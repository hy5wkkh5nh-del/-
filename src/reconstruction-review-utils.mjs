/**
 * Pure helpers for the moving-video reconstruction review card.
 *
 * The helpers deliberately accept both the camelCase and snake_case names
 * used by the evidence ledgers. They never infer a map coordinate or merge
 * neighbouring frames; an unknown location remains visibly unknown.
 */

export const KEYFRAME_REVIEW_STATES = Object.freeze({
  pending: 'pending',
  confirmed: 'confirmed',
  corrected: 'corrected',
  rejected: 'rejected'
});

export const KEYFRAME_MOTION_STATES = Object.freeze({
  forward: 'forward',
  backward: 'backward',
  stop: 'stop',
  rotationOnly: 'rotation-only',
  turning: 'turning',
  unknown: 'unknown'
});

export const LOCATION_MODES = Object.freeze({
  point: 'point',
  interval: 'interval',
  relativeOnly: 'relative-only',
  pending: 'pending',
  rotationOnly: 'rotation-only'
});

const REVIEW_STATE_LABELS = Object.freeze({
  pending: '待确认',
  confirmed: '已确认',
  corrected: '已修正',
  rejected: '不采用'
});

const MOTION_LABELS = Object.freeze({
  forward: '前进',
  backward: '回程 / 后退',
  stop: '停止 / 固定机位',
  'rotation-only': '原地旋转',
  turning: '转弯中',
  unknown: '运动待判定'
});

const LOCATION_MODE_LABELS = Object.freeze({
  point: '地图点',
  interval: '地图区间',
  'relative-only': '仅相对位置',
  pending: '待定位',
  'rotation-only': '同一站点 · 旋转'
});

const CONFIDENCE_LABELS = Object.freeze({
  high: '高',
  medium: '中',
  low: '低',
  unknown: '未记录'
});

const EVIDENCE_LEVEL_LABELS = Object.freeze({
  observed: '现场观测',
  derived: '算法推导',
  hypothesis: '合理模拟',
  scenario: '情景推演',
  unavailable: '暂无证据'
});

const TEMPORARY_OBJECT_STATE_LABELS = Object.freeze({
  review: '仅审阅层',
  candidate: '候选层',
  excluded: '不采用',
  pending: '待确认'
});

function canonicalLocationMode(value) {
  const normalized = asString(value).trim().toLowerCase().replaceAll('_', '-');
  if (!normalized) return LOCATION_MODES.pending;
  if (['point', 'station', 'station-point', 'capture-station', 'verified-point', 'verified', 'mapped', 'located'].includes(normalized)) return LOCATION_MODES.point;
  if (normalized.includes('rotation') || normalized === 'station-only') return LOCATION_MODES.rotationOnly;
  if (normalized.includes('interval') || normalized.includes('seed') || normalized.includes('range')) return LOCATION_MODES.interval;
  if (normalized.includes('relative') || normalized.includes('topology') || normalized.includes('sequence')) return LOCATION_MODES.relativeOnly;
  if (normalized.includes('pending') || normalized.includes('manual-review') || normalized.includes('unlocated') || normalized.includes('not-assigned') || normalized.includes('unassigned')) return LOCATION_MODES.pending;
  return normalized;
}

function canonicalSelectionState(value) {
  const normalized = asString(value).trim().toLowerCase().replaceAll('_', '-');
  if (['selected', 'adopted', 'adopt', 'included', 'include', 'accepted'].includes(normalized)) return KEYFRAME_REVIEW_STATES.confirmed;
  if (['corrected', 'selected-after-correction', 'adopted-after-correction'].includes(normalized)) return KEYFRAME_REVIEW_STATES.corrected;
  if (['not-selected', 'not-adopted', 'excluded', 'rejected', 'discarded'].includes(normalized)) return KEYFRAME_REVIEW_STATES.rejected;
  return KEYFRAME_REVIEW_STATES.pending;
}

function mapCoordinatesValue(value) {
  const isCoordinateNumber = (item) => {
    if (item === undefined || item === null || (typeof item === 'string' && item.trim() === '')) return false;
    return Number.isFinite(Number(item));
  };
  if (Array.isArray(value) && value.length >= 2 && value.slice(0, 2).every(isCoordinateNumber)) return value.slice(0, 2).map(Number);
  if (!value || typeof value !== 'object') return null;
  const keys = [
    ['x', 'y'], ['lon', 'lat'], ['longitude', 'latitude'], ['east', 'north'], ['easting', 'northing']
  ];
  for (const [xKey, yKey] of keys) {
    if (isCoordinateNumber(value[xKey]) && isCoordinateNumber(value[yKey])) return [Number(value[xKey]), Number(value[yKey])];
  }
  const nested = value.localEnuM || value.local_enu_m || value.coordinates;
  if (Array.isArray(nested) && nested.length >= 2 && nested.slice(0, 2).every(isCoordinateNumber)) return nested.slice(0, 2).map(Number);
  return null;
}

function mapCoordinatesLabel(value) {
  const coordinates = mapCoordinatesValue(value);
  return coordinates ? `(${coordinates.map((item) => Number(item).toFixed(2)).join(', ')})` : '';
}

