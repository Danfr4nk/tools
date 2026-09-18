# stylometry v3 — the semantic layer

v2 measures **how** Dan writes. v3 measures **what** he is saying, and fuses
the two. Neither axis is reported alone.

Stdlib Python. Layer A runs offline in the 30-minute loop; Layer B calls the
Claude API on triggers only.

**Read `BURNIN-V3.md` before reading any output** — in particular §6, the 2x2
and the topic/task confound.

## Shape

```
run_v3.py ──► Layer A (offline, every 30 min)
              ├─ registry.py   entity mentions + Poisson spike surprise
              ├─ topics.py     per-tier topic-mix divergence + null lookup
              └─ discourse.py  four lexicon proxies
                     │
                     ▼
              joint.py  ── 2x2 vs v2's style read ── alert arbitration
                     │
                     ▼
              layer_b.py (triggers only: v2 flag/alert, digest, manual)
                     │
                     ▼
              runs/YYYY-MM-DD/<window_id>.json
```

## Quick start

```bash
export STYLO_V3_DATA="$HOME/workspace/stylometry/v3"
STYLO_V3_DATA=/tmp/v3check python3 -m v3.selftest    # synthetic, no network
python3 -m unittest discover -s v3/tests -t .
```

Then §1–§3 of `BURNIN-V3.md`: build the artifacts, wire the cron, set the key.

## Rules that are enforced in code, not documented

- **Data never enters this repo.** Everything lives under `$STYLO_V3_DATA`.
- **v2 is byte-identical.** v3 reads v2; it never writes there.
- **A flag is a shift, not a diagnosis.** The calibration gate blocks
  state-signature vocabulary until five distinct `(label, date)` episodes
  exist, and substitutes a deterministic read if a model produces it anyway.
- **Suppressed flags render ONGOING, never clean.**
- **Novel entities stay candidates.** The registry is append-only; similar
  names are never merged.
- **Every Layer B call is audited** — input hash, prompt hash, raw output.
- **Layer A never opens a socket.** There is a test that enforces this.
