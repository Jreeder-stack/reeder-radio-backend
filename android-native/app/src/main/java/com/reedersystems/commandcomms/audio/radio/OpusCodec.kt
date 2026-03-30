package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import org.concentus.OpusApplication
import org.concentus.OpusDecoder
import org.concentus.OpusEncoder
import org.concentus.OpusSignal

private const val TAG = "[OpusCodec]"

class OpusCodec {
    companion object {
        const val SAMPLE_RATE = 48000
        const val CHANNELS = 1
        const val BITRATE = 16000
        const val FRAME_SIZE = 960
        const val FRAME_DURATION_MS = 20
        const val MAX_ENCODED_SIZE = 512
    }

    private var encoder: OpusEncoder? = null
    private var decoder: OpusDecoder? = null
    private val encodeLock = Any()
    private val expectedFrameBytes = FRAME_SIZE * CHANNELS * 2
    @Volatile
    private var initialized = false

    fun initialize() {
        if (initialized) return
        try {
            val enc = OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_VOIP)
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(0)
            enc.setUseVBR(true)
            enc.setUseInbandFEC(true)
            enc.setPacketLossPercent(10)
            encoder = enc
            decoder = OpusDecoder(SAMPLE_RATE, CHANNELS)
            initialized = true
            Log.d(TAG, "OpusCodec initialized (Concentus, sample_rate=$SAMPLE_RATE frame_size=$FRAME_SIZE channels=$CHANNELS complexity=0)")
        } catch (e: Exception) {
            Log.e(TAG, "OpusCodec initialization failed: ${e.message}", e)
        }
    }

    fun encode(pcmData: ByteArray): ByteArray? {
        val byteCount = pcmData.size
        val sampleCount = byteCount / 2
        val currentThread = Thread.currentThread().name
        Log.d(TAG, "OPUS_ENCODE_INPUT samples=$sampleCount bytes=$byteCount thread=$currentThread reusedBuffer=${System.identityHashCode(pcmData)}")

        if (byteCount != expectedFrameBytes || (byteCount and 1) != 0) {
            Log.w(TAG, "OPUS_ENCODE_REJECTED_BAD_FRAME samples=$sampleCount bytes=$byteCount expectedSamples=$FRAME_SIZE expectedBytes=$expectedFrameBytes")
            return null
        }

        synchronized(encodeLock) {
            Log.d(TAG, "OPUS_ENCODE_SERIALIZED thread=$currentThread")
            val enc = encoder ?: return null
            val safeFrameBytes = pcmData.copyOf(expectedFrameBytes)
            val pcmFrame = ShortArray(FRAME_SIZE)
            java.nio.ByteBuffer.wrap(safeFrameBytes)
                .order(java.nio.ByteOrder.LITTLE_ENDIAN)
                .asShortBuffer()
                .get(pcmFrame, 0, FRAME_SIZE)
            val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
            return try {
                val encodedBytes = enc.encode(pcmFrame, 0, FRAME_SIZE, outputBuffer, 0, outputBuffer.size)
                if (encodedBytes > 0) outputBuffer.copyOf(encodedBytes) else null
            } catch (e: AssertionError) {
                Log.e(TAG, "OPUS_ENCODE_ASSERTION_FAILURE samples=$sampleCount bytes=$byteCount thread=$currentThread message=${e.message}", e)
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
            val enc = OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_VOIP)
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(0)
            enc.setUseVBR(true)
            enc.setUseInbandFEC(true)
            enc.setPacketLossPercent(10)
            encoder = enc
            Log.d(TAG, "Encoder re-initialized after assertion failure (complexity=0)")
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
        Log.d(TAG, "OpusCodec released")
    }
}
