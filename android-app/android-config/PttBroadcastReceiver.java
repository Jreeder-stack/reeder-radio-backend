package com.reedersystems.commandcomms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

public class PttBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "PTT-DIAG";
    private static final String PREFS_NAME = "CommandCommsPttConfig";
    private static final String PREF_PTT_DOWN_ACTIONS = "ptt_down_actions";
    private static final String PREF_PTT_UP_ACTIONS = "ptt_up_actions";
    private static final String PREF_DIAG_LOG_UNMATCHED = "ptt_diag_log_unmatched";

    // Build-time defaults (can be overridden at runtime via SharedPreferences).
    private static final boolean DEFAULT_DIAG_LOG_UNMATCHED = true;
    private static final Set<String> DEFAULT_DOWN_ACTIONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "android.intent.action.PTT.down",
        "android.intent.action.PTT_DOWN",
        "com.inrico.ptt.down",
        "com.inrico.intent.action.PTT_DOWN"
    )));
    private static final Set<String> DEFAULT_UP_ACTIONS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "android.intent.action.PTT.up",
        "android.intent.action.PTT_UP",
        "com.inrico.ptt.up",
        "com.inrico.intent.action.PTT_UP"
    )));

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;

        String action = intent.getAction();
        if (action == null) return;

        Set<String> allowedDownActions = getConfiguredActionSet(context, PREF_PTT_DOWN_ACTIONS, DEFAULT_DOWN_ACTIONS);
        Set<String> allowedUpActions = getConfiguredActionSet(context, PREF_PTT_UP_ACTIONS, DEFAULT_UP_ACTIONS);
        boolean diagLogUnmatched = getDiagLogUnmatched(context);

        boolean isScreenOn = isScreenInteractive(context);
        boolean serviceRunning = BackgroundAudioService.isRunning;
        BackgroundAudioService svcInstance = BackgroundAudioService.getInstance();
        LiveKitPlugin lk = LiveKitPlugin.getInstance();
        String extrasSummary = summarizeExtras(intent.getExtras());

        Log.d(TAG, "========== PTT BROADCAST RECEIVED ==========");
        Log.d(TAG, "PttBroadcastReceiver.onReceive() — action=" + action
            + " screenOn=" + isScreenOn
            + " extras=" + extrasSummary);
        Log.d(TAG, "PttBroadcastReceiver STATE: serviceRunning=" + serviceRunning
            + " svcInstance=" + (svcInstance != null ? "YES" : "NULL")
            + " livekit=" + (lk != null && lk.isRoomConnected() ? "CONNECTED" : "DISCONNECTED")
            + " lkChannel=" + (lk != null ? lk.getActiveChannel() : "null"));
        Log.d(TAG, "PTT action allowlist: down=" + allowedDownActions + " up=" + allowedUpActions
            + " diagLogUnmatched=" + diagLogUnmatched);

        if (allowedDownActions.contains(action)) {
            Log.d(TAG, "PTT ROUTE: broadcast action matched DOWN allowlist -> BackgroundAudioService.handlePttDown()");
            Log.d(TAG, "PTT DOWN broadcast — acquiring wake lock and forwarding to service");
            acquireCpuWakeLock(context);
            if (!isScreenOn) {
                wakeScreenAndLaunchActivity(context);
            }
            forwardToService(context, BackgroundAudioService.PTT_ACTION_DOWN);
        } else if (allowedUpActions.contains(action)) {
            Log.d(TAG, "PTT ROUTE: broadcast action matched UP allowlist -> BackgroundAudioService.handlePttUp()");
            Log.d(TAG, "PTT UP broadcast — forwarding to service");
            forwardToService(context, BackgroundAudioService.PTT_ACTION_UP);
        } else if (diagLogUnmatched) {
            Log.d(TAG, "PTT ROUTE: broadcast action UNMATCHED (ignored by receiver allowlist)");
            Log.d(TAG, "[DIAG-ONLY] Unmatched PTT broadcast action observed: action=" + action
                + " extras=" + extrasSummary);
        }
    }

    private Set<String> getConfiguredActionSet(Context context, String prefKey, Set<String> defaults) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String configured = prefs.getString(prefKey, null);
        if (configured == null || configured.trim().isEmpty()) {
            return defaults;
        }

        Set<String> parsed = new HashSet<>();
        String[] values = configured.split(",");
        for (String value : values) {
            String action = value.trim();
            if (!action.isEmpty()) {
                parsed.add(action);
            }
        }

        return parsed.isEmpty() ? defaults : parsed;
    }

    private boolean getDiagLogUnmatched(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean(PREF_DIAG_LOG_UNMATCHED, DEFAULT_DIAG_LOG_UNMATCHED);
    }

    private String summarizeExtras(Bundle extras) {
        if (extras == null || extras.isEmpty()) {
            return "{}";
        }

        StringBuilder sb = new StringBuilder("{");
        for (String key : extras.keySet()) {
            Object value = extras.get(key);
            sb.append(key).append("=").append(String.valueOf(value)).append(", ");
        }
        if (sb.length() > 1) {
            sb.setLength(sb.length() - 2);
        }
        sb.append("}");
        return sb.toString();
    }

    private void forwardToService(Context context, String pttAction) {
        BackgroundAudioService serviceInstance = BackgroundAudioService.getInstance();

        if (serviceInstance != null) {
            Log.d(TAG, "Service instance AVAILABLE — calling handle directly, action=" + pttAction);
            if (BackgroundAudioService.PTT_ACTION_DOWN.equals(pttAction)) {
                serviceInstance.handlePttDown();
            } else {
                serviceInstance.handlePttUp();
            }
            Log.d(TAG, "Direct service call completed for action=" + pttAction);
        } else {
            Log.d(TAG, "Service instance NULL — cold-starting service with intent extra, action=" + pttAction);
            Intent serviceIntent = new Intent(context, BackgroundAudioService.class);
            serviceIntent.putExtra(BackgroundAudioService.EXTRA_PTT_ACTION, pttAction);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent);
                } else {
                    context.startService(serviceIntent);
                }
                Log.d(TAG, "Service cold-start intent sent with action=" + pttAction);
            } catch (Exception e) {
                Log.e(TAG, "Failed to cold-start service: " + e.getMessage());
            }
        }
    }

    private void wakeScreenAndLaunchActivity(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) {
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock screenWl = pm.newWakeLock(
                    PowerManager.FULL_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP
                    | PowerManager.ON_AFTER_RELEASE,
                    "CommandComms::PTTScreenWake"
                );
                screenWl.acquire(10 * 1000L);
                Log.d(TAG, "PTT-DIAG: screen wake lock acquired (FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP)");
            }
        } catch (Exception e) {
            Log.e(TAG, "PTT-DIAG: failed to acquire screen wake lock: " + e.getMessage());
        }

        try {
            Intent launchIntent = context.getPackageManager()
                .getLaunchIntentForPackage(context.getPackageName());
            if (launchIntent != null) {
                launchIntent.setAction("com.reedersystems.commandcomms.PTT_WAKE");
                launchIntent.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                );
                context.startActivity(launchIntent);
                Log.d(TAG, "PTT-DIAG: MainActivity launched for PTT_WAKE");
            }
        } catch (Exception e) {
            Log.e(TAG, "PTT-DIAG: failed to launch MainActivity on PTT wake: " + e.getMessage());
        }
    }

    private void acquireCpuWakeLock(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "CommandComms::PTTWake"
                );
                wakeLock.acquire(10 * 1000L);
                Log.d(TAG, "CPU wake lock acquired for PTT broadcast");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire wake lock: " + e.getMessage());
        }
    }

    private boolean isScreenInteractive(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isInteractive();
        } catch (Exception e) {
            return false;
        }
    }
}
