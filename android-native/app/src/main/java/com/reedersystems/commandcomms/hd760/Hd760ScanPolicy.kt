package com.reedersystems.commandcomms.hd760

/**
 * Receive-only scan arbitration. The hardware knob always selects the primary
 * TX channel and wins over any secondary traffic. No audio streams are mixed.
 */
data class Hd760ScanDecision(val accept: Boolean, val changed: Boolean, val activeChannel: Int?)

class Hd760ScanPolicy(private val hangMs: Long = 550L) {
    private var active: Int? = null
    private var lastPacketMs = 0L

    @Synchronized
    fun reset() {
        active = null
        lastPacketMs = 0L
    }

    @Synchronized
    fun onPacket(
        channelId: Int,
        primaryId: Int,
        enabledSecondary: Set<Int>,
        scanning: Boolean,
        transmitting: Boolean,
        nowMs: Long
    ): Hd760ScanDecision {
        if (transmitting) {
            reset()
            return Hd760ScanDecision(false, false, null)
        }
        val eligible = channelId == primaryId ||
            (scanning && channelId in enabledSecondary)
        if (!eligible) return Hd760ScanDecision(false, false, active)

        val previous = active
        val expired = previous != null && nowMs - lastPacketMs >= hangMs
        // Primary always preempts a monitored secondary channel.
        val choose = when {
            previous == null || expired -> channelId
            channelId == primaryId -> primaryId
            previous == primaryId -> primaryId
            previous == channelId -> channelId
            else -> previous
        }
        if (choose != channelId) return Hd760ScanDecision(false, false, choose)
        active = choose
        lastPacketMs = nowMs
        return Hd760ScanDecision(true, previous != choose, choose)
    }
}
