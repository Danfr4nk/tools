#!/usr/bin/env python3
"""Daily digest. ONE Layer B call over the day's windows.

    python3 -m v3.digest_v3 --day 2026-09-18

Reuses the cached Layer B outputs of flagged windows -- it never re-scores a
window and never re-reads the message store for windows Layer B already saw.
Windows still sitting in the backfill queue are reported as an explicit GAP;
the digest never presents a partial day as a complete one.
"""
import argparse
import json
import sys
import time

from . import calibration, config, layer_b as lb, runrecord

QUADRANT_ORDER = ("state_change_or_new_domain", "state_shift_familiar_content",
                  "new_task_same_state", "baseline")


def rollup(day, runs_base=None, queue_path=None):
    recs = runrecord.read_day(day, runs_base)
    t0 = time.mktime(time.strptime(day + " +0000", "%Y-%m-%d %z"))
    gaps = [r for r in lb.pending(queue_path)
            if t0 <= float(r.get("enqueued_at", 0)) < t0 + 86400]

    quads = {q: 0 for q in QUADRANT_ORDER}
    statuses = {"ALERT": 0, "ONGOING": 0, "CLEAR": 0}
    cached = []
    for r in recs:
        quads[r["joint"]["quadrant"]] = quads.get(r["joint"]["quadrant"], 0) + 1
        statuses[r["joint"]["alerting"]["status"]] += 1
        b = r.get("layer_b") or {}
        if b.get("available"):
            cached.append({
                "window_id": r["window_id"],
                "kind": r["window"]["kind"],
                "end_ts": r["window"]["end_ts"],
                "quadrant": r["joint"]["quadrant"],
                "topics": b.get("topics", []),
                "entities": b.get("entities", []),
                "discourse_moves": b.get("discourse_moves", []),
                "wiki_nodes": b.get("wiki_nodes", []),
                "confidence": b.get("confidence"),
                "ambiguity": b.get("ambiguity"),
                "joint_read": b.get("joint_read"),
            })
    return {
        "day": day,
        "n_windows": len(recs),
        "quadrants": quads,
        "statuses": statuses,
        "layer_b_cached": cached,
        "gaps": gaps,
        "n_gaps": len(gaps),
        "calibration_gate": calibration.gate_status(),
    }


def build_digest_input(roll):
    return ("DAILY ROLLUP -- these per-window semantic reads are already "
            "computed. Synthesize the day; do not re-derive them.\n"
            + json.dumps(roll, sort_keys=True, indent=1, ensure_ascii=False)
            + ("\n\nGAP NOTICE: %d window(s) failed Layer B and are queued for "
               "backfill. State this gap in ambiguity.\n" % roll["n_gaps"]
               if roll["n_gaps"] else ""))


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", default=time.strftime("%Y-%m-%d", time.gmtime()))
    ap.add_argument("--runs", default=None)
    ap.add_argument("--no-llm", action="store_true",
                    help="rollup only; skip the Layer B digest call")
    ap.add_argument("--out", default=None)
    args = ap.parse_args(argv)

    roll = rollup(args.day, args.runs)
    result = {"rollup": roll, "layer_b": {"available": False,
                                          "reason": "skipped"}}

    if not args.no_llm and roll["n_windows"]:
        ptext = lb.load_prompt()
        payload = lb.build_payload(build_digest_input(roll), system=ptext)
        started = time.time()
        base = {"window_id": "digest:%s" % args.day, "trigger": "daily_digest",
                "prompt_version": lb.PROMPT_VERSION,
                "prompt_hash": lb.prompt_hash(ptext),
                "model": payload["model"], "called_at": started,
                "code_version": config.CODE_VERSION}
        try:
            resp, used = lb.call_api(payload)
            obj = lb.extract_json(resp)
            allowed, hits = calibration.enforce(obj.get("joint_read", ""),
                                                roll["calibration_gate"])
            lb.audit(dict(base, ok=True, transport=used, output=obj,
                          usage=resp.get("usage", {}),
                          gate_violation=(not allowed), banned_terms=hits,
                          validation_issues=lb.validate(obj),
                          latency_sec=round(time.time() - started, 3)))
            result["layer_b"] = dict(obj, available=True,
                                     gate_violation=(not allowed),
                                     joint_read_source=("layer_b" if allowed
                                                        else "blocked_by_gate"))
            if not allowed:
                result["layer_b"]["joint_read"] = (
                    "Digest read withheld: calibration gate OPEN and the model "
                    "asserted a state signature (%s). Rollup numbers stand."
                    % ", ".join(hits))
        except lb.LayerBUnavailable as exc:
            lb.audit(dict(base, ok=False, error=str(exc)))
            result["layer_b"] = {"available": False, "reason": str(exc)}

    text = json.dumps(result, sort_keys=True, indent=2, ensure_ascii=False)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        print("wrote %s" % args.out)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
