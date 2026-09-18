# CHANGELOG — stylometry v3 (semantic layer)

## v3.0.1 — 2026-09-18 — production wiring

First live wiring: v3 now scores real windows against the real corpus.

### Corpus
- `export_corpus.py` (new) — exports the 94,503-message outbound corpus
  (`~/workspace/wikitest/corpus/messages.csv`, generated 2026-09-15) plus
  386 recent chat messages as the `muse` tier, into v3's input contract
  (`corpus/v3-baseline.jsonl`, 99,703 rows). Tier mapping mirrors v2's
  baseline2.json: top-10 correspondents keep their own tier, everyone else
  is `longtail`.
- `topic_profiles.json` and `semantic_null.json` **rebuilt on the real
  corpus** 2026-09-18 (11 tiers, 990,385 background tokens; 49 null strata
  per axis). The selftest-built artifacts they replace are gone. Rebuilds
  change every subsequent score — this date is the new baseline.

### Bridge
- `v2_bridge.py` — reads real v2 run records: `flag`→`style_flag`,
  `null_percentile`→`percentile`, `alert`/`suppressed`→`style_alert`/
  `style_suppressed`; adds `divergence_index` to the divergence keys
  (`null_percentile` + `mahalanobis_distance` now surface as `divergence`);
  `v2_run_id` falls back to `scored_at`, `v2_window_id` to the window kind;
  v2 run files are JSONL (one record/line) — load takes the last line.
  Verified day-one against `runs/2026-09-17.jsonl` and `runs/2026-09-18.jsonl`.

### Layer B transport
- `layer_b_manual.py` (new) — the cron-worker environment has no API key,
  so the 30-min worker IS the Layer B transport. Two honest halves:
  `--show` prints the versioned prompt + assembled window payload; the
  worker performs the read and `--respond` validates the strict JSON
  (bounds, discourse shares, non-empty joint_read), enforces the
  calibration gate, writes the audit row, patches the run record, and
  clears the pending queue.

### State
- `.gitignore` (new) — `runs/`, `audit/`, `queue/`, `__pycache__/`,
  `entity_candidates.jsonl` are local run state, never committed.

### Not done
- `entity_registry.json` remains seed-only by design (populate on the Mac,
  never commit the populated file) — the entity axis is dead until then.
- 30-min v3 cron (`stylo-v3-burnin-30m`, goal-owned) runs the loop and
  performs manual Layer B reads on ALERT windows.

## v3.0.0 — 2026-09-18 — initial build

First release of the semantic layer. v2 remains **byte-identical**: v3 reads
v2's run records and writes nothing into v2's tree.

### Added

- **Layer A** (`layer_a.py`, stdlib, zero network, runs in the 30-min loop):
  - `registry.py` — entity matching (longest-alias-first), Poisson-tail spike
    surprise against per-tier historical rates, append-only novel-candidate
    logging.
  - `topics.py` — per-tier topic-mix divergence (cosine on sublinear-tf
    vectors against log-odds/Dirichlet keyword profiles), plus the shared
    stratified-null lookup.
  - `discourse.py` — four lexicon proxies: imperative ratio, interrogative
    ratio, second-person directive density, declarative share.
- **Layer B** (`layer_b.py`) — one batched, trigger-only call per window;
  strict `output_config.format` JSON schema; versioned + hashed prompt
  (`prompts/joint_read_v1.txt`); SDK transport with a stdlib `urllib`
  fallback; bounded retry; queue-on-failure.
- **`joint.py`** — the 2x2 matrix, the deterministic joint read, and alert
  arbitration (`semantic_flag` measurement vs `semantic_alert` notification,
  6h per-signature cooldown, ONGOING rendering).
- **`windows.py`** — v3-independent window construction (see *Breaking from
  v2* below).
- **`window_store.py`** — per-window message store for flagged windows;
  Layer B reads from it and never re-queries the message DB.
- **`calibration.py`** — the gate, enforced in code on every render path.
- **`v2_bridge.py`** — tolerant read-only adapter for v2 run records.
- **`runrecord.py`** — run records + the documented daily-worker read path.
- Build scripts (`build_topic_profiles.py`, `build_semantic_null.py`),
  `digest_v3.py`, `backfill_v3.py` (with Batch API mode), `selftest.py`,
  `verify_replay_v3.py`, and 57 stdlib tests.

### Breaking from v2 — deliberate

- **Window construction is independent.** v2's tier-adjacency bug (per-tier
  sequences sorted independently, so "adjacent" records can splice unrelated
  conversations) is **not inherited**. v3 orders by `(ts, msg_id)` over the
  whole outbound stream; tier is an attribute used for conditioning, never a
  sort or grouping key. Differing member sets between v2 and v3 are expected.
  Every record carries `window_semantics` and an `adjacency_divergence` block
  (null when v2 membership is unavailable — which is not agreement).

### Defects found and fixed during this build

- **Degenerate-null false flag.** `bisect_right` against a null stratum with
  no spread returns percentile 1.0 for a perfectly typical observation — a
  permanent false flag on any axis whose null is constant (an empty entity
  registry does exactly this). Fixed two ways: strata with zero spread now
  report `available: false, degenerate: true` instead of a number, and
  ranking uses a **mid-p** rank (ties contribute half their mass) rather than
  `bisect_right`. `robust_z` falls back to the inter-decile range when the
  MAD is flat, instead of dividing by a floor and manufacturing a z in the
  hundreds.
- **Window id did not cover message text.** `window_store.write()` treats an
  existing file for a window id as identical and skips the write; with the id
  hashed over message *ids* only, an edited or corrected message would have
  silently reused a stale store file. Message text is now part of the id.

### Known and deliberate

- `temperature: 0` was specified and is **not settable**: current Claude
  models reject `temperature` with a 400. Determinism is structural — strict
  output schema, frozen hashed prompt, hashed input, pinned effort — and the
  residual wobble in Layer B's wording is stated in every record rather than
  papered over. `temperature: 0` is still emitted for models that accept it
  (Haiku 4.5 and older).
- Layer A replays exactly. Layer B is **never** re-called by replay; only its
  provenance hashes are verified.
- Shipped `topic_profiles.json` and `semantic_null.json` are `status:
  "unbuilt"` stubs. Layer A reports axes as unavailable against them rather
  than scoring confidently off an empty profile.
- `entity_registry.json` is a schema-only seed with no real names.
