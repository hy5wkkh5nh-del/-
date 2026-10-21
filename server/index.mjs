import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { aggregateWindows, buildHourlyScenario, buildObservationBundle, buildScenarioAnchors, computeHomographyCalibration, computeScenario, hasDeterministicKpiChange, proposalDraftJsonSchema, representativeLevel, validateProposalDraft, validateProposalGeometry } from './domain.mjs';
import { createLlmClient } from './llm-client.mjs';
import { convertDwgToExtrusion, convertDwgToPlan, convertSkpToGlb } from './cad-converter.mjs';
import { sceneObjectsForReasoning, sceneObjectsForWorkspace } from './scene-object-view.mjs';
import { createKeyedLockRegistry } from './keyed-lock.mjs';
import { registerReconstructionReviewRoutes, requireConfirmedScene } from './reconstruction-review.mjs';
import { buildTransportPlan, normalizeTransportReview, simulateTransportPlan } from './transport-plan.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1';
const uploadDir = path.resolve(rootDir, process.env.UPLOAD_DIR || './data/uploads');
const storeFile = path.resolve(rootDir, process.env.STORE_FILE || './data/store.json');
const artifactDir = path.resolve(rootDir, process.env.ARTIFACT_DIR || './data/artifacts');
const blenderBin = String(process.env.BLENDER_BIN || 'blender').trim() || 'blender';
const llmBaseUrl = String(process.env.LLM_BASE_URL || 'https://testvideo.site/v1').replace(/\/$/, '');
const llmDirectBaseUrl = String(process.env.LLM_DIRECT_BASE_URL || 'https://hk.testvideo.site/v1').replace(/\/$/, '');
const llmModel = String(process.env.LLM_MODEL || 'gpt-5.6-sol');
const llmApiKey = String(process.env.LLM_API_KEY || '').trim();
const configuredLlmTimeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS || 120_000);
const llmRequestTimeoutMs = Number.isFinite(configuredLlmTimeoutMs) && configuredLlmTimeoutMs >= 10_000 && configuredLlmTimeoutMs <= 300_000 ? configuredLlmTimeoutMs : 120_000;
const llmClient = createLlmClient({ primaryBaseUrl: llmBaseUrl, directBaseUrl: llmDirectBaseUrl, model: llmModel, apiKey: llmApiKey, timeoutMs: llmRequestTimeoutMs });
const exportLocks = createKeyedLockRegistry();
const proposalOutputSchema = proposalDraftJsonSchema();
const groundingDinoModel = String(process.env.GROUNDING_DINO_MODEL || '').trim();
const sam2Model = String(process.env.SAM2_MODEL || '').trim();
const allowRemoteModelDownloads = process.env.ALLOW_REMOTE_MODEL_DOWNLOADS === 'true';
const corsOrigins = String(process.env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
const rtspAllowedHosts = new Set(String(process.env.RTSP_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
const windows1252Bytes = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e],
  [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]
]);

function decodeMojibakePass(value) {
  const bytes = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0xff) bytes.push(codePoint);
    else if (windows1252Bytes.has(codePoint)) bytes.push(windows1252Bytes.get(codePoint));
    else return null;
  }
  return Buffer.from(bytes).toString('utf8');
}

function repairUtf8Mojibake(value) {
  const original = String(value || '');
  return original.replace(/[\u0080-\u02ff\u2000-\u21ff]{2,}/g, (run) => {
    let candidate = run;
    for (let pass = 0; pass < 3; pass += 1) {
    const decoded = decodeMojibakePass(candidate);
    if (!decoded || decoded === candidate || decoded.includes('\uFFFD')) break;
    candidate = decoded;
    if (/[\u3400-\u9fff]/.test(candidate)) return candidate;
    }
    return run;
  });
}

const likelyTestAssetName = /(?:yolox|dog[-_\s]?public[-_\s]?example|virtual|synthetic|test[-_\s]?only|not[-_\s]?observed|dummy|sample)/i;

function isLikelyTestAsset(asset) {
  return Boolean(
    asset?.testOnly
    || asset?.sourceNature === 'virtual_test'
    || likelyTestAssetName.test(String(asset?.name || ''))
  );
}

// The field-video scope migration keeps every original file for traceability,
// but marks videos that were found in the directory without project identity.
// They must never enter the current project's route, camera, or field-evidence
// selectors.  New uploads without a scope tag remain eligible until the
// operator explicitly classifies them.
function videoEvidenceMeta(asset) {
  return asset?.metadata?.videoEvidence && typeof asset.metadata.videoEvidence === 'object'
    ? asset.metadata.videoEvidence
    : null;
}

function isExcludedProjectVideo(asset) {
  return asset?.type === 'video' && videoEvidenceMeta(asset)?.status === 'excluded_unconfirmed';
}

function isHiddenVideoAlias(asset) {
  return asset?.type === 'video' && videoEvidenceMeta(asset)?.hiddenByDefault === true;
}

function isProjectFieldVideo(asset) {
  return asset?.type === 'video'
    && !isLikelyTestAsset(asset)
    && !isExcludedProjectVideo(asset)
    && !isHiddenVideoAlias(asset);
}

function isVideoRouteGenerationBlocked(project = store.project) {
  return ['scope_locked_pending_motion_reanchor', 'motion_evidence_complete_pending_navigation_reanchor']
    .includes(project?.videoEvidenceRegistry?.status);
}

async function enforceSceneModelingGate(body = {}) {
  const sceneId = String(body?.sceneId || '').trim();
  const sceneScoped = Boolean(sceneId || body?.candidateLayer === true || body?.candidateKey === 'scope-direct-image-v3');
  if (!sceneScoped) return null;
  if (!sceneId) {
    const error = new Error('候选场景建模必须提供 sceneId');
    error.status = 400;
    error.code = 'SCENE_ID_REQUIRED';
    throw error;
  }
  await requireConfirmedScene({
    rootDir,
    artifactDir,
    projectId: store.activeProjectId,
    sceneId
  });
  return sceneId;
}

function inferredSourceNature(asset, requested) {
  if (requested === 'virtual_test' || requested === 'field_observation') return requested;
  return isLikelyTestAsset(asset) ? 'virtual_test' : 'field_observation';
}

await fsp.mkdir(uploadDir, { recursive: true });
await fsp.mkdir(artifactDir, { recursive: true });
await fsp.mkdir(path.dirname(storeFile), { recursive: true });

const emptyStore = {
  projects: [],
  activeProjectId: null,
  project: null,
  assets: [],
  videoWindows: [],
  jobs: [],
  jobEvents: [],
  observations: [],
  proposals: [],
  artifacts: [],
  reviews: [],
  sceneObjects: [],
  semanticCandidates: [],
  settings: {
    timeSlots: [
      { id: 'weekday_arrival', label: '工作日上班到达', start: '07:30', end: '09:30', condition: 'normal_weekday' },
      { id: 'midday_visitor', label: '午间 / 来宾到达', start: '11:30', end: '13:30', condition: 'normal_weekday' },
      { id: 'hotel_logistics', label: '酒店后勤作业', start: '09:30', end: '11:00', condition: 'normal_weekday' },
      { id: 'weekday_departure', label: '工作日下班离场', start: '17:00', end: '19:30', condition: 'normal_weekday' },
      { id: 'night_lighting', label: '夜间照明 / 低峰', start: '21:00', end: '23:00', condition: 'normal_weekday' }
    ]
  }
};

async function readHostedStoreParts() {
  const dataDir = path.join(rootDir, 'data');
  const names = (await fsp.readdir(dataDir).catch(() => []))
    .filter((name) => /^store-slim\\.part\\d+\\.json$/.test(name))
    .sort();
  if (!names.length) return null;
  const raw = (await Promise.all(names.map((name) => fsp.readFile(path.join(dataDir, name), 'utf8')))).map((chunk) => chunk.replace(/\r?\n$/, '')).join('');
  return JSON.parse(raw);
}

async function readStore() {
  const hosted = await readHostedStoreParts();
  if (hosted) return { ...emptyStore, ...hosted };
  try {
    const raw = await fsp.readFile(storeFile, 'utf8');
    return { ...emptyStore, ...JSON.parse(raw) };
  } catch {
    return structuredClone(emptyStore);
  }
}

let store = await readStore();
const collectionKeys = ['projects', 'assets', 'videoWindows', 'jobs', 'jobEvents', 'observations', 'proposals', 'artifacts', 'reviews', 'sceneObjects', 'semanticCandidates'];
for (const key of collectionKeys) store[key] = Array.isArray(store[key]) ? store[key] : [];
let storeMigrated = false;
if (store.project && !store.projects.some((project) => project.id === store.project.id)) {
  store.projects.push(store.project);
  storeMigrated = true;
}
if (!store.activeProjectId && store.project?.id) {
  store.activeProjectId = store.project.id;
  storeMigrated = true;
}
if (store.activeProjectId && !store.projects.some((project) => project.id === store.activeProjectId && project.status !== 'archived')) {
  store.activeProjectId = store.projects.find((project) => project.status !== 'archived')?.id || null;
  storeMigrated = true;
}
store.project = store.projects.find((project) => project.id === store.activeProjectId) || null;
const legacyProjectId = store.project?.id || store.projects[0]?.id || null;
for (const key of ['assets', 'videoWindows', 'jobs', 'observations', 'proposals', 'artifacts', 'sceneObjects', 'semanticCandidates']) {
  for (const record of store[key]) {
    if (!record.projectId && legacyProjectId) {
      record.projectId = legacyProjectId;
      storeMigrated = true;
    }
  }
}
for (const asset of store.assets) {
  const repairedName = repairUtf8Mojibake(asset.name);
  if (repairedName !== asset.name) {
    asset.name = repairedName;
    storeMigrated = true;
  }
  // Older imports did not persist evidence provenance.  Backfill the known
  // demo/test samples now so they cannot enter a field reconstruction by
  // accident after a restart or context refresh.
  const inferredNature = inferredSourceNature(asset);
  const inferredTestOnly = inferredNature === 'virtual_test';
  const inferredEvidenceLevel = inferredTestOnly ? 'Scenario' : (asset.evidenceLevel || 'Observed');
  if (asset.sourceNature !== inferredNature || Boolean(asset.testOnly) !== inferredTestOnly || asset.evidenceLevel !== inferredEvidenceLevel) {
    Object.assign(asset, { sourceNature: inferredNature, testOnly: inferredTestOnly, evidenceLevel: inferredEvidenceLevel });
    storeMigrated = true;
  }
}
for (const artifact of store.artifacts) {
  const repairedTitle = repairUtf8Mojibake(artifact.title);
  const repairedSourceName = repairUtf8Mojibake(artifact.metadata?.sourceAssetName);
  if (repairedTitle !== artifact.title) {
    artifact.title = repairedTitle;
    storeMigrated = true;
  }
  if (artifact.metadata?.sourceAssetName && repairedSourceName !== artifact.metadata.sourceAssetName) {
    artifact.metadata.sourceAssetName = repairedSourceName;
    storeMigrated = true;
  }
}
// Backfill the latest non-stale site corridor into the project registration.
// Older corridor jobs were created before siteContextArtifactId was persisted,
// and failed/replaced jobs can leave the old ID pointing at a stale or deleted
// artifact.  A refresh must repair both cases without inventing an ID.
for (const projectRecord of store.projects) {
  const registration = projectRecord.modelRegistration;
  if (!registration) continue;
  const registeredSiteContext = store.artifacts.find((artifact) =>
    artifact.id === registration.siteContextArtifactId
    && artifact.projectId === projectRecord.id
    && artifact.kind === 'site_context_glb'
    && artifact.metadata?.stale !== true
  );
  if (registeredSiteContext) continue;
  const currentSiteContext = [...store.artifacts].reverse().find((artifact) =>
    artifact.projectId === projectRecord.id
    && artifact.kind === 'site_context_glb'
    && artifact.metadata?.stale !== true
  );
  const registeredBuilding = store.artifacts.find((artifact) =>
    artifact.id === registration.modelArtifactId
    && artifact.projectId === projectRecord.id
    && artifact.metadata?.stale !== true
  );
  const linkedBuildingId = currentSiteContext?.metadata?.mainBuildingArtifactId;
  if (!currentSiteContext || (linkedBuildingId && registeredBuilding && linkedBuildingId !== registeredBuilding.id)) continue;
  registration.siteContextArtifactId = currentSiteContext.id;
  projectRecord.updatedAt = new Date().toISOString();
  storeMigrated = true;
}
let writeQueue = Promise.resolve();
function persist() {
  writeQueue = writeQueue.then(() => fsp.writeFile(storeFile, JSON.stringify(store, null, 2), 'utf8'));
  return writeQueue;
}
if (storeMigrated) await persist();

function setActiveProject(projectId) {
  store.activeProjectId = projectId || null;
  store.project = store.projects.find((project) => project.id === store.activeProjectId) || null;
  return store.project;
}

function recordsForProject(records, projectId = store.activeProjectId) {
  return projectId ? records.filter((record) => record.projectId === projectId) : [];
}

function projectForJob(job) {
  const project = store.projects.find((item) => item.id === job.projectId);
  if (!project) throw new Error(`任务 ${job.id} 对应的项目不存在`);
  return structuredClone(project);
}

function projectCounts(projectId) {
  return {
    assets: recordsForProject(store.assets, projectId).length,
    jobs: recordsForProject(store.jobs, projectId).length,
    observations: recordsForProject(store.observations, projectId).length,
    proposals: recordsForProject(store.proposals, projectId).length,
    artifacts: recordsForProject(store.artifacts, projectId).length
  };
}

function geoAnchorHash(project) {
  return crypto.createHash('sha256').update(JSON.stringify({
    latitude: Number(project?.latitude),
    longitude: Number(project?.longitude),
    coordinateSystem: project?.coordinateSystem || 'WGS84'
  })).digest('hex');
}

function classifyCurrentSiteDetailCounts(detailCounts = {}) {
  const historicalConstructionKeys = new Set(['construction_fence', 'construction_frame', 'tower_crane', 'construction_site']);
  const currentState = {};
  const historicalConstruction = {};
  for (const [key, value] of Object.entries(detailCounts || {})) {
    if (historicalConstructionKeys.has(key)) historicalConstruction[key] = Number(value) || 0;
    else currentState[key] = Number(value) || 0;
  }
  return { currentState, historicalConstruction };
}

// Keep the conflict boundary explicit when supplemental photographs and
// published articles are linked to an existing corridor model.  These records
// are evidence status, not geometry edits: the photographs have no camera
// poses/control points and the articles are not site measurements.
function referenceConflictRecords() {
  return [
    {
      id: 'facade_material_palette',
      severity: 'medium',
      status: 'needs_material_review',
      statement: '补充现场照片显示深色连续玻璃、白色水平带、橙褐色砖墙和弧形转角；当前 Blender 工作台预览仍可能显示为中性灰。',
      evidence: 'field_images_observed',
      allowedAction: '仅校核网页原始材质与材质清单；不据此改绝对几何。'
    },
    {
      id: 'construction_history_vs_current',
      severity: 'high',
      status: 'resolved_by_visibility_policy',
      statement: '旧模型包含施工围挡、塔吊和临时框架，而补充资料反映当前无施工。',
      evidence: 'field_images_observed_plus_existing_history_objects',
      allowedAction: '现状默认隐藏，专家模式仅回看历史证据。'
    },
    {
      id: 'metric_geometry_control',
      severity: 'high',
      status: 'open_data_gap',
      statement: '补充照片没有相机姿态、控制点或可验证距离，不能单独修正道路线位、建筑朝向或护栏绝对位置。',
      evidence: 'field_images_without_control_points',
      allowedAction: '保留当前近似配准；需要现场控制点/带移动位姿影像后才能升级。'
    },
    {
      id: 'article_reference_boundary',
      severity: 'medium',
      status: 'reference_only',
      statement: '微信文章中的改造历史、光伏、绿色屋顶和设计意图属于背景参考，不能直接变成现场实测构件。',
      evidence: 'wechat_articles_reference',
      allowedAction: '保留为 Reference；与现场照片冲突时以现场照片为准。'
    }
  ];
}

function correctedReferenceConflictRecords(records = referenceConflictRecords()) {
  return (Array.isArray(records) ? records : []).map((item) => {
    if (item.id === 'facade_material_palette') {
      return {
        ...item,
        status: 'resolved_by_reference_correction',
        statement: '已按现场图片校准深色连续玻璃、白色水平带、橙褐色砖墙和弧形转角的显示材质；PBR反射率仍属于 Hypothesis。',
        allowedAction: '如有现场材质扫描，可继续调整反射率，不再改变空间几何。'
      };
    }
    if (item.id === 'metric_geometry_control') {
      return {
        ...item,
        status: 'operator_approved_approximate',
        statement: '道路、护栏和建筑朝向已按现有视频顺序、全景拓扑和地图参考完成近似配准；当前成果不宣称测绘级。',
        allowedAction: '如需测绘级精度再补控制点；当前结果可用于展示和方案讨论。'
      };
    }
    if (item.id === 'article_reference_boundary') {
      return {
        ...item,
        status: 'reference_only',
        statement: '微信文章已作为光伏、绿化屋顶、改造历史和材料关系的 Reference 加入当前模型，不作为现场实测构件。',
        allowedAction: '与现场照片冲突时以现场照片为准；Reference 不参与实测流量和合规结论。'
      };
    }
    return item;
  });
}

function supplementalReferenceMetadata(manifest, manifestId) {
  if (!manifest || typeof manifest !== 'object') return {};
  return {
    supplementalReferenceManifestId: manifestId || null,
    supplementalReferenceAssetIds: Array.isArray(manifest.sourceAssetIds) ? manifest.sourceAssetIds : [],
    supplementalReferenceImageCount: Array.isArray(manifest.imageSources) ? manifest.imageSources.length : 0,
    supplementalReferenceArticleCount: Array.isArray(manifest.articleSources) ? manifest.articleSources.length : 0,
    supplementalReferenceState: 'reference_bound_geometry_unchanged',
    supplementalReferencePolicy: '补充图片用于材质、外观和语义关系校核；未提供控制点时不改绝对线位。',
    supplementalReferenceConflicts: correctedReferenceConflictRecords(),
    supplementalMaterialTargets: [
      'main_building_dark_glazing',
      'main_building_white_horizontal_bands',
      'main_building_orange_brick_ground_wall',
      'main_building_rounded_glass_corner',
      'continuous_asphalt_lane_and_concrete_curb',
      'lawn_hedge_tree_and_street_lamp_context'
    ]
  };
}

// Backfill the present-day / historical construction split for artifacts made
// before the current-state display policy existed.  This keeps existing
// projects truthful after refresh without replacing their source GLB.
for (const artifact of store.artifacts) {
  if (!['site_context_glb', 'site_detail_manifest', 'site_corridor_manifest'].includes(artifact.kind)) continue;
  if (artifact.metadata?.currentStateDetailCounts || !artifact.metadata?.detailCounts) continue;
  const split = classifyCurrentSiteDetailCounts(artifact.metadata.detailCounts);
  artifact.metadata = {
    ...(artifact.metadata || {}),
    currentStateDetailCounts: split.currentState,
    historicalConstructionDetailCounts: split.historicalConstruction,
    currentStatePolicy: '施工围挡、塔吊、临时框架只保留为历史证据；现状展示默认隐藏，不参与现状空间分析。'
  };
  storeMigrated = true;
}

// Keep the visible evidence panel aligned with the current material policy.
// Older corridor artifacts recorded the pre-texture-review conflict status;
// they remain valid assets, but their status must not claim that the new
// photographic material pass is still pending.
for (const artifact of store.artifacts) {
  if (!Array.isArray(artifact.metadata?.supplementalReferenceConflicts)) continue;
  const corrected = correctedReferenceConflictRecords(artifact.metadata.supplementalReferenceConflicts);
  if (JSON.stringify(corrected) !== JSON.stringify(artifact.metadata.supplementalReferenceConflicts)) {
    artifact.metadata.supplementalReferenceConflicts = corrected;
    storeMigrated = true;
  }
}

// Link the newest supplemental reference manifest to the current site model
// without replacing its GLB.  This makes the evidence relationship survive a
// refresh and prevents a later reconstruction from silently dropping it.
for (const projectRecord of store.projects) {
  const manifestArtifact = [...store.artifacts].reverse().find((artifact) =>
    artifact.projectId === projectRecord.id
    && artifact.kind === 'reference_source_manifest'
    && artifact.metadata?.stale !== true
  );
  if (!manifestArtifact || !manifestArtifact.storedPath || !fs.existsSync(manifestArtifact.storedPath)) continue;
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(manifestArtifact.storedPath, 'utf8')); } catch { continue; }
  const linkedMetadata = supplementalReferenceMetadata(manifest, manifestArtifact.id);
  const targetArtifacts = [...store.artifacts].reverse().filter((artifact) =>
    artifact.projectId === projectRecord.id
    && ['site_context_glb', 'site_detail_manifest', 'site_corridor_manifest'].includes(artifact.kind)
    && artifact.metadata?.stale !== true
  );
  for (const artifact of targetArtifacts) {
    const currentSignature = JSON.stringify({
      id: artifact.metadata?.supplementalReferenceManifestId,
      images: artifact.metadata?.supplementalReferenceImageCount,
      articles: artifact.metadata?.supplementalReferenceArticleCount,
      state: artifact.metadata?.supplementalReferenceState
    });
    const nextSignature = JSON.stringify({
      id: linkedMetadata.supplementalReferenceManifestId,
      images: linkedMetadata.supplementalReferenceImageCount,
      articles: linkedMetadata.supplementalReferenceArticleCount,
      state: linkedMetadata.supplementalReferenceState
    });
    if (currentSignature === nextSignature) continue;
    const preserveCorrectionBoundary = artifact.metadata?.referenceCorrectionStatus === 'operator_approved_approximate';
    artifact.metadata = {
      ...(artifact.metadata || {}),
      ...linkedMetadata,
      ...(preserveCorrectionBoundary ? {
        supplementalReferenceState: 'reference_bound_operator_approved_approximate',
        supplementalReferenceConflicts: correctedReferenceConflictRecords(artifact.metadata?.supplementalReferenceConflicts || linkedMetadata.supplementalReferenceConflicts)
      } : {})
    };
    storeMigrated = true;
  }
}

const siteCorridorArtifactKinds = new Set([
  'site_context_glb', 'site_context_source_glb', 'site_context_blend', 'site_context_blender_preview', 'site_context_blender_manifest',
  'site_route_geojson', 'site_camera_track_json', 'site_keyframes_manifest',
  'site_keyframes_zip', 'site_boundary_registration', 'site_material_manifest',
  'site_detail_manifest', 'site_field_evidence_manifest', 'site_panorama_sampling_manifest', 'site_registration_manifest', 'site_capture_station_register', 'site_corridor_preview', 'site_corridor_manifest'
  , 'site_master_ledger', 'site_verification_report'
]);
const geographicArtifactKinds = new Set([
  'osm_context_glb', 'osm_context_geojson', 'osm_scene_objects', 'osm_context_manifest', 'terrain_dem_geotiff',
  ...siteCorridorArtifactKinds
]);

function markGeographicContextStale(projectId, reason = 'project_anchor_changed') {
  const staleAt = new Date().toISOString();
  const affectedArtifactIds = new Set();
  for (const artifact of store.artifacts) {
    if (artifact.projectId !== projectId || !geographicArtifactKinds.has(artifact.kind)) continue;
    artifact.metadata = { ...(artifact.metadata || {}), stale: true, staleReason: reason, staleAt };
    affectedArtifactIds.add(artifact.id);
  }
  for (const object of store.sceneObjects) {
    if (object.projectId !== projectId) continue;
    if (object.properties?.source === 'OpenStreetMap' || affectedArtifactIds.has(object.properties?.sourceArtifactId)) {
      object.properties = { ...(object.properties || {}), stale: true, staleReason: reason, staleAt };
      object.updatedAt = staleAt;
    }
  }
  for (const job of store.jobs) {
    if (job.projectId === projectId && job.type === 'geographic_context' && job.status === 'succeeded') {
      job.stale = true;
      job.staleReason = reason;
    }
  }
}

function markGeographicBatchStale(projectId, jobId, reason) {
  const staleAt = new Date().toISOString();
  const affectedArtifactIds = new Set();
  for (const artifact of store.artifacts) {
    if (artifact.projectId !== projectId || artifact.jobId !== jobId || !geographicArtifactKinds.has(artifact.kind)) continue;
    artifact.metadata = { ...(artifact.metadata || {}), stale: true, staleReason: reason, staleAt };
    affectedArtifactIds.add(artifact.id);
  }
  for (const object of store.sceneObjects) {
    if (object.projectId !== projectId || !affectedArtifactIds.has(object.properties?.sourceArtifactId)) continue;
    object.properties = { ...(object.properties || {}), stale: true, staleReason: reason, staleAt };
    object.updatedAt = staleAt;
  }
  const job = store.jobs.find((item) => item.id === jobId && item.projectId === projectId);
  if (job) {
    job.stale = true;
    job.staleReason = reason;
  }
  return affectedArtifactIds.size > 0;
}

function reconcileGeographicStaleness() {
  let changed = false;
  for (const project of store.projects) {
    const groups = new Map();
    for (const artifact of store.artifacts) {
      if (artifact.projectId !== project.id || !geographicArtifactKinds.has(artifact.kind)) continue;
      const batchId = artifact.jobId || artifact.id;
      const group = groups.get(batchId) || [];
      group.push(artifact);
      groups.set(batchId, group);
    }
    for (const [batchId, artifacts] of groups) {
      const recordedHash = artifacts.find((artifact) => artifact.metadata?.anchorHash)?.metadata?.anchorHash;
      const origin = artifacts.find((artifact) => Number.isFinite(Number(artifact.metadata?.origin?.latitude)) && Number.isFinite(Number(artifact.metadata?.origin?.longitude)))?.metadata?.origin;
      const mismatch = recordedHash
        ? recordedHash !== geoAnchorHash(project)
        : origin
          ? Math.abs(Number(origin.latitude) - Number(project.latitude)) > 1e-7 || Math.abs(Number(origin.longitude) - Number(project.longitude)) > 1e-7
          : false;
      if (mismatch && artifacts.some((artifact) => artifact.metadata?.stale !== true)) {
        changed = markGeographicBatchStale(project.id, batchId, 'stored_anchor_mismatch') || changed;
      }
    }
  }
  return changed;
}

function geographicContextStatus(project = store.project) {
  if (!project) return { available: false, stale: false };
  const artifacts = recordsForProject(store.artifacts, project.id).filter((artifact) => geographicArtifactKinds.has(artifact.kind));
  if (!artifacts.length) return { available: false, stale: false, requiredAnchorHash: geoAnchorHash(project) };
  const current = artifacts.filter((artifact) => artifact.metadata?.stale !== true && artifact.metadata?.anchorHash === geoAnchorHash(project));
  if (current.length) return { available: true, stale: false, anchorHash: geoAnchorHash(project), generatedAt: current.map((artifact) => artifact.createdAt).filter(Boolean).sort().at(-1) || null };
  return { available: false, stale: true, requiredAnchorHash: geoAnchorHash(project), staleArtifactCount: artifacts.filter((artifact) => artifact.metadata?.stale === true).length || artifacts.length };
}

function reconcileInterruptedJobs() {
  let changed = false;
  const interruptedAt = new Date().toISOString();
  for (const job of store.jobs) {
    if (!['queued', 'running'].includes(job.status)) continue;
    job.status = 'failed';
    job.stage = 'interrupted';
    job.error = '服务在任务执行期间重启，该任务未自动恢复，请重新启动';
    job.finishedAt = interruptedAt;
    const previousSequence = store.jobEvents.filter((event) => event.jobId === job.id).at(-1)?.sequence || 0;
    store.jobEvents.push({
      id: id('event'),
      jobId: job.id,
      sequence: previousSequence + 1,
      type: 'job.failed',
      at: interruptedAt,
      payload: { error: job.error, reason: 'server_restart' }
    });
    changed = true;
  }
  return changed;
}

const geographicStateChanged = reconcileGeographicStaleness();
const interruptedJobsChanged = reconcileInterruptedJobs();
if (geographicStateChanged || interruptedJobsChanged) await persist();

function emitJobEvent(jobId, type, payload = {}) {
  const previous = store.jobEvents.filter((event) => event.jobId === jobId).at(-1);
  const event = {
    id: id('event'), jobId, sequence: (previous?.sequence || 0) + 1,
    type, at: new Date().toISOString(), payload
  };
  store.jobEvents.push(event);
  if (store.jobEvents.length > 5000) store.jobEvents = store.jobEvents.slice(-5000);
  persist();
  const listeners = eventListeners.get(jobId);
  if (listeners) for (const response of listeners) sendSse(response, event);
  return event;
}

