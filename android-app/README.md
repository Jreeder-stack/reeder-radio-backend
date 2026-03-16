# COMMAND COMMS Android App

Native Android wrapper for the PTT radio application using Capacitor.

## Prerequisites

- Android Studio (latest version)
- JDK 21+
- Node.js 18+

## Build Steps

### 1. Install Dependencies

```bash
cd android-app
npm install
```

### 2. Build Web Assets

```bash
npm run build
```

### 3. Initialize Capacitor (first time only)

```bash
npx cap add android
```

### 4. Sync Web Assets

```bash
npx cap sync android
```

### 5. Copy Native Plugins

Copy the following files from `android-config/` to `android/app/src/main/java/com/reedersystems/commandcomms/`:

- `BackgroundAudioService.java` - Foreground service for background audio
- `BackgroundServicePlugin.java` - Capacitor plugin to control the service
- `HardwarePttPlugin.java` - Volume/Bluetooth PTT key support
- `DndOverridePlugin.java` - Do Not Disturb override for emergencies
- `LiveKitPlugin.kt` - Native LiveKit SDK wrapper (optional)
- `RadioVoiceDSP.kt` - Radio voice processing (reference only)

### 6. Register Plugins in MainActivity

Edit `android/app/src/main/java/com/reedersystems/commandcomms/MainActivity.java`:

```java
package com.reedersystems.commandcomms;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundServicePlugin.class);
        registerPlugin(HardwarePttPlugin.class);
        registerPlugin(DndOverridePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
```

### 7. Merge AndroidManifest.xml

Copy the permissions and service declaration from `android-config/AndroidManifest.xml` into `android/app/src/main/AndroidManifest.xml`.

Key additions:
- `FOREGROUND_SERVICE` permissions
- `WAKE_LOCK` permission
- `BackgroundAudioService` service declaration

### 8. Add Notification Icon (Optional)

For a custom notification icon, add `ic_stat_icon.png` to:
- `android/app/src/main/res/drawable-mdpi/`
- `android/app/src/main/res/drawable-hdpi/`
- `android/app/src/main/res/drawable-xhdpi/`
- `android/app/src/main/res/drawable-xxhdpi/`

If not provided, a default system icon will be used.

### 9. Open in Android Studio

```bash
npx cap open android
```

### 10. Build APK

In Android Studio:
1. Build > Build Bundle(s) / APK(s) > Build APK(s)
2. Find APK in `android/app/build/outputs/apk/debug/`

## Background Service

The `BackgroundAudioService` keeps the app running when the screen is off:

- Shows a persistent notification while active
- Prevents the system from killing the app
- Maintains audio streaming capability
- Uses `FOREGROUND_SERVICE_MICROPHONE` for Android 14+

The service is automatically started when the user enters the radio interface and stopped when they leave.

## Wake Lock

During active PTT transmission, a partial wake lock is acquired to prevent CPU sleep. This ensures reliable audio transmission even when the screen is off.

## Troubleshooting

### App stops when screen turns off

1. Verify `BackgroundAudioService` is registered in AndroidManifest.xml
2. Check that `BackgroundServicePlugin` is registered in MainActivity
3. Ensure FOREGROUND_SERVICE permissions are granted
4. Check device battery optimization settings - disable for this app

### Plugin not found errors

Ensure all plugins are:
1. Copied to the correct package directory
2. Registered in MainActivity.onCreate() BEFORE super.onCreate()

### Notification not showing

The foreground service requires a notification. If the custom icon is missing, a default icon will be used. Check logcat for any notification errors.


### `attempting to assign weaker access privileges; was public`

If Android build fails with errors like:

- `onResume() in MainActivity cannot override onResume() in BridgeActivity`
- `onDestroy() in MainActivity cannot override onDestroy() in BridgeActivity`

then your local `MainActivity.java` still has `protected` lifecycle overrides.

Fix by re-running the setup script so `android-config/MainActivity.java` is copied and normalized:

```bash
./setup-android.sh
```

On Windows:

```bat
setup-android.bat
```

Or manually change these signatures in `android/app/src/main/java/com/reedersystems/commandcomms/MainActivity.java`:

- `protected void onResume()` -> `public void onResume()`
- `protected void onDestroy()` -> `public void onDestroy()`
