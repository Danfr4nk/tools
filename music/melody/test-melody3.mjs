// test-melody3.mjs — regression suite for melody.js (hysteresis +
// harmonicity gate + note-level octave-by-evidence). Run: node test-melody3.mjs
// All audio is synthesized in-memory; no files written.
import { extractMelody } from './melody.js';

const SR = 22050;
const mf = m => 440 * Math.pow(2, (m - 69) / 12);
const mk = dur => new Float32Array(Math.ceil(dur * SR));
let seed = 987654321;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff - 1;

// lead voice: additive harmonics, optional vibrato + portamento glide-in
function addLead(buf, midi, t0, dur, o = {}) {
  const { amp = 0.5, nharm = 9, rolloff = 0.72, vibHz = 0, vibCents = 0,
          glideFrom = null, glideDur = 0.12 } = o;
  const f1 = mf(midi), f0 = glideFrom == null ? f1 : mf(glideFrom);
  const start = Math.floor(t0 * SR), n = Math.floor(dur * SR);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const g = glideDur > 0 ? Math.min(1, t / glideDur) : 1;
    const gs = g * g * (3 - 2 * g);
    const fglide = f0 * Math.pow(f1 / f0, gs);
    const vib = vibHz ? Math.sin(2 * Math.PI * vibHz * t) * vibCents / 100 : 0;
    phase += 2 * Math.PI * fglide * Math.pow(2, vib / 12) / SR;
    let s = 0;
    for (let h = 1; h <= nharm; h++) s += Math.pow(rolloff, h - 1) * Math.sin(phase * h) / h;
    const env = Math.min(1, t / 0.01) * Math.min(1, (dur - t) / 0.05);
    const idx = start + i;
    if (idx < buf.length) buf[idx] += amp * s * env;
  }
}
function addBass(buf, midi, t0, dur, amp = 0.42) {
  const f = mf(midi), start = Math.floor(t0 * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / 0.01) * Math.exp(-t * 2.2);
    const idx = start + i;
    if (idx < buf.length) buf[idx] += amp * env * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t));
  }
}
function addKick(buf, t0, amp = 0.85) {
  const start = Math.floor(t0 * SR), n = Math.floor(0.3 * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += 2 * Math.PI * (45 + 110 * Math.exp(-t * 30)) / SR;
    const idx = start + i;
    if (idx < buf.length) buf[idx] += amp * Math.exp(-t * 18) * Math.sin(ph);
  }
}
function addSnare(buf, t0, amp = 0.5) {
  const start = Math.floor(t0 * SR), n = Math.floor(0.2 * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.exp(-t * 25), idx = start + i;
    if (idx < buf.length) buf[idx] += amp * env * (rnd() * 0.7 + 0.3 * Math.sin(2 * Math.PI * 190 * t));
  }
}
function addHat(buf, t0, amp = 0.22) {
  const start = Math.floor(t0 * SR), n = Math.floor(0.06 * SR);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, nz = rnd(), hp = nz - lp;
    lp = nz;
    const idx = start + i;
    if (idx < buf.length) buf[idx] += amp * Math.exp(-t * 90) * hp;
  }
}
function drums(buf, t0, bars, beat = 0.5) {
  for (let b = 0; b < bars; b++) {
    const bt = t0 + b * beat;
    addKick(buf, bt); addHat(buf, bt + beat / 2);
    if (b % 2 === 1) addSnare(buf, bt);
  }
}
// bass with a full sawtooth-ish harmonic series (5 partials) — every one of
// its harmonics lands on the lead's when it doubles the lead an octave down
function addRichBass(buf, midi, t0, dur, amp) {
  const f = mf(midi), start = Math.floor(t0 * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / 0.01) * Math.exp(-t * 1.5);
    let s = 0;
    for (let h = 1; h <= 5; h++) s += Math.sin(2 * Math.PI * f * h * t) / h;
    const idx = start + i;
    if (idx < buf.length) buf[idx] += amp * env * s;
  }
}
function addPad(buf, midis, t0, dur, amp = 0.15) {
  for (const m of midis) {
    const f = mf(m), start = Math.floor(t0 * SR), n = Math.floor(dur * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR, env = Math.min(1, t / 0.4) * Math.min(1, (dur - t) / 0.4);
      let s = 0;
      for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * h * t * 1.003) / Math.pow(h, 1.4);
      const idx = start + i;
      if (idx < buf.length) buf[idx] += amp * env * s;
    }
  }
}

