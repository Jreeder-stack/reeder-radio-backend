package com.reedersystems.commandcomms

import android.Manifest
import android.content.Context
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.util.LoggingLevel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest

@CapacitorPlugin(
    name = "NativeLiveKit",
    permissions = [
        Permission(
            alias = "microphone",
            strings = [Manifest.permission.RECORD_AUDIO]
        ),
        Permission(
            alias = "audioSettings", 
            strings = [Manifest.permission.MODIFY_AUDIO_SETTINGS]
        )
    ]
)
class LiveKitPlugin : Plugin() {
    
    companion object {
        private const val TAG = "LiveKitPlugin"
        private const val DIAG_TAG = "PTT-DIAG"

        @Volatile
        private var instance: LiveKitPlugin? = null

        @JvmStatic
        fun getInstance(): LiveKitPlugin? = instance
    }
    
    private var room: Room? = null
    private val pluginScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var isConnectedState = false
    private var isMicEnabledState = false
    private var currentChannelName: String? = null
    private var audioManager: AudioManager? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL
    private var wasSpeakerphoneOn: Boolean = false
    private var localAudioTrack: LocalAudioTrack? = null
    
    override fun load() {
        super.load()
        instance = this
        Log.d(TAG, "LiveKitPlugin loaded (instance set)")
        Log.d(DIAG_TAG, "LiveKitPlugin instance registered")
        LiveKit.loggingLevel = LoggingLevel.DEBUG
        
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }

    fun isRoomConnected(): Boolean = isConnectedState
    fun isMicTransmitting(): Boolean = isMicEnabledState
    fun getActiveChannel(): String? = currentChannelName

    fun startTransmit(): Boolean {
        val currentRoom = room
        Log.d(DIAG_TAG, "startTransmit() called — connected=$isConnectedState, room=${currentRoom != null}, channel=$currentChannelName")
        
        if (!isConnectedState || currentRoom == null) {
            Log.w(DIAG_TAG, "startTransmit() FAILED — not connected to a room")
            return false
        }
        
        if (isMicEnabledState) {
            Log.d(DIAG_TAG, "startTransmit() — already transmitting, ignoring")
            return true
        }
        
        pluginScope.launch {
            try {
                localAudioTrack?.let { track ->
                    Log.d(DIAG_TAG, "startTransmit() — cleaning up existing track")
                    try {
                        currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                    } catch (e: Exception) {
                        Log.w(DIAG_TAG, "startTransmit() — error unpublishing old track: ${e.message}")
                    }
                    localAudioTrack = null
                }
                
                val track = currentRoom.localParticipant.createAudioTrack("microphone")
                localAudioTrack = track
                currentRoom.localParticipant.publishAudioTrack(track)
                
                isMicEnabledState = true
                Log.d(DIAG_TAG, "startTransmit() SUCCESS — audio track published to $currentChannelName")
                
                try {
                    val result = JSObject().apply {
                        put("success", true)
                        put("enabled", true)
                    }
                    notifyListeners("microphoneEnabled", result)
                } catch (e: Exception) {
                    Log.d(DIAG_TAG, "startTransmit() — UI notify skipped (bridge unavailable): ${e.message}")
                }
                
            } catch (e: Exception) {
                Log.e(DIAG_TAG, "startTransmit() FAILED — ${e.message}", e)
            }
        }
        
        return true
    }

