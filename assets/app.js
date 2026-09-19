/* tools — site shell.
 *
 * Renders the rack from assets/registry.js, wires the command palette, the
 * dependency map and the vault. Nothing here is imported by an instrument;
 * this file only ever reads instrument state, and only writes localStorage
 * when the vault's import is explicitly confirmed.
 */

import { INSTRUMENTS, HUBS, DOMAINS, DEPS, BY_ID, META } from './registry.js';
import * as vault from './vault.js';
import { card, wireCards, esc as escHtml } from './cards.js';
import { mountMap } from './map.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = escHtml;
const PREFS = 'tools.site.v1';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------------------------------------------------------- prefs */
const prefs = Object.assign(
  { view: 'rack', theme: 'dark', domain: 'all', facets: [], recent: [] },
  (() => { try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch (e) { return {}; } })()
);
function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) {} }

/* ---------------------------------------------------------------- state */
let SCAN = { ok: false, known: [], foreign: [], bytes: 0 };
let STATE = {};
function rescan() {
  SCAN = vault.scan();
  STATE = SCAN.ok ? vault.byTool(SCAN) : {};
}

/* ---------------------------------------------------------------- toast */
let toastT;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!err);
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), err ? 5200 : 2600);
}

/* ---------------------------------------------------------------- rack */
function passes(i) {
  if (prefs.domain !== 'all' && i.domain !== prefs.domain) return false;
  for (const f of prefs.facets) {
    if (f === 'device' && !i.posture.device) return false;
    if (f === 'offline' && i.posture.net !== 'none') return false;
    if (f === 'data' && !(STATE[i.id] && STATE[i.id].keys)) return false;
  }
  return true;
}

function renderRack() {
  const list = INSTRUMENTS.filter(passes);
  $('#rack').innerHTML = list.length
    ? list.map((i) => card(i, INSTRUMENTS.indexOf(i) + 1, STATE)).join('')
    : `<p class="dnote" style="grid-column:1/-1">Nothing matches that combination. <button class="btn" id="clearf">clear filters</button></p>`;
  $('#count').textContent = `${list.length} / ${INSTRUMENTS.length} instruments`;
  const cf = $('#clearf');
  if (cf) cf.onclick = () => { prefs.domain = 'all'; prefs.facets = []; savePrefs(); renderFilters(); renderManifest(); renderRack(); };

  wireCards($('#rack'), (id) => { const i = BY_ID[id]; if (i) go(i); });
}

function renderFilters() {
  const dom = [{ id: 'all', label: 'ALL' }, ...DOMAINS];
  $('#domains').innerHTML = dom.map((d) =>
    `<button class="chip" data-domain="${d.id}" aria-pressed="${prefs.domain === d.id}">${esc(d.label)}</button>`).join('');
  $$('#domains .chip').forEach((b) => b.onclick = () => {
    prefs.domain = b.dataset.domain; savePrefs(); renderFilters(); renderManifest(); renderRack();
  });
  const facets = [
    { id: 'device', label: 'ON-DEVICE' },
    { id: 'offline', label: 'NO NETWORK' },
    { id: 'data', label: 'HAS MY DATA' },
  ];
  $('#facets').innerHTML = facets.map((f) =>
    `<button class="chip facet" data-facet="${f.id}" aria-pressed="${prefs.facets.includes(f.id)}">${esc(f.label)}</button>`).join('');
  $$('#facets .chip').forEach((b) => b.onclick = () => {
    const f = b.dataset.facet;
    prefs.facets = prefs.facets.includes(f) ? prefs.facets.filter((x) => x !== f) : [...prefs.facets, f];
    savePrefs(); renderFilters(); renderRack();
  });
}

function go(i, newTab) {
  prefs.recent = [i.id, ...prefs.recent.filter((x) => x !== i.id)].slice(0, 6);
  savePrefs();
  if (newTab || i.external) window.open(i.href, '_blank', 'noopener');
  else location.href = i.href;
}

