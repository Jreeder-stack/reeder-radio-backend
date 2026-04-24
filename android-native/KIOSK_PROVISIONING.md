# Kiosk Provisioning Guide

This guide explains how to lock a T320 (or any compatible Android device, API 26+)
to the Command Comms radio app so the user cannot exit it, open Settings, or
reach any other app. This is achieved with Android's **Device Owner** feature,
which the app must be enrolled into.

---

## What "Device Owner" buys us

Once the radio app is the device owner, it can:

- Pin itself in lock-task (kiosk) mode — Home, Recents, the back-out gestures
  and the notification shade can no longer leave the app.
- Hide the status bar and navigation bar permanently.
- Disable the keyguard so wake goes straight back to the radio UI.
- Make itself the persistent default Home, so the device boots into the radio.
- Survive reboots — the device returns to the radio with no user action needed.

Incoming radio audio, PTT, paging tones, emergency alerts, foreground-service
notifications, and FCM all keep working unchanged. The kiosk only blocks **the
user from leaving** — it does not block the app from doing its job.

---

## When you can — and can't — provision

Device Owner provisioning **must be done on a freshly-reset device with no
Google account configured**. This is an Android requirement, not an app one.

- ✅ Brand-new T320 out of the box.
- ✅ T320 that has just been factory-reset (Settings → System → Reset).
- ❌ Device that already has a primary user / Google account.
- ❌ Device that already has another device-owner app installed.

If you try to provision a device that does not meet these conditions, the
`dpm` command will fail with `not allowed to set the device owner`.

---

## Path A — ADB enrollment (recommended for dev / bench)

This is the fastest way to enroll a single device when you can plug it into a
laptop.

1. **Factory reset** the device. During the welcome screen, do **not** add a
   Google account; tap *Skip* on every step until you reach the home screen.
2. Enable USB debugging:
   *Settings → About → tap Build Number 7 times → back → Developer Options →
   USB Debugging → ON.*
3. Sideload the radio APK:
   ```bash
   adb install -r android-native/app/build/outputs/apk/debug/app-debug.apk
   ```
4. Set the radio app as Device Owner:
   ```bash
   adb shell dpm set-device-owner com.reedersystems.commandcomms/.RadioDeviceAdminReceiver
   ```
   You should see:
   ```
   Success: Device owner set to package com.reedersystems.commandcomms
   ```
5. Open the radio app. Go to **Settings → Kiosk Mode**. The "Device Owner"
   row should now read **YES**.
6. Set a 4–12 digit **Admin PIN** (write it down somewhere safe — without it,
   the only way out of kiosk mode is a factory reset).
7. Flip **Enable Kiosk Mode** to ON. The status/navigation bars disappear and
   Home / Recents / pull-down shade are blocked.

That's it — the device is now a single-purpose radio. You can unplug USB.

---

## Path B — QR-code enrollment (recommended for field deployment)

The Android setup wizard supports enrolling a Device Owner straight from the
welcome screen by scanning a QR code. Use this when you need to lock down many
devices and don't want to babysit each one with `adb`.

### One-time: build the QR payload

The QR code encodes a small JSON document. Host the signed APK somewhere the
device can reach, then build the JSON payload:

```json
{
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME":
      "com.reedersystems.commandcomms/.RadioDeviceAdminReceiver",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM":
      "<base64-url-encoded SHA-256 of the APK's signing certificate>",
  "android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION":
      "https://your.cdn/commandcomms-release.apk",
  "android.app.extra.PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED": true,
  "android.app.extra.PROVISIONING_SKIP_ENCRYPTION": false,
  "android.app.extra.PROVISIONING_WIFI_SSID": "ReederFieldWiFi",
  "android.app.extra.PROVISIONING_WIFI_PASSWORD": "<wifi password>",
  "android.app.extra.PROVISIONING_WIFI_SECURITY_TYPE": "WPA"
}
```

Compute the signature checksum with:

```bash
keytool -list -printcert -jarfile commandcomms-release.apk \
  | awk '/SHA-?256/ {print $2}' \
  | tr -d ':' \
  | xxd -r -p \
  | base64 \
  | tr '+/' '-_' \
  | tr -d '='
```

