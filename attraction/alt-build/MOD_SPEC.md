# Scenario Ratings ALT — modifier authoring spec

## The instrument
An alternate version of the scenario-ratings instrument. Dan rates each base
situation 1–10, then rates 10–20 MODIFIERS per base as LOVE / LIKE / MEH / NO WAY.
Your job: author exactly **12 modifiers** for each base situation assigned to you.

## Input
`/tmp/bases.json` — array of `{idx, id, desc, vec}`. `desc` is the base situation
(a short lowercase phrase, e.g. "watching your girlfriend fuck her ex").
Use your batch's `idx` range only.

## Output
Write `/tmp/alt-mods/batch-N.json` (N = your batch number) as a JSON array:
```json
[
  {"baseIdx": 0, "baseId": "b00", "baseDesc": "watching your girlfriend fuck her ex",
   "modifiers": [
     {"text": "he cums inside her", "theme": "FLUID"},
     {"text": "she's wearing the outfit from your first date", "theme": "TONE"}
   ]}
]
```
Exactly 12 modifiers per base. `theme` is one of: WHO, ACT, WHERE, SEEN, FLUID, TONE, AFTER.

## Theme meanings
- WHO: participants change — someone added, removed, swapped (only when the base survives it)
- ACT: what is physically being done changes
- WHERE: setting changes
- SEEN: witnesses, filming, photos, being overheard, livestream
- FLUID: cum, piss, squirt, spit, swallow — where fluids go / who takes them in
- TONE: power, roughness, tenderness, pace, taboo framing, who's in charge
- AFTER: aftermath — cleanup, cuddling, talking about it later, doing it again

## HARD RULES — violating any of these fails the batch
1. **The modifier must make sense in the situation.** Read the base literally:
   who is present, what is happening, where. The #1 failure mode to avoid:
   a base about *her squirting* got the modifier *"no girl involved"* — absurd.
   Never remove a load-bearing participant. Never add something the base's own
   logic forbids. If the base is "solo male", don't add "she" anything.
   If the base has no third party, "the third guy" is meaningless — name or
   describe who you mean from the base's own cast.
2. **One change per modifier.** Not two. "he cums inside her while she moans
   your name" is two changes — split or pick one.
3. **A modifier is a CHANGE, not a restatement.** Don't echo the base back
   with slightly different words.
4. **No duplicates within a base's 12** — not even near-duplicates
   ("he pulls out" vs "he doesn't cum inside her" = same modifier, pick one).
5. **Theme spread:** at least 5 different themes across the 12. Don't do 12
   WHO modifiers.
6. **Discriminating:** each modifier should be something a person could plausibly
   LOVE, LIKE, MEH, or NO WAY — a real preference question, not trivia.
   ("it happens on a Tuesday" is not a modifier.)
7. **Terse:** one clause, ~12 words max, plain lowercase descriptive language
   like the base descs. No purple prose, no second person beyond what's needed.
8. **Physically possible** given the base. No teleporting, no contradictions
   ("in the car" base → "in the bedroom" is fine; "in the car" base →
   "the car is parked inside the bedroom" is not).
9. **Don't moralize, don't editorialize.** Describe the variation, nothing else.
10. **Consent is presumed** throughout the instrument — never write modifiers
    about coercion, force, or anyone underage. If a base involves role play
    with an age gap, keep modifiers on the play, not on real minors.

## Calibration examples
Base: "watching your girlfriend fuck her ex"
- GOOD (ACT): "he eats her out first"
- GOOD (SEEN): "he doesn't know you're watching"
- GOOD (FLUID): "he cums on her face"
- GOOD (TONE): "she moans your name while he fucks her"
- GOOD (WHO): "it's a stranger instead of her ex"
- BAD: "you're not there" (removes the load-bearing watcher — the base IS watching)
- BAD: "she fucks her ex" (restatement)
- BAD: "no girl involved" (absurd — the base is about her)

Base: "she squirts"
- GOOD (FLUID): "she squirts in your mouth"
- GOOD (WHERE): "she squirts on the couch and you don't clean it up"
- BAD: "no girl involved"

## Self-check before writing the file
For each base, re-read all 12 and ask: does every one make sense IN this
situation? Could any two be the same answer? Are 5+ themes covered?
If any answer is no, fix it before writing.
