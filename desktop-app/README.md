# Command Communications Desktop App

Electron desktop wrapper for the Command Communications dispatch console with **per-channel global PTT hotkeys** that work even when the app is minimized or behind other windows.

## Features

- **Per-Channel PTT Hotkeys** — assign a modifier+key combo (Ctrl+1, Shift+F1, Alt+2, etc.) to each channel. Press to start transmitting on that channel, press again to stop. Works system-wide.
- **Global Emergency Hotkey** (default: Ctrl+Shift+E) — triggers emergency from anywhere.
- **Channel Dropdown** — settings screen fetches available channels from the server and shows them in a dropdown for easy assignment.
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

Each channel gets its own global hotkey (modifier+key combo). When you press a channel's hotkey:
1. The app temporarily switches the TX channel to the mapped channel
2. PTT starts immediately — the app stays in the background
3. Press the same hotkey again to stop transmitting
4. The previous TX channel selection is automatically restored

Spacebar continues to work as PTT for the currently selected TX channels when the app is focused.

## Hotkey Requirements

All hotkeys must include at least one modifier key:
- **Ctrl** (or Cmd on Mac)
- **Shift**
- **Alt**

Single keys without modifiers are rejected to prevent accidental activation. Examples:
- Ctrl+1, Ctrl+2, Ctrl+3 (for channels)
- Shift+F1, Shift+F2 (for channels)
- Ctrl+Shift+E (emergency)

## Configuration

Settings are stored in the user's app data directory and persist across updates:
- **Windows:** `%APPDATA%/command-comms-desktop/config.json`
- **Mac:** `~/Library/Application Support/command-comms-desktop/config.json`
- **Linux:** `~/.config/command-comms-desktop/config.json`