/* ---------------------------------------------------------------- manifest */
/* Domain roll-up in the hero — doubles as the coarsest filter there is. */
function renderManifest() {
  const el = $('#manifest');
  el.innerHTML = DOMAINS.map((d) => {
    const list = INSTRUMENTS.filter((i) => i.domain === d.id);
    const withData = list.filter((i) => STATE[i.id] && STATE[i.id].keys).length;
    return `<button data-domain="${d.id}" aria-pressed="${prefs.domain === d.id}" style="--c:var(--d-${d.id})"
      title="${list.length} instrument${list.length === 1 ? '' : 's'}${withData ? `, ${withData} holding saved state` : ''}">
      <i></i><span>${esc(d.label)}</span><b>${list.length}${withData ? `<span style="color:var(--d-${d.id})"> ●</span>` : ''}</b></button>`;
  }).join('');
  $$('#manifest button').forEach((b) => b.onclick = () => {
    prefs.domain = prefs.domain === b.dataset.domain ? 'all' : b.dataset.domain;
    savePrefs(); renderFilters(); renderManifest(); renderRack();
    setView('rack');
    $('#view-rack').scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
  });
}

/* ---------------------------------------------------------------- resume */
function renderResume() {
  const rows = Object.entries(STATE)
    .filter(([id, s]) => BY_ID[id] && s.keys)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 4);
  const el = $('#resume');
  if (!rows.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span class="h">PICK UP WHERE YOU LEFT OFF</span>` + rows.map(([id, s]) => {
    const i = BY_ID[id];
    return `<a href="${esc(i.href)}">${esc(i.name)} <small>${esc(s.bits[0] || vault.fmtBytes(s.bytes))}</small></a>`;
  }).join('');
}

/* ---------------------------------------------------------------- statline */
function renderStat() {
  const onDevice = INSTRUMENTS.filter((i) => i.posture.device).length;
  const offline = INSTRUMENTS.filter((i) => i.posture.net === 'none').length;
  const withData = Object.keys(STATE).filter((k) => BY_ID[k]).length;
  $('#statline').innerHTML = [
    `<span class="live">●</span> <b>${INSTRUMENTS.length}</b> instruments online`,
    `<b>${onDevice}</b> compute on-device`,
    `<b>${offline}</b> need no network at all`,
    SCAN.ok
      ? `<b>${vault.fmtBytes(SCAN.bytes)}</b> of your state held locally across <b>${withData}</b>`
      : `local state unreadable here`,
    `no accounts · no tracking · no service worker`,
  ].map((s) => `<span>${s}</span>`).join('');
}

/* ---------------------------------------------------------------- scope */
/* The header strip is a readout, not decoration: one bar per instrument,
   height driven by how many bytes of your own state that instrument is
   holding. Click a bar to jump to its card. */
function mountScope(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, t = 0, raf = 0, hot = -1;
  const bars = () => INSTRUMENTS.map((i) => {
    const s = STATE[i.id];
    const b = s ? s.bytes : 0;
    return { i, v: b ? Math.min(1, Math.log10(b + 1) / 5.2) : 0 };
  });
  let data = bars();

  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    paint();
  }
  const varOf = (d) => getComputedStyle(document.documentElement).getPropertyValue('--d-' + d).trim() || '#2dd4bf';

  function paint() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = data.length, gap = 3;
    const bw = Math.max(2, (W - gap * (n - 1)) / n);
    const base = H - 12;
    /* baseline */
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#17222e';
    ctx.beginPath(); ctx.moveTo(0, base + .5); ctx.lineTo(W, base + .5); ctx.stroke();

    data.forEach((d, k) => {
      const x = k * (bw + gap);
      const pulse = reduceMotion ? 0 : (Math.sin((t / 34) + k * 0.7) + 1) / 2;
      const floor = 5 + pulse * 3;
      const h = d.v ? floor + d.v * (base - 16) : floor;
      const col = varOf(d.i.domain);
      ctx.globalAlpha = d.v ? 1 : .26;
      if (k === hot) ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.fillRect(x, base - h, bw, h);
      if (d.v) { ctx.globalAlpha = .28; ctx.fillRect(x, base - h - 3, bw, 2); }
      ctx.globalAlpha = 1;
    });

    /* sweep */
    if (!reduceMotion) {
      const sx = ((t / 2.2) % (W + 160)) - 80;
      const g = ctx.createLinearGradient(sx - 70, 0, sx + 70, 0);
      const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() || '#2dd4bf';
      g.addColorStop(0, 'transparent'); g.addColorStop(.5, acc); g.addColorStop(1, 'transparent');
      ctx.globalAlpha = .13; ctx.fillStyle = g; ctx.fillRect(sx - 70, 0, 140, H); ctx.globalAlpha = 1;
    }
  }
  function loop() { t += 1; paint(); raf = requestAnimationFrame(loop); }

  canvas.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    const n = data.length, gap = 3, bw = Math.max(2, (W - gap * (n - 1)) / n);
    const k = Math.floor((ev.clientX - r.left) / (bw + gap));
    hot = (k >= 0 && k < n) ? k : -1;
    canvas.title = hot >= 0
      ? `${data[hot].i.name} — ${data[hot].v ? vault.fmtBytes(STATE[data[hot].i.id].bytes) + ' saved locally' : 'no local state'}`
      : '';
    if (reduceMotion) paint();
  });
  canvas.addEventListener('click', () => {
    if (hot < 0) return;
    const i = data[hot].i;
    prefs.domain = 'all'; prefs.facets = []; savePrefs(); renderFilters(); renderManifest(); renderRack();
    setView('rack');
    const el = $(`#rack .mod[data-id="${i.id}"]`);
    if (el) { el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' }); el.focus({ preventScroll: true }); }
  });

  new ResizeObserver(size).observe(canvas);
  size();
  if (!reduceMotion) loop();
  return { refresh() { data = bars(); paint(); } };
}

