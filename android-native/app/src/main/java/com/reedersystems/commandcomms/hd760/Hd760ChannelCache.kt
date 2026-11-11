package com.reedersystems.commandcomms.hd760

import android.content.Context
import com.google.gson.Gson
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.data.model.toZones
import com.reedersystems.commandcomms.data.prefs.RadioTokenStore
import java.security.MessageDigest

/**
 * Metadata only. A saved channel list is never a channel grant and must not
 * authorize PTT, floor control, UDP transmission, or emergency operations.
 *
 * The fingerprint binds the catalog to a specific registered radio, token,
 * assigned unit and server. No radio credential is stored in the catalog.
 */
data class Hd760CatalogScope(
    val radioId: String,
    val assignedUnitId: String,
    val radioToken: String,
    val serverUrl: String
) {
    fun fingerprint(): String? {
        if (radioId.isBlank() || assignedUnitId.isBlank() ||
            radioToken.isBlank() || serverUrl.isBlank()) return null
        val material = listOf(radioId, assignedUnitId, radioToken, serverUrl)
            .joinToString(separator = "") { it.length.toString() + ":" + it }
        return MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }
}

data class Hd760SavedZone(val id: Int?, val name: String)

/** Pure, JVM-testable serialization and validation of the last authorized metadata. */
object Hd760CatalogCodec {
    private const val VERSION = 1
    private const val MAX_CHANNELS = 512
    private val gson = Gson()

    private data class Envelope(
        val version: Int,
        val identity: String,
        val channels: List<Channel>
    )

    fun encode(scope: Hd760CatalogScope, zones: List<Zone>): String? {
        val fingerprint = scope.fingerprint() ?: return null
        val channels = zones.flatMap { it.channels }
        if (!validChannels(channels)) return null
        return gson.toJson(Envelope(VERSION, fingerprint, channels))
    }

    fun decode(scope: Hd760CatalogScope, json: String?): List<Zone>? {
        val fingerprint = scope.fingerprint() ?: return null
        if (json.isNullOrBlank()) return null
        return runCatching {
            val envelope = gson.fromJson(json, Envelope::class.java) ?: return null
            if (envelope.version != VERSION || envelope.identity != fingerprint ||
                !validChannels(envelope.channels)) return null
            envelope.channels.toZones()
        }.getOrNull()
    }

    private fun validChannels(channels: List<Channel>?): Boolean {
        if (channels == null || channels.size > MAX_CHANNELS) return false
        return runCatching {
            channels.all { it.id > 0 && it.name.isNotBlank() && it.roomKey.isNotBlank() } &&
                channels.map { it.id }.distinct().size == channels.size
        }.getOrDefault(false)
    }
}

/**
 * Deliberately separate from ServiceConnectionPrefs: this stores only a
 * read-only display snapshot and selected zone, not an operational route.
 */
class Hd760ChannelCache(context: Context) {
    private val prefs = context.getSharedPreferences("HD760AuthorizedCatalog", Context.MODE_PRIVATE)

    companion object {
        private const val KEY_OWNER = "owner"
        private const val KEY_CATALOG = "catalog"
        private const val KEY_ZONE_ID = "selected_zone_id"
        private const val KEY_ZONE_NAME = "selected_zone_name"

        fun scope(store: RadioTokenStore, baseUrl: String): Hd760CatalogScope? {
            val scope = Hd760CatalogScope(
                store.getRadioId().orEmpty(),
                store.getAssignedUnitId().orEmpty(),
                store.getToken().orEmpty(),
                baseUrl
            )
            return scope.takeIf { it.fingerprint() != null }
        }
    }

    fun restore(scope: Hd760CatalogScope?): List<Zone>? {
        val identity = scope?.fingerprint() ?: run { clear(); return null }
        if (prefs.getString(KEY_OWNER, null) != identity) {
            clear()
            return null
        }
        val zones = Hd760CatalogCodec.decode(scope, prefs.getString(KEY_CATALOG, null))
        if (zones == null) clear()
        return zones
    }

    /** Call only after a successful, authenticated /api/channels response. */
    fun save(scope: Hd760CatalogScope?, zones: List<Zone>): Boolean {
        if (scope == null) return false
        val identity = scope.fingerprint() ?: return false
        val encoded = Hd760CatalogCodec.encode(scope, zones) ?: return false
        val editor = prefs.edit()
        if (prefs.getString(KEY_OWNER, null) != identity) {
            editor.remove(KEY_ZONE_ID).remove(KEY_ZONE_NAME)
        }
        return editor.putString(KEY_OWNER, identity)
            .putString(KEY_CATALOG, encoded).commit()
    }

    fun selectedZone(scope: Hd760CatalogScope?): Hd760SavedZone? {
        val identity = scope?.fingerprint() ?: return null
        if (prefs.getString(KEY_OWNER, null) != identity) return null
        val name = prefs.getString(KEY_ZONE_NAME, null)?.takeIf { it.isNotBlank() }
            ?: return null
        val id = prefs.getInt(KEY_ZONE_ID, -1).takeIf { it >= 0 }
        return Hd760SavedZone(id, name)
    }

    /** Synchronous commit so a power-off cannot lose the last zone selection. */
    fun saveSelectedZone(scope: Hd760CatalogScope?, zone: Zone) {
        val identity = scope?.fingerprint() ?: return
        if (prefs.getString(KEY_OWNER, null) != identity) return
        prefs.edit().putInt(KEY_ZONE_ID, zone.id ?: -1)
            .putString(KEY_ZONE_NAME, zone.name).commit()
    }

    fun clear() {
        prefs.edit().clear().commit()
    }
}
