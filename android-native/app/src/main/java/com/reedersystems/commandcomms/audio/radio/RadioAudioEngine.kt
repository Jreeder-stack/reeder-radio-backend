package com.reedersystems.commandcomms.audio.radio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AutomaticGainControl
import android.os.Build
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

private const val TAG = "[RadioEngine]"
private const val DEFAULT_MIC_SAMPLE_RATE = 16000
private const val CAPTURE_INTERVAL_MS = 20L
private const val RX_DIAG_INTERVAL_MS = 5_000L
private const val PRE_BUFFER_MAX_FRAMES = 150
private const val TRANSMIT_MUTEX_TIMEOUT_MS = 3_000L
private const val CAPTURE_JOIN_TIMEOUT_MS = 500L

class RadioAudioEngine(private val context: Context) {

    var stateManager = RadioStateManager()
        private set
    val opusCodec = OpusCodec()
    val jitterBuffer = JitterBuffer()
    val audioPlayback = AudioPlayback(jitterBuffer, opusCodec)
    val udpTransport = UdpAudioTransport()

    var floorControl: FloorControlManager? = null
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null
    private val transmitMutex = Mutex()

    private var audioRecord: AudioRecord? = null
    private var autoGainControl: AutomaticGainControl? = null
    private var captureJob: Job? = null
    private var encodeJob: Job? = null
    private var encodeQueue: LinkedBlockingQueue<ByteArray>? = null
    private var rxDiagJob: Job? = null
    @Volatile
    private var isTransmitting = false
    @Volatile
    private var pendingCodecReset = false
    @Volatile
    private var pendingDspReset = false
    @Volatile
    private var started = false
    @Volatile
    var isPreCapturing = false
        private set
    @Volatile
    private var preCapturingToBuffer = false
    @Volatile
    private var preCaptureAborted = false
    private val preBuffer = ArrayDeque<ByteArray>()
    private val preBufferLock = Any()
    @Volatile
    private var lastDiagRxCount: Long = 0

    private var actualSampleRate: Int = DEFAULT_MIC_SAMPLE_RATE
    private var actualChannelCount: Int = 1
    private var actualFrameSizeSamples: Int = (DEFAULT_MIC_SAMPLE_RATE * CAPTURE_INTERVAL_MS.toInt()) / 1000
    private var actualFrameSizeBytes: Int = actualFrameSizeSamples * 2

