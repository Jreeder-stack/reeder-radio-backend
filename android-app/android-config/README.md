# COMMAND COMMS - Android Native Configuration

This directory contains configuration and instructions for building the native Android app with Capacitor.

## PTT Architecture

### Primary Path (Service-Level — works with screen off, app backgrounded, activity destroyed)

```
PTT button press
  → android.intent.action.PTT.down/up (firmware broadcast)
  → PttBroadcastReceiver.onReceive()
  → BackgroundAudioService.getInstance().handlePttDown() / handlePttUp()
  → LiveKitPlugin.getInstance().startTransmit() / stopTransmit()
  → LiveKit audio track published / unpublished (native SDK)
  → HTTP POST /api/ptt/start or /api/ptt/end (non-blocking signaling)
```

### Foreground Bonus Path (redundant zero-latency when app is in foreground)

```
PTT key event
  → MainActivity.dispatchKeyEvent()
  → BackgroundAudioService.handlePttDown() / handlePttUp() (same as above)
  → HardwarePttPlugin.handleKeyEvent() (UI sync only)
  → JS notifyListeners pttDown/pttUp (WebView UI update)
```

### Key Design Principles

1. **PTT does NOT depend on MainActivity, WebView, or JS bridge**
   - BackgroundAudioService owns PTT state (IDLE / TRANSMITTING)
   - LiveKitPlugin exposes native `startTransmit()` / `stopTransmit()` without PluginCall
   - PttBroadcastReceiver calls service directly, never brings activity to front

2. **Cold-start handling**
   - If BackgroundAudioService instance is null, PttBroadcastReceiver starts the service via intent with `ptt_action` extra
   - `onStartCommand()` processes PTT intent extras and calls `handlePttDown()` / `handlePttUp()`

3. **Backend signaling is fire-and-forget**
   - HTTP POST to `/api/ptt/start` and `/api/ptt/end` bridges into Socket.IO
   - If these calls fail, native audio TX still works normally

4. **UI sync is optional**
   - After native TX starts/stops, `notifyPttStateFromService()` updates HardwarePttPlugin → JS
   - If WebView/Activity is unavailable, sync is silently skipped

### Diagnostic Logging

All PTT chain events are logged with the `PTT-DIAG` tag.

```bash
adb logcat -s PTT-DIAG
```

**Expected output — Screen-off PTT press:**
```
PTT-DIAG: PttBroadcastReceiver.onReceive() — action=android.intent.action.PTT.down screenOn=false
PTT-DIAG: PTT DOWN broadcast received
PTT-DIAG: CPU wake lock acquired for PTT broadcast
PTT-DIAG: Service instance AVAILABLE — calling handle directly, action=down
PTT-DIAG: handlePttDown() — currentState=IDLE
PTT-DIAG: handlePttDown() — LiveKitPlugin=true connected=true
PTT-DIAG: handlePttDown() — state → TRANSMITTING
PTT-DIAG: startTransmit() called — connected=true, room=true, channel=...
PTT-DIAG: startTransmit() SUCCESS — audio track published to ...
PTT-DIAG: handlePttDown() — startTransmit() result=true
PTT-DIAG: sendPttSignaling(start) — HTTP 200
PTT-DIAG: notifyUiPttState(true) — HardwarePttPlugin not available, UI sync skipped
```

**Expected output — PTT release:**
```
PTT-DIAG: PttBroadcastReceiver.onReceive() — action=android.intent.action.PTT.up screenOn=false
PTT-DIAG: PTT UP broadcast received
PTT-DIAG: Service instance AVAILABLE — calling handle directly, action=up
PTT-DIAG: handlePttUp() — currentState=TRANSMITTING
PTT-DIAG: handlePttUp() — state → IDLE
PTT-DIAG: stopTransmit() called — connected=true, mic=true
PTT-DIAG: stopTransmit() SUCCESS — audio track unpublished
PTT-DIAG: handlePttUp() — stopTransmit() result=true
PTT-DIAG: sendPttSignaling(end) — HTTP 200
```

**Expected output — Cold-start (service killed):**
```
PTT-DIAG: PttBroadcastReceiver.onReceive() — action=android.intent.action.PTT.down screenOn=false
PTT-DIAG: Service instance NULL — cold-starting service with intent extra, action=down
PTT-DIAG: BackgroundAudioService CREATED — instance set, isRunning=true
PTT-DIAG: Service received PTT via intent extra: action=down
PTT-DIAG: handlePttDown() — currentState=IDLE
```

