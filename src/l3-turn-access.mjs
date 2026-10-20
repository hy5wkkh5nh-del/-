/**
 * Evidence-bound additive model for the turn / vehicle-entry position window.
 *
 * This module deliberately does not traverse or edit source GLB materials or
 * meshes.  It attaches one disposable group to the currently displayed model
 * so the parallel modelling lanes can land on the same base layer.
 */

const GROUP_NAME = 'L3-TURN-ACCESS-root';
const PREFIX = 'L3-TURN-ACCESS-';

function disposeGroup(group) {
  if (!group) return;
  group.parent?.remove(group);
  group.traverse((node) => {
    node.geometry?.dispose?.();
    if (Array.isArray(node.material)) node.material.forEach((material) => material?.dispose?.());
    else node.material?.dispose?.();
  });
}

function mesh(THREE, geometry, material, name, group, y = null) {
  const item = new THREE.Mesh(geometry, material);
  item.name = `${PREFIX}${name}`;
  if (y != null) item.position.y = y;
  item.frustumCulled = false;
  group.add(item);
  return item;
}

function material(THREE, color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.82,
    metalness: options.metalness ?? 0.04,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    depthWrite: options.depthWrite ?? false,
    depthTest: options.depthTest ?? false,
  });
}

function surfaceY(runtime, THREE) {
  const candidates = [];
  runtime.model?.traverse?.((node) => {
    if (!node?.isMesh || !/road|path|paving|asphalt|PLAN_ROAD/i.test(node.name || '')) return;
    const box = new THREE.Box3().setFromObject(node);
    if (box.max.y - box.min.y < 1.2) candidates.push(box.max.y);
  });
  if (runtime.bWalkSurfaceDetail?.userData?.surfaceY != null) {
    return Number(runtime.bWalkSurfaceDetail.userData.surfaceY) + 0.012;
  }
  return (candidates.length ? Math.max(...candidates) : Number(runtime.groundY || 0) + 0.18) + 0.045;
}

function polygonMesh(THREE, points, y, mat, name, group) {
  const shape = new THREE.Shape();
  points.forEach(([x, z], index) => {
    if (index === 0) shape.moveTo(x, -z);
    else shape.lineTo(x, -z);
  });
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const item = mesh(THREE, geometry, mat, name, group, y);
  item.renderOrder = 110;
  return item;
}

function ribbonPolygon(points, width) {
  const left = [];
  const right = [];
  for (let i = 0; i < points.length; i += 1) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - prev[0];
    const dz = next[1] - prev[1];
    const length = Math.max(0.001, Math.hypot(dx, dz));
    const nx = -dz / length;
    const nz = dx / length;
    left.push([points[i][0] + nx * width / 2, points[i][1] + nz * width / 2]);
    right.push([points[i][0] - nx * width / 2, points[i][1] - nz * width / 2]);
  }
  return left.concat(right.reverse());
}

function line(THREE, points, materialValue, name, group, y) {
  const geometry = new THREE.BufferGeometry().setFromPoints(
    points.map(([x, z]) => new THREE.Vector3(x, y, z)),
  );
  const item = new THREE.Line(geometry, materialValue);
  item.name = `${PREFIX}${name}`;
  item.renderOrder = 160;
  item.frustumCulled = false;
  group.add(item);
  return item;
}

function addSign(THREE, group, y, x, z, title, color = 0x0d4f7d) {
  const poleMat = material(THREE, 0x5d6668, { roughness: 0.62, metalness: 0.34 });
  const faceMat = material(THREE, color, { roughness: 0.44, metalness: 0.12 });
  mesh(THREE, new THREE.CylinderGeometry(0.045, 0.06, 1.85, 10), poleMat, `${title}-sign-pole`, group, y + 0.925)
    .position.set(x, y + 0.925, z);
  const panel = mesh(THREE, new THREE.BoxGeometry(0.9, 0.52, 0.075), faceMat, `${title}-sign-panel`, group, y + 1.72);
  panel.position.set(x, y + 1.72, z);
  panel.userData = { evidenceLevel: 'Observed', sourceAnchors: ['B-ENT-01', 'B-TURN-02'], label: title };
  return panel;
}

