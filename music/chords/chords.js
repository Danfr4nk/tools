// chords.js — audio -> chord sequence. Pure JS, zero imports. Runs in the browser and in Node.
//
// Method:
//   1. downsample to 22050 Hz, 2048-sample Hann windows, hop 1024 (same front end as melody.js)
//   2. per frame: magnitude spectrum; harmonic-weighted chroma — per-MIDI salience
//      over 7 harmonics (h^-0.55) folded into 12 pitch classes, MIDI 24..95; frame RMS
//   3. beat tracking: log-spectral-flux onset envelope -> tempo by autocorrelation
//      peak (60-200 BPM, parabolic refinement) -> Ellis-style DP beat grid
//   4. per beat: RMS-weighted mean chroma -> cosine match vs 24 major/minor
//      templates (+ N when the beat is near-silent)
//   5. Viterbi smoothing with a change penalty -> merged chord segments
//
// export: extractChords(monoFloat32, sampleRate, onProgress)
//         -> Promise<{chords, tempo, beats, duration, stats}>
//   chords: [{start, dur, root (0-11, C=0), quality ('maj'|'min'|'N'), name, conf}]

const TARGET_SR = 22050;
const N = 2048;            // FFT size for onset flux (time resolution)
const NC = 8192;           // FFT size for chroma (frequency resolution)
const HOP = 1024;          // hop (~46ms at 22050)
const MIN_MIDI = 24;       // C1
const MAX_MIDI = 95;       // B6
const N_HARM = 7;
const MAX_F = 9000;
const FPS = TARGET_SR / HOP;

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

function downsample(mono, sr) {
  if (Math.abs(sr - TARGET_SR) < 1) return mono;
  const ratio = sr / TARGET_SR;
  const avg = Math.max(1, Math.round(ratio));
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

// chroma candidates: fundamentals + octave/fifth harmonics only (h=1..4, steep
// rolloff). The 5th+ harmonics fold a major 3rd above each note into the chroma
// (B's 5th harmonic reads as Eb) — great for pitch salience, poison for chords.
// Bins are for the NC=8192 chroma FFT (binHzC); the flux FFT (N=2048) can't
// resolve semitones below ~E3, so chroma gets its own long window.
const BINHZ_C = TARGET_SR / NC;
function buildChromaCandidates() {
  const cands = [];
  for (let m = MIN_MIDI; m <= MAX_MIDI; m++) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    const harm = [];
    for (let h = 1; h <= 4; h++) {
      const f = f0 * h;
      if (f > MAX_F) break;
      harm.push([f / BINHZ_C, Math.pow(h, -1.5)]);
    }
    cands.push({ midi: m, pc: m % 12, harm });
  }
  return cands;
}
const CHROMA_CANDS = buildChromaCandidates();

// parabolic-interpolated peak magnitude at a fractional bin, straight from the
// complex spectrum — recovers energy lost when a tone sits between FFT bins,
// without widening the window into neighboring semitones
function peakMagInline(re, im, p) {
  const b = Math.round(p);
  const n2 = re.length >> 1;
  if (b < 1 || b + 1 >= n2) return 0;
  const a = re[b - 1] * re[b - 1] + im[b - 1] * im[b - 1];
  const c = re[b] * re[b] + im[b] * im[b];
  const d = re[b + 1] * re[b + 1] + im[b + 1] * im[b + 1];
  if (c === 0) return 0;
  const denom = a - 2 * c + d;
  if (denom >= 0) return Math.sqrt(c);
  const delta = 0.5 * (a - d) / denom;
  return Math.sqrt(Math.max(0, c - 0.25 * (a - d) * delta));
}

