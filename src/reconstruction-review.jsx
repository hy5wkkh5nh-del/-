import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Eye,
  EyeOff,
  Map,
  PauseCircle,
  RotateCw,
  Route,
  ShieldCheck,
  Video,
  XCircle
} from 'lucide-react';
import {
  KEYFRAME_REVIEW_STATES,
  KEYFRAME_MOTION_STATES,
  LOCATION_MODES,
  buildKeyframeReviewPatch,
  formatConfidence,
  formatFrameLocation,
  formatLocationMode,
  formatMotion,
  formatReviewState,
  formatTemporaryObjectState,
  getFrameMotion,
  getFrameMapPosition,
  getFrameReviewState,
  getFrameThumbnailUrl,
  getTemporaryObjectState,
  isTemporaryObjectVisible,
  normalizeLedgerForDisplay,
  reviewPatchForState,
  reviewGateStatus,
  updateKeyframe
} from './reconstruction-review-utils.mjs';
import './reconstruction-review.css';

const noop = () => {};

function stopPropagation(event) {
  event.stopPropagation();
}

function IconForMotion({ motion }) {
  if (motion === 'rotation-only') return <RotateCw size={13} aria-hidden="true" />;
  if (motion === 'stop') return <PauseCircle size={13} aria-hidden="true" />;
  return <Route size={13} aria-hidden="true" />;
}

export function ReviewStateBadge({ state = KEYFRAME_REVIEW_STATES.pending, className = '' }) {
  const icon = state === KEYFRAME_REVIEW_STATES.confirmed || state === KEYFRAME_REVIEW_STATES.corrected
    ? <CheckCircle2 size={12} aria-hidden="true" />
    : state === KEYFRAME_REVIEW_STATES.rejected
      ? <XCircle size={12} aria-hidden="true" />
      : <CircleHelp size={12} aria-hidden="true" />;
  return <span className={`reconstruction-review-state state-${state} ${className}`}>{icon}{formatReviewState(state)}</span>;
}

export function MotionBadge({ motion }) {
  return <span className={`reconstruction-review-motion motion-${String(motion || 'unknown').replaceAll('_', '-')}`}><IconForMotion motion={motion} />{formatMotion(motion)}</span>;
}

function GateSummary({ gate }) {
  return <div className="reconstruction-review-gate-summary" aria-live="polite">
    <span className={gate.canConfirm ? 'gate-ready' : 'gate-pending'}><ShieldCheck size={14} aria-hidden="true" />{gate.label}</span>
    <small>{gate.confirmed}/{gate.total} 帧已确认 · {gate.uncertain} 帧仍含位置区间/相对定位{gate.uncertainConfirmed ? `（其中 ${gate.uncertainConfirmed} 帧不能放行建模）` : ''} · {gate.rejected} 帧不采用</small>
  </div>;
}

