"""Topic-mix divergence + the shared stratified-null lookup.

Profiles are built by build_topic_profiles.py using the log-odds-ratio with an
informative Dirichlet prior (Monroe, Colaresi & Quinn 2008 -- "fightin' words"),
which is the right estimator here because raw frequency ranking is dominated by
function words and plain log-odds blows up on rare terms.
"""
import bisect
import json
import math
import os

from . import config
from .textnorm import tokens

SIZE_BUCKETS = ((0, 150), (150, 400), (400, 1000), (1000, 10 ** 9))


def size_bucket(n_tokens):
    for lo, hi in SIZE_BUCKETS:
        if lo <= n_tokens < hi:
            return "%d-%d" % (lo, hi if hi < 10 ** 9 else 0)
    return "0-0"


def _load(path, stub):
    p = path if os.path.exists(path) else stub
    with open(p, "r", encoding="utf-8") as fh:
        d = json.load(fh)
    d["_source_path"] = str(p)
    return d


class TopicProfiles:
    def __init__(self, data):
        self.data = data
        self.status = data.get("status", "unbuilt")
        self.tiers = data.get("tiers", {})
        self.discourse = data.get("discourse", {})

    @classmethod
    def load(cls, path=None):
        return cls(_load(str(path or config.TOPIC_PROFILES),
                         str(config.TOPIC_PROFILES_STUB)))

    @property
    def built(self):
        return self.status == "built"

    def profile_for(self, tier):
        """Returns (weights, vocab_set, tier_fallback)."""
        if tier in self.tiers:
            return self.tiers[tier]["weights"], False
        if config.LONGTAIL_TIER in self.tiers:
            return self.tiers[config.LONGTAIL_TIER]["weights"], True
        return {}, True