const eventListeners = new Map();
function sendSse(response, event) {
  response.write(`id: ${event.sequence}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function commandAvailable(command) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return readableFileAvailable(path.resolve(rootDir, command));
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  const result = spawnSync(probe, [command], { encoding: 'utf8', windowsHide: true, env });
  return result.status === 0;
}

function commandAvailableAsync(command) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return Promise.resolve(readableFileAvailable(path.resolve(rootDir, command)));
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(available);
    };
    const child = spawn(probe, [command], { windowsHide: true, env, stdio: 'ignore' });
    const timeout = setTimeout(() => {
      child.kill();
      finish(false);
    }, 5000);
    timeout.unref();
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

function readableFileAvailable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pythonCommand() {
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

function pythonModulesAvailable(modules) {
  const script = `import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(name) for name in ${JSON.stringify(modules)}) else 1)`;
  const env = { ...process.env };
  delete env.LLM_API_KEY;
  const result = spawnSync(pythonCommand(), ['-c', script], { encoding: 'utf8', windowsHide: true, env });
  return result.status === 0;
}

const semanticPythonRuntimeReady = commandAvailable(pythonCommand()) && pythonModulesAvailable(['torch', 'torchvision', 'transformers', 'PIL', 'cv2']);

function modelReferenceStatus(reference, label) {
  if (!reference) return { configured: false, available: false, source: 'unconfigured', label };
  const remote = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(reference) && !path.isAbsolute(reference) && !reference.startsWith('.');
  if (remote) {
    return {
      configured: true,
      available: allowRemoteModelDownloads,
      source: 'remote_repository',
      model: reference,
      label,
      note: allowRemoteModelDownloads ? '允许运行时下载；实际可用性由任务验证' : '远程模型下载未启用'
    };
  }
  const resolved = path.resolve(rootDir, reference);
  let available = false;
  try { available = fs.statSync(resolved).isDirectory() || fs.statSync(resolved).isFile(); } catch { available = false; }
  return { configured: true, available, source: 'local', model: path.basename(resolved), label };
}

function semanticRuntimeStatus() {
  const groundingDino = modelReferenceStatus(groundingDinoModel, 'Grounding DINO');
  const sam2 = modelReferenceStatus(sam2Model, 'SAM 2');
  groundingDino.runtimeReady = semanticPythonRuntimeReady;
  sam2.runtimeReady = semanticPythonRuntimeReady;
  groundingDino.available = groundingDino.available && semanticPythonRuntimeReady;
  sam2.available = sam2.available && semanticPythonRuntimeReady;
  return { groundingDino, sam2 };
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { env: optionEnv, ...spawnOptions } = options;
    const childEnv = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(optionEnv || {})
    };
    delete childEnv.LLM_API_KEY;
    const child = spawn(command, args, {
      cwd: rootDir,
      windowsHide: true,
      ...spawnOptions,
      env: childEnv
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function lastJsonLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean).reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch { /* keep scanning */ }
  }
  return null;
}

async function addArtifact({ projectId, jobId, kind, title, storedPath, evidenceLevel, metadata = {} }) {
  const artifact = {
    id: id('artifact'), projectId, jobId, kind, title,
    storedPath,
    sha256: await sha256(storedPath), size: (await fsp.stat(storedPath)).size,
    evidenceLevel, metadata, createdAt: new Date().toISOString()
  };
  artifact.url = `/api/artifacts/${artifact.id}/content`;
  store.artifacts.push(artifact);
  return artifact;
}

// Keep operator-review candidates visible in the real workspace without
// changing the registered active site model.  This is intentionally a small
// startup migration: the candidate files already live inside ARTIFACT_DIR,
// and the records are only added once by candidateKey.
async function ensureDirectImageCandidateArtifacts() {
  const projectId = store.activeProjectId;
  if (!projectId) return false;
  const candidateDir = path.join(artifactDir, 'job_049e9022a808-scope-direct-image-v3');
  const files = {
    combined: path.join(candidateDir, 'scope-direct-image-v3-candidate.glb'),
    surrounding: path.join(candidateDir, 'scope-direct-image-v3-surrounding.glb'),
    g3: path.join(candidateDir, 'scope-direct-image-v3-g3-candidate.glb'),
    g3v3: path.join(candidateDir, 'scope-direct-image-v3-g3-v3-candidate.glb'),
    b1Filled: path.join(candidateDir, 'scope-direct-image-v3-b1-filled-candidate.glb'),
    b1CLocal: path.join(candidateDir, 'scope-direct-image-v3-b1-c-local-v1-candidate.glb'),
    b1CLocalManifest: path.join(candidateDir, 'scope-direct-image-v3-b1-c-local-v1-manifest.json'),
    manifest: path.join(candidateDir, 'scope-direct-image-v3-manifest.json'),
    map: path.join(candidateDir, 'viewer', 'v3-map-1to1.png'),
    annotatedMap: path.join(candidateDir, 'operator-annotated-map.jpg')
  };
  const required = [files.combined, files.surrounding, files.manifest, files.map, files.annotatedMap];
  if (!(await Promise.all(required.map(async (filePath) => {
    try { await fsp.access(filePath, fs.constants.R_OK); return true; } catch { return false; }
  }))).every(Boolean)) return false;
  let manifest = {};
  try { manifest = JSON.parse(await fsp.readFile(files.manifest, 'utf8')); } catch { return false; }
  const baseMetadata = {
    candidateOnly: true,
    candidateKey: 'scope-direct-image-v3',
    candidateVersion: 'scope-direct-image.v3',
    operatorAcceptance: 'pending',
    activeArtifactModified: false,
    sourceAssetsModified: false,
    semantics: manifest.semantics || { green: 'review_scope_only', black: 'building_footprint', blue: 'road_occupancy' },
    sourceManifest: path.relative(artifactDir, files.manifest).replaceAll('\\', '/'),
    mapImageMode: 'original_1to1',
    mainBuildingMaterialsPreserved: true,
    surroundingBuildingCount: Number(manifest.surroundingBuildings?.count || 3),
    roadSkeletonCount: Number(manifest.roads?.count || 1),
    proxyHeightM: Number(manifest.proxyHeightM || 28.85),
    reviewNote: '候选范围模型：主楼完整 SKP 状态 + 原图黑色建筑轮廓 + 原图蓝色道路像素网络；只供网页复查，不替换 active。'
  };
  const records = [
    { key: 'combined', kind: 'site_direct_image_candidate_glb', title: '候选范围 v3 · 主楼 + 周边建筑 + 小道', file: files.combined, evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, viewRole: 'combined' } },
    ...(await fsp.access(files.b1Filled, fs.constants.R_OK).then(() => [{ key: 'b1-filled', kind: 'site_direct_image_candidate_glb', title: '候选范围 v3 · B1 实体填充', file: files.b1Filled, evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, candidateKey: 'scope-direct-image-v3-b1-filled', candidateVersion: 'scope-direct-image.v3-b1-filled', viewRole: 'b1_filled_candidate', sourceCandidate: 'scope-direct-image-v3-candidate.glb', patchAudit: 'scope-direct-image-v3-b1-filled-audit.json', reviewNote: '仅填充北侧 B1 模拟建筑内部，外轮廓、位置、高度及其他节点保持不变。' } }]).catch(() => [])),
    ...(await Promise.all([files.b1CLocal, files.b1CLocalManifest].map((file) => fsp.access(file, fs.constants.R_OK))).then(() => [{
      key: 'b1-c-local-v1',
      kind: 'site_direct_image_candidate_glb',
      title: '候选范围 v3 · B1/C夹道局部 v1',
      file: files.b1CLocal,
      evidenceLevel: 'Hypothesis',
      metadata: {
        ...baseMetadata,
        candidateKey: 'scope-direct-image-v3-b1-c-local-v1',
        candidateVersion: 'scope-direct-image.v3-b1-c-local-v1',
        viewRole: 'b1_c_corridor_local_candidate',
        sceneId: 'SCENE-G3-01-fb932-b1-c-local-v1',
        sourceCandidate: 'scope-direct-image-v3-b1-filled-candidate.glb',
        sourceManifest: path.relative(artifactDir, files.b1CLocalManifest).replaceAll('\\', '/'),
        structuralAudit: 'job_049e9022a808-scope-direct-image-v3/scope-direct-image-v3-b1-c-local-v1-structural-audit.json',
        fourViewReview: 'job_049e9022a808-scope-direct-image-v3/reviews/b1-c-local-v1/four-view-review.json',
        reviewNote: '仅补充用户确认的 B1楼/C楼夹道、横向道路连接和对面小道；B1、C楼、主楼、锁定道路和 active 均未移动。'
      }
    }]).catch(() => [])),
    { key: 'surrounding', kind: 'site_direct_image_surrounding_glb', title: '候选范围 v3 · 周边建筑和小道', file: files.surrounding, evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, viewRole: 'surrounding_only' } },
    ...(await fsp.access(files.g3, fs.constants.R_OK).then(() => [{ key: 'g3', kind: 'site_direct_image_g3_candidate_glb', title: '候选范围 v3 · G3 起点局部', file: files.g3, evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, viewRole: 'g3_scene_candidate', sceneId: 'SCENE-G3-01', sourceCard: 'docs/evidence/second-capture-video-phase2-keyframes/G3-location-card.json' } }]).catch(() => [])),
    ...(await fsp.access(files.g3v3, fs.constants.R_OK).then(() => [{ key: 'g3v3', kind: 'site_direct_image_g3_v3_candidate_glb', title: '候选范围 v3 · G3 导航核验版', file: files.g3v3, evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, viewRole: 'g3_scene_navigation_grounded_candidate', sceneId: 'SCENE-G3-01', sourceCard: 'docs/evidence/second-capture-video-phase2-keyframes-v2/scene-register/G3-scene-register.json', fourViewReview: 'tmp/runtime/artifacts/job_049e9022a808-scope-direct-image-v3/reviews/g3-v3/g3-v3-four-view-review.json' } }]).catch(() => [])),
    { key: 'map', kind: 'site_direct_image_reference_png', title: '候选范围 v3 · 用户标注图 1:1', file: files.map, evidenceLevel: 'Observed', metadata: { ...baseMetadata, viewRole: 'original_1to1_map' } },
    { key: 'annotated-map', kind: 'site_direct_image_annotated_map_jpg', title: '候选范围 v3 · 标注图副本', file: files.annotatedMap, evidenceLevel: 'Observed', metadata: { ...baseMetadata, viewRole: 'annotated_map' } },
    { key: 'manifest', kind: 'site_direct_image_manifest', title: '候选范围 v3 · 生成清单', file: files.manifest, evidenceLevel: 'Derived', metadata: { ...baseMetadata, viewRole: 'manifest' } }
  ];
  let changed = false;
  for (const record of records) {
    const exists = store.artifacts.find((artifact) => artifact.projectId === projectId && artifact.kind === record.kind && artifact.metadata?.candidateKey === record.metadata.candidateKey);
    if (exists) continue;
    await addArtifact({ projectId, jobId: null, kind: record.kind, title: record.title, storedPath: record.file, evidenceLevel: record.evidenceLevel, metadata: record.metadata });
    changed = true;
  }
  // The v3 navigation-grounded G3 candidate supersedes the earlier fb932+b67
  // candidate for the normal workspace. Keep the earlier record in history,
  // but do not let insertion order make it the visible current layer.
  for (const artifact of store.artifacts) {
    if (artifact.projectId !== projectId) continue;
    if (artifact.kind !== 'site_direct_image_g3_v3_candidate_glb') continue;
    if (artifact.metadata?.candidateKey === 'scope-direct-image-v3') continue;
    if (artifact.metadata?.stale === true) continue;
    artifact.metadata = {
      ...(artifact.metadata || {}),
      stale: true,
      staleReason: 'superseded_by_scene_g3_v3_navigation_grounded_candidate',
      supersededAt: new Date().toISOString()
    };
    changed = true;
  }
  if (changed) await persist();
  return changed;
}

await ensureDirectImageCandidateArtifacts();

async function ensureFacadePhotoZonesCandidate() {
  const projectId = store.activeProjectId;
  if (!projectId) return false;
  const dir = path.join(artifactDir, 'competition-facade-photo-zones-20261014-v13');
  const glb = path.join(dir, 'site-layout.glb');
  const audit = path.join(dir, 'site-layout.glb.audit.json');
  for (const file of [glb, audit]) {
    try { await fsp.access(file, fs.constants.R_OK); } catch { return false; }
  }
  const candidateKey = 'competition-facade-photo-zones-20261014-v13';
  if (store.artifacts.some((a) => a.projectId === projectId && a.kind === 'main_building_facade_candidate_glb' && a.metadata?.candidateKey === candidateKey)) return false;
  await addArtifact({
    projectId, jobId: null, kind: 'main_building_facade_candidate_glb',
    title: '照片版候选 v13 · 现有背立面玻璃可见性修复', storedPath: glb, evidenceLevel: 'Hypothesis',
    metadata: {
      candidateOnly: true, candidateKey, candidateVersion: 'facade.photo-zones.v13',
      operatorAcceptance: 'pending', activeArtifactModified: false, videoApplied: false,
      sourceCandidate: 'competition-main-facade-entry-rightdown-20261013-v2',
      sourceGlb: 'competition-entry-material-retained-20261012-v1/main-facade-entry-rightdown-final.glb',
      targetPrefix: 'main-building-exterior-review-*', photoZones: [1, 2, 3, 4, 5],
      audit: 'competition-facade-photo-zones-20261014-v13/site-layout.glb.audit.json',
      preserved: ['main building transform', 'purple junction', 'entry equipment', 'long fence', 'road topology']
    }
  });
  await persist();
  return true;
}

await ensureFacadePhotoZonesCandidate();

// Register the current G3 v2 candidate as a separate candidate-only layer.
// It uses its own kind so bootstrap's latest-by-kind filter cannot hide it
// behind the older G3 navigation candidate.
async function ensureG3Fb932B67V2Artifact() {
  const projectId = store.activeProjectId;
  if (!projectId) return false;
  const candidateDir = path.join(artifactDir, 'job_049e9022a808-g3-fb932-b67-v2');
  const glb = path.join(candidateDir, 'g3-fb932-b67-candidate.glb');
  const manifest = path.join(candidateDir, 'g3-fb932-b67-manifest.json');
  const review = path.join(candidateDir, 'reviews', 'g3-v2-four-view-review.json');
  for (const filePath of [glb, manifest, review]) {
    try { await fsp.access(filePath, fs.constants.R_OK); } catch { return false; }
  }
  const candidateKey = 'g3-fb932-b67-v2';
  const exists = store.artifacts.find((artifact) =>
    artifact.projectId === projectId
    && artifact.kind === 'site_direct_image_g3_fb932_b67_candidate_glb'
    && artifact.metadata?.candidateKey === candidateKey
  );
  if (exists) {
    if (exists.metadata?.stale !== true) {
      exists.metadata = { ...(exists.metadata || {}), stale: true, staleReason: 'superseded_by_scene_g3_v3_navigation_grounded_candidate', supersededAt: new Date().toISOString() };
      await persist();
      return true;
    }
    return false;
  }
  let manifestJson = {};
  try { manifestJson = JSON.parse(await fsp.readFile(manifest, 'utf8')); } catch { return false; }
  await addArtifact({
    projectId,
    jobId: null,
    kind: 'site_direct_image_g3_fb932_b67_candidate_glb',
    title: 'G3 第一处 v2 · fb932 + b67 双验证候选',
    storedPath: glb,
    evidenceLevel: 'Hypothesis',
    metadata: {
      candidateOnly: true,
      candidateKey,
      candidateVersion: 'scene-g3.fb932-b67.v2',
      operatorAcceptance: 'pending',
      activeArtifactModified: false,
      mainBuildingTransformChanged: false,
      lockedRoadsMoved: false,
      sceneId: 'SCENE-G3-01',
      sourceManifest: path.relative(artifactDir, manifest).replaceAll('\\', '/'),
      fourViewReview: path.relative(artifactDir, review).replaceAll('\\', '/'),
      doubleValidation: ['fb93278a5dfeb43576fcab66c2e8d990', 'b67dcc09ead45fc1b2e9aa28ddb89952'],
      sampleCount: Number(manifestJson.geometryPolicy?.sampleCount || 28),
      reviewNote: '候选叠加层：主楼、已锁定道路和连续分隔设施保留；未替换 active。'
    }
  });
  await persist();
  return true;
}

await ensureG3Fb932B67V2Artifact();

// Register the current single-material fb932 main-entry candidate as its own
// candidate-only layer.  The workspace can display it for operator review
// without replacing the active site model or moving any locked geometry.
async function ensureG3Fb932MainEntryV2Artifact() {
  const projectId = store.activeProjectId;
  if (!projectId) return false;
  const candidateDir = path.join(artifactDir, 'job_049e9022a808-g3-fb932-main-entry-v2');
  const glb = path.join(candidateDir, 'g3-fb932-main-entry-candidate.glb');
  const manifest = path.join(candidateDir, 'g3-fb932-main-entry-manifest.json');
  const audit = path.join(candidateDir, 'g3-fb932-main-entry-independent-audit.json');
  const reviewImages = [
    'fb932-main-entry-top.png',
    'fb932-main-entry-forward.png',
    'fb932-main-entry-reverse.png',
    'fb932-main-entry-oblique.png',
    'fb932-main-entry-fourth.png'
  ].map((name) => path.join(candidateDir, 'reviews', name));
  for (const filePath of [glb, manifest, audit, ...reviewImages]) {
    try { await fsp.access(filePath, fs.constants.R_OK); } catch { return false; }
  }
  const candidateKey = 'g3-fb932-main-entry-v2';
  const exists = store.artifacts.find((artifact) =>
    artifact.projectId === projectId
    && artifact.kind === 'site_direct_image_g3_v3_candidate_glb'
    && artifact.metadata?.candidateKey === candidateKey
  );
  if (exists) {
    if (exists.metadata?.stale === true) {
      return false;
    }
    if (exists.metadata?.stale !== true) {
      exists.metadata = { ...(exists.metadata || {}), stale: true, staleReason: 'superseded_by_scene_g3_v3_navigation_grounded_candidate', supersededAt: new Date().toISOString() };
      await persist();
      return true;
    }
    return false;
  }
  let manifestJson = {};
  let auditJson = {};
  try {
    manifestJson = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    auditJson = JSON.parse(await fsp.readFile(audit, 'utf8'));
  } catch {
    return false;
  }
  await addArtifact({
    projectId,
    jobId: null,
    kind: 'site_direct_image_g3_v3_candidate_glb',
    title: 'G3 主入口支路 v2 · fb932 箭尾→箭头候选',
    storedPath: glb,
    evidenceLevel: 'Hypothesis',
    metadata: {
      candidateOnly: true,
      candidateKey,
      candidateVersion: 'scene-g3.fb932-main-entry.v2',
      stale: true,
      staleReason: 'superseded_by_scene_g3_v3_navigation_grounded_candidate',
      operatorAcceptance: 'pending',
      activeArtifactModified: false,
      mainBuildingTransformChanged: false,
      lockedRoadsMoved: false,
      sceneId: 'SCENE-G3-01',
      sourceVideo: 'fb93278a5dfeb43576fcab66c2e8d990',
      sourceManifest: path.relative(artifactDir, manifest).replaceAll('\\', '/'),
      independentAudit: path.relative(artifactDir, audit).replaceAll('\\', '/'),
      fourViewReview: reviewImages.map((filePath) => path.relative(artifactDir, filePath).replaceAll('\\', '/')),
      routeBinding: 'site-branch-main-entry-surface',
      routeDirection: 'arrow-tail-to-arrow-head',
      addedMeshCount: Number(manifestJson.addedNodeCount || manifestJson.addedNodes || 300),
      auditSummary: auditJson.summary || null,
      reviewNote: '候选局部层：只加入 fb932 主入口支路现场细节；主楼、已锁定道路和 active 不动。'
    }
  });
  await persist();
  return true;
}

await ensureG3Fb932MainEntryV2Artifact();

// Keep the rebased v3 baseline visible as the newest candidate-only layer.
async function ensureG3Fb932MainEntryV3Artifact() {
  const projectId = store.activeProjectId;
  if (!projectId) return false;
  const candidateDir = path.join(artifactDir, 'job_049e9022a808-g3-fb932-main-entry-v3');
  const glb = path.join(candidateDir, 'g3-fb932-main-entry-rebased-candidate.glb');
  const manifest = path.join(candidateDir, 'g3-fb932-main-entry-rebased-manifest.json');
  for (const filePath of [glb, manifest]) {
    try { await fsp.access(filePath, fs.constants.R_OK); } catch { return false; }
  }
  const candidateKey = 'g3-fb932-main-entry-v3-rebased';
  const exists = store.artifacts.find((artifact) =>
    artifact.projectId === projectId
    && artifact.kind === 'site_direct_image_g3_v3_candidate_glb'
    && artifact.metadata?.candidateKey === candidateKey
  );
  if (exists) {
    if (exists.metadata?.stale === true) {
      exists.metadata = { ...(exists.metadata || {}), stale: false, staleReason: null, restoredAt: new Date().toISOString() };
      await persist();
      return true;
    }
    return false;
  }
  let manifestJson = {};
  try { manifestJson = JSON.parse(await fsp.readFile(manifest, 'utf8')); } catch { return false; }
  await addArtifact({
    projectId,
    jobId: null,
    kind: 'site_direct_image_g3_v3_candidate_glb',
    title: 'G3 主入口支路 v3 · 最新纠正候选基线',
    storedPath: glb,
    evidenceLevel: 'Hypothesis',
    metadata: {
      candidateOnly: true,
      candidateKey,
      candidateVersion: 'scene-g3.fb932-main-entry.v3-rebased',
      operatorAcceptance: 'pending',
      activeArtifactModified: false,
      mainBuildingTransformChanged: false,
      lockedRoadsMoved: false,
      sceneId: 'SCENE-G3-01',
      sourceVideo: 'fb93278a5dfeb43576fcab66c2e8d990',
      baseCandidate: 'g3-fb932-main-entry-v2',
      sourceManifest: path.relative(artifactDir, manifest).replaceAll('\\', '/'),
      routeBinding: 'site-branch-main-entry-surface',
      routeDirection: 'arrow-tail-to-arrow-head',
      geometryPolicy: manifestJson.geometryPolicy || { mode: 'exact_rebase', newGeometryAdded: false },
      reviewNote: '以最新路线纠正候选为后续修改基线；未新增未经素材证明的构件。'
    }
  });
  await persist();
  return true;
}

await ensureG3Fb932MainEntryV3Artifact();

function publicArtifact(artifact) {
  const { storedPath, ...safe } = artifact;
  const hostedUrl = artifact.id === 'artifact_2dbc856e76e8' ? '/models/twin-main.glb' : (typeof safe.url === 'string' && safe.url.startsWith('/') && !safe.url.startsWith('/api/') ? safe.url : null);
  return { ...safe, url: hostedUrl || `/api/artifacts/${artifact.id}/content` };
}

// The store intentionally keeps every historical candidate for traceability,
// but the normal workspace only needs the current, non-stale records. Sending
// all historical GLB metadata on every page load made the UI download and
// parse tens of megabytes before the viewport could start. History remains
// available to diagnostics with ?includeHistory=true.
function workspaceArtifacts(includeHistory = false) {
  const records = recordsForProject(store.artifacts);
  return includeHistory
    ? records
    : records.filter((artifact) => artifact?.metadata?.stale !== true);
}

// The first workspace paint only needs the latest visual layers.  Large
// manifest/CAD-history records remain available through the normal endpoint,
// but do not block the initial 3D viewport with hundreds of kilobytes of JSON.
const bootstrapArtifactKinds = new Set([
  'site_context_glb', 'site_context_blender_preview', 'site_corridor_preview',
  'site_interior_model_glb', 'blender_enhanced_glb', 'blender_preview_png',
  'skp_glb', 'dwg_plan_glb', 'dwg_extrusion_glb', 'osm_context_glb',
  'dwg_plan_geojson', 'osm_context_geojson', 'reference_source_manifest',
  'site_direct_image_reference_png', 'site_direct_image_candidate_glb',
  'site_direct_image_surrounding_glb', 'site_direct_image_g3_candidate_glb', 'site_direct_image_g3_v3_candidate_glb',
  'site_direct_image_g3_fb932_b67_candidate_glb', 'main_building_facade_candidate_glb'
]);

function bootstrapWorkspaceArtifacts() {
  const latestByKind = new Map();
  for (const artifact of workspaceArtifacts(false)) {
    if (!bootstrapArtifactKinds.has(artifact.kind)) continue;
    latestByKind.set(artifact.kind, artifact);
  }
  return [...latestByKind.values()];
}

const bootstrapMetadataKeys = [
  'stale', 'supersededAt', 'sourceArtifactId', 'mainBuildingArtifactId', 'candidateKey',
  'geometryCount', 'outputBytes', 'schema', 'coordinateSpace', 'coordinateStatus',
  'georeferenced', 'axes', 'buildingSchema', 'buildingAxes', 'bounds',
  'mainBuildingHalfExtentsM', 'mainBuildingHeightM', 'wallHeightM',
  'floorSlabThicknessM', 'floorCount', 'levelCount', 'openingCounts',
  'resolvedOpeningCounts', 'windowFrameCount', 'selectedFurnitureCount',
  'selectedSemanticObjectCount', 'categoryCounts', 'sourceSurfaceCount',
  'mainBuildingSourceGeometryNodeCount', 'mainBuildingInteriorIncludedInSiteContext',
  'exteriorShellOnly', 'exteriorShellPolicy', 'blenderRefined', 'blenderVersion',
  'blenderRefinement', 'topologyFirst', 'routeLengthM', 'sourceVideoOrder', 'returnVideoOrder',
  'ordinaryPhotoEvidenceCount', 'panoramaEvidenceCount', 'fieldImageEvidenceCount',
  'allProjectVideoAssetCount', 'fieldVideoAssetCount', 'testVideoAssetCount',
  'unmappedFieldVideoAssetCount', 'imageSourceCount', 'referenceUrlCount'
];

// The first paint only needs model records. Field photos/videos and their
// manifests are hydrated after the fast 3D layer is ready; sending them here
// made JSON parsing compete with the initial GLTF work.
function bootstrapAssets() {
  return recordsForProject(store.assets)
    .filter((asset) => asset?.type === '3d' || /\.(glb|gltf|ply)$/i.test(asset?.name || ''))
    .map(publicAsset);
}

function publicBootstrapArtifact(artifact) {
  const safe = publicArtifact(artifact);
  const metadata = {};
  for (const key of bootstrapMetadataKeys) {
    if (artifact.metadata?.[key] !== undefined) metadata[key] = artifact.metadata[key];
  }
  return { ...safe, metadata };
}

function cloneStoreRecord(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

async function ffprobeMetadata(videoPath) {
  const result = await runProcess('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,avg_frame_rate,codec_name', '-of', 'json', videoPath]);
  if (result.code !== 0) throw new Error(`FFprobe 无法读取视频: ${result.stderr.trim() || 'unknown error'}`);
  return JSON.parse(result.stdout);
}

function observationSpatialConfig(zones = []) {
  const roiCandidates = [];
  const regions = [];
  const countLines = [];
  for (const raw of Array.isArray(zones) ? zones : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const type = String(raw.type || raw.kind || '').trim().toLowerCase();
    const itemId = String(raw.id || '').trim();
    const polygon = raw.polygon_px || raw.polygonPx || raw.polygon;
    const a = raw.a_px || raw.aPx || raw.a;
    const b = raw.b_px || raw.bPx || raw.b;
    if (type === 'count_line' || type === 'countline' || (Array.isArray(a) && Array.isArray(b))) {
      countLines.push({ id: itemId, a_px: a, b_px: b, direction: raw.direction || 'both' });
      continue;
    }
    if (!Array.isArray(polygon)) continue;
    if (type === 'roi') roiCandidates.push(polygon);
    else regions.push({ id: itemId, polygon_px: polygon, conflict_zone: Boolean(raw.conflict_zone ?? raw.conflictZone) });
  }
  return { roi_polygon_px: roiCandidates[0] || null, regions, count_lines: countLines };
}

function observationSampleLevel(window, projectId) {
  if (!window?.slotId || window.dayType !== 'normal_weekday') return 'single_observation';
  const dates = new Set(store.videoWindows
    .filter((item) => item.projectId === projectId && item.slotId === window.slotId && item.dayType === 'normal_weekday' && item.capturedAt)
    .map((item) => String(item.capturedAt).slice(0, 10))
    .filter(Boolean));
  return representativeLevel(dates.size);
}

async function runVisionJob(job, asset) {
  const project = projectForJob(job);
  const jobDir = path.join(artifactDir, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  job.status = 'running';
  job.stage = 'decode';
  job.startedAt = new Date().toISOString();
  await persist();
  emitJobEvent(job.id, 'step.started', { stepId: 'metadata', title: '读取视频元数据' });
  try {
    const metadata = await ffprobeMetadata(asset.storedPath);
    job.metadata = metadata;
    emitJobEvent(job.id, 'tool.completed', { name: 'ffprobe', outputSummary: '视频元数据已读取' });
    job.stage = 'inference';
    await persist();
    emitJobEvent(job.id, 'step.started', { stepId: 'inference', title: 'YOLOX-s + ByteTrack 推理' });
    const detectionsPath = path.join(jobDir, 'detections.ndjson');
    const annotatedPath = path.join(jobDir, 'annotated.mp4');
    const worker = path.join(rootDir, 'workers', 'yolo_worker.py');
    const result = await runProcess(pythonCommand(), [worker, '--video', asset.storedPath, '--model', process.env.YOLO_MODEL_PATH, '--output', detectionsPath, '--annotated', annotatedPath, '--fps', String(job.sampling.fps || 10)]);
    const payload = lastJsonLine(result.stdout);
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || 'YOLO Worker failed');
    const summary = payload.result;
    job.stage = 'deterministic_observation';
    emitJobEvent(job.id, 'tool.completed', { name: 'yolox_bytetrack', outputSummary: `${summary.processed_frames} 个采样帧已完成` });
    emitJobEvent(job.id, 'step.started', { stepId: 'deterministic_observation', title: '构建可追溯 ObservationBundle' });
    const window = job.windowId
      ? store.videoWindows.find((item) => item.projectId === job.projectId && item.id === job.windowId)
      : [...store.videoWindows].reverse().find((item) => item.projectId === job.projectId && item.assetId === asset.id && item.slotId === job.slotId);
    if (!window) throw new Error('找不到与该资产和典型时段匹配的视频窗口');
    const stream = (metadata?.streams || []).find((item) => Number(item.width) > 0 && Number(item.height) > 0) || {};
    const spatial = observationSpatialConfig(window.zones);
    const calibrationReliable = window.calibration?.mode === 'homography'
      && Number(window.calibration.rmse_m) <= 0.5
      && window.calibration.status !== 'degraded';
    const calibration = calibrationReliable ? {
      mode: 'homography', matrix: window.calibration.matrix,
      rmse_m: Number(window.calibration.rmse_m),
      control_point_count: Number(window.calibration.controlPointCount ?? window.calibration.control_point_count)
    } : { mode: 'pixel' };
    const observationConfigPath = path.join(jobDir, 'observation-config.json');
    const observationArtifactPath = path.join(jobDir, 'observation-bundle.json');
    const observationConfig = {
      project_id: project.id,
      source_window_id: window.id,
      source_asset_id: asset.id,
      source_nature: window.sourceNature || inferredSourceNature(asset),
      test_only: (window.sourceNature || inferredSourceNature(asset)) === 'virtual_test',
      captured_at: window.capturedAt,
      sample_level: observationSampleLevel(window, project.id),
      duration_seconds: Number(window.durationSeconds || metadata?.format?.duration || 600),
      video: { width_px: Number(stream.width || 0), height_px: Number(stream.height || 0) },
      upstream: {
        detector: { name: 'YOLOX-s ONNX', version: 'yolox_onnx_decoder.v2', model_sha256: await sha256(process.env.YOLO_MODEL_PATH) },
        tracker: { name: summary.tracker, version: summary.tracker_version }
      },
      sampling: { requested_fps: Number(job.sampling.fps), actual_fps: Number(summary.sample_fps), source_fps: Number(summary.source_fps) },
      verification: { supervision_enabled: true, tolerance_ratio: 0.05, minimum_crossing_threshold: 2 },
      calibration,
      ...spatial,
      thresholds: {
        min_track_samples: 2,
        line_side_margin_px: 2,
        line_stable_samples: 2,
        line_min_transition_ms: 100,
        line_rearm_distance_px: 6,
        line_rearm_ms: 800,
        sync_tolerance_ms: 250,
        proximity_m: 1.25,
        ttc_horizon_s: 5,
        ttc_miss_distance_m: 0.75,
        pet_max_s: 5
      }
    };
    await fsp.writeFile(observationConfigPath, JSON.stringify(observationConfig, null, 2), 'utf8');
    const observationWorker = path.join(rootDir, 'workers', 'observation_worker.py');
    const observationResult = await runProcess(pythonCommand(), [observationWorker, '--detections', detectionsPath, '--config', observationConfigPath, '--output', observationArtifactPath]);
    const observationPayload = lastJsonLine(observationResult.stdout) || lastJsonLine(observationResult.stderr);
    if (observationResult.code !== 0 || !observationPayload?.ok) throw new Error(observationPayload?.error || observationResult.stderr.trim() || 'Observation Worker failed');
    const observation = {
      ...observationPayload.result,
      source: { ...observationPayload.result.source, detections_file: path.basename(detectionsPath) },
      sourceNature: window.sourceNature || inferredSourceNature(asset),
      testOnly: (window.sourceNature || inferredSourceNature(asset)) === 'virtual_test',
      createdAt: new Date().toISOString(),
      rawSummary: summary
    };
    await fsp.writeFile(observationArtifactPath, JSON.stringify(observation, null, 2), 'utf8');
    if (window) {
      window.metrics = observation.metrics;
      window.conflicts = observation.conflicts;
      window.dataGaps = observation.data_gaps;
      window.status = 'analyzed';
      window.observationId = observation.id;
    }
    store.observations.push(observation);
    observation.projectId = project.id;
    const sourceNature = window.sourceNature || inferredSourceNature(asset);
    const testOnly = sourceNature === 'virtual_test';
    const sourceEvidenceLevel = testOnly ? 'Scenario' : 'Observed';
    const detectionsArtifact = await addArtifact({ projectId: project.id, jobId: job.id, kind: 'vision_ndjson', title: `${testOnly ? '测试' : '现场'} YOLO 检测与轨迹 NDJSON`, storedPath: detectionsPath, evidenceLevel: sourceEvidenceLevel, metadata: { schema: 'vision_observation.v1', sourceNature, testOnly } });
    const videoArtifact = await addArtifact({ projectId: project.id, jobId: job.id, kind: 'annotated_video', title: `${testOnly ? '虚拟测试' : '真实'}标注视频`, storedPath: annotatedPath, evidenceLevel: sourceEvidenceLevel, metadata: { sourceAssetId: asset.id, sourceNature, testOnly } });
    const bundleArtifact = await addArtifact({ projectId: project.id, jobId: job.id, kind: 'observation_bundle', title: `ObservationBundle${testOnly ? ' · TEST ONLY' : ''}`, storedPath: observationArtifactPath, evidenceLevel: 'Derived', metadata: { schema: 'observation_bundle.v1', sourceNature, testOnly } });
    job.output = { observationId: observation.id, artifacts: [publicArtifact(detectionsArtifact), publicArtifact(videoArtifact), publicArtifact(bundleArtifact)] };
    job.status = 'succeeded';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'artifact.created', { artifactId: detectionsArtifact.id, kind: detectionsArtifact.kind, title: detectionsArtifact.title });
    emitJobEvent(job.id, 'artifact.created', { artifactId: bundleArtifact.id, kind: bundleArtifact.kind, title: bundleArtifact.title });
    emitJobEvent(job.id, 'job.completed', { outputSummary: '观测指标与真实产物已保存' });
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.diagnostics = [...(job.diagnostics || []), error.message];
    emitJobEvent(job.id, 'step.failed', { stepId: job.stage || 'worker', error: error.message, recoverable: true });
  }
  await persist();
}

async function runScenePreflightJob(job, assets) {
  const project = projectForJob(job);
  const jobDir = path.join(artifactDir, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  job.status = 'running';
  job.stage = 'preflight';
  job.startedAt = new Date().toISOString();
  await persist();
  emitJobEvent(job.id, 'step.started', { stepId: 'preflight', title: '生成可追溯场景预检清单' });
  try {
    const outputPath = path.join(jobDir, 'scene-preflight.json');
    const args = [path.join(rootDir, 'workers', 'scene_worker.py'), '--latitude', String(project.latitude), '--longitude', String(project.longitude), '--output', outputPath];
    for (const asset of assets) args.push('--input', asset.storedPath);
    const result = await runProcess(pythonCommand(), args);
    const payload = lastJsonLine(result.stdout);
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || '场景预检失败');
    const artifact = await addArtifact({ projectId: project.id, jobId: job.id, kind: 'scene_preflight', title: '场景证据预检清单', storedPath: outputPath, evidenceLevel: 'Derived', metadata: payload.result });
    job.output = { artifacts: [publicArtifact(artifact)], preflight: payload.result };
    job.stage = 'runtime_gate';
    job.diagnostics = [];
    const blockingDiagnostics = [];
    const colmapAvailable = commandAvailable(process.env.COLMAP_BIN || 'colmap');
    const ffmpegAvailable = commandAvailable(process.env.FFMPEG_BIN || 'ffmpeg');
    const nerfstudioAvailable = commandAvailable(process.env.NERFSTUDIO_BIN || 'ns-train');
    const nsExportAvailable = commandAvailable(process.env.NS_EXPORT_BIN || 'ns-export');
    const spzAvailable = commandAvailable(process.env.SPZ_BIN || 'spz');
    const gaussianComputeAvailable = commandAvailable('nvidia-smi') || process.env.ALLOW_CPU_3DGS === 'true';
    if (!colmapAvailable) blockingDiagnostics.push('未找到 COLMAP；摄影测量无法启动。');
    if (!ffmpegAvailable) blockingDiagnostics.push('未找到 FFmpeg；重建影像预处理无法启动。');
    const withSplat = nerfstudioAvailable && nsExportAvailable && spzAvailable && gaussianComputeAvailable;
    if (!withSplat) {
      const missing = [];
      if (!nerfstudioAvailable) missing.push('Nerfstudio');
      if (!nsExportAvailable) missing.push('ns-export');
      if (!spzAvailable) missing.push('Niantic SPZ');
      if (!gaussianComputeAvailable) missing.push('CUDA/允许的CPU训练环境');
      job.diagnostics.push(`3DGS 运行时不完整（${missing.join('、')}）；本次真实降级为 COLMAP-only 局部点云。`);
    }
    const reconstructionInputs = assets.filter((asset) => ['image', 'video'].includes(asset.type));
    if (!reconstructionInputs.length) blockingDiagnostics.push('没有照片或移动视频输入；已有 GLB/GLTF 可直接展示，但不能启动摄影测量。');
    job.diagnostics.push(...blockingDiagnostics);
    if (blockingDiagnostics.length) {
      job.status = 'blocked';
      emitJobEvent(job.id, 'artifact.created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
      emitJobEvent(job.id, 'step.failed', { stepId: 'runtime_gate', error: job.diagnostics.join(' '), recoverable: true });
    } else {
      emitJobEvent(job.id, 'artifact.created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
      job.stage = 'photogrammetry';
      emitJobEvent(job.id, 'step.started', { stepId: 'photogrammetry', title: 'FFmpeg 抽帧与 COLMAP 摄影测量' });
      const reconstructionDir = path.join(jobDir, 'reconstruction');
      const reconstructionWorker = path.join(rootDir, 'workers', 'reconstruction_worker.py');
      const reconstructionArgs = [
        reconstructionWorker, '--output-dir', reconstructionDir,
        '--colmap', process.env.COLMAP_BIN || 'colmap', '--ffmpeg', process.env.FFMPEG_BIN || 'ffmpeg',
        '--ns-train', process.env.NERFSTUDIO_BIN || 'ns-train', '--ns-export', process.env.NS_EXPORT_BIN || 'ns-export',
        '--spz', process.env.SPZ_BIN || 'spz',
        '--max-iterations', String(Number(process.env.NERFSTUDIO_MAX_ITERATIONS || 30000))
      ];
      if (withSplat) reconstructionArgs.push('--with-splat');
      for (const input of reconstructionInputs) reconstructionArgs.push('--input', input.storedPath);
      const reconstruction = await runProcess(pythonCommand(), reconstructionArgs);
      const reconstructionPayload = lastJsonLine(reconstruction.stdout) || lastJsonLine(reconstruction.stderr);
      if (reconstruction.code !== 0 || !reconstructionPayload?.ok) throw new Error(reconstructionPayload?.error || reconstruction.stderr.trim() || '摄影测量失败');
      const result = reconstructionPayload.result;
      const sparseArtifact = await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'sparse_point_cloud', title: 'COLMAP 稀疏点云 PLY',
        storedPath: result.sparse_ply, evidenceLevel: 'Derived', metadata: { quality: result.quality, coordinateStatus: result.coordinate_status, georeferenced: result.georeferenced, metricAnalysisAllowed: result.metric_analysis_allowed }
      });
      const qualityArtifact = await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'reconstruction_quality', title: 'COLMAP 重建质量门槛',
        storedPath: result.quality_path, evidenceLevel: 'Derived', metadata: result.quality
      });
      const manifestArtifact = await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'reconstruction_manifest', title: '重建资产清单',
        storedPath: result.manifest, evidenceLevel: 'Derived', metadata: { schema: 'reconstruction_manifest.v1', mode: result.reconstruction_mode }
      });
      const producedArtifacts = [sparseArtifact, qualityArtifact, manifestArtifact];
      if (result.reconstruction_mode === 'full_3dgs') {
        producedArtifacts.push(await addArtifact({
          projectId: project.id, jobId: job.id, kind: 'gaussian_ply', title: 'Gaussian Splatting PLY',
          storedPath: result.gaussian_ply, evidenceLevel: 'Derived', metadata: { quality: result.quality, coordinateStatus: result.coordinate_status, georeferenced: result.georeferenced }
        }));
        producedArtifacts.push(await addArtifact({
          projectId: project.id, jobId: job.id, kind: 'gaussian_spz', title: '网页 Gaussian Splatting SPZ',
          storedPath: result.gaussian_spz, evidenceLevel: 'Derived', metadata: { quality: result.quality, coordinateStatus: result.coordinate_status, georeferenced: result.georeferenced }
        }));
      }
      job.output = { ...(job.output || {}), reconstruction: result, artifacts: [...(job.output?.artifacts || []), ...producedArtifacts.map(publicArtifact)] };
      job.status = 'succeeded';
      job.stage = 'completed';
      job.progress = 100;
      emitJobEvent(job.id, 'tool.completed', { name: result.reconstruction_mode === 'full_3dgs' ? 'colmap_nerfstudio' : 'colmap', outputSummary: `${result.quality.registered_views} 个注册视角；${result.reconstruction_mode === 'full_3dgs' ? 'Gaussian 与稀疏点云' : '稀疏点云'}已导出` });
      for (const produced of producedArtifacts) emitJobEvent(job.id, 'artifact.created', { artifactId: produced.id, kind: produced.kind, title: produced.title });
      emitJobEvent(job.id, 'job.completed', { outputSummary: result.reconstruction_mode === 'full_3dgs' ? '真实3DGS与COLMAP点云已完成' : '真实COLMAP局部点云已完成；未生成Gaussian资产' });
    }
    job.completedAt = new Date().toISOString();
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.diagnostics = [...(job.diagnostics || []), error.message];
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'step.failed', { stepId: job.stage || 'preflight', error: error.message, recoverable: true });
  }
  await persist();
}

async function runGeographicContextJob(job, radiusMeters) {
  const project = projectForJob(job);
  const anchorHash = geoAnchorHash(project);
  const jobDir = path.join(artifactDir, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  job.status = 'running';
  job.stage = 'overpass_fetch';
  job.startedAt = new Date().toISOString();
  await persist();
  emitJobEvent(job.id, 'step.started', { stepId: 'overpass_fetch', title: '读取 OpenStreetMap 建筑与道路' });
  try {
    const worker = path.join(rootDir, 'workers', 'osm_context_worker.py');
    const result = await runProcess(pythonCommand(), [
      worker,
      '--latitude', String(project.latitude),
      '--longitude', String(project.longitude),
      '--radius-m', String(radiusMeters),
      '--output-dir', jobDir,
      '--dem-cache-dir', process.env.DEM_CACHE_DIR || path.join(rootDir, 'data', 'cache', 'copernicus-dem'),
      ...(process.env.OSM_SOURCE_GEOJSON ? ['--source-geojson', process.env.OSM_SOURCE_GEOJSON] : []),
      ...(process.env.OSM_SOURCE_DEM ? ['--source-dem', process.env.OSM_SOURCE_DEM] : []),
      ...(process.env.OSM_SKIP_DEM === 'true' ? ['--skip-dem'] : [])
    ]);
    const payload = lastJsonLine(result.stdout) || lastJsonLine(result.stderr);
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || 'OSM 地理底景生成失败');
    const context = payload.result;
    const anchorStillCurrent = geoAnchorHash(store.projects.find((item) => item.id === project.id)) === anchorHash;
    const staleMetadata = anchorStillCurrent ? { stale: false } : { stale: true, staleReason: 'project_anchor_changed_during_generation', staleAt: new Date().toISOString() };
    markGeographicContextStale(project.id, 'superseded_by_new_context');
    job.stage = 'asset_registration';
    emitJobEvent(job.id, 'tool.completed', { name: 'osmnx_trimesh', outputSummary: `${context.counts.buildings} 栋建筑、${context.counts.roads} 段道路已生成` });
    emitJobEvent(job.id, 'step.started', { stepId: 'asset_registration', title: '登记 GLB、GeoJSON 与语义对象' });

    const glbArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'osm_context_glb', title: 'OSM 概念三维底景 GLB',
      storedPath: context.outputs.glb, evidenceLevel: 'Derived',
      metadata: { schema: context.schema, origin: context.origin, anchorHash, radiusMeters, ...staleMetadata, counts: context.counts, terrain: context.terrain, dataGaps: context.data_gaps }
    });
    const geojsonArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'osm_context_geojson', title: 'OSM 建筑道路 GeoJSON',
      storedPath: context.outputs.geojson, evidenceLevel: 'Derived',
      metadata: { schema: 'FeatureCollection', origin: context.origin, anchorHash, radiusMeters, ...staleMetadata, license: context.source.license }
    });
    const objectsArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'osm_scene_objects', title: 'OSM 本地米制语义对象',
      storedPath: context.outputs.scene_objects, evidenceLevel: 'Derived',
      metadata: { schema: 'scene_objects.v1', origin: context.origin, anchorHash, radiusMeters, ...staleMetadata, counts: context.counts }
    });
    const manifestArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'osm_context_manifest', title: 'OSM 地理底景清单',
      storedPath: context.manifest, evidenceLevel: 'Derived',
      metadata: { schema: context.schema, origin: context.origin, anchorHash, radiusMeters, ...staleMetadata, source: context.source, assumptions: context.assumptions.length, dataGaps: context.data_gaps }
    });
    const producedArtifacts = [glbArtifact, geojsonArtifact, objectsArtifact, manifestArtifact];
    if (context.terrain?.status === 'available' && context.outputs.dem_geotiff) {
      producedArtifacts.push(await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'terrain_dem_geotiff', title: 'Copernicus DEM 裁剪地形 GeoTIFF',
        storedPath: context.outputs.dem_geotiff, evidenceLevel: 'Derived',
        metadata: { terrain: context.terrain, origin: context.origin, anchorHash, radiusMeters, ...staleMetadata }
      }));
    }

    const generatedObjects = JSON.parse(await fsp.readFile(context.outputs.scene_objects, 'utf8'));
    let registered = 0;
    let skipped = 0;
    for (const generated of generatedObjects) {
      const existingIndex = store.sceneObjects.findIndex((item) => item.projectId === project.id && item.id === generated.id);
      const object = {
        ...generated,
        projectId: project.id,
        properties: { ...(generated.properties || {}), sourceArtifactId: geojsonArtifact.id, origin: context.origin, anchorHash, ...staleMetadata },
        createdAt: existingIndex >= 0 ? store.sceneObjects[existingIndex].createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (existingIndex < 0) {
        store.sceneObjects.push(object);
        registered += 1;
      } else if (store.sceneObjects[existingIndex].properties?.source === 'OpenStreetMap') {
        store.sceneObjects[existingIndex] = object;
        registered += 1;
      } else {
        skipped += 1;
      }
    }
    job.output = {
      counts: context.counts,
      assumptions: context.assumptions,
      dataGaps: context.data_gaps,
      terrain: context.terrain,
      objectRegistration: { registered, skipped },
      artifacts: producedArtifacts.map(publicArtifact)
    };
    job.status = 'succeeded';
    job.stale = !anchorStillCurrent;
    if (!anchorStillCurrent) job.staleReason = 'project_anchor_changed_during_generation';
    job.stage = 'completed';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    for (const artifact of producedArtifacts) {
      emitJobEvent(job.id, 'artifact.created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
    }
    emitJobEvent(job.id, 'job.completed', { outputSummary: `OSM 概念底景已生成；${registered} 个语义对象已登记；地形 ${context.terrain?.status || 'unknown'}` });
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.diagnostics = [...(job.diagnostics || []), error.message];
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'step.failed', { stepId: job.stage || 'overpass_fetch', error: error.message, recoverable: true });
  }
  await persist();
}

async function runSiteCorridorJob(job, videoAssets, mainBuildingArtifact, options = {}) {
  const project = projectForJob(job);
  const anchorHash = geoAnchorHash(project);
  const jobDir = path.join(artifactDir, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  job.status = 'running';
  job.stage = 'keyframe_extraction';
  job.progress = 8;
  job.startedAt = new Date().toISOString();
  await persist();
  emitJobEvent(job.id, 'step.started', { stepId: 'keyframe_extraction', title: '按密集帧率提取连续视频证据（默认4 fps）' });
  const routeRoles = new Set(['site_walkway_route', 'site_context_panorama_outer_lane', 'site_return_route_to_two_gates']);
  let storedProject = null;
  let previousCorridorArtifacts = [];
  let previousCorridorArtifactIds = new Set();
  let previousRouteObjects = [];
  let previousModelRegistration;
  let previousProjectUpdatedAt;
  let nextModelRegistration = null;
  const producedArtifactIds = new Set();
  let registrationCommitStarted = false;
  let registrationCommitted = false;
  try {
    const configPath = path.join(jobDir, 'site-corridor-config.json');
    const masterLedgerPath = path.join(rootDir, 'docs', 'site-reconstruction-master-ledger.json');
    const jobLedgerPath = path.join(jobDir, 'site-reconstruction-master-ledger.json');
    await fsp.copyFile(masterLedgerPath, jobLedgerPath);
    const masterLedger = JSON.parse(await fsp.readFile(jobLedgerPath, 'utf8'));
    const config = {
      schema: 'site_corridor_request.v1',
      anchor: {
        latitude: project.latitude,
        longitude: project.longitude,
        address: project.address,
        coordinateSystem: project.coordinateSystem || 'WGS84',
        anchorHash
      },
      frame_fps: options.frameFps || 4,
      scope: options.scope || 'route_visible_sides',
      visual_continuity: options.visualContinuity !== false,
      videos: videoAssets.map((asset) => ({ asset_id: asset.id, name: asset.name, path: asset.storedPath, sha256: asset.sha256 })),
      return_videos: (options.returnVideoAssets || []).map((asset) => ({ asset_id: asset.id, name: asset.name, path: asset.storedPath, sha256: asset.sha256 })),
      photos: (options.photoAssets || []).map((asset) => ({ asset_id: asset.id, name: asset.name, path: asset.storedPath, sha256: asset.sha256 })),
      panoramas: (options.panoramaAssets || []).map((asset) => ({ asset_id: asset.id, name: asset.name, path: asset.storedPath, sha256: asset.sha256 })),
      // The worker only decodes the ordered route clips.  Pass the complete
      // project video registry separately so the generated manifest can
      // distinguish all uploaded evidence (including unassigned field clips,
      // duplicate uploads and TEST ONLY records) from the geometry subset.
      all_project_videos: (options.allProjectVideoAssets || []).map((asset) => ({
        asset_id: asset.id,
        name: asset.name,
        path: asset.storedPath,
        sha256: asset.sha256,
        sourceNature: asset.sourceNature,
        testOnly: Boolean(asset.testOnly)
      })),
      supplemental_video: options.supplementalVideoAsset
        ? { asset_id: options.supplementalVideoAsset.id, name: options.supplementalVideoAsset.name, path: options.supplementalVideoAsset.storedPath, sha256: options.supplementalVideoAsset.sha256 }
        : null,
      master_ledger_path: jobLedgerPath,
      master_ledger_version: masterLedger.changeLog?.at(-1)?.version || null,
      main_building_artifact_id: mainBuildingArtifact?.id || null,
      main_building_path: mainBuildingArtifact?.storedPath || null,
      map_registration: {
        method: 'navigation_dimension_topology_first_then_field_video_metric_refinement',
        topologyFirst: true,
        dimensionEvidence: {
          fileName: 'amap-site-boundary-20261005.png',
          sha256: '844673463455B9403EE3C58D7CB5151AA7B451ADC8CA13AD4B6CCED6492CB7DC',
          siteBoundaryPixels: [[13, 104], [760, 104], [760, 632], [13, 632]],
          mainBuildingZonePixels: [[181, 183], [540, 183], [540, 444], [181, 444]]
        },
        annotated_map: {
          fileName: 'codex-clipboard-55ec86d8-949e-410a-b422-7230ddee795c.png',
          sha256: '45f98827c9d4d0d3e4ac8934c59936068c300ab2c3179ed07810828c9fa583dd'
        },
        base_map: {
          fileName: 'codex-clipboard-7d8a0e55-6da9-4279-bdfc-15917a9efbba.png',
          sha256: 'eee124fbbae4f037d51cbb676015e1d88251703f35fe3c207fc748d483cdf95c'
        }
      }
    };
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    const worker = options.rebuild === true
      ? path.join(rootDir, 'workers', 'site_corridor_rebuild_worker.py')
      : path.join(rootDir, 'workers', 'site_corridor_worker.py');
    const result = await runProcess(pythonCommand(), [worker, '--config', configPath, '--output-dir', jobDir]);
    const payload = lastJsonLine(result.stdout) || lastJsonLine(result.stderr);
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || '连续视频小道 Worker 失败');
    const corridor = payload.result;
    let corridorManifest = null;
    try {
      corridorManifest = JSON.parse(await fsp.readFile(corridor.outputs.manifest_json, 'utf8'));
    } catch {
      corridorManifest = null;
    }
    let finalSiteContextPath = corridor.outputs.site_context_glb;
    let blenderRefinement = null;
    emitJobEvent(job.id, 'tool.completed', { name: 'ffmpeg_trimesh', outputSummary: `${corridor.counts?.keyframes || 0} 个关键帧；连续路线 ${corridor.routeLengthM || 0}m` });
    if (options.useBlender) {
      job.stage = 'blender_refinement';
      job.progress = 78;
      await persist();
      emitJobEvent(job.id, 'step.started', { stepId: 'blender_refinement', title: 'Blender 综合场景倒角、PBR 材质与可编辑源文件生成' });
      const blenderOutputDir = path.join(jobDir, 'blender-refinement');
      const blenderTempDir = path.join(blenderOutputDir, 'temp');
      await fsp.mkdir(blenderTempDir, { recursive: true });
      const blenderWorker = path.join(rootDir, 'workers', 'blender_site_refine.py');
      const blenderResult = await runProcess(blenderBin, [
        '--background', '--python-exit-code', '1', '--python', blenderWorker, '--',
        '--source', corridor.outputs.site_context_glb,
        '--metadata', corridor.outputs.manifest_json,
        '--output-dir', blenderOutputDir,
        '--max-bevel-objects', String(options.maxBlenderBevelObjects ?? 900)
      ], { env: { TEMP: blenderTempDir, TMP: blenderTempDir } });
      const blenderPayload = lastJsonLine(blenderResult.stdout) || lastJsonLine(blenderResult.stderr);
      if (blenderResult.code !== 0 || !blenderPayload?.ok) {
        throw Object.assign(new Error(blenderPayload?.error || blenderResult.stderr.trim().slice(-1200) || 'Blender 综合场景精修失败'), { code: 'SITE_CORRIDOR_BLENDER_FAILED' });
      }
      blenderRefinement = blenderPayload.result;
      const blenderOutputs = blenderRefinement?.outputs || {};
      for (const outputKey of ['blend', 'glb', 'preview', 'manifest']) {
        const outputPath = path.resolve(String(blenderOutputs[outputKey] || ''));
        if (!storedPathIsInside(outputPath, blenderOutputDir)) throw Object.assign(new Error(`Blender 输出路径越界: ${outputKey}`), { code: 'SITE_CORRIDOR_BLENDER_OUTPUT_INVALID' });
        const outputStat = await fsp.stat(outputPath).catch(() => null);
        if (!outputStat?.isFile()) throw Object.assign(new Error(`Blender 缺少输出: ${outputKey}`), { code: 'SITE_CORRIDOR_BLENDER_OUTPUT_MISSING' });
      }
      finalSiteContextPath = path.resolve(blenderOutputs.glb);
      emitJobEvent(job.id, 'tool.completed', {
        name: 'blender',
        outputSummary: `Blender ${blenderRefinement.blenderVersion || ''}；倒角 ${blenderRefinement.refinement?.bevelAppliedCount || 0} 个；材质精修 ${blenderRefinement.tunedMaterialCount || 0} 个`
      });
    }
    job.stage = 'artifact_registration';
    job.progress = 88;
    emitJobEvent(job.id, 'step.started', { stepId: 'artifact_registration', title: '登记米制路线、GLB 与证据清单' });

    // Prepare the complete replacement set before touching the active result.
    // A worker or artifact failure must not make the previous model disappear.
    storedProject = store.projects.find((item) => item.id === project.id);
    previousCorridorArtifacts = store.artifacts
      .filter((artifact) => artifact.projectId === project.id && siteCorridorArtifactKinds.has(artifact.kind) && artifact.metadata?.stale !== true)
      .map(cloneStoreRecord);
    previousCorridorArtifactIds = new Set(previousCorridorArtifacts.map((artifact) => artifact.id));
    previousRouteObjects = store.sceneObjects
      .filter((object) => object.projectId === project.id && routeRoles.has(object.properties?.role) && object.properties?.stale !== true)
      .map(cloneStoreRecord);
    previousModelRegistration = cloneStoreRecord(storedProject?.modelRegistration);
    previousProjectUpdatedAt = storedProject?.updatedAt;

    // Carry the newest supplemental evidence binding onto every newly
    // generated corridor artifact.  Without this, a successful rerun would
    // appear to lose the six field images and four Reference articles until a
    // full server restart performed the migration backfill.
    let currentSupplementalReferenceMetadata = {};
    const currentReferenceArtifact = [...store.artifacts].reverse().find((artifact) =>
      artifact.projectId === project.id
      && artifact.kind === 'reference_source_manifest'
      && artifact.metadata?.stale !== true
      && artifact.storedPath
    );
    if (currentReferenceArtifact) {
      try {
        const currentReferenceManifest = JSON.parse(await fsp.readFile(currentReferenceArtifact.storedPath, 'utf8'));
        currentSupplementalReferenceMetadata = supplementalReferenceMetadata(currentReferenceManifest, currentReferenceArtifact.id);
      } catch {
        currentSupplementalReferenceMetadata = {};
      }
    }

    const commonMetadata = {
      schema: corridor.schema,
      sourceAssetIds: [...new Set([
        ...(options.allProjectVideoAssets || videoAssets).map((asset) => asset.id),
        ...(options.photoAssets || []).map((asset) => asset.id),
        ...(options.panoramaAssets || []).map((asset) => asset.id),
        ...(options.supplementalVideoAsset ? [options.supplementalVideoAsset.id] : [])
      ])],
      supplementalSourceAssetIds: [...new Set([
        ...(options.returnVideoAssets || []).map((asset) => asset.id),
        ...(options.photoAssets || []).map((asset) => asset.id),
        ...(options.panoramaAssets || []).map((asset) => asset.id),
        ...(options.supplementalVideoAsset ? [options.supplementalVideoAsset.id] : [])
      ])],
      allProjectVideoAssetIds: (options.allProjectVideoAssets || videoAssets).map((asset) => asset.id),
      unmappedFieldVideoAssetIds: (options.allProjectVideoAssets || [])
        .filter((asset) => !videoAssets.some((item) => item.id === asset.id)
          && !(options.returnVideoAssets || []).some((item) => item.id === asset.id)
          && asset.id !== options.supplementalVideoAsset?.id
          && !isLikelyTestAsset(asset))
        .map((asset) => asset.id),
      testVideoAssetIds: (options.allProjectVideoAssets || []).filter((asset) => isLikelyTestAsset(asset)).map((asset) => asset.id),
      masterLedgerPath: 'docs/site-reconstruction-master-ledger.json',
      masterLedgerVersion: JSON.parse(await fsp.readFile(path.join(jobDir, 'site-reconstruction-master-ledger.json'), 'utf8')).changeLog?.at(-1)?.version || null,
      sourceVideoOrder: corridor.videoOrder,
      returnVideoOrder: corridor.returnVideoOrder || [],
      mainBuildingArtifactId: mainBuildingArtifact?.id || null,
      coordinateSpace: 'local_enu_m',
      coordinateStatus: 'approximate_registration',
      registrationMethod: corridor.registrationMethod,
      navigationTopologyMethod: corridorManifest?.navigationTopologyMethod || 'navigation_dimension_topology_first_then_field_video_metric_refinement',
      topologyFirst: corridorManifest?.topologyFirst === true,
      navigationZoneAudit: corridorManifest?.navigationZoneAudit
        || corridorManifest?.scene?.navigation_zone_audit
        || corridorManifest?.scene?.spatial_validation?.navigationZoneAudit
        || null,
      navigationSpatialValidation: corridorManifest?.scene?.spatial_validation || null,
      navigationZonePlacementConflictCount: Number(
        corridorManifest?.scene?.spatial_validation?.navigationZonePlacementConflictCount
        ?? corridorManifest?.scene?.navigationZonePlacementConflictCount
        ?? corridorManifest?.navigationZoneAudit?.placementConflicts?.length
        ?? 0
      ),
      navigationZoneRouteConflictCount: Number(
        Array.isArray(corridorManifest?.scene?.spatial_validation?.navigationZoneRouteAudits)
          ? corridorManifest.scene.spatial_validation.navigationZoneRouteAudits.filter((item) => item?.conflict).length
          : corridorManifest?.navigationZoneAudit?.routeConflicts?.length
            ?? 0
      ),
      navigationZoneAutomaticRelocationCount: Number(
        corridorManifest?.scene?.spatial_validation?.navigationZoneAutomaticRelocationCount
        ?? corridorManifest?.navigationZoneAudit?.automaticRelocationCount
        ?? 0
      ),
      navigationZoneAuditPolicy: corridorManifest?.scene?.spatial_validation?.navigationZonePolicy
        || corridorManifest?.navigationZoneAudit?.policy
        || null,
      navigationDimensionPolicy: corridorManifest?.navigationDimensionPolicy || corridorManifest?.navigationTopologyBaseline?.dimensionPolicy || null,
      navigationDimensionAnchors: corridorManifest?.navigationDimensionAnchors || corridorManifest?.scene?.navigationDimensionAnchors || [],
      relativePlanDimensionsApplied: corridorManifest?.relativePlanDimensionsApplied === true,
      navigationTopologyBaseline: corridorManifest?.navigationTopologyBaseline || null,
      navigationTopologyEvidenceArtifact: corridorManifest?.navigationTopologyEvidenceArtifact || null,
      navigationDimensionEvidence: corridorManifest?.navigationTopologyBaseline?.evidence?.find((item) => item?.fileName === 'amap-site-boundary-20261005.png') || null,
      evidenceInventory: corridorManifest?.evidenceInventory || null,
      anchorHash,
      surveyGrade: false,
      routeLengthM: corridor.routeLengthM,
      // Keep the ordinary-photo and panorama channels separate, but also
      // publish the complete field-image inventory.  The old metadata exposed
      // only `photoEvidenceCount` (24 after removing 11 panoramas), which was
      // easy to misread as the project having only 24 images.
      ordinaryPhotoEvidenceCount: Array.isArray(options.photoAssets) ? options.photoAssets.length : 0,
      panoramaEvidenceCount: Array.isArray(options.panoramaAssets) ? options.panoramaAssets.length : 0,
      fieldImageEvidenceCount: (Array.isArray(options.photoAssets) ? options.photoAssets.length : 0)
        + (Array.isArray(options.panoramaAssets) ? options.panoramaAssets.length : 0),
      fieldImageRawAssetCount: (Array.isArray(options.photoAssets) ? options.photoAssets.length : 0)
        + (Array.isArray(options.panoramaAssets) ? options.panoramaAssets.length : 0),
      fieldImageUniqueSha256Count: new Set([
        ...(options.photoAssets || []).map((asset) => asset.sha256 || asset.id),
        ...(options.panoramaAssets || []).map((asset) => asset.sha256 || asset.id)
      ]).size,
      allProjectVideoAssetCount: (options.allProjectVideoAssets || videoAssets).length,
      fieldVideoAssetCount: (options.allProjectVideoAssets || videoAssets).filter((asset) => !isLikelyTestAsset(asset)).length,
      testVideoAssetCount: (options.allProjectVideoAssets || []).filter((asset) => isLikelyTestAsset(asset)).length,
      uniqueProjectVideoSha256Count: new Set((options.allProjectVideoAssets || videoAssets).map((asset) => asset.sha256 || asset.id)).size,
      routeMainVideoAssetCount: videoAssets.length,
      routeReturnVideoAssetCount: (options.returnVideoAssets || []).length,
      unmappedFieldVideoAssetCount: (options.allProjectVideoAssets || []).filter((asset) => !isLikelyTestAsset(asset)
        && !videoAssets.some((item) => item.id === asset.id)
        && !(options.returnVideoAssets || []).some((item) => item.id === asset.id)
        && asset.id !== options.supplementalVideoAsset?.id).length,
      mainBuildingSourceGeometryPreserved: corridor.scene?.building_registration?.sourceGeometryPreserved === true,
      mainBuildingSourceGeometryNodeCount: corridor.scene?.building_registration?.sourceGeometryAddedNodeCount
        ?? corridor.scene?.building_registration?.sourceGeometryNodeCount
        ?? 0,
      mainBuildingSourceGeometryIncludedInSiteContext: Boolean(
        corridor.scene?.source_geometry_included === true
        || corridor.scene?.building_registration?.interiorModelIncludedInSiteContext === true
        || Number(corridor.scene?.building_registration?.sourceGeometryAddedNodeCount || 0) > 0
      ),
      mainBuildingInteriorIncludedInSiteContext: corridor.scene?.building_registration?.interiorModelIncludedInSiteContext === true,
      mainBuildingInteriorSeparate: corridor.scene?.building_registration?.interiorModelSeparate === true
        || corridor.scene?.building_registration?.interiorModelKeptAsSeparateArtifact === true,
      staticRepresentativeVehicles: corridor.counts?.staticRepresentativeVehicles || 0,
      detailCounts: corridor.scene?.detail_counts || {},
      ...(() => {
        const split = classifyCurrentSiteDetailCounts(corridor.scene?.detail_counts || {});
        return {
          currentStateDetailCounts: split.currentState,
          historicalConstructionDetailCounts: split.historicalConstruction,
          currentStatePolicy: '施工围挡、塔吊、临时框架只保留为历史证据；现状展示默认隐藏，不参与现状空间分析。'
        };
      })(),
      blenderRefined: Boolean(blenderRefinement),
      blenderVersion: blenderRefinement?.blenderVersion || null,
      ...currentSupplementalReferenceMetadata,
      stale: false
    };
    const artifactDefinitions = [
      ['site_context_glb', blenderRefinement ? 'Blender 精修建筑周边小道 GLB' : '连续视频建筑周边小道 GLB', finalSiteContextPath, 'Hypothesis'],
      ...(corridor.outputs.interior_model_glb ? [
        ['site_interior_model_glb', '主建筑独立室内 CAD/BIM GLB', corridor.outputs.interior_model_glb, 'Derived']
      ] : []),
      ...(blenderRefinement ? [
        ['site_context_source_glb', 'Blender 精修前周边小道源 GLB', corridor.outputs.site_context_glb, 'Hypothesis'],
        ['site_context_blend', '建筑周边场景 Blender 可编辑源文件', blenderRefinement.outputs.blend, 'Hypothesis'],
        ['site_context_blender_preview', '建筑周边场景 Blender 晴天预览', blenderRefinement.outputs.preview, 'Hypothesis'],
        ['site_context_blender_manifest', '建筑周边场景 Blender 精修清单', blenderRefinement.outputs.manifest, 'Derived']
      ] : []),
      ['site_route_geojson', '建筑周边小道米制路线 GeoJSON', corridor.outputs.route_geojson, 'Hypothesis'],
      ['site_camera_track_json', '连续视频相机轨迹 JSON', corridor.outputs.camera_track_json, 'Hypothesis'],
      ['site_keyframes_manifest', '连续视频关键帧与哈希清单', corridor.outputs.keyframes_manifest_json, 'Derived'],
      ['site_keyframes_zip', '连续视频关键帧 ZIP', corridor.outputs.keyframes_zip, 'Observed'],
      ['site_boundary_registration', '六处片段边界配准清单', corridor.outputs.boundary_registration_json, 'Hypothesis'],
      ['site_material_manifest', '周边小道近似 PBR 材质清单', corridor.outputs.materials_manifest_json, 'Hypothesis'],
      ['site_detail_manifest', '周边环境设施与视频证据清单', corridor.outputs.details_manifest_json, 'Hypothesis'],
      ['site_field_evidence_manifest', '补充照片与固定机位视频证据清单', corridor.outputs.field_evidence_manifest_json, 'Derived'],
      ...(corridor.outputs.panorama_sampling_manifest_json ? [['site_panorama_sampling_manifest', '约10米全景采样与双通道校正清单', corridor.outputs.panorama_sampling_manifest_json, 'Derived']] : []),
      ['site_registration_manifest', '主楼、路线与地理锚点配准清单', corridor.outputs.registration_manifest_json, 'Hypothesis'],
      ...(corridor.outputs.capture_station_register_json ? [['site_capture_station_register', '采景站点与跨批次空间身份登记', corridor.outputs.capture_station_register_json, 'Derived']] : []),
      ['site_corridor_preview', '连续视频小道重建预览图', corridor.outputs.preview_png, 'Hypothesis'],
      ['site_corridor_manifest', '连续视频小道重建总清单', corridor.outputs.manifest_json, 'Hypothesis'],
      ['site_master_ledger', '19条问题与验收总控台账', jobLedgerPath, 'Derived']
    ];
    for (const [kind, _title, storedPath] of artifactDefinitions) {
      const resolvedOutput = path.resolve(String(storedPath || ''));
      if (!storedPathIsInside(resolvedOutput, jobDir)) {
        throw Object.assign(new Error(`连续小道输出路径越界: ${kind}`), { code: 'SITE_CORRIDOR_OUTPUT_INVALID' });
      }
      const outputStat = await fsp.stat(resolvedOutput).catch(() => null);
      if (!outputStat?.isFile()) {
        throw Object.assign(new Error(`连续小道缺少输出文件: ${kind}`), { code: 'SITE_CORRIDOR_OUTPUT_MISSING' });
      }
    }
    const producedArtifacts = [];
    for (const [kind, title, storedPath, evidenceLevel] of artifactDefinitions) {
      const buildingMetadata = mainBuildingArtifact?.metadata || {};
      const artifact = await addArtifact({
        projectId: project.id,
        jobId: job.id,
        kind,
        title,
        storedPath,
        evidenceLevel,
        metadata: {
          ...commonMetadata,
          ...(kind === 'site_context_glb' ? {
            geometryCount: blenderRefinement?.meshCount ?? corridor.scene?.geometry_count,
            outputBytes: (await fsp.stat(finalSiteContextPath)).size,
            mainBuildingHalfExtentsM: corridor.scene?.building_half_extents_m || null,
            mainBuildingHeightM: corridor.scene?.building_height_m ?? null,
            exteriorShellOnly: corridor.scene?.exterior_shell_only === true,
            exteriorShellPolicy: corridor.scene?.exterior_shell_only === true
              ? '周边场景只显示主楼外壳；CAD室内墙、柱、家具和语义对象保留在独立室内模型中。'
              : null,
            georeferenced: false,
            axes: 'Y-up GLB',
            buildingSchema: buildingMetadata.schema || null,
            buildingAxes: buildingMetadata.axes || null,
            wallHeightM: buildingMetadata.wallHeightM ?? null,
            floorSlabThicknessM: buildingMetadata.floorSlabThicknessM ?? null,
            floorCount: buildingMetadata.floorCount ?? buildingMetadata.levelCount ?? null,
            levelCount: buildingMetadata.levelCount ?? buildingMetadata.floorCount ?? null,
            levels: Array.isArray(buildingMetadata.levels) ? buildingMetadata.levels : [],
            openingCounts: buildingMetadata.openingCounts || null,
            resolvedOpeningCounts: buildingMetadata.resolvedOpeningCounts || null,
            windowFrameCount: buildingMetadata.windowFrameCount ?? null,
            selectedFurnitureCount: buildingMetadata.selectedFurnitureCount ?? null,
            selectedSemanticObjectCount: buildingMetadata.selectedSemanticObjectCount ?? null,
            categoryCounts: buildingMetadata.categoryCounts || {},
            semanticLegend: buildingMetadata.semanticLegend || {},
            blenderRefinement: blenderRefinement ? {
              schema: blenderRefinement.schema,
              blenderVersion: blenderRefinement.blenderVersion,
              sourceSha256: blenderRefinement.sourceSha256,
              outputSha256: blenderRefinement.outputSha256,
              bevelAppliedCount: blenderRefinement.refinement?.bevelAppliedCount || 0,
              smoothObjectCount: blenderRefinement.refinement?.smoothObjectCount || 0,
              tunedMaterialCount: blenderRefinement.tunedMaterialCount || 0,
              materialProfiles: blenderRefinement.materialProfiles || {},
              geometryEvidenceLevel: blenderRefinement.geometryEvidenceLevel,
              materialFinishEvidenceLevel: blenderRefinement.materialFinishEvidenceLevel,
              dataGaps: blenderRefinement.dataGaps || []
            } : null
          } : {}),
          ...(kind === 'site_interior_model_glb' ? {
            geometryCount: corridor.scene?.building_registration?.interiorModelNodeCount
              ?? corridor.scene?.building_registration?.sourceGeometryNodeCount
              ?? null,
            outputBytes: (await fsp.stat(storedPath)).size,
            interiorModel: true,
            exteriorShellOnly: false,
            interiorModelIncludedInSiteContext: false,
            interiorModelSeparate: true,
            sourceGeometryPreserved: corridor.scene?.building_registration?.sourceGeometryPreserved === true,
            sourceGeometryNodeCount: corridor.scene?.building_registration?.sourceGeometryNodeCount ?? null,
            axes: 'Y-up GLB',
            buildingSchema: buildingMetadata.schema || null,
            buildingAxes: buildingMetadata.axes || null,
            wallHeightM: buildingMetadata.wallHeightM ?? null,
            floorSlabThicknessM: buildingMetadata.floorSlabThicknessM ?? null,
            floorCount: buildingMetadata.floorCount ?? buildingMetadata.levelCount ?? null,
            levelCount: buildingMetadata.levelCount ?? buildingMetadata.floorCount ?? null,
            levels: Array.isArray(buildingMetadata.levels) ? buildingMetadata.levels : [],
            openingCounts: buildingMetadata.openingCounts || null,
            resolvedOpeningCounts: buildingMetadata.resolvedOpeningCounts || null,
            windowFrameCount: buildingMetadata.windowFrameCount ?? null,
            selectedFurnitureCount: buildingMetadata.selectedFurnitureCount ?? null,
            selectedSemanticObjectCount: buildingMetadata.selectedSemanticObjectCount ?? null,
            categoryCounts: buildingMetadata.categoryCounts || {},
            semanticLegend: buildingMetadata.semanticLegend || {}
          } : {})
        }
      });
      producedArtifacts.push(artifact);
      producedArtifactIds.add(artifact.id);
    }
    const routeArtifact = producedArtifacts.find((artifact) => artifact.kind === 'site_route_geojson');
    const routeDocument = JSON.parse(await fsp.readFile(corridor.outputs.route_geojson, 'utf8'));
    const routeFeatures = (routeDocument.features || [])
      .filter((feature) => ['site_walkway_route', 'site_context_panorama_outer_lane', 'site_return_route_to_two_gates'].includes(feature?.properties?.role))
      .filter((feature) => feature?.geometry?.type === 'LineString' && Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length >= 2);
    if (!routeFeatures.length) throw new Error('路线 GeoJSON 缺少有效的 site_walkway_route LineString');
    const routeObjects = routeFeatures.map((routeFeature) => {
      const routeId = String(routeFeature.id || `site-walkway-route-${routeFeatures.indexOf(routeFeature) + 1}`);
      const existingObject = store.sceneObjects.find((item) => item.projectId === project.id && item.id === routeId);
      const routeRole = routeFeature.properties?.role || 'site_walkway_route';
      const displayContinuity = routeFeature.properties?.displayContinuity || 'single_continuous_route';
      const label = routeRole === 'site_return_route_to_two_gates'
        ? '第二岔路口返回两个门的连续小道'
        : routeId === 'site-walkway-route-main'
        ? '建筑周边连续主路线'
        : routeRole === 'site_context_panorama_outer_lane' || displayContinuity === 'separate_parallel_context_lane'
          ? '栅栏外侧全景平行小道'
          : String(routeFeature.properties?.label || routeFeature.properties?.detail || routeId);
      const routeObject = {
        id: routeId,
        projectId: project.id,
        type: 'walkway',
        label,
        geometry: routeFeature.geometry,
        properties: {
          ...(routeFeature.properties || {}),
          role: routeRole === 'site_return_route_to_two_gates' ? 'site_return_route_to_two_gates' : 'site_walkway_route',
          routeRole,
          coordinateSpace: 'local_enu_m',
          source: routeFeature.properties?.source || 'annotated_map_screenshot_plus_ordered_field_videos',
          sourceArtifactId: routeArtifact.id,
          anchorHash,
          registrationVersion: corridor.schema,
          stale: false
        },
        evidenceLevel: routeFeature.properties?.evidenceLevel || 'Hypothesis',
        sourceAssetIds: Array.isArray(routeFeature.properties?.sourceAssetIds)
          ? routeFeature.properties.sourceAssetIds
          : videoAssets.map((asset) => asset.id),
        createdAt: existingObject?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      return routeObject;
    });
    const routeObject = routeObjects.find((item) => item.id === 'site-walkway-route-main') || routeObjects[0];

    const siteContextArtifact = producedArtifacts.find((artifact) => artifact.kind === 'site_context_glb');
    const currentOsmContext = [...recordsForProject(store.artifacts, project.id)].reverse()
      .find((artifact) => artifact.kind === 'osm_context_glb' && artifact.metadata?.stale !== true);
    if (storedProject && mainBuildingArtifact && currentOsmContext && siteContextArtifact) {
      const previousRegistration = storedProject.modelRegistration || {};
      const preserveTransform = previousRegistration.contextArtifactId === currentOsmContext.id
        && previousRegistration.modelArtifactId === mainBuildingArtifact.id;
      nextModelRegistration = {
        modelArtifactId: mainBuildingArtifact.id,
        contextArtifactId: currentOsmContext.id,
        siteContextArtifactId: siteContextArtifact.id,
        offsetXM: preserveTransform ? Number(previousRegistration.offsetXM || 0) : 0,
        offsetZM: preserveTransform ? Number(previousRegistration.offsetZM || 0) : 0,
        rotationDeg: preserveTransform ? Number(previousRegistration.rotationDeg || 0) : 0,
        scale: preserveTransform ? Number(previousRegistration.scale || 1) : 1,
        evidenceLevel: 'Hypothesis',
        updatedAt: new Date().toISOString()
      };
    }

    // Commit only after every artifact, route and registration input has been
    // validated.  This is the single point where the previous active result is
    // retired, so a failure above leaves it visible and addressable.
    registrationCommitStarted = true;
    const staleAt = new Date().toISOString();
    for (const artifact of store.artifacts) {
      if (!previousCorridorArtifactIds.has(artifact.id)) continue;
      artifact.metadata = { ...(artifact.metadata || {}), stale: true, staleReason: 'superseded_by_new_site_corridor', staleAt };
    }
    const routeObjectById = new Map(routeObjects.map((object) => [object.id, object]));
    for (const [index, object] of store.sceneObjects.entries()) {
      if (object.projectId !== project.id || !routeRoles.has(object.properties?.role)) continue;
      const replacement = routeObjectById.get(object.id);
      if (replacement) store.sceneObjects[index] = replacement;
    }
    const existingRouteIds = new Set(store.sceneObjects
      .filter((object) => object.projectId === project.id && routeRoles.has(object.properties?.role) && object.properties?.stale !== true)
      .map((object) => object.id));
    for (const object of routeObjects) {
      if (!existingRouteIds.has(object.id)) store.sceneObjects.push(object);
    }
    if (storedProject && nextModelRegistration) {
      storedProject.modelRegistration = nextModelRegistration;
      storedProject.updatedAt = new Date().toISOString();
      if (store.activeProjectId === storedProject.id) store.project = storedProject;
    }
    registrationCommitted = true;

    job.output = {
      schema: corridor.schema,
      routeObjectId: routeObject.id,
      routeLengthM: corridor.routeLengthM,
      alignmentStatus: corridor.alignmentStatus,
      surveyGrade: false,
      counts: corridor.counts,
      blenderRefinement: blenderRefinement ? {
        schema: blenderRefinement.schema,
        blenderVersion: blenderRefinement.blenderVersion,
        bevelAppliedCount: blenderRefinement.refinement?.bevelAppliedCount || 0,
        smoothObjectCount: blenderRefinement.refinement?.smoothObjectCount || 0,
        tunedMaterialCount: blenderRefinement.tunedMaterialCount || 0
      } : null,
      artifacts: producedArtifacts.map(publicArtifact)
    };
    job.status = 'succeeded';
    job.stage = 'completed';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    for (const artifact of producedArtifacts) emitJobEvent(job.id, 'artifact.created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
    emitJobEvent(job.id, 'job.completed', { outputSummary: `${blenderRefinement ? 'Blender 精修 GLB' : '连续小道 GLB'} 与 ${Math.round(corridor.routeLengthM || 0)}m 米制路线已生成；状态为近似配准` });
  } catch (error) {
    // Remove partially registered artifacts on every failure. If the commit
    // crossed the retirement point, restore the complete prior active set as
    // well, including route objects and project registration.
    if (producedArtifactIds.size) {
      store.artifacts = store.artifacts.filter((artifact) => !producedArtifactIds.has(artifact.id));
    }
    if (registrationCommitStarted || registrationCommitted) {
      const previousRouteIds = new Set(previousRouteObjects.map((object) => object.id));
      store.sceneObjects = store.sceneObjects.filter((object) => {
        if (object.projectId !== project.id) return true;
        if (previousRouteIds.has(object.id)) return false;
        return !producedArtifactIds.has(object.properties?.sourceArtifactId);
      });
      store.sceneObjects.push(...previousRouteObjects.map(cloneStoreRecord));
      for (const snapshot of store.artifacts) {
        if (!previousCorridorArtifactIds.has(snapshot.id)) continue;
        const previous = previousCorridorArtifacts.find((artifact) => artifact.id === snapshot.id);
        if (previous) Object.assign(snapshot, cloneStoreRecord(previous));
      }
    }
    if (storedProject) {
      if (previousModelRegistration === undefined) delete storedProject.modelRegistration;
      else storedProject.modelRegistration = cloneStoreRecord(previousModelRegistration);
      if (previousProjectUpdatedAt === undefined) delete storedProject.updatedAt;
      else storedProject.updatedAt = previousProjectUpdatedAt;
      if (store.activeProjectId === storedProject.id) store.project = storedProject;
    }
    job.status = 'failed';
    job.error = error.message;
    job.diagnostics = [...(job.diagnostics || []), error.message];
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'step.failed', { stepId: job.stage || 'site_corridor', error: error.message, recoverable: true });
  }
  await persist();
}

async function runSemanticExtractionJob(job, asset, labels, thresholds) {
  const project = projectForJob(job);
  const sourceNature = inferredSourceNature(asset);
  const testOnly = sourceNature === 'virtual_test';
  const jobDir = path.join(artifactDir, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  job.status = 'running';
  job.stage = 'grounding_dino';
  job.startedAt = new Date().toISOString();
  await persist();
  emitJobEvent(job.id, 'step.started', { stepId: 'grounding_dino', title: 'Grounding DINO 文本引导检测' });
  try {
    const worker = path.join(rootDir, 'workers', 'semantic_worker.py');
    const result = await runProcess(pythonCommand(), [
      worker,
      '--image', asset.storedPath,
      '--grounding-model', groundingDinoModel,
      '--sam2-model', sam2Model,
      '--labels-json', JSON.stringify(labels),
      '--output-dir', jobDir,
      '--box-threshold', String(thresholds.box),
      '--text-threshold', String(thresholds.text),
      '--max-detections', String(thresholds.maxDetections),
      '--device', String(process.env.SEMANTIC_DEVICE || 'auto')
    ]);
    const payload = lastJsonLine(result.stdout) || lastJsonLine(result.stderr);
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || '语义识别 Worker 失败');
    const semantic = payload.result;
    job.stage = 'sam2';
    emitJobEvent(job.id, 'tool.completed', { name: 'grounding_dino', outputSummary: `${semantic.count} 个文本引导候选框` });
    emitJobEvent(job.id, 'step.started', { stepId: 'sam2', title: 'SAM 2 生成逐对象掩膜' });
    const overlayArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'semantic_overlay', title: 'Grounding DINO + SAM 2 语义叠加图',
      storedPath: semantic.outputs.overlay, evidenceLevel: 'Derived',
      metadata: { schema: semantic.schema, sourceAssetId: asset.id, sourceNature, testOnly, count: semantic.count, labels, coordinateSpace: semantic.coordinate_space, models: semantic.models, thresholds: semantic.thresholds, dataGaps: semantic.data_gaps }
    });
    const detectionsArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'semantic_candidates', title: '二维语义候选 JSON',
      storedPath: semantic.outputs.detections, evidenceLevel: 'Derived',
      metadata: { schema: 'semantic_candidates.v1', sourceAssetId: asset.id, sourceNature, testOnly, count: semantic.count, coordinateSpace: semantic.coordinate_space }
    });
    const manifestArtifact = await addArtifact({
      projectId: project.id, jobId: job.id, kind: 'semantic_manifest', title: '语义识别模型与哈希清单',
      storedPath: semantic.manifest, evidenceLevel: 'Derived', metadata: { schema: semantic.schema, sourceAssetId: asset.id, sourceNature, testOnly, hashes: semantic.hashes }
    });
    const detectionsPayload = JSON.parse(await fsp.readFile(semantic.outputs.detections, 'utf8'));
    const candidates = (detectionsPayload.detections || []).map((candidate) => ({
      ...candidate,
      projectId: project.id,
      sourceAssetId: asset.id,
      sourceNature,
      testOnly,
      jobId: job.id,
      overlayArtifactId: overlayArtifact.id,
      status: 'candidate_2d',
      evidenceLevel: 'Derived',
      createdAt: new Date().toISOString()
    }));
    store.semanticCandidates = store.semanticCandidates.filter((item) => item.jobId !== job.id).concat(candidates);
    job.output = {
      count: semantic.count,
      labels,
      sourceNature,
      testOnly,
      coordinateSpace: semantic.coordinate_space,
      dataGaps: semantic.data_gaps,
      candidateIds: candidates.map((candidate) => candidate.id),
      artifacts: [overlayArtifact, detectionsArtifact, manifestArtifact].map(publicArtifact)
    };
    job.status = 'succeeded';
    job.stage = 'completed';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'tool.completed', { name: 'sam2', outputSummary: `${semantic.count} 个二维掩膜候选；尚未映射三维` });
    for (const artifact of [overlayArtifact, detectionsArtifact, manifestArtifact]) {
      emitJobEvent(job.id, 'artifact.created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
    }
    emitJobEvent(job.id, 'job.completed', { outputSummary: `已生成 ${semantic.count} 个真实二维语义候选，等待人工/标定映射` });
  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.diagnostics = [...(job.diagnostics || []), error.message];
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'step.failed', { stepId: job.stage || 'grounding_dino', error: error.message, recoverable: true });
  }
  await persist();
}

async function runCadConversionJob(job, asset) {
  const project = projectForJob(job);
  const jobDir = path.join(artifactDir, job.id);
  await fsp.mkdir(jobDir, { recursive: true });
  job.status = 'running';
  job.stage = 'source_parse';
  job.startedAt = new Date().toISOString();
  asset.status = 'processing';
  await persist();
  emitJobEvent(job.id, 'job.started', { title: `${job.sourceFormat.toUpperCase()} 真实转换` });
  emitJobEvent(job.id, 'step.started', { stepId: 'source_parse', title: `解析 ${asset.name}` });
  try {
    const sourceMetadata = { sourceAssetId: asset.id, sourceAssetName: asset.name, sourceSha256: asset.sha256 };
    const artifacts = [];
    let result;
    let lastStage = '';
    const onProgress = (progress = {}) => {
      const stage = String(progress.stage || 'source_parse');
      job.stage = stage;
      if (Number.isFinite(progress.current) && Number.isFinite(progress.total) && progress.total > 0) {
        job.progress = Math.max(1, Math.min(92, Math.round(progress.current / progress.total * 90)));
      }
      if (stage !== lastStage) {
        lastStage = stage;
        emitJobEvent(job.id, 'step.started', { stepId: stage, title: progress.message || `执行 ${stage}` });
      }
    };
    if (job.sourceFormat === 'skp') {
      const glbPath = path.join(jobDir, `${path.parse(asset.name).name}.glb`);
      result = await convertSkpToGlb({ inputPath: asset.storedPath, outputPath: glbPath, onProgress });
      const artifact = await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'skp_glb',
        title: `${path.parse(asset.name).name} · SKP 网页三维模型`, storedPath: glbPath,
        evidenceLevel: 'Derived', metadata: { ...sourceMetadata, ...result }
      });
      artifacts.push(artifact);
    } else if (job.sourceFormat === 'dwg') {
      const baseName = path.parse(asset.name).name;
      const glbPath = path.join(jobDir, `${baseName}-plan.glb`);
      const geojsonPath = path.join(jobDir, `${baseName}-plan.geojson`);
      result = await convertDwgToPlan({ inputPath: asset.storedPath, glbPath, geojsonPath, onProgress });
      const glbArtifact = await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'dwg_plan_glb',
        title: `${baseName} · DWG 平面校核层`, storedPath: glbPath,
        evidenceLevel: 'Derived', metadata: { ...sourceMetadata, ...result }
      });
      const geojsonArtifact = await addArtifact({
        projectId: project.id, jobId: job.id, kind: 'dwg_plan_geojson',
        title: `${baseName} · DWG 分层线稿 GeoJSON`, storedPath: geojsonPath,
        evidenceLevel: 'Derived', metadata: { ...sourceMetadata, ...result, schema: 'cad_plan_reference.v1' }
      });
      artifacts.push(glbArtifact, geojsonArtifact);
    } else {
      throw new Error(`不支持的 CAD 源格式: ${job.sourceFormat}`);
    }
    asset.status = 'ready';
    asset.derivedArtifactIds = artifacts.map((artifact) => artifact.id);
    asset.conversion = { jobId: job.id, result };
    job.output = { result, artifacts: artifacts.map(publicArtifact) };
    job.status = 'succeeded';
    job.stage = 'completed';
    job.progress = 100;
    job.completedAt = new Date().toISOString();
    for (const artifact of artifacts) emitJobEvent(job.id, 'artifact.created', { artifactId: artifact.id, kind: artifact.kind, title: artifact.title });
    emitJobEvent(job.id, 'job.completed', { outputSummary: `${asset.name} 已转换为 ${artifacts.length} 个真实网页资产` });
  } catch (error) {
    asset.status = 'failed';
    asset.conversion = { jobId: job.id, error: error.message };
    job.status = 'failed';
    job.error = error.message;
    job.diagnostics = [...(job.diagnostics || []), error.message];
    job.completedAt = new Date().toISOString();
    emitJobEvent(job.id, 'step.failed', { stepId: job.stage || 'source_parse', error: error.message, recoverable: true });
  }
  await persist();
}

const uploadTypes = new Map(Object.entries({
  '.mp4': { type: 'video', mime: ['video/mp4', 'application/mp4', 'application/octet-stream'] },
  '.mov': { type: 'video', mime: ['video/quicktime', 'application/octet-stream'] },
  '.mkv': { type: 'video', mime: ['video/x-matroska', 'video/mkv', 'application/octet-stream'] },
  '.webm': { type: 'video', mime: ['video/webm', 'application/octet-stream'] },
  '.avi': { type: 'video', mime: ['video/x-msvideo', 'video/avi', 'application/octet-stream'] },
  '.jpg': { type: 'image', mime: ['image/jpeg'] }, '.jpeg': { type: 'image', mime: ['image/jpeg'] },
  '.png': { type: 'image', mime: ['image/png'] }, '.webp': { type: 'image', mime: ['image/webp'] },
  '.tif': { type: 'image', mime: ['image/tiff', 'application/octet-stream'] }, '.tiff': { type: 'image', mime: ['image/tiff', 'application/octet-stream'] },
  '.glb': { type: '3d', mime: ['model/gltf-binary', 'application/octet-stream'] },
  '.gltf': { type: '3d', mime: ['model/gltf+json', 'application/json', 'text/plain', 'application/octet-stream'] },
  '.obj': { type: '3d', mime: ['model/obj', 'text/plain', 'application/octet-stream'] },
  '.fbx': { type: '3d', mime: ['application/octet-stream'] }, '.ply': { type: '3d', mime: ['text/plain', 'application/octet-stream'] },
  '.las': { type: '3d', mime: ['application/octet-stream'] }, '.laz': { type: '3d', mime: ['application/octet-stream'] },
  '.spz': { type: '3d', mime: ['application/octet-stream'] },
  '.skp': { type: 'cad', mime: ['application/octet-stream', 'application/vnd.sketchup.skp'] },
  '.dwg': { type: 'cad', mime: ['application/octet-stream', 'application/acad', 'application/x-acad', 'application/autocad_dwg', 'image/vnd.dwg'] },
  '.pdf': { type: 'document', mime: ['application/pdf'] },
  '.docx': { type: 'document', mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip', 'application/octet-stream'] },
  '.pptx': { type: 'document', mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream'] },
  '.xlsx': { type: 'document', mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip', 'application/octet-stream'] },
  '.csv': { type: 'document', mime: ['text/csv', 'text/plain', 'application/vnd.ms-excel'] },
  '.txt': { type: 'document', mime: ['text/plain'] }, '.md': { type: 'document', mime: ['text/markdown', 'text/plain'] },
  '.geojson': { type: 'document', mime: ['application/geo+json', 'application/json', 'text/plain'] }
}));

function uploadDescriptor(file) {
  return uploadTypes.get(path.extname(file.originalname || '').toLowerCase()) || null;
}

function classifyAsset(file) {
  return uploadDescriptor(file)?.type || null;
}

function uploadError(code, message, status = 415) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function storedPathIsInside(filePath, baseDir) {
  const relative = path.relative(path.resolve(baseDir), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const responseMimeByExtension = new Map([
  ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'], ['.json', 'application/json'],
  ['.geojson', 'application/geo+json'], ['.csv', 'text/csv; charset=utf-8'], ['.pdf', 'application/pdf'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.ply', 'application/octet-stream'], ['.spz', 'application/octet-stream'],
  ['.skp', 'application/octet-stream'], ['.dwg', 'application/octet-stream'], ['.blend', 'application/octet-stream']
]);

async function sendStoredFile(req, res, record, baseDir) {
  if (!record?.storedPath || !storedPathIsInside(record.storedPath, baseDir)) {
    return res.status(404).json(errorBody('STORED_FILE_NOT_FOUND', '该文件不属于允许的存储边界'));
  }
  try {
    await fsp.access(record.storedPath, fs.constants.R_OK);
  } catch {
    return res.status(404).json(errorBody('STORED_FILE_NOT_FOUND', '文件不存在或不可读'));
  }
  let servedPath = record.storedPath;
  if (req.query?.lod === 'preview' && path.extname(record.storedPath).toLowerCase() === '.glb') {
    const previewPath = `${record.storedPath}.preview.glb`;
    if (storedPathIsInside(previewPath, baseDir)) {
      try {
        await fsp.access(previewPath, fs.constants.R_OK);
        servedPath = previewPath;
        res.setHeader('X-GLB-LOD', 'preview');
      } catch {
        // Preview LOD is optional; fall back to the registered full GLB.
      }
    }
  }
  const displayName = String(record.name || record.title || path.basename(servedPath)).replace(/[\r\n"]/g, '_');
  const mime = record.mimeType || responseMimeByExtension.get(path.extname(servedPath).toLowerCase()) || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(displayName)}`);
  // Artifact URLs are immutable IDs: allowing the browser to keep the binary
  // avoids downloading and reparsing a 26 MB GLB every time the workspace is
  // reopened.  Keep the encoding variant in the cache key for gzip responses.
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  // GLB is already a binary container but still compresses well on the wire.
  // Use a sidecar only when it is newer than the source and the browser
  // advertises gzip; the decompressed bytes seen by GLTFLoader are unchanged.
  const acceptsGzip = String(req?.headers?.['accept-encoding'] || '').toLowerCase().includes('gzip');
  const extension = path.extname(servedPath).toLowerCase();
  if (extension === '.glb') {
    res.setHeader('X-GLB-Accept', String(req?.headers?.['accept-encoding'] || 'none'));
    res.setHeader('Vary', 'Accept-Encoding');
  }
  if (acceptsGzip && extension === '.glb') {
    const compressedPath = `${servedPath}.gz`;
    try {
      const [sourceStat, compressedStat] = await Promise.all([
        fsp.stat(servedPath),
        fsp.stat(compressedPath)
      ]);
      // Filesystems can round the sidecar mtime down by a few milliseconds.
      if (compressedStat.mtimeMs + 1000 >= sourceStat.mtimeMs && compressedStat.size > 0) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(compressedStat.size));
        res.setHeader('X-GLB-Transfer', 'gzip-sidecar');
        return res.sendFile(path.resolve(compressedPath));
      }
    } catch {
      // A missing/stale sidecar falls through to the original GLB.
    }
  }
  if (extension === '.glb') res.setHeader('X-GLB-Transfer', 'identity');
  return res.sendFile(path.resolve(servedPath));
}

