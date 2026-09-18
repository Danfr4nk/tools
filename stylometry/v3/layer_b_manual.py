#!/usr/bin/env python3
"""Manual Layer B transport for the cron-worker environment.

In production the 30-minute worker IS the LLM, so there is no API key to
post to. This tool splits the Layer B call into two honest halves:

  1. SHOW:  python3 -m v3.layer_b_manual --show --window-id <id>
            prints the versioned prompt + the assembled window payload.
            The worker reads it, performs the semantic read, and writes
            the strict-JSON response to a file.

  2. RECORD: python3 -m v3.layer_b_manual --respond --window-id <id>
            --json /tmp/lb-response.json --trigger v2_flag
            validates the JSON (numeric bounds, discourse shares, non-empty
            joint_read), enforces the calibration gate, writes the audit row,
            patches the run record's layer_b block and joint_read, and
            clears the window from the pending queue.

Nothing is invented: the audit trail, prompt hash, input hash, validation
issues and gate state are all recorded exactly as the API transport would.
"""
import argparse
import json
import os
import sys
import time

from . import calibration, config, joint as joint_mod, layer_b as lb, runrecord


def find_record(window_id, base=None):
    for p in runrecord.iter_paths(base):
        try:
            rec = runrecord.read(p)
        except (ValueError, OSError):
            continue
        if rec.get("window_id") == window_id:
            return p, rec
    return None, None


def cmd_show(window_id):
    p, rec = find_record(window_id)
    if rec is None:
        raise SystemExit("no run record for window %r" % window_id)
    prompt = lb.load_prompt()
    user_text, ihash, meta = lb.build_input(
        window_id, rec["layer_a"], rec["joint"])
    print("=" * 72)
    print("SYSTEM PROMPT (prompt_version=%s, sha=%s)"
          % (lb.PROMPT_VERSION, lb.prompt_hash(prompt)[:12]))
    print("=" * 72)
    print(prompt)
    print("=" * 72)
    print("USER PAYLOAD (input_hash=%s, %s messages)" % (ihash[:12],
          meta.get("n_messages")))
    print("=" * 72)
    print(user_text)
    print("=" * 72)
    print("Respond with STRICT JSON matching the schema in the prompt:")
    print("  {topics[], entities[], discourse_moves[], wiki_nodes[],")
    print("   confidence[0,1], ambiguity, joint_read}")
    print("Calibration gate state: %s" % rec["joint"]["calibration_gate"]["state"])


def cmd_respond(window_id, json_path, trigger):
    p, rec = find_record(window_id)
    if rec is None:
        raise SystemExit("no run record for window %r" % window_id)
    with open(json_path, encoding="utf-8") as fh:
        obj = json.load(fh)
    prompt = lb.load_prompt()
    phash = lb.prompt_hash(prompt)
    user_text, ihash, meta = lb.build_input(
        window_id, rec["layer_a"], rec["joint"])
    started = time.time()
    issues = lb.validate(obj)
    gate = rec["joint"]["calibration_gate"]
    allowed, banned_hits = calibration.enforce(obj.get("joint_read", ""), gate)
    lb.audit({
        "window_id": window_id, "trigger": trigger,
        "prompt_version": lb.PROMPT_VERSION, "prompt_hash": phash,
        "model": "manual-cron-worker", "code_version": config.CODE_VERSION,
        "called_at": started, "ok": True, "input_hash": ihash,
        "input_meta": meta, "transport": "manual-cron-worker",
        "output": obj, "validation_issues": issues,
        "gate_state": gate["state"], "gate_violation": (not allowed),
        "banned_terms": banned_hits,
        "latency_sec": round(time.time() - started, 3),
    })
    joint_block = rec["joint"]
    block = {
        "available": True,
        "prompt_version": lb.PROMPT_VERSION,
        "prompt_hash": phash,
        "input_hash": ihash,
        "model": "manual-cron-worker",
        "transport": "manual-cron-worker",
        "response_id": None,
        "usage": None,
        "topics": obj.get("topics", []),
        "entities": obj.get("entities", []),
        "discourse_moves": obj.get("discourse_moves", []),
        "wiki_nodes": obj.get("wiki_nodes", []),
        "confidence": obj.get("confidence"),
        "ambiguity": obj.get("ambiguity"),
        "validation_issues": issues,
        "gate_violation": (not allowed),
        "banned_terms": banned_hits,
        "joint_read": (obj.get("joint_read") if allowed
                       else joint_block["joint_read"]),
        "joint_read_source": ("layer_b" if allowed
                              else "layer_a_deterministic_gate_block"),
    }
    rec["layer_b"] = block
    if allowed:
        rec["joint"] = dict(joint_block)
        rec["joint"]["joint_read"] = obj.get("joint_read")
        rec["joint"]["joint_read_source"] = "layer_b"
    with open(p, "w", encoding="utf-8") as fh:
        json.dump(rec, fh, sort_keys=True, indent=2, ensure_ascii=False)
    cleared = lb.clear_pending([window_id])
    print("patched %s (pending cleared: %d, gate_violation=%s, issues=%s)"
          % (p, cleared, (not allowed), issues or "none"))


def main(argv=None):
    ap = argparse.ArgumentParser(description="manual Layer B transport")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--show", action="store_true")
    g.add_argument("--respond", action="store_true")
    ap.add_argument("--window-id", required=True)
    ap.add_argument("--json", dest="json_path")
    ap.add_argument("--trigger", default="manual")
    args = ap.parse_args(argv)
    if args.show:
        cmd_show(args.window_id)
    else:
        if not args.json_path:
            raise SystemExit("--respond needs --json <file>")
        cmd_respond(args.window_id, args.json_path, args.trigger)
    return 0


if __name__ == "__main__":
    sys.exit(main())