## Prerequisites

1. Android Studio installed (latest version recommended)
2. Android SDK (API 33+)
3. Node.js 18+
4. JDK 21+ (required for Gradle 8.9+)
5. Gradle 8.9+ (Android Studio will prompt to update if needed)

## Build Steps

### 1. Build the web app
```bash
npm run build
```

### 2. Add Android platform (first time only)
```bash
npx cap add android
```

### 3. Sync web assets to Android project
```bash
npx cap sync android
```

### 4. Apply native configuration (IMPORTANT — run after every `cap sync`)

Run the setup script to copy all native source files, icons, splash screen, notification icons, adaptive icons, and the manifest into the Android project:

```bash
# From the android-app directory:
./setup-android.sh
```

This script copies:
- All Java/Kotlin native plugins (BackgroundAudioService, LiveKitPlugin, HardwarePttPlugin, etc.)
- Custom launcher icons (shield design) replacing default Capacitor icons
- Adaptive icon resources for Android 8+
- Splash screen drawable
- Foreground service notification icons
- AndroidManifest.xml with all required permissions and service declarations

**If you skip this step, the APK will use default Capacitor icons and lack native PTT functionality.**

### 5. Open in Android Studio
```bash
npx cap open android
```

### 6. Fix Gradle Version (if prompted)

If Android Studio shows "Minimum supported Gradle version is 8.9":

**Option A:** Click the "Gradle Settings" link and let Android Studio update automatically

**Option B:** Manually edit `android/gradle/wrapper/gradle-wrapper.properties`:
```properties
distributionUrl=https\://services.gradle.org/distributions/gradle-8.9-bin.zip
```

**Note:** Gradle 8.9+ requires JDK 21. If you see JDK compatibility errors, update your JDK or set `JAVA_HOME` to a JDK 21 installation.

## Required Android Permissions

Add these to `android/app/src/main/AndroidManifest.xml`:

```xml
<!-- CRITICAL: Network permissions (required for ALL API calls and LiveKit) -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<!-- Location permissions -->
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION" />

<!-- Foreground service for background audio and GPS -->
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION" />

<!-- Audio/microphone for WebRTC/LiveKit PTT -->
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

<!-- Keep device awake during PTT -->
<uses-permission android:name="android.permission.WAKE_LOCK" />

<!-- Notifications -->
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

<!-- Do Not Disturb Override -->
<uses-permission android:name="android.permission.ACCESS_NOTIFICATION_POLICY" />

<!-- Hardware feature declarations -->
<uses-feature android:name="android.hardware.microphone" android:required="true" />
<uses-feature android:name="android.hardware.location.gps" android:required="false" />
```

**IMPORTANT:** The `INTERNET` permission is REQUIRED for the app to make any network requests, including connecting to LiveKit for PTT.

## WebRTC Audio Permissions (CRITICAL)

The app uses LiveKit for real-time PTT voice. For WebRTC to work in the Android WebView, 
MainActivity.java MUST include the WebChromeClient override to grant audio permissions.

The MainActivity.java in this directory already includes this code - make sure to copy it
to your Android project at:
`android/app/src/main/java/com/reedersystems/commandcomms/MainActivity.java`

Without this override, you'll get "Permission denied" errors when trying to connect to channels.

## Foreground Service for Background Audio

The app requires a foreground service to keep audio playing when minimized. Add this service to AndroidManifest.xml:

```xml
<service
    android:name=".BackgroundAudioService"
    android:exported="false"
    android:foregroundServiceType="mediaPlayback|location">
</service>
```

## Files

| File | Role |
|------|------|
| `PttBroadcastReceiver.java` | Catches firmware PTT broadcasts, forwards to BackgroundAudioService |
| `BackgroundAudioService.java` | Foreground service: owns PTT state machine, calls LiveKit TX, HTTP signaling |
| `LiveKitPlugin.kt` | Native LiveKit SDK wrapper: static `startTransmit()` / `stopTransmit()` |
| `HardwarePttPlugin.java` | Capacitor plugin for UI sync (JS notifyListeners), not control path |
| `MainActivity.java` | Foreground key dispatch (redundant path), WebView keepalive |

## Native LiveKit SDK

The app uses a native LiveKit plugin to bypass WebView WebRTC limitations. This provides
more reliable audio connections than the web SDK.

