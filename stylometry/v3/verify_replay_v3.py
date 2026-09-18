#!/usr/bin/env python3
"""Deterministic replay for v3. ZERO NETWORK.

    python3 -m v3.verify_replay_v3 [--runs DIR] [--allow-artifact-drift]

WHAT IS VERIFIED
  Layer A: re-scored from the stored window and compared field by field
  against the recorded numbers. Every stored float is rounded to
  config.ROUND_DP at write time, so comparison is exact equality, not a
  tolerance. Any mismatch is a failure.

  Layer B: NOT re-called and NOT reproduced. LLM output is non-deterministic
  and re-running it would prove nothing. What is verified is provenance --
  that the recorded prompt_hash matches the prompt on disk, and that the
  recorded input_hash matches the hash recomputed from the stored window plus
  the recorded Layer A numbers. That establishes WHAT was sent, not that the
  same text would come back.

ARTIFACT DRIFT
  If the registry / profiles / null on disk no longer hash to what the record
  says, Layer A is expected to differ and the record is reported as DRIFT
  rather than FAIL. --allow-artifact-drift downgrades it to a warning and
  replays anyway (the result will usually mismatch; that is the point).
"""
import argparse
import sys

from . import (config, layer_a as la, layer_b as lb, registry as reg,
               runrecord, topics, window_store)
from .windows import Message, Window

COMPARE_SCALARS = ("semantic_percentile", "composite_excess", "dominant_axis",
                   "semantic_flag", "semantic_strong", "tier_fallback",
                   "confidence", "ambiguity", "n_candidates")
COMPARE_AXIS = {
    "topic": ("divergence", "percentile", "robust_z", "available"),
    "entity": ("max_surprise", "percentile", "robust_z", "available"),
    "discourse": ("max_abs_z", "percentile", "robust_z", "available"),
}


def rebuild_window(stored):
    h = stored["header"]
    msgs = [Message(m["msg_id"], m["ts"], m["tier"], "", m["text"])
            for m in stored["messages"]]
    w = Window(h["kind"], h["end_ts"], msgs)
    return w, (w.window_id == h["window_id"])


def replay_record(rec, registry_obj, profiles, null, allow_drift=False,
                  store_base=None):
    out = {"window_id": rec["window_id"], "status": "PASS", "diffs": [],
           "notes": []}

    stored = window_store.read(rec["window_id"], store_base)
    if stored is None:
        out["status"] = "SKIP"
        out["notes"].append("window not in store (unflagged windows are not stored)")
        return out

    current = la.artifact_hashes()
    recorded = rec.get("artifact_hashes", {})
    drift = sorted(k for k in recorded if current.get(k) != recorded.get(k))
    if drift:
        out["notes"].append("artifact drift: %s" % ", ".join(drift))
        if not allow_drift:
            out["status"] = "DRIFT"
            return out

    window, id_ok = rebuild_window(stored)
    if not id_ok:
        out["status"] = "FAIL"
        out["diffs"].append({"field": "window_id",
                             "recorded": stored["header"]["window_id"],
                             "replayed": window.window_id})
        return out

    fresh = la.score_window(window, registry_obj, profiles, null)
    rec_a = rec["layer_a"]
    for f in COMPARE_SCALARS:
        if fresh.get(f) != rec_a.get(f):
            out["diffs"].append({"field": f, "recorded": rec_a.get(f),
                                 "replayed": fresh.get(f)})
    for axis, fields in COMPARE_AXIS.items():
        for f in fields:
            a = rec_a.get("axes", {}).get(axis, {}).get(f)
            b = fresh["axes"][axis].get(f)
            if a != b:
                out["diffs"].append({"field": "axes.%s.%s" % (axis, f),
                                     "recorded": a, "replayed": b})

    ih = la.inputs_hash(window, fresh)
    if ih != rec.get("inputs_hash"):
        out["diffs"].append({"field": "inputs_hash",
                             "recorded": rec.get("inputs_hash"), "replayed": ih})

    # -- Layer B provenance, never reproduction --------------------------
    lbb = rec.get("layer_b") or {}
    if lbb.get("available"):
        ph = lb.prompt_hash()
        if ph != lbb.get("prompt_hash"):
            out["diffs"].append({"field": "layer_b.prompt_hash",
                                 "recorded": lbb.get("prompt_hash"),
                                 "replayed": ph})
            out["notes"].append("prompt text on disk differs from the one used")
        try:
            _, ihash_b, _ = lb.build_input(rec["window_id"], rec_a,
                                           rec["joint"], store_base)
            if ihash_b != lbb.get("input_hash"):
                out["diffs"].append({"field": "layer_b.input_hash",
                                     "recorded": lbb.get("input_hash"),
                                     "replayed": ihash_b})
        except lb.LayerBUnavailable as exc:
            out["notes"].append("layer_b input not rebuildable: %s" % exc)
        out["notes"].append("layer_b output NOT reproduced: LLM output is a "
                            "sample, not a measurement")

    if out["diffs"] and out["status"] == "PASS":
        out["status"] = "FAIL"
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=None)
    ap.add_argument("--windows", default=None)
    ap.add_argument("--allow-artifact-drift", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)

    registry_obj = reg.Registry.load()
    profiles = topics.TopicProfiles.load()
    null = topics.SemanticNull.load()

    tally = {"PASS": 0, "FAIL": 0, "DRIFT": 0, "SKIP": 0}
    failures = []
    for p in runrecord.iter_paths(args.runs):
        rec = runrecord.read(p)
        res = replay_record(rec, registry_obj, profiles, null,
                            allow_drift=args.allow_artifact_drift,
                            store_base=args.windows)
        tally[res["status"]] += 1
        if res["status"] in ("FAIL", "DRIFT"):
            failures.append((p, res))
        if args.verbose:
            print("%-5s %s %s" % (res["status"], rec["window_id"],
                                  "; ".join(res["notes"])))

    print("replay: %d pass, %d fail, %d drift, %d skip"
          % (tally["PASS"], tally["FAIL"], tally["DRIFT"], tally["SKIP"]))
    for p, res in failures:
        print("\n%s -> %s" % (p, res["status"]))
        for d in res["diffs"][:12]:
            print("   %-28s recorded=%r replayed=%r"
                  % (d["field"], d["recorded"], d["replayed"]))
        for n in res["notes"]:
            print("   note: %s" % n)
    return 1 if (tally["FAIL"] or tally["DRIFT"]) else 0


if __name__ == "__main__":
    sys.exit(main())
