/* tools/body/mannequin.js v3.4 — pure bust-sculpt math, no three.js dependency.
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
 * fold (px deltas × mm/px), areola diameter, mound width (absolute mm),
 * apex projection (modeled_physical.apex_projection_mm, optional — measured
 * from a profile photo, chained via nipple_to_fold_mm so no new anchor needed).
 * v3.4 adds the 3D-geometry package: areola ellipse (semi-axes + major-axis
 * angle → the areola dome and tint go elliptical; tilt_deg is diagnostic only —
 * one photo can't separate areola-plane tilt from camera obliqueness, so it
 * never drives the sculpt), breast contour (nipple-centered radial footprint
 * table in mm → drives moundFalloff wherever the photo resolved a boundary;
 * the modeled elliptical/teardrop footprint fills the gaps), fold curve
 * (measured under-breast boundary across x → the inframammary crease follows
 * the curve instead of a flat line at -nipUp). All three degrade to the old
 * behavior when the JSON predates them.
 * Modeled (labeled as such): apex projection as 0.45 × mound half-width, but
 * ONLY when no measured projection is present; upper-pole fullness (only where
 * the contour gives no boundary), bust position, left mirror always.
 */

export const PARAMS = {
  body: 0xc9ced6,
  foldY: 1150,            // 2D schematic reference only
  projectionFactor: 0.45, // MODELED: apex projection = factor × mound half-width
  upperPole: 1.20,        // MODELED: upper-pole fullness = factor × mound half-width
                          // (vertical falloff radius above the apex; Dan's reference
                          // photos show a gradual, full upper slope from the chest,
                          // not a ski-slope drop)
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* breast_telemetry/v1 -> bust parameters (mm). */
export function deriveParams(obj) {
  const notes = [];
  const mp = obj.measured_px, mmpx = obj.scale_model.mm_per_px;
  const ph = obj.modeled_physical;
  const c = (v, a, b, name) => {
    if (v === null || v === undefined || !isFinite(v))
      throw new Error('deriveParams: ' + name + ' is not finite (scale unresolved?) — got ' + JSON.stringify(v));
    const cl = clamp(v, a, b);
    if (cl !== v) notes.push(name + ' clamped ' + v.toFixed(1) + ' → ' + cl.toFixed(1) + ' mm');
    return cl;
  };
  const moundW = c(ph.right_mound_width_mm, 80, 260, 'mound width');
  // Apex projection: measured wins when the JSON carries it (v3.3 — Dan's
  // Annie-vs-Alexis test showed width-slaved projection erases real shape
  // differences: same teardrop at two scales, sub-visible at body scale).
  const apx = ph.apex_projection_mm;
  const apexMeasured = typeof apx === 'number' && isFinite(apx);
  const apexH = apexMeasured ? c(apx, 10, 90, 'apex projection')
                            : moundW / 2 * PARAMS.projectionFactor;
  const areolaD = c(ph.right_areola_diameter_mm, 18, 95, 'areola diameter');
  // Areola ellipse (measured): semi-axes in mm + major-axis angle. The photo
  // angle is measured from +x toward +y-down; the sculpt's tangent plane is
  // x lateral / y up — the double flip cancels mod π, so the photo angle
  // carries over directly. tilt_deg is diagnostic only (assumes a circular
  // areola; mixes anatomy with camera obliqueness) and never drives the sculpt.
  let areolaEllipse = null;
  const el = mp.right_areola_ellipse;
  if (el && mmpx > 0 && isFinite(el.semi_major_px) && isFinite(el.semi_minor_px) &&
      isFinite(el.major_axis_angle_deg) && el.semi_major_px >= el.semi_minor_px) {
    areolaEllipse = {
      a: c(el.semi_major_px * mmpx, 9, 47.5, 'areola semi-major'),
      b: c(el.semi_minor_px * mmpx, 9, 47.5, 'areola semi-minor'),
      ang: el.major_axis_angle_deg * Math.PI / 180,
      tiltDeg: isFinite(el.tilt_deg) ? el.tilt_deg : null,
    };
  }
  // Breast contour (measured): photo-px polyline → nipple-centered radial
  // footprint table in mm (720 bins, smoothed). Bins with no measured
  // boundary stay NaN and the sculpt falls back to the modeled footprint.
  const nx = mp.right_nipple && isFinite(mp.right_nipple.x) ? mp.right_nipple.x : null;
  const ny = mp.right_nipple && isFinite(mp.right_nipple.y) ? mp.right_nipple.y : null;
  let contourTable = null, contourCoverage = 0, contourMm = null;
  const contour = mp.right_breast_contour_px;
  if (Array.isArray(contour) && contour.length >= 12 && mmpx > 0 && nx !== null) {
    const BINS = 720, raw = new Float64Array(BINS).fill(NaN);
    const pts = [];
    for (const p of contour) {
      if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) continue;
      const dx = (p[0] - nx) * mmpx, dy = (ny - p[1]) * mmpx; // mm, y up
      const r = Math.hypot(dx, dy);
      if (r < 2) continue;
      pts.push({ dx, dy });
      const bin = Math.floor((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * BINS) % BINS;
      if (!(r <= raw[bin])) raw[bin] = r; // max radius wins; NaN-safe
    }
    // circular smooth over valid bins (fills single-bin gaps from neighbors)
    const sm = new Float64Array(BINS).fill(NaN);
    for (let i = 0; i < BINS; i++) {
      let s = 0, n = 0;
      for (let k = -3; k <= 3; k++) {
        const v = raw[(i + k + BINS) % BINS];
        if (isFinite(v)) { s += v; n++; }
      }
      if (n > 0) sm[i] = s / n;
    }
    // interpolate across small NaN gaps (≤40 bins / 20° — sparse sampling);
    // large gaps stay NaN = genuinely unmeasured (the sculpt falls back to
    // the modeled footprint there). Longest gap is the rotation break so
    // interpolation never wraps around it.
    let brk = 0, brkLen = 0;
    {
      let s = -1;
      for (let k = 0; k < 2 * BINS; k++) {
        if (!isFinite(sm[k % BINS])) { if (s < 0) s = k; }
        else {
          if (s >= 0 && k - s > brkLen && k - s <= BINS) { brkLen = k - s; brk = s % BINS; }
          s = -1;
        }
      }
      if (s >= 0 && 2 * BINS - s > brkLen && 2 * BINS - s <= BINS) { brkLen = 2 * BINS - s; brk = s % BINS; }
    }
    const filled = new Float64Array(BINS).fill(NaN);
    let valid = 0;
    {
      const rsm = new Float64Array(BINS), rfill = new Float64Array(BINS).fill(NaN);
      for (let i = 0; i < BINS; i++) rsm[i] = sm[(brk + i) % BINS];
      let i = 0;
      while (i < BINS) {
        if (isFinite(rsm[i])) { rfill[i] = rsm[i]; i++; continue; }
        let j = i + 1;
        while (j < BINS && (j - i) <= 40 && !isFinite(rsm[j])) j++;
        const bounded = j < BINS && isFinite(rsm[j]) && (j - i) <= 40;
        if (bounded && i > 0) {
          const v0 = rfill[i - 1], v1 = rsm[j], gap = j - i;
          for (let k = 0; k < gap; k++) rfill[i + k] = v0 + (v1 - v0) * ((k + 1) / (gap + 1));
        }
        i = j; // unbounded gaps (incl. the leading break gap) stay NaN
      }
      for (let i = 0; i < BINS; i++) {
        filled[(brk + i) % BINS] = rfill[i];
        if (isFinite(rfill[i])) valid++;
      }
    }
    if (valid >= 36 && pts.length >= 12) { // ≥5% angular coverage, else not worth it
      contourTable = filled;
      contourCoverage = valid / BINS;
      // decimated nipple-centered mm points for the 2D schematic overlay
      const step = Math.max(1, Math.floor(pts.length / 120));
      contourMm = pts.filter((_, i) => i % step === 0);
    }
  }
  // Fold curve (measured): under-breast boundary across x, stored as
  // {dx: lateral mm from nipple, depth: mm below nipple}, sorted by dx.
  // The inframammary crease follows it; without it the crease is flat at nipUp.
  let foldCurve = null;
  const fc = mp.right_fold_curve_px;
  if (Array.isArray(fc) && fc.length >= 4 && mmpx > 0 && nx !== null) {
    const pts = [];
    for (const p of fc) {
      if (!Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1])) continue;
      pts.push({ dx: (p[0] - nx) * mmpx, depth: clamp((p[1] - ny) * mmpx, 20, 220) });
    }
    pts.sort((u, v) => u.dx - v.dx);
    if (pts.length >= 4) foldCurve = pts;
  }
  return {
    nipLat: c(Math.abs(mp.right_nipple.x - mp.cleavage_x_at_nipple_height_px) * mmpx, 40, 150, 'nipple lateral offset'),
    nipUp: c((mp.right_fold_y_px - mp.right_nipple.y) * mmpx, 35, 175, 'nipple height above fold'),
    moundW,
    apexH,
    apexMeasured,
    areolaD,
    areolaEllipse,
    contourTable,
    contourCoverage,
    contourMm,
    foldCurve,
    foldY: PARAMS.foldY,
    cup: obj.cup_estimate.verdict,
    source: obj.source,
    notes,
  };
}

