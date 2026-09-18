#!/usr/bin/env python3
"""Export the 94,503-message outbound corpus to v3's baseline.jsonl.

Reads ~/workspace/wikitest/corpus/messages.csv (the Mac iMessage export),
keeps is_from_me rows, and emits one JSONL row per message in v3's input
contract:

    {"msg_id","ts","tier","recipient","text","direction":"out"}

Tier mapping mirrors v2's baseline2.json: the top-10 correspondents keep
their own tier (keyed by chat_identifier, same as v2), everyone else is
"longtail". Recipient = chat_display_name, falling back to chat_identifier.

Timestamps are America/New_York -> epoch UTC. Rows with unparseable dates
are kept with ts=null (windows use arrival order as tiebreak).
"""
import csv
import json
import os
import sys
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
CSV_PATH = os.path.expanduser("~/workspace/wikitest/corpus/messages.csv")
BASELINE2 = os.path.expanduser("~/workspace/stylometry/baseline2.json")
OUT = os.path.expanduser("~/workspace/stylometry/corpus/v3-baseline.jsonl")


def parse_ts(s):
    if not s or not s.strip():
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s.strip(), fmt).replace(tzinfo=ET).timestamp()
        except ValueError:
            continue
    return None


def main():
    top = set(json.load(open(BASELINE2))["tiers"]["top"])
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    n_in = n_out = 0
    tier_counts = Counter()
    with open(CSV_PATH, newline="", encoding="utf-8", errors="replace") as fh, \
            open(OUT, "w", encoding="utf-8") as out:
        rdr = csv.DictReader(fh)
        for row in rdr:
            n_in += 1
            if (row.get("is_from_me") or "").strip() != "1":
                continue
            text = (row.get("text") or "").strip()
            if not text:
                continue
            if text.startswith("[") and len(text.split()) < 4:
                continue  # system bracket-lines, same rule as scorer2
            ident = (row.get("chat_identifier") or "").strip()
            name = (row.get("chat_display_name") or "").strip()
            recipient = name or ident or "unknown"
            tier = ident if ident in top else "longtail"
            out.write(json.dumps({
                "msg_id": (row.get("message_id") or "").strip() or f"row{n_in}",
                "ts": parse_ts(row.get("date_sent") or ""),
                "tier": tier,
                "recipient": recipient,
                "text": text,
                "direction": "out",
            }, ensure_ascii=False) + "\n")
            n_out += 1
            tier_counts[tier] += 1
    print(f"rows_in={n_in} rows_out={n_out}")
    for t, c in tier_counts.most_common():
        print(f"  tier={t!r:16} n={c}")


if __name__ == "__main__":
    sys.exit(main())
