"""v3 window construction.

LOUD NOTICE -- v3 DOES NOT INHERIT v2's WINDOW CONSTRUCTION.

v2 has an open adjacency bug: per-tier sequences are sorted independently, so
records that are "adjacent" in one tier's sequence can splice conversations
that never touched each other in wall-clock time. v3 therefore defines window
membership itself, from first principles:

  * The ONLY ordering key is (ts, msg_id) over the whole outbound stream.
  * Tier is an ATTRIBUTE used for conditioning, never a sort key and never a
    grouping key for membership.
  * trailing_hours = every message with now - TRAILING_HOURS <= ts <= now.
  * trailing_n     = the last TRAILING_N messages in that global order.

Consequence: a v3 window and the v2 window nominally covering the same period
can contain different message sets. That is the point. Every record carries
window_semantics and, when v2's member set is available, an explicit
v2_adjacency_divergence block. Never reconcile the two by quietly adopting v2's
membership.
"""
import hashlib
import json

from . import config


class Message:
    __slots__ = ("msg_id", "ts", "tier", "recipient", "text")

    def __init__(self, msg_id, ts, tier, recipient, text):
        self.msg_id = str(msg_id)
        self.ts = float(ts)
        self.tier = str(tier)
        self.recipient = str(recipient)
        self.text = text or ""

    def sort_key(self):
        return (self.ts, self.msg_id)

    def as_store_row(self):
        return {
            "msg_id": self.msg_id,
            "msg_hash": hashlib.sha256(self.text.encode("utf-8")).hexdigest()[:16],
            "ts": self.ts,
            "tier": self.tier,
            "recipient_hash": hashlib.sha256(
                self.recipient.encode("utf-8")
            ).hexdigest()[:16],
            "text": self.text,
        }


REQUIRED_FIELDS = ("msg_id", "ts", "tier", "recipient", "text")


def parse_messages(rows):
    """Input contract adapter. Raises on a malformed row rather than guessing."""
    out = []
    for i, row in enumerate(rows):
        missing = [f for f in REQUIRED_FIELDS if f not in row]
        if missing:
            raise ValueError("message row %d missing fields: %s" % (i, ",".join(missing)))
        if row.get("direction", "out") != "out":
            continue
        out.append(Message(row["msg_id"], row["ts"], row["tier"],
                           row["recipient"], row["text"]))
    return out


def _dedupe_sorted(msgs):
    seen = set()
    out = []
    for m in sorted(msgs, key=Message.sort_key):
        if m.msg_id in seen:
            continue
        seen.add(m.msg_id)
        out.append(m)
    return out


def window_id(kind, end_ts, msgs):
    """Content-addressed. Same members + same end => same id => replayable."""
    h = hashlib.sha256()
    h.update(kind.encode("utf-8"))
    h.update(b"\x00")
    h.update(("%.3f" % float(end_ts)).encode("utf-8"))
    for m in msgs:
        h.update(b"\x00")
        h.update(m.msg_id.encode("utf-8"))
        h.update(b"\x01")
        # Text is part of the identity. The window store is keyed by this id
        # and treats an existing file as identical; an edited or corrected
        # message must therefore produce a different id, not silently reuse a
        # stale store file.
        h.update(hashlib.sha256(m.text.encode("utf-8")).hexdigest()[:16]
                 .encode("ascii"))
    return "v3:%s:%.0f:%s" % (kind, float(end_ts), h.hexdigest()[:12])


class Window:
    def __init__(self, kind, end_ts, messages):
        self.kind = kind
        self.end_ts = float(end_ts)
        self.messages = messages
        self.window_id = window_id(kind, end_ts, messages)

    @property
    def start_ts(self):
        return self.messages[0].ts if self.messages else self.end_ts

    @property
    def n_messages(self):
        return len(self.messages)

    def text(self):
        return "\n".join(m.text for m in self.messages)

    def tier_counts(self):
        c = {}
        for m in self.messages:
            c[m.tier] = c.get(m.tier, 0) + 1
        return dict(sorted(c.items()))

    def dominant_tier(self):
        c = self.tier_counts()
        if not c:
            return config.LONGTAIL_TIER
        # Ties broken by tier name so the choice is deterministic.
        return sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]

    def meta(self):
        return {
            "window_id": self.window_id,
            "kind": self.kind,
            "window_semantics": "v3-independent-global-time",
            "start_ts": self.start_ts,
            "end_ts": self.end_ts,
            "n_messages": self.n_messages,
            "tier_counts": self.tier_counts(),
            "dominant_tier": self.dominant_tier(),
        }


def build_windows(messages, now_ts, kinds=config.WINDOW_KINDS):
    """Build every configured window from one pre-sorted global stream."""
    ordered = _dedupe_sorted(messages)
    out = []
    for kind in kinds:
        if kind == "trailing_hours":
            lo = now_ts - config.TRAILING_HOURS * 3600.0
            sel = [m for m in ordered if lo <= m.ts <= now_ts]
        elif kind == "trailing_n":
            sel = [m for m in ordered if m.ts <= now_ts][-config.TRAILING_N:]
        else:
            raise ValueError("unknown window kind: %s" % kind)
        out.append(Window(kind, now_ts, sel))
    return out


def adjacency_divergence(v3_window, v2_member_ids):
    """Compare v3 membership against whatever v2 claims for the same window.

    Returns None when v2 membership is unavailable -- which is the common case,
    and is itself recorded so nobody reads a missing block as agreement.
    """
    if v2_member_ids is None:
        return None
    v3_ids = {m.msg_id for m in v3_window.messages}
    v2_ids = set(str(x) for x in v2_member_ids)
    only_v3 = sorted(v3_ids - v2_ids)
    only_v2 = sorted(v2_ids - v3_ids)
    return {
        "agrees": not only_v3 and not only_v2,
        "n_only_v3": len(only_v3),
        "n_only_v2": len(only_v2),
        "only_v3_sample": only_v3[:10],
        "only_v2_sample": only_v2[:10],
    }


def canonical_json(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
