package com.reedersystems.commandcomms.data.prefs

import android.content.Context

class PttKeyPrefs(context: Context) {
    private val prefs = context.getSharedPreferences("ptt_key_prefs", Context.MODE_PRIVATE)

    var customKeyCode: Int
        get() = prefs.getInt("custom_ptt_key", -1)
        set(value) = prefs.edit().putInt("custom_ptt_key", value).apply()

    var volumeButtonPttEnabled: Boolean
        get() = prefs.getBoolean("volume_button_ptt", false)
        set(value) = prefs.edit().putBoolean("volume_button_ptt", value).apply()

    var customKeyLabel: String
        get() = prefs.getString("custom_ptt_key_label", "") ?: ""
        set(value) = prefs.edit().putString("custom_ptt_key_label", value).apply()
}
