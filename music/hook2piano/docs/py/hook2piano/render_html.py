"""Render sections as printable piano-roll pages.

No staff notation. Two views:
  - Harmonic view (default): one merged lane per system. Chords become
    tinted background bands; melody notes sit on top, colored by their
    relation to the active chord (chord tone / diatonic tension / chromatic).
    Labels show note names (default) or intervals vs the chord root.
    A dashed contour line traces the phrase shape, and each section gets
    a chord-shape palette (mini one-octave keyboards, each chord once).
  - Classic view: the original two piano rolls (melody / chords).
The output HTML is fully self-contained (inline SVG, no JS dependencies).
"""

import json

from .parse import split_measures
from .theory import key_signature


def sections_to_js(sections):
    """Convert parsed Sections to the JSON-serializable SONG structure the
    piano-roll renderer consumes. Shared by the CLI and the web harness
    (which calls this from Pyodide)."""
    js_sections = []
    for s in sections:
        js_sections.append({
            "name": s.name, "title": s.title,
            "keySig": key_signature(s.key),
            "keyName": f"{s.key.tonic} {s.key.scale}",
            "bpm": s.bpm, "beatsPerMeasure": s.beats_per_measure,
            "measures": split_measures(s),
        })
    return {"sections": js_sections}


def render(sections):
    data = json.dumps(sections_to_js(sections))

    return _PAGE.replace("__DATA__", data)


