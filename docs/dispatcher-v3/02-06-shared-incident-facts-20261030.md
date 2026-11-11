# AI Dispatcher V3 02-06: shared incident facts without merged unit instructions

**Plan:** AI-DISP-V3-001, original work item 02-06 only. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), open/draft/unmerged/unmergeable. **Date:** October 30, 2026, US Eastern.

## Root-cause and design boundary

02-01–02-05 already made pending clarifications, instructions, dispositions and field-incident follow-ups belong to an authenticated center/unit/account/connection and task. Those private records must NEVER become incident-wide instructions. On the other hand, the old operational snapshot exposed raw current/active call summaries to the planner without a distinct, proven participant view or attributed note readback. A model could treat “our call” or “both of us” as implicit unit authority; raw CAD report text must not become a model instruction.

02-06 introduces one read-only, runtime-bounded incident projection. It is deliberately **not** another task store, dispatcher engine, CAD mirror or role/permission grant. It uses existing CAD and action contracts. No V1/V2 revival, V4 restart, transport/codec/firmware, provider, schema or hardware emergency changes.

## Implemented behavior

- **Authoritative participation:** `V3SharedIncidentFacts.view` requires `call.read` and `unit.read`, a current active call in the existing center-scoped CAD snapshot, a fresh `GET /api/radio/v3/cad/calls/:id` with matching ID, nonterminal call state and an explicit noncleared CAD assigned-unit membership entry. The fresh resolved speaker UUID/callsign must match the original trusted PTT envelope and current runtime generation. Missing membership or stale identity yields no shared projection. A channel, utterance, old transcript, model-generated call ID or pending conversation does not grant access.
- **Different kinds of evidence:** The call number, CAD nature/location/status/priority and participating units are presented as *fresh, center-authorized CAD data*. CAD notes are *unverified reports*, not proven incident assertions, even after the note write is verified. Notes written by an authenticated V3 unit are attributed to its actual PTT speaker only after an independently verified CAD note write, unique note text matching, and within the bounded runtime attribution lease. Missing/duplicated provenance is explicitly “Unattributed CAD note”; no guess about the author. Reports are capped at eight most recent, notes are bounded for speech, and ephemeral attribution is TTL/size bounded.
- **Planning versus speaking:** The model sees the read-only verified incident metadata, participant list and report count, but never raw note text or another unit's conversation history. It can select a read action to answer a participant question. After planning/execution, the runtime refreshes the CAD snapshot and participant view before composing a shared `GET_CALL` / `GET_CURRENT_CALL` response, and requires the returned call ID to match. Replies identify confirmed CAD details separately from unverified field reports.
- **No transferred authority:** The existing task ledger, delivered-prompt answer lease, authenticated speaker ownership and CAD action verification are unchanged. Group-target mutation requests using “we”, “us”, or “both of us” are held for an individual-callsign/action clarification, before the action executor. An explicit individually named unit still follows the existing unit resolver, scope checks, authenticated lifecycle and verified CAD write.
- **Lifecycle:** Stop clears only temporary report attribution. Revoked/changed CAD assignments or identity mismatch prevent a shared view. The existing physical emergency state and urgent override controls remain independent.

## Scoped validation and diagnosis

**Starting HEAD:** `4abdd6b36c6454170799ee2c04a3252a0a0f60a8` (documentation). **Prior validated executable:** `c9e92e53d9dc5b857684e222c79ae877a11f34b6`.
**Implementation commits:** `ae04b813c9e06415eed4a46fb3ba3fbe9dbc82f1`; `b89f49e685a197243cd325df9ca6f59fd7008eca`; **validated executable:** `0da4fb1ce858a58167260f0aac25935f2087ffa9`.

[GitHub Actions run 41048969337](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/41048969337), job `124039999953`, Node 20, used `.github/workflows/ai-dispatcher-v3-ci.yml`. The workflow runs `npm ci`, syntax and retired-engine checks, a PTT credential/floor suite, real manager-to-V3 integration against synthetic CAD, then `npm run test:v3 -- --reporter=default --reporter=json --outputFile=reports/v3-tests.json`. The focused file `src/dispatcher-v3/__tests__/sharedIncidentFacts.test.js` is part of that V3 suite; the synthetic harness uses authenticated PTT identities, mocked STT/TTS/model, center-scoped in-memory CAD and fake timers. No paid provider or real production/radio calls occurred.

| Check | Result |
| --- | ---: |
| New 02-06 shared incident tests | **18/18** |
| Existing audit regressions | **26/26** |
| Previous 02-05 follow-up tests | **32/32** |
| Previous 02-04 task transitions | **16/16** |
| Previous 02-03 prompt delivery | **20/20** |
| Previous 02-02 clarification | **13/13** |
| Real manager-to-V3 PTT/CAD integration | **7/7** |
| PTT credentials, routing and physical-floor controls | **81/81** |
| All V3 tests | **523/524**, 45 test files; one historical failure |
| Syntax and absent-legacy-engine checks | **Passed** |

The 18 new cases exercise positive A1-to-B2 verified note sharing with private histories omitted; A1's delivered disposition retained while B2 asks about the same incident; lack of membership; reassignment and closure; mismatched original authenticated PTT speaker; unassignment during planning; absent `call.read` scope; rejected note writes; unattributed and duplicate notes; late identity/assignment changes; duplicate callsigns/call IDs in different centers; ambiguous group pronouns; explicitly named B2 status changes under existing verified authorization; read-only group references; lifecycle cleanup.

The workflow's overall conclusion is **failure**, not a green release. Its sole failed case is unchanged `src/dispatcher-v3/__tests__/phase4Pipeline.test.js`: the CREATE_CALL fixture expects an affirmative acknowledgment without independent CAD read-back. V3 correctly refuses to claim an unverified write; the fixture and verifier were not changed or hidden. CI artifact `12973372661` (`dispatcher-v3-evidence-41048969337-1`), SHA-256 **reported by GitHub** `f16b337c578048c60b8ed26a01ea39c775bf0c8b07440bcc2dc85324c3279949` (not independently downloaded and rehashed).

## Known limits and exact continuation

- A fresh CAD response proves what the center-authorized CAD service returned, **not** real-world truth of a recorded call or field allegation. Note author attribution cannot be durably established from old notes lacking stable server-side identity; duplicate identical text is left unattributed. No schema change was authorized.
- Multi-request CAD reads cannot guarantee atomic membership against a reassignment that occurs after the final check; later full integration/pilot gates remain necessary.
- On-air speech is still ordinary channel audio: independently authorized listeners on the same radio channel can hear it. This feature does not provide private per-unit encrypted audio.
- No real radio, STT/TTS/model provider, production or live CAD acceptance; no full repo/mobile or newer-main integration; no PR merge/rebase, release, restart, deployment or paid provider calls.
- The only unresolved original audit cases remain R08, R13 and R14 for later tasks. The old CREATE_CALL fixture is still red. **G-01–G-04 remain unchecked.**

**02-06 coding and scoped mocked validation complete:** Task 01 **8/8**, Task 02 **6/8**, Task 03 **1/8**, Task 04 **0/8**, total **15/32**. **Next original item: 02-07: Handle channel changes, disconnects and identity changes.** 02-08 retains full five-unit integration and G-01–G-04 remain separate and pending.
