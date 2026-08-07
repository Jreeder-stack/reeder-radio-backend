package com.reedersystems.commandcomms.audio.radio

import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import com.reedersystems.commandcomms.BuildConfig
import com.reedersystems.commandcomms.data.prefs.SpeakerBoostPrefs
import kotlinx.coroutines.*

private const val TAG = "[AudioPlay]"
private const val SAMPLE_RATE = 16000
private const val FRAME_INTERVAL_MS = 20L
private const val FRAME_INTERVAL_NS = FRAME_INTERVAL_MS * 1_000_000L
private const val DEFAULT_SOFTWARE_GAIN = 2.5f
private const val WARM_IDLE_TIMEOUT_MS = 500L
private const val IDLE_TIMEOUT_MS = 2000L
private const val WAIT_WINDOW_MS = 5L
private const val WAIT_WINDOW_LOOKAHEAD_MS = 25L
private const val LOOKAHEAD_JITTER_THRESHOLD_MS = 5.0
private const val MAX_CATCHUP_FRAMES = 2
private const val SOFT_CLIP_THRESHOLD = 0.8
private const val MAX_CONSECUTIVE_PLC_BEFORE_FADE = 10
private const val PLC_FADE_FRAMES = 5
private const val POST_LOSS_CROSSFADE_SAMPLES = 80

