/* workbench/render.js — pure report-card renderers, shared by app.js and import.js.
 *
 * No model code, no heavyweight imports: importing this module never pulls the
 * transformers/MediaPipe/ort stacks, so the standalone JSON importer can load
 * it even when the photo pipeline fails to boot.
 */
import { drawBreastOverlay, SCHEMA as BUST_SCHEMA } from '../attraction/js/breast.js?v=20260922c';

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
  let h = '';
  if (r.annotated_png_dataurl)
    h += '<div style="margin-bottom:10px"><img class="preview" src="' + r.annotated_png_dataurl +
      '" alt="face crop with telemetry guidelines"></div>';
  else if (r.overlay_error)
    h += '<p class="note err">annotated picture failed: ' + esc(r.overlay_error) + '</p>';
  h += '<table class="metrics">';
  for (const k of TELEMETRY_SHOW)
    h += '<tr><td>' + esc(METRIC_LABELS[k] || k) + ' <span class="note">' + esc(k) + '</span></td>' +
      '<td>' + (typeof r.metrics[k] === 'number' ? r.metrics[k].toFixed(3) : esc(r.metrics[k])) + '</td></tr>';
  h += '</table><p class="note">Full 17-metric vector is in the exported JSON. ' +
    esc(r.method) + '. Measured on: ' + esc(r.measured_on || 'face crop') + '.</p>';
  return card('facial telemetry — face ' + (faceIdx + 1), h);
}

// ratioKeys + ratioLabelFn come from the caller (attraction/js/body.js) so this
// module never pulls the MediaPipe stack — the standalone JSON importer
// keeps working even when the photo pipeline fails to boot.
export function renderBody(r, ratioKeys, ratioLabelFn) {
  if (!r || r.error)
    return card('body telemetry', '<p class="note err">body telemetry failed: ' +
      esc((r && r.error) || 'unknown error') + '</p>');
  let h = '';
  if (r.pose_png_dataurl)
    h += '<div style="margin-bottom:10px"><img class="preview" src="' + r.pose_png_dataurl +
      '" alt="pose stick figure"></div>';
  if (r.skip_reason)
    h += '<div class="cav">' + esc(r.skip_reason) + ' — full-body ratios need ' +
      'shoulders-through-ankles in frame; the stick figure is drawn from the ' +
      'landmarks that were visible.</div>';
  if (r.ratios) {
    h += '<table class="metrics">';
    for (const k of (ratioKeys || Object.keys(r.ratios)))
      h += '<tr><td>' + esc(ratioLabelFn ? ratioLabelFn(k) : k) +
        ' <span class="note">' + esc(k) + '</span></td><td>' +
        (typeof r.ratios[k] === 'number' ? r.ratios[k].toFixed(3) : esc(r.ratios[k])) + '</td></tr>';
    h += '</table>';
  }
  for (const w of (r.warnings || [])) h += '<div class="cav">' + esc(w) + '</div>';
  h += '<p class="note">' + esc(r.method || '') + '. ' + esc(r.model || '') + '.</p>';
  return card('body telemetry', h);
}

