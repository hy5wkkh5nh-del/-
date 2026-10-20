const MATERIAL_STATE = Symbol('spatial-reframe-display-materials');
const FACADE_STATE = Symbol('spatial-reframe-facade-layer');
const ROAD_STATE = Symbol('spatial-reframe-road-layer');
const LANDSCAPE_STATE = Symbol('spatial-reframe-landscape-layer');
const ANALYSIS_CYAN = 0x54e0da;

export function latestArtifactsPerKind(artifacts = []) {
  const latest = new Map();
  for (const artifact of artifacts) {
    if (!artifact?.kind || artifact.metadata?.stale === true) continue;
    const current = latest.get(artifact.kind);
    const artifactTime = new Date(artifact.createdAt || artifact.uploadedAt || 0).getTime();
    const currentTime = new Date(current?.createdAt || current?.uploadedAt || 0).getTime();
    if (!current || artifactTime >= currentTime) latest.set(artifact.kind, artifact);
  }
  return [...latest.values()];
}

// The project registration is the source of truth for the active site scene.
// A later unregistered artifact can exist after a failed/replaced refinement;
// never let timestamp ordering silently replace the registered geometry.
export function selectCurrentSiteContextArtifact(artifacts = [], registeredArtifactId = '') {
  const active = artifacts.filter((artifact) =>
    artifact?.kind === 'site_context_glb' && artifact.metadata?.stale !== true
  );
  if (!active.length) return null;
  const registered = active.find((artifact) => artifact.id === registeredArtifactId);
  if (registered) return registered;
  return [...active].sort((left, right) =>
    new Date(left.createdAt || left.uploadedAt || 0) - new Date(right.createdAt || right.uploadedAt || 0)
  ).at(-1) || null;
}

function asArray(material) {
  return Array.isArray(material) ? material : [material];
}

function facadeKind(node, rootBounds = null, three = null) {
  const label = `${node?.name || ''} ${asArray(node?.material).map((item) => item?.name || '').join(' ')}`.toLowerCase();
  if (/window|glass|glazing|窗|幕墙/.test(label)) return 'window';
  const box = three?.Box3 && node?.isMesh ? new three.Box3().setFromObject(node) : null;
  if (box && rootBounds && rootBounds.max?.y != null && rootBounds.max.y - box.max.y < 2 && box.getSize(new three.Vector3()).y < 2) return 'roof';
  if (/roof|top|hvac|water|tank|antenna|屋顶|设备/.test(label)) return 'roof';
  if (/road|path|ground|terrain|道路|铺装|地面/.test(label)) return null;
  return 'facade';
}

function makeFacadeMaterial(material, kind, night = false, three = null) {
  if (!material?.clone) return material;
  const enhanced = material.clone();
  enhanced.name = `${material.name || material.type || 'material'} · 立面表现层 · ${kind}`;
  const color = kind === 'window' ? 0x345063 : kind === 'roof' ? 0x436b86 : 0xc3beb4;
  enhanced.color?.setHex?.(night ? Math.round(color * 0.56) : color);
  if (kind === 'window' && enhanced.emissive) {
    enhanced.emissive.setHex(night ? 0xffb35c : 0x18353c);
    enhanced.emissiveIntensity = night ? 0.62 : 0.08;
  }
  if ('roughness' in enhanced) enhanced.roughness = kind === 'window' ? 0.28 : kind === 'roof' ? 0.82 : 0.68;
  if ('metalness' in enhanced) enhanced.metalness = kind === 'window' ? 0.18 : 0.04;
  // Canvas textures are intentionally created only in the browser. The
  // material/color fallback keeps server-side tests and non-browser exports
  // deterministic while preserving the source geometry and maps.
  if (typeof document !== 'undefined' && enhanced.map == null && enhanced.color) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.fillRect(0, 0, 128, 128);
      if (kind === 'window') {
        ctx.fillStyle = night ? 'rgba(255,190,110,.72)' : 'rgba(218,235,237,.58)';
        for (let x = 8; x < 128; x += 24) for (let y = 8; y < 128; y += 22) ctx.fillRect(x, y, 13, 11);
      } else if (kind === 'facade') {
        ctx.strokeStyle = 'rgba(74,80,80,.28)';
        ctx.lineWidth = 1;
        for (let y = 16; y < 128; y += 20) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(128, y); ctx.stroke(); }
      }
      const TextureCtor = three?.CanvasTexture || globalThis.THREE?.CanvasTexture;
      if (TextureCtor) {
        enhanced.map = new TextureCtor(canvas);
        const repeatMode = three?.RepeatWrapping || globalThis.THREE?.RepeatWrapping;
        if (repeatMode) enhanced.map.wrapS = enhanced.map.wrapT = repeatMode;
        enhanced.map.repeat?.set(kind === 'window' ? 1.2 : 0.8, kind === 'window' ? 1.4 : 0.8);
      }
    }
  }
  enhanced.needsUpdate = true;
  return enhanced;
}

