// melody.js — predominant-melody extraction: mono audio -> note list.
// Pure JS, zero imports. Runs in the browser and in Node (for tests).
//
// Method (simplified MELODIA-style salience tracking):
//   1. downsample to 22050 Hz, frame into 2048-sample Hann windows, hop 1024
//   2. per frame: FFT magnitude spectrum
//   3. pitch salience(m) = sum over harmonics h of w_h * |X(bin(f0(m)*h))|
//      over MIDI 36..96, with a mild lead-band emphasis (melodies live midrange)
//   4. argmax + octave-down preference (kills octave-up errors)
//   5. voicing via adaptive salience/RMS thresholds
//   6. median smoothing + note segmentation (quantize, min-duration, gap-merge)
//
// export: extractMelody(monoFloat32, sampleRate, onProgress) -> Promise<{notes, duration, stats}>

const TARGET_SR = 22050;
const N = 2048;          // FFT size
const HOP = 1024;        // hop (~46ms at 22050)
const MIN_MIDI = 36;     // C2
const MAX_MIDI = 96;     // C7
const N_HARM = 7;
const MAX_F = 9000;

// ---- FFT (iterative radix-2, in place) ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = i + j + half;
        const vr = re[b] * cwr - im[b] * cwi;
        const vi = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr;        im[a] += vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = nwr;
      }
    }
  }
}

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / n));
  return w;
}
const HANN = hannWindow(N);

// candidate table: for each MIDI, list of [bin, weight]
function buildCandidates(sr) {
  const cands = [];
  const binHz = sr / N;
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    // lead-band emphasis: melodies live ~150Hz-2.5kHz; de-weight bass rumble & fizz
    let band = 1.0;
    if (f0 < 110) band = 0.55;
    else if (f0 < 150) band = 0.8;
    else if (f0 > 3000) band = 0.7;
    const harm = [];
    for (let h = 1; h <= N_HARM; h++) {
      const f = f0 * h;
      if (f > MAX_F) break;
      harm.push([Math.round(f / binHz), Math.pow(h, -0.55) * band]);
    }
    cands.push({ midi: m, f0, harm });
  }
  return cands;
}

function downsample(mono, sr) {
  if (Math.abs(sr - TARGET_SR) < 1) return mono;
  const ratio = sr / TARGET_SR;
  const avg = Math.max(1, Math.round(ratio)); // crude anti-alias boxcar
  const len = Math.floor(mono.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const c = Math.floor(i * ratio);
    let s = 0, k = 0;
    for (let j = c - ((avg - 1) >> 1); j <= c + (avg >> 1); j++) {
      if (j >= 0 && j < mono.length) { s += mono[j]; k++; }
    }
    out[i] = k ? s / k : 0;
  }
  return out;
}

// Equal-loudness-ish spectral weighting: crush sub-bass (kick drums live here),
// ramp up through the low mids, gentle presence lift. Precomputed per bin.
// This is the standard melody-extraction pre-emphasis (cf. MELODIA's
// equal-loudness filter): it collapses kick-drum pitch sweeps while leaving
// lead harmonics intact.
const EQ_POINTS = [ // [freq Hz, weight]
  [30, 0.03], [60, 0.15], [100, 0.45], [150, 0.75],
  [250, 0.95], [800, 1.0], [3000, 1.05], [6000, 0.9], [9000, 0.7],
];
function buildEqWeights(sr) {
  const w = new Float32Array(N / 2 + 1);
  const binHz = sr / N;
  let p = 0;
  for (let k = 0; k <= N / 2; k++) {
    const f = k * binHz;
    while (p < EQ_POINTS.length - 2 && f > EQ_POINTS[p + 1][0]) p++;
    const [f0, w0] = EQ_POINTS[p], [f1, w1] = EQ_POINTS[p + 1];
    const t = Math.min(1, Math.max(0,
      (Math.log(Math.max(f, 1)) - Math.log(f0)) / (Math.log(f1) - Math.log(f0))));
    w[k] = w0 + (w1 - w0) * t;
  }
  return w;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i];
}

// median filter over voiced f0s only (Float32Array, NaN = unvoiced)
function medianSmooth(f0, radius) {
  const n = f0.length, out = new Float32Array(n).fill(NaN);
  const buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      if (!Number.isNaN(f0[j])) buf.push(f0[j]);
    }
    if (buf.length) {
      buf.sort((a, b) => a - b);
      out[i] = buf[buf.length >> 1];
    }
  }
  return out;
}

