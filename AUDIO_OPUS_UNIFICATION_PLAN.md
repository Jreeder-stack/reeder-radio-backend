# Opus-Only Audio Unification Audit & Rebuild Plan

Status date: 2026-03-28
Decision: single end-to-end codec path is **Opus-only** (no long-term PCM transport).

## Scope audited
- Browser/Desktop TX
- Browser/Desktop RX
- Android Native TX
- Android Native RX
- Server relay

## 1) Exact current mismatches

### A. Browser/Desktop path is still PCM-over-WebSocket
- `client/src/audio/AudioTransportManager.js` transmits and receives JSON PCM packets via `/api/audio-ws`.
- `client/src/audio/PcmPacket.js` hardcodes `codec: 'pcm'` and array payload samples.
- `client/src/audio/PcmCaptureEngine.js` captures PCM and emits Int16 frames.
- `client/src/audio/PcmPlaybackEngine.js` plays Int16 PCM frames.
- `src/services/wsAudioBridge.js` validates only PCM packet shape (`codec: 'pcm'`) and relays JSON payloads.

**Mismatch:** browser/desktop transport is PCM+JSON over WS while Android/server radio path is Opus over UDP.

### B. Server runs two audio assumptions simultaneously
- `src/services/audioRelayService.js` handles Opus payload relay over UDP with tokenized framing.
- `src/services/wsAudioBridge.js` simultaneously maintains a PCM-only websocket bridge.
- `src/server.js` boots both services at startup.

**Mismatch:** mixed transport contracts in production runtime.

### C. Packet metadata is inconsistent across paths
- UDP relay payload to clients currently includes `channelId(2) + sequence(2) + opusPayload` (no senderUnitId/timestamp in UDP frame).
- Browser WS packets include `senderUnitId` in JSON object relayed by ws bridge.

**Mismatch:** self-suppression and diagnostics rely on different metadata availability by client type.

### D. Bitrate defaults are inconsistent
- Android native Opus codec uses 64 kbps (`OpusCodec.BITRATE = 64000`).
- Server `opusCodec.js` sets encoder bitrate to 48 kbps.

**Mismatch:** unnecessary bandwidth spread and non-uniform quality/latency behavior.

## 2) Single interoperable transport spec (all clients + server)

## Audio encoding contract
- codec: **Opus**
- channels: **mono (1)**
- sample rate: **48000 Hz**
- frame duration: **20 ms**
- frame size: **960 samples**
- Opus application: **VOIP**

## UDP packet format (v1)
All clients and server use one binary packet envelope:

| Field | Size | Type | Notes |
|---|---:|---|---|
| version | 1 byte | uint8 | `0x01` |
| flags | 1 byte | bitmask | bit0=FEC present, bit1=DTX frame, others reserved |
| sequence | 2 bytes | uint16 BE | wraps at 65535 |
| timestampMs | 4 bytes | uint32 BE | sender monotonic ms modulo 2^32 |
| channelId | 4 bytes | uint32 BE | canonical numeric channel id |
| senderUnitIdLen | 1 byte | uint8 | length of UTF-8 senderUnitId |
| senderUnitId | N bytes | utf8 | unit identifier |
| opusPayloadLen | 2 bytes | uint16 BE | encoded Opus bytes |
| opusPayload | M bytes | bytes | single Opus 20 ms frame |

**Rules**
- One packet carries exactly one 20 ms Opus frame.
- Receiver ignores unknown higher `version`.
- SenderUnitId required for no-self-monitor enforcement on every client.
- No PCM payload field exists in this spec.

## 3) Initial bitrate recommendation (public-safety voice, low data usage)

Recommended baseline:
- **16 kbps CBR/VBR constrained** for baseline deployment.
- Keep Opus VOIP mode + mono + 20 ms frames.

Why:
- Usually intelligible for narrowband field speech while significantly reducing data usage vs 48–64 kbps.
- Leaves room for FEC overhead in weak links while staying bandwidth-efficient.

Operational guardrails:
- If intelligibility is poor in high-noise scenes, raise to **20 kbps**.
- Avoid jumping directly to 48/64 kbps unless field validation proves required.

## 4) FEC + DTX support plan

### Phase 1 (baseline first)
- Enable Opus in-band FEC on all encoders.
- Decoder attempts packet-loss concealment for missing frames.
- Keep DTX disabled until baseline stability is confirmed.

### Phase 2 (after baseline passes)
- Add optional DTX flag in config (default off initially).
- When DTX enabled, mark frame flag bit1 for comfort-noise/silence handling.
- Validate dispatch monitoring expectations before enabling by default.

## 5) Exact files to change first

### First wave (define and enforce one shared transport contract)
1. `src/services/audioRelayService.js`
   - Introduce v1 packet parser/encoder with senderUnitId + timestamp.
   - Remove legacy header assumptions (`16-byte token + 2-byte channel + 2-byte seq`) after migration.
2. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/radio/UdpAudioTransport.kt`
   - Implement v1 packet read/write.
   - Include senderUnitId in TX and parse it on RX.
3. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/radio/OpusCodec.kt`
   - Normalize bitrate to baseline target (16 kbps start).
   - Keep VOIP, 48k, mono, 20 ms.

### Second wave (remove PCM transport assumptions)
4. `src/services/wsAudioBridge.js`
   - Replace PCM validation with Opus frame schema or retire endpoint if UDP-only architecture is selected.
5. `client/src/audio/PcmPacket.js`
   - Replace with Opus packet model (`OpusPacket.js`) aligned with v1 contract.
6. `client/src/audio/PcmCaptureEngine.js`
   - Replace with `OpusCaptureEngine` that encodes Opus 20 ms frames.
7. `client/src/audio/PcmPlaybackEngine.js`
   - Replace with `OpusPlaybackEngine` decode+playback path.
8. `client/src/audio/AudioTransportManager.js`
   - Remove PCM JSON assumptions and move to Opus packet send/receive.
9. `src/server.js`
   - Stop attaching legacy PCM ws bridge once Opus web path is active.

## 6) Smallest clean rebuild sequence

1. **Lock spec first**
   - Add a single source-of-truth spec file and test vectors for packet v1.
2. **Server relay first**
   - Implement v1 parser/serializer in `audioRelayService.js` with backward path disabled in feature branch tests.
3. **Android native align**
   - Update `UdpAudioTransport.kt` to v1 packet + normalize Opus bitrate.
   - Validate native TX/RX/floor on real radios.
4. **Browser/Desktop migrate**
   - Swap PCM engines to Opus engines and update client manager.
   - Update/replace ws bridge to Opus-only shape.
5. **Remove mixed codec code**
   - Delete PCM packet validators and PCM transport-only code paths.
6. **Final interop validation matrix**
   - Android↔Android, Browser↔Browser, Android↔Browser, AI injection↔all.

## 7) Guardrail
- Do **not** add dual codec negotiation unless explicitly approved.
- During migration, temporary compatibility shims are allowed only inside the feature branch and must be removed before final merge.
