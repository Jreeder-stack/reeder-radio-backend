# Anysecu HD760 hardware key discovery

This standalone Android 7.1-compatible diagnostic app is the **first test
APK**, not yet the Command Communications operational PoC client.

The HD760 is reported with Android 7.1 (API 25) and a non-touch keypad.
The existing native Command Communications app has minSdk 26 and cannot
be installed on API 25 as currently configured. Do not change shared
T320/SD7 app compatibility or verified key mappings to work around this.

This application:
- Shows manufacturer, device model, Android release, and API level.
- Shows physical Android key DOWN/UP with keycode, scan code and input.
- Watches documented Zello/generic broadcast action candidates while open.
- **Does not** request microphone permission or transmit any audio.
- Does not assign arbitrary keys to PTT, emergency, or channel change.

## Build

From the repository root with Android SDK 34, JDK 17, Gradle 8.6:

```sh
gradle -p hd760-keytest :app:assembleDebug
```

APK path: `hd760-keytest/app/build/outputs/apk/debug/app-debug.apk`

The GitHub Actions workflow `Build HD760 Key Test APK` runs for changes
on this hardware-test branch and publishes the `command-comms-hd760-keytest`
artifact. It deliberately does not modify existing app flavors.

## Install and capture evidence (Windows PowerShell)

Connect radio over a **data-capable USB cable**, enable USB debugging and
authorize the computer on the device. Confirm:

```powershell
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
& $adb devices
& $adb shell getprop ro.build.version.release
& $adb shell getprop ro.build.version.sdk
& $adb install -r ".\app-debug.apk"
& $adb shell monkey -p com.reedersystems.commandcomms.hd760keytest -c android.intent.category.LAUNCHER 1
& $adb logcat -c
& $adb logcat -v time -s "CC-HD760:I" "*:S"
```

With the test app visible, record **press and release**, not only press:
1. Big side PTT.
2. Top channel knob, one step clockwise then counterclockwise.
3. Each smaller side button, short then long press.
4. Front navigation arrows, OK, back, green/red handset, numeric keys.
5. Rotate power/volume knob gently (do not turn the radio off).

Stop logcat with Ctrl+C. Send us the output, or save to a text file.
If a key causes no event, collect raw input while pressing it:

```powershell
& $adb shell getevent -lt
```

Some manufacturer controls may be consumed by Android system services.
Missing key events do NOT prove the hardware is unprogrammable.
On-device SDK documentation or OEM configuration may be necessary for
events, background/screen-off PTT, and channel knob positions.

## Subsequent operational APK

Use observed key/broadcast evidence and confirmed Android API to add an
HD760 product flavor and keypad-first UX to the existing
`android-native/` Command Communications app, while preserving
verified T320/SD7 behavior and shared authenticated audio/floor control.
This diagnostic APK does not claim those functions are working.
