package com.reedersystems.commandcomms

import android.content.Context
import android.media.AudioManager
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import io.livekit.android.events.collect
import kotlinx.coroutines.launch

class NativeRadioEngine private constructor(context: Context) {

    interface Listener {
        fun onEngineEvent(event: String, data: Map<String, Any?> = emptyMap())
    }

    companion object {
        private const val TAG = "NativeRadioEngine"
        private const val DIAG_TAG = "PTT-DIAG"

        @Volatile
        private var instance: NativeRadioEngine? = null

        @JvmStatic
        fun getInstance(context: Context): NativeRadioEngine {
            return instance ?: synchronized(this) {
                instance ?: NativeRadioEngine(context.applicationContext).also {
                    instance = it
                    Log.d(DIAG_TAG, "NativeRadioEngine initialized")
                }
            }
        }

        @JvmStatic
        fun peekInstance(): NativeRadioEngine? = instance
    }

    private val appContext = context.applicationContext
    private val engineScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private val listeners = mutableSetOf<Listener>()

    private val audioManager: AudioManager =
        appContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var room: Room? = null
    @Volatile private var isConnectedState = false
    @Volatile private var isMicEnabledState = false
    @Volatile private var currentChannelName: String? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL
    private var wasSpeakerphoneOn: Boolean = false
    private var localAudioTrack: LocalAudioTrack? = null

    fun addListener(listener: Listener) {
        synchronized(listeners) { listeners.add(listener) }
    }

    fun removeListener(listener: Listener) {
        synchronized(listeners) { listeners.remove(listener) }
    }

    fun isConnected(): Boolean = isConnectedState
    fun isMicEnabled(): Boolean = isMicEnabledState
    fun getActiveChannel(): String? = currentChannelName

    fun connect(url: String, token: String, channelName: String): Boolean {
        engineScope.launch { connectSuspend(url, token, channelName) }
        return true
    }

    suspend fun connectSuspend(url: String, token: String, channelName: String): Boolean {
        Log.d(DIAG_TAG, "engine.connect() — url=$url channel=$channelName")
        return try {
            room?.disconnect()
            room = null
            configureAudioForSpeaker()

            val newRoom = LiveKit.create(appContext)
            currentChannelName = channelName
            setupRoomListeners(newRoom)
            newRoom.connect(url, token)
            room = newRoom
            isConnectedState = true
            emit("connected", mapOf("success" to true, "channelName" to channelName))
            Log.d(DIAG_TAG, "engine.connect() SUCCESS — channel=$channelName")
            true
        } catch (e: Exception) {
            isConnectedState = false
            Log.e(DIAG_TAG, "engine.connect() FAILED — ${e.message}", e)
            false
        }
    }

    fun disconnect(): Boolean {
        engineScope.launch { disconnectSuspend() }
        return true
    }

    suspend fun disconnectSuspend(): Boolean {
        return try {
            localAudioTrack?.let { track ->
                try {
                    room?.localParticipant?.unpublishTrack(track, stopOnUnpublish = true)
                } catch (e: Exception) {
                    Log.w(DIAG_TAG, "engine.disconnect() — unpublish error: ${e.message}")
                }
            }
            localAudioTrack = null
            room?.disconnect()
            room = null
            isConnectedState = false
            isMicEnabledState = false
            currentChannelName = null
            restoreAudioSettings()
            emit("disconnected", mapOf("success" to true))
            Log.d(DIAG_TAG, "engine.disconnect() SUCCESS")
            true
        } catch (e: Exception) {
            Log.e(DIAG_TAG, "engine.disconnect() FAILED — ${e.message}", e)
            false
        }
    }

    fun startTransmit(): Boolean {
        engineScope.launch { startTransmitSuspend() }
        return true
    }

    suspend fun startTransmitSuspend(): Boolean {
        val currentRoom = room
        if (!isConnectedState || currentRoom == null) {
            Log.w(DIAG_TAG, "engine.startTransmit() FAILED — not connected")
            return false
        }
        if (isMicEnabledState) {
            return true
        }

        return try {
            localAudioTrack?.let { track ->
                try {
                    currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                } catch (e: Exception) {
                    Log.w(DIAG_TAG, "engine.startTransmit() — old track cleanup failed: ${e.message}")
                }
            }
            val track = currentRoom.localParticipant.createAudioTrack("microphone")
            localAudioTrack = track
            currentRoom.localParticipant.publishAudioTrack(track)
            isMicEnabledState = true
            emit("microphoneEnabled", mapOf("success" to true, "enabled" to true))
            Log.d(DIAG_TAG, "engine.startTransmit() SUCCESS")
            true
        } catch (e: Exception) {
            Log.e(DIAG_TAG, "engine.startTransmit() FAILED — ${e.message}", e)
            false
        }
    }

