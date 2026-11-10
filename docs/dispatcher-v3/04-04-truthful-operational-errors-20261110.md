# AI-DISP-V3-001 04-04: Specific operational errors and outbound delivery faults

**Repository:** Jreeder-stack/reeder-radio-backend. **Branch:** test/dispatcher-v3-01-01-baseline-20261028. **PR:** #163 draft/open/unmerged/unmergeable.
**Date:** November 10, 2026. **Scope:** original AI-DISP-V3-001 item only. No V1/V2/V4, provider/schema/transport/codec/firmware change, merge, rebase, restart, deployment, paid provider or production work.
**Starting checkpoint:** `8eb10b113ebd504b5f8494237a921604c7e20061` (26/32 completed, 04-03 through 04-08 pending).
**Corrected/CI-validated executable:** `a21fb09b03a6bcd5658e1788375d8713d84ad642`.

## Defect and boundary
The Task 03 factual contract protected CAD writes, but some non-success paths returned only a generic dead end; queued responses were observable in diagnostics but lacked a bounded operator-status summary for failed local radio delivery.

## Implemented
**Original implementation:** `4340672774d1b77f7eb0ff2319c02eb4fa2adee8`.
`operationalReplies.js` maps server-owned failure codes to bounded truthful guidance and records `RADIO_REPLY_NOT_DELIVERED` without raw CAD or transcript data. `responseComposer.js` and `liveRuntime.js` use it for supported failures while keeping historical unauthorized and planning-error wording where existing regression contracts require it. An unknown submitted write always requires reconciliation before repeat, not a false definitive failure. The status is local relay output evidence, never proof the human received it.

## Focused tests
`src/dispatcher-v3/__tests__/truthfulFailures04.test.js` (12/12) covers access, unsupported/missing inputs, stale/service errors, an uncertain write, no false handoff and forced TTS delivery failure. Original 01/03 error and authorization regressions pass.
**Focused new tests: 12/12 passed.**

## Scoped verification
Initial [CI 42874543308](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42874543308): full V3 672/683, dedicated acceptance 68/72, with old error-message compatibility and new test-fixture errors. Both were corrected without disabling legacy assertions, CAD authorization or physical emergency requirements.
Successful [CI 42875717002](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42875717002), job `130038376665`, Node 20: **683/683 V3** across 62 files; **72/72 synthetic acceptance runner**, **81/81 PTT**, **8/8 manager**, **26/26 audit**; syntax checks and removed-engine absence pass. GitHub-reported artifact ID `13790584839`, SHA-256 `9a38289d7c6de263e9977c5cc146afe1ce6c520104f2f3f03e40089c8601365c`; not independently rehashed.
## Scope separation
Code and scoped synthetic validation are complete for this item. Release gates G-01 through G-04 are all unchecked; full repo/mobile, newer main, cross-repository Command Link, paid providers, real radios, pilot and production are not verified. PR #163 remains draft, unmerged and unmergeable. No code merge, deployment, restart, paid calls or production data mutation is authorized.

## Remaining specific qualifications
No new external human handoff service was added; a spoken recommendation to call a human does not mean a handoff was delivered. Actual radio audibility and production observability remain unchecked.
