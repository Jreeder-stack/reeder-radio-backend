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
- **Real-time Communication:** LiveKit is central for real-time audio streaming and data channel communication, enabling features like unit presence, emergency signals, and tone broadcasting.
- **Audio Processing:** The Web Audio API is used for advanced Digital Signal Processing (DSP) including Automatic Gain Control (AGC), noise suppression, and a transmit compressor. Features like PTT Release Reliability, Feedback Loop Prevention, and Authorization/Busy Tones enhance the audio experience.
- **Authentication & Authorization:** Username/password authentication with bcrypt hashing and session management. Role-based access control protects routes for users, dispatchers, and administrators. Default admin credentials are provided for initial setup.
- **State Management:** Zustand stores manage application state for channels, units, and dispatcher settings on the frontend.
- **AI Voice Dispatcher:** Integrates Azure Speech Services (Speech-to-Text and Text-to-Speech) for automated radio acknowledgments. Uses an intent-driven state machine with per-unit conversation sessions. Supports comprehensive dispatcher functions including:
  - **Status Commands:** on duty, available, en route, on scene, off duty, out of service, clear (with 10-codes)
  - **Immediate Commands:** radio check, time check, backup request, welfare check, tow/wrecker request, supervisor request, EMS/fire request, K9 request, subject in custody, negative contact, meal break
  - **Multi-Step Commands:** traffic stop (prompts for location), run plate (queries CAD), warrant check (queries CAD), BOLO broadcast, vehicle pursuit
  - **Emergency Commands:** Signal 100 (emergency traffic only), Signal 100 clear
  - **CAD Integration:** Automatic status updates, broadcast messages, vehicle/person/warrant queries via external CAD API
  - Safety guards prevent unintended transmissions and errors. Time format uses 24-hour with colon (e.g., "15:46 hours").
- **Cost Optimization:** LiveKit connections are optimized by connecting units only to active/selected channels (or scanned channels). An idle timeout feature disconnects users from rooms after inactivity, with automatic re-connection on activity.

### Feature Specifications
- **Core PTT:** Unit ID-based authentication and Push-to-Talk audio transmission.
- **Talkgroup System:** Organized into zones (Operations, Fire, Secure Command) with channel switching and scan mode capabilities.
- **Unit Presence:** Real-time unit status (idle, transmitting, emergency) with visual indicators and last transmission timestamps, synced via LiveKit data channels.
- **Emergency Button (E-Button):** Activates a 10-second transmit lock, broadcasts an emergency flag, displays flashing alarms, and allows acknowledgment/cancellation by dispatchers/units.
- **Dispatcher Console:** A dedicated interface for multi-channel monitoring, unit lists, per-channel audio controls (mute, level meters, TX selector), last transmission recall, emergency acknowledgment, and channel patching. Supports multi-channel TX and tone broadcasting.
- **Admin System:** Dashboard for user management (roles, blocking, dispatcher access), channel management (enable/disable), and activity logging.

## External Dependencies
- **LiveKit:** Real-time audio streaming and data channel communication.
- **PostgreSQL:** Primary database for user, channel, and activity log data.
- **Azure Speech Services:** Used by the AI Voice Dispatcher for Speech-to-Text (STT) and Text-to-Speech (TTS) functionalities.
- **`dnd-kit`:** For drag-and-drop channel grid functionality in the Dispatcher Console.
- **`bcrypt`:** For password hashing.
- **`connect-pg-simple`:** For PostgreSQL-backed session management.
- **TailwindCSS v4:** Frontend styling and utility-first CSS framework.
- **Zustand:** Frontend state management library.