function publicAsset(asset) {
  const { storedPath, ...safe } = asset;
  const sourceNature = inferredSourceNature(asset);
  const testOnly = isLikelyTestAsset(asset) || sourceNature === 'virtual_test';
  return {
    ...safe,
    sourceNature,
    testOnly,
    evidenceLevel: testOnly ? 'Scenario' : (safe.evidenceLevel || 'Observed'),
    url: asset.id === 'asset_a98b0182ed4e' ? '/models/twin-main.glb' : (typeof safe.url === 'string' && safe.url.startsWith('/') && !safe.url.startsWith('/api/') ? safe.url : `/api/assets/${asset.id}/content`)
  };
}

function errorBody(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

function assertProject() {
  if (!store.project) {
    const err = new Error('请先创建项目');
    err.status = 400;
    err.code = 'PROJECT_REQUIRED';
    throw err;
  }
}

const supportedGeoJsonGeometryTypes = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);

function geoJsonImportError(code, message, status = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function validateGeoJsonCoordinates(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.every((item) => typeof item === 'number')) {
    return value.length >= 2 && value.length <= 3 && value.every(Number.isFinite);
  }
  return value.every(validateGeoJsonCoordinates);
}

function normalizedGeoJsonFeatures(document) {
  if (document?.type === 'FeatureCollection' && Array.isArray(document.features)) return document.features;
  if (document?.type === 'Feature') return [document];
  throw geoJsonImportError('GEOJSON_FEATURES_REQUIRED', 'GeoJSON 必须是 FeatureCollection 或 Feature');
}

