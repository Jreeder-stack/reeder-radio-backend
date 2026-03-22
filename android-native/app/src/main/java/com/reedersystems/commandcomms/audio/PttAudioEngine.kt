package com.reedersystems.commandcomms.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import io.livekit.android.LiveKit
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrackOptions
import kotlinx.coroutines.*

private const val TAG = "[PTT-DIAG]"
private const val CONNECT_TIMEOUT_MS = 5_000L
private const val WATCHDOG_INTERVAL_MS = 500L

/**
 * @deprecated Use [com.reedersystems.commandcomms.audio.radio.RadioAudioEngine] for the
 * custom radio transport path on handheld devices. This LiveKit-based engine is retained
 * only for the dispatcher/web fallback path and will be removed once the replacement is
 * verified working in production.
 */
@Deprecated("Replaced by RadioAudioEngine for handheld custom-radio transport")
class PttAudioEngine(private val context: Context) {

    private var room: Room? = null
    private var isTransmitting = false
    private val radioDsp = RadioDspChain()
    private var eventJob: Job? = null
    private var watchdogJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var audioFocusRequest: AudioFocusRequest? = null
    private var expectingDisconnect = false

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT -> {
                Log.d(TAG, "PttAudioEngine: audio focus gained — re-asserting speakerphone")
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                enableSpeakerphone()
                setMaxVoiceCallVolume()
            }
            else -> {}
        }
    }

    /** Called when LiveKit disconnects unexpectedly (not via our own disconnect()). */
    var onDisconnected: (() -> Unit)? = null

    val isConnected: Boolean
        get() = room?.state == Room.State.CONNECTED

    suspend fun connect(livekitUrl: String, token: String): Boolean =
        withContext(Dispatchers.Main) {
            runCatching {
                Log.d(TAG, "PttAudioEngine.connect() url=$livekitUrl")

                // Acquire audio focus so Android routes remote audio to speaker for RX and TX.
                // Without this, receive-only connections get no audio because the voice
                // communication pipeline is never opened by the OS.
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

                val newRoom = LiveKit.create(
                    appContext = context,
                    options = RoomOptions(
                        audioTrackCaptureDefaults = LocalAudioTrackOptions(
                            noiseSuppression = true,
                            echoCancellation = true,
                            autoGainControl = true,
                            highPassFilter = true,
                            typingNoiseDetection = false
                        )
                    )
                )

                // Set speaker routing BEFORE connecting so WebRTC starts on the right audio path.
                // Without this, the OS defaults to earpiece for MODE_IN_COMMUNICATION.
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                enableSpeakerphone()
                setMaxVoiceCallVolume()

                val connected = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                    newRoom.connect(url = livekitUrl, token = token)
                    true
                }

                if (connected == true) {
                    room = newRoom
                    radioDsp.enable()
                    observeRoomEvents(newRoom)
                    // Re-apply at 300ms, 600ms, and 1500ms after connect to catch all phases
                    // of LiveKit/WebRTC initialization that can override audio routing.
                    scope.launch {
                        delay(300)
                        enableSpeakerphone()
                        setMaxVoiceCallVolume()
                        Log.d(TAG, "PttAudioEngine: speaker routing re-applied after 300ms")
                    }
                    scope.launch {
                        delay(600)
                        enableSpeakerphone()
                        setMaxVoiceCallVolume()
                        Log.d(TAG, "PttAudioEngine: speaker routing re-applied after 600ms")
                    }
                    scope.launch {
                        delay(1500)
                        enableSpeakerphone()
                        setMaxVoiceCallVolume()
                        Log.d(TAG, "PttAudioEngine: speaker routing re-applied after 1500ms")
                    }
                    startWatchdog()
                    Log.d(TAG, "PttAudioEngine connected — speakerphone enabled, watchdog started")
                    true
                } else {
                    Log.w(TAG, "PttAudioEngine connect timed out")
                    newRoom.disconnect()
                    false
                }
            }.getOrElse { e ->
                Log.e(TAG, "PttAudioEngine connect error: ${e.message}", e)
                false
            }
        }

    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = scope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                if (room?.state == Room.State.CONNECTED) {
                    val needsReapply = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        val commDevice = audioManager.communicationDevice
                        audioManager.mode != AudioManager.MODE_IN_COMMUNICATION ||
                            commDevice?.type != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    } else {
                        @Suppress("DEPRECATION")
                        audioManager.mode != AudioManager.MODE_IN_COMMUNICATION ||
                            !audioManager.isSpeakerphoneOn
                    }
                    if (needsReapply) {
                        Log.w(TAG, "PttAudioEngine watchdog: routing reverted — re-asserting speakerphone")
                        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                        enableSpeakerphone()
                        setMaxVoiceCallVolume()
                    }
                }
            }
        }
    }

    private fun stopWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = null
    }

    private fun setMaxVoiceCallVolume() {
        val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
        audioManager.setStreamVolume(AudioManager.STREAM_VOICE_CALL, maxVol, 0)
        Log.d(TAG, "AudioManager: STREAM_VOICE_CALL volume set to max ($maxVol)")
    }

    private fun enableSpeakerphone() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            enableSpeakerphoneModern()
        } else {
            enableSpeakerphoneLegacy()
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun enableSpeakerphoneModern() {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val speakerDevice = audioManager.availableCommunicationDevices
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        if (speakerDevice != null) {
            val success = audioManager.setCommunicationDevice(speakerDevice)
            Log.d(TAG, "AudioManager: mode=IN_COMMUNICATION setCommunicationDevice(SPEAKER) success=$success")
        } else {
            // TYPE_BUILTIN_SPEAKER not in availableCommunicationDevices (can happen on PoC devices
            // like Inrico T320 before audio session fully initialises). Fall back to the deprecated
            // setSpeakerphoneOn which still works on all API levels.
            Log.w(TAG, "AudioManager: TYPE_BUILTIN_SPEAKER not available — using legacy setSpeakerphoneOn fallback")
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = true
        }
    }

    @Suppress("DEPRECATION")
    private fun enableSpeakerphoneLegacy() {
        // API 26–30: setSpeakerphoneOn was deprecated in API 34; on these older OS versions
        // there is no alternative. MODE_IN_COMMUNICATION is required by WebRTC on these APIs.
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isSpeakerphoneOn = true
        Log.d(TAG, "AudioManager: mode=IN_COMMUNICATION speakerphone=ON (legacy API)")
    }

    private fun restoreAudio() {
        stopWatchdog()
        radioDsp.disable()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            restoreAudioModern()
        } else {
            restoreAudioLegacy()
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun restoreAudioModern() {
        audioManager.clearCommunicationDevice()
        audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
        audioManager.mode = AudioManager.MODE_NORMAL
        Log.d(TAG, "AudioManager: clearCommunicationDevice() + audio focus abandoned + mode=NORMAL")
    }

    @Suppress("DEPRECATION")
    private fun restoreAudioLegacy() {
        audioManager.isSpeakerphoneOn = false
        audioManager.mode = AudioManager.MODE_NORMAL
        @Suppress("DEPRECATION")
        audioManager.abandonAudioFocus(audioFocusListener)
        Log.d(TAG, "AudioManager: mode=NORMAL speakerphone=OFF audio focus abandoned (legacy API)")
    }

    private fun observeRoomEvents(room: Room) {
        eventJob?.cancel()
        eventJob = scope.launch {
            room.events.collect { event ->
                when (event) {
                    is RoomEvent.Disconnected -> {
                        Log.d(TAG, "Room disconnected: ${event.error?.message}")
                        isTransmitting = false
                        this@PttAudioEngine.room = null
                        restoreAudio()
                        if (!expectingDisconnect) {
                            Log.d(TAG, "Unexpected LiveKit disconnect — notifying service")
                            onDisconnected?.invoke()
                        }
                        expectingDisconnect = false
                    }
                    else -> {}
                }
            }
        }
    }

    suspend fun startTransmit(): Boolean =
        withContext(Dispatchers.Main) {
            val r = room ?: run {
                Log.w(TAG, "startTransmit: no room connected")
                return@withContext false
            }
            if (isTransmitting) return@withContext true
            runCatching {
                r.localParticipant.setMicrophoneEnabled(true)
                isTransmitting = true
                Log.d(TAG, "PttAudioEngine TX START")
                true
            }.getOrElse {
                Log.e(TAG, "startTransmit error: ${it.message}", it)
                false
            }
        }

    suspend fun stopTransmit() =
        withContext(Dispatchers.Main) {
            val r = room ?: return@withContext
            if (!isTransmitting) return@withContext
            runCatching {
                r.localParticipant.setMicrophoneEnabled(false)
                isTransmitting = false
                Log.d(TAG, "PttAudioEngine TX STOP")
            }.onFailure { Log.e(TAG, "stopTransmit error: ${it.message}", it) }
        }

    fun disconnect() {
        runCatching {
            expectingDisconnect = true
            isTransmitting = false
            eventJob?.cancel()
            eventJob = null
            room?.disconnect()
            room = null
            restoreAudio()
            Log.d(TAG, "PttAudioEngine disconnected")
        }.onFailure { Log.e(TAG, "disconnect error: ${it.message}", it) }
    }

    fun release() {
        disconnect()
        scope.cancel()
    }
}
