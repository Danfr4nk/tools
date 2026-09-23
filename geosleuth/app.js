// app.js — GEOSLEUTH UI wiring. Imports pure logic from geo.js.
import { CUES, CUE_BY_ID, CUE_GROUPS, scoreCues, regionRollup, parseExif, analyzePixels, suggestCues } from './geo.js';

const $ = id => document.getElementById(id);
const selected = new Set();
let photoName = '', exif = null, heur = null, imgURL = null;

const SINGLE_GROUPS = new Set(['Driving']); // radio behavior

// ---- cue chips ----
const cuesEl = $('cues');
for (const g of CUE_GROUPS) {
  const wrap = document.createElement('div');
  wrap.className = 'cuegroup';
  const lab = document.createElement('div');
  lab.className = 'glabel'; lab.textContent = g;
  wrap.appendChild(lab);
  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const c of CUES.filter(x => x.group === g)) {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.cue = c.id;
    b.innerHTML = `${c.label}${c.hint ? `<small>${c.hint}</small>` : ''}`;
    b.title = c.hint || c.label;
    b.onclick = () => {
      if (SINGLE_GROUPS.has(g)) {
        for (const o of CUES.filter(x => x.group === g)) {
          selected.delete(o.id);
          chips.querySelector(`[data-cue="${o.id}"]`).classList.remove('on');
        }
      }
      if (selected.has(c.id)) { selected.delete(c.id); b.classList.remove('on'); }
      else { selected.add(c.id); b.classList.add('on'); }
      renderVerdict();
    };
    chips.appendChild(b);
  }
  wrap.appendChild(chips);
  cuesEl.appendChild(wrap);
}

function toggleCue(id) {
  const b = cuesEl.querySelector(`[data-cue="${id}"]`);
  if (b && !selected.has(id)) b.click();
  else if (!b) { selected.add(id); renderVerdict(); }
}

// ---- verdict ----
function renderVerdict() {
  const el = $('verdict');
  const ids = [...selected];
  if (ids.length < 3) {
    el.innerHTML = `<p class="dim">Pick at least 3 cues above. <span class="dim small">(${ids.length}/3)</span></p>`;
    return;
  }
  const ranked = scoreCues(ids);
  const regions = regionRollup(ranked);
  const top = ranked.slice(0, 8);
  let html = `<div id="regionline">Best guess region: <b>${regions[0].region}</b>` +
    (regions[1] ? ` <span class="dim small">· ${regions[1].region} ${regions[1].pct}%</span>` : '') + `</div>`;
  top.forEach((r, i) => {
    const c = r.country;
    html += `<div class="vcard${i === 0 ? ' top' : ''}" data-i="${i}">
      <div class="vhead"><span class="vname">${i + 1}. ${c.name}</span><span class="vpct">${r.pct}%</span></div>
      <div class="bar"><div style="width:${r.pct}%"></div></div>
      <div class="tell">${c.tell}</div>
      <div class="vev">
        ${r.matched.map(m => `<div class="m">+ ${m}</div>`).join('')}
        ${r.missed.map(m => `<div class="x">− ${m}</div>`).join('')}
      </div>
    </div>`;
  });
  html += `<p class="dim small">Tap a result to see which cues matched or missed. Confidence is relative to the cues you picked — more cues, sharper verdict.</p>`;
  el.innerHTML = html;
  el.querySelectorAll('.vcard').forEach(v => v.onclick = () => v.classList.toggle('open'));
  el._ranked = ranked;
}

