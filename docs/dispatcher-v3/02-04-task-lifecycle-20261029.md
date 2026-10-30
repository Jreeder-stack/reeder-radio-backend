# AI Dispatcher V3 02-04: unified correction, cancellation, topic change and resumption

**Plan:** AI-DISP-V3-001. **Original work item:** 02-04. **Repository:** `Jreeder-stack/reeder-radio-backend`; **branch:** `test/dispatcher-v3-01-01-baseline-20261028`; **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable. **Date:** October 29, 2026 (US Eastern).

## Root-cause trace and authorized scope

Before 02-04, `V3ConversationRecords` owned authenticated short-lived conversation/task IDs and retained clarification proposals (02-01/02-02). `V3ConversationGate` separately held delivered-question custody (02-03). Dispositions were only a gate pending context; `V3FieldIncidentCoordinator` cached follow-up goals by a callsign, outside the owner/task lifecycle. `V3LiveDispatcher._processTranscript` always retrieved that callsign incident, so a new subject could inherit an unrelated old call. When the planner returned `NO_ACTION`, its catch-all incident continuation turned the entire speech into an `UPDATE_FIELD_INCIDENT` note. Audit R05 demonstrated "disregard the previous request" being appended to `OLD-CALL` after reassignment to `NEW-CALL`.

The approved change is **one task lifecycle** in the existing V3 conversation records, not a second manager or a new dispatcher implementation. A trusted, immutable turn envelope supplies center, authenticated unit/session/account/connection and generation; the task ID is minted by the server. A routing channel and spoken callsign cannot establish ownership. Task control does not grant CAD permissions or reverse writes.

## Implementation

- `src/dispatcher-v3/conversationRecords.js`: adds explicit active/completed/awaiting_clarification/awaiting_follow_up/suspended/canceled/expired task transitions; records pending clarification, disposition and field incident follow-up against the one owner-bound task, tracks submitted CAD writes, bounds suspended tasks and expiry, and permits resumption only by the same authenticated owner. The requested task ID is never accepted from transcript or model.
- `src/dispatcher-v3/taskTransitions.js`: recognizes complete, explicit cancel, correction, topic and resume utterances without treating quoted reports, negation, questions or "cancelled by complainant" dispositions as dialogue cancellation. The existing semantic planner may propose equivalent task-control actions for natural phrasing.
- `src/dispatcher-v3/intentPlanner.js`: extends only its **non-CAD control** output vocabulary with `CANCEL_TASK`, `CORRECT_TASK`, `NEW_TOPIC`, `RESUME_TASK`. Existing authorized CAD actions, materialization, verified write and physical emergency policy are unchanged. Free-form revised requests are fed through the same ordinary planner/authorization path.
- `src/dispatcher-v3/fieldIncidentCoordinator.js` and `src/dispatcher-v3/liveRuntime.js`: bind a field-incident continuation to the active authenticated conversation/task rather than a bare callsign. Cancellation retires the unfinished target and its scoped incidental dialogue; a new topic suspends old follow-up without silently adding an old call note; resumption restores only a still-live bounded suspended task and queues a fresh radio question. The gate's exact session/task/turn/generation/channel outbound **completed** receipt is still required to open an answer window.
- Cancel/correction uses the already implemented Task 01 turn lifecycle to cancel the original in-flight turn if still cancelable, and releases the current pending-answer lease. If a write was previously submitted, the spoken response explicitly states that prior CAD changes have **not** been reversed. There is no CAD rollback or assertion of successful persistence without read-back. Emergency-button state is not a conversation task and is never cleared by these control transitions.
- `src/dispatcher-v3/__tests__/taskTransitions.test.js` adds sixteen actual V3 runtime/harness cases covering the R05 regression, negative phrase classification, authorized A1/B2 and cross-connection isolation, canceled answers, correction and new-topic continuation, incident/clarification/disposition suspension and resumption, late delivery rejection, bounded expiry, and a semantic model control without mutation.
- `src/dispatcher-v3/__tests__/auditBaseline.test.js` marks **R05 repaired**, so all modes assert the fixed behavior, and adds the new task-transition source to the audited source-hash list.

This is not a claim that every speech-to-text variation has been simulated; open-ended expressions still depend on the existing semantic model. No live-provider tokens were spent.

## Scoped validation and preserved known defect

**Executable commit:** `2dc054bf6a9b40d4eacc02a1df4323843a1bf81d` (parent: `53ae003699e7657f13ca996013ffc8db6d72de3e`).

**[GitHub CI run 40984392644](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40984392644)**; job `123831877334`, Node 20; completed with overall **failure** solely because the unchanged `phase4Pipeline.test.js` CREATE_CALL test expects positive speech despite missing independent CAD verification. No assertion was changed or skipped and the runtime still refuses to claim an unverified mutation.

| Scope | Result |
| --- | --- |
| New 02-04 actual V3 tests | 16/16 passed |
| Existing 01-01 audit including fixed R05 | 26/26 passed |
| Earlier 02-03 delivered follow-up | 20/20 passed |
| Earlier 02-02 structured clarification | 13/13 passed |
| Actual manager-to-V3 runtime integration | 7/7 passed |
| PTT/credential/floor adapter controls | 81/81 passed |
| Entire V3 suite (43 files) | **473/474**, sole old CREATE_CALL fixture remains |
| V3 syntax / old dispatcher absence checks | Passed |

Evidence artifact `12946785265`, `dispatcher-v3-evidence-40984392644-1`, provider-reported SHA-256 `0113f8f7a8ac16ee4d864fdccc0eff600d0c64cdc71debfd7de33c44e4c54d0f` (not independently downloaded or hashed). Synthetic CAD, PTT credentials, time, speech, model and relay only. No real radio, external CAD or paid LLM evaluation.

## Task and release boundary

**02-04 coded and scoped-validated.** Original Task 01 **8/8**, Task 02 **4/8**, Task 03 **1/8**, Task 04 **0/8**; total **13/32** original tasks. All four parent scopes, all 32 work item IDs, the 32 original deliverables/acceptances and G-01 to G-04 remain intact and unchecked as release gates.

The next original item is **02-05: revalidate incident and assignment relationships**. It owns complete current-call/assignment checks before follow-up CAD writes and removal of unrelated `NO_ACTION`→`UPDATE_FIELD_INCIDENT` catch-all conversion; 02-04's focused lifecycle work does not pre-claim those requirements. Audit R08, R13, R14 also remain pending their owners. The unchanged CREATE_CALL verification fixture is separately unresolved.

No full repository/mobile, newer-main conflict resolution, distributed/multi-instance acceptance, live radio/provider, production replay, pilot or release acceptance was performed. No merge, rebase, deployment, restart, production data change or paid provider call. This is an executable-code CI checkpoint plus documentation; neither the PR nor production was advanced.
