// progs.js — chord progression generator. Pure JS, zero imports. Browser + Node.
//
// Style packs encode the harmonic fingerprints of Dan's three obsessions:
//   nimino     — minor melodic house / UK garage swing
//                ("The Back Of Your Hands": Gm-Bb-Eb = i-bIII-bVI; "I Only
//                Smoke When I Drink": B, 127 BPM, dark valence)
//   oskar med k — warm diatonic chill-house, vi-IV-I-V family
//   LYNY       — dark trap/bass minor, i-bVI-bIII-bVII, sparse voicings,
//                phrygian bII color, half-time 140s
// Voicings stay simple on purpose: major/minor triads, occasional 7ths.
// CLASSICS is the canon library: 50+ named progressions (pop, house, garage,
// dnb, techno, soul, lo-fi, modal, global, hip-hop) voiced the same simple way.
//
// export: generateProgression(styleKey, {keyPc, mode, seed})
//   -> {style, keyName, mode, tempo, chords:[{roman, name, root, quality,
//       notes:[midi], bass}], bassPattern}

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJ_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const MIN_SEMIS = [0, 2, 3, 5, 7, 8, 10];
const MAJ_DEG_Q = { 1: 'maj', 2: 'min', 3: 'min', 4: 'maj', 5: 'maj', 6: 'min' };
const MIN_DEG_Q = { 1: 'min', 3: 'maj', 4: 'min', 5: 'min', 6: 'maj', 7: 'maj' };
const MAJ_ROMAN = { 1: 'I', 2: 'ii', 3: 'iii', 4: 'IV', 5: 'V', 6: 'vi', 7: 'vii' };
const MIN_ROMAN = { 1: 'i', 3: 'bIII', 4: 'iv', 5: 'v', 6: 'bVI', 7: 'bVII' };
const CHROM_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

const QUALITY_IV = {
  maj: [0, 4, 7], min: [0, 3, 7],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
  7: [0, 4, 7, 10],
  maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  min11: [0, 3, 7, 10, 14, 17],
};
const QUALITY_SFX = {
  maj: '', min: 'm', maj7: 'maj7', min7: 'm7', 7: '7', maj9: 'maj9', min9: 'm9',
  add9: 'add9', madd9: 'm(add9)', min11: 'm11',
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rng, pairs) {
  let r = rng(), acc = 0;
  for (const [v, w] of pairs) { acc += w; if (r <= acc) return v; }
  return pairs[pairs.length - 1][0];
}

const STYLES = {
  nimino: {
    label: 'nimino', mode: 'min', tempo: 124, swing: 0.12, bass: 'garage',
    templates: [
      [1, 6, 3, 7], [1, 3, 6, 7], [1, 7, 6, 7], [1, 6, 7, 5], [1, 4, 6, 5],
      [6, 7, 1, 3],
    ],
    ext: {
      min: [['min', 0.55], ['min7', 0.45]],
      maj: [['maj', 0.55], ['maj7', 0.30], ['7', 0.15]],
    },
  },
  oskar: {
    label: 'oskar med k', mode: 'maj', tempo: 122, swing: 0, bass: 'sustain',
    templates: [
      [6, 4, 1, 5], [1, 5, 6, 4], [1, 4, 6, 5], [4, 1, 5, 6], [1, 6, 3, 7],
    ],
    ext: {
      min: [['min', 0.60], ['min7', 0.40]],
      maj: [['maj', 0.60], ['maj7', 0.25], ['7', 0.15]],
    },
  },
  lyny: {
    label: 'LYNY', mode: 'min', tempo: 140, swing: 0, bass: 'sub',
    templates: [
      [1, 6, 3, 7], [1, 1, 6, 7], [1, 7, 6, 7], [1, 6, 7, 7],
      [1, 'b2', 1, 7], [1, 3, 7, 4],
    ],
    ext: {
      min: [['min', 0.65], ['min7', 0.35]],
      maj: [['maj', 0.65], ['7', 0.35]],
    },
  },
};

function degreePc(degree, keyPc, mode) {
  if (degree === 'b2') return (keyPc + 1) % 12; // phrygian color
  const semis = mode === 'maj' ? MAJ_SEMIS : MIN_SEMIS;
  return (keyPc + semis[degree - 1]) % 12;
}