// ---- photo intake ----
const dz = $('dropzone'), fp = $('filepick');
dz.onclick = () => fp.click();
dz.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') fp.click(); };
['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
fp.onchange = () => { const f = fp.files[0]; if (f) loadFile(f); };
document.addEventListener('paste', e => {
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

function loadFile(f) {
  photoName = f.name || 'pasted-image';
  if (imgURL) URL.revokeObjectURL(imgURL);
  imgURL = URL.createObjectURL(f);
  $('preview').src = imgURL;
  $('previewrow').style.display = 'block';
  $('filemeta').textContent = `${photoName} · ${(f.size / 1024).toFixed(0)} KB · ${f.type || 'unknown type'}`;
  // EXIF from raw bytes
  f.arrayBuffer().then(ab => {
    exif = parseExif(new Uint8Array(ab));
    renderAuto();
  });
  // pixels via canvas
  const img = new Image();
  img.onload = () => {
    const max = 900;
    const sc = Math.min(1, max / Math.max(img.width, img.height));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    try {
      const d = ctx.getImageData(0, 0, cv.width, cv.height);
      heur = analyzePixels(d);
    } catch (e) { heur = null; }
    renderAuto();
    URL.revokeObjectURL(img.src);
  };
  img.src = imgURL;
}

function renderAuto() {
  const el = $('auto');
  if (!exif && !heur) { el.innerHTML = '<p class="dim">Scanning…</p>'; return; }
  let html = '<table class="exif">';
  if (exif) {
    html += `<tr><td class="k">EXIF</td><td>${exif.hasExif ? 'present' : 'none found (stripped or PNG)'}</td></tr>`;
    if (exif.make || exif.model) html += `<tr><td class="k">Camera</td><td>${[exif.make, exif.model].filter(Boolean).join(' ')}</td></tr>`;
    if (exif.datetime) html += `<tr><td class="k">Taken</td><td>${exif.datetime.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')}</td></tr>`;
    if (exif.lat != null && exif.lon != null) {
      html += `<tr><td class="k">GPS</td><td><strong>${exif.lat}, ${exif.lon}</strong> — coordinates embedded in the photo</td></tr>`;
      const d = 0.08, mw = $('mapwrap');
      mw.style.display = 'block';
      $('osm').src = `https://www.openstreetmap.org/export/embed.html?bbox=${exif.lon - d}%2C${exif.lat - d}%2C${exif.lon + d}%2C${exif.lat + d}&layer=mapnik&marker=${exif.lat}%2C${exif.lon}`;
      $('gmaps').href = `https://www.google.com/maps/search/?api=1&query=${exif.lat},${exif.lon}`;
    } else if (exif.hasExif) {
      html += `<tr><td class="k">GPS</td><td class="dim">no coordinates — stripped by the sending app, most likely</td></tr>`;
    }
  }
  if (heur) {
    const bits = [];
    bits.push(heur.night ? 'night shot' : 'daytime');
    bits.push(`${Math.round(heur.veg * 100)}% vegetation`);
    bits.push(`${Math.round(heur.sky * 100)}% blue sky (upper frame)`);
    bits.push(heur.warm > 0.05 ? 'warm light' : heur.warm < -0.05 ? 'cool light' : 'neutral light');
    html += `<tr><td class="k">Pixels</td><td>${bits.join(' · ')}</td></tr>`;
  }
  html += '</table>';
  el.innerHTML = html;
  // suggestions → tap-to-add cue chips
  const sg = $('suggest');
  if (heur) {
    const sugs = suggestCues(heur).filter(s => s.cues && s.cues.length);
    if (sugs.length) {
      sg.style.display = 'block';
      sg.innerHTML = '';
      for (const s of sugs) {
        const div = document.createElement('div');
        div.className = 'sug';
        div.innerHTML = `<div>🔎 ${s.label} — add as cue:</div>`;
        const opts = document.createElement('div');
        opts.className = 'opts';
        for (const cid of s.cues) {
          const c = CUE_BY_ID[cid];
          if (!c || selected.has(cid)) continue;
          const b = document.createElement('button');
          b.textContent = c.label;
          b.onclick = () => { toggleCue(cid); div.remove(); if (!sg.children.length) sg.style.display = 'none'; };
          opts.appendChild(b);
        }
        if (!opts.children.length) continue;
        div.appendChild(opts);
        sg.appendChild(div);
      }
      if (!sg.children.length) sg.style.display = 'none';
    }
  }
}

// ---- report ----
function buildMarkdown() {
  const ids = [...selected];
  const ranked = ids.length >= 3 ? scoreCues(ids) : [];
  const L = [];
  L.push(`# GEOSLEUTH report — ${photoName || 'no photo'}`);
  L.push(`_${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC_`, '');
  if (exif) {
    L.push('## EXIF', '');
    L.push(`- EXIF block: ${exif.hasExif ? 'present' : 'absent'}`);
    if (exif.make || exif.model) L.push(`- Camera: ${[exif.make, exif.model].filter(Boolean).join(' ')}`);
    if (exif.datetime) L.push(`- Taken: ${exif.datetime}`);
    if (exif.lat != null) L.push(`- GPS: ${exif.lat}, ${exif.lon}`);
    L.push('');
  }
  if (heur) {
    L.push('## Pixel scan', '');
    L.push(`- ${heur.night ? 'night' : 'daytime'}, ${Math.round(heur.veg * 100)}% vegetation, ${Math.round(heur.sky * 100)}% blue sky, ${heur.warm > 0.05 ? 'warm' : heur.warm < -0.05 ? 'cool' : 'neutral'} light`, '');
  }
  const tx = $('transcribe').value.trim();
  if (tx) { L.push('## Transcribed text', '', `> ${tx}`, ''); }
  L.push('## Cues', '');
  ids.forEach(id => L.push(`- ${CUE_BY_ID[id].label} (${CUE_BY_ID[id].group})`));
  if (!ids.length) L.push('- none selected');
  L.push('');
  if (ranked.length) {
    L.push('## Verdict', '');
    ranked.slice(0, 8).forEach((r, i) => {
      L.push(`${i + 1}. **${r.country.name}** — ${r.pct}%`);
      L.push(`   - matched: ${r.matched.join('; ') || '—'}`);
      if (r.missed.length) L.push(`   - missed: ${r.missed.join('; ')}`);
    });
    const rr = regionRollup(ranked);
    L.push('', `Top region: **${rr[0].region}** (${rr[0].pct}%)`);
  }
  return L.join('\n');
}

$('copymd').onclick = async () => {
  const md = buildMarkdown();
  try { await navigator.clipboard.writeText(md); $('copymd').textContent = 'copied ✓'; }
  catch (e) { $('copymd').textContent = 'copy failed — select manually'; }
  setTimeout(() => $('copymd').textContent = 'copy report (markdown)', 2000);
};
$('dljson').onclick = () => {
  const ids = [...selected];
  const data = {
    tool: 'geosleuth', version: 1, photo: photoName, exported: new Date().toISOString(),
    exif, heuristics: heur, transcribed: $('transcribe').value.trim(),
    cues: ids, verdict: ids.length >= 3 ? scoreCues(ids).slice(0, 8).map(r => ({
      country: r.country.name, code: r.country.id, pct: r.pct, matched: r.matched, missed: r.missed,
    })) : [],
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = 'geosleuth-report.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

renderVerdict();
