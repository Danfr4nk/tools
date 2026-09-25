// test-prog2keys.mjs — run: node test-prog2keys.mjs
import {createRequire} from 'module';
const require = createRequire(import.meta.url);
const P = require('./prog2keys.js');

let pass = 0, fail = 0;
const eq = (got, want, label) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${label}\n  got  ${g}\n  want ${w}`); }
};

// --- symbol parsing ---
eq(P.parseChordSymbol('Cmaj7').intervals, [0,4,7,11], 'Cmaj7');
eq(P.parseChordSymbol('Am7').root, 9, 'Am7 root');
eq(P.parseChordSymbol('Am7').intervals, [0,3,7,10], 'Am7');
eq(P.parseChordSymbol('F#dim7').intervals, [0,3,6,9], 'F#dim7');
eq(P.parseChordSymbol('F#dim7').root, 6, 'F# root');
eq(P.parseChordSymbol('Bbm9').intervals, [0,3,7,10,14], 'Bbm9');
eq(P.parseChordSymbol('G/B').bass, 11, 'G/B bass');
eq(P.parseChordSymbol('C-7').intervals, [0,3,7,10], 'C-7');
eq(P.parseChordSymbol('Dø').intervals, [0,3,6,10], 'Dø');
eq(P.parseChordSymbol('Esus4').intervals, [0,5,7], 'Esus4');
eq(P.parseChordSymbol('A7#9').intervals, [0,4,7,10,15], 'A7#9');
eq(P.parseChordSymbol('C69').intervals, [0,4,7,9,14], 'C69');
eq(P.parseChordSymbol('C').intervals, [0,4,7], 'bare C');
eq(P.parseChordSymbol('Cm').intervals, [0,3,7], 'Cm');
eq(P.parseChordSymbol('CΔ7').intervals, [0,4,7,11], 'CΔ7');
eq(P.parseChordSymbol('Bo7').intervals, [0,3,6,9], 'Bo7');
eq(P.parseChordSymbol('H9').error !== undefined, true, 'H9 rejected');
eq(P.parseChordSymbol('Cxyz').error !== undefined, true, 'Cxyz rejected');
// capital M = major: must not case-fold into minor
eq(P.parseChordSymbol('CM6').intervals, [0,4,7,9], 'CM6 is major 6');
eq(P.parseChordSymbol('CM13').intervals, [0,4,7,11,14,21], 'CM13 is maj13');
eq(P.parseChordSymbol('CMadd9').intervals, [0,4,7,14], 'CMadd9 is major add9');
eq(P.parseChordSymbol('CM69').intervals, [0,4,7,9,14], 'CM69');
eq(P.parseChordSymbol('CMaj7').intervals, [0,4,7,11], 'CMaj7');
eq(P.parseChordSymbol('CMin7').intervals, [0,3,7,10], 'CMin7');
eq(P.parseChordSymbol('Cmi7').intervals, [0,3,7,10], 'Cmi7 (Real Book)');
eq(P.parseChordSymbol('CΔ6').intervals, [0,4,7,9], 'CΔ6');
eq(P.parseChordSymbol('CM7b5').error !== undefined, true, 'CM7b5 rejected, not misread');

// --- progression splitting ---
eq(P.splitProgression('Cmaj7 – Am7, Dm7 | G7'), ['Cmaj7','Am7','Dm7','G7'], 'separators');
eq(P.splitProgression('C - Am - F - G'), ['C','Am','F','G'], 'spaced hyphens');
eq(P.parseProgression('C-7 D-9').map(c => c.intervals[0]), [0,0], 'hyphen-minor kept');

// --- voicings ---
const cmaj7 = P.parseChordSymbol('Cmaj7');
eq(P.voicing(cmaj7, 0), [60,64,67,71], 'Cmaj7 root pos');
eq(P.voicing(cmaj7, 1), [64,67,71,72], 'Cmaj7 1st inv');
eq(P.voicing(cmaj7, 3), [71,72,76,79], 'Cmaj7 3rd inv');
const gb = P.parseChordSymbol('G/B');
eq(P.voicing(gb, 0)[0], 59, 'G/B bass under');
eq(P.voicing(P.parseChordSymbol('C13'), 0).length, 6, 'C13 six notes');
// extended-chord inversions: the named chord tone is the lowest note, and
// the voicing comes back ascending (rotate+12 broke both past the octave)
const lowest = v => Math.min(...v);
const asc = v => v.every((m, i) => !i || m > v[i - 1]);
eq(P.voicing(P.parseChordSymbol('Cadd9'), 3)[0] % 12, 2, 'Cadd9 3rd inv: D in bass');
eq(lowest(P.voicing(P.parseChordSymbol('Cadd9'), 3)) % 12, 2, 'Cadd9 3rd inv: D lowest');
eq(P.voicing(P.parseChordSymbol('Cmaj9'), 1), [64,67,71,72,74], 'Cmaj9 1st inv ascending');
eq(lowest(P.voicing(P.parseChordSymbol('Cm13'), 6)) % 12, 9, 'Cm13 6th inv: A lowest');
eq(['Cmaj9','Am9','Dm9','G13','Cm13','C7#11'].every(sym => {
  const c = P.parseChordSymbol(sym);
  return c.intervals.every((_, i) => { const v = P.voicing(c, i); return asc(v) && v[0] >= 48 && v[v.length - 1] <= 83; });
}), true, 'all inversions ascending + in range');

// --- transpose + naming ---
const t = P.transposeChord(P.parseChordSymbol('Cmaj7'), 2);
eq(P.chordName(t, false), 'Dmaj7', 'transpose sharp');
eq(P.chordName(P.transposeChord(P.parseChordSymbol('Cmaj7'), 1), true), 'Dbmaj7', 'transpose flat');
eq(P.chordName(P.transposeChord(P.parseChordSymbol('A/F#'), 1), false), 'A#/G', 'slash transpose');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
