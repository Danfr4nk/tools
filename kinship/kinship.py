#!/usr/bin/env python3
"""Kinship face-comparison tool (research-grounded heuristic).

Compares the most prominent face in each of two photos and estimates
whether the two people could be genetically related, with a confidence
score.

Usage:
    kinship.py <photo_a> <photo_b> [--json]
    kinship.py <photo_a> <photo_b> --face-a 1 --face-b 0   # pick which detected face

Research grounding (what the tool takes from the literature):
  * Hoskens et al. 2021, PLOS Genetics ("3D facial phenotyping by biometric
    sibling matching"): in sibling matching, ANGULAR measures (Mahalanobis
    angle) beat distance measures, and Mahalanobis beat Euclidean. Kinship
    signal lives in the DIRECTION of the face vector (deviations from the
    average face), not its magnitude. This tool therefore uses COSINE
    SIMILARITY (a pure angular measure) on L2-normalized ArcFace embeddings.
  * Same paper: global-to-local integration beat every single matcher, and
    siblings share SOME features, not all (only ~44% of pairs matched in the
    top 1%). The verdict bands below reflect that partial-overlap reality --
    moderate scores are genuinely ambiguous.
  * Griffin, Journal of Vision ("Relative faces"): family resemblance is
    judged relative to sex/age norms, so cross-sex or large age-gap
    comparisons are intrinsically harder. The tool flags these as caveats;
    it does not attempt the paper's gender-mean normalization (that needs a
    population reference cohort we don't have).
  * The paper notes a "face-to-face" classifier could output P(sibling pair |
    similarity). We have NO sibling training cohort, so our "confidence" is
    a TRANSPARENT HEURISTIC mapping, not a validated probability. It is a
    resemblance meter, not a kinship test.

Method: InsightFace buffalo_l (ArcFace R100, 512-d), same backbone as the
local face-tag system. Largest sufficiently-confident face per image.
"""
import sys, os, math, json, argparse

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.expanduser("~"), "workspace", "face-tag"))
from enroll import get_face_app, cos  # noqa: E402  (reuses the local face-tag pipeline)

# --- heuristic calibration (transparent, NOT learned from sibling data) ---
# ArcFace cosine: unrelated pairs center ~0.0-0.15, same-person typically
# >0.45 (local face-tag threshold). Siblings live in between, overlapping
# both. Logistic centered at 0.30 maps that overlap zone to ~50%.
LOGIT_CENTER = 0.30
LOGIT_SLOPE = 11.0
SAME_PERSON_HINT = 0.45  # face-tag's own same-person threshold

VERDICTS = [
    (0.55, "very strong resemblance",
     "At this level it may be the same person (or identical twins) rather than two siblings."),
    (0.40, "strong resemblance",
     "Consistent with close kinship -- or the same person photographed years apart."),
    (0.28, "moderate resemblance",
     "Weak-to-moderate evidence. Many unrelated lookalikes score in this range."),
    (0.15, "slight resemblance",
     "Little evidence of kinship either way."),
    (-1.0, "no meaningful resemblance",
     "No evidence of kinship from facial similarity."),
]


def confidence(s):
    try:
        return 1.0 / (1.0 + math.exp(-LOGIT_SLOPE * (s - LOGIT_CENTER)))
    except OverflowError:
        return 1.0 if s > LOGIT_CENTER else 0.0


def verdict(s):
    for floor, label, note in VERDICTS:
        if s >= floor:
            return label, note
    return VERDICTS[-1][1], VERDICTS[-1][2]


def pick_face(app, path):
    import cv2
    img = cv2.imread(path)
    if img is None:
        return None, f"unreadable file: {path}"
    faces = [f for f in app.get(img) if f.det_score >= 0.5]
    if not faces:
        return None, f"no face detected (det_score >= 0.5): {path}"
    faces.sort(key=lambda f: -((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])))
    return img, faces


def main():
    ap = argparse.ArgumentParser(description="Compare two faces for possible kinship.")
    ap.add_argument("photo_a")
    ap.add_argument("photo_b")
    ap.add_argument("--face-a", type=int, default=0, help="which detected face in A (0=largest)")
    ap.add_argument("--face-b", type=int, default=0, help="which detected face in B (0=largest)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    app = get_face_app()
    _, fa = pick_face(app, args.photo_a)
    _, fb = pick_face(app, args.photo_b)
    if isinstance(fa, str):
        print(f"ERROR: {fa}", file=sys.stderr); sys.exit(2)
    if isinstance(fb, str):
        print(f"ERROR: {fb}", file=sys.stderr); sys.exit(2)
    if args.face_a >= len(fa) or args.face_b >= len(fb):
        print(f"ERROR: face index out of range (A has {len(fa)}, B has {len(fb)})",
              file=sys.stderr); sys.exit(2)
    A, B = fa[args.face_a], fb[args.face_b]

    import numpy as np
    ea = A.embedding / np.linalg.norm(A.embedding)
    eb = B.embedding / np.linalg.norm(B.embedding)
    s = cos(ea, eb)
    p = confidence(s)
    label, note = verdict(s)

    caveats = []
    try:  # buffalo_l ships age/gender estimators; informational only
        sa, sb = str(A.sex).lower(), str(B.sex).lower()
        if sa != sb:
            caveats.append("different predicted sexes -- cross-sex comparisons are "
                           "intrinsically harder (Griffin: resemblance is judged "
                           "relative to sex norms)")
        ga = int(A.age) if A.age is not None else None
        gb = int(B.age) if B.age is not None else None
        if ga is not None and gb is not None and abs(ga - gb) > 15:
            caveats.append(f"large predicted age gap (~{abs(ga-gb)}y) -- age differences "
                           "mask family cues")
    except Exception:
        pass
    if s >= SAME_PERSON_HINT:
        caveats.append("score is above the local same-person threshold (0.45) -- "
                       "the two photos may show the SAME individual, not two relatives")
    if len(fa) > 1 or len(fb) > 1:
        caveats.append(f"multiple faces detected (A:{len(fa)}, B:{len(fb)}) -- compared "
                       "the largest in each; use --face-a/--face-b to pick others")

    result = {
        "cosine_similarity": round(s, 4),
        "kinship_confidence": round(p, 3),
        "verdict": label,
        "verdict_note": note,
        "caveats": caveats,
        "faces_detected": {"a": len(fa), "b": len(fb)},
        "detection_scores": {"a": round(float(A.det_score), 3),
                             "b": round(float(B.det_score), 3)},
        "calibration": ("heuristic logistic(center=0.30, slope=11) on ArcFace cosine; "
                        "NOT trained on sibling data -- resemblance meter, not a test"),
    }

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"cosine similarity : {result['cosine_similarity']}")
        print(f"kinship confidence: {result['kinship_confidence']}  ({label})")
        print(f"note              : {note}")
        for c in caveats:
            print(f"caveat            : {c}")
        print(f"calibration       : {result['calibration']}")


if __name__ == "__main__":
    main()
