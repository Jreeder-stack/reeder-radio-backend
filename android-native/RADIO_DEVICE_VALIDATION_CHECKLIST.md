# Native Android/Radio Validation Plan (Post Browser Transport Verification)

Status date: 2026-03-28

## 1) Freeze browser audio implementation
- Browser transport/audio is **frozen** for now.
- Scope constraint: no redesign, no refactor, no new browser-audio work unless a blocker appears that directly prevents native/radio validation.

## 2) Next concrete native/radio test sequence
Run this in order on two real devices (A and B) on the same channel:

1. **Preflight / app state**
   - Install latest APK on both devices.
   - Confirm microphone permission granted.
   - Confirm battery optimization exemption granted.
   - Confirm app can run foreground service (persistent notification visible).
2. **Login/session**
   - Login on A and B with distinct unit IDs.
   - Verify signaling transitions to authenticated.
3. **Channel join**
   - On each device, select same zone/channel.
   - Verify channel join occurs and channel switch does leave old/join new.
4. **Receive audio (RX)**
   - Press/hold PTT on A and speak; B must hear continuous audio.
   - Release A; B audio stops within expected tail.
5. **Transmit audio (TX)**
   - Press/hold PTT on B and speak; A must hear continuous audio.
   - Release B; A audio stops and floor releases.
6. **No self-monitor playback**
   - While A is transmitting, A must not hear own voice loopback in speaker/earpiece.
7. **Floor grant/deny + tones**
   - Idle channel: first PTT gets floor grant and TX starts.
   - Busy channel: second device pressing PTT while first transmits gets floor denied.
   - Verify talk-permit tone on attempt and deny/busy tone on deny.
8. **Screen-on behavior**
   - With screen on and app foreground: hardware PTT down/up works repeatedly.
9. **Screen-off behavior**
   - Turn screen off on A.
   - Press/release hardware PTT; TX/RX path still works and service remains responsive.
10. **Background behavior**
    - Put app in background (home screen), keep device unlocked.
    - Confirm hardware PTT still controls TX and RX continues.

## 3) Strict pass/fail checklist for radio device

### Login/session
- [ ] PASS if `AUTHENTICATED` reached within 5s after login on each device.
- [ ] FAIL if stuck in `CONNECTING`/`DISCONNECTED`, or reconnect loops.

### Channel join
- [ ] PASS if selecting channel causes join and channel switch leaves old / joins new.
- [ ] FAIL if no channel events or stale channel remains active.

### Receive audio
- [ ] PASS if remote speech is intelligible, no major gaps/stutter over 30s RX.
- [ ] FAIL if silence, severe clipping, robotic artifacts, or >2s dropouts.

### Transmit audio
- [ ] PASS if local mic audio reaches remote device within 500ms floor-grant path.
- [ ] FAIL if TX never starts, delayed >1s repeatedly, or early cutout.

### No self-monitor playback
- [ ] PASS if transmitting unit never hears own voice return path.
- [ ] FAIL if any self-audio loopback is audible during TX.

### Floor grant/deny
- [ ] PASS if first requester gets grant; concurrent second requester gets deny while channel busy.
- [ ] FAIL if double-grant, no deny, or stale busy state after release.

### Talk permit / deny tone
- [ ] PASS if talk-permit tone plays on TX attempt and busy/deny tone plays on floor deny.
- [ ] FAIL if tones missing, wrong order, or repeated unintentionally.

### Screen-on behavior
- [ ] PASS if PTT down/up works for 20 consecutive presses with screen on.
- [ ] FAIL on missed transitions or stuck TX.

### Screen-off behavior
- [ ] PASS if PTT works with screen off (CPU wake bridge + service handles actions).
- [ ] FAIL if presses are dropped or TX cannot start while screen off.

### Background behavior
- [ ] PASS if PTT+RX work while app backgrounded for 10 minutes.
- [ ] FAIL if service dies, RX halts, or key events stop routing.

## 4) Exact files most likely to fail on native/radio path

1. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/BackgroundAudioService.kt`
   - Highest complexity path for floor request lifecycle, signaling sync, TX state transitions, and wake-lock/service lifetime behavior.
2. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/radio/UdpAudioTransport.kt`
   - Raw UDP framing/receive path; potential packet framing, DNS/relay resolution, and receive-loop edge failures.
3. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/radio/RadioAudioEngine.kt`
   - TX/RX engine, AudioRecord lifecycle, capture loop stability, and playback concurrency under real hardware constraints.
4. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/radio/FloorControlManager.kt`
   - Floor arbitration state machine (granted/denied/release/cancel race handling).
5. `android-native/app/src/main/java/com/reedersystems/commandcomms/audio/PttHardwareReceiver.kt`
   - Hardware broadcast mapping + wake-lock bridge for screen-off/background key reliability.
6. `android-native/app/src/main/java/com/reedersystems/commandcomms/signaling/SignalingClient.kt`
   - Session auth and event mapping; any event mismatch here breaks floor or channel behavior.

## 5) Highest-risk remaining blocker for real device operation
**Highest risk:** potential **self-monitor / self-audio loopback** and TX/RX race conditions around floor grant, because receive audio is always accepted in UDP RX path and the native pipeline has no explicit per-packet self-unit suppression in transport/playback.

If relay/server echoes sender audio under certain conditions, current native client may play local TX audio back to the transmitting device.

## 6) Out-of-scope for this step
- No browser audio redesign.
- No browser transport changes unless a blocker is proven that directly blocks native/radio validation.