function fallbackGeoJsonObjectType(geometryType) {
  if (['Point', 'MultiPoint'].includes(geometryType)) return 'point';
  if (['LineString', 'MultiLineString'].includes(geometryType)) return 'line';
  return 'area';
}

function buildGeoJsonSceneObjects({ asset, document, coordinateSpace, projectId }) {
  const features = normalizedGeoJsonFeatures(document);
  if (!features.length) throw geoJsonImportError('GEOJSON_FEATURES_REQUIRED', 'GeoJSON 中没有可导入的 Feature');
  if (features.length > 5000) throw geoJsonImportError('GEOJSON_FEATURE_LIMIT', '单次最多导入 5000 个 GeoJSON Feature');
  const createdAt = new Date().toISOString();
  const ids = new Set();
  return features.map((feature, index) => {
    if (feature?.type !== 'Feature' || !feature.geometry || typeof feature.geometry !== 'object') {
      throw geoJsonImportError('GEOJSON_FEATURE_INVALID', `第 ${index + 1} 个条目不是有效 GeoJSON Feature`);
    }
    const geometryType = String(feature.geometry.type || '');
    if (!supportedGeoJsonGeometryTypes.has(geometryType)) {
      throw geoJsonImportError('GEOJSON_GEOMETRY_UNSUPPORTED', `第 ${index + 1} 个 Feature 使用不支持的几何类型 ${geometryType || '(空)'}`, 400, { featureIndex: index, geometryType });
    }
    if (!validateGeoJsonCoordinates(feature.geometry.coordinates)) {
      throw geoJsonImportError('GEOJSON_COORDINATES_INVALID', `第 ${index + 1} 个 Feature 的坐标为空或包含非有限数值`, 400, { featureIndex: index });
    }
    const sourceProperties = feature.properties && typeof feature.properties === 'object' && !Array.isArray(feature.properties) ? feature.properties : {};
    const requestedId = String(sourceProperties.object_id || sourceProperties.objectId || '').trim();
    const objectId = /^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(requestedId)
      ? requestedId
      : `${asset.id}-feature-${String(index + 1).padStart(3, '0')}`.slice(0, 80);
    if (ids.has(objectId)) throw geoJsonImportError('GEOJSON_OBJECT_ID_DUPLICATE', `GeoJSON 内存在重复对象 ID ${objectId}`, 409, { objectId });
    ids.add(objectId);
    const objectType = String(sourceProperties.object_type || sourceProperties.objectType || sourceProperties.sr_type || '').trim() || fallbackGeoJsonObjectType(geometryType);
    const label = String(sourceProperties.label || sourceProperties.name || objectId).trim();
    const sourceFeatureId = feature.id === undefined || feature.id === null ? String(index + 1) : String(feature.id);
    const sourceFeatureHash = crypto.createHash('sha256').update(JSON.stringify(feature)).digest('hex');
    return {
      id: objectId,
      projectId,
      type: objectType,
      label,
      geometry: feature.geometry,
      properties: {
        ...sourceProperties,
        coordinateSpace,
        source: asset.sourceArtifactId ? 'derived_geojson_artifact' : 'uploaded_geojson',
        ...(asset.sourceArtifactId ? { sourceArtifactId: asset.sourceArtifactId } : {}),
        sourceFeatureId,
        sourceFeatureIndex: index,
        sourceFeatureHash
      },
      evidenceLevel: ['Observed', 'Derived', 'Hypothesis', 'Scenario', 'Expert Approved'].includes(asset.evidenceLevel) ? asset.evidenceLevel : 'Observed',
      sourceAssetIds: Array.isArray(asset.sourceAssetIds) ? asset.sourceAssetIds : [asset.id],
      createdAt,
      updatedAt: createdAt
    };
  });
}

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(self)');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
if (corsOrigins.length) {
  app.use(cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: false
  }));
}
app.use(express.json({ limit: '6mb' }));

