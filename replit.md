# Reeder Radio PTT

## Overview
A Push-to-Talk (PTT) radio communication app using LiveKit for real-time audio streaming. This is a fullstack application with a React frontend and Express backend.

## Project Structure
```
/
├── server.js          # Express backend - generates LiveKit access tokens
├── package.json       # Backend dependencies
├── client/            # React frontend (Vite)
│   ├── src/
│   │   ├── App.jsx    # Main PTT interface component
│   │   └── main.jsx   # React entry point
│   ├── vite.config.js # Vite configuration with proxy to backend
│   └── package.json   # Frontend dependencies
```

## Architecture

### Backend (Express - Port 3001)
- Provides `/getToken` endpoint for LiveKit access token generation
- Uses `livekit-server-sdk` to create JWT tokens for room access
- Runs on port 3001, proxied through the frontend

### Frontend (React/Vite - Port 5000)
- React app with LiveKit client integration
- Push-to-Talk interface with channel selection
- Vite dev server proxies `/getToken` requests to backend

## Environment Variables

### Required Secrets (already configured):
- `LIVEKIT_API_KEY` - LiveKit API key
- `LIVEKIT_API_SECRET` - LiveKit API secret  
- `LIVEKIT_URL` - LiveKit server URL (wss://...)

### Frontend Environment:
- `VITE_LIVEKIT_URL` - LiveKit server URL for browser client

## Running the App

Both workflows run automatically:
1. **Backend API** - `npm start` (port 3001)
2. **Frontend** - `cd client && npm run dev` (port 5000)

## Features
- Unit ID-based authentication
- Multiple channel support (OPS1, OPS2, TAC1, TAC2)
- Push-to-Talk audio transmission
- Live participant tracking
