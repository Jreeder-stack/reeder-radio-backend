# AI Dispatcher V3 03-02: one semantic interpretation contract

**Plan:** AI-DISP-V3-001. **Item:** original 03-02 only. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable. **Date:** October 30, 2026 (US Eastern).

## Diagnosis

The original runtime already had a center-scoped, authenticated V3 PTT conversation/task ledger (02-01–02-08), trusted gate, bounded action pipeline, existing Azure OpenAI planner and a deliberately narrow deterministic fast path (03-01). But model JSON was normalized in `intentPlanner.js` independently from deterministic plans. There was no common category for action requests versus information questions, observations, corrections, cancellations, clarifications and conversation-only replies. Model input included sanitized CAD snapshots but did not enumerate only the current runtime's allowed capabilities. The model's JSON parser accepted any known action including the **physical-only** `DECLARE_EMERGENCY` capability and copied unbounded, arbitrary nested raw input into plan candidates before the existing CAD materializer and verifier.

The correct repair is one **interpretation** contract, not a new dispatcher or phrase matcher. Authorization remains exclusively with the current V3 actor/session checks, unit/call materializer and CAD action executor. Any model output is a candidate plan, never a grant or a proven factual account. Genuinely unaddressed speech is determined at the original trusted radio gate rather than by model text.

## Implemented

- Added `src/dispatcher-v3/semanticContract.js` with `normalizeV3SemanticPlan` shared by deterministic and model paths. It classifies `action_request`, `question`, `observation`, `correction`, `cancellation`, `clarification`, and `conversation_only`. `unaddressed` is an explicit gate-only category, rejected as an untrusted model assertion. Read-only questions cannot select status/other write tools; observational language cannot silently change a unit status. Appropriate field reports and notes remain distinct, authorized actions. Bare `NO_ACTION` can be a conversation or observation, not a failed mutation.
- Existing normalized V3 action allowlist remains the authoritative tool vocabulary. A model cannot output `DECLARE_EMERGENCY`, unknown actions, new database/web tools or fake internal unit/center/account IDs, channel grants, permission flags or verification controls. Input must be bounded/structured; model-generated nested objects and oversized fields are rejected. Compound action output remains bounded to the existing ten steps; dependency execution remains 03-03.
- Added `buildV3SemanticModelContext`: current trusted speaker and channel/dispatch-center, center-authorized operational snapshot, separate fresh shared-incident metadata (no raw note text), owner-scoped short conversation history and pending task, plus `availableActions` and `toolCapabilities` filtered by the runtime's actual scopes. No raw credential, CAD key, other units' private pending tasks or source report text enters the model context. Capability visibility cannot grant permissions; the existing executor independently revalidates scope/identity and verifies any CAD write.
- The planner preserves its existing model, Azure JSON-object response format, deadlines and deterministic rules. The same validated semantic shape is applied regardless of model/shortcut source. Malformed or self-contradictory model plans result in a targeted safe `CLARIFY` without a CAD action; malformed-model containment speech from 03-01 remains truthful. A truly unaddressed transmission never reaches the planner, now explicitly reflected in the runtime's sanitized routing diagnostic.
- Existing 01/02 lifecycle, prompt-delivery receipts, independent field-report coordinator, group-target clarification, compound-action executor, CAD permissions/read-back, and physical hardware emergency controls are unchanged. No new schema, transport/codec, client firmware, provider migration, legacy V1/V2 path or V4 engine.

## Evidence and scoped tests

**Starting documentation HEAD:** `e482a62b001315092f2c0158a9ecdeeaf4cc305f`.
**Previous validated executable:** `ff7a47894cdf7af4a1fd3f03d2dbe6f3c1f3bdbc`.

1. `bfc9c57d3325723313c9a8c786f98c302d718d56`: first semantic contract, planner integration, trusted gate diagnostic and 20 new tests.
2. `f204e30082be6995d2dbc377941d7fbd84f19fd8`: targeted syntax correction and preservation of 03-01 malformed-model failure wording. This is the independently CI-tested executable source. CI now syntax-checks the new contract and test file before entering the full suites.

[GitHub Actions 41062935182](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/41062935182), job `124086942090`, Node 20. The tests use the real V3 planner/intake/gate/turn/handler paths with synthetic credential-backed PTT, CAD HTTP, fake timers, and mocked model/STT/TTS/audio. There were **no live or paid provider calls, real radio output, external CAD mutations, production data or service changes**.

| Scope | Passed | Failed |
| --- | ---: | ---: |
| 03-02 semantic interpretation and actual V3 runtime | **20** | **0** |
| Existing audit baseline/corrected regressions | **26** | **0** |
| 02-08 five-unit runtime scenarios | **14** | **0** |
| Existing real manager-to-V3 PTT integration | **8** | **0** |
| Existing PTT grants, routing, identity and hardware floor group | **81** | **0** |
| All V3 tests, 48 test files | **570** | **1** |
| Syntax and legacy-engine absence checks | **Passed** | **0** |

New cases cover both normalized planning sources; filtered capabilities and verified speaker/candidate target separation; unfamiliar wording mapped by mocked model to authorized reads/status writes; observational statements not becoming status changes; safe authorized field reports; question/observation-versus-write contradictions resulting in explicit clarification; corrections/cancellations/conversation-only/no-match control; truly unaddressed radio ignored by the gate; invented and physical-emergency voice tools rejected; model-controlled internal IDs/grants blocked; read-only runtime incapable of executing write despite model request; center-private dialogue and report sanitization; compound output validation; invalid nested/oversized/prototype fields; safe original clarification proposal; and verified versus unverified shared incident evidence labels.

The full CI workflow correctly remains **FAILED**, with the only failure being the **unchanged** `src/dispatcher-v3/__tests__/phase4Pipeline.test.js` CREATE_CALL acknowledgment fixture. It expects affirmative speech without independent CAD read-back. The actual runtime refuses to assert a mutation was verified. The fixture, independent verifier, authorization, emergency policy and failing assertion were not weakened, hidden or altered.

CI artifact: `12981490473`, name `dispatcher-v3-evidence-41062935182-1`, GitHub-reported SHA-256 `5f1cd9b32106fe4f0c99110b2533948106d982e2aa195d95b53611c1735c3766`. The ZIP was **not** independently downloaded/rehashed.

## Limits and next scope

- Synthetic model responses verify the **contract and action boundaries**, not real Azure model classification quality for previously unseen utterances. Accuracy/latency in noisy radio conditions, authentic speech, model prompts and real dispatch tasks need the original later acceptance gates; do not present these tests as live field approval.
- `NO_ACTION` can now be classified correctly as non-mutating conversation/observation. Generating natural spoken responses when no CAD mutation is appropriate remains a separate original Task 04 scope, not quietly claimed complete here.
- 03-03 owns compound-request dependency semantics; 03-04 call ambiguity/reference resolution; 03-05 authorization/input deeper audit; 03-06 outcome reconciliation; 03-07 complete factual responses; 03-08 integrated semantic tests and cleanup. These are not implicitly marked done by 03-02.
- No full repository/mobile testing, integration against independently advanced `main`, cross-repository Command Link testing, real radio/provider/human audibility, original live scenario, pilot/release approval, production deployment or restart occurred. PR remains draft/open/unmerged/unmergeable. G-01–G-04 all unchecked.

**03-02 coding/scoped mocked validation complete.** Task01 `8/8`, Task02 `8/8`, Task03 `2/8`, Task04 `0/8`, **18/32**. **Next exact original item: 03-03, Preserve compound requests and action dependencies.**