// photoImg: an HTMLImageElement for the landmark overlay, or null (pure import).
// Face anchor readout: the face-predicted body box vs the detected body box.
// r.face_anchor comes from the 7.5-heads canon; r.anchor_check carries the
// pose-bbox validation gate (PASS/SUSPECT); r.anchor_note covers the no-face
// and failure fallbacks. Pure — safe for the JSON importer.
export function renderAnchor(r) {
  if (!r || r.error) return '';
  const a = r.face_anchor, chk = r.anchor_check;
  if (!a) {
    return card('face anchor', '<p class="note">' +
      esc(r.anchor_note || 'no face anchor — body search ran full-frame.') + '</p>');
  }
  const f = (v) => (typeof v === 'number' ? v.toFixed(1) : '—');
  const e = a.expected;
  const ew = e.x2 - e.x1, eh = e.y2 - e.y1;
  let h = '<div class="kpi">' +
    '<div><div class="v">' + f(a.headH) + ' px</div><div class="l">head height · ' + esc(a.source) + '</div></div>' +
    '<div><div class="v">' + f(ew) + '×' + f(eh) + '</div><div class="l">expected body box (px)</div></div>';
  if (chk) {
    const d = chk.detected;
    const dw = d.x2 - d.x1, dh = d.y2 - d.y1;
    h += '<div><div class="v">' + f(dw) + '×' + f(dh) + '</div><div class="l">detected body box (px)</div></div>' +
      '<div><div class="v">' + chk.iou.toFixed(2) + '</div><div class="l">box IoU</div></div>' +
      '<div><div class="v" style="color:' + (chk.pass ? '#22c55e' : '#f87171') + '">' +
      esc(chk.verdict) + '</div><div class="l">validation gate</div></div>';
  }
  h += '</div><table class="metrics">';
  const row = (k, v) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>';
  h += row('anchor source', a.source === 'landmarks' ? 'face landmarks (478-pt)' : 'face bbox only') +
    row('anchor confidence', a.confidence) +
    row('head roll', a.rollDeg.toFixed(1) + '°') +
    row('expected box', '(' + f(e.x1) + ', ' + f(e.y1) + ') → (' + f(e.x2) + ', ' + f(e.y2) + ')');
  if (a.halfBody) h += row('framing', 'half-body crop — the canon body runs below the frame (expected, clipped)');
  else if (a.clipped) h += row('framing', 'expected box clipped at the frame edge');
  if (chk) {
    h += row('width ratio (det/exp)', chk.widthRatio.toFixed(2)) +
      row('height ratio (det/exp)', chk.heightRatio.toFixed(2));
    for (const fl of (chk.failures || []))
      h += row('✗ gate failure', fl);
  } else if (r.anchor_note) {
    h += row('check', r.anchor_note);
  }
  // Hand-trace region guide (Dan's idea): the user's own traced outline is
  // the initial body region — its bbox replaces the pose bbox as the
  // "detected" box in the gate above.
  const tg = r.trace_guide;
  if (tg) {
    h += row('hand trace', tg.points + ' points, ' + Math.round(tg.area_fraction * 100) + '% of frame') +
      row('detected box source', 'your hand-traced outline');
    if (tg.landmark_coverage)
      h += row('pose landmarks inside trace',
        tg.landmark_coverage.inside + '/' + tg.landmark_coverage.total +
        ' (' + Math.round(tg.landmark_coverage.fraction * 100) + '%)');
  }
  h += '</table>';
  if (chk && !chk.pass)
    h += '<div class="cav" style="border-color:#f87171"><b>SUSPECT body read</b> — the detected ' +
      'body box does not match the face-predicted box. Treat the body numbers below as unreliable.</div>';
  h += '<p class="note">anchor = 7.5-heads canon: body height ≈ 7.5 × head height ' +
    '(crown→chin ≈ 1.24 × forehead→chin), shoulders ≈ 2 × head width, centered on the ' +
    'landmark-derived face axis (tilt-corrected), top just below the chin. Gate: IoU ≥ 0.30 ' +
    'and both dimensions within ±40% of expected.</p>';
  return card('face anchor — body box prediction', h);
}

