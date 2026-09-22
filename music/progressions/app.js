// app.js — PROGRESSIONS UI: generate, audition (WebAudio), export MIDI.
// v2: stereo mix + compressor, humanized timing, 808 glide on the LYNY sub,
// chord locks, 4/8 bar toggle with turnaround.
import { generateProgression, generateClassic, CLASSICS, CLASSIC_FAMS, STYLE_KEYS, STYLE_META } from './progs.js';
import { writeMidi } from './midi.js';

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

let style = 'nimino';
let classicId = 'levels';
let classicStyle = null; // null = the classic's own default flavor
let bars = 4;
let locks = []; // locked chord objects per position, or null
let prog = null;
let playing = false;
let ctx = null, master = null, comp = null, timer = null;
let nextBar = 0, barIdx = 0;

const $ = id => document.getElementById(id);
const keySel = $('key'), modeSel = $('mode'), tempoSl = $('tempo');

ROOTS.forEach((n, i) => {
  const o = document.createElement('option');
  o.value = i; o.textContent = n;
  keySel.appendChild(o);
});
keySel.value = 7;

document.querySelectorAll('.style').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.style').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    style = b.dataset.style;
    const isClassics = style === 'classics';
    $('classicpick').style.display = isClassics ? '' : 'none';
    $('classicstyles').style.display = isClassics ? '' : 'none';
    if (!isClassics) {
      tempoSl.value = STYLE_META[style].tempo;
    } else {
      const c = CLASSICS.find(e => e.id === classicId);
      tempoSl.value = c.bpm;
      modeSel.value = c.mode;
    }
    $('bpmval').textContent = tempoSl.value;
    locks = [];
    generate();
  };
});

