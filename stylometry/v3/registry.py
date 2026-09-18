"""Entity registry: matching, spike detection, candidate logging.

Identity discipline (non-negotiable):
  * The registry is APPEND-ONLY. Entries are never rewritten in place by code.
  * A phrase that does not match a confirmed entry is a CANDIDATE. Candidates
    are logged with provenance and never auto-promoted.
  * Similar names are NEVER merged. norm_key() collapses case/space/punctuation
    and nothing else. "Sam" and "Sammy" are two entities until a human says
    otherwise.
"""
import json
import math
import os
import re
import time

from . import config
from .textnorm import cap_phrases, handles, norm_key, tokens

# Capitalized words that are grammar or idiom, not reference. Kept small and
# explicit: every addition suppresses a real candidate, so it must be earned.
CAP_STOPLIST = frozenset("""
i i'm i'll i've i'd ok okay yeah yep nope lol lmao imo idk btw fyi tbh omg
monday tuesday wednesday thursday friday saturday sunday
january february march april may june july august september october november december
mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep oct nov dec
god jesus christ english american
""".split())


class Registry:
    def __init__(self, data):
        self.version = data.get("version")
        self.entries = data.get("entries", [])
        self.tier_rates = data.get("tier_rates", {})   # entity_id -> tier -> rate/token
        self.global_rates = data.get("global_rates", {})
        self._alias_index = {}
        self._max_alias_tokens = 1
        for e in self.entries:
            if e.get("status") != "confirmed":
                continue   # candidates never participate in matching
            for alias in [e["canonical"]] + list(e.get("aliases", [])):
                k = norm_key(alias)
                if not k:
                    continue
                # First writer wins; a collision is reported, never silently merged.
                if k in self._alias_index and self._alias_index[k] != e["id"]:
                    e.setdefault("_alias_collisions", []).append(
                        {"alias": alias, "held_by": self._alias_index[k]})
                    continue
                self._alias_index[k] = e["id"]
                self._max_alias_tokens = max(self._max_alias_tokens, len(k.split()))

    @classmethod
    def load(cls, path=None):
        p = path or config.ENTITY_REGISTRY
        if not os.path.exists(p):
            p = config.ENTITY_REGISTRY_STUB
        with open(p, "r", encoding="utf-8") as fh:
            return cls(json.load(fh))

    def alias_collisions(self):
        out = []
        for e in self.entries:
            for c in e.get("_alias_collisions", []):
                out.append({"entity": e["id"], **c})
        return out

    # -- matching ------------------------------------------------------------
    def match(self, text):
        """Longest-alias-first match over the token stream. Returns id -> count."""
        toks = tokens(text)
        hits = {}
        i = 0
        n = len(toks)
        while i < n:
            matched = 0
            for span in range(min(self._max_alias_tokens, n - i), 0, -1):
                key = " ".join(toks[i:i + span])
                eid = self._alias_index.get(key)
                if eid:
                    hits[eid] = hits.get(eid, 0) + 1
                    matched = span
                    break
            i += matched if matched else 1
        for h in handles(text):
            eid = self._alias_index.get(norm_key(h))
            if eid:
                hits[eid] = hits.get(eid, 0) + 1
        return dict(sorted(hits.items()))

    def expected_rate(self, entity_id, tier):
        per_tier = self.tier_rates.get(entity_id, {})
        if tier in per_tier:
            return float(per_tier[tier]), False
        if config.LONGTAIL_TIER in per_tier:
            return float(per_tier[config.LONGTAIL_TIER]), True
        return float(self.global_rates.get(entity_id, 0.0)), True


def poisson_surprise(k, lam):
    """-log10 P(X >= k | Poisson(lam)), capped. k == 0 is never a surprise."""
    if k <= 0:
        return 0.0
    lam = max(float(lam), config.ENTITY_MIN_LAMBDA)
    # P(X >= k) = 1 - sum_{i<k} e^-lam lam^i / i!
    term = math.exp(-lam)
    cum = term
    for i in range(1, k):
        term *= lam / i
        cum += term
        if cum >= 1.0:
            cum = 1.0
            break
    tail = max(1.0 - cum, 1e-300)
    return min(-math.log10(tail), config.ENTITY_SURPRISE_CAP)


def score_entities(window, registry):
    """Per-window registry mentions, spike surprise, and novel candidates."""
    text = window.text()
    n_tokens = len(tokens(text))
    hits = registry.match(text)

    # Spike is scored against the window's tier composition: a window that is
    # 80% tier A and 20% tier B gets a blended expectation, not tier A's alone.
    tier_counts = window.tier_counts()
    total_msgs = max(sum(tier_counts.values()), 1)
    tier_weights = {t: c / total_msgs for t, c in tier_counts.items()}

    per_entity = []
    fallback_used = False
    for eid, k in sorted(hits.items()):
        lam_rate = 0.0
        for t, w in sorted(tier_weights.items()):
            rate, fb = registry.expected_rate(eid, t)
            fallback_used = fallback_used or fb
            lam_rate += w * rate
        lam = lam_rate * n_tokens
        per_entity.append({
            "entity_id": eid,
            "count": k,
            "expected": config.r(lam),
            "surprise": config.r(poisson_surprise(k, lam)),
        })
    per_entity.sort(key=lambda d: (-d["surprise"], d["entity_id"]))
    max_surprise = per_entity[0]["surprise"] if per_entity else 0.0

    # -- candidates ----------------------------------------------------------
    candidates = {}
    for phrase in cap_phrases(text):
        key = norm_key(phrase)
        if not key or key in registry._alias_index:
            continue
        parts = key.split()
        if all(p in CAP_STOPLIST for p in parts):
            continue
        c = candidates.setdefault(key, {"key": key, "surface": phrase, "count": 0})
        c["count"] += 1
    cand_list = sorted(candidates.values(), key=lambda d: (-d["count"], d["key"]))

    return {
        "n_tokens": n_tokens,
        "n_registry_hits": sum(hits.values()),
        "n_distinct_entities": len(hits),
        "entities": per_entity[:25],
        "max_surprise": config.r(max_surprise),
        "tier_fallback": bool(fallback_used),
        "candidates": cand_list[:25],
        "n_candidates": len(cand_list),
    }


def log_candidates(window_meta, cand_list, path=None):
    """Append-only candidate log. Writing here NEVER changes the registry."""
    if not cand_list:
        return 0
    p = path or config.CANDIDATES_LOG
    os.makedirs(os.path.dirname(p), exist_ok=True)
    now = time.time()
    with open(p, "a", encoding="utf-8") as fh:
        for c in cand_list:
            fh.write(json.dumps({
                "observed_at": now,
                "window_id": window_meta["window_id"],
                "kind": window_meta["kind"],
                "dominant_tier": window_meta["dominant_tier"],
                "key": c["key"],
                "surface": c["surface"],
                "count": c["count"],
                "status": "candidate",
            }, sort_keys=True, ensure_ascii=False) + "\n")
    return len(cand_list)
