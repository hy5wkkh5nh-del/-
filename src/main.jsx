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
