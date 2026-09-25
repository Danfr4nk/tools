#!/usr/bin/env bash
# run-tests.sh — every test suite in the repo, one summary line per suite.
# Needs only node + python3 (stdlib). Works with macOS bash 3.2 / BSD find.
#
#   ./run-tests.sh            run everything
#   ./run-tests.sh melody     only suites whose label contains "melody"
#
# JS suites are discovered by name (*.test.js, *.test.mjs, test-*.mjs) and run
# from their own directory; Python suites are listed explicitly below because
# each wants its own invocation. Exit status is non-zero if anything failed.
set -u
cd "$(dirname "$0")"
filter="${1:-}"
pass=0; fail=0; failed=()
TO=""; command -v timeout >/dev/null 2>&1 && TO="timeout 600"

run() {  # run <label> <dir> <cmd...>
  local label=$1 dir=$2 out
  shift 2
  if [ -n "$filter" ] && [[ $label != *"$filter"* ]]; then return; fi
  if out=$(cd "$dir" && $TO "$@" 2>&1); then
    pass=$((pass + 1)); printf 'ok    %s\n' "$label"
  else
    fail=$((fail + 1)); failed+=("$label"); printf 'FAIL  %s\n' "$label"
    printf '%s\n' "$out" | tail -15 | sed 's/^/      /'
  fi
}

while IFS= read -r f; do
  f=${f#./}
  run "$f" "$(dirname "$f")" node "$(basename "$f")"
done < <(find . -path ./.git -prune -o -path '*/node_modules' -prune -o -type f \
  \( -name '*.test.js' -o -name '*.test.mjs' -o -name 'test-*.mjs' \) -print | sort)

run music/melody/midi.js         music/melody       node midi.js
run music/hook2piano/tests       music/hook2piano   python3 -m unittest discover -s tests -q
run sc2mp3/test_server.py        sc2mp3             python3 test_server.py
run stylometry/v3/tests          stylometry         python3 -m unittest discover -s v3/tests -t . -q
# selftest writes synthetic artifacts into $STYLO_V3_DATA — never the real
# data root (it refuses a non-empty one anyway). Throwaway dir, removed after.
stylo_tmp=$(mktemp -d)
run stylometry/v3/selftest       stylometry         env STYLO_V3_DATA="$stylo_tmp" python3 -m v3.selftest
rm -rf "$stylo_tmp"

echo
echo "$pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf '  %s\n' "${failed[@]}"; exit 1; fi
