/**
 * AudioPlayback — Plays decoded PCM audio via Android AudioTrack.
 *
 * Module boundary: This module handles audio output only. It accepts decoded PCM frames
 * from the JitterBuffer/OpusCodec pipeline and plays them with low-latency settings.
 * It does not interact with the network, codec, or signaling layers directly.
 *
 * Configuration: Voice communication usage, 16 kHz mono, 16-bit PCM, low-latency mode.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log

private const val TAG = "[RadioPlayback]"

class AudioPlayback(
    private val sampleRate: Int = OpusCodec.SAMPLE_RATE,
    private val frameSizeSamples: Int = OpusCodec.FRAME_SIZE
) {
    private var audioTrack: AudioTrack? = null

    fun start() {
        if (audioTrack != null) return

        val channelConfig = AudioFormat.CHANNEL_OUT_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufferSize = AudioTrack.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val bufferSize = maxOf(minBufferSize, frameSizeSamples * 2 * 4)

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(sampleRate)
                    .setChannelMask(channelConfig)
                    .setEncoding(audioFormat)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .build()

        if (track.state != AudioTrack.STATE_INITIALIZED) {
            Log.e(TAG, "AudioTrack failed to initialize")
            track.release()
            return
        }

        audioTrack = track
        track.play()
        Log.d(TAG, "AudioPlayback started: ${sampleRate}Hz mono, low-latency")
    }

    fun writePcm(pcmSamples: ShortArray) {
        val track = audioTrack ?: return
        track.write(pcmSamples, 0, pcmSamples.size)
    }

    fun stop() {
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
        Log.d(TAG, "AudioPlayback stopped")
    }
}
