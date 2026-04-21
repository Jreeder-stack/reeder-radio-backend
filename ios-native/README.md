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

## Background PTT — manual verification on real iOS hardware

The audio engine changes from Task #449 (silent keep-alive playback,
shared `AVAudioSession`, interruption / route-change / media-services-reset
handling) can only be exercised end-to-end on a real device — the iOS
Simulator does not honor the `audio` / `voip` background modes accurately
and MFi / Bluetooth PTT accessories are device-only. Run the test plan
below before each release and record the results in the table at the
bottom of this section.

### Pre-flight
- Build a **Release** configuration onto the device from Xcode (Debug
  builds are kept alive by the debugger and will mask real suspension
  behavior).
- Sign in, join the test channel, and confirm RX/TX work in the
  foreground first.
- Disconnect from Xcode before starting the timed tests so the OS treats
  the app as a normal user-launched process.
- Have a second radio (Android client or a second iOS device on a
  different account) ready to send periodic test traffic.

### Test plan

For each row, "PASS" means RX audio is heard within ~1 s of the remote
keying up, with no need to bring the app back to the foreground; for TX
rows, "PASS" means the keyed audio is received cleanly by the other
radio.

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Screen-off RX | Lock the device with the app open; have the other radio TX every 30 s for 10 minutes. | Every transmission is heard with the screen off. |
| 2 | Backgrounded RX (home button / swipe up) | Send the app to the home screen; have the other radio TX every 30 s for 10 minutes. | Every transmission is heard. |
| 3 | Long-idle RX | Background the app and stay completely silent (no test traffic) for 15 min, 30 min, 60 min. After each interval, have the other radio TX. | TX is heard. Record the longest silent interval after which RX still recovers without the user re-foregrounding. |
| 4 | BT-PTT TX while backgrounded | Pair an MFi / BT PTT accessory; background the app; key the accessory. | Other radio receives the transmission; talk-permit tone (if enabled) plays in-ear. |
| 5 | Phone call interruption | While backgrounded with traffic flowing, accept an inbound phone call, talk for ~30 s, hang up. | RX resumes within a few seconds of the call ending without re-foregrounding. |
| 6 | Siri interruption | Long-press side button to invoke Siri, ask the time, dismiss. | RX resumes immediately after Siri dismisses. |
| 7 | Headphone / BT unplug | While RX is playing through wired headphones or BT, unplug / disconnect mid-transmission. | Audio re-routes to the speaker (or remaining BT device) and continues without a manual restart. |
| 8 | Headphone / BT plug-in | While RX is playing through the speaker, plug in wired headphones or connect BT. | Audio re-routes to the new device and continues. |
| 9 | `mediaServicesWereReset` recovery | Reproduce by toggling Airplane Mode + Bluetooth in rapid succession, or use the private `notifyMediaServicesWereReset` test hook in a debug build. | App logs `mediaServicesWereReset — rebuilding` and resumes RX without a manual restart. |
| 10 | Cold-start after long suspension | Leave the app backgrounded overnight; in the morning, have the other radio TX. | Either RX resumes (best case) or the app reconnects within a few seconds of being foregrounded; record which. |

### Known and expected iOS platform limits

These are limits imposed by iOS itself; they are not bugs in the radio
client and dispatchers should be aware of them.

- **Pure-silence suspension.** The `audio` background mode keeps the
  process alive only as long as iOS believes we are producing audio.
  We schedule short silent buffers (`AudioPlayback.keepAlive*`) to keep
  the engine attributed as "playing", but Apple does not contractually
  promise an unbounded background lifetime. In practice the process can
  still be suspended after long idle periods, low-memory pressure, or
  thermal pressure. Record the observed limit in row #3 above; current
  field reports cluster around **30–60 minutes** before suspension on
  iPhone 13/14/15 class devices.
- **No background launch from PTT.** If iOS has fully suspended the app,
  pressing a BT-PTT button will **not** cold-launch it. The user must
  re-foreground the app to re-key the radio. The `voip` background mode
  keeps the signaling socket alive longer than `audio` alone, but is
  not a guaranteed wake source for accessory input.
- **MFi accessories only.** Generic Bluetooth HID "media" buttons are
  routed to the system (play/pause, volume) and are **not** delivered
  to third-party apps. Only accessories that implement the MFi
  ExternalAccessory or Apple's Game Controller HID profile (with the
  protocol declared in `UISupportedExternalAccessoryProtocols`) can
  drive PTT from the background.
- **Phone calls fully suspend audio I/O.** During an active CallKit /
  cellular call, `AVAudioSession` is owned by the system; the radio
  cannot RX or TX. The engine resumes from the interruption-ended
  notification once the call ends (handled in `AudioSessionManager`).
- **Siri / alarms / timers** trigger the same interruption flow as a
  phone call but are typically short. Recovery is automatic.
- **`mediaServicesWereReset`** is rare but unrecoverable without a full
  rebuild of every `AVAudioEngine` instance — handled by
  `AudioSessionManager.handleMediaServicesReset` plus `AudioPlayback`
  / `AudioCapture` `restart()` calls. If it ever fires while the app
  is suspended, recovery happens on next foreground.
- **Locked-device microphone access** is permitted because we declare
  both `audio` and `voip` background modes and use
  `.playAndRecord` / `.voiceChat`. There is no separate "record in
  background" entitlement to add.
- **Battery cost.** The silent keep-alive plus an always-active
  `.playAndRecord` session is more expensive than a foreground-only
  app. Expect a measurable battery drain over a multi-hour shift; this
  is inherent to push-to-talk on iOS and not specific to this client.

### Results log

Append a row per device + iOS version tested. Keep entries terse — link
to a longer note in the PR description if needed.

| Date | Device | iOS | Build | Tester | #1 | #2 | #3 (max silent) | #4 | #5 | #6 | #7 | #8 | #9 | #10 | Notes |
|------|--------|-----|-------|--------|----|----|------------------|----|----|----|----|----|----|-----|-------|
| _TBD_ | iPhone 15 Pro | 18.x | _TBD_ | _TBD_ | – | – | – | – | – | – | – | – | – | – | First real-device pass pending. |

> Note: as of this writing no real-device pass has been recorded. The
> simulator was used only to confirm the code paths compile and that
> the interruption / route-change observers fire on synthetic
> notifications. Field results from at least one current iPhone must
> be filled into the table above before this verification is
> considered complete.

## Out of scope for this task
UDP audio transport, Opus encode/decode, jitter buffer, AGC/noise
suppression, hardware/MFi PTT, scan monitor, paging tone overlay,
emergency button, and live GPS reporting. Each will land in a follow-up
task that builds on this foundation.
