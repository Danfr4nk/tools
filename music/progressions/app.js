// app.js — PROGRESSIONS UI: generate, audition (WebAudio), export MIDI.
import { generateProgression, STYLE_KEYS, STYLE_META } from './progs.js';
import { writeMidi } from './midi.js';

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

let style = 'nimino';
let prog = null;
let playing = false;
let ctx = null, master = null, timer = null;
let nextBar = 0, barIdx = 0;

const $ = id => document.getElementById(id);
const keySel = $('key'), modeSel = $('mode'), tempoSl = $('tempo');

// key selector
ROOTS.forEach((n, i) => {
  const o = document.createElement('option');
  o.value = i; o.textContent = n;
  keySel.appendChild(o);
});
keySel.value = 7; // G — nimino's "Back Of Your Hands" key

document.querySelectorAll('.style').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.style').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    style = b.dataset.style;
    tempoSl.value = STYLE_META[style].tempo;
    $('bpmval').textContent = tempoSl.value;
    generate();
  };
});
tempoSl.oninput = () => {
  $('bpmval').textContent = tempoSl.value;
  if (prog) prog.tempo = +tempoSl.value;
};
$('gen').onclick = generate;
$('play').onclick = togglePlay;
$('midi').onclick = exportMidi;
$('arp').onchange = () => { if (playing) { /* takes effect next loop */ } };
keySel.onchange = generate;
modeSel.onchange = generate;

function generate() {
  stop();
  prog = generateProgression(style, {
    keyPc: +keySel.value,
    mode: modeSel.value,
    tempo: +tempoSl.value,
  });
  const cards = $('cards');
  cards.innerHTML = '';
  prog.chords.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'card'; d.id = 'card' + i;
    d.innerHTML = `<div class="roman">${c.roman}</div>
      <div class="name">${c.name}</div>
      <div class="notes">${c.notes.map(midiName).join(' ')}</div>`;
    cards.appendChild(d);
  });
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = `${prog.style} lane · ${prog.keyName} ${prog.mode === 'min' ? 'minor' : 'major'} · ${prog.tempo} BPM`;
  cards.appendChild(meta);
}

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.8;
  // gentle space
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.32;
  const fb = ctx.createGain(); fb.gain.value = 0.28;
  const wet = ctx.createGain(); wet.gain.value = 0.18;
  delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(master);
  ctx._delay = delay;
  master.connect(ctx.destination);
}

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

function padVoice(notes, t, dur) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.16, t + 0.4);
  g.gain.setValueAtTime(0.16, t + dur - 0.4);
  g.gain.linearRampToValueAtTime(0, t + dur);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1900; lp.Q.value = 0.4;
  g.connect(lp); lp.connect(master); lp.connect(ctx._delay);
  for (const n of notes) {
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = mtof(n); o.detune.value = det;
      o.connect(g); o.start(t); o.stop(t + dur + 0.05);
    }
  }
}

function bassVoice(midi, t, dur) {
  const o = ctx.createOscillator();
  o.type = 'sine'; o.frequency.value = mtof(midi);
  const o2 = ctx.createOscillator();
  o2.type = 'triangle'; o2.frequency.value = mtof(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.5, t + 0.03);
  g.gain.setValueAtTime(0.5, t + Math.max(0.03, dur - 0.15));
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g); o2.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05); o2.start(t); o2.stop(t + dur + 0.05);
}

function pluck(midi, t) {
  const o = ctx.createOscillator();
  o.type = 'triangle'; o.frequency.value = mtof(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.22, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  o.connect(g); g.connect(master); g.connect(ctx._delay);
  o.start(t); o.stop(t + 0.25);
}

function scheduleBar(t, ci) {
  const ch = prog.chords[ci];
  const spb = 60 / prog.tempo;
  const barDur = 4 * spb;
  padVoice(ch.notes, t, barDur);
  for (const bp of prog.bassPattern) {
    bassVoice(ch.bass + bp.oct * 12, t + bp.t * spb, bp.d * spb);
  }
  if ($('arp').checked) {
    const tones = [];
    for (let o = 0; o < 2; o++) for (const n of ch.notes) tones.push(n + o * 12);
    const step = spb / 4;
    for (let s = 0; s < 16; s++) {
      let st = t + s * step;
      if (prog.swing) st += (s % 2 === 1 ? prog.swing * step : 0);
      pluck(tones[s % tones.length], st);
    }
  }
  document.querySelectorAll('.card').forEach((el, i) => {
    el.classList.toggle('playing', i === ci);
  });
}

function tick() {
  const spb = 60 / prog.tempo;
  const barDur = 4 * spb;
  while (nextBar < ctx.currentTime + 0.25) {
    scheduleBar(nextBar, barIdx % 4);
    nextBar += barDur;
    barIdx++;
  }
}

function togglePlay() {
  if (!prog) generate();
  ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
  playing ? stop() : start();
}

function start() {
  playing = true;
  $('play').textContent = '■ stop';
  nextBar = ctx.currentTime + 0.08;
  barIdx = 0;
  timer = setInterval(tick, 40);
}

function stop() {
  playing = false;
  $('play').textContent = '▶ play';
  if (timer) clearInterval(timer);
  timer = null;
  document.querySelectorAll('.card').forEach(el => el.classList.remove('playing'));
}

function exportMidi() {
  if (!prog) generate();
  const bytes = writeMidi({
    tempo: prog.tempo, chords: prog.chords,
    bassPattern: prog.bassPattern, arp: $('arp').checked,
  });
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `progression-${prog.styleKey}-${prog.keyName}${prog.mode === 'min' ? 'm' : ''}-${prog.tempo}bpm.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

generate();
