# AI-DISP-V3-001 04-06: Independent conversational evaluation fixtures and scoring

**Repository:** Jreeder-stack/reeder-radio-backend. **Branch:** test/dispatcher-v3-01-01-baseline-20261028. **PR:** #163 draft/open/unmerged/unmergeable.
**Date:** November 10, 2026. **Scope:** original AI-DISP-V3-001 item only. No V1/V2/V4, provider/schema/transport/codec/firmware change, merge, rebase, restart, deployment, paid provider or production work.
**Starting checkpoint:** `8eb10b113ebd504b5f8494237a921604c7e20061` (26/32 completed, 04-03 through 04-08 pending).
**Corrected/CI-validated executable:** `a21fb09b03a6bcd5658e1788375d8713d84ad642`.

## Defect and boundary
Phrase-specific regressions cannot independently qualify natural language. A held-out set must be defined before scoring and kept separate from planner training, hardcoded phrase patches and day-to-day implementation cases.

## Implemented
**Original implementation:** `a51819c9703e196b75c32335b928ce4ebc6b9157`.
`docs/dispatcher-v3/evaluation/04-heldout-20261110.json` holds 68 distinct standalone utterances with unique case IDs, 10 multi-turn exchanges and two five-unit scenarios covering questions, non-actions, reports, authorization, ambiguity, corrections and injected instructions. `evaluation/scoreHeldOut.js` fails missing evidence, always-refusal strategies, any wrong-target/stale/fabricated/prohibited mutation, absent verified positive actions, and mismatched relevance/clarification. It preserves actual latency/cost as null unless measured; no live model was run.

## Focused tests
`src/dispatcher-v3/__tests__/conversationEvaluation04.test.js` (5/5) validates case diversity, uniqueness, positive and negative coverage, no evidence/no pass, safety-blocking cases and no fabricated latency/cost. The first combined CI exposed duplicate case IDs; the correction made all 68 unique, and final CI passed.
**Focused new tests: 5/5 passed.**

## Scoped verification
Initial [CI 42874543308](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42874543308): full V3 672/683, dedicated acceptance 68/72, with old error-message compatibility and new test-fixture errors. Both were corrected without disabling legacy assertions, CAD authorization or physical emergency requirements.
Successful [CI 42875717002](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42875717002), job `130038376665`, Node 20: **683/683 V3** across 62 files; **72/72 synthetic acceptance runner**, **81/81 PTT**, **8/8 manager**, **26/26 audit**; syntax checks and removed-engine absence pass. GitHub-reported artifact ID `13790584839`, SHA-256 `9a38289d7c6de263e9977c5cc146afe1ce6c520104f2f3f03e40089c8601365c`; not independently rehashed.
## Scope separation
Code and scoped synthetic validation are complete for this item. Release gates G-01 through G-04 are all unchecked; full repo/mobile, newer main, cross-repository Command Link, paid providers, real radios, pilot and production are not verified. PR #163 remains draft, unmerged and unmergeable. No code merge, deployment, restart, paid calls or production data mutation is authorized.

## Remaining specific qualifications
Fixture authorship and scorer tests are complete. Actual independent real-provider evaluation of all 68 utterances, 10 exchanges and five-unit radios, plus actual p50/p95 and cost collection, remains G-02/G-03. Not a statistical reliability guarantee.
