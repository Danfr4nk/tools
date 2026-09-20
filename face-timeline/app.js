/* face-timeline/app.js — facial telemetry over time.
 *
 * Scan pipeline (mirrors workbench's instrumentTelemetry):
 *   ensureDetector (SCRFD det only) -> detectFaces (../kinship/pipeline.js)
 *   -> auto-pick largest face -> 512px crop -> measureImage
 *   (../attraction/js/measure.js, the 17-ratio diagnostic set)
 *   -> annotatedPngDataUrl (../workbench/face-overlay.js)
 *
 * The pure timeline math (ordering, dating, deltas, deviance) lives in
 * timeline.js and is unit-tested under plain node. This file is browser
 * glue only: model loading, scanning, DOM rendering, drag-reorder,
 * localStorage, export/import. Everything runs on-device; nothing is uploaded.
 */
import {
  ensureLandmarker, landmarkerError,
  detectError, detectLandmarks, measureImage,
} from '../attraction/js/measure.js';
import { computeFaceOverlayData, annotatedPngDataUrl } from '../workbench/face-overlay.js';
import {
  CORE_METRICS, METRIC_LABEL, uid, datingLabel,
  insertEntry, moveEntry, removeEntry,
  incrementalAnalysis, totalAnalysis, devianceSeries,
} from './timeline.js';

