// melody.js — predominant-melody extraction: mono audio -> note list.
// Pure JS, zero imports. Runs in the browser and in Node (for tests).
//
// Method (simplified MELODIA-style salience tracking):
//   1. downsample to 22050 Hz, frame into 2048-sample Hann windows, hop 1024
//   2. per frame: FFT magnitude spectrum
//   3. pitch salience(m) = sum over harmonics h of w_h * peak |X| within
//      +-1 semitone of f0(m)*h (cos^2-weighted), over MIDI 36..96, with a
//      mild lead-band emphasis (melodies live midrange). The tolerance keeps
//      salience intact when the pitch is off the semitone grid (vibrato,
//      slides) instead of reading one rounded bin that the energy missed
//   4. argmax + explaining-away penalty (bass stealing the melody), pitch
//      from salience averaged over +-2 frames near the raw winner, then
//      parabolic interpolation for sub-semitone f0 (vibrato stays continuous
//      instead of becoming a square wave on the MIDI grid)
//   5. voicing via adaptive salience/RMS thresholds + harmonicity gate
//      (the winning pitch must explain a share of the frame's spectrum —
//      broadband percussion/noise fails this and goes unvoiced)
//   6. median smoothing + hysteresis note segmentation (0.6-semitone deadband,
//      2-frame confirmation: vibrato rides through, real steps cut cleanly)
//   7. per-note octave decision: fold an octave-up error down only when the
//      lower octave's own harmonics started with the note (common onset =
//      one source), not when a pad/bass was already sustaining down there
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

