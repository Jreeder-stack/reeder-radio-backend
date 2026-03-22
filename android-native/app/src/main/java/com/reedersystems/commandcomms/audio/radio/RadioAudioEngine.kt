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

private const val TAG = "[RadioEngine]"
private const val SAMPLE_RATE = 16000
private const val FRAME_SIZE_BYTES = 640
private const val CAPTURE_INTERVAL_MS = 20L

class RadioAudioEngine(private val context: Context) {

    var stateManager = RadioStateManager()
        private set
    val opusCodec = OpusCodec()
    val jitterBuffer = JitterBuffer()
    val audioPlayback = AudioPlayback(jitterBuffer, opusCodec)
    val udpTransport = UdpAudioTransport()

    lateinit var floorControl: FloorControlManager
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var audioFocusRequest: AudioFocusRequest? = null

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
        stopTransmit()
        stopReceive()
        udpTransport.stop()
        releaseAudioFocus()
        opusCodec.release()
        started = false
        stateManager.reset()
        Log.d(TAG, "RadioAudioEngine stopped")
    }

    fun startTransmit(): Boolean {
        if (!started) {
            Log.w(TAG, "startTransmit: engine not started")
            return false
        }
        if (isTransmitting) return true

        try {
            val bufferSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            val record = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE,
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
                val buffer = ByteArray(FRAME_SIZE_BYTES)
                while (isActive && isTransmitting) {
                    val read = record.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        val encoded = opusCodec.encode(buffer.copyOf(read))
                        if (encoded != null) {
                            udpTransport.send(encoded)
                        }
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

    fun stopTransmit() {
        if (!isTransmitting) return
        isTransmitting = false
        captureJob?.cancel()
        captureJob = null
        audioRecord?.stop()
        audioRecord?.release()
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

    private fun acquireAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
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
