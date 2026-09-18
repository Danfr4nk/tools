"use strict";
/* hook2piano player — zero-dependency Web Audio playback of the rendered SONG.
 * Least-taxing approach: plain oscillators (triangle melody, sine chords)
 * scheduled with a lookahead timer. No samples, no soundfonts, no libraries.
 * Reads window.H2P.lastSong (stashed by renderSong) and drives the red
 * playhead lines tagged onto each roll SVG (data-t0 / data-t1 / data-bpm).
 */
window.H2P = window.H2P || {};

(function () {
  var PPB = 64, KB = 64; // set from render.js constants below (must match)
  if (window.H2P.PPB) PPB = window.H2P.PPB;
  if (window.H2P.KB) KB = window.H2P.KB;

  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // Flatten a SONG into sorted note events: {t, d, midi, hand}
  function flattenSong(song) {
    var evs = [], t = 0;
    (song.sections || []).forEach(function (sec) {
      var spb = 60 / sec.bpm, bmult = sec.beatsPerMeasure;
      sec.measures.forEach(function (m, mi) {
        var base = t + mi * bmult * spb;
        (m.notes || []).forEach(function (n) {
          if (n.midi == null) return;
          evs.push({ t: base + n.beat * spb, d: Math.max(0.05, n.dur * spb), midi: n.midi, hand: "mel" });
        });
        (m.chords || []).forEach(function (c) {
          (c.midis || []).forEach(function (tm) {
            evs.push({ t: base + c.beat * spb, d: Math.max(0.05, c.dur * spb), midi: tm, hand: "chd" });
          });
        });
      });
      t += sec.measures.length * bmult * spb;
    });
    evs.sort(function (a, b) { return a.t - b.t; });
    return { events: evs, dur: t };
  }

  var S = {
    ctx: null, master: null,
    playing: false, song: null, evs: [], dur: 0,
    startAt: 0, offset: 0, idx: 0,
    timer: null, raf: 0, gen: 0, live: []
  };

  function ensureCtx() {
    if (!S.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      S.ctx = new AC();
      S.master = S.ctx.createGain();
      S.master.gain.value = 0.9;
      var comp = S.ctx.createDynamicsCompressor();
      S.master.connect(comp);
      comp.connect(S.ctx.destination);
    }
    if (S.ctx.state === "suspended") S.ctx.resume();
    return true;
  }

  function voice(midi, when, dur, hand) {
    var ctx = S.ctx;
    var o = ctx.createOscillator();
    o.type = hand === "mel" ? "triangle" : "sine";
    o.frequency.value = midiHz(midi);
    var g = ctx.createGain();
    var peak = hand === "mel" ? 0.20 : 0.10;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.15);
    o.connect(g); g.connect(S.master);
    o.start(when);
    o.stop(when + dur + 0.25);
    S.live.push(o);
    return o;
  }

  function silence() {
    S.live.forEach(function (o) { try { o.stop(); } catch (e) {} });
    S.live = [];
  }

  function schedule(g) {
    if (g !== S.gen || !S.playing) return;
    var ahead = S.ctx.currentTime + 0.15;
    while (S.idx < S.evs.length) {
      var e = S.evs[S.idx];
      var when = S.startAt + (e.t - S.offset);
      if (when > ahead) break;
      if (when >= S.ctx.currentTime - 0.05) voice(e.midi, when, e.d, e.hand);
      S.idx++;
    }
    if (S.idx >= S.evs.length) {
      var endAt = S.startAt + (S.dur - S.offset);
      var ms = Math.max(0, (endAt - S.ctx.currentTime) * 1000);
      setTimeout(function () { if (g === S.gen) api.stop(true); }, ms + 400);
    }
  }

  function songTime() {
    if (!S.playing || !S.ctx) return S.offset;
    return S.offset + (S.ctx.currentTime - S.startAt);
  }

  /* ----- playhead + transport ----- */

  var lastPh = null;

  function hidePlayheads() {
    if (lastPh) { lastPh.style.display = "none"; lastPh = null; }
  }

  function drawPlayhead(t) {
    var rolls = document.querySelectorAll("svg.h2p-roll");
    var hit = null;
    for (var i = 0; i < rolls.length; i++) {
      var t0 = parseFloat(rolls[i].getAttribute("data-t0"));
      var t1 = parseFloat(rolls[i].getAttribute("data-t1"));
      if (t >= t0 && t < t1) { hit = rolls[i]; break; }
    }
    if (lastPh && lastPh.parentNode !== (hit || null)) {
      lastPh.style.display = "none"; lastPh = null;
    }
    if (hit) {
      var t0 = parseFloat(hit.getAttribute("data-t0"));
      var bpm = parseFloat(hit.getAttribute("data-bpm"));
      var x = KB + ((t - t0) * bpm / 60) * PPB;
      var ph = hit.querySelector(".h2p-ph");
      if (ph) {
        ph.setAttribute("x1", x.toFixed(1));
        ph.setAttribute("x2", x.toFixed(1));
        ph.style.display = "";
        lastPh = ph;
      }
    }
  }

  function fmt(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  function updateTransport() {
    var bp = document.getElementById("tplay");
    if (bp) bp.innerHTML = S.playing ? "&#10074;&#10074; Pause" : "&#9654; Play";
  }

  function rafLoop(g) {
    if (g !== S.gen) return;
    var t = songTime();
    drawPlayhead(t);
    var bar = document.getElementById("tbar");
    if (bar && S.dur > 0) bar.style.width = Math.min(100, (t / S.dur) * 100) + "%";
    var tt = document.getElementById("ttime");
    if (tt) tt.textContent = fmt(t) + " / " + fmt(S.dur);
    if (t >= S.dur) { api.stop(true); return; }
    S.raf = requestAnimationFrame(function () { rafLoop(g); });
  }

  /* ----- public API ----- */

  var api = {
    flattenSong: flattenSong, // exposed for tests

    play: function () {
      var song = window.H2P.lastSong;
      if (!song || !ensureCtx()) return;
      if (song !== S.song) {
        var f = flattenSong(song);
        S.song = song; S.evs = f.events; S.dur = f.dur; S.offset = 0;
      }
      if (!S.evs.length) return;
      var g = ++S.gen;
      S.playing = true;
      S.startAt = S.ctx.currentTime + 0.06;
      S.idx = 0;
      while (S.idx < S.evs.length && S.evs[S.idx].t < S.offset - 0.001) S.idx++;
      clearInterval(S.timer);
      S.timer = setInterval(function () { schedule(g); }, 25);
      schedule(g);
      cancelAnimationFrame(S.raf);
      S.raf = requestAnimationFrame(function () { rafLoop(g); });
      updateTransport();
    },

    pause: function () {
      if (!S.playing) return;
      S.gen++;
      S.playing = false;
      S.offset = Math.min(songTime(), S.dur);
      clearInterval(S.timer);
      cancelAnimationFrame(S.raf);
      silence();
      updateTransport();
    },

    stop: function (ended) {
      var was = S.playing;
      S.gen++;
      S.playing = false;
      S.offset = 0;
      clearInterval(S.timer);
      cancelAnimationFrame(S.raf);
      silence();
      hidePlayheads();
      var bar = document.getElementById("tbar");
      if (bar) bar.style.width = "0%";
      var tt = document.getElementById("ttime");
      if (tt && S.dur) tt.textContent = "0:00 / " + fmt(S.dur);
      updateTransport();
      return was;
    },

    toggle: function () {
      if (S.playing) api.pause();
      else api.play();
    },

    reset: function () { // new song rendered
      api.stop();
      S.song = null; S.evs = []; S.dur = 0; S.offset = 0;
      var tt = document.getElementById("ttime");
      if (tt) tt.textContent = "";
    },

    isPlaying: function () { return S.playing; },

    /* added for falling.js: current song time + scrubbing */
    time: function () { return songTime(); },
    duration: function () { return S.dur; },
    seek: function (t) {
      var song = window.H2P.lastSong;
      if (!song) return;
      if (song !== S.song) {
        var f = flattenSong(song);
        S.song = song; S.evs = f.events; S.dur = f.dur;
      }
      var was = S.playing;
      if (was) api.pause();
      S.offset = Math.max(0, Math.min(t, S.dur));
      if (was) { api.play(); return; }
      drawPlayhead(S.offset);
      var bar = document.getElementById("tbar");
      if (bar && S.dur > 0) bar.style.width = Math.min(100, (S.offset / S.dur) * 100) + "%";
      var tt = document.getElementById("ttime");
      if (tt) tt.textContent = fmt(S.offset) + " / " + fmt(S.dur);
    }
  };

  window.H2P.player = api;
})();
