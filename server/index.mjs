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
    .filter((name) => /^store-slim\.part\d+\.json$/.test(name))
    .sort();
  if (!names.length) return null;
  const raw = (await Promise.all(names.map((name) => fsp.readFile(path.join(dataDir, name), 'utf8')))).join('');
  return JSON.parse(raw);
}

async function readStore() {
  try {
    const hosted = await readHostedStoreParts();
    if (hosted) return { ...emptyStore, ...hosted };
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

function commandAvailableAsync(command) {  return result.status === 0;
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
  const hostedUrl = typeof safe.url === 'string' && safe.url.startsWith('/') && !safe.url.startsWith('/api/') ? safe.url : null;
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
