"""Calibration gate. Higher bar than v2's, and it is enforced in code.

Until five genuinely distinct labeled episodes exist -- deduped by
(label, date) -- v3 emits description and joint reads only. No state-signature
claims. The gate is checked on every render path, not just on the LLM path.
"""
import json
import os

from . import config


def load_labels(path=None):
    p = str(path or config.LABELS_LOG)
    if not os.path.exists(p):
        return []
    rows = []
    with open(p, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def gate_status(path=None):
    rows = load_labels(path)
    episodes = set()
    labels = set()
    for r in rows:
        lab = str(r.get("label", "")).strip().lower()
        date = str(r.get("date", "")).strip()[:10]
        if not lab or not date:
            continue
        episodes.add((lab, date))
        labels.add(lab)
    n = len(episodes)
    return {
        "state": "OPEN" if n < config.CALIBRATION_MIN_EPISODES else "MET",
        "n_episodes": n,
        "n_distinct_labels": len(labels),
        "required": config.CALIBRATION_MIN_EPISODES,
        "episodes": sorted(episodes),
        "note": ("state-signature claims are BLOCKED until %d distinct "
                 "(label, date) episodes exist" % config.CALIBRATION_MIN_EPISODES),
    }


def scan_banned(text):
    """Return the state-signature terms present in a rendered read."""
    low = (text or "").lower()
    return sorted({t for t in config.BANNED_STATE_TERMS if t in low})


def enforce(text, gate=None):
    """-> (allowed, hits). The caller substitutes the deterministic read on False.

    Model output is NEVER edited or deleted here -- it is archived in full by
    the audit log. This only decides what gets rendered."""
    g = gate or gate_status()
    hits = scan_banned(text)
    if g["state"] == "MET":
        return True, hits
    return (not hits), hits
