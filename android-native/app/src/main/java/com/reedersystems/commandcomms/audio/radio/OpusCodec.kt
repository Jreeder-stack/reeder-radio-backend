package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import org.concentus.OpusApplication
import org.concentus.OpusDecoder
import org.concentus.OpusEncoder
import org.concentus.OpusSignal
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "[OpusCodec]"

class OpusCodec {
    companion object {
        const val DEFAULT_SAMPLE_RATE = 16000
        const val DECODER_SAMPLE_RATE = 16000
        const val SAMPLE_RATE = DEFAULT_SAMPLE_RATE
        const val CHANNELS = 1
        const val BITRATE = 64000
        const val FRAME_SIZE = 320
        const val DECODER_FRAME_SIZE = 320
        const val FRAME_DURATION_MS = 20
        const val MAX_ENCODED_SIZE = 512
        const val COMPLEXITY = 5
        const val CONSECUTIVE_FAILURE_THRESHOLD = 10
        const val BACKOFF_FRAMES = 3
        const val TOTAL_ASSERTION_FAILURE_LIMIT = 50
        const val SUCCESS_STREAK_RESET_THRESHOLD = 10
        const val WARMUP_MAX_RETRIES = 2
        const val CODEC_MARKER_PCM: Byte = 0x01
        const val CODEC_MARKER_OPUS: Byte = 0x02
        private const val COMFORT_NOISE_AMPLITUDE: Short = 10
        private const val MIN_FRAME_ENERGY_THRESHOLD = 1.0
    }

    private var encoder: OpusEncoder? = null
    private var decoder: OpusDecoder? = null
    private val encodeLock = Any()
    @Volatile
    private var initialized = false

    var encoderSampleRate: Int = DEFAULT_SAMPLE_RATE
        private set
    var encoderChannels: Int = CHANNELS
        private set
    var encoderFrameSize: Int = FRAME_SIZE
        private set
    private var expectedFrameBytes: Int = FRAME_SIZE * CHANNELS * 2

