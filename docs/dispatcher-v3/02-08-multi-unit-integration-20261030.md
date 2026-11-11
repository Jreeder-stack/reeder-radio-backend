# AI Dispatcher V3 02-08: five-unit integration and single task lifecycle

**Plan:** AI-DISP-V3-001. **Original work item:** 02-08, without changing the four parent tasks, 32 IDs or their acceptance criteria. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable. **Date:** October 30, 2026 (US Eastern).

## Root-cause trace

Earlier work items 02-01 through 02-07 safely bound private dialogue to authenticated centers, speakers, accounts and connections; verified call assignments and prompts; and allowed limited same-owner reconnect. But `V3ConversationGate.pending` still keyed the most recent question by **callsign alone** and copied its full task payload, even though `V3ConversationRecords` was designated the sole private task owner. Two simultaneous legitimate devices using one callsign could overwrite each other's prompt, and old duplicated payload could be presented to the model instead of retrieved from the original authenticated task ledger.

Likewise, `V3OutboundScheduler.latest` and the runtime's `_unitLatestIntake` supersession map used the display callsign. A newer question from a sibling socket could inadvertently invalidate a still-pending response belonging to another authenticated connection. Those were source-level ownership defects, not voice prompts or phrases to patch.

The full path inspected was real authenticated PTT issuance and manager/compatibility routing -> V3 intake and turn scheduler -> STT -> conversation gate -> sole task ledger -> planner/CAD execution and independent verification -> outbound scheduler and local radio injection. Existing `aiDispatchService` and `aiDispatcherSignaling` remain forwarding compatibility facades; no competing legacy engine was found or reintroduced. `V3FieldIncidentCoordinator` retains task-keyed operational report details, not an alternate dialogue/answer authority.

## Implemented behavior

- **Single authoritative task lifecycle:** `V3ConversationRecords` is the sole owner of pending operation, known fields, original turn, call/identity constraints, clarification and suspended task context. Added `followUpForPrompt`, which rechecks the exact authenticated conversation, session, active task ID/kind, prompt-origin turn, runtime generation and unfinished state before exposing the original task to the planner. No client, model or another unit supplies a task ID as authority.
- **Session-specific delivery receipts:** `V3ConversationGate` now keys its bounded pending map by unit plus authenticated session key, instead of by unit callsign alone. Each entry contains only routing/delivery metadata: unit/session, conversation/task/turn, channel, generation, non-actionable kind label, delivery state and timing. No call ID, raw note, pending CAD operation, candidate set or input is duplicated in the gate. Untrusted/foreign sessions, late receipts, expired prompts and changed task owners fail closed. Original 30-second reply clock still starts only after terminal outbound completion.
- **Device-safe outbound supersession:** `V3OutboundScheduler` and the runtime latest-intake check now key routine output by original trusted connection/account/unit/generation custody, not by display callsign alone. Newer output still supersedes older output of **that same session**, but two concurrently authorized same-unit radios may each receive their own queued prompt. Priority and emergency floor control remain independent.
- **Existing safeguards retained:** CAD writes are still independently authorized and read-back verified; cross-center membership and call relationships remain authoritative and revalidated; private histories do not leak through shared incident metadata. Physical emergency hardware events alone activate/clear hardware state under existing rules. No provider, firmware, codec, transport, database schema, production settings, legacy V1/V2 or V4 changes.

## Reproducible scoped validation

**Starting documentation HEAD:** `283a85da21dfb6586bc479f22541d410a0aefa35`. **Prior validated executable:** `4faed6153b43b2936d61d143673e81098fe796e1`.

**Implementation/testing commits (all on the existing branch):**

1. `116e0d4f2917a2161e918dce0c6e6abad2f288b2`: replace callsign-wide prompt payload/custody with per-session delivery-only receipts and ledger-sourced tasks.
2. `85b775b2c65334498f55bbad4c21876f683ba64e`: update prior regression expectations to assert authoritative task custody, not redundant prompt data.
3. `eb209d4ea676b221af08f6efa78cc65b2d6543cc`: correct remaining historical-test assertions after source cleanup.
4. `7218e9c45d66684bc3838a91d52de4e250f6dc6e`: add 13 representative five-unit runtime scenarios.
5. `9279188cd57a83293b5bfe4ce57f74d46ecf383b`: extend real manager-to-V3 PTT acceptance to five independent credentialed units.
6. `ff7a47894cdf7af4a1fd3f03d2dbe6f3c1f3bdbc`: source-fix same-callsign sibling queued speech supersession and add the 14th runtime regression. **Latest validated executable.**