// Moving-video reconstruction review is an evidence-only workflow.  Its
// ledgers and overlays are deliberately separate from the model/artifact
// mutation routes, so frame confirmation cannot move navigation geometry or
// replace the active model.
registerReconstructionReviewRoutes({
  app,
  rootDir,
  artifactDir,
  getProjectId: () => store.activeProjectId,
  persist,
  assertProject
});

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-\u4e00-\u9fff]/g, '_');
    cb(null, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 40 },
  fileFilter: (_req, file, cb) => {
    file.originalname = repairUtf8Mojibake(file.originalname);
    const descriptor = uploadDescriptor(file);
    if (!descriptor) return cb(uploadError('UNSUPPORTED_FILE_TYPE', `不支持文件扩展名 ${path.extname(file.originalname || '') || '(无)'}`));
    const declaredMime = String(file.mimetype || '').toLowerCase().split(';')[0].trim();
    if (!descriptor.mime.includes(declaredMime)) return cb(uploadError('MIME_TYPE_MISMATCH', `文件 ${file.originalname} 的 MIME 类型与扩展名不匹配`));
    return cb(null, true);
  }
});

app.get('/api/health', async (_req, res) => {
  const [gpu, colmap, nerfstudio, nsExport, spz, blender, ffmpeg, ffprobe, python] = await Promise.all([
    commandAvailableAsync('nvidia-smi'),
    commandAvailableAsync(process.env.COLMAP_BIN || 'colmap'),
    commandAvailableAsync(process.env.NERFSTUDIO_BIN || 'ns-train'),
    commandAvailableAsync(process.env.NS_EXPORT_BIN || 'ns-export'),
    commandAvailableAsync(process.env.SPZ_BIN || 'spz'),
    commandAvailableAsync(blenderBin),
    commandAvailableAsync('ffmpeg'),
    commandAvailableAsync('ffprobe'),
    commandAvailableAsync(pythonCommand())
  ]);
  const yoloModelPath = String(process.env.YOLO_MODEL_PATH || '').trim();
  const yoloReady = readableFileAvailable(yoloModelPath);
  const semantic = semanticRuntimeStatus();
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    llm: {
      configured: Boolean(llmApiKey),
      baseUrl: llmBaseUrl,
      primaryBaseUrl: llmBaseUrl,
      directBaseUrl: llmDirectBaseUrl,
      model: llmModel,
      requestTimeoutMs: llmRequestTimeoutMs,
      keyPresent: Boolean(llmApiKey)
    },
    runtimeCapabilities: {
      nerfstudio: { state: nerfstudio ? 'ready' : 'external_required', available: nerfstudio, requiredFor: 'enhanced_3dgs', fallback: 'COLMAP point cloud', detail: nerfstudio ? '本机 Nerfstudio / gsplat 可用' : '本机未安装；完整 3DGS 需要配置 NVIDIA CUDA Worker' },
      nsExport: { state: nsExport ? 'ready' : 'external_required', available: nsExport, requiredFor: 'enhanced_3dgs', fallback: 'COLMAP point cloud', detail: nsExport ? 'Gaussian PLY 导出可用' : '本机未检测到 ns-export；仅影响 Gaussian 导出' },
      spz: { state: spz ? 'ready' : 'external_required', available: spz, requiredFor: 'enhanced_3dgs', fallback: 'GLB / PLY', detail: spz ? 'SPZ 网页压缩可用' : '本机未检测到 SPZ；GLB / PLY 与 COLMAP 点云仍可用' },
      blender: { state: blender ? 'ready' : 'external_required', available: blender, requiredFor: 'pbr_model_enhancement', fallback: 'CAD 语义 GLB', detail: blender ? 'Blender 后台建模与 PBR 资产导出可用' : '未配置 BLENDER_BIN；CAD 语义 GLB 仍可使用，但不能生成 BLEND、PBR 增强 GLB 和参观预览' },
      gpu: { state: gpu ? 'ready' : 'external_required', available: gpu, requiredFor: 'enhanced_3dgs', fallback: 'COLMAP point cloud', detail: gpu ? 'NVIDIA CUDA 本机可用' : '当前为 Intel GPU；完整 3DGS 训练需要外部 NVIDIA CUDA 算力' },
      colmap: { state: colmap ? 'ready' : 'blocked', available: colmap, requiredFor: 'core_photogrammetry', fallback: null, detail: colmap ? '摄影测量核心运行时可用' : '缺少 COLMAP，摄影测量核心路径被阻断' }
    },
    runtimes: {
      gpu: { available: gpu, note: gpu ? 'NVIDIA runtime detected' : 'No NVIDIA runtime detected; CPU or remote worker required' },
      colmap,
      nerfstudio,
      nsExport,
      spz,
      blender,
      yolo: yoloReady,
      groundingDino: semantic.groundingDino,
      sam2: semantic.sam2,
      skpConverter: true,
      dwgReader: true,
      ffmpeg,
      ffprobe,
      python
    },
    counts: {
      ...projectCounts(store.activeProjectId),
      projects: store.projects.length
    }
  });
});

app.get('/api/project', (req, res) => {
  const includeHistory = req.query.includeHistory === 'true';
  const bootstrap = req.query.view === 'bootstrap';
  res.json({
    ok: true,
    project: store.project,
    settings: store.settings,
    assets: bootstrap ? bootstrapAssets() : recordsForProject(store.assets).map(publicAsset),
    artifacts: bootstrap
      ? bootstrapWorkspaceArtifacts().map(publicBootstrapArtifact)
      : workspaceArtifacts(includeHistory).map(publicArtifact),
    geographicContext: geographicContextStatus()
  });
});

// Store supplemental field photographs and externally published references as a
// traceable manifest.  The manifest is deliberately separate from the site
// corridor artifacts so re-running a reconstruction cannot silently discard
// research material.  Reference URLs are never treated as geometry or as
// survey-grade evidence by the worker.
app.post('/api/project/reference-sources', async (req, res) => {
  try {
    assertProject();
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const assetIds = Array.isArray(body.assetIds) ? [...new Set(body.assetIds.map((value) => String(value || '').trim()).filter(Boolean))] : [];
    if (!sources.length && !assetIds.length) return res.status(400).json(errorBody('REFERENCE_SOURCES_REQUIRED', '至少提供一条文章链接或一张补充图片'));
    if (sources.length > 20) return res.status(400).json(errorBody('REFERENCE_SOURCE_LIMIT', '参考链接最多20条'));
    const validSources = sources.map((source, index) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw Object.assign(new Error(`第${index + 1}条参考资料格式无效`), { code: 'REFERENCE_SOURCE_INVALID', status: 400 });
      const url = String(source.url || '').trim();
      let parsed;
      try { parsed = new URL(url); } catch { throw Object.assign(new Error(`第${index + 1}条参考资料 URL 无效`), { code: 'REFERENCE_SOURCE_URL_INVALID', status: 400 }); }
      if (parsed.protocol !== 'https:' || !['mp.weixin.qq.com', 'weixin.qq.com'].includes(parsed.hostname.toLowerCase())) {
        throw Object.assign(new Error(`第${index + 1}条参考资料只允许微信文章链接`), { code: 'REFERENCE_SOURCE_HOST_INVALID', status: 400 });
      }
      return {
        url,
        title: String(source.title || '微信文章参考资料').trim().slice(0, 200),
        sourceType: String(source.sourceType || 'Reference').trim().slice(0, 40),
        evidenceLevel: 'Reference',
        notes: String(source.notes || '文章内容仅作设计背景与材料关系参考，不直接转写为现场实测').trim().slice(0, 1000)
      };
    });
    const assets = assetIds.map((assetId) => store.assets.find((asset) => asset.id === assetId && asset.projectId === store.project.id));
    if (assets.some((asset) => !asset)) return res.status(404).json(errorBody('REFERENCE_ASSET_NOT_FOUND', '补充资料中包含不属于当前项目的图片资产'));
    if (assets.some((asset) => asset.type !== 'image')) return res.status(400).json(errorBody('REFERENCE_ASSET_TYPE_INVALID', '补充参考资产必须是图片'));
    const classifications = body.classifications && typeof body.classifications === 'object' && !Array.isArray(body.classifications) ? body.classifications : {};
    const allowedEvidence = new Set(['Observed', 'Derived', 'Hypothesis', 'Reference']);
    const assetRecords = assets.map((asset) => {
      const supplied = classifications[asset.id] && typeof classifications[asset.id] === 'object' ? classifications[asset.id] : {};
      const evidenceLevel = allowedEvidence.has(String(supplied.evidenceLevel || 'Observed')) ? String(supplied.evidenceLevel || 'Observed') : 'Observed';
      const tags = Array.isArray(supplied.tags) ? [...new Set(supplied.tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 30))] : [];
      const modelLayers = Array.isArray(supplied.modelLayers) ? [...new Set(supplied.modelLayers.map((layer) => String(layer || '').trim()).filter(Boolean).slice(0, 20))] : [];
      return {
        assetId: asset.id,
        name: asset.name,
        sha256: asset.sha256,
        sourceNature: asset.sourceNature,
        evidenceLevel,
        tags,
        modelLayers,
        observations: String(supplied.observations || '').trim().slice(0, 1200),
        metricUse: '仅用于外观、材质与语义关系校核；没有控制点时不用于绝对尺寸或测绘级配准'
      };
    });
    const now = new Date().toISOString();
    const manifest = {
      schema: 'project_reference_sources.v1',
      projectId: store.project.id,
      createdAt: now,
      evidencePolicy: {
        fieldImages: 'Observed：图片中直接可见的建筑、道路、绿化和材质证据',
        articleLinks: 'Reference：文章中的历史、设计意图和技术说明，不直接生成现场实体',
        geometryPolicy: '未提供控制点的资料不得宣称为测绘级几何或绝对坐标'
      },
      articleSources: validSources,
      imageSources: assetRecords,
      sourceAssetIds: assets.map((asset) => asset.id),
      dataGaps: [
        '新增图片没有相机姿态和控制点，不能单独修正道路绝对线位。',
        '文章中的历史改造、光伏和绿色技术说明需要现场或竣工资料确认后才能升级为 Observed。',
        '材质颜色可用于展示校核，不能替代现场材质样本或反射率测量。'
      ]
    };
    const filePath = path.join(artifactDir, `reference-sources-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`);
    await fsp.writeFile(filePath, JSON.stringify(manifest, null, 2), 'utf8');
    const artifact = await addArtifact({
      projectId: store.project.id,
      jobId: null,
      kind: 'reference_source_manifest',
      title: '补充图片与微信文章参考资料清单',
      storedPath: filePath,
      evidenceLevel: 'Reference',
      metadata: {
        schema: manifest.schema,
        sourceAssetIds: manifest.sourceAssetIds,
        referenceUrlCount: validSources.length,
        imageSourceCount: assetRecords.length,
        evidencePolicy: manifest.evidencePolicy,
        stale: false
      }
    });
    const linkedMetadata = supplementalReferenceMetadata(manifest, artifact.id);
    for (const targetArtifact of store.artifacts) {
      if (targetArtifact.projectId !== store.project.id) continue;
      if (!['site_context_glb', 'site_detail_manifest', 'site_corridor_manifest'].includes(targetArtifact.kind)) continue;
      if (targetArtifact.metadata?.stale === true) continue;
      targetArtifact.metadata = { ...(targetArtifact.metadata || {}), ...linkedMetadata };
    }
    await persist();
    res.status(201).json({ ok: true, artifact: publicArtifact(artifact), manifest });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'REFERENCE_SOURCE_CREATE_FAILED', err.message));
  }
});

// Apply the operator-approved, evidence-bounded reference correction to the
// newest active site GLB. The original GLB remains stored and is marked stale;
// the new artifact records the exact reference manifest and keeps approximate
// registration explicit instead of silently upgrading it to survey geometry.
app.post('/api/scene/site-corridor/reference-correction', async (_req, res) => {
  try {
    assertProject();
    const activeSourceArtifact = [...store.artifacts].reverse().find((artifact) =>
      artifact.projectId === store.project.id
      && artifact.kind === 'site_context_glb'
      && artifact.metadata?.stale !== true
    );
    // Rebuild repeated reference corrections from the original Blender GLB,
    // not from the already corrected output. This prevents roof reference
    // proxies and small presentation offsets from accumulating on every run.
    const sourceArtifact = activeSourceArtifact?.metadata?.sourceArtifactId
      ? store.artifacts.find((artifact) => artifact.id === activeSourceArtifact.metadata.sourceArtifactId && artifact.projectId === store.project.id)
      : activeSourceArtifact;
    if (!sourceArtifact?.storedPath || !storedPathIsInside(sourceArtifact.storedPath, artifactDir)) {
      return res.status(404).json(errorBody('SITE_REFERENCE_SOURCE_NOT_FOUND', '当前项目没有可修正的周边 GLB'));
    }
    const referenceArtifact = [...store.artifacts].reverse().find((artifact) =>
      artifact.projectId === store.project.id
      && artifact.kind === 'reference_source_manifest'
      && artifact.metadata?.stale !== true
      && artifact.storedPath
    );
    if (!referenceArtifact || !storedPathIsInside(referenceArtifact.storedPath, artifactDir)) {
      return res.status(409).json(errorBody('SITE_REFERENCE_MANIFEST_REQUIRED', '请先登记现场图片和参考链接，再进行资料修正'));
    }
    const sourceStat = await fsp.stat(sourceArtifact.storedPath).catch(() => null);
    const referenceStat = await fsp.stat(referenceArtifact.storedPath).catch(() => null);
    if (!sourceStat?.isFile() || !referenceStat?.isFile()) return res.status(404).json(errorBody('SITE_REFERENCE_INPUT_MISSING', '周边模型或参考资料清单文件不存在'));

    const runId = id('site_reference_correction');
    const outputDir = path.join(artifactDir, runId);
    await fsp.mkdir(outputDir, { recursive: true });
    const worker = path.join(rootDir, 'workers', 'site_reference_correction.py');
    const result = await runProcess(pythonCommand(), [
      worker,
      '--source', sourceArtifact.storedPath,
      '--reference-manifest', referenceArtifact.storedPath,
      '--output-dir', outputDir
    ]);
    const payload = lastJsonLine(result.stdout) || lastJsonLine(result.stderr);
    if (result.code !== 0 || !payload?.ok) throw Object.assign(new Error(payload?.error || result.stderr.trim() || '资料参考修正失败'), { code: 'SITE_REFERENCE_CORRECTION_FAILED' });
    const correction = payload.result;
    const correctedPath = path.resolve(String(correction.output || ''));
    const correctionManifestPath = path.join(outputDir, 'site-context-reference-correction.json');
    for (const filePath of [correctedPath, correctionManifestPath]) {
      if (!storedPathIsInside(filePath, outputDir)) throw Object.assign(new Error('资料修正输出路径越界'), { code: 'SITE_REFERENCE_CORRECTION_OUTPUT_INVALID' });
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile()) throw Object.assign(new Error('资料修正缺少输出文件'), { code: 'SITE_REFERENCE_CORRECTION_OUTPUT_MISSING' });
    }

    const staleAt = new Date().toISOString();
    // Bind the source reference-manifest ID into the correction record. The
    // worker cannot know this server-side artifact ID, so its raw payload
    // intentionally leaves the field empty. Keeping the returned metadata
    // self-consistent makes the GLB, manifest and project record traceable.
    correction.referenceManifestId = referenceArtifact.id;
    for (const artifact of store.artifacts) {
      if (artifact.projectId !== store.project.id || artifact.kind !== 'site_context_glb' || artifact.metadata?.stale === true) continue;
      artifact.metadata = { ...(artifact.metadata || {}), stale: true, staleReason: 'superseded_by_reference_correction', staleAt };
    }
    const sourceMetadata = sourceArtifact.metadata || {};
    const correctedReferenceConflicts = correctedReferenceConflictRecords(sourceMetadata.supplementalReferenceConflicts);
    const addedDetailCounts = {
      ...(sourceMetadata.detailCounts || {}),
      roof_pv_reference_proxy: Number(correction.addedReferenceElements?.solarPanelProxy || 0),
      roof_pv_frame_reference_proxy: Number(correction.addedReferenceElements?.solarPanelFrameProxy || 0),
      green_roof_reference_proxy: Number(correction.addedReferenceElements?.greenRoofProxy || 0)
    };
    const currentDetailCounts = {
      ...(sourceMetadata.currentStateDetailCounts || sourceMetadata.detailCounts || {}),
      roof_pv_reference_proxy: Number(correction.addedReferenceElements?.solarPanelProxy || 0),
      roof_pv_frame_reference_proxy: Number(correction.addedReferenceElements?.solarPanelFrameProxy || 0),
      green_roof_reference_proxy: Number(correction.addedReferenceElements?.greenRoofProxy || 0)
    };
    const correctedArtifact = await addArtifact({
      projectId: store.project.id,
      jobId: null,
      kind: 'site_context_glb',
      title: '现场资料修正后的建筑周边小道 GLB',
      storedPath: correctedPath,
      evidenceLevel: 'Hypothesis',
      metadata: {
        ...sourceMetadata,
        stale: false,
        staleReason: null,
        sourceArtifactId: sourceArtifact.id,
        sourceReferenceManifestId: referenceArtifact.id,
        referenceCorrection: correction,
        referenceCorrectionStatus: 'operator_approved_approximate',
        registrationMethod: 'operator_approved_reference_alignment',
        coordinateStatus: 'operator_approved_approximate_registration',
        surveyGrade: false,
        detailCounts: addedDetailCounts,
        currentStateDetailCounts: currentDetailCounts,
        historicalConstructionDetailCounts: sourceMetadata.historicalConstructionDetailCounts || {},
        currentStatePolicy: '施工围挡、塔吊、临时框架只保留为历史证据；现状展示默认隐藏，不参与现状空间分析。',
        supplementalReferenceConflicts: correctedReferenceConflicts,
        outputBytes: (await fsp.stat(correctedPath)).size,
        supplementalReferenceManifestId: referenceArtifact.id,
        supplementalReferenceState: 'reference_bound_operator_approved_approximate'
      }
    });
    const correctionManifest = await addArtifact({
      projectId: store.project.id,
      jobId: null,
      kind: 'site_reference_correction_manifest',
      title: '现场图片与文章参考修正清单',
      storedPath: correctionManifestPath,
      evidenceLevel: 'Derived',
      metadata: {
        schema: correction.schema,
        sourceArtifactId: sourceArtifact.id,
        correctedArtifactId: correctedArtifact.id,
        referenceManifestId: referenceArtifact.id,
        registrationStatus: correction.registrationStatus,
        limitations: correction.limitations || []
      }
    });
    const project = store.projects.find((item) => item.id === store.project.id);
    if (project) {
      project.modelRegistration = {
        ...(project.modelRegistration || {}),
        siteContextArtifactId: correctedArtifact.id,
        updatedAt: new Date().toISOString(),
        evidenceLevel: 'Hypothesis'
      };
      store.project = project;
    }
    await persist();
    res.status(201).json({ ok: true, artifact: publicArtifact(correctedArtifact), correctionManifest: publicArtifact(correctionManifest), correction });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SITE_REFERENCE_CORRECTION_FAILED', err.message));
  }
});

app.get('/api/projects', (_req, res) => {
  res.json({
    ok: true,
    activeProjectId: store.activeProjectId,
    projects: store.projects.map((project) => ({ ...project, counts: projectCounts(project.id), active: project.id === store.activeProjectId }))
  });
});

function validateProjectBody(body) {
  if (!String(body.name || '').trim()) return { error: errorBody('PROJECT_NAME_REQUIRED', '项目名称不能为空') };
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { error: errorBody('COORDINATES_REQUIRED', '请提供有效的纬度和经度') };
  }
  return {
    value: {
      name: String(body.name).trim(), address: String(body.address || '').trim(), latitude, longitude,
      coordinateSystem: body.coordinateSystem || 'WGS84'
    }
  };
}

app.post('/api/projects', async (req, res) => {
  const parsed = validateProjectBody(req.body || {});
  if (parsed.error) return res.status(400).json(parsed.error);
  const now = new Date().toISOString();
  const project = { id: id('project'), ...parsed.value, createdAt: now, updatedAt: now, status: 'active' };
  store.projects.push(project);
  setActiveProject(project.id);
  await persist();
  res.status(201).json({ ok: true, project });
});

app.post('/api/projects/:projectId/activate', async (req, res) => {
  const project = store.projects.find((item) => item.id === req.params.projectId);
  if (!project) return res.status(404).json(errorBody('PROJECT_NOT_FOUND', '项目不存在'));
  if (project.status === 'archived') return res.status(409).json(errorBody('PROJECT_ARCHIVED', '请先恢复项目再切换'));
  setActiveProject(project.id);
  await persist();
  res.json({ ok: true, project });
});

app.patch('/api/projects/:projectId', async (req, res) => {
  const project = store.projects.find((item) => item.id === req.params.projectId);
  if (!project) return res.status(404).json(errorBody('PROJECT_NOT_FOUND', '项目不存在'));
  const hasStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status');
  const hasModelRegistration = Object.prototype.hasOwnProperty.call(req.body || {}, 'modelRegistration');
  if (!hasStatus && !hasModelRegistration) return res.status(400).json(errorBody('PROJECT_PATCH_EMPTY', '没有可更新的项目字段'));
  if (hasStatus) {
    const status = String(req.body?.status || '').trim();
    if (!['active', 'archived'].includes(status)) return res.status(400).json(errorBody('PROJECT_STATUS_INVALID', '项目状态只能是 active 或 archived'));
    project.status = status;
    if (status === 'archived' && project.id === store.activeProjectId) {
      setActiveProject(store.projects.find((item) => item.id !== project.id && item.status !== 'archived')?.id || null);
    }
  }
  if (hasModelRegistration) {
    const registration = req.body?.modelRegistration;
    const modelArtifactId = String(registration?.modelArtifactId || '').trim();
    const contextArtifactId = String(registration?.contextArtifactId || '').trim();
    const offsetXM = Number(registration?.offsetXM);
    const offsetZM = Number(registration?.offsetZM);
    const rotationDeg = Number(registration?.rotationDeg);
    const scale = Number(registration?.scale);
    const modelArtifact = store.artifacts.find((item) => item.id === modelArtifactId && item.projectId === project.id && ['skp_glb', 'dwg_extrusion_glb', 'blender_enhanced_glb'].includes(item.kind));
    const contextArtifact = store.artifacts.find((item) => item.id === contextArtifactId && item.projectId === project.id && item.kind === 'osm_context_glb' && item.metadata?.stale !== true);
    const valuesValid = [offsetXM, offsetZM, rotationDeg, scale].every(Number.isFinite)
      && Math.abs(offsetXM) <= 5000 && Math.abs(offsetZM) <= 5000
      && Math.abs(rotationDeg) <= 360 && scale >= 0.1 && scale <= 10;
    if (!modelArtifact || !contextArtifact || !valuesValid) {
      return res.status(400).json(errorBody('MODEL_REGISTRATION_INVALID', '模型配准必须引用当前项目有效的 CAD 室内模型和 OSM 底景；偏移不超过 5000m、旋转不超过 360°、比例为 0.1–10'));
    }
    project.modelRegistration = {
      ...(project.modelRegistration || {}),
      modelArtifactId, contextArtifactId, offsetXM, offsetZM, rotationDeg, scale,
      scaleXYZ: Array.isArray(registration?.scaleXYZ) ? registration.scaleXYZ.map(Number) : undefined,
      evidenceLevel: String(registration?.evidenceLevel || 'Hypothesis'),
      evidenceBasis: String(registration?.evidenceBasis || ''),
      combinedScene: registration?.combinedScene === true,
      combinedSceneAssetId: String(registration?.combinedSceneAssetId || ''),
      skpBuildingMeshCount: Number(registration?.skpBuildingMeshCount || 0),
      skpAccessoryMeshCountExcluded: Number(registration?.skpAccessoryMeshCountExcluded || 0),
      buildingMassHidden: registration?.buildingMassHidden === true,
      stage3TreeNodeCount: Number(registration?.stage3TreeNodeCount || 0),
      updatedAt: new Date().toISOString()
    };
  }
  project.updatedAt = new Date().toISOString();
  await persist();
  res.json({ ok: true, project, activeProjectId: store.activeProjectId });
});

