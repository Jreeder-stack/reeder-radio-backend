package com.reedersystems.commandcomms.audio

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import kotlinx.coroutines.*

private const val TAG = "[PTT-DIAG]"
private const val CONNECT_TIMEOUT_MS = 5_000L

class PttAudioEngine(private val context: Context) {

    private var room: Room? = null
    private var isTransmitting = false
    private var eventJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    val isConnected: Boolean
        get() = room?.state == Room.State.CONNECTED

    suspend fun connect(livekitUrl: String, token: String): Boolean =
        withContext(Dispatchers.Main) {
            runCatching {
                Log.d(TAG, "PttAudioEngine.connect() url=$livekitUrl")
                val newRoom = LiveKit.create(appContext = context)

                val connected = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                    newRoom.connect(url = livekitUrl, token = token)
                    true
                }

                if (connected == true) {
                    room = newRoom
                    observeRoomEvents(newRoom)
                    enableSpeakerphone()
                    Log.d(TAG, "PttAudioEngine connected — speakerphone enabled")
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

    private fun enableSpeakerphone() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val speakerDevice = audioManager.availableCommunicationDevices
                .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (speakerDevice != null) {
                val success = audioManager.setCommunicationDevice(speakerDevice)
                Log.d(TAG, "AudioManager: setCommunicationDevice(SPEAKER) success=$success")
            } else {
                Log.w(TAG, "AudioManager: TYPE_BUILTIN_SPEAKER not available — no routing change")
            }
        } else {
            // API 26–30: use the deprecated method. setSpeakerphoneOn was deprecated in API 34;
            // on these older OS versions there is no alternative.
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = true
            Log.d(TAG, "AudioManager: mode=IN_COMMUNICATION speakerphone=ON (legacy API)")
        }
    }

    private fun restoreAudio() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
            Log.d(TAG, "AudioManager: clearCommunicationDevice()")
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
            audioManager.mode = AudioManager.MODE_NORMAL
            Log.d(TAG, "AudioManager: mode=NORMAL speakerphone=OFF (legacy API)")
        }
    }

    private fun observeRoomEvents(room: Room) {
        eventJob?.cancel()
        eventJob = scope.launch {
            room.events.collect { event ->
                when (event) {
                    is RoomEvent.Disconnected -> {
                        Log.d(TAG, "Room disconnected: ${event.error?.message}")
                        isTransmitting = false
                        restoreAudio()
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
