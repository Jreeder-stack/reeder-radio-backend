# Reeder Radio PTT

## Overview
A Push-to-Talk (PTT) radio communication app using LiveKit for real-time audio streaming. Fullstack application with React frontend and Express backend.

## Project Structure
```
/
├── server.js          # Express backend - generates LiveKit access tokens, serves static files
├── package.json       # Backend dependencies (express, livekit-server-sdk, cors, dotenv)
├── client/            # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx    # Main PTT interface component
│   │   └── main.jsx   # React entry point
│   ├── vite.config.js # Vite configuration with proxy to backend
│   ├── index.html     # HTML entry point
│   └── package.json   # Frontend dependencies (react, livekit-client)
```

## Environment Variables

### Required Secrets:
- `LIVEKIT_API_KEY` - LiveKit API key
- `LIVEKIT_API_SECRET` - LiveKit API secret  
- `LIVEKIT_URL` - LiveKit server URL (wss://...)

### Frontend Environment (development):
- `VITE_LIVEKIT_URL` - LiveKit server URL for browser client

## Running Locally (Replit)

Both workflows run automatically:
1. **Backend API** - `npm start` (port 3001)
2. **Frontend** - `cd client && npm run dev` (port 5000)

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