// ---- frame analysis: chroma[12] (raw), rms ----
export function analyzeFrames(x, progress) {
  const nFrames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const chromas = new Array(nFrames);
  const rmss = new Float32Array(nFrames);
  const mags = new Array(nFrames); // 2048-mag per frame, for flux
  const re = new Float64Array(N), im = new Float64Array(N);       // short window (2048)
  const rec = new Float64Array(NC), imc = new Float64Array(NC);   // long window (8192)
  const hannC = hannWindow(NC);
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    // --- short window: rms + flux magnitude ---
    let sumsq = 0;
    for (let i = 0; i < N; i++) {
      const v = (off + i < x.length ? x[off + i] : 0) * HANN[i];
      re[i] = v; im[i] = 0; sumsq += v * v;
    }
    rmss[f] = Math.sqrt(sumsq / N);
    fft(re, im);
    const mag = new Float32Array(N / 2 + 1);
    for (let k = 0; k <= N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    mags[f] = mag;
    // --- long window (centered on the short one): chroma magnitude ---
    const center = off + (N >> 1);
    const coff = center - (NC >> 1);
    for (let i = 0; i < NC; i++) {
      const xi = coff + i;
      rec[i] = (xi >= 0 && xi < x.length ? x[xi] : 0) * hannC[i];
      imc[i] = 0;
    }
    fft(rec, imc);
    const ch = new Float64Array(12);
    for (const c of CHROMA_CANDS) {
      let s = 0;
      for (const [fbin, w] of c.harm) {
        const b = Math.round(fbin);
        if (b < 1 || b + 1 >= NC / 2) continue;
        s += w * peakMagInline(rec, imc, fbin);
      }
      ch[c.pc] += s;
    }
    // sharpen: emphasize peaks, suppress the noise floor
    for (let k = 0; k < 12; k++) ch[k] = Math.pow(ch[k], 1.5);
    chromas[f] = ch;
    if (progress && (f & 511) === 0) progress(f / nFrames);
  }
  return { chromas, rmss, mags, nFrames };
}

// ---- onset envelope: log spectral flux ----
function onsetEnvelope(mags) {
  const T = mags.length, K = mags[0].length;
  const flux = new Float64Array(T);
  const prev = new Float64Array(K);
  for (let t = 0; t < T; t++) {
    const mag = mags[t];
    let s = 0;
    for (let k = 1; k < K; k++) {
      const d = Math.log1p(mag[k]) - Math.log1p(prev[k]);
      if (d > 0) s += d;
      prev[k] = mag[k];
    }
    flux[t] = s;
  }
  // normalize
  let mx = 0;
  for (let t = 0; t < T; t++) if (flux[t] > mx) mx = flux[t];
  if (mx > 0) for (let t = 0; t < T; t++) flux[t] /= mx;
  return flux;
}

// ---- tempo: autocorrelation peak over 60-200 BPM, parabolic refinement ----
function estimateTempo(flux) {
  const T = flux.length;
  const mean = flux.reduce((a, b) => a + b, 0) / T;
  const z = new Float64Array(T);
  for (let t = 0; t < T; t++) z[t] = flux[t] - mean;
  const lagMin = Math.floor(60 * FPS / 200), lagMax = Math.ceil(60 * FPS / 60);
  let bestLag = lagMin, bestV = -Infinity;
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let t = 0; t + lag < T; t++) s += z[t] * z[t + lag];
    ac[lag] = s / (T - lag);
    // prefer the beat level over half/double: mild penalty for very short lags
    const v = ac[lag] * (lag < lagMin * 1.6 ? 0.85 : 1.0);
    // gentle EDM prior: break near-ties toward ~130 BPM (trap's grid is 140s, never 70s)
    const bpmLag = 60 * FPS / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpmLag / 130) / 1.0, 2));
    if (v * prior > bestV) { bestV = v * prior; bestLag = lag; }
  }
  // walk up from half-time: if the half-lag peak is strong, the true beat is faster
  let lag = bestLag;
  while (lag / 2 >= lagMin) {
    const half = Math.round(lag / 2);
    if ((ac[half] || 0) > 0.8 * (ac[lag] || 0)) lag = half;
    else break;
  }
  // parabolic refinement
  const a = ac[lag - 1] || 0, b = ac[lag], c = ac[lag + 1] || 0;
  const denom = (a - 2 * b + c);
  const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
  const lagRef = lag + Math.max(-1, Math.min(1, shift));
  const bpm = 60 * FPS / lagRef;
  return { bpm, period: lagRef };
}

