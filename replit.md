# Reeder Radio PTT

## Overview
A Push-to-Talk (PTT) radio communication app using LiveKit for real-time audio streaming. Fullstack application with React frontend and Express backend.

## Project Structure
```
/
├── server.js          # Express backend - auth, admin API, LiveKit tokens
├── db.js              # PostgreSQL database setup and queries
├── package.json       # Backend dependencies
├── client/            # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx        # Main PTT interface component
│   │   ├── Dispatcher.jsx # Dispatcher console (multi-channel monitoring)
│   │   ├── Login.jsx      # Login/register screen
│   │   ├── Admin.jsx      # Admin dashboard (users, channels, logs)
│   │   ├── AuthContext.jsx # Auth state management
│   │   └── main.jsx       # React entry point with protected routing
│   ├── vite.config.js # Vite configuration with proxy to backend
│   ├── index.html     # HTML entry point
│   └── package.json   # Frontend dependencies
```

## Environment Variables

### Required Secrets:
- `LIVEKIT_API_KEY` - LiveKit API key
- `LIVEKIT_API_SECRET` - LiveKit API secret  
- `LIVEKIT_URL` - LiveKit server URL (wss://...)
- `SESSION_SECRET` - Required in production for secure sessions

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
- "Radio effect" toggle with narrowband filter (300Hz-3400Hz)
- Per-channel audio level meters (TX and RX)
- Recording last RX with playback capability

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
  - `/dispatcher` - New Dispatch Console (replaces legacy)
  - `/dispatcher-legacy` - Original dispatcher view
- Known limitation: Tones play locally on dispatcher console. Broadcasting tones over LiveKit requires WebRTC MediaStream routing which is not yet implemented.

## Default Admin Credentials
- Username: admin (or ADMIN_USERNAME env var)
- Password: admin123 (or ADMIN_PASSWORD env var)
- Change these in production!
