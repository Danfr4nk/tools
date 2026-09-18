# stylometry

Dan's stylometric state-tracking instrument. **Local scripts, not a web tool** —
nothing here is served by GitHub Pages.

- **`v3/`** — the semantic layer: what is being said, fused with v2's style
  read through a 2x2 joint matrix. Stdlib Python; Layer A offline, Layer B on
  triggers only. See `v3/README.md` and `v3/BURNIN-V3.md`.

v1 and v2 live on the Mac at `~/workspace/stylometry/` and are deliberately not
in this repo: v2 must stay byte-identical during v3's burn-in, and the same
rule that protected v1 during v2's burn-in now protects v2.

## Data never lives here

Every artifact with message text or real names — run records, window stores,
the populated entity registry, the label log, audit logs — lives under
`$STYLO_V3_DATA` (default `~/workspace/stylometry/v3`), outside the repo. The
root `.gitignore` is a backstop, not the mechanism. This repo is public.
