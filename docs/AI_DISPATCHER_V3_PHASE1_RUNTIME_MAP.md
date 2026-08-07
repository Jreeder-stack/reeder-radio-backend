# AI Dispatcher V3 — Phase 1 Runtime and Shutdown Map

## Purpose

The current AI dispatcher is not an operational dependency and will not be used as the foundation for V3. This document identifies the exact runtime boundary of the existing system so V3 can replace it without duplicating listeners, breaking radio transport, or carrying forward command-state assumptions.

The existing implementation remains reference material only until V3 is ready to become the sole runtime.

## Current startup path

1. `src/server.js` initializes the database, HTTP server, audio relay, signaling service, WebSocket audio bridge, channel mappings, and recording tap.
2. `src/server.js` calls `aiDispatcherRuntimeManager.initialize()`.
3. `src/services/aiDispatcherRuntimeManager.js` loads all rows from `ai_dispatcher_profiles`.
4. Each enabled profile is started through `startProfile(profile.id)`.
5. `startProfile()` constructs an immutable runtime context containing the profile, radio channel, dispatch center, CAD URL/API key, and unique AI identity.
6. A CAD preflight verifies the assigned dispatch center, required scopes, and active-call read path.
7. The manager constructs `AIDispatcher` from `src/services/aiDispatchService.js` and calls `dispatcher.start(...)`.
8. The manager constructs `AIDispatcherSignaling` and subscribes that runtime to PTT start, PTT end, emergency start, and emergency end events.
9. The runtime is stored in `aiDispatcherRuntimeManager.runtimes` until stopped, restarted, updated, deleted, or the server shuts down.

## Existing runtime ownership

### `src/server.js`

Responsibilities:

- Starts shared HTTP, signaling, audio relay, WebSocket audio, and recording infrastructure.
- Initializes all configured AI dispatcher profiles.
- Stops all AI dispatcher runtimes during graceful shutdown.

V3 decision: **KEEP** the shared server startup and shutdown structure. Replace only the runtime implementation selected by the manager.

### `src/services/aiDispatcherRuntimeManager.js`

Responsibilities:

- Owns `ai_dispatcher_profiles` persistence and migration.
- Assigns each profile to one radio channel and one Command Link dispatch center.
- Creates the per-profile runtime context.
- Runs Command Link preflight checks.
- Creates, starts, stops, restarts, and reports runtime status.
- Registers and unregisters four signaling subscriptions per runtime.

V3 decision: **KEEP AND REFACTOR**. Preserve profile administration, center/channel assignment, immutable runtime context, preflight, lifecycle ownership, and subscription cleanup. Replace the concrete `AIDispatcher` construction with the V3 runtime factory.

### `src/services/aiDispatcherSignaling.js`

Responsibilities:

- Filters PTT and emergency events by the active runtime channel.
- Ignores the AI runtime's own radio identity.
- Sends `PTT_READY` acknowledgements.
- Flushes the active unit recording at PTT end.
- Starts and clears emergency escalation.

V3 decision: **KEEP THE TRANSPORT ROLE, REWRITE THE CONTRACT**. The adapter should forward normalized radio events into V3. It must not own dispatcher business logic or direct emergency workflow behavior.

### `src/services/aiDispatchService.js`

Current responsibilities include:

- Audio listener registration and health repair.
- Opus frame handling and decoding.
- Per-unit audio recording and buffering.
- Audio resampling.
- Azure speech-to-text.
- Wake-word and identity gates.
- Hard-coded phrase matching through `commandMatcher.js`.
- LLM classification through `llmIntentService.js`.
- Conversation and prompt state.
- Command-specific data extraction.
- CAD reads and writes.
- Status-check workflows.
- Emergency and backup workflows.
- Address normalization and geocoding behavior.
- Response composition and canned templates.
- Azure text-to-speech.
- Floor control and outbound audio publication.
- Speech logging, runtime counters, retries, and reconnect behavior.

V3 decision: **REPLACE COMPLETELY**. This class is the primary legacy boundary. V3 must not import it, extend it, wrap its command processing, or use it as a base class.

### `src/services/commandMatcher.js`

Responsibilities:

- Hard-coded command and phrase matching.
- Dispatcher conversation states and unit session state.
- Prompt ownership and timeout management.
- Emergency, confirmation, welfare, and floor-handoff phrase matching.

V3 decision: **REFERENCE ONLY, THEN REMOVE FROM STARTUP**. V3 may use this file to identify historical behaviors that should become explicit action contracts, but V3 must not depend on its state machine.

### `src/services/llmIntentService.js`

Responsibilities:

- Intent classification and LLM-generated responses.
- Natural response composition and query answering.
- Legacy behavior fallback remains in `llmIntentService.legacy.js`.

V3 decision: **DO NOT USE AS THE V3 ORCHESTRATOR**. Useful provider/client code may be extracted later, but the current intent schema and fallback behavior are part of the legacy command system.

### `src/services/cadService.js`

Responsibilities:

- Builds authenticated Command Link requests.
- Attaches dispatch-center and agency context.
- Implements calls, assignments, notes, dispositions, unit statuses, queries, status checks, integration preflight, and retry behavior.