app.get('/api/scene/objects', (req, res) => {
  const objects = recordsForProject(store.sceneObjects);
  res.json({ ok: true, objects: req.query.detail === 'full' ? objects : sceneObjectsForWorkspace(objects) });
});

app.post('/api/scene/objects', async (req, res) => {
  try {
    assertProject();
    const body = req.body || {};
    const objectId = String(body.id || '').trim();
    const evidenceLevel = String(body.evidenceLevel || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(objectId)) return res.status(400).json(errorBody('SCENE_OBJECT_ID_INVALID', '三维对象 ID 需为2–80位字母、数字、下划线或短横线'));
    if (store.sceneObjects.some((item) => item.projectId === store.project.id && item.id === objectId)) return res.status(409).json(errorBody('SCENE_OBJECT_EXISTS', `三维对象 ${objectId} 已存在`));
    if (!['Observed', 'Derived', 'Hypothesis', 'Scenario'].includes(evidenceLevel)) return res.status(400).json(errorBody('SCENE_OBJECT_EVIDENCE_INVALID', '语义对象必须明确选择 Observed、Derived、Hypothesis 或 Scenario'));
    if (!String(body.type || '').trim()) return res.status(400).json(errorBody('SCENE_OBJECT_TYPE_REQUIRED', '三维对象类型不能为空'));
    if (!body.geometry || typeof body.geometry !== 'object' || Array.isArray(body.geometry)) return res.status(400).json(errorBody('SCENE_OBJECT_GEOMETRY_REQUIRED', '三维对象必须提供真实 geometry'));
    const object = {
      id: objectId, projectId: store.project.id, type: String(body.type).trim(), label: String(body.label || '').trim(),
      geometry: body.geometry, properties: body.properties && typeof body.properties === 'object' ? body.properties : {},
      evidenceLevel,
      sourceAssetIds: Array.isArray(body.sourceAssetIds) ? body.sourceAssetIds : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    store.sceneObjects.push(object);
    await persist();
    res.status(201).json({ ok: true, object });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SCENE_OBJECT_CREATE_FAILED', err.message));
  }
});

app.post('/api/scene/import-geojson', async (req, res) => {
  try {
    assertProject();
    const assetId = String(req.body?.assetId || '').trim();
    const coordinateSpace = String(req.body?.coordinateSpace || '').trim();
    const uploadedAsset = store.assets.find((item) => item.id === assetId && item.projectId === store.project.id);
    const derivedArtifact = store.artifacts.find((item) => item.id === assetId && item.projectId === store.project.id && path.extname(item.storedPath || '').toLowerCase() === '.geojson');
    if (!uploadedAsset && !derivedArtifact) throw geoJsonImportError('GEOJSON_ASSET_NOT_FOUND', '找不到当前项目中的 GeoJSON 资产或阶段产物', 404);
    const asset = uploadedAsset || {
      ...derivedArtifact,
      name: path.basename(derivedArtifact.storedPath),
      sourceArtifactId: derivedArtifact.id,
      sourceAssetIds: derivedArtifact.metadata?.sourceAssetId ? [derivedArtifact.metadata.sourceAssetId] : []
    };
    if (path.extname(asset.name || asset.storedPath || '').toLowerCase() !== '.geojson') throw geoJsonImportError('GEOJSON_ASSET_REQUIRED', '所选来源不是 .geojson 文件');
    if (!['local_enu', 'wgs84'].includes(coordinateSpace)) throw geoJsonImportError('GEOJSON_COORDINATE_SPACE_REQUIRED', '请选择 local_enu 或 wgs84 坐标语义');
    const sourceDir = derivedArtifact ? artifactDir : uploadDir;
    if (!asset.storedPath || !storedPathIsInside(asset.storedPath, sourceDir)) throw geoJsonImportError('GEOJSON_FILE_NOT_FOUND', 'GeoJSON 文件不属于允许的存储目录', 404);
    const stat = await fsp.stat(asset.storedPath).catch(() => null);
    if (!stat?.isFile()) throw geoJsonImportError('GEOJSON_FILE_NOT_FOUND', 'GeoJSON 文件不存在或不可读', 404);
    if (stat.size > 25 * 1024 * 1024) throw geoJsonImportError('GEOJSON_FILE_TOO_LARGE', 'GeoJSON 批量导入文件不能超过 25MiB', 413);
    let document;
    try { document = JSON.parse(await fsp.readFile(asset.storedPath, 'utf8')); }
    catch { throw geoJsonImportError('GEOJSON_PARSE_FAILED', 'GeoJSON 文件不是有效的 UTF-8 JSON'); }
    const objects = buildGeoJsonSceneObjects({ asset, document, coordinateSpace, projectId: store.project.id });
    const existingIds = new Set(recordsForProject(store.sceneObjects).map((item) => item.id));
    const conflicts = objects.map((item) => item.id).filter((objectId) => existingIds.has(objectId));
    if (conflicts.length) throw geoJsonImportError('GEOJSON_OBJECT_EXISTS', `以下对象 ID 已存在: ${conflicts.join(', ')}`, 409, { objectIds: conflicts });
    store.sceneObjects.push(...objects);
    await persist();
    res.status(201).json({ ok: true, import: { assetId: asset.id, sourceType: derivedArtifact ? 'artifact' : 'asset', coordinateSpace, importedCount: objects.length, objects } });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'GEOJSON_IMPORT_FAILED', err.message, err.details || {}));
  }
});

app.post('/api/project', async (req, res) => {
  const body = req.body || {};
  const parsed = validateProjectBody(body);
  if (parsed.error) return res.status(400).json(parsed.error);
  const now = new Date().toISOString();
  if (!store.project) {
    const project = { id: id('project'), ...parsed.value, createdAt: now, updatedAt: now, status: 'active' };
    store.projects.push(project);
    setActiveProject(project.id);
  } else {
    const previousHash = geoAnchorHash(store.project);
    Object.assign(store.project, parsed.value, { updatedAt: now, status: 'active' });
    if (geoAnchorHash(store.project) !== previousHash) markGeographicContextStale(store.project.id);
  }
  await persist();
  res.json({ ok: true, project: store.project });
});

app.get('/api/assets/:assetId/content', async (req, res) => {
  const asset = store.assets.find((item) => item.id === req.params.assetId && item.projectId === store.activeProjectId);
  if (!asset) return res.status(404).json(errorBody('ASSET_NOT_FOUND', '找不到该资产'));
  return sendStoredFile(req, res, asset, uploadDir);
});

// Register a locally verified Blender refinement when the automatic Blender
// worker is interrupted by a graphics-driver crash.  Paths are accepted only
// as relative names inside ARTIFACT_DIR; this endpoint cannot expose arbitrary
// files and never fabricates a replacement model.
app.post('/api/scene/site-corridor/register-refinement', async (req, res) => {
  try {
    assertProject();
    const refinementRelative = String(req.body?.refinementRelative || '').trim();
    const sourceRelative = String(req.body?.sourceRelative || '').trim();
    if (!refinementRelative || !sourceRelative) {
      return res.status(400).json(errorBody('SITE_REFINEMENT_PATHS_REQUIRED', '必须提供已验证的 Blender 精修目录和源 GLB 相对路径'));
    }
    const refinementDir = path.resolve(artifactDir, refinementRelative);
    const sourcePath = path.resolve(artifactDir, sourceRelative);
    if (!storedPathIsInside(refinementDir, artifactDir) || !storedPathIsInside(sourcePath, artifactDir)) {
      return res.status(400).json(errorBody('SITE_REFINEMENT_PATH_OUTSIDE_ARTIFACTS', '精修资产路径必须位于阶段性产物目录内'));
    }
    const files = {
      glb: path.join(refinementDir, 'site-context-refined.glb'),
      blend: path.join(refinementDir, 'site-context-refined.blend'),
      preview: path.join(refinementDir, 'site-context-blender-preview.png'),
      manifest: path.join(refinementDir, 'site-context-blender-manifest.json')
    };
    for (const [key, filePath] of Object.entries(files)) {
      if (!storedPathIsInside(filePath, refinementDir)) return res.status(400).json(errorBody('SITE_REFINEMENT_PATH_INVALID', `${key} 输出路径越界`));
      const stat = await fsp.stat(filePath).catch(() => null);
      if (!stat?.isFile()) return res.status(404).json(errorBody('SITE_REFINEMENT_FILE_MISSING', `缺少已验证的 Blender 输出：${key}`));
    }
    const sourceStat = await fsp.stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) return res.status(404).json(errorBody('SITE_REFINEMENT_SOURCE_MISSING', '缺少精修前周边场景源 GLB'));
    const sourceManifestPath = path.join(path.dirname(sourcePath), 'manifest.json');
    const sourceManifestStat = await fsp.stat(sourceManifestPath).catch(() => null);
    if (!sourceManifestStat?.isFile() || !storedPathIsInside(sourceManifestPath, artifactDir)) {
      return res.status(404).json(errorBody('SITE_REFINEMENT_SOURCE_MANIFEST_MISSING', '缺少精修前场景清单，不能建立可追溯的当前版本'));
    }
    const sourceManifest = JSON.parse(await fsp.readFile(sourceManifestPath, 'utf8'));
    const blenderManifest = JSON.parse(await fsp.readFile(files.manifest, 'utf8'));
    const sourceScene = sourceManifest.scene || {};
    const sourceBuildingRegistration = sourceScene.building_registration || {};
    const sourceHalfExtents = Array.isArray(sourceScene.building_half_extents_m)
      ? sourceScene.building_half_extents_m.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : null;
    const sourceHeight = Number(sourceScene.building_height_m);
    const sourceBounds = Array.isArray(sourceBuildingRegistration.bounds_m)
      ? sourceBuildingRegistration.bounds_m
      : null;

    const prior = [...recordsForProject(store.artifacts, store.project.id)].reverse()
      .find((artifact) => artifact.kind === 'site_context_glb' && artifact.metadata?.stale !== true);
    const staleAt = new Date().toISOString();
    const replacementKinds = new Set(['site_context_glb', 'site_context_source_glb', 'site_context_blend', 'site_context_blender_preview', 'site_context_blender_manifest']);
    for (const artifact of store.artifacts) {
      if (artifact.projectId !== store.project.id || !replacementKinds.has(artifact.kind) || artifact.metadata?.stale === true) continue;
      artifact.metadata = { ...(artifact.metadata || {}), stale: true, staleReason: 'superseded_by_verified_geometry_refinement', staleAt };
    }
    const priorMetadata = prior?.metadata || {};
    const baseMetadata = {
      ...priorMetadata,
      schema: sourceManifest.schema || priorMetadata.schema,
      sourceAssetIds: sourceManifest.sourceAssetIds || priorMetadata.sourceAssetIds,
      sourceVideoOrder: sourceManifest.videoOrder || priorMetadata.sourceVideoOrder,
      coordinateSpace: sourceManifest.coordinateSpace || priorMetadata.coordinateSpace,
      coordinateStatus: sourceManifest.alignmentStatus || priorMetadata.coordinateStatus,
      registrationMethod: sourceManifest.registrationMethod || priorMetadata.registrationMethod,
      navigationTopologyMethod: sourceManifest.navigationTopologyMethod || priorMetadata.navigationTopologyMethod,
      topologyFirst: sourceManifest.topologyFirst ?? priorMetadata.topologyFirst,
      navigationDimensionPolicy: {
        ...(sourceManifest.navigationDimensionPolicy || priorMetadata.navigationDimensionPolicy || {}),
        operatorConfirmed: true,
        dimensionAuthority: 'operator_confirmed_navigation_graphic',
        planDimensions: 'authoritative',
        relativePlanDimensions: 'authoritative',
        orientationAndAdjacency: 'hard_constraint',
        metricScaleInterpretation: '导航图内部相对尺寸作为首层平面依据；CAD首层轮廓仅用于将该平面锚定到本地米制，不能覆盖导航图的方向、比例或邻接关系'
      },
      navigationDimensionAnchors: sourceManifest.navigationDimensionAnchors || priorMetadata.navigationDimensionAnchors,
      relativePlanDimensionsApplied: sourceManifest.relativePlanDimensionsApplied ?? priorMetadata.relativePlanDimensionsApplied,
      navigationTopologyBaseline: sourceManifest.navigationTopologyBaseline || priorMetadata.navigationTopologyBaseline,
      navigationTopologyEvidenceArtifact: sourceManifest.navigationTopologyEvidenceArtifact || priorMetadata.navigationTopologyEvidenceArtifact,
      navigationZoneAudit: sourceManifest.navigationZoneAudit || priorMetadata.navigationZoneAudit,
      spatialValidation: sourceManifest.spatialValidation || priorMetadata.spatialValidation,
      routeLengthM: sourceManifest.routeLengthM ?? priorMetadata.routeLengthM,
      surveyGrade: sourceManifest.surveyGrade ?? priorMetadata.surveyGrade,
      counts: sourceManifest.counts || priorMetadata.counts,
      detailCounts: sourceScene.detail_counts || priorMetadata.detailCounts,
      // Never carry geometry-size metadata forward from an older active
      // artifact.  The source manifest is the only accepted size record for
      // the refined GLB, and it is already tied to the navigation main-building
      // anchor.  This prevents a refinement registration from reporting the
      // old overall-scene bounds as the main-building half extents.
      mainBuildingHalfExtentsM: sourceHalfExtents?.length === 2
        ? sourceHalfExtents
        : priorMetadata.mainBuildingHalfExtentsM,
      mainBuildingHeightM: Number.isFinite(sourceHeight)
        ? sourceHeight
        : priorMetadata.mainBuildingHeightM,
      mainBuildingBoundsM: sourceBounds || priorMetadata.mainBuildingBoundsM,
      exteriorShellOnly: sourceScene.exterior_shell_only ?? priorMetadata.exteriorShellOnly,
      exteriorShellPolicy: sourceScene.exterior_shell_policy || priorMetadata.exteriorShellPolicy,
      interiorModelKeptSeparate: sourceScene.interior_model_separate ?? priorMetadata.interiorModelKeptSeparate,
      blenderRefined: true,
      blenderVersion: blenderManifest.blenderVersion || null,
      geometryCount: blenderManifest.meshCount ?? sourceManifest.scene?.geometry_count ?? priorMetadata.geometryCount,
      outputBytes: (await fsp.stat(files.glb)).size,
      stale: false,
      geometryRepair: {
        schema: 'site_geometry_repair.v1',
        method: 'cad_face_clip_vertex_edge_midpoint_centroid_and_ground_contact_snap',
        apronPolicy: 'continuous_footprint_apron',
        sourceRelative,
        refinementRelative,
        verifiedAt: staleAt
      },
      manualRegistrationReason: 'automatic_blender_worker_driver_crash; verified_prebuilt_refinement_registered',
      blenderRefinement: {
        schema: blenderManifest.schema,
        blenderVersion: blenderManifest.blenderVersion,
        sourceSha256: blenderManifest.sourceSha256,
        outputSha256: blenderManifest.outputSha256,
        bevelAppliedCount: blenderManifest.refinement?.bevelAppliedCount || 0,
        smoothObjectCount: blenderManifest.refinement?.smoothObjectCount || 0,
        tunedMaterialCount: blenderManifest.tunedMaterialCount || 0,
        materialProfiles: blenderManifest.materialProfiles || {},
        geometryEvidenceLevel: blenderManifest.geometryEvidenceLevel,
        materialFinishEvidenceLevel: blenderManifest.materialFinishEvidenceLevel,
        dataGaps: blenderManifest.dataGaps || []
      }
    };
    const artifacts = [];
    artifacts.push(await addArtifact({
      projectId: store.project.id, jobId: null, kind: 'site_context_glb',
      title: 'Blender 精修建筑周边小道 GLB（几何修复）', storedPath: files.glb,
      evidenceLevel: 'Hypothesis', metadata: baseMetadata
    }));
    artifacts.push(await addArtifact({
      projectId: store.project.id, jobId: null, kind: 'site_context_source_glb',
      title: '几何修复前建筑周边小道源 GLB', storedPath: sourcePath,
      evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, sourceArtifactId: artifacts[0].id }
    }));
    artifacts.push(await addArtifact({
      projectId: store.project.id, jobId: null, kind: 'site_context_blend',
      title: '建筑周边场景 Blender 可编辑源文件（几何修复）', storedPath: files.blend,
      evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, sourceArtifactId: artifacts[0].id }
    }));
    artifacts.push(await addArtifact({
      projectId: store.project.id, jobId: null, kind: 'site_context_blender_preview',
      title: '建筑周边场景 Blender 晴天预览（几何修复）', storedPath: files.preview,
      evidenceLevel: 'Hypothesis', metadata: { ...baseMetadata, sourceArtifactId: artifacts[0].id }
    }));
    artifacts.push(await addArtifact({
      projectId: store.project.id, jobId: null, kind: 'site_context_blender_manifest',
      title: '建筑周边场景 Blender 精修清单（几何修复）', storedPath: files.manifest,
      evidenceLevel: 'Derived', metadata: { ...baseMetadata, sourceArtifactId: artifacts[0].id }
    }));
    const storedProject = store.projects.find((item) => item.id === store.project.id);
    if (storedProject) {
      storedProject.modelRegistration = { ...(storedProject.modelRegistration || {}), siteContextArtifactId: artifacts[0].id, updatedAt: staleAt };
      storedProject.updatedAt = staleAt;
      if (store.activeProjectId === storedProject.id) store.project = storedProject;
    }
    await persist();
    res.status(201).json({ ok: true, artifacts: artifacts.map(publicArtifact), replacementArtifactId: artifacts[0].id });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SITE_REFINEMENT_REGISTRATION_FAILED', err.message));
  }
});

app.get('/api/artifacts/:artifactId/content', async (req, res) => {
  const artifact = store.artifacts.find((item) => item.id === req.params.artifactId && item.projectId === store.activeProjectId);
  if (!artifact) return res.status(404).json(errorBody('ARTIFACT_NOT_FOUND', '找不到该阶段性产物'));
  return sendStoredFile(req, res, artifact, artifactDir);
});

app.patch('/api/assets/:assetId/source-nature', async (req, res) => {
  try {
    assertProject();
    const asset = store.assets.find((item) => item.id === req.params.assetId && item.projectId === store.project.id);
    if (!asset) return res.status(404).json(errorBody('ASSET_NOT_FOUND', '找不到该资产'));
    const sourceNature = String(req.body?.sourceNature || '').trim();
    if (!['field_observation', 'virtual_test'].includes(sourceNature)) return res.status(400).json(errorBody('SOURCE_NATURE_INVALID', '资料用途必须是 field_observation 或 virtual_test'));
    if (asset.type === 'video' && store.videoWindows.some((window) => window.projectId === store.project.id && window.assetId === asset.id)) {
      return res.status(409).json(errorBody('SOURCE_NATURE_REANALYSIS_REQUIRED', '该视频已产生观测窗口，不能事后修改证据用途；请按正确用途重新上传并分析'));
    }
    const testOnly = sourceNature === 'virtual_test';
    Object.assign(asset, { sourceNature, testOnly, evidenceLevel: testOnly ? 'Scenario' : 'Observed', updatedAt: new Date().toISOString() });
    let relatedArtifacts = 0;
    for (const artifact of store.artifacts) {
      if (artifact.projectId !== store.project.id || artifact.metadata?.sourceAssetId !== asset.id) continue;
      artifact.metadata = { ...(artifact.metadata || {}), sourceNature, testOnly };
      relatedArtifacts += 1;
    }
    for (const candidate of store.semanticCandidates) {
      if (candidate.projectId === store.project.id && candidate.sourceAssetId === asset.id) Object.assign(candidate, { sourceNature, testOnly });
    }
    for (const job of store.jobs) {
      if (job.projectId !== store.project.id || job.assetId !== asset.id) continue;
      Object.assign(job, { sourceNature, testOnly });
      for (const artifact of job.output?.artifacts || []) {
        if (artifact.metadata?.sourceAssetId === asset.id) artifact.metadata = { ...(artifact.metadata || {}), sourceNature, testOnly };
      }
    }
    await persist();
    res.json({ ok: true, asset: publicAsset(asset), relatedArtifacts });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SOURCE_NATURE_UPDATE_FAILED', err.message));
  }
});

app.post('/api/assets/upload', (req, res, next) => {
  try { assertProject(); next(); } catch (error) { res.status(error.status || 400).json(errorBody(error.code || 'PROJECT_REQUIRED', error.message)); }
}, upload.array('files', 40), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json(errorBody('FILES_REQUIRED', '请选择至少一个文件'));
    const added = [];
    const conversionJobs = [];
    for (const file of files) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const requiresConversion = extension === '.skp' || extension === '.dwg';
      const sourceNature = inferredSourceNature({ name: file.originalname }, req.body?.sourceNature);
      const asset = {
        id: id('asset'),
        projectId: store.project.id,
        name: file.originalname,
        type: classifyAsset(file),
        mimeType: file.mimetype,
        size: file.size,
        sha256: await sha256(file.path),
        storedPath: file.path,
        url: null,
        source: 'user_upload',
        sourceNature,
        testOnly: sourceNature === 'virtual_test',
        evidenceLevel: sourceNature === 'virtual_test' ? 'Scenario' : 'Observed',
        status: requiresConversion ? 'processing' : 'ready',
        uploadedAt: new Date().toISOString()
      };
      store.assets.push(asset);
      added.push(publicAsset(asset));
      if (requiresConversion) {
        const job = {
          id: id('job'), projectId: store.project.id, type: 'cad_conversion', status: 'queued', createdAt: new Date().toISOString(),
          sourceAssetIds: [asset.id], assetId: asset.id, sourceFormat: extension.slice(1),
          stage: 'queued', progress: 0, diagnostics: []
        };
        store.jobs.push(job);
        conversionJobs.push(job);
      }
    }
    await persist();
    for (const job of conversionJobs) {
      const asset = store.assets.find((item) => item.id === job.assetId);
      void runCadConversionJob(job, asset);
    }
    res.json({ ok: true, assets: added, jobs: conversionJobs });
  } catch (err) {
    await Promise.all((req.files || []).map((file) => fsp.unlink(file.path).catch(() => {})));
    const status = err.status || 500;
    res.status(status).json(errorBody(err.code || 'UPLOAD_FAILED', err.message || '文件上传失败'));
  }
});

app.delete('/api/assets/:assetId', async (req, res) => {
  const index = store.assets.findIndex((asset) => asset.id === req.params.assetId && asset.projectId === store.activeProjectId);
  if (index < 0) return res.status(404).json(errorBody('ASSET_NOT_FOUND', '找不到该资产'));
  const [asset] = store.assets.splice(index, 1);
  try { await fsp.unlink(asset.storedPath); } catch { /* file may already be gone */ }
  await persist();
  res.json({ ok: true, assetId: asset.id });
});

app.post('/api/video/windows', async (req, res) => {
  try {
    assertProject();
    const body = req.body || {};
    const duration = Number(body.durationSeconds || 600);
    if (duration < 300 || duration > 1200) return res.status(400).json(errorBody('INVALID_DURATION', '典型片段应为5–20分钟'));
    const window = {
      id: id('window'),
      projectId: store.project.id,
      assetId: body.assetId || null,
      slotId: body.slotId || null,
      label: String(body.label || '').trim(),
      capturedAt: body.capturedAt || null,
      durationSeconds: duration,
      dayType: body.dayType || 'normal_weekday',
      weather: body.weather || 'unknown',
      cameraId: body.cameraId || null,
      sourceNature: inferredSourceNature(store.assets.find((item) => item.id === body.assetId && item.projectId === store.project.id), body.sourceNature),
      zones: Array.isArray(body.zones) ? body.zones : [],
      calibration: body.calibration && typeof body.calibration === 'object' ? body.calibration : { mode: 'none' },
      controlPoints: Array.isArray(body.controlPoints) ? body.controlPoints : [],
      notes: String(body.notes || '').trim(),
      status: 'registered',
      createdAt: new Date().toISOString()
    };
    store.videoWindows.push(window);
    await persist();
    res.json({ ok: true, window });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'WINDOW_CREATE_FAILED', err.message));
  }
});

app.get('/api/video/windows', (_req, res) => {
  res.json({ ok: true, windows: recordsForProject(store.videoWindows) });
});

app.post('/api/video/windows/:windowId/calibration', async (req, res) => {
  try {
    const window = store.videoWindows.find((item) => item.id === req.params.windowId && item.projectId === store.activeProjectId);
    if (!window) return res.status(404).json(errorBody('VIDEO_WINDOW_NOT_FOUND', '典型视频窗口不存在'));
    const controlPoints = Array.isArray(req.body?.controlPoints) ? req.body.controlPoints : [];
    const calibration = computeHomographyCalibration(controlPoints);
    window.controlPoints = controlPoints;
    window.calibration = calibration;
    window.updatedAt = new Date().toISOString();
    await persist();
    res.json({ ok: true, windowId: window.id, calibration });
  } catch (err) {
    res.status(400).json(errorBody('CALIBRATION_FAILED', err.message));
  }
});

app.post('/api/sources/rtsp/test', async (req, res) => {
  try {
    const rawUrl = String(req.body?.url || '').trim();
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return res.status(400).json(errorBody('RTSP_URL_INVALID', 'RTSP 地址格式无效')); }
    if (!['rtsp:', 'rtsps:'].includes(parsed.protocol)) return res.status(400).json(errorBody('RTSP_PROTOCOL_INVALID', '只允许 rtsp:// 或 rtsps:// 地址'));
    if (!rtspAllowedHosts.has(parsed.hostname.toLowerCase())) return res.status(403).json(errorBody('RTSP_HOST_NOT_ALLOWED', '该 RTSP 主机不在服务端允许列表中'));
    if (!commandAvailable('ffprobe')) return res.status(503).json(errorBody('FFPROBE_UNAVAILABLE', '未找到 FFprobe，无法测试 RTSP'));
    const result = await runProcess('ffprobe', ['-v', 'error', '-rtsp_transport', 'tcp', '-timeout', '5000000', '-show_entries', 'format=duration:stream=width,height,avg_frame_rate,codec_name', '-of', 'json', rawUrl]);
    if (result.code !== 0) return res.status(502).json(errorBody('RTSP_CONNECT_FAILED', 'RTSP 连接或解码测试失败', { stderr: result.stderr.slice(0, 800).replaceAll(rawUrl, '[redacted-rtsp-url]') }));
    let metadata;
    try { metadata = JSON.parse(result.stdout); } catch { return res.status(502).json(errorBody('RTSP_METADATA_INVALID', 'FFprobe 返回了不可解析的元数据')); }
    res.json({ ok: true, source: { protocol: parsed.protocol.slice(0, -1), host: parsed.hostname, metadata, testedAt: new Date().toISOString() } });
  } catch (err) {
    res.status(500).json(errorBody('RTSP_TEST_FAILED', err.message));
  }
});

