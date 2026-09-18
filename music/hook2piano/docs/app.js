"use strict";
/* hook2piano web harness.
 * Flow: TheoryTab URL (or tab ID) -> section list -> Hooktheory project JSON
 * (direct fetch; api.hooktheory.com allows CORS *) -> hook2piano Python engine
 * running in Pyodide -> SONG structure -> piano-roll renderer (render.js).
 */

const API = "https://api.hooktheory.com/v1/songs/public/";
const FIELDS = "ID,xmlData,song,jsonData";
const PY_FILES = ["__init__.py", "fetch.py", "theory.py", "parse.py",
                  "render_text.py", "render_html.py", "cli.py"];

const $ = id => document.getElementById(id);
const statusEl = $("status"), chipsEl = $("chips"),
       scoreEl = $("score"), actionsEl = $("actions");

/* ---------- bookmarklet (single source of truth) ----------
 * Same-origin DOM access: reads the tab list straight from the TheoryTab
 * page, so it needs no relay at all. The hint link href + copy buttons
 * are wired from this string at init. */
const BOOKMARKLET = `javascript:(function(){var h=document.documentElement.innerHTML,out=[],seen={},re=/<div id="tab-([^"]+)">/g,m;while((m=re.exec(h))){var tid=m[1];if(seen[tid])continue;seen[tid]=1;var b=h.slice(Math.max(0,m.index-3000),m.index),ts=[],tm,tr=/>(([^<>]{1,60}))</g;while((tm=tr.exec(b))){var t=tm[1].trim();if(t&&t.indexOf('Open In Hookpad')<0)ts.push(t)}var name=ts.length?ts[ts.length-1]:'Tab';if(name.indexOf('\u2013')>=0)name=name.split('\u2013').pop().trim();else if(name.indexOf(' - ')>=0)name=name.split(' - ').pop().trim();out.push(encodeURIComponent(name)+':'+tid)}if(!out.length){alert('hook2piano: no tabs found on this page');return}open('https://danfr4nk.github.io/tools/music/hook2piano/docs/?tabs='+out.join(','),'_blank')})()`;

async function copyBookmarklet(okEl){
  const done = ()=>{ if(okEl){ okEl.style.display = "inline";
    setTimeout(()=>{ okEl.style.display = "none"; }, 4000); } };
  try { await navigator.clipboard.writeText(BOOKMARKLET); done(); return; }
  catch(e){
    const ta = document.createElement("textarea");
    ta.value = BOOKMARKLET; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch(e2){}
    ta.remove();
  }
}

function showRelayPanel(){
  statusEl.innerHTML =
    '<div class="relaypanel"><b>hooktheory is blocking the relay (rate-limited) ' +
    '&mdash; pasting links is down for now.</b><br>' +
    'On your phone the reliable path is the bookmarklet: it reads the tab list ' +
    'straight from the TheoryTab page, no relay involved.<br>' +
    '<div class="btnrow"><button class="ghost" id="bmcopy2" type="button">Copy bookmarklet</button> ' +
    '<span class="copied" id="bmok2">copied &mdash; paste it into the bookmark&rsquo;s address field</span></div>' +
    '<ol><li>In Safari: Share &rarr; Add Bookmark (any page).</li>' +
    '<li>Bookmarks &rarr; Edit &rarr; tap it &rarr; clear the address field &rarr; paste &rarr; name it &#9889; hook2piano.</li>' +
    '<li>On any TheoryTab page, tap the address bar, type &ldquo;hook2piano&rdquo;, tap the bookmark &mdash; the sheet loads here.</li></ol></div>';
  $("bmcopy2").onclick = ()=>copyBookmarklet($("bmok2"));
}

function setStatus(t) { statusEl.textContent = t || ""; }

/* ---------- input parsing ---------- */

function parseInput(raw) {
  const s = raw.trim();
  if (!s) return null;
  // bare tab id: no slashes/dots/spaces, e.g. nZgWr__wmry
  if (/^[A-Za-z0-9_-]{5,}$/.test(s) && !s.includes("/") && !s.includes(".")) {
    return { kind: "tab", tid: s };
  }
  // strip a possible tab- prefix pasted from page source
  const tm = s.match(/tab-([A-Za-z0-9_-]{5,})/);
  if (tm && !s.includes("/")) return { kind: "tab", tid: tm[1] };
  return { kind: "url", url: s.startsWith("http") ? s : "https://" + s };
}

