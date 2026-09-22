/* workbench/resume-util.js — crash-resume helpers. Pure + DOM-free.
 *
 * The workbench persists the imported photo (downscaled JPEG), the instrument
 * selection, and per-instrument progress to IndexedDB as the run proceeds.
 * If the tab dies mid-run, the next page load offers a one-tap resume that
 * restores completed instruments' cards and runs only what remains.
 */

export const INSTRUMENT_KEYS = ['age', 'tele', 'body', 'bust'];
export const INSTRUMENT_LABELS = { age: 'age', tele: 'telemetry', body: 'body', bust: 'breast' };

// Instrument keys selected but not yet completed, in run order.
export function remainingInstruments(sel, done) {
  const d = new Set(done);
  return INSTRUMENT_KEYS.filter(k => sel[k] && !d.has(k));
}

// Rebuild the visible report from saved per-instrument card HTML,
// in completion order.
export function orderReportHtml(order, htmlByKey) {
  return order.map(k => (htmlByKey && htmlByKey[k]) || '').join('');
}

// Faces are plain data — strip to the fields the resume needs.
export function sanitizeFaces(faces) {
  return (faces || []).map(f => ({ bbox: f.bbox, score: f.score, kps: f.kps }));
}

// One-line banner text for the resume prompt.
export function describeResume(rec) {
  const done = rec.done || [];
  const rem = remainingInstruments(rec.instruments || {}, done);
  const when = rec.startedAt ? new Date(rec.startedAt).toLocaleString() : 'unknown time';
  const name = rec.photoName || 'upload';
  const fmt = ks => ks.map(k => INSTRUMENT_LABELS[k] || k).join(', ') || 'none';
  return 'Interrupted run from ' + when + ' — photo "' + name + '". ' +
    'Completed: ' + fmt(done) + '. Remaining: ' + fmt(rem) + '.';
}
