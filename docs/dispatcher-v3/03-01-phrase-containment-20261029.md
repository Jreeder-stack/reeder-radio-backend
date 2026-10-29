# AI dispatcher 03-01: unsafe phrase-match containment

Plan: AI-DISP-V3-001. Work item: 03-01. Date: October 29, 2026.

**03-01 coding and scoped mocked validation are complete. This is not release or live-operation acceptance.** Implementation commit: `db111bb7888e0dcb15e1715b4259568cae6b8910`. Implementation tree: `a5e8f40701bc8207867161794104afbf0b1fdd7e`. Branch and draft PR #163 are unchanged; no merge or deployment is authorized.

## Root cause and affected path

The actual PTT path enters speech capture, the conversation gate, `V3IntentPlanner`, materialization, the executor and CAD verification. `planNamedUnitStatus` previously searched for a roster callsign and a status substring anywhere in the sentence, then returned confidence 1 before semantic interpretation. Consequently, a question or prohibition could reach correctly authorized and verified execution with the wrong meaning. `mark B2 not available` selected available; even a callsign containing AVAILABLE could supply the status keyword.

The same source file also captured unconstrained call types, locations and call references. A second instruction became part of a location, and `on my screen` could be misread as a new call location. Unanchored urgent-event keywords treated a denial or question as a field report. Speaker-prefix normalization changed the remainder of a sentence, including apostrophes and number-word content.

The trace also identified status-clearing and responder-assignment shortcuts before the ordinary planner in the active hardware-emergency path. Unanchored safe/response matching could treat `not all good` as safe or `not responding` as a responder. Those two shortcuts now require complete replies; hardware activation, distress escalation, timers and explicit operator clearing retain their existing policy.

## Implemented behavior

- Named status fast paths require a complete imperative, one unambiguous roster callsign and a complete status complement. `not_available` remains a supported positive command. Unknown or ambiguous targets go to semantic interpretation; they do not become the speaker.
- Questions, conditions, history, quotations, additional clauses and malformed fused commands cannot satisfy those fast paths. This is complete-command matching, not a negation exception list.
- Open-ended CREATE_CALL, self-initiated call and named-call-reference shortcuts were removed. The existing Azure semantic planner receives the intact transmission. No model or provider was replaced, and no arbitrary endpoint was introduced.
- Short complete urgent reports retain their fast path. Richer field reports use semantic interpretation. Addressed urgent reports normalize only their configured leading dispatcher address; they keep their urgent addressing exemption and cannot activate hardware emergency through voice.
- Prefix matching recognizes the transmitting unit without rewriting the rest of the sentence. Semantic inputs retain the original sentence supplied to the planner.
- Active hardware-emergency safe and responder replies use complete-sentence matches after only configured dispatcher/own-callsign prefixes. Unsafe replies leave the hardware state and next status-check timer intact; exact legitimate safe/responder replies and explicit hardware/manual clearing still work.
- Model failure, malformed output and the existing model timeout produce no fallback phrase mutation. Existing action scopes, authoritative target resolution and read-back verification remain enforced.

## Validation and evidence

Permanent machine-readable evidence: `validation/03-01-results.json`.

Environment: Node **v20.20.2**, Linux x64, unchanged package lockfile. The exact Node distribution was SHA-256 checked against its published checksum. Tests use synthetic speech/model/CAD/radio boundaries; no paid provider, production write, physical radio transmission or deployment occurred.

```sh
DISPATCHER_AUDIT_MODE=baseline \
DISPATCHER_AUDIT_REPORT=/tmp/dispatcher-03-01-audit-final.json \
npm run test:v3 -- --silent --reporter=json \
  --outputFile=/tmp/dispatcher-03-01-full-final.json
```

| Scope | Passed | Failed |
| --- | ---: | ---: |
| New ordinary phrase-containment tests | 63 | 0 |
| New active-emergency reply-containment tests | 22 | 0 |
| Audit regressions and healthy controls | 26 | 0 |
| Complete V3 suite, 32 files | 318 | 1 |

The full command exits nonzero. Its sole failing assertion is the unchanged CREATE_CALL success fixture without verification evidence in `phase4Pipeline.test.js`. The production composer continues to refuse an unverified success acknowledgment. That assertion was not deleted, skipped or relaxed. The two other original failures, compound CREATE_CALL matching and current-screen en-route interpretation, pass after removal of the underlying broad shortcuts.

