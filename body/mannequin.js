/* tools/body/mannequin.js — parametric grey mannequin, units in millimetres.
 *
 * The body itself is a standard-proportion artist's mannequin (lofted
 * elliptical torso, capsule limbs). The bust is driven by breast_telemetry/v1
 * measurements via deriveParams(): nipple position, areola diameter, mound
 * width and fold line all land to scale. Everything tunable in PARAMS.
 */
import * as THREE from 'three';

export const PARAMS = {
  body: 0xc9ced6,        // clay grey
  marker: 0x8f96a3,      // telemetry markers (areola, nipple, fold)
  foldY: 1150,           // underbust height on the standard body
  torsoRings: [          // y, rx (half-width), rz (half-depth)
    { y: 760, rx: 148, rz: 116 },
    { y: 820, rx: 165, rz: 126 },
    { y: 880, rx: 174, rz: 130 },
    { y: 940, rx: 158, rz: 120 },
    { y: 1010, rx: 142, rz: 106 },
    { y: 1080, rx: 144, rz: 108 },
    { y: 1150, rx: 150, rz: 114 },
    { y: 1210, rx: 163, rz: 130 },
    { y: 1280, rx: 172, rz: 134 },
    { y: 1340, rx: 182, rz: 124 },
    { y: 1400, rx: 194, rz: 110 },
    { y: 1445, rx: 168, rz: 96 },
    { y: 1465, rx: 120, rz: 80 },
  ],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* Front (+z) surface of the torso loft at height y, by lerping ring rz. */
export function torsoFrontZ(y) {
  const rings = PARAMS.torsoRings;
  if (y <= rings[0].y) return rings[0].rz;
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    if (y <= b.y) {
      const t = (y - a.y) / (b.y - a.y);
      return a.rz + (b.rz - a.rz) * t;
    }
  }
  return rings[rings.length - 1].rz;
}

/* Loft elliptical rings into a closed solid. */
function loft(rings, segments = 56) {
  const pos = [], idx = [];
  rings.forEach(rg => {
    for (let j = 0; j < segments; j++) {
      const t = (j / segments) * Math.PI * 2;
      pos.push((rg.cx || 0) + rg.rx * Math.cos(t), rg.y, (rg.cz || 0) + rg.rz * Math.sin(t));
    }
  });
  const R = rings.length;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j, b = i * segments + (j + 1) % segments;
      const c = (i + 1) * segments + j, d = (i + 1) * segments + (j + 1) % segments;
      idx.push(a, c, b, b, c, d);
    }
  }
  const cap = (ring, top) => {
    const ci = pos.length / 3;
    const rg = rings[ring];
    pos.push(rg.cx || 0, rg.y, rg.cz || 0);
    for (let j = 0; j < segments; j++) {
      const a = ring * segments + j, b = ring * segments + (j + 1) % segments;
      if (top) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  cap(0, false);
  cap(R - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/* Tapered limb segment between two points, with joint spheres. */
function segment(group, a, b, rA, rB, mat) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = new THREE.Vector3().subVectors(vb, va);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(rB, rA, len, 24);
  const m = new THREE.Mesh(geo, mat);
  m.position.copy(va).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  group.add(m);
  for (const [p, r] of [[va, rA], [vb, rB]]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), mat);
    s.position.copy(p);
    s.castShadow = true;
    group.add(s);
  }
}

function buildBody(mat) {
  const g = new THREE.Group();
  const torso = new THREE.Mesh(loft(PARAMS.torsoRings), mat);
  torso.castShadow = true;
  g.add(torso);

  // neck + head
  segment(g, [0, 1440, 0], [0, 1575, 0], 62, 52, mat);
  const head = new THREE.Mesh(new THREE.SphereGeometry(102, 36, 24), mat);
  head.geometry.scale(0.94, 1.2, 0.99);
  head.position.set(0, 1672, 10);
  head.castShadow = true;
  g.add(head);

  for (const s of [1, -1]) {
    // shoulder cap + arm (relaxed A-pose, palms forward)
    const sh = new THREE.Mesh(new THREE.SphereGeometry(62, 20, 14), mat);
    sh.position.set(s * 192, 1398, 0);
    sh.castShadow = true;
    g.add(sh);
    segment(g, [s * 196, 1395, 0], [s * 280, 1175, 12], 56, 43, mat); // upper arm
    segment(g, [s * 280, 1175, 12], [s * 320, 950, 20], 41, 31, mat); // forearm
    const hand = new THREE.Mesh(new THREE.BoxGeometry(64, 150, 32), mat);
    hand.position.set(s * 324, 862, 22);
    hand.rotation.z = s * -0.06;
    hand.castShadow = true;
    g.add(hand);
    // legs
    segment(g, [s * 92, 860, 0], [s * 98, 470, 6], 88, 62, mat);  // thigh
    segment(g, [s * 98, 470, 6], [s * 104, 140, 10], 58, 36, mat); // calf
    const foot = new THREE.Mesh(new THREE.BoxGeometry(78, 58, 205), mat);
    foot.position.set(s * 104, 40, 62);
    foot.castShadow = true;
    g.add(foot);
  }
  return g;
}

