# Command Communications by Reeder - Systems

## Overview
This project is a Push-to-Talk (PTT) radio communication application leveraging LiveKit for real-time audio streaming. It's a full-stack application with a React frontend and an Express.js backend. The core purpose is to provide robust, real-time communication for field units and a comprehensive dispatch console for monitoring and managing channels and units. Key features include a talkgroup system, unit presence tracking, advanced audio processing, emergency signaling, and an AI Voice Dispatcher for automated acknowledgments, aiming to enhance operational efficiency and communication reliability.

## User Preferences
Not specified.

## System Architecture

### UI/UX Decisions
- The application is designed as a Progressive Web App (PWA) for installability on mobile devices, ensuring a native-like experience with offline capabilities.
- A dark/light theme toggle is implemented with persistent preference storage, applying consistent styling across all UI elements using a predefined `THEMES` object.
- The Dispatcher Console features a modern React architecture with TailwindCSS v4, utilizing a modular component structure for maintainability and scalability.
- Drag-and-drop functionality for channel grids is implemented using `dnd-kit`.

### Technical Implementations
- **Frontend (React/Vite):** Utilizes React for dynamic UI, Vite for fast development, and Zustand for state management with localStorage persistence. Audio engines (`toneEngine.js`, `livekitEngine.js`) manage various audio functionalities and LiveKit connections.
- **Backend (Express.js):** Provides API endpoints for authentication, user/channel management, LiveKit token generation, and dispatch services. PostgreSQL is used for data persistence with `connect-pg-simple` for session management.
- **Zello-Style Connect-on-Transmit Architecture (NEW):**
  - **Signaling Layer:** Socket.IO-based lightweight signaling for presence, status, location, and PTT events. Standardized events include: CHANNEL_JOIN, CHANNEL_LEAVE, PTT_START, PTT_END, EMERGENCY_START, EMERGENCY_END, EMERGENCY_FORCE_CONNECT, UNIT_STATUS_UPDATE, LOCATION_UPDATE, SYSTEM_STATUS.
  - **On-Demand LiveKit Connections:** Units connect to LiveKit rooms only during active voice transmissions, reducing monthly usage from ~240 hours to ~2 hours.
  - **Client Components:**
    - `SignalingManager` (client/src/signaling/SignalingManager.js): Manages Socket.IO connection, authentication, and event handling.
    - `SignalingContext` (client/src/context/SignalingContext.jsx): React context for automatic connection/authentication when user logs in.
    - `OnDemandVoiceManager` (client/src/audio/OnDemandVoiceManager.js): Implements connect-on-transmit pattern with 3-second grace period for late-join support.
  - **Server Components:**
    - `signalingService` (src/services/signalingService.js): Socket.IO signaling server with channel membership, presence tracking, and event callbacks.
    - `aiDispatcherSignaling` (src/services/aiDispatcherSignaling.js): Bridges AI dispatcher with signaling events for on-demand connections.
  - **Grace Period:** 3-second window after PTT_END for late-join support and rapid follow-up transmissions.
  - **Emergency Override:** Force-connect broadcasts to all channel members with 60-second extended room lifetime, grace timer suppression during active emergencies.
- **Real-time Communication:** LiveKit for real-time audio streaming (on-demand only), Socket.IO signaling for presence/status/location (always-on, lightweight).
- **Audio Processing:** The Web Audio API is used for advanced Digital Signal Processing (DSP) including Automatic Gain Control (AGC), noise suppression, and a transmit compressor. Features like PTT Release Reliability, Feedback Loop Prevention, and Authorization/Busy Tones enhance the audio experience.
- **Authentication & Authorization:** Username/password authentication with bcrypt hashing and session management. Role-based access control protects routes for users, dispatchers, and administrators. Default admin credentials are provided for initial setup.
- **State Management:** Zustand stores manage application state for channels, units, and dispatcher settings on the frontend.
- **AI Voice Dispatcher:** Integrates Azure Speech Services (Speech-to-Text and Text-to-Speech) for automated radio acknowledgments. Now operates in standby mode by default, connecting to LiveKit only when signaling events trigger on-demand connections. Uses an intent-driven state machine with per-unit conversation sessions. Supports comprehensive dispatcher functions including:
  - **Status Commands:** on duty, available, en route, on scene, off duty, out of service, clear (with 10-codes)
  - **Immediate Commands:** radio check, time check, backup request, welfare check, tow/wrecker request, supervisor request, EMS/fire request, K9 request, subject in custody, negative contact, meal break
  - **Multi-Step Commands:** traffic stop (prompts for location), run plate (queries CAD), warrant check (queries CAD), BOLO broadcast, vehicle pursuit, records check (10-27) with phonetic name spelling support
  - **Records Check (10-27):** Multi-step person query flow with phonetic alphabet support (police: Adam/Boy/Charles, NATO: Alpha/Bravo/Charlie, or plain spelling). AI confirms name/DOB back, queries CAD, and if flags/warrants found, prompts "is your mic secure?" before delivering sensitive details. Results auto-logged to call notes.
  - **Emergency Commands:** Signal 100 (emergency traffic only), Signal 100 clear
  - **CAD Integration:** Automatic status updates, broadcast messages, vehicle/person/warrant queries via external CAD API
  - Safety guards prevent unintended transmissions and errors. Time format uses 24-hour with colon (e.g., "15:46 hours").
