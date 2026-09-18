import json
import os
import socket
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))))

from v3 import (build_semantic_null as bsn, build_topic_profiles as btp,
                calibration, config, discourse, joint, layer_a as la,
                layer_b as lb, registry as reg, runrecord, textnorm, topics,
                v2_bridge, window_store, windows as win)

from v3.synth import TIER_WORDS, make_corpus


def build_artifacts():
    rows = make_corpus()
    prof = btp.build(rows, top_k=60, min_count=2, min_tier_tokens=100)
    with open(str(config.TOPIC_PROFILES), "w", encoding="utf-8") as fh:
        json.dump(prof, fh, sort_keys=True)
    registry_obj = reg.Registry.load()
    nul = bsn.build(rows, prof, registry_obj, draws=1200, seed=11)
    with open(str(config.SEMANTIC_NULL), "w", encoding="utf-8") as fh:
        json.dump(nul, fh, sort_keys=True)
    return topics.TopicProfiles(prof), topics.SemanticNull(nul)


def mk_window(texts, tier="work", kind="trailing_hours", t0=1_700_000_000.0):
    msgs = [win.Message("m%03d" % i, t0 + i * 60, tier, "r", t)
            for i, t in enumerate(texts)]
    return win.Window(kind, t0 + len(texts) * 60 + 1, msgs)


# --------------------------------------------------------------------------
class TestWindows(unittest.TestCase):
    def test_membership_is_global_time_not_tier_adjacency(self):
        """The v2 bug: per-tier sorting splices unrelated conversations.
        v3 orders by (ts, msg_id) across the whole stream, so interleaving
        tiers cannot change membership."""
        rows = [{"msg_id": "a", "ts": 100, "tier": "work", "recipient": "x", "text": "one"},
                {"msg_id": "b", "ts": 150, "tier": "family", "recipient": "y", "text": "two"},
                {"msg_id": "c", "ts": 200, "tier": "work", "recipient": "x", "text": "three"}]
        msgs = win.parse_messages(rows)
        w = win.build_windows(msgs, 250)[0]
        self.assertEqual([m.msg_id for m in w.messages], ["a", "b", "c"])
        # Shuffled input must produce an identical window and window id.
        w2 = win.build_windows(win.parse_messages(list(reversed(rows))), 250)[0]
        self.assertEqual(w.window_id, w2.window_id)

    def test_window_id_is_content_addressed(self):
        a = mk_window(["x", "y"])
        b = mk_window(["x", "y"])
        c = mk_window(["x", "z"])
        self.assertEqual(a.window_id, b.window_id)
        self.assertNotEqual(a.window_id, c.window_id)

    def test_trailing_hours_respects_the_horizon(self):
        rows = [{"msg_id": str(i), "ts": 1000 + i * 3600, "tier": "work",
                 "recipient": "x", "text": "t"} for i in range(10)]
        w = win.build_windows(win.parse_messages(rows), 1000 + 9 * 3600)[0]
        self.assertEqual(w.n_messages, 5)   # 4h window, hourly messages, inclusive

    def test_trailing_n_caps(self):
        rows = [{"msg_id": str(i), "ts": 1000 + i, "tier": "work",
                 "recipient": "x", "text": "t"} for i in range(250)]
        ws = {w.kind: w for w in win.build_windows(win.parse_messages(rows), 9999)}
        self.assertEqual(ws["trailing_n"].n_messages, config.TRAILING_N)

    def test_direction_filter_and_missing_field(self):
        self.assertEqual(len(win.parse_messages(
            [{"msg_id": "a", "ts": 1, "tier": "t", "recipient": "r",
              "text": "x", "direction": "in"}])), 0)
        with self.assertRaises(ValueError):
            win.parse_messages([{"msg_id": "a", "ts": 1}])

    def test_adjacency_divergence_reports_missing_v2_as_none(self):
        w = mk_window(["a", "b"])
        self.assertIsNone(win.adjacency_divergence(w, None))
        d = win.adjacency_divergence(w, ["m000", "zzz"])
        self.assertFalse(d["agrees"])
        self.assertEqual(d["n_only_v3"], 1)
        self.assertEqual(d["n_only_v2"], 1)


