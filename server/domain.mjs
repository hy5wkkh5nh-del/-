export const ALLOWED_ACTIONS = new Set([
  'set_gate_mode', 'set_one_way', 'separate_time_window', 'reroute_flow',
  'move_dropoff_zone', 'move_loading_zone', 'widen_walkway', 'add_crossing',
  'add_barrier', 'add_wayfinding', 'add_lighting', 'set_signal_or_marshal'
]);

export const ACTION_PARAMETER_RULES = {
  set_gate_mode: { mode: ['inbound', 'outbound', 'mixed', 'service_only', 'visitor_only'] },
  set_one_way: { direction: ['inbound', 'outbound', 'clockwise', 'counterclockwise'] },
  separate_time_window: { slot: 'string', blocked_actor: ['person', 'bicycle', 'motorcycle', 'car', 'truck', 'bus', 'service_vehicle', 'all'] },
  reroute_flow: { route_id: 'string', direction: ['inbound', 'outbound', 'clockwise', 'counterclockwise'] },
  move_dropoff_zone: { zone_id: 'string', offset_m: { min: -50, max: 50 } },
  move_loading_zone: { zone_id: 'string', offset_m: { min: -50, max: 50 } },
  widen_walkway: { width_m: { min: 1, max: 12 } },
  add_crossing: { crossing_id: 'string', width_m: { min: 1, max: 20 } },
  add_barrier: { barrier_id: 'string', length_m: { min: 0.5, max: 200 } },
  add_wayfinding: { sign_id: 'string', count: { min: 1, max: 100 } },
  add_lighting: { light_id: 'string', illuminance_lux: { min: 1, max: 2000 } },
  set_signal_or_marshal: { mode: ['signal', 'marshal'], duration_min: { min: 1, max: 240 } }
};

function strictObject(properties, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function actionSchema(type, parameters) {
  return strictObject({
    type: { type: 'string', const: type },
    target_ids: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    parameters: strictObject(parameters),
    evidence_refs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }
  });
}

export function proposalDraftJsonSchema() {
  const actionSchemas = [
    actionSchema('set_gate_mode', { mode: { type: 'string', enum: ACTION_PARAMETER_RULES.set_gate_mode.mode } }),
    actionSchema('set_one_way', { direction: { type: 'string', enum: ACTION_PARAMETER_RULES.set_one_way.direction } }),
    actionSchema('separate_time_window', {
      slot: { type: 'string', minLength: 1 },
      blocked_actor: { type: 'string', enum: ACTION_PARAMETER_RULES.separate_time_window.blocked_actor }
    }),
    actionSchema('reroute_flow', {
      route_id: { type: 'string', minLength: 1 },
      direction: { type: 'string', enum: ACTION_PARAMETER_RULES.reroute_flow.direction }
    }),
    actionSchema('move_dropoff_zone', {
      zone_id: { type: 'string', minLength: 1 },
      offset_m: { type: 'number', ...ACTION_PARAMETER_RULES.move_dropoff_zone.offset_m }
    }),
    actionSchema('move_loading_zone', {
      zone_id: { type: 'string', minLength: 1 },
      offset_m: { type: 'number', ...ACTION_PARAMETER_RULES.move_loading_zone.offset_m }
    }),
    actionSchema('widen_walkway', { width_m: { type: 'number', ...ACTION_PARAMETER_RULES.widen_walkway.width_m } }),
    actionSchema('add_crossing', {
      crossing_id: { type: 'string', minLength: 1 },
      width_m: { type: 'number', ...ACTION_PARAMETER_RULES.add_crossing.width_m }
    }),
    actionSchema('add_barrier', {
      barrier_id: { type: 'string', minLength: 1 },
      length_m: { type: 'number', ...ACTION_PARAMETER_RULES.add_barrier.length_m }
    }),
    actionSchema('add_wayfinding', {
      sign_id: { type: 'string', minLength: 1 },
      count: { type: 'number', ...ACTION_PARAMETER_RULES.add_wayfinding.count }
    }),
    actionSchema('add_lighting', {
      light_id: { type: 'string', minLength: 1 },
      illuminance_lux: { type: 'number', ...ACTION_PARAMETER_RULES.add_lighting.illuminance_lux }
    }),
    actionSchema('set_signal_or_marshal', {
      mode: { type: 'string', enum: ACTION_PARAMETER_RULES.set_signal_or_marshal.mode },
      duration_min: { type: 'number', ...ACTION_PARAMETER_RULES.set_signal_or_marshal.duration_min }
    })
  ];
  const textArray = { type: 'array', items: { type: 'string' } };
  return strictObject({
    schema: { type: 'string', const: 'proposal_draft.v1' },
    diagnoses: {
      type: 'array',
      items: strictObject({
        conflict_id: { type: 'string', minLength: 1 },
        summary: { type: 'string', minLength: 1 },
        evidence_refs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        confidence: { type: 'number', minimum: 0, maximum: 1 }
      })
    },
    plans: {
      type: 'array', minItems: 3, maxItems: 3,
      items: strictObject({
        id: { type: 'string', enum: ['P-SAFE', 'P-EFFICIENCY', 'P-BALANCED'] },
        name: { type: 'string', enum: ['安全优先', '效率优先', '综合平衡'] },
        actions: { type: 'array', minItems: 1, items: { anyOf: actionSchemas } },
        assumptions: textArray,
        evidence_refs: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }
      })
    },
    data_gaps: textArray
  });
}

const PROPOSAL_KEYS = new Set(['schema', 'diagnoses', 'plans', 'data_gaps']);
const DIAGNOSIS_KEYS = new Set(['conflict_id', 'summary', 'evidence_refs', 'confidence']);
const PLAN_KEYS = new Set(['id', 'name', 'actions', 'assumptions', 'evidence_refs']);
const ACTION_KEYS = new Set(['type', 'target_ids', 'parameters', 'evidence_refs']);

function ensurePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value;
}

function ensureOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (/improvement|score|percentage|percent|reduction|increase|decrease_rate/i.test(key)) throw new Error('输出中包含由大模型生成的改善值或评分');
    throw new Error(`${label}包含未知字段：${key}`);
  }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? percentile(sorted, 0.5) : null;
}

function polygonContains(point, polygon) {
  if (!Array.isArray(point) || point.length < 2 || !Array.isArray(polygon) || polygon.length < 3) return false;
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] || [];
    const [xj, yj] = polygon[j] || [];
    const intersects = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function distance2d(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const dx = Number(a[0]) - Number(b[0]);
  const dy = Number(a[1]) - Number(b[1]);
  return Number.isFinite(dx) && Number.isFinite(dy) ? Math.hypot(dx, dy) : null;
}

function mapPixelToGround(point, calibration) {
  if (!calibration || calibration.mode !== 'homography' || !Array.isArray(calibration.matrix) || calibration.matrix.length !== 3) return null;
  const m = calibration.matrix;
  const x = Number(point?.[0]);
  const y = Number(point?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = m[2][0] * x + m[2][1] * y + m[2][2];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
  return [
    (m[0][0] * x + m[0][1] * y + m[0][2]) / w,
    (m[1][0] * x + m[1][1] * y + m[1][2]) / w
  ];
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row.map(Number), Number(vector[index])]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('控制点退化或共线，无法计算单应性');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = column; j <= n; j += 1) augmented[column][j] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let j = column; j <= n; j += 1) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row) => row[n]);
}

