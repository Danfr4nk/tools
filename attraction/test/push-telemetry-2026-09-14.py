#!/usr/bin/env python3
"""Scoped push: Telemetry Lab hardening pass 2026-09-14 only.

Variant of test/push-via-api.py with a reduced FILES list — Telemetry Lab
files changed/added in this run. Body Metrics, game, splash, Face Book
explicitly excluded.
"""
import base64
import json
import subprocess
import sys

REPO = "Danfr4nk/tools"
PREFIX = "attraction/"  # repo-relative subdir for the moved tools
BRANCH = "main"
GH = "/home/hatch/workspace/skills/github/bin/gh-api"
APP = "/home/hatch/workspace/attraction-guide"

FILES = [
    "js/telemetry.js",
    "js/telemetry2.js",
    "js/telemetry3.js",
    "test/drift-harness/run.js",
    "test/drift-harness/denom-guard-test.mjs",
    "test/drift-harness/HARDENING-REPORT-2026-09-14.md",
    "test/drift-harness/drift-report.json",
]

MESSAGE = """Telemetry Lab hardening: full denominator audit (second wave)

- Every V1/V2/V3 ratio now has a bank-calibrated denominator floor
  (0.5 x bank minimum, n=155): fwhr_proxy, jaw/ipd/nose/mouth:cheek,
  chin:lower-third, philtrum:nose, nose:intercanthal, mouth:nose,
  lip_fullness, fifths, spacing, brow_arch, V3 brow_len/nose_tip/
  lip_corner, V2 mouth_corner_drop + mm_per_px (anatomical iris floor).
- Removed the remaining || 1 fabrications (V3 nose_tip_deviation,
  lip_corner_asym; V2 brow_apex_angle now returns null on degenerate
  geometry, null poisons the mean).
- computeV2() returns { metrics, flags } like V3; canon metrics inherit
  their source ratio's flags; collapsed iris anchor adds a scale note.
- denom-guard-test.mjs: 35/35 (clean-face zero-flag control included).
- Drift audit re-run vs 2026-09-11 baseline: aspect-only pattern intact.
"""


def api(method, path, body=None):
    cmd = [GH, method, f"/repos/{REPO}{path}"]
    inp = json.dumps(body).encode() if body is not None else None
    p = subprocess.run(cmd, input=inp, capture_output=True)
    if p.returncode != 0:
        print(f"API FAILED: {method} {path}", file=sys.stderr)
        print(p.stderr.decode()[:2000], file=sys.stderr)
        sys.exit(1)
    return json.loads(p.stdout.decode())


def main():
    ref = api("GET", f"/git/ref/heads/{BRANCH}")
    head_sha = ref["object"]["sha"]
    print("head:", head_sha[:12])

    tree_entries = []
    for f in FILES:
        with open(f"{APP}/{f}", "rb") as fh:
            content = base64.b64encode(fh.read()).decode()
        blob = api("POST", "/git/blobs", {"content": content, "encoding": "base64"})
        tree_entries.append({"path": PREFIX + f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        print("blob:", f, blob["sha"][:12])

    head_commit = api("GET", f"/git/commits/{head_sha}")
    new_tree = api("POST", "/git/trees", {"base_tree": head_commit["tree"]["sha"], "tree": tree_entries})
    print("tree:", new_tree["sha"][:12])

    commit = api("POST", "/git/commits", {
        "message": MESSAGE, "tree": new_tree["sha"], "parents": [head_sha]})
    print("commit:", commit["sha"])

    api("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": commit["sha"]})
    print("pushed", commit["sha"], "to", BRANCH)


main()