class TestTextnorm(unittest.TestCase):
    def test_cap_phrases_skip_sentence_initial(self):
        self.assertEqual(textnorm.cap_phrases("Sarah Chen called."), [])
        self.assertIn("Sarah Chen", textnorm.cap_phrases("Ping Sarah Chen today."))

    def test_cap_phrases_absorb_particles(self):
        self.assertIn("Bank of America",
                      textnorm.cap_phrases("Call Bank of America now."))

    def test_norm_key_does_not_stem_or_merge(self):
        self.assertEqual(textnorm.norm_key("Sarah  Chen."), "sarah chen")
        self.assertNotEqual(textnorm.norm_key("Sam"), textnorm.norm_key("Sammy"))


class TestRegistry(unittest.TestCase):
    def setUp(self):
        self.r = reg.Registry({"entries": [
            {"id": "p.sarah", "canonical": "Sarah Chen", "aliases": ["sarah", "@schen"],
             "kind": "person", "status": "confirmed"},
            {"id": "p.sam", "canonical": "Sam", "aliases": [], "kind": "person",
             "status": "confirmed"},
            {"id": "p.ghost", "canonical": "Ghost Project", "aliases": [],
             "kind": "project", "status": "candidate"}],
            "tier_rates": {"p.sarah": {"work": 0.001}},
            "global_rates": {"p.sarah": 0.0005}})

    def test_longest_alias_wins(self):
        hits = self.r.match("talked to Sarah Chen today")
        self.assertEqual(hits, {"p.sarah": 1})   # not sarah + chen separately

    def test_candidates_never_match(self):
        self.assertEqual(self.r.match("the Ghost Project shipped"), {})

    def test_similar_names_stay_separate(self):
        self.assertEqual(self.r.match("Sam and Sarah"), {"p.sam": 1, "p.sarah": 1})

    def test_poisson_surprise_monotone_and_capped(self):
        vals = [reg.poisson_surprise(k, 0.5) for k in range(0, 8)]
        self.assertEqual(vals[0], 0.0)
        self.assertTrue(all(b >= a for a, b in zip(vals, vals[1:])))
        self.assertLessEqual(reg.poisson_surprise(500, 1e-6),
                             config.ENTITY_SURPRISE_CAP)

    def test_tier_fallback_flagged(self):
        rate, fb = self.r.expected_rate("p.sarah", "family")
        self.assertTrue(fb)
        self.assertEqual(rate, 0.0005)

    def test_novel_candidates_logged_not_registered(self):
        w = mk_window(["Ping Wire Protocol about it. Ping Wire Protocol again."])
        out = reg.score_entities(w, self.r)
        keys = [c["key"] for c in out["candidates"]]
        self.assertIn("wire protocol", keys)
        self.assertEqual(len(self.r.entries), 3)      # registry untouched


class TestDiscourse(unittest.TestCase):
    def test_classifier(self):
        cases = [("Fix the parser.", "imperative"),
                 ("Can you fix it?", "interrogative"),
                 ("Why is it broken", "interrogative"),
                 ("The parser is broken.", "declarative"),
                 ("Book is on the table.", "declarative"),
                 ("Don't ship that.", "imperative")]
        for text, want in cases:
            self.assertEqual(discourse._classify(text), want, text)

    def test_unavailable_below_min_tokens(self):
        out = discourse.score_discourse(mk_window(["hi"]),
                                        topics.TopicProfiles({}),
                                        topics.SemanticNull({}))
        self.assertFalse(out["available"])
        self.assertEqual(out["proxy_quality"], "lexicon-heuristic")


