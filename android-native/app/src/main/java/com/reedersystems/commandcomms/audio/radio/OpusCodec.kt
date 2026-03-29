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
    @Volatile
    private var initialized = false

    fun initialize() {
        if (initialized) return
        try {
            val enc = OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_VOIP)
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(5)
            enc.setUseVBR(true)
            enc.setUseInbandFEC(true)
            enc.setPacketLossPercent(10)
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
        if (pcmSamples.size < FRAME_SIZE) {
            Log.w(TAG, "PCM frame too small: ${pcmSamples.size} samples, expected $FRAME_SIZE")
            return null
        }
        java.nio.ByteBuffer.wrap(pcmData).order(java.nio.ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(pcmSamples)
        val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
        return try {
            val encodedBytes = enc.encode(pcmSamples, 0, FRAME_SIZE, outputBuffer, 0, outputBuffer.size)
            if (encodedBytes > 0) outputBuffer.copyOf(encodedBytes) else null
        } catch (e: Exception) {
            Log.w(TAG, "Encode error: ${e.message}")
            null
        } catch (e: AssertionError) {
            Log.e(TAG, "Encode assertion failure (re-initializing encoder): ${e.message}", e)
            reinitializeEncoder()
            null
        }
    }

    private fun reinitializeEncoder() {
        try {
            val enc = OpusEncoder(SAMPLE_RATE, CHANNELS, OpusApplication.OPUS_APPLICATION_VOIP)
            enc.setBitrate(BITRATE)
            enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
            enc.setComplexity(5)
            enc.setUseVBR(true)
            enc.setUseInbandFEC(true)
            enc.setPacketLossPercent(10)
            encoder = enc
            Log.d(TAG, "Encoder re-initialized after assertion failure")
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
