# AI-DISP-V3-001 / 04-08: Acceptance runner and operational runbook

**Scope:** Original item 04-08, Command Communications V3, branch test/dispatcher-v3-01-01-baseline-20261028, PR #163 draft/unmerged. The runner does not authorize deployment, real radios, paid model calls or a new engine.

## Safe local / CI validation

Use Node 20 and the committed dependency lockfile. Run from the repository root:

~~~powershell
npm ci
node scripts/dispatcher-v3-acceptance.mjs --synthetic
~~~

The script uses the real V3 runtime exercised by mocked, authenticated PTT and synthetic CAD/provider boundaries. It strips provider credentials, accepts only --synthetic, and writes:

1. reports/dispatcher-v3-synthetic-tests.json: machine-readable Vitest assertions.
2. reports/dispatcher-v3-synthetic-scenarios.json: test correlation turn IDs, diagnostic phases, CAD writes, and local audio relay injections.
3. reports/dispatcher-v3-synthetic-acceptance.json: candidate revision, outcomes, prior reference, explicitly unmeasured real-provider/radio metrics, and unchecked release gates.

A nonzero exit blocks scoped acceptance. Full V3, 14 audit scenarios, PTT tests, manager integration and repository build checks must also be inspected; partial test selection cannot become gate G-01. Record the exact command, Node and Git revisions for every execution.

## Candidate and rollback baseline

Record the **candidate tested SHA**, build environment, active configuration, and the prior **actually deployed** revision before an approved pilot. The last previously scoped-validated V3 executable 45a50a26f5c4580e9f40442a93a84c24ba54544a is a historical code comparison, **not** necessarily the deployed rollback version. Do not rebase, merge or deploy on the strength of synthetic tests alone.

## G-02: actual provider and CAD qualification, requires explicit approval

Before running any real model, STT/TTS or CAD evaluation, obtain the owner's separate authorization, an agreed cost cap, scoped test credentials, isolated center and fictional data. Separate acoustic transcription accuracy from planning accuracy, target resolution, CAD authorization and spoken accuracy. Test ambiguous names/registrations, provider timeouts, denied access, rejected writes, a timeout after submission, independent read-back and refusal to blindly replay an uncertain call create or note. Record unsupported capabilities, not invented success.

## G-03: real five-unit radio evaluation, requires separate approval

Use five independently credentialed radios A1, B2, C3, D4 and E5. Exercise simultaneous and interleaved conversations, shared calls, ambiguous references, fragmented replies, cancellation, corrections, changed calls, channel transitions, revoked grants, center aliases and overlapping callsigns. Include real ambient noise and clipped speech without tuning new phrase patches to the held-out 68 standalone cases and 10 multi-turn exchanges. Measure actual end-of-PTT-to-first **audible** response, P50/P95, queue age and per-turn cost. Preapprove performance targets and cost before testing. Local relay injection is not proof an officer heard the reply.

Use supervised physical emergency-button activation only with authorized personnel and controlled conditions. A spoken emergency must never energize the physical emergency state. Confirm emergency traffic preempts routine replies and actual operator takeover works.

## Human stop / takeover and uncertain writes

Existing admin-only POST under the mounted AI dispatcher profiles router, /:id/stop, stops the profile, disallows further AI PTT, invalidates old turns, interrupts queued speech and releases the floor. The admin-only GET /:id/handoff returns a **redacted in-memory snapshot** of submitted/unknown CAD writes, output failures and physical-emergency presence as seen immediately before stop. Actual mount prefix depends on the application's existing router registration. Neither endpoint verifies reconciliation, notifies a person, or reverses already submitted writes.

Human dispatch must review authoritative CAD records for each uncertain write, continue emergency handling and manage the physical alert independently. The AI does not issue endEmergencyForUnit on stop. A process restart loses in-memory handoff entries, so operators must capture the snapshot before restart if needed; durable cross-restart reconciliation is **not** implemented.

## G-04: release, human verification and rollback

Require separately approved merge/deployment and supervised pilot. Record the candidate deployed SHA and previous deployed rollback SHA, verified routing, human mute/stop test and field acknowledgements. On a wrong-unit or cross-center write, stale action, false success, duplicate mutation or interference with an actual emergency, stop the AI, initiate approved rollback, and separately reconcile submitted CAD writes. Code rollback cannot undo CAD mutations.

The original reported cases must be verified end to end by real operators before claiming field acceptance. A passing finite mock suite does not demonstrate infallibility or authorize unsupervised public-safety operation.

**Restrictions preserved:** no V1/V2/V4, model migration, schema, radio transport/codec/firmware rewrite, production changes or paid provider calls. G-01–G-04 remain unchecked until separately evidenced.