// candidate table: for each MIDI and harmonic, a search window of FFT bins.
// Each harmonic contributes its strongest bin within +-1 semitone of the
// ideal frequency, weighted cos^2 by distance (MELODIA-style harmonic
// summation). Reading a single rounded bin instead makes salience collapse
// whenever the pitch sits off the semitone grid — vibrato, slides, detuned
// sources — and at higher harmonics a 50-cent offset is several bins away.
// Low harmonics get at least a +-1-bin window so interpolation still works
// where a semitone is narrower than a bin.
function buildCandidates(sr) {
  const cands = [];
  const binHz = sr / N;
  const SEMI = Math.pow(2, 1 / 12) - 1;
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
      const center = f / binHz;
      const tol = Math.max(1, f * SEMI / binHz); // in bins
      const lo = Math.max(1, Math.ceil(center - tol)), hi = Math.min(N / 2, Math.floor(center + tol));
      const bins = [], gains = [];
      for (let k = lo; k <= hi; k++) {
        const c = Math.cos(0.5 * Math.PI * Math.abs(k - center) / tol);
        bins.push(k); gains.push(c * c);
      }
      harm.push({ w: Math.pow(h, -0.55) * band, bins, gains });
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
  const harm = new Float32Array(nFrames); // harmonic energy fraction of winner

  // Two passes. Pass 1 (heavy): per-frame spectrum, salience, penalized
  // salience, harmonic-energy fractions — stored, no decisions yet.
  // Pass 2 (cheap): median-smooth the penalized salience over +-2 frames
  // BEFORE argmax. This is the vibrato fix at the right level: with a 93ms
  // window and 5-6Hz vibrato, each frame averages half a vibrato cycle, so
  // per-frame pitch decisions are bimodal garbage. Averaging the salience
  // *distributions* recovers a stable peak at the vibrato center; voting on
  // quantized per-frame *decisions* cannot.
  const penAll = new Float64Array(nFrames * nC);
  const harmAll = new Float32Array(nFrames * nC);
  // salience from odd harmonics only (h = 1, 3, 5, 7): the part of a
  // candidate's evidence its octave-up does NOT share. Used by the
  // note-level octave decision below.
  const oddAll = new Float32Array(nFrames * nC);
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
    let totalE = 0;
    for (let k = 0; k <= N / 2; k++) totalE += mag[k] * mag[k];
    const hb = f0idx * nC, invE = 1 / (totalE || 1);
    // salience for every candidate, plus its harmonic energy fraction (for
    // the octave tiebreak and the voicing gate in pass 2): energy in the
    // Hann main lobe (peak bin +-1) of each located harmonic peak
    for (let c = 0; c < nC; c++) {
      const hs = cands[c].harm;
      let s = 0, so = 0, he = 0;
      for (let j = 0; j < hs.length; j++) {
        const { w, bins, gains } = hs[j];
        let best = 0, bk = bins[0];
        for (let q = 0; q < bins.length; q++) {
          const v = gains[q] * mag[bins[q]];
          if (v > best) { best = v; bk = bins[q]; }
        }
        s += w * best;
        if (!(j & 1)) so += w * best;
        if (j < 6) {
          const a = mag[bk - 1], b = mag[bk], d = bk < N / 2 ? mag[bk + 1] : 0;
          he += a * a + b * b + d * d;
        }
      }
      salAll[c] = s;
      oddAll[hb + c] = so;
      harmAll[hb + c] = he * invE;
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
    penAll.set(pen, f0idx * nC);
    if (onProgress && (f0idx % CHUNK === 0)) {
      onProgress(f0idx / nFrames * 0.72);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(0.74);

  // Pass 2: decide pitch per frame from salience averaged over +-2 frames.
  // (232ms covers ~1.3 cycles of 5.5Hz vibrato.) The average must be a MEAN,
  // not a median: with a 93ms window each frame sees half a vibrato cycle,
  // so per-frame pitch estimates are bimodal (dwelling at the vibrato
  // extremes). Averaging the salience *distributions* recovers a symmetric
  // peak at the vibrato center; a median just votes for one extreme.
  // Note the split responsibility: PITCH comes from the averaged salience
  // (vibrato-stable), but VOICING/confidence use the RAW per-frame salience.
  // Averaged salience lets gap frames borrow energy from neighboring lead
  // frames — voicing on it would resurrect gaps as phantom notes with
  // arbitrary interpolated pitches.
  const SM_RAD = 2;
  const penS = new Float64Array(nC);
  const foldVote = new Uint8Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const ro = f * nC;
    // raw winner: "is there a lead here?" (for voicing)
    let rbi = 0;
    for (let c = 1; c < nC; c++) if (penAll[ro + c] > penAll[ro + rbi]) rbi = c;
    const rawBest = penAll[ro + rbi];
    // averaged winner: "which pitch?" (for f0 — vibrato-stable)
    const w0 = Math.max(0, f - SM_RAD), w1 = Math.min(nFrames - 1, f + SM_RAD);
    const nw = w1 - w0 + 1, inv = 1 / nw;
    for (let c = 0; c < nC; c++) {
      let s = 0;
      for (let w = w0; w <= w1; w++) s += penAll[w * nC + c];
      penS[c] = s * inv;
    }
    // The averaged peak is searched only within a semitone of the raw
    // winner: that's all vibrato needs (the raw winner dithers +-1 around
    // the vibrato center), and it stops the +-2-frame average from handing
    // a note boundary to whatever sustained source (pad, drone) was
    // continuous across the window — the lead's new note owns the frame as
    // soon as it wins raw.
    let bi = rbi;
    for (let c = Math.max(0, rbi - 1); c <= Math.min(nC - 1, rbi + 1); c++) if (penS[c] > penS[bi]) bi = c;
    // neighbor-max harmonicity (stable under vibrato dither)
    const hb = f * nC;
    const harmN = (c) => {
      if (c < 0 || c >= nC) return 0;
      const a = c > 0 ? harmAll[hb + c - 1] : 0;
      const b = harmAll[hb + c];
      const d = c < nC - 1 ? harmAll[hb + c + 1] : 0;
      return Math.max(a, b, d);
    };
    // octave evidence: the lower octave's harmonic bins are a superset of
    // the upper's, so it always explains >= as much spectrum. It gets a vote
    // only when it explains clearly MORE (a real fundamental plus odd
    // harmonics is present) — the signature of an octave-up error from a
    // strong 2nd harmonic. The fold itself is decided per NOTE after
    // segmentation (see octave pass below): per frame it flickers, and a
    // single frame can't tell the lead's own fundamental from a pad or bass
    // already sustaining an octave down.
    const fold = bi >= 12 && penS[bi - 12] >= 0.6 * penS[bi] && harmN(bi - 12) > 1.3 * harmN(bi);
    foldVote[f] = fold ? 1 : 0;
    // parabolic interpolation of the salience peak -> sub-semitone f0
    let frac = 0;
    if (bi > 0 && bi < nC - 1) {
      const a = penS[bi - 1], b = penS[bi], cc = penS[bi + 1];
      const denom = a - 2 * b + cc;
      if (denom < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (a - cc) / denom));
    }
    f0[f] = cands[bi].f0 * Math.pow(2, frac / 12);
    sal[f] = rawBest > 0 ? rawBest : 0;
    harm[f] = fold ? harmN(bi - 12) : harmN(bi);
    if (onProgress && (f % CHUNK === 0)) {
      onProgress(0.74 + f / nFrames * 0.11);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(0.87);

  // voicing: adaptive thresholds from p95 of salience & rms, plus a
  // harmonicity gate — the winning pitch must explain a real share of the
  // frame's spectrum. Broadband junk (snare/hat hits, vinyl crackle, noise)
  // can spike salience at a random candidate but explains almost nothing;
  // the gate drops those frames to unvoiced instead of phantom notes.
  // The gate threshold self-calibrates from confident frames, and very
  // strong salience overrides it (a confident pitch is transcribed even
  // through a dense backing).
  const salS = Array.from(sal).sort((a, b) => a - b);
  const rmsS = Array.from(rms).sort((a, b) => a - b);
  const p95sal = percentile(salS, 0.95);
  const salT = 0.22 * p95sal;
  const rmsT = 0.04 * percentile(rmsS, 0.95);
  const confH = [];
  for (let i = 0; i < nFrames; i++) if (sal[i] > 0.5 * p95sal) confH.push(harm[i]);
  confH.sort((a, b) => a - b);
  const harmT = Math.min(0.28, Math.max(0.08,
    0.35 * (confH.length ? confH[confH.length >> 1] : 0.3)));
  const voiced = new Uint8Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    voiced[i] = (sal[i] > salT && rms[i] > rmsT &&
      (harm[i] > harmT || sal[i] > 0.6 * p95sal)) ? 1 : 0;
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

  // hysteresis segmentation on the smoothed continuous pitch track.
  // A note holds until the pitch sits >0.6 semitone from the note's running
  // mean for 2 consecutive frames (~92ms), then cuts cleanly. Vibrato
  // (±a semitone at 5-6Hz) is already attenuated by the median smoother and
  // rides inside the deadband instead of splitting the note; genuine steps
  // and octave jumps cut within ~90ms; slow glides get absorbed into the
  // nearer side instead of spawning intermediate fragment notes.
  const frameDur = HOP / sr;
  // a frame stands for the hop-wide slice around its window CENTER, not its
  // first sample: frame i covers [i*HOP, i*HOP + N], so a run of frames
  // i0..i1 spans [i0*HOP + (N-HOP)/2, (i1+1)*HOP + (N-HOP)/2]. Stamping
  // notes at i*HOP put every onset and offset ~23ms early.
  const tOff = (N - HOP) / 2 / sr;
  const cmidi = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    cmidi[i] = (voiced[i] && !Number.isNaN(sm[i]))
      ? 69 + 12 * Math.log2(sm[i] / 440) : NaN;
  }
  const HYST = 0.6, CONFIRM = 2;
  const MIN_NOTE = 0.09, MERGE_GAP = 0.08;
  const raw = [];
  let cur = null, pend = 0;
  // Octave pass (per note). Fold a note down an octave when most of its
  // frames voted for the lower octave AND that lower octave's own evidence
  // (its odd harmonics) arrived with the note: harmonics that start together
  // belong to one source. If the odd-harmonic energy was already there
  // before the note began, it's a separate sustained source — a pad or bass
  // holding the octave below — and the lead stays where it is.
  // "Before" only counts frames where nothing was tracked, or where the
  // tracked pitch was that lower octave itself. Frames tracking some other
  // note (the previous melody note, legato) are skipped: its partials land
  // in the lower octave's +-1-semitone harmonic windows by coincidence
  // (a fifth above supplies the 3rd harmonic, etc.), which says nothing
  // about a separate source at the octave below.
  const OCT_PRE = 4, OCT_SKIP = 2; // pre-window: 4 frames, ending 2 before onset (window overlap)
  function octaveFold(midi, s, e) {
    const c = midi - MIN_MIDI, lc = c - 12;
    if (lc < 0 || c >= nC) return false;
    let votes = 0;
    for (let k = s; k < e; k++) votes += foldVote[k];
    if (votes * 2 < e - s) return false;
    let during = 0;
    for (let k = s; k < e; k++) during += oddAll[k * nC + lc];
    during /= e - s;
    let pre = 0, np = 0;
    for (let k = Math.max(0, s - OCT_SKIP - OCT_PRE); k < s - OCT_SKIP; k++) {
      if (!Number.isNaN(cmidi[k]) && Math.abs(cmidi[k] - (midi - 12)) > 0.5) continue;
      pre += oddAll[k * nC + lc]; np++;
    }
    return !np || pre / np < 0.5 * during;
  }
  function closeNote(endFrame) {
    const n = endFrame - cur.start;
    const dur = n * frameDur;
    if (dur >= MIN_NOTE && n > 0) {
      let midi = Math.round(cur.sum / cur.n);
      if (octaveFold(midi, cur.start, endFrame)) midi -= 12;
      let ssum = 0;
      for (let k = cur.start; k < endFrame; k++) ssum += sal[k];
      raw.push({
        midi, start: cur.start * frameDur + tOff, dur,
        conf: ssum / n / (p95sal || 1),
      });
    }
    cur = null;
  }
  for (let i = 0; i < nFrames; i++) {
    const m = cmidi[i];
    if (Number.isNaN(m)) { pend = 0; if (cur) closeNote(i); continue; }
    if (!cur) { cur = { sum: m, n: 1, start: i }; continue; }
    if (Math.abs(m - cur.sum / cur.n) > HYST) {
      if (++pend >= CONFIRM) {
        const ns = i - CONFIRM + 1; // new note starts at first deviant frame
        closeNote(ns);
        cur = { sum: 0, n: 0, start: ns };
        for (let k = ns; k <= i; k++) { cur.sum += cmidi[k]; cur.n++; }
        pend = 0;
      }
      // held-out outlier frame: belongs to neither note yet
    } else {
      pend = 0;
      cur.sum += m; cur.n++;
    }
  }
  if (cur) closeNote(nFrames);
  // octave-flicker fragments: a sliver (< ~0.19s) that sits exactly an
  // octave from a longer note it touches is that note's onset/offset
  // transient read at the wrong octave — adopt the neighbor's pitch so the
  // merge below joins them instead of emitting a phantom octave blip.
  const FRAG = 4 * frameDur + 1e-9;
  for (let i = 0; i < raw.length; i++) {
    const nt = raw[i];
    if (nt.dur > FRAG) continue;
    for (const nb of [raw[i - 1], raw[i + 1]]) {
      if (!nb || nb.dur <= nt.dur || Math.abs(nb.midi - nt.midi) !== 12) continue;
      const gap = nb.start > nt.start ? nb.start - (nt.start + nt.dur) : nt.start - (nb.start + nb.dur);
      if (gap < MERGE_GAP) { nt.midi = nb.midi; break; }
    }
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
