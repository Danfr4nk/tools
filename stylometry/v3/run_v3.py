#!/usr/bin/env python3
"""v3 fast-loop entry point. Called by the 30-minute cron alongside v2.

    python3 -m v3.run_v3 --messages out.jsonl [--v2-record v2run.json]

Layer A always runs and never touches the network. Layer B fires only on its
trigger conditions, and an unreachable Layer B queues the window rather than
failing the run.

Input contract (JSONL, one object per outbound message):
    {"msg_id": str, "ts": epoch_seconds_utc, "tier": str,
     "recipient": str, "text": str, "direction": "out"}
"""
import argparse
import json
import subprocess
import sys
import time

from . import (config, joint as joint_mod, layer_a as la, layer_b as lb,
               registry as reg, runrecord, topics, v2_bridge, window_store,
               windows as win)


def load_message_rows(args):
    if args.messages_cmd:
        out = subprocess.run(args.messages_cmd, shell=True, check=True,
                             capture_output=True, text=True).stdout
        lines = out.splitlines()
    elif args.messages == "-":
        lines = sys.stdin.read().splitlines()
    else:
        with open(args.messages, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    return [json.loads(l) for l in lines if l.strip()]


def score_one(window, registry_obj, profiles, null, v2_style, now_ts,
              trigger="auto", commit=True, transport=None, dry_run=False):
    layer_a = la.score_window(window, registry_obj, profiles, null)
    ihash = la.inputs_hash(window, layer_a)
    joint_block = joint_mod.build_joint(layer_a, v2_style, now_ts,
                                        commit=commit)

    # Store the window iff EITHER layer flagged it. Layer B may need the text
    # later (backfill, digest) and re-querying the DB would break reproducibility.
    stored_path = None
    reason = None
    if layer_a["semantic_flag"] and (v2_style or {}).get("style_flag"):
        reason = "v2_flag+semantic_flag"
    elif layer_a["semantic_flag"]:
        reason = "semantic_flag"
    elif (v2_style or {}).get("style_flag"):
        reason = "v2_flag"
    if reason and not dry_run:
        stored_path, _ = window_store.write(window, reason)

    if registry_obj and layer_a["candidates"] and not dry_run:
        reg.log_candidates(layer_a["window"], layer_a["candidates"])

    layer_b_block = {"available": False, "reason": "not_triggered"}
    fire, fired_by, skip = lb.should_fire(layer_a, joint_block, trigger, now_ts,
                                          commit=commit)
    if fire and stored_path and not dry_run:
        layer_b_block = lb.run(window.window_id, layer_a, joint_block,
                               fired_by or trigger, transport=transport)
        if layer_b_block.get("available"):
            joint_block = dict(joint_block)
            joint_block["joint_read"] = layer_b_block["joint_read"]
            joint_block["joint_read_source"] = layer_b_block["joint_read_source"]
    elif fire and not stored_path:
        layer_b_block = {"available": False, "reason": "window_not_stored"}
    elif skip:
        layer_b_block = {"available": False, "reason": skip}

    adjacency = win.adjacency_divergence(window, (v2_style or {}).get("v2_member_ids"))
    return runrecord.build(layer_a, joint_block, layer_b_block, v2_style,
                           adjacency, now_ts, ihash, stored_path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="stylometry v3 fast loop")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--messages", help="JSONL path, or - for stdin")
    src.add_argument("--messages-cmd", help="shell command emitting JSONL")
    ap.add_argument("--v2-record", help="v2 run record (json or jsonl)")
    ap.add_argument("--now", type=float, default=None, help="override now (epoch)")
    ap.add_argument("--trigger", default="auto", choices=("auto", "manual"))
    ap.add_argument("--dry-run", action="store_true",
                    help="score and print; write nothing, call nothing")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    now_ts = args.now if args.now is not None else time.time()
    if not args.dry_run:
        config.ensure_dirs()

    rows = load_message_rows(args)
    messages = win.parse_messages(rows)
    registry_obj = reg.Registry.load()
    profiles = topics.TopicProfiles.load()
    null = topics.SemanticNull.load()

    written = []
    for window in win.build_windows(messages, now_ts):
        v2_style = v2_bridge.load(args.v2_record, kind=window.kind)
        rec = score_one(window, registry_obj, profiles, null, v2_style, now_ts,
                        trigger=args.trigger, commit=not args.dry_run,
                        dry_run=args.dry_run)
        if not args.dry_run:
            written.append(runrecord.write(rec))
        if not args.quiet:
            j = rec["joint"]
            print("%-15s %-14s %-32s %s"
                  % (window.kind, j["alerting"]["status"], j["quadrant"],
                     rec["window_id"]))
            print("   %s" % j["joint_read"])
    if written and not args.quiet:
        print("wrote %d run record(s)" % len(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
