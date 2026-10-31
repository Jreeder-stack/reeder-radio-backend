package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.data.repository.HttpException
import com.reedersystems.commandcomms.hd760.Hd760ChannelLocation
import com.reedersystems.commandcomms.hd760.Hd760ChannelRecovery
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import org.junit.Assert.*
import org.junit.Test

class Hd760ChannelRecoveryTest {
    @Test fun networkAndTemporaryServerFailuresRetry() {
        assertTrue(Hd760ChannelRecovery.shouldRetry(UnknownHostException("DNS failure")))
        assertTrue(Hd760ChannelRecovery.shouldRetry(SocketTimeoutException("timeout")))
        for (status in listOf(408, 429, 500, 502, 503, 504)) {
            assertTrue(Hd760ChannelRecovery.shouldRetry(HttpException(status, "HTTP $status")))
        }
    }

    @Test fun authorizationAndInvalidCatalogErrorsDoNotRetry() {
        for (status in listOf(400, 401, 403, 404, 422)) {
            assertFalse(Hd760ChannelRecovery.shouldRetry(HttpException(status, "HTTP $status")))
        }
        assertFalse(Hd760ChannelRecovery.shouldRetry(IllegalStateException("No channels field")))
    }

    @Test fun retryIntervalsBackOffAndRemainCapped() {
        assertEquals(2_000L, Hd760ChannelRecovery.delayAfterFailureMs(1))
        assertEquals(5_000L, Hd760ChannelRecovery.delayAfterFailureMs(2))
        assertEquals(10_000L, Hd760ChannelRecovery.delayAfterFailureMs(3))
        assertEquals(20_000L, Hd760ChannelRecovery.delayAfterFailureMs(4))
        assertEquals(30_000L, Hd760ChannelRecovery.delayAfterFailureMs(5))
        assertEquals(30_000L, Hd760ChannelRecovery.delayAfterFailureMs(500))
    }

    private val zones = listOf(
        Zone(1, "OPS", listOf(
            Channel(8, "OPS1", "OPS", 1, "OPS__OPS1"),
            Channel(9, "OPS2", "OPS", 1, "OPS__OPS2")
        )),
        Zone(2, "TAC", listOf(
            Channel(9, "TAC1", "TAC", 2, "TAC__TAC1")
        ))
    )

    @Test fun restoresSavedChannelAndNeverDefaultsToFirstZone() {
        assertEquals(
            Hd760ChannelLocation(1, 0),
            Hd760ChannelRecovery.findSavedChannel(
                zones, "INDIANA-1", "INDIANA-1", 9, "TAC__TAC1")
        )
    }

    @Test fun rejectsSavedChannelFromOtherUnitAndUnmatchedRoomKeys() {
        assertNull(Hd760ChannelRecovery.findSavedChannel(
            zones, "INDIANA-1", "OTHER-1", 9, "TAC__TAC1"))
        assertNull(Hd760ChannelRecovery.findSavedChannel(
            zones, "INDIANA-1", "INDIANA-1", 9, "OLD__STOLEN"))
        assertNull(Hd760ChannelRecovery.findSavedChannel(
            zones, "INDIANA-1", "INDIANA-1", -1, "TAC__TAC1"))
        assertNull(Hd760ChannelRecovery.findSavedChannel(
            zones, "", "", 9, "TAC__TAC1"))
    }
}
