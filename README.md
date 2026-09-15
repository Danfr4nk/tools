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