/* ---------------------------------------------------------------- views */
let MAP = null;
function setView(v) {
  prefs.view = v; savePrefs();
  $('#view-rack').hidden = v !== 'rack';
  $('#view-map').hidden = v !== 'map';
  $('#btn-map').setAttribute('aria-pressed', String(v === 'map'));
  $('#btn-map .t').textContent = v === 'map' ? 'RACK' : 'MAP';
  if (v === 'map' && !MAP) {
    MAP = mountMap($('#mapcanvas'), {
      tip: $('#maptip'),
      onOpen: (n) => { const i = BY_ID[n.id]; if (i) go(i); },
    });
    $('#map-reset').onclick = () => MAP.reset();
  } else if (v === 'map' && MAP) MAP.refresh();
}

/* ---------------------------------------------------------------- palette */
function paletteEntries() {
  const out = [];
  for (const i of INSTRUMENTS) {
    out.push({ kind: 'instrument', id: i.id, name: i.name, hint: i.kicker, href: i.href, ext: !!i.external, group: 'INSTRUMENTS', hay: [i.name, i.kicker, i.domain, i.href, ...(i.kw || []), ...(i.facts || [])].join(' ').toLowerCase() });
    for (const s of i.subs || [])
      out.push({ kind: 'sub', name: s.label, hint: `${i.name} · ${s.note || ''}`.trim(), href: s.href, ext: !!s.ext, group: 'DEEP LINKS', hay: [s.label, s.note, i.name].join(' ').toLowerCase() });
  }
  for (const h of HUBS) out.push({ kind: 'hub', name: h.name, hint: h.note, href: h.href, group: 'INDEXES', hay: (h.name + ' ' + h.note).toLowerCase() });
  for (const [id, d] of Object.entries(DEPS)) {
    const users = INSTRUMENTS.filter((i) => (i.deps || []).includes(id));
    if (!users.length) continue;
    out.push({ kind: 'dep', id, name: d.label, hint: `${d.kind} · used by ${users.length}`, group: 'DEPENDENCIES', hay: (d.label + ' ' + d.note + ' ' + d.kind).toLowerCase() });
  }
  out.push(
    { kind: 'action', name: 'Open the vault', hint: 'inspect, back up and restore local state', act: 'vault', group: 'ACTIONS', hay: 'vault backup export import localstorage data' },
    { kind: 'action', name: 'Download a full backup', hint: 'every instrument’s saved state, one file', act: 'export', group: 'ACTIONS', hay: 'backup export download json save' },
    { kind: 'action', name: 'Toggle the dependency map', hint: 'what shares a model with what', act: 'map', group: 'ACTIONS', hay: 'map graph dependency network model' },
    { kind: 'action', name: 'Toggle daylight mode', hint: 'high contrast, for reading outdoors', act: 'theme', group: 'ACTIONS', hay: 'theme light dark daylight contrast sun' },
    { kind: 'action', name: 'Keyboard shortcuts', hint: 'every key this page listens for', act: 'help', group: 'ACTIONS', hay: 'help keys shortcuts keyboard' },
    { kind: 'action', name: 'Source on GitHub', hint: META.repo, href: META.repo, ext: true, group: 'ACTIONS', hay: 'github source repo code' },
  );
  return out;
}
const ENTRIES = paletteEntries();