V3 decision: **AUDIT AND REPLACE WITH A NARROW GATEWAY**. V3 should use typed action methods rather than importing the full legacy CAD helper surface. Existing methods are reference material until Command Link contracts are mapped in Phase 2.

### Shared radio/audio infrastructure

Likely reusable components:

- `src/services/signalingService.js`
- `src/services/audioRelayService.js`
- `src/services/wsAudioBridge.js`
- `src/services/recordingTapService.js`
- `src/services/opusCodec.js`
- `src/services/floorControlService.js`
- `src/services/azureSpeechService.js`
- `src/services/runtimeContext.js`

V3 decision: **REUSE BEHIND V3 INTERFACES**. These components provide transport or provider capabilities and should not contain dispatcher policy.

## Live inbound path

```text
Radio/mobile client PTT
  -> signalingService PTT events
  -> aiDispatcherRuntimeManager profile-scoped subscriptions
  -> AIDispatcherSignaling channel filter
  -> audioRelayService listener registered by AIDispatcher.start()
  -> AIDispatcher._onAudioFrame()
  -> Opus decode and per-unit recording buffer
  -> PTT end calls flushRecordingForUnit(unitId)
  -> resample audio
  -> Azure speechToText()
  -> wake/identity checks
  -> commandMatcher and/or LLM classifyIntent()
  -> command-specific handler inside aiDispatchService.js
  -> cadService and other helpers
  -> response text
  -> Azure textToSpeech()
  -> floor control
  -> audioRelayService.injectAudio()
  -> radio channel
```

## Current outbound path

The legacy class synthesizes text with Azure TTS, sends AI playback signaling messages, requests/observes floor control, encodes audio into Opus frames, and injects those frames into the active channel through `audioRelayService.injectAudio()`.

V3 should preserve the transport behavior but expose it through one response-output interface. Action handlers must never publish radio audio directly.

## Current stop and restart path

A profile stop performs the following:

1. Calls every unsubscribe function stored for the runtime's PTT/emergency subscriptions.
2. Runs `runtime.dispatcher.stop()` inside the profile runtime context.
3. Removes the runtime from `aiDispatcherRuntimeManager.runtimes`.
4. Persists the stopped timestamp and optionally disables the profile.

Server shutdown calls `aiDispatcherRuntimeManager.shutdown()`, which stops all active profiles before stopping signaling, WebSocket audio, the audio relay, HTTP, and the database pool.

V3 must maintain this ownership model so there is exactly one subscriber and one audio listener set per enabled profile.

## Duplicate-processing hazards to eliminate

Before V3 is selected at startup, verify:

- The manager constructs either legacy or V3, never both.
- No singleton `aiDispatcherSignaling` instance is also initialized outside the manager.
- V3 uses the profile's unique `identity` for all audio listener registration.
- Updating or restarting a profile unsubscribes all event handlers and removes all audio listeners.
- Health checks cannot restore listeners belonging to a stopped runtime.
- One incoming transmission cannot reach two runtimes assigned to different centers or channels.
- The hourly time broadcaster cannot invoke legacy dispatcher methods after V3 activation.

## V3 replacement seam

The manager should eventually depend on a runtime interface rather than `AIDispatcher` directly:

```text
createDispatcherRuntime(context, dependencies) -> runtime

runtime.start()
runtime.stop()
runtime.getStatus()
runtime.matchesChannel(channelId)
runtime.handlePttStart(event)
runtime.handlePttEnd(event)
runtime.handleEmergencyStart(event)
runtime.handleEmergencyEnd(event)
runtime.handleAudioFrame(event)
```

The V3 runtime will own orchestration. Audio transport, STT, Command Link actions, TTS, and radio publication will be injected as narrow dependencies.

## Phase 1 keep/replace matrix

| Component | Decision | Reason |
|---|---|---|
| Server startup/shutdown | Keep | Correct shared infrastructure lifecycle |
| AI profile database/admin | Keep | Already supports multiple profile assignments |
| Runtime context | Keep and harden | Correct place for immutable center/channel identity |
| Runtime manager | Refactor | Good lifecycle owner; currently constructs legacy class directly |
| Signaling adapter | Refactor | Useful channel/event boundary; contains workflow behavior |
| Audio relay | Keep | Shared radio transport |
| Opus codec | Keep | Transport codec |
| Azure STT/TTS provider | Keep behind interfaces | Provider capability, not dispatcher policy |
| Legacy `AIDispatcher` | Replace | Monolith containing all layers and business logic |
| `commandMatcher` state machine | Replace | Hard-coded command/state foundation |
| Current LLM intent orchestrator | Replace | Coupled to legacy state and response model |
| Legacy CAD helper surface | Audit then narrow | Too broad and mixes contracts with compatibility behavior |
| Command-specific tests | Mine for requirements | Useful behavioral history, not architectural tests |

## Phase 1 completion criteria

Phase 1 is complete when:

- The current startup, inbound, outbound, and shutdown paths are documented.
- The legacy replacement boundary is explicitly identified.
- Shared components that may be reused are separated from policy components that must be replaced.
- The duplicate-listener hazards are recorded.
- No legacy command behavior has been modified.
- No runtime switch has been made yet.

## Next phase

Phase 2 maps the authoritative Command Link contracts and status/call lifecycle rules across both repositories. The output must define the exact typed operations V3 is allowed to execute before implementation begins.
