// test-progs.mjs — node test for the progression generator + MIDI writer.
// Must print PASS lines; any FAIL exits nonzero.
import { generateProgression, generateClassic, generateExtracted, CLASSICS, STYLE_KEYS } from './progs.js';
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
    ok(p.chords.every(c => /^[A-G]#?(m|7|maj7|m7)?$/.test(c.name)),
      `${style} seed ${seed}: chord names are triads/7ths only (${p.chords.map(c => c.name).join(' ')})`);
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

// ---- CLASSICS library ----
const SIMPLE = /^[A-G]#?(m|7|maj7|m7)?$/;
ok(CLASSICS.length >= 50, `CLASSICS library has ${CLASSICS.length} entries (>= 50)`);
{
  const ids = new Set();
  for (const c of CLASSICS) {
    ok(!ids.has(c.id), `unique classic id: ${c.id}`);
    ids.add(c.id);
    for (const b of [4, 8]) {
      const p = generateClassic(c.id, { keyPc: 7, bars: b, seed: 3 });
      ok(p.chords.length === b, `${c.id}: ${b} bars -> ${b} chords`);
      ok(p.chords.every(ch => SIMPLE.test(ch.name)),
        `${c.id}: triads/7ths only (${p.chords.map(ch => ch.name).join(' ')})`);
      ok(p.chords.every(ch => ch.notes.every(n => n >= 52 && n <= 79)),
        `${c.id}: pads in sweet register`);
    }
  }
}
// style switching: same progression, different lane flavor
{
  const lvN = generateClassic('levels', { keyPc: 7, seed: 11 });
  const lvO = generateClassic('levels', { keyPc: 7, seed: 11, styleKey: 'oskar' });
  const lvL = generateClassic('levels', { keyPc: 7, seed: 11, styleKey: 'lyny' });
  ok(lvN.voicingStyle === 'nimino' && lvN.bassStyle === 'garage', 'levels default = nimino flavor, garage bass');
  ok(lvO.voicingStyle === 'oskar' && lvO.bassStyle === 'sustain', 'levels as oskar = sustain bass');
  ok(lvL.voicingStyle === 'lyny' && lvL.bassStyle === 'sub', 'levels as LYNY = sub bass');
  const rom = p => p.chords.map(c => c.roman).join(' ');
  ok(rom(lvN) === rom(lvO) && rom(lvO) === rom(lvL), `style switch keeps the progression (${rom(lvN)})`);
  const sw = generateClassic('sensitive-female', { keyPc: 0, seed: 4, styleKey: 'nimino' });
  ok(sw.swing === 0.12, 'style switch brings the lane swing (nimino 0.12)');
}

// ---- EXTRACTED progressions (hook2piano bridge) ----
{
  // Creep verse as extracted by hook2piano: G Bm C Cm in G major
  const creep = [
    { rootPc: 7, fam: 'maj', roman: 'I', name: 'G' },
    { rootPc: 11, fam: 'min', roman: 'iii', name: 'Bm' },
    { rootPc: 0, fam: 'maj', roman: 'IV', name: 'C' },
    { rootPc: 0, fam: 'min', roman: 'iv (bor. minor)', name: 'Cm' },
  ];
  const p = generateExtracted(creep, { seed: 1, keyPc: 7, mode: 'maj', tempo: 92, title: 'Creep — Verse' });
  ok(p.styleKey === 'extracted', 'extracted styleKey set');
  ok(p.chords.length === 4, 'extracted: 4 chords');
  ok(p.chords.every((c, i) => c.root === creep[i].rootPc), 'extracted: roots preserved');
  ok(p.chords.map(c => c.roman).join('|') === 'I|iii|IV|iv (bor. minor)', 'extracted: romans preserved');
  ok(p.chords.every(c => c.notes.every(n => n >= 52 && n <= 79)), 'extracted: pads in sweet register');
  ok(p.chords.every(c => c.bass >= 28 && c.bass <= 48), 'extracted: bass in sub range');
  ok(p.chords.every(c => SIMPLE.test(c.name)), `extracted: triads/7ths only (${p.chords.map(c => c.name).join(' ')})`);
  ok(p.tempo === 92 && p.keyName === 'G' && p.extTitle === 'Creep — Verse', 'extracted: meta carried through');
  // re-voicing through another lane keeps the harmony, changes the flavor
  const pl = generateExtracted(creep, { seed: 1, styleKey: 'lyny' });
  ok(pl.voicingStyle === 'lyny' && pl.bassStyle === 'sub', 'extracted as LYNY = sub bass');
  ok(pl.chords.every((c, i) => c.root === creep[i].rootPc), 're-voiced: roots still preserved');
  ok(pl.chords.map(c => c.roman).join('|') === p.chords.map(c => c.roman).join('|'), 're-voiced: romans unchanged');
  // determinism
  const p2 = generateExtracted(creep, { seed: 1, keyPc: 7, mode: 'maj' });
  ok(p2.chords.every((c, i) => c.notes.join(',') === p.chords[i].notes.join(',')),
    'extracted: same seed -> identical voicing');
  // locks
  const lk = generateExtracted(creep, { seed: 1, locked: [null, p.chords[1], null, null] });
  ok(lk.chords[1].notes.join(',') === p.chords[1].notes.join(','), 'extracted: locked chord preserved');
  // MIDI round-trips
  const eb = writeMidi({ tempo: p.tempo, chords: p.chords, bassPattern: p.bassPattern, arp: true });
  const ei = parseMidiInfo(eb);
  ok(ei.noteOns === ei.noteOffs && ei.noteOns > 12, 'extracted MIDI round-trips');
  // empty extraction throws
  let ethrew = false;
  try { generateExtracted([], {}); } catch { ethrew = true; }
  ok(ethrew, 'generateExtracted([]) throws');
  // build() refactor regression: classic still voices through buildFrom
  const lv = generateClassic('levels', { keyPc: 7, seed: 11 });
  ok(lv.chords.map(c => c.roman).join(' ') === 'i bIII bVII bVI', 'build refactor: levels romans intact');
}

// unknown style throws
let threw = false;
try { generateProgression('skrillex', {}); } catch { threw = true; }
ok(threw, 'unknown style throws');

console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
