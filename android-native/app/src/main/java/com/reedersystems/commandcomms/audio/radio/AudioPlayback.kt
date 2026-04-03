package com.reedersystems.commandcomms.audio.radio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.*

private const val TAG = "[AudioPlay]"
private const val SAMPLE_RATE = 48000
private const val FRAME_INTERVAL_MS = 20L
private const val FRAME_INTERVAL_NS = FRAME_INTERVAL_MS * 1_000_000L
private const val DEFAULT_SOFTWARE_GAIN = 2.5f
private const val IDLE_TIMEOUT_MS = 500L
private const val WAIT_WINDOW_MS = 5L
private const val MAX_CATCHUP_FRAMES = 2
private const val SOFT_CLIP_THRESHOLD = 0.8

class AudioPlayback(
    private val jitterBuffer: JitterBuffer,
    private val opusCodec: OpusCodec
) {

    private var audioTrack: AudioTrack? = null
    private var playbackJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var softwareGain: Float = DEFAULT_SOFTWARE_GAIN
    var onFrameDecoded: (() -> Unit)? = null
    var onUnderrun: (() -> Unit)? = null
    var onDecodeFailure: (() -> Unit)? = null
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

    var rxGateThresholdDb: Double = -50.0
    private val gateAttackCoeff: Double get() = 1.0 - Math.exp(-1.0 / (SAMPLE_RATE * 0.001))
    private val gateReleaseCoeff: Double get() = 1.0 - Math.exp(-1.0 / (SAMPLE_RATE * 0.15))
    private var gateEnvelopeDb: Double = -90.0
    private var gateAttenuation: Double = 0.0

    private val writeRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)
    private var summaryWriteBytes: Long = 0

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
            val normalized = shortBuf[i].toDouble() / 32768.0
            val amplified = normalized * softwareGain
            val clipped = if (amplified > SOFT_CLIP_THRESHOLD || amplified < -SOFT_CLIP_THRESHOLD) {
                Math.tanh(amplified)
            } else {
                amplified
            }
            shortBuf.put(i, (clipped * 32768.0).coerceIn(-32768.0, 32767.0).toInt().toShort())
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

        Log.d(TAG, "AUDIOTRACK_INIT rate=$SAMPLE_RATE channelConfig=MONO format=PCM_16BIT minBufSize=$minBufferSize allocBufSize=$bufferSize perfMode=LOW_LATENCY ${RadioDiagLog.elapsedTag()}")

        val track = try {
            AudioTrack.Builder()
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
        } catch (e: Exception) {
            Log.e("[RadioError]", "AudioTrack.Builder threw: ${e::class.simpleName}: ${e.message} rate=$SAMPLE_RATE bufSize=$bufferSize", e)
            return
        }

        if (track.state != AudioTrack.STATE_INITIALIZED) {
            Log.e("[RadioError]", "AudioTrack failed to initialize state=${track.state} rate=$SAMPLE_RATE bufSize=$bufferSize")
            track.release()
            return
        }

        audioTrack = track
        Log.d(TAG, "AUDIOTRACK_READY rate=$SAMPLE_RATE mono low-latency sessionId=${track.audioSessionId} ${RadioDiagLog.elapsedTag()}")
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
            writeRateLimiter.reset()
            summaryWriteBytes = 0
            Log.d(TAG, "RECONNECT_AUDIOTRACK_FLUSHED stale playback data cleared ${RadioDiagLog.elapsedTag()}")
        } catch (e: Exception) {
            Log.w("[RadioError]", "RECONNECT_AUDIOTRACK_FLUSH_FAILED: ${e::class.simpleName}: ${e.message} method=clearStaleFrames")
        }
    }

    fun start() {
        ensureTrackReady()
        val track = audioTrack
        if (track == null) {
            Log.e("[RadioError]", "start() called but audioTrack is null after ensureTrackReady — aborting")
            return
        }

        if (playbackJob != null) {
            Log.w(TAG, "start() called but playbackJob already active — ignoring")
            return
        }

        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) {
            track.play()
        }
        writeRateLimiter.reset()
        summaryWriteBytes = 0
        Log.d(TAG, "AudioPlayback started: ${SAMPLE_RATE}Hz mono, low-latency playState=${track.playState} ${RadioDiagLog.elapsedTag()}")

        playbackJob = scope.launch {
            var lastDataTimeMs = System.currentTimeMillis()
            var missWaitStartMs = 0L
            var plcCount = 0
            var nextFrameTimeNs = System.nanoTime()
            var catchupCount = 0
            try {
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
                        nextFrameTimeNs = System.nanoTime()
                        catchupCount = 0
                    }

                    val nowNs = System.nanoTime()
                    val sleepNs = nextFrameTimeNs - nowNs
                    if (sleepNs > 1_000_000L) {
                        delay(sleepNs / 1_000_000L)
                        catchupCount = 0
                    }

                    val expectedSeq = jitterBuffer.getExpectedSeq()
                    if (expectedSeq < 0) {
                        delay(FRAME_INTERVAL_MS)
                        nextFrameTimeNs = System.nanoTime() + FRAME_INTERVAL_NS
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
                                    onFrameDecoded?.invoke()
                                    if (!firstRxDecodeLogged) {
                                        Log.d(TAG, "LATENCY_FIRST_RX_FRAME_DECODED seq=$expectedSeq opusBytes=${data.size} pcmBytes=${pcm.size} ${RadioDiagLog.elapsedTag()}")
                                        firstRxDecodeLogged = true
                                    }
                                    applyRxDspChain(pcm)
                                    applyGain(pcm)

                                    writeRateLimiter.tick()
                                    summaryWriteBytes += pcm.size

                                    if (writeRateLimiter.shouldLogDetail()) {
                                        Log.d(TAG, "WRITE frame=${writeRateLimiter.frameCount} seq=$expectedSeq pcmBytes=${pcm.size} trackState=${track.playState} ${RadioDiagLog.elapsedTag()}")
                                    } else if (writeRateLimiter.shouldLogSummary()) {
                                        val cnt = writeRateLimiter.resetSummaryAccumulator()
                                        val underrunCount = try { track.underrunCount } catch (_: Exception) { -1 }
                                        Log.d(TAG, "WRITE_SUMMARY frames=$cnt totalFrames=${writeRateLimiter.frameCount} totalBytes=$summaryWriteBytes underruns=$underrunCount jbSize=${jitterBuffer.size} ${RadioDiagLog.elapsedTag()}")
                                    }

                                    if (!firstPlaybackWriteLogged) {
                                        Log.d(TAG, "LATENCY_FIRST_PLAYBACK_WRITE seq=$expectedSeq pcm=${pcm.size} ${RadioDiagLog.elapsedTag()}")
                                        firstPlaybackWriteLogged = true
                                    }
                                    try {
                                        track.write(pcm, 0, pcm.size)
                                    } catch (e: Exception) {
                                        Log.e("[RadioError]", "AudioTrack write error: ${e::class.simpleName}: ${e.message} seq=$expectedSeq pcmSize=${pcm.size} method=playbackLoop", e)
                                    }
                                }
                            } catch (e: Exception) {
                                onDecodeFailure?.invoke()
                                Log.e("[RadioError]", "Opus decode error seq=$expectedSeq (falling through to PLC): ${e::class.simpleName}: ${e.message} method=playbackLoop", e)
                                try {
                                    val plcPcm = opusCodec.decode(null)
                                    if (plcPcm != null && plcPcm.isNotEmpty()) {
                                        applyRxDspChain(plcPcm)
                                        applyGain(plcPcm)
                                        try {
                                            track.write(plcPcm, 0, plcPcm.size)
                                        } catch (writeEx: Exception) {
                                            Log.e("[RadioError]", "AudioTrack write error in PLC fallback: ${writeEx::class.simpleName}: ${writeEx.message} method=playbackLoop")
                                        }
                                    }
                                } catch (plcEx: Exception) {
                                    Log.e("[RadioError]", "PLC fallback also failed: ${plcEx::class.simpleName}: ${plcEx.message} method=playbackLoop")
                                }
                            }
                        }

                        nextFrameTimeNs += FRAME_INTERVAL_NS
                        val drift = System.nanoTime() - nextFrameTimeNs
                        if (drift > 0) {
                            catchupCount++
                            if (catchupCount >= MAX_CATCHUP_FRAMES) {
                                nextFrameTimeNs = System.nanoTime()
                                catchupCount = 0
                            }
                        } else {
                            catchupCount = 0
                        }
                    } else {
                        val now = System.currentTimeMillis()

                        if (missWaitStartMs == 0L) {
                            missWaitStartMs = now
                        }

                        val waited = now - missWaitStartMs

                        if (waited < WAIT_WINDOW_MS) {
                            delay(1L)
                        } else {
                            plcCount++
                            jitterBuffer.recordUnderrun()
                            onUnderrun?.invoke()
                            try {
                                val pcm = opusCodec.decode(null)
                                if (pcm != null && pcm.isNotEmpty()) {
                                    applyRxDspChain(pcm)
                                    applyGain(pcm)
                                    try {
                                        track.write(pcm, 0, pcm.size)
                                    } catch (e: Exception) {
                                        Log.e("[RadioError]", "AudioTrack write error in PLC path: ${e::class.simpleName}: ${e.message} method=playbackLoop")
                                    }
                                    if (plcCount % 10 == 1) {
                                        Log.d(TAG, "PLC frame for seq=$expectedSeq (total=$plcCount) jbSize=${jitterBuffer.size} ${RadioDiagLog.elapsedTag()}")
                                    }
                                } else {
                                    delay(FRAME_INTERVAL_MS)
                                }
                            } catch (e: Exception) {
                                Log.e("[RadioError]", "PLC decode error: ${e::class.simpleName}: ${e.message} method=playbackLoop", e)
                                delay(FRAME_INTERVAL_MS)
                            }

                            jitterBuffer.advancePlaybackSeq()
                            missWaitStartMs = 0L

                            nextFrameTimeNs += FRAME_INTERVAL_NS
                            val drift = System.nanoTime() - nextFrameTimeNs
                            if (drift > 0) {
                                catchupCount++
                                if (catchupCount >= MAX_CATCHUP_FRAMES) {
                                    nextFrameTimeNs = System.nanoTime()
                                    catchupCount = 0
                                }
                            } else {
                                catchupCount = 0
                            }

                            if (jitterBuffer.isEmpty) {
                                val silenceMs = now - lastDataTimeMs
                                if (silenceMs >= IDLE_TIMEOUT_MS) {
                                    jitterBuffer.enterIdle()
                                    lastDataTimeMs = now
                                    Log.d(TAG, "Idle — buffer empty for ${IDLE_TIMEOUT_MS}ms, reset pre-buffer plcTotal=$plcCount ${RadioDiagLog.elapsedTag()}")
                                }
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("[RadioError]", "PLAYBACK_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=playbackWriteLoop", e)
            }
        }
    }

    fun stop() {
        playbackJob?.cancel()
        playbackJob = null
        val underrunCount = try { audioTrack?.underrunCount ?: -1 } catch (_: Exception) { -1 }
        Log.d(TAG, "AudioPlayback stopped totalWrites=${writeRateLimiter.frameCount} totalBytes=$summaryWriteBytes underruns=$underrunCount ${RadioDiagLog.elapsedTag()}")
    }

    fun release() {
        playbackJob?.cancel()
        playbackJob = null
        try {
            audioTrack?.stop()
        } catch (e: Exception) {
            Log.e("[RadioError]", "AudioTrack stop threw: ${e::class.simpleName}: ${e.message} method=release")
        }
        try {
            audioTrack?.release()
        } catch (e: Exception) {
            Log.e("[RadioError]", "AudioTrack release threw: ${e::class.simpleName}: ${e.message} method=release")
        }
        audioTrack = null
        scope.cancel()
        Log.d(TAG, "AudioPlayback released ${RadioDiagLog.elapsedTag()}")
    }
}
