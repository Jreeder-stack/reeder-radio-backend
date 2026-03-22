package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import org.concentus.OpusApplication
import org.concentus.OpusDecoder
import org.concentus.OpusEncoder
import org.concentus.OpusSignal

private const val TAG = "[OpusCodec]"

class OpusCodec {
    companion object {
        const val SAMPLE_RATE = 16000
        const val CHANNELS = 1
        const val BITRATE = 24000
        const val FRAME_SIZE = 320
        const val FRAME_DURATION_MS = 20
        const val MAX_ENCODED_SIZE = 512
    }

    private var encoder: OpusEncoder? = null
    private var decoder: OpusDecoder? = null
    @Volatile
    private var initialized = false

    fun initialize() {
        if (initialized) return
        try {
            val enc = OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_VOIP)
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(5)
            encoder = enc
            decoder = OpusDecoder(SAMPLE_RATE, CHANNELS)
            initialized = true
            Log.d(TAG, "OpusCodec initialized (Concentus, sample_rate=$SAMPLE_RATE frame_size=$FRAME_SIZE channels=$CHANNELS)")
        } catch (e: Exception) {
            Log.e(TAG, "OpusCodec initialization failed: ${e.message}", e)
        }
    }

    fun encode(pcmData: ByteArray): ByteArray? {
        val enc = encoder ?: return null
        val pcmSamples = ShortArray(pcmData.size / 2)
        java.nio.ByteBuffer.wrap(pcmData).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(pcmSamples)
        val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
        return try {
            val encodedBytes = enc.encode(pcmSamples, 0, FRAME_SIZE, outputBuffer, 0, outputBuffer.size)
            if (encodedBytes > 0) outputBuffer.copyOf(encodedBytes) else null
        } catch (e: Exception) {
            Log.w(TAG, "Encode error: ${e.message}")
            null
        }
    }

    fun decode(opusData: ByteArray): ByteArray? {
        val dec = decoder ?: return null
        val pcmBuffer = ShortArray(FRAME_SIZE * CHANNELS)
        return try {
            val decodedSamples = dec.decode(opusData, 0, opusData.size, pcmBuffer, 0, FRAME_SIZE, false)
            if (decodedSamples > 0) {
                val result = ByteArray(decodedSamples * CHANNELS * 2)
                java.nio.ByteBuffer.wrap(result).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcmBuffer, 0, decodedSamples * CHANNELS)
                result
            } else null
        } catch (e: Exception) {
            Log.w(TAG, "Decode error: ${e.message}")
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
