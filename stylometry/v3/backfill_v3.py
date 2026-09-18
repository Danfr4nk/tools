#!/usr/bin/env python3
"""Drain the Layer B queue. Optionally via the Batch API at 50% cost.

    python3 -m v3.backfill_v3 [--batch] [--limit N]

Sequential mode calls one window at a time (simple, immediate). Batch mode
submits every queued window in one Message Batch and polls -- the right mode
for a queue that built up while the box was offline, because backfill is by
definition not latency-sensitive.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

from . import config, layer_b as lb, runrecord


def _headers():
    var, key = lb._api_key()
    h = {"content-type": "application/json",
         "anthropic-version": config.API_VERSION}
    if var == "ANTHROPIC_API_KEY":
        h["x-api-key"] = key
    else:
        h["authorization"] = "Bearer " + key
        h["anthropic-beta"] = "oauth-2025-04-20"
    return h


def _req(method, path, body=None):
    r = urllib.request.Request(config.API_BASE.rstrip("/") + path,
                               data=json.dumps(body).encode("utf-8") if body else None,
                               headers=_headers(), method=method)
    with urllib.request.urlopen(r, timeout=config.LAYER_B_TIMEOUT_SEC) as resp:
        return resp.read().decode("utf-8")


def build_index(runs_base=None):
    """sanitized-basename -> path, built once.

    The naive version rescanned every run record for every queued window:
    50 queued windows against a year of 30-minute runs is ~1.7M file reads.

    Keyed by the SANITIZED name, not by a reversal of it: sanitization maps
    ":" -> "_" and window kinds already contain underscores, so
    "v3_trailing_hours_..." cannot be turned back into a window id."""
    idx = {}
    for p in runrecord.iter_paths(runs_base):
        idx[os.path.basename(p)[:-len(".json")]] = p
    return idx


def find_record(window_id, index, runs_base=None):
    p = index.get(runrecord.sanitize(window_id))
    if p is None:
        return None, None
    try:
        rec = runrecord.read(p)
    except (ValueError, OSError):
        return None, None
    return (p, rec) if rec.get("window_id") == window_id else (None, None)


def submit_batch(items):
    """items: [(window_id, payload)] -> batch id."""
    body = {"requests": [{"custom_id": wid.replace(":", "_")[:64],
                          "params": payload} for wid, payload in items]}
    return json.loads(_req("POST", "/v1/messages/batches", body))["id"]


def poll_batch(batch_id, interval=60, timeout=24 * 3600):
    deadline = time.time() + timeout
    while time.time() < deadline:
        b = json.loads(_req("GET", "/v1/messages/batches/" + batch_id))
        if b.get("processing_status") == "ended":
            return b
        time.sleep(interval)
    raise lb.LayerBUnavailable("batch %s did not end within timeout" % batch_id)


def fetch_results(batch_id):
    """Results arrive in ANY order -- keyed by custom_id, never by position."""
    txt = _req("GET", "/v1/messages/batches/%s/results" % batch_id)
    out = {}
    for line in txt.splitlines():
        if line.strip():
            obj = json.loads(line)
            out[obj["custom_id"]] = obj
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", action="store_true", help="use the Batch API (50%% cost)")
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--runs", default=None)
    ap.add_argument("--poll-interval", type=int, default=60)
    args = ap.parse_args(argv)

    queued = lb.pending()[:args.limit]
    if not queued:
        print("queue empty")
        return 0
    print("%d queued window(s)" % len(queued))
    index = build_index(args.runs)

    done = []
    if not args.batch:
        for row in queued:
            wid = row["window_id"]
            p, rec = find_record(wid, index, args.runs)
            if rec is None:
                print("  %s: no run record; dropping from queue" % wid)
                done.append(wid)
                continue
            block = lb.run(wid, rec["layer_a"], rec["joint"],
                           row.get("trigger", "manual"))
            if block.get("available"):
                rec["layer_b"] = block
                rec["joint"]["joint_read"] = block["joint_read"]
                rec["joint"]["joint_read_source"] = block["joint_read_source"]
                rec["backfilled_at"] = time.time()
                runrecord.write(rec, args.runs)
                done.append(wid)
                print("  %s: backfilled" % wid)
            else:
                print("  %s: still failing (%s)" % (wid, block.get("reason")))
        lb.clear_pending(done)
        print("backfilled %d" % len(done))
        return 0

    items = []
    index = {}
    for row in queued:
        wid = row["window_id"]
        p, rec = find_record(wid, index, args.runs)
        if rec is None:
            done.append(wid)
            continue
        try:
            user_text, ihash, _ = lb.build_input(wid, rec["layer_a"], rec["joint"])
        except lb.LayerBUnavailable as exc:
            print("  %s: %s" % (wid, exc))
            continue
        payload = lb.build_payload(user_text)
        cid = wid.replace(":", "_")[:64]
        index[cid] = (wid, rec, ihash)
        items.append((wid, payload))
    if not items:
        lb.clear_pending(done)
        print("nothing batchable")
        return 0

    bid = submit_batch(items)
    print("batch %s submitted (%d requests); polling" % (bid, len(items)))
    poll_batch(bid, interval=args.poll_interval)
    results = fetch_results(bid)
    phash = lb.prompt_hash()
    for cid, res in sorted(results.items()):
        wid, rec, ihash = index.get(cid, (None, None, None))
        if rec is None:
            continue
        if res.get("result", {}).get("type") != "succeeded":
            print("  %s: %s" % (wid, res.get("result", {}).get("type")))
            continue
        msg = res["result"]["message"]
        try:
            obj = lb.extract_json(msg)
        except lb.LayerBUnavailable as exc:
            lb.audit({"window_id": wid, "ok": False, "error": str(exc),
                      "batch_id": bid, "input_hash": ihash})
            continue
        from . import calibration
        gate = rec["joint"]["calibration_gate"]
        allowed, hits = calibration.enforce(obj.get("joint_read", ""), gate)
        lb.audit({"window_id": wid, "ok": True, "batch_id": bid,
                  "input_hash": ihash, "prompt_hash": phash,
                  "prompt_version": lb.PROMPT_VERSION, "output": obj,
                  "usage": msg.get("usage", {}), "gate_state": gate["state"],
                  "gate_violation": (not allowed), "banned_terms": hits,
                  "validation_issues": lb.validate(obj),
                  "code_version": config.CODE_VERSION, "called_at": time.time()})
        rec["layer_b"] = {
            "available": True, "prompt_hash": phash, "input_hash": ihash,
            "prompt_version": lb.PROMPT_VERSION, "transport": "batch-api",
            "batch_id": bid, "usage": msg.get("usage", {}),
            "topics": obj.get("topics", []), "entities": obj.get("entities", []),
            "discourse_moves": obj.get("discourse_moves", []),
            "wiki_nodes": obj.get("wiki_nodes", []),
            "confidence": obj.get("confidence"), "ambiguity": obj.get("ambiguity"),
            "gate_violation": (not allowed), "banned_terms": hits,
            "validation_issues": lb.validate(obj),
            "joint_read": (obj.get("joint_read") if allowed
                           else rec["joint"]["joint_read"]),
            "joint_read_source": ("layer_b" if allowed
                                  else "layer_a_deterministic_gate_block"),
        }
        rec["joint"]["joint_read"] = rec["layer_b"]["joint_read"]
        rec["joint"]["joint_read_source"] = rec["layer_b"]["joint_read_source"]
        rec["backfilled_at"] = time.time()
        runrecord.write(rec, args.runs)
        done.append(wid)
    lb.clear_pending(done)
    print("backfilled %d of %d" % (len(done), len(items)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
