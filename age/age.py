#!/usr/bin/env python3
"""Age estimation from a photo — CLI companion to the web tool.

Uses the same Vision Transformer age classifier as the browser build
(dima806/fairface_age_image_detection — the base model behind the
onnx-community ONNX conversion the web app runs). Fully local after
the first download; nothing is uploaded anywhere.

Usage:
    python age.py photo.jpg
    python age.py photo.jpg --json
    python age.py photo.jpg --topk 3

Requires: pip install torch transformers Pillow
"""
import argparse
import json
import sys

LABELS = ["0-2", "3-9", "10-19", "20-29", "30-39",
          "40-49", "50-59", "60-69", "more than 70"]
MIDPOINTS = [1, 6, 14.5, 24.5, 34.5, 44.5, 54.5, 64.5, 78.0]
MODEL_ID = "dima806/fairface_age_image_detection"


def estimate(image_path):
    from PIL import Image
    from transformers import pipeline

    clf = pipeline("image-classification", model=MODEL_ID, top_k=None)
    img = Image.open(image_path).convert("RGB")
    out = clf(img)

    probs = {r["label"]: float(r["score"]) for r in out}
    dist = [{"label": l, "prob": probs.get(l, 0.0)} for l in LABELS]
    expected = sum(d["prob"] * m for d, m in zip(dist, MIDPOINTS))
    top = max(dist, key=lambda d: d["prob"])
    return {
        "model": MODEL_ID,
        "expected_age": round(expected, 2),
        "top_bracket": top["label"],
        "top_confidence": round(top["prob"], 4),
        "distribution": [{**d, "prob": round(d["prob"], 4)} for d in dist],
        "note": ("Expected age is the probability-weighted mean of bracket "
                 "midpoints. Treat as +/- one bracket. Apparent age, not identity."),
    }


def main():
    ap = argparse.ArgumentParser(description="Estimate apparent age from a photo.")
    ap.add_argument("image", help="path to image file")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    ap.add_argument("--topk", type=int, default=9, help="show top-k brackets (default 9)")
    args = ap.parse_args()

    try:
        res = estimate(args.image)
    except Exception as e:  # noqa: BLE001 - report cleanly for CLI use
        print(f"error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(res, indent=2))
        return

    print(f"estimated age: ~{res['expected_age']:.1f} years")
    print(f"top bracket:   {res['top_bracket']} ({res['top_confidence']*100:.1f}%)")
    print("distribution:")
    for d in sorted(res["distribution"], key=lambda x: -x["prob"])[:args.topk]:
        bar = "#" * int(d["prob"] * 40)
        print(f"  {d['label']:>12} {d['prob']*100:5.1f}% {bar}")


if __name__ == "__main__":
    main()