export async function extractMelody(mono, sampleRate, onProgress) {
  const x = downsample(mono, sampleRate);
  const sr = TARGET_SR;
  const EQW = buildEqWeights(sr);
  const nFrames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const cands = buildCandidates(sr);
  const nC = cands.length;

  const re = new Float32Array(N), im = new Float32Array(N);
  const mag = new Float32Array(N / 2 + 1);
  const salAll = new Float64Array(nC);
  const salPen = new Float64Array(nC);
  const REL_OFFS = [7, 12, 19, 24, 31, 36]; // fifths & octaves above
  const f0 = new Float32Array(nFrames).fill(NaN);
  const sal = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);

  const CHUNK = 256;
  for (let f0idx = 0; f0idx < nFrames; f0idx++) {
    const off = f0idx * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = x[off + i] * HANN[i];
      re[i] = v; im[i] = 0;
      e += v * v;
    }
    rms[f0idx] = Math.sqrt(e / N);
    fft(re, im);
    for (let k = 0; k <= N / 2; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N * EQW[k];
    }
    // salience for every candidate
    for (let c = 0; c < nC; c++) {
      const h = cands[c].harm;
      let s = 0;
      for (let j = 0; j < h.length; j++) s += h[j][1] * mag[h[j][0]];
      salAll[c] = s;
    }
    // Pass A — "explaining away": a lower candidate whose harmonics coincide
    // with a strong higher candidate is probably stealing its energy
    // (the classic bass-steals-the-melody failure). Penalize each candidate
    // by the strongest harmonically-related candidate above it
    // (octaves and fifths).
    const pen = salPen; // reused buffer
    for (let c = nC - 1; c >= 0; c--) {
      let mx = 0;
      for (let o = 0; o < REL_OFFS.length; o++) {
        const d = c + REL_OFFS[o];
        if (d < nC && salAll[d] > mx) mx = salAll[d];
      }
      pen[c] = salAll[c] - 0.85 * mx;
    }
    let bi = 0;
    for (let c = 1; c < nC; c++) if (pen[c] > pen[bi]) bi = c;
    // single octave-down check on penalized salience: if the octave below
    // the winner is nearly as strong on its own merits, the winner was an
    // octave-up error (strong 2nd harmonic) — take the lower.
    if (bi >= 12 && pen[bi - 12] >= 0.55 * pen[bi]) bi -= 12;
    const bestPen = pen[bi];
    f0[f0idx] = cands[bi].f0;
    sal[f0idx] = bestPen > 0 ? bestPen : 0;
    if (onProgress && (f0idx % CHUNK === 0)) {
      onProgress(f0idx / nFrames * 0.85);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(0.87);

  // voicing: adaptive thresholds from p95 of salience & rms
  const salS = Array.from(sal).sort((a, b) => a - b);
  const rmsS = Array.from(rms).sort((a, b) => a - b);
  const salT = 0.22 * percentile(salS, 0.95);
  const rmsT = 0.04 * percentile(rmsS, 0.95);
  const voiced = new Uint8Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    voiced[i] = (sal[i] > salT && rms[i] > rmsT) ? 1 : 0;
  }

  // drop voiced blips shorter than ~115ms
  const MIN_VOICED_FRAMES = 3;
  for (let i = 0; i < nFrames;) {
    if (!voiced[i]) { i++; continue; }
    let j = i;
    while (j < nFrames && voiced[j]) j++;
    if (j - i < MIN_VOICED_FRAMES) voiced.fill(0, i, j);
    i = j;
  }

  // smooth f0 over voiced frames
  const f0s = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) f0s[i] = voiced[i] ? f0[i] : NaN;
  const sm = medianSmooth(f0s, 3);
  if (onProgress) onProgress(0.92);

  // quantize + segment into notes
  const frameDur = HOP / sr;
  const midiOf = new Int16Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    midiOf[i] = voiced[i] && !Number.isNaN(sm[i])
      ? Math.round(69 + 12 * Math.log2(sm[i] / 440))
      : -1;
  }
  const MIN_NOTE = 0.09, MERGE_GAP = 0.08;
  const raw = [];
  for (let i = 0; i < nFrames;) {
    if (midiOf[i] < 0) { i++; continue; }
    let j = i;
    while (j < nFrames && midiOf[j] === midiOf[i]) j++;
    const start = i * frameDur, dur = (j - i) * frameDur;
    if (dur >= MIN_NOTE) {
      // confidence = mean normalized salience
      let ssum = 0;
      for (let k = i; k < j; k++) ssum += sal[k];
      raw.push({ midi: midiOf[i], start, dur, conf: ssum / (j - i) / (percentile(salS, 0.95) || 1) });
    }
    i = j;
  }
  // merge same-pitch notes separated by tiny gaps
  const notes = [];
  for (const nt of raw) {
    const prev = notes[notes.length - 1];
    if (prev && prev.midi === nt.midi && nt.start - (prev.start + prev.dur) < MERGE_GAP) {
      prev.dur = (nt.start + nt.dur) - prev.start;
      prev.conf = (prev.conf + nt.conf) / 2;
    } else notes.push({ ...nt });
  }
  if (onProgress) onProgress(1);

  const duration = x.length / sr;
  return {
    notes,
    duration,
    stats: {
      frames: nFrames,
      voicedRatio: voiced.reduce((a, b) => a + b, 0) / Math.max(1, nFrames),
      noteCount: notes.length,
    },
  };
}
