# Command Communications by Reeder - Systems

## Overview
This project is a Push-to-Talk (PTT) radio communication application for real-time audio streaming, designed to enhance operational efficiency and communication reliability for field units and dispatch operations. Key capabilities include a talkgroup system, unit presence tracking, advanced audio processing, emergency signaling, and an AI Voice Dispatcher. The AI Voice Dispatcher provides automated acknowledgments and voice-driven interactions for tasks such as status changes, records checks, traffic stops, and emergency escalations, offering a robust and intuitive communication platform for critical field operations.

## User Preferences
- **Audio transport is locked down**: Do not change any audio encoding, decoding, DSP, Opus, WebSocket audio relay, or transport code unless the user specifically requests it.
- **Audio Settings**: Zello-style per-user audio settings accessible from Dispatch Console TopBar ("Audio" button). Settings persist in localStorage and apply in real-time. Controls: Incoming Volume (0-150%), Mic Volume (0-150%), Playback Amplifier (2x boost toggle), Recording Amplifier (2x boost toggle), Noise Suppression toggle.

## System Architecture

### Client Architecture
- **Dispatch Console:** A React/Vite web application, also available as an Electron desktop app for global PTT hotkeys.
- **Radio Client (Field Units / T320):** A native Kotlin Android app utilizing custom UDP radio transport with Opus encoding and native PTT hardware key handling.
- **Radio Client (Siyata SD7):** Same Kotlin codebase, built as a separate APK via the `sd7` Gradle product flavor (`applicationIdSuffix = ".sd7"`). Hardware integration differs from the T320: the SD7 firmware exposes its physical buttons as broadcast intents (Airbus PMR / Kodiak / `android.intent.action.*` namespaces), confirmed via on-device logcat capture. `KEYCODE_F11` (141) is treated as PTT on the T320 build only — on the SD7 build that exact keycode is the SOS button, gated by `BuildConfig.FLAVOR`. SD7 side-button volume keys use a 600 ms hold-timer in `MainActivity` to distinguish short-press (system volume) from long-press (top = scan toggle, bottom = toggle current channel on/off scan list). The SD7 OLED (`Sd7RadioStatusScreen`) renders `ZN:<zone>` / `CH:<channel>` on the top two lines, with a `✓` next to the channel name when it is on the scan list.

  **SD7 button reference:**
  - PTT (side big button) → transmit (broadcast `com.airbus.pmr.action.PTT_START` / `_STOP`)
  - SOS (top button) → emergency (broadcast `android.intent.action.SOS_BUTTON` / `SOS.down` / `.up`, `com.kodiak.intent.action.KEYCODE_SOS`)
  - Channel knob rotate left → previous channel; right → next (broadcast `android.intent.action.CHANNEL.prev` / `.next`, `com.airbus.pmr.action.GROUP_SELECT_PREVIOUS` / `_NEXT`)
  - Channel knob press → cycle unit status (`KEYCODE_F8` aliased to `KeyAction.DpadCenter`)
  - Top side button short → volume up; long-press (~600 ms) → scan on/off
  - Bottom side button short → volume down; long-press (~600 ms) → add/remove current channel from scan list
- **iOS Radio Client:** A native SwiftUI app (`ios-native/`) with login, signaling (Socket.IO), and an Opus-over-UDP audio path that mirrors the Android packet format. Audio is captured by AVAudioEngine at 16 kHz mono, encoded with libopus via the `swift-opus` SwiftPM package, sent through `Network.framework` (NWConnection UDP) to the audio relay, and on RX is sequence-buffered (`JitterBuffer`), Opus-decoded, and played through AVAudioEngine. Floor control wires `ptt:request`/`ptt:granted`/`tx:start`/`tx:stop`/`channel:busy`/`channel:idle`/`ptt:revoked` through `SignalingClient`.

### UI/UX Decisions
The dispatch console is a PWA with responsive design, featuring auto-login, dark/light themes, and built with React, TailwindCSS v4, and `dnd-kit`. The native Android app uses Jetpack Compose with a dark cyan theme.

