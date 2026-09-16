/* tools/body/mannequin.js v2 — high-poly parametric mannequin, units in mm.
 *
 * Design: a generic, anonymized, standard-proportion female body. The JSON
 * regenerates ONLY the bust — everything else is fixed default anatomy.
 * The bust is sculpted by displacing the torso mesh itself (no intersecting
 * parts), so the result is one continuous high-poly surface.
 *
 * Measured (from breast_telemetry/v1): nipple lateral offset + height above
 * fold (px deltas × mm/px), areola diameter, mound width (absolute mm).
 * Modeled (labeled as such): apex projection, body proportions, left mirror.
 */
import * as THREE from 'three';

export const PARAMS = {
  body: 0xc9ced6,
  foldY: 1150,
  projectionFactor: 0.45, // MODELED: apex projection = factor × mound half-width
  superP: 0.85,           // cross-section fullness (<1 = fuller than ellipse)
  radialSegments: 176,
  ringSamples: 80,
  // control rings: y, rx (half-width), rz (half-depth), fb (front boost)
  controlRings: [
    { y: 760, rx: 148, rz: 116, fb: 0.00 },
    { y: 820, rx: 165, rz: 126, fb: 0.00 },
    { y: 880, rx: 174, rz: 130, fb: 0.00 },
    { y: 940, rx: 158, rz: 120, fb: 0.01 },
    { y: 1010, rx: 142, rz: 106, fb: 0.01 },
    { y: 1080, rx: 144, rz: 108, fb: 0.02 },
    { y: 1150, rx: 150, rz: 114, fb: 0.02 },
    { y: 1210, rx: 163, rz: 130, fb: 0.05 },
    { y: 1280, rx: 172, rz: 134, fb: 0.06 },
    { y: 1340, rx: 182, rz: 124, fb: 0.04 },
    { y: 1400, rx: 194, rz: 110, fb: 0.02 },
    { y: 1445, rx: 168, rz: 96, fb: 0.00 },
    { y: 1465, rx: 120, rz: 80, fb: 0.00 },
  ],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* breast_telemetry/v1 -> bust parameters (mm). */
export function deriveParams(obj) {
  const notes = [];
  const mp = obj.measured_px, mmpx = obj.scale_model.mm_per_px;
  const ph = obj.modeled_physical;
  const c = (v, a, b, name) => {
    const cl = clamp(v, a, b);
    if (cl !== v) notes.push(name + ' clamped ' + v.toFixed(1) + ' → ' + cl.toFixed(1) + ' mm');
    return cl;
  };
  return {
    nipLat: c(Math.abs(mp.right_nipple.x - mp.cleavage_x_at_nipple_height_px) * mmpx, 40, 150, 'nipple lateral offset'),
    nipUp: c((mp.right_fold_y_px - mp.right_nipple.y) * mmpx, 35, 175, 'nipple height above fold'),
    moundW: c(ph.right_mound_width_mm, 80, 260, 'mound width'),
    areolaD: c(ph.right_areola_diameter_mm, 18, 95, 'areola diameter'),
    foldY: PARAMS.foldY,
    cup: obj.cup_estimate.verdict,
    source: obj.source,
    notes,
  };
}

/* Dense smooth rings from the control table via Catmull-Rom. */
function denseRings() {
  const ctrl = PARAMS.controlRings;
  const curve = new THREE.CatmullRomCurve3(
    ctrl.map(r => new THREE.Vector3(r.y, r.rx, r.rz)), false, 'centripetal');
  const N = PARAMS.ringSamples, rings = [];
  for (let i = 0; i < N; i++) {
    const p = curve.getPoint(i / (N - 1));
    // front-boost lerped from control table
    let fb = 0;
    for (let k = 0; k < ctrl.length - 1; k++) {
      const a = ctrl[k], b = ctrl[k + 1];
      if (p.x >= a.y && p.x <= b.y) { fb = a.fb + (b.fb - a.fb) * (p.x - a.y) / (b.y - a.y); break; }
    }
    rings.push({ y: p.x, rx: p.y, rz: p.z, fb });
  }
  return rings;
}

function superXY(rx, rz, fb, theta) {
  const p = PARAMS.superP;
  const c = Math.cos(theta), s = Math.sin(theta);
  const x = rx * Math.sign(c) * Math.pow(Math.abs(c), p);
  let z = rz * Math.sign(s) * Math.pow(Math.abs(s), p);
  z *= 1 + fb * Math.pow(Math.max(0, s), 2); // fuller front at bust
  return [x, z];
}

/* Build the torso as one continuous mesh, then sculpt the bust into it. */
function buildTorso(T, mat) {
  const rings = denseRings();
  const SEG = PARAMS.radialSegments, R = rings.length;
  const pos = new Float32Array(R * SEG * 3);
  let k = 0;
  rings.forEach(rg => {
    for (let j = 0; j < SEG; j++) {
      const th = (j / SEG) * Math.PI * 2;
      const [x, z] = superXY(rg.rx, rg.rz, rg.fb, th);
      pos[k++] = x; pos[k++] = rg.y; pos[k++] = z;
    }
  });
  const idx = [];
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < SEG; j++) {
      const a = i * SEG + j, b = i * SEG + (j + 1) % SEG;
      const c = (i + 1) * SEG + j, d = (i + 1) * SEG + (j + 1) % SEG;
      idx.push(a, c, b, b, c, d);
    }
  // caps
  const capBase = pos.length / 3;
  const posArr = Array.from(pos);
  const addCap = (ring, top) => {
    const rg = rings[ring], ci = posArr.length / 3;
    posArr.push(0, rg.y, 0);
    for (let j = 0; j < SEG; j++) {
      const a = ring * SEG + j, b = ring * SEG + (j + 1) % SEG;
      if (top) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  addCap(0, false); addCap(R - 1, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals(); // base normals -> displacement direction
  const nrm = geo.attributes.normal.array.slice();
  const col = new Float32Array((posArr.length / 3) * 3).fill(1);

  sculptBust(geo, nrm, col, T);
  sculptGlutes(geo, nrm, T);

  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  return mesh;
}

/* Pure bust displacement profile: offset (mm) at (dx, dy) from the nipple.
 * Positive = outward. Exported for unit testing. */
export function bustOffset(dx, dy, T) {
  const R = T.moundW / 2, H = R * PARAMS.projectionFactor, aR = T.areolaD / 2;
  let off = 0;
  const rv = dy > 0 ? R * 0.95 : R * 1.30; // teardrop: fuller below nipple
  const d2 = Math.pow(dx / R, 2) + Math.pow(dy / rv, 2);
  if (d2 < 1) off += H * Math.pow(Math.cos(Math.sqrt(d2) * Math.PI / 2), 1.15);
  const da = Math.hypot(dx, dy) / aR;
  if (da < 1) off += 1.6 * Math.pow(Math.cos(da * Math.PI / 2), 2);
  const dn = Math.hypot(dx, dy) / 7;
  if (dn < 2.5) off += 5.0 * Math.exp(-dn * dn);
  const fdx = dx / (R * 1.05);
  if (Math.abs(fdx) < 1) {
    const dyf = (dy + T.nipUp) / 10; // == y - foldY
    off -= 2.4 * Math.exp(-dyf * dyf) * Math.pow(Math.cos(fdx * Math.PI / 2), 2);
  }
  return off;
}

/* Sculpt the measured bust into the torso surface. Left mirrored from right. */
function sculptBust(geo, nrm, col, T) {
  const p = geo.attributes.position.array;
  const n = p.length / 3;
  for (const s of [1, -1]) {
    const cx = s * T.nipLat, cy = T.foldY + T.nipUp, aR = T.areolaD / 2;
    const R = T.moundW / 2;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (z < -20) continue;                    // front only
      const dx = x - cx, dy = y - cy;
      if (Math.abs(dx) > R * 1.9) continue;
      if (Math.abs(dy) > R * 2.2) continue;
      const off = bustOffset(dx, dy, T);
      // areola + nipple tint (subtle, keeps the mannequin neutral)
      const da = Math.hypot(dx, dy) / aR;
      if (da < 1) {
        const t = Math.pow(Math.cos(da * Math.PI / 2), 2) * 0.9;
        col[i * 3] = col[i * 3] * (1 - t) + 0.80 * t;
        col[i * 3 + 1] = col[i * 3 + 1] * (1 - t) + 0.66 * t;
        col[i * 3 + 2] = col[i * 3 + 2] * (1 - t) + 0.68 * t;
      }
      const dn = Math.hypot(dx, dy) / 7;
      if (dn < 2.5) {
        const t2 = Math.exp(-dn * dn) * 0.85;
        col[i * 3] = col[i * 3] * (1 - t2) + 0.70 * t2;
        col[i * 3 + 1] = col[i * 3 + 1] * (1 - t2) + 0.56 * t2;
        col[i * 3 + 2] = col[i * 3 + 2] * (1 - t2) + 0.58 * t2;
      }
      if (off !== 0) {
        p[i * 3] += nrm[i * 3] * off;
        p[i * 3 + 1] += nrm[i * 3 + 1] * off;
        p[i * 3 + 2] += nrm[i * 3 + 2] * off;
      }
    }
  }
  geo.attributes.position.needsUpdate = true;
}

/* Subtle glute shaping so the back isn't a flat column. */
function sculptGlutes(geo, nrm) {
  const p = geo.attributes.position.array;
  const n = p.length / 3;
  for (const s of [1, -1]) {
    const bx = s * 88, by = 895;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      if (z > 0) continue;
      const d2 = Math.pow((x - bx) / 72, 2) + Math.pow((y - by) / 88, 2);
      if (d2 < 4) {
        const off = 13 * Math.exp(-d2 * 1.1);
        p[i * 3] += nrm[i * 3] * off;
        p[i * 3 + 1] += nrm[i * 3 + 1] * off;
        p[i * 3 + 2] += nrm[i * 3 + 2] * off;
      }
    }
  }
}

/* Tapered limb segment with joint spheres. */
function segment(group, a, b, rA, rB, mat) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const dir = new THREE.Vector3().subVectors(vb, va);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rB, rA, len, 32), mat);
  m.position.copy(va).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  group.add(m);
  for (const [pt, r] of [[va, rA], [vb, rB]]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), mat);
    s.position.copy(pt);
    s.castShadow = true;
    group.add(s);
  }
}

