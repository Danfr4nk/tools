"""Discourse-move proxies. Stdlib heuristics -- proxies, not parses.

These are lexicon+position rules standing in for a POS tagger. They are the
weakest component in Layer A and they are labelled that way in every record:
each score carries proxy_quality so nothing downstream can mistake an
imperative-lexicon hit for a parsed imperative.
"""
import re

from . import config
from .textnorm import sentences, tokens

# Base-form verbs that actually open Dan's imperatives. A lexicon, not grammar:
# it will miss any imperative whose verb is not listed, and it will false-fire
# on a noun homograph in sentence-initial position ("Book is on the table").
IMPERATIVE_VERBS = frozenset("""
add askback build call change check clean close come confirm copy cut delete
do drop email fix flag follow forget get give go grab hand help hit hold keep
kill leave let list look make mark move open paste ping pull push put read
remember remind remove rename reply run save say see send set ship show sign
skip stop take talk tell test text throw try turn update upload use wait walk
watch write
""".split())
IMPERATIVE_OPENERS = ("don't", "do not", "dont", "let's", "lets", "please",
                      "never", "always", "just")
WH_WORDS = frozenset({"who", "what", "when", "where", "why", "how", "which", "whose"})
AUX_WORDS = frozenset({"do", "does", "did", "is", "are", "was", "were", "can",
                       "could", "will", "would", "should", "have", "has", "had",
                       "am", "may", "might"})
SECOND_PERSON = frozenset({"you", "your", "you're", "youre", "yours", "u", "ur",
                           "yourself"})
OBLIGATION = frozenset({"should", "need", "needs", "must", "gotta", "have",
                        "has", "ought", "better"})

_PUNCT = re.compile(r"^[\"'“‘(\[]+")

AXES = ("imperative_ratio", "interrogative_ratio",
        "second_person_directive_per_100", "declarative_share")


def _classify(sent):
    raw = _PUNCT.sub("", sent.strip())
    low = raw.lower()
    toks = tokens(raw)
    if not toks:
        return None
    if raw.endswith("?"):
        return "interrogative"
    if toks[0] in WH_WORDS and len(toks) > 1:
        return "interrogative"
    if toks[0] in AUX_WORDS and len(toks) > 2 and toks[1] in SECOND_PERSON:
        return "interrogative"          # aux-inversion: "can you ..."
    for op in IMPERATIVE_OPENERS:
        if low.startswith(op):
            return "imperative"
    if toks[0] in IMPERATIVE_VERBS and (len(toks) == 1 or toks[1] not in
                                        {"is", "was", "were", "are", "'s"}):
        return "imperative"
    return "declarative"


def score_discourse(window, profiles, null):
    text = window.text()
    sents = sentences(text)
    toks = tokens(text)
    n_tok = len(toks)
    counts = {"imperative": 0, "interrogative": 0, "declarative": 0}
    for s in sents:
        c = _classify(s)
        if c:
            counts[c] += 1
    total = sum(counts.values())

    # second-person directive: obligation modal within 4 tokens of a 2p pronoun
    directive = 0
    for i, t in enumerate(toks):
        if t in SECOND_PERSON:
            lo, hi = max(0, i - 4), min(n_tok, i + 5)
            if any(x in OBLIGATION for x in toks[lo:hi]):
                directive += 1

    raw = {
        "imperative_ratio": (counts["imperative"] / total) if total else None,
        "interrogative_ratio": (counts["interrogative"] / total) if total else None,
        "second_person_directive_per_100": (100.0 * directive / n_tok) if n_tok else None,
        "declarative_share": (counts["declarative"] / total) if total else None,
    }

    if n_tok < config.MIN_WINDOW_TOKENS or not total:
        return {"available": False, "reason": "insufficient_signal",
                "raw": {k: config.r(v) for k, v in raw.items()},
                "n_sentences": total, "n_tokens": n_tok,
                "max_abs_z": None, "percentile": None, "robust_z": None,
                "per_axis": [], "tier_fallback": False,
                "proxy_quality": "lexicon-heuristic"}

    tier = window.dominant_tier()
    base = profiles.discourse.get(tier) or profiles.discourse.get(config.LONGTAIL_TIER)
    fallback = tier not in profiles.discourse
    per_axis = []
    max_abs = 0.0
    if base:
        for axis in AXES:
            b = base.get(axis)
            v = raw[axis]
            if not b or v is None:
                per_axis.append({"axis": axis, "value": config.r(v), "z": None})
                continue
            mad = max(float(b.get("mad", 0.0)), config.MAD_FLOOR)
            z = 0.6745 * (v - float(b["median"])) / mad
            per_axis.append({"axis": axis, "value": config.r(v), "z": config.r(z)})
            max_abs = max(max_abs, abs(z))
    else:
        per_axis = [{"axis": a, "value": config.r(raw[a]), "z": None} for a in AXES]
        return {"available": False, "reason": "no_discourse_baseline",
                "raw": {k: config.r(v) for k, v in raw.items()},
                "n_sentences": total, "n_tokens": n_tok, "max_abs_z": None,
                "percentile": None, "robust_z": None, "per_axis": per_axis,
                "tier_fallback": True, "proxy_quality": "lexicon-heuristic"}

    pct, nullmeta = null.percentile("discourse", tier, n_tok, max_abs)
    return {
        "available": pct is not None,
        "reason": None if pct is not None else "null_unavailable",
        "raw": {k: config.r(v) for k, v in raw.items()},
        "n_sentences": total,
        "n_tokens": n_tok,
        "max_abs_z": config.r(max_abs),
        "percentile": pct,
        "robust_z": null.robust_z("discourse", tier, n_tok, max_abs),
        "null": nullmeta,
        "per_axis": per_axis,
        "tier_fallback": fallback,
        "proxy_quality": "lexicon-heuristic",
    }
