# PROGRESSIONS — chord loops in your lanes

Chord progression generator built on the harmonic fingerprints of the three
artists Dan named: **nimino**, **oskar med k**, **LYNY** — plus a CLASSICS
library of 59 named progressions (pop canon, house, garage, dnb/halftime,
techno, soul/jazz, lo-fi, modal, global, hip-hop/R&B).

Voicings stay simple on purpose: major/minor triads, occasional 7ths.

Live: https://danfr4nk.github.io/tools/music/progressions/

## The lanes

| lane | source material | fingerprints |
|---|---|---|
| nimino | "The Back Of Your Hands" (Gm–Bb–Eb = i–bIII–bVI), "I Only Smoke When I Drink" (B, 127 BPM, dark valence) | emotional minor keys, UK-garage bass bounce, swing |
| oskar med k | chill/melodic house, emotive soundscapes | warm diatonic vi–IV–I–V family, sustained soft bass |
| LYNY | bass music, trap/hip-hop + R&B | dark minor i–bVI–bIII–bVII, sparse voicings, phrygian bII color, long sub bass, half-time 140s |
| CLASSICS | the canon: Sensitive Female, Canon, Levels, Andalusian, Boom-Bap, Dembow… | 59 fixed progressions, playable "as" any of the three lanes |

## How it works

`progs.js` (pure JS, zero imports — browser + Node):
1. Pick a 4-chord template of scale degrees — from the lane's vocabulary,
   or a fixed classic (numbers = diatonic, strings = chromatic: "b2",
   "b7", "3M", "4m").
2. Voice it as a triad or 7th from the lane's table (8-bar mode: two
   phrases, bar 8 lifts to a V turnaround in the artist lanes; classics
   with a second phrase use it instead).
3. Voice-lead: spread tones in the sweet register (MIDI 52–79), choose the
   inversion minimizing movement from the previous chord — common tones hold
   still, low semitone rubs penalized out (mud guard).
4. Attach the lane's bass pattern (garage 2-step / sustain + fifth swell /
   808-style sub / house pump / techno 16th roll / halftime).
5. Locks: pass `locked` chord objects to freeze positions across
   regenerations. Classics can be played "as" any lane — progression and
   style are independent.

`midi.js`: minimal SMF0 writer (pad + bass + optional 16th arp, tempo meta).
Humanized by default (timing/velocity jitter on bass+arp, seeded, pads stay
grid-locked); `humanize:false` is bit-deterministic.
`app.js`: WebAudio audition — stereo-widened detuned-saw pad through a
sweeping lowpass, sine sub bass (808 glide on the LYNY lane), optional swung
arp with feedback delay, gentle master compressor. Chord locks + 4/8 bar
toggle. **Back track**: the 🥁 drums button loops a grid-locked 4-bar pocket
of the "Sun Goes Down" drums stem under the audition (measured 128 BPM —
enabling snaps tempo there); the loop follows the tempo slider live and
re-anchors every 4 bars so it can't drift. Export drops
a `.mid` straight into GarageBand or any DAW.

## Test

`node test-progs.mjs` — all 3 lanes × 3 seeds: 4 chords, piano-range notes,
sub-range bass, triad/7th-only names, compact voice-leading, MIDI round-trip
(tempo meta present, note-ons match note-offs); 8-bar turnaround lands on V;
locks survive regeneration; mud guard holds; humanized MIDI round-trips and
unhumanized MIDI is deterministic; all 59 classics validate in 4- and 8-bar;
style switching keeps the progression while swapping the lane flavor.
Must print ALL PASS.
