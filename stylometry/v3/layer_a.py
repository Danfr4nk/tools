"""Layer A: lexical-semantic scoring. Stdlib only. ZERO NETWORK.

Runs inside the 30-minute loop alongside v2. Every number here is a pure
function of (window messages, registry, profiles, null, config, code version),
so verify_replay_v3.py can reproduce it exactly.
"""
import hashlib
import json
import os

from . import config, discourse, registry as reg, topics

AXES = ("topic", "entity", "discourse")


def artifact_hash(path, stub):
    p = path if os.path.exists(path) else stub
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def artifact_hashes():
    return {
        "entity_registry": artifact_hash(str(config.ENTITY_REGISTRY),
                                         str(config.ENTITY_REGISTRY_STUB)),
        "topic_profiles": artifact_hash(str(config.TOPIC_PROFILES),
                                        str(config.TOPIC_PROFILES_STUB)),
        "semantic_null": artifact_hash(str(config.SEMANTIC_NULL),
                                       str(config.SEMANTIC_NULL_STUB)),
    }


def _entity_percentile(ent, window, null):
    tier = window.dominant_tier()
    n_tok = ent["n_tokens"]
    pct, meta = null.percentile("entity", tier, n_tok, ent["max_surprise"])
    return pct, meta, null.robust_z("entity", tier, n_tok, ent["max_surprise"])


def score_window(window, registry_obj, profiles, null):
    ent = reg.score_entities(window, registry_obj)
    top = topics.score_topics(window, profiles, null)
    dis = discourse.score_discourse(window, profiles, null)

    e_pct, e_null, e_z = _entity_percentile(ent, window, null)
    ent_axis = {
        "available": e_pct is not None,
        "reason": None if e_pct is not None else "null_unavailable",
        "max_surprise": ent["max_surprise"],
        "percentile": e_pct,
        "robust_z": e_z,
        "null": e_null,
        "tier_fallback": ent["tier_fallback"],
    }

    axes = {"topic": top, "entity": ent_axis, "discourse": dis}
    avail = {a: axes[a] for a in AXES if axes[a].get("percentile") is not None}

    if avail:
        dominant = max(sorted(avail), key=lambda a: avail[a]["percentile"])
        semantic_percentile = avail[dominant]["percentile"]
        excess = 0.0
        for a in sorted(avail):
            z = avail[a].get("robust_z")
            if z is not None and z > 0:
                excess += z * z
        composite_excess = config.r(excess ** 0.5)
        semantic_flag = semantic_percentile >= config.FLAG_PCTL
        strong = semantic_percentile >= config.STRONG_PCTL
    else:
        dominant = None
        semantic_percentile = None
        composite_excess = None
        semantic_flag = False
        strong = False

    tier_fallback = any(axes[a].get("tier_fallback") for a in AXES)
    unavailable = sorted(a for a in AXES if axes[a].get("percentile") is None)

    confidence, ambiguity = _confidence(window, axes, unavailable, tier_fallback,
                                        profiles, null)

    return {
        "window": window.meta(),
        "axes": axes,
        "candidates": ent["candidates"],
        "n_candidates": ent["n_candidates"],
        "semantic_percentile": semantic_percentile,
        "composite_excess": composite_excess,
        "dominant_axis": dominant,
        "semantic_flag": bool(semantic_flag),
        "semantic_strong": bool(strong),
        "axes_unavailable": unavailable,
        "tier_fallback": bool(tier_fallback),
        "confidence": config.r(confidence),
        "ambiguity": ambiguity,
        "artifact_hashes": artifact_hashes(),
        "code_version": config.CODE_VERSION,
        "thresholds": {"flag_pctl": config.FLAG_PCTL,
                       "strong_pctl": config.STRONG_PCTL},
    }


def _confidence(window, axes, unavailable, tier_fallback, profiles, null):
    """Deterministic. Starts at 1.0 and is debited for every stated weakness."""
    c = 1.0
    notes = []
    if not profiles.built:
        c -= 0.45
        notes.append("topic profiles unbuilt: topic axis is dead, not quiet")
    if not null.built:
        c -= 0.35
        notes.append("semantic null unbuilt: percentiles are not calibrated")
    for a in unavailable:
        c -= 0.12
        notes.append("%s axis unavailable (%s)" % (a, axes[a].get("reason")))
    if tier_fallback:
        c -= 0.10
        notes.append("longtail tier fallback in use: expectation is not this tier's")
    if window.n_messages < 8:
        c -= 0.15
        notes.append("thin window: %d messages" % window.n_messages)
    for a in AXES:
        nm = axes[a].get("null") or {}
        if nm.get("available") and nm.get("fallback_level", 0) > 0:
            c -= 0.05
            notes.append("%s null fell back to stratum %s" % (a, nm.get("stratum")))
        if nm.get("available") and nm.get("n", 0) < 200:
            c -= 0.05
            notes.append("%s null stratum thin (n=%d)" % (a, nm.get("n", 0)))
    if axes["discourse"].get("percentile") is not None:
        notes.append("discourse axis is a lexicon proxy, not a parse")
    return max(0.0, min(1.0, c)), "; ".join(notes) if notes else "none stated"


def inputs_hash(window, layer_a_result):
    """Identity of everything Layer A consumed. Replay compares this first."""
    payload = {
        "window_id": window.window_id,
        "msg_ids": [m.msg_id for m in window.messages],
        "msg_hashes": [m.as_store_row()["msg_hash"] for m in window.messages],
        "artifact_hashes": layer_a_result["artifact_hashes"],
        "code_version": config.CODE_VERSION,
        "thresholds": layer_a_result["thresholds"],
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()
