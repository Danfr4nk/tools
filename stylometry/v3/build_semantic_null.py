#!/usr/bin/env python3
"""Build semantic_null.json -- the stratified topic/entity/discourse null.

    python3 -m v3.build_semantic_null --corpus baseline.jsonl \
        --profiles topic_profiles.json --draws 20000

Strata are (tier | token-size-bucket), mirroring v2's stratified-null design.
Each draw assembles a pseudo-window by sampling messages WITHIN one tier (so
the null answers "how far does a normal window of this tier and size sit from
this tier's profile", not "how far is a random text blob"), scores all three
axes, and records the values. Lookup is a sorted-list bisect.

Sampling is seeded. Same corpus + same seed + same draws => same null file.
"""
import argparse
import json
import random
import sys
import time

from . import config, discourse, registry as reg, topics
from .textnorm import tokens

TARGET_SIZES = (80, 200, 600, 1500)


class _FakeWindow:
    """Minimal duck-type for the scorers: a null draw is not a real window."""

    def __init__(self, texts, tier):
        self._texts = texts
        self._tier = tier
        self.messages = [_FakeMsg(t, tier) for t in texts]
        self.n_messages = len(texts)
        self.window_id = "null"

    def text(self):
        return "\n".join(self._texts)

    def tier_counts(self):
        return {self._tier: len(self._texts)}

    def dominant_tier(self):
        return self._tier


class _FakeMsg:
    __slots__ = ("text", "tier", "msg_id", "ts", "recipient")

    def __init__(self, text, tier):
        self.text = text
        self.tier = tier
        self.msg_id = "null"
        self.ts = 0.0
        self.recipient = "null"


class _NullNull:
    """Percentile lookups are meaningless while BUILDING the null."""
    built = False

    def percentile(self, *a, **k):
        return None, {"available": False}

    def robust_z(self, *a, **k):
        return None


def build(rows, profiles, registry_obj, draws=20000, seed=20260918):
    rng = random.Random(seed)
    by_tier = {}
    for r in rows:
        by_tier.setdefault(str(r["tier"]), []).append(r.get("text", ""))
    by_tier = {t: v for t, v in by_tier.items() if v}
    if not by_tier:
        raise SystemExit("empty corpus")

    prof = topics.TopicProfiles(profiles)
    nn = _NullNull()
    strata = {"topic": {}, "entity": {}, "discourse": {}}
    tiers = sorted(by_tier)
    per_combo = max(1, draws // (len(tiers) * len(TARGET_SIZES)))

    for tier in tiers:
        pool = by_tier[tier]
        for target in TARGET_SIZES:
            for _ in range(per_combo):
                texts = []
                ntok = 0
                guard = 0
                while ntok < target and guard < 400:
                    t = pool[rng.randrange(len(pool))]
                    texts.append(t)
                    ntok += len(tokens(t))
                    guard += 1
                if not texts:
                    continue
                w = _FakeWindow(texts, tier)
                bkt = topics.size_bucket(ntok)
                key = "%s|%s" % (tier, bkt)

                ts = topics.score_topics(w, prof, nn)
                if ts.get("divergence") is not None:
                    strata["topic"].setdefault(key, []).append(ts["divergence"])

                es = reg.score_entities(w, registry_obj)
                strata["entity"].setdefault(key, []).append(es["max_surprise"])

                ds = discourse.score_discourse(w, prof, nn)
                if ds.get("max_abs_z") is not None:
                    strata["discourse"].setdefault(key, []).append(ds["max_abs_z"])

    # Wildcard strata so a lookup for an unseen tier still lands somewhere real.
    for axis in strata:
        by_bucket = {}
        allv = []
        for key, vals in strata[axis].items():
            bkt = key.split("|", 1)[1]
            by_bucket.setdefault(bkt, []).extend(vals)
            allv.extend(vals)
        for bkt, vals in by_bucket.items():
            strata[axis]["*|%s" % bkt] = vals
        if allv:
            strata[axis]["*|*"] = allv
        for key in strata[axis]:
            strata[axis][key] = sorted(config.r(v) for v in strata[axis][key])

    return {
        "status": "built",
        "built_at": time.time(),
        "code_version": config.CODE_VERSION,
        "params": {"draws": draws, "seed": seed, "target_sizes": list(TARGET_SIZES),
                   "per_combo": per_combo},
        "n_strata": {a: len(strata[a]) for a in strata},
        "strata": strata,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--profiles", default=str(config.TOPIC_PROFILES))
    ap.add_argument("--registry", default=str(config.ENTITY_REGISTRY))
    ap.add_argument("--out", default=str(config.SEMANTIC_NULL))
    ap.add_argument("--draws", type=int, default=20000)
    ap.add_argument("--seed", type=int, default=20260918)
    args = ap.parse_args(argv)
    with open(args.corpus, "r", encoding="utf-8") as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    with open(args.profiles, "r", encoding="utf-8") as fh:
        profiles = json.load(fh)
    out = build(rows, profiles, reg.Registry.load(args.registry),
                draws=args.draws, seed=args.seed)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, sort_keys=True, indent=1, ensure_ascii=False)
    print("wrote %s: strata %s" % (args.out, out["n_strata"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
