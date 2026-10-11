# Safety events

A `safety_events` row (metadata only: user, conversation, layer, outcome, lexicon version, time) is written whenever an interview or debrief is interrupted. The athlete's text is **not** retained for an interrupted turn.

## What happens automatically

1. Layer 1 (`packages/core/src/safety/lexicon.ts`) runs before any model call. Layer 2 is the model's `safety_signal`.
2. Crisis: the conversation becomes `SAFETY_INTERRUPTED`, the app shows the crisis card for the athlete's territory (9-8-8 call or text and emergency services for Canada and the US), and generation from that conversation is impossible. A new interview starts from scratch.
3. Ambiguous: the reviewed clarification message replaces the model's question and no profile update from that turn is applied.

## What a human does

- Weekly: review counts by `layer` and `lexicon_version` for drift. A rise in `model` layer interruptions with no `deterministic` ones suggests lexicon gaps; a rise in false positives on sports idioms suggests a lexicon change is needed.
- Never read athlete text to investigate. If a missed case is reported, reproduce it with a fictional message in the red-team set instead.
- Any lexicon or message change runs the full safety evaluation (EVALS §6) and is approved by the content and safety reviewer (D-30). **The seed lexicon and crisis copy are not approved for beta.**
