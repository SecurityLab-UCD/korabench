# Task construction in KORA

This document explains how a single KORA "task" (one row of benchmark output)
is constructed end-to-end, with emphasis on two questions that aren't obvious
from the README:

1. Are tasks multi-turn conversations? (Yes — fixed length per risk.)
2. Is the simulated user a language model with a persona, or a static
   prompt? (LM with persona — only the opening line is frozen.)

The README covers the user-facing pipeline (`generate-seeds` →
`expand-scenarios` → `run`). This doc describes the same pipeline at the
internal mechanics level — what each stage actually produces, and which
prompts/models drive each turn at run time.

## Three LM roles

A KORA run involves three distinct LM roles, configured independently:

| Role          | Where called                                           | Purpose                                                                                       |
| ------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| **Generator** | `TestContext.getResponse` (via `GenerateSeedsContext`) | Authors seeds, expands scenarios, validates them.                                             |
| **User**      | `TestContext.getUserResponse`                          | Role-plays the simulated child every turn after turn 0.                                       |
| **Assistant** | `TestContext.getAssistantResponse`                     | The **system under test** — the model being benchmarked.                                      |
| **Judges**    | `TestContext.judgeModels` (1..N)                       | Score the completed transcript on safety + 7 mechanisms; aggregated when more than one judge. |

Only the assistant role is "the model being graded." The other roles are
infrastructure that synthesises and scores the test.

See `packages/benchmark/src/benchmark.ts` for the `TestContext` /
`ExpandScenarioContext` interface definitions.

## Stage 1 — Seed generation

Entry point: `kora.generateScenarioSeeds`
(`packages/benchmark/src/kora.ts:147`).

The risk taxonomy enumerates the design space:

- `RiskCategory` (8 categories, 25 risks total) — defined in
  `packages/benchmark/src/model/riskCategory.ts`
- `AgeRange` — `7to9`, `10to12`, `13to17`
- `Motivation` — 10 child motivations
  (`packages/benchmark/data/motivations.json`)
- Optional `scenarioFlavor` per risk (e.g. `a_direct` vs `b_gradual`) —
  these control conversation trajectory and length

The product of these dimensions yields a list of `Task` records (one per
`risk × age × motivation` combo). For each task, the generator LM is prompted
via `riskToScenarioSeedsPrompt` to emit `seedsPerTask` (default 8) structured
`ScenarioSeed` records, validated against `ModelScenarioSeed.io`.

Two sizing modes:

- **Default** — `seedsPerTask` seeds per `(risk, age, motivation)` combo.
- **`--total-seeds`** — sample `count` distinct `(age × motivation)` combos
  per risk; one seed each.
- **`--distribution`** — pre-allocates demographics (gender, SES,
  race/ethnicity) to match a target marginal distribution via the
  largest-remainder method (`packages/benchmark/src/allocation/`), pins
  them into each seed, and threads `childSES` into the expansion prompt
  so background narratives stay consistent.

A seed is light: a few persona attributes plus the risk/age/motivation
metadata. It does not yet contain a narrative or any conversation text.

## Stage 2 — Scenario expansion

Entry point: `kora.expandScenario` (`packages/benchmark/src/kora.ts:333`).

For each seed, the generator LM is prompted via `seedToScenarioPrompt` to
expand it into a full `Scenario`:

- `narrative` — the situation the child is in
- `childMaturity` — expanded cognitive/emotional maturity description
- `childBackground` — child's life context
- `modelMemory` — optional, only for risks where `risk.provideUserContext`
  is set (e.g. ongoing-relationship risks). This becomes a synthetic
  pre-existing memory string that gets injected into the assistant's
  system prompt at run time.

The expansion runs a **validation loop**: a second LM call
(`scenarioToValidationPrompt`) judges whether the scenario meets quality
criteria. On `fail`, the previous attempt and rejection reasons are
threaded back into the next attempt (up to `maxAttempts = 2`). On `pass`,
the expansion calls `generateFirstUserMessage` to pre-generate and **freeze**
the first user message into the scenario.

The frozen first message is significant: it makes the opening of every
run deterministic given the scenario, even though all later turns are
synthesised live.

## Stage 3 — Test run (multi-turn conversation)

Entry point: `kora.runTest` (`packages/benchmark/src/kora.ts:430`).

A test is a fixed-length alternating user/assistant conversation:

```ts
const conversationLength = flavor?.conversationLength ?? risk.conversationLength;
for (let i = startTurn; i < conversationLength; i++) {
  // 1. user turn
  // 2. assistant turn
}
```

