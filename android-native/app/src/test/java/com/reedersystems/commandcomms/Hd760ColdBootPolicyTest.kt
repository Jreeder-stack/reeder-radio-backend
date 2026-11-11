package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.hd760.Hd760CatalogCodec
import com.reedersystems.commandcomms.hd760.Hd760CatalogScope
import com.reedersystems.commandcomms.hd760.Hd760SavedZone
import com.reedersystems.commandcomms.hd760.Hd760StartupPolicy
import com.reedersystems.commandcomms.hd760.Hd760StartupStage
import org.junit.Assert.*
import org.junit.Test

class Hd760ColdBootPolicyTest {
    private val own = Hd760CatalogScope("radio-17", "unit-a", "token-a", "https://radio.test")
    private val channels = listOf(
        Zone(2, "OPS", listOf(Channel(101, "OPS 1", "OPS", 2, "ops__1"))),
        Zone(9, "TAC", listOf(
            Channel(201, "TAC 1", "TAC", 9, "tac__1"),
            Channel(202, "TAC 2", "TAC", 9, "tac__2")
        ))
    )

    @Test fun savesAndRestoresCatalogWithoutService() {
        val encoded = Hd760CatalogCodec.encode(own, channels)
        assertNotNull(encoded)
        assertEquals(channels, Hd760CatalogCodec.decode(own, encoded))
        assertNull(Hd760CatalogCodec.decode(own, null))
        assertNull(Hd760CatalogCodec.decode(own, "corrupt"))
    }

    @Test fun cacheCannotCrossRadioUnitTokenOrServerIdentity() {
        val encoded = Hd760CatalogCodec.encode(own, channels)
        assertNull(Hd760CatalogCodec.decode(own.copy(radioId = "radio-18"), encoded))
        assertNull(Hd760CatalogCodec.decode(own.copy(assignedUnitId = "unit-b"), encoded))
        assertNull(Hd760CatalogCodec.decode(own.copy(radioToken = "rotated"), encoded))
        assertNull(Hd760CatalogCodec.decode(own.copy(serverUrl = "https://different.test"), encoded))
        assertNull(Hd760CatalogCodec.encode(own.copy(radioToken = ""), channels))
        assertNull(Hd760CatalogCodec.decode(own.copy(assignedUnitId = ""), encoded))
    }

    @Test fun authoritativeEmptyCatalogReplacesPreviousChannels() {
        val encoded = Hd760CatalogCodec.encode(own, emptyList())
        assertEquals(emptyList<Zone>(), Hd760CatalogCodec.decode(own, encoded))
    }

    @Test fun corruptOrUnauthorizedChannelMetadataDoesNotRestore() {
        assertNull(Hd760CatalogCodec.encode(own, listOf(
            Zone(1, "INVALID", listOf(Channel(1, "", "INVALID", 1, "bad")))
        )))
        val encoded = Hd760CatalogCodec.encode(own, channels)!!
        assertNull(Hd760CatalogCodec.decode(own, encoded.replace("ops__1", "")))
    }

    @Test fun selectedZoneSurvivesReorderingAndChannelKnobUsesThatZone() {
        val swapped = channels.reversed()
        val selection = Hd760StartupPolicy.restoreSelection(
            swapped, Hd760SavedZone(9, "TAC"), 1
        ) { zone, pos -> zone.channels.getOrNull(pos)?.id }
        assertEquals(0, selection.zoneIndex)
        assertEquals(1, selection.channelIndex)
        assertFalse(selection.emptySlot)
        assertEquals("TAC 2", swapped[selection.zoneIndex].channels[selection.channelIndex].name)
    }

    @Test fun removedZoneFallsBackToFirstAuthorizedAndMissingSlotCannotWrap() {
        assertEquals(0, Hd760StartupPolicy.zoneIndex(channels, Hd760SavedZone(999, "TAC")))
        val selection = Hd760StartupPolicy.restoreSelection(
            channels, Hd760SavedZone(2, "OPS"), 15
        ) { zone, pos -> zone.channels.getOrNull(pos)?.id }
        assertTrue(selection.emptySlot)
        assertEquals(0, selection.channelIndex)
    }

    @Test fun legacyZoneWithoutIdRestoresByName() {
        assertEquals(1, Hd760StartupPolicy.zoneIndex(channels, Hd760SavedZone(null, "TAC")))
    }

    @Test fun serviceStateNotCatalogNamesControlsReadyStatus() {
        assertEquals(Hd760StartupStage.STARTING_RADIO,
            Hd760StartupPolicy.stage(true, false, false, null, null))
        assertEquals(Hd760StartupStage.WAITING_FOR_SERVICE,
            Hd760StartupPolicy.stage(false, false, true, "ops__1", "ops__1"))
        assertEquals(Hd760StartupStage.WAITING_FOR_SERVICE,
            Hd760StartupPolicy.stage(false, true, false, "ops__1", "ops__1"))
        assertEquals(Hd760StartupStage.WAITING_FOR_SERVICE,
            Hd760StartupPolicy.stage(false, true, true, "ops__1", "other__channel"))
        assertEquals(Hd760StartupStage.WAITING_FOR_SERVICE,
            Hd760StartupPolicy.stage(false, true, true, null, null))
        assertEquals(Hd760StartupStage.READY,
            Hd760StartupPolicy.stage(false, true, true, "ops__1", "ops__1"))
    }
}
