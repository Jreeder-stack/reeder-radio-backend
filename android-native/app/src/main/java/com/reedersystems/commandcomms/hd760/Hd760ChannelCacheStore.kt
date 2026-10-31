package com.reedersystems.commandcomms.hd760

import android.content.Context
import com.google.gson.Gson
import com.reedersystems.commandcomms.data.model.Channel

/** Never store the server's radio token or credentials in the channel lineup. */
data class Hd760ChannelSnapshot(
    val formatVersion: Int,
    val radioId: String,
    val unitId: String,
    val channels: List<Channel>
)

/** Pure codec so cache validation and isolation can be tested without Android. */
object Hd760ChannelCacheCodec {
    private val gson = Gson()
    private const val VERSION = 1

    fun encode(radioId: String, unitId: String, channels: List<Channel>): String =
        gson.toJson(Hd760ChannelSnapshot(VERSION, radioId, unitId, channels))

    fun decode(raw: String?, currentRadioId: String?, currentUnitId: String?): List<Channel>? {
        if (raw.isNullOrBlank() || currentRadioId.isNullOrBlank() ||
            currentUnitId.isNullOrBlank()) return null
        return runCatching {
            val snapshot = gson.fromJson(raw, Hd760ChannelSnapshot::class.java)
                ?: return null
            if (snapshot.formatVersion != VERSION ||
                snapshot.radioId != currentRadioId ||
                snapshot.unitId != currentUnitId) return null
            val channels = snapshot.channels
            if (channels.size > 256 || channels.any {
                    it.id <= 0 || it.name.isBlank() ||
                        it.roomKey.isBlank() || it.roomKey.length > 240 ||
                        it.name.length > 100
                } || channels.map { it.id }.toSet().size != channels.size ||
                channels.map { it.roomKey }.toSet().size != channels.size
            ) return null
            channels
        }.getOrNull()
    }
}

/** One durable lineup per physical HD760, scoped to the last verified unit. */
class Hd760ChannelCacheStore(context: Context) {
    private val prefs = context.getSharedPreferences("hd760_channel_lineup", Context.MODE_PRIVATE)

    fun load(radioId: String?, unitId: String?): List<Channel>? =
        Hd760ChannelCacheCodec.decode(prefs.getString("lineup", null), radioId, unitId)

    /** Called only after a successful server-authenticated 200 channel response. */
    fun save(radioId: String, unitId: String, channels: List<Channel>): Boolean {
        val json = Hd760ChannelCacheCodec.encode(radioId, unitId, channels)
        if (Hd760ChannelCacheCodec.decode(json, radioId, unitId) == null) return false
        return prefs.edit().putString("lineup", json).commit()
    }

    fun clear(): Boolean = prefs.edit().clear().commit()
}