// ---- Ellis-style DP beat tracking ----
function trackBeats(flux, period) {
  const T = flux.length;
  const D = new Float64Array(T).fill(-Infinity);
  const P = new Int32Array(T).fill(-1);
  const lo = Math.max(2, Math.floor(period * 0.45)), hi = Math.ceil(period * 2.2);
  for (let t = 0; t < T; t++) {
    let best = flux[t], bi = -1;
    for (let lag = lo; lag <= hi && lag <= t; lag++) {
      const score = D[t - lag] - Math.pow(Math.log2(lag / period), 2);
      if (score > best) { best = score; bi = t - lag; }
    }
    D[t] = best; P[t] = bi;
  }
  let end = T - 1;
  const from = Math.max(0, T - Math.ceil(period * 3));
  for (let t = from; t < T; t++) if (D[t] > D[end]) end = t;
  const beats = [];
  for (let t = end; t >= 0; t = P[t]) { beats.push(t); if (P[t] < 0) break; }
  beats.reverse();
  // extend the grid to the track edges at the estimated period — onsets anchor
  // phase, but beats are periodic even where the flux goes quiet
  const per = Math.round(period);
  while (beats.length && beats[0] - per >= 0) beats.unshift(beats[0] - per);
  while (beats.length && beats[beats.length - 1] + per < T) beats.push(beats[beats.length - 1] + per);
  return beats;
}

// ---- chord templates ----
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function rot(t, r) { const o = new Array(12).fill(0); for (let i = 0; i < 12; i++) o[(i + r) % 12] = t[i]; return o; }
const MAJ = [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0];
const MIN = [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0];
const TEMPLATES = []; // 24: root*2 + (0=maj,1=min)
for (let r = 0; r < 12; r++) {
  for (const [t, q] of [[MAJ, 'maj'], [MIN, 'min']]) {
    const v = rot(t, r);
    const n = Math.hypot(...v);
    TEMPLATES.push({ root: r, quality: q, name: ROOTS[r] + (q === 'min' ? 'm' : ''), vec: v.map(x => x / n) });
  }
}
const NSTATE = 24; // index 24 = N (no chord)

