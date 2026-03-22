package com.reedersystems.commandcomms;

import android.content.Context;
import android.content.SharedPreferences;
import android.view.KeyEvent;

import org.json.JSONObject;

public final class PttKeyMapping {
    public static final int KEYCODE_PTT_PRIMARY = KeyEvent.KEYCODE_F11; // 141
    public static final int KEYCODE_PTT_FALLBACK = 230;
    private static final String PREFS_NAME = "CommandCommsServicePrefs";

    private PttKeyMapping() {}

    public static boolean isPttKey(int keyCode) {
        return keyCode == KEYCODE_PTT_PRIMARY || keyCode == KEYCODE_PTT_FALLBACK;
    }

    public static boolean isPttKey(int keyCode, Context context) {
        if (keyCode == KEYCODE_PTT_PRIMARY || keyCode == KEYCODE_PTT_FALLBACK) {
            return true;
        }

        if (context == null) return false;

        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("app_settings_json", null);
            if (settingsJson == null) return false;

            JSONObject settings = new JSONObject(settingsJson);

            if (keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
                return settings.optBoolean("volumeButtonPtt", false);
            }

            if (keyCode == KeyEvent.KEYCODE_HEADSETHOOK
                || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                || keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) {
                return settings.optBoolean("bluetoothMediaButtonPtt", true);
            }

            int customKeyCode = settings.optInt("pttKeyCode", -1);
            if (customKeyCode > 0 && keyCode == customKeyCode) {
                return true;
            }
        } catch (Exception e) {
            android.util.Log.w("PttKeyMapping", "Failed to read settings for PTT key check: " + e.getMessage());
        }

        return false;
    }
}
