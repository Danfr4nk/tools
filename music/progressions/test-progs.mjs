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

// unknown style throws
let threw = false;
try { generateProgression('skrillex', {}); } catch { threw = true; }
ok(threw, 'unknown style throws');

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
