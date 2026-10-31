package com.reedersystems.commandcomms

import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.hd760.Hd760ChannelCacheCodec
import org.junit.Assert.*
import org.junit.Test

class Hd760ChannelCacheCodecTest {
    private val channels = listOf(
        Channel(17, "DISPATCH", "INDIANA", 1, "INDIANA__DISPATCH"),
        Channel(23, "TAC1", "INDIANA", 1, "INDIANA__TAC1"),
        Channel(31, "OPS1", "STATEWIDE", 2, "STATEWIDE__OPS1")
    )

    @Test fun offlineLineupRoundTripsWithoutNetworkAndKeepsOrder() {
        val raw = Hd760ChannelCacheCodec.encode("000042", "INDIANA-1", channels)
        assertEquals(channels, Hd760ChannelCacheCodec.decode(raw, "000042", "INDIANA-1"))
        assertFalse(raw.contains("radio_token"))
    }

    @Test fun cannotOpenAnotherRadioOrUnitSnapshot() {
        val raw = Hd760ChannelCacheCodec.encode("000042", "INDIANA-1", channels)
        assertNull(Hd760ChannelCacheCodec.decode(raw, "000043", "INDIANA-1"))
        assertNull(Hd760ChannelCacheCodec.decode(raw, "000042", "INDIANA-2"))
        assertNull(Hd760ChannelCacheCodec.decode(raw, "", "INDIANA-1"))
        assertNull(Hd760ChannelCacheCodec.decode(raw, "000042", null))
    }

    @Test fun emptyAuthorizedLineupIsValidAndMustNotRestoreOldChannels() {
        val empty = Hd760ChannelCacheCodec.encode("000042", "INDIANA-1", emptyList())
        assertEquals(emptyList<Channel>(), Hd760ChannelCacheCodec.decode(
            empty, "000042", "INDIANA-1"))
    }

    @Test fun invalidAndStaleCacheCannotBecomeProgrammedChannels() {
        assertNull(Hd760ChannelCacheCodec.decode("{invalid", "000042", "INDIANA-1"))
        val oldVersion = Hd760ChannelCacheCodec.encode("000042", "INDIANA-1", channels)
            .replace("\"formatVersion\":1", "\"formatVersion\":2")
        assertNull(Hd760ChannelCacheCodec.decode(oldVersion, "000042", "INDIANA-1"))
        val duplicates = Hd760ChannelCacheCodec.encode(
            "000042", "INDIANA-1", channels + channels[0])
        assertNull(Hd760ChannelCacheCodec.decode(duplicates, "000042", "INDIANA-1"))
    }
}
