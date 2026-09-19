# CHORDS — audio → chord chart

The harmonic sibling of [MELODY](../melody/). Upload a finished song; it finds the
tempo, tracks the beats, and names the chord on each one — drawn as a tap-to-hear
timeline. Runs 100% on device (Web Audio decode + pure-JS DSP), nothing uploaded.

Live: https://danfr4nk.github.io/tools/music/chords/

## Method (`chords.js`, pure JS, zero imports — browser + Node)

1. Downsample to 22050 Hz. Two STFTs per frame (hop 1024):
   - **flux STFT** (N=2048): log-spectral-flux onset envelope
   - **chroma STFT** (N=8192, centered): harmonic-weighted chroma — per-MIDI
     salience over harmonics 1–4 (h^-1.5 rolloff, parabolic-interpolated peak
     magnitudes), folded into 12 pitch classes, sharpened (^1.5).
     The long window is load-bearing: a 2048 FFT can't resolve semitones below
     ~E3, so low-voiced chords smear into a flat chroma.
2. **Tempo**: autocorrelation of the onset envelope over 60–200 BPM, parabolic
   refinement, half-time walk-up + gentle ~130 BPM prior (EDM bias).
3. **Beats**: Ellis-style dynamic-programming beat grid, extended to the track
   edges at the estimated period.
4. **Chords**: RMS-weighted mean chroma per beat → cosine match vs 24 major/minor
   triad templates (+ N when the beat is near-silent) → Viterbi smoothing with a
   change penalty → merged segments.
5. Output: `{chords: [{start, dur, root, quality, name, conf}], tempo, beats,
   duration, stats}`.

## Test

`node test-chords.mjs` — synthetic I–V–vi–IV (C G Am F), 2 beats each @120 BPM
with four-on-the-floor kicks. Must print `PASS: exact match`.

## Known v1 limits

- Triads only — 7th/extended chords get rounded to the nearest triad (F#maj7 may
  read as F# or F depending on which chord tone shouts loudest).
- Predominant harmony wins: if the bass and the stab disagree, the louder one wins.
- Beat tracker assumes roughly steady tempo; rubato and half-time drops confuse it.
