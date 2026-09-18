#!/usr/bin/env python3
"""Build topic_profiles.json from the baseline corpus. Run ONCE; reuse forever.

    python3 -m v3.build_topic_profiles --corpus baseline.jsonl \
        --out ~/workspace/stylometry/v3/topic_profiles.json

Estimator: log-odds-ratio with an informative Dirichlet prior (Monroe, Colaresi
& Quinn 2008). Raw frequency ranking returns function words; plain log-odds
explodes on rare terms. This does neither.

    a_w   = alpha0 * (y_w / n_bg)          informative prior from background
    delta = log((y_tw+a_w)/(n_t+alpha0-y_tw-a_w))
          - log((y_w+a_w)/(n_bg+alpha0-y_w-a_w))
    var   = 1/(y_tw+a_w) + 1/(y_w+a_w)
    z     = delta / sqrt(var)

Corpus row contract: {"tier": str, "text": str}  (extra keys ignored).
"""
import argparse
import json
import math
import sys
import time

from . import config, discourse
from .textnorm import tokens

DEFAULT_TOP_K = 150
DEFAULT_ALPHA0 = 1000.0
DEFAULT_MIN_COUNT = 5
DEFAULT_MIN_TIER_TOKENS = 5000


def median(xs):
    s = sorted(xs)
    n = len(s)
    if not n:
        return 0.0
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def mad(xs):
    if not xs:
        return 0.0
    m = median(xs)
    return median([abs(x - m) for x in xs])


def build(rows, top_k=DEFAULT_TOP_K, alpha0=DEFAULT_ALPHA0,
          min_count=DEFAULT_MIN_COUNT, min_tier_tokens=DEFAULT_MIN_TIER_TOKENS):
    tier_counts = {}
    bg = {}
    tier_totals = {}
    tier_texts = {}
    for row in rows:
        tier = str(row["tier"])
        toks = tokens(row.get("text", ""))
        if not toks:
            continue
        c = tier_counts.setdefault(tier, {})
        for t in toks:
            c[t] = c.get(t, 0) + 1
            bg[t] = bg.get(t, 0) + 1
        tier_totals[tier] = tier_totals.get(tier, 0) + len(toks)
        tier_texts.setdefault(tier, []).append(row.get("text", ""))

    n_bg = sum(bg.values())
    if n_bg == 0:
        raise SystemExit("empty corpus")

    # Tiers too thin to profile are folded into the longtail bucket.
    thin = [t for t, n in tier_totals.items() if n < min_tier_tokens]
    if thin:
        lt = config.LONGTAIL_TIER
        merged = tier_counts.setdefault(lt, {})
        for t in thin:
            if t == lt:
                continue
            for w, k in tier_counts.pop(t).items():
                merged[w] = merged.get(w, 0) + k
            tier_totals[lt] = tier_totals.get(lt, 0) + tier_totals.pop(t)
            tier_texts.setdefault(lt, []).extend(tier_texts.pop(t, []))
    if config.LONGTAIL_TIER not in tier_counts:
        # Always provide a fallback profile: the whole corpus.
        tier_counts[config.LONGTAIL_TIER] = dict(bg)
        tier_totals[config.LONGTAIL_TIER] = n_bg
        tier_texts[config.LONGTAIL_TIER] = [r.get("text", "") for r in rows]

    out_tiers = {}
    for tier in sorted(tier_counts):
        counts = tier_counts[tier]
        n_t = tier_totals[tier]
        scored = []
        for w, y_tw in counts.items():
            if y_tw < min_count:
                continue
            y_w = bg.get(w, 0)
            a_w = alpha0 * (y_w / n_bg)
            num_t = y_tw + a_w
            den_t = n_t + alpha0 - num_t
            num_b = y_w + a_w
            den_b = n_bg + alpha0 - num_b
            if min(num_t, den_t, num_b, den_b) <= 0:
                continue
            delta = math.log(num_t / den_t) - math.log(num_b / den_b)
            var = 1.0 / num_t + 1.0 / num_b
            z = delta / math.sqrt(var)
            if z > 0:
                scored.append((z, w))
        scored.sort(key=lambda zw: (-zw[0], zw[1]))
        top = scored[:top_k]
        norm = math.sqrt(sum(z * z for z, _ in top)) or 1.0
        out_tiers[tier] = {
            "n_tokens": n_t,
            "n_vocab": len(counts),
            "weights": {w: config.r(z / norm) for z, w in top},
        }

    # Discourse baselines: per-tier median + MAD over per-message proxy values.
    disc = {}
    for tier in sorted(tier_texts):
        per_axis = {a: [] for a in discourse.AXES}
        for text in tier_texts[tier]:
            v = _message_proxies(text)
            for a in discourse.AXES:
                if v[a] is not None:
                    per_axis[a].append(v[a])
        disc[tier] = {a: {"median": config.r(median(per_axis[a])),
                          "mad": config.r(max(mad(per_axis[a]), config.MAD_FLOOR)),
                          "n": len(per_axis[a])}
                      for a in discourse.AXES}

    return {
        "status": "built",
        "built_at": time.time(),
        "code_version": config.CODE_VERSION,
        "params": {"top_k": top_k, "alpha0": alpha0, "min_count": min_count,
                   "min_tier_tokens": min_tier_tokens},
        "estimator": "log-odds-ratio, informative Dirichlet prior (Monroe 2008)",
        "n_corpus_rows": len(rows),
        "n_background_tokens": n_bg,
        "tiers": out_tiers,
        "discourse": disc,
    }


def _message_proxies(text):
    from .textnorm import sentences
    sents = sentences(text)
    toks = tokens(text)
    counts = {"imperative": 0, "interrogative": 0, "declarative": 0}
    for s in sents:
        c = discourse._classify(s)
        if c:
            counts[c] += 1
    total = sum(counts.values())
    directive = 0
    for i, t in enumerate(toks):
        if t in discourse.SECOND_PERSON:
            lo, hi = max(0, i - 4), min(len(toks), i + 5)
            if any(x in discourse.OBLIGATION for x in toks[lo:hi]):
                directive += 1
    return {
        "imperative_ratio": counts["imperative"] / total if total else None,
        "interrogative_ratio": counts["interrogative"] / total if total else None,
        "second_person_directive_per_100":
            100.0 * directive / len(toks) if toks else None,
        "declarative_share": counts["declarative"] / total if total else None,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, help="JSONL {tier, text}")
    ap.add_argument("--out", default=str(config.TOPIC_PROFILES))
    ap.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    ap.add_argument("--alpha0", type=float, default=DEFAULT_ALPHA0)
    ap.add_argument("--min-count", type=int, default=DEFAULT_MIN_COUNT)
    args = ap.parse_args(argv)
    with open(args.corpus, "r", encoding="utf-8") as fh:
        rows = [json.loads(l) for l in fh if l.strip()]
    prof = build(rows, top_k=args.top_k, alpha0=args.alpha0,
                 min_count=args.min_count)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(prof, fh, sort_keys=True, indent=1, ensure_ascii=False)
    print("wrote %s: %d tiers, %d bg tokens"
          % (args.out, len(prof["tiers"]), prof["n_background_tokens"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
