# age — visual age estimation

Estimate *apparent* age from a photo. Web app runs 100% in the browser
(Transformers.js, local ONNX inference — nothing is uploaded). Python CLI
uses the same model via HuggingFace transformers.

**Live:** https://danfr4nk.github.io/tools/age/

## How it works

1. Drop in a photo. The app crops the largest detected face
   (native `FaceDetector` API when available, center-square crop otherwise)
   and shows you exactly which region was classified.
2. A Vision Transformer (`ViT-Base`, patch16-224) fine-tuned on FairFace
   age brackets classifies the crop into 9 brackets:
   `0-2, 3-9, 10-19, 20-29, 30-39, 40-49, 50-59, 60-69, 70+`.
3. The headline number is the probability-weighted mean of bracket
   midpoints — treat it as **± one bracket**, not a precise birthday.

Web model: `onnx-community/fairface_age_image_detection-ONNX` (q4f16, ~50MB,
downloaded once from HuggingFace and cached in the browser).
CLI model: `dima806/fairface_age_image_detection` (same weights, PyTorch).

## CLI

```bash
pip install torch transformers Pillow
python age.py photo.jpg
python age.py photo.jpg --json
```

## Research notes: the state of the art (2023–2026)

Visual age estimation has converged on **Vision Transformers**. The
generations, roughly:

- **CNN era (legacy):** DeepFace repurposes VGG-Face with a regression head;
  InsightFace's ArcFace backbone adds a `genderage` head. Fast and tiny,
  but outclassed on accuracy. A 2025 resolution-sensitivity study still
  uses these two as the baseline pair.
- **ViT SOTA — VOLO / MiVOLO (2023–2024):** Kuprashevich & Tolstykh's
  *MiVOLO: Multi-input Transformer for Age and Gender Estimation*
  (arXiv 2307.04616) is the practical state of the art: a VOLO-D1
  transformer taking face *and* body crops, **MAE ≈ 3.65 years** on Lagenda
  (v2, 384px), ~4.2y face-only on IMDB-cleaned. HuggingFace:
  `iitolstykh/mivolo_v2`. A 2025 primate study independently cites VOLO-D1
  as SOTA at MAE 4.2y. Caveat: the authors note ONNX export is
  problematic (`col2im` unsupported) — it's a server/CLI model, not a
  browser model.
- **Swin two-stage (2025):** Qiao et al.'s semantic-attention-guided
  hierarchical network (Swin Transformer, coarse-to-fine) reports SOTA on
  the classic benchmarks — same transformer direction, finer machinery.
- **Deployable ViTs:** `nateraw/vit-age-classifier` and
  `dima806/fairface_age_image_detection` (both ViT-Base fine-tuned on
  FairFace, 9 brackets, ~59% exact-bracket accuracy) are the same
  architectural generation as SOTA, and the latter has an official
  `onnx-community` ONNX conversion — which is why this tool uses it.
  Same family as the best; shippable in a browser.

**Why not MiVOLO here:** it's the lab-grade best, but it needs a YOLO
face+body detector, paired crops, and PyTorch — no clean browser path.
If you want the absolute best number on a local machine, run MiVOLO v2
directly (`iitolstykh/mivolo_v2` via transformers, or the
`mivolo_skill` / `face-profiler` wrappers on GitHub).

## Limitations (read before quoting a number)

- Bracket classifier, not a regressor: resolution is one bracket wide.
- FairFace-trained: carries that dataset's demographic biases; best on
  clear, front-facing, well-lit faces.
- Apparent age ≠ chronological age, and ≠ identity — this tool cannot
  tell you who someone is, only how old the face reads.
- Not for surveillance, not for gating access, not for anything
  involving minors. It's an instrument, not a verdict.
