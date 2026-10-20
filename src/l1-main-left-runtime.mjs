/**
 * L1 · 主楼左侧连续段运行时附加层。
 *
 * 这个模块只依赖当前 Three runtime，不导入或改写源 GLB。调用方在加载
 * asset_a98b0182ed4e 后传入 runtime，即可把本组对象挂到同一个 model 根上。
 * 所有对象都使用 L1-MAIN-LEFT- 命名空间，重复调用会复用已有组。
 */

export const L1_MAIN_LEFT_GROUP = 'L1-MAIN-LEFT-surface-detail';
export const L1_MAIN_LEFT_BASE_LAYER = 'asset_a98b0182ed4e';

const SOURCE_PHOTOS = ['P033', 'P034', 'P035'];
const SOURCE_EVIDENCE = ['B-WALK-01', 'B-MAIN-ENTRY-01', 'B-ENTRY-ROAD-02', ...SOURCE_PHOTOS];

const reportFor = (group, extra = {}) => ({
  groupName: group?.name || L1_MAIN_LEFT_GROUP,
  objects: group?.userData?.objectNames || [],
  evidenceLevel: group?.userData?.evidenceLevel || 'Derived_pending_visual_review',
  geometryMutated: false,
  baseLayer: L1_MAIN_LEFT_BASE_LAYER,
  sourceEvidence: SOURCE_EVIDENCE,
  ...extra
});

const addBox = (THREE, group, name, size, position, material, userData = {}) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.userData = { namespace: 'L1-MAIN-LEFT-', ...userData };
  mesh.frustumCulled = false;
  group.add(mesh);
  return mesh;
};

const addCylinder = (THREE, group, name, radius, height, position, material, userData = {}) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.userData = { namespace: 'L1-MAIN-LEFT-', ...userData };
  mesh.frustumCulled = false;
  group.add(mesh);
  return mesh;
};

const addTree = (THREE, group, name, position, scale, materials, surfaceY) => {
  const tree = new THREE.Group();
  tree.name = name;
  tree.position.set(...position);
  tree.userData = {
    namespace: 'L1-MAIN-LEFT-',
    evidenceLevel: 'Derived',
    sourcePhotos: SOURCE_PHOTOS,
    spacing: 'photo-rhythm / approximate'
  };
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16 * scale, 0.22 * scale, 2.8 * scale, 12),
    materials.trunk
  );
  trunk.name = `${name}-trunk`;
  trunk.position.y = surfaceY + 1.4 * scale;
  trunk.userData = { namespace: 'L1-MAIN-LEFT-', evidenceLevel: 'Derived' };
  const crown = new THREE.Mesh(new THREE.SphereGeometry(1.35 * scale, 20, 12), materials.leaf);
  crown.name = `${name}-crown`;
  crown.scale.y = 1.25;
  crown.position.y = surfaceY + 3.25 * scale;
  crown.userData = { namespace: 'L1-MAIN-LEFT-', evidenceLevel: 'Derived', smoothRepresentation: true };
  tree.add(trunk, crown);
  tree.traverse((node) => { node.frustumCulled = false; node.renderOrder = 145; });
  group.add(tree);
  return tree;
};

/**
 * Attach the L1 left-side continuous segment to the existing model root.
 * @param {object} runtime current runtime with `{THREE, model, groundY}`
 * @returns {{groupName:string, objects:string[], evidenceLevel:string, geometryMutated:boolean}}
 */
