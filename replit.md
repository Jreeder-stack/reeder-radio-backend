# Command Communications by Reeder - Systems

## Overview
This project is a Push-to-Talk (PTT) radio communication application built for real-time audio streaming, primarily for field units and dispatch operations. It features a React frontend and an Express.js backend. The application aims to provide reliable, real-time communication through a talkgroup system, unit presence tracking, advanced audio processing, emergency signaling, and an AI Voice Dispatcher for automated acknowledgments, thereby enhancing operational efficiency and communication reliability.

## User Preferences
Not specified.

## System Architecture

### UI/UX Decisions
The application is designed as a Progressive Web App (PWA) with a single codebase for both mobile and desktop. It features responsive design, adapting the interface based on screen size (e.g., `RadioDeckView` for mobile, full `App` for desktop). Special consideration is given to Inrico T320 devices with a dedicated display-only layout and hardware key mapping. Auto-login functionality is included, and a dark/light theme toggle with persistent storage is implemented. The Dispatcher Console uses React with TailwindCSS v4 and incorporates drag-and-drop functionality for channel grids using `dnd-kit`.

### Technical Implementations
- **Frontend:** Built with React/Vite, using Zustand for state management and `localStorage` persistence. Audio functionalities and LiveKit connections are managed by dedicated audio engines.
- **Backend:** An Express.js server handles API endpoints for authentication, user/channel management, LiveKit token generation, and dispatch services. PostgreSQL is used for data persistence and session management.
- **Zello-Style Connect-on-Transmit Architecture:** This architecture uses Socket.IO for lightweight signaling (presence, status, location, PTT events) and on-demand LiveKit connections. Units connect to LiveKit rooms only during active voice transmissions, significantly reducing usage. A 3-second grace period after PTT_END supports late-joins and rapid follow-up transmissions. Emergency overrides force connections with extended room lifetimes.
- **Real-time Communication:** LiveKit is used for on-demand real-time audio streaming, complemented by Socket.IO for persistent, lightweight signaling.
- **Audio Processing:** Advanced Digital Signal Processing (DSP) is implemented using the Web Audio API, including Automatic Gain Control (AGC), noise suppression, and a transmit compressor. Features like PTT Release Reliability and Feedback Loop Prevention enhance audio quality.
- **Authentication & Authorization:** Username/password authentication with bcrypt hashing and session management. Role-based access control is implemented for users, dispatchers, and administrators.
- **AI Voice Dispatcher:** Integrates Azure Speech Services for automated radio acknowledgments. It operates in a standby mode, connecting to LiveKit on demand, and uses an intent-driven state machine with per-unit conversation sessions. It supports various status commands, immediate commands, multi-step commands (e.g., traffic stop, run plate, records check with phonetic spelling), and emergency commands. It includes CAD integration for automatic status updates and queries. A 1.5-second audio idle timeout safeguards PTT release reliability. Late-join track pickup ensures the dispatcher catches audio even when joining after a unit starts transmitting. Track SID deduplication prevents double-processing.
- **10-27 Records Check Flow:** Unit says "Central, 10-27" → AI responds "[unit], 10-27 go ahead" → Unit provides name/DOB → AI asks for any missing fields (last name, first name, DOB) individually → AI reads back details and asks "10-4?" → Unit confirms (10-4) or denies (negative to re-enter) → AI queries CAD → Results returned (with secure mic check for flagged individuals). DOB parsing supports numeric (3/15/1985), spoken month ("march fifteenth nineteen eighty five"), and fully spoken ("three fifteen eighty five", "oh three fifteen eighty five") formats.
- **TTS 10-Code Pronunciation:** Azure Speech TTS preprocesses all `10-XX` patterns into spoken words (e.g., "10-4" → "ten four") before synthesis to prevent misinterpretation as math expressions.
- **Cost Optimization:** LiveKit connections are optimized through on-demand connections and an idle timeout feature.

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk audio.
- **Talkgroup System:** Channels are organized into zones with switching and scan mode capabilities.
- **Unit Presence:** Real-time unit status (idle, transmitting, emergency) with visual indicators, synced via Socket.IO.
- **Emergency Button (E-Button):** Activates a transmit lock, broadcasts an emergency flag, and allows acknowledgment/cancellation.
- **AI-Powered Emergency Escalation:** The AI Dispatcher automatically initiates a status check flow upon an emergency button press, escalating to continuous alerts if no response.
- **Dispatcher Console:** A dedicated interface for multi-channel monitoring, unit management, audio controls, last transmission recall, emergency acknowledgment, and channel patching. Supports multi-channel TX and tone broadcasting.
- **Dispatcher Map:** A real-time map displaying unit locations using Leaflet with OpenStreetMap tiles, updated via LiveKit heartbeats.
- **Channel Chat:** Each channel has a chat tab in the Dispatcher Console, displaying text messages and playable voice messages from PTT transmissions with transcription capabilities.
- **Admin System:** Provides user and channel management, role assignment, and activity logging. The Zones & Channels screen uses an accordion layout where zones are expandable cards showing their channels. Channel names are unique per-zone (not globally), allowing the same channel name in different zones. The database enforces `UNIQUE(name, zone_id)`.
- **Zone-Scoped Channel Identity (`room_key`):** Each channel has a unique `room_key` computed as `COALESCE(zone, 'Default') || '__' || name` (double underscore separator). This `room_key` is used as the LiveKit room name, Socket.IO signaling channel ID, presence tracking key, and unit status identifier. The raw channel `name` is used only for display. This ensures channels with the same name in different zones (e.g., "OPS-1" in "PHILA" and "OPS-1" in "OPS") use separate rooms and don't cross-talk. The AI Dispatcher config also stores `room_key` (not channel name). Backend returns `room_key` from `GET /api/channels`.

