export const WALKTHROUGH_BODY_RADIUS_M = 0.34;

const COLLIDER_PATTERN = /(?:painted masonry wall|concrete column|glazing partition|elevator and shaft|stair flight|guardrail|balustrade|handrail|metal door frame|timber door leaf|aluminium window frame|window glass|furniture component|sanitary fixture|fire safety equipment|building services equipment|\bwall\b|\bcolumn\b|\bglazing\b|\belevator\b|\bstair\b|\brailing\b|\bhandrail\b|\bdoor\b|\bwindow\b|\bfurniture\b)/i;
const NON_COLLIDER_PATTERN = /(?:neutral stone floor|parking marking|parking outline|wheel stop|vehicle body|vehicle glass|landscape planting|route|flow|ground|sky)/i;

export function isWalkthroughCollisionCandidate({ name = '', materialNames = [] } = {}) {
  const description = [name, ...materialNames].filter(Boolean).join(' ');
  if (!description || NON_COLLIDER_PATTERN.test(description)) return false;
  return COLLIDER_PATTERN.test(description);
}

export function visitorWalkthroughYaw(level = {}) {
  const sourceYaw = Number(level?.walkFacingYaw);
  if (!Number.isFinite(sourceYaw)) return 0;
  const opposite = sourceYaw + Math.PI;
  return Math.atan2(Math.sin(opposite), Math.cos(opposite));
}

export function chooseWalkthroughYaw({ preferredYaw = 0, measureHeading, samples = 24 } = {}) {
  const preferred = Number.isFinite(Number(preferredYaw)) ? Number(preferredYaw) : 0;
  if (typeof measureHeading !== 'function') return Math.atan2(Math.sin(preferred), Math.cos(preferred));
  const sampleCount = Math.max(8, Math.floor(Number(samples) || 24));
  let bestYaw = preferred;
  let bestScore = Number(measureHeading(preferred));
  if (!Number.isFinite(bestScore)) bestScore = -Infinity;
  for (let index = 1; index < sampleCount; index += 1) {
    const yaw = preferred + (Math.PI * 2 * index) / sampleCount;
    const score = Number(measureHeading(yaw));
    if (Number.isFinite(score) && score > bestScore) {
      bestScore = score;
      bestYaw = yaw;
    }
  }
  return Math.atan2(Math.sin(bestYaw), Math.cos(bestYaw));
}

export function shouldFallbackToFloorSpawn(space = {}, viewScore, level = {}, spawnBlocked = false) {
  const score = Number(viewScore);
  return space?.geometryStatus === 'label_anchor_only'
    && (Boolean(spawnBlocked) || (Number.isFinite(score) && score < 4))
    && Array.isArray(level?.walkSpawnM)
    && level.walkSpawnM.length >= 3;
}

export function preferredWalkthroughEntry(levels = []) {
  const availableLevels = Array.isArray(levels) ? levels.filter(Boolean) : [];
  const entryLevel = availableLevels.find((level) => Number(level.floorNumber) === 1) || availableLevels[0];
  const spaces = Array.isArray(entryLevel?.spaces) ? entryLevel.spaces : [];
  const labelOf = (space) => String(space?.displayLabel || space?.label || '').trim();
  const publicEntry = spaces.filter((space) => {
    const label = labelOf(space);
    return !/(?:车库|停车|地下车库|后勤|卸货|设备|机房|电梯厅|楼梯间)/.test(label);
  });
  const findBy = (pattern, type) => publicEntry.find((space) => {
    const label = labelOf(space);
    return (type ? space?.type === type : true) && pattern.test(label);
  });
  // Do not let a technical “出入口” win over the actual visitor route.
  // The floor data currently contains both “车库出入口” and “门厅”.
  const preferred = findBy(/(?:主门厅|门厅)/)
    || findBy(/(?:大厅休息|大厅|展厅)/)
    || findBy(/接待/)
    || findBy(/(?:休息厅|休息区|走廊|公共)/)
    || publicEntry.find((space) => ['amenity', 'corridor', 'circulation'].includes(space?.type))
    || publicEntry.find((space) => space?.type === 'lobby')
    || publicEntry[0];
  return preferred || spaces[0] || null;
}

function clamp(value, extent) {
  const safeExtent = Math.max(0, Number(extent) || 0);
  return Math.max(-safeExtent, Math.min(safeExtent, Number(value) || 0));
}

function horizontalLength(delta) {
  return Math.hypot(Number(delta?.[0]) || 0, Number(delta?.[2]) || 0);
}

export function resolveConstrainedWalkthroughMove({ position, delta, bounds, collides } = {}) {
  const current = [Number(position?.[0]) || 0, Number(position?.[1]) || 0, Number(position?.[2]) || 0];
  const movement = [Number(delta?.[0]) || 0, 0, Number(delta?.[2]) || 0];
  const collisionCheck = typeof collides === 'function' ? collides : () => false;
  if (!horizontalLength(movement)) return { position: current, blocked: false, slid: false };

  const axisMoves = [
    [movement[0], 0, 0],
    [0, 0, movement[2]]
  ].filter((candidate) => horizontalLength(candidate) > 1e-6)
    .sort((left, right) => horizontalLength(right) - horizontalLength(left));
  const attempts = [movement, ...axisMoves];

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    if (collisionCheck(current, attempt)) continue;
    return {
      position: [
        clamp(current[0] + attempt[0], bounds?.x),
        current[1],
        clamp(current[2] + attempt[2], bounds?.z)
      ],
      blocked: false,
      slid: index > 0
    };
  }

  return { position: current, blocked: true, slid: false };
}

