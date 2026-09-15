# modbod

Anonymized parametric wireframe body study — a single self-contained page
(`index.html`, no build step, no dependencies beyond the embedded three.js).

- Base mesh: SMPL-X female statistical template, posed to a relaxed T-pose.
  Generic prior, not a scan of anyone.
- Sliders sculpt regions (bust / waist / hips / glute / thigh / height) along
  surface normals.
- Coverage overlay paints per-vertex source-material availability
  (red → yellow → green). Red = statistical prior only.
- Genital detail omitted by design; the mesh stays schematic.

Local build source lives outside this repo. To redeploy: replace `index.html`
with a fresh build and push to `main` — GitHub Pages serves it as-is.