const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const inWin = (notes, t0, t1, minOv = 0.12) =>
  notes.filter(n => overlap(n.start, n.start + n.dur, t0, t1) > minOv);

let failures = 0;
function check(name, cond, detail = '') {
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
  if (!cond) failures++;
}

const T = [];

// T1: heavy vibrato lead must not split notes
T.push(['T1 vibrato: 4 notes, no splits', async () => {
  const buf = mk(4.2), seq = [60, 64, 67, 72];
  seq.forEach((m, i) => {
    const t = 0.2 + i * 0.95;
    addLead(buf, m, t, 0.8, { vibHz: 5.5, vibCents: 70 });
    addBass(buf, m - 24, t, 0.8);
  });
  drums(buf, 0.2, 8);
  const { notes } = await extractMelody(buf, SR);
  let ok = true, det = [];
  seq.forEach((m, i) => {
    const t0 = 0.2 + i * 0.95, w = inWin(notes, t0, t0 + 0.8);
    det.push(`${m}:${w.map(n => n.midi).join(',')}`);
    if (w.length !== 1 || w[0].midi !== m) ok = false;
  });
  check('T1', ok, det.join(' '));
}]);

// T2: legato portamento must not spawn fragment notes
T.push(['T2 legato glides: 3 clean notes', async () => {
  const buf = mk(3.0), seq = [62, 64, 65];
  seq.forEach((m, i) => {
    const t = 0.2 + i * 0.85;
    addLead(buf, m, t, 0.7, { glideFrom: i ? seq[i - 1] : null });
    addBass(buf, m - 24, t, 0.7, 0.35);
  });
  drums(buf, 0.2, 6, 0.45);
  const { notes } = await extractMelody(buf, SR);
  const midis = notes.map(n => n.midi);
  check('T2', notes.length === 3 && midis.every((m, i) => m === seq[i]),
    `got [${midis.join(' ')}]`);
}]);

// T3: drum break must produce zero notes
T.push(['T3 drum break: silence in the break', async () => {
  const buf = mk(5.2);
  [60, 64, 67].forEach((m, i) => addLead(buf, m, 0.2 + i * 0.35, 0.3));
  drums(buf, 1.5, 8, 0.25); // 2s of drums only
  [67, 64, 60].forEach((m, i) => addLead(buf, m, 3.8 + i * 0.35, 0.3));
  const { notes } = await extractMelody(buf, SR);
  const intruders = notes.filter(n => n.start > 1.6 && n.start < 3.3);
  check('T3', intruders.length === 0,
    intruders.length ? `intruders: ${intruders.map(n => `${n.midi}@${n.start.toFixed(2)}`).join(' ')}` : `${notes.length} notes total`);
}]);

// T4: octave jumps land in the right octave
T.push(['T4 octave jumps: exact octaves', async () => {
  const buf = mk(3.4), seq = [60, 72, 60, 84];
  seq.forEach((m, i) => {
    const t = 0.2 + i * 0.7;
    addLead(buf, m, t, 0.55);
    addBass(buf, 36, t, 0.55);
  });
  drums(buf, 0.2, 10, 0.35);
  const { notes } = await extractMelody(buf, SR);
  const midis = notes.map(n => n.midi);
  check('T4', notes.length === 4 && midis.every((m, i) => m === seq[i]),
    `got [${midis.join(' ')}]`);
}]);

// T5: quiet lead over a loud pad — lead must still win most windows
T.push(['T5 quiet lead vs loud pad: >=3/4', async () => {
  const buf = mk(4.6), seq = [67, 69, 71, 72];
  addPad(buf, [48, 55, 60], 0.1, 4.4, 0.17);
  seq.forEach((m, i) => addLead(buf, m, 0.2 + i * 1.0, 0.85, { amp: 0.22 }));
  const { notes } = await extractMelody(buf, SR);
  let hits = 0;
  const det = seq.map((m, i) => {
    const w = inWin(notes, 0.2 + i * 1.0, 1.05 + i * 1.0);
    const hit = w.length === 1 && w[0].midi === m;
    if (hit) hits++;
    return `${m}:${w.map(n => n.midi).join(',')}`;
  });
  check('T5', hits >= 3, `${hits}/4 ${det.join(' ')}`);
}]);