function canonicalMotionState(value) {
  const normalized = asString(value).trim().toLowerCase().replaceAll('_', '-');
  if (!normalized) return KEYFRAME_MOTION_STATES.unknown;
  if (normalized.includes('rotation') || normalized.includes('360') || normalized.includes('panorama')) return KEYFRAME_MOTION_STATES.rotationOnly;
  if (normalized.includes('return') || normalized.includes('backward') || normalized.includes('reverse')) return KEYFRAME_MOTION_STATES.backward;
  if (normalized.includes('turn') || normalized.includes('corner')) return KEYFRAME_MOTION_STATES.turning;
  if (normalized.includes('forward') || normalized.includes('moving') || normalized.includes('route')) return KEYFRAME_MOTION_STATES.forward;
  if (normalized.includes('stop') || normalized.includes('stationary') || normalized.includes('fixed')) return KEYFRAME_MOTION_STATES.stop;
  if (normalized.includes('static') || normalized.includes('unknown') || normalized === 'pending' || normalized === 'unavailable') return KEYFRAME_MOTION_STATES.unknown;
  return normalized;
}

function canonicalReviewState(value) {
  const normalized = asString(value).trim().toLowerCase().replaceAll('_', '-');
  if (['confirmed', 'user-confirmed', 'operator-confirmed', 'approved', 'expert-approved'].includes(normalized)) return KEYFRAME_REVIEW_STATES.confirmed;
  if (['corrected', 'revised', 'accepted-after-correction'].includes(normalized)) return KEYFRAME_REVIEW_STATES.corrected;
  if (['rejected', 'excluded', 'not-used', 'not-adopted'].includes(normalized)) return KEYFRAME_REVIEW_STATES.rejected;
  return KEYFRAME_REVIEW_STATES.pending;
}

