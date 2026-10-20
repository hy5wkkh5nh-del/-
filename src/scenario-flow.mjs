import { SITE_ROUTE_ROLE } from './site-route.mjs';

const FLOW_LIFT_M = 0.18;
const DEFAULT_MAX_PARTICLES = 72;
const PARTICLES_PER_ACTOR_PER_MINUTE = 12;

function distanceBetween(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function roundCoordinate(value) {
  return Number(value.toFixed(6));
}

function hashUnit(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

export function extractScenarioRoads(sceneObjects = []) {
  return sceneObjects
    .filter((object) => (object?.type === 'road' || object?.properties?.role === SITE_ROUTE_ROLE) && object?.geometry?.type === 'LineString' && object?.properties?.stale !== true)
    .map((object) => {
      const coordinates = Array.isArray(object.geometry.coordinates) ? object.geometry.coordinates : [];
      const base = Number(object?.properties?.terrainBaseRelativeM);
      const points = coordinates
        .filter((coordinate) => Array.isArray(coordinate) && coordinate.length >= 2 && Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1])))
        .map((coordinate) => {
          const up = Number(coordinate[2]);
          const elevation = (Number.isFinite(up) ? up : Number.isFinite(base) ? base : 0) + FLOW_LIFT_M;
          return [roundCoordinate(Number(coordinate[0])), roundCoordinate(elevation), roundCoordinate(-Number(coordinate[1]))];
        });
      const length = points.slice(1).reduce((sum, point, index) => sum + distanceBetween(points[index], point), 0);
      return {
        id: String(object.id || ''),
        label: String(object.label || object?.properties?.name || object.id || ''),
        source: object?.properties?.source || null,
        highway: object?.properties?.highway || null,
        widthM: Number.isFinite(Number(object?.properties?.width_m)) ? Number(object.properties.width_m) : null,
        evidenceLevel: object.evidenceLevel || null,
        points,
        length: roundCoordinate(length)
      };
    })
    .filter((route) => route.id && route.points.length >= 2 && route.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function pointAlongPolyline(route, progress, reverse = false) {
  const points = route?.points || [];
  if (points.length < 2) return points[0] || [0, 0, 0];
  const wrapped = ((Number(progress) % 1) + 1) % 1;
  const normalized = reverse ? 1 - wrapped : wrapped;
  const routeLength = Number(route.length) || points.slice(1).reduce((sum, point, index) => sum + distanceBetween(points[index], point), 0);
  let remaining = normalized * routeLength;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentLength = distanceBetween(start, end);
    if (remaining <= segmentLength || index === points.length - 1) {
      const ratio = segmentLength ? Math.min(1, remaining / segmentLength) : 0;
      return start.map((value, axis) => roundCoordinate(value + (end[axis] - value) * ratio));
    }
    remaining -= segmentLength;
  }
  return [...points.at(-1)];
}

export function buildScenarioFlowPlan(sceneObjects = [], scenarioPoint = null, options = {}) {
  const availableRoutes = extractScenarioRoads(sceneObjects);
  const selectedRouteId = String(options.selectedRouteId || '').trim();
  const selectedRoute = availableRoutes.find((route) => route.id === selectedRouteId) || null;
  const routes = selectedRoute ? [selectedRoute] : [];
  const flowValue = Math.max(0, Number(scenarioPoint?.value) || 0);
  const requestedLimit = Number(options.maxParticles);
  const maxParticles = Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_MAX_PARTICLES);
  const particleCount = routes.length && flowValue > 0
    ? Math.min(maxParticles, Math.max(1, Math.ceil(flowValue * PARTICLES_PER_ACTOR_PER_MINUTE)))
    : 0;
  const routeSignature = selectedRoute?.id || '';
  const hour = Number(scenarioPoint?.hour) || 0;
  const particles = Array.from({ length: particleCount }, (_, index) => {
    const seed = `${routeSignature}:${hour}:${index}`;
    return {
      routeId: selectedRoute.id,
      phase: roundCoordinate(hashUnit(`${seed}:phase`)),
      speed: roundCoordinate(0.025 + hashUnit(`${seed}:speed`) * 0.035),
      reverse: hashUnit(`${seed}:direction`) >= 0.5
    };
  });
  return {
    label: 'Scenario 道路映射 · 非逐点轨迹',
    evidenceLevel: 'Scenario',
    sourceEvidenceLevel: scenarioPoint?.evidenceLevel || null,
    isObservedTrajectory: false,
    flowValue,
    selectedRouteId: selectedRoute?.id || selectedRouteId || null,
    availableRoutes,
    routes,
    particles,
    dataGap: selectedRoute ? null : selectedRouteId ? 'selected_route_not_found' : 'route_selection_required'
  };
}

export function scenarioFlowColor(value, maximum) {
  const safeMaximum = Math.max(1, Number(maximum) || 0);
  const ratio = Math.max(0, Math.min(1, (Number(value) || 0) / safeMaximum));
  return `hsl(${Math.round(120 - ratio * 120)}, 76%, 57%)`;
}