function addTree(THREE, group, y, x, z, scale, index) {
  const tree = new THREE.Group();
  tree.name = `${PREFIX}turn-green-tree-${index}`;
  tree.userData = { evidenceLevel: 'Derived', sourceAnchors: ['B-TURN-02', 'B-JCT-01-R'], placement: 'inner turn island' };
  const trunk = mesh(THREE, new THREE.CylinderGeometry(0.11 * scale, 0.16 * scale, 1.35 * scale, 10), material(THREE, 0x594531, { roughness: 0.96 }), `turn-green-tree-${index}-trunk`, tree, y + 0.675 * scale);
  trunk.position.x = x;
  trunk.position.z = z;
  const crown = mesh(THREE, new THREE.SphereGeometry(0.86 * scale, 16, 12), material(THREE, 0x4d743b, { roughness: 0.94 }), `turn-green-tree-${index}-crown`, tree, y + 1.7 * scale);
  crown.scale.y = 1.08;
  crown.position.x = x;
  crown.position.z = z;
  tree.renderOrder = 150;
  group.add(tree);
  return tree;
}

/**
 * Add the L3 turn / vehicle-entry position packet to the displayed model.
 * @returns {{groupName:string, objects:string[], evidenceLevel:string, geometryMutated:false}}
 */
export function applyL3TurnAccess(runtime) {
  const THREE = runtime?.THREE;
  if (!runtime?.model || !THREE) {
    return { groupName: GROUP_NAME, objects: [], evidenceLevel: 'Derived_pending_visual_review', geometryMutated: false };
  }
  disposeGroup(runtime.l3TurnAccessGroup);

  const group = new THREE.Group();
  group.name = GROUP_NAME;
  const y = surfaceY(runtime, THREE);

  // The 10-02 archive places this packet at the purple-fork / vehicle-entry
  // relation: the confirmed flag anchor is [63.15, -78.70], while the two-path
  // video places the main-road entry around z=-87.468.  These are visual
  // anchors, not a survey claim.
  const anchor = { x: 63.15, z: -78.70 };
  const entry = { x: 66.8, z: -87.468 };
  const turnPath = [[42.0, -78.70], [52.0, -78.70], [59.0, -80.00], [64.5, -83.8], [entry.x, entry.z]];

  const asphalt = material(THREE, 0x353b40, { roughness: 0.96, depthTest: false });
  const road = polygonMesh(THREE, ribbonPolygon(turnPath, 5.4), y + 0.025, asphalt, 'turn-road-smooth-curve', group);
  road.userData = { evidenceLevel: 'Derived', sourceAnchors: ['B-JCT-01-R', 'B-TURN-02', 'B-FORK-01'], metricSurveyClaimed: false };

  const marking = new THREE.LineBasicMaterial({ color: 0xf1d271, transparent: true, opacity: 0.94, depthWrite: false, depthTest: false });
  line(THREE, [[47.2, -79.55], [57.2, -80.0], [63.8, -84.3], [entry.x - 1.0, entry.z]], marking, 'turn-road-yellow-guide', group, y + 0.07);
  line(THREE, [[entry.x - 2.4, entry.z - 2.0], [entry.x + 2.4, entry.z - 2.0]], marking, 'vehicle-entry-yellow-grid-front', group, y + 0.075);
  line(THREE, [[entry.x - 2.4, entry.z - 1.15], [entry.x + 2.4, entry.z - 1.15]], marking, 'vehicle-entry-yellow-grid-back', group, y + 0.075);

  // Inner turning island shown in B-TURN-02.  Low planting keeps the curve
  // legible in the competition camera without inventing a surveyed layout.
  const islandMat = material(THREE, 0x5e7739, { roughness: 0.95, depthTest: false });
  const island = polygonMesh(THREE, [[61.5, -82.0], [66.4, -79.9], [70.0, -82.4], [67.1, -85.0]], y + 0.09, islandMat, 'turn-inner-green-island', group);
  island.userData = { evidenceLevel: 'Derived', sourceAnchors: ['B-TURN-02'], temporaryObjectsExcluded: ['cones', 'warning tape'] };
  addTree(THREE, group, y, 65.2, -82.4, 0.62, 1);
  addTree(THREE, group, y, 67.4, -83.0, 0.46, 2);

  // Vehicle entrance: a small ramp, blue-white gate equipment and the booth
  // are all explicitly described in the B-ENT-01 photo/video notes.
  const rampMat = material(THREE, 0x4a5053, { roughness: 0.92, depthTest: false });
  const ramp = mesh(THREE, new THREE.BoxGeometry(5.4, 0.12, 4.5), rampMat, 'vehicle-entry-ramp', group, y + 0.06);
  ramp.position.set(entry.x, y + 0.06, entry.z);
  ramp.userData = { evidenceLevel: 'Derived', sourceAnchors: ['B-ENT-01'], function: 'vehicle ramp / under-building entry' };

  const blue = material(THREE, 0x1e6e9d, { roughness: 0.44, metalness: 0.18, depthTest: false });
  const white = material(THREE, 0xe4e7e4, { roughness: 0.58, depthTest: false });
  const dark = material(THREE, 0x1d282d, { roughness: 0.36, metalness: 0.5, depthTest: false });
  const booth = new THREE.Group();
  booth.name = `${PREFIX}vehicle-entry-guard-booth`;
  booth.userData = { evidenceLevel: 'Observed', sourceAnchors: ['B-ENT-01'], metricSurveyClaimed: false };
  const boothBody = mesh(THREE, new THREE.BoxGeometry(2.3, 2.1, 2.1), white, 'vehicle-entry-guard-booth-body', booth, y + 1.05);
  boothBody.position.set(entry.x + 3.2, y + 1.05, entry.z + 0.7);
  const boothRoof = mesh(THREE, new THREE.BoxGeometry(2.55, 0.18, 2.35), blue, 'vehicle-entry-guard-booth-blue-roof', booth, y + 2.18);
  boothRoof.position.set(entry.x + 3.2, y + 2.18, entry.z + 0.7);
  const boothWindow = mesh(THREE, new THREE.BoxGeometry(2.02, 0.72, 0.06), dark, 'vehicle-entry-guard-booth-window', booth, y + 1.42);
  boothWindow.position.set(entry.x + 3.2, y + 1.42, entry.z - 0.37);
  group.add(booth);

  const barrierPost = mesh(THREE, new THREE.CylinderGeometry(0.16, 0.2, 1.05, 12), blue, 'vehicle-entry-barrier-post', group, y + 0.525);
  barrierPost.position.set(entry.x - 2.3, y + 0.525, entry.z + 0.5);
  const barrierArm = mesh(THREE, new THREE.BoxGeometry(4.2, 0.13, 0.12), white, 'vehicle-entry-barrier-arm', group, y + 1.06);
  barrierArm.position.set(entry.x - 0.25, y + 1.06, entry.z + 0.5);
  barrierArm.rotation.y = 0.04;
  const barrierStripe = mesh(THREE, new THREE.BoxGeometry(0.55, 0.15, 0.14), blue, 'vehicle-entry-barrier-blue-stripe', group, y + 1.06);
  barrierStripe.position.set(entry.x - 0.18, y + 1.06, entry.z + 0.5);

  const cameraPole = mesh(THREE, new THREE.CylinderGeometry(0.055, 0.075, 2.4, 10), dark, 'vehicle-entry-camera-pole', group, y + 1.2);
  cameraPole.position.set(entry.x - 2.85, y + 1.2, entry.z - 0.7);
  const cameraHead = mesh(THREE, new THREE.BoxGeometry(0.28, 0.22, 0.44), dark, 'vehicle-entry-camera-head', group, y + 2.32);
  cameraHead.position.set(entry.x - 2.85, y + 2.32, entry.z - 0.7);

  for (let i = 0; i < 3; i += 1) {
    const bollard = mesh(THREE, new THREE.CylinderGeometry(0.13, 0.16, 0.9, 10), i % 2 ? blue : white, `vehicle-entry-bollard-${i + 1}`, group, y + 0.45);
    bollard.position.set(entry.x + 0.5 + i * 0.62, y + 0.45, entry.z - 1.8);
  }

  // Small pedestrian gate on the second-path side, tied to the continuous
  // fence evidence but kept local so M2 can retain ownership of the long run.
  const gate = new THREE.Group();
  gate.name = `${PREFIX}pedestrian-gate-local`;
  gate.userData = { evidenceLevel: 'Observed', sourceAnchors: ['B-JCT-01', 'B-JCT-01-R'], owner: 'L3-TURN-ACCESS' };
  for (const [index, dx] of [-1.1, 1.1].entries()) {
    const post = mesh(THREE, new THREE.BoxGeometry(0.14, 1.45, 0.14), dark, `pedestrian-gate-post-${index + 1}`, gate, y + 0.725);
    post.position.set(anchor.x + dx, y + 0.725, anchor.z + 1.1);
  }
  const gateLeaf = mesh(THREE, new THREE.BoxGeometry(2.05, 1.12, 0.08), dark, 'pedestrian-gate-leaf', gate, y + 0.72);
  gateLeaf.position.set(anchor.x, y + 0.72, anchor.z + 1.1);
  group.add(gate);

  const drainMat = material(THREE, 0x242c2f, { roughness: 0.9, metalness: 0.24, depthTest: false });
  const drain = mesh(THREE, new THREE.CylinderGeometry(0.38, 0.38, 0.035, 16), drainMat, 'entry-drain-manhole', group, y + 0.075);
  drain.rotation.x = Math.PI / 2;
  drain.position.set(entry.x - 3.0, y + 0.075, entry.z - 2.8);
  drain.userData = { evidenceLevel: 'Observed', sourceAnchors: ['B-ENT-01', 'B-JCT-01-R'], exactPosition: 'visual anchor only' };

  addSign(THREE, group, y, entry.x - 1.8, entry.z - 2.35, 'height-2_1m', 0x18557a);
  addSign(THREE, group, y, entry.x + 0.25, entry.z - 2.35, 'vehicle-entry', 0x18557a);
  addSign(THREE, group, y, 70.5, -84.2, 'turn-direction', 0x1b6f92);

  group.userData = {
    evidenceLevel: 'Derived_pending_visual_review',
    sourceEvidence: ['B-JCT-01', 'B-ENT-01', 'B-JCT-01-R', 'B-TURN-02', 'B-FORK-01'],
    sourceArchive: '2026-10-02 photo/video archive',
    anchors: { purpleFork: [anchor.x, 0, anchor.z], mainRoadEntrySiteZ: entry.z },
    metricSurveyClaimed: false,
    geometryMutated: false,
    temporaryObjectsExcluded: ['cones', 'warning tape'],
  };
  group.renderOrder = 100;
  group.traverse((node) => { node.frustumCulled = false; });

  // Match the existing additive-layer convention: positions are authored in
  // the registered scene coordinates, then neutralised against the model root
  // transform.  No source mesh or source material is touched.
  group.position.set(-(runtime.model.position.x || 0), -(runtime.model.position.y || 0), -(runtime.model.position.z || 0));
  runtime.model.add(group);
  runtime.l3TurnAccessGroup = group;

  const objects = [];
  group.traverse((node) => { if (node !== group && node.name?.startsWith(PREFIX)) objects.push(node.name); });
  return { groupName: GROUP_NAME, objects, evidenceLevel: group.userData.evidenceLevel, geometryMutated: false };
}

export function removeL3TurnAccess(runtime) {
  if (!runtime?.l3TurnAccessGroup) return false;
  disposeGroup(runtime.l3TurnAccessGroup);
  runtime.l3TurnAccessGroup = null;
  return true;
}


