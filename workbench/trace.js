/* workbench/trace.js — hand-trace polygon utilities.
 *
 * The user draws the body outline with a finger on the photo; the polygon
 * (in photo pixel coordinates) becomes the initial search-region guide for
 * the body-symmetry and breast-telemetry instruments. Pure + DOM-free
 * (node-testable). The trace is a guide, not a measurement: instruments
 * still compute from their own models, but candidates/landmarks outside
 * the traced region are treated as suspect.
 */

const isF = v => typeof v === 'number' && isFinite(v);

// Radial-distance simplification: drop points closer than minDist to the
// last kept point. Keeps a finger stroke light without changing its shape.
export function simplifyStroke(points, minDist) {
  if (!Array.isArray(points) || points.length < 2) return (points || []).slice();
  const kept = [points[0]];
  let [lx, ly] = points[0];
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    if (Math.hypot(x - lx, y - ly) >= minDist) { kept.push(points[i]); lx = x; ly = y; }
  }
  if (kept.length > 1) {
    const [fx, fy] = kept[0], [ex, ey] = kept[kept.length - 1];
    if (fx !== ex || fy !== ey) kept.push([fx, fy]); // close the loop
  }
  return kept;
}

// Ray-casting point-in-polygon. poly: [[x,y],...], closed or not.
export function pointInPolygon(x, y, poly) {
  if (!isF(x) || !isF(y) || !Array.isArray(poly) || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) &&
        x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonBBox(poly) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of poly) {
    if (!isF(x) || !isF(y)) return null;
    if (x < x1) x1 = x; if (y < y1) y1 = y;
    if (x > x2) x2 = x; if (y > y2) y2 = y;
  }
  if (!isFinite(x1) || x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

// Shoelace area (absolute, px^2).
export function polygonArea(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]);
  }
  return Math.abs(a) / 2;
}

// A trace is usable as a region guide when it's a real drawn loop: enough
// points to be a shape (not a tap), non-trivial area (not a dot/scribble),
// and a sane bounding box.
export const TRACE_MIN_POINTS = 8;
export const TRACE_MIN_AREA_FRACTION = 0.005; // 0.5% of the photo

export function traceUsable(trace, w, h) {
  const pts = trace && trace.points;
  if (!Array.isArray(pts) || pts.length < TRACE_MIN_POINTS)
    return { usable: false, reason: 'trace has too few points' };
  const bb = polygonBBox(pts);
  if (!bb) return { usable: false, reason: 'trace bounding box is degenerate' };
  if (!(w > 0 && h > 0)) return { usable: false, reason: 'photo dimensions unknown' };
  const area = polygonArea(pts);
  if (area < TRACE_MIN_AREA_FRACTION * w * h)
    return { usable: false, reason: 'trace area is too small' };
  return {
    usable: true, reason: null,
    bbox: { x1: Math.round(bb.x1), y1: Math.round(bb.y1), x2: Math.round(bb.x2), y2: Math.round(bb.y2) },
    area_fraction: Math.round((area / (w * h)) * 1000) / 1000,
    points: pts.length,
  };
}

// Fraction of landmarks inside the traced region. landmarks: [{x,y}] in
// the same pixel space as the trace.
export function traceLandmarkCoverage(trace, landmarks) {
  const pts = trace && trace.points;
  if (!Array.isArray(pts) || pts.length < 3) return null;
  let inside = 0, total = 0;
  for (const p of landmarks || []) {
    if (!p || !isF(p.x) || !isF(p.y)) continue;
    total++;
    if (pointInPolygon(p.x, p.y, pts)) inside++;
  }
  if (!total) return null;
  return { inside, total, fraction: Math.round((inside / total) * 1000) / 1000 };
}