class TestLayerA(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config.ensure_dirs()
        cls.profiles, cls.null = build_artifacts()
        cls.registry = reg.Registry.load()

    def _score(self, texts, tier="work"):
        return la.score_window(mk_window(texts, tier=tier), self.registry,
                               self.profiles, self.null)

    def test_on_profile_text_is_not_a_flag(self):
        rows = [r for r in make_corpus(seed=99) if r["tier"] == "work"][:40]
        out = self._score([r["text"] for r in rows])
        self.assertIsNotNone(out["semantic_percentile"])
        self.assertFalse(out["semantic_flag"], out["semantic_percentile"])

    def test_off_profile_text_moves_the_topic_axis(self):
        on = self._score([r["text"] for r in make_corpus(seed=5)
                          if r["tier"] == "work"][:40])
        off = self._score([r["text"] for r in make_corpus(seed=5)
                           if r["tier"] == "family"][:40])
        self.assertGreater(off["axes"]["topic"]["divergence"],
                           on["axes"]["topic"]["divergence"])

    def test_unbuilt_artifacts_yield_unavailable_not_zero(self):
        out = la.score_window(mk_window(["some text here about deploys"] * 10),
                              self.registry, topics.TopicProfiles({}),
                              topics.SemanticNull({}))
        self.assertIsNone(out["semantic_percentile"])
        self.assertFalse(out["semantic_flag"])
        self.assertEqual(sorted(out["axes_unavailable"]),
                         ["discourse", "entity", "topic"])
        self.assertLess(out["confidence"], 0.4)

    def test_scoring_is_deterministic(self):
        texts = [r["text"] for r in make_corpus(seed=3) if r["tier"] == "work"][:30]
        a = self._score(texts)
        b = self._score(texts)
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_inputs_hash_tracks_content(self):
        w1 = mk_window(["alpha beta gamma"] * 10)
        w2 = mk_window(["alpha beta delta"] * 10)
        h1 = la.inputs_hash(w1, la.score_window(w1, self.registry, self.profiles,
                                                self.null))
        h2 = la.inputs_hash(w2, la.score_window(w2, self.registry, self.profiles,
                                                self.null))
        self.assertNotEqual(h1, h2)

    def test_confidence_is_debited_for_stated_weakness(self):
        out = self._score(["deploy latency rollback staging pipeline incident"] * 3)
        self.assertLess(out["confidence"], 1.0)
        self.assertNotEqual(out["ambiguity"], "none stated")


class TestNullEdgeCases(unittest.TestCase):
    """Regressions for defects found during the build, not hypotheticals."""

    def test_degenerate_stratum_is_unavailable_not_percentile_one(self):
        n = topics.SemanticNull({"status": "built", "strata": {
            "entity": {"*|*": [0.0] * 200}}})
        pct, meta = n.percentile("entity", "work", 500, 0.0)
        self.assertIsNone(pct)
        self.assertTrue(meta["degenerate"])
        self.assertIsNone(n.robust_z("entity", "work", 500, 0.0))

    def test_mid_p_rank_puts_the_mode_in_the_middle(self):
        n = topics.SemanticNull({"status": "built", "strata": {
            "topic": {"*|*": sorted([0.0] * 50 + [1.0] * 50)}}})
        pct, _ = n.percentile("topic", "work", 500, 0.0)
        self.assertEqual(pct, 0.25)      # not 0.5 (bisect_right) and not 0.0
        pct2, _ = n.percentile("topic", "work", 500, 1.0)
        self.assertEqual(pct2, 0.75)

    def test_window_id_covers_message_text(self):
        """An edited message must not reuse a stale window-store file."""
        a = mk_window(["x", "y"])
        b = mk_window(["x", "z"])
        self.assertNotEqual(a.window_id, b.window_id)
        self.assertEqual(a.window_id, mk_window(["x", "y"]).window_id)


class TestJoint(unittest.TestCase):
    def setUp(self):
        self.state = os.path.join(str(config.STATE_DIR),
                                  "alert_test_%f.json" % time.time())
        self.la = {"window": {"kind": "trailing_hours", "window_id": "w1",
                              "end_ts": 1_700_000_000.0, "n_messages": 40,
                              "dominant_tier": "work"},
                   "axes": {"topic": {"percentile": 0.99},
                            "entity": {"percentile": 0.5},
                            "discourse": {"percentile": 0.5}},
                   "semantic_percentile": 0.99, "dominant_axis": "topic",
                   "semantic_flag": True, "semantic_strong": True,
                   "axes_unavailable": [], "tier_fallback": False,
                   "confidence": 0.8, "ambiguity": "none stated",
                   "composite_excess": 2.0}

    def test_all_four_quadrants(self):
        self.assertEqual(joint.quadrant_of(True, True), "state_change_or_new_domain")
        self.assertEqual(joint.quadrant_of(True, False), "state_shift_familiar_content")
        self.assertEqual(joint.quadrant_of(False, True), "new_task_same_state")
        self.assertEqual(joint.quadrant_of(False, False), "baseline")

    def test_semantic_only_shift_does_not_alert(self):
        """The topic/task confound: content moved, style did not => context."""
        j = joint.build_joint(self.la, {"available": True, "style_flag": False,
                                        "percentile": 0.4},
                              1_700_000_000.0, state_path=self.state)
        self.assertEqual(j["quadrant"], "new_task_same_state")
        self.assertTrue(j["alerting"]["semantic_flag"])       # measurement kept
        self.assertFalse(j["alerting"]["semantic_alert"])
        self.assertTrue(j["alerting"]["suppressed"])
        self.assertEqual(j["alerting"]["suppression_reason"], "quadrant_task_confound")
        self.assertEqual(j["alerting"]["status"], "ONGOING")  # never CLEAR

    def test_style_plus_semantic_alerts_then_cools_down(self):
        style = {"available": True, "style_flag": True, "percentile": 0.99}
        t0 = 1_700_000_000.0
        a = joint.build_joint(self.la, style, t0, state_path=self.state)
        self.assertEqual(a["alerting"]["status"], "ALERT")
        b = joint.build_joint(self.la, style, t0 + 600, state_path=self.state)
        self.assertEqual(b["alerting"]["status"], "ONGOING")
        self.assertEqual(b["alerting"]["suppression_reason"], "cooldown")
        self.assertTrue(b["alerting"]["semantic_flag"])
        c = joint.build_joint(self.la, style, t0 + config.ALERT_COOLDOWN_SEC + 1,
                              state_path=self.state)
        self.assertEqual(c["alerting"]["status"], "ALERT")

    def test_missing_v2_read_is_not_stability(self):
        j = joint.build_joint(self.la, {"available": False, "reason": "v2_record_missing"},
                              1_700_000_000.0, state_path=self.state)
        self.assertIn("v2 read unavailable", j["joint_read"])

    def test_joint_read_states_gate_and_confidence(self):
        j = joint.build_joint(self.la, {"available": True, "style_flag": True},
                              1_700_000_000.0, state_path=self.state)
        self.assertIn("Gate OPEN", j["joint_read"])
        self.assertIn("shift, not diagnosis", j["joint_read"])
        self.assertIn("Confidence", j["joint_read"])


class TestCalibration(unittest.TestCase):
    def test_gate_open_by_default(self):
        g = calibration.gate_status(os.path.join(str(config.DATA_ROOT), "nope.jsonl"))
        self.assertEqual(g["state"], "OPEN")

    def test_gate_dedupes_by_label_and_date(self):
        p = os.path.join(str(config.DATA_ROOT), "labels_test.jsonl")
        with open(p, "w", encoding="utf-8") as fh:
            for lab, date in [("a", "2026-01-01"), ("a", "2026-01-01"),
                              ("a", "2026-01-02"), ("b", "2026-01-03"),
                              ("c", "2026-01-04")]:
                fh.write(json.dumps({"label": lab, "date": date}) + "\n")
        g = calibration.gate_status(p)
        self.assertEqual(g["n_episodes"], 4)      # the duplicate collapses
        self.assertEqual(g["state"], "OPEN")
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"label": "d", "date": "2026-01-05"}) + "\n")
        self.assertEqual(calibration.gate_status(p)["state"], "MET")

    def test_banned_terms_blocked_while_gate_open(self):
        g = {"state": "OPEN"}
        ok, hits = calibration.enforce("Topic moved toward logistics.", g)
        self.assertTrue(ok)
        ok, hits = calibration.enforce("This reads like a relapse.", g)
        self.assertFalse(ok)
        self.assertEqual(hits, ["relapse"])

    def test_gate_met_allows_the_vocabulary(self):
        ok, _ = calibration.enforce("withdrawal signature", {"state": "MET"})
        self.assertTrue(ok)


