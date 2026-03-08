# Command Communications by Reeder - Systems

## Overview
This project is a Push-to-Talk (PTT) radio communication application designed for real-time audio streaming between field units and dispatch operations. Its primary purpose is to enhance operational efficiency and communication reliability through features such as a talkgroup system, unit presence tracking, advanced audio processing, emergency signaling, and an AI Voice Dispatcher for automated acknowledgments and voice-driven interactions. The application aims to provide a robust and intuitive communication platform for critical field operations.

## User Preferences
Not specified.

## System Architecture

### UI/UX Decisions
The application is a Progressive Web App (PWA) with a responsive design, supporting both mobile and desktop environments from a single codebase. It features specific layouts for devices like the Inrico T320, including hardware key mapping. Key UI/UX elements include auto-login, dark/light theme toggles, and a Dispatcher Console built with React and TailwindCSS v4, utilizing `dnd-kit` for channel grid management.

### Technical Implementations
- **Frontend:** Developed with React/Vite, using Zustand for state management and `localStorage` for persistence. Audio and LiveKit connections are managed by dedicated audio engines.
- **Backend:** An Express.js server provides API endpoints for authentication, user/channel management, LiveKit token generation, and dispatch services. PostgreSQL serves as the primary database for data persistence and session management.
- **Zello-Style Connect-on-Transmit Architecture:** Employs Socket.IO for lightweight signaling (presence, status, location, PTT) and on-demand LiveKit connections for audio, reducing resource usage. A 3-second grace period and emergency overrides manage connection lifetimes.
- **Real-time Communication:** LiveKit handles on-demand real-time audio streaming, while Socket.IO manages persistent, lightweight signaling.
- **Audio Processing:** Incorporates advanced Digital Signal Processing (DSP) via the Web Audio API, including AGC, noise suppression, and a transmit compressor, alongside PTT Release Reliability and Feedback Loop Prevention.
- **Authentication & Authorization:** Implements username/password authentication with bcrypt hashing and session management, supporting role-based access control (users, dispatchers, administrators).
- **AI Voice Dispatcher:** Integrates Azure Speech Services for STT/TTS and Azure OpenAI (GPT-4o-mini) for **full AI response generation**, enabling natural speech commands for status changes, detail commands, 10-27 records checks with phonetic spelling, traffic stops, plate checks, backup requests, radio/time checks, Signal 100, emergency escalation, and **voice-driven CAD call creation**. The LLM generates natural, varied response text (temperature 0.4) instead of rigid templates, with per-unit conversation history (last 4 exchanges) passed to the LLM for contextual awareness. It operates in standby, connecting to LiveKit on demand. Emergency commands prioritize fast pattern matching. "Repeat" / "say again" / "10-9" repeats the last spoken response to any unit. TTS pronunciation of 10-codes is pre-processed, and address normalization is applied to spoken inputs. AI dispatcher TTS responses are recorded and stored. **Two-tier response system:** Tier 1 (routine: status changes, traffic stops, radio/time checks, disregard) uses fixed short format without unit ID echo; Tier 2 (complex: backup, records, CAD calls, emergencies) uses natural AI personality with variation. Military time is output as spoken words (e.g., "fourteen thirty" not "1430") to prevent TTS mispronunciation.
- **T320 Screen-Off PTT (Service-Level Architecture):** PTT works entirely at the native Android service level, independent of MainActivity/WebView. Primary chain: `PttBroadcastReceiver` → `BackgroundAudioService.handlePttDown/Up()` → `LiveKitPlugin.startTransmit/stopTransmit()` → native LiveKit audio track publish/unpublish. BackgroundAudioService owns PTT state machine (IDLE/TRANSMITTING). LiveKitPlugin exposes static `getInstance()` with native `startTransmit()`/`stopTransmit()` methods callable without PluginCall/Capacitor bridge. Cold-start handled via intent extras (`ptt_action=down/up`). Backend HTTP endpoints `POST /api/ptt/start` and `POST /api/ptt/end` bridge native service HTTP calls into Socket.IO signaling (fire-and-forget, TX works even if signaling fails). `GET /api/ptt/token` provides LiveKit tokens for native service reconnection (auth via unit presence, no session required). WebView/HardwarePttPlugin notification is optional UI sync only. `[PTT-DIAG]` diagnostic logging throughout entire chain, filterable via `adb logcat -s PTT-DIAG`. Battery optimization exemption requested on first launch.
- **Background PTT Persistence:** Connection info (server URL, unit ID, channel ID, LiveKit URL, channel name) is persisted to Android SharedPreferences (`CommandCommsServicePrefs`). On service cold-start, info is restored automatically. If the native LiveKit room connection drops while backgrounded, `handlePttDown()` triggers auto-reconnect: fetches a fresh token from `GET /api/ptt/token`, calls `LiveKitPlugin.connectFromService()`, waits up to 3s for connection, then transmits.
- **Native LiveKit Bridge (JS↔Android):** On Android native, LiveKit connections route through the native LiveKit SDK instead of the web `livekit-client` SDK. `client/src/plugins/nativeLiveKit.js` bridges JS calls to the `NativeLiveKit` Capacitor plugin. `LiveKitManager._doConnectNative()` gets a token from the server and calls `NativeLiveKit.connect()`, creating a native room proxy object for the web-side code. `MicPTTManager._startNative()/_doStopNative()` call `NativeLiveKit.enableMicrophone()/disableMicrophone()` instead of web SDK `publishTrack/unpublishTrack`. This ensures the native `LiveKitPlugin.kt` always has an active room connection, enabling `BackgroundAudioService.handlePttDown()` → `LiveKitPlugin.startTransmit()` to work with screen off. `BackgroundServicePlugin.updateConnectionInfo()` passes server URL, unit ID, and channel ID to the service for HTTP PTT signaling. The web SDK path remains unchanged for browser/desktop use.
- **On-Demand GPS Tracking:** Activates GPS streaming only when necessary (emergency button or dispatcher request) via Socket.IO events, with server-side processing and broadcasting to dispatch consoles.
- **Global Emergency Alerts:** A `GlobalEmergencyOverlay` component ensures emergency alarms are displayed and acknowledged across all application pages.
- **Monitor-Only Audio Connections:** The Dispatch Console can monitor channels via Socket.IO signaling without consuming LiveKit resources until actively monitored.
- **Cost Optimization:** LiveKit connections are optimized through on-demand activation and idle timeouts.

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk functionality.
- **Talkgroup System:** Channels are organized into zones with switching and scan capabilities.
- **Unit Presence:** Real-time unit status (idle, transmitting, emergency) displayed via visual indicators and synced via Socket.IO.
- **Emergency Button (E-Button):** Activates a transmit lock, broadcasts an emergency flag, and supports acknowledgment/cancellation.
- **AI-Powered Emergency Escalation:** The AI Dispatcher automatically initiates a status check flow upon emergency, escalating if no response.
- **Dispatcher Console:** A dedicated interface for multi-channel monitoring, unit management, audio controls, last transmission recall, emergency acknowledgment, and channel patching, including multi-channel TX and tone broadcasting.
- **Dispatcher Map:** Real-time unit location display using Leaflet with OpenStreetMap tiles.
- **Channel Chat:** Each channel includes a chat tab in the Dispatcher Console, showing text messages and playable voice messages with transcription.
- **Admin System:** Provides user and channel management, role assignment, and activity logging. Zones and channels are structured with unique channel names per zone, enforced by a `room_key` (`COALESCE(zone, 'Default') || '__' || name`) used for LiveKit rooms and signaling.
- **Audio Export System:** Allows exporting channel audio messages within a specified date range as a ZIP file including a `manifest.json`.

## External Dependencies
- **LiveKit:** Real-time audio streaming and data communication.
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