function KeyframeMiniMap({ ledger, frames, mapImageUrl, selectedFrameId, onSelectFrame }) {
  const source = mapImageUrl || ledger?.mapReference?.url || ledger?.map_reference?.url || ledger?.map?.url;
  const markers = frames.map((frame, index) => {
    const position = getFrameMapPosition(frame);
    return {
      ...frame,
      index,
      ...position
    };
  });
  const placedMarkers = markers.filter((marker) => marker.x !== null && marker.y !== null);
  const unconvertedMarkers = markers.filter((marker) => marker.unconverted);
  return <section className="reconstruction-review-map" aria-label="关键帧导航位置">
    <div className="reconstruction-review-section-heading">
      <div><Map size={15} aria-hidden="true" /><strong>逐帧地图对应</strong></div>
      <small>{placedMarkers.length
        ? `${placedMarkers.length}/${markers.length} 帧有明确图面点位${unconvertedMarkers.length ? ` · ${unconvertedMarkers.length} 帧已记录但未转换` : ''}`
        : unconvertedMarkers.length
          ? `${unconvertedMarkers.length} 帧已记录点位，但未转换到底图百分比`
          : '未伪造地图坐标；使用表格中的点/区间/相对位置'}</small>
    </div>
    <div className={`reconstruction-review-map-canvas ${source ? 'has-image' : 'without-image'}`}>
      {source && <img src={source} alt="候选范围导航参考图" loading="lazy" />}
      {!source && <div className="reconstruction-review-map-placeholder"><Map size={24} /><span>尚未提供导航底图</span><small>关键帧仍可逐行确认；不能以屏幕坐标替代地图定位。</small></div>}
      {placedMarkers.map((marker) => <button
        type="button"
        key={marker.id}
        className={`reconstruction-review-map-marker ${marker.id === selectedFrameId ? 'active' : ''}`}
        style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
        title={`${marker.id} · ${marker.locationLabel}`}
        aria-label={`选择关键帧 ${marker.id}`}
        onClick={() => onSelectFrame(marker.id)}
      >{marker.index + 1}</button>)}
    </div>
    <div className="reconstruction-review-map-legend"><span><i className="marker-swatch" />每个编号对应一个独立关键帧</span><span><i className="route-swatch" />连续移动按帧记录，不合并成单点</span></div>
    {unconvertedMarkers.length > 0 && <div className="reconstruction-review-map-recorded-points" aria-label="已记录但未转换的关键帧点位">
      <strong>已记录点位（未转换到底图百分比）</strong>
      <div>{unconvertedMarkers.map((marker) => <button type="button" key={`recorded-${marker.id}`} onClick={() => onSelectFrame(marker.id)} className={marker.id === selectedFrameId ? 'active' : ''}>
        <span>{marker.index + 1} · {marker.id}</span>
        <small>{marker.pointId ? `点 ${marker.pointId}` : marker.coordinatesLabel || '坐标已记录'} · 未转换到底图位置</small>
      </button>)}</div>
    </div>}
  </section>;
}

function CameraRelationGrid({ camera }) {
  return <div className="reconstruction-review-camera-grid" aria-label="相机当前行进方向下的画面关系">
    <div><span>左侧</span><strong>{camera.left}</strong></div>
    <div><span>中央 / 视线</span><strong>{camera.center}</strong></div>
    <div><span>右侧</span><strong>{camera.right}</strong></div>
    <small>参照：{camera.reference || '相机当前行进方向'}</small>
  </div>;
}

function editableFormFromFrame(frame) {
  const raw = frame?.raw || {};
  const location = frame?.location || {};
  const coordinates = Array.isArray(location.coordinates) ? location.coordinates : [];
  const changes = {
    fromPrevious: raw.changeFromPrevious || raw.change_from_previous || raw.transition || raw.comparison || '',
    toNext: raw.changeToNext || raw.change_to_next || ''
  };
  return {
    locationMode: location.mode || LOCATION_MODES.pending,
    pointId: location.pointId || '',
    routeSegment: location.routeSegment || '',
    coordinateX: coordinates[0] ?? '',
    coordinateY: coordinates[1] ?? '',
    imageXPercent: raw.mapBinding?.xPercent ?? raw.location?.xPercent ?? '',
    imageYPercent: raw.mapBinding?.yPercent ?? raw.location?.yPercent ?? '',
    intervalStart: location.start ?? '',
    intervalEnd: location.end ?? '',
    relativeNote: location.relative || '',
    rotationStationConfirmed: location.rotationStationValid === true,
    routeProgress: location.progress ?? '',
    motionState: frame?.motion || KEYFRAME_MOTION_STATES.unknown,
    cameraLeft: frame?.camera?.left || '',
    cameraCenter: frame?.camera?.center || '',
    cameraRight: frame?.camera?.right || '',
    cameraReference: frame?.camera?.reference || 'camera_travel_direction',
    changeFromPrevious: changes.fromPrevious,
    changeToNext: changes.toNext
  };
}

