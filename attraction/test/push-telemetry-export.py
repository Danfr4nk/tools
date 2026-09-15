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
    "telemetry.html",
]

MESSAGE = """Telemetry Lab: image export (photo+overlay PNG, wireframe PNG)

- renderViewer() drawing body extracted into drawOverlay(ctx, W, H, it, withPhoto):
  same code path renders the on-screen viewer and the exports, so what you
  download is pixel-identical to what you see.
- Export card gains two buttons: "download png" (analyzed photo + toggled
  overlay layers + HUD frame at full image resolution) and "wireframe png"
  (overlay layers + HUD on a transparent background, no photo).
- Full-resolution via an upscale canvas transform; filenames
  <name>-telemetry.png / <name>-wireframe.png.
- Smoke-tested in node with stubbed DOM: 5/5 (photo render, wireframe
  render, export canvas dims + transform, filenames, viewer path).
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
