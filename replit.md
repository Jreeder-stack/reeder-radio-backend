# Command Communications by Reeder - Systems

## Overview
A Push-to-Talk (PTT) radio communication app using LiveKit for real-time audio streaming. Fullstack application with React frontend and Express backend.

## Project Structure
```
/
├── src/                   # Backend source (Express)
│   ├── app.js             # Express app setup with middleware
│   ├── server.js          # Server entry point
│   ├── config/
│   │   └── index.js       # Environment configuration
│   ├── db/
│   │   └── index.js       # PostgreSQL database queries
│   ├── routes/
│   │   ├── index.js       # Route aggregation
│   │   ├── auth.js        # Auth routes (/api/login, /api/logout, etc.)
│   │   ├── admin.js       # Admin routes (/api/admin/*)
│   │   ├── channels.js    # Channel routes (/api/channels)
│   │   ├── livekit.js     # LiveKit token route (/api/livekit-token)
│   │   └── dispatch.js    # Dispatch routes (/api/dispatch/*)
│   ├── controllers/
│   │   └── dispatchController.js
│   ├── services/
│   │   ├── dispatchService.js
│   │   └── livekitService.js
│   └── middleware/
│       ├── auth.js        # requireAuth, requireAdmin, requireDispatcher
│       └── session.js     # Session configuration
├── server.js              # Legacy entry point (imports src/server.js)
├── db.js                  # Legacy DB (imports src/db/index.js)
├── package.json           # Backend dependencies
├── client/                # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx        # Main PTT interface (state machine pattern)
│   │   ├── Login.jsx      # Login screen
│   │   ├── Admin.jsx      # Admin dashboard
│   │   ├── AuthContext.jsx # Auth state management
│   │   ├── main.jsx       # React entry with protected routing
│   │   ├── pages/
│   │   │   └── DispatchConsole.jsx # Dispatcher console UI
│   │   ├── components/    # Reusable UI components
│   │   ├── state/         # Zustand stores (channels.js, units.js, dispatcher.js)
│   │   └── audio/         # Audio engines (toneEngine, livekitEngine, ToneTransmitter)
│   ├── vite.config.js     # Vite config with proxy to backend
│   ├── index.html         # HTML entry point
│   └── package.json       # Frontend dependencies
```

## Environment Variables