class TestWindowStore(unittest.TestCase):
    def test_write_read_roundtrip_and_idempotence(self):
        w = mk_window(["first message", "second message"])
        p, created = window_store.write(w, "semantic_flag")
        self.assertTrue(created)
        p2, created2 = window_store.write(w, "semantic_flag")
        self.assertFalse(created2)
        got = window_store.read(w.window_id)
        self.assertEqual(got["header"]["window_id"], w.window_id)
        self.assertEqual(got["header"]["stored_reason"], "semantic_flag")
        self.assertEqual([m["text"] for m in got["messages"]],
                         ["first message", "second message"])
        self.assertIn("msg_hash", got["messages"][0])
        self.assertNotIn("recipient", got["messages"][0])   # only a hash is kept

    def test_missing_window_reads_none(self):
        self.assertIsNone(window_store.read("v3:trailing_hours:0:deadbeef"))


class TestV2Bridge(unittest.TestCase):
    def test_unrecognized_schema_is_unavailable_not_stable(self):
        out = v2_bridge.adapt({"totally": "different"})
        self.assertFalse(out["available"])
        self.assertEqual(out["reason"], "v2_fields_not_recognized")

    def test_alternate_key_spellings(self):
        for key in ("percentile", "pct", "null_percentile"):
            out = v2_bridge.adapt({key: 0.99})
            self.assertTrue(out["available"], key)
            self.assertTrue(out["style_flag"])

    def test_missing_file(self):
        self.assertFalse(v2_bridge.load("/nonexistent/v2.json")["available"])


