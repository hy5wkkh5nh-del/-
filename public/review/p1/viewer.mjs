import * as THREE from 'three';
import { OrbitControls } from '/vendor/addons/controls/OrbitControls.js';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';
const $ = (id) => document.getElementById(id);
const ui = { viewport: $('viewport'), loading: $('loading'), title: $('loading-title'), detail: $('loading-detail'), retry: $('retry'), quality: $('quality'), envelope: $('envelope') };
const state = { ready: false, mode: 'candidate', quality: true, view: 'overall', data: null, error: null };
let renderer, scene, camera, controls, assembly, skp, sample, envelope, data;
const stageMain = [], treeRoots = new Map(), materialChanges = [];
const captions = {
  legacy: ['原装配对照', '阶段3外观层与SKP同时显示，SKP沿用原平移。只重现装配关系；没有复刻旧页面的材质覆写和运行时剪裁。'],
  candidate: ['单一主楼候选', '关闭明确列出的71个阶段3主楼外观件，保留与原装配相同的1037个SKP可见构件；按既有导航包络对中。底层构件归属、道路衔接仍待核对。'],
  stage: ['阶段3单独对照', '隐藏SKP，单独查看阶段3楼体。它仍是历史简模，不表示比SKP更准确。']
};
const views = { overall: [[185, 140, 205], [9, -2, 25]], top: [[9, 290, 32], [9, -5, 32]], reverse: [[-175, 110, -185], [9, -2, 25]], sample: [[87, 29, -85], [41, -6, -36]], street: [[69, -10.8, -37], [23, -10.1, -36]] };
function render() { if (renderer && scene) { controls?.update(); renderer.render(scene, camera); } }
function resize() {
  if (!renderer) return;
  const { width, height } = ui.viewport.getBoundingClientRect(); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
}
function cameraView(name) {
  if (!views[name]) return;
  state.view = name; camera.position.fromArray(views[name][0]); controls.target.fromArray(views[name][1]);
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name))); render();
}
function makeTexture(kind) {
  const size = 256, canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(size, size); let seed = kind === 'road' ? 519 : 1537;
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const v = (seed / 4294967296 - .5) * (kind === 'road' ? 30 : 48), base = kind === 'road' ? [90, 94, 88] : [87, 109, 59];
    pixels.data[i] = base[0] + v; pixels.data[i + 1] = base[1] + v; pixels.data[i + 2] = base[2] + v; pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0); const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(kind === 'road' ? 80 : 50, 5); texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); return texture;
}
function installSample(library) {
  sample = new THREE.Group(); sample.name = 'P1_ENVIRONMENT_SAMPLE';
  const prototypes = ['P1_Tree_A', 'P1_Tree_B'].map((name) => library.getObjectByName(name));
  if (prototypes.some((p) => !p)) throw new Error('样板树资源不完整');
  for (const [i, item] of data.sampleTrees.entries()) {
    if (!treeRoots.has(item.id)) throw new Error('缺少既有树落点：' + item.id);
    const tree = prototypes[i % 2].clone(true), box = new THREE.Box3().setFromObject(tree), factor = item.estimatedHeight / box.getSize(new THREE.Vector3()).y;
    tree.scale.setScalar(factor); tree.position.set(item.position[0], item.position[1] - box.min.y * factor, item.position[2]); tree.rotation.y = i * 1.618;
    tree.name = 'P1_SAMPLE_' + item.id; tree.userData = { inheritedTreeId: item.id, placement: 'Inherited/unverified', height: 'Photo-derived estimate' };
    tree.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); sample.add(tree);
  }
  scene.add(sample);
  const road = new THREE.MeshStandardMaterial({ map: makeTexture('road'), roughness: .98 }), grass = new THREE.MeshStandardMaterial({ map: makeTexture('grass'), roughness: 1 });
  const whitelist = new Map([['B-WALK-01-expanded-road-1_5-5-3', road], ['B-WALK-01-green-building-side', grass], ['B-WALK-01-green-between-parallel-roads', grass]]);
  assembly.traverse((o) => { const replacement = whitelist.get(o.userData.p1OriginalName); if (o.isMesh && replacement) materialChanges.push({ object: o, before: o.material, after: replacement }); });
}
function applyMode() {
  if (!state.ready) return;
  const single = state.mode === 'candidate'; stageMain.forEach((o) => { o.visible = !single && o.userData.p1LegacyVisible !== false; });
  skp.visible = state.mode !== 'stage'; skp.position.fromArray(single ? data.registration.candidatePosition : data.registration.legacyPosition);
  const showSample = single && state.quality; sample.visible = showSample;
  data.sampleTrees.forEach((t) => { const o = treeRoots.get(t.id); o.visible = !showSample && o.userData.p1LegacyVisible !== false; });
  materialChanges.forEach((m) => { m.object.material = showSample ? m.after : m.before; }); ui.quality.disabled = !single; envelope.visible = ui.envelope.checked;
  $('scene-title').textContent = captions[state.mode][0];
  $('mode-caption').textContent = captions[state.mode][1] + (showSample ? ' 环境样板已开启：10株树的X/Z沿用旧候选、树高为照片估计；材质作用于三块既有整段路面/绿地。' : ' 环境样板未显示。'); render();
}
function showEvidence() {
  const photos = $('photos'); photos.replaceChildren();
  for (const p of data.photos) {
    const figure = document.createElement('figure'), link = document.createElement('a'), img = document.createElement('img'), caption = document.createElement('figcaption'), title = document.createElement('b');
    link.href = p.url; link.target = '_blank'; link.rel = 'noopener'; img.src = p.url; img.alt = p.alt; img.loading = 'lazy'; img.width = 800; img.height = 600;
    title.textContent = p.id + ' · 现场照片'; caption.append(title, document.createTextNode(p.note)); link.append(img); figure.append(link, caption); photos.append(figure);
  }
  const gaps = $('gaps'); gaps.replaceChildren();
  for (const [i, g] of data.gaps.entries()) {
    const article = document.createElement('article'); article.className = 'gap';
    const order = document.createElement('span'), title = document.createElement('h3'), now = document.createElement('p'), next = document.createElement('p'), strong = document.createElement('strong');
    order.textContent = String(i + 1).padStart(2, '0') + ' / 待完善'; title.textContent = g.title; now.textContent = g.current; strong.textContent = '下一步：'; next.append(strong, document.createTextNode(g.next)); article.append(order, title, now, next); gaps.append(article);
  }
}
async function fetchModel(path) {
  const response = await fetch(path, { signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error('模型请求失败（' + response.status + '）');
  const bytes = await response.arrayBuffer(); if (new DataView(bytes).getUint32(0, true) !== 0x46546c67) throw new Error('模型文件无效，请重新载入'); return new GLTFLoader().parseAsync(bytes, '/review/p1/assets/');
}
async function start() {
  try {
    const response = await fetch('./data.json', { signal: AbortSignal.timeout(20000) }); if (!response.ok) throw new Error('对照清单读取失败'); data = await response.json(); state.data = data; showEvidence();
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; ui.viewport.prepend(renderer.domElement); renderer.domElement.setAttribute('aria-label', '可旋转、缩放的三维场地模型');
    renderer.domElement.addEventListener('webglcontextlost', (event) => { event.preventDefault(); fail('三维画面连接中断，请重新载入'); });
    scene = new THREE.Scene(); scene.background = new THREE.Color('#dce4dd'); camera = new THREE.PerspectiveCamera(45, 1, .15, 1800);
    controls = new OrbitControls(camera, renderer.domElement); controls.minDistance = 1.5; controls.maxDistance = 650; controls.maxPolarAngle = Math.PI * .495; controls.addEventListener('change', () => renderer.render(scene, camera));
    scene.add(new THREE.HemisphereLight(0xf0f5ff, 0x5d684b, 2.1));
    const sunlight = new THREE.DirectionalLight(0xfff3dd, 3); sunlight.position.set(50, 140, -60); sunlight.castShadow = true; sunlight.shadow.mapSize.set(2048, 2048); Object.assign(sunlight.shadow.camera, { left: -150, right: 150, top: 130, bottom: -130, near: 1, far: 380 }); sunlight.shadow.normalBias = .12; sunlight.shadow.bias = -.0008; scene.add(sunlight); resize();
    ui.detail.textContent = '载入整场装配与局部环境样板，首次约7.3 MB…';
    const [source, vegetation] = await Promise.all([fetchModel('./assets/source-assembly.glb'), fetchModel('./assets/vegetation-library.glb')]); assembly = source.scene; scene.add(assembly);
    assembly.traverse((o) => {
      if ('p1LegacyVisible' in o.userData) o.visible = o.userData.p1LegacyVisible;
      if (o.userData.p1Role === 'stage_main') stageMain.push(o);
      if (o.userData.p1Role === 'skp_source') skp = o;
      if (o.userData.p1Role === 'legacy_tree_root') treeRoots.set(o.userData.p1OriginalName, o);
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = !['skp_primitive', 'stage_main'].includes(o.userData.p1Role); }
    });
    if (!skp || stageMain.length !== 71) throw new Error('装配清单与模型不一致，暂不显示候选');
    skp.scale.fromArray(data.registration.scale); installSample(vegetation.scene);
    envelope = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...data.navigationEnvelope.min), new THREE.Vector3(...data.navigationEnvelope.max)), 0xcc7f2b); envelope.visible = false; scene.add(envelope);
    state.ready = true; $('model-controls').disabled = false; document.querySelectorAll('[data-view]').forEach((b) => { b.disabled = false; }); cameraView('overall'); applyMode(); ui.loading.hidden = true;
  } catch (error) { fail(error.message); }
}
function fail(message) {
  state.ready = false; state.error = message; ui.loading.hidden = false; ui.title.textContent = '模型暂未载入'; ui.detail.textContent = message + '。请检查网络后重试；若浏览器不支持WebGL，请换用桌面浏览器。'; ui.retry.hidden = false;
  $('model-controls').disabled = true; document.querySelectorAll('[data-view]').forEach((b) => { b.disabled = true; });
}
ui.retry.addEventListener('click', () => location.reload());
document.querySelectorAll('[name=mode]').forEach((radio) => radio.addEventListener('change', () => { state.mode = radio.value; applyMode(); }));
ui.quality.addEventListener('change', () => { state.quality = ui.quality.checked; applyMode(); }); ui.envelope.addEventListener('change', applyMode);
document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => cameraView(button.dataset.view))); new ResizeObserver(resize).observe(ui.viewport);
window.P1Review = { state, inspect() {
  if (!state.ready) return { ready: false, error: state.error };
  let sourceVertices = 0, visibleSkp = 0; skp.traverse((o) => { if (o.isMesh) { sourceVertices += o.geometry.attributes.position.count; if (o.visible) visibleSkp++; } });
  return { ready: true, mode: state.mode, quality: sample.visible, stageMainCount: stageMain.length, stageMainVisible: stageMain.filter((o) => o.visible).length, visibleSkp, sourceVertices, skpVisible: skp.visible, skpPosition: skp.position.toArray(), camera: camera.position.toArray(), target: controls.target.toArray(), sampleTrees: sample.children.map((o) => ({ id: o.userData.inheritedTreeId, position: o.position.toArray(), height: new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3()).y })), materialNames: materialChanges.map((m) => m.object.userData.p1OriginalName) };
} };
start();
