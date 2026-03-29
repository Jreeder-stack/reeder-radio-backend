# STEP 8 — Real T320 Device Validation Report (2026-03-29)

## 1. BUILD RESULT
- **FAIL (environment/precondition blocker):** `./gradlew assembleDebug` failed immediately because `org.gradle.wrapper.GradleWrapperMain` is missing.
- The repository intentionally excludes `gradle-wrapper.jar` (documented in `android-native/gradle/wrapper/README.md`), so a real Android build environment with Android Studio or a locally provisioned Gradle wrapper is required before APK generation/install can proceed.

## 2. DEVICE TEST RESULTS (PASS/FAIL per test)
> No real T320 hardware is connected in this execution environment, and APK build is blocked prior to install. Therefore all hardware/runtime tests are currently **BLOCKED / NOT EXECUTED**.

### PHASE A — Build/install validation
1. Build native Android app in real environment: **FAIL (blocked at missing Gradle wrapper JAR)**
2. Install latest APK on T320 A/B: **NOT EXECUTED (no APK produced here)**
3. Launch + permission prompts: **NOT EXECUTED**
4. Login on both devices: **NOT EXECUTED**

### PHASE B — Connectivity validation
1. Signaling connects: **NOT EXECUTED**
2. Auth succeeds: **NOT EXECUTED**
3. Channel fetch/join succeeds: **NOT EXECUTED**
4. Subscriber registration succeeds: **NOT EXECUTED**
5. Lifecycle log order correct: **NOT EXECUTED**

### PHASE C — Core radio validation
1. A TX -> B RX (start/stop): **NOT EXECUTED**
2. B TX -> A RX (start/stop): **NOT EXECUTED**
3. No self-monitor playback: **NOT EXECUTED**
4. Floor grant/deny behavior: **NOT EXECUTED**
5. Talk-permit / deny tones: **NOT EXECUTED**

### PHASE D — T320 behavior validation
1. Screen on (20 PTT presses): **NOT EXECUTED**
2. Screen off PTT: **NOT EXECUTED**
3. Background operation (PTT + RX): **NOT EXECUTED**
4. Long idle (10 min) then TX/RX: **NOT EXECUTED**

## 3. FIRST EXACT FAILURE POINT (if any)
1. **First failing step:** Phase A.1 (build)
2. **Exact command:** `cd android-native && ./gradlew assembleDebug`
3. **Exact failure:** `Could not find or load main class org.gradle.wrapper.GradleWrapperMain`
4. **Location/context:** Android build bootstrap at Gradle wrapper startup (`android-native/gradlew` expects `android-native/gradle/wrapper/gradle-wrapper.jar`, which is intentionally absent per wrapper README).
5. **Smallest required fix:** Provision wrapper JAR via Android Studio sync or run `gradle wrapper --gradle-version 8.6` in a proper Android environment, then rerun build and device validation.

## 4. FILES MODIFIED IN THIS STEP (if any)
- `android-native/STEP8_T320_DEVICE_VALIDATION_REPORT.md` (this report only)

## 5. LOG EVIDENCE SUMMARY
- Required runtime/device logs (`CHANNEL_JOINED`, `SUBSCRIBER_REGISTERED`, `PTT_REQUEST_SENT`, `PTT_GRANTED`, `PTT_DENIED`, `PTT_RELEASE_SENT`, `OPUS_TX_INIT`, `OPUS_TX_FRAME_ENCODED`, `OPUS_TX_FRAME_SENT`, `OPUS_RX_FRAME_RECEIVED`, `OPUS_RX_FRAME_DECODED`, `OPUS_RX_PLAYBACK_STARTED`, `SELF_AUDIO_SUPPRESSED`) are **NOT AVAILABLE** in this run because the APK was not built/installed and no T320 device session was executed here.

## 6. REMAINING KNOWN RISKS
1. Build pipeline cannot produce APK in current environment until Gradle wrapper bootstrap is restored.
2. Real-device regressions (PTT floor arbitration, Opus TX/RX continuity, background/screen-off behavior) remain unvalidated until on-hardware test execution.
3. Required production log proof points remain uncollected pending successful real-device run.

## 7. CONFIRMATION HARDWARE KEY MAPPING WAS UNTOUCHED
- **Confirmed:** No hardware key mapping, button routing, PTT mapping, emergency key mapping, or key code handling code was modified.

## 8. CONFIRMATION PERMISSION PROMPTS WERE UNTOUCHED
- **Confirmed:** No permission prompt/startup permission flow code was modified.
