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

## The site

The root page (`index.html` + `assets/`) is a shell around the instruments —
it renders them, it never runs them. No instrument imports anything from
`assets/`, so the site can be rebuilt without touching a single tool.

- **`assets/registry.js`** — the single source of truth. Every instrument, its
  deep links, what it downloads, whether it needs the network, and which
  `localStorage` keys it owns. The rack, the filters, the command palette, the
  reuse map and the vault all read from this one file.
- **`assets/cards.js`** — the shared card renderer (root rack + category hubs).
- **`assets/vault.js`** — reads local state, builds and restores backups.
- **`assets/map.js`** — the reuse map: the real dependency graph, so you can see
  what shares a model before tapping a 174 MB instrument on a tether.
- **`assets/app.js`** — rack, filters, palette, drawers, keyboard.
- **`assets/site.css`** — dark by default (every instrument is), with a
  high-contrast DAYLIGHT mode for reading a phone outdoors.

No web fonts, no CDN, no analytics, and deliberately **no service worker** —
caching this origin could hand an instrument a stale model or script, and a
broken instrument is worse than a page that loads a beat slower.

### The vault

Every instrument stores its state in `localStorage`, which is per-origin: one
"clear site data" wipes a year of scored weeks. The vault (press `v`) lists
every key with a plain-English summary, and round-trips the whole lot through
one `tools_vault/v1` backup file. It carries values as the raw strings the
tools wrote — nothing is reshaped — and writes only on an explicit confirmed
restore, offering a copy of the current state first.

`fd_apiKey` (the frame-describe vision key) is flagged as a secret: its value
is never rendered on the page and is left out of backups unless you tick the
box.

## Adding a tool

1. Create `<tool-name>/` with a `README.md` explaining what it is and how to run it.
2. Keep it static if it can be static. If it needs a backend, say so in the README.
3. Add an entry to `assets/registry.js` — that is what puts it on the splash
   page, in the search palette and on the reuse map. If it saves anything,
   register its `localStorage` keys in `STORAGE` too, so the vault can back
   them up.

## Deploy

GitHub Pages serves this repo from `main` at
https://danfr4nk.github.io/tools/ — every tool is reachable at
`https://danfr4nk.github.io/tools/<tool-name>/`.

Note: localStorage is per-origin, so tools moved here from elsewhere on
`danfr4nk.github.io` keep their saved data as long as their storage keys are
unchanged. Do not rename a tool's localStorage keys on move — the vault reads
them under exactly the names the instruments write, and a rename orphans
saved runs.
