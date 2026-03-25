package com.reedersystems.commandcomms.audio.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.*

private const val TAG = "[AudioPlay]"
private const val SAMPLE_RATE = 48000
private const val PLAYBACK_INTERVAL_MS = 20L
private const val DEFAULT_SOFTWARE_GAIN = 3.5f

class AudioPlayback(
    private val jitterBuffer: JitterBuffer,
    private val opusCodec: OpusCodec
) {

    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var softwareGain: Float = DEFAULT_SOFTWARE_GAIN

    private fun applyGain(pcm: ShortArray): ShortArray {
        if (softwareGain == 1.0f) return pcm
        for (i in pcm.indices) {
            val amplified = (pcm[i] * softwareGain).toInt()
            pcm[i] = amplified.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }
        return pcm
    }

    fun start() {
        if (audioTrack != null) return

        val channelConfig = AudioFormat.CHANNEL_OUT_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufferSize = AudioTrack.getMinBufferSize(SAMPLE_RATE, channelConfig, audioFormat)
        val bufferSize = maxOf(minBufferSize, OpusCodec.FRAME_SIZE * 2 * 4)

        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setSampleRate(SAMPLE_RATE)
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

        track.play()
        audioTrack = track
        Log.d(TAG, "AudioPlayback started: ${SAMPLE_RATE}Hz mono, low-latency")

        playbackJob = scope.launch {
            while (isActive) {
                val packet = jitterBuffer.dequeue()
                if (packet != null) {
                    val pcm = opusCodec.decode(packet)
                    if (pcm != null && pcm.isNotEmpty()) {
                        applyGain(pcm)
                        track.write(pcm, 0, pcm.size)
                    }
                } else {
                    delay(PLAYBACK_INTERVAL_MS)
                }
            }
        }
    }

    fun stop() {
        playbackJob?.cancel()
        playbackJob = null
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
        Log.d(TAG, "AudioPlayback stopped")
    }

    fun release() {
        stop()
        scope.cancel()
    }
}
