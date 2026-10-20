import fs from 'node:fs/promises';
import path from 'node:path';
import { buildScene, toGLB } from 'openskp';
import { DwgReader } from '@node-projects/acad-ts';
import { ShapeUtils, Vector2 } from 'three';

const DWG_UNIT_TO_METRES = new Map([
  [1, 0.0254], [2, 0.3048], [3, 1609.344], [4, 0.001], [5, 0.01], [6, 1], [7, 1000],
  [8, 2.54e-8], [9, 2.54e-5], [10, 0.9144], [11, 1e-10], [12, 1e-9], [13, 1e-6],
  [14, 0.1], [15, 10], [16, 100], [17, 1e9], [18, 149597870700], [19, 9.4607304725808e15],
  [20, 3.085677581491367e16], [21, 1200 / 3937], [22, 100 / 3937], [23, 3600 / 3937]
]);

function finitePoint(point) {
  if (!point) return null;
  const values = [Number(point.x), Number(point.y), Number(point.z || 0)];
  return values.every(Number.isFinite) ? values : null;
}

function boundsFromPositions(positions) {
  if (!positions?.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[index + axis]);
      max[axis] = Math.max(max[axis], positions[index + axis]);
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null;
  return {
    min, max,
    size: max.map((value, axis) => value - min[axis]),
    center: max.map((value, axis) => (value + min[axis]) / 2)
  };
}

function chooseFocusedSkpPrimitives(primitives) {
  const described = primitives.map((primitive) => ({
    primitive,
    bounds: boundsFromPositions(primitive.positions),
    vertexCount: Math.floor((primitive.positions?.length || 0) / 3)
  })).filter((item) => item.bounds && item.vertexCount > 0);
  const originalBounds = boundsFromPositions(Float32Array.from(described.flatMap((item) => [item.bounds.min, item.bounds.max]).flat()));
  if (!described.length || !originalBounds) return { primitives, originalBounds: null, focusBounds: null, omitted: 0, mode: 'full_scene' };

  const candidates = described.filter((item) => {
    const [width, height, depth] = item.bounds.size;
    return height >= 1 && Math.max(width, depth) <= 500;
  });
  const core = [...candidates].sort((left, right) => right.vertexCount - left.vertexCount)[0];
  if (!core) return { primitives, originalBounds, focusBounds: originalBounds, omitted: 0, mode: 'full_scene' };
  const originalHorizontal = Math.max(originalBounds.size[0], originalBounds.size[2]);
  const coreHorizontal = Math.max(core.bounds.size[0], core.bounds.size[2], 1);
  if (originalHorizontal <= coreHorizontal * 4) return { primitives, originalBounds, focusBounds: originalBounds, omitted: 0, mode: 'full_scene' };

  const margin = Math.max(20, Math.min(120, coreHorizontal * 0.75));
  const xRange = [core.bounds.min[0] - margin, core.bounds.max[0] + margin];
  const zRange = [core.bounds.min[2] - margin, core.bounds.max[2] + margin];
  const kept = described.filter((item) => {
    const [x, , z] = item.bounds.center;
    return x >= xRange[0] && x <= xRange[1] && z >= zRange[0] && z <= zRange[1];
  });
  if (!kept.length || kept.length < Math.max(1, described.length * 0.05)) {
    return { primitives, originalBounds, focusBounds: originalBounds, omitted: 0, mode: 'full_scene' };
  }
  const focusBounds = boundsFromPositions(Float32Array.from(kept.flatMap((item) => [item.bounds.min, item.bounds.max]).flat()));
  return {
    primitives: kept.map((item) => item.primitive), originalBounds, focusBounds,
    omitted: described.length - kept.length, mode: 'dominant_vertical_geometry'
  };
}

function normalizeBounds(bounds) {
  if (!bounds) return null;
  return Object.fromEntries(Object.entries(bounds).map(([key, values]) => [key, values.map((value) => Number(value.toFixed(6)))]));
}

export async function convertSkpToGlb({ inputPath, outputPath, onProgress = () => {} }) {
  const source = await fs.readFile(inputPath);
  const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const scene = buildScene(arrayBuffer, {
    respectEdgeVisibility: true,
    onProgress: (progress) => onProgress(progress),
    onLog: (_level, message) => onProgress({ stage: 'parser', message })
  });
  if (!scene.glbPrimitives?.length) throw new Error('SKP_NO_RENDERABLE_GEOMETRY');
  const focus = chooseFocusedSkpPrimitives(scene.glbPrimitives);
  const keepNames = new Set(focus.primitives.map((primitive) => primitive.geomName));
  scene.glbPrimitives = focus.primitives;
  scene.meshIndex = Object.fromEntries(Object.entries(scene.meshIndex || {}).filter(([name]) => keepNames.has(name)));
  scene.bounds = focus.focusBounds;
  const output = toGLB(scene, { textures: true });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, output);
  return {
    sourceFormat: 'skp', units: 'metres', axes: 'Y-up', coordinateStatus: 'relative_metric',
    metricAnalysisAllowed: false, georeferenced: false,
    sourcePrimitiveCount: focus.primitives.length + focus.omitted,
    outputPrimitiveCount: focus.primitives.length, omittedOutlierPrimitives: focus.omitted,
    focusMode: focus.mode, originalBounds: normalizeBounds(focus.originalBounds),
    bounds: normalizeBounds(focus.focusBounds), outputBytes: output.byteLength
  };
}

function entityPolyline(entity) {
  const name = entity?.constructor?.name;
  if (name === 'Line') {
    const start = finitePoint(entity.startPoint);
    const end = finitePoint(entity.endPoint);
    return start && end ? [start, end] : [];
  }
  if (name === 'LwPolyline' || name === 'Polyline2D') {
    const points = typeof entity.getPoints === 'function' ? entity.getPoints(24).map(finitePoint).filter(Boolean) : [];
    if (entity.isClosed && points.length > 2) points.push(points[0]);
    return points;
  }
  if (name === 'Arc' || name === 'Circle' || name === 'Ellipse') {
    const points = typeof entity.polygonalVertexes === 'function' ? entity.polygonalVertexes(32).map(finitePoint).filter(Boolean) : [];
    if ((name === 'Circle' || entity.isFullEllipse) && points.length > 2) points.push(points[0]);
    return points;
  }
  if (name === 'Solid') {
    return [entity.firstCorner, entity.secondCorner, entity.thirdCorner, entity.fourthCorner, entity.firstCorner].map(finitePoint).filter(Boolean);
  }
  return [];
}

function polygonSignedArea(polygon) {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    area += polygon[index][0] * polygon[next][1] - polygon[next][0] * polygon[index][1];
  }
  return area / 2;
}

function cleanPolygon(points, precision = 1e-5) {
  const cleaned = [];
  for (const point of points || []) {
    const candidate = [Number(point?.[0]), Number(point?.[1])];
    if (!candidate.every(Number.isFinite)) continue;
    const previous = cleaned.at(-1);
    if (previous && Math.hypot(previous[0] - candidate[0], previous[1] - candidate[1]) <= precision) continue;
    cleaned.push(candidate);
  }
  if (cleaned.length > 2 && Math.hypot(cleaned[0][0] - cleaned.at(-1)[0], cleaned[0][1] - cleaned.at(-1)[1]) <= precision) cleaned.pop();
  return cleaned.length >= 3 && Math.abs(polygonSignedArea(cleaned)) > precision ? cleaned : [];
}

function polygonBounds2d(polygon) {
  if (!polygon?.length) return null;
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  const min = [Math.min(...xs), Math.min(...ys)];
  const max = [Math.max(...xs), Math.max(...ys)];
  return { min, max, size: [max[0] - min[0], max[1] - min[1]], center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] };
}

function edgePoints2d(edge, unitScale) {
  if (Array.isArray(edge?.vertices)) {
    return edge.vertices.map((point) => [Number(point.x) * unitScale, Number(point.y) * unitScale]).filter((point) => point.every(Number.isFinite));
  }
  if (edge?.start && edge?.end) {
    return [edge.start, edge.end].map((point) => [Number(point.x) * unitScale, Number(point.y) * unitScale]).filter((point) => point.every(Number.isFinite));
  }
  if (edge?.center && Number.isFinite(Number(edge.radius))) {
    let start = Number.isFinite(Number(edge.startAngle)) ? Number(edge.startAngle) : 0;
    let end = Number.isFinite(Number(edge.endAngle)) ? Number(edge.endAngle) : Math.PI * 2;
    const counterClockwise = edge.counterClockWise !== false;
    if (counterClockwise && end <= start) end += Math.PI * 2;
    if (!counterClockwise && end >= start) end -= Math.PI * 2;
    const span = end - start;
    const steps = Math.max(8, Math.min(48, Math.ceil(Math.abs(span) / (Math.PI / 12))));
    return Array.from({ length: steps + 1 }, (_, index) => {
      const angle = start + span * index / steps;
      return [
        (Number(edge.center.x) + Math.cos(angle) * Number(edge.radius)) * unitScale,
        (Number(edge.center.y) + Math.sin(angle) * Number(edge.radius)) * unitScale
      ];
    });
  }
  if (edge?.center && edge?.majorAxisEndPoint) {
    const center = [Number(edge.center.x), Number(edge.center.y)];
    const major = [Number(edge.majorAxisEndPoint.x), Number(edge.majorAxisEndPoint.y)];
    const ratio = Number(edge.minorMajorRatio ?? edge.axisRatio ?? 1);
    if (![...center, ...major, ratio].every(Number.isFinite)) return [];
    let start = Number(edge.startParameter ?? edge.startAngle ?? 0);
    let end = Number(edge.endParameter ?? edge.endAngle ?? Math.PI * 2);
    if (end <= start) end += Math.PI * 2;
    const steps = Math.max(12, Math.min(64, Math.ceil((end - start) / (Math.PI / 18))));
    const majorLength = Math.hypot(...major);
    const unitMajor = majorLength > 0 ? major.map((value) => value / majorLength) : [1, 0];
    const unitMinor = [-unitMajor[1], unitMajor[0]];
    return Array.from({ length: steps + 1 }, (_, index) => {
      const angle = start + (end - start) * index / steps;
      return [
        (center[0] + unitMajor[0] * majorLength * Math.cos(angle) + unitMinor[0] * majorLength * ratio * Math.sin(angle)) * unitScale,
        (center[1] + unitMajor[1] * majorLength * Math.cos(angle) + unitMinor[1] * majorLength * ratio * Math.sin(angle)) * unitScale
      ];
    });
  }
  return [];
}

export function classifyDwgSemanticDescriptor(layer, blockName = '') {
  const value = `${String(layer || '').trim()} ${String(blockName || '').trim()}`;
  if (!value.trim() || /(?:^|[-_\s])(dim|text|anno|axis|grid)(?:$|[-_\s])|标注|文字|引出|编号|尺寸|轴网|立面|剖线/i.test(value)) return null;
  if (/消火栓|消防|防火|hydrant|fire[-_\s]?safety|fire\s?shutter/i.test(value)) return 'fireSafety';
  if (/停车|车位|parking|(?:^|[-_\s])park(?:$|[-_\s])|(?:^|[-_\s])bike(?:$|[-_\s])/i.test(value)) return 'parking';
  if (/景观|绿化|乔木|灌木|草坪|树池|trees?|landscape|planting/i.test(value)) return 'landscape';
  if (/卫生间|洁具|便器|坐便|洗手盆|lavatory|sanitary|toilet|(?:^|[-_\s])wc\d*(?:$|[-_\s])|lvtry/i.test(value)) return 'sanitary';
  if (/扶手|hand[-_\s]?rail|rail[-_\s]?hand/i.test(value)) return 'handrail';
  if (/护栏|栏杆|栏板|railing|guard[-_\s]?rail|balustrade|barr[i]?er/i.test(value)) return 'railing';
  if (/lift|elev(?:ator)?|电梯|轿厢|井道/i.test(value)) return 'elevator';
  if (/stairs?|楼梯|踏步|梯段/i.test(value)) return 'stair';
  if (/配电|电气|强电|弱电|暖通|空调|风管|给排水|雨水|污水|设备|机房|equipment|electrical|plumbing|hvac|duct/i.test(value)) return 'equipment';
  return null;
}

