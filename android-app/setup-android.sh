#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ANDROID_DIR="$SCRIPT_DIR/android"
CONFIG_DIR="$SCRIPT_DIR/android-config"
JAVA_DIR="$ANDROID_DIR/app/src/main/java/com/reedersystems/commandcomms"
RES_DIR="$ANDROID_DIR/app/src/main/res"

if [ ! -d "$ANDROID_DIR" ]; then
    echo "ERROR: android/ directory not found."
    echo "Run these commands first:"
    echo "  npm run build"
    echo "  npx cap add android"
    echo "  npx cap sync android"
    exit 1
fi

echo "=== Command Comms Android Setup ==="
echo ""

mkdir -p "$JAVA_DIR"

echo "[1/6] Copying native source files..."
for f in BackgroundAudioService.java BackgroundServicePlugin.java BootReceiver.java \
         DndOverridePlugin.java HardwarePttPlugin.java PttBroadcastReceiver.java \
         PttAccessibilityService.java PttKeyMapping.java MainActivity.java; do
    if [ -f "$CONFIG_DIR/$f" ]; then
        cp "$CONFIG_DIR/$f" "$JAVA_DIR/$f"
        echo "  -> $f"
    fi
done
for f in LiveKitPlugin.kt NativeRadioEngine.kt RadioVoiceDSP.kt; do
    if [ -f "$CONFIG_DIR/$f" ]; then
        cp "$CONFIG_DIR/$f" "$JAVA_DIR/$f"
        echo "  -> $f"
    fi
done

# Capacitor BridgeActivity lifecycle methods are public in newer versions.
# If a stale local MainActivity uses protected overrides, javac fails with:
# "attempting to assign weaker access privileges; was public".
MAIN_ACTIVITY="$JAVA_DIR/MainActivity.java"
if [ -f "$MAIN_ACTIVITY" ]; then
    sed -i 's/protected void onResume()/public void onResume()/g' "$MAIN_ACTIVITY"
    sed -i 's/protected void onDestroy()/public void onDestroy()/g' "$MAIN_ACTIVITY"
fi

echo ""
echo "[2/6] Copying launcher icons..."
for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    mkdir -p "$RES_DIR/mipmap-$density"
    for icon in ic_launcher.png ic_launcher_round.png; do
        if [ -f "$CONFIG_DIR/res/mipmap-$density/$icon" ]; then
            cp "$CONFIG_DIR/res/mipmap-$density/$icon" "$RES_DIR/mipmap-$density/$icon"
        fi
    done
    echo "  -> mipmap-$density"
done

mkdir -p "$RES_DIR/mipmap-anydpi-v26"
if [ -f "$CONFIG_DIR/res/mipmap-anydpi-v26/ic_launcher.xml" ]; then
    cp "$CONFIG_DIR/res/mipmap-anydpi-v26/ic_launcher.xml" "$RES_DIR/mipmap-anydpi-v26/ic_launcher.xml"
    cp "$CONFIG_DIR/res/mipmap-anydpi-v26/ic_launcher_round.xml" "$RES_DIR/mipmap-anydpi-v26/ic_launcher_round.xml"
    echo "  -> mipmap-anydpi-v26 (adaptive icons)"
fi

echo ""
echo "[3/6] Copying splash and foreground drawables..."
mkdir -p "$RES_DIR/drawable"
rm -f "$RES_DIR/drawable/splash.png"
if [ ! -f "$RES_DIR/drawable/splash.png" ]; then
    echo "  -> Removed default splash.png (conflicts with splash.xml)"
else
    echo "  WARNING: Could not delete splash.png - delete it manually!"
    echo "  Path: $RES_DIR/drawable/splash.png"
fi
for f in ic_splash.png splash.xml ic_launcher_foreground.png; do
    if [ -f "$CONFIG_DIR/res/drawable/$f" ]; then
        cp "$CONFIG_DIR/res/drawable/$f" "$RES_DIR/drawable/$f"
        echo "  -> drawable/$f"
    fi
done

