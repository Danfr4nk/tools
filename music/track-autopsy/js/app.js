/* AUTOPSY — what did it? Dissect the drivers of liking, one track at a time. */
(function(){
"use strict";

const ATTRS = [
  {k:"drop",        label:"the drop",        sub:"payoff / climax"},
  {k:"sound_design",label:"sound design",    sub:"synths / textures / ear candy"},
  {k:"bass",        label:"bass weight",     sub:"low-end pressure"},
  {k:"drums",       label:"drums / groove",  sub:"rhythm / swing"},
  {k:"arrangement", label:"arrangement",     sub:"structure / pacing"},
  {k:"tension",     label:"tension & release",sub:"builds / breaks"},
  {k:"mix",         label:"mix / polish",    sub:"loudness / clarity"},
  {k:"energy",      label:"energy / tempo",  sub:"pace / drive"},
  {k:"hook",        label:"melody / hook",   sub:"the earworm"},
  {k:"vocal",       label:"vocal as texture",sub:"voice, not words"},
  {k:"chords",      label:"chords / harmony",sub:"progression / mood"},
  {k:"atmos",       label:"atmosphere",      sub:"space / vibe"},
  {k:"surprise",    label:"novelty / surprise",sub:"never heard that"},
  {k:"nostalgia",   label:"nostalgia",       sub:"familiar / era"},
  {k:"set",         label:"set utility",     sub:"would play it out"},
  {k:"replay",      label:"replay urge",     sub:"run it back now"},
];
const ATTR = Object.fromEntries(ATTRS.map(a=>[a.k,a]));
const LSKEY = "autopsy.v1";

let state = load();
let cur = 0; // index into queue
let uidc = 0;

function uid(){ return "t"+Date.now().toString(36)+(uidc++); }
function load(){
  try{
    const raw = localStorage.getItem(LSKEY);
    if(raw){ const s = JSON.parse(raw); if(s && Array.isArray(s.tracks)) return s; }
  }catch(e){}
  return { tracks: [] };
}
function save(){ try{ localStorage.setItem(LSKEY, JSON.stringify(state)); }catch(e){} }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function $(id){ return document.getElementById(id); }
function toast(m){ const t=$("toast"); t.textContent=m; t.classList.remove("hidden"); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.add("hidden"),2200); }
function show(v){
  ["play","drivers","import"].forEach(x=>{
    $("view-"+x).classList.toggle("hidden", x!==v);
    $("nav-"+x).classList.toggle("active", x===v);
  });
  if(window.scrollTo) window.scrollTo(0,0);
}
function trackId(uri){
  const m = String(uri||"").match(/(?:track\/|track:)([A-Za-z0-9]{22})/);
  return m ? m[1] : null;
}
function embedUrl(t){
  const id = trackId(t.uri);
  return id ? "https://open.spotify.com/embed/track/"+id+"?utm_source=generator&theme=0" : null;
}
function bpmRoom(tempo){
  if(tempo==null) return null;
  if(tempo>=165) return "165+ dnb room";
  if(tempo>=125) return "125–145 house room";
  if(tempo<100) return "sub-100 halftime";
  return Math.round(tempo)+" bpm";
}
function machineChips(m){
  if(!m) return "";
  const c = [];
  if(m.tempo!=null) c.push(`<span class="mchip">♩ ${bpmRoom(m.tempo)}</span>`);
  if(m.energy!=null) c.push(`<span class="mchip">⚡ energy ${m.energy.toFixed(2)}</span>`);
  if(m.valence!=null) c.push(`<span class="mchip">◉ valence ${m.valence.toFixed(2)}</span>`);
  if(m.danceability!=null) c.push(`<span class="mchip">✦ dance ${m.danceability.toFixed(2)}</span>`);
  if(m.speechiness!=null) c.push(`<span class="mchip">◍ voice ${m.speechiness.toFixed(2)}</span>`);
  return c.join("");
}
function fetchMachine(t){
  if(t.machine || t.machineTried) return;
  const id = trackId(t.uri);
  t.machineTried = true;
  if(!id) return;
  fetch("https://api.reccobeats.com/v1/track?ids="+id)
    .then(r=>r.json())
    .then(j=>{
      const hit = (j.content||[]).find(x=>String(x.href||"").includes(id));
      if(hit){
        t.machine = { energy:hit.energy, valence:hit.valence, danceability:hit.danceability,
                      tempo:hit.tempo, speechiness:hit.speechiness, loudness:hit.loudness };
        save();
        const el = document.querySelector("#view-play .machineread");
        if(el) el.innerHTML = machineChips(t.machine) || `<span class="hint">no machine read</span>`;
      }
    })
    .catch(()=>{});
}

/* ---------- queue ---------- */
function queue(){ return state.tracks.filter(t=>!t.done); }
function current(){ const q = queue(); return q.length ? q[Math.min(cur, q.length-1)] : null; }

/* ---------- play view ---------- */
function chipGrid(t, mode){
  // mode: "attrs" (multi) or "kill" (single)
  return ATTRS.map(a=>{
    const on = mode==="attrs" ? !!t.attrs[a.k] : t.kill===a.k;
    const cls = mode==="attrs" ? (on?"chip on":"chip") : (on?"chip killpick":"chip");
    return `<button class="${cls}" data-chip="${mode}:${a.k}">${esc(a.label)}<small>${esc(a.sub)}</small></button>`;
  }).join("");
}
function renderPlay(){
  const t = current();
  const q = queue();
  const done = state.tracks.filter(x=>x.done).length;
  let h = `<div class="prog"><i style="width:${state.tracks.length?done/state.tracks.length*100:0}%"></i></div>`;
  if(!t){
    h += `<div class="empty"><div class="big">🔬</div>
      <div>${state.tracks.length?"Autopsy complete. Check the drivers.":"No tracks loaded."}</div>
      <div class="hint">Import tracks — or a MusicTrainer week — to start dissecting.</div></div>`;
    $("view-play").innerHTML = h; return;
  }
  h += `<div class="atrack">
    <div class="t">${esc(t.name||"untitled")}</div>
    <div class="a">${esc(t.artists||"")} · ${done+1} of ${state.tracks.length} dissected</div>
    <div class="player-wrap"><button class="loadplayer" id="loadplayer">▶ load Spotify player</button></div>
    <div class="q">MACHINE READ <span style="color:var(--faint);letter-spacing:0;text-transform:none">— what the algorithm hears</span></div>
    <div class="machineread">${t.machine ? machineChips(t.machine) : (t.machineTried ? `<span class="hint">no machine read for this track</span>` : `<span class="hint">reading…</span>`)}</div>
    <div class="q">TRIAGE</div>
    <div class="triage">
      <button class="sbtn ${t.status==="skip"?"on-skip":""}" data-tri="skip">skip</button>
      <button class="sbtn ${t.status==="like"?"on-like":""}" data-tri="like">like</button>
      <button class="sbtn ${t.status==="keep"?"on-keep":""}" data-tri="keep">★ added</button>
    </div>
    <div class="q">SCORE</div>
    <div class="sliderow">
      <input type="range" min="1" max="10" step="1" value="${t.score??5}" id="score">
      <span class="sval" id="sval">${t.score??"—"}</span>
    </div>
    <div class="q">WHAT DID IT? — check all that apply</div>
    <div class="chipgrid" id="attrgrid">${chipGrid(t,"attrs")}</div>
    <div class="q">KILL ONE — remove one element and the track dies</div>
    <div class="chipgrid" id="killgrid">${chipGrid(t,"kill")}</div>
    ${window.SongNotes?SongNotes.fieldHTML(SongNotes.trackId(t.uri),{name:t.name,artists:t.artists,uri:t.uri},{label:"IN YOUR WORDS — what did it for you"}):""}
    <button class="nextbtn" id="nextbtn" ${t.status==="unscored"?"disabled":""}>next track →</button>
    <button class="skipbtn" id="laterbtn">do this one later</button>
    <div class="hint">The machine read the measurable stuff above — your taps are for what only ears can judge. Vocals count as texture, never as words.</div>
  </div>`;
  $("view-play").innerHTML = h;
  if(window.SongNotes) SongNotes.bind($("view-play"));

  const eu = embedUrl(t);
  $("loadplayer").onclick = ()=>{
    const w = document.querySelector("#view-play .player-wrap");
    w.innerHTML = eu ? `<iframe src="${eu}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`
                     : `<div class="hint">no Spotify URI for this track</div>`;
  };
  document.querySelectorAll("#view-play [data-tri]").forEach(b=>{
    b.onclick = ()=>{ t.status = (t.status===b.dataset.tri) ? "unscored" : b.dataset.tri; save(); renderPlay(); };
  });
  const slider = $("score");
  slider.addEventListener("input", ()=>{ t.score = +slider.value; $("sval").textContent = slider.value; });
  slider.addEventListener("change", ()=>{ save(); });
  document.querySelectorAll("#attrgrid [data-chip]").forEach(c=>{
    c.onclick = ()=>{
      const k = c.dataset.chip.split(":")[1];
      if(t.attrs[k]) delete t.attrs[k]; else t.attrs[k] = true;
      save(); refreshChips(t);
    };
  });
  document.querySelectorAll("#killgrid [data-chip]").forEach(c=>{
    c.onclick = ()=>{
      const k = c.dataset.chip.split(":")[1];
      t.kill = (t.kill===k) ? null : k;
      save(); refreshChips(t);
    };
  });
  $("nextbtn").onclick = ()=>{ t.done = true; save(); renderPlay(); };
  $("laterbtn").onclick = ()=>{
    const i = state.tracks.indexOf(t);
    state.tracks.push(state.tracks.splice(i,1)[0]);
    save(); renderPlay();
  };
  fetchMachine(t);
}
function refreshChips(t){
  $("attrgrid").innerHTML = chipGrid(t,"attrs");
  $("killgrid").innerHTML = chipGrid(t,"kill");
  document.querySelectorAll("#attrgrid [data-chip]").forEach(c=>{
    c.onclick = ()=>{ const k=c.dataset.chip.split(":")[1]; if(t.attrs[k]) delete t.attrs[k]; else t.attrs[k]=true; save(); refreshChips(t); };
  });
  document.querySelectorAll("#killgrid [data-chip]").forEach(c=>{
    c.onclick = ()=>{ const k=c.dataset.chip.split(":")[1]; t.kill=(t.kill===k)?null:k; save(); refreshChips(t); };
  });
}

/* ---------- drivers view ---------- */
function renderDrivers(){
  const done = state.tracks.filter(t=>t.done && t.status!=="unscored");
  const keeps = done.filter(t=>t.status==="keep");
  const base = done.length ? keeps.length/done.length : 0;
  let h = `<div class="bigstat">
    <div class="stat"><div class="v">${done.length}</div><div class="l">autopsied</div></div>
    <div class="stat"><div class="v">${done.length?Math.round(base*100)+"%":"—"}</div><div class="l">keep rate</div></div>
    <div class="stat"><div class="v">${keeps.length}</div><div class="l">keeps</div></div>
  </div>`;
  if(done.length < 3){
    h += `<div class="empty"><div>Dissect at least 3 tracks and the drivers appear here.</div></div>`;
    $("view-drivers").innerHTML = h; return;
  }
  const rows = ATTRS.map(a=>{
    const chk = done.filter(t=>t.attrs[a.k]);
    const kchk = chk.filter(t=>t.status==="keep").length;
    const p = chk.length ? kchk/chk.length : 0;
    const lift = base>0 ? p/base : 0;
    const killN = keeps.filter(t=>t.kill===a.k).length;
    const killAll = done.filter(t=>t.kill===a.k).length;
    return {a, n:chk.length, p, lift, killN, killAll};
  });
  const sig = rows.filter(r=>r.n>=2).sort((x,y)=>y.lift-x.lift);
  h += `<div class="sect">WHAT DRIVES YOUR KEEPS — lift over base rate</div>`;
  h += `<table class="dtable"><tr><th>driver</th><th>lift</th><th>keep-rate when checked</th><th>n</th></tr>`;
  sig.forEach(r=>{
    h += `<tr class="${r.lift>=1.5?"hot":""}"><td>${esc(r.a.label)}<br><small style="color:var(--faint)">${esc(r.a.sub)}</small></td>
      <td class="lift">×${r.lift.toFixed(1)}</td>
      <td><div class="bar"><i style="width:${Math.min(100,r.p*100)}%"></i></div><small class="mono">${Math.round(r.p*100)}%</small></td>
      <td class="mono">${r.n}</td></tr>`;
  });
  h += `</table><div class="hint">Lift = how much more likely a track is to be a keep when you check this driver, vs your base keep rate of ${Math.round(base*100)}%. Min 2 checks. The sample is small — treat early leaders as suspects, not verdicts.</div>`;

  const kills = rows.filter(r=>r.killAll>0).sort((x,y)=>y.killN-x.killN || y.killAll-x.killAll);
  if(kills.length){
    const maxK = Math.max(...kills.map(r=>r.killAll));
    h += `<div class="sect">LOAD-BEARING — "kill one" picks</div>`;
    h += `<table class="dtable"><tr><th>element</th><th></th><th>picks</th></tr>`;
    kills.forEach(r=>{
      h += `<tr><td>${esc(r.a.label)}</td>
        <td><div class="bar killbar"><i style="width:${maxK?r.killAll/maxK*100:0}%"></i></div></td>
        <td class="mono">${r.killAll}${r.killN?` <small style="color:var(--keep)">(${r.killN} on keeps)</small>`:""}</td></tr>`;
    });
    h += `</table><div class="hint">The element you'd remove to kill the track. The top of this list is what your keeps are built on.</div>`;
  }
  $("view-drivers").innerHTML = h;
}

/* ---------- import view ---------- */
function parseTracks(text){
  const out = [];
  text.split(/\n+/).map(s=>s.trim()).filter(Boolean).forEach(line=>{
    let uri=line, name="", artists="";
    const m = line.match(/^(spotify:(?:track:)?[A-Za-z0-9]{22}|https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/[A-Za-z0-9]{22}[^\s|]*)\s*\|?\s*(.*)$/);
    if(m){ uri=m[1]; const rest=(m[2]||"").trim();
      if(rest){ const p=rest.split("|").map(s=>s.trim()); name=p[0]||""; artists=p[1]||""; }
    }
    if(!/spotify/.test(uri)) return;
    out.push({ id:uid(), uri, name, artists, status:"unscored", score:null, attrs:{}, kill:null, done:false });
  });
  return out;
}
function renderImport(){
  $("view-import").innerHTML = `
    <div class="sect">ADD TRACKS — spotify links, one per line</div>
    <textarea id="imp-urls" placeholder="https://open.spotify.com/track/…"></textarea>
    <div class="btnrow"><button class="btn" id="imp-add">add tracks</button></div>
    <div class="sect">IMPORT FROM MUSICTRAINER — paste a week export</div>
    <textarea id="imp-mt" placeholder='{"id":"dw-…","tracks":[…]}'></textarea>
    <div class="btnrow"><button class="btn" id="imp-mtbtn">import week</button></div>
    <div class="sect">DATA</div>
    <div class="btnrow">
      <button class="btn ghost" id="exp-btn">export json</button>
      <button class="btn ghost" id="exp-notes">export song notes</button>
      <button class="btn ghost" id="imp-notes">import song notes…</button>
      <input type="file" id="imp-notes-file" accept=".json" class="hidden">
      <button class="btn ghost" id="reset-btn">reset all</button>
    </div>
    <div class="hint">${state.tracks.length} tracks in the lab · ${state.tracks.filter(t=>t.done).length} dissected</div>`;
  $("imp-add").onclick = ()=>{
    const ts = parseTracks($("imp-urls").value);
    if(!ts.length){ toast("no Spotify tracks found"); return; }
    state.tracks.push(...ts); cur=0; save(); renderPlay(); show("play"); toast(ts.length+" tracks added");
  };
  $("imp-mtbtn").onclick = ()=>{
    try{
      const w = JSON.parse($("imp-mt").value);
      if(!w || !Array.isArray(w.tracks)) throw new Error("no tracks array");
      const ts = w.tracks.filter(t=>t.uri).map(t=>({
        id:uid(), uri:t.uri, name:t.name||"", artists:t.artists||"",
        status:t.status||"unscored", score:(t.score==null?null:t.score),
        attrs:{}, kill:null, done:false
      }));
      if(!ts.length){ toast("no tracks with URIs"); return; }
      if(window.SongNotes) w.tracks.forEach(t=>{
        if(t.note && t.uri){ const id = SongNotes.trackId(t.uri); if(id) SongNotes.set(id, t.note, {name:t.name, artists:t.artists, uri:t.uri}); }
      });
      state.tracks.push(...ts); cur=0; save(); renderPlay(); show("play");
      toast(ts.length+" tracks imported"+(w.id?(" from "+w.id):""));
    }catch(e){ toast("import failed: "+e.message); }
  };
  $("exp-btn").onclick = ()=>{
    const out = Object.assign({}, state, { tracks: state.tracks.map(t=>{
      const c = Object.assign({}, t);
      if(window.SongNotes){ const id = SongNotes.trackId(t.uri); const n = id && SongNotes.get(id); if(n) c.note = n; }
      return c;
    })});
    const blob = new Blob([JSON.stringify(out,null,2)],{type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "autopsy-export.json"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  };
  const xn = $("exp-notes");
  if(xn && window.SongNotes) xn.onclick = ()=>{
    const blob = new Blob([SongNotes.exportJSON()],{type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "song-notes.json"; a.click();
    setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
  };
  const inb = $("imp-notes"), inf = $("imp-notes-file");
  if(inb && inf && window.SongNotes){
    inb.onclick = ()=>inf.click();
    inf.onchange = e=>{
      const f = e.target.files[0]; if(!f) return;
      const r = new FileReader();
      r.onload = ()=>{
        try{ toast(SongNotes.importJSON(r.result)+" notes imported"); renderPlay(); }
        catch(err){ toast("import failed: "+err.message); }
      };
      r.readAsText(f);
    };
  }
  $("reset-btn").onclick = ()=>{
    if(confirm("Wipe all autopsy data?")){ state={tracks:[]}; cur=0; save(); renderPlay(); renderDrivers(); renderImport(); }
  };
}

/* ---------- keyboard ---------- */
document.addEventListener("keydown", e=>{
  if($("view-play").classList.contains("hidden")) return;
  const tag = (document.activeElement||{}).tagName;
  if(tag==="INPUT"||tag==="TEXTAREA") return;
  const t = current(); if(!t) return;
  if(e.key==="1"){ t.status="skip"; save(); renderPlay(); }
  else if(e.key==="2"){ t.status="like"; save(); renderPlay(); }
  else if(e.key==="3"){ t.status="keep"; save(); renderPlay(); }
  else if(e.key==="n"||e.key==="Enter"){ if(t.status!=="unscored"){ t.done=true; save(); renderPlay(); } }
});

/* ---------- init ---------- */
$("nav-play").onclick = ()=>{ renderPlay(); show("play"); };
$("nav-drivers").onclick = ()=>{ renderDrivers(); show("drivers"); };
$("nav-import").onclick = ()=>{ renderImport(); show("import"); };
save();
renderImport();
renderPlay();
show("play");
})();
