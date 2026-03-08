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

echo "[1/5] Copying native source files..."
for f in BackgroundAudioService.java BackgroundServicePlugin.java BootReceiver.java \
         DndOverridePlugin.java HardwarePttPlugin.java PttBroadcastReceiver.java \
         MainActivity.java; do
    if [ -f "$CONFIG_DIR/$f" ]; then
        cp "$CONFIG_DIR/$f" "$JAVA_DIR/$f"
        echo "  -> $f"
    fi
done
for f in LiveKitPlugin.kt RadioVoiceDSP.kt; do
    if [ -f "$CONFIG_DIR/$f" ]; then
        cp "$CONFIG_DIR/$f" "$JAVA_DIR/$f"
        echo "  -> $f"
    fi
done

echo ""
echo "[2/5] Copying launcher icons..."
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
echo "[3/5] Copying splash and foreground drawables..."
mkdir -p "$RES_DIR/drawable"
if [ -f "$RES_DIR/drawable/splash.png" ]; then
    rm -f "$RES_DIR/drawable/splash.png"
    echo "  -> Removed default splash.png (conflicts with splash.xml)"
fi
for f in ic_splash.png splash.xml ic_launcher_foreground.png; do
    if [ -f "$CONFIG_DIR/res/drawable/$f" ]; then
        cp "$CONFIG_DIR/res/drawable/$f" "$RES_DIR/drawable/$f"
        echo "  -> drawable/$f"
    fi
done

echo ""
echo "[4/5] Copying notification icons..."
for density in mdpi hdpi xhdpi xxhdpi; do
    mkdir -p "$RES_DIR/drawable-$density"
    if [ -f "$CONFIG_DIR/res/drawable-$density/ic_stat_icon.png" ]; then
        cp "$CONFIG_DIR/res/drawable-$density/ic_stat_icon.png" "$RES_DIR/drawable-$density/ic_stat_icon.png"
        echo "  -> drawable-$density/ic_stat_icon.png"
    fi
done

echo ""
echo "[5/5] Copying values and manifest..."
mkdir -p "$RES_DIR/values"
for f in ic_launcher_background.xml colors.xml; do
    if [ -f "$CONFIG_DIR/res/values/$f" ]; then
        cp "$CONFIG_DIR/res/values/$f" "$RES_DIR/values/$f"
        echo "  -> values/$f"
    fi
done

if [ -f "$CONFIG_DIR/AndroidManifest.xml" ]; then
    cp "$CONFIG_DIR/AndroidManifest.xml" "$ANDROID_DIR/app/src/main/AndroidManifest.xml"
    echo "  -> AndroidManifest.xml"
fi

echo ""
echo "=== Setup complete ==="
echo "Open in Android Studio: npx cap open android"
echo "Build APK: Build > Build Bundle(s) / APK(s) > Build APK(s)"
