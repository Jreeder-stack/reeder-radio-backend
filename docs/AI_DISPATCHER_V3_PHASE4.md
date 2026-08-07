# AI Dispatcher V3 — Phase 4 Live Runtime

Phase 4 connects the Phase 3 safety foundation to the live Command Communications radio path.

## Live pipeline

1. Profile/runtime manager selects one dispatch center and one radio channel.
2. PTT start opens a bounded per-unit audio session.
3. Audio relay frames are decoded to 16 kHz mono PCM.
4. PTT end sends the buffered transmission to Azure Speech-to-Text.
5. The conversation gate processes only:
   - traffic addressed to a configured wake word (`Central`, `Dispatch`, `Dispatcher` by default),
   - protected emergency traffic, or
   - a timed follow-up from a unit that V3 just asked a clarification question.
6. Azure OpenAI maps the transcript to the fixed V3 action contract. Protected emergency phrases bypass the LLM.
7. Spoken unit references are resolved inside the assigned dispatch center and replaced with immutable unit UUIDs.
8. The Phase 3 executor validates scopes/input and performs the Command Link/Command Comms operation.
9. A deterministic response composer creates short radio wording from the verified result.
10. Azure TTS produces PCM; V3 acquires the existing Command Comms AI floor, encodes Opus, injects paced frames, re-arms the floor for long speech, and releases it in `finally`.

## Runtime cutover

V3 is now the default AI dispatcher runtime. An explicit environment override is retained for emergency rollback:

```text
AI_DISPATCHER_RUNTIME=legacy
```

The existing AI dispatcher profile UI/database remains authoritative for profile name, enabled state, channel, dispatch center, identity, and status-check setting. No second configuration system is introduced.

## Startup requirements

An enabled V3 profile fails closed unless all of the following are available:

- assigned dispatch-center UUID;
- assigned radio channel/room key;
- Command Link URL and API key;
- required Command Link scopes from the existing CAD preflight;
- Azure Speech configuration;
- Azure OpenAI configuration.

Phase 4 depends on the strict Command Link V3 unit resolver from Command-Link PR #62 being deployed with the radio backend.

## Safety behavior

- Unrelated radio conversations are ignored.
- Low-confidence operational plans are not executed; V3 asks the unit to repeat.
- The planner cannot invent actions outside the Phase 3 registry.
- Raw callsigns never reach the final action contract; unit identities are materialized to UUIDs first.
- CAD/action failures cannot be spoken as success.
- Backup wording confirms only that the request was sent; it does not claim another unit is responding.
- Voice-declared V3 emergency and backup events use the selected signaling room key and carry dispatch-center/runtime/correlation metadata.
- Hardware-button emergencies are observed by V3 but are not activated a second time.
- Outbound AI speech never preempts routine floor traffic and always releases the floor after transmission/failure.

## Known boundary

The pre-existing native hardware-emergency APNs callback still uses its legacy global fan-out. V3 does not duplicate that callback, and voice-declared V3 emergencies suppress the legacy global push path. A separate center-scoped push refactor is still required for the legacy hardware-emergency notification callback itself.

## Validation

The branch adds a dedicated GitHub Actions workflow (`AI Dispatcher V3 CI`) that runs:

```bash
npm ci
npm run test:v3
```

Phase 4 tests cover speech buffering/STT, protected emergency bypass, wake/follow-up gating, immutable unit materialization, gateway payload unwrapping, safe backup wording, and outbound floor acquisition/release/failure behavior.
