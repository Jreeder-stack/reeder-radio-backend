package com.reedersystems.commandcomms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.view.KeyEvent;

public class PttBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "CommandComms.PTTReceiver";
    private static final String ACTION_PTT_DOWN = "android.intent.action.PTT.down";
    private static final String ACTION_PTT_UP = "android.intent.action.PTT.up";
    private static final int RETRY_DELAY_MS = 200;
    private static final int MAX_RETRIES = 5;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (action == null) return;

        Log.d(TAG, "Received broadcast: " + action);

        if (ACTION_PTT_DOWN.equals(action)) {
            wakeScreenIfNeeded(context);
            bringActivityToFront(context);
            forwardToPlugin(KeyEvent.ACTION_DOWN);
        } else if (ACTION_PTT_UP.equals(action)) {
            forwardToPlugin(KeyEvent.ACTION_UP);
        }
    }

    private void wakeScreenIfNeeded(Context context) {
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null && !pm.isInteractive()) {
                PowerManager.WakeLock wakeLock = pm.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                    "CommandComms::PTTWake"
                );
                wakeLock.acquire(10 * 1000L);
                Log.d(TAG, "CPU wake lock acquired for PTT broadcast");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to acquire wake lock: " + e.getMessage());
        }
    }

    private void bringActivityToFront(Context context) {
        try {
            Intent activityIntent = new Intent(context, MainActivity.class);
            activityIntent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
            );
            activityIntent.putExtra("ptt_wake", true);
            context.startActivity(activityIntent);
            Log.d(TAG, "MainActivity brought to front");
        } catch (Exception e) {
            Log.e(TAG, "Failed to bring activity to front: " + e.getMessage());
        }
    }

    private void forwardToPlugin(int keyAction) {
        forwardToPluginWithRetry(keyAction, 0);
    }

    private void forwardToPluginWithRetry(int keyAction, int attempt) {
        HardwarePttPlugin plugin = HardwarePttPlugin.getInstance();
        if (plugin != null) {
            KeyEvent event = new KeyEvent(keyAction, 230);
            plugin.handleKeyEvent(event);
            Log.d(TAG, "PTT event forwarded to plugin: " + (keyAction == KeyEvent.ACTION_DOWN ? "DOWN" : "UP"));
        } else if (attempt < MAX_RETRIES) {
            Log.d(TAG, "HardwarePttPlugin not ready, retry " + (attempt + 1) + "/" + MAX_RETRIES);
            new Handler(Looper.getMainLooper()).postDelayed(
                () -> forwardToPluginWithRetry(keyAction, attempt + 1),
                RETRY_DELAY_MS
            );
        } else {
            Log.w(TAG, "HardwarePttPlugin not available after " + MAX_RETRIES + " retries, PTT event dropped");
        }
    }
}
