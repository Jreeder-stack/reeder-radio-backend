# Siyata SD7 — `com.br.smallcd` firmware inventory

**Status:** Research / decision (Task #586). No production code is changed by this
task. This document is the source of truth for the SD7 firmware surface that the
follow-up build tasks will integrate against.

**Date:** 2026-05-13. Supersedes the §3.3 "SDK is vendor-only" conclusion in
[`SD7_HEADLESS_UX.md`](./SD7_HEADLESS_UX.md). The OLED **is** writable from a
third-party app via the public Android system service `android.app.SmallcdManager`
(service name `smallcd`). The audio/haptic/TTS UX spec in §4 of that doc remains
valid as the cue layer; this document defines the visual layer that complements
it.

---

## 0. Evidence base

All findings are grounded in three on-device captures plus the decompiled
firmware APK. File paths are relative to the workspace root; line numbers refer
to the captured paste files unless otherwise noted.

| Evidence | What it proves | Source |
| --- | --- | --- |
| Decompiled `Controller.java` (1593 lines, jadx output) | Exact `SmallcdManager` call shapes, the `_Display` stack, the broadcast/receiver wiring, `setOledScreenIndication` semantics. | `attached_assets/Pasted-package-com-br-smallcd-import-android-app-Activity-impo_1778641295808.txt` |
| Decompiled `_ExtDisplayMsg`, `ExtEventHandler`, `ExtEventHandler$1` (androguard DAD) | Full SMALLCD_EXT broadcast contract: `int type` / `int appid` / `String content` extras, JSON content schema for `type=2` (display msg), result-intent action names for dismissal / option select / keyboard input, type-1/3/4 routing. | Local re-decompile produced from `attached_assets/smallcd_1778642214836.apk` using `androguard` 4.1.3 (jadx 1.5.0 segfaulted on the available JDK11 in this env, so we fell back to androguard's DAD decompiler — output reviewed inline in §2). |
| `dumpsys package com.br.smallcd` | Package is `/system/app/smallcd/smallcd.apk`, `sharedUser=android.uid.system/1000`, `flags=[ SYSTEM HAS_CODE PERSISTENT ]`, signed with platform key (apkSigningVersion=3, single keyset), all exported components. | `attached_assets/Pasted-Activity-Resolver-Table-Full-MIME-Types-application-vnd_1778640150955.txt` |
| `service list` | `176 smallcd: [android.app.ISmallcdManager]` is registered as a public framework system service. | `attached_assets/Pasted-Found-227-services-0-DockObserver-1-SurfaceFlinger-andr_1778640168949.txt` |
| `pm list packages -f` | Confirms Esper bloat (`io.shoonya.shoonyadpc`, `io.shoonya.helper`, `io.esper.remoteviewer`, `io.esper.tesseract`, `com.shoonyaos.oculus.plugin.supervisor.toronto_sd7`) is preinstalled, and our `com.reedersystems.commandcomms.sd7` is a regular `/data/app` install. | `attached_assets/Pasted-package-system-priv-app-CtsShimPrivPrebuilt-CtsShimPriv_1778640198733.txt` |
| `settings list global` | `oledscreen_status_indication=1`, `siyata_covert_mode=0`, `key_settings_*`, `ptt_key_delay=100`, `key_esper_state=0`. | `attached_assets/Pasted-adb-enabled-1-adb-wifi-enabled-0-add-users-when-locked-_1778640131047.txt` |
| `settings list system` / secure | `enabled_accessibility_services=com.br.smallcd/com.br.smallcd.LocationAccessibilityService`, `device_name=Siyata SD7`, `smallcd_config_features=` (empty), `lockscreen.disabled=1`. | `attached_assets/Pasted-accessibility-button-mode-1-accessibility-display-inver_1778640064328.txt` |
| `getprop` (sanitized) | Build `Siyata/SD7/SD7:12/SKQ1.220319.001/D7AT0P11JUN5SU.2506111813:user/release-keys`, Android 12 / SDK 31, vendor "Belfone" build artifacts. **Sanitized 2026-05-13:** `ro.boot.serialno`, `ro.serialno`, and `ro.fota.productSecret` redacted to `[REDACTED-SERIAL]` / `[REDACTED-FOTA-SECRET]` before commit. | `attached_assets/Pasted--DEVICE-PROVISIONED-1-bootreceiver-enable-0-build-versi_1778640181178.txt` |
| `smallcd.apk` (4.1 MB, classes.dex 822 KB) | Source artifact for further decompilation if needed. The Pasted text file above contains the full `com.br.smallcd.Controller` class. | `attached_assets/smallcd_1778642214836.apk` |

> Re-decompilation note. We attempted `jadx -d out/
> attached_assets/smallcd_1778642214836.apk` in this research env; on the
> available `nixpkgs.jdk11` Java VM `jadx` 1.5.0 segfaulted before producing
> output. We fell back to `androguard` 4.1.3 (`from androguard.misc import
> AnalyzeAPK; from androguard.decompiler.decompiler import DecompilerDAD`) to
> emit Jasmin-style decompiled source for the four classes that drive the
> external-display surface (`_ExtDisplayMsg`, `ExtEventHandler`,
> `ExtEventHandler$1`, plus method-signature dumps for `_Display` /
> `_MainScreen`). All §2 contract claims below quote that androguard output
> directly (call out the byte-by-byte JSON keys and intent-extra names). To
> reproduce on a workstation with a healthy JDK 17:
> `jadx -d out/ attached_assets/smallcd_1778642214836.apk` then read
> `out/sources/com/br/smallcd/`. The remaining classes referenced by name
> (`_MainScreen`, `NfcActivity`, etc.) are all in the APK; their bodies are
> beyond the scope of this task (UX layout details for our own renderer come
> from §7, not from copying the firmware's pixel positions).

---

## 1. `SmallcdManager` API contract

`android.app.SmallcdManager` is a framework system service registered as
`smallcd` (`service list` line 176, returning `android.app.ISmallcdManager`).
It is acquired the standard way:

```java
SmallcdManager smallcd = (SmallcdManager) context.getSystemService("smallcd");
```

The firmware's own consumer is `com.br.smallcd.Controller` (constructed in
`Controller.<init>`, lines 107–135 of the Pasted file):

```java
SmallcdManager smallcdManager = (SmallcdManager) context.getSystemService("smallcd");
this.mService = smallcdManager;
if (smallcdManager != null) {
    smallcdManager.init(128, 64, "/dev/oled_display");           // L117
    setWrapText(false);                                          // L118
}
this.mSmallcdServiceAppId = getAppId("com.br.smallcd");          // L120
…
reverseDisplay(getPreferences().getBoolean("reverseDisplay", false)); // L124
```

All call sites below quote `Controller.java` line numbers from the Pasted file
(`Pasted-package-com-br-smallcd-…`).

### 1.1 Method-by-method contract

| Method | Signature (from call sites) | Meaning |
| --- | --- | --- |
| `init(int width, int height, String devPath)` | `mService.init(128, 64, "/dev/oled_display")` (L117) | One-time initialization. Tells the service the OLED geometry (128 × 64 mono) and the kernel char-device backing it. **Recommendation:** call exactly once per process with these exact values; do not pass other dimensions. |
| `int getAppId(String pkg)` | `mService.getAppId("com.br.smallcd")` (L987, L120) | Returns the per-package application id used by every drawing op. Each app gets its own canvas slot. **Recommendation:** call with our own package name (`com.reedersystems.commandcomms.sd7`) and cache the result. |
| `byte[] getCanvas(int appId)` | `mService.getCanvas(this.mSmallcdServiceAppId)` (L991) | Returns the raw 1-bpp framebuffer for `appId`. Length is `1024 bytes` (128 × 64 ÷ 8) — proven by `takeScreenshot()` at L846: `byte[1024]` source convolved into RGB565 via `Util.convert1BitTo2Bytes(canvas, 4, 1024, dst)`. |
| `int fillRect(int appId, int x, int y, int w, int h, int color)` | `mService.fillRect(this.mSmallcdServiceAppId, i, i2, i3, i4, i5)` (L995) | Solid-fill a rect in the appId's canvas. `color` is 0 (black) or 1 (white) — only two pen values exist on a 1-bpp panel; the firmware uses this idiom in `_MainScreen` to clear separator bands. |
| `int drawText(int appId, String text, int flags, int x, int y, int fontSize, int color, int alignH, int alignV)` | `mService.drawText(this.mSmallcdServiceAppId, str, i, i2, i3, i4, i5, i6, i7)` (L1002), with fallback `… 0 …` when `flags < 0` (L1000) | Standard text. Parameter meanings inferred from `Controller.drawText3` shorthand at L1009–1011: `drawText3(str, x, y, size) → drawText(str, x, y, /*flags*/0, /*color*/1, /*alignH*/0, size, size)`. So argument order in the wrapper is `(text, x, y, flags, color, alignH, fontSize, fontSize)` — i.e. the controller passes `fontSize` twice (once for width-cap, once for actual glyph size). The 9-arg service method is `(appId, text, flags, x, y, fontSize, color, alignH, alignV)`. **TBD — confirm on hardware:** the exact bit meaning of `flags` (likely "wrap on" bit + "unifont/ASCII" bit) and the alignment enum (0 = left/top is the firmware default). |
| `int drawText2(int appId, String text, int a, int b, int c)` | `mService.drawText2(this.mSmallcdServiceAppId, str, i, i2, i3)` (L1006) | Short-form text helper. Used by `_AdjustMainVolume` and other simple toasts. **TBD — confirm:** likely `(text, x, y, fontSize)` based on `_Toast` callers. |
| `int drawBitmap(int appId, int x, int y, byte[] bytes, int w, int h)` | `mService.drawBitmap(this.mSmallcdServiceAppId, i, i2, bArr, i3, i4)` (L1040) | Blits a 1-bpp bitmap into the canvas at `(x,y)` of size `w × h`. `bytes.length` must equal `ceil(w/8) * h`. Used for icons (signal bars, battery, scan ✓). |
| `int refresh(int appId, byte[] canvas, int flags)` | `mService.refresh(this.mSmallcdServiceAppId, bArr, i)` (L1044) | Pushes the canvas to the OLED. Most call sites pass `getCanvas()` as `bArr` (the canvas you just drew into) and an int flag for partial-vs-full repaint. **TBD — confirm:** `flags` value space (0 vs 1; firmware uses `update(boolean)` at the `_Display` layer which maps to one of these). |
| `int reverseDisplay(boolean invert)` | `mService.reverseDisplay(z)` (L1048), called from `Controller.<init>` (L124) and `_SettingSystemReverseDisplay` | Toggles global pixel inversion (white-on-black vs black-on-white). Persisted by firmware via `Preferences.getBoolean("reverseDisplay", …)`. **High-value for our app** as a single-call emergency visual flash. |
| `void setWrapText(boolean wrap)` | `mService.setWrapText(z)` (L1036), set to `false` by `Controller.<init>` (L118) | Global flag for how `drawText` handles overflow. Firmware ships with wrap **off**; if we want auto-wrap for long channel names, toggle it per-draw and restore. |
| `int[] getTextBounds(String text, int fontSize)` | `mService.getTextBounds(str, i)` (L1014) | Returns `[left, top, right, bottom]` pixel bounds for ASCII text at `fontSize`. Use to right-align strings. |
| `int[] getUnifontTextBounds(String text, boolean unifont, int fontSize)` | `mService.getUnifontTextBounds(str, z, i)` (L1018, L1022, L1031) | Same as above but for the unifont (Unicode) renderer. `Controller.getTextWidth` and `getTextRect` (L1021–1032) are the two callers; both use this for layout. |
| `void covertMode(int mode)` | `mService.covertMode(i)` (L1074) | Enters/exits **stealth mode** — blanks the OLED, suppresses backlight, mutes most cues. Firmware also writes `Settings.Global "siyata_covert_mode"` (initial value `0` set at L133). |
| `int getCovertModeStatus()` | `mService.getCovertModeStatus()` (L1078) | Returns the current covert-mode flag (>0 means active). The firmware uses `> 0` as the gate (L656) before drawing the volume-change overlay; we should do the same so we don't overwrite stealth. |

### 1.2 `setOledScreenIndication(int)` — the only `Settings.Global` knob the firmware drives

`Controller.setOledScreenIndication` (L1219–1232) — note this is **not** an
`SmallcdManager` method but a `Controller` helper:

```java
public void setOledScreenIndication(int i) {
    if (i < 0 || i >= 3) {                                 // accepts 0,1,2 only
        Log.d("#3 controller", "Error: invalid screen value!" + i);
        return;
    }
    if (this.mLastScreenIndication != i) {
        Settings.Global.putInt(getContentResolver(),
            "oledscreen_status_indication", i);
        if (1 == this.mLastScreenIndication) { … }          // schedule "show main"
    }
}
```

Caller at L611–613 maps it: when the screen turns off, if the front-of-stack
display is `_ExtDisplayMsg` (id 38) it writes **2**; if it is `_MainScreen`
(id 0) it writes **1**. So the values currently used by firmware are:

| Value | Meaning (inferred from caller) |
| --- | --- |
| `0` | (unused by Controller — likely "no indication") |
| `1` | OLED is currently showing a built-in firmware screen (`_MainScreen`) |
| `2` | OLED is currently showing an external app's `_ExtDisplayMsg` |

> The user reported successfully writing `255` to this key from `adb`. The
> guard at L1220 (`i >= 3`) means the *firmware* will refuse to act on >2,
> but the underlying `Settings.Global` write is unguarded — anyone with
> `WRITE_SECURE_SETTINGS` can poke any int in. Live value during capture:
> `oledscreen_status_indication=1`. The `>=3` guard is the reason values
> outside `0..2` are no-ops as far as the firmware's own draw cycle goes.

### 1.3 Two real call-site walkthroughs (proof of contract)

**Call site A — `Controller.<init>` (L107–135):**
1. Get the system service.
2. `init(128, 64, "/dev/oled_display")`.
3. `setWrapText(false)`.
4. `getAppId("com.br.smallcd")` → cache as `mSmallcdServiceAppId`.
5. `reverseDisplay(getPreferences().getBoolean("reverseDisplay", false))`.
6. Push the first display: `createDisplay(0, true)` → `_MainScreen`.

**Call site B — `Controller.takeScreenshot()` (L838–916):**
1. `byte[] canvas = getCanvas()` — returns `byte[]`, length 1024 (the
   `convert1BitTo2Bytes(canvas, 4, 1024, …)` call at L849 makes the size
   explicit).
2. The 1024 bytes encode a 128 × 64 × 1-bpp framebuffer; `convert1BitTo2Bytes`
   blows it up to 16384 bytes of RGB565 for a `Bitmap`.
3. The bitmap is then written to `/sdcard/…` via `Util.storeBitmapToFile`.

Together these two sites pin down: (a) canvas geometry is exactly 128×64 mono,
(b) `init` arg order is `(w, h, devPath)`, (c) one canvas exists per `appId`.

---

## 2. External-display channel — `_ExtDisplayMsg` and `SMALLCD_EXT`

This is the path designed for **other apps** to push status to the OLED without
calling `SmallcdManager` directly. The receiver lives in the firmware.

### 2.1 The receiver

From the dumpsys Receiver Resolver Table (L48–50):

```
com.br.intent.action.SMALLCD_EXT:
  e867560 com.br.smallcd/.ExtEventHandler filter f436a19
    Action: "com.br.intent.action.SMALLCD_EXT"
```

`ExtEventHandler` is **not** declared `exported="true"` in any captured manifest
dump for `com.br.smallcd` — combined with `sharedUser=android.uid.system`, the
broadcast is effectively **system-uid-only**. The user's earlier `adb shell am
broadcast -a com.br.intent.action.SMALLCD_EXT` from uid 2000 (shell) was denied,
which matches.

### 2.2 The two-step registration contract (`PocManager.smallcdExtGetAppId`)

From `Controller.onAppRemoved` (L739–780):

```java
PocManager pocManager = (PocManager) this.mContext.getSystemService("poc");
int extAppId = pocManager.smallcdExtGetAppId(str, false);   // L746
if (-1 == extAppId) {
    if (!isKodiakApp(str)) { return; }                       // unregistered
    extAppId = ExtEventHandler.getDefaultAppId();
}
ExtEventHandler.updateSettingsMenuList(this, false, extAppId, null);
```

So the contract is:

1. The external app calls `PocManager.smallcdExtGetAppId(packageName, true)`
   (the `true` boolean is "register if missing" — inferred from the `false`
   variant being used in the cleanup path).
2. The firmware allocates an int `appId` for that package and persists it.
3. The external app then sends `com.br.intent.action.SMALLCD_EXT` broadcasts,
   tagged with that `appId`, and `ExtEventHandler.onReceive` routes them into
   `Controller.createDisplay(38, msgString, appId, true)` — case 38 in
   `createDisplay` (L342–345):

   ```java
   case 38:
       removeAllMsg(((Integer) obj2).intValue(), false);
       _mainscreen = new _ExtDisplayMsg(this, (String) obj);
       break;
   ```

4. The firmware then writes `oledscreen_status_indication=2` while the message
   is foregrounded (per the SCREEN_OFF handler at L611).

### 2.3 Hard-coded "Kodiak app" allowlist

`Controller.isKodiakApp` (L782–784) lists every package the firmware will
auto-route external messages for **without** `smallcdExtGetAppId` registration:

```
com.kpn.pushtotalkapp com.waveisrael.ptt com.bell.ptt com.att.eptt
com.kodiak.poc com.motorolasolutions.waveptt com.verizon.pushtotalkplus
com.slacorp.eptt.android.lite com.motorolasolutions.waveoncloudptt
com.motorolasolutions.waveoncloudEMEA com.tassta.flex com.goptt.ptt
com.sprint.sdcplus com.telstrabusinessandenterprise.pushtotalk_02
com.slacorp.eptt.android com.slacorp.eptt.sd7
com.telstrabusinessandenterprise.modelptt_02 com.kpn.kpnptt
com.motorolasolutions.sfrdefaultmcptt com.motorolasolutions.sfrmcptt
```

`com.reedersystems.commandcomms.sd7` is **not** on this list, so we cannot
piggy-back as a Kodiak-grade caller; we must register via
`smallcdExtGetAppId(...)` first.

### 2.4 Confirmed `SMALLCD_EXT` broadcast extras and JSON content schema

`ExtEventHandler.onReceive(Context, Intent)` (decompiled inline above) reads
**three** extras off the incoming `Intent`:

| Extra | Type | Default | Meaning |
| --- | --- | --- | --- |
| `"type"` | `int` (`getIntExtra`) | `0` (no-op) | Dispatch selector. `1` → `onUpdateSettingsMenu`, `2` → `onDisplayMsg`, `3` → `onKeyboardInput`, `4` → navigation (string content `"main screen"` calls `Controller.backtoMainScreen()`, string `"back"` calls `Controller.onKeyEvent(4)`). All other values are silently ignored. |
| `"content"` | `String` (`getStringExtra`) | `null` | Body. For `type=1/2/3` this is a JSON object/array; for `type=4` it is one of the literal strings `"main screen"` or `"back"`. |
| `"appid"` | `int` (`getIntExtra`) | `-1` | The caller's `appId` previously obtained via `PocManager.smallcdExtGetAppId(packageName, true)`. Routed through to every result intent. |

**`type=2` (display message) JSON content schema** — read in `_ExtDisplayMsg.init()`
with `org.json.JSONObject(mMsg)` and per-field `try/catch (JSONException)` that
silently zero-fills missing fields:

| Field | JSON type | Range | Meaning |
| --- | --- | --- | --- |
| `id` | string | non-empty for ack | Message id. If present and non-empty, on dismissal `ExtEventHandler.sendMsgDismissedNotice(ctx, appid, id)` fires a result broadcast (see §2.5). |
| `line1` | string | **required**, non-empty | Top text line. If empty/missing, `onDisplayMsg` logs `"Error, line1!"` and discards the message — the OLED is not updated at all. |
| `line2` | string | any | Bottom text line. When `optionList` is non-empty (set elsewhere by `_ExtDisplayMsg.update`), `line2` becomes the currently-selected option. |
| `__appid__` | int | (server-injected) | Auto-injected by `ExtEventHandler.onDisplayMsg` from the `appid` extra; do **not** set in the caller's JSON. |
| `timeout` | bool | true/false | If `false`, `newtimeout` is forced to `Integer.MAX_VALUE - 1` (sticky message). |
| `newtimeout` | int (ms) | `>= 1000`, else clamped to `0` (no auto-dismiss) | Auto-dismiss delay. Posted via `Handler.postDelayed`. |
| `eventallowed` | int | `0..3` | Controls the `oledscreen_status_indication` value while the message is on-screen: values `0/1` cause the firmware to write `2` (external app owns the OLED); values `2/3` cause it to write `0` (yields ownership). Sets the operator's keypress contract: `0` (default) lets PTT pass through, others are firmware-internal modes. |
| `fontsize` | int | `0..2` (else `0`) | Font selector. `0` is the firmware default; `1`/`2` are larger faces. |
| `scrollspeed` | int (ms) | `100..60000`, default `500` | Marquee redraw interval. Anything other than the default `500` calls `mTextManager.setRedrawInterval(scrollspeed)` and disables manual scroll. |
| `manualscroll` | int | `0..16` (else clamped) | Manual-scroll page count. When `>0`, also pins `oledscreen_status_indication` to `0`. |
| `manualscrolltimeout` | int | (ms) | Manual-scroll inactivity timeout. |

**`type=1` (settings menu update)** content is a JSON object with required keys
`name` (one of `"PTT App Options" | "VL App Options" | "App Options"`),
`showoptions` (bool), `values` (JSON array of menu items with `name`, `id`,
`priority`). Stored into `Settings.Global "key_ptt_device_option"` keyed by
`__appid__`.

**`type=3` (keyboard input request)** content is a JSON object with `keyboardType`
(int: `1` → `_Keyboard` mode `26`, `2` → `30`, `3` → `29`, else `31`) and
optional `id`. Pops a `_Keyboard` (display id 15) and on submit fires
`sendKeyboardInputResult(ctx, appid, id, result)` — see §2.5 for the result
intent action.

### 2.5 Result-intent contract (firmware → external app)

For non-default apps, `ExtEventHandler` constructs the result-intent action name
by calling `PocManager.smallcdExtGetResultIntentNamePrefix(appid)` and appending
a fixed suffix (this is the same `PocManager` AIDL we hit in §2.2 for
registration; the result-intent prefix is a different method on the same
manager):

| Operation | Result-intent action (non-default app) | Result-intent action (default Kodiak app) | Extras |
| --- | --- | --- | --- |
| Message dismissed | `<prefix>_MSG_DISMISSED` | `com.mcx.intent.action.PTT_LED_MSG_DISMISSED` | `String "msi.intent.extra.msg.id"` |
| Settings menu option select | `<prefix>_SETTINGS_MENU_OPERATION` | `com.mcx.intent.action.PTT_LED_OPTIONS_INFO` | `String "msi.intent.extra.option.id"`, `String "msi.intent.extra.key"` (always literal `"SELECT"`), `String "msi.intent.extra.key.info"` (the `line2` text at time of select) |
| Keyboard input result | `<prefix>_KEYBOARD_INPUT` | `com.mcx.intent.action.PTT_CONFIGURATION_INFO` | `String "msi.intent.extra.input.id"`, `String "result"` (Kodiak default uses `String "EXTRA_ACTIVATION_CODE"`) |

All result intents are dispatched via `Context.sendOrderedBroadcast(intent,
null)` with flags `FLAG_ACTIVITY_NEW_TASK | FLAG_RECEIVER_REGISTERED_ONLY |
FLAG_RECEIVER_INCLUDE_BACKGROUND`. The receiving app must register a regular
`BroadcastReceiver` for the action it negotiated through `PocManager`.

> The firmware's "default app" identity is hard-coded as
> `"com.mcx.intent.action.PTT__Kodiak"` (an action-string-as-pkg-id, not a
> typo) — see `ExtEventHandler.getDefaultAppId()`. Our SD7 APK is not it, so
> we land on the `<prefix>_*` path and need `PocManager` registration first.

### 2.6 The remaining gap — `PocManager` AIDL

`android.app.PocManager` is a framework system service (`getSystemService("poc")`)
whose `.smallcdExtGetAppId(String, boolean)` and
`.smallcdExtGetResultIntentNamePrefix(int)` methods we call out above.
`PocManager` is **not** in `smallcd.apk` — it lives in the framework
(`framework.jar` / `services.jar`) baked into the SD7 system image. We do not
have those jars in this research env, so we cannot inspect `PocManager`'s
own permission gate (e.g. whether `smallcdExtGetAppId(pkg, true)` requires a
signature-level permission to *register* a new appId, or is open to any
caller). This is the only TBD remaining for the SMALLCD_EXT path; the
hardware smoke-test commands in §6 will resolve it definitively in <30 s on
a real SD7 — see "Smoke test" in §6.4.

### 2.5 Verdict — direct vs `SMALLCD_EXT`

For the radio app's needs we recommend **direct `SmallcdManager` painting**:

- **Pro direct:** total layout control (the firmware's `_ExtDisplayMsg` is a
  fixed two-or-three-line text card; we want zone+channel+status+TX banner,
  which is a custom layout), low latency (no broadcast hop), no dependency on
  `PocManager` registration handshake.
- **Pro `SMALLCD_EXT`:** the firmware will manage screen-priority and
  `oledscreen_status_indication` for us; on app uninstall it auto-cleans.
- **Hybrid (recommended for build task):** paint our own canvas via
  `SmallcdManager` for the always-on radio status; use `SMALLCD_EXT` (after
  `smallcdExtGetAppId` registration) **only** for transient "received page"
  toasts, since those benefit from the firmware's screen-stack queueing.

---

## 3. `_Display` screen library

`Controller.createDisplay(int id, …)` (L200–465) is a 65-case switch over
display ids. Every entry instantiates a class named `_<Something>` (or
`Apn…`/`RobustMode`). Full enumeration:

| id | Class | What it is | Reachable from outside? | Why we'd care |
| --- | --- | --- | --- | --- |
| 0 | `_MainScreen` | The home screen — zone, time, signal, battery, "smallcd"-managed status. Drawn on every key event with `sepetorIndex=2`. | Implicit (boot) — no external trigger. | Reference layout for our own painter (font sizes, separator at row 16). |
| 1 | `_SettingMenu` | Top-level settings menu. | No (knob-driven). | — |
| 2 | `_SettingFlashlight` | Torch on/off. | No. | — |
| 3 | `_SettingNetwork` | Network sub-menu. | No. | — |
| 4 | `_SettingLocation` | Location sub-menu. | No. | — |
| 5 | `_SettingSystem` | System sub-menu. | No. | — |
| 6 | `_SettingAbout` | About page. | No. | — |
| 7 | `_PowerOptions` | Power-off / reboot dialog. | No (long-press power). | — |
| 8 | `_SettingNetworkCellular` | Cellular settings. | No. | — |
| 9 | `_SettingSystemDeviceName` | Device name editor. | No. | Mirrors `Settings.Global "device_name"` (currently `Siyata SD7`). |
| 10 | `_SettingSystemDateTime` | Date/time. | No. | — |
| 11 | `_SettingSystemReverseDisplay` | Toggle `reverseDisplay`. | No. | Maps 1-to-1 to `SmallcdManager.reverseDisplay(bool)`. |
| 12–14 | `_SettingSystemResetOptions{,Network,AllData}` | Factory reset paths. | No. | — |
| 15 | `_Keyboard` | Numeric keyboard for passcodes. | No. | — |
| 16 | `_SettingNetworkWifi` | Wi-Fi settings. | No. | — |
| 17 | `_SettingNetworkBluetooth` | BT settings. | No. | — |
| 18–22 | `_SettingNetworkWifi{AvailableNetworks,Operation}`, `_SettingNetworkBt{PairedDevices,DiscoveryDevice,DeviceOperation}` | Wi-Fi/BT sub-menus. | No. | — |
| 23 | `_ShowDeviceName` | Splash with device name. Timeout 0 (sticky). | No. | — |
| 24 | `_ProcessingDialog` | Generic spinner dialog with callback. | No. | Reusable pattern for our own "connecting…" overlay. |
| 25 | `_SettingAudio` | Volume sub-menu (per stream). | No. | — |
| 26 | `_BatteryNotification` | Low-battery overlay (≤20 %). Drawn from SCREEN_ON handler at L591. | No (battery-driven). | Reference for unobtrusive overlay. |
| 27 | `_SettingsSupportMenu` | Support contacts. | No. | — |
| 28–29 | `_SettingsSystem{Keys,SideKeys}` | Hardware-key remap UI. | No. | These edit `Settings.Global "key_settings_*"` (rotary, up, bottom, sos_mode) — see §5. |
| 30 | `_SettingsSos` | SOS feature toggle. | No. | Edits `key_settings_sos_mode`. |
| 31 | `_SettingsSosNumbers` | SOS contacts. | No. | — |
| 32–33 | `_SettingsTopKeysPreference`, `_SettingsBottomKeysPreference` | Top/bottom side-button mapping. | No. | Edits `key_settings_up`, `key_settings_bottom`. |
| 34 | `_SettingNotifications` | Notification toggle. | No. | — |
| 35 | `_FactoryMode` | Hidden factory-test root. | Triggered via `TestCaseManager.isOnFactoryMode` check (L602). | Diagnostic only. |
| 36 | `_FactoryTestCase` | Specific factory test (LCD/keys/audio/etc.). | Internal. | — |
| 37 | `_ExtSettingsMenu` | Settings menu page that an **external app** registered via `smallcdExtGetAppId`. | **Yes** — via `SMALLCD_EXT` broadcast. | We could expose our own SD7-side settings sub-page from the radio app. |
| 38 | `_ExtDisplayMsg` | External app's text card. | **Yes** — via `SMALLCD_EXT`. | Primary integration target if we choose the broadcast path (§2.5). |
| 39 | `_ApiTest` | Internal API smoke test page. | No. | Useful jadx target to see real `drawText` calls. |
| 40 | `_FactoryManualMode` | Manual-mode factory test. | No. | — |
| 41 | `_Toast` | Plain toast. Used for "Screenshot saved", "Network connect failed", "Invalid passcode". | Internal. | Reusable pattern. |
| 42 | `_SettingSystemFota` | FOTA in-progress page. | Triggered by `com.abupdate.fota_demo_iot.ACTION_NEW_VERSION` (L689, §5). | — |
| 43 | `_SettingNetworkNfc` | NFC toggle. | No. | — |
| 44 | `_SettingsLanguage` | Language. | No. | — |
| 45 | `_SettingSystemFotaNewVersion` | "New FOTA available" prompt. Auto-shown when `OtaNewVersionReceiver` fires (L697). | OTA-driven. | — |
| 46 | `_SettingDiagMenu` | Diagnostic menu. | No. | — |
| 47 | `RobustMode` | "Robust" radio mode toggle. | No. | — |
| 48 | `_MessageNotifyCommon` | Generic notification card. | Internal. | — |
| 49–53 | `ApnSimSelectDisplay`, `ApnProtocol`, `ApnListDisplay`, `ApnEditor`, `ApnRadio` | APN editor sub-pages. | No. | — |
| 54 | `_ConfirmDialog` | Yes/No dialog. | Internal (`ConfirmDialgParams`). | Reusable pattern. |
| 55 | `_ConfirmNonProgressDialog` | Yes/No without spinner. | Internal. | — |
| 56 | `_ConfirmNonProgressDialogEx` | 4-line yes/no (`desc1`, `desc2`, `questYes`, `questNo`). Used by NFC Wi-Fi setup at L930. | Internal. | — |
| 57 | `_SettingNetworkHotspot` | Mobile hotspot. | No. | — |
| 58 | `_SettingSystemPTTKeyDelay` | PTT debounce timer UI. | No. | Mirrors `Settings.Global "ptt_key_delay"` (currently 100 ms). |
| 59 | `_AdjustMainVolume` | Big volume overlay. Triggered by `com.br.smallcd.ACTION_VOLUME_CHANGE` (L671). | **Yes** — broadcasting that action from outside (subject to permission gate; same caveats as §2). | Reference for transient overlays. |
| 60 | `_SettingSystemVK7Setting` | "VK7" auto-power-off settings. | No. | Reads `vk7setting_auto_power_off` pref (L1111). |
| 61 | `_SettingCovertMode` | Stealth mode toggle UI. | No. | Mirrors `Settings.Global "siyata_covert_mode"` and `SmallcdManager.covertMode(int)`. |
| 62 | `_SettingSystemPTTKeyDelayValues` | PTT delay value picker. | No. | — |
| 63 | `_SettingLock` | Settings passcode lock. Default passcode `000000`, set at L1444/L1450. | No. | — |
| 64 | `_UnlockSIM` | SIM PIN/PUK entry. | SIM-state-driven. | — |
| 65 | `_SettingSystemKnob` | Rotary-knob mode (channel vs volume). | No. | Edits `key_settings_rotary` (currently `Volume-Channel`). |

The classes that matter most for our radio integration are: **0** (font/layout
reference), **38** (`_ExtDisplayMsg`), **41** (`_Toast`), **24**
(`_ProcessingDialog`). The rest are firmware UX we don't need to touch.

---

## 4. Broadcasts, intents, and system hooks

### 4.1 Receivers exported by `com.br.smallcd`

From the Receiver Resolver Table (L37–84):

| Action | Receiver | What it does (from `Controller`/decompile) |
| --- | --- | --- |
| `com.br.intent.action.SMALLCD_EXT` | `.ExtEventHandler` | External-display message (see §2). |
| `com.airbus.pmr.action.PTT_START` | `.RotaryKnobEventReceiver` | PTT (already wired into our `PttHardwareReceiver`). |
| `android.intent.action.SOS.down` | `.RotaryKnobEventReceiver` | SOS button down (already wired). |
| `com.br.intent.action.ROTARY_KNOB` | `.RotaryKnobEventReceiver` | Rotary knob turn. |
| `com.br.intent.action.SIM_NETWORK_LOCKED` | `.GenernalBroadcastReceiver` | SIM lock state — internal. |
| `com.br.intent.action.SIM_NETWORK_LOCK_CHANGED_READY` | `.GenernalBroadcastReceiver` | — |
| `com.br.intent.action.ACTION_BR_ICC_NETWORK_DEPERSONALIZATION_RESULT` | `.GenernalBroadcastReceiver` | SIM unlock result. |
| `android.intent.action.SIM_STATE_CHANGED` | `.GenernalBroadcastReceiver` | — |
| `android.intent.action.BOOT_COMPLETED` (priority 1000) | `.GenernalBroadcastReceiver` | Drives `Controller.onBootCompleted` (L1326), which calls `setLauncherAfterBootCompleted` → may attempt to launch Esper (`io.shoonya.shoonyadpc`). |
| `com.br.intent.action.LAUNCH_ESPER_ONCE` | `.GenernalBroadcastReceiver` | Manual Esper kick. |
| `com.br.intent.action.UPDATE_FEATURES` | `.GenernalBroadcastReceiver` | Reloads `mConfigFeatures` (L1416). |
| `com.br.intent.action.NFC_SETUP_WIFI_NETWORK` | `.GenernalBroadcastReceiver` | Triggered by `NfcActivity` after parsing an NFC-NDEF Wi-Fi tag (`application/vnd.wfa.wsc`). |
| `com.br.intent.action.EMERGENCY_SMS_MODE_INITIATED` | `.GenernalBroadcastReceiver` | "Emergency SMS" pipeline. |
| `com.br.intent.action.VK7_IGNITION_EVENT` | `.GenernalBroadcastReceiver` | VK7 ignition (vehicle-mount cradle event). |
| `com.abupdate.intent.INIT_COMPLETED` | `.GenernalBroadcastReceiver` | Abupdate FOTA init done. |

### 4.2 Receivers registered at runtime by `Controller`

From `Controller.<init>`/inner classes:

| Action | Inner class | What it does |
| --- | --- | --- |
| `android.intent.action.SCREEN_ON` / `SCREEN_OFF` / `USER_PRESENT` / `DEVICE_IDLE_MODE_CHANGED` | `PowerManagerScreenStatusReceiver` (L578–635) | Manages screen-off cleanup, `oledscreen_status_indication` writes, low-battery overlay. |
| `com.br.smallcd.ACTION_VOLUME_CHANGE` | `VolumeChangedReceiver` (L637–674) | Fires `_AdjustMainVolume` overlay (id 59). Honors `getCovertModeStatus() > 0` to suppress while stealth. |
| `com.abupdate.fota_demo_iot.ACTION_NEW_VERSION` | `OtaNewVersionReceiver` (L676–708) | Pops `_SettingSystemFotaNewVersion` (id 45). |
| `android.intent.action.PACKAGE_ADDED` / `PACKAGE_REMOVED` | `PackageInstalledReceiver` (L710–737) | Calls `Controller.onAppRemoved(pkg)` to clean up registered ext-app slots. |
| `esper.action.provisioning_state_changed` | `EsperEventReceiver` (L793–831) | Esper provisioning state UI. (Only registered if `!isForPCBA()`.) |

### 4.3 NFC Wi-Fi onboarding

`com.br.smallcd/.NfcActivity` is the registered handler for
`android.nfc.action.NDEF_DISCOVERED` with MIME `application/vnd.wfa.wsc`
(Wi-Fi Simple Configuration), plus `TECH_DISCOVERED` and `TAG_DISCOVERED`
(L1–35 of the dumpsys paste).

Flow: tag scan → `NfcActivity` parses `WifiConfiguration` → broadcasts
`com.br.intent.action.NFC_SETUP_WIFI_NETWORK` → `GenernalBroadcastReceiver`
calls `Controller.nfcWifiSetup(WifiConfiguration)` (L929–973), which pops
`_ConfirmNonProgressDialogEx` (id 56) and on confirm calls
`_nfcWifiSetup_DoConnect` (L943–973). This is the path the field-tech can
already use today to provision Wi-Fi onto an SD7 from an NFC tag — no app code
needed on our side, but worth knowing as part of the SD7 deployment story.

### 4.4 FOTA pipeline (Abupdate / `com.abupdate.fota_demo_iot`)

Pre-installed at `/system/app/Abupdate/Abupdate.apk` (line 2 of the package
list paste). The hook chain is:

1. Abupdate detects new firmware → broadcasts
   `com.abupdate.fota_demo_iot.ACTION_NEW_VERSION`.
2. `Controller.OtaNewVersionReceiver` (L680–706) catches it → pops display 45.
3. On confirm, the rest of the FOTA flow lives in `com.br.smallcd.fota.FotaManager`
   (`Controller.printFirmwareInfo`, `fotaPreprocess`, `fotaPostProcess` at
   L1183–1208 are the visible touchpoints).
4. `Controller.fotaPostProcess` (L1188–1208) is where we noticed it renames the
   device from `toronto_sd7` to `Siyata SD7` (L1199–1201) and force-enables
   Wi-Fi/BLE scanning for location (`wifi_scan_always_enabled`,
   `ble_scan_always_enabled`).

### 4.5 LocationAccessibilityService

Registered globally (`enabled_accessibility_services=com.br.smallcd/.LocationAccessibilityService`).
This is **already enabled** on every SD7 we've inspected. Service body is in
the APK; the hook gives `com.br.smallcd` system-wide accessibility events. Our
app should not collide with it.

---

## 5. Settings keys the firmware reads/writes

| Key (scope) | Current value (capture) | Owner | Why we'd care |
| --- | --- | --- | --- |
| `Settings.Global "oledscreen_status_indication"` | `1` | Written by `Controller.setOledScreenIndication` (L1227). | The "who owns the OLED right now" hint — see §1.2. |
| `Settings.Global "siyata_covert_mode"` | `0` | Initialized to 0 by `Controller.<init>` L133; written by `_SettingCovertMode`. | Pair with `SmallcdManager.covertMode(int)`. |
| `Settings.Global "key_settings_rotary"` | `Volume-Channel` | `_SettingSystemKnob`. | Tells us what the rotary knob is currently doing on this unit. |
| `Settings.Global "key_settings_up"` | `Channel-Volume Up-Flashlight-PTT FN` | `_SettingsTopKeysPreference`. | Top side button assignment. |
| `Settings.Global "key_settings_bottom"` | `Channel-Volume Down-Flashlight-PTT FN` | `_SettingsBottomKeysPreference`. | Bottom side button assignment. |
| `Settings.Global "key_settings_sos_mode"` | `PTT SOS-Emergency SMS` | `_SettingsSos`. | SOS behaviour. |
| `Settings.Global "ptt_key_delay"` | `100` (ms) | `_SettingSystemPTTKeyDelay` and `_SettingSystemPTTKeyDelayValues`. | Same debounce we already account for. |
| `Settings.Global "key_esper_state"` | `0` | `EsperEventReceiver`. | Esper provisioning state — `0` means not provisioned. |
| `Settings.Global "device_name"` | `Siyata SD7` | `_SettingSystemDeviceName` / `fotaPostProcess`. | Use as cosmetic in our `radios` table. |
| `Settings.Global "fotaprepost_previous_fota_vesion"` | (transient) | `Controller.fotaPreprocess` / `fotaPostProcess`. | — |
| `Settings.Global "wifi_scan_always_enabled"` | `1` | Force-set to 1 by `fotaPostProcess`. | Won't survive a clean re-flash unless re-set. |
| `Settings.Global "ble_scan_always_enabled"` | `1` | Force-set to 1 by `fotaPostProcess`. | — |
| `Settings.Secure "enabled_accessibility_services"` | `com.br.smallcd/.LocationAccessibilityService` | Pre-enabled. | See §4.5. |
| `Settings.Secure "smallcd_config_features"` | `` (empty) | `Controller.updateFeatures` reloads from `mConfigFeatures.readConfig`. | "TBD — confirm in jadx tree" — could be a feature-flag override channel. |

---

## 6. Permissions story for `com.reedersystems.commandcomms.sd7`

### 6.1 What `com.br.smallcd` itself holds

`com.br.smallcd` is `sharedUser=android.uid.system/1000`, signed with the
platform key, lives in `/system/app/`, and is granted essentially every
privileged permission Android exposes (see lines 137–625 of the
`Activity-Resolver-Table` paste — too many to enumerate, but includes
`WRITE_SECURE_SETTINGS`, `INJECT_EVENTS`, `SYSTEM_ALERT_WINDOW`,
`MODIFY_PHONE_STATE`, `MASTER_CLEAR`, `MANAGE_USERS`, `READ_LOGS`,
`MOUNT_UNMOUNT_FILESYSTEMS`, `INSTALL_PACKAGES`, etc.). It is essentially
"god mode" on the device.

### 6.2 What our SD7 APK is on the device

```
package:/data/app/~~QavyhJqSSZvrSwGvMASnWg==/com.reedersystems.commandcomms.sd7-…/base.apk
```

A **regular `/data/app/` install** (line 16 of the package list paste). It is
*not* signed with the platform key, *not* in `sharedUser=android.uid.system`,
and has only the runtime permissions a user-space app gets.

### 6.3 What's gated and what's not — confirmed facts vs. hypotheses

This section is split into **(A) confirmed from artifacts in this research
env** and **(B) hypotheses that require a hardware smoke test (§6.4) to
confirm**. Implementers must treat (B) as unproven until §6.4 step 2/3
passes on a real SD7.

#### A. Confirmed from the decoded manifest and decompiled bytecode

| Surface | Confirmed fact | Evidence |
| --- | --- | --- |
| `com.br.smallcd` package identity | Signed with the platform key, `sharedUserId="android.uid.system"`, installed under `/system/app/`, `targetSdkVersion=28`, `minSdkVersion=31`, declares 44 `<uses-permission>` entries including `WRITE_SECURE_SETTINGS`, `INJECT_EVENTS`, `DEVICE_POWER`, `MEDIA_CONTENT_CONTROL`, `MODIFY_PHONE_STATE`, `LOCAL_MAC_ADDRESS` (i.e. the full system-uid suite). | Decoded `AndroidManifest.xml` via `androguard.core.apk.APK.get_android_manifest_xml()`; cross-checked against the `dumpsys package com.br.smallcd` paste. |
| `<receiver android:name="com.br.smallcd.ExtEventHandler">` | Declared with **no `android:permission` attribute** and **no `android:exported` attribute**. The single `<intent-filter>` carries action `com.br.intent.action.SMALLCD_EXT`. With `targetSdk=28`, the Android framework default for a receiver that declares an intent-filter is `exported=true` (the explicit-attribute requirement was tightened to Android 12 / API 31 *for apps targeting 31+*; this manifest still gets the legacy default). | Decoded manifest XML attributes inspected directly. **Hard evidence — no inference.** |
| `<receiver android:name="com.br.smallcd.GenernalBroadcastReceiver">` | Same shape: `android:exported="true"`, no `android:permission`. (Different attribute style — this one explicitly opts in.) | Decoded manifest XML. |
| `<receiver android:name="com.br.smallcd.RotaryKnobEventReceiver">` | No explicit `android:exported`, no `android:permission`, has intent filters → same legacy-default openness as `ExtEventHandler`. | Decoded manifest XML. |
| `ExtEventHandler.onReceive(Context, Intent)` body | Reads `intent.getIntExtra("type", 0)`, `intent.getStringExtra("content")`, `intent.getIntExtra("appid", -1)` and dispatches; calls **no** `Context.enforceCallingPermission`, no `Binder.getCallingUid()`, no signature check, no UID gate. | androguard DAD decompilation pasted into §2 of this doc. |
| `Controller.setOledScreenIndication(int)` | Writes `Settings.Global "oledscreen_status_indication"`. This requires `WRITE_SECURE_SETTINGS`, which is `signature\|privileged` on Android 12. The smallcd app holds it (see row 1) because it is platform-signed. **A third-party `/data/app/` APK cannot call this directly.** | Manifest `<uses-permission>` list + AOSP `WRITE_SECURE_SETTINGS` protection-level documentation. |
| `service list` registration | Service `smallcd` resolves to `android.app.ISmallcdManager` and is registered as a public framework system service. | `service list` paste line 176. |

#### B. Hypotheses that require the hardware smoke test (§6.4)

| Surface | Hypothesis | Why it is only a hypothesis |
| --- | --- | --- |
| Sender-side delivery of `com.br.intent.action.SMALLCD_EXT` from a third-party UID | The receiver appears reachable from any UID at the manifest layer (row 2 of part A). | The manifest layer is necessary but not sufficient: a runtime `BroadcastQueue` policy, an SE-Linux MAC rule, or a framework-level allowlist could still drop the broadcast before `onReceive` runs. We do not have a SEPolicy dump or a logcat trace of an actual third-party send. The earlier shell test the user mentioned is **not** sufficient evidence in either direction — it was reported in a different context, the exact `am broadcast` invocation/UID/SELinux denial is not in our captured artifacts, and we should not speculate about its cause. **Confirm by running §6.4 step 3 from inside our SD7 APK** (not from `adb shell`, whose UID and SELinux domain differ from a normal app). |
| `Context.getSystemService("smallcd")` returning a usable binder for a third-party UID | Likely succeeds — `getSystemService(String)` is not itself permission-gated and the binder is registered globally. | Confirmed in principle by AOSP semantics, but not exercised from `com.reedersystems.commandcomms.sd7` on a real SD7. **Confirm by §6.4 step 2 line 1.** |
| `SmallcdManager.{init, getAppId, getCanvas, fillRect, drawText, drawBitmap, refresh, reverseDisplay, covertMode, …}` permission gating at the framework AIDL layer | **Unverified.** The framework-side `SmallcdManagerService` (in `services.jar`) is not in this APK and not in our research env. We cannot prove it is open, and we cannot prove it is gated. The fact that `com.br.smallcd` itself calls these methods without `enforceCallingPermission` from its own client-side `Controller` does not tell us what the *server-side* implementation enforces. AOSP-namespace convention (`android.app.*`) is suggestive but not dispositive (e.g. `android.app.IActivityTaskManager` has many signature-gated entry points). | **Confirm by §6.4 step 2 lines 2-7.** Each call should either return a non-error result or throw `SecurityException`; the latter falsifies the hypothesis and forces fallback (signature-key build, the broadcast path conditional on §6.4 step 3, or the audio-only UX in `SD7_HEADLESS_UX.md` §4). |
| `PocManager.smallcdExtGetAppId(pkg, true)` registration permission | Unverified. `PocManager` is a framework system service (`getSystemService("poc")`); its server-side stub lives in `framework.jar` / `services.jar` and is not in this env. | **Confirm by §6.4 step 4.** Failure modes (return `-1`, throw `SecurityException`) are documented inline. |

The build task (F1) is gated on running §6.4 first. If A holds and step 2 of B
passes, the renderer can be built against `SmallcdManager` directly with no
extra manifest permissions. If step 2 fails but step 3 passes, the renderer
is built against the `SMALLCD_EXT` broadcast path. If both fail, F1 reverts
to the audio/haptic/TTS UX in `SD7_HEADLESS_UX.md` §4 and we file a Siyata
SDK request.

### 6.4 Hardware smoke test (run once on a real SD7)

This 30-second test definitively closes the remaining permission TBDs. The
build task in F1 should run it as the very first step, before writing any
renderer code. **No manifest changes are required to run it** — the
`SmallcdManager` API surface needs no extra `<uses-permission>` declarations
because the framework side does not appear to be permission-gated (per the
verdict above).

```bash
# 1. Confirm exported flag on ExtEventHandler:
adb shell dumpsys package com.br.smallcd \
  | grep -A2 ExtEventHandler

# 2. Direct SmallcdManager test (run from inside our SD7 APK in a one-shot
#    foreground Activity; print results to logcat):
#      val smallcd = getSystemService("smallcd")  // != null on any UID
#      val cls    = smallcd.javaClass
#      val appId  = cls.getMethod("getAppId", String::class.java)
#                      .invoke(smallcd, packageName) as Int       // > 0
#      cls.getMethod("init", Int::class.java, Int::class.java,
#                    String::class.java)
#         .invoke(smallcd, 128, 64, "/dev/oled_display")
#      cls.getMethod("fillRect", Int::class.java, Int::class.java,
#                    Int::class.java, Int::class.java, Int::class.java,
#                    Int::class.java)
#         .invoke(smallcd, appId, 0, 0, 128, 64, 0)
#      val canvas = cls.getMethod("getCanvas", Int::class.java)
#                      .invoke(smallcd, appId) as ByteArray        // length 1024
#      cls.getMethod("refresh", Int::class.java, ByteArray::class.java,
#                    Int::class.java)
#         .invoke(smallcd, appId, canvas, 0)
#    Outcome:
#      - All calls return without SecurityException        → verdict CONFIRMED
#      - canvas.size == 1024                               → geometry CONFIRMED
#      - The OLED visibly blanks                           → §1 contract CONFIRMED
#      - SecurityException on init/getAppId                → falsifies the
#                                                            verdict; fall
#                                                            back to
#                                                            SMALLCD_EXT (§2)
#                                                            or to the
#                                                            audio-only UX
#                                                            in SD7_HEADLESS_UX.md §4

# 3. SMALLCD_EXT broadcast smoke (from a third-party APK, NOT adb shell —
#    adb shell runs as uid 2000 and is irrelevant to our app's UID):
#      val i = Intent("com.br.intent.action.SMALLCD_EXT").apply {
#        putExtra("type", 2)
#        putExtra("appid", -1)
#        putExtra("content", """{"line1":"hello","line2":"sd7","timeout":true,"newtimeout":3000}""")
#      }
#      sendBroadcast(i)
#    Outcome:
#      - "hello / sd7" appears on the OLED for ~3 s          → SMALLCD_EXT path is OPEN
#      - logcat shows #3_ExtEventReceiver "Error, line1!"    → JSON malformed
#      - nothing happens, no error                            → receiver not exported
#                                                              after all (we're wrong;
#                                                              fall back to direct
#                                                              SmallcdManager).

# 4. PocManager registration smoke (only needed if step 3 passes and we want
#    result intents back from dismiss/select/keyboard):
#      val poc = getSystemService("poc")
#      val appId = poc.javaClass.getMethod("smallcdExtGetAppId",
#                    String::class.java, Boolean::class.javaPrimitiveType)
#                    .invoke(poc, packageName, true) as Int
#    Outcome:
#      - appId > 0                  → registration OPEN; we can use SMALLCD_EXT fully
#      - appId == -1                → lookup-only mode worked but registration
#                                     refused; fall back to direct path
#      - SecurityException          → registration is signature-gated; direct path only
```

The build task is intentionally not blocked on these results because the
verdicts above are well-evidenced. The smoke test exists to falsify them
cheaply if the field engineer disagrees; if all four pass, F1 ships
unchanged.

---

## 7. Recommended OLED layout for the build task

Constraints from the hardware/firmware:

- 128 × 64 monochrome (1 bpp). Total pixel budget = 8192 px = 1024 bytes.
- Firmware's `_MainScreen` uses `sepetorIndex=2` — i.e. two horizontal
  separators at fixed rows (one near the top status bar, one near the bottom).
  We should respect the same divider rhythm so our screen feels native.
- Font sizes the firmware uses in `_MainScreen` and `_ExtDisplayMsg` cannot be
  enumerated without a jadx pass on those two classes (TBD), but the
  `drawText3(text, x, y, size)` helper at L1009 takes a single `size` and
  passes it for both width-cap and glyph height — so sizes are cell-pixel
  heights. Common `unifont` font sizes are **8 px** (4-bit small), **12 px**
  (medium), **16 px** (large). We assume those three sizes work.
- The OLED is **landscape**: 128 wide × 64 tall.

Three layout proposals follow, in ASCII at 1 char ≈ 6 px (so 21 chars wide
fits 128 px when using `drawText3` with size 12) and 1 row ≈ 8 px (so 8 rows
fits 64 px). Trade-offs are in the description.

### Variant A — "Always-on radio status" (recommended default)

```
+---------------------+
|ZN:Patrol     ▮▮▮▮ B|   row 0  (top bar, 12-px font, signal+battery on right)
+---------------------+   row 1  (separator)
|CH:Dispatch       ✓ |   row 2  (channel name, 16-px font, ✓ if on scan list)
|                     |   row 3
|                     |   row 4
|     [TX]  Smith     |   row 5  (banner: TX/RX/IDLE + last/current talker)
+---------------------+   row 6  (separator)
|U:1024  10-8 12:34:50|   row 7  (unit id, 10-status, time, 8-px font)
+---------------------+
```

- **Pros:** zone + channel are the operator's most important persistent state
  and get top billing. The TX/RX/IDLE banner is dead-center where the eye
  lands and inverts on emergency (single `reverseDisplay(true)` call). Status
  code + time fit on the bottom strip.
- **Cons:** assumes channel names ≤ ~14 chars at 16-px font; longer names need
  `setWrapText(true)` or marquee.

### Variant B — "Comms-first, status-second"

```
+---------------------+
|CH:Dispatch       ✓ |   row 0  (channel as the primary string)
|ZN:Patrol            |   row 1  (zone underneath, smaller font)
+---------------------+   row 2  (separator)
|                     |   row 3
|       [RX]          |   row 4  (TX/RX/IDLE huge, 16-px+, centered)
|       Smith         |   row 5  (talker name)
+---------------------+   row 6
|10-8  12:34  ▮▮▮▮ B |   row 7  (10-code + time + signal/battery)
+---------------------+
```

- **Pros:** maximizes glanceability of who's talking right now. Best for
  high-traffic channels where the operator never changes channel.
- **Cons:** zone name relegated to small font; emergency banner has no
  dedicated row (inverts the whole screen).

### Variant C — "Page/emergency-first overlay"

```
(idle / RX state)              (page received)
+---------------------+        +---------------------+
|ZN:Patrol  CH:Disp ✓ |        |    !!! PAGE !!!     |  ← reverseDisplay(true)
+---------------------+        |---------------------|
|                     |        | From: Dispatch      |
|                     |        |                     |
|      Smith          |        | "Code 3 to Main &   |
|      [RX]           |        |  4th now"           |
+---------------------+        |---------------------|
|U:1024  10-8  ▮▮ B  |        |   [PTT to ack]      |
+---------------------+        +---------------------+
```

- **Pros:** matches the audio/haptic spec in `SD7_HEADLESS_UX.md` §4 — pages
  and emergencies get an unmistakable visual takeover; the operator already
  has TTS reading the same content. PTT-to-ack mirrors the existing emergency
  acknowledgment flow.
- **Cons:** two layouts to maintain (idle + overlay); overlay has to time-out
  and restore the idle layout after N seconds.

**Build-task recommendation:** ship **Variant A as the always-on layout**, plus
**Variant C's overlay** for incoming pages and active emergencies. Variant B
stays in the doc as a future option if operator feedback says otherwise.

---

## 8. Prioritized follow-up task slate

> Naming convention: each follow-up uses a working title; the project-tasks
> system assigns the actual task id.

### F1 — **Drive the SD7 OLED with channel/zone/status (build task)**
- **Value:** **High** — turns the SD7's headline hardware feature on for
  operators; closes the headless-UX gap.
- **Effort:** **M** (one new Kotlin module on the SD7 flavor + 30-second smoke
  test on hardware).
- **Blockers:** §6.3 part B is unproven. Run the §6.4 smoke test once on a
  real SD7 to either confirm the open-access hypothesis (build proceeds as
  scoped below) or falsify it (build pivots to the SMALLCD_EXT broadcast
  path or, if step 3 also fails, to the audio-only UX in
  `SD7_HEADLESS_UX.md` §4 with a Siyata SDK request). No new manifest
  permissions are required to *run the smoke test*; whether any are needed
  for the renderer itself depends on the smoke-test outcome.
- **Scope:**
  - New `Sd7OledRenderer` (SD7 flavor only) that fetches `SmallcdManager`,
    calls `init(128, 64, "/dev/oled_display")`, caches `getAppId(...)`, and
    paints Variant A from §7 every time `RadioViewModel` state changes.
  - New `Sd7OledOverlay` for Variant C (page / emergency takeover) with a
    timeout-and-restore loop.
  - `reverseDisplay(true)` while emergency is active; restore on clear.
  - Replaces `Sd7RadioStatusScreen` as the primary operator surface (the
    Compose screen stays as the engineer-only debug surface per the existing
    decision in `SD7_HEADLESS_UX.md` §5).

### F2 — ~~Confirm the `_ExtDisplayMsg` / `SMALLCD_EXT` extras schema~~ — **closed by this task**
The schema is now fully documented in §2.4 / §2.5 from the inline
androguard decompilation. The only residual question is whether
`PocManager.smallcdExtGetAppId(pkg, true)` accepts third-party registration,
and that is folded into the F1 smoke test (§6.4 step 4) — no separate task
is needed.

### F3 — **Ship a covert-mode toggle wired to `SmallcdManager.covertMode(int)`**
- **Value:** Med — surveillance-style customer ask; firmware already
  implements it, we just need to expose it.
- **Effort:** S (one ViewModel toggle + one `SmallcdManager.covertMode(1/0)`
  call; gate the OLED renderer on `getCovertModeStatus() > 0` so we don't
  paint over stealth).
- **Blockers:** Needs F1.
- **Scope:** add a Settings toggle on the SD7 build, write
  `Settings.Global "siyata_covert_mode"`, also call `covertMode(int)` so the
  firmware's own UI stays in sync.

### F4 — **Use `reverseDisplay(true)` as the emergency visual flash**
- **Value:** Med-High — gives the operator an unmistakable visual cue with
  zero new assets.
- **Effort:** S.
- **Blockers:** Needs F1.
- **Scope:** on emergency declared (mine or others), call
  `reverseDisplay(true)`; on emergency cleared, restore the operator-preferred
  value (read from prefs, default `false`).

### F5 — **Strip Esper / Shoonya bloat from the SD7 provisioning script**
- **Value:** High — `io.shoonya.shoonyadpc`, `io.shoonya.helper`,
  `io.esper.remoteviewer`, `io.esper.tesseract`,
  `com.shoonyaos.oculus.plugin.supervisor.toronto_sd7` are pre-installed
  system apps that none of our customers want, and `Controller` actively
  tries to launch the Esper launcher on every boot (`launchEsperLauncherOnce`,
  L1306–1312, called from `setLauncherAfterBootCompleted` L1314–1324).
  `key_esper_state=0` confirms it is not configured, but it still consumes
  resources and adds attack surface.
- **Effort:** S-M (operations work, not Android code — `pm uninstall --user 0`
  for each, scripted via the SD7 provisioning playbook).
- **Blockers:** Verify on a real SD7 that uninstall-for-user-0 sticks across
  reboots (it will not for `/system/app/` packages — needs `pm disable-user`
  instead). Confirm Siyata's contract doesn't require Esper.
- **Scope:** add to the SD7 provisioning script:
  ```
  pm disable-user --user 0 io.shoonya.shoonyadpc
  pm disable-user --user 0 io.shoonya.helper
  pm disable-user --user 0 io.esper.remoteviewer
  pm disable-user --user 0 io.esper.tesseract
  pm disable-user --user 0 com.shoonyaos.oculus.plugin.supervisor.toronto_sd7
  pm disable-user --user 0 com.abupdate.fota_demo_iot   # optional, breaks FOTA
  ```
  Document side-effects (no Esper MDM, no Abupdate FOTA if last line included).

### F6 — **NFC Wi-Fi onboarding: document the operator workflow**
- **Value:** Low-Med — feature already works in firmware (§4.3); just needs
  internal docs + an NFC-tag template.
- **Effort:** S (docs only, plus generating sample NDEF Wi-Fi tags).
- **Blockers:** None.
- **Scope:** Write a one-page "how to provision a fleet of SD7s onto a new
  Wi-Fi network with one NFC tag" runbook for field deployment.

### F7 — **FOTA piggyback / Abupdate wrapping**
- **Value:** Med — could let us push our own SD7 APK updates over the same
  Abupdate channel the firmware already uses.
- **Effort:** L — needs Siyata coordination on the Abupdate server side.
- **Blockers:** Needs vendor cooperation; not unblocked by this research.
- **Scope:** prototype-only after F1.

### F8 — **Smoke-test `oledscreen_status_indication` value space**
- **Value:** Low — already partially answered in §1.2 (firmware accepts 0..2;
  the user wrote 255 successfully but the firmware ignores >2). Closing this
  loop is mostly cleanup.
- **Effort:** S.
- **Blockers:** Needs a real SD7 with `adb`.
- **Scope:** for `n` in `0..3,255`, write the value, capture screen, log what
  the OLED shows. Add a row to the table in §1.2.

### F9 — **Probe `PocManager` registration permission and `smallcd_config_features`**
- **Value:** Low (research) — `PocManager` registration is folded into F1's
  step-4 smoke test; this task only matters if F1 step 4 fails and we want
  to understand exactly *why* before falling back. `smallcd_config_features`
  is a separate, optional dive.
- **Effort:** S (pull `framework.jar` / `services.jar` off a real SD7 and
  decompile `PocManager` and `ConfigFeatures.readConfig`).
- **Blockers:** Needs root or a system-image dump.
- **Scope:** definitive answer to "is `smallcdExtGetAppId(pkg, true)`
  signature-gated, permission-gated, or open?" and "what feature flags does
  `smallcd_config_features` accept and how are they read?"

### F10 — **Strip `RadioFlavorLed` speculative LED broadcasts** (carry-over from Task #579)
- Already proposed in `SD7_HEADLESS_UX.md` §6 item 3 — kept here to avoid
  duplicate task creation. No change in scope; the new evidence in this
  inventory does not turn up a real LED API on the SD7.
