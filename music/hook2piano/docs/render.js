"use strict";
/* Extracted from hook2piano/render_html.py — do not hand-edit; rerun docs/build.sh */
/* Piano-roll renderer — no staff notation. Two rolls per section: MELODY
   (right hand) and CHORDS (left hand), with note names above AND below
   each roll. Pure SVG, zero dependencies. */
window.H2P = window.H2P || {};
var W = 1020, KB = 64, PPB = 44, ROWH = 9;
var NUMH = 14, ABOVEH = 20, BELOWH = 20;   // label rows per roll
var GRID_TOP = NUMH + ABOVEH;              // y where the grid starts
var BLACK = {1:1, 3:1, 6:1, 8:1, 10:1};
var PC_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
var MEL_FILL = "#2b6cb0", CHD_FILL = "#2f855a";

function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
                  .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function midiName(m){ return PC_SHARP[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
function vfName(pair){ // ["g/3",""] -> "G3"; ["b/2","b"] -> "Bb2"
  var parts = String(pair[0]).split("/");
  return parts[0].toUpperCase() + (pair[1] || "") + parts[1];
}

// One piano roll SVG. mode: "melody" | "chords".
// measures: chunk of section measures; idx0: global measure index of chunk[0].
// lo/hi: section pitch range (shared so both rolls align).
function rollSVG(sec, measures, idx0, lo, hi, mode){
  var bpm = sec.beatsPerMeasure, mps = measures.length;
  var measW = bpm * PPB, gridW = mps * measW;
  var nRows = hi - lo + 1, gridH = nRows * ROWH;
  var H = GRID_TOP + gridH + BELOWH;
  var gx = KB, gy = GRID_TOP;
  var isMel = (mode === "melody");
  var fill = isMel ? MEL_FILL : CHD_FILL;
  var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" ' +
          'style="max-width:100%;height:auto;display:block;background:#fff" ' +
          'xmlns="http://www.w3.org/2000/svg">';
  var m, y, isBlack, k, b, x0;
  // grid rows + keyboard, top pitch first
  for(m = hi; m >= lo; m--){
    y = gy + (hi - m) * ROWH;
    isBlack = BLACK[((m % 12) + 12) % 12] === 1;
    s += '<rect x="' + gx + '" y="' + y + '" width="' + gridW + '" height="' + ROWH + '" ' +
         'fill="' + (isBlack ? "#f2f2f2" : "#ffffff") + '" stroke="#e6e6e6" stroke-width="0.5"/>';
    s += '<rect x="0" y="' + y + '" width="' + (isBlack ? Math.round(KB * 0.62) : KB) + '" ' +
         'height="' + ROWH + '" fill="' + (isBlack ? "#2b2b2b" : "#ffffff") + '" ' +
         'stroke="#b5b5b5" stroke-width="0.5"/>';
  }
  // barlines, beat lines, bar numbers
  for(k = 0; k < mps; k++){
    x0 = gx + k * measW;
    s += '<line x1="' + x0 + '" y1="' + gy + '" x2="' + x0 + '" y2="' + (gy + gridH) + '" stroke="#8a8a8a" stroke-width="1.2"/>';
    for(b = 1; b < bpm; b++){
      var xb = x0 + b * PPB;
      s += '<line x1="' + xb + '" y1="' + gy + '" x2="' + xb + '" y2="' + (gy + gridH) + '" stroke="#dedede" stroke-width="0.5"/>';
    }
    s += '<text x="' + (x0 + 5) + '" y="' + (NUMH - 4) + '" font-family="Georgia,serif" font-size="9" fill="#999">' + (idx0 + k + 1) + '</text>';
  }
  var xEnd = gx + gridW;
  s += '<line x1="' + xEnd + '" y1="' + gy + '" x2="' + xEnd + '" y2="' + (gy + gridH) + '" stroke="#8a8a8a" stroke-width="1.2"/>';

  // note-name labels, above AND below the roll; crowded labels are skipped
  var lastX = -1e9;
  function nameLabel(cx, txt, big){
    cx = Math.round(cx * 10) / 10;
    if(cx - lastX < 30) return;
    lastX = cx;
    var st = 'text-anchor="middle" font-family="Georgia,serif" font-size="' + (big ? 11 : 10) + '" ' +
             'fill="' + (big ? "#161616" : "#3d3d3d") + '"' + (big ? ' font-weight="bold"' : '');
    var ya = NUMH + ABOVEH - 6, yb = gy + gridH + 15;
    s += '<text x="' + cx + '" y="' + ya + '" ' + st + '>' + esc(txt) + '</text>';
    s += '<text x="' + cx + '" y="' + yb + '" ' + st + '>' + esc(txt) + '</text>';
  }
  function bar(x, w, midi, inner){
    var bx = Math.round((x + 1) * 10) / 10, bw = Math.max(2, Math.round((w - 2) * 10) / 10);
    var by = gy + (hi - midi) * ROWH + 1;
    s += '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + (ROWH - 2) + '" rx="2.5" fill="' + fill + '"/>';
    if(inner && bw > 30){
      s += '<text x="' + Math.round((bx + bw / 2) * 10) / 10 + '" y="' + (by + ROWH / 2 + 2.5) + '" ' +
           'text-anchor="middle" font-family="Georgia,serif" font-size="7.5" fill="#fff">' + esc(inner) + '</text>';
    }
  }
  measures.forEach(function(mm, kk){
    var off = kk * bpm;
    if(isMel){
      mm.notes.forEach(function(n){
        if(n.midi == null) return;
        var x = gx + (off + n.beat) * PPB, w = n.dur * PPB;
        bar(x, w, n.midi, null);
        nameLabel(x + w / 2, n.name || midiName(n.midi), false);
      });
    } else {
      mm.chords.forEach(function(c){
        var x = gx + (off + c.beat) * PPB, w = c.dur * PPB;
        (c.midis || []).forEach(function(tm, ti){
          var nm = (c.vfkeys && c.vfkeys[ti]) ? vfName(c.vfkeys[ti]) : midiName(tm);
          bar(x, w, tm, nm);
        });
        nameLabel(x + w / 2, c.label, true);
      });
    }
  });
  s += '</svg>';
  return s;
}

window.H2P.renderSong = function(SONG, mountEl){
  var html = '';
  SONG.sections.forEach(function(sec){
    var lo = 127, hi = 0;
    sec.measures.forEach(function(m){
      m.notes.forEach(function(n){
        if(n.midi != null){ if(n.midi < lo) lo = n.midi; if(n.midi > hi) hi = n.midi; }
      });
      m.chords.forEach(function(c){
        (c.midis || []).forEach(function(tm){
          if(tm < lo) lo = tm; if(tm > hi) hi = tm;
        });
      });
    });
    if(hi < lo){ lo = 60; hi = 72; }
    lo = Math.max(0, lo - 2); hi = Math.min(127, hi + 2);

    var seen = {}, prog = [];
    sec.measures.forEach(function(m){
      m.chords.forEach(function(c){ if(!seen[c.label]){ seen[c.label] = 1; prog.push(c.label); } });
    });
    html += '<div class="section">' +
      '<h1>' + esc(sec.title) + ' <span style="font-weight:normal;font-size:16px">&mdash; ' + esc(sec.name) + '</span></h1>' +
      '<h2>Key of ' + esc(sec.keyName) + ' &nbsp;|&nbsp; ' + sec.bpm + ' BPM &nbsp;|&nbsp; ' + sec.beatsPerMeasure + '/4</h2>' +
      '<div class="prog">Progression: ' + esc(prog.join(" \\u2013 ")) + '</div>';

    var totalM = sec.measures.length;
    var systems = Math.min(5, Math.max(1, Math.ceil(totalM / 5)));
    var mps = Math.ceil(totalM / systems);
    for(var si = 0; si < systems; si++){
      var chunk = sec.measures.slice(si * mps, si * mps + mps);
      if(!chunk.length) break;
      html += '<div class="rolltitle mel">MELODY <span>right hand</span></div>';
      html += rollSVG(sec, chunk, si * mps, lo, hi, "melody");
      html += '<div class="rolltitle chd">CHORDS <span>left hand</span></div>';
      html += rollSVG(sec, chunk, si * mps, lo, hi, "chords");
    }
    html += '</div>';
  });
  mountEl.innerHTML = html;
};