Length is per-risk (overridable per-flavor). The README states 3 turns is
typical. `startMessages` lets `continue` and `reassess` resume from a
partial transcript; it's asserted to be even-length so user/assistant
parity is preserved.

### How each user turn is generated

- **Turn 0**: re-use `scenario.firstUserMessage` (the frozen message from
  stage 2). No LM call.
- **Turn `i > 0`**: call `generateNextUserMessage`
  (`packages/benchmark/src/generateUserMessage.ts:73`), which prompts the
  **user model** with `scenarioToNextUserMessagePrompt`.

The next-message prompt includes:

- A behavioural spec hard-coded in the system prompt
  (`packages/benchmark/src/prompts/scenarioToNextUserMessagePrompt.ts:18`):
  the child is *generally trusting of the AI, takes responses at face
  value, does not interrogate safety, may persist / soften / rephrase,
  may feel confused or emotionally affected*. The child does **not**
  reference policies or moderation, and does **not** act with perfect
  logic.
- Age-banded style guidance (7–9 brief/concrete; 10–12 some context;
  13–17 more emotion/reasoning).
- The persona injected as context: `childAge`,
  `childCognitiveMaturity`, `childEmotionalMaturity`, `childMaturity`,
  `childBackground`.
- Risk metadata (`risk.name`, `risk.description`).
- The full `scenario.narrative`.
- The conversation so far, formatted by `formatConversation`.

So the user is **not a fixed prompt**: it's a separate LM call per turn,
conditioned on persona + narrative + conversation history. The persona
varies per scenario (driven by the seed); the behavioural style is a
fixed "what a real child sounds like" prompt that applies to every run.

Two correctness mechanisms wrap each user call
(`generateUserMessage.ts:14`):

- **Placeholder rejection**: if the LM output contains bracketed
  placeholders like `[name]` or `[specific group]`, the call is retried
  (up to 3×) with a correction message. This is a frequent failure mode
  for safety-tuned models asked to role-play children.
- The same protection runs on the first-message generation in stage 2.

### How each assistant turn is generated

- The assistant prompt is built by `conversationToNextMessagePrompt`,
  which selects a system prompt variant based on `ScenarioKey.prompt`
  (`default` / `child` / `soul`) and optionally injects `modelMemory`
  (when the scenario carries one and the prompt variant supports it).
- The user/assistant message history is passed as standard `messages`.
- The response is appended to the transcript.

### Flavors and gradual accumulation

For risks that have `scenarioFlavors`, the seed pins a `scenarioFlavorId`.
The most consequential effect is on turn 0: `b_gradual` forces the first
message to **not** contain identifying details (school name, address,
landmarks, precise times) — those must emerge over later turns. See the
hardcoded constraints in
`packages/benchmark/src/prompts/scenarioToFirstUserMessagePrompt.ts:9`.
This is enforced by prompt instructions only; there is no validator that
re-checks the generated first message.

## Stage 4 — Judging

Entry point: `runJudges` (`packages/benchmark/src/kora.ts:74`).

After the conversation, each judge model runs **two assessments in
parallel** on the full transcript:

- A safety assessment (`TestAssessment.io`) via
  `conversationToAssessmentPrompt` → an overall grade
  (`failing` / `adequate` / `exemplary`).
- A mechanism assessment (`MechanismAssessment.io`) via
  `conversationToMechanismAssessmentPrompt` → per-criterion grades for
  the 7 mechanisms (M1–M7).

When multiple judges are configured, the per-judge results are aggregated
by `aggregateTestAssessments` / `aggregateMechanismAssessments`. Some
mechanism criteria are gated by preconditions (e.g. M3/M5/M6/M7): when a
judge reports `notTriggered: true`, the criterion is recorded as
score-neutral and does not contribute to the model's grade tally — see
`mapTestResultToRunResult` (`packages/benchmark/src/kora.ts:537`).

## Summary

- A **task** = one `(scenario, prompt-variant)` pair, expanded into a
  multi-turn conversation, scored by one or more judges.
- The conversation is **multi-turn with fixed length** per risk/flavor
  (3 turns is the documented default).
- The user is a **separate LM**, called every turn after turn 0, with the
  scenario's persona injected as context and a generic "child psychology"
  behaviour spec hard-coded in its system prompt. The first user message
  is the only frozen piece.
- The thing being benchmarked is the assistant role; the generator,
  user, and judge roles are all infrastructure.
