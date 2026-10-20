import { useEffect, useMemo, useRef, useState } from 'react';

/* 第三部分: 真实3D孪生场景 —— 幽灵化真模型 + 周边路况光柱 + 点路飞行 + 右侧详情栏
   数据: /data/amap-traffic-matrix.json (Observed) + /data/amap-road-anchors.json (配准落位) */

const STATE_COLORS = [
  { key: '畅通', hex: 0x4ade80, css: '#4ade80' },
  { key: '缓行', hex: 0xeab308, css: '#eab308' },
  { key: '拥堵', hex: 0xf59e0b, css: '#f59e0b' },
  { key: '严重拥堵', hex: 0xef4444, css: '#ef4444' }
];
const GROUND_Y = -15.41;
// 高清底图(595×421)上 8 条小路的采样点像素坐标（操作者标绘，与交付索引表底图 X/Y 一致）
const TWIN_ROAD_NEW_PX = {
  '小路1': [79, 400], '小路2': [136, 360], '小路3': [154, 407], '小路4': [144, 230],
  '小路5': [317, 79], '小路6': [481, 324], '小路7': [493, 249], '小路8': [522, 103]
};
// 预裁剪几何资产（丢贴图/材质，25MB->1.6MB）：由 tmp/clip_glb.py 从原资产生成
const MODEL_URL = '/models/twin-main.glb';
const MIDDLE_BUILDING_URL = '/models/twin-middle.glb';

function stateOf(cell) {
  if (!cell) return { key: '无数据', hex: 0x64748b, css: '#64748b', share: 0 };
  const entries = STATE_COLORS.map((s) => ({ ...s, n: cell.counts?.[s.key] || 0 }));
  const total = entries.reduce((sum, e) => sum + e.n, 0) || 1;
  const top = entries.reduce((a, b) => (b.n > a.n ? b : a), entries[0]);
  return { ...top, share: top.n / total, total, entries };
}

const AMAP_DAY_LABEL = {
  '2026-09-28': '节前·工作日1',
  '2026-09-29': '节前·工作日2',
  '2026-09-30': '节前·工作日3',
  '2026-10-01': '假期·第1天',
  '2026-10-02': '假期·第2天',
  '2026-10-04': '假期·第3天'
};

function roadAggregate(matrix, roadId) {
  const rows = matrix.matrix.filter((m) => m.road === roadId);
  const byState = { 畅通: 0, 缓行: 0, 拥堵: 0, 严重拥堵: 0 };
  const byDay = {};
  const byHour = {};
  rows.forEach((m) => {
    Object.entries(m.counts || {}).forEach(([k, v]) => { if (k in byState) byState[k] += v; });
    byDay[m.date] = (byDay[m.date] || 0) + (m.counts?.['缓行'] || 0) + (m.counts?.['拥堵'] || 0) + (m.counts?.['严重拥堵'] || 0);
    byHour[m.hour] = (byHour[m.hour] || 0) + (m.counts?.['拥堵'] || 0) + (m.counts?.['严重拥堵'] || 0) + (m.counts?.['缓行'] || 0) * 0.5;
  });
  const total = rows.reduce((sum, m) => sum + Object.values(m.counts || {}).reduce((a, b) => a + b, 0), 0) || 1;
  const noc = rows.reduce((sum, m) => sum + (m.counts?.['无路况颜色'] || 0), 0);
  const smooth = byState['畅通'] / Math.max(1, total - noc);
  const peakHour = Number(Object.entries(byHour).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 17);
  const worstDay = AMAP_DAY_LABEL[Object.entries(byDay).sort((a, b) => b[1] - a[1])[0]?.[0] || ''] || '—';
  const peakHourJam = Math.min(1, (byHour[peakHour] || 0) / Math.max(1, rows.filter((m) => m.hour === peakHour).reduce((s, m) => s + Object.values(m.counts || {}).reduce((a, b) => a + b, 0), 1) / 7));
  return { byState, total, smooth, peakHour, worstDay, byDay, peakJam: peakHourJam };
}

function bearingText(x, z) {
  // 场景 +x=东, +z=南
  const dirs = [['东', x > 8], ['西', x < -8], ['南', z > 8], ['北', z < -8]].filter(([, on]) => on).map(([t]) => t);
  return dirs.length ? `主楼${dirs.join('')}` : '主楼上方';
}

