Warning: truncated output (original token count: 135598)
Total output lines: 6785

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
    let canc…85598 tokens truncated… null };
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






