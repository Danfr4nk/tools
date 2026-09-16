# AUTOPSY — what did it?

A companion game to [MusicTrainer](https://github.com/Danfr4nk/tools/tree/main/musictrainer). MusicTrainer answers *whether* a track makes it. Autopsy answers **what it is about the track** that did it.

## The loop

Per track:
1. **Triage** — skip / like / ★ added (same ladder as MusicTrainer)
2. **Score** — 1–10 slider
3. **WHAT DID IT?** — check-all-that-apply across 16 production/musical/context drivers (drop, sound design, bass weight, vocal-as-texture, set utility…)
4. **KILL ONE** — remove one element and the track dies (identifies the load-bearing element)

## Drivers view

- **Lift ranking**: for each driver, how much more likely a track is to be a keep when you check it, vs your base keep rate. Min 2 checks; early leaders are suspects, not verdicts.
- **Load-bearing ranking**: frequency of KILL ONE picks — what your keeps are built on.

## Interop

Paste a **MusicTrainer week export** and every track arrives with its status + score intact — autopsy the drivers on top of real decisions. Or paste bare Spotify URLs.

## Method notes

- Check-all-that-apply (CATA) beats Likert scales for rapid profiling — tap what grabbed you, skip the rest. Validated in sensory science (untrained raters ≈ trained panels, RV > 0.89).
- The attribute list is anchored on the MUSIC model's three validated dimensions (arousal / valence / depth; Greenberg et al. 2016) with producer-specific items bolted on: drop payoff, bass weight, sound-design novelty, set utility.
- **Machine/human split**: ReccoBeats auto-fills the measurable (tempo room, energy, valence, danceability, vocal-texture density). Your taps are reserved for what machines can't hear: drop *quality*, bass *weight* vs loudness, arrangement cleverness, mix utility.
- The KILL ONE round is an ablation/MaxDiff hybrid — no published music-specific version exists; asking what kills a track is more diagnostic than asking what saves it.
- Vocals are texture, never words (lyric qualifier).
- Static site, no backend, no Spotify API. `localStorage` key `autopsy.v1`.
- Live at https://danfr4nk.github.io/tools/music/track-autopsy/
