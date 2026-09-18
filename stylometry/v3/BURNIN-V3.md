# BURNIN-V3 — runbook

v3 measures **what** is being said. v2 measures **how**. Neither is reported
alone. Read §6 before reading any output.

---

## 0. Install

Code lives in this repo. **Data never does.**

```bash
mkdir -p ~/workspace/stylometry/v3
ln -s ~/src/tools/stylometry/v3 ~/workspace/stylometry/v3/code   # or copy
export STYLO_V3_DATA="$HOME/workspace/stylometry/v3"             # add to ~/.profile
```

`$STYLO_V3_DATA` holds `runs/`, `windows/`, `queue/`, `state/`, `audit/`,
`entity_registry.json`, `topic_profiles.json`, `semantic_null.json`,
`entity_candidates.jsonl`, `labels.jsonl`. All of it contains message text or
real names. None of it is committed; the repo `.gitignore` blocks it, but the
env var is what actually keeps it out.

Prove the install before pointing it at real data:

```bash
STYLO_V3_DATA=/tmp/v3check python3 -m v3.selftest     # synthetic, no network
python3 -m unittest discover -s v3/tests -t .          # 57 tests
```

## 1. Build the artifacts (once)

Both build scripts are offline and idempotent. Rebuilding changes every
subsequent score, so do it deliberately and note the date in CHANGELOG.

```bash
# baseline.jsonl: {"tier": str, "text": str} over the 94,503-message corpus
python3 -m v3.build_topic_profiles --corpus baseline.jsonl
python3 -m v3.build_semantic_null  --corpus baseline.jsonl --draws 20000
```

Until both exist, Layer A reports `available: false` on the topic and
discourse axes and `confidence` near zero. That is the designed behaviour:
an unbuilt artifact makes an axis **dead, not quiet**.

Seed the entity registry by hand. It is append-only, and every entry carries
provenance. Candidates never match; only `status: "confirmed"` entries do.

## 2. Wire the 30-minute worker

v3 runs **after** v2 in the same cron slot, reading v2's output. It never
writes into v2's tree.

```bash
*/30 * * * * cd ~/workspace/stylometry && \
  ./v2/run_v2.sh > /tmp/v2.out 2>&1 ; \
  STYLO_V3_DATA=$HOME/workspace/stylometry/v3 \
  python3 -m v3.run_v3 \
    --messages-cmd 'python3 v2/export_outbound.py --since 8h' \
    --v2-record ~/workspace/stylometry/v2/runs/latest.json \
    --quiet >> ~/workspace/stylometry/v3/cron.log 2>&1
```

**Message input contract** (JSONL, one object per outbound message):

```json
{"msg_id": "...", "ts": 1700000000.0, "tier": "close",
 "recipient": "...", "text": "...", "direction": "out"}
```

`ts` is epoch seconds UTC. A missing required field raises rather than being
guessed. `direction != "out"` rows are dropped.

**v2 record**: `--v2-record` takes v2's run record as JSON or JSONL (last line
wins). `v2_bridge.py` probes several plausible key spellings because v3 was
built without access to v2's source. If it recognizes nothing it reports
`available: false` — which renders as *"v2 read unavailable"*, never as a
stable style axis. **Check this on day one**: if every joint read says the v2
read is unavailable, fix the adapter before trusting a single quadrant.

## 3. Layer B triggers

Layer B never runs in the fast loop. It fires on exactly four conditions:

| Trigger | Fires when |
|---|---|
| `v2_flag` | v2 raised a style flag on this window |
| `v2_alert` | v2 raised a style alert |
| `daily_digest` | once per day, over the day's windows |
| `manual` | `run_v3.py --trigger manual`, or `backfill_v3.py` |

A **v3-only semantic flag does not fire Layer B.** With a stable style axis it
is quadrant 3 — new task, same state — which is context, not signal, and
paying Opus to narrate a task change is how this instrument becomes expensive
and boring at the same time.

On top of the triggers sits a **cost brake**: `LAYER_B_COOLDOWN_SEC` (90 min)
per `(window_kind, dominant_axis)`. Without it, a three-hour flag cluster
fires two calls every thirty minutes. Distinct from the 6h alert cooldown —
one governs spend, the other governs notification.