function canonicalEvidenceLevel(value) {
  const normalized = asString(value).trim().toLowerCase().replaceAll('_', '-');
  if (normalized.includes('observ')) return 'observed';
  if (normalized.includes('deriv')) return 'derived';
  if (normalized.includes('hypoth') || normalized.includes('approx')) return 'hypothesis';
  if (normalized.includes('scenario') || normalized.includes('simulat')) return 'scenario';
  if (!normalized || normalized.includes('unavail') || normalized.includes('unknown') || normalized === 'null') return 'unavailable';
  return normalized;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function asString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseKeyframePath(value) {
  const path = asString(value);
  const fileName = path.split(/[\\/]/).pop() || path;
  const timeMatch = fileName.match(/__t(\d+(?:\.\d+)?)__/i);
  const frameMatch = fileName.match(/(?:__kf|frame[-_]?)(\d+)/i);
  const parentMatch = path.match(/video-entity-([^\\/]+)/i);
  const videoMatch = fileName.match(/^([a-z0-9]+)__t/i);
  return {
    sourcePath: path,
    fileName,
    timestampMs: timeMatch ? Number(timeMatch[1]) * 1000 : null,
    frameNumber: frameMatch ? Number(frameMatch[1]) : null,
    entityId: parentMatch ? parentMatch[1] : null,
    videoId: videoMatch ? videoMatch[1] : null
  };
}

function materializeKeyframe(value, entity = {}, index = 0) {
  if (value && typeof value === 'object') {
    return {
      ...value,
      id: firstDefined(value.id, value.frameId),
      videoId: firstDefined(value.videoId, value.assetId, entity.canonicalVideoId, entity.entityId),
      videoName: firstDefined(value.videoName, value.assetName, entity.primaryFile, entity.entityId),
      frameNumber: firstDefined(value.frameNumber, value.frameNo, value.sourceFrameNumber),
      timestamp: firstDefined(value.timestamp, value.timestampSeconds),
      timestampSeconds: firstDefined(value.timestampSeconds, value.timestamp),
      imagePath: firstDefined(value.imagePath, value.sourcePath, value.path),
      motion: firstDefined(value.motion, value.motionState, value.motionClass, entity.motion?.motionClass, entity.directionState?.relativeMotionState),
      routeBinding: value.routeBinding || entity.routeBinding,
      location: value.location || {
        mode: firstDefined(value.positionStatus, value.positionRef ? 'point' : null, entity.routeBinding?.status, entity.bindingStatus, LOCATION_MODES.pending),
        pointId: firstDefined(value.positionRef, value.captureStationId, value.stationId),
        coordinates: value.mapCoordinates,
        progress: value.routeProgress,
        routeSegment: value.routeSegment
      },
      mapCoordinates: value.mapCoordinates,
      routeProgress: value.routeProgress,
      routeSegment: value.routeSegment,
      cameraRelation: value.cameraRelation || value.cameraLocal || entity.leftRightState,
      locationEvidence: value.locationEvidence,
      evidenceLevel: value.evidenceLevel || value.metricEvidence,
      reviewStatus: firstDefined(value.reviewStatus, value.userStatus, value.status),
      selectionStatus: value.selectionStatus,
      userConfirmation: value.userConfirmation,
      directionState: value.directionState || entity.directionState,
      leftRightState: value.leftRightState || entity.leftRightState
    };
  }
  const parsed = parseKeyframePath(value);
  return {
    id: `${entity.entityId || parsed.entityId || entity.canonicalVideoId || 'video'}:KF-${String(index + 1).padStart(3, '0')}`,
    sourcePath: parsed.sourcePath,
    fileName: parsed.fileName,
    videoId: firstDefined(entity.canonicalVideoId, parsed.videoId, entity.entityId, '未标记视频'),
    videoName: firstDefined(entity.primaryFile, parsed.fileName, entity.entityId, '未命名视频'),
    timestampMs: parsed.timestampMs,
    frameNumber: parsed.frameNumber,
    imagePath: parsed.sourcePath,
    motion: firstDefined(entity.motion?.motionClass, entity.directionState?.relativeMotionState, entity.routeBinding?.travel),
    motionNote: entity.motion?.interpretation,
    routeBinding: entity.routeBinding,
    directionState: entity.directionState,
    leftRightState: entity.leftRightState,
    location: {
      mode: firstDefined(entity.routeBinding?.status, entity.bindingStatus, entity.stationCandidates?.[0]?.assignmentStatus, LOCATION_MODES.pending),
      pointId: firstDefined(entity.routeBinding?.captureStationId, entity.stationCandidates?.[0]?.captureStationId),
      coordinates: firstDefined(entity.routeBinding?.mapCoordinates, entity.routeBinding?.coordinateLocalEnuM),
      routeSegment: entity.routeBinding?.routeSegment,
      label: firstDefined(entity.routeBinding?.routeSegment, entity.groups?.[0]?.groupName),
      relative: entity.routeBinding?.reason
    },
    cameraRelation: entity.leftRightState,
    confidence: firstDefined(entity.leftRightState?.evidenceLevel, entity.routeBinding?.evidenceLevel, 'unknown'),
    reviewStatus: firstDefined(entity.reviewStatus, entity.userStatus, 'pending'),
    selectionStatus: firstDefined(entity.selectionStatus, 'unreviewed'),
    userConfirmation: firstDefined(entity.userConfirmation, 'pending')
  };
}

export function flattenMotionRecords(ledger) {
  const records = asArray(ledger?.records || ledger?.entities || ledger?.videoRecords);
  if (!records.length) return null;
  return records.flatMap((entity) => asArray(entity?.keyframes).map((value, index) => materializeKeyframe(value, entity, index)));
}

export function flattenVideoFrames(ledger) {
  const videos = asArray(ledger?.videos);
  if (!videos.length) return null;
  return videos.flatMap((video) => asArray(video?.frames).map((frame, index) => materializeKeyframe(frame, {
    canonicalVideoId: video.videoId,
    entityId: video.videoId,
    primaryFile: video.fileName,
    routeBinding: video.routeBinding,
    motion: video.motion,
    directionState: video.directionState,
    leftRightState: video.leftRightState,
    groups: video.groups
  }, index)));
}

export function getLedgerKeyframes(ledger) {
  const direct = asArray(ledger?.keyframes || ledger?.keyFrames || ledger?.frames);
  if (direct.length) return direct;
  const videos = flattenVideoFrames(ledger);
  if (videos?.length) return videos;
  return flattenMotionRecords(ledger) || [];
}

export function getFrameId(frame, fallback = '') {
  return asString(firstDefined(frame?.id, frame?.frameId, frame?.keyframeId, fallback));
}

export function getFrameSourceId(frame) {
  return asString(firstDefined(
    frame?.videoId,
    frame?.assetId,
    frame?.sourceAssetId,
    frame?.source?.videoId,
    frame?.source?.assetId,
    frame?.source?.id,
    typeof frame === 'string' ? parseKeyframePath(frame).videoId : null,
    '未标记视频'
  ));
}

export function getFrameSourceName(frame) {
  return asString(firstDefined(
    frame?.videoName,
    frame?.assetName,
    frame?.sourceName,
    frame?.source?.name,
    frame?.source?.fileName,
    frame?.fileName,
    typeof frame === 'string' ? parseKeyframePath(frame).fileName : null,
    getFrameSourceId(frame)
  ));
}

export function getFrameImagePath(frame) {
  return asString(firstDefined(frame?.imagePath, frame?.sourcePath, frame?.path, frame?.image?.path, frame?.thumbnailPath, ''), '');
}

export function getFrameThumbnailUrl(frame, { resolver = null, baseUrl = '' } = {}) {
  const direct = firstDefined(frame?.thumbnailUrl, frame?.imageUrl, frame?.previewUrl, frame?.image?.url);
  if (direct) return String(direct);
  const imagePath = getFrameImagePath(frame);
  if (!imagePath) return '';
  if (typeof resolver === 'function') {
    const resolved = resolver(frame, imagePath);
    if (resolved) return String(resolved);
  }
  if (baseUrl) return `${String(baseUrl).replace(/\/$/, '')}?path=${encodeURIComponent(imagePath)}`;
  return '';
}

export function resolveEvidenceImageUrl(frame, { ledger = null, baseUrl = '', resolver = null } = {}) {
  const direct = getFrameThumbnailUrl(frame, { resolver, baseUrl });
  if (direct) return direct;
  const imagePath = getFrameImagePath(frame);
  if (!imagePath || !ledger) return '';
  const root = ledger?.evidenceBaseUrl || ledger?.evidenceRootUrl || ledger?.baseUrl;
  if (root) return `${String(root).replace(/\/$/, '')}/${imagePath.replace(/^[/\\]+/, '').replaceAll('\\', '/')}`;
  return '';
}

export function getFrameNumber(frame) {
  return asNumber(firstDefined(frame?.frameNumber, frame?.frameNo, frame?.sourceFrameNumber, frame?.frame, frame?.index, typeof frame === 'string' ? parseKeyframePath(frame).frameNumber : null), null);
}

export function getFrameTimestampMs(frame) {
  const directMilliseconds = firstDefined(frame?.timestampMs, frame?.timeMs, frame?.ptsMs);
  const directSeconds = firstDefined(frame?.timestampSeconds, frame?.timeSeconds);
  const direct = firstDefined(directMilliseconds, directSeconds, frame?.timestamp, typeof frame === 'string' ? parseKeyframePath(frame).timestampMs : null);
  if (typeof direct === 'string' && /:/.test(direct)) {
    const parts = direct.split(':').map(Number);
    if (parts.every(Number.isFinite)) {
      if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
      if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
    }
  }
  const number = asNumber(direct, null);
  if (number === null) return null;
  // Ledgers normally store milliseconds; values below one hour are commonly
  // seconds from ffmpeg/PyAV exports. Keep explicit `timestampMs` untouched.
  if (directMilliseconds !== undefined) return number;
  if (directSeconds !== undefined) return number * 1000;
  if (typeof frame === 'string') return number;
  return number < 3600 ? number * 1000 : number;
}

export function formatTimestamp(value, { empty = '—' } = {}) {
  const milliseconds = typeof value === 'object' ? getFrameTimestampMs(value) : asNumber(value, null);
  if (milliseconds === null) return empty;
  const totalMs = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const prefix = hours > 0 ? `${String(hours).padStart(2, '0')}:` : '';
  return `${prefix}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function getFrameLocation(frame) {
  const binding = frame?.mapBinding && typeof frame.mapBinding === 'object' ? frame.mapBinding : {};
  const location = frame?.location || frame?.map || frame?.mapLocation || binding || {};
  const coordinates = mapCoordinatesValue(firstDefined(
    location?.coordinates,
    location?.mapCoordinates,
    binding?.point,
    frame?.mapCoordinates,
    frame?.coordinates
  ));
  const mode = canonicalLocationMode(firstDefined(
    location?.mode,
    location?.locationMode,
    binding?.status,
    frame?.locationMode,
    frame?.mapMode,
    frame?.positionMode,
    frame?.positionStatus,
    frame?.positionRef && coordinates ? 'point' : null,
    LOCATION_MODES.pending
  ));
  const pointId = firstDefined(location?.pointId, location?.stationId, location?.captureStationId, binding?.markerId, frame?.positionRef, frame?.captureStationId, frame?.pointId, frame?.stationId);
  const routeSegment = firstDefined(location?.routeSegment, location?.routeId, location?.segmentId, binding?.routeSegment, frame?.routeSegment, frame?.routeId, frame?.routeBinding?.routeSegment);
  const label = firstDefined(location?.label, location?.description, binding?.note, frame?.locationLabel, frame?.mapLabel);
  const progress = asNumber(firstDefined(location?.progress, location?.progressM, frame?.progress, frame?.routeProgress, frame?.routeProgressM), null);
  const start = firstDefined(location?.start, location?.from, location?.intervalStart, binding?.interval?.start);
  const end = firstDefined(location?.end, location?.to, location?.intervalEnd, binding?.interval?.end);
  const relative = firstDefined(location?.relative, location?.relativePosition, binding?.note, frame?.relativePosition, frame?.routeBinding?.reason, frame?.unresolved?.[0]);
  const rotationStationValid = Boolean(
    location?.rotationStationValid
    || frame?.rotationStationValid
    || (mode === LOCATION_MODES.rotationOnly && pointId && (frame?.stationStatus === 'verified' || frame?.positionRefVerified === true || location?.stationStatus === 'verified'))
  );
  return { mode, pointId, routeSegment, label, progress, start, end, relative, coordinates, rotationStationValid, coordinatesLabel: mapCoordinatesLabel(coordinates), raw: location };
}

function finiteMapPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

/**
 * Return only explicitly image-relative map placement data.  Local/map-meter
 * coordinates are retained as recorded evidence but are never guessed to be
 * percentages.  The review map can therefore show a marker only when the
 * ledger explicitly supplies xPercent/yPercent (or an equivalent normalized
 * pair); all other points remain visible in the unconverted list.
 */
export function getFrameMapPosition(frame) {
  const source = frame?.raw && typeof frame.raw === 'object' ? frame.raw : frame;
  const location = getFrameLocation(source);
  const rawLocation = source?.location || source?.map || source?.mapLocation || {};
  const binding = source?.mapBinding && typeof source.mapBinding === 'object' ? source.mapBinding : {};
  const nestedPercent = firstDefined(
    rawLocation?.mapPercent,
    rawLocation?.mapPositionPercent,
    binding?.mapPercent,
    binding?.mapPositionPercent,
    source?.mapPercent,
    source?.mapPositionPercent
  );
  const percentObject = nestedPercent && typeof nestedPercent === 'object' ? nestedPercent : {};
  const explicitX = firstDefined(
    rawLocation?.xPercent,
    rawLocation?.percentX,
    rawLocation?.normalizedX,
    binding?.xPercent,
    binding?.percentX,
    source?.xPercent,
    source?.percentX,
    percentObject?.x,
    percentObject?.xPercent
  );
  const explicitY = firstDefined(
    rawLocation?.yPercent,
    rawLocation?.percentY,
    rawLocation?.normalizedY,
    binding?.yPercent,
    binding?.percentY,
    source?.yPercent,
    source?.percentY,
    percentObject?.y,
    percentObject?.yPercent
  );
  let x = finiteMapPercent(explicitX);
  let y = finiteMapPercent(explicitY);
  const coordinateSpace = asString(firstDefined(
    rawLocation?.coordinateSpace,
    binding?.coordinateSpace,
    source?.coordinateSpace,
    source?.mapCoordinateSpace
  )).trim().toLowerCase().replaceAll('_', '-');
  // Bare x/y values are ambiguous (pixels, meters, or percentages).  Accept
  // them only when the source explicitly declares an image-relative space.
  if (x === null || y === null) {
    const imageRelative = coordinateSpace.includes('percent') || coordinateSpace.includes('normalized') || coordinateSpace.includes('image-relative');
    if (imageRelative) {
      x = finiteMapPercent(firstDefined(rawLocation?.x, binding?.x, source?.x));
      y = finiteMapPercent(firstDefined(rawLocation?.y, binding?.y, source?.y));
    }
  }
  // A bare mode (for example `point` with no point id/coordinates) is still
  // unresolved and should not be presented as a recorded map point.
  const recorded = Boolean(location.coordinates || location.pointId);
  const converted = x !== null && y !== null;
  return {
    x: converted ? x : null,
    y: converted ? y : null,
    coordinates: location.coordinates,
    coordinatesLabel: location.coordinatesLabel,
    pointId: location.pointId,
    recorded,
    converted,
    unconverted: recorded && !converted,
    conversionNote: recorded && !converted ? '已记录，但未转换到底图百分比' : null
  };
}

export function formatFrameLocation(frame, { empty = '待定位' } = {}) {
  const location = getFrameLocation(frame);
  const modeLabel = formatLocationMode(location.mode);
  const parts = [];
  if (location.label) parts.push(String(location.label));
  if (location.pointId) parts.push(`点 ${location.pointId}`);
  if (location.routeSegment) parts.push(`段 ${location.routeSegment}`);
  if (location.start !== undefined || location.end !== undefined) {
    parts.push(`${firstDefined(location.start, '?')} → ${firstDefined(location.end, '?')}`);
  }
  if (location.progress !== null) parts.push(`${Math.round(location.progress)}m`);
  if (location.coordinatesLabel) parts.push(location.coordinatesLabel);
  if (location.relative) parts.push(String(location.relative));
  return parts.length ? `${modeLabel} · ${parts.join(' · ')}` : modeLabel || empty;
}

export function getFrameMotion(frame) {
  const rawMotion = firstDefined(
    frame?.motion,
    frame?.motionState,
    frame?.movement,
    frame?.movementState,
    frame?.cameraMotion,
    frame?.motion?.motionClass,
    frame?.directionState?.relativeMotionState,
    frame?.routeBinding?.travel,
    KEYFRAME_MOTION_STATES.unknown
  );
  const value = canonicalMotionState(typeof rawMotion === 'object' ? firstDefined(rawMotion?.motionClass, rawMotion?.relativeMotionState, rawMotion?.status, KEYFRAME_MOTION_STATES.unknown) : rawMotion);
  return value;
}

export function formatMotion(value) {
  return MOTION_LABELS[asString(value)] || asString(value, MOTION_LABELS.unknown);
}

export function getCameraRelation(frame) {
  const relation = frame?.cameraRelation || frame?.cameraRelative || frame?.cameraLocal || frame?.camera?.relation || frame?.sides || frame?.leftCenterRight || {};
  const left = firstDefined(relation?.left, frame?.left, frame?.cameraLeft, frame?.view?.left);
  const center = firstDefined(relation?.center, relation?.centre, frame?.center, frame?.centre, frame?.cameraCenter, frame?.view?.center, frame?.view?.centre);
  const right = firstDefined(relation?.right, frame?.right, frame?.cameraRight, frame?.view?.right);
  return {
    left: asString(left, '未记录'),
    center: asString(center, '未记录'),
    right: asString(right, '未记录'),
    reference: asString(firstDefined(relation?.reference, frame?.cameraDirection, frame?.headingReference), '相机当前行进方向')
  };
}

export function getFrameReviewState(frame) {
  const explicit = firstDefined(frame?.reviewStatus, frame?.userStatus, frame?.status);
  if (explicit !== undefined) return canonicalReviewState(explicit);
  if (frame?.selectionStatus !== undefined) {
    const selectionState = canonicalSelectionState(frame.selectionStatus);
    if (selectionState === KEYFRAME_REVIEW_STATES.rejected) return selectionState;
    if (frame?.userConfirmationState !== undefined) {
      const confirmationState = canonicalReviewState(frame.userConfirmationState);
      if (confirmationState !== KEYFRAME_REVIEW_STATES.pending) return confirmationState;
    }
    if (selectionState !== KEYFRAME_REVIEW_STATES.pending || frame?.userConfirmation === undefined) return selectionState;
  }
  if (frame?.userConfirmationState !== undefined) return canonicalReviewState(frame.userConfirmationState);
  if (frame?.userConfirmation !== undefined) return canonicalReviewState(frame.userConfirmation);
  return KEYFRAME_REVIEW_STATES.pending;
}

export function formatReviewState(value) {
  return REVIEW_STATE_LABELS[asString(value)] || asString(value, REVIEW_STATE_LABELS.pending);
}

export function reviewPatchForState(state) {
  const canonical = canonicalReviewState(state);
  if (canonical === KEYFRAME_REVIEW_STATES.confirmed) return {
    reviewStatus: canonical,
    userStatus: canonical,
    status: canonical,
    userConfirmation: 'confirmed',
    selectionStatus: 'selected'
  };
  if (canonical === KEYFRAME_REVIEW_STATES.corrected) return {
    reviewStatus: canonical,
    userStatus: canonical,
    status: canonical,
    userConfirmation: 'corrected',
    selectionStatus: 'selected'
  };
  if (canonical === KEYFRAME_REVIEW_STATES.rejected) return {
    reviewStatus: canonical,
    userStatus: canonical,
    status: canonical,
    userConfirmation: 'rejected',
    selectionStatus: 'not_selected'
  };
  return {
    reviewStatus: KEYFRAME_REVIEW_STATES.pending,
    userStatus: KEYFRAME_REVIEW_STATES.pending,
    status: KEYFRAME_REVIEW_STATES.pending,
    userConfirmation: 'pending',
    selectionStatus: 'unreviewed'
  };
}

/**
 * Build the small, server-safe review patch used by the manual locator.
 * Empty inputs stay null/empty and are never converted into coordinates.
 * The host may merge this patch with the selected frame before persisting it.
 */
export function buildKeyframeReviewPatch({
  locationMode = LOCATION_MODES.pending,
  pointId = '',
  routeSegment = '',
  coordinates = null,
  imageXPercent = '',
  imageYPercent = '',
  intervalStart = '',
  intervalEnd = '',
  relativeNote = '',
  routeProgress = '',
  motionState = KEYFRAME_MOTION_STATES.unknown,
  cameraLeft = '',
  cameraCenter = '',
  cameraRight = '',
  cameraReference = 'camera_travel_direction',
  changeFromPrevious = '',
  changeToNext = '',
  rotationStationConfirmed = false
} = {}) {
  const mode = canonicalLocationMode(locationMode);
  const cleanPointId = asString(pointId).trim();
  const cleanSegment = asString(routeSegment).trim();
  const cleanRelative = asString(relativeNote).trim();
  const cleanStart = asString(intervalStart).trim();
  const cleanEnd = asString(intervalEnd).trim();
  const cleanCoordinates = mapCoordinatesValue(coordinates);
  const imageX = imageXPercent === '' || imageXPercent === null || imageXPercent === undefined
    ? null
    : asNumber(imageXPercent, null);
  const imageY = imageYPercent === '' || imageYPercent === null || imageYPercent === undefined
    ? null
    : asNumber(imageYPercent, null);
  const progressNumber = routeProgress === '' || routeProgress === null || routeProgress === undefined ? null : asNumber(routeProgress, null);
  const binding = { status: mode };
  if (cleanPointId) binding.markerId = cleanPointId;
  if (cleanSegment) binding.routeSegment = cleanSegment;
  if (cleanCoordinates) binding.point = cleanCoordinates;
  if (imageX !== null && imageX >= 0 && imageX <= 100) binding.xPercent = imageX;
  if (imageY !== null && imageY >= 0 && imageY <= 100) binding.yPercent = imageY;
  if (mode === LOCATION_MODES.interval && (cleanStart || cleanEnd)) binding.interval = { start: cleanStart || null, end: cleanEnd || null };
  if (mode === LOCATION_MODES.relativeOnly && cleanRelative) binding.note = cleanRelative;
  if (mode === LOCATION_MODES.rotationOnly) {
    binding.kind = 'rotation-only';
    binding.rotationStationValid = Boolean(cleanPointId && rotationStationConfirmed === true);
  }
  return {
    mapBinding: binding,
    progress: progressNumber,
    motionState: canonicalMotionState(motionState),
    cameraRelative: {
      left: asString(cameraLeft).trim() || null,
      center: asString(cameraCenter).trim() || null,
      right: asString(cameraRight).trim() || null,
      reference: asString(cameraReference).trim() || 'camera_travel_direction'
    },
    changeFromPrevious: asString(changeFromPrevious).trim() || null,
    changeToNext: asString(changeToNext).trim() || null
  };
}

export function getFrameConfidence(frame) {
  const rawConfidence = firstDefined(frame?.confidence, frame?.evidence?.confidence, frame?.location?.confidence, 'unknown');
  const confidence = asString(typeof rawConfidence === 'object' ? firstDefined(rawConfidence?.level, rawConfidence?.value, rawConfidence?.label, 'unknown') : rawConfidence);
  return CONFIDENCE_LABELS[confidence] ? confidence : 'unknown';
}

export function getFrameEvidenceLevel(frame) {
  const locationEvidence = frame?.locationEvidence;
  const evidenceFromList = Array.isArray(locationEvidence) ? locationEvidence.find((item) => item && typeof item === 'object' ? firstDefined(item.level, item.evidenceLevel, item.type) : item) : locationEvidence;
  return canonicalEvidenceLevel(firstDefined(
    frame?.evidenceLevel,
    frame?.evidence?.level,
    frame?.metricEvidence,
    typeof evidenceFromList === 'object' ? firstDefined(evidenceFromList?.level, evidenceFromList?.evidenceLevel, evidenceFromList?.type) : evidenceFromList,
    frame?.leftRightState?.evidenceLevel,
    frame?.routeBinding?.evidenceLevel,
    'unavailable'
  ));
}

export function formatEvidenceLevel(value) {
  const key = canonicalEvidenceLevel(value);
  return EVIDENCE_LEVEL_LABELS[key] || asString(value, EVIDENCE_LEVEL_LABELS.unavailable);
}

export function formatConfidence(value) {
  return CONFIDENCE_LABELS[asString(value)] || asString(value, CONFIDENCE_LABELS.unknown);
}

export function formatLocationMode(value) {
  return LOCATION_MODE_LABELS[asString(value)] || asString(value, LOCATION_MODE_LABELS.pending);
}

export function frameHasLocationUncertainty(frame) {
  return !frameHasExactLocation(frame);
}

export function frameHasExactLocation(frame) {
  const location = getFrameLocation(frame);
  if ([LOCATION_MODES.interval, LOCATION_MODES.relativeOnly, LOCATION_MODES.pending].includes(location.mode)) return false;
  if (location.mode === LOCATION_MODES.rotationOnly) return Boolean(location.pointId && location.rotationStationValid);
  if (location.mode === LOCATION_MODES.point) return Boolean(location.pointId || location.coordinates);
  return Boolean(location.coordinates && location.pointId);
}

export function frameIsBuildable(frame) {
  const state = getFrameReviewState(frame);
  return state === KEYFRAME_REVIEW_STATES.confirmed || state === KEYFRAME_REVIEW_STATES.corrected;
}

export function reviewGateStatus(ledger) {
  const keyframes = getLedgerKeyframes(ledger);
  const confirmed = keyframes.filter(frameIsBuildable).length;
  const uncertain = keyframes.filter(frameHasLocationUncertainty).length;
  const uncertainConfirmed = keyframes.filter((frame) => frameIsBuildable(frame) && frameHasLocationUncertainty(frame)).length;
  const pending = keyframes.filter((frame) => getFrameReviewState(frame) === KEYFRAME_REVIEW_STATES.pending).length;
  const rejected = keyframes.filter((frame) => getFrameReviewState(frame) === KEYFRAME_REVIEW_STATES.rejected).length;
  // An operator may acknowledge an interval/relative frame, but that does
  // not authorize geometry mutation. Exact map points are required for the
  // final “allow modeling” gate; unresolved frames must be corrected or
  // explicitly excluded first.
  const canConfirm = keyframes.length > 0 && pending === 0 && confirmed > 0 && uncertainConfirmed === 0;
  return {
    total: keyframes.length,
    confirmed,
    uncertain,
    uncertainConfirmed,
    pending,
    rejected,
    canConfirm,
    label: canConfirm ? '可提交确认' : keyframes.length ? '仍需逐帧确认' : '尚无关键帧'
  };
}

export function getTemporaryObjects(ledger) {
  const candidate = ledger?.temporaryObjects || ledger?.reviewObjects || ledger?.temporaryLayer?.objects || ledger?.temporaryLayer;
  return Array.isArray(candidate) ? candidate : candidate && typeof candidate === 'object' ? [candidate] : [];
}

export function isTemporaryObjectVisible(object, { layerVisible = true, objectVisibility = {} } = {}) {
  const objectId = String(object?.id || object?.objectId || '').trim();
  const overrides = objectVisibility && typeof objectVisibility === 'object' ? objectVisibility : {};
  const overrideVisible = objectId && Object.prototype.hasOwnProperty.call(overrides, objectId)
    ? overrides[objectId] !== false
    : true;
  return object?.visible !== false && layerVisible !== false && overrideVisible;
}

export function getTemporaryObjectState(object) {
  const normalized = asString(firstDefined(object?.state, object?.reviewStatus, object?.status, 'review')).trim().toLowerCase().replaceAll('_', '-');
  if (['candidate', 'candidate-only', 'formal-candidate'].includes(normalized)) return 'candidate';
  if (['excluded', 'rejected', 'not-used', 'not-adopted'].includes(normalized)) return 'excluded';
  if (['pending', 'pending-confirmation', 'pending-manual-review'].includes(normalized)) return 'pending';
  return 'review';
}

export function formatTemporaryObjectState(value) {
  return TEMPORARY_OBJECT_STATE_LABELS[asString(value)] || asString(value, TEMPORARY_OBJECT_STATE_LABELS.review);
}

export function updateKeyframe(ledger, frameId, patch) {
  const id = asString(frameId);
  const source = ledger || {};
  const directKeyframes = asArray(source.keyframes || source.keyFrames || source.frames);
  if (directKeyframes.length) {
    const keyframes = directKeyframes.map((frame, index) => {
      if (getFrameId(frame, String(index + 1)) !== id) return frame;
      return { ...frame, ...patch, id: frame.id || id };
    });
    return { ...source, keyframes };
  }
  if (Array.isArray(source.videos)) {
    let found = false;
    const videos = source.videos.map((video) => {
      const keyframes = asArray(video?.frames).map((frame, index) => {
        const materialized = materializeKeyframe(frame, {
          canonicalVideoId: video.videoId,
          entityId: video.videoId,
          primaryFile: video.fileName,
          routeBinding: video.routeBinding,
          motion: video.motion,
          directionState: video.directionState,
          leftRightState: video.leftRightState,
          groups: video.groups
        }, index);
        const frameId = getFrameId(materialized, `${video.videoId || 'video'}:KF-${String(index + 1).padStart(3, '0')}`);
        if (frameId !== id) return frame;
        found = true;
        return { ...frame, ...patch, frameId: frame.frameId || frameId };
      });
      return { ...video, frames: keyframes };
    });
    if (found) return { ...source, videos };
  }
  const recordKey = Array.isArray(source.records) ? 'records' : Array.isArray(source.entities) ? 'entities' : Array.isArray(source.videoRecords) ? 'videoRecords' : null;
  if (!recordKey) return { ...source, keyframes: getLedgerKeyframes(source).map((frame, index) => getFrameId(frame, String(index + 1)) === id ? { ...frame, ...patch, id: frame.id || id } : frame) };
  let offset = 0;
  const records = source[recordKey].map((entity) => {
    const keyframes = asArray(entity?.keyframes).map((value, index) => {
      const materialized = materializeKeyframe(value, entity, index);
      const generatedId = getFrameId(materialized, `${entity?.entityId || entity?.canonicalVideoId || 'video'}:KF-${String(offset + index + 1).padStart(3, '0')}`);
      if (generatedId !== id) return value;
      // Source ledgers often store a path string. Preserve the path while
      // adding review metadata as an object instead of flattening the ledger.
      return typeof value === 'string' ? { ...materialized, ...patch, id: generatedId } : { ...value, ...patch, id: value.id || generatedId };
    });
    offset += keyframes.length;
    return { ...entity, keyframes };
  });
  return { ...source, [recordKey]: records };
}

export function normalizeKeyframeForDisplay(frame, index = 0) {
  return {
    id: getFrameId(frame, String(index + 1)),
    sourceId: getFrameSourceId(frame),
    sourceName: getFrameSourceName(frame),
    frameNumber: getFrameNumber(frame),
    timestampMs: getFrameTimestampMs(frame),
    timestampLabel: formatTimestamp(frame),
    imagePath: getFrameImagePath(frame),
    thumbnailUrl: getFrameThumbnailUrl(frame),
    location: getFrameLocation(frame),
    locationLabel: formatFrameLocation(frame),
    motion: getFrameMotion(frame),
    motionLabel: formatMotion(getFrameMotion(frame)),
    camera: getCameraRelation(frame),
    reviewState: getFrameReviewState(frame),
    reviewStateLabel: formatReviewState(getFrameReviewState(frame)),
    selectionStatus: firstDefined(frame?.selectionStatus, frame?.raw?.selectionStatus, ''),
    userConfirmation: firstDefined(frame?.userConfirmation, frame?.raw?.userConfirmation, ''),
    confidence: getFrameConfidence(frame),
    confidenceLabel: formatConfidence(getFrameConfidence(frame)),
    evidenceLevel: getFrameEvidenceLevel(frame),
    evidenceLevelLabel: formatEvidenceLevel(getFrameEvidenceLevel(frame)),
    uncertainty: frameHasLocationUncertainty(frame),
    buildable: frameIsBuildable(frame),
    raw: frame
  };
}

export function normalizeLedgerForDisplay(ledger) {
  const keyframes = getLedgerKeyframes(ledger).map(normalizeKeyframeForDisplay);
  return {
    id: asString(ledger?.id, 'unregistered-review'),
    title: asString(firstDefined(ledger?.title, ledger?.name, '移动视频关键帧确认卡')),
    status: asString(firstDefined(ledger?.status, 'analysis_pending')),
    candidateKey: asString(firstDefined(ledger?.candidateKey, ledger?.candidate_key, 'scope-direct-image-v3')),
    keyframes,
    temporaryObjects: getTemporaryObjects(ledger),
    gate: reviewGateStatus(ledger),
    raw: ledger || {}
  };
}

