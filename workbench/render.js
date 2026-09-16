/* workbench/render.js — pure report-card renderers, shared by app.js and import.js.
 *
 * No model code, no heavyweight imports: importing this module never pulls the
 * transformers/MediaPipe/ort stacks, so the standalone JSON importer can load
 * it even when the photo pipeline fails to boot.
 */
import { drawBreastOverlay, SCHEMA as BUST_SCHEMA } from '../attraction/js/breast.js';

export const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function card(title, inner) {
  return '<div class="card"><h2>' + esc(title) + '</h2>' + inner + '</div>';
}

// telemetry metrics worth surfacing in the unified report (full 17 in JSON)
export const TELEMETRY_SHOW = ['width_height_ratio', 'jaw_to_cheek', 'ipd_to_cheek',
  'eye_w_to_h', 'nose_to_cheek', 'mouth_to_cheek', 'lip_fullness',
  'canthal_tilt_mean', 'gonial_angle_mean', 'mean_asymmetry'];

const METRIC_LABELS = {
  width_height_ratio: 'w:h', jaw_to_cheek: 'jaw:chk', ipd_to_cheek: 'ipd:chk',
  eye_w_to_h: 'eye w:h', nose_to_cheek: 'nose:chk', mouth_to_cheek: 'mth:chk',
  lip_fullness: 'lip full', canthal_tilt_mean: 'tilt',
  gonial_angle_mean: 'gonial°', mean_asymmetry: 'asym',
};

export function renderAge(r, emb, faceIdx) {
  let h = '<div class="kpi">' +
    '<div><div class="v">' + r.expected_age.toFixed(1) + '</div><div class="l">expected age (ViT)</div></div>' +
    '<div><div class="v">' + esc(r.top_bracket) + '</div><div class="l">top bracket · ' +
    (r.top_confidence * 100).toFixed(1) + '%</div></div>';
  if (emb) h += '<div><div class="v">' + emb.age + '</div><div class="l">genderage 2nd opinion · ' +
    esc(emb.sex) + '</div></div>';
  h += '</div><div class="dist">';
  const mx = Math.max(...r.distribution.map(d => d.p));
  for (const d of r.distribution) {
    h += '<div class="drow"><span class="dl">' + esc(d.bracket) + '</span>' +
      '<span class="db"><div style="width:' + (mx ? (d.p / mx * 100).toFixed(1) : 0) + '%"></div></span>' +
      '<span class="dp">' + (d.p * 100).toFixed(1) + '%</span></div>';
  }
  h += '</div><p class="note">' + esc(r.method) + '.</p>';
  return card('age estimation — face ' + (faceIdx + 1), h);
}

export function renderTelemetry(r, faceIdx) {
  let h = '<table class="metrics">';
  for (const k of TELEMETRY_SHOW)
    h += '<tr><td>' + esc(METRIC_LABELS[k] || k) + ' <span class="note">' + esc(k) + '</span></td>' +
      '<td>' + (typeof r.metrics[k] === 'number' ? r.metrics[k].toFixed(3) : esc(r.metrics[k])) + '</td></tr>';
  h += '</table><p class="note">Full 17-metric vector is in the exported JSON. ' +
    esc(r.method) + '.</p>';
  return card('facial telemetry — face ' + (faceIdx + 1), h);
}

export function renderKinship(r) {
  if (r.skipped)
    return card('kinship', '<p class="note">' + esc(r.skipped) + '.</p>');
  let h = '<div class="kpi">' +
    '<div><div class="v">' + r.cosine_similarity.toFixed(4) + '</div><div class="l">cosine similarity</div></div>' +
    '<div><div class="v">' + (r.kinship_confidence * 100).toFixed(1) + '%</div><div class="l">confidence</div></div>' +
    '</div><p style="font-size:17px;font-weight:650;margin:6px 0">' + esc(r.verdict) + '</p>' +
    '<p class="note">' + esc(r.verdict_note) + '</p>';
  for (const c of r.caveats) h += '<div class="cav">' + esc(c) + '</div>';
  h += '<p class="note">Face A: ' + esc(r.predicted.a.sex) + '/' + r.predicted.a.age +
    ' · Face B: ' + esc(r.predicted.b.sex) + '/' + r.predicted.b.age + '. ' +
    esc(r.calibration) + '.</p>';
  return card('kinship — face ' + (r.face_a + 1) + ' vs face ' + (r.face_b + 1), h);
}

// photoImg: an HTMLImageElement for the landmark overlay, or null (pure import).
export function renderBreast(rep, photoImg) {
  const mp = rep.measured_px, sm = rep.scale_model, ph = rep.modeled_physical, ce = rep.cup_estimate;
  const row = (k, v) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>';
  let h = '<p class="note">' + esc(BUST_SCHEMA) + '</p><div class="kpi">' +
    '<div><div class="v">' + esc(ce.verdict) + '</div><div class="l">cup verdict (modeled)</div></div>' +
    '<div><div class="v">' + ph.right_areola_diameter_mm + ' mm</div><div class="l">areola diameter</div></div>' +
    '<div><div class="v">' + ph.right_mound_width_mm + ' mm</div><div class="l">mound width</div></div>' +
    '<div><div class="v">' + sm.mm_per_px + '</div><div class="l">mm/px (nail anchor)</div></div></div>';
  h += '<table class="metrics">' +
    row('nipple (px)', mp.right_nipple.x + ', ' + mp.right_nipple.y) +
    row('areola diameter', mp.right_areola_diameter_px + ' px') +
    row('mound width', mp.right_mound_width_px + ' px') +
    row('nipple → fold', mp.right_nipple_to_fold_px + ' px (fold y=' + mp.right_fold_y_px + ')') +
    row('cleavage x @ nipple height', mp.cleavage_x_at_nipple_height_px + ' px') +
    row('nail anchor', mp.nail_anchor_median_width_px + ' px median') +
    row('band table', Object.entries(ce.band_table).map(([b, c]) => b + ': ' + c).join(' · ')) +
    '</table>';
  h += '<p class="note"><b>method:</b> ' + esc(ce.method) + '</p>';
  h += '<p class="note"><b>assumption:</b> ' + esc(ce.assumption) + ' ' + esc(ce.note) + '</p>';
  h += '<p class="note"><b>scale:</b> ' + esc(sm.assumption) + ' ' + esc(sm.caveat) + '</p>';
  h += '<p class="note"><b>left breast:</b> ' + esc(rep.left_breast.note || JSON.stringify(rep.left_breast)) + '</p>';
  h += '<div class="note"><b>confidence</b><ul style="margin:4px 0;padding-left:18px">';
  for (const [k, v] of Object.entries(rep.confidence))
    h += '<li>' + esc(k) + ': ' + esc(v) + '</li>';
  h += '</ul></div>';
  if (photoImg) {
    h += '<div class="row"><div><canvas class="preview" id="bustOverlay"></canvas></div>' +
      '<div class="note">magenta = areola fit · red = nipple · yellow = cleavage shadow · ' +
      'cyan = mound width · green = fold line.</div></div>';
  }
  const html = card('breast telemetry', h);
  // overlay draws after insertion into the DOM
  if (photoImg) {
    setTimeout(() => {
      const cv = document.getElementById('bustOverlay');
      if (cv) drawBreastOverlay(cv, photoImg, rep);
    }, 0);
  }
  return html;
}