function normalizeDwgSpaceLabel(value) {
  return String(value || '')
    .replace(/\\P/gi, ' ')
    .replace(/\\[A-Za-z][^;]*;/g, '')
    .replace(/[，,]?(?:内)?[，,]?详见.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyDwgSpaceLabel(value) {
  const label = normalizeDwgSpaceLabel(value);
  if (!label || label.length > 32) return null;
  if (/平面图|立面图|剖面图|详图|详建|建施|比例|图纸|标高|索引|轴线|尺寸|材料|做法|LED|卵石|吊顶|地面|墙面|天花|备注|说明|面积|平方米|送风|排水沟|座位|家具|风口|星光灯/i.test(label)) return null;
  if (/^(?:[-+]?\\d+(?:\\.\\d+)?|[A-Z]?[A-Z0-9]+[-/]?[A-Z0-9]*)$/i.test(label)) return null;
  if (/停车位|停车场|车库/.test(label)) return 'parking';
  if (/门厅|大厅|前厅|电梯厅|接待/.test(label)) return 'lobby';
  if (/走廊|走道|过道|连廊/.test(label)) return 'corridor';
  if (/会议|报告厅|展厅|多功能厅/.test(label)) return 'meeting';
  if (/办公室|办公|设计院|工作室/.test(label)) return 'office';
  if (/厨房|备餐|餐厅|茶水/.test(label)) return 'kitchen';
  if (/卫生间|洗手间|盥洗|更衣|淋浴/.test(label)) return 'sanitary';
  if (/机房|配电|弱电|强电|设备房|泵房|水箱|风机房/.test(label)) return 'service';
  if (/楼梯|前室/.test(label)) return 'circulation';
  if (/仓库|库房|储藏|档案|文印|打印/.test(label)) return 'storage';
  if (/休息|休闲|等候/.test(label)) return 'amenity';
  return null;
}

export function extractDwgSpaceLabel(entity, unitScale = 1) {
  const entityType = entity?.constructor?.name;
  if (!['TextEntity', 'MText', 'Object'].includes(entityType)) return null;
  const label = normalizeDwgSpaceLabel(entity.value ?? entity.text ?? entity._value ?? entity.textValue);
  const type = classifyDwgSpaceLabel(label);
  const sourcePoint = finitePoint(entity.insertPoint || entity.insertionPoint || entity.alignmentPoint);
  if (!type || !sourcePoint) return null;
  return {
    label,
    type,
    point: [Number((sourcePoint[0] * unitScale).toFixed(6)), Number((sourcePoint[1] * unitScale).toFixed(6))],
    sourceLayer: String(entity.layer?.name || ''),
    evidence: 'Derived',
    geometryStatus: 'label_anchor_only'
  };
}

function deduplicateDwgSpaces(spaces = []) {
  const result = [];
  for (const space of spaces) {
    const duplicate = result.some((candidate) => candidate.label === space.label
      && Math.hypot(candidate.point[0] - space.point[0], candidate.point[1] - space.point[1]) <= 0.35);
    if (!duplicate) result.push(space);
  }
  return result;
}

function classifyDwgSurfaceLayer(layer) {
  const value = String(layer || '').trim();
  if (!value || /(?:^|[-_\s])(dim|text|anno|axis|grid|fur|furniture)(?:$|[-_\s])|标注|文字|家具|引出|编号|尺寸|轴网|饰面|立面|剖线/i.test(value)) return null;
  const semantic = classifyDwgSemanticDescriptor(value);
  if (['elevator', 'stair', 'landscape', 'fireSafety', 'railing', 'handrail'].includes(semantic)) return semantic;
  if (/column|colume|pillar|柱/i.test(value)) return 'column';
  if (/lift|stair|core|电梯|楼梯|交通核|井道/i.test(value)) return 'core';
  if (/glass|glazing|window|windows|玻璃|窗|win[-_]|幕墙/i.test(value)) return 'glazing';
  if (/wall|partition|墙|隔墙|砌块|地垄/i.test(value)) return 'wall';
  return null;
}

export function extractDwgHatchSurfaces(entity, unitScale = 1) {
  if (!entity || (entity.constructor?.name && !['Hatch', 'Object'].includes(entity.constructor.name))) return [];
  const layer = String(entity.layer?.name || '');
  const category = classifyDwgSurfaceLayer(layer);
  if (!category) return [];
  const surfaces = [];
  for (const pathEntry of entity.paths || []) {
    const polygon = [];
    for (const edge of pathEntry.edges || []) {
      const points = edgePoints2d(edge, unitScale);
      if (polygon.length && points.length && Math.hypot(polygon.at(-1)[0] - points[0][0], polygon.at(-1)[1] - points[0][1]) <= 1e-5) points.shift();
      polygon.push(...points);
    }
    const cleaned = cleanPolygon(polygon);
    if (!cleaned.length) continue;
    const areaM2 = Math.abs(polygonSignedArea(cleaned));
    if (areaM2 < 0.01 || areaM2 > 50000) continue;
    surfaces.push({ category, layer, polygon: cleaned, areaM2, evidence: 'Derived' });
  }
  return surfaces;
}

function closedPolylineCandidate(entity, unitScale) {
  if (!entity?.isClosed || !['LwPolyline', 'Polyline2D'].includes(entity.constructor?.name)) return null;
  let points = [];
  try { points = entityPolyline(entity).map((point) => [point[0] * unitScale, point[1] * unitScale]); } catch { points = []; }
  const polygon = cleanPolygon(points);
  if (!polygon.length) return null;
  const bounds = polygonBounds2d(polygon);
  return { polygon, bounds, areaM2: Math.abs(polygonSignedArea(polygon)), layer: String(entity.layer?.name || '') };
}

export function detectDwgPlanFrames(entities, unitScale = 1) {
  const candidates = [];
  for (const entity of entities || []) {
    const candidate = closedPolylineCandidate(entity, unitScale);
    if (!candidate) continue;
    const [width, height] = candidate.bounds.size;
    if (candidate.areaM2 < 20000 || width < 120 || height < 90 || width / height < 0.8 || width / height > 2.5) continue;
    candidates.push(candidate);
  }
  if (!candidates.length) return [];
  const groups = new Map();
  for (const candidate of candidates) {
    const key = `${Math.round(candidate.bounds.size[0])}:${Math.round(candidate.bounds.size[1])}`;
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }
  const selected = [...groups.values()].sort((left, right) => right.length - left.length || right[0].areaM2 - left[0].areaM2)[0];
  return selected.sort((left, right) => right.bounds.center[1] - left.bounds.center[1]).map((candidate, index) => ({
    floorNumber: index + 1,
    label: `${index + 1}F`,
    bounds: candidate.bounds,
    sourceLayer: candidate.layer,
    sourceAreaM2: Number(candidate.areaM2.toFixed(3))
  }));
}

function pointInsideBounds(point, bounds, margin = 0) {
  return point[0] >= bounds.min[0] - margin && point[0] <= bounds.max[0] + margin
    && point[1] >= bounds.min[1] - margin && point[1] <= bounds.max[1] + margin;
}

function centroid2d(polygon) {
  if (!polygon?.length) return [0, 0];
  return polygon.reduce((sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length], [0, 0]);
}

export function organizeDwgInteriorLevels({ frames = [], segments = [], openings = [], surfaces = [], footprints = [], furnishings = [], semanticObjects = [], spaces = [] } = {}) {
  return [...frames].sort((left, right) => Number(left.floorNumber) - Number(right.floorNumber)).map((frame) => {
    const center = frame.bounds?.center || [
      (Number(frame.bounds?.min?.[0]) + Number(frame.bounds?.max?.[0])) / 2,
      (Number(frame.bounds?.min?.[1]) + Number(frame.bounds?.max?.[1])) / 2
    ];
    const transformPoint = (point) => [Number(point[0]) - center[0], Number(point[1]) - center[1], Number(point[2] || 0)];
    return {
      floorNumber: Number(frame.floorNumber),
      label: frame.label || `${frame.floorNumber}F`,
      sourceFrame: { ...frame, center: center.map((value) => Number(value.toFixed(6))) },
      segments: segments.filter((segment) => pointInsideBounds([
        (segment.start[0] + segment.end[0]) / 2,
        (segment.start[1] + segment.end[1]) / 2
      ], frame.bounds)).map((segment) => ({ ...segment, start: transformPoint(segment.start), end: transformPoint(segment.end) })),
      openings: openings.filter((opening) => pointInsideBounds(opening.center, frame.bounds)).map((opening) => ({
        ...opening, center: transformPoint(opening.center).slice(0, 2)
      })),
      surfaces: surfaces.filter((surface) => pointInsideBounds(centroid2d(surface.polygon), frame.bounds)).map((surface) => ({
        ...surface, polygon: surface.polygon.map((point) => transformPoint(point).slice(0, 2))
      })),
      footprints: footprints.filter((footprint) => pointInsideBounds(centroid2d(footprint.polygon), frame.bounds)).map((footprint) => ({
        ...footprint, polygon: footprint.polygon.map((point) => transformPoint(point).slice(0, 2))
      })),
      furnishings: furnishings.filter((item) => pointInsideBounds(item.center, frame.bounds)).map((item) => ({
        ...item, center: transformPoint(item.center).slice(0, 2)
      })),
      semanticObjects: semanticObjects.filter((item) => pointInsideBounds(item.center, frame.bounds)).map((item) => ({
        ...item, center: transformPoint(item.center).slice(0, 2)
      })),
      spaces: spaces.filter((space) => pointInsideBounds(space.point, frame.bounds)).map((space) => ({
        ...space, point: transformPoint(space.point).slice(0, 2)
      }))
    };
  });
}

function collectDwgSegments(document, unitScale) {
  const entityCounts = {};
  const omittedEntityCounts = {};
  const segments = [];
  const openings = [];
  const surfaces = [];
  const footprints = [];
  const furnishings = [];
  const semanticObjects = [];
  const spaces = [];
  const entities = [...(document.modelSpace?.entities || [])];
  for (const entity of entities) {
    const name = entity?.constructor?.name || 'UnknownEntity';
    entityCounts[name] = (entityCounts[name] || 0) + 1;
    const space = extractDwgSpaceLabel(entity, unitScale);
    if (space) spaces.push(space);
    if (name === 'Insert') {
      const opening = extractDwgInsertOpening(entity, unitScale);
      if (opening) openings.push(opening);
      else {
        const semanticObject = extractDwgSemanticInsert(entity, unitScale);
        if (semanticObject) semanticObjects.push(semanticObject);
        else {
          const furnishing = extractDwgFurnitureInsert(entity, unitScale);
          if (furnishing) furnishings.push(furnishing);
        }
      }
    }
    if (name === 'Hatch') surfaces.push(...extractDwgHatchSurfaces(entity, unitScale));
    if (entity.isClosed && ['LwPolyline', 'Polyline2D'].includes(name)) {
      const candidate = closedPolylineCandidate(entity, unitScale);
      if (candidate && candidate.areaM2 >= 1000 && candidate.areaM2 <= 25000
        && candidate.bounds.size[0] >= 20 && candidate.bounds.size[1] >= 20
        && !/^(?:0|图框)$/i.test(candidate.layer) && !EXTRUSION_EXCLUDE_PATTERN.test(candidate.layer)) {
        footprints.push({ polygon: candidate.polygon, areaM2: candidate.areaM2, layer: candidate.layer, evidence: 'Derived' });
      }
    }
    let points;
    try { points = entityPolyline(entity); } catch { points = []; }
    if (points.length < 2) {
      omittedEntityCounts[name] = (omittedEntityCounts[name] || 0) + 1;
      continue;
    }
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1].map((value) => value * unitScale);
      const end = points[index].map((value) => value * unitScale);
      const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
      if (!Number.isFinite(length) || length <= 1e-8) continue;
      segments.push({ start, end, layer: String(entity.layer?.name || '0') });
    }
  }
  return {
    segments, openings, surfaces, footprints, furnishings, semanticObjects, spaces: deduplicateDwgSpaces(spaces),
    frames: detectDwgPlanFrames(entities, unitScale),
    entityCounts, omittedEntityCounts
  };
}

function segmentBounds(segments) {
  return boundsFromPositions(Float64Array.from(segments.flatMap((segment) => [segment.start, segment.end]).flat()));
}

function chooseFocusedDwgSegments(segments) {
  const originalBounds = segmentBounds(segments);
  if (!originalBounds || Math.max(originalBounds.size[0], originalBounds.size[1]) <= 800) {
    return { segments, originalBounds, focusBounds: originalBounds, omitted: 0, mode: 'full_model_space' };
  }
  const gridSize = 250;
  const buckets = new Map();
  for (const segment of segments) {
    const midpoint = [(segment.start[0] + segment.end[0]) / 2, (segment.start[1] + segment.end[1]) / 2];
    const length = Math.hypot(segment.end[0] - segment.start[0], segment.end[1] - segment.start[1]);
    if (length > 1000) continue;
    const key = `${Math.floor(midpoint[0] / gridSize)}:${Math.floor(midpoint[1] / gridSize)}`;
    const bucket = buckets.get(key) || { count: 0, sumX: 0, sumY: 0 };
    bucket.count += 1;
    bucket.sumX += midpoint[0];
    bucket.sumY += midpoint[1];
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((left, right) => right.count - left.count)[0];
  if (!dominant) return { segments, originalBounds, focusBounds: originalBounds, omitted: 0, mode: 'full_model_space' };
  const center = [dominant.sumX / dominant.count, dominant.sumY / dominant.count];
  const radius = 400;
  const focused = segments.filter((segment) => {
    const x = (segment.start[0] + segment.end[0]) / 2;
    const y = (segment.start[1] + segment.end[1]) / 2;
    return Math.hypot(x - center[0], y - center[1]) <= radius;
  });
  if (focused.length < Math.max(4, segments.length * 0.02)) {
    return { segments, originalBounds, focusBounds: originalBounds, omitted: 0, mode: 'full_model_space' };
  }
  return {
    segments: focused, originalBounds, focusBounds: segmentBounds(focused),
    omitted: segments.length - focused.length, mode: 'dominant_line_density'
  };
}

function encodeLineGlb(segments, origin, metadata) {
  const positions = new Float32Array(segments.length * 6);
  let offset = 0;
  for (const segment of segments) {
    for (const point of [segment.start, segment.end]) {
      positions[offset++] = point[0] - origin[0];
      positions[offset++] = point[2] - origin[2];
      positions[offset++] = -(point[1] - origin[1]);
    }
  }
  const bounds = boundsFromPositions(positions);
  const json = {
    asset: { version: '2.0', generator: 'Spatial Reframe DWG linework converter', extras: metadata },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'DWG plan reference' }],
    meshes: [{ name: 'DWG linework', primitives: [{ attributes: { POSITION: 0 }, material: 0, mode: 1 }] }],
    materials: [{
      name: 'CAD reference cyan', pbrMetallicRoughness: { baseColorFactor: [0.329, 0.878, 0.855, 1], metallicFactor: 0, roughnessFactor: 1 },
      emissiveFactor: [0.08, 0.28, 0.27], extensions: { KHR_materials_unlit: {} }
    }],
    extensionsUsed: ['KHR_materials_unlit'],
    buffers: [{ byteLength: positions.byteLength }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 }],
    accessors: [{
      bufferView: 0, byteOffset: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3',
      min: bounds.min, max: bounds.max
    }]
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const binBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const binPadding = (4 - (binBytes.length % 4)) % 4;
  const totalLength = 12 + 8 + jsonBytes.length + jsonPadding + 8 + binBytes.length + binPadding;
  const output = Buffer.alloc(totalLength);
  output.write('glTF', 0, 4, 'ascii'); output.writeUInt32LE(2, 4); output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonBytes.length + jsonPadding, 12); output.writeUInt32LE(0x4E4F534A, 16);
  jsonBytes.copy(output, 20); output.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPadding);
  const binHeader = 20 + jsonBytes.length + jsonPadding;
  output.writeUInt32LE(binBytes.length + binPadding, binHeader); output.writeUInt32LE(0x004E4942, binHeader + 4);
  binBytes.copy(output, binHeader + 8);
  return output;
}

const EXTRUSION_EXCLUDE_PATTERN = /(?:^|[-_\s])(dim|text|anno|axis|grid|fur|furniture)(?:$|[-_\s])|标注|文字|家具|引出|编号|尺寸|轴网|填充|饰面|立面|剖线/i;

export function classifyDwgExtrusionLayer(layer) {
  const value = String(layer || '').trim();
  if (!value || EXTRUSION_EXCLUDE_PATTERN.test(value)) return null;
  if (/door|doors|门(?:$|[-_\s])|门扇/i.test(value)) return 'door';
  if (/glass|glazing|window|windows|玻璃|窗|win[-_]/i.test(value)) return 'glazing';
  const semantic = classifyDwgSemanticDescriptor(value);
  if (['elevator', 'stair', 'fireSafety', 'railing', 'handrail'].includes(semantic)) return semantic;
  if (/core|交通核/i.test(value)) return 'core';
  if (/column|colume|pillar|柱/i.test(value)) return 'column';
  if (/wall|partition|墙|隔墙|砌块/i.test(value)) return 'wall';
  return null;
}

const DWG_DOOR_BLOCK_PATTERN = /\$DorLib|^D\d|^d-\d|^_dblk$|door|门/i;

function openingKindForInsert(layer, blockName) {
  if (DWG_DOOR_BLOCK_PATTERN.test(String(blockName || '').trim())) return 'door';
  const value = String(layer || '').trim();
  if (/door|doors|门(?:$|[-_\s])|门扇/i.test(value)) return 'door';
  if (/window|windows|窗|win[-_]/i.test(value)) return 'window';
  return null;
}