    fun stopTransmit(): Boolean {
        engineScope.launch { stopTransmitSuspend() }
        return true
    }

    suspend fun stopTransmitSuspend(): Boolean {
        val currentRoom = room
        if (!isConnectedState || currentRoom == null) {
            isMicEnabledState = false
            Log.w(DIAG_TAG, "engine.stopTransmit() — not connected")
            return false
        }
        if (!isMicEnabledState) {
            return true
        }

        return try {
            localAudioTrack?.let { track ->
                currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
            }
            localAudioTrack = null
            isMicEnabledState = false
            emit("microphoneDisabled", mapOf("success" to true, "enabled" to false))
            Log.d(DIAG_TAG, "engine.stopTransmit() SUCCESS")
            true
        } catch (e: Exception) {
            Log.e(DIAG_TAG, "engine.stopTransmit() FAILED — ${e.message}", e)
            false
        }
    }

    fun shutdown() {
        engineScope.launch { disconnectSuspend() }
        engineScope.cancel()
    }

    private fun emit(event: String, data: Map<String, Any?> = emptyMap()) {
        val snapshot = synchronized(listeners) { listeners.toList() }
        snapshot.forEach { listener ->
            try {
                listener.onEngineEvent(event, data)
            } catch (e: Exception) {
                Log.w(TAG, "Listener error for $event: ${e.message}")
            }
        }
    }

    private fun configureAudioForSpeaker() {
        previousAudioMode = audioManager.mode
        wasSpeakerphoneOn = audioManager.isSpeakerphoneOn
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isSpeakerphoneOn = true
    }

    private fun restoreAudioSettings() {
        audioManager.mode = previousAudioMode
        audioManager.isSpeakerphoneOn = wasSpeakerphoneOn
    }

    private fun setupRoomListeners(room: Room) {
        room.events.collect(engineScope) { event: RoomEvent ->
            when (event) {
                is RoomEvent.Disconnected -> {
                    isConnectedState = false
                    isMicEnabledState = false
                    emit("disconnected", mapOf("reason" to (event.reason?.name ?: "unknown")))
                }
                is RoomEvent.Reconnecting -> emit("reconnecting")
                is RoomEvent.Reconnected -> {
                    isConnectedState = true
                    emit("reconnected")
                }
                is RoomEvent.ParticipantConnected -> emit(
                    "participantConnected",
                    mapOf("identity" to (event.participant.identity?.value ?: "unknown"))
                )
                is RoomEvent.ParticipantDisconnected -> emit(
                    "participantDisconnected",
                    mapOf("identity" to (event.participant.identity?.value ?: "unknown"))
                )
                is RoomEvent.TrackUnsubscribed -> {
                    if (event.track.kind == io.livekit.android.room.track.Track.Kind.AUDIO) {
                        val identity = event.participant.identity?.value ?: "unknown"
                        emit("trackUnsubscribed", mapOf("identity" to identity, "kind" to "audio"))
                        emit("activeSpeakerChanged", mapOf("identity" to "", "speaking" to false))
                    }
                }
                is RoomEvent.TrackMuted -> {
                    if (event.publication.kind == io.livekit.android.room.track.Track.Kind.AUDIO) {
                        emit("activeSpeakerChanged", mapOf("identity" to "", "speaking" to false))
                    }
                }
                is RoomEvent.ActiveSpeakersChanged -> {
                    val speakers = event.speakers.filter {
                        it.identity?.value != room.localParticipant.identity?.value
                    }
                    if (speakers.isNotEmpty()) {
                        val speaker = speakers.first()
                        emit(
                            "activeSpeakerChanged",
                            mapOf("identity" to (speaker.identity?.value ?: "unknown"), "speaking" to true)
                        )
                    } else {
                        emit("activeSpeakerChanged", mapOf("identity" to "", "speaking" to false))
                    }
                }
                else -> Unit
            }
        }
    }
}
