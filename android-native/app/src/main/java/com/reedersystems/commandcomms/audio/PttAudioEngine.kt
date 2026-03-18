package com.reedersystems.commandcomms.audio

import android.content.Context
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
                    Log.d(TAG, "PttAudioEngine connected")
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

    private fun observeRoomEvents(room: Room) {
        eventJob?.cancel()
        eventJob = scope.launch {
            room.events.collect { event ->
                when (event) {
                    is RoomEvent.Disconnected -> {
                        Log.d(TAG, "Room disconnected: ${event.error?.message}")
                        isTransmitting = false
                    }
                    else -> {}
                }
            }
        }
    }

    suspend fun startTransmit() =
        withContext(Dispatchers.Main) {
            val r = room ?: run {
                Log.w(TAG, "startTransmit: no room connected")
                return@withContext
            }
            if (isTransmitting) return@withContext
            runCatching {
                r.localParticipant.setMicrophoneEnabled(true)
                isTransmitting = true
                Log.d(TAG, "PttAudioEngine TX START")
            }.onFailure { Log.e(TAG, "startTransmit error: ${it.message}", it) }
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
            Log.d(TAG, "PttAudioEngine disconnected")
        }.onFailure { Log.e(TAG, "disconnect error: ${it.message}", it) }
    }

    fun release() {
        disconnect()
        scope.cancel()
    }
}
