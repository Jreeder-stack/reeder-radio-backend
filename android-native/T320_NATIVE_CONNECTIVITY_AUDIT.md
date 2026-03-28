# T320 Native Connectivity Audit (Backend + Service/PTT + Audio)

Status date: 2026-03-28
Priority: native Android app on T320.

Hard constraint observed in this change:
- Hardware button mappings were preserved exactly (no keycode or action mapping edits).

## 1) Exact current native/backend mismatches

1. **Background service channel join used generic signaling join instead of radio join**
   - Previous behavior joined via `channel:join`, not `radio:joinChannel`.
   - Effect: bypasses radio join path semantics and does not mark the socket as radio-client in backend radio flow.

2. **No explicit UDP port advertised during radio channel join**
   - Backend radio join supports `udpPort` for subscriber registration.
   - Without this, receiver registration can be delayed until first outbound UDP packet from that unit.

3. **Mixed signaling paths in native app**
   - UI view model still uses generic channel presence events (`channel:join`, `ptt:start`, `ptt:end`) for UI state.
   - Background radio audio path should use radio events (`radio:joinChannel`, `ptt:request`, `ptt:granted/denied`, `tx:start/stop`).

## 2) Exact T320 service/PTT reliability failure points

1. **RX readiness race for non-transmitting listener units**
   - If a unit never TXes first, backend subscriber mapping may not be established early enough for immediate RX.

2. **Foreground service is responsible for continuous radio behavior across app lifecycle**
   - Any signaling desync in service channel join can break screen-off/background receive behavior even when key mapping is correct.

3. **Radio channel sync must leave/join in radio namespace**
   - Leaving/joining wrong event namespace causes stale or missing radio-channel state in backend floor-control path.

## 3) Exact audio-format mismatch points

1. Browser/desktop path remains PCM-over-WS while native/server path is Opus-over-UDP.
2. Packet metadata differs by path (senderUnitId/timestamp availability inconsistent).
3. Bitrate defaults differ between Android and server Opus implementations.

## 4) Smallest clean rebuild sequence

1. Fix native connectivity first (radio join + UDP subscriber registration) — done in this change.
2. Validate T320 login/session/auth/join/floor grant/deny on real device.
3. Validate T320 screen-on/off/background PTT service reliability on real device.
4. Then align native/server packet format contract fields (senderUnitId/timestamp/version/flags).
5. Then migrate browser path to same Opus transport and delete PCM transport assumptions.

## 5) First implementation step to make native app connect successfully

Implemented now:
- BackgroundAudioService channel sync switched to radio signaling join/leave.
- Radio channel join now sends UDP local port when available.
- Signaling repository/client updated to support radio join with optional udpPort.

## 6) Next step to get T320 TX/RX working

1. Deploy this build to two T320 units.
2. Verify sequence:
   - login/session persistence
   - signaling authenticated
   - radio join acknowledged
   - floor request/grant/deny
   - RX without requiring the receiving unit to TX first
   - TX stop/release behavior
3. Capture logs around:
   - `BackgroundAudioService.syncBackgroundSignalingChannel`
   - `SignalingClient.emitRadioJoinChannel`
   - backend `_handleRadioJoinChannel` + `_handlePttRequest`

If RX-before-first-TX still fails after this, next minimal fix should be a periodic radio subscriber heartbeat from service (without touching hardware mapping).