function KeyframeDetail({ frame, onUpdateFrame = noop, readOnly = false, thumbnailUrlResolver, thumbnailBaseUrl = '' }) {
  const raw = frame.raw || {};
  const currentState = frame.reviewState;
  const thumbnailUrl = frame.thumbnailUrl || getFrameThumbnailUrl(raw, { resolver: thumbnailUrlResolver, baseUrl: thumbnailBaseUrl });
  const [form, setForm] = useState(() => editableFormFromFrame(frame));
  const [saveMessage, setSaveMessage] = useState('');
  useEffect(() => {
    setForm(editableFormFromFrame(frame));
    setSaveMessage('');
  }, [frame.id, frame.raw]);
  const updateForm = (field) => (event) => {
    const value = event?.target?.value ?? '';
    setForm((current) => ({ ...current, [field]: value }));
    setSaveMessage('');
  };
  const rotationStationMissing = form.locationMode === LOCATION_MODES.rotationOnly
    && (!String(form.pointId || '').trim() || form.rotationStationConfirmed !== true);
  const saveLocation = () => {
    if (readOnly || rotationStationMissing) return;
    const hasCoordinateInput = String(form.coordinateX ?? '').trim() || String(form.coordinateY ?? '').trim();
    const patch = buildKeyframeReviewPatch({
      locationMode: form.locationMode,
      pointId: form.pointId,
      routeSegment: form.routeSegment,
      coordinates: hasCoordinateInput ? { x: form.coordinateX, y: form.coordinateY } : null,
      imageXPercent: form.imageXPercent,
      imageYPercent: form.imageYPercent,
      intervalStart: form.intervalStart,
      intervalEnd: form.intervalEnd,
      relativeNote: form.relativeNote,
      routeProgress: form.routeProgress,
      motionState: form.motionState,
      cameraLeft: form.cameraLeft,
      cameraCenter: form.cameraCenter,
      cameraRight: form.cameraRight,
      cameraReference: form.cameraReference,
      changeFromPrevious: form.changeFromPrevious,
      changeToNext: form.changeToNext,
      rotationStationConfirmed: form.rotationStationConfirmed
    });
    onUpdateFrame(frame.id, patch);
    setSaveMessage('已提交当前关键帧定位与相邻变化');
  };
  const setStatus = (nextState) => {
    if (readOnly) return;
    onUpdateFrame(frame.id, reviewPatchForState(nextState));
  };
  return <div className="reconstruction-review-frame-detail">
    <div className="reconstruction-review-detail-head">
      <div><span className="detail-kicker">关键帧 {frame.id}</span><strong>{frame.sourceName}</strong><small>{frame.timestampLabel} · {frame.frameNumber === null ? '源帧号未记录' : `源帧 ${frame.frameNumber}`}</small>{frame.imagePath && <small className="frame-source-path" title={frame.imagePath}>证据文件：{frame.imagePath}</small>}</div>
      <ReviewStateBadge state={currentState} />
    </div>
    {thumbnailUrl && <a className="reconstruction-review-frame-thumbnail" href={thumbnailUrl} target="_blank" rel="noreferrer"><img src={thumbnailUrl} alt={`${frame.id} 证据关键帧`} loading="lazy" /><span>打开原始关键帧</span></a>}
    <div className="reconstruction-review-detail-grid">
      <div className="reconstruction-review-detail-block"><span>导航对应</span><strong>{formatFrameLocation(raw)}</strong><small>定位模式：{formatLocationMode(frame.location.mode)}{frame.location.routeSegment ? ` · 路线段 ${frame.location.routeSegment}` : ''}</small></div>
      <div className="reconstruction-review-detail-block"><span>移动状态</span><strong><MotionBadge motion={frame.motion} /></strong><small>{raw.motionNote || raw.movementNote || '按视频前后帧判断；不把画面变化直接当世界方位。'}</small></div>
      <div className="reconstruction-review-detail-block"><span>证据等级 / 置信度</span><strong className={`confidence-${frame.confidence}`}>{frame.evidenceLevelLabel} · {formatConfidence(frame.confidence)}</strong><small>{raw.evidence?.basis || raw.evidenceBasis || raw.location?.basis || '未记录定位依据'}</small></div>
    </div>
    <CameraRelationGrid camera={frame.camera} />
    {(raw.changeFromPrevious || raw.changeToNext || raw.transition || raw.comparison) && <div className="reconstruction-review-transition"><span>与相邻帧的变化</span><p>{raw.changeFromPrevious || raw.transition || raw.comparison || '—'}</p>{raw.changeToNext && <p>下一帧：{raw.changeToNext}</p>}</div>}
    {((Array.isArray(raw.evidence?.basis) && raw.evidence.basis.length > 0) || (Array.isArray(raw.locationEvidence) && raw.locationEvidence.length > 0)) && <div className="reconstruction-review-evidence-list"><span>定位证据</span><ul>{(raw.evidence?.basis || raw.locationEvidence || []).map((item, index) => <li key={`${frame.id}-basis-${index}`}>{typeof item === 'object' ? (item.statement || item.label || item.id || JSON.stringify(item)) : item}</li>)}</ul></div>}
    <form className="reconstruction-review-location-editor" onSubmit={(event) => { event.preventDefault(); saveLocation(); }} onClick={stopPropagation}>
      <div className="reconstruction-review-editor-heading"><div><Map size={14} aria-hidden="true" /><strong>人工定位与移动关系编辑</strong></div><small>只保存明确输入；空字段保持为空，不从画面猜坐标。</small></div>
      <div className="reconstruction-review-editor-grid">
        <label><span>位置模式</span><select value={form.locationMode} onChange={updateForm('locationMode')} disabled={readOnly}>
          <option value={LOCATION_MODES.pending}>待定位</option>
          <option value={LOCATION_MODES.point}>地图点</option>
          <option value={LOCATION_MODES.interval}>地图区间</option>
          <option value={LOCATION_MODES.relativeOnly}>仅相对位置</option>
          <option value={LOCATION_MODES.rotationOnly}>同一站点 · 原地旋转</option>
        </select></label>
        <label><span>地图点标识 / 站点标识</span><input value={form.pointId} onChange={updateForm('pointId')} disabled={readOnly} placeholder="如 OBS-07 / PAN-001" /></label>
        {form.locationMode === LOCATION_MODES.rotationOnly && <div className="editor-checkbox"><span>站点确认</span><label><input type="checkbox" checked={form.rotationStationConfirmed === true} onChange={(event) => setForm((current) => ({ ...current, rotationStationConfirmed: event.target.checked }))} disabled={readOnly} />用户已确认该合法旋转站点</label></div>}
        <label><span>路线段</span><input value={form.routeSegment} onChange={updateForm('routeSegment')} disabled={readOnly} placeholder="只填已确认的路线段" /></label>
        <label><span>箭尾→箭头进度（米）</span><input type="number" step="any" value={form.routeProgress} onChange={updateForm('routeProgress')} disabled={readOnly} placeholder="未确认可留空" /></label>
        <label><span>两维点 X</span><input type="number" step="any" value={form.coordinateX} onChange={updateForm('coordinateX')} disabled={readOnly} placeholder="用户明确输入" /></label>
        <label><span>两维点 Y</span><input type="number" step="any" value={form.coordinateY} onChange={updateForm('coordinateY')} disabled={readOnly} placeholder="用户明确输入" /></label>
        <label><span>底图 X（%）</span><input type="number" min="0" max="100" step="any" value={form.imageXPercent} onChange={updateForm('imageXPercent')} disabled={readOnly} placeholder="明确图面比例时填写" /></label>
        <label><span>底图 Y（%）</span><input type="number" min="0" max="100" step="any" value={form.imageYPercent} onChange={updateForm('imageYPercent')} disabled={readOnly} placeholder="明确图面比例时填写" /></label>
        <label><span>运动状态</span><select value={form.motionState} onChange={updateForm('motionState')} disabled={readOnly}>
          <option value={KEYFRAME_MOTION_STATES.forward}>前进</option>
          <option value={KEYFRAME_MOTION_STATES.backward}>回程 / 后退</option>
          <option value={KEYFRAME_MOTION_STATES.turning}>转弯中</option>
          <option value={KEYFRAME_MOTION_STATES.stop}>停止 / 固定机位</option>
          <option value={KEYFRAME_MOTION_STATES.rotationOnly}>原地旋转</option>
          <option value={KEYFRAME_MOTION_STATES.unknown}>运动待判定</option>
        </select></label>
        <label className="editor-span-2"><span>区间起点 → 终点（仅区间模式）</span><div className="reconstruction-review-inline-fields"><input value={form.intervalStart} onChange={updateForm('intervalStart')} disabled={readOnly} placeholder="起点" /><input value={form.intervalEnd} onChange={updateForm('intervalEnd')} disabled={readOnly} placeholder="终点" /></div></label>
        <label className="editor-span-2"><span>相对位置说明（仅相对模式）</span><input value={form.relativeNote} onChange={updateForm('relativeNote')} disabled={readOnly} placeholder="如：转弯后第二个岔路口" /></label>
      </div>
      <div className="reconstruction-review-editor-subheading">相机当前行进方向下的左 / 中 / 右</div>
      <div className="reconstruction-review-editor-grid camera-editor-grid">
        <label><span>左侧</span><input value={form.cameraLeft} onChange={updateForm('cameraLeft')} disabled={readOnly} placeholder="画面左侧" /></label>
        <label><span>中央</span><input value={form.cameraCenter} onChange={updateForm('cameraCenter')} disabled={readOnly} placeholder="行进方向 / 视线" /></label>
        <label><span>右侧</span><input value={form.cameraRight} onChange={updateForm('cameraRight')} disabled={readOnly} placeholder="画面右侧" /></label>
        <label className="editor-span-2"><span>左右关系参照</span><input value={form.cameraReference} onChange={updateForm('cameraReference')} disabled={readOnly} placeholder="camera_travel_direction" /></label>
      </div>
      <div className="reconstruction-review-editor-subheading">与相邻帧相比的变化</div>
      <div className="reconstruction-review-editor-grid">
        <label className="editor-span-2"><span>相对上一帧</span><textarea rows="2" value={form.changeFromPrevious} onChange={updateForm('changeFromPrevious')} disabled={readOnly} placeholder="位置、遮挡、道路或左右环境变化" /></label>
        <label className="editor-span-2"><span>相对下一帧</span><textarea rows="2" value={form.changeToNext} onChange={updateForm('changeToNext')} disabled={readOnly} placeholder="下一帧将出现或消失的关系" /></label>
      </div>
      {rotationStationMissing && <p className="reconstruction-review-editor-warning"><AlertTriangle size={13} />原地旋转必须填写明确站点标识，并由用户明确确认合法站点；当前不能保存。</p>}
      <div className="reconstruction-review-editor-actions"><button type="submit" disabled={readOnly || rotationStationMissing}><Map size={13} />保存定位编辑</button>{saveMessage && <span role="status">{saveMessage}</span>}</div>
    </form>
    {!readOnly && <div className="reconstruction-review-status-actions" role="group" aria-label={`关键帧 ${frame.id} 确认状态`} onClick={stopPropagation}>
      <button type="button" className={currentState === KEYFRAME_REVIEW_STATES.confirmed ? 'active' : ''} onClick={() => setStatus(KEYFRAME_REVIEW_STATES.confirmed)}><Check size={13} />确认可用于建模</button>
      <button type="button" className={currentState === KEYFRAME_REVIEW_STATES.corrected ? 'active' : ''} onClick={() => setStatus(KEYFRAME_REVIEW_STATES.corrected)}>已修正后采用</button>
      <button type="button" className={currentState === KEYFRAME_REVIEW_STATES.pending ? 'active' : ''} onClick={() => setStatus(KEYFRAME_REVIEW_STATES.pending)}>保留待确认</button>
      <button type="button" className={currentState === KEYFRAME_REVIEW_STATES.rejected ? 'active danger' : ''} onClick={() => setStatus(KEYFRAME_REVIEW_STATES.rejected)}><XCircle size={13} />不采用</button>
    </div>}
  </div>;
}

