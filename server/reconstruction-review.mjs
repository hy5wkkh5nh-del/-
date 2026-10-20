import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const KEYFRAME_LEDGER_SCHEMA = 'scene_keyframe_confirmation.v1';
export const LEGACY_KEYFRAME_LEDGER_SCHEMA = 'second_capture_keyframe_confirmation_ledger.v1';
const supportedKeyframeLedgerSchemas = new Set([KEYFRAME_LEDGER_SCHEMA, LEGACY_KEYFRAME_LEDGER_SCHEMA]);
export const KEYFRAME_OVERLAY_SCHEMA = 'scene_keyframe_annotation_overlay.v1';

const allowedSceneStatuses = new Set([
  'pending_location_confirmation',
  'correction_requested',
  'confirmed',
  'locked'
]);
const allowedSelectionStatuses = new Set(['unreviewed', 'pending_selection', 'adopted', 'not_adopted']);
const allowedPositionStatuses = new Set(['pending', 'pending_user_marker', 'point', 'interval', 'relative-only', 'rotation-only', 'pending_user_confirmation']);
const allowedMotionStates = new Set(['unassigned', 'unknown', 'forward', 'return', 'stop', 'rotation', 'turning']);
const allowedProgressStates = new Set(['unassigned', 'start', 'approach', 'turn_before', 'turn_during', 'turn_after', 'middle', 'end']);
const allowedConfirmationStates = new Set(['pending', 'confirmed', 'correction_requested']);
const allowedFramePatchKeys = new Set([
  'selectionStatus', 'selectionReason', 'sceneId', 'routeSegment', 'mapBinding', 'progress',
  'motionState', 'cameraRelative', 'changeFromPrevious', 'changeToNext', 'locationBasis',
  'confidence', 'modelEligibility', 'userConfirmationState', 'temporaryObjects', 'notes'
]);

function asString(value, max = 1000) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function asStringArray(value, maxItems = 40, maxLength = 240) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => asString(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function safeSceneId(value) {
  const sceneId = asString(value, 120);
  if (!sceneId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sceneId)) {
    const error = new Error('场景 ID 无效');
    error.status = 400;
    error.code = 'KEYFRAME_SCENE_ID_INVALID';
    throw error;
  }
  return sceneId;
}

function safeVideoId(value) {
  const videoId = asString(value, 180);
  if (!videoId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(videoId)) {
    const error = new Error('视频 ID 无效');
    error.status = 400;
    error.code = 'KEYFRAME_VIDEO_ID_INVALID';
    throw error;
  }
  return videoId;
}

function fail(message, code = 'KEYFRAME_LEDGER_INVALID', status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  throw error;
}

