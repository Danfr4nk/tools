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
- **`kinship/`** — face-comparison CLI (InsightFace `buffalo_l` ArcFace
  embeddings + cosine similarity → resemblance verdict + heuristic
  confidence). Local Python script, not a web app: needs the
  `~/workspace/face-tag/venv` environment. The confidence is an uncalibrated
  heuristic — a resemblance meter, not a kinship test.
- **`age/`** — visual age estimation. Web app runs a Vision Transformer
  age-bracket classifier fully in-browser (Transformers.js, local ONNX —
  nothing uploaded); Python CLI (`age.py`) uses the same model via
  HuggingFace transformers. See `age/README.md` for the SOTA research notes.
- **`stylometry/`** — stylometric state-tracking instrument. `v3/` is the
  semantic layer: what is being said, fused with v2's style read through a 2x2
  joint matrix. Local stdlib Python, not a web app — Layer A runs offline in a
  30-minute loop, Layer B calls the Claude API on triggers only. All data
  (message text, entity names, run records) lives outside this repo under
  `$STYLO_V3_DATA`. See `stylometry/v3/BURNIN-V3.md`.
- **`workbench/`** — one photo in, every instrument out. Shared SCRFD face
  detection fans out to age estimation, facial telemetry, and kinship
  comparison in a single pass (reuses `kinship/`'s pipeline + models,
  `age/`'s classifier, `attraction/`'s telemetry), with one unified report
  and JSON export. All on-device.

## Adding a tool

1. Create `<tool-name>/` with a `README.md` explaining what it is and how to run it.
2. Keep it static if it can be static. If it needs a backend, say so in the README.
3. Link it from the splash page (`index.html`).

## Tests

`./run-tests.sh` runs every suite in the repo (JS `*.test.js` / `test-*.mjs`
files are picked up automatically; Python suites are listed in the script) and
exits non-zero if any fail. `./run-tests.sh melody` runs just the matching
ones. Needs only `node` + `python3`. CI runs the same script on every push and
PR (`.github/workflows/tests.yml`).

When adding a tool with tests, name them `*.test.js` or `test-*.mjs` so the
runner finds them, or add a line to `run-tests.sh` for anything else.

## Deploy

GitHub Pages serves this repo from `main` at
https://danfr4nk.github.io/tools/ — every tool is reachable at
`https://danfr4nk.github.io/tools/<tool-name>/`.

Note: localStorage is per-origin, so tools moved here from elsewhere on
`danfr4nk.github.io` keep their saved data as long as their storage keys are
unchanged. Do not rename a tool's localStorage keys on move.
