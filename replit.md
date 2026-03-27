# Command Communications by Reeder - Systems

## Overview
This project is a Push-to-Talk (PTT) radio communication application designed for real-time audio streaming between field units and dispatch operations. Its primary purpose is to enhance operational efficiency and communication reliability through features such as a talkgroup system, unit presence tracking, advanced audio processing, emergency signaling, and an AI Voice Dispatcher for automated acknowledgments and voice-driven interactions. The application aims to provide a robust and intuitive communication platform for critical field operations.

## User Preferences
Not specified.

## System Architecture

### Client Architecture Split
- **Dispatch Console:** Web app (React/Vite) used by dispatchers on desktop browsers. Also available as an Electron desktop app (`desktop-app/`) with global PTT hotkeys that work even when the app is minimized or unfocused. The Electron app wraps the production web URL and injects simulated keyboard events for PTT.
- **Radio Client (Field Units / T320):** Native Kotlin Android app (`android-native/`). Uses custom UDP radio transport with Opus encoding, native PTT hardware key handling, and a foreground service for screen-off PTT. Connects to the same backend as the web app.

### UI/UX Decisions
The dispatch console is a Progressive Web App (PWA) with a responsive design for desktop. Key UI/UX elements include auto-login, dark/light theme toggles, and a Dispatcher Console built with React and TailwindCSS v4, utilizing `dnd-kit` for channel grid management. The native Android radio client uses Jetpack Compose with a dark cyan theme matching the web radio interface.

### Technical Implementations
- **Frontend:** Developed with React/Vite, using Zustand for state management and `localStorage` for persistence. Audio connections are managed by dedicated audio engines using WebSocket transport with end-to-end Opus encoding (48kHz/mono/960-frame).
- **Backend:** An Express.js server provides API endpoints for authentication, user/channel management, and dispatch services. PostgreSQL serves as the primary database for data persistence and session management.
- **Custom WebSocket/UDP Audio Transport (End-to-End Opus):** Replaces LiveKit. Browser clients encode Opus locally via `OpusBrowserCodec.js` (opusscript WebAssembly build loaded from `client/public/audio/opusscript_native_wasm.{js,wasm}`) and send Opus frames (type `0x02`) over WebSocket. The server relays Opus as-is to all subscribers without transcoding. Native Android clients use UDP with Opus. The server `audioRelayService.js` broadcasts Opus to UDP, WebSocket, and audio listener subscribers. Browser RX decodes Opus locally with a `JitterBuffer.js` for reorder/gap handling. FEC (Forward Error Correction) is enabled on both browser and server Opus encoders. Legacy PCM (`0x01`) frames are still accepted server-side for backward compatibility. AI dispatcher receives Opus from relay listeners and decodes server-side for STT. Socket.IO handles persistent signaling (presence, PTT floor control, data messages, emergency, location).
- **Real-time Communication:** WebSocket handles real-time audio streaming, while Socket.IO manages persistent, lightweight signaling and channel data messages.
- **Audio Processing:** Incorporates advanced Digital Signal Processing (DSP) via the Web Audio API, including AGC, noise suppression, and a transmit compressor, alongside PTT Release Reliability and Feedback Loop Prevention.
- **Authentication & Authorization:** Implements username/password authentication with bcrypt hashing and session management, supporting role-based access control (users, dispatchers, administrators).
- **AI Voice Dispatcher:** Integrates Azure Speech Services for STT/TTS and Azure OpenAI (GPT-4o-mini) for **full AI response generation**, enabling natural speech commands for status changes, detail commands, 10-27 records checks with phonetic spelling, traffic stops, plate checks, backup requests, radio/time checks, Signal 100, emergency escalation, and **voice-driven CAD call creation**. The LLM generates natural, varied response text (temperature 0.4) instead of rigid templates, with per-unit conversation history (last 4 exchanges) passed to the LLM for contextual awareness. It operates in standby, connecting to LiveKit on demand. Emergency commands prioritize fast pattern matching. "Repeat" / "say again" / "10-9" repeats the last spoken response to any unit. TTS pronunciation of 10-codes is pre-processed, and address normalization is applied to spoken inputs. AI dispatcher TTS responses are recorded and stored. **Two-tier response system:** Tier 1 (routine: status changes, traffic stops, radio/time checks, disregard) uses fixed short format without unit ID echo; Tier 2 (complex: backup, records, CAD calls, emergencies) uses natural AI personality with variation. Military time is output as spoken words (e.g., "fourteen thirty" not "1430") to prevent TTS mispronunciation.
- **T320 Screen-Off PTT (Service-Level Architecture):** PTT works entirely at the native Android service level, independent of MainActivity/WebView. Primary chain: `PttHardwareReceiver` → `BackgroundAudioService.onStartCommand()` → `RadioAudioEngine` `startTransmit/stopTransmit()`. BackgroundAudioService owns PTT state machine (IDLE/CONNECTING/TRANSMITTING). Uses `RadioAudioEngine` with `FloorControlManager` → `RadioSignalingGateway` → Socket.IO floor control → `UdpAudioTransport` → relay server → `OpusCodec` → `JitterBuffer` → `AudioPlayback`. Radio state managed by `RadioStateManager` (IDLE/REQUESTING_FLOOR/TRANSMITTING/RECEIVING/CHANNEL_BUSY), observed by `RadioViewModel` for UI updates. Signaling events: `radio:joinChannel`, `radio:leaveChannel`, `ptt:request`, `ptt:granted`, `ptt:denied`, `tx:start`, `tx:stop`, `channel:busy`, `channel:idle`.
  Hardware button detection code in `PttHardwareReceiver.kt`, `MainActivity.kt` key handlers, and `BackgroundAudioService.kt` intent dispatch are marked with "DO NOT MODIFY — VERIFIED HARDWARE MAPPING" comments. `[PTT-DIAG]` diagnostic logging throughout entire chain, filterable via `adb logcat -s PTT-DIAG`. Battery optimization exemption requested on first launch.