### Required Secrets:
- `LIVEKIT_API_KEY` - LiveKit API key
- `LIVEKIT_API_SECRET` - LiveKit API secret  
- `LIVEKIT_URL` - LiveKit server URL (wss://...)
- `SESSION_SECRET` - Required in production for secure sessions
- `AZURE_SPEECH_KEY` - Azure Speech Services API key (for AI Voice Dispatcher)
- `AZURE_SPEECH_REGION` - Azure Speech Services region (for AI Voice Dispatcher)

### Optional Environment Variables:
- `ADMIN_USERNAME` - Default admin username (defaults to "admin")
- `ADMIN_PASSWORD` - Default admin password (defaults to "admin123")
- `NODE_ENV` - Set to "production" for secure cookie settings

### Frontend Environment (development):
- `VITE_LIVEKIT_URL` - LiveKit server URL for browser client

## Running Locally (Replit)

Both workflows run automatically:
1. **Backend API** - `npm start` (port 3001)
2. **Frontend** - `cd client && npm run dev` (port 5000)

## PWA (Progressive Web App)

The app is installable as a PWA on Android and iOS:
- **Manifest**: `client/public/manifest.json` - App name, icons, theme colors
- **Icons**: `client/public/icons/` - 192x192 and 512x512 PNG icons
- **Service Worker**: `client/public/sw.js` - Network-first caching with offline fallback
- **Mobile Audio Fix**: Pre-captures microphone on first connection to unlock audio autoplay on mobile browsers

### Installing on Android:
1. Open the app in Chrome
2. Tap the three-dot menu → "Add to Home Screen"
3. The app will run in standalone mode with no browser UI

## Routes
- `/login` - Login screen (no self-registration, admin creates accounts)
- `/` - Main PTT Radio interface for field units (protected)
- `/dispatcher` - Dispatcher Console for multi-channel monitoring (requires dispatcher permission)
- `/admin` - Admin dashboard for user/channel management (admin only)

## Deploying to Render

Build command: `cd client && npm install && npm run build && cd .. && npm install`
Start command: `node server.js`

Set these environment variables in Render:
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `LIVEKIT_URL`
- `VITE_LIVEKIT_URL`

## Features

### Phase 1 - Core PTT
- Unit ID-based authentication
- Push-to-Talk audio transmission

### Phase 2 - Talkgroup System
- 3 Zones: Operations (OPS1, OPS2, TAC1), Fire (FIRE1-8), Secure Command
- Channel switching within zones
- Scan mode - monitor multiple channels, transmit on primary
- TX/RX indicator

### Phase 3 - Unit Presence
- Real-time unit status tracking (idle/transmitting/emergency)
- Status color indicators: Green=idle, Yellow=transmitting, Red=emergency
- Last transmission timestamp per unit
- LiveKit data channels for presence sync across participants
- Online units display grouped by channel with status

### Phase 4 - Audio Engine Enhancements
- Web Audio API DSP chain:
  - Automatic Gain Control (AGC)
  - Noise suppression
  - Transmit compressor (APX-style curve)
- Per-channel audio level meters (TX and RX)
- Recording last RX with playback capability
- PTT Release Reliability: Global window listeners (pointerup, pointercancel, touchend, touchcancel, blur) ensure transmission stops reliably on mobile and desktop
- Feedback Loop Prevention: TX channels are automatically muted during transmission to prevent audio feedback
- Authorization Tone: Motorola-style quick double beep (2x 50ms at 1200Hz) plays when PTT engages on clear channel
- Busy Tone: Sustained 480Hz tone plays while PTT is held on an occupied channel
- Pre-Alert Tone: 4 beeps at 1000Hz (0.30s beep, 0.20s gap)
- Race Condition Prevention: stopCalledRef ensures stopTransmission only executes once per PTT cycle, preventing double-unpublish on rapid release
- Stale Channel Cleanup: Persisted gridChannelIds/channelOrder are validated against database on load, removing deleted channel references

### Phase 5 - Emergency Button (E-Button)
- Emergency button on UI
- 10-second transmit lock when activated
- Emergency flag broadcast via data channel
- Flashing red alarm display on all connected clients
- Dispatcher/unit can acknowledge (ACK) to clear emergency
- Cancel emergency option

### Phase 6 - Dispatcher Console (/dispatcher)
- Separate fullscreen multi-channel view
- Auto-joins all talkgroups on connect
- Comprehensive unit list with status by channel
- Mute per channel
- Per-channel audio level meters
- TX channel selector with dispatch PTT
- Last transmission recall per channel
- Emergency acknowledgement

### Phase 7 - Advanced Data Channels
- Unit heartbeat system (30-second intervals) for online/offline detection
- Location pings (if geolocation available)
- Channel metadata in data messages

### Phase 9 - Dispatch Radio Module (Backend)
- Database tables: units, radio_events, dispatch_monitor_sets, radio_channels, channel_patches
- Persistent unit presence tracking with emergency status
- Radio event logging for auditing
- Dispatcher monitor configuration (primary TX channel, monitored channels)
- API endpoints at /api/dispatch:
  - GET/POST /units - Unit presence management
  - POST /units/:id/emergency - Toggle emergency status
  - POST /emergency/ack - Acknowledge emergencies
  - GET/POST/PATCH /channels - Radio channel management
  - GET/POST/PATCH /patches - Channel patch management
  - GET/POST /monitor/:dispatcherId - Dispatcher monitor config
- LiveKit helper stubs in src/livekit/radioRooms.js

### Phase 7.5 - Dark/Light Theme Toggle
- Theme toggle button (sun/moon emoji) in radio screen header
- Persistent theme preference via localStorage
- THEMES object with dark and light color schemes
- Applied to all UI elements: buttons, panels, text, backgrounds
- Dark mode: dark grays (#111, #1a1a1a, #222) with white text
- Light mode: light grays (#f5f5f5, #fff, #e5e5e5) with dark text

### Phase 8 - Authentication & Admin System
- PostgreSQL database with users, channels, activity_logs tables
- Username/password authentication with bcrypt hashing
- Session management with connect-pg-simple
- Default admin account created on startup
- No self-registration - admin creates all user accounts
- Admin dashboard with three tabs:
  - Users: View all, change roles (user/admin), block/unblock accounts, set dispatcher access
  - Channels: Enable/disable channels by zone
  - Activity Logs: View all user actions with timestamps
- Protected routes with role-based access control
- Dispatcher permission: Users need "Dispatcher Access" checkbox enabled to access Dispatcher Console
- Activity logging for logins, registrations, channel joins, admin actions

### Phase 10 - State-of-the-Art Dispatch Console UI
- Modern React architecture with TailwindCSS v4
- Modular component structure:
  - `client/src/state/` - Zustand stores (channels.js, units.js, dispatcher.js)
  - `client/src/api/` - Backend API integration (dispatch.js)
  - `client/src/audio/` - Audio engines (toneEngine.js, livekitEngine.js)
  - `client/src/components/` - Reusable UI components
  - `client/src/pages/` - Page components (DispatchConsole.jsx)
- Drag-and-drop channel grid using dnd-kit
- Features:
  - ChannelTile with audio level meters, monitor/mute/TX controls
  - TopBar with time, PTT status, patch indicators
  - BottomBar with PTT button, tone buttons, emergency controls
  - UnitList showing online units by channel with status
  - EmergencyPanel for active emergencies and acknowledgement
  - EventLog for recent radio events
  - PatchPanel for channel patching configuration
  - Multi-channel TX: Select multiple channels for simultaneous transmission
  - Channel picker UI to add/remove channels from dispatch grid
  - Per-tone button locking (each tone locks independently during playback)
- Audio engines:
  - toneEngine.js: Dispatch tones (alert, MDC knock, 3-beep pre-alert, continuous) with hard start/stop
  - livekitEngine.js: Multi-room LiveKit connections for channel audio
- Tone types:
  - Alert (Tone A): 1-second 1000Hz sine wave
  - MDC (Tone B): 2-second alternating 1200/800Hz square wave
  - Pre-Alert (Tone C): 3-beep 1000Hz pattern for pre-alerting
  - Continuous: Aggressive 5-second alarm with 800/850Hz + LFO modulation
- State management via Zustand with localStorage persistence (uses arrays for JSON serialization)
- Routes:
  - `/dispatcher` - Dispatch Console
- Tone transmission: Tones are broadcast over LiveKit to all field units when a tone button is pressed. The system automatically keys up, transmits the tone, and releases.

### Phase 12 - LiveKit Cost Optimization
- Radio mode connects only to active/selected channel (not all channels)
- Dispatcher mode still connects to all channels (multi-channel monitoring)
- Scan mode: when enabled, connects to scanned channels list
- Idle timeout: 5 min inactivity disconnects from rooms to save costs
- Auto-reconnect on PTT press or channel change after idle disconnect
- Safari audio fix: mic pre-capture on connect enables RX audio playback (Safari autoplay policy workaround)

### Phase 11 - AI Voice Dispatcher
- Automated radio acknowledgement system using Azure Speech Services
- LiveKit bot that joins configured channel and listens for transmissions
- Call sign: "Central" - AI only responds when explicitly addressed
- Two-state interaction model:
  - STATE A (IDLE): Listens for wake phrase "Central, <UnitID>"
  - STATE B (AWAITING STATUS): After wake phrase, waits for valid status command
- Wake phrase detection: "Central, Indiana-1" → "Indiana-1, go ahead."
- Supported status commands (whitelist only):
  - on duty, en route, on scene, on location
  - available, off duty, out of service, clear
- Response format: "<UnitID>, <status>, HHMM hours." (e.g., "Indiana-1, on duty, 0712 hours.")
- 15-second timeout: Resets to IDLE silently if no valid status received
- Silence required when:
  - Toggle OFF, "Central" not spoken, malformed wake phrase
  - Status command not recognized, any error occurs
- Speech-to-Text (STT) transcribes incoming audio using Azure Speech SDK
- Text-to-Speech (TTS) generates audio responses via Azure Speech
- Safety guards:
  - Toggle OFF = zero transmissions (checked before every action)
  - Any error = silence + full shutdown (muted flag + disconnect)
  - Unmatched commands = silence (no response)
  - Multiple abort checkpoints during processing
  - No freeform AI responses or improvisation
- Admin UI toggle in Settings tab for immediate enable/disable
- Requires AZURE_SPEECH_KEY and AZURE_SPEECH_REGION secrets
- Backend services:
  - src/services/azureSpeechService.js - STT/TTS wrapper
  - src/services/commandMatcher.js - Two-state command matching with wake phrase detection
  - src/services/aiDispatchService.js - Main AI dispatcher with safety guards
- Database: ai_settings table with ai_dispatch_enabled flag

## Default Admin Credentials
- Username: admin (or ADMIN_USERNAME env var)
- Password: admin123 (or ADMIN_PASSWORD env var)
- Change these in production!