    private val encodeRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)
    private val decodeRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)
    private var encodeSummaryBytes: Long = 0
    private var encodeSummaryPcmBytes: Long = 0
    private var decodeSummaryBytes: Long = 0
    private var decodeSummaryPcmBytes: Long = 0
    private var decodePlcCount: Long = 0

    private fun configureEncoder(enc: OpusEncoder, bitrate: Int) {
        enc.setBitrate(bitrate)
        enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
        enc.setComplexity(COMPLEXITY)
        enc.setUseVBR(false)
        enc.setUseInbandFEC(true)
        enc.setPacketLossPercent(10)
    }

    fun initialize() {
        initialize(DEFAULT_SAMPLE_RATE, CHANNELS)
    }

    fun initialize(sampleRate: Int, channels: Int) {
        if (initialized) release()
        encoderSampleRate = sampleRate
        encoderChannels = channels
        encoderFrameSize = (sampleRate * FRAME_DURATION_MS) / 1000
        expectedFrameBytes = encoderFrameSize * channels * 2
        try {
            val enc = OpusEncoder(sampleRate, channels, OpusApplication.OPUS_APPLICATION_VOIP)
            configureEncoder(enc, BITRATE)
            encoder = enc
            decoder = OpusDecoder(DECODER_SAMPLE_RATE, CHANNELS)
            initialized = true
            Log.d(TAG, "OpusCodec initialized rate=$sampleRate channels=$channels frameSize=$encoderFrameSize bitrate=$BITRATE VBR=false complexity=$COMPLEXITY FEC=true lossPercent=10 decoderRate=$DECODER_SAMPLE_RATE ${RadioDiagLog.elapsedTag()}")
        } catch (e: Exception) {
            Log.e("[RadioError]", "OpusCodec initialization failed: ${e::class.simpleName}: ${e.message} rate=$sampleRate channels=$channels", e)
        }
    }

    fun reinitializeEncoderOnly(sampleRate: Int, channels: Int) {
        synchronized(encodeLock) {
            encoderSampleRate = sampleRate
            encoderChannels = channels
            encoderFrameSize = (sampleRate * FRAME_DURATION_MS) / 1000
            expectedFrameBytes = encoderFrameSize * channels * 2
            encodeRateLimiter.reset()
            encodeSummaryBytes = 0; encodeSummaryPcmBytes = 0
            try {
                val enc = OpusEncoder(sampleRate, channels, OpusApplication.OPUS_APPLICATION_VOIP)
                configureEncoder(enc, currentBitrate)
                encoder = enc
                Log.d(TAG, "ENCODER_REINIT rate=$sampleRate frameSize=$encoderFrameSize channels=$channels bitrate=$currentBitrate VBR=false complexity=$COMPLEXITY FEC=true — decoder untouched ${RadioDiagLog.elapsedTag()}")
            } catch (e: Exception) {
                Log.e("[RadioError]", "Encoder-only reinit failed: ${e::class.simpleName}: ${e.message} rate=$sampleRate channels=$channels", e)
            }
        }
    }

    fun reinitializeEncoderIfNeeded(sampleRate: Int, channels: Int) {
        synchronized(encodeLock) {
            reinitializeEncoderOnly(sampleRate, channels)
        }
    }

    private fun warmUpEncoder(enc: OpusEncoder, frameSize: Int): Boolean {
        val silentFrame = ShortArray(frameSize)
        val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
        return try {
            val result = enc.encode(silentFrame, 0, frameSize, outputBuffer, 0, outputBuffer.size)
            result > 0
        } catch (e: Throwable) {
            Log.w(TAG, "ENCODER_WARMUP_FAILED: ${e::class.simpleName}: ${e.message}")
            false
        }
    }

    fun createFreshEncoder(sampleRate: Int, channels: Int) {
        synchronized(encodeLock) {
            encoderSampleRate = sampleRate
            encoderChannels = channels
            encoderFrameSize = (sampleRate * FRAME_DURATION_MS) / 1000
            expectedFrameBytes = encoderFrameSize * channels * 2
            encodeRateLimiter.reset()
            encodeSummaryBytes = 0; encodeSummaryPcmBytes = 0

            for (attempt in 0..WARMUP_MAX_RETRIES) {
                try {
                    val enc = OpusEncoder(sampleRate, channels, OpusApplication.OPUS_APPLICATION_VOIP)
                    configureEncoder(enc, currentBitrate)

                    if (warmUpEncoder(enc, encoderFrameSize)) {
                        encoder = enc
                        Log.d(TAG, "ENCODER_FRESH_CREATE rate=$sampleRate frameSize=$encoderFrameSize channels=$channels bitrate=$currentBitrate attempt=$attempt warmup=passed ${RadioDiagLog.elapsedTag()}")
                        return
                    } else {
                        Log.w(TAG, "ENCODER_WARMUP_RETRY attempt=$attempt rate=$sampleRate — silent frame encode failed, retrying ${RadioDiagLog.elapsedTag()}")
                    }
                } catch (e: Exception) {
                    Log.e("[RadioError]", "ENCODER_FRESH_CREATE_FAILED attempt=$attempt: ${e::class.simpleName}: ${e.message} rate=$sampleRate channels=$channels", e)
                }
            }

            Log.e("[RadioError]", "ENCODER_FRESH_CREATE_EXHAUSTED all ${WARMUP_MAX_RETRIES + 1} attempts failed — falling back to unvalidated encoder ${RadioDiagLog.elapsedTag()}")
            try {
                val enc = OpusEncoder(sampleRate, channels, OpusApplication.OPUS_APPLICATION_VOIP)
                configureEncoder(enc, currentBitrate)
                encoder = enc
            } catch (e: Exception) {
                Log.e("[RadioError]", "ENCODER_FALLBACK_CREATE_FAILED: ${e::class.simpleName}: ${e.message}", e)
                encoder = null
            }
        }
    }

    @Volatile
    var currentBitrate: Int = BITRATE

    fun setBitrateRuntime(newBitrate: Int) {
        if (newBitrate < 6000 || newBitrate > 128000) {
            Log.w("[RadioError]", "setBitrateRuntime: invalid bitrate $newBitrate (valid 6000-128000), ignoring")
            return
        }
        currentBitrate = newBitrate
        synchronized(encodeLock) {
            try {
                encoder?.setBitrate(newBitrate)
                Log.d(TAG, "Encoder bitrate updated to $newBitrate at runtime ${RadioDiagLog.elapsedTag()}")
            } catch (e: Exception) {
                Log.w("[RadioError]", "Failed to set encoder bitrate: ${e.message}")
            }
        }
    }

    fun resetDecoder() {
        if (!initialized) {
            Log.w("[RadioError]", "resetDecoder called but codec not initialized")
            return
        }
        try {
            decoder = OpusDecoder(DECODER_SAMPLE_RATE, CHANNELS)
            decodeRateLimiter.reset()
            decodeSummaryBytes = 0; decodeSummaryPcmBytes = 0; decodePlcCount = 0
            Log.d(TAG, "DECODER_RESET OpusDecoder recreated rate=$DECODER_SAMPLE_RATE channels=$CHANNELS ${RadioDiagLog.elapsedTag()}")
        } catch (e: Exception) {
            Log.e("[RadioError]", "DECODER_RESET_FAILED: ${e::class.simpleName}: ${e.message}", e)
        }
    }

    fun resetEncoder() {
        if (!initialized) {
            Log.w("[RadioError]", "resetEncoder called but codec not initialized")
            return
        }
        synchronized(encodeLock) {
            try {
                val enc = OpusEncoder(encoderSampleRate, encoderChannels, OpusApplication.OPUS_APPLICATION_VOIP)
                configureEncoder(enc, BITRATE)
                encoder = enc
                encodeRateLimiter.reset()
                encodeSummaryBytes = 0; encodeSummaryPcmBytes = 0
                Log.d(TAG, "ENCODER_RESET OpusEncoder recreated rate=$encoderSampleRate frameSize=$encoderFrameSize channels=$encoderChannels complexity=$COMPLEXITY VBR=false ${RadioDiagLog.elapsedTag()}")
            } catch (e: Exception) {
                Log.e("[RadioError]", "ENCODER_RESET_FAILED: ${e::class.simpleName}: ${e.message}", e)
            }
        }
    }

    private val _assertionFailureCount = AtomicLong(0)
    val assertionFailureCount: Long get() = _assertionFailureCount.get()

    private val _encodeFailureCount = AtomicLong(0)
    val encodeFailureCount: Long get() = _encodeFailureCount.get()

    private val _consecutiveAssertionFailures = AtomicLong(0)
    val consecutiveAssertionFailures: Long get() = _consecutiveAssertionFailures.get()

    @Volatile
    var circuitBreakerTripped: Boolean = false
        private set

    @Volatile
    var backoffFramesRemaining: Int = 0
        private set

    @Volatile
    var encoderReinitialized: Boolean = false

    @Volatile
    var lastEncodeWasPcmFallback: Boolean = false

    @Volatile
    var currentAudioSource: String = ""

    private val _consecutiveSuccesses = AtomicLong(0)

    fun resetFailureCounts() {
        _assertionFailureCount.set(0)
        _encodeFailureCount.set(0)
        _consecutiveAssertionFailures.set(0)
        _consecutiveSuccesses.set(0)
        circuitBreakerTripped = false
        backoffFramesRemaining = 0
        encoderReinitialized = false
        lastEncodeWasPcmFallback = false
    }

    private fun wrapPcmFallback(pcmData: ByteArray): ByteArray {
        val wrapped = ByteArray(1 + pcmData.size)
        wrapped[0] = CODEC_MARKER_PCM
        System.arraycopy(pcmData, 0, wrapped, 1, pcmData.size)
        return wrapped
    }

    fun encode(pcmData: ByteArray): ByteArray? {
        val byteCount = pcmData.size
        val sampleCount = byteCount / 2

        synchronized(encodeLock) {
            lastEncodeWasPcmFallback = false

            if (circuitBreakerTripped) {
                lastEncodeWasPcmFallback = true
                Log.d(TAG, "ENCODE_PCM_FALLBACK reason=circuit_breaker_tripped pcmBytes=$byteCount frame=${encodeRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
                return wrapPcmFallback(pcmData)
            }

            if (backoffFramesRemaining > 0) {
                backoffFramesRemaining--
                if (backoffFramesRemaining == 0) {
                    Log.d(TAG, "ENCODE_BACKOFF_COMPLETE — re-initializing encoder and resuming ${RadioDiagLog.elapsedTag()}")
                    reinitializeEncoder()
                }
                lastEncodeWasPcmFallback = true
                return wrapPcmFallback(pcmData)
            }

            val enc = encoder
            if (enc == null) {
                _encodeFailureCount.incrementAndGet()
                Log.w("[RadioError]", "OPUS_ENCODE_NULL_ENCODER method=encode")
                lastEncodeWasPcmFallback = true
                return wrapPcmFallback(pcmData)
            }

            val lockedExpectedBytes = expectedFrameBytes
            val lockedFrameSize = encoderFrameSize
            val lockedSampleRate = encoderSampleRate
            val lockedSource = currentAudioSource

            if (byteCount != lockedExpectedBytes || (byteCount and 1) != 0) {
                _encodeFailureCount.incrementAndGet()
                Log.w("[RadioError]", "OPUS_ENCODE_REJECTED_BAD_FRAME samples=$sampleCount bytes=$byteCount expectedSamples=$lockedFrameSize expectedBytes=$lockedExpectedBytes frame=${encodeRateLimiter.frameCount} source=$lockedSource method=encode")
                return null
            }

            val safeFrameBytes = pcmData.copyOf(lockedExpectedBytes)
            val pcmFrame = ShortArray(lockedFrameSize)
            java.nio.ByteBuffer.wrap(safeFrameBytes)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN)
                .asShortBuffer()
                .get(pcmFrame, 0, lockedFrameSize)

            sanitizePcmFrame(pcmFrame, lockedFrameSize)

            val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
            return try {
                val encodedBytes = enc.encode(pcmFrame, 0, lockedFrameSize, outputBuffer, 0, outputBuffer.size)
                _consecutiveAssertionFailures.set(0)
                val successes = _consecutiveSuccesses.incrementAndGet()
                if (successes >= SUCCESS_STREAK_RESET_THRESHOLD && _assertionFailureCount.get() > 0) {
                    val prevCount = _assertionFailureCount.getAndSet(0)
                    _consecutiveSuccesses.set(0)
                    Log.d(TAG, "ASSERTION_FAILURE_COUNT_RESET after $successes consecutive successes (was $prevCount) ${RadioDiagLog.elapsedTag()}")
                }
                if (encodedBytes > 0) {
                    val result = outputBuffer.copyOf(encodedBytes)
                    encodeRateLimiter.tick()
                    encodeSummaryBytes += encodedBytes
                    encodeSummaryPcmBytes += byteCount

                    if (encodeRateLimiter.shouldLogDetail()) {
                        Log.d(TAG, "ENCODE frame=${encodeRateLimiter.frameCount} pcmBytes=$byteCount encodedBytes=$encodedBytes seq=${encodeRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
                    } else if (encodeRateLimiter.shouldLogSummary()) {
                        val cnt = encodeRateLimiter.resetSummaryAccumulator()
                        Log.d(TAG, "ENCODE_SUMMARY frames=$cnt totalFrames=${encodeRateLimiter.frameCount} totalPcmBytes=$encodeSummaryPcmBytes totalEncodedBytes=$encodeSummaryBytes ${RadioDiagLog.elapsedTag()}")
                    }

                    result
                } else {
                    _encodeFailureCount.incrementAndGet()
                    Log.w("[RadioError]", "OPUS_ENCODE_ZERO_RESULT encodedBytes=$encodedBytes samples=$sampleCount method=encode")
                    lastEncodeWasPcmFallback = true
                    wrapPcmFallback(pcmData)
                }
            } catch (e: AssertionError) {
                _consecutiveSuccesses.set(0)
                val assertCount = _assertionFailureCount.incrementAndGet()
                val consecutiveCount = _consecutiveAssertionFailures.incrementAndGet()
                if (assertCount >= TOTAL_ASSERTION_FAILURE_LIMIT) {
                    circuitBreakerTripped = true
                    Log.e("[RadioError]", "OPUS_ENCODE_CIRCUIT_BREAKER_TRIPPED totalAssertionFailures=$assertCount consecutiveFailures=$consecutiveCount frame=${encodeRateLimiter.frameCount} source=$lockedSource — encoding disabled, PCM fallback for remainder of TX session method=encode")
                } else if (consecutiveCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
                    backoffFramesRemaining = BACKOFF_FRAMES
                    _consecutiveAssertionFailures.set(0)
                    Log.e("[RadioError]", "OPUS_ENCODE_BACKOFF_STARTED consecutiveFailures=$consecutiveCount totalAssertionFailures=$assertCount backoffFrames=$BACKOFF_FRAMES frame=${encodeRateLimiter.frameCount} source=$lockedSource — skipping $BACKOFF_FRAMES frames then re-init method=encode")
                } else {
                    Log.e("[RadioError]", "OPUS_ENCODE_ASSERTION_FAILURE frame=${encodeRateLimiter.frameCount} source=$lockedSource samples=$sampleCount bytes=$byteCount expectedBytes=$lockedExpectedBytes sampleRate=$lockedSampleRate frameSize=$lockedFrameSize consecutiveFailures=$consecutiveCount assertionFailures=$assertCount method=encode")
                    reinitializeEncoder()
                }
                lastEncodeWasPcmFallback = true
                wrapPcmFallback(pcmData)
            } catch (e: Exception) {
                _consecutiveAssertionFailures.set(0)
                _encodeFailureCount.incrementAndGet()
                Log.w("[RadioError]", "Encode error: ${e::class.simpleName}: ${e.message} samples=$sampleCount method=encode")
                lastEncodeWasPcmFallback = true
                wrapPcmFallback(pcmData)
            }
        }
    }

    private var comfortNoiseSeed: Long = 1

    private fun sanitizePcmFrame(pcmFrame: ShortArray, frameSize: Int) {
        var energy = 0.0
        for (i in 0 until frameSize) {
            val sample = pcmFrame[i].toDouble()
            energy += sample * sample
            pcmFrame[i] = pcmFrame[i].coerceIn(-32000, 32000)
        }
        val rmsEnergy = Math.sqrt(energy / frameSize)
        if (rmsEnergy < MIN_FRAME_ENERGY_THRESHOLD) {
            for (i in 0 until frameSize) {
                comfortNoiseSeed = comfortNoiseSeed * 1103515245 + 12345
                val noise = ((comfortNoiseSeed shr 16) and 0xFF) - 128
                pcmFrame[i] = (noise * COMFORT_NOISE_AMPLITUDE / 128).toShort()
            }
        }
    }

    private fun reinitializeEncoder() {
        synchronized(encodeLock) {
            try {
                val enc = OpusEncoder(encoderSampleRate, encoderChannels, OpusApplication.OPUS_APPLICATION_VOIP)
                configureEncoder(enc, currentBitrate)
                encoder = enc
                encoderReinitialized = true
                Log.d(TAG, "Encoder re-initialized after assertion failure (sampleRate=$encoderSampleRate frameSize=$encoderFrameSize complexity=$COMPLEXITY VBR=false bitrate=$currentBitrate) ${RadioDiagLog.elapsedTag()}")
            } catch (t: Throwable) {
                Log.e("[RadioError]", "Failed to re-initialize encoder: ${t::class.simpleName}: ${t.message} method=reinitializeEncoder", t)
                encoder = null
                initialized = false
            }
        }
    }

    fun decode(opusData: ByteArray?): ByteArray? {
        val dec = decoder
        if (dec == null) {
            Log.w("[RadioError]", "OPUS_DECODE_NULL_DECODER method=decode isNull=${opusData == null}")
            return null
        }
        val pcmBuffer = ShortArray(DECODER_FRAME_SIZE * CHANNELS)
        return try {
            val decodedSamples = if (opusData != null) {
                dec.decode(opusData, 0, opusData.size, pcmBuffer, 0, DECODER_FRAME_SIZE, false)
            } else {
                decodePlcCount++
                dec.decode(null, 0, 0, pcmBuffer, 0, DECODER_FRAME_SIZE, false)
            }
            if (decodedSamples > 0) {
                val result = ByteArray(decodedSamples * CHANNELS * 2)
                java.nio.ByteBuffer.wrap(result).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcmBuffer, 0, decodedSamples * CHANNELS)

                decodeRateLimiter.tick()
                val pcmBytes = result.size
                decodeSummaryPcmBytes += pcmBytes
                if (opusData != null) decodeSummaryBytes += opusData.size

                val isPLC = opusData == null
                if (decodeRateLimiter.shouldLogDetail()) {
                    Log.d(TAG, "DECODE frame=${decodeRateLimiter.frameCount} opusBytes=${opusData?.size ?: 0} pcmBytes=$pcmBytes decodedSamples=$decodedSamples PLC=$isPLC ${RadioDiagLog.elapsedTag()}")
                } else if (decodeRateLimiter.shouldLogSummary()) {
                    val cnt = decodeRateLimiter.resetSummaryAccumulator()
                    Log.d(TAG, "DECODE_SUMMARY frames=$cnt totalFrames=${decodeRateLimiter.frameCount} totalOpusBytes=$decodeSummaryBytes totalPcmBytes=$decodeSummaryPcmBytes plcCount=$decodePlcCount ${RadioDiagLog.elapsedTag()}")
                }

                result
            } else {
                Log.w("[RadioError]", "OPUS_DECODE_ZERO_RESULT decodedSamples=$decodedSamples opusBytes=${opusData?.size ?: 0} PLC=${opusData == null} method=decode")
                null
            }
        } catch (t: Throwable) {
            Log.w("[RadioError]", "Decode error: ${t::class.simpleName}: ${t.message} opusBytes=${opusData?.size ?: 0} PLC=${opusData == null} method=decode")
            null
        }
    }

    fun release() {
        encoder = null
        decoder = null
        initialized = false
        encoderSampleRate = DEFAULT_SAMPLE_RATE
        encoderChannels = CHANNELS
        encoderFrameSize = FRAME_SIZE
        expectedFrameBytes = FRAME_SIZE * CHANNELS * 2
        encodeRateLimiter.reset()
        decodeRateLimiter.reset()
        Log.d(TAG, "OpusCodec released (encoderDefaults: rate=$DEFAULT_SAMPLE_RATE frameSize=$FRAME_SIZE decoderRate=$DECODER_SAMPLE_RATE decoderFrameSize=$DECODER_FRAME_SIZE) ${RadioDiagLog.elapsedTag()}")
    }
}