export function applyFacadeMaterialLayer(model, mode = 'original', three = null) {
  const report = { meshes: 0, enhanced: 0, geometryMutated: false, nightWindows: mode === 'day-night' };
  if (!model) return report;
  const rootBounds = three?.Box3 ? new three.Box3().setFromObject(model) : null;
  model.traverse((node) => {
    if (!node?.isMesh || !node.material || node.userData?.preserveDisplayMaterial) return;
    const kind = facadeKind(node, rootBounds, three);
    if (!kind) return;
    report.meshes += 1;
    const existing = node[FACADE_STATE];
    const original = existing?.original || node.material;
    const night = mode === 'day-night';
    if (!existing || existing.original !== original) {
      const enhanced = Array.isArray(original)
        ? original.map((material) => makeFacadeMaterial(material, kind, false, three))
        : makeFacadeMaterial(original, kind, false, three);
      const enhancedNight = Array.isArray(original)
        ? original.map((material) => makeFacadeMaterial(material, kind, true, three))
        : makeFacadeMaterial(original, kind, true, three);
      node[FACADE_STATE] = { original, enhanced, enhancedNight, kind };
      const textureUrl = kind === 'roof' ? '/textures/roof-pv.jpg' : kind === 'window' ? '/textures/facade-glass.jpg' : null;
      if (textureUrl && three?.TextureLoader) {
        const loader = new three.TextureLoader();
        loader.load(textureUrl, (texture) => {
          texture.colorSpace = three.SRGBColorSpace;
          texture.wrapS = texture.wrapT = three.RepeatWrapping;
          texture.repeat.set(kind === 'roof' ? 1 / 8 : kind === 'window' ? 1 / 6 : 1 / 4, kind === 'roof' ? 1 / 8 : kind === 'window' ? 1 / 6 : 1 / 4);
          asArray(node[FACADE_STATE].enhanced).forEach((material) => { material.map = texture; material.needsUpdate = true; });
          node[FACADE_STATE].textureSource = textureUrl;
        });
      }
    }
    node.material = night ? node[FACADE_STATE].enhancedNight : node[FACADE_STATE].enhanced;
    report.enhanced += 1;
  });
  return report;
}

export function applyRoadMaterialLayer(model) {
  const report = { meshes: 0, enhanced: 0, geometryMutated: false };
  if (!model) return report;
  model.traverse((node) => {
    if (!node?.isMesh || !node.material || node.userData?.preserveDisplayMaterial) return;
    const label = `${node.name || ''} ${asArray(node.material).map((item) => item?.name || '').join(' ')}`.toLowerCase();
    if (!/road|path|walk|lane|paving|道路|小道|铺装|路缘|斑马/.test(label)) return;
    report.meshes += 1;
    const existing = node[ROAD_STATE];
    const original = existing?.original || node.material;
    if (!existing || existing.original !== original) {
      const enhanced = asArray(original).map((material) => {
        const clone = material?.clone ? material.clone() : material;
        clone.name = `${material?.name || 'road'} · 道路材质层`;
        clone.color?.setHex?.(/cross|zebra|斑马|line|标线/.test(label) ? 0xf1d27a : /curb|路缘/.test(label) ? 0xb7b9b0 : 0x5f6769);
        if ('roughness' in clone) clone.roughness = 0.92;
        clone.needsUpdate = true;
        return clone;
      });
      node[ROAD_STATE] = { original, enhanced: Array.isArray(original) ? enhanced : enhanced[0] };
    }
    node.material = node[ROAD_STATE].enhanced;
    report.enhanced += 1;
  });
  return report;
}

