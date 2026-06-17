# Siyata SD7 — Headless UX Strategy & OLED SDK Research

**Status:** Research / decision (Task #579). No production code is changed
by this task; this document is the source of truth for the follow-up
implementation tasks listed at the bottom.

---

> **2026-05-13 correction (Task #586):** the §3.3 conclusion below — *"SDK is
> vendor-only, ask Siyata"* — is **wrong**. On-device introspection found that
> `android.app.SmallcdManager` is a public Android system service registered
> as `smallcd` and exposing a complete OLED drawing API
> (`init`/`getAppId`/`drawText`/`drawBitmap`/`fillRect`/`refresh`/`reverseDisplay`/
> `covertMode`/...). The SD7 OLED **is** writable from a third-party app; no
> NDA SDK is needed. The audio/haptic/TTS UX spec in §4 of this doc remains
> valid as the cue layer, but it is no longer the *only* operator surface.
> Calling `Sd7RadioStatusScreen` "functionally invisible" (§1, end of) is
> also outdated — the new build task will replace it with an OLED renderer
> as the primary operator surface, with the Compose screen retained as the
> engineer-only debug surface (§5 decision still stands for the Compose
> screen). See the full inventory, API contract, recommended OLED layout,
> and follow-up task slate in
> [`SD7_FIRMWARE_INVENTORY.md`](./SD7_FIRMWARE_INVENTORY.md).

---

## 1. Hardware reality check

The SD7 has **no Android-controlled main display**. The 0.97" 128×64
monochrome OLED strip on top of the device is **not a regular Android
surface** — it is owned and painted exclusively by a system-privileged
firmware app shipped on the device:

```
package: com.br.smallcd     (logged tag: "smallcd", "#3_smallcd",
                             "_MainScreen", "_AdjustMainVolume",
                             "_SettingMenu", "RotaryKnobEventReceiver",
                             "PowerManagerScreenStatusReceiver",
                             "TimeUpdateReceiver", "VolumeChangedReceiver",
                             "Controller")
```

`com.br` is the OEM hint (Belfone — Siyata partner ODM). On every key
event, screen on/off, volume change, time tick, and rotary turn the
**smallcd** app rebuilds the OLED contents (`_MainScreen:update -
sepetorIndex=2`). There is no observed evidence of a public API,
broadcast, ContentProvider, or AIDL service that lets a third-party app
push pixels or text strings to the OLED. The only system surface
related to the OLED that crosses the public boundary is a single
`Settings.Global` flag the firmware reads:

```
content://settings/global/oledscreen_status_indication
```

…which appears to be a numeric enum used by `smallcd` to choose which
of its built-in canned status views to show. We have not (yet) sniffed
the value space; it can be probed with `adb shell settings get global
oledscreen_status_indication` on a real device. Even in the
best case it would let us pick from `smallcd`'s pre-baked indications,
not paint our own text.

### Where this leaves the existing Compose UI

`Sd7RadioStatusScreen` (Task #573) renders into the **regular Android
framebuffer**. On the SD7 the regular framebuffer is the device's
internal display panel that the firmware keeps hidden behind `smallcd`'s
OLED process — i.e. **the operator never sees it**. It paints fine in
the emulator and in `adb shell screencap`, which is why it survived
review, but on real hardware it is functionally invisible.

It is therefore wrong to treat `Sd7RadioStatusScreen` as the SD7's
primary user surface. See §5 for the decision.

---

## 2. SD7 surface inventory (confirmed by on-device logcat capture)

All entries are **from real SD7 logcat** in `attached_assets/Pasted-*.txt`.
Anything marked _speculative_ has no on-device evidence yet and
should be treated as "needs vendor confirmation" rather than "supported".

### 2.1 Hardware buttons → broadcasts (already wired)

| Button | Keycode | Broadcasts emitted by firmware (PhoneWindowManager) |
| ------ | ------- | --------------------------------------------------- |
| Knob rotate left  | F4 (134) | `com.kodiak.intent.action.ACTION_BUTTON_PREVIOUS`, `com.airbus.pmr.action.GROUP_SELECT_PREVIOUS`, `android.intent.action.CHANNEL.prev`, `com.siyata.intent.action.ROTARY_KNOB` (system-ui only) |
| Knob rotate right | F5 (135) | `com.kodiak.intent.action.ACTION_BUTTON_NEXT`, `com.airbus.pmr.action.GROUP_SELECT_NEXT`, `android.intent.action.CHANNEL.next`, `com.siyata.intent.action.ROTARY_KNOB` |
| Knob press        | F8       | (no broadcast; key-event only — currently aliased to `KeyAction.DpadCenter`) |
| Top side short    | (Vol Up keycode) | (system volume up) |
| Top side long ~600 ms | (Vol Up long) | (handled in `MainActivity` — scan toggle) |
| Bottom side short | (Vol Down keycode) | (system volume down) |
| Bottom side long  | (Vol Down long) | (handled in `MainActivity` — scan-list toggle) |
| PTT (side big)    | — | `com.airbus.pmr.action.PTT_START` / `_STOP`, `com.kodiak.intent.action.PTT_BUTTON` |
| SOS (top)         | F11 (141) | `android.intent.action.SOS_BUTTON`, `android.intent.action.SOS.down`/`.up`, `com.kodiak.intent.action.KEYCODE_SOS` |

Conclusion: every operator action we care about is reachable from the
Android app today. The dead path is *output*.

### 2.2 Output surfaces

| Surface | What it is | Available to our app? | Notes |
| ------- | ---------- | --------------------- | ----- |
| **OLED status strip (128×64 mono)** | Painted exclusively by `com.br.smallcd`. No public write API was visible in any logcat. | **No** (read-only via `oledscreen_status_indication` enum at best) | The Compose UI we render is **never seen**. Owning vendor is Siyata/Belfone — see §3 for the SDK ask. |
| **Internal display panel** | Physical panel exists; held by `smallcd`. | No (would race smallcd) | Even SYSTEM_ALERT_WINDOW overlays can't beat a system-privileged foreground app. |
| **Backlight (`LightsService setLight #0`)** | OLED backlight only. Driven by firmware on screen-on/off. Not addressable to indicate radio state. | No | Observed values: `#ff000000` (off), `#ff666666` (on). |
| **Status / TX-RX LED** | **No evidence of a separate user-driveable LED** in any captured logcat. The wide-net `com.siyata.sd7.LED` / `com.siyata.intent.action.LED` / `com.siyata.led.set` broadcasts in the current `RadioFlavorLed` are **speculative** and not corroborated by any system_server line. | _Speculative_ — needs Siyata SDK to confirm | If a hardware LED exists at all (typical of rugged PTT bricks) it is most likely driven via a vendor sysprop or a HIDL service we have not seen. |
| **Speaker / audio cues** | Standard Android audio path. | **Yes** — fully supported | This is our most reliable feedback channel. App can play short PCM/WAV cues through `BackgroundAudioService`'s existing audio engine. |
| **Vibrator** | Standard `Vibrator` service. Already used by firmware (`onReceive: mVibrator = android.os.SystemVibrator@…`). | **Yes** — fully supported | Cheap, unambiguous, works in pocket. |
| **TTS** | Standard `TextToSpeech` engine (Google or vendor). | **Yes** — fully supported | Useful for status readback ("Channel: Dispatch", "Status: en route"). |
| **Notification LED** (legacy) | API removed in Android 11+; no NotificationChannel-LED on this build. | No | Can ignore. |

### 2.3 What this means in practice

For a headless SD7 the **only surfaces we actually own** are:

- **Audio** (tones, beeps, TTS readback)
- **Vibrator** (haptic confirms)

Everything else (OLED, backlight, possible status LED) is owned by
firmware and either invisible to us or speculative pending an SDK from
Siyata.

---

## 3. OLED SDK hunt — outcome

### 3.1 In-device search

Searched in the captured logcats for any process or broadcast that
suggests a public OLED-write surface:

- No `com.siyata.oled.*`, `com.br.smallcd.WRITE_*`, or
  `com.siyata.intent.action.OLED_*` broadcast was ever observed.
- `com.br.smallcd` exposes no `<receiver android:exported="true">` we can
  see from logs. Its only inbound traffic is system events
  (`SCREEN_ON`/`OFF`, `USER_PRESENT`, `TIME_TICK`, `VOLUME_CHANGED`)
  and its own internal `RotaryKnobEventReceiver`.
- No `com.siyata.*` package other than `com.siyata.intent.action.ROTARY_KNOB`
  (a system-ui internal action) appears in any captured logcat.
- The only OLED-adjacent public knob is `Settings.Global` key
  `oledscreen_status_indication` — a single integer the firmware reads
  to decide which of its **canned** status pages to draw. It cannot
  carry our channel/zone strings.

### 3.2 External search

Public web sources for "Siyata SD7 SDK", "SD7 OLED display API",
"Siyata MCPTT SDK", and "Belfone SD7 SDK" turn up:

- Marketing / spec sheets only.
- The Siyata MCPTT app and Kodiak/Tassta third-party PTT integrations,
  which use the standard PTT/SOS/Knob broadcasts above (already wired
  into our `PttHardwareReceiver`).
- **No public OLED write SDK or sample code.**

### 3.3 Decision: ~~SDK is vendor-only~~ — **CORRECTED 2026-05-13: no SDK is needed**

> The original conclusion below — that we need an NDA SDK from Siyata — was
> wrong. See the top-of-file correction and
> [`SD7_FIRMWARE_INVENTORY.md`](./SD7_FIRMWARE_INVENTORY.md) for the full
> mapping of `android.app.SmallcdManager`. In short: the firmware exposes a
> public framework system service named `smallcd` that any app can fetch via
> `context.getSystemService("smallcd")` and use to drive the OLED with
> `init/getAppId/drawText/drawBitmap/fillRect/refresh`. The Siyata-ticket
> action item is therefore **withdrawn**; the OLED writer build task is
> tracked as F1 in `SD7_FIRMWARE_INVENTORY.md` §8 instead. The status-LED
> question (§2.2 of this doc) is still open and is now the only outstanding
> Siyata ask — kept as F-LED in the inventory's slate.

~~We do not have an OLED SDK. The only way to get one is to obtain it
directly from Siyata (or Belfone, the ODM) under NDA.~~

~~**Action item (not part of this code task — operations work):**~~

~~- Open a partner-portal ticket with Siyata at <https://www.siyatamobile.com/contact-us/>~~
  ~~and the SD7 product page. Reference the device model (SD7), our~~
  ~~application ID (`com.reedersystems.commandcomms.sd7`), and ask~~
  ~~specifically for:~~
  ~~1. The SD7 OLED writing API (any of: vendor JAR/AAR, AIDL service,~~
     ~~ContentProvider, broadcast intent).~~
  ~~2. The status LED API (if a user-driveable LED exists at all).~~
  ~~3. The expected value space of `Settings.Global.oledscreen_status_indication`.~~
~~- Track the ticket number in this file under §6 once filed.~~

~~**Proof-of-OLED test:** intentionally **not** built in this task because
without an SDK there is nothing to prove; the only test we could write
right now ("does Compose paint to OLED?") has already been answered
*no* by the smallcd ownership in logcat. A proof-of-OLED test app
will land as the first follow-up *after* Siyata returns an SDK.~~

---

## 4. Headless UX spec (audio + vibrate only)

This is the spec we will implement now, before any SDK arrives. It
relies only on surfaces we definitively own. Each row maps a user
action to the feedback the operator should receive on the SD7.

| User action | Audio cue | Haptic | TTS readback (optional, off by default) | Notes |
| ----------- | --------- | ------ | --------------------------------------- | ----- |
| PTT down, floor granted | Existing talk-permit beep | Single 30 ms buzz | — | Reuse current talk-permit clip; no new asset. |
| PTT down, floor denied / channel busy | Short "bonk" (descending two-tone, ~200 ms) | Double 50 ms buzz | — | New WAV asset. |
| PTT up | Soft tail-tone (200 Hz blip ~80 ms) | — | — | Confirms TX actually stopped. |
| Channel knob rotate (channel changed) | Short "tick" (~40 ms click) | Single 20 ms buzz | "Channel: <name>" | TTS gated by user pref (default OFF — operator preference). |
| Knob press (cycle status) | Single confirm beep | Single 30 ms buzz | "Status: <new status>" | TTS gated; status is invisible without it. |
| Top-side long-press → scan toggle | Two ascending beeps if scan ON, two descending if scan OFF | Single 30 ms buzz | "Scan on" / "Scan off" | TTS recommended for this — invisible state otherwise. |
| Bottom-side long-press → scan-list toggle for current channel | Single high beep if added, single low beep if removed | Single 30 ms buzz | "<channel> added to scan" / "<channel> removed from scan" | TTS recommended; otherwise impossible to know what happened. |
| Incoming RX start (someone keys up) | None (audio itself is the cue) | — | — | Audio relay output already plays — no extra cue. |
| Incoming page (FCM `page` event) | Existing page tone | Long 800 ms buzz | TTS reads page sender + message | Page is the highest-priority audible event after emergency. |
| Emergency declared (mine) | Existing emergency tone | Continuous 1.5 s buzz | "Emergency active" | TTS unconditional for safety. |
| Emergency on channel (other unit) | Existing emergency tone | Single 500 ms buzz | "Emergency from <unit>" | TTS unconditional. |
| Boot / radio assigned | Single ascending three-tone | — | "Radio <unit> ready" | TTS gated. |
| Sign-out / unassigned | Single descending three-tone | — | "Radio signed out" | TTS gated. |
| Network loss / link down | Repeating low double-beep every 30 s while down | — | "Connection lost" once when first detected | TTS gated. |

**TTS toggle:** add a per-device pref `sd7_tts_readback_enabled` (default
**ON**, can be turned off by the operator from the T320-side app while
provisioning). The exception rows above (`scan toggle`, `scan-list
toggle`, both emergency rows) ignore the toggle because the state is
otherwise unrecoverable.

**Volume routing:** all audio cues should go through the same
`AudioManager.STREAM_VOICE_CALL` stream the audio relay already uses, so
a single physical volume setting controls everything.

**No-conflict rule:** never play a cue while floor-controlled TX audio
is open (would feed back through the mic). Cues triggered during TX are
queued and emitted after `tx:stop`.

---

## 5. Decision: keep `Sd7RadioStatusScreen`?

**Decision: keep it but flag it as a hidden debug / emulator-only
surface.** It is the only screen rendered when an SD7 build is run on
non-SD7 hardware (engineer's emulator, an Android tablet during
development, etc.) and provides operational context for QA when
debugging the SD7 build with `adb shell screencap` even though end users
never see it on real SD7 hardware.

Rationale for not deleting:

- It compiles cleanly, ships zero risk to the production T320 build
  (flavor-isolated under `src/sd7/`), and has no hot path on real
  hardware (no operator looks at it).
- Removing it would force `RadioFlavorScreen.kt` to render a blank
  surface, which makes engineer-side debugging strictly harder.
- The visual cost on real SD7 is exactly zero: smallcd hides it.

Rationale for not promoting it:

- It is invisible to operators on real SD7 hardware (smallcd owns the
  display).
- All real SD7 operator feedback must come from §4 (audio/haptic/TTS)
  until an OLED SDK arrives from Siyata.

**Action in this task:** add a brief decision note to `replit.md`
(below) and a one-line header comment to `Sd7RadioStatusScreen.kt`
clarifying it is an engineer-only surface. No structural change.

---

## 6. Follow-up tasks (to be created as project tasks)

The implementation work fanned out from this research is small and
independent. Each item is a separate scoped follow-up task, **not**
part of this research task:

1. **SD7 audio-cue engine (no OLED required)** — implement the
   audio/haptic feedback table in §4 (talk-permit, denied bonk,
   tail-tone, channel-tick, status-cycle confirm, scan toggle, scan-list
   toggle, page tone, emergency tones, link-loss heartbeat, boot tones).
   Wire from `RadioViewModel` events; no transport changes.
2. **SD7 TTS readback** — gated `TextToSpeech` engine for channel name,
   status, scan state, page contents, emergency, boot/sign-out. Per-row
   gating from §4. New per-device pref `sd7_tts_readback_enabled`
   default ON, with the unconditional rows from §4 ignoring it.
3. **Remove speculative `RadioFlavorLed` LED broadcasts** — the wide-net
   `com.siyata.sd7.LED` / `com.siyata.intent.action.LED` /
   `com.siyata.led.set` broadcasts in `src/sd7/.../RadioFlavorLed.kt`
   were never observed in any logcat capture. Either replace with a
   no-op (keeping the interface so transport code compiles) or, if a
   real LED API arrives from Siyata, replace the body with the real
   write. Until then, the broadcasts are noise.
4. **Probe `oledscreen_status_indication`** — small QA chore: enumerate
   the integer values the firmware accepts and what each one shows on
   the OLED, by writing values 0…N with `adb shell settings put global
   oledscreen_status_indication <n>`. Document findings here. If any
   value usefully maps to one of our radio states (e.g. "TX active"),
   wire it into `RadioFlavorLed.kt` as the OLED-side counterpart of the
   audio cue.
5. **Vendor-engagement task (operations, not code)** — file the Siyata
   ticket described in §3.3 and track the response. Once Siyata
   returns an SDK, reopen this document and add §7 with the SDK
   integration plan and a concrete proof-of-OLED test.

---

## 7. Open questions / future work

- Awaiting Siyata's reply on a public OLED write API.
- Awaiting Siyata's reply on whether SD7 has a separately-driveable
  status LED at all.
- Once on a real SD7 with `adb`, run `pm list packages | grep -iE
  'siyata|belfone|smallcd|kodiak|airbus'` and `dumpsys package
  com.br.smallcd` to confirm there is no exported receiver we missed.
