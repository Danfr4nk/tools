# Attacking v3

Written against my own build, in the register Sammy used on v2. Everything
below is a real weakness, ordered by how likely it is to mislead Dan.
Defects found *during* the build and already fixed are in CHANGELOG.md; these
are the ones still standing.

## 1. Where the Layer A heuristics break

**The imperative detector is a verb list.** `discourse.IMPERATIVE_VERBS` has
~70 entries. Every imperative whose verb is not in it scores as declarative,
and the guard against noun homographs ("Book is on the table") is one
lookahead token. Dan's actual imperative vocabulary is not this list — it is
whatever he happens to use, including profanity-fronted forms ("just fucking
ship it") that the opener list catches only by accident. Consequence: the
imperative ratio has an unknown, tier-dependent miss rate, and the discourse
axis is the one most likely to produce a flag that means nothing. It is
labelled `proxy_quality: "lexicon-heuristic"` in every record and named in
every joint read, which is honesty, not a fix. **Fix path:** hand-label 300
sentences from the corpus, measure precision/recall per tier, and either
calibrate the baseline per tier against the measured bias or drop the axis.
Do this before the axis is ever dominant on a real alert.

**Topic divergence is bag-of-words and cannot see negation, sarcasm, or
quotation.** "I'm not doing the deploy" and "doing the deploy" are near
identical vectors. A window where Dan pastes someone else's text scores that
text as his topic. The cosine is over the top-150 per-tier terms, so a window
that is mostly *outside* the profile vocabulary gets a divergence driven by
whichever few profile terms happen to appear — the `coverage` guard
(`MIN_PROFILE_COVERAGE = 0.02`) is very low, and I set it by judgement, not
by measurement.

**Mixed-tier windows are scored per tier but ranked against a single-tier
null.** `score_topics` correctly computes per-tier sub-divergences and a
token-weighted aggregate. But the percentile lookup uses the *dominant* tier's
null stratum, and the null was built from single-tier draws. A window that is
55% work / 45% family gets an aggregate compared against a pure-work null.
This is the most methodologically soft thing in Layer A. **Fix path:** score
each tier's sub-divergence against its own stratum, then combine percentiles
(Fisher or max) instead of combining divergences first.

**Entity spike assumes Poisson.** Mentions are bursty and correlated — Dan
says a name five times in one conversation because he is having that
conversation, not because the rate changed. Poisson treats that as
overwhelming surprise. The cap at 12 bounds the damage; it does not make the
model right. A negative-binomial fit on the baseline would.

**Capitalized-phrase detection is a candidate generator with a bad
precision floor.** It skips sentence-initial words, which is right, but Dan
writes in lowercase a lot — so real entities will be missed entirely — and
any two consecutive capitalized words become a candidate, so `entity_candidates.jsonl`
will accumulate noise fast. It is append-only and never auto-promoted, so the
cost is review time, not false identity. Budget for pruning it weekly.

**`norm_key` is deliberately conservative and will therefore fragment.**
"Sarah", "Sarah Chen", and "@schen" only co-refer because I listed them as
aliases by hand. Nothing detects that "Wire Protocol" and "the wire thing"
are the same project. This is the correct trade — a wrong merge asserts a
falsehood about a real person — but it means registry coverage decays unless
someone maintains it.

## 2. Where the 2x2 misleads

**It has no "both axes unavailable" cell.** If the artifacts are unbuilt or
the null strata are thin, `semantic_flag` is `False`, and `False` is
indistinguishable from "measured and stable" at the quadrant level. The
quadrant then reads `baseline` or `state_shift_familiar_content` — both of
which look like findings. `confidence` drops to ~0 and `ambiguity` says why,
so the information is present, but the *quadrant name* lies. **Any renderer
that shows the quadrant without the confidence is broken.** This is the single
most dangerous thing in the design and I did not fully solve it; I only made
it loud.

**A missing v2 record biases toward quadrant 3.** `v2_bridge` reports
`available: false`, and `build_joint` computes `style_shift = False` from it.
So every window scored without a v2 read lands in `new_task_same_state` or
`baseline` — and quadrant 3 *suppresses alerts*. A broken v2 path therefore
fails silently in the direction of under-alerting. The joint read says "v2
read unavailable", which the daily worker must surface. **Fix path:** a fifth
state (`style_unknown`) that suppresses the quadrant entirely rather than
computing one from a missing input.

**"State change OR new-domain stress" is not a finding.** Quadrant 1 is
honest that it cannot separate the two, but a human reading twenty of these
will start treating quadrant 1 as "bad day". The gloss resists this; repeated
exposure beats glosses. The labels in `labels.jsonl` are the only thing that
can ever separate them, and until five exist the gate keeps the vocabulary
out — which is exactly the right pressure, and also exactly the thing Dan
will be tempted to shortcut.

**Both windows overlap.** `trailing_hours` and `trailing_n` usually share most
of their messages, so their quadrants are correlated. Two "independent"
agreeing reads on the same 90 messages is one read. The per-signature
cooldowns key on `window_kind`, so the two can each alert within the same six
hours on the same underlying event.

## 3. What the token budget missed

**The p95 window size is a guess.** `trailing_n` is exactly 100 by
construction, but I have no measurement of the 4h window's message count or
of Dan's mean message length — I assumed ~35 tokens. If real messages average
80 tokens, input roughly doubles and the Opus monthly figure goes from ~$7 to
~$12. Still small. The estimate is labelled as an estimate in BURNIN §7;
re-derive it from one week of real windows.

**Thinking tokens are the least certain line.** I budgeted ~800 output tokens
of adaptive thinking at `effort: medium`. That is a guess about a model I
cannot measure from here. If the judge task pulls `high`-like depth, output
could triple and the Opus figure lands near $15/mo. Check
`usage.output_tokens` in the audit log after the first week and re-tune
`LAYER_B_EFFORT` — the audit log records usage on every call specifically so
this is measurable rather than arguable.

**Prompt caching probably will not fire.** I put a `cache_control` breakpoint
on the ~1,300-token system prompt, but the minimum cacheable prefix is
model-dependent (512–4096 tokens) and calls are typically 90+ minutes apart,
far outside the 5-minute TTL. It is free if it misses. It will mostly miss,
except during a digest or a batch backfill. Do not count the savings.

**Backfill via the Batch API is implemented but never exercised.** The
sequential path is tested; the batch path has no test that runs it, because
testing it means either mocking three HTTP endpoints or spending money. It is
the least-trusted code in the build.

**The 90-minute Layer B cooldown is unvalidated.** It is the difference
between ~$7/mo and ~$190/mo, and I picked 90 minutes by argument, not by
measurement against the burn-in flag-rate data — which I do not have access
to from here. If real clusters are longer than 90 minutes, this fires more
than modelled; if they are shorter, it suppresses reads Dan wanted.

## 4. What I did not solve

- **No embedding model.** Decided: stdlib lexical proxies + LLM judge. The
  cost/accuracy/latency table is in the build report. A local embedding model
  would fix the negation, paraphrase, and coverage problems in §1 at the cost
  of a heavy dependency on a 2015 MBP, and it is the right next move if the
  topic axis proves too noisy to use.
- **v2's adjacency bug is still open in v2.** v3 does not inherit it, and says
  so loudly, but every v3 record that joins to a v2 record joins to a number
  computed over a possibly-spliced window. `adjacency_divergence` measures the
  disagreement only when v2 exposes its member ids — which, on the schema I
  was given, it may not. `null` there means "unknown", not "agrees".
- **LLM non-determinism is bounded, not removed.** `temperature: 0` is not
  settable on current models. Structured outputs fix the shape; wording,
  topic phrasing, and confidence still move between identical calls. Replay
  verifies provenance, never reproduction.
- **v2's actual output schema is unverified.** I built `v2_bridge` against a
  description of v2, not its source. The tolerant adapter is a hedge, not a
  contract. First real run: check that the style axis is not
  `available: false` everywhere.
- **No test asserts that Layer B's prompt actually produces schema-valid
  output from a real model.** Every Layer B test uses an injected transport.
