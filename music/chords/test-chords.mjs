// test-chords.mjs — synthetic ground truth: C G Am F, 2 beats each @120BPM.
import { extractChords } from './chords.js';

const SR = 22050, BPM = 120, BEAT = 60 / BPM;
const PROG = [
  { name: 'C',  tones: [48, 52, 55] },
  { name: 'G',  tones: [43, 47, 50] },
  { name: 'Am', tones: [45, 48, 52] },
  { name: 'F',  tones: [41, 45, 48] },
];
const CHORD_DUR = BEAT * 2;

function tone(midi, t0, dur, amp) {
  const f0 = 440 * Math.pow(2, (midi - 69) / 12);
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.015) * Math.exp(-t / (dur * 0.8));
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / Math.pow(h, 1.4);
    out[i] = amp * env * v;
  }
  return { buf: out, t0 };
}

function kick(t0, amp) {
  const dur = 0.18, n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = amp * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * 50 * t);
  }
  return { buf: out, t0 };
}

const total = CHORD_DUR * PROG.length + 0.6;
const mix = new Float32Array(Math.floor(total * SR));
function add({ buf, t0 }) {
  const off = Math.floor(t0 * SR);
  for (let i = 0; i < buf.length && off + i < mix.length; i++) mix[off + i] += buf[i];
}

PROG.forEach((ch, ci) => {
  const t0 = ci * CHORD_DUR;
  // rhythmic pad: re-struck every beat, decaying over the beat (four-on-the-floor feel)
  for (let b = 0; b < 2; b++) {
    for (const m of ch.tones) add(tone(m, t0 + b * BEAT, BEAT * 1.2, 0.16));
    add(kick(t0 + b * BEAT, 0.5));
  }
});

const res = await extractChords(mix, SR, p => { if (p === 1) process.stdout.write(''); });
console.log('tempo:', res.tempo, '(want ~120)');
console.log('beats:', res.beats.length, 'chords:', res.chords.length);
const names = res.chords.filter(c => c.name !== 'N').map(c => c.name);
console.log('sequence:', names.join(' '));
const want = PROG.map(c => c.name);
const ok = want.every((w, i) => names[i] === w) && names.length === want.length;
console.log(ok ? 'PASS: exact match' : 'FAIL: expected ' + want.join(' '));
for (const c of res.chords) console.log(`  ${c.start.toFixed(2)}s +${c.dur.toFixed(2)}s  ${c.name}  conf=${c.conf}`);
