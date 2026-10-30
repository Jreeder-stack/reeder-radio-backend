# AI Dispatcher V3 02-02: retained structured clarification task

**Plan:** AI-DISP-V3-001. **Scope:** original item 02-02 only. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable.

## Root cause and repair

The actual `V3LiveDispatcher._processTranscript` discarded the prior action when `materializeV3Plan` could not resolve an ambiguous call, substituting `CLARIFY` with empty input. `V3ConversationGate` retained only question text and an incomplete input, while `V3ConversationRecords.completeTurn` overwrote the active task action with `CLARIFY`. The next response therefore depended on reconstructing the request from transcripts. This is the existing audit R12 reproduction: `ASSIGN_UNIT` requested by A1 was lost after "Which call?".

The repair stays inside the existing V3 runtime/planner/conversation architecture. `clarificationTasks.js` validates a bounded proposed operational action (never the hardware-only `DECLARE_EMERGENCY`), known input parameters, a single unresolved field, and bounded candidate IDs. Server-side creation stamps the authentic original turn, dispatch-center-sourced candidate IDs and a historical current-call relationship. The 02-01 record holds a task in `awaiting_clarification` while keeping `ASSIGN_UNIT`, its original ID and original input; `CLARIFY` remains only the spoken per-turn result. The unit/session/authenticated connection/runtime generation remain the actual custody key, and the old per-unit gate only transports the corresponding pending prompt.

An answer to the existing pending task is interpreted with full structured original intent but may fill only the missing field. It cannot rewrite the saved unit, action, disposition or other known parameters. Call choices must resolve against fresh center-authorized CAD context and the original candidate set, and a changed current-call relationship is guarded. The resulting action still traverses normal `materializeV3Plan`, `V3ActionExecutor`, existing action scopes and CAD read-back verification. Missing/expired context, a noncandidate or closed call, wrong owner, invalid input and unrelated fresh addressed commands fail closed or follow the existing independent request path. The task is not an authorization grant and stores no authoritative CAD snapshot.

Model-originated `CLARIFY` tasks receive the **same server-side identity/candidate stamp** as resolution-error clarifications. An initial CI regression caught a missing stamp; that was repaired before recording the validated source. A generic `CLARIFY` without a known intended operation remains a non-executable question.

## Commits and validation

- Starting documentation HEAD: `ebdeebf981a52ff4b1dbf30bab56bc0fcbd926dd`.
- Implementation and R12 repaired assertion: `9d225cb87d84499a57eab83a40bc21bdf0527ff3`.
- Verified correction for model-originated clarification: `b10d55931b5f6bd548114bbd0303edd356868833`.
- **Final CI-tested executable source:** `b10d55931b5f6bd548114bbd0303edd356868833`.
- Initial [CI 40979319846](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40979319846) exposed one new test failure in the model-originated path; it was not accepted or hidden.
- Final [CI 40979565361](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40979565361), job `123815931446`, Node 20: **13/13** new actual V3 clarification tests, **26/26** audit reproductions/controls including R12 repaired, **7/7** actual manager-to-V3 tests, **81/81** PTT controls and **437/438** complete V3 cases across 41 files. These test totals overlap. Syntax and absent-V1/V2 workflow checks passed.
- The **only failure**, unchanged from the pre-02-02 suite, is `src/dispatcher-v3/__tests__/phase4Pipeline.test.js`'s CREATE_CALL fixture expecting "Ten-four" without verified CAD read-back. The runtime correctly says "unable to verify that change in CAD". No assertion, executor verification or authorization was weakened. CI conclusion remains **failure**, not release acceptance.
- Evidence artifact `12944481302` (`dispatcher-v3-evidence-40979565361-1`), GitHub-reported SHA-256 `ff4321e3c611b951f222bfb498be02ebc87175beb7fff0e2915889603848e9ca`. Digest is provider-reported, not independently downloaded/rehashed.

The new test matrix uses synthetic CAD and credential database boundaries with actual V3 runtime, real task/turn custody, planner normalization, materializer, executor and read-back. It covers R12 original action retention, single-field assignment resumption, natural candidate resolution, model-injected constraint replacement refusal, model-originated clarification, invented and closed candidate rejection, changed current-call relation, cross-unit/connection isolation, expiry, independent fresh requests, generic question non-execution and verbal hardware-emergency prevention.

## Fixed boundaries and outstanding items

All original 32 IDs and four parent scopes remain. 02-02 is **coded and scoped mocked-validated**, not a production/live fix. Task 02-03 owns prompt-*delivery*-time windows and wake-free follow-up timing; 02-04 owns correction/cancel/suspend/resume; 02-05 owns complete incident/assignment relationship revalidation; 02-06/02-07/02-08 own group context, reconnect and five-unit integration. Known audit items R05/R08/R11/R13/R14 remain pending. Hardware emergency, emergency paging, codec, radio transport, firmware, schema, provider configuration, tenant isolation and existing verification controls remain untouched.

Checkpoint: **Task 01 8/8; Task 02 2/8; Task 03 1/8; Task 04 0/8; total 11/32 coded/scoped-validated**. G-01 through G-04 unchecked. PR #163 stays draft, open, unmerged and unmergeable pending newer-main conflict review. Full repository/mobile, newer-main integration, real radio/providers, pilot, production and release are unverified. No merge/rebase, deployment, restart, real data mutation or paid provider call. **Next: 02-03, correlate follow-ups with delivered prompts.**
