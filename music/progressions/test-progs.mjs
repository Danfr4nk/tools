// test-progs.mjs — node test for the progression generator + MIDI writer.
// Must print PASS lines; any FAIL exits nonzero.
import { generateProgression, STYLE_KEYS } from './progs.js';
import { writeMidi, parseMidiInfo } from './midi.js';

let fails = 0;
const ok = (cond, label) => {
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + label);
  if (!cond) fails++;
};

for (const style of STYLE_KEYS) {
  for (const seed of [1, 7, 1234]) {
    const p = generateProgression(style, { keyPc: 7, mode: 'auto', seed });
    ok(p.chords.length === 4, `${style} seed ${seed}: 4 chords`);
    ok(p.chords.every(c => c.notes.length >= 3 && c.notes.length <= 6),
      `${style} seed ${seed}: 3-6 notes per chord`);
    ok(p.chords.every(c => c.notes.every(n => n >= 21 && n <= 108)),
      `${style} seed ${seed}: notes in piano range`);
    ok(p.chords.every(c => c.bass >= 28 && c.bass <= 48),
      `${style} seed ${seed}: bass in sub range`);
    ok(p.chords.every(c => /^[A-G]#?(m|maj7|m7|maj9|m9|add9|m\(add9\)|m11)?$/.test(c.name)),
      `${style} seed ${seed}: chord names well-formed (${p.chords.map(c => c.name).join(' ')})`);
    // voice-leading: adjacent chord movement stays compact
    let move = 0;
    for (let i = 1; i < 4; i++) {
      const a = p.chords[i - 1].notes, b = p.chords[i].notes;
      move += b.reduce((s, n) => s + Math.min(...a.map(x => Math.abs(x - n))), 0);
    }
    ok(move < 60, `${style} seed ${seed}: voice-leading compact (move=${move.toFixed(1)})`);

    for (const arp of [false, true]) {
      const bytes = writeMidi({ tempo: p.tempo, chords: p.chords, bassPattern: p.bassPattern, arp });
      const info = parseMidiInfo(bytes);
      ok(info.hasTempo, `${style} arp=${arp}: tempo meta present`);
      ok(info.noteOns > 12, `${style} arp=${arp}: note-ons present (${info.noteOns})`);
      ok(info.noteOns === info.noteOffs, `${style} arp=${arp}: ons match offs`);
    }
  }
}

// key transposition sanity: G minor i chord root must be G (pc 7)
const g = generateProgression('nimino', { keyPc: 7, mode: 'min', seed: 42 });
ok(g.chords[0].root === 7 && g.chords[0].roman === 'i', 'G minor starts on i (Gm*)');

// 8-bar: two phrases, turnaround V on bar 8
const e8 = generateProgression('lyny', { keyPc: 7, mode: 'min', bars: 8, seed: 9 });
ok(e8.chords.length === 8, '8-bar: 8 chords');
ok(e8.chords[7].roman === 'V', `8-bar: turnaround is V (got ${e8.chords[7].roman} ${e8.chords[7].name})`);
ok(e8.chords.every(c => c.notes.every(n => n >= 52 && n <= 79)),
  '8-bar: pad notes in sweet register [52,79]');
// mud guard: no semitone rubs below 64
let muddy = 0;
for (const p of [e8, g]) for (const c of p.chords) {
  const s = [...c.notes].sort((a, b) => a - b);
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] === 1 && s[i - 1] < 64) muddy++;
}
ok(muddy === 0, `mud guard: no low semitone rubs (${muddy} found)`);

// locks: locked chord survives regeneration, neighbors re-voice around it
const base = generateProgression('oskar', { keyPc: 0, mode: 'maj', seed: 5 });
const relock = generateProgression('oskar', {
  keyPc: 0, mode: 'maj', seed: 99, locked: [null, base.chords[1], null, null],
});
ok(relock.chords[1].name === base.chords[1].name, 'locked chord preserved');
ok(relock.chords[1].notes.join(',') === base.chords[1].notes.join(','),
  'locked chord voicing preserved');

// humanized MIDI still round-trips
const hm = writeMidi({ tempo: 124, chords: base.chords, bassPattern: base.bassPattern, arp: true, humanize: true, seed: 7 });
const hi = parseMidiInfo(hm);
ok(hi.noteOns === hi.noteOffs && hi.noteOns > 40, `humanized MIDI round-trips (${hi.noteOns} notes)`);
const dm = writeMidi({ tempo: 124, chords: base.chords, bassPattern: base.bassPattern, humanize: false, seed: 7 });
const dm2 = writeMidi({ tempo: 124, chords: base.chords, bassPattern: base.bassPattern, humanize: false, seed: 7 });
ok(dm.join(',') === dm2.join(','), 'humanize=false is deterministic');

// unknown style throws
let threw = false;
try { generateProgression('skrillex', {}); } catch { threw = true; }
ok(threw, 'unknown style throws');

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