**IMPORTANT:** The plugin is written in Kotlin because LiveKit's Android SDK uses Kotlin
coroutines (suspend functions) which cannot be called directly from Java.

### Enable Kotlin

LiveKit SDK requires Kotlin. In `android/build.gradle`:
```gradle
buildscript {
    ext.kotlin_version = '1.9.0'
    dependencies {
        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlin_version"
    }
}
```

In `android/app/build.gradle`:
```gradle
apply plugin: 'kotlin-android'
apply plugin: 'kotlin-kapt' // Optional, for annotation processing

android {
    // ... existing config
    
    kotlinOptions {
        jvmTarget = '21'
    }
}

dependencies {
    // Kotlin
    implementation "org.jetbrains.kotlin:kotlin-stdlib:$kotlin_version"
    implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3"
    
    // LiveKit Native SDK
    implementation "io.livekit:livekit-android:2.5.0"
}

repositories {
    google()
    mavenCentral()
    maven { url 'https://jitpack.io' }
}
```

### Copy the App Icon and Splash Screen

Copy the `res/` folder contents to replace the default icons and splash screen:
```
cp -r android-config/res/* android/app/src/main/res/
```
This replaces:
- **Launcher icons** (`mipmap-*/ic_launcher*.png`): The default Capacitor icon with the Command Comms radio tower logo at all required Android densities (mdpi through xxxhdpi)
- **Splash screen** (`drawable/splash.xml` + `drawable/ic_splash.png`): The default blue X Capacitor splash with a dark background (#111111) and centered radio tower icon
- **Colors** (`values/colors.xml`): Splash background color resource

### Copy the Plugin Files

Copy these files to `android/app/src/main/java/com/reedersystems/commandcomms/`:
- `LiveKitPlugin.kt` - Native LiveKit wrapper (Kotlin)
- `RadioVoiceDSP.kt` - Radio voice audio processing (band-pass filter, compression, saturation)

**Note:** Delete the old `LiveKitPlugin.java` if it exists.

### Radio Voice DSP Effect

The `RadioVoiceDSP.kt` class provides authentic radio voice processing with:
- **Band-pass filter**: 300Hz - 3400Hz (standard voice radio frequencies)
- **Dynamic compression**: 8:1 ratio with -24dB threshold for consistent levels
- **Soft saturation**: Light harmonic distortion for radio character
- **Output gain**: 1.4x boost for presence

The DSP class also enables Android's built-in AGC (Automatic Gain Control) and noise 
suppression when attached to an AudioRecord session.

**Note on Integration:** The DSP effect is primarily applied on the web client side via 
the Web Audio API. The Android native app uses LiveKit's SDK which handles audio capture 
internally. Android's built-in AGC and noise suppression provide similar audio quality 
improvements. The `RadioVoiceDSP.kt` class is provided for future custom audio capture 
implementations if needed.

### Register the LiveKit Plugin

In MainActivity.java, the plugin is already registered:
```java
registerPlugin(LiveKitPlugin.class);
```

## App Signing

For release builds, create a keystore:
```bash
keytool -genkey -v -keystore command-comms.keystore -alias command-comms -keyalg RSA -keysize 2048 -validity 10000
```

## Inrico T320 — Device Setup

1. **Duraspeed must be OFF** — Settings → Battery → Duraspeed → disable for COMMAND COMMS
2. **Battery optimization exempt** — Requested automatically on first launch
3. **PTT key code**: 230 (Inrico T320 hardware PTT button)
4. **Firmware broadcasts**: `android.intent.action.PTT.down` / `android.intent.action.PTT.up`

### Copy Commands

```bash
cp android-app/android-config/PttBroadcastReceiver.java android/app/src/main/java/com/reedersystems/commandcomms/
cp android-app/android-config/BackgroundAudioService.java android/app/src/main/java/com/reedersystems/commandcomms/
cp android-app/android-config/MainActivity.java android/app/src/main/java/com/reedersystems/commandcomms/
cp android-app/android-config/HardwarePttPlugin.java android/app/src/main/java/com/reedersystems/commandcomms/
cp android-app/android-config/LiveKitPlugin.kt android/app/src/main/java/com/reedersystems/commandcomms/
cp android-app/android-config/AndroidManifest.xml android/app/src/main/AndroidManifest.xml
```

## Testing on Device

1. Enable USB debugging on Android device
2. Connect via USB
3. Run `npx cap run android` or build APK in Android Studio
4. Use `adb logcat -s PTT-DIAG` to verify PTT chain
