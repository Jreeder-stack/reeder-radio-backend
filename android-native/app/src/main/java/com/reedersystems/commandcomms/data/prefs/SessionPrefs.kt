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

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "commandcomms_session"
        private const val KEY_USERNAME = "username"
        private const val KEY_UNIT_ID = "unit_id"
        private const val KEY_ROLE = "role"
        private const val KEY_USER_ID = "user_id"
    }
}
