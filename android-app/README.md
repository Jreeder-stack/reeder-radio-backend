# COMMAND COMMS Android App

Native Android wrapper for the PTT radio application using Capacitor.

## Prerequisites

- Android Studio (latest version)
- JDK 21+
- Node.js 18+

## Build Steps

### First-time setup

```bash
cd android-app
npm install
npm run build
npx cap add android
npx cap sync android
```

Then run the setup script **once** from the `android-app/` directory:

**Windows:**
```bat
setup-android.bat
```

**Mac / Linux:**
```bash
./setup-android.sh
```

The setup script:
- Copies all native Java/Kotlin source files into the Android project
- Copies all icons, splash screen, and resource files
- Copies the AndroidManifest.xml
- **Hooks Gradle** so that every subsequent build automatically re-copies everything from `android-config/` before compiling — no manual steps needed after this point

Then open in Android Studio and build:
```bash
npx cap open android
```
`Build → Build Bundle(s) / APK(s) → Build APK(s)`

APK output: `android/app/build/outputs/apk/debug/app-debug.apk`

---

### After updating web assets (`npx cap sync android`)

Re-run the setup script once to re-copy any changed native files and keep the Gradle hook in place:

```bat
setup-android.bat
```

Then build normally in Android Studio. The Gradle hook ensures all `android-config/` files are applied automatically on every build.

---

### Installing on device

```bash
# Uninstall old version first (required to clear cached icon)
adb uninstall com.reedersystems.commandcomms

# Install new APK
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

---

## How the Gradle hook works

`setup-android.bat` appends this line to `android/app/build.gradle`:

```groovy
apply from: '../../android-config/commandcomms.gradle'
```

`commandcomms.gradle` defines a `applyCcNativeConfig` task that copies all files from `android-config/` into the right Android project locations, then runs it via `preBuild.dependsOn`. This means every Android Studio build — including incremental builds — automatically syncs the native config.

---

## Background Service

The `BackgroundAudioService` keeps the app running when the screen is off:

- Shows a persistent notification while active
- Prevents the system from killing the app
- Maintains audio streaming capability
- Uses `FOREGROUND_SERVICE_MICROPHONE` for Android 14+

## Wake Lock

During active PTT transmission, a partial wake lock is acquired to prevent CPU sleep.

---

## Troubleshooting

### App stops when screen turns off

1. Verify `BackgroundAudioService` is registered in AndroidManifest.xml
2. Check that `BackgroundServicePlugin` is registered in MainActivity
3. Ensure FOREGROUND_SERVICE permissions are granted
4. Disable battery optimization for this app in device settings

### Plugin not found errors

Ensure all plugins are registered in `MainActivity.onCreate()` **before** `super.onCreate()`.

### Notification not showing

The foreground service requires a notification. If the custom icon is missing, a default system icon will be used. Check logcat for errors.

### `attempting to assign weaker access privileges; was public`

If Android build fails with:
- `onResume() in MainActivity cannot override onResume() in BridgeActivity`
- `onDestroy() in MainActivity cannot override onDestroy() in BridgeActivity`

Re-run `setup-android.bat` — it normalizes the lifecycle method access modifiers automatically.

### Accessibility service not appearing in Settings

Re-run `setup-android.bat` to ensure `res/xml/accessibility_service_config.xml` is in place, then rebuild. The Gradle hook keeps this in sync automatically on every subsequent build.

### Icon still showing old design after rebuild

Uninstall the old app from the device before installing — Android caches launcher icons aggressively:
```bash
adb uninstall com.reedersystems.commandcomms
```
