/* workbench/import.js — standalone JSON import for the workbench.
 *
 * Loads INDEPENDENTLY of app.js (which pulls the transformers / ort / MediaPipe
 * stacks). Importing a report only needs the breast schema validator plus the
 * pure renderers, so this keeps working even when the photo pipeline fails to
 * boot — e.g. a CDN hiccup on the phone.
 */
import { validateBreastTelemetry, SCHEMA as BUST_SCHEMA } from '../attraction/js/breast.js?v=20260920e';
import { esc, card, renderBreast, renderAge, renderTelemetry, renderBody } from './render.js?v=20260920e';

const $ = id => document.getElementById(id);
const setStatus = html => { $('importState').innerHTML = html; };
const okMsg = t => setStatus(esc(t));
const errMsg = t => setStatus('<span class="err">' + esc(t) + '</span>');

// Re-renders a previously exported workbench report (obj.tool === 'workbench').
// Each instrument card renders from the saved data; anything broken renders as
// a note instead of killing the whole import.
function renderImportedReport(obj) {
  const faceIdx = Number.isInteger(obj.subject_a) ? obj.subject_a : 0;
  const ins = obj.instruments;
  const errCard = (title, msg) =>
    card(title, '<p class="note err">' + esc(msg) + '</p>');
  const safe = (title, fn) => {
    try { return fn(); }
    catch (e) { return errCard(title, 'render failed: ' + (e.message || e)); }
  };
  let html = card('imported report',
    '<p class="note">workbench report · generated ' + esc(obj.generated_at || 'unknown') +
    ' · ' + (obj.faces_detected || 0) + ' face(s) detected.</p>');
  if (ins.age) {
    html += ins.age.error ? errCard('age estimation', ins.age.error)
      : safe('age estimation', () => renderAge(ins.age,
          obj.face_a_attributes
            ? { age: obj.face_a_attributes.genderage_age, sex: obj.face_a_attributes.sex }
            : null,
          faceIdx));
  }
  if (ins.telemetry) {
    html += ins.telemetry.error ? errCard('facial telemetry', ins.telemetry.error)
      : (!ins.telemetry.metrics ? errCard('facial telemetry', 'no metrics in imported JSON')
        : safe('facial telemetry', () => renderTelemetry(ins.telemetry, faceIdx)));
  }
  if (ins.breast_telemetry) {
    html += ins.breast_telemetry.error ? errCard('breast telemetry', ins.breast_telemetry.error)
      : safe('breast telemetry', () => renderBreast(ins.breast_telemetry, null));
  }
  if (ins.body_telemetry) {
    // no ratio labels on the import path (render.js stays MediaPipe-free);
    // renderBody falls back to raw key names in stored order.
    html += ins.body_telemetry.error ? errCard('body telemetry', ins.body_telemetry.error)
      : safe('body telemetry', () => renderBody(ins.body_telemetry));
  }
  $('report').innerHTML = html;
  const ec = $('exportcard');
  if (ec) ec.classList.remove('hidden');
}

function importBreast(obj) {
  const v = validateBreastTelemetry(obj);
  if (!v.ok) {
    errMsg('breast_telemetry schema check failed: ' + v.errors.join('; '));
    // Best-effort fallback: still try to render whatever fields exist.
    const rb = $('importRetry');
    rb.innerHTML = '<div style="margin-top:8px"><button class="ghost" id="lenientBtn">render anyway (best effort)</button></div>';
    $('lenientBtn').onclick = () => {
      try {
        $('report').innerHTML = renderBreast(obj, null);
        const ec = $('exportcard');
        if (ec) ec.classList.remove('hidden');
        okMsg('rendered best-effort — some fields are missing vs the strict schema.');
      } catch (e) {
        errMsg('best-effort render failed too: ' + (e.message || e));
      }
      rb.innerHTML = '';
    };
    return;
  }
  $('importRetry').innerHTML = '';
  let html;
  try {
    html = renderBreast(obj, null);
  } catch (e) {
    errMsg('render failed: ' + (e.message || e));
    return;
  }
  $('report').innerHTML = html;
  const ec = $('exportcard');
  if (ec) ec.classList.remove('hidden');
  window.__wbLastReport = {
    generated_at: new Date().toISOString(),
    tool: 'workbench',
    faces_detected: 0,
    subject_a: 0,
    instruments: { breast_telemetry: obj },
    imported_from: BUST_SCHEMA,
  };
  okMsg('imported ' + BUST_SCHEMA + ' — rendered below.');
}

// Accepts either a breast_telemetry/v1 object or a full workbench report.
function importReport(obj) {
  $('importRetry').innerHTML = '';
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errMsg('not a JSON object');
    return;
  }
  if (obj.schema === BUST_SCHEMA) {
    importBreast(obj);
    return;
  }
  if (obj.tool === 'workbench' && obj.instruments && typeof obj.instruments === 'object') {
    const keys = Object.keys(obj.instruments);
    if (!keys.length) {
      errMsg('workbench report has no instruments');
      return;
    }
    try {
      renderImportedReport(obj);
    } catch (e) {
      errMsg('import failed: ' + (e.message || e));
      return;
    }
    window.__wbLastReport = obj;
    okMsg('imported workbench report (' + keys.join(', ') + ') — rendered below.');
    return;
  }
  errMsg('unrecognized JSON — need "tool":"workbench" or "schema":"breast_telemetry/v1".');
}

function importJsonText(text) {
  if (!text || !text.trim()) {
    errMsg('nothing to import — paste JSON or pick a file.');
    return;
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    errMsg('not valid JSON: ' + e.message);
    return;
  }
  importReport(obj);
}

// Called by app.js when a .json file is picked through the photo dropzone.
window.__wbImportText = importJsonText;

$('jsonFile').addEventListener('change', () => {
  const f = $('jsonFile').files[0];
  $('jsonFile').value = ''; // allow re-picking the same file
  if (!f) return;
  okMsg('reading ' + f.name + '…');
  f.text().then(importJsonText, e => errMsg('could not read file: ' + (e.message || e)));
});
$('jsonImportBtn').onclick = () => importJsonText($('jsonPaste').value);

// Boot check: if the photo pipeline (app.js) hasn't booted 12s after this
// module ran, say so — the import above keeps working regardless.
setTimeout(() => {
  if (!window.__wbAppBooted && !window.__wbAppBootWarned) {
    window.__wbAppBootWarned = true;
    const m = $('modelmsg');
    if (m) m.innerHTML = '<span class="err">photo pipeline failed to load ' +
      '(check connection / CDN) — JSON import below still works.</span>';
  }
}, 12000);
