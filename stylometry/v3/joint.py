"""The 2x2 joint matrix, the deterministic joint read, and alert arbitration.

Neither axis is ever reported alone. Topic is TASK-coupled, not STATE-coupled:
a semantic shift with a stable style read is almost always a new task, and
rendering it as a state signal is the single most likely way this instrument
lies to its user.
"""
import json
import os
import time

from . import calibration, config

QUADRANTS = {
    (True, True): "state_change_or_new_domain",
    (True, False): "state_shift_familiar_content",
    (False, True): "new_task_same_state",
    (False, False): "baseline",
}

QUADRANT_GLOSS = {
    "state_change_or_new_domain":
        "Style moved and content moved. Genuine state change OR new-domain "
        "stress -- these are not separable from the numbers alone. Check "
        "labels and self-reports before distinguishing.",
    "state_shift_familiar_content":
        "Style moved, content did not. Highest-value quadrant for a state "
        "tracker: the same subject matter delivered differently.",
    "new_task_same_state":
        "Content moved, style did not. Expected. New task, same state. "
        "Context only -- this is not a state signal on its own.",
    "baseline":
        "Both axes inside their historical range for this tier.",
}


def quadrant_of(style_shift, semantic_shift):
    return QUADRANTS[(bool(style_shift), bool(semantic_shift))]


def _fmt_pct(p):
    return "n/a" if p is None else ("p%.1f" % (100.0 * p))


def deterministic_joint_read(layer_a, v2_style, quad, gate):
    """Layer A's own joint read. Exists so the fast loop NEVER depends on the
    slow layer, and so a gate-blocked LLM read always has a replacement."""
    w = layer_a["window"]
    axes = layer_a["axes"]
    parts = []
    parts.append(
        "%s / %s window ending %s, %d msgs, dominant tier %s%s."
        % (quad.replace("_", "-"), w["kind"],
           time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(w["end_ts"])),
           w["n_messages"], w["dominant_tier"],
           " (tier fallback)" if layer_a["tier_fallback"] else ""))
    parts.append(QUADRANT_GLOSS[quad])
    parts.append(
        "Style: %s%s. Semantic: %s, dominant axis %s (topic %s, entity %s, "
        "discourse %s)."
        % (_fmt_pct((v2_style or {}).get("percentile")),
           "" if (v2_style or {}).get("available", False) else " [v2 read unavailable]",
           _fmt_pct(layer_a["semantic_percentile"]),
           layer_a["dominant_axis"] or "none",
           _fmt_pct(axes["topic"].get("percentile")),
           _fmt_pct(axes["entity"].get("percentile")),
           _fmt_pct(axes["discourse"].get("percentile"))))
    if layer_a["axes_unavailable"]:
        parts.append("Axes unavailable: %s." % ", ".join(layer_a["axes_unavailable"]))
    parts.append("Confidence %.2f. Ambiguity: %s."
                 % (layer_a["confidence"], layer_a["ambiguity"]))
    parts.append("Gate %s (%d/%d episodes): shift, not diagnosis."
                 % (gate["state"], gate["n_episodes"], gate["required"]))
    return " ".join(parts)


# -- alert arbitration -------------------------------------------------------

def _load_state(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError):
        return {}


def _save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, sort_keys=True, indent=2)
    os.replace(tmp, path)


def signature(window_kind, dominant_axis):
    return "%s:%s" % (window_kind, dominant_axis or "none")


def arbitrate(layer_a, quad, now_ts, state_path=None, cooldown=None,
              commit=True):
    """flag is measurement and is ALWAYS recorded. alert is a notification
    decision. A suppressed flag renders ONGOING and is never read as clean."""
    path = str(state_path or config.ALERT_STATE)
    cd = config.ALERT_COOLDOWN_SEC if cooldown is None else cooldown
    sig = signature(layer_a["window"]["kind"], layer_a["dominant_axis"])
    state = _load_state(path)
    last = state.get(sig, {}).get("last_alert_ts")

    flag = layer_a["semantic_flag"]
    alert = False
    suppressed = False
    reason = None

    if not flag:
        reason = "no_flag"
    elif quad == "new_task_same_state":
        suppressed = True
        reason = "quadrant_task_confound"
    elif last is not None and (now_ts - float(last)) < cd:
        suppressed = True
        reason = "cooldown"
    else:
        alert = True
        reason = "fired"
        if commit:
            state[sig] = {"last_alert_ts": now_ts,
                          "window_id": layer_a["window"]["window_id"]}
            _save_state(path, state)

    if flag and not alert:
        status = "ONGOING"
    elif flag and alert:
        status = "ALERT"
    else:
        status = "CLEAR"

    return {
        "semantic_flag": bool(flag),
        "semantic_alert": bool(alert),
        "suppressed": bool(suppressed),
        "suppression_reason": reason,
        "signature": sig,
        "cooldown_sec": cd,
        "seconds_since_last_alert": (None if last is None
                                     else config.r(now_ts - float(last))),
        "status": status,
    }


def build_joint(layer_a, v2_style, now_ts, state_path=None, commit=True,
                gate=None):
    g = gate or calibration.gate_status()
    style_shift = bool((v2_style or {}).get("style_flag"))
    quad = quadrant_of(style_shift, layer_a["semantic_flag"])
    alerting = arbitrate(layer_a, quad, now_ts, state_path=state_path,
                         commit=commit)
    return {
        "quadrant": quad,
        "quadrant_gloss": QUADRANT_GLOSS[quad],
        "style_shift": style_shift,
        "semantic_shift": bool(layer_a["semantic_flag"]),
        "style": v2_style or {"available": False},
        "alerting": alerting,
        "calibration_gate": g,
        "joint_read": deterministic_joint_read(layer_a, v2_style, quad, g),
        "joint_read_source": "layer_a_deterministic",
    }
