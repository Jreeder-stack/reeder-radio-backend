package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences

class RadioTokenStore(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun saveToken(radioId: String, token: String) {
        prefs.edit()
            .putString(KEY_RADIO_ID, radioId)
            .putString(KEY_TOKEN, token)
            .remove(KEY_ASSIGNED_UNIT_ID)
            .apply()
    }

    fun getToken(): String? = prefs.getString(KEY_TOKEN, null)

    fun getRadioId(): String? = prefs.getString(KEY_RADIO_ID, null)

    fun saveAssignedUnit(unitId: String) {
        prefs.edit().putString(KEY_ASSIGNED_UNIT_ID, unitId).apply()
    }

    fun getAssignedUnitId(): String? = prefs.getString(KEY_ASSIGNED_UNIT_ID, null)

    fun clearAssignedUnit() {
        prefs.edit().remove(KEY_ASSIGNED_UNIT_ID).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "commandcomms_radio_token"
        private const val KEY_RADIO_ID = "radio_id"
        private const val KEY_TOKEN = "token"
        private const val KEY_ASSIGNED_UNIT_ID = "assigned_unit_id"
    }
}
