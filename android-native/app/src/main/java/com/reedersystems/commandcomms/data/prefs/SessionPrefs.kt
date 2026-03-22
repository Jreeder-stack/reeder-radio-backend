package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences

class SessionPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var username: String?
        get() = prefs.getString(KEY_USERNAME, null)
        set(value) = prefs.edit().putString(KEY_USERNAME, value).apply()

    var unitId: String?
        get() = prefs.getString(KEY_UNIT_ID, null)
        set(value) = prefs.edit().putString(KEY_UNIT_ID, value).apply()

    var userRole: String?
        get() = prefs.getString(KEY_ROLE, null)
        set(value) = prefs.edit().putString(KEY_ROLE, value).apply()

    var userId: Int
        get() = prefs.getInt(KEY_USER_ID, -1)
        set(value) = prefs.edit().putInt(KEY_USER_ID, value).apply()

    var micPermissionGranted: Boolean
        get() = prefs.getBoolean(KEY_MIC_GRANTED, false)
        set(value) = prefs.edit().putBoolean(KEY_MIC_GRANTED, value).apply()

    var locationPermissionGranted: Boolean
        get() = prefs.getBoolean(KEY_LOCATION_GRANTED, false)
        set(value) = prefs.edit().putBoolean(KEY_LOCATION_GRANTED, value).apply()

    var notificationPermissionGranted: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATION_GRANTED, false)
        set(value) = prefs.edit().putBoolean(KEY_NOTIFICATION_GRANTED, value).apply()

    var dndPromptShown: Boolean
        get() = prefs.getBoolean(KEY_DND_PROMPT_SHOWN, false)
        set(value) = prefs.edit().putBoolean(KEY_DND_PROMPT_SHOWN, value).apply()

    var lastVersionCode: Long
        get() = prefs.getLong(KEY_LAST_VERSION_CODE, -1L)
        set(value) = prefs.edit().putLong(KEY_LAST_VERSION_CODE, value).apply()

    fun clear() {
        val savedVersion = lastVersionCode
        prefs.edit().clear().apply()
        if (savedVersion != -1L) lastVersionCode = savedVersion
    }

    companion object {
        private const val PREFS_NAME = "commandcomms_session"
        private const val KEY_USERNAME = "username"
        private const val KEY_UNIT_ID = "unit_id"
        private const val KEY_ROLE = "role"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_MIC_GRANTED = "mic_granted"
        private const val KEY_LOCATION_GRANTED = "location_granted"
        private const val KEY_NOTIFICATION_GRANTED = "notification_granted"
        private const val KEY_DND_PROMPT_SHOWN = "dnd_prompt_shown"
        private const val KEY_LAST_VERSION_CODE = "last_version_code"
    }
}
