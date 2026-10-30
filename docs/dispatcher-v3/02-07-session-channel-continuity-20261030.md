# AI Dispatcher V3 02-07: authenticated session and channel continuity

**Plan:** AI-DISP-V3-001, original work item 02-07 only. **Repository:** `Jreeder-stack/reeder-radio-backend`. **Branch:** `test/dispatcher-v3-01-01-baseline-20261028`. **PR:** [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163), draft/open/unmerged/unmergeable. **Date:** October 30, 2026, US Eastern.

## Root cause and approved boundary

02-01 established center/unit/account/connection-owned dialogue; 02-03 required exact delivered-prompt receipts; 01-05 revalidated account and radio grants. Those safeguards prevented accidental cross-owner dialogue, but a legitimate reconnection could not recover a relevant unfinished task. More seriously, credential validity alone did not prove a disconnected Socket.IO radio was still joined to the original channel when the queued response or delayed CAD action ran. Reassigning a radio or switching channels must never turn old task content into new authority.

02-07 repairs the existing V3 runtime rather than adding another dispatcher or private task engine. The existing immutable trusted PTT envelope, `V3ConversationRecords` ledger, `V3ConversationGate` delivery lease, turn scheduler, CAD authorization/verification and hardware emergency controller remain authoritative. No database schema, firmware, transport/codec, provider, model migration or V1/V2/V4 is introduced.

## Implemented continuity rules

- **Socket routing:** For credential-issued socket PTT, new intakes and pre-action/pre-speech rechecks require a live server-owned Socket.IO socket with the *same principal object, bound unit*, configured channel membership and channel room. Client-supplied channel text/presence is not authority. HTTP-sourced PTT without a socket continues to use existing credential/grant/binding checks and authenticated session ownership. Stale/disconnected/changed-channel socket turns cannot submit a new CAD write or send routine speech to the old channel; queue relevance is rechecked before and during audio injection.
- **Authenticated replacement:** New `V3ConnectionCustody` tracks a bounded center/generation/unit/account/credential-type connection lease, not conversation content. A new proven session replaces an old disconnected/unrouted connection. Old in-flight turns, pending reply windows and queued/active routine audio are retired/canceled. A prior socket that later reappears cannot regain task ownership through its old connection ID. Retirement tombstones survive dialogue idle expiry until runtime stop; repeated mobile reconnects have a bounded, fail-closed capacity. This is safety bookkeeping, not CAD state or a second pending-task store.
- **Genuine sibling devices:** Two concurrently live, authorized sockets for one account/unit/channel are kept as separate active connections. One phone/radio speaking does not automatically revoke the other. The connection ledger has bounded sibling counts; it does not join the two devices' private conversation tasks.
- **Relevant reconnect resume:** Only unfinished and unexpired original tasks from the *same* center/generation/resolved unit/account/credential type are adopted into the new connection's existing `V3ConversationRecords` ledger and suspended, at most the existing bounded suspended-topic count. Old completed turns and raw dialogue history are not carried forward. No previous delivered prompt is assumed audible. A new explicitly addressed resume request must pass active credentials, current routing, current CAD incident/assignment relationships where required, and a fresh outbound delivery receipt before the answer window opens. Field-incident task custody is rekeyed to the same preserved task ID; no CAD note, fact or mutation is fabricated or rolled back.
- **Identity changes:** Other account, credential type, unit reassignment, dispatch center, runtime generation or changed hardware radio identity never inherits old unfinished tasks. Channel switching between V3 runtimes does not transfer private dialogue or old-channel prompts; the user must make a new authorized request on the chosen channel. Emergency floor control and hardware emergency state continue independently.
- **Limits:** Current socket presence does not guarantee a human heard an on-air response. The bounded ledger cannot replace atomic, authoritative CAD assignment validation; verified CAD readback remains mandatory. No claim of cross-process/shared-server reconnect durability, end-to-end human audibility or live device acceptance.

## Scope and validation

**Starting HEAD:** `cafddc84b813b732e3ada5019020f4eaf932437e` (02-06 documentation). **Previous validated executable:** `0da4fb1ce858a58167260f0aac25935f2087ffa9`.

