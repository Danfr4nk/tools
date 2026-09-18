"""Read-only bridge to v2. v3 NEVER writes into v2's tree.

v2's on-disk run-record schema is not available to this build (v3 was written
without access to the v2 source), so this adapter is deliberately tolerant: it
probes a set of plausible key spellings, and when it cannot find a field it
reports available=False rather than inventing a zero. A missing style read is
a stated gap, never a "stable" style axis.
"""
import json
import os

from . import config

PCTL_KEYS = ("percentile", "pct", "null_percentile", "divergence_percentile")
FLAG_KEYS = ("flag", "style_flag", "flagged")
ALERT_KEYS = ("alert", "style_alert", "alerted")
DIV_KEYS = ("divergence", "score", "divergence_score")
SUPPRESSED_KEYS = ("suppressed",)
MEMBER_KEYS = ("msg_ids", "message_ids", "members", "window_msg_ids")


def _first(d, keys):
    for k in keys:
        if isinstance(d, dict) and k in d and d[k] is not None:
            return d[k], k
    return None, None


def adapt(record, kind=None):
    """Normalize one v2 run record into v3's style block."""
    if not isinstance(record, dict):
        return {"available": False, "reason": "no_v2_record"}
    node = record
    # v2 may nest per-window results under the window kind.
    for probe in (kind, "windows", "results"):
        if probe and isinstance(node.get(probe), dict):
            inner = node[probe]
            if kind and isinstance(inner.get(kind), dict):
                inner = inner[kind]
            node = inner
            break
    pct, pct_key = _first(node, PCTL_KEYS)
    flag, flag_key = _first(node, FLAG_KEYS)
    alert, _ = _first(node, ALERT_KEYS)
    div, _ = _first(node, DIV_KEYS)
    supp, _ = _first(node, SUPPRESSED_KEYS)
    members, _ = _first(node, MEMBER_KEYS)
    if pct is None and flag is None:
        return {"available": False, "reason": "v2_fields_not_recognized",
                "probed_keys": sorted(set(PCTL_KEYS + FLAG_KEYS))}
    return {
        "available": True,
        "percentile": config.r(pct) if pct is not None else None,
        "divergence": config.r(div) if div is not None else None,
        "style_flag": bool(flag) if flag is not None else
                      (pct is not None and float(pct) >= config.FLAG_PCTL),
        "style_alert": bool(alert) if alert is not None else False,
        "style_suppressed": bool(supp) if supp is not None else False,
        "v2_run_id": record.get("run_id") or record.get("id"),
        "v2_window_id": node.get("window_id") or record.get("window_id"),
        "v2_member_ids": [str(x) for x in members] if members else None,
        "source_keys": {"percentile": pct_key, "flag": flag_key},
    }


def load(path, kind=None):
    if not path or not os.path.exists(str(path)):
        return {"available": False, "reason": "v2_record_missing",
                "path": str(path) if path else None}
    try:
        with open(str(path), "r", encoding="utf-8") as fh:
            txt = fh.read().strip()
        if not txt:
            return {"available": False, "reason": "v2_record_empty"}
        if txt.lstrip().startswith("{"):
            rec = json.loads(txt)
        else:                       # jsonl: take the last record
            rec = json.loads([l for l in txt.splitlines() if l.strip()][-1])
    except (ValueError, OSError) as exc:
        return {"available": False, "reason": "v2_record_unreadable",
                "error": str(exc)}
    return adapt(rec, kind=kind)