function KeyframeRow({ frame, index, expanded, onExpand, onUpdateFrame, readOnly, thumbnailUrlResolver, thumbnailBaseUrl }) {
  return <>
    <tr className={`${expanded ? 'expanded' : ''} ${frame.uncertainty ? 'uncertain' : ''}`}>
      <td className="frame-index"><button type="button" onClick={() => onExpand(frame.id)} aria-expanded={expanded} aria-label={`${expanded ? '收起' : '展开'}关键帧 ${frame.id}`}>{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}<b>{index + 1}</b></button></td>
      <td><strong>{frame.sourceName}</strong><small>{frame.timestampLabel}{frame.frameNumber === null ? '' : ` · 帧 ${frame.frameNumber}`}</small></td>
      <td><span className={`location-chip mode-${frame.location.mode}`} title={frame.locationLabel}>{frame.locationLabel}</span>{frame.uncertainty && <small className="uncertainty-note"><AlertTriangle size={11} />不得伪造精确点位</small>}</td>
      <td><MotionBadge motion={frame.motion} /></td>
      <td><div className="camera-summary"><span title="左侧">L · {frame.camera.left}</span><span title="中央">C · {frame.camera.center}</span><span title="右侧">R · {frame.camera.right}</span></div></td>
      <td><ReviewStateBadge state={frame.reviewState} /><small className={`confidence-${frame.confidence}`}>{frame.evidenceLevelLabel} · 置信度 {frame.confidenceLabel}</small></td>
      <td><button type="button" className="reconstruction-review-open-button" onClick={() => onExpand(frame.id)}>{expanded ? '收起' : '查看'}</button></td>
    </tr>
    {expanded && <tr className="frame-detail-row"><td colSpan="7"><KeyframeDetail frame={frame} onUpdateFrame={onUpdateFrame} readOnly={readOnly} thumbnailUrlResolver={thumbnailUrlResolver} thumbnailBaseUrl={thumbnailBaseUrl} /></td></tr>}
  </>;
}

