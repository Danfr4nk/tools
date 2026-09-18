"""Persistent per-window message store.

Written at SCORING time for every flagged window (v2 style flag OR v3 semantic
flag -- see BURNIN-V3.md for why both). Layer B reads from here and NEVER
re-queries the message DB: that is what makes a Layer B call reproducible
against the exact text that produced the numbers.

Unflagged windows are not stored.
"""
import json
import os

from . import config


def path_for(window_id, base=None):
    from .runrecord import sanitize
    return os.path.join(str(base or config.WINDOWS_DIR),
                        sanitize(window_id) + ".jsonl")


def write(window, reason, base=None):
    """Idempotent: an existing store file for this window id is left alone --
    window ids are content-addressed, so a rewrite could only be identical."""
    p = path_for(window.window_id, base)
    if os.path.exists(p):
        return p, False
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        header = dict(window.meta())
        header["record"] = "header"
        header["stored_reason"] = reason
        header["code_version"] = config.CODE_VERSION
        fh.write(json.dumps(header, sort_keys=True, ensure_ascii=False) + "\n")
        for m in window.messages:
            row = m.as_store_row()
            row["record"] = "message"
            fh.write(json.dumps(row, sort_keys=True, ensure_ascii=False) + "\n")
    os.replace(tmp, p)
    return p, True


def read(window_id, base=None):
    p = path_for(window_id, base)
    if not os.path.exists(p):
        return None
    header = None
    rows = []
    with open(p, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("record") == "header":
                header = obj
            else:
                rows.append(obj)
    return {"header": header, "messages": rows}


def exists(window_id, base=None):
    return os.path.exists(path_for(window_id, base))