- **Cost Optimization:** LiveKit connections are optimized by connecting units only to active/selected channels (or scanned channels). An idle timeout feature disconnects users from rooms after inactivity, with automatic re-connection on activity.
- **PTT Release Reliability:** The AI Dispatcher includes a 1.5-second audio idle timeout safeguard. If no audio frames arrive for 1.5 seconds after transmission starts, the buffered audio is automatically processed. This ensures the AI responds even if the client fails to properly signal end-of-transmission.

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk audio transmission.
- **Talkgroup System:** Organized into zones (Operations, Fire, Secure Command) with channel switching and scan mode capabilities.
- **Unit Presence:** Real-time unit status (idle, transmitting, emergency) with visual indicators and last transmission timestamps, synced via Socket.IO signaling layer (lightweight, always-on).
- **Emergency Button (E-Button):** Activates a 10-second transmit lock, broadcasts an emergency flag, displays flashing alarms, and allows acknowledgment/cancellation by dispatchers/units. 
- **AI-Powered Emergency Escalation:** When a unit presses the emergency button, the AI Dispatcher automatically initiates a 2-attempt status check flow:
  1. Plays Alert A tone (1200Hz) + "Unit, status check" message
  2. Waits 5 seconds for response
  3. If no response, repeats once more
  4. If still no response, plays Continuous alert tone + broadcasts "no response" message to all units and CAD
  5. Unit can respond with "10-4"/"I'm OK" to clear emergency, or distress phrases ("shots fired", "needs backup") to trigger emergency broadcast
- **Dispatcher Console:** A dedicated interface for multi-channel monitoring, unit lists, per-channel audio controls (mute, level meters, TX selector), last transmission recall, emergency acknowledgment, and channel patching. Supports multi-channel TX and tone broadcasting.
- **Dispatcher Map:** Standalone real-time map at `/map` showing unit locations. Uses Leaflet with OpenStreetMap tiles. Unit positions updated via LiveKit heartbeats with 2-minute TTL. Includes SSE streaming for live updates, unit markers with ID/status colors, and auto-fit bounds. Accessible via "Map" button in Dispatcher Console (opens in new window).
- **Channel Chat (Zello-style):** Each channel has a chat tab in the Dispatcher Console showing both text messages and voice messages. Voice messages are automatically recorded from PTT transmissions and appear as playable audio bubbles with:
  - Inline play/pause button with progress bar
  - Duration display
  - On-demand transcription button using Azure Speech-to-Text
  - Real-time sync via LiveKit data channel for the AI dispatcher's active channel (OPS1 by default); other channels use 10-second polling fallback
  - Channel selector dropdown to view different channels' chat history
  - Text messaging support for dispatchers to send typed messages
  - Audio files stored in `uploads/audio/` directory (excluded from git)
- **Admin System:** Dashboard for user management (roles, blocking, dispatcher access), channel management (enable/disable), and activity logging.
- **Radio App Tab:** Admin-only tab that provides development info and build instructions for the Android app.

## Native Android App (Capacitor)

The Android radio app source code is located in the `android-app/` folder. It uses Capacitor to wrap the web UI into a native Android application.

### Configuration
- **App ID:** `com.reedersystems.commandcomms`
- **App Name:** COMMAND COMMS
- **Backend:** Connects to this server via environment variables (`BACKEND_URL`, `CAD_URL`)

### Native Plugins (`android-app/android-config/`)
- `LiveKitPlugin.kt` - Native LiveKit SDK wrapper for reliable PTT audio
- `HardwarePttPlugin.java` - Volume/Bluetooth PTT key support
- `BackgroundAudioService.java` - Foreground service for background audio/GPS
- `DndOverridePlugin.java` - Do Not Disturb override for emergency alerts

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

### Play Store Release
When ready for production, build a signed APK/AAB in Android Studio and upload to Google Play Console. The app launches directly to the radio login screen.

## External Dependencies
- **LiveKit:** Real-time audio streaming and data channel communication.
- **PostgreSQL:** Primary database for user, channel, and activity log data.
- **Azure Speech Services:** Used by the AI Voice Dispatcher for Speech-to-Text (STT) and Text-to-Speech (TTS) functionalities.
- **`dnd-kit`:** For drag-and-drop channel grid functionality in the Dispatcher Console.
- **`bcrypt`:** For password hashing.
- **`connect-pg-simple`:** For PostgreSQL-backed session management.
- **TailwindCSS v4:** Frontend styling and utility-first CSS framework.
- **Zustand:** Frontend state management library.
- **Leaflet/react-leaflet:** For the Dispatcher Map component with real-time unit markers.