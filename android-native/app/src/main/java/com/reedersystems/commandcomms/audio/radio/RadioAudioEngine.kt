package com.reedersystems.commandcomms.audio.radio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val TAG = "[RadioEngine]"
private const val MIC_SAMPLE_RATE = 48000
private const val MIC_FRAME_SAMPLES = 960
private const val MIC_FRAME_SIZE_BYTES = MIC_FRAME_SAMPLES * 2
private const val CAPTURE_INTERVAL_MS = 20L

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
    private var noiseSuppressor: NoiseSuppressor? = null
    private var autoGainControl: AutomaticGainControl? = null
    private var captureJob: Job? = null
    @Volatile
    private var isTransmitting = false
    @Volatile
    private var started = false

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
        udpTransport.onPacketReceived = { packet -> onAudioPacketReceived(packet) }
        udpTransport.start()
        started = true
        Log.d(TAG, "RadioAudioEngine started")
    }

    fun stop() {
        if (!started) return
        runBlocking { stopTransmit() }
        stopReceive()
        udpTransport.stop()
        releaseAudioFocus()
        opusCodec.release()
        started = false
        stateManager.reset()
        Log.d(TAG, "RadioAudioEngine stopped")
    }

    suspend fun startTransmit(): Boolean = transmitMutex.withLock {
        if (!started) {
            Log.w(TAG, "startTransmit: engine not started")
            return false
        }
        if (isTransmitting) return true

        try {
            val minBufferSize = AudioRecord.getMinBufferSize(
                MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val bufferSize = maxOf(minBufferSize, MIC_FRAME_SIZE_BYTES * 4)
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize
            )
            if (record.state != AudioRecord.STATE_INITIALIZED) {
                Log.e(TAG, "AudioRecord failed to initialize")
                record.release()
                return false
            }
            record.startRecording()
            audioRecord = record

            // Attach platform audio effects when available
            val sessionId = record.audioSessionId
            try {
                if (NoiseSuppressor.isAvailable()) {
                    noiseSuppressor = NoiseSuppressor.create(sessionId)?.also { it.enabled = true }
                    Log.d(TAG, "NoiseSuppressor attached: ${noiseSuppressor != null}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "NoiseSuppressor unavailable: ${e.message}")
            }
            try {
                if (AutomaticGainControl.isAvailable()) {
                    autoGainControl = AutomaticGainControl.create(sessionId)?.also { it.enabled = true }
                    Log.d(TAG, "AutomaticGainControl attached: ${autoGainControl != null}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "AutomaticGainControl unavailable: ${e.message}")
            }

            isTransmitting = true
            stateManager.transitionTo(RadioState.TRANSMITTING)
            Log.d(TAG, "OPUS_TX_INIT sampleRate=$MIC_SAMPLE_RATE channels=1 frameMs=$CAPTURE_INTERVAL_MS bitrate=${OpusCodec.BITRATE}")
            Log.d(TAG, "RADIO_TX_CAPTURE_STARTED sampleRate=$MIC_SAMPLE_RATE frameMs=$CAPTURE_INTERVAL_MS")

            captureJob = scope.launch {
                val readBuffer = ByteArray(MIC_FRAME_SIZE_BYTES)
                val pendingFrame = ByteArray(MIC_FRAME_SIZE_BYTES)
                var pendingBytes = 0
                var frameCounter = 0
                while (isActive && isTransmitting) {
                    try {
                        val read = record.read(readBuffer, 0, readBuffer.size)
                        if (read > 0) {
                            var readOffset = 0
                            while (readOffset < read) {
                                val remainingFrameBytes = MIC_FRAME_SIZE_BYTES - pendingBytes
                                val chunkSize = minOf(remainingFrameBytes, read - readOffset)
                                System.arraycopy(readBuffer, readOffset, pendingFrame, pendingBytes, chunkSize)
                                pendingBytes += chunkSize
                                readOffset += chunkSize

                                if (pendingBytes == MIC_FRAME_SIZE_BYTES) {
                                    highPassFilter(pendingFrame, MIC_FRAME_SIZE_BYTES)
                                    lowPassFilter(pendingFrame, MIC_FRAME_SIZE_BYTES)
                                    softwareCompressor(pendingFrame, MIC_FRAME_SIZE_BYTES)
                                    applyGain(pendingFrame, MIC_FRAME_SIZE_BYTES, TX_GAIN)
                                    val encoded = opusCodec.encode(pendingFrame)
                                    if (encoded != null) {
                                        frameCounter++
                                        Log.d(TAG, "OPUS_TX_FRAME_ENCODED frame=$frameCounter bytes=${encoded.size}")
                                        Log.d(TAG, "RADIO_OPUS_TX_FRAME_ENCODED frame=$frameCounter bytes=${encoded.size}")
                                        udpTransport.send(encoded)
                                        Log.d(TAG, "OPUS_TX_FRAME_SENT frame=$frameCounter bytes=${encoded.size}")
                                        Log.d(TAG, "RADIO_OPUS_TX_FRAME_SENT frame=$frameCounter bytes=${encoded.size}")
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
            Log.d(TAG, "TX started — audio capture active (buffer=${bufferSize}, bitrate=${OpusCodec.BITRATE})")
            return true
        } catch (e: SecurityException) {
            Log.e(TAG, "Mic permission denied: ${e.message}", e)
            return false
        } catch (e: Exception) {
            Log.e(TAG, "startTransmit error: ${e.message}", e)
            return false
        }
    }

    suspend fun stopTransmit() = transmitMutex.withLock {
        if (!isTransmitting) return@withLock
        isTransmitting = false
        captureJob?.cancelAndJoin()
        captureJob = null
        resetDspState()
        try {
            noiseSuppressor?.release()
        } catch (_: Exception) {}
        noiseSuppressor = null
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
        Log.d(TAG, "RX started — playback active")
    }

    fun stopReceive() {
        audioPlayback.stop()
        jitterBuffer.stop()
        if (stateManager.state.value == RadioState.RECEIVING) {
            stateManager.transitionTo(RadioState.IDLE)
        }
        Log.d(TAG, "RX stopped")
    }

    private fun onAudioPacketReceived(packet: OpusRadioPacket) {
        if (packet.channelId != udpTransport.channelId) {
            Log.d(TAG, "Dropping RX frame for other channel packetChannel=${packet.channelId} local=${udpTransport.channelId}")
            return
        }
        Log.d(TAG, "RADIO_RX_PACKET_RECEIVED seq=${packet.sequence} sender=${packet.senderUnitId} payload=${packet.opusPayload.size}")
        jitterBuffer.enqueue(packet.sequence, packet.opusPayload)
    }

    // --- DSP state ---

    // High-pass filter state (~80Hz, single-pole IIR)
    private var hpPrevOutput: Double = 0.0
    private var hpPrevInput: Double = 0.0
    private val HP_ALPHA: Double = 0.9889

    // Low-pass filter state (7.5kHz biquad at 48kHz sample rate)
    // Biquad coefficients for: fc=7500Hz, Q=0.707, fs=48000Hz
    private val LP_B0: Double = 0.1554851459
    private val LP_B1: Double = 0.3109702918
    private val LP_B2: Double = 0.1554851459
    private val LP_A1: Double = -0.5765879199
    private val LP_A2: Double = 0.1985285035
    private var lpX1: Double = 0.0
    private var lpX2: Double = 0.0
    private var lpY1: Double = 0.0
    private var lpY2: Double = 0.0

    // Compressor state (matches web: threshold=-18dB, ratio=3:1, attack=3ms, release=150ms)
    private val COMP_THRESHOLD_DB: Double = -18.0
    private val COMP_RATIO: Double = 3.0
    private val COMP_ATTACK_COEFF: Double = 1.0 - Math.exp(-1.0 / (MIC_SAMPLE_RATE * 0.003))
    private val COMP_RELEASE_COEFF: Double = 1.0 - Math.exp(-1.0 / (MIC_SAMPLE_RATE * 0.15))
    private var compEnvelopeDb: Double = -90.0

    // TX gain (matches web's 1.4x base gain)
    private val TX_GAIN: Double = 1.4

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
            val y = HP_ALPHA * (prevOut + x - prevIn)
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
            val y0 = LP_B0 * x0 + LP_B1 * x1 + LP_B2 * x2 - LP_A1 * y1 - LP_A2 * y2
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

            // Envelope follower
            val coeff = if (inputDb > envelope) COMP_ATTACK_COEFF else COMP_RELEASE_COEFF
            envelope += coeff * (inputDb - envelope)

            // Gain computation
            var gainDb = 0.0
            if (envelope > COMP_THRESHOLD_DB) {
                val overDb = envelope - COMP_THRESHOLD_DB
                gainDb = -(overDb - overDb / COMP_RATIO)
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
