package com.reedersystems.commandcomms.audio.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.*

private const val TAG = "[AudioPlay]"
private const val SAMPLE_RATE = 48000
private const val FRAME_INTERVAL_MS = 20L
private const val DEFAULT_SOFTWARE_GAIN = 2.5f
private const val IDLE_TIMEOUT_MS = 500L
private const val WAIT_WINDOW_MS = 20L

class AudioPlayback(
    private val jitterBuffer: JitterBuffer,
    private val opusCodec: OpusCodec
) {

    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var softwareGain: Float = DEFAULT_SOFTWARE_GAIN
    @Volatile
    private var firstRxDecodeLogged = false
    @Volatile
    private var firstPlaybackWriteLogged = false

    private var rxHpPrevOutput: Double = 0.0
    private var rxHpPrevInput: Double = 0.0
    var rxHpAlpha: Double = 0.9673

    var rxLpB0: Double = 0.06050
    var rxLpB1: Double = 0.12100
    var rxLpB2: Double = 0.06050
    var rxLpA1: Double = -1.19388
    var rxLpA2: Double = 0.43585
    private var rxLpX1: Double = 0.0
    private var rxLpX2: Double = 0.0
    private var rxLpY1: Double = 0.0
    private var rxLpY2: Double = 0.0

    var rxGateThresholdDb: Double = -40.0
    private val gateAttackCoeff: Double get() = 1.0 - Math.exp(-1.0 / (SAMPLE_RATE * 0.001))
    private val gateReleaseCoeff: Double get() = 1.0 - Math.exp(-1.0 / (SAMPLE_RATE * 0.05))
    private var gateEnvelopeDb: Double = -90.0
    private var gateAttenuation: Double = 0.0

    private fun resetRxDspState() {
        rxHpPrevOutput = 0.0
        rxHpPrevInput = 0.0
        rxLpX1 = 0.0; rxLpX2 = 0.0; rxLpY1 = 0.0; rxLpY2 = 0.0
        gateEnvelopeDb = -90.0
        gateAttenuation = 0.0
    }

    private fun rxHighPassFilter(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var prevOut = rxHpPrevOutput
        var prevIn = rxHpPrevInput
        for (i in 0 until sampleCount) {
            val x = buf.getShort(i * 2).toDouble()
            val y = rxHpAlpha * (prevOut + x - prevIn)
            prevIn = x
            prevOut = y
            buf.putShort(i * 2, y.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        rxHpPrevOutput = prevOut
        rxHpPrevInput = prevIn
    }

    private fun rxLowPassFilter(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var x1 = rxLpX1; var x2 = rxLpX2
        var y1 = rxLpY1; var y2 = rxLpY2
        for (i in 0 until sampleCount) {
            val x0 = buf.getShort(i * 2).toDouble()
            val y0 = rxLpB0 * x0 + rxLpB1 * x1 + rxLpB2 * x2 - rxLpA1 * y1 - rxLpA2 * y2
            x2 = x1; x1 = x0
            y2 = y1; y1 = y0
            buf.putShort(i * 2, y0.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        rxLpX1 = x1; rxLpX2 = x2
        rxLpY1 = y1; rxLpY2 = y2
    }

    private fun rxNoiseGate(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var envelope = gateEnvelopeDb
        var atten = gateAttenuation
        for (i in 0 until sampleCount) {
            val sample = buf.getShort(i * 2).toDouble()
            val absSample = Math.abs(sample) + 1e-10
            val inputDb = 20.0 * Math.log10(absSample / 32768.0)

            val coeff = if (inputDb > envelope) gateAttackCoeff else gateReleaseCoeff
            envelope += coeff * (inputDb - envelope)

            val targetAtten = if (envelope < rxGateThresholdDb) 0.0 else 1.0
            val smoothCoeff = if (targetAtten > atten) gateAttackCoeff else gateReleaseCoeff
            atten += smoothCoeff * (targetAtten - atten)

            val output = sample * atten
            buf.putShort(i * 2, output.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        gateEnvelopeDb = envelope
        gateAttenuation = atten
    }

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

    private fun applyRxDspChain(pcmBytes: ByteArray) {
        val length = pcmBytes.size
        rxHighPassFilter(pcmBytes, length)
        rxLowPassFilter(pcmBytes, length)
        rxNoiseGate(pcmBytes, length)
    }

    fun ensureTrackReady() {
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

        audioTrack = track
        Log.d(TAG, "LATENCY_AUDIOTRACK_WARM_IDLE AudioTrack pre-initialized: ${SAMPLE_RATE}Hz mono, low-latency")
    }

    fun clearStaleFrames() {
        val track = audioTrack ?: return
        try {
            if (track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                track.pause()
                track.flush()
                track.play()
            } else {
                track.flush()
            }
            firstRxDecodeLogged = false
            firstPlaybackWriteLogged = false
            resetRxDspState()
            Log.d(TAG, "RECONNECT_AUDIOTRACK_FLUSHED stale playback data cleared")
        } catch (e: Exception) {
            Log.w(TAG, "RECONNECT_AUDIOTRACK_FLUSH_FAILED: ${e.message}")
        }
    }

    fun start() {
        ensureTrackReady()
        val track = audioTrack ?: return

        if (playbackJob != null) return

        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) {
            track.play()
        }
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
                        try {
                            val pcm = opusCodec.decode(data)
                            if (pcm != null && pcm.isNotEmpty()) {
                                if (!firstRxDecodeLogged) {
                                    Log.d(TAG, "LATENCY_FIRST_RX_FRAME_DECODED seq=$expectedSeq bytes=${data.size} pcm=${pcm.size}")
                                    firstRxDecodeLogged = true
                                }
                                if (!firstPlaybackWriteLogged) {
                                    Log.d(TAG, "LATENCY_FIRST_PLAYBACK_WRITE seq=$expectedSeq pcm=${pcm.size}")
                                    firstPlaybackWriteLogged = true
                                }
                                Log.d(TAG, "OPUS_RX_FRAME_DECODED bytes=${data.size} pcm=${pcm.size}")
                                Log.d(TAG, "RADIO_OPUS_RX_FRAME_DECODED bytes=${data.size} pcm=${pcm.size}")
                                applyRxDspChain(pcm)
                                applyGain(pcm)
                                try {
                                    track.write(pcm, 0, pcm.size)
                                } catch (e: Exception) {
                                    Log.e(TAG, "AudioTrack write error (continuing): ${e.message}")
                                }
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "Opus decode error seq=$expectedSeq (falling through to PLC): ${e.message}")
                            try {
                                val plcPcm = opusCodec.decode(null)
                                if (plcPcm != null && plcPcm.isNotEmpty()) {
                                    applyRxDspChain(plcPcm)
                                    applyGain(plcPcm)
                                    try {
                                        track.write(plcPcm, 0, plcPcm.size)
                                    } catch (writeEx: Exception) {
                                        Log.e(TAG, "AudioTrack write error in PLC fallback (continuing): ${writeEx.message}")
                                    }
                                }
                            } catch (plcEx: Exception) {
                                Log.e(TAG, "PLC fallback also failed: ${plcEx.message}")
                            }
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
                        try {
                            val pcm = opusCodec.decode(null)
                            if (pcm != null && pcm.isNotEmpty()) {
                                applyRxDspChain(pcm)
                                applyGain(pcm)
                                try {
                                    track.write(pcm, 0, pcm.size)
                                } catch (e: Exception) {
                                    Log.e(TAG, "AudioTrack write error in PLC path (continuing): ${e.message}")
                                }
                                if (plcCount % 10 == 1) {
                                    Log.d(TAG, "PLC frame for seq=$expectedSeq (total=$plcCount)")
                                }
                            } else {
                                delay(FRAME_INTERVAL_MS)
                            }
                        } catch (e: Exception) {
                            Log.e(TAG, "PLC decode error (continuing): ${e.message}")
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
        Log.d(TAG, "AudioPlayback playback loop stopped (track kept warm)")
    }

    fun release() {
        playbackJob?.cancel()
        playbackJob = null
        audioTrack?.stop()
        audioTrack?.release()
        audioTrack = null
        scope.cancel()
        Log.d(TAG, "AudioPlayback released")
    }
}