_PAGE = """<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>hook2piano</title>
<style>
  body { font-family: Georgia, serif; margin: 0; padding: 12px 18px; color: #111; }
  .section { page-break-after: always; }
  .section:last-child { page-break-after: avoid; }
  h1 { font-size: 22px; margin: 0 0 2px; }
  h2 { font-size: 15px; font-weight: normal; margin: 0 0 10px; color: #444; }
  .prog { font-size: 12px; color: #555; margin: 0 0 8px; }
  .rolltitle { font-size: 13px; font-weight: bold; letter-spacing: 2px; margin: 16px 0 4px; }
  .rolltitle.mel { color: #2b6cb0; }
  .rolltitle.chd { color: #2f855a; }
  .rolltitle span { font-weight: normal; letter-spacing: 0; color: #777; font-size: 12px; }
  .h2p-toolbar { display: flex; gap: 18px; align-items: center; margin: 0 0 10px;
    font-size: 13px; color: #444; flex-wrap: wrap; }
  .h2p-toolbar .grp { display: flex; gap: 6px; align-items: center; }
  .h2p-toolbar button { font-family: Georgia, serif; font-size: 12px; padding: 3px 10px;
    border: 1px solid #bbb; background: #fff; border-radius: 4px; cursor: pointer; color: #444; }
  .h2p-toolbar button.active { background: #2b2b2b; color: #fff; border-color: #2b2b2b; }
  .h2p-legend { display: flex; gap: 14px; align-items: center; font-size: 12px; color: #555; }
  .h2p-legend .sw { display: inline-block; width: 12px; height: 9px; border-radius: 3px; margin-right: 4px; }
  .h2p-palette { display: flex; gap: 18px; margin: 6px 0 10px; flex-wrap: wrap; align-items: flex-end; }
  .h2p-chordbox { text-align: center; }
  .h2p-chordbox .nm { font-size: 15px; font-weight: bold; margin-bottom: 2px; }
  .h2p-lead { font-family: "Courier New", monospace; font-size: 13px; line-height: 1.5;
    background: #fafafa; border: 1px solid #e2e2e2; border-radius: 6px;
    padding: 10px 14px; margin: 8px 0 14px; white-space: pre; overflow-x: auto; }
  @media print {
    body { padding: 0; }
    .noprint { display: none; }
  }
</style>
</head><body>
<div class="noprint" style="margin-bottom:10px;font-size:13px;color:#666">
  hook2piano &mdash; print this page (or save as PDF) for the piano-roll sheet.
  Harmonic view: chords are the tinted bands, melody sits on top.
  Teal = chord tone, coral = diatonic tension, slate = chromatic.
  Labels toggle between note names and intervals vs the chord root.
</div>
<div id="score"></div>
<script>const SONG = __DATA__;</script>
<script>
(function(){
"use strict";
/* Piano-roll renderer — no staff notation. Harmonic view (default): one
   merged lane per system, chords as background bands, melody colored by
   chord relation, contour line, chord-shape palette per section.
   Classic view: the original MELODY / CHORDS two-roll layout.
   Pure SVG + tiny toolbar JS, zero dependencies. */
window.H2P = window.H2P || {};
var W = 1020, KB = 64, PPB = 44;
window.H2P.PPB = PPB; window.H2P.KB = KB;   // layout constants the player needs
var NUMH = 14, ABOVEH = 20, BELOWH = 20;   // label rows per roll
var GRID_TOP = NUMH + ABOVEH;              // y where the grid starts
var BLACK = {1:1, 3:1, 6:1, 8:1, 10:1};
var PC_SHARP = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
var MEL_FILL = "#2b6cb0", CHD_FILL = "#2f855a";
// harmonic-view palette
var TONE_FILL = "#1d9e75", TENSION_FILL = "#d85a30", CHROM_FILL = "#718096";
var CHORD_TONE_FILL = "#2f855a", BAND_FILL = "#f1efe8", BAND_EDGE = "#d3d1c7";
var H_ROWH = 24, H_TOP_PAD = 30, H_KB = 46;

function esc(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
                  .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function midiName(m){ return PC_SHARP[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
function pc(m){ return ((m % 12) + 12) % 12; }
function vfName(pair){ // ["g/3",""] -> "G3"; ["b/2","b"] -> "Bb2"
  var parts = String(pair[0]).split("/");
  return parts[0].toUpperCase() + (pair[1] || "") + parts[1];
}
function rootPc(label){ // "G#m" -> 8, "E" -> 4, "Bbmaj7" -> 10
  var m = /^([A-G])([#b]?)/.exec(String(label || ""));
  if(!m) return null;
  var base = {C:0, D:2, E:4, F:5, G:7, A:9, B:11}[m[1]];
  if(m[2] === "#") base += 1;
  if(m[2] === "b") base -= 1;
  return ((base % 12) + 12) % 12;
}
function keyPcs(keyName){ // "G# minor" -> pitch classes of the key scale
  var m = /^([A-G][#b]?)\s+(major|minor)/i.exec(String(keyName || ""));
  if(!m) return null;
  var tonic = rootPc(m[1]);
  var iv = /minor/i.test(m[2]) ? [0,2,3,5,7,8,10] : [0,2,4,5,7,9,11];
  var out = {};
  iv.forEach(function(i){ out[(tonic + i) % 12] = 1; });
  return out;
}
var INT_NAMES = ["1","b9","9","b3","3","11","b5","5","#5","6","b7","maj7"];
function intervalName(midi, chordRoot){
  if(chordRoot == null) return midiName(midi);
  return INT_NAMES[(pc(midi) - chordRoot + 12) % 12];
}
// relation of a melody pitch to the active chord: tone | tension | chromatic | none
function noteRelation(midi, chord, scalePcs){
  var p = pc(midi);
  if(chord && chord.pcs && chord.pcs[p]) return "tone";
  if(scalePcs && scalePcs[p]) return chord ? "tension" : "none";
  return "chromatic";
}
function relFill(rel){
  return rel === "tone" ? TONE_FILL : rel === "tension" ? TENSION_FILL :
         rel === "chromatic" ? CHROM_FILL : MEL_FILL;
}
// active chord (with pitch-class set) sounding at absolute beat `ab` in chunk
function chordAt(chords, ab){
  for(var i = 0; i < chords.length; i++){
    var c = chords[i];
    if(ab >= c.abeat - 1e-9 && ab < c.abeat + c.dur - 1e-9) return c;
  }
  return null;
}
function prepChord(c, off){
  var pcs = {};
  (c.midis || []).forEach(function(m){ pcs[pc(m)] = 1; });
  return { label: c.label, beat: c.beat, dur: c.dur, abeat: off + c.beat,
           midis: c.midis || [], pcs: pcs, root: rootPc(c.label) };
}

// Mini one-octave keyboard SVG with the chord's pitch classes lit.
function miniKbSVG(chordPcs){
  var wk = 16, bh = 28, bw = 10, H = 46;
  var whitePcs = [0,2,4,5,7,9,11], blackPcs = [1,3,-1,6,8,10,-1];
  var s = '<svg width="' + (wk * 7) + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">';
  var i, x;
  for(i = 0; i < 7; i++){
    x = i * wk;
    s += '<rect x="' + x + '" y="0" width="' + wk + '" height="' + H + '" fill="' +
         (chordPcs[whitePcs[i]] ? TONE_FILL : "#ffffff") + '" stroke="#888780" stroke-width="0.8"/>';
  }
  for(i = 0; i < 7; i++){
    if(blackPcs[i] < 0) continue;
    x = (i + 1) * wk - bw / 2;
    s += '<rect x="' + x + '" y="0" width="' + bw + '" height="' + bh + '" fill="' +
         (chordPcs[blackPcs[i]] ? TONE_FILL : "#2b2b2b") + '" stroke="#555" stroke-width="0.6"/>';
  }
  s += "</svg>";
  return s;
}
function paletteHTML(sec){
  var seen = {}, boxes = "";
  sec.measures.forEach(function(m){
    m.chords.forEach(function(c){
      if(seen[c.label]) return;
      seen[c.label] = 1;
      var pcs = {};
      (c.midis || []).forEach(function(tm){ pcs[pc(tm)] = 1; });
      boxes += '<div class="h2p-chordbox"><div class="nm">' + esc(c.label) + "</div>" +
               miniKbSVG(pcs) + "</div>";
    });
  });
  if(!boxes) return "";
  return '<div class="h2p-palette">' + boxes + "</div>";
}

// Harmonic view: one merged lane. Chords = tinted bands; chord tones =
// dimmed green blocks behind; melody on top colored by chord relation.
// used: sorted-desc array of midi pitches that sound in this chunk.
function harmonicSVG(sec, measures, idx0, used, t0, labels){
  var bpm = sec.beatsPerMeasure, mps = measures.length;
  var measW = bpm * PPB, gridW = mps * measW;
  var nRows = used.length, gridH = Math.max(1, nRows) * H_ROWH;
  var gy = H_TOP_PAD, gx = H_KB;
  var H = gy + gridH + 8;
  var t1 = t0 + mps * bpm * 60 / sec.bpm;
  var rowOf = {};
  used.forEach(function(m, i){ rowOf[m] = i; });
  var scalePcs = keyPcs(sec.keyName);
  // flatten chords with absolute beats for chordAt lookups
  var chords = [];
  measures.forEach(function(mm, kk){
    var off = kk * bpm;
    mm.chords.forEach(function(c){ chords.push(prepChord(c, off)); });
  });
  var s = '<svg class="h2p-roll" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" ' +
          'data-t0="' + t0.toFixed(3) + '" data-t1="' + t1.toFixed(3) + '" data-bpm="' + sec.bpm + '" ' +
          'style="max-width:100%;height:auto;display:block;background:#fff" ' +
          'xmlns="http://www.w3.org/2000/svg">';
  var k, b, x0;
  // chord bands (behind everything)
  chords.forEach(function(c){
    var bx = gx + c.abeat * PPB, bw = Math.max(3, c.dur * PPB);
    s += '<rect x="' + bx + '" y="' + gy + '" width="' + bw + '" height="' + gridH + '" rx="4" ' +
         'fill="' + BAND_FILL + '" stroke="' + BAND_EDGE + '" stroke-width="0.5"/>';
    s += '<text x="' + (bx + 8) + '" y="' + (gy + 18) + '" font-family="Georgia,serif" ' +
         'font-size="14" font-weight="bold" fill="#2c2c2a">' + esc(c.label) + "</text>";
  });
  // pitch rows + left labels
  used.forEach(function(m, i){
    var y = gy + i * H_ROWH;
    s += '<rect x="' + gx + '" y="' + y + '" width="' + gridW + '" height="' + H_ROWH + '" ' +
         'fill="none" stroke="#ececec" stroke-width="0.5"/>';
    s += '<text x="' + (gx - 6) + '" y="' + (y + H_ROWH / 2 + 4) + '" text-anchor="end" ' +
         'font-family="Georgia,serif" font-size="11" fill="#5f5e5a">' + esc(midiName(m)) + "</text>";
  });
  // barlines, beat lines, bar numbers
  for(k = 0; k < mps; k++){
    x0 = gx + k * measW;
    s += '<line x1="' + x0 + '" y1="' + gy + '" x2="' + x0 + '" y2="' + (gy + gridH) + '" stroke="#8a8a8a" stroke-width="1.2"/>';
    for(b = 1; b < bpm; b++){
      var xb = x0 + b * PPB;
      s += '<line x1="' + xb + '" y1="' + gy + '" x2="' + xb + '" y2="' + (gy + gridH) + '" stroke="#dedede" stroke-width="0.5"/>';
    }
    s += '<text x="' + (x0 + 5) + '" y="' + 12 + '" font-family="Georgia,serif" font-size="9" fill="#999">' + (idx0 + k + 1) + "</text>";
  }
  var xEnd = gx + gridW;
  s += '<line x1="' + xEnd + '" y1="' + gy + '" x2="' + xEnd + '" y2="' + (gy + gridH) + '" stroke="#8a8a8a" stroke-width="1.2"/>';
  // chord-tone blocks (left hand), dimmed behind the melody
  chords.forEach(function(c){
    var bx = gx + c.abeat * PPB, bw = Math.max(3, c.dur * PPB - 2);
    c.midis.forEach(function(tm){
      if(!(tm in rowOf)) return;
      var by = gy + rowOf[tm] * H_ROWH + 3;
      s += '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + (H_ROWH - 6) +
           '" rx="3" fill="' + CHORD_TONE_FILL + '" opacity="0.35"/>';
    });
  });
  // melody blocks, colored by chord relation, with labels + contour
  var pts = [];
  measures.forEach(function(mm, kk){
    var off = kk * bpm;
    mm.notes.forEach(function(n){
      if(n.midi == null || !(n.midi in rowOf)) return;
      var ab = off + n.beat;
      var ch = chordAt(chords, ab + 1e-6);
      var rel = noteRelation(n.midi, ch, scalePcs);
      var x = gx + ab * PPB, w = Math.max(6, n.dur * PPB - 2);
      var by = gy + rowOf[n.midi] * H_ROWH + 3;
      s += '<rect x="' + x + '" y="' + by + '" width="' + w + '" height="' + (H_ROWH - 6) +
           '" rx="3" fill="' + relFill(rel) + '"/>';
      var lab = labels === "intervals" ? intervalName(n.midi, ch ? ch.root : null)
                                       : (n.name || midiName(n.midi));
      s += '<text x="' + (x + w / 2) + '" y="' + (by - 4) + '" text-anchor="middle" ' +
           'font-family="Georgia,serif" font-size="11" fill="#444441">' + esc(lab) + "</text>";
      pts.push((x + w / 2).toFixed(1) + "," + (by + (H_ROWH - 6) / 2).toFixed(1));
    });
  });
  if(pts.length > 1){
    s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#888780" ' +
         'stroke-width="1" stroke-dasharray="3 3"/>';
  }
  // playhead line, parked off-canvas until the player moves it
  s += '<line class="h2p-ph" x1="-20" y1="' + gy + '" x2="-20" y2="' + (gy + gridH) + '" ' +
       'stroke="#d62728" stroke-width="2" style="display:none"/>';
  s += "</svg>";
  return s;
}

// Compact lead-sheet text: chord symbols over melody note names, per bar.
function leadSheetHTML(sec){
  var lines = [], chLine = "", melLine = "";
  sec.measures.forEach(function(m, mi){
    var chs = m.chords.map(function(c){ return c.label; }).join(" ");
    var names = m.notes.filter(function(n){ return n.midi != null; })
                       .map(function(n){ return n.name || midiName(n.midi); }).join(" ");
    var cell = "|" + " " + chs;
    while(cell.length < 24) cell += " ";
    chLine += cell;
    var mcell = "|" + " " + names;
    while(mcell.length < 24) mcell += " ";
    melLine += mcell;
    if(mi % 4 === 3 || mi === sec.measures.length - 1){
      lines.push(chLine + "|");
      lines.push(melLine + "|");
      lines.push("");
      chLine = ""; melLine = "";
    }
  });
  return '<div class="h2p-lead">' + esc(lines.join("\n")) + "</div>";
}

// One piano roll SVG (classic view). mode: "melody" | "chords".
// measures: chunk of section measures; idx0: global measure index of chunk[0].
// used: sorted-desc array of midi pitches that sound in the SECTION (shared
// so both rolls align, and collapsed so unused keys take no space).
// t0: song time in seconds where this system starts (for the playhead).
var C_ROWH = 12;
function rollSVG(sec, measures, idx0, used, mode, t0){
  var bpm = sec.beatsPerMeasure, mps = measures.length;
  var measW = bpm * PPB, gridW = mps * measW;
  var nRows = used.length, gridH = nRows * C_ROWH;
  var H = GRID_TOP + gridH + BELOWH;
  var gx = KB, gy = GRID_TOP;
  var t1 = t0 + mps * bpm * 60 / sec.bpm;
  var rowOf = {};
  used.forEach(function(m, i){ rowOf[m] = i; });
  var isMel = (mode === "melody");
  var fill = isMel ? MEL_FILL : CHD_FILL;
  var s = '<svg class="h2p-roll" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" ' +
          'data-t0="' + t0.toFixed(3) + '" data-t1="' + t1.toFixed(3) + '" data-bpm="' + sec.bpm + '" ' +
          'style="max-width:100%;height:auto;display:block;background:#fff" ' +
          'xmlns="http://www.w3.org/2000/svg">';
  var m, y, isBlack, k, b, x0;
  // grid rows + keyboard, top pitch first (only pitches that sound)
  for(m = 0; m < used.length; m++){
    y = gy + m * C_ROWH;
    isBlack = BLACK[pc(used[m])] === 1;
    s += '<rect x="' + gx + '" y="' + y + '" width="' + gridW + '" height="' + C_ROWH + '" ' +
         'fill="' + (isBlack ? "#f2f2f2" : "#ffffff") + '" stroke="#e6e6e6" stroke-width="0.5"/>';
    s += '<rect x="0" y="' + y + '" width="' + (isBlack ? Math.round(KB * 0.62) : KB) + '" ' +
         'height="' + C_ROWH + '" fill="' + (isBlack ? "#2b2b2b" : "#ffffff") + '" ' +
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
    s += '<text x="' + (x0 + 5) + '" y="' + (NUMH - 4) + '" font-family="Georgia,serif" font-size="9" fill="#999">' + (idx0 + k + 1) + "</text>";
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
    if(!(midi in rowOf)) return;
    var bx = Math.round((x + 1) * 10) / 10, bw = Math.max(2, Math.round((w - 2) * 10) / 10);
    var by = gy + rowOf[midi] * C_ROWH + 1;
    s += '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + (C_ROWH - 2) + '" rx="2.5" fill="' + fill + '"/>';
    if(inner && bw > 30){
      s += '<text x="' + Math.round((bx + bw / 2) * 10) / 10 + '" y="' + (by + C_ROWH / 2 + 2.5) + '" ' +
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
  // playhead line, parked off-canvas until the player moves it
  s += '<line class="h2p-ph" x1="-20" y1="' + gy + '" x2="-20" y2="' + (gy + gridH) + '" ' +
       'stroke="#d62728" stroke-width="2" style="display:none"/>';
  s += "</svg>";
  return s;
}

function usedPitches(measures){
  var seen = {};
  measures.forEach(function(m){
    m.notes.forEach(function(n){ if(n.midi != null) seen[n.midi] = 1; });
    m.chords.forEach(function(c){ (c.midis || []).forEach(function(tm){ seen[tm] = 1; }); });
  });
  var out = Object.keys(seen).map(Number).sort(function(a, b){ return b - a; });
  if(!out.length){ for(var m = 72; m >= 60; m--) out.push(m); }
  return out;
}

function toolbarHTML(opts){
  function btn(group, val, label){
    return '<button data-grp="' + group + '" data-val="' + val + '"' +
           (opts[group] === val ? ' class="active"' : "") + ">" + label + "</button>";
  }
  return '<div class="h2p-toolbar noprint"><div class="grp">View: ' +
         btn("view", "harmonic", "Harmonic") + btn("view", "classic", "Piano roll") +
         '</div><div class="grp">Labels: ' +
         btn("labels", "names", "Note names") + btn("labels", "intervals", "Intervals") +
         '</div><div class="grp">' +
         '<button data-grp="lead" data-val="' + (opts.lead ? "off" : "on") + '"' +
         (opts.lead ? ' class="active"' : "") + ">Lead sheet</button></div>" +
         '<div class="h2p-legend"><span><span class="sw" style="background:' + TONE_FILL +
         '"></span>Chord tone</span><span><span class="sw" style="background:' + TENSION_FILL +
         '"></span>Tension</span><span><span class="sw" style="background:' + CHROM_FILL +
         '"></span>Chromatic</span></div></div>';
}

window.H2P.renderSong = function(SONG, mountEl, opts){
  window.H2P.lastSong = SONG;   // the player reads this
  opts = opts || {};
  if(!opts.view) opts.view = "harmonic";
  if(!opts.labels) opts.labels = "names";
  window.H2P.lastOpts = opts;
  var html = toolbarHTML(opts);
  var songT = 0;                // seconds elapsed before the current section
  SONG.sections.forEach(function(sec){
    var seen = {}, prog = [];
    sec.measures.forEach(function(m){
      m.chords.forEach(function(c){ if(!seen[c.label]){ seen[c.label] = 1; prog.push(c.label); } });
    });
    html += '<div class="section">' +
      '<h1>' + esc(sec.title) + ' <span style="font-weight:normal;font-size:16px">&mdash; ' + esc(sec.name) + "</span></h1>" +
      '<h2>Key of ' + esc(sec.keyName) + " &nbsp;|&nbsp; " + sec.bpm + " BPM &nbsp;|&nbsp; " + sec.beatsPerMeasure + "/4</h2>" +
      '<div class="prog">Progression: ' + esc(prog.join(" \u2013 ")) + "</div>";
    if(opts.view === "harmonic") html += paletteHTML(sec);
    if(opts.lead) html += leadSheetHTML(sec);
    var secUsed = usedPitches(sec.measures);   // section pitch set, shared by every system

    var totalM = sec.measures.length;
    var systems = Math.min(5, Math.max(1, Math.ceil(totalM / 5)));
    var mps = Math.ceil(totalM / systems);
    for(var si = 0; si < systems; si++){
      var chunk = sec.measures.slice(si * mps, si * mps + mps);
      if(!chunk.length) break;
      var sysT0 = songT + si * mps * sec.beatsPerMeasure * 60 / sec.bpm;
      if(opts.view === "harmonic"){
        html += harmonicSVG(sec, chunk, si * mps, secUsed, sysT0, opts.labels);
      } else {
        html += '<div class="rolltitle mel">MELODY <span>right hand</span></div>';
        html += rollSVG(sec, chunk, si * mps, secUsed, "melody", sysT0);
        html += '<div class="rolltitle chd">CHORDS <span>left hand</span></div>';
        html += rollSVG(sec, chunk, si * mps, secUsed, "chords", sysT0);
      }
    }
    html += "</div>";
    songT += sec.measures.length * sec.beatsPerMeasure * 60 / sec.bpm;
  });
  mountEl.innerHTML = html;
  var btns = mountEl.querySelectorAll(".h2p-toolbar button");
  for(var i = 0; i < btns.length; i++){
    (function(b){
      b.addEventListener("click", function(){
        var o = { view: window.H2P.lastOpts.view, labels: window.H2P.lastOpts.labels,
                  lead: window.H2P.lastOpts.lead };
        var g = b.getAttribute("data-grp"), v = b.getAttribute("data-val");
        if(g === "lead") o.lead = !o.lead;
        else o[g] = v;
        window.H2P.renderSong(window.H2P.lastSong, mountEl, o);
      });
    })(btns[i]);
  }
};
window.H2P.renderSong(SONG, document.getElementById("score"));
})();
</script>
</body></html>
"""
