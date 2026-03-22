/**
 * OpusCodec — Wraps Opus encoding and decoding using the Concentus pure-Java library.
 *
 * Module boundary: This is a standalone codec module with no dependencies on signaling,
 * transport, or Android audio APIs. It accepts raw PCM samples and produces encoded
 * Opus frames (and vice versa). Other radio engine modules feed data through this
 * codec via direct method calls.
 *
 * Configuration: 16 kHz mono, ~24 kbps, 20 ms frames (320 samples per frame at 16 kHz).
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import org.concentus.OpusApplication
import org.concentus.OpusDecoder
import org.concentus.OpusEncoder
import org.concentus.OpusSignal

class OpusCodec(
    private val sampleRate: Int = SAMPLE_RATE,
    private val channels: Int = CHANNELS,
    private val bitrate: Int = BITRATE,
    private val frameSize: Int = FRAME_SIZE
) {
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

    fun initEncoder() {
        val enc = OpusEncoder(sampleRate, channels, OpusApplication.OPUS_APPLICATION_VOIP)
        enc.setBitrate(bitrate)
        enc.setSignalType(OpusSignal.OPUS_SIGNAL_VOICE)
        enc.setComplexity(5)
        encoder = enc
    }

    fun initDecoder() {
        decoder = OpusDecoder(sampleRate, channels)
    }

    fun encode(pcmSamples: ShortArray, offset: Int = 0, length: Int = frameSize): ByteArray? {
        val enc = encoder ?: return null
        val outputBuffer = ByteArray(MAX_ENCODED_SIZE)
        val encodedBytes = enc.encode(pcmSamples, offset, length, outputBuffer, 0, outputBuffer.size)
        return if (encodedBytes > 0) {
            outputBuffer.copyOf(encodedBytes)
        } else {
            null
        }
    }

    fun decode(opusData: ByteArray, opusOffset: Int = 0, opusLength: Int = opusData.size): ShortArray? {
        val dec = decoder ?: return null
        val pcmBuffer = ShortArray(frameSize * channels)
        val decodedSamples = dec.decode(opusData, opusOffset, opusLength, pcmBuffer, 0, frameSize, false)
        return if (decodedSamples > 0) {
            pcmBuffer.copyOf(decodedSamples * channels)
        } else {
            null
        }
    }

    fun decodePLC(): ShortArray? {
        val dec = decoder ?: return null
        val pcmBuffer = ShortArray(frameSize * channels)
        val decodedSamples = dec.decode(null, 0, 0, pcmBuffer, 0, frameSize, true)
        return if (decodedSamples > 0) {
            pcmBuffer.copyOf(decodedSamples * channels)
        } else {
            null
        }
    }

    fun releaseEncoder() {
        encoder = null
    }

    fun releaseDecoder() {
        decoder = null
    }

    fun release() {
        encoder = null
        decoder = null
    }
}
