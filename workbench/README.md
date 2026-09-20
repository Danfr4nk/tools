# workbench

**Live:** https://danfr4nk.github.io/tools/workbench/

One photo in, every instrument out. Upload a single photo and shared face detection
(SCRFD, buffalo_l) fans out to all instruments in one pass — no re-uploading, no
re-cropping per tool:

- **Age estimation** — ViT-Base bracket classifier (expected age + full distribution),
  with the kinship pipeline's genderage regression as a second opinion.
- **Facial telemetry** — the same 17-ratio MediaPipe FaceLandmarker vector the
  attraction lab uses (w:h, jaw:cheek, canthal tilt, gonial angle, asymmetry…).
- **Kinship** — pick face A and face B in the same photo; ArcFace cosine similarity
  with the heuristic confidence calibration.
- **Body telemetry** — MediaPipe PoseLandmarker stick figure + the 16 body ratios
  from the body-metrics lab (9 segment lengths, 7 scale-invariant ratios). Runs
  without a face; needs shoulders-through-ankles in frame for the full ratio set,
  but the stick figure draws from whatever landmarks are visible.
- **Breast telemetry** — as before, plus a **body-pose cross-check**: the nipple
  seed is validated against the pose skeleton (below the shoulder line, inside
  the torso band, clear of the hands — the hand-lock misfire class). A hard
  failure refuses the read outright instead of shipping a verdict; the check
  runs even when the body instrument is toggled off, and its PASS/WARN detail
  rides on the breast card (and in the exported JSON as `body_cross_check`).

Pick subject A with the face chips; if the photo has 2+ faces, choose a kinship
target B from the dropdown. Toggle instruments on/off, hit run, get one unified
report — exportable as JSON, and re-importable later (the import card accepts a
workbench report JSON or a breast_telemetry/v1 JSON, from file or pasted text —
no photo needed).

## How it reuses the other tools

No model is downloaded twice. The workbench loads code and model files from its
siblings by relative path:

| piece | source |
|---|---|
| face detection + alignment + ArcFace + genderage | `../kinship/pipeline.js`, `../kinship/models/` |
| age classifier config (labels, midpoints) | `../age/` (same HF model id) |
| telemetry ratios | `../attraction/js/measure.js` |
| pose skeleton + body ratios | `../attraction/js/body.js` (pose_landmarker_lite, lazy — only when body/breast instruments run) |
| breast landmark cross-check | `poseCrossCheck` in `../attraction/js/breast.js` |

First run downloads ~250 MB total (detector 17 MB, ArcFace 174 MB, age ViT 50 MB,
landmarker ~5 MB); everything is cached by the browser afterwards. All inference
is on-device — the photo never leaves the page.

## Files

- `index.html` — UI shell (import map for MediaPipe, ort + kinship pipeline scripts)
- `app.js` — orchestrator: intake → detection → instruments → unified report → JSON export
