# 01-03: bounded per-unit scheduling and scoped validation

Plan **AI-DISP-V3-001**, work item **01-03**, October 29, 2026. This note records *coding and scoped synthetic validation*, not a live-radio or release approval.

## Provenance and current branch
- Repository: `Jreeder-stack/reeder-radio-backend`.
- Branch: `test/dispatcher-v3-01-01-baseline-20261028`. PR [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163) is draft, open, unmerged and GitHub reports it unmergeable with current main.
- Pre-01-03 HEAD: `3c6200f17ea92f47312e06bf210fba29c68c4b4c`.
- Core implementation: `a137daa81ae329745cd5784959c42603b1db3d50`.
- Added tests/audit case conversion: `0f635535e2b62761a614c97fd0266ea1c53bb442`.
- Terminal-envelope regression fix: `4f523191662c17f184a91021ae71d916d377da6f`.
- Final scoped validated source: `01ceda2d7dea1bd6224397eeeff52e83a3d7c6a9` (test expectation fix).
- Main independently advanced to `fd88b6076dd66f3badada8509ceb287f13c4ab37` through #164/#165. The PTT/signaling overlap includes `src/services/signalingService.js`, native paging, embedded-radio controls and Android signaling. The 01-03 source files do not merge those changes. One competing signaling import area needs explicit reconciliation later. Integration with newer main remains unverified.

## Root cause and implementation
Previously `_handleCapturedTranscript` serialized by callsign **after** STT finished, so a younger STT completion could execute before its earlier captured turn. Hail/emergency-reply handling and the conversation gate also occurred before that queue. `src/dispatcher-v3/turnScheduler.js` is a single V3 scheduler used by the actual `V3LiveDispatcher`, not a second dispatcher engine.

At trusted PTT start the runtime allocates immutable 01-02 turn identity and immediately reserves a unit queue slot using the authenticated center and speaker reference. On PTT end, capture is sealed once. The global preparation lease bounds speaker-resolution wait and transcription, while the processing lease serializes the whole gate/emergency-reply/interpretation/CAD/output path **in intake order** for that unit. Distinct units can progress while A1 awaits STT, subject to shared process limits. Late STT results from expired or stopped queue entries are discarded before planning or CAD writes. The original 03-01 phrase-containment and physical-emergency paths remain unchanged.

## Hard bounds (per Node.js process)
| Resource | Limit | Behavior |
| --- | ---: | --- |
| Resident turns across V3 instances | 64 | Reject new intake with `scheduler_overloaded` when full |
| Turns for one unit in one V3 runtime | 8 | Reject a ninth capture, with explicit terminal diagnostic |
| Simultaneous preparations (identity/STT) | 8 | Additional admitted work waits for a preparation lease |
| Simultaneous execution pipelines | 4 | Other units use available capacity independently |
| End-of-capture to beginning of execution | 30 seconds | `queue_expired` terminal outcome, no newly started CAD mutation |
| Capture accepted but never ended | 90 seconds | `capture_expired`, release capture and reservation |

The process-global capacities and unit queues are **in-memory**, not a distributed multi-instance coordination guarantee. Limits prevent unlimited admission; if a provider cannot physically cancel, its preparation lease stays occupied until the provider settles. Active CAD/speech operations are not forcibly aborted or represented as rolled back by this item. Complete external-operation deadlines are **01-04**, current-generation/side-effect revalidation and cancellation are **01-05**, outbound speech separation is **01-06**, and operator-grade diagnostics are **01-07**. Channel-change continuation and cross-profile unit task ownership remain **02-07**. No radio transport/codec, firmware, schema, provider or CAD authorization change was made.

Overload and expiry produce explicit `turn_completed` / `turn_scheduler_terminal` diagnostic outcomes and a false accepted/handled result; this is fail-closed, not a guaranteed audible busy notification. A rejected capture cannot create a CAD action. The authenticated actor and requested target remain separate; source proof is unchanged.

## Validation and preserved failures
- [GitHub CI 40950616489](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40950616489), job `123717447457`, final code `01ceda2d7dea1bd6224397eeeff52e83a3d7c6a9`, Node 20.
- V3: **364 passed, 1 failed** (365 cases, 34 files). All **14 new 01-03** tests passed; existing trusted-intake/terminal-envelope cases pass.
- PTT credential/routing/floor group: **81/81 passed**. CI syntax and removed-legacy-engine checks passed.
- The **26 audit/control tests** and **85 phrase/emergency containment tests** pass. R02 (STT order), R03 (queued-answer expiry), R04 (pending STT after stop), and R10 (stalled TTS holding later work) now assert repaired behavior at their **specific queued-work boundaries**. R06/R07 remain repaired. R01, R05, R08, R09, R11, R12, R13 and R14 still reproduce known defects.
- **The full V3 job remains red:** unchanged `phase4Pipeline.test.js` CREATE_CALL test expects `Ten-four, eleven fifty-nine hours.` with no verified CAD mutation evidence. Actual response accurately says the change cannot be verified. Neither success assertions nor read-back verification were weakened.
- CI artifact `12931441394` (`dispatcher-v3-evidence-40950616489-1`); GitHub reports SHA-256 `4cd3fb141049e783610cfd2bce5189d8cab256475314d6b882f2c32edaebae12`. Artifact digest was reported by GitHub, not independently downloaded or rehashed here.
- Mocked provider, credential, CAD and PTT boundary tests are not real audio, provider, radio, mobile or production verification.

## Result and next step
Coding and **scoped mocked validation** for 01-03 are complete; counts are now 01=3/8, 02=0/8, 03=1/8, 04=0/8, total **4/32**. G-01 through G-04 remain unchecked. Next work item **01-04: Bound complete external operations**. Do not merge, rebase, deploy, restart, use production data, or run paid providers without separate authorization.