export function renderBreast(rep, photoImg) {
  const mp = rep.measured_px, sm = rep.scale_model, ph = rep.modeled_physical, ce = rep.cup_estimate;
  const row = (k, v) => '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>';
  let h = '<p class="note">' + esc(BUST_SCHEMA) + '</p><div class="kpi">' +
    '<div><div class="v">' + esc(ce.verdict) + '</div><div class="l">cup verdict (modeled)</div></div>' +
    '<div><div class="v">' + ph.right_areola_diameter_mm + ' mm</div><div class="l">areola diameter</div></div>' +
    '<div><div class="v">' + ph.right_mound_width_mm + ' mm</div><div class="l">mound width</div></div>' +
    '<div><div class="v">' + sm.mm_per_px + '</div><div class="l">mm/px (nail anchor)</div></div></div>';
  const chk = rep.body_cross_check;
  if (chk && chk.applicable) {
    const ok = chk.passed;
    h += '<div class="cav" style="border-color:' + (ok ? '#22c55e' : '#f87171') + '">' +
      '<b>body cross-check: ' + (ok ? 'PASS' : 'FAIL') + '</b> — nipple seed vs pose ' +
      'skeleton (shoulders y=' + chk.torso.shoulder_y_px + 'px' +
      (chk.torso.hip_y_px != null ? ', hips y=' + chk.torso.hip_y_px + 'px' : ', hips out of frame') + ').';
    for (const w of (chk.warnings || [])) h += '<br>⚠ ' + esc(w);
    for (const f of (chk.failures || [])) h += '<br>✗ ' + esc(f);
    h += '</div>';
  } else if (chk && chk.reason) {
    h += '<p class="note">body cross-check skipped: ' + esc(chk.reason) + '.</p>';
  }
  h += '<table class="metrics">' +
    row('nipple (px)', mp.right_nipple.x + ', ' + mp.right_nipple.y) +
    row('areola diameter', mp.right_areola_diameter_px + ' px') +
    row('areola ellipse', mp.right_areola_ellipse.semi_major_px + '×' +
      mp.right_areola_ellipse.semi_minor_px + ' px, tilt ~' +
      Math.round(mp.right_areola_ellipse.tilt_deg) + '°') +
    row('breast contour', mp.right_breast_contour_px.length + ' mound-region boundary points') +
    row('fold curve', mp.right_fold_curve_px.length + ' columns') +
    row('mound width', mp.right_mound_width_px + ' px') +
    row('nipple → fold', mp.right_nipple_to_fold_px + ' px (fold y=' + mp.right_fold_y_px + ')') +
    row('cleavage x @ nipple height', mp.cleavage_x_at_nipple_height_px + ' px') +
    row('nail anchor', mp.nail_anchor_median_width_px + ' px median') +
    row('band table', Object.entries(ce.band_table).map(([b, c]) => b + ': ' + c).join(' · ')) +
    (rep.trace_guide ? row('hand trace', rep.trace_guide.points + ' points, ' +
      rep.trace_guide.vetoed_outside + ' rival seed' +
      (rep.trace_guide.vetoed_outside === 1 ? '' : 's') + ' vetoed outside it') : '') +
    '</table>';
  h += '<p class="note"><b>method:</b> ' + esc(ce.method) + '</p>';
  h += '<p class="note"><b>assumption:</b> ' + esc(ce.assumption) + ' ' + esc(ce.note) + '</p>';
  h += '<p class="note"><b>scale:</b> ' + esc(sm.assumption) + ' ' + esc(sm.caveat) + '</p>';
  h += '<p class="note"><b>left breast:</b> ' + esc(rep.left_breast.note || JSON.stringify(rep.left_breast)) + '</p>';
  h += '<p class="note"><a href="../body/" target="_blank" rel="noopener">rebuild this bust on the mannequin →</a></p>';
  h += '<div class="note"><b>confidence</b><ul style="margin:4px 0;padding-left:18px">';
  for (const [k, v] of Object.entries(rep.confidence))
    h += '<li>' + esc(k) + ': ' + esc(v) + '</li>';
  h += '</ul></div>';
  if (photoImg) {
    h += '<div class="row"><div><canvas class="preview" id="bustOverlay"></canvas></div>' +
      '<div class="note">magenta = areola ellipse fit · red = nipple · orange = breast contour · ' +
      'yellow = cleavage shadow · cyan = mound width · green = fold curve.</div></div>';
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