app.post('/api/scene/site-corridor', async (req, res) => {
  try {
    assertProject();
    const sceneId = await enforceSceneModelingGate(req.body);
    if (isVideoRouteGenerationBlocked()) {
      return res.status(409).json(errorBody(
        'SITE_CORRIDOR_VIDEO_SCOPE_NOT_REANCHORED',
        '视频资料范围已补齐，但完整运动方向、首尾连续性和路线重定位尚未完成；请先完成视频证据重定位，避免再次生成错误位置的三维路线'
      ));
    }
    const videoAssetIds = Array.isArray(req.body?.videoAssetIds) ? req.body.videoAssetIds.map((value) => String(value || '').trim()) : [];
    if (videoAssetIds.length !== 7 || new Set(videoAssetIds).size !== 7) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_VIDEO_ORDER_REQUIRED', '连续小道重建必须按顺序选择7段互不重复的视频'));
    }
    const videos = videoAssetIds.map((assetId) => store.assets.find((asset) => asset.id === assetId && asset.projectId === store.project.id));
    if (videos.some((asset) => !asset || asset.type !== 'video')) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_VIDEO_INVALID', '所选7个来源必须全部是当前项目中的视频资产'));
    }
    if (videos.some(isLikelyTestAsset)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_VIDEO_TEST_ONLY', '连续小道重建不能使用 TEST ONLY / 虚拟视频'));
    }
    if (videos.some(isExcludedProjectVideo)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_VIDEO_OUT_OF_SCOPE', '连续小道重建不能使用已隔离的未确认现场视频'));
    }
    const expectedPrefixes = ['450d', '4444', 'b322', '1572', '783e', 'f684', '4b75'];
    const invalidIndex = videos.findIndex((asset, index) => !String(asset.name || '').toLowerCase().startsWith(expectedPrefixes[index]));
    if (invalidIndex >= 0) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_VIDEO_SEQUENCE_INVALID', `第${invalidIndex + 1}段视频顺序错误；期望文件名以 ${expectedPrefixes[invalidIndex]} 开头`));
    }
    const frameFps = Number(req.body?.frameFps ?? 4);
    if (!Number.isFinite(frameFps) || frameFps < 1 || frameFps > 8) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_FRAME_FPS_INVALID', '关键帧采样率必须在 1–8 fps 之间'));
    }
    const requestedBuildingId = String(req.body?.mainBuildingArtifactId || '').trim();
    const eligibleBuildingKinds = new Set(['skp_glb', 'dwg_extrusion_glb', 'blender_enhanced_glb']);
    const mainBuildingArtifact = requestedBuildingId
      ? store.artifacts.find((artifact) => artifact.id === requestedBuildingId && artifact.projectId === store.project.id && eligibleBuildingKinds.has(artifact.kind) && artifact.metadata?.stale !== true)
      : [...recordsForProject(store.artifacts)].reverse().find((artifact) => artifact.kind === 'skp_glb' && artifact.metadata?.stale !== true)
        || [...recordsForProject(store.artifacts)].reverse().find((artifact) => artifact.kind === 'dwg_extrusion_glb' && artifact.metadata?.stale !== true);
    if (!mainBuildingArtifact) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_MAIN_BUILDING_REQUIRED', '请先导入并转换主楼 SKP，或选择有效的 CAD 室内 GLB'));
    }
    const requestedPhotoAssetIds = Array.isArray(req.body?.photoAssetIds)
      ? req.body.photoAssetIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    if (new Set(requestedPhotoAssetIds).size !== requestedPhotoAssetIds.length) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_PHOTO_EVIDENCE_INVALID', '补充照片不能重复'));
    }
    const requestedPhotoAssets = requestedPhotoAssetIds.map((assetId) => store.assets.find((asset) => asset.id === assetId && asset.projectId === store.project.id));
    if (requestedPhotoAssets.some((asset) => !asset || asset.type !== 'image' || isLikelyTestAsset(asset))) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_PHOTO_EVIDENCE_INVALID', '补充照片必须属于当前项目，且不能是 TEST ONLY 资料'));
    }
    const panoramaAssetIds = Array.isArray(req.body?.panoramaAssetIds) ? req.body.panoramaAssetIds.map((value) => String(value || '').trim()).filter(Boolean) : [];
    if (panoramaAssetIds.length && panoramaAssetIds.length !== 11) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_PANORAMA_SEQUENCE_REQUIRED', '全景校正必须按路线顺序选择11张约10米采样截图'));
    }
    if (new Set(panoramaAssetIds).size !== panoramaAssetIds.length) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_PANORAMA_EVIDENCE_INVALID', '全景截图不能重复'));
    }
    const panoramaAssets = panoramaAssetIds.map((assetId) => store.assets.find((asset) => asset.id === assetId && asset.projectId === store.project.id));
    if (panoramaAssets.some((asset) => !asset || asset.type !== 'image' || isLikelyTestAsset(asset))) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_PANORAMA_EVIDENCE_INVALID', '全景截图必须属于当前项目，且不能是 TEST ONLY 资料'));
    }
    // A corridor rebuild must not silently discard field photographs just
    // because the UI selection was stale or capped.  Union the requested
    // list with every current-project field image, while keeping panorama
    // evidence in its dedicated channel to avoid duplicate worker passes.
    const panoramaIdSet = new Set(panoramaAssetIds);
    const allFieldPhotoAssets = recordsForProject(store.assets)
      .filter((asset) => asset.type === 'image' && !isLikelyTestAsset(asset));
    const allProjectVideoAssets = recordsForProject(store.assets)
      .filter((asset) => isProjectFieldVideo(asset));
    const photoAssets = [...new Map(
      [...requestedPhotoAssets, ...allFieldPhotoAssets]
        .filter((asset) => !panoramaIdSet.has(asset.id))
        .map((asset) => [asset.id, asset])
    ).values()];
    const photoAssetIds = photoAssets.map((asset) => asset.id);
    const supplementalVideoAssetId = String(req.body?.supplementalVideoAssetId || '').trim();
    const supplementalVideoAsset = supplementalVideoAssetId
      ? store.assets.find((asset) => asset.id === supplementalVideoAssetId && asset.projectId === store.project.id && asset.type === 'video')
      : null;
    if (supplementalVideoAssetId && !supplementalVideoAsset) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_SUPPLEMENTAL_VIDEO_INVALID', '补充固定机位视频必须属于当前项目'));
    }
    if (supplementalVideoAsset && isLikelyTestAsset(supplementalVideoAsset)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_SUPPLEMENTAL_VIDEO_TEST_ONLY', '补充固定机位视频不能是 TEST ONLY 资料'));
    }
    if (supplementalVideoAsset && isExcludedProjectVideo(supplementalVideoAsset)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_SUPPLEMENTAL_VIDEO_OUT_OF_SCOPE', '补充固定机位视频不能使用已隔离的未确认现场视频'));
    }
    const returnVideoAssetIds = Array.isArray(req.body?.returnVideoAssetIds)
      ? req.body.returnVideoAssetIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    if (returnVideoAssetIds.length && (returnVideoAssetIds.length !== 5 || new Set(returnVideoAssetIds).size !== 5)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_RETURN_VIDEO_SEQUENCE_REQUIRED', '回程路线必须按顺序选择5段互不重复的视频'));
    }
    const returnVideoAssets = returnVideoAssetIds.map((assetId) => store.assets.find((asset) => asset.id === assetId && asset.projectId === store.project.id));
    if (returnVideoAssets.some((asset) => !asset || asset.type !== 'video')) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_RETURN_VIDEO_INVALID', '回程路线视频必须全部属于当前项目'));
    }
    if (returnVideoAssets.some(isLikelyTestAsset)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_RETURN_VIDEO_TEST_ONLY', '回程路线不能使用 TEST ONLY / 虚拟视频'));
    }
    if (returnVideoAssets.some(isExcludedProjectVideo)) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_RETURN_VIDEO_OUT_OF_SCOPE', '回程路线不能使用已隔离的未确认现场视频'));
    }
    const returnExpectedPrefixes = ['04c3', 'db13', '977c', '76c9', '6f07'];
    const invalidReturnIndex = returnVideoAssets.findIndex((asset, index) => !String(asset.name || '').toLowerCase().startsWith(returnExpectedPrefixes[index]));
    if (invalidReturnIndex >= 0) {
      return res.status(400).json(errorBody('SITE_CORRIDOR_RETURN_VIDEO_SEQUENCE_INVALID', `回程第${invalidReturnIndex + 1}段视频顺序错误；期望文件名以 ${returnExpectedPrefixes[invalidReturnIndex]} 开头`));
    }
    const blenderAvailable = commandAvailable(blenderBin);
    const blenderExplicitlyRequested = req.body?.useBlender === true;
    const rebuild = req.body?.rebuild === true;
    // Keep the request-level Blender capability explicit for diagnostics and
    // backward-compatible callers. A clean rebuild deliberately bypasses the
    // previous Blender refinement chain, so only the effective flag is forced
    // off for that job.
    const useBlender = req.body?.useBlender === false ? false : blenderAvailable;
    const effectiveUseBlender = rebuild ? false : useBlender;
    const maxBlenderBevelObjects = Number(req.body?.maxBlenderBevelObjects ?? 450);
    if (!Number.isFinite(maxBlenderBevelObjects) || maxBlenderBevelObjects < 0 || maxBlenderBevelObjects > 1200) {
      return res.status(400).json(errorBody('BLENDER_BEVEL_LIMIT_INVALID', 'Blender 倒角对象上限必须在 0–1200 之间'));
    }
    if (blenderExplicitlyRequested && !blenderAvailable) {
      return res.status(503).json(errorBody('BLENDER_RUNTIME_UNAVAILABLE', '已要求使用 Blender 精修，但服务端未检测到可用的 BLENDER_BIN'));
    }
    const job = {
      id: id('job'),
      projectId: store.project.id,
      anchorHash: geoAnchorHash(store.project),
      type: 'site_corridor_reconstruction',
      status: 'queued',
      stage: 'runtime_preflight',
      progress: 0,
      createdAt: new Date().toISOString(),
      sourceAssetIds: [...new Set([...allProjectVideoAssets.map((asset) => asset.id), ...photoAssetIds, ...panoramaAssetIds, ...(supplementalVideoAsset ? [supplementalVideoAsset.id] : [])])],
      videoAssetIds,
      allProjectVideoAssetIds: allProjectVideoAssets.map((asset) => asset.id),
      returnVideoAssetIds,
      photoAssetIds,
      panoramaAssetIds,
      supplementalVideoAssetId: supplementalVideoAsset?.id || null,
      mainBuildingArtifactId: mainBuildingArtifact.id,
      scope: 'route_visible_sides',
      frameFps,
      useBlender: effectiveUseBlender,
      rebuild,
      maxBlenderBevelObjects,
      sceneId: sceneId || null,
      candidateLayer: Boolean(sceneId),
      diagnostics: []
    };
    store.jobs.push(job);
    emitJobEvent(job.id, 'job.started', { title: '连续视频建筑周边小道重建' });
    await persist();
    void runSiteCorridorJob(job, videos, mainBuildingArtifact, {
      frameFps,
      scope: 'route_visible_sides',
      visualContinuity: true,
      photoAssets,
      panoramaAssets,
      allProjectVideoAssets,
      supplementalVideoAsset,
      returnVideoAssets,
      useBlender: effectiveUseBlender,
      rebuild,
      maxBlenderBevelObjects
    });
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SITE_CORRIDOR_RECONSTRUCTION_FAILED', err.message));
  }
});

app.post('/api/scene/reconstruct', async (req, res) => {
  try {
    assertProject();
    const sceneId = await enforceSceneModelingGate(req.body);
    const sourceAssetIds = Array.isArray(req.body?.assetIds) ? req.body.assetIds : [];
    const assets = sourceAssetIds.map((assetId) => store.assets.find((asset) => asset.id === assetId && asset.projectId === store.project.id)).filter(Boolean);
    if (!assets.length) return res.status(400).json(errorBody('SCENE_ASSETS_REQUIRED', '请先选择用于重建的影像或模型资产'));
    const hasPython = commandAvailable(pythonCommand());
    const movingImages = assets.some((asset) => asset.type === 'image' || asset.type === 'video');
    const job = {
      id: id('job'), projectId: store.project.id, type: 'scene_reconstruction', status: hasPython ? 'queued' : 'blocked',
      createdAt: new Date().toISOString(), sourceAssetIds, stage: 'preflight', progress: 0,
      sceneId: sceneId || null,
      candidateLayer: Boolean(sceneId),
      qualityGate: { minRegisteredViews: 30, minRegistrationRate: 0.7, maxMedianReprojectionPx: 2 },
      diagnostics: []
    };
    if (!movingImages) job.diagnostics.push('未发现可用于摄影测量的影像；仅有地图或固定机位视频不能生成3DGS。');
    if (!hasPython) job.diagnostics.push('未找到 Python Worker 运行时。');
    if (job.status === 'blocked') {
      store.jobs.push(job);
      emitJobEvent(job.id, 'job.started', { title: '三维重建预检' });
      emitJobEvent(job.id, 'step.failed', { stepId: 'runtime_preflight', error: job.diagnostics.join(' '), recoverable: true });
      await persist();
      return res.status(503).json({ ok: false, job, error: { code: 'SCENE_RUNTIME_UNAVAILABLE', message: '3D重建任务未启动：运行环境不满足质量门槛', details: job.diagnostics } });
    }
    store.jobs.push(job);
    emitJobEvent(job.id, 'job.started', { title: '三维重建' });
    emitJobEvent(job.id, 'step.started', { stepId: 'preflight', title: '检查影像与运行时' });
    await persist();
    void runScenePreflightJob(job, assets);
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SCENE_JOB_FAILED', err.message));
  }
});

app.post('/api/scene/dwg-extrusion', async (req, res) => {
  try {
    assertProject();
    const assetId = String(req.body?.assetId || '').trim();
    const asset = store.assets.find((item) => item.id === assetId && item.projectId === store.project.id);
    if (!asset) return res.status(404).json(errorBody('DWG_ASSET_NOT_FOUND', '找不到当前项目中的 DWG 平面图'));
    if (path.extname(asset.name || asset.storedPath || '').toLowerCase() !== '.dwg') {
      return res.status(400).json(errorBody('DWG_ASSET_REQUIRED', '所选资产不是 DWG 平面图'));
    }
    if (!asset.storedPath || !storedPathIsInside(asset.storedPath, uploadDir)) {
      return res.status(404).json(errorBody('DWG_FILE_NOT_FOUND', 'DWG 文件不属于允许的上传存储边界'));
    }
    const stat = await fsp.stat(asset.storedPath).catch(() => null);
    if (!stat?.isFile()) return res.status(404).json(errorBody('DWG_FILE_NOT_FOUND', 'DWG 文件不存在或不可读'));

    const regionMode = String(req.body?.regionMode || 'auto_dominant').trim();
    if (!['auto_dominant', 'all_candidates'].includes(regionMode)) {
      return res.status(400).json(errorBody('DWG_REGION_MODE_INVALID', '平面范围必须为 auto_dominant 或 all_candidates'));
    }
    const includeLayers = Array.isArray(req.body?.includeLayers)
      ? [...new Set(req.body.includeLayers.map((value) => String(value).trim()).filter(Boolean))]
      : [];
    if (includeLayers.length > 200 || includeLayers.some((layer) => layer.length > 120)) {
      return res.status(400).json(errorBody('DWG_LAYER_FILTER_INVALID', 'DWG 图层筛选最多 200 项，单个图层名不能超过 120 个字符'));
    }
    const options = {
      includeLayers,
      regionMode,
      wallHeightM: Number(req.body?.wallHeightM ?? 3.2),
      wallThicknessM: Number(req.body?.wallThicknessM ?? 0.18),
      floorSlabThicknessM: Number(req.body?.floorSlabThicknessM ?? 0.12),
      doorHeightM: Number(req.body?.doorHeightM ?? 2.1),
      windowSillM: Number(req.body?.windowSillM ?? 0.9),
      windowHeadM: Number(req.body?.windowHeadM ?? 2.4),
      floorCount: Number(req.body?.floorCount ?? 1),
      storeyHeightM: Number(req.body?.storeyHeightM ?? 3.6),
      regionRadiusM: Number(req.body?.regionRadiusM ?? 90)
    };
    const validParameters = Number.isFinite(options.wallHeightM) && options.wallHeightM >= 1.8 && options.wallHeightM <= 8
      && Number.isFinite(options.wallThicknessM) && options.wallThicknessM >= 0.05 && options.wallThicknessM <= 0.8
      && Number.isFinite(options.floorSlabThicknessM) && options.floorSlabThicknessM >= 0.05 && options.floorSlabThicknessM <= 0.5
      && Number.isFinite(options.doorHeightM) && options.doorHeightM >= 1.8 && options.doorHeightM <= Math.min(3.5, options.wallHeightM)
      && Number.isFinite(options.windowSillM) && options.windowSillM >= 0 && options.windowSillM <= options.wallHeightM - 0.4
      && Number.isFinite(options.windowHeadM) && options.windowHeadM >= options.windowSillM + 0.4 && options.windowHeadM <= options.wallHeightM
      && Number.isInteger(options.floorCount) && options.floorCount >= 1 && options.floorCount <= 20
      && Number.isFinite(options.storeyHeightM) && options.storeyHeightM >= options.wallHeightM && options.storeyHeightM <= 12
      && Number.isFinite(options.regionRadiusM) && options.regionRadiusM >= 20 && options.regionRadiusM <= 300;
    if (!validParameters) {
      return res.status(400).json(errorBody(
        'DWG_EXTRUSION_PARAMETERS_INVALID',
        '参数范围：墙高 1.8–8m、墙厚 0.05–0.8m、楼板厚 0.05–0.5m、门高 1.8–3.5m、窗顶高高于窗台至少 0.4m且不超过墙高、楼层数 1–20、层高不低于墙高且不超过 12m、识别半径 20–300m'
      ));
    }

    const runId = id('dwg_volume');
    const outputPath = path.join(artifactDir, runId, 'dwg-parametric-supplement.glb');
    const result = await convertDwgToExtrusion({ inputPath: asset.storedPath, outputPath, options });
    const artifact = await addArtifact({
      projectId: store.project.id,
      jobId: null,
      kind: 'dwg_extrusion_glb',
      title: `${path.parse(asset.name).name} · CAD 室内三维`,
      storedPath: outputPath,
      evidenceLevel: 'Hypothesis',
      metadata: {
        sourceAssetId: asset.id,
        sourceAssetName: asset.name,
        sourceSha256: asset.sha256,
        sourceNature: asset.sourceNature,
        testOnly: Boolean(asset.testOnly),
        ...result
      }
    });
    await persist();
    res.status(201).json({ ok: true, artifact: publicArtifact(artifact) });
  } catch (err) {
    const knownErrors = {
      DWG_EXTRUSION_METRIC_UNITS_REQUIRED: ['DWG_METRIC_UNITS_REQUIRED', 'DWG 未声明可识别的米制单位，不能生成可用于空间分析的三维体量'],
      DWG_EXTRUSION_NO_ARCHITECTURAL_LAYERS: ['DWG_ARCHITECTURAL_LAYERS_NOT_FOUND', '未在所选范围或图层中识别到可拉伸的墙、柱或玻璃线条']
    };
    const [code, message] = knownErrors[err.message] || [err.code || 'DWG_EXTRUSION_FAILED', err.message || 'DWG 参数化补模失败'];
    res.status(err.status || (knownErrors[err.message] ? 422 : 500)).json(errorBody(code, message));
  }
});

app.post('/api/scene/blender-enhance', async (req, res) => {
  let lockKey = null;
  let lockAcquired = false;
  try {
    assertProject();
    const sourceArtifactId = String(req.body?.sourceArtifactId || '').trim();
    const sourceArtifact = store.artifacts.find((item) => item.id === sourceArtifactId
      && item.projectId === store.project.id
      && item.kind === 'dwg_extrusion_glb'
      && item.metadata?.stale !== true);
    if (!sourceArtifact) return res.status(404).json(errorBody('BLENDER_SOURCE_ARTIFACT_NOT_FOUND', '找不到当前项目有效的 CAD 室内三维资产'));
    if (!sourceArtifact.storedPath || !storedPathIsInside(sourceArtifact.storedPath, artifactDir)) {
      return res.status(404).json(errorBody('BLENDER_SOURCE_FILE_NOT_FOUND', 'CAD 室内三维不属于允许的阶段资产存储边界'));
    }
    const sourceStat = await fsp.stat(sourceArtifact.storedPath).catch(() => null);
    if (!sourceStat?.isFile()) return res.status(404).json(errorBody('BLENDER_SOURCE_FILE_NOT_FOUND', 'CAD 室内三维文件不存在或不可读'));
    if (!commandAvailable(blenderBin)) return res.status(503).json(errorBody('BLENDER_RUNTIME_UNAVAILABLE', '未检测到 Blender 后台运行时，请配置 BLENDER_BIN'));

    const levels = Array.isArray(sourceArtifact.metadata?.levels) ? sourceArtifact.metadata.levels : [];
    const fallbackFloor = Number(levels[0]?.floorNumber || 1);
    const previewFloor = Number(req.body?.previewFloor ?? fallbackFloor);
    if (!Number.isInteger(previewFloor) || (levels.length && !levels.some((level) => Number(level.floorNumber) === previewFloor))) {
      return res.status(400).json(errorBody('BLENDER_PREVIEW_FLOOR_INVALID', '预览楼层必须来自当前 CAD 室内模型的已识别楼层'));
    }

    lockKey = `blender:${store.project.id}:${sourceArtifact.id}`;
    if (!exportLocks.acquire(lockKey)) return res.status(409).json(errorBody('BLENDER_ENHANCEMENT_IN_PROGRESS', '该模型正在进行 Blender 增强，请等待当前任务完成'));
    lockAcquired = true;
    const runId = id('blender');
    const outputDir = path.join(artifactDir, runId);
    const tempDir = path.join(outputDir, 'temp');
    const metadataPath = path.join(outputDir, 'source-metadata.json');
    await fsp.mkdir(tempDir, { recursive: true });
    await fsp.writeFile(metadataPath, JSON.stringify(sourceArtifact.metadata || {}, null, 2), 'utf8');
    const worker = path.join(rootDir, 'workers', 'blender_enhance.py');
    const result = await runProcess(blenderBin, [
      '--background', '--python-exit-code', '1', '--python', worker, '--',
      '--source', sourceArtifact.storedPath,
      '--metadata', metadataPath,
      '--output-dir', outputDir,
      '--preview-floor', String(previewFloor)
    ], { env: { TEMP: tempDir, TMP: tempDir } });
    const payload = lastJsonLine(result.stdout) || lastJsonLine(result.stderr);
    if (result.code !== 0 || !payload?.ok) {
      const error = new Error(payload?.error || result.stderr.trim().slice(-1000) || 'Blender Worker 失败');
      error.code = 'BLENDER_ENHANCEMENT_FAILED';
      throw error;
    }

    const files = Array.isArray(payload.result?.files) ? payload.result.files : [];
    const expectedKinds = new Set(['blender_scene_blend', 'blender_enhanced_glb', 'blender_preview_png', 'blender_manifest_json']);
    const produced = new Map();
    for (const file of files) {
      if (!expectedKinds.has(file?.kind)) continue;
      const storedPath = path.resolve(String(file.path || ''));
      if (!storedPathIsInside(storedPath, outputDir)) throw Object.assign(new Error('Blender Worker 返回了越界文件路径'), { code: 'BLENDER_OUTPUT_PATH_INVALID' });
      const stat = await fsp.stat(storedPath).catch(() => null);
      if (!stat?.isFile()) throw Object.assign(new Error(`Blender Worker 缺少产物 ${file.kind}`), { code: 'BLENDER_OUTPUT_MISSING' });
      produced.set(file.kind, storedPath);
    }
    for (const kind of expectedKinds) if (!produced.has(kind)) throw Object.assign(new Error(`Blender Worker 缺少产物 ${kind}`), { code: 'BLENDER_OUTPUT_MISSING' });

    const enhancement = {
      schema: payload.result.schema,
      blenderVersion: payload.result.blenderVersion,
      sourceArtifactId: sourceArtifact.id,
      sourceArtifactSha256: sourceArtifact.sha256,
      geometryEvidenceLevel: payload.result.geometryEvidenceLevel,
      materialFinishEvidenceLevel: payload.result.materialFinishEvidenceLevel,
      enhancedMaterials: payload.result.enhancedMaterials,
      generatedTextureCount: payload.result.generatedTextureCount,
      previewCamera: payload.result.previewCamera,
      dataGaps: payload.result.dataGaps
    };
    const titles = {
      blender_scene_blend: `${sourceArtifact.title} · Blender 可编辑源文件`,
      blender_enhanced_glb: `${sourceArtifact.title} · Blender PBR 增强`,
      blender_preview_png: `${sourceArtifact.title} · ${previewFloor}F 参观预览`,
      blender_manifest_json: `${sourceArtifact.title} · Blender 增强清单`
    };
    const artifacts = [];
    for (const kind of ['blender_scene_blend', 'blender_enhanced_glb', 'blender_preview_png', 'blender_manifest_json']) {
      const metadata = kind === 'blender_enhanced_glb'
        ? { ...sourceArtifact.metadata, blenderEnhancement: enhancement, sourceArtifactId: sourceArtifact.id }
        : { ...enhancement, previewFloor };
      artifacts.push(await addArtifact({
        projectId: store.project.id,
        jobId: null,
        kind,
        title: titles[kind],
        storedPath: produced.get(kind),
        evidenceLevel: 'Hypothesis',
        metadata
      }));
    }
    const replacementGlb = artifacts.find((artifact) => artifact.kind === 'blender_enhanced_glb');
    for (const prior of store.artifacts) {
      if (prior.id === replacementGlb.id || prior.projectId !== store.project.id || prior.kind !== 'blender_enhanced_glb') continue;
      if (prior.metadata?.sourceArtifactId !== sourceArtifact.id || prior.metadata?.supersededAt) continue;
      prior.metadata = { ...(prior.metadata || {}), supersededAt: new Date().toISOString(), supersededBy: replacementGlb.id };
    }
    await persist();
    res.status(201).json({ ok: true, enhancement, artifacts: artifacts.map(publicArtifact) });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'BLENDER_ENHANCEMENT_FAILED', err.message));
  } finally {
    if (lockAcquired) exportLocks.release(lockKey);
  }
});

app.post('/api/scene/context', async (req, res) => {
  try {
    assertProject();
    const radiusMeters = Number(req.body?.radiusMeters ?? 250);
    if (!Number.isFinite(radiusMeters) || radiusMeters < 50 || radiusMeters > 1000) {
      return res.status(400).json(errorBody('OSM_RADIUS_INVALID', 'OSM 地理底景半径必须在 50–1000 米之间'));
    }
    const job = {
      id: id('job'), projectId: store.project.id, anchorHash: geoAnchorHash(store.project), type: 'geographic_context', status: 'queued', stage: 'overpass_fetch', progress: 0,
      createdAt: new Date().toISOString(), radiusMeters, diagnostics: []
    };
    store.jobs.push(job);
    emitJobEvent(job.id, 'job.started', { title: 'OSM 地理底景生成' });
    await persist();
    void runGeographicContextJob(job, radiusMeters);
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'OSM_CONTEXT_FAILED', err.message));
  }
});

app.get('/api/scene/semantic-candidates', (_req, res) => {
  res.json({ ok: true, candidates: recordsForProject(store.semanticCandidates) });
});

app.post('/api/scene/segment', async (req, res) => {
  try {
    assertProject();
    const asset = store.assets.find((item) => item.id === req.body?.assetId && item.projectId === store.project.id);
    if (!asset || asset.type !== 'image') return res.status(400).json(errorBody('IMAGE_ASSET_REQUIRED', '请选择真实现场图片'));
    const requestedLabels = Array.isArray(req.body?.labels) ? req.body.labels : [];
    const labels = [...new Set(requestedLabels.map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
    if (!labels.length) return res.status(400).json(errorBody('SEMANTIC_LABELS_REQUIRED', '请提供至少一个英文语义标签'));
    if (labels.length > 16 || labels.some((label) => !/^[a-z0-9][a-z0-9 _-]{0,47}$/.test(label))) {
      return res.status(400).json(errorBody('SEMANTIC_LABELS_INVALID', '语义标签最多16个，仅允许英文、数字、空格、下划线和短横线'));
    }
    const boxThreshold = Number(req.body?.boxThreshold ?? 0.28);
    const textThreshold = Number(req.body?.textThreshold ?? 0.25);
    const maxDetections = Number(req.body?.maxDetections ?? 40);
    if (![boxThreshold, textThreshold].every((value) => Number.isFinite(value) && value >= 0.05 && value <= 0.95) || !Number.isInteger(maxDetections) || maxDetections < 1 || maxDetections > 100) {
      return res.status(400).json(errorBody('SEMANTIC_THRESHOLDS_INVALID', '检测阈值须为0.05–0.95，最大候选数须为1–100的整数'));
    }
    const runtime = semanticRuntimeStatus();
    const diagnostics = [];
    if (!semanticPythonRuntimeReady) diagnostics.push('Python 缺少 torch、torchvision、transformers、Pillow 或 OpenCV 语义运行时。');
    if (!groundingDinoModel) diagnostics.push('未配置 GROUNDING_DINO_MODEL。');
    else if (!runtime.groundingDino.available) diagnostics.push(runtime.groundingDino.source === 'remote_repository' ? 'Grounding DINO 远程模型下载未启用或运行时不可用。' : 'Grounding DINO 本地模型不存在或不可读。');
    if (!sam2Model) diagnostics.push('未配置 SAM2_MODEL。');
    else if (!runtime.sam2.available) diagnostics.push(runtime.sam2.source === 'remote_repository' ? 'SAM 2 远程模型下载未启用或运行时不可用。' : 'SAM 2 本地模型不存在或不可读。');
    const job = {
      id: id('job'), projectId: store.project.id, type: 'semantic_extraction', status: diagnostics.length ? 'blocked' : 'queued',
      createdAt: new Date().toISOString(), assetId: asset.id, labels,
      sourceNature: inferredSourceNature(asset), testOnly: inferredSourceNature(asset) === 'virtual_test',
      sampling: { boxThreshold, textThreshold, maxDetections }, stage: 'runtime_preflight', progress: 0, diagnostics
    };
    store.jobs.push(job);
    emitJobEvent(job.id, 'job.started', { title: 'Grounding DINO + SAM 2 语义识别' });
    if (job.status === 'blocked') {
      emitJobEvent(job.id, 'step.failed', { stepId: 'runtime_preflight', error: diagnostics.join(' '), recoverable: true });
      await persist();
      return res.status(503).json({ ok: false, job, error: { code: 'SEMANTIC_RUNTIME_UNAVAILABLE', message: '语义识别未启动：缺少真实模型或运行时', details: diagnostics } });
    }
    job.stage = 'grounding_dino';
    emitJobEvent(job.id, 'step.started', { stepId: 'runtime_preflight', title: '检查真实图片、模型与运行时' });
    await persist();
    void runSemanticExtractionJob(job, asset, labels, { box: boxThreshold, text: textThreshold, maxDetections });
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SEMANTIC_JOB_FAILED', err.message));
  }
});

app.post('/api/vision/analyze', async (req, res) => {
  try {
    assertProject();
    const asset = store.assets.find((item) => item.id === req.body?.assetId && item.projectId === store.project.id);
    if (!asset || asset.type !== 'video') return res.status(400).json(errorBody('VIDEO_ASSET_REQUIRED', '请选择已上传的视频资产'));
    const modelPath = String(process.env.YOLO_MODEL_PATH || '').trim();
    const modelReady = readableFileAvailable(modelPath);
    const runtimeReady = commandAvailable(pythonCommand()) && commandAvailable('ffprobe');
    const requestedFps = Number(req.body?.fps ?? 15);
    if (!Number.isFinite(requestedFps) || requestedFps < 5 || requestedFps > 20) {
      return res.status(400).json(errorBody('VISION_SAMPLE_FPS_INVALID', '视频抽帧率必须在 5–20 fps 之间'));
    }
    const job = {
      id: id('job'), projectId: store.project.id, type: 'vision_analysis', status: modelReady && runtimeReady ? 'queued' : 'blocked',
      createdAt: new Date().toISOString(), assetId: asset.id, slotId: req.body?.slotId || null, windowId: req.body?.windowId || null,
      sourceNature: inferredSourceNature(asset, req.body?.sourceNature),
      sampling: { fps: requestedFps, tracker: 'ByteTrack', detector: 'YOLOX-s ONNX' },
      output: null, diagnostics: []
    };
    if (!modelPath) job.diagnostics.push('未配置 YOLO_MODEL_PATH；请提供真实 YOLOX-s ONNX 权重，系统不会生成模拟检测。');
    else if (!modelReady) job.diagnostics.push('YOLO_MODEL_PATH 不是可读的真实 ONNX 权重文件。');
    if (!commandAvailable(pythonCommand())) job.diagnostics.push('未找到 Python Worker 运行时。');
    if (!commandAvailable('ffprobe')) job.diagnostics.push('未找到 FFprobe，无法验证视频元数据。');
    if (job.status === 'blocked') {
      store.jobs.push(job);
      emitJobEvent(job.id, 'job.started', { title: '视频视觉分析预检' });
      emitJobEvent(job.id, 'step.failed', { stepId: 'runtime_preflight', error: job.diagnostics.join(' '), recoverable: true });
      await persist();
      return res.status(503).json({ ok: false, job, error: { code: 'VISION_RUNTIME_UNAVAILABLE', message: '视觉分析未启动：缺少真实模型或运行时', details: job.diagnostics } });
    }
    store.jobs.push(job);
    emitJobEvent(job.id, 'job.started', { title: 'YOLOX + ByteTrack 视频分析' });
    emitJobEvent(job.id, 'step.started', { stepId: 'decode', title: 'FFmpeg 解码视频' });
    await persist();
    void runVisionJob(job, asset);
    res.status(202).json({ ok: true, job });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'VISION_JOB_FAILED', err.message));
  }
});

app.get('/api/jobs', (_req, res) => res.json({ ok: true, jobs: recordsForProject(store.jobs) }));

app.get('/api/observations', (_req, res) => {
  res.json({ ok: true, observations: recordsForProject(store.observations) });
});

app.get('/api/transport/plan', (_req, res) => {
  try {
    assertProject();
    const basePlan = buildTransportPlan(store.project);
    const persisted = store.project.transportAccess || {};
    res.json({
      ok: true,
      plan: {
        ...basePlan,
        review: persisted.review || null,
        lastSimulation: persisted.lastSimulation || null
      }
    });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'TRANSPORT_PLAN_FAILED', err.message));
  }
});

app.post('/api/transport/simulate', async (req, res) => {
  try {
    assertProject();
    const plan = buildTransportPlan(store.project);
    const simulation = simulateTransportPlan(plan, String(req.body?.scenarioId || 'weekday-0830'));
    const now = new Date().toISOString();
    for (const road of plan.roads) {
      const objectId = `transport-${road.id}`;
      const existing = store.sceneObjects.find((item) => item.projectId === store.project.id && item.id === objectId);
      const record = {
        id: objectId,
        projectId: store.project.id,
        type: 'road',
        label: road.label,
        geometry: road.geometry,
        properties: {
          role: 'transport_scenario_road',
          transportPlanId: plan.planId,
          capacityPerHour: road.capacityPerHour,
          complexity: road.complexity,
          source: 'user_defined_simulation_from_navigation_and_map_markup',
          evidenceLevel: 'Scenario',
          stale: false
        },
        evidenceLevel: 'Scenario',
        sourceAssetIds: [],
        updatedAt: now
      };
      if (existing) Object.assign(existing, record);
      else store.sceneObjects.push({ ...record, createdAt: now });
    }
    store.project.transportAccess = {
      ...(store.project.transportAccess || {}),
      planId: plan.planId,
      lastSimulation: simulation,
      simulatedAt: new Date().toISOString()
    };
    await persist();
    res.json({ ok: true, plan: { ...plan, ...store.project.transportAccess }, simulation });
  } catch (err) {
    res.status(err.status || 422).json(errorBody(err.code || 'TRANSPORT_SIMULATION_FAILED', err.message));
  }
});