## External Dependencies
- **LiveKit:** Real-time audio streaming and data channel communication.
- **PostgreSQL:** Primary database for user, channel, and activity log data.
- **Azure Speech Services:** Used by the AI Voice Dispatcher for Speech-to-Text (STT) and Text-to-Speech (TTS).
- **`dnd-kit`:** For drag-and-drop channel grid functionality.
- **`bcrypt`:** For password hashing.
- **`connect-pg-simple`:** For PostgreSQL-backed session management.
- **TailwindCSS v4:** Frontend styling framework.
- **Zustand:** Frontend state management library.
- **Leaflet/react-leaflet:** For the Dispatcher Map component.

## Native Android App (Capacitor)

The Android radio app source code is located in the `android-app/` folder. It uses Capacitor to wrap the web UI into a native Android application.

### Configuration
- **App ID:** `com.reedersystems.commandcomms`
- **App Name:** COMMAND COMMS
- **Backend:** Connects to this server via environment variables (`BACKEND_URL`, `CAD_URL`)

### Native Plugins (`android-app/android-config/`)
- `LiveKitPlugin.kt` - Native LiveKit SDK wrapper for reliable PTT audio
- `HardwarePttPlugin.java` - Volume/Bluetooth PTT key support
- `BackgroundAudioService.java` - Foreground service for background audio/GPS with CPU wake lock
- `BackgroundServicePlugin.java` - Capacitor plugin to control background service and wake locks from JavaScript
- `DndOverridePlugin.java` - Do Not Disturb override for emergency alerts
- `RadioVoiceDSP.kt` - Radio voice DSP processing (reference implementation)

### Background PTT Operation
When the app goes off-screen (screen off or backgrounded), Android pauses the WebView's JavaScript engine. `MainActivity.java` overrides `onPause()` and `onStop()` to immediately call `webView.onResume()` and `webView.resumeTimers()`, keeping JS execution alive. A periodic JS keepalive timer runs every 3 seconds while the screen is off, and executes `evaluateJavascript("1", null)` to force the JS engine to stay warm for Capacitor plugin callbacks. On the JS side, `capacitor.js` overrides `document.hidden` and `document.visibilityState` to always report "visible" on native platforms, preventing Socket.IO and WebRTC from throttling when the page appears hidden. Both `document.addEventListener` and `window.addEventListener` are intercepted to block `visibilitychange` event registration. `setupAppLifecycle` uses the Capacitor App plugin's `appStateChange` event instead of `visibilitychange`. The `BackgroundAudioService` foreground service is started early in `AppWrapper` (main.jsx) as soon as the user logs in on native, ensuring the CPU wake lock is active before the radio view mounts. Combined with `FLAG_KEEP_SCREEN_ON`, this ensures PTT works reliably even when the screen is off.

### Talk Permit Tone
Uses a Motorola APX WAV file at `client/public/sounds/talk-permit.wav`. Played via `playPermitTone()` in `talkPermitTone.js` and `playTalkPermitTone()` in `audioTones.js`.

### Signaling Architecture
All views (App.jsx, RadioDeckView.jsx, DispatchConsole.jsx) must join/leave signaling channels via `useSignalingContext` for presence, PTT events, and emergency alerts to work. Emergency alerts use two paths: channel-scoped `emergency:start` (to channel members) and global `emergency:alert` (to all clients). The dispatch console listens for both via `LiveKitConnectionContext.jsx`.

### Building the APK
**Prerequisites:** Android Studio, JDK 21+, Gradle 8.9+

1. `cd android-app && npm install`
2. `npm run build`
3. `npx cap add android` (first time only)
4. `npx cap sync android`
5. Fix Gradle version if prompted (update to 8.9 in Android Studio)
6. Copy files from `android-config/` to the Android project
7. Open in Android Studio: `npx cap open android`
8. Build APK from Android Studio