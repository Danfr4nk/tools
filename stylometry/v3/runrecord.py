"""v3 run records. Live OUTSIDE v2's logs; joinable to v2 run records.

READ PATH FOR THE DAILY REPORT WORKER -- this is the contract:

    from v3 import runrecord
    for rec in runrecord.read_range(start_ts, end_ts):
        rec["joint"]["quadrant"]              # 2x2 cell
        rec["joint"]["joint_read"]            # the rendered paragraph
        rec["joint"]["joint_read_source"]     # layer_b | layer_a_deterministic*
        rec["joint"]["alerting"]["status"]    # ALERT | ONGOING | CLEAR
        rec["joint"]["calibration_gate"]["state"]
        rec["layer_a"]["semantic_percentile"]
        rec["layer_b"]                        # may be {"available": False, ...}

Files: runs/YYYY-MM-DD/<window_id>.json  (one file per scored window).
A window id is content-addressed, so re-scoring the same window overwrites an
identical record and never forks history.
"""
import json
import os
import time

from . import config

SCHEMA_VERSION = "v3-run-1"


def _day(ts):
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def sanitize(window_id):
    """Filesystem-safe name. NOT reversible -- window kinds contain "_"."""
    return window_id.replace(":", "_").replace("/", "_")


def path_for(window_id, end_ts, base=None):
    return os.path.join(str(base or config.RUNS_DIR), _day(end_ts),
                        sanitize(window_id) + ".json")


def build(layer_a, joint_block, layer_b, v2_style, adjacency, run_ts,
          inputs_hash, stored_path=None):
    return {
        "schema_version": SCHEMA_VERSION,
        "code_version": config.CODE_VERSION,
        "run_ts": run_ts,
        "window_id": layer_a["window"]["window_id"],
        "window": layer_a["window"],
        "inputs_hash": inputs_hash,
        "artifact_hashes": layer_a["artifact_hashes"],
        "window_store_path": stored_path,
        "layer_a": layer_a,
        "layer_b": layer_b,
        "joint": joint_block,
        "v2": {
            "style": v2_style,
            "adjacency_divergence": adjacency,
            "window_semantics_note": (
                "v3 windows are built independently of v2. v2's tier-adjacency "
                "bug is NOT inherited. Differing member sets are expected; "
                "adjacency_divergence is null when v2 membership is unavailable, "
                "which is not agreement."),
        },
    }


def write(record, base=None):
    p = path_for(record["window_id"], record["window"]["end_ts"], base)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(record, fh, sort_keys=True, indent=2, ensure_ascii=False)
    os.replace(tmp, p)
    return p


def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def iter_paths(base=None, days=None):
    """Yield run-record paths. `days` restricts to specific YYYY-MM-DD dirs --
    without it a year of 30-minute runs is ~35k files, which is not a scan any
    caller should pay for by accident."""
    root = str(base or config.RUNS_DIR)
    if not os.path.isdir(root):
        return
    wanted = set(days) if days else None
    for day in sorted(os.listdir(root)):
        if wanted is not None and day not in wanted:
            continue
        d = os.path.join(root, day)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(d)):
            if name.endswith(".json"):
                yield os.path.join(d, name)


def days_spanning(start_ts, end_ts):
    """UTC day dirs touched by a range, plus one either side for boundary slop."""
    out = []
    t = start_ts - 86400
    while t <= end_ts + 86400:
        out.append(_day(t))
        t += 86400
    return sorted(set(out))


def read_range(start_ts, end_ts, base=None):
    """Every record whose window ENDS inside [start_ts, end_ts]. Chronological.

    Only the day directories spanning the range are opened."""
    out = []
    for p in iter_paths(base, days=days_spanning(start_ts, end_ts)):
        try:
            rec = read(p)
        except (ValueError, OSError):
            continue
        ts = rec.get("window", {}).get("end_ts")
        if ts is None or not (start_ts <= ts <= end_ts):
            continue
        out.append(rec)
    out.sort(key=lambda r: (r["window"]["end_ts"], r["window_id"]))
    return out


def read_day(day_str, base=None):
    """day_str = 'YYYY-MM-DD' (UTC)."""
    t0 = time.mktime(time.strptime(day_str + " +0000", "%Y-%m-%d %z"))
    return read_range(t0, t0 + 86400 - 1e-6, base)