/* ---------- section extraction (port of fetch.song_sections) ---------- */

function extractSections(html) {
  const divRe = /<div id="tab-([^"]+)">/g;
  const out = [];
  let m;
  while ((m = divRe.exec(html))) {
    const tid = m[1];
    const before = html.slice(Math.max(0, m.index - 3000), m.index);
    const texts = [...before.matchAll(/>([^<>]{1,60})</g)]
      .map(x => x[1].trim())
      .filter(t => t && !t.includes("Open In Hookpad"));
    let name = texts.length ? texts[texts.length - 1] : "Section " + (out.length + 1);
    if (name.includes("\u2013")) name = name.split("\u2013").pop().trim();
    else if (name.includes(" - ")) name = name.split(" - ").pop().trim();
    out.push({ name, tid });
  }
  if (!out.length) {
    const ids = [...html.matchAll(/TheoryTabs\("tab-([^"]+)"\)/g)].map(x => x[1]);
    ids.forEach((tid, i) => out.push({ name: "Section " + (i + 1), tid }));
  }
  // dedupe, keep order
  const seen = new Set();
  return out.filter(s => (seen.has(s.tid) ? false : (seen.add(s.tid), true)));
}

async function fetchViewHtml(url) {
  try {
    const r = await fetch(url);
    if (r.ok) {
      const t = await r.text();
      if (t.includes("TheoryTabs")) return t;
    }
  } catch (e) { /* CORS — fall through to proxies */ }
  const enc = encodeURIComponent(url);
  // NOTE 2026-09-18: hooktheory.com sends no ACAO header, so the direct
  // fetch above always fails in-browser. Public relays are ALL dead or
  // rate-limited now: api.cors.lol hard-429s, allorigins/codetabs 522,
  // corsproxy.io 401s without a key, isomorphic-git 403s, and hooktheory
  // itself 429s proxy IPs (cors.eu.org). api.cors.lol stays as one
  // best-effort attempt (it worked 2026-09-16). On failure the caller shows
  // the bookmarklet panel — same-origin DOM access needs no relay at all.
  const proxies = [
    "https://api.cors.lol/?url=" + enc,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p);
      if (r.ok) {
        const t = await r.text();
        if (t.includes("TheoryTabs")) return t;
      }
    } catch (e) { /* try next */ }
  }
  throw new Error("RELAY_FAILED");
}

/* ---------- project JSON (direct; api.hooktheory.com sends CORS *) ---------- */

async function fetchProject(tid) {
  const r = await fetch(API + encodeURIComponent(tid) + "?fields=" + FIELDS);
  if (!r.ok) throw new Error("tab not found (" + r.status + ")");
  const d = await r.json();
  const project = JSON.parse(d.jsonData);
  project._song_title = d.song || "";
  project._tab_id = tid;
  return project;
}

/* ---------- Pyodide + hook2piano engine ---------- */

let pyodide = null, pyReady = null;

async function ensurePy() {
  if (pyodide) return pyodide;
  if (pyReady) return pyReady;
  pyReady = (async () => {
    setStatus("loading python engine\u2026 (one-time, ~10 MB)");
    const py = await loadPyodide();
    await py.FS.mkdir("/h2p");
    await py.FS.mkdir("/h2p/hook2piano");
    for (const f of PY_FILES) {
      const r = await fetch("py/hook2piano/" + f);
      if (!r.ok) throw new Error("missing engine file: " + f);
      py.FS.writeFile("/h2p/hook2piano/" + f, await r.text());
    }
    py.runPython('import sys; sys.path.insert(0, "/h2p")\nimport hook2piano\nfrom hook2piano import parse, render_html\nimport json');
    pyodide = py;
    return py;
  })();
  return pyReady;
}