class TestLayerB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config.ensure_dirs()
        cls.profiles, cls.null = build_artifacts()
        cls.registry = reg.Registry.load()

    def _prepared(self, texts=None):
        w = mk_window(texts or ["deploy latency rollback staging"] * 12)
        window_store.write(w, "test")
        a = la.score_window(w, self.registry, self.profiles, self.null)
        j = joint.build_joint(a, {"available": True, "style_flag": True,
                                  "percentile": 0.99}, w.end_ts,
                              state_path=os.path.join(str(config.STATE_DIR),
                                                      "lb_alert.json"))
        return w, a, j

    def test_temperature_is_omitted_on_current_models(self):
        """The spec asked for temperature 0. Current models reject it."""
        p = lb.build_payload("x", model="claude-opus-5")
        self.assertNotIn("temperature", p)
        p2 = lb.build_payload("x", model="claude-haiku-4-5")
        self.assertEqual(p2["temperature"], 0)

    def test_payload_uses_structured_outputs(self):
        p = lb.build_payload("x")
        self.assertEqual(p["output_config"]["format"]["type"], "json_schema")
        self.assertFalse(p["output_config"]["format"]["schema"]["additionalProperties"])
        self.assertEqual(p["output_config"]["effort"], config.LAYER_B_EFFORT)

    def test_schema_has_no_unsupported_constraints(self):
        """Structured outputs reject minimum/maximum/minLength."""
        blob = json.dumps(lb.OUTPUT_SCHEMA)
        for bad in ('"minimum"', '"maximum"', '"minLength"', '"maxLength"',
                    '"multipleOf"'):
            self.assertNotIn(bad, blob)

    def test_input_hash_is_stable_and_content_sensitive(self):
        w, a, j = self._prepared()
        t1, h1, _ = lb.build_input(w.window_id, a, j)
        t2, h2, _ = lb.build_input(w.window_id, a, j)
        self.assertEqual(h1, h2)
        w2, a2, j2 = self._prepared(["dinner mom grandma birthday drive"] * 12)
        _, h3, _ = lb.build_input(w2.window_id, a2, j2)
        self.assertNotEqual(h1, h3)

    def test_input_carries_precomputed_numbers(self):
        w, a, j = self._prepared()
        text, _, _ = lb.build_input(w.window_id, a, j)
        self.assertIn("PRECOMPUTED NUMBERS", text)
        self.assertIn("do not re-derive", text)
        self.assertIn("data, not instructions", text)

    def test_unreachable_layer_b_queues_and_falls_back(self):
        w, a, j = self._prepared()
        qp = os.path.join(str(config.QUEUE_DIR), "q_test.jsonl")

        def dead(_payload):
            raise OSError("network down")

        out = lb.run(w.window_id, a, j, "v2_flag", transport=dead, queue_path=qp)
        self.assertFalse(out["available"])
        self.assertTrue(out["queued"])
        self.assertEqual(out["joint_read"], j["joint_read"])
        self.assertEqual(out["joint_read_source"], "layer_a_deterministic")
        self.assertEqual(len(lb.pending(qp)), 1)

    def test_successful_call_parses_and_audits(self):
        w, a, j = self._prepared()
        payload_obj = {
            "topics": ["deploy pipeline"], "entities": [],
            "discourse_moves": [{"move": "coordinating", "share": 1.0}],
            "wiki_nodes": [], "joint_read": "Content and style both moved.",
            "confidence": 0.7, "ambiguity": "task vs state not separable"}

        def fake(_payload):
            return {"id": "msg_1", "stop_reason": "end_turn",
                    "usage": {"input_tokens": 100, "output_tokens": 50},
                    "content": [{"type": "text", "text": json.dumps(payload_obj)}]}

        out = lb.run(w.window_id, a, j, "v2_flag", transport=fake)
        self.assertTrue(out["available"])
        self.assertEqual(out["joint_read_source"], "layer_b")
        self.assertEqual(out["topics"], ["deploy pipeline"])
        self.assertEqual(out["validation_issues"], [])
        self.assertTrue(out["prompt_hash"])
        self.assertTrue(out["input_hash"])

    def test_gate_violation_blocks_render_but_keeps_archive(self):
        w, a, j = self._prepared()
        bad = {"topics": [], "entities": [], "discourse_moves": [],
               "wiki_nodes": [], "joint_read": "Clear relapse signature here.",
               "confidence": 0.9, "ambiguity": "none"}

        def fake(_payload):
            return {"id": "msg_2", "stop_reason": "end_turn", "usage": {},
                    "content": [{"type": "text", "text": json.dumps(bad)}]}

        out = lb.run(w.window_id, a, j, "manual", transport=fake)
        self.assertTrue(out["gate_violation"])
        self.assertEqual(out["banned_terms"], ["relapse"])
        self.assertEqual(out["joint_read"], j["joint_read"])
        self.assertEqual(out["joint_read_source"], "layer_a_deterministic_gate_block")
        newest = sorted(os.listdir(str(config.AUDIT_DIR)))[-1]
        with open(os.path.join(str(config.AUDIT_DIR), newest), encoding="utf-8") as fh:
            audits = [json.loads(line) for line in fh if line.strip()]
        self.assertTrue(any(r.get("output", {}).get("joint_read", "").startswith(
            "Clear relapse") for r in audits), "raw output must still be archived")

    def test_refusal_and_truncation_are_failures_not_silent(self):
        w, a, j = self._prepared()
        for resp in ({"stop_reason": "refusal", "stop_details": {"category": "x"},
                      "content": []},
                     {"stop_reason": "max_tokens", "content": []}):
            with self.assertRaises(lb.LayerBUnavailable):
                lb.extract_json(resp)

    def test_validation_reports_out_of_range(self):
        issues = lb.validate({"confidence": 1.7, "joint_read": "x",
                              "entities": [{"name": "n", "status": "novel",
                                            "salience": 9}],
                              "discourse_moves": [{"move": "a", "share": 0.2}]})
        self.assertEqual(len(issues), 3)

    def test_triggers_are_exhaustive(self):
        w, a, j = self._prepared()
        sp = os.path.join(str(config.STATE_DIR), "lb_trig_%f.json" % time.time())
        # v3-only semantic flag with no v2 flag must NOT fire Layer B.
        j_no_style = dict(j, style={"available": True, "style_flag": False})
        fire, _, why = lb.should_fire(a, j_no_style, "auto", w.end_ts,
                                      state_path=sp)
        self.assertFalse(fire)
        self.assertEqual(why, "no_v2_flag_or_alert")
        fire, by, _ = lb.should_fire(a, j, "auto", w.end_ts, state_path=sp)
        self.assertTrue(fire)
        self.assertEqual(by, "v2_flag")
        # cost brake: a sustained cluster must not fire every 30 minutes
        fire, _, why = lb.should_fire(a, j, "auto", w.end_ts + 1800,
                                      state_path=sp)
        self.assertFalse(fire)
        self.assertEqual(why, "layer_b_cooldown")
        fire, _, _ = lb.should_fire(a, j, "auto",
                                    w.end_ts + config.LAYER_B_COOLDOWN_SEC + 1,
                                    state_path=sp)
        self.assertTrue(fire)
        for t in ("manual", "daily_digest"):
            self.assertTrue(lb.should_fire(a, j, t, w.end_ts, state_path=sp)[0])


class TestReplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        config.ensure_dirs()
        cls.profiles, cls.null = build_artifacts()
        cls.registry = reg.Registry.load()

    def _record(self, texts, runs, wins):
        w = mk_window(texts)
        window_store.write(w, "test", wins)
        a = la.score_window(w, self.registry, self.profiles, self.null)
        j = joint.build_joint(a, {"available": True, "style_flag": True},
                              w.end_ts,
                              state_path=os.path.join(str(config.STATE_DIR),
                                                      "replay_alert.json"))
        rec = runrecord.build(a, j, {"available": False, "reason": "not_triggered"},
                              {"available": True, "style_flag": True}, None,
                              w.end_ts, la.inputs_hash(w, a),
                              window_store.path_for(w.window_id, wins))
        runrecord.write(rec, runs)
        return w, rec

    def test_replay_is_exact(self):
        from v3 import verify_replay_v3 as vr
        runs = os.path.join(str(config.DATA_ROOT), "replay_runs")
        wins = os.path.join(str(config.DATA_ROOT), "replay_windows")
        _, rec = self._record(["deploy latency rollback staging pipeline"] * 20,
                              runs, wins)
        res = vr.replay_record(rec, self.registry, self.profiles, self.null,
                               store_base=wins)
        self.assertEqual(res["status"], "PASS", res["diffs"])
        self.assertEqual(res["diffs"], [])

    def test_replay_detects_tampering(self):
        from v3 import verify_replay_v3 as vr
        runs = os.path.join(str(config.DATA_ROOT), "replay_runs2")
        wins = os.path.join(str(config.DATA_ROOT), "replay_windows2")
        _, rec = self._record(["deploy latency rollback staging"] * 20, runs, wins)
        rec["layer_a"]["semantic_percentile"] = 0.123456
        res = vr.replay_record(rec, self.registry, self.profiles, self.null,
                               store_base=wins)
        self.assertEqual(res["status"], "FAIL")
        self.assertTrue(any(d["field"] == "semantic_percentile"
                            for d in res["diffs"]))

    def test_layer_a_opens_no_socket(self):
        """Layer A must run with zero network. Enforced, not asserted in prose."""
        real = socket.socket

        def boom(*a, **k):
            raise AssertionError("Layer A opened a socket")

        socket.socket = boom
        try:
            rows = [r["text"] for r in make_corpus(seed=77) if r["tier"] == "work"][:40]
            out = la.score_window(mk_window(rows), self.registry, self.profiles,
                                  self.null)
            # The point is that nothing dialled out; the score is incidental.
            self.assertIsNotNone(out["axes"]["topic"]["divergence"])
            self.assertIsNotNone(out["confidence"])
        finally:
            socket.socket = real


