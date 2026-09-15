# Kinship face-comparison tool

Compares the most prominent face in each of two photos and estimates whether
the two people could be genetically related, returning a similarity score, a
confidence score, and a plain-language verdict.

## Web app

**Live:** https://danfr4nk.github.io/tools/kinship/

`index.html` + `app.js` + `pipeline.js` run the full pipeline in the browser
via ONNX Runtime Web. All inference is local — photos are never uploaded. The
17MB face detector and 1.3MB attribute model are bundled in `models/`; the
174MB recognition model loads from HuggingFace (CORS-verified for this origin).
The browser pipeline is numerically validated against the Python CLI
(cosine within 4e-6, detection boxes within ~0.4px across 13 faces).
Photos are downscaled to 1600px on the longest side before analysis (phone
photos are far larger than the 640px detector / 112px recognition inputs
need) — scores on very large photos may differ slightly from the CLI.

## CLI usage

```bash
~/workspace/face-tag/venv/bin/python ~/workspace/kinship/kinship.py <photo_a> <photo_b>
~/workspace/face-tag/venv/bin/python ~/workspace/kinship/kinship.py a.jpg b.jpg --json
~/workspace/face-tag/venv/bin/python ~/workspace/kinship/kinship.py a.jpg b.jpg --face-a 1 --face-b 0
```

## What the numbers mean

- **cosine similarity** — the angular distance between the two faces' ArcFace
  embeddings. This is the research-backed metric (see below).
- **kinship confidence** — a heuristic 0–1 mapping of that similarity.
  **Not a validated probability.** There is no sibling training cohort behind
  it; it is a transparent logistic curve (center 0.30, slope 11) chosen so the
  ambiguous middle of the score range maps to ~50%.
- **verdict** — bands: ≥0.55 very strong · 0.40–0.55 strong · 0.28–0.40
  moderate · 0.15–0.28 slight · <0.15 none. Scores ≥0.45 trip a same-person
  warning (the local face-tag same-person threshold), because very high
  similarity often means *one individual*, not two relatives.

## Research grounding

1. **Hoskens et al. 2021, PLOS Genetics** — biometric matching of 273 sibling
   pairs on 3D faces. Findings used here: *angular* measures beat distance
   measures, Mahalanobis beat Euclidean — kinship signal is in the *direction*
   of the face vector (deviations from average), not magnitude. Hence cosine
   similarity on L2-normalized embeddings. Also: global-to-local integration
   beat any single matcher, siblings share *some* features not all (~44% of
   pairs in the top 1%) — hence moderate scores are genuinely ambiguous, and
   the verdict bands say so.
2. **Griffin, Journal of Vision** — family resemblance is encoded *relative to
   sex means* in face space. The tool can't do that normalization (needs a
   population cohort), so it flags cross-sex and large age-gap comparisons as
   harder instead of pretending to correct for them.
3. **Sibling familiarity effect (BJOP)** — sibling resemblance is structural
   enough to survive changes in camera/lighting/expression, which is why a
   single photo per person is a defensible (if noisy) input.

## Honest limitations

- 2D photos, not 3D scans; one embedding per face, not segment-wise matching.
- No population reference, so no Mahalanobis normalization and no
  gender-mean-relative encoding — the two strongest ideas in the papers.
- No calibration data: the confidence number is a *resemblance meter*, not a
  kinship test. Do not use for anything consequential.
- All processing is local (face-tag venv, InsightFace buffalo_l). Nothing is
  uploaded anywhere.