/* subsequence match — cheap, forgiving, and highlights what it matched */
function fuzzy(q, name, hay) {
  if (!q) return { score: 0, marks: null };
  const ql = q.toLowerCase(), nl = name.toLowerCase();
  if (nl.startsWith(ql)) return { score: 1000 - nl.length, marks: [0, ql.length] };
  const at = nl.indexOf(ql);
  if (at >= 0) return { score: 800 - at, marks: [at, at + ql.length] };
  let qi = 0, last = -1, gaps = 0;
  for (let i = 0; i < nl.length && qi < ql.length; i++) {
    if (nl[i] === ql[qi]) { if (last >= 0) gaps += i - last - 1; last = i; qi++; }
  }
  if (qi === ql.length) return { score: 500 - gaps, marks: null };
  if (hay.includes(ql)) return { score: 200, marks: null };
  const words = ql.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => hay.includes(w))) return { score: 150, marks: null };
  return null;
}

let palSel = 0, palRows = [];
function renderPalette(q) {
  const scored = [];
  for (const e of ENTRIES) {
    const m = fuzzy(q, e.name, e.hay);
    if (!m) continue;
    let s = m.score;
    if (e.kind === 'instrument') s += 60;
    const r = prefs.recent.indexOf(e.id);
    if (r >= 0) s += 40 - r * 5;
    scored.push({ e, s, marks: m.marks });
  }
  if (!q) {
    const recent = prefs.recent.map((id) => ENTRIES.find((e) => e.kind === 'instrument' && e.id === id)).filter(Boolean);
    const rest = ENTRIES.filter((e) => e.kind === 'instrument' && !prefs.recent.includes(e.id));
    palRows = [...recent.map((e) => ({ e, group: 'RECENT' })), ...rest.map((e) => ({ e })), ...ENTRIES.filter((e) => e.kind === 'action').map((e) => ({ e }))];
  } else {
    /* rank by score, but keep each group contiguous so its header prints once */
    scored.sort((a, b) => b.s - a.s);
    const order = [], buckets = new Map();
    for (const x of scored.slice(0, 40)) {
      if (!buckets.has(x.e.group)) { buckets.set(x.e.group, []); order.push(x.e.group); }
      buckets.get(x.e.group).push({ e: x.e, marks: x.marks });
    }
    palRows = order.flatMap((g) => buckets.get(g));
  }
  palSel = 0;

  const box = $('#palres');
  if (!palRows.length) { box.innerHTML = `<div class="palempty">Nothing matches <b>${esc(q)}</b>. Try an instrument name, a metric, a model, or a file path.</div>`; return; }
  let html = '', group = null;
  palRows.forEach((row, k) => {
    const g = row.group || row.e.group;
    if (g !== group) { group = g; html += `<div class="grp">${esc(g)}</div>`; }
    const nm = row.marks
      ? esc(row.e.name.slice(0, row.marks[0])) + '<mark>' + esc(row.e.name.slice(row.marks[0], row.marks[1])) + '</mark>' + esc(row.e.name.slice(row.marks[1]))
      : esc(row.e.name);
    html += `<a href="${esc(row.e.href || '#')}" data-k="${k}" role="option" aria-selected="${k === 0}">
      <span class="nm">${nm}</span><span class="why">${esc(row.e.hint || '')}</span></a>`;
  });
  box.innerHTML = html;
  $$('#palres a').forEach((a) => {
    a.addEventListener('mousemove', () => selPal(+a.dataset.k));
    a.addEventListener('click', (ev) => { ev.preventDefault(); runPal(palRows[+a.dataset.k].e, ev.metaKey || ev.ctrlKey); });
  });
}
function selPal(k) {
  palSel = Math.max(0, Math.min(palRows.length - 1, k));
  $$('#palres a').forEach((a, i) => a.setAttribute('aria-selected', String(i === palSel)));
  const el = $(`#palres a[data-k="${palSel}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function runPal(e, newTab) {
  if (!e) return;
  if (e.kind === 'action' && e.act) {
    closePalette();
    if (e.act === 'vault') openVault();
    else if (e.act === 'export') doExport();
    else if (e.act === 'map') setView(prefs.view === 'map' ? 'rack' : 'map');
    else if (e.act === 'theme') toggleTheme();
    else if (e.act === 'help') openHelp();
    return;
  }
  if (e.kind === 'dep') {
    closePalette(); setView('map');
    setTimeout(() => { MAP && MAP.focus(e.id); toast(`highlighted: ${e.name}`); }, 60);
    return;
  }
  if (e.kind === 'instrument') { closePalette(); go(BY_ID[e.id], newTab); return; }
  closePalette();
  if (newTab || e.ext) window.open(e.href, '_blank', 'noopener');
  else location.href = e.href;
}
function openPalette(seed = '') {
  $('#scrim').classList.add('on');
  $('#pal').classList.add('on');
  const inp = $('#palinput');
  inp.value = seed;
  renderPalette(seed);
  setTimeout(() => inp.focus(), 10);
}
function closePalette() {
  $('#pal').classList.remove('on');
  /* hand focus back to the page — otherwise the input keeps eating m / v / t */
  const inp = $('#palinput');
  if (inp) inp.blur();
  if (document.activeElement === document.body || !document.activeElement) { /* already free */ }
  else if ($('#pal').contains(document.activeElement)) document.activeElement.blur();
  maybeScrim();
}

/* ---------------------------------------------------------------- drawers */
function maybeScrim() {
  const any = $('#pal').classList.contains('on') || $('#vault').classList.contains('on') || $('#help').classList.contains('on');
  $('#scrim').classList.toggle('on', any);
  document.body.style.overflow = any ? 'hidden' : '';
}
function openHelp() { $('#help').classList.add('on'); maybeScrim(); }
function closeHelp() { $('#help').classList.remove('on'); maybeScrim(); }

/* ---------------------------------------------------------------- vault UI */
function keyRow(r, foreign) {
  const owner = r.toolName || (foreign ? 'UNCLAIMED' : '');
  return `<div class="krow${r.secret ? ' secret' : ''}${foreign ? ' foreign' : ''}">
    <div class="k">
      <code>${esc(r.key)}</code>
      ${owner ? `<span class="owner">${esc(owner)}</span>` : ''}
      <span class="sz">${esc(vault.fmtBytes(r.size))}</span>
    </div>
    ${r.label ? `<div class="sum"><b>${esc(r.label)}</b> — ${esc(r.summary.join(' · '))}</div>`
              : `<div class="sum">${esc(r.summary.join(' · '))}</div>`}
    ${r.secret ? `<div class="warn">⚠ secret — value never rendered, and excluded from backups unless you opt in below</div>` : ''}
    <div class="acts">
      ${r.secret ? '' : `<button data-copy="${esc(r.key)}">COPY</button><button data-save="${esc(r.key)}">SAVE .JSON</button>`}
    </div>
  </div>`;
}

function renderVault() {
  rescan();
  const body = $('#vaultbody');
  if (!SCAN.ok) {
    body.innerHTML = `<p class="dnote">${esc(SCAN.reason)}. Every instrument keeps its state here, so they will also start empty in this browser.</p>`;
    return;
  }
  const quotaEst = 5 * 1024 * 1024;
  const pct = Math.min(100, (SCAN.bytes / quotaEst) * 100);
  const withData = SCAN.known.filter((r) => !r.own);

  body.innerHTML = `
    <div class="quota">
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="lbl"><span>${esc(vault.fmtBytes(SCAN.bytes))} used</span><span>~5 MB is the usual per-origin ceiling</span><span>${SCAN.known.length + SCAN.foreign.length} keys</span></div>
    </div>
    <p class="dnote">Every instrument in this suite saves to <b>this browser only</b>. Nothing is synced, and clearing site data for
      <code class="mono">${esc(location.host)}</code> erases all of it at once. A backup is one file and costs nothing.</p>

    <div class="dsect">WRITTEN BY THE INSTRUMENTS — ${withData.length}</div>
    ${withData.length ? withData.map((r) => keyRow(r, false)).join('') : '<p class="dnote">Nothing saved yet in this browser.</p>'}

    ${SCAN.foreign.length ? `<div class="dsect">OTHER KEYS ON ${esc(location.host).toUpperCase()} — ${SCAN.foreign.length}</div>
      <p class="dnote">This origin is shared with everything else published under it, so these may belong to another project.
        They are left alone, and stay out of backups unless you tick the box below.</p>
      ${SCAN.foreign.map((r) => keyRow(r, true)).join('')}` : ''}

    <div class="dsect">BACKUP OPTIONS</div>
    <label class="optrow"><input type="checkbox" id="opt-foreign"> <span>Include the ${SCAN.foreign.length} unclaimed keys above.</span></label>
    <label class="optrow"><input type="checkbox" id="opt-secrets"> <span><b>Include secrets.</b> Your frame-describe API key would then sit in plain text inside the downloaded file. Off by default.</span></label>
  `;

  $$('#vaultbody [data-copy]').forEach((b) => b.onclick = async () => {
    const r = [...SCAN.known, ...SCAN.foreign].find((x) => x.key === b.dataset.copy);
    try { await navigator.clipboard.writeText(r.raw); toast('copied ' + r.key); }
    catch (e) { toast('clipboard refused — use SAVE .JSON', true); }
  });
  $$('#vaultbody [data-save]').forEach((b) => b.onclick = () => {
    const r = [...SCAN.known, ...SCAN.foreign].find((x) => x.key === b.dataset.save);
    vault.download(`${r.key.replace(/[^\w.-]+/g, '_')}-${vault.stamp()}.json`, r.raw);
    toast('saved ' + r.key);
  });
}

function openVault() { $('#vault').classList.add('on'); maybeScrim(); renderVault(); }
function closeVault() { $('#vault').classList.remove('on'); maybeScrim(); }

function doExport() {
  try {
    const payload = vault.buildExport({
      includeSecrets: !!$('#opt-secrets')?.checked,
      includeForeign: !!$('#opt-foreign')?.checked,
    });
    if (!payload.counts.keys) { toast('nothing saved yet — nothing to back up', true); return; }
    vault.download(`tools-vault-${vault.stamp()}.json`, JSON.stringify(payload, null, 2));
    toast(`backed up ${payload.counts.keys} keys · ${vault.fmtBytes(payload.counts.bytes)}`);
  } catch (e) { toast(String(e.message || e), true); }
}

function doImport(file) {
  const rd = new FileReader();
  rd.onload = () => {
    let payload;
    try { payload = JSON.parse(rd.result); }
    catch (e) { toast('that file is not JSON', true); return; }
    let plan;
    try { plan = vault.planImport(payload); }
    catch (e) { toast('not a tools backup: ' + e.message, true); return; }

    const lines = [
      `Restore from ${payload.exportedAt ? new Date(payload.exportedAt).toLocaleString() : 'an unknown date'}:`,
      '',
      `  ${plan.add.length} new key(s) added`,
      `  ${plan.overwrite.length} existing key(s) OVERWRITTEN`,
      `  ${plan.same.length} already identical (skipped)`,
      plan.bad.length ? `  ${plan.bad.length} malformed entr(ies) ignored` : '',
      '',
      plan.overwrite.length ? 'Overwrites:\n' + plan.overwrite.slice(0, 12).map((r) => '  · ' + r.key).join('\n') + (plan.overwrite.length > 12 ? `\n  …and ${plan.overwrite.length - 12} more` : '') : '',
      '',
      plan.overwrite.length ? 'This replaces saved runs in this browser and cannot be undone.' : '',
      'Continue?',
    ].filter((x) => x !== '').join('\n');

    if (plan.overwrite.length && !confirm('Back up the CURRENT state first?\n\nOK downloads a backup of what is in this browser right now, then continues to the restore.\nCancel skips straight to the restore preview.')) {
      /* user declined the safety copy — fall through */
    } else if (plan.overwrite.length) {
      try { const cur = vault.buildExport({}); vault.download(`tools-vault-before-restore-${vault.stamp()}.json`, JSON.stringify(cur, null, 2)); }
      catch (e) { /* nothing to back up */ }
    }

    if (!confirm(lines)) { toast('restore cancelled — nothing was written'); return; }
    const res = vault.applyImport(plan);
    rescan(); renderVault(); renderManifest(); renderRack(); renderResume(); renderStat(); SCOPE && SCOPE.refresh();
    if (res.failed.length) toast(`restored ${res.written.length}, ${res.failed.length} failed (quota?)`, true);
    else toast(`restored ${res.written.length} keys`);
  };
  rd.readAsText(file);
}

/* ---------------------------------------------------------------- theme */
function applyTheme() {
  document.documentElement.setAttribute('data-theme', prefs.theme === 'day' ? 'day' : 'dark');
  $('#btn-theme .t').textContent = prefs.theme === 'day' ? 'DARK' : 'DAYLIGHT';
  const m = $('meta[name="theme-color"]');
  if (m) m.content = prefs.theme === 'day' ? '#eef1f4' : '#05070a';
  if (MAP) MAP.refresh();
  if (SCOPE) SCOPE.refresh();
}
function toggleTheme() { prefs.theme = prefs.theme === 'day' ? 'dark' : 'day'; savePrefs(); applyTheme(); }

/* ---------------------------------------------------------------- keys */
function typingIn(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
addEventListener('keydown', (ev) => {
  const palOpen = $('#pal').classList.contains('on');
  if ((ev.key === 'k' || ev.key === 'K') && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); palOpen ? closePalette() : openPalette(''); return; }
  if (ev.key === 'Escape') {
    if (palOpen) { closePalette(); return; }
    if ($('#vault').classList.contains('on')) { closeVault(); return; }
    if ($('#help').classList.contains('on')) { closeHelp(); return; }
  }
  if (palOpen) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); selPal(palSel + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); selPal(palSel - 1); }
    else if (ev.key === 'Enter') { ev.preventDefault(); runPal(palRows[palSel]?.e, ev.metaKey || ev.ctrlKey); }
    return;
  }
  if (typingIn(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === '/') { ev.preventDefault(); openPalette(''); }
  else if (ev.key === '?') { ev.preventDefault(); openHelp(); }
  else if (ev.key === 'm') setView(prefs.view === 'map' ? 'rack' : 'map');
  else if (ev.key === 'v') { $('#vault').classList.contains('on') ? closeVault() : openVault(); }
  else if (ev.key === 't') toggleTheme();
  else if (/^[1-9]$/.test(ev.key)) {
    const i = INSTRUMENTS[+ev.key - 1];
    if (i) go(i);
  }
});

/* ---------------------------------------------------------------- boot */
let SCOPE = null;
function boot() {
  applyTheme();
  rescan();
  renderFilters();
  renderManifest();
  renderRack();
  renderResume();
  renderStat();
  SCOPE = mountScope($('#scope'));
  setView(prefs.view === 'map' ? 'map' : 'rack');

  $('#btn-search').onclick = () => openPalette('');
  $('#btn-map').onclick = () => setView(prefs.view === 'map' ? 'rack' : 'map');
  $('#btn-vault').onclick = () => openVault();
  $('#btn-theme').onclick = toggleTheme;
  $('#btn-help').onclick = openHelp;
  $('#scrim').onclick = () => { closePalette(); closeVault(); closeHelp(); };
  $('#pal').addEventListener('mousedown', (ev) => { if (ev.target.id === 'pal') closePalette(); });
  $('#palinput').addEventListener('input', (ev) => renderPalette(ev.target.value.trim()));
  $('#vault-close').onclick = closeVault;
  $('#help-close').onclick = closeHelp;
  $('#vault-export').onclick = doExport;
  $('#vault-import').onclick = () => $('#vault-file').click();
  $('#vault-file').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (f) doImport(f);
    ev.target.value = '';
  });
  $('#vault-refresh').onclick = () => { renderVault(); renderManifest(); renderRack(); renderResume(); renderStat(); SCOPE.refresh(); toast('re-read local state'); };

  /* keep the readout honest if another tab writes while this page is open */
  addEventListener('storage', () => { rescan(); renderManifest(); renderRack(); renderResume(); renderStat(); SCOPE.refresh(); });
  addEventListener('pageshow', (e) => { if (e.persisted) { rescan(); renderManifest(); renderRack(); renderResume(); renderStat(); SCOPE.refresh(); } });

  $('#year').textContent = new Date().getFullYear();
}

if (document.readyState === 'loading') addEventListener('DOMContentLoaded', boot);
else boot();
