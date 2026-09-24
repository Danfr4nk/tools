// prog2keys.js — chord-symbol parser + voicing math. Pure JS, zero imports.
// Runs in the browser and in Node (module.exports when available).
//
//   parseProgression("Cmaj7 Am7 Dm7 G7") -> [{name, root, bass, intervals, quality}...]
//   voicing(chord, inversion)            -> [midi, ...] (bass lowest, clamped 48..83)
//   transposeChord(chord, semis)         -> chord
//   chordName(chord, preferFlats)        -> "Bbm7" / "A#m7"

const Prog2Keys = (() => {
  'use strict';

  const SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  const BASE_PC = {C:0, D:2, E:4, F:5, G:7, A:9, B:11};

  // interval stacks in semitones from the root
  const QUALITIES = {
    '': [0,4,7], 'maj': [0,4,7], 'M': [0,4,7],
    'm': [0,3,7], 'min': [0,3,7], '-': [0,3,7],
    '5': [0,7],
    '6': [0,4,7,9], 'm6': [0,3,7,9], 'min6': [0,3,7,9],
    '69': [0,4,7,9,14], '6/9': [0,4,7,9,14],
    '7': [0,4,7,10],
    'maj7': [0,4,7,11], 'M7': [0,4,7,11], 'ma7': [0,4,7,11],
    'm7': [0,3,7,10], 'min7': [0,3,7,10], '-7': [0,3,7,10],
    'mmaj7': [0,3,7,11], 'mM7': [0,3,7,11], '-maj7': [0,3,7,11],
    'dim': [0,3,6], 'o': [0,3,6],
    'dim7': [0,3,6,9], 'o7': [0,3,6,9],
    'm7b5': [0,3,6,10], 'min7b5': [0,3,6,10], '-7b5': [0,3,6,10],
    'aug': [0,4,8], '+': [0,4,8],
    '7#5': [0,4,8,10], 'aug7': [0,4,8,10], '+7': [0,4,8,10],
    'maj7#5': [0,4,8,11], 'M7#5': [0,4,8,11],
    'sus': [0,5,7], 'sus4': [0,5,7],
    '7sus': [0,5,7,10], '7sus4': [0,5,7,10],
    'sus2': [0,2,7], '7sus2': [0,2,7,10], '9sus4': [0,5,7,10,14],
    'add9': [0,4,7,14],
    'madd9': [0,3,7,14], 'minadd9': [0,3,7,14], '-add9': [0,3,7,14],
    'add11': [0,4,7,17],
    '9': [0,4,7,10,14],
    'm9': [0,3,7,10,14], 'min9': [0,3,7,10,14], '-9': [0,3,7,10,14],
    'maj9': [0,4,7,11,14], 'M9': [0,4,7,11,14],
    '11': [0,4,7,10,14,17],
    'm11': [0,3,7,10,14,17], 'min11': [0,3,7,10,14,17],
    'maj11': [0,4,7,11,14,17],
    '13': [0,4,7,10,14,21],
    'm13': [0,3,7,10,14,17,21], 'min13': [0,3,7,10,14,17,21],
    'maj13': [0,4,7,11,14,21],
    '7b5': [0,4,6,10],
    '7#9': [0,4,7,10,15],
    '7b9': [0,4,7,10,13],
    '7#11': [0,4,7,10,18],
    'maj7#11': [0,4,7,11,18], 'M7#11': [0,4,7,11,18],
  };

  const mod12 = n => ((n % 12) + 12) % 12;

  function pcOf(letter, acc) {
    let pc = BASE_PC[letter];
    if (acc === '#' || acc === '♯') pc += 1;
    else if (acc === 'b' || acc === '♭') pc -= 1;
    return mod12(pc);
  }

  function normalizeQuality(q) {
    // unicode shorthands -> ascii keys
    q = q.replace(/Δ/g, 'maj').replace(/ø7/g, 'm7b5').replace(/ø/g, 'm7b5')
         .replace(/°7/g, 'dim7').replace(/°/g, 'dim');
    if (q in QUALITIES) return q;
    const lo = q.toLowerCase();
    if (lo in QUALITIES) return lo;
    return null;
  }

  // "Cmaj7", "F#m7b5", "Bb/D", "C-7", "G♭aug"
  function parseChordSymbol(sym) {
    const s = String(sym).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
    const m = /^([A-G])([#b]?)([^/]*?)(?:\/([A-G][#b]?))?$/.exec(s);
    if (!m) return {error: `can't read "${sym}"`};
    const root = pcOf(m[1], m[2]);
    const qkey = normalizeQuality(m[3]);
    if (qkey == null) return {error: `unknown quality "${m[3] || '(none)'}" in "${sym}"`};
    let bass = null;
    if (m[4]) bass = pcOf(m[4][0], m[4][1] || '');
    return {name: s, root, bass, intervals: QUALITIES[qkey].slice(), quality: m[3]};
  }

  function splitProgression(text) {
    return String(text)
      .replace(/[–—]/g, ' ')      // en/em dashes are separators
      .replace(/\s+-\s+/g, ' ')   // spaced hyphens too ("C - Am"), but not "C-7"
      .split(/[\s,;|]+/)
      .map(t => t.trim())
      .filter(Boolean);
  }

  function parseProgression(text) {
    return splitProgression(text).map(parseChordSymbol);
  }

  // concrete MIDI voicing: root parked at C4 (60), inversion rotates the stack,
  // slash bass drops underneath, everything clamped into 48..83 (C3..B5)
  function voicing(chord, inversion = 0) {
    const n = chord.intervals.length;
    const inv = ((inversion % n) + n) % n;
    const base = 60 + chord.root;
    const stacked = chord.intervals.map(i => base + i);
    let midis = stacked.slice(inv).concat(stacked.slice(0, inv).map(m => m + 12));
    if (chord.bass != null) {
      const lowPc = mod12(midis[0]);
      const delta = mod12(lowPc - chord.bass);
      if (delta !== 0) midis = [midis[0] - delta, ...midis];
    }
    while (Math.max(...midis) > 83) midis = midis.map(m => m - 12);
    while (Math.min(...midis) < 48) midis = midis.map(m => m + 12);
    return midis;
  }

  function transposeChord(chord, semis) {
    if (chord.error) return chord;
    return {...chord,
      root: mod12(chord.root + semis),
      bass: chord.bass == null ? null : mod12(chord.bass + semis)};
  }

  function chordName(chord, preferFlats = false) {
    if (chord.error) return chord.name;
    const names = preferFlats ? FLAT : SHARP;
    let s = names[chord.root] + chord.quality;
    if (chord.bass != null) s += '/' + names[chord.bass];
    return s;
  }

  const INV_NAMES = ['root', '1st', '2nd', '3rd', '4th', '5th', '6th'];

  return {parseChordSymbol, parseProgression, splitProgression, voicing,
          transposeChord, chordName, mod12, SHARP, FLAT, INV_NAMES, QUALITIES};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Prog2Keys;
