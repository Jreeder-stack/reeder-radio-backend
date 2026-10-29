package com.reedersystems.commandcomms.hd760

import android.content.Context
import com.reedersystems.commandcomms.data.model.Zone

/** HD760 firmware reports absolute rotary detents as Android keycodes 401..416. */
object Hd760KnobMapping {
    const val SLOT_COUNT = 16
    fun positionForKeyCode(code: Int): Int? = if (code in 401..416) code - 401 else null

    /** Do not wrap an unmapped or stale slot onto an unrelated channel. */
    fun channelIdForSlot(position: Int, channelIds: List<Int>, programmedId: Int?): Int? {
        if (position !in 0 until SLOT_COUNT) return null
        val id = programmedId ?: channelIds.getOrNull(position) ?: return null
        return id.takeIf { it in channelIds }
    }
}

enum class Hd760SideAction(val label: String) {
    NONE("NONE"), SCAN("SCAN"), SCAN_LIST("SCAN LIST"), MENU("MENU")
}

/** HD760-only settings. Each slot stores its zone's actual channel ID, not list order. */
class Hd760Preferences(context: Context) {
    private val prefs = context.getSharedPreferences("HD760Hardware", Context.MODE_PRIVATE)

    fun lastPosition(): Int? =
        prefs.getInt("physical_position", -1).takeIf { it in 0 until Hd760KnobMapping.SLOT_COUNT }

    fun savePosition(position: Int) {
        require(position in 0 until Hd760KnobMapping.SLOT_COUNT)
        prefs.edit().putInt("physical_position", position).apply()
    }

    private fun slotKey(zone: Zone, position: Int) =
        "zone:" + (zone.id?.toString() ?: zone.name) + ":slot:" + position

    /** Capture default ordering once so server-side reordering cannot silently change channels. */
    fun initializeZone(zone: Zone) {
        val editor = prefs.edit()
        for (position in 0 until Hd760KnobMapping.SLOT_COUNT) {
            val key = slotKey(zone, position)
            val channel = zone.channels.getOrNull(position) ?: continue
            if (!prefs.contains(key)) editor.putInt(key, channel.id)
        }
        editor.apply()
    }

    fun channelIdForSlot(zone: Zone, position: Int): Int? {
        if (position !in 0 until Hd760KnobMapping.SLOT_COUNT) return null
        val key = slotKey(zone, position)
        val programmed = if (prefs.contains(key)) prefs.getInt(key, -1) else null
        return Hd760KnobMapping.channelIdForSlot(position, zone.channels.map { it.id }, programmed)
    }

    fun programSlot(zone: Zone, position: Int, channelId: Int?) {
        require(position in 0 until Hd760KnobMapping.SLOT_COUNT)
        require(channelId == null || zone.channels.any { it.id == channelId })
        prefs.edit().putInt(slotKey(zone, position), channelId ?: -1).apply()
    }

    private fun buttonKey(button: Int, longPress: Boolean) =
        "button:" + button + ":" + if (longPress) "long" else "short"

    fun buttonAction(button: Int, longPress: Boolean): Hd760SideAction {
        val default = when {
            button == 1 && !longPress -> Hd760SideAction.SCAN
            button == 1 -> Hd760SideAction.SCAN_LIST
            button == 2 && !longPress -> Hd760SideAction.NONE
            else -> Hd760SideAction.MENU
        }
        val saved = prefs.getString(buttonKey(button, longPress), default.name)
        return Hd760SideAction.values().firstOrNull { it.name == saved } ?: default
    }

    fun cycleButtonAction(button: Int, longPress: Boolean) {
        val actions = Hd760SideAction.values()
        val next = actions[(buttonAction(button, longPress).ordinal + 1) % actions.size]
        prefs.edit().putString(buttonKey(button, longPress), next.name).apply()
    }
}
