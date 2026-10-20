const EARTH_RADIUS_M = 6_378_137;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function localEnu(latitude, longitude, origin) {
  const lat0 = finiteNumber(origin?.latitude);
  const lon0 = finiteNumber(origin?.longitude);
  const lat = finiteNumber(latitude);
  const lon = finiteNumber(longitude);
  const cosLat = Math.cos((lat0 * Math.PI) / 180) || 1;
  return [
    Number((((lon - lon0) * Math.PI / 180) * EARTH_RADIUS_M * cosLat).toFixed(2)),
    Number((((lat - lat0) * Math.PI / 180) * EARTH_RADIUS_M).toFixed(2))
  ];
}

function lengthOfLine(coordinates = []) {
  return coordinates.slice(1).reduce((sum, point, index) => {
    const previous = coordinates[index];
    return sum + Math.hypot(Number(point[0]) - Number(previous[0]), Number(point[1]) - Number(previous[1]));
  }, 0);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

const STATION_EVIDENCE = {
  userMap: 'codex-clipboard-b8728a11-b398-4e62-ad10-029b42be04ee.png',
  stationName: '同济大学站',
  line: '上海地铁10号线',
  locationPolicy: '红色矩形只作为出口标注；站体不按外观还原，先保留 Point 标记与接驳路网。'
};

const RAW_STATION_ENTRIES = [
  {
    id: 'metro-tongji-exit-2',
    label: '同济大学站 · 2号口',
    exitNumber: '2',
    latitude: 31.284006,
    longitude: 121.502442,
    source: 'Wikimedia Commons · Exit 2 of Tongji University Station in Shanghai 2025',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Exit_2_of_Tongji_University_Station_in_Shanghai_2025.jpg',
    mapMarker: { x: 72, y: 85 }
  },
  {
    id: 'metro-tongji-exit-4',
    label: '同济大学站 · 4号口',
    exitNumber: '4',
    latitude: 31.282372,
    longitude: 121.501128,
    source: 'Wikimedia Commons · Exit 4 of Tongji University Station in Shanghai 2025',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Exit_4_of_Tongji_University_Station_in_Shanghai_2025.jpg',
    mapMarker: { x: 59, y: 538 }
  }
];

const ROAD_TEMPLATES = [
  {
    id: 'metro-2-to-building-north',
    label: '2号口—主楼北侧到达线',
    type: 'pedestrian_connector',
    capacityPerHour: 720,
    complexity: '中',
    coordinates: (stations) => [stations[0].modelLocal || stations[0].local, [155, 120], [96, 88], [42, 58], [0, 46]]
  },
  {
    id: 'metro-4-to-building-west',
    label: '4号口—西门步行接驳线',
    type: 'pedestrian_connector',
    capacityPerHour: 600,
    complexity: '高',
    coordinates: (stations) => [stations[1].modelLocal || stations[1].local, [82, 62], [44, 34], [0, 15]]
  },
  {
    id: 'north-east-shared-road',
    label: '北侧—东侧共享路',
    type: 'shared_street',
    capacityPerHour: 520,
    complexity: '高',
    coordinates: () => [[0, 46], [42, 58], [96, 88], [128, 42], [104, 0]]
  },
  {
    id: 'west-gate-walkway',
    label: '西门—主楼人行小道',
    type: 'walkway',
    capacityPerHour: 420,
    complexity: '中',
    coordinates: () => [[0, 15], [-36, 12], [-76, 10], [-106, 4], [-128, -14]]
  },
  {
    id: 'south-service-lane',
    label: '南侧后勤/非机动车混行线',
    type: 'mixed_service_lane',
    capacityPerHour: 360,
    complexity: '高',
    coordinates: () => [[-128, -14], [-84, -34], [-28, -48], [22, -54], [80, -40], [104, 0]]
  }
];

const OPERATOR_MAP_MEASUREMENTS = {
  'metro-tongji-exit-2': {
    distanceM: 164,
    distanceType: 'operator_map_measurement',
    stationBinding: 'operator_cross_checked_with_exit_4_page',
    source: 'map-measurement-exit2-164m.png',
    // Same-handed map-to-scene derivation around the registered building anchor.
    modelLocal: [-118.2746, -149.1426],
    markerLocalXZ: [-118.2746, -149.1426]
  },
  'metro-tongji-exit-4': {
    distanceM: 147,
    distanceType: 'operator_map_measurement',
    stationBinding: 'operator_latest_map_measurement_supersedes_place_page_estimate',
    source: 'map-measurement-exit4-147m.png',
    priorSource: 'amap-place-page-verified.png',
    priorDistanceM: 60,
    // Same-handed map-to-scene derivation around the registered building anchor.
    modelLocal: [-103.2950, 58.7299],
    markerLocalXZ: [-103.2950, 58.7299]
  }
};

const PHOTO_ORIGIN_BINDINGS = {
  'metro-tongji-exit-2': {
    photoId: 'P001',
    photoFile: 'origin-P001-main-entry.jpg',
    description: '照片P001可识别的主楼车行/人行入口区域；三维锚点使用已登记入口组 CURRENTGATE/ENTRYFIX 基准点。',
    modelAnchor: { id: 'main-entry-photo-anchor', local: [63.15, 0, -78.70], source: 'docs/evidence/image-to-scene-entry-run-20261012-v1/analysis.json' }
  },
  'metro-tongji-exit-4': {
    photoId: 'P024',
    photoFile: 'origin-P024-main-entry.jpg',
    description: '照片P024可识别的主楼车行/人行入口区域；三维锚点使用已登记入口组 CURRENTGATE/ENTRYFIX 基准点。',
    modelAnchor: { id: 'main-entry-photo-anchor', local: [63.15, 0, -78.70], source: 'docs/evidence/image-to-scene-entry-run-20261012-v1/analysis.json' }
  }
};

const SCENARIOS = [
  // Vehicle presence is visible in some field photos, but no source provides
  // an hourly count. scenarioPressureInput is therefore a Scenario-only
  // stress input for conflict grading; it must never be reported as cars/hour.
  {
    id: 'weekday-0830',
    label: '工作日早高峰 08:30–09:30',
    timeWindow: '08:30–09:30',
    note: '按用户要求模拟上班最高峰，站口到建筑的步行、自行车和电动车压力；现场没有按小时机动车计数，车辆数不作为实测值展示。',
    vehicleFlowStatus: 'unmeasured',
    roadFlow: {
      'metro-2-to-building-north': { pedestrians: 286, bicycles: 38, eBikes: 26, parkedBikes: 22, parkedEBikes: 18, scenarioPressureInput: 30 },
      'metro-4-to-building-west': { pedestrians: 214, bicycles: 25, eBikes: 34, parkedBikes: 16, parkedEBikes: 21, scenarioPressureInput: 22 },
      'north-east-shared-road': { pedestrians: 170, bicycles: 29, eBikes: 31, parkedBikes: 12, parkedEBikes: 14, scenarioPressureInput: 124 },
      'west-gate-walkway': { pedestrians: 132, bicycles: 18, eBikes: 21, parkedBikes: 20, parkedEBikes: 17, scenarioPressureInput: 39 },
      'south-service-lane': { pedestrians: 86, bicycles: 12, eBikes: 18, parkedBikes: 11, parkedEBikes: 15, scenarioPressureInput: 70 }
    }
  },
  {
    id: 'weekday-1730',
    label: '工作日下班高峰 17:30–18:30',
    timeWindow: '17:30–18:30',
    note: '下班离场方向反转，步行与非机动车压力叠加；现场没有按小时机动车计数，车辆数不作为实测值展示。',
    vehicleFlowStatus: 'unmeasured',
    roadFlow: {
      'metro-2-to-building-north': { pedestrians: 248, bicycles: 31, eBikes: 21, parkedBikes: 28, parkedEBikes: 24, scenarioPressureInput: 52 },
      'metro-4-to-building-west': { pedestrians: 190, bicycles: 24, eBikes: 28, parkedBikes: 20, parkedEBikes: 22, scenarioPressureInput: 42 },
      'north-east-shared-road': { pedestrians: 154, bicycles: 35, eBikes: 42, parkedBikes: 14, parkedEBikes: 18, scenarioPressureInput: 158 },
      'west-gate-walkway': { pedestrians: 118, bicycles: 22, eBikes: 26, parkedBikes: 23, parkedEBikes: 20, scenarioPressureInput: 50 },
      'south-service-lane': { pedestrians: 72, bicycles: 16, eBikes: 20, parkedBikes: 13, parkedEBikes: 18, scenarioPressureInput: 90 }
    }
  },
  {
    id: 'weekday-1230',
    label: '工作日午间 12:30–13:30',
    timeWindow: '12:30–13:30',
    note: '午间访客和后勤活动为主，整体压力低于上下班高峰；现场没有按小时机动车计数，车辆数不作为实测值展示。',
    vehicleFlowStatus: 'unmeasured',
    roadFlow: {
      'metro-2-to-building-north': { pedestrians: 112, bicycles: 17, eBikes: 12, parkedBikes: 15, parkedEBikes: 10, scenarioPressureInput: 33 },
      'metro-4-to-building-west': { pedestrians: 96, bicycles: 12, eBikes: 10, parkedBikes: 12, parkedEBikes: 9, scenarioPressureInput: 25 },
      'north-east-shared-road': { pedestrians: 82, bicycles: 18, eBikes: 16, parkedBikes: 8, parkedEBikes: 9, scenarioPressureInput: 82 },
      'west-gate-walkway': { pedestrians: 54, bicycles: 9, eBikes: 8, parkedBikes: 10, parkedEBikes: 8, scenarioPressureInput: 26 },
      'south-service-lane': { pedestrians: 48, bicycles: 8, eBikes: 10, parkedBikes: 7, parkedEBikes: 9, scenarioPressureInput: 48 }
    }
  }
];

const DESIGN_STANDARDS = [
  { id: 'clear-walkway', label: '连续人行净宽 ≥ 3.0m', target: 'separate_pedestrian_flow', threshold: 3, unit: 'm' },
  { id: 'crossing-visibility', label: '交叉口视距与过街优先', target: 'reduce_mixed_conflict', threshold: 0.7, unit: 'risk_index' },
  { id: 'parking-setback', label: '自行车/电动车停放距路口 ≥ 5m', target: 'keep_intersection_clear', threshold: 5, unit: 'm' },
  { id: 'peak-saturation', label: '高峰路段饱和度控制在 0.85 以下', target: 'limit_peak_pressure', threshold: 0.85, unit: 'ratio' }
];

export function buildTransportPlan(project = {}) {
  const origin = { latitude: finiteNumber(project.latitude, 31.2805), longitude: finiteNumber(project.longitude, 121.5007) };
  const stations = RAW_STATION_ENTRIES.map((entry) => ({
    ...entry,
    kind: 'metro_entrance',
    stationName: STATION_EVIDENCE.stationName,
    line: STATION_EVIDENCE.line,
    evidenceLevel: 'Derived',
    locationConfidence: 'approximate',
    local: localEnu(entry.latitude, entry.longitude, origin),
    geometry: { type: 'Point', coordinates: localEnu(entry.latitude, entry.longitude, origin) }
  }));
  // The public map coordinates are kept as evidence, while the 3D anchor uses
  // the operator-checked walking distance so the model does not inherit the
  // earlier rough coordinate estimate.
  stations.forEach((station) => {
    const measuredDistance = OPERATOR_MAP_MEASUREMENTS[station.id]?.distanceM;
    const coordinateDistance = Math.hypot(...station.local);
    const scale = measuredDistance && coordinateDistance ? measuredDistance / coordinateDistance : 1;
    const sourceModelLocal = OPERATOR_MAP_MEASUREMENTS[station.id]?.modelLocal
      || station.local.map((value) => Number((value * scale).toFixed(2)));
    // sourceModelLocal is already the anchor-relative, same-handed scene
    // coordinate produced by the corrected derivation chain.
    station.modelLocal = [Number(sourceModelLocal[0].toFixed(4)), Number(sourceModelLocal[1].toFixed(4))];
    station.markerLocalXZ = OPERATOR_MAP_MEASUREMENTS[station.id]?.markerLocalXZ || [station.modelLocal[0], -station.modelLocal[1]];
    station.distanceToBuildingM = measuredDistance ?? null;
    station.modelGeometry = { type: 'Point', coordinates: station.modelLocal };
  });
  const roads = ROAD_TEMPLATES.map((template) => {
    const coordinates = template.coordinates(stations);
    return {
      id: template.id,
      sceneObjectId: `transport-${template.id}`,
      label: template.label,
      type: template.type,
      complexity: template.complexity,
      capacityPerHour: template.capacityPerHour,
      lengthM: Number(lengthOfLine(coordinates).toFixed(1)),
      geometry: { type: 'LineString', coordinates },
      evidenceLevel: 'Scenario',
      source: 'user_defined_simulation_from_navigation_and_map_markup'
    };
  });
  const stationDistances = stations.map((station) => ({
    stationId: station.id,
    coordinateEstimateM: Number(Math.hypot(...station.local).toFixed(1)),
    distanceToBuildingM: OPERATOR_MAP_MEASUREMENTS[station.id]?.distanceM ?? null,
    distanceType: OPERATOR_MAP_MEASUREMENTS[station.id]?.distanceType || null,
    stationBinding: OPERATOR_MAP_MEASUREMENTS[station.id]?.stationBinding || 'pending_operator_map_measurement',
    source: OPERATOR_MAP_MEASUREMENTS[station.id]?.source || null,
    originDescription: PHOTO_ORIGIN_BINDINGS[station.id]?.description || null,
    evidencePhotoId: PHOTO_ORIGIN_BINDINGS[station.id]?.photoId || null,
    evidencePhotoFile: PHOTO_ORIGIN_BINDINGS[station.id]?.photoFile || null,
    originModelAnchor: PHOTO_ORIGIN_BINDINGS[station.id]?.modelAnchor || null,
    relationToScope: OPERATOR_MAP_MEASUREMENTS[station.id]?.distanceM <= 150 ? 'inside_150m_scope' : 'connector_beyond_150m_scope',
    distanceStatus: OPERATOR_MAP_MEASUREMENTS[station.id] ? 'operator_map_measurement_supersedes_coordinate_estimate' : 'pending_operator_map_measurement'
  }));
  return {
    schema: 'transport_access_plan.v1',
    planId: 'transport-access-phase2-v1',
    projectId: project.id || null,
    origin,
    scope: {
      baselineRadiusM: 50,
      targetRadiusM: 150,
      extensionFromBaselineM: 100,
      stationConnectorPolicy: '站口可作为150m研究圈外的接驳锚点；连接线保留到主楼，不把圈外线段伪装成已建成场地。',
      boundaryGeometry: { type: 'Polygon', coordinates: [[[-150, -150], [150, -150], [150, 150], [-150, 150], [-150, -150]]] }
    },
    building: { id: 'main-building', label: project.name || '主楼', local: [0, 0], geometry: { type: 'Point', coordinates: [0, 0] }, evidenceLevel: 'Observed' },
    stations,
    stationDistances,
    roads,
    scenarios: SCENARIOS,
    standards: DESIGN_STANDARDS,
    evidence: {
      level: 'Scenario',
      stationMarkup: STATION_EVIDENCE,
      mapMarkers: RAW_STATION_ENTRIES.map((entry) => ({ id: entry.id, ...entry.mapMarker })),
      mapMeasurement: {
        source: 'map-measurement-exit2-164m.png',
        startLabel: '地图起点',
        endLabel: '主楼红色定位点',
        measuredDistanceM: 164,
        stationBinding: 'probable_metro-tongji-exit-2_pending_explicit_label_confirmation',
        evidenceLevel: 'Observed'
      },
      amapPlacePage: {
        source: 'amap-place-page-verified.png',
        address: '上海市杨浦区四平路1230号',
        relation: '同济大学地铁站4号口步行60米',
        distanceM: 60,
        status: 'historical_auxiliary_evidence_superseded_by_latest_operator_map_measurement',
        evidenceLevel: 'Observed'
      },
      mapMeasurementExit4: {
        source: 'map-measurement-exit4-147m.png',
        measuredDistanceM: 147,
        stationBinding: 'metro-tongji-exit-4',
        supersedes: 'amapPlacePage.distanceM=60',
        evidenceLevel: 'Observed'
      },
      photoOriginBindings: PHOTO_ORIGIN_BINDINGS,
      dataGaps: [
        '站口坐标由用户截图红色矩形与公开出口照片交叉定位，当前为 approximate，需现场控制点复核。',
        '道路中心线、宽度和流量均为 Scenario 模拟，不是高德或现场连续计数。',
        '地铁站只做接驳锚点与位置标记，不做站体外观还原。'
      ]
    },
    review: null,
    lastSimulation: null
  };
}

export function simulateTransportPlan(plan, scenarioId = 'weekday-0830') {
  const scenario = (plan?.scenarios || []).find((item) => item.id === scenarioId) || plan?.scenarios?.[0];
  if (!scenario) throw new Error('没有可用的路网情景');
  const vehicleFlowStatus = scenario.vehicleFlowStatus || 'unmeasured';
  const vehicleFlowNote = vehicleFlowStatus === 'measured'
    ? '机动车流量来自已登记的按小时计数。'
    : '现场照片能证明车辆存在，但没有按小时计数；当前只用压力输入做冲突分级，不把它换算成机动车/小时。';
  const roadResults = (plan.roads || []).map((road) => {
    const raw = scenario.roadFlow?.[road.id] || {};
    const nonMotorizedVolume = ['pedestrians', 'bicycles', 'eBikes'].reduce((sum, key) => sum + finiteNumber(raw[key]), 0);
    const motorizedVolume = vehicleFlowStatus === 'measured'
      ? ['cars', 'motorcycles'].reduce((sum, key) => sum + finiteNumber(raw[key]), 0)
      : finiteNumber(raw.scenarioPressureInput);
    const movingVolume = nonMotorizedVolume + motorizedVolume;
    const saturation = Number((movingVolume / Math.max(1, road.capacityPerHour)).toFixed(3));
    const conflictIndex = Number((saturation * (road.complexity === '高' ? 1.18 : road.complexity === '中' ? 1.05 : 0.9)).toFixed(3));
    return {
      roadId: road.id,
      label: road.label,
      flow: raw,
      movingVolume,
      movingVolumeBasis: vehicleFlowStatus === 'measured' ? 'all_configured_modes' : 'pedestrians_bicycles_eBikes_plus_scenario_pressure_input',
      parkingVolume: finiteNumber(raw.parkedBikes) + finiteNumber(raw.parkedEBikes),
      saturation,
      conflictIndex,
      riskLevel: conflictIndex >= 0.85 ? 'high' : conflictIndex >= 0.6 ? 'medium' : 'low',
      evidenceLevel: 'Scenario'
    };
  });
  const hotspots = roadResults.filter((result) => result.riskLevel !== 'low').map((result) => result.roadId);
  return {
    schema: 'transport_simulation.v1',
    scenarioId: scenario.id,
    label: scenario.label,
    timeWindow: scenario.timeWindow,
    roadResults,
    hotspots,
    totalPedestrians: roadResults.reduce((sum, item) => sum + finiteNumber(item.flow.pedestrians), 0),
    totalBicycles: roadResults.reduce((sum, item) => sum + finiteNumber(item.flow.bicycles), 0),
    totalEBikes: roadResults.reduce((sum, item) => sum + finiteNumber(item.flow.eBikes), 0),
    totalCars: vehicleFlowStatus === 'measured' ? roadResults.reduce((sum, item) => sum + finiteNumber(item.flow.cars), 0) : null,
    totalMotorcycles: vehicleFlowStatus === 'measured' ? roadResults.reduce((sum, item) => sum + finiteNumber(item.flow.motorcycles), 0) : null,
    vehicleFlowStatus,
    vehicleFlowNote,
    evidenceLevel: 'Scenario',
    method: 'transport_scenario_engine.v1'
  };
}

export function normalizeTransportReview(body = {}) {
  const decision = String(body.decision || '').trim();
  if (!['accepted', 'needs_revision'].includes(decision)) throw new Error('人工审核结论必须是 accepted 或 needs_revision');
  const reviewer = String(body.reviewer || '').trim();
  const note = String(body.note || '').trim();
  if (!reviewer || !note) throw new Error('人工审核需要填写审核人和意见');
  return { decision, reviewer: reviewer.slice(0, 80), note: note.slice(0, 1000), reviewedAt: new Date().toISOString(), evidenceLevel: 'Expert Approved' };
}

export const transportPlanConstants = { STATION_EVIDENCE, RAW_STATION_ENTRIES, DESIGN_STANDARDS };

