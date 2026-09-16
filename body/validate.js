/* tools/body/validate.js — breast_telemetry/v1 schema + validation.
 * Mirrors tools/attraction/js/breast.js (validateBreastTelemetry) without
 * pulling the TF-backed measurement pipeline onto this page.
 */
export const SCHEMA = 'breast_telemetry/v1';

const NUM = v => typeof v === 'number' && isFinite(v);

export function validateBreastTelemetry(obj) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };
  need(obj && typeof obj === 'object', 'not a JSON object');
  if (!obj || typeof obj !== 'object') return { ok: false, errors };
  need(obj.schema === SCHEMA, 'schema must be "' + SCHEMA + '" (got ' + JSON.stringify(obj.schema) + ')');
  need(typeof obj.source === 'string', 'missing source');
  need(obj.image && NUM(obj.image.w) && NUM(obj.image.h), 'missing image.{w,h}');
  const mp = obj.measured_px || {};
  need(mp.right_nipple && NUM(mp.right_nipple.x) && NUM(mp.right_nipple.y), 'missing measured_px.right_nipple.{x,y}');
  for (const k of ['right_areola_diameter_px', 'right_mound_width_px', 'right_nipple_to_fold_px',
    'right_fold_y_px', 'cleavage_x_at_nipple_height_px', 'nail_anchor_median_width_px'])
    need(NUM(mp[k]), 'missing measured_px.' + k);
  const sm = obj.scale_model || {};
  need(sm.method && sm.assumption && NUM(sm.mm_per_px) && sm.caveat, 'incomplete scale_model');
  const ph = obj.modeled_physical || {};
  for (const k of ['right_areola_diameter_mm', 'right_mound_width_mm', 'right_nipple_to_fold_mm'])
    need(NUM(ph[k]), 'missing modeled_physical.' + k);
  need(obj.left_breast && typeof obj.left_breast === 'object', 'missing left_breast');
  const ce = obj.cup_estimate || {};
  need(ce.method && ce.assumption && typeof ce.verdict === 'string' && ce.band_table && ce.note,
    'incomplete cup_estimate');
  const cf = obj.confidence || {};
  for (const k of ['areola_diameter', 'mound_width', 'nipple_to_fold', 'physical_mm', 'cup', 'left_breast'])
    need(typeof cf[k] === 'string', 'missing confidence.' + k);
  return { ok: errors.length === 0, errors };
}
