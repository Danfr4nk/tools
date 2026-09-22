# PROGRESSIONS — chord loops in your lanes

Chord progression generator built on the harmonic fingerprints of the three
artists Dan named: **nimino**, **oskar med k**, **LYNY**.

Live: https://danfr4nk.github.io/tools/music/progressions/

## The lanes

| lane | source material | fingerprints |
|---|---|---|
| nimino | "The Back Of Your Hands" (Gm–Bb–Eb = i–bIII–bVI), "I Only Smoke When I Drink" (B, 127 BPM, dark valence) | lush extended minor chords (m9, m11, madd9), emotional minor keys, UK-garage bass bounce, swing |
| oskar med k | chill/melodic house, emotive soundscapes | warm diatonic vi–IV–I–V family, add9/maj9 glow, sustained soft bass |
| LYNY | bass music, trap/hip-hop + R&B | dark minor i–bVI–bIII–bVII, sparse voicings, phrygian bII color, long sub bass, half-time 140s |

## How it works

`progs.js` (pure JS, zero imports — browser + Node):
1. Pick a 4-chord template of scale degrees from the lane's vocabulary
   (8-bar mode: two phrases, bar 8 forced to a harmonic-minor V turnaround).
2. Assign extensions from the lane's weighted voicing table (e.g. nimino minor → min9 40%).
3. Voice-lead: spread tones in the sweet register (MIDI 52–79), choose the
   inversion minimizing movement from the previous chord — common tones hold
   still, low semitone rubs penalized out (mud guard).
4. Attach the lane's bass pattern (garage 2-step / sustain + fifth swell /
   808-style sub with glide flag).
5. Locks: pass `locked` chord objects to freeze positions across regenerations.

`midi.js`: minimal SMF0 writer (pad + bass + optional 16th arp, tempo meta).
Humanized by default (timing/velocity jitter on bass+arp, seeded, pads stay
grid-locked); `humanize:false` is bit-deterministic.
`app.js`: WebAudio audition — stereo-widened detuned-saw pad through a
sweeping lowpass, sine sub bass (808 glide on the LYNY lane), optional swung
arp with feedback delay, gentle master compressor. Chord locks + 4/8 bar
toggle. Export drops a `.mid` straight into GarageBand or any DAW.

## Test

`node test-progs.mjs` — all 3 lanes × 3 seeds: 4 chords, piano-range notes,
sub-range bass, well-formed names, compact voice-leading, MIDI round-trip
(tempo meta present, note-ons match note-offs); 8-bar turnaround lands on V;
locks survive regeneration; mud guard holds; humanized MIDI round-trips and
unhumanized MIDI is deterministic. Must print ALL PASS.