[GitHub Actions run 41058261239](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/41058261239), job `124071167090`, Node 20, workflow `.github/workflows/ai-dispatcher-v3-ci.yml`. The workflow independently checks the real V3 modules and PTT/manager adapters using synthetic, credential-backed session/database/CAD boundary, in-memory simulated radio sockets, mocked STT/model/TTS, fake timers and mocked audio relay. No paid providers, real radios, live dispatch, CAD writes or production data.

| Validation | Passed | Failed |
| --- | ---: | ---: |
| New 02-08 five-unit V3 runtime integration | **14** | **0** |
| Actual manager to V3 PTT integration (including new five-unit case) | **8** | **0** |
| PTT grants, routing and hardware-floor checks | **81** | **0** |
| 02-07 reconnect/channel cases | **13** | **0** |
| 02-06 shared incident cases | **18** | **0** |
| 02-05 call/assignment relationship cases | **32** | **0** |
| 02-04 task transitions | **16** | **0** |
| 02-03 delivered prompt | **20** | **0** |
| 02-02 retained clarification | **13** | **0** |
| Full audit source/behavior regressions | **26** | **0** |
| All V3 test files (47 files) | **550** | **1** |
| Syntax / legacy-engine absence checks | Passed | 0 |

The 14 new cases specifically validate: five interleaved independently identified PTT units; blocked A1 STT with B2/C3/D4/E5 progressing; five simultaneously delivered independent clarification tasks; owner-only cancel with four unaffected answers; multiple topics plus original A1 task resumption; shared CAD incident details and unverified-note attribution with no model note leakage; group-pronoun write refusal; same-account twin-radio independent prompts; delayed channel departure during model/CAD; repeated A1 callsigns across dispatch centers; expired answers; hardware-emergency handling alongside C3's pending request; stop/restart invalidation; and both sibling devices' queued speech successfully delivered after the first TTS blockage. The new manager test separately exercises all five authenticated PTT paths through the actual `AIDispatcherRuntimeManager` rather than directly calling the runtime.

**CI conclusion remains FAILURE.** The sole failure is the **unchanged** `src/dispatcher-v3/__tests__/phase4Pipeline.test.js` CREATE_CALL success-acknowledgment fixture. It expects positive speech without independent CAD read-back while production correctly refuses to certify a write that cannot be verified. The assertion was not skipped, modified, suppressed or bypassed; the actual CAD verifier and authorization remain unchanged. No full-green or release qualification is claimed.

**CI evidence:** GitHub artifact ID `12977228633`, `dispatcher-v3-evidence-41058261239-1`, GitHub-reported SHA-256 `d3179c4f8eca4410b27d72be70e2e326656713ff0065a5fcce05621208cc6f79`. The archive was not independently downloaded/rehashed.

## Limits, release and continuation

- This establishes **coding plus scoped synthetic V3 runtime/manager validation**, not completed full repository/mobile, newer-main, real radio/provider, field/operational, deployment or production acceptance. No multi-instance state replication, live Socket.IO NTP/packet-loss conditions, human audibility or legally consequential live CAD simulation was tested.
- Prompt delivery `completed` proves **local relay injection only**, never that a field unit actually heard the response. Same-channel audio is audible to authorized listeners; the task ledger never transfers across them.
- `V3ConversationGate.pending` remains a separate **delivery receipt** store, intentionally required to prove what prompt was delivered; it is not a parallel task or pending-action lifecycle. The field-incident coordinator stores bounded task-specific work details, not dispatcher conversation ownership. Actual CAD verification remains non-atomic with assignment changes after final read.
- Existing `phase4Pipeline.test.js` CREATE_CALL read-back fixture remains unresolved. Latest independently advanced main, full desktop/mobile repositories and real radio/providers remain unverified. No PR merge/rebase, release gate, deployment, restart, production changes or paid provider calls were authorized or performed.

**Completed for coding and scoped validation:** Task01 `8/8`, Task02 `8/8`, Task03 `1/8`, Task04 `0/8`, **17/32** overall. **G-01, G-02, G-03 and G-04 remain unchecked.** Exact next original task: **03-02, Implement one semantic interpretation contract.**