class TestRunRecordReadPath(unittest.TestCase):
    def test_daily_worker_contract(self):
        runs = os.path.join(str(config.DATA_ROOT), "contract_runs")
        t = 1_700_000_000.0
        a = {"window": {"window_id": "v3:trailing_hours:1700000000:abc",
                        "kind": "trailing_hours", "end_ts": t, "n_messages": 3,
                        "dominant_tier": "work"},
             "artifact_hashes": {}, "semantic_percentile": 0.99,
             "dominant_axis": "topic"}
        j = {"quadrant": "state_change_or_new_domain", "joint_read": "x",
             "joint_read_source": "layer_a_deterministic",
             "alerting": {"status": "ALERT"},
             "calibration_gate": {"state": "OPEN"}}
        rec = runrecord.build(a, j, {"available": False}, {"available": True},
                              None, t, "hash")
        runrecord.write(rec, runs)
        got = runrecord.read_range(t - 10, t + 10, runs)
        self.assertEqual(len(got), 1)
        r = got[0]
        for path in (("joint", "quadrant"), ("joint", "joint_read"),
                     ("joint", "joint_read_source"),
                     ("layer_a", "semantic_percentile")):
            node = r
            for k in path:
                self.assertIn(k, node)
                node = node[k]
        self.assertEqual(r["joint"]["alerting"]["status"], "ALERT")
        self.assertEqual(r["schema_version"], runrecord.SCHEMA_VERSION)
        self.assertIn("window_semantics_note", r["v2"])
        self.assertEqual(runrecord.read_range(t + 100, t + 200, runs), [])