    fun stopTransmit(): Boolean {
        val currentRoom = room
        Log.d(DIAG_TAG, "stopTransmit() called — connected=$isConnectedState, mic=$isMicEnabledState")
        
        if (!isConnectedState || currentRoom == null) {
            Log.w(DIAG_TAG, "stopTransmit() — not connected, clearing mic state")
            isMicEnabledState = false
            return false
        }
        
        if (!isMicEnabledState) {
            Log.d(DIAG_TAG, "stopTransmit() — not transmitting, ignoring")
            return true
        }
        
        pluginScope.launch {
            try {
                localAudioTrack?.let { track ->
                    Log.d(DIAG_TAG, "stopTransmit() — unpublishing audio track")
                    currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                    localAudioTrack = null
                    Log.d(DIAG_TAG, "stopTransmit() SUCCESS — audio track unpublished")
                } ?: run {
                    Log.w(DIAG_TAG, "stopTransmit() — no audio track to unpublish")
                }
                
                isMicEnabledState = false
                
                try {
                    val result = JSObject().apply {
                        put("success", true)
                        put("enabled", false)
                    }
                    notifyListeners("microphoneDisabled", result)
                } catch (e: Exception) {
                    Log.d(DIAG_TAG, "stopTransmit() — UI notify skipped (bridge unavailable): ${e.message}")
                }
                
            } catch (e: Exception) {
                Log.e(DIAG_TAG, "stopTransmit() FAILED — ${e.message}", e)
            }
        }
        
        return true
    }