export function extractDwgInsertOpening(entity, unitScale = 1) {
  if (!entity || (entity.constructor?.name && !['Insert', 'Object'].includes(entity.constructor.name))) return null;
  const layer = String(entity.layer?.name || '');
  const blockName = String(entity.block?.name || '');
  const kind = openingKindForInsert(layer, blockName);
  if (!kind || !entity.insertPoint || !entity.block) return null;
  const localPoints = [];
  for (const blockEntity of entity.block.entities || []) {
    let points = [];
    try { points = entityPolyline(blockEntity); } catch { points = []; }
    localPoints.push(...points);
  }
  if (localPoints.length < 2) return null;
  const xs = localPoints.map((point) => Number(point[0])).filter(Number.isFinite);
  const ys = localPoints.map((point) => Number(point[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const xScale = Number.isFinite(Number(entity.xScale)) ? Number(entity.xScale) : 1;
  const yScale = Number.isFinite(Number(entity.yScale)) ? Number(entity.yScale) : 1;
  const widthM = Math.abs(maxX - minX) * Math.abs(xScale) * unitScale;
  const minimumWidth = kind === 'door' ? 0.5 : 0.25;
  const maximumWidth = kind === 'door' ? 4 : 8;
  if (!Number.isFinite(widthM) || widthM < minimumWidth || widthM > maximumWidth) return null;
  const localCenterX = (minX + maxX) / 2;
  const localBaselineY = minY <= 0 && maxY >= 0 ? 0 : (Math.abs(minY) <= Math.abs(maxY) ? minY : maxY);
  const scaledX = localCenterX * xScale;
  const scaledY = localBaselineY * yScale;
  const rotation = Number.isFinite(Number(entity.rotation)) ? Number(entity.rotation) : 0;
  const cos = Math.cos(rotation); const sin = Math.sin(rotation);
  const insertX = Number(entity.insertPoint.x); const insertY = Number(entity.insertPoint.y);
  if (!Number.isFinite(insertX) || !Number.isFinite(insertY)) return null;
  const center = [
    (insertX + scaledX * cos - scaledY * sin) * unitScale,
    (insertY + scaledX * sin + scaledY * cos) * unitScale
  ];
  const sign = xScale < 0 ? -1 : 1;
  const direction = [Math.cos(rotation) * sign, Math.sin(rotation) * sign];
  return {
    kind, center, direction, widthM,
    layer, blockName, evidence: 'Derived'
  };
}

function extractDwgFurnitureInsert(entity, unitScale = 1) {
  if (!entity?.insertPoint || !entity.block) return null;
  const layer = String(entity.layer?.name || '');
  const blockName = String(entity.block?.name || '');
  if (!/(?:^|[-_\s])fur(?:niture)?(?:$|[-_\s])|家具|座位|桌|椅|柜|沙发/i.test(`${layer} ${blockName}`)) return null;
  const localPoints = [];
  for (const blockEntity of entity.block.entities || []) {
    let points = [];
    try { points = entityPolyline(blockEntity); } catch { points = []; }
    localPoints.push(...points);
  }
  if (localPoints.length < 2) return null;
  const xs = localPoints.map((point) => Number(point[0])).filter(Number.isFinite);
  const ys = localPoints.map((point) => Number(point[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const xScale = Number.isFinite(Number(entity.xScale)) ? Number(entity.xScale) : 1;
  const yScale = Number.isFinite(Number(entity.yScale)) ? Number(entity.yScale) : 1;
  const widthM = Math.abs(Math.max(...xs) - Math.min(...xs)) * Math.abs(xScale) * unitScale;
  const depthM = Math.abs(Math.max(...ys) - Math.min(...ys)) * Math.abs(yScale) * unitScale;
  if (![widthM, depthM].every(Number.isFinite) || widthM < 0.2 || depthM < 0.2 || widthM > 8 || depthM > 8) return null;
  const localCenter = [
    (Math.min(...xs) + Math.max(...xs)) / 2 * xScale,
    (Math.min(...ys) + Math.max(...ys)) / 2 * yScale
  ];
  const rotation = Number.isFinite(Number(entity.rotation)) ? Number(entity.rotation) : 0;
  const cos = Math.cos(rotation); const sin = Math.sin(rotation);
  const insert = [Number(entity.insertPoint.x), Number(entity.insertPoint.y)];
  if (!insert.every(Number.isFinite)) return null;
  const descriptor = `${layer} ${blockName}`;
  const heightM = /柜|cabinet|wardrobe/i.test(descriptor) ? 1.1 : /沙发|sofa/i.test(descriptor) ? 0.82 : /座|椅|chair/i.test(descriptor) ? 0.46 : 0.74;
  return {
    center: [
      (insert[0] + localCenter[0] * cos - localCenter[1] * sin) * unitScale,
      (insert[1] + localCenter[0] * sin + localCenter[1] * cos) * unitScale
    ],
    direction: [cos, sin], widthM, depthM, heightM, layer, blockName,
    footprintEvidence: 'Derived', heightEvidence: 'Hypothesis'
  };
}

export function extractDwgSemanticInsert(entity, unitScale = 1) {
  if (!entity?.insertPoint || !entity.block) return null;
  const layer = String(entity.layer?.name || '');
  const blockName = String(entity.block?.name || '');
  const category = classifyDwgSemanticDescriptor(layer, blockName);
  if (!['parking', 'landscape', 'sanitary', 'fireSafety', 'equipment', 'elevator', 'stair', 'railing', 'handrail'].includes(category)) return null;
  const localPoints = [];
  for (const blockEntity of entity.block.entities || []) {
    let points = [];
    try { points = entityPolyline(blockEntity); } catch { points = []; }
    localPoints.push(...points);
  }
  if (localPoints.length < 2) return null;
  const xs = localPoints.map((point) => Number(point[0])).filter(Number.isFinite);
  const ys = localPoints.map((point) => Number(point[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  const xScale = Number.isFinite(Number(entity.xScale)) ? Number(entity.xScale) : 1;
  const yScale = Number.isFinite(Number(entity.yScale)) ? Number(entity.yScale) : 1;
  const widthM = Math.abs(Math.max(...xs) - Math.min(...xs)) * Math.abs(xScale) * unitScale;
  const depthM = Math.abs(Math.max(...ys) - Math.min(...ys)) * Math.abs(yScale) * unitScale;
  const maximumSize = category === 'landscape' ? 40 : category === 'parking' ? 15 : 12;
  if (![widthM, depthM].every(Number.isFinite) || widthM < 0.08 || depthM < 0.08 || widthM > maximumSize || depthM > maximumSize) return null;
  const localCenter = [
    (Math.min(...xs) + Math.max(...xs)) / 2 * xScale,
    (Math.min(...ys) + Math.max(...ys)) / 2 * yScale
  ];
  const rotation = Number.isFinite(Number(entity.rotation)) ? Number(entity.rotation) : 0;
  const cos = Math.cos(rotation); const sin = Math.sin(rotation);
  const insert = [Number(entity.insertPoint.x), Number(entity.insertPoint.y)];
  if (!insert.every(Number.isFinite)) return null;
  return {
    category,
    center: [
      (insert[0] + localCenter[0] * cos - localCenter[1] * sin) * unitScale,
      (insert[1] + localCenter[0] * sin + localCenter[1] * cos) * unitScale
    ],
    direction: [cos, sin], widthM, depthM, layer, blockName,
    footprintEvidence: 'Derived', heightEvidence: 'Hypothesis'
  };
}

function clampNumber(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(maximum, Math.max(minimum, numeric)) : fallback;
}

function segmentLength2d(segment) {
  return Math.hypot(Number(segment.end[0]) - Number(segment.start[0]), Number(segment.end[1]) - Number(segment.start[1]));
}

function deduplicateSegments(segments, precision = 0.01) {
  const seen = new Set();
  return segments.filter((segment) => {
    const quantize = (value) => Math.round(Number(value) / precision);
    const a = [quantize(segment.start[0]), quantize(segment.start[1])];
    const b = [quantize(segment.end[0]), quantize(segment.end[1])];
    const ordered = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
    const key = `${segment.category}:${ordered[0].join(',')}:${ordered[1].join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectDominantPlanRegion(segments, radiusM) {
  if (!segments.length) return { segments: [], center: [0, 0], omitted: 0 };
  const bucketSize = Math.max(20, Math.min(60, radiusM / 2));
  const buckets = new Map();
  for (const segment of segments) {
    const x = (segment.start[0] + segment.end[0]) / 2;
    const y = (segment.start[1] + segment.end[1]) / 2;
    const key = `${Math.floor(x / bucketSize)}:${Math.floor(y / bucketSize)}`;
    const bucket = buckets.get(key) || { count: 0, weightedX: 0, weightedY: 0, weight: 0 };
    const weight = Math.min(10, Math.max(0.25, segmentLength2d(segment)));
    bucket.count += 1;
    bucket.weightedX += x * weight;
    bucket.weightedY += y * weight;
    bucket.weight += weight;
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((left, right) => right.count - left.count || right.weight - left.weight)[0];
  const center = [dominant.weightedX / dominant.weight, dominant.weightedY / dominant.weight];
  const selected = segments.filter((segment) => {
    const x = (segment.start[0] + segment.end[0]) / 2;
    const y = (segment.start[1] + segment.end[1]) / 2;
    return Math.hypot(x - center[0], y - center[1]) <= radiusM;
  });
  return { segments: selected.length >= 4 ? selected : segments, center, omitted: selected.length >= 4 ? segments.length - selected.length : 0 };
}

function pushBoxGeometry(group, start, end, bottom, top, thickness) {
  const dx = end[0] - start[0];
  const dz = -(end[1] - start[1]);
  const length = Math.hypot(dx, dz);
  if (!Number.isFinite(length) || length <= 1e-6) return;
  const half = thickness / 2;
  const px = -dz / length * half;
  const pz = dx / length * half;
  const x1 = start[0]; const z1 = -start[1];
  const x2 = end[0]; const z2 = -end[1];
  const corners = [
    [x1 + px, bottom, z1 + pz], [x1 - px, bottom, z1 - pz], [x2 - px, bottom, z2 - pz], [x2 + px, bottom, z2 + pz],
    [x1 + px, top, z1 + pz], [x1 - px, top, z1 - pz], [x2 - px, top, z2 - pz], [x2 + px, top, z2 + pz]
  ];
  const faces = [
    [[0, 3, 2, 1], [0, -1, 0]], [[4, 5, 6, 7], [0, 1, 0]],
    [[0, 1, 5, 4], [-dx / length, 0, dz / length]], [[3, 7, 6, 2], [dx / length, 0, -dz / length]],
    [[0, 4, 7, 3], [-dz / length, 0, -dx / length]], [[1, 2, 6, 5], [dz / length, 0, dx / length]]
  ];
  for (const [cornerIds, normal] of faces) {
    const baseIndex = group.positions.length / 3;
    for (const cornerId of cornerIds) {
      group.positions.push(...corners[cornerId]);
      group.normals.push(...normal);
    }
    group.indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  }
}

function normalizeVector3(vector) {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length > 1e-8 ? vector.map((value) => value / length) : null;
}

function crossVector3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function addVector3(left, right, scale = 1) {
  return [left[0] + right[0] * scale, left[1] + right[1] * scale, left[2] + right[2] * scale];
}

// Rail beams follow a stair slope in world space; box extrusion alone cannot represent that slope.
function pushBeamGeometry(group, start, end, thickness = 0.06) {
  if (!group || !start?.every(Number.isFinite) || !end?.every(Number.isFinite)) return false;
  const direction = normalizeVector3([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
  if (!direction) return false;
  const reference = Math.abs(direction[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
  const side = normalizeVector3(crossVector3(direction, reference));
  const normal = normalizeVector3(crossVector3(side, direction));
  if (!side || !normal) return false;
  const half = Math.max(0.018, Number(thickness) || 0.06) / 2;
  const corners = [
    addVector3(addVector3(start, side, half), normal, half),
    addVector3(addVector3(start, side, -half), normal, half),
    addVector3(addVector3(start, side, -half), normal, -half),
    addVector3(addVector3(start, side, half), normal, -half),
    addVector3(addVector3(end, side, half), normal, half),
    addVector3(addVector3(end, side, -half), normal, half),
    addVector3(addVector3(end, side, -half), normal, -half),
    addVector3(addVector3(end, side, half), normal, -half)
  ];
  const faces = [
    [[0, 1, 2, 3], direction.map((value) => -value)],
    [[4, 7, 6, 5], direction],
    [[0, 4, 5, 1], side],
    [[3, 2, 6, 7], side.map((value) => -value)],
    [[0, 3, 7, 4], normal],
    [[1, 5, 6, 2], normal.map((value) => -value)]
  ];
  for (const [cornerIds, faceNormal] of faces) {
    const baseIndex = group.positions.length / 3;
    for (const cornerId of cornerIds) {
      group.positions.push(...corners[cornerId]);
      group.normals.push(...faceNormal);
    }
    group.indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  }
  return true;
}

function pushTriangleGeometry(group, points, normal) {
  const baseIndex = group.positions.length / 3;
  for (const point of points) {
    group.positions.push(...point);
    group.normals.push(...normal);
  }
  group.indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
}

function pushConvexPrismGeometry(group, polygon, bottom, top) {
  if (!Array.isArray(polygon) || polygon.length < 3 || top <= bottom) return;
  for (let index = 1; index < polygon.length - 1; index += 1) {
    pushTriangleGeometry(group, [
      [polygon[0][0], top, polygon[0][1]],
      [polygon[index][0], top, polygon[index][1]],
      [polygon[index + 1][0], top, polygon[index + 1][1]]
    ], [0, 1, 0]);
    pushTriangleGeometry(group, [
      [polygon[0][0], bottom, polygon[0][1]],
      [polygon[index + 1][0], bottom, polygon[index + 1][1]],
      [polygon[index][0], bottom, polygon[index][1]]
    ], [0, -1, 0]);
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    const [x1, z1] = polygon[index]; const [x2, z2] = polygon[next];
    const dx = x2 - x1; const dz = z2 - z1;
    const length = Math.hypot(dx, dz) || 1;
    const normal = [dz / length, 0, -dx / length];
    const baseIndex = group.positions.length / 3;
    for (const point of [[x1, bottom, z1], [x1, top, z1], [x2, top, z2], [x2, bottom, z2]]) {
      group.positions.push(...point);
      group.normals.push(...normal);
    }
    group.indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  }
}

function pushPolygonPrismGeometry(group, polygon, bottom, top, holes = []) {
  const cleaned = cleanPolygon(polygon);
  if (cleaned.length < 3 || top <= bottom) return false;
  let contour = cleaned.map(([x, z]) => new Vector2(x, z));
  if (!ShapeUtils.isClockWise(contour)) contour = contour.reverse();
  const holeContours = holes.map(cleanPolygon).filter((hole) => hole.length >= 3).map((hole) => {
    let ring = hole.map(([x, z]) => new Vector2(x, z));
    if (ShapeUtils.isClockWise(ring)) ring = ring.reverse();
    return ring;
  });
  const flattened = [contour, ...holeContours].flat();
  const triangles = ShapeUtils.triangulateShape(contour, holeContours);
  if (!triangles.length) return false;
  for (const triangle of triangles) {
    pushTriangleGeometry(group, triangle.map((index) => [flattened[index].x, top, flattened[index].y]), [0, 1, 0]);
    pushTriangleGeometry(group, [...triangle].reverse().map((index) => [flattened[index].x, bottom, flattened[index].y]), [0, -1, 0]);
  }
  for (const [ringIndex, ring] of [contour, ...holeContours].entries()) {
    for (let index = 0; index < ring.length; index += 1) {
      const next = (index + 1) % ring.length;
      const x1 = ring[index].x; const z1 = ring[index].y;
      const x2 = ring[next].x; const z2 = ring[next].y;
      const dx = x2 - x1; const dz = z2 - z1;
      const length = Math.hypot(dx, dz) || 1;
      const normalSign = ringIndex === 0 ? 1 : -1;
      const normal = [dz / length * normalSign, 0, -dx / length * normalSign];
      const baseIndex = group.positions.length / 3;
      for (const point of [[x1, bottom, z1], [x1, top, z1], [x2, top, z2], [x2, bottom, z2]]) {
        group.positions.push(...point);
        group.normals.push(...normal);
      }
      group.indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
    }
  }
  return true;
}

function pointOnPolygonEdge(point, polygon, tolerance = 1e-4) {
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    const [ax, ay] = polygon[index]; const [bx, by] = polygon[next];
    const dx = bx - ax; const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared > 0 ? Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSquared)) : 0;
    if (Math.hypot(point[0] - (ax + dx * t), point[1] - (ay + dy * t)) <= tolerance) return true;
  }
  return false;
}

function pointInPolygon2d(point, polygon) {
  if (pointOnPolygonEdge(point, polygon)) return true;
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const [xi, yi] = polygon[index]; const [xj, yj] = polygon[previous];
    const intersects = ((yi > point[1]) !== (yj > point[1]))
      && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function normalizedDirection2d(direction, fallback = [1, 0]) {
  const values = Array.isArray(direction) ? [Number(direction[0]), Number(direction[1])] : fallback;
  const length = Math.hypot(values[0], values[1]);
  return Number.isFinite(length) && length > 1e-8 ? [values[0] / length, values[1] / length] : [...fallback];
}

function closestPointOnSegment2d(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 1e-12
    ? Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared))
    : 0;
  return [start[0] + dx * t, start[1] + dy * t];
}

function openingGapCandidate(opening, direction, surfacePolygons, wallSegments, wallThickness) {
  const width = Number(opening.widthM);
  if (!Number.isFinite(width) || width <= 0) return null;
  const halfWidth = width / 2;
  const normal = [-direction[1], direction[0]];
  const alongTolerance = Math.max(0.14, Math.min(0.45, width * 0.2));
  const normalTolerance = Math.max(0.25, Math.min(0.55, wallThickness * 2.5));
  const candidates = [];
  const addCandidate = (point, source, boundaryAlignment) => {
    const vx = point[0] - opening.center[0];
    const vy = point[1] - opening.center[1];
    const along = vx * direction[0] + vy * direction[1];
    const across = vx * normal[0] + vy * normal[1];
    const widthError = Math.abs(Math.abs(along) - halfWidth);
    if (Math.abs(along) < 1e-5 || widthError > alongTolerance || Math.abs(across) > normalTolerance) return;
    candidates.push({
      point, source, along, across,
      score: widthError / alongTolerance + Math.abs(across) / normalTolerance + boundaryAlignment * 0.2
    });
  };

  for (const polygon of surfacePolygons) {
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const edgeDirection = normalizedDirection2d([end[0] - start[0], end[1] - start[1]]);
      const parallelAlignment = Math.abs(edgeDirection[0] * direction[0] + edgeDirection[1] * direction[1]);
      if (parallelAlignment > 0.5) continue;
      addCandidate(closestPointOnSegment2d(opening.center, start, end), 'surface', parallelAlignment);
    }
  }

  for (const segment of wallSegments) {
    const segmentDirection = normalizedDirection2d([
      segment.end[0] - segment.start[0],
      segment.end[1] - segment.start[1]
    ]);
    const parallelAlignment = Math.abs(segmentDirection[0] * direction[0] + segmentDirection[1] * direction[1]);
    if (parallelAlignment < 0.8) continue;
    addCandidate(segment.start, 'line', 1 - parallelAlignment);
    addCandidate(segment.end, 'line', 1 - parallelAlignment);
  }

  const negative = candidates.filter((candidate) => candidate.along < 0).sort((left, right) => left.score - right.score)[0];
  const positive = candidates.filter((candidate) => candidate.along > 0).sort((left, right) => left.score - right.score)[0];
  if (!negative || !positive) return null;
  const resolvedWidth = positive.along - negative.along;
  if (resolvedWidth < width * 0.65 || resolvedWidth > width * 1.35) return null;
  const center = [
    (negative.point[0] + positive.point[0]) / 2,
    (negative.point[1] + positive.point[1]) / 2
  ];
  const centerAdjustmentM = Math.hypot(center[0] - opening.center[0], center[1] - opening.center[1]);
  if (centerAdjustmentM > Math.max(0.4, width * 0.28)) return null;
  const sources = new Set([negative.source, positive.source]);
  return {
    center,
    direction,
    widthM: resolvedWidth,
    centerAdjustmentM,
    method: sources.size > 1 ? 'mixed_gap' : sources.has('surface') ? 'surface_gap' : 'linear_gap',
    score: negative.score + positive.score
  };
}

function resolveOpeningAgainstWallGaps(opening, surfacePolygons, wallSegments, wallThickness) {
  const direction = normalizedDirection2d(opening.direction);
  const candidates = [
    openingGapCandidate(opening, direction, surfacePolygons, wallSegments, wallThickness),
    openingGapCandidate(opening, [-direction[1], direction[0]], surfacePolygons, wallSegments, wallThickness)
  ].filter(Boolean).sort((left, right) => left.score - right.score);
  const resolved = candidates[0];
  if (!resolved) return null;
  return {
    ...resolved,
    directionAdjusted: Math.abs(resolved.direction[0] * direction[0] + resolved.direction[1] * direction[1]) < 0.8
  };
}

function openingHoleForSurface(opening, surfacePolygon, wallThickness) {
  if (!pointInPolygon2d(opening.center, surfacePolygon)) return null;
  const directionLength = Math.hypot(opening.direction?.[0], opening.direction?.[1]) || 1;
  const direction = [(opening.direction?.[0] || 1) / directionLength, (opening.direction?.[1] || 0) / directionLength];
  const normal = [-direction[1], direction[0]];
  const halfWidth = Math.max(0.12, Number(opening.widthM) * 0.47);
  for (const depthFactor of [0.42, 0.28, 0.16, 0.08]) {
    const halfDepth = Math.max(0.012, wallThickness * depthFactor);
    const polygon = [
      [opening.center[0] - direction[0] * halfWidth - normal[0] * halfDepth, opening.center[1] - direction[1] * halfWidth - normal[1] * halfDepth],
      [opening.center[0] + direction[0] * halfWidth - normal[0] * halfDepth, opening.center[1] + direction[1] * halfWidth - normal[1] * halfDepth],
      [opening.center[0] + direction[0] * halfWidth + normal[0] * halfDepth, opening.center[1] + direction[1] * halfWidth + normal[1] * halfDepth],
      [opening.center[0] - direction[0] * halfWidth + normal[0] * halfDepth, opening.center[1] - direction[1] * halfWidth + normal[1] * halfDepth]
    ];
    if (polygon.every((point) => pointInPolygon2d(point, surfacePolygon))) return polygon;
  }
  return null;
}

function pushWallSurfaceWithOpenings(group, surfacePolygon, openings, bottom, top, wallThickness, windowSill, windowHead, doorHeight) {
  const matched = openings.map((opening) => ({ opening, hole: openingHoleForSurface(opening, surfacePolygon, wallThickness) })).filter((item) => item.hole);
  if (!matched.length) {
    pushPolygonPrismGeometry(group, surfacePolygon.map(([x, y]) => [x, -y]), bottom, top);
    return [];
  }
  const levels = new Set([bottom, top]);
  for (const { opening } of matched) {
    if (opening.kind === 'window') {
      levels.add(bottom + windowSill);
      levels.add(bottom + windowHead);
    } else {
      levels.add(bottom + doorHeight);
    }
  }
  const sortedLevels = [...levels].filter((value) => value >= bottom && value <= top).sort((left, right) => left - right);
  for (let index = 1; index < sortedLevels.length; index += 1) {
    const bandBottom = sortedLevels[index - 1]; const bandTop = sortedLevels[index];
    if (bandTop - bandBottom <= 1e-5) continue;
    const midpoint = (bandBottom + bandTop) / 2 - bottom;
    const holes = matched.filter(({ opening }) => opening.kind === 'window'
      ? midpoint > windowSill && midpoint < windowHead
      : midpoint < doorHeight).map(({ hole }) => hole.map(([x, y]) => [x, -y]));
    pushPolygonPrismGeometry(group, surfacePolygon.map(([x, y]) => [x, -y]), bandBottom, bandTop, holes);
  }
  return matched.map(({ opening }) => opening);
}

function convexHull2d(points) {
  const unique = [...new Map(points.map((point) => [`${Number(point[0]).toFixed(4)}:${Number(point[1]).toFixed(4)}`, [Number(point[0]), Number(point[1])]])).values()]
    .filter((point) => point.every(Number.isFinite))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (unique.length < 3) return [];
  const cross = (origin, a, b) => (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function distanceToPolygonEdges2d(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 2) return Infinity;
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    const closest = closestPointOnSegment2d(point, polygon[index], polygon[next]);
    distance = Math.min(distance, Math.hypot(point[0] - closest[0], point[1] - closest[1]));
  }
  return distance;
}

function walkPointClearance(point, floorPolygon, wallSegments, surfacePolygons) {
  const floorClearance = distanceToPolygonEdges2d(point, floorPolygon);
  const lineClearance = (wallSegments || []).reduce((minimum, segment) => {
    const start = [segment.start[0], -segment.start[1]];
    const end = [segment.end[0], -segment.end[1]];
    return Math.min(minimum, Math.hypot(...(() => {
      const closest = closestPointOnSegment2d(point, start, end);
      return [point[0] - closest[0], point[1] - closest[1]];
    })()));
  }, Infinity);
  const surfaceClearance = (surfacePolygons || []).reduce(
    (minimum, polygon) => Math.min(minimum, distanceToPolygonEdges2d(point, polygon)), Infinity
  );
  return Math.min(floorClearance, lineClearance, surfaceClearance);
}

function chooseWalkSpawnPoint(floorPolygon, wallSegments, surfacePolygons) {
  if (!Array.isArray(floorPolygon) || floorPolygon.length < 3) return { point: [0, 0], clearanceM: 0 };
  const bounds = polygonBounds2d(floorPolygon);
  const candidates = [centroid2d(floorPolygon)];
  for (let row = 1; row < 8; row += 1) {
    for (let column = 1; column < 8; column += 1) {
      const point = [
        bounds.min[0] + (bounds.max[0] - bounds.min[0]) * column / 8,
        bounds.min[1] + (bounds.max[1] - bounds.min[1]) * row / 8
      ];
      if (pointInPolygon2d(point, floorPolygon)) candidates.push(point);
    }
  }
  const ranked = candidates.map((point) => ({
    point,
    clearanceM: walkPointClearance(point, floorPolygon, wallSegments, surfacePolygons)
  })).sort((left, right) => right.clearanceM - left.clearanceM);
  const best = ranked[0] || { point: centroid2d(floorPolygon), clearanceM: 0 };
  return {
    point: best.point,
    clearanceM: Number(Math.max(0, best.clearanceM).toFixed(3))
  };
}

function walkFacingYaw(point, openings) {
  const windows = (openings || []).filter((opening) => opening.kind === 'window' && opening.center?.every(Number.isFinite));
  const nearest = windows.sort((left, right) => (
    Math.hypot(left.center[0] - point[0], -left.center[1] - point[1])
      - Math.hypot(right.center[0] - point[0], -right.center[1] - point[1])
  ))[0];
  if (!nearest) return 0;
  const dx = nearest.center[0] - point[0];
  const dz = -nearest.center[1] - point[1];
  return Number(Math.atan2(dx, -dz).toFixed(5));
}

function deduplicateOpenings(openings, precision = 0.05) {
  const seen = new Set();
  return openings.filter((opening) => {
    if (!['door', 'window'].includes(opening?.kind) || !opening.center?.every(Number.isFinite)) return false;
    const key = [opening.kind, ...opening.center.map((value) => Math.round(value / precision)), Math.round(Number(opening.widthM) / precision)].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function openingIntervalOnSegment(segment, opening, wallThickness) {
  const dx = segment.end[0] - segment.start[0];
  const dy = segment.end[1] - segment.start[1];
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 1e-6) return null;
  const ux = dx / length; const uy = dy / length;
  const openingDirection = Array.isArray(opening.direction) ? opening.direction : [ux, uy];
  const directionLength = Math.hypot(Number(openingDirection[0]), Number(openingDirection[1])) || 1;
  const alignment = Math.abs(ux * Number(openingDirection[0]) / directionLength + uy * Number(openingDirection[1]) / directionLength);
  if (alignment < 0.55) return null;
  const relX = opening.center[0] - segment.start[0];
  const relY = opening.center[1] - segment.start[1];
  const projection = relX * ux + relY * uy;
  const perpendicular = Math.abs(relX * uy - relY * ux);
  const halfWidth = Number(opening.widthM) / 2 + Math.max(0.04, wallThickness * 0.2);
  if (perpendicular > Math.max(0.6, wallThickness * 3) || projection < -halfWidth || projection > length + halfWidth) return null;
  const start = Math.max(0, projection - halfWidth);
  const end = Math.min(length, projection + halfWidth);
  return end - start >= 0.12 ? { start, end, opening, length, ux, uy } : null;
}

function splitSegmentForOpenings(segment, openings, wallThickness) {
  const intervals = openings.map((opening) => openingIntervalOnSegment(segment, opening, wallThickness)).filter(Boolean)
    .sort((left, right) => left.start - right.start);
  if (!intervals.length) return { pieces: [segment], intervals: [] };
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end + 0.02) {
      previous.end = Math.max(previous.end, interval.end);
      previous.openings.push(interval.opening);
    } else {
      merged.push({ ...interval, openings: [interval.opening] });
    }
  }
  const pieces = [];
  let cursor = 0;
  const pointAt = (distance) => [segment.start[0] + merged[0].ux * distance, segment.start[1] + merged[0].uy * distance];
  for (const interval of merged) {
    if (interval.start - cursor >= 0.12) pieces.push({ ...segment, start: pointAt(cursor), end: pointAt(interval.start) });
    cursor = Math.max(cursor, interval.end);
  }
  if (merged[0].length - cursor >= 0.12) pieces.push({ ...segment, start: pointAt(cursor), end: pointAt(merged[0].length) });
  return { pieces, intervals: merged };
}

export const DWG_SEMANTIC_MATERIALS = Object.freeze({
  wall: { label: '墙体', name: 'CAD painted masonry wall', color: '#d1cec2', rgba: [0.82, 0.81, 0.76, 1], roughness: 0.92 },
  column: { label: '结构柱', name: 'CAD concrete column', color: '#808584', rgba: [0.5, 0.52, 0.5, 1], roughness: 0.88 },
  glazing: { label: '玻璃隔断', name: 'CAD glazing partition', color: '#299baa', rgba: [0.16, 0.61, 0.67, 0.3], roughness: 0.18, alphaMode: 'BLEND' },
  core: { label: '交通核', name: 'CAD circulation core', color: '#575c5a', rgba: [0.34, 0.36, 0.35, 1], roughness: 0.82 },
  elevator: { label: '电梯与井道', name: 'CAD elevator and shaft', color: '#3979ad', rgba: [0.22, 0.47, 0.68, 1], roughness: 0.48, metallic: 0.16 },
  stair: { label: '楼梯', name: 'CAD stair flight', color: '#d18a2d', rgba: [0.82, 0.54, 0.18, 1], roughness: 0.78 },
  railing: { label: '护栏与栏杆', name: 'CAD guardrail and balustrade', color: '#c8d0cf', rgba: [0.72, 0.77, 0.76, 1], roughness: 0.34, metallic: 0.55 },
  handrail: { label: '扶手', name: 'CAD handrail', color: '#e3a44b', rgba: [0.89, 0.64, 0.29, 1], roughness: 0.3, metallic: 0.35 },
  floor: { label: '楼地面', name: 'CAD neutral stone floor', color: '#5c615e', rgba: [0.36, 0.38, 0.36, 1], roughness: 0.74 },
  door: { label: '门框', name: 'CAD metal door frame', color: '#474d4b', rgba: [0.28, 0.3, 0.29, 1], roughness: 0.58, metallic: 0.24 },
  doorLeaf: { label: '门扇', name: 'CAD timber door leaf', color: '#8f4d26', rgba: [0.56, 0.3, 0.15, 1], roughness: 0.66 },
  windowFrame: { label: '窗框', name: 'CAD aluminium window frame', color: '#293133', rgba: [0.16, 0.19, 0.2, 1], roughness: 0.42, metallic: 0.24 },
  window: { label: '窗玻璃', name: 'CAD window glass', color: '#248fab', rgba: [0.14, 0.56, 0.68, 0.42], roughness: 0.16, alphaMode: 'BLEND' },
  furniture: { label: '家具', name: 'CAD furniture component', color: '#a18e73', rgba: [0.63, 0.56, 0.45, 1], roughness: 0.76 },
  parking: { label: '停车位', name: 'CAD parking marking', color: '#e4c441', rgba: [0.89, 0.77, 0.25, 1], roughness: 0.68 },
  parkingMarking: { label: '车位边线', name: 'CAD parking outline', color: '#f6e58b', rgba: [0.96, 0.9, 0.55, 1], roughness: 0.58 },
  wheelStop: { label: '车轮挡', name: 'Parking wheel stop', color: '#f0f0e8', rgba: [0.94, 0.94, 0.91, 1], roughness: 0.82 },
  vehicleBody: { label: '车辆代理', name: 'Hypothesis vehicle body', color: '#b3483f', rgba: [0.7, 0.28, 0.25, 1], roughness: 0.52, metallic: 0.16 },
  vehicleGlass: { label: '车辆玻璃', name: 'Hypothesis vehicle glass', color: '#1f6574', rgba: [0.12, 0.4, 0.46, 0.62], roughness: 0.18, alphaMode: 'BLEND' },
  landscape: { label: '景观绿化', name: 'CAD landscape planting', color: '#4c985b', rgba: [0.3, 0.6, 0.36, 1], roughness: 0.9 },
  sanitary: { label: '卫生洁具', name: 'CAD sanitary fixture', color: '#d7e8e3', rgba: [0.84, 0.91, 0.89, 1], roughness: 0.34 },
  fireSafety: { label: '消防设施', name: 'CAD fire safety equipment', color: '#d9473f', rgba: [0.85, 0.28, 0.25, 1], roughness: 0.55 },
  equipment: { label: '机电设备', name: 'CAD building services equipment', color: '#8b6daf', rgba: [0.55, 0.43, 0.69, 1], roughness: 0.62, metallic: 0.1 }
});

const DWG_MESH_CATEGORY_ORDER = Object.keys(DWG_SEMANTIC_MATERIALS);

function clusterLinearSegments(segments = [], maximumMidpointDistance = 2.4) {
  const parent = segments.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const join = (left, right) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const midpoints = segments.map((segment) => [
    (segment.start[0] + segment.end[0]) / 2,
    (segment.start[1] + segment.end[1]) / 2
  ]);
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 1; right < segments.length; right += 1) {
      if (Math.hypot(midpoints[left][0] - midpoints[right][0], midpoints[left][1] - midpoints[right][1]) <= maximumMidpointDistance) join(left, right);
    }
  }
  const groups = new Map();
  segments.forEach((segment, index) => {
    const root = find(index);
    const group = groups.get(root) || [];
    group.push(segment);
    groups.set(root, group);
  });
  return [...groups.values()];
}

function deriveStairFlights(segments = []) {
  const candidates = segments.filter((segment) => segmentLength2d(segment) >= 0.3 && segmentLength2d(segment) <= 12);
  return clusterLinearSegments(candidates, 4.2).filter((group) => group.length >= 3).map((group) => {
    const reference = [...group].sort((left, right) => segmentLength2d(right) - segmentLength2d(left))[0];
    const length = segmentLength2d(reference) || 1;
    let tread = [(reference.end[0] - reference.start[0]) / length, (reference.end[1] - reference.start[1]) / length];
    if (tread[0] < -1e-6 || (Math.abs(tread[0]) <= 1e-6 && tread[1] < 0)) tread = tread.map((value) => -value);
    const run = [-tread[1], tread[0]];
    const points = group.flatMap((segment) => [segment.start, segment.end]);
    const treadValues = points.map((point) => point[0] * tread[0] + point[1] * tread[1]);
    const runValues = points.map((point) => point[0] * run[0] + point[1] * run[1]);
    return {
      tread,
      run,
      treadMin: Math.min(...treadValues),
      treadMax: Math.max(...treadValues),
      runMin: Math.min(...runValues),
      runMax: Math.max(...runValues),
      sourceSegmentCount: group.length
    };
  }).filter((flight) => flight.treadMax - flight.treadMin >= 0.6 && flight.runMax - flight.runMin >= 0.45
    && flight.treadMax - flight.treadMin <= 12 && flight.runMax - flight.runMin <= 18);
}

function stairWorldPoint(flight, treadValue, runValue, elevation) {
  const planX = flight.tread[0] * treadValue + flight.run[0] * runValue;
  const planY = flight.tread[1] * treadValue + flight.run[1] * runValue;
  return [planX, elevation, -planY];
}

function pushStairRailings(detailGroups, flight, floorBase, riseHeight) {
  const railingGroup = detailGroups?.railing;
  const handrailGroup = detailGroups?.handrail;
  if (!railingGroup && !handrailGroup) return { railingCount: 0, handrailCount: 0 };
  const runSpan = Math.max(0.45, flight.runMax - flight.runMin);
  const postCount = Math.max(2, Math.min(14, Math.ceil(runSpan / 1.1) + 1));
  const railingHeight = 1.05;
  const postThickness = 0.055;
  const handrailThickness = 0.075;
  let railingCount = 0;
  let handrailCount = 0;
  for (const side of [-1, 1]) {
    const edge = side < 0 ? flight.treadMin : flight.treadMax;
    const edgeOffset = side * 0.035;
    const posts = [];
    for (let index = 0; index < postCount; index += 1) {
      const fraction = index / (postCount - 1);
      const runValue = flight.runMin + runSpan * fraction;
      const baseElevation = floorBase + riseHeight * fraction;
      const point = stairWorldPoint(flight, edge + edgeOffset, runValue, baseElevation);
      const top = [point[0], point[1] + railingHeight, point[2]];
      posts.push(top);
      if (railingGroup && pushBeamGeometry(railingGroup, point, top, postThickness)) railingCount += 1;
    }
    for (let index = 1; index < posts.length; index += 1) {
      if (handrailGroup && pushBeamGeometry(handrailGroup, posts[index - 1], posts[index], handrailThickness)) handrailCount += 1;
      if (railingGroup) {
        const start = posts[index - 1].map((value, axis) => value + (axis === 1 ? -0.5 : 0));
        const end = posts[index].map((value, axis) => value + (axis === 1 ? -0.5 : 0));
        if (pushBeamGeometry(railingGroup, start, end, 0.045)) railingCount += 1;
      }
    }
  }
  return { railingCount, handrailCount };
}

function pushLinearRailingGeometry(groups, item, floorBase, wallHeight, category = 'railing') {
  const directionLength = Math.hypot(item.direction?.[0], item.direction?.[1]) || 1;
  const direction = [(item.direction?.[0] || 1) / directionLength, (item.direction?.[1] || 0) / directionLength];
  const width = Math.max(0.3, Number(item.widthM) || 1);
  const center = [Number(item.center?.[0]) || 0, Number(item.center?.[1]) || 0];
  const startPlan = [center[0] - direction[0] * width / 2, center[1] - direction[1] * width / 2];
  const endPlan = [center[0] + direction[0] * width / 2, center[1] + direction[1] * width / 2];
  const base = floorBase + 0.02;
  const height = category === 'handrail' ? Math.min(1.05, Math.max(0.72, wallHeight * 0.32)) : Math.min(1.2, Math.max(0.92, wallHeight * 0.38));
  const railingGroup = groups.railing;
  const handrailGroup = groups.handrail;
  const postCount = Math.max(2, Math.min(16, Math.ceil(width / 1.1) + 1));
  let railingCount = 0;
  let handrailCount = 0;
  const tops = [];
  for (let index = 0; index < postCount; index += 1) {
    const fraction = index / (postCount - 1);
    const plan = [startPlan[0] + (endPlan[0] - startPlan[0]) * fraction, startPlan[1] + (endPlan[1] - startPlan[1]) * fraction];
    const point = [plan[0], base, -plan[1]];
    const top = [plan[0], base + height, -plan[1]];
    tops.push(top);
    if (category !== 'handrail' && railingGroup && pushBeamGeometry(railingGroup, point, top, 0.055)) railingCount += 1;
  }
  if (category === 'handrail') {
    for (let index = 1; index < tops.length; index += 1) {
      if (handrailGroup && pushBeamGeometry(handrailGroup, tops[index - 1], tops[index], 0.075)) handrailCount += 1;
    }
  } else {
    for (let index = 1; index < tops.length; index += 1) {
      if (handrailGroup && pushBeamGeometry(handrailGroup, tops[index - 1], tops[index], 0.075)) handrailCount += 1;
      if (railingGroup) {
        const start = tops[index - 1].map((value, axis) => value + (axis === 1 ? -0.5 : 0));
        const end = tops[index].map((value, axis) => value + (axis === 1 ? -0.5 : 0));
        if (pushBeamGeometry(railingGroup, start, end, 0.045)) railingCount += 1;
      }
    }
  }
  return { railingCount, handrailCount };
}

function pushStairFlightGeometry(group, flight, floorBase, riseHeight, detailGroups = null) {
  const runSpan = flight.runMax - flight.runMin;
  const stepCount = Math.max(4, Math.min(24, Math.round(runSpan / 0.28)));
  const stepDepth = runSpan / stepCount;
  for (let index = 0; index < stepCount; index += 1) {
    const runPosition = flight.runMin + stepDepth * (index + 0.5);
    const start = [
      flight.tread[0] * flight.treadMin + flight.run[0] * runPosition,
      flight.tread[1] * flight.treadMin + flight.run[1] * runPosition
    ];
    const end = [
      flight.tread[0] * flight.treadMax + flight.run[0] * runPosition,
      flight.tread[1] * flight.treadMax + flight.run[1] * runPosition
    ];
    pushBoxGeometry(group, start, end, floorBase, floorBase + riseHeight * (index + 1) / stepCount, stepDepth);
  }
  return pushStairRailings(detailGroups, flight, floorBase, riseHeight);
}

function pushSemanticObjectGeometry(groups, item, floorBase, wallHeight, storeyHeight, parkingSequence = 0) {
  const category = item.category;
  const group = groups[category];
  if (!group) return false;
  const directionLength = Math.hypot(item.direction?.[0], item.direction?.[1]) || 1;
  const direction = [(item.direction?.[0] || 1) / directionLength, (item.direction?.[1] || 0) / directionLength];
  const width = Math.max(0.12, Number(item.widthM) || 0.6);
  const depth = Math.max(0.08, Number(item.depthM) || 0.4);
  const center = [Number(item.center?.[0]) || 0, Number(item.center?.[1]) || 0];
  const start = [center[0] - direction[0] * width / 2, center[1] - direction[1] * width / 2];
  const end = [center[0] + direction[0] * width / 2, center[1] + direction[1] * width / 2];
  if (category === 'parking') {
    pushBoxGeometry(group, start, end, floorBase + 0.012, floorBase + 0.045, depth);
    const perpendicular = [-direction[1], direction[0]];
    const halfDepth = depth / 2;
    const outlineThickness = Math.min(0.1, Math.max(0.045, Math.min(width, depth) * 0.025));
    const sideStartA = [start[0] - perpendicular[0] * halfDepth, start[1] - perpendicular[1] * halfDepth];
    const sideEndA = [end[0] - perpendicular[0] * halfDepth, end[1] - perpendicular[1] * halfDepth];
    const sideStartB = [start[0] + perpendicular[0] * halfDepth, start[1] + perpendicular[1] * halfDepth];
    const sideEndB = [end[0] + perpendicular[0] * halfDepth, end[1] + perpendicular[1] * halfDepth];
    pushBoxGeometry(groups.parkingMarking, sideStartA, sideEndA, floorBase + 0.047, floorBase + 0.064, outlineThickness);
    pushBoxGeometry(groups.parkingMarking, sideStartB, sideEndB, floorBase + 0.047, floorBase + 0.064, outlineThickness);
    pushBoxGeometry(groups.parkingMarking, sideStartA, sideStartB, floorBase + 0.047, floorBase + 0.064, outlineThickness);
    pushBoxGeometry(groups.parkingMarking, sideEndA, sideEndB, floorBase + 0.047, floorBase + 0.064, outlineThickness);

    const longDirection = width >= depth ? direction : perpendicular;
    const crossDirection = [-longDirection[1], longDirection[0]];
    const longLength = Math.max(width, depth);
    const shortLength = Math.min(width, depth);
    const stopCenter = [center[0] + longDirection[0] * longLength * 0.33, center[1] + longDirection[1] * longLength * 0.33];
    const stopHalf = Math.max(0.35, shortLength * 0.34);
    pushBoxGeometry(
      groups.wheelStop,
      [stopCenter[0] - crossDirection[0] * stopHalf, stopCenter[1] - crossDirection[1] * stopHalf],
      [stopCenter[0] + crossDirection[0] * stopHalf, stopCenter[1] + crossDirection[1] * stopHalf],
      floorBase + 0.05,
      floorBase + 0.16,
      Math.min(0.22, Math.max(0.12, longLength * 0.035))
    );

    if (parkingSequence % 6 === 0 && longLength >= 2.8 && shortLength >= 1.4) {
      const vehicleLength = Math.min(4.55, longLength * 0.78);
      const vehicleWidth = Math.min(1.88, shortLength * 0.78);
      const vehicleStart = [center[0] - longDirection[0] * vehicleLength / 2, center[1] - longDirection[1] * vehicleLength / 2];
      const vehicleEnd = [center[0] + longDirection[0] * vehicleLength / 2, center[1] + longDirection[1] * vehicleLength / 2];
      pushBoxGeometry(groups.vehicleBody, vehicleStart, vehicleEnd, floorBase + 0.12, floorBase + 0.83, vehicleWidth);
      const cabinLength = vehicleLength * 0.48;
      const cabinStart = [center[0] - longDirection[0] * cabinLength / 2, center[1] - longDirection[1] * cabinLength / 2];
      const cabinEnd = [center[0] + longDirection[0] * cabinLength / 2, center[1] + longDirection[1] * cabinLength / 2];
      pushBoxGeometry(groups.vehicleGlass, cabinStart, cabinEnd, floorBase + 0.82, floorBase + 1.32, vehicleWidth * 0.76);
      return { vehicleProxyCount: 1 };
    }
    return { vehicleProxyCount: 0 };
  } else if (category === 'landscape') {
    const perpendicular = [-direction[1], direction[0]];
    const trunkLength = Math.min(0.32, width * 0.18);
    const trunkStart = [center[0] - direction[0] * trunkLength / 2, center[1] - direction[1] * trunkLength / 2];
    const trunkEnd = [center[0] + direction[0] * trunkLength / 2, center[1] + direction[1] * trunkLength / 2];
    pushBoxGeometry(group, trunkStart, trunkEnd, floorBase, floorBase + Math.min(1.4, wallHeight * 0.45), Math.min(0.32, depth * 0.22));
    const crownBottom = floorBase + Math.min(0.9, wallHeight * 0.28);
    const crownTop = floorBase + Math.min(2.7, wallHeight * 0.86);
    pushBoxGeometry(group, start, end, crownBottom, crownTop, Math.max(0.45, depth * 0.72));
    const crossStart = [center[0] - perpendicular[0] * depth / 2, center[1] - perpendicular[1] * depth / 2];
    const crossEnd = [center[0] + perpendicular[0] * depth / 2, center[1] + perpendicular[1] * depth / 2];
    pushBoxGeometry(group, crossStart, crossEnd, crownBottom, crownTop, Math.max(0.45, width * 0.72));
  } else if (category === 'stair') {
    const run = [-direction[1], direction[0]];
    const detail = pushStairFlightGeometry(group, {
      tread: direction, run,
      treadMin: center[0] * direction[0] + center[1] * direction[1] - width / 2,
      treadMax: center[0] * direction[0] + center[1] * direction[1] + width / 2,
      runMin: center[0] * run[0] + center[1] * run[1] - depth / 2,
      runMax: center[0] * run[0] + center[1] * run[1] + depth / 2
    }, floorBase, storeyHeight, groups);
    return detail;
  } else if (category === 'railing' || category === 'handrail') {
    return pushLinearRailingGeometry(groups, item, floorBase, wallHeight, category);
  } else {
    const verticalRange = {
      sanitary: [0.04, Math.min(0.82, wallHeight * 0.3)],
      fireSafety: [0.35, Math.min(1.55, wallHeight * 0.52)],
      equipment: [0.04, Math.min(1.45, wallHeight * 0.5)],
      elevator: [0, wallHeight]
    }[category] || [0.02, Math.min(0.8, wallHeight * 0.3)];
    pushBoxGeometry(group, start, end, floorBase + verticalRange[0], floorBase + verticalRange[1], depth);
  }
  return { vehicleProxyCount: 0 };
}

function encodeMeshGlb(groups, metadata) {
  const binaryParts = [];
  let binaryOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const primitives = [];
  const materials = [];
  const appendBuffer = (buffer, target) => {
    const padding = (4 - (binaryOffset % 4)) % 4;
    if (padding) {
      binaryParts.push(Buffer.alloc(padding));
      binaryOffset += padding;
    }
    const viewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: binaryOffset, byteLength: buffer.byteLength, target });
    binaryParts.push(buffer);
    binaryOffset += buffer.byteLength;
    return viewIndex;
  };
  for (const category of DWG_MESH_CATEGORY_ORDER) {
    const group = groups[category];
    if (!group?.indices.length) continue;
    const positionValues = new Float32Array(group.positions);
    const normalValues = new Float32Array(group.normals);
    const indexValues = new Uint32Array(group.indices);
    const positionView = appendBuffer(Buffer.from(positionValues.buffer, positionValues.byteOffset, positionValues.byteLength), 34962);
    const normalView = appendBuffer(Buffer.from(normalValues.buffer, normalValues.byteOffset, normalValues.byteLength), 34962);
    const indexView = appendBuffer(Buffer.from(indexValues.buffer, indexValues.byteOffset, indexValues.byteLength), 34963);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positionValues.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis], positionValues[index + axis]);
        max[axis] = Math.max(max[axis], positionValues[index + axis]);
      }
    }
    const positionAccessor = accessors.push({ bufferView: positionView, componentType: 5126, count: positionValues.length / 3, type: 'VEC3', min, max }) - 1;
    const normalAccessor = accessors.push({ bufferView: normalView, componentType: 5126, count: normalValues.length / 3, type: 'VEC3' }) - 1;
    const indexAccessor = accessors.push({
      bufferView: indexView,
      componentType: 5125,
      count: indexValues.length,
      type: 'SCALAR',
      min: [0],
      max: [positionValues.length / 3 - 1]
    }) - 1;
    const definition = DWG_SEMANTIC_MATERIALS[category];
    const materialIndex = materials.push({
      name: definition.name,
      pbrMetallicRoughness: { baseColorFactor: definition.rgba, metallicFactor: definition.metallic || 0, roughnessFactor: definition.roughness },
      alphaMode: definition.alphaMode || 'OPAQUE',
      doubleSided: true,
      extras: { semanticCategory: category, semanticLabel: definition.label, displayColor: definition.color }
    }) - 1;
    primitives.push({ attributes: { POSITION: positionAccessor, NORMAL: normalAccessor }, indices: indexAccessor, material: materialIndex, mode: 4 });
  }
  if (!primitives.length) throw new Error('DWG_EXTRUSION_EMPTY');
  const binary = Buffer.concat(binaryParts);
  const json = {
    asset: { version: '2.0', generator: 'Spatial Reframe CAD interior generator', extras: metadata },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'CAD interior model' }],
    meshes: [{ name: 'CAD derived interior components', primitives }], materials,
    buffers: [{ byteLength: binary.byteLength }], bufferViews, accessors
  };
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const binPadding = (4 - (binary.length % 4)) % 4;
  const totalLength = 12 + 8 + jsonBytes.length + jsonPadding + 8 + binary.length + binPadding;
  const output = Buffer.alloc(totalLength);
  output.write('glTF', 0, 4, 'ascii'); output.writeUInt32LE(2, 4); output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonBytes.length + jsonPadding, 12); output.writeUInt32LE(0x4E4F534A, 16);
  jsonBytes.copy(output, 20); output.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPadding);
  const binHeader = 20 + jsonBytes.length + jsonPadding;
  output.writeUInt32LE(binary.length + binPadding, binHeader); output.writeUInt32LE(0x004E4942, binHeader + 4);
  binary.copy(output, binHeader + 8);
  return output;
}

function buildMultiLevelDwgInterior({
  levels, includeLayers, wallHeightM, wallThicknessM, floorSlabThicknessM, doorHeightM,
  windowSillM, windowHeadM, storeyHeightM, maximumSegments, maximumFurniture = 2500
}) {
  const height = clampNumber(wallHeightM, 1.8, 8, 3.2);
  const thickness = clampNumber(wallThicknessM, 0.05, 0.8, 0.18);
  const floorSlabThickness = clampNumber(floorSlabThicknessM, 0.05, 0.5, 0.12);
  const doorHeight = Math.min(height, clampNumber(doorHeightM, 1.8, 3.5, 2.1));
  const windowSill = clampNumber(windowSillM, 0, Math.max(0, height - 0.5), 0.9);
  const windowHead = clampNumber(windowHeadM, windowSill + 0.4, height, Math.min(2.4, height));
  const storeyHeight = clampNumber(storeyHeightM, height, 12, Math.max(3.6, height));
  const explicitLayers = new Set((Array.isArray(includeLayers) ? includeLayers : []).map(String));
  const categories = DWG_MESH_CATEGORY_ORDER;
  const groups = Object.fromEntries(categories.map((category) => [category, { positions: [], normals: [], indices: [] }]));
  const selectedLayerNames = new Set();
  const matchedOpeningKeys = new Set();
  const cutOpeningKeys = new Set();
  const openingCounts = { door: 0, window: 0 };
  const gapOpeningCounts = { door: 0, window: 0 };
  const cutOpeningCounts = { door: 0, window: 0 };
  const surfaceCounts = Object.fromEntries(categories.map((category) => [category, 0]));
  const categoryCounts = Object.fromEntries(categories.map((category) => [category, 0]));
  const levelMetadata = [];
  let wallPieceCount = 0;
  let selectedOpeningCount = 0;
  let selectedFurnitureCount = 0;
  let selectedSemanticObjectCount = 0;
  let outputSegmentCount = 0;
  let classifiedSegmentCount = 0;
  let floorSlabCount = 0;
  let surfaceOpeningCutCount = 0;
  let surfaceGapOpeningCount = 0;
  let linearGapOpeningCount = 0;
  let mixedGapOpeningCount = 0;
  let maximumOpeningSnapM = 0;
  let windowFrameCount = 0;
  let vehicleProxyCount = 0;

  const normalizedLevels = [...levels].sort((left, right) => Number(left.floorNumber) - Number(right.floorNumber));
  const furniturePerLevel = Math.max(1, Math.floor(clampNumber(maximumFurniture, 0, 10000, 2500) / normalizedLevels.length));
  normalizedLevels.forEach((level, levelIndex) => {
    const floorBase = levelIndex * storeyHeight;
    const detailCountsBefore = { railing: categoryCounts.railing, handrail: categoryCounts.handrail };
    const classified = deduplicateSegments((level.segments || []).map((segment) => ({
      ...segment,
      category: classifyDwgExtrusionLayer(segment.layer) || (explicitLayers.has(String(segment.layer)) ? 'wall' : null)
    })).filter((segment) => {
      const length = segmentLength2d(segment);
      return ['wall', 'column', 'glazing', 'core', 'elevator', 'stair', 'railing', 'handrail', 'fireSafety'].includes(segment.category)
        && (explicitLayers.size === 0 || explicitLayers.has(String(segment.layer))) && length >= 0.2 && length <= 40;
    }));
    classifiedSegmentCount += classified.length;
    const sourceOpenings = deduplicateOpenings(level.openings || []).filter((opening) => explicitLayers.size === 0 || explicitLayers.has(String(opening.layer)))
      .map((opening, index) => ({ ...opening, key: `level-${level.floorNumber}-opening-${index + 1}` }));
    const levelSurfaces = (level.surfaces || []).filter((surface) => ['wall', 'column', 'glazing', 'core', 'elevator', 'railing', 'handrail', 'fireSafety'].includes(surface.category)
      && (explicitLayers.size === 0 || explicitLayers.has(String(surface.layer))) && surface.areaM2 >= 0.01)
      .sort((left, right) => (left.category === 'wall' ? 0 : 1) - (right.category === 'wall' ? 0 : 1) || left.areaM2 - right.areaM2);
    const semanticSurfaces = (level.surfaces || []).filter((surface) => ['landscape', 'parking'].includes(surface.category)
      && (explicitLayers.size === 0 || explicitLayers.has(String(surface.layer))) && surface.areaM2 >= 0.05);
    const surfaceLayerKeys = new Set(levelSurfaces.map((surface) => `${surface.category}:${surface.layer}`));
    const fallbackSegments = classified.filter((segment) => !surfaceLayerKeys.has(`${segment.category}:${segment.layer}`));
    const limitedSegments = fallbackSegments.length > maximumSegments
      ? [...fallbackSegments].sort((left, right) => segmentLength2d(right) - segmentLength2d(left)).slice(0, maximumSegments)
      : fallbackSegments;
    const wallSegmentsForResolution = classified.filter((segment) => segment.category === 'wall');
    const wallSurfacePolygons = levelSurfaces.filter((surface) => surface.category === 'wall').map((surface) => surface.polygon);
    const gapCountsBefore = {
      surface: surfaceGapOpeningCount,
      linear: linearGapOpeningCount,
      mixed: mixedGapOpeningCount
    };
    const semanticCounts = Object.fromEntries(['elevator', 'stair', 'parking', 'landscape', 'sanitary', 'fireSafety', 'equipment', 'railing', 'handrail'].map((category) => [category, 0]));
    const openings = sourceOpenings.map((opening) => {
      const resolved = resolveOpeningAgainstWallGaps(opening, wallSurfacePolygons, wallSegmentsForResolution, thickness);
      if (!resolved) return opening;
      matchedOpeningKeys.add(opening.key);
      gapOpeningCounts[opening.kind] += 1;
      maximumOpeningSnapM = Math.max(maximumOpeningSnapM, resolved.centerAdjustmentM);
      if (resolved.method === 'surface_gap') surfaceGapOpeningCount += 1;
      else if (resolved.method === 'linear_gap') linearGapOpeningCount += 1;
      else mixedGapOpeningCount += 1;
      return {
        ...opening,
        center: resolved.center,
        direction: resolved.direction,
        widthM: resolved.widthM,
        wallGapResolution: {
          method: resolved.method,
          centerAdjustmentM: resolved.centerAdjustmentM,
          directionAdjusted: resolved.directionAdjusted,
          evidence: 'Derived'
        }
      };
    });
    selectedOpeningCount += openings.length;
    for (const opening of openings) {
      openingCounts[opening.kind] += 1;
      selectedLayerNames.add(String(opening.layer));
    }
    outputSegmentCount += limitedSegments.length;
    for (const segment of limitedSegments) selectedLayerNames.add(String(segment.layer));
    const surfaceCutsBefore = surfaceOpeningCutCount;
    for (const surface of levelSurfaces) {
      selectedLayerNames.add(String(surface.layer));
      surfaceCounts[surface.category] += 1;
      categoryCounts[surface.category] += 1;
      if (surface.category === 'wall') {
        const availableOpenings = openings.filter((opening) => !matchedOpeningKeys.has(opening.key));
        const matched = pushWallSurfaceWithOpenings(
          groups.wall, surface.polygon, availableOpenings, floorBase, floorBase + height,
          thickness, windowSill, windowHead, doorHeight
        );
        for (const opening of matched) {
          matchedOpeningKeys.add(opening.key);
          if (!cutOpeningKeys.has(opening.key)) cutOpeningCounts[opening.kind] += 1;
          cutOpeningKeys.add(opening.key);
        }
        surfaceOpeningCutCount += matched.length;
      } else {
        pushPolygonPrismGeometry(
          groups[surface.category],
          surface.polygon.map(([x, y]) => [x, -y]),
          floorBase,
          floorBase + height
        );
      }
    }
    for (const surface of semanticSurfaces) {
      selectedLayerNames.add(String(surface.layer));
      surfaceCounts[surface.category] += 1;
      categoryCounts[surface.category] += 1;
      semanticCounts[surface.category] += 1;
      pushPolygonPrismGeometry(
        groups[surface.category],
        surface.polygon.map(([x, y]) => [x, -y]),
        floorBase + 0.012,
        floorBase + 0.055
      );
    }

    const floorCandidate = [...(level.footprints || [])].filter((item) => item.areaM2 >= 20).sort((left, right) => right.areaM2 - left.areaM2)[0];
    let floorPolygon = floorCandidate?.polygon?.map(([x, y]) => [x, -y]) || [];
    let floorEvidence = floorCandidate ? 'Derived' : 'Hypothesis';
    if (floorPolygon.length < 3) {
      floorPolygon = convexHull2d([
        ...limitedSegments.flatMap((segment) => [[segment.start[0], -segment.start[1]], [segment.end[0], -segment.end[1]]]),
        ...levelSurfaces.flatMap((surface) => surface.polygon.map(([x, y]) => [x, -y]))
      ]);
    }
    if (floorPolygon.length >= 3 && pushPolygonPrismGeometry(groups.floor, floorPolygon, floorBase - floorSlabThickness, floorBase)) {
      floorSlabCount += 1;
      categoryCounts.floor += 1;
    }

    const stairSegments = limitedSegments.filter((segment) => segment.category === 'stair');
    const stairFlights = deriveStairFlights(stairSegments);
    for (const flight of stairFlights) {
      const detail = pushStairFlightGeometry(groups.stair, flight, floorBase, storeyHeight, groups);
      categoryCounts.railing += Number(detail.railingCount || 0);
      categoryCounts.handrail += Number(detail.handrailCount || 0);
    }
    categoryCounts.stair += stairFlights.length;
    semanticCounts.stair += stairFlights.length;
    const elevatorSegments = limitedSegments.filter((segment) => segment.category === 'elevator');
    const elevatorComponents = clusterLinearSegments(elevatorSegments, 2.6);
    categoryCounts.elevator += elevatorComponents.length;
    semanticCounts.elevator += elevatorComponents.length;

    for (const segment of limitedSegments.filter((item) => item.category !== 'stair')) {
      if (segment.category === 'railing' || segment.category === 'handrail') {
        const directionLength = segmentLength2d(segment) || 1;
        const item = {
          category: segment.category,
          center: [(segment.start[0] + segment.end[0]) / 2, (segment.start[1] + segment.end[1]) / 2],
          direction: [(segment.end[0] - segment.start[0]) / directionLength, (segment.end[1] - segment.start[1]) / directionLength],
          widthM: directionLength,
          layer: segment.layer
        };
        const detail = pushLinearRailingGeometry(groups, item, floorBase, height, segment.category);
        categoryCounts.railing += Number(detail.railingCount || 0);
        categoryCounts.handrail += Number(detail.handrailCount || 0);
        semanticCounts[segment.category] += 1;
        continue;
      }
      const categoryThickness = segment.category === 'column' ? Math.max(thickness, 0.3)
        : segment.category === 'glazing' ? Math.max(0.06, thickness * 0.55)
          : segment.category === 'elevator' ? Math.max(0.12, thickness * 0.85)
            : segment.category === 'fireSafety' ? Math.max(0.1, thickness * 0.72) : thickness;
      if (segment.category !== 'wall') {
        pushBoxGeometry(groups[segment.category], segment.start, segment.end, floorBase, floorBase + height, categoryThickness);
        if (segment.category !== 'elevator') {
          categoryCounts[segment.category] += 1;
          if (semanticCounts[segment.category] !== undefined) semanticCounts[segment.category] += 1;
        }
        continue;
      }
      const split = splitSegmentForOpenings(segment, openings.filter((opening) => !matchedOpeningKeys.has(opening.key)), thickness);
      wallPieceCount += split.pieces.length;
      categoryCounts.wall += 1;
      for (const piece of split.pieces) pushBoxGeometry(groups.wall, piece.start, piece.end, floorBase, floorBase + height, thickness);
      for (const interval of split.intervals) {
        interval.openings.forEach((opening) => {
          matchedOpeningKeys.add(opening.key);
          if (!cutOpeningKeys.has(opening.key)) cutOpeningCounts[opening.kind] += 1;
          cutOpeningKeys.add(opening.key);
        });
        const start = [segment.start[0] + interval.ux * interval.start, segment.start[1] + interval.uy * interval.start];
        const end = [segment.start[0] + interval.ux * interval.end, segment.start[1] + interval.uy * interval.end];
        const primaryOpening = interval.openings.find((opening) => opening.kind === 'door') || interval.openings[0];
        if (primaryOpening.kind === 'window') {
          if (windowSill > 0.05) pushBoxGeometry(groups.wall, start, end, floorBase, floorBase + windowSill, thickness);
          if (windowHead < height - 0.05) pushBoxGeometry(groups.wall, start, end, floorBase + windowHead, floorBase + height, thickness);
        } else if (doorHeight < height - 0.05) pushBoxGeometry(groups.wall, start, end, floorBase + doorHeight, floorBase + height, thickness);
      }
    }

    for (const opening of openings) {
      const directionLength = Math.hypot(opening.direction?.[0], opening.direction?.[1]) || 1;
      const direction = [(opening.direction?.[0] || 1) / directionLength, (opening.direction?.[1] || 0) / directionLength];
      const halfWidth = Number(opening.widthM) / 2;
      const start = [opening.center[0] - direction[0] * halfWidth, opening.center[1] - direction[1] * halfWidth];
      const end = [opening.center[0] + direction[0] * halfWidth, opening.center[1] + direction[1] * halfWidth];
      if (opening.kind === 'window') {
        const frameWidth = Math.min(0.11, Math.max(0.055, thickness * 0.42));
        const frameDepth = Math.max(0.065, thickness * 0.72);
        const postAt = (distance) => {
          const center = [start[0] + direction[0] * distance, start[1] + direction[1] * distance];
          return [
            [center[0] - direction[0] * frameWidth / 2, center[1] - direction[1] * frameWidth / 2],
            [center[0] + direction[0] * frameWidth / 2, center[1] + direction[1] * frameWidth / 2]
          ];
        };
        const panelCount = Math.max(1, Math.ceil(Number(opening.widthM) / 1.35));
        for (let panelIndex = 0; panelIndex <= panelCount; panelIndex += 1) {
          const post = postAt(Number(opening.widthM) * panelIndex / panelCount);
          pushBoxGeometry(groups.windowFrame, post[0], post[1], floorBase + windowSill, floorBase + windowHead, frameDepth);
        }
        pushBoxGeometry(groups.windowFrame, start, end, floorBase + windowSill, floorBase + windowSill + frameWidth, frameDepth);
        pushBoxGeometry(groups.windowFrame, start, end, floorBase + windowHead - frameWidth, floorBase + windowHead, frameDepth);
        const glassStart = [start[0] + direction[0] * frameWidth, start[1] + direction[1] * frameWidth];
        const glassEnd = [end[0] - direction[0] * frameWidth, end[1] - direction[1] * frameWidth];
        pushBoxGeometry(groups.window, glassStart, glassEnd, floorBase + windowSill + frameWidth, floorBase + windowHead - frameWidth, Math.max(0.025, thickness * 0.18));
        windowFrameCount += 1;
        categoryCounts.windowFrame += 1;
        categoryCounts.window += 1;
      } else {
        const jambWidth = Math.min(0.1, Math.max(0.055, thickness * 0.42));
        const startPost = [[start[0] - direction[0] * jambWidth / 2, start[1] - direction[1] * jambWidth / 2], [start[0] + direction[0] * jambWidth / 2, start[1] + direction[1] * jambWidth / 2]];
        const endPost = [[end[0] - direction[0] * jambWidth / 2, end[1] - direction[1] * jambWidth / 2], [end[0] + direction[0] * jambWidth / 2, end[1] + direction[1] * jambWidth / 2]];
        pushBoxGeometry(groups.door, startPost[0], startPost[1], floorBase, floorBase + doorHeight, Math.max(0.08, thickness));
        pushBoxGeometry(groups.door, endPost[0], endPost[1], floorBase, floorBase + doorHeight, Math.max(0.08, thickness));
        pushBoxGeometry(groups.door, start, end, floorBase + doorHeight - jambWidth, floorBase + doorHeight, Math.max(0.08, thickness));
        const openAngle = Math.PI * 0.36;
        const leafDirection = [
          direction[0] * Math.cos(openAngle) - direction[1] * Math.sin(openAngle),
          direction[0] * Math.sin(openAngle) + direction[1] * Math.cos(openAngle)
        ];
        const leafEnd = [start[0] + leafDirection[0] * Number(opening.widthM) * 0.92, start[1] + leafDirection[1] * Number(opening.widthM) * 0.92];
        pushBoxGeometry(groups.doorLeaf, start, leafEnd, floorBase + 0.04, floorBase + doorHeight - 0.04, 0.045);
        categoryCounts.door += 1;
        categoryCounts.doorLeaf += 1;
      }
    }

    const furnishings = (level.furnishings || []).slice(0, furniturePerLevel);
    selectedFurnitureCount += furnishings.length;
    for (const item of furnishings) {
      const directionLength = Math.hypot(item.direction?.[0], item.direction?.[1]) || 1;
      const direction = [(item.direction?.[0] || 1) / directionLength, (item.direction?.[1] || 0) / directionLength];
      const halfWidth = item.widthM / 2;
      const start = [item.center[0] - direction[0] * halfWidth, item.center[1] - direction[1] * halfWidth];
      const end = [item.center[0] + direction[0] * halfWidth, item.center[1] + direction[1] * halfWidth];
      pushBoxGeometry(groups.furniture, start, end, floorBase, floorBase + item.heightM, item.depthM);
      categoryCounts.furniture += 1;
    }

    const semanticObjects = (level.semanticObjects || []).filter((item) => groups[item.category]
      && (explicitLayers.size === 0 || explicitLayers.has(String(item.layer))));
    selectedSemanticObjectCount += semanticObjects.length;
    let parkingSequence = 0;
    for (const item of semanticObjects) {
      selectedLayerNames.add(String(item.layer));
      const result = pushSemanticObjectGeometry(groups, item, floorBase, height, storeyHeight, parkingSequence);
      if (!result) continue;
      if (item.category === 'parking') parkingSequence += 1;
      vehicleProxyCount += Number(result.vehicleProxyCount || 0);
      if (item.category === 'parking') {
        categoryCounts.parkingMarking += 4;
        categoryCounts.wheelStop += 1;
        categoryCounts.vehicleBody += Number(result.vehicleProxyCount || 0);
        categoryCounts.vehicleGlass += Number(result.vehicleProxyCount || 0);
      }
      if (item.category === 'railing' || item.category === 'handrail') {
        categoryCounts.railing += Number(result.railingCount || 0);
        categoryCounts.handrail += Number(result.handrailCount || 0);
      } else {
        categoryCounts[item.category] += 1;
      }
      if (semanticCounts[item.category] !== undefined) semanticCounts[item.category] += 1;
    }

    const walkSpawn = floorPolygon.length >= 3
      ? chooseWalkSpawnPoint(
        floorPolygon,
        classified.filter((segment) => segment.category === 'wall'),
        levelSurfaces.filter((surface) => surface.category === 'wall').map((surface) => surface.polygon.map(([x, y]) => [x, -y]))
      )
      : { point: [0, 0], clearanceM: 0 };
    const walkFacing = walkFacingYaw(walkSpawn.point, openings);
    semanticCounts.railing = categoryCounts.railing - detailCountsBefore.railing;
    semanticCounts.handrail = categoryCounts.handrail - detailCountsBefore.handrail;

    const duplicateLabelCounts = new Map();
    const spaces = (level.spaces || []).map((space, index) => {
      const occurrence = (duplicateLabelCounts.get(space.label) || 0) + 1;
      duplicateLabelCounts.set(space.label, occurrence);
      return {
        id: `space-${level.floorNumber}-${String(index + 1).padStart(3, '0')}`,
        label: space.label,
        displayLabel: occurrence > 1 ? `${space.label} ${occurrence}` : space.label,
        type: space.type,
        floorNumber: Number(level.floorNumber),
        positionM: [Number(space.point[0].toFixed(3)), Number(floorBase.toFixed(3)), Number((-space.point[1]).toFixed(3))],
        visitPointM: [Number(space.point[0].toFixed(3)), Number((floorBase + Math.min(1.62, height * 0.55)).toFixed(3)), Number((-space.point[1]).toFixed(3))],
        evidence: space.evidence || 'Derived',
        geometryStatus: 'label_anchor_only',
        sourceLayer: space.sourceLayer || ''
      };
    });

    levelMetadata.push({
      floorNumber: level.floorNumber,
      label: level.label || `${level.floorNumber}F`,
      elevationM: Number(floorBase.toFixed(3)),
      sourceFrameCenterM: level.sourceFrame?.center || level.sourceFrame?.bounds?.center || null,
      segmentCount: limitedSegments.length,
      surfaceCount: levelSurfaces.length,
      openingCount: openings.length,
      doorCount: openings.filter((opening) => opening.kind === 'door').length,
      windowCount: openings.filter((opening) => opening.kind === 'window').length,
      surfaceOpeningCutCount: surfaceOpeningCutCount - surfaceCutsBefore,
      openingGapCount: (surfaceGapOpeningCount - gapCountsBefore.surface)
        + (linearGapOpeningCount - gapCountsBefore.linear)
        + (mixedGapOpeningCount - gapCountsBefore.mixed),
      furnishingCount: furnishings.length,
      semanticObjectCount: semanticObjects.length,
      semanticCounts,
      spaces,
      spaceCount: spaces.length,
      stairFlightCount: stairFlights.length,
      railingCount: categoryCounts.railing - detailCountsBefore.railing,
      handrailCount: categoryCounts.handrail - detailCountsBefore.handrail,
      walkSpawnM: [Number(walkSpawn.point[0].toFixed(3)), Number((floorBase + Math.min(1.62, height * 0.55)).toFixed(3)), Number(walkSpawn.point[1].toFixed(3))],
      walkSpawnClearanceM: walkSpawn.clearanceM,
      walkFacingYaw: walkFacing,
      walkSpawnEvidence: floorEvidence,
      floorEnvelopeEvidence: floorEvidence
    });
  });

  const allPositions = [];
  for (const group of Object.values(groups)) for (const value of group.positions) allPositions.push(value);
  if (!allPositions.length) throw new Error('DWG_EXTRUSION_NO_ARCHITECTURAL_LAYERS');
  const outputTriangles = Object.values(groups).reduce((sum, group) => sum + group.indices.length / 3, 0);
  const modelBounds = boundsFromPositions(allPositions);
  const metadata = {
    schema: 'dwg_interior_model.v4', units: 'metres', axes: 'Y-up', coordinateStatus: 'relative_metric', georeferenced: false,
    sourceGeometryEvidence: 'Derived', verticalParametersEvidence: 'Hypothesis', openingGeometryEvidence: 'Derived',
    floorEnvelopeEvidence: levelMetadata.every((level) => level.floorEnvelopeEvidence === 'Derived') ? 'Derived' : 'Mixed',
    wallHeightM: height, wallThicknessM: thickness, floorSlabThicknessM: floorSlabThickness,
    doorHeightM: doorHeight, windowSillM: windowSill, windowHeadM: windowHead,
    floorCount: normalizedLevels.length, levelCount: normalizedLevels.length, storeyHeightM: storeyHeight,
    levels: levelMetadata, classifiedSegmentCount, outputSegmentCount, selectedOpeningCount,
    openingCounts, wallOpeningCutCount: cutOpeningKeys.size, surfaceOpeningCutCount,
    surfaceGapOpeningCount, linearGapOpeningCount, mixedGapOpeningCount,
    openingResolvedCount: matchedOpeningKeys.size,
    gapOpeningCounts,
    cutOpeningCounts,
    resolvedOpeningCounts: {
      door: gapOpeningCounts.door + cutOpeningCounts.door,
      window: gapOpeningCounts.window + cutOpeningCounts.window
    },
    maximumOpeningSnapM: Number(maximumOpeningSnapM.toFixed(4)),
    wallPieceCount, floorSlabCount,
    surfaceCounts, selectedFurnitureCount, selectedSemanticObjectCount, windowFrameCount, categoryCounts, outputTriangles,
    railingCount: categoryCounts.railing, handrailCount: categoryCounts.handrail,
    vehicleProxyCount, vehicleProxyEvidence: 'Hypothesis',
    semanticLegend: Object.fromEntries(Object.entries(DWG_SEMANTIC_MATERIALS).map(([category, definition]) => [category, {
      label: definition.label,
      color: definition.color,
      material: definition.name
    }])),
    selectedLayers: [...selectedLayerNames].sort(), sourceOriginMetres: [0, 0, 0], bounds: normalizeBounds(modelBounds),
    dataGaps: [
      '各楼层平面几何、墙体填充、柱位和门窗块来自 CAD；楼层高程参数需要建筑师核验。',
      '墙体填充面和线性墙均按 CAD 门窗块位置生成概念级洞口；洞口高度与窗框分格仍需建筑师核验。',
      '楼板优先使用当层闭合轮廓；缺少闭合轮廓的楼层使用建筑线凸包，需复核中庭和洞口。',
      '家具平面范围来自 CAD 块，家具高度和门扇开启角度属于 Hypothesis。',
      '楼梯、电梯、停车、景观、洁具、消防、机电以及 CAD 明确标注的栏杆/扶手平面定位来自 CAD 图层或图块；楼梯升高、栏杆高度与间距、植物体量和设备高度属于 Hypothesis。',
      '楼梯两侧栏杆、立柱、中间横杆和扶手由楼梯梯段边界 Derived；构件高度、管径与间距属于 Hypothesis，需按现场或规范复核。',
      '空间名称和参观锚点来自 CAD 文字位置，当前未推断完整房间边界；稀疏车辆代理仅用于体验车库尺度，车辆类型与占用状态属于 Hypothesis。',
      '与 SKP 或 OSM 同场叠加前仍需控制点或变换矩阵配准。'
    ]
  };
  return { glb: encodeMeshGlb(groups, metadata), metadata };
}

export function buildDwgExtrusionGlb({
  segments = [], openings = [], levels = [], includeLayers = [], wallHeightM = 3.2, wallThicknessM = 0.18,
  floorSlabThicknessM = 0.12, doorHeightM = 2.1, windowSillM = 0.9, windowHeadM = 2.4,
  floorCount = 1, storeyHeightM = 3.6, regionMode = 'auto_dominant', regionRadiusM = 90,
  maximumSegments = 8000
} = {}) {
  if (Array.isArray(levels) && levels.length) {
    return buildMultiLevelDwgInterior({
      levels, includeLayers, wallHeightM, wallThicknessM, floorSlabThicknessM, doorHeightM,
      windowSillM, windowHeadM, storeyHeightM, maximumSegments
    });
  }
  const height = clampNumber(wallHeightM, 1.8, 8, 3.2);
  const thickness = clampNumber(wallThicknessM, 0.05, 0.8, 0.18);
  const floorSlabThickness = clampNumber(floorSlabThicknessM, 0.05, 0.5, 0.12);
  const doorHeight = Math.min(height, clampNumber(doorHeightM, 1.8, 3.5, 2.1));
  const windowSill = clampNumber(windowSillM, 0, Math.max(0, height - 0.5), 0.9);
  const windowHead = clampNumber(windowHeadM, windowSill + 0.4, height, Math.min(2.4, height));
  const floors = Math.round(clampNumber(floorCount, 1, 20, 1));
  const storeyHeight = clampNumber(storeyHeightM, height, 12, Math.max(3.6, height));
  const radius = clampNumber(regionRadiusM, 20, 300, 90);
  const explicitLayers = new Set((Array.isArray(includeLayers) ? includeLayers : []).map(String));
  const classified = segments.map((segment) => ({
    ...segment,
    category: classifyDwgExtrusionLayer(segment.layer) || (explicitLayers.has(String(segment.layer)) ? 'wall' : null)
  })).filter((segment) => {
    const length = segmentLength2d(segment);
    return ['wall', 'column', 'glazing', 'core'].includes(segment.category)
      && (explicitLayers.size === 0 || explicitLayers.has(String(segment.layer))) && length >= 0.5 && length <= 30;
  });
  const deduplicated = deduplicateSegments(classified);
  const region = regionMode === 'all_candidates'
    ? { segments: deduplicated, center: null, omitted: 0 }
    : selectDominantPlanRegion(deduplicated, radius);
  const limited = region.segments.length > maximumSegments
    ? [...region.segments].sort((left, right) => segmentLength2d(right) - segmentLength2d(left)).slice(0, maximumSegments)
    : region.segments;
  if (!limited.length) throw new Error('DWG_EXTRUSION_NO_ARCHITECTURAL_LAYERS');
  const bounds = segmentBounds(limited);
  const origin = bounds?.center || [0, 0, 0];
  const selectedOpenings = deduplicateOpenings(openings)
    .filter((opening) => explicitLayers.size === 0 || explicitLayers.has(String(opening.layer)))
    .filter((opening) => opening.center[0] >= bounds.min[0] - 3 && opening.center[0] <= bounds.max[0] + 3
      && opening.center[1] >= bounds.min[1] - 3 && opening.center[1] <= bounds.max[1] + 3)
    .map((opening, index) => ({ ...opening, key: `opening-${index + 1}` }));
  const groups = Object.fromEntries(['wall', 'column', 'glazing', 'core', 'floor', 'door', 'window']
    .map((category) => [category, { positions: [], normals: [], indices: [] }]));
  const matchedOpeningKeys = new Set();
  let wallPieceCount = 0;
  const floorHull = convexHull2d(limited.flatMap((segment) => [
    [segment.start[0] - origin[0], -(segment.start[1] - origin[1])],
    [segment.end[0] - origin[0], -(segment.end[1] - origin[1])]
  ]));
  for (let floor = 0; floor < floors; floor += 1) {
    const floorBase = floor * storeyHeight;
    if (floorHull.length >= 3) pushConvexPrismGeometry(groups.floor, floorHull, floorBase - floorSlabThickness, floorBase);
    for (const segment of limited) {
      const categoryThickness = segment.category === 'column' ? Math.max(thickness, 0.3) : segment.category === 'glazing' ? Math.max(0.06, thickness * 0.55) : thickness;
      if (segment.category !== 'wall') {
        const start = [segment.start[0] - origin[0], segment.start[1] - origin[1]];
        const end = [segment.end[0] - origin[0], segment.end[1] - origin[1]];
        pushBoxGeometry(groups[segment.category], start, end, floorBase, floorBase + height, categoryThickness);
        continue;
      }
      const split = splitSegmentForOpenings(segment, selectedOpenings, thickness);
      if (floor === 0) wallPieceCount += split.pieces.length;
      for (const piece of split.pieces) {
        const start = [piece.start[0] - origin[0], piece.start[1] - origin[1]];
        const end = [piece.end[0] - origin[0], piece.end[1] - origin[1]];
        pushBoxGeometry(groups.wall, start, end, floorBase, floorBase + height, thickness);
      }
      for (const interval of split.intervals) {
        interval.openings.forEach((opening) => matchedOpeningKeys.add(opening.key));
        const start = [segment.start[0] + interval.ux * interval.start - origin[0], segment.start[1] + interval.uy * interval.start - origin[1]];
        const end = [segment.start[0] + interval.ux * interval.end - origin[0], segment.start[1] + interval.uy * interval.end - origin[1]];
        const primaryOpening = interval.openings.find((opening) => opening.kind === 'door') || interval.openings[0];
        if (primaryOpening.kind === 'window') {
          if (windowSill > 0.05) pushBoxGeometry(groups.wall, start, end, floorBase, floorBase + windowSill, thickness);
          if (windowHead < height - 0.05) pushBoxGeometry(groups.wall, start, end, floorBase + windowHead, floorBase + height, thickness);
        } else if (doorHeight < height - 0.05) {
          pushBoxGeometry(groups.wall, start, end, floorBase + doorHeight, floorBase + height, thickness);
        }
      }
    }
    for (const opening of selectedOpenings) {
      const directionLength = Math.hypot(opening.direction[0], opening.direction[1]) || 1;
      const direction = [opening.direction[0] / directionLength, opening.direction[1] / directionLength];
      const halfWidth = opening.widthM / 2;
      const start = [opening.center[0] - direction[0] * halfWidth - origin[0], opening.center[1] - direction[1] * halfWidth - origin[1]];
      const end = [opening.center[0] + direction[0] * halfWidth - origin[0], opening.center[1] + direction[1] * halfWidth - origin[1]];
      if (opening.kind === 'window') {
        pushBoxGeometry(groups.window, start, end, floorBase + windowSill, floorBase + windowHead, Math.max(0.04, thickness * 0.35));
      } else {
        const jambWidth = Math.min(0.1, Math.max(0.055, thickness * 0.42));
        const startPost = [[start[0] - direction[0] * jambWidth / 2, start[1] - direction[1] * jambWidth / 2], [start[0] + direction[0] * jambWidth / 2, start[1] + direction[1] * jambWidth / 2]];
        const endPost = [[end[0] - direction[0] * jambWidth / 2, end[1] - direction[1] * jambWidth / 2], [end[0] + direction[0] * jambWidth / 2, end[1] + direction[1] * jambWidth / 2]];
        pushBoxGeometry(groups.door, startPost[0], startPost[1], floorBase, floorBase + doorHeight, Math.max(0.08, thickness));
        pushBoxGeometry(groups.door, endPost[0], endPost[1], floorBase, floorBase + doorHeight, Math.max(0.08, thickness));
        pushBoxGeometry(groups.door, start, end, floorBase + doorHeight - jambWidth, floorBase + doorHeight, Math.max(0.08, thickness));
      }
    }
  }
  const outputTriangles = Object.values(groups).reduce((sum, group) => sum + group.indices.length / 3, 0);
  const sourceCategoryCounts = Object.fromEntries(['wall', 'column', 'glazing', 'core'].map((category) => [category, limited.filter((segment) => segment.category === category).length]));
  const openingCounts = Object.fromEntries(['door', 'window'].map((kind) => [kind, selectedOpenings.filter((opening) => opening.kind === kind).length]));
  const metadata = {
    schema: 'dwg_interior_model.v1', units: 'metres', axes: 'Y-up', coordinateStatus: 'relative_metric', georeferenced: false,
    sourceGeometryEvidence: 'Derived', verticalParametersEvidence: 'Hypothesis',
    openingGeometryEvidence: 'Derived', floorEnvelopeEvidence: 'Hypothesis',
    wallHeightM: height, wallThicknessM: thickness, floorSlabThicknessM: floorSlabThickness,
    doorHeightM: doorHeight, windowSillM: windowSill, windowHeadM: windowHead,
    floorCount: floors, storeyHeightM: storeyHeight,
    regionMode, regionRadiusM: radius, regionCenterSourceM: region.center?.map((value) => Number(value.toFixed(3))) || null,
    sourceSegmentCount: segments.length, classifiedSegmentCount: classified.length, deduplicatedSegmentCount: deduplicated.length,
    outputSegmentCount: limited.length, omittedOutsideRegion: region.omitted, omittedByLimit: Math.max(0, region.segments.length - limited.length),
    sourceOpeningCount: openings.length, selectedOpeningCount: selectedOpenings.length, openingCounts,
    wallOpeningCutCount: matchedOpeningKeys.size, wallPieceCount, floorSlabCount: floorHull.length >= 3 ? floors : 0,
    outputTriangles, selectedLayers: [...new Set([...limited.map((segment) => String(segment.layer)), ...selectedOpenings.map((opening) => opening.layer)])].sort(),
    categoryCounts: { ...sourceCategoryCounts, floor: floorHull.length >= 3 ? floors : 0, door: openingCounts.door, window: openingCounts.window },
    sourceOriginMetres: origin.map((value) => Number(value.toFixed(6))), bounds: normalizeBounds(bounds),
    dataGaps: [
      '门窗位置、方向和宽度来自 CAD 块参照；门高、窗台高和窗顶高仍需人工核验。',
      '楼板使用所选结构线的凸包范围，凹形边界、中庭和洞口需由建筑师复核。',
      '楼层数、层高、墙高、墙厚和楼板厚度属于人工确认前的 Hypothesis。',
      '与 SKP 或 OSM 同场叠加前仍需控制点或变换矩阵配准。'
    ]
  };
  return { glb: encodeMeshGlb(groups, metadata), metadata };
}

export async function convertDwgToExtrusion({ inputPath, outputPath, options = {}, onProgress = () => {} }) {
  const source = await fs.readFile(inputPath);
  const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  onProgress({ stage: 'dwg_extrusion_parse', current: 0, total: 1 });
  const document = DwgReader.readFromStream(arrayBuffer, () => {});
  const unitScale = DWG_UNIT_TO_METRES.get(Number(document.header?.insUnits));
  if (!unitScale) throw new Error('DWG_EXTRUSION_METRIC_UNITS_REQUIRED');
  const collected = collectDwgSegments(document, unitScale);
  const levels = collected.frames.length >= 2 ? organizeDwgInteriorLevels(collected) : [];
  const result = buildDwgExtrusionGlb({
    segments: collected.segments,
    openings: collected.openings,
    levels,
    ...options
  });
  result.metadata.sourcePlanFrameCount = collected.frames.length;
  result.metadata.sourceSurfaceCount = collected.surfaces.length;
  result.metadata.sourceFootprintCandidateCount = collected.footprints.length;
  result.metadata.sourceFurnishingCount = collected.furnishings.length;
  result.metadata.sourceSemanticObjectCount = collected.semanticObjects.length;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result.glb);
  onProgress({ stage: 'dwg_extrusion_export', current: 1, total: 1 });
  return { ...result.metadata, outputBytes: result.glb.byteLength };
}

export async function convertDwgToPlan({ inputPath, glbPath, geojsonPath, onProgress = () => {} }) {
  const source = await fs.readFile(inputPath);
  const arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const parserWarnings = [];
  onProgress({ stage: 'dwg_parse', current: 0, total: 1 });
  const document = DwgReader.readFromStream(arrayBuffer, (_sender, event) => {
    if (parserWarnings.length < 100) parserWarnings.push(String(event?.message || event));
  });
  const unitScale = DWG_UNIT_TO_METRES.get(Number(document.header?.insUnits)) || 1;
  const coordinateStatus = DWG_UNIT_TO_METRES.has(Number(document.header?.insUnits)) ? 'metric_source' : 'relative_unscaled';
  const collected = collectDwgSegments(document, unitScale);
  if (!collected.segments.length) throw new Error('DWG_NO_RENDERABLE_LINEWORK');
  const focus = chooseFocusedDwgSegments(collected.segments);
  const origin = focus.focusBounds?.center || [0, 0, 0];
  const layerGroups = new Map();
  for (const segment of focus.segments) {
    const coordinates = [segment.start, segment.end].map((point) => [
      Number((point[0] - origin[0]).toFixed(6)), Number((point[1] - origin[1]).toFixed(6)), Number((point[2] - origin[2]).toFixed(6))
    ]);
    if (!layerGroups.has(segment.layer)) layerGroups.set(segment.layer, []);
    layerGroups.get(segment.layer).push(coordinates);
  }
  const metadata = {
    sourceFormat: 'dwg', units: coordinateStatus === 'metric_source' ? 'metres' : 'source_units',
    coordinateStatus, metricAnalysisAllowed: coordinateStatus === 'metric_source', georeferenced: false,
    sourceEntityCount: Object.values(collected.entityCounts).reduce((sum, count) => sum + count, 0),
    sourceEntityCounts: collected.entityCounts, omittedEntityCounts: collected.omittedEntityCounts,
    sourceSegmentCount: collected.segments.length, outputSegmentCount: focus.segments.length,
    omittedOutlierSegments: focus.omitted, focusMode: focus.mode, sourceUnitsCode: Number(document.header?.insUnits ?? 0),
    sourceOriginMetres: origin.map((value) => Number(value.toFixed(6))),
    originalBounds: normalizeBounds(focus.originalBounds), bounds: normalizeBounds(focus.focusBounds),
    parserWarningCount: parserWarnings.length, parserWarnings: parserWarnings.slice(0, 20)
  };
  const geojson = {
    type: 'FeatureCollection',
    name: path.basename(inputPath, path.extname(inputPath)),
    properties: { schema: 'cad_plan_reference.v1', ...metadata },
    features: [...layerGroups.entries()].map(([layer, coordinates], index) => ({
      type: 'Feature', id: `dwg-layer-${String(index + 1).padStart(3, '0')}`,
      properties: {
        layer, type: 'cad_reference', label: layer, units: metadata.units,
        coordinate_space: 'local_model', evidence_level: 'Derived', segment_count: coordinates.length
      },
      geometry: { type: 'MultiLineString', coordinates }
    }))
  };
  const glb = encodeLineGlb(focus.segments, origin, metadata);
  await Promise.all([fs.mkdir(path.dirname(glbPath), { recursive: true }), fs.mkdir(path.dirname(geojsonPath), { recursive: true })]);
  await Promise.all([fs.writeFile(glbPath, glb), fs.writeFile(geojsonPath, JSON.stringify(geojson), 'utf8')]);
  onProgress({ stage: 'dwg_export', current: 1, total: 1 });
  return { ...metadata, glbBytes: glb.byteLength, geojsonFeatures: geojson.features.length };
}