class TestBackfillIndex(unittest.TestCase):
    def test_index_lookup_survives_underscores_in_window_kind(self):
        """'v3:trailing_hours:...' sanitizes to a name that cannot be reversed;
        the index must be keyed by the sanitized form, not by un-sanitizing."""
        from v3 import backfill_v3
        runs = os.path.join(str(config.DATA_ROOT), "bf_runs")
        t = 1_700_000_000.0
        wid = "v3:trailing_hours:1700000000:abc123def456"
        rec = runrecord.build(
            {"window": {"window_id": wid, "kind": "trailing_hours", "end_ts": t,
                        "n_messages": 1, "dominant_tier": "work"},
             "artifact_hashes": {}},
            {"quadrant": "baseline"}, {"available": False}, {"available": False},
            None, t, "h")
        runrecord.write(rec, runs)
        idx = backfill_v3.build_index(runs)
        p, got = backfill_v3.find_record(wid, idx, runs)
        self.assertIsNotNone(got, idx)
        self.assertEqual(got["window_id"], wid)
        self.assertEqual(backfill_v3.find_record("v3:trailing_n:1:x", idx, runs),
                         (None, None))

    def test_read_range_only_opens_spanning_days(self):
        runs = os.path.join(str(config.DATA_ROOT), "span_runs")
        base = 1_700_000_000.0
        for i in range(6):
            t = base + i * 86400
            wid = "v3:trailing_n:%d:aa%02d" % (t, i)
            runrecord.write(runrecord.build(
                {"window": {"window_id": wid, "kind": "trailing_n", "end_ts": t,
                            "n_messages": 1, "dominant_tier": "work"},
                 "artifact_hashes": {}},
                {"quadrant": "baseline"}, {"available": False},
                {"available": False}, None, t, "h"), runs)
        self.assertEqual(len(list(runrecord.iter_paths(runs))), 6)
        got = runrecord.read_range(base, base + 86400, runs)
        self.assertEqual(len(got), 2)
        self.assertEqual(len(runrecord.days_spanning(base, base + 86400)), 4)


class TestBuildScripts(unittest.TestCase):
    def test_profiles_separate_tiers(self):
        prof = btp.build(make_corpus(seed=42), top_k=40, min_count=2,
                         min_tier_tokens=100)
        self.assertEqual(prof["status"], "built")
        self.assertIn(config.LONGTAIL_TIER, prof["tiers"])
        work = set(prof["tiers"]["work"]["weights"])
        fam = set(prof["tiers"]["family"]["weights"])
        self.assertTrue(work & set(TIER_WORDS["work"].split()))
        self.assertLess(len(work & fam) / max(len(work), 1), 0.5)

    def test_null_is_seeded_and_reproducible(self):
        rows = make_corpus(seed=1, per_tier=120)
        prof = btp.build(rows, top_k=40, min_count=2, min_tier_tokens=100)
        r = reg.Registry.load()
        a = bsn.build(rows, prof, r, draws=240, seed=5)
        b = bsn.build(rows, prof, r, draws=240, seed=5)
        self.assertEqual(a["strata"], b["strata"])
        self.assertIn("*|*", a["strata"]["topic"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