export function TemporaryReviewLayerPanel({ objects = [], visible = true, objectVisibility = {}, onToggleTemporaryLayer = noop, readOnly = false }) {
  const [expanded, setExpanded] = useState(true);
  const [localVisible, setLocalVisible] = useState(visible);
  useEffect(() => setLocalVisible(visible), [visible]);
  const list = Array.isArray(objects) ? objects : [];
  const toggleAll = () => {
    if (readOnly) return;
    const next = !localVisible;
    setLocalVisible(next);
    onToggleTemporaryLayer('__all__', next);
  };
  return <section className={`reconstruction-review-temporary ${localVisible ? 'visible' : 'hidden'}`} aria-label="临时审阅层">
    <div className="reconstruction-review-section-heading">
      <div><Eye size={15} aria-hidden="true" /><strong>临时审阅层</strong><span className="candidate-only-tag">不进入正式候选</span></div>
      <button type="button" className="reconstruction-review-disclosure" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>{expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {expanded ? '收起' : '展开'}</button>
    </div>
    <div className="reconstruction-review-boundary-note"><AlertTriangle size={14} aria-hidden="true" /><span>车辆、锥桶、临时标牌、施工物和未确认对象只在此层审阅；不会移动主楼、道路，也不会写入 active 正式模型。</span></div>
    {expanded && <>
      <div className="reconstruction-review-temporary-toolbar"><span>{list.length ? `${list.length} 个临时对象` : '当前没有临时对象记录'}</span><button type="button" onClick={toggleAll} disabled={readOnly || !list.length}>{localVisible ? <EyeOff size={13} /> : <Eye size={13} />}{localVisible ? '隐藏审阅层' : '显示审阅层'}</button></div>
      {list.length > 0 && <div className="reconstruction-review-temporary-list">{list.map((object, index) => {
        const objectId = String(object.id || object.objectId || `temporary-${index + 1}`);
        const state = getTemporaryObjectState(object);
        const objectVisible = isTemporaryObjectVisible(object, { layerVisible: localVisible, objectVisibility });
        const configuredVisible = isTemporaryObjectVisible(object, { layerVisible: true, objectVisibility });
        return <div className={`reconstruction-review-temporary-row ${objectVisible ? '' : 'muted'}`} key={objectId}>
          <button type="button" className="temporary-visibility-toggle" aria-label={`${objectVisible ? '隐藏' : '显示'} ${object.label || object.name || objectId}`} onClick={() => { if (readOnly) return; onToggleTemporaryLayer(objectId, !configuredVisible); }} disabled={readOnly}>{objectVisible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
          <div><strong>{object.label || object.name || objectId}</strong><small>{object.type || object.category || '未分类'} · {object.source || object.sourceAssetName || '来源未记录'}</small></div>
          <span className={`temporary-state state-${state}`}>{formatTemporaryObjectState(state)}</span>
        </div>;
      })}</div>}
    </>}
  </section>;
}

/**
 * Reusable confirmation card for one moving-video scene.
 *
 * `onUpdateFrame(frameId, patch, nextLedger)` is called optimistically for
 * each status change. `onConfirm(nextLedger)` is intentionally separate so
 * the host can persist an explicit operator confirmation before modeling.
 */
export function KeyframeReviewPanel({
  ledger,
  onConfirm = noop,
  onUpdateFrame = noop,
  onToggleTemporaryLayer = noop,
  mapImageUrl,
  temporaryLayerVisible = true,
  temporaryLayerObjectVisibility = {},
  thumbnailUrlResolver,
  thumbnailBaseUrl = '',
  contactSheetUrlResolver,
  readOnly = false,
  className = '',
  emptyMessage = '当前场景尚未生成关键帧确认记录。'
}) {
  const [draftLedger, setDraftLedger] = useState(ledger || null);
  const [selectedFrameId, setSelectedFrameId] = useState('');
  const [expandedFrameId, setExpandedFrameId] = useState('');
  useEffect(() => {
    setDraftLedger(ledger || null);
    const first = normalizeLedgerForDisplay(ledger).keyframes[0];
    setSelectedFrameId((current) => current || first?.id || '');
    setExpandedFrameId((current) => current && normalizeLedgerForDisplay(ledger).keyframes.some((frame) => frame.id === current) ? current : '');
  }, [ledger]);

  const display = useMemo(() => normalizeLedgerForDisplay(draftLedger), [draftLedger]);
  const gate = useMemo(() => reviewGateStatus(draftLedger), [draftLedger]);
  const selectedFrame = display.keyframes.find((frame) => frame.id === selectedFrameId) || display.keyframes[0] || null;
  const contactSheets = [...new Map(display.keyframes.map((frame) => [frame.sourceId, frame])).values()]
    .map((frame) => ({ sourceId: frame.sourceId, sourceName: frame.sourceName, url: typeof contactSheetUrlResolver === 'function' ? contactSheetUrlResolver(frame.sourceId, frame) : '' }))
    .filter((item) => item.url);

  const commitFrame = (frameId, patch) => {
    if (readOnly) return;
    const nextLedger = updateKeyframe(draftLedger, frameId, patch);
    setDraftLedger(nextLedger);
    onUpdateFrame(frameId, patch, nextLedger);
  };

  if (!draftLedger || !display.keyframes.length) {
    return <section className={`reconstruction-review-panel empty ${className}`} aria-label="移动视频关键帧确认卡"><div className="reconstruction-review-empty"><Video size={22} /><strong>{emptyMessage}</strong><span>先完成密集采样和逐帧定位，再允许进入候选建模。</span></div></section>;
  }

  return <section className={`reconstruction-review-panel ${className}`} aria-label={`${display.title} · 逐关键帧确认`}>
    <header className="reconstruction-review-header">
      <div className="reconstruction-review-title-block"><span className="reconstruction-review-eyebrow">移动视频 · 逐帧确认卡</span><h2>{display.title}</h2><p>每个采用帧都必须单独说明地图位置；移动、转弯和原地旋转不合并成一个静态点。</p></div>
      <div className="reconstruction-review-baseline"><span>唯一候选基准</span><strong>{display.candidateKey}</strong><small>只写入候选审阅流程；active 正式模型不变</small></div>
    </header>
    <div className="reconstruction-review-summary-row"><GateSummary gate={gate} /><div className="reconstruction-review-summary-chips"><span><Video size={13} />{new Set(display.keyframes.map((frame) => frame.sourceId)).size} 个视频源</span><span><Route size={13} />{display.keyframes.length} 个独立关键帧</span><span className={gate.uncertain ? 'chip-warning' : ''}><AlertTriangle size={13} />{gate.uncertain} 个位置不确定</span></div></div>
    <KeyframeMiniMap ledger={display.raw} frames={display.keyframes} mapImageUrl={mapImageUrl} selectedFrameId={selectedFrame?.id || ''} onSelectFrame={(id) => { setSelectedFrameId(id); setExpandedFrameId(id); }} />
    {contactSheets.length > 0 && <section className="reconstruction-review-contact-sheets" aria-label="关键帧联系图"><div className="reconstruction-review-section-heading"><div><Video size={15} aria-hidden="true" /><strong>关键帧联系图</strong></div><small>每个视频源保留独立 dense 关键帧联系页；不合并为空间单点</small></div><div className="reconstruction-review-contact-links">{contactSheets.map((item) => <a key={item.sourceId} href={item.url} target="_blank" rel="noreferrer"><span>{item.sourceName || item.sourceId}</span><small>打开联系图</small></a>)}</div></section>}
    <section className="reconstruction-review-table-section" aria-label="逐关键帧表格">
      <div className="reconstruction-review-section-heading"><div><Video size={15} aria-hidden="true" /><strong>逐关键帧账本</strong></div><small>左右关系按相机当前行进方向，不复用截图屏幕坐标</small></div>
      <div className="reconstruction-review-table-scroll"><table className="reconstruction-review-table"><thead><tr><th scope="col">序号</th><th scope="col">视频 / 时间</th><th scope="col">导航位置</th><th scope="col">运动</th><th scope="col">左 / 中 / 右</th><th scope="col">确认状态</th><th scope="col"><span className="sr-only">操作</span></th></tr></thead><tbody>{display.keyframes.map((frame, index) => <KeyframeRow key={frame.id} frame={frame} index={index} expanded={expandedFrameId === frame.id} onExpand={(id) => setExpandedFrameId((current) => current === id ? '' : id)} onUpdateFrame={commitFrame} readOnly={readOnly} thumbnailUrlResolver={thumbnailUrlResolver} thumbnailBaseUrl={thumbnailBaseUrl} />)}</tbody></table></div>
    </section>
    {selectedFrame && <section className="reconstruction-review-focus" aria-label="当前关键帧详情"><div className="reconstruction-review-section-heading"><div><ShieldCheck size={15} aria-hidden="true" /><strong>当前帧复核</strong></div><button type="button" onClick={() => setExpandedFrameId(selectedFrame.id)}>{selectedFrame.id} · {selectedFrame.timestampLabel}</button></div><KeyframeDetail frame={selectedFrame} onUpdateFrame={commitFrame} readOnly={readOnly} thumbnailUrlResolver={thumbnailUrlResolver} thumbnailBaseUrl={thumbnailBaseUrl} /></section>}
    <TemporaryReviewLayerPanel objects={display.temporaryObjects} visible={temporaryLayerVisible} objectVisibility={temporaryLayerObjectVisibility} onToggleTemporaryLayer={onToggleTemporaryLayer} readOnly={readOnly} />
    <footer className="reconstruction-review-footer"><div><strong>确认门槛</strong><span>{gate.canConfirm ? '所有待确认帧已处理，可将本处关系交给建模阶段。' : '逐帧确认完成前，不得修改候选几何。'}</span></div><button type="button" className="reconstruction-review-confirm" disabled={readOnly || !gate.canConfirm} onClick={() => onConfirm(draftLedger)}><CheckCircle2 size={15} />{readOnly ? '只读审阅' : gate.canConfirm ? '确认本处关键帧，允许建模' : '等待逐帧确认'}</button></footer>
  </section>;
}

export default KeyframeReviewPanel;