function buildBody(T, mat) {
  const g = new THREE.Group();
  g.add(buildTorso(T, mat));
  segment(g, [0, 1440, 0], [0, 1575, 0], 62, 52, mat); // neck
  const head = new THREE.Mesh(new THREE.SphereGeometry(102, 48, 32), mat);
  head.geometry.scale(0.94, 1.2, 0.99);
  head.position.set(0, 1672, 10);
  head.castShadow = true;
  g.add(head);
  for (const s of [1, -1]) {
    const sh = new THREE.Mesh(new THREE.SphereGeometry(62, 28, 20), mat);
    sh.position.set(s * 192, 1398, 0);
    sh.castShadow = true;
    g.add(sh);
    segment(g, [s * 196, 1395, 0], [s * 280, 1175, 12], 56, 43, mat);
    segment(g, [s * 280, 1175, 12], [s * 320, 950, 20], 41, 31, mat);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(64, 150, 32), mat);
    hand.position.set(s * 324, 862, 22);
    hand.rotation.z = s * -0.06;
    hand.castShadow = true;
    g.add(hand);
    segment(g, [s * 92, 860, 0], [s * 98, 470, 6], 88, 62, mat);
    segment(g, [s * 98, 470, 6], [s * 104, 140, 10], 58, 36, mat);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(78, 58, 205), mat);
    foot.position.set(s * 104, 40, 62);
    foot.castShadow = true;
    g.add(foot);
  }
  return g;
}

export function triCount(group) {
  let t = 0;
  group.traverse(o => { if (o.isMesh && o.geometry.index) t += o.geometry.index.count / 3; });
  return Math.round(t);
}

export function buildMannequin(T) {
  const mat = new THREE.MeshStandardMaterial({
    color: PARAMS.body, roughness: 0.5, metalness: 0.05, vertexColors: true,
  });
  const group = new THREE.Group();
  group.add(buildBody(T, mat));
  // vertexColors is on: geometries without a color attribute (limbs, head)
  // need an explicit white one or they render black.
  group.traverse(o => {
    if (o.isMesh && !o.geometry.attributes.color) {
      const n = o.geometry.attributes.position.count;
      const white = new Float32Array(n * 3).fill(1);
      o.geometry.setAttribute('color', new THREE.BufferAttribute(white, 3));
    }
  });
  group.userData.material = mat; // wireframe toggle
  group.userData.tris = triCount(group);
  return group;
}