// classics picker, grouped by family
{
  const sel = $('classicpick');
  for (const fam of CLASSIC_FAMS) {
    const og = document.createElement('optgroup');
    og.label = fam;
    for (const c of CLASSICS.filter(e => e.fam === fam)) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name} (${c.deg.join('-')})`;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  sel.value = classicId;
  sel.onchange = () => {
    classicId = sel.value;
    classicStyle = null; // back to the classic's own default flavor
    const c = CLASSICS.find(e => e.id === classicId);
    tempoSl.value = c.bpm;
    $('bpmval').textContent = c.bpm;
    modeSel.value = c.mode;
    locks = [];
    generate();
  };
}

// "play it as" — switch which lane's voicing/bass/swing plays the classic
function syncCstyleButtons() {
  document.querySelectorAll('.cstyle').forEach(x => {
    x.classList.toggle('on', !!prog && prog.styleKey === 'classics' && x.dataset.cstyle === prog.voicingStyle);
  });
}
document.querySelectorAll('.cstyle').forEach(b => {
  b.onclick = () => {
    classicStyle = b.dataset.cstyle;
    locks = [];
    generate();
  };
});
document.querySelectorAll('.bars').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.bars').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    bars = +b.dataset.bars;
    locks = [];
    generate();
  };
});
tempoSl.oninput = () => {
  $('bpmval').textContent = tempoSl.value;
  if (prog) {
    prog.tempo = +tempoSl.value;
    syncDrumsRate();
  }
};
$('gen').onclick = () => { locks = locks.map(() => null); generate(); };
$('play').onclick = togglePlay;
$('midi').onclick = exportMidi;
keySel.onchange = () => { locks = []; generate(); };
modeSel.onchange = () => { locks = []; generate(); };

function generate() {
  stop();
  const locked = [];
  for (let i = 0; i < bars; i++) locked[i] = locks[i] || null;
  if (style === 'classics') {
    const c = CLASSICS.find(e => e.id === classicId);
    modeSel.value = c.mode;
    prog = generateClassic(classicId, {
      keyPc: +keySel.value, tempo: +tempoSl.value, bars, locked,
      styleKey: classicStyle || undefined,
    });
  } else {
    prog = generateProgression(style, {
      keyPc: +keySel.value, mode: modeSel.value,
      tempo: +tempoSl.value, bars, locked,
    });
  }
  locks = prog.chords.map((c, i) => (locks[i] ? c : null));
  syncCstyleButtons();
  renderCards();
}

function renderCards() {
  const wrap = $('cards');
  wrap.innerHTML = '';
  wrap.classList.toggle('eight', prog.bars === 8);
  prog.chords.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'card' + (locks[i] ? ' locked' : '');
    d.id = 'card' + i;
    d.innerHTML = `<button class="lock" data-i="${i}" title="lock this chord">${locks[i] ? '🔒' : '🔓'}</button>
      <div class="roman">${c.roman}</div>
      <div class="name">${c.name}</div>
      <div class="notes">${c.notes.map(midiName).join(' ')}</div>`;
    wrap.appendChild(d);
  });
  wrap.querySelectorAll('.lock').forEach(b => {
    b.onclick = (e) => {
      e.stopPropagation();
      const i = +b.dataset.i;
      locks[i] = locks[i] ? null : prog.chords[i];
      renderCards();
    };
  });
  const meta = document.createElement('p');
  meta.className = 'meta';
  const laneName = prog.styleKey === 'classics'
    ? `CLASSICS · ${prog.classicFam} · as ${prog.voicingLabel}`
    : `${prog.style} lane`;
  meta.textContent = `${laneName} · ${prog.keyName} ${prog.mode === 'min' ? 'minor' : 'major'} · ${prog.tempo} BPM · ${prog.bars} bars`;
  wrap.appendChild(meta);
}

function ensureCtx() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0.85;
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16; comp.ratio.value = 4;
  comp.attack.value = 0.004; comp.release.value = 0.18;
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.32;
  const fb = ctx.createGain(); fb.gain.value = 0.28;
  const wet = ctx.createGain(); wet.gain.value = 0.16;
  delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(comp);
  master.connect(comp); comp.connect(ctx.destination);
  ctx._delay = delay;
}

const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const jitter = ms => (Math.random() * 2 - 1) * ms / 1000;

function padVoice(notes, t, dur) {
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 0.5;
  lp.frequency.setValueAtTime(2400, t);
  lp.frequency.exponentialRampToValueAtTime(1500, t + dur);
  lp.connect(master); lp.connect(ctx._delay);
  // stereo pair: left and right detuned stacks, panned apart
  for (const pan of [-0.55, 0.55]) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.45);
    g.gain.setValueAtTime(0.11, t + Math.max(0.45, dur - 0.5));
    g.gain.linearRampToValueAtTime(0, t + dur);
    g.connect(p); p.connect(lp);
    for (const n of notes) {
      for (const det of [-7, 5]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth'; o.frequency.value = mtof(n);
        o.detune.value = det + (Math.random() * 4 - 2);
        o.connect(g); o.start(t); o.stop(t + dur + 0.05);
      }
    }
  }
}

function bassVoice(midi, t, dur, glide) {
  const o = ctx.createOscillator();
  o.type = 'sine';
  const f = mtof(midi);
  if (glide) { // 808-style: slide up from a fifth below into the note
    o.frequency.setValueAtTime(f * Math.pow(2, -7 / 12), t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.09);
  } else {
    o.frequency.value = f;
  }
  const o2 = ctx.createOscillator();
  o2.type = 'triangle'; o2.frequency.value = f;
  const g2 = ctx.createGain(); g2.gain.value = 0.25;
  const g = ctx.createGain();
  const v = 0.5 * (0.92 + Math.random() * 0.16);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v, t + 0.03);
  g.gain.setValueAtTime(v, t + Math.max(0.03, dur - 0.15));
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g); o2.connect(g2); g2.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur + 0.05);
  o2.start(t); o2.stop(t + dur + 0.05);
}

function pluck(midi, t, accent) {
  const o = ctx.createOscillator();
  o.type = 'triangle'; o.frequency.value = mtof(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(accent ? 0.2 : 0.13, t);
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
    const bt = t + bp.t * spb + jitter(8);
    const n = ch.bass + bp.oct * 12 + (bp.semi || 0);
    bassVoice(n, bt, bp.d * spb, bp.glide && ci % 2 === 0);
  }
  if ($('arp').checked) {
    const tones = [];
    for (let o = 0; o < 2; o++) for (const n of ch.notes) tones.push(n + o * 12);
    const step = spb / 4;
    for (let s = 0; s < 16; s++) {
      let st = t + s * step + jitter(6);
      if (prog.swing) st += (s % 2 === 1 ? prog.swing * step : 0);
      pluck(tones[s % tones.length], st, s % 4 === 0);
    }
  }
  document.querySelectorAll('.card').forEach((el, i) => {
    el.classList.toggle('playing', i === ci);
  });
}

function tick() {
  const spb = 60 / prog.tempo;
  const barDur = 4 * spb;
  syncDrumsRate(); // back-track loop re-locks to the slider every tick
  while (nextBar < ctx.currentTime + 0.25) {
    scheduleBar(nextBar, barIdx % prog.bars);
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

// --- back track: "Sun Goes Down" drums stem.
// Measured 2026-09-22: exactly 128.00 BPM. The stem is a 5-minute arrangement,
// so instead of looping the whole file we loop one measured 4-bar pocket
// (270.05s-277.55s, 0.98 self-similarity, starts on a beat) via loopStart /
// loopEnd. The tight loop re-anchors every 4 bars, so tempo changes can't
// accumulate drift — playbackRate re-locks to the slider every scheduler tick.
const DRUMS_URL = 'assets/sun-goes-down-drums.mp3';
const DRUMS_BPM = 128.0;
const DRUMS_LOOP_START = 270.05;
const DRUMS_LOOP_END = 277.55;
let drumsOn = false, drumsBuf = null, drumsSrc = null, drumsLoading = false;

function syncDrumsRate() {
  if (drumsSrc && prog) drumsSrc.playbackRate.value = prog.tempo / DRUMS_BPM;
}

async function loadDrums() {
  if (drumsBuf || drumsLoading) return;
  drumsLoading = true;
  $('drums').textContent = '🥁 …';
  ensureCtx();
  try {
    const r = await fetch(DRUMS_URL);
    drumsBuf = await ctx.decodeAudioData(await r.arrayBuffer());
  } finally {
    drumsLoading = false;
    $('drums').textContent = '🥁 drums';
  }
  if (drumsOn && playing) startDrums(ctx.currentTime + 0.05);
}

function startDrums(when) {
  if (!drumsBuf) return;
  stopDrums();
  drumsSrc = ctx.createBufferSource();
  drumsSrc.buffer = drumsBuf;
  drumsSrc.loop = true;
  drumsSrc.loopStart = DRUMS_LOOP_START;
  drumsSrc.loopEnd = DRUMS_LOOP_END;
  syncDrumsRate();
  const g = ctx.createGain();
  g.gain.value = 0.55;
  drumsSrc.connect(g); g.connect(master);
  drumsSrc.start(when, DRUMS_LOOP_START);
}

function stopDrums() {
  if (drumsSrc) { try { drumsSrc.stop(); } catch (e) { /* already stopped */ } drumsSrc = null; }
}

$('drums').onclick = async () => {
  drumsOn = !drumsOn;
  $('drums').classList.toggle('on', drumsOn);
  if (drumsOn) {
    // snap the audition to the stem's native tempo so it locks
    tempoSl.value = Math.round(DRUMS_BPM);
    $('bpmval').textContent = tempoSl.value;
    if (prog) prog.tempo = +tempoSl.value;
    await loadDrums();
    if (playing && drumsBuf) startDrums(ctx.currentTime + 0.05);
  } else {
    stopDrums();
  }
};

function start() {
  playing = true;
  $('play').textContent = '■ stop';
  nextBar = ctx.currentTime + 0.08;
  barIdx = 0;
  timer = setInterval(tick, 40);
  if (drumsOn) startDrums(nextBar);
}

function stop() {
  playing = false;
  $('play').textContent = '▶ play';
  if (timer) clearInterval(timer);
  timer = null;
  stopDrums();
  document.querySelectorAll('.card').forEach(el => el.classList.remove('playing'));
}

function exportMidi() {
  if (!prog) generate();
  const bytes = writeMidi({
    tempo: prog.tempo, chords: prog.chords,
    bassPattern: prog.bassPattern, arp: $('arp').checked,
    seed: (Math.random() * 1e9) | 0,
  });
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `progression-${prog.styleKey}-${prog.keyName}${prog.mode === 'min' ? 'm' : ''}-${prog.tempo}bpm-${prog.bars}bar.mid`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

generate();

// invisible debug handle, only with ?debug — used by automated checks
if (location.search.includes('debug')) {
  window.__drums = {
    get src() { return drumsSrc; },
    get prog() { return prog; },
    get on() { return drumsOn; },
    constants: { DRUMS_BPM, DRUMS_LOOP_START, DRUMS_LOOP_END },
  };
}
