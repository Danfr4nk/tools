/* MusicTrainer — weekly DW / Release Radar scoring instrument. Static, localStorage-backed. */
(function(){
"use strict";
const LS_KEY = "musictrainer.v1";
const TARGET_DECISIONS = 240;

let state = load();
let selIdx = 0;

function load(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(raw){ const s = JSON.parse(raw); if(s && Array.isArray(s.weeks)) return s; }
  }catch(e){}
  const s = { weeks: [] };
  if(window.SEED_WEEK) s.weeks.push(structuredClone(window.SEED_WEEK));
  return s;
}
function save(){ localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function week(){ return state.weeks.find(w=>w.id===state.currentWeekId); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtDate(iso){ try{ return new Date(iso).toLocaleString([], {month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}); }catch(e){ return ""; } }

/* ---------- parsing ---------- */
const ID_RE = /(?:open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]{22})/;
function parseTrackLines(text){
  const out = [];
  for(const raw of text.split("\n")){
    const line = raw.trim();
    if(!line) continue;
    const m = line.match(ID_RE);
    if(!m) continue;
    const id = m[1];
    let name = "", artists = "";
    if(line.includes("|")){
      const parts = line.split("|").map(p=>p.trim());
      if(parts.length>=3){ name = parts[1]; artists = parts[2]; }
      else if(parts.length===2){ name = parts[0].replace(ID_RE,"").trim(); artists = parts[1]; }
    }
    out.push({ uri:"spotify:track:"+id, id, name, artists, status:"unscored",
               predicted_keep:null, p_keep:null });
  }
  return out;
}
function parsePredLines(text){
  const t = text.trim();
  if(!t) return [];
  // JSON first
  if(t[0]==="[" || t[0]==="{"){
    try{
      let arr = JSON.parse(t);
      if(!Array.isArray(arr)) arr = [arr];
      return arr.map(o=>{
        const m = String(o.uri||o.id||"").match(ID_RE) || String(o.uri||o.id||"").match(/^([A-Za-z0-9]{22})$/);
        return { id: m?m[1]:null,
                 predicted_keep: !!(o.predicted_keep ?? o.keep),
                 p_keep: (o.p_keep ?? o.p ?? null) };
      }).filter(p=>p.id);
    }catch(e){ /* fall through to line parser */ }
  }
  const out = [];
  for(const raw of t.split("\n")){
    const line = raw.trim();
    if(!line) continue;
    const m = line.match(ID_RE) || line.match(/^([A-Za-z0-9]{22})/);
    if(!m) continue;
    const id = m[1];
    const low = line.toLowerCase();
    const noId = low.replace(id.toLowerCase(), "");
    const pf = noId.match(/0?\.\d+/);
    const noProb = pf ? noId.replace(pf[0], "") : noId;
    const keepTok = /\b(keep|true|yes|y|k)\b/.test(noProb);
    const skipTok = /\b(skip|false|no|n|s)\b/.test(noProb);
    out.push({ id, predicted_keep: keepTok && !skipTok, p_keep: pf?parseFloat(pf[0]):null });
  }
  return out;
}

/* ---------- scoring ---------- */
function scoreStats(w){
  const scored = w.tracks.filter(t=>t.status!=="unscored");
  let tp=0, fp=0, fn=0, tn=0;
  for(const t of scored){
    const actual = t.status==="keep";
    const pred = !!t.predicted_keep;
    if(pred && actual) tp++;
    else if(pred && !actual) fp++;
    else if(!pred && actual) fn++;
    else tn++;
  }
  const n = scored.length;
  return { n, tp, fp, fn, tn,
    acc: n? (tp+tn)/n : null,
    prec: (tp+fp)? tp/(tp+fp) : null,
    rec: (tp+fn)? tp/(tp+fn) : null };
}
function cumulative(){
  let n=0, correct=0;
  for(const w of state.weeks){
    if(!w.predictionsLocked) continue;
    const s = scoreStats(w);
    n += s.n; correct += s.tp + s.tn;
  }
  return { n, acc: n? correct/n : null };
}

/* ---------- views ---------- */
const $ = id => document.getElementById(id);
const views = ["view-home","view-week","view-new"];
function show(v){
  views.forEach(x=>$(x).classList.toggle("hidden", x!==v));
  document.querySelectorAll(".navbtn").forEach(b=>b.classList.remove("active"));
  if(v==="view-home") $("nav-home").classList.add("active");
  if(v==="view-new") $("nav-new").classList.add("active");
  window.scrollTo(0,0);
}
function toast(msg){
  const t = $("toast");
  t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.add("hidden"), 2200);
}
function pct(x){ return x==null ? "—" : (x*100).toFixed(1)+"%"; }

function renderHome(){
  const c = cumScore => cumScore;
  const cum = cumulative();
  let h = `<h2>Scoring weeks</h2>
    <div class="sub">Discover Weekly + Release Radar, scored against locked predictions.</div>
    <div class="card"><div class="row spread">
      <div><div class="dim" style="font-size:12px">CUMULATIVE vs ${TARGET_DECISIONS}-decision target</div>
      <div class="big">${pct(cum.acc)} <span class="dim" style="font-size:14px">acc</span></div></div>
      <div class="mono dim">${cum.n}/${TARGET_DECISIONS} decisions</div>
    </div>
    <div class="prog"><i style="width:${Math.min(100, cum.n/TARGET_DECISIONS*100)}%"></i></div>
    <div class="target-note">Target: ≥90% per-track accuracy over ≥${TARGET_DECISIONS} decisions, plus ≥85% recall on keeps.</div>
    </div>`;
  if(!state.weeks.length) h += `<div class="empty">No weeks yet. Create one to start scoring.</div>`;
  for(const w of [...state.weeks].reverse()){
    const s = scoreStats(w);
    const nsc = w.tracks.filter(t=>t.status!=="unscored").length;
    h += `<div class="card clickable" data-open="${w.id}">
      <div class="row spread">
        <div><strong>${esc(w.name)}</strong>
          <span class="badge ${w.type==="discover-weekly"?"dw":"rr"}">${w.type==="discover-weekly"?"DISCOVER WEEKLY":"RELEASE RADAR"}</span>
          <span class="badge ${w.predictionsLocked?"locked":"unlocked"}">${w.predictionsLocked?"🔒 preds locked · scoring open":"unlocked"}</span>
        </div>
        <div class="mono dim">${w.date||""}</div>
      </div>
      <div class="row" style="margin-top:8px;gap:16px">
        <span class="mono dim">${nsc}/${w.tracks.length} scored</span>
        ${w.predictionsLocked && s.n ? `<span class="mono">acc ${pct(s.acc)}</span><span class="mono dim">prec ${pct(s.prec)} · rec ${pct(s.rec)}</span>` : `<span class="faint">score pending</span>`}
      </div>
      <div class="prog"><i style="width:${w.tracks.length?nsc/w.tracks.length*100:0}%"></i></div>
    </div>`;
  }
  $("view-home").innerHTML = h;
  $("view-home").querySelectorAll("[data-open]").forEach(el=>{
    el.onclick = ()=>{ state.currentWeekId = el.dataset.open; selIdx = 0; save(); renderWeek(); };
  });
}

function predBadge(t){
  if(t.predicted_keep==null) return `<span class="pred skip-pred">no pred</span>`;
  return t.predicted_keep
    ? `<span class="pred keep-pred" title="model P(keep)=${t.p_keep??"?"}">▲ KEEP ${t.p_keep!=null?t.p_keep.toFixed(2):""}</span>`
    : `<span class="pred skip-pred" title="model P(keep)=${t.p_keep??"?"}">▽ skip ${t.p_keep!=null?t.p_keep.toFixed(2):""}</span>`;
}
function verdictBadge(t){
  if(t.status==="unscored" || t.predicted_keep==null) return "";
  const hit = (!!t.predicted_keep) === (t.status==="keep");
  return `<span class="verdict ${hit?"hit":"miss"}">${hit?"HIT":"MISS"}</span>`;
}

function avgScoreLine(w){
  const avg = a => a.length ? (a.reduce((x,y)=>x+y,0)/a.length) : null;
  const k = w.tracks.filter(t=>t.status==="keep" && t.score!=null).map(t=>t.score);
  const r = w.tracks.filter(t=>t.status!=="keep" && t.status!=="unscored" && t.score!=null).map(t=>t.score);
  const ak = avg(k), ar = avg(r);
  if(ak==null && ar==null) return "";
  const f = x => x==null ? "—" : x.toFixed(1);
  return `<div class="hint">avg my-score — added: <span class="mono" style="color:var(--keep)">${f(ak)}</span> · not added: <span class="mono">${f(ar)}</span></div>`;
}
function renderWeek(){
  const w = week();
  if(!w){ renderHome(); show("view-home"); return; }
  show("view-week");
  const s = scoreStats(w);
  const nsc = s.n;
  let h = `<div class="weekhead"><h2>${esc(w.name)}</h2>
      <span class="badge ${w.type==="discover-weekly"?"dw":"rr"}">${w.type==="discover-weekly"?"DISCOVER WEEKLY":"RELEASE RADAR"}</span>
      ${w.predictionsLocked
        ? `<span class="badge locked">🔒 locked ${esc(w.lockedAt||"")}</span>`
        : `<span class="badge unlocked">predictions unlocked</span>`}
    </div>
    <div class="sub">${w.tracks.length} tracks · slider = your score 1–10 · <span class="kbd">j</span>/<span class="kbd">k</span> move · <span class="kbd">1</span> skip · <span class="kbd">2</span> like · <span class="kbd">3</span> added · <span class="kbd">p</span> player</div>`;

  h += `<div id="scorebar"><div class="row spread">
      <div class="statgrid" style="margin:0;flex:1;min-width:260px">
        <div class="stat"><div class="v">${pct(s.acc)}</div><div class="l">accuracy</div></div>
        <div class="stat"><div class="v">${pct(s.prec)}</div><div class="l">precision</div></div>
        <div class="stat"><div class="v">${pct(s.rec)}</div><div class="l">recall</div></div>
        <div class="stat"><div class="v">${nsc}/${w.tracks.length}</div><div class="l">scored</div></div>
      </div></div>
      <div class="prog"><i style="width:${w.tracks.length?nsc/w.tracks.length*100:0}%"></i></div>
      ${avgScoreLine(w)}
      ${w.predictionsLocked
        ? `<div class="lockbanner">🔒 predictions locked ${fmtDate(w.predictionsLockedAt)} — blind test active · <b>scoring is open</b></div>`
        : `<div class="btnrow"><button class="btn" id="lockbtn">🔒 Lock predictions</button></div>
        <div class="hint">Locking timestamps the predictions. Score only counts after lock — this preserves the blind test.</div>`}
    </div>`;

  h += `<div id="tracklist">`;
  w.tracks.forEach((t,i)=>{
    const added = t.status==="keep";
    h += `<div class="track ${i===selIdx?"sel":""}" data-i="${i}">
      <div class="head" data-head="${i}">
        <span class="idx">${String(i+1).padStart(2,"0")}</span>
        <div class="meta"><div class="t">${esc(t.name||"untitled")}</div><div class="a">${esc(t.artists||"")}</div></div>
        ${t.score!=null?`<span class="sval-head">${t.score}/10</span>`:""}
        ${verdictBadge(t)}${predBadge(t)}
      </div>
      <div class="controls">
        <div class="sliderow">
          <span class="clabel">SCORE</span>
          <input type="range" min="1" max="10" step="1" value="${t.score??5}" data-slider="${i}" aria-label="my score">
          <span class="sval" data-sval="${i}">${t.score??"—"}</span>
        </div>
        <div class="outcomerow">
          <div class="scorebtns">
            <button class="sbtn ${t.status==="skip"?"on-skip":""}" data-score="skip" data-i="${i}">skip</button>
            <button class="sbtn ${t.status==="like"?"on-like":""}" data-score="like" data-i="${i}">like</button>
          </div>
          <div class="addedseg">
            <span class="clabel">ADDED?</span>
            <button class="sbtn ${added?"on-keep":""}" data-added-yes="${i}">yes</button>
            <button class="sbtn ${!added&&t.status!=="unscored"?"on-skip":""}" data-added-no="${i}">no</button>
          </div>
        </div>
      </div>
      ${window.SongNotes?SongNotes.fieldHTML(t.id,{name:t.name,artists:t.artists,uri:"spotify:track:"+t.id}):""}
      <div class="player-wrap" data-pw="${i}"><button class="loadplayer" data-load="${i}">▶ load Spotify player</button></div>
    </div>`;
  });
  h += `</div>
    <div class="btnrow" style="margin-top:20px">
      <button class="btn ghost" id="exportbtn">export week JSON</button>
      <button class="btn ghost" id="notesbtn">export song notes</button>
      <button class="btn ghost" id="backbtn">← all weeks</button>
      <button class="btn danger" id="delbtn">delete week</button>
    </div>`;
  $("view-week").innerHTML = h;
  if(window.SongNotes) SongNotes.bind($("view-week"));

  $("view-week").querySelectorAll("[data-score]").forEach(b=>{
    b.onclick = e=>{ e.stopPropagation(); setStatus(+b.dataset.i, b.dataset.score, true); };
  });
  $("view-week").querySelectorAll("[data-added-yes]").forEach(b=>{
    b.onclick = e=>{ e.stopPropagation(); setAdded(+b.dataset.addedYes, true); };
  });
  $("view-week").querySelectorAll("[data-added-no]").forEach(b=>{
    b.onclick = e=>{ e.stopPropagation(); setAdded(+b.dataset.addedNo, false); };
  });
  $("view-week").querySelectorAll("[data-slider]").forEach(el=>{
    el.addEventListener("input", ()=>{
      const w = week(); const t = w.tracks[+el.dataset.slider];
      t.score = +el.value;
      const sv = document.querySelector(`[data-sval="${el.dataset.slider}"]`);
      if(sv) sv.textContent = el.value;
    });
    el.addEventListener("change", ()=>{
      save();
      selIdx = +el.dataset.slider;
      renderWeek();
    });
  });
  $("view-week").querySelectorAll("[data-head]").forEach(el=>{
    el.onclick = ()=>{ selIdx = +el.dataset.head; paintSel(); };
  });
  $("view-week").querySelectorAll("[data-load]").forEach(b=>{
    b.onclick = e=>{ e.stopPropagation(); loadPlayer(+b.dataset.load); };
  });
  const lb = $("lockbtn");
  if(lb) lb.onclick = ()=>{
    if(confirm("Lock predictions? They become uneditable, timestamped now.")){
      w.predictionsLocked = true; w.lockedAt = new Date().toISOString();
      save(); renderWeek(); toast("predictions locked");
    }
  };
  $("exportbtn").onclick = ()=>{
    const out = Object.assign({}, w, { tracks: w.tracks.map(t=>{
      const c = Object.assign({}, t);
      if(window.SongNotes){ const n = SongNotes.get(t.id); if(n) c.note = n; }
      return c;
    })});
    const blob = new Blob([JSON.stringify(out,null,1)],{type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = w.id+".json"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  };
  const nb = $("notesbtn");
  if(nb) nb.onclick = ()=>{
    if(!window.SongNotes) return;
    const blob = new Blob([SongNotes.exportJSON()],{type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "song-notes.json"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  };
  $("backbtn").onclick = ()=>{ save(); renderHome(); show("view-home"); };
  $("delbtn").onclick = ()=>{
    if(confirm("Delete this week permanently?")){
      state.weeks = state.weeks.filter(x=>x.id!==w.id);
      state.currentWeekId = null; save(); renderHome(); show("view-home");
    }
  };
}
function paintSel(){
  document.querySelectorAll("#tracklist .track").forEach(el=>{
    el.classList.toggle("sel", +el.dataset.i===selIdx);
  });
  const el = document.querySelector(`#tracklist .track[data-i="${selIdx}"]`);
  if(el) el.scrollIntoView({block:"nearest"});
}
function loadPlayer(i){
  const w = week(); const t = w.tracks[i];
  const pw = document.querySelector(`[data-pw="${i}"]`);
  pw.innerHTML = `<iframe src="https://open.spotify.com/embed/track/${t.id}?theme=0" allow="encrypted-media" loading="lazy"></iframe>`;
}
function setAdded(i, yes){
  const w = week(); const t = w.tracks[i];
  if(yes) t.status = "keep";
  else t.status = (t.status==="like") ? "like" : "skip";
  save(); renderWeek();
  selIdx = Math.min(i+1, w.tracks.length-1); paintSel();
}
function setStatus(i, status, advance){
  const w = week(); const t = w.tracks[i];
  t.status = (t.status===status) ? "unscored" : status; // toggle off
  save(); renderWeek();
  if(advance && t.status!=="unscored"){
    selIdx = Math.min(i+1, w.tracks.length-1);
    paintSel();
  } else { selIdx = i; paintSel(); }
}

function renderNew(){
  show("view-new");
  $("view-new").innerHTML = `
    <h2>New scoring week</h2>
    <div class="sub">Paste the week's tracks, then paste predictions and lock them <em>before</em> listening.</div>
    <label>Week name</label>
    <input type="text" id="nw-name" placeholder="Discover Weekly — Sep 21, 2026">
    <div class="row" style="gap:12px">
      <div style="flex:1"><label>Type</label>
        <select id="nw-type"><option value="discover-weekly">Discover Weekly</option><option value="release-radar">Release Radar</option></select></div>
      <div style="flex:1"><label>Week of</label><input type="date" id="nw-date"></div>
    </div>
    <label>Tracks — one per line. Spotify URL, URI, or <span class="mono">uri | title | artists</span></label>
    <textarea id="nw-tracks" placeholder="https://open.spotify.com/track/7c25Gr6cBaMoxFBUOZqFrP&#10;spotify:track:… | REMEDY | spüke"></textarea>
    <label>Predictions — JSON array or one per line: <span class="mono">uri, keep, 0.39</span></label>
    <textarea id="nw-preds" placeholder='[{"uri":"spotify:track:…","predicted_keep":true,"p_keep":0.39}]'></textarea>
    <div class="hint">Predictions stay editable until you press 🔒 Lock predictions in the week view. Lock before your first listen.</div>
    <div class="btnrow"><button class="btn" id="nw-create">Create week</button>
    <button class="btn ghost" id="nw-import">Import week JSON…</button>
    <input type="file" id="nw-file" accept=".json" class="hidden"></div>`;
  $("nw-create").onclick = ()=>{
    const tracks = parseTrackLines($("nw-tracks").value);
    if(!tracks.length){ toast("no tracks parsed — check the format"); return; }
    const preds = parsePredLines($("nw-preds").value);
    const pmap = Object.fromEntries(preds.map(p=>[p.id,p]));
    tracks.forEach(t=>{ const p = pmap[t.id]; if(p){ t.predicted_keep=p.predicted_keep; t.p_keep=p.p_keep; } });
    const name = $("nw-name").value.trim() || (($("nw-type").value==="discover-weekly"?"Discover Weekly":"Release Radar")+" — "+($("nw-date").value||"untitled"));
    const w = { id: "w-"+Date.now().toString(36), name,
      type: $("nw-type").value, date: $("nw-date").value,
      predictionsLocked:false, lockedAt:null, tracks };
    state.weeks.push(w); state.currentWeekId = w.id; selIdx = 0;
    save(); renderWeek();
    toast(tracks.length+" tracks loaded"+(preds.length?"; lock predictions before listening":""));
  };
  $("nw-import").onclick = ()=>$("nw-file").click();
  $("nw-file").onchange = e=>{
    const f = e.target.files[0]; if(!f) return;
    const r = new FileReader();
    r.onload = ()=>{
      try{
        const w = JSON.parse(r.result);
        if(!w.tracks || !Array.isArray(w.tracks)) throw 0;
        w.id = w.id || "w-"+Date.now().toString(36);
        if(window.SongNotes) w.tracks.forEach(t=>{
          if(t.note && t.id) SongNotes.set(t.id, t.note, {name:t.name, artists:t.artists, uri:"spotify:track:"+t.id});
        });
        state.weeks.push(w); state.currentWeekId = w.id; selIdx = 0;
        save(); renderWeek(); toast("week imported");
      }catch(err){ toast("import failed — not a week JSON"); }
    };
    r.readAsText(f);
  };
}

/* ---------- keyboard ---------- */
document.addEventListener("keydown", e=>{
  if($("view-week").classList.contains("hidden")) return;
  if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  const w = week(); if(!w) return;
  const n = w.tracks.length;
  if(e.key==="j"||e.key==="ArrowDown"){ selIdx=Math.min(n-1,selIdx+1); paintSel(); e.preventDefault(); }
  else if(e.key==="k"||e.key==="ArrowUp"){ selIdx=Math.max(0,selIdx-1); paintSel(); e.preventDefault(); }
  else if(e.key==="1") setStatus(selIdx,"skip",true);
  else if(e.key==="2") setStatus(selIdx,"like",true);
  else if(e.key==="3") setStatus(selIdx,"keep",true);
  else if(e.key==="0") setStatus(selIdx,w.tracks[selIdx].status,false);
  else if(e.key==="p") loadPlayer(selIdx);
});

/* ---------- init ---------- */
$("nav-home").onclick = ()=>{ renderHome(); show("view-home"); };
$("nav-new").onclick = ()=>{ renderNew(); };
save();
if(state.currentWeekId && week()){ renderWeek(); }
else { renderHome(); show("view-home"); }
})();
