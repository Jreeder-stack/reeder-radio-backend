# AI Dispatcher V3 03-03: compound requests and action dependencies

**Plan:** AI-DISP-V3-001; original item **03-03** only. **Date:** October 30, 2026 (US Eastern).
**Repository:** `Jreeder-stack/reeder-radio-backend`.
**Branch:** `test/dispatcher-v3-01-01-baseline-20261028`.
**PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163) (draft/open/unmerged/unmergeable).

## Confirmed root cause

The existing V3 semantic contract correctly admitted bounded action arrays, but omitted machine-readable dependencies or call-result binding. The live runtime simply materialized and executed the array in sequence. As a result, later operations could resolve an unrelated currently assigned call instead of the newly created call; an exception during materialization could lose earlier completed-step evidence; and the radio response gave only a generic acknowledgment or failure, not requested read data and per-step outcomes. Blindly retrying that request could duplicate a prior CAD mutation.

## Implemented within 03-03

- **One V3 plan and existing security boundary:** `semanticContract.js` validates short unique step IDs, preceding-step `dependsOn` references, bounded action inputs and optional `callIdFrom` for supported call-target actions with a corresponding earlier call producer. No model-supplied internal unit IDs, credentials, grants, verified flags or arbitrary result objects are admitted. Omitted dependencies mean previous-step sequencing for compatibility; explicit empty dependencies permit independent reads/writes.
- **Verified dependencies:** New `compoundActions.js` executes through the existing `materializeV3Plan` and `V3ActionExecutor.execute`, using trusted turn identity, current scopes and lifecycle deadlines. It may bind a dependent call target only from a prior returned CAD call that has independent verification (or an authenticated read). An unverified newly created call cannot be used by an assignment, note or other dependent action. Absent or ambiguous call evidence fails closed. Existing center and hardware-emergency controls are unchanged.
- **Per-step results and cleanup:** Steps preserve ID, dependencies, attempted/not-attempted, result or error, submitted-write evidence, and precise verified/read/partial/unknown/failed/blocked/duplicate status. Failed prerequisites block their dependents. Explicitly independent reads continue and return information, even when an unrelated write fails. Identical consecutive verified mutations in a single plan are not resubmitted; later genuinely changed statuses remain independent writes. There is no cross-turn replay, cross-system transaction or rollback claim.
- **Audible factual response:** `responseComposer.js` reports clean created-call location, verified statuses, available CAD read results and which operations were not completed or whose write outcome is unconfirmed. A partial result does not claim total success. Original direct/legacy multi-response callers still fail closed when a mutation lacks independent verification; the existing strict regression expectation was preserved. The separate 03-07 requirement to improve all standalone factual queries remains open.
- **Model planning contract:** Prompt instructions preserve every requested operation, a separate address, explicit dependencies, a verified new-call reference, and independent mixed reads. Model responses are *candidates*, not authorization. No phrase matching fallback or provider migration was added.
- **CI:** New file and test receive syntax-checks in existing `.github/workflows/ai-dispatcher-v3-ci.yml`. No changes to schema, audio/codec, transport, firmware, mobile clients, PTT routing, prior V3 parent items or paid services.

## Scoped evidence

Starting HEAD `a6c99e6982723a93130c74509d00710b5ef7fc03` (docs-only).
Previous validated executable `f204e30082be6995d2dbc377941d7fbd84f19fd8`.

1. **`0caba05d1ee4ff3d73236e2ab1b63f7ae62c8015`**: compound engine, normalized dependencies, model instructions, runtime wiring, per-step spoken reports, 12 mocked end-to-end tests and syntax guards.
2. **`3dc7fcf9416e96db8feef2922c1db35f44350088`**: restored strict verification-response behavior for old multi-action result fixtures without hiding the new per-step partial outcomes. This is the CI-validated executable source.

[CI run 41065901952](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/41065901952), job `124097104072`, Node 20. Original synthetic CAD integration used credential-backed trusted PTT, actual V3 planner, runtime, materializer, executor and read-back verification; STT/TTS/model and CAD HTTP boundaries were mocked. **12/12 new 03-03 tests passed**, including:

- Clean building-check address and ordered on-scene status, independent verification.
- Both explicit and inferred verified created-call ID binding before assignment, no invented ID.
- Submitted-but-unverified create blocking dependent assignment with truthful on-air uncertainty.
- Mixed read/write speaking the read results and verified mutation result, including independent read after failed write.
- Later materializer or authorization failure retaining earlier completed writes, with no automatic bulk replay.
- Invalid/forward/duplicated dependency rejection, result-injection refusal, and consecutive duplicate suppression while preserving legitimate intervening status changes.
- Original scoped center-identity and read-only authorization controls.

The CI also passed **8/8 real manager integration**, **81/81 PTT**, and **582/583 V3 tests** across 49 files. The unchanged sole failure is the old `src/dispatcher-v3/__tests__/phase4Pipeline.test.js` test expecting a positive CREATE_CALL message despite a synthetic acknowledgment with **no independent CAD read-back**. The runtime continues to reject false verification. CI is **FAILED**, not green.

Reported GitHub evidence artifact: `12980624807`, `dispatcher-v3-evidence-41065901952-1`, SHA-256 `3aee1a41d3445f5bab1956c8f98d3a7e35852239011500cc074cb963fdb5718f`. This digest is GitHub-reported, **not independently downloaded/rehashed**. There were no live/paid provider calls, real radio transmission, production CAD mutations, merge, rebase, deployment or restart.

## Remaining boundaries

This is coding plus scoped synthetic validation, **not** G-01–G-04 acceptance, an all-green V3 run, or field/pilot verification. The 03-03 engine provides per-step statuses *within a compound request* only; comprehensive outcome reconciliation, ambiguous call/units resolution, tool input audit, standalone factual replies and integrated held-out semantics remain original items 03-04 through 03-08 and Task 04. Concurrency with independently advanced `main`, full repository/mobile, cross-repository Command Link, actual speech/model quality and live operational hardware remain unverified.

**Checkpoint:** Task 01 8/8, Task 02 8/8, Task 03 **3/8**, Task 04 0/8. **19/32** original items coded and scoped-validated. Release gates G-01–G-04 unchecked. **Next exact original item: 03-04, Resolve unit and call references using adequate evidence.**