export default function AmapTwinScene() {
  const mountRef = useRef(null);
  const labelLayerRef = useRef(null);
  const rtRef = useRef(null);
  const [matrix, setMatrix] = useState(null);
  const [anchors, setAnchors] = useState(null);
  const [showOutOfRange, setShowOutOfRange] = useState(false);
  const [hour, setHour] = useState(17);
  const [selected, setSelected] = useState(null);
  const [loadMsg, setLoadMsg] = useState('正在加载真实三维场景…');
  const [failed, setFailed] = useState(false);
  const [rtReady, setRtReady] = useState(0);
  const [playing, setPlaying] = useState(false);
  const hourRef = useRef(17);
  const selectedRef = useRef(null);
  const selectRef = useRef(null);
  hourRef.current = hour;
  selectedRef.current = selected;
  selectRef.current = setSelected;

  useEffect(() => {
    let alive = true;
    fetch('/data/amap-traffic-matrix.json').then((r) => r.json()).then((j) => { if (alive) setMatrix(j); }).catch(() => {});
    fetch('/data/amap-road-anchors.json').then((r) => r.json()).then((j) => { if (alive) setAnchors(j); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  /* ---------- three.js 初始化 ---------- */
  useEffect(() => {
    let disposed = false;
    const mount = mountRef.current;
    if (!mount) return undefined;

    (async () => {
      try {
        const THREE = await import('three');
        const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        if (disposed || !mountRef.current) return;

        const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x05070d, 1);
        mount.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.fog = new THREE.Fog(0x05070d, 320, 760);
        const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 1600);
        camera.position.set(185, 135, 205);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.target.set(0, -6, 0);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.maxPolarAngle = Math.PI / 2 - 0.05;
        controls.minDistance = 24;
        controls.maxDistance = 560;

        // 地面 + 灯
        const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 48), new THREE.MeshBasicMaterial({ color: 0x060b13 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = GROUND_Y - 0.25;
        scene.add(ground);
        scene.add(new THREE.AmbientLight(0x8fb4d8, 0.85));
        const dir = new THREE.DirectionalLight(0xbfdcff, 0.7);
        dir.position.set(120, 180, 90);
        scene.add(dir);

        // 环路流光 (沿矩形环移动的光点)
        const ringGroup = new THREE.Group();
        scene.add(ringGroup);
        const ringRect = { xMin: -98.3, xMax: 92.7, zMin: -70.8, zMax: 71.8 };
        const ringPath = [];
        const w = ringRect.xMax - ringRect.xMin, h = ringRect.zMax - ringRect.zMin;
        for (let t = 0; t < w; t += 4) ringPath.push(new THREE.Vector3(ringRect.xMin + t, GROUND_Y + 0.4, ringRect.zMin));
        for (let t = 0; t < h; t += 4) ringPath.push(new THREE.Vector3(ringRect.xMax, GROUND_Y + 0.4, ringRect.zMin + t));
        for (let t = 0; t < w; t += 4) ringPath.push(new THREE.Vector3(ringRect.xMax - t, GROUND_Y + 0.4, ringRect.zMax));
        for (let t = 0; t < h; t += 4) ringPath.push(new THREE.Vector3(ringRect.xMin, GROUND_Y + 0.4, ringRect.zMax - t));
        const flowCount = 46;
        const flowGeo = new THREE.BufferGeometry();
        flowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flowCount * 3), 3));
        const flowPts = new THREE.Points(flowGeo, new THREE.PointsMaterial({ color: 0x67e8f9, size: 1.6, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
        flowPts.frustumCulled = false;
        ringGroup.add(flowPts);
        const flowState = { path: ringPath, offset: 0, per: ringPath.length / flowCount };

        // 幽灵模型
        setLoadMsg('正在下载真实模型…');
        const gltf = await new Promise((resolve, reject) => new GLTFLoader().load(MODEL_URL, resolve, undefined, reject));
        if (disposed) return;
        const model = gltf.scene;
        const box = new THREE.Box3().setFromObject(model);
        const modelCenter = box.getCenter(new THREE.Vector3());
        model.position.sub(new THREE.Vector3(modelCenter.x, 0, modelCenter.z));
        scene.add(model);
        model.updateMatrixWorld(true);

        let edgeCount = 0;
        const windowPts = [];
        const ghostify = (root) => root.traverse((child) => {
          if (!child.isMesh) return;
          const geo = child.geometry;
          geo.computeBoundingBox();
          const size = new THREE.Vector3();
          geo.boundingBox.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z);
          const isMain = maxDim > 45;
          child.material = new THREE.MeshBasicMaterial({
            color: isMain ? 0x2a4a73 : maxDim > 8 ? 0x101c2c : 0x0c1522,
            transparent: true, opacity: isMain ? 0.42 : maxDim > 8 ? 0.28 : 0.16, depthWrite: false
          });
          child.renderOrder = 2;
          if (maxDim > 7 && edgeCount < 900) {
            const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 22), new THREE.LineBasicMaterial({ color: isMain ? 0x9fd8ff : 0x6fb6e8, transparent: true, opacity: isMain ? 0.9 : 0.4 }));
            edges.applyMatrix4(child.matrixWorld);
            edges.renderOrder = 3;
            scene.add(edges);
            edgeCount += 1;
          }
          if (isMain) {
            geo.computeBoundingSphere();
            const c = geo.boundingSphere.center.clone().applyMatrix4(child.matrixWorld);
            for (let i = 0; i < 14; i += 1) {
              windowPts.push(new THREE.Vector3(
                c.x + (Math.random() - 0.5) * size.x * 0.9,
                c.y + (Math.random() - 0.5) * size.y * 0.85,
                c.z + (Math.random() - 0.5) * size.z * 0.9
              ));
            }
          }
        });
        ghostify(model);
        // 中间建筑②（EVIDENCE_BUILDING_02）：主模型 GLB 里缺失，单独从导入资产补齐
        try {
          setLoadMsg('正在补充中间建筑②…');
          const midGltf = await new Promise((resolve, reject) => new GLTFLoader().load(MIDDLE_BUILDING_URL, resolve, undefined, reject));
          if (disposed) return;
          const midRoot = midGltf.scene.getObjectByName('EVIDENCE_BUILDING_02') || midGltf.scene;
          midRoot.position.sub(new THREE.Vector3(modelCenter.x, 0, modelCenter.z));
          scene.add(midRoot);
          midRoot.updateMatrixWorld(true);
          ghostify(midRoot);
        } catch { /* 中间楼资产缺失时不阻塞主场景 */ }
        if (windowPts.length) {
          const wg = new THREE.BufferGeometry().setFromPoints(windowPts);
          const stars = new THREE.Points(wg, new THREE.PointsMaterial({ color: 0xffd9a0, size: 0.55, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
          stars.frustumCulled = false;
          scene.add(stars);
        }
        setLoadMsg('');

        // 光柱 (锚点到达后由另一个 effect 填充)
        const beaconGroup = new THREE.Group();
        scene.add(beaconGroup);

        // DOM 标签
        const labelLayer = labelLayerRef.current;
        const labelEls = new Map();

        const rt = { THREE, renderer, scene, camera, controls, beaconGroup, labelLayer, labelEls, flowPts, flowState, model,
          tween: null, raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2() };
        rtRef.current = rt;
        if (typeof window !== 'undefined') window.__amapTwin = rt;

        const resize = () => {
          const el = mountRef.current;
          if (!el) return;
          const w0 = el.clientWidth || 800;
          const h0 = el.clientHeight || 520;
          renderer.setSize(w0, h0, false);
          camera.aspect = w0 / h0;
          camera.updateProjectionMatrix();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(mount);

        let raf = 0;
        const clock = new THREE.Clock();
        const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
        const animate = () => {
          raf = requestAnimationFrame(animate);
          if (disposed) return;
          const dt = Math.min(0.05, clock.getDelta());
          // 流光推进
          rt.flowState.offset = (rt.flowState.offset + dt * 9) % rt.flowState.path.length;
          const posAttr = rt.flowPts.geometry.attributes.position;
          for (let i = 0; i < flowCount; i += 1) {
            const p = rt.flowState.path[Math.floor(rt.flowState.offset + i * rt.flowState.per) % rt.flowState.path.length];
            posAttr.setXYZ(i, p.x, p.y, p.z);
          }
          posAttr.needsUpdate = true;
          // 相机 tween
          if (rt.tween) {
            const tw = rt.tween;
            const t = Math.min(1, (performance.now() - tw.t0) / tw.dur);
            const k = easeInOut(t);
            camera.position.lerpVectors(tw.fromP, tw.toP, k);
            controls.target.lerpVectors(tw.fromT, tw.toT, k);
            if (t >= 1) rt.tween = null;
          }
          controls.update();
          renderer.render(scene, camera);
          // 标签投影
          if (labelLayer) {
            const w1 = mountRef.current?.clientWidth || 1;
            const h1 = mountRef.current?.clientHeight || 1;
            labelEls.forEach((el, id) => {
              const b = rt.beacons.get(id);
              if (!b) return;
              const v = b.top.clone().project(camera);
              const vis = v.z < 1 && (b.anchor.inModel !== false || showOutOfRange);
              el.style.display = vis ? 'flex' : 'none';
              if (vis) {
                el.style.left = `${((v.x + 1) / 2) * w1}px`;
                el.style.top = `${((1 - v.y) / 2) * h1}px`;
              }
            });
          }
        };
        animate();

        // 点击拾取
        const onClick = (event) => {
          const rect = renderer.domElement.getBoundingClientRect();
          rt.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
          rt.raycaster.setFromCamera(rt.pointer, camera);
          const cylinders = [];
          rt.beacons.forEach((b) => cylinders.push(b.hit));
          const hits = rt.raycaster.intersectObjects(cylinders, false);
          selectRef.current?.(hits.length ? hits[0].object.userData.roadId : null);
        };
        renderer.domElement.addEventListener('click', onClick);

        rt.dispose = () => {
          cancelAnimationFrame(raf);
          ro.disconnect();
          renderer.domElement.removeEventListener('click', onClick);
          controls.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
        setRtReady((v) => v + 1);
        setLoadMsg('');
      } catch (error) {
        if (!disposed) { setFailed(true); setLoadMsg(`三维场景加载失败：${error?.message || '未知错误'}`); }
      }
    })();

    return () => {
      disposed = true;
      if (rtRef.current?.dispose) rtRef.current.dispose();
      rtRef.current = null;
    };
  }, []);

  /* ---------- 光柱构建 (锚点) ---------- */
  useEffect(() => {
    const rt = rtRef.current;
    if (!rtReady || !rt || !anchors) return;
    const { THREE, beaconGroup, labelLayer, labelEls } = rt;
    beaconGroup.children.slice().forEach((c) => { beaconGroup.remove(c); });
    labelEls.forEach((el) => el.remove());
    labelEls.clear();
    rt.beacons = new Map();
    anchors.points.forEach((p) => {
      if (p.excluded) return; // 小路9~14 距主楼较远，剔除（用户拍板）
      const [x, z] = p.local;
      p.inModel = p.inModel !== false;
      const mat = new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 26, 12, 1, true), mat);
      cyl.position.set(x, GROUND_Y + 13, z);
      cyl.userData.roadId = p.id;
      cyl.renderOrder = 10;
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 26, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      cyl.add(core);
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(5.5, 5.5, 30, 8), new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.set(x, GROUND_Y + 14, z);
      hit.userData.roadId = p.id;
      beaconGroup.add(hit);
      beaconGroup.add(cyl);
      const el = document.createElement('div');
      el.className = 'twin-label';
      el.textContent = p.name;
      labelLayer.appendChild(el);
      labelEls.set(p.id, el);
      rt.beacons.set(p.id, { cyl, mat, hit, top: new THREE.Vector3(x, GROUND_Y + 27, z), anchor: p });
    });
  }, [anchors, rtReady]);


  /* ---------- 建模范围外的点：默认隐藏 ---------- */
  useEffect(() => {
    const rt = rtRef.current;
    if (!rtReady || !rt?.beacons || !anchors) return;
    rt.beacons.forEach((b, id) => {
      const inModel = b.anchor.inModel !== false;
      const vis = inModel || showOutOfRange;
      b.cyl.visible = vis;
      b.hit.visible = vis;
    });
  }, [showOutOfRange, anchors, rtReady]);

  /* ---------- 时点 -> 光柱颜色 ---------- */
  useEffect(() => {
    const rt = rtRef.current;
    if (!rtReady || !rt?.beacons || !matrix) return;
    rt.beacons.forEach((b, id) => {
      const rows = matrix.matrix.filter((m) => m.road === id && m.hour === hour);
      const agg = rows.reduce((acc, m) => {
        Object.entries(m.counts || {}).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + v; });
        return acc;
      }, {});
      const st = stateOf({ counts: agg });
      b.mat.color.setHex(st.hex);
      b.mat.opacity = 0.5 + st.share * 0.45;
      b.st = st;
      const el = rt.labelEls.get(id);
      if (el) { el.textContent = `${b.anchor.name} · ${st.key}`; el.style.borderColor = st.css; el.style.color = st.css; }
    });
  }, [hour, matrix, anchors, rtReady]);

  /* ---------- 选中 -> 高亮 + 飞行 ---------- */
  useEffect(() => {
    const rt = rtRef.current;
    if (!rtReady || !rt?.beacons) return;
    rt.beacons.forEach((b, id) => {
      const on = id === selected;
      b.cyl.scale.set(on ? 1.7 : 1, 1, on ? 1.7 : 1);
      b.mat.opacity = on ? 0.95 : 0.5 + (b.st?.share || 0) * 0.45;
    });
    const focus = selected ? rt.beacons.get(selected) : null;
    const fromP = rt.camera.position.clone();
    const fromT = rt.controls.target.clone();
    const toP = focus
      ? new (rt.THREE.Vector3)(focus.cyl.position.x * 0.72 + 30, GROUND_Y + 26, focus.cyl.position.z * 0.72 + 38)
      : new (rt.THREE.Vector3)(185, 135, 205);
    const toT = focus ? new (rt.THREE.Vector3)(focus.cyl.position.x, GROUND_Y + 8, focus.cyl.position.z) : new (rt.THREE.Vector3)(0, -6, 0);
    rt.tween = { t0: performance.now(), dur: 1200, fromP, fromT, toP, toT };
  }, [selected, rtReady]);

  /* ---------- 事件联动 ---------- */
  useEffect(() => {
    const onPick = (e) => { if (e.detail?.source !== 'twin') setSelected(e.detail?.roadId || null); };
    const onHour = (e) => {
      if (e.detail?.source === 'twin' || !Number.isFinite(e.detail?.hour)) return;
      if (e.detail?.source === 'rhythm') setPlaying(false); // 用户手动拖动 -> 停掉自动播放，避免来回跳
      setHour(Math.max(0, Math.min(23, Math.round(e.detail.hour))));
    };
    window.addEventListener('amap-road-picked', onPick);
    window.addEventListener('amap-hour-sync', onHour);
    return () => { window.removeEventListener('amap-road-picked', onPick); window.removeEventListener('amap-hour-sync', onHour); };
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('amap-hour-sync', { detail: { hour, source: 'twin' } }));
  }, [hour]);
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setHour((h) => (h + 1) % 24), 1500);
    return () => clearInterval(timer);
  }, [playing]);

  /* ---------- 右栏九卡数据 ---------- */
  const roadIds = anchors ? anchors.points.filter((p) => !p.excluded).map((p) => p.id) : [];
  const excludedIds = anchors ? new Set(anchors.points.filter((p) => p.excluded).map((p) => p.id)) : new Set();
  const agg = useMemo(() => {
    if (!matrix || !anchors) return null;
    const stats = {};
    anchors.points.forEach((p) => { if (!p.excluded) stats[p.id] = roadAggregate(matrix, p.id); });
    const ranking = anchors.points.filter((p) => !p.excluded).map((p) => ({ id: p.id, name: p.name, smooth: stats[p.id].smooth })).sort((a, b) => b.smooth - a.smooth);
    const byId = new Map(ranking.map((r, i) => [r.id, { rank: i + 1, smooth: r.smooth }]));
    const hourRows = matrix.matrix.filter((m) => m.hour === hour && !excludedIds.has(m.road));
    const worstAtHour = hourRows.reduce((worst, m) => {
      const jam = (m.counts?.['拥堵'] || 0) + (m.counts?.['严重拥堵'] || 0);
      return jam > worst.jam ? { road: m.road, jam } : worst;
    }, { road: null, jam: -1 });
    return { stats, byId, ranking, worstAtHour };
  }, [matrix, anchors, hour]);

  const selInfo = selected && anchors ? anchors.points.find((p) => p.id === selected) : null;
  const selAgg = selected && agg ? agg.stats[selected] : null;
  const selHourStates = useMemo(() => {
    if (!matrix || !selected) return null;
    const rows = matrix.matrix.filter((m) => m.road === selected && m.hour === hour);
    const aggH = {};
    rows.forEach((m) => Object.entries(m.counts || {}).forEach(([k, v]) => { aggH[k] = (aggH[k] || 0) + v; }));
    const total = Object.values(aggH).reduce((a, b) => a + b, 0) || 1;
    return STATE_COLORS.map((s) => ({ ...s, n: aggH[s.key] || 0, share: (aggH[s.key] || 0) / total }));
  }, [matrix, selected, hour]);

  return (
    <section className="amap-twin-section" aria-label="真实3D孪生场景">
      <div className="retrofit-wipe-head">
        <div><span className="amap-rhythm-kicker">03 / LIVE TWIN SCENE</span><h2>真实孪生 · 周边路况 <em>高德实测驱动 · OBSERVED</em></h2></div>
        <em className="wipe-badge">真模型幽灵化 · 8 采样点配准落位（9~14 距主楼较远已剔除）</em>
      </div>
      <details className="twin-calibration">
        <summary>标定对照 · 8 采样点位置（高清底图 595×421 · 小路9~14 已剔除不标注 · 点击展开）</summary>
        {anchors && (
          <div className="twin-cal-body">
            <div className="twin-cal-map">
              <img src="/evidence/amap-delivery-20261005/amap-road-index-annotated-clear.png?v=20261020" alt="设计院周边高清底图，标注小路1到小路8采样点" draggable={false} />
              {anchors.points.map((p) => {
                const np = TWIN_ROAD_NEW_PX[p.name];
                if (p.excluded || !np) return null;
                return (
                  <span key={p.id} className="twin-cal-pin" style={{ left: `${(np[0] / 595) * 100}%`, top: `${(np[1] / 421) * 100}%` }}>
                    <i>{p.name.replace('小路', '')}</i>
                    <em>✓参与定位 · {p.trueDistanceM}m</em>
                  </span>
                );
              })}
            </div>
            <p className="twin-cal-note">
              上图 = 高清周边底图（595×421，操作者标绘，8 个编号点 = 各小路采样位置，与交付索引表底图 X/Y 一致）。小路9~14 距主楼超过 128m、超出建模范围，经操作者确认剔除，此图不再标注。
              场景中光柱编号与此图编号一一对应；若某条路的位置与实际不符，报编号即可单点修正。
            </p>
          </div>
        )}
      </details>
      <div className="twin-layout">
        <div className="twin-stage" ref={mountRef}>
          <div className="twin-labels" ref={labelLayerRef} />
          {loadMsg && <div className="twin-loading">{loadMsg}</div>}
          <div className="twin-hud">
            <span>TONGJI DESIGN GROUP · GHOST TWIN</span>
            <strong>{String(hour).padStart(2, '0')}:00 实测路况</strong>
            <small>方位落位: 主楼锚点实测配准 · 真实地理方位 · 真实距离见右栏</small>
          </div>
        </div>
        <aside className="twin-rail">
          <div className="twin-card twin-card-hero">
            {selInfo ? (
              <>
                <small>选中采样点 · {bearingText(selInfo.local[0], selInfo.local[1])} · 距主楼约 {selInfo.trueDistanceM}m</small>
                <h3>{selInfo.name}</h3>
                <strong style={{ color: selHourStates?.find((s) => s.share === Math.max(...selHourStates.map((x) => x.share)))?.css }}>
                  {String(hour).padStart(2, '0')}:00 {selHourStates ? stateOf({ counts: Object.fromEntries(selHourStates.map((s) => [s.key, Math.round(s.n)])) }).key : ''}
                </strong>
              </>
            ) : <><small>实时路况孪生</small><h3>点击光柱查看道路</h3><strong>拖动旋转 · 滚轮缩放 · 点击空白返回全景</strong></>}
          </div>
          <div className="twin-card">
            <small>当前时点四态构成 {selInfo ? `· ${selInfo.name}` : '· 全场景'}</small>
            {(selHourStates || STATE_COLORS.map((s) => ({ ...s, n: 0, share: 0 }))).map((s) => (
              <div className="twin-bar-row" key={s.key} title={`${s.key} ${Math.round(s.n)} 次（该小时 6 天合并）`}>
                <span>{s.key}</span>
                <i><b style={{ width: `${s.share * 100}%`, minWidth: s.share > 0 ? 2 : 0, background: s.css }} /></i>
                <em>{(s.share * 100).toFixed(1)}%</em>
              </div>
            ))}
            {!selInfo && <p className="twin-note">未选中道路时显示 0 基线；选中后为该路该小时 6 天合并构成，占比保留 1 位小数。</p>}
          </div>
          <div className="twin-card">
            <small>{selInfo ? `${selInfo.name} · 全期指标` : '全场景 · 实测概览'}</small>
            {selInfo && selAgg ? (
              <div className="twin-kv">
                <div><span>全期畅通率</span><strong>{(selAgg.smooth * 100).toFixed(2)}%</strong></div>
                <div><span>8 路排名</span><strong>No.{agg.byId.get(selected)?.rank}</strong></div>
                <div><span>高峰时段</span><strong>{String(selAgg.peakHour).padStart(2, '0')}:00 前后</strong></div>
                <div><span>最差一天</span><strong>{selAgg.worstDay}</strong></div>
              </div>
            ) : (
              <div className="twin-kv">
                <div><span>监测窗口</span><strong>国庆前后 · 6天</strong></div>
                <div><span>样本总量</span><strong>666,632</strong></div>
                <div><span>采样点</span><strong>14 路 · 定位 8 条</strong></div>
                <div><span>证据等级</span><strong>Observed</strong></div>
              </div>
            )}
          </div>
          {selInfo && selAgg && (
            <div className="twin-card">
              <small>六天逐日非畅通样本 · {selInfo.name}</small>
              <div className="twin-days">
                {Object.entries(selAgg.byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => {
                  const maxN = Math.max(1, ...Object.values(selAgg.byDay));
                  return <div key={day}><i><b style={{ height: `${Math.max(6, Math.round(n / maxN * 44))}px` }} /></i><span>{AMAP_DAY_LABEL[day] || day.slice(5)}</span></div>;
                })}
              </div>
            </div>
          )}
          <div className="twin-card">
            <small>8 路畅通率横向对比（9~14 已剔除）</small>
            <div className="twin-rank">
              {agg ? agg.ranking.map((r) => (
                <button type="button" key={r.id} className={r.id === selected ? 'on' : ''} onClick={() => setSelected(selected === r.id ? null : r.id)}>
                  <span>{r.name}</span>
                  <i><b style={{ width: `${Math.round(r.smooth * 100)}%`, background: r.smooth > 0.97 ? '#4ade80' : r.smooth > 0.9 ? '#eab308' : '#f59e0b' }} /></i>
                  <em>{(r.smooth * 100).toFixed(2)}%</em>
                </button>
              )) : <p className="twin-note">数据加载中…</p>}
            </div>
          </div>
          <div className="twin-card">
            <small>当前时点全场景最拥堵</small>
            <strong className="twin-worst">{agg?.worstAtHour?.road ? `${anchors.points.find((p) => p.id === agg.worstAtHour.road)?.name} · 拥堵+严重 ${agg.worstAtHour.jam} 次` : '—'}</strong>
            <p className="twin-note">基于 6 天同小时合并 · {String(hour).padStart(2, '0')}:00</p>
          </div>
          <div className="twin-card">
            <small>配准口径</small>
            <p className="twin-note">采样点像素取自监测器 config(高德标定图 1440×900, zoom17)，经 GCJ→WGS→ENU 换算、以主楼实测足迹中心锚定；小路9~14 距主楼较远剔除。模型: asset_a98b0182ed4e · 几何零修改 · 幽灵表现层 Derived。</p>
          </div>
        </aside>
      </div>
      <div className="twin-slider">
        <span>TIME OF DAY</span>
        <input type="range" min="0" max="23" value={hour} aria-label="孪生场景时间滑杆"
          onChange={(e) => setHour(Number(e.target.value))} />
        <strong>{String(hour).padStart(2, '0')}:00</strong>
        <button type="button" className={playing ? 'on' : ''} onClick={() => setPlaying((v) => !v)}>{playing ? '⏸ 停止播放' : '▶ 播放全天'}</button>
        <small>与第一部分节奏图双向联动</small>
      </div>
    </section>
  );
}

