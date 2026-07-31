# AI Dispatcher V2

## Scope

This rebuild changes only the AI decision layer between speech-to-text and the existing dispatcher/CAD handlers.

It does not change:

- radio audio capture
- PTT or floor control
- channel selection
- audio relay or LiveKit/signaling behavior
- text-to-speech
- radio transmit timing
- emergency-button data messages

## Rollout flag

V2 is opt-in:

```env
AI_DISPATCHER_V2_ENABLED=true
```

When the flag is absent or false, `llmIntentService.legacy.js` preserves the existing classifier and semantic-recovery behavior.

Optional settings:

```env
AI_DISPATCHER_V2_MIN_CONFIDENCE=0.82
AI_DISPATCHER_V2_TIMEOUT_MS=4500
```

## Initial V2 capabilities

The first slice intentionally supports only routine actions:

- no action / silence
- clarification
- radio check
- time check
- unit status change
- create a call
- attach the speaking unit to a call
- add a call note
- run a plate
- read the speaking unit's current call
- read details for a specified call
- clear the speaking unit from a call
- close a call
- repeat dispatch
- disregard the speaking unit's pending request

The planner cannot dispatch a wrecker, EMS, fire, K9, supervisor, or other outside resource. Unsupported actions are rejected instead of producing a false success acknowledgment.

## Emergency separation

Explicit officer-down, shots-fired, 10-33, emergency-traffic, and Signal 100 phrases are excluded from the routine V2 planner. Existing protected emergency handling remains upstream.

## Current migration boundary

V2 currently replaces routine intent classification only for `IDLE` and `AWAITING_COMMAND`. Existing multi-step follow-up states and CAD executors remain in place so the new brain can be tested without changing radio transport or rewriting every CAD handler at once.

The next migration step is to replace the legacy intent-to-handler switch with direct validated dispatcher tools, then remove unused scripted states after each replacement is covered by tests.
