# AI Dispatcher V3 master checklist

Plan AI-DISP-V3-001, version 1.4, October 29, 2026.
Repository: `Jreeder-stack/reeder-radio-backend`.
Branch: `test/dispatcher-v3-01-01-baseline-20261028`; PR #163, unmerged.
Latest scoped-validated source: `01ceda2d7dea1bd6224397eeeff52e83a3d7c6a9` (01-03, GitHub CI 40950616489 on Node 20; expected pre-existing CREATE_CALL verification fixture failure retained).
Main at the implementation baseline: `c5ce5feed7a4feadb86ddca3d6d8c89e2c2f90fa`, identical to the audit. Final read-only checkpoint observed independently advanced main `fd88b6076dd66f3badada8509ceb287f13c4ab37` (PRs #164/#165); integration with that revision and the production revision remain unverified.

## Fixed objective and boundaries

Repair V3 for natural, context-aware multi-unit dispatch conversation, ordered and bounded execution, safe authorized CAD actions and truthful responses. Unfamiliar wording must not require a new hardcoded phrase. No CAD action needed must not mean no useful reply. Keep these four parent scopes and all 32 IDs unchanged; release gates are not a fifth development task.

Preserve radio transport, codec, gateway transmitter behavior, client firmware, center isolation, military time, verified mutations and hardware-emergency policy. Do not revive V1/V2, create V4, migrate providers, add unrestricted database/web tools, or change the schema without separate approval. Retain the existing speech/model stack initially. Broader off-topic chat policy remains undecided and does not block natural operational dialogue.

Coding completion, scoped validation, pilot verification and release are separate. Each item requires complete wiring/error paths/tests/cleanup/docs and a recorded commit before coding completion. Validation requires evidence, not an assertion. All unchecked items are pending verification, not a claim that existing code is absent. Preserve and reuse verified existing work. No merge, deployment, restart, paid evaluation or production-data changes without separate authorization.

## Checkpoint and order

| Parent | Scope | Coding | Validated |
| --- | --- | ---: | ---: |
| 01 | Reliable request processing | 3/8 | 3/8 |
| 02 | Multi-unit conversation management | 0/8 | 0/8 |
| 03 | Meaning-based understanding and safe CAD actions | 1/8 | 1/8 |
| 04 | Natural conversation and useful responses | 0/8 | 0/8 |
| Total | Original 32 items | 4/32 | 4/32 |

01-01, 01-02, **01-03** and urgent 03-01 are complete for coding and scoped mocked validation. CI run **40950616489** on Node 20 tested final 01-03 source: **364 passed, 1 existing failure / 365 V3 cases**; **81/81 PTT** tests; all 14 new 01-03 scheduling tests, 85 containment cases and 26 audit/control cases passed. R02/R03/R04/R10 now assert repaired behavior for their specific queued-work boundaries alongside prior R06/R07. Eight remaining audit cases still reproduce defects. The unchanged CREATE_CALL success fixture lacks CAD verification evidence and fails; verification and its failing assertion were not weakened. See `dispatcher-v3/01-03-per-unit-scheduling-20261029.md` and `dispatcher-v3/validation/01-03-results.json`. Historical 01-02 results remain unchanged. Scoped validation is not G-01 release acceptance.

Read `dispatcher-v3/01-02-intake-trace-20261029.md`, `dispatcher-v3/validation/01-02-results.json` and `dispatcher-v3/validation/01-02-audit-results.json` for current implementation, commands, source hashes, CI comparison and limitations. The earlier `dispatcher-v3/03-01-phrase-containment-20261029.md` and `dispatcher-v3/validation/03-01-results.json` retain their historical evidence; the 01-01 baseline/results are also not rewritten as repair evidence.

Next is **01-04: Bound complete external operations**. Intake-order execution, independent per-unit queues and bounded admission/waiting are now in place. Continue 01-04 through 01-08, Task02, remaining Task03, Task04 and gates. Complete freshness/cancellation remains 01-05. No mutating pilot is authorized by this completion. Use one coordinated implementation stream for shared runtime/planner/state files. Write and run focused tests with each change; prefer mocked checks before paid calls and do not rerun unchanged expensive jobs without a diagnosis.

The deliverables and acceptance paragraphs below are retained verbatim from version1.0. Repeated pending-evidence boilerplate is consolidated: for every item except 01-01, 01-02, 01-03 and 03-01, commits/tests/implementation evidence remain pending and live/pilot status remains unverified for every item. Do not silently shorten requirements when implementing an item.

## Task 01: Reliable request processing

| ID | Work item | Coded | Validated |
| --- | --- | --- | --- |
| 01-01 | Verify the baseline and establish the runtime test harness | [x] | [x] |
| 01-02 | Give every transmission a trusted identity and ordered turn record | [x] | [x] |
| 01-03 | Implement bounded, independent per-unit scheduling | [x] | [x] |
| 01-04 | Bound complete external operations | [ ] | [ ] |
| 01-05 | Enforce expiry, cancellation and runtime-generation checks | [ ] | [ ] |
| 01-06 | Separate outbound speech from command processing | [ ] | [ ] |
| 01-07 | Add correlated, bounded diagnostics | [ ] | [ ] |
| 01-08 | Integrate Task 01 and author its regression coverage | [ ] | [ ] |

### 01-01: Verify the baseline and establish the runtime test harness

**Deliverable:** Read current main and repository instructions; record the exact revision, supported runtime, dependency lockfile, dispatcher configuration, existing capabilities and test commands. Compare the current implementation with the audited revision before changing it. Import or faithfully reconstruct the audit reproductions against actual dispatcher entry points, using synthetic CAD data, mocked providers and controllable time. Record the existing failure results and define finite operation limits and the pilot latency/cost measurement procedure.

**Acceptance:** The baseline is pinned; the focused harness runs on the repository-supported runtime; each reproduced defect has an expected fixed behavior. Any defect already repaired is credited only after inspecting and testing the current implementation. Missing credentials must not prevent mocked tests. No production writes, radio transmissions or deployments are part of this step.

### 01-02: Give every transmission a trusted identity and ordered turn record

**Deliverable:** Create a consistent turn envelope with dispatcher/runtime generation, dispatch center, authenticated connection and speaker/unit identity, channel, unique turn ID, sequence and capture timestamps. Keep the speaker distinct from a requested target unit. Carry this envelope through transcription, planning, execution, output and diagnostics; suppress duplicate intake events.

**Acceptance:** Transmission order is allocated at intake, not transcription completion. Missing or ambiguous identity cannot authorize a mutation. A duplicate PTT-end event does not create a second action. A spoken callsign cannot override authenticated identity or permissions.

**Completion evidence (October 29, 2026):** implementation `7e9fcdb1982967771e3264328ce9554a8896b48e`; 103/103 new cases pass on Node v20.20.2. Stored-session or assigned-radio proof and account-owned enabled channel grants are bound to an unambiguous configured channel/center before speaker resolution. Private transmission metadata survives normal, drained and forced ends plus both compatibility layers. Immutable intake identity/sequence and completed capture envelopes flow through transcription, planning, execution, output and diagnostics; correlated duplicate events cannot create a second action. Local and inspected GitHub CI run 40917334797 agree on 81/81 PTT cases and 350/351 V3 cases, with the existing unverified CREATE_CALL fixture failure preserved. Server-observed capture timestamps do not claim physical microphone timing; legacy no-ID wire events cannot distinguish every delayed/replayed event. See the 01-02 trace/results/audit evidence above. Execution ordering (01-03), complete freshness/cancellation (01-05), live/pilot and release acceptance remain pending.

### 01-03: Implement bounded, independent per-unit scheduling

**Deliverable:** Preserve legitimate sequential requests for each unit even when transcription finishes out of order. Allow other units to progress independently, subject to a documented global resource limit. Bound queue lengths and waiting time; report overload through a safe terminal outcome rather than silently building a backlog.

**Acceptance:** Reversed transcription completion still produces the correct operation order. A stalled A1 request does not block B2. Two legitimate consecutive commands both execute when still relevant. Duplicate or expired work cannot accumulate without limit.

**Completion evidence (October 29, 2026):** implementation `a137daa81ae329745cd5784959c42603b1db3d50`, final validated source `01ceda2d7dea1bd6224397eeeff52e83a3d7c6a9`; process-global 64 resident/8 STT preparation/4 execution capacities, 8 resident per unit, 30-second end-of-PTT queue wait and 90-second never-ended capture lease. Capture-order reservations now precede asynchronous identity/STT, and the whole gate/semantic-action pipeline serializes within a unit while others proceed. Fail-closed overload/expiry outcomes and immutable original envelopes are retained; late queued work cannot newly mutate CAD. GitHub CI 40950616489 ran 14/14 new scheduler tests, 81/81 PTT controls and 364/365 V3 cases; the only failure remains the unchanged CREATE_CALL verification fixture. R02/R03/R04/R10 assert scoped queued-work repairs; complete lifecycle/cancellation, external timeouts, outbound speech scheduling, distributed multi-instance coordination and live verification remain pending under their assigned items. See the 01-03 implementation report and evidence JSON.\n\n### 01-04: Bound complete external operations

**Deliverable:** Apply per-stage and overall turn deadlines to transcription, model requests, CAD response headers and bodies, verification, speech synthesis, and speech SDK shutdown. Propagate cancellation through supported provider APIs and invalidate late results when physical cancellation is unavailable. Clean up timers, listeners and resources in all terminal paths.

**Acceptance:** A stalled body read, model call, synthesis call or SDK stop callback reaches a bounded terminal state. Late completions cannot execute actions or speak. Tests use configured deadlines and controlled clocks rather than waiting minutes in CI.

### 01-05: Enforce expiry, cancellation and runtime-generation checks

**Deliverable:** Revalidate freshness, pending-task ownership, authorization and runtime generation immediately before side effects and after asynchronous boundaries. Stop/restart invalidates old work. Support explicit supersession without dropping every earlier command. Distinguish unsent work from a CAD operation already submitted.

**Acceptance:** Five-minute-old queued requests and expired replies cannot execute. Stopping and restarting during transcription or planning cannot produce an old-runtime action. Cancellation never claims to undo a write already submitted; uncertain outcomes move to reconciliation under 03-06.

### 01-06: Separate outbound speech from command processing

**Deliverable:** Use a bounded outbound scheduler through the existing channel-floor interface. Preserve recipient, channel, order, freshness and delivery outcomes. Support priority handling through existing emergency/floor controls without changing the radio transport. Track queued, speaking, completed, interrupted, expired and failed output.

**Acceptance:** Stalled speech does not hold a unit's next valid command indefinitely. Speech is not sent on an obsolete channel or over another authorized speaker. Interrupted prompts are not treated as delivered. A queued reply is rechecked for relevance before transmission.

### 01-07: Add correlated, bounded diagnostics

**Deliverable:** Trace intake, transcription, addressing, conversation selection, interpretation, action outcomes, verification and speech delivery using turn/task IDs. Record stage duration, queue age, timeout/cancel reasons and available usage/cost metrics. Apply redaction, access controls, bounded retention and rate limits; do not dump credentials or unrestricted audio/transcripts into routine logs.

**Acceptance:** An operator can distinguish not addressed, unintelligible audio, ambiguity, unsupported capability, denied action, provider failure and delivery failure. No silent catch-all path and no repeated-event logging storm. Each accepted turn has a traceable terminal outcome.

### 01-08: Integrate Task 01 and author its regression coverage

**Deliverable:** Wire the new scheduling and lifecycle through the real dispatcher runtime and runtime manager. Remove superseded dispatcher-owned queue/timeout paths. Add focused regression tests covering ownership envelopes, reversed completion, duplicates, expiry, stop/restart, body stalls, speech stalls, backpressure and normal consecutive commands.

**Acceptance:** Test code and production wiring are complete, with no unconnected replacement implementation. Mark coding complete separately from a recorded passing run. Validation must exercise actual entry points, not merely mocked copies of the functions being repaired.

## Task 02: Multi-unit conversation management

| ID | Work item | Coded | Validated |
| --- | --- | --- | --- |
| 02-01 | Create unit-owned conversation and task records | [ ] | [ ] |
| 02-02 | Retain the complete task during clarification | [ ] | [ ] |
| 02-03 | Correlate follow-ups with delivered prompts | [ ] | [ ] |
| 02-04 | Implement correction, cancel, topic change and resumption | [ ] | [ ] |
| 02-05 | Revalidate incident and assignment relationships | [ ] | [ ] |
| 02-06 | Share incident facts without merging unit instructions | [ ] | [ ] |
| 02-07 | Handle channel changes, disconnects and identity changes | [ ] | [ ] |
| 02-08 | Integrate and test multi-unit conversation behavior | [ ] | [ ] |

### 02-01: Create unit-owned conversation and task records

**Deliverable:** Store dialogue by dispatch center and authenticated unit/session, with explicit conversation/task IDs, speaker and capture times. Separate dialogue from durable CAD facts. Permit an active task and bounded suspended topics so a single unit can change subjects without deleting all useful context. Channel is a routing attribute, not a replacement for identity.

**Acceptance:** A1 resumes its own traffic stop after B2 and C3 speak. Another unit's unfinished task does not become A1's instruction. Same callsigns in different centers remain isolated. Old conversational relevance expires without deleting CAD records.

### 02-02: Retain the complete task during clarification

**Deliverable:** Keep the intended action, resolved parameters, unresolved field, candidate IDs, original turn and call relationship when asking a question. Clarification changes the task state rather than replacing the original plan with an empty CLARIFY action.

**Acceptance:** After “Put me on that call” and “Which call?”, the answer resumes the assignment request with its original ownership and constraints. The model need not reconstruct the entire task from raw transcripts.

### 02-03: Correlate follow-ups with delivered prompts

**Deliverable:** Bind questions and answers to the correct unit and task. Start the answer window from confirmed output completion, not question creation. Follow-ups in an active conversation need not repeat the wake phrase. Preserve explicit addressing and ignore unrelated unit-to-unit speech or the dispatcher's own output.

**Acceptance:** A prompt delayed by a busy channel does not expire before the unit can answer. An interrupted or failed prompt is not assumed heard. Ambiguous answers receive a targeted clarification rather than answering a different unit's question. Delivery means observed transmission completion, not proof the person heard it.

### 02-04: Implement correction, cancel, topic change and resumption

**Deliverable:** Use one task lifecycle for pending clarifications, dispositions and incident follow-ups. Distinguish a new task, a correction, cancellation, suspension, resumption, completion and expiry. Feed these transitions into Task 01 cancellation and freshness controls.

**Acceptance:** “Disregard that” retires the applicable unfinished request, not every task in the center. A new topic does not append itself to an old incident. A conversation reset cannot clear an actual hardware emergency. Already-submitted actions are not falsely represented as undone.

### 02-05: Revalidate incident and assignment relationships

**Deliverable:** Check the task's target call and the unit's current assignment before follow-up writes. Handle closure, reassignment and changes made by another authorized actor. Remove the conversion of unrelated NO_ACTION text into UPDATE_FIELD_INCIDENT and prevent unrelated speech from extending old dialogue indefinitely.

**Acceptance:** Cancellation-like text cannot become a note on OLD-CALL. A changed or ambiguous call relationship triggers a targeted question or an explicit invalidation. An explicit, authorized reference to a previous call remains possible rather than banning all historical references.

### 02-06: Share incident facts without merging unit instructions

**Deliverable:** Provide verified, center-authorized incident facts and properly attributed operational reports to participating units. Resolve group references against actual assignments and permissions. Keep private dialogue, pending answers and requested actions separate, including when two units discuss the same event.

**Acceptance:** B2 can ask about an incident shared with A1 without acquiring A1's pending command. Unverified reports remain labeled as reports. “We” or “both of us” does not grant authority to alter other units' records; unclear group intent is clarified.

### 02-07: Handle channel changes, disconnects and identity changes

**Deliverable:** Apply explicit rules for conversation continuation when a unit changes channel or reconnects. Revalidate permissions and current routing before replying. Retire stale sessions and handle device-to-unit reassignment without transferring another operator's unfinished work. Do not change client firmware or transport protocols.

**Acceptance:** A valid reconnect can resume a still-relevant task; an old session cannot act after replacement. Replies are not sent to the wrong channel. A device reassigned to B2 does not retain A1's task authority.

### 02-08: Integrate and test multi-unit conversation behavior

**Deliverable:** Add actual runtime-path tests with at least five independently identified units, interleaved and overlapping questions, multiple topics for one unit, shared incidents, repeated callsigns across centers, channel changes, disconnects, stale context and emergency interruptions. Remove superseded pending-state stores and consumers.

**Acceptance:** Positive follow-ups succeed, isolation tests remain intact and one unit's delay does not corrupt another's conversation. There is one authoritative lifecycle, not a new manager running beside old conflicting stores. Record coding and validation separately.

## Task 03: Meaning-based understanding and safe CAD actions

| ID | Work item | Coded | Validated |
| --- | --- | --- | --- |
| 03-01 | Remove unsafe phrase-match bypasses [urgent] | [x] | [x] |
| 03-02 | Implement one semantic interpretation contract | [ ] | [ ] |
| 03-03 | Preserve compound requests and action dependencies | [ ] | [ ] |
| 03-04 | Resolve unit and call references using adequate evidence | [ ] | [ ] |
| 03-05 | Enforce tool permissions and validated inputs | [ ] | [ ] |
| 03-06 | Track verified, partial, failed and unknown outcomes | [ ] | [ ] |
| 03-07 | Return complete, factual results for every supported action | [ ] | [ ] |
| 03-08 | Integrate semantic-action tests and remove obsolete paths | [ ] | [ ] |

### 03-01: Remove unsafe phrase-match bypasses [urgent]

**Deliverable:** After the baseline harness is available, contain and replace broad matchers that confidently mutate based on a unit name plus a status word. Route ambiguous or unconstrained language through semantic interpretation. Keep only genuinely unambiguous fast paths that pass complete-sentence meaning tests. Do not fix this by adding a list of negation exceptions.

**Acceptance:** “Do not mark B2 available,” “Is B2 available?” and “B2 is not on scene” do not create the opposite status change. This protection is required before any pilot that allows real CAD writes. Early containment alone does not mark all of Task 03 complete.

**Completion evidence (October 29, 2026):** implementation `db111bb7888e0dcb15e1715b4259568cae6b8910`; 85/85 new containment tests and 26/26 audit/control cases pass on Node v20.20.2. R06 and the incidentally repaired R07 always assert fixed behavior. Full V3 remains red, 318/319, with the existing unverified CREATE_CALL fixture failure preserved. See `dispatcher-v3/03-01-phrase-containment-20261029.md` and `dispatcher-v3/validation/03-01-results.json`. No live/pilot or release acceptance.

### 03-02: Implement one semantic interpretation contract

**Deliverable:** Provide the model with the correctly scoped conversation, current facts and available tool capabilities. Distinguish an action request, question, observation, correction, cancellation, clarification, conversation-only reply and genuinely unaddressed speech. Use structured, validated outputs and preserve speaker versus target. No-match is not a generic failure or a forced mutation.

**Acceptance:** Previously unseen wording for supported operations produces a valid plan or a specific clarification. Questions remain questions; observations are not automatically status changes. A model-generated plan never grants itself authorization or invents a new tool.

### 03-03: Preserve compound requests and action dependencies

**Deliverable:** Represent multi-part requests as explicit ordered operations with dependencies and per-step outcomes. Keep the location separate from a trailing instruction. Apply duplicate prevention and stop dependent work when a prerequisite fails; do not claim cross-system atomicity or rollback that the existing APIs do not provide.

**Acceptance:** “Start a building check at 100 Main Street and mark me on scene” preserves both operations and a clean address. A mixed read/write request returns requested information as well as mutation outcomes. Partial completion is observable and not retried wholesale.

### 03-04: Resolve unit and call references using adequate evidence

**Deliverable:** Require sufficient non-conflicting information for call/unit selection. Prefer explicit IDs and authoritative context; detect conflicting nature, location, assignment or identity evidence. Distinguish no match from several plausible matches. Revalidate shared-call state immediately before execution and use existing concurrency controls where available.

**Acceptance:** “Walmart robbery” does not silently select a Walmart alarm merely because it is the only Walmart call. Ambiguous units or calls prompt a specific question. Stale context or simultaneous shared-call changes cannot silently redirect an action.

### 03-05: Enforce tool permissions and validated inputs

**Deliverable:** Keep a finite registry of existing authorized CAD capabilities with schema validation, center scoping, actor/target permissions, allowed transitions and execution limits. Treat model output, radio wording and retrieved note text as untrusted inputs, not permission instructions. Preserve existing security checks and verified-mutation boundaries.

**Acceptance:** No arbitrary endpoint, SQL, cross-center read/write, unauthorized other-unit action or instruction embedded in a CAD note can bypass validation. Existing supported legitimate operations still work. Missing capabilities are reported, not manufactured.

### 03-06: Track verified, partial, failed and unknown outcomes

**Deliverable:** Carry receipt, persistence, deferral, failure and uncertainty through incident handling, execution and verification. Reconcile timed-out submitted mutations with supported read-back/idempotency mechanisms before retrying. Bound retries and pending work; surface unresolved outcomes to the operator. Do not silently introduce a database migration for a feature the existing interfaces cannot support.

**Acceptance:** A failed incident note cannot be labeled fully successful. A timeout after submission is unknown until reconciled, not automatically failed or safe to repeat. Retries cannot duplicate calls or notes. Any gap in the current CAD contract is documented and gated rather than hidden behind a success message.

### 03-07: Return complete, factual results for every supported action

**Deliverable:** Define a response contract for all supported reads and writes, including GET_CALL, SEARCH_CALLS, field incidents and multi-action plans. Return requested fields, verified effects, partial results and actionable failure reasons. Keep “heard you” distinct from “saved in CAD.” Task 04 may phrase the response naturally but cannot alter these facts.

**Acceptance:** Call queries return the answer, not only “copy.” Acknowledgments never conceal known failed/deferred writes or claim an unverified success. Factual output preserves the chosen military-time convention.

### 03-08: Integrate semantic-action tests and remove obsolete paths

**Deliverable:** Test negative/question versus command pairs, natural paraphrases, compounds, ambiguous references, authorization, prompt-injection attempts, partial failures, unknown outcomes and verified positive workflows. Trace each test through planner, resolver, executor and result composition; remove replaced matchers and conflicting fallbacks.

**Acceptance:** R06-R08 and R13-R14 meet fixed-behavior expectations. Valid commands still execute instead of a blanket clarification or refusal strategy. No alternate runtime path can still reach the removed unsafe behavior. Paid model evaluation is separate from cheap deterministic regressions.

## Task 04: Natural conversation and useful responses

| ID | Work item | Coded | Validated |
| --- | --- | --- | --- |
| 04-01 | Add a first-class conversation-only response path | [ ] | [ ] |
| 04-02 | Generate concise, grounded radio responses | [ ] | [ ] |
| 04-03 | Recover from missing or unclear information | [ ] | [ ] |
| 04-04 | Replace generic dead ends with truthful explanations | [ ] | [ ] |
| 04-05 | Preserve radio discipline and human takeover | [ ] | [ ] |
| 04-06 | Author an independent conversational evaluation set | [ ] | [ ] |
| 04-07 | Wire natural conversation through the actual radio path | [ ] | [ ] |
| 04-08 | Implement the end-to-end acceptance runner and runbook | [ ] | [ ] |

### 04-01: Add a first-class conversation-only response path

**Deliverable:** Allow a meaningful reply without selecting a CAD operation: presence checks, acknowledgments, explanations, simple conversational exchanges and questions answerable from available context. Integrate this into the same planner and task lifecycle rather than a disconnected chatbot. A known tool list limits executable operations, not possible sentences.

**Acceptance:** “Central, are you there?” receives an appropriate reply. An unfamiliar but understandable sentence is interpreted or clarified rather than discarded because it lacks a command template. Unaddressed chatter and self-generated speech are still ignored appropriately.

### 04-02: Generate concise, grounded radio responses

**Deliverable:** Compose natural replies using the correct unit, dialogue and Task 03 outcome contract. Answer the question actually asked; avoid needless repeated questions, boilerplate and long speeches. Use approved terminology and military time. Bound output length and preserve factual status when using natural-language generation.

**Acceptance:** Replies are useful, brief and associated with the correct unit/incident. No invented calls, locations, assignments, capabilities or completed actions. Scripted emergency/error wording may remain where useful; officers do not need scripted input wording.

### 04-03: Recover from missing or unclear information

**Deliverable:** Ask a focused question about the actual missing detail, retaining everything already known. Handle hesitation, pronouns, corrections, fragmented transmissions and low-quality transcription without guessing critical names, addresses or registrations. Bound repeated clarification and explain a terminal problem.

**Acceptance:** The user can answer with just the requested detail. The dispatcher does not repeatedly ask answered questions or loop forever. Critical ambiguities lead to a narrow clarification or human handoff, not fabricated certainty.

### 04-04: Replace generic dead ends with truthful explanations

**Deliverable:** Distinguish unclear intent, unavailable capability, denied access, service failure, stale request and undelivered output. State what is known and what the unit can do next, using existing human-dispatcher/operator paths where supported. Show a bounded operational error when speech cannot be delivered.

**Acceptance:** “I can't right now” is not the catch-all for unfamiliar language. The explanation identifies the real limitation without disclosing sensitive internals. A handoff is not announced as completed unless its delivery is verified; no new external service is silently added.

### 04-05: Preserve radio discipline and human takeover

**Deliverable:** Coordinate natural replies with existing floor and emergency controls. Routine conversation yields to urgent traffic. Prevent the dispatcher from hearing its own synthesized output as a fresh request. Support the existing operator mute/disable/takeover path and invalidate queued AI work appropriately; implement missing dispatcher-side wiring within this scope.

**Acceptance:** Human takeover stops new AI mutations and queued speech while exposing already-submitted unknown outcomes for reconciliation. Routine speech does not block an emergency. Canceling dialogue never clears the hardware emergency. Wider off-topic chat policy is not required to ship natural operational conversation.

### 04-06: Author an independent conversational evaluation set

**Deliverable:** Prepare a held-out evaluation set not used to accumulate phrase patches. Include at least 50 varied utterances and 10 multi-turn exchanges, plus the five-unit scenarios from 02-08. Cover unfamiliar paraphrases, ordinary conversation, silence, ambiguity, negation, questions, compounds, corrections, unsupported requests and injected instructions. Identify acceptable outcomes before scoring.

**Acceptance:** The evaluation scores task success, response relevance, clarification quality, wrong-target actions, stale execution, fabricated claims, latency and cost. Include positive requests so a system that always refuses cannot pass. The numerical sample sizes are proposed planning acceptance minima, not a statistical reliability guarantee.

### 04-07: Wire natural conversation through the actual radio path

**Deliverable:** Connect intake, addressing, per-unit conversation, semantic planning, guarded CAD tools, factual result composition and speech delivery using the current provider/platform. Remove disconnected prototypes and stale command-only fallbacks. Ensure errors and no-action replies use the same diagnostics and outcome tracking.

**Acceptance:** The behavior is available in the existing dispatcher runtime, not only a text demo. All existing clients using the dispatcher PTT interface remain compatible. No new engine, codec, radio firmware, provider migration or broad Command Link rewrite is required.

### 04-08: Implement the end-to-end acceptance runner and runbook

**Deliverable:** Provide repeatable scenarios for real runtime and audio-path testing with synthetic data, controlled provider failures, multi-unit interleaving and human interruption. Record expected results, trace IDs, task outcomes, delivery evidence and baseline comparisons. Document supervised pilot setup, operator takeover, candidate/previous revisions and rollback steps.

**Acceptance:** The acceptance runner, fixtures, evaluation scoring and operator instructions are complete. Passing focused tests is recorded separately from actual-provider and real-radio evidence. The release gates below remain required; this work item does not authorize a deployment.

## Integrated release gates: not an additional development task

All gates remain unchecked. Each passing result must identify the candidate commit and the actual environment. A failure blocks rollout; a narrower safe mode requires explicit approval and cannot be reported as the full plan completed.

| Gate | Required result | Status |
| --- | --- | --- |
| G-01 | Supported-runtime focused tests and complete V3 suite pass; appropriate repository tests/build pass; removed paths cannot still execute; all 14 audit scenarios now assert correct behavior. Record exact commands, revisions, configuration limits and failures resolved. | [ ] |
| G-02 | Actual speech/model/CAD integration succeeds against synthetic data in a designated test environment, with scoped credentials and an agreed cost cap. Exercise failure and unknown-write outcomes. Record unsupported capabilities explicitly. | [ ] |
| G-03 | Run the held-out language evaluation and an actual PTT/audio session with at least five independently identified units, interleaved conversations, shared calls, corrections, channel changes and urgent interruptions. Measure end-of-PTT to first audible response, completion, queue age and per-turn cost; record p50/p95 against targets documented before the run. | [ ] |
| G-04 | Justin separately authorizes the candidate merge/deployment and supervised pilot. Record the deployed revision and previous rollback target; verify human takeover/disable and rollback procedure. Correlate original symptom scenarios end to end in the pilot before claiming operational acceptance. | [ ] |

All original regression cases must pass. Any observed wrong-unit/cross-center action, prohibited or negated mutation, expired execution, duplicate mutation, fabricated completion or suppression of actual emergency state blocks acceptance. Positive cases must also complete useful work; refusing everything or endlessly clarifying is not a pass. An unavailable capability must produce an accurate explanation, not an invented tool or success. Passing a finite scenario set does not establish infallibility or justify unsupervised public-safety operation.

Separate real-audio transcription problems from downstream interpretation problems. Score both the captured audio/transcript and the chosen action/response so a correct transcript cannot conceal a planning defect and an incorrect transcript is not automatically blamed on the planner. Evaluate noise, clipped identifiers and short follow-ups without changing the codec or transport in this scope.

## Audit-to-work traceability

| Finding | Defect described by the audit | Owning work items |
| --- | --- | --- |
| F1 | Shared stale dialogue across units | 01-02, 02-01, 02-06, 02-08 |
| F2 | Transcription-completion ordering; expired/old-runtime work executes | 01-02, 01-03, 01-05, 01-08 |
| F3 | Unbounded CAD body/speech waits and blocked queues | 01-04, 01-06, 01-08 |
| F4 | Old incident dialogue survives fresh requests and call changes | 02-04, 02-05, 02-08 |
| F5 | Broad deterministic matching overrides actual meaning | 03-01, 03-02, 03-03, 03-08 |
| F6 | Clarification loses the task or expires before prompt delivery | 02-02, 02-03, 02-08, 04-03 |
| F7 | Successful queries return only acknowledgment | 03-07, 03-08, 04-02 |
| F8 | Failed/deferred incident writes hidden behind success | 03-06, 03-07, 03-08, 04-04 |
| F9 | Weak partial reference selects the wrong call | 03-04, 03-08 |

## Required regression outcomes

| Audit check | Expected behavior after the repair | Main owners |
| --- | --- | --- |
| R01 | A six-minute-old A1 conversation is not supplied as current B2 dialogue; verified shared facts remain available only when authorized/relevant. | 02-01, 02-08 |
| R02 | Reversed transcription completion does not reverse transmission/operation order. | 01-03, 01-08 |
| R03 | An expired disposition answer cannot execute against its old pending context. | 01-05, 02-03 |
| R04 | Work from a stopped runtime cannot newly mutate CAD or speak after a late completion. Already-submitted uncertainty is reconciled, not called undone. | 01-05, 01-08, 03-06 |
| R05 | Cancellation or topic change cannot become a note on an obsolete incident. | 02-04, 02-05 |
| R06 | Negations and status questions cannot become contrary status mutations. | 03-01, 03-02, 03-08 |
| R07 | Compound call/status requests retain both operations and the correct address. | 03-03, 03-08 |
| R08 | GET_CALL and SEARCH_CALLS return requested information when available. | 03-07, 04-02 |
| R09 | A stalled response body is bounded by the complete-operation deadline. | 01-04, 01-08 |
| R10 | Stalled synthesis does not indefinitely hold the next request or later release stale work. | 01-04, 01-06 |
| R11 | The answer window starts after the question is actually transmitted, and interrupted prompts do not count as delivered. | 01-06, 02-03 |
| R12 | Clarification retains the intended action and already resolved parameters. | 02-02, 02-08 |
| R13 | A failed note write is visible as failed/deferred/unknown as appropriate, not full success. | 03-06, 03-07 |
| R14 | Conflicting call nature/location evidence triggers clarification or no-match instead of a weak-match selection. | 03-04, 03-08 |

## Exact continuation

01-03 core implementation `a137daa81ae329745cd5784959c42603b1db3d50`; terminal-envelope fix `4f523191662c17f184a91021ae71d916d377da6f`; final tested source `01ceda2d7dea1bd6224397eeeff52e83a3d7c6a9`. CI [40950616489](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40950616489), Node 20, **364/365 V3** and **81/81 PTT**. One pre-existing `phase4Pipeline.test.js` CREATE_CALL verification fixture failure is still visible, not passed or suppressed. All 14 new 01-03 tests passed; R02/R03/R04/R10 now assert scoped repairs alongside R06/R07. No full operation timeout, cancellation, output scheduler or release acceptance is claimed.

Prior 01-02 implementation `7e9fcdb1982967771e3264328ce9554a8896b48e`, 03-01 implementation `db111bb7888e0dcb15e1715b4259568cae6b8910`, and their original evidence remain valid and unaltered. 01-03 evidence is `docs/dispatcher-v3/01-03-per-unit-scheduling-20261029.md` and `docs/dispatcher-v3/validation/01-03-results.json`. This documentation update follows tested source and contains no executable changes.

Main advanced independently to `fd88b6076dd66f3badada8509ceb287f13c4ab37` through PRs #164/#165; the draft PR #163 remains **unmerged and unmergeable** due to overlapping signaling/PTT changes. Integration with newer main and production remains unverified; no merge/rebase/deploy/restart, production-data changes or paid provider calls are authorized or performed. Real audio/radio/mobile validation and the original live scenario remain unverified.

Next: **01-04 complete external operation deadlines**. Counts: 01=3/8; 02=0/8; 03=1/8; 04=0/8, **4/32 total**. G-01 through G-04 remain unchecked. Preserve all four parent tasks, 32 item IDs, 64 original acceptance/deliverable paragraphs, trusted identity, 03-01 containment, CAD scopes/verification and hardware emergency controls.
