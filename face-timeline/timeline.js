/* face-timeline/timeline.js — pure timeline math for facial telemetry over time.
 *
 * ZERO DOM, zero imports: every function here is a pure function over plain
 * data, so this module is unit-testable under plain node (see timeline.test.js).
 * The browser glue (detection, scanning, rendering) lives in app.js.
 *
 * Metric set: the 17 scale-invariant ratios returned by measureImage() in
 * ../attraction/js/measure.js — deliberately NOT pixel measures, so photos
 * taken at different distances/resolutions still compare. Labels mirror
 * measure.js's METRIC_LABELS.
 *
 * AGGREGATE DEVIANCE (the one number per step):
 *   deviance(A, B) = sqrt( Σ_k ( (B_k − A_k) / |A_k| )² )
 * over the core metric set, skipping metrics missing on either side or with
 * |A_k| ≈ 0. This is a Euclidean distance in *relative-delta* space: unit-free,
 * so degrees and ratios share one number, and relative, so a photo shot
 * closer/farther still compares. It is a descriptive distance — how far the
 * measured face moved — NOT a model of aging, and it says nothing about which
 * direction is "better". The same formula drives both the incremental series
 * (each entry vs the previous one) and the total series (each entry vs #1).
 */

export const CORE_METRICS = [
  { key: 'width_height_ratio', label: 'w:h' },
  { key: 'jaw_to_cheek', label: 'jaw:chk' },
  { key: 'ipd_to_cheek', label: 'ipd:chk' },
  { key: 'eye_w_to_h', label: 'eye w:h' },
  { key: 'nose_to_cheek', label: 'nose:chk' },
  { key: 'mouth_to_cheek', label: 'mth:chk' },
  { key: 'lip_fullness', label: 'lip full' },
  { key: 'mean_asymmetry', label: 'asym' },
  { key: 'gonial_angle_mean', label: 'gonial°' },
  { key: 'eye_spacing_widths', label: 'eye spc' },
  { key: 'nose_w_to_intercanthal', label: 'nose:ic' },
  { key: 'brow_arch_mean', label: 'brow arch' },
  { key: 'canthal_tilt_mean', label: 'tilt' },
  { key: 'brow_eye_dist_pct', label: 'brw-eye%' },
  { key: 'mouth_to_nose', label: 'mth:nose' },
  { key: 'upper_lower_lip', label: 'u:l lip' },
  { key: 'asymmetry_9', label: 'asym9' },
];

export const METRIC_KEYS = CORE_METRICS.map(m => m.key);
export const METRIC_LABEL = Object.fromEntries(CORE_METRICS.map(m => [m.key, m.label]));

// Unique entry ids. Random + timestamp; collisions are not a correctness
// issue here (ids only key DOM nodes and anchor references).
export function uid() {
  return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- dating ---------------------------------------------------------------
// entry.dating = { mode: 'exact'|'year'|'relative'|'unknown',
//                  date?: 'YYYY-MM-DD', year?: number,
//                  relation?: 'before'|'after', anchorId?: string }
// The timeline ARRAY ORDER is the source of truth for analysis; dating is
// annotation. datingLabel renders one entry's marker for the strip.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function exactLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const mi = +m[2];
  if (mi < 1 || mi > 12 || +m[3] < 1 || +m[3] > 31) return null;
  return MONTHS[mi - 1] + ' ' + (+m[3]) + ', ' + m[1];
}

export function datingLabel(entry, entries = [], seen = null) {
  const d = entry.dating || { mode: 'unknown' };
  if (d.mode === 'exact') {
    const l = exactLabel(d.date);
    if (l) return l;
  } else if (d.mode === 'year') {
    const y = +d.year;
    if (Number.isFinite(y) && y >= 1900 && y <= 2100) return String(Math.trunc(y));
  } else if (d.mode === 'relative' && (d.relation === 'before' || d.relation === 'after') && d.anchorId) {
    // Guard against anchor cycles/deleted anchors.
    seen = seen || new Set();
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      const anchor = entries.find(e => e.id === d.anchorId);
      if (anchor) {
        const al = datingLabel(anchor, entries, seen);
        return d.relation + ' ' + (al === '?' ? 'that photo' : '«' + al + '»');
      }
    }
    return d.relation + ' another photo';
  }
  return '?';
}

// ---- ordering --------------------------------------------------------------