R06 now always asserts semantic routing, zero contrary status writes and successful status-question read handling. R07 always asserts both requested operations, the clean address, actual synthetic writes and verification. Neither case can return to a passing baseline-defect assertion, even when `DISPATCHER_AUDIT_MODE=baseline`. The other twelve audit defects remain baseline reproductions; 03-03 and 03-08 are not complete because one compound example passes.

Existing positive free-form intent tests now exercise semantic routing with explicit mock model replies and preserve their action/target assertions. Separate actual-runtime tests execute and verify the resulting writes. These tests prove routing and execution contracts, not real model language accuracy.

All 11 changed JavaScript files passed syntax checks; `git diff --check` passed; removed legacy-engine files remain absent. The tested working tree was subsequently committed, and the complete staged tree was verified identical to implementation commit `db111bb7`. The audit report truthfully records the pre-commit base revision together with source blob hashes; it does not pretend the test command ran after the commit existed.

An initial local evidence-export attempt could not spawn the reporter's read-only Git revision lookup under the sandbox (`EPERM`). The final supported-runtime invocation with that read permission completed the audit export. The final report has 26/26 audit cases and no audit hook failure. No implementation workaround or reporter bypass was added.

## GitHub CI confirmation

[Run 40887096038](https://github.com/Jreeder-stack/reeder-radio-backend/actions/runs/40887096038), attempt 1, job 123493652604, reproduced the same **318 passed/1 existing failure/319 total** on Node v20.20.2. All 85 new containment tests and 26 audit/control tests passed. Syntax and legacy-engine absence steps passed. The run remains failed; it is not a green-suite or release claim.

GitHub checked out temporary PR test merge `e70085c8e8190a93f2c835763fe2fb824b9857ac`, with the same tree `d3a4c1016662e5b60b2d99d4a56ed5884b3ba9d2` as branch head `c233bc8a12cc51aa8a57265a34e32da5a509ab0a`. This is not a merge into main. Every audited source blob matches implementation `db111bb7`; every test-case outcome matches the local report.

The uploaded artifact was downloaded and independently parsed, not inferred solely from logs. Artifact ID `12901974844`, name `dispatcher-v3-evidence-40887096038-1`, ZIP SHA-256 `d866d67c1615ea680d20b8a7a6ed25dc969d9770503112f12dc27bfe3ca99c55`, 17,305 bytes, retention through November 12, 2026. Essential CI results and the audit report are retained in `validation/03-01-results.json`.

Other automatic PR workflows are not certified by this task: iOS project generation check failed; T320 failed during Android SDK setup before compilation; Android Phone/Bridge was still running at evidence capture. No mobile files were changed or unrelated workflows rerun. The CI-evidence update is documentation only and deliberately does not rerun unchanged code.

## Remaining limits and controlled release

G-01 through G-04 remain unchecked. Full repository/mobile builds, actual speech/model/audio behavior and the production revision are unverified. Twelve audit defects remain, including stale conversation/incident handling, operation ordering, lifetime bounds and truthful partial outcomes. Active-emergency conservative distress interpretation and broader semantic integration remain subject to the later Task 03/04 evaluations; this item does not certify the whole emergency lifecycle.

Open-ended language now depends on the existing configured semantic provider. If that provider is unavailable, the dispatcher reports failure rather than reconstructing an unsafe regex mutation. That compatibility tradeoff is intentional; exact supported fast paths remain usable. Real provider latency/cost and language generalization require the separately authorized pilot.

No schema, transport, codec, firmware, provider, permission model, emergency activation policy or verification boundary was replaced. No deployment/rollback was performed. If later authorized, deploy only the separately approved candidate, record the then-current production revision as rollback target, and run the original PTT scenarios plus positive controls in the designated synthetic center before any operational claim. The historical audited main is not asserted to be the current production rollback revision.

## Next item

01-02 has resumed with a read-only intake/authentication trace recorded in `01-02-intake-trace-20261029.md`. Its implementation and validation remain unchecked. Preserve all four parents and all 32 work-item IDs.
