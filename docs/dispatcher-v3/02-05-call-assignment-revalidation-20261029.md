# AI Dispatcher V3 02-05: revalidate incident and assignment relationships

**Plan:** AI-DISP-V3-001, original 02-05 only. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable. **Local date:** October 29, 2026, US Eastern.

## Root-cause path and safety boundary

02-04 unified the conversation/task owner, but its incident coordinator still cached a call ID and follow-up goals from an earlier CAD snapshot. `V3FieldIncidentCoordinator.update`, `_applyLocation` and `_tryRecordNote` could reuse that ID after a different dispatcher had closed the call, unassigned the speaker or moved the unit to another call. A disposition answer likewise carried its original `callId` from the earlier question without a fresh current-assignment check immediately before `CLEAR_UNIT`. If a planner omitted the call ID, normal plan materialization could select a newly assigned call rather than the held disposition's original target.

The source also retained the old `NO_ACTION` => `UPDATE_FIELD_INCIDENT` conversion, which promoted unrelated speech, questions and denials into CAD notes. 02-04's explicit task-cancellation path repaired audit R05, but general unrelated speech and mid-turn call changes still needed this 02-05 repair.

The center-scoped CAD APIs, PTT authorization, task/turn ownership, independent CAD mutation verification and physical emergency controller remain authoritative. This change is NOT a blanket prohibition on updating previous calls: an independent, explicitly identified historical-call request still follows its ordinary authorized CAD path.

## Scope of the implementation

- `src/dispatcher-v3/operationalContext.js` adds `assertV3CurrentTaskCall`. It fails closed if the trusted unit ID changed, the current assignment is absent or different, or the target is missing/closed/cancelled from the fresh center-authorized active-call list. Originally unassigned incident tasks may continue only while the unit remains unassigned. Missing snapshot/active-call information is not authorization.
- `src/dispatcher-v3/errors.js` adds `CALL_RELATIONSHIP_CHANGED` as a distinct safe terminal reason; no database or wire/schema migration.
- `src/dispatcher-v3/liveRuntime.js` pins an answering disposition to the original owner/call, rejects model-generated attempts to target another unit or call, checks a fresh snapshot after model/materialization waits, and checks again at the real CAD submission boundary. Invalidated disposition and incident tasks are retired only within their authenticated conversation; the prompt window and stale incident cache are cleared. The dispatcher gives an explicit spoken invalidation, does not claim old writes were undone, and never touches hardware emergency state. Resumption of old disposition/incident tasks rechecks CAD before speaking a new question. Transient CAD lookup failures before a write fail closed and allow a still-live task to be suspended for later owner-bound resumption.
- `src/dispatcher-v3/conversationRecords.js` adds owner-scoped temporary suspension on CAD uncertainty and allows an invalidation control turn to be recorded without falsely marking it successful.
- `src/dispatcher-v3/fieldIncidentCoordinator.js` validates the source incident call/assignment at follow-up receipt and again before each location change, note or deferred-note flush. Its internal pending state is still task-scoped from 02-04; a changed relationship is thrown, not hidden as a deferred note. An independent field update with no current call now fails closed instead of caching a note with no defined target.
- `src/dispatcher-v3/actionExecutor.js`, `defaultActionHandlers.js` and `createCallHandler.js` pass an optional internal-only **additional** validation callback to supported CAD mutation handlers. The callback executes immediately before the actual POST/PATCH, **after** asynchronous identity and location preparation. Planner input and action contracts cannot supply it; existing permissions, Task 01 turn freshness checks and independent CAD read-back verification remain mandatory. It never reduces authorization or creates another action engine.
- The `NO_ACTION` => `UPDATE_FIELD_INCIDENT` catch-all is removed. When an unanswered incident question receives non-actionable speech, no CAD note is written and the wake-free prompt is cleared. A separately recognized, complete new instruction releases the old pending-answer lease and proceeds independently under its own task.

## Scoped negative and healthy test evidence

**Executable implementation:** `c9e92e53d9dc5b857684e222c79ae877a11f34b6` (parent `5af3a18e9d734f1ee982bef648bbe6d1178aed5d`). New `src/dispatcher-v3/__tests__/followUpRelationships.test.js` uses the actual V3 runtime, synthetic center-scoped CAD transport, authenticated PTT sessions, a mocked model/speech stack and deterministic time. It includes 32 passing cases covering assignment/active-call helper validation, reassignment, unassignment, closed calls, identity changes, original-call pinning, model target substitution, disposition/incident follow-ups, changes during semantic planning, changes during location preparation and handler read-back, note/PATCH/clear write-boundary checks, bounded resumption, transient CAD failure, NO_ACTION containment, explicit historical-call updates with read/write scope checks and duplicate callsigns across dispatch centers. The direct incident coordinator test fixture was corrected to include the actual snapshot's authenticated speaker field.

**CI:** [40994880046](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40994880046), job `123865577097`, Node 20. Completed overall **failure** because the single unchanged `phase4Pipeline.test.js` CREATE_CALL fixture still expects positive speech with no independent CAD read-back. This assertion and the CAD verifier remain unmodified, so the fixture is not hidden or treated as success.

| Check | Evidence |
| --- | --- |
| New 02-05 tests | **32/32 passed** |
| Existing audit (R05 retained repaired) | **26/26 passed** |
| Previous 02-04 tests | **16/16 passed** |
| Previous 02-03 tests | **20/20 passed** |
| Previous 02-02 tests | **13/13 passed** |
| Real manager-to-V3 integration | **7/7 passed** |
| PTT/credential/floor checks | **81/81 passed** |
| Entire V3 suite | **505/506**, 44 files; only old CREATE_CALL fixture failed |
| Runtime syntax and absent-legacy-engine checks | Passed |

Artifact `12950672330`, `dispatcher-v3-evidence-40994880046-1`; GitHub-reported SHA-256 `caecb91f4d3689c1e1757575eccd5b416b06b9f5120ef785c3b4f17f39d9d1a0`, not independently downloaded/rehashed.

## Limits, separation and exact next item

This gives scoped, mocked evidence of fail-closed follow-up validation. CAD API responses may race with changes occurring after the final pre-write check; without a conditional/transactional CAD update API, a distributed atomic compare-and-write cannot be claimed. No schema/Command-Link change was authorized. Final read-back verification remains mandatory; deployment/live pilots must validate the actual CAD endpoint semantics and time budgets.

**02-05 coding and scoped validation completed** at the executable commit above: Task 01 **8/8**, Task 02 **5/8**, Task 03 **1/8**, Task 04 **0/8**; total **14/32** original IDs. G-01, G-02, G-03 and G-04 remain unchecked. R08, R13 and R14 remain owned by later tasks; the unchanged CREATE_CALL fixture remains red. No V1/V2, V4, provider/transport/codec/firmware, schema, emergency, security-control, production, merge/rebase or deployment changes.

**Next original work item: 02-06, Share incident facts without merging unit instructions.** Verified, center-authorized incident information must be shared without sharing pending tasks, assumptions, permissions, or another unit's requests. Later 02-07/02-08 retain reconnect and full five-unit integration work. Full repository/mobile/newer-main integration, real providers and radio, production behavior and release/pilot acceptance remain unverified.
