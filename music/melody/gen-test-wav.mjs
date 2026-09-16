// gen-test-wav.mjs — writes a 12s "song" WAV: vibrato lead + bass + kick/hats.
import { writeFileSync } from 'fs';
const SR = 44100;
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
function vibTone(midi, dur, amp) {
  const n = Math.floor(dur * SR), buf = new Float32Array(n), f = midiHz(midi);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, vib = 1 + 0.025 * Math.sin(2 * Math.PI * 5.5 * t);
    ph += 2 * Math.PI * f * vib / SR;
    const a = Math.min(1, t / 0.02), r = Math.min(1, (dur - t) / 0.05);
    buf[i] = amp * (Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph)) * Math.min(a, r);
  }
  return buf;
}
function kick() {
  const n = Math.floor(0.25 * SR), buf = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = 55 + 45 * Math.exp(-t * 30);
    ph += 2 * Math.PI * f / SR;
    buf[i] = 0.85 * Math.sin(ph) * Math.exp(-t * 12);
  }
  return buf;
}
function hat() {
  const n = Math.floor(0.05 * SR), buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = 0.18 * (Math.random() * 2 - 1) * Math.exp(-i / (n * 0.15));
  return buf;
}
function put(dst, src, t) {
  const o = Math.floor(t * SR);
  for (let i = 0; i < src.length && o + i < dst.length; i++) dst[o + i] += src[i];
}
const MEL = [60, 62, 64, 67, 69, 67, 64, 62, 60, 64, 67, 72];
const STEP = 0.5, total = MEL.length * STEP + 1.5;
const mix = new Float32Array(Math.floor(total * SR));
MEL.forEach((m, i) => put(mix, vibTone(m, 0.46, 0.5), i * STEP));
[36, 43, 41, 43, 36, 43, 45, 43, 36, 43, 41, 43].forEach((m, i) => put(mix, vibTone(m, 0.48, 0.34), i * STEP));
for (let t = 0; t < total; t += 0.5) put(mix, kick(), t);
for (let t = 0.25; t < total; t += 0.5) put(mix, hat(), t);
let pk = 0;
for (const v of mix) pk = Math.max(pk, Math.abs(v));
const g = 0.89 / pk;
// 16-bit PCM WAV
const data = new Int16Array(mix.length);
for (let i = 0; i < mix.length; i++) data[i] = Math.max(-32768, Math.min(32767, Math.round(mix[i] * g * 32767)));
const hdr = Buffer.alloc(44);
hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length * 2, 4); hdr.write('WAVE', 8);
hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
hdr.write('data', 36); hdr.writeUInt32LE(data.length * 2, 40);
writeFileSync('/home/hatch/workspace/tools-migration/tools-clone/music/melody/test-song.wav', Buffer.concat([hdr, Buffer.from(data.buffer)]));
console.log('wrote test-song.wav', total.toFixed(1) + 's');
// expected melody for the browser test to verify
console.log('expected:', MEL.join(' '));
