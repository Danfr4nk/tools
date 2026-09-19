// app.js — glue: file decode -> extractChords -> timeline -> audition/export.
import { extractChords } from './chords.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), prog = $('prog'), progFill = $('progfill'),
      status = $('status'), results = $('results'), errBox = $('err'),
      canvas = $('tl'), ctx = canvas.getContext('2d');

let actx = null, audioBuf = null;
let chords = [], beats = [], tempo = 0, duration = 0, startAt = 0;
let playing = false, playNodes = [], rafId = 0, playT0 = 0;
let viewStart = 0, viewDur = 0; // seconds visible; 0 = fit

function setStatus(t) { status.textContent = t; }
function showErr(t) { errBox.textContent = t; errBox.hidden = false; }
function clearErr() { errBox.hidden = true; errBox.textContent = ''; }

['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  if (e.target === fileInput) return;
  const f = e.dataTransfer.files[0]; if (f) loadFile(f);
});
fileInput.addEventListener('change', () => { const f = fileInput.files[0]; if (f) { loadFile(f); fileInput.value = ''; } });

async function loadFile(f) {
  clearErr(); results.hidden = true; stop();
  if (!/^audio\//.test(f.type) && !/\.(mp3|wav|m4a|aac|ogg|flac|aiff?)$/i.test(f.name)) {
    showErr('That doesn\'t look like an audio file.'); return;
  }
  setStatus('decoding ' + f.name + ' …');
  prog.hidden = false; progFill.style.width = '4%';
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const ab = await f.arrayBuffer();
    audioBuf = await actx.decodeAudioData(ab);
  } catch (e) {
    showErr('Couldn\'t decode that file: ' + (e.message || e)); prog.hidden = true; return;
  }
  duration = audioBuf.duration;
  if (duration > 720) { showErr('12-minute max for now — trim it and retry.'); prog.hidden = true; return; }
  const mono = new Float32Array(audioBuf.length);
  for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
    const d = audioBuf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / audioBuf.numberOfChannels;
  }
  setStatus('finding the chords …');
  try {
    const res = await extractChords(mono, audioBuf.sampleRate, p => { progFill.style.width = (4 + p * 96).toFixed(1) + '%'; });
    chords = res.chords; beats = res.beats; tempo = res.tempo;
  } catch (e) {
    showErr('Analysis failed: ' + (e.message || e)); prog.hidden = true; return;
  }
  prog.hidden = true;
  if (!chords.length) { showErr('No chords found — is there harmony in this file?'); return; }
  startAt = 0; viewStart = 0; viewDur = 0;
  draw();
  const voiced = chords.filter(c => c.name !== 'N');
  $('stats').textContent =
    `${tempo} BPM · ${chords.length} segments · ${duration.toFixed(1)}s · harmony present ${(voiced.reduce((a, c) => a + c.dur, 0) / duration * 100).toFixed(0)}% of the time`;
  $('fname').textContent = f.name;
  $('chart').innerHTML = chords.map(c =>
    `<span class="chip${c.name === 'N' ? ' n' : ''}"><b>${c.name}</b> ${fmtT(c.start)}</span>`).join('');
  results.hidden = false;
  setStatus('done — tap a block to hear the chord, or press play.');
}

const fmtT = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(0).padStart(2, '0')}`;

// ---- timeline drawing ----
function colorFor(name) {
  if (name === 'N') return '#1e2129';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 45%, 58%)`;
}

function view() {
  const vd = viewDur || duration;
  return [viewStart, Math.min(duration, viewStart + vd)];
}

function draw(playheadT) {
  const r = canvas.getBoundingClientRect();
  const W = canvas.width = r.width * devicePixelRatio, H = canvas.height = r.height * devicePixelRatio;
  ctx.clearRect(0, 0, W, H);
  const [vs, ve] = view();
  const X = t => ((t - vs) / (ve - vs)) * W;
  const top = H * 0.12, bh = H * 0.6;
  // beat ticks
  ctx.fillStyle = '#3a3e4a';
  for (const b of beats) {
    if (b < vs || b > ve) continue;
    ctx.fillRect(X(b), top + bh, 1.5 * devicePixelRatio, 8 * devicePixelRatio);
  }
  // chord blocks
  ctx.textBaseline = 'middle';
  for (const c of chords) {
    const x0 = X(c.start), x1 = X(c.start + c.dur);
    if (x1 < 0 || x0 > W) continue;
    ctx.fillStyle = colorFor(c.name);
    ctx.fillRect(x0, top, x1 - x0 - 1.5 * devicePixelRatio, bh);
    if (x1 - x0 > 30 * devicePixelRatio && c.name !== 'N') {
      ctx.fillStyle = '#0b0d10';
      ctx.font = `${600} ${13 * devicePixelRatio}px -apple-system, sans-serif`;
      ctx.fillText(c.name, x0 + 6 * devicePixelRatio, top + bh / 2);
    }
  }
  // time labels
  ctx.fillStyle = '#9aa0ad';
  ctx.font = `${11 * devicePixelRatio}px -apple-system, sans-serif`;
  const step = niceStep((ve - vs) / 8);
  for (let t = Math.ceil(vs / step) * step; t <= ve; t += step) {
    ctx.fillText(fmtT(t), X(t) - 10 * devicePixelRatio, top + bh + 22 * devicePixelRatio);
  }
  // playhead
  if (playheadT != null && playheadT >= vs && playheadT <= ve) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(X(playheadT), 0, 2 * devicePixelRatio, H);
  }
}