    private val txSessionStats = RadioDiagLog.TxSessionStats()
    private val rxSessionStats = RadioDiagLog.RxSessionStats()
    private val pcmReadRateLimiter = RadioDiagLog.RateLimiter(detailCount = 10)
    private val dspRateLimiter = RadioDiagLog.RateLimiter(detailCount = 3)
    private var txSessionStartPacketCount: Long = 0

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT -> {
                Log.d(TAG, "Audio focus gained")
            }
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                Log.w(TAG, "Audio focus lost focusChange=$focusChange ${RadioDiagLog.elapsedTag()}")
            }
            else -> {}
        }
    }

    var onDisconnected: (() -> Unit)? = null
    var onTxStall: ((reason: String) -> Unit)? = null

    @Volatile
    private var lastSuccessfulSendMs: Long = 0L
    private var txHeartbeatJob: Job? = null
    companion object {
        const val TX_HEARTBEAT_CHECK_INTERVAL_MS = 500L
        const val TX_STALL_THRESHOLD_MS = 1000L
        private const val PROBE_SILENCE_RMS_THRESHOLD = 2.0
        private const val PROBE_FRAME_COUNT = 10
        private const val PROBE_RATE = DEFAULT_MIC_SAMPLE_RATE

        @Volatile
        var bypassSourceCache: Boolean = false

        @Volatile
        private var cachedSourceKey: String? = null
        @Volatile
        private var cachedSourceValue: Int? = null
        @Volatile
        private var cachedSourceName: String? = null
    }

    val isConnected: Boolean get() = started

    private suspend fun acquireTransmitMutex(caller: String): Boolean {
        val acquireStart = System.currentTimeMillis()
        val acquired = withTimeoutOrNull(TRANSMIT_MUTEX_TIMEOUT_MS) { transmitMutex.lock(); true }
        if (acquired != null) {
            val lockAcquiredMs = System.currentTimeMillis() - acquireStart
            if (lockAcquiredMs > 100) {
                Log.w(TAG, """{"event":"MUTEX_SLOW_ACQUIRE","caller":"$caller","acquireMs":$lockAcquiredMs}""")
            }
            return true
        }
        val waitMs = System.currentTimeMillis() - acquireStart
        Log.e(TAG, """{"event":"MUTEX_TIMEOUT","caller":"$caller","waitMs":$waitMs,"timeoutMs":$TRANSMIT_MUTEX_TIMEOUT_MS}""")
        forceResetTransmitState(caller)
        val retryAcquired = withTimeoutOrNull(TRANSMIT_MUTEX_TIMEOUT_MS) { transmitMutex.lock(); true }
        if (retryAcquired != null) {
            Log.d(TAG, """{"event":"MUTEX_RETRY_SUCCESS","caller":"$caller"}""")
            return true
        }
        Log.e(TAG, """{"event":"MUTEX_ACQUIRE_FAILED","caller":"$caller"}""")
        return false
    }

    private fun forceResetTransmitState(reason: String) {
        Log.e(TAG, """{"event":"FORCE_RESET_TRANSMIT_STATE","reason":"$reason"}""")
        captureJob?.cancel()
        captureJob = null
        encodeJob?.cancel()
        encodeJob = null
        encodeQueue = null
        isTransmitting = false
        stopTxHeartbeatMonitor()
        isPreCapturing = false
        synchronized(preBufferLock) {
            preCapturingToBuffer = false
            preBuffer.clear()
        }
        try { autoGainControl?.release() } catch (_: Exception) {}
        autoGainControl = null
        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
        resetDspState()
        stateManager.txPipelineRunning = false
        stateManager.transitionTo(RadioState.IDLE, "force_reset:$reason")
        Log.e(TAG, """{"event":"FORCE_RESET_COMPLETE","reason":"$reason"}""")
    }

    fun useSharedStateManager(shared: RadioStateManager) {
        stateManager = shared
    }

    fun wireFloorControl(gateway: RadioSignalingGateway) {
        floorControl = FloorControlManager(gateway, stateManager)
    }

    fun start() {
        if (started) {
            Log.w("[RadioError]", "start() called but engine already started — ignoring")
            return
        }
        opusCodec.initialize()
        acquireAudioFocus()
        audioPlayback.ensureTrackReady()
        udpTransport.onPacketReceived = { packet -> onAudioPacketReceived(packet) }
        udpTransport.start()
        started = true
        RadioDiagLog.resetSessionClock()
        Log.d(TAG, "RadioAudioEngine started ${RadioDiagLog.elapsedTag()}")
    }

    fun stop() {
        if (!started) {
            Log.w("[RadioError]", "stop() called but engine not started — ignoring")
            return
        }
        runBlocking {
            if (isPreCapturing) stopPreCapture()
            stopTransmit()
        }
        stopReceive()
        udpTransport.stop()
        releaseAudioFocus()
        opusCodec.release()
        started = false
        stateManager.reset()
        Log.d(TAG, "RadioAudioEngine stopped ${RadioDiagLog.elapsedTag()}")
    }

    fun requestCodecReset() {
        if (isTransmitting || isPreCapturing) {
            Log.w(TAG, "CODEC_RESET_DEFERRED — active TX/preCapture, will reset after TX completes")
            pendingCodecReset = true
            return
        }
        performCodecReset()
    }

    private fun performCodecReset() {
        pendingCodecReset = false
        try {
            opusCodec.resetDecoder()
            opusCodec.resetEncoder()
            Log.d(TAG, "CODEC_RESET_PERFORMED decoder+encoder reset ${RadioDiagLog.elapsedTag()}")
        } catch (e: Exception) {
            Log.e("[RadioError]", "CODEC_RESET_FAILED: ${e::class.simpleName}: ${e.message}", e)
        }
    }

    private val OPUS_SUPPORTED_RATES = setOf(8000, 12000, 16000, 24000, 48000)

    private data class SourceProbeResult(
        val source: Int,
        val sourceName: String,
        val avgRms: Double,
        val minSample: Int,
        val maxSample: Int,
        val accepted: Boolean,
        val reason: String
    )

    private fun probeAudioSource(source: Int, sourceName: String): SourceProbeResult {
        val rate = PROBE_RATE
        try {
            val testMinBuf = AudioRecord.getMinBufferSize(
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            if (testMinBuf <= 0) {
                val reason = "init_failed_bad_buffer_size"
                Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason minBuf=$testMinBuf")
                return SourceProbeResult(source, sourceName, 0.0, 0, 0, false, reason)
            }
            val testRecord = AudioRecord(
                source,
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                testMinBuf
            )
            try {
                if (testRecord.state != AudioRecord.STATE_INITIALIZED) {
                    val reason = "init_failed_not_initialized"
                    Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason")
                    return SourceProbeResult(source, sourceName, 0.0, 0, 0, false, reason)
                }

                try {
                    testRecord.startRecording()
                } catch (e: Exception) {
                    val reason = "start_recording_failed"
                    Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason err=${e.message}")
                    return SourceProbeResult(source, sourceName, 0.0, 0, 0, false, reason)
                }

                val frameSizeSamples = (rate * CAPTURE_INTERVAL_MS.toInt()) / 1000
                val frameSizeBytes = frameSizeSamples * 2
                val readBuf = ByteArray(frameSizeBytes)
                var totalRms = 0.0
                var globalMin = Short.MAX_VALUE.toInt()
                var globalMax = Short.MIN_VALUE.toInt()
                var validFrames = 0

                for (i in 0 until PROBE_FRAME_COUNT) {
                    val bytesRead = testRecord.read(readBuf, 0, frameSizeBytes)
                    if (bytesRead > 0) {
                        val stats = RadioDiagLog.pcmStats(readBuf, bytesRead)
                        totalRms += stats.rms
                        if (stats.min < globalMin) globalMin = stats.min
                        if (stats.max > globalMax) globalMax = stats.max
                        validFrames++
                        Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeFrame=$i $stats")
                    } else {
                        Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeFrame=$i readRet=$bytesRead")
                    }
                }

                if (validFrames == 0) {
                    val reason = "read_failed_no_valid_frames"
                    Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason")
                    return SourceProbeResult(source, sourceName, 0.0, 0, 0, false, reason)
                }

                val avgRms = totalRms / validFrames
                val accepted = avgRms >= PROBE_SILENCE_RMS_THRESHOLD
                val reason = if (accepted) "rms_above_threshold" else "rms_too_low"
                Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=${if (accepted) "OK" else "REJECT"} avgRms=${String.format("%.1f", avgRms)} min=$globalMin max=$globalMax validFrames=$validFrames reason=$reason threshold=$PROBE_SILENCE_RMS_THRESHOLD")
                return SourceProbeResult(source, sourceName, avgRms, globalMin, globalMax, accepted, reason)

            } finally {
                try { testRecord.stop() } catch (_: Exception) {}
                try { testRecord.release() } catch (_: Exception) {}
            }

        } catch (e: Exception) {
            val reason = "exception"
            Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason err=${e.message}")
            return SourceProbeResult(source, sourceName, 0.0, 0, 0, false, reason)
        }
    }

    private fun isKnownGoodDevice(): Boolean {
        val model = Build.MODEL?.uppercase() ?: ""
        val manufacturer = Build.MANUFACTURER?.uppercase() ?: ""
        return (manufacturer == "ZRK" && model == "T320")
    }

    private fun selectAudioSource(): Int? {
        val deviceKey = "${Build.MANUFACTURER}/${Build.MODEL}/API${Build.VERSION.SDK_INT}"
        if (!bypassSourceCache) {
            val cached = cachedSourceKey
            if (cached != null && cached == deviceKey && cachedSourceValue != null) {
                val src = cachedSourceValue!!
                val name = cachedSourceName ?: "UNKNOWN"
                Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_SELECTED source=$name reason=cached_for_device device=$deviceKey")
                txSessionStats.audioSource = name
                return src
            }
        } else {
            Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_CACHE_BYPASSED device=$deviceKey bypassSourceCache=true")
        }

        if (isKnownGoodDevice()) {
            val source = MediaRecorder.AudioSource.VOICE_COMMUNICATION
            val name = "VOICE_COMMUNICATION"
            Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_SELECTED source=$name reason=known_good_device device=$deviceKey")
            txSessionStats.audioSource = name
            cachedSourceKey = deviceKey
            cachedSourceValue = source
            cachedSourceName = name
            return source
        }

        data class Candidate(val source: Int, val name: String)
        val candidates = mutableListOf(
            Candidate(MediaRecorder.AudioSource.MIC, "MIC"),
            Candidate(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION"),
            Candidate(MediaRecorder.AudioSource.VOICE_COMMUNICATION, "VOICE_COMMUNICATION")
        )
        if (Build.VERSION.SDK_INT >= 24) {
            candidates.add(Candidate(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED"))
        }

        val allCandidateNames = candidates.map { it.name }
        Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE_BEGIN device=$deviceKey candidates=$allCandidateNames")

        val allResults = mutableListOf<SourceProbeResult>()
        for (c in candidates) {
            val result = probeAudioSource(c.source, c.name)
            allResults.add(result)
            if (result.accepted) {
                Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_PROBE_EARLY_EXIT source=${result.sourceName} avgRms=${String.format("%.1f", result.avgRms)} reason=accepted_early device=$deviceKey")
                break
            }
        }
        txSessionStats.probeResults.clear()
        for (r in allResults) {
            txSessionStats.probeResults[r.sourceName] = r.avgRms
        }

        val validResults = allResults.filter { it.accepted }
        val best = validResults.maxByOrNull { it.avgRms }

        if (best != null) {
            Log.d("[AudioCapture]", "TX_AUDIO_SOURCE_SELECTED source=${best.sourceName} avgRms=${String.format("%.1f", best.avgRms)} min=${best.minSample} max=${best.maxSample} reason=best_valid_source device=$deviceKey")
            txSessionStats.audioSource = best.sourceName
            cachedSourceKey = deviceKey
            cachedSourceValue = best.source
            cachedSourceName = best.sourceName
            return best.source
        }

        val readableResults = allResults.filter { it.reason == "rms_too_low" }
        val fallback = readableResults.maxByOrNull { it.avgRms }
        if (fallback != null) {
            Log.w("[AudioCapture]", "TX_AUDIO_SOURCE_FALLBACK source=${fallback.sourceName} avgRms=${String.format("%.1f", fallback.avgRms)} min=${fallback.minSample} max=${fallback.maxSample} reason=below_threshold_fallback device=$deviceKey threshold=$PROBE_SILENCE_RMS_THRESHOLD")
            txSessionStats.audioSource = fallback.sourceName
            cachedSourceKey = deviceKey
            cachedSourceValue = fallback.source
            cachedSourceName = fallback.sourceName
            return fallback.source
        }

        Log.e("[AudioCapture]", "TX_AUDIO_SOURCE_ALL_REJECTED device=$deviceKey threshold=$PROBE_SILENCE_RMS_THRESHOLD probeResults=${txSessionStats.probeResults}")
        txSessionStats.audioSource = "NONE"
        return null
    }

    private fun computeDspCoefficients(sampleRate: Int) {
        val sr = sampleRate.toDouble()

        val hpCutoff = 80.0
        txHpAlpha = 1.0 / (1.0 + (2.0 * Math.PI * hpCutoff / sr))

        val lpCutoff = if (sampleRate <= 16000) 3500.0 else 7500.0
        val omega = 2.0 * Math.PI * lpCutoff / sr
        val sinOmega = Math.sin(omega)
        val cosOmega = Math.cos(omega)
        val alpha = sinOmega / (2.0 * 0.7071)
        val a0 = 1.0 + alpha
        txLpB0 = ((1.0 - cosOmega) / 2.0) / a0
        txLpB1 = (1.0 - cosOmega) / a0
        txLpB2 = ((1.0 - cosOmega) / 2.0) / a0
        txLpA1 = (-2.0 * cosOmega) / a0
        txLpA2 = (1.0 - alpha) / a0

        txCompAttackMs = 0.003
        txCompReleaseMs = 0.15

        Log.d("[AudioDSP]", "TX_DSP_COEFFICIENTS sampleRate=$sampleRate hpCutoff=$hpCutoff hpAlpha=$txHpAlpha lpCutoff=$lpCutoff lpB0=$txLpB0 lpB1=$txLpB1 lpB2=$txLpB2 lpA1=$txLpA1 lpA2=$txLpA2 compThreshold=$txCompThresholdDb compRatio=$txCompRatio compAttack=$txCompAttackMs compRelease=$txCompReleaseMs gain=$txGain ${RadioDiagLog.elapsedTag()}")
    }

    fun abortPreCapture() {
        preCaptureAborted = true
        Log.d(TAG, "PRE_CAPTURE_ABORT_REQUESTED ${RadioDiagLog.elapsedTag()}")
    }

    suspend fun startPreCapture(): Boolean {
        if (!acquireTransmitMutex("startPreCapture")) {
            Log.e(TAG, """{"event":"START_PRE_CAPTURE_ABORTED","reason":"mutex_acquire_failed"}""")
            return false
        }
        try {
        if (!started) {
            Log.w("[RadioError]", "startPreCapture: engine not started method=startPreCapture")
            return false
        }
        if (isTransmitting || isPreCapturing) {
            Log.w("[RadioError]", "startPreCapture: already active isTransmitting=$isTransmitting isPreCapturing=$isPreCapturing method=startPreCapture")
            return isPreCapturing
        }

        preCaptureAborted = false

        try {
            RadioDiagLog.resetSessionClock()
            txSessionStats.reset()
            txSessionStats.startTimeMs = System.currentTimeMillis()
            txSessionStats.requestedRate = DEFAULT_MIC_SAMPLE_RATE
            pcmReadRateLimiter.reset()
            dspRateLimiter.reset()
            opusCodec.resetFailureCounts()
            udpTransport.resetTxDetailLogging()
            txSessionStartPacketCount = udpTransport.txPacketCount
            Log.d(TAG, "PRE_CAPTURE_SESSION_START ${RadioDiagLog.elapsedTag()}")

            val audioSource = selectAudioSource()
            if (audioSource == null) {
                Log.e("[RadioError]", "PRE_CAPTURE_ABORTED reason=all_audio_sources_rejected method=startPreCapture")
                txSessionStats.stopReason = "all_sources_rejected"
                return false
            }

            if (preCaptureAborted) {
                Log.d(TAG, "PRE_CAPTURE_ABORTED_AFTER_PROBE — cancelled during source probing")
                txSessionStats.stopReason = "aborted_during_probe"
                return false
            }

            val minBufferSize = AudioRecord.getMinBufferSize(
                DEFAULT_MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val requestedFrameSizeBytes = (DEFAULT_MIC_SAMPLE_RATE / 1000 * CAPTURE_INTERVAL_MS.toInt()) * 2
            val bufferSize = maxOf(minBufferSize, requestedFrameSizeBytes * 4)

            Log.d("[AudioCapture]", "PRE_CAPTURE_AUDIORECORD_INIT requestedRate=$DEFAULT_MIC_SAMPLE_RATE source=${txSessionStats.audioSource} minBufSize=$minBufferSize allocBufSize=$bufferSize frameMs=$CAPTURE_INTERVAL_MS ${RadioDiagLog.elapsedTag()}")

            val record = try {
                AudioRecord(
                    audioSource,
                    DEFAULT_MIC_SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize
                )
            } catch (e: Exception) {
                Log.e("[RadioError]", "AudioRecord constructor threw: ${e::class.simpleName}: ${e.message} source=${txSessionStats.audioSource} rate=$DEFAULT_MIC_SAMPLE_RATE method=startPreCapture", e)
                txSessionStats.stopReason = "audiorecord_constructor_exception"
                return false
            }
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e("[RadioError]", "AudioRecord failed to initialize state=${record.state} source=${txSessionStats.audioSource} rate=$DEFAULT_MIC_SAMPLE_RATE method=startPreCapture")
                record.release()
                txSessionStats.stopReason = "audiorecord_init_failed"
                return false
            }

            actualSampleRate = record.sampleRate
            actualChannelCount = record.channelCount
            txSessionStats.actualRate = actualSampleRate
            txSessionStats.channels = actualChannelCount

            if (actualSampleRate !in OPUS_SUPPORTED_RATES) {
                Log.e("[RadioError]", "PRE_CAPTURE_UNSUPPORTED_SAMPLE_RATE halRate=$actualSampleRate — not in Opus supported set $OPUS_SUPPORTED_RATES method=startPreCapture")
                record.release()
                txSessionStats.stopReason = "unsupported_sample_rate"
                return false
            }

            actualFrameSizeSamples = (actualSampleRate * CAPTURE_INTERVAL_MS.toInt()) / 1000
            actualFrameSizeBytes = actualFrameSizeSamples * actualChannelCount * 2
            val needsStereoDownmix = actualChannelCount == 2

            if (actualChannelCount > 2) {
                Log.e("[RadioError]", "PRE_CAPTURE_UNEXPECTED_CHANNEL_COUNT channelCount=$actualChannelCount method=startPreCapture")
                record.release()
                txSessionStats.stopReason = "unsupported_channel_count"
                return false
            }

            Log.d("[AudioCapture]", "PRE_CAPTURE_HAL_NEGOTIATED requestedRate=$DEFAULT_MIC_SAMPLE_RATE actualRate=$actualSampleRate actualChannels=$actualChannelCount needsStereoDownmix=$needsStereoDownmix bufferSize=$bufferSize monoFrameSamples=$actualFrameSizeSamples monoFrameBytes=${actualFrameSizeSamples * 2} ${RadioDiagLog.elapsedTag()}")

            if (needsStereoDownmix) {
                Log.w("[AudioCapture]", "PRE_CAPTURE_STEREO_DETECTED HAL returned stereo ($actualChannelCount ch) despite requesting CHANNEL_IN_MONO — will downmix to mono before DSP/Opus encoding")
            }

            if (actualSampleRate != DEFAULT_MIC_SAMPLE_RATE) {
                Log.w("[AudioCapture]", "PRE_CAPTURE_SAMPLE_RATE_MISMATCH requested=$DEFAULT_MIC_SAMPLE_RATE actual=$actualSampleRate — adapting pipeline")
            }

            opusCodec.currentAudioSource = txSessionStats.audioSource
            opusCodec.reinitializeEncoderIfNeeded(actualSampleRate, 1)
            computeDspCoefficients(actualSampleRate)

            record.startRecording()
            audioRecord = record

            val postStartRate = record.sampleRate
            if (postStartRate != actualSampleRate) {
                Log.w("[AudioCapture]", "PRE_CAPTURE_POST_START_RATE_CHANGE preStart=$actualSampleRate postStart=$postStartRate")
                actualSampleRate = postStartRate
                txSessionStats.actualRate = actualSampleRate
                if (actualSampleRate !in OPUS_SUPPORTED_RATES) {
                    Log.e("[RadioError]", "PRE_CAPTURE_UNSUPPORTED_SAMPLE_RATE_POST_START rate=$actualSampleRate method=startPreCapture")
                    record.stop()
                    record.release()
                    audioRecord = null
                    txSessionStats.stopReason = "post_start_unsupported_rate"
                    return false
                }
                actualFrameSizeSamples = (actualSampleRate * CAPTURE_INTERVAL_MS.toInt()) / 1000
                actualFrameSizeBytes = actualFrameSizeSamples * actualChannelCount * 2
                opusCodec.reinitializeEncoderIfNeeded(actualSampleRate, 1)
                computeDspCoefficients(actualSampleRate)
            }

            if (preCaptureAborted) {
                Log.d(TAG, "PRE_CAPTURE_ABORTED_AFTER_SETUP — cleaning up before capture loop")
                record.stop()
                record.release()
                audioRecord = null
                txSessionStats.stopReason = "aborted_during_setup"
                return false
            }

            val monoFrameSizeBytes = actualFrameSizeSamples * 2

            val sessionId = record.audioSessionId
            try {
                if (AutomaticGainControl.isAvailable()) {
                    autoGainControl = AutomaticGainControl.create(sessionId)?.also { it.enabled = false }
                    Log.d("[AudioCapture]", "AGC attached=true enabled=false sessionId=$sessionId ${RadioDiagLog.elapsedTag()}")
                } else {
                    Log.d("[AudioCapture]", "AGC attached=false reason=unavailable ${RadioDiagLog.elapsedTag()}")
                }
            } catch (e: Exception) {
                Log.w("[RadioError]", "AutomaticGainControl unavailable: ${e.message} method=startPreCapture")
            }

            synchronized(preBufferLock) {
                preBuffer.clear()
                preCapturingToBuffer = true
            }
            isPreCapturing = true
            Log.d("[AudioCapture]", "PRE_CAPTURE_STARTED sampleRate=$actualSampleRate channelCount=$actualChannelCount frameMs=$CAPTURE_INTERVAL_MS frameSizeSamples=$actualFrameSizeSamples maxBufferFrames=$PRE_BUFFER_MAX_FRAMES ${RadioDiagLog.elapsedTag()}")

            val captureStartMs = System.currentTimeMillis()
            val queue = LinkedBlockingQueue<ByteArray>(50)
            encodeQueue = queue
            val poisonPill = ByteArray(0)

            encodeJob = scope.launch {
                var frameCounter = 0
                try {
                    while (isActive) {
                        val monoFrame = queue.poll(100, TimeUnit.MILLISECONDS)
                        if (monoFrame == null) {
                            if (!isPreCapturing && !isTransmitting) break
                            continue
                        }
                        if (monoFrame.isEmpty()) break

                        val encoded = opusCodec.encode(monoFrame)
                        if (opusCodec.encoderReinitialized) {
                            opusCodec.encoderReinitialized = false
                            pendingDspReset = true
                            Log.d("[AudioDSP]", "DSP_STATE_RESET_PENDING reason=encoder_reinitialized frame=$frameCounter ${RadioDiagLog.elapsedTag()}")
                        }
                        if (encoded != null) {
                            if (opusCodec.lastEncodeWasPcmFallback) {
                                txSessionStats.pcmFallbackFrames++
                            }
                            frameCounter++
                            txSessionStats.framesEncoded++
                            synchronized(preBufferLock) {
                                if (preCapturingToBuffer) {
                                    if (preBuffer.size >= PRE_BUFFER_MAX_FRAMES) {
                                        preBuffer.removeFirst()
                                    }
                                    preBuffer.addLast(encoded)
                                } else {
                                    txSessionStats.packetsSent++
                                    if (frameCounter == 1) {
                                        val latencyMs = System.currentTimeMillis() - captureStartMs
                                        Log.d(TAG, "LATENCY_FIRST_LIVE_TX_FRAME frame=$frameCounter latencyMs=$latencyMs ${RadioDiagLog.elapsedTag()}")
                                    }
                                    udpTransport.send(encoded)
                                    lastSuccessfulSendMs = System.currentTimeMillis()
                                }
                            }
                        } else {
                            txSessionStats.failures++
                        }
                    }
                } catch (e: Exception) {
                    Log.e("[RadioError]", "PRE_CAPTURE_ENCODE_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=preCaptureEncodeLoop", e)
                }
                Log.d(TAG, "ENCODE_THREAD_EXIT framesEncoded=${txSessionStats.framesEncoded} ${RadioDiagLog.elapsedTag()}")
            }

            captureJob = scope.launch {
                val readBuffer = ByteArray(actualFrameSizeBytes)
                val pendingFrame = ByteArray(actualFrameSizeBytes)
                var pendingBytes = 0
                try {
                    while (isActive && (isPreCapturing || isTransmitting)) {
                        try {
                            val read = record.read(readBuffer, 0, readBuffer.size)
                            if (read > 0) {
                                txSessionStats.framesRead++
                                if (read < readBuffer.size) txSessionStats.partialReads++
                                var readOffset = 0
                                while (readOffset < read) {
                                    val remainingFrameBytes = actualFrameSizeBytes - pendingBytes
                                    val chunkSize = minOf(remainingFrameBytes, read - readOffset)
                                    System.arraycopy(readBuffer, readOffset, pendingFrame, pendingBytes, chunkSize)
                                    pendingBytes += chunkSize
                                    readOffset += chunkSize

                                    if (pendingBytes == actualFrameSizeBytes) {
                                        val monoFrame: ByteArray
                                        if (needsStereoDownmix) {
                                            monoFrame = stereoToMono(pendingFrame, actualFrameSizeBytes)
                                        } else {
                                            monoFrame = pendingFrame.copyOf(monoFrameSizeBytes)
                                        }

                                        pcmReadRateLimiter.tick()
                                        if (pcmReadRateLimiter.shouldLogDetail()) {
                                            val stats = RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes)
                                            if (stats.silent) txSessionStats.silentFrames++
                                            txSessionStats.firstFrameRmsValues.add(stats.rms)
                                            Log.d("[AudioCapture]", "PCM_FRAME frame=${pcmReadRateLimiter.frameCount} readRet=$read $stats downmix=$needsStereoDownmix source=${txSessionStats.audioSource} sampleRate=$actualSampleRate channels=$actualChannelCount ${RadioDiagLog.elapsedTag()}")
                                        } else {
                                            val stats = RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes)
                                            if (stats.silent) txSessionStats.silentFrames++
                                            if (pcmReadRateLimiter.shouldLogSummary()) {
                                                val cnt = pcmReadRateLimiter.resetSummaryAccumulator()
                                                Log.d("[AudioCapture]", "PCM_SUMMARY frames=$cnt totalFrames=${pcmReadRateLimiter.frameCount} silentFrames=${txSessionStats.silentFrames} partials=${txSessionStats.partialReads} zeros=${txSessionStats.zeroReads} ${RadioDiagLog.elapsedTag()}")
                                            }
                                        }

                                        if (pendingDspReset) {
                                            pendingDspReset = false
                                            resetDspState()
                                            Log.d("[AudioDSP]", "DSP_STATE_RESET reason=encoder_reinitialized frame=${pcmReadRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
                                        }

                                        dspRateLimiter.tick()
                                        val preStats = if (dspRateLimiter.shouldLogDetail()) RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes) else null

                                        highPassFilter(monoFrame, monoFrameSizeBytes)
                                        txNoiseGate(monoFrame, monoFrameSizeBytes)
                                        lowPassFilter(monoFrame, monoFrameSizeBytes)
                                        softwareCompressor(monoFrame, monoFrameSizeBytes)
                                        applyGain(monoFrame, monoFrameSizeBytes, txGain)

                                        if (preStats != null) {
                                            val postStats = RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes)
                                            Log.d("[AudioDSP]", "DSP_FRAME frame=${dspRateLimiter.frameCount} pre=[$preStats] post=[$postStats] gate=${if (txGateOpen) "open" else "closed"} gateEnv=${String.format("%.1f", txGateEnvelopeDb)}dB gateThreshold=${txGateThresholdDb}dB ${RadioDiagLog.elapsedTag()}")
                                        }

                                        if (!queue.offer(monoFrame)) {
                                            Log.w("[AudioCapture]", "ENCODE_QUEUE_FULL dropping frame ${pcmReadRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
                                        }
                                        pendingBytes = 0
                                    }
                                }
                            } else if (read < 0) {
                                txSessionStats.failures++
                                Log.w("[RadioError]", "AudioRecord read returned error: $read method=preCaptureLoop ${RadioDiagLog.elapsedTag()}")
                            } else {
                                txSessionStats.zeroReads++
                            }
                        } catch (e: IllegalStateException) {
                            Log.w("[RadioError]", "AudioRecord read failed (released?): ${e.message} method=preCaptureLoop")
                            txSessionStats.stopReason = "audiorecord_released"
                            break
                        } catch (t: Throwable) {
                            txSessionStats.failures++
                            Log.e("[RadioError]", "Pre-capture loop error (continuing): ${t::class.simpleName}: ${t.message} method=preCaptureLoop", t)
                        }
                    }
                } catch (e: Exception) {
                    Log.e("[RadioError]", "PRE_CAPTURE_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=preCaptureLoop", e)
                    txSessionStats.stopReason = "capture_loop_exception"
                }
                queue.offer(poisonPill)
            }
            Log.d(TAG, "Pre-capture started — buffering audio (sampleRate=$actualSampleRate channels=$actualChannelCount buffer=$bufferSize) ${RadioDiagLog.elapsedTag()}")
            return true
        } catch (e: SecurityException) {
            Log.e("[RadioError]", "Mic permission denied: ${e.message} method=startPreCapture", e)
            txSessionStats.stopReason = "mic_permission_denied"
            return false
        } catch (e: Exception) {
            Log.e("[RadioError]", "startPreCapture error: ${e::class.simpleName}: ${e.message} method=startPreCapture", e)
            txSessionStats.stopReason = "startPreCapture_exception"
            return false
        }
        } finally {
            transmitMutex.unlock()
        }
    }

    suspend fun promoteToLiveTransmit(): Boolean {
        if (!acquireTransmitMutex("promoteToLiveTransmit")) {
            Log.e(TAG, """{"event":"PROMOTE_TO_LIVE_ABORTED","reason":"mutex_acquire_failed"}""")
            return false
        }
        try {
        if (!isPreCapturing) {
            Log.w("[RadioError]", "promoteToLiveTransmit: not pre-capturing method=promoteToLiveTransmit")
            return false
        }

        var flushedFrames = 0
        synchronized(preBufferLock) {
            while (preBuffer.isNotEmpty()) {
                val frame = preBuffer.removeFirst()
                udpTransport.send(frame)
                flushedFrames++
                txSessionStats.packetsSent++
            }
            isTransmitting = true
            preCapturingToBuffer = false
        }
        isPreCapturing = false

        stateManager.txPipelineRunning = true
        stateManager.transitionTo(RadioState.TRANSMITTING, "tx_promoted_from_prebuffer")
        Log.d(TAG, "PRE_BUFFER_FLUSHED flushedFrames=$flushedFrames durationMs=${flushedFrames * CAPTURE_INTERVAL_MS} — live TX active ${RadioDiagLog.elapsedTag()}")
        return true
        } finally {
            transmitMutex.unlock()
        }
    }

    suspend fun stopPreCapture() {
        if (!acquireTransmitMutex("stopPreCapture")) {
            Log.e(TAG, """{"event":"STOP_PRE_CAPTURE_ABORTED","reason":"mutex_acquire_failed"}""")
            return
        }
        try {
        val cleanupStart = System.currentTimeMillis()
        preCaptureAborted = true
        val wasPreCapturing = isPreCapturing
        isPreCapturing = false
        captureJob?.cancel()
        val joinResult = withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { captureJob?.join() }
        if (joinResult == null && captureJob != null) {
            Log.w(TAG, """{"event":"CAPTURE_JOIN_TIMEOUT","caller":"stopPreCapture","timeoutMs":$CAPTURE_JOIN_TIMEOUT_MS}""")
        }
        captureJob = null
        val encodeJoinResult = withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { encodeJob?.join() }
        if (encodeJoinResult == null && encodeJob != null) {
            Log.w(TAG, """{"event":"ENCODE_JOIN_TIMEOUT","caller":"stopPreCapture","timeoutMs":$CAPTURE_JOIN_TIMEOUT_MS}""")
            encodeJob?.cancel()
        }
        encodeJob = null
        encodeQueue = null
        synchronized(preBufferLock) {
            preCapturingToBuffer = false
        }
        val hasResources = audioRecord != null || autoGainControl != null
        if (!wasPreCapturing && !hasResources) {
            val discardedOrphan: Int
            synchronized(preBufferLock) {
                discardedOrphan = preBuffer.size
                preBuffer.clear()
            }
            Log.d(TAG, "stopPreCapture: nothing to clean (wasPreCapturing=false, no resources) orphanFrames=$discardedOrphan")
            return
        }
        resetDspState()
        try {
            autoGainControl?.release()
        } catch (e: Exception) {
            Log.w("[RadioError]", "AGC release threw: ${e.message} method=stopPreCapture")
        }
        autoGainControl = null
        try {
            audioRecord?.stop()
        } catch (e: IllegalStateException) {
            Log.w("[RadioError]", "AudioRecord stop failed: ${e.message} method=stopPreCapture")
        }
        try {
            audioRecord?.release()
        } catch (e: IllegalStateException) {
            Log.w("[RadioError]", "AudioRecord release failed: ${e.message} method=stopPreCapture")
        }
        audioRecord = null
        val discardedFrames: Int
        synchronized(preBufferLock) {
            discardedFrames = preBuffer.size
            preBuffer.clear()
        }
        val cleanupMs = System.currentTimeMillis() - cleanupStart
        Log.d(TAG, """{"event":"PRE_CAPTURE_STOPPED","wasPreCapturing":$wasPreCapturing,"discardedFrames":$discardedFrames,"cleanupMs":$cleanupMs}""")
        } finally {
            transmitMutex.unlock()
        }
    }

    suspend fun startTransmit(): Boolean {
        if (!acquireTransmitMutex("startTransmit")) {
            Log.e(TAG, """{"event":"START_TRANSMIT_ABORTED","reason":"mutex_acquire_failed"}""")
            return false
        }
        try {
        if (!started) {
            Log.w("[RadioError]", "startTransmit: engine not started method=startTransmit")
            return false
        }
        if (isTransmitting) {
            Log.w("[RadioError]", "startTransmit: already transmitting — ignoring method=startTransmit")
            return true
        }

        try {
            RadioDiagLog.resetSessionClock()
            txSessionStats.reset()
            txSessionStats.startTimeMs = System.currentTimeMillis()
            txSessionStats.requestedRate = DEFAULT_MIC_SAMPLE_RATE
            pcmReadRateLimiter.reset()
            dspRateLimiter.reset()
            opusCodec.resetFailureCounts()
            udpTransport.resetTxDetailLogging()
            txSessionStartPacketCount = udpTransport.txPacketCount
            val txStartMs = System.currentTimeMillis()
            Log.d(TAG, "TX_SESSION_START ${RadioDiagLog.elapsedTag()}")

            val audioSource = selectAudioSource()
            if (audioSource == null) {
                Log.e("[RadioError]", "TX_START_ABORTED reason=all_audio_sources_rejected method=startTransmit")
                txSessionStats.stopReason = "all_sources_rejected"
                return false
            }

            val minBufferSize = AudioRecord.getMinBufferSize(
                DEFAULT_MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val requestedFrameSizeBytes = (DEFAULT_MIC_SAMPLE_RATE / 1000 * CAPTURE_INTERVAL_MS.toInt()) * 2
            val bufferSize = maxOf(minBufferSize, requestedFrameSizeBytes * 4)

            Log.d("[AudioCapture]", "TX_AUDIORECORD_INIT requestedRate=$DEFAULT_MIC_SAMPLE_RATE source=${txSessionStats.audioSource} minBufSize=$minBufferSize allocBufSize=$bufferSize frameMs=$CAPTURE_INTERVAL_MS ${RadioDiagLog.elapsedTag()}")

            val record = try {
                AudioRecord(
                    audioSource,
                    DEFAULT_MIC_SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    bufferSize
                )
            } catch (e: Exception) {
                Log.e("[RadioError]", "AudioRecord constructor threw: ${e::class.simpleName}: ${e.message} source=${txSessionStats.audioSource} rate=$DEFAULT_MIC_SAMPLE_RATE method=startTransmit", e)
                txSessionStats.stopReason = "audiorecord_constructor_exception"
                return false
            }
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e("[RadioError]", "AudioRecord failed to initialize state=${record.state} source=${txSessionStats.audioSource} rate=$DEFAULT_MIC_SAMPLE_RATE method=startTransmit")
                record.release()
                txSessionStats.stopReason = "audiorecord_init_failed"
                return false
            }

            actualSampleRate = record.sampleRate
            actualChannelCount = record.channelCount
            val actualAudioFormat = record.audioFormat
            txSessionStats.actualRate = actualSampleRate
            txSessionStats.channels = actualChannelCount

            if (actualSampleRate !in OPUS_SUPPORTED_RATES) {
                Log.e("[RadioError]", "TX_UNSUPPORTED_SAMPLE_RATE halRate=$actualSampleRate — not in Opus supported set $OPUS_SUPPORTED_RATES, aborting TX method=startTransmit")
                record.release()
                txSessionStats.stopReason = "unsupported_sample_rate"
                return false
            }

            actualFrameSizeSamples = (actualSampleRate * CAPTURE_INTERVAL_MS.toInt()) / 1000
            actualFrameSizeBytes = actualFrameSizeSamples * actualChannelCount * 2
            val needsStereoDownmix = actualChannelCount == 2

            if (actualChannelCount > 2) {
                Log.e("[RadioError]", "TX_UNEXPECTED_CHANNEL_COUNT channelCount=$actualChannelCount — only mono/stereo supported, aborting TX method=startTransmit")
                record.release()
                txSessionStats.stopReason = "unsupported_channel_count"
                return false
            }

            Log.d("[AudioCapture]", "TX_HAL_NEGOTIATED requestedRate=$DEFAULT_MIC_SAMPLE_RATE actualRate=$actualSampleRate actualChannels=$actualChannelCount audioFormat=$actualAudioFormat needsStereoDownmix=$needsStereoDownmix bufferSize=$bufferSize monoFrameSamples=$actualFrameSizeSamples monoFrameBytes=${actualFrameSizeSamples * 2} ${RadioDiagLog.elapsedTag()}")

            if (needsStereoDownmix) {
                Log.w("[AudioCapture]", "TX_STEREO_DETECTED HAL returned stereo ($actualChannelCount ch) despite requesting CHANNEL_IN_MONO — will downmix to mono before DSP/Opus encoding")
            }

            if (actualSampleRate != DEFAULT_MIC_SAMPLE_RATE) {
                Log.w("[AudioCapture]", "TX_SAMPLE_RATE_MISMATCH requested=$DEFAULT_MIC_SAMPLE_RATE actual=$actualSampleRate — adapting TX pipeline")
            }

            resetDspState()
            opusCodec.currentAudioSource = txSessionStats.audioSource
            opusCodec.reinitializeEncoderIfNeeded(actualSampleRate, 1)
            Log.d("[OpusCodec]", "OPUS_TX_INIT sampleRate=$actualSampleRate channels=1 frameMs=$CAPTURE_INTERVAL_MS frameSize=${opusCodec.encoderFrameSize} bitrate=${OpusCodec.BITRATE} ${RadioDiagLog.elapsedTag()}")

            computeDspCoefficients(actualSampleRate)

            record.startRecording()
            audioRecord = record

            val postStartRate = record.sampleRate
            if (postStartRate != actualSampleRate) {
                Log.w("[AudioCapture]", "TX_POST_START_RATE_CHANGE preStart=$actualSampleRate postStart=$postStartRate — vendor changed rate after startRecording()")
                actualSampleRate = postStartRate
                txSessionStats.actualRate = actualSampleRate
                if (actualSampleRate !in OPUS_SUPPORTED_RATES) {
                    Log.e("[RadioError]", "TX_UNSUPPORTED_SAMPLE_RATE_POST_START rate=$actualSampleRate — aborting TX method=startTransmit")
                    record.stop()
                    record.release()
                    audioRecord = null
                    txSessionStats.stopReason = "post_start_unsupported_rate"
                    return false
                }
                actualFrameSizeSamples = (actualSampleRate * CAPTURE_INTERVAL_MS.toInt()) / 1000
                actualFrameSizeBytes = actualFrameSizeSamples * actualChannelCount * 2
                opusCodec.reinitializeEncoderIfNeeded(actualSampleRate, 1)
                computeDspCoefficients(actualSampleRate)
                Log.d("[AudioCapture]", "TX_PIPELINE_READAPTED postStartRate=$actualSampleRate frameSize=$actualFrameSizeSamples ${RadioDiagLog.elapsedTag()}")
            }

            Log.d("[AudioCapture]", "TX_POST_START_VERIFY recordingState=${record.recordingState} sessionId=${record.audioSessionId} actualRate=${record.sampleRate} ${RadioDiagLog.elapsedTag()}")

            val monoFrameSizeBytes = actualFrameSizeSamples * 2

            val sessionId = record.audioSessionId
            try {
                if (AutomaticGainControl.isAvailable()) {
                    autoGainControl = AutomaticGainControl.create(sessionId)?.also { it.enabled = false }
                    Log.d("[AudioCapture]", "AGC attached=true enabled=false sessionId=$sessionId ${RadioDiagLog.elapsedTag()}")
                } else {
                    Log.d("[AudioCapture]", "AGC attached=false reason=unavailable ${RadioDiagLog.elapsedTag()}")
                }
            } catch (e: Exception) {
                Log.w("[RadioError]", "AutomaticGainControl unavailable: ${e.message} method=startTransmit")
            }

            isTransmitting = true
            lastSuccessfulSendMs = System.currentTimeMillis()
            stateManager.txPipelineRunning = true
            stateManager.transitionTo(RadioState.TRANSMITTING, "tx_started")
            Log.d("[AudioCapture]", "TX_CAPTURE_STARTED sampleRate=$actualSampleRate channelCount=$actualChannelCount frameMs=$CAPTURE_INTERVAL_MS frameSizeSamples=$actualFrameSizeSamples frameSizeBytes=$actualFrameSizeBytes ${RadioDiagLog.elapsedTag()}")

            startTxHeartbeatMonitor()

            val queue = LinkedBlockingQueue<ByteArray>(50)
            encodeQueue = queue
            val poisonPill = ByteArray(0)

            encodeJob = scope.launch {
                var frameCounter = 0
                try {
                    while (isActive) {
                        val monoFrame = queue.poll(100, TimeUnit.MILLISECONDS)
                        if (monoFrame == null) {
                            if (!isTransmitting) break
                            continue
                        }
                        if (monoFrame.isEmpty()) break

                        val encoded = opusCodec.encode(monoFrame)
                        if (opusCodec.encoderReinitialized) {
                            opusCodec.encoderReinitialized = false
                            pendingDspReset = true
                            Log.d("[AudioDSP]", "DSP_STATE_RESET_PENDING reason=encoder_reinitialized frame=$frameCounter ${RadioDiagLog.elapsedTag()}")
                        }
                        if (encoded != null) {
                            if (opusCodec.lastEncodeWasPcmFallback) {
                                txSessionStats.pcmFallbackFrames++
                            }
                            frameCounter++
                            txSessionStats.framesEncoded++
                            txSessionStats.packetsSent++
                            if (frameCounter == 1) {
                                val latencyMs = System.currentTimeMillis() - txStartMs
                                val monoFrameByteCount = actualFrameSizeSamples * 2
                                Log.d(TAG, "LATENCY_FIRST_TX_FRAME_SENT frame=$frameCounter samplesPerFrame=$actualFrameSizeSamples pcmBytesToEncode=$monoFrameByteCount opusFrameSize=${opusCodec.encoderFrameSize} encodedBytes=${encoded.size} latencyMs=$latencyMs ${RadioDiagLog.elapsedTag()}")
                            }
                            udpTransport.send(encoded)
                            lastSuccessfulSendMs = System.currentTimeMillis()
                        } else {
                            txSessionStats.failures++
                        }
                    }
                } catch (e: Exception) {
                    Log.e("[RadioError]", "TX_ENCODE_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=txEncodeLoop", e)
                }
                Log.d(TAG, "TX_ENCODE_THREAD_EXIT framesEncoded=${txSessionStats.framesEncoded} ${RadioDiagLog.elapsedTag()}")
            }

            captureJob = scope.launch {
                val readBuffer = ByteArray(actualFrameSizeBytes)
                val pendingFrame = ByteArray(actualFrameSizeBytes)
                var pendingBytes = 0
                try {
                    while (isActive && isTransmitting) {
                        try {
                            val read = record.read(readBuffer, 0, readBuffer.size)
                            if (read > 0) {
                                txSessionStats.framesRead++
                                if (read < readBuffer.size) txSessionStats.partialReads++
                                var readOffset = 0
                                while (readOffset < read) {
                                    val remainingFrameBytes = actualFrameSizeBytes - pendingBytes
                                    val chunkSize = minOf(remainingFrameBytes, read - readOffset)
                                    System.arraycopy(readBuffer, readOffset, pendingFrame, pendingBytes, chunkSize)
                                    pendingBytes += chunkSize
                                    readOffset += chunkSize

                                    if (pendingBytes == actualFrameSizeBytes) {
                                        val monoFrame: ByteArray
                                        if (needsStereoDownmix) {
                                            monoFrame = stereoToMono(pendingFrame, actualFrameSizeBytes)
                                        } else {
                                            monoFrame = pendingFrame.copyOf(monoFrameSizeBytes)
                                        }

                                        pcmReadRateLimiter.tick()
                                        if (pcmReadRateLimiter.shouldLogDetail()) {
                                            val stats = RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes)
                                            if (stats.silent) txSessionStats.silentFrames++
                                            txSessionStats.firstFrameRmsValues.add(stats.rms)
                                            Log.d("[AudioCapture]", "PCM_FRAME frame=${pcmReadRateLimiter.frameCount} readRet=$read $stats downmix=$needsStereoDownmix source=${txSessionStats.audioSource} sampleRate=$actualSampleRate channels=$actualChannelCount ${RadioDiagLog.elapsedTag()}")
                                        } else {
                                            val stats = RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes)
                                            if (stats.silent) txSessionStats.silentFrames++
                                            if (pcmReadRateLimiter.shouldLogSummary()) {
                                                val cnt = pcmReadRateLimiter.resetSummaryAccumulator()
                                                Log.d("[AudioCapture]", "PCM_SUMMARY frames=$cnt totalFrames=${pcmReadRateLimiter.frameCount} silentFrames=${txSessionStats.silentFrames} partials=${txSessionStats.partialReads} zeros=${txSessionStats.zeroReads} ${RadioDiagLog.elapsedTag()}")
                                            }
                                        }

                                        if (pendingDspReset) {
                                            pendingDspReset = false
                                            resetDspState()
                                            Log.d("[AudioDSP]", "DSP_STATE_RESET reason=encoder_reinitialized frame=${pcmReadRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
                                        }

                                        dspRateLimiter.tick()
                                        val preStats = if (dspRateLimiter.shouldLogDetail()) RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes) else null

                                        highPassFilter(monoFrame, monoFrameSizeBytes)
                                        txNoiseGate(monoFrame, monoFrameSizeBytes)
                                        lowPassFilter(monoFrame, monoFrameSizeBytes)
                                        softwareCompressor(monoFrame, monoFrameSizeBytes)
                                        applyGain(monoFrame, monoFrameSizeBytes, txGain)

                                        if (preStats != null) {
                                            val postStats = RadioDiagLog.pcmStats(monoFrame, monoFrameSizeBytes)
                                            Log.d("[AudioDSP]", "DSP_FRAME frame=${dspRateLimiter.frameCount} pre=[$preStats] post=[$postStats] gate=${if (txGateOpen) "open" else "closed"} gateEnv=${String.format("%.1f", txGateEnvelopeDb)}dB gateThreshold=${txGateThresholdDb}dB ${RadioDiagLog.elapsedTag()}")
                                        }

                                        if (!queue.offer(monoFrame)) {
                                            Log.w("[AudioCapture]", "ENCODE_QUEUE_FULL dropping frame ${pcmReadRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
                                        }
                                        pendingBytes = 0
                                    }
                                }
                            } else if (read < 0) {
                                txSessionStats.failures++
                                Log.w("[RadioError]", "AudioRecord read returned error: $read method=captureLoop ${RadioDiagLog.elapsedTag()}")
                            } else {
                                txSessionStats.zeroReads++
                            }
                        } catch (e: IllegalStateException) {
                            Log.w("[RadioError]", "AudioRecord read failed (released?): ${e.message} method=captureLoop")
                            txSessionStats.stopReason = "audiorecord_released"
                            break
                        } catch (t: Throwable) {
                            txSessionStats.failures++
                            Log.e("[RadioError]", "Capture loop error (continuing): ${t::class.simpleName}: ${t.message} method=captureLoop", t)
                        }
                    }
                } catch (e: Exception) {
                    Log.e("[RadioError]", "TX_CAPTURE_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=captureLoop", e)
                    txSessionStats.stopReason = "capture_loop_exception"
                }
                queue.offer(poisonPill)
            }
            Log.d(TAG, "TX started — audio capture active (sampleRate=$actualSampleRate channels=$actualChannelCount buffer=$bufferSize bitrate=${OpusCodec.BITRATE}) ${RadioDiagLog.elapsedTag()}")
            return true
        } catch (e: SecurityException) {
            Log.e("[RadioError]", "Mic permission denied: ${e.message} method=startTransmit", e)
            txSessionStats.stopReason = "mic_permission_denied"
            return false
        } catch (e: Exception) {
            Log.e("[RadioError]", "startTransmit error: ${e::class.simpleName}: ${e.message} method=startTransmit", e)
            txSessionStats.stopReason = "startTransmit_exception"
            return false
        }
        } finally {
            transmitMutex.unlock()
        }
    }

    private fun stereoToMono(stereoBuffer: ByteArray, stereoLength: Int): ByteArray {
        val stereoBuf = java.nio.ByteBuffer.wrap(stereoBuffer, 0, stereoLength).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val stereoSamples = stereoLength / 2
        val monoSamples = stereoSamples / 2
        val monoBytes = ByteArray(monoSamples * 2)
        val monoBuf = java.nio.ByteBuffer.wrap(monoBytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until monoSamples) {
            val left = stereoBuf.getShort(i * 4).toInt()
            val right = stereoBuf.getShort(i * 4 + 2).toInt()
            val mono = ((left + right) / 2).coerceIn(-32768, 32767).toShort()
            monoBuf.putShort(i * 2, mono)
        }
        return monoBytes
    }

    suspend fun stopTransmit() {
        if (!acquireTransmitMutex("stopTransmit")) {
            Log.e(TAG, """{"event":"STOP_TRANSMIT_ABORTED","reason":"mutex_acquire_failed"}""")
            return
        }
        try {
        val cleanupStart = System.currentTimeMillis()
        if (!isTransmitting) {
            Log.w("[RadioError]", "stopTransmit called but not transmitting — ignoring")
            return
        }
        isTransmitting = false
        stopTxHeartbeatMonitor()
        txSessionStats.stopReason = "ptt_release"
        captureJob?.cancel()
        val joinResult = withTimeoutOrNull(CAPTURE_JOIN_TIMEOUT_MS) { captureJob?.join() }
        if (joinResult == null && captureJob != null) {
            Log.w(TAG, """{"event":"CAPTURE_JOIN_TIMEOUT","caller":"stopTransmit","timeoutMs":$CAPTURE_JOIN_TIMEOUT_MS}""")
        }
        captureJob = null
        val drainTimeoutMs = 2000L
        val encodeJoinResult = withTimeoutOrNull(drainTimeoutMs) { encodeJob?.join() }
        if (encodeJoinResult == null && encodeJob != null) {
            Log.w(TAG, """{"event":"ENCODE_DRAIN_TIMEOUT","caller":"stopTransmit","timeoutMs":$drainTimeoutMs,"remainingFrames":${encodeQueue?.size ?: -1}}""")
            encodeQueue?.clear()
            encodeJob?.cancel()
        }
        encodeJob = null
        encodeQueue = null
        resetDspState()
        try {
            autoGainControl?.release()
        } catch (e: Exception) {
            Log.w("[RadioError]", "AGC release threw: ${e.message} method=stopTransmit")
        }
        autoGainControl = null
        try {
            audioRecord?.stop()
        } catch (e: IllegalStateException) {
            Log.w("[RadioError]", "AudioRecord stop failed: ${e.message} method=stopTransmit")
        }
        try {
            audioRecord?.release()
        } catch (e: IllegalStateException) {
            Log.w("[RadioError]", "AudioRecord release failed: ${e.message} method=stopTransmit")
        }
        audioRecord = null
        txSessionStats.assertionFailures = opusCodec.assertionFailureCount
        txSessionStats.encodeFailures = opusCodec.encodeFailureCount
        txSessionStats.packetsSent = udpTransport.txPacketCount - txSessionStartPacketCount
        stateManager.txPipelineRunning = false
        stateManager.transitionTo(RadioState.IDLE, "tx_stopped")
        val cleanupMs = System.currentTimeMillis() - cleanupStart
        val lastSendGapMs = if (lastSuccessfulSendMs > 0) System.currentTimeMillis() - lastSuccessfulSendMs else -1
        Log.d(TAG, """{"event":"TX_STOPPED","cleanupMs":$cleanupMs,"lastSendGapMs":$lastSendGapMs,${txSessionStats.summaryJson()}}""")
        Log.d(TAG, txSessionStats.summary() + " lastSendGapMs=$lastSendGapMs ${RadioDiagLog.elapsedTag()}")
        if (pendingCodecReset) {
            Log.d(TAG, "CODEC_RESET_EXECUTING_DEFERRED — performing codec reset deferred during TX")
            performCodecReset()
        }
        } finally {
            transmitMutex.unlock()
        }
    }

    private fun startTxHeartbeatMonitor() {
        txHeartbeatJob?.cancel()
        txHeartbeatJob = scope.launch {
            var stallReported = false
            while (isActive && isTransmitting) {
                delay(TX_HEARTBEAT_CHECK_INTERVAL_MS)
                if (!isTransmitting) break
                val now = System.currentTimeMillis()
                val gap = now - lastSuccessfulSendMs
                if (gap > TX_STALL_THRESHOLD_MS && !stallReported) {
                    stallReported = true
                    val reason = "tx_heartbeat_stall_gap=${gap}ms"
                    Log.e("[RadioError]", "TX_HEARTBEAT_STALL detected gap=${gap}ms threshold=${TX_STALL_THRESHOLD_MS}ms ${RadioDiagLog.elapsedTag()}")
                    txSessionStats.stopReason = "tx_stall_detected"
                    try {
                        onTxStall?.invoke(reason)
                    } catch (e: Exception) {
                        Log.e("[RadioError]", "onTxStall callback error: ${e.message}")
                    }
                } else if (gap <= TX_STALL_THRESHOLD_MS && stallReported) {
                    stallReported = false
                    Log.d(TAG, "TX_HEARTBEAT_RECOVERED gap=${gap}ms ${RadioDiagLog.elapsedTag()}")
                }
            }
        }
    }

    private fun stopTxHeartbeatMonitor() {
        txHeartbeatJob?.cancel()
        txHeartbeatJob = null
    }

    fun startReceive() {
        if (!started) {
            Log.w("[RadioError]", "startReceive called but engine not started — ignoring")
            return
        }
        rxSessionStats.reset()
        audioPlayback.onFrameDecoded = { rxSessionStats.packetsDecoded++ }
        audioPlayback.onUnderrun = { rxSessionStats.underruns++ }
        audioPlayback.onDecodeFailure = { rxSessionStats.failures++ }
        jitterBuffer.start()
        audioPlayback.start()
        stateManager.rxPipelineRunning = true
        Log.d(TAG, "RX_SESSION_START ${RadioDiagLog.elapsedTag()}")
        if (stateManager.state.value != RadioState.TRANSMITTING) {
            stateManager.transitionTo(RadioState.RECEIVING, "rx_started")
        }
        startRxDiagnostics()
        Log.d(TAG, "RX started — playback active ${RadioDiagLog.elapsedTag()}")
    }

    fun stopReceive() {
        rxDiagJob?.cancel()
        rxDiagJob = null
        audioPlayback.stop()
        audioPlayback.onFrameDecoded = null
        audioPlayback.onUnderrun = null
        audioPlayback.onDecodeFailure = null
        jitterBuffer.stop()
        stateManager.rxPipelineRunning = false
        if (stateManager.state.value == RadioState.RECEIVING) {
            stateManager.transitionTo(RadioState.IDLE, "rx_stopped")
        }
        rxSessionStats.stopReason = "explicit_stop"
        Log.d(TAG, rxSessionStats.summary() + " ${RadioDiagLog.elapsedTag()}")
        Log.d(TAG, "RX stopped")
    }

    private fun startRxDiagnostics() {
        rxDiagJob?.cancel()
        lastDiagRxCount = udpTransport.rxPacketCount
        rxDiagJob = scope.launch {
            while (isActive) {
                delay(RX_DIAG_INTERVAL_MS)
                val currentRxCount = udpTransport.rxPacketCount
                val newPackets = currentRxCount - lastDiagRxCount
                lastDiagRxCount = currentRxCount
                val bufSize = jitterBuffer.size
                val bufDepth = jitterBuffer.currentTargetDepth
                val bufPlaying = jitterBuffer.isPlaybackActive
                Log.d(TAG, "RX_DIAG rxTotal=$currentRxCount rxNew=$newPackets jbSize=$bufSize jbDepth=$bufDepth jbPlaying=$bufPlaying channelIdx=${udpTransport.channelIndex} ${RadioDiagLog.elapsedTag()}")
            }
        }
    }

    private fun onAudioPacketReceived(packet: OpusRadioPacket) {
        rxSessionStats.packetsReceived++
        if (packet.channelIndex != udpTransport.channelIndex) {
            rxSessionStats.packetsDropped++
            Log.d(TAG, "RX_DROP_WRONG_CHANNEL packetChannel=${packet.channelIndex} local=${udpTransport.channelIndex} seq=${packet.sequence}")
            return
        }
        Log.d(TAG, "RADIO_RX_CHANNEL_MATCH packetChannel=${packet.channelIndex} local=${udpTransport.channelIndex}")
        Log.d(TAG, "RADIO_RX_PACKET_RECEIVED seq=${packet.sequence} sender=${packet.senderUnitId} payload=${packet.opusPayload.size}")
        rxSessionStats.totalJitterDepth += jitterBuffer.size
        rxSessionStats.jitterSamples++
        if (udpTransport.rxPacketCount == 1L) {
            Log.d(TAG, "LATENCY_FIRST_RX_PACKET seq=${packet.sequence} sender=${packet.senderUnitId} ${RadioDiagLog.elapsedTag()}")
        }
        jitterBuffer.enqueue(packet.sequence, packet.opusPayload)
    }

    // --- DSP state ---

    private var hpPrevOutput: Double = 0.0
    private var hpPrevInput: Double = 0.0
    var txHpAlpha: Double = 0.9889

    var txLpB0: Double = 0.1554851459
    var txLpB1: Double = 0.3109702918
    var txLpB2: Double = 0.1554851459
    var txLpA1: Double = -0.5765879199
    var txLpA2: Double = 0.1985285035
    private var lpX1: Double = 0.0
    private var lpX2: Double = 0.0
    private var lpY1: Double = 0.0
    private var lpY2: Double = 0.0

    var txCompThresholdDb: Double = -12.0
    var txCompRatio: Double = 3.0
    var txCompAttackMs: Double = 0.003
    var txCompReleaseMs: Double = 0.15
    private var compEnvelopeDb: Double = -90.0

    private val compAttackCoeff: Double get() = 1.0 - Math.exp(-1.0 / (actualSampleRate * txCompAttackMs))
    private val compReleaseCoeff: Double get() = 1.0 - Math.exp(-1.0 / (actualSampleRate * txCompReleaseMs))

    var txGain: Double = 2.5

    var txGateThresholdDb: Double = -36.0
    var txGateAttackMs: Double = 0.002
    var txGateReleaseMs: Double = 0.08
    private var txGateEnvelopeDb: Double = -90.0
    private var txGateAttenuation: Double = 0.0
    private var txGateOpen: Boolean = false
    private var txGateLogCount: Int = 0

    private val txGateAttackCoeff: Double get() = 1.0 - Math.exp(-1.0 / (actualSampleRate * txGateAttackMs))
    private val txGateReleaseCoeff: Double get() = 1.0 - Math.exp(-1.0 / (actualSampleRate * txGateReleaseMs))

    private fun resetDspState() {
        hpPrevOutput = 0.0
        hpPrevInput = 0.0
        lpX1 = 0.0; lpX2 = 0.0; lpY1 = 0.0; lpY2 = 0.0
        compEnvelopeDb = -90.0
        txGateEnvelopeDb = -90.0
        txGateAttenuation = 0.0
        txGateOpen = false
        txGateLogCount = 0
    }

    private fun highPassFilter(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var prevOut = hpPrevOutput
        var prevIn = hpPrevInput
        for (i in 0 until sampleCount) {
            val x = buf.getShort(i * 2).toDouble()
            val y = txHpAlpha * (prevOut + x - prevIn)
            prevIn = x
            prevOut = y
            val clamped = y.coerceIn(-32768.0, 32767.0).toInt().toShort()
            buf.putShort(i * 2, clamped)
        }
        hpPrevOutput = prevOut
        hpPrevInput = prevIn
    }

    private fun lowPassFilter(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var x1 = lpX1; var x2 = lpX2
        var y1 = lpY1; var y2 = lpY2
        for (i in 0 until sampleCount) {
            val x0 = buf.getShort(i * 2).toDouble()
            val y0 = txLpB0 * x0 + txLpB1 * x1 + txLpB2 * x2 - txLpA1 * y1 - txLpA2 * y2
            x2 = x1; x1 = x0
            y2 = y1; y1 = y0
            buf.putShort(i * 2, y0.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        lpX1 = x1; lpX2 = x2
        lpY1 = y1; lpY2 = y2
    }

    private fun softwareCompressor(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var envelope = compEnvelopeDb
        for (i in 0 until sampleCount) {
            val sample = buf.getShort(i * 2).toDouble()
            val absSample = Math.abs(sample) + 1e-10
            val inputDb = 20.0 * Math.log10(absSample / 32768.0)

            val coeff = if (inputDb > envelope) compAttackCoeff else compReleaseCoeff
            envelope += coeff * (inputDb - envelope)

            var gainDb = 0.0
            if (envelope > txCompThresholdDb) {
                val overDb = envelope - txCompThresholdDb
                gainDb = -(overDb - overDb / txCompRatio)
            }

            val gainLinear = Math.pow(10.0, gainDb / 20.0)
            val output = sample * gainLinear
            buf.putShort(i * 2, output.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        compEnvelopeDb = envelope
    }

    private fun applyGain(buffer: ByteArray, length: Int, gain: Double) {
        if (gain == 1.0) return
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        for (i in 0 until sampleCount) {
            val sample = buf.getShort(i * 2).toDouble() * gain
            buf.putShort(i * 2, sample.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
    }

    private fun txNoiseGate(buffer: ByteArray, length: Int) {
        val buf = java.nio.ByteBuffer.wrap(buffer, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val sampleCount = length / 2
        var envelope = txGateEnvelopeDb
        var atten = txGateAttenuation
        for (i in 0 until sampleCount) {
            val sample = buf.getShort(i * 2).toDouble()
            val absSample = Math.abs(sample) + 1e-10
            val inputDb = 20.0 * Math.log10(absSample / 32768.0)

            val envCoeff = if (inputDb > envelope) txGateAttackCoeff else txGateReleaseCoeff
            envelope += envCoeff * (inputDb - envelope)

            val targetAtten = if (envelope < txGateThresholdDb) 0.0 else 1.0
            val smoothCoeff = if (targetAtten > atten) txGateAttackCoeff else txGateReleaseCoeff
            atten += smoothCoeff * (targetAtten - atten)

            val output = sample * atten
            buf.putShort(i * 2, output.coerceIn(-32768.0, 32767.0).toInt().toShort())
        }
        val wasOpen = txGateOpen
        val nowOpen = atten > 0.5
        if (nowOpen != wasOpen) {
            txGateLogCount++
            if (txGateLogCount <= 200) {
                Log.d("[AudioDSP]", "TX_GATE ${if (nowOpen) "OPEN" else "CLOSED"} envelope=${String.format("%.1f", envelope)}dB threshold=${txGateThresholdDb}dB frame=${dspRateLimiter.frameCount} ${RadioDiagLog.elapsedTag()}")
            }
        }
        txGateOpen = nowOpen
        txGateEnvelopeDb = envelope
        txGateAttenuation = atten
    }

    private fun acquireAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .setOnAudioFocusChangeListener(audioFocusListener)
                .build()
            audioManager.requestAudioFocus(req)
            audioFocusRequest = req
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                audioFocusListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
            )
        }
    }

    private fun releaseAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            audioFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusListener)
        }
    }

    fun release() {
        stop()
        audioPlayback.release()
        udpTransport.release()
        scope.cancel()
    }
}
