// test-melody2.mjs — harder: vibrato lead + kick/snare + bass.
// Run: node test-melody2.mjs
import { extractMelody } from './melody.js';

const SR = 22050;
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);

function vibTone(midi, start, dur, amp) {
  const n = Math.floor(dur * SR);
  const buf = new Float32Array(n);
  const f = midiHz(midi);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vib = 1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t); // ~±0.5 semitone @5.5Hz
    phase += 2 * Math.PI * f * vib / SR;
    let v = Math.sin(phase) + 0.3 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase);
    const a = Math.min(1, t / 0.02), r = Math.min(1, (dur - t) / 0.05);
    buf[i] = amp * v * Math.min(a, r);
  }
  return buf;
}
function kick(dur = 0.25, amp = 0.9) {
  const n = Math.floor(dur * SR);
  const buf = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = 55 + 45 * Math.exp(-t * 30);
    phase += 2 * Math.PI * f / SR;
    buf[i] = amp * Math.sin(phase) * Math.exp(-t * 12);
  }
  return buf;
}
function snare(dur = 0.18, amp = 0.5) {
  const n = Math.floor(dur * SR);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    buf[i] = amp * (Math.random() * 2 - 1) * Math.exp(-t * 25)
           + 0.3 * amp * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30);
  }
  return buf;
}
function mixInto(dst, src, startSec) {
  const off = Math.floor(startSec * SR);
  for (let i = 0; i < src.length && off + i < dst.length; i++) dst[off + i] += src[i];
}

const MEL = [60, 64, 67, 72, 71, 67, 64, 62]; // includes octave jump 67->72
const NOTE = 0.45, STEP = 0.5;
const total = MEL.length * STEP + 1.0;
const mix = new Float32Array(Math.floor(total * SR));

MEL.forEach((m, i) => mixInto(mix, vibTone(m, 0, NOTE, 0.5), i * STEP));
// four-on-floor kick + backbeat snare, LOUD
for (let t = 0; t < total; t += 0.5) mixInto(mix, kick(), t);
for (let t = 0.25; t < total; t += 0.5) mixInto(mix, snare(), t);
// bass roots
[36, 41, 43, 41].forEach((m, i) => {
  mixInto(mix, vibTone(m, 0, STEP * 2, 0.35), i * STEP * 2);
});
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
for (let i = 0; i < mix.length; i++) mix[i] /= peak * 1.05;

const res = await extractMelody(mix, SR);
const seq = res.notes.map(n => n.midi);
const collapsed = seq.filter((m, i) => i === 0 || m !== seq[i - 1]);
console.log('got      :', collapsed.join(' '));
console.log('expected :', MEL.join(' '));
let correct = 0;
for (let i = 0; i < Math.min(collapsed.length, MEL.length); i++) {
  if (Math.abs(collapsed[i] - MEL[i]) <= 1) correct++;
}
console.log(`pitch accuracy: ${correct}/${MEL.length}`);
// kick drum should not become phantom low notes: count notes below MIDI 45
const lowNotes = res.notes.filter(n => n.midi < 45);
console.log('phantom low notes (<45):', lowNotes.length);
const pass = correct >= MEL.length - 1 && lowNotes.length <= 2;
console.log(pass ? 'TEST PASS' : 'TEST FAIL');
process.exit(pass ? 0 : 1);