### Technical Implementations
- **Frontend:** React/Vite with Zustand for state management. Audio connections utilize WebSockets with end-to-end Opus or PCM encoding.
- **Backend:** An Express.js server providing API endpoints for authentication, user/channel management, and dispatch services, backed by PostgreSQL.
- **Audio System:** End-to-end Opus passthrough from native clients to web browsers. Browser-side Opus decoding uses `opus-decoder` WASM, and encoding uses WebCodecs `AudioEncoder` or PCM fallback. Includes client-side packet loss concealment, reorder buffers, and network resilience features (bitrate control, FEC, RTT-based degraded mode).
- **Real-time Communication:** WebSockets for audio streaming; Socket.IO v4.x server for signaling (presence, PTT floor control, data messages, emergency, location).
- **Audio Processing:** Web Audio API DSP for AGC, noise suppression, transmit compression, PTT release reliability, and feedback loop prevention.
- **Authentication & Authorization:** Username/password authentication with bcrypt, session management, and role-based access control. CAD integration uses an API key for trusted server-to-server authentication.
- **Radio Device Auth (T320):** Hardware radios use device-identity-based authentication with permanent Radio IDs and tokens. Each radio has a persistent `device_uuid` stored in the `radios` table, linked to a record in the `devices` table.
- **Persistent Device ID System:** Every connection type (T320 radio, browser CAD, browser dispatch, Electron desktop, Android) gets a UUID stored persistently — localStorage for web, SharedPreferences for Android, `radios.device_uuid` for T320 radios. Floor control uses `socket.floorKey = socket.deviceId` as the lock key. Admin panel includes a Devices tab for managing all registered devices.
- **CAD-to-Radio PTT Integration:** External CAD systems can authenticate, verify users, fetch channels, and utilize an embeddable JavaScript client for PTT functionality.
- **AI Voice Dispatcher:** Integrates Azure Speech Services (STT/TTS) and Azure OpenAI (GPT-4o-mini) for natural language processing, enabling voice commands for operational tasks (e.g., unit assignment, call notes, person/warrant checks, status changes). Includes location awareness and handles common STT misrecognitions.
- **Radio Diagnostic Logging:** Comprehensive diagnostic logging across the Android radio TX/RX pipeline.
- **T320 Screen-Off PTT:** Native Android service-level PTT functionality.
- **On-Demand GPS Tracking:** Activates GPS streaming only when necessary.
- **PTT-Triggered GPS:** Captures a one-shot GPS fix with every PTT press.
- **Reverse Geocoding:** Converts GPS coordinates to street addresses using Nominatim/OpenStreetMap.
- **Global Emergency Alerts:** Application-wide display and acknowledgment of emergency alarms.
- **Monitor-Only Audio Connections:** Dispatch Console can monitor channels without immediate audio resource consumption.
- **Cost Optimization:** On-demand audio connection activation and idle timeouts.
- **iOS / PWA polish (Task #376):** `viewport-fit=cover` + iOS safe-area insets on `.dispatch-viewport`, `.admin-root`, TopBar, and BottomBar so UI clears the iPhone notch and Home Indicator. Full-height layouts use `100svh` (with `100vh` fallback) via `.h-screen-safe` / `.min-h-screen-safe` utilities to avoid clipping behind Safari's collapsing address bar. Apple PWA tags include `mobile-web-app-capable`, `apple-touch-startup-image`, and `format-detection=telephone=no`. Web Wake Lock is acquired while the page is visible (and re-acquired on `visibilitychange` / `pageshow`) so iPhones don't sleep mid-monitor; same handlers also resume the AudioContext after returning from background. `client/src/lib/iosUtils.js` exposes `isIOS()`, `isSafari()`, `isStandalonePWA()` helpers. Audio transport code remains untouched per project rule.

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk.
- **Talkgroup System:** Channels organized into zones with switching and scan capabilities.
- **Unit Presence:** Real-time unit status tracking.
- **Emergency Button (E-Button):** Activates transmit lock, broadcasts emergency flag, and supports acknowledgment.
- **AI-Powered Emergency Escalation:** AI Dispatcher automatically initiates status checks and escalates emergencies. Routine status checks are gated by an admin-controlled kill switch ("AI Status Checks" toggle on the AI Voice Dispatcher card; defaults OFF / `AI_STATUS_CHECKS_ENABLED=false`) since CAD discontinued the routine status check feature.
- **AI Dispatcher Bounded Learning (Task #488):** Operator corrections (wrong address/unit/nature) and explicit "remember that X means Y" / "from now on X is Y" teachings are captured into `dispatch_learning_candidates` (per-agency, status pending/approved/rejected) by `src/services/dispatcherLearning.js`. Hard guardrails (FORBIDDEN_PATTERNS) reject anything touching personality, tier rules, 10-code semantics, escalation, safety/never-say, or raw backend IDs at both capture and apply time. Admins review candidates in the Settings tab (`client/src/AiLearningReview.jsx` → `/api/admin/learning/*` endpoints), and approved items are written to `dispatch_learned_items` (UNIQUE per agency+category+key). At runtime, `getLearnedPlaces()` is loaded into `agencyKnowledge.setLearnedPlaces()` and merged with `KNOWN_PLACES` for `resolveDestination` — the LLM system prompt is never modified. All learning activity (capture, block, approve, reject, delete) is appended to `logs/ai-dispatch-speech.log` under `[AI-DISPATCH-LEARNING]`.
- **Call Lifecycle Rules (R1, R2, R8, R9, R10):** AI Dispatcher enforces CAD call-lifecycle rules. Dispose requires both `disposition` and `dispositionNotes` (R9, same spoken text used for both). Voice cancel uses `PUT /api/calls/:id` with `status=cancelled` via `cadService.cancelCallDirect` (SEQ-10), prompting for a reason if not spoken inline. Voice reopen uses `POST /api/unit-command` with `REOPEN/<callNumber>` via `cadService.reopenCall` (SEQ-11) and never auto-reassigns the speaker. A primary-unit clear that returns HTTP 409 is spoken back and confirmed before cascading into the close-call flow (R8). All `cadService.updateUnitStatus` calls run through a per-unit serial queue (`_updateUnitStatusSerial`) so concurrent status progressions for the same unit can't interleave (R10).
- **Dispatcher Console:** Multi-channel monitoring, unit management, audio controls, last transmission recall, emergency acknowledgment, channel patching, multi-channel TX, and tone broadcasting.
- **Dispatcher Map:** Real-time unit location display using Leaflet with OpenStreetMap.
- **Channel Chat:** Text and playable voice messages with transcription.
- **Admin System:** User/channel management, role assignment, activity logging, and real-time audio tuning.
- **Audio Export System:** Exports channel audio messages within a specified date range.
- **Recording Logs (Admin):** Review, playback, and export radio transmissions with filtering options and PDF/ZIP export. Audio data is persisted in the PostgreSQL database.
- **Priority Channel:** Dispatchers can designate a priority channel in the console; only its audio plays while others are suppressed. Android clients prioritize the selected channel during scan mode.
- **Clear Air:** Dispatcher-activated mode for emergency traffic, forcing units onto a channel.
- **Live Scanner Feed:** Streams audio from HTTP sources into a channel as a virtual unit, applying VAD and integrating with floor control.

## FCM Push Notifications (Paging)

Device paging uses Firebase Cloud Messaging via the Firebase Admin SDK. The
server needs a **Firebase Admin service account JSON** to obtain OAuth2 tokens
— `android-native/app/google-services.json` is a client config and is **not**
sufficient.

### Setup
1. Firebase Console → Project Settings → Service Accounts → **Generate New
   Private Key**. Download the JSON.
2. Store it as a secret so it is not committed:
   - **Replit:** add secret `FIREBASE_SERVICE_ACCOUNT_JSON` with the full JSON
     string as the value.
   - **Azure VM (PM2):** either export `FIREBASE_SERVICE_ACCOUNT_JSON` in the
     PM2 ecosystem env, or save the file on disk (e.g.
     `/etc/command-comms/firebase-sa.json`, `chmod 600`) and set
     `FIREBASE_SERVICE_ACCOUNT_PATH=/etc/command-comms/firebase-sa.json`.
3. Restart the backend. On startup you should see
   `[FCM] Firebase Admin SDK initialized from FIREBASE_SERVICE_ACCOUNT_JSON for project: command-comms`.

If neither env var is set, the backend logs
`[STARTUP] FCM push notifications DISABLED: ...` and paging returns
`0 success, N failed` (no crash) until credentials are provided.

## Automated Testing

The project uses **Vitest** (v4.x) for unit and integration tests, run from the workspace root.

- **Test command:** `npm test` (runs `vitest run`)
- **Config file:** `vitest.config.js` (root)
- **Test files:** `client/src/**/__tests__/**/*.test.js`
- **Coverage provider:** v8

### Test Coverage
- `client/src/audio/__tests__/OpusBrowserEncoder.test.js` — 9 unit tests for `OpusBrowserEncoder` (init, isReady, destroy, idempotency, unsupported browser)
- `client/src/audio/__tests__/AudioTransportManager.ptt.test.js` — 8 integration tests verifying fast PTT start regression prevention:
  - Encoder is pre-warmed immediately after `connect()` succeeds
  - Encoder is re-warmed after `stopTransmit()` returns
  - `prewarmAudioContext()` correctly calls/skips encoder init
  - Guards against regression to the 3–4 s Opus encoder init delay (fixed in Task #359)

## External Dependencies
- **opusscript:** Opus audio codec (server-side).
- **opus-decoder:** WASM Opus decoder (browser-side).
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