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
import kotlinx.coroutines.sync.withLock

private const val TAG = "[RadioEngine]"
private const val DEFAULT_MIC_SAMPLE_RATE = 48000
private const val CAPTURE_INTERVAL_MS = 20L
private const val RX_DIAG_INTERVAL_MS = 5_000L

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
    private var rxDiagJob: Job? = null
    @Volatile
    private var isTransmitting = false
    @Volatile
    private var started = false
    @Volatile
    private var lastDiagRxCount: Long = 0

    @Volatile
    private var reconnectCount = 0

    private var actualSampleRate: Int = DEFAULT_MIC_SAMPLE_RATE
    private var actualChannelCount: Int = 1
    private var actualFrameSizeSamples: Int = (DEFAULT_MIC_SAMPLE_RATE * CAPTURE_INTERVAL_MS.toInt()) / 1000
    private var actualFrameSizeBytes: Int = actualFrameSizeSamples * 2

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT -> {
                Log.d(TAG, "Audio focus gained")
            }
            else -> {}
        }
    }

    var onDisconnected: (() -> Unit)? = null

    val isConnected: Boolean get() = started

    fun useSharedStateManager(shared: RadioStateManager) {
        stateManager = shared
    }

    fun wireFloorControl(gateway: RadioSignalingGateway) {
        floorControl = FloorControlManager(gateway, stateManager)
    }

    fun start() {
        if (started) return
        opusCodec.initialize()
        acquireAudioFocus()
        audioPlayback.ensureTrackReady()
        udpTransport.onPacketReceived = { packet -> onAudioPacketReceived(packet) }
        udpTransport.onSessionTokenChanged = { onSessionTokenChanged() }
        udpTransport.start()
        started = true
        Log.d(TAG, "RadioAudioEngine started")
    }

    fun stop() {
        if (!started) return
        runBlocking { stopTransmit() }
        stopReceive()
        udpTransport.onSessionTokenChanged = null
        udpTransport.stop()
        releaseAudioFocus()
        opusCodec.release()
        started = false
        stateManager.reset()
        Log.d(TAG, "RadioAudioEngine stopped")
    }

    private fun onSessionTokenChanged() {
        if (!started) return
        reconnectCount++
        val rc = reconnectCount
        Log.d(TAG, "RECONNECT_START reconnectCount=$rc — coordinated audio pipeline reset")
        val resetStartMs = System.currentTimeMillis()

        opusCodec.resetDecoder()
        Log.d(TAG, "RECONNECT_STEP_1_DECODER_RESET reconnectCount=$rc")

        opusCodec.resetEncoder()
        Log.d(TAG, "RECONNECT_STEP_2_ENCODER_RESET reconnectCount=$rc")

        jitterBuffer.flushForReconnect()
        Log.d(TAG, "RECONNECT_STEP_3_JITTER_BUFFER_FLUSHED reconnectCount=$rc")

        audioPlayback.clearStaleFrames()
        Log.d(TAG, "RECONNECT_STEP_4_AUDIOTRACK_FLUSHED reconnectCount=$rc")

        resetDspState()
        Log.d(TAG, "RECONNECT_STEP_5_DSP_STATE_RESET reconnectCount=$rc")

        val resetDurationMs = System.currentTimeMillis() - resetStartMs
        Log.d(TAG, "RECONNECT_COMPLETE reconnectCount=$rc resetDurationMs=$resetDurationMs")
    }

    private val OPUS_SUPPORTED_RATES = setOf(8000, 12000, 16000, 24000, 48000)

    private fun probeAudioSource(source: Int, sourceName: String): Boolean {
        val probeRates = intArrayOf(DEFAULT_MIC_SAMPLE_RATE, 16000, 8000)
        for (rate in probeRates) {
            try {
                val testMinBuf = AudioRecord.getMinBufferSize(
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                )
                if (testMinBuf <= 0) continue
                val testRecord = AudioRecord(
                    source,
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    testMinBuf
                )
                val ok = testRecord.state == AudioRecord.STATE_INITIALIZED
                testRecord.release()
                if (ok) {
                    Log.d(TAG, "TX_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=OK")
                    return true
                }
            } catch (_: Exception) {}
        }
        return false
    }

    private fun selectAudioSource(): Int {
        if (Build.VERSION.SDK_INT >= 24) {
            if (probeAudioSource(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED")) {
                Log.d(TAG, "TX_AUDIO_SOURCE selected=UNPROCESSED (API ${Build.VERSION.SDK_INT})")
                return MediaRecorder.AudioSource.UNPROCESSED
            }
        }

        if (probeAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION")) {
            Log.d(TAG, "TX_AUDIO_SOURCE selected=VOICE_RECOGNITION")
            return MediaRecorder.AudioSource.VOICE_RECOGNITION
        }

        Log.d(TAG, "TX_AUDIO_SOURCE selected=MIC (fallback)")
        return MediaRecorder.AudioSource.MIC
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

        Log.d(TAG, "TX_DSP_COEFFICIENTS sampleRate=$sampleRate hpAlpha=$txHpAlpha lpCutoff=$lpCutoff lpB0=$txLpB0 lpB1=$txLpB1 lpB2=$txLpB2 lpA1=$txLpA1 lpA2=$txLpA2")
    }

    suspend fun startTransmit(): Boolean = transmitMutex.withLock {
        if (!started) {
            Log.w(TAG, "startTransmit: engine not started")
            return false
        }
        if (isTransmitting) return true

        try {
            val txStartMs = System.currentTimeMillis()
            Log.d(TAG, "LATENCY_TX_START_BEGIN")

            val audioSource = selectAudioSource()

            val minBufferSize = AudioRecord.getMinBufferSize(
                DEFAULT_MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val requestedFrameSizeBytes = (DEFAULT_MIC_SAMPLE_RATE / 1000 * CAPTURE_INTERVAL_MS.toInt()) * 2
            val bufferSize = maxOf(minBufferSize, requestedFrameSizeBytes * 4)
            val record = AudioRecord(
                audioSource,
                DEFAULT_MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord failed to initialize")
                record.release()
                return false
            }

            actualSampleRate = record.sampleRate
            actualChannelCount = record.channelCount
            val actualAudioFormat = record.audioFormat

            if (actualSampleRate !in OPUS_SUPPORTED_RATES) {
                Log.e(TAG, "TX_UNSUPPORTED_SAMPLE_RATE halRate=$actualSampleRate — not in Opus supported set $OPUS_SUPPORTED_RATES, aborting TX")
                record.release()
                return false
            }

            actualFrameSizeSamples = (actualSampleRate * CAPTURE_INTERVAL_MS.toInt()) / 1000
            actualFrameSizeBytes = actualFrameSizeSamples * actualChannelCount * 2
            val needsStereoDownmix = actualChannelCount == 2

            if (actualChannelCount > 2) {
                Log.e(TAG, "TX_UNEXPECTED_CHANNEL_COUNT channelCount=$actualChannelCount — only mono/stereo supported, aborting TX")
                record.release()
                return false
            }

            Log.d(TAG, "TX_HAL_NEGOTIATED actualSampleRate=$actualSampleRate actualChannelCount=$actualChannelCount audioFormat=$actualAudioFormat requestedSampleRate=$DEFAULT_MIC_SAMPLE_RATE needsStereoDownmix=$needsStereoDownmix bufferSize=$bufferSize")

            if (actualSampleRate != DEFAULT_MIC_SAMPLE_RATE) {
                Log.w(TAG, "TX_SAMPLE_RATE_MISMATCH requested=$DEFAULT_MIC_SAMPLE_RATE actual=$actualSampleRate — adapting TX pipeline")
            }

            opusCodec.reinitializeEncoderOnly(actualSampleRate, 1)
            Log.d(TAG, "OPUS_TX_INIT sampleRate=$actualSampleRate channels=1 frameMs=$CAPTURE_INTERVAL_MS frameSize=${opusCodec.encoderFrameSize} bitrate=${OpusCodec.BITRATE}")

            computeDspCoefficients(actualSampleRate)

            record.startRecording()
            audioRecord = record

            val postStartRate = record.sampleRate
            if (postStartRate != actualSampleRate) {
                Log.w(TAG, "TX_POST_START_RATE_CHANGE preStart=$actualSampleRate postStart=$postStartRate — vendor changed rate after startRecording()")
                actualSampleRate = postStartRate
                if (actualSampleRate !in OPUS_SUPPORTED_RATES) {
                    Log.e(TAG, "TX_UNSUPPORTED_SAMPLE_RATE_POST_START rate=$actualSampleRate — aborting TX")
                    record.stop()
                    record.release()
                    audioRecord = null
                    return false
                }
                actualFrameSizeSamples = (actualSampleRate * CAPTURE_INTERVAL_MS.toInt()) / 1000
                actualFrameSizeBytes = actualFrameSizeSamples * actualChannelCount * 2
                opusCodec.reinitializeEncoderOnly(actualSampleRate, 1)
                computeDspCoefficients(actualSampleRate)
                Log.d(TAG, "TX_PIPELINE_READAPTED postStartRate=$actualSampleRate frameSize=$actualFrameSizeSamples")
            }

            val monoFrameSizeBytes = actualFrameSizeSamples * 2

            val sessionId = record.audioSessionId
            try {
                if (AutomaticGainControl.isAvailable()) {
                    autoGainControl = AutomaticGainControl.create(sessionId)?.also { it.enabled = false }
                    Log.d(TAG, "AutomaticGainControl attached and DISABLED for radio TX")
                }
            } catch (e: Exception) {
                Log.w(TAG, "AutomaticGainControl unavailable: ${e.message}")
            }

            isTransmitting = true
            stateManager.transitionTo(RadioState.TRANSMITTING)
            Log.d(TAG, "RADIO_TX_CAPTURE_STARTED sampleRate=$actualSampleRate channelCount=$actualChannelCount frameMs=$CAPTURE_INTERVAL_MS frameSizeSamples=$actualFrameSizeSamples frameSizeBytes=$actualFrameSizeBytes")

            captureJob = scope.launch {
                val readBuffer = ByteArray(actualFrameSizeBytes)
                val pendingFrame = ByteArray(actualFrameSizeBytes)
                var pendingBytes = 0
                var frameCounter = 0
                while (isActive && isTransmitting) {
                    try {
                        val read = record.read(readBuffer, 0, readBuffer.size)
                        if (read > 0) {
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
                                    highPassFilter(monoFrame, monoFrameSizeBytes)
                                    lowPassFilter(monoFrame, monoFrameSizeBytes)
                                    softwareCompressor(monoFrame, monoFrameSizeBytes)
                                    applyGain(monoFrame, monoFrameSizeBytes, txGain)
                                    val encoded = opusCodec.encode(monoFrame)
                                    if (encoded != null) {
                                        frameCounter++
                                        if (frameCounter == 1) {
                                            val latencyMs = System.currentTimeMillis() - txStartMs
                                            val monoFrameByteCount = actualFrameSizeSamples * 2
                                            Log.d(TAG, "LATENCY_FIRST_TX_FRAME_SENT frame=$frameCounter samplesPerFrame=$actualFrameSizeSamples pcmBytesToEncode=$monoFrameByteCount opusFrameSize=${opusCodec.encoderFrameSize} encodedBytes=${encoded.size} latencyMs=$latencyMs")
                                        }
                                        udpTransport.send(encoded)
                                    }
                                    pendingBytes = 0
                                }
                            }
                        } else if (read < 0) {
                            Log.w(TAG, "AudioRecord read returned error: $read")
                        }
                    } catch (e: IllegalStateException) {
                        Log.w(TAG, "AudioRecord read failed (released?): ${e.message}")
                        break
                    } catch (t: Throwable) {
                        Log.e(TAG, "Capture loop error (continuing): ${t.message}", t)
                    }
                }
            }
            Log.d(TAG, "TX started — audio capture active (sampleRate=$actualSampleRate channels=$actualChannelCount buffer=$bufferSize bitrate=${OpusCodec.BITRATE})")
            return true
        } catch (e: SecurityException) {
            Log.e(TAG, "Mic permission denied: ${e.message}", e)
            return false
        } catch (e: Exception) {
            Log.e(TAG, "startTransmit error: ${e.message}", e)
            return false
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

    suspend fun stopTransmit() = transmitMutex.withLock {
        if (!isTransmitting) return@withLock
        isTransmitting = false
        captureJob?.cancelAndJoin()
        captureJob = null
        resetDspState()
        try {
            autoGainControl?.release()
        } catch (_: Exception) {}
        autoGainControl = null
        try {
            audioRecord?.stop()
        } catch (e: IllegalStateException) {
            Log.w(TAG, "AudioRecord stop failed: ${e.message}")
        }
        try {
            audioRecord?.release()
        } catch (e: IllegalStateException) {
            Log.w(TAG, "AudioRecord release failed: ${e.message}")
        }
        audioRecord = null
        stateManager.transitionTo(RadioState.IDLE)
        Log.d(TAG, "TX stopped")
    }

    fun startReceive() {
        if (!started) return
        jitterBuffer.start()
        audioPlayback.start()
        Log.d(TAG, "OPUS_RX_PLAYBACK_STARTED")
        Log.d(TAG, "RADIO_RX_PLAYBACK_STARTED")
        if (stateManager.state.value != RadioState.TRANSMITTING) {
            stateManager.transitionTo(RadioState.RECEIVING)
        }
        startRxDiagnostics()
        Log.d(TAG, "RX started — playback active")
    }

    fun stopReceive() {
        rxDiagJob?.cancel()
        rxDiagJob = null
        audioPlayback.stop()
        jitterBuffer.stop()
        if (stateManager.state.value == RadioState.RECEIVING) {
            stateManager.transitionTo(RadioState.IDLE)
        }
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
                Log.d(TAG, "RX_DIAG rxTotal=$currentRxCount rxNew=$newPackets jbSize=$bufSize jbDepth=$bufDepth jbPlaying=$bufPlaying channelIdx=${udpTransport.channelIndex}")
            }
        }
    }

    private fun onAudioPacketReceived(packet: OpusRadioPacket) {
        if (packet.channelIndex != udpTransport.channelIndex) {
            Log.d(TAG, "Dropping RX frame for other channel packetChannel=${packet.channelIndex} local=${udpTransport.channelIndex}")
            return
        }
        Log.d(TAG, "RADIO_RX_CHANNEL_MATCH packetChannel=${packet.channelIndex} local=${udpTransport.channelIndex}")
        Log.d(TAG, "RADIO_RX_PACKET_RECEIVED seq=${packet.sequence} sender=${packet.senderUnitId} payload=${packet.opusPayload.size}")
        if (udpTransport.rxPacketCount == 1L) {
            Log.d(TAG, "LATENCY_FIRST_RX_PACKET seq=${packet.sequence} sender=${packet.senderUnitId}")
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

    var txGain: Double = 3.5

    private fun resetDspState() {
        hpPrevOutput = 0.0
        hpPrevInput = 0.0
        lpX1 = 0.0; lpX2 = 0.0; lpY1 = 0.0; lpY2 = 0.0
        compEnvelopeDb = -90.0
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
