package com.reedersystems.commandcomms.audio.radio

import android.os.SystemClock
import android.util.Log

object RadioDiagLog {

    const val TAG_PTT_DIAG = "PTT-DIAG"
    const val TAG_RADIO_STATE = "RadioState"
    const val TAG_FLOOR_CTRL = "FloorCtrl"
    const val TAG_RADIO_SIG_GW = "RadioSigGW"
    const val TAG_AUDIO_CAPTURE = "AudioCapture"
    const val TAG_AUDIO_DSP = "AudioDSP"
    const val TAG_OPUS_CODEC = "OpusCodec"
    const val TAG_UDP_TRANSPORT = "UdpTransport"
    const val TAG_JITTER_BUF = "JitterBuf"
    const val TAG_AUDIO_PLAY = "AudioPlay"
    const val TAG_RADIO_ENGINE = "RadioEngine"
    const val TAG_RADIO_ERROR = "RadioError"

    @Volatile
    private var sessionStartNs: Long = SystemClock.elapsedRealtimeNanos()

    fun resetSessionClock() {
        sessionStartNs = SystemClock.elapsedRealtimeNanos()
    }

    fun elapsedMs(): Long {
        return (SystemClock.elapsedRealtimeNanos() - sessionStartNs) / 1_000_000L
    }

    fun elapsedTag(): String = "t=${elapsedMs()}ms"

    class RateLimiter(
        private val detailCount: Int = 5,
        private val summaryIntervalMs: Long = 1000L
    ) {
        @Volatile
        var frameCount: Long = 0
            private set
        @Volatile
        private var lastSummaryTimeMs: Long = 0L
        @Volatile
        var summaryAccumulator: Long = 0
            private set

        fun shouldLogDetail(): Boolean {
            return frameCount <= detailCount
        }

        fun shouldLogSummary(): Boolean {
            val now = SystemClock.elapsedRealtime()
            if (now - lastSummaryTimeMs >= summaryIntervalMs) {
                lastSummaryTimeMs = now
                return true
            }
            return false
        }

        fun tick() {
            frameCount++
            summaryAccumulator++
        }

        fun resetSummaryAccumulator(): Long {
            val v = summaryAccumulator
            summaryAccumulator = 0
            return v
        }

        fun reset() {
            frameCount = 0
            lastSummaryTimeMs = 0L
            summaryAccumulator = 0
        }
    }

    fun pcmStats(buffer: ByteArray, length: Int): PcmStats {
        val sampleCount = length / 2
        if (sampleCount == 0) return PcmStats(0, 0, 0, 0.0, true, 0)
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        var min = Short.MAX_VALUE.toInt()
        var max = Short.MIN_VALUE.toInt()
        var sumSquares = 0.0
        var zeroCount = 0
        for (i in 0 until sampleCount) {
            val s = buf.getShort(i * 2).toInt()
            if (s < min) min = s
            if (s > max) max = s
            sumSquares += s.toDouble() * s.toDouble()
            if (s == 0) zeroCount++
        }
        val rms = Math.sqrt(sumSquares / sampleCount)
        val silent = rms < 50.0
        return PcmStats(sampleCount, min, max, rms, silent, zeroCount)
    }

    fun pcmStatsShort(buffer: ShortArray, length: Int): PcmStats {
        if (length == 0) return PcmStats(0, 0, 0, 0.0, true, 0)
        var min = Short.MAX_VALUE.toInt()
        var max = Short.MIN_VALUE.toInt()
        var sumSquares = 0.0
        var zeroCount = 0
        for (i in 0 until length) {
            val s = buffer[i].toInt()
            if (s < min) min = s
            if (s > max) max = s
            sumSquares += s.toDouble() * s.toDouble()
            if (s == 0) zeroCount++
        }
        val rms = Math.sqrt(sumSquares / length)
        val silent = rms < 50.0
        return PcmStats(length, min, max, rms, silent, zeroCount)
    }