/* Areola boundary orientation in the tangent plane (x lateral, y up).
 * side = +1 is the measured (right) breast — world +x is the person's right;
 * the mirrored left breast reflects the major-axis angle across the midline.
 * Returns radians. Only meaningful when T.areolaEllipse exists. */
export function areolaAngle(T, side) {
  const el = T.areolaEllipse;
  if (!el) return 0;
  return side === 1 ? el.ang : Math.PI - el.ang;
}

/* Normalized areola radius: 1 on the boundary, <1 inside. Elliptical when the
 * telemetry carries a measured ellipse, circular (areolaD) fallback otherwise. */
export function areolaR(dx, dy, T, side) {
  const el = T.areolaEllipse;
  if (!el) return Math.hypot(dx, dy) / (T.areolaD / 2);
  const a = areolaAngle(T, side), co = Math.cos(a), si = Math.sin(a);
  const rx = dx * co + dy * si, ry = -dx * si + dy * co; // into ellipse frame
  return Math.hypot(rx / el.a, ry / el.b);
}

/* Fold depth below the nipple (mm, positive) at lateral offset dx.
 * The measured fold curve wins when present; otherwise the single nipUp. */
export function foldDepthAt(T, dx) {
  const fc = T.foldCurve;
  if (!fc || !fc.length) return T.nipUp;
  if (dx <= fc[0].dx) return fc[0].depth;
  const last = fc[fc.length - 1];
  if (dx >= last.dx) return last.depth;
  for (let i = 0; i + 1 < fc.length; i++) {
    const u = fc[i], v = fc[i + 1];
    if (dx >= u.dx && dx <= v.dx) {
      const t = (dx - u.dx) / ((v.dx - u.dx) || 1);
      return u.depth + (v.depth - u.depth) * t;
    }
  }
  return T.nipUp;
}