- **Android Dev Auto-Login:** `DevConfig.AUTO_LOGIN_ENABLED` (in `android-native/.../DevConfig.kt`) skips the login screen and auto-authenticates with hardcoded credentials (unit ID "T320"). Set to `false` for production builds. The auto-login still calls `/api/auth/login` server-side so sessions are established normally.
- **Background PTT Persistence:** Connection info (server URL, unit ID, channel ID, channel name) is persisted to Android SharedPreferences (`CommandCommsServicePrefs`). On service cold-start, info is restored automatically.
- **On-Demand GPS Tracking:** Activates GPS streaming only when necessary (emergency button or dispatcher request) via Socket.IO events, with server-side processing and broadcasting to dispatch consoles.
- **Global Emergency Alerts:** A `GlobalEmergencyOverlay` component ensures emergency alarms are displayed and acknowledged across all application pages.
- **Monitor-Only Audio Connections:** The Dispatch Console can monitor channels via Socket.IO signaling without consuming audio resources until actively monitored.
- **Cost Optimization:** Audio connections are optimized through on-demand activation and idle timeouts (no external media server dependency).

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk functionality.
- **Talkgroup System:** Channels are organized into zones with switching and scan capabilities.
- **Unit Presence:** Real-time unit status (idle, transmitting, emergency) displayed via visual indicators and synced via Socket.IO.
- **Emergency Button (E-Button):** Activates a transmit lock, broadcasts an emergency flag, and supports acknowledgment/cancellation.
- **AI-Powered Emergency Escalation:** The AI Dispatcher automatically initiates a status check flow upon emergency, escalating if no response.
- **Dispatcher Console:** A dedicated interface for multi-channel monitoring, unit management, audio controls, last transmission recall, emergency acknowledgment, and channel patching, including multi-channel TX and tone broadcasting.
- **Dispatcher Map:** Real-time unit location display using Leaflet with OpenStreetMap tiles.
- **Channel Chat:** Each channel includes a chat tab in the Dispatcher Console, showing text messages and playable voice messages with transcription.
- **Admin System:** Provides user and channel management, role assignment, and activity logging. Zones and channels are structured with unique channel names per zone, enforced by a `room_key` (`COALESCE(zone, 'Default') || '__' || name`) used for audio rooms and signaling.
- **Audio Export System:** Allows exporting channel audio messages within a specified date range as a ZIP file including a `manifest.json`.
- **Clear Air:** Dispatcher selects a channel and activates Clear Air mode (with persistent beep alert). Server broadcasts `clear_air:start` to all connected units via Socket.IO; units on that channel or in their scan list are force-connected and shown a prominent animated "CLEAR AIR — EMERGENCY TRAFFIC ONLY" banner. Releasing Clear Air requires a confirmation dialog and broadcasts `clear_air:end`. Late-joining units receive immediate Clear Air state on channel join.

