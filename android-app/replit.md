# COMMAND COMMUNICATIONS by REEDER-SYSTEMS

## Overview

This is a mission-critical communications web application built as a React frontend with an Express backend. The app provides Push-To-Talk (PTT) radio communications, channel selection, presence tracking, and emergency alerting functionality. It connects to an external backend at `https://comms.reeder-systems.com` for authentication, channels, presence data, and LiveKit token minting for real-time voice.

The UI is designed to mimic a native Android app experience with a mobile-first approach. Users can choose between two interface styles:
- **Phone**: Standard tactical interface with cyan accents, dark theme, and mobile frame on desktop
- **Radio**: Hardware radio-style interface with white/black LCD-style display and physical button layout (up/down arrows, scan, emergency, settings)

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight React router)
- **State Management**: TanStack React Query for server state, React Context for radio/PTT state
- **UI Components**: shadcn/ui component library with Radix UI primitives
- **Styling**: Tailwind CSS v4 with custom CSS variables for theming
- **Animations**: Framer Motion for PTT button interactions

### Backend Architecture
- **Runtime**: Node.js with Express
- **Purpose**: Acts as a BFF (Backend for Frontend) proxy to the external comms backend
- **Session Management**: In-memory session token storage (should be Redis in production)
- **API Pattern**: All external API calls go through `/api/*` routes which proxy to `https://comms.reeder-systems.com`

### Key Design Patterns
- **Proxy Pattern**: The Express server proxies requests to the external backend, keeping API tokens server-side
- **Fallback Data**: Frontend uses fallback mock data when backend is unavailable for graceful degradation
- **Mobile-First UI**: The MobileFrame component provides consistent mobile app-like experience across devices

### Database Schema
- Uses Drizzle ORM with PostgreSQL
- Currently minimal schema with just a `users` table (id, username, password)
- Schema location: `shared/schema.ts`

### Audio System
- Web Audio API for PTT tones (talk permit, busy, end of transmission)
- Radio context manages scanning, emergency state, and transmission state globally

## External Dependencies

### External Services
- **Backend API**: `https://comms.reeder-systems.com` - Handles authentication, channels, presence, LiveKit tokens, emergency alerts, location upload
- **LiveKit**: Real-time voice communication (token minted by backend)

### Database
- PostgreSQL via Drizzle ORM
- Connection configured via `DATABASE_URL` environment variable
- Migrations output to `./migrations` directory

### Key NPM Packages
- `@tanstack/react-query` - Server state management
- `drizzle-orm` / `drizzle-zod` - Database ORM and validation
- `framer-motion` - Animations
- `wouter` - Client-side routing
- `livekit-client` (expected) - Real-time voice
- Radix UI primitives - Accessible UI components

### Build Tools
- Vite for frontend bundling
- esbuild for server bundling
- TypeScript throughout

## Native Android App (Capacitor)

### Configuration
- **App ID**: `com.reedersystems.commandcomms`
- **App Name**: COMMAND COMMS
- **Config File**: `capacitor.config.ts`

### Capacitor Utilities (`client/src/lib/capacitor.ts`)
- Settings persistence (background GPS, GPS frequency, background audio, alert sounds, PTT key mapping)
- Location permissions and tracking with Capacitor Geolocation plugin
- Local notifications via Capacitor Local Notifications plugin
- App lifecycle management (pause/resume events)
- Hardware PTT key interfaces for native plugin

### Native Android Files (`android-config/`)
- `README.md` - Build instructions and Android permissions
- `MainActivity.java` - Main activity with hardware key capture
- `HardwarePttPlugin.java` - Capacitor plugin for volume/Bluetooth PTT keys
- `BackgroundAudioService.java` - Foreground service for background audio/GPS
- `LiveKitPlugin.kt` - Native LiveKit SDK wrapper (Kotlin) for reliable PTT audio

### Native LiveKit Integration
The Android app uses a native LiveKit SDK plugin instead of the web SDK to bypass WebView's WebRTC DataChannel issues. Key components:
- `android-config/LiveKitPlugin.kt` - Kotlin Capacitor plugin with coroutine support
- `client/src/lib/native-livekit.ts` - TypeScript interface for native plugin
- `client/src/hooks/use-livekit-combined.ts` - Hook that auto-selects native vs web SDK
- Requires Kotlin and LiveKit Android SDK dependencies in build.gradle

### Building the Android APK
1. Run `npm run build` to build the web app
2. Run `npx cap add android` (first time only)
3. Run `npx cap sync android`
4. Copy files from `android-config/` to the Android project
5. Open in Android Studio: `npx cap open android`
6. Build APK from Android Studio

### Settings Page (`/settings`)
- Background GPS toggle with permission request
- GPS update frequency selector (10s, 30s, 1m, 5m)
- Background audio toggle for PTT when minimized
- Hardware PTT key capture (volume buttons, Bluetooth accessories)
- Alert sounds toggle
- Do Not Disturb Override (Android native only):
  - Requests system permission to bypass DND
  - Granular controls for Emergency button, CAD priority events, Officer down alerts
  - Permission status verified on app resume and window focus
  - Uses module-level state to avoid React closure issues
- Logout button

### Location Tracking
- Uses `client/src/hooks/use-location.ts`
- Automatically uses Capacitor APIs on native, browser geolocation on web
- Respects user settings for enabled/disabled and update frequency
- Listens for `settings-changed` events to restart tracking on config changes
- Uploads to `/api/location` endpoint