/* Smooth mound falloff only (no areola/nipple/crease detail), 0..1.
 * Exported so the neutral mesh's own bust can be subtracted with the same shape.
 * Where the telemetry's breast contour resolved a boundary, the footprint IS
 * the measured contour (radial table); everywhere else the modeled
 * elliptical/teardrop footprint fills in. */
export function moundFalloff(dx, dy, T) {
  const R = T.moundW / 2;
  const r = Math.hypot(dx, dy);
  if (r < 1e-9) return 1;
  let Rb = NaN; // measured boundary radius in this direction (mm)
  const ct = T.contourTable;
  if (ct) {
    const BINS = ct.length;
    const f = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI) * BINS;
    const i0 = Math.floor(f) % BINS, fr = f - Math.floor(f);
    const v0 = ct[i0], v1 = ct[(i0 + 1) % BINS];
    if (isFinite(v0) && isFinite(v1)) Rb = v0 + (v1 - v0) * fr;
    else if (isFinite(v0)) Rb = v0;
    else if (isFinite(v1)) Rb = v1;
  }
  if (!isFinite(Rb) || Rb < 4) {
    const rv = dy > 0 ? R * PARAMS.upperPole : R * 1.30; // full upper pole, gentle teardrop below
    const d2 = Math.pow(dx / R, 2) + Math.pow(dy / rv, 2);
    if (d2 >= 1) return 0;
    return Math.pow(Math.cos(Math.sqrt(d2) * Math.PI / 2), 1.15);
  }
  const rn = r / Rb;
  if (rn >= 1) return 0;
  return Math.pow(Math.cos(rn * Math.PI / 2), 1.15);
}

/* Pure bust displacement profile: offset (mm) at (dx, dy) from the apex.
 * Positive = outward along the surface normal. Exported for unit testing.
 * side = +1 measured (right) breast, -1 mirrored left (areola orientation). */
export function bustOffset(dx, dy, T, side = 1) {
  const R = T.moundW / 2;
  // Measured projection (T.apexH) wins when deriveParams resolved one;
  // otherwise fall back to the modeled 0.45 × half-width.
  const H = (typeof T.apexH === 'number' && isFinite(T.apexH)) ? T.apexH : R * PARAMS.projectionFactor;
  let off = H * moundFalloff(dx, dy, T);
  const da = areolaR(dx, dy, T, side);
  if (da < 1) off += 1.6 * Math.pow(Math.cos(da * Math.PI / 2), 2); // areola dome
  const dn = Math.hypot(dx, dy) / 7;
  if (dn < 2.5) off += 5.0 * Math.exp(-dn * dn);                    // nipple
  const fdx = dx / (R * 1.05);
  if (Math.abs(fdx) < 1) {
    const dyf = (dy + foldDepthAt(T, dx)) / 10; // == y - foldY(x)
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
  const R = T.moundW / 2;
  // the measured contour can reach past the modeled footprint window
  const winX = T.contourTable ? R * 2.6 : R * 1.9;
  const winY = T.contourTable ? R * 2.6 : R * 2.2;
  for (const A of apexes) {
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - A.x, dy = pos[i * 3 + 1] - A.y;
      if (Math.abs(dx) > winX || Math.abs(dy) > winY) continue;
      if (nrm[i * 3 + 2] < 0.35) continue; // front-facing chest wall only
      const off = bustOffset(dx, dy, T, A.side) - A.bump * moundFalloff(dx, dy, T);
      // areola + nipple tint (subtle, keeps the mannequin neutral)
      const da = areolaR(dx, dy, T, A.side);
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