function validateMapBinding(value) {
  if (value == null) return { status: 'pending_user_marker', markerId: null, routeSegment: null, point: null, interval: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('mapBinding 必须是对象');
  const status = asString(value.status, 40) || 'pending_user_marker';
  if (!allowedPositionStatuses.has(status)) fail(`不支持的关键帧位置状态: ${status}`);
  const point = Array.isArray(value.point) ? value.point.map(Number) : null;
  if (point && (point.length !== 2 || point.some((number) => !Number.isFinite(number)))) fail('地图点必须是两个有限数值');
  const interval = value.interval && typeof value.interval === 'object' && !Array.isArray(value.interval)
    ? { start: asString(value.interval.start, 120), end: asString(value.interval.end, 120) }
    : null;
  const kind = asString(value.kind, 40) || null;
  const rotationStationValid = value.rotationStationValid === true;
  const percent = (raw, label) => {
    if (raw === undefined || raw === null || raw === '') return null;
    const number = Number(raw);
    if (!Number.isFinite(number) || number < 0 || number > 100) fail(`${label} 必须是 0–100 之间的数值`);
    return number;
  };
  const xPercent = percent(value.xPercent, '底图 X 百分比');
  const yPercent = percent(value.yPercent, '底图 Y 百分比');
  return {
    status,
    markerId: asString(value.markerId, 120) || null,
    routeSegment: asString(value.routeSegment, 180) || null,
    point,
    interval,
    note: asString(value.note, 500) || null,
    ...(kind ? { kind } : {}),
    ...(xPercent !== null ? { xPercent } : {}),
    ...(yPercent !== null ? { yPercent } : {}),
    ...(rotationStationValid ? { rotationStationValid: true } : {})
  };
}

export function validateKeyframeFramePatch(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('关键帧更新必须是对象');
  const unknown = Object.keys(patch).filter((key) => !allowedFramePatchKeys.has(key));
  if (unknown.length) fail(`关键帧更新包含禁止字段: ${unknown.join(', ')}`);
  const next = {};
  if (patch.selectionStatus != null) {
    next.selectionStatus = asString(patch.selectionStatus, 40);
    if (!allowedSelectionStatuses.has(next.selectionStatus)) fail(`不支持的关键帧选择状态: ${next.selectionStatus}`);
  }
  if (patch.selectionReason != null) next.selectionReason = asString(patch.selectionReason, 500) || null;
  if (patch.sceneId != null) next.sceneId = asString(patch.sceneId, 120) || null;
  if (patch.routeSegment != null) next.routeSegment = asString(patch.routeSegment, 180) || null;
  if (patch.mapBinding != null) next.mapBinding = validateMapBinding(patch.mapBinding);
  if (patch.progress != null) {
    const numericProgress = typeof patch.progress === 'number' ? patch.progress : Number(String(patch.progress).trim());
    if (Number.isFinite(numericProgress) && String(patch.progress).trim() !== '') {
      next.progress = numericProgress;
    } else {
      next.progress = asString(patch.progress, 40);
      if (!allowedProgressStates.has(next.progress)) fail(`不支持的路线进度: ${next.progress}`);
    }
  }
  if (patch.motionState != null) {
    next.motionState = asString(patch.motionState, 40);
    if (!allowedMotionStates.has(next.motionState)) fail(`不支持的运动状态: ${next.motionState}`);
  }
  if (patch.cameraRelative != null) {
    if (!patch.cameraRelative || typeof patch.cameraRelative !== 'object' || Array.isArray(patch.cameraRelative)) fail('cameraRelative 必须是对象');
    next.cameraRelative = {
      left: asStringArray(patch.cameraRelative.left),
      center: asStringArray(patch.cameraRelative.center),
      right: asStringArray(patch.cameraRelative.right),
      near: asStringArray(patch.cameraRelative.near),
      middle: asStringArray(patch.cameraRelative.middle),
      far: asStringArray(patch.cameraRelative.far),
      reference: asString(patch.cameraRelative.reference, 120) || null
    };
  }
  if (patch.changeFromPrevious != null) next.changeFromPrevious = asString(patch.changeFromPrevious, 1200) || null;
  if (patch.changeToNext != null) next.changeToNext = asString(patch.changeToNext, 1200) || null;
  if (patch.locationBasis != null) next.locationBasis = asStringArray(patch.locationBasis, 20, 400);
  if (patch.confidence != null) next.confidence = asString(patch.confidence, 40) || 'unreviewed';
  if (patch.modelEligibility != null) next.modelEligibility = asString(patch.modelEligibility, 80) || 'blocked_until_scene_confirmation';
  if (patch.userConfirmationState != null) {
    next.userConfirmationState = asString(patch.userConfirmationState, 40);
    if (!allowedConfirmationStates.has(next.userConfirmationState)) fail(`不支持的关键帧确认状态: ${next.userConfirmationState}`);
  }
  if (patch.temporaryObjects != null) next.temporaryObjects = asStringArray(patch.temporaryObjects, 20, 300);
  if (patch.notes != null) next.notes = asString(patch.notes, 1200) || null;
  return next;
}

function mergeFrame(base, patch) {
  const next = { ...base, ...patch };
  if (patch.mapBinding) next.mapBinding = { ...(base.mapBinding || {}), ...patch.mapBinding };
  if (patch.cameraRelative) next.cameraRelative = { ...(base.cameraRelative || {}), ...patch.cameraRelative };
  return next;
}

function finitePoint(value) {
  return Array.isArray(value) && value.length === 2 && value.every((number) => Number.isFinite(Number(number)));
}

function frameHasExactMapBinding(frame) {
  const binding = frame?.mapBinding && typeof frame.mapBinding === 'object' ? frame.mapBinding : {};
  const status = String(binding.status || frame?.positionStatus || '').trim().toLowerCase();
  if (status === 'point') return finitePoint(binding.point) || finitePoint(frame?.mapCoordinates) || Boolean(frame?.positionRef || binding.markerId);
  if (status === 'rotation-only') return Boolean((binding.markerId || frame?.positionRef) && binding.rotationStationValid === true);
  return false;
}

function sceneConfirmationGate(ledger) {
  const frames = (ledger?.videos || []).flatMap((video) => video.frames || []);
  if (!frames.length) return false;
  const adoptedCount = frames.filter((frame) => frame.selectionStatus === 'adopted').length;
  if (adoptedCount === 0) return false;
  return frames.every((frame) => {
    if (frame.selectionStatus === 'not_adopted') return true;
    return frame.selectionStatus === 'adopted' && frameHasExactMapBinding(frame);
  });
}

/**
 * Resolve the read-only base ledger plus the project-scoped review overlay.
 * Modeling callers use this instead of reading the base JSON directly, so an
 * operator correction is part of the authorization decision.
 */
export async function readSceneConfirmationLedger({ rootDir, artifactDir, projectId, sceneId }) {
  const safeId = safeSceneId(sceneId);
  const base = await readBaseLedger(rootDir, safeId);
  const overlay = await readOverlay(artifactDir, projectId, safeId);
  return mergeKeyframeLedger(base, overlay);
}

export function sceneModelingAllowed(ledger) {
  return Boolean(
    ledger
    && (ledger.status === 'confirmed' || ledger.status === 'locked')
    && sceneConfirmationGate(ledger)
  );
}

/**
 * Candidate-scene modeling must call this gate before starting a worker.
 * Legacy whole-site jobs may omit sceneId; once a sceneId is supplied, a
 * pending or partially located scene is never allowed to mutate geometry.
 */
export async function requireConfirmedScene({ rootDir, artifactDir, projectId, sceneId }) {
  const ledger = await readSceneConfirmationLedger({ rootDir, artifactDir, projectId, sceneId });
  if (!sceneModelingAllowed(ledger)) {
    fail('该场景尚未完成逐帧确认，不能开始候选建模', 'SCENE_CONFIRMATION_REQUIRED', 409);
  }
  return ledger;
}

export function mergeKeyframeLedger(base, overlay = {}) {
  if (!base || !supportedKeyframeLedgerSchemas.has(base.schema)) fail('关键帧账本 schema 不受支持', 'KEYFRAME_LEDGER_SCHEMA_UNSUPPORTED', 500);
  const frameUpdates = new Map((overlay.frameUpdates || []).map((item) => [`${item.videoId}:${item.frameNo}`, item.patch || {}]));
  const videos = (base.videos || []).map((video) => ({
    ...video,
    frames: (video.frames || []).map((frame) => {
      const patch = frameUpdates.get(`${video.videoId}:${frame.frameNo}`);
      return patch ? mergeFrame(frame, patch) : frame;
    })
  }));
  return {
    ...base,
    status: overlay.status || base.status,
    sceneNotes: overlay.sceneNotes ?? base.sceneNotes ?? '',
    updatedAt: overlay.updatedAt || base.updatedAt,
    temporaryLayer: overlay.temporaryLayer || base.temporaryLayer || { visible: true, objectVisibility: {} },
    review: {
      ...(base.review || {}),
      ...(overlay.review || {})
    },
    videos
  };
}

function pathInside(candidate, root) {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function readJson(filePath) {
  return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

async function readBaseIndex(rootDir) {
  const indexPath = path.join(rootDir, 'docs', 'evidence', 'scene-keyframe-ledgers', 'index.json');
  try { return await readJson(indexPath); } catch { return { schema: 'scene_keyframe_confirmation_index.v1', ledgers: [], counts: { scenes: 0, videos: 0, frames: 0 } }; }
}

async function readBaseLedger(rootDir, sceneId) {
  const baseDir = path.join(rootDir, 'docs', 'evidence', 'scene-keyframe-ledgers');
  const filePath = path.join(baseDir, `${sceneId}.json`);
  if (!pathInside(filePath, baseDir)) fail('关键帧账本路径无效', 'KEYFRAME_LEDGER_PATH_INVALID', 400);
  try {
    const ledger = await readJson(filePath);
    if (!supportedKeyframeLedgerSchemas.has(ledger.schema)) fail('关键帧账本 schema 无效', 'KEYFRAME_LEDGER_SCHEMA_INVALID', 500);
    return ledger;
  } catch (error) {
    if (error.code === 'ENOENT') fail('找不到该场景的关键帧账本', 'KEYFRAME_LEDGER_NOT_FOUND', 404);
    throw error;
  }
}

function overlayFile(artifactDir, projectId, sceneId) {
  return path.join(artifactDir, 'reconstruction-review', String(projectId), `${sceneId}.json`);
}

async function readOverlay(artifactDir, projectId, sceneId) {
  const filePath = overlayFile(artifactDir, projectId, sceneId);
  try { return await readJson(filePath); } catch (error) {
    if (error.code === 'ENOENT') return { schema: KEYFRAME_OVERLAY_SCHEMA, projectId, sceneId, frameUpdates: [] };
    throw error;
  }
}

async function writeOverlay(artifactDir, projectId, sceneId, overlay) {
  const filePath = overlayFile(artifactDir, projectId, sceneId);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8');
  return filePath;
}

function publicFrameSummary(ledger) {
  const videos = (ledger.videos || []).map((video) => ({
    videoId: video.videoId,
    fileName: video.fileName,
    groups: video.groups || [],
    status: video.status,
    frameCount: video.frameCount || 0,
    intervalSeconds: video.intervalSeconds ?? null,
    framesPath: video.framesPath || null,
    adoptedCount: (video.frames || []).filter((frame) => frame.selectionStatus === 'adopted').length,
    pendingCount: (video.frames || []).filter((frame) => ['unreviewed', 'pending_selection'].includes(frame.selectionStatus)).length
  }));
  return {
    sceneId: ledger.sceneId,
    captureGroup: ledger.captureGroup || null,
    title: ledger.title || ledger.sceneId,
    status: ledger.status,
    sourceStatus: ledger.sourceStatus || null,
    frameCount: videos.reduce((sum, video) => sum + video.frameCount, 0),
    adoptedCount: videos.reduce((sum, video) => sum + video.adoptedCount, 0),
    pendingCount: videos.reduce((sum, video) => sum + video.pendingCount, 0),
    videos,
    mutation: ledger.mutation || null,
    mapImagePath: ledger.mapImagePath || null,
    review: ledger.review || null
  };
}

export function registerReconstructionReviewRoutes({ app, rootDir, artifactDir, getProjectId, persist, assertProject }) {
  const resolveProjectId = () => {
    const projectId = String(getProjectId?.() || '').trim();
    if (!projectId) {
      const error = new Error('请先创建项目');
      error.status = 400;
      error.code = 'PROJECT_REQUIRED';
      throw error;
    }
    return projectId;
  };

  app.get('/api/reconstruction/keyframe-ledgers', async (_req, res) => {
    try {
      const index = await readBaseIndex(rootDir);
      const projectId = resolveProjectId();
      const summaries = [];
      const entries = Array.isArray(index.ledgers) ? index.ledgers : (Array.isArray(index.scenes) ? index.scenes : []);
      for (const item of entries) {
        const sceneId = safeSceneId(item.sceneId);
        const base = await readBaseLedger(rootDir, sceneId);
        const merged = mergeKeyframeLedger(base, await readOverlay(artifactDir, projectId, sceneId));
        summaries.push(publicFrameSummary(merged));
      }
      res.json({ ok: true, schema: index.schema, summaries, counts: { scenes: summaries.length, videos: summaries.reduce((n, item) => n + item.videos.length, 0), frames: summaries.reduce((n, item) => n + item.frameCount, 0) } });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'KEYFRAME_LEDGER_INDEX_FAILED', message: error.message } });
    }
  });

  app.get('/api/reconstruction/keyframe-ledgers/:sceneId', async (req, res) => {
    try {
      const projectId = resolveProjectId();
      const sceneId = safeSceneId(req.params.sceneId);
      const base = await readBaseLedger(rootDir, sceneId);
      const overlay = await readOverlay(artifactDir, projectId, sceneId);
      const ledger = mergeKeyframeLedger(base, overlay);
      res.json({ ok: true, ledger, overlay: { schema: overlay.schema, updatedAt: overlay.updatedAt || null } });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'KEYFRAME_LEDGER_READ_FAILED', message: error.message } });
    }
  });

  app.patch('/api/reconstruction/keyframe-ledgers/:sceneId', async (req, res) => {
    try {
      assertProject?.();
      const projectId = resolveProjectId();
      const sceneId = safeSceneId(req.params.sceneId);
      const base = await readBaseLedger(rootDir, sceneId);
      const previous = await readOverlay(artifactDir, projectId, sceneId);
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const requestedStatus = body.status == null ? undefined : asString(body.status, 60);
      if (requestedStatus !== undefined && !allowedSceneStatuses.has(requestedStatus)) fail(`不支持的场景状态: ${requestedStatus}`);
      const currentStatus = previous.status || base.status;
      if (currentStatus === 'locked' && (requestedStatus !== undefined || (Array.isArray(body.frameUpdates) && body.frameUpdates.length) || body.temporaryLayer)) {
        fail('场景已锁定，只读状态下不能继续修改', 'KEYFRAME_SCENE_LOCKED', 409);
      }
      if (requestedStatus === 'locked' && currentStatus !== 'confirmed') {
        fail('场景必须先完成 confirmed 确认，才能锁定', 'KEYFRAME_LOCK_REQUIRES_CONFIRMATION', 409);
      }
      if (body.mutation && typeof body.mutation === 'object') fail('关键帧确认接口不能修改模型、导航或 active 状态', 'KEYFRAME_MUTATION_FORBIDDEN', 409);
      const updates = Array.isArray(body.frameUpdates) ? body.frameUpdates : [];
      if (updates.length > 5000) fail('单次关键帧更新过多');
      const existing = new Map((previous.frameUpdates || []).map((item) => [`${item.videoId}:${item.frameNo}`, item]));
      const knownFrames = new Set((base.videos || []).flatMap((video) => (video.frames || []).map((frame) => `${video.videoId}:${frame.frameNo}`)));
      for (const update of updates) {
        const videoId = safeVideoId(update?.videoId);
        const frameNo = Number(update?.frameNo);
        if (!Number.isInteger(frameNo) || frameNo < 1) fail('frameNo 必须是正整数');
        const key = `${videoId}:${frameNo}`;
        if (!knownFrames.has(key)) fail(`关键帧不存在: ${key}`, 'KEYFRAME_NOT_FOUND', 404);
        const patch = validateKeyframeFramePatch(update.patch || {});
        existing.set(key, { videoId, frameNo, patch: { ...(existing.get(key)?.patch || {}), ...patch } });
      }
      const temporaryLayer = body.temporaryLayer && typeof body.temporaryLayer === 'object' && !Array.isArray(body.temporaryLayer)
        ? {
          visible: body.temporaryLayer.visible !== false,
          objectVisibility: body.temporaryLayer.objectVisibility && typeof body.temporaryLayer.objectVisibility === 'object'
            ? Object.fromEntries(Object.entries(body.temporaryLayer.objectVisibility).slice(0, 500).map(([key, value]) => [String(key).slice(0, 160), Boolean(value)]))
            : {}
        }
        : previous.temporaryLayer || { visible: true, objectVisibility: {} };
      const overlay = {
        schema: KEYFRAME_OVERLAY_SCHEMA,
        projectId,
        sceneId,
        status: requestedStatus || previous.status || base.status,
        sceneNotes: body.sceneNotes == null ? (previous.sceneNotes || '') : asString(body.sceneNotes, 3000),
        review: {
          ...(previous.review || {}),
          ...(body.review && typeof body.review === 'object' ? {
            operator: asString(body.review.operator, 120) || null,
            note: asString(body.review.note, 2000) || null,
            updatedAt: new Date().toISOString()
          } : {})
        },
        temporaryLayer,
        updatedAt: new Date().toISOString(),
        frameUpdates: [...existing.values()]
      };
      const mergedForGate = mergeKeyframeLedger(base, overlay);
      if ((requestedStatus === 'confirmed' || requestedStatus === 'locked') && !sceneConfirmationGate(mergedForGate)) {
        fail('场景仍有未采用/未精确定位的关键帧，不能确认或锁定', 'KEYFRAME_CONFIRMATION_GATE_BLOCKED', 409);
      }
      await writeOverlay(artifactDir, projectId, sceneId, overlay);
      await persist?.();
      res.json({ ok: true, ledger: mergeKeyframeLedger(base, overlay), overlay: { schema: overlay.schema, updatedAt: overlay.updatedAt } });
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'KEYFRAME_LEDGER_UPDATE_FAILED', message: error.message } });
    }
  });

  // Evidence files are read-only and are restricted to the generated keyframe
  // directory. No uploaded file or model path can be reached through this route.
  app.get('/api/reconstruction/evidence', async (req, res) => {
    try {
      const requested = asString(req.query.path, 500);
      if (!requested || requested.includes('..') || path.isAbsolute(requested)) fail('证据路径无效', 'EVIDENCE_PATH_INVALID', 400);
      const evidenceRoot = path.join(rootDir, 'docs', 'evidence');
      const filePath = path.resolve(evidenceRoot, requested);
      if (!pathInside(filePath, evidenceRoot)) fail('证据路径越界', 'EVIDENCE_PATH_INVALID', 400);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile()) return res.status(404).json({ ok: false, error: { code: 'EVIDENCE_NOT_FOUND', message: '找不到证据文件' } });
      return res.sendFile(filePath);
    } catch (error) {
      res.status(error.status || 500).json({ ok: false, error: { code: error.code || 'EVIDENCE_READ_FAILED', message: error.message } });
    }
  });
}

export { allowedSceneStatuses, allowedSelectionStatuses, allowedPositionStatuses, allowedMotionStates, allowedProgressStates, allowedConfirmationStates };

