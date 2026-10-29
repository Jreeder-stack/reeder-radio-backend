# AI Dispatcher V3 02-01: authenticated unit-owned conversation/task records

**Plan:** AI-DISP-V3-001. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163) remains draft/open/unmerged/unmergeable. No merge, rebase, deployment, restart, production data changes or paid provider calls.

## Verified design and integration

The old `V3LiveDispatcher._recentContext` held one shared list of recent transcript/plan data for all speakers. Its contents were passed through `V3IntentPlanner.plan({ recentContext })` even after a different unit spoke, creating the audit's R01 cross-speaker dialogue leak. The task 01 trusted turn envelope and bounded execution path were already sound.

The 02-01 change places `V3ConversationRecords` directly in the real `V3LiveDispatcher` pipeline. It accepts only `assertV3TurnEnvelope`-verified turns, and derives custody from the runtime ID/generation, dispatch center, resolved speaker unit ID, authenticated speaker reference, account ID and connection ID. Channel/room are recorded on each turn for routing, not used to determine conversation ownership. Speaker, unique turn/conversation/task IDs, capture start/end times and intake sequence are recorded. These capture times are server-observed timing, not independently measured microphone timestamps.

An in-process, bounded record holds a current task, up to three suspended tasks, and up to twelve truncated dialogue turns. There is a five-minute inactivity limit per conversation and five-minute expiry of individual old turns and suspended/active task relevance, even when the conversation stays active. At most 128 conversations are resident per V3 runtime, with at most 240 characters of transcript per stored turn. Records contain sanitized intent input and operation outcomes but **no authoritative CAD snapshot or database record**. The planner receives only the trusted speaker's recent committed dialogue; the old shared `_recentContext` and `_remember` path are removed.

The existing `V3ConversationGate` has a narrow authenticated-session key check for pending replies; its old per-unit pending state is retained until 02-02/02-03/02-08 replace it in the original lifecycle. Mismatched sessions cannot take each other's unauthenticated wake-free follow-ups. Runtime stop clears dialogue records; a turn from an old generation cannot read new-generation state. The authenticated `activateTask` operation provides a bounded ownership-checked state primitive, but natural-language topic resumption is **not** represented as complete in 02-01.

## Source and test commits

- `4466823234f60e91574338de34e2f6829b7e9926`: initial trusted conversation store, actual runtime/gate wiring, eight real-V3 harness tests.
- `d35136a14369bcc840b230e234d73bf195e34972`: mark R01 as a **repaired acceptance assertion** in the existing audit, add fail-closed runtime-generation custody and ninth negative regression. Other audit expectations are not weakened.
- `233afa7c1af7ca36c6efae8b292e1f20c323296d`: expire old individual turns inside still-active conversations; add tenth focused regression.

## GitHub CI validation

[GitHub Actions run 40973313285](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40973313285), job `123795153204`, Node 20, executable source `233afa7c1af7ca36c6efae8b292e1f20c323296d`:

- **10/10** new 02-01 synthetic tests through production `V3LiveDispatcher`, exercising interleaved A1/B2/C3, trusted capture IDs/timestamps, bounded topics/explicit resume, cross-connection pending isolation, identical callsigns across centers, whole-conversation and per-turn expiry, fake envelopes, generation restart, and stop cleanup.
- **26/26** existing audit reproductions/controls pass, including R01's fixed-behavior acceptance. Historical audit fixtures remain preserved.
- **7/7** real `AIDispatcherRuntimeManager` integration tests, **81/81** PTT authorization/routing/floor-control tests.
- **424/425** V3 tests across 40 files. The one unchanged failure is `src/dispatcher-v3/__tests__/phase4Pipeline.test.js`: its CREATE_CALL fixture expects a success announcement without independent CAD read-back verification. The runtime correctly refuses a false verified-success claim. **The V3 workflow remains red and no release gate is passed.**
- Evidence artifact `12941541182` (`dispatcher-v3-evidence-40973313285-1`), GitHub reported SHA-256 `50693db0636026b65619351b598cae9ac496d26bc4d5234ff2fc9ccc0f006ab5`. Artifact digest was not independently downloaded/rehashed.

The tests use synthetic CAD, mock speech providers and authenticated-credential fixtures. No real providers, radio, firmware or field scenario were exercised.

## Remaining boundaries and next task

02-02 must keep the complete structured assignment/disposition through clarification. 02-03 must bind answer windows to *completed* prompts, not their creation time. 02-04/02-08 must consolidate legacy pending and field-incident dialogue, handling correction, suspension, cancellation and natural resumption in one lifecycle. 02-05/02-06 must verify assignment and incident relationships without granting another unit authority. 02-07 owns reconnect/channel-change/device reassignment rules. No distributed multi-instance memory coordination is claimed.

Other known defects R05/R08/R11/R12/R13/R14 remain pending. Current scope is **Task01 8/8, Task02 1/8, Task03 1/8, Task04 0/8: 10/32 coded/scoped-validated**. G-01 to G-04 remain unchecked. Later main integration, PR conflicts, full repository/mobile tests, live real-provider/radio/pilot and release acceptance remain unverified.

**Next original item: 02-02, Retain the complete task during clarification.**
