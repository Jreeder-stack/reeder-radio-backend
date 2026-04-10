# Command Communications by Reeder - Systems

## Overview
This project is a Push-to-Talk (PTT) radio communication application for real-time audio streaming between field units and dispatch operations. It aims to enhance operational efficiency and communication reliability through features like a talkgroup system, unit presence tracking, advanced audio processing, emergency signaling, and an AI Voice Dispatcher. The AI Voice Dispatcher provides automated acknowledgments and voice-driven interactions for tasks such as status changes, records checks, traffic stops, and emergency escalations, acting as a robust and intuitive communication platform for critical field operations.

## User Preferences
Not specified.

## System Architecture

### Client Architecture
- **Dispatch Console:** A React/Vite web application, also available as an Electron desktop app (`desktop-app/`) for global PTT hotkeys.
- **Radio Client (Field Units / T320):** A native Kotlin Android app (`android-native/`) utilizing custom UDP radio transport with Opus encoding and native PTT hardware key handling.

### UI/UX Decisions
The dispatch console is a PWA with responsive design, featuring auto-login, dark/light themes, and a Dispatcher Console built with React, TailwindCSS v4, and `dnd-kit`. The native Android app uses Jetpack Compose with a dark cyan theme.

### Technical Implementations
- **Frontend:** React/Vite with Zustand for state management. Audio connections utilize WebSockets with end-to-end Opus or PCM encoding.
- **Backend:** An Express.js server providing API endpoints for authentication, user/channel management, and dispatch services, backed by PostgreSQL.
- **Audio System:** End-to-end Opus passthrough from T320/native clients to web browsers. Binary WebSocket frames use a codec marker byte: `0x01` = PCM (legacy), `0x02` = Opus passthrough. Server relays raw Opus packets to web clients without decoding/re-encoding (~100-200 bytes/frame vs ~2KB PCM). Browser-side Opus decoding uses the `opus-decoder` WASM package (Float32 output converted to Int16 for playback worklet). Browser TX uses WebCodecs `AudioEncoder` for Opus encoding when available, with PCM fallback for older browsers. Client-side packet loss concealment (PLC) is handled by the browser's Opus decoder (fed empty frames on sequence gaps). Reorder buffer operates on opaque payloads (opus bytes or PCM samples), decoding only after reordering. AI dispatcher and recording tap are unaffected — they receive raw Opus via `addAudioListener`/`onRecordingTap` and decode server-side independently. Server pacing queue is 75 frames (~1500ms) with console.warn on drops. UDP subscriber timeout is 60 seconds. Server-side TX activity watchdog emits `tx:silence_warning` after 2s of silence from a floor holder. Browser reorder buffer is 20 frames with 90ms flush timer, PLC max consecutive is 7, and playback worklet pre-buffer is 22 frames (~440ms) with quadratic fade underrun handling (10 steps). Android TX heartbeat monitors send gaps >1s and triggers error tone + `onTxStall` callback. Android clients use UDP with Opus encoding (complexity 5, CBR mode, FEC enabled). The Android TX path detects the HAL-negotiated sample rate (e.g. 16 kHz on T320) and adapts the Opus encoder, DSP filters, and buffer sizes accordingly, including automatic stereo-to-mono downmix when HAL returns 2 channels despite requesting mono. RX/decoder path remains at 48 kHz. The Opus encoder persists across TX sessions (reused if sample rate/channels unchanged) to avoid cold-start instability. On encoder assertion failures, a graduated recovery strategy applies: individual failures trigger encoder re-init, 3 consecutive failures trigger a 5-frame backoff, and 10+ total failures trip the permanent circuit breaker. All encoder failures produce PCM fallback frames (prefixed with `0x01` codec marker) instead of dropping audio. Channel keys are normalized to compound format (zone__name) from the DB to prevent cross-channel audio bleed caused by key fragmentation (numeric ID vs compound key). The audio relay's `registerChannelNumeric` migrates subscribers when channel keys are remapped.
- **Real-time Communication:** WebSockets for audio streaming; Socket.IO v4.x server for signaling (presence, PTT floor control, data messages, emergency, location). Server configured with `allowEIO3: true` for backward compatibility with Android Socket.IO Java client v2.1.0 (EIO=3 protocol).
- **Audio Processing:** Incorporates Web Audio API DSP for AGC, noise suppression, transmit compression, PTT release reliability, and feedback loop prevention.
- **Authentication & Authorization:** Username/password authentication with bcrypt, session management, and role-based access control. CAD integration uses an API key (`CAD_INTEGRATION_KEY`) stored as a Replit Secret for trusted server-to-server authentication. The key is a 32-byte hex string provided via `x-radio-api-key` header or `apiKey` body field.
- **CAD-to-Radio PTT Integration:** External CAD systems can authenticate users via `POST /api/auth/cad-login` (API key + username, no password), verify users via `POST /api/cad-integration/verify-user`, and fetch zones/channels via `GET /api/cad-integration/zones` and `/channels`. An embeddable JavaScript client (`/api/radio-client.js`) provides PTT functionality for CAD pages.
- **AI Voice Dispatcher:** Integrates Azure Speech Services (STT/TTS) and Azure OpenAI (GPT-4o-mini) for natural language processing, enabling voice commands for various operational tasks and contextual conversations. It supports a two-tier response system for routine and complex interactions. Features include: assign/attach units to calls by number or description, add call notes by voice, query pending calls with follow-up questions, check current assignment, auto-broadcast new BOLOs via polling, person search by name+DOB (single-transmission parsing supported), driver's license/ID number + state, and SSN. Common STT misrecognitions of "radio check" (e.g., "radio shack") are handled.
- **Radio Diagnostic Logging:** Comprehensive diagnostic logging across the entire Android radio TX/RX pipeline (see `RadioDiagLog.kt`). Uses 12 structured log tags (`PTT-DIAG`, `RadioState`, `FloorCtrl`, `RadioSigGW`, `AudioCapture`, `AudioDSP`, `OpusCodec`, `UdpTransport`, `JitterBuf`, `AudioPlay`, `RadioEngine`, `RadioError`) with rate-limited frame logging (first N detail, then 1-second summaries) and TX/RX session end summaries. Filter via: `adb logcat | grep -E "PTT-DIAG|RadioState|FloorCtrl|RadioSigGW|AudioCapture|AudioDSP|OpusCodec|UdpTransport|JitterBuf|AudioPlay|RadioEngine|RadioError"`.
- **T320 Screen-Off PTT:** Native Android service-level PTT functionality, independent of the main activity, ensuring consistent operation.
- **On-Demand GPS Tracking:** Activates GPS streaming only when necessary (emergency or dispatcher request).
- **Global Emergency Alerts:** `GlobalEmergencyOverlay` component ensures emergency alarms are displayed and acknowledged across the application.
- **Monitor-Only Audio Connections:** Dispatch Console can monitor channels via Socket.IO without immediately consuming audio resources.
- **Cost Optimization:** On-demand audio connection activation and idle timeouts to optimize resource usage.

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk.
- **Talkgroup System:** Channels organized into zones with switching and scan capabilities.
- **Unit Presence:** Real-time unit status tracking via Socket.IO.
- **Emergency Button (E-Button):** Activates transmit lock, broadcasts emergency flag, and supports acknowledgment.
- **AI-Powered Emergency Escalation:** AI Dispatcher automatically initiates status checks and escalates emergencies.
- **Dispatcher Console:** Multi-channel monitoring, unit management, audio controls, last transmission recall, emergency acknowledgment, channel patching, multi-channel TX, and tone broadcasting.
- **Dispatcher Map:** Real-time unit location display using Leaflet with OpenStreetMap.
- **Channel Chat:** Text and playable voice messages with transcription in the Dispatcher Console.
- **Admin System:** User/channel management, role assignment, activity logging, and real-time audio tuning.
- **Audio Export System:** Exports channel audio messages within a specified date range as a ZIP file.
- **Recording Logs (Admin):** Review, playback, and export radio transmissions with filtering options and PDF/ZIP export. Audio data is persisted in the PostgreSQL database (`audio_data BYTEA` column on `channel_messages`) so recordings survive server restarts and deploys. On startup, any WAV files on disk are migrated into the database. The frontend gracefully handles missing audio (disabled Play/Download buttons with "Unavailable" label) and 0-second recordings.
- **Clear Air:** Dispatcher-activated mode for emergency traffic, forcing units onto a channel with a prominent visual alert.

## External Dependencies
- **opusscript:** Opus audio codec (server-side encoding/decoding for AI dispatcher, recording tap, and PCM fallback).
- **opus-decoder:** WASM Opus decoder for browser-side audio playback (client-side Opus-to-PCM decoding).
- **PostgreSQL:** Primary database.
- **Azure Speech Services:** STT/TTS for AI Voice Dispatcher.
- **Azure OpenAI (GPT-4o-mini):** Natural language intent classification for AI Voice Dispatcher.
- **`dnd-kit`:** Drag-and-drop functionality.
- **`bcrypt`:** Password hashing.
- **`connect-pg-simple`:** PostgreSQL-backed session management.
- **TailwindCSS v4:** Frontend styling.
- **Zustand:** Frontend state management.
- **Leaflet/react-leaflet:** Mapping components.
- **`archiver`:** ZIP file creation.