async function buildSong(sectionName, project) {
  const py = await ensurePy();
  py.globals.set("js_project", project);
  py.globals.set("js_section_name", sectionName);
  const json = py.runPython(
    'json.dumps(render_html.sections_to_js([parse.parse_section(js_section_name, js_project.to_py())]))'
  );
  return JSON.parse(json);
}

/* ---------- UI ---------- */

let sections = [];

function renderChips() {
  chipsEl.innerHTML = "";
  sections.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = s.name;
    b.onclick = () => selectSection(i);
    chipsEl.appendChild(b);
  });
}

async function selectSection(i) {
  const s = sections[i];
  if (window.H2P && H2P.player) H2P.player.stop();
  [...chipsEl.children].forEach((b, j) => b.classList.toggle("active", j === i));
  setStatus("rendering " + s.name + "\u2026");
  try {
    const project = await fetchProject(s.tid);
    const song = await buildSong(s.name, project);
    window.H2P.renderSong(song, scoreEl);
    actionsEl.style.display = "flex";
    $("transport").style.display = "flex";
    if (window.H2P.player) H2P.player.reset();
    setStatus("");
  } catch (e) {
    setStatus("error: " + e.message);
  }
}

async function onLoad() {
  const parsed = parseInput($("url").value);
  if (!parsed) { setStatus("paste a TheoryTab URL or tab ID first"); return; }
  $("load").disabled = true;
  chipsEl.innerHTML = "";
  scoreEl.innerHTML = "";
  actionsEl.style.display = "none";
  $("transport").style.display = "none";
  if (window.H2P && H2P.player) H2P.player.reset();
  try {
    if (parsed.kind === "tab") {
      sections = [{ name: "Tab", tid: parsed.tid }];
    } else {
      setStatus("reading TheoryTab page\u2026");
      const html = await fetchViewHtml(parsed.url);
      sections = extractSections(html);
      if (!sections.length) throw new Error("no tabs found on that page");
    }
    renderChips();
    setStatus(sections.length > 1 ? "pick a section" : "rendering\u2026");
    await selectSection(0);
  } catch (e) {
    if (e && e.message === "RELAY_FAILED") showRelayPanel();
    else setStatus("error: " + e.message);
  } finally {
    $("load").disabled = false;
  }
}

$("load").onclick = onLoad;
$("url").addEventListener("keydown", e => { if (e.key === "Enter") onLoad(); });

/* bookmarklet link + copy buttons (hint) */
(function(){
  const link = $("bmlink");
  if (link) link.href = BOOKMARKLET;
  const c = $("bmcopy");
  if (c) c.onclick = ()=>copyBookmarklet($("bmok"));
})();
$("print").onclick = () => window.print();
$("tplay").onclick = () => { if (window.H2P && H2P.player) H2P.player.toggle(); };
$("tstop").onclick = () => { if (window.H2P && H2P.player) H2P.player.stop(); };

/* ---------- ?tabs= deep link (bookmarklet target) ----------
 * Format: ?tabs=<enc(name)>:<id>,<enc(name)>:<id>  (or bare ids: ?tabs=id1,id2)
 * Skips the page fetch entirely — the project API is CORS-open, so this
 * path needs no relay. The bookmarklet (see index.html) extracts ids +
 * names from the live TheoryTab DOM, where CORS doesn't apply. */
function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); }
  catch (e) { return s; }
}

function readTabsParam() {
  // parse the RAW query string: URLSearchParams would decode %2C before we
  // split, breaking names that contain commas — split first, decode after.
  const m = location.search.match(/[?&]tabs=([^&#]*)/);
  if (!m) return null;
  return m[1].split(",").map(p => {
    const c = p.lastIndexOf(":");  // separator colon is raw; name's own are %3A
    const name = c < 0 ? "Tab" : safeDecode(p.slice(0, c)).trim();
    const tid = (c < 0 ? p : p.slice(c + 1)).trim();
    return { name: name || "Tab", tid };
  }).filter(s => s.tid);
}

window.addEventListener("DOMContentLoaded", () => {
  const t = readTabsParam();
  if (t && t.length) {
    sections = t;
    renderChips();
    setStatus("rendering…");
    selectSection(0);
  }
});