/* breast_telemetry/v1 -> mannequin bust parameters (mm). */
export function deriveParams(obj) {
  const notes = [];
  const mp = obj.measured_px, mmpx = obj.scale_model.mm_per_px;
  const ph = obj.modeled_physical;
  let nipLat = Math.abs(mp.right_nipple.x - mp.cleavage_x_at_nipple_height_px) * mmpx;
  let nipUp = (mp.right_fold_y_px - mp.right_nipple.y) * mmpx;
  let moundW = ph.right_mound_width_mm;
  let areolaD = ph.right_areola_diameter_mm;
  const c = (v, a, b, name) => {
    const cl = clamp(v, a, b);
    if (cl !== v) notes.push(name + ' clamped ' + v.toFixed(1) + ' → ' + cl.toFixed(1) + ' mm');
    return cl;
  };
  nipLat = c(nipLat, 40, 150, 'nipple lateral offset');
  nipUp = c(nipUp, 35, 175, 'nipple height above fold');
  moundW = c(moundW, 80, 260, 'mound width');
  areolaD = c(areolaD, 18, 95, 'areola diameter');
  return {
    nipLat, nipUp, moundW, areolaD,
    foldY: PARAMS.foldY,
    cup: obj.cup_estimate.verdict,
    source: obj.source,
    notes,
  };
}

function buildBreasts(group, T, mat, markerMat) {
  const R = T.moundW / 2;
  const nipY = T.foldY + T.nipUp;
  const fz = torsoFrontZ(T.foldY);
  for (const s of [1, -1]) {
    const cx = s * T.nipLat;
    const chestZ = torsoFrontZ(nipY);
    // mound: sphere sunk into the chest wall, apex at nipple height
    const geo = new THREE.SphereGeometry(R, 48, 32);
    geo.scale(1.0, 1.12, 0.78);
    geo.computeVertexNormals();
    const mound = new THREE.Mesh(geo, mat);
    mound.position.set(cx, nipY, chestZ - R * 0.45);
    mound.castShadow = true;
    group.add(mound);
    const apexZ = chestZ - R * 0.45 + R * 0.78;
    // areola: shallow dome on the apex
    const aR = T.areolaD / 2;
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(aR, 32, 12, 0, Math.PI * 2, 0, 0.45), markerMat);
    cap.geometry.rotateX(Math.PI / 2); // dome axis -> +z
    cap.position.set(cx, nipY, apexZ - 1.5);
    group.add(cap);
    // nipple: small bump at the dome centre
    const nR = clamp(T.areolaD * 0.1, 2.5, 6);
    const nip = new THREE.Mesh(new THREE.SphereGeometry(nR, 16, 12), markerMat);
    nip.position.set(cx, nipY, apexZ + aR * 0.1 + nR * 0.5);
    group.add(nip);
    // fold crease: thin tube hugging the under-breast
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(cx - s * R * 0.95, T.foldY - 2, fz + 8),
      new THREE.Vector3(cx, T.foldY - 7, fz + R * 0.3),
      new THREE.Vector3(cx + s * R * 0.95, T.foldY - 2, fz + 8),
    ]);
    const crease = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 1.8, 8), markerMat);
    group.add(crease);
  }
}

export function buildMannequin(T) {
  const mat = new THREE.MeshStandardMaterial({
    color: PARAMS.body, roughness: 0.55, metalness: 0.05,
  });
  const markerMat = new THREE.MeshStandardMaterial({
    color: PARAMS.marker, roughness: 0.6, metalness: 0.05,
  });
  const group = new THREE.Group();
  group.add(buildBody(mat));
  buildBreasts(group, T, mat, markerMat);
  return group;
}
