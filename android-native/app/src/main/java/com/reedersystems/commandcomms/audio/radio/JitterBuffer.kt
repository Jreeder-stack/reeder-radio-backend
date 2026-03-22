/**
 * JitterBuffer — Smooths packet timing variation for receive audio.
 *
 * Module boundary: This is a pure data structure with no dependencies on Android APIs,
 * signaling, or transport. It accepts encoded audio frames tagged with sequence numbers,
 * reorders them, and outputs frames at regular intervals. The RadioAudioEngine feeds
 * frames from UdpAudioTransport into this buffer and pulls from it for decoding.
 *
 * Configuration: 2–4 frames (~40–80 ms at 20 ms/frame) for radio-style low latency.
 * Uses a circular ring buffer indexed by sequence number modulo capacity.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

class JitterBuffer(
    private val capacity: Int = DEFAULT_CAPACITY
) {
    companion object {
        const val DEFAULT_CAPACITY = 4
        const val MIN_BUFFERED_BEFORE_PLAY = 2
        private const val SEQ_MAX = 65536
        private const val SEQ_HALF = SEQ_MAX / 2
    }

    data class Frame(
        val sequenceNumber: Int,
        val data: ByteArray
    ) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is Frame) return false
            return sequenceNumber == other.sequenceNumber && data.contentEquals(other.data)
        }

        override fun hashCode(): Int {
            return 31 * sequenceNumber + data.contentHashCode()
        }
    }

    private val buffer = arrayOfNulls<Frame>(capacity)
    private var playoutSeq = -1
    private var frameCount = 0
    private var primed = false

    @Synchronized
    fun push(sequenceNumber: Int, data: ByteArray) {
        if (playoutSeq == -1) {
            playoutSeq = sequenceNumber
        }

        val ahead = seqDiff(sequenceNumber, playoutSeq)

        if (ahead < 0) return

        if (ahead >= capacity) {
            val advance = ahead - capacity + 1
            for (i in 0 until advance) {
                val idx = (playoutSeq + i) % capacity
                if (buffer[idx] != null) {
                    buffer[idx] = null
                    frameCount--
                }
            }
            playoutSeq = (playoutSeq + advance) and (SEQ_MAX - 1)
        }

        val index = sequenceNumber % capacity
        if (buffer[index] == null) {
            frameCount++
        }
        buffer[index] = Frame(sequenceNumber, data.copyOf())

        if (!primed && frameCount >= MIN_BUFFERED_BEFORE_PLAY) {
            primed = true
        }
    }

    @Synchronized
    fun pop(): Frame? {
        if (!primed || frameCount == 0) return null

        val index = playoutSeq % capacity
        val frame = buffer[index]
        buffer[index] = null
        if (frame != null) {
            frameCount--
        }
        playoutSeq = (playoutSeq + 1) and (SEQ_MAX - 1)
        return frame
    }

    @Synchronized
    fun reset() {
        for (i in buffer.indices) {
            buffer[i] = null
        }
        frameCount = 0
        playoutSeq = -1
        primed = false
    }

    val bufferedCount: Int
        @Synchronized get() = frameCount

    val isReady: Boolean
        @Synchronized get() = primed && frameCount > 0

    private fun seqDiff(a: Int, b: Int): Int {
        val diff = a - b
        return when {
            diff > SEQ_HALF -> diff - SEQ_MAX
            diff < -SEQ_HALF -> diff + SEQ_MAX
            else -> diff
        }
    }
}
