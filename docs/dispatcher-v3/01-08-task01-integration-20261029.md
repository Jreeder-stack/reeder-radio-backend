# AI Dispatcher V3 01-08: Task 01 production-wiring integration and regression evidence

**Plan AI-DISP-V3-001**, October 29, 2026. Task 01 coding and **scoped mocked integration validation** complete; release acceptance, live radio verification, deployment and newer-main integration remain pending.

## Scope, baseline and production-path inspection

Repository: `Jreeder-stack/reeder-radio-backend`, branch `test/dispatcher-v3-01-01-baseline-20261028`, PR [#163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163) draft, open, unmerged, unmergeable. Starting HEAD `c2998266a66c42e29b4782ca53914751e7bf3233` (01-07 evidence). Final **CI-validated source**: `96e06e8b255d509a5cdff303d3123a9a73e72db3`. Main independently advanced to `1c9a5d6df338dddf7b1333adb4ba1c477713194e`; integration with it is not verified and no rebase/merge is authorized.

Source inspection verified the existing, real V3 request path:
1. The existing `AIDispatcherRuntimeManager.startProfile()` creates `new V3LiveDispatcher`, passes the validated center/channel/scopes and registers PTT start/end listeners with `signalingService`. It resolves each event through its configured unique profile, private principal/grant, center and channel binding before calling `V3LiveDispatcher.handlePttStart/End()`.
2. V3 reserves the immutable 01-02 identity in `turnScheduler.reserve()` **at intake**. Completion seals capture and follows 01-03 per-unit FIFO with shared process limits. `operationDeadline` provides 01-04 STT/model/CAD-header+body/speech deadlines and a turn budget.
3. `turnLifecycle` (01-05) checks generation, actor/session/radio token, grant and task ownership before side effects. The CAD gateway refuses unsafe write retries and the action handlers retain independent mutation read-back verification. Stop/restart invalidates old work.
4. `outboundScheduler` (01-06) handles speech independently from CAD command processing and keeps existing floor and emergency priorities. The 01-07 bounded journal correlates admission, model, action, CAD verification and delivery outcomes without raw credential/audio dumps.
5. The manager's older named `aiDispatchService` compatibility facade simply forwards verified PTT events to the manager's V3 resolver; it is **not** an active V1/V2 dispatcher engine. The former live-runtime per-unit `_processing` promise chain was already removed during 01-03; the former header-only CAD timeout was already removed in 01-04. No duplicate active request engine, legacy planner or unconnected replacement scheduler was found in this scoped production path. No unnecessary source rewrite was introduced under 01-08.

## New actual-entry integration regression
New test `src/services/__tests__/dispatcherV3ManagerIntegration.test.js` does **not stub V3LiveDispatcher**. It instantiates the actual runtime manager and V3 class and exercises manager-managed signaling callbacks. External CAD HTTP, credentials database, speech SDK, audio and floor hardware are synthetic and bounded. The seven tests cover:
- Reversed STT completion for two A1 transmissions: CAD writes retain capture order while B2 executes independently.
- Same callsign and similarly named OPS1 channels in separate centers: the manager rejects the wrong path and CAD writes stay in the bound center.
- Stop/restart during unresolved STT: old-generation transcription cannot write; new events work, and PTT listener subscriptions do not multiply.
- Eight resident turns on one unit and ninth-turn overload: source entry-point admission enforces bounded backpressure.
- A CAD POST with a stalled response body: the whole request fails within the bounded timeout, with no duplicate write or invented verification.
- Duplicate authenticated PTT-end replay: the manager forwards the event but the real V3 capture is consumed once and only one CAD mutation occurs.
- Stalled speech synthesis: manager-routed subsequent CAD commands execute independently, and stopping the runtime prevents late audio injection.

Existing source-scoped 01-02–01-07 tests continue to exercise immutable turn envelopes, authorization, retries, timeout/cancellation, emergency containment, queue fairness and outbound delivery independently, without a fake copy of the repaired runtime functions.

## Test code, CI and limitations

- New real-manager test commit `bcd708c49ebc2546f2083b93299ae9fbd3f1d183`; dedicated branch-scoped GitHub Actions integration step `fa73f0b8ca0324ff970e8964c4eafb5f5d23adf5`; synthetic readiness settings and test isolation corrections completed through final validated commit `96e06e8b255d509a5cdff303d3123a9a73e72db3`.
- [GitHub Actions 40969353725](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40969353725), job `123781887212`, Node 20:
  - **7/7** actual manager-to-V3 synthetic integration checks passed.
  - **81/81** existing PTT adapter, configured-routing and floor-control checks passed.
  - **414/415** V3 regression tests passed across 39 files; 01-01–01-07 and urgent 03-01 containment/healthy checks remain unchanged and passing.
  - Syntax, absence of superseded V1/V2 dispatcher engines and recorded audit/containment test steps passed.
- The **one existing failure** remains `src/dispatcher-v3/__tests__/phase4Pipeline.test.js`, which expects the successful CREATE_CALL radio confirmation while the fixture contains no independent CAD verification evidence. The runtime correctly declines to claim verified success. The fixture, authorization, verification and failing assertion were not modified, suppressed or reclassified as passing. **The V3 suite and CI workflow remain red**; scoped integration checks pass.
- Artifact `12939612238` (`dispatcher-v3-evidence-40969353725-1`), GitHub-reported SHA-256 `d3b83a2eda721ba5b7516275f4ca84aa1fa61c1403c0bcf241c7f1ae1ad62c4d`. Artifact was not independently downloaded/rehashed during this step.
- This is a **coding and scoped synthetic validation milestone, not G-01** release acceptance. Newer main has additional PTT/signaling/audio changes. PR #163 still conflicts; integration with main, real provider/audio/radio, mobile/full repository, production revision, original incident and actual emergency pilot remain unverified. No merge/rebase/deployment/restart/production-data changes or paid provider tests were performed.

## Task 01 checkpoint and continuation

**Task 01: 8/8 coded and scoped-validated.** Urgent 03-01 is also complete. Counts: 01=8/8, 02=0/8, 03=1/8, 04=0/8; **9/32** total work-item coding/scoped checks. All four release gates **G-01–G-04 unchecked**. Existing audit R02/R03/R04/R06/R07/R09/R10 remain repaired at their previously recorded scoped boundaries; R01/R05/R08/R11/R12/R13/R14 remain known defects assigned to remaining work. Do not claim full release-readiness or force a false green test result.

**Next original item is 02-01, Create unit-owned conversation and task records.** Preserve all 32 work IDs and 64 original deliverable/acceptance paragraphs. Do not revive old engines, change transport/codecs/firmware/schema, weaken existing authorization/physical-emergency controls, or integrate/deploy without separate approval.