echo ""
echo "[4/6] Copying notification icons..."
for density in mdpi hdpi xhdpi xxhdpi; do
    mkdir -p "$RES_DIR/drawable-$density"
    if [ -f "$CONFIG_DIR/res/drawable-$density/ic_stat_icon.png" ]; then
        cp "$CONFIG_DIR/res/drawable-$density/ic_stat_icon.png" "$RES_DIR/drawable-$density/ic_stat_icon.png"
        echo "  -> drawable-$density/ic_stat_icon.png"
    fi
done

echo ""
echo "[5/6] Copying values, XML resources, and manifest..."
mkdir -p "$RES_DIR/values"
for f in ic_launcher_background.xml colors.xml accessibility_strings.xml; do
    if [ -f "$CONFIG_DIR/res/values/$f" ]; then
        cp "$CONFIG_DIR/res/values/$f" "$RES_DIR/values/$f"
        echo "  -> values/$f"
    fi
done

mkdir -p "$RES_DIR/xml"
if [ -f "$CONFIG_DIR/res/xml/accessibility_service_config.xml" ]; then
    cp "$CONFIG_DIR/res/xml/accessibility_service_config.xml" "$RES_DIR/xml/accessibility_service_config.xml"
    echo "  -> xml/accessibility_service_config.xml"
fi

if [ -f "$CONFIG_DIR/AndroidManifest.xml" ]; then
    cp "$CONFIG_DIR/AndroidManifest.xml" "$ANDROID_DIR/app/src/main/AndroidManifest.xml"
    echo "  -> AndroidManifest.xml"
fi

echo ""
echo "[6/7] Hooking Gradle auto-copy into app/build.gradle..."
BUILD_GRADLE="$ANDROID_DIR/app/build.gradle"
if [ -f "$BUILD_GRADLE" ]; then
    if ! grep -q "commandcomms.gradle" "$BUILD_GRADLE"; then
        echo "" >> "$BUILD_GRADLE"
        echo "apply from: '../../android-config/commandcomms.gradle'" >> "$BUILD_GRADLE"
        echo "  -> Injected apply from: commandcomms.gradle"
    else
        echo "  -> Already present, skipping"
    fi
else
    echo "  WARNING: app/build.gradle not found - Gradle hook not added"
fi

echo ""
echo "[7/7] Verifying icon files..."
VERIFY_OK=1
for density in mdpi hdpi xhdpi xxhdpi xxxhdpi; do
    ICON_FILE="$RES_DIR/mipmap-$density/ic_launcher.png"
    if [ -f "$ICON_FILE" ]; then
        SIZE=$(stat -f%z "$ICON_FILE" 2>/dev/null || stat -c%s "$ICON_FILE" 2>/dev/null || echo "0")
        if [ "$SIZE" -lt 1000 ]; then
            echo "  WARNING: mipmap-$density/ic_launcher.png is too small (${SIZE} bytes) - may be default!"
            VERIFY_OK=0
        else
            echo "  OK: mipmap-$density/ic_launcher.png (${SIZE} bytes)"
        fi
    else
        echo "  MISSING: mipmap-$density/ic_launcher.png"
        VERIFY_OK=0
    fi
done
FG_FILE="$RES_DIR/drawable/ic_launcher_foreground.png"
if [ -f "$FG_FILE" ]; then
    SIZE=$(stat -f%z "$FG_FILE" 2>/dev/null || stat -c%s "$FG_FILE" 2>/dev/null || echo "0")
    echo "  OK: drawable/ic_launcher_foreground.png (${SIZE} bytes)"
else
    echo "  MISSING: drawable/ic_launcher_foreground.png"
    VERIFY_OK=0
fi
if [ "$VERIFY_OK" -eq 1 ]; then
    echo "  All icons verified successfully."
else
    echo "  WARNING: Some icons may not have been copied correctly!"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Gradle hook is now active. Every subsequent Android Studio build will"
echo "automatically re-copy all files from android-config/ before compiling."
echo "You only need to re-run this script after: npx cap sync android"
echo ""
echo "IMPORTANT: If updating an existing install on the device,"
echo "UNINSTALL the old app first to clear the cached icon."
echo "  adb uninstall com.reedersystems.commandcomms"
echo ""
echo "Open in Android Studio: npx cap open android"
echo "Build APK: Build > Build Bundle(s) / APK(s) > Build APK(s)"
