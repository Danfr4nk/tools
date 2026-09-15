# tools

Dan's tool collection — diagnostics, instruments, and utilities. Static-first:
every tool here runs as a static site (GitHub Pages) or a local script. No
backends, no build steps.

## Layout

Each tool lives in its own directory with its own README:

- **`attraction/`** — the facial-preference / psychosexual instrument suite,
  moved here from `Danfr4nk/attraction-guide` (2026-09-15). A/B face-preference
  diagnostic, scenario telemetry + scenario ratings, face book, frame-describe
  lexicon tool, body metrics, telemetry lab. See `attraction/README.md`.
- **`musictrainer/`** — the weekly taste-experiment scorecard (Discover Weekly +
  Release Radar), moved here from `Danfr4nk/MusicTrainer` (2026-09-15). Score
  slider 1–10, skip/like, ADDED? yes/no, prediction lock, week JSON export.
- **`track-autopsy/`** — dissects WHAT drives a track's liking (companion to
  MusicTrainer), moved here from `Danfr4nk/track-autopsy` (2026-09-15). 16
  driver check-all-that-apply + load-bearing-element pick per track.
- **`hook2piano/`** — TheoryTab → printable grand-staff piano score (Python
  engine + Pyodide web app), moved here from `Danfr4nk/hook2piano`
  (2026-09-15).
- **`modbod/`** — body-spec / wireframe proportion studies, moved here from
  `Danfr4nk/modbod` (2026-09-15).

## Adding a tool

1. Create `<tool-name>/` with a `README.md` explaining what it is and how to run it.
2. Keep it static if it can be static. If it needs a backend, say so in the README.
3. Link it from the splash page (`index.html`).

## Deploy

GitHub Pages serves this repo from `main` at
https://danfr4nk.github.io/tools/ — every tool is reachable at
`https://danfr4nk.github.io/tools/<tool-name>/`.

Note: localStorage is per-origin, so tools moved here from elsewhere on
`danfr4nk.github.io` keep their saved data as long as their storage keys are
unchanged. Do not rename a tool's localStorage keys on move.
