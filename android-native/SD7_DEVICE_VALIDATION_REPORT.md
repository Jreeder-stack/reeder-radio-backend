# Siyata SD7 Validation Report

This report mirrors `T320_DEVICE_VALIDATION_REPORT.md` style. It tracks
what is implemented in code (and verified at the source-set / merge / type
level) versus what requires a physical Siyata SD7 to confirm at runtime.

> **On the "no Gradle build" caveat.** The same caveat documented in
> `T320_DEVICE_VALIDATION_REPORT.md` applies here: this repo intentionally
> excludes `gradle-wrapper.jar`, so neither flavor's APK can be assembled
> from this isolated CI environment. Static verification (manifest merger
> rules, source-set FQN collisions, type-checking against the shared
> `main/` source set, BuildConfig generation) was performed by inspection
> against AGP's documented behavior.

---

## Implementation summary (Task #569)

The SD7 client is **not** a separate Android project. It is a Gradle
**product flavor** of the existing `android-native/` module so audio
transport, signaling, floor control, jitter buffer, Opus codec, paging,
emergency handling, and the entire dispatch backend are 100 % shared with
the T320 build. Only device-integration code (hardware key intents, OLED
status surface, indicator-LED driver, knob-press action, and the
`device_type` the radio reports to the backend) is SD7-specific.

### Build flavors (`android-native/app/build.gradle.kts`)

| flavor | applicationId                            | versionName | `BuildConfig.RADIO_DEVICE_TYPE` |
| ------ | ---------------------------------------- | ----------- | ------------------------------- |
| t320   | `com.reedersystems.commandcomms`         | `1.0`       | `"t320"`                        |
| sd7    | `com.reedersystems.commandcomms.sd7`     | `1.0-sd7`   | `"siyata_sd7"`                  |

`applicationIdSuffix = ".sd7"` lets both APKs install side-by-side on the
same test device. `RADIO_DEVICE_TYPE` is sent as the socket-auth
`deviceType` field (see `SignalingClient.kt`); the backend stores it
verbatim with no allowlist (`signalingService.js:514`) and surfaces it in
the admin Devices tab.

To build either APK:

```
./gradlew :app:assembleT320Debug   # default T320 build
./gradlew :app:assembleSd7Debug    # Siyata SD7 build
```

### Flavor source-set layout

```
android-native/app/src/
├── main/                                                # SHARED across all flavors
│   ├── AndroidManifest.xml                              # T320 PTT/SOS intent filters
│   └── java/com/reedersystems/commandcomms/
│       ├── KeyAction.kt                                 # +DpadCenter (SD7 knob press)
│       ├── MainActivity.kt                              # +KEY_DPAD_CENTER (23) handling
│       ├── CommandCommsApp.kt                           # +RadioFlavorLed.start(...)
│       ├── audio/PttHardwareReceiver.kt                 # T320 + SD7 broadcast mappings
│       ├── audio/led/RadioFlavorLed.kt                  # interface RadioFlavorLedDriver
│       ├── signaling/SignalingClient.kt                 # uses BuildConfig.RADIO_DEVICE_TYPE
│       ├── device/DeviceIdentity.kt                     # +Siyata sysprop fallbacks
│       └── ui/radio/RadioViewModel.kt                   # +DpadCenter → cycleStatus()
├── t320/                                                # T320-only overlays
│   └── java/.../audio/led/RadioFlavorLed.kt             # no-op (NotificationChannel LED)
│   └── java/.../ui/radio/RadioFlavorScreen.kt           # → existing RadioScreen
└── sd7/                                                 # SD7-only overlays
    ├── AndroidManifest.xml                              # Siyata PTT/SOS intent filters
    ├── res/values/strings.xml                           # app_name = "COMMAND COMMS SD7"
    └── java/.../
        ├── audio/led/RadioFlavorLed.kt                  # Siyata LED broadcasts
        ├── ui/radio/RadioFlavorScreen.kt                # → Sd7RadioStatusScreen
        └── ui/sd7/Sd7RadioStatusScreen.kt               # 128×64 OLED status UI
```

