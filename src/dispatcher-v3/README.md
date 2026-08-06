# AI Dispatcher V3

This directory is the clean replacement boundary for the legacy AI dispatcher implementation.

## Phase 3A scope

Phase 3A intentionally contains no live radio integration and does not alter application startup. It establishes only:

- a stable V3 module boundary;
- normalized fail-closed runtime context validation;
- shared V3 error codes and error results;
- an explicit runtime selector that defaults to the legacy runtime until V3 is deliberately wired in;
- a minimal contract test proving the scaffold can be imported and validated independently.

## Architectural rule

V3 must not import the legacy phrase matcher, V2 planner, legacy dispatcher conversation state, or legacy CAD command behavior. Shared transport/provider infrastructure may be reused only through explicit V3 adapters added in later phases.

## Next steps

- Phase 3B: immutable runtime context and isolation hardening.
- Phase 3C: Command Link gateway.
- Phase 3D: center-scoped immutable unit resolution.
- Phase 3E: action contracts.
- Phase 3F: action executor.
- Phase 3G: structured diagnostics.
- Phase 3H: foundation and isolation test suite.
