package com.reedersystems.commandcomms.hd760

/** Accepted UDP audio packet identity for HD760 display only. */
data class Hd760RxPacket(val channelId: Int, val senderUnitId: String, val atMs: Long)

data class Hd760RxDisplay(val channelId: Int, val unitId: String, val receiving: Boolean)

/** Show the actual RX source, then restore the selected channel 1s after RX ends. */
class Hd760RxDisplayTracker(
    private val holdMs: Long = 1_000L,
    private val missingStopGapMs: Long = 350L
) {
    private var channel: Int? = null
    private var unit: String? = null
    private var lastPacketAt: Long = 0L
    private var endedAt: Long? = null

    @Synchronized fun onPacket(channelId: Int, unitId: String, atMs: Long) {
        if (channelId <= 0 || atMs < lastPacketAt) return
        channel = channelId
        unit = unitId
        lastPacketAt = atMs
        endedAt = null
    }

    @Synchronized fun onEnd(channelId: Int, unitId: String, atMs: Long) {
        if (channel != channelId || unit != unitId || endedAt != null) return
        endedAt = maxOf(atMs, lastPacketAt)
    }

    @Synchronized fun snapshot(nowMs: Long): Hd760RxDisplay? {
        val id = channel ?: return null
        val finish = endedAt ?: if (nowMs - lastPacketAt >= missingStopGapMs) {
            lastPacketAt + missingStopGapMs
        } else null
        if (finish != null && nowMs - finish >= holdMs) {
            reset()
            return null
        }
        return Hd760RxDisplay(id, unit.orEmpty(), finish == null)
    }

    @Synchronized fun reset() {
        channel = null
        unit = null
        lastPacketAt = 0L
        endedAt = null
    }
}
