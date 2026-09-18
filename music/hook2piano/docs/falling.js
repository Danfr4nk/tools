"use strict";
/* hook2piano falling-notes view (Synthesia-style), drop-in module.
 *
 * Plug-in: load AFTER render.js and player.js:
 *   <script src="falling.js"></script>
 * It wraps H2P.renderSong, so every rendered song gets a Sheet / Falling
 * toggle above the score. The sheet stays the print view.
 *
 * One real keyboard at the bottom; notes fall toward it. Left hand (chord
 * voicings) and right hand (melody) share the keyboard, split by pitch.
 * Chord changes are marked with a line and the chord name. "Harmony" colour
 * mode tints melody notes as chord tone vs tension and labels the interval
 * above the current chord root.
 *
 * Reads playback time from H2P.player.time() / seek() (see player.js patch);
 * without them it still renders and scrubs, just not synced to audio.
 */
window.H2P = window.H2P || {};

(function () {
  var LH = "#2f855a", RH = "#2b6cb0", TENSION = "#dd6b20";
  var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  var PC = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  var LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  var IVL = ["R", "b9", "9", "b3", "3", "11", "#11", "5", "b13", "6", "b7", "maj7"];
  var KEYH = 64;                         // white key height (css px)
  var STORE = "h2p.falling";

  function load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save(o) { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) {} }
  var prefs = load();
  var st = {
    view: prefs.view === "falling" ? "falling" : "sheet",
    color: prefs.color === "hands" ? "hands" : "harmony",
    ppb: prefs.ppb || 56                 // pixels per beat
  };
  function persist() { save({ view: st.view, color: st.color, ppb: st.ppb }); }

  function rootPc(label) {
    var m = /^([A-G])([#b]?)/.exec(label || "");
    if (!m) return null;
    return (LETTER[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? 11 : 0)) % 12;
  }

  /* ---------- flatten SONG into timed events (same clock as player.js) ---------- */
  function flatten(song) {
    var notes = [], chords = [], bars = [], secs = [], t = 0, lo = 127, hi = 0;
    (song.sections || []).forEach(function (sec) {
      var spb = 60 / sec.bpm, bm = sec.beatsPerMeasure;
      secs.push({ t: t, name: sec.name });
      sec.measures.forEach(function (m, mi) {
        var base = t + mi * bm * spb;
        bars.push({ t: base, n: mi + 1 });
        (m.chords || []).forEach(function (c) {
          var pcs = {};
          (c.midis || []).forEach(function (x) { pcs[((x % 12) + 12) % 12] = 1; });
          var ev = { t: base + c.beat * spb, e: base + (c.beat + c.dur) * spb,
                     label: c.label, roman: c.roman || "", root: rootPc(c.label), pcs: pcs };
          chords.push(ev);
          (c.midis || []).forEach(function (x) {
            notes.push({ t: ev.t, e: ev.e, midi: x, hand: "lh" });
            if (x < lo) lo = x; if (x > hi) hi = x;
          });

        });
        (m.notes || []).forEach(function (n) {
          if (n.midi == null) return;
          var nt = base + n.beat * spb;
          notes.push({ t: nt, e: nt + Math.max(0.05, n.dur * spb), midi: n.midi, hand: "rh",
                       name: n.name || (PC[n.midi % 12] + (Math.floor(n.midi / 12) - 1)) });
          if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi;
        });
      });
      t += sec.measures.length * bm * spb;
    });
    chords.sort(function (a, b) { return a.t - b.t; });
    // tag each melody note with the chord sounding at its onset
    var ci = 0;
    notes.sort(function (a, b) { return a.t - b.t; });
    notes.forEach(function (n) {
      if (n.hand !== "rh") return;
      while (ci + 1 < chords.length && chords[ci + 1].t <= n.t + 1e-6) ci++;
      var c = chords[ci];
      if (c && c.t <= n.t + 1e-6 && c.root != null) {
        var pc = n.midi % 12;
        n.tone = !!c.pcs[pc];
        n.ivl = IVL[(pc - c.root + 12) % 12];
      }
    });
    if (hi < lo) { lo = 60; hi = 72; }
    return { notes: notes, chords: chords, bars: bars, secs: secs, dur: t, lo: lo, hi: hi,
             bpm0: (song.sections && song.sections[0] && song.sections[0].bpm) || 100 };
  }

  /* ---------- keyboard geometry ---------- */
  function keyLayout(lo, hi, W) {
    lo -= 2; hi += 2;                               // a little air on both sides
    while (BLACK[lo % 12]) lo--;
    while (BLACK[hi % 12]) hi++;
    var whites = [];
    for (var m = lo; m <= hi; m++) if (!BLACK[m % 12]) whites.push(m);
    var ww = W / whites.length, bw = ww * 0.6, pos = {};
    whites.forEach(function (m, i) { pos[m] = { x: i * ww, w: ww, black: false }; });
    for (m = lo; m <= hi; m++) if (BLACK[m % 12]) pos[m] = { x: pos[m - 1].x + ww - bw / 2, w: bw, black: true };
    return { lo: lo, hi: hi, pos: pos, ww: ww };
  }

  /* ---------- the view ---------- */
  var V = null;   // { wrap, canvas, ctx, data, keys, W, H, localT, raf, dirty, lastT }

  function timeNow() {
    var p = window.H2P.player;
    if (p && p.time) return p.time();
    return V ? V.localT : 0;
  }
  function playing() { var p = window.H2P.player; return !!(p && p.isPlaying && p.isPlaying()); }

  function resize() {
    if (!V) return;
    var r = V.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    V.W = Math.max(200, r.width); V.H = Math.max(200, r.height);
    V.canvas.width = Math.round(V.W * dpr); V.canvas.height = Math.round(V.H * dpr);
    V.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    V.keys = keyLayout(V.data.lo, V.data.hi, V.W);
    V.dirty = true;
  }

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function draw() {
    var c = V.ctx, W = V.W, H = V.H, d = V.data, K = V.keys;
    var now = timeNow(), pps = st.ppb * d.bpm0 / 60, nowY = H - KEYH;
    var span = nowY / pps;                       // seconds visible above the keys
    var yOf = function (t) { return nowY - (t - now) * pps; };
    c.clearRect(0, 0, W, H);

    // lanes: faint shading under black keys
    c.fillStyle = "#f6f6f4";
    for (var m = K.lo; m <= K.hi; m++) {
      var p = K.pos[m];
      if (p.black) c.fillRect(p.x, 0, p.w, nowY);
    }
    // C lines so octaves read at a glance
    c.strokeStyle = "#e4e4e0"; c.lineWidth = 1;
    for (m = K.lo; m <= K.hi; m++) if (m % 12 === 0) {
      c.beginPath(); c.moveTo(K.pos[m].x + 0.5, 0); c.lineTo(K.pos[m].x + 0.5, nowY); c.stroke();
    }

    c.font = "11px Georgia, serif"; c.textBaseline = "middle";
    // bar lines + numbers
    d.bars.forEach(function (b) {
      if (b.t < now - 0.5 || b.t > now + span) return;
      var y = Math.round(yOf(b.t)) + 0.5;
      c.strokeStyle = "#d4d4ce"; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();
      c.fillStyle = "#9a9a94"; c.textAlign = "right"; c.fillText(String(b.n), W - 4, y - 7);
    });

    // notes: left hand first, melody on top
    var sounding = {};
    ["lh", "rh"].forEach(function (hand) {
      d.notes.forEach(function (n) {
        if (n.hand !== hand || n.e < now || n.t > now + span) return;
        var p = K.pos[n.midi]; if (!p) return;
        var yb = Math.min(yOf(n.t), nowY), yt = Math.max(yOf(n.e), 0);
        var h = yb - yt - 1.5; if (h < 2) return;
        var col = hand === "lh" ? LH : (st.color === "harmony" && n.tone === false ? TENSION : RH);
        var inset = p.black ? 0.5 : 1.5;
        c.fillStyle = col; rr(c, p.x + inset, yt, p.w - inset * 2, h, 4); c.fill();
        if (hand === "rh") { c.strokeStyle = "rgba(255,255,255,.9)"; c.lineWidth = 1; c.stroke(); }
        if (n.t <= now) sounding[n.midi] = col;
        // label inside the block if there is room
        var lbl = hand === "rh" ? (st.color === "harmony" ? n.ivl : (p.w < 20 ? n.name.replace(/-?\d+$/, "") : n.name)) : null;
        if (lbl && h >= 16 && p.w >= 13) {
          c.save(); c.beginPath(); c.rect(p.x, yt, p.w, h); c.clip();
          c.fillStyle = "#fff"; c.textAlign = "center";
          c.font = (p.w < 18 ? "9px" : "10px") + " Georgia, serif";
          c.fillText(lbl, p.x + p.w / 2, yb - 9);
          c.restore();
        }
      });
    });

    // chord changes: rule + name pill at the left edge
    c.font = "bold 13px Georgia, serif"; c.textBaseline = "middle";
    d.chords.forEach(function (ch, i) {
      if (ch.e < now || ch.t > now + span) return;
      var y = yOf(ch.t);
      if (y <= nowY) {
        c.strokeStyle = "rgba(47,133,90,.55)"; c.setLineDash([5, 4]); c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(W, Math.round(y) + 0.5); c.stroke();
        c.setLineDash([]);
      }
      // pill sticks to the now-line while its chord is sounding
      var py = Math.min(y, nowY) - 12;
      var txt = ch.label + (ch.roman ? "  " + ch.roman : "");
      var tw = c.measureText(txt).width + 14;
      c.fillStyle = "rgba(255,255,255,.92)"; rr(c, 4, py - 11, tw, 22, 11); c.fill();
      c.strokeStyle = LH; c.lineWidth = 1; c.stroke();
      c.fillStyle = "#1c4d33"; c.textAlign = "left"; c.fillText(txt, 11, py);
    });

    // section names
    c.font = "italic 12px Georgia, serif";
    d.secs.forEach(function (s) {
      if (d.secs.length < 2 || s.t < now - 0.5 || s.t > now + span) return;
      c.fillStyle = "#555"; c.textAlign = "right"; c.fillText(s.name, W - 22, yOf(s.t) - 8);
    });

    // keyboard
    c.fillStyle = "#333"; c.fillRect(0, nowY - 2, W, 2);
    for (m = K.lo; m <= K.hi; m++) {
      p = K.pos[m]; if (p.black) continue;
      c.fillStyle = sounding[m] || "#fff";
      c.fillRect(p.x, nowY, p.w, KEYH);
      c.strokeStyle = "#b5b5b5"; c.lineWidth = 1; c.strokeRect(p.x + 0.5, nowY + 0.5, p.w - 1, KEYH - 1);
      if (m % 12 === 0) {
        c.fillStyle = sounding[m] ? "#fff" : "#999"; c.font = "9px Georgia, serif";
        c.textAlign = "center"; c.fillText("C" + (Math.floor(m / 12) - 1), p.x + p.w / 2, nowY + KEYH - 9);
      }
    }
    for (m = K.lo; m <= K.hi; m++) {
      p = K.pos[m]; if (!p.black) continue;
      c.fillStyle = sounding[m] || "#2b2b2b";
      c.fillRect(p.x, nowY, p.w, KEYH * 0.6);
    }
    V.lastT = now; V.dirty = false;
  }

  function loop() {
    if (!V) return;
    if (st.view === "falling" && (V.dirty || playing() || timeNow() !== V.lastT)) draw();
    V.raf = requestAnimationFrame(loop);
  }

  /* ---------- scrubbing: drag up/down on the notes ---------- */
  function wireScrub(cv) {
    var drag = null;
    cv.addEventListener("pointerdown", function (e) {
      drag = { y: e.clientY, t: timeNow() };
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var pps = st.ppb * V.data.bpm0 / 60;
      var t = Math.max(0, Math.min(V.data.dur, drag.t + (e.clientY - drag.y) / pps));
      var p = window.H2P.player;
      if (p && p.seek) p.seek(t); else V.localT = t;
      V.dirty = true;
    });
    var end = function () { drag = null; };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
  }

  /* ---------- toolbar + mounting ---------- */
  function btn(label, on, fn, title) {
    var b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.className = on ? "on" : "";
    if (title) b.title = title;
    b.onclick = fn; return b;
  }

  function buildBar(mountEl) {
    var bar = document.createElement("div");
    bar.className = "h2p-viewbar noprint";
    function refresh() {
      bar.innerHTML = "";
      var seg = document.createElement("span"); seg.className = "h2p-seg";
      seg.appendChild(btn("Sheet", st.view === "sheet", function () { setView("sheet"); }));
      seg.appendChild(btn("Falling", st.view === "falling", function () { setView("falling"); }));
      bar.appendChild(seg);
      if (st.view === "falling") {
        var s2 = document.createElement("span"); s2.className = "h2p-seg";
        s2.appendChild(btn("Hands", st.color === "hands", function () { st.color = "hands"; persist(); refresh(); if (V) V.dirty = true; },
          "Green left hand, blue melody, note names"));
        s2.appendChild(btn("Harmony", st.color === "harmony", function () { st.color = "harmony"; persist(); refresh(); if (V) V.dirty = true; },
          "Melody coloured by chord tone (blue) or tension (orange), with intervals"));
        bar.appendChild(s2);
        var s3 = document.createElement("span"); s3.className = "h2p-seg";
        s3.appendChild(btn("\u2212", false, function () { st.ppb = Math.max(24, st.ppb - 12); persist(); if (V) V.dirty = true; }, "Zoom out"));
        s3.appendChild(btn("+", false, function () { st.ppb = Math.min(160, st.ppb + 12); persist(); if (V) V.dirty = true; }, "Zoom in"));
        bar.appendChild(s3);
      }
    }
    function setView(v) {
      st.view = v; persist(); refresh();
      mountEl.classList.toggle("h2p-mode-falling", v === "falling");
      if (v === "falling") { resize(); V.dirty = true; }
    }
    refresh();
    mountEl.classList.toggle("h2p-mode-falling", st.view === "falling");
    return bar;
  }

  function mount(song, mountEl) {
    if (V) { cancelAnimationFrame(V.raf); if (V.ro) V.ro.disconnect(); }
    var wrap = document.createElement("div");
    wrap.className = "h2p-fall noprint";
    var cv = document.createElement("canvas");
    cv.setAttribute("aria-label", "Falling-notes view: notes fall toward the keyboard; drag to scrub");
    wrap.appendChild(cv);
    var hint = document.createElement("div");
    hint.className = "h2p-fallhint";
    hint.textContent = "Drag the notes up or down to scrub. Blocks land on the key you play.";
    wrap.appendChild(hint);

    mountEl.insertBefore(wrap, mountEl.firstChild);
    mountEl.insertBefore(buildBar(mountEl), mountEl.firstChild);

    V = { wrap: wrap, canvas: cv, ctx: cv.getContext("2d"), data: flatten(song),
          localT: 0, dirty: true, lastT: -1, raf: 0, ro: null };
    wireScrub(cv);
    if (window.ResizeObserver) { V.ro = new ResizeObserver(resize); V.ro.observe(cv); }
    else window.addEventListener("resize", resize);
    resize();
    V.raf = requestAnimationFrame(loop);
  }

  /* ---------- styles (injected once) ---------- */
  var css = [
    ".h2p-viewbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}",
    ".h2p-seg{display:inline-flex;border:1px solid #333;border-radius:8px;overflow:hidden}",
    ".h2p-seg button{font:14px Georgia,serif;padding:7px 12px;border:0;border-radius:0;background:#fff;color:#111;cursor:pointer}",
    ".h2p-seg button+button{border-left:1px solid #333}",
    ".h2p-seg button.on{background:#111;color:#fff}",
    ".h2p-seg button:focus-visible{outline:2px solid #2b6cb0;outline-offset:-3px}",
    ".h2p-fall{display:none}",
    ".h2p-mode-falling .h2p-fall{display:block}",
    ".h2p-mode-falling .section{display:none}",
    ".h2p-mode-falling .h2p-toolbar{display:none}",
    ".h2p-fall canvas{display:block;width:100%;height:62vh;min-height:320px;max-height:720px;touch-action:none;border:1px solid #ddd;border-radius:8px;background:#fff}",
    ".h2p-fallhint{font-size:12px;color:#888;margin:6px 0 0}",
    "@media print{.h2p-mode-falling .section{display:block!important}.h2p-fall,.h2p-viewbar{display:none!important}}"
  ].join("\n");
  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  (document.head || document.documentElement).appendChild(styleEl);

  /* ---------- hook into the existing renderer ---------- */
  var orig = window.H2P.renderSong;
  if (typeof orig !== "function") {
    console.warn("falling.js: load it after render.js");
    return;
  }
  window.H2P.renderSong = function (song, mountEl, opts) {
    orig.call(this, song, mountEl, opts);
    mount(song, mountEl);
  };
  window.H2P.falling = { flatten: flatten, state: st };
})();