// T6a: original 8-note regression — bass playing same pitch classes 2 octaves down
T.push(['T6a regression: 8/8 exact over walking bass', async () => {
  const buf = mk(5.0), seq = [60, 62, 64, 67, 69, 67, 64, 62];
  seq.forEach((m, i) => {
    const t = 0.2 + i * 0.55;
    addLead(buf, m, t, 0.45);
    addBass(buf, m - 24, t, 0.45);
  });
  drums(buf, 0.2, 16, 0.28);
  const { notes } = await extractMelody(buf, SR);
  const midis = notes.map(n => n.midi);
  check('T6a', notes.length === 8 && midis.every((m, i) => m === seq[i]),
    `got [${midis.join(' ')}]`);
}]);

// T6b: octave preference — lead an octave above loud bass roots
T.push(['T6b regression: lead octave wins over bass', async () => {
  const buf = mk(5.0), seq = [72, 74, 76, 79, 81, 79, 76, 74];
  seq.forEach((m, i) => {
    const t = 0.2 + i * 0.55;
    addLead(buf, m, t, 0.45, { amp: 0.4 });
    addBass(buf, 36, t, 0.5, 0.5);
  });
  drums(buf, 0.2, 16, 0.28);
  const { notes } = await extractMelody(buf, SR);
  const midis = notes.map(n => n.midi);
  check('T6b', notes.length === 8 && midis.every((m, i) => m === seq[i]),
    `got [${midis.join(' ')}]`);
}]);

// T7: bass doubling the lead an octave down, as loud as the lead, with
// vibrato + drums. v2 read 4/12 here (bass stole the melody an octave low).
T.push(['T7 octave-doubling bass: >=10/12', async () => {
  const seq = [64, 67, 69, 72, 71, 67, 65, 64, 62, 60, 62, 64];
  const buf = mk(seq.length * 0.5 + 0.6);
  seq.forEach((m, i) => {
    addLead(buf, m, 0.2 + i * 0.5, 0.42, { amp: 0.5, vibHz: 5.5, vibCents: 30 });
    addRichBass(buf, m - 12, 0.2 + i * 0.5, 0.45, 0.5);
  });
  drums(buf, 0.2, seq.length * 2, 0.25);
  const { notes } = await extractMelody(buf, SR);
  let hits = 0;
  const det = seq.map((m, i) => {
    const w = inWin(notes, 0.2 + i * 0.5, 0.62 + i * 0.5);
    if (w.length === 1 && w[0].midi === m) hits++;
    return w.map(n => n.midi - m).join(',') || 'x';
  });
  check('T7', hits >= 10, `${hits}/12 offsets ${det.join(' ')}`);
}]);

// T8: note timing is unbiased — onsets land within 20ms of truth on median
// (v2 stamped notes at the analysis frame's first sample: ~23ms early).
T.push(['T8 onset timing: |median error| < 20ms', async () => {
  const buf = mk(5.0), seq = [60, 62, 64, 67, 69, 67, 64, 62];
  seq.forEach((m, i) => {
    addLead(buf, m, 0.2 + i * 0.55, 0.45);
    addBass(buf, m - 24, 0.2 + i * 0.55, 0.45);
  });
  drums(buf, 0.2, 16, 0.28);
  const { notes } = await extractMelody(buf, SR);
  const errs = notes.map((n, i) => n.start - (0.2 + i * 0.55)).sort((a, b) => a - b);
  const med = errs[errs.length >> 1];
  check('T8', notes.length === seq.length && Math.abs(med) < 0.02,
    `median ${(med * 1000).toFixed(1)}ms over ${notes.length} notes`);
}]);

for (const [name, fn] of T) {
  try { await fn(); }
  catch (e) { check(name, false, 'threw: ' + e.message); }
}
console.log(failures ? `\n${failures} FAILURES` : '\nALL GREEN');
process.exit(failures ? 1 : 0);
