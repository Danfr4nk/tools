// progs.js — chord progression generator. Pure JS, zero imports. Browser + Node.
//
// Style packs encode the harmonic fingerprints of Dan's three obsessions:
//   nimino     — lush extended minor chords, melodic house / UK garage swing
//                ("The Back Of Your Hands": Gm-Bb-Eb = i-bIII-bVI; "I Only
//                Smoke When I Drink": B, 127 BPM, dark valence)
//   oskar med k — warm diatonic chill-house, add9/maj9 glow, vi-IV-I-V family
//   LYNY       — dark trap/bass minor, i-bVI-bIII-bVII, sparse voicings,
//                phrygian bII color, half-time 140s
//
// export: generateProgression(styleKey, {keyPc, mode, seed})
//   -> {style, keyName, mode, tempo, chords:[{roman, name, root, quality,
//       notes:[midi], bass}], bassPattern}

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJ_SEMIS = [0, 2, 4, 5, 7, 9, 11];
const MIN_SEMIS = [0, 2, 3, 5, 7, 8, 10];
const MAJ_DEG_Q = { 1: 'maj', 2: 'min', 3: 'min', 4: 'maj', 5: 'maj', 6: 'min' };
const MIN_DEG_Q = { 1: 'min', 3: 'maj', 4: 'min', 5: 'min', 6: 'maj', 7: 'maj' };
const MAJ_ROMAN = { 1: 'I', 2: 'ii', 3: 'iii', 4: 'IV', 5: 'V', 6: 'vi' };
const MIN_ROMAN = { 1: 'i', 3: 'bIII', 4: 'iv', 5: 'v', 6: 'bVI', 7: 'bVII' };

const QUALITY_IV = {
  maj: [0, 4, 7], min: [0, 3, 7],
  maj7: [0, 4, 7, 11], min7: [0, 3, 7, 10],
  maj9: [0, 4, 7, 11, 14], min9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14],
  min11: [0, 3, 7, 10, 14, 17],
};
const QUALITY_SFX = {
  maj: '', min: 'm', maj7: 'maj7', min7: 'm7', maj9: 'maj9', min9: 'm9',
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
      min: [['min9', 0.40], ['min7', 0.30], ['min11', 0.15], ['madd9', 0.15]],
      maj: [['maj9', 0.50], ['maj7', 0.30], ['add9', 0.20]],
    },
  },
  oskar: {
    label: 'oskar med k', mode: 'maj', tempo: 122, swing: 0, bass: 'sustain',
    templates: [
      [6, 4, 1, 5], [1, 5, 6, 4], [1, 4, 6, 5], [4, 1, 5, 6], [1, 6, 3, 7],
    ],
    ext: {
      min: [['min9', 0.40], ['min7', 0.40], ['madd9', 0.20]],
      maj: [['add9', 0.40], ['maj9', 0.30], ['maj7', 0.30]],
    },
  },
  lyny: {
    label: 'LYNY', mode: 'min', tempo: 140, swing: 0, bass: 'sub',
    templates: [
      [1, 6, 3, 7], [1, 1, 6, 7], [1, 7, 6, 7], [1, 6, 7, 7],
      [1, 'b2', 1, 7], [1, 3, 7, 4],
    ],
    ext: {
      min: [['min', 0.35], ['min7', 0.25], ['madd9', 0.25], ['min9', 0.15]],
      maj: [['maj', 0.50], ['add9', 0.50]],
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

// voice-lead: spread chord tones in [48,72], choose the rotation minimizing
// total movement from the previous voicing (common tones hold still)
function voiceChord(pcs, prev) {
  const sorted = [...pcs].sort((a, b) => a - b);
  let best = null, bestScore = Infinity;
  for (let rot = 0; rot < sorted.length; rot++) {
    const order = sorted.map((_, i) => sorted[(rot + i) % sorted.length]);
    const notes = [];
    let m = 48 + ((order[0] - 48) % 12 + 12) % 12;
    if (m < 48) m += 12;
    notes.push(m);
    for (let i = 1; i < order.length; i++) {
      let n = notes[i - 1] + ((order[i] - notes[i - 1]) % 12 + 12) % 12;
      if (n <= notes[i - 1]) n += 12;
      if (n > 76) n -= 12;
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
    if (score < bestScore) { bestScore = score; best = notes; }
  }
  return best;
}

const BASS_PATTERNS = {
  garage: [ // UK-garage bounce: root down low, octave pop on the "and" of 2
    { t: 0.0, oct: 0, d: 1.4 }, { t: 2.5, oct: 1, d: 0.4 }, { t: 3.0, oct: 0, d: 0.9 },
  ],
  sustain: [{ t: 0.0, oct: 0, d: 3.8 }],   // warm held root
  sub: [{ t: 0.0, oct: 0, d: 3.6 }, { t: 3.5, oct: 1, d: 0.4 }], // long sub + pop
};

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
  const template = st.templates[(rng() * st.templates.length) | 0];

  const chords = [];
  let prev = null;
  for (const deg of template) {
    const root = degreePc(deg, keyPc, mode);
    const baseQ = degreeQuality(deg, mode);
    const fam = baseQ === 'min' ? 'min' : 'maj';
    const quality = pickWeighted(rng, st.ext[fam]);
    const iv = QUALITY_IV[quality];
    const pcs = iv.map(s => (root + s) % 12);
    const notes = voiceChord(pcs, prev);
    prev = notes;
    chords.push({
      roman: roman(deg, mode),
      name: ROOTS[root] + QUALITY_SFX[quality],
      root, quality, notes,
      bass: bassMidi(root, 0),
    });
  }

  return {
    style: st.label, styleKey,
    keyName: ROOTS[keyPc], keyPc, mode,
    tempo: opts.tempo ?? st.tempo,
    swing: st.swing,
    chords,
    bassPattern: BASS_PATTERNS[st.bass],
    bassStyle: st.bass,
  };
}

export const STYLE_KEYS = Object.keys(STYLES);
export const STYLE_META = Object.fromEntries(
  Object.entries(STYLES).map(([k, s]) => [k, { label: s.label, mode: s.mode, tempo: s.tempo }])
);
