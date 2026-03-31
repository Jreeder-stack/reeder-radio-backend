package com.reedersystems.commandcomms.audio.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.*

private const val TAG = "[AudioPlay]"
private const val SAMPLE_RATE = 48000
private const val FRAME_INTERVAL_MS = 20L
private const val DEFAULT_SOFTWARE_GAIN = 3.5f
private const val IDLE_TIMEOUT_MS = 200L
private const val WAIT_WINDOW_MS = 20L

class AudioPlayback(
    private val jitterBuffer: JitterBuffer,
    private val opusCodec: OpusCodec
) {

    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var softwareGain: Float = DEFAULT_SOFTWARE_GAIN

    private fun applyGain(pcmBytes: ByteArray): ByteArray {
        if (softwareGain == 1.0f) return pcmBytes
        val buf = java.nio.ByteBuffer.wrap(pcmBytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val shortBuf = buf.asShortBuffer()
        for (i in 0 until shortBuf.limit()) {
            val amplified = (shortBuf[i] * softwareGain).toInt()
            shortBuf.put(i, amplified.coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
        }
        return pcmBytes
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
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
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
            var lastDataTimeMs = System.currentTimeMillis()
            var missWaitStartMs = 0L
            var plcCount = 0

            while (isActive) {
                if (!jitterBuffer.isPlaybackActive) {
                    if (!jitterBuffer.tryStartPlayback()) {
                        delay(FRAME_INTERVAL_MS)

                        if (!jitterBuffer.isEmpty) {
                            lastDataTimeMs = System.currentTimeMillis()
                        }
                        continue
                    }
                    lastDataTimeMs = System.currentTimeMillis()
                    missWaitStartMs = 0L
                }

                val expectedSeq = jitterBuffer.getExpectedSeq()
                if (expectedSeq < 0) {
                    delay(FRAME_INTERVAL_MS)
                    continue
                }

                if (jitterBuffer.hasPacket(expectedSeq)) {
                    val data = jitterBuffer.take(expectedSeq)
                    jitterBuffer.advancePlaybackSeq()
                    missWaitStartMs = 0L
                    lastDataTimeMs = System.currentTimeMillis()

                    if (data != null) {
                        val pcm = opusCodec.decode(data)
                        if (pcm != null && pcm.isNotEmpty()) {
                            Log.d(TAG, "OPUS_RX_FRAME_DECODED bytes=${data.size} pcm=${pcm.size}")
                            Log.d(TAG, "RADIO_OPUS_RX_FRAME_DECODED bytes=${data.size} pcm=${pcm.size}")
                            applyGain(pcm)
                            track.write(pcm, 0, pcm.size)
                        }
                    }
                } else {
                    val now = System.currentTimeMillis()

                    if (missWaitStartMs == 0L) {
                        missWaitStartMs = now
                    }

                    val waited = now - missWaitStartMs

                    if (waited < WAIT_WINDOW_MS) {
                        delay(FRAME_INTERVAL_MS)
                    } else {
                        plcCount++
                        val pcm = opusCodec.decode(null)
                        if (pcm != null && pcm.isNotEmpty()) {
                            applyGain(pcm)
                            track.write(pcm, 0, pcm.size)
                            if (plcCount % 10 == 1) {
                                Log.d(TAG, "PLC frame for seq=$expectedSeq (total=$plcCount)")
                            }
                        } else {
                            delay(FRAME_INTERVAL_MS)
                        }

                        jitterBuffer.advancePlaybackSeq()
                        missWaitStartMs = 0L

                        if (jitterBuffer.isEmpty) {
                            val silenceMs = now - lastDataTimeMs
                            if (silenceMs >= IDLE_TIMEOUT_MS) {
                                jitterBuffer.enterIdle()
                                lastDataTimeMs = now
                                Log.d(TAG, "Idle — buffer empty for ${IDLE_TIMEOUT_MS}ms, reset pre-buffer")
                            }
                        }
                    }
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
