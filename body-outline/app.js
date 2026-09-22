// body-outline — standalone body tracing tool.
//
// Upload one photo → lazy-load the MediaPipe segmentation model → downscale
// to 768px max (the model is 256x256 internally; feeding a full-res iPhone
// photo straight into the GPU delegate is what got the workbench's tab
// Jetsam-killed) → segment → trace the largest person contour → canvas shows
// the photo with the traced outline → metrics card with widths, ratios,
// frame coverage → annotated PNG download.
//
// Honest-caveat contract: the outline traces clothing and hair, NOT the body
// underneath. The comparable unit across photos is the width RATIOS.
import {
  ensureSegmenter, segmentPerson, extractContour, smoothContour,
  silhouetteMetrics, drawOutline, silhouetteLabel,
} from './silhouette.js?v=20260921a';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let img = null;        // loaded HTMLImageElement
let traced = null;     // { contour, metrics, maskW, maskH }
let exportUrl = null;

function setStatus(msg, isErr) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', !!isErr);
}

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  const im = new Image();
  im.onload = () => {
    URL.revokeObjectURL(url);
    img = im;
    traced = null;
    $('stagecard').classList.add('hidden');
    $('metricscard').classList.add('hidden');
    $('dl').classList.add('hidden');
    if (exportUrl) { URL.revokeObjectURL(exportUrl); exportUrl = null; }
    $('run').disabled = false;
    setStatus('photo loaded — ' + im.naturalWidth + '×' + im.naturalHeight + '. hit "trace outline".');
  };
  im.onerror = () => { URL.revokeObjectURL(url); setStatus('could not read that image.', true); };
  im.src = url;
}

const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); }
});
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => {
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
  }
});

$('run').addEventListener('click', async () => {
  if (!img) return;
  $('run').disabled = true;
  traced = null;
  $('stagecard').classList.add('hidden');
  $('metricscard').classList.add('hidden');
  $('dl').classList.add('hidden');
  try {
    // The segmentation model loads on demand — the default page is light.
    const seg = await ensureSegmenter((m) => setStatus(m));
    if (!seg) {
      setStatus('segmentation unavailable on this device/network — the model failed to load.', true);
      $('run').disabled = false;
      return;
    }
    setStatus('segmenting…');
    // Downscale before segmenting: the model is 256x256 internally, no
    // quality is lost, and it keeps iOS Safari's memory budget happy.
    const MAXD = 768, dsc = Math.min(1, MAXD / Math.max(img.naturalWidth, img.naturalHeight));
    const dc = document.createElement('canvas');
    dc.width = Math.max(1, Math.round(img.naturalWidth * dsc));
    dc.height = Math.max(1, Math.round(img.naturalHeight * dsc));
    dc.getContext('2d').drawImage(img, 0, 0, dc.width, dc.height);
    const out = await segmentPerson(dc, seg);
    if (!out || !out.mask || !out.mask.some((v) => v)) {
      setStatus('no person found in this photo — nothing traced.');
      $('run').disabled = false;
      return;
    }
    const loop = extractContour(out.mask, out.w, out.h);
    if (loop.length <= 8) {
      setStatus('no person found in this photo — nothing traced.');
      $('run').disabled = false;
      return;
    }
    const contour = smoothContour(loop, 3);
    const metrics = silhouetteMetrics(out.mask, out.w, out.h, null);
    traced = { contour, metrics };

    // Preview: photo with the traced outline.
    const cv = $('preview');
    const maxW = 640, scale = Math.min(maxW / img.naturalWidth, 1);
    cv.width = Math.round(img.naturalWidth * scale);
    cv.height = Math.round(img.naturalHeight * scale);
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    drawOutline(ctx, contour, cv.width, cv.height,
      { stroke: 'rgba(125,211,252,0.95)', width: 2 });
    $('diag').textContent = diagReport(out, contour, cv, ctx);
    $('diagcard').classList.remove('hidden');
    $('stagecard').classList.remove('hidden');

    renderMetrics(metrics);
    $('metricscard').classList.remove('hidden');
    $('dl').classList.remove('hidden');
    setStatus('traced.');
  } catch (e) {
    setStatus('tracing failed: ' + String((e && e.message) || e), true);
  }
  $('run').disabled = false;
});

