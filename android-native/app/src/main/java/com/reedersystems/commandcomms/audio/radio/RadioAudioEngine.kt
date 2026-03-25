package com.reedersystems.commandcomms.audio.radio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val TAG = "[RadioEngine]"
private const val MIC_SAMPLE_RATE = 16000
private const val OPUS_SAMPLE_RATE = 48000
private const val MIC_FRAME_SAMPLES = 320
private const val MIC_FRAME_SIZE_BYTES = MIC_FRAME_SAMPLES * 2
private const val OPUS_FRAME_SAMPLES = 960
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
            val bufferSize = AudioRecord.getMinBufferSize(
                MIC_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
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
            isTransmitting = true
            stateManager.transitionTo(RadioState.TRANSMITTING)

            captureJob = scope.launch {
                val micBuffer = ByteArray(MIC_FRAME_SIZE_BYTES)
                while (isActive && isTransmitting) {
                    try {
                        val read = record.read(micBuffer, 0, micBuffer.size)
                        if (read > 0) {
                            val upsampled = upsample16kTo48k(micBuffer, read)
                            val encoded = opusCodec.encode(upsampled)
                            if (encoded != null) {
                                udpTransport.send(encoded)
                            }
                        }
                    } catch (e: IllegalStateException) {
                        Log.w(TAG, "AudioRecord read failed (released?): ${e.message}")
                        break
                    } catch (t: Throwable) {
                        Log.e(TAG, "Capture loop error (continuing): ${t.message}", t)
                    }
                }
            }
            Log.d(TAG, "TX started — audio capture active")
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

    private fun onAudioPacketReceived(packet: ByteArray) {
        jitterBuffer.enqueue(packet)
    }

    private fun upsample16kTo48k(input: ByteArray, length: Int): ByteArray {
        val inputSamples = length / 2
        val outputSamples = inputSamples * 3
        val output = ByteArray(outputSamples * 2)
        val inBuf = java.nio.ByteBuffer.wrap(input, 0, length).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val outBuf = java.nio.ByteBuffer.wrap(output).order(java.nio.ByteOrder.LITTLE_ENDIAN)

        var prevSample: Short = 0
        for (i in 0 until inputSamples) {
            val sample = inBuf.getShort(i * 2)
            val s0 = prevSample.toInt()
            val s1 = sample.toInt()
            outBuf.putShort((i * 3) * 2, ((s0 * 2 + s1) / 3).toShort())
            outBuf.putShort((i * 3 + 1) * 2, ((s0 + s1 * 2) / 3).toShort())
            outBuf.putShort((i * 3 + 2) * 2, sample)
            prevSample = sample
        }
        return output
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
