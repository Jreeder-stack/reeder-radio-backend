# AI Dispatcher V3 01-04: complete external-operation deadlines

**AI-DISP-V3-001 / 01-04** | October 29, 2026 | Coding and scoped synthetic validation complete; no live/release qualification.

## Verified baseline and root cause
The latest 01-03 checkpoint was `c53c45091f426f720795877131446330bbf1fe1f` on `test/dispatcher-v3-01-01-baseline-20261028`; [PR #163](https://github.com/Jreeder-stack/reeder-radio-backend/pull/163) remains draft, open, unmerged and unmergeable. The V3 gateway previously canceled its timeout immediately after `fetch()` returned headers, leaving `response.text()` unbounded (audit R09). The model relied on the provider honoring AbortSignal, and the Azure recognition shutdown awaited `stopContinuousRecognitionAsync` callbacks without a hard timer. A stalled synthesis was also able to occupy the processing slot until its provider returned. These were **whole-operation lifecycle** defects, not Opus or transport problems.

Main advanced independently to `a730aec0c163cf567edd2e66eda18d9cd892d8ee` via #166 after the earlier main baseline `fd88b6076dd66f3badada8509ceb287f13c4ab37`. No reconciliation, rebase, merge, deploy or restart took place. Embedded-radio/PTT and native paging overlap in signaling requires separate main integration verification.

## Implementation
- `src/dispatcher-v3/operationDeadline.js` creates a **60-second end-of-capture overall budget** and a cancellable stage deadline. It rejects a late result even if its provider ignores abort, supplies an AbortSignal where supported and cleans timeout/listener resources.
- `src/dispatcher-v3/liveRuntime.js` shares the same budget across queued preparation and execution, STT, planning, CAD and speech, validates deadline before new speech/output, and rejects follow-on actions after expiration.
- `src/dispatcher-v3/speechPipeline.js` bounds STT at **15 seconds** and forwards the abort signal to the configured speech provider.
- `src/dispatcher-v3/intentPlanner.js` bounds model requests at **6.5 seconds** with actual race settlement, not only SDK abort. The existing 03-01 semantic routing and deterministic controls remain unchanged.
- `src/dispatcher-v3/cadGateway.js` applies one **8-second overall request budget** encompassing header reception, response body consumption and safe-read retries, including CAD read-back verification. Mutating POST/PATCH requests are never retried. A write acknowledged without verified read-back remains unconfirmed.
- `src/services/azureSpeechService.js` closes recognizers/synthesizers and clears registered timers/listeners when completed or aborted. Recognition SDK stop callbacks have a **2.5-second guard**; synthesis SDK has **12-second** maximum. Delayed SDK callbacks are ignored after a terminal result.
- `src/dispatcher-v3/actionExecutor.js` checks budget immediately before executing handlers and after they return, refusing to turn an expired result into successful action completion. This is a turn deadline check only, not complete 01-05 credential/runtime-generation/task ownership revalidation.

Stage limits are defaults with overall-budget clipping; they are not new public APIs or changes to radio transport, client firmware, codec, provider selection or database schema.

## Tested source and evidence
- Core deadline implementation: [`53e5a1452ea3d7a9598437523b896dfc69e5b77d`](https://github.com/Jreeder-stack/reeder-radio-backend/commit/53e5a1452ea3d7a9598437523b896dfc69e5b77d).
- Azure SDK bounded shutdown: [`f23acab51abe055a1c03eb15314c4e9144dc0a0e`](https://github.com/Jreeder-stack/reeder-radio-backend/commit/f23acab51abe055a1c03eb15314c4e9144dc0a0e).
- Controlled-clock regression tests: `e7ed72690f80f3e87182f1bd3a29d6ef01976cbd`.
- Validated test/diagnostic correction: **`bb9491b48184f9a7cb2fa03bb63a60f0e72ebd1a`**.
- GitHub [CI 40953141520](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40953141520), Node 20, job `123726233504`: **374 passed, 1 failed** in the V3 suite (375 cases, 36 files); **81/81 PTT** cases passed. All **10 new 01-04** deadline tests passed, including synthetic Azure SDK shutdown, non-cooperating body/model, late-result discard and two-unit progress. Syntax, legacy-engine absence, 85 phrase/emergency containment cases, 26 audit/healthy controls and existing 01-02/01-03 regressions passed.
- Audit **R09 now asserts the repaired response-body deadline** in all modes. R02/R03/R04/R06/R07/R10 remain repaired for their recorded scopes; R01/R05/R08/R11/R12/R13/R14 remain known reproductions.
- The **one known existing failure remains unchanged**: `src/dispatcher-v3/__tests__/phase4Pipeline.test.js` expects a successful CREATE_CALL radio acknowledgment even though its fixture lacks read-back verification evidence. Actual voice says the change could not be verified. Neither production verification nor the assertion was relaxed, skipped or hidden.
- GitHub CI artifact ID `12931079806`, digest **sha256:80d042846bcf09cc551b1cea659cd4d169acf6c3ff4dd53e538fce8028141b82**. This digest is GitHub-reported; the artifact was not independently downloaded or hashed.

## Safety boundaries and remaining work
A deadline prevents *new* follow-on activity from an expired turn and closes supported provider resources. It cannot undo an outbound CAD write already submitted or promise that the remote service physically stopped. An uncertain remote result remains unverified and belongs to 03-06 reconciliation. **01-05** owns complete per-boundary authorization/runtime-generation/intent freshness and cancellation policy; **01-06** owns a separate prioritized outbound speech scheduler and delivery states; **01-07** owns expanded operator diagnostics. The process-local 01-03 queue limits remain unchanged.

No real providers/audio, full repository/mobile testing, main integration or original production scenario has been verified. No merge, rebase, deployment, restart, production-data changes or paid-provider calls were performed. G-01 through G-04 remain unchecked.

**Checkpoint:** 01=4/8, 02=0/8, 03=1/8, 04=0/8; **5/32** completed for coding and scoped validation. Next **01-05**, without expanding the original four parent tasks or 32 IDs.
