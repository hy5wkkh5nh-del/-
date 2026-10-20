const DEFAULT_MAX_COORDINATES = 200;
const REASONING_OBJECT_TYPES = new Set([
  'building', 'bridge', 'gate', 'entrance', 'road', 'walkway',
  'loading_zone', 'dropoff_zone', 'lighting', 'landscape'
]);

function inspectCoordinates(value, result) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
    const x = Number(value[0]);
    const y = Number(value[1]);
    const z = Number.isFinite(Number(value[2])) ? Number(value[2]) : 0;
    result.coordinateCount += 1;
    result.minX = Math.min(result.minX, x);
    result.minY = Math.min(result.minY, y);
    result.minZ = Math.min(result.minZ, z);
    result.maxX = Math.max(result.maxX, x);
    result.maxY = Math.max(result.maxY, y);
    result.maxZ = Math.max(result.maxZ, z);
    return;
  }
  for (const child of value) inspectCoordinates(child, result);
}

export function sceneObjectForWorkspace(object, { maxCoordinates = DEFAULT_MAX_COORDINATES } = {}) {
  const geometry = object?.geometry;
  if (!geometry || typeof geometry !== 'object' || !Array.isArray(geometry.coordinates)) return { ...object };
  const inspected = {
    coordinateCount: 0,
    minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, minZ: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY, maxZ: Number.NEGATIVE_INFINITY
  };
  inspectCoordinates(geometry.coordinates, inspected);
  if (inspected.coordinateCount <= maxCoordinates) return { ...object };
  const bounds = inspected.coordinateCount ? {
    minX: inspected.minX, minY: inspected.minY, minZ: inspected.minZ,
    maxX: inspected.maxX, maxY: inspected.maxY, maxZ: inspected.maxZ
  } : null;
  return {
    ...object,
    geometry: {
      type: geometry.type,
      summaryOnly: true,
      coordinateCount: inspected.coordinateCount,
      bounds
    }
  };
}

export function sceneObjectsForWorkspace(objects, options) {
  return (Array.isArray(objects) ? objects : []).map((object) => sceneObjectForWorkspace(object, options));
}

export function sceneObjectsForReasoning(objects, options) {
  return sceneObjectsForWorkspace(objects, options)
    .filter((object) => REASONING_OBJECT_TYPES.has(String(object?.type || '').toLowerCase()));
}