Set the key once:

```bash
export ANTHROPIC_API_KEY=sk-ant-...     # or ANTHROPIC_AUTH_TOKEN for OAuth
```

Transport is the official `anthropic` SDK when importable, stdlib `urllib`
otherwise. Both build one payload; there is nothing to drift.

## 4. The daily worker's read path

This is the contract. Do not parse `runs/` any other way.

```python
from v3 import runrecord

for rec in runrecord.read_day("2026-09-18"):        # UTC; or read_range(t0, t1)
    rec["window_id"]                                 # content-addressed
    rec["window"]["kind"]                            # trailing_hours | trailing_n
    rec["window"]["window_semantics"]                # "v3-independent-global-time"
    rec["joint"]["quadrant"]                         # the 2x2 cell
    rec["joint"]["joint_read"]                       # the rendered paragraph
    rec["joint"]["joint_read_source"]                # layer_b | layer_a_deterministic*
    rec["joint"]["alerting"]["status"]               # ALERT | ONGOING | CLEAR
    rec["joint"]["alerting"]["suppression_reason"]
    rec["joint"]["calibration_gate"]["state"]        # OPEN | MET
    rec["layer_a"]["semantic_percentile"]
    rec["layer_a"]["dominant_axis"]
    rec["layer_a"]["confidence"], rec["layer_a"]["ambiguity"]
    rec["layer_b"]                                   # may be {"available": false, ...}
    rec["v2"]["style"], rec["v2"]["adjacency_divergence"]
```

Layout: `runs/YYYY-MM-DD/<window_id>.json`, one file per scored window.
`schema_version` is `v3-run-1`.

**Three rendering rules the worker must not break:**

1. `ONGOING` is **never** rendered as clean. A flag that was suppressed is
   still a flag; only `CLEAR` means the axes were inside range.
2. Never render the semantic axis without the style axis beside it.
3. `joint_read_source != "layer_b"` means the paragraph is deterministic
   template text or a gate-blocked substitution. Say which.

Digest: `python3 -m v3.digest_v3 --day 2026-09-18` reuses the cached Layer B
output of flagged windows and makes exactly one additional call. Queued
windows are reported as an explicit `gaps` list — a partial day is never
presented as a complete one.

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| Layer B unreachable | Layer A completes; window queues in `queue/pending.jsonl`; the record carries Layer A's deterministic joint read; digest reports the gap |
| No API key | Same as above — `LayerBUnavailable` at the first call, queued |
| Artifacts unbuilt | Axes report `available: false`, `confidence` ~0, nothing flags |
| v2 record missing | Style axis `available: false`; joint read says so; quadrant computed with `style_shift = False`, which biases toward quadrant 3 — treat those reads as low-information |
| Model refusal / `max_tokens` | `LayerBUnavailable`, logged, queued; never a silent empty read |
| Gate violation | Model output archived in full; **rendered** read replaced by Layer A's |

Drain the queue: `python3 -m v3.backfill_v3 --batch` (Batch API, 50% cost,
right mode for a backlog) or without `--batch` for sequential.

## 6. Reading the output — the 2x2

**Topic is task-coupled, not state-coupled.** A content shift is, by default,
evidence that Dan is doing something different — not that he *is* something
different. This is the single most likely way v3 lies.

| | semantic stable | semantic shift |
|---|---|---|
| **style shift** | `state_shift_familiar_content` — highest-value quadrant | `state_change_or_new_domain` — genuine state change OR new-domain stress, not separable from numbers |
| **style stable** | `baseline` | `new_task_same_state` — expected, context only, alert suppressed |

### Worked example (real selftest output, both quadrants, same run)

A 120-message stream that spends 90 messages on work vocabulary then drifts to
family vocabulary. v2 flagged the 4h window (p99.1) and did not flag the
trailing-100 window (p42.0).

**Window A — `trailing_hours`, v2 p99.1, semantic p100.0 → `state_change_or_new_domain` → ALERT**

