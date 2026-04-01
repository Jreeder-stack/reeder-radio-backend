package com.reedersystems.commandcomms.audio.radio

import android.util.Log

private const val TAG = "[JitterBuf]"
private const val MAX_BUFFER_SIZE = 50
private const val MIN_DEPTH = 2
private const val MAX_DEPTH = 8
private const val INITIAL_DEPTH = 3
private const val JITTER_ALPHA = 0.07
private const val SEQ_MOD = 65536
private const val SEQ_HALF = 32768
private const val RECONNECT_PROTECTION_FRAMES = 3

class JitterBuffer {

    private val buffer = HashMap<Int, ByteArray>()
    private val lock = Object()

    private var nextPlaybackSeq: Int = -1
    private var preBuffering = true
    private var targetDepth = INITIAL_DEPTH
    private var running = false
    private var playbackActive = false

    private var lastArrivalTimeNs: Long = 0L
    private var estimatedJitterMs: Double = 0.0

    @Volatile
    private var reconnectProtection = false
    private var reconnectProtectionDepth = RECONNECT_PROTECTION_FRAMES

    fun start() {
        synchronized(lock) {
            running = true
            buffer.clear()
            nextPlaybackSeq = -1
            preBuffering = true
            playbackActive = false
            targetDepth = INITIAL_DEPTH
            lastArrivalTimeNs = 0L
            estimatedJitterMs = 0.0
            reconnectProtection = false
        }
        Log.d(TAG, "JitterBuffer started (adaptive depth=$INITIAL_DEPTH)")
    }

    fun stop() {
        synchronized(lock) {
            running = false
            playbackActive = false
            buffer.clear()
            nextPlaybackSeq = -1
            preBuffering = true
            reconnectProtection = false
        }
        Log.d(TAG, "JitterBuffer stopped")
    }

    fun flushForReconnect() {
        synchronized(lock) {
            val staleCount = buffer.size
            buffer.clear()
            nextPlaybackSeq = -1
            preBuffering = true
            playbackActive = false
            lastArrivalTimeNs = 0L
            estimatedJitterMs = 0.0
            targetDepth = INITIAL_DEPTH
            reconnectProtection = true
            reconnectProtectionDepth = RECONNECT_PROTECTION_FRAMES
            Log.d(TAG, "RECONNECT_JITTER_BUFFER_FLUSHED staleFrames=$staleCount protectionFrames=$RECONNECT_PROTECTION_FRAMES")
        }
    }

    fun enqueue(sequence: Int, packet: ByteArray) {
        synchronized(lock) {
            if (!running) return

            if (playbackActive && nextPlaybackSeq >= 0 && seqBefore(sequence, nextPlaybackSeq)) {
                Log.d(TAG, "Late packet seq=$sequence (playing=$nextPlaybackSeq), discarded")
                return
            }

            if (buffer.size >= MAX_BUFFER_SIZE) {
                val farthest = findFarthestSeq()
                if (farthest != null) {
                    buffer.remove(farthest)
                    Log.w(TAG, "Overflow — dropped farthest seq=$farthest")
                }
            }

            buffer[sequence] = packet

            updateJitterEstimate()
        }
    }

    fun hasPacket(sequence: Int): Boolean {
        synchronized(lock) {
            return buffer.containsKey(sequence)
        }
    }

    fun take(sequence: Int): ByteArray? {
        synchronized(lock) {
            if (!running) return null
            return buffer.remove(sequence)
        }
    }

    fun getExpectedSeq(): Int {
        synchronized(lock) {
            return nextPlaybackSeq
        }
    }

    fun advancePlaybackSeq() {
        synchronized(lock) {
            if (nextPlaybackSeq >= 0) {
                nextPlaybackSeq = advanceSeq(nextPlaybackSeq)
            }
        }
    }

    fun tryStartPlayback(): Boolean {
        synchronized(lock) {
            if (!running) return false
            if (!preBuffering) return playbackActive

            val requiredDepth = if (reconnectProtection) {
                maxOf(targetDepth, reconnectProtectionDepth)
            } else {
                targetDepth
            }

            if (buffer.size < requiredDepth) {
                return false
            }
            preBuffering = false
            playbackActive = true
            nextPlaybackSeq = findOldestSeq() ?: return false
            if (reconnectProtection) {
                Log.d(TAG, "RECONNECT_PROTECTION_COMPLETE — playback starting at seq=$nextPlaybackSeq (protectionDepth=$reconnectProtectionDepth buffered=${buffer.size})")
                reconnectProtection = false
            } else {
                Log.d(TAG, "Pre-buffer complete, starting at seq=$nextPlaybackSeq (depth=$targetDepth, buffered=${buffer.size})")
            }
            return true
        }
    }

    val isPlaybackActive: Boolean get() = synchronized(lock) { playbackActive }

    fun enterIdle() {
        synchronized(lock) {
            nextPlaybackSeq = -1
            preBuffering = true
            playbackActive = false
            lastArrivalTimeNs = 0L
            estimatedJitterMs = 0.0
            targetDepth = MIN_DEPTH
            Log.d(TAG, "Entered idle — pre-buffering on next packet (depth=$MIN_DEPTH, kept ${buffer.size} buffered frames)")
        }
    }

    val size: Int get() = synchronized(lock) { buffer.size }
    val isEmpty: Boolean get() = synchronized(lock) { buffer.isEmpty() }
    val currentTargetDepth: Int get() = synchronized(lock) { targetDepth }

    private fun findFarthestSeq(): Int? {
        if (buffer.isEmpty()) return null
        if (nextPlaybackSeq >= 0) {
            return buffer.keys.maxByOrNull { seqDistance(nextPlaybackSeq, it) }
        }
        return buffer.keys.reduce { farthest, seq ->
            if (seqBefore(farthest, seq)) seq else farthest
        }
    }

    private fun findOldestSeq(): Int? {
        if (buffer.isEmpty()) return null
        if (nextPlaybackSeq >= 0) {
            return buffer.keys.minByOrNull { seqDistance(nextPlaybackSeq, it) }
        }
        return buffer.keys.reduce { oldest, seq ->
            if (seqBefore(seq, oldest)) seq else oldest
        }
    }

    private fun seqDistance(from: Int, to: Int): Int {
        return (to - from + SEQ_MOD) % SEQ_MOD
    }

    private fun updateJitterEstimate() {
        val now = System.nanoTime()
        if (lastArrivalTimeNs > 0) {
            val intervalMs = (now - lastArrivalTimeNs) / 1_000_000.0
            val deviation = kotlin.math.abs(intervalMs - OpusCodec.FRAME_DURATION_MS)
            estimatedJitterMs = (1 - JITTER_ALPHA) * estimatedJitterMs + JITTER_ALPHA * deviation
            val newDepth = (estimatedJitterMs / OpusCodec.FRAME_DURATION_MS + 1.5).toInt()
                .coerceIn(MIN_DEPTH, MAX_DEPTH)
            if (newDepth != targetDepth) {
                Log.d(TAG, "Adaptive depth: $targetDepth → $newDepth (jitter=${String.format("%.1f", estimatedJitterMs)}ms)")
                targetDepth = newDepth
            }
        }
        lastArrivalTimeNs = now
    }

    private fun seqBefore(a: Int, b: Int): Boolean {
        val diff = (a - b + SEQ_MOD) % SEQ_MOD
        return diff > SEQ_HALF
    }

    private fun advanceSeq(seq: Int): Int = (seq + 1) % SEQ_MOD
}
