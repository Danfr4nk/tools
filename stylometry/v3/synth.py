"""Synthetic corpus + message stream. No real data, no network.

Used by the test suite AND by selftest.py, so an install can be proved end to
end before v3 is ever pointed at real messages.
"""
import random

TIER_WORDS = {
    "work": "deploy latency rollback staging pipeline incident schema migration "
            "throughput regression",
    "family": "dinner mom grandma birthday drive groceries sunday cousin laundry "
              "kitchen",
    "close": "sleep tired music smoke late awake track record listen session",
}
FILLER = "the a it is and to of that we i you this be for on with".split()


def make_corpus(seed=7, per_tier=400):
    rng = random.Random(seed)
    rows = []
    for tier, words in TIER_WORDS.items():
        vocab = words.split()
        for _ in range(per_tier):
            n = rng.randint(8, 22)
            toks = [rng.choice(vocab) if rng.random() < 0.45 else rng.choice(FILLER)
                    for _ in range(n)]
            rows.append({"tier": tier, "text": " ".join(toks) + "."})
    return rows


def make_stream(corpus, n=120, drift_after=90, t0=1_700_000_000.0, step=120,
                seed=3, tier="work", drift_tier="family"):
    """A stream that stays on-profile then drifts to another tier's vocabulary,
    with two novel capitalized entities planted near the drift."""
    rng = random.Random(seed)
    on = [r["text"] for r in corpus if r["tier"] == tier]
    off = [r["text"] for r in corpus if r["tier"] == drift_tier]
    out = []
    for i in range(n):
        pool = on if i < drift_after else off
        out.append({"msg_id": "m%04d" % i, "ts": t0 + i * step, "tier": tier,
                    "recipient": "alice", "text": pool[rng.randrange(len(pool))],
                    "direction": "out"})
    if drift_after < n:
        out[drift_after]["text"] += " Ping Sarah Chen about Wire Protocol."
    return out
