#!/bin/bash
# Assemble the web harness: copies the Python engine into docs/ and extracts
# the piano-roll renderer JS from hook2piano/render_html.py into docs/render.js.
# Run from the repo root after changing hook2piano/*.py.
set -e
cd "$(dirname "$0")/.."
mkdir -p docs/py/hook2piano
cp hook2piano/*.py docs/py/hook2piano/
python3 - <<'EOF'
import re
src = open('hook2piano/render_html.py').read()
m = re.search(r'<script>\n\(function\(\)\{\n(.*)\n\}\)\(\);\n</script>', src, re.S)
assert m, "renderer IIFE not found in render_html.py _PAGE"
js = m.group(1)
lines = js.split('\n')
assert lines[0].strip() == '"use strict";', lines[0]
# drop the standalone page's auto-run line (the web harness calls renderSong itself)
body = [l for l in lines[1:] if 'document.getElementById("score")' not in l]
out = ['"use strict";',
       '/* Extracted from hook2piano/render_html.py — do not hand-edit; rerun docs/build.sh */'] + body
open('docs/render.js', 'w').write('\n'.join(out) + '\n')
print("regenerated docs/render.js")
EOF
echo "docs/ assembled"
