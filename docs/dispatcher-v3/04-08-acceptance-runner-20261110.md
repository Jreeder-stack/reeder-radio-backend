# AI-DISP-V3-001 04-08: Synthetic end-to-end acceptance runner and supervised pilot runbook

**Repository:** Jreeder-stack/reeder-radio-backend. **Branch:** test/dispatcher-v3-01-01-baseline-20261028. **PR:** #163 draft/open/unmerged/unmergeable.
**Date:** November 10, 2026. **Scope:** original AI-DISP-V3-001 item only. No V1/V2/V4, provider/schema/transport/codec/firmware change, merge, rebase, restart, deployment, paid provider or production work.
**Starting checkpoint:** `8eb10b113ebd504b5f8494237a921604c7e20061` (26/32 completed, 04-03 through 04-08 pending).
**Corrected/CI-validated executable:** `a21fb09b03a6bcd5658e1788375d8713d84ad642`.

## Defect and boundary
Passing individual unit tests cannot substitute for a repeatable cross-path acceptance procedure or recorded operator/rollback controls. A deterministic synthetic runner is needed before any separately authorized paid or live evaluation.

## Implemented
**Original implementation:** `bb577a929c469a316aef1d46b69ee3dfa80c2c90` and `b9a7d00bac45ec71be8a3dd3ed6aff222286ab77`.
`scripts/dispatcher-v3-acceptance.mjs --synthetic` strips provider credentials, accepts no paid/live mode and writes JSON Vitest, synthetic trace and summary evidence in `reports/`. The script exercises the six new 04 suites, older five-unit integration and physical emergency containment. `.github/workflows/ai-dispatcher-v3-ci.yml` runs it after full V3, PTT, manager, syntax and removed-engine checks. The companion `docs/dispatcher-v3/04-08-acceptance-runbook-20261110.md` covers scoped model/CAD, five-radio field testing, explicit cost caps, physical emergency, admin stop, unknown writes and rollback.

## Focused tests
`src/dispatcher-v3/__tests__/acceptanceRunner04.test.js` (2/2) records five-unit interleave and controlled failed synthesis with safe local status. Full dedicated synthetic acceptance 72/72. Real provider/radio measurements are intentionally null, not silently assumed passed.
**Focused new tests: 2/2 passed.**

## Scoped verification
Initial [CI 42874543308](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42874543308): full V3 672/683, dedicated acceptance 68/72, with old error-message compatibility and new test-fixture errors. Both were corrected without disabling legacy assertions, CAD authorization or physical emergency requirements.
Successful [CI 42875717002](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42875717002), job `130038376665`, Node 20: **683/683 V3** across 62 files; **72/72 synthetic acceptance runner**, **81/81 PTT**, **8/8 manager**, **26/26 audit**; syntax checks and removed-engine absence pass. GitHub-reported artifact ID `13790584839`, SHA-256 `9a38289d7c6de263e9977c5cc146afe1ce6c520104f2f3f03e40089c8601365c`; not independently rehashed.
## Scope separation
Code and scoped synthetic validation are complete for this item. Release gates G-01 through G-04 are all unchecked; full repo/mobile, newer main, cross-repository Command Link, paid providers, real radios, pilot and production are not verified. PR #163 remains draft, unmerged and unmergeable. No code merge, deployment, restart, paid calls or production data mutation is authorized.

## Remaining specific qualifications
No real test credentials, human audibility, actual STT/LLM model, production CAD, pilot, newer-main compatibility, or rollback testing was run. G-01 through G-04 remain unchecked and require owner approval.
