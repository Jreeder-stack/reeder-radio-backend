package com.reedersystems.commandcomms;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * PttAccessibilityService — preferred primary background key capture path for Inrico T320.
 *
 * Receives hardware key events system-wide via FLAG_REQUEST_FILTER_KEY_EVENTS, including
 * when the app is backgrounded and when the screen is off.
 *
 * Communication with BackgroundAudioService is Intent-based (lifecycle-safe).
 * No direct in-memory service instance access.
 *
 * Confirmed device key observations (do not re-diagnose):
 *   PTT       = KEY_F11 at Linux layer → Android KEYCODE_F11 = 141 (also handles 230 as fallback)
 *   Side btn1 = KEY_F1  at Linux layer → Android KEYCODE_F1  = 131
 *   Side btn2 = KEY_SELECT at Linux layer → actual Android keycode verified by log on device;
 *               KEYCODE_BUTTON_SELECT (109) and KEYCODE_DPAD_CENTER (23) are fallbacks.
 */
public class PttAccessibilityService extends AccessibilityService {

    private static final String DIAG_TAG = "PTT-DIAG";
    private static final String TAG = "PttAccessibility";

    // Confirmed Linux-to-Android mappings
    private static final int KEYCODE_SIDE1        = KeyEvent.KEYCODE_F1;            // 131
    private static final int KEYCODE_SIDE2_A      = KeyEvent.KEYCODE_BUTTON_SELECT; // 109 — verify on device
    private static final int KEYCODE_SIDE2_B      = KeyEvent.KEYCODE_DPAD_CENTER;   // 23  — fallback
    private static final int KEYCODE_EMERGENCY    = 233;
    private static final int KEYCODE_TV_TELETEXT  = 349;

    // Per-button held-state — process only first DOWN (released→pressed) and first UP (pressed→released)
    private volatile boolean pttHeld       = false;
    private volatile boolean side1Held     = false;
    private volatile boolean side2Held     = false;
    private volatile boolean emergencyHeld = false;

    // Last captured event for diagnostics
    private volatile int    lastCode      = -1;
    private volatile String lastAction    = "none";
    private volatile long   lastTimestamp = 0;

    private static volatile PttAccessibilityService instance = null;

    public static PttAccessibilityService getInstance() {
        return instance;
    }

    public static boolean isRunning() {
        return instance != null;
    }

    // --- Diagnostic state getters ---

    public int    getLastCode()      { return lastCode; }
    public String getLastAction()    { return lastAction; }
    public long   getLastTimestamp() { return lastTimestamp; }
    public boolean isPttHeld()       { return pttHeld; }

    // -----------------------------------------------------------------------

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;

        AccessibilityServiceInfo info = getServiceInfo();
        if (info == null) info = new AccessibilityServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS;
        info.eventTypes = AccessibilityEvent.TYPES_ALL_MASK;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        setServiceInfo(info);

