#!/usr/bin/env bash
# ============================================================
# COMMAND COMMS — Native Android Build Script
# ============================================================
# Prerequisites:
#   - Android Studio Hedgehog (2023.1.1) or newer
#   - JDK 17 (bundled with Android Studio)
#   - Android SDK API 34 installed via SDK Manager
#
# This script documents the build steps. Most users will build
# via Android Studio GUI, but this script can also run a debug
# APK from the command line using the Gradle wrapper.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo " COMMAND COMMS Native Android Build"
echo "========================================"
echo ""

# Verify we have a JDK available
if ! command -v java &>/dev/null; then
  echo "ERROR: Java not found. Install JDK 17 or set JAVA_HOME."
  echo "  On Mac:   brew install --cask temurin@17"
  echo "  On Linux: sudo apt install openjdk-17-jdk"
  exit 1
fi

JAVA_VER=$(java -version 2>&1 | awk -F '"' '/version/ {print $2}' | cut -d. -f1)
echo "Java version: $JAVA_VER"
if [[ "$JAVA_VER" -lt 17 ]]; then
  echo "WARNING: JDK 17+ is recommended. Current: $JAVA_VER"
fi

echo ""
echo "Building debug APK..."
echo "(For release APK, open in Android Studio: Build > Generate Signed Bundle/APK)"
echo ""

# Make gradlew executable
chmod +x gradlew

# Build debug APK
./gradlew assembleDebug --no-daemon

echo ""
echo "========================================"
echo " Build complete!"
echo " APK: app/build/outputs/apk/debug/app-debug.apk"
echo "========================================"
echo ""
echo "To install on a connected device:"
echo "  adb install -r app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "IMPORTANT: Uninstall the old Capacitor APK first if it has"
echo "the same package ID (com.reedersystems.commandcomms):"
echo "  adb uninstall com.reedersystems.commandcomms"
