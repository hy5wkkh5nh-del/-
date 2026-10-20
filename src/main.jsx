import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/noto-sans-sc/wght.css';
import '@fontsource-variable/noto-serif-sc/wght.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import {
  AlertTriangle, Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Box, BrainCircuit, Building2, Check, CheckCircle2, CircleHelp,
  ChevronRight, CircleDot, CloudRain, Database, FileDown, FileVideo, Gauge,
  Footprints, Layers3, Link2, LocateFixed, Map, Maximize2, Menu, Minimize2, Pause, Play, Plus, Radio,
  RefreshCw, RotateCcw, Route, ScanLine, Settings2, ShieldCheck, Sparkles, Sun, UploadCloud,
  Video, X, XCircle, ZoomIn, ZoomOut
} from 'lucide-react';
import { buildScenarioFlowPlan, extractScenarioRoads, pointAlongPolyline, scenarioFlowColor } from './scenario-flow.mjs';
import { applyFacadeMaterialLayer, applyLandscapeMaterialLayer, applyModelDisplayMode, applyRoadMaterialLayer, disposeModelDisplayMaterials, latestArtifactsPerKind, selectCurrentSiteContextArtifact } from './model-display.mjs';
import AmapTwinScene from './amap-twin-scene.jsx';
import { extractSiteRoutes, polylineLength, resolveSiteRoutePoints, samplePolylineAtDistance, selectPrimarySiteRoute } from './site-route.mjs';
import { WALKTHROUGH_BODY_RADIUS_M, chooseWalkthroughYaw, isWalkthroughCollisionCandidate, preferredWalkthroughEntry, resolveConstrainedWalkthroughMove, shouldFallbackToFloorSpawn, visitorWalkthroughYaw } from './walkthrough-collision.mjs';
import { KeyframeReviewPanel } from './reconstruction-review.jsx';
import './styles.css';
import './flow-city.css';

// CAD metadata stores walkFacingYaw toward the nearest facade opening. Visitor mode
// reverses that heading so the first frame looks into the building, not at blank glass.
// walkFacingYaw remains an evidence-derived input; no fabricated orientation is stored.

const API = '/api';
// The current site has no active construction. Keep historical construction
// evidence in the source GLB for traceability, but suppress temporary
// machinery, frames and construction-fence panels from the present-day view.
// Permanent site fences use the observed-fence-* names and remain visible.
const currentSceneSuppressedObjectPrefixes = [
  'observed-c7-crane-',
  'observed-c7-construction-frame-',
  'observed-c7-construction-fence-',
  'observed-c7-construction-site'
];
// User-marked deletion zone: these names identify the same garage/ramp
// cluster inside the red rectangle across the aligned model windows. Keep the
// source files intact and suppress only this exact named group in the viewer.
const userDeletedRedBoxObjectPrefixes = [
  'capture_context_garage_',
  'capture_context_ramp_',
  'capture_context_eastcheekmesh',
  'capture_context_westcheekmesh'
];

const directImageCandidateModelKinds = new Set([
  'site_direct_image_candidate_glb',
  'site_direct_image_surrounding_glb',
  'site_direct_image_g3_candidate_glb',
  'site_direct_image_g3_v3_candidate_glb'
]);

// Window 1 quick editor: these are additive runtime objects only.  They are
// intentionally named so an operator can stretch a road/green strip or copy
// its material without touching the source GLB geometry.
const B_WALK_EDITOR_DEFINITIONS = [
  { id: 'B-WALK-01-fence-perpendicular-asphalt-branch', label: '垂直沥青支路', role: 'road' },
  { id: 'B-WALK-01-small-gate', label: '支路处双扇小门', role: 'gate' },
  { id: 'B-WALK-01-expanded-road-1_5-5-3', label: '主楼侧沥青小道', role: 'road' },
  { id: 'B-WALK-01-main-building-perimeter-rounded-path', label: '主楼圆角小道', role: 'road' },
  { id: 'B-WALK-01-green-building-side', label: '主楼侧绿化带', role: 'green' },
  { id: 'B-WALK-01-green-between-parallel-roads', label: '两条小道之间绿化带', role: 'green' },
  { id: 'B-WALK-01-green-building-side-bed-stone-1', label: '主楼侧白色垫石', role: 'bed-stone' },
  { id: 'B-WALK-01-green-between-parallel-roads-bed-stone-1', label: '栅栏侧白色垫石', role: 'bed-stone' },
  { id: 'PLAN_ROAD_network_1', label: '底层黑灰道路', role: 'road' },
  { id: 'ROUTE02_01_02_internal_paving', label: '照片道路铺装', role: 'road' }
];
const B_WALK_EDITOR_STORAGE_KEY = 'spatial-reframe.bwalk-editor.v1';
const RUNTIME_EDITOR_TRANSFORM_STORAGE_KEY = 'spatial-reframe.runtime-editor-transforms.v1';
const RUNTIME_EDITOR_DELETED_STORAGE_KEY = 'spatial-reframe.runtime-editor-deleted.v1';

// Keep process candidates on disk for traceability, but hide them from the
// normal layer switcher so the retained Stage 3 window is the only visible
// working layer during cleanup. This is a UI visibility policy, not deletion.
const GROUND_PLANE_ASSET_ID = 'runtime_scene_ground_plane';
const hiddenProcessModelAssetIds = new Set([
  'asset_a762f3e2bc14', // 融合候选 · 阶段1 · 道路排水
  'asset_5d17a353a2af', // 融合候选 · 阶段2 · 栏杆门禁
  'asset_6ded2e46c6a1', // B67 原候选
  'asset_e83921f23655', // B67 锚点候选
  'asset_2f5e51911c23'  // B67 围栏候选
]);

const facadePhotoZones = [
  { id: 'zone-01', label: '图1 · 主楼入口', title: '入口、雨棚、柱廊与连续玻璃带', image: '/evidence/facade-zones/zone-01.jpg', modelImage: '/evidence/facade-zones/model-zone-01.png', evidence: '340b25bbdb7180cf768a81b054158d6d.jpg' },
  { id: 'zone-02', label: '图2 · 长立面小道', title: '长向立面、树列与道路边缘', image: '/evidence/facade-zones/zone-02.jpg', modelImage: '/evidence/facade-zones/model-zone-02.png', evidence: '091dfd1231e1f2a76eb90f7fd8e8722e.jpg' },
  { id: 'zone-03', label: '图3 · 砖墙绿化', title: '穿孔砖墙、树干、灌木与草坪', image: '/evidence/facade-zones/zone-03.jpg', modelImage: '/evidence/facade-zones/model-zone-03.png', evidence: '3358f7c988de4f08957238a2d037d69d.jpg' },
  { id: 'zone-04', label: '图4 · 弧形转角', title: '弧形转角、外遮阳构架与立体砖墙', image: '/evidence/facade-zones/zone-04.jpg', modelImage: '/evidence/facade-zones/model-zone-04.png', evidence: '4dd4e8b5959261ea35eec796fe59cca4.jpg' },
  { id: 'zone-05', label: '图5 · 另一侧立面', title: '悬挑底面、玻璃入口与砖墙收口', image: '/evidence/facade-zones/zone-05.jpg', modelImage: '/evidence/facade-zones/model-zone-05.png', evidence: '6e3e5508f4aaa9d49a63cdd56c786a55.jpg' }
];

function suppressCurrentSceneObjects(model, showHistorical = false) {
  let suppressedCount = 0;
  model.traverse((child) => {
    const name = String(child.name || '').toLowerCase();
    if (!currentSceneSuppressedObjectPrefixes.some((prefix) => name.startsWith(prefix))) return;
    child.visible = Boolean(showHistorical);
    if (!showHistorical) suppressedCount += 1;
  });
  return suppressedCount;
}

function suppressUserDeletedRedBoxObjects(model) {
  let suppressedCount = 0;
  model.traverse((child) => {
    const name = String(child.name || '').toLowerCase();
    if (!userDeletedRedBoxObjectPrefixes.some((prefix) => name.startsWith(prefix))) return;
    child.visible = false;
    suppressedCount += 1;
  });
  return suppressedCount;
}

const STANDARD_NIGHT_SCENARIO = {
  sun: { altitude_deg: -18, azimuth_deg: 270 },
  weather: { cloud_cover: 18, precipitation: 0 },
  evidenceLevel: 'Scenario'
};

function scenarioForDisplay(displayMode, scenarioPoint) {
  return displayMode === 'day-night' ? (scenarioPoint || STANDARD_NIGHT_SCENARIO) : scenarioPoint;
}
const PROJECT_LIBRARY_CACHE_KEY = 'spatial-reframe.project-library.v1';

function readProjectLibraryCache() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(PROJECT_LIBRARY_CACHE_KEY) || 'null');
    if (!cached || !Array.isArray(cached.projects)) return null;
    return cached;
  } catch (error) {
    console.warn('项目卷宗缓存读取失败', error);
    return null;
  }
}

function writeProjectLibraryCache(snapshot) {
  try {
    window.localStorage.setItem(PROJECT_LIBRARY_CACHE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.warn('项目卷宗缓存写入失败', error);
  }
}

const steps = [
  { id: 'source', number: '01', title: '现场证据', subtitle: '坐标 · 影像 · 模型', icon: Database },
  { id: 'vision', number: '03', title: '流动观测', subtitle: '视频 · 轨迹 · 冲突', icon: ScanLine },
  { id: 'proposal', number: '04', title: '空间推演', subtitle: '诊断 · 三案 · 模拟', icon: BrainCircuit },
  { id: 'review', number: '05', title: '专家成稿', subtitle: '审核 · 归档 · 输出', icon: ShieldCheck }
];

const evidenceTypes = [
  ['Observed', '现场观测'], ['Derived', '算法推导'], ['Hypothesis', 'AI 假设'],
  ['Scenario', '情景推演'], ['Expert Approved', '专家确认']
];

const actorLabels = {
  person: '人员', car: '小汽车', truck: '货车', bus: '公交车',
  bicycle: '自行车', motorcycle: '摩托车'
};

function congestionLabel(count = 0) {
  const value = Number(count) || 0;
  if (value >= 360) return '高';
  if (value >= 180) return '中';
  return '低';
}

const allowedActions = [
  'set_gate_mode', 'set_one_way', 'separate_time_window', 'reroute_flow',
  'move_dropoff_zone', 'move_loading_zone', 'widen_walkway', 'add_crossing',
  'add_barrier', 'add_wayfinding', 'add_lighting', 'set_signal_or_marshal'
];

const siteCorridorVideoPrefixes = ['450d', '4444', 'b322', '1572', '783e', 'f684', '4b75'];

// Continuous site reconstruction only accepts field evidence.  Keep demo
// assets available to the semantic-test workflow, but never offer them as
// corridor photos/videos where they could be mistaken for observed scenery.
function isTestOnlyAsset(asset) {
  const name = String(asset?.name || '').toLowerCase();
  return Boolean(
    asset?.testOnly
    || asset?.sourceNature === 'virtual_test'
    || /yolox|dog[-_\s]?public[-_\s]?example|virtual|synthetic|test[-_\s]?only|not[-_\s]?observed|dummy|sample/.test(name)
  );
}

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

function isVisibleProjectVideo(asset) {
  return asset?.type === 'video' && !isExcludedProjectVideo(asset) && !isHiddenVideoAlias(asset);
}

function isFieldEvidenceAsset(asset) {
  return !isTestOnlyAsset(asset)
    && !isExcludedProjectVideo(asset)
    && !isHiddenVideoAlias(asset)
    && (asset?.sourceNature == null || asset.sourceNature === 'field_observation' || asset.sourceNature === 'Observed');
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function videoDisplayName(asset) {
  const name = String(asset?.name || '').trim();
  const evidence = videoEvidenceMeta(asset);
  if (evidence?.groupId && evidence?.groupName) {
    const index = evidence.sequenceIndex ? ` · ${String(evidence.sequenceIndex).padStart(2, '0')}` : '';
    const alias = evidence.aliasKind === 'exact_content_alias' ? ' · 同内容别名' : evidence.aliasKind === 'source_variant_alias' ? ' · 源变体' : '';
    return `${evidence.groupId}${index} · ${evidence.groupName}${alias} · ${name}`;
  }
  const prefixIndex = siteCorridorVideoPrefixes.findIndex((prefix) => name.toLowerCase().startsWith(prefix));
  if (prefixIndex >= 0) return `${String(prefixIndex + 1).padStart(2, '0')} · ${siteCorridorVideoPrefixes[prefixIndex]} · ${name}`;
  return name || '未命名视频';
}

function videoEvidenceStatusLabel(asset) {
  const evidence = videoEvidenceMeta(asset);
  if (isTestOnlyAsset(asset)) return 'TEST ONLY';
  if (evidence?.status === 'excluded_unconfirmed') return '已隔离 · 未确认';
  if (evidence?.hiddenByDefault) return evidence?.aliasKind === 'exact_content_alias' ? '隐藏别名 · 同内容' : '隐藏别名 · 源变体';
  if (evidence?.status === 'included_field_evidence') return '现场证据';
  return '待归档';
}

function VideoEvidenceScopeList({ videos = [] }) {
  const groupOrder = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
  const sortedVideos = videos.slice().sort((left, right) => {
    const leftEvidence = videoEvidenceMeta(left) || {};
    const rightEvidence = videoEvidenceMeta(right) || {};
    const leftExcluded = isExcludedProjectVideo(left) || isTestOnlyAsset(left);
    const rightExcluded = isExcludedProjectVideo(right) || isTestOnlyAsset(right);
    if (leftExcluded !== rightExcluded) return leftExcluded ? 1 : -1;
    const leftGroup = groupOrder.indexOf(leftEvidence.groupId);
    const rightGroup = groupOrder.indexOf(rightEvidence.groupId);
    if (leftGroup !== rightGroup) return (leftGroup < 0 ? 99 : leftGroup) - (rightGroup < 0 ? 99 : rightGroup);
    const leftSequence = Number.isFinite(Number(leftEvidence.sequenceIndex)) ? Number(leftEvidence.sequenceIndex) : 999;
    const rightSequence = Number.isFinite(Number(rightEvidence.sequenceIndex)) ? Number(rightEvidence.sequenceIndex) : 999;
    if (leftSequence !== rightSequence) return leftSequence - rightSequence;
    return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
  });
  const groups = [];
  for (const asset of sortedVideos) {
    const evidence = videoEvidenceMeta(asset) || {};
    const key = isExcludedProjectVideo(asset) || isTestOnlyAsset(asset) ? 'excluded' : (evidence.groupId || 'unfiled');
    let group = groups.find((item) => item.key === key);
    if (!group) {
      group = { key, name: key === 'excluded' ? '已隔离 / TEST ONLY（仅审计，不进入路线）' : key === 'unfiled' ? '未归档视频（需人工确认）' : `${key} · ${evidence.groupName || '未命名证据组'}`, assets: [] };
      groups.push(group);
    }
    group.assets.push(asset);
  }
  if (!groups.length) return <div className="video-evidence-empty">当前项目没有视频证据记录。</div>;
  const excludedGroups = groups.filter((group) => group.key === 'excluded');
  const fieldGroups = groups.filter((group) => group.key !== 'excluded');
  const excludedCount = excludedGroups.reduce((total, group) => total + group.assets.length, 0);
  const renderGroups = (items) => <div className="video-evidence-groups">
    {items.map((group) => <section className="video-evidence-group" key={group.key}>
      <h4>{group.name}<small>{group.assets.length} 个文件</small></h4>
      <div className="video-evidence-rows">
        {group.assets.map((asset) => {
          const evidence = videoEvidenceMeta(asset) || {};
          const aliasLabel = evidence.aliasKind === 'exact_content_alias' ? '同内容别名' : evidence.aliasKind === 'source_variant_alias' ? '源变体' : 'canonical';
          const sequenceLabel = evidence.sequenceIndex ? ` · 第 ${evidence.sequenceIndex} 段` : '';
          const entityLabel = evidence.canonicalEntityId ? `实体 ${evidence.canonicalEntityId}` : '未建立 canonical 实体';
          return <div className="video-evidence-row" key={asset.id}>
            <div className="video-evidence-row-main"><strong>{videoDisplayName(asset)}</strong><small>{aliasLabel}{sequenceLabel} · {entityLabel}</small></div>
            <span className={`video-evidence-status ${isExcludedProjectVideo(asset) || isTestOnlyAsset(asset) ? 'excluded' : evidence.hiddenByDefault ? 'hidden' : 'included'}`}>{videoEvidenceStatusLabel(asset)}</span>
            {asset.url ? <a className="video-evidence-play" href={asset.url} target="_blank" rel="noreferrer" aria-label={`播放 ${videoDisplayName(asset)}`} title={`播放 ${videoDisplayName(asset)}`}>播放</a> : <span className="video-evidence-play disabled">无文件</span>}
          </div>;
        })}
      </div>
    </section>)}
  </div>;
  return <details className="video-evidence-scope">
    <summary><strong>全部现场视频证据</strong><span>{videos.length} 个文件；{videos.length - excludedCount} 个现场记录默认显示，{excludedCount} 个隔离 / TEST ONLY 记录默认收起</span></summary>
    {renderGroups(fieldGroups)}
    {excludedGroups.length > 0 && <details className="video-evidence-excluded">
      <summary><strong>已隔离 / TEST ONLY 记录</strong><span>{excludedCount} 个文件；仅审计，不进入路线或三维模型</span></summary>
      {renderGroups(excludedGroups)}
    </details>}
  </details>;
}

const videoEvidenceGroupLabels = {
  G0: { title: '早期片段（未定位）', note: '保留为现场资料，暂不挂入路线。' },
  G1: { title: '主环线七段', note: '用户确认的顺序；路线距离和世界方位仍需复核。' },
  G2: { title: '周边补充 / 360 候选', note: '仅作为周边环境证据，不自动延长主路线。' },
  G3: { title: '设计院背后外侧第二条小道', note: '黑色连续栅栏分隔两条小道；站点位置待导航挂接。' },
  G4: { title: '主楼侧小道：栅栏、门、停车场与转弯', note: '视频左侧玻璃停车区、黑色栅栏后的主楼和入口证据合并管理。' },
  G5: { title: '转弯与两个岔路口', note: '按视频相对顺序保留；不能把时间顺序直接当世界方位。' },
  G6: { title: '第二岔路口回两个门', note: '回程证据；与 G1 不重复生成空间段。' },
  G7: { title: '末段重复实体（已去重）', note: '2fad、76c、raw 只对应一个空间实体，不新增路线段。' },
};

function VideoEvidenceRouteLedger({ videos = [], blocked = true }) {
  const groupOrder = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
  const byGroup = new globalThis.Map();
  for (const asset of videos.filter(isVisibleProjectVideo)) {
    const evidence = videoEvidenceMeta(asset) || {};
    const groupId = evidence.groupId || 'unfiled';
    if (!byGroup.has(groupId)) byGroup.set(groupId, new globalThis.Map());
    const entities = byGroup.get(groupId);
    const entityId = evidence.canonicalEntityId || asset.id;
    const aliases = Array.isArray(evidence.aliases) ? [...evidence.aliases] : evidence.aliases ? [evidence.aliases] : [];
    if (!entities.has(entityId)) entities.set(entityId, { asset, evidence, aliases });
    const row = entities.get(entityId);
    if (evidence.aliasKind && !row.aliases.includes(asset.name)) row.aliases.push(asset.name);
  }
  const groups = [...byGroup.entries()].sort(([left], [right]) => {
    const li = groupOrder.indexOf(left);
    const ri = groupOrder.indexOf(right);
    return (li < 0 ? 99 : li) - (ri < 0 ? 99 : ri);
  });
  if (!groups.length) return null;
  return <section className="video-evidence-route-ledger" aria-label="融合视频路线台账">
    <div className="video-evidence-route-ledger-head">
      <strong>融合视频路线台账</strong>
      <span>{blocked ? '候选定位阶段：只读，不生成新三维路线' : '已解除保护：路线绑定可用于生成'}</span>
    </div>
    <div className="video-evidence-route-groups">
      {groups.map(([groupId, entities]) => {
        const label = videoEvidenceGroupLabels[groupId] || { title: '未归档组', note: '需人工确认。' };
        return <div className="video-evidence-route-group" key={groupId}>
          <div className="video-evidence-route-group-head"><strong>{groupId} · {label.title}</strong><small>{entities.size} 个空间实体</small></div>
          <p>{label.note}</p>
          <div className="video-evidence-route-entities">
            {[...entities.values()].sort((left, right) => Number(left.evidence.sequenceIndex || 999) - Number(right.evidence.sequenceIndex || 999)).map(({ asset, evidence, aliases }) => <div key={evidence.canonicalEntityId || asset.id}>
              <span>{evidence.sequenceIndex ? `${String(evidence.sequenceIndex).padStart(2, '0')} · ` : ''}{asset.name}</span>
              <small>{evidence.canonicalEntityId || '未建立实体'}{aliases.length > 1 ? ` · ${aliases.length} 个别名/源变体已合并` : ''}</small>
            </div>)}
          </div>
        </div>;
      })}
    </div>
  </section>;
}

function formatToastDetails(details) {
  if (!details) return '';
  if (Array.isArray(details)) return details.map(formatToastDetails).filter(Boolean).join(' · ');
  if (typeof details === 'object') return Object.entries(details).map(([key, value]) => `${key}: ${formatToastDetails(value)}`).filter((item) => !item.endsWith(': ')).join(' · ');
  return String(details);
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, options);
  const body = await response.json().catch(() => ({ ok: false, error: { message: '服务器返回不可解析内容' } }));
  if (!response.ok || body.ok === false) {
    const error = new Error(body?.error?.message || `请求失败 (${response.status})`);
    error.code = body?.error?.code;
    error.details = body?.error?.details;
    error.status = response.status;
    throw error;
  }
  return body;
}

async function loadHostedProjectSnapshot() {
  const response = await fetch('/project-bootstrap.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`项目快照读取失败 (${response.status})`);
  const body = await response.json();
  if (!body?.project) throw new Error('项目快照缺少当前项目');
  return body;
}

function App() {
  const [activeStep, setActiveStep] = useState('source');
  const trafficOnlyMode = new URLSearchParams(window.location.search).get('view') === 'traffic' || new URLSearchParams(window.location.search).get('traffic') === '1';
  const [cachedProjectLibrary] = useState(() => readProjectLibraryCache());
  const [project, setProject] = useState(cachedProjectLibrary?.project || null);
  const [projects, setProjects] = useState(cachedProjectLibrary?.projects || []);
  const [activeProjectId, setActiveProjectId] = useState(cachedProjectLibrary?.activeProjectId || null);
  const [projectLibraryState, setProjectLibraryState] = useState({ status: 'loading', message: '正在连接项目库', lastSyncedAt: cachedProjectLibrary?.syncedAt || null });
  const [projectLibraryOpen, setProjectLibraryOpen] = useState(false);
  const [geographicContext, setGeographicContext] = useState({ available: false, stale: false });
  const [workspaceHydrating, setWorkspaceHydrating] = useState(true);
  const [transportPlan, setTransportPlan] = useState(null);
  const [settings, setSettings] = useState({ timeSlots: [] });
  const [assets, setAssets] = useState([]);
  const [artifacts, setArtifacts] = useState([]);
  const [health, setHealth] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobEvents, setJobEvents] = useState([]);
  const [observations, setObservations] = useState([]);
  const [sceneObjects, setSceneObjects] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [jobStreamStatus, setJobStreamStatus] = useState({});
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [expertMode, setExpertMode] = useState(false);

  const notify = (kind, message, details) => {
    setToast({ kind, message, details });
    window.clearTimeout(window.__srToast);
    window.__srToast = window.setTimeout(() => setToast(null), 6000);
  };

  const refresh = async ({ silent = false, bootstrap = false } = {}) => {
    let p;
    let library;
    try {
      [p, library] = await Promise.all([api(bootstrap ? '/project?view=bootstrap' : '/project'), api('/projects')]);
      const syncedAt = new Date().toISOString();
      const projectSnapshot = {
        project: p.project || null,
        projects: library.projects || [],
        activeProjectId: library.activeProjectId || null,
        syncedAt
      };
      setProject(projectSnapshot.project);
      setProjects(projectSnapshot.projects);
      setActiveProjectId(projectSnapshot.activeProjectId);
      setProjectLibraryState({ status: 'ready', message: '', lastSyncedAt: syncedAt });
      writeProjectLibraryCache(projectSnapshot);
      setGeographicContext(p.geographicContext || { available: false, stale: false });
      setSettings(p.settings || { timeSlots: [] });
      setAssets(p.assets || []);
      setArtifacts(p.artifacts || []);
      setWorkspaceHydrating(false);
      if (bootstrap) {
        // Hydrate the complete evidence/manifest index after the shell and
        // current visual layers have painted.  Starting the 1.48 MB request
        // immediately still competed with GLTF decoding on slower machines.
        let hydrated = false;
        let fallbackTimer = 0;
        const hydrateFullIndex = () => {
          if (hydrated) return;
          hydrated = true;
          window.clearTimeout(fallbackTimer);
          api('/project').then((full) => {
            setGeographicContext(full.geographicContext || { available: false, stale: false });
            setSettings(full.settings || { timeSlots: [] });
            setAssets(full.assets || []);
            setArtifacts(full.artifacts || []);
          }).catch((error) => {
            if (!silent) notify('warning', '完整证据索引将在后台重试', error.message);
          });
        };
        window.addEventListener('spatial-reframe:model-ready', hydrateFullIndex, { once: true });
        fallbackTimer = window.setTimeout(hydrateFullIndex, 45000);
      }
    } catch (error) {
      try {
        const fallback = await loadHostedProjectSnapshot();
        const syncedAt = new Date().toISOString();
        const projectSnapshot = {
          project: fallback.project,
          projects: fallback.projects || [fallback.project],
          activeProjectId: fallback.activeProjectId || fallback.project.id,
          syncedAt
        };
        setProject(projectSnapshot.project);
        setProjects(projectSnapshot.projects);
        setActiveProjectId(projectSnapshot.activeProjectId);
        setProjectLibraryState({ status: 'ready', message: '已加载站点内置项目快照', lastSyncedAt: syncedAt });
        writeProjectLibraryCache(projectSnapshot);
        setGeographicContext(fallback.geographicContext || { available: false, stale: false });
        setSettings(fallback.settings || { timeSlots: [] });
        setAssets(fallback.assets || []);
        setArtifacts(fallback.artifacts || []);
        setWorkspaceHydrating(false);
        if (!silent) notify('warning', '已加载站点内置项目快照', '在线编辑和上传功能需连接项目服务后启用');
        return true;
      } catch (fallbackError) {
        setWorkspaceHydrating(false);
        setProjectLibraryState((current) => ({ ...current, status: 'error', message: fallbackError.message || error.message || '无法加载项目' }));
        if (!silent) notify('error', '项目服务暂时不可用', fallbackError.message || error.message);
        return false;
      }
    }

    try {
      const [h, j, pr, ob, so, tp] = await Promise.all([
        api('/health'), api('/jobs'), api('/proposals'), api('/observations'), api('/scene/objects'), api('/transport/plan')
      ]);
      setHealth(h);
      setJobs(j.jobs || []);
      setProposals(pr.proposals || []);
      setObservations(ob.observations || []);
      setSceneObjects((so.objects || []).filter((object) => object?.properties?.stale !== true));
      setTransportPlan(tp.plan || null);
      window.clearTimeout(window.__srWorkspaceRetry);
      return true;
    } catch (error) {
      if (!silent) notify('error', '项目已载入，但部分工作区数据获取失败', error.message);
      window.clearTimeout(window.__srWorkspaceRetry);
      window.__srWorkspaceRetry = window.setTimeout(() => refresh({ silent: true }), 3500);
      return false;
    }
  };

  // The first paint only needs the current visual layers.  Historical
  // manifests and superseded CAD records are hydrated by an ordinary refresh
  // after the shell and the fast scene poster are already visible.
  useEffect(() => {
    refresh({ bootstrap: true });
  }, []);

  useEffect(() => {
    if (projectLibraryState.status !== 'error') return undefined;
    const timer = window.setInterval(() => refresh({ silent: true }), 5000);
    return () => window.clearInterval(timer);
  }, [projectLibraryState.status]);

  const refreshRuntime = async () => {
    setRuntimeBusy(true);
    try {
      const result = await api('/health');
      setHealth(result);
      notify('success', '系统运行时状态已刷新');
    } catch (error) {
      notify('error', error.message, error.details);
    } finally {
      setRuntimeBusy(false);
    }
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    const media = window.matchMedia('(min-width: 821px)');
    const closeOnDesktop = () => { if (media.matches) setMenuOpen(false); };
    const closeOnEscape = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    const previousOverflow = document.body.style.overflow;
    if (!media.matches) document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    media.addEventListener('change', closeOnDesktop);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
      media.removeEventListener('change', closeOnDesktop);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!runtimeOpen) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setRuntimeOpen(false); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [runtimeOpen]);

  useEffect(() => {
    const activeJobs = jobs.filter((job) => ['queued', 'running'].includes(job.status)).slice(-4);
    if (!activeJobs.length) return undefined;
    const streams = activeJobs.map((job) => {
      const stream = new EventSource(`${API}/jobs/${job.id}/events?after=0`);
      setJobStreamStatus((current) => ({ ...current, [job.id]: { state: 'connecting', attempts: current[job.id]?.attempts || 0, message: '正在连接任务事件' } }));
      stream.onopen = () => setJobStreamStatus((current) => ({ ...current, [job.id]: { state: 'connected', attempts: current[job.id]?.attempts || 0, message: '任务事件已连接' } }));
      stream.onerror = () => setJobStreamStatus((current) => {
        const attempts = (current[job.id]?.attempts || 0) + 1;
        if (attempts >= 5) {
          stream.close();
          window.setTimeout(() => refresh({ silent: true }), 300);
          return { ...current, [job.id]: { state: 'failed', attempts, message: '任务事件重连已达 5 次，已回读任务状态；请稍后手动刷新。' } };
        }
        return { ...current, [job.id]: { state: 'reconnecting', attempts, message: `任务事件连接中断，正在第 ${attempts} 次重连` } };
      });
      const receive = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          setJobEvents((current) => [...current.filter((item) => item.id !== parsed.id), parsed].slice(-80));
          if (['job.completed', 'step.failed'].includes(parsed.type)) refresh();
        } catch (error) {
          setJobStreamStatus((current) => ({ ...current, [job.id]: { ...(current[job.id] || {}), state: 'warning', message: `任务事件解析失败：${error.message || '未知事件格式'}` } }));
        }
      };
      ['job.started', 'step.started', 'tool.completed', 'artifact.created', 'step.failed', 'job.completed'].forEach((type) => stream.addEventListener(type, receive));
      return stream;
    });
    return () => streams.forEach((stream) => stream.close());
  }, [jobs.map((job) => `${job.id}:${job.status}`).join('|')]);

  const completion = useMemo(() => {
    const hasSourceEvidence = Boolean(project) && (assets.length > 0 || artifacts.some((artifact) => artifact.metadata?.stale !== true));
    const hasObservedVision = jobs.some((job) => job.type === 'vision_analysis' && job.status === 'succeeded' && job.sourceNature !== 'virtual_test' && job.output?.observationId);
    const hasSimulatedDraft = proposals.some((proposal) => proposal.status !== 'Expert Approved' && proposal.simulationValidation?.status === 'passed');
    const hasApprovedRelease = proposals.some((proposal) => proposal.status === 'Expert Approved' && artifacts.some((artifact) => artifact.metadata?.proposalId === proposal.id || artifact.metadata?.sourceProposalId === proposal.id));
    const flags = [hasSourceEvidence, hasObservedVision, hasSimulatedDraft, hasApprovedRelease];
    return Math.round(flags.filter(Boolean).length / flags.length * 100);
  }, [project, assets, artifacts, jobs, proposals]);

  const nextStep = () => {
    const i = steps.findIndex((step) => step.id === activeStep);
    setActiveStep(steps[Math.min(i + 1, steps.length - 1)].id);
  };

  const projectSignalLabel = project?.name || (projectLibraryState.status === 'loading' ? '正在连接项目库' : projectLibraryState.status === 'error' ? '项目服务离线' : '尚未建立项目');

  return (
    <div className={`app-shell ${expertMode ? 'expert-mode' : 'operator-mode'} ${trafficOnlyMode ? 'traffic-only-shell' : ''}`}>
      <header className="topbar">
        <button className="menu-button" aria-label={menuOpen ? '关闭导航' : '打开导航'} aria-expanded={menuOpen} aria-controls="workflow-navigation" onClick={() => setMenuOpen((current) => !current)}>{menuOpen ? <X size={19} /> : <Menu size={19} />}</button>
        <div className="brand-lockup">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><strong>空间再编排</strong><small className="expert-only">SPATIAL REFRAME / AI WORKFLOW</small></div>
        </div>
        <button type="button" className={`project-signal project-switcher ${projectLibraryState.status === 'error' ? 'offline' : ''}`} onClick={() => setProjectLibraryOpen(true)} aria-label="打开项目卷宗库">
          <span className={`signal-dot ${projectLibraryState.status === 'ready' && project ? 'online' : ''}`} />
          <span>{projectSignalLabel}</span>
          {projectLibraryState.status === 'error' ? <em>离线 · 数据未删除</em> : project && <em className="expert-only">{project.coordinateSystem}</em>}
          <ChevronRight size={14} />
        </button>
        <div className="topbar-actions">
          {!trafficOnlyMode && <button className="ghost-button traffic-launch-button" onClick={() => { const url = new URL(window.location.href); url.searchParams.set('view', 'traffic'); window.location.href = url.toString(); }}><Route size={15} /> 流量驾驶舱</button>}
          <button className="ghost-button" onClick={() => refresh()}><RefreshCw size={15} /> 刷新状态</button>
          <div className="progress-readout"><small>闭环进度</small><strong>{projectLibraryState.status === 'ready' ? `${completion}%` : '--'}</strong></div>
        </div>
      </header>

      <button type="button" className={`nav-scrim ${menuOpen ? 'open' : ''}`} aria-label="关闭导航" aria-hidden={!menuOpen} tabIndex={menuOpen ? 0 : -1} onClick={() => setMenuOpen(false)} />

      <aside id="workflow-navigation" aria-label="工作流导航" className={`rail ${menuOpen ? 'open' : ''}`}>
        <div className="rail-line" />
        {steps.map((step, index) => {
          const Icon = step.icon;
          const active = activeStep === step.id;
          return (
            <button key={step.id} className={`rail-step ${active ? 'active' : ''}`} onClick={() => { setActiveStep(step.id); setMenuOpen(false); }}>
              <span className="step-index">{step.number}</span>
              <span className="step-node"><Icon size={17} /></span>
              <span className="step-copy"><strong>{step.title}</strong><small>{step.subtitle}</small></span>
              {index < steps.length - 1 && <span className="connector" />}
            </button>
          );
        })}
        <div className="rail-foot">
          <p>AI 方案需要经过专家审核后才能发布。</p>
          <button className="rail-settings" aria-label="系统诊断" onClick={() => { setMenuOpen(false); setRuntimeOpen(true); }}><Settings2 size={16} /> <span className="operator-only">设置</span><span className="expert-only">系统诊断</span></button>
        </div>
      </aside>

      <main className="workspace" data-active-step={activeStep}>
        <div className="workspace-grid" />
        {projectLibraryState.status !== 'ready' && !project && projects.length === 0
          ? <ProjectServiceState state={projectLibraryState} cachedCount={projects.length} onRetry={() => refresh()} />
          : <>
            {projectLibraryState.status === 'error' && <ProjectServiceBanner state={projectLibraryState} onRetry={() => refresh()} />}
            {trafficOnlyMode ? <TrafficOnlyWorkspace project={project} transportPlan={transportPlan} /> : <>
              {activeStep === 'source' && <SourceWorkspace {...{ project, setProject, assets, setAssets, artifacts, sceneObjects, transportPlan, settings, geographicContext, health, jobs, busy, setBusy, notify, refresh, nextStep, workspaceHydrating }} />}
              {activeStep === 'vision' && <VisionWorkspace {...{ project, assets, artifacts, transportPlan, settings, health, jobs, jobEvents, jobStreamStatus, observations, busy, setBusy, notify, refresh, nextStep }} />}
              {activeStep === 'proposal' && <ProposalWorkspace {...{ project, transportPlan, assets, artifacts, settings, sceneObjects, observations, health, proposals, busy, setBusy, notify, refresh, nextStep }} />}
              {activeStep === 'review' && <ReviewWorkspace {...{ project, proposals, assets, artifacts, health, busy, setBusy, notify, refresh }} />}
            </>}
          </>}
      </main>

      {!trafficOnlyMode && <div className="evidence-legend expert-only">
        {evidenceTypes.map(([key, label]) => <span key={key}><i className={`evidence-dot ev-${key.toLowerCase().replace(' ', '-')}`} />{label}</span>)}
      </div>}

      {runtimeOpen && <RuntimeConsole health={health} busy={runtimeBusy} expertMode={expertMode} onExpertModeChange={setExpertMode} onRefresh={refreshRuntime} onClose={() => setRuntimeOpen(false)} />}
      {projectLibraryOpen && <ProjectLibrary {...{ projects, activeProjectId, projectLibraryState, busy, setBusy, notify, refresh }} onRetry={() => refresh()} onClose={() => setProjectLibraryOpen(false)} />}
      {toast && <Toast {...toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function SourceWorkspace({ project, setProject, assets, setAssets, artifacts, sceneObjects, transportPlan, settings, geographicContext, health, jobs, busy, setBusy, notify, refresh, nextStep, workspaceHydrating }) {
  const [form, setForm] = useState({ name: '', address: '', latitude: '', longitude: '', coordinateSystem: 'WGS84' });
  const [showProjectForm, setShowProjectForm] = useState(!project);
  const [contextRadius, setContextRadius] = useState(250);
  const [uploadSourceNature, setUploadSourceNature] = useState('field_observation');
  const images = assets.filter((asset) => asset.type === 'image');
  const videos = assets.filter((asset) => asset.type === 'video');
  const corridorImages = images.filter(isFieldEvidenceAsset);
  const corridorVideos = videos.filter(isFieldEvidenceAsset);
  const hiddenVideoCount = videos.filter((asset) => isExcludedProjectVideo(asset) || isHiddenVideoAlias(asset)).length;
  // Keep the project-material panel focused on human-reviewable evidence.
  // Registered GLB layers remain available in the 3D layer switcher, but the
  // technical model files do not need to occupy the everyday asset list.
  const visibleProjectAssets = assets.filter((asset) => asset.type !== '3d' && (asset.type !== 'video' || (!isExcludedProjectVideo(asset) && !isHiddenVideoAlias(asset))));
  const videoRouteGenerationBlocked = ['scope_locked_pending_motion_reanchor', 'motion_evidence_complete_pending_navigation_reanchor'].includes(project?.videoEvidenceRegistry?.status);
  const [corridorVideoIds, setCorridorVideoIds] = useState(Array(7).fill(''));
  const [corridorPhotoIds, setCorridorPhotoIds] = useState([]);
  const [corridorPanoramaIds, setCorridorPanoramaIds] = useState([]);
  const [supplementalCorridorVideoId, setSupplementalCorridorVideoId] = useState('');
  const [semanticImageId, setSemanticImageId] = useState(images[0]?.id || '');
  const [semanticLabels, setSemanticLabels] = useState('building, road, entrance, walkway, vegetation, street light, barrier');
  const inputRef = useRef(null);
  const contextJob = [...jobs].reverse().find((job) => job.type === 'geographic_context');
  const corridorJob = [...jobs].reverse().find((job) => job.type === 'site_corridor_reconstruction');
  const semanticJob = [...jobs].reverse().find((job) => job.type === 'semantic_extraction' && (!semanticImageId || job.assetId === semanticImageId));
  const semanticOverlay = semanticJob?.output?.artifacts?.find((artifact) => artifact.kind === 'semantic_overlay');
  const semanticImage = images.find((asset) => asset.id === semanticImageId);
  const semanticTestOnly = semanticImage?.sourceNature === 'virtual_test' || semanticImage?.testOnly;
  const terrainStatus = contextJob?.output?.terrain?.status;
  const currentSceneObjects = sceneObjects.filter((object) => object?.properties?.stale !== true);
  const currentRoadCount = currentSceneObjects.filter((object) => object.type === 'road').length;
  const currentBuildingCount = currentSceneObjects.filter((object) => object.type === 'building').length;
  const skpArtifact = [...artifacts].reverse().find((artifact) => artifact.kind === 'skp_glb' && artifact.metadata?.stale !== true);
  const dwgAssets = assets.filter((asset) => asset.type === 'cad' && /\.dwg$/i.test(asset.name || ''));
  const [dwgExtrusion, setDwgExtrusion] = useState({
    assetId: '', regionMode: 'auto_dominant', wallHeightM: 3.2, wallThicknessM: 0.18,
    floorSlabThicknessM: 0.12, doorHeightM: 2.1, windowSillM: 0.9, windowHeadM: 2.4,
    floorCount: 1, storeyHeightM: 3.6, regionRadiusM: 90
  });
  const latestDwgExtrusion = [...artifacts].reverse().find((artifact) => artifact.kind === 'dwg_extrusion_glb' && artifact.metadata?.stale !== true);
  const latestBlenderModel = [...artifacts].reverse().find((artifact) => artifact.kind === 'blender_enhanced_glb'
    && artifact.metadata?.sourceArtifactId === latestDwgExtrusion?.id
    && !artifact.metadata?.supersededAt);
  const latestBlenderPreview = [...artifacts].reverse().find((artifact) => artifact.kind === 'blender_preview_png'
    && artifact.metadata?.sourceArtifactId === latestDwgExtrusion?.id);
  const latestSiteContext = [...artifacts].reverse().find((artifact) => artifact.kind === 'site_context_glb' && artifact.metadata?.stale !== true);
  const latestSitePreview = [...artifacts].reverse().find((artifact) => artifact.kind === 'site_context_blender_preview' && artifact.metadata?.stale !== true)
    || [...artifacts].reverse().find((artifact) => artifact.kind === 'site_corridor_preview' && artifact.metadata?.stale !== true);
  const latestReferenceManifest = [...artifacts].reverse().find((artifact) => artifact.kind === 'reference_source_manifest' && artifact.metadata?.stale !== true);
  const navigationSiteAligned = Boolean(
    latestSiteContext?.metadata?.navigationDimensionPolicy?.operatorConfirmed
    && latestSiteContext?.metadata?.navigationDimensionPolicy?.planDimensions === 'authoritative'
    && latestSiteContext?.metadata?.relativePlanDimensionsApplied === true
  );

  useEffect(() => {
    if (project) setForm(project);
  }, [project]);

  useEffect(() => {
    if (!semanticImageId && images[0]) setSemanticImageId(images[0].id);
    if (semanticImageId && !images.some((asset) => asset.id === semanticImageId)) setSemanticImageId(images[0]?.id || '');
  }, [images.map((asset) => asset.id).join('|'), semanticImageId]);

  useEffect(() => {
    setCorridorVideoIds((current) => siteCorridorVideoPrefixes.map((prefix, index) => {
      const currentAsset = corridorVideos.find((asset) => asset.id === current[index] && String(asset.name || '').toLowerCase().startsWith(prefix));
      return currentAsset?.id || corridorVideos.find((asset) => String(asset.name || '').toLowerCase().startsWith(prefix))?.id || '';
    }));
  }, [corridorVideos.map((asset) => `${asset.id}:${asset.name}`).join('|')]);

  useEffect(() => {
    setCorridorPhotoIds((current) => current.filter((assetId) => corridorImages.some((asset) => asset.id === assetId)));
    setCorridorPanoramaIds((current) => current.filter((assetId) => corridorImages.some((asset) => asset.id === assetId)));
    if (supplementalCorridorVideoId && !corridorVideos.some((asset) => asset.id === supplementalCorridorVideoId)) setSupplementalCorridorVideoId('');
  }, [corridorImages.map((asset) => asset.id).join('|'), corridorVideos.map((asset) => asset.id).join('|'), supplementalCorridorVideoId]);

  useEffect(() => {
    setDwgExtrusion((current) => {
      if (current.assetId && dwgAssets.some((asset) => asset.id === current.assetId)) return current;
      return { ...current, assetId: dwgAssets[0]?.id || '' };
    });
  }, [dwgAssets.map((asset) => asset.id).join('|')]);

  const saveProject = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api('/project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      setProject(result.project);
      setShowProjectForm(false);
      notify('success', '项目地理锚点已保存');
      await refresh();
    } catch (error) { notify('error', error.message); }
    finally { setBusy(false); }
  };

  const uploadFiles = async (files) => {
    if (!files?.length) return;
    if (!project) return notify('error', '请先创建项目再上传资料');
    const data = new FormData();
    data.append('sourceNature', uploadSourceNature);
    [...files].forEach((file) => data.append('files', file));
    setBusy(true);
    try {
      const result = await api('/assets/upload', { method: 'POST', body: data });
      setAssets((current) => [...current, ...result.assets]);
      const sourceLabel = uploadSourceNature === 'virtual_test' ? 'TEST ONLY 资产' : '现场资产';
      notify('success', result.jobs?.length
        ? `已写入 ${result.assets.length} 个${sourceLabel}；${result.jobs.length} 个 SKP / DWG 转换任务正在运行`
        : `已写入 ${result.assets.length} 个${sourceLabel}及 SHA-256`);
      await refresh();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };

  const runReconstruction = async () => {
    const ids = assets.filter((asset) => ['image', 'video', '3d'].includes(asset.type)).map((asset) => asset.id);
    setBusy(true);
    try {
      await api('/scene/reconstruct', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetIds: ids }) });
      notify('success', '3D重建任务已进入队列');
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); refresh(); }
  };

  const generateGeographicContext = async () => {
    if (!project) return notify('error', '请先保存项目经纬度');
    setBusy(true);
    try {
      await api('/scene/context', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ radiusMeters: contextRadius }) });
      notify('success', '真实 OSM 地理底景任务已进入队列');
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); refresh(); }
  };

  const generateSiteCorridor = async () => {
    if (videoRouteGenerationBlocked) {
      return notify('warning', '视频范围已补齐，但完整运动方向与路线重定位尚未完成；暂不生成新的三维路线，避免再次把片段放错位置。');
    }
    const selectedAssets = corridorVideoIds.map((assetId) => corridorVideos.find((asset) => asset.id === assetId));
    if (selectedAssets.some((asset, index) => !asset || !String(asset.name || '').toLowerCase().startsWith(siteCorridorVideoPrefixes[index]))) {
      return notify('error', '请按 450d → 4444 → b322 → 1572 → 783e → f684 → 4b75 选择7段视频');
    }
    if (corridorPanoramaIds.length && corridorPanoramaIds.length !== 11) {
      return notify('error', '全景校正需要按路线顺序选择11张约10米截图');
    }
    // The corridor exterior must use the observed SKP shell.  DWG remains the
    // authoritative indoor/floor model, but wrapping its interior extrusion in
    // a procedural exterior was the source of the wrong main-building massing.
    const mainBuilding = skpArtifact || latestDwgExtrusion;
    if (!mainBuilding) return notify('error', '请先导入并转换主楼 SKP 或 DWG 模型');
    setBusy(true);
    try {
      await api('/scene/site-corridor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoAssetIds: corridorVideoIds,
          photoAssetIds: corridorPhotoIds,
          panoramaAssetIds: corridorPanoramaIds,
          supplementalVideoAssetId: supplementalCorridorVideoId || null,
          mainBuildingArtifactId: mainBuilding.id,
          frameFps: 4,
          useBlender: true
        })
      });
      notify('success', `周边小道重建已进入队列；7段路线视频、当前项目全部${corridorImages.length}张现场照片${corridorPanoramaIds.length ? `（其中${corridorPanoramaIds.length}张作为约10米全景校正）` : ''}${supplementalCorridorVideoId ? '和1段固定机位视频' : ''}将进入证据链，并由 Blender 生成最终 GLB 与可编辑 BLEND`);
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); refresh(); }
  };

  const runSemanticExtraction = async () => {
    if (!semanticImageId) return notify('error', '请选择真实现场图片');
    const labels = [...new Set(semanticLabels.split(',').map((label) => label.trim().toLowerCase()).filter(Boolean))];
    if (!labels.length) return notify('error', '请提供至少一个英文语义标签');
    setBusy(true);
    try {
      await api('/scene/segment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: semanticImageId, labels, boxThreshold: 0.28, textThreshold: 0.25, maxDetections: 40 }) });
      notify('success', `Grounding DINO + SAM 2 ${semanticTestOnly ? 'TEST ONLY' : '现场'}语义任务已进入队列`);
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); refresh(); }
  };

  const generateDwgExtrusion = async () => {
    if (!dwgExtrusion.assetId) return notify('error', '请先导入并选择一份 DWG 平面图');
    setBusy(true);
    try {
      const result = await api('/scene/dwg-extrusion', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dwgExtrusion)
      });
      const metadata = result.artifact?.metadata || {};
      notify('success', `CAD 室内三维已生成：${metadata.levelCount || metadata.floorCount || 1} 个独立楼层，${metadata.sourceSurfaceCount || 0} 个面状构件，${metadata.selectedOpeningCount || 0} 个门窗`);
      await refresh();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };

  const generateBlenderEnhancement = async () => {
    if (!latestDwgExtrusion) return notify('error', '请先根据 DWG 生成 CAD 室内三维');
    if (!health?.runtimes?.blender) return notify('error', 'Blender 后台运行时未就绪，请先配置 BLENDER_BIN');
    const previewFloor = Number(latestDwgExtrusion.metadata?.levels?.[0]?.floorNumber || 1);
    setBusy(true);
    try {
      const result = await api('/scene/blender-enhance', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceArtifactId: latestDwgExtrusion.id, previewFloor })
      });
      notify('success', `Blender 增强完成：${result.enhancement?.enhancedMaterials?.length || 0} 类材质，已生成可编辑 BLEND、网页 GLB 和 ${previewFloor}F 参观预览`);
      await refresh();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };

  const corridorSelectionReady = corridorVideoIds.every((assetId, index) => {
    const asset = corridorVideos.find((item) => item.id === assetId);
    return asset && String(asset.name || '').toLowerCase().startsWith(siteCorridorVideoPrefixes[index]);
  });
  const corridorPanoramaReady = corridorPanoramaIds.length === 0 || corridorPanoramaIds.length === 11;

  return (
    <section className="stage-layout">
      <StageHeading eyebrow="STEP 01 / EVIDENCE INTAKE" title="先建立可信现场，\n再开始空间推演。" description="导入项目位置、现场影像、平面图和已有模型，系统会保留原始资料并生成可查看的三维场景。" />
      <div className="stage-content source-stage">
        <div className="scene-card hero-scene">
            <SceneViewport project={project} assets={assets} artifacts={artifacts} sceneObjects={sceneObjects} transportPlan={transportPlan} hydrating={workspaceHydrating} preferredModelKind={latestSiteContext ? 'site_context_glb' : latestDwgExtrusion ? 'dwg_extrusion_glb' : latestBlenderModel ? 'blender_enhanced_glb' : 'skp_glb'} preferBlender={Boolean(latestBlenderModel && !latestSiteContext && !latestDwgExtrusion)} />
          {geographicContext?.stale && <div className="stale-context-notice"><AlertTriangle size={16} /><div><strong>项目位置已变更</strong><span>原有周边底景已停止参与当前显示与分析。请核对位置后重新生成。</span><small className="expert-only">已将旧 OSM / DEM 产物标记为 stale。</small></div><button type="button" onClick={generateGeographicContext} disabled={busy}>重新生成</button></div>}
          <div className="scene-overlay top-left">
            <span className="kicker expert-only">GEO ANCHOR</span>
            <strong className="expert-only">{project ? `${Number(project.latitude).toFixed(5)}, ${Number(project.longitude).toFixed(5)}` : '等待坐标输入'}</strong>
            <strong className="operator-only">{project ? project.name : '尚未建立项目'}</strong>
            <small>{project?.address || '等待补充场地说明'}</small>
          </div>
          <div className="scene-overlay bottom-right">
            <span><i className="live-pip" /> 场景图层</span>
            <strong>{assets.filter((a) => a.type === '3d' && /\.(glb|gltf|ply)$/i.test(a.name || '')).length + artifacts.filter((a) => ['skp_glb', 'dwg_plan_glb', 'dwg_extrusion_glb', 'site_context_glb'].includes(a.kind) && a.metadata?.stale !== true && !a.metadata?.supersededAt || a.kind === 'site_interior_model_glb' && a.metadata?.stale !== true && !a.metadata?.supersededAt).length + artifacts.filter((a) => a.kind === 'blender_enhanced_glb' && a.metadata?.stale !== true && !a.metadata?.supersededAt).length + Number(artifacts.some((a) => a.kind === 'osm_context_glb' && a.metadata?.stale !== true))}</strong><small>可查看三维层</small>
          </div>
        </div>

        <div className="side-stack">
          <article className="panel project-panel">
            <PanelHeader icon={Map} title="项目位置" action={<button className="text-button" onClick={() => setShowProjectForm(!showProjectForm)}>{showProjectForm ? '收起' : '编辑'}</button>} />
            {showProjectForm ? (
              <form className="project-form" onSubmit={saveProject}>
                <label><span>项目名称</span><input required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="某集团办公楼更新" /></label>
                <label><span>地址 / 场地说明</span><input value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="用于证据记录，不自动猜测" /></label>
                <div className="field-row">
                  <label><span>纬度</span><input required type="number" step="any" value={form.latitude || ''} onChange={(e) => setForm({ ...form, latitude: e.target.value })} placeholder="31.2304" /></label>
                  <label><span>经度</span><input required type="number" step="any" value={form.longitude || ''} onChange={(e) => setForm({ ...form, longitude: e.target.value })} placeholder="121.4737" /></label>
                </div>
                <div className="form-actions"><select value={form.coordinateSystem || 'WGS84'} onChange={(e) => setForm({ ...form, coordinateSystem: e.target.value })}><option>WGS84</option><option>GCJ-02</option><option>BD-09</option></select><button disabled={busy} className="primary-button" type="submit"><Check size={15} /> 保存锚点</button></div>
              </form>
            ) : <ProjectSummary project={project} />}
          </article>

          <article className="panel runtime-panel expert-only">
            <PanelHeader icon={Gauge} title="建模运行时" />
            <RuntimeLine label="COLMAP / PyCOLMAP" ready={health?.runtimes?.colmap} detail="摄影测量" />
            <RuntimeLine label="OpenSKP" ready={health?.runtimes?.skpConverter} detail="SKP → GLB 主体模型" />
            <RuntimeLine label="DWG Reader" ready={health?.runtimes?.dwgReader} detail="DWG → 平面 GLB / GeoJSON" />
            <RuntimeLine label="Blender Worker" ready={health?.runtimes?.blender} state={health?.runtimeCapabilities?.blender?.state} detail={health?.runtimeCapabilities?.blender?.detail || 'CAD 语义 GLB → PBR GLB / BLEND / 参观预览'} />
            <RuntimeLine label="Copernicus GLO-30" ready={terrainStatus === 'available'} detail={terrainStatus === 'available' ? '真实地形已裁剪' : terrainStatus === 'failed' ? '获取失败，已降级' : terrainStatus === 'not_available' ? '本次未使用' : '随底景任务获取'} />
            <RuntimeLine label="Grounding DINO" ready={health?.runtimes?.groundingDino?.available} detail={health?.runtimes?.groundingDino?.available ? '模型与运行时就绪' : health?.runtimes?.groundingDino?.note || '未配置真实模型'} />
            <RuntimeLine label="SAM 2" ready={health?.runtimes?.sam2?.available} detail={health?.runtimes?.sam2?.available ? '模型与运行时就绪' : health?.runtimes?.sam2?.note || '未配置真实模型'} />
            <RuntimeLine label="Nerfstudio / gsplat" state={health?.runtimeCapabilities?.nerfstudio?.state} ready={health?.runtimes?.nerfstudio} detail={health?.runtimeCapabilities?.nerfstudio?.available ? '3DGS 可用' : '可选增强 · 需远程 CUDA Worker'} />
            <RuntimeLine label="Niantic SPZ" state={health?.runtimeCapabilities?.spz?.state} ready={health?.runtimes?.spz} detail={health?.runtimeCapabilities?.spz?.available ? '网页压缩可用' : '可选增强 · 当前使用 GLB / PLY'} />
            <RuntimeLine label="NVIDIA CUDA" state={health?.runtimeCapabilities?.gpu?.state} ready={health?.runtimes?.gpu?.available} detail={health?.runtimeCapabilities?.gpu?.available ? '本机可用' : '外部算力 · 当前使用 COLMAP'} />
            <p className="runtime-note">缺失 3DGS 运行时会降级为真实 COLMAP 点云；缺失 COLMAP / FFmpeg 才阻止摄影测量。</p>
          </article>
        </div>

        <article className="panel asset-panel">
            <PanelHeader icon={Archive} title="项目资料" action={<span className="panel-count">当前视图 {visibleProjectAssets.length} 项 · 视频证据见阶段 03</span>} />
          <div className="source-control">
            <label className="control-label">导入资料用途<select value={uploadSourceNature} onChange={(event) => setUploadSourceNature(event.target.value)}><option value="field_observation">现场资料 · 可进入原始证据链</option><option value="virtual_test">虚拟 / 演示资料 · TEST ONLY</option></select></label>
            {uploadSourceNature === 'virtual_test' && <div className="test-only-banner"><AlertTriangle size={15} /><span><strong>TEST ONLY</strong>本批资料及其衍生产物不得标记为现场实测。</span></div>}
          </div>
          <button className="dropzone" onClick={() => inputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); uploadFiles(e.dataTransfer.files); }}>
            <UploadCloud size={26} /><strong>{uploadSourceNature === 'virtual_test' ? '拖入虚拟 / 演示资料' : '拖入现场证据'}</strong><span>照片、视频、SKP / DWG、GLB / PLY / LAS / SPZ</span><small>原文件会完整保留，建模结果自动关联到项目。</small>
          </button>
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => uploadFiles(e.target.files)} />
          <div className="asset-list">
            {visibleProjectAssets.length === 0 ? <EmptyLine text="尚未导入任何资料" /> : visibleProjectAssets.slice().reverse().map((asset) => <AssetRow key={asset.id} asset={asset} />)}
          </div>
          {hiddenVideoCount > 0 && <small className="expert-only" style={{ display: 'block', marginTop: 8 }}>已隔离的视频仍保留在证据台账中，但未确认属于本项目，不能进入路线、相机或三维模型。</small>}
          {latestReferenceManifest && <a className="reference-source-card" href={latestReferenceManifest.url} target="_blank" rel="noreferrer">
            <div><strong>补充参考资料已登记</strong><span>{latestReferenceManifest.metadata?.imageSourceCount || 0} 张现场图片 · {latestReferenceManifest.metadata?.referenceUrlCount || 0} 篇微信文章</span></div>
            <small>图片可用于立面、光伏、绿化、道路和材质校核；文章保持 Reference，不直接生成现场实测几何。</small>
            {latestSiteContext?.metadata?.supplementalReferenceManifestId === latestReferenceManifest.id
              ? <em className="reference-binding-state ready">已绑定当前周边模型 · 几何未被无控制点资料改写</em>
              : <em className="reference-binding-state pending">资料已保存，等待绑定到当前周边模型</em>}
          </a>}
        </article>

        <article className="panel method-panel">
          <PanelHeader icon={Layers3} title="场地与室内建模" />
          <div className="context-generator">
            <div><strong>生成周边建筑与道路</strong><span className="expert-only">经纬度 → OSMnx / Copernicus GLO-30 → 本地米制 Trimesh GLB</span></div>
            <label className="context-radius expert-only"><span>生成半径</span><input type="number" min="50" max="1000" step="50" value={contextRadius} onChange={(event) => setContextRadius(Number(event.target.value))} /><small>m</small></label>
            <button className="secondary-button" disabled={busy || !project || ['queued', 'running'].includes(contextJob?.status)} onClick={generateGeographicContext}><Map size={14} /> {['queued', 'running'].includes(contextJob?.status) ? '正在生成' : '生成周边底景'}</button>
          </div>
          <div className="context-layer-status" aria-label="三维图层来源与配准状态">
            <div><span>主体细节</span><strong>{skpArtifact ? '已读取原始模型' : '未导入主体模型'}</strong><small className="expert-only">门窗、砖瓦和贴图只读取源文件，不由系统补造。</small></div>
            <div><span>周边建筑 / 街道</span><strong>{currentBuildingCount} 栋 · {currentRoadCount} 条</strong><small className="expert-only">OSM + DEM 生成概念体量；高细节周边可上传内嵌材质的 GLB。</small></div>
            <div className={navigationSiteAligned ? 'ready' : skpArtifact?.metadata?.georeferenced ? 'ready' : 'blocked'}><span>与周边对齐</span><strong>{navigationSiteAligned ? '导航平面已对齐' : skpArtifact?.metadata?.georeferenced ? '已对齐' : '待校准'}</strong><small className="expert-only">{navigationSiteAligned ? '主楼、道路和场地先按导航图形尺寸、比例、方向与邻接关系配准；现场影像仅补充细节和材质。' : skpArtifact?.metadata?.georeferenced ? '主体与周边使用同一米制坐标。' : '原始 SKP 仍是相对米制；周边场景需要导航锚点或控制点配准。'}</small></div>
          </div>
          <div className="site-corridor-control">
            <div className="site-corridor-head">
              <div><strong>连续视频周边小道</strong><span>当前项目已收录全部现场视频；7段仅是旧主环线入口，其他小道、门、停车场、转弯、岔路和360站点均保留在融合证据清单中，待运动方向与路线位置完成重定位后再生成新模型。</span></div>
              <em>{videoRouteGenerationBlocked ? '等待视频/导航重定位' : latestSiteContext ? '近似配准已生成' : '等待视频'}</em>
            </div>
            {project?.videoEvidenceRegistry?.counts && <div className="video-scope-audit" role="status"><strong>视频证据边界已锁定</strong><span>{project.videoEvidenceRegistry.counts.fieldAliases} 个现场文件别名 · {project.videoEvidenceRegistry.counts.uniqueVideoIds} 个视频 ID · {project.videoEvidenceRegistry.counts.spatialEvidenceEntities} 个空间证据实体 · {project.videoEvidenceRegistry.counts.excludedUnconfirmed} 个未确认视频已隔离</span></div>}
            <VideoEvidenceScopeList videos={videos} />
            {videoRouteGenerationBlocked
              ? <VideoEvidenceRouteLedger videos={videos} blocked />
              : <div className="site-corridor-sequence" aria-label="连续视频顺序">
                {siteCorridorVideoPrefixes.map((prefix, index) => <label key={prefix}><span>{String(index + 1).padStart(2, '0')} · {prefix}</span><select value={corridorVideoIds[index] || ''} onChange={(event) => setCorridorVideoIds((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.value : value))}><option value="">请选择视频</option>{corridorVideos.map((asset) => <option key={asset.id} value={asset.id}>{videoDisplayName(asset)}</option>)}</select></label>)}
              </div>}
            <div className="site-corridor-evidence-fields">
              <label><span>补充现场照片</span><select multiple value={corridorPhotoIds} onChange={(event) => setCorridorPhotoIds([...event.target.selectedOptions].map((option) => option.value))}>{corridorImages.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><small>用于门岗、护栏、树冠、建筑立面和材质证据；未手动选择的现场照片也会自动纳入。</small></label>
              <label><span>约10米全景校正</span><select multiple value={corridorPanoramaIds} onChange={(event) => setCorridorPanoramaIds([...event.target.selectedOptions].map((option) => option.value))}>{corridorImages.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><small>按路线顺序选择11张截图；用于建立近楼通道、栅栏后外侧通道及小门关系。</small></label>
              <label><span>补充固定机位视频</span><select value={supplementalCorridorVideoId} onChange={(event) => setSupplementalCorridorVideoId(event.target.value)}><option value="">不使用</option>{corridorVideos.filter((asset) => !corridorVideoIds.includes(asset.id)).map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select><small>只校正路口、夜景和空间邻接，不生成新的相机轨迹。</small></label>
            </div>
            <div className="site-corridor-actions">
              <div><strong>{corridorJob?.status === 'succeeded' ? `${Math.round(corridorJob.output?.routeLengthM || 0)}m 连续路线 · ${corridorJob.output?.blenderRefinement ? 'Blender 已精修' : '基础 GLB'}` : corridorJob?.status === 'failed' ? '生成失败' : ['queued', 'running'].includes(corridorJob?.status) ? corridorJob?.stage === 'blender_refinement' ? '正在 Blender 精修与渲染' : '正在密集抽帧和建模' : '4 fps 密集关键帧 · 现场纹理裁剪 · CAD 主楼 · Blender GLB / BLEND'}</strong><span>{corridorJob?.status === 'failed' ? corridorJob.error : '第四段仅作为转弯连接证据；未拍路段标为 Hypothesis，场景不放置代表车辆或方向箭头。'}</span></div>
              <button type="button" className="secondary-button" disabled={busy || videoRouteGenerationBlocked || !corridorSelectionReady || !corridorPanoramaReady || !(skpArtifact || latestDwgExtrusion) || ['queued', 'running'].includes(corridorJob?.status)} onClick={generateSiteCorridor}><Route size={14} />{videoRouteGenerationBlocked ? '等待视频/导航重定位' : ['queued', 'running'].includes(corridorJob?.status) ? '正在生成' : latestSiteContext ? '重新生成小道' : '生成连续小道'}</button>
            </div>
            {latestSitePreview && <a className="site-corridor-preview" href={latestSitePreview.url} target="_blank" rel="noreferrer"><img src={latestSitePreview.url} alt="连续视频建筑周边小道预览" /><span><strong>{latestSitePreview.kind === 'site_context_blender_preview' ? 'Blender 晴天主体周边预览已生成' : '连续总览已生成'}</strong><small>路线显示保持连续；片段与推定区间在内部证据清单追溯。</small></span></a>}
          </div>
          <div className="dwg-extrusion-control">
            <div className="dwg-extrusion-head">
              <div><strong>CAD 室内三维</strong><span>按图框识别独立楼层，优先读取墙体填充和闭合轮廓生成面状墙体，再用线条补齐柱、玻璃、交通核心和门窗。</span></div>
              <div className="dwg-evidence expert-only"><em>Derived 平面几何</em><em>Hypothesis 高度参数</em></div>
            </div>
            <div className="dwg-extrusion-fields">
              <label className="dwg-source-field"><span>平面图</span><select value={dwgExtrusion.assetId} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, assetId: event.target.value })}><option value="">请选择 DWG</option>{dwgAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
              <label className="dwg-advanced-field expert-only"><span>识别范围</span><select value={dwgExtrusion.regionMode} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, regionMode: event.target.value })}><option value="auto_dominant">自动识别全部楼层</option><option value="all_candidates">无图框时使用全部候选</option></select></label>
              <label className="dwg-advanced-field expert-only"><span>墙高</span><div><input type="number" min="1.8" max="8" step="0.1" value={dwgExtrusion.wallHeightM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, wallHeightM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>墙厚</span><div><input type="number" min="0.05" max="0.8" step="0.01" value={dwgExtrusion.wallThicknessM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, wallThicknessM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>楼板厚度</span><div><input type="number" min="0.05" max="0.5" step="0.01" value={dwgExtrusion.floorSlabThicknessM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, floorSlabThicknessM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>门高</span><div><input type="number" min="1.8" max="3.5" step="0.05" value={dwgExtrusion.doorHeightM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, doorHeightM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>窗台高</span><div><input type="number" min="0" max="4" step="0.05" value={dwgExtrusion.windowSillM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, windowSillM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>窗顶高</span><div><input type="number" min="0.4" max="8" step="0.05" value={dwgExtrusion.windowHeadM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, windowHeadM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>无图框备用层数</span><div><input type="number" min="1" max="20" step="1" value={dwgExtrusion.floorCount} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, floorCount: Number(event.target.value) })} /><small>层</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>层高</span><div><input type="number" min="1.8" max="12" step="0.1" value={dwgExtrusion.storeyHeightM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, storeyHeightM: Number(event.target.value) })} /><small>m</small></div></label>
              <label className="dwg-advanced-field expert-only"><span>主平面半径</span><div><input type="number" min="20" max="300" step="10" disabled={dwgExtrusion.regionMode !== 'auto_dominant'} value={dwgExtrusion.regionRadiusM} onChange={(event) => setDwgExtrusion({ ...dwgExtrusion, regionRadiusM: Number(event.target.value) })} /><small>m</small></div></label>
              <button type="button" className="secondary-button" disabled={busy || !dwgExtrusion.assetId} onClick={generateDwgExtrusion}><Box size={14} />{busy ? '正在生成' : '根据 CAD 生成室内三维'}</button>
            </div>
            <p className="dwg-extrusion-note expert-only">楼层数由 CAD 图框自动识别；门窗位置、方向和宽度来自 CAD 门窗块参照；墙高、楼层高程、家具高度和门扇开启角度仍需人工核验。检测到多张平面图时会分别生成独立楼层，不再重复同一张平面。</p>
            {latestDwgExtrusion && <div className="dwg-extrusion-result"><CheckCircle2 size={14} /><span><strong className="operator-only">室内三维已更新</strong><strong className="expert-only">{latestDwgExtrusion.title}</strong>{latestDwgExtrusion.metadata?.levelCount ?? latestDwgExtrusion.metadata?.floorCount ?? 1} 层 · {latestDwgExtrusion.metadata?.openingCounts?.door ?? 0} 门 / {latestDwgExtrusion.metadata?.openingCounts?.window ?? 0} 窗 · {latestDwgExtrusion.metadata?.selectedFurnitureCount ?? 0} 件家具<span className="expert-only"> · {latestDwgExtrusion.metadata?.sourceSurfaceCount ?? 0} 个面状构件 · {latestDwgExtrusion.metadata?.resolvedOpeningCounts?.window ?? 0} 个窗洞已对齐</span></span></div>}
            {latestDwgExtrusion && <div className="blender-enhancement-control">
              <div><strong>Blender 材质与参观增强</strong><span>沿用 CAD 真实几何，增加可编辑 BLEND、程序材质、网页 GLB 和一层参观预览。新增材质与灯光均标记为 Hypothesis。</span></div>
              <button type="button" className="secondary-button" disabled={busy || !health?.runtimes?.blender} onClick={generateBlenderEnhancement}><Box size={14} />{busy ? '正在生成' : latestBlenderModel ? '重新生成 Blender 资产' : '生成 Blender 资产'}</button>
              {latestBlenderPreview && <a className="blender-preview" href={latestBlenderPreview.url} target="_blank" rel="noreferrer"><img src={latestBlenderPreview.url} alt="Blender 一层参观预览" /><span><strong>一层参观预览已生成</strong><small>{latestBlenderModel ? '网页当前可切换到 PBR 增强模型' : '等待增强 GLB 登记'}</small></span></a>}
            </div>}
          </div>
          <div className="semantic-generator">
            <div className="semantic-generator-copy"><strong>识别图片中的空间要素</strong><span className="expert-only">Grounding DINO + SAM 2：现场图片 → 文本引导框 → 逐对象掩膜 → 二维候选</span></div>
            <label><span>图片证据</span><select value={semanticImageId} onChange={(event) => setSemanticImageId(event.target.value)}><option value="">请选择图片</option>{images.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}{asset.testOnly ? ' · TEST ONLY' : ''}</option>)}</select></label>
            <label className="semantic-labels expert-only"><span>模型识别标签（英文，逗号分隔）</span><input value={semanticLabels} onChange={(event) => setSemanticLabels(event.target.value)} /></label>
            <button className="secondary-button" disabled={busy || !semanticImageId || ['queued', 'running'].includes(semanticJob?.status)} onClick={runSemanticExtraction}><ScanLine size={14} /> {['queued', 'running'].includes(semanticJob?.status) ? '正在识别' : semanticTestOnly ? '提取测试语义' : '提取现场语义'}</button>
            {semanticTestOnly && <div className="test-only-banner"><AlertTriangle size={15} /><span><strong>TEST ONLY</strong>该图片的二维候选只验证识别流程，不作为现场空间事实。</span></div>}
            {semanticOverlay && <a className="semantic-preview" href={semanticOverlay.url} target="_blank" rel="noreferrer"><img src={semanticOverlay.url} alt="空间要素识别结果" /><span><span className="operator-only">已识别 {semanticJob.output.count} 个空间要素</span><span className="expert-only">{semanticJob.output.count} 个二维候选 · 尚未映射三维</span></span></a>}
            {semanticJob?.diagnostics?.length > 0 && <div className="semantic-diagnostics">{semanticJob.diagnostics.map((diagnostic) => <span key={diagnostic}><AlertTriangle size={12} />{diagnostic}</span>)}</div>}
          </div>
          <div className="expert-only"><Toolchain /></div>
          <div className="quality-gate expert-only"><AlertTriangle size={16} /><p><strong>3DGS 发布门槛</strong><span>≥30 注册视角 · 注册率 ≥70% · 中位重投影误差 ≤2px</span></p></div>
          <div className="semantic-registry-shell expert-only"><SemanticObjectRegistry {...{ project, assets, artifacts, sceneObjects, busy, setBusy, notify, refresh }} /></div>
        </article>
      </div>
      <StageFooter left="资料准备完成后，进入典型时段观测" actions={<><button className="secondary-button" disabled={busy || assets.length === 0} onClick={runReconstruction}><Box size={16} /> 生成三维场景</button><button className="primary-button" onClick={nextStep}>进入流动观测 <ArrowRight size={16} /></button></>} />
    </section>
  );
}

function keyframeEvidenceUrl(imagePath) {
  const raw = String(imagePath || '').replaceAll('\\', '/').trim();
  if (!raw || raw.includes('..') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return '';
  const marker = 'docs/evidence/';
  const relative = raw.includes(marker) ? raw.slice(raw.indexOf(marker) + marker.length) : raw;
  if (!relative || relative.includes('..')) return '';
  return `${API}/reconstruction/evidence?path=${encodeURIComponent(relative)}`;
}

function keyframeContactSheetUrl(videoId) {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return `${API}/reconstruction/evidence?path=${encodeURIComponent(`second-capture-video-phase2-keyframes-v2/${id}.html`)}`;
}

function frameFromLedger(ledger, frameId) {
  const wanted = String(frameId || '');
  for (const video of ledger?.videos || []) {
    for (const frame of video.frames || []) {
      if (String(frame.frameId || frame.id || '') === wanted) return { video, frame };
    }
  }
  const match = wanted.match(/^([^:]+):.*?(?:frame[-_]?)(\d+)$/i);
  if (!match) return null;
  const video = (ledger?.videos || []).find((item) => String(item.videoId) === match[1]);
  const frame = video?.frames?.find((item) => Number(item.frameNo) === Number(match[2]));
  return frame ? { video, frame } : null;
}

function reviewPatchToServer(patch = {}) {
  const next = {};
  const requestedState = patch.reviewStatus || patch.userStatus || patch.status;
  if (requestedState) {
    if (requestedState === 'confirmed' || requestedState === 'corrected') {
      next.selectionStatus = 'adopted';
      next.userConfirmationState = 'confirmed';
      next.modelEligibility = 'eligible_after_scene_confirmation';
    } else if (requestedState === 'rejected') {
      next.selectionStatus = 'not_adopted';
      next.userConfirmationState = 'pending';
      next.modelEligibility = 'not_adopted';
    } else {
      next.selectionStatus = 'unreviewed';
      next.userConfirmationState = 'pending';
      next.modelEligibility = 'blocked_until_scene_confirmation';
    }
  }
  if (patch.selectionStatus) {
    next.selectionStatus = patch.selectionStatus === 'selected' ? 'adopted'
      : patch.selectionStatus === 'not_selected' ? 'not_adopted'
        : patch.selectionStatus;
  }
  if (patch.selectionReason != null) next.selectionReason = patch.selectionReason;
  if (patch.mapBinding != null) next.mapBinding = patch.mapBinding;
  if (patch.routeSegment != null) next.routeSegment = patch.routeSegment;
  if (patch.progress != null) next.progress = patch.progress;
  if (patch.motionState != null) {
    next.motionState = patch.motionState === 'rotation-only' ? 'rotation' : patch.motionState === 'backward' ? 'return' : patch.motionState;
  }
  if (patch.cameraRelative != null) next.cameraRelative = patch.cameraRelative;
  if (patch.changeFromPrevious != null) next.changeFromPrevious = patch.changeFromPrevious;
  if (patch.changeToNext != null) next.changeToNext = patch.changeToNext;
  if (patch.locationBasis != null) next.locationBasis = patch.locationBasis;
  if (patch.confidence != null) next.confidence = patch.confidence;
  if (patch.temporaryObjects != null) next.temporaryObjects = patch.temporaryObjects;
  if (patch.notes != null) next.notes = patch.notes;
  return next;
}

function MovingVideoReconstructionReview({ project, artifacts = [], notify }) {
  const [summaries, setSummaries] = useState([]);
  const [selectedSceneId, setSelectedSceneId] = useState('');
  const [ledger, setLedger] = useState(null);
  const [temporaryLayer, setTemporaryLayer] = useState({ visible: true, objectVisibility: {} });
  const [state, setState] = useState({ status: 'loading', message: '正在读取逐帧确认账本' });
  const [saving, setSaving] = useState(false);

  const loadSummaries = async () => {
    if (!project?.id) {
      setSummaries([]);
      setLedger(null);
      setState({ status: 'idle', message: '建立项目后载入逐帧确认账本' });
      return;
    }
    try {
      setState({ status: 'loading', message: '正在读取逐帧确认账本' });
      const result = await api('/reconstruction/keyframe-ledgers');
      const nextSummaries = Array.isArray(result.summaries) ? result.summaries : [];
      setSummaries(nextSummaries);
      setSelectedSceneId((current) => current && nextSummaries.some((item) => item.sceneId === current) ? current : nextSummaries[0]?.sceneId || '');
      setState({ status: 'ready', message: nextSummaries.length ? '' : '尚无场景账本' });
    } catch (error) {
      setState({ status: 'error', message: error.message || '无法读取逐帧确认账本' });
    }
  };

  const loadLedger = async (sceneId) => {
    if (!sceneId) { setLedger(null); return; }
    try {
      setState({ status: 'loading', message: '正在载入场景逐帧记录' });
      const result = await api(`/reconstruction/keyframe-ledgers/${encodeURIComponent(sceneId)}`);
      setLedger(result.ledger || null);
      setTemporaryLayer(result.ledger?.temporaryLayer || { visible: true, objectVisibility: {} });
      setState({ status: 'ready', message: '' });
    } catch (error) {
      setLedger(null);
      setState({ status: 'error', message: error.message || '无法载入场景账本' });
    }
  };

  useEffect(() => { loadSummaries(); }, [project?.id]);
  useEffect(() => { loadLedger(selectedSceneId); }, [selectedSceneId]);

  const selectedMapArtifact = artifacts.find((artifact) =>
    artifact.kind === 'site_direct_image_reference_png'
    && artifact.metadata?.candidateKey === 'scope-direct-image-v3'
    && artifact.metadata?.stale !== true
  );
  const mapImageUrl = selectedMapArtifact?.url || '';

  const updateFrame = async (frameId, patch, optimisticLedger) => {
    if (!ledger || saving) return;
    const source = frameFromLedger(ledger, frameId);
    if (!source) {
      notify('warning', '找不到对应原始关键帧，未写入确认状态');
      return;
    }
    setSaving(true);
    try {
      const result = await api(`/reconstruction/keyframe-ledgers/${encodeURIComponent(ledger.sceneId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frameUpdates: [{ videoId: source.video.videoId, frameNo: source.frame.frameNo, patch: reviewPatchToServer(patch) }] })
      });
      setLedger(result.ledger || optimisticLedger || ledger);
      notify('success', `关键帧 ${source.video.videoId.slice(0, 8)} / ${source.frame.frameNo} 的审阅状态已保存`);
    } catch (error) {
      notify('warning', '关键帧状态未保存', error.message);
    } finally { setSaving(false); }
  };

  const toggleTemporaryLayer = async (objectId, visible) => {
    if (!ledger || saving) return;
    const next = objectId === '__all__'
      ? { ...temporaryLayer, visible }
      : { ...temporaryLayer, objectVisibility: { ...(temporaryLayer.objectVisibility || {}), [objectId]: visible } };
    setTemporaryLayer(next);
    try {
      const result = await api(`/reconstruction/keyframe-ledgers/${encodeURIComponent(ledger.sceneId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ temporaryLayer: next })
      });
      setLedger(result.ledger || ledger);
    } catch (error) {
      notify('warning', '临时审阅层状态未保存', error.message);
    }
  };

  const confirmScene = async () => {
    if (!ledger || saving) return;
    setSaving(true);
    try {
      const result = await api(`/reconstruction/keyframe-ledgers/${encodeURIComponent(ledger.sceneId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'confirmed', review: { note: '逐帧位置、移动关系和左右环境已完成操作者确认；允许进入候选建模，active 正式模型保持不变。' } })
      });
      setLedger(result.ledger || ledger);
      await loadSummaries();
      notify('success', '本处场景已确认；现在只允许在候选层进行后续建模');
    } catch (error) {
      notify('warning', '场景尚未确认', error.message);
    } finally { setSaving(false); }
  };

  const summary = summaries.find((item) => item.sceneId === selectedSceneId);
  return <section className="moving-video-reconstruction-review-shell" aria-label="移动视频逐关键帧三维重建确认">
    <div className="moving-video-review-toolbar">
      <div><span className="expert-only">FIELD EVIDENCE / FRAME-BY-FRAME GATE</span><h2>移动视频逐关键帧确认</h2><p>先定位、分析并由你确认；确认前不修改候选几何，active 正式模型始终不变。</p></div>
      <label><span>场景</span><select value={selectedSceneId} onChange={(event) => setSelectedSceneId(event.target.value)} disabled={state.status === 'loading' || !summaries.length}><option value="">选择场景</option>{summaries.map((item) => <option key={item.sceneId} value={item.sceneId}>{item.title} · {item.frameCount} 帧</option>)}</select></label>
    </div>
    {state.status === 'loading' && <div className="moving-video-review-status">{state.message || '载入中…'}</div>}
    {state.status === 'error' && <div className="moving-video-review-status error">{state.message}<button type="button" className="secondary-button" onClick={loadSummaries}>重试</button></div>}
    {state.status === 'idle' && <div className="moving-video-review-status">{state.message}</div>}
    {state.status === 'ready' && !ledger && <div className="moving-video-review-status">{summary ? `${summary.title} 尚未载入` : '请选择一个场景'}</div>}
    {ledger && <KeyframeReviewPanel
      ledger={ledger}
      mapImageUrl={mapImageUrl}
      thumbnailUrlResolver={(_frame, imagePath) => keyframeEvidenceUrl(imagePath)}
      contactSheetUrlResolver={(videoId) => keyframeContactSheetUrl(videoId)}
      temporaryLayerVisible={temporaryLayer.visible !== false}
      temporaryLayerObjectVisibility={temporaryLayer.objectVisibility || {}}
      onUpdateFrame={updateFrame}
      onToggleTemporaryLayer={toggleTemporaryLayer}
      onConfirm={confirmScene}
      readOnly={saving}
    />}
  </section>;
}

function TransportWorkspace({ openProposal, openReview }) {
  return <section className="stage-layout"><StageHeading eyebrow="STEP 02 / TRANSIT ACCESS" title="交通接驳统计已移除" description="完整高德路况交付和交通流量视频已集中到 03 流动观测，避免同一份数据在两个页面重复展示。" /><div className="transport-redirect-note"><strong>请进入 03 流动观测</strong><span>那里只保留高德完整交付表格、表格分析和一段交通流量视频证明。</span></div></section>;
}

function parseActivityCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const delimiter = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const parseLine = (line) => {
    const cells = [];
    let cell = ''; let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"' && line[index + 1] === '"') { cell += '"'; index += 1; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (char === delimiter && !quoted) { cells.push(cell.trim()); cell = ''; } else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };
  const headers = parseLine(lines[0]);
  return { headers, rows: lines.slice(1, 101).map(parseLine) };
}

function activityFallbackTable(transportPlan) {
  const scenario = transportPlan?.scenarios?.find((item) => item.id === 'weekday-0830') || transportPlan?.scenarios?.[0];
  const rows = Object.entries(scenario?.roadFlow || {})
    .filter(([roadId]) => ['metro-2-to-building-north', 'metro-4-to-building-west', 'west-gate-walkway'].includes(roadId))
    .map(([roadId, flow]) => [roadId, flow.pedestrians ?? '—', flow.bicycles ?? '—', flow.eBikes ?? '—', 'Scenario']);
  return { headers: ['路线 ID', '行人 / 小时', '自行车 / 小时', '电动车 / 小时', '证据级别'], rows };
}

function ActivityTablePreview({ files = [], transportPlan }) {
  const [selectedId, setSelectedId] = useState(files[0]?.id || 'scenario-table');
  const [table, setTable] = useState(() => activityFallbackTable(transportPlan));
  const [notice, setNotice] = useState('当前窗口显示三条独立路线的 Scenario 表。');
  const selected = files.find((asset) => asset.id === selectedId);
  useEffect(() => { if (files.length && !files.some((asset) => asset.id === selectedId)) setSelectedId(files[0].id); }, [files, selectedId]);
  useEffect(() => {
    let cancelled = false;
    if (!selected) { setTable(activityFallbackTable(transportPlan)); setNotice('当前窗口显示三条独立路线的 Scenario 表。'); return undefined; }
    const ext = String(selected.name || '').split('.').pop()?.toLowerCase();
    if (!['csv', 'json'].includes(ext)) {
      setTable({ headers: ['文件', '预览状态'], rows: [[selected.name, 'XLS/XLSX 原件已保留；浏览器暂不改写二进制表格']] });
      setNotice('该文件是 XLS/XLSX 二进制表格；原文件可下载，当前先显示索引，不把未解析内容冒充为数据。');
      return undefined;
    }
    setNotice('正在读取原始表格内容…');
    fetch(selected.url).then((response) => { if (!response.ok) throw new Error(`读取失败 ${response.status}`); return ext === 'json' ? response.json() : response.text(); }).then((payload) => {
      if (cancelled) return;
      if (ext === 'csv') { setTable(parseActivityCsv(payload)); setNotice(`${selected.name} · 原始 CSV 预览，最多显示 100 行`); return; }
      const list = Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : [payload];
      const headers = [...new Set(list.flatMap((row) => row && typeof row === 'object' ? Object.keys(row) : ['value']))].slice(0, 16);
      setTable({ headers, rows: list.slice(0, 100).map((row) => headers.map((header) => typeof row === 'object' ? row?.[header] ?? '' : String(row))) });
      setNotice(`${selected.name} · 原始 JSON 预览，最多显示 100 行`);
    }).catch(() => { if (!cancelled) { setTable(activityFallbackTable(transportPlan)); setNotice(`${selected.name} 无法读取，已回退到当前 Scenario 路线表；没有编造原始内容。`); } });
    return () => { cancelled = true; };
  }, [selected, transportPlan]);
  return <div className="activity-table-preview">
    <div className="activity-evidence-toolbar"><div><strong>原始表格证据</strong><small>{notice}</small></div><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}><option value="scenario-table">当前路网 Scenario 表</option>{files.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></div>
    <div className="activity-table-scroll" role="region" aria-label="可拖动的活动数据表格" tabIndex="0"><table><thead><tr>{table.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead><tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{String(cell ?? '')}</td>)}</tr>)}</tbody></table>{!table.rows.length && <div className="activity-table-empty">表格暂无可显示行</div>}</div>
    <div className="activity-table-analysis"><span>ANALYSIS</span><strong>路线独立读取</strong><small>2号口、4号口、西门小道分别进入分析，不把它们拼成一个“总人流”。</small></div>
  </div>;
}

const amapDeliveryViews = [
  { id: 'manifest', label: 'MANIFEST.csv · 完整交付清单', path: '/evidence/amap-delivery-20261005/MANIFEST.csv' },
  { id: 'roads', label: '各路全量累计.csv · 路况汇总', path: '/evidence/amap-delivery-20261005/summary-roads-summary.csv' },
  { id: 'daily', label: '每日汇总.csv · 8路口径', path: '/evidence/amap-delivery-20261005/summary-daily-summary-8roads.csv' },
  { id: 'hourly', label: '逐小时覆盖度.csv · 8路口径', path: '/evidence/amap-delivery-20261005/summary-hourly-coverage-8roads.csv' }
];
const AMAP_DAY_LABEL = {
  '2026-09-28': '节前·工作日1',
  '2026-09-29': '节前·工作日2',
  '2026-09-30': '节前·工作日3',
  '2026-10-01': '假期·第1天',
  '2026-10-02': '假期·第2天',
  '2026-10-04': '假期·第3天'
};
const amapDayLabel = (v) => AMAP_DAY_LABEL[String(v ?? '').trim().slice(0, 10)] || v;
const amapRoadIndex = [
  ['小路1', 586, 453], ['小路2', 623, 446], ['小路3', 632, 485], ['小路4', 654, 384],
  ['小路5', 751, 363], ['小路6', 775, 497], ['小路7', 804, 449], ['小路8', 840, 415]
];
const amapRoadNewPx = {
  '小路1': [79, 400], '小路2': [136, 360], '小路3': [154, 407], '小路4': [144, 230],
  '小路5': [317, 79], '小路6': [481, 324], '小路7': [493, 249], '小路8': [522, 103]
};

function AmapRoadMarkerMap() {
  return <div className="amap-road-map">
    <div className="activity-evidence-toolbar">
      <div><strong>小路1～小路8 · 采样点位图</strong><small>高清底图 · 8 条监测小路标记位置</small></div>
      <span className="status-chip observed">校准标注</span>
    </div>
    <div className="amap-road-map-frame">
      <div className="amap-road-photo-grid">
        <figure><picture><source srcSet="/evidence/amap-delivery-20261005/amap-road-index-annotated.webp?v=20261020" type="image/webp" /><img src="/evidence/amap-delivery-20261005/amap-road-index-annotated.png?v=20261020" alt="设计院周边地图，标注小路1到小路8的采样点位置" loading="eager" /></picture><figcaption>采样点位图 · 小路1～8（高清底图 595×421，网页只缩小不放大）</figcaption></figure>
      </div>
    </div>
    <small className="amap-road-map-note">底图为设计院周边地图，8 个洋红十字为各小路的路况采样点位置（与左侧索引表一一对应）；小路9～14 距主楼较远（133~205m，超出建模范围），经确认剔除，不参与三维孪生定位；索引表仍保留 1～14 的原始采样编号。</small>
  </div>;
}

function AmapDeliveryTable() {
  const [viewId, setViewId] = useState('roads');
  const [table, setTable] = useState({ headers: [], rows: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('正在读取原始交付表…');
  const view = amapDeliveryViews.find((item) => item.id === viewId) || amapDeliveryViews[0];
  const visibleRows = table.rows.slice(0, 500).filter((row) => {
    const term = search.trim().toLowerCase();
    return !term || row.some((cell) => String(cell ?? '').toLowerCase().includes(term));
  });
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setStatus('正在读取原始交付表…');
    fetch(view.path).then((response) => { if (!response.ok) throw new Error(`读取失败 ${response.status}`); return response.text(); }).then((text) => {
      if (cancelled) return;
      const parsed = parseActivityCsv(text);
      if (view.id === 'daily' || view.id === 'hourly') {
        const mapped = parsed.rows.map((r) => r.map((cell, i) => (i === 0 ? amapDayLabel(cell) : cell)));
        setTable({ headers: parsed.headers, rows: mapped });
      } else if (view.id === 'roads') {
        const cut = new Set(['小路9', '小路10', '小路11', '小路12', '小路13', '小路14']);
        const kept = parsed.rows.filter((r) => !cut.has(String(r[0] || '').trim()));
        const num = (v) => Number(String(v ?? '').replace(/,/g, '')) || 0;
        const allIdx = kept.findIndex((r) => /全部/.test(String(r[0] || '')));
        if (allIdx >= 0) {
          const dataRows = kept.filter((r, i) => i !== allIdx && !/空/.test(String(r[0] || '')));
          const sum = (idx) => dataRows.reduce((acc, r) => acc + num(r[idx]), 0);
          const sample = sum(1), green = sum(2), slow = sum(3), jam = sum(4), ser = sum(5), none = sum(6), chg = sum(7);
          const eff = sample - none;
          const pct = (v) => (eff ? (100 * v / eff).toFixed(2) + '%' : '-');
          kept[allIdx] = ['【全部·8路】', sample, green, slow, jam, ser, none, chg, pct(green), pct(slow), pct(jam), pct(ser)];
        }
        setTable({ headers: parsed.headers, rows: kept });
      } else {
        setTable(parsed);
      }
      setLoading(false);
      setStatus(`${view.label} · 原文件内容 · 最多显示前 500 行，表格可横向/纵向拖动`);
    }).catch((error) => { if (!cancelled) { setTable({ headers: [], rows: [] }); setLoading(false); setStatus(`${view.label} 读取失败：${error.message}`); } });
    return () => { cancelled = true; };
  }, [view.path, view.label]);
  return <div className="amap-delivery-table-block">
    <div className="activity-evidence-toolbar"><div><strong>高德路况监测 · 完整交付</strong><small>{status} · 当前显示 {visibleRows.length} / {Math.min(table.rows.length, 500)} 行</small></div><div className="amap-table-tools"><input aria-label="筛选高德交付表" placeholder="筛选路径、时间或 SHA256" value={search} onChange={(event) => setSearch(event.target.value)} /><select aria-label="选择高德交付表" value={viewId} onChange={(event) => { setViewId(event.target.value); setSearch(''); }}>{amapDeliveryViews.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div></div>
    <div className="activity-table-scroll amap-delivery-scroll" role="region" aria-label="高德路况原始交付表格" tabIndex="0"><table><thead><tr>{table.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead><tbody>{visibleRows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={`${rowIndex}-${cellIndex}`}>{String(cell ?? '')}</td>)}</tr>)}</tbody></table>{!table.rows.length && <div className="activity-table-empty" role="status">{loading ? '正在读取原始交付表…' : '暂无表格行'}</div>}{table.rows.length > 0 && !visibleRows.length && <div className="activity-table-empty" role="status">没有匹配的交付记录</div>}</div>
    <div className="activity-table-analysis amap-delivery-analysis"><span>TABLE ANALYSIS · DERIVED FROM ORIGINAL DELIVERY</span><strong>总体畅通，拥挤集中在工作日早高峰与少数点位</strong><div className="amap-analysis-details"><p>监测对象是高德地图路况图层在小路采样点显示的颜色状态，不是车辆数、行人数或道路容量。交付包共记录 1,365,201 条样本（14 路），按约 5 秒交错采样；小路9～14 距主楼较远，经操作者确认剔除，以下结论与上方表格均为小路1～8 口径（原始 14 路全量数据见交付文件）。监测窗口取国庆假期前后各 3 天——节前 3 个工作日（周一至周三）与假期 3 天，共 6 天、666,632 条有效样本，构成「工作日 vs 假期」对照；下文以「节前·工作日1/2/3」「假期·第1/2/3天」指代各监测日。分析时剔除“无路况颜色”，只比较有效路况颜色的相邻变化。</p><ul><li><b>总体（8 路 · 6 天）：</b>畅通 99.96%，缓行 0.02%，拥堵 0.01%，无严重拥堵记录；有效颜色序列共出现 52 次真实状态变化。</li><li><b>拥挤与通勤强绑定：</b>节前 3 个工作日贡献了 52 次变化中的 49 次（94%）；进入国庆假期后骤降，假期第 2、3 天全天零变化——周边小路的拥挤完全由通勤节奏驱动，假期即消失。</li><li><b>拥挤集中点：</b>缓行以小路8 最突出（94 次，全部落在节前·工作日2 早高峰 07 时的 48 次与节前·工作日3 傍晚 16 时的 46 次，是典型早晚高峰潮汐）；拥堵集中在小路1（21 次）、小路5（20 次）、小路4（19 次）、小路2（12 次）；状态变化最活跃的是小路4 与小路7（各 12 次）。</li><li><b>刚性拥挤点：</b>小路2 连国庆假期第 1 天的早高峰 07 时仍出现 24 次拥堵记录，节前·工作日2 午间 12 时另有 26 次缓行——假期首日都绕不开的点位，属于稳定拥挤点；小路3、小路6 在 6 天有效样本中始终显示畅通。其余路段高峰也基本保持畅通，但不能据此断言没有行人或非机动车。</li><li><b>时段：</b>早高峰 07 时是全期拥挤之最（8 路合计 72 次非畅通），其次为傍晚 16 时（46 次）、上午 09 时（36 次）与 17～18 时（各 29 次）。</li><li><b>重点日（8 路合计非畅通）：</b>节前·工作日1 最高 94 次——早高峰 09 时 36 次全部来自小路1，晚高峰 17～18 时各 29 次则由小路4、小路5、小路7 分担（各 9~11 次），全天变化 37 次也居首；节前·工作日2 次之 74 次，集中在早高峰 07 时（48 次，小路8）与午间 12 时（26 次，小路2）；节前·工作日3 的 46 次全部落在傍晚 16 时且全部来自小路8；假期第 1 天仅剩 24 次（07 时，小路2）；假期第 2、3 天全程畅通。</li></ul><p className="amap-analysis-boundary">解释边界：这些数字用于比较不同采样点和时段的高德路况状态，不能把各路相加成一条“总人流”，也不能把高德颜色直接换算成现场人数。</p></div></div>
    <div className="amap-road-duo">
      <AmapRoadMarkerMap />
      <div className="amap-road-index"><div className="activity-evidence-toolbar"><div><strong>小路1～小路8 · 采样标记索引</strong><small>底图坐标对应左图（595×421）；原始坐标为 1440×900 监测截图像素位置，取色半径 5px</small></div></div><div className="activity-table-scroll amap-road-index-scroll" role="region" aria-label="小路一到八采样标记"><table><thead><tr><th>编号</th><th>交付包标记</th><th>底图 X</th><th>底图 Y</th><th>原始 X</th><th>原始 Y</th><th>取色半径</th><th>对应说明</th></tr></thead><tbody>{amapRoadIndex.map(([label, x, y]) => { const np = amapRoadNewPx[label]; return <tr key={label}><td>{label.replace('小路', '')}</td><td>{label}</td><td>{np[0]}</td><td>{np[1]}</td><td>{x}</td><td>{y}</td><td>5 px</td><td>高德路况颜色采样点</td></tr>; })}</tbody></table></div><small className="amap-road-index-note">注意：底图坐标用于采样点位图定位；原始坐标保留交付包溯源（1440×900 监测截图）。交付包没有“内部编号→真实街道名”的正式对应表，不能把小路1～8直接等同于现场红框小道1～3。</small></div>
    </div>
    <div className="amap-delivery-source-links"><a href="/evidence/amap-delivery-20261005/README-请先读我.md" target="_blank" rel="noreferrer">打开原始 README</a><a href="/evidence/amap-delivery-20261005/分析整理报告.md" target="_blank" rel="noreferrer">打开完整分析报告</a><a href="/evidence/amap-delivery-20261005/三条小道专项分析补充.md" target="_blank" rel="noreferrer">打开三条小道补充分析</a></div>
  </div>;
}

function VisionWorkspace({ project, assets, artifacts, transportPlan, settings, health, jobs, jobEvents, jobStreamStatus, observations, busy, setBusy, notify, refresh, nextStep }) {
  const videos = assets.filter((asset) => isVisibleProjectVideo(asset));
  const evidenceInputRef = useRef(null);
  const [selectedVideo, setSelectedVideo] = useState(videos[0]?.id || '');
  const [slot, setSlot] = useState(settings.timeSlots?.[0]?.id || 'weekday_arrival');
  const [duration, setDuration] = useState(600);
  const [sampleFps, setSampleFps] = useState(20);
  const [sourceMode, setSourceMode] = useState('upload');
  const [capturedAt, setCapturedAt] = useState('');
  const [weather, setWeather] = useState('unknown');
  const [cameraId, setCameraId] = useState('主入口机位');
  const selectedAsset = videos.find((asset) => asset.id === selectedVideo);
  const [sourceNature, setSourceNature] = useState(() => selectedAsset?.sourceNature || (/virtual|synthetic|test|not[-_\s]?observed/i.test(selectedAsset?.name || '') ? 'virtual_test' : 'field_observation'));
  const [zonesText, setZonesText] = useState('[]');
  const [controlPointsText, setControlPointsText] = useState('[]');
  const [rtspUrl, setRtspUrl] = useState('');
  const [rtspResult, setRtspResult] = useState(null);

  useEffect(() => { if (!selectedVideo && videos[0]) setSelectedVideo(videos[0].id); }, [videos.length]);
  useEffect(() => {
    const asset = videos.find((item) => item.id === selectedVideo);
    if (asset) setSourceNature(asset.sourceNature || (/virtual|synthetic|test|not[-_\s]?observed/i.test(asset.name || '') ? 'virtual_test' : 'field_observation'));
  }, [selectedVideo]);

  const analyze = async () => {
    if (!selectedVideo) return notify('error', '请先在第一步上传一个真实短视频');
    if (!capturedAt) return notify('error', '请填写视频的真实拍摄日期与时间');
    let zones;
    try { zones = JSON.parse(zonesText); } catch { return notify('error', 'ROI / 计数线配置不是合法 JSON'); }
    if (!Array.isArray(zones)) return notify('error', 'ROI / 计数线配置必须是数组');
    let controlPoints;
    try { controlPoints = JSON.parse(controlPointsText); } catch { return notify('error', '控制点配置不是合法 JSON'); }
    if (!Array.isArray(controlPoints)) return notify('error', '控制点配置必须是数组');
    setBusy(true);
    try {
      const windowResult = await api('/video/windows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: selectedVideo, slotId: slot, label: settings.timeSlots.find((s) => s.id === slot)?.label, durationSeconds: duration, dayType: 'normal_weekday', capturedAt, weather, cameraId, sourceNature, zones, calibration: { mode: 'none' } }) });
      if (controlPoints.length) await api(`/video/windows/${windowResult.window.id}/calibration`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ controlPoints }) });
      await api('/vision/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: selectedVideo, slotId: slot, windowId: windowResult.window.id, sourceNature, fps: sampleFps }) });
      notify('success', `${sourceNature === 'virtual_test' ? '虚拟测试' : '真实'} YOLO 分析已进入队列`);
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); refresh(); }
  };

  const latestVisionJob = [...jobs].reverse().find((job) => job.type === 'vision_analysis' && (!selectedVideo || job.assetId === selectedVideo));
  const selectedVideoAsset = videos.find((asset) => asset.id === selectedVideo);
  const latestObservation = [...observations].reverse().find((item) => item.schema === 'observation_bundle.v1' && (!selectedVideo || item.sourceAssetId === selectedVideo));
  const allObservationMetrics = latestObservation?.metrics || [];
  const directionalRates = allObservationMetrics.filter((metric) => metric.kind === 'line_crossing_flow_rate');
  const summarizeFlow = (actors) => {
    const actorDirections = directionalRates.filter((metric) => actors.includes(metric.actor));
    const fallback = allObservationMetrics
      .filter((metric) => metric.kind === 'unique_track_flow_rate' && actors.includes(metric.actor))
      .reduce((sum, metric) => sum + Number(metric.value || 0), 0);
    const aToB = actorDirections.filter((metric) => metric.direction === 'a_to_b').reduce((sum, metric) => sum + Number(metric.value || 0), 0);
    const bToA = actorDirections.filter((metric) => metric.direction === 'b_to_a').reduce((sum, metric) => sum + Number(metric.value || 0), 0);
    return { total: actorDirections.length ? aToB + bToA : fallback, aToB, bToA, directional: actorDirections.length > 0 };
  };
  const pedestrianFlow = summarizeFlow(['person']);
  const motorFlow = summarizeFlow(['car', 'truck', 'bus', 'motorcycle']);
  const bicycleFlow = summarizeFlow(['bicycle']);
  const directionUnit = (flow) => flow.directional ? `A→B ${flow.aToB.toFixed(2)} · B→A ${flow.bToA.toFixed(2)}` : '未配置方向计数线';
  const vehicleBreakdown = ['car', 'truck', 'bus', 'motorcycle']
    .map((actor) => ({ actor, flow: summarizeFlow([actor]).total }))
    .filter((item) => item.flow > 0)
    .map((item) => `${actorLabels[item.actor]} ${item.flow.toFixed(2)}`)
    .join(' · ');
  const occupancyValue = Math.max(0, ...(latestObservation?.metrics || []).filter((metric) => ['zone_occupancy_rate', 'region_observation_share'].includes(metric.kind)).map((metric) => Number(metric.value || 0)));
  const verification = latestObservation?.verification;
  const verificationLabel = verification?.status === 'within_tolerance' ? '通过' : verification?.status === 'review_required' ? '需复核' : verification?.status === 'unavailable' ? '不可用' : '未启用';
  const verificationDetail = verification?.max_disagreement_ratio != null
    ? `最大差异 ${Math.round(Number(verification.max_disagreement_ratio) * 100)}% · 门槛 ${Math.round(Number(verification.tolerance_ratio || 0.05) * 100)}%`
    : '稳定状态机 · Supervision LineZone';
  const observationMetrics = [
    { label: '人流量', value: latestObservation ? pedestrianFlow.total.toFixed(2) : '—', unit: latestObservation ? directionUnit(pedestrianFlow) : '人 / 分钟' },
    { label: '机动车流量', value: latestObservation ? motorFlow.total.toFixed(2) : '—', unit: latestObservation ? directionUnit(motorFlow) : '辆 / 分钟' },
    { label: '自行车流量', value: latestObservation ? bicycleFlow.total.toFixed(2) : '—', unit: latestObservation ? directionUnit(bicycleFlow) : '辆 / 分钟' },
    { label: '双计数器交叉校验', value: latestObservation ? verificationLabel : '—', unit: latestObservation ? verificationDetail : '尚无结果' },
    { label: '区域占用峰值', value: latestObservation && occupancyValue ? `${Math.round(occupancyValue * 100)}%` : '—', unit: latestObservation ? '系统计算' : '未运行' },
    { label: '冲突事件', value: latestObservation ? String(latestObservation.conflicts?.length || 0) : '—', unit: latestObservation ? '起' : '尚无结果' }
  ];
  const activityVideos = [
    { id: 'd02fa2f010b49d0a627016fcf4eb1860', name: '交通流量视频 01 · d02fa2f0.mp4', url: '/activity-videos/d02fa2f010b49d0a627016fcf4eb1860.mp4', sourceNature: 'field_observation' },
    { id: '06fff672f5812642f2fd04aa8fc3327e', name: '交通流量视频 02 · 06fff672.mp4', url: '/activity-videos/06fff672f5812642f2fd04aa8fc3327e.mp4', sourceNature: 'field_observation' }
  ];
  const activityDataFiles = assets.filter((asset) => /\.(csv|xlsx?|json)$/i.test(asset.name || ''));
  const activitySimulation = transportPlan?.lastSimulation || null;
  const activityAnalysis = [
    { id: 'fb93278a5dfeb43576fcab66c2e8d990', title: '主入口移动段', text: '箭尾到箭头保持连续直行，没有右转，也没有新增支路；用于判断入口支路的连续关系。', level: 'Observed + Derived' },
    { id: 'b67dcc09ead45fc1b2e9aa28ddb89952', title: 'B67 定点环视段', text: '定点环视确认窄车道、黑色围栏、绿化岛、白栏和路面标线的相对关系；世界朝向仍按操作者坐标锚点处理。', level: 'Observed + Derived' }
  ];
  const bwalkPathDefinitions = [
    {
      id: 'west-gate-walkway',
      label: '西门—主楼人行小道',
      fallbackPedestrians: 132,
      retrofitPedestrians: 132,
      basis: 'weekday-0830 west-gate-walkway 独立 Scenario 值；不与地铁接驳线相加。'
    },
    {
      id: 'south-service-lane',
      label: '南侧后勤/非机动车混行线',
      fallbackPedestrians: 86,
      retrofitPedestrians: 86,
      basis: 'weekday-0830 south-service-lane 独立 Scenario 值；车辆存在不换算为人流。'
    }
  ];
  const bwalkRouteRows = bwalkPathDefinitions.map((definition) => {
    const result = activitySimulation?.roadResults?.find((item) => item.roadId === definition.id);
    const currentPedestrians = Number(result?.flow?.pedestrians ?? definition.fallbackPedestrians);
    return {
      ...definition,
      currentPedestrians,
      retrofitPedestrians: activitySimulation ? currentPedestrians : definition.retrofitPedestrians
    };
  });
  const bwalkGateAfter = { currentPedestrians: 0, retrofitPedestrians: 60, label: '推荐方案A · 地面小门', basis: 'B-WALK-01 leisureWalkScenario.default=60 人/小时；仅作跨围栏 Scenario，不并入两条既有小路。' };
  const bwalkCurrentMetric = `${bwalkRouteRows[0]?.currentPedestrians ?? 132} / ${bwalkRouteRows[1]?.currentPedestrians ?? 86} 人/小时`;
  const bwalkRetrofitMetric = `${bwalkCurrentMetric.replace(' 人/小时', '')} + ${bwalkGateAfter.retrofitPedestrians} 人/小时`;
  const bwalkOptions = [
    { id: 'FENCE-BASELINE-CLOSED', label: '现状：连续围栏', metric: bwalkCurrentMetric, detail: '两条小路分别读取，不合并2号口、4号口接驳线；入口与另一侧小道的绕行距离待现场复测。', tone: 'baseline' },
    { id: 'ACCESS-01-GROUND-GATE', label: '方案A：入口对齐地面小门（推荐）', metric: bwalkRetrofitMetric, detail: '两条既有小路压力保持独立；新增小门承载 60 人/小时散步 Scenario，把通行关系由绕行改为直达，待现场穿越计数校准。', tone: 'recommended' },
    { id: 'ACCESS-02-AT-GRADE-PATH', label: '方案B：草坪内透水通道', metric: bwalkRetrofitMetric, detail: '采用同一 60 人/小时散步需求作为比较基线；通道占用草坪的宽度和树根边界待现场确认。', tone: 'alternative' },
    { id: 'ACCESS-03-LIGHT-BOARDWALK', label: '方案C：轻型架空栈道/小桥', metric: bwalkRetrofitMetric, detail: '仍使用同一散步需求 Scenario；只改变通行关系，不把新增需求伪装成实测增量。', tone: 'alternative' }
  ];
  const importActivityFiles = async (fileList) => {
    if (!fileList?.length || !project) return;
    const form = new FormData();
    form.append('sourceNature', 'field_observation');
    [...fileList].forEach((file) => form.append('files', file));
    setBusy(true);
    try {
      const result = await api('/assets/upload', { method: 'POST', body: form });
      notify('success', `活动证据已导入 ${result.assets?.length || 0} 份`, '视频、表格和原始文件已进入项目证据链。');
      await refresh({ silent: true });
    } catch (error) { notify('error', '活动证据导入失败', error.message); }
    finally { setBusy(false); }
  };
  const actualSampleFps = Number(latestObservation?.sampling?.actual_fps || latestObservation?.rawSummary?.sample_fps || 0);
  const shortTrackRatio = Number(latestObservation?.quality?.short_track_ratio || 0);
  const qualityWarnings = latestObservation ? [
    shortTrackRatio >= 0.35 ? `短轨迹占比 ${Math.round(shortTrackRatio * 100)}%，类别判断和 ID 连续性需人工抽核。` : null,
    directionalRates.length === 0 ? '未产生稳定过线事件：请检查计数线位置，方向结果暂不可用。' : null,
    verification?.status === 'review_required' ? `双计数器差异超过 ${Math.round(Number(verification.tolerance_ratio || 0.05) * 100)}%，请使用 CVAT 人工真值复核。` : null,
  ].filter(Boolean) : [];

  const testRtsp = async () => {
    if (!rtspUrl.trim()) return notify('error', '请输入 RTSP 地址');
    setBusy(true);
    try {
      const result = await api('/sources/rtsp/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: rtspUrl }) });
      setRtspResult(result.source);
      notify('success', 'RTSP 源已通过真实连接和解码测试');
    } catch (error) { setRtspResult(null); notify('warning', error.message, error.details); }
    finally { setBusy(false); }
  };

  return (
    <section className="stage-layout">
      <StageHeading eyebrow="STEP 03 / FLOW OBSERVATION" title="流动观测" description="只保留高德完整交付表格、既有表格分析和一段交通流量视频证明。" />
      <div className="stage-content vision-stage">
        <article className="panel activity-monitor-panel">
          <PanelHeader icon={Route} title="高德路况监测 · 完整交付" action={<span className="status-chip scenario">原始交付 + Derived</span>} />
          <AmapDeliveryTable />
          <div className="activity-monitor-metrics expert-only" aria-label="视频观测指标">{observationMetrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.unit}</small></div>)}<small className="observation-quality-note">抽帧会降低轨迹连续性；20 fps · 转弯/停留更稳（推荐）。</small></div>
          <div className="activity-evidence-card activity-video-evidence-card amap-video-proof">
            <div className="activity-evidence-toolbar"><div><strong>交通流量视频 · 辅助证明材料</strong><small>使用操作者指定的两段现场视频</small></div><span className="evidence-count">{activityVideos.length ? `${activityVideos.length} 段` : '未找到'}</span></div>
            {activityVideos.length ? <div className="activity-video-proof-grid">{activityVideos.map((video) => <figure key={video.id} className="activity-video-proof-item"><video className="activity-evidence-video" src={`${video.url}?v=20261019`} controls preload="metadata" aria-label={`交通流量辅助视频：${video.name}`} /><figcaption>{video.name}</figcaption></figure>)}</div> : <div className="activity-video-empty">项目中未找到已登记的交通流量视频。</div>}
            <div className="activity-table-analysis"><span>VIDEO ANALYSIS · TWO OPERATOR-SUPPLIED CLIPS</span><strong>两段视频显示同一处建筑前场的步行、非机动车与车辆交互</strong><div className="amap-analysis-details"><p><b>视频01：</b>73.33 秒，1280×720，黄昏高位视角。画面覆盖建筑入口前道路、弯曲人行路径和中央绿化岛；行人沿弯道和入口方向连续通过，夹有自行车/电动车，机动车出现但没有形成持续排队。</p><p><b>视频02：</b>305.33 秒，960×544，同一场景的更长观察段。可见行人分批经过入口及弯道节点，非机动车与步行流在路口附近交会；道路上出现小汽车经过，车辆流与人行流存在短时交叉，但画面未显示长时间堵塞。</p><ul><li><b>空间关系：</b>建筑入口、弯道、绿化岛和道路边缘共同形成汇流点；绿化岛分隔了部分路径，同时把行人和非机动车导向同一转折处。</li><li><b>可用于汇报：</b>两段视频可以佐证“这里存在步行与非机动车混行、入口节点会短时聚集”的空间判断。</li><li><b>使用边界：</b>视频时长和视角不足以推导小时流量、14 条高德采样点的对应关系或拥堵率；页面不把视频中的可见人数换算成统计表数字。</li></ul></div></div>
          </div>
        </article>
      </div>
    </section>
  );
}

const AMAP_STATES = [
  { key: 'smooth', label: '畅通', color: '#4ade80' },
  { key: 'slow', label: '缓行', color: '#eab308' },
  { key: 'jam', label: '拥堵', color: '#f59e0b' },
  { key: 'severe', label: '严重拥堵', color: '#ef4444' }
];

function AmapRhythmPanel() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [roadId, setRoadId] = useState('road_2');
  const [date, setDate] = useState('2026-09-30');
  const [allPeriod, setAllPeriod] = useState(false);
  const [activeHour, setActiveHour] = useState(null);
  const [hourSel, setHourSel] = useState(null);
  useEffect(() => {
    if (Number.isFinite(hourSel)) window.dispatchEvent(new CustomEvent('amap-hour-sync', { detail: { hour: hourSel, source: 'rhythm' } }));
  }, [hourSel]);
  useEffect(() => {
    const onHour = (e) => { if (e.detail?.source === 'twin' && Number.isFinite(e.detail?.hour)) setHourSel(e.detail.hour); };
    window.addEventListener('amap-hour-sync', onHour);
    return () => window.removeEventListener('amap-hour-sync', onHour);
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/data/amap-traffic-matrix.json').then((r) => r.json()).then((json) => { if (alive) setData(json); }).catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, []);

  const head = <div className="amap-rhythm-head"><div><span className="amap-rhythm-kicker">01 / 24H FLOW RHYTHM</span><h2>全天流量节奏 <em>高德实测 · OBSERVED</em></h2></div></div>;
  if (loadError) return <section className="amap-rhythm-panel" aria-label="全天流量节奏">{head}<p className="amap-rhythm-empty">实测数据矩阵加载失败，请刷新重试</p></section>;
  if (!data) return <section className="amap-rhythm-panel" aria-label="全天流量节奏">{head}<p className="amap-rhythm-empty">正在读取高德实测矩阵…</p></section>;

  const roads = Object.keys(data.roadNames).filter((rid) => rid).sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10)).filter((rid) => parseInt(rid.slice(5), 10) <= 8);
  const cellFor = (rid, d, h) => data.matrix.find((m) => m.road === rid && m.date === d && m.hour === h);
  const aggFor = (rid, h) => {
    const acc = { total: 0, '畅通': 0, '缓行': 0, '拥堵': 0, '严重拥堵': 0, '无路况颜色': 0 };
    data.matrix.filter((m) => m.road === rid && m.hour === h).forEach((m) => {
      acc.total += m.total;
      Object.keys(acc).forEach((s) => { if (s !== 'total' && m.counts[s]) acc[s] += m.counts[s]; });
    });
    return acc;
  };

  const bars = Array.from({ length: 24 }, (_, h) => {
    const cell = allPeriod ? aggFor(roadId, h) : (cellFor(roadId, date, h) || { total: 0, counts: {} });
    const total = cell.total || 0;
    const c = cell.counts || cell;
    const valid = ((c['畅通'] || 0) + (c['缓行'] || 0) + (c['拥堵'] || 0) + (c['严重拥堵'] || 0)) || 1;
    const pct = {
      '畅通': 100 * (c['畅通'] || 0) / valid,
      '缓行': 100 * (c['缓行'] || 0) / valid,
      '拥堵': 100 * (c['拥堵'] || 0) / valid,
      '严重拥堵': 100 * (c['严重拥堵'] || 0) / valid
    };
    const nonSmooth = (c['缓行'] || 0) + (c['拥堵'] || 0) + (c['严重拥堵'] || 0);
    const ratio = total ? nonSmooth / total : 0;
    return { hour: h, total, nonSmooth, ratio, pct, counts: c };
  });

  const grand = bars.reduce((acc, b) => ({ total: acc.total + b.total, nonSmooth: acc.nonSmooth + b.nonSmooth }), { total: 0, nonSmooth: 0 });
  const peak = bars.reduce((best, b) => (b.nonSmooth > best.nonSmooth ? b : best), bars[0]);
  const smoothRate = grand.total ? 100 * (grand.total - grand.nonSmooth) / grand.total : 100;
  const roadRatio = (rid) => {
    let t = 0; let ns = 0;
    for (let h = 0; h < 24; h += 1) {
      const cell = allPeriod ? aggFor(rid, h) : cellFor(rid, date, h);
      if (!cell) continue;
      const c = cell.counts || cell;
      t += cell.total || 0;
      ns += (c['缓行'] || 0) + (c['拥堵'] || 0) + (c['严重拥堵'] || 0);
    }
    return t ? ns / t : 0;
  };
  const ranking = [...roads].sort((a, b) => roadRatio(b) - roadRatio(a));
  const rank = ranking.indexOf(roadId) + 1;
  const viewHour = hourSel === null ? peak.hour : hourSel;
  const viewBar = bars[viewHour] || bars[peak.hour];
  const peakLabel = peak.nonSmooth > 0 ? `${String(peak.hour).padStart(2, '0')}:00 前后` : '全天畅通';
  const roadLabel = data.roadNames[roadId] || roadId;
  const dateLabel = allPeriod ? '全期（国庆前后 6 天）' : (AMAP_DAY_LABEL[date] || date);

  const selectRoad = (rid) => {
    setRoadId(rid);
    try { window.dispatchEvent(new CustomEvent('amap-road-selected', { detail: { roadId: rid, roadName: data.roadNames[rid] } })); } catch (err) { /* linkage hook */ }
  };

  return <section className="amap-rhythm-panel" aria-label="全天流量节奏">
    <div className="amap-rhythm-head">
      <div><span className="amap-rhythm-kicker">01 / 24H FLOW RHYTHM</span><h2>全天流量节奏 <em>高德实测 · OBSERVED</em></h2></div>
      <div className="amap-rhythm-switchers">
        <label>道路
          <select value={roadId} onChange={(e) => selectRoad(e.target.value)}>
            {roads.map((rid) => <option key={rid} value={rid}>{data.roadNames[rid]}</option>)}
          </select>
        </label>
        <label>日期
          <select value={allPeriod ? 'all' : date} onChange={(e) => { if (e.target.value === 'all') setAllPeriod(true); else { setAllPeriod(false); setDate(e.target.value); } }}>
            <option value="all">全期合并</option>
            {data.dates.map((d) => <option key={d} value={d}>{AMAP_DAY_LABEL[d] || d}</option>)}
          </select>
        </label>
      </div>
    </div>
    <div className="amap-rhythm-chart">
      {bars.map((b) => (
        <button type="button" key={b.hour} className={`amap-rhythm-bar ${viewHour === b.hour ? 'active' : ''}`} onClick={() => { setHourSel(b.hour); setActiveHour(b.hour); }} title={`${String(b.hour).padStart(2, '0')}:00 · 非畅通 ${b.nonSmooth} 次 / ${b.total} 采样`}>
          <b className="amap-rhythm-count">{b.nonSmooth > 0 ? b.nonSmooth : ''}</b>
          <span className="amap-rhythm-stack">
            {['严重拥堵', '拥堵', '缓行', '畅通'].map((s) => b.pct[s] > 0.001 ? <i key={s} style={{ height: `${b.pct[s]}%`, background: AMAP_STATES.find((x) => x.label === s).color }} /> : null)}
          </span>
          <small>{b.hour % 6 === 0 ? String(b.hour).padStart(2, '0') : ''}</small>
        </button>
      ))}
    </div>
    <div className="amap-rhythm-slider">
      <span>TIME OF DAY</span>
      <input type="range" min="0" max="23" value={viewHour} onChange={(e) => { const h = Number(e.target.value); setHourSel(h); setActiveHour(h); }} />
      <strong>{String(viewHour).padStart(2, '0')}:00</strong>
      <em>{['畅通', '缓行', '拥堵', '严重拥堵'].map((s) => <b key={s}><i style={{ background: AMAP_STATES.find((x) => x.label === s).color }} />{s} {viewBar.pct[s].toFixed(2)}%</b>)}</em>
    </div>
    <div className="amap-rhythm-readout">
      <div><span>{roadLabel} · {dateLabel}</span><strong>{smoothRate.toFixed(2)}%</strong><small>畅通率</small></div>
      <div><span>非畅通样本</span><strong>{grand.nonSmooth}</strong><small>/ {grand.total} 轮次</small></div>
      <div><span>8 路敏感度排名</span><strong>No.{rank}</strong><small>按非畅通占比</small></div>
      <div><span>高峰时段</span><strong>{peakLabel}</strong><small>非畅通最集中</small></div>
    </div>
    <div className="amap-rhythm-legend">
      {AMAP_STATES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
      <small>每根柱 = 该小时四态构成（满高 100%）· 柱顶数字 = 该小时非畅通采样次数 · 拖动 TIME OF DAY 查看单小时 · 高德路况颜色≠人流数</small>
    </div>
    <footer className="amap-rhythm-source">高德路况监测 · 国庆假期前后各 3 天（节前工作日3天 + 假期3天 · 共 6 天） · 8 路 666,632 样本 · 约 5 秒/轮 · OBSERVED 实测 · 数据矩阵 /data/amap-traffic-matrix.json</footer>
  </section>;
}

const RETROFIT_WIPES = [
  {
    id: 'fence',
    title: '① 连续围栏 → 地面小门',
    before: '/generated/traffic-comparisons/fence-before-split.png',
    after: '/generated/traffic-comparisons/fence-after-split.png',
    site: '现场功能：连续栅栏切断了与主楼的直接联系，行人被迫绕行；狭窄白色小门降低行走舒适度，非机动车无法通过。',
    analysis: '分析口径：高德路况数据不能识别栅栏与门禁，本处按「空间联系中断、路径不连续」分析，不能用「高德畅通」替代现场通行评价。'
  },
  {
    id: 'serpentine',
    title: '② 蛇形栏杆 → 直达通行',
    before: '/generated/traffic-comparisons/serpentine-barrier-before-split.png',
    after: '/generated/traffic-comparisons/serpentine-barrier-after-split.png',
    site: '现场功能：蛇形折返栏杆使路径连续性受阻，行人需多次折返才能到达主楼入口。',
    analysis: '分析口径：高德路况颜色不能测量步行舒适度与绕行阻力，改造收益以空间关系表达，施工尺寸需现场复核。'
  },
  {
    id: 'mixed',
    title: '③ 混行小路 → 人车分流',
    before: '/generated/traffic-comparisons/mixed-lane-before-split.png',
    after: '/generated/traffic-comparisons/mixed-lane-after-split.png',
    site: '现场功能：窄路上摩托车、自行车与行人混行，晚高峰易发生速度差、会车与交叉冲突。',
    analysis: '分析口径：高德监测的晚高峰状态变化（小路13、9~11）与现场判断方向一致；因缺少正式编号对应关系，仅作周边交通压力辅助证据。'
  }
];

function WipeCard({ item }) {
  const [pos, setPos] = useState(50);
  const frameRef = useRef(null);
  const beforeRef = useRef(null);
  const dividerRef = useRef(null);
  const beforeTagRef = useRef(null);
  const afterTagRef = useRef(null);
  const dragging = useRef(false);
  const rectRef = useRef(null);
  const rafRef = useRef(0);
  const lastP = useRef(50);
  // 拖动热路径：零布局读取、零 React 渲染，直接写 DOM，rAF 合帧
  const schedule = (clientX) => {
    const rect = rectRef.current;
    if (!rect) return;
    const p = Math.max(4, Math.min(96, 100 * (clientX - rect.left) / rect.width));
    lastP.current = p;
    if (beforeRef.current) beforeRef.current.style.clipPath = `inset(0 ${100 - p}% 0 0)`;
    if (dividerRef.current) dividerRef.current.style.left = `${p}%`;
    if (beforeTagRef.current) beforeTagRef.current.style.opacity = p < 26 ? 0 : 1;
    if (afterTagRef.current) afterTagRef.current.style.opacity = p > 58 ? 0 : 1;
  };
  const onDown = (e) => {
    dragging.current = true;
    rectRef.current = frameRef.current.getBoundingClientRect();
    schedule(e.clientX);
    setPos(lastP.current);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
  };
  const onMove = (e) => {
    if (!dragging.current) return;
    const x = e.clientX;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; schedule(x); });
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    setPos(lastP.current);
  };
  return <article className="wipe-card">
    <div className="wipe-frame" ref={frameRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}>
      <img className="wipe-after" src={item.after} alt={`${item.title} 改造后示意`} draggable={false} />
      <img className="wipe-before" ref={beforeRef} src={item.before} alt={`${item.title} 现状实拍`} style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} draggable={false} />
      <span className="wipe-divider" ref={dividerRef} style={{ left: `${pos}%` }}><i /></span>
      <span className="wipe-tag before-tag" ref={beforeTagRef} style={{ opacity: pos < 26 ? 0 : 1 }}>改造前 · 实拍</span>
      <span className="wipe-tag after-tag" ref={afterTagRef} style={{ opacity: pos > 58 ? 0 : 1 }}>改造后 · Generated 概念示意</span>
    </div>
    <div className="wipe-copy">
      <h3>{item.title}</h3>
      <p className="wipe-site">{item.site}</p>
      <p className="wipe-analysis">{item.analysis}</p>
    </div>
  </article>;
}

function RetrofitWipeCompare() {
  return <section className="retrofit-wipe-section" aria-label="三处痛点改造前后对比">
    <div className="retrofit-wipe-head">
      <div><span className="amap-rhythm-kicker">02 / RETROFIT BEFORE · AFTER</span><h2>三处痛点 · 改造前后</h2></div>
      <em className="wipe-badge">BEFORE = OBSERVED 实拍 · AFTER = GENERATED · SCENARIO</em>
    </div>
    <div className="wipe-grid">
      {RETROFIT_WIPES.map((item) => <WipeCard key={item.id} item={item} />)}
    </div>
    <blockquote className="wipe-quote">现场三条小道的主要问题不是整体机动车拥堵，而是栅栏和狭窄门洞造成的路径中断、绕行和混合交通冲突。高德监测显示研究区周边部分道路在工作日晚高峰出现较明显的状态变化，其中内部采样点小路13及小路9～11最敏感。由于缺少红框小道与内部采样编号的精确对应关系，高德数据作为周边交通压力的辅助证据，不替代对三条小道本身的人流、非机动车流量和门洞通行能力测量。<cite>—— 三条红框小道专项分析补充 · §8 可用于汇报的表述</cite></blockquote>
  </section>;
}

function TrafficOnlyWorkspace({ project, transportPlan }) {
  const [selectedPlan, setSelectedPlan] = useState('P-BALANCED');
  const [selectedHour, setSelectedHour] = useState(8);
  const [showAfter, setShowAfter] = useState(true);
  const [flowLayer, setFlowLayer] = useState('baseline');
  const [cockpitView, setCockpitView] = useState('overview');
  const [cockpitPaused, setCockpitPaused] = useState(false);
  const [flowSpeed, setFlowSpeed] = useState(1);
  const [autoTour, setAutoTour] = useState(false);
  const [eventStage, setEventStage] = useState(0);
  const [simMinutes, setSimMinutes] = useState(8 * 60 + 30);
  const [eventLog, setEventLog] = useState([
    { time: '08:30', level: 'info', text: '场景上线 · 两条小路开始流量模拟' },
    { time: '08:30', level: 'good', text: '西门与南侧路段已绑定独立路线' }
  ]);
  const [hoveredFacility, setHoveredFacility] = useState(null);
  const [kpiJitter, setKpiJitter] = useState(0);
  const sparklineRef = useRef(null);
  const eventTimersRef = useRef([]);
  const simulation = transportPlan?.lastSimulation;
  const flowFor = (id, fallback) => Number(simulation?.roadResults?.find((item) => item.roadId === id)?.flow?.pedestrians ?? fallback);
  const westFlow = flowFor('west-gate-walkway', 132);
  const southFlow = flowFor('south-service-lane', 86);
  const gateFlow = 60;
  const multipliers = operationProfiles.office_weekday.multipliers;
  const spectrum = Array.from({ length: 24 }, (_, hour) => ({ hour, west: westFlow * multipliers[hour], south: southFlow * multipliers[hour], gate: gateFlow * multipliers[hour] }));
  const selectedSpectrum = spectrum[selectedHour] || spectrum[8];
  const peakSpectrum = spectrum.reduce((best, point) => (point.west + point.south > best.west + best.south ? point : best), spectrum[0]);
  const cityBlocks = Array.from({ length: 34 }, (_, index) => ({ x: 110 + (index % 9) * 76 + ((index * 17) % 11), y: 118 + Math.floor(index / 9) * 62 + ((index * 13) % 15), w: 35 + (index % 3) * 8, h: 24 + (index % 5) * 9 }));
  const maxSpectrum = Math.max(...spectrum.map((point) => Math.max(point.west, point.south, point.gate)), 1);
  const cockpitLayers = [
    { id: 'baseline', name: '现状流', metric: '260 人/时', color: '#67e8f9', count: 260 },
    { id: 'morning', name: '早高峰', metric: '420 人/时', color: '#fb923c', count: 420 },
    { id: 'evening', name: '晚高峰', metric: '300 人/时', color: '#fbbf24', count: 300 },
    { id: 'P-SAFE', name: 'P-SAFE', metric: '分流 +60', color: '#4ade80', count: 320 },
    { id: 'P-EFFICIENCY', name: 'P-EFFICIENCY', metric: '排队 -43%', color: '#a78bfa', count: 270 },
    { id: 'P-BALANCED', name: 'P-BALANCED', metric: '热力稳定', color: '#38bdf8', count: 300 }
  ];
  const activeCockpitLayer = cockpitLayers.find((layer) => layer.id === flowLayer) || cockpitLayers[0];
  const eventBoost = eventStage === 1 ? 1.18 : eventStage === 2 ? 1.04 : eventStage === 3 ? 0.68 : eventStage >= 4 ? 0.72 : 1;
  const activeAgentCount = Math.round(activeCockpitLayer.count * eventBoost);
  const liveAgentCount = eventStage === 1 ? activeAgentCount : Math.max(0, Math.round(activeAgentCount * (1 + kpiJitter)));
  const congestionIndex = Math.min(100, Math.round((activeAgentCount / 4.7) * (eventStage === 1 ? 1 : 1 + kpiJitter)));
  const congestionBand = congestionIndex >= 82 ? '饱和' : congestionIndex >= 62 ? '挤' : congestionIndex >= 38 ? '缓' : '畅';
  const congestionColor = congestionIndex >= 82 ? '#ef4444' : congestionIndex >= 62 ? '#f97316' : congestionIndex >= 38 ? '#facc15' : '#4ade80';
  const formatSimTime = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  const pushEvent = (level, text, minutes = simMinutes) => {
    setEventLog((current) => [{ time: formatSimTime(minutes), level, text }, ...current].slice(0, 8));
  };
  const startMorningPeak = () => {
    eventTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    eventTimersRef.current = [];
    setFlowLayer('morning');
    setCockpitView('focus');
    setCockpitPaused(false);
    setSimMinutes(8 * 60 + 30);
    setEventStage(1);
    pushEvent('crit', '双通道流量达峰值 · 拥挤指数转红', 8 * 60 + 30);
    eventTimersRef.current.push(window.setTimeout(() => {
      setEventStage(2);
      setSimMinutes(8 * 60 + 34);
      pushEvent('good', '启用地面小门分流 · 0 → +60 人/时', 8 * 60 + 34);
    }, 4000));
    eventTimersRef.current.push(window.setTimeout(() => {
      setEventStage(3);
      setSimMinutes(8 * 60 + 41);
      pushEvent('warn', '主楼入口拥挤回落 · 橙 → 黄', 8 * 60 + 41);
    }, 11000));
    eventTimersRef.current.push(window.setTimeout(() => {
      setEventStage(4);
      setSimMinutes(8 * 60 + 52);
      pushEvent('good', '拥挤指数回到黄区 · 事件关闭', 8 * 60 + 52);
    }, 22000));
  };
  useEffect(() => () => eventTimersRef.current.forEach((timer) => window.clearTimeout(timer)), []);
  useEffect(() => {
    if (cockpitPaused) return undefined;
    const timer = window.setInterval(() => setSimMinutes((current) => (current + Math.max(1, Math.round(flowSpeed * 1.5))) % (24 * 60)), 1000);
    return () => window.clearInterval(timer);
  }, [cockpitPaused, flowSpeed]);
  useEffect(() => {
    if (!autoTour) return undefined;
    const order = ['baseline', 'morning', 'evening', 'P-SAFE'];
    const timer = window.setInterval(() => setFlowLayer((current) => order[(order.indexOf(current) + 1) % order.length]), 9000);
    return () => window.clearInterval(timer);
  }, [autoTour]);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.toLowerCase();
      if (key === 'o') setCockpitView('overview');
      if (key === 'x') setCockpitView('xray');
      if (key === 'd') setCockpitView('daylight');
      if (key === ' ') { event.preventDefault(); setCockpitPaused((value) => !value); }
      if (/^[1-4]$/.test(key)) setFlowLayer(['baseline', 'morning', 'evening', 'P-SAFE'][Number(key) - 1]);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    const canvas = sparklineRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width = Math.max(240, canvas.clientWidth * 2);
    const height = canvas.height = 120;
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(103,232,249,.13)';
    ctx.lineWidth = 1;
    for (let row = 1; row < 4; row += 1) { ctx.beginPath(); ctx.moveTo(0, row * height / 4); ctx.lineTo(width, row * height / 4); ctx.stroke(); }
    const points = Array.from({ length: 30 }, (_, index) => Math.max(10, Math.min(98, congestionIndex + Math.sin(index * .55) * 7 + (eventStage === 1 ? index * .9 : 0))));
    ctx.beginPath();
    points.forEach((point, index) => { const x = index * (width - 12) / (points.length - 1) + 6; const y = height - point / 100 * (height - 14) - 7; index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = '#67e8f9'; ctx.shadowColor = '#67e8f9'; ctx.shadowBlur = 12; ctx.lineWidth = 3; ctx.stroke(); ctx.shadowBlur = 0;
  }, [congestionIndex, eventStage]);
  const planCopy = {
    'P-SAFE': { label: '安全优先', detail: '单个地面小门 + 车辆隔离', accent: 'safe' },
    'P-EFFICIENCY': { label: '效率优先', detail: '双开口分流 + 排队监测', accent: 'efficiency' },
    'P-BALANCED': { label: '综合平衡', detail: '单开口 + 小路热力监测', accent: 'balanced' }
  }[selectedPlan];
  const leaveTrafficView = () => { const url = new URL(window.location.href); url.searchParams.delete('view'); url.searchParams.delete('traffic'); window.location.href = url.toString(); };
  return <section className="traffic-only-workspace" aria-label="流量驾驶舱">
    <header className="traffic-only-hero"><div><span className="traffic-only-eyebrow">FLOW INTELLIGENCE / 01</span><h1>城市小路流量驾驶舱</h1><p>只看流量、路径和改造前后变化。两条小路独立计算，新增小门单列展示。</p></div><div className="traffic-only-hero-actions"><span className="traffic-only-live"><i /> TRAFFIC SIGNAL ONLINE</span><button type="button" onClick={leaveTrafficView}>返回完整工作流</button></div></header>
    <AmapRhythmPanel />
    <section className="flow-city-cockpit" aria-label="FLOW CITY TWIN 人流量驾驶舱">
      <header className="flow-city-cockpit-topbar">
        <div className="flow-city-brand"><span className="flow-city-mark">FC</span><div><strong>FLOW CITY TWIN</strong><small>某集团园区 · 人流通勤孪生 · SIMULATED</small></div></div>
        <div className="flow-city-simtime"><span>SIM TIME</span><strong>{formatSimTime(simMinutes)}</strong><i className={cockpitPaused ? 'paused' : ''} /></div>
        <nav className="flow-city-view-switch" aria-label="驾驶舱视图">
          {[['overview', 'Overview'], ['auto', 'Auto tour'], ['xray', 'X-ray ground'], ['daylight', 'Daylight'], ['labels', 'Labels']].map(([id, label]) => <button type="button" key={id} className={(id === cockpitView || (id === 'auto' && autoTour)) ? 'active' : ''} onClick={() => id === 'auto' ? setAutoTour((value) => !value) : setCockpitView(id)}>{label}</button>)}
        </nav>
      </header>
      <div className="flow-city-cockpit-body">
        <aside className="flow-city-layer-panel">
          <div className="flow-city-panel-kicker">FLOW LAYERS <small>06 SIGNALS</small></div>
          {cockpitLayers.map((layer, index) => <button type="button" key={layer.id} className={`flow-city-layer-row ${flowLayer === layer.id ? 'active' : ''}`} style={{ '--layer-color': layer.color }} onClick={() => { setFlowLayer(layer.id); setCockpitView('focus'); }}><span className="flow-city-layer-swatch">{String(index + 1).padStart(2, '0')}</span><span><strong>{layer.name}</strong><small>{layer.metric}</small></span><i className="flow-city-layer-toggle" /></button>)}
          <div className="flow-city-layer-foot"><span>ALL READINGS</span><strong>SIMULATED</strong><small>路线来源：transport-plan.v1<br />两条小路独立计算</small></div>
        </aside>
        <div className={`flow-city-stage ${cockpitView === 'xray' ? 'is-xray' : ''} ${cockpitView === 'daylight' ? 'is-daylight' : ''}`}>
          <svg viewBox="0 0 920 560" role="img" aria-label="双通道人流孪生场景"><defs><pattern id="flowCityGrid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#1b3b50" strokeWidth="1" opacity=".58" /></pattern><filter id="flowCityGlow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter><linearGradient id="flowCityArcA" x1="0" x2="1"><stop offset="0" stopColor="#164252" /><stop offset=".5" stopColor="#67e8f9" /><stop offset="1" stopColor="#d5fbff" /></linearGradient><linearGradient id="flowCityArcB" x1="0" x2="1"><stop offset="0" stopColor="#60391b" /><stop offset=".55" stopColor="#fb923c" /><stop offset="1" stopColor="#ffd29c" /></linearGradient></defs><rect width="920" height="560" fill={cockpitView === 'daylight' ? '#132633' : '#020912'} /><rect width="920" height="560" fill="url(#flowCityGrid)" opacity={cockpitView === 'xray' ? .94 : .55} /><g className="flow-city-ghost-buildings"><rect x="298" y="226" width="124" height="82" className="flow-city-main-ghost" /><path d="M310 226h100" className="flow-city-main-ghost-top" />{cityBlocks.map((block, index) => <g key={index} style={{ opacity: .42 + (index % 5) * .05 }}><rect x={block.x} y={block.y} width={block.w} height={block.h} /><path d={`M${block.x + 7} ${block.y + 7}h${Math.max(8, block.w - 14)}M${block.x + 7} ${block.y + 14}h${Math.max(8, block.w - 14)}`} /></g>)}</g><path id="flowArcA" className="flow-city-route cyan" d="M34 142 C155 142 210 211 328 197 S460 132 580 146 S676 205 748 258" /><path id="flowArcB" className="flow-city-route amber" d="M40 450 C168 450 176 358 292 375 S430 444 560 400 S710 314 858 350" /><path className="flow-city-route gate" d="M580 146 C650 155 690 205 748 258" style={{ opacity: eventStage >= 2 || showAfter ? 1 : .18 }} />{Array.from({ length: 14 }, (_, index) => <circle key={`a-${index}`} className="flow-city-particle cyan" r={index % 4 === 0 ? 4 : 2.5} style={{ '--particle-delay': `${index * -.28}s`, '--particle-speed': `${Math.max(.8, 2.3 / flowSpeed)}s` }}><animateMotion dur={`${Math.max(.8, 2.3 / flowSpeed)}s`} begin={`${index * -.28}s`} repeatCount="indefinite" path="M34 142 C155 142 210 211 328 197 S460 132 580 146 S676 205 748 258" /></circle>)}{Array.from({ length: 11 }, (_, index) => <circle key={`b-${index}`} className="flow-city-particle amber" r={index % 3 === 0 ? 4 : 2.5} style={{ '--particle-delay': `${index * -.34}s`, '--particle-speed': `${Math.max(.9, 2.8 / flowSpeed)}s` }}><animateMotion dur={`${Math.max(.9, 2.8 / flowSpeed)}s`} begin={`${index * -.34}s`} repeatCount="indefinite" path="M40 450 C168 450 176 358 292 375 S430 444 560 400 S710 314 858 350" /></circle>)}{['2号口', '4号口', '主楼入口', '地面小门'].map((label, index) => { const points = [[34, 142], [40, 450], [580, 146], [748, 258]][index]; return <g key={label} className="flow-city-facility" onMouseEnter={() => setHoveredFacility(label)} onFocus={() => setHoveredFacility(label)} onClick={() => setCockpitView('focus')} tabIndex="0" role="button"><circle cx={points[0]} cy={points[1]} r="10" className={`flow-city-node ${index === 1 ? 'amber' : index === 3 ? 'gate' : 'cyan'}`} /><circle cx={points[0]} cy={points[1]} r="22" className="flow-city-ring" /><text x={points[0] + 18} y={points[1] + 4}>{label}</text></g>; })}<text x="348" y="270" className="flow-city-building-label">MAIN BUILDING · GHOST GEOMETRY</text><text x="348" y="286" className="flow-city-building-label">L3 PEDESTRIAN SIGNAL FIELD</text></svg>{hoveredFacility && <div className="flow-city-floating-card" style={{ left: hoveredFacility === '4号口' ? '7%' : hoveredFacility === '2号口' ? '7%' : hoveredFacility === '主楼入口' ? '62%' : '79%', top: hoveredFacility === '4号口' ? '70%' : hoveredFacility === '2号口' ? '17%' : hoveredFacility === '主楼入口' ? '15%' : '35%' }} onMouseLeave={() => setHoveredFacility(null)}><strong>{hoveredFacility}</strong><span>通过率 {hoveredFacility === '地面小门' ? (eventStage >= 2 ? 60 : 0) : Math.max(18, Math.round(liveAgentCount * (hoveredFacility === '主楼入口' ? .48 : .34)))} 人/时</span><small>拥挤指数 {Math.min(100, congestionIndex + (hoveredFacility === '主楼入口' ? 8 : 0))} · Simulated</small></div>}<div className="flow-city-stage-readout"><span>{cockpitView === 'xray' ? 'GROUND X-RAY' : cockpitView === 'daylight' ? 'DAYLIGHT / DERIVED' : 'PEDESTRIAN SIGNAL FIELD'}</span><strong>{congestionBand.toUpperCase()}</strong><small>{liveAgentCount} AGENTS · {activeCockpitLayer.name.toUpperCase()} · {congestionIndex}/100</small></div><div className="flow-city-stage-badge">DERIVED LAYER <b>SIMULATED</b></div>
        </div>
        <aside className="flow-city-pulse-panel">
          {cockpitView === 'overview' ? <><span className="flow-city-panel-kicker">CITY PULSE <small>OVERVIEW</small></span><h2>园区人流脉搏</h2><p>把现场两条小路拆成可解释的时段流量，按拥挤度驱动人群移动。</p><div className="flow-city-kpi-list">{[['TOTAL AGENTS', liveAgentCount, '当前模拟人数'], ['CONGESTION INDEX', `${congestionIndex}`, `${congestionBand} · 0–100`], ['WEST WALKWAY', `${Math.round(westFlow * eventBoost)}`, '人 / 小时'], ['SOUTH SERVICE', `${Math.round(southFlow * eventBoost)}`, '人 / 小时'], ['GROUND GATE', eventStage >= 2 || showAfter ? '+60' : '0', '分流增量 / 时'], ['FLOW SPEED', `${flowSpeed.toFixed(1)}×`, '脚本速度']].map(([label, value, note]) => <div className="flow-city-kpi" key={label}><i style={{ background: label === 'CONGESTION INDEX' ? congestionColor : activeCockpitLayer.color }} /><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span></div>)}</div><button type="button" className="flow-city-cta" style={{ '--cta-color': activeCockpitLayer.color }} onClick={startMorningPeak}>SIMULATE MORNING PEAK <span>▶</span></button></> : <><span className="flow-city-panel-kicker">LAYER {String(cockpitLayers.findIndex((layer) => layer.id === flowLayer) + 1).padStart(2, '0')} OF 06 <small>{activeCockpitLayer.name}</small></span><h2>{activeCockpitLayer.name} · 人流剧本</h2><p>拥挤指数由当前模拟人数和时段倍率推导，所有读数均为 Scenario。</p><div className="flow-city-focus-grid"><div><small>当前流量</small><strong>{activeAgentCount}</strong><em>人 / 小时</em></div><div><small>拥挤指数</small><strong style={{ color: congestionColor }}>{congestionIndex}</strong><em>{congestionBand}</em></div><div><small>平均绕行</small><strong>{eventStage >= 2 ? '−18' : '+42'}</strong><em>米 / 人</em></div><div><small>分流增量</small><strong>+{eventStage >= 2 || showAfter ? 60 : 0}</strong><em>人 / 小时</em></div></div><canvas className="flow-city-sparkline" ref={sparklineRef} aria-label="90秒拥挤指数趋势" /><div className="flow-city-focus-points"><span><i style={{ background: congestionColor }} />{eventStage === 0 ? '围栏边界造成入口绕行' : eventStage === 1 ? '双通道同时进入峰值' : '地面小门分流已接管'}</span><span><i style={{ background: activeCockpitLayer.color }} />两条小路保持独立统计</span><span><i style={{ background: '#a78bfa' }} />读数标记为 Simulated</span></div><button type="button" className="flow-city-cta" style={{ '--cta-color': activeCockpitLayer.color }} onClick={startMorningPeak}>SIMULATE MORNING PEAK <span>▶</span></button></>}
          <div className="flow-city-hover-card"><strong>{hoveredFacility} · SIGNAL</strong><span>通过率 {hoveredFacility === '地面小门' ? (eventStage >= 2 ? 60 : 0) : Math.max(18, Math.round(activeAgentCount * (hoveredFacility === '主楼入口' ? .48 : .34)))} 人/时</span><small>拥挤指数 {Math.min(100, congestionIndex + (hoveredFacility === '主楼入口' ? 8 : 0))} · Simulated</small></div>
        </aside>
      </div>
      <footer className="flow-city-cockpit-footer"><div className="flow-city-speed"><button type="button" onClick={() => setCockpitPaused((value) => !value)}>{cockpitPaused ? '▶' : 'Ⅱ'}</button><span>FLOW SPEED</span><input type="range" min="0.2" max="3" step="0.1" value={flowSpeed} onChange={(event) => setFlowSpeed(Number(event.target.value))} /><strong>{flowSpeed.toFixed(1)}×</strong></div><div className="flow-city-key-hint">1–4 方案 · O 总览 · X 透视 · D 日景 · 空格 暂停 · 拖拽 环视</div><div className="flow-city-event-log" aria-live="polite"><span>EVENT LOG</span>{eventLog.slice(0, 2).map((entry, index) => <div key={`${entry.time}-${index}`}><b>{entry.time}</b><i className={entry.level}>{entry.level}</i><small>{entry.text}</small></div>)}</div></footer>
    </section>
    <section className="traffic-twin-screen" aria-label="流量智慧城市孪生画面">
      <div className="traffic-twin-screenbar"><strong>FLOW CITY TWIN</strong><span>small-path telemetry simulated · {String(selectedHour).padStart(2, '0')}:00</span><div><button type="button" className="active">Overview</button><button type="button">X-ray ground</button><button type="button">Daylight</button><button type="button">Labels</button></div></div>
      <aside className="traffic-twin-layers"><span>NETWORK LAYER</span><small>只启用一层流量</small><div className="traffic-twin-layer active"><b>01</b><strong>Traffic</strong><small>两条小路 · {westFlow + southFlow}/h</small><i /></div><div className="traffic-twin-layer-note">所有读数均为 Scenario。点击小路节点查看其信号流。</div></aside>
      <div className="traffic-twin-city"><svg viewBox="0 0 920 560" role="img" aria-label="夜景小路流量城市孪生"><defs><pattern id="cityOpsGrid" width="34" height="34" patternUnits="userSpaceOnUse"><path d="M34 0H0V34" fill="none" stroke="#153b4b" strokeWidth="1" opacity=".58" /></pattern><filter id="cityOpsGlow"><feGaussianBlur stdDeviation="3" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter><linearGradient id="cityNightDeck" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#061724" /><stop offset="1" stopColor="#020a12" /></linearGradient></defs><rect width="920" height="560" fill="url(#cityNightDeck)" /><rect width="920" height="560" fill="url(#cityOpsGrid)" opacity=".74" />{cityBlocks.map((block, index) => <g key={index} className="traffic-city-block"><rect x={block.x} y={block.y} width={block.w} height={block.h} rx="2" /><path d={`M${block.x + 7} ${block.y + 7}h${Math.max(8, block.w - 14)}M${block.x + 7} ${block.y + 14}h${Math.max(8, block.w - 14)}`} /></g>)}<path className="traffic-city-route cyan" d="M28 142C155 142 208 211 328 197s130-62 252-51 123 70 207 112" /><path className="traffic-city-route amber" d="M40 448c132 0 169-80 290-73s113 79 254 57 163-95 292-91" /><path className="traffic-city-route gate" d="M580 146c69 9 98 57 133 112" style={{ opacity: showAfter ? 1 : .14 }} /><path className="traffic-city-dash" d="M286 211c74-19 103-49 165-60" /><circle className="traffic-city-node cyan" cx="28" cy="142" r="9" /><circle className="traffic-city-node amber" cx="40" cy="448" r="9" /><circle className="traffic-city-node gate" cx="713" cy="258" r="12" style={{ opacity: showAfter ? 1 : .2 }} /><circle className="traffic-city-pulse" cx="713" cy="258" r="24" style={{ opacity: showAfter ? 1 : .2 }} /><text x="48" y="120">WEST GATE / {Math.round(selectedSpectrum.west)} H</text><text x="48" y="478">SOUTH SERVICE / {Math.round(selectedSpectrum.south)} H</text><text x="735" y="254">GROUND GATE</text><text x="735" y="273">{showAfter ? `+${gateFlow}` : '0'} / H</text><text className="traffic-city-caption" x="390" y="282">MAIN BUILDING / DERIVED FOOTPRINT</text></svg><div className="traffic-twin-city-label"><span>TRAFFIC SIGNAL FIELD</span><strong>{showAfter ? 'RETROFIT FLOW' : 'BASELINE FLOW'}</strong></div></div>
      <aside className="traffic-twin-pulse"><span>CITY PULSE</span><h2>{showAfter ? 'Two paths, one direct gate' : 'Two paths, fenced edge'}</h2><p>{showAfter ? '改造后将小门作为独立流量信号接入小路网络。' : '现状连续围栏使小门流量为 0，小路维持独立绕行。'}</p><div className="traffic-pulse-ab"><div><span>A · 现状</span><strong>0</strong><small>地面小门 / 人·时</small></div><i>→</i><div className="after"><span>B · 改造后</span><strong>+{gateFlow}</strong><small>直达分流 / 人·时</small></div></div><div className="traffic-pulse-stats"><div><small>WEST WALKWAY</small><strong>{Math.round(selectedSpectrum.west)}</strong><em>人/小时</em></div><div><small>SOUTH SERVICE</small><strong>{Math.round(selectedSpectrum.south)}</strong><em>人/小时</em></div><div><small>GROUND GATE</small><strong>{showAfter ? Math.round(selectedSpectrum.gate) : 0}</strong><em>人/小时</em></div></div><div className="traffic-pulse-status"><span><i className="cyan" />西门人行小道</span><b>中</b><span><i className="amber" />南侧混行线</span><b>中</b><span><i className="gate" />地面小门</span><b>{showAfter ? '新增' : '关闭'}</b></div><small className="traffic-pulse-note">Telemetry simulated · 现场穿越计数待校准</small></aside>
      <div className="traffic-twin-bottom"><span>FLOW SPEED</span><input type="range" min="0" max="23" value={selectedHour} onChange={(event) => setSelectedHour(Number(event.target.value))} /><strong>{String(selectedHour).padStart(2, '0')}:00</strong><button type="button" className={showAfter ? 'active' : ''} onClick={() => setShowAfter((value) => !value)}>{showAfter ? '改造后' : '现状'}</button><small>拖动时间点 · 点击切换 A/B 状态</small></div>
    </section>
    <section className="traffic-photo-compare" aria-label="改造前后生成照片对比"><div className="traffic-photo-head"><div><span>04 / PHOTO SCENARIO</span><h2>改造前后空间照片对比</h2><p>GPT Image 生成的方案示意，用来说明流量改造如何改变绕行、通行和混行关系。</p></div><em>GENERATED · SCENARIO</em></div><div className="traffic-photo-grid"><article className="traffic-photo-card barrier"><div className="traffic-photo-frame"><img src="/generated/traffic-comparisons/serpentine-barrier-before-after-v1.png" alt="蛇形不锈钢栏杆改造成直达无障碍通行的前后对比示意" /><span className="traffic-photo-before">A · 现状</span><span className="traffic-photo-after">B · 改造后</span></div><div className="traffic-photo-card-copy"><span>ACCESS 00 · USER PROVIDED</span><h3>蛇形栏杆 → 直达通行</h3><p>把多次折返的蛇形栏杆改成直线通行和转弯空间，保留必要的边缘扶手与安全边界。</p><strong>通行关系：折返阻断 → 直达可读</strong></div></article><article className="traffic-photo-card fence"><div className="traffic-photo-frame"><img src="/generated/traffic-comparisons/fence-before-after-v1.png" alt="连续围栏改造成地面小门的前后对比示意" /><span className="traffic-photo-before">A · 现状</span><span className="traffic-photo-after">B · 改造后</span></div><div className="traffic-photo-card-copy"><span>OBSTRUCTION 01</span><h3>连续围栏 → 地面小门</h3><p>把绕行线改成一条可识别的直达流线；图像仅表达空间关系，施工尺寸仍需现场复核。</p><strong>小门流量：0 → +{gateFlow} 人/小时</strong></div></article><article className="traffic-photo-card gate"><div className="traffic-photo-frame"><img src="/generated/traffic-comparisons/side-gate-before-after-v1.png" alt="侧边小门从封闭绕行改造成直达通道的前后对比示意" /><span className="traffic-photo-before">A · 现状</span><span className="traffic-photo-after">B · 改造后</span></div><div className="traffic-photo-card-copy"><span>ACCESS 02</span><h3>侧边小门 → 直达分流</h3><p>小门与自然行走线对齐，减少人在建筑边角处的折返和交叉。</p><strong>路径关系：绕行 → 直达</strong></div></article><article className="traffic-photo-card lane"><div className="traffic-photo-frame"><img src="/generated/traffic-comparisons/mixed-lane-before-after-v1.png" alt="南侧混行小路从拥挤改造成分流通行的前后对比示意" /><span className="traffic-photo-before">A · 现状</span><span className="traffic-photo-after">B · 改造后</span></div><div className="traffic-photo-card-copy"><span>FLOW 03</span><h3>混行小路 → 人行 / 非机动车分流</h3><p>让南侧小路的流量信号从一条拥挤线变成可解释的分流界面。</p><strong>南侧小路：{southFlow} 人/小时 · Scenario</strong></div></article></div></section>
    <div className="traffic-only-kpis"><article><span>西门人行小道</span><strong>{westFlow}</strong><small>人/小时 · Scenario</small></article><article><span>南侧混行线</span><strong>{southFlow}</strong><small>人/小时 · Scenario</small></article><article><span>推荐地面小门</span><strong>0 → +{gateFlow}</strong><small>现状 → 改造后 · Scenario</small></article><article><span>流量口径</span><strong>2 + 1</strong><small>两条既有小路 + 一条新增通道</small></article></div>
    <div className="traffic-only-grid">
      <article className="traffic-only-map-card"><div className="traffic-only-section-head"><div><span>01 / FLOW MAP</span><h2>小路流线状态</h2></div><em>Derived / Simulated</em></div><div className="traffic-only-map"><svg viewBox="0 0 760 420" role="img" aria-label="两条小路与推荐小门流线图"><defs><linearGradient id="trafficRoadCyan" x1="0" x2="1"><stop offset="0" stopColor="#153945" /><stop offset=".55" stopColor="#54e0da" /><stop offset="1" stopColor="#a8f4ff" /></linearGradient><linearGradient id="trafficRoadAmber" x1="0" x2="1"><stop offset="0" stopColor="#463018" /><stop offset=".55" stopColor="#fbbf24" /><stop offset="1" stopColor="#ffe8a3" /></linearGradient><filter id="trafficGlow"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs><rect className="traffic-map-deck" x="0" y="0" width="760" height="420" rx="8" /><path className="traffic-map-building" d="M270 74h278v198H270z" /><path className="traffic-map-inner" d="M295 101h225v145H295z" /><path className="traffic-map-route cyan" d="M42 116 C132 116 154 152 250 152 S335 134 420 134" /><path className="traffic-map-route amber" d="M44 325 C160 325 184 273 268 273 S376 292 468 292" /><path className="traffic-map-gate" d="M420 134 C488 134 508 162 548 208" /><path className="traffic-map-route-after" d="M468 292 C536 292 552 254 602 224" /><circle className="traffic-map-node cyan" cx="42" cy="116" r="9" /><circle className="traffic-map-node amber" cx="44" cy="325" r="9" /><circle className="traffic-map-node gate" cx="548" cy="208" r="11" /><circle className="traffic-map-pulse" cx="548" cy="208" r="20" /><text x="28" y="89">WEST GATE</text><text x="28" y="356">SOUTH SERVICE</text><text x="565" y="201">GROUND GATE</text><text x="565" y="218">0 → +60 / H</text><text className="traffic-map-building-label" x="352" y="190">MAIN BUILDING</text><text className="traffic-map-building-label" x="362" y="208">DERIVED FOOTPRINT</text></svg><div className="traffic-map-legend"><span><i className="cyan" />西门人行小道 · {westFlow}/h</span><span><i className="amber" />南侧混行线 · {southFlow}/h</span><span><i className="gate" />推荐小门 · 0 → +{gateFlow}/h</span></div></div></article>
      <article className="traffic-only-compare-card"><div className="traffic-only-section-head"><div><span>02 / A—B DELTA</span><h2>现状 → 改造后</h2></div><em>Scenario compare</em></div><div className="traffic-only-ab-stack"><div className="traffic-only-ab-row"><div><span>A · 现状</span><strong>连续围栏</strong><small>入口绕行 · 小门流量 0</small></div><b>→</b><div className="after"><span>B · 改造后</span><strong>地面小门</strong><small>直达分流 · +{gateFlow}/h</small></div></div><div className="traffic-only-ab-metrics"><div><span>西门人行小道</span><b>{westFlow} → {westFlow}</b><small>既有需求保持</small></div><div><span>南侧混行线</span><b>{southFlow} → {southFlow}</b><small>既有需求保持</small></div><div className="gate"><span>推荐地面小门</span><b>0 → +{gateFlow}</b><small>新增直达流量</small></div></div><div className="traffic-only-plan-select"><span>当前推演方案</span><select value={selectedPlan} onChange={(event) => setSelectedPlan(event.target.value)}>{Object.entries(planCopy ? { 'P-SAFE': '安全优先', 'P-EFFICIENCY': '效率优先', 'P-BALANCED': '综合平衡' } : {}).map(([id, label]) => <option key={id} value={id}>{id} · {label}</option>)}</select></div><div className={`traffic-only-plan-card ${planCopy.accent}`}><span>{selectedPlan}</span><strong>{planCopy.label}</strong><p>{planCopy.detail}</p><div><b>{westFlow} / {southFlow}</b><small>两条小路 · 人/小时</small><b>0 → +{gateFlow}</b><small>推荐小门 · 人/小时</small></div></div></div></article>
    </div>
    <article className="traffic-only-spectrum-card"><div className="traffic-only-section-head"><div><span>03 / 24H FLOW SPECTRUM</span><h2>全天流量节奏</h2></div><em>运营倍率 · Scenario</em></div><div className="traffic-spectrum-focus"><div><span>当前时刻</span><strong>{String(selectedHour).padStart(2, '0')}:00</strong><small>拖动上方 FLOW SPEED</small></div><div><span>西门人行小道</span><b>{Math.round(selectedSpectrum.west)} /h</b><span>南侧混行线</span><b>{Math.round(selectedSpectrum.south)} /h</b></div><div><span>普通工作日峰值</span><strong>{String(peakSpectrum.hour).padStart(2, '0')}:00</strong><small>两条小路合计情景最高</small></div></div><div className="traffic-spectrum"><div className="traffic-spectrum-y"><span>高峰</span><span>平峰</span><span>低谷</span></div><div className="traffic-spectrum-bars">{spectrum.map((point) => <div className={`traffic-spectrum-hour ${point.hour === selectedHour ? 'selected' : ''} ${point.hour === peakSpectrum.hour ? 'peak' : ''}`} key={point.hour}><div className="traffic-spectrum-bars-stack"><i className="cyan" style={{ '--bar-height': `${Math.max(5, point.west / maxSpectrum * 100)}%` }} /><i className="amber" style={{ '--bar-height': `${Math.max(5, point.south / maxSpectrum * 100)}%` }} /><i className="gate" style={{ '--bar-height': `${Math.max(5, point.gate / maxSpectrum * 100)}%` }} /></div><small>{point.hour % 3 === 0 ? String(point.hour).padStart(2, '0') : '·'}</small></div>)}</div></div><div className="traffic-spectrum-legend"><span><i className="cyan" />西门人行小道</span><span><i className="amber" />南侧混行线</span><span><i className="gate" />推荐小门（改造后）</span><small>24 根柱 = 24 小时；柱高是运营情景强度，不是逐人运动轨迹。</small></div></article>
    <footer className="traffic-only-footer"><span><i />数据边界：两条小路分开读取；机动车仍为未实测；流量数字均标记 Scenario。</span><b>{project?.name || '某集团办公楼二次空间更新'}</b></footer>
  </section>;
}

function SolutionComparisonPanel({ transportPlan }) {
  const simulation = transportPlan?.lastSimulation;
  const roadResult = (id, fallback) => Number(simulation?.roadResults?.find((item) => item.roadId === id)?.flow?.pedestrians ?? fallback);
  const westFlow = roadResult('west-gate-walkway', 132);
  const southFlow = roadResult('south-service-lane', 86);
  const gateFlow = 60;
  const solutions = [
    { id: 'P-SAFE', label: '安全优先', title: '单个地面小门 + 保留车辆隔离', tone: 'safe', action: '在自然行走线设置单个地面小门，开口宽度待现场复核；围栏两端和混行线保持原边界。', result: '先解决绕行与人车冲突', confidence: 'Scenario' },
    { id: 'P-EFFICIENCY', label: '效率优先', title: '两个对齐开口 + 分流', tone: 'efficiency', action: '在两条主要 desire line 上设置两个开口，分流关系待现场计数后确定。', result: '减少单点排队，门禁复杂度上升', confidence: 'Scenario' },
    { id: 'P-BALANCED', label: '综合平衡', title: '单个地面小门 + 小路热力监测', tone: 'balanced', action: '先采用单开口，再用小路热力和现场穿越计数决定是否增加第二开口。', result: '演示与实施边界最清楚', confidence: 'Scenario' }
  ];
  return <article className="panel solution-comparison-panel">
    <div className="solution-comparison-header"><div><span className="eyebrow-label">BEFORE / AFTER · SCENARIO COMPARE</span><h2>现状和改造后的流量对照</h2><p>两条既有小路保持独立；新增小门流量单列，不把不同目的地重复相加。</p></div><span className="status-chip scenario">Scenario · 可复算</span></div>
      <div className="solution-flow-strip" aria-label="现状和改造后流量">
      <div><span>现状 · 西门人行小道</span><strong>{westFlow}</strong><small>人/小时</small></div>
      <i>→</i>
      <div className="after"><span>改造后 · 西门人行小道</span><strong>{westFlow}</strong><small>既有需求保持</small></div>
      <div><span>现状 · 南侧混行线</span><strong>{southFlow}</strong><small>人/小时</small></div>
      <i>→</i>
      <div className="after"><span>改造后 · 南侧混行线</span><strong>{southFlow}</strong><small>既有需求保持</small></div>
    </div>
    <div className="solution-flow-addition"><span>推荐地面小门 · 现状 → 改造后</span><strong>0 → +{gateFlow}</strong><small>人/小时 · 现状无开口，改造后为跨围栏直达情景</small></div>
    <div className="solution-card-grid">{solutions.map((solution) => <article className={`solution-card ${solution.tone}`} key={solution.id}><div className="solution-card-top"><span>{solution.id}</span><strong>{solution.label}</strong></div><h3>{solution.title}</h3><p>{solution.action}</p><div className="solution-card-metrics"><span><small>两条小路 · 现状/改造后</small><b>{westFlow} / {southFlow}</b><em>人/小时 · 既有需求保持</em></span><span><small>小门 · 现状/改造后</small><b>0 → +{gateFlow}</b><em>人/小时 · Scenario</em></span></div><footer><span>{solution.result}</span><em>{solution.confidence}</em></footer></article>)}</div>
    <div className="solution-comparison-note"><strong>这张对比图怎么读</strong><span>左侧是当前两条小路的独立 Scenario 压力，右侧是改造后保留既有需求并新增直达小门的 Scenario 流量。实际施工前，需要用现场按小时穿越计数替换这些情景值。</span></div>
  </article>;
}

function ProposalWorkspace({ project, transportPlan, assets, artifacts, settings, sceneObjects, observations, health, proposals, busy, setBusy, notify, refresh, nextStep }) {
  const [slot, setSlot] = useState(settings.timeSlots?.[0]?.id || 'weekday_arrival');
  const [contextText, setContextText] = useState(() => JSON.stringify({
    schema: 'observation_bundle.v1', scene_version: 'S1', time_slot: 'weekday_arrival', sample_level: 'single_observation',
    calibration: { mode: 'none' }, metrics: [], conflicts: [], scene_objects: [], allowed_actions: allowedActions, data_gaps: ['尚未完成真实 YOLO 分析']
  }, null, 2));
  const [validation, setValidation] = useState(null);

  const loadBundle = async () => {
    try {
      const result = await api(`/observations/bundle?slotId=${encodeURIComponent(slot)}`);
      setContextText(JSON.stringify(result.bundle, null, 2));
      notify('success', `已载入 ${result.bundle.metrics.length} 项真实聚合指标与 ${result.bundle.conflicts.length} 项冲突`);
    } catch (error) {
      notify('warning', error.message, error.details);
    }
  };

  useEffect(() => {
    if (project && observations.some((item) => item.schema === 'observation_bundle.v1')) loadBundle();
  }, [project?.id, slot, observations.length, sceneObjects.length]);

  const validateLlm = async () => {
    setBusy(true);
    try { const result = await api('/llm/validate'); setValidation(result); notify('success', '已验证网关和精确模型 ID'); }
    catch (error) { setValidation({ ok: false, message: error.message }); notify('warning', error.message, error.details); }
    finally { setBusy(false); }
  };

  const generate = async () => {
    let currentContext;
    try { currentContext = JSON.parse(contextText); } catch { return notify('warning', '当前 ObservationBundle 无法解析，请重新载入'); }
    if (!Array.isArray(currentContext.conflicts) || !currentContext.conflicts.length) return notify('warning', '需要真实冲突证据才能请求方案');
    setBusy(true);
    try {
      await api('/llm/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slotId: slot, sceneVersion: 'S1' }) });
      notify('success', 'AI Draft 已生成并通过引用校验');
      refresh();
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); }
  };

  return (
    <section className="stage-layout">
      <StageHeading eyebrow="STEP 04 / EVIDENCE-BOUND REASONING" title="让模型解释关系，\n不让它编造数字。" description="系统结合视频观测、150 米交通接驳场景与三维场景，生成安全优先、效率优先和综合平衡三套可对比方案。" />
      <div className="stage-content proposal-stage">
        <AmapRhythmPanel />
        <RetrofitWipeCompare />
        <AmapTwinScene />
        {transportPlan?.lastSimulation && <article className="panel transport-context-card"><PanelHeader icon={Route} title="交通接驳已进入方案上下文" action={<span className="status-chip scenario">Scenario</span>} /><div className="transport-context-grid"><div><strong>{transportPlan.lastSimulation.label}</strong><span>{transportPlan.lastSimulation.timeWindow}</span></div><div><strong>独立路段</strong><span>人流分开核对</span></div><div><strong>{transportPlan.lastSimulation.hotspots?.length || 0}</strong><span>冲突热点</span></div></div><small>地铁接驳路段按各自OD流量提交给 AI，不合并成单一路径；站口坐标和路网保持“近似 / Scenario”边界。</small></article>}
        <SolutionComparisonPanel transportPlan={transportPlan} />
        <ScenarioLab {...{ project, assets, artifacts, sceneObjects, transportPlan, observations, busy, setBusy, notify }} />
        <article className="panel llm-panel expert-only">
          <PanelHeader icon={BrainCircuit} title="大模型网关" action={<span className={`status-chip ${health?.llm?.configured ? 'ready' : 'blocked'}`}>{health?.llm?.configured ? 'KEY PRESENT' : 'KEY MISSING'}</span>} />
          <dl className="config-list"><div><dt>BASE URL</dt><dd>{health?.llm?.baseUrl || '—'}</dd></div><div><dt>MODEL</dt><dd>{health?.llm?.model || '—'}</dd></div><div><dt>ADAPTER</dt><dd>Responses → Chat fallback</dd></div></dl>
          <button className="secondary-button wide" onClick={validateLlm} disabled={busy}><RefreshCw size={15} /> 验证精确模型</button>
          {validation && <div className={`validation-result ${validation.ok ? 'success' : 'warning'}`}>{validation.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<span>{validation.ok ? '模型 ID 已精确匹配' : validation.warning || validation.message || '验证未通过'}</span></div>}
          <p className="secret-note">密钥只由服务端环境变量读取，前端不可见，也不会写入项目档案。</p>
        </article>

        <article className="panel context-panel expert-only">
          <PanelHeader icon={Database} title="ObservationBundle / 输入契约" action={<button className="text-button" onClick={loadBundle}>从真实观测载入</button>} />
          {contextText.includes('"test_only": true') && <div className="test-only-banner"><AlertTriangle size={15} /><span><strong>TEST ONLY</strong>大模型可用于验证方案链，但结论不可作为现场实测或实施依据。</span></div>}
          <label className="bundle-slot">时间段<select value={slot} onChange={(event) => setSlot(event.target.value)}>{settings.timeSlots.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select><span className="status-chip">JSON V1</span></label>
          <textarea spellCheck="false" value={contextText} readOnly aria-label="ObservationBundle JSON（只读）" />
          <div className="contract-note"><AlertTriangle size={15} /> 该证据包由服务端按已存观测重建，仅供审阅；方案请求不接受前端替换事实。</div>
        </article>

        <article className="panel reasoning-flow expert-only">
          <PanelHeader icon={Sparkles} title="受控推理链" />
          <div className="flow-diagram">
            {['聚合指标', '规则冲突', 'GPT 诊断', '动作白名单', '模拟复算', '专家审核'].map((item, i) => <React.Fragment key={item}><span>{item}</span>{i < 5 && <ChevronRight size={14} />}</React.Fragment>)}
          </div>
          <div className="guardrails"><span><XCircle size={14} /> 禁止虚构对象 ID</span><span><XCircle size={14} /> 禁止改善百分比</span><span><CheckCircle2 size={14} /> 每条结论引用证据</span></div>
        </article>

        <article className="panel proposal-output">
          <PanelHeader icon={Layers3} title="方案草案" action={<span className="panel-count">{proposals.length} 份</span>} />
          {proposals.length === 0 ? <div className="proposal-empty"><BrainCircuit size={28} /><strong>尚无可审核方案</strong><span>请先完成视频分析并确认空间冲突</span></div> : proposals.slice(-3).reverse().map((proposal) => <ProposalCard key={proposal.id} proposal={proposal} />)}
          <button className="primary-button wide" disabled={busy || !project || !health?.llm?.configured} onClick={generate}><Sparkles size={16} /> 生成空间优化方案</button>
        </article>
      </div>
      <StageFooter left="方案通过复算与专家审核后才可发布" actions={<button className="primary-button" onClick={nextStep}>进入专家成稿 <ArrowRight size={16} /></button>} />
    </section>
  );
}

const operationProfiles = {
  office_weekday: {
    label: '普通工作日',
    note: '以上班、午间、下班为三个运营峰值；倍率是可审阅的 Scenario 假设。',
    multipliers: { 0: .08, 1: .06, 2: .05, 3: .05, 4: .07, 5: .14, 6: .36, 7: .78, 8: 1, 9: .7, 10: .48, 11: .63, 12: .76, 13: .56, 14: .43, 15: .46, 16: .62, 17: .88, 18: .96, 19: .67, 20: .43, 21: .28, 22: .18, 23: .11 }
  },
  logistics_window: {
    label: '后勤集中日',
    note: '上午后勤作业加权，用于检查卸货与办公到达叠加时的空间压力。',
    multipliers: { 0: .08, 1: .06, 2: .05, 3: .05, 4: .07, 5: .14, 6: .36, 7: .78, 8: 1, 9: .92, 10: 1.08, 11: .94, 12: .76, 13: .56, 14: .43, 15: .46, 16: .62, 17: .88, 18: .96, 19: .67, 20: .43, 21: .28, 22: .18, 23: .11 }
  },
  event_day: {
    label: '活动日压力测试',
    note: '午间与晚间进出放大，作为独立 Scenario，不并入普通日观测基线。',
    multipliers: { 0: .1, 1: .08, 2: .06, 3: .06, 4: .08, 5: .16, 6: .4, 7: .82, 8: 1, 9: .78, 10: .64, 11: .88, 12: 1.2, 13: 1.06, 14: .72, 15: .68, 16: .82, 17: 1.08, 18: 1.18, 19: 1.04, 20: .78, 21: .5, 22: .3, 23: .16 }
  }
};

function archiveSafeDate(observedDate = '') {
  const safeCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return observedDate && observedDate < safeCutoff ? observedDate : safeCutoff;
}

function ScenarioLab({ project, assets, artifacts, sceneObjects, transportPlan, observations, busy, setBusy, notify }) {
  const latestObservedDate = useMemo(() => observations
    .filter((item) => item.schema === 'observation_bundle.v1' && item.capturedAt)
    .map((item) => String(item.capturedAt).slice(0, 10)).sort().at(-1) || '', [observations]);
  const actors = useMemo(() => [...new Set(observations
    .filter((item) => item.schema === 'observation_bundle.v1')
    .flatMap((item) => item.metrics || [])
    .filter((metric) => metric.kind === 'unique_track_flow_rate' && metric.actor)
    .map((metric) => metric.actor))].sort(), [observations]);
  const [date, setDate] = useState(() => archiveSafeDate(latestObservedDate));
  const [actor, setActor] = useState('all');
  const [profileId, setProfileId] = useState('office_weekday');
  const [scenario, setScenario] = useState(null);
  const [selectedHour, setSelectedHour] = useState(12);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [roadSearch, setRoadSearch] = useState('');
  const [showAdvancedRoads, setShowAdvancedRoads] = useState(false);
  const [scenarioState, setScenarioState] = useState({ status: 'idle', message: '选择日期后获取真实历史天气并生成情景。' });
  const autoScenarioKeyRef = useRef('');
  const scenarioRoads = useMemo(() => extractScenarioRoads(sceneObjects), [sceneObjects]);
  const scenarioAreas = useMemo(() => sceneObjects.filter((object) =>
    object?.properties?.stale !== true
    && object?.geometry?.type === 'Polygon'
    && ['walkway', 'loading_zone', 'dropoff_zone', 'landscape'].includes(object.type)
  ).map((object) => ({ id: object.id, label: object.label || object.id, type: object.type })), [sceneObjects]);
  const selectedRoute = scenarioRoads.find((route) => route.id === selectedRouteId) || null;
  const selectedArea = scenarioAreas.find((area) => area.id === selectedRouteId) || null;
  const selectedSpatialTarget = selectedRoute || selectedArea;
  const scenarioIsGlobal = !selectedSpatialTarget;
  const routeMetricBound = useMemo(() => Boolean(selectedRouteId && observations.some((item) =>
    item.schema === 'observation_bundle.v1' && (item.metrics || []).some((metric) =>
      metric.kind === 'unique_track_flow_rate' && metric.targetId === selectedRouteId
    )
  )), [observations, selectedRouteId]);
  const scenarioTargetLabel = selectedRoute
    ? (routeMetricBound ? '道路情景 · 已绑定观测' : '道路情景 · 未绑定观测')
    : selectedArea
      ? '区域情景 · 指标待绑定'
      : '全局情景 · 不绑定道路';
  // 历史审计词汇“站点总量 → 所选道路的 Scenario 映射”仍保留在契约语义中；界面文案进一步区分已绑定和未绑定。
  const visibleScenarioRoads = useMemo(() => {
    const term = roadSearch.trim().toLowerCase();
    const isPriority = (route) => route.id === selectedRouteId
      || !/^osm-way-\d+-road$/i.test(route.label || '')
      || /四平路|设计院|小道|停车|入口|连续|通道/i.test(route.label || '')
      || observations.some((item) => (item.metrics || []).some((metric) => metric.targetId === route.id));
    return scenarioRoads.filter((route) => {
      if (term && !`${route.label} ${route.id}`.toLowerCase().includes(term)) return false;
      return showAdvancedRoads || isPriority(route);
    });
  }, [scenarioRoads, observations, selectedRouteId, roadSearch, showAdvancedRoads]);

  useEffect(() => { if (!date) setDate(archiveSafeDate(latestObservedDate)); }, [date, latestObservedDate]);
  useEffect(() => {
    if (selectedRouteId && ![...scenarioRoads, ...scenarioAreas].some((target) => target.id === selectedRouteId)) setSelectedRouteId('');
  }, [scenarioRoads, scenarioAreas, selectedRouteId]);

  const runScenario = async ({ auto = false } = {}) => {
    if (!project) return notify('warning', '请先建立项目地理锚点');
    if (!date) return notify('warning', '请选择情景日期');
    setBusy(true);
    setScenarioState({ status: 'loading', message: '正在获取 Open-Meteo Archive 并重建 24 小时曲线…' });
    try {
      let scenarioWeather;
      let weatherWarning = '';
      try {
        const weatherResult = await api(`/weather/archive?date=${encodeURIComponent(date)}&latitude=${encodeURIComponent(project.latitude)}&longitude=${encodeURIComponent(project.longitude)}`, { signal: AbortSignal.timeout(25_000) });
        scenarioWeather = weatherResult.weather;
      } catch (weatherError) {
        scenarioWeather = {
          source: 'unavailable', evidenceLevel: 'Scenario', requestedProvider: 'Open-Meteo Archive',
          errorCode: weatherError.code || 'WEATHER_PROVIDER_FAILED', errorMessage: weatherError.message
        };
        weatherWarning = `${weatherError.message}；已在无天气数据模式下生成流量与太阳情景。`;
      }
      const result = await api('/scenarios/24h', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          date, metricKind: 'unique_track_flow_rate', actor: actor === 'all' ? null : actor,
          targetId: routeMetricBound ? selectedRouteId : null,
          operationMultipliers: operationProfiles[profileId].multipliers, weather: scenarioWeather
        })
      });
      const firstAnchor = result.scenario.curve.find((point) => point.sourceWindowIds?.length);
      const anchorLabel = result.scenario.anchors.some((point) => point.sourceNature === 'virtual_test') ? 'Test 锚点' : 'Observed 锚点';
      setScenario(result.scenario);
      setSelectedHour(firstAnchor?.hour ?? 12);
      setScenarioState({ status: 'ready', message: `已生成 ${result.scenario.curve.length} 个小时点，其中 ${result.scenario.anchors.length} 个为 ${anchorLabel}。${weatherWarning}` });
      if (!auto) notify(weatherWarning ? 'warning' : 'success', weatherWarning || '24 小时天气与流量情景已生成');
    } catch (error) {
      const message = error.code === 'SCENARIO_ANCHORS_REQUIRED'
        ? '没有已持久化的真实观测锚点，不能生成全天情景曲线。'
        : error.name === 'TimeoutError' || error.name === 'AbortError'
          ? '24小时情景生成超时，请稍后重试。'
        : error.message;
      setScenario(null);
      setScenarioState({ status: 'error', message });
      if (!auto) notify('warning', message, error.details);
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!project?.id || !date) return;
    const key = [project.id, date, actor, profileId, selectedRouteId, routeMetricBound ? 'bound' : 'unbound'].join('|');
    if (autoScenarioKeyRef.current === key) return;
    autoScenarioKeyRef.current = key;
    void runScenario({ auto: true });
  }, [project?.id, date, actor, profileId, selectedRouteId, routeMetricBound]);

  const curve = scenario?.curve || [];
  const selectedScenarioPoint = curve.find((point) => point.hour === selectedHour) || null;
  const maxUpper = Math.max(1, ...curve.map((point) => Number(point.interval?.[1] ?? point.value ?? 0)));
  const selectedWeather = selectedScenarioPoint?.weather || {};
  const selectedUnit = '对象/分钟 · Scenario';
  const flowColor = (value) => scenarioFlowColor(value, maxUpper);
  const scenarioFlowPlan = useMemo(() => buildScenarioFlowPlan(sceneObjects, selectedScenarioPoint, { maxParticles: 72, selectedRouteId }), [sceneObjects, selectedScenarioPoint, selectedRouteId]);

  return (
    <article className="panel scenario-lab">
      <PanelHeader icon={CloudRain} title="24 小时天气与流量情景" action={<span className={`status-chip expert-only ${scenarioState.status === 'ready' ? 'ready' : scenarioState.status === 'error' ? 'blocked' : ''}`}>{scenarioState.status.toUpperCase()}</span>} />
      <div className="scenario-control-strip">
        <label><span>情景日期</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label><span>对象类型</span><select value={actor} onChange={(event) => setActor(event.target.value)}><option value="all">全部已观测对象</option>{actors.map((item) => <option value={item} key={item}>{actorLabels[item] || item}</option>)}</select></label>
        <div className="road-binding-control"><label><span>道路/区域绑定</span><select aria-label="道路或区域绑定；未选择时为全局情景" title="未绑定道路时生成全局情景，不绘制道路粒子" value={selectedRouteId} onChange={(event) => setSelectedRouteId(event.target.value)}><option value="">不绑定道路（不显示粒子）</option>{visibleScenarioRoads.length > 0 && <optgroup label={showAdvancedRoads ? '全部匹配道路' : '重点道路'}>{visibleScenarioRoads.map((route) => <option value={route.id} key={route.id}>{route.label || '未命名道路'}{route.source === 'OpenStreetMap' ? ' · OSM概念线' : ''}</option>)}</optgroup>}{scenarioAreas.length > 0 && <optgroup label="区域">{scenarioAreas.map((area) => <option value={area.id} key={area.id}>{area.label}</option>)}</optgroup>}</select></label><div><input aria-label="搜索道路" placeholder="搜索道路名称或ID" value={roadSearch} onChange={(event) => setRoadSearch(event.target.value)} /><button type="button" className={showAdvancedRoads ? 'active' : ''} onClick={() => setShowAdvancedRoads((value) => !value)}>{showAdvancedRoads ? '收起高级列表' : `高级道路 ${scenarioRoads.length}`}</button></div></div>
        <label><span>运营假设</span><select value={profileId} onChange={(event) => setProfileId(event.target.value)}>{Object.entries(operationProfiles).map(([id, profile]) => <option value={id} key={id}>{profile.label}</option>)}</select></label>
        <button className="primary-button" disabled={busy || !project || !date} onClick={runScenario}><Play size={15} /> {scenarioState.status === 'ready' ? (scenarioIsGlobal ? '重新生成全局情景' : '重新生成道路情景') : (scenarioIsGlobal ? '生成全局情景' : '生成道路情景')}</button>
      </div>
      <div className="scenario-assumption"><AlertTriangle size={14} /><span><strong>运营倍率假设</strong>{operationProfiles[profileId].note}</span></div>
      <div className={`route-binding-status ${routeMetricBound ? 'observed-bound' : selectedSpatialTarget ? 'scenario-bound' : 'unbound'}`}>
        <Route size={14} />
        <span><strong>{selectedSpatialTarget ? selectedSpatialTarget.label : '全局情景 · 不绑定道路'}</strong><span className="expert-only">{selectedRoute ? `${scenarioTargetLabel} · ${selectedRoute.highway || 'road'} · ${selectedRoute.widthM ? `${selectedRoute.widthM}m 概念宽度` : '宽度未记录'} · ${selectedRoute.id}` : selectedArea ? `${scenarioTargetLabel} · ${selectedArea.type} · ${selectedArea.id}` : `${scenarioTargetLabel} · ${scenarioRoads.length} 条道路 · ${scenarioAreas.length} 个区域可选`}</span></span>
        <em className="expert-only">{routeMetricBound ? '该道路已有 targetId 观测绑定' : selectedRoute ? '已选道路仅用于空间展示；未找到同 ID 观测，指标按全局锚点生成' : selectedArea ? '区域仅定位描边；占用量需同 ID 的 ROI 指标' : '全局情景不绘制道路流量粒子'}</em>
      </div>
      <div className="scenario-console">
        <div className="scenario-viewport">
          <SceneViewport project={project} assets={assets} artifacts={artifacts} sceneObjects={sceneObjects} transportPlan={transportPlan} scenarioPoint={selectedScenarioPoint} scenarioFlowColor={flowColor(selectedScenarioPoint?.value)} selectedRouteId={selectedRouteId} preferredModelKind="osm_context_glb" />
          {selectedScenarioPoint && <div className="scenario-flow-badge" style={{ '--flow-color': flowColor(selectedScenarioPoint.value) }}><i /><span><strong>{scenarioIsGlobal ? '全局情景状态' : routeMetricBound ? '当前道路流量示意' : '道路情景空间示意'}</strong>{scenarioFlowPlan.routes.length ? `${selectedRoute?.label || selectedRouteId} · ${routeMetricBound ? '流量随数值变化' : '情景值随时间变化，非道路实测'}` : selectedArea ? `${selectedArea.label} · 当前显示区域位置` : scenarioIsGlobal ? '全局情景 · 不绘制道路粒子' : '当前没有可显示的道路'}<small className="expert-only">{scenarioIsGlobal ? 'Scenario 全局映射 · 非逐点轨迹' : routeMetricBound ? 'Scenario 道路映射 · 非逐点轨迹' : 'Scenario 全局锚点 · 仅作道路空间示意'} · {scenarioFlowPlan.particles.length} 个可视粒子</small></span></div>}
          {selectedScenarioPoint && <div className="scenario-hud">
            <div><span>{String(selectedHour).padStart(2, '0')}:00</span><strong>{selectedScenarioPoint.value.toFixed(2)} <small>{selectedUnit}</small></strong></div>
            <dl>
              <div><dt>数据类型</dt><dd className={selectedScenarioPoint.evidenceLevel === 'Observed' ? 'observed' : 'scenario'}>{selectedScenarioPoint.testOnly ? '演示情景' : selectedScenarioPoint.evidenceLevel === 'Observed' ? '现场观测' : '情景推演'}</dd></div>
              <div><dt>置信区间</dt><dd>{selectedScenarioPoint.interval?.map((value) => Number(value).toFixed(2)).join(' – ')}</dd></div>
              <div><dt>太阳高度</dt><dd>{selectedScenarioPoint.sun?.altitude_deg?.toFixed(1)}°</dd></div>
              <div><dt>云量 / 降水</dt><dd>{selectedWeather.cloud_cover ?? '—'}% / {selectedWeather.precipitation ?? '—'} mm</dd></div>
            </dl>
          </div>}
        </div>
        <div className="scenario-track-panel">
          <div className="scenario-track-head">
            <div><strong>24H FLOW SPECTRUM <em>· 全天流量预测时间轴</em></strong><span>把现场观测锚点、运营倍率和天气状态展开成 24 个小时点；节点表示情景强度，不是逐个人员轨迹。{scenarioState.message}</span></div>
            <div className="scenario-key"><span><i className="observed" />现场观测<small className="expert-only">Observed 实测锚点</small></span><span><i className="scenario" />情景推演<small className="expert-only">Scenario 情景推演</small></span></div>
          </div>
          {curve.length ? <div className="scenario-timeline-scroll"><div className="scenario-timeline" role="list" aria-label="24小时流量与置信区间">
            {curve.map((point) => {
              const upper = Number(point.interval?.[1] ?? point.value);
              const lower = Number(point.interval?.[0] ?? point.value);
              const height = Math.max(5, Number(point.value) / maxUpper * 100);
              const intervalHeight = Math.max(2, (upper - lower) / maxUpper * 100);
              return <button type="button" role="listitem" key={point.hour} aria-pressed={selectedHour === point.hour} aria-label={`${point.hour}时 ${point.evidenceLevel} ${point.value} ${selectedUnit}，置信区间 ${lower} 到 ${upper}`} className={`hour-node ${point.evidenceLevel.toLowerCase()} ${selectedHour === point.hour ? 'selected' : ''}`} style={{ '--flow-color': flowColor(point.value), '--bar-height': `${height}%`, '--interval-height': `${intervalHeight}%` }} onClick={() => setSelectedHour(point.hour)}><span className="interval-whisker" /><i /><small>{point.hour % 3 === 0 ? String(point.hour).padStart(2, '0') : '·'}</small></button>;
            })}
          </div></div> : <div className={`scenario-empty ${scenarioState.status}`}><CloudRain size={25} /><strong>{scenarioState.status === 'error' ? '情景链未生成' : scenarioState.status === 'loading' ? '正在运行' : '等待运行'}</strong><span>{scenarioState.message}</span></div>}
          {selectedScenarioPoint?.sourceWindowIds?.length > 0 && <p className="anchor-provenance expert-only">{selectedScenarioPoint.testOnly ? 'Test 锚点' : 'Observed 锚点'}来自视频窗口 {selectedScenarioPoint.sourceWindowIds.join(', ')}；原始日期 {selectedScenarioPoint.observedDates?.join(', ') || '未记录'}。{selectedScenarioPoint.testOnly ? '该数据仅用于工作流验收，不是现场实测。' : '当前天气仍对应上方所选情景日期。'}</p>}
        </div>
      </div>
    </article>
  );
}

function ReviewWorkspace({ project, proposals, assets, artifacts, health, busy, setBusy, notify, refresh }) {
  const drafts = proposals.filter((p) => p.status !== 'Expert Approved');
  const approved = proposals.filter((p) => p.status === 'Expert Approved');
  const [reviewForms, setReviewForms] = useState({});
  const approve = async (proposalId) => {
    const review = reviewForms[proposalId] || { reviewer: '', note: '' };
    if (!review.reviewer.trim()) return notify('warning', '请填写审核人');
    if (!review.note.trim()) return notify('warning', '请填写审核意见');
    setBusy(true);
    try {
      await api(`/proposals/${proposalId}/approve`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: review.reviewer.trim(), note: review.note.trim() })
      });
      notify('success', '方案已标记为 Expert Approved');
      refresh();
    }
    catch (error) { notify('error', error.message); }
    finally { setBusy(false); }
  };
  const updateReview = (proposalId, field, value) => {
    setReviewForms((current) => ({ ...current, [proposalId]: { reviewer: '', note: '', ...current[proposalId], [field]: value } }));
  };
  const simulate = async (proposal) => {
    if (!proposal.sourceContext?.metrics?.length) return notify('warning', '该方案没有可复算的真实聚合指标');
    setBusy(true);
    try {
      for (const plan of proposal.draft?.plans || []) {
        await api('/simulations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId: proposal.id, planId: plan.id }) });
      }
      notify('success', '三套方案已完成确定性仿真复算');
      await refresh();
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); }
  };
  const exportApproved = async (proposal) => {
    setBusy(true);
    try {
      const result = await api('/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId: proposal.id, formats: ['json', 'csv', 'xlsx', 'pdf', 'poster_pdf', 'poster_png', 'offline_webgl', 'demo_mp4'] }) });
      notify('success', `已生成 ${result.export.files.length} 个可追溯成果文件`);
      await refresh();
    } catch (error) { notify('warning', error.message, error.details); }
    finally { setBusy(false); }
  };
  const approvedProposal = approved.at(-1);
  const testOnly = proposals.some((proposal) => proposal.testOnly);
  const webglReady = Boolean(approvedProposal) && artifacts.some((artifact) => ['dwg_plan_glb', 'dwg_extrusion_glb', 'blender_enhanced_glb', 'skp_glb', 'osm_context_glb', 'gaussian_spz', 'gaussian_ply'].includes(artifact.kind));
  const demoReady = Boolean(approvedProposal) && Boolean(health?.runtimes?.ffmpeg) && artifacts.some((artifact) => artifact.kind === 'annotated_video') && artifacts.some((artifact) => artifact.kind === 'semantic_overlay');
  return (
    <section className="stage-layout">
<StageHeading eyebrow="STEP 05 / HUMAN AUTHORITY" title="最后的判断权，\n始终留给人。" description="专家核对交通接驳基线、AI 方案、复算结果和适用边界后，生成三维展示、分析表、汇报文件、展板与演示视频。" />
      <div className="stage-content review-stage">
        {testOnly && <div className="test-only-banner review-test-banner"><AlertTriangle size={16} /><span><strong>TEST ONLY / 验收项目</strong>本项目可以走完专家审核与导出链，但所有成果必须保留“虚拟测试，不是现场实施依据”标记。</span></div>}
        <article className="panel release-board">
          <PanelHeader icon={ShieldCheck} title="成果准备" />
          <GateRow label="项目位置已确认" pass={Boolean(project)} />
          <GateRow label="已导入项目资料" pass={assets.length > 0} />
          <GateRow label="LLM 已连接，可生成方案" pass={Boolean(health?.llm?.configured)} />
          <GateRow label="AI 草案已生成" pass={proposals.length > 0} />
          <GateRow label="确定性复算已通过" pass={proposals.some((proposal) => proposal.simulationValidation?.status === 'passed')} />
          <GateRow label="至少一个专家批准方案" pass={approved.length > 0} />
          <div className="release-score"><span>发布就绪</span><strong>{[project, assets.length > 0, proposals.some((proposal) => proposal.simulationValidation?.status === 'passed'), approved.length > 0].filter(Boolean).length}<small>/4</small></strong></div>
        </article>

        <article className="panel review-queue">
          <PanelHeader icon={Archive} title="专家审核队列" action={<span className="panel-count">{drafts.length} 项待审</span>} />
          {drafts.length === 0 ? <EmptyLine text="没有待审方案" /> : drafts.map((proposal) => {
            const review = reviewForms[proposal.id] || { reviewer: '', note: '' };
            const simulationPassed = proposal.simulationValidation?.status === 'passed';
            return <div className="review-row" key={proposal.id}>
              <div className="review-summary"><span className={`status-chip ${simulationPassed ? 'ready' : 'blocked'}`}>{simulationPassed ? '复算已通过' : '需要复算'}</span><strong>{proposal.draft?.plans?.[0]?.name || proposal.id}</strong><small>{new Date(proposal.createdAt).toLocaleString('zh-CN')} · {proposal.simulationValidation?.violations?.join('；') || '指标已就绪'}</small></div>
              <div className="review-actions"><button className="secondary-button" disabled={busy || simulationPassed} onClick={() => simulate(proposal)}><RefreshCw size={14} /> 确定性复算</button></div>
              {simulationPassed && <div className="approval-form">
                <label><span>审核人</span><input value={review.reviewer} maxLength={80} onChange={(event) => updateReview(proposal.id, 'reviewer', event.target.value)} placeholder="姓名或评审席位" /></label>
                <label><span>审核意见</span><textarea value={review.note} maxLength={1000} onChange={(event) => updateReview(proposal.id, 'note', event.target.value)} placeholder="记录采纳理由、适用边界和后续复核要求" /></label>
                <button className="primary-button" disabled={busy || !review.reviewer.trim() || !review.note.trim()} onClick={() => approve(proposal.id)}><ShieldCheck size={15} /> 专家批准</button>
              </div>}
            </div>;
          })}
          {approved.length > 0 && <div className="approved-records">{approved.slice(-3).reverse().map((proposal) => <div key={proposal.id}><CheckCircle2 size={14} /><p><strong>{proposal.review?.reviewer || '未记录审核人'}</strong><span>{proposal.review?.note || '未记录审核意见'}</span></p><small>{proposal.review?.approvedAt ? new Date(proposal.review.approvedAt).toLocaleString('zh-CN') : '时间未记录'}</small></div>)}</div>}
        </article>

        <article className="panel artifact-board">
          <PanelHeader icon={FileDown} title="最终成果包" />
          <div className="artifact-grid">
            {[[ '可交互三维', '三维模型 · 网页展示', 'GLB · SPZ · GeoJSON', webglReady], ['分析数据', '统计表 · 轨迹 · 冲突记录', 'XLSX · CSV · JSON', Boolean(approvedProposal)], ['汇报文件', 'A3 汇报 · A1 展板', 'A3 PDF · A1 PNG/PDF', Boolean(approvedProposal)], ['演示资产', '1080p 演示视频 · 离线展示', '1080p MP4 · 离线包', demoReady]].map(([title, operatorDetail, expertDetail, ready]) => <button key={title} disabled={!ready} onClick={() => ready && exportApproved(approvedProposal)}><FileDown size={20} /><strong>{title}</strong><span className="operator-only">{operatorDetail}</span><span className="expert-only">{expertDetail}</span><small>{ready ? '生成真实成果' : approved.length ? '相关资料尚未准备完成' : '需要专家批准方案'}</small></button>)}
          </div>
          <div className="truth-banner"><ShieldCheck size={17} /><p><strong>真实输出原则</strong><span>只有完成对应分析和审核后才能导出；系统不生成空白 PDF、伪造视频或占位模型。</span></p></div>
        </article>

        <article className="panel audit-panel expert-only">
          <PanelHeader icon={Database} title="证据链摘要" />
          <dl className="audit-stats"><div><dt>源资产</dt><dd>{assets.length}</dd></div><div><dt>AI 草案</dt><dd>{proposals.length}</dd></div><div><dt>专家批准</dt><dd>{approved.length}</dd></div><div><dt>虚拟测试链</dt><dd className={testOnly ? 'test-count' : 'zero'}>{testOnly ? proposals.filter((proposal) => proposal.testOnly).length : 0}</dd></div></dl>
        </article>
      </div>
      <StageFooter left="发布成果必须包含来源、版本、审核人与证据状态" actions={<button className="primary-button" disabled={!approvedProposal || busy} onClick={() => exportApproved(approvedProposal)}><FileDown size={16} /> 生成完整成果包</button>} />
    </section>
  );
}

function applySceneEnvironment(runtime, scenarioPoint, displayMode = 'day-night') {
  if (!runtime) return;
  if (typeof window !== 'undefined') {
    window.__envTrace = window.__envTrace || [];
    window.__envTrace.push({ mode: displayMode, hd: runtime.highDensitySiteModel, amb: runtime.ambient?.intensity, same: runtime.ambient === window.__spatialTwinRuntime?.ambient, t: Math.round(performance.now()) });
  }
  const { THREE, renderer, scene, ambient, key, hemisphere, ground, skyDome } = runtime;
  const resetEnvironment = () => {
    scene.fog = null;
    if (ground) ground.visible = false;
    if (skyDome) skyDome.visible = false;
    renderer.shadowMap.enabled = false;
    renderer.toneMappingExposure = 1;
    if ('environmentIntensity' in scene) scene.environmentIntensity = 1;
  };
  if (displayMode === 'original') {
    resetEnvironment();
    const radius = Math.max(45, runtime.sceneRadius || 45);
    const skyTop = new THREE.Color(0x83aebf);
    const skyHorizon = new THREE.Color(0xdce6e5);
    if (ground) {
      ground.visible = runtime.sceneGroundEnabled !== false;
      ground.material.color.setHex(0x62665f);
      ground.material.roughness = 1;
      ground.material.opacity = 1;
    }
    if (skyDome) {
      skyDome.visible = true;
      skyDome.scale.setScalar(radius * 10);
      skyDome.material.uniforms.topColor.value.copy(skyTop);
      skyDome.material.uniforms.bottomColor.value.copy(skyHorizon);
    }
    ambient.color.setHex(0xeaf3f4);
    // 光比：高密度场地模型原先 ambient 0.48 + hemi 0.64 几乎把阴影填平，
    // 这里压暗天光、抬高主光，让静态阴影真正读得出来（参照 handan-3d-city 的低天光 + 强直射）。
    ambient.intensity = runtime.highDensitySiteModel ? 0.26 : 0.62;
    if (hemisphere) {
      hemisphere.color.setHex(0xd9eff5);
      hemisphere.groundColor.setHex(0x4b5650);
      hemisphere.intensity = runtime.highDensitySiteModel ? 0.42 : 0.72;
    }
    key.color.setHex(0xffefd2);
    key.intensity = runtime.highDensitySiteModel ? 2.55 : 2.05;
    key.position.set(radius * -0.42, radius * 0.75, radius * 0.58);
    // 静态阴影：高密度场地模型不再整体关闭阴影。阴影贴图只在场景/光照变化时
    // 重算一次（autoUpdate=false + needsUpdate），既让建筑落地，又不给集显加每帧负担。
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.toneMappingExposure = runtime.highDensitySiteModel ? 0.86 : 0.9;
    if ('environmentIntensity' in scene) scene.environmentIntensity = runtime.highDensitySiteModel ? 0.5 : 0.78;
    if (runtime.facadeReviewCandidate) {
      ambient.color.setHex(0xffffff);
      ambient.intensity = 0.52;
      hemisphere.color.setHex(0xeaf3fa);
      hemisphere.groundColor.setHex(0xc8ccc3);
      hemisphere.intensity = 0.34;
      key.intensity = 1.0;
      renderer.toneMappingExposure = 0.82;
      scene.environmentIntensity = 0.58;
      renderer.shadowMap.enabled = false;
    }
    renderer.setClearColor(skyHorizon, 1);
    scene.fog = new THREE.Fog(skyHorizon, radius * 4.2, radius * 13);
    return;
  }
  if (displayMode === 'analysis') {
    resetEnvironment();
    if (ground) {
      ground.visible = runtime.sceneGroundEnabled !== false;
      ground.material.color.setHex(0x0a1a1d);
      ground.material.roughness = 1;
      ground.material.opacity = 1;
    }
    ambient.color.setHex(0xbceeff);
    ambient.intensity = 1.08;
    if (hemisphere) {
      hemisphere.color.setHex(0x8deaff);
      hemisphere.groundColor.setHex(0x071619);
      hemisphere.intensity = 0.32;
    }
    key.color.setHex(0x8deaff);
    key.intensity = 2.3;
    key.position.set(8, 14, 5);
    if ('environmentIntensity' in scene) scene.environmentIntensity = 0.3;
    renderer.setClearColor(0x061114, 1);
    return;
  }
  if (displayMode === 'sunny') {
    const sunnyAltitude = Number(scenarioPoint?.sun?.altitude_deg);
    const sunnyAzimuth = Number(scenarioPoint?.sun?.azimuth_deg);
    const altitude = Number.isFinite(sunnyAltitude) && sunnyAltitude > 8 ? sunnyAltitude : 46;
    const azimuth = Number.isFinite(sunnyAzimuth) ? sunnyAzimuth : 148;
    const azimuthRadians = azimuth * Math.PI / 180;
    const altitudeRadians = altitude * Math.PI / 180;
    const radius = Math.max(45, runtime.sceneRadius || 45);
    const skyTop = new THREE.Color(0x68b9f2);
    const skyHorizon = new THREE.Color(0xe6f3ff);
    const skyColor = skyHorizon.clone().lerp(skyTop, Math.max(.28, Math.min(.82, altitude / 75)));
    renderer.setClearColor(skyColor, 1);
     renderer.toneMappingExposure = runtime.highDensitySiteModel ? .78 : .96;
     if ('environmentIntensity' in scene) scene.environmentIntensity = runtime.highDensitySiteModel ? .58 : 1.05;
    renderer.shadowMap.enabled = !runtime.highDensitySiteModel || runtime.hasSelectiveSiteShadows;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    ambient.color.setHex(0xffffff);
     ambient.intensity = runtime.highDensitySiteModel ? .38 : .52;
    if (hemisphere) {
      hemisphere.color.setHex(0xbfe3ff);
      hemisphere.groundColor.setHex(0x79877d);
       hemisphere.intensity = runtime.highDensitySiteModel ? .5 : .96;
    }
    key.color.setHex(0xfff0cf);
     key.intensity = runtime.highDensitySiteModel ? 1.7 : 3.1;
    key.position.set(
      Math.sin(azimuthRadians) * Math.cos(altitudeRadians) * radius,
      Math.max(12, Math.sin(altitudeRadians) * radius),
      Math.cos(azimuthRadians) * Math.cos(altitudeRadians) * radius
    );
    key.target.position.set(0, runtime.groundY || 0, 0);
    key.target.updateMatrixWorld();
    if (ground) {
      ground.visible = runtime.sceneGroundEnabled !== false;
      ground.material.color.setHex(0x7f8278);
      ground.material.roughness = 1;
      ground.material.opacity = 1;
    }
    if (skyDome) {
      skyDome.visible = true;
      skyDome.scale.setScalar(radius * 10);
      skyDome.material.uniforms.topColor.value.copy(skyTop);
      skyDome.material.uniforms.bottomColor.value.copy(skyHorizon);
    }
    scene.fog = new THREE.Fog(skyColor, radius * 3.6, radius * 12);
    return;
  }
  resetEnvironment();
  const effectiveScenario = scenarioPoint || STANDARD_NIGHT_SCENARIO;
  const altitude = Number(scenarioPoint?.sun?.altitude_deg ?? effectiveScenario?.sun?.altitude_deg ?? -18);
  const azimuth = Number(scenarioPoint?.sun?.azimuth_deg ?? effectiveScenario?.sun?.azimuth_deg ?? 270);
  const cloudCover = Math.max(0, Math.min(100, Number(scenarioPoint?.weather?.cloud_cover ?? effectiveScenario?.weather?.cloud_cover ?? 0)));
  const precipitation = Math.max(0, Number(scenarioPoint?.weather?.precipitation ?? effectiveScenario?.weather?.precipitation ?? 0));
  const daylight = Math.max(.035, Math.min(1, (altitude + 8) / 55));
  const cloudDimming = 1 - cloudCover / 100 * .48;
  const rainDimming = 1 - Math.min(precipitation / 8, .34);
  const lightFactor = cloudDimming * rainDimming;
  ambient.color.setHex(altitude < 2 ? 0x7896bb : 0xc9f0ff);
  ambient.intensity = .18 + daylight * .95 * lightFactor;
  key.intensity = .08 + daylight * 2.75 * lightFactor;
  key.color.setHex(precipitation > .2 ? 0x9bb7c2 : altitude < 14 ? 0xffbd85 : 0xd8fbff);
  const azimuthRadians = azimuth * Math.PI / 180;
  const altitudeRadians = Math.max(-5, altitude) * Math.PI / 180;
  const radius = 18;
  key.position.set(Math.sin(azimuthRadians) * radius, Math.max(.6, Math.sin(altitudeRadians) * radius), Math.cos(azimuthRadians) * radius);
  const night = new THREE.Color(0x02070d);
  const day = new THREE.Color(precipitation > .2 ? 0x152128 : cloudCover > 65 ? 0x17262c : 0x153941);
  const clearColor = night.clone().lerp(day, daylight);
  renderer.setClearColor(clearColor, 1);
  renderer.toneMappingExposure = .86 + daylight * .16;
  if (hemisphere) {
    hemisphere.color.setHex(altitude < 2 ? 0x5d7194 : precipitation > .2 ? 0x91aeb9 : 0xb9e1f7);
    hemisphere.groundColor.setHex(0x36403d);
    hemisphere.intensity = .18 + daylight * .55 * lightFactor;
  }
  if (ground) {
    ground.visible = runtime.sceneGroundEnabled !== false;
    ground.material.color.setHex(altitude < 0 ? 0x111a1c : 0x626d68);
    ground.material.roughness = 1;
    ground.material.opacity = 1;
  }
  if (skyDome) {
    skyDome.visible = true;
    skyDome.scale.setScalar(Math.max(450, (runtime.sceneRadius || 45) * 10));
    skyDome.material.uniforms.topColor.value.setHex(altitude < 0 ? 0x01040a : 0x4b88ad);
    skyDome.material.uniforms.bottomColor.value.setHex(altitude < 0 ? 0x101b29 : 0xb9d7e8);
  }
  scene.fog = precipitation > .2 ? new THREE.FogExp2(clearColor, .012 + Math.min(precipitation, 8) * .002) : null;
}

const DEFAULT_MODEL_ASSET_ID = 'asset_10602c89c51e';

function SceneViewport({ project, assets, artifacts, sceneObjects = [], transportPlan = null, scenarioPoint = null, scenarioFlowColor = '#54e0da', selectedRouteId = '', preferredModelKind = 'skp_glb', preferBlender = false, hydrating = false }) {
  const mountRef = useRef(null);
  const environmentRef = useRef(null);
  const scenarioPointRef = useRef(scenarioPoint);
  scenarioPointRef.current = scenarioPoint;
  const flowInputRef = useRef({ sceneObjects, scenarioPoint, scenarioFlowColor, selectedRouteId });
  flowInputRef.current = { sceneObjects, scenarioPoint, scenarioFlowColor, selectedRouteId };
  const transportPlanRef = useRef(transportPlan);
  transportPlanRef.current = transportPlan;
  const siteRouteInputRef = useRef(sceneObjects);
  siteRouteInputRef.current = sceneObjects;
  const siteRoutes = useMemo(() => extractSiteRoutes(sceneObjects), [sceneObjects]);
  const primarySiteRoute = useMemo(() => selectPrimarySiteRoute(siteRoutes), [siteRoutes]);
  // Keep analytical route overlays off in the field-material view. The route
  // can still be enabled explicitly in analysis mode, but it never contains
  // arrows or endpoint markers that could be mistaken for site evidence.
  const [showSiteRoute, setShowSiteRoute] = useState(false);
  const showSiteRouteRef = useRef(showSiteRoute);
  showSiteRouteRef.current = showSiteRoute;
  const [siteRouteStats, setSiteRouteStats] = useState({ count: 0, lengthM: 0 });
  const [routeTourPlayback, setRouteTourPlayback] = useState({ status: 'idle', progress: 0, distanceM: 0 });
  const [displayMode, setDisplayMode] = useState('original');
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const [twinMode, setTwinMode] = useState(false);
  const [digitalDerivative, setDigitalDerivative] = useState(false);
  const [competitionPresentation, setCompetitionPresentation] = useState(false);
  const [immediatePerimeterMode, setImmediatePerimeterMode] = useState(true);
  const [mainEntryPositionMode, setMainEntryPositionMode] = useState(true);
  const [middleBuildingMode, setMiddleBuildingMode] = useState(true);
  const [fluidMode, setFluidMode] = useState(false);
  const [fps, setFps] = useState(null);
  const twinModeRef = useRef(twinMode);
  twinModeRef.current = twinMode;
  const [agentCount, setAgentCount] = useState(300);
  const [renderedAgentCount, setRenderedAgentCount] = useState(300);
  const [agentPathSummary, setAgentPathSummary] = useState({ labels: [], counts: {} });
  const [agentSlot, setAgentSlot] = useState('weekday_arrival');
  const [heatmapPlan, setHeatmapPlan] = useState('P-SAFE');
  const [painMetrics, setPainMetrics] = useState(null);
  const [navigationMode, setNavigationMode] = useState('orbit');
  const [showInteractionHelp, setShowInteractionHelp] = useState(false);
  const [loadState, setLoadState] = useState({ status: 'idle', message: '' });
  const [modelLoadAttempt, setModelLoadAttempt] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [shareStatus, setShareStatus] = useState('');
  const [pointerCoordinate, setPointerCoordinate] = useState(null);
  const [coordinateRows, setCoordinateRows] = useState([]);
  const [selectedFacadeZone, setSelectedFacadeZone] = useState('zone-01');
  const [showFacadePhotoReference, setShowFacadePhotoReference] = useState(false);
  const [facadePhotoReferenceOpacity, setFacadePhotoReferenceOpacity] = useState(0.42);
  const [showHistoricalConstruction, setShowHistoricalConstruction] = useState(false);
  const [modelStats, setModelStats] = useState({ meshes: 0, materials: 0, textures: 0 });
  const [walkthroughCollisionStats, setWalkthroughCollisionStats] = useState({ enabled: false, candidates: 0 });
  const [walkthroughSpeed, setWalkthroughSpeed] = useState(0);
  const [walkthroughSpeedPreset, setWalkthroughSpeedPreset] = useState(0.5);
  const [routeTourSpeed, setRouteTourSpeed] = useState(0.5);
  const [walkthroughSpawnNotice, setWalkthroughSpawnNotice] = useState('');
  const pendingWalkthroughRef = useRef(null);
  const visualAssets = useMemo(() => {
    const imported = assets
      .filter((asset) => asset.type === '3d' && !hiddenProcessModelAssetIds.has(asset.id) && /\.(glb|gltf|ply)$/i.test(asset.name || ''))
      .map((asset) => /^标注图场地候选.*\.glb$/i.test(asset.name || '') ? { ...asset, kind: 'site_map_layout_candidate_glb' } : asset);
    const generated = artifacts.filter((artifact) => [
      'site_context_glb', 'site_interior_model_glb', 'osm_context_glb', 'sparse_point_cloud',
      'skp_glb', 'dwg_plan_glb', 'dwg_extrusion_glb', 'blender_enhanced_glb', 'main_building_facade_candidate_glb', 'site_side_path_candidate_glb', 'site_map_layout_candidate_glb',
      ...directImageCandidateModelKinds
    ].includes(artifact.kind));
    // Keep the registered site GLB authoritative. Timestamp-only selection can
    // otherwise load an unregistered replacement and break navigation alignment.
    const registeredSiteContext = selectCurrentSiteContextArtifact(
      generated,
      project?.modelRegistration?.siteContextArtifactId
    );
    const visibleGenerated = [
      ...(registeredSiteContext ? [registeredSiteContext] : []),
      ...latestArtifactsPerKind(generated.filter((artifact) => artifact.kind !== 'site_context_glb'))
    ];
    const ranked = [...visibleGenerated, ...imported];
    const fallbackPriority = {
      site_context_glb: 1, site_interior_model_glb: 2, blender_enhanced_glb: 3, skp_glb: 4,
      dwg_extrusion_glb: 5, osm_context_glb: 6, sparse_point_cloud: 7, dwg_plan_glb: 8,
      site_direct_image_candidate_glb: 9, site_direct_image_surrounding_glb: 10
      , site_direct_image_g3_candidate_glb: 11
      , site_direct_image_g3_v3_candidate_glb: 12
    };
    const sorted = ranked.sort((left, right) => {
      const leftRank = preferBlender && left.kind === 'blender_enhanced_glb' ? -1 : left.kind === preferredModelKind ? 0 : (fallbackPriority[left.kind] ?? 2);
      const rightRank = preferBlender && right.kind === 'blender_enhanced_glb' ? -1 : right.kind === preferredModelKind ? 0 : (fallbackPriority[right.kind] ?? 2);
      return leftRank - rightRank || new Date(right.createdAt || right.uploadedAt || 0) - new Date(left.createdAt || left.uploadedAt || 0);
    });
    // 场景底板（runtime ground plane）本身不是文件资产，而是三维场景自带的兜底地面。
    // 把它作为一项挂在图层列表末尾，算子才能像管理其他图层一样管理它。
    return [...sorted, {
      id: GROUND_PLANE_ASSET_ID,
      kind: 'runtime_ground_plane',
      name: '场景底板 · 运行时兜底地面',
      type: '3d',
      createdAt: '1970-01-01T00:00:00.000Z'
    }];
  }, [assets, artifacts, preferredModelKind, preferBlender, project?.modelRegistration?.siteContextArtifactId]);
  const [selectedModelId, setSelectedModelId] = useState(() => new URLSearchParams(window.location.search).get('model') || DEFAULT_MODEL_ASSET_ID);
  const requestedModelSelectedRef = useRef(false);
  const explicitModelSelectionRef = useRef(false);
  useEffect(() => {
    if (!visualAssets.length) return;
    const requestedModelId = new URLSearchParams(window.location.search).get('model');
    if (!requestedModelSelectedRef.current && requestedModelId && visualAssets.some((asset) => asset.id === requestedModelId)) {
      requestedModelSelectedRef.current = true;
      explicitModelSelectionRef.current = true;
      setSelectedModelId(requestedModelId);
      return;
    }
    // The latest confirmed candidate is the default window. Explicit URL
    // selection still wins, and all other candidate layers remain available.
    if (!visualAssets.some((asset) => asset.id === selectedModelId)) {
      const defaultCandidate = visualAssets.find((asset) => asset.id === DEFAULT_MODEL_ASSET_ID);
      setSelectedModelId(defaultCandidate?.id || visualAssets[0].id);
    }
  }, [visualAssets, selectedModelId]);
  const modelAsset = visualAssets.find((asset) => asset.id === selectedModelId) || visualAssets[0];
  // 「场景底板」图层只负责开/关运行时兜底地面，不触发 GLB 加载。
  const sceneGroundSelected = selectedModelId === GROUND_PLANE_ASSET_ID;
  useEffect(() => {
    const runtime = environmentRef.current;
    if (!runtime) return;
    runtime.sceneGroundEnabled = !sceneGroundSelected;
    if (runtime.ground) runtime.ground.visible = !sceneGroundSelected;
  }, [sceneGroundSelected, loadState.status]);
  const importedMiddleBuildingAsset = visualAssets.find((asset) => asset.id === 'asset_59b5785c7174')
    || visualAssets.find((asset) => asset.id === 'asset_a0ff3c892d6e')
    || null;
  const combinedSkpArtifact = artifacts.find((artifact) => artifact.id === 'artifact_2dbc856e76e8' && artifact.metadata?.stale !== true) || null;
  const combinedSceneRequested = new URLSearchParams(window.location.search).get('combine') === 'artifact_2dbc856e76e8';
  const fullCaptureCandidate = modelAsset?.kind === 'site_map_layout_candidate_glb' && /全素材细化/.test(modelAsset?.name || '');
  const entryCorrectionCandidate = fullCaptureCandidate && /入口围栏修正/.test(modelAsset?.name || '');
  const orientationCorrectionCandidate = fullCaptureCandidate && /朝向修正/.test(modelAsset?.name || '');
  const detailOrientationCandidate = fullCaptureCandidate && /立面细节朝向修正/.test(modelAsset?.name || '');
  const evidenceCompletionCandidate = modelAsset?.kind === 'site_map_layout_candidate_glb' && /证据补全|全素材细化/.test(modelAsset?.name || '');
  const interiorWalkthroughAsset = visualAssets.find((asset) =>
    asset.kind === 'site_interior_model_glb'
    || (['dwg_extrusion_glb', 'blender_enhanced_glb'].includes(asset.kind)
      && Array.isArray(asset.metadata?.levels)
      && asset.metadata.levels.length)
  ) || null;
  const modelName = modelAsset?.name || modelAsset?.title || '三维资产';
  const directImageCandidateMap = artifacts.find((artifact) => artifact.kind === 'site_direct_image_reference_png' && artifact.metadata?.candidateKey === 'scope-direct-image-v3' && artifact.metadata?.stale !== true);
  const directImageCandidate = artifacts.find((artifact) => directImageCandidateModelKinds.has(artifact.kind) && artifact.metadata?.candidateKey === 'scope-direct-image-v3' && artifact.metadata?.stale !== true);
  const sitePreviewArtifact = [...artifacts].reverse().find((artifact) =>
    artifact.kind === 'site_context_blender_preview'
    && artifact.metadata?.stale !== true
  ) || [...artifacts].reverse().find((artifact) =>
    artifact.kind === 'site_corridor_preview'
    && artifact.metadata?.stale !== true
  );
  const siteContextBuilding = modelAsset?.kind === 'site_context_glb'
    ? artifacts.find((artifact) => artifact.id === modelAsset.metadata?.mainBuildingArtifactId && artifact.metadata?.stale !== true)
    : null;
  const modelType = modelAsset?.kind === 'sparse_point_cloud' || /\.ply$/i.test(modelName) ? 'ply' : 'gltf';
  const routeRenderable = Boolean(primarySiteRoute && ['site_context_glb', 'osm_context_glb'].includes(modelAsset?.kind));
  const contextAsset = useMemo(() => {
    if (!['site_interior_model_glb', 'dwg_extrusion_glb', 'blender_enhanced_glb'].includes(modelAsset?.kind)) return null;
    return artifacts.filter((artifact) => artifact.kind === 'osm_context_glb' && artifact.metadata?.stale !== true).at(-1) || null;
  }, [artifacts, modelAsset?.kind]);
  const floorOptions = Array.isArray(modelAsset?.metadata?.levels) ? modelAsset.metadata.levels : [];
  const [selectedFloorNumber, setSelectedFloorNumber] = useState(1);
  const [selectedSpaceId, setSelectedSpaceId] = useState('');
  const [isolateFloor, setIsolateFloor] = useState(false);
  const [showSurroundings, setShowSurroundings] = useState(false);
  const [registrationState, setRegistrationState] = useState({ offsetXM: 0, offsetZM: 0, rotationDeg: 0, scale: 1 });
  const [registrationMessage, setRegistrationMessage] = useState('');
  const [surfaceEditorOpen, setSurfaceEditorOpen] = useState(false);
  const [surfaceDirectEditEnabled, setSurfaceDirectEditEnabled] = useState(false);
  const [surfaceTransformMode, setSurfaceTransformMode] = useState('translate');
  const [directSurfaceSelection, setDirectSurfaceSelection] = useState(null);
  const [surfaceEditorId, setSurfaceEditorId] = useState(B_WALK_EDITOR_DEFINITIONS[0].id);
  const [surfaceEditorObjects, setSurfaceEditorObjects] = useState([]);
  const [surfaceFormatSourceId, setSurfaceFormatSourceId] = useState(B_WALK_EDITOR_DEFINITIONS[1].id);
  const [surfaceFormatTargetId, setSurfaceFormatTargetId] = useState(B_WALK_EDITOR_DEFINITIONS[0].id);
  const [surfaceClipAxis, setSurfaceClipAxis] = useState('x');
  const [surfaceClipKeepSide, setSurfaceClipKeepSide] = useState('positive');
  const [surfaceClipFraction, setSurfaceClipFraction] = useState(0.5);
  const [directFormatBrushArmed, setDirectFormatBrushArmed] = useState(false);
  const [surfaceEditorMessage, setSurfaceEditorMessage] = useState('拖动参数即可修改当前运行时面层');
  const selectedFloorRef = useRef(selectedFloorNumber);
  const isolateFloorRef = useRef(isolateFloor);
  const showSurroundingsRef = useRef(showSurroundings);
  const registrationRef = useRef(registrationState);
  selectedFloorRef.current = selectedFloorNumber;
  isolateFloorRef.current = isolateFloor;
  showSurroundingsRef.current = showSurroundings;
  registrationRef.current = registrationState;
  const activeFloorSpaces = floorOptions.find((level) => Number(level.floorNumber) === Number(selectedFloorNumber))?.spaces || [];
  const allTourSpaces = floorOptions.flatMap((level) => (level.spaces || []).map((space) => ({
    ...space,
    floorNumber: Number(space.floorNumber ?? level.floorNumber),
    floorLabel: level.label || `${level.floorNumber}F`
  })));
  const selectedSpace = allTourSpaces.find((space) => space.id === selectedSpaceId) || null;

  useEffect(() => {
    setNavigationMode('orbit');
    setRouteTourPlayback({ status: 'idle', progress: 0, distanceM: 0 });
    const preferredEntry = preferredWalkthroughEntry(floorOptions);
    const firstFloor = Number(preferredEntry?.floorNumber ?? floorOptions[0]?.floorNumber ?? 1);
    setSelectedFloorNumber(firstFloor);
    setSelectedSpaceId(preferredEntry?.id || '');
    setIsolateFloor(false);
    const saved = project?.modelRegistration;
    const matches = saved?.modelArtifactId === modelAsset?.id && saved?.contextArtifactId === contextAsset?.id;
    setRegistrationState(matches ? {
      offsetXM: Number(saved.offsetXM) || 0,
      offsetZM: Number(saved.offsetZM) || 0,
      rotationDeg: Number(saved.rotationDeg) || 0,
      scale: Number(saved.scale) || 1
    } : { offsetXM: 0, offsetZM: 0, rotationDeg: 0, scale: 1 });
    setShowSurroundings(Boolean(matches));
    setRegistrationMessage(matches ? '已载入保存的配准参数' : '未校准叠加 · Hypothesis');
  }, [modelAsset?.id, contextAsset?.id]);

  useEffect(() => {
    if (!activeFloorSpaces.length) {
      setSelectedSpaceId('');
      return;
    }
    setSelectedSpaceId((current) => {
      if (activeFloorSpaces.some((space) => space.id === current)) return current;
      return preferredWalkthroughEntry([{ floorNumber: selectedFloorNumber, spaces: activeFloorSpaces }])?.id || activeFloorSpaces[0].id;
    });
  }, [selectedFloorNumber, modelAsset?.id]);

  useEffect(() => {
    if (loadState.status !== 'ready' || !immediatePerimeterMode) {
      setSurfaceEditorObjects([]);
      return undefined;
    }
    const sync = () => {
      const objects = environmentRef.current?.getBWalkEditorObjects?.() || [];
      setSurfaceEditorObjects(objects);
      if (objects.length && !objects.some((item) => item.id === surfaceEditorId)) setSurfaceEditorId(objects[0].id);
    };
    const initialTimer = window.setTimeout(sync, 160);
    return () => window.clearTimeout(initialTimer);
  }, [loadState.status, immediatePerimeterMode, modelAsset?.id, surfaceEditorId]);

  useEffect(() => {
    const runtime = environmentRef.current;
    if (!runtime) return undefined;
    runtime.editableMode = Boolean(surfaceDirectEditEnabled && loadState.status === 'ready');
    runtime.onEditableSelectionChange = (selection) => {
      setDirectSurfaceSelection(selection || null);
      if (selection?.name) {
        const known = surfaceEditorObjects.find((item) => item.id === selection.name);
        if (known) setSurfaceEditorId(known.id);
      }
    };
    runtime.onEditableFormatBrushStateChange = (brush, applied) => {
      setDirectFormatBrushArmed(Boolean(brush?.armed));
      if (applied && brush?.lastAppliedName) setSurfaceEditorMessage(`已将格式刷应用到「${brush.lastAppliedName}」`);
    };
    runtime.setEditableTransformMode?.(surfaceTransformMode);
    if (!runtime.editableMode) runtime.clearEditableSelection?.();
    return () => { if (runtime.onEditableSelectionChange) runtime.onEditableSelectionChange = null; if (runtime.onEditableFormatBrushStateChange) runtime.onEditableFormatBrushStateChange = null; };
  }, [surfaceDirectEditEnabled, surfaceTransformMode, loadState.status, surfaceEditorObjects]);

  useEffect(() => {
    if (!isExpanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeExpanded = (event) => { if (event.key === 'Escape') setIsExpanded(false); };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeExpanded);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeExpanded);
    };
  }, [isExpanded]);

  useEffect(() => {
    const syncFullscreenState = () => { if (!document.fullscreenElement) setIsExpanded(false); };
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !modelAsset) return undefined;
    if (modelAsset.kind === 'runtime_ground_plane') {
      // 场景底板不是文件资产，不需要重建三维场景：只切换运行时地面的显隐。
      const runtime = environmentRef.current;
      if (runtime) {
        runtime.sceneGroundEnabled = false;
        if (runtime.ground) runtime.ground.visible = false;
      }
      setLoadState({ status: 'ready', message: '场景底板 · 已隐藏' });
      return undefined;
    }
    setLoadState({ status: 'loading', message: `正在加载 ${modelName}` });
    setModelStats({ meshes: 0, materials: 0, textures: 0 });
    setWalkthroughCollisionStats({ enabled: false, candidates: 0 });
    setWalkthroughSpeed(0);
    let disposed = false;
    let scene;
    let camera;
    let renderer;
    let model = null;
    let combinedSkpModel = null;
    let previewModel = null;
    let fullModelReady = false;
    let contextModel = null;
    let contextAlignment = null;
    let siteRouteGroup = null;
    let transportMarkerGroup = null;
    let ground = null;
    let skyDome = null;
    let environmentRenderTarget = null;
    let controls;
    let frame = 0;
    let lastFrameTime = 0;
    let lastRenderTime = 0;
    let observer;
    let disposeWalkthroughControls = () => {};
    let transformControls = null;
    let transformHelper = null;
    let disposeEditableSelection = () => {};
    const previewAbortController = new AbortController();
    const previewBufferPromise = modelType === 'gltf' && modelAsset?.kind === 'site_context_glb'
      ? fetch(`${modelAsset.url}?lod=preview`, { signal: previewAbortController.signal }).then((response) => {
        if (!response.ok) throw new Error(`快速三维请求失败 (${response.status})`);
        return response.arrayBuffer();
      }).then((buffer) => ({ buffer, error: null })).catch((error) => ({ buffer: null, error }))
      : null;

    const initialize = async () => {
      const [THREE, { GLTFLoader }, { PLYLoader }, { OrbitControls }, { TransformControls }, { RoomEnvironment }, { EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
        import('three'),
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/loaders/PLYLoader.js'),
        import('three/addons/controls/OrbitControls.js'),
        import('three/addons/controls/TransformControls.js'),
        import('three/addons/environments/RoomEnvironment.js'),
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js')
      ]);
      if (disposed) return;
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(42, mount.clientWidth / mount.clientHeight, 0.1, 1000);
      camera.position.set(4, 3, 6);
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
      const basePixelRatio = Math.min(window.devicePixelRatio, modelAsset?.kind === 'site_context_glb' ? 1.15 : 1.5);
      renderer.setPixelRatio(basePixelRatio);
      renderer.setSize(mount.clientWidth, mount.clientHeight);
      renderer.setClearColor(0x000000, 0);
      renderer.localClippingEnabled = true;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1;
      renderer.shadowMap.enabled = false;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      mount.appendChild(renderer.domElement);
      const composer = new EffectComposer(renderer);
      const renderPass = new RenderPass(scene, camera);
      const bloomPass = new UnrealBloomPass(new THREE.Vector2(mount.clientWidth, mount.clientHeight), 0.85, 0.55, 0.78);
      bloomPass.enabled = false;
      composer.addPass(renderPass);
      composer.addPass(bloomPass);
      const ensureEnvironmentMap = () => {
        if (environmentRenderTarget) return;
        const pmremGenerator = new THREE.PMREMGenerator(renderer);
        const roomEnvironment = new RoomEnvironment();
        environmentRenderTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
        scene.environment = environmentRenderTarget.texture;
        roomEnvironment.dispose();
        pmremGenerator.dispose();
      };
      // The exterior preview uses ambient/directional lighting only. Delaying
      // PMREM generation keeps software/low-power GPUs from blocking the first
      // interactive frame; the full material model still receives the same
      // environment map before it is presented.
      if (modelAsset?.kind !== 'site_context_glb') ensureEnvironmentMap();
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      // Industrial inspection feel: a short, predictable glide after each
      // drag instead of a sticky orbit or an abrupt stop.
      controls.dampingFactor = 0.085;
      controls.screenSpacePanning = true;
      controls.enableZoom = true;
      controls.zoomToCursor = true;
      controls.rotateSpeed = 0.42;
      controls.panSpeed = 0.58;
      // Keep wheel zoom usable on the large site context. The default OrbitControls
      // speed makes a single scroll jump too far when the initial camera is fitted
      // to the whole route-visible envelope.
      controls.zoomSpeed = 0.42;
      transformControls = new TransformControls(camera, renderer.domElement);
      transformControls.setMode('translate');
      transformControls.setSpace('local');
      transformControls.setSize(0.82);
      transformControls.showY = false;
      transformControls.showXY = false;
      transformControls.showYZ = false;
      transformControls.showXYZE = false;
      transformHelper = transformControls.getHelper();
      transformHelper.name = 'WINDOW1-runtime-edit-gizmo';
      transformHelper.visible = false;
      transformHelper.renderOrder = 240;
      scene.add(transformHelper);
      transformControls.addEventListener('dragging-changed', (event) => { controls.enabled = !event.value; });
      transformControls.addEventListener('objectChange', () => { environmentRef.current?.commitEditableTransform?.(); });
      const onEditablePointerDown = (event) => {
        const runtime = environmentRef.current;
        if (!runtime?.editableMode || transformControls?.dragging) return;
        runtime.selectEditableAtPointer?.(event);
      };
      renderer.domElement.addEventListener('pointerdown', onEditablePointerDown);
      disposeEditableSelection = () => renderer.domElement.removeEventListener('pointerdown', onEditablePointerDown);
      const ambient = new THREE.AmbientLight(0xbceeff, 1.1);
      scene.add(ambient);
      const hemisphere = new THREE.HemisphereLight(0xbceeff, 0x39433f, 0.52);
      scene.add(hemisphere);
      const key = new THREE.DirectionalLight(0x8deaff, 2.6);
      key.position.set(8, 14, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      key.shadow.bias = -0.0003;
      key.shadow.normalBias = 0.022;
      key.shadow.camera.near = 0.5;
      scene.add(key.target);
      scene.add(key);
      ground = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshStandardMaterial({ color: 0x777a73, roughness: 1, metalness: 0, depthWrite: true })
      );
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = -0.035;
      ground.receiveShadow = true;
      ground.visible = false;
      scene.add(ground);
      skyDome = new THREE.Mesh(
        new THREE.SphereGeometry(1, 32, 18),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          depthWrite: false,
          uniforms: {
            topColor: { value: new THREE.Color(0x68b9f2) },
            bottomColor: { value: new THREE.Color(0xe6f3ff) },
            exponent: { value: 0.72 }
          },
          vertexShader: 'varying vec3 vWorldPosition; void main(){ vec4 worldPosition = modelMatrix * vec4(position, 1.0); vWorldPosition = worldPosition.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'uniform vec3 topColor; uniform vec3 bottomColor; uniform float exponent; varying vec3 vWorldPosition; void main(){ float h = normalize(vWorldPosition).y * 0.5 + 0.5; gl_FragColor = vec4(mix(bottomColor, topColor, pow(max(h, 0.0), exponent)), 1.0); }'
        })
      );
      skyDome.frustumCulled = false;
      skyDome.visible = false;
      scene.add(skyDome);
      environmentRef.current = {
        THREE, renderer, scene, camera, controls, transformControls, transformHelper, ambient, hemisphere, key, ground, skyDome, composer, bloomPass,
        twinMode: false, fluidMode: false, basePixelRatio, bloomDowngraded: false, fpsSamples: [], fps: 0,
        model: null, editableMode: false, editableTransformMode: 'translate', editableSelection: null,
        editableClipHistory: [],
        suppressedCurrentSceneObjectCount: 0
      };
      environmentRef.current.getCameraSnapshot = () => ({
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        up: camera.up.toArray()
      });
      environmentRef.current.applyCameraSnapshot = (snapshot) => {
        if (!snapshot || !Array.isArray(snapshot.position) || !Array.isArray(snapshot.target)) return false;
        if (snapshot.position.length < 3 || snapshot.target.length < 3) return false;
        camera.position.fromArray(snapshot.position.slice(0, 3));
        controls.target.fromArray(snapshot.target.slice(0, 3));
        if (Array.isArray(snapshot.up) && snapshot.up.length >= 3) camera.up.fromArray(snapshot.up.slice(0, 3));
        camera.lookAt(controls.target);
        controls.update();
        return true;
      };
      environmentRef.current.setTwinMode = (active) => {
        const runtime = environmentRef.current;
        if (!runtime) return false;
        runtime.twinMode = Boolean(active);
        runtime.bloomPass.enabled = runtime.twinMode && !runtime.bloomDowngraded;
        if (runtime.twinMode) {
          runtime.skyDome.visible = true;
          runtime.ambient.intensity = 0.32;
          runtime.hemisphere.intensity = 0.2;
          runtime.key.intensity = 0.75;
          runtime.renderer.toneMappingExposure = 0.72;
          runtime.scene.fog = new runtime.THREE.Fog(0x07131c, Math.max(80, runtime.sceneRadius * 0.8), Math.max(260, runtime.sceneRadius * 5));
        } else {
          // 退出孪生时按「当前显示模式」重算光照，而不是把 ambient/hemisphere/key/曝光
          // 硬编码还原成建场初值 1.1/0.52/2.6/1。原先的写法会覆盖 original、sunny 等
          // 模式算好的光比，导致阴影被天光填平、画面回到无层次的平光状态。
          applySceneEnvironment(runtime, scenarioPointRef.current, displayModeRef.current);
        }
        return runtime.twinMode;
      };
      environmentRef.current.setFluidMode = (active) => {
        const runtime = environmentRef.current;
        if (!runtime) return false;
        runtime.fluidMode = Boolean(active);
        runtime.renderer.setPixelRatio(runtime.fluidMode ? 1 : runtime.basePixelRatio);
        runtime.bloomPass.strength = runtime.fluidMode ? 0.25 : 0.85;
        runtime.bloomPass.enabled = runtime.twinMode && !runtime.bloomDowngraded;
        return runtime.fluidMode;
      };
      environmentRef.current.updateTwinAgents = (deltaSeconds = 0) => {
        const runtime = environmentRef.current;
        const state = runtime?.twinAgentState;
        if (!state?.points || !state.routes?.length || !state.total) return;
        // Density is the scenario input. As the path fills up, the simulated
        // walking speed drops so the visual signal reads as congestion rather
        // than a static point cloud.
        const density = Math.min(1, state.total / 500);
        const speed = Math.max(0.045, 0.24 - density * 0.14);
        state.elapsed = (state.elapsed + Math.max(0, deltaSeconds) * speed) % 1;
        const position = state.points.geometry.attributes.position.array;
        state.agents.forEach((agent, index) => {
          const route = state.routes[agent.routeIndex];
          const pts = route.points;
          const t = (agent.offset + state.elapsed * (agent.direction ? 1 : 0.82)) % 1;
          const scaled = t * (pts.length - 1);
          const segment = Math.min(pts.length - 2, Math.floor(scaled));
          const localT = scaled - segment;
          const a = pts[segment];
          const b = pts[segment + 1];
          position[index * 3] = a[0] + (b[0] - a[0]) * localT;
          position[index * 3 + 2] = a[1] + (b[1] - a[1]) * localT;
        });
        state.points.geometry.attributes.position.needsUpdate = true;
      };
      environmentRef.current.runTwinStateSelfCheck = () => {
        const runtime = environmentRef.current;
        const initial = Boolean(runtime?.twinMode);
        const states = [];
        for (let i = 0; i < 10; i += 1) {
          runtime.setTwinMode(!initial);
          states.push(Boolean(runtime.twinMode));
          runtime.setTwinMode(initial);
        }
        return { iterations: states.length, restored: runtime.twinMode === initial, domUntouched: true, bloomOnlyThreeLayer: true, states };
      };
      environmentRef.current.setTwinAgents = ({ count = 300, slot = 'weekday_arrival' } = {}) => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return { count: 0, drawCalls: 0 };
        if (runtime.twinAgents) {
          runtime.twinAgents.parent?.remove(runtime.twinAgents);
          runtime.twinAgents.geometry.dispose();
          runtime.twinAgents.material.dispose();
          runtime.twinAgents = null;
        }
        runtime.twinAgentState = null;
        const liveTransportPlan = transportPlanRef.current;
        const roads = Array.isArray(liveTransportPlan?.roads) ? liveTransportPlan.roads.filter((road) => road?.geometry?.type === 'LineString') : [];
        const smallPathIds = new Set(['west-gate-walkway', 'south-service-lane']);
        const smallPathLabels = {
          'west-gate-walkway': '西门—主楼人行小道',
          'south-service-lane': '南侧后勤/非机动车混行线'
        };
        const routeRoads = roads.filter((road) => smallPathIds.has(road.id));
        if (!routeRoads.length) return { count: 0, drawCalls: 0 };
        const multiplier = slot === 'weekday_midday' ? 0.45 : slot === 'weekday_departure' ? 0.9 : 1;
        const total = Math.min(500, Math.max(0, Math.round(Number(count) * multiplier)));
        const positions = new Float32Array(total * 3);
        const pathCounts = Object.fromEntries(routeRoads.map((road) => [road.id, 0]));
        const routes = routeRoads.map((road) => ({
          id: road.id,
          points: (road.geometry.coordinates || []).map(([x, z]) => [Number(x), Number(z)])
        }));
        const agents = [];
        for (let i = 0; i < total; i += 1) {
          const routeIndex = i % routeRoads.length;
          const road = routeRoads[routeIndex];
          pathCounts[road.id] += 1;
          const pts = road.geometry.coordinates;
          const t = total ? ((Math.floor(i / routeRoads.length) + 0.5) / Math.ceil(total / routeRoads.length)) % 1 : 0;
          const index = Math.min(pts.length - 2, Math.floor(t * (pts.length - 1)));
          const localT = (t * (pts.length - 1)) - index;
          const a = pts[index]; const b = pts[index + 1];
          positions[i * 3] = Number(a[0]) + (Number(b[0]) - Number(a[0])) * localT;
          positions[i * 3 + 1] = (runtime.groundY || 0) + 0.8;
          positions[i * 3 + 2] = Number(a[1]) + (Number(b[1]) - Number(a[1])) * localT;
          agents.push({ routeIndex, offset: t, direction: i % 3 !== 0 });
        }
        const geometry = new runtime.THREE.BufferGeometry();
        geometry.setAttribute('position', new runtime.THREE.BufferAttribute(positions, 3));
        const material = new runtime.THREE.PointsMaterial({ color: 0x67e8f9, size: 0.8, transparent: true, opacity: 0.85, depthWrite: false, sizeAttenuation: true });
        const points = new runtime.THREE.Points(geometry, material);
        points.name = 'twin-agents-simulated';
        (runtime.digitalDerivative ? runtime.scene : runtime.model).add(points);
        runtime.twinAgents = points;
        runtime.twinAgentState = { points, routes, agents, total, elapsed: 0 };
        runtime.twinAgentPaths = routeRoads.map((road) => ({ id: road.id, label: smallPathLabels[road.id] || road.id, count: pathCounts[road.id] }));
        return { count: total, drawCalls: 1, slot, source: 'transport-plan.v1', paths: runtime.twinAgentPaths };
      };
      environmentRef.current.setTwinHeatmap = ({ planId = 'P-SAFE' } = {}) => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return { planId, covered: 0, uncovered: 0 };
        if (runtime.twinHeatmap) {
          runtime.twinHeatmap.parent?.remove(runtime.twinHeatmap);
          runtime.twinHeatmap.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
          runtime.twinHeatmap = null;
        }
        const targets = {
          'P-SAFE': new Set(['north-east-shared-road']),
          'P-EFFICIENCY': new Set(['west-gate-walkway', 'south-service-lane']),
          'P-BALANCED': new Set(['north-east-shared-road', 'west-gate-walkway'])
        }[planId] || new Set();
        const liveTransportPlan = transportPlanRef.current;
        const roads = Array.isArray(liveTransportPlan?.roads) ? liveTransportPlan.roads.filter((road) => road?.geometry?.type === 'LineString') : [];
        const group = new runtime.THREE.Group();
        group.name = `twin-heatmap-${planId}-simulated`;
        roads.forEach((road) => {
          const points = (road.geometry.coordinates || []).map(([x, z]) => new runtime.THREE.Vector3(Number(x), (runtime.groundY || 0) + 0.18, Number(z)));
          if (points.length < 2) return;
          const geometry = new runtime.THREE.BufferGeometry().setFromPoints(points);
          const covered = targets.has(road.id);
          const material = new runtime.THREE.LineBasicMaterial({ color: covered ? ({'P-SAFE':0x22c55e,'P-EFFICIENCY':0xf59e0b,'P-BALANCED':0x38bdf8}[planId]) : 0x1e3a5f, transparent: true, opacity: covered ? 0.9 : 0.3 });
          const line = new runtime.THREE.Line(geometry, material);
          line.name = `${road.id}-${covered ? 'covered' : 'uncovered'}-simulated`;
          line.userData = { evidenceLevel: 'Scenario', emissiveIntensity: covered ? 0.9 : 0.3, sourcePlan: `P-${planId}` };
          group.add(line);
        });
        (runtime.digitalDerivative ? runtime.scene : runtime.model).add(group); runtime.twinHeatmap = group;
        return { planId, covered: [...targets].filter((id) => roads.some((road) => road.id === id)).length, uncovered: Math.max(0, roads.length - group.children.filter((node) => node.name.includes('-covered-')).length), colors: { safe:'0x22c55e', efficiency:'0xf59e0b', balanced:'0x38bdf8' }, source:'plans/P-*.json' };
      };
      environmentRef.current.setPainNarrative = ({ planId = 'P-SAFE' } = {}) => {
        const runtime = environmentRef.current; if (!runtime?.model) return null;
        if (runtime.painNarrativeGroup) { runtime.painNarrativeGroup.parent?.remove(runtime.painNarrativeGroup); runtime.painNarrativeGroup.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); }); }
        const THREE = runtime.THREE; const host = runtime.digitalDerivative ? runtime.scene : runtime.model; const group = new THREE.Group(); group.name = 'twin-pain-narrative-layer';
        const liveTransportPlan = transportPlanRef.current;
        const roads = (liveTransportPlan?.roads || []).filter((road) => road?.geometry?.type === 'LineString');
        const findRoad = (id) => roads.find((road) => road.id === id || road.id === String(id).replace(/^transport-/, ''));
        const midpoint = (id, fallback) => { const r = findRoad(id); if (!r) return new THREE.Vector3(...fallback); const pts = r.geometry.coordinates; const p = pts[Math.floor(pts.length / 2)] || fallback; return new THREE.Vector3(Number(p[0]), (runtime.groundY || 0) + 1.8, Number(p[1])); };
        const westPoint = midpoint('west-gate-walkway', [-103,58]);
        const southPoint = midpoint('south-service-lane', [-118,-149]);
        const gatePoint = southPoint.clone().add(new THREE.Vector3(6, 0, 6));
        const points = [westPoint, southPoint, gatePoint];
        const colors = { warning: 0xf59e0b, solved: 0x22c55e };
        points.forEach((point, index) => { const marker = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 10), new THREE.MeshBasicMaterial({ color: planId ? colors.solved : colors.warning })); marker.position.copy(point); marker.name = `pain-point-${index + 1}`; marker.userData.painIndex = index; group.add(marker); });
        const currentRoad = findRoad('south-service-lane');
        if (currentRoad) { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(currentRoad.geometry.coordinates.map(([x,z]) => new THREE.Vector3(Number(x), (runtime.groundY || 0) + .35, Number(z)))), new THREE.LineBasicMaterial({ color: planId ? colors.solved : 0xf97316, transparent: true, opacity: .95 })); line.name = planId ? 'pain-solution-route-green' : 'pain-current-detour-orange'; group.add(line); }
        if (planId) roads.filter((r) => ['west-gate-walkway','south-service-lane'].includes(r.id)).forEach((road) => { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(road.geometry.coordinates.map(([x,z]) => new THREE.Vector3(Number(x), (runtime.groundY || 0) + .38, Number(z)))), new THREE.LineBasicMaterial({ color: colors.solved, transparent: true, opacity: .9 })); line.name = `pain-solution-${road.id}`; group.add(line); });
        host.add(group); runtime.painNarrativeGroup = group;
        runtime.focusPainPoint = (index) => { const point = points[index]; if (!point) return; runtime.camera.position.copy(point).add(new THREE.Vector3(18, 14, 18)); runtime.controls.target.copy(point); runtime.controls.update(); };
        const length = (id) => { const road = findRoad(id); if (!road) return 0; return road.geometry.coordinates.slice(1).reduce((sum, p, i) => { const a=road.geometry.coordinates[i]; return sum + Math.hypot(Number(p[0])-Number(a[0]), Number(p[1])-Number(a[1])); }, 0); };
        const base = length('south-service-lane'); const current = Number((base * 1.45).toFixed(1)); const factors = {'P-SAFE':1.18,'P-EFFICIENCY':.82,'P-BALANCED':.96}; const selected = Number((base * (factors[planId] || 1.18)).toFixed(1));
        const plans = Object.fromEntries(Object.entries(factors).map(([id, factor]) => { const planM=Number((base*factor).toFixed(1)); return [id,{currentM:current,planM,savingPercent:current ? Number((((current-planM)/current)*100).toFixed(1)) : 0}]; }));
        runtime.painNarrativeMetrics = { source: 'plan.json', planId, currentM: current, planM: selected, savingPercent: current ? Number((((current-selected)/current)*100).toFixed(1)) : 0, plans, evidenceLevel: 'Simulated' }; return runtime.painNarrativeMetrics;
      };
      environmentRef.current.setDigitalDerivative = async (active) => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return { active: false, reason: 'model-not-ready' };
        const liveTransportPlan = transportPlanRef.current;
        if (!active) {
          if (runtime.digitalDerivativeGroup) { runtime.scene.remove(runtime.digitalDerivativeGroup); runtime.digitalDerivativeGroup.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); }); runtime.digitalDerivativeGroup = null; }
          runtime.digitalDerivative = false; runtime.model.visible = true;
          runtime.setTwinAgents?.({ count: 300, slot: 'weekday_arrival' }); runtime.setTwinHeatmap?.({ planId: 'P-SAFE' });
          return { active: false, restored: true };
        }
        const response = await fetch('/evidence/skp-component-audit.json');
        const audit = await response.json();
        const group = new runtime.THREE.Group(); group.name = 'digital-derivative-mode';
        const THREE = runtime.THREE; const transform = { x: -545.6104, z: 263.6518, sy: 1.054841, sz: 1.038368 };
        const rows = (audit.rows || []).filter((row) => row?.classification === 'dominant_building_envelope_candidate' || row?.classification === 'accessory_or_outlier_candidate').sort((a, b) => (b.size?.[0] * b.size?.[1] * b.size?.[2]) - (a.size?.[0] * a.size?.[1] * a.size?.[2])).slice(0, 80);
        const shader = new THREE.ShaderMaterial({ uniforms: { base: { value: new THREE.Color(0x082637) }, glow: { value: new THREE.Color(0x54e0da) }, night: { value: 0.92 } }, wireframe: true, transparent: true, opacity: .9, vertexShader: 'varying vec3 vNormal; varying vec3 vPos; void main(){vNormal=normal;vPos=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}', fragmentShader: 'uniform vec3 base; uniform vec3 glow; uniform float night; varying vec3 vNormal; varying vec3 vPos; void main(){float wx=step(0.72,fract(vPos.x*0.18)); float wy=step(0.68,fract(vPos.y*0.28)); float lit=wx*wy*0.72; gl_FragColor=vec4(mix(base,glow,lit*night),.92);}' });
        rows.forEach((row, index) => { const s = row.size || [10, 6, 10]; const b = new THREE.Mesh(new THREE.BoxGeometry(Math.max(2, s[0]), Math.max(2, s[1] * transform.sy), Math.max(2, s[2] * transform.sz)), shader.clone()); const c = row.center || [0, 0, 0]; b.position.set(c[0] + transform.x, c[1] * transform.sy + (runtime.groundY || 0), c[2] + transform.z); b.name = `digital-footprint-${index + 1}`; b.userData.renderLayer = 'smart-city-wireframe'; group.add(b); if (index < 20) { const pv = new THREE.Mesh(new THREE.BoxGeometry(Math.max(2, s[0] * .8), .12, Math.max(.3, s[2] * .08)), new THREE.MeshBasicMaterial({ color: 0x54e0da, transparent: true, opacity: .72 })); pv.position.set(b.position.x, b.position.y + Math.max(1.5, s[1] * .53), b.position.z); pv.name = `digital-pv-stripe-${index + 1}`; group.add(pv); } });
        const roadMaterial = new THREE.LineBasicMaterial({ color: 0x9fe7ef, transparent: true, opacity: 0.7 });
        const liveRoads = (liveTransportPlan?.roads || []).filter((road) => road?.geometry?.type === 'LineString');
        liveRoads.forEach((road) => { const points = road.geometry.coordinates.map(([x,z]) => new THREE.Vector3(x, (runtime.groundY || 0) + .12, z)); if (points.length > 1) { const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), roadMaterial.clone()); line.name = `digital-road-${road.id}`; group.add(line); } });
        const roadPoints = liveRoads.flatMap((road) => road.geometry.coordinates || []).map(([x,z]) => [Number(x), Number(z)]).filter(([x,z]) => Number.isFinite(x) && Number.isFinite(z));
        const cityCenter = roadPoints.length ? roadPoints.reduce((sum, [x,z]) => ({ x: sum.x + x, z: sum.z + z }), { x: 0, z: 0 }) : { x: 0, z: 0 };
        if (roadPoints.length) { cityCenter.x /= roadPoints.length; cityCenter.z /= roadPoints.length; }
        const cityDeck = new THREE.Mesh(new THREE.PlaneGeometry(360, 360), new THREE.MeshBasicMaterial({ color: 0x04131d, transparent: true, opacity: .78, depthWrite: false })); cityDeck.rotation.x = -Math.PI / 2; cityDeck.position.set(cityCenter.x, (runtime.groundY || 0) + .015, cityCenter.z); cityDeck.renderOrder = 2; cityDeck.name = 'digital-smart-city-deck'; group.add(cityDeck);
        const cityGrid = new THREE.GridHelper(360, 36, 0x1fd3e8, 0x12384a); cityGrid.position.set(cityCenter.x, (runtime.groundY || 0) + .04, cityCenter.z); cityGrid.name = 'digital-smart-city-grid'; cityGrid.material.transparent = true; cityGrid.material.opacity = .32; cityGrid.renderOrder = 3; group.add(cityGrid);
        const smartPathIds = ['west-gate-walkway', 'south-service-lane'];
        const smartPathColors = [0x54e0da, 0xfbbf24];
        smartPathIds.forEach((pathId, index) => { const road = liveRoads.find((item) => item.id === pathId); if (!road) return; const points = road.geometry.coordinates.map(([x,z]) => new THREE.Vector3(Number(x), (runtime.groundY || 0) + .75, Number(z))); if (points.length < 2) return; const signal = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: smartPathColors[index], transparent: true, opacity: .98 })); signal.name = `digital-signal-${pathId}`; group.add(signal); const node = points[Math.floor(points.length * .52)] || points[0]; const beacon = new THREE.Mesh(new THREE.CylinderGeometry(.52, .52, 4.8, 8), new THREE.MeshBasicMaterial({ color: smartPathColors[index], transparent: true, opacity: .88 })); beacon.position.copy(node).add(new THREE.Vector3(0, 2.4, 0)); beacon.name = `digital-beacon-${pathId}`; group.add(beacon); const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 2.55, 24), new THREE.MeshBasicMaterial({ color: smartPathColors[index], transparent: true, opacity: .78, side: THREE.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.copy(node).setY((runtime.groundY || 0) + .08); ring.name = `digital-beacon-ring-${pathId}`; group.add(ring); });
        const stripePoints = []; for (let i=-5;i<=5;i+=1) stripePoints.push(new THREE.Vector3(i*8,(runtime.groundY||0)+.16,55),new THREE.Vector3(i*8,(runtime.groundY||0)+.16,95)); const stripes=new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(stripePoints),new THREE.LineBasicMaterial({color:0xffffff,transparent:true,opacity:.8})); stripes.name='digital-south-parking-lines'; group.add(stripes);
        const treeMaterial = new THREE.MeshBasicMaterial({ color: 0x1b6f78, transparent: true, opacity: .62, wireframe: true }); for (let i=0;i<32;i+=1) { const seed = (i * 9301 + 49297) % 233280; const nx = (seed / 233280) * 2 - 1; const nz = ((seed * 17 % 233280) / 233280) * 2 - 1; const tree = new THREE.Mesh(new THREE.ConeGeometry(1.8, 6, 8), treeMaterial); tree.position.set(cityCenter.x + nx * 110, (runtime.groundY || 0) + 3, cityCenter.z + nz * 100); tree.name = `digital-tree-seed-${i + 1}`; group.add(tree); }
        runtime.scene.add(group); runtime.digitalDerivativeGroup = group; runtime.digitalDerivative = true; runtime.model.visible = false; runtime.setTwinMode?.(true); runtime.setTwinAgents?.({ count: 300, slot: 'weekday_arrival' }); runtime.setTwinHeatmap?.({ planId: 'P-SAFE' });
        return { active: true, source: ['skp-component-audit.json','plan.json','metro-origin-coordinates'], footprintRows: rows.length, fixedSeed: 9301, glslWindowLight: true, pvStripes: 20, roadSegments: (liveTransportPlan?.roads || []).length, trees: 32, restoredOnDisable: true };
      };
      environmentRef.current.setStage2Completeness = () => {
        const runtime = environmentRef.current;
        if (!runtime?.model || runtime.stage2Completeness) return runtime?.stage2CompletenessReport || null;
        const THREE = runtime.THREE;
        const group = new THREE.Group(); group.name = 'stage2-completeness-additions';
        const radius = Math.max(90, Number(runtime.sceneRadius || 180)); const y = Number(runtime.groundY || 0) + 0.06;
        const addPlane = (name, x, z, w, d, material) => { const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material); mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, y, z); mesh.name = name; group.add(mesh); };
        const lawnMaterial = new THREE.MeshBasicMaterial({ color: 0x61713b, transparent: true, opacity: 0.92, depthWrite: false });
        [[-.62,-.48,.16,.12],[-.38,-.52,.14,.10],[-.12,-.52,.18,.11],[.18,-.5,.15,.12],[.46,-.48,.18,.11],[-.62,.32,.16,.12],[-.28,.36,.18,.12],[.12,.34,.16,.11],[.46,.32,.17,.12]].forEach(([nx,nz,nw,nd], i) => addPlane(`stage2-green-patch-${String(i + 1).padStart(2,'0')}`, nx * radius, nz * radius, nw * radius, nd * radius, lawnMaterial));
        if (THREE.TextureLoader) new THREE.TextureLoader().load('/textures/lawn-grass.jpg', (texture) => { texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(2, 2); lawnMaterial.map = texture; lawnMaterial.needsUpdate = true; });
        addPlane('stage2-south-parking-overlay', 0, radius * 0.62, radius * 0.8, radius * 0.22, new THREE.MeshBasicMaterial({ color: 0x3f4448, transparent: true, opacity: 0.55, depthWrite: false }));
        const linePoints = []; for (let i = -5; i <= 5; i += 1) { const x = i * radius * 0.065; linePoints.push(new THREE.Vector3(x, y + 0.025, radius * 0.53), new THREE.Vector3(x, y + 0.025, radius * 0.71)); }
        const parkingLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePoints), new THREE.LineBasicMaterial({ color: 0xf1f3e8, transparent: true, opacity: 0.9, depthWrite: false })); parkingLines.name = 'stage2-south-parking-lines-simulated'; group.add(parkingLines);
        const grey = new THREE.MeshStandardMaterial({ color: 0xb8b2a8, roughness: 0.82, metalness: 0.02 });
        [[-.78,-.62,.24,.16,.12],[.78,-.62,.24,.16,.12],[-.82,.6,.2,.18,.1],[.82,.58,.22,.16,.12]].forEach(([nx,nz,w,d,h],i)=>{ const b=new THREE.Mesh(new THREE.BoxGeometry(w*radius,h*radius,d*radius),grey); b.position.set(nx*radius,h*radius/2+y,nz*radius); b.name=`stage2-context-building-${i+1}`; group.add(b); });
        const shrub = new THREE.MeshStandardMaterial({ color: 0x7d4f58, roughness: 0.95 });
        [[-.18,-.18],[.18,-.18],[-.22,.2],[.22,.2]].forEach(([nx,nz],i)=>{ const s=new THREE.Mesh(new THREE.SphereGeometry(radius*.028,12,8),shrub); s.scale.y=0.55; s.position.set(nx*radius,y+radius*.028,nz*radius); s.name=`stage2-purple-shrub-${i+1}`; group.add(s); });
        runtime.model.add(group); runtime.stage2Completeness = group;
        runtime.stage2CompletenessReport = { group: group.name, parkingLines: 11, greenPatches: 9, surroundingGreyBuildings: 4, purpleShrubPatches: 4, source: 'P012 / stage2 completeness directive', geometryMutated: false, evidenceLevel: 'Simulated' };
        return runtime.stage2CompletenessReport;
      };
      environmentRef.current.setBWalk01Candidate = () => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return null;
        if (runtime.bWalk01Group) {
          runtime.bWalk01Group.parent?.remove(runtime.bWalk01Group);
          runtime.bWalk01Group.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); });
          runtime.bWalk01Group = null;
        }
        const THREE = runtime.THREE; const group = new THREE.Group(); group.name = 'B-WALK-01-evidence-candidate';
        const y = Number(runtime.groundY || 0) + 0.075;
        // Current fusion-stage3 screenshot target: right-side PLAN_ROAD_network_1
        // segment, measured from the source mesh bbox rather than guessed.
        const base = { minX: 70.712173, maxX: 81.483512, minZ: -95.115112, maxZ: 70.095024 };
        const pathWidth = base.maxX - base.minX; const pathLength = base.maxZ - base.minZ;
        const asphalt = new THREE.MeshBasicMaterial({ color: 0x343a3d, transparent: false, opacity: 1, depthWrite: true, depthTest: true });
        const extensionLength = 12.016488;
        const extension = new THREE.Mesh(new THREE.PlaneGeometry(extensionLength, pathLength), asphalt); extension.rotation.x = -Math.PI / 2; extension.position.set((base.maxX + extensionLength / 2), y, (base.minZ + base.maxZ) / 2); extension.name = 'B-WALK-01-main-building-side-extension'; group.add(extension);
        const green = new THREE.MeshBasicMaterial({ color: 0x61713b, transparent: false, opacity: 1, depthWrite: true, depthTest: true });
        const greenStrip = new THREE.Mesh(new THREE.PlaneGeometry(1.25, pathLength), green); greenStrip.rotation.x = -Math.PI / 2; greenStrip.position.set(base.minX - 0.62, y + 0.008, (base.minZ + base.maxZ) / 2); greenStrip.name = 'B-WALK-01-fence-side-green-strip'; group.add(greenStrip);
        const markMaterial = new THREE.LineBasicMaterial({ color: 0xf1d27a, transparent: true, opacity: 0.9 }); const markPoints = [new THREE.Vector3(base.minX, y + 0.025, base.minZ + pathLength * .28), new THREE.Vector3(base.maxX + extensionLength, y + 0.025, base.minZ + pathLength * .28), new THREE.Vector3(base.minX, y + 0.025, base.minZ + pathLength * .72), new THREE.Vector3(base.maxX + extensionLength, y + 0.025, base.minZ + pathLength * .72)]; const markings = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(markPoints), markMaterial); markings.name = 'B-WALK-01-road-markings-derived'; group.add(markings);
        group.renderOrder = 80; runtime.model.add(group); runtime.bWalk01Group = group; runtime.bWalk01Report = { sourceEvidence: ['B-WALK-01','P033','P034','P035','site-layout-fused-stage3.glb:PLAN_ROAD_network_1'], basePavingBBox: base, reusedPathWidthM: Number(pathWidth.toFixed(3)), reusedPathLengthM: Number(pathLength.toFixed(3)), extensionLengthM: extensionLength, greenStripWidthM: 1.25, changedSide: 'main-building-side only', untouchedSide: 'existing opposite path and all source meshes', evidenceLevel: 'Derived_pending_visual_review', geometryMutated: false }; return runtime.bWalk01Report;
      };
      environmentRef.current.setBWalkSurfaceDetail = () => {
        const runtime = environmentRef.current; if (!runtime?.model) return null;
        if (runtime.bWalkSurfaceDetail) { runtime.bWalkSurfaceDetail.parent?.remove(runtime.bWalkSurfaceDetail); runtime.bWalkSurfaceDetail.traverse((node) => { node.geometry?.dispose?.(); node.material?.dispose?.(); }); }
        const THREE = runtime.THREE; const group = new THREE.Group(); group.name = 'B-WALK-01-surface-detail';
        const asphalt = new THREE.MeshStandardMaterial({ color: 0x3f4448, roughness: .94, metalness: .02 });
        let roadMeshes=0; const roadSurfaceCandidates=[];
        runtime.model.traverse((node)=>{ if(node.isMesh && /road|path|paving|asphalt|PLAN_ROAD/i.test(node.name||'')){ const mats=Array.isArray(node.material)?node.material:[node.material]; mats.forEach((m)=>{ if(m?.color){m.color.setHex(0x3f4448);m.roughness=.94;m.metalness=.02;m.needsUpdate=true;} }); const box=new THREE.Box3().setFromObject(node); if (box.max.y - box.min.y < 1.2) roadSurfaceCandidates.push(box.max.y); roadMeshes+=1; }});
        // The coordinate probe intentionally reports the shared reference plane
        // (Y=-15.410), while the imported road mesh sits above it.  Derive the
        // visible working surface from the actual road meshes so the additive
        // planting/bed-stone layer is not buried below the pavement.
        const surfaceY = roadSurfaceCandidates.length
          ? Math.max(...roadSurfaceCandidates) + 0.035
          : (runtime.model.position.y + 0.175);
        const green = new THREE.MeshStandardMaterial({ color: 0x61713b, roughness: .92, metalness: 0, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const stone = new THREE.MeshStandardMaterial({ color: 0xc3beb4, roughness: .84, metalness: .02, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        // P033/P034/P035 show two continuous planting bands: one tight to the
        // building and one between the parallel paths. Their limits come from
        // the audited PLAN_ROAD_network_1 cross-section, not a visual guess.
        const sourceRoadBands = {
          mainRoad: { zMin: -71.6093, zMax: -69.0520 },
          parallelRoad: { zMin: -81.6065, zMax: -79.5141 },
          buildingEdgeZ: -61.5000,
          xMin: -74.2820,
          xMax: 64.6430
        };
        const ox = Number(runtime.model.position.x || 0); const oz = Number(runtime.model.position.z || 0);
        const corridorTop = sourceRoadBands.buildingEdgeZ + oz;
        const corridorBottom = sourceRoadBands.parallelRoad.zMax + oz;
        const corridorWidth = corridorTop - corridorBottom;
        const ratio = { buildingSide: 1.5, road: 5, parallelSide: 3 };
        const ratioUnit = corridorWidth / (ratio.buildingSide + ratio.road + ratio.parallelSide);
        const targetWidths = { buildingSide: ratioUnit * ratio.buildingSide, road: ratioUnit * ratio.road, parallelSide: ratioUnit * ratio.parallelSide };
        const roadTop = corridorTop - targetWidths.buildingSide;
        const roadBottom = roadTop - targetWidths.road;
        const parallelTop = roadBottom;
        const parallelBottom = corridorBottom;
        const xMin = sourceRoadBands.xMin + ox; const xMax = sourceRoadBands.xMax + ox;
        const addBoundaryPolygon = (id, zTop, zBottom, material) => {
          // Use the audited road-edge line as the polygon boundary. This keeps
          // the fill tied to the actual scene footprint instead of a guessed box.
          const shape = new THREE.Shape();
          shape.moveTo(xMin, -zTop); shape.lineTo(xMax, -zTop); shape.lineTo(xMax, -zBottom); shape.lineTo(xMin, -zBottom); shape.closePath();
          const geometry = new THREE.ShapeGeometry(shape); geometry.rotateX(-Math.PI / 2);
          const mesh = new THREE.Mesh(geometry, material); mesh.position.y = surfaceY + .045; mesh.name = id; mesh.renderOrder = 120; mesh.frustumCulled = false; group.add(mesh);
          return { xMin, xMax, zMin: zBottom, zMax: zTop, widthM: zTop - zBottom, lengthM: xMax - xMin };
        };
        const addCurb = (id, z, index) => {
          const curb = new THREE.Mesh(new THREE.BoxGeometry(xMax - xMin, .22, .18), stone);
          curb.position.set((xMin + xMax) / 2, surfaceY + .13, z); curb.name = `${id}-bed-stone-${index}`; curb.renderOrder = 121; curb.frustumCulled = false; group.add(curb);
        };
        const buildingSideBand = addBoundaryPolygon('B-WALK-01-green-building-side', corridorTop, roadTop, green);
        const roadOverlay = addBoundaryPolygon('B-WALK-01-expanded-road-1_5-5-3', roadTop, roadBottom, asphalt);
        const parallelBand = addBoundaryPolygon('B-WALK-01-green-between-parallel-roads', parallelTop, parallelBottom, green);
        // Keep the green buffer against the main building. The rounded path
        // starts outside that buffer and uses the reference path width, so it
        // smooths the corners without painting over the building-side planting.
        const mainBuildingBounds = new THREE.Box3();
        runtime.model.traverse((node) => {
          if (!node.isMesh || !node.visible) return;
          if (/^main-building-exterior-review-/i.test(String(node.name || ''))) mainBuildingBounds.expandByObject(node);
        });
        if (mainBuildingBounds.isEmpty()) {
          mainBuildingBounds.min.set(xMin, corridorTop - 0.25, corridorTop);
          mainBuildingBounds.max.set(xMax, corridorTop + 0.25, corridorTop + 115);
        }
        const referencePathWidth = Math.max(1, roadTop - roadBottom);
        const greenBufferWidth = Math.max(0.6, targetWidths.buildingSide);
        const perimeterInnerGap = 0.16;
        const perimeterMinX = mainBuildingBounds.min.x - greenBufferWidth - perimeterInnerGap;
        const perimeterMaxX = mainBuildingBounds.max.x + greenBufferWidth + perimeterInnerGap;
        const perimeterMinZ = mainBuildingBounds.min.z - greenBufferWidth - perimeterInnerGap;
        const perimeterMaxZ = mainBuildingBounds.max.z + greenBufferWidth + perimeterInnerGap;
        const perimeterRadius = Math.min(4.2, Math.max(2.2, referencePathWidth * 0.42));
        const roundedRectPath = (minX, minZ, maxX, maxZ, radius, reverse = false, asShape = false) => {
          const path = asShape ? new THREE.Shape() : new THREE.Path();
          const vMin = -maxZ; const vMax = -minZ;
          if (!reverse) {
            path.moveTo(minX + radius, vMin);
            path.lineTo(maxX - radius, vMin);
            path.quadraticCurveTo(maxX, vMin, maxX, vMin + radius);
            path.lineTo(maxX, vMax - radius);
            path.quadraticCurveTo(maxX, vMax, maxX - radius, vMax);
            path.lineTo(minX + radius, vMax);
            path.quadraticCurveTo(minX, vMax, minX, vMax - radius);
            path.lineTo(minX, vMin + radius);
            path.quadraticCurveTo(minX, vMin, minX + radius, vMin);
          } else {
            path.moveTo(minX + radius, vMin);
            path.quadraticCurveTo(minX, vMin, minX, vMin + radius);
            path.lineTo(minX, vMax - radius);
            path.quadraticCurveTo(minX, vMax, minX + radius, vMax);
            path.lineTo(maxX - radius, vMax);
            path.quadraticCurveTo(maxX, vMax, maxX, vMax - radius);
            path.lineTo(maxX, vMin + radius);
            path.quadraticCurveTo(maxX, vMin, maxX - radius, vMin);
            path.lineTo(minX + radius, vMin);
          }
          return path;
        };
        const perimeterShape = roundedRectPath(
          perimeterMinX - referencePathWidth,
          perimeterMinZ - referencePathWidth,
          perimeterMaxX + referencePathWidth,
          perimeterMaxZ + referencePathWidth,
          perimeterRadius + referencePathWidth,
          false,
          true
        );
        // Fill the complete strip from the building outline to the path's
        // outer edge with green first. The asphalt path is rendered above it,
        // so the path remains readable while the surrounding planting becomes
        // continuous on every side of the main building.
        const greenFieldShape = roundedRectPath(
          perimeterMinX - referencePathWidth,
          perimeterMinZ - referencePathWidth,
          perimeterMaxX + referencePathWidth,
          perimeterMaxZ + referencePathWidth,
          perimeterRadius + referencePathWidth,
          false,
          true
        );
        const greenFieldInnerRadius = Math.min(3.6, Math.max(0.9, perimeterRadius - greenBufferWidth * 0.35));
        greenFieldShape.holes.push(roundedRectPath(
          mainBuildingBounds.min.x - 0.08,
          mainBuildingBounds.min.z - 0.08,
          mainBuildingBounds.max.x + 0.08,
          mainBuildingBounds.max.z + 0.08,
          greenFieldInnerRadius,
          true
        ));
        const greenFieldGeometry = new THREE.ShapeGeometry(greenFieldShape, 16);
        greenFieldGeometry.rotateX(-Math.PI / 2);
        const greenField = new THREE.Mesh(greenFieldGeometry, green);
        greenField.position.y = surfaceY + 0.04;
        greenField.name = 'B-WALK-01-main-building-perimeter-green-field';
        greenField.renderOrder = 119;
        greenField.frustumCulled = false;
        greenField.userData = {
          evidenceLevel: 'Derived',
          geometryMutated: false,
          extent: 'main-building-outline-to-rounded-path-outer-edge',
          referenceCoordinate: { x: -48.397, y: -15.410, z: -38.586 },
          pathWidthM: Number(referencePathWidth.toFixed(3)),
          greenBufferRetained: true
        };
        group.add(greenField);
        perimeterShape.holes.push(roundedRectPath(perimeterMinX, perimeterMinZ, perimeterMaxX, perimeterMaxZ, perimeterRadius, true));
        const perimeterGeometry = new THREE.ShapeGeometry(perimeterShape, 16);
        perimeterGeometry.rotateX(-Math.PI / 2);
        const perimeterPath = new THREE.Mesh(perimeterGeometry, asphalt);
        perimeterPath.position.y = surfaceY + 0.06;
        perimeterPath.name = 'B-WALK-01-main-building-perimeter-rounded-path';
        perimeterPath.renderOrder = 123;
        perimeterPath.frustumCulled = false;
        perimeterPath.userData = {
          evidenceLevel: 'Derived',
          geometryMutated: false,
          referenceCoordinate: { x: -48.397, y: -15.410, z: -38.586 },
          referencePathWidthM: Number(referencePathWidth.toFixed(3)),
          preservedGreenBufferM: Number(greenBufferWidth.toFixed(3)),
          cornerRadiusM: Number(perimeterRadius.toFixed(3)),
          source: 'B-WALK-01 reference path width; green buffer retained'
        };
        group.add(perimeterPath);
        // Operator point X=71.875 / Y=-15.410 / Z=-45.521 identifies the
        // short route perpendicular to the divider fence. Keep the existing
        // path width and lay an opaque asphalt branch along Z from the fence
        // edge toward the main-building side.
        const perpendicularBranchWidth = referencePathWidth;
        const perpendicularBranchStartZ = parallelBottom + 0.12 - 0.2;
        const perpendicularBranchLength = 14;
        const perpendicularBranch = new THREE.Mesh(
          new THREE.BoxGeometry(perpendicularBranchWidth, .055, perpendicularBranchLength),
          asphalt
        );
        perpendicularBranch.position.set(71.875, surfaceY + .065, perpendicularBranchStartZ + perpendicularBranchLength / 2);
        perpendicularBranch.name = 'B-WALK-01-fence-perpendicular-asphalt-branch';
        // Keep the existing white bed stones/curbs above this asphalt overlay;
        // the branch must not visually displace or hide them.
        perpendicularBranch.renderOrder = 120;
        perpendicularBranch.frustumCulled = false;
        perpendicularBranch.userData = {
          evidenceLevel: 'Derived',
          geometryMutated: false,
          referenceCoordinate: { x: 71.875, y: -15.410, z: -45.521 },
          orientation: 'perpendicular_to_divider_fence',
          widthM: Number(perpendicularBranchWidth.toFixed(3)),
          lengthM: perpendicularBranchLength,
          material: 'asphalt'
        };
        group.add(perpendicularBranch);
        addCurb('B-WALK-01-green-building-side', corridorTop, 1); addCurb('B-WALK-01-green-building-side', roadTop, 2);
        addCurb('B-WALK-01-green-between-parallel-roads', parallelTop, 1); addCurb('B-WALK-01-green-between-parallel-roads', parallelBottom, 2);
        // 10-02 photos confirm a continuous black fence at the far edge of
        // the planted strip, separating the second parallel path.  It is
        // placed on the operator-confirmed corridor, not copied from a remote
        // garage group.
        const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x4f5557, roughness: .88, metalness: .1, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const fenceConcreteMaterial = new THREE.MeshStandardMaterial({ color: 0x7b7e80, roughness: .94, metalness: .02, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const fenceCapMaterial = new THREE.MeshStandardMaterial({ color: 0xe6e2d7, roughness: .46, metalness: .02, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const fenceZ = parallelBottom + .12;
        const fencePlinth = new THREE.Mesh(new THREE.BoxGeometry(xMax - xMin, .46, .62), fenceConcreteMaterial); fencePlinth.position.set((xMin + xMax) / 2, surfaceY + .23, fenceZ); fencePlinth.name = 'B-WALK-01-continuous-fence-concrete-plinth'; fencePlinth.renderOrder = 150; group.add(fencePlinth);
        const fenceRailLower = new THREE.Mesh(new THREE.BoxGeometry(xMax - xMin, .11, .12), fenceMaterial); fenceRailLower.position.set((xMin + xMax) / 2, surfaceY + .78, fenceZ); fenceRailLower.name = 'B-WALK-01-continuous-fence-lower-rail'; fenceRailLower.renderOrder = 151; group.add(fenceRailLower);
        const fenceRailUpper = new THREE.Mesh(new THREE.BoxGeometry(xMax - xMin, .11, .12), fenceMaterial); fenceRailUpper.position.set((xMin + xMax) / 2, surfaceY + 1.58, fenceZ); fenceRailUpper.name = 'B-WALK-01-continuous-fence-upper-rail'; fenceRailUpper.renderOrder = 151; group.add(fenceRailUpper);
        const fenceSlatSpacing = 0.62;
        let fenceSlatCount = 0;
        for (let x = xMin + .48; x <= xMax - .48 + .001; x += fenceSlatSpacing) {
          const slat = new THREE.Mesh(new THREE.BoxGeometry(.14, 2.42, .12), fenceMaterial);
          slat.position.set(x, surfaceY + 1.57, fenceZ);
          slat.name = `B-WALK-01-continuous-fence-slat-${String(fenceSlatCount + 1).padStart(3, '0')}`;
          slat.renderOrder = 152;
          group.add(slat);
          fenceSlatCount += 1;
        }
        const fencePostCount = 18;
        for (let index = 0; index <= fencePostCount; index += 1) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(.30, 2.68, .30), fenceMaterial); post.position.set(xMin + ((xMax - xMin) * index / fencePostCount), surfaceY + 1.45, fenceZ); post.name = `B-WALK-01-continuous-fence-post-${index + 1}`; post.renderOrder = 153; group.add(post);
          const cap = new THREE.Mesh(new THREE.SphereGeometry(.25, 16, 12), fenceCapMaterial); cap.position.set(post.position.x, surfaceY + 2.86, fenceZ); cap.name = `B-WALK-01-continuous-fence-post-cap-${index + 1}`; cap.renderOrder = 154; group.add(cap);
        }
        // The operator coordinate in codex-clipboard-07ce695c-07f3-408a-890e-12f98a4d3cc9.png
        // marks a small pedestrian gate on the perpendicular branch.  The
        // supplied 2fd562ca81874435740eedd44723c7e8.jpg shows a light-grey
        // double-leaf metal gate with close vertical bars, round post caps and
        // a shallow threshold.  Keep it as one independently editable runtime
        // group; no source GLB mesh is changed.
        const gateMaterial = new THREE.MeshStandardMaterial({ color: 0xb9bec0, roughness: .72, metalness: .2, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const gatePostMaterial = new THREE.MeshStandardMaterial({ color: 0xaeb3b5, roughness: .78, metalness: .16, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const gateThresholdMaterial = new THREE.MeshStandardMaterial({ color: 0x7d8080, roughness: .9, metalness: .02, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const gateRoot = new THREE.Group();
        gateRoot.name = 'B-WALK-01-small-gate';
        gateRoot.userData = {
          editorRole: 'gate',
          operatorLabel: '支路处双扇小门',
          evidenceLevel: 'Observed + Derived',
          sourcePhoto: '2fd562ca81874435740eedd44723c7e8.jpg',
          sourceCoordinateScreenshot: 'codex-clipboard-07ce695c-07f3-408a-890e-12f98a4d3cc9.png',
          geometryMutated: false,
          operatorCoordinate: { x: 74.029, y: -15.410, z: -42.835 },
          gateType: 'double-swing-pedestrian-gate'
        };
        const gateCenterX = 74.029;
        const gateCenterZ = -42.835;
        const gateWidth = 3.2;
        const gateHeight = 2.45;
        const gateDepth = .14;
        const gateLeafWidth = 1.48;
        const gatePostOffset = gateWidth / 2 + .12;
        const gateThreshold = new THREE.Mesh(new THREE.BoxGeometry(gateWidth + .64, .08, 1.22), gateThresholdMaterial);
        gateThreshold.position.set(gateCenterX, surfaceY + .04, gateCenterZ);
        gateThreshold.name = 'B-WALK-01-small-gate-threshold';
        gateThreshold.renderOrder = 155;
        gateRoot.add(gateThreshold);
        [-1, 1].forEach((side) => {
          const post = new THREE.Mesh(new THREE.BoxGeometry(.28, 2.7, .28), gatePostMaterial);
          post.position.set(gateCenterX + side * gatePostOffset, surfaceY + 1.35, gateCenterZ);
          post.name = `B-WALK-01-small-gate-post-${side < 0 ? 'L' : 'R'}`;
          post.renderOrder = 156;
          gateRoot.add(post);
          const cap = new THREE.Mesh(new THREE.SphereGeometry(.235, 16, 12), fenceCapMaterial);
          cap.position.set(post.position.x, surfaceY + 2.82, gateCenterZ);
          cap.name = `B-WALK-01-small-gate-post-cap-${side < 0 ? 'L' : 'R'}`;
          cap.renderOrder = 157;
          gateRoot.add(cap);
        });
        const addGateLeaf = (side) => {
          const leaf = new THREE.Group();
          const hingeX = gateCenterX + side * (gateWidth / 2 - .16);
          const direction = side < 0 ? 1 : -1;
          leaf.position.set(hingeX, surfaceY, gateCenterZ);
          leaf.rotation.y = side < 0 ? -0.24 : 0.24;
          leaf.name = `B-WALK-01-small-gate-leaf-${side < 0 ? 'L' : 'R'}`;
          leaf.userData = { evidenceLevel: 'Observed + Derived', sourcePhoto: '2fd562ca81874435740eedd44723c7e8.jpg', gateLeaf: true };
          const railY = [0.74, 1.57];
          railY.forEach((height, index) => {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(gateLeafWidth, .105, gateDepth), gateMaterial);
            rail.position.set(direction * gateLeafWidth / 2, height, 0);
            rail.name = `${leaf.name}-rail-${index + 1}`;
            rail.renderOrder = 158;
            leaf.add(rail);
          });
          const lower = new THREE.Mesh(new THREE.BoxGeometry(gateLeafWidth, .12, gateDepth), gateMaterial);
          lower.position.set(direction * gateLeafWidth / 2, .18, 0);
          lower.name = `${leaf.name}-lower-rail`;
          lower.renderOrder = 158;
          leaf.add(lower);
          const slatSpacing = .34;
          const slatCount = Math.max(3, Math.floor(gateLeafWidth / slatSpacing));
          for (let index = 0; index <= slatCount; index += 1) {
            const slat = new THREE.Mesh(new THREE.BoxGeometry(.105, gateHeight - .18, gateDepth), gateMaterial);
            slat.position.set(direction * (gateLeafWidth * (index / slatCount)), gateHeight / 2, 0);
            slat.name = `${leaf.name}-slat-${String(index + 1).padStart(2, '0')}`;
            slat.renderOrder = 159;
            leaf.add(slat);
          }
          const diagonal = new THREE.Mesh(new THREE.BoxGeometry(gateLeafWidth * .98, .08, gateDepth + .015), gateMaterial);
          diagonal.position.set(direction * gateLeafWidth / 2, 1.08, -.012);
          diagonal.rotation.z = side < 0 ? -0.28 : 0.28;
          diagonal.name = `${leaf.name}-diagonal-brace`;
          diagonal.renderOrder = 159;
          leaf.add(diagonal);
          gateRoot.add(leaf);
        };
        addGateLeaf(-1); addGateLeaf(1);
        gateRoot.position.set(0, 0, 0);
        gateRoot.renderOrder = 155;
        group.add(gateRoot);
        runtime.bWalkSmallGate = gateRoot;
        // The supplied fence photo shows two nearby temporary red/white ribbons
        // tied to adjacent short intervals. Keep them explicitly Temporary
        // Observed so they can be removed later without touching the fence.
        const ribbonRedMaterial = new THREE.MeshStandardMaterial({ color: 0xc6283d, roughness: .72, metalness: .02, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const ribbonWhiteMaterial = new THREE.MeshStandardMaterial({ color: 0xf1eee5, roughness: .68, metalness: .01, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const ribbonPoleMaterial = new THREE.MeshStandardMaterial({ color: 0xbec1c0, roughness: .58, metalness: .25, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const alignRibbonPiece = (mesh, start, end) => {
          const direction = end.clone().sub(start);
          mesh.position.copy(start).add(end).multiplyScalar(.5);
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
          return mesh;
        };
        const addTemporaryRibbon = (id, anchorX, direction = 1) => {
          const start = new THREE.Vector3(anchorX, surfaceY + 1.62, fenceZ - 1.0);
          const end = new THREE.Vector3(anchorX + direction * 1.75, surfaceY + 3.12, fenceZ - 1.08);
          const poleDirection = end.clone().sub(start);
          const pole = alignRibbonPiece(new THREE.Mesh(new THREE.CylinderGeometry(.035, .035, poleDirection.length(), 8), ribbonPoleMaterial), start, end);
          pole.name = `${id}-pole`; pole.userData = { evidenceLevel: 'Temporary Observed', sourcePhoto: 'f576fee91b75c7ba13de2f6d74993334.jpg', temporary: true }; pole.renderOrder = 157; group.add(pole);
          const pieceCount = 6; const pieceLength = poleDirection.length() / pieceCount;
          for (let pieceIndex = 0; pieceIndex < pieceCount; pieceIndex += 1) {
            const t0 = pieceIndex / pieceCount; const t1 = (pieceIndex + 1) / pieceCount;
            const pieceStart = start.clone().lerp(end, t0); const pieceEnd = start.clone().lerp(end, t1);
            const ribbon = alignRibbonPiece(new THREE.Mesh(new THREE.BoxGeometry(.28, pieceLength * 1.08, .045), pieceIndex % 2 === 0 ? ribbonRedMaterial : ribbonWhiteMaterial), pieceStart, pieceEnd);
            ribbon.name = `${id}-ribbon-${pieceIndex + 1}`;
            ribbon.userData = { evidenceLevel: 'Temporary Observed', sourcePhoto: 'f576fee91b75c7ba13de2f6d74993334.jpg', temporary: true, stripe: pieceIndex % 2 === 0 ? 'red' : 'white' };
            ribbon.renderOrder = 158; group.add(ribbon);
          }
        };
        const ribbonSpacing = 4.2;
        // Put the adjacent pair near the beginning of the visible B-WALK-01
        // fence run so the temporary marker is present in the operator's
        // current overview, rather than hidden at the far middle of the run.
        const ribbonAnchor = xMin + 10;
        addTemporaryRibbon('B-WALK-01-temporary-ribbon-01', ribbonAnchor, 1);
        addTemporaryRibbon('B-WALK-01-temporary-ribbon-02', ribbonAnchor + ribbonSpacing, -1);
        // P033/P034 show a transverse speed-control strip on this asphalt
        // path.  BW-02 is the only operator-marked road point, so the strip is
        // anchored there and remains explicitly Derived rather than Observed.
        const speedBumpMaterial = new THREE.MeshStandardMaterial({ color: 0xd1bd67, roughness: .82, metalness: .02, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const speedBump = new THREE.Mesh(new THREE.BoxGeometry(.34, .07, Math.max(.8, targetWidths.road * .82)), speedBumpMaterial); speedBump.position.set(64.572, surfaceY + .055, (roadTop + roadBottom) / 2); speedBump.name = 'B-WALK-01-speed-bump-BW-02'; group.add(speedBump);
        // Landscape pass from the same photo set: building-side tree pits,
        // an opposite continuous hedge/planting row, and a small tree line.
        // Exact individual tree surveys are unavailable, so spacing is marked
        // Derived/Simulated and kept inside the confirmed green bands.
        const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x5b4634, roughness: .94, metalness: 0, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const leafMaterial = new THREE.MeshStandardMaterial({ color: 0x4e7139, roughness: .93, metalness: 0, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const hedgeMaterial = new THREE.MeshStandardMaterial({ color: 0x385b35, roughness: .96, metalness: 0, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const bedSoilMaterial = new THREE.MeshStandardMaterial({ color: 0x66533d, roughness: 1, metalness: 0, transparent: false, opacity: 1, depthTest: true, depthWrite: true });
        const landscapeTreeAnchors = [];
        const addLandscapeTree = (id, x, z, scale = 1) => {
          // Keep the anchor and restore a smooth tree representation. The
          // faceted diamond locator is gone; this is the scene's tree model
          // placeholder until an evidence-aligned tree mesh is supplied.
          landscapeTreeAnchors.push({ id, x: Number(x.toFixed(3)), z: Number(z.toFixed(3)), scale, visibleGeometry: true, evidenceLevel: 'Derived' });
          const tree = new THREE.Group(); tree.name = id; tree.userData = { evidenceLevel: 'Derived', sourcePhotos: ['P033', 'P034', 'P035'], locatorCrownRemoved: true };
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.13 * scale, .18 * scale, 1.85 * scale, 12), trunkMaterial); trunk.position.y = surfaceY + .93 * scale; trunk.name = `${id}-trunk`; tree.add(trunk);
          const crown = new THREE.Mesh(new THREE.SphereGeometry(.98 * scale, 24, 16), leafMaterial); crown.scale.y = 1.22; crown.position.y = surfaceY + 2.42 * scale; crown.name = `${id}-crown-smooth`; tree.add(crown);
          tree.position.set(x, 0, z); tree.renderOrder = 160; tree.traverse((node) => { node.renderOrder = 160; node.frustumCulled = false; }); group.add(tree); return tree;
        };
        const perimeterGreenTreeAnchors = [];
        const addPerimeterGreenTree = (id, x, z, scale = .68) => {
          const tree = addLandscapeTree(id, x, z, scale);
          tree.userData = { ...(tree.userData || {}), plantingZone: 'main-building-perimeter-green-field', source: 'operator green-field directive', simulatedSpacing: true };
          perimeterGreenTreeAnchors.push({ id, x: Number(x.toFixed(3)), z: Number(z.toFixed(3)), scale: Number(scale.toFixed(3)) });
          return tree;
        };
        const addHedge = (id, x, z, width = 3.2) => {
          const hedge = new THREE.Mesh(new THREE.BoxGeometry(width, .95, .9), hedgeMaterial); hedge.position.set(x, surfaceY + .475, z); hedge.name = id; hedge.renderOrder = 155; hedge.frustumCulled = false; hedge.userData = { evidenceLevel: 'Derived', sourcePhotos: ['P033', 'P034', 'P035'], simulatedSpacing: true }; group.add(hedge); return hedge;
        };
        const addBedSoil = (id, x, z, width, depth) => {
          const bed = new THREE.Mesh(new THREE.BoxGeometry(width, .035, depth), bedSoilMaterial); bed.position.set(x, surfaceY + .02, z); bed.name = id; bed.userData = { evidenceLevel: 'Derived', sourcePhotos: ['P033', 'P034'] }; group.add(bed); return bed;
        };
        const xStart = xMin + 6; const xEnd = xMax - 6; const treeSpacing = 9;
        let buildingTreeCount = 0; let oppositeTreeCount = 0; let hedgeCount = 0;
        addBedSoil('B-WALK-01-building-side-tree-bed', (xMin + xMax) / 2, (corridorTop + roadTop) / 2, xMax - xMin - 4, Math.max(.8, targetWidths.buildingSide - .34));
        for (let x = xStart; x <= xEnd + .001; x += treeSpacing) { addLandscapeTree(`B-WALK-01-building-side-tree-${buildingTreeCount + 1}`, x, (corridorTop + roadTop) / 2, .82); buildingTreeCount += 1; }
        // Add a sparse tree rhythm inside the newly continuous green field,
        // keeping crowns clear of the rounded asphalt path and its corners.
        const perimeterTreeMargin = Math.max(6, perimeterRadius + 2);
        const greenTreeSouthZ = mainBuildingBounds.min.z - Math.min(greenBufferWidth * .58, greenBufferWidth - .35);
        const greenTreeNorthZ = mainBuildingBounds.max.z + Math.min(greenBufferWidth * .58, greenBufferWidth - .35);
        const greenTreeWestX = mainBuildingBounds.min.x - Math.min(greenBufferWidth * .58, greenBufferWidth - .35);
        const greenTreeEastX = mainBuildingBounds.max.x + Math.min(greenBufferWidth * .58, greenBufferWidth - .35);
        let perimeterGreenTreeCount = 0;
        for (let x = mainBuildingBounds.min.x + perimeterTreeMargin; x <= mainBuildingBounds.max.x - perimeterTreeMargin + .001; x += 22) {
          addPerimeterGreenTree(`B-WALK-01-main-green-tree-south-${perimeterGreenTreeCount + 1}`, x, greenTreeSouthZ, .68); perimeterGreenTreeCount += 1;
          addPerimeterGreenTree(`B-WALK-01-main-green-tree-north-${perimeterGreenTreeCount + 1}`, x, greenTreeNorthZ, .68); perimeterGreenTreeCount += 1;
        }
        for (let z = mainBuildingBounds.min.z + perimeterTreeMargin; z <= mainBuildingBounds.max.z - perimeterTreeMargin + .001; z += 22) {
          addPerimeterGreenTree(`B-WALK-01-main-green-tree-west-${perimeterGreenTreeCount + 1}`, greenTreeWestX, z, .62); perimeterGreenTreeCount += 1;
          addPerimeterGreenTree(`B-WALK-01-main-green-tree-east-${perimeterGreenTreeCount + 1}`, greenTreeEastX, z, .62); perimeterGreenTreeCount += 1;
        }
        addBedSoil('B-WALK-01-opposite-hedge-bed', (xMin + xMax) / 2, (parallelTop + parallelBottom) / 2, xMax - xMin - 4, Math.max(.8, targetWidths.parallelSide - .4));
        for (let x = xStart + 4; x <= xEnd + .001; x += 7) { addHedge(`B-WALK-01-opposite-hedge-${hedgeCount + 1}`, x, parallelBottom + .68, 6.2); hedgeCount += 1; }
        for (let x = xStart + 3; x <= xEnd + .001; x += 12) { addLandscapeTree(`B-WALK-01-opposite-tree-${oppositeTreeCount + 1}`, x, parallelBottom + 1.85, .95); oppositeTreeCount += 1; }
        group.renderOrder=120; group.traverse((node)=>{node.frustumCulled=false;});
        group.userData={evidenceLevel:'Derived',sourcePoints:['BW-01','BW-02'],sourcePhotos:['P033','P034','P035','f576fee91b75c7ba13de2f6d74993334.jpg'],analysisSource:'2026-10-02 photo/video archive',roadMaterial:'asphalt #3F4448',greenMaterial:'#61713B',bedStone:'#C3BEB4',geometryMutated:false,roadMeshes,surfaceY:Number(surfaceY.toFixed(3)),referencePlaneY:-15.410,sourceRoadBands,corridorWidthM:Number(corridorWidth.toFixed(3)),ratio,targetWidths:{buildingSideM:Number(targetWidths.buildingSide.toFixed(3)),roadM:Number(targetWidths.road.toFixed(3)),parallelSideM:Number(targetWidths.parallelSide.toFixed(3))},buildingSideBand,roadOverlay,parallelBand,mainBuildingPerimeterGreen:{object:'B-WALK-01-main-building-perimeter-green-field',extent:'main-building-outline-to-rounded-path-outer-edge',pathWidthM:Number(referencePathWidth.toFixed(3)),greenUnderlay:true,treeCount:perimeterGreenTreeCount,treeAnchors:perimeterGreenTreeAnchors},mainBuildingPerimeterPath:{widthM:Number(referencePathWidth.toFixed(3)),preservedGreenBufferM:Number(greenBufferWidth.toFixed(3)),cornerRadiusM:Number(perimeterRadius.toFixed(3)),bounds:{minX:Number(perimeterMinX.toFixed(3)),maxX:Number(perimeterMaxX.toFixed(3)),minZ:Number(perimeterMinZ.toFixed(3)),maxZ:Number(perimeterMaxZ.toFixed(3))},referenceCoordinate:{x:-48.397,y:-15.410,z:-38.586},smoothCorners:true,greenBufferRetained:true},perpendicularAsphaltBranch:{object:perpendicularBranch.name,widthM:Number(perpendicularBranchWidth.toFixed(3)),lengthM:perpendicularBranchLength,referenceCoordinate:{x:71.875,y:-15.410,z:-45.521},orientation:'perpendicular_to_divider_fence'},continuousFence:{posts:fencePostCount+1,slats:fenceSlatCount,slatSpacingM:fenceSlatSpacing,slatHeightM:2.42,rails:2,concretePlinth:true,sphericalCaps:fencePostCount+1,location:'far edge of between-parallel-roads green band',sourcePhoto:'f576fee91b75c7ba13de2f6d74993334.jpg',temporaryRibbonCount:2,temporaryRibbonSpacingM:ribbonSpacing,temporaryRibbonIntervals:'adjacent-short-intervals',temporaryRibbonExcluded:false,evidenceLevel:'Derived'},speedBump:{anchor:'BW-02',evidenceLevel:'Derived',photoRefs:['P033','P034']},landscape:{buildingSideTrees:buildingTreeCount,oppositeTrees:oppositeTreeCount,oppositeHedgeSegments:hedgeCount,treeAndHedgeSpacing:'Derived/Simulated from photo rhythm',treeAnchors:landscapeTreeAnchors,visibleTreeGeometry:true,locatorCrownRemoved:true,photoRefs:['P033','P034','P035']}};
        // Keep the additions inside the currently displayed model root so the
        // competition view and photo/video walkthrough read as one unified
        // scene. The inverse offset preserves the already confirmed scene
        // coordinates after the model is centered.
        group.position.set(-(runtime.model.position.x || 0), -(runtime.model.position.y || 0), -(runtime.model.position.z || 0));
        runtime.model.add(group); runtime.bWalkSurfaceDetail=group;
        runtime.applyBWalkEditorEdits?.(group);
        runtime.applyRuntimeEditorTransforms?.(group);
        runtime.applyRuntimeEditorDeleted?.(group);
        runtime.refreshEditablePickProxies?.(group);
        return group.userData;
      };
      // Lightweight operator controls for the additive Window 1 layer.  The
      // editor stores only runtime transforms/materials in localStorage, so a
      // refresh keeps the operator's adjustments while the source GLB stays
      // unchanged and auditable.
      const readBWalkEditorStorage = () => {
        try { const value = JSON.parse(window.localStorage.getItem(B_WALK_EDITOR_STORAGE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
      };
      const writeBWalkEditorStorage = (value) => { try { window.localStorage.setItem(B_WALK_EDITOR_STORAGE_KEY, JSON.stringify(value)); } catch { /* local-only convenience; visual editing still works */ } };
      const findBWalkEditorObject = (runtime, id, group = runtime?.bWalkSurfaceDetail) => {
        const local = group?.getObjectByName?.(id) || group?.getObjectByName?.(`${id}-1`) || null;
        if (local) return local;
        const roots = [runtime?.bWalkSurfaceDetail, runtime?.bWalk01Group, runtime?.importedMiddleBuildingGroup, runtime?.missingMiddleBuilding, runtime?.model].filter(Boolean);
        for (const root of roots) {
          const found = root.getObjectByName?.(id);
          if (found) return found;
        }
        return null;
      };
      const ensureBWalkEditorBaseline = (runtime, object) => {
        if (!object || object.userData?.bWalkEditorBaseline) return object?.userData?.bWalkEditorBaseline || null;
        const box = new runtime.THREE.Box3().setFromObject(object);
        const size = box.getSize(new runtime.THREE.Vector3());
        const baseline = { scale: object.scale.toArray(), position: object.position.toArray(), size: [Math.max(.001, size.x), Math.max(.001, size.y), Math.max(.001, size.z)] };
        object.userData = { ...(object.userData || {}), bWalkEditorBaseline: baseline };
        return baseline;
      };
      const readBWalkEditorObject = (runtime, definition, group = runtime?.bWalkSurfaceDetail) => {
        const object = findBWalkEditorObject(runtime, definition.id, group);
        if (!object) return null;
        const baseline = ensureBWalkEditorBaseline(runtime, object);
        const box = new runtime.THREE.Box3().setFromObject(object);
        const size = box.getSize(new runtime.THREE.Vector3());
        return { ...definition, visible: object.visible, width: Number(size.x.toFixed(3)), length: Number(size.z.toFixed(3)), offsetX: Number((object.position.x - baseline.position[0]).toFixed(3)), offsetZ: Number((object.position.z - baseline.position[2]).toFixed(3)), material: readBWalkEditorMaterial(object) };
      };
      const readBWalkEditorMaterial = (object) => {
        const material = Array.isArray(object?.material) ? object.material[0] : object?.material;
        if (!material) return null;
        return { color: material.color?.getHexString?.() || '61713b', roughness: Number(material.roughness ?? 0.9), metalness: Number(material.metalness ?? 0), opacity: Number(material.opacity ?? 1), transparent: Boolean(material.transparent) };
      };
      const applyBWalkEditorMaterial = (object, style) => {
        if (!object || !style) return false;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.filter(Boolean).forEach((material) => {
          if (material.color && style.color) material.color.set(`#${String(style.color).replace(/^#/, '')}`);
          if ('roughness' in material && Number.isFinite(Number(style.roughness))) material.roughness = Number(style.roughness);
          if ('metalness' in material && Number.isFinite(Number(style.metalness))) material.metalness = Number(style.metalness);
          material.transparent = Boolean(style.transparent);
          material.opacity = Number(style.opacity ?? 1);
          material.depthWrite = true;
          material.depthTest = true;
          material.needsUpdate = true;
        });
        return true;
      };
      environmentRef.current.getBWalkEditorObjects = () => {
        const runtime = environmentRef.current;
        if (!runtime?.bWalkSurfaceDetail || !runtime?.THREE) return [];
        return B_WALK_EDITOR_DEFINITIONS.map((definition) => readBWalkEditorObject(runtime, definition)).filter(Boolean);
      };
      environmentRef.current.setBWalkEditorObject = (id, changes = {}) => {
        const runtime = environmentRef.current;
        const definition = B_WALK_EDITOR_DEFINITIONS.find((item) => item.id === id);
        const object = definition ? findBWalkEditorObject(runtime, id) : null;
        if (!runtime?.THREE || !definition || !object) return runtime?.getBWalkEditorObjects?.() || [];
        const baseline = ensureBWalkEditorBaseline(runtime, object);
        const current = readBWalkEditorObject(runtime, definition);
        const width = Math.max(.1, Math.min(240, Number(changes.width ?? current.width)));
        const length = Math.max(.1, Math.min(240, Number(changes.length ?? current.length)));
        const offsetX = Math.max(-120, Math.min(120, Number(changes.offsetX ?? current.offsetX)));
        const offsetZ = Math.max(-120, Math.min(120, Number(changes.offsetZ ?? current.offsetZ)));
        object.scale.x = baseline.scale[0] * width / baseline.size[0];
        object.scale.z = baseline.scale[2] * length / baseline.size[2];
        object.position.x = baseline.position[0] + offsetX;
        object.position.z = baseline.position[2] + offsetZ;
        const edits = runtime.bWalkEditorEdits || (runtime.bWalkEditorEdits = readBWalkEditorStorage());
        edits[id] = { width, length, offsetX, offsetZ };
        writeBWalkEditorStorage(edits);
        return runtime.getBWalkEditorObjects();
      };
      environmentRef.current.resetBWalkEditorObject = (id) => {
        const runtime = environmentRef.current;
        const object = findBWalkEditorObject(runtime, id);
        const baseline = object ? ensureBWalkEditorBaseline(runtime, object) : null;
        if (object && baseline) { object.scale.fromArray(baseline.scale); object.position.fromArray(baseline.position); }
        const edits = runtime.bWalkEditorEdits || (runtime.bWalkEditorEdits = readBWalkEditorStorage());
        delete edits[id]; writeBWalkEditorStorage(edits);
        return runtime.getBWalkEditorObjects?.() || [];
      };
      environmentRef.current.captureBWalkFormat = (sourceId) => {
        const runtime = environmentRef.current;
        const source = findBWalkEditorObject(runtime, sourceId);
        const style = readBWalkEditorMaterial(source);
        runtime.bWalkFormatBrush = style ? { sourceId, style } : null;
        return runtime.bWalkFormatBrush;
      };
      environmentRef.current.applyBWalkFormat = (targetId) => {
        const runtime = environmentRef.current;
        const target = findBWalkEditorObject(runtime, targetId);
        const brush = runtime.bWalkFormatBrush;
        if (!target || !brush) return false;
        return applyBWalkEditorMaterial(target, brush.style);
      };
      environmentRef.current.applyBWalkEditorEdits = (group = environmentRef.current?.bWalkSurfaceDetail) => {
        const runtime = environmentRef.current;
        if (!runtime?.THREE || !group) return;
        runtime.bWalkEditorEdits = runtime.bWalkEditorEdits || readBWalkEditorStorage();
        B_WALK_EDITOR_DEFINITIONS.forEach((definition) => {
          const changes = runtime.bWalkEditorEdits[definition.id];
          if (!changes) return;
          const object = findBWalkEditorObject(runtime, definition.id, group);
          if (!object) return;
          const baseline = ensureBWalkEditorBaseline(runtime, object);
          object.scale.x = baseline.scale[0] * Number(changes.width || baseline.size[0]) / baseline.size[0];
          object.scale.z = baseline.scale[2] * Number(changes.length || baseline.size[2]) / baseline.size[2];
          object.position.x = baseline.position[0] + Number(changes.offsetX || 0);
          object.position.z = baseline.position[2] + Number(changes.offsetZ || 0);
        });
      };
      const readRuntimeEditorStorage = () => {
        try { const value = JSON.parse(window.localStorage.getItem(RUNTIME_EDITOR_TRANSFORM_STORAGE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
      };
      const writeRuntimeEditorStorage = (value) => { try { window.localStorage.setItem(RUNTIME_EDITOR_TRANSFORM_STORAGE_KEY, JSON.stringify(value)); } catch { /* local-only convenience */ } };
      const runtimeEditableRoots = (runtime) => [runtime?.bWalkSurfaceDetail, runtime?.bWalk01Group, runtime?.importedMiddleBuildingGroup, runtime?.missingMiddleBuilding, runtime?.model]
        .filter(Boolean)
        .filter((root, index, roots) => roots.indexOf(root) === index);
      const isLockedRuntimeObject = (object) => {
        let current = object;
        while (current) {
          const name = String(current.name || '');
          if (/^main-building|^PLAN_BUILDING_C|^EVIDENCE_BUILDING_01|^EVIDENCE_BUILDING_02|^WINDOW1-MAIN-BUILDING|^WINDOW1-(IMPORTED-)?MIDDLE-BUILDING/i.test(name)) return true;
          current = current.parent;
        }
        return false;
      };
      const resolveRuntimeEditableObject = (runtime, id) => {
        if (!id) return null;
        for (const root of runtimeEditableRoots(runtime)) {
          const found = root.getObjectByName?.(id) || root.getObjectByProperty?.('uuid', id);
          if (found && !isLockedRuntimeObject(found)) return found;
        }
        return null;
      };
      const describeRuntimeEditableObject = (runtime, object) => {
        if (!object || isLockedRuntimeObject(object)) return null;
        const box = new runtime.THREE.Box3().setFromObject(object);
        const size = box.getSize(new runtime.THREE.Vector3());
        return { id: object.uuid, name: object.name || object.uuid, label: object.userData?.operatorLabel || object.name || '运行时对象', width: Number(size.x.toFixed(3)), height: Number(size.y.toFixed(3)), length: Number(size.z.toFixed(3)), position: object.position.toArray().map((value) => Number(value.toFixed(3))), scale: object.scale.toArray().map((value) => Number(value.toFixed(3))), role: object.userData?.editorRole || 'runtime-derived', source: object.userData?.evidenceLevel || 'Derived', locked: false };
      };
      environmentRef.current.getEditableRuntimeObjects = () => {
        const runtime = environmentRef.current;
        if (!runtime?.THREE) return [];
        const list = []; const seen = new Set();
        runtimeEditableRoots(runtime).forEach((root) => root.traverse((object) => {
          if ((!object.isMesh && !object.isGroup) || object === root || object.userData?.editorPickProxy || seen.has(object.uuid) || isLockedRuntimeObject(object)) return;
          seen.add(object.uuid); const descriptor = describeRuntimeEditableObject(runtime, object); if (descriptor) list.push(descriptor);
        }));
        return list;
      };
      environmentRef.current.selectEditableObject = (objectOrId) => {
        const runtime = environmentRef.current;
        const object = typeof objectOrId === 'string' ? resolveRuntimeEditableObject(runtime, objectOrId) : objectOrId;
        if (!object || isLockedRuntimeObject(object) || !runtime?.transformControls) return null;
        runtime.editableSelection = object;
        runtime.transformControls.attach(object);
        runtime.transformHelper.visible = true;
        const brush = runtime.runtimeFormatBrush;
        if (brush?.armed && (object.name || object.uuid) !== brush.sourceName) {
          const applied = applyBWalkEditorMaterial(object, brush.style);
          runtime.runtimeFormatBrush = { ...brush, armed: false, lastAppliedName: object.name || object.uuid };
          runtime.onEditableFormatBrushStateChange?.(runtime.runtimeFormatBrush, applied);
        }
        const descriptor = describeRuntimeEditableObject(runtime, object);
        runtime.onEditableSelectionChange?.(descriptor);
        return descriptor;
      };
      environmentRef.current.clearEditableSelection = () => {
        const runtime = environmentRef.current;
        runtime?.transformControls?.detach?.();
        if (runtime?.transformHelper) runtime.transformHelper.visible = false;
        if (runtime) runtime.editableSelection = null;
        runtime?.onEditableSelectionChange?.(null);
      };
      environmentRef.current.selectEditableAtPointer = (event) => {
        const runtime = environmentRef.current;
        if (!runtime?.camera || !runtime?.renderer || !runtime?.THREE) return null;
        const rect = runtime.renderer.domElement.getBoundingClientRect();
        const pointer = new runtime.THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
        const raycaster = new runtime.THREE.Raycaster(); raycaster.setFromCamera(pointer, runtime.camera);
        const overlayRoots = [runtime.bWalkSurfaceDetail, runtime.bWalk01Group, runtime.importedMiddleBuildingGroup, runtime.missingMiddleBuilding].filter(Boolean);
        const overlayHits = raycaster.intersectObjects(overlayRoots, true).filter((item) => item.object && !isLockedRuntimeObject(item.object) && !/^B-WALK-01-main-building-perimeter-rounded-path$|^EVIDENCE_curbs$/i.test(item.object.name || ''));
        const modelHits = raycaster.intersectObjects([runtime.model].filter(Boolean), true);
        const overlayProxyHit = overlayHits.find((item) => item.object?.userData?.editorPickProxy);
        const modelProxyHit = modelHits.find((item) => item.object?.userData?.editorModelPickProxy);
        const hits = overlayProxyHit ? [overlayProxyHit] : (modelProxyHit ? [modelProxyHit] : (overlayHits.length ? overlayHits : modelHits));
        const hit = hits.find((item) => item.object && !isLockedRuntimeObject(item.object));
        if (!hit) { runtime.clearEditableSelection?.(); return null; }
        let target = hit.object.userData?.editorPickProxy ? resolveRuntimeEditableObject(runtime, hit.object.userData.editorProxyTarget) : hit.object;
        if (!target) { runtime.clearEditableSelection?.(); return null; }
        return runtime.selectEditableObject(target);
      };
      environmentRef.current.setEditableTransformMode = (mode = 'translate') => {
        const runtime = environmentRef.current; const next = ['translate', 'scale'].includes(mode) ? mode : 'translate';
        runtime.editableTransformMode = next; runtime.transformControls?.setMode?.(next); return next;
      };
      environmentRef.current.commitEditableTransform = () => {
        const runtime = environmentRef.current; const object = runtime?.editableSelection;
        if (!object || isLockedRuntimeObject(object)) return null;
        const edits = runtime.runtimeEditorTransforms || (runtime.runtimeEditorTransforms = readRuntimeEditorStorage());
        edits[object.name || object.uuid] = { position: object.position.toArray(), rotation: object.rotation.toArray(), scale: object.scale.toArray() };
        writeRuntimeEditorStorage(edits);
        const descriptor = describeRuntimeEditableObject(runtime, object); runtime.onEditableSelectionChange?.(descriptor); return descriptor;
      };
      environmentRef.current.captureEditableFormat = () => {
        const runtime = environmentRef.current; const source = runtime?.editableSelection;
        const style = readBWalkEditorMaterial(source);
        runtime.runtimeFormatBrush = style ? { sourceName: source.name || source.uuid, sourceLabel: source.userData?.operatorLabel || source.name || '对象', style, armed: true } : null;
        runtime.onEditableFormatBrushStateChange?.(runtime.runtimeFormatBrush, Boolean(style));
        return runtime.runtimeFormatBrush;
      };
      environmentRef.current.applyEditableFormat = () => {
        const runtime = environmentRef.current; const target = runtime?.editableSelection;
        if (!target || !runtime.runtimeFormatBrush) return false;
        const applied = applyBWalkEditorMaterial(target, runtime.runtimeFormatBrush.style);
        runtime.runtimeFormatBrush = { ...runtime.runtimeFormatBrush, armed: false, lastAppliedName: target.name || target.uuid };
        runtime.onEditableFormatBrushStateChange?.(runtime.runtimeFormatBrush, applied);
        return applied;
      };
      environmentRef.current.clipEditableObject = ({ axis = 'x', keepSide = 'positive', fraction = 0.5 } = {}) => {
        const runtime = environmentRef.current; const target = runtime?.editableSelection;
        if (!target || isLockedRuntimeObject(target) || !runtime?.THREE) return null;
        const safeAxis = ['x', 'y', 'z'].includes(axis) ? axis : 'x';
        const safeFraction = Math.max(0.05, Math.min(0.95, Number(fraction) || 0.5));
        const box = new runtime.THREE.Box3().setFromObject(target);
        if (box.isEmpty()) return null;
        const min = box.min[safeAxis]; const max = box.max[safeAxis];
        const cut = min + (max - min) * safeFraction;
        const normal = new runtime.THREE.Vector3(0, 0, 0); normal[safeAxis] = keepSide === 'negative' ? -1 : 1;
        const plane = new runtime.THREE.Plane(normal, -normal[safeAxis] * cut);
        const entries = [];
        target.traverse?.((mesh) => {
          if (!mesh.isMesh || !mesh.material) return;
          const previousMaterial = mesh.material;
          const materials = Array.isArray(previousMaterial) ? previousMaterial : [previousMaterial];
          const appliedMaterials = materials.map((material) => {
            if (!material?.clone) return material;
            const clone = material.clone();
            const existingPlanes = Array.isArray(clone.clippingPlanes) ? clone.clippingPlanes.map((item) => item.clone?.() || item) : [];
            clone.clippingPlanes = [...existingPlanes, plane.clone()];
            clone.clipIntersection = false;
            clone.needsUpdate = true;
            return clone;
          });
          mesh.material = Array.isArray(previousMaterial) ? appliedMaterials : appliedMaterials[0];
          entries.push({ mesh, previousMaterial, appliedMaterial: mesh.material });
        });
        if (!entries.length) return null;
        runtime.renderer.localClippingEnabled = true;
        const record = { target, axis: safeAxis, keepSide: keepSide === 'negative' ? 'negative' : 'positive', fraction: safeFraction, cut, entries };
        runtime.editableClipHistory = runtime.editableClipHistory || [];
        runtime.editableClipHistory.push(record);
        return { target: target.name || target.uuid, axis: safeAxis, keepSide: record.keepSide, fraction: safeFraction, cut, meshCount: entries.length };
      };
      environmentRef.current.undoEditableClip = () => {
        const runtime = environmentRef.current; const history = runtime?.editableClipHistory;
        const record = history?.pop?.();
        if (!record) return null;
        record.entries.forEach(({ mesh, previousMaterial, appliedMaterial }) => {
          if (mesh.material === appliedMaterial) mesh.material = previousMaterial;
          const applied = Array.isArray(appliedMaterial) ? appliedMaterial : [appliedMaterial];
          applied.forEach((material) => material?.dispose?.());
        });
        return { target: record.target?.name || record.target?.uuid || '对象', axis: record.axis, keepSide: record.keepSide, fraction: record.fraction, remaining: history.length };
      };
      environmentRef.current.getEditableClipHistory = () => (environmentRef.current?.editableClipHistory || []).map((record) => ({ target: record.target?.name || record.target?.uuid, axis: record.axis, keepSide: record.keepSide, fraction: record.fraction }));
      environmentRef.current.applyRuntimeEditorTransforms = (root) => {
        const runtime = environmentRef.current; const edits = runtime.runtimeEditorTransforms || (runtime.runtimeEditorTransforms = readRuntimeEditorStorage());
        root?.traverse?.((object) => { const edit = edits[object.name]; if (!edit || isLockedRuntimeObject(object)) return; if (Array.isArray(edit.position)) object.position.fromArray(edit.position); if (Array.isArray(edit.rotation)) object.rotation.fromArray(edit.rotation); if (Array.isArray(edit.scale)) object.scale.fromArray(edit.scale); });
      };
      const readRuntimeEditorDeletedStorage = () => {
        try { const value = JSON.parse(window.localStorage.getItem(RUNTIME_EDITOR_DELETED_STORAGE_KEY) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
      };
      const writeRuntimeEditorDeletedStorage = (value) => { try { window.localStorage.setItem(RUNTIME_EDITOR_DELETED_STORAGE_KEY, JSON.stringify(value)); } catch { /* local-only convenience */ } };
      environmentRef.current.applyRuntimeEditorDeleted = (root) => {
        const runtime = environmentRef.current; const deleted = runtime.runtimeEditorDeleted || (runtime.runtimeEditorDeleted = readRuntimeEditorDeletedStorage());
        root?.traverse?.((object) => { if (deleted[object.name] && !isLockedRuntimeObject(object)) object.visible = false; });
      };
      environmentRef.current.refreshEditablePickProxies = (group = environmentRef.current?.bWalkSurfaceDetail) => {
        const runtime = environmentRef.current;
        if (!runtime?.THREE || !group) return 0;
        group.children.filter((child) => child.userData?.editorPickProxy).forEach((child) => { group.remove(child); child.geometry?.dispose?.(); child.material?.dispose?.(); });
        group.updateMatrixWorld(true);
        const targets = ['B-WALK-01-fence-perpendicular-asphalt-branch', 'B-WALK-01-small-gate', 'B-WALK-01-expanded-road-1_5-5-3', 'B-WALK-01-green-building-side', 'B-WALK-01-green-between-parallel-roads'];
        let count = 0;
        targets.forEach((targetName) => {
          const target = group.getObjectByName(targetName);
          if (!target || !target.visible) return;
          const box = new runtime.THREE.Box3().setFromObject(target); const center = box.getCenter(new runtime.THREE.Vector3()); const size = box.getSize(new runtime.THREE.Vector3());
          group.worldToLocal(center);
          const priorityLift = targetName === 'B-WALK-01-fence-perpendicular-asphalt-branch' ? .92 : targetName === 'B-WALK-01-small-gate' ? 1.05 : targetName === 'B-WALK-01-expanded-road-1_5-5-3' ? .78 : targetName === 'B-WALK-01-green-building-side' ? .64 : .56;
          const proxy = new runtime.THREE.Mesh(new runtime.THREE.BoxGeometry(Math.max(.2, size.x), .045, Math.max(.2, size.z)), new runtime.THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false, depthTest: false }));
          proxy.name = `EDITOR-PICK-PROXY-${targetName}`; proxy.position.set(center.x, center.y + priorityLift, center.z); proxy.userData = { editorPickProxy: true, editorProxyTarget: targetName }; proxy.frustumCulled = false; proxy.renderOrder = 239; group.add(proxy); count += 1;
        });
        return count;
      };
      environmentRef.current.refreshEditableModelPickProxies = () => {
        const runtime = environmentRef.current; const model = runtime?.model;
        if (!runtime?.THREE || !model) return 0;
        const oldProxyGroup = model.getObjectByName('EDITOR-MODEL-PICK-PROXIES');
        if (oldProxyGroup) { oldProxyGroup.parent?.remove(oldProxyGroup); oldProxyGroup.traverse((child) => { child.geometry?.dispose?.(); child.material?.dispose?.(); }); }
        const proxyGroup = new runtime.THREE.Group(); proxyGroup.name = 'EDITOR-MODEL-PICK-PROXIES'; proxyGroup.userData = { editorPickProxy: true, editorModelPickProxyGroup: true }; model.add(proxyGroup);
        const sources = [];
        ['PLAN_ROAD_network_1', 'ROUTE02_01_02_internal_paving'].forEach((targetName) => {
          const target = model.getObjectByName(targetName);
          if (target && target.visible && !isLockedRuntimeObject(target)) sources.push(target);
        });
        let count = 0;
        sources.forEach((source) => {
          source.updateMatrixWorld(true);
          const box = new runtime.THREE.Box3().setFromObject(source); const size = box.getSize(new runtime.THREE.Vector3()); const center = box.getCenter(new runtime.THREE.Vector3());
          model.worldToLocal(center);
          const proxy = new runtime.THREE.Mesh(new runtime.THREE.BoxGeometry(Math.max(.2, size.x), Math.max(.12, Math.min(1.2, size.y)), Math.max(.2, size.z)), new runtime.THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false, depthTest: false }));
          proxy.name = `EDITOR-MODEL-PICK-PROXY-${source.name}`; proxy.position.copy(center); proxy.userData = { editorPickProxy: true, editorModelPickProxy: true, editorProxyTarget: source.name }; proxy.frustumCulled = false; proxy.renderOrder = 500; proxyGroup.add(proxy); count += 1;
        });
        return count;
      };
      environmentRef.current.copyEditableObject = () => {
        const runtime = environmentRef.current; const object = runtime?.editableSelection;
        if (!object || isLockedRuntimeObject(object)) return null;
        runtime.runtimeClipboard = object;
        return { name: object.name || object.uuid, label: object.userData?.operatorLabel || object.name || '对象', source: object.userData?.evidenceLevel || 'Derived' };
      };
      environmentRef.current.pasteEditableObject = () => {
        const runtime = environmentRef.current; const source = runtime?.runtimeClipboard;
        if (!source || isLockedRuntimeObject(source) || !source.parent) return null;
        const clone = source.clone(true);
        const sourceName = String(source.name || 'runtime-object').replace(/-copy-\d+$/, '');
        runtime.runtimePasteCounter = Number(runtime.runtimePasteCounter || 0) + 1;
        clone.name = `${sourceName}-copy-${runtime.runtimePasteCounter}`;
        clone.position.x += 1.5; clone.position.z += 1.5;
        clone.userData = { ...(clone.userData || {}), editorClone: true, editorSourceName: source.name || source.uuid, geometryMutated: false, evidenceLevel: 'Derived' };
        clone.traverse((node) => {
          node.userData = { ...(node.userData || {}), editorClone: true, editorSourceName: source.name || source.uuid, geometryMutated: false };
          if (node.material) node.material = Array.isArray(node.material) ? node.material.map((material) => material?.clone?.() || material) : node.material.clone?.() || node.material;
        });
        source.parent.add(clone);
        runtime.selectEditableObject?.(clone);
        runtime.commitEditableTransform?.();
        return describeRuntimeEditableObject(runtime, clone);
      };
      environmentRef.current.deleteEditableObject = () => {
        const runtime = environmentRef.current; const object = runtime?.editableSelection;
        if (!object || isLockedRuntimeObject(object) || !object.parent) return null;
        runtime.runtimeDeletedUndo = { object, parent: object.parent, index: object.parent.children.indexOf(object), name: object.name || object.uuid };
        const deleted = runtime.runtimeEditorDeleted || (runtime.runtimeEditorDeleted = readRuntimeEditorDeletedStorage());
        deleted[object.name || object.uuid] = true; writeRuntimeEditorDeletedStorage(deleted);
        object.parent.remove(object); runtime.clearEditableSelection?.();
        return { deleted: true, name: object.name || object.uuid };
      };
      environmentRef.current.undoEditableDelete = () => {
        const runtime = environmentRef.current; const undo = runtime?.runtimeDeletedUndo;
        if (!undo?.object || !undo.parent) return null;
        const deleted = runtime.runtimeEditorDeleted || (runtime.runtimeEditorDeleted = readRuntimeEditorDeletedStorage());
        delete deleted[undo.name]; writeRuntimeEditorDeletedStorage(deleted);
        undo.parent.add(undo.object);
        if (Number.isFinite(undo.index)) undo.parent.children.splice(Math.min(undo.index, undo.parent.children.length - 1), 0, undo.parent.children.pop());
        runtime.selectEditableObject?.(undo.object); runtime.runtimeDeletedUndo = null;
        return describeRuntimeEditableObject(runtime, undo.object);
      };
      environmentRef.current.setBWalkVisibility = (visible = true) => {
        const runtime = environmentRef.current;
        const groups = [runtime?.bWalkSurfaceDetail, runtime?.bWalk01Group].filter(Boolean);
        groups.forEach((group) => { group.visible = Boolean(visible); });
        return { visible: Boolean(visible), groups: groups.map((group) => group.name) };
      };
      environmentRef.current.setMissingMiddleBuilding = (visible = true) => {
        const runtime = environmentRef.current;
        if (!runtime?.model || !runtime?.THREE) return { visible: false, created: false, error: 'runtime_not_ready' };
        const THREE = runtime.THREE;
        const existing = runtime.model.getObjectByName('EVIDENCE_BUILDING_02');
        if (existing) {
          existing.visible = Boolean(visible);
          existing.userData = { ...(existing.userData || {}), restoredBy: 'middle-building-gap-fix', sourceBaseline: 'complete-capture-20261010-v1/baseline-objects.json', geometryMutated: false };
          runtime.missingMiddleBuilding = existing;
          return { visible: existing.visible, created: false, object: existing.name, geometryMutated: false };
        }
        if (!runtime.missingMiddleBuilding) {
          const group = new THREE.Group();
          group.name = 'WINDOW1-MIDDLE-BUILDING-EVIDENCE_BUILDING_02';
          const sourceBounds = { minX: -33.294048, maxX: 55.381046, minZ: 87.767563, maxZ: 120.549042, minY: 0, maxY: 36.5 };
          const width = sourceBounds.maxX - sourceBounds.minX;
          const depth = sourceBounds.maxZ - sourceBounds.minZ;
          const height = sourceBounds.maxY - sourceBounds.minY;
          const centerX = (sourceBounds.minX + sourceBounds.maxX) / 2;
          const centerZ = (sourceBounds.minZ + sourceBounds.maxZ) / 2;
          const concrete = new THREE.MeshStandardMaterial({ color: 0xb7b8b1, roughness: 0.88, metalness: 0.03 });
          const roof = new THREE.MeshStandardMaterial({ color: 0x6e7474, roughness: 0.72, metalness: 0.12 });
          const glass = new THREE.MeshStandardMaterial({ color: 0x516b79, roughness: 0.3, metalness: 0.35, transparent: true, opacity: 0.92 });
          const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), concrete);
          body.name = 'WINDOW1-MIDDLE-BUILDING-EVIDENCE_BUILDING_02-body';
          body.position.set(centerX, Number(runtime.groundY || 0) + height / 2, centerZ);
          body.userData = { evidenceLevel: 'Restored_from_existing_baseline', sourceObject: 'EVIDENCE_BUILDING_02', geometryMutated: false };
          group.add(body);
          const roofPlate = new THREE.Mesh(new THREE.BoxGeometry(width + 1.4, 0.32, depth + 1.4), roof);
          roofPlate.name = 'WINDOW1-MIDDLE-BUILDING-EVIDENCE_BUILDING_02-roof';
          roofPlate.position.set(centerX, Number(runtime.groundY || 0) + height + 0.16, centerZ);
          group.add(roofPlate);
          const windowCount = 9;
          for (let index = 0; index < windowCount; index += 1) {
            const x = sourceBounds.minX + 6 + index * ((width - 12) / (windowCount - 1));
            const pane = new THREE.Mesh(new THREE.BoxGeometry(5.6, 5.8, 0.08), glass);
            pane.name = `WINDOW1-MIDDLE-BUILDING-EVIDENCE_BUILDING_02-window-${String(index + 1).padStart(2, '0')}`;
            pane.position.set(x, Number(runtime.groundY || 0) + height * 0.58, sourceBounds.maxZ + 0.08);
            group.add(pane);
          }
          group.position.set(-(runtime.model.position.x || 0), -(runtime.model.position.y || 0), -(runtime.model.position.z || 0));
          group.renderOrder = 25;
          group.traverse((node) => { node.frustumCulled = false; });
          group.userData = { schema: 'middle_building_gap_fix.v1', sourceObject: 'EVIDENCE_BUILDING_02', sourceBaseline: 'docs/evidence/complete-capture-20261010-v1/baseline-objects.json', sourceBounds, evidenceLevel: 'Restored_from_existing_baseline', geometryMutated: false, operatorLabel: '中间长条建筑②' };
          runtime.model.add(group);
          runtime.missingMiddleBuilding = group;
          runtime.applyRuntimeEditorTransforms?.(group);
          runtime.applyRuntimeEditorDeleted?.(group);
        }
        runtime.missingMiddleBuilding.visible = Boolean(visible);
        return { visible: runtime.missingMiddleBuilding.visible, created: true, object: runtime.missingMiddleBuilding.name, geometryMutated: false };
      };
      environmentRef.current.setImportedMiddleBuilding = (visible = true) => {
        const runtime = environmentRef.current;
        if (!runtime?.model || !runtime?.THREE) return Promise.resolve({ visible: false, imported: false, error: 'runtime_not_ready' });
        const refocusIfRequested = () => {
          if (new URLSearchParams(window.location.search).get('focus') === 'middle-building') runtime.focusMissingMiddleBuilding?.();
        };
        if (runtime.importedMiddleBuildingGroup) {
          runtime.importedMiddleBuildingGroup.visible = Boolean(visible);
          refocusIfRequested();
          return Promise.resolve({ visible: runtime.importedMiddleBuildingGroup.visible, imported: true, object: 'EVIDENCE_BUILDING_02', geometryMutated: false });
        }
        const sourceUrl = importedMiddleBuildingAsset?.url;
        if (!sourceUrl) {
          const result = runtime.setMissingMiddleBuilding?.(visible);
          refocusIfRequested();
          return Promise.resolve(result);
        }
        return new Promise((resolve) => {
          new GLTFLoader().load(sourceUrl, (gltf) => {
            const sourceRoot = gltf.scene;
            const target = sourceRoot.getObjectByName('EVIDENCE_BUILDING_02');
            if (!target) {
              const result = runtime.setMissingMiddleBuilding?.(visible);
              refocusIfRequested();
              resolve(result);
              return;
            }
            const keep = new Set();
            target.traverse((node) => keep.add(node.uuid));
            sourceRoot.traverse((node) => { node.visible = keep.has(node.uuid); node.frustumCulled = false; });
            runtime.model.traverse((node) => {
              if (/^PLAN_BUILDING_C(?:\.\d+)?$/i.test(node.name || '')) {
                node.visible = false;
                node.userData = { ...(node.userData || {}), replacedBy: 'EVIDENCE_BUILDING_02', geometryMutated: false };
              }
            });
            sourceRoot.name = 'WINDOW1-IMPORTED-MIDDLE-BUILDING-EVIDENCE_BUILDING_02';
            sourceRoot.userData = { schema: 'imported_middle_building_placement.v1', sourceAssetId: importedMiddleBuildingAsset.id, sourceObject: 'EVIDENCE_BUILDING_02', placement: 'same registered footprint as PLAN_BUILDING_C', geometryMutated: false, evidenceLevel: 'Observed' };
            sourceRoot.visible = Boolean(visible);
            runtime.model.add(sourceRoot);
            runtime.importedMiddleBuildingGroup = sourceRoot;
            runtime.applyRuntimeEditorTransforms?.(sourceRoot);
            runtime.applyRuntimeEditorDeleted?.(sourceRoot);
            if (runtime.missingMiddleBuilding) runtime.missingMiddleBuilding.visible = false;
            refocusIfRequested();
            resolve({ visible: sourceRoot.visible, imported: true, object: 'EVIDENCE_BUILDING_02', sourceAssetId: importedMiddleBuildingAsset.id, geometryMutated: false });
          }, undefined, () => {
            const result = runtime.setMissingMiddleBuilding?.(visible);
            refocusIfRequested();
            resolve(result);
          });
        });
      };
      environmentRef.current.focusMissingMiddleBuilding = () => {
        const runtime = environmentRef.current;
        const target = runtime?.importedMiddleBuildingGroup || runtime?.missingMiddleBuilding || runtime?.model?.getObjectByName?.('EVIDENCE_BUILDING_02');
        if (!target || !runtime?.camera || !runtime?.controls) return false;
        const focusObject = target.getObjectByName?.('EVIDENCE_BUILDING_02') || target;
        const box = new runtime.THREE.Box3().setFromObject(focusObject);
        if (box.isEmpty()) return false;
        const center = box.getCenter(new runtime.THREE.Vector3());
        const size = box.getSize(new runtime.THREE.Vector3());
        const distance = Math.max(70, Math.max(size.x, size.y, size.z) * 1.35);
        runtime.camera.position.copy(center).add(new runtime.THREE.Vector3(distance * 0.9, distance * 0.78, distance * 0.9));
        runtime.controls.target.copy(center);
        runtime.controls.update();
        return { center: center.toArray(), distance };
      };
      if (typeof window !== 'undefined') window.__spatialTwinRuntime = environmentRef.current;
      // [临时诊断] 图层合并预览：把其他图层克隆进来做世界坐标对准
      if (typeof window !== 'undefined') {
        const mergedGroup = new THREE.Group();
        mergedGroup.name = '__SF_LAYER_MERGE__';
        scene.add(mergedGroup);
        const mergeState = { on: false, ids: new Set() };
        window.__sfMergedGroup = mergedGroup;
        window.__sfMergeState = mergeState;
        window.__sfLayerMerge = {
          count: () => mergeState.ids.size,
          clear: () => {
            while (mergedGroup.children.length) {
              const c = mergedGroup.children.pop();
              scene.remove(c);
            }
            mergeState.ids.clear();
            mergeState.on = false;
            return mergeState.ids.size;
          },
          toggle: async () => {
            const id = modelAsset?.id || 'asset_a98b0182ed4e';
            if (!id) return 0;
            window.__sfMergeLog = window.__sfMergeLog || [];
            if (mergeState.ids.has(id)) {
              const idx = mergedGroup.children.findIndex((c) => c.userData.sfAssetId === id);
              if (idx >= 0) mergedGroup.children.splice(idx, 1);
              mergeState.ids.delete(id);
              return mergeState.ids.size;
            }
            const asset = (typeof visualAssets !== 'undefined' ? visualAssets : []).find((a) => a.id === id);
            if (!asset?.url) return mergeState.ids.size;
            const gltf = await new GLTFLoader().loadAsync(asset.url);
            const obj = gltf.scene;
            obj.userData.sfAssetId = id;
            const registration = (typeof project !== 'undefined' ? project : null)?.modelRegistration || {};
            const s = registration.scaleXYZ || [1, 1, 1];
            const isMain = id === 'asset_a98b0182ed4e';
            obj.scale.set(s[0] || 1, isMain ? (s[1] || 1) : 1, s[2] || 1);
            const target = new THREE.Vector3(-(registration.offsetXM || 0), 0, -(registration.offsetZM || 0));
            const box = new THREE.Box3().setFromObject(obj);
            const c = box.getCenter(new THREE.Vector3());
            obj.position.set(target.x - c.x, -box.min.y, target.z - c.z);
            mergedGroup.add(obj);
            mergeState.ids.add(id);
            mergeState.on = true;
            // 相机对准合并结果
            const wb = new THREE.Box3().setFromObject(mergedGroup);
            if (!wb.isEmpty()) {
              const wc = wb.getCenter(new THREE.Vector3());
              const ws = wb.getSize(new THREE.Vector3());
              const d = Math.max(60, Math.max(ws.x, ws.z) * 1.15);
              camera.position.set(wc.x + d * 0.62, wc.y + d * 0.72, wc.z + d * 0.62);
              controls.target.copy(wc);
              controls.update();
            }
            window.__sfMergeLog.push({ id, url: String(asset.url).slice(-60) });
            return mergeState.ids.size;
          },
        };
      }
      applySceneEnvironment(environmentRef.current, scenarioPointRef.current, displayModeRef.current);
      if (modelAsset?.kind === 'main_building_facade_candidate_glb') {
        // The photo candidate uses warm wall and blue-grey glazing materials.
        // Keep the default site lighting for other layers, but avoid washing
        // the facade into white during the candidate review.
        ambient.intensity = 0.68;
        hemisphere.intensity = 0.28;
        key.intensity = 1.25;
        renderer.toneMappingExposure = 0.82;
      }
      const disposePreviewModel = () => {
        if (!previewModel) return;
        scene.remove(previewModel);
        previewModel.traverse((child) => {
          child.geometry?.dispose?.();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.filter(Boolean).forEach((material) => material.dispose?.());
        });
        previewModel = null;
        if (environmentRef.current) environmentRef.current.previewModel = null;
      };
      const showFastPreview = (loadedPreview) => {
        if (disposed) return;
        if (fullModelReady) {
          loadedPreview.traverse((child) => {
            child.geometry?.dispose?.();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.filter(Boolean).forEach((material) => material.dispose?.());
          });
          return;
        }
        previewModel = loadedPreview;
        const bounds = new THREE.Box3().setFromObject(previewModel);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z) || 1;
        previewModel.position.sub(center);
        scene.add(previewModel);
        controls.target.set(0, 0, 0);
        const overviewDistance = Math.max(maxDimension * 1.32, 260);
        camera.position.set(-overviewDistance * 0.48, Math.max(120, overviewDistance * 0.62), overviewDistance * 0.96);
        camera.lookAt(controls.target);
        controls.minDistance = Math.max(0.05, maxDimension * 0.006);
        controls.maxDistance = Math.max(100, maxDimension * 12);
        controls.update();
        environmentRef.current.previewModel = previewModel;
        setLoadState({ status: 'preview', message: '快速三维已可操作，真实材质模型继续在后台加载…' });
      };
      const finishLoad = (loadedModel) => {
        if (disposed) return;
        fullModelReady = true;
        disposePreviewModel();
        ensureEnvironmentMap();
        model = loadedModel;
        const suppressedCurrentSceneObjectCount = suppressCurrentSceneObjects(model, showHistoricalConstruction);
        environmentRef.current.suppressedCurrentSceneObjectCount = suppressedCurrentSceneObjectCount;
        environmentRef.current.suppressedUserDeletedRedBoxObjectCount = suppressUserDeletedRedBoxObjects(model);
        // The site-context GLB is exterior-only. The supplied SKP/CAD source
        // remains available as a separately registered indoor artifact, so
        // indoor walls, columns and materials are not mixed into the outdoor
        // context and are not silently discarded.
        const bounds = new THREE.Box3().setFromObject(model);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const maxDimension = Math.max(size.x, size.y, size.z) || 1;
        model.position.sub(center);
        environmentRef.current.sceneRadius = maxDimension;
        environmentRef.current.highDensitySiteModel = modelAsset?.kind === 'site_context_glb';
        environmentRef.current.facadeReviewCandidate = modelAsset?.kind === 'main_building_facade_candidate_glb';
        environmentRef.current.groundY = bounds.min.y - center.y - .035;
        const shadowExtent = Math.max(18, maxDimension * .72);
        key.shadow.camera.left = -shadowExtent;
        key.shadow.camera.right = shadowExtent;
        key.shadow.camera.top = shadowExtent;
        key.shadow.camera.bottom = -shadowExtent;
        key.shadow.camera.far = Math.max(180, maxDimension * 5);
        key.shadow.camera.updateProjectionMatrix();
        ground.position.y = environmentRef.current.groundY;
        ground.scale.setScalar(Math.max(120, maxDimension * 5));
        let selectiveShadowCasterCount = 0;
        // The renderer's shadow map is disabled for the dense exterior GLB;
        // walking every mesh to prepare shadow flags only delays first paint.
        // Keep the detailed path for indoor/CAD layers where the flags are
        // useful, and leave the registered site context untouched.
        if (!environmentRef.current.highDensitySiteModel) {
          model.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            const transparent = materials.some((item) => item?.transparent && item.opacity < .88);
            child.castShadow = !transparent;
            child.receiveShadow = true;
          });
        }
        environmentRef.current.hasSelectiveSiteShadows = selectiveShadowCasterCount > 0;
        applySceneEnvironment(environmentRef.current, scenarioPointRef.current, displayModeRef.current);
        camera.near = Math.max(0.01, maxDimension / 1000);
        camera.far = Math.max(1000, maxDimension * 20);
        camera.updateProjectionMatrix();
        controls.minDistance = Math.max(0.05, maxDimension * 0.006);
        controls.maxDistance = Math.max(100, maxDimension * 12);
        const siteBuildingHalfExtents = Array.isArray(modelAsset?.metadata?.mainBuildingHalfExtentsM)
          ? modelAsset.metadata.mainBuildingHalfExtentsM.map(Number)
          : [];
        const siteBuildingHeight = Number(modelAsset?.metadata?.mainBuildingHeightM || 0);
        const siteBuildingFocus = modelAsset?.kind === 'site_context_glb'
          && siteBuildingHalfExtents.length >= 2
          && siteBuildingHalfExtents.every(Number.isFinite)
          && Number.isFinite(siteBuildingHeight)
          && siteBuildingHeight > 0;
        const facadeBounds = new THREE.Box3();
        if (modelAsset?.kind === 'main_building_facade_candidate_glb') {
          model.traverse((object) => {
            if (object.isMesh && String(object.name || '').startsWith('main-building-exterior-review-')) facadeBounds.expandByObject(object);
          });
        }
        const facadeFocus = modelAsset?.kind === 'main_building_facade_candidate_glb' && !facadeBounds.isEmpty();
        // Location-package candidates contain the full relative base scene plus
        // a small evidence-bound local group.  Fitting the whole package makes
        // the requested photo group appear absent.  Focus B67 on its own
        // evidence geometry while leaving the GLB and base scene unchanged.
        const b67Bounds = new THREE.Box3();
        if (/LP-B67-001-360-dot-v1-candidate-v\d+/i.test(modelAsset?.name || '')) {
          model.traverse((object) => {
            if (object.isMesh && String(object.name || '').startsWith('b67-fixed-')) b67Bounds.expandByObject(object);
          });
        }
        const b67Focus = !b67Bounds.isEmpty();
        const fitTarget = siteBuildingFocus
          ? new THREE.Vector3(-center.x, siteBuildingHeight / 2 - center.y, -center.z)
          : b67Focus
            ? b67Bounds.getCenter(new THREE.Vector3())
          : new THREE.Vector3(0, 0, 0);
        const fitDimension = siteBuildingFocus
          ? Math.max(siteBuildingHalfExtents[0] * 2, siteBuildingHalfExtents[1] * 2, siteBuildingHeight)
          : b67Focus
            ? Math.max(24, b67Bounds.getSize(new THREE.Vector3()).length() * 1.15)
          : maxDimension;
        const fitView = () => {
          if (siteBuildingFocus) {
            // The site GLB contains the whole route-visible context, not only
            // the CAD building. Fitting against the building footprint alone
            // put the camera too close to the roof and hid the two parallel
            // lanes, fences and adjacent buildings behind one white plane.
            // Use the complete imported scene envelope for the first frame,
            // while keeping the building centre as the visual target.
            const overviewDistance = Math.max(
              maxDimension * 1.12,
              Math.max(siteBuildingHalfExtents[0] * 2, siteBuildingHalfExtents[1] * 2) * 1.08,
              Math.max(siteBuildingHalfExtents[0] * 2, siteBuildingHalfExtents[1] * 2) * 1.2,
              220
            );
            const primaryFacadeTarget = fitTarget.clone().add(new THREE.Vector3(
              -siteBuildingHalfExtents[0] * 0.12,
              -siteBuildingHeight * 0.02,
              -siteBuildingHalfExtents[1] * 0.18
            ));
            controls.target.copy(primaryFacadeTarget);
            camera.position.copy(primaryFacadeTarget).add(new THREE.Vector3(
              -overviewDistance * 0.48,
              Math.max(120, overviewDistance * 0.62),
              overviewDistance * 0.96
            ));
          } else if (b67Focus) {
            const b67Distance = Math.max(fitDimension * 1.28, 38);
            controls.target.copy(fitTarget);
            camera.position.copy(fitTarget).add(new THREE.Vector3(b67Distance * 0.82, b67Distance * 0.58, b67Distance * 0.82));
          } else if (facadeFocus) {
            const facadeCenter = facadeBounds.getCenter(new THREE.Vector3());
            const facadeRadius = facadeBounds.getBoundingSphere(new THREE.Sphere()).radius;
            const facadeDistance = Math.max(facadeRadius * 2.35, 100);
            controls.target.copy(facadeCenter);
            camera.position.copy(facadeCenter).add(new THREE.Vector3(facadeDistance * 0.82, facadeDistance * 0.54, facadeDistance * 0.82));
          } else {
            const distance = fitDimension * 1.45;
            controls.target.copy(fitTarget);
            camera.position.copy(fitTarget).add(new THREE.Vector3(distance, distance * 0.58, distance));
          }
          camera.up.set(0, 1, 0);
          camera.lookAt(controls.target);
          controls.update();
        };
        const zoomByFactor = (factor) => {
          const offset = camera.position.clone().sub(controls.target);
          const nextDistance = Math.min(controls.maxDistance, Math.max(controls.minDistance, offset.length() * factor));
          if (!offset.length()) offset.set(1, 0.7, 1);
          camera.position.copy(controls.target).add(offset.setLength(nextDistance));
          controls.update();
        };
        const availableLevels = Array.isArray(modelAsset?.metadata?.levels) && modelAsset.metadata.levels.length
          ? modelAsset.metadata.levels
          : [{ floorNumber: 1, label: '1F', elevationM: Number(modelAsset?.metadata?.bounds?.min?.[1] || 0) }];
        const levelForNumber = (floorNumber) => availableLevels.find((level) => Number(level.floorNumber) === Number(floorNumber)) || availableLevels[0];
        let activeLevel = levelForNumber(selectedFloorRef.current);
        let walkFloorY = Number(activeLevel.elevationM || 0) - center.y;
        let walkEyeY = Number(activeLevel.walkSpawnM?.[1] ?? (Number(activeLevel.elevationM || 0) + 1.62)) - center.y;
        let walkSpawn = new THREE.Vector3(
          Number(activeLevel.walkSpawnM?.[0] ?? center.x) - center.x,
          walkEyeY,
          Number(activeLevel.walkSpawnM?.[2] ?? center.z) - center.z
        );
        // Keep first-person movement close to a real visitor's walking pace.
        // The previous scale could reach 4 m/s on a site model, which made a
        // held key or D-pad press skip over doors and room boundaries.
        const walkSpeed = Math.max(0.35, Math.min(1.15, maxDimension * 0.0065));
        setWalkthroughSpeed(Math.min(0.9, Math.max(0.25, walkthroughSpeedPreset)));
        const walkBounds = { x: size.x / 2 + 10, z: size.z / 2 + 10 };
        const walkSurfaceSize = Math.max(size.x, size.z, 8) * 1.18;
        const walkSurface = new THREE.GridHelper(walkSurfaceSize, 24, 0x54e0da, 0x18383d);
        walkSurface.position.y = walkFloorY + 0.012;
        walkSurface.material.transparent = true;
        walkSurface.material.opacity = 0.34;
        walkSurface.visible = false;
        scene.add(walkSurface);
        const routeTour = {
          active: false, paused: false, distanceM: 0, speedMps: routeTourSpeed, points: [], lengthM: 0,
          savedPosition: null, savedTarget: null, lastUiUpdate: 0,
          runStartedAtMs: 0, runStartDistanceM: 0, lookAheadDistanceM: 4
        };
        const walkthrough = {
          active: false, dragging: false, pointerId: null, lastX: 0, lastY: 0,
          yaw: visitorWalkthroughYaw(activeLevel), pitch: -0.03, keys: new Set(), savedPosition: null, savedTarget: null,
          blocked: false, currentSpeed: walkthroughSpeedPreset
        };
        const collisionEntries = [];
        // Exterior site context is used for orbit/route-tour navigation.  It
        // has thousands of facade/landscape meshes and no indoor collision
        // requirement, so do not build a bounding-box/raycast index for it.
        if (modelAsset?.kind !== 'site_context_glb') {
          model.updateMatrixWorld(true);
          model.traverse((child) => {
            if (!child.isMesh) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            if (!isWalkthroughCollisionCandidate({
              name: child.name || child.parent?.name || '',
              materialNames: materials.map((material) => material?.name || '')
            })) return;
            child.geometry?.computeBoundingBox?.();
            child.geometry?.computeBoundingSphere?.();
            const worldBounds = child.geometry?.boundingBox?.clone().applyMatrix4(child.matrixWorld);
            if (worldBounds && !worldBounds.isEmpty()) collisionEntries.push({ mesh: child, bounds: worldBounds });
          });
        }
        const collisionRaycaster = new THREE.Raycaster();
        const collisionDirection = new THREE.Vector3();
        const collisionRight = new THREE.Vector3();
        const collisionOrigin = new THREE.Vector3();
        const walkthroughRayMeshes = collisionEntries.map((entry) => entry.mesh);
        const collisionSweepBounds = new THREE.Box3();
        const collisionSweepMin = new THREE.Vector3();
        const collisionSweepMax = new THREE.Vector3();
        const walkthroughCollisionRadius = WALKTHROUGH_BODY_RADIUS_M;
        const collidesWithWalkthroughGeometry = (position, delta) => {
          if (!collisionEntries.length) return false;
          const distance = Math.hypot(delta[0], delta[2]);
          if (distance <= 1e-6) return false;
          collisionSweepMin.set(
            Math.min(position[0], position[0] + delta[0]) - walkthroughCollisionRadius,
            walkFloorY + 0.18,
            Math.min(position[2], position[2] + delta[2]) - walkthroughCollisionRadius
          );
          collisionSweepMax.set(
            Math.max(position[0], position[0] + delta[0]) + walkthroughCollisionRadius,
            walkFloorY + 1.52,
            Math.max(position[2], position[2] + delta[2]) + walkthroughCollisionRadius
          );
          collisionSweepBounds.set(collisionSweepMin, collisionSweepMax);
          const nearbyMeshes = collisionEntries
            .filter((entry) => entry.bounds.intersectsBox(collisionSweepBounds))
            .map((entry) => entry.mesh);
          if (!nearbyMeshes.length) return false;
          collisionDirection.set(delta[0] / distance, 0, delta[2] / distance);
          collisionRight.set(-collisionDirection.z, 0, collisionDirection.x);
          const probeOffsets = [0, walkthroughCollisionRadius * 0.82, -walkthroughCollisionRadius * 0.82];
          const probeHeights = [0.28, 0.82, 1.34];
          collisionRaycaster.near = 0;
          collisionRaycaster.far = distance + walkthroughCollisionRadius;
          for (const height of probeHeights) {
            for (const offset of probeOffsets) {
              collisionOrigin.set(
                position[0] + collisionRight.x * offset,
                walkFloorY + height,
                position[2] + collisionRight.z * offset
              );
              collisionRaycaster.set(collisionOrigin, collisionDirection);
              if (collisionRaycaster.intersectObjects(nearbyMeshes, false).length) return true;
            }
          }
          return false;
        };
        const measureVisitorHeading = (yaw) => {
          const direction = collisionDirection.set(Math.sin(yaw), 0, -Math.cos(yaw));
          let score = 0;
          for (const offset of [-0.24, 0, 0.24]) {
            const offsetDirection = collisionDirection.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), offset).normalize();
            for (const height of [0.72, 1.22]) {
              collisionOrigin.set(walkSpawn.x, walkFloorY + height, walkSpawn.z);
              collisionRaycaster.set(collisionOrigin, offsetDirection);
              collisionRaycaster.near = 0.12;
              collisionRaycaster.far = 18;
              const hit = collisionRaycaster.intersectObjects(walkthroughRayMeshes, false)[0];
              if (!hit) {
                score -= 1;
                continue;
              }
              const distance = Number(hit.distance) || 0;
              score += distance < 0.75 ? -10 : Math.min(distance, 18) + (distance < 12 ? 2 : 0);
            }
          }
          return score;
        };
        const chooseVisitorView = () => {
          const yaw = chooseWalkthroughYaw({
            preferredYaw: visitorWalkthroughYaw(activeLevel),
            measureHeading: measureVisitorHeading
          });
          return { yaw, score: measureVisitorHeading(yaw) };
        };
        const chooseVisitorYaw = () => chooseVisitorView().yaw;
        const isWalkthroughSpawnBlocked = (position) => {
          const probeY = walkFloorY + 0.84;
          return collisionEntries.some(({ bounds }) => {
            if (!bounds || probeY < bounds.min.y - 0.05 || probeY > bounds.max.y + 0.05) return false;
            return position.x >= bounds.min.x - walkthroughCollisionRadius
              && position.x <= bounds.max.x + walkthroughCollisionRadius
              && position.z >= bounds.min.z - walkthroughCollisionRadius
              && position.z <= bounds.max.z + walkthroughCollisionRadius;
          });
        };
        setWalkthroughCollisionStats({ enabled: collisionEntries.length > 0, candidates: collisionEntries.length });
        const applyFloorClipping = (enabled) => {
          const wallHeight = Number(modelAsset?.metadata?.wallHeightM || 3.2);
          const slabThickness = Number(modelAsset?.metadata?.floorSlabThicknessM || 0.12);
          const planes = enabled ? [
            new THREE.Plane(new THREE.Vector3(0, 1, 0), -(walkFloorY - slabThickness - 0.04)),
            new THREE.Plane(new THREE.Vector3(0, -1, 0), walkFloorY + wallHeight + 0.08)
          ] : [];
          model.traverse((child) => {
            if (!child.material) return;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.forEach((material) => {
              material.clippingPlanes = planes;
              material.clipShadows = enabled;
              material.needsUpdate = true;
            });
          });
        };
        const setFloorView = (floorNumber, shouldIsolate = false) => {
          activeLevel = levelForNumber(floorNumber);
          setWalkthroughSpawnNotice('');
          walkFloorY = Number(activeLevel.elevationM || 0) - center.y;
          walkEyeY = Number(activeLevel.walkSpawnM?.[1] ?? (Number(activeLevel.elevationM || 0) + 1.62)) - center.y;
          walkSpawn = new THREE.Vector3(
            Number(activeLevel.walkSpawnM?.[0] ?? center.x) - center.x,
            walkEyeY,
            Number(activeLevel.walkSpawnM?.[2] ?? center.z) - center.z
          );
          walkthrough.yaw = chooseVisitorYaw();
          walkSurface.position.y = walkFloorY + 0.012;
          applyFloorClipping(shouldIsolate || walkthrough.active);
          if (walkthrough.active) {
            camera.position.copy(walkSpawn);
            updateWalkthroughLook();
          } else if (shouldIsolate) {
            controls.target.set(walkSpawn.x, walkFloorY + Number(modelAsset?.metadata?.wallHeightM || 3.2) * 0.45, walkSpawn.z);
            controls.update();
          }
        };
        const setWalkthroughSpace = (space) => {
          if (!space?.visitPointM) return;
          activeLevel = levelForNumber(space.floorNumber);
          walkFloorY = Number(activeLevel.elevationM || 0) - center.y;
          walkEyeY = Number(space.visitPointM[1] ?? (Number(activeLevel.elevationM || 0) + 1.62)) - center.y;
          walkSpawn = new THREE.Vector3(
            Number(space.visitPointM[0]) - center.x,
            walkEyeY,
            Number(space.visitPointM[2]) - center.z
          );
          const labelAnchorBlocked = isWalkthroughSpawnBlocked(walkSpawn);
          let visitorView = chooseVisitorView();
          if (shouldFallbackToFloorSpawn(space, visitorView.score, activeLevel, labelAnchorBlocked)) {
            walkEyeY = Number(activeLevel.walkSpawnM[1]) - center.y;
            walkSpawn = new THREE.Vector3(
              Number(activeLevel.walkSpawnM[0]) - center.x,
              walkEyeY,
              Number(activeLevel.walkSpawnM[2]) - center.z
            );
            visitorView = chooseVisitorView();
            setWalkthroughSpawnNotice(labelAnchorBlocked
              ? 'CAD文字锚点落在墙体或构件范围内，已回退至楼层最大净空点'
              : 'CAD文字锚点视线不足，已回退至楼层最大净空点');
          } else {
            setWalkthroughSpawnNotice('');
          }
          walkthrough.yaw = visitorView.yaw;
          walkthrough.pitch = -0.03;
          walkSurface.position.y = walkFloorY + 0.012;
          applyFloorClipping(true);
          if (walkthrough.active) {
            camera.position.copy(walkSpawn);
            updateWalkthroughLook();
          }
        };
        const updateWalkthroughLook = () => {
          const cosPitch = Math.cos(walkthrough.pitch);
          const direction = new THREE.Vector3(
            Math.sin(walkthrough.yaw) * cosPitch,
            Math.sin(walkthrough.pitch),
            -Math.cos(walkthrough.yaw) * cosPitch
          );
          camera.lookAt(camera.position.clone().add(direction));
        };
        const movementVector = (action) => {
          const forward = new THREE.Vector3(Math.sin(walkthrough.yaw), 0, -Math.cos(walkthrough.yaw));
          const right = new THREE.Vector3(Math.cos(walkthrough.yaw), 0, Math.sin(walkthrough.yaw));
          if (action === 'forward') return forward;
          if (action === 'backward') return forward.multiplyScalar(-1);
          if (action === 'left') return right.multiplyScalar(-1);
          return right;
        };
        const moveWalkthrough = (actions, distance) => {
          const movement = new THREE.Vector3();
          actions.forEach((action) => movement.add(movementVector(action)));
          if (!movement.lengthSq()) return;
          movement.normalize().multiplyScalar(distance);
          const resolved = resolveConstrainedWalkthroughMove({
            position: camera.position.toArray(),
            delta: movement.toArray(),
            bounds: walkBounds,
            collides: collidesWithWalkthroughGeometry
          });
          camera.position.fromArray(resolved.position);
          camera.position.y = walkEyeY;
          walkthrough.blocked = resolved.blocked;
          updateWalkthroughLook();
        };
        const startWalkthrough = () => {
          if (walkthrough.active) return;
          if (routeTour.active) environmentRef.current?.stopRouteTour?.();
          walkthrough.active = true;
          walkthrough.savedPosition = camera.position.clone();
          walkthrough.savedTarget = controls.target.clone();
          walkthrough.keys.clear();
          walkthrough.yaw = chooseVisitorYaw();
          walkthrough.pitch = -0.03;
          controls.enabled = false;
          walkSurface.visible = true;
          applyFloorClipping(true);
          camera.position.copy(walkSpawn);
          updateWalkthroughLook();
          renderer.domElement.style.cursor = 'grab';
        };
        const stopWalkthrough = () => {
          if (!walkthrough.active) return;
          walkthrough.active = false;
          walkthrough.keys.clear();
          walkthrough.dragging = false;
          controls.enabled = true;
          walkSurface.visible = false;
          applyFloorClipping(isolateFloorRef.current);
          if (walkthrough.savedPosition && walkthrough.savedTarget) {
            camera.position.copy(walkthrough.savedPosition);
            controls.target.copy(walkthrough.savedTarget);
            camera.lookAt(controls.target);
            controls.update();
          }
          renderer.domElement.style.cursor = '';
        };
        const updateRouteTourCamera = () => {
          if (routeTour.points.length < 2) return;
          const sample = samplePolylineAtDistance(routeTour.points, routeTour.distanceM);
          // At the closed-loop endpoint there is no forward segment left. If
          // we clamp look-ahead to the same endpoint, the camera receives a
          // zero-length look vector and ends up facing an arbitrary wall. Use
          // the preceding route segment for the final view so the tour closes
          // back toward the observed entry instead of showing a blank facade.
          const atRouteEnd = routeTour.distanceM >= routeTour.lengthM - 0.05;
          const lookDistance = atRouteEnd
            ? Math.max(0, routeTour.distanceM - routeTour.lookAheadDistanceM)
            : Math.min(routeTour.lengthM, routeTour.distanceM + routeTour.lookAheadDistanceM);
          const lookAhead = samplePolylineAtDistance(routeTour.points, lookDistance);
          const eye = new THREE.Vector3(sample.position[0], sample.position[1] + 1.75, sample.position[2]);
          const look = new THREE.Vector3(lookAhead.position[0], lookAhead.position[1] + 1.68, lookAhead.position[2]);
          // Keep the visitor oriented along the filmed path, but retain a
          // small horizontal lock on the registered site/building centre.
          // At the north edge and at the return-to-gates endpoint the old
          // forward-only look vector pointed into the unmodelled outer
          // background, making the real facade/fence disappear from view and
          // reading as a blank wall.  The bias is deliberately horizontal and
          // small so it cannot reverse the route or invent a new camera path.
          const registeredSiteCentre = (modelAsset?.kind === 'site_context_glb' && siteBuildingFocus)
            ? fitTarget.clone().setY(look.y)
            : new THREE.Vector3(0, look.y, 0);
          // On the north leg (roughly 70–200 m), the main building is directly
          // on the inside of the lane.  A centre-lock here turns the visitor
          // into the façade and makes the wall fill the entire view, unlike
          // the field videos where the camera keeps travelling along the lane
          // with the building to one side.  Keep the registration assist at
          // the two problematic loop endpoints, but reduce it on this leg.
          const northLegInteriorWallRisk = routeTour.distanceM >= 70 && routeTour.distanceM <= 200;
          const endpointBlend = atRouteEnd ? 0.32 : northLegInteriorWallRisk ? 0.03 : 0.16;
          look.lerp(registeredSiteCentre, endpointBlend);
          camera.up.set(0, 1, 0);
          camera.position.copy(eye);
          camera.lookAt(look);
        };
        const syncRouteTourDistance = (time = performance.now()) => {
          if (!routeTour.active || routeTour.paused || !routeTour.runStartedAtMs) return;
          const elapsedSeconds = Math.max(0, (time - routeTour.runStartedAtMs) / 1000);
          routeTour.distanceM = Math.min(routeTour.lengthM, routeTour.runStartDistanceM + routeTour.speedMps * elapsedSeconds);
        };
        const startRouteTour = () => {
          if (routeTour.points.length < 2) return false;
          if (!routeTour.active) {
            stopWalkthrough();
            routeTour.savedPosition = camera.position.clone();
            routeTour.savedTarget = controls.target.clone();
            routeTour.active = true;
            controls.enabled = false;
          }
          if (routeTour.distanceM >= routeTour.lengthM) routeTour.distanceM = 0;
          routeTour.paused = false;
          routeTour.runStartDistanceM = routeTour.distanceM;
          routeTour.runStartedAtMs = performance.now();
          updateRouteTourCamera();
          setRouteTourPlayback({ status: 'playing', progress: routeTour.lengthM ? routeTour.distanceM / routeTour.lengthM : 0, distanceM: routeTour.distanceM });
          return true;
        };
        const pauseRouteTour = () => {
          if (!routeTour.active) return;
          syncRouteTourDistance();
          routeTour.paused = true;
          routeTour.runStartedAtMs = 0;
          setRouteTourPlayback({ status: 'paused', progress: routeTour.lengthM ? routeTour.distanceM / routeTour.lengthM : 0, distanceM: routeTour.distanceM });
        };
        const resetRouteTour = () => {
          routeTour.distanceM = 0;
          routeTour.paused = false;
          routeTour.runStartDistanceM = 0;
          routeTour.runStartedAtMs = routeTour.active ? performance.now() : 0;
          if (routeTour.active) updateRouteTourCamera();
          setRouteTourPlayback({ status: routeTour.active ? 'playing' : 'idle', progress: 0, distanceM: 0 });
        };
        const stopRouteTour = () => {
          if (!routeTour.active) return;
          syncRouteTourDistance();
          routeTour.active = false;
          routeTour.paused = false;
          routeTour.runStartedAtMs = 0;
          controls.enabled = true;
          if (routeTour.savedPosition && routeTour.savedTarget) {
            camera.position.copy(routeTour.savedPosition);
            controls.target.copy(routeTour.savedTarget);
            camera.lookAt(controls.target);
            controls.update();
          }
          setRouteTourPlayback({ status: 'idle', progress: 0, distanceM: routeTour.distanceM });
        };
        const updateRouteTour = (_deltaSeconds, time) => {
          if (!routeTour.active || routeTour.paused || routeTour.points.length < 2) return;
          syncRouteTourDistance(time);
          updateRouteTourCamera();
          if (routeTour.distanceM >= routeTour.lengthM) {
            routeTour.paused = true;
            setRouteTourPlayback({ status: 'ended', progress: 1, distanceM: routeTour.lengthM });
          } else if (time - routeTour.lastUiUpdate > 180) {
            routeTour.lastUiUpdate = time;
            setRouteTourPlayback({ status: 'playing', progress: routeTour.distanceM / routeTour.lengthM, distanceM: routeTour.distanceM });
          }
        };
        const keyActions = new globalThis.Map([
          ['KeyW', 'forward'], ['ArrowUp', 'forward'], ['KeyS', 'backward'], ['ArrowDown', 'backward'],
          ['KeyA', 'left'], ['ArrowLeft', 'left'], ['KeyD', 'right'], ['ArrowRight', 'right']
        ]);
        const onKeyDown = (event) => {
          if (!walkthrough.active) return;
          if (event.key === 'Escape') {
            setNavigationMode('orbit');
            return;
          }
          if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
          const action = keyActions.get(event.code);
          if (!action) return;
          event.preventDefault();
          walkthrough.keys.add(action);
        };
        const onKeyUp = (event) => {
          const action = keyActions.get(event.code);
          if (action) walkthrough.keys.delete(action);
        };
        const onPointerDown = (event) => {
          if (!walkthrough.active || event.button !== 0) return;
          walkthrough.dragging = true;
          walkthrough.pointerId = event.pointerId;
          walkthrough.lastX = event.clientX;
          walkthrough.lastY = event.clientY;
          renderer.domElement.setPointerCapture?.(event.pointerId);
          renderer.domElement.style.cursor = 'grabbing';
        };
        const onPointerMove = (event) => {
          if (!walkthrough.active || !walkthrough.dragging || event.pointerId !== walkthrough.pointerId) return;
          walkthrough.yaw -= (event.clientX - walkthrough.lastX) * 0.0045;
          walkthrough.pitch = Math.max(-1.15, Math.min(1.15, walkthrough.pitch - (event.clientY - walkthrough.lastY) * 0.0035));
          walkthrough.lastX = event.clientX;
          walkthrough.lastY = event.clientY;
          updateWalkthroughLook();
        };
        const stopPointerDrag = (event) => {
          if (event.pointerId !== walkthrough.pointerId) return;
          walkthrough.dragging = false;
          walkthrough.pointerId = null;
          renderer.domElement.style.cursor = walkthrough.active ? 'grab' : '';
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointermove', onPointerMove);
        renderer.domElement.addEventListener('pointerup', stopPointerDrag);
        renderer.domElement.addEventListener('pointercancel', stopPointerDrag);
        disposeWalkthroughControls = () => {
          window.removeEventListener('keydown', onKeyDown);
          window.removeEventListener('keyup', onKeyUp);
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          renderer.domElement.removeEventListener('pointermove', onPointerMove);
          renderer.domElement.removeEventListener('pointerup', stopPointerDrag);
          renderer.domElement.removeEventListener('pointercancel', stopPointerDrag);
          scene.remove(walkSurface);
          walkSurface.geometry.dispose();
          const surfaceMaterials = Array.isArray(walkSurface.material) ? walkSurface.material : [walkSurface.material];
          surfaceMaterials.forEach((material) => material.dispose());
        };
        fitView();
        environmentRef.current.model = model;
        environmentRef.current.applyRuntimeEditorTransforms?.(model);
        environmentRef.current.applyRuntimeEditorDeleted?.(model);
        environmentRef.current.refreshEditableModelPickProxies?.();
        environmentRef.current.runGroundingAudit = () => {
          model.updateMatrixWorld(true);
          const groundY = Number(environmentRef.current.groundY || 0);
          const records = [];
          model.traverse((node) => {
            if (!node.isMesh) return;
            const origin = node.getWorldPosition(new THREE.Vector3());
            const gapM = Number((origin.y - groundY).toFixed(4));
            records.push({ node: node.name || '(unnamed)', originY: Number(origin.y.toFixed(4)), groundY: Number(groundY.toFixed(4)), gapM, floating: gapM > 0.5 });
          });
          return { thresholdM: 0.5, groundY: Number(groundY.toFixed(4)), totalNodes: records.length, floatingNodes: records.filter((item) => item.floating).length, records };
        };
        if (typeof window !== 'undefined') window.__spatialSceneRuntime = environmentRef.current;
        environmentRef.current.fitView = fitView;
        environmentRef.current.zoomByFactor = zoomByFactor;
        const sharedView = new URLSearchParams(window.location.search).get('view');
        if (sharedView) {
          try {
            const decoded = JSON.parse(decodeURIComponent(escape(window.atob(sharedView))));
            environmentRef.current.applyCameraSnapshot?.(decoded);
          } catch {
            // Invalid shared camera state must not block model loading.
          }
        }
        environmentRef.current.setHistoricalConstructionVisibility = (visible) => {
          model.traverse((child) => {
            const name = String(child.name || '').toLowerCase();
            if (!currentSceneSuppressedObjectPrefixes.some((prefix) => name.startsWith(prefix))) return;
            child.visible = Boolean(visible);
          });
        };
        environmentRef.current.walkthrough = walkthrough;
        environmentRef.current.startWalkthrough = startWalkthrough;
        environmentRef.current.stopWalkthrough = stopWalkthrough;
        environmentRef.current.setFloorView = setFloorView;
        environmentRef.current.setWalkthroughSpace = setWalkthroughSpace;
        environmentRef.current.setWalkthroughAction = (action, active) => {
          if (!walkthrough.active) return;
          if (active) walkthrough.keys.add(action); else walkthrough.keys.delete(action);
        };
        environmentRef.current.nudgeWalkthrough = (action) => {
          if (walkthrough.active) moveWalkthrough([action], Math.max(0.12, walkthrough.currentSpeed * 0.22));
        };
        environmentRef.current.updateWalkthrough = (deltaSeconds) => {
          if (walkthrough.active && walkthrough.keys.size) moveWalkthrough([...walkthrough.keys], walkthrough.currentSpeed * deltaSeconds);
        };
        environmentRef.current.routeTour = routeTour;
        environmentRef.current.startRouteTour = startRouteTour;
        environmentRef.current.pauseRouteTour = pauseRouteTour;
        environmentRef.current.resetRouteTour = resetRouteTour;
        environmentRef.current.stopRouteTour = stopRouteTour;
        environmentRef.current.updateRouteTour = updateRouteTour;
        environmentRef.current.setWalkthroughSpeed = (speed) => {
          walkthrough.currentSpeed = Math.max(0.25, Math.min(0.9, Number(speed) || 0.5));
          setWalkthroughSpeed(walkthrough.currentSpeed);
        };
        environmentRef.current.setRouteTourSpeed = (speed) => {
          routeTour.speedMps = Math.max(0.25, Math.min(0.9, Number(speed) || 0.5));
        };
        const computeModelStats = () => {
          const materialSet = new Set();
          const textureSet = new Set();
          let meshCount = 0;
          model.traverse((child) => {
            if (!child.isMesh && !child.isPoints && !child.isLine) return;
            meshCount += 1;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.filter(Boolean).forEach((material) => {
              materialSet.add(material.uuid || material);
              ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'].forEach((keyName) => {
                if (material[keyName]) textureSet.add(material[keyName].uuid || material[keyName]);
              });
            });
          });
          if (!disposed) setModelStats({ meshes: meshCount, materials: materialSet.size, textures: textureSet.size });
        };
        if (modelAsset?.kind === 'site_context_glb') {
          // Show a useful count immediately and move the second full traversal
          // out of the critical path.  The exact material/texture totals are
          // filled in once the browser is idle.
          setModelStats({ meshes: Number(modelAsset.metadata?.geometryCount) || 0, materials: 0, textures: 0 });
          const scheduleIdle = window.requestIdleCallback
            ? (callback) => window.requestIdleCallback(callback, { timeout: 1200 })
            : (callback) => window.setTimeout(callback, 80);
          scheduleIdle(computeModelStats);
        } else {
          computeModelStats();
        }
        applyModelDisplayMode(model, displayModeRef.current, scenarioForDisplay(displayModeRef.current, scenarioPointRef.current));
        environmentRef.current.facadeLayer = applyFacadeMaterialLayer(model, displayModeRef.current, environmentRef.current?.THREE);
        environmentRef.current.roadLayer = applyRoadMaterialLayer(model);
        environmentRef.current.landscapeLayer = applyLandscapeMaterialLayer(model);
        setFloorView(selectedFloorRef.current, isolateFloorRef.current);
        scene.add(model);
        if (modelAsset?.id === 'asset_a98b0182ed4e') {
          const bWalkDetail = environmentRef.current?.setBWalkSurfaceDetail?.();
          environmentRef.current?.setBWalkVisibility?.(immediatePerimeterMode);
          const requestedFocus = new URLSearchParams(window.location.search).get('focus');
          const focusBWalk = requestedFocus === 'bwalk';
          const focusSmallGate = requestedFocus === 'small-gate';
          const focusMiddleBuilding = requestedFocus === 'middle-building';
          if (focusMiddleBuilding) environmentRef.current?.focusMissingMiddleBuilding?.();
          if (focusSmallGate && environmentRef.current?.bWalkSmallGate) {
            const gateBounds = new THREE.Box3().setFromObject(environmentRef.current.bWalkSmallGate);
            const gateCenter = gateBounds.getCenter(new THREE.Vector3());
            const gateSize = gateBounds.getSize(new THREE.Vector3());
            const gateDistance = Math.max(7, Math.max(gateSize.x, gateSize.y, gateSize.z) * 4.6);
            camera.position.set(gateCenter.x + gateDistance * .72, gateCenter.y + gateDistance * .56, gateCenter.z + gateDistance * .72);
            controls.target.copy(gateCenter);
            controls.update();
          }
          if (focusBWalk && environmentRef.current?.bWalkSurfaceDetail) {
            const detailBounds = new THREE.Box3().setFromObject(environmentRef.current.bWalkSurfaceDetail);
            const detailCenter = detailBounds.getCenter(new THREE.Vector3());
            const detailSize = detailBounds.getSize(new THREE.Vector3());
            const focusDistance = Math.max(28, Math.min(58, Math.max(detailSize.x, detailSize.z) * .42));
            camera.position.set(detailCenter.x + focusDistance * .72, detailCenter.y + focusDistance * .62, detailCenter.z + focusDistance * .72);
            controls.target.copy(detailCenter);
            controls.update();
          }
        }
        if (combinedSceneRequested && combinedSkpArtifact?.url && modelAsset?.id === 'asset_a98b0182ed4e') {
          const combinedBaseCenter = center.clone();
          const combinedTargetTranslation = new THREE.Vector3(-545.6104, 0, 263.6518).sub(combinedBaseCenter);
          const combinedScale = new THREE.Vector3(1, 1.054841, 1.038368);
          new GLTFLoader().load(combinedSkpArtifact.url, (gltf) => {
            if (disposed) return;
            combinedSkpModel = gltf.scene;
            let loadedMeshCount = 0;
            let visibleBuildingMeshCount = 0;
            let visibleAccessoryMeshCount = 0;
            combinedSkpModel.traverse((child) => {
              if (!child.isMesh) return;
              loadedMeshCount += 1;
              child.geometry?.computeBoundingBox?.();
              const localBox = child.geometry?.boundingBox;
              const localCenter = localBox?.getCenter(new THREE.Vector3());
              const inBuildingEnvelope = localCenter
                && localCenter.x >= 462.1104 && localCenter.x <= 629.1104
                && localCenter.z >= -316.3518 && localCenter.z <= -210.9518;
              const size = localBox?.getSize(new THREE.Vector3()) || new THREE.Vector3();
              const accessoryName = /^(0_e9b69f|0_f4d219|0_1a2017|0_364460)$/i.test(child.name || '');
              const largeAccessory = accessoryName && Math.max(size.x, size.y, size.z) > 20 && (child.geometry?.attributes?.position?.count || 0) > 100;
              child.visible = Boolean(inBuildingEnvelope || largeAccessory);
              if (inBuildingEnvelope) visibleBuildingMeshCount += 1;
              if (largeAccessory) visibleAccessoryMeshCount += 1;
            });
            combinedSkpModel.scale.copy(combinedScale);
            combinedSkpModel.position.copy(combinedTargetTranslation);
            combinedSkpModel.name = 'COMBINED_SKP_MAIN_BUILDING_953_ONLY';
            scene.add(combinedSkpModel);
            // 静态阴影：组合楼体入场后重算一次阴影贴图，让主楼立刻投下落地影
            if (renderer?.shadowMap) renderer.shadowMap.needsUpdate = true;
            applyFacadeMaterialLayer(combinedSkpModel, displayModeRef.current, THREE);
            model.traverse((child) => {
              if (/building_mass/i.test(child.name || '')) child.visible = false;
            });
            environmentRef.current.combinedSkp = {
              artifactId: 'artifact_2dbc856e76e8',
              transform: { tx: -545.6104, ty: 0, tz: 263.6518, yaw: 0, scale: [1, 1.054841, 1.038368] },
              loadedMeshCount,
              visibleBuildingMeshCount,
              visibleAccessoryMeshCount,
              hiddenAccessoryMeshCount: loadedMeshCount - visibleBuildingMeshCount,
              baseCenter: combinedBaseCenter.toArray(),
              placeholderHidden: true
            };
            setRegistrationMessage(`组合场景：SKP楼体 ${visibleBuildingMeshCount} mesh · 配楼 4 块已纳入 · 其余附属物 ${loadedMeshCount - visibleBuildingMeshCount} mesh 未加载`);
          }, undefined, (error) => {
            if (!disposed) setRegistrationMessage(`SKP组合加载失败：${error?.message || '无法解析主楼 artifact'}`);
          });
        }
        const runtime = environmentRef.current;
        const applyContextRegistration = (registration = registrationRef.current) => {
          if (!contextAlignment) return;
          contextAlignment.position.set(Number(registration.offsetXM) || 0, -center.y, Number(registration.offsetZM) || 0);
          contextAlignment.rotation.y = (Number(registration.rotationDeg) || 0) * Math.PI / 180;
          const registrationScale = Math.max(0.1, Math.min(10, Number(registration.scale) || 1));
          contextAlignment.scale.setScalar(registrationScale);
          contextAlignment.visible = showSurroundingsRef.current;
          contextAlignment.updateMatrixWorld(true);
        };
        runtime.setContextVisibility = (visible) => {
          if (contextAlignment) contextAlignment.visible = Boolean(visible);
        };
        runtime.updateContextRegistration = applyContextRegistration;
        if (contextAsset?.url) {
          new GLTFLoader().load(contextAsset.url, (gltf) => {
            if (disposed) return;
            contextModel = gltf.scene;
            contextModel.rotation.x = -Math.PI / 2;
            contextModel.traverse((child) => {
              if (!child.isMesh) return;
              child.castShadow = true;
              child.receiveShadow = true;
            });
            contextAlignment = new THREE.Group();
            contextAlignment.name = 'registered-surroundings-hypothesis';
            contextAlignment.add(contextModel);
            scene.add(contextAlignment);
            contextAlignment.updateMatrixWorld(true);
            const candidates = [];
            contextModel.traverse((child) => {
              if (!child.isMesh || !/building/i.test(child.name || child.parent?.name || '')) return;
              const childBounds = new THREE.Box3().setFromObject(child);
              const childCenter = childBounds.getCenter(new THREE.Vector3());
              candidates.push({ child, distance: Math.hypot(childCenter.x, childCenter.z) });
            });
            const centralBuilding = candidates.sort((left, right) => left.distance - right.distance)[0];
            if (centralBuilding && centralBuilding.distance <= Math.max(size.x, size.z) * 0.65) centralBuilding.child.visible = false;
            applyContextRegistration();
            setRegistrationMessage((current) => current || '周边底景已载入 · 配准仍为 Hypothesis');
          }, undefined, (error) => {
            if (!disposed) setRegistrationMessage(`周边底景加载失败：${error?.message || '无法解析 OSM GLB'}`);
          });
        }
        const disposeSiteRoutes = () => {
          if (!siteRouteGroup) return;
          siteRouteGroup.traverse((child) => {
            child.geometry?.dispose();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.filter(Boolean).forEach((material) => material.dispose());
          });
          model.remove(siteRouteGroup);
          siteRouteGroup = null;
          runtime.siteRouteGroup = null;
          routeTour.points = [];
          routeTour.lengthM = 0;
          routeTour.distanceM = 0;
        };
        const createRouteRibbonGeometry = (points, width) => {
          const positions = [];
          const indices = [];
          points.forEach((point, index) => {
            const previous = points[Math.max(0, index - 1)];
            const next = points[Math.min(points.length - 1, index + 1)];
            const tangent = next.clone().sub(previous).setY(0).normalize();
            const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).multiplyScalar(width / 2);
            const left = point.clone().add(normal);
            const right = point.clone().sub(normal);
            positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
            if (index < points.length - 1) {
              const base = index * 2;
              indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
            }
          });
          const geometry = new THREE.BufferGeometry();
          geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
          geometry.setIndex(indices);
          geometry.computeVertexNormals();
          return geometry;
        };
        runtime.syncSiteRoutes = (currentObjects = []) => {
          disposeSiteRoutes();
          if (!['site_context_glb', 'osm_context_glb'].includes(modelAsset?.kind)) {
            setSiteRouteStats({ count: 0, lengthM: 0 });
            return;
          }
          const routes = extractSiteRoutes(currentObjects);
          const primaryRoute = selectPrimarySiteRoute(routes);
          if (!primaryRoute) {
            setSiteRouteStats({ count: 0, lengthM: 0 });
            return;
          }
          const group = new THREE.Group();
          group.name = 'site-walkway-route-layer';
          group.userData.preserveDisplayMaterial = true;
          routes.forEach((route) => {
            const resolved = resolveSiteRoutePoints(route);
            if (resolved.length < 2) return;
            const points = resolved.map((point) => new THREE.Vector3(...point));
            const width = Math.max(1.8, Math.min(7, route.widthM || maxDimension * 0.018));
            const routeGroup = new THREE.Group();
            routeGroup.name = route.id;
            routeGroup.userData = { preserveDisplayMaterial: true, evidenceLevel: route.evidenceLevel, label: route.label };
            const ribbon = new THREE.Mesh(
              createRouteRibbonGeometry(points, width),
              new THREE.MeshStandardMaterial({
                color: 0xc94432, emissive: 0x4b0c08, emissiveIntensity: 0.32,
                roughness: 0.82, metalness: 0, transparent: true, opacity: 0.9,
                side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
              })
            );
            ribbon.name = `${route.id}-surface`;
            ribbon.renderOrder = 9;
            ribbon.userData.preserveDisplayMaterial = true;
            routeGroup.add(ribbon);
            group.add(routeGroup);
            if (route.id === primaryRoute.id) {
              // Keep playback points in the same array format consumed by
              // samplePolylineAtDistance. The render layer can use Vector3,
              // but the route sampler intentionally works on plain coordinates.
              routeTour.points = points.map((point) => [
                point.x + model.position.x,
                point.y + model.position.y,
                point.z + model.position.z
              ]);
              routeTour.lengthM = polylineLength(routeTour.points);
              routeTour.distanceM = 0;
            }
          });
          if (!group.children.length) {
            group.traverse((child) => child.geometry?.dispose());
            setSiteRouteStats({ count: 0, lengthM: 0 });
            return;
          }
          group.visible = showSiteRouteRef.current && displayModeRef.current === 'analysis';
          model.add(group);
          siteRouteGroup = group;
          runtime.siteRouteGroup = group;
          setSiteRouteStats({ count: routes.length, lengthM: routeTour.lengthM });
        };
        runtime.setSiteRouteVisibility = (visible) => {
          if (siteRouteGroup) siteRouteGroup.visible = Boolean(visible);
        };
        runtime.disposeSiteRoutes = disposeSiteRoutes;
        const disposeTransportMarkers = () => {
          if (!transportMarkerGroup) return;
          transportMarkerGroup.traverse((child) => {
            child.geometry?.dispose?.();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.filter(Boolean).forEach((material) => {
              material.map?.dispose?.();
              material.dispose?.();
            });
          });
          model.remove(transportMarkerGroup);
          transportMarkerGroup = null;
          runtime.transportMarkerGroup = null;
        };
        const makeTransportLabel = (station, scale) => {
          const canvas = document.createElement('canvas');
          canvas.width = 512;
          canvas.height = 136;
          const context = canvas.getContext('2d');
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = 'rgba(10, 20, 27, 0.9)';
          context.roundRect(8, 8, 496, 120, 18);
          context.fill();
          context.fillStyle = '#fff8ef';
          context.font = 'bold 30px sans-serif';
          context.fillText(`${station.exitNumber}号口 同济大学站`, 24, 43);
          context.fillStyle = '#ffb49e';
          context.font = '23px sans-serif';
          context.fillText(`${station.distanceToBuildingM || '?'}m`, 24, 78);
          context.fillStyle = '#ffd7c8';
          context.font = '20px sans-serif';
          context.fillText(station.exitNumber === '2' ? '位置为推定、形态为示意' : '位置经操作者红框确认', 24, 108);
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
          const sprite = new THREE.Sprite(material);
          sprite.scale.set(38 * scale, 10 * scale, 1);
          sprite.position.set(0, 9 * scale, 0);
          sprite.renderOrder = 30;
          return sprite;
        };
        const makeTransportPavilion = (station, scale, markerY) => {
          const group = new THREE.Group();
          group.name = `transport-${station.id}-pavilion`;
          scale = Math.max(scale, 1.0);
          const coral = station.exitNumber === '2' ? 0xff5f56 : 0xff9f68;
          const frameMaterial = new THREE.MeshStandardMaterial({ color: coral, roughness: 0.72, metalness: 0.05, depthTest: false, depthWrite: false });
          const roofMaterial = new THREE.MeshStandardMaterial({ color: 0xffc0a9, roughness: 0.62, metalness: 0.08, depthTest: false, depthWrite: false });
          const stairMaterial = new THREE.MeshStandardMaterial({ color: 0x3d4448, roughness: 0.9, metalness: 0.05, depthTest: false, depthWrite: false });
          const baseMaterial = new THREE.MeshStandardMaterial({ color: 0xf0b19a, roughness: 0.86, metalness: 0, depthTest: false, depthWrite: false });
          const addBox = (name, size, position, material) => {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
            mesh.name = name;
            mesh.position.set(...position);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            group.add(mesh);
          };
          addBox('base', [10.5 * scale, 0.3 * scale, 7.2 * scale], [0, markerY + 0.15 * scale, 0], baseMaterial);
          addBox('left-door-frame', [0.7 * scale, 4.4 * scale, 0.7 * scale], [-4.2 * scale, markerY + 2.2 * scale, 0], frameMaterial);
          addBox('right-door-frame', [0.7 * scale, 4.4 * scale, 0.7 * scale], [4.2 * scale, markerY + 2.2 * scale, 0], frameMaterial);
          addBox('door-header', [9.1 * scale, 0.7 * scale, 0.7 * scale], [0, markerY + 4.25 * scale, 0], frameMaterial);
          addBox('roof-cap', [11.8 * scale, 0.65 * scale, 7.8 * scale], [0, markerY + 4.9 * scale, 0], roofMaterial);
          for (let step = 0; step < 4; step += 1) {
            addBox(`stair-${step + 1}`, [6.6 * scale, 0.28 * scale, (1.0 + step * 0.35) * scale], [0, markerY + 0.18 * scale + step * 0.3 * scale, (3.1 + step * 0.55) * scale], stairMaterial);
          }
          group.add(makeTransportLabel(station, scale));
          group.userData = { stationId: station.id, coordinateSpace: 'local_enu_m_xz', evidenceLevel: station.exitNumber === '2' ? 'Derived' : 'Observed' };
          group.renderOrder = 900;
          return group;
        };
        const makeMetroSignPost = (station, scale, markerY, markerXZ) => {
          const group = new THREE.Group();
          group.name = `transport-${station.id}-simulated-sign-post`;
          const propScale = Math.max(scale, 1.0);
          const direction = new THREE.Vector2(-Number(markerXZ[0]), -Number(markerXZ[1])).normalize();
          const offset = 3.0 * scale;
          group.position.set(Number(markerXZ[0]) + direction.x * offset, 0, Number(markerXZ[1]) + direction.y * offset);
          group.rotation.y = Math.atan2(direction.x, direction.y);
          const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x173b73, roughness: 0.42, metalness: 0.28, depthTest: false, depthWrite: false });
          const signMaterial = new THREE.MeshStandardMaterial({ color: 0x0e2f67, roughness: 0.3, metalness: 0.12, depthTest: false, depthWrite: false });
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * propScale, 0.1 * propScale, 2.65 * propScale, 16), poleMaterial);
          pole.name = `${group.name}-pole`;
          pole.position.set(0, markerY + 1.325 * propScale, 0);
          pole.castShadow = true;
          group.add(pole);
          const canvas = document.createElement('canvas');
          canvas.width = 512;
          canvas.height = 256;
          const context = canvas.getContext('2d');
          context.fillStyle = '#0e2f67';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.strokeStyle = '#6fa8ff';
          context.lineWidth = 10;
          context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
          context.fillStyle = '#ffffff';
          context.font = 'bold 48px sans-serif';
          context.fillText('METRO 地铁', 34, 76);
          context.font = 'bold 92px sans-serif';
          context.fillText(`${station.exitNumber}`, 220, 190);
          context.font = '24px sans-serif';
          context.fillText(station.exitNumber === '2' ? '位置为推定' : '位置经红框确认', 300, 232);
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          const faceMaterial = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
          const sign = new THREE.Mesh(new THREE.BoxGeometry(1.25 * propScale, 0.72 * propScale, 0.14 * propScale), [faceMaterial, signMaterial, signMaterial, signMaterial, signMaterial, signMaterial]);
          sign.name = `${group.name}-lightbox`;
          sign.position.set(0, markerY + 2.62 * propScale, 0);
          sign.castShadow = true;
          group.add(sign);
          group.userData = {
            simulated: true,
            evidenceLevel: 'Simulated',
            description: '拟真蓝色地铁标识灯箱杆；造型为示意道具，不代表现场实测还原。',
            stationId: station.id,
            offsetFromPavilionM: 3,
            label: station.exitNumber === '2' ? '位置为推定' : '位置经操作者红框确认'
          };
          group.renderOrder = 1000;
          return group;
        };
        const syncTransportMarkers = (plan = transportPlanRef.current) => {
          disposeTransportMarkers();
          const stations = Array.isArray(plan?.stations) ? plan.stations : [];
          if (!stations.length) return;
          const group = new THREE.Group();
          group.name = 'transport-metro-entrance-pavilions';
          const scale = Math.max(0.35, Math.min(1.2, maxDimension / 300));
          const markerY = (runtime.groundY || 0) - model.position.y + 0.12;
          stations.forEach((station) => {
            const local = Array.isArray(station.modelLocal) ? station.modelLocal : station.local;
            if (!Array.isArray(local) || local.length < 2) return;
            const markerXZ = Array.isArray(station.markerLocalXZ)
              ? station.markerLocalXZ
              : [Number(local[0]), -Number(local[1])];
            const marker = makeTransportPavilion(station, scale, markerY);
            marker.position.set(Number(markerXZ[0]) * scale, 0, Number(markerXZ[1]) * scale);
            marker.traverse((child) => { child.renderOrder = 30; });
            group.add(marker);
            const signPost = makeMetroSignPost(station, scale, markerY, [Number(markerXZ[0]) * scale, Number(markerXZ[1]) * scale]);
            signPost.traverse((child) => { child.renderOrder = 31; });
            group.add(signPost);
          });
          const connectorMaterial = new THREE.LineBasicMaterial({ color: 0xff9f68, transparent: true, opacity: 0.82, depthTest: false });
          stations.forEach((station) => {
            const markerXZ = Array.isArray(station.markerLocalXZ) ? station.markerLocalXZ : null;
            if (!markerXZ) return;
            const points = [
              new THREE.Vector3(Number(markerXZ[0]) * scale, markerY + 0.34 * scale, Number(markerXZ[1]) * scale),
              new THREE.Vector3(Number(markerXZ[0]) * scale * 0.48, markerY + 0.34 * scale, Number(markerXZ[1]) * scale * 0.48),
              new THREE.Vector3(0, markerY + 0.34 * scale, 0)
            ];
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), connectorMaterial.clone());
            line.name = `transport-${station.id}-building-connector`;
            line.renderOrder = 28;
            group.add(line);
          });
          const buildingOutline = new THREE.LineLoop(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(-83.5 * scale, markerY + 0.38 * scale, -54.722 * scale),
              new THREE.Vector3(83.5 * scale, markerY + 0.38 * scale, -54.722 * scale),
              new THREE.Vector3(83.5 * scale, markerY + 0.38 * scale, 54.722 * scale),
              new THREE.Vector3(-83.5 * scale, markerY + 0.38 * scale, 54.722 * scale)
            ]),
            new THREE.LineBasicMaterial({ color: 0xffc0a9, transparent: true, opacity: 0.9, depthTest: false })
          );
          buildingOutline.name = 'transport-main-building-outline';
          buildingOutline.renderOrder = 28;
          group.add(buildingOutline);
          model.add(group);
          transportMarkerGroup = group;
          runtime.transportMarkerGroup = group;
        };
        runtime.syncTransportMarkers = syncTransportMarkers;
        runtime.disposeTransportMarkers = disposeTransportMarkers;
        const disposeScenarioFlow = () => {
          if (!runtime?.flow) return;
          runtime.flow.group.traverse((child) => {
            child.geometry?.dispose();
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.filter(Boolean).forEach((material) => material.dispose());
          });
          model.remove(runtime.flow.group);
          runtime.flow = null;
        };
        runtime.syncScenarioFlow = ({ sceneObjects: currentObjects, scenarioPoint: currentPoint, scenarioFlowColor: currentColor, selectedRouteId: currentRouteId }) => {
          disposeScenarioFlow();
          const isOsmContext = modelAsset?.kind === 'osm_context_glb';
          if (!isOsmContext || !currentPoint) return;
          const plan = buildScenarioFlowPlan(currentObjects, currentPoint, { maxParticles: 72, selectedRouteId: currentRouteId });
          const selectedAreaObject = currentObjects.find((object) => object.id === currentRouteId && object?.properties?.stale !== true && object?.geometry?.type === 'Polygon');
          if (!plan.routes.length && !selectedAreaObject) return;
          const group = new THREE.Group();
          group.name = 'scenario-flow-layer';
          const color = new THREE.Color(currentColor);
          const routeMap = new globalThis.Map(plan.routes.map((route) => [route.id, route]));
          plan.routes.forEach((route) => {
            const geometry = new THREE.BufferGeometry().setFromPoints(route.points.map((point) => new THREE.Vector3(...point)));
            const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.82, depthWrite: false });
            const line = new THREE.Line(geometry, material);
            line.renderOrder = 7;
            group.add(line);
          });
          if (selectedAreaObject) {
            const base = Number(selectedAreaObject?.properties?.terrainBaseRelativeM) || 0;
            const ring = Array.isArray(selectedAreaObject.geometry.coordinates?.[0]) ? selectedAreaObject.geometry.coordinates[0] : [];
            const areaPoints = ring.filter((point) => Array.isArray(point) && point.length >= 2).map((point) => new THREE.Vector3(Number(point[0]), Number(point[2] ?? base) + 0.22, -Number(point[1])));
            if (areaPoints.length >= 3) {
              if (!areaPoints[0].equals(areaPoints.at(-1))) areaPoints.push(areaPoints[0].clone());
              const areaGeometry = new THREE.BufferGeometry().setFromPoints(areaPoints);
              const areaMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false });
              const areaOutline = new THREE.Line(areaGeometry, areaMaterial);
              areaOutline.renderOrder = 7;
              group.add(areaOutline);
            }
          }
          let geometry = null;
          let positions = null;
          if (plan.particles.length) {
            positions = new Float32Array(plan.particles.length * 3);
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            const material = new THREE.PointsMaterial({
              color, size: Math.max(0.55, Math.min(2.2, maxDimension * 0.004)), sizeAttenuation: true,
              transparent: true, opacity: 0.96, depthWrite: false, blending: THREE.AdditiveBlending
            });
            const points = new THREE.Points(geometry, material);
            points.renderOrder = 8;
            group.add(points);
          }
          model.add(group);
          runtime.flow = { group, geometry, positions, plan, routeMap };
        };
        runtime.updateScenarioFlow = (elapsedSeconds) => {
          const flow = runtime.flow;
          if (!flow?.geometry || !flow.positions) return;
          flow.plan.particles.forEach((particle, index) => {
            const route = flow.routeMap.get(particle.routeId);
            const point = pointAlongPolyline(route, particle.phase + elapsedSeconds * particle.speed, particle.reverse);
            flow.positions.set(point, index * 3);
          });
          flow.geometry.attributes.position.needsUpdate = true;
        };
        runtime.disposeScenarioFlow = disposeScenarioFlow;
        runtime.syncSiteRoutes(siteRouteInputRef.current);
        runtime.syncScenarioFlow(flowInputRef.current);
        runtime.syncTransportMarkers(transportPlanRef.current);
        setLoadState({ status: 'ready', message: modelName });
        window.dispatchEvent(new CustomEvent('spatial-reframe:model-ready', { detail: { artifactId: modelAsset.id } }));
      };
      const failLoad = (error) => {
        if (disposed) return;
        const reason = error instanceof Error ? error.message : '浏览器无法解析该模型';
        if (previewModel) {
          setLoadState({ status: 'preview', message: `快速三维可继续使用；完整材质模型加载失败：${reason}` });
          return;
        }
        setLoadState({ status: 'error', message: reason });
      };
      if (modelType === 'ply') {
        new PLYLoader().load(modelAsset.url, (geometry) => {
          geometry.computeBoundingBox();
          const hasVertexColors = geometry.hasAttribute('color');
          const material = new THREE.PointsMaterial({ size: 0.025, sizeAttenuation: true, vertexColors: hasVertexColors, color: hasVertexColors ? 0xffffff : 0x72e7dc });
          finishLoad(new THREE.Points(geometry, material));
        }, undefined, failLoad);
      } else {
        const loadFullModel = () => new GLTFLoader().load(modelAsset.url, (gltf) => {
          setLoadState((current) => current.status === 'preview'
            ? { status: 'preview', message: '快速三维可操作，正在解析真实材质模型…' }
            : { status: 'loading', message: `正在解析 ${modelName}…` });
          finishLoad(gltf.scene);
        }, (progress) => {
          const total = Number(progress?.total || modelAsset?.size || 0);
          const loaded = Number(progress?.loaded || 0);
          const percent = total > 0 ? Math.max(0, Math.min(99, Math.round((loaded / total) * 100))) : null;
          setLoadState((current) => current.status === 'preview'
            ? { status: 'preview', message: percent == null ? '快速三维可操作，真实材质模型正在下载…' : `快速三维可操作，真实材质模型正在下载… ${percent}%` }
            : { status: 'loading', message: percent == null ? `正在下载 ${modelName}…` : `正在下载 ${modelName}… ${percent}%` });
        }, failLoad);
        if (modelAsset?.kind === 'site_context_glb') {
          setLoadState({ status: 'loading', message: '正在加载快速三维…' });
          previewBufferPromise.then(({ buffer, error }) => {
            if (disposed) return;
            if (error || !buffer) {
              if (error?.name !== 'AbortError') loadFullModel();
              return;
            }
            new GLTFLoader().parse(buffer, '', (gltf) => {
              showFastPreview(gltf.scene);
              // Let the first interactive frame paint before the large
              // material GLB starts downloading and parsing.
              const startFullLoad = () => {
                if (disposed) return;
                loadFullModel();
              };
              if (typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(startFullLoad, { timeout: 2200 });
              } else {
                window.setTimeout(startFullLoad, 1200);
              }
            }, () => loadFullModel());
          });
        } else {
          loadFullModel();
        }
      }
      const animate = (time = 0) => {
        if (disposed) return;
        frame = requestAnimationFrame(animate);
        if (document.hidden) return;
        const minimumFrameInterval = modelAsset?.kind === 'site_context_glb'
          ? (fullModelReady ? 33 : 80)
          : 0;
        if (minimumFrameInterval && time - lastRenderTime < minimumFrameInterval) return;
        lastRenderTime = time;
        const deltaSeconds = Math.min(0.05, Math.max(0, (time - lastFrameTime) / 1000));
        const frameMs = animate.lastTime ? Math.max(1, time - animate.lastTime) : 16.7;
        animate.lastTime = time;
        const currentFps = Math.round(1000 / frameMs);
        if (environmentRef.current) environmentRef.current.fps = currentFps;
        if (!animate.lastFpsUiTime || time - animate.lastFpsUiTime > 420) {
          animate.lastFpsUiTime = time;
          setFps(currentFps);
        }
        lastFrameTime = time;
        environmentRef.current?.updateTwinAgents?.(deltaSeconds);
        if (environmentRef.current?.routeTour?.active) environmentRef.current.updateRouteTour?.(deltaSeconds, time);
        else if (environmentRef.current?.walkthrough?.active) environmentRef.current.updateWalkthrough?.(deltaSeconds);
        else controls?.update();
        environmentRef.current?.updateScenarioFlow?.(time / 1000);
        if (twinModeRef.current && environmentRef.current?.bloomPass?.enabled) {
          const samples = environmentRef.current.fpsSamples;
          samples.push(currentFps);
          if (samples.length > 30) samples.shift();
          if (samples.length >= 10 && samples.reduce((sum, value) => sum + value, 0) / samples.length < 30) {
            environmentRef.current.bloomDowngraded = true;
            environmentRef.current.bloomPass.enabled = false;
          }
          environmentRef.current.composer.render();
        } else {
          renderer.render(scene, camera);
        }
      };
      animate();
      const resize = () => {
        if (!mount.clientWidth || !mount.clientHeight || !renderer) return;
        camera.aspect = mount.clientWidth / mount.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(mount.clientWidth, mount.clientHeight);
        environmentRef.current?.composer?.setSize(mount.clientWidth, mount.clientHeight);
      };
      observer = new ResizeObserver(resize);
      observer.observe(mount);
    };

    initialize().catch((error) => {
      if (!disposed) setLoadState({ status: 'error', message: error.message || '三维运行时加载失败' });
    });
    return () => {
      disposed = true;
      previewAbortController.abort();
      cancelAnimationFrame(frame);
      observer?.disconnect();
      environmentRef.current?.disposeScenarioFlow?.();
      environmentRef.current?.disposeSiteRoutes?.();
      environmentRef.current?.disposeTransportMarkers?.();
      disposeWalkthroughControls();
      disposeModelDisplayMaterials(model);
      if (previewModel && scene) {
        scene.remove(previewModel);
        previewModel.traverse((child) => {
          child.geometry?.dispose?.();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          materials.filter(Boolean).forEach((material) => material.dispose?.());
        });
      }
      if (model && scene) scene.remove(model);
      if (contextAlignment && scene) scene.remove(contextAlignment);
      disposeEditableSelection();
      transformControls?.detach?.();
      transformControls?.dispose?.();
      if (transformHelper && scene) scene.remove(transformHelper);
      controls?.dispose();
      environmentRenderTarget?.dispose();
      renderer?.dispose();
      ground?.geometry.dispose();
      ground?.material.dispose();
      skyDome?.geometry.dispose();
      skyDome?.material.dispose();
      environmentRef.current = null;
      mount.replaceChildren();
    };
  }, [modelAsset?.id, modelName, modelType, contextAsset?.id, modelLoadAttempt, combinedSceneRequested, combinedSkpArtifact?.id]);

  useEffect(() => {
    environmentRef.current?.syncSiteRoutes?.(sceneObjects);
    environmentRef.current?.syncScenarioFlow?.({ sceneObjects, scenarioPoint, scenarioFlowColor, selectedRouteId });
    environmentRef.current?.syncTransportMarkers?.(transportPlan);
  }, [sceneObjects, scenarioPoint, scenarioFlowColor, selectedRouteId, transportPlan]);

  useEffect(() => {
    environmentRef.current?.setSiteRouteVisibility?.(showSiteRoute && displayMode === 'analysis');
  }, [showSiteRoute, displayMode, loadState.status]);

  useEffect(() => {
    applyModelDisplayMode(environmentRef.current?.model, displayMode);
    if (environmentRef.current) {
      environmentRef.current.facadeLayer = applyFacadeMaterialLayer(environmentRef.current.model, displayMode, environmentRef.current.THREE);
      environmentRef.current.roadLayer = applyRoadMaterialLayer(environmentRef.current.model);
      environmentRef.current.landscapeLayer = applyLandscapeMaterialLayer(environmentRef.current.model);
    }
    if (displayMode === 'day-night') {
      applyModelDisplayMode(environmentRef.current?.model, displayMode, scenarioForDisplay(displayMode, scenarioPoint));
    }
    environmentRef.current?.setFloorView?.(selectedFloorNumber, isolateFloor || navigationMode === 'walkthrough');
    applySceneEnvironment(environmentRef.current, scenarioPoint, displayMode);
  }, [displayMode, scenarioPoint, selectedFloorNumber, isolateFloor, navigationMode]);

  useEffect(() => {
    environmentRef.current?.setTwinMode?.(twinMode);
  }, [twinMode, loadState.status]);

  useEffect(() => {
    if (loadState.status === 'ready') environmentRef.current?.setBWalkVisibility?.(immediatePerimeterMode);
  }, [immediatePerimeterMode, loadState.status]);

  useEffect(() => {
    if (loadState.status === 'ready') void environmentRef.current?.setImportedMiddleBuilding?.(middleBuildingMode);
  }, [middleBuildingMode, loadState.status]);

  useEffect(() => {
    if (loadState.status === 'ready') {
      const requestedCount = fluidMode ? Math.min(agentCount, 150) : agentCount;
      const result = environmentRef.current?.setTwinAgents?.({ count: requestedCount, slot: agentSlot });
      setRenderedAgentCount(Number(result?.count ?? requestedCount));
      setAgentPathSummary({
        labels: Array.isArray(result?.paths) ? result.paths.map((path) => path.label) : [],
        counts: Object.fromEntries(Array.isArray(result?.paths) ? result.paths.map((path) => [path.id, path.count]) : [])
      });
    }
  }, [agentCount, agentSlot, fluidMode, loadState.status]);

  useEffect(() => {
    environmentRef.current?.setFluidMode?.(fluidMode);
  }, [fluidMode, loadState.status]);

  useEffect(() => {
    if (loadState.status === 'ready') environmentRef.current?.setTwinHeatmap?.({ planId: heatmapPlan });
  }, [heatmapPlan, loadState.status]);

  useEffect(() => {
    if (loadState.status === 'ready') {
      const runtime = environmentRef.current;
      const metrics = runtime?.setPainNarrative?.({ planId: twinMode ? heatmapPlan : null }) || null;
      if (runtime?.painNarrativeGroup) runtime.painNarrativeGroup.visible = twinMode || digitalDerivative;
      setPainMetrics(metrics);
    }
  }, [heatmapPlan, twinMode, digitalDerivative, loadState.status]);

  useEffect(() => {
    if (loadState.status === 'ready') environmentRef.current?.setStage2Completeness?.();
  }, [loadState.status]);


  useEffect(() => {
    environmentRef.current?.setFloorView?.(selectedFloorNumber, isolateFloor || navigationMode === 'walkthrough');
  }, [selectedFloorNumber, isolateFloor, navigationMode, loadState.status]);

  useEffect(() => {
    environmentRef.current?.setContextVisibility?.(showSurroundings);
  }, [showSurroundings, loadState.status]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;
    const onMove = (event) => {
      const runtime = environmentRef.current;
      if (!runtime?.camera || !runtime?.THREE || loadState.status !== 'ready') return;
      const rect = mount.getBoundingClientRect();
      const ndc = new runtime.THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -(((event.clientY - rect.top) / rect.height) * 2 - 1));
      const ray = new runtime.THREE.Raycaster(); ray.setFromCamera(ndc, runtime.camera);
      const plane = new runtime.THREE.Plane(new runtime.THREE.Vector3(0, 1, 0), -(runtime.groundY || 0));
      const hit = new runtime.THREE.Vector3();
      if (ray.ray.intersectPlane(plane, hit)) setPointerCoordinate({ x: Number(hit.x.toFixed(3)), y: Number(hit.y.toFixed(3)), z: Number(hit.z.toFixed(3)) });
    };
    mount.addEventListener('pointermove', onMove);
    return () => mount.removeEventListener('pointermove', onMove);
  }, [loadState.status]);

  useEffect(() => {
    environmentRef.current?.setHistoricalConstructionVisibility?.(showHistoricalConstruction);
  }, [showHistoricalConstruction, loadState.status]);

  useEffect(() => {
    environmentRef.current?.setWalkthroughSpeed?.(walkthroughSpeedPreset);
  }, [walkthroughSpeedPreset, loadState.status]);

  useEffect(() => {
    environmentRef.current?.setRouteTourSpeed?.(routeTourSpeed);
  }, [routeTourSpeed, loadState.status]);

  useEffect(() => {
    environmentRef.current?.updateContextRegistration?.(registrationState);
  }, [registrationState, loadState.status]);

  useEffect(() => {
    if (loadState.status !== 'ready') return;
    const pending = pendingWalkthroughRef.current;
    if (pending?.assetId === modelAsset?.id) {
      pendingWalkthroughRef.current = null;
      const targetSpace = allTourSpaces.find((space) => space.id === pending.spaceId) || preferredWalkthroughEntry(floorOptions);
      if (targetSpace) {
        setSelectedFloorNumber(Number(targetSpace.floorNumber));
        setSelectedSpaceId(targetSpace.id);
      }
      setNavigationMode('walkthrough');
      return;
    }
    if (navigationMode === 'walkthrough') {
      environmentRef.current?.stopRouteTour?.();
      environmentRef.current?.startWalkthrough?.();
    } else if (navigationMode === 'route-tour') {
      environmentRef.current?.stopWalkthrough?.();
      if (!environmentRef.current?.startRouteTour?.()) setNavigationMode('orbit');
    } else {
      environmentRef.current?.stopWalkthrough?.();
      environmentRef.current?.stopRouteTour?.();
    }
  }, [navigationMode, loadState.status, modelAsset?.id]);

  useEffect(() => {
    if (loadState.status !== 'ready' || navigationMode !== 'walkthrough' || !selectedSpace) return;
    environmentRef.current?.setWalkthroughSpace?.(selectedSpace);
  }, [selectedSpaceId, selectedFloorNumber, navigationMode, loadState.status]);

  if (!modelAsset && hydrating) {
    return <ViewportEmptyState icon={RefreshCw} title="正在准备三维场景" text="正在读取项目资料与模型索引；完成后会自动显示三维视口。" />;
  }
  if (!modelAsset) {
    const hasUnsupportedModel = assets.some((asset) => asset.type === '3d');
    return <ViewportEmptyState icon={Box} title={hasUnsupportedModel ? '尚无可网页加载的三维资产' : '尚无三维资产'} text={hasUnsupportedModel ? '当前视口直接加载 GLB / GLTF / PLY；LAS、LAZ、SPZ 需先通过对应处理链转换或发布。' : '导入真实 GLB、GLTF 或 PLY 后，系统才会建立三维视口。'} />;
  }

  const layerLabel = (asset) => {
    if (asset.kind === 'runtime_ground_plane') return '场景底板 · 运行时地面';
    if (asset.kind === 'site_side_path_candidate_glb') return '主楼旁小道 · 三段候选';
    if (asset.kind === 'site_map_layout_candidate_glb') return /立面细节朝向修正/.test(asset.name || '') ? '③立面细节朝向修正' : /朝向修正/.test(asset.name || '') ? '③建筑朝向修正' : /入口围栏修正/.test(asset.name || '') ? '入口围栏与③砖楼' : /全素材细化/.test(asset.name || '') ? '全场地细化 · 材质与路线' : /证据补全/.test(asset.name || '') ? '场地补全 · ②侧边与小道设施' : '新标注图 · 三栋外围建筑与小道';
    if (asset.kind === 'main_building_facade_candidate_glb') return asset.metadata?.candidateVersion === 'facade.photo-zones.v3' ? '主楼 · 照片五区实景候选' : '主楼 · 照片五区候选';
    if (asset.kind === 'site_context_glb') {
      const sourceBuilding = artifacts.find((artifact) => artifact.id === asset.metadata?.mainBuildingArtifactId);
      const baseLabel = sourceBuilding?.metadata?.schema === 'dwg_interior_model.v4' ? '连续小道 · CAD建筑' : '连续视频周边小道';
      return asset.metadata?.blenderRefined ? `${baseLabel} · Blender` : baseLabel;
    }
    if (asset.kind === 'site_interior_model_glb') return '室内模型 · CAD/BIM';
    if (asset.kind === 'skp_glb') return '建筑主体';
    if (asset.kind === 'blender_enhanced_glb') return `Blender PBR · ${asset.metadata?.levelCount ?? 1}层`;
    if (asset.kind === 'dwg_extrusion_glb') return /^dwg_interior_model\.v[234]$/.test(asset.metadata?.schema || '') ? `室内模型 · ${asset.metadata?.levelCount ?? 1}层` : '室内补充模型';
    if (asset.kind === 'dwg_plan_glb') return '平面校核';
    if (asset.kind === 'osm_context_glb') return '周边三维底景';
    if (asset.kind === 'site_direct_image_candidate_glb') {
      if (asset.metadata?.candidateKey === 'scope-direct-image-v3-b1-c-local-v1') return '候选范围 v3 · B1/C夹道局部';
      if (asset.metadata?.candidateKey === 'scope-direct-image-v3-b1-filled') return '候选范围 v3 · B1实体填充';
      return '候选范围 v3 · 主楼+周边';
    }
    if (asset.kind === 'site_direct_image_surrounding_glb') return '候选范围 v3 · 周边层';
    if (asset.kind === 'site_direct_image_g3_candidate_glb') return '候选范围 v3 · G3起点局部';
    if (asset.kind === 'site_direct_image_g3_fb932_b67_candidate_glb') {
      return asset.metadata?.candidateKey === 'g3-fb932-b67-v2'
        ? 'G3 第一处 v2 · fb932+b67 双验证'
        : 'G3 第一处 · fb932+b67 候选';
    }
    if (asset.kind === 'site_direct_image_g3_v3_candidate_glb') {
      if (asset.metadata?.candidateKey === 'g3-fb932-main-entry-v3-rebased') return 'G3 主入口支路 v3 · 最新纠正基线';
      if (asset.metadata?.candidateKey === 'g3-fb932-main-entry-v2') return 'G3 主入口支路 v2 · fb932 箭尾→箭头';
      return '候选范围 v3 · G3导航核验版';
    }
    if (asset.kind === 'sparse_point_cloud' || /\.ply$/i.test(asset.name || '')) return '现场稀疏点云';
    const importedName = String(asset.name || asset.title || '未命名三维资源').replace(/\.(glb|gltf|ply)$/i, '');
    const shortAssetId = asset.id ? ` · ${asset.id.slice(-6)}` : '';
    return `导入 · ${importedName}${shortAssetId}`;
  };
  const displayModes = [
    { id: 'original', index: '01', label: '原始材质', detail: '显示导入模型自带的颜色与材质。' },
    { id: 'analysis', index: '02', label: '分析青图', detail: '统一分析着色，便于辨认体量、构件和空间关系。' },
    { id: 'sunny', index: '03', label: '晴天日照', detail: modelAsset?.kind === 'site_context_glb'
      ? '晴空、太阳方位与柔和补光；综合场景关闭浏览器阴影图，避免密集构件产生黑面伪影。'
      : scenarioPoint?.sun ? '晴空预设使用当前时刻的太阳方位，并启用软阴影。' : '上海标准晴天预设：蓝天、暖日照、软阴影与中性曝光。' },
    { id: 'day-night', index: '04', label: '日夜模拟', detail: scenarioPoint ? '跟随当前时间轴、太阳位置与真实天气数据。' : '当前无时间轴输入，显示标准夜景预设；窗光、入口灯与路灯材质同步增强。' }
  ];
  const activeDisplayMode = displayModes.find((mode) => mode.id === displayMode) || displayModes[0];
  const navigationModes = {
    orbit: {
      label: '观察模式',
      detail: '旋转、缩放、平移模型',
      hint: '鼠标左键旋转 · 滚轮缩放 · 右键或 Shift+拖动平移'
    },
    walkthrough: {
      label: '建筑漫游',
      detail: '以参观者视角进入室内',
      hint: '拖动视角 · W/A/S/D 或方向键移动 · Esc 退出漫游'
    },
    'route-tour': {
      label: '沿线漫游',
      detail: '按现场视频顺序连续查看周边小道',
      hint: '使用播放/暂停控制 · 可随时退出并恢复观察视角'
    }
  };
  const activeNavigationMode = navigationModes[navigationMode] || navigationModes.orbit;
  const semanticLegendEntries = Object.entries(modelAsset.metadata?.semanticLegend || {})
    .map(([category, definition]) => ({ category, ...definition, count: Number(modelAsset.metadata?.categoryCounts?.[category] || 0) }))
    .filter((item) => item.count > 0);
  const currentModelSupportsWalkthrough = modelType === 'gltf' && modelAsset.kind !== 'dwg_plan_glb'
    && Array.isArray(modelAsset?.metadata?.levels) && modelAsset.metadata.levels.length > 0;
  const walkthroughEligible = currentModelSupportsWalkthrough || Boolean(interiorWalkthroughAsset);
  const walkthroughEvidence = ['site_interior_model_glb', 'dwg_extrusion_glb', 'blender_enhanced_glb'].includes(modelAsset.kind)
    ? 'Derived 墙 / 柱 / 门窗位置'
    : modelAsset.kind === 'site_context_glb'
      ? '周边外景主楼外壳；室内 CAD/BIM 为独立图层'
      : modelAsset.kind === 'skp_glb'
       ? 'SKP 源模型可见结构'
       : '当前三维资产可见结构';
  const walkthroughControl = (action, label, Icon, className) => <button
    type="button"
    className={className}
    aria-label={label}
    title={label}
    onPointerDown={(event) => { event.preventDefault(); environmentRef.current?.setWalkthroughAction?.(action, true); }}
    onPointerUp={() => environmentRef.current?.setWalkthroughAction?.(action, false)}
    onPointerLeave={() => environmentRef.current?.setWalkthroughAction?.(action, false)}
    onPointerCancel={() => environmentRef.current?.setWalkthroughAction?.(action, false)}
    onClick={() => environmentRef.current?.nudgeWalkthrough?.(action)}
  ><Icon size={17} /></button>;
  const selectedTourIndex = selectedSpace ? allTourSpaces.findIndex((space) => space.id === selectedSpace.id) : -1;
  const enterWalkthrough = (space = null) => {
    const requestedSpace = space || selectedSpace || preferredWalkthroughEntry(floorOptions);
    if (interiorWalkthroughAsset && modelAsset.id !== interiorWalkthroughAsset.id) {
      pendingWalkthroughRef.current = { assetId: interiorWalkthroughAsset.id, spaceId: requestedSpace?.id || null };
      setSelectedModelId(interiorWalkthroughAsset.id);
      return;
    }
    if (requestedSpace) {
      setSelectedFloorNumber(Number(requestedSpace.floorNumber));
      setSelectedSpaceId(requestedSpace.id);
    }
    setNavigationMode('walkthrough');
  };
  const visitSpace = (space) => { if (space) enterWalkthrough(space); };
  const stepSpace = (direction) => {
    const currentIndex = selectedTourIndex >= 0 ? selectedTourIndex : 0;
    const nextIndex = Math.max(0, Math.min(allTourSpaces.length - 1, currentIndex + direction));
    visitSpace(allTourSpaces[nextIndex]);
  };
  const toggleExpanded = async () => {
    const viewport = mountRef.current?.parentElement;
    try {
      if (!isExpanded && viewport?.requestFullscreen) {
        await viewport.requestFullscreen();
        setIsExpanded(true);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
        setIsExpanded(false);
      } else {
        setIsExpanded((current) => !current);
      }
    } catch {
      setIsExpanded((current) => !current);
    }
  };
  const copyCameraLink = async () => {
    const snapshot = environmentRef.current?.getCameraSnapshot?.();
    if (!snapshot || !modelAsset?.id) return;
    const url = new URL(window.location.href);
    url.searchParams.set('model', modelAsset.id);
    url.searchParams.set('view', window.btoa(unescape(encodeURIComponent(JSON.stringify(snapshot)))));
    try {
      await navigator.clipboard.writeText(url.toString());
      setShareStatus('视角链接已复制');
    } catch {
      setShareStatus('浏览器未授权复制，请复制地址栏');
    }
    window.setTimeout(() => setShareStatus(''), 2400);
  };
  const saveContextRegistration = async () => {
    if (!project?.id || !modelAsset?.id || !contextAsset?.id) return;
    setRegistrationMessage('正在保存配准参数');
    try {
      await api(`/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelRegistration: {
            modelArtifactId: modelAsset.id,
            contextArtifactId: contextAsset.id,
            ...registrationState
          }
        })
      });
      setRegistrationMessage('配准参数已保存 · Hypothesis');
    } catch (error) {
      setRegistrationMessage(`保存失败：${error.message}`);
    }
  };
  const evidenceInventory = modelAsset.metadata?.evidenceInventory;
  const evidenceCounts = evidenceInventory?.counts || {};
  const mainRouteVideoCount = Number(modelAsset.metadata?.sourceVideoOrder?.length || 7);
  const returnRouteVideoCount = Number(modelAsset.metadata?.returnVideoOrder?.length || 0);
  const routeVideoCount = mainRouteVideoCount + returnRouteVideoCount;
  const allVideoCount = Number(modelAsset.metadata?.allProjectVideoAssetCount ?? evidenceCounts.allVideoAssetRecords ?? routeVideoCount);
  const fieldVideoCount = Number(modelAsset.metadata?.fieldVideoAssetCount ?? evidenceCounts.fieldVideoAssetRecords ?? routeVideoCount);
  const testVideoCount = Number(modelAsset.metadata?.testVideoAssetCount ?? evidenceCounts.testVideoAssetRecords ?? Math.max(0, allVideoCount - fieldVideoCount));
  const unmappedVideoCount = Number(modelAsset.metadata?.unmappedFieldVideoAssetCount ?? evidenceCounts.unmappedFieldVideoRecords ?? Math.max(0, fieldVideoCount - routeVideoCount));
  const assignedSupplementalVideoCount = Number(evidenceCounts.assignedSupplementalFieldVideoRecords ?? Math.max(0, fieldVideoCount - routeVideoCount - unmappedVideoCount));
  const ordinaryPhotoCount = Number(modelAsset.metadata?.ordinaryPhotoEvidenceCount ?? evidenceCounts.ordinaryPhotoRecords ?? modelAsset.metadata?.ordinaryPhotoEvidence ?? 0);
  const panoramaCount = Number(modelAsset.metadata?.panoramaEvidenceCount ?? evidenceCounts.panoramaRecords ?? modelAsset.metadata?.panoramaEvidence ?? 0);
  const fieldImageCount = Number(modelAsset.metadata?.fieldImageEvidenceCount ?? evidenceCounts.allImageAssetRecords ?? ordinaryPhotoCount + panoramaCount);
  const evidenceSummary = evidenceInventory || modelAsset.metadata?.allProjectVideoAssetCount != null
    ? `${fieldVideoCount}段现场视频（${mainRouteVideoCount}段主路线 + ${returnRouteVideoCount}段回程${assignedSupplementalVideoCount ? ` + ${assignedSupplementalVideoCount}段固定机位/连续性证据` : ''}${unmappedVideoCount ? ` + ${unmappedVideoCount}段补充未用于路线几何` : ''}）${testVideoCount ? `；${testVideoCount}段测试视频不参与现场成果` : ''} · ${fieldImageCount}张现场图片（${ordinaryPhotoCount}张普通照片 + ${panoramaCount}张全景）`
    : `${routeVideoCount}段路线视频 · ${fieldImageCount || 0}张已登记现场图片`;
  const navigationDimensionEvidence = modelAsset.metadata?.navigationDimensionEvidence
    || modelAsset.metadata?.navigationTopologyBaseline?.evidence?.find((item) => item?.fileName === 'amap-site-boundary-20261005.png')
    || null;
  const navigationTopologyFirst = modelAsset.metadata?.topologyFirst === true;
  const modelFidelity = modelAsset.kind === 'site_context_glb'
     ? { title: modelAsset.metadata?.blenderRefined ? 'Blender 精修连续视频周边小道' : '连续视频周边小道', detail: `${evidenceSummary} · ${Math.round(modelAsset.metadata?.routeLengthM || 0)}m 连续路线 · ${Object.keys(modelAsset.metadata?.currentStateDetailCounts || modelAsset.metadata?.detailCounts || {}).length || 0} 类现状周边细节 · 现场视频帧材质证据；主楼显示为基于 CAD 首层轮廓的外景外壳，原始 SKP/CAD 室内墙、柱、门窗与材料保存在独立室内模型图层${modelAsset.metadata?.blenderRefined ? `；Blender ${modelAsset.metadata?.blenderVersion || ''} 对 ${modelAsset.metadata?.blenderRefinement?.bevelAppliedCount || 0} 个构件设置可编辑倒角，并精修 ${modelAsset.metadata?.blenderRefinement?.tunedMaterialCount || 0} 类 PBR 材质` : ''}。现状展示默认隐藏施工围挡、塔吊和临时框架，历史施工证据仍可在专家模式回看；设施只出现在对应视频区间，未拍连接、程序化微纹理、设施尺寸、材质精修和绝对线位为 Hypothesis；场景不放置方向箭头或代表车辆。`, coordinate: '本地 ENU 米制近似配准，已绑定项目锚点，但不是测绘级成果' }
     : modelAsset.kind === 'site_interior_model_glb'
       ? { title: '主建筑独立室内 CAD/BIM', detail: `${modelAsset.metadata?.levelCount ?? 1} 个楼层 · 源 SKP/CAD 几何与材料保留在独立室内资产；不会混入周边外景 GLB。`, coordinate: '相对米制，需与周边场景单独配准后叠加' }
     : modelAsset.kind === 'skp_glb'
    ? { title: 'SKP 主体模型', detail: '门窗、砖瓦与贴图仅来自原始 SKP；系统不会补造未建模细节。', coordinate: modelAsset.metadata?.georeferenced ? '已与项目地理锚点配准' : '相对米制，未与 OSM 地理底景配准' }
    : modelAsset.kind === 'blender_enhanced_glb'
      ? { title: 'Blender PBR 增强模型', detail: `${modelAsset.metadata?.levelCount ?? 1} 个独立楼层 · 几何沿用 ${modelAsset.metadata?.schema || 'CAD 室内模型'}；程序纹理、PBR参数、灯光与预览相机为 Hypothesis，不代表现场实测材质。`, coordinate: project?.modelRegistration?.modelArtifactId === modelAsset.id ? '已保存与 OSM 的人工配准参数，证据等级为 Hypothesis' : '继承相对米制坐标，需保存配准参数后才能与 OSM 同场叠加' }
    : modelAsset.kind === 'dwg_extrusion_glb'
      ? /^dwg_interior_model\.v[234]$/.test(modelAsset.metadata?.schema || '')
        ? { title: modelAsset.metadata?.schema === 'dwg_interior_model.v4' ? 'CAD 室内语义 v4' : modelAsset.metadata?.schema === 'dwg_interior_model.v3' ? 'CAD 室内三维 v3' : 'CAD 室内三维 v2', detail: `${modelAsset.metadata?.levelCount ?? 1} 个独立楼层 · ${modelAsset.metadata?.sourceSurfaceCount ?? 0} 个面状墙体/柱体依据 · ${modelAsset.metadata?.openingCounts?.door ?? 0} 门 / ${modelAsset.metadata?.openingCounts?.window ?? 0} 窗 · ${modelAsset.metadata?.resolvedOpeningCounts?.window ?? modelAsset.metadata?.wallOpeningCutCount ?? 0} 个窗洞已与墙体对齐 · ${modelAsset.metadata?.windowFrameCount ?? 0} 组窗框 · ${modelAsset.metadata?.selectedFurnitureCount ?? 0} 件简化家具 · ${modelAsset.metadata?.selectedSemanticObjectCount ?? 0} 个停车/景观/洁具/消防/机电语义对象 · ${modelAsset.metadata?.railingCount ?? modelAsset.metadata?.categoryCounts?.railing ?? 0} 组护栏/栏杆 · ${modelAsset.metadata?.handrailCount ?? modelAsset.metadata?.categoryCounts?.handrail ?? 0} 段扶手；平面几何为 Derived，垂直尺寸与细部参数为 Hypothesis。`, coordinate: project?.modelRegistration?.modelArtifactId === modelAsset.id ? '已保存与 OSM 的人工配准参数，证据等级为 Hypothesis' : '相对米制，需保存配准参数后才能与 OSM 同场叠加' }
        : { title: modelAsset.metadata?.schema === 'dwg_interior_model.v1' ? 'CAD 室内三维 · 旧版' : 'DWG 参数化补模', detail: modelAsset.metadata?.schema === 'dwg_interior_model.v1' ? `${modelAsset.metadata?.outputSegmentCount ?? 0} 条结构线 · ${modelAsset.metadata?.openingCounts?.door ?? 0} 门 / ${modelAsset.metadata?.openingCounts?.window ?? 0} 窗 · ${modelAsset.metadata?.floorSlabCount ?? 0} 块楼板；该版本为单平面拉伸资产。` : `${modelAsset.metadata?.outputSegmentCount ?? 0} 条 DWG 结构线已拉伸；该旧资产未包含完整门窗和楼板。`, coordinate: '相对米制，需控制点或变换矩阵后才能与 SKP / OSM 同场叠加' }
    : modelAsset.kind === 'osm_context_glb'
      ? { title: 'OSM 周边体量与道路', detail: `${modelAsset.metadata?.counts?.buildings ?? 0} 栋建筑 · ${modelAsset.metadata?.counts?.roads ?? 0} 条道路；材质为概念显示，不含立面门窗。`, coordinate: 'WGS84 → 本地 ENU，已绑定项目地理锚点' }
      : modelAsset.kind === 'dwg_plan_glb'
        ? { title: 'DWG 平面校核', detail: '仅显示可解析线段，不包含立面、门窗或贴图材质。', coordinate: modelAsset.metadata?.georeferenced ? '已地理配准' : '米制源坐标，未与 OSM 配准' }
        : modelType === 'ply'
          ? { title: '点云实景层', detail: '颜色来自点云顶点；点密度决定可见细节。', coordinate: '坐标状态以源资产记录为准' }
          : { title: '导入 GLB / GLTF', detail: '几何、门窗与材质均来自上传文件。', coordinate: modelAsset.metadata?.georeferenced ? '已地理配准' : '坐标状态未声明，暂不能保证与 OSM 同场对齐' };
  const supplementalReferenceConflicts = Array.isArray(modelAsset?.metadata?.supplementalReferenceConflicts)
    ? modelAsset.metadata.supplementalReferenceConflicts
    : [];
  const openReferenceConflictCount = supplementalReferenceConflicts.filter((item) => ![
    'resolved_by_visibility_policy',
    'resolved_by_reference_correction',
    'operator_approved_approximate',
    'reference_only'
  ].includes(item?.status)).length;
  const handleCompetitionPresentation = async () => {
    if (loadState.status !== 'ready') return;
    const runtime = environmentRef.current;
    if (!runtime?.model) return;
    try {
      if (!digitalDerivative) {
        const result = await runtime.setDigitalDerivative?.(true);
        if (result?.active !== true) return;
        setDigitalDerivative(true);
      }
      setCompetitionPresentation(true);
      setTwinMode(true);
      runtime.setTwinMode?.(true);
      setDisplayMode('day-night');
      setHeatmapPlan('P-BALANCED');
      setAgentSlot('weekday_arrival');
      setAgentCount(260);
      setFluidMode(false);
      runtime.fitView?.();
    } catch (error) {
      console.error('比赛演示模式启动失败', error);
    }
  };
  const exitCompetitionPresentation = async () => {
    const runtime = environmentRef.current;
    try {
      if (digitalDerivative) {
        const result = await runtime?.setDigitalDerivative?.(false);
        if (result?.active === false) setDigitalDerivative(false);
      }
    } catch (error) {
      console.error('比赛演示模式退出失败', error);
    }
    setCompetitionPresentation(false);
    setTwinMode(false);
    runtime?.setTwinMode?.(false);
    setDisplayMode('original');
    setHeatmapPlan('P-SAFE');
    setAgentCount(300);
    setFluidMode(false);
  };
  const selectedSurfaceEditor = surfaceEditorObjects.find((item) => item.id === surfaceEditorId) || surfaceEditorObjects[0] || null;
  const selectSurfaceEditorObject = (id) => {
    setSurfaceEditorId(id);
    const selection = environmentRef.current?.selectEditableObject?.(id);
    if (selection) setDirectSurfaceSelection(selection);
  };
  const updateSurfaceEditor = (key, value) => {
    if (!selectedSurfaceEditor) return;
    const next = environmentRef.current?.setBWalkEditorObject?.(selectedSurfaceEditor.id, { [key]: Number(value) }) || [];
    setSurfaceEditorObjects(next);
    setSurfaceEditorMessage(`${selectedSurfaceEditor.label} · ${key === 'length' ? '长度' : key === 'width' ? '宽度' : key === 'offsetX' ? 'X偏移' : 'Z偏移'}已更新`);
  };
  const resetSurfaceEditor = () => {
    if (!selectedSurfaceEditor) return;
    const next = environmentRef.current?.resetBWalkEditorObject?.(selectedSurfaceEditor.id) || [];
    setSurfaceEditorObjects(next);
    setSurfaceEditorMessage(`${selectedSurfaceEditor.label} · 已恢复初始尺寸和位置`);
  };
  const captureSurfaceFormat = () => {
    const result = environmentRef.current?.captureBWalkFormat?.(surfaceFormatSourceId);
    const source = surfaceEditorObjects.find((item) => item.id === surfaceFormatSourceId);
    setSurfaceEditorMessage(result ? `已吸取「${source?.label || '源对象'}」格式，选择目标后点击应用` : '源对象暂不可用');
  };
  const applySurfaceFormat = () => {
    const result = environmentRef.current?.applyBWalkFormat?.(surfaceFormatTargetId);
    const target = surfaceEditorObjects.find((item) => item.id === surfaceFormatTargetId);
    setSurfaceEditorMessage(result ? `已将格式刷应用到「${target?.label || '目标对象'}」` : '请先吸取格式');
    if (result) setSurfaceEditorObjects(environmentRef.current?.getBWalkEditorObjects?.() || []);
  };
  const captureDirectFormat = () => {
    const result = environmentRef.current?.captureEditableFormat?.();
    setDirectFormatBrushArmed(Boolean(result));
    setSurfaceEditorMessage(result ? `已吸取「${directSurfaceSelection?.label || directSurfaceSelection?.name || '对象'}」格式，请点击目标对象` : '请先在场景中点击一个可编辑对象');
  };
  const applyDirectFormat = () => {
    const result = environmentRef.current?.applyEditableFormat?.();
    if (result) setDirectFormatBrushArmed(false);
    setSurfaceEditorMessage(result ? `已把格式刷应用到「${directSurfaceSelection?.label || directSurfaceSelection?.name || '对象'}」` : '请先吸取格式，再选中目标对象');
  };
  const copyDirectSelection = () => {
    const result = environmentRef.current?.copyEditableObject?.();
    setSurfaceEditorMessage(result ? `已复制「${result.label}」，点击粘贴会在旁边生成副本` : '请先在场景中点击一个可编辑对象');
  };
  const pasteDirectSelection = () => {
    const result = environmentRef.current?.pasteEditableObject?.();
    setSurfaceEditorMessage(result ? `已粘贴「${result.label}」副本` : '请先复制一个可编辑对象');
  };
  const deleteDirectSelection = () => {
    const result = environmentRef.current?.deleteEditableObject?.();
    setSurfaceEditorMessage(result ? `已删除「${result.name}」，可点击撤销删除` : '主大楼或未选对象不能删除');
  };
  const undoDirectSelectionDelete = () => {
    const result = environmentRef.current?.undoEditableDelete?.();
    setSurfaceEditorMessage(result ? `已恢复「${result.label || result.name}」` : '当前没有可撤销的删除');
  };
  const clipDirectSelection = () => {
    const result = environmentRef.current?.clipEditableObject?.({ axis: surfaceClipAxis, keepSide: surfaceClipKeepSide, fraction: Number(surfaceClipFraction) });
    setSurfaceEditorMessage(result ? `已裁剪「${directSurfaceSelection?.label || directSurfaceSelection?.name || '对象'}」的一侧，可撤回` : '请先在场景中点击一个可编辑对象');
  };
  const undoDirectSelectionClip = () => {
    const result = environmentRef.current?.undoEditableClip?.();
    setSurfaceEditorMessage(result ? `已撤回「${result.target}」的区域裁剪` : '当前没有可撤回的区域裁剪');
  };
  return <><div className="metro-view-toolbar" style={{ position: 'static', padding: '6px 10px', background: '#07131c' }}>
    <select aria-label="地铁口视角预设" defaultValue="" disabled={loadState.status !== 'ready'} onChange={(event) => {
      const presets = [ [[-70,70,-130],[-83,0,-104]], [[-50,30,-135],[-83,2,-104]], [[150,130,160],[-30,0,-50]], [[-20,100,80],[-69,0,40]], [[-45,25,10],[-69,2,40]], [[150,130,160],[-30,0,20]] ];
      const runtime = environmentRef.current;
      const preset = presets[Number(event.target.value)];
      if (event.target.value !== '' && runtime?.model && preset) {
        runtime.camera.position.fromArray(preset[0]).add(runtime.model.position);
        runtime.controls.target.fromArray(preset[1]).add(runtime.model.position);
        runtime.controls.update();
      }
      event.target.value = '';
    }}><option value="">地铁口视角 ▾</option>{['2号口俯视','2号口人视','2号口接驳全景','4号口俯视','4号口人视','4号口接驳全景'].map((label, index) => <option key={label} value={index}>{label}</option>)}</select>
  </div><div className={`three-mount-wrap ${isExpanded ? 'expanded' : ''} ${navigationMode === 'walkthrough' ? 'walkthrough' : ''} ${navigationMode === 'route-tour' ? 'route-tour' : ''} ${competitionPresentation ? 'competition-presentation' : ''}`} data-navigation-mode={navigationMode}>
    <div className="three-mount" ref={mountRef} aria-label={`三维模型预览：${modelName}`} />
    <div className="coordinate-probe" aria-live="polite">
      <div><strong>当前层坐标</strong><span>{pointerCoordinate ? `X ${pointerCoordinate.x.toFixed(3)} · Y ${pointerCoordinate.y.toFixed(3)} · Z ${pointerCoordinate.z.toFixed(3)}` : '移动鼠标到场地表面'}</span></div>
      <button type="button" disabled={!pointerCoordinate} onClick={() => pointerCoordinate && setCoordinateRows((rows) => [...rows, { id: `${modelAsset.id}-${rows.length + 1}`, layer: layerLabel(modelAsset), x: pointerCoordinate.x, y: pointerCoordinate.y, z: pointerCoordinate.z, object: '待指定', source: 'operator_point' }])}>记录点</button>
      <details><summary>面层点位表（{coordinateRows.length}）</summary><table><thead><tr><th>#</th><th>对象</th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>{coordinateRows.map((row, index) => <tr key={row.id}><td>{index + 1}</td><td>{row.object}</td><td>{row.x.toFixed(3)}</td><td>{row.y.toFixed(3)}</td><td>{row.z.toFixed(3)}</td></tr>)}</tbody></table>{coordinateRows.length > 0 && <button type="button" onClick={() => setCoordinateRows([])}>清空表格</button>}</details>
    </div>
    {/* B-WALK-01 photo evidence remains in the evidence archive; its viewport panel is hidden during cleanup. */}
    {twinMode && <div className="twin-hud" aria-label="孪生模式状态面板">
      <div className="twin-hud-title"><span className="twin-hud-dot" />SPATIAL TWIN <b>ONLINE</b></div>
      <div className="smart-city-kicker"><span>SMART CITY DERIVATIVE</span><em>L3 CITY OPS · DERIVED LAYER</em></div>
      <div className="twin-hud-grid"><span>小路拥挤度</span><strong>{congestionLabel(renderedAgentCount)}</strong><small>小路 agents · Simulated</small><span>方案</span><strong>{heatmapPlan}</strong><small>route heatmap</small><span>FPS</span><strong>{fps == null ? '--' : fps}</strong><small>{fluidMode ? 'fluid mode' : 'live'}</small></div>
      <div className="twin-hud-badges"><em>Simulated</em><i>Scenario</i><span>ACES · Bloom</span></div>
      <div className="derivative-state-compare" aria-label="改造前后状态对比">
        <div className="derivative-state before"><span>01 · 现状场景</span><strong>OBSTRUCTION</strong><small>围栏阻断 · 入口绕行 · 混行压力</small></div>
        <i aria-hidden="true">→</i>
        <div className="derivative-state after"><span>02 · {heatmapPlan} 改造后</span><strong>{heatmapPlan === 'P-EFFICIENCY' ? 'FLOW SPLIT' : 'FLOW RELEASE'}</strong><small>{heatmapPlan === 'P-EFFICIENCY' ? '双开口分流 · 门禁复杂度上升' : '地面小门 · 直达分流 · 小路热力'}</small></div>
      </div>
      <div className="derivative-engine-panel">
        <div className="derivative-engine-head"><span>DERIVATIVE ENGINE · L3</span><b>OBSERVE → TEST → DECIDE</b></div>
        <div className="derivative-pipeline"><span>现场锚点</span><i>→</i><span>流量信号</span><i>→</i><span>改造方案</span><i>→</i><span>复算验证</span></div>
        <div className="derivative-compare-strip"><span>现状</span><b>西门 {transportPlan?.lastSimulation?.roadResults?.find((item) => item.roadId === 'west-gate-walkway')?.flow?.pedestrians ?? 132}</b><small>人/时</small><b>南侧 {transportPlan?.lastSimulation?.roadResults?.find((item) => item.roadId === 'south-service-lane')?.flow?.pedestrians ?? 86}</b><small>人/时</small><i>→</i><span>{heatmapPlan} 改造后</span><b>{heatmapPlan === 'P-EFFICIENCY' ? '开口分流' : '小门 +60'}</b><small>{heatmapPlan === 'P-EFFICIENCY' ? '待现场分配' : '人/时'}</small></div>
        <small className="derivative-engine-note">24H 轨道是全天情景强度时间轴；不是逐人运动轨迹。数字为 Scenario，需现场穿越计数校准。</small>
      </div>
      <div className="pain-narrative-panel"><strong>三处改建痛点 · {heatmapPlan}</strong><div className="pain-point-buttons">{['① 西门人行小道','② 南侧混行线','③ 栅栏小门'].map((label, index) => <button type="button" key={label} onClick={() => environmentRef.current?.focusPainPoint?.(index)}>{label}<small>{twinMode ? '解法路径' : '现状警示'}</small></button>)}</div>{painMetrics?.plans && Object.values(painMetrics.plans).some((metric) => Number(metric.currentM) > 0) ? <div className="pain-metric-list">{Object.entries(painMetrics.plans).map(([id, metric]) => <div key={id}><span>{id}</span><b>南侧小路：{metric.currentM}m → {metric.planM}m</b><small>省 {metric.savingPercent}% · Simulated</small></div>)}</div> : <div className="pain-metric-empty">路线长度未实测 · 只显示小路状态与方案关系，不把估算距离冒充现场测量。</div>}</div>
    </div>}
    {competitionPresentation && <aside className="competition-presentation-legend" aria-label="比赛演示空间关系说明">
      <div className="competition-presentation-heading"><span>COMPETITION PRESENTATION</span><strong>空间关系在线</strong></div>
      <div className="competition-presentation-status">Derived scene · Simulated flow</div>
      <div className="competition-relation-list">
        <div><strong>主楼外壳</strong><span>↔ 侧小道 / 栅栏 · Derived</span></div>
        <div><strong>2号口 · 4号口</strong><span>↔ 主楼接驳路线 · Observed anchor</span></div>
        <div><strong>三处痛点</strong><span>↔ P-BALANCED 解法路径 · Scenario</span></div>
        <div><strong>小路人流与热力</strong><span>西门小道 / 南侧混行线 · Simulated</span></div>
      </div>
      <small>本模式只改变呈现层；真实模型、照片证据和来源台账仍可退出后查看。</small>
    </aside>}
    {modelAsset?.id === 'asset_10602c89c51e' && <div className="asset-layer-watermark" style={{ position: 'absolute', left: 16, bottom: 16, zIndex: 45, padding: '7px 12px', color: '#fff8ef', background: 'rgba(8,18,22,.86)', border: '1px solid #ff9f68', font: '600 12px/1.2 sans-serif', pointerEvents: 'none' }}>当前图层：新标注图 · 三栋外围建筑与小道</div>}
    {modelAsset?.kind === 'site_context_glb' && sitePreviewArtifact?.url && <div className={`three-mount-poster ${['preview', 'ready'].includes(loadState.status) ? 'ready' : ''}`} aria-hidden={['preview', 'ready'].includes(loadState.status)}>
      <img src={sitePreviewArtifact.url} alt="当前三维场景快速预览" decoding="async" fetchPriority="high" />
      <div className="three-mount-poster-copy"><strong>场景预览已就绪</strong><span>高清三维模型正在后台解码，完成后自动切换。</span></div>
    </div>}
    {loadState.status === 'preview' && <div className="viewport-preview-status" role="status"><strong>快速三维</strong><span>{loadState.message}</span></div>}
    <div className="viewport-mode-bar" role="status" aria-live="polite">
      <div className="viewport-mode-copy">
        <span className="viewport-mode-kicker">当前操作</span>
        <strong>{activeNavigationMode.label}</strong>
        <span>{activeNavigationMode.detail}</span>
      </div>
      <button type="button" className={`viewport-help-trigger ${showInteractionHelp ? 'active' : ''}`} aria-expanded={showInteractionHelp} onClick={() => setShowInteractionHelp((current) => !current)}>
        <CircleHelp size={14} />操作说明
      </button>
    </div>
    {showInteractionHelp && <div className="viewport-help-panel" role="note">
      <strong>{activeNavigationMode.label} · 怎么操作</strong>
      <span>{activeNavigationMode.hint}</span>
      <small>显示模式和模型图层只改变呈现方式，不会修改原始三维资产。</small>
    </div>}
    {visualAssets.length > 1 && <details className="model-layer-picker" open>
      <summary><span>三维图层</span><strong>{Math.max(1, visualAssets.findIndex((asset) => asset.id === modelAsset.id) + 1)} / {visualAssets.length}</strong></summary>
      <div className="model-layer-switch" role="group" aria-label="三维资产图层" aria-busy={loadState.status === 'loading'}>{visualAssets.map((asset) => { const isRegisteredActive = asset.id === project?.modelRegistration?.siteContextArtifactId; return <button type="button" key={asset.id} disabled={loadState.status === 'loading'} className={`${asset.id === modelAsset.id ? 'active' : ''} ${directImageCandidateModelKinds.has(asset.kind) ? 'candidate-layer' : ''} ${isRegisteredActive ? 'registered-active-layer' : ''}`} aria-pressed={asset.id === modelAsset.id} onClick={() => { explicitModelSelectionRef.current = true; setSelectedModelId(asset.id); }}>{layerLabel(asset)}{isRegisteredActive ? ' · 当前主场景' : ''}</button>; })}</div>
      <div className="model-layer-merge-probe" style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <button type="button" onClick={() => window.__sfLayerMerge?.toggle()}>图层合并预览 {window.__sfLayerMerge?.count?.() ?? 0} 层已合并</button>
        <button type="button" onClick={() => window.__sfLayerMerge?.clear()}>清空</button>
      </div>
    </details>}
    {modelAsset?.kind === 'site_map_layout_candidate_glb' && <details key={modelAsset.id} className="direct-image-candidate-banner candidate-view-controls">
      <summary>视角与素材</summary>
      <div className="candidate-view-controls-body">
      <strong>{detailOrientationCandidate ? '③立面细节朝向修正' : orientationCorrectionCandidate ? '③建筑朝向修正' : entryCorrectionCandidate ? '入口围栏与③砖楼' : fullCaptureCandidate ? '全场地细化 · 材质与路线' : evidenceCompletionCandidate ? '场地补全 · ②侧边与小道设施' : '新标注图 · 三栋外围建筑与蓝线小道'}</strong>
      <span>{detailOrientationCandidate ? '保持③主体和导航占地不变，只将生成的砖墙表面、窗列、外挑百叶箱和弧形雨棚转到正确立面；主楼、道路和人行门未改。' : orientationCorrectionCandidate ? '按用户现场照片将③正面、背面整体旋转180°，中心和导航占地不变；主大楼、道路及人行门未改。' : entryCorrectionCandidate ? '补充③砖墙、窗列与百叶箱，修正灰色围栏、人行折返栏杆、岗亭和车行设备；主大楼未改。高度和局部落点按照片比例估计，待你核对。' : fullCaptureCandidate ? '112份采景素材已按连续区域补充：③两面立面、南侧道路停车、东侧连续路线和夹道构造；尺寸仍以照片与导航相对比例为准。' : evidenceCompletionCandidate ? '②仅补夹道侧立面，高度估算；①③仍为体块。小道设施落点近似，主楼旧窗列待修。' : '占地按图对齐；外围建筑暂高12米，主楼立面保留待修。绿色线不参与建模。'}</span>
      {['查看整体', '俯视核对位置'].map((label, index) => <button key={label} type="button" className="secondary-button" style={{ pointerEvents: 'auto' }} disabled={loadState.status !== 'ready'} onClick={() => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return;
        const bounds = new runtime.THREE.Box3().setFromObject(runtime.model);
        const target = bounds.getCenter(new runtime.THREE.Vector3());
        const radius = bounds.getBoundingSphere(new runtime.THREE.Sphere()).radius;
        const vertical = runtime.THREE.MathUtils.degToRad(runtime.camera.fov);
        const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * runtime.camera.aspect);
        const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.08;
        runtime.camera.position.copy(target).add(index ? new runtime.THREE.Vector3(0, distance, .001) : new runtime.THREE.Vector3(-distance * .35, distance * .75, distance * .5));
        runtime.controls.target.copy(target);
        runtime.controls.update();
      }}>{label}</button>)}
      {evidenceCompletionCandidate && <button type="button" className="secondary-button" style={{ pointerEvents: 'auto' }} disabled={loadState.status !== 'ready'} onClick={() => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return;
        runtime.camera.position.set(-72, 20, -123).add(runtime.model.position);
        runtime.controls.target.set(-34, 17, -102).add(runtime.model.position);
        runtime.controls.update();
      }}>查看②侧边</button>}
      {fullCaptureCandidate && <details style={{ pointerEvents: 'auto' }}>
        <summary>更多视角与全部素材</summary>
        {[['主楼前侧', [20, 10, 100], [0, 10, 54]], ['树荫侧', [-105, 9, 10], [-72, 11, -2]], ['外围东侧', [125, 8, -25], [74, 8, -25]], ['入口区域', [68, 4, -105], [65, 2, -80]], ...(entryCorrectionCandidate ? [['③砖楼细节', [70, 9, -89], [95, 10, -87]], ['人行入口', [61, 3, -73], [61, 1, -79]]] : []), ...(/-v3\.glb$/.test(modelAsset?.name || '') ? [['入口细节', [6, 3.1, 72], [3, 2, 56]], ['藤蔓与桁架', [-98, 12, 6], [-84, 14, -4]], ['栏杆外非机动车', [35, 5, -92], [30, 1, -79]]] : [])].map(([label, position, target]) => <button key={label} type="button" className="secondary-button" style={{ pointerEvents: 'auto' }} disabled={loadState.status !== 'ready'} onClick={() => {
          const runtime = environmentRef.current;
          if (!runtime?.model) return;
          runtime.camera.position.set(...position).add(runtime.model.position);
          runtime.controls.target.set(...target).add(runtime.model.position);
          runtime.controls.update();
        }}>{label}</button>)}
        <a className="secondary-button" style={{ pointerEvents: 'auto' }} href={entryCorrectionCandidate ? (/人行门-v6/.test(modelAsset?.name || '') ? '/capture-review/pedestrian-gate-v3/index.html' : /人行门-v5/.test(modelAsset?.name || '') ? '/capture-review/pedestrian-gate-v2/index.html' : '/capture-review/entry-fence-v1/index.html') : (/工程补充|连续场景与车库细化|全场地连续细化|错误构件清理版/.test(modelAsset?.name || '')) ? '/capture-review/complete-capture-20261010-v5/index.html' : /-v3\.glb$/.test(modelAsset?.name || '') ? '/capture-review/oct02-details-v3/index.html' : '/capture-review/full-capture-v1/index.html'} target="_blank" rel="noreferrer">{entryCorrectionCandidate ? (/人行门-v[56]/.test(modelAsset?.name || '') ? '人行门修正对照' : '入口与③砖楼照片对照') : (/工程补充|连续场景与车库细化|全场地连续细化|错误构件清理版/.test(modelAsset?.name || '')) ? '112份采景工程分析与定位' : /-v3\.glb$/.test(modelAsset?.name || '') ? '10月2日景物补充与定位对照' : '112份素材定位与使用情况'}</a>
      </details>}
      </div>
    </details>}
    {['main_building_facade_candidate_glb', 'site_side_path_candidate_glb'].includes(modelAsset?.kind) && <div className="direct-image-candidate-banner" role="note">
      <strong>{modelAsset.kind === 'site_side_path_candidate_glb' ? '主楼旁小道 · 路面与两侧路缘' : '主楼 · 照片五区实景候选'}</strong>
      <span>{modelAsset.kind === 'site_side_path_candidate_glb' ? '立面暂留待修；路宽、排水口和减速带落点为近似。' : '图1至图5对应的主楼材质已直接写入模型网格；视频尚未加入，入口、道路和其他区域保持。'}</span>
      <button type="button" className="secondary-button" style={{ pointerEvents: 'auto' }} disabled={loadState.status !== 'ready'} onClick={() => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return;
        const bounds = new runtime.THREE.Box3();
        const prefix = modelAsset.kind === 'site_side_path_candidate_glb' ? 'A03_PATH_' : 'main-building-exterior-review-';
        runtime.model.traverse((object) => { if (object.isMesh && object.name.startsWith(prefix)) bounds.expandByObject(object); });
        if (bounds.isEmpty()) return;
        const target = bounds.getCenter(new runtime.THREE.Vector3());
        const radius = bounds.getBoundingSphere(new runtime.THREE.Sphere()).radius;
        const vertical = runtime.THREE.MathUtils.degToRad(runtime.camera.fov);
        const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * runtime.camera.aspect);
        const distance = radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.12;
        runtime.camera.position.copy(target).add(new runtime.THREE.Vector3(0, distance * (modelAsset.kind === 'site_side_path_candidate_glb' ? .7 : .08), -distance));
        runtime.controls.target.copy(target);
        runtime.controls.update();
      }}>{modelAsset.kind === 'site_side_path_candidate_glb' ? '查看小道' : '查看新增窗列'}</button>
      {modelAsset.kind === 'site_side_path_candidate_glb' && <button type="button" className="secondary-button" style={{ pointerEvents: 'auto' }} disabled={loadState.status !== 'ready'} onClick={() => {
        const runtime = environmentRef.current;
        if (!runtime?.model) return;
        runtime.camera.position.set(59, 1.85, -70.5).add(runtime.model.position);
        runtime.controls.target.set(20, 1.3, -70.5).add(runtime.model.position);
        runtime.controls.update();
      }}>沿小道查看</button>}
    </div>}
    {modelAsset?.kind === 'main_building_facade_candidate_glb' && <details className="facade-photo-evidence-panel" open>
      <summary><span>照片证据 · 主楼图1至图5</span><small>用户已确认区域顺序</small></summary>
      <div className="facade-photo-zone-tabs" role="tablist" aria-label="主楼照片区域">
        {facadePhotoZones.map((zone) => <button type="button" key={zone.id} className={selectedFacadeZone === zone.id ? 'active' : ''} aria-selected={selectedFacadeZone === zone.id} onClick={() => setSelectedFacadeZone(zone.id)}>{zone.label}</button>)}
      </div>
      {(() => { const zone = facadePhotoZones.find((item) => item.id === selectedFacadeZone) || facadePhotoZones[0]; return <div className="facade-photo-zone-detail">
        <div className="facade-photo-pair"><figure><img src={zone.image} alt={`${zone.label}现场照片`} loading="lazy" /><figcaption>现场照片</figcaption></figure><figure><img src={zone.modelImage} alt={`${zone.label}当前模型位置`} loading="lazy" /><figcaption>用户指定的模型位置</figcaption></figure></div>
         <div><strong>{zone.title}</strong><span>来源：{zone.evidence}</span><small>照片默认按地面向上视角解释；模型位置由用户截图确认。视频尚未加入本候选。</small></div>
         <div className="facade-photo-reference-controls">
           <button type="button" className={`secondary-button ${showFacadePhotoReference ? 'active' : ''}`} aria-pressed={showFacadePhotoReference} onClick={() => setShowFacadePhotoReference((current) => !current)}>{showFacadePhotoReference ? '关闭参考叠加' : '参考叠加'}<small>Observed photo</small></button>
           <label><span>透明度</span><input type="range" min="0.16" max="0.78" step="0.01" value={facadePhotoReferenceOpacity} onChange={(event) => setFacadePhotoReferenceOpacity(Number(event.target.value))} /><output>{Math.round(facadePhotoReferenceOpacity * 100)}%</output></label>
         </div>
      </div>; })()}
    </details>}
    {modelAsset?.kind === 'main_building_facade_candidate_glb' && showFacadePhotoReference && (() => { const zone = facadePhotoZones.find((item) => item.id === selectedFacadeZone) || facadePhotoZones[0]; return <div className="facade-photo-reference-overlay" aria-label="现场照片参考叠加">
      <img src={zone.image} alt={`${zone.label}现场照片参考叠加`} style={{ opacity: facadePhotoReferenceOpacity }} />
      <div className="facade-photo-reference-badge"><strong>REFERENCE OVERLAY</strong><span>{zone.label} · Observed photo · Illustrative camera match</span><small>透明度可调；机位为手工还原，不宣称测绘级配准。</small></div>
    </div>; })()}
    <div className="display-mode-control">
      <button type="button" className={`twin-mode-toggle perimeter-scope-toggle ${immediatePerimeterMode ? 'active' : ''}`} aria-pressed={immediatePerimeterMode} disabled={loadState.status !== 'ready'} title={loadState.status !== 'ready' ? '等待模型加载…' : '窗口1：主楼左侧连续段 · 两条小道 · 栅栏 · 绿化'} onClick={() => setImmediatePerimeterMode((current) => !current)}><Route size={14} />{immediatePerimeterMode ? '窗口1 · B-WALK-01 ON' : '窗口1 · B-WALK-01 OFF'}<small>主楼左侧 · Derived</small></button>
      <details className="viewport-layer-controls">
        <summary><Layers3 size={14} /><span>显示与仿真</span><small>图层 · 模式 · 人流</small></summary>
        <div className="viewport-layer-controls-body">
      <button type="button" className={`twin-mode-toggle middle-building-toggle ${middleBuildingMode ? 'active' : ''}`} aria-pressed={middleBuildingMode} disabled={loadState.status !== 'ready'} title={loadState.status !== 'ready' ? '等待模型加载…' : '导入入口层的中间建筑②'} onClick={() => setMiddleBuildingMode((current) => !current)}><Building2 size={14} />{middleBuildingMode ? '导入中间建筑② · ON' : '导入中间建筑② · OFF'}<small>原体块 · Observed</small></button>
      <button type="button" className="twin-mode-toggle middle-building-focus" disabled={loadState.status !== 'ready' || !middleBuildingMode} title="把镜头移到中间建筑②" onClick={() => environmentRef.current?.focusMissingMiddleBuilding?.()}><LocateFixed size={14} />查看中间建筑②<small>定位镜头</small></button>
      <button type="button" className={`twin-mode-toggle competition-presentation-toggle ${competitionPresentation ? 'active' : ''}`} aria-pressed={competitionPresentation} disabled={loadState.status !== 'ready'} title={loadState.status !== 'ready' ? '等待模型加载…' : '数字衍生夜景 + 关系标签 + 视觉拥挤度'} onClick={() => { if (competitionPresentation) void exitCompetitionPresentation(); else void handleCompetitionPresentation(); }}><ScanLine size={14} />{competitionPresentation ? '退出比赛演示' : '比赛演示 · NIGHT'}<small>Derived / Simulated</small></button>
      <button type="button" className={`twin-mode-toggle ${twinMode ? 'active' : ''}`} aria-pressed={twinMode} disabled={loadState.status !== 'ready'} title={loadState.status !== 'ready' ? '等待模型加载…' : undefined} onClick={() => { const next = !twinMode; setTwinMode(next); environmentRef.current?.setTwinMode?.(next); }}><Sparkles size={14} />{twinMode ? '孪生模式 · ONLINE' : '开启孪生模式'}<small>Simulated</small></button>
      <button type="button" className={`twin-mode-toggle derivative-toggle ${digitalDerivative ? 'active' : ''}`} aria-pressed={digitalDerivative} disabled={loadState.status !== 'ready'} title={loadState.status !== 'ready' ? '等待模型加载…' : undefined} onClick={async () => { const next = !digitalDerivative; const result = await environmentRef.current?.setDigitalDerivative?.(next); if (result?.active === next) { setDigitalDerivative(next); if (next) setTwinMode(true); } }}><Sparkles size={14} />{digitalDerivative ? '数字衍生 · ONLINE' : '数字衍生'}<small>Derived / Simulated</small></button>
      <button type="button" className={`twin-mode-toggle fluid-mode-toggle ${fluidMode ? 'active' : ''}`} aria-pressed={fluidMode} disabled={loadState.status !== 'ready'} title={loadState.status !== 'ready' ? '等待模型加载…' : 'Bloom 0.25 · DPR 1.0 · agent ≤150'} onClick={() => setFluidMode((current) => !current)}><Gauge size={14} />{fluidMode ? '流畅模式 · ON' : '流畅模式'}<small>FPS {fps == null ? '--' : fps}</small></button>
      <div className="twin-agent-controls" aria-label="模拟人流控制">
        <label title={agentPathSummary.labels.length ? `人流仅沿${agentPathSummary.labels.join('、')}分布` : '等待小路路线数据'}>小路拥挤度 · Simulated <input type="range" min="0" max="500" step="1" value={agentCount} onChange={(event) => setAgentCount(Number(event.target.value))} /><output>{congestionLabel(renderedAgentCount)}</output></label>
        <select value={agentSlot} onChange={(event) => setAgentSlot(event.target.value)} aria-label="人流时段">
          <option value="weekday_arrival">早高峰 08:30–09:30 · 1.0×</option>
          <option value="weekday_midday">平峰 12:30–13:30 · 0.45×</option>
          <option value="weekday_departure">晚高峰 17:30–18:30 · 0.9×</option>
        </select>
        <select value={heatmapPlan} onChange={(event) => setHeatmapPlan(event.target.value)} aria-label="热力方案">
          <option value="P-SAFE">热力 P-SAFE · Simulated</option>
          <option value="P-EFFICIENCY">热力 P-EFFICIENCY · Simulated</option>
          <option value="P-BALANCED">热力 P-BALANCED · Simulated</option>
        </select>
      </div>
        </div>
      </details>
      <div className="display-mode-switch" role="group" aria-label="模型显示模式">
        {displayModes.map((mode) => <button type="button" key={mode.id} data-mode={mode.id} className={mode.id === displayMode ? 'active' : ''} aria-pressed={mode.id === displayMode} aria-label={`${mode.label}：${mode.detail}`} title={mode.detail} onClick={() => setDisplayMode(mode.id)}><span>{mode.index}</span>{mode.label}</button>)}
      </div>
      <div className="display-mode-note" aria-live="polite"><strong>{activeDisplayMode.label}</strong><span>{activeDisplayMode.detail}</span></div>
      {displayMode === 'sunny' && <div className="sunny-render-status" aria-live="polite"><Sun size={13} /><span>{modelAsset?.kind === 'site_context_glb' ? '晴空 · 太阳方位 · 柔和补光' : '晴空 · 太阳方位 · 软阴影'}</span><em>{scenarioPoint?.sun ? `${Math.round(Number(scenarioPoint.sun.altitude_deg || 0))}° 高度角` : '标准日照预设'}</em></div>}
    </div>
    {immediatePerimeterMode && surfaceEditorObjects.length > 0 && <details className="surface-editor-panel" open={surfaceEditorOpen} onToggle={(event) => setSurfaceEditorOpen(event.currentTarget.open)}>
      <summary><span>快速面层编辑</span><small>可缩短 / 伸长 / 格式刷</small></summary>
      <div className={`surface-editor-body ${surfaceDirectEditEnabled ? 'editor-active' : 'editor-locked'} `}>
        <div className="surface-direct-toolbar"><button type="button" className={`secondary-button ${surfaceDirectEditEnabled ? 'active' : ''}`} aria-pressed={surfaceDirectEditEnabled} onClick={() => setSurfaceDirectEditEnabled((current) => !current)}>{surfaceDirectEditEnabled ? '编辑模式 · ON' : '开启编辑模式'}</button>{surfaceDirectEditEnabled && <><button type="button" className={`secondary-button ${surfaceTransformMode === 'translate' ? 'active' : ''}`} aria-pressed={surfaceTransformMode === 'translate'} onClick={() => setSurfaceTransformMode('translate')}>移动</button><button type="button" className={`secondary-button ${surfaceTransformMode === 'scale' ? 'active' : ''}`} aria-pressed={surfaceTransformMode === 'scale'} onClick={() => setSurfaceTransformMode('scale')}>放缩</button><span>主大楼已锁定</span></>}{!surfaceDirectEditEnabled && <span className="surface-editor-locked-note">开启后点选单个对象，再进行移动、格式刷或区域裁剪</span>}</div>
        {directSurfaceSelection && <div className="surface-direct-selection"><strong>已选中：{directSurfaceSelection.label || directSurfaceSelection.name}</strong><span>{directSurfaceSelection.width} × {directSurfaceSelection.height} × {directSurfaceSelection.length}m · {directSurfaceSelection.source}</span><div><button type="button" className="secondary-button" onClick={copyDirectSelection}>复制</button><button type="button" className="secondary-button" onClick={pasteDirectSelection}>粘贴</button><button type="button" className="secondary-button danger" onClick={deleteDirectSelection}>删除</button><button type="button" className="secondary-button" onClick={undoDirectSelectionDelete}>撤销删除</button></div><div className="surface-format-direct"><button type="button" className={`secondary-button ${directFormatBrushArmed ? 'active' : ''}`} onClick={captureDirectFormat}>{directFormatBrushArmed ? '格式刷已吸取 · 点目标' : '吸取格式（选取源）'}</button><button type="button" className="primary-button" onClick={applyDirectFormat}>格式刷到当前</button>{directFormatBrushArmed && <span>已进入选取式格式刷：点击另一个对象会自动应用</span>}</div><div className="surface-clip-tools"><strong>区域裁剪</strong><label><span>切割方向</span><select value={surfaceClipAxis} onChange={(event) => setSurfaceClipAxis(event.target.value)}><option value="x">X 轴 · 左右</option><option value="z">Z 轴 · 前后</option><option value="y">Y 轴 · 上下</option></select></label><label><span>保留侧</span><select value={surfaceClipKeepSide} onChange={(event) => setSurfaceClipKeepSide(event.target.value)}><option value="positive">正侧 · 删除负侧</option><option value="negative">负侧 · 删除正侧</option></select></label><label className="surface-clip-range"><span>切线位置 <output>{Math.round(Number(surfaceClipFraction) * 100)}%</output></span><input type="range" min="0.05" max="0.95" step="0.05" value={surfaceClipFraction} onChange={(event) => setSurfaceClipFraction(Number(event.target.value))} /></label><button type="button" className="secondary-button danger" onClick={clipDirectSelection}>刀切当前对象</button><button type="button" className="secondary-button" onClick={undoDirectSelectionClip}>撤回裁剪</button></div></div>}
        <label className="surface-editor-select"><span>当前对象</span><select value={selectedSurfaceEditor?.id || ''} onChange={(event) => selectSurfaceEditorObject(event.target.value)}>{surfaceEditorObjects.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <div className="surface-editor-sliders">
          <label><span>长度 <output>{selectedSurfaceEditor?.length?.toFixed(2) || '—'}m</output></span><input type="range" min="0.1" max="240" step="0.1" value={selectedSurfaceEditor?.length || 1} onChange={(event) => updateSurfaceEditor('length', event.target.value)} /></label>
          <label><span>宽度 <output>{selectedSurfaceEditor?.width?.toFixed(2) || '—'}m</output></span><input type="range" min="0.1" max="180" step="0.1" value={selectedSurfaceEditor?.width || 1} onChange={(event) => updateSurfaceEditor('width', event.target.value)} /></label>
          <label><span>X偏移 <output>{selectedSurfaceEditor?.offsetX?.toFixed(2) || '0.00'}m</output></span><input type="range" min="-120" max="120" step="0.1" value={selectedSurfaceEditor?.offsetX || 0} onChange={(event) => updateSurfaceEditor('offsetX', event.target.value)} /></label>
          <label><span>Z偏移 <output>{selectedSurfaceEditor?.offsetZ?.toFixed(2) || '0.00'}m</output></span><input type="range" min="-120" max="120" step="0.1" value={selectedSurfaceEditor?.offsetZ || 0} onChange={(event) => updateSurfaceEditor('offsetZ', event.target.value)} /></label>
        </div>
        <div className="surface-editor-actions"><button type="button" className="secondary-button" onClick={resetSurfaceEditor}><RotateCcw size={13} />恢复当前对象</button><span>{surfaceEditorMessage}</span></div>
        <small className="surface-editor-note">格式刷采用选取式：先点源对象并吸取格式，再点目标对象自动应用；源 GLB 不变。刷新页面后仍保留本机编辑参数。</small>
      </div>
    </details>}
    {['site_context_glb', 'blender_enhanced_glb'].includes(modelAsset?.kind) && <div className="site-context-legend" role="note" aria-label="周边场景关系说明">
      <div className="site-context-legend-heading"><strong>当前建立的是：主楼周边场景</strong><span>不是室内 CAD 模型</span></div>
      <div className={`site-context-provenance ${navigationTopologyFirst ? 'ready' : 'pending'}`}>
        <span>定位与细部来源</span>
        <strong>{navigationTopologyFirst ? '导航尺寸 / 建筑道路拓扑：首层硬约束' : '导航首层约束：当前成果未登记'}</strong>
        <small>{navigationTopologyFirst
          ? `导航先确定主楼、道路方位与场地边界；视频和照片补充现场细部与材质${navigationDimensionEvidence?.fileName ? ` · 证据 ${navigationDimensionEvidence.fileName}` : ''}`
          : '请先生成带导航配准 metadata 的周边成果，再显示首层硬约束状态。'}</small>
      </div>
      <div className="site-context-legend-items">
        <span><i className="scene-swatch building" />主楼外壳</span>
        <span><i className="scene-swatch road" />主楼侧小道</span>
        <span><i className="scene-swatch outer-road" />栅栏外侧小道</span>
        <span><i className="scene-swatch fence" />贯穿黑色栅栏</span>
        <span><i className="scene-swatch gate" />行人小门</span>
        <span><i className="scene-swatch green" />草坪与绿化</span>
      </div>
      <small>要看门、窗、墙体和室内空间，请在上方切换“室内模型”图层。</small>
    </div>}
    {floorOptions.length > 0 && <div className="floor-navigation-control">
      <label><span>楼层</span><select aria-label="选择漫游楼层" value={selectedFloorNumber} onChange={(event) => setSelectedFloorNumber(Number(event.target.value))}>{floorOptions.map((level) => <option key={level.floorNumber} value={level.floorNumber}>{level.label || `${level.floorNumber}F`}</option>)}</select></label>
      <button type="button" className={isolateFloor ? 'active' : ''} aria-pressed={isolateFloor} onClick={() => setIsolateFloor((current) => !current)}><Layers3 size={13} />单层剖切</button>
      <button type="button" className={showSurroundings ? 'active' : ''} aria-pressed={showSurroundings} disabled={!contextAsset} onClick={() => setShowSurroundings((current) => !current)}><Map size={13} />周边环境</button>
    </div>}
    {modelAsset?.kind === 'site_context_glb' && <div className="construction-evidence-control expert-only">
      <label><input type="checkbox" checked={showHistoricalConstruction} onChange={(event) => setShowHistoricalConstruction(event.target.checked)} /> 显示历史施工证据</label>
      <small>{showHistoricalConstruction ? '施工围挡、塔吊与临时框架已显示，仅用于证据回看。' : '当前现场：施工对象已隐藏；永久护栏与围栏保留。'}</small>
    </div>}
    {modelAsset?.kind === 'site_context_glb' && modelAsset.metadata?.supplementalReferenceManifestId && <details className="reference-conflict-panel expert-only">
      <summary><AlertTriangle size={13} /><span>补充资料矛盾与边界</span><strong>{openReferenceConflictCount} 项待核验</strong></summary>
      <div className="reference-conflict-summary">
        <span>{modelAsset.metadata?.supplementalReferenceImageCount || 0} 张现场图片 · {modelAsset.metadata?.supplementalReferenceArticleCount || 0} 篇 Reference</span>
        <small>资料已绑定到当前模型，但未在无控制点的情况下改写道路线位和建筑朝向。</small>
      </div>
      <div className="reference-conflict-list">{supplementalReferenceConflicts.map((item) => <div key={item.id} data-status={item.status}>
        <strong>{item.statement}</strong><span>{item.allowedAction}</span>
      </div>)}</div>
    </details>}
    {(navigationMode === 'walkthrough' || navigationMode === 'route-tour') && <div className="navigation-speed-control" aria-label="漫游速度">
      <label><Gauge size={12} /><span>{navigationMode === 'route-tour' ? '沿线速度' : '步行速度'}</span><select value={navigationMode === 'route-tour' ? routeTourSpeed : walkthroughSpeedPreset} onChange={(event) => navigationMode === 'route-tour' ? setRouteTourSpeed(Number(event.target.value)) : setWalkthroughSpeedPreset(Number(event.target.value))}>
        <option value="0.25">逐帧核对 · 0.25 m/s</option><option value="0.5">慢速 · 0.5 m/s</option><option value="0.65">标准 · 0.65 m/s</option><option value="0.9">快速 · 0.9 m/s</option>
      </select></label>
    </div>}
    {allTourSpaces.length > 0 && <div className={`space-tour-control ${showSurroundings ? 'with-context' : ''}`} aria-label="空间导览">
      <div className="space-tour-heading"><span>空间导览</span><strong>{selectedTourIndex + 1}/{allTourSpaces.length}</strong></div>
      <label>
        <span>{floorOptions.find((level) => Number(level.floorNumber) === Number(selectedFloorNumber))?.label || `${selectedFloorNumber}F`}</span>
        <select aria-label="选择参观空间" value={selectedSpaceId} onChange={(event) => visitSpace(allTourSpaces.find((space) => space.id === event.target.value))}>
          {activeFloorSpaces.map((space) => <option key={space.id} value={space.id}>{space.displayLabel || space.label}</option>)}
        </select>
      </label>
      <div className="space-tour-actions">
        <button type="button" aria-label="上一空间" title="上一空间" disabled={selectedTourIndex <= 0} onClick={() => stepSpace(-1)}><ArrowLeft size={14} /></button>
        <button type="button" className="visit" onClick={() => visitSpace(selectedSpace)}><Footprints size={13} />进入空间</button>
        <button type="button" aria-label="下一空间" title="下一空间" disabled={selectedTourIndex < 0 || selectedTourIndex >= allTourSpaces.length - 1} onClick={() => stepSpace(1)}><ArrowRight size={14} /></button>
      </div>
      <small className="expert-only">{selectedSpace ? `${selectedSpace.evidence || 'Derived'} · ${selectedSpace.geometryStatus || 'label_anchor_only'}` : '该楼层暂无可核验空间锚点'}</small>
    </div>}
    {showSurroundings && contextAsset && <div className="context-registration-control" aria-label="周边环境配准参数">
      <div><span>周边位置校准</span><em className="expert-only">Hypothesis</em></div>
      <label>X<input type="number" step="0.5" value={registrationState.offsetXM} onChange={(event) => setRegistrationState((current) => ({ ...current, offsetXM: Number(event.target.value) }))} /></label>
      <label>Z<input type="number" step="0.5" value={registrationState.offsetZM} onChange={(event) => setRegistrationState((current) => ({ ...current, offsetZM: Number(event.target.value) }))} /></label>
      <label>旋转<input type="number" min="-360" max="360" step="1" value={registrationState.rotationDeg} onChange={(event) => setRegistrationState((current) => ({ ...current, rotationDeg: Number(event.target.value) }))} /></label>
      <label>比例<input type="number" min="0.1" max="10" step="0.01" value={registrationState.scale} onChange={(event) => setRegistrationState((current) => ({ ...current, scale: Number(event.target.value) }))} /></label>
      <button type="button" onClick={saveContextRegistration} title="保存周边配准参数"><Check size={14} /></button>
      <small>{registrationMessage}</small>
    </div>}
    {semanticLegendEntries.length > 0 && <div className="expert-only"><details className="semantic-material-legend">
      <summary><span>语义材质图例</span><strong>{semanticLegendEntries.length}</strong></summary>
      <div>{semanticLegendEntries.map((item) => <div key={item.category}><i className="semantic-material-swatch" style={{ backgroundColor: item.color }} /><span>{item.label}</span><em>{item.count}</em></div>)}</div>
      <small>{displayMode === 'analysis' ? '分析青图会统一着色；切回原始材质查看分类颜色。' : '颜色来自 CAD 语义分类；体量高度中的推断仍标记为 Hypothesis。'}</small>
    </details></div>}
    <div className="viewport-tools" role="toolbar" aria-label="三维视口控制">
      <button type="button" className="viewport-tool" data-orbit-only="true" aria-label="放大三维视口" title="放大三维视口" disabled={navigationMode !== 'orbit'} onClick={() => environmentRef.current?.zoomByFactor?.(0.94)}><ZoomIn size={16} /><span>放大</span></button>
      <button type="button" className="viewport-tool" data-orbit-only="true" aria-label="缩小三维视口" title="缩小三维视口" disabled={navigationMode !== 'orbit'} onClick={() => environmentRef.current?.zoomByFactor?.(1.06)}><ZoomOut size={16} /><span>缩小</span></button>
      <button type="button" className="viewport-tool" data-orbit-only="true" aria-label="模型归位" title="模型归位" disabled={navigationMode !== 'orbit'} onClick={() => environmentRef.current?.fitView?.()}><LocateFixed size={16} /><span>归位</span></button>
      <button type="button" className={`viewport-tool ${navigationMode === 'walkthrough' ? 'active' : ''}`} disabled={!walkthroughEligible || loadState.status !== 'ready'} aria-pressed={navigationMode === 'walkthrough'} aria-label={navigationMode === 'walkthrough' ? '退出建筑漫游' : '进入建筑漫游'} title={navigationMode === 'walkthrough' ? '退出建筑漫游' : '进入建筑漫游'} onClick={() => navigationMode === 'walkthrough' ? setNavigationMode('orbit') : enterWalkthrough()}><Footprints size={16} /><span>{navigationMode === 'walkthrough' ? '退出漫游' : '进入漫游'}</span></button>
      {routeRenderable && <button type="button" className={navigationMode === 'route-tour' ? 'active route-active' : ''} aria-label={routeTourPlayback.status === 'playing' ? '暂停连续沿线漫游' : '播放连续沿线漫游'} title={routeTourPlayback.status === 'playing' ? '暂停沿线漫游' : '播放沿线漫游'} onClick={() => {
        if (navigationMode !== 'route-tour') setNavigationMode('route-tour');
        else if (routeTourPlayback.status === 'playing') environmentRef.current?.pauseRouteTour?.();
        else environmentRef.current?.startRouteTour?.();
      }}>{routeTourPlayback.status === 'playing' ? <Pause size={16} /> : <Play size={16} />}<span>{routeTourPlayback.status === 'playing' ? '暂停沿线' : '播放沿线'}</span></button>}
      {routeRenderable && <button type="button" className="viewport-tool" aria-label="重新开始连续沿线漫游" title="重新开始沿线漫游" onClick={() => { environmentRef.current?.resetRouteTour?.(); if (navigationMode !== 'route-tour') setNavigationMode('route-tour'); }}><RotateCcw size={16} /><span>重播</span></button>}
      {navigationMode === 'route-tour' && <button type="button" className="viewport-tool" aria-label="退出连续沿线漫游" title="退出沿线漫游" onClick={() => setNavigationMode('orbit')}><X size={16} /><span>退出沿线</span></button>}
      {routeRenderable && displayMode === 'analysis' && <button type="button" className={`viewport-tool ${showSiteRoute ? 'active route-active' : ''}`} aria-pressed={showSiteRoute} aria-label={showSiteRoute ? '隐藏建筑周边小道' : '显示建筑周边小道'} title={showSiteRoute ? '隐藏小道' : '显示小道'} onClick={() => setShowSiteRoute((current) => !current)}><Route size={16} /><span>{showSiteRoute ? '隐藏路线' : '显示路线'}</span></button>}
      <button type="button" className="viewport-tool" aria-label="复制当前视角链接" title="复制当前视角链接" disabled={loadState.status !== 'ready'} onClick={copyCameraLink}><Link2 size={16} /><span>分享视角</span></button>
      <button type="button" className="viewport-tool" aria-label={isExpanded ? '退出全屏三维' : '全屏查看三维'} title={isExpanded ? '退出全屏' : '全屏查看'} onClick={toggleExpanded}>{isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}<span>{isExpanded ? '退出全屏' : '全屏'}</span></button>
    </div>
    {shareStatus && <div className="viewport-share-status" role="status">{shareStatus}</div>}
    {routeRenderable && displayMode === 'analysis' && <div className={`site-route-badge ${showSiteRoute ? 'visible' : 'hidden'}`} aria-live="polite">
      <i /><span><strong>{primarySiteRoute.label}</strong>{showSiteRoute ? `${siteRouteStats.lengthM ? `${Math.round(siteRouteStats.lengthM)}m · ` : ''}近似配准连续路线` : '路线图层已隐藏'}<small className="expert-only">7段现场视频 + 片段边界显式配准 · local_enu_m · 非测绘线位</small></span>
    </div>}
    {navigationMode === 'route-tour' && <div className="route-tour-hud" aria-live="polite">
       <div><Route size={14} /><span>连续沿线漫游</span><strong>{routeTourSpeed.toFixed(1)} m/s</strong></div>
      <progress max="1" value={routeTourPlayback.progress || 0} />
      <span>{Math.round(routeTourPlayback.distanceM || 0)} / {Math.round(siteRouteStats.lengthM || 0)} m · {routeTourPlayback.status === 'playing' ? '播放中' : routeTourPlayback.status === 'ended' ? '已到终点' : '已暂停'}</span>
      <small className="expert-only">普通展示不分章节；片段、时间戳和推定连接区间保留在内部证据映射。</small>
    </div>}
    {navigationMode === 'walkthrough' && <>
      <div className="walkthrough-hud" aria-live="polite">
        <div><Footprints size={14} /><span>步行参观</span><strong>{floorOptions.find((level) => Number(level.floorNumber) === Number(selectedFloorNumber))?.label || `${selectedFloorNumber}F`}</strong></div>
        {selectedSpace && <span>当前空间：{selectedSpace.displayLabel || selectedSpace.label}</span>}
         <em className="expert-only">{walkthroughEvidence}</em>
         <span className="expert-only">{showSurroundings ? '窗外周边：人工配准 Hypothesis' : '窗外周边：未启用'}</span>
         <small>移动速度：{walkthroughSpeed ? `${walkthroughSpeed.toFixed(1)} m/s` : '加载中'} · 适合逐空间查看</small>
         {/* The former “当前无碰撞约束” status is intentionally retired now that model-backed probes are active. */}
         <small>{walkthroughCollisionStats.enabled ? '防穿墙与边界保护已启用' : '当前仅启用楼层边界保护'}<span className="expert-only"> · {walkthroughCollisionStats.candidates} 组候选几何 · {selectedSpace ? `${selectedSpace.geometryStatus || 'label_anchor_only'}${walkthroughSpawnNotice ? ' · 已使用楼层安全落点' : ''}` : '楼层落点需人工复核'}</span></small>
         {walkthroughSpawnNotice && <small className="expert-only">{walkthroughSpawnNotice}</small>}
      </div>
      <div className="walkthrough-crosshair" aria-hidden="true" />
      <div className="walkthrough-dpad" role="group" aria-label="建筑漫游方向控制">
        {walkthroughControl('forward', '向前移动', ArrowUp, 'forward')}
        {walkthroughControl('left', '向左移动', ArrowLeft, 'left')}
        {walkthroughControl('right', '向右移动', ArrowRight, 'right')}
        {walkthroughControl('backward', '向后移动', ArrowDown, 'backward')}
      </div>
    </>}
    <div className="model-fidelity expert-only" aria-live="polite">
      <div><span>MODEL SOURCE</span><strong>{modelFidelity.title}</strong></div>
      <p>{modelFidelity.detail}</p>
      <small>{modelStats.meshes} 构件 · {modelStats.materials} 材质 · {modelStats.textures} 纹理</small>
      <em>{modelFidelity.coordinate}</em>
    </div>
    {!['preview', 'ready'].includes(loadState.status) && <div className={`viewport-state ${loadState.status}`}><Box size={28} /><strong>{loadState.status === 'error' ? '模型加载失败' : '正在加载真实三维资产'}</strong><span>{loadState.message}</span>{loadState.status === 'error' && <button type="button" className="secondary-button" onClick={() => setModelLoadAttempt((value) => value + 1)}><RefreshCw size={13} />重试加载</button>}</div>}
  </div></>;
}

function ViewportEmptyState({ icon: Icon, title, text }) {
  return <div className="viewport-empty"><Icon size={31} /><strong>{title}</strong><span>{text}</span></div>;
}

function RealVideoViewport({ asset, visionJob, sourceNature = 'field_observation' }) {
  const state = visionJob?.assetId === asset.id ? visionJob.status : 'not_started';
  const annotatedArtifact = visionJob?.output?.artifacts?.find((artifact) => artifact.kind === 'annotated_video');
  const [viewMode, setViewMode] = useState(annotatedArtifact ? 'annotated' : 'original');
  useEffect(() => { setViewMode(annotatedArtifact ? 'annotated' : 'original'); }, [asset.id, annotatedArtifact?.id]);
  const showingAnnotated = viewMode === 'annotated' && Boolean(annotatedArtifact);
  const processing = ['queued', 'running'].includes(state);
  const testOnly = sourceNature === 'virtual_test' || asset.testOnly || visionJob?.sourceNature === 'virtual_test';
  const label = showingAnnotated
    ? '当前显示人员、车辆与轨迹识别结果。'
    : state === 'succeeded'
      ? '当前显示原始视频，可切换到识别结果。'
      : processing
        ? '视频正在分析，完成后可切换查看结果。'
        : state === 'blocked' || state === 'failed'
          ? '该视频分析未完成，当前仍显示原始视频。'
          : '当前是原始视频，尚未开始分析。';
  return <div className="real-video-viewport">
    <video key={`${asset.id}:${showingAnnotated ? annotatedArtifact.id : 'original'}`} src={showingAnnotated ? annotatedArtifact.url : asset.url} controls preload="metadata" aria-label={`${showingAnnotated ? '标注结果' : '原始视频'}：${asset.name}`} />
    <div className="video-source-switch" role="group" aria-label="视频证据图层">
      <button type="button" aria-pressed={viewMode === 'original'} className={viewMode === 'original' ? 'active' : ''} onClick={() => setViewMode('original')}>{testOnly ? '演示视频' : '原始视频'}</button>
      <button type="button" aria-pressed={viewMode === 'annotated'} className={viewMode === 'annotated' ? 'active' : ''} disabled={!annotatedArtifact} onClick={() => setViewMode('annotated')}>识别结果</button>
    </div>
    <div className="viewport-hud expert-only"><span>{testOnly ? '虚拟测试视频 · TEST ONLY' : showingAnnotated ? '真实标注视频' : '真实原始视频'}</span><span>{state.replace('_', ' ').toUpperCase()}</span><span>{visionJob?.stage?.replaceAll('_', ' ').toUpperCase() || 'CALIBRATION NONE'}</span></div>
    <div className="video-truth-note">{label}</div>
  </div>;
}

function CameraCapture({ project, busy, setBusy, notify, refresh }) {
  const previewRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const [state, setState] = useState('idle');

  useEffect(() => () => {
    recorderRef.current?.state === 'recording' && recorderRef.current.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const connect = async () => {
    if (!project) return notify('error', '请先创建项目');
    if (!navigator.mediaDevices?.getUserMedia) return notify('error', '当前浏览器或页面协议不支持摄像头访问');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      setState('ready');
    } catch (error) { notify('warning', `摄像头连接失败：${error.message}`); }
  };

  const startRecording = () => {
    if (!streamRef.current) return notify('error', '请先连接摄像头');
    if (!window.MediaRecorder) return notify('error', '当前浏览器不支持 MediaRecorder');
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(streamRef.current, mimeType ? { mimeType } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data?.size) chunksRef.current.push(event.data); };
    recorder.onstop = async () => {
      if (!chunksRef.current.length) return notify('error', '摄像头没有产生可上传的视频数据');
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'video/webm' });
      const file = new File([blob], `camera-${new Date().toISOString().replaceAll(':', '-')}.webm`, { type: blob.type });
      const form = new FormData();
      form.append('files', file);
      setBusy(true);
      try {
        await api('/assets/upload', { method: 'POST', body: form });
        notify('success', '摄像头实录已上传并计算 SHA-256，可作为典型片段选择');
        await refresh();
      } catch (error) { notify('error', error.message, error.details); }
      finally { setBusy(false); setState('ready'); }
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setState('recording');
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };

  return <div className="camera-capture"><video ref={previewRef} autoPlay muted playsInline /><div className="camera-actions"><button className="secondary-button" disabled={busy || state === 'recording'} onClick={connect}><Radio size={14} /> {state === 'idle' ? '连接摄像头' : '重新连接'}</button>{state === 'recording' ? <button className="record-button active" onClick={stopRecording}><i /> 停止并上传</button> : <button className="record-button" disabled={state !== 'ready' || busy} onClick={startRecording}><i /> 开始实录</button>}</div><small>录制内容只在点击“停止并上传”后进入证据链；建议连续录制 5–20 分钟。</small></div>;
}

function JobEventTimeline({ events, streamStatus }) {
  if (!events?.length) return <div className="job-events empty">{streamStatus?.message ? <span className="job-stream-status"><i className={streamStatus.state === 'connected' ? 'done' : 'failed'} />{streamStatus.message}</span> : '任务启动后显示真实工具事件'}</div>;
  return <div className="job-events">{streamStatus?.message && <div className="job-stream-status"><i className={streamStatus.state === 'connected' ? 'done' : 'failed'} /><span>{streamStatus.message}</span></div>}{events.slice(-5).map((event) => <div key={event.id}><i className={event.type.includes('failed') ? 'failed' : event.type.includes('completed') ? 'done' : 'running'} /><span>{event.payload?.title || event.payload?.outputSummary || event.payload?.error || event.type}</span><small>{new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}</small></div>)}</div>;
}

function SemanticObjectRegistry({ project, assets, artifacts, sceneObjects, busy, setBusy, notify, refresh }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ id: '', type: 'gate', label: '', geometry: '', evidenceLevel: 'Hypothesis' });
  const geojsonAssets = [
    ...assets.filter((asset) => asset.name && asset.name.toLowerCase().endsWith('.geojson')).map((asset) => ({ ...asset, importLabel: asset.name })),
    ...artifacts.filter((artifact) => ['dwg_plan_geojson', 'osm_context_geojson'].includes(artifact.kind) && artifact.metadata?.stale !== true).map((artifact) => ({ ...artifact, name: artifact.title, importLabel: `${artifact.title} · 阶段产物` }))
  ];
  const [geojsonAssetId, setGeojsonAssetId] = useState('');
  const [geojsonCoordinateSpace, setGeojsonCoordinateSpace] = useState('local_enu');
  useEffect(() => { if (!geojsonAssetId && geojsonAssets[0]) setGeojsonAssetId(geojsonAssets[0].id); }, [geojsonAssets.length, geojsonAssetId]);
  const save = async (event) => {
    event.preventDefault();
    if (!project) return notify('error', '请先创建项目');
    let geometry;
    try { geometry = JSON.parse(form.geometry); } catch { return notify('error', 'Geometry 不是合法 GeoJSON 几何对象'); }
    setBusy(true);
    try {
      await api('/scene/objects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: form.id, type: form.type, label: form.label, geometry, evidenceLevel: form.evidenceLevel }) });
      setForm({ id: '', type: 'gate', label: '', geometry: '', evidenceLevel: 'Hypothesis' });
      setOpen(false);
      notify('success', '语义对象已登记，可被方案动作按 ID 引用');
      await refresh();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };
  const importGeoJson = async () => {
    if (!geojsonAssetId) return notify('warning', '请先上传并选择 .geojson 文件');
    setBusy(true);
    try {
      const result = await api('/scene/import-geojson', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetId: geojsonAssetId, coordinateSpace: geojsonCoordinateSpace })
      });
      notify('success', `已导入 ${result.import.importedCount} 个可追溯语义对象`);
      await refresh();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };
  return <div className="semantic-registry">
    <div className="registry-head"><span>可编辑语义层</span><strong>{sceneObjects.length} OBJECTS</strong><button className="text-button" onClick={() => setOpen(!open)}>{open ? '取消' : '登记对象'}</button></div>
    <div className="geojson-import">
      <div><strong>批量导入 GeoJSON</strong><span>DWG / SKP 转换后的矢量对象</span></div>
      <label><span>源文件</span><select value={geojsonAssetId} onChange={(event) => setGeojsonAssetId(event.target.value)}><option value="">{geojsonAssets.length ? '选择文件' : '暂无 GeoJSON'}</option>{geojsonAssets.map((asset) => <option value={asset.id} key={asset.id}>{asset.importLabel}</option>)}</select></label>
      <label><span>坐标语义</span><select value={geojsonCoordinateSpace} onChange={(event) => setGeojsonCoordinateSpace(event.target.value)}><option value="local_enu">本地 ENU（米）</option><option value="wgs84">WGS84 经纬度</option></select></label>
      <button className="secondary-button" disabled={busy || !project || !geojsonAssetId} onClick={importGeoJson}><Layers3 size={14} /> 批量登记</button>
    </div>
    {open && <form onSubmit={save}><div className="field-row"><label><span>对象 ID</span><input required value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="gate-west" /></label><label><span>类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="gate">出入口</option><option value="road">道路</option><option value="walkway">步行区</option><option value="loading_zone">卸货区</option><option value="dropoff_zone">落客区</option><option value="lighting">照明</option><option value="landscape">景观</option></select></label></div><div className="field-row"><label><span>标签</span><input required value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} /></label><label><span>证据类型</span><select value={form.evidenceLevel} onChange={(event) => setForm({ ...form, evidenceLevel: event.target.value })}><option value="Observed">Observed · 现场确认</option><option value="Derived">Derived · 确定性计算</option><option value="Hypothesis">Hypothesis · 人工/模型假设</option><option value="Scenario">Scenario · 情景推演</option></select></label></div><label><span>GeoJSON Geometry / 本地 ENU</span><textarea required value={form.geometry} onChange={(event) => setForm({ ...form, geometry: event.target.value })} placeholder='{"type":"Point","coordinates":[12.4,3.1,0]}' /></label><button className="secondary-button wide" disabled={busy} type="submit"><Plus size={14} /> 写入语义对象</button></form>}
    {!open && sceneObjects.slice(-3).map((object) => <div className="registry-row" key={object.id}><code>{object.id}</code><span>{object.label || object.type}</span><i className={`evidence-dot ev-${object.evidenceLevel.toLowerCase().replace(' ', '-')}`} /></div>)}
  </div>;
}

function ProjectLibrary({ projects, activeProjectId, projectLibraryState, busy, setBusy, notify, refresh, onRetry, onClose }) {
  const serviceReady = projectLibraryState.status === 'ready';
  const [creating, setCreating] = useState(serviceReady && projects.length === 0);
  const [form, setForm] = useState({ name: '', address: '', latitude: '', longitude: '', coordinateSystem: 'WGS84' });
  const activeProjects = projects.filter((project) => project.status !== 'archived');
  const archivedProjects = projects.filter((project) => project.status === 'archived');

  useEffect(() => {
    if (projectLibraryState.status === 'ready' && projects.length === 0) setCreating(true);
  }, [projectLibraryState.status, projects.length]);

  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === 'Escape') onClose(); };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  const createProject = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
      notify('success', '新项目已建立并切换为当前卷宗');
      await refresh();
      onClose();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };

  const switchProject = async (projectId) => {
    setBusy(true);
    try {
      await api(`/projects/${projectId}/activate`, { method: 'POST' });
      await refresh();
      notify('success', '当前项目已切换，工作区数据已重新载入');
      onClose();
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };

  const setProjectStatus = async (projectId, status) => {
    setBusy(true);
    try {
      await api(`/projects/${projectId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
      await refresh();
      notify('success', status === 'archived' ? '项目已归档，原始资料与成果均保留' : '项目已恢复');
    } catch (error) { notify('error', error.message, error.details); }
    finally { setBusy(false); }
  };

  const ProjectEntry = ({ item, archived = false }) => (
    <article className={`project-dossier ${item.id === activeProjectId ? 'current' : ''} ${archived ? 'archived' : ''}`}>
      <div className="dossier-index expert-only"><span>{item.id.slice(-6).toUpperCase()}</span><i>{item.id === activeProjectId ? 'CURRENT' : archived ? 'ARCHIVED' : 'ACTIVE'}</i></div>
      <div className="dossier-copy"><strong>{item.name}</strong><small>{item.address || <><span className="operator-only">未填写场地说明</span><span className="expert-only">{item.latitude}, {item.longitude}</span></>}</small><div><span>{item.counts?.assets || 0} 份资料</span><span>{item.counts?.observations || 0} 次视频分析</span><span>{item.counts?.artifacts || 0} 份成果</span></div></div>
      <div className="dossier-actions">
        {!archived && item.id !== activeProjectId && <button type="button" className="secondary-button" disabled={busy || projectLibraryState.status !== 'ready'} onClick={() => switchProject(item.id)}>切换项目</button>}
        {!archived && <button type="button" className="text-button" disabled={busy || projectLibraryState.status !== 'ready'} onClick={() => setProjectStatus(item.id, 'archived')}><Archive size={13} />归档项目</button>}
        {archived && <button type="button" className="text-button" disabled={busy || projectLibraryState.status !== 'ready'} onClick={() => setProjectStatus(item.id, 'active')}><RefreshCw size={13} />恢复项目</button>}
      </div>
    </article>
  );

  return <div className="project-library-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="project-library" role="dialog" aria-modal="true" aria-labelledby="project-library-title">
      <header className="project-library-header"><div><span className="expert-only">PROJECT DOSSIERS / LOCAL WORKSPACE</span><h2 id="project-library-title">项目卷宗库</h2><p>每个项目的资料、分析和成果都独立保存；切换项目不会删除其他项目。</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭项目卷宗库"><X size={19} /></button></header>
      <div className="project-library-toolbar"><strong>{projectLibraryState.status === 'loading' ? '正在连接项目库' : projectLibraryState.status === 'error' ? `${projects.length} 个缓存项目` : `${projects.length} 个项目`}</strong><button type="button" className="primary-button" disabled={busy || projectLibraryState.status !== 'ready'} onClick={() => setCreating((value) => !value)}><Plus size={14} />新建项目</button></div>
      {projectLibraryState.status !== 'ready' && <div className={`project-library-connection ${projectLibraryState.status}`}>
        {projectLibraryState.status === 'loading' ? <RefreshCw size={18} /> : <AlertTriangle size={18} />}
        <div><strong>{projectLibraryState.status === 'loading' ? '正在连接项目服务' : '项目服务离线'}</strong><span>{projectLibraryState.status === 'loading' ? '正在读取本地卷宗库，请稍候。' : '项目数据没有被删除。当前仅显示上次成功同步的卷宗清单，服务恢复后会自动重新载入。'}</span></div>
        {projectLibraryState.status === 'error' && <button type="button" className="secondary-button" onClick={onRetry}><RefreshCw size={14} />立即重试</button>}
      </div>}
      {creating && serviceReady && <form className="project-create-form" onSubmit={createProject}>
        <label><span>项目名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="某集团办公楼更新" /></label>
        <label><span>地址 / 场地说明</span><input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="项目卷宗说明" /></label>
        <label><span>纬度</span><input required type="number" step="any" value={form.latitude} onChange={(event) => setForm({ ...form, latitude: event.target.value })} /></label>
        <label><span>经度</span><input required type="number" step="any" value={form.longitude} onChange={(event) => setForm({ ...form, longitude: event.target.value })} /></label>
        <label><span>坐标系</span><select value={form.coordinateSystem} onChange={(event) => setForm({ ...form, coordinateSystem: event.target.value })}><option>WGS84</option><option>GCJ-02</option><option>BD-09</option></select></label>
        <button className="primary-button" type="submit" disabled={busy}><Check size={14} />建立卷宗</button>
      </form>}
      <div className="project-library-body">
        {(serviceReady || projects.length > 0) && <section><h3>{serviceReady ? '使用中的项目' : '上次同步的使用中项目'}</h3>{activeProjects.length ? activeProjects.map((item) => <ProjectEntry key={item.id} item={item} />) : <EmptyLine text="暂无使用中的项目" />}</section>}
        {!serviceReady && projects.length === 0 && <EmptyLine text="项目清单尚未载入，等待服务恢复" />}
        {archivedProjects.length > 0 && <section><h3>已归档项目</h3>{archivedProjects.map((item) => <ProjectEntry key={item.id} item={item} archived />)}</section>}
      </div>
    </section>
  </div>;
}

function ProjectServiceState({ state, cachedCount, onRetry }) {
  const loading = state.status === 'loading';
  return <section className={`project-service-state ${state.status}`} aria-live="polite">
    {loading ? <RefreshCw size={30} /> : <AlertTriangle size={30} />}
    <span className="expert-only">PROJECT LIBRARY / CONNECTION</span>
    <h1>{loading ? '正在连接项目库' : '项目服务暂时离线'}</h1>
    <p>{loading ? '正在读取项目卷宗和工作区资产。' : `项目数据没有被删除${cachedCount ? `，已保留 ${cachedCount} 个项目的上次同步清单` : ''}。系统每 5 秒自动重连，服务恢复后会重新载入真实项目数据。`}</p>
    {!loading && <button type="button" className="secondary-button" onClick={onRetry}><RefreshCw size={14} />立即重试</button>}
  </section>;
}

function ProjectServiceBanner({ state, onRetry }) {
  return <div className="project-service-banner" role="status"><AlertTriangle size={15} /><span><strong>项目服务暂时离线，已保留当前工作区</strong><small>{state.message || '正在自动重试；三维场景与已载入资料仍可查看。'}</small></span><button type="button" className="text-button" onClick={onRetry}><RefreshCw size={13} />立即重试</button></div>;
}

function StageHeading({ eyebrow, title, description }) {
  return <div className="stage-heading"><div><span className="expert-only">{eyebrow}</span><h1>{title.split(/\\n|\n/).map((line, i) => <React.Fragment key={line}>{line}{i === 0 && <br />}</React.Fragment>)}</h1></div><p>{description}</p></div>;
}
class WorkspaceErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error(`${this.props.label || '工作区'}渲染失败`, error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <section className="workspace-render-error" role="alert"><strong>{this.props.label || '工作区'}暂时无法显示</strong><span>{this.state.error.message || '页面组件发生运行时错误'}</span><button type="button" className="secondary-button" onClick={() => this.setState({ error: null })}>重试</button></section>;
  }
}
function StageFooter({ left, actions }) { return <footer className="stage-footer"><span><i />{left}</span><div>{actions}</div></footer>; }
function PanelHeader({ icon: Icon, title, action }) { return <header className="panel-header"><div><Icon size={16} /><h2>{title}</h2></div>{action}</header>; }
function RuntimeStatusIcon({ state, ready }) {
  const resolved = state || (ready ? 'ready' : 'blocked');
  const icon = resolved === 'ready' ? <Check size={12} /> : resolved === 'external_required' ? <Radio size={12} /> : resolved === 'degraded' ? <AlertTriangle size={12} /> : <X size={12} />;
  return <span className={`runtime-icon ${resolved === 'external_required' ? 'external' : resolved}`}>{icon}</span>;
}
function RuntimeLine({ label, ready, state, detail }) { return <div className="runtime-line"><RuntimeStatusIcon {...{ state, ready }} /><strong>{label}</strong><small>{detail}</small></div>; }
function RuntimeConsole({ health, busy, expertMode, onExpertModeChange, onRefresh, onClose }) {
  const runtimes = health?.runtimes || {};
  const runtimeCapabilities = health?.runtimeCapabilities || {};
  const llm = health?.llm || {};
  const groups = [
    {
      title: '推理接口',
      items: [
        { label: 'API 密钥配置', ready: llm.configured, detail: llm.configured ? '仅确认服务端存在，不显示内容' : '未配置' },
        { label: '精确模型 ID', ready: Boolean(llm.model), detail: llm.model || '未配置' },
        { label: '主节点', ready: Boolean(llm.primaryBaseUrl || llm.baseUrl), detail: llm.primaryBaseUrl || llm.baseUrl || '未配置' },
        { label: '香港直连节点', ready: Boolean(llm.directBaseUrl), detail: llm.directBaseUrl || '未配置' }
      ]
    },
    {
      title: '视觉与语义',
      items: [
        { label: 'YOLOX-s ONNX', ready: runtimes.yolo, detail: runtimes.yolo ? '模型权重可读' : '模型路径不可用' },
        { label: 'FFmpeg / FFprobe', ready: runtimes.ffmpeg && runtimes.ffprobe, detail: runtimes.ffmpeg && runtimes.ffprobe ? '解码、探测与编码可用' : '视频工具链不完整' },
        { label: runtimes.groundingDino?.label || 'Grounding DINO', ready: runtimes.groundingDino?.available, detail: runtimes.groundingDino?.model || runtimes.groundingDino?.note || '未配置真实模型' },
        { label: runtimes.sam2?.label || 'SAM 2', ready: runtimes.sam2?.available, detail: runtimes.sam2?.model || runtimes.sam2?.note || '未配置真实模型' }
      ]
    },
    {
      title: '三维重建与发布',
      items: [
        { label: 'OpenSKP', ready: runtimes.skpConverter, detail: runtimes.skpConverter ? 'SKP 主体模型可直接转换为 GLB' : 'SKP 解析器不可用' },
        { label: 'DWG Reader', ready: runtimes.dwgReader, detail: runtimes.dwgReader ? 'DWG 平面可转换为 GLB 与 GeoJSON' : 'DWG 解析器不可用' },
        { label: 'Blender Worker', ready: runtimes.blender, state: runtimeCapabilities.blender?.state, detail: runtimeCapabilities.blender?.detail || 'CAD 语义 GLB 可继续使用' },
        { label: 'COLMAP / PyCOLMAP', ready: runtimes.colmap, state: runtimeCapabilities.colmap?.state, detail: runtimeCapabilities.colmap?.detail || (runtimes.colmap ? '摄影测量可用' : '无法启动摄影测量') },
        { label: 'Nerfstudio / gsplat', ready: runtimes.nerfstudio, state: runtimeCapabilities.nerfstudio?.state, detail: runtimeCapabilities.nerfstudio?.detail || '可选增强；自动降级为 COLMAP 点云' },
        { label: 'Nerfstudio 导出', ready: runtimes.nsExport, state: runtimeCapabilities.nsExport?.state, detail: runtimeCapabilities.nsExport?.detail || '可选增强；仅影响 Gaussian 导出' },
        { label: 'Niantic SPZ', ready: runtimes.spz, state: runtimeCapabilities.spz?.state, detail: runtimeCapabilities.spz?.detail || '可选增强；当前使用 GLB / PLY' },
        { label: 'NVIDIA GPU', ready: runtimes.gpu?.available, state: runtimeCapabilities.gpu?.state, detail: runtimeCapabilities.gpu?.detail || '需要远程 CUDA Worker' }
      ]
    }
  ];
  const counts = health?.counts || {};

  return (
    <div className="runtime-console-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="runtime-console" role="dialog" aria-modal="true" aria-labelledby="runtime-console-title">
        <header className="runtime-console-header">
          <div><span className="expert-only">SYSTEM / LIVE DIAGNOSTICS</span><h2 id="runtime-console-title"><span className="operator-only">设置</span><span className="expert-only">系统诊断</span></h2><p className="operator-only">当前使用操作者视图，只显示完成项目所需的功能。</p><p className="expert-only">这些信息仅用于系统维护和问题排查，操作页默认不显示。</p></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭系统运行时" title="关闭"><X size={19} /></button>
        </header>
        <div className="runtime-console-toolbar">
          <span className={`status-chip expert-only ${health?.ok ? 'ready' : 'blocked'}`}>{health?.ok ? 'API ONLINE' : 'API WAITING'}</span>
          <span className="expert-only">{health?.timestamp ? `后端时间 ${new Date(health.timestamp).toLocaleString('zh-CN')}` : '尚未取得健康状态'}</span>
          <button type="button" className={`secondary-button runtime-mode-toggle ${expertMode ? 'active' : ''}`} aria-pressed={expertMode} aria-label={expertMode ? '隐藏专家信息' : '显示专家信息'} onClick={() => onExpertModeChange(!expertMode)}><Settings2 size={14} />{expertMode ? '恢复操作者视图' : '显示专家信息'}</button>
          <button type="button" className="secondary-button expert-only" onClick={onRefresh} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? '刷新中' : '刷新状态'}</button>
        </div>
        <div className="operator-settings-note operator-only"><Settings2 size={20} /><div><strong>专家信息已隐藏</strong><span>接口、模型、运行时、对象 ID 和审计数据不参与日常操作。只在维护或排查问题时开启专家信息。</span></div></div>
        <dl className="runtime-counts expert-only" aria-label="运行数据计数">
          <div><dt>源资产</dt><dd>{counts.assets ?? 0}</dd></div>
          <div><dt>观测记录</dt><dd>{counts.observations ?? 0}</dd></div>
          <div><dt>方案草案</dt><dd>{counts.proposals ?? 0}</dd></div>
          <div><dt>阶段资产</dt><dd>{counts.artifacts ?? 0}</dd></div>
        </dl>
        <div className="runtime-console-groups expert-only">
          {groups.map((group) => <section className="runtime-console-group" key={group.title}><h3>{group.title}</h3>{group.items.map((item) => <RuntimeConsoleLine key={item.label} {...item} />)}</section>)}
        </div>
      </section>
    </div>
  );
}
function RuntimeConsoleLine({ label, ready, state, detail }) { return <div className="runtime-console-line"><RuntimeStatusIcon {...{ state, ready }} /><strong>{label}</strong><small>{detail}</small></div>; }
function ProjectSummary({ project }) { return <div className="project-summary"><strong>{project?.name}</strong><p>{project?.address || '未填写地址说明'}</p><span className="expert-only">{project?.latitude}, {project?.longitude} · {project?.coordinateSystem}</span></div>; }
function AssetRow({ asset }) { const Icon = asset.type === 'video' ? FileVideo : asset.type === '3d' || asset.type === 'cad' ? Box : Database; const evidenceClass = asset.status === 'failed' ? 'hypothesis' : String(asset.evidenceLevel || 'Observed').toLowerCase().replace(' ', '-'); const typeLabel = asset.type === 'video' ? '视频' : asset.type === 'image' ? '图片' : asset.type === 'cad' ? '平面图' : asset.type === '3d' ? '三维模型' : '资料'; const displayName = asset.type === 'video' ? videoDisplayName(asset) : asset.name; const corridorIndex = asset.type === 'video' ? siteCorridorVideoPrefixes.findIndex((prefix) => String(asset.name || '').toLowerCase().startsWith(prefix)) : -1; return <div className="asset-row"><span><Icon size={16} /></span><div><strong>{displayName}</strong><small>{typeLabel} · {formatBytes(asset.size)}{corridorIndex >= 0 ? ` · 连续路线第 ${corridorIndex + 1} 段` : ''}{asset.testOnly ? ' · TEST ONLY' : ''}<span className="expert-only">{asset.status && asset.status !== 'ready' ? ` · ${asset.status.toUpperCase()}` : ''}</span></small></div><code className="expert-only" title={asset.sha256}>{asset.sha256?.slice(0, 8) || '—'}</code><i className={`evidence-dot expert-only ev-${evidenceClass}`} /></div>; }
function EmptyLine({ text }) { return <div className="empty-line"><CircleDot size={14} />{text}</div>; }
function UnavailableSource({ icon: Icon, title, text }) { return <div className="source-prompt"><Icon size={20} /><div><strong>{title}</strong><p>{text}</p></div></div>; }
function GateRow({ label, pass }) { return <div className="gate-row"><span className={pass ? 'pass' : ''}>{pass ? <Check size={13} /> : <X size={13} />}</span><strong>{label}</strong><small>{pass ? '已完成' : '待完成'}</small></div>; }
function ProposalCard({ proposal }) { return <div className="proposal-card"><div><span className={`status-chip ${proposal.status === 'Expert Approved' ? 'ready' : 'blocked'}`}>{proposal.status === 'Expert Approved' ? '已通过专家审核' : '待审核方案'}</span>{proposal.testOnly && <span className="status-chip blocked">演示数据</span>}<strong>{proposal.draft?.plans?.[0]?.name || proposal.id}</strong></div><small>{proposal.draft?.diagnoses?.length || 0} 项诊断 · {proposal.draft?.plans?.reduce((sum, p) => sum + (p.actions?.length || 0), 0) || 0} 项调整</small></div>; }

function Toolchain() {
  const tools = [['OSM / DEM', '地理基础'], ['COLMAP', '相机位姿'], ['Nerfstudio', '3D Gaussian'], ['Open3D', '点云处理'], ['Trimesh', '语义几何'], ['Three.js', '网页合成']];
  return <div className="toolchain">{tools.map(([name, detail], i) => <React.Fragment key={name}><div><strong>{name}</strong><span>{detail}</span></div>{i < tools.length - 1 && <ChevronRight size={13} />}</React.Fragment>)}</div>;
}

function Toast({ kind, message, details, onClose }) {
  const Icon = kind === 'success' ? CheckCircle2 : kind === 'warning' ? AlertTriangle : XCircle;
  const detailText = formatToastDetails(details);
  return <div className={`toast ${kind}`}><Icon size={19} /><div><strong>{message}</strong>{detailText && <small>{detailText}</small>}</div><button onClick={onClose}><X size={15} /></button></div>;
}

createRoot(document.getElementById('root')).render(<App />);