function norm12(v) {
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

export async function extractChords(mono, sampleRate, onProgress, opts) {
  const debug = opts && opts.debug;
  const rep = p => { if (onProgress) onProgress(p); };
  const x = downsample(mono, sampleRate);
  const duration = x.length / TARGET_SR;
  rep(0.02);

  const { chromas, rmss, mags, nFrames } = analyzeFrames(x, p => rep(0.02 + p * 0.43));
  rep(0.45);

  const flux = onsetEnvelope(mags);
  const { bpm, period } = estimateTempo(flux);
  let beats = trackBeats(flux, period);
  rep(0.6);

  // fallback: rigid grid if DP found almost nothing
  if (beats.length < 4) {
    beats = [];
    for (let t = 0; t < nFrames; t += Math.round(period)) beats.push(t);
  }
  const beatSec = beats.map(b => b / FPS);

  // per-beat mean chroma (RMS-weighted) + beat RMS
  const nB = beats.length;
  const beatChroma = [], beatRms = new Float64Array(nB);
  const medRms = [...rmss].sort((a, b) => a - b)[Math.floor(nFrames / 2)] || 1e-6;
  for (let i = 0; i < nB; i++) {
    const a = beats[i], b = i + 1 < nB ? beats[i + 1] : nFrames;
    const acc = new Float64Array(12);
    let wsum = 0, rsum = 0;
    for (let t = a; t < b && t < nFrames; t++) {
      const w = rmss[t];
      for (let k = 0; k < 12; k++) acc[k] += chromas[t][k] * w;
      wsum += w; rsum += rmss[t];
    }
    beatChroma.push(norm12([...acc.map(v => (wsum > 0 ? v / wsum : v))]));
    beatRms[i] = rsum / Math.max(1, b - a);
  }
  rep(0.75);

  // emission scores: cosine vs templates; N state from silence
  const CHANGE = 0.22;
  const emis = [];
  for (let i = 0; i < nB; i++) {
    const row = new Float64Array(NSTATE + 1);
    const ch = beatChroma[i];
    for (let s = 0; s < NSTATE; s++) {
      const tv = TEMPLATES[s].vec;
      let d = 0;
      for (let k = 0; k < 12; k++) d += ch[k] * tv[k];
      row[s] = d;
    }
    row[NSTATE] = beatRms[i] < 0.18 * medRms ? 0.85 : 0.30;
    emis.push(row);
  }

  // Viterbi
  const S = NSTATE + 1;
  let dp = new Float64Array(emis[0]);
  const bp = [];
  for (let i = 1; i < nB; i++) {
    const ndp = new Float64Array(S).fill(-Infinity);
    const bprow = new Int32Array(S);
    for (let s = 0; s < S; s++) {
      let best = -Infinity, bi = 0;
      for (let p = 0; p < S; p++) {
        const v = dp[p] - (p === s ? 0 : CHANGE) + emis[i][s];
        if (v > best) { best = v; bi = p; }
      }
      ndp[s] = best; bprow[s] = bi;
    }
    dp = ndp; bp.push(bprow);
  }
  let st = 0;
  for (let s = 1; s < S; s++) if (dp[s] > dp[st]) st = s;
  const path = new Int32Array(nB);
  path[nB - 1] = st;
  for (let i = nB - 2; i >= 0; i--) path[i] = bp[i][path[i + 1]];
  rep(0.9);

  // merge runs into segments
  const chords = [];
  let cur = null;
  const confAcc = [];
  function close(endBeat) {
    if (!cur) return;
    const start = beatSec[cur.startBeat];
    const end = endBeat < nB ? beatSec[endBeat] : duration;
    const conf = confAcc.reduce((a, b) => a + b, 0) / Math.max(1, confAcc.length);
    chords.push({
      start, dur: Math.max(0, end - start),
      root: cur.root, quality: cur.quality, name: cur.name,
      conf: Math.round(conf * 100) / 100,
    });
  }
  for (let i = 0; i < nB; i++) {
    const s = path[i];
    const info = s === NSTATE
      ? { root: -1, quality: 'N', name: 'N' }
      : { root: TEMPLATES[s].root, quality: TEMPLATES[s].quality, name: TEMPLATES[s].name };
    const same = cur && cur.root === info.root && cur.quality === info.quality;
    if (!same) { close(i); cur = { ...info, startBeat: i }; confAcc.length = 0; }
    confAcc.push(s === NSTATE ? emis[i][s] : emis[i][s]);
  }
  close(nB);
  rep(1.0);

  let beatDetail = null;
  if (debug) {
    beatDetail = [];
    for (let i = 0; i < nB; i++) {
      const scored = [];
      for (let s = 0; s < NSTATE; s++) scored.push([TEMPLATES[s].name, Math.round(emis[i][s] * 1000) / 1000]);
      scored.sort((a, b) => b[1] - a[1]);
      beatDetail.push({ t: Math.round(beatSec[i] * 100) / 100, top: scored.slice(0, 4), path: path[i] === NSTATE ? 'N' : TEMPLATES[path[i]].name });
    }
  }

  return {
    chords: chords.filter(c => c.dur > 0.05),
    tempo: Math.round(bpm * 10) / 10,
    beats: beatSec,
    duration: Math.round(duration * 100) / 100,
    stats: {
      frames: nFrames, beats: nB,
      chordCount: chords.length,
      voicedBeats: emis.filter((r, i) => path[i] !== NSTATE).length,
    },
    ...(beatDetail ? { beatDetail } : {}),
  };
}
