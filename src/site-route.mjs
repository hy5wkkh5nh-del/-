export const SITE_ROUTE_ROLE = 'site_walkway_route';
export const PRIMARY_SITE_ROUTE_ID = 'site-walkway-route-main';
export const SITE_ROUTE_ROLES = new Set([
  SITE_ROUTE_ROLE,
  'site_context_panorama_outer_lane',
  'site_return_route_to_two_gates',
]);
export const SITE_ROUTE_COORDINATE_SPACE = 'local_enu_m';

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function extractSiteRoutes(sceneObjects = []) {
  return sceneObjects
    .filter((object) => object?.properties?.stale !== true)
    .filter((object) => SITE_ROUTE_ROLES.has(object?.properties?.role))
    .filter((object) => object?.properties?.coordinateSpace === SITE_ROUTE_COORDINATE_SPACE)
    .filter((object) => object?.geometry?.type === 'LineString')
    .filter((object) => Array.isArray(object.geometry.coordinates) && object.geometry.coordinates.length >= 2)
    .map((object) => ({
      id: String(object.id || ''),
      label: String(object.label || '建筑周边小道'),
      evidenceLevel: object.evidenceLevel || 'Hypothesis',
      role: object.properties?.role || null,
      displayContinuity: object.properties?.displayContinuity || null,
      coordinateSpace: SITE_ROUTE_COORDINATE_SPACE,
      widthM: finiteNumber(object.properties?.width_m),
      elevationM: finiteNumber(object.properties?.elevation_m),
      direction: object.properties?.direction === 'reverse' ? 'reverse' : 'forward',
      sourceReference: object.properties?.sourceReference || object.properties?.sourceArtifactId || null,
      registrationVersion: object.properties?.registrationVersion || null,
      evidenceIntervals: Array.isArray(object.properties?.evidenceIntervals) ? object.properties.evidenceIntervals : [],
      sourceAssetIds: Array.isArray(object.sourceAssetIds) ? object.sourceAssetIds : [],
      coordinates: object.geometry.coordinates
    }))
    .filter((route) => route.id);
}

export function selectPrimarySiteRoute(routes = []) {
  if (!Array.isArray(routes) || !routes.length) return null;
  return routes.find((route) => route.id === PRIMARY_SITE_ROUTE_ID)
    || routes.find((route) => route.role === SITE_ROUTE_ROLE && route.displayContinuity === 'single_continuous_route')
    || routes.find((route) => route.role === SITE_ROUTE_ROLE && route.displayContinuity !== 'independent_branch_route')
    || routes[0];
}

export function resolveSiteRoutePoints(route) {
  if (route?.coordinateSpace !== SITE_ROUTE_COORDINATE_SPACE || !Array.isArray(route?.coordinates)) return [];
  const lift = Number.isFinite(route?.elevationM) ? route.elevationM : 0.08;
  const points = route.coordinates.map((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
    const east = finiteNumber(coordinate[0]);
    const north = finiteNumber(coordinate[1]);
    const up = finiteNumber(coordinate[2]) ?? 0;
    if (east === null || north === null) return null;
    // GeoJSON stores local ENU as [east, north, up]. Three.js uses Y-up.
    return [east, up + lift, -north];
  }).filter(Boolean);
  return route.direction === 'reverse' ? points.reverse() : points;
}

export function polylineLength(points = []) {
  return points.slice(1).reduce((length, point, index) => {
    const previous = points[index];
    return length + Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]);
  }, 0);
}

export function samplePolylineAtDistance(points = [], distanceM = 0) {
  if (!points.length) return { position: [0, 0, 0], tangent: [0, 0, -1], distanceM: 0, progress: 0 };
  if (points.length === 1) return { position: [...points[0]], tangent: [0, 0, -1], distanceM: 0, progress: 1 };
  const total = polylineLength(points);
  const target = Math.max(0, Math.min(total, Number(distanceM) || 0));
  let travelled = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    if (travelled + segmentLength >= target || index === points.length - 1) {
      const local = segmentLength ? Math.min(1, Math.max(0, (target - travelled) / segmentLength)) : 0;
      const position = start.map((value, axis) => value + (end[axis] - value) * local);
      const tangentLength = segmentLength || 1;
      const tangent = start.map((value, axis) => (end[axis] - value) / tangentLength);
      return { position, tangent, distanceM: target, progress: total ? target / total : 1 };
    }
    travelled += segmentLength;
  }
  return { position: [...points.at(-1)], tangent: [0, 0, -1], distanceM: total, progress: 1 };
}

