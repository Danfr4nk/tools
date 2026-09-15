# Migration notes — attraction-guide → tools (2026-09-15)

Moved every tool from `Danfr4nk/attraction-guide` into `Danfr4nk/tools` under
`attraction/`, preserving internal structure byte-for-byte except where noted.
The old repo is slated for deletion after this lands.

## Secondary check — what was verified

- **All JS parses**: `node --check` clean on all 7 files in `attraction/js/`
  and the inline script of `scenario-rate-alt.html`.
- **Face bank intact**: all 155 entries in `attraction/faces/faces.json`
  resolve to files on disk. Zero missing.
- **Alt instrument data validated** (`scenario-rate-alt.html`, built 2026-09-15):
  78 bases × exactly 12 modifiers each, ≥5 theme spread per base, zero
  duplicate modifiers, all themes from the valid set, baseIdx 0–77 sequential.
  0 issues.
- **Move-safe links**: every internal link across all pages is relative —
  nothing hardcodes the old repo path, so the `tools/attraction/` subdir move
  breaks zero links.
- **localStorage preserved**: keys (`scen_rate_v3`, `attraction-guide-run-v2`,
  etc.) deliberately NOT renamed — storage is per-origin
  (`danfr4nk.github.io`), so saved runs/scores survive the move untouched.

## Changes made during the move

1. `attraction/README.md` — Pages URL updated to
   `https://danfr4nk.github.io/tools/attraction/`.
2. `attraction/test/push-*.py` (4 scripts) — `REPO` retargeted to
   `Danfr4nk/tools`, tree paths prefixed with `attraction/` via new `PREFIX`
   constant. All four still parse.
3. Root `README.md` + minimal `index.html` — placeholder until the real
   splash page is built (paused per Dan, 2026-09-15).

## Improvements flagged — not yet made

- **Branding**: pages still title themselves "attraction-guide". Fine as a
  product name, but if the suite gets renamed, titles/headers in
  `game.html`, `body-metrics.html`, `frame-describe.html`, `index.html`
  need a pass.
- **`attraction/index.html` is the suite hub** — the future tools splash
  should deep-link its instrument cards, not just the folder.
- **Old version archives** (`scenario-v1..v5.html`, `scenario-rate-v1/v2.html`)
  are frozen snapshots; they reference no shared assets, so they're safe —
  but any future shared-asset refactor must keep them self-contained.
- **`alt-build/`** is authoring scaffolding (spec + modifier batches), not a
  deployed tool. Kept for provenance; candidate for `attraction/dev/` or
  removal once the alt instrument is final.
- **Drift-harness baselines** (`test/drift-harness/baseline-2026-09-11/`)
  pin old JS copies for regression diffing — unaffected by the move, but
  remember they exist before any `js/` refactor.