export function insertEntry(entries, entry, placement) {
  const next = entries.slice();
  if (!placement || placement.at === 'end') { next.push(entry); return next; }
  const i = next.findIndex(e => e.id === placement.anchorId);
  if (i === -1) { next.push(entry); return next; }
  next.splice(placement.at === 'before' ? i : i + 1, 0, entry);
  return next;
}

// Drag-reorder index math: remove from fromIdx, clamp toIdx into the
// post-removal array, insert. Pure — the DOM drag handler calls this once
// on pointerup.
export function moveEntry(entries, fromIdx, toIdx) {
  const next = entries.slice();
  if (fromIdx < 0 || fromIdx >= next.length) return next;
  const [e] = next.splice(fromIdx, 1);
  const t = Math.max(0, Math.min(toIdx, next.length));
  next.splice(t, 0, e);
  return next;
}

export function removeEntry(entries, id) {
  return entries.filter(e => e.id !== id);
}

// ---- delta engine -----------------------------------------------------------

// Per-metric absolute + relative deltas between two metric objects.
// Missing/non-finite values yield null (honest gap, not zero).
export function deltasFor(a, b) {
  const out = {};
  for (const k of METRIC_KEYS) {
    const x = a[k], y = b[k];
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) {
      out[k] = null;
      continue;
    }
    out[k] = { delta: y - x, rel: Math.abs(x) < 1e-9 ? null : (y - x) / Math.abs(x) };
  }
  return out;
}

// Aggregate deviance — see the module header for the formula and its limits.
export function deviance(a, b) {
  let s = 0, n = 0;
  for (const k of METRIC_KEYS) {
    const x = a[k], y = b[k];
    if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) continue;
    if (Math.abs(x) < 1e-9) continue;
    const r = (y - x) / Math.abs(x);
    s += r * r;
    n++;
  }
  return n ? Math.sqrt(s) : NaN;
}

// Top-N movers by |relative delta| — the metrics that changed most, whatever
// their units.
export function topMovers(deltas, n = 5) {
  return Object.entries(deltas)
    .filter(([, v]) => v && v.rel !== null && isFinite(v.rel))
    .sort((a, b) => Math.abs(b[1].rel) - Math.abs(a[1].rel))
    .slice(0, n)
    .map(([key, v]) => ({ key, delta: v.delta, rel: v.rel }));
}

// Incremental: each consecutive pair. Entries missing metrics are skipped
// (their neighbors still pair across the gap is WRONG — skip the pair, keep
// the chain honest: only adjacent measurable entries form a step).
export function incrementalAnalysis(entries) {
  const steps = [];
  for (let i = 0; i + 1 < entries.length; i++) {
    const A = entries[i], B = entries[i + 1];
    if (!A.metrics || !B.metrics) continue; // a failed scan breaks the chain
    const deltas = deltasFor(A.metrics, B.metrics);
    steps.push({
      fromId: A.id, toId: B.id,
      fromIndex: i, toIndex: i + 1,
      deviance: deviance(A.metrics, B.metrics),
      deltas,
      movers: topMovers(deltas),
    });
  }
  return steps;
}

// A failed scan breaks the incremental chain rather than silently bridging
// across it: steps only form between adjacent, measurable entries.

export function totalAnalysis(entries) {
  const meas = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.metrics);
  if (!meas.length) return [];
  const base = meas[0];
  return meas.slice(1).map(({ e, i }) => {
    const deltas = deltasFor(base.e.metrics, e.metrics);
    return {
      id: e.id, index: i, baselineId: base.e.id, baselineIndex: base.i,
      deviance: deviance(base.e.metrics, e.metrics),
      deltas,
      movers: topMovers(deltas),
    };
  });
}

// Chart-ready series: incremental deviance keyed by step midpoint position,
// total deviance keyed by entry index (baseline = 0 at its own index).
export function devianceSeries(entries) {
  const inc = incrementalAnalysis(entries).map(s => ({
    x: (s.fromIndex + s.toIndex) / 2, v: s.deviance, fromId: s.fromId, toId: s.toId,
  }));
  const tot = totalAnalysis(entries).map(t => ({ x: t.index, v: t.deviance, id: t.id }));
  const meas = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.metrics);
  if (meas.length) tot.unshift({ x: meas[0].i, v: 0, id: meas[0].e.id, baseline: true });
  return { incremental: inc, total: tot };
}
