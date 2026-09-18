/* SongNotes — shared "why did I like it?" store for the music ranker tools.
 * One drop-in script, zero dependencies. Notes are keyed by Spotify track id,
 * so a note written in MusicTrainer shows up in Autopsy and vice versa.
 *
 * Usage (in any tool):
 *   <script src="../shared/song-notes.js?v=1"></script>
 *   ... in per-track HTML:  SongNotes.fieldHTML(trackId, {name, artists, uri})
 *   ... after render:       SongNotes.bind(rootElement)
 *
 * Store shape (localStorage "songnotes.v1"):
 *   { "<22-char id>": { note, name, artists, uri, updatedAt } }
 */
(function(){
"use strict";
var LS_KEY = "songnotes.v1";
var ID_RE = /(?:open\.spotify\.com\/track\/|spotify:track:)([A-Za-z0-9]{22})/;

function load(){
  try{
    var raw = localStorage.getItem(LS_KEY);
    if(raw){ var s = JSON.parse(raw); if(s && typeof s==="object") return s; }
  }catch(e){}
  return {};
}
var store = load();
var listeners = [];
function persist(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(store)); }catch(e){} }

function esc(s){
  return String(s==null?"":s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];
  });
}

var api = {
  trackId: function(uri){
    var m = String(uri||"").match(ID_RE);
    return m ? m[1] : null;
  },
  get: function(id){ return store[id] ? store[id].note : ""; },
  entry: function(id){ return store[id] || null; },
  set: function(id, note, meta){
    if(!id) return;
    note = String(note==null?"":note);
    if(!note.trim()){
      if(store[id]){ delete store[id]; persist(); emit(id, ""); }
      return;
    }
    meta = meta || {};
    store[id] = { note: note, name: meta.name||"", artists: meta.artists||"",
                  uri: meta.uri||"", updatedAt: new Date().toISOString() };
    persist(); emit(id, note);
  },
  has: function(id){ return !!(store[id] && store[id].note && store[id].note.trim()); },
  count: function(){ return Object.keys(store).length; },
  all: function(){ return store; },
  exportJSON: function(){ return JSON.stringify({ exportedAt: new Date().toISOString(), notes: store }, null, 2); },
  importJSON: function(json){
    var d = typeof json==="string" ? JSON.parse(json) : json;
    var notes = d && (d.notes || d);
    if(!notes || typeof notes!=="object") throw new Error("no notes found");
    var n = 0;
    Object.keys(notes).forEach(function(id){
      var e = notes[id];
      if(!/^[A-Za-z0-9]{22}$/.test(id)) return;
      if(typeof e==="string"){ store[id] = { note:e, name:"", artists:"", uri:"", updatedAt:new Date().toISOString() }; n++; }
      else if(e && typeof e.note==="string" && e.note.trim()){ store[id] = e; n++; }
    });
    persist(); emit(null, null);
    return n;
  },
  onChange: function(fn){ listeners.push(fn); },

  /* HTML for one per-track note field. Bind after render with SongNotes.bind(root). */
  fieldHTML: function(id, meta, opts){
    if(!id) return "";
    opts = opts || {};
    var open = api.has(id) ? " open" : "";
    var label = opts.label || "WHY? — what did it for you";
    var ph = opts.placeholder || "in your own words: the moment, the sound, the reason it made the cut…";
    return '<details class="whybox"'+open+' data-whybox="'+esc(id)+'">'
      + '<summary class="whysum">'+esc(label)
      + (api.has(id) ? ' <span class="whydot" title="note saved">●</span>' : '')
      + '</summary>'
      + '<textarea class="whytext" data-songnote="'+esc(id)+'"'
      + ' data-meta=\''+esc(JSON.stringify({name:meta&&meta.name||"",artists:meta&&meta.artists||"",uri:meta&&meta.uri||""}))+ '\''
      + ' placeholder="'+esc(ph)+'">'+esc(api.get(id))+'</textarea>'
      + '</details>';
  },

  bind: function(root){
    root = root || document;
    root.querySelectorAll("textarea[data-songnote]").forEach(function(ta){
      if(ta._snBound) return; ta._snBound = true;
      var id = ta.getAttribute("data-songnote");
      var meta = {};
      try{ meta = JSON.parse(ta.getAttribute("data-meta")||"{}"); }catch(e){}
      var save = function(){
        api.set(id, ta.value, meta);
        var box = ta.closest("[data-whybox]");
        if(box){
          var sum = box.querySelector(".whysum");
          if(sum){
            var dot = sum.querySelector(".whydot");
            if(api.has(id) && !dot){
              dot = document.createElement("span");
              dot.className = "whydot"; dot.title = "note saved";
              dot.textContent = "●"; sum.appendChild(dot);
            } else if(!api.has(id) && dot){ dot.remove(); }
          }
        }
      };
      var t; ta.addEventListener("input", function(){ clearTimeout(t); t = setTimeout(save, 600); });
      ta.addEventListener("change", function(){ clearTimeout(t); save(); });
    });
  }
};

function emit(id, note){ listeners.forEach(function(fn){ try{ fn(id, note); }catch(e){} }); }

window.SongNotes = api;
})();