class SemanticNull:
    """Stratified null. strata[axis][tier|size_bucket] -> sorted value list."""

    def __init__(self, data):
        self.data = data
        self.status = data.get("status", "unbuilt")
        self.strata = data.get("strata", {})

    @classmethod
    def load(cls, path=None):
        return cls(_load(str(path or config.SEMANTIC_NULL),
                         str(config.SEMANTIC_NULL_STUB)))

    @property
    def built(self):
        return self.status == "built"

    def lookup(self, axis, tier, n_tokens):
        """-> (values, stratum_key, fallback_level). fallback_level 0=exact."""
        fam = self.strata.get(axis, {})
        bkt = size_bucket(n_tokens)
        for level, key in enumerate(("%s|%s" % (tier, bkt),
                                     "%s|%s" % (config.LONGTAIL_TIER, bkt),
                                     "*|%s" % bkt,
                                     "*|*")):
            vals = fam.get(key)
            if vals:
                return vals, key, level
        return None, None, 99

    @staticmethod
    def degenerate(vals):
        """A stratum with no spread cannot discriminate anything.

        This is not a corner case: an entity axis whose registry is empty, or a
        tier where a proxy is constant, produces an all-identical null. Ranking
        against it with bisect_right returns percentile 1.0 for a perfectly
        typical observation -- a permanent false flag. Such a stratum reports
        unavailable instead of a number."""
        return not vals or vals[0] == vals[-1]

    def percentile(self, axis, tier, n_tokens, value):
        vals, key, level = self.lookup(axis, tier, n_tokens)
        if not vals or value is None:
            return None, {"stratum": key, "fallback_level": level, "n": 0,
                          "available": False, "degenerate": False}
        if self.degenerate(vals):
            return None, {"stratum": key, "fallback_level": level,
                          "n": len(vals), "available": False,
                          "degenerate": True}
        # Mid-p rank: ties contribute half their mass. bisect_right alone puts
        # an observation equal to the null's mode at the top of the
        # distribution; bisect_left alone puts it at the bottom. Neither is
        # true, and on a discrete statistic (entity surprise is mostly 0) the
        # difference is the whole answer.
        lo = bisect.bisect_left(vals, value)
        hi = bisect.bisect_right(vals, value)
        pct = (lo + 0.5 * (hi - lo)) / float(len(vals))
        return config.r(pct), {"stratum": key, "fallback_level": level,
                               "n": len(vals), "available": True,
                               "degenerate": False}

    def robust_z(self, axis, tier, n_tokens, value):
        vals, _, _ = self.lookup(axis, tier, n_tokens)
        if not vals or value is None or self.degenerate(vals):
            return None
        med = vals[len(vals) // 2]
        devs = sorted(abs(v - med) for v in vals)
        mad = devs[len(devs) // 2]
        if mad <= config.MAD_FLOOR:
            # Spread exists but the middle half is flat: fall back to the
            # inter-decile range rather than dividing by a floor, which would
            # manufacture a z in the hundreds.
            spread = vals[int(0.9 * (len(vals) - 1))] - vals[int(0.1 * (len(vals) - 1))]
            if spread <= config.MAD_FLOOR:
                return None
            mad = spread / 2.563
        return config.r(0.6745 * (value - med) / mad)


# -- vectors -----------------------------------------------------------------

def term_vector(text, vocab):
    """Sublinear-tf vector restricted to vocab, plus coverage diagnostics."""
    toks = tokens(text)
    n = len(toks)
    counts = {}
    inv = 0
    for t in toks:
        if t in vocab:
            counts[t] = counts.get(t, 0) + 1
            inv += 1
    vec = {t: 1.0 + math.log(c) for t, c in counts.items()}
    norm = math.sqrt(sum(v * v for v in vec.values()))
    if norm > 0:
        vec = {t: v / norm for t, v in vec.items()}
    return vec, n, (inv / n if n else 0.0)


def cosine_divergence(vec, weights):
    """1 - cos. Both vectors are non-negative, so the range is [0, 1]."""
    wnorm = math.sqrt(sum(v * v for v in weights.values()))
    if wnorm <= 0 or not vec:
        return None
    dot = sum(v * weights.get(t, 0.0) for t, v in vec.items())
    return config.r(max(0.0, 1.0 - dot / wnorm))


def chi_square(vec, weights):
    """Secondary statistic. Reported, never the flag driver."""
    wnorm = sum(weights.values())
    if wnorm <= 0 or not vec:
        return None
    vnorm = sum(vec.values()) or 1.0
    acc = 0.0
    for t, w in weights.items():
        e = w / wnorm
        o = vec.get(t, 0.0) / vnorm
        acc += (o - e) ** 2 / (e + 1e-12)
    return config.r(acc)


def score_topics(window, profiles, null):
    """Per-tier sub-scoring, token-weighted aggregate. Never scores across tiers
    with one profile -- that is the mistake that makes a mixed window look like
    a topic shift when it is only a tier shift."""
    if not profiles.built:
        return {"available": False, "reason": "profiles_unbuilt",
                "divergence": None, "percentile": None, "robust_z": None,
                "tier_fallback": False, "per_tier": []}

    by_tier = {}
    for m in window.messages:
        by_tier.setdefault(m.tier, []).append(m.text)

    per_tier = []
    fallback = False
    wsum = 0.0
    dsum = 0.0
    for tier in sorted(by_tier):
        text = "\n".join(by_tier[tier])
        weights, fb = profiles.profile_for(tier)
        fallback = fallback or fb
        vocab = frozenset(weights)
        vec, n_tok, cov = term_vector(text, vocab)
        if n_tok < config.MIN_WINDOW_TOKENS or cov < config.MIN_PROFILE_COVERAGE:
            per_tier.append({"tier": tier, "n_tokens": n_tok,
                             "coverage": config.r(cov), "divergence": None,
                             "chi2": None, "tier_fallback": fb,
                             "skipped": "insufficient_signal"})
            continue
        div = cosine_divergence(vec, weights)
        per_tier.append({"tier": tier, "n_tokens": n_tok,
                         "coverage": config.r(cov), "divergence": div,
                         "chi2": chi_square(vec, weights), "tier_fallback": fb,
                         "skipped": None})
        if div is not None:
            dsum += div * n_tok
            wsum += n_tok

    if wsum <= 0:
        return {"available": False, "reason": "insufficient_coverage",
                "divergence": None, "percentile": None, "robust_z": None,
                "tier_fallback": fallback, "per_tier": per_tier}

    agg = config.r(dsum / wsum)
    dom = window.dominant_tier()
    n_tok_total = len(tokens(window.text()))
    pct, nullmeta = null.percentile("topic", dom, n_tok_total, agg)
    return {
        "available": pct is not None,
        "reason": None if pct is not None else "null_unavailable",
        "divergence": agg,
        "percentile": pct,
        "robust_z": null.robust_z("topic", dom, n_tok_total, agg),
        "null": nullmeta,
        "tier_fallback": fallback,
        "per_tier": per_tier,
    }
