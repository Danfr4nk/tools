// test-melody.mjs — synthetic "full mix" with a known lead melody.
// Run: node test-melody.mjs
import { extractMelody } from './melody.js';

const SR = 22050;
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
// seeded LCG so the hat noise (and the result) is reproducible run to run
let seed = 24681357;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff - 1;

function tone(midi, start, dur, amp, harmonics) {
  const n = Math.floor(dur * SR);
  const buf = new Float32Array(n);
  const f = midiHz(midi);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      v += harmonics[h] * Math.sin(2 * Math.PI * f * (h + 1) * t);
    }
    // gentle attack/decay to avoid clicks
    const a = Math.min(1, t / 0.01), r = Math.min(1, (dur - t) / 0.03);
    buf[i] = amp * v * Math.min(a, r);
    void start;
  }
  return buf;
}

function mixInto(dst, src, startSec) {
  const off = Math.floor(startSec * SR);
  for (let i = 0; i < src.length && off + i < dst.length; i++) dst[off + i] += src[i];
}

function noiseBurst(dur, amp) {
  const n = Math.floor(dur * SR);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = amp * rnd() * Math.exp(-i / (n * 0.2));
  return buf;
}

// --- build the mix ---
const MEL = [60, 62, 64, 67, 69, 67, 64, 62]; // C D E G A G E D
const NOTE = 0.4, GAP = 0.015;
const melLen = MEL.length * (NOTE + GAP);
const total = melLen + 1.0;
const mix = new Float32Array(Math.floor(total * SR));

// lead melody: bright, amp 0.5
MEL.forEach((m, i) => {
  mixInto(mix, tone(m, 0, NOTE, 0.5, [1, 0.35, 0.18, 0.08]), i * (NOTE + GAP));
});
// bass line: roots, amp 0.42 (LOUDER-ish low end competition)
const BASS = [36, 36, 43, 43, 45, 45, 43, 41];
BASS.forEach((m, i) => {
  mixInto(mix, tone(m, 0, NOTE + GAP, 0.42, [1, 0.3, 0.1]), i * (NOTE + GAP));
});
// pad: chord tones, soft
const PAD = [[48, 55, 64], [53, 57, 65], [55, 59, 67], [53, 57, 65]];
PAD.forEach((ch, i) => {
  ch.forEach(m => mixInto(mix, tone(m, 0, (NOTE + GAP) * 2, 0.10, [1, 0.2]), i * (NOTE + GAP) * 2));
});
// hats: 8th-note noise ticks
for (let t = 0; t < total; t += 0.2) mixInto(mix, noiseBurst(0.03, 0.06), t);
// normalize-ish
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
for (let i = 0; i < mix.length; i++) mix[i] /= peak * 1.05;

// silence gap in the middle of the melody? no — legato test first.

const t0 = Date.now();
const res = await extractMelody(mix, SR, p => {
  if (Math.round(p * 20) !== Math.round(((p * 20) | 0))) return;
});
const ms = Date.now() - t0;

console.log(`extracted ${res.notes.length} notes in ${ms}ms (audio ${res.duration.toFixed(2)}s)`);
console.log('voiced ratio:', res.stats.voicedRatio.toFixed(2));
const seq = res.notes.map(n => n.midi);
console.log('got     :', seq.join(' '));
console.log('expected:', MEL.join(' '));

// scoring: collapse consecutive duplicates, compare
const collapsed = seq.filter((m, i) => i === 0 || m !== seq[i - 1]);
console.log('collapsed:', collapsed.join(' '));
let correct = 0;
for (let i = 0; i < Math.min(collapsed.length, MEL.length); i++) {
  if (Math.abs(collapsed[i] - MEL[i]) <= 1) correct++;
}
console.log(`pitch accuracy: ${correct}/${MEL.length}`);
const timingOk = res.notes.every((n, i) => {
  if (i >= MEL.length) return true;
  const expStart = i * (NOTE + GAP);
  return Math.abs(n.start - expStart) < 0.12;
});
console.log('timing ok:', timingOk);
// no notes during the trailing 1s silence
const tailNotes = res.notes.filter(n => n.start > melLen + 0.1);
console.log('notes in trailing silence:', tailNotes.length, tailNotes.length === 0 ? 'OK' : 'FAIL');

const pass = correct >= MEL.length - 1 && timingOk && tailNotes.length === 0;
console.log(pass ? 'TEST PASS' : 'TEST FAIL');
process.exit(pass ? 0 : 1);