app.post('/api/transport/review', async (req, res) => {
  try {
    assertProject();
    const review = normalizeTransportReview(req.body || {});
    store.project.transportAccess = {
      ...(store.project.transportAccess || {}),
      planId: 'transport-access-phase2-v1',
      review
    };
    store.reviews.push({
      id: id('review'),
      projectId: store.project.id,
      targetId: 'transport-access-phase2-v1',
      targetType: 'transport_plan',
      ...review
    });
    await persist();
    res.status(201).json({ ok: true, review, plan: { ...buildTransportPlan(store.project), ...store.project.transportAccess } });
  } catch (err) {
    res.status(err.status || 422).json(errorBody(err.code || 'TRANSPORT_REVIEW_FAILED', err.message));
  }
});

function canonicalObservationBundle({ slotId = null, sceneVersion = 'unversioned' } = {}) {
  assertProject();
  const sourceObservations = store.observations.filter((item) => item.schema === 'observation_bundle.v1' && item.projectId === store.project.id);
  const windows = recordsForProject(store.videoWindows).map((window) => {
    const observation = [...sourceObservations].reverse().find((item) => item.sourceWindowId === window.id);
    return observation ? {
      ...window,
      sourceNature: window.sourceNature || observation.sourceNature || inferredSourceNature(store.assets.find((asset) => asset.id === window.assetId)),
      metrics: observation.metrics || [],
      conflicts: observation.conflicts || [],
      dataGaps: observation.data_gaps || observation.dataGaps || [],
      calibration: observation.calibration || window.calibration || { mode: 'none' }
    } : null;
  }).filter(Boolean);
  if (!windows.length) {
    const error = new Error('尚无真实视觉观测结果，不能生成 ObservationBundle');
    error.status = 409;
    error.code = 'OBSERVATION_DATA_MISSING';
    throw error;
  }
  const calibrations = windows.map((window) => window.calibration).filter((calibration) => calibration?.mode === 'homography' && Number(calibration.rmse_m) <= 0.5);
  const calibration = calibrations.length ? calibrations.sort((a, b) => Number(a.rmse_m) - Number(b.rmse_m))[0] : { mode: 'none' };
  const bundle = buildObservationBundle({
    projectId: store.project.id,
    sceneVersion,
    slotId,
    windows,
    sceneObjects: sceneObjectsForReasoning(recordsForProject(store.sceneObjects).filter((object) => object.properties?.stale !== true)),
    calibration,
    allowedActions: undefined,
    transportPlan: store.project.transportAccess?.lastSimulation
      ? {
        planId: store.project.transportAccess.planId || 'transport-access-phase2-v1',
        scope: buildTransportPlan(store.project).scope,
        stations: buildTransportPlan(store.project).stations,
        roads: buildTransportPlan(store.project).roads.map((road) => ({
          ...road,
          id: road.sceneObjectId || road.id,
          routeId: road.id
        })),
        simulation: store.project.transportAccess.lastSimulation,
        evidenceLevel: 'Scenario'
      }
      : null
  });
  if (!bundle.metrics.length && !bundle.conflicts.length) {
    const error = new Error('所选时间段没有可用的真实指标或冲突证据');
    error.status = 409;
    error.code = 'OBSERVATION_DATA_MISSING';
    throw error;
  }
  return bundle;
}

app.get('/api/observations/bundle', (req, res) => {
  try {
    const slotId = String(req.query.slotId || '').trim() || null;
    const bundle = canonicalObservationBundle({ slotId, sceneVersion: String(req.query.sceneVersion || 'unversioned') });
    res.json({ ok: true, bundle });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'OBSERVATION_BUNDLE_FAILED', err.message));
  }
});

app.post('/api/scenarios/24h', async (req, res) => {
  try {
    assertProject();
    const body = req.body || {};
    if (!body.date) return res.status(400).json(errorBody('SCENARIO_DATE_REQUIRED', '24小时情景需要日期'));
    const persistedWindows = recordsForProject(store.videoWindows).map((window) => {
      const observation = [...store.observations].reverse().find((item) => item.schema === 'observation_bundle.v1' && item.projectId === store.project.id && item.sourceWindowId === window.id);
      return observation ? { ...window, sourceNature: window.sourceNature || observation.sourceNature || inferredSourceNature(store.assets.find((asset) => asset.id === window.assetId)), metrics: observation.metrics || [] } : null;
    }).filter(Boolean);
    const fieldWindows = persistedWindows.filter((window) => window.sourceNature !== 'virtual_test');
    const scenarioWindows = fieldWindows.length ? fieldWindows : persistedWindows;
    const requestedMetric = String(body.metricKind || 'unique_track_flow_rate');
    const anchors = buildScenarioAnchors(scenarioWindows, { metricKind: requestedMetric, actor: body.actor || null, targetId: body.targetId || null });
    if (!anchors.length) return res.status(400).json(errorBody('SCENARIO_ANCHORS_REQUIRED', '没有已持久化的真实观测锚点，不能生成全天情景曲线'));
    const curve = buildHourlyScenario({
      date: body.date, latitude: Number(body.latitude ?? store.project.latitude), longitude: Number(body.longitude ?? store.project.longitude),
      anchors, operationMultipliers: body.operationMultipliers || {}, weather: body.weather || { source: 'not_provided' }
    });
    const scenario = { id: id('scenario'), projectId: store.project.id, date: body.date, curve, anchors, metricKind: requestedMetric, evidenceLevel: 'Scenario', createdAt: new Date().toISOString() };
    store.observations.push({ id: id('observation'), type: 'scenario_24h', projectId: store.project.id, data: scenario, evidenceLevel: 'Scenario', createdAt: scenario.createdAt });
    // The project store is a large evidence JSON. Do not hold the browser's
    // loading state open while serializing it; the scenario is already in
    // memory and the queued write will finish in the background.
    void persist().catch((persistError) => console.error('24h scenario persistence failed:', persistError));
    res.json({ ok: true, scenario });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SCENARIO_FAILED', err.message));
  }
});

app.get('/api/weather/archive', async (req, res) => {
  const date = String(req.query.date || '');
  const latitude = Number(req.query.latitude ?? store.project?.latitude);
  const longitude = Number(req.query.longitude ?? store.project?.longitude);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json(errorBody('WEATHER_QUERY_INVALID', '历史天气需要有效日期和经纬度'));
  }
  try {
    const query = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), start_date: date, end_date: date,
      hourly: 'temperature_2m,relative_humidity_2m,precipitation,rain,snowfall,cloud_cover,wind_speed_10m,visibility',
      timezone: 'Asia/Shanghai'
    });
    const response = await fetch(`https://archive-api.open-meteo.com/v1/archive?${query}`, { signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.hourly) return res.status(502).json(errorBody('WEATHER_PROVIDER_FAILED', `Open-Meteo Archive 返回 HTTP ${response.status}`));
    res.json({ ok: true, weather: { source: 'Open-Meteo Archive', fetchedAt: new Date().toISOString(), latitude: body.latitude, longitude: body.longitude, timezone: body.timezone, hourly_units: body.hourly_units, hourly: body.hourly, evidenceLevel: 'Observed' } });
  } catch (err) {
    res.status(502).json(errorBody('WEATHER_PROVIDER_FAILED', `历史天气获取失败：${err.message}`));
  }
});

app.get('/api/jobs/:jobId/events', (req, res) => {
  const jobId = req.params.jobId;
  const visibleJob = store.jobs.find((job) => job.id === jobId && job.projectId === store.activeProjectId);
  const after = Number(req.query.after || req.headers['last-event-id'] || 0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  sendSse(res, { sequence: after, type: 'ready', jobId, at: new Date().toISOString(), payload: { exists: Boolean(visibleJob) } });
  if (visibleJob) for (const event of store.jobEvents.filter((item) => item.jobId === jobId && item.sequence > after)) sendSse(res, event);
  const listeners = eventListeners.get(jobId) || new Set();
  listeners.add(res);
  eventListeners.set(jobId, listeners);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    listeners.delete(res);
    if (listeners.size === 0) eventListeners.delete(jobId);
  });
});

app.post('/api/simulations', async (req, res) => {
  try {
    assertProject();
    const context = req.body || {};
    const proposal = store.proposals.find((item) => item.id === context.proposalId && item.projectId === store.project.id);
    if (!proposal) return res.status(404).json(errorBody('PROPOSAL_NOT_FOUND', '方案不存在'));
    if (proposal.status === 'Expert Approved') return res.status(409).json(errorBody('APPROVED_PROPOSAL_IMMUTABLE', '已批准方案不能重新写入仿真结果'));
    const planId = String(context.planId || '').trim();
    const plan = (proposal.draft?.plans || []).find((item) => item.id === planId);
    if (!plan) return res.status(400).json(errorBody('PLAN_NOT_FOUND', '请选择该 AI Draft 中存在的方案'));
    const metrics = proposal.sourceContext?.metrics;
    if (!Array.isArray(metrics) || !metrics.length) return res.status(400).json(errorBody('METRICS_REQUIRED', '该方案没有服务端持久化的真实聚合指标'));
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const kpis = computeScenario(metrics, actions);
    const simulation = { id: id('sim'), proposalId: proposal.id, planId, createdAt: new Date().toISOString(), actions, kpis, status: 'completed', evidenceLevel: 'Scenario' };
    const existing = proposal.simulationValidation && typeof proposal.simulationValidation === 'object' ? proposal.simulationValidation : {};
    const runs = Array.isArray(existing.runs) ? existing.runs.filter((run) => run.planId !== planId) : [];
    runs.push({ planId, simulationId: simulation.id, kpis, status: 'completed', evidenceLevel: 'Scenario', method: 'scenario_engine.v1', validatedAt: simulation.createdAt });
    const expectedPlanIds = new Set((proposal.draft?.plans || []).map((item) => item.id).filter(Boolean));
    const complete = expectedPlanIds.size === 3 && [...expectedPlanIds].every((itemId) => runs.some((run) => run.planId === itemId));
    const missingPlanIds = [...expectedPlanIds].filter((itemId) => !runs.some((run) => run.planId === itemId));
    const unchangedPlanIds = runs.filter((run) => expectedPlanIds.has(run.planId) && !hasDeterministicKpiChange(run.kpis)).map((run) => run.planId);
    const geometryPassed = existing.geometry?.status === 'passed';
    const violations = [
      ...(geometryPassed ? [] : (existing.geometry?.violations?.length ? existing.geometry.violations : ['方案几何检查尚未通过'])),
      ...(missingPlanIds.length ? [`仍缺少 ${missingPlanIds.join(', ')}`] : []),
      ...unchangedPlanIds.map((itemId) => `${itemId} 没有产生可验证的确定性 KPI 变化`)
    ];
    proposal.simulationValidation = { ...existing, status: complete && geometryPassed && unchangedPlanIds.length === 0 ? 'passed' : 'blocked', runs, lastSimulationId: simulation.id, validatedAt: simulation.createdAt, method: 'scenario_engine.v1', violations };
    proposal.status = 'AI Draft';
    store.observations.push({ id: id('observation'), projectId: store.project.id, type: 'simulation', simulationId: simulation.id, data: simulation, createdAt: simulation.createdAt });
    await persist();
    res.json({ ok: true, simulation });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'SIMULATION_FAILED', err.message));
  }
});

async function llmRequest(endpoint, payload) {
  return llmClient.request(endpoint, { payload });
}

function extractText(body) {
  if (typeof body?.output_text === 'string') return body.output_text;
  if (Array.isArray(body?.output)) {
    const texts = body.output.flatMap((item) => item.content || []).map((item) => item.text).filter(Boolean);
    if (texts.length) return texts.join('\n');
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item.text || '').join('\n');
  return '';
}

function parseJsonText(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try { return JSON.parse(candidate); } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('LLM 返回内容不是合法 JSON');
  }
}

function endpointUnsupported(error) {
  return [404, 405].includes(Number(error?.details?.providerStatus));
}

app.get('/api/llm/validate', async (_req, res) => {
  try {
    if (!llmApiKey) return res.status(503).json({
      ok: false,
      error: { code: 'LLM_KEY_MISSING', message: '服务端未配置 LLM_API_KEY' },
      llm: { primaryBaseUrl: llmBaseUrl, directBaseUrl: llmDirectBaseUrl, model: llmModel }
    });
    const validation = await llmClient.validateModel();
    res.json({
      ok: validation.exactModelFound,
      llm: {
        primaryBaseUrl: llmBaseUrl,
        directBaseUrl: llmDirectBaseUrl,
        activeBaseUrl: validation.meta.activeBaseUrl,
        node: validation.meta.node,
        fallbackUsed: validation.meta.fallbackUsed,
        model: llmModel,
        exactModelFound: validation.exactModelFound
      },
      models: validation.models,
      warning: validation.exactModelFound ? null : `未在模型目录中找到 ${llmModel}，不会静默替换模型`
    });
  } catch (err) {
    res.status(err.status || 502).json({
      ok: false,
      error: { code: err.code || 'LLM_VALIDATE_FAILED', message: err.message, details: err.details || {} },
      llm: {
        primaryBaseUrl: llmBaseUrl,
        directBaseUrl: llmDirectBaseUrl,
        activeBaseUrl: err.details?.activeBaseUrl || llmBaseUrl,
        node: err.details?.node || 'primary',
        fallbackUsed: err.details?.node === 'direct',
        model: llmModel
      }
    });
  }
});

app.post('/api/llm/propose', async (req, res) => {
  try {
    assertProject();
    const requestedContext = req.body?.context;
    const slotId = String(req.body?.slotId || requestedContext?.time_slot || '').trim() || null;
    const context = canonicalObservationBundle({
      slotId,
      sceneVersion: String(req.body?.sceneVersion || requestedContext?.scene_version || 'unversioned')
    });
    if (!Array.isArray(context.conflicts) || !context.conflicts.length) return res.status(400).json(errorBody('CONFLICTS_REQUIRED', '需要真实冲突证据才能请求方案'));
    const modelValidation = await llmClient.validateModel();
    if (!modelValidation.exactModelFound) {
      const error = new Error(`未在模型目录中找到精确模型 ${llmModel}，不会静默替换模型`);
      error.code = 'LLM_MODEL_NOT_FOUND';
      error.status = 503;
      error.details = {
        configuredModel: llmModel,
        activeBaseUrl: modelValidation.meta.activeBaseUrl,
        node: modelValidation.meta.node,
        availableModels: modelValidation.models
      };
      throw error;
    }
    const system = [
      '你是既有建筑空间更新的方案编排器。',
      '只使用输入中的事实与ID；未知信息必须写入 data_gaps。',
      '只能从 allowed_actions 选择动作；不要输出任何改善百分比、评分或虚构坐标。',
      '必须返回三套且每套至少一个动作：P-SAFE/安全优先、P-EFFICIENCY/效率优先、P-BALANCED/综合平衡。',
      'diagnoses、plans 和 actions 的 evidence_refs 只能逐字引用输入中已有的冲突 ID、指标 ID 或 evidence_refs；不得把对象 ID、区域 ID 或自然语言当成证据 ID。',
      'separate_time_window 的 blocked_actor 必须是其 evidence_refs 所引用冲突中的实际 actors；不得用未出现的公交、货车或人员类型替代。',
      'reroute_flow 的 target_ids 只能指向 geometry.type 为 LineString 或 MultiLineString 的对象；没有适配对象时必须改选其他白名单动作。',
      '必须返回严格 JSON，schema 固定为 proposal_draft.v1。',
      '人员角色不是视觉身份识别结果，只能引用人工运营规则。'
    ].join('\n');
    const prompt = JSON.stringify(context);
    const llmRequests = [{ ...modelValidation.meta, purpose: 'model_validation' }];
    const invokeLlm = async (endpoint, payload) => {
      const result = await llmRequest(endpoint, payload);
      llmRequests.push(result.meta);
      return result.body;
    };
    let body;
    try {
      body = await invokeLlm('/responses', {
        model: llmModel,
        input: [{ role: 'system', content: [{ type: 'input_text', text: system }] }, { role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        text: { format: { type: 'json_schema', name: 'proposal_draft_v1', strict: true, schema: proposalOutputSchema } }
      });
    } catch (firstError) {
      if (endpointUnsupported(firstError)) {
        body = await invokeLlm('/chat/completions', {
          model: llmModel,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'proposal_draft_v1', strict: true, schema: proposalOutputSchema } }
        });
      } else throw firstError;
    }
    const rawDraft = parseJsonText(extractText(body));
    let draft;
    let repaired = false;
    const validateCandidate = (candidate) => {
      const validated = validateProposalDraft(candidate, context);
      const candidateGeometry = validateProposalGeometry(validated, context.scene_objects || []);
      if (candidateGeometry.status !== 'passed') throw new Error(`方案几何检查未通过：${candidateGeometry.violations.join('；')}`);
      return validated;
    };
    try {
      draft = validateCandidate(rawDraft);
    } catch (validationError) {
      const allowedEvidenceIds = [...new Set([
        ...(context.conflicts || []).map((item) => item.id),
        ...(context.metrics || []).map((item) => item.id),
        ...(context.conflicts || []).flatMap((item) => item.evidence_refs || item.evidenceRefs || []),
        ...(context.metrics || []).flatMap((item) => item.sourceTrackIds || item.source_track_ids || item.sourceWindowIds || item.source_window_ids || [])
      ].filter(Boolean))];
      const repairSystem = [
        '你是严格 JSON 修复器，只能修复给定 proposal_draft.v1 的结构与引用。',
        '不得添加新事实、对象、冲突、指标、坐标、改善百分比或评分。',
        'evidence_refs 中的每个值必须从 allowed_evidence_ids 原样复制，不得生成新 ID。',
        'separate_time_window 的 blocked_actor 必须改为其 evidence_refs 所引用冲突中的实际 actors，或改用其他适配动作。',
        '必须修复 validation_error 中的几何动作问题；reroute_flow 只能指向 LineString 或 MultiLineString 对象，也可以改为其他适配的 allowed_actions。',
        '只返回修复后的 JSON，必须保留三套方案并从 allowed_actions 中选择。'
      ].join('\n');
      const repairInput = JSON.stringify({ validation_error: validationError.message, allowed_evidence_ids: allowedEvidenceIds, context, invalid_draft: rawDraft });
      let repairBody;
      try {
        repairBody = await invokeLlm('/responses', {
          model: llmModel,
          input: [{ role: 'system', content: [{ type: 'input_text', text: repairSystem }] }, { role: 'user', content: [{ type: 'input_text', text: repairInput }] }],
          text: { format: { type: 'json_schema', name: 'proposal_draft_v1', strict: true, schema: proposalOutputSchema } }
        });
      } catch (repairEndpointError) {
        if (endpointUnsupported(repairEndpointError)) repairBody = await invokeLlm('/chat/completions', {
          model: llmModel,
          messages: [{ role: 'system', content: repairSystem }, { role: 'user', content: repairInput }],
          response_format: { type: 'json_schema', json_schema: { name: 'proposal_draft_v1', strict: true, schema: proposalOutputSchema } }
        });
        else throw repairEndpointError;
      }
      draft = validateCandidate(parseJsonText(extractText(repairBody)));
      repaired = true;
    }
    const inputHash = crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex');
    const outputHash = crypto.createHash('sha256').update(JSON.stringify(draft)).digest('hex');
    const geometryValidation = validateProposalGeometry(draft, context.scene_objects || []);
    const simulationRuns = (context.metrics || []).length ? draft.plans.map((plan) => ({
      planId: plan.id, status: 'completed', evidenceLevel: 'Scenario', method: 'scenario_engine.v1',
      kpis: computeScenario(context.metrics, plan.actions)
    })) : [];
    const unchangedPlanIds = simulationRuns.filter((run) => !hasDeterministicKpiChange(run.kpis)).map((run) => run.planId);
    const simulationViolations = [
      ...(simulationRuns.length === 3 ? [] : ['缺少可复算的聚合指标']),
      ...unchangedPlanIds.map((planId) => `${planId} 没有产生可验证的确定性 KPI 变化`)
    ];
    const simulationValidation = {
      status: geometryValidation.status === 'passed' && simulationViolations.length === 0 ? 'passed' : 'blocked',
      geometry: geometryValidation, runs: simulationRuns,
      violations: [...geometryValidation.violations, ...simulationViolations],
      validatedAt: new Date().toISOString()
    };
    const proposal = {
      id: id('proposal'), projectId: store.project.id, status: 'AI Draft', createdAt: new Date().toISOString(),
      sourceContext: context, draft, model: llmModel, simulationValidation,
      sourceNature: context.source_nature || 'field_observation', testOnly: Boolean(context.test_only),
      audit: {
        endpoint: llmRequests.at(-1)?.activeBaseUrl || llmBaseUrl,
        primaryEndpoint: llmBaseUrl,
        directEndpoint: llmDirectBaseUrl,
        modelId: llmModel,
        promptVersion: 'proposal_orchestrator.v2',
        schemaVersion: 'proposal_draft.v1',
        inputHash,
        outputHash,
        repairedOnce: repaired,
        requests: llmRequests
      }
    };
    store.proposals.push(proposal);
    await persist();
    res.json({ ok: true, proposal });
  } catch (err) {
    res.status(err.status || 422).json(errorBody(err.code || 'LLM_PROPOSAL_FAILED', err.message, err.details || {}));
  }
});

app.post('/api/proposals/:proposalId/approve', async (req, res) => {
  const proposal = store.proposals.find((item) => item.id === req.params.proposalId && item.projectId === store.activeProjectId);
  if (!proposal) return res.status(404).json(errorBody('PROPOSAL_NOT_FOUND', '方案不存在'));
  if (proposal.status === 'Expert Approved') return res.status(409).json(errorBody('PROPOSAL_ALREADY_APPROVED', '该方案已完成专家批准，审核记录不可覆盖'));
  const reviewer = String(req.body?.reviewer || '').trim();
  const note = String(req.body?.note || '').trim();
  if (!reviewer) return res.status(400).json(errorBody('REVIEWER_REQUIRED', '专家批准必须记录审核人'));
  if (reviewer.length > 80) return res.status(400).json(errorBody('REVIEWER_INVALID', '审核人名称不能超过 80 个字符'));
  if (!note) return res.status(400).json(errorBody('REVIEW_NOTE_REQUIRED', '专家批准必须填写审核意见'));
  if (note.length > 1000) return res.status(400).json(errorBody('REVIEW_NOTE_INVALID', '审核意见不能超过 1000 个字符'));
  try {
    const currentSceneObjects = recordsForProject(store.sceneObjects).filter((object) => object.properties?.stale !== true);
    const validationContext = { ...(proposal.sourceContext || {}), scene_objects: currentSceneObjects };
    validateProposalDraft(proposal.draft, validationContext);
    const geometryValidation = validateProposalGeometry(proposal.draft, currentSceneObjects);
    const metrics = validationContext.metrics || [];
    const runs = metrics.length ? proposal.draft.plans.map((plan) => ({
      planId: plan.id,
      status: 'completed',
      evidenceLevel: 'Scenario',
      method: 'scenario_engine.v1',
      kpis: computeScenario(metrics, plan.actions)
    })) : [];
    const unchangedPlanIds = runs.filter((run) => !hasDeterministicKpiChange(run.kpis)).map((run) => run.planId);
    const violations = [
      ...geometryValidation.violations,
      ...(runs.length === 3 ? [] : ['缺少可复算的聚合指标']),
      ...unchangedPlanIds.map((planId) => `${planId} 没有产生可验证的确定性 KPI 变化`)
    ];
    proposal.simulationValidation = {
      status: geometryValidation.status === 'passed' && runs.length === 3 && unchangedPlanIds.length === 0 ? 'passed' : 'blocked',
      geometry: geometryValidation,
      runs,
      violations,
      validatedAt: new Date().toISOString(),
      validationVersion: 'proposal_approval_gate.v1'
    };
    if (proposal.simulationValidation.status !== 'passed') return res.status(409).json(errorBody('SIMULATION_REQUIRED', `AI Draft 重新校验未通过：${violations.join('；')}`));
  } catch (error) {
    return res.status(409).json(errorBody('PROPOSAL_REVALIDATION_FAILED', `AI Draft 不符合当前方案规则：${error.message}`));
  }
  proposal.status = 'Expert Approved';
  proposal.review = { reviewer, note, approvedAt: new Date().toISOString(), testOnly: Boolean(proposal.testOnly) };
  store.reviews.push({ id: id('review'), projectId: store.activeProjectId, targetId: proposal.id, targetType: 'proposal', ...proposal.review });
  await persist();
  res.json({ ok: true, proposal });
});

app.get('/api/proposals', (_req, res) => res.json({ ok: true, proposals: recordsForProject(store.proposals) }));
app.get('/api/artifacts', (req, res) => {
  const includeHistory = req.query.includeHistory === 'true';
  res.json({ ok: true, artifacts: workspaceArtifacts(includeHistory).map(publicArtifact) });
});

app.post('/api/exports', async (req, res) => {
  let exportLockKey = null;
  let exportLockAcquired = false;
  try {
    assertProject();
    const proposal = store.proposals.find((item) => item.id === req.body?.proposalId && item.projectId === store.project.id);
    if (!proposal) return res.status(404).json(errorBody('PROPOSAL_NOT_FOUND', '方案不存在'));
    if (proposal.status !== 'Expert Approved') return res.status(409).json(errorBody('EXPERT_APPROVAL_REQUIRED', '只有 Expert Approved 方案才允许导出')); 
    if (proposal.simulationValidation?.status !== 'passed') return res.status(409).json(errorBody('SIMULATION_REQUIRED', '方案没有通过确定性复算'));
    const supportedFormats = new Set(['json', 'csv', 'xlsx', 'pdf', 'poster_pdf', 'poster_png', 'offline_webgl', 'demo_mp4']);
    const requestedFormats = Array.isArray(req.body?.formats) ? req.body.formats.map((format) => String(format)) : [];
    const unsupportedFormats = requestedFormats.filter((format) => !supportedFormats.has(format));
    if (unsupportedFormats.length) return res.status(400).json(errorBody('EXPORT_FORMAT_UNSUPPORTED', `不支持的导出格式: ${unsupportedFormats.join(', ')}`));
    const formats = [...new Set(requestedFormats)];
    if (!formats.length) return res.status(400).json(errorBody('EXPORT_FORMAT_REQUIRED', '请选择 json、csv、xlsx、pdf、poster_pdf、poster_png、offline_webgl 或 demo_mp4'));
    exportLockKey = `${store.project.id}:${proposal.id}`;
    if (!exportLocks.acquire(exportLockKey)) return res.status(409).json(errorBody('EXPORT_IN_PROGRESS', '该方案正在生成成果包，请等待当前导出完成'));
    exportLockAcquired = true;
    const exportRunId = id('export');
    const sourcePath = path.join(artifactDir, `export-source-${proposal.id}-${exportRunId}.json`);
    const source = {
      schema: 'approved_export_bundle.v1', project: store.project, proposal, observations: store.observations.filter((item) => item.projectId === store.project.id),
      sceneObjects: recordsForProject(store.sceneObjects).filter((object) => object.properties?.stale !== true), artifacts: store.artifacts.filter((item) => item.projectId === store.project.id), model: proposal.model, exportedAt: new Date().toISOString()
    };
    await fsp.writeFile(sourcePath, JSON.stringify(source, null, 2), 'utf8');
    const outputDir = path.join(artifactDir, `export-${proposal.id}-${exportRunId}`);
    const result = await runProcess(pythonCommand(), [path.join(rootDir, 'workers', 'export_worker.py'), '--source', sourcePath, '--output-dir', outputDir, ...formats.flatMap((format) => ['--format', format])]);
    const payload = lastJsonLine(result.stdout) || lastJsonLine(result.stderr);
    if (result.code !== 0 || !payload?.ok) throw new Error(payload?.error || result.stderr.trim() || '导出 Worker 失败');
    const priorArtifacts = store.artifacts.filter((item) => item.projectId === store.project.id && item.metadata?.proposalId === proposal.id && (payload.result.files || []).some((file) => file.kind === item.kind));
    const artifacts = [];
    for (const file of payload.result.files || []) artifacts.push(await addArtifact({ projectId: store.project.id, jobId: null, kind: file.kind, title: file.kind, storedPath: file.path, evidenceLevel: 'Expert Approved', metadata: { proposalId: proposal.id, sourceHash: await sha256(sourcePath), format: file.kind } }));
    const newestByKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
    for (const prior of priorArtifacts) {
      const replacement = newestByKind.get(prior.kind);
      if (replacement && replacement.id !== prior.id) prior.metadata = { ...(prior.metadata || {}), supersededAt: new Date().toISOString(), supersededBy: replacement.id };
    }
    await persist();
    res.status(201).json({ ok: true, export: { ...payload.result, exportRunId, artifacts: artifacts.map(publicArtifact) } });
  } catch (err) {
    res.status(err.status || 500).json(errorBody(err.code || 'EXPORT_FAILED', err.message));
  } finally {
    if (exportLockAcquired) exportLocks.release(exportLockKey);
  }
});

// In production, serve the built frontend from the same process.
const distDir = path.join(rootDir, 'dist');
// Serve the standalone operator-review candidate over HTTP. Opening the
// copied HTML with file:// blocks module imports and GLB fetches in Chromium;
// this route keeps the page, candidate GLB, and viewer libraries same-origin.
const g3MainEntryCandidateDir = path.join(artifactDir, 'job_049e9022a808-g3-fb932-main-entry-v2');
app.use('/candidate/g3-main-entry-v2', express.static(g3MainEntryCandidateDir));
app.use('/candidate/g3-main-entry-v3', express.static(path.join(artifactDir, 'job_049e9022a808-g3-fb932-main-entry-v3')));
app.use('/viewer-libs/three', express.static(path.join(rootDir, 'node_modules', 'three')));
app.use('/node_modules/three', express.static(path.join(rootDir, 'node_modules', 'three')));
app.use('/activity-videos', express.static(path.join(rootDir, 'public', 'activity-videos'), { acceptRanges: true }));
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => req.path.startsWith('/api') ? next() : res.sendFile(path.join(distDir, 'index.html')));
}

app.use(async (err, req, res, _next) => {
  await Promise.all((req.files || []).map((file) => file?.path ? fsp.unlink(file.path).catch(() => {}) : null));
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json(errorBody('FILE_TOO_LARGE', '单个文件不能超过2GB'));
  const status = Number(err?.status) || (String(err?.code || '').startsWith('LIMIT_') ? 400 : 500);
  res.status(status).json(errorBody(err?.code || 'SERVER_ERROR', status >= 500 ? '服务器内部错误' : err.message));
});

app.listen(port, host, () => {
  console.log(`Spatial Reframe API listening on http://${host}:${port}`);
  console.log(`LLM gateway configured: ${Boolean(llmApiKey)} (${llmBaseUrl}, model=${llmModel})`);
});

// Hosted project data is loaded from chunked JSON files under data/.