> Style moved and content moved. Genuine state change OR new-domain stress —
> these are not separable from the numbers alone. Check labels and
> self-reports before distinguishing. Style: p99.1. Semantic: p100.0,
> dominant axis topic (topic p100.0, entity n/a, discourse p80.8). Axes
> unavailable: entity. Confidence 0.78. Ambiguity: entity axis unavailable
> (null_unavailable); topic null stratum thin (n=125); discourse axis is a
> lexicon proxy, not a parse. Gate OPEN (0/5 episodes): shift, not diagnosis.

**Window B — `trailing_n`, v2 p42.0, semantic p100.0 → `new_task_same_state` → ONGOING**

> Content moved, style did not. Expected. New task, same state. Context only —
> this is not a state signal on its own. Style: p42.0. Semantic: p100.0,
> dominant axis topic.

**Both windows saw the same topic shift at the same percentile.** The only
difference is the style axis. Window A is worth a look; window B is Dan
changing subject. A semantic-only instrument would have fired twice and been
wrong once. `semantic_flag` is `True` on both — measurement is always
recorded — but B's alert is suppressed with
`suppression_reason: "quadrant_task_confound"` and renders ONGOING, not CLEAR.

### What a flag is not

A flag is a threshold crossing. It is not a diagnosis, and inference is not
proof. While the **calibration gate** is `OPEN` — fewer than five distinct
`(label, date)` episodes in `labels.jsonl` — v3 emits description and joint
reads only. A Layer B read containing state-signature vocabulary while the
gate is open is archived and **not rendered**; Layer A's deterministic read is
substituted. Add episodes as:

```bash
echo '{"label":"...","date":"2026-09-18","note":"...","window_id":"..."}' \
  >> $STYLO_V3_DATA/labels.jsonl
```

Five `(label, date)` pairs unlock the vocabulary. They do not make the
inference correct — `n_distinct_labels` is reported alongside so the thinness
of the calibration stays visible.

## 7. Cost

Assumptions, stated so they can be argued with: p95 window = 100 messages
(`trailing_n` is exactly 100 by construction; 4h windows are capped at 240 for
Layer B input); ~35 tokens/message → ~3,500 tokens of text; ~1,000 tokens of
precomputed Layer A + v2 numbers; ~1,300-token system prompt; ~350 tokens of
schema → **~6,200 input tokens/call**. Output: structured JSON ~600 + adaptive
thinking at `effort: medium` ~800 → **~1,400 output tokens/call**. Digest
calls: ~5,000 in / ~1,800 out.

Call volume from observed burn-in flag rates, after the 90-minute Layer B
cooldown collapses clusters: quiet day 1 window call, typical day 3, active
day 5, plus 1 digest daily. Month = 12 quiet + 14 typical + 4 active →
**74 window calls + 30 digests**.

| Model | $/MTok in/out | Window call | Digest call | **Monthly** |
|---|---|---|---|---|
| `claude-opus-5` (default) | 5 / 25 | $0.066 | $0.070 | **$6.98** |
| `claude-sonnet-5` | 2 / 10 | $0.026 | $0.028 | **$2.79** |
| `claude-haiku-4-5` | 1 / 5 | $0.013 | $0.014 | **$1.40** |
| Opus 5, backfill via Batch API | — | $0.033 | — | 50% off the queued subset |
| **Opus 5, no discipline** (every window, every 30 min) | 5 / 25 | $0.066 | — | **$190** |

The last row is what the trigger conditions and the cooldown buy: **27×**.
The default is Opus 5; switch with `STYLO_V3_MODEL=claude-sonnet-5`. Prices
are first-party API rates as of 2026-06; re-check before trusting the table.

Layer A costs nothing and runs every 30 minutes regardless.

## 8. Replay

```bash
python3 -m v3.verify_replay_v3 --verbose
```

Layer A is re-scored from the stored window and compared by **exact equality**
(every stored float is rounded to 10 dp at write time). Layer B is **not**
re-called: its output is a sample, not a measurement. What replay verifies for
Layer B is provenance — recorded `prompt_hash` matches the prompt on disk, and
recorded `input_hash` matches the hash rebuilt from the stored window.

`DRIFT` means the registry/profiles/null on disk no longer hash to what the
record says. That is expected after a rebuild and is reported separately from
`FAIL`. `SKIP` means the window was never flagged, so it was never stored.
