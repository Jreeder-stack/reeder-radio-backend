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

    private val enqueueRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)
    private var summaryLateDrops: Long = 0
    private var summaryOverflows: Long = 0
    private var summaryUnderruns: Long = 0
    private var summaryReorders: Long = 0
    private var summaryEnqueued: Long = 0

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
        enqueueRateLimiter.reset()
        summaryLateDrops = 0; summaryOverflows = 0; summaryUnderruns = 0; summaryReorders = 0; summaryEnqueued = 0
        Log.d(TAG, "JitterBuffer started targetDepth=$INITIAL_DEPTH maxBuf=$MAX_BUFFER_SIZE ${RadioDiagLog.elapsedTag()}")
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
        Log.d(TAG, "JitterBuffer stopped totalEnqueued=$summaryEnqueued lateDrops=$summaryLateDrops overflows=$summaryOverflows underruns=$summaryUnderruns reorders=$summaryReorders ${RadioDiagLog.elapsedTag()}")
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
            Log.d(TAG, "FLUSH_FOR_RECONNECT staleFrames=$staleCount protectionFrames=$RECONNECT_PROTECTION_FRAMES resetDepth=$INITIAL_DEPTH ${RadioDiagLog.elapsedTag()}")
        }
        enqueueRateLimiter.reset()
    }

    fun enqueue(sequence: Int, packet: ByteArray) {
        synchronized(lock) {
            if (!running) {
                Log.w("[RadioError]", "enqueue called while not running seq=$sequence — ignoring")
                return
            }

            if (playbackActive && nextPlaybackSeq >= 0 && seqBefore(sequence, nextPlaybackSeq)) {
                summaryLateDrops++
                Log.d(TAG, "Late packet seq=$sequence (playing=$nextPlaybackSeq), discarded totalLateDrops=$summaryLateDrops")
                return
            }

            if (buffer.size >= MAX_BUFFER_SIZE) {
                val farthest = findFarthestSeq()
                if (farthest != null) {
                    buffer.remove(farthest)
                    summaryOverflows++
                    Log.w(TAG, "Overflow — dropped farthest seq=$farthest bufSize=${buffer.size} totalOverflows=$summaryOverflows")
                }
            }

            if (playbackActive && nextPlaybackSeq >= 0) {
                val distance = seqDistance(nextPlaybackSeq, sequence)
                if (distance > 1 && buffer.containsKey(sequence).not()) {
                    summaryReorders++
                }
            }

            buffer[sequence] = packet
            summaryEnqueued++

            enqueueRateLimiter.tick()
            if (enqueueRateLimiter.shouldLogDetail()) {
                Log.d(TAG, "ENQUEUE seq=$sequence bufSize=${buffer.size} targetDepth=$targetDepth playbackActive=$playbackActive playbackSeq=$nextPlaybackSeq payload=${packet.size} ${RadioDiagLog.elapsedTag()}")
            } else if (enqueueRateLimiter.shouldLogSummary()) {
                val cnt = enqueueRateLimiter.resetSummaryAccumulator()
                Log.d(TAG, "ENQUEUE_SUMMARY frames=$cnt totalEnqueued=$summaryEnqueued bufSize=${buffer.size} depth=$targetDepth lateDrops=$summaryLateDrops overflows=$summaryOverflows underruns=$summaryUnderruns reorders=$summaryReorders jitter=${String.format("%.1f", estimatedJitterMs)}ms ${RadioDiagLog.elapsedTag()}")
            }

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
                Log.d(TAG, "RECONNECT_PROTECTION_COMPLETE — playback starting at seq=$nextPlaybackSeq (protectionDepth=$reconnectProtectionDepth buffered=${buffer.size}) ${RadioDiagLog.elapsedTag()}")
                reconnectProtection = false
            } else {
                Log.d(TAG, "PRE_BUFFER_COMPLETE startSeq=$nextPlaybackSeq targetDepth=$targetDepth buffered=${buffer.size} ${RadioDiagLog.elapsedTag()}")
            }
            return true
        }
    }

    fun recordUnderrun() {
        summaryUnderruns++
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
            Log.d(TAG, "ENTER_IDLE depth=$MIN_DEPTH keptFrames=${buffer.size} ${RadioDiagLog.elapsedTag()}")
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
