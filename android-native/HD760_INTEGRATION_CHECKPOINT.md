# Anysecu HD760 radio integration checkpoint (2026-10-28)

## On-device evidence
- Android 7.1.2, API 25; diagnostic APK installed and launched.
- PTT DOWN: `com.zello.ptt.down`, UP: `com.zello.ptt.up`.
- BOTH broadcasts delivered while `com.loudtalks` force-stopped and
  `pidof com.loudtalks` returned empty. The broadcast *namespace*
  does not imply a runtime dependency on Zello.
- `zxx_state=0` on DOWN and UP: discriminate using intent action, not extra.
- Rotary: Android key 402 / scan 602 and key 401 / scan 601.
  Direction (clockwise vs counterclockwise) needs confirmation on radio.
- Side function keys: 265 / scan 763, 266 / scan 764.
  Which one is SOS/scan is unverified; neither is mapped to emergency.
- Front DPAD 19-22, Enter 66, Back 4.
- `getevent` produced no PTT raw input on event0/event2; firmware
  broadcast is observed and sufficient for initial app PTT wiring.

## Implementation
- Standalone flavor `hd760` with application ID
  `com.reedersystems.commandcomms` (existing Google Services client), minSdk/targetSdk 25.
- Shared authenticated radio registration, floor-control, Opus, UDP,
  signaling, and background audio retained.
- Flavor-specific manifest registers confirmed OEM PTT broadcasts,
  receiver routes them only on HD760.
- Rotary 401/402 routed via existing channel ViewModel actions.
- Compact non-touch radio display; shared screen for registration.
- Android 7.1 notification and lock-screen compatibility guards.
- No OEM PTT service or Zello dependency added.
- Verified T320 and SD7 mappings preserved.
- Stock apps `com.loudtalks` and candidate Real-PTT `com.corget`
  are *not* automatically uninstalled; do reversible device testing
  first, confirm `com.corget`'s identity and restore APKs if needed.

## Before operational deployment
1. GitHub build must pass.
2. Install APK with ADB, register radio, assign a test unit.
3. Verify keypad navigation through registration (non-touch screen).
4. PTT three presses with Zello stopped/disabled; TX and RX both ways
   to a separate Command Communications unit.
5. Screen-off and background 10-minute testing; no stuck TX,
   no double floor grant, no loopback, no unexpected app restarts.
6. Check knob direction, speaker/microphone routing, and volume.
7. Confirm which factory apps can be disabled/removed without losing
   hardware signals or provisioning.
8. Do not claim completion before these physical tests pass.