function degreeQuality(degree, mode) {
  if (degree === 'b2') return 'maj';
  const map = mode === 'maj' ? MAJ_DEG_Q : MIN_DEG_Q;
  return map[degree];
}

function roman(degree, mode) {
  if (degree === 'b2') return 'bII';
  return (mode === 'maj' ? MAJ_ROMAN : MIN_ROMAN)[degree];
}

// voice-lead: spread chord tones in the sweet register [52,79], choose the
// rotation minimizing movement from the previous voicing (common tones hold
// still). Mud guard: penalize semitone/whole-tone clusters below 64 — low
// extensions that smear get pushed to a cleaner inversion.
function voiceChord(pcs, prev) {
  const sorted = [...pcs].sort((a, b) => a - b);
  let best = null, bestScore = Infinity;
  for (let rot = 0; rot < sorted.length; rot++) {
    const order = sorted.map((_, i) => sorted[(rot + i) % sorted.length]);
    const notes = [];
    let m = 52 + ((order[0] - 52) % 12 + 12) % 12;
    if (m < 52) m += 12;
    notes.push(m);
    for (let i = 1; i < order.length; i++) {
      let n = notes[i - 1] + ((order[i] - notes[i - 1]) % 12 + 12) % 12;
      if (n <= notes[i - 1]) n += 12;
      if (n > 79) n -= 12;
      notes.push(n);
    }
    let score = 0;
    if (prev) {
      for (const n of notes) {
        let d = Infinity;
        for (const p of prev) d = Math.min(d, Math.abs(n - p));
        score += d;
      }
      score += Math.max(0, Math.max(...notes) - Math.min(...notes) - 19) * 2;
    }
    const srt = [...notes].sort((a, b) => a - b);
    for (let i = 1; i < srt.length; i++) {
      if (srt[i] - srt[i - 1] === 1 && srt[i - 1] < 64) score += 100; // low semitone rub
    }
    if (score < bestScore) { bestScore = score; best = notes; }
  }
  return best;
}

const BASS_PATTERNS = {
  garage: [ // UK-garage 2-step: root stab, 16th pickup, octave pop, push
    { t: 0.0, oct: 0, d: 0.7 }, { t: 0.75, oct: 0, d: 0.4 },
    { t: 2.5, oct: 1, d: 0.4 }, { t: 3.0, oct: 0, d: 0.9 },
  ],
  sustain: [ // warm held root + fifth swell mid-bar
    { t: 0.0, oct: 0, d: 3.8 }, { t: 2.0, oct: 0, semi: 7, d: 1.6 },
  ],
  sub: [ // long 808-style sub + octave pop at the turnaround
    { t: 0.0, oct: 0, d: 3.4, glide: true }, { t: 3.5, oct: 1, d: 0.4 },
  ],
  pump: [ // house offbeat pump: root, fifth, octave pops
    { t: 0.5, oct: 0, d: 0.35 }, { t: 1.5, oct: 0, semi: 7, d: 0.35 },
    { t: 2.5, oct: 1, d: 0.35 }, { t: 3.5, oct: 0, d: 0.35 },
  ],
  rolling: [ // techno 16th rolling bass
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
      .map(s => ({ t: s * 0.25, oct: s % 8 === 6 ? 1 : 0, d: 0.22 })),
  ],
  half: [ // halftime: long root, fifth stab on the back half
    { t: 0.0, oct: 0, d: 2.6, glide: true }, { t: 2.75, oct: 0, semi: 7, d: 0.5 },
  ],
};

