package com.reedersystems.commandcomms.hd760

import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.data.repository.HttpException
import java.io.IOException

data class Hd760ChannelLocation(val zoneIndex: Int, val channelIndex: Int)

/**
 * Channel catalog recovery is separate from the background radio/PTT transport.
 * Retrying is appropriate for network/server faults, never denied credentials
 * or malformed catalog responses. Only restore a saved service channel when
 * it is still present in the fresh authorized channel list for the same unit.
 */
object Hd760ChannelRecovery {
    fun shouldRetry(error: Throwable): Boolean = when (error) {
        is IOException -> true
        is HttpException ->
            error.code == 408 || error.code == 429 || error.code in 500..599
        else -> false
    }

    fun delayAfterFailureMs(failedAttempts: Int): Long = when {
        failedAttempts <= 1 -> 2_000L
        failedAttempts == 2 -> 5_000L
        failedAttempts == 3 -> 10_000L
        failedAttempts == 4 -> 20_000L
        else -> 30_000L
    }

    fun findSavedChannel(
        zones: List<Zone>,
        currentUnitId: String,
        savedUnitId: String?,
        savedChannelId: Int,
        savedRoomKey: String?
    ): Hd760ChannelLocation? {
        if (currentUnitId.isBlank() || savedUnitId != currentUnitId ||
            savedChannelId < 0 || savedRoomKey.isNullOrBlank()
        ) return null

        zones.forEachIndexed { zoneIndex, zone ->
            zone.channels.forEachIndexed { channelIndex, channel ->
                if (channel.id == savedChannelId && channel.roomKey == savedRoomKey) {
                    return Hd760ChannelLocation(zoneIndex, channelIndex)
                }
            }
        }
        return null
    }
}
