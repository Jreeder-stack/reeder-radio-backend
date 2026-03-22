package com.reedersystems.commandcomms;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "PTT-DIAG";
    private static final String PREFS_NAME = "CommandCommsServicePrefs";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        Log.d(TAG, "BootReceiver.onReceive() — action=" + action);

        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {

            boolean startOnBoot = true;
            try {
                SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String settingsJson = prefs.getString("app_settings_json", null);
                if (settingsJson != null) {
                    JSONObject settings = new JSONObject(settingsJson);
                    startOnBoot = settings.optBoolean("startOnBoot", true);
                }
            } catch (Exception e) {
                Log.e(TAG, "BootReceiver — Failed to read startOnBoot preference: " + e.getMessage());
            }

            if (!startOnBoot) {
                Log.d(TAG, "BootReceiver — startOnBoot is disabled, skipping service launch");
                return;
            }

            Log.d(TAG, "BootReceiver — Device booted, starting BackgroundAudioService");
            try {
                Intent serviceIntent = new Intent(context, BackgroundAudioService.class);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent);
                } else {
                    context.startService(serviceIntent);
                }
                Log.d(TAG, "BootReceiver — BackgroundAudioService start intent sent");
            } catch (Exception e) {
                Log.e(TAG, "BootReceiver — Failed to start service on boot: " + e.getMessage());
            }
        }
    }
}