Drop the JSON into any QR generator (the payload must be a single QR code).

### On the device

1. Factory reset the T320.
2. On the **Welcome / Hi there** screen, tap any blank area **6 times in a row**.
   The setup wizard launches its built-in QR scanner.
3. (If prompted) connect to Wi-Fi so the device can download the QR scanner
   updater and the APK.
4. Scan the QR code. The setup wizard will:
   - download the APK,
   - install it,
   - set it as Device Owner,
   - launch `KioskProvisioningActivity`, which pre-applies our kiosk policies
     and bounces the user into `MainActivity`.
5. Once the radio UI is on screen, set an admin PIN under **Settings → Kiosk
   Mode** and enable kiosk.

---

## Verifying Device Owner status

There are two ways to confirm:

- **In-app:** open the radio app's **Settings** screen. The "Device Owner" row
  reads **YES** when provisioning succeeded.
- **From ADB:** `adb shell dumpsys device_policy | grep -A2 "Device Owner"`.
  You should see the radio app's package name.

---

## Exiting kiosk mode in the field

Inside the radio app, an admin can:

1. Open **Settings → Kiosk Mode**.
2. Type the Admin PIN into the **EXIT KIOSK** field.
3. Tap **EXIT KIOSK**. The status / navigation bars come back and Home works
   again.

The PIN is stored salted+hashed; the plaintext PIN is never written to disk.

---

## Un-provisioning a device (retiring it)

> ⚠️  Important: on a real production-installed (non-test, non-debug) build,
> **a factory reset is the only reliable way to remove Device Owner status.**
> Android intentionally blocks the regular `dpm remove-active-admin` command
> against an active Device Owner because the whole point of DO is that the
> end-user (and even an attacker with shell access) cannot strip it.

### Recommended path (production devices) — factory reset

1. Inside the radio app, open **Settings → Kiosk Mode** and use **EXIT KIOSK**
   to drop out of lock-task cleanly (so the user can reach the system Settings
   app afterwards).
2. Open the system **Settings → System → Reset → Erase all data (factory
   reset)**.
3. Confirm the reset. After reboot, the device is no longer Device Owner and
   the radio app is back to a normal installed app — re-provision it (or any
   other app) as needed.

### Debuggable / test builds only — `dpm remove-active-admin`

Only works when one of the following is true:

- The APK is a debug build (`android:testOnly="true"` in the manifest), **or**
- The Device Owner was set on a userdebug / `eng` Android image.

In those cases, after exiting kiosk via the in-app PIN flow, you can run:

```bash
adb shell dpm remove-active-admin \
    com.reedersystems.commandcomms/.RadioDeviceAdminReceiver
```

If the command returns `not allowed`, the device is a normal user build with a
real Device Owner, and you must factory reset instead.

---

## Manual T320 verification checklist

Run through this list after provisioning a real T320 — all items should pass:

- [ ] Settings shows **Device Owner: YES**.
- [ ] Setting an admin PIN persists across an app restart.
- [ ] Enabling kiosk mode hides the status/navigation bars.
- [ ] Pressing the Home button does **not** leave the app.
- [ ] Pressing the Recents key does **not** leave the app.
- [ ] Swiping down from the top does **not** open the notification shade.
- [ ] Long-pressing Power does **not** show the global actions menu.
- [ ] After turning the screen off and back on, the device wakes straight to
      the radio UI (no lock-screen swipe required).
- [ ] After a reboot, the device boots straight to the radio app.
- [ ] Foreground PTT works (push-to-talk transmits and is received).
- [ ] Background PTT works (screen off; PTT key still keys up).
- [ ] Incoming radio audio is heard normally, foreground and background.
- [ ] A pager tone fires and the page overlay shows on top of the radio UI.
- [ ] Emergency alerts still arrive and play.
- [ ] Entering the wrong PIN in **EXIT KIOSK** keeps the device locked.
- [ ] Entering the correct PIN in **EXIT KIOSK** drops out of kiosk cleanly.
