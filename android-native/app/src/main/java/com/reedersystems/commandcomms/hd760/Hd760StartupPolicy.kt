package com.reedersystems.commandcomms.hd760

import com.reedersystems.commandcomms.data.model.Zone

/** Presentation only. Never grants network or radio transmitting authority. */
enum class Hd760StartupStage { STARTING_RADIO, WAITING_FOR_SERVICE, READY }

data class Hd760ZoneAndSlot(
    val zoneIndex: Int,
    val channelIndex: Int,
    val emptySlot: Boolean
)

object Hd760StartupPolicy {
    fun stage(
        loadingCatalog: Boolean,
        freshCatalog: Boolean,
        signalingAuthenticated: Boolean,
        selectedRoomKey: String?,
        confirmedJoinedRoomKey: String?
    ): Hd760StartupStage = when {
        loadingCatalog -> Hd760StartupStage.STARTING_RADIO
        !freshCatalog || !signalingAuthenticated || selectedRoomKey.isNullOrBlank() ||
            confirmedJoinedRoomKey != selectedRoomKey -> Hd760StartupStage.WAITING_FOR_SERVICE
        else -> Hd760StartupStage.READY
    }

    /**
     * Restore by stable zone ID, never by the previous list index. For old
     * zones without an ID, use the zone name. An ID that was removed does not
     * automatically select another zone with the same name.
     */
    fun zoneIndex(zones: List<Zone>, savedZone: Hd760SavedZone?): Int {
        if (zones.isEmpty()) return 0
        val index = when {
            savedZone?.id != null -> zones.indexOfFirst { it.id == savedZone.id }
            savedZone?.name != null -> zones.indexOfFirst { it.name == savedZone.name }
            else -> -1
        }
        return if (index >= 0) index else 0
    }

    fun restoreSelection(
        zones: List<Zone>,
        savedZone: Hd760SavedZone?,
        physicalPosition: Int?,
        channelIdForSlot: (Zone, Int) -> Int?
    ): Hd760ZoneAndSlot {
        val zoneIndex = zoneIndex(zones, savedZone)
        val zone = zones.getOrNull(zoneIndex)
            ?: return Hd760ZoneAndSlot(zoneIndex, 0, true)
        if (physicalPosition == null) {
            return Hd760ZoneAndSlot(zoneIndex, 0, zone.channels.isEmpty())
        }
        val savedId = channelIdForSlot(zone, physicalPosition)
        val channelIndex = zone.channels.indexOfFirst { it.id == savedId }
        return Hd760ZoneAndSlot(
            zoneIndex = zoneIndex,
            channelIndex = if (channelIndex >= 0) channelIndex else 0,
            emptySlot = channelIndex < 0
        )
    }
}
