// extract.js — hook2piano bridge: TheoryTab URL/tab ID -> section chords.
// Reuses the hook2piano Python engine (Pyodide) served from the sibling
// hook2piano app; no code duplicated, the py files are fetched live.
//
// export: parseExtractInput(raw), loadExtractSections(raw),
//         extractSectionChords(name, tid)
//   -> { title, keyPc, mode, tempo, chords: [{rootPc, fam, roman, name}] }

const API = "https://api.hooktheory.com/v1/songs/public/";
const FIELDS = "ID,xmlData,song,jsonData";
const PY_BASE = "../hook2piano/docs/py/hook2piano/";
const PY_FILES = ["__init__.py", "fetch.py", "theory.py", "parse.py",
                  "render_text.py", "render_html.py", "cli.py"];
// Dan's own relay for TheoryTab page HTML (hooktheory.com sends no CORS
// headers); api.cors.lol is the fallback. Same pair hook2piano uses.
const RELAYS = [
  "https://script.google.com/macros/s/AKfycbw7kEOABWrz29CSTvg7tUWbifuaneDXICJ87UThzEyjKJeOEBZcAbpkWjWgFL1H3cMT/exec?url=",
  "https://api.cors.lol/?url=",
];

const PC_OF = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

export function parseExtractInput(raw) {
  const s = (raw || "").trim();
  if (!s) return null;
  if (/^[A-Za-z0-9_-]{5,}$/.test(s) && !s.includes("/") && !s.includes(".")) {
    return { kind: "tab", tid: s };
  }
  const tm = s.match(/tab-([A-Za-z0-9_-]{5,})/);
  if (tm && !s.includes("/")) return { kind: "tab", tid: tm[1] };
  return { kind: "url", url: s.startsWith("http") ? s : "https://" + s };
}

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
  } catch (e) { /* CORS — fall through to relays */ }
  const enc = encodeURIComponent(url);
  for (const base of RELAYS) {
    try {
      const r = await fetch(base + enc);
      if (r.ok) {
        const t = await r.text();
        if (t.includes("TheoryTabs")) return t;
      }
    } catch (e) { /* try next */ }
  }
  throw new Error("couldn't read that TheoryTab page (relay blocked) — paste a tab ID instead");
}

/** Resolve the input to a section list [{name, tid}]. */
export async function loadExtractSections(raw) {
  const parsed = parseExtractInput(raw);
  if (!parsed) throw new Error("paste a TheoryTab URL or tab ID first");
  if (parsed.kind === "tab") return [{ name: "Tab", tid: parsed.tid }];
  const html = await fetchViewHtml(parsed.url);
  const sections = extractSections(html);
  if (!sections.length) throw new Error("no tabs found on that page");
  return sections;
}

async function fetchProject(tid) {
  const r = await fetch(API + encodeURIComponent(tid) + "?fields=" + FIELDS);
  if (!r.ok) throw new Error("tab not found (" + r.status + ")");
  const d = await r.json();
  const project = JSON.parse(d.jsonData);
  project._song_title = d.song || "";
  project._tab_id = tid;
  return project;
}

let pyodide = null, pyReady = null;
async function ensurePy(onStatus) {
  if (pyodide) return pyodide;
  if (pyReady) return pyReady;
  pyReady = (async () => {
    if (typeof loadPyodide === "undefined")
      throw new Error("python engine failed to load (are you offline?)");
    onStatus && onStatus("loading chord engine\u2026 (one-time, ~10 MB)");
    const py = await loadPyodide();
    await py.FS.mkdir("/h2p");
    await py.FS.mkdir("/h2p/hook2piano");
    for (const f of PY_FILES) {
      const r = await fetch(PY_BASE + f);
      if (!r.ok) throw new Error("missing engine file: " + f);
      py.FS.writeFile("/h2p/hook2piano/" + f, await r.text());
    }
    py.runPython('import sys; sys.path.insert(0, "/h2p")\nimport hook2piano\nfrom hook2piano import parse, render_html\nimport json');
    pyodide = py;
    return py;
  })();
  return pyReady;
}

/**
 * Parse one section into PROGRESSIONS-ready chord data.
 * Returns { title, keyPc, mode, tempo, chords, bars, truncated }.
 * Only 4/4 is supported — other meters throw a clear error rather than
 * silently misaligning the loop.
 */
export async function extractSectionChords(name, tid, onStatus) {
  const py = await ensurePy(onStatus);
  onStatus && onStatus("fetching tab\u2026");
  const project = await fetchProject(tid);
  py.globals.set("js_project", project);
  py.globals.set("js_section_name", name);
  onStatus && onStatus("extracting chords\u2026");
  const json = py.runPython(
    'json.dumps(render_html.sections_to_js([parse.parse_section(js_section_name, js_project.to_py())]))'
  );
  const song = JSON.parse(json);
  const sec = song.sections[0];
  if (sec.beatsPerMeasure !== 4)
    throw new Error(`only 4/4 supported (this tab is ${sec.beatsPerMeasure}/4)`);

  // keyName looks like "Eb major" / "F# minor" / "D dorian"
  const km = /^([A-G][#b]?)\s+(\w+)/.exec(sec.keyName || "");
  const tonic = km ? km[1] : "C";
  const scale = km ? km[2].toLowerCase() : "major";
  const keyPc = PC_OF[tonic] ?? 0;
  const mode = ["major", "lydian", "mixolydian"].includes(scale) ? "maj" : "min";

  const chords = [];
  let prev = null;
  for (const meas of sec.measures) {
    if (!meas.chords.length) {           // no change this bar: hold previous
      if (prev) chords.push(prev);
      continue;
    }
    const c = meas.chords.reduce((a, b) => (b.dur > a.dur ? b : a));
    if (c.rootPc == null) {              // N.C. — hold previous
      if (prev) chords.push(prev);
      continue;
    }
    prev = { rootPc: c.rootPc, fam: c.fam === "min" ? "min" : "maj",
             roman: c.roman || "", name: c.label || "" };
    chords.push(prev);
  }
  if (!chords.length) throw new Error("no chords found in that section");

  const truncated = chords.length > 8;
  return {
    title: (project._song_title ? project._song_title + " — " : "") + name,
    keyPc, mode,
    tempo: Math.round(sec.bpm) || 120,
    chords: chords.slice(0, 8),
    bars: Math.min(chords.length, 8),
    total: chords.length,
    truncated,
  };
}