**Implementation commits:**
1. `83d2e0ae1ab5aa5992bac574a7c361393bf8fcc4`: connection custody, same-owner task adoption, active route rechecks, old queue/prompt cancellation, initial nine tests.
2. `8eb4dfab908dfbb627c079759b85f27650713e8f`: preserve simultaneous live sibling devices; retain replacement tombstones while runtime is active; two more tests.
3. `4faed6153b43b2936d61d143673e81098fe796e1`: tolerate repeated mobile reconnections and verify disconnected real-socket replacement/replay; two more tests. **Latest independently CI-validated executable source.**

[GitHub Actions run 41055047521](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/41055047521), job `124060346801`, Node 20, workflow `.github/workflows/ai-dispatcher-v3-ci.yml`. Actual V3 runtime with synthetic credential database, session and radio tokens, Socket.IO socket presence, CAD HTTP boundary, STT/TTS/model stubs and fake timers; no real providers, paid calls, radio transmissions, production services or data.

| Check | Outcome |
| --- | ---: |
| New 02-07 reconnect, device, routing, stale-turn and replay cases | **13/13 passed** |
| Prior 02-06 shared incident tests | **18/18 passed** |
| Prior 02-05 relationship/follow-up tests | **32/32 passed** |
| Prior 02-04 task lifecycle tests | **16/16 passed** |
| Prior 02-03 prompt delivery tests | **20/20 passed** |
| Prior 02-02 clarification tests | **13/13 passed** |
| Existing audit suite | **26/26 passed** |
| Manager to real V3 runtime integration | **7/7 passed** |
| PTT credential/floor/routing adapter suite | **81/81 passed** |
| All V3 tests | **536/537 passed**, 46 test files; one historical failure |
| Syntax and legacy dispatcher absence checks | **Passed** |

The 13 new checks cover: bounded replacement with replay denial; replacement tombstones surviving ordinary dialogue TTL; repeated reconnects; real disconnected socket replacement and late stale-socket replay; independent concurrently live sibling devices; an outbound TTS queued response suppressed after a channel change; trusted same-account same-unit reconnect restoring disposition as a suspended task with a newly delivered prompt rather than accepting the old answer; different accounts with same callsign; different credential types and changed unit identity; in-flight model work canceled before a stale CAD write; real socket connected/identity/room checks; channel departure while planning; radio-token unit reassignment; and generation reset on runtime restart.

**CI status is still FAILED**, strictly due to the unchanged `phase4Pipeline.test.js` CREATE_CALL success-acknowledgment fixture, which has no independent CAD readback. The production verifier correctly refuses to claim an unverified successful write. The fixture, CAD verifier and required authorization were neither altered nor skipped. New 02-07 cases passed; no complete-green suite or release acceptance is claimed.

GitHub-uploaded CI artifact `12976482326`, name `dispatcher-v3-evidence-41055047521-1`, GitHub-reported SHA-256 `e87b8110c6fb44fb4d8508b8e2f76621246d7a8ca2d851aa2cb453d31564fc86`; its ZIP was **not** independently downloaded or rehashed.

## Known limits and continuation

- This is scoped, deterministic synthetic runtime testing, not end-to-end production or human radio acceptance. The original CREATE_CALL success fixture still requires independent correction/verification in its designated future scope; no false-success bypass is acceptable.
- A session may resume only on the same original V3 runtime/channel when it passes a new authenticated request and the original task has not expired. Cross-channel task migration or restart recovery was intentionally not added. A changed channel immediately fails server-side routing checks on old-channel action and speech paths when observed; brief leave-and-rejoin cycles between observations cannot prove what the human heard.
- Session tombstones and sibling registry are in-process and bounded, not a cross-instance shared store. Up to 1,024 actor records per runtime, 256 replacements/siblings per actor (rejected safely at capacity). Stop/restart resets transient state. Live multi-instance routing and duration/scale testing remain release work.
- The existing CAD mutation verification is non-atomic against changes occurring immediately after a recheck; downstream full integration and release gates must assess this. Existing hardware emergency controls were not changed.
- Full repository/mobile tests, newer-main integration, real STT/TTS/model, real radio, production service and original live incident verification remain unverified. No branch merge, rebase, deployment, service restart, production modification or paid call.

**02-07 coding and scoped mocked validation complete:** parent 01 **8/8**, parent 02 **7/8**, parent 03 **1/8**, parent 04 **0/8**, total **16/32**. **Next original item 02-08** (five-unit integrated behavior). **G-01–G-04 all unchecked**.
