package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import org.concentus.OpusApplication
import org.concentus.OpusDecoder
import org.concentus.OpusEncoder
import org.concentus.OpusSignal

private const val TAG = "[OpusCodec]"

class OpusCodec {
    companion object {
        const val DEFAULT_SAMPLE_RATE = 48000
        const val SAMPLE_RATE = DEFAULT_SAMPLE_RATE
        const val CHANNELS = 1
        const val BITRATE = 48000
        const val FRAME_SIZE = 960
        const val FRAME_DURATION_MS = 20
        const val MAX_ENCODED_SIZE = 512
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
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(5)
            enc.setUseVBR(true)
            enc.setUseInbandFEC(true)
            enc.setPacketLossPercent(10)
            encoder = enc
            decoder = OpusDecoder(DEFAULT_SAMPLE_RATE, CHANNELS)
            initialized = true
            Log.d(TAG, "OpusCodec initialized (Concentus, encoder_sample_rate=$sampleRate encoder_frame_size=$encoderFrameSize channels=$channels decoder_sample_rate=$DEFAULT_SAMPLE_RATE complexity=5)")
        } catch (e: Exception) {
            Log.e(TAG, "OpusCodec initialization failed: ${e.message}", e)
        }
    }

    fun reinitializeEncoderOnly(sampleRate: Int, channels: Int) {
        encoderSampleRate = sampleRate
        encoderChannels = channels
        encoderFrameSize = (sampleRate * FRAME_DURATION_MS) / 1000
        expectedFrameBytes = encoderFrameSize * channels * 2
        synchronized(encodeLock) {
            try {
                val enc = OpusEncoder(sampleRate, channels, OpusApplication.OPUS_APPLICATION_VOIP)
                enc.setBitrate(currentBitrate)
                enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
                enc.setComplexity(5)
                enc.setUseVBR(true)
                enc.setUseInbandFEC(true)
                enc.setPacketLossPercent(10)
                encoder = enc
                Log.d(TAG, "Encoder-only reinit (sampleRate=$sampleRate frameSize=$encoderFrameSize channels=$channels) — decoder untouched")
            } catch (e: Exception) {
                Log.e(TAG, "Encoder-only reinit failed: ${e.message}", e)
            }
        }
    }

    @Volatile
    var currentBitrate: Int = BITRATE

    fun setBitrateRuntime(newBitrate: Int) {
        if (newBitrate < 6000 || newBitrate > 128000) {
            Log.w(TAG, "setBitrateRuntime: invalid bitrate $newBitrate, ignoring")
            return
        }
        currentBitrate = newBitrate
        synchronized(encodeLock) {
            try {
                encoder?.setBitrate(newBitrate)
                Log.d(TAG, "Encoder bitrate updated to $newBitrate at runtime")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to set encoder bitrate: ${e.message}")
            }
        }
    }

    fun resetDecoder() {
        if (!initialized) return
        try {
            decoder = OpusDecoder(DEFAULT_SAMPLE_RATE, CHANNELS)
            Log.d(TAG, "RECONNECT_DECODER_RESET OpusDecoder recreated — stale state cleared")
        } catch (e: Exception) {
            Log.e(TAG, "RECONNECT_DECODER_RESET_FAILED: ${e.message}", e)
        }
    }

    fun resetEncoder() {
        if (!initialized) return
        synchronized(encodeLock) {
            try {
                val enc = OpusEncoder(encoderSampleRate, encoderChannels, OpusApplication.OPUS_APPLICATION_VOIP)
                enc.setBitrate(BITRATE)
                enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
                enc.setComplexity(5)
                enc.setUseVBR(true)
                enc.setUseInbandFEC(true)
                enc.setPacketLossPercent(10)
                encoder = enc
                Log.d(TAG, "RECONNECT_ENCODER_RESET OpusEncoder recreated (sampleRate=$encoderSampleRate frameSize=$encoderFrameSize) — stale state cleared")
            } catch (e: Exception) {
                Log.e(TAG, "RECONNECT_ENCODER_RESET_FAILED: ${e.message}", e)
            }
        }
    }

    fun encode(pcmData: ByteArray): ByteArray? {
        val byteCount = pcmData.size
        val sampleCount = byteCount / 2

        if (byteCount != expectedFrameBytes || (byteCount and 1) != 0) {
            Log.w(TAG, "OPUS_ENCODE_REJECTED_BAD_FRAME samples=$sampleCount bytes=$byteCount expectedSamples=$encoderFrameSize expectedBytes=$expectedFrameBytes")
            return null
        }

        synchronized(encodeLock) {
            val enc = encoder ?: return null
            val safeFrameBytes = pcmData.copyOf(expectedFrameBytes)
            val pcmFrame = ShortArray(encoderFrameSize)
            java.nio.ByteBuffer.wrap(safeFrameBytes)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN)
                .asShortBuffer()
                .get(pcmFrame, 0, encoderFrameSize)
            val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
            return try {
                val encodedBytes = enc.encode(pcmFrame, 0, encoderFrameSize, outputBuffer, 0, outputBuffer.size)
                if (encodedBytes > 0) outputBuffer.copyOf(encodedBytes) else null
            } catch (e: AssertionError) {
                Log.e(TAG, "OPUS_ENCODE_ASSERTION_FAILURE samples=$sampleCount bytes=$byteCount message=${e.message}", e)
                reinitializeEncoder()
                null
            } catch (e: Exception) {
                Log.w(TAG, "Encode error: ${e.message}")
                null
            }
        }
    }

    private fun reinitializeEncoder() {
        try {
            val enc = OpusEncoder(encoderSampleRate, encoderChannels, OpusApplication.OPUS_APPLICATION_VOIP)
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(5)
            enc.setUseVBR(true)
            enc.setUseInbandFEC(true)
            enc.setPacketLossPercent(10)
            encoder = enc
            Log.d(TAG, "Encoder re-initialized after assertion failure (sampleRate=$encoderSampleRate frameSize=$encoderFrameSize complexity=5)")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to re-initialize encoder: ${t.message}", t)
            encoder = null
            initialized = false
        }
    }

    fun decode(opusData: ByteArray?): ByteArray? {
        val dec = decoder ?: return null
        val pcmBuffer = ShortArray(FRAME_SIZE * CHANNELS)
        return try {
            val decodedSamples = if (opusData != null) {
                dec.decode(opusData, 0, opusData.size, pcmBuffer, 0, FRAME_SIZE, false)
            } else {
                dec.decode(null, 0, 0, pcmBuffer, 0, FRAME_SIZE, false)
            }
            if (decodedSamples > 0) {
                val result = ByteArray(decodedSamples * CHANNELS * 2)
                java.nio.ByteBuffer.wrap(result).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcmBuffer, 0, decodedSamples * CHANNELS)
                result
            } else null
        } catch (t: Throwable) {
            Log.w(TAG, "Decode error: ${t.message}")
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
        Log.d(TAG, "OpusCodec released")
    }
}
