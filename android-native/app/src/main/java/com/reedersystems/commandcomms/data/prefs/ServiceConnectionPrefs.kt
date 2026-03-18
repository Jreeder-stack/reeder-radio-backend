package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences

class ServiceConnectionPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, null)
        set(v) = prefs.edit().putString(KEY_SERVER_URL, v).apply()

    var livekitUrl: String?
        get() = prefs.getString(KEY_LIVEKIT_URL, null)
        set(v) = prefs.edit().putString(KEY_LIVEKIT_URL, v).apply()

    var unitId: String?
        get() = prefs.getString(KEY_UNIT_ID, null)
        set(v) = prefs.edit().putString(KEY_UNIT_ID, v).apply()

    var channelId: Int
        get() = prefs.getInt(KEY_CHANNEL_ID, -1)
        set(v) = prefs.edit().putInt(KEY_CHANNEL_ID, v).apply()

    var channelRoomKey: String?
        get() = prefs.getString(KEY_CHANNEL_ROOM_KEY, null)
        set(v) = prefs.edit().putString(KEY_CHANNEL_ROOM_KEY, v).apply()

    var channelName: String?
        get() = prefs.getString(KEY_CHANNEL_NAME, null)
        set(v) = prefs.edit().putString(KEY_CHANNEL_NAME, v).apply()

    fun isValid(): Boolean =
        serverUrl != null && unitId != null && channelId >= 0 && channelRoomKey != null

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        const val PREFS_NAME = "CommandCommsServicePrefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_LIVEKIT_URL = "livekit_url"
        private const val KEY_UNIT_ID = "unit_id"
        private const val KEY_CHANNEL_ID = "channel_id"
        private const val KEY_CHANNEL_ROOM_KEY = "channel_room_key"
        private const val KEY_CHANNEL_NAME = "channel_name"
    }
}
