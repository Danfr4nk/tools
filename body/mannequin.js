/* tools/body/mannequin.js v3 — pure bust-sculpt math, no three.js dependency.
 *
 * The body is a baked neutral mesh (body-neutral.obj): MakeHuman CC0 assets —
 * base.obj + ethnicity-averaged female-young macro target + min-cup delta,
 * face defeatured. Units mm, y-up, feet at y=0, +z forward.
 *
 * The JSON regenerates ONLY the bust: apexes are auto-detected on the neutral
 * mesh, the mesh's own small bust is subtracted (neutralBump × moundFalloff),
 * and the measured profile is sculpted in along the surface normals.
 * Bust POSITION follows the base mesh; the JSON drives SHAPE (width,
 * projection, areola, nipple, fold depth). nipLat still feeds the 2D
 * schematic and the readout.
 *
 * Measured (from breast_telemetry/v1): nipple lateral offset + height above
 * fold (px deltas × mm/px), areola diameter, mound width (absolute mm).
 * Modeled (labeled as such): apex projection, bust position, left mirror.
 */

export const PARAMS = {
  body: 0xc9ced6,
  foldY: 1150,            // 2D schematic reference only
  projectionFactor: 0.45, // MODELED: apex projection = factor × mound half-width
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

/* Smooth mound falloff only (no areola/nipple/crease detail), 0..1.
 * Exported so the neutral mesh's own bust can be subtracted with the same shape. */
export function moundFalloff(dx, dy, T) {
  const R = T.moundW / 2;
  const rv = dy > 0 ? R * 0.95 : R * 1.30; // teardrop: fuller below nipple
  const d2 = Math.pow(dx / R, 2) + Math.pow(dy / rv, 2);
  if (d2 >= 1) return 0;
  return Math.pow(Math.cos(Math.sqrt(d2) * Math.PI / 2), 1.15);
}

/* Pure bust displacement profile: offset (mm) at (dx, dy) from the apex.
 * Positive = outward along the surface normal. Exported for unit testing. */
export function bustOffset(dx, dy, T) {
  const R = T.moundW / 2, H = R * PARAMS.projectionFactor, aR = T.areolaD / 2;
  let off = H * moundFalloff(dx, dy, T);
  const da = Math.hypot(dx, dy) / aR;
  if (da < 1) off += 1.6 * Math.pow(Math.cos(da * Math.PI / 2), 2); // areola dome
  const dn = Math.hypot(dx, dy) / 7;
  if (dn < 2.5) off += 5.0 * Math.exp(-dn * dn);                    // nipple
  const fdx = dx / (R * 1.05);
  if (Math.abs(fdx) < 1) {
    const dyf = (dy + T.nipUp) / 10; // == y - foldY
    off -= 2.4 * Math.exp(-dyf * dyf) * Math.pow(Math.cos(fdx * Math.PI / 2), 2); // crease
  }
  return off;
}

/* Apex detection on neutral-mesh positions (Float32Array, mm, feet at y=0).
 * Returns [{ side, x, y, z, wallZ, bump }] — bump = apex z minus chest-wall z. */
export function detectApexes(pos) {
  const n = pos.length / 3;
  const out = [];
  for (const s of [1, -1]) {
    const top = []; // [z, x, y], ascending, capped at 25
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (s * x < 25 || s * x > 220 || y < 950 || y > 1450 || z <= 0) continue;
      if (top.length < 25 || z > top[0][0]) {
        top.push([z, x, y]);
        top.sort((a, b) => a[0] - b[0]);
        if (top.length > 25) top.shift();
      }
    }
    if (!top.length) throw new Error('detectApexes: no apex found on side ' + s);
    const cx = top.reduce((a, p) => a + p[1], 0) / top.length;
    const cy = top.reduce((a, p) => a + p[2], 0) / top.length;
    const cz = top.reduce((a, p) => a + p[0], 0) / top.length;
    // chest wall: median z of front verts near the centreline at apex height
    const wall = [];
    for (let i = 0; i < n; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (z > 50 && Math.abs(x - s * 20) < 18 && Math.abs(y - cy) < 18) wall.push(z);
    }
    wall.sort((a, b) => a - b);
    const wallZ = wall[Math.floor(wall.length / 2)];
    out.push({ side: s, x: cx, y: cy, z: cz, wallZ, bump: cz - wallZ });
  }
  return out;
}

/* Sculpt the measured bust into the neutral mesh.
 * pos/nrm: Float32Array positions + unit normals (same order). Returns
 * { pos, colors } — displaced positions and white-based vertex colors with
 * the subtle areola/nipple tint. Left is mirrored from right by construction
 * (both sides sculpted from the same T). */
export function sculptBust(pos, nrm, T, apexes) {
  const n = pos.length / 3;
  const out = new Float32Array(pos);
  const col = new Float32Array(n * 3).fill(1);
  const R = T.moundW / 2, aR = T.areolaD / 2;
  for (const A of apexes) {
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - A.x, dy = pos[i * 3 + 1] - A.y;
      if (Math.abs(dx) > R * 1.9 || Math.abs(dy) > R * 2.2) continue;
      if (nrm[i * 3 + 2] < 0.35) continue; // front-facing chest wall only
      const off = bustOffset(dx, dy, T) - A.bump * moundFalloff(dx, dy, T);
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
        out[i * 3] += nrm[i * 3] * off;
        out[i * 3 + 1] += nrm[i * 3 + 1] * off;
        out[i * 3 + 2] += nrm[i * 3 + 2] * off;
      }
    }
  }
  return { pos: out, colors: col };
}