export function computeHomographyCalibration(controlPoints = []) {
  if (!Array.isArray(controlPoints) || controlPoints.length < 4) throw new Error('至少需要4个地面控制点');
  const rows = [];
  const values = [];
  for (const point of controlPoints) {
    const [x, y] = point.pixel || point.pixel_px || [];
    const [u, v] = point.ground || point.ground_xy_m || [];
    if (![x, y, u, v].every((item) => Number.isFinite(Number(item)))) throw new Error('控制点必须包含 pixel 与 ground 数值坐标');
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const rhs = Array(8).fill(0);
  for (let r = 0; r < rows.length; r += 1) {
    for (let i = 0; i < 8; i += 1) {
      rhs[i] += rows[r][i] * values[r];
      for (let j = 0; j < 8; j += 1) normal[i][j] += rows[r][i] * rows[r][j];
    }
  }
  const h = solveLinearSystem(normal, rhs);
  const matrix = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  const errors = controlPoints.map((point) => {
    const projected = mapPixelToGround(point.pixel || point.pixel_px, { mode: 'homography', matrix });
    return distance2d(projected, point.ground || point.ground_xy_m) || 0;
  });
  const rmse = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
  return {
    mode: 'homography', matrix, rmse_m: Number(rmse.toFixed(6)), controlPointCount: controlPoints.length,
    status: rmse <= 0.5 ? 'passed' : 'degraded', evidenceLevel: 'Derived', method: 'homography_dlt.v1'
  };
}

function inferDirection(first, last) {
  if (!first || !last) return 'unknown';
  const dx = Number(last[0]) - Number(first[0]);
  const dy = Number(last[1]) - Number(first[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-6) return 'stationary';
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'eastbound' : 'westbound';
  return dy > 0 ? 'southbound' : 'northbound';
}

function unique(values) { return [...new Set(values.filter(Boolean))]; }

function lineSide(point, a, b) {
  return (Number(b[0]) - Number(a[0])) * (Number(point[1]) - Number(a[1])) - (Number(b[1]) - Number(a[1])) * (Number(point[0]) - Number(a[0]));
}

/**
 * Convert frame-level YOLO/ByteTrack records into deterministic, auditable
 * metrics and conflict evidence. This function never estimates metric units
 * that are not supported by the supplied calibration.
 */
export function aggregateTrackRecords(records, config = {}) {
  if (!Array.isArray(records)) throw new Error('轨迹记录必须是数组');
  const windowId = String(config.windowId || 'window_unknown');
  const durationSeconds = Math.max(1, Number(config.durationSeconds || 600));
  const durationMinutes = durationSeconds / 60;
  const zones = Array.isArray(config.zones) ? config.zones : [];
  const calibration = config.calibration || { mode: 'none' };
  const thresholds = { pixelDistance: 30, simultaneousMs: 1000, ...(config.conflictThresholds || {}) };
  const countingLines = Array.isArray(config.countingLines) ? config.countingLines : [];
  const byTrack = new Map();
  const byFrame = new Map();
  const normalized = [];

  for (const raw of records) {
    const trackId = raw?.track_id ?? raw?.trackId;
    const actor = String(raw?.class || raw?.actor || 'unknown');
    const tMs = numberOrNull(raw?.t_ms ?? raw?.tMs);
    const footPx = Array.isArray(raw?.foot_px) ? raw.foot_px : (Array.isArray(raw?.footPx) ? raw.footPx : null);
    if (trackId == null || tMs == null || !footPx) continue;
    const ground = mapPixelToGround(footPx, calibration);
    const zoneIds = unique([
      ...(Array.isArray(raw?.zone_ids) ? raw.zone_ids : []),
      ...(Array.isArray(raw?.zoneIds) ? raw.zoneIds : []),
      ...zones.filter((zone) => polygonContains(footPx, zone.polygon_px || zone.polygonPx)).map((zone) => zone.id)
    ]);
    const item = {
      track_id: String(trackId), actor, t_ms: tMs,
      frame: numberOrNull(raw?.frame), confidence: numberOrNull(raw?.confidence),
      foot_px: [Number(footPx[0]), Number(footPx[1])], ground_xy_m: ground, zone_ids: zoneIds
    };
    normalized.push(item);
    const track = byTrack.get(item.track_id) || [];
    track.push(item);
    byTrack.set(item.track_id, track);
    const frame = byFrame.get(item.t_ms) || [];
    frame.push(item);
    byFrame.set(item.t_ms, frame);
  }

  const metrics = [];
  const tracks = [];
  for (const [trackId, values] of byTrack.entries()) {
    values.sort((a, b) => a.t_ms - b.t_ms);
    const first = values[0];
    const last = values.at(-1);
    const pixelDisplacement = distance2d(first.foot_px, last.foot_px) || 0;
    const elapsedSeconds = Math.max(0.001, (last.t_ms - first.t_ms) / 1000);
    const groundDisplacement = first.ground_xy_m && last.ground_xy_m ? distance2d(first.ground_xy_m, last.ground_xy_m) : null;
    const direction = inferDirection(first.foot_px, last.foot_px);
    const actor = first.actor;
    const zoneIds = unique(values.flatMap((value) => value.zone_ids));
    tracks.push({
      id: `track:${windowId}:${trackId}`, track_id: trackId, actor, direction,
      first_t_ms: first.t_ms, last_t_ms: last.t_ms, dwell_seconds: Number(elapsedSeconds.toFixed(3)),
      zone_ids: zoneIds, evidenceLevel: 'Observed'
    });
    metrics.push({
      id: `m-displacement-${windowId}-${trackId}`, kind: 'pixel_displacement_rate', actor,
      targetId: zoneIds[0] || 'site', value: Number((pixelDisplacement / elapsedSeconds).toFixed(3)),
      unit: 'px/s', sourceTrackIds: [`track:${windowId}:${trackId}`], evidenceLevel: 'Derived'
    });
    if (groundDisplacement != null && calibration.mode === 'homography') {
      metrics.push({
        id: `m-speed-${windowId}-${trackId}`, kind: 'ground_speed', actor,
        targetId: zoneIds[0] || 'site', value: Number((groundDisplacement / elapsedSeconds).toFixed(3)),
        unit: 'm/s', sourceTrackIds: [`track:${windowId}:${trackId}`], evidenceLevel: 'Derived'
      });
    }
  }

  const actorGroups = new Map();
  for (const track of tracks) {
    const key = `${track.actor}:${track.direction}:${track.zone_ids[0] || 'site'}`;
    const group = actorGroups.get(key) || { actor: track.actor, direction: track.direction, targetId: track.zone_ids[0] || 'site', count: 0, sourceTrackIds: [] };
    group.count += 1;
    group.sourceTrackIds.push(track.id);
    actorGroups.set(key, group);
  }
  for (const group of actorGroups.values()) {
    metrics.push({
      id: `m-flow-${windowId}-${metrics.length}`, kind: 'unique_track_flow_rate', actor: group.actor,
      targetId: group.targetId, value: Number((group.count / durationMinutes).toFixed(3)), unit: 'actors/min',
      normalizedPerMinute: true, sourceTrackIds: group.sourceTrackIds, evidenceLevel: 'Derived'
    });
    metrics.push({
      id: `m-direction-${windowId}-${metrics.length}`, kind: 'direction_flow_rate', actor: group.actor,
      direction: group.direction, targetId: group.targetId, value: Number((group.count / durationMinutes).toFixed(3)),
      unit: 'actors/min', normalizedPerMinute: true, sourceTrackIds: group.sourceTrackIds, evidenceLevel: 'Derived'
    });
  }

  const occupancyByZone = new Map();
  for (const value of normalized) {
    for (const zoneId of value.zone_ids) {
      const item = occupancyByZone.get(zoneId) || { frames: new Set(), tracks: new Set() };
      item.frames.add(value.t_ms);
      item.tracks.add(value.track_id);
      occupancyByZone.set(zoneId, item);
    }
  }
  const observedFrameCount = new Set(normalized.map((value) => value.t_ms)).size;
  for (const [zoneId, value] of occupancyByZone.entries()) {
    metrics.push({
      id: `m-occupancy-${windowId}-${zoneId}`, kind: 'zone_occupancy_rate', targetId: zoneId,
      value: Number((value.frames.size / Math.max(1, observedFrameCount)).toFixed(3)), unit: 'ratio',
      uniqueTracks: value.tracks.size, sourceTrackIds: [...value.tracks].map((id) => `track:${windowId}:${id}`), evidenceLevel: 'Derived'
    });
  }

  const frameZoneCounts = new Map();
  for (const [time, values] of byFrame.entries()) {
    for (const zone of zones) {
      const count = values.filter((value) => value.zone_ids.includes(zone.id)).length;
      const list = frameZoneCounts.get(zone.id) || [];
      list.push(count);
      frameZoneCounts.set(zone.id, list);
    }
  }
  for (const zone of zones.filter((item) => item.type === 'queue')) {
    const counts = (frameZoneCounts.get(zone.id) || []).sort((a, b) => a - b);
    metrics.push({
      id: `m-queue-${windowId}-${zone.id}`, kind: 'queue_length_p95_tracks', targetId: zone.id,
      value: Number((percentile(counts, .95) || 0).toFixed(3)), unit: 'tracks', evidenceLevel: 'Derived'
    });
  }

  for (const line of countingLines) {
    const a = line.a_px || line.aPx;
    const b = line.b_px || line.bPx;
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const crossings = [];
    for (const track of tracks) {
      const values = byTrack.get(track.track_id) || [];
      let crossed = false;
      let direction = 'unknown';
      for (let index = 1; index < values.length; index += 1) {
        const before = lineSide(values[index - 1].foot_px, a, b);
        const after = lineSide(values[index].foot_px, a, b);
        if ((before < 0 && after >= 0) || (before > 0 && after <= 0)) {
          crossed = true;
          direction = before < after ? 'a_to_b_positive' : 'b_to_a_negative';
          break;
        }
      }
      if (crossed) crossings.push({ trackId: track.id, actor: track.actor, direction });
    }
    for (const actor of unique(crossings.map((item) => item.actor))) {
      const actorCrossings = crossings.filter((item) => item.actor === actor);
      metrics.push({
        id: `m-line-${windowId}-${line.id}-${actor}`, kind: 'line_crossing_count', actor, targetId: line.id,
        value: actorCrossings.length, unit: 'tracks', sourceTrackIds: actorCrossings.map((item) => item.trackId), evidenceLevel: 'Derived'
      });
    }
  }

  const conflicts = [];
  const conflictSeen = new Set();
  const allValues = [...byFrame.values()].flat();
  for (let i = 0; i < allValues.length; i += 1) {
    const a = allValues[i];
    if (!['person', 'pedestrian'].includes(a.actor)) continue;
    for (let j = i + 1; j < allValues.length; j += 1) {
      const b = allValues[j];
      if (!['car', 'truck', 'bus', 'motorcycle'].includes(b.actor)) continue;
      if (Math.abs(a.t_ms - b.t_ms) > Number(thresholds.simultaneousMs)) continue;
      const commonZones = a.zone_ids.filter((zoneId) => b.zone_ids.includes(zoneId));
      const pixelDistance = distance2d(a.foot_px, b.foot_px);
      if (!commonZones.length && (pixelDistance == null || pixelDistance > Number(thresholds.pixelDistance))) continue;
      const zoneId = commonZones[0] || 'unassigned_conflict_area';
      const key = `${a.track_id}:${b.track_id}:${zoneId}`;
      if (conflictSeen.has(key)) continue;
      conflictSeen.add(key);
      const conflictId = `c-${windowId}-${conflicts.length + 1}`;
      const trackRefs = [`track:${windowId}:${a.track_id}`, `track:${windowId}:${b.track_id}`];
      const frameRefs = [`frame:${windowId}:${a.t_ms}`, `frame:${windowId}:${b.t_ms}`];
      conflicts.push({
        id: conflictId, type: 'pedestrian_vehicle_overlap', zoneId,
        timeMs: Math.min(a.t_ms, b.t_ms), severity: Number(Math.max(0.1, Math.min(1, 1 - ((pixelDistance || 0) / Number(thresholds.pixelDistance || 30)))).toFixed(3)),
        confidence: Number(Math.min(a.confidence || 0, b.confidence || 0).toFixed(3)),
        metricRefs: [], evidenceRefs: [...trackRefs, ...frameRefs], evidence_refs: [...trackRefs, ...frameRefs],
        algorithm: 'conflict_rules.v1', thresholds: { ...thresholds }, evidenceLevel: 'Derived'
      });
    }
  }

  const dataGaps = [];
  if (calibration.mode !== 'homography' || Number(calibration.rmse_m) > 0.5) {
    dataGaps.push('未完成满足阈值的地面标定；仅输出像素轨迹、方向、相对速度和区域计数。');
    dataGaps.push('PET/TTC 与米制距离、速度暂不可用。');
  }
  if (!zones.length) dataGaps.push('未配置道路、步行区或出入口 ROI；区域占用与空间对象映射有限。');
  if (!normalized.length) dataGaps.push('没有有效的 YOLO/ByteTrack 轨迹记录。');

  return {
    schema: 'observation_metrics.v1', windowId, durationSeconds,
    metrics, conflicts, tracks, dataGaps, recordCount: normalized.length,
    evidenceLevel: 'Derived', algorithm: 'observation_aggregation.v1'
  };
}

/** Build the canonical LLM-facing bundle from stored observation windows. */
export function buildObservationBundle({ projectId = null, sceneVersion = 'unversioned', slotId = null, windows = [], sceneObjects = [], allowedActions = [...ALLOWED_ACTIONS], calibration = { mode: 'none' }, constraints = [], objectiveWeights = undefined, transportPlan = null } = {}) {
  const matchingWindows = windows.filter((window) => !slotId || window.slotId === slotId);
  const fieldWindows = matchingWindows.filter((window) => window.sourceNature !== 'virtual_test');
  const eligibleWindows = fieldWindows.length ? fieldWindows : matchingWindows;
  const sourceNature = eligibleWindows.length && eligibleWindows.every((window) => window.sourceNature === 'virtual_test') ? 'virtual_test' : 'field_observation';
  const testOnly = sourceNature === 'virtual_test';
  const aggregated = aggregateWindows(eligibleWindows);
  const slotAggregate = aggregated.find((item) => item.slotId === slotId) || aggregated[0] || { sampleLevel: 'insufficient', metrics: [], sourceWindowIds: [] };
  const allConflicts = eligibleWindows.flatMap((window) => Array.isArray(window.conflicts) ? window.conflicts : []);
  const conflictWindows = eligibleWindows.filter((window) => {
    const hasDetectedConflict = Array.isArray(window.conflicts) && window.conflicts.length > 0;
    const hasConflictZone = Array.isArray(window.zones) && window.zones.some((zone) => Boolean(zone?.conflict_zone ?? zone?.conflictZone));
    const hasReliableMetricCalibration = window.calibration?.mode === 'homography'
      && Number(window.calibration.rmse_m) <= 0.5
      && window.calibration.status !== 'degraded';
    return hasDetectedConflict || hasConflictZone || hasReliableMetricCalibration;
  });
  const metrics = slotAggregate.metrics.map((metric, index) => ({ ...metric, id: metric.id || `m-aggregate-${slotId || 'site'}-${index}`, sourceWindowIds: metric.sourceWindowIds || slotAggregate.sourceWindowIds, sourceNature, testOnly }));
  const conflicts = allConflicts.length ? allConflicts.map((conflict) => ({ ...conflict, sourceNature, testOnly })) : [];
  if (conflicts.length) {
    const conflictRates = conflictWindows.map((window) => {
      const count = Array.isArray(window.conflicts) ? window.conflicts.length : 0;
      const durationMinutes = Math.max(1 / 60, Number(window.durationSeconds || 0) / 60);
      return count / durationMinutes;
    }).sort((a, b) => a - b);
    const sourceConflictIds = unique(conflicts.map((conflict) => conflict.id).filter(Boolean));
    metrics.push({
      id: `metric-aggregate-${slotId || 'site'}-conflict-event-rate`,
      kind: 'conflict_event_rate', actor: 'all', targetId: 'site',
      value: Number(percentile(conflictRates, .5).toFixed(3)),
      interval: [Number(percentile(conflictRates, .25).toFixed(3)), Number(percentile(conflictRates, .75).toFixed(3))],
      unit: 'events/min', normalizedPerMinute: true,
      evidence_refs: sourceConflictIds,
      sourceConflictIds,
      sourceWindowIds: unique(conflictWindows.map((window) => window.id).filter(Boolean)),
      sourceDurationSeconds: unique(conflictWindows.map((window) => Number(window.durationSeconds)).filter(Number.isFinite)).sort((a, b) => a - b),
      evidenceLevel: 'Derived', algorithm: 'conflict_metric_aggregation.v1', sourceNature, testOnly
    });
  }
  const dataGaps = [];
  if (slotAggregate.sampleLevel !== 'representative_baseline') dataGaps.push('当前时间段普通日样本不足3个，不能称为代表性基线。');
  if (calibration.mode !== 'homography' || Number(calibration.rmse_m) > 0.5) dataGaps.push('未达到米制标定门槛；PET/TTC、米制速度和距离不可用。');
  if (conflicts.length && conflictWindows.length < eligibleWindows.length) dataGaps.push('部分观测窗口未配置冲突区或可靠米制标定，未纳入冲突率分母。');
  for (const window of eligibleWindows) for (const gap of (window.dataGaps || window.data_gaps || [])) dataGaps.push(gap);
  if (testOnly) dataGaps.push('当前证据来自虚拟测试视频，只用于工作流验收，不得作为现场实测或实施依据。');
  const hasEditableLineGeometry = sceneObjects.some((object) => ['LineString', 'MultiLineString'].includes(object?.geometry?.type));
  const compatibleAllowedActions = [...new Set(allowedActions)]
    .filter((action) => ALLOWED_ACTIONS.has(action))
    .filter((action) => action !== 'reroute_flow' || hasEditableLineGeometry);
  if (!hasEditableLineGeometry && allowedActions.includes('reroute_flow')) dataGaps.push('当前语义场景没有连续线形对象，reroute_flow 已从动作白名单中移除。');
  return {
    schema: 'observation_bundle.v1', project_id: projectId, scene_version: sceneVersion,
    time_slot: slotId, sample_level: slotAggregate.sampleLevel,
    calibration, metrics, conflicts, scene_objects: sceneObjects,
    allowed_actions: compatibleAllowedActions,
    constraints, objective_weights: objectiveWeights || { safety: 0.35, operations: 0.25, visitor_experience: 0.15, public_space: 0.15, cost: 0.1 },
    source_window_ids: slotAggregate.sourceWindowIds, source_nature: sourceNature, test_only: testOnly,
    ...(transportPlan ? { transport_plan: transportPlan } : {}),
    data_gaps: unique(dataGaps), evidenceLevel: 'Derived'
  };
}

function solarPosition(date, hour, latitude, longitude) {
  const instant = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+08:00`);
  const dayStart = new Date(`${date}T00:00:00+08:00`);
  const dayOfYear = Math.floor((instant - new Date(`${instant.getFullYear()}-01-01T00:00:00+08:00`)) / 86400000) + 1;
  const gamma = 2 * Math.PI / 365 * (dayOfYear - 1 + (hour - 12) / 24);
  const equationOfTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const timezoneOffsetHours = -dayStart.getTimezoneOffset() / 60;
  const trueSolarMinutes = hour * 60 + equationOfTime + 4 * longitude - 60 * timezoneOffsetHours;
  const hourAngle = (trueSolarMinutes / 4 - 180) * Math.PI / 180;
  const lat = latitude * Math.PI / 180;
  const cosZenith = Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle);
  const altitude = 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) * 180 / Math.PI;
  const azimuth = Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(declination) * Math.cos(lat)) * 180 / Math.PI + 180;
  return { altitude_deg: Number(altitude.toFixed(2)), azimuth_deg: Number(((azimuth + 360) % 360).toFixed(2)) };
}

function weatherAtHour(weather, hour) {
  if (!weather?.hourly || typeof weather.hourly !== 'object') return weather;
  const times = Array.isArray(weather.hourly.time) ? weather.hourly.time : [];
  const index = times.findIndex((time) => {
    const match = String(time || '').match(/T(\d{2}):/);
    return match && Number(match[1]) === hour;
  });
  const point = {
    source: weather.source || 'unavailable',
    evidenceLevel: weather.evidenceLevel || 'Observed',
    time: index >= 0 ? times[index] : null
  };
  for (const [key, values] of Object.entries(weather.hourly)) {
    if (key === 'time' || !Array.isArray(values)) continue;
    point[key] = index >= 0 && index < values.length ? values[index] : null;
  }
  point.units = { ...(weather.hourly_units || {}) };
  return point;
}

/**
 * Produce a 24-hour presentation curve. Uploaded windows are immutable
 * Observed anchors; every interpolated hour is labelled Scenario and carries
 * widening uncertainty as it moves away from an anchor.
 */
export function buildHourlyScenario({ date, latitude, longitude, anchors = [], operationMultipliers = {}, weather = { source: 'unavailable' } } = {}) {
  if (!date || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) throw new Error('24小时情景需要日期和经纬度');
  const normalizedAnchors = anchors
    .map((anchor) => ({ ...anchor, hour: Number(anchor.hour), value: Number(anchor.value) }))
    .filter((anchor) => Number.isInteger(anchor.hour) && anchor.hour >= 0 && anchor.hour <= 23 && Number.isFinite(anchor.value));
  const byHour = new Map(normalizedAnchors.map((anchor) => [anchor.hour, anchor]));
  const globalMedian = median(normalizedAnchors.map((anchor) => anchor.value)) || 0;
  return Array.from({ length: 24 }, (_, hour) => {
    const anchor = byHour.get(hour);
    const sun = solarPosition(date, hour, Number(latitude), Number(longitude));
    const hourlyWeather = weatherAtHour(weather, hour);
    if (anchor) {
      const interval = Array.isArray(anchor.interval) && anchor.interval.length === 2 ? anchor.interval.map(Number) : [anchor.value, anchor.value];
      return {
        hour, value: anchor.value, interval, evidenceLevel: anchor.evidenceLevel || 'Observed',
        sourceNature: anchor.sourceNature || 'field_observation', testOnly: anchor.sourceNature === 'virtual_test',
        sourceMetricId: anchor.metricId || null, sourceMetricIds: anchor.sourceMetricIds || [],
        sourceWindowIds: anchor.sourceWindowIds || [], observedDates: anchor.observedDates || [],
        multiplier: 1, weather: hourlyWeather, sun
      };
    }
    const nearest = normalizedAnchors
      .map((item) => ({ item, distance: Math.abs(item.hour - hour) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const multiplier = Number(operationMultipliers[hour] ?? 1);
    const base = nearest?.item?.value ?? globalMedian;
    const value = Number((base * (Number.isFinite(multiplier) ? multiplier : 1)).toFixed(3));
    const distance = nearest?.distance ?? 12;
    const anchorIntervalWidth = nearest?.item?.interval?.length === 2 ? Math.abs(Number(nearest.item.interval[1]) - Number(nearest.item.interval[0])) : Math.abs(base) * 0.15;
    const uncertainty = Math.max(
      anchorIntervalWidth / 2,
      Math.abs(value) * 0.12 + Math.abs(base) * 0.04 * distance
    );
    return {
      hour, value, interval: [Number(Math.max(0, value - uncertainty).toFixed(3)), Number((value + uncertainty).toFixed(3))],
      evidenceLevel: 'Scenario', anchorHour: nearest?.item?.hour ?? null, distanceFromAnchorHours: distance,
      sourceNature: nearest?.item?.sourceNature || 'field_observation', testOnly: nearest?.item?.sourceNature === 'virtual_test',
      multiplier: Number.isFinite(multiplier) ? multiplier : 1, weather: hourlyWeather, sun
    };
  });
}

export function representativeLevel(normalDates) {
  if (normalDates >= 3) return 'representative_baseline';
  if (normalDates === 2) return 'preliminary_baseline';
  if (normalDates === 1) return 'single_observation';
  return 'insufficient';
}

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}

export function aggregateWindows(windows) {
  const groups = new Map();
  for (const window of windows) {
    if (window.dayType !== 'normal_weekday' || !Array.isArray(window.metrics)) continue;
    const group = groups.get(window.slotId) || { dates: new Set(), metrics: new Map(), sourceWindowIds: [] };
    if (window.capturedAt) group.dates.add(String(window.capturedAt).slice(0, 10));
    group.sourceWindowIds.push(window.id);
    for (const metric of window.metrics) {
      const key = `${metric.kind}:${metric.actor || 'all'}:${metric.targetId || 'site'}:${metric.unit || 'count/min'}`;
      const alreadyPerMinute = metric.normalizedPerMinute || /\/min$/i.test(String(metric.unit || ''));
      const countMetric = /(?:^|_)count$/i.test(String(metric.kind || ''));
      const normalizePerMinute = Boolean(alreadyPerMinute || countMetric);
      const values = group.metrics.get(key) || {
        metric: { ...metric, normalizedPerMinute: normalizePerMinute }, values: [],
        sourceMetricIds: [], sourceWindowIds: [], sourceDurationSeconds: [], evidenceRefs: []
      };
      const rawValue = Number(metric.value);
      const aggregatedValue = normalizePerMinute && !alreadyPerMinute
        ? rawValue / Math.max(1, window.durationSeconds / 60)
        : rawValue;
      if (Number.isFinite(aggregatedValue)) values.values.push(aggregatedValue);
      if (metric.id) values.sourceMetricIds.push(metric.id);
      values.sourceWindowIds.push(window.id);
      if (Number.isFinite(Number(window.durationSeconds))) values.sourceDurationSeconds.push(Number(window.durationSeconds));
      values.evidenceRefs.push(...(metric.evidence_refs || metric.evidenceRefs || []));
      group.metrics.set(key, values);
    }
    groups.set(window.slotId, group);
  }

  return [...groups.entries()].map(([slotId, group]) => ({
    slotId,
    sampleLevel: representativeLevel(group.dates.size),
    normalDateCount: group.dates.size,
    sourceWindowIds: group.sourceWindowIds,
    metrics: [...group.metrics.values()].map(({ values, metric, sourceMetricIds, sourceWindowIds, sourceDurationSeconds, evidenceRefs }, index) => {
      const sorted = values.sort((a, b) => a - b);
      const {
        id: _sourceMetricId, duration_seconds: _durationSeconds, durationSeconds: _durationSecondsCamel,
        source_record_count: _sourceRecordCount, matching_record_count: _matchingRecordCount,
        evidence_refs: _evidenceRefs, evidenceRefs: _evidenceRefsCamel, ...aggregateMetric
      } = metric;
      return {
        ...aggregateMetric,
        id: `metric-aggregate-${slotId || 'site'}-${index + 1}`,
        value: Number(percentile(sorted, .5).toFixed(3)),
        interval: [Number(percentile(sorted, .25).toFixed(3)), Number(percentile(sorted, .75).toFixed(3))],
        unit: metric.normalizedPerMinute && !/\/min$/i.test(String(metric.unit || '')) ? `${metric.unit || 'count'}/min` : metric.unit,
        evidence_refs: unique(evidenceRefs),
        sourceMetricIds: unique(sourceMetricIds),
        sourceWindowIds: unique(sourceWindowIds),
        sourceDurationSeconds: unique(sourceDurationSeconds).sort((a, b) => a - b),
        evidenceLevel: 'Derived'
      };
    })
  }));
}

/** Build 24-hour observation anchors only from persisted analyzed windows. */
export function buildScenarioAnchors(windows, { metricKind = 'unique_track_flow_rate', actor = null, targetId = null, dayType = 'normal_weekday' } = {}) {
  const byHour = new Map();
  for (const window of Array.isArray(windows) ? windows : []) {
    if (dayType && window.dayType !== dayType) continue;
    const hourMatch = String(window.capturedAt || '').match(/T(\d{2}):/);
    if (!hourMatch || !Array.isArray(window.metrics)) continue;
    const hour = Number(hourMatch[1]);
    const selected = window.metrics.filter((metric) => {
      if (metric.kind !== metricKind) return false;
      if (actor && metric.actor !== actor) return false;
      if (targetId && (metric.targetId || 'site') !== targetId) return false;
      return Number.isFinite(Number(metric.value));
    });
    if (!selected.length) continue;
    const value = selected.reduce((sum, metric) => {
      const raw = Number(metric.value);
      const alreadyPerMinute = metric.normalizedPerMinute || /\/min$/i.test(String(metric.unit || ''));
      return sum + (alreadyPerMinute ? raw : raw / Math.max(1, Number(window.durationSeconds || 600) / 60));
    }, 0);
    const samples = byHour.get(hour) || [];
    samples.push({
      value,
      windowId: window.id,
      date: String(window.capturedAt).slice(0, 10),
      metricIds: selected.map((metric) => metric.id).filter(Boolean),
      sourceNature: window.sourceNature || 'field_observation'
    });
    byHour.set(hour, samples);
  }
  return [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, samples]) => {
    const values = samples.map((sample) => sample.value).sort((a, b) => a - b);
    return {
      hour,
      value: Number(percentile(values, .5).toFixed(3)),
      interval: [Number(percentile(values, .25).toFixed(3)), Number(percentile(values, .75).toFixed(3))],
      metricId: metricKind,
      sourceMetricIds: unique(samples.flatMap((sample) => sample.metricIds)),
      sourceWindowIds: unique(samples.map((sample) => sample.windowId)),
      observedDates: unique(samples.map((sample) => sample.date)),
      sourceNature: samples.every((sample) => sample.sourceNature === 'virtual_test') ? 'virtual_test' : 'field_observation',
      evidenceLevel: samples.every((sample) => sample.sourceNature === 'virtual_test') ? 'Scenario' : 'Observed'
    };
  });
}

export function validateProposalDraft(draft, context) {
  ensurePlainObject(draft, 'proposal');
  ensureOnlyKeys(draft, PROPOSAL_KEYS, 'proposal');
  if (draft.schema !== 'proposal_draft.v1') throw new Error('LLM 返回 schema 不匹配');
  if (!Array.isArray(draft.diagnoses) || !Array.isArray(draft.plans)) throw new Error('LLM 返回缺少 diagnoses 或 plans');
  if (draft.plans.length !== 3) throw new Error('必须返回三套方案');
  const requiredPlanIds = ['P-SAFE', 'P-EFFICIENCY', 'P-BALANCED'];
  const planIds = draft.plans.map((plan) => plan?.id);
  if (new Set(planIds).size !== 3 || requiredPlanIds.some((planId) => !planIds.includes(planId))) throw new Error('三套方案 ID 必须分别为 P-SAFE、P-EFFICIENCY 和 P-BALANCED');
  const objectIds = new Set((context.scene_objects || context.sceneObjects || []).map((object) => object.id).filter(Boolean));
  const conflictIds = new Set((context.conflicts || []).map((conflict) => conflict.id).filter(Boolean));
  const conflictsById = new Map((context.conflicts || []).map((conflict) => [conflict.id, conflict]));
  const metricIds = new Set((context.metrics || []).map((metric) => metric.id).filter(Boolean));
  const evidenceIds = new Set([...conflictIds, ...metricIds]);
  for (const conflict of context.conflicts || []) for (const ref of conflict.evidence_refs || conflict.evidenceRefs || []) evidenceIds.add(ref);
  for (const metric of context.metrics || []) for (const ref of metric.sourceTrackIds || metric.source_track_ids || metric.sourceWindowIds || metric.source_window_ids || []) evidenceIds.add(ref);
  for (const diagnosis of draft.diagnoses) {
    ensurePlainObject(diagnosis, 'diagnosis');
    ensureOnlyKeys(diagnosis, DIAGNOSIS_KEYS, 'diagnosis');
    if (!conflictIds.has(diagnosis.conflict_id)) throw new Error(`诊断引用未知冲突 ${diagnosis.conflict_id}`);
    if (!Array.isArray(diagnosis.evidence_refs) || diagnosis.evidence_refs.length === 0) throw new Error('诊断缺少证据引用');
    const unknownDiagnosisEvidence = diagnosis.evidence_refs.filter((ref) => !evidenceIds.has(ref));
    if (unknownDiagnosisEvidence.length) throw new Error(`诊断包含未知证据：${unknownDiagnosisEvidence.join(', ')}`);
  }
  for (const plan of draft.plans) {
    ensurePlainObject(plan, 'plan');
    ensureOnlyKeys(plan, PLAN_KEYS, 'plan');
    if (!String(plan.id || '').trim() || !String(plan.name || '').trim()) throw new Error('方案缺少 id 或 name');
    if (!Array.isArray(plan.actions) || plan.actions.length === 0) throw new Error('每套方案必须包含至少一个白名单动作');
    if (!Array.isArray(plan.evidence_refs) || plan.evidence_refs.length === 0) throw new Error('方案缺少证据引用');
    const unknownPlanEvidence = plan.evidence_refs.filter((ref) => !evidenceIds.has(ref));
    if (unknownPlanEvidence.length) throw new Error(`方案包含未知证据：${unknownPlanEvidence.join(', ')}`);
    if (plan.assumptions != null && !Array.isArray(plan.assumptions)) throw new Error('方案 assumptions 必须是数组');
    for (const action of plan.actions) {
      ensurePlainObject(action, 'action');
      ensureOnlyKeys(action, ACTION_KEYS, 'action');
      if (!ALLOWED_ACTIONS.has(action.type)) throw new Error(`动作不在白名单：${action.type}`);
      if (!Array.isArray(action.target_ids) || action.target_ids.length === 0 || action.target_ids.some((target) => !objectIds.has(target))) throw new Error('动作引用未知三维对象');
      if (!Array.isArray(action.evidence_refs) || action.evidence_refs.length === 0) throw new Error('动作缺少证据引用');
      const unknownActionEvidence = action.evidence_refs.filter((ref) => !evidenceIds.has(ref));
      if (unknownActionEvidence.length) throw new Error(`动作包含未知证据：${unknownActionEvidence.join(', ')}`);
      validateActionParameters(action.type, action.parameters || {});
      if (action.type === 'separate_time_window' && action.parameters?.blocked_actor !== 'all') {
        const referencedActors = new Set(action.evidence_refs.flatMap((ref) => conflictsById.get(ref)?.actors || []));
        if (referencedActors.size && !referencedActors.has(action.parameters.blocked_actor)) {
          throw new Error(`separate_time_window 的 blocked_actor ${action.parameters.blocked_actor} 不是引用冲突参与者`);
        }
      }
    }
  }
  rejectModelAuthoredNumbers(draft);
  return draft;
}

export function validateProposalGeometry(draft, sceneObjects = []) {
  const objectMap = new Map(sceneObjects.map((object) => [object.id, object]));
  const violations = [];
  for (const plan of draft?.plans || []) {
    for (const action of plan.actions || []) {
      for (const targetId of action.target_ids || []) {
        const target = objectMap.get(targetId);
        if (!target) violations.push(`${plan.id || 'plan'}:${action.type} 引用不存在的对象 ${targetId}`);
        else if (!target.geometry || typeof target.geometry !== 'object') violations.push(`${plan.id || 'plan'}:${action.type} 的目标 ${targetId} 缺少 geometry`);
      }
      if (action.type === 'reroute_flow') {
        for (const targetId of action.target_ids || []) {
          const geometryType = objectMap.get(targetId)?.geometry?.type;
          if (geometryType && !['LineString', 'MultiLineString'].includes(geometryType)) violations.push(`${plan.id || 'plan'}:reroute_flow 需要连续线形 geometry`);
        }
      }
    }
  }
  return { status: violations.length ? 'blocked' : 'passed', violations, method: 'geometry_gate.v1' };
}

function validateActionParameters(type, parameters) {
  ensurePlainObject(parameters, '动作 parameters');
  const rules = ACTION_PARAMETER_RULES[type] || {};
  for (const key of Object.keys(parameters)) if (!(key in rules)) throw new Error(`动作参数包含未知字段：${key}`);
  for (const [key, value] of Object.entries(parameters)) {
    const rule = rules[key];
    if (rule === 'string' && typeof value !== 'string') throw new Error(`动作参数 ${key} 必须是字符串`);
    if (Array.isArray(rule) && !rule.includes(value)) throw new Error(`动作参数 ${key} 不在允许范围`);
    if (rule && typeof rule === 'object' && 'min' in rule) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || numeric < rule.min || numeric > rule.max) throw new Error(`动作参数 ${key} 参数越界`);
    }
  }
}

function rejectModelAuthoredNumbers(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/improvement|score|percentage|percent|reduction|increase|decrease_rate/i.test(key)) throw new Error('输出中包含由大模型生成的改善值或评分');
    rejectModelAuthoredNumbers(child, `${path}.${key}`);
  }
}

export function computeScenario(metrics, actions) {
  const factors = actions.reduce((acc, action) => {
    if (['add_barrier', 'add_crossing', 'separate_time_window', 'set_one_way', 'set_signal_or_marshal'].includes(action.type)) acc.conflict *= 0.78;
    if (['reroute_flow', 'move_dropoff_zone', 'move_loading_zone'].includes(action.type)) acc.queue *= 0.82;
    if (action.type === 'widen_walkway') acc.capacity *= 1.15;
    if (['add_lighting', 'add_wayfinding'].includes(action.type)) acc.experience *= 1.08;
    return acc;
  }, { conflict: 1, queue: 1, capacity: 1, experience: 1 });
  return metrics.map((metric) => {
    const value = Number(metric.value);
    let after = value;
    if (/conflict|overlap|pet|ttc/i.test(metric.kind || '')) after = value * factors.conflict;
    else if (/queue|delay/i.test(metric.kind || '')) after = value * factors.queue;
    else if (/capacity/i.test(metric.kind || '')) after = value * factors.capacity;
    else if (/experience|lighting/i.test(metric.kind || '')) after = value * factors.experience;
    return { metricId: metric.id, kind: metric.kind, unit: metric.unit, before: value, after: Number(after.toFixed(3)), method: 'scenario_engine.v1', evidenceLevel: 'Scenario' };
  });
}

export function hasDeterministicKpiChange(kpis) {
  return Array.isArray(kpis) && kpis.some((kpi) => {
    const before = Number(kpi?.before);
    const after = Number(kpi?.after);
    return Number.isFinite(before) && Number.isFinite(after) && before !== after;
  });
}

