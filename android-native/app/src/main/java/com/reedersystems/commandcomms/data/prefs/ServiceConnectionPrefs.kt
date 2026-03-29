package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences

class ServiceConnectionPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, null)
        set(v) = prefs.edit().putString(KEY_SERVER_URL, v).apply()

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

    var transportMode: String
        get() = prefs.getString(KEY_TRANSPORT_MODE, "custom-radio") ?: "custom-radio"
        set(v) = prefs.edit().putString(KEY_TRANSPORT_MODE, v).apply()

    var relayHost: String?
        get() = prefs.getString(KEY_RELAY_HOST, null)
        set(v) = prefs.edit().putString(KEY_RELAY_HOST, v).apply()

    var relayPort: Int
        get() = prefs.getInt(KEY_RELAY_PORT, 5100)
        set(v) = prefs.edit().putInt(KEY_RELAY_PORT, v).apply()

    var signalingUrl: String?
        get() = prefs.getString(KEY_SIGNALING_URL, null)
        set(v) = prefs.edit().putString(KEY_SIGNALING_URL, v).apply()

    var useTls: Boolean
        get() = prefs.getBoolean(KEY_USE_TLS, false)
        set(v) = prefs.edit().putBoolean(KEY_USE_TLS, v).apply()

    fun isValid(): Boolean =
        serverUrl != null && unitId != null && channelId >= 0 && channelRoomKey != null

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        const val PREFS_NAME = "CommandCommsServicePrefs"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_UNIT_ID = "unit_id"
        private const val KEY_CHANNEL_ID = "channel_id"
        private const val KEY_CHANNEL_ROOM_KEY = "channel_room_key"
        private const val KEY_CHANNEL_NAME = "channel_name"
        private const val KEY_TRANSPORT_MODE = "transport_mode"
        private const val KEY_RELAY_HOST = "relay_host"
        private const val KEY_RELAY_PORT = "relay_port"
        private const val KEY_SIGNALING_URL = "signaling_url"
        private const val KEY_USE_TLS = "use_tls"
    }
}
