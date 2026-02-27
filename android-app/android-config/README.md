# COMMAND COMMS - Android Native Configuration

This directory contains configuration and instructions for building the native Android app with Capacitor.

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

### 4. Open in Android Studio
```bash
npx cap open android
```

### 5. Fix Gradle Version (if prompted)

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

## Hardware PTT Key Mapping

To capture volume buttons and Bluetooth PTT:

1. Override `dispatchKeyEvent` in MainActivity
2. Send events to WebView via JavaScript interface
3. See `HardwarePttPlugin.java` in this directory

The app already has JavaScript event listeners for:
- `ptt-key-down` - Hardware PTT pressed
- `ptt-key-up` - Hardware PTT released

Volume button key codes:
- KEYCODE_VOLUME_UP: 24
- KEYCODE_VOLUME_DOWN: 25
- KEYCODE_HEADSETHOOK: 79 (Bluetooth headset button)
- KEYCODE_MEDIA_PLAY_PAUSE: 85 (Media button)

## Native LiveKit SDK (Recommended for PTT)

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

### Copy the App Icon

Copy the `res/` folder contents to replace the default icons:
```
cp -r android-config/res/* android/app/src/main/res/
```
This replaces the default Capacitor icon with the Command Comms radio tower logo at all required Android densities (mdpi through xxxhdpi).

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

## Testing on Device

1. Enable USB debugging on Android device
2. Connect via USB
3. Run `npx cap run android` or build APK in Android Studio
