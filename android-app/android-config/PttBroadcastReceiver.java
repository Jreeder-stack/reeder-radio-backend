package com.reedersystems.commandcomms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.util.Log;

public class PttBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "PTT-DIAG";
    private static final String ACTION_PTT_DOWN = "android.intent.action.PTT.down";
    private static final String ACTION_PTT_UP = "android.intent.action.PTT.up";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        boolean isScreenOn = isScreenInteractive(context);
        Log.d(TAG, "PttBroadcastReceiver.onReceive() — action=" + action + " screenOn=" + isScreenOn);

        if (ACTION_PTT_DOWN.equals(action)) {
            Log.d(TAG, "PTT DOWN broadcast received");
            acquireCpuWakeLock(context);
            forwardToService(context, BackgroundAudioService.PTT_ACTION_DOWN);
        } else if (ACTION_PTT_UP.equals(action)) {
            Log.d(TAG, "PTT UP broadcast received");
            forwardToService(context, BackgroundAudioService.PTT_ACTION_UP);
        }
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