export function applyLandscapeMaterialLayer(model) {
  const report = { meshes: 0, enhanced: 0, geometryMutated: false, simulatedBadge: 'Simulated' };
  if (!model) return report;
  model.traverse((node) => {
    if (!node?.isMesh || !node.material || node.userData?.preserveDisplayMaterial) return;
    const label = `${node.name || ''} ${asArray(node.material).map((item) => item?.name || '').join(' ')}`.toLowerCase();
    if (!/tree|canopy|trunk|plant|green|island|hedge|树|冠|干|绿化|花池/.test(label)) return;
    report.meshes += 1;
    const existing = node[LANDSCAPE_STATE];
    const original = existing?.original || node.material;
    if (!existing || existing.original !== original) {
      const enhanced = asArray(original).map((material) => {
        const clone = material?.clone ? material.clone() : material;
        clone.name = `${material?.name || 'landscape'} · Simulated palette`;
        clone.color?.setHex?.(/trunk|干/.test(label) ? 0x6a5138 : 0x61713b);
        if ('roughness' in clone) clone.roughness = 0.86;
        clone.needsUpdate = true;
        return clone;
      });
      node[LANDSCAPE_STATE] = { original, enhanced: Array.isArray(original) ? enhanced : enhanced[0] };
    }
    node.material = node[LANDSCAPE_STATE].enhanced;
    report.enhanced += 1;
  });
  return report;
}

function makeAnalysisMaterial(material) {
  const analysis = material.clone();
  analysis.name = `${material.name || material.type} · 分析青图`;
  analysis.color?.setHex(ANALYSIS_CYAN);
  if (analysis.emissive) {
    analysis.emissive.setHex(0x0b3537);
    analysis.emissiveIntensity = 0.18;
  }
  if ('vertexColors' in analysis) analysis.vertexColors = false;
  if ('metalness' in analysis) analysis.metalness = 0;
  if ('roughness' in analysis) analysis.roughness = 0.9;
  for (const mapName of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'lightMap']) {
    if (mapName in analysis) analysis[mapName] = null;
  }
  analysis.needsUpdate = true;
  return analysis;
}

function makeNightMaterial(material) {
  const night = material.clone();
  night.name = `${material.name || material.type} · 夜景`;
  const materialName = String(material.name || '').toLowerCase();
  const luminous = /glass|glazing|window|light|luminaire|灯|窗/.test(materialName);
  if (night.color) {
    if (luminous) night.color.lerp(new night.color.constructor(0xffd58a), 0.38);
    else night.color.multiplyScalar(0.42);
  }
  if (night.emissive) {
    night.emissive.setHex(luminous ? 0xffb85a : 0x03080b);
    night.emissiveIntensity = luminous ? 0.82 : 0.04;
  }
  if ('roughness' in night && luminous) night.roughness = Math.min(Number(night.roughness ?? 0.5), 0.38);
  night.needsUpdate = true;
  return night;
}

function materialState(node) {
  if (!node[MATERIAL_STATE]) {
    const original = node.material;
    const analysis = Array.isArray(original)
      ? original.map(makeAnalysisMaterial)
      : makeAnalysisMaterial(original);
    const night = Array.isArray(original)
      ? original.map(makeNightMaterial)
      : makeNightMaterial(original);
    node[MATERIAL_STATE] = { original, analysis, night };
  }
  return node[MATERIAL_STATE];
}

export function applyModelDisplayMode(model, mode, scenarioPoint = null) {
  if (!model) return;
  const altitude = Number(scenarioPoint?.sun?.altitude_deg);
  const nightActive = mode === 'day-night' && Number.isFinite(altitude) && altitude < 0;
  model.traverse((node) => {
    if (node.userData?.preserveDisplayMaterial) return;
    if (!node.material || !(node.isMesh || node.isPoints || node.isLine)) return;
    // Original mode is the default and should not allocate an analysis and a
    // night clone for every mesh during the first GLB paint.  Clone display
    // materials only when an alternate mode is actually requested.
    if (mode === 'original' && !node[MATERIAL_STATE]) return;
    const state = materialState(node);
    node.material = mode === 'analysis' ? state.analysis : nightActive ? state.night : state.original;
  });
}

export function disposeModelDisplayMaterials(model) {
  if (!model) return;
  model.traverse((node) => {
    const facade = node[FACADE_STATE];
    if (facade) {
      node.material = facade.original;
      asArray(facade.enhanced).forEach((material) => material.dispose?.());
      asArray(facade.enhancedNight).forEach((material) => material.dispose?.());
      delete node[FACADE_STATE];
    }
    const road = node[ROAD_STATE];
    if (road) {
      node.material = road.original;
      asArray(road.enhanced).forEach((material) => material.dispose?.());
      delete node[ROAD_STATE];
    }
    const landscape = node[LANDSCAPE_STATE];
    if (landscape) {
      node.material = landscape.original;
      asArray(landscape.enhanced).forEach((material) => material.dispose?.());
      delete node[LANDSCAPE_STATE];
    }
    const state = node[MATERIAL_STATE];
    if (!state) return;
    node.material = state.original;
    asArray(state.analysis).forEach((material) => material.dispose());
    asArray(state.night).forEach((material) => material.dispose());
    delete node[MATERIAL_STATE];
  });
}

