package com.reedersystems.commandcomms.audio.radio

/** A real-time voice packet from an obsolete transport generation or old queue has no replay value. */
internal object RadioTxFramePolicy {
    const val MAX_AGE_MS = 400L

    fun maySend(packetEpoch: Long, currentEpoch: Long, ageMs: Long): Boolean =
        packetEpoch == currentEpoch && ageMs in 0L..MAX_AGE_MS
}