        Log.d(DIAG_TAG, "[AccessibilitySvc] onServiceConnected — key filtering active");
    }

    @Override
    public void onDestroy() {
        instance = null;
        Log.d(DIAG_TAG, "[AccessibilitySvc] onDestroy — service stopped");
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Not used for key handling — key events come through onKeyEvent()
    }

    @Override
    public void onInterrupt() {
        Log.d(DIAG_TAG, "[AccessibilitySvc] onInterrupt");
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        int    keyCode     = event.getKeyCode();
        int    action      = event.getAction();
        int    repeatCount = event.getRepeatCount();
        long   eventTime   = event.getEventTime();
        String actionStr   = (action == KeyEvent.ACTION_DOWN) ? "DOWN" : "UP";

        // Log every received key unconditionally for field verification
        Log.d(DIAG_TAG, "[AccessibilitySvc] KEY_RECV keyCode=" + keyCode
                + " action=" + actionStr
                + " repeat=" + repeatCount
                + " time=" + eventTime
                + " pttHeld=" + pttHeld
                + " s1Held=" + side1Held
                + " s2Held=" + side2Held);

        // Update diagnostic state
        lastCode      = keyCode;
        lastAction    = actionStr;
        lastTimestamp = eventTime;

        if (PttKeyMapping.isPttKey(keyCode, this)) {
            Log.d(DIAG_TAG, "[AccessibilitySvc] PTT matched keyCode=" + keyCode
                    + " (primary=" + PttKeyMapping.KEYCODE_PTT_PRIMARY
                    + ", fallback=" + PttKeyMapping.KEYCODE_PTT_FALLBACK + ")");
            return handlePtt(keyCode, action, repeatCount);
        }

        // Black side button — KEYCODE_F1 (131)
        if (keyCode == KEYCODE_SIDE1) {
            return handleSide1(action, repeatCount);
        }

        // Orange side button — KEYCODE_BUTTON_SELECT (109) or KEYCODE_DPAD_CENTER (23)
        // Log the actual keycode so the field test can confirm the correct mapping.
        if (keyCode == KEYCODE_SIDE2_A || keyCode == KEYCODE_SIDE2_B) {
            Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE2 observed keyCode=" + keyCode
                    + " (SELECT=109, DPAD_CENTER=23) — using as side button 2");
            return handleSide2(action, repeatCount);
        }

        // Emergency button — KEYCODE 233 or KEYCODE_TV_TELETEXT (349 / scanCode 353)
        if (keyCode == KEYCODE_EMERGENCY || keyCode == KEYCODE_TV_TELETEXT) {
            Log.d(DIAG_TAG, "[AccessibilitySvc] EMERGENCY key observed keyCode=" + keyCode);
            return handleEmergency(keyCode, action, repeatCount);
        }

        // Unhandled — pass through
        return false;
    }

    // --- PTT press/release state machine ---

    private boolean handlePtt(int keyCode, int action, int repeatCount) {
        if (action == KeyEvent.ACTION_DOWN) {
            if (repeatCount > 0) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] PTT DOWN keyCode=" + keyCode + " repeat=" + repeatCount + " — ignored (held)");
                return true; // consume but do not retrigger
            }
            if (pttHeld) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] PTT DOWN keyCode=" + keyCode + " — already held, duplicate suppressed");
                return true;
            }
            pttHeld = true;
            Log.d(DIAG_TAG, "[AccessibilitySvc] PTT DOWN keyCode=" + keyCode + " — first press, forwarding to service");
            acquireCpuWakeLock();
            wakeScreenAndLaunchActivity();
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_PTT_DOWN, "AccessibilitySvc");
            return true;

        } else if (action == KeyEvent.ACTION_UP) {
            if (!pttHeld) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] PTT UP keyCode=" + keyCode + " — not held, duplicate suppressed");
                return true;
            }
            pttHeld = false;
            Log.d(DIAG_TAG, "[AccessibilitySvc] PTT UP keyCode=" + keyCode + " — forwarding to service");
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_PTT_UP, "AccessibilitySvc");
            return true;
        }

        return true;
    }

    // --- Side button 1 (black, KEY_F1) ---

    private boolean handleSide1(int action, int repeatCount) {
        if (action == KeyEvent.ACTION_DOWN) {
            if (repeatCount > 0 || side1Held) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE1 DOWN suppressed repeat=" + repeatCount + " held=" + side1Held);
                return true;
            }
            side1Held = true;
            Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE1 DOWN — forwarding");
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_SIDE1_DOWN, "AccessibilitySvc");
            return true;

        } else if (action == KeyEvent.ACTION_UP) {
            if (!side1Held) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE1 UP suppressed — not held");
                return true;
            }
            side1Held = false;
            Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE1 UP — forwarding");
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_SIDE1_UP, "AccessibilitySvc");
            return true;
        }

        return true;
    }

    // --- Side button 2 (orange, KEY_SELECT) ---

    private boolean handleSide2(int action, int repeatCount) {
        if (action == KeyEvent.ACTION_DOWN) {
            if (repeatCount > 0 || side2Held) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE2 DOWN suppressed repeat=" + repeatCount + " held=" + side2Held);
                return true;
            }
            side2Held = true;
            Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE2 DOWN — forwarding");
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_SIDE2_DOWN, "AccessibilitySvc");
            return true;

        } else if (action == KeyEvent.ACTION_UP) {
            if (!side2Held) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE2 UP suppressed — not held");
                return true;
            }
            side2Held = false;
            Log.d(DIAG_TAG, "[AccessibilitySvc] SIDE2 UP — forwarding");
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_SIDE2_UP, "AccessibilitySvc");
            return true;
        }

        return true;
    }

    // --- Emergency button (KEYCODE 233, KEYCODE_TV_TELETEXT 349) ---

    private boolean handleEmergency(int keyCode, int action, int repeatCount) {
        if (action == KeyEvent.ACTION_DOWN) {
            if (repeatCount > 0 || emergencyHeld) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] EMERGENCY DOWN suppressed repeat=" + repeatCount + " held=" + emergencyHeld);
                return true;
            }
            emergencyHeld = true;
            Log.d(DIAG_TAG, "[AccessibilitySvc] EMERGENCY DOWN keyCode=" + keyCode + " — forwarding");
            acquireCpuWakeLock();
            wakeScreenAndLaunchActivity();
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_EMERGENCY_DOWN, "AccessibilitySvc");
            return true;

        } else if (action == KeyEvent.ACTION_UP) {
            if (!emergencyHeld) {
                Log.d(DIAG_TAG, "[AccessibilitySvc] EMERGENCY UP suppressed — not held");
                return true;
            }
            emergencyHeld = false;
            Log.d(DIAG_TAG, "[AccessibilitySvc] EMERGENCY UP keyCode=" + keyCode + " — forwarding");
            sendButtonIntent(BackgroundAudioService.ACTION_BTN_EMERGENCY_UP, "AccessibilitySvc");
            return true;
        }

        return true;
    }

    // --- Intent-based (lifecycle-safe) service communication ---

    private void sendButtonIntent(String action, String source) {
        try {
            Intent intent = new Intent(this, BackgroundAudioService.class);
            intent.setAction(action);
            intent.putExtra(BackgroundAudioService.EXTRA_EVENT_SOURCE, source);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
            Log.d(DIAG_TAG, "[AccessibilitySvc] Intent sent: action=" + action + " source=" + source);
        } catch (Exception e) {
            Log.e(DIAG_TAG, "[AccessibilitySvc] Failed to send intent: " + e.getMessage());
        }
    }

    private void acquireCpuWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "CommandComms::AccessibilityPTT");
                wl.acquire(10_000L);
                Log.d(DIAG_TAG, "[AccessibilitySvc] CPU wake lock acquired");
            }
        } catch (Exception e) {
            Log.w(DIAG_TAG, "[AccessibilitySvc] Wake lock failed: " + e.getMessage());
        }
    }

    private void wakeScreenAndLaunchActivity() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) {
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock screenWl = pm.newWakeLock(
                    PowerManager.FULL_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                    "CommandComms::AccessibilityScreenWake"
                );
                screenWl.acquire(10_000L);
                Log.d(DIAG_TAG, "[AccessibilitySvc] screen wake lock acquired");
            }
        } catch (Exception e) {
            Log.w(DIAG_TAG, "[AccessibilitySvc] screen wake failed: " + e.getMessage());
        }

        try {
            Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launchIntent != null) {
                launchIntent.setAction("com.reedersystems.commandcomms.PTT_WAKE");
                launchIntent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                );
                startActivity(launchIntent);
                Log.d(DIAG_TAG, "[AccessibilitySvc] MainActivity launched for PTT_WAKE");
            }
        } catch (Exception e) {
            Log.w(DIAG_TAG, "[AccessibilitySvc] activity launch on PTT wake failed: " + e.getMessage());
        }
    }
}