function niceStep(raw) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const s of steps) if (s >= raw) return s;
  return 600;
}

// tap to audition, drag to scroll
let dragX = null, dragV = null, moved = false;
canvas.addEventListener('pointerdown', e => { dragX = e.clientX; dragV = viewStart; moved = false; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => {
  if (dragX == null) return;
  const [vs, ve] = view();
  const dx = (e.clientX - dragX) / canvas.getBoundingClientRect().width * (ve - vs);
  if (Math.abs(e.clientX - dragX) > 6) moved = true;
  if (viewDur) { viewStart = Math.max(0, Math.min(duration - viewDur, dragV - dx)); draw(playing ? startAt + (actx.currentTime - playT0) : null); }
});
canvas.addEventListener('pointerup', e => {
  if (!moved) {
    const r = canvas.getBoundingClientRect();
    const [vs, ve] = view();
    const t = vs + (e.clientX - r.left) / r.width * (ve - vs);
    const c = chords.find(c => t >= c.start && t < c.start + c.dur);
    if (c && c.name !== 'N') audition(c);
  }
  dragX = null;
});
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const vd = viewDur || duration;
  const f = e.deltaY > 0 ? 1.25 : 0.8;
  const nvd = Math.max(4, Math.min(duration, vd * f));
  if (nvd >= duration) { viewDur = 0; viewStart = 0; }
  else {
    const r = canvas.getBoundingClientRect();
    const [vs, ve] = view();
    const tc = vs + (e.clientX - r.left) / r.width * (ve - vs);
    const ratio = (tc - vs) / (ve - vs);
    viewDur = nvd; viewStart = Math.max(0, Math.min(duration - nvd, tc - ratio * nvd));
  }
  draw();
}, { passive: false });

// ---- audio: audition + transport ----
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
const PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

function chordTones(c) {
  const m = /^(A#|C#|D#|F#|G#|[A-G])/.exec(c.name);
  if (!m) return [];
  const root = 48 + PC[m[1]];
  const iv = c.quality === 'min' ? [0, 3, 7] : [0, 4, 7];
  return iv.map(i => root + i);
}

function scheduleChord(c, when, peak = 0.16) {
  const tones = chordTones(c);
  if (!tones.length) return;
  const dur = Math.max(0.25, Math.min(2.5, c.dur * 0.9));
  for (const m of tones) {
    const o = actx.createOscillator();
    o.type = 'triangle'; o.frequency.value = midiHz(m);
    const g = actx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.02);
    g.gain.setValueAtTime(peak, when + Math.max(0.02, dur - 0.12));
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(actx.destination);
    o.start(when); o.stop(when + dur + 0.05);
    playNodes.push(o, g);
  }
}

function audition(c) {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();
  stop(true);
  scheduleChord(c, actx.currentTime + 0.01, 0.22);
  setStatus(c.name + ' — ' + c.quality + (c.root >= 0 ? ' · root ' + ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][c.root] : ''));
  setTimeout(() => stop(true), 1200);
}

function play() {
  if (!chords.length) return;
  actx.resume();
  stop(true);
  playing = true;
  $('playbtn').textContent = '⏸ pause';
  const t0 = actx.currentTime + 0.08;
  playT0 = t0;
  for (const c of chords) {
    const end = c.start + c.dur;
    if (end <= startAt || c.name === 'N') continue;
    const skip = Math.max(0, startAt - c.start);
    scheduleChord({ ...c, dur: c.dur - skip }, t0 + Math.max(0, c.start - startAt));
  }
  if ($('origtoggle').checked && audioBuf) {
    const src = actx.createBufferSource();
    src.buffer = audioBuf;
    const g = actx.createGain(); g.gain.value = 0.8;
    src.connect(g).connect(actx.destination);
    try { src.start(t0, startAt % audioBuf.duration); } catch (e) { src.start(t0); }
    playNodes.push(src, g);
  }
  const tick = () => {
    const t = startAt + (actx.currentTime - playT0);
    if (t >= duration || !playing) { stop(); return; }
    draw(t);
    $('time').textContent = t.toFixed(1) + 's / ' + duration.toFixed(1) + 's';
    rafId = requestAnimationFrame(tick);
  };
  tick();
}

function stop(silent) {
  playing = false;
  cancelAnimationFrame(rafId);
  const t = actx ? actx.currentTime : 0;
  playNodes.forEach(x => { try { x.stop ? x.stop(t) : x.disconnect(); } catch (e) {} });
  playNodes = [];
  if (!silent) { $('playbtn').textContent = '▶ play chords'; draw(); }
}

$('playbtn').addEventListener('click', () => {
  if (playing) { startAt = Math.min(duration, startAt + (actx.currentTime - playT0)); stop(); }
  else play();
});
$('stopbtn').addEventListener('click', () => { startAt = 0; stop(); });

// ---- export ----
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
$('jsonbtn').addEventListener('click', () => {
  download(new Blob([JSON.stringify({ tempo, beats, chords, duration }, null, 2)], { type: 'application/json' }), 'chords.json');
  setStatus('chords.json downloaded.');
});

window.addEventListener('resize', () => draw());
