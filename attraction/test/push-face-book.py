#!/usr/bin/env python3
"""One-off: push face-book.html + face thumbnails to Danfr4nk/tools via the Git Data API."""
import base64, json, os, subprocess, sys

REPO = "Danfr4nk/tools"
PREFIX = "attraction/"  # repo-relative subdir for the moved tools
BRANCH = "main"
GH = "/home/hatch/workspace/skills/github/bin/gh-api"
APP = "/home/hatch/workspace/attraction-guide"

FILES = ["face-book.html"] + sorted(
    "faces/thumbs/" + f for f in os.listdir(f"{APP}/faces/thumbs") if f.endswith(".webp")
)
MESSAGE = sys.argv[1] if len(sys.argv) > 1 else "Add FACEBOOK: a book of faces (155-face gallery with filters + lightbox)"

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
    print("head:", head_sha[:12], flush=True)
    tree_entries = []
    for i, f in enumerate(FILES):
        with open(f"{APP}/{f}", "rb") as fh:
            content = base64.b64encode(fh.read()).decode()
        blob = api("POST", "/git/blobs", {"content": content, "encoding": "base64"})
        tree_entries.append({"path": PREFIX + f, "mode": "100644", "type": "blob", "sha": blob["sha"]})
        if i % 25 == 0:
            print(f"blob {i+1}/{len(FILES)}", flush=True)
    print(f"blobs done: {len(FILES)}", flush=True)
    head_commit = api("GET", f"/git/commits/{head_sha}")
    new_tree = api("POST", "/git/trees", {"base_tree": head_commit["tree"]["sha"], "tree": tree_entries})
    print("tree:", new_tree["sha"][:12], flush=True)
    new_commit = api("POST", "/git/commits", {
        "message": MESSAGE, "tree": new_tree["sha"], "parents": [head_sha]})
    print("commit:", new_commit["sha"][:12], flush=True)
    upd = api("PATCH", f"/git/refs/heads/{BRANCH}", {"sha": new_commit["sha"]})
    print("branch now:", upd["object"]["sha"][:12], flush=True)

main()