export function applyL1MainBuilding(runtime) {
  if (!runtime?.model || !runtime?.THREE) {
    return {
      groupName: L1_MAIN_LEFT_GROUP,
      objects: [],
      evidenceLevel: 'Blocked_runtime_not_ready',
      geometryMutated: false,
      baseLayer: L1_MAIN_LEFT_BASE_LAYER,
      sourceEvidence: SOURCE_EVIDENCE,
      error: 'runtime.model and runtime.THREE are required'
    };
  }

  const existing = runtime.model.getObjectByName(L1_MAIN_LEFT_GROUP);
  if (existing) return reportFor(existing, { reused: true });

  const THREE = runtime.THREE;
  const group = new THREE.Group();
  group.name = L1_MAIN_LEFT_GROUP;
  group.renderOrder = 135;

  // These are the audited stage-3 corridor anchors already used by B-WALK-01.
  // Adding model.position then applying its inverse on the group keeps the
  // additions in the same world frame when the model is centered by the viewer.
  const ox = Number(runtime.model.position?.x || 0);
  const oz = Number(runtime.model.position?.z || 0);
  const source = {
    xMin: -74.2820,
    xMax: 64.6430,
    buildingEdgeZ: -61.5000,
    roadTopZ: -66.6400,
    pathCenterZ: -69.0520,
    greenFarEdgeZ: -79.5141
  };
  const xMin = source.xMin + ox;
  const xMax = source.xMax + ox;
  const buildingEdgeZ = source.buildingEdgeZ + oz;
  const roadTopZ = source.roadTopZ + oz;
  const pathCenterZ = source.pathCenterZ + oz;
  const greenFarEdgeZ = source.greenFarEdgeZ + oz;
  const surfaceY = Number(runtime.groundY || 0) + 0.14;
  const middleX = (xMin + xMax) / 2;
  const segmentLength = Math.max(12, xMax - xMin - 8);

  const brick = new THREE.MeshStandardMaterial({ color: 0x9a5a3e, roughness: 0.9, metalness: 0.03 });
  const brickDark = new THREE.MeshStandardMaterial({ color: 0x5b3c35, roughness: 0.92, metalness: 0.02 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb9b5aa, roughness: 0.86, metalness: 0.02 });
  const asphalt = new THREE.MeshStandardMaterial({ color: 0x3e4448, roughness: 0.95, metalness: 0.01 });
  const stainless = new THREE.MeshStandardMaterial({ color: 0xaeb9bb, roughness: 0.28, metalness: 0.72 });
  const tactile = new THREE.MeshStandardMaterial({ color: 0xe1bd3a, roughness: 0.75, metalness: 0.01 });
  const hedge = new THREE.MeshStandardMaterial({ color: 0x385b35, roughness: 0.96, metalness: 0.0 });
  const trunk = new THREE.MeshStandardMaterial({ color: 0x584235, roughness: 0.95, metalness: 0.0 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x4c713d, roughness: 0.93, metalness: 0.0 });

  const objectNames = [];
  const record = (object) => { if (object?.name) objectNames.push(object.name); return object; };

  // P034: the left-side building edge is a warm perforated/brick wall with a
  // dark return. It is kept as a thin visual skin so the source facade mesh is
  // untouched and remains the authoritative base geometry.
  record(addBox(THREE, group, 'L1-MAIN-LEFT-facade-brick-skin', [segmentLength, 5.8, 0.16], [middleX, surfaceY + 2.9, buildingEdgeZ + 0.18], brick, {
    evidenceLevel: 'Derived', sourcePhotos: ['P034'], visualRole: 'perforated-brick-wall-skin'
  }));
  record(addBox(THREE, group, 'L1-MAIN-LEFT-facade-dark-return', [0.22, 5.8, 3.8], [xMin + 3.0, surfaceY + 2.9, buildingEdgeZ + 1.95], brickDark, {
    evidenceLevel: 'Derived', sourcePhotos: ['P034'], visualRole: 'dark-side-return'
  }));

  // Preserve the facade's panel rhythm without inventing window openings that
  // are not visible in P034. These shallow seams read at competition distance.
  for (let index = 0; index < 9; index += 1) {
    const seamX = xMin + 7 + index * ((segmentLength - 14) / 8);
    record(addBox(THREE, group, `L1-MAIN-LEFT-facade-panel-seam-${String(index + 1).padStart(2, '0')}`, [0.035, 5.45, 0.02], [seamX, surfaceY + 2.9, buildingEdgeZ + 0.275], brickDark, {
      evidenceLevel: 'Derived', sourcePhotos: ['P034'], visualRole: 'panel-rhythm'
    }));
  }

  // P033/B-ENTRY-ROAD-02: a small concrete connection pad and tactile strip
  // tie the main left-side path to the gate. Its dimensions stay visual-scale
  // and are explicitly derived, not a survey claim.
  record(addBox(THREE, group, 'L1-MAIN-LEFT-entry-connection-pad', [8.6, 0.08, 4.8], [xMax - 8.0, surfaceY - 0.03, pathCenterZ], concrete, {
    evidenceLevel: 'Derived', sourcePhotos: ['P033', 'P035'], visualRole: 'entry-connection-surface'
  }));
  for (let index = 0; index < 6; index += 1) {
    record(addBox(THREE, group, `L1-MAIN-LEFT-tactile-strip-${String(index + 1).padStart(2, '0')}`, [0.52, 0.055, 0.32], [xMax - 9.8 + index * 0.82, surfaceY + 0.045, pathCenterZ - 1.0], tactile, {
      evidenceLevel: 'Observed_anchor_derived_scale', sourcePhotos: ['P033'], visualRole: 'yellow-tactile-strip'
    }));
  }

  // P033: stainless pedestrian channel/turnstile. The repeated cylinders and
  // rails reproduce the recognizable gate silhouette without asserting access
  // control hardware that is not visible in the evidence.
  const gateX = xMax - 5.8;
  const gateZ = pathCenterZ + 0.35;
  for (let lane = 0; lane < 2; lane += 1) {
    const laneX = gateX + lane * 2.1 - 1.05;
    record(addCylinder(THREE, group, `L1-MAIN-LEFT-gate-post-${lane + 1}-a`, 0.095, 1.36, [laneX, surfaceY + 0.68, gateZ - 1.0], stainless, { evidenceLevel: 'Observed_anchor_derived_scale', sourcePhotos: ['P033'], visualRole: 'pedestrian-gate-post' }));
    record(addCylinder(THREE, group, `L1-MAIN-LEFT-gate-post-${lane + 1}-b`, 0.095, 1.36, [laneX, surfaceY + 0.68, gateZ + 1.0], stainless, { evidenceLevel: 'Observed_anchor_derived_scale', sourcePhotos: ['P033'], visualRole: 'pedestrian-gate-post' }));
    record(addBox(THREE, group, `L1-MAIN-LEFT-gate-rail-${lane + 1}`, [0.08, 0.08, 2.0], [laneX, surfaceY + 1.19, gateZ], stainless, { evidenceLevel: 'Observed_anchor_derived_scale', sourcePhotos: ['P033'], visualRole: 'pedestrian-gate-rail' }));
  }
  record(addBox(THREE, group, 'L1-MAIN-LEFT-gate-canopy', [4.9, 0.12, 2.9], [gateX, surfaceY + 2.05, gateZ], stainless, {
    evidenceLevel: 'Derived', sourcePhotos: ['P033'], visualRole: 'light-entry-canopy'
  }));

  // P034/P035: a low hedge and one smooth tree anchor the building-side
  // planting rhythm. Existing B-WALK foliage remains untouched; these objects
  // carry the L1 namespace and fill only this continuous segment's facade edge.
  const hedgeCount = 8;
  for (let index = 0; index < hedgeCount; index += 1) {
    const hedgeX = xMin + 11 + index * ((segmentLength - 22) / (hedgeCount - 1));
    record(addBox(THREE, group, `L1-MAIN-LEFT-facade-hedge-${String(index + 1).padStart(2, '0')}`, [7.1, 0.95, 0.9], [hedgeX, surfaceY + 0.48, buildingEdgeZ + 1.1], hedge, {
      evidenceLevel: 'Derived', sourcePhotos: ['P034', 'P035'], visualRole: 'building-side-hedge'
    }));
  }
  record(addTree(THREE, group, 'L1-MAIN-LEFT-facade-tree-anchor', [xMin + 26, 0, buildingEdgeZ + 1.55], 1.05, { trunk, leaf }, surfaceY));
  objectNames.push('L1-MAIN-LEFT-facade-tree-anchor');

  // A narrow curb cap makes the two adjacent path edges legible from the
  // competition camera while keeping the actual road meshes untouched.
  record(addBox(THREE, group, 'L1-MAIN-LEFT-path-edge-curb', [segmentLength, 0.16, 0.18], [middleX, surfaceY + 0.08, roadTopZ], concrete, {
    evidenceLevel: 'Derived', sourcePhotos: ['P033', 'P035'], visualRole: 'path-edge-curb'
  }));

  group.position.set(-ox, -(runtime.model.position?.y || 0), -oz);
  group.userData = {
    schema: 'l1_main_left_runtime.v1',
    namespace: 'L1-MAIN-LEFT-',
    evidenceLevel: 'Derived_pending_visual_review',
    sourceEvidence: SOURCE_EVIDENCE,
    sourcePhotos: SOURCE_PHOTOS,
    sourceArchive: '2026-10-02 photo/video archive',
    baseLayer: L1_MAIN_LEFT_BASE_LAYER,
    operatorUrl: 'http://localhost:5174/?model=asset_a98b0182ed4e&combine=artifact_2dbc856e76e8&focus=bwalk',
    geometryMutated: false,
    sourceGLBMeshesTouched: false,
    placement: {
      sourceAnchors: source,
      worldOffset: { x: ox, z: oz },
      surfaceY: Number(surfaceY.toFixed(3)),
      visualScaleOnly: true
    },
    objectNames,
    relations: [
      'P034 brick facade -> L1-MAIN-LEFT-facade-brick-skin',
      'P033 gate channel -> L1-MAIN-LEFT-gate-*',
      'P033/P035 path connection -> L1-MAIN-LEFT-entry-connection-pad',
      'P034/P035 trees and hedge rhythm -> L1-MAIN-LEFT-facade-hedge-*'
    ]
  };
  group.traverse((node) => { node.frustumCulled = false; });
  runtime.model.add(group);
  runtime.l1MainLeftGroup = group;
  runtime.setL1MainLeftVisibility = (visible = true) => {
    group.visible = Boolean(visible);
    return { visible: group.visible, groupName: group.name };
  };
  return reportFor(group);
}

export default applyL1MainBuilding;

