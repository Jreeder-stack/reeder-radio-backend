# Command Comms — iOS Radio Client (Foundation)

Native iOS push-to-talk client that mirrors the Android radio client. This
foundation task delivers only the project skeleton, login, and signaling
connection. UDP audio, Opus codec, MFi/hardware PTT, paging, emergency, and
location reporting are layered on in subsequent tasks.

## Requirements
- macOS with **Xcode 15 or newer**
- iOS 17+ Simulator (iPhone)

## Open & Run
1. Clone this repo on a Mac.
2. Open `ios-native/CommandComms.xcodeproj` in Xcode 15+.
3. The first build will fetch two Swift Package Manager dependencies:
   - [`socket.io-client-swift`](https://github.com/socketio/socket.io-client-swift) (16.x)
   - [`KeychainAccess`](https://github.com/kishikawakatsumi/KeychainAccess) (4.x)
   Wait for "Resolving Package Graph" to finish.
4. Select an **iPhone 15** (or any iOS 17+) simulator and press **⌘R**.

## Configuring the signaling URL
The signaling/auth server URL is stored in `UserDefaults` and editable
both from the Login screen and the Settings tab. Defaults to
`https://comms.reeder-systems.com`.

| Environment | Signaling URL                                  |
| ----------- | ---------------------------------------------- |
| Production  | `https://comms.reeder-systems.com`             |
| Local dev   | `http://<your-mac-lan-ip>:5000`                |
| Replit dev  | `https://<your-replit>.replit.dev`             |

Production traffic uses HTTPS. App Transport Security stays enabled by
default; the bundled Info.plist only carves out scoped HTTP exceptions for
`localhost` and `*.local` so the simulator can reach a Mac dev server. To
hit a non-`.local` LAN IP over plain HTTP for testing, add it to the
`NSExceptionDomains` dictionary in `CommandComms/Resources/Info.plist` —
do not re-enable `NSAllowsArbitraryLoads` globally.

## What is wired up
- **Login screen** mirroring the Android `LoginScreen`. POSTs
  `/api/auth/login`. On success the session cookie returned by the backend
  and the user record are persisted in the **iOS Keychain** (via
  `KeychainAccess`). Subsequent launches restore the session through
  `/api/auth/me` and skip the login screen.
- **Signaling client** — wraps `socket.io-client-swift`, connects to the
  `/signaling` namespace, performs the `authenticate` handshake, and joins
  a default channel after auth completes. Connection state is exposed as
  an `@Published` property and shown on the Radio screen.
- **Radio screen** — placeholder UI showing connection state, current
  channel, channel-join control, and static TX/RX/PTT indicators.
- **Settings screen** — edit signaling URL and default channel ID, sign
  out, view account info.
- **Device Registration screen** — placeholder showing the device
  identifier; will host MFi/hardware-PTT pairing in a future task.

## Info.plist capabilities (already declared)
The following permissions and background modes are pre-declared so future
audio/PTT/location tasks don't require re-provisioning:

| Key                                            | Reason                              |
| ---------------------------------------------- | ----------------------------------- |
| `NSMicrophoneUsageDescription`                 | PTT capture (future task)           |
| `NSLocationWhenInUseUsageDescription`          | Foreground location (future task)   |
| `NSLocationAlwaysAndWhenInUseUsageDescription` | Background location (future task)   |
| `UIBackgroundModes` → `audio`                  | Continuous RX while backgrounded    |
| `UIBackgroundModes` → `voip`                   | Long-lived signaling socket         |
| `UIBackgroundModes` → `location`               | Background GPS reporting            |
| `UIBackgroundModes` → `external-accessory`     | MFi PTT accessories (future task)   |
| `UIBackgroundModes` → `remote-notification`    | FCM/APNs paging (future task)       |
| `UISupportedExternalAccessoryProtocols`        | Empty array; protocols added later  |

## Project layout
```
ios-native/
├── CommandComms.xcodeproj/
└── CommandComms/
    ├── App/                  # @main entry, AppState, root shell
    ├── Features/
    │   ├── Login/
    │   ├── Radio/
    │   ├── Settings/
    │   └── DeviceRegistration/
    ├── Networking/           # ApiClient, AuthService, SignalingClient
    ├── Models/               # User, etc.
    ├── Storage/              # KeychainStore, AppPreferences
    └── Resources/            # Info.plist, Assets.xcassets
```

## Out of scope for this task
UDP audio transport, Opus encode/decode, jitter buffer, AGC/noise
suppression, hardware/MFi PTT, scan monitor, paging tone overlay,
emergency button, and live GPS reporting. Each will land in a follow-up
task that builds on this foundation.