`AppNavigation` calls `RadioFlavorScreen(...)` instead of `RadioScreen(...)`.
Both flavors provide a `RadioFlavorScreen` Composable with the same
fully-qualified name and signature; the T320 implementation forwards to
the existing full-color `RadioScreen`, and the SD7 implementation forwards
to the new monochrome `Sd7RadioStatusScreen`. No flavor-conditional code
sits in `src/main/`.

---

## Implemented and verified at compile-time

| Area | What it does | Status |
| ---- | ------------ | ------ |
| Product flavors | T320 + SD7 with distinct application IDs and version names; both APKs co-install. | **Implemented** |
| `BuildConfig.RADIO_DEVICE_TYPE` | "t320" / "siyata_sd7" reported as `deviceType` over socket auth. Backend stores verbatim. | **Implemented** |
| Shared transport | Audio codec, jitter buffer, floor control, paging, emergency, dispatch backend untouched. | **Implemented** (zero diff in those files) |
| PTT / SOS broadcast filters (T320) | Original verified actions kept in original order. | **Unchanged** |
| PTT / SOS broadcast filters (SD7) | Wide-net Siyata actions appended in `PttHardwareReceiver` and merged into the manifest via `tools:node="merge"`. | **Implemented**; action strings need on-device confirmation |
| Knob-press action | `KEYCODE_DPAD_CENTER` (23) → `KeyAction.DpadCenter` → `RadioViewModel.cycleStatus()`. T320 hardware never emits this keycode so T320 behavior is unaffected. | **Implemented** |
| OLED status UI | `Sd7RadioStatusScreen` renders zone/channel, unit/signal/battery, TX/RX/IDLE banner, BUSY indicator, page-alert overlay, emergency overlay — using the production `RadioViewModel`. | **Implemented** |
| LED driver | `RadioFlavorLed` collects `RadioStateManager.state` from `CommandCommsApp.onCreate` and on SD7 emits Siyata LED broadcasts (off / red / green) on every TX/RX/IDLE transition. T320 stays a no-op (existing NotificationChannel light routing). | **Implemented**; broadcast action strings need on-device confirmation |
| Device identity | `DeviceIdentity` sysprop fallback list extended with Siyata-specific keys (`ro.siyata.serial`, `ro.siyata.serialno`, `ro.product.serial`, `ro.siyata.imei`, `persist.siyata.imei`). | **Implemented** |
| App label | `app_name` overridden in `src/sd7/res/values/strings.xml` to "COMMAND COMMS SD7" so the SD7 launcher icon and notifications are distinguishable from T320 on the same device. | **Implemented** |

---

## Requires on-hardware verification (cannot be tested in this environment)

This isolated CI environment has no Siyata SD7 attached. The matrix below
is what the on-device QA pass needs to confirm. The implementation already
sends a wide-net union of broadcast names, so most items are
"verify the right one fires" rather than "build the missing wiring".

### A. PTT / SOS broadcast strings

`PttHardwareReceiver` ships with a wide-net list of Siyata actions
(`com.siyata.sd7.PTT_DOWN/UP`, `com.siyata.intent.action.*`,
`com.siyata.ptt.*`, `com.siyata.sos.*`, all the `*_LONGPRESS` variants).
On first SD7 boot:

1. Run `adb logcat -s "[PTT-DIAG]"` while pressing PTT, releasing PTT,
   long-pressing PTT, and pressing/long-pressing SOS.
2. Note which action strings the receiver actually sees and which arm
   maps them — the receiver logs every `onReceive` call with its action
   plus `mapped action=... -> svcAction=...`.
3. Trim unused actions from `src/sd7/AndroidManifest.xml` and the SD7
   block in `PttHardwareReceiver.kt` once ground truth is known. Append
   the confirmed mappings to "Confirmed broadcasts" at the bottom of this
   report.