    private fun configureAudioForSpeaker() {
        audioManager?.let { am ->
            Log.d(TAG, "Configuring audio for speakerphone")
            
            previousAudioMode = am.mode
            wasSpeakerphoneOn = am.isSpeakerphoneOn
            
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            am.isSpeakerphoneOn = true
            
            val maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
            val currentVolume = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
            Log.d(TAG, "Voice call volume: $currentVolume / $maxVolume")
            
            val targetVolume = (maxVolume * 0.8).toInt()
            if (currentVolume < targetVolume) {
                am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, targetVolume, 0)
                Log.d(TAG, "Boosted voice call volume to $targetVolume")
            }
            
            Log.d(TAG, "Audio configured: speakerphone=${am.isSpeakerphoneOn}, mode=${am.mode}")
        }
    }
    
    private fun restoreAudioSettings() {
        audioManager?.let { am ->
            Log.d(TAG, "Restoring audio settings")
            am.mode = previousAudioMode
            am.isSpeakerphoneOn = wasSpeakerphoneOn
        }
    }
    
    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url")
        val token = call.getString("token")
        val channelName = call.getString("channelName") ?: "unknown"
        
        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            call.reject("Missing url or token parameter")
            return
        }
        
        Log.d(DIAG_TAG, "connect() called via Capacitor bridge — channel=$channelName url=$url")
        
        pluginScope.launch {
            try {
                room?.let {
                    Log.d(DIAG_TAG, "connect() — disconnecting from previous room")
                    it.disconnect()
                }
                room = null
                
                configureAudioForSpeaker()
                
                val newRoom = LiveKit.create(context)
                currentChannelName = channelName
                
                launch {
                    setupRoomListeners(newRoom)
                }
                
                Log.d(DIAG_TAG, "connect() — calling room.connect()...")
                newRoom.connect(url, token)
                Log.d(DIAG_TAG, "connect() — room.connect() completed successfully")
                
                room = newRoom
                isConnectedState = true
                
                Log.d(DIAG_TAG, "connect() SUCCESS — LiveKit CONNECTED to room: $channelName")
                
                val result = JSObject().apply {
                    put("success", true)
                    put("channelName", channelName)
                }
                
                call.resolve(result)
                notifyListeners("connected", result)
                
            } catch (e: Exception) {
                Log.e(DIAG_TAG, "connect() FAILED — ${e.message}", e)
                isConnectedState = false
                call.reject("Failed to connect: ${e.message}")
            }
        }
    }
    
    @PluginMethod
    fun disconnect(call: PluginCall) {
        Log.d(DIAG_TAG, "disconnect() called via Capacitor bridge — channel=$currentChannelName connected=$isConnectedState")
        
        pluginScope.launch {
            try {
                localAudioTrack?.let { track ->
                    Log.d(DIAG_TAG, "disconnect() — cleaning up audio track before disconnect")
                    try {
                        room?.localParticipant?.unpublishTrack(track, stopOnUnpublish = true)
                    } catch (e: Exception) {
                        Log.w(DIAG_TAG, "disconnect() — error unpublishing track: ${e.message}")
                    }
                    localAudioTrack = null
                }
                
                room?.disconnect()
                room = null
                
                isConnectedState = false
                isMicEnabledState = false
                currentChannelName = null
                
                restoreAudioSettings()
                
                Log.d(DIAG_TAG, "LiveKit DISCONNECTED")
                
                val result = JSObject().apply {
                    put("success", true)
                }
                
                call.resolve(result)
                notifyListeners("disconnected", result)
                
            } catch (e: Exception) {
                Log.e(DIAG_TAG, "disconnect() FAILED — ${e.message}", e)
                call.reject("Failed to disconnect: ${e.message}")
            }
        }
    }
    
    @PluginMethod
    fun enableMicrophone(call: PluginCall) {
        Log.d(DIAG_TAG, "enableMicrophone() called via Capacitor bridge — connected=$isConnectedState channel=$currentChannelName")
        
        val currentRoom = room
        if (!isConnectedState || currentRoom == null) {
            Log.w(DIAG_TAG, "enableMicrophone() REJECTED — not connected to a room")
            call.reject("Not connected to a room")
            return
        }
        
        pluginScope.launch {
            try {
                localAudioTrack?.let { track ->
                    Log.d(DIAG_TAG, "enableMicrophone() — cleaning up existing audio track")
                    try {
                        currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                    } catch (e: Exception) {
                        Log.w(DIAG_TAG, "enableMicrophone() — error unpublishing existing track: ${e.message}")
                    }
                    localAudioTrack = null
                }
                
                val track = currentRoom.localParticipant.createAudioTrack("microphone")
                localAudioTrack = track
                currentRoom.localParticipant.publishAudioTrack(track)
                
                isMicEnabledState = true
                
                Log.d(DIAG_TAG, "enableMicrophone() SUCCESS — audio track published to $currentChannelName")
                
                val result = JSObject().apply {
                    put("success", true)
                    put("enabled", true)
                }
                
                call.resolve(result)
                notifyListeners("microphoneEnabled", result)
                
            } catch (e: Exception) {
                Log.e(DIAG_TAG, "enableMicrophone() FAILED — ${e.message}", e)
                call.reject("Failed to enable microphone: ${e.message}")
            }
        }
    }
    
    @PluginMethod
    fun disableMicrophone(call: PluginCall) {
        Log.d(DIAG_TAG, "disableMicrophone() called via Capacitor bridge — connected=$isConnectedState mic=$isMicEnabledState channel=$currentChannelName")
        
        val currentRoom = room
        if (!isConnectedState || currentRoom == null) {
            Log.w(DIAG_TAG, "disableMicrophone() REJECTED — not connected to a room")
            call.reject("Not connected to a room")
            return
        }
        
        pluginScope.launch {
            try {
                localAudioTrack?.let { track ->
                    Log.d(DIAG_TAG, "disableMicrophone() — unpublishing audio track")
                    currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                    
                    localAudioTrack = null
                    Log.d(DIAG_TAG, "disableMicrophone() SUCCESS — audio track unpublished")
                } ?: run {
                    Log.w(DIAG_TAG, "disableMicrophone() — no audio track to unpublish")
                }
                
                isMicEnabledState = false
                
                val result = JSObject().apply {
                    put("success", true)
                    put("enabled", false)
                }
                
                call.resolve(result)
                notifyListeners("microphoneDisabled", result)
                
            } catch (e: Exception) {
                Log.e(DIAG_TAG, "disableMicrophone() FAILED — ${e.message}", e)
                call.reject("Failed to disable microphone: ${e.message}")
            }
        }
    }
    
    @PluginMethod
    fun getState(call: PluginCall) {
        val result = JSObject().apply {
            put("isConnected", isConnectedState)
            put("isMicEnabled", isMicEnabledState)
            put("currentChannel", currentChannelName)
            room?.let {
                put("roomState", it.state.name)
            }
        }
        call.resolve(result)
    }
    
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val result = JSObject().apply {
            put("available", true)
            put("platform", "android")
        }
        call.resolve(result)
    }
    
    private suspend fun setupRoomListeners(room: Room) {
        room.events.collect { event ->
            when (event) {
                is RoomEvent.Disconnected -> {
                    Log.d(TAG, "Room disconnected: ${event.reason}")
                    Log.d(DIAG_TAG, "LiveKit room DISCONNECTED: ${event.reason}")
                    isConnectedState = false
                    isMicEnabledState = false
                    notifyListeners("disconnected", JSObject().apply {
                        put("reason", event.reason?.name ?: "unknown")
                    })
                }
                is RoomEvent.Reconnecting -> {
                    Log.d(TAG, "Room reconnecting...")
                    notifyListeners("reconnecting", JSObject())
                }
                is RoomEvent.Reconnected -> {
                    Log.d(TAG, "Room reconnected")
                    Log.d(DIAG_TAG, "LiveKit room RECONNECTED")
                    isConnectedState = true
                    notifyListeners("reconnected", JSObject())
                }
                is RoomEvent.ParticipantConnected -> {
                    Log.d(TAG, "Participant connected: ${event.participant.identity}")
                    notifyListeners("participantConnected", JSObject().apply {
                        put("identity", event.participant.identity?.value ?: "unknown")
                    })
                }
                is RoomEvent.ParticipantDisconnected -> {
                    Log.d(TAG, "Participant disconnected: ${event.participant.identity}")
                    notifyListeners("participantDisconnected", JSObject().apply {
                        put("identity", event.participant.identity?.value ?: "unknown")
                    })
                }
                is RoomEvent.TrackSubscribed -> {
                    if (event.track.kind == io.livekit.android.room.track.Track.Kind.AUDIO) {
                        Log.d(TAG, "Audio track subscribed from: ${event.participant.identity}")
                    }
                }
                is RoomEvent.TrackUnsubscribed -> {
                    if (event.track.kind == io.livekit.android.room.track.Track.Kind.AUDIO) {
                        val identity = event.participant.identity?.value ?: "unknown"
                        Log.d(TAG, "Audio track unsubscribed from: $identity - clearing receiving state")
                        notifyListeners("trackUnsubscribed", JSObject().apply {
                            put("identity", identity)
                            put("kind", "audio")
                        })
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", "")
                            put("speaking", false)
                        })
                    }
                }
                is RoomEvent.TrackMuted -> {
                    if (event.publication.kind == io.livekit.android.room.track.Track.Kind.AUDIO) {
                        val identity = event.participant.identity?.value ?: "unknown"
                        Log.d(TAG, "Audio track muted from: $identity")
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", "")
                            put("speaking", false)
                        })
                    }
                }
                is RoomEvent.ActiveSpeakersChanged -> {
                    val speakers = event.speakers.filter { it.identity?.value != room.localParticipant.identity?.value }
                    Log.d(TAG, "Active speakers changed: ${speakers.map { it.identity?.value }}")
                    
                    if (speakers.isNotEmpty()) {
                        val speaker = speakers.first()
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", speaker.identity?.value ?: "unknown")
                            put("speaking", true)
                        })
                    } else {
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", "")
                            put("speaking", false)
                        })
                    }
                }
                else -> {
                }
            }
        }
    }
    
    @PluginMethod
    fun setSpeakerphone(call: PluginCall) {
        val enabled = call.getBoolean("enabled", true) ?: true
        
        audioManager?.let { am ->
            am.isSpeakerphoneOn = enabled
            Log.d(TAG, "Speakerphone set to: $enabled")
            
            val result = JSObject().apply {
                put("success", true)
                put("enabled", enabled)
            }
            call.resolve(result)
        } ?: run {
            call.reject("AudioManager not available")
        }
    }
    
    override fun handleOnDestroy() {
        super.handleOnDestroy()
        
        localAudioTrack?.let { track ->
            try {
                room?.localParticipant?.unpublishTrack(track, stopOnUnpublish = true)
            } catch (e: Exception) {
                Log.w(TAG, "Error unpublishing track on destroy: ${e.message}")
            }
            localAudioTrack = null
        }
        
        restoreAudioSettings()
        
        pluginScope.launch {
            room?.disconnect()
            room = null
        }
        
        pluginScope.launch {
            delay(500)
            pluginScope.cancel()
        }
        
        instance = null
        Log.d(DIAG_TAG, "LiveKitPlugin instance cleared (destroyed)")
    }
}