(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = window.KinshipPipeline;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

  /* ---------------- constants ---------------- */

  const DET_URL = '../kinship/models/det_10g.onnx';
  const LS_KEY = 'face-timeline/v1';
  const THUMB_SIZE = 192;
  const OVERLAY_TARGET = 768; // annotated PNG long edge (kept modest: 10+ live in memory)
  const DEG_KEYS = new Set(['gonial_angle_mean', 'canthal_tilt_mean']);
  const PP_KEYS = new Set(['brow_eye_dist_pct']); // already a percent: delta in pp

  /* ---------------- state ---------------- */

  let detSession = null, detNames = null, detectReady = false;
  let teleReady = false;
  let entries = [];          // timeline order = source of truth
  let selectedId = null;
  let scanQueue = [];        // File[] waiting to be scanned
  let scanning = false;
  let stagedScan = null;     // finished scan awaiting dating/placement

  // Serialize ort session runs (single-threaded wasm on Pages).
  let runQueue = Promise.resolve();
  const queuedRun = fn => {
    const p = runQueue.then(fn, fn);
    runQueue = p.catch(() => {});
    return p;
  };
  const T = (data, dims) => new ort.Tensor('float32', data, dims);

  /* ---------------- model loading ---------------- */

  async function loadDetect(onp) {
    const r = await fetch(DET_URL);
    if (!r.ok) throw new Error('det model fetch failed: ' + r.status);
    const buf = await r.arrayBuffer();
    onp && onp(1);
    const sess = await ort.InferenceSession.create(buf);
    detSession = {
      det: {
        run: feeds => queuedRun(() => {
          const real = {};
          for (const [k, v] of Object.entries(feeds)) real[k] = T(v.data, v.dims);
          return sess.run(real);
        }),
      },
    };
    detNames = { detIn: sess.inputNames[0], detOut: sess.outputNames };
    detectReady = true;
  }

  async function ensureModels(status) {
    if (!detectReady) {
      status('loading face detector…');
      await loadDetect(() => status('loading face detector… done'));
    }
    if (!teleReady) {
      const lm = await ensureLandmarker(status);
      if (!lm) throw new Error('landmark model failed to load (' + (landmarkerError() || 'unknown') + ')');
      teleReady = true;
    }
  }

  /* ---------------- photo intake + scan ---------------- */

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const im = new Image();
      im.onload = () => {
        const MAXD = 1600;
        const sc = Math.min(1, MAXD / Math.max(im.naturalWidth, im.naturalHeight));
        const w = Math.max(1, Math.round(im.naturalWidth * sc));
        const h = Math.max(1, Math.round(im.naturalHeight * sc));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        const rgb = new Float32Array(w * h * 3);
        for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
          rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2];
        }
        URL.revokeObjectURL(url);
        resolve({ rgb, w, h, img: im });
      };
      im.onerror = () => reject(new Error('could not read image'));
      im.src = url;
    });
  }

  // Expanded square crop around a face bbox, as a canvas.
  function faceCropCanvas(photo, face, size) {
    const [x1, y1, x2, y2] = face.bbox;
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    let side = Math.max(x2 - x1, y2 - y1) * 1.5;
    let sx = Math.max(0, cx - side / 2), sy = Math.max(0, cy - side / 2);
    side = Math.min(side, photo.w - sx, photo.h - sy);
    const src = document.createElement('canvas');
    src.width = photo.w; src.height = photo.h;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(photo.w, photo.h);
    for (let i = 0, j = 0; i < photo.rgb.length; i += 3, j += 4) {
      img.data[j] = photo.rgb[i]; img.data[j + 1] = photo.rgb[i + 1];
      img.data[j + 2] = photo.rgb[i + 2]; img.data[j + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    cv.getContext('2d').drawImage(src, sx, sy, side, side, 0, 0, size, size);
    return cv;
  }

  function canvasToImage(cv) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = cv.toDataURL('image/jpeg', 0.92);
    });
  }

  function thumbDataURL(cropCanvas) {
    const cv = document.createElement('canvas');
    cv.width = THUMB_SIZE; cv.height = THUMB_SIZE;
    cv.getContext('2d').drawImage(cropCanvas, 0, 0, THUMB_SIZE, THUMB_SIZE);
    return cv.toDataURL('image/jpeg', 0.85);
  }

  // Full telemetry scan of one photo. Returns the entry payload (no dating yet).
  async function scanPhoto(file, status) {
    status('reading photo…');
    const photo = await readPhoto(file);
    status('detecting faces…');
    const faces = await P.detectFaces(detSession, detNames, photo.rgb, photo.w, photo.h);
    if (!faces.length) throw new Error('no faces detected');
    const face = faces[0]; // largest first — auto-pick, noted on the entry
    status('measuring face…');
    const cropCanvas = faceCropCanvas(photo, face, 512);
    const cropImg = await canvasToImage(cropCanvas);
    let m = measureImage(cropImg);
    let measuredOn = 'face crop';
    let ovImg = cropImg;
    if (!m) {
      m = measureImage(photo.img);
      measuredOn = 'full photo (crop fallback)';
      ovImg = photo.img;
      if (!m) throw new Error('no landmarks (crop: ' + detectError() + '; full: ' + detectError() + ')');
    }
    let annotated = null;
    try {
      const lm = detectLandmarks(ovImg);
      if (!lm) throw new Error('no landmarks for overlay');
      const d = computeFaceOverlayData(lm);
      if (!d) throw new Error('overlay geometry failed');
      annotated = annotatedPngDataUrl(ovImg, lm, d,
        (file.name || 'photo') + ' · face 1 of ' + faces.length + ' · ' + measuredOn, OVERLAY_TARGET);
    } catch (e) { console.warn('overlay failed:', e); }
    return {
      id: uid(),
      name: file.name || 'photo',
      thumb: thumbDataURL(cropCanvas),
      metrics: m,
      measuredOn,
      faceCount: faces.length,
      faceUsed: 0,
      annotated,
      dating: { mode: 'unknown' },
    };
  }

  async function pumpQueue() {
    if (scanning || !scanQueue.length || stagedScan) return;
    scanning = true;
    const file = scanQueue.shift();
    const total = scanQueue.length + 1;
    try {
      await ensureModels(msg => { $('scanstate').textContent = msg; });
      const entry = await scanPhoto(file, msg => {
        $('scanstate').textContent = msg;
      });
      stagedScan = entry;
      renderStaged();
      $('scanstate').textContent = 'scan complete — date it and place it on the timeline.';
    } catch (e) {
      console.error(e);
      $('scanstate').innerHTML = '<span class="err">scan failed (' + esc(e.message || e) +
        '). The photo was skipped; the rest of the queue continues.</span>';
    }
    scanning = false;
    if (scanQueue.length && !stagedScan) pumpQueue();
    else if (!scanQueue.length) $('scanstate').textContent = $('scanstate').textContent || 'idle.';
  }

  function queueFiles(files) {
    let n = 0;
    for (const f of files) {
      if (f && f.type && f.type.startsWith('image/')) { scanQueue.push(f); n++; }
    }
    if (n) { $('scanstate').textContent = n + ' photo(s) queued…'; pumpQueue(); }
    else $('scanstate').textContent = 'no images in that drop.';
  }

  /* ---------------- formatting ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const sgn = v => (v > 0 ? '+' : '') + v;

  function fmtDelta(key, delta) {
    if (DEG_KEYS.has(key)) return sgn(delta.toFixed(2)) + '°';
    if (PP_KEYS.has(key)) return sgn(delta.toFixed(2)) + ' pp';
    return sgn(delta.toFixed(3));
  }

  function fmtRel(rel) {
    return sgn((rel * 100).toFixed(1)) + '%';
  }

  function fmtDev(v) {
    return Number.isNaN(v) ? '—' : v.toFixed(3);
  }

  function metricValue(key, v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    if (DEG_KEYS.has(key)) return v.toFixed(1) + '°';
    if (PP_KEYS.has(key)) return v.toFixed(1) + '%';
    return v.toFixed(3);
  }

  /* ---------------- dating controls ---------------- */

  // Shared dating-mode controls, used by the staging card and the detail editor.
  // prefix namespaces the element ids.
  function datingControlsHTML(prefix, dating, entriesForAnchors, selfId) {
    const d = dating || { mode: 'unknown' };
    const anchors = (entriesForAnchors || []).filter(e => e.id !== selfId);
    const anchorOpts = anchors.map(e =>
      '<option value="' + e.id + '">' + esc(datingLabel(e, entriesForAnchors)) + '</option>').join('');
    return '' +
      '<label class="fld"><span>dating</span>' +
      '<select id="' + prefix + '-mode">' +
      ['exact', 'year', 'relative', 'unknown'].map(m =>
        '<option value="' + m + '"' + (d.mode === m ? ' selected' : '') + '>' +
        ({ exact: 'exact date', year: 'year only', relative: 'before / after another', unknown: "don't know" })[m] +
        '</option>').join('') +
      '</select></label> ' +
      '<label class="fld" data-when="exact"><span>date</span>' +
      '<input type="date" id="' + prefix + '-date" value="' + esc(d.date || '') + '"></label> ' +
      '<label class="fld" data-when="year"><span>year</span>' +
      '<input type="number" id="' + prefix + '-year" min="1900" max="2100" value="' + esc(d.year || '') + '" placeholder="2019"></label> ' +
      '<span data-when="relative">' +
      '<label class="fld"><span>relation</span><select id="' + prefix + '-rel">' +
      '<option value="before"' + (d.relation === 'before' ? ' selected' : '') + '>before</option>' +
      '<option value="after"' + (d.relation !== 'before' ? ' selected' : '') + '>after</option>' +
      '</select></label> ' +
      '<label class="fld"><span>anchor</span><select id="' + prefix + '-anchor">' + anchorOpts + '</select></label>' +
      '</span>';
  }

  function wireDatingVisibility(prefix) {
    const mode = $(prefix + '-mode');
    const sync = () => {
      document.querySelectorAll('#' + prefix + '-box [data-when]').forEach(el => {
        el.style.display = el.getAttribute('data-when') === mode.value ? '' : 'none';
      });
    };
    mode.onchange = sync;
    sync();
  }

  function readDating(prefix, fallback) {
    const mode = $(prefix + '-mode').value;
    if (mode === 'exact') return { mode, date: $(prefix + '-date').value || null };
    if (mode === 'year') {
      const y = parseInt(($(prefix + '-year').value || ''), 10);
      return { mode, year: Number.isFinite(y) ? y : null };
    }
    if (mode === 'relative') {
      return {
        mode,
        relation: $(prefix + '-rel').value,
        anchorId: $(prefix + '-anchor').value || (fallback && fallback.anchorId) || null,
      };
    }
    return { mode: 'unknown' };
  }

  /* ---------------- persistence ---------------- */

  function save() {
    try {
      // Annotated PNGs live in memory only — they're 100s of KB each and would
      // blow the ~5MB localStorage budget at 10+ entries. Thumbs + metrics +
      // dating persist; overlays re-render on a fresh scan, and export/import
      // carries them as files instead.
      const slim = entries.map(e => {
        const { annotated, ...rest } = e;
        return rest;
      });
      localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, entries: slim }));
    } catch (e) { console.warn('save failed:', e); }
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data && Array.isArray(data.entries)) {
        entries = data.entries.filter(e => e && e.id);
        selectedId = entries.length ? entries[0].id : null;
      }
    } catch (e) { console.warn('load failed:', e); }
  }

  /* ---------------- staging (date + place a fresh scan) ---------------- */

  function renderStaged() {
    const box = $('stagecard');
    if (!stagedScan) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const placeOpts = ['<option value="end">at the end</option>']
      .concat(entries.map((e, i) =>
        '<option value="before:' + e.id + '">before #' + (i + 1) + ' (' + esc(datingLabel(e, entries)) + ')</option>' +
        '<option value="after:' + e.id + '">after #' + (i + 1) + ' (' + esc(datingLabel(e, entries)) + ')</option>'))
      .join('');
    box.innerHTML =
      '<h2>new scan — date it &amp; place it</h2>' +
      '<div class="row"><div><img class="thumb-lg" src="' + stagedScan.thumb + '" alt="face crop"></div>' +
      '<div><div class="note">' + esc(stagedScan.name) + ' · ' + stagedScan.faceCount +
      ' face' + (stagedScan.faceCount === 1 ? '' : 's') + ' detected — using the largest' +
      ' · measured on ' + esc(stagedScan.measuredOn) + '</div>' +
      '<div id="stage-box">' + datingControlsHTML('stage', stagedScan.dating, entries, stagedScan.id) + '</div>' +
      '<div style="margin-top:8px"><label class="fld"><span>placement</span>' +
      '<select id="stage-place">' + placeOpts + '</select></label> ' +
      '<button class="go" id="stage-add" style="font-size:14px;padding:9px 20px">add to timeline</button> ' +
      '<button class="ghost" id="stage-discard">discard</button></div>' +
      '</div></div>';
    wireDatingVisibility('stage');
    $('stage-add').onclick = () => {
      stagedScan.dating = readDating('stage', stagedScan.dating);
      const pv = $('stage-place').value;
      const placement = pv === 'end' ? { at: 'end' }
        : { at: pv.startsWith('before:') ? 'before' : 'after', anchorId: pv.split(':')[1] };
      entries = insertEntry(entries, stagedScan, placement);
      selectedId = stagedScan.id;
      stagedScan = null;
      save();
      renderAll();
      pumpQueue(); // continue with any queued photos
    };
    $('stage-discard').onclick = () => {
      stagedScan = null;
      renderStaged();
      pumpQueue();
    };
  }

  /* ---------------- timeline strip ---------------- */

  function renderStrip() {
    const strip = $('strip');
    if (!entries.length) {
      strip.innerHTML = '<div class="note" style="padding:18px">no photos yet — drop some above.</div>';
      return;
    }
    strip.innerHTML = entries.map((e, i) =>
      '<div class="tcard' + (e.id === selectedId ? ' sel' : '') + (e.metrics ? '' : ' broken') +
      '" data-id="' + e.id + '" data-idx="' + i + '">' +
      '<div class="grip" title="drag to reorder">⠿</div>' +
      '<img class="thumb" src="' + e.thumb + '" alt="" draggable="false">' +
      '<div class="tlabel">#' + (i + 1) + ' · ' + esc(datingLabel(e, entries)) + '</div>' +
      (e.metrics ? '' : '<div class="note err">scan failed</div>') +
      '</div>').join('');
    wireStripDrag(strip);
    strip.querySelectorAll('.tcard').forEach(card => {
      card.addEventListener('click', ev => {
        if (ev.target.closest('.grip')) return;
        selectedId = card.getAttribute('data-id');
        renderStrip(); renderDetail();
      });
    });
  }

  // Pointer-based drag reorder — works with mouse and touch. Only the grip
  // starts a drag (it has touch-action:none); swiping anywhere else scrolls
  // the strip. The dragged card is live-reordered in the DOM for feedback;
  // on drop, moveEntry() commits the same index math to the data.
  function wireStripDrag(strip) {
    let drag = null;
    strip.querySelectorAll('.grip').forEach(grip => {
      grip.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        const card = grip.closest('.tcard');
        drag = {
          card,
          fromIdx: +card.getAttribute('data-idx'),
          targetIdx: +card.getAttribute('data-idx'),
          startX: ev.clientX,
          active: false,
        };
        grip.setPointerCapture(ev.pointerId);
      });
      grip.addEventListener('pointermove', ev => {
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        if (!drag.active && Math.abs(dx) < 8) return; // tap, not drag
        drag.active = true;
        drag.card.classList.add('dragging');
        drag.card.style.transform = 'translateX(' + dx + 'px)';
        drag.card.style.zIndex = '5';
        // insertion slot: first OTHER card whose midpoint is right of the pointer
        const others = [...strip.querySelectorAll('.tcard')].filter(c => c !== drag.card);
        const px = ev.clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
        let t = others.length;
        for (let i = 0; i < others.length; i++) {
          if (px < others[i].offsetLeft + others[i].offsetWidth / 2) { t = i; break; }
        }
        drag.targetIdx = t; // == post-removal insertion index for moveEntry()
        const ref = others[t] || null;
        if (ref) strip.insertBefore(drag.card, ref);
        else strip.appendChild(drag.card);
      });
      const end = () => {
        if (!drag) return;
        const d = drag;
        drag = null;
        d.card.classList.remove('dragging');
        d.card.style.transform = '';
        d.card.style.zIndex = '';
        if (d.active && d.targetIdx !== d.fromIdx) {
          entries = moveEntry(entries, d.fromIdx, d.targetIdx);
          save();
          renderAll();
        }
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    });
  }

  /* ---------------- entry detail ---------------- */

  function renderDetail() {
    const box = $('detailcard');
    const e = entries.find(x => x.id === selectedId);
    if (!e) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const idx = entries.indexOf(e);
    const metricRows = e.metrics ? CORE_METRICS.map(({ key, label }) =>
      '<tr><td>' + esc(label) + '</td><td class="num">' + metricValue(key, e.metrics[key]) + '</td></tr>').join('')
      : '<tr><td colspan="2" class="err">scan failed — no metrics for this entry.</td></tr>';
    box.innerHTML =
      '<h2>entry #' + (idx + 1) + '</h2>' +
      '<div class="row"><div>' +
      '<img class="thumb-lg" src="' + e.thumb + '" alt="face crop">' +
      '<div class="note" style="margin-top:6px">' + esc(e.name) + ' · ' + e.faceCount +
      ' face' + (e.faceCount === 1 ? '' : 's') + ' — using the largest' +
      ' · measured on ' + esc(e.measuredOn || '?') + '</div>' +
      (e.annotated ? '<div style="margin-top:8px"><img class="preview" src="' + e.annotated +
        '" alt="annotated telemetry overlay"></div>' : '') +
      '</div><div>' +
      '<table class="metrics"><tbody>' + metricRows + '</tbody></table>' +
      '<div id="detail-box" style="margin-top:10px">' + datingControlsHTML('detail', e.dating, entries, e.id) + '</div>' +
      '<div style="margin-top:8px"><button class="ghost" id="detail-save">save dating</button> ' +
      '<button class="ghost danger" id="detail-del">delete entry</button></div>' +
      '</div></div>';
    wireDatingVisibility('detail');
    $('detail-save').onclick = () => {
      e.dating = readDating('detail', e.dating);
      save(); renderAll();
    };
    $('detail-del').onclick = () => {
      if (!confirm('delete this entry from the timeline?')) return;
      entries = removeEntry(entries, e.id);
      if (selectedId === e.id) selectedId = entries.length ? entries[0].id : null;
      save(); renderAll();
    };
  }

  /* ---------------- analysis ---------------- */

  function moversHTML(movers) {
    return movers.map(m =>
      '<span class="mover"><b>' + esc(METRIC_LABEL[m.key]) + '</b> ' +
      esc(fmtDelta(m.key, m.delta)) + ' <i>(' + esc(fmtRel(m.rel)) + ')</i></span>').join('');
  }

  function renderAnalysis() {
    const box = $('analysis');
    const measCount = entries.filter(e => e.metrics).length;
    if (measCount < 2) {
      box.innerHTML = '<div class="card"><h2>changes over time</h2>' +
        '<div class="note">add at least two successfully scanned photos — incremental and total deviance appear here.</div></div>';
      return;
    }
    const inc = incrementalAnalysis(entries);
    const tot = totalAnalysis(entries);
    const series = devianceSeries(entries);

    let h = '<div class="card"><h2>changes over time</h2>';
    h += '<div class="note" style="margin-bottom:10px">Aggregate deviance = Euclidean norm of per-metric ' +
      'relative deltas (Δ ÷ baseline) over the 17-metric core set — unit-free, descriptive, not a model of aging. ' +
      'Baseline for totals is entry #1.</div>';
    h += chartSVG(series);

    // incremental cards
    h += '<h3>incremental — each step vs the previous</h3>';
    for (const s of inc) {
      h += '<div class="step"><div class="stephead"><b>#' + (s.fromIndex + 1) + ' → #' + (s.toIndex + 1) + '</b> ' +
        '<span class="note">' + esc(datingLabel(entries[s.fromIndex], entries)) + ' → ' +
        esc(datingLabel(entries[s.toIndex], entries)) + '</span>' +
        '<span class="dev">deviance ' + fmtDev(s.deviance) + '</span></div>' +
        '<div class="movers">' + moversHTML(s.movers) + '</div></div>';
    }
    // total cards
    h += '<h3>total — each entry vs #' + (tot[0] ? tot[0].baselineIndex + 1 : 1) + ' (baseline)</h3>';
    for (const t of tot) {
      h += '<div class="step"><div class="stephead"><b>#' + (t.baselineIndex + 1) + ' → #' + (t.index + 1) + '</b> ' +
        '<span class="note">' + esc(datingLabel(entries[t.index], entries)) + ' vs baseline</span>' +
        '<span class="dev">deviance ' + fmtDev(t.deviance) + '</span></div>' +
        '<div class="movers">' + moversHTML(t.movers) + '</div></div>';
    }
    h += '</div>';

    // sortable delta tables
    h += '<div class="card"><h2>per-metric deltas</h2>' +
      '<div class="note" style="margin-bottom:8px">click a column header to sort by that step\'s |relative change|.</div>';
    h += deltaTable('incremental', inc.map(s => ({
      id: s.fromId + '→' + s.toId,
      label: '#' + (s.fromIndex + 1) + '→#' + (s.toIndex + 1),
      deltas: s.deltas,
    })));
    h += deltaTable('total vs baseline', tot.map(t => ({
      id: t.id, label: '#' + (t.index + 1), deltas: t.deltas,
    })));
    h += '</div>';
    box.innerHTML = h;
    wireSortableTables(box);
  }

  function deltaTable(title, cols) {
    let h = '<h3>' + esc(title) + '</h3><div class="tblwrap"><table class="deltas" data-tbl>';
    h += '<thead><tr><th>metric</th>' + cols.map((c, i) =>
      '<th data-col="' + i + '">' + esc(c.label) + ' <span class="sortmark"></span></th>').join('') + '</tr></thead><tbody>';
    for (const { key, label } of CORE_METRICS) {
      h += '<tr><td>' + esc(label) + '</td>' + cols.map(c => {
        const v = c.deltas[key];
        if (!v || v.rel === null || !isFinite(v.rel)) return '<td class="num">—</td>';
        const cls = v.rel > 0 ? 'up' : (v.rel < 0 ? 'dn' : '');
        return '<td class="num ' + cls + '" data-rel="' + v.rel + '">' +
          esc(fmtDelta(key, v.delta)) + '<br><span class="rel">' + esc(fmtRel(v.rel)) + '</span></td>';
      }).join('') + '</tr>';
    }
    return h + '</tbody></table></div>';
  }

  function wireSortableTables(box) {
    box.querySelectorAll('table.deltas').forEach(tbl => {
      let sortCol = -1, dir = 1;
      tbl.querySelectorAll('thead th[data-col]').forEach(th => {
        th.style.cursor = 'pointer';
        th.onclick = () => {
          const col = +th.getAttribute('data-col');
          dir = (col === sortCol) ? -dir : -1; // first click: biggest movers first
          sortCol = col;
          const rows = [...tbl.querySelectorAll('tbody tr')];
          rows.sort((a, b) => {
            const ra = parseFloat(a.children[col + 1].getAttribute('data-rel') || 'NaN');
            const rb = parseFloat(b.children[col + 1].getAttribute('data-rel') || 'NaN');
            const va = isNaN(ra) ? -Infinity : Math.abs(ra);
            const vb = isNaN(rb) ? -Infinity : Math.abs(rb);
            return dir * (va - vb);
          });
          const tb = tbl.querySelector('tbody');
          rows.forEach(r => tb.appendChild(r));
          tbl.querySelectorAll('.sortmark').forEach(s => s.textContent = '');
          th.querySelector('.sortmark').textContent = dir === -1 ? '▼' : '▲';
        };
      });
    });
  }

  function chartSVG(series) {
    const W = 660, H = 240, PL = 44, PR = 14, PT = 14, PB = 34;
    const n = entries.length;
    const allV = series.incremental.map(p => p.v).concat(series.total.map(p => p.v)).filter(isFinite);
    const maxV = Math.max(0.01, ...allV) * 1.1;
    const X = i => PL + (n <= 1 ? 0 : (i / (n - 1)) * (W - PL - PR));
    const Y = v => PT + (1 - v / maxV) * (H - PT - PB);
    const line = pts => pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join(' ');
    const dots = (pts, color) => pts.map(p =>
      '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="3.5" fill="' + color + '"/>').join('');
    const xlabels = entries.map((e, i) =>
      '<text x="' + X(i).toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle" font-size="10" fill="#8b93a7">#' +
      (i + 1) + '</text>').join('');
    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="aggregate deviance chart">' +
      '<line x1="' + PL + '" y1="' + Y(0) + '" x2="' + (W - PR) + '" y2="' + Y(0) + '" stroke="#2b3a55"/>' +
      '<text x="6" y="' + (Y(maxV / 1.1) + 4) + '" font-size="10" fill="#8b93a7">' + maxV.toFixed(2) + '</text>' +
      '<text x="6" y="' + (Y(0) + 4) + '" font-size="10" fill="#8b93a7">0</text>' +
      (series.total.length ? '<path d="' + line(series.total) + '" fill="none" stroke="#a78bfa" stroke-width="2"/>' + dots(series.total, '#a78bfa') : '') +
      (series.incremental.length ? '<path d="' + line(series.incremental) + '" fill="none" stroke="#7dd3fc" stroke-width="2" stroke-dasharray="5 3"/>' + dots(series.incremental, '#7dd3fc') : '') +
      xlabels +
      '<g font-size="11" fill="#cfd6e4"><circle cx="' + (PL + 6) + '" cy="12" r="4" fill="#7dd3fc"/>' +
      '<text x="' + (PL + 16) + '" y="16">incremental</text>' +
      '<circle cx="' + (PL + 130) + '" cy="12" r="4" fill="#a78bfa"/>' +
      '<text x="' + (PL + 140) + '" y="16">total vs baseline</text></g>' +
      '</svg>';
  }

  /* ---------------- export / import ---------------- */

  function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    if (isIOS) { window.open(url, '_blank'); }
    else {
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function exportJSON() {
    const payload = {
      tool: 'face-timeline', version: 1,
      exportedAt: new Date().toISOString(),
      entries,
    };
    downloadFile('face-timeline.json', JSON.stringify(payload, null, 2));
    $('exportstate').textContent = isIOS ? 'opened in a new tab.' : 'downloaded.';
  }

  function importJSON(text) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error('not valid JSON'); }
    const list = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(list)) throw new Error('no entries array found');
    const clean = list.filter(e => e && typeof e.id === 'string' && e.dating);
    if (!clean.length) throw new Error('no usable entries found');
    // metrics may be missing (failed scans) — allowed; annotated is optional.
    entries = clean.map(e => ({
      id: e.id, name: e.name || 'photo', thumb: e.thumb || '',
      metrics: e.metrics || null, measuredOn: e.measuredOn || null,
      faceCount: e.faceCount || 0, faceUsed: e.faceUsed || 0,
      annotated: e.annotated || null, dating: e.dating,
    }));
    selectedId = entries.length ? entries[0].id : null;
    stagedScan = null;
    save(); renderAll();
  }

  /* ---------------- render all / wiring / boot ---------------- */

  function renderAll() {
    renderStrip();
    renderDetail();
    renderAnalysis();
    $('countline').textContent = entries.length + ' entr' + (entries.length === 1 ? 'y' : 'ies') +
      ' · ' + entries.filter(e => e.metrics).length + ' scanned';
  }

  function wire() {
    const drop = $('drop'), fileInput = $('file');
    drop.onclick = () => fileInput.click();
    drop.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
    fileInput.onchange = () => { queueFiles(fileInput.files); fileInput.value = ''; };
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => {
      e.preventDefault(); drop.classList.remove('over');
      if (e.dataTransfer.files && e.dataTransfer.files.length) queueFiles(e.dataTransfer.files);
    };
    document.addEventListener('paste', e => {
      const items = [...(e.clipboardData?.items || [])].filter(i => i.type.startsWith('image/'));
      if (items.length) queueFiles(items.map(i => i.getAsFile()));
    });
    $('exportbtn').onclick = exportJSON;
    $('importbtn').onclick = () => $('importfile').click();
    $('importfile').onchange = () => {
      const f = $('importfile').files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        try {
          if (entries.length && !confirm('replace the current timeline with the imported one?')) return;
          importJSON(rd.result);
          $('exportstate').textContent = 'imported ' + entries.length + ' entries.';
        } catch (e) { $('exportstate').textContent = 'import failed: ' + e.message; }
      };
      rd.readAsText(f);
      $('importfile').value = '';
    };
    $('clearbtn').onclick = () => {
      if (!entries.length || !confirm('delete the whole timeline? (export first if you want a copy)')) return;
      entries = []; selectedId = null; stagedScan = null;
      save(); renderAll(); renderStaged();
    };
  }

  load();
  wire();
  renderAll();
  renderStaged();
})();
