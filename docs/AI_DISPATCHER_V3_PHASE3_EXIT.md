# AI Dispatcher V3 — Phase 3 Exit Criteria

Phase 3 establishes the non-speech operational foundation for AI Dispatcher V3. It does not switch production startup or audio processing to V3.

## Completed foundation

- Isolated V3 module boundary and runtime selector.
- Immutable runtime context with mandatory dispatch-center and radio-channel assignment.
- Scope enforcement and AsyncLocalStorage runtime isolation.
- Correlation ID helpers.
- Single Command Link gateway for authentication, center context, timeouts, normalized errors, and safe read retries.
- Strict center-scoped unit identity service that converts callsigns to immutable unit UUIDs.
- Closed action vocabulary and strict per-action input validation.
- Deterministic action executor and handlers for radio/time checks, unit status, current call, call creation, notes, assignment, clearing, closure, status lookup, backup requests, and emergency declarations.
- Dedicated operational-alert behavior for backup and emergency; no generic-broadcast substitution.
- Structured diagnostic journal with sensitive-field redaction, correlation filtering, bounded retention, and action lifecycle tracing.
- Focused V3 regression suite and `npm run test:v3` command.

## Fail-closed requirements covered by tests

- Missing dispatch center.
- Missing channel.
- Simultaneous independent runtime contexts.
- Missing action scope.
- Malformed planner/action payload.
- Handler/upstream failure does not become success.
- Runtime/correlation trace separation.
- Malformed unit identity response.
- Duplicate/ambiguous unit identity behavior in the dedicated identity tests.
- Emergency collision and signaling-unavailable behavior in operational-alert tests.
- Gateway timeout/rejection behavior in gateway tests.

## Known boundaries carried into Phase 4

1. Existing Command Link radio mutation routes are still callsign-oriented. V3 uses the fail-closed UUID → callsign → UUID verification bridge until Command Link mutations accept immutable unit IDs directly.
2. The legacy global emergency/APNs fan-out is not safe for multi-center V3 and is intentionally not invoked. A dispatch-center-scoped notification path is required before V3 uses push notification fan-out.
3. V3 is not connected to live audio, STT, intent planning, TTS, or runtime startup yet. That is Phase 4 work.
4. Tests are present in the repository, but this chat environment cannot execute Node/Vitest locally. CI or a deployed/local checkout must execute `npm run test:v3` before runtime activation.

## Phase 4 entry condition

Phase 4 may attach transcription/intent/response components only through the V3 action-contract and executor boundaries defined in Phase 3. Speech or LLM code must not call Command Link directly.