### B. Knob, knob-press, SOS keycodes

Wiring is already in place: `KEY_DPAD_CENTER` (23) is dispatched as
`KeyAction.DpadCenter` and consumed by `RadioViewModel.cycleStatus()`. QA
should confirm:

1. Knob rotation emits `KEYCODE_DPAD_UP`/`DPAD_DOWN`. (Already wired to
   `nextChannel()`/`prevChannel()`.)
2. Knob press emits `KEYCODE_DPAD_CENTER` (23). If it instead emits
   `KEYCODE_ENTER` (66) or a vendor keycode, add an `||` arm to the
   `KEY_DPAD_CENTER` branch in `MainActivity.handleKeyDown`.
3. SOS button emits one of the broadcast actions registered in the SD7
   manifest overlay. If the OEM dispatches it as a keycode instead, wire
   that keycode to `forwardEmergencyToBackgroundService(...)` the same way
   `isEmergencyKey` already handles `KEY_EMERGENCY` (233) on T320.

### C. OLED rendering

The 0.97" 128×64 OLED is monochrome but Compose renders into a standard
ARGB framebuffer; the OEM display driver dithers to mono. QA should:

1. Confirm `Sd7RadioStatusScreen` is legible end-to-end (zone/channel
   line, unit/signal/battery row, TX/RX/IDLE banner, BUSY, page-alert
   overlay, emergency overlay).
2. Verify the inverse TX/RX banner survives dithering. If it doesn't,
   switch the banner to a bordered outline (one-line code change in
   `Sd7RadioStatusScreen.kt`).
3. Capture a photo of each state (IDLE / TX / RX / BUSY / PAGE / EMERGENCY)
   for the OLED design follow-up task.

### D. Indicator-LED broadcast names

`RadioFlavorLed` (SD7) sends the LED state to three candidate broadcast
actions on every transition (`com.siyata.sd7.LED`,
`com.siyata.intent.action.LED`, `com.siyata.led.set`) with a wide set of
extras (`color`, `led_color`, `state`, `mode`, `on`). On hardware:

1. Watch `adb logcat -s "[RadioLED-SD7]"` while keying TX, releasing TX,
   and receiving inbound traffic.
2. Confirm the LED actually changes color. If none of the three
   broadcasts work, capture the broadcasts the OEM Siyata PTT app emits
   (logcat or `dumpsys activity broadcasts`) and add the confirmed action
   to the `LED_ACTIONS` list and any required extras.
3. Trim unused actions once ground truth is known.

### E. Device identity / sysprops

`DeviceIdentity` includes Siyata-specific sysprop fallbacks. After first
boot run `adb shell getprop | grep -i siyata` and tighten the lists in
`tryReadSerial()` / `tryReadImei()` to the keys that actually return a
value.

### F. Backend admin Devices tab

After first registration confirm an SD7 row appears with
`device_type = "siyata_sd7"`. The backend
(`src/services/signalingService.js:514`) stores `clientDeviceType`
verbatim with no allowlist, so this should work without backend changes —
verify the Devices tab UI renders unknown device types gracefully (it
currently does for `radio`, `desktop`, `cad`, `electron`, `android`).

---

## Confirmed broadcasts (to be filled in during validation)

| Action string | Source | Maps to |
| ------------- | ------ | ------- |
| _(populate from first-boot logcat)_ | | |

---

## Out of scope for this task

- Final visual design of `Sd7RadioStatusScreen` (icons, menu hierarchy,
  font sizing tuned to dithered output) — see follow-up #571.
- Vendor-specific LED broadcast tightening — see follow-up #572 once OEM
  broadcasts have been sniffed.
- A full menu UI driven by knob rotate + press (current SD7 knob press
  cycles unit status; a richer menu hierarchy is part of the design
  follow-up).
- Dispatch console UI changes (none — SD7 is a radio client only).
