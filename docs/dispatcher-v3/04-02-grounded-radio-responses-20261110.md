# AI-DISP-V3-001: Original 04-02, concise grounded radio responses

**Date:** November 10, 2026. **Repo:** Jreeder-stack/reeder-radio-backend.
**Branch:** test/dispatcher-v3-01-01-baseline-20261028. **PR #163:** draft/open/unmerged/unmergeable.

## Root cause and scope

Task 03-07 already provided factual CAD outcome reporting, and 04-01 introduced addressed non-CAD conversation. The radio composer nevertheless returned broad call summaries when only a specific requested fact was relevant. There was no bounded semantic selector for which CAD fields to speak. Allowing the model to compose arbitrary factual prose would risk fabricated locations, assignments and completed actions. This task corrects response selection and presentation, not the existing CAD authorization or write-verification contract.

## Implementation

- Added a finite read-answer field vocabulary for existing GET_CALL/GET_CURRENT_CALL, SEARCH_CALLS, LIST_ACTIVE_CALLS, STATUS_CHECK, TIME_CHECK and RADIO_CHECK actions. General summaries remain available. The model selects fields by meaning rather than forcing the officer into a fixed input phrase.
- The shared semantic contract accepts at most four distinct selected read fields, rejects unsupported selections on writes, compound top-level fields, contradictory summary fields and malformed values. Each compound read step retains its selection, never as a CAD executor parameter.
- The grounded answer renderer uses returned CAD fields and the authenticated transmitting callsign. Assigned-unit information excludes inactive/cleared entries; report excerpts require current verified incident provenance, remain labelled unverified and cannot leak from an unrelated call.
- Missing fields are stated as unavailable rather than invented. Focused answers are limited to 420 characters. The original military-time conversion is reused. Existing write outcomes, partial/unknown warnings, physical-only emergency activation, center isolation and floor/output paths are preserved.
- Existing Azure intent planning is reused, with no second provider call, new provider, database schema, codec, transport or firmware change.

## Validation and repair history

Starting docs HEAD: 5ff1cdd665d89b4e5c2c2370809750c4ef031648.
Initial implementation: 6bb21b186ce0ccaec3380c92dc7b436463fbcd77.
Validated executable: 45a50a26f5c4580e9f40442a93a84c24ba54544a.

First CI 42840037884: 646/647 V3 passed; all 81 PTT and eight manager tests, syntax and removed-engine checks passed. The single failure was a new negative assertion expecting lowercase text for a correctly capitalized rejection of answer focus on a write step. Only that test regex was changed to case-insensitive. No runtime safety code was changed.

Successful GitHub Actions run: https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/42840228520
Job 129913154768, Node 20. New tests 12/12. Full V3 647/647 across 56 files. Audit 26/26, PTT 81/81, manager 8/8, syntax and legacy-engine absence checks passed.

Synthetic tests cover narrow call facts, missing data, count-only answers, military time, assignment filtering, verified report separation and no cross-call borrowing, long-value bounds, verification/uncertainty preservation and authenticated real V3 PTT-to-CAD-read-to-radio output, including mixed read/write results. The model answer selection was mocked, not independently qualified with actual provider audio.

GitHub-reported artifact: 13776520343 (dispatcher-v3-evidence-42840228520-1); reported SHA-256 eed955ebdc59290d6f7dee362ba1fbca54a955cf7202ee861b3cc171b5195d93, not independently downloaded or hashed.

## Remaining and non-authorizations

Only focused factual read answers receive the new 420-character limit; other existing response types retain their previous bounds and unchanged CAD outcome rules. No real STT/TTS/provider, live CAD/radio, p50/p95 latency or cost measurement, newer-main integration, full repository/mobile, supervised pilot or production deployment was tested. Original 04-03 through 04-08 and release gates G-01 through G-04 remain open.

**Coding:** complete. **Scoped synthetic validation:** complete. **Released or field verified:** no.
**Progress:** Parent 01 8/8, Parent 02 8/8, Parent 03 8/8, Parent 04 2/8. Total 26/32.
**Next original item:** 04-03, recover from missing or unclear information.
