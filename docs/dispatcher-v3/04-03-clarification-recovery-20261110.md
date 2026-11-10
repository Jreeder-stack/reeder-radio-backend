# AI-DISP-V3-001 04-03: Finite task-owned clarification recovery

**Repository:** Jreeder-stack/reeder-radio-backend. **Branch:** test/dispatcher-v3-01-01-baseline-20261028. **PR:** #163 draft/open/unmerged/unmergeable.
**Date:** November 10, 2026. **Scope:** original AI-DISP-V3-001 item only. No V1/V2/V4, provider/schema/transport/codec/firmware change, merge, rebase, restart, deployment, paid provider or production work.
**Starting checkpoint:** `8eb10b113ebd504b5f8494237a921604c7e20061` (26/32 completed, 04-03 through 04-08 pending).
**Corrected/CI-validated executable:** `a21fb09b03a6bcd5658e1788375d8713d84ad642`.

## Defect and boundary
Unclear answers to an original still-pending task could keep requesting the same detail repeatedly. The task ledger already protected the owner, saved operation and candidate list; response handling needed a finite budget and more precise missing-field prompts without replacing the original candidate-rejection errors.

## Implemented
**Original implementation:** `6a26ff1c9996aefe6d01d6adcf362f1a875f2e67` and `b368083c93e382866e2a9abd476df6f414f0bd03`.
`clarificationPolicy.js` defines a finite missing-field question and terminal response. `conversationRecords.js` owns the three-question budget on the authenticated task and retires only that original task after exhaustion. `liveRuntime.js` reuses prior known fields, preserves specific invalid/closed/noncandidate call errors, and refuses to guess from hesitation. The existing pending-prompt delivery receipt, CAD materializer, fresh authorization and independent write read-back remain unchanged.

## Focused tests
`src/dispatcher-v3/__tests__/clarificationRecovery04.test.js` (6/6) exercises missing detail, short complete answer, repeated hesitation, independent new request, other-unit independence and rejected call-target substitution. Existing 02-02/03-04 regression expectations remained mandatory and pass.
**Focused new tests: 6/6 passed.**

## Scoped verification
Initial [CI 42874543308](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42874543308): full V3 672/683, dedicated acceptance 68/72, with old error-message compatibility and new test-fixture errors. Both were corrected without disabling legacy assertions, CAD authorization or physical emergency requirements.
Successful [CI 42875717002](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42875717002), job `130038376665`, Node 20: **683/683 V3** across 62 files; **72/72 synthetic acceptance runner**, **81/81 PTT**, **8/8 manager**, **26/26 audit**; syntax checks and removed-engine absence pass. GitHub-reported artifact ID `13790584839`, SHA-256 `9a38289d7c6de263e9977c5cc146afe1ce6c520104f2f3f03e40089c8601365c`; not independently rehashed.
## Scope separation
Code and scoped synthetic validation are complete for this item. Release gates G-01 through G-04 are all unchecked; full repo/mobile, newer main, cross-repository Command Link, paid providers, real radios, pilot and production are not verified. PR #163 remains draft, unmerged and unmergeable. No code merge, deployment, restart, paid calls or production data mutation is authorized.

## Remaining specific qualifications
Finite fixture coverage does not establish recognition of naturally noisy, fragmented real speech. Real STT/model accuracy, new names and registration recognition remain G-02/G-03.