class AudioPlayback(
    private val jitterBuffer: JitterBuffer,
    private val opusCodec: OpusCodec,
    private val speakerBoostPrefs: SpeakerBoostPrefs? = null
) {

    private var audioTrack: AudioTrack? = null
    private var loudnessEnhancer: LoudnessEnhancer? = null
    private var playbackJob: Job? = null
    val isStarted: Boolean get() = playbackJob != null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    var softwareGain: Float = speakerBoostPrefs?.softwareAmplifier ?: DEFAULT_SOFTWARE_GAIN

    // Track the most recently applied values from SpeakerBoostPrefs so the
    // listener only re-applies the LoudnessEnhancer / software-gain stage when
    // the user actually changes the speaker-boost preference. SharedPreferences
    // change callbacks can fire on any commit (including no-op writes and
    // unrelated keys), and we don't want those to disturb in-flight RX.
    private var lastAppliedReceiveBoostMb: Int = speakerBoostPrefs?.receiveBoostMb ?: -1
    private var lastAppliedSoftwareGain: Float = speakerBoostPrefs?.softwareAmplifier
        ?: DEFAULT_SOFTWARE_GAIN

    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        val prefs = speakerBoostPrefs ?: return@OnSharedPreferenceChangeListener
        when (key) {
            SpeakerBoostPrefs.KEY_RECEIVE_BOOST_MB -> {
                val mb = prefs.receiveBoostMb
                if (mb == lastAppliedReceiveBoostMb) return@OnSharedPreferenceChangeListener
                lastAppliedReceiveBoostMb = mb
                val le = loudnessEnhancer
                if (le != null) {
                    try {
                        le.setTargetGain(mb)
                        Log.d(TAG, "[LOUDNESS] LoudnessEnhancer gain updated mb=$mb")
                    } catch (e: Exception) {
                        Log.w(TAG, "[LOUDNESS-FALLBACK] gain update failed: ${e::class.simpleName}: ${e.message}")
                    }
                }
            }
            SpeakerBoostPrefs.KEY_SOFTWARE_AMPLIFIER -> {
                val newGain = prefs.softwareAmplifier
                if (newGain == lastAppliedSoftwareGain) return@OnSharedPreferenceChangeListener
                lastAppliedSoftwareGain = newGain
                softwareGain = newGain
                Log.d(TAG, "[LOUDNESS] amplifier=${newGain}x")
            }
        }
    }

    init {
        speakerBoostPrefs?.registerOnChange(prefsListener)
    }

    private fun attachLoudnessEnhancer(track: AudioTrack) {
        releaseLoudnessEnhancer()
        val gainMb = speakerBoostPrefs?.receiveBoostMb ?: 0
        try {
            val le = LoudnessEnhancer(track.audioSessionId)
            le.setTargetGain(gainMb)
            le.enabled = true
            loudnessEnhancer = le
            lastAppliedReceiveBoostMb = gainMb
            Log.d(TAG, "[LOUDNESS] LoudnessEnhancer attached sessionId=${track.audioSessionId} gainMb=$gainMb")
        } catch (e: Exception) {
            loudnessEnhancer = null
            Log.w(TAG, "[LOUDNESS-FALLBACK] LoudnessEnhancer attach failed sessionId=${track.audioSessionId}: ${e::class.simpleName}: ${e.message} — using PCM gain only")
        }
    }

    private fun releaseLoudnessEnhancer() {
        val le = loudnessEnhancer ?: return
        try { le.enabled = false } catch (_: Exception) {}
        try { le.release() } catch (_: Exception) {}
        loudnessEnhancer = null
        Log.d(TAG, "[LOUDNESS] LoudnessEnhancer released")
    }
    var onFrameDecoded: (() -> Unit)? = null
    var onUnderrun: (() -> Unit)? = null
    var onDecodeFailure: (() -> Unit)? = null
    var onFecRecovery: (() -> Unit)? = null
    @Volatile
    var rxFecRecoveries: Long = 0
        private set
    @Volatile
    var rxPlcFrames: Long = 0
        private set
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
    private var lastDepthSnapshotMs: Long = 0
    private var rxPlcTotal: Long = 0

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

    private fun applyPostLossFadeIn(pcmBytes: ByteArray) {
        // Short cross-fade-in over the first ~5ms of the first decoded frame
        // following a loss burst, so it doesn't pop against the trailing PLC.
        val buf = java.nio.ByteBuffer.wrap(pcmBytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = pcmBytes.size / 2
        val fadeSamples = minOf(POST_LOSS_CROSSFADE_SAMPLES, sampleCount)
        if (fadeSamples <= 0) return
        for (i in 0 until fadeSamples) {
            val gain = (i + 1).toDouble() / (fadeSamples + 1).toDouble()
            val sample = buf.getShort(i * 2).toDouble() * gain
            buf.putShort(i * 2, sample.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
    }

    private fun applyPlcFade(pcmBytes: ByteArray, fadeFrameIndex: Int) {
        // Linearly attenuate this PLC frame so a sustained outage cleanly
        // fades to silence instead of producing extended robotic noise.
        if (fadeFrameIndex <= 0) return
        val gain = (1.0 - (fadeFrameIndex.toDouble() / PLC_FADE_FRAMES.toDouble())).coerceIn(0.0, 1.0)
        if (gain >= 0.999) return
        val buf = java.nio.ByteBuffer.wrap(pcmBytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = pcmBytes.size / 2
        for (i in 0 until sampleCount) {
            val sample = buf.getShort(i * 2).toDouble() * gain
            buf.putShort(i * 2, sample.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
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
        val bufferSize = maxOf(minBufferSize, OpusCodec.DECODER_FRAME_SIZE * 2 * 4)
        val playbackUsage = if (BuildConfig.RADIO_DEVICE_TYPE == "android_phone")
            AudioAttributes.USAGE_MEDIA else AudioAttributes.USAGE_VOICE_COMMUNICATION

        Log.d(TAG, "AUDIOTRACK_INIT rate=$SAMPLE_RATE channelConfig=MONO format=PCM_16BIT minBufSize=$minBufferSize allocBufSize=$bufferSize perfMode=LOW_LATENCY usage=$playbackUsage ${RadioDiagLog.elapsedTag()}")

        val track = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(playbackUsage)
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
        attachLoudnessEnhancer(track)
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
        lastDepthSnapshotMs = System.currentTimeMillis()
        rxPlcTotal = 0
        rxFecRecoveries = 0
        rxPlcFrames = 0

        // Pre-warm the playback HAL: prime the Opus decoder with a PLC frame
        // and write a small chunk of silence so the audio HAL is fully spun up
        // before the first real RX packet arrives. This avoids the multi-second
        // cold-start gap on devices like the T320 where MODE_IN_COMMUNICATION is
        // applied lazily at RX_ENTER.
        try {
            val primed = opusCodec.decode(null)
            if (primed != null && primed.isNotEmpty()) {
                Log.d(TAG, "PLAYBACK_DECODER_PRIMED bytes=${primed.size} ${RadioDiagLog.elapsedTag()}")
            }
            val silentMs = 100
            val silentBytes = (SAMPLE_RATE / 1000) * silentMs * 2
            val silence = ByteArray(silentBytes)
            track.write(silence, 0, silence.size)
            Log.d(TAG, "PLAYBACK_HAL_WARMED silentBytes=$silentBytes ${RadioDiagLog.elapsedTag()}")
        } catch (e: Exception) {
            Log.w("[RadioError]", "PLAYBACK_WARMUP_FAILED: ${e::class.simpleName}: ${e.message}")
        }

        Log.d(TAG, "AudioPlayback started: ${SAMPLE_RATE}Hz mono, low-latency playState=${track.playState} ${RadioDiagLog.elapsedTag()}")

        playbackJob = scope.launch {
            var lastDataTimeMs = System.currentTimeMillis()
            var missWaitStartMs = 0L
            var plcCount = 0
            var consecutivePlc = 0
            var lastWasConcealment = false
            var nextFrameTimeNs = System.nanoTime()
            var catchupCount = 0
            var lastQualityLogMs = System.currentTimeMillis()
            var lastQualityWriteCount = 0L
            var lastQualityFecCount = 0L
            var lastQualityPlcCount = 0L
            try {
                while (isActive) {
                    if (!jitterBuffer.isPlaybackActive) {
                        if (!jitterBuffer.tryStartPlayback()) {
                            delay(FRAME_INTERVAL_MS)

                            val silenceMs = System.currentTimeMillis() - lastDataTimeMs
                            if (silenceMs >= IDLE_TIMEOUT_MS) {
                                if (!jitterBuffer.isEmpty) {
                                    Log.d(TAG, "IDLE_TIMEOUT_FLUSH orphanFrames=${jitterBuffer.size} silenceMs=$silenceMs — flushing stale buffer ${RadioDiagLog.elapsedTag()}")
                                    jitterBuffer.flushAndEnterIdle()
                                } else {
                                    jitterBuffer.enterIdle()
                                }
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
                            val isPcmFallback = data.size > 1 && data[0] == OpusCodec.CODEC_MARKER_PCM
                            try {
                                val pcm = if (isPcmFallback) {
                                    data.copyOfRange(1, data.size)
                                } else {
                                    opusCodec.decode(data)
                                }
                                if (pcm != null && pcm.isNotEmpty()) {
                                    onFrameDecoded?.invoke()
                                    if (!firstRxDecodeLogged) {
                                        Log.d(TAG, "LATENCY_FIRST_RX_FRAME_DECODED seq=$expectedSeq opusBytes=${data.size} pcmBytes=${pcm.size} pcmFallback=$isPcmFallback ${RadioDiagLog.elapsedTag()}")
                                        firstRxDecodeLogged = true
                                    }
                                    applyRxDspChain(pcm)
                                    applyGain(pcm)

                                    if (lastWasConcealment) {
                                        applyPostLossFadeIn(pcm)
                                        lastWasConcealment = false
                                    }
                                    consecutivePlc = 0
                                    jitterBuffer.recordSuccessfulRealFrame()

                                    writeRateLimiter.tick()
                                    summaryWriteBytes += pcm.size

                                    if (writeRateLimiter.shouldLogDetail()) {
                                        Log.d(TAG, "WRITE frame=${writeRateLimiter.frameCount} seq=$expectedSeq pcmBytes=${pcm.size} pcmFallback=$isPcmFallback trackState=${track.playState} ${RadioDiagLog.elapsedTag()}")
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

                        val snapNow = System.currentTimeMillis()
                        if (snapNow - lastDepthSnapshotMs >= 2000) {
                            val underruns = try { track.underrunCount } catch (_: Exception) { -1 }
                            Log.d(TAG, "RX_DEPTH_SNAPSHOT jbSize=${jitterBuffer.size} jbTarget=${jitterBuffer.currentTargetDepth} totalFrames=${writeRateLimiter.frameCount} plcTotal=$rxPlcTotal underruns=$underruns ${RadioDiagLog.elapsedTag()}")
                            lastDepthSnapshotMs = snapNow
                        }
                    } else {
                        val now = System.currentTimeMillis()

                        if (missWaitStartMs == 0L) {
                            missWaitStartMs = now
                        }

                        val waited = now - missWaitStartMs
                        val jitterMs = jitterBuffer.estimatedJitterMsValue
                        val effectiveWaitWindowMs = if (jitterMs >= LOOKAHEAD_JITTER_THRESHOLD_MS) {
                            WAIT_WINDOW_LOOKAHEAD_MS
                        } else {
                            WAIT_WINDOW_MS
                        }

                        if (waited < effectiveWaitWindowMs) {
                            delay(1L)
                        } else {
                            // Try Opus inband FEC recovery using the next packet, if available.
                            val nextPacket = jitterBuffer.peekNextPacket(expectedSeq)
                            val fecCandidate = nextPacket?.takeIf {
                                it.isNotEmpty() && it[0] != OpusCodec.CODEC_MARKER_PCM
                            }
                            val fecPcm = if (fecCandidate != null) {
                                try { opusCodec.decodeFec(fecCandidate) } catch (_: Exception) { null }
                            } else null

                            if (fecPcm != null && fecPcm.isNotEmpty()) {
                                rxFecRecoveries++
                                onFecRecovery?.invoke()
                                applyRxDspChain(fecPcm)
                                applyGain(fecPcm)
                                if (lastWasConcealment) {
                                    applyPostLossFadeIn(fecPcm)
                                }
                                lastWasConcealment = false
                                consecutivePlc = 0
                                jitterBuffer.recordSuccessfulRealFrame()
                                try {
                                    track.write(fecPcm, 0, fecPcm.size)
                                } catch (e: Exception) {
                                    Log.e("[RadioError]", "AudioTrack write error in FEC path: ${e::class.simpleName}: ${e.message} method=playbackLoop")
                                }
                                if (rxFecRecoveries % 25 == 1L) {
                                    Log.d(TAG, "FEC_RECOVERY seq=$expectedSeq totalFec=$rxFecRecoveries jbSize=${jitterBuffer.size} jitterMs=${String.format("%.1f", jitterMs)} ${RadioDiagLog.elapsedTag()}")
                                }
                            } else {
                                plcCount++
                                rxPlcTotal++
                                rxPlcFrames++
                                consecutivePlc++
                                lastWasConcealment = true
                                jitterBuffer.recordUnderrun()
                                onUnderrun?.invoke()
                                try {
                                    val pcm = opusCodec.decode(null)
                                    if (pcm != null && pcm.isNotEmpty()) {
                                        applyRxDspChain(pcm)
                                        applyGain(pcm)
                                        // After many consecutive PLC frames, fade the
                                        // concealment toward silence so a long outage
                                        // doesn't keep producing extended robotic noise.
                                        if (consecutivePlc > MAX_CONSECUTIVE_PLC_BEFORE_FADE) {
                                            val fadeIdx = consecutivePlc - MAX_CONSECUTIVE_PLC_BEFORE_FADE
                                            applyPlcFade(pcm, fadeIdx)
                                        }
                                        try {
                                            track.write(pcm, 0, pcm.size)
                                        } catch (e: Exception) {
                                            Log.e("[RadioError]", "AudioTrack write error in PLC path: ${e::class.simpleName}: ${e.message} method=playbackLoop")
                                        }
                                        if (plcCount % 50 == 1) {
                                            Log.d(TAG, "PLC frame for seq=$expectedSeq (total=$plcCount consec=$consecutivePlc) jbSize=${jitterBuffer.size} ${RadioDiagLog.elapsedTag()}")
                                        }
                                    } else {
                                        delay(FRAME_INTERVAL_MS)
                                    }
                                } catch (e: Exception) {
                                    Log.e("[RadioError]", "PLC decode error: ${e::class.simpleName}: ${e.message} method=playbackLoop", e)
                                    delay(FRAME_INTERVAL_MS)
                                }
                            }

                            jitterBuffer.advancePlaybackSeq()
                            missWaitStartMs = 0L

                            // Periodic RX quality summary (every ~5s of playback).
                            val qNow = System.currentTimeMillis()
                            if (qNow - lastQualityLogMs >= 5000) {
                                val frames = writeRateLimiter.frameCount
                                val deltaWrites = frames - lastQualityWriteCount
                                val deltaFec = rxFecRecoveries - lastQualityFecCount
                                val deltaPlc = rxPlcFrames - lastQualityPlcCount
                                val totalAttempts = deltaWrites + deltaPlc
                                val lossPct = if (totalAttempts > 0) (deltaPlc * 100.0 / totalAttempts) else 0.0
                                Log.d(TAG, "RX_QUALITY winFrames=$totalAttempts lossPct=${String.format("%.1f", lossPct)} fecRecoveries=$deltaFec plcFrames=$deltaPlc jitterMs=${String.format("%.1f", jitterMs)} jbDepth=${jitterBuffer.currentTargetDepth} jbSize=${jitterBuffer.size} totalFec=$rxFecRecoveries totalPlc=$rxPlcFrames ${RadioDiagLog.elapsedTag()}")
                                lastQualityLogMs = qNow
                                lastQualityWriteCount = frames
                                lastQualityFecCount = rxFecRecoveries
                                lastQualityPlcCount = rxPlcFrames
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

                            if (jitterBuffer.isPlaybackActive) {
                                val silenceMs = now - lastDataTimeMs
                                if (silenceMs >= IDLE_TIMEOUT_MS) {
                                    if (!jitterBuffer.isEmpty) {
                                        Log.d(TAG, "IDLE_TIMEOUT_FLUSH_ACTIVE orphanFrames=${jitterBuffer.size} silenceMs=$silenceMs plcTotal=$plcCount — flushing stale buffer ${RadioDiagLog.elapsedTag()}")
                                        jitterBuffer.flushAndEnterIdle()
                                    } else {
                                        jitterBuffer.enterIdle()
                                    }
                                    lastDataTimeMs = now
                                    Log.d(TAG, "Idle — no new data for ${IDLE_TIMEOUT_MS}ms, reset pre-buffer plcTotal=$plcCount ${RadioDiagLog.elapsedTag()}")
                                } else if (jitterBuffer.isEmpty && silenceMs >= WARM_IDLE_TIMEOUT_MS) {
                                    jitterBuffer.enterWarmIdle()
                                    Log.d(TAG, "WarmIdle — buffer empty for ${WARM_IDLE_TIMEOUT_MS}ms, minimal pre-buffer plcTotal=$plcCount ${RadioDiagLog.elapsedTag()}")
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
        Log.d(TAG, "RX_SESSION_END totalWrites=${writeRateLimiter.frameCount} totalBytes=$summaryWriteBytes plcTotal=$rxPlcTotal fecRecoveries=$rxFecRecoveries underruns=$underrunCount jbDepth=${jitterBuffer.currentTargetDepth} jbSize=${jitterBuffer.size} ${RadioDiagLog.elapsedTag()}")
    }

    fun release() {
        playbackJob?.cancel()
        playbackJob = null
        releaseLoudnessEnhancer()
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
        try { speakerBoostPrefs?.unregisterOnChange(prefsListener) } catch (_: Exception) {}
        scope.cancel()
        Log.d(TAG, "AudioPlayback released ${RadioDiagLog.elapsedTag()}")
    }
}