// Diagnostics: proves each pipeline stage produced sane output, on the
// user's own device. The stroke self-check scans the preview canvas for
// the cyan stroke color — if the outline drew, this is nonzero.
function diagReport(out, contour, cv, ctx) {
  const L = [];
  let nz = 0;
  for (let i = 0; i < out.mask.length; i++) nz += out.mask[i] ? 1 : 0;
  L.push('mask ' + out.w + 'x' + out.h + ' · person px ' + nz +
         ' (' + (100 * nz / out.mask.length).toFixed(1) + '%)');
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, bad = 0;
  for (const p of contour) {
    if (!p || !isFinite(p[0]) || !isFinite(p[1])) { bad++; continue; }
    if (p[0] < mnx) mnx = p[0]; if (p[0] > mxx) mxx = p[0];
    if (p[1] < mny) mny = p[1]; if (p[1] > mxy) mxy = p[1];
  }
  L.push('contour ' + contour.length + ' pts · bbox x[' + mnx.toFixed(1) + ',' +
         mxx.toFixed(1) + '] y[' + mny.toFixed(1) + ',' + mxy.toFixed(1) +
         '] · bad pts ' + bad);
  const sx = cv.width / 256, sy = cv.height / 256;
  L.push('canvas ' + cv.width + 'x' + cv.height + ' · drawn bbox x[' +
         Math.round(mnx * sx) + ',' + Math.round(mxx * sx) + '] y[' +
         Math.round(mny * sy) + ',' + Math.round(mxy * sy) + ']');
  let cyan = -1;
  try {
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    cyan = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 2] > 170 && d[i + 2] > d[i] + 40 && d[i + 1] > 150) cyan++;
    }
  } catch (e) { L.push('stroke self-check: canvas unreadable'); }
  if (cyan >= 0) L.push('stroke self-check: ' + cyan + ' cyan px on canvas');
  return L.join('\n');
}

function renderMetrics(s) {
  const f = (v) => (typeof v === 'number' ? v.toFixed(3) : '—');
  const row = (k, v) => '<tr><td>' + esc(silhouetteLabel(k)) +
    '</td><td class="num">' + esc(v) + '</td></tr>';
  let h = '<div class="kpi">' +
    '<div><div class="v">' + f(s.shoulder_waist) + '</div><div class="l">shoulder ÷ waist</div></div>' +
    '<div><div class="v">' + f(s.waist_hip) + '</div><div class="l">waist ÷ hip</div></div>' +
    '<div><div class="v">' + f(s.hip_shoulder) + '</div><div class="l">hip ÷ shoulder</div></div>' +
    '<div><div class="v">' + (typeof s.area_fraction === 'number' ? (s.area_fraction * 100).toFixed(1) + '%' : '—') +
    '</div><div class="l">frame covered</div></div></div>';
  h += '<table class="metrics">' +
    row('shoulder_width', s.shoulder_width + ' px @ row ' + s.rows.shoulder) +
    row('waist_width', s.waist_width + ' px @ row ' + s.rows.waist) +
    row('hip_width', s.hip_width + ' px @ row ' + s.rows.hip) +
    row('area_fraction', f(s.area_fraction)) +
    row('bbox_height_fraction', f(s.bbox_height_fraction)) +
    '</table>';
  h += '<p class="note">clothed-silhouette measurements — the outline traces clothing and hair, ' +
    'not the body underneath; the ratios are the comparable unit. ' + esc(s.model || '') + '.</p>';
  $('metrics').innerHTML = h;
}

$('dl').addEventListener('click', () => {
  if (!traced) return;
  // Rebuild at full photo resolution for the download (preview is downscaled).
  const full = document.createElement('canvas');
  full.width = img.naturalWidth; full.height = img.naturalHeight;
  const ctx = full.getContext('2d');
  ctx.drawImage(img, 0, 0);
  drawOutline(ctx, traced.contour, full.width, full.height,
    { stroke: 'rgba(125,211,252,0.95)', width: Math.max(2, full.width / 300) });
  const MAXS = 1200, sc = Math.min(1, MAXS / Math.max(full.width, full.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(full.width * sc));
  out.height = Math.max(1, Math.round(full.height * sc));
  out.getContext('2d').drawImage(full, 0, 0, out.width, out.height);
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  out.toBlob((blob) => {
    if (!blob) { setStatus('export failed.', true); return; }
    exportUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = exportUrl;
    a.download = 'body-outline.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, 'image/png');
});
