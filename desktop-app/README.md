# Command Communications Desktop App

Electron desktop wrapper for the Command Communications dispatch console with **global PTT hotkeys** that work even when the app is minimized or behind other windows.

## Features

- **Global PTT Hotkey** (default: F5) — press to start transmitting, press again to stop. Works system-wide.
- **Global Emergency Hotkey** (default: F6) — triggers emergency from anywhere.
- **Always on Top** — keep the dispatch console above other windows.
- **Minimize to Tray** — keeps running in the system tray when closed.
- **Configurable Server URL** — point to any Command Communications server.
- **Settings** — accessible from File > Settings or Ctrl+,

## Setup

### Prerequisites
- Node.js 18+ installed on your build machine
- npm or yarn

### Install Dependencies
```bash
cd desktop-app
npm install
```

### Run in Development
```bash
npm start
```

### Build Installer

**Windows (.exe):**
```bash
npm run dist:win
```

**Mac (.dmg):**
```bash
npm run dist:mac
```

**Linux (.AppImage):**
```bash
npm run dist:linux
```

Built installers will be in the `dist/` folder.

## How PTT Works

- **When the app is focused:** The global hotkey triggers PTT like normal hold-to-talk. Releasing focus auto-releases PTT.
- **When the app is NOT focused:** The global hotkey works as a toggle — press once to start transmitting (the app will come to the foreground), press again to stop.
- **Spacebar** continues to work as PTT when the app is focused, same as the web version.

## Default Hotkeys

| Action | Default Key |
|--------|------------|
| PTT (Push-to-Talk) | F5 |
| Emergency | F6 |

You can change these in Settings (File > Settings or Ctrl+,). Any key or key combination (e.g., Ctrl+Shift+T) can be mapped.

## Configuration

Settings are stored in the user's app data directory and persist across updates:
- **Windows:** `%APPDATA%/command-comms-desktop/config.json`
- **Mac:** `~/Library/Application Support/command-comms-desktop/config.json`
- **Linux:** `~/.config/command-comms-desktop/config.json`