// ---- chromatic chord specs ----
// numeric specs are diatonic (mode-aware). String specs allow chromatic
// roots and forced qualities: "b2" (Phrygian bII), "b7" (Mixolydian bVII),
// "3M" (major III, the Creep lift), "4m" (minor iv). Accidentals resolve
// against the MAJOR scale so "b6" is always the flat-6, in any mode.
const MAJ_OFF = [0, 2, 4, 5, 7, 9, 11];
const MAJ_QUAL = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
function parseSpec(spec, keyPc, mode) {
  if (spec === 'b2') // legacy phrygian color: major quality, bII roman
    return { root: (keyPc + 1) % 12, fam: 'maj', deg: 2, acc: 'b', roman: 'bII' };
  if (typeof spec === 'number') {
    const q = degreeQuality(spec, mode);
    return { root: degreePc(spec, keyPc, mode), fam: q === 'min' ? 'min' : 'maj',
             deg: spec, acc: '', roman: roman(spec, mode) };
  }
  const m = /^([b#]?)(\d)([Mm])?$/.exec(spec);
  if (!m) throw new Error('bad chord spec: ' + spec);
  const d = +m[2], acc = m[1], qov = m[3];
  const root = (((keyPc + MAJ_OFF[d - 1] + (acc === 'b' ? -1 : acc === '#' ? 1 : 0)) % 12) + 12) % 12;
  let fam = qov ? (qov === 'M' ? 'maj' : 'min')
                : (MAJ_QUAL[d - 1] === 'maj' ? 'maj' : 'min');
  const romanStr = acc + (fam === 'maj' ? CHROM_ROMAN[d - 1] : CHROM_ROMAN[d - 1].toLowerCase());
  return { root, fam, deg: d, acc, roman: romanStr };
}

// shared chord builder: voice-leads `specs` (numbers or chromatic strings)
// through `prev`, picking extensions from `extTable` with `rng`.
function makeChordBuilder({ keyPc, mode, extTable, rng, vMaj = false }) {
  let prev = null;
  return {
    setPrev(notes) { prev = notes; },
    // vMajOnce: harmonic-minor V lift (major quality + "V" roman on degree 5)
    build(spec, vMajOnce = false) {
      const p = parseSpec(spec, keyPc, mode);
      let { root, fam, roman: romanStr } = p;
      if ((vMaj || vMajOnce) && p.deg === 5 && !p.acc) { fam = 'maj'; romanStr = 'V'; }
      return this.buildFrom(root, fam, romanStr);
    },
    // voice an explicit root + family (used for extracted progressions,
    // where the harmony comes from outside the spec system)
    buildFrom(rootPc, fam, romanStr) {
      const quality = pickWeighted(rng, extTable[fam]);
      const pcs = QUALITY_IV[quality].map(s => (rootPc + s) % 12);
      const notes = voiceChord(pcs, prev);
      prev = notes;
      return {
        roman: romanStr,
        name: ROOTS[rootPc] + QUALITY_SFX[quality],
        root: rootPc, quality, notes,
        bass: bassMidi(rootPc, 0),
      };
    },
  };
}

function bassMidi(rootPc, oct) {
  let m = 36 + rootPc + oct * 12;
  while (m > 43) m -= 12;
  while (m < 28) m += 12;
  return m;
}

export function generateProgression(styleKey, opts = {}) {
  const st = STYLES[styleKey];
  if (!st) throw new Error('unknown style: ' + styleKey);
  const rng = mulberry32(opts.seed ?? ((Math.random() * 1e9) | 0));
  const keyPc = opts.keyPc ?? (rng() * 12 | 0);
  const mode = opts.mode === 'auto' || !opts.mode ? st.mode : opts.mode;
  const bars = opts.bars === 8 ? 8 : 4;
  const locked = opts.locked || [];

  const chords = [];
  const cb = makeChordBuilder({ keyPc, mode, extTable: st.ext, rng });
  let template = null;

  for (let b = 0; b < bars; b++) {
    if (locked[b]) { // keep the locked chord, voice-lead through it
      chords.push(locked[b]);
      cb.setPrev(locked[b].notes);
      continue;
    }
    const phrasePos = b % 4;
    if (!template || phrasePos === 0) {
      // start a phrase: fresh 4-chord template
      template = st.templates[(rng() * st.templates.length) | 0];
    }
    const isTurnaround = bars === 8 && b === 7;
    chords.push(isTurnaround
      ? cb.build(5, true)            // harmonic-minor V lift into the loop
      : cb.build(template[phrasePos]));
  }

  return {
    style: st.label, styleKey,
    keyName: ROOTS[keyPc], keyPc, mode,
    tempo: opts.tempo ?? st.tempo,
    swing: st.swing,
    bars,
    chords,
    bassPattern: BASS_PATTERNS[st.bass],
    bassStyle: st.bass,
  };
}

export const STYLE_KEYS = Object.keys(STYLES);
export const STYLE_META = Object.fromEntries(
  Object.entries(STYLES).map(([k, s]) => [k, { label: s.label, mode: s.mode, tempo: s.tempo }])
);

// ---- CLASSICS: the canon of progressions that built pop and dance music ----
// deg: 4 chord specs (numbers = diatonic, strings = chromatic: "b2","b7","3M","4m").
// deg2: optional second phrase for 8-bar mode. ext: lush|warm|dark voicing
// family (borrowed from the artist lanes). bass: garage|sustain|sub|pump|rolling|half.
export const CLASSICS = [
  // -- Pop --
  { id: 'sensitive-female', name: 'Sensitive Female', fam: 'Pop', mode: 'maj', deg: [1, 5, 6, 4], ext: 'warm', bass: 'sustain', bpm: 100 },
  { id: 'pop-punk', name: 'Pop Punk', fam: 'Pop', mode: 'maj', deg: [6, 4, 1, 5], ext: 'warm', bass: 'pump', bpm: 160 },
  { id: 'doo-wop', name: 'Doo-Wop', fam: 'Pop', mode: 'maj', deg: [1, 6, 4, 5], ext: 'warm', bass: 'sustain', bpm: 120 },
  { id: 'canon', name: 'Canon', fam: 'Pop', mode: 'maj', deg: [1, 5, 6, 3], deg2: [4, 1, 4, 5], ext: 'lush', bass: 'sustain', bpm: 90 },
  { id: 'creep', name: 'Creep', fam: 'Pop', mode: 'maj', deg: [1, '3M', 4, '4m'], ext: 'lush', bass: 'sustain', bpm: 92 },
  { id: 'wistful', name: 'Wistful', fam: 'Pop', mode: 'maj', deg: [6, 2, 5, 1], ext: 'lush', bass: 'sustain', bpm: 110 },
  { id: 'heartland', name: 'Heartland', fam: 'Pop', mode: 'maj', deg: [1, 4, 5, 4], ext: 'warm', bass: 'pump', bpm: 120 },
  { id: 'get-lucky', name: 'Get Lucky', fam: 'Pop', mode: 'maj', deg: [6, 1, 3, '2M'], ext: 'warm', bass: 'pump', bpm: 116 },
  { id: 'nu-disco', name: 'Nu-Disco', fam: 'Pop', mode: 'maj', deg: [6, 5, 1, 5], ext: 'warm', bass: 'pump', bpm: 118 },
  { id: 'eurodance', name: 'Eurodance', fam: 'Pop', mode: 'maj', deg: [1, 4, 6, 5], ext: 'warm', bass: 'pump', bpm: 140 },
  // -- Dance / House --
  { id: 'levels', name: 'Levels', fam: 'Dance / House', mode: 'min', deg: [1, 3, 7, 6], ext: 'lush', bass: 'pump', bpm: 126 },
  { id: 'anthem', name: 'Festival Anthem', fam: 'Dance / House', mode: 'min', deg: [1, 6, 3, 7], ext: 'lush', bass: 'pump', bpm: 128 },
  { id: 'andalusian', name: 'Andalusian', fam: 'Dance / House', mode: 'min', deg: [1, 7, 6, 5], vMaj: true, ext: 'lush', bass: 'pump', bpm: 124 },
  { id: 'diva-house', name: 'Diva House', fam: 'Dance / House', mode: 'maj', deg: [1, 6, 2, 5], ext: 'warm', bass: 'pump', bpm: 122 },
  { id: 'afterhours', name: 'Afterhours', fam: 'Dance / House', mode: 'min', deg: [1, 4, 7, 6], ext: 'lush', bass: 'sustain', bpm: 122 },
  { id: 'piano-house', name: 'Piano House', fam: 'Dance / House', mode: 'maj', deg: [1, 5, 6, 4], ext: 'warm', bass: 'pump', bpm: 124 },
  { id: 'euphoria', name: 'Euphoria', fam: 'Dance / House', mode: 'min', deg: [1, 7, 6, 7], ext: 'lush', bass: 'pump', bpm: 138 },
  { id: 'rave', name: 'Rave Stab', fam: 'Dance / House', mode: 'min', deg: [1, 1, 6, 7], ext: 'dark', bass: 'pump', bpm: 140 },
  { id: 'sunset-prog', name: 'Sunset Prog', fam: 'Dance / House', mode: 'maj', deg: [1, 6, 3, 4], ext: 'lush', bass: 'pump', bpm: 124 },
  { id: 'bassline', name: 'Bassline House', fam: 'Dance / House', mode: 'min', deg: [1, 5, 6, 7], ext: 'dark', bass: 'pump', bpm: 128 },
  { id: 'funky', name: 'UK Funky', fam: 'Dance / House', mode: 'maj', deg: [1, 2, 5, 1], ext: 'warm', bass: 'garage', bpm: 130 },
  { id: 'speed-house', name: 'Speed House', fam: 'Dance / House', mode: 'min', deg: [1, 4, 5, 6], ext: 'lush', bass: 'pump', bpm: 135 },
  { id: 'italo', name: 'Italo Disco', fam: 'Dance / House', mode: 'maj', deg: [6, 2, 5, 1], ext: 'lush', bass: 'pump', bpm: 118 },
  { id: 'outrun', name: 'Outrun', fam: 'Dance / House', mode: 'min', deg: [1, 4, 6, 5], ext: 'lush', bass: 'pump', bpm: 100 },
  { id: 'future-bass', name: 'Future Bass', fam: 'Dance / House', mode: 'maj', deg: [6, 5, 4, 5], ext: 'lush', bass: 'half', bpm: 150 },
  // -- Garage --
  { id: 'night-garage', name: 'Night Garage', fam: 'Garage', mode: 'min', deg: [1, 4, 7, 6], ext: 'lush', bass: 'garage', bpm: 130 },
  { id: 'bump', name: '2-Step Bump', fam: 'Garage', mode: 'min', deg: [1, 7, 1, 6], ext: 'lush', bass: 'garage', bpm: 132 },
  { id: 'soulful-garage', name: 'Soulful Garage', fam: 'Garage', mode: 'maj', deg: [2, 5, 1, 6], ext: 'lush', bass: 'garage', bpm: 128, swing: true },
  // -- DnB / Halftime --
  { id: 'roller', name: 'Roller', fam: 'DnB / Halftime', mode: 'min', deg: [1, 6, 1, 6], ext: 'dark', bass: 'half', bpm: 174 },
  { id: 'jungle', name: 'Jungle', fam: 'DnB / Halftime', mode: 'min', deg: [1, 5, 1, 4], ext: 'dark', bass: 'half', bpm: 172 },
  { id: 'halftime-drop', name: 'Halftime Drop', fam: 'DnB / Halftime', mode: 'min', deg: [1, 1, 7, 6], ext: 'dark', bass: 'half', bpm: 80 },
  { id: 'liquid', name: 'Liquid', fam: 'DnB / Halftime', mode: 'maj', deg: [1, 6, 2, 5], ext: 'lush', bass: 'half', bpm: 174 },
  { id: 'minimal-dnb', name: 'Minimal DnB', fam: 'DnB / Halftime', mode: 'min', deg: [1, 1, 1, 6], ext: 'dark', bass: 'sub', bpm: 174 },
  // -- Techno --
  { id: 'warehouse', name: 'Warehouse', fam: 'Techno', mode: 'min', deg: [1, 1, 1, 7], ext: 'dark', bass: 'rolling', bpm: 132 },
  { id: 'loop-techno', name: 'Loop Techno', fam: 'Techno', mode: 'min', deg: [1, 1, 6, 1], ext: 'dark', bass: 'rolling', bpm: 130 },
  { id: 'peak-time', name: 'Peak Time', fam: 'Techno', mode: 'min', deg: [1, 7, 1, 7], ext: 'dark', bass: 'rolling', bpm: 138 },
  { id: 'dub-techno', name: 'Dub Techno', fam: 'Techno', mode: 'min', deg: [1, 4, 1, 7], ext: 'lush', bass: 'sustain', bpm: 120 },
  { id: 'acid-line', name: 'Acid Line', fam: 'Techno', mode: 'min', deg: [1, 'b2', 1, 7], ext: 'dark', bass: 'rolling', bpm: 132 },
  // -- Soul / Jazz (sample fodder) --
  { id: 'rhythm-changes', name: 'Rhythm Changes', fam: 'Soul / Jazz', mode: 'maj', deg: [1, 6, 2, 5], ext: 'warm', bass: 'sustain', bpm: 160 },
  { id: 'jazz-turnaround', name: 'Jazz Turnaround', fam: 'Soul / Jazz', mode: 'maj', deg: [3, 6, 2, 5], ext: 'lush', bass: 'sustain', bpm: 120 },
  { id: 'neo-soul', name: 'Neo-Soul 9ths', fam: 'Soul / Jazz', mode: 'maj', deg: [2, 5, 1, 6], ext: 'lush', bass: 'sustain', bpm: 90 },
  { id: 'gospel-lift', name: 'Gospel Lift', fam: 'Soul / Jazz', mode: 'maj', deg: [1, 4, 1, 5], ext: 'warm', bass: 'sustain', bpm: 100 },
  { id: 'bossa', name: 'Bossa', fam: 'Soul / Jazz', mode: 'maj', deg: [1, 6, 2, 5], ext: 'lush', bass: 'sustain', bpm: 120, swing: true },
  { id: 'minor-gospel', name: 'Minor Gospel', fam: 'Soul / Jazz', mode: 'min', deg: [1, 4, 7, 3], ext: 'lush', bass: 'sustain', bpm: 96 },
  // -- Lo-Fi --
  { id: 'rainy', name: 'Rainy Day', fam: 'Lo-Fi', mode: 'maj', deg: [6, 4, 1, 5], ext: 'lush', bass: 'sustain', bpm: 84 },
  { id: 'tape-loop', name: 'Tape Loop', fam: 'Lo-Fi', mode: 'maj', deg: [1, 3, 6, 2], ext: 'lush', bass: 'sustain', bpm: 80 },
  { id: 'night-drive', name: 'Night Drive', fam: 'Lo-Fi', mode: 'min', deg: [4, 7, 3, 6], ext: 'lush', bass: 'sustain', bpm: 86 },
  // -- Modal --
  { id: 'dorian-vamp', name: 'Dorian Vamp', fam: 'Modal', mode: 'min', deg: [1, 4, 1, 4], ext: 'dark', bass: 'half', bpm: 100 },
  { id: 'phrygian', name: 'Phrygian Dark', fam: 'Modal', mode: 'min', deg: [1, 'b2', 1, 'b2'], ext: 'dark', bass: 'rolling', bpm: 128 },
  { id: 'mixolydian', name: 'Mixolydian Groove', fam: 'Modal', mode: 'maj', deg: [1, 5, 'b7', 4], ext: 'warm', bass: 'pump', bpm: 118 },
  { id: 'aeolian', name: 'Aeolian Folk', fam: 'Modal', mode: 'min', deg: [1, 4, 5, 4], ext: 'warm', bass: 'sustain', bpm: 100 },
  // -- Global --
  { id: 'amapiano', name: 'Amapiano', fam: 'Global', mode: 'maj', deg: [2, 5, 1, 1], ext: 'warm', bass: 'pump', bpm: 112 },
  { id: 'dembow', name: 'Dembow', fam: 'Global', mode: 'min', deg: [1, 7, 1, 7], ext: 'warm', bass: 'half', bpm: 96 },
  { id: 'island', name: 'Island Pop', fam: 'Global', mode: 'maj', deg: [1, 5, 2, 4], ext: 'warm', bass: 'half', bpm: 100 },
  // -- Hip-Hop / R&B --
  { id: 'eight-oh-eights', name: '808s', fam: 'Hip-Hop / R&B', mode: 'min', deg: [1, 6, 7, 6], ext: 'dark', bass: 'sub', bpm: 140 },
  { id: 'golden-era', name: 'Golden Era', fam: 'Hip-Hop / R&B', mode: 'maj', deg: [2, 5, 1, 6], ext: 'warm', bass: 'half', bpm: 92 },
  { id: 'phonk', name: 'Phonk', fam: 'Hip-Hop / R&B', mode: 'min', deg: [1, 1, 7, 6], ext: 'dark', bass: 'sub', bpm: 128 },
  { id: 'witch-house', name: 'Witch House', fam: 'Hip-Hop / R&B', mode: 'min', deg: [1, 'b6', 'b7', 1], ext: 'dark', bass: 'half', bpm: 90 },
  { id: 'slow-jam', name: 'Slow Jam', fam: 'Hip-Hop / R&B', mode: 'maj', deg: [1, 3, 6, 2], ext: 'lush', bass: 'sustain', bpm: 76 },
];

const EXT_FAM = { lush: 'nimino', warm: 'oskar', dark: 'lyny' };

// generate a classic: fixed degrees, lane-borrowed voicing + bass, full
// voice-leading, locks, and 8-bar support (deg2 second phrase when present).
// styleKey overrides which lane's voicing/bass/swing plays it — the progression
// and the style are independent dimensions.
export function generateClassic(id, opts = {}) {
  const c = CLASSICS.find(e => e.id === id);
  if (!c) throw new Error('unknown classic: ' + id);
  const rng = mulberry32(opts.seed ?? ((Math.random() * 1e9) | 0));
  const keyPc = opts.keyPc ?? 7;
  const mode = c.mode;
  const bars = opts.bars === 8 ? 8 : 4;
  const locked = opts.locked || [];
  const laneKey = opts.styleKey || EXT_FAM[c.ext];
  const lane = STYLES[laneKey];
  if (!lane) throw new Error('unknown styleKey: ' + opts.styleKey);

  const chords = [];
  const cb = makeChordBuilder({ keyPc, mode, extTable: lane.ext, rng, vMaj: !!c.vMaj });
  for (let b = 0; b < bars; b++) {
    if (locked[b]) { chords.push(locked[b]); cb.setPrev(locked[b].notes); continue; }
    const phrase = b < 4 ? c.deg : (c.deg2 || c.deg);
    chords.push(cb.build(phrase[b % 4]));
  }
  return {
    style: c.name, styleKey: 'classics', classicId: id, classicFam: c.fam,
    voicingStyle: laneKey, voicingLabel: lane.label,
    keyName: ROOTS[keyPc], keyPc, mode,
    tempo: opts.tempo ?? c.bpm,
    swing: c.swing ? 0.12 : lane.swing,
    bars, chords,
    bassPattern: BASS_PATTERNS[lane.bass],
    bassStyle: lane.bass,
  };
}

export const CLASSIC_FAMS = [...new Set(CLASSICS.map(c => c.fam))];

// ---- EXTRACTED: progressions pulled from real songs (hook2piano) ----
// extChords: [{rootPc, fam ('maj'|'min'), roman, name}] — the harmony is
// fixed, the lane supplies voicing/bass/swing, exactly like CLASSICS.
// The raw extraction is kept on prog.extracted so "play it as" can re-voice
// it through any lane without re-fetching.
export function generateExtracted(extChords, opts = {}) {
  if (!extChords || !extChords.length) throw new Error('generateExtracted: no chords');
  const laneKey = opts.styleKey || 'nimino';
  const lane = STYLES[laneKey];
  if (!lane) throw new Error('unknown styleKey: ' + opts.styleKey);
  const rng = mulberry32(opts.seed ?? ((Math.random() * 1e9) | 0));
  const bars = extChords.length;
  const locked = opts.locked || [];
  const keyPc = opts.keyPc ?? 0;

  const chords = [];
  const cb = makeChordBuilder({ keyPc, mode: 'min', extTable: lane.ext, rng });
  for (let b = 0; b < bars; b++) {
    if (locked[b]) { chords.push(locked[b]); cb.setPrev(locked[b].notes); continue; }
    const ec = extChords[b];
    chords.push(cb.buildFrom(ec.rootPc, ec.fam, ec.roman));
  }
  // display names come from the extraction; voicing names from the lane build
  chords.forEach((ch, i) => { ch.name = extChords[i].name || ch.name; });
  return {
    style: opts.name || 'Extracted', styleKey: 'extracted',
    extracted: extChords,
    extKeyPc: keyPc, extTitle: opts.title || '',
    voicingStyle: laneKey, voicingLabel: lane.label,
    keyName: ROOTS[keyPc], keyPc, mode: opts.mode || 'min',
    tempo: opts.tempo ?? 120,
    swing: lane.swing,
    bars, chords,
    bassPattern: BASS_PATTERNS[lane.bass],
    bassStyle: lane.bass,
  };
}