## External Dependencies
- **opusscript:** Opus audio codec used server-side (AI dispatcher encode/decode, legacy PCM fallback) and browser-side (via asm.js build in `client/public/audio/opusscript_native_nasm.js` for end-to-end Opus transport).
- **PostgreSQL:** Primary database for application data.
- **Azure Speech Services:** Speech-to-Text (STT) and Text-to-Speech (TTS) for the AI Voice Dispatcher.
- **Azure OpenAI (GPT-4o-mini):** Natural language intent classification for the AI Voice Dispatcher.
- **`dnd-kit`:** Drag-and-drop functionality for UI components.
- **`bcrypt`:** Password hashing.
- **`connect-pg-simple`:** PostgreSQL-backed session management.
- **TailwindCSS v4:** Frontend styling framework.
- **Zustand:** Frontend state management.
- **Leaflet/react-leaflet:** Mapping components for the Dispatcher Map.
- **`archiver`:** For ZIP file creation in the audio export system.

## Azure VM Deployment
The app is deployed on Azure VM `20.115.21.70` at `https://comms.reeder-systems.com`.

### SSL/TLS
- Let's Encrypt certificate issued via certbot (nginx plugin) on 2026-03-24
- Certificate auto-renews via certbot systemd timer
- nginx serves HTTPS on port 443 with HTTP→HTTPS redirect on port 80
- Certificate path: `/etc/letsencrypt/live/comms.reeder-systems.com/`

### Deploy Scripts
Deployment scripts and configs are in the `deploy/` directory:
- `deploy/remote-deploy.sh` — Full remote deployment: SSH into VM, sync code, install deps, build frontend, configure nginx+SSL, start PM2.
- `deploy/setup-server.sh` — Provisions a fresh Ubuntu VM with Node.js 20, PostgreSQL 16, nginx, PM2, certbot, and firewall rules (ports 443, 80, 5100/UDP).
- `deploy/nginx.conf` — Reverse proxy config with SSL, WebSocket upgrade for Socket.IO and signaling.
- `deploy/nginx-pre-ssl.conf` — HTTP-only nginx config used before certbot runs.
- `deploy/ecosystem.config.cjs` — PM2 process config for auto-restart and boot persistence.
- `deploy/init-db.sh` — Creates the PostgreSQL database and user. The app auto-creates tables on first connect.
- `deploy/deploy.sh` — Pulls latest code, installs deps, builds frontend, restarts PM2.
- `.github/workflows/deploy.yml` — GitHub Actions workflow that auto-deploys to the Azure VM on push to `main` using `appleboy/ssh-action`. Requires GitHub repository secrets: `AZURE_VM_HOST`, `AZURE_VM_USER`, `AZURE_VM_SSH_KEY` (and optionally `AZURE_VM_PORT`, `AZURE_VM_FINGERPRINT`).
- `.env.production.example` — Template listing all required and optional environment variables.