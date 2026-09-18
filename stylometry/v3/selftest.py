#!/usr/bin/env python3
"""Prove a v3 install end to end on synthetic data. No network, no real messages.

    STYLO_V3_DATA=/tmp/v3check python3 -m v3.selftest

Builds synthetic topic profiles and a semantic null into the data root, scores
a drifting message stream through the real fast-loop path, then replays. Run it
before pointing v3 at real data, and again after any artifact rebuild.

REFUSES to run against a data root that already holds run records -- this
writes artifacts, and overwriting a real profile build with a synthetic one
would silently invalidate every subsequent score.
"""
import argparse
import json
import os
import sys

from . import (build_semantic_null as bsn, build_topic_profiles as btp, config,
               registry as reg, runrecord, synth)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true",
                    help="overwrite artifacts in a non-empty data root")
    args = ap.parse_args(argv)

    config.ensure_dirs()
    existing = list(runrecord.iter_paths())
    if existing and not args.force:
        print("REFUSING: %s already holds %d run record(s).\n"
              "Point STYLO_V3_DATA at a scratch dir, or pass --force to "
              "overwrite the artifacts there." % (config.DATA_ROOT, len(existing)))
        return 2

    print("data root: %s" % config.DATA_ROOT)
    corpus = synth.make_corpus()
    prof = btp.build(corpus, top_k=60, min_count=2, min_tier_tokens=100)
    with open(str(config.TOPIC_PROFILES), "w", encoding="utf-8") as fh:
        json.dump(prof, fh, sort_keys=True)
    print("  profiles: %d tiers, %d bg tokens"
          % (len(prof["tiers"]), prof["n_background_tokens"]))

    nul = bsn.build(corpus, prof, reg.Registry.load(), draws=1500, seed=11)
    with open(str(config.SEMANTIC_NULL), "w", encoding="utf-8") as fh:
        json.dump(nul, fh, sort_keys=True)
    print("  null: %s" % nul["n_strata"])

    stream = synth.make_stream(corpus)
    msgs_path = os.path.join(str(config.DATA_ROOT), "selftest_messages.jsonl")
    with open(msgs_path, "w", encoding="utf-8") as fh:
        for m in stream:
            fh.write(json.dumps(m) + "\n")
    v2_path = os.path.join(str(config.DATA_ROOT), "selftest_v2.json")
    with open(v2_path, "w", encoding="utf-8") as fh:
        json.dump({"trailing_hours": {"percentile": 0.991, "flag": True},
                   "trailing_n": {"percentile": 0.42, "flag": False}}, fh)

    now = stream[-1]["ts"] + 60
    from . import run_v3
    print("\n-- fast loop --")
    run_v3.main(["--messages", msgs_path, "--v2-record", v2_path,
                 "--now", str(now)])

    print("\n-- replay --")
    from . import verify_replay_v3
    rc = verify_replay_v3.main(["--verbose"])
    print("\nselftest %s" % ("OK" if rc == 0 else "FAILED"))
    return rc


if __name__ == "__main__":
    sys.exit(main())