    data class PcmStats(
        val sampleCount: Int,
        val min: Int,
        val max: Int,
        val rms: Double,
        val silent: Boolean,
        val zeroCount: Int
    ) {
        override fun toString(): String =
            "samples=$sampleCount min=$min max=$max rms=${String.format("%.1f", rms)} silent=$silent zeros=$zeroCount"
    }

    class TxSessionStats {
        var startTimeMs: Long = System.currentTimeMillis()
        var requestedRate: Int = 0
        var actualRate: Int = 0
        var channels: Int = 0
        var audioSource: String = ""
        var framesRead: Long = 0
        var framesEncoded: Long = 0
        var packetsSent: Long = 0
        var failures: Long = 0
        var silentFrames: Long = 0
        var partialReads: Long = 0
        var zeroReads: Long = 0
        var stopReason: String = "unknown"
        var assertionFailures: Long = 0
        var encodeFailures: Long = 0
        var pcmFallbackFrames: Long = 0
        val probeResults: MutableMap<String, Double> = mutableMapOf()
        val firstFrameRmsValues: MutableList<Double> = mutableListOf()

        fun summary(): String {
            val durationMs = System.currentTimeMillis() - startTimeMs
            val probeStr = probeResults.entries.joinToString(",") { "${it.key}=${String.format("%.1f", it.value)}" }
            val rmsStr = firstFrameRmsValues.joinToString(",") { String.format("%.1f", it) }
            return "TX_SESSION_END duration=${durationMs}ms reqRate=$requestedRate actRate=$actualRate ch=$channels src=$audioSource framesRead=$framesRead framesEncoded=$framesEncoded pktSent=$packetsSent failures=$failures encodeFailures=$encodeFailures assertionFailures=$assertionFailures pcmFallback=$pcmFallbackFrames silentFrames=$silentFrames partials=$partialReads zeros=$zeroReads probeRms=[$probeStr] first10rms=[$rmsStr] stop=$stopReason"
        }

        fun summaryJson(): String {
            val durationMs = System.currentTimeMillis() - startTimeMs
            return """"durationMs":$durationMs,"framesRead":$framesRead,"framesEncoded":$framesEncoded,"pktSent":$packetsSent,"failures":$failures,"pcmFallback":$pcmFallbackFrames,"silentFrames":$silentFrames,"stopReason":"$stopReason""""
        }

        fun reset() {
            startTimeMs = System.currentTimeMillis()
            requestedRate = 0; actualRate = 0; channels = 0; audioSource = ""
            framesRead = 0; framesEncoded = 0; packetsSent = 0; failures = 0
            silentFrames = 0; partialReads = 0; zeroReads = 0; stopReason = "unknown"
            assertionFailures = 0; encodeFailures = 0; pcmFallbackFrames = 0
            probeResults.clear(); firstFrameRmsValues.clear()
        }
    }

    class RxSessionStats {
        var startTimeMs: Long = System.currentTimeMillis()
        var packetsReceived: Long = 0
        var packetsDropped: Long = 0
        var packetsDecoded: Long = 0
        var failures: Long = 0
        var totalJitterDepth: Long = 0
        var jitterSamples: Long = 0
        var underruns: Long = 0
        var stopReason: String = "unknown"

        fun avgJitterDepth(): Double =
            if (jitterSamples > 0) totalJitterDepth.toDouble() / jitterSamples else 0.0

        fun summary(): String {
            val durationMs = System.currentTimeMillis() - startTimeMs
            return "RX_SESSION_END duration=${durationMs}ms pktsRecv=$packetsReceived pktsDrop=$packetsDropped pktsDec=$packetsDecoded failures=$failures avgJitter=${String.format("%.1f", avgJitterDepth())} underruns=$underruns stop=$stopReason"
        }

        fun reset() {
            startTimeMs = System.currentTimeMillis()
            packetsReceived = 0; packetsDropped = 0; packetsDecoded = 0
            failures = 0; totalJitterDepth = 0; jitterSamples = 0; underruns = 0
            stopReason = "unknown"
        }
    }
}
