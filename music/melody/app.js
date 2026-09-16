// app.js — glue: file decode -> extractMelody -> piano roll -> play/export.
import { extractMelody } from './melody.js';
import { createRoll, midiName } from './roll.js';
import { notesToMidi } from './midi.js';

const $ = id => document.getElementById(id);
const drop = $('drop'), fileInput = $('file'), prog = $('prog'), progFill = $('progfill'),
      status = $('status'), results = $('results'), errBox = $('err');

let actx = null, audioBuf = null, mono = null, sr = 44100;
let notes = [], duration = 0, startAt = 0;
let roll = null, playing = false, playNodes = [], rafId = 0, playT0 = 0;

roll = createRoll($('roll'), {
  onAudition: n => audition(n),
  onSeek: t => { startAt = t; if (playing) { stop(); play(); } else roll.setPlayhead(t); },
});

function setStatus(t) { status.textContent = t; }
function showErr(t) { errBox.textContent = t; errBox.hidden = false; }
function clearErr() { errBox.hidden = true; errBox.textContent = ''; }

// the file input covers the whole drop zone, so taps/clicks land on it natively
['dragover', 'dragenter'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => {
  if (e.target === fileInput) return; // the input's own change event handles this
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
  sr = audioBuf.sampleRate;
  mono = new Float32Array(audioBuf.length);
  for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
    const d = audioBuf.getChannelData(ch);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / audioBuf.numberOfChannels;
  }
  setStatus('finding the melody …');
  try {
    const res = await extractMelody(mono, sr, p => { progFill.style.width = (4 + p * 96).toFixed(1) + '%'; });
    notes = res.notes;
  } catch (e) {
    showErr('Analysis failed: ' + (e.message || e)); prog.hidden = true; return;
  }
  prog.hidden = true;
  if (!notes.length) { showErr('No melody found — is there a clear lead line in this file?'); return; }
  startAt = 0;
  roll.setData(notes, duration);
  roll.setPlayhead(0);
  const ms = notes.map(n => n.midi);
  const lo = Math.min(...ms), hi = Math.max(...ms);
  const cover = notes.reduce((a, n) => a + n.dur, 0) / duration * 100;
  $('stats').textContent =
    `${notes.length} notes · ${midiName(lo)}–${midiName(hi)} · ${duration.toFixed(1)}s · melody present ${cover.toFixed(0)}% of the time`;
  $('fname').textContent = f.name;
  results.hidden = false;
  setStatus('done — tap a note to hear it, or press play.');
}

// ---- transport ----
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

function envGain(t, peak, dur) {
  const g = actx.createGain();
  const a = Math.min(0.015, dur * 0.2), r = Math.min(0.08, dur * 0.35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + Math.max(a, dur - r));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  return g;
}

function scheduleNote(n, when, peak = 0.22) {
  const o = actx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = midiHz(n.midi);
  const g = envGain(when, peak, Math.max(0.05, n.dur));
  o.connect(g).connect(actx.destination);
  o.start(when); o.stop(when + Math.max(0.06, n.dur) + 0.1);
  playNodes.push(o, g);
}

function audition(n) {
  actx = actx || new (window.AudioContext || window.webkitAudioContext)();
  actx.resume();
  scheduleNote(n, actx.currentTime + 0.01, 0.25);
  setTimeout(() => { playNodes.forEach(x => { try { x.disconnect(); } catch (e) {} }); playNodes = []; }, (n.dur + 0.3) * 1000);
}

function play() {
  if (!notes.length) return;
  actx.resume();
  stop(true);
  playing = true;
  $('playbtn').textContent = '⏸ pause';
  const t0 = actx.currentTime + 0.08;
  playT0 = t0;
  for (const n of notes) {
    const end = n.start + n.dur;
    if (end <= startAt) continue;
    const skip = Math.max(0, startAt - n.start);
    scheduleNote({ ...n, dur: n.dur - skip }, t0 + Math.max(0, n.start - startAt));
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
    if (t >= duration || !playing) { stop(); roll.setPlayhead(null); return; }
    roll.setPlayhead(t); roll.follow(t);
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
  if (!silent) { $('playbtn').textContent = '▶ play melody'; }
}

$('playbtn').addEventListener('click', () => {
  if (playing) { startAt = Math.min(duration, startAt + (actx.currentTime - playT0)); stop(); roll.setPlayhead(startAt); }
  else play();
});
$('stopbtn').addEventListener('click', () => { startAt = 0; stop(); roll.setPlayhead(0); });
$('zin').addEventListener('click', () => roll.zoomBy(1.4));
$('zout').addEventListener('click', () => roll.zoomBy(1 / 1.4));
$('zfit').addEventListener('click', () => roll.zoomFit());

// ---- export ----
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
$('midibtn').addEventListener('click', () => {
  const data = notesToMidi(notes);
  download(new Blob([data], { type: 'audio/midi' }), 'melody.mid');
  setStatus('melody.mid downloaded — drop it in your DAW.');
});
$('jsonbtn').addEventListener('click', () => {
  download(new Blob([JSON.stringify({ notes, duration }, null, 2)], { type: 'application/json' }), 'melody-notes.json');
});
