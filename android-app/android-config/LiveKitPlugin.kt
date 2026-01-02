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

/**
 * Native LiveKit Capacitor Plugin for COMMAND COMMS
 * 
 * This plugin wraps the LiveKit Android SDK to bypass WebView WebRTC limitations.
 * Written in Kotlin to properly handle LiveKit's suspend functions via coroutines.
 * 
 * Installation:
 * 1. Copy to android/app/src/main/java/com/reedersystems/commandcomms/
 * 2. Add LiveKit SDK to android/app/build.gradle:
 *    implementation "io.livekit:livekit-android:2.5.0"
 * 3. Enable Kotlin in the Android project
 * 4. Register plugin in MainActivity.java:
 *    registerPlugin(LiveKitPlugin.class);
 */
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
    }
    
    private var room: Room? = null
    private val pluginScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var isConnected = false
    private var isMicEnabled = false
    private var currentChannel: String? = null
    private var audioManager: AudioManager? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL
    private var wasSpeakerphoneOn: Boolean = false
    private var localAudioTrack: LocalAudioTrack? = null
    
    override fun load() {
        super.load()
        Log.d(TAG, "LiveKitPlugin loaded")
        LiveKit.loggingLevel = LoggingLevel.DEBUG
        
        // Get audio manager for speaker control
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    }
    
    /**
     * Configure audio for speakerphone output at maximum volume
     */
    private fun configureAudioForSpeaker() {
        audioManager?.let { am ->
            Log.d(TAG, "Configuring audio for speakerphone")
            
            // Save current state to restore later
            previousAudioMode = am.mode
            wasSpeakerphoneOn = am.isSpeakerphoneOn
            
            // Set mode to communication for voice
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            
            // Enable speakerphone for louder output
            am.isSpeakerphoneOn = true
            
            // Set media volume to max for louder playback
            val maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
            val currentVolume = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
            Log.d(TAG, "Voice call volume: $currentVolume / $maxVolume")
            
            // Boost to at least 80% volume if lower
            val targetVolume = (maxVolume * 0.8).toInt()
            if (currentVolume < targetVolume) {
                am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, targetVolume, 0)
                Log.d(TAG, "Boosted voice call volume to $targetVolume")
            }
            
            Log.d(TAG, "Audio configured: speakerphone=${am.isSpeakerphoneOn}, mode=${am.mode}")
        }
    }
    
    /**
     * Restore audio settings when disconnecting
     */
    private fun restoreAudioSettings() {
        audioManager?.let { am ->
            Log.d(TAG, "Restoring audio settings")
            am.mode = previousAudioMode
            am.isSpeakerphoneOn = wasSpeakerphoneOn
        }
    }
    
    /**
     * Connect to a LiveKit room
     * 
     * @param url - LiveKit server WebSocket URL (wss://...)
     * @param token - JWT token for authentication
     * @param channelName - Name of the channel (for logging/events)
     */
    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url")
        val token = call.getString("token")
        val channelName = call.getString("channelName") ?: "unknown"
        
        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            call.reject("Missing url or token parameter")
            return
        }
        
        Log.d(TAG, "Connecting to LiveKit room: $channelName")
        
        pluginScope.launch {
            try {
                // Disconnect from previous room if any
                room?.let {
                    Log.d(TAG, "Disconnecting from previous room")
                    it.disconnect()
                }
                room = null
                
                // Configure audio for speakerphone before connecting
                configureAudioForSpeaker()
                
                // Create new room
                val newRoom = LiveKit.create(context)
                currentChannel = channelName
                
                // Set up event collection in a separate coroutine
                launch {
                    setupRoomListeners(newRoom)
                }
                
                // Connect to room (this is a suspend function)
                Log.d(TAG, "Calling room.connect()...")
                newRoom.connect(url, token)
                Log.d(TAG, "room.connect() completed successfully")
                
                room = newRoom
                isConnected = true
                
                Log.d(TAG, "Connected to LiveKit room: $channelName")
                
                val result = JSObject().apply {
                    put("success", true)
                    put("channelName", channelName)
                }
                
                call.resolve(result)
                notifyListeners("connected", result)
                
            } catch (e: Exception) {
                Log.e(TAG, "Failed to connect to LiveKit", e)
                isConnected = false
                call.reject("Failed to connect: ${e.message}")
            }
        }
    }
    
    /**
     * Disconnect from the current room
     */
    @PluginMethod
    fun disconnect(call: PluginCall) {
        Log.d(TAG, "Disconnecting from LiveKit room")
        
        pluginScope.launch {
            try {
                // Clean up audio track first
                localAudioTrack?.let { track ->
                    Log.d(TAG, "Cleaning up audio track before disconnect")
                    try {
                        room?.localParticipant?.unpublishTrack(track, stopOnUnpublish = true)
                    } catch (e: Exception) {
                        Log.w(TAG, "Error unpublishing track on disconnect: ${e.message}")
                    }
                    localAudioTrack = null
                }
                
                room?.disconnect()
                room = null
                
                isConnected = false
                isMicEnabled = false
                currentChannel = null
                
                // Restore audio settings
                restoreAudioSettings()
                
                val result = JSObject().apply {
                    put("success", true)
                }
                
                call.resolve(result)
                notifyListeners("disconnected", result)
                
            } catch (e: Exception) {
                Log.e(TAG, "Error disconnecting", e)
                call.reject("Failed to disconnect: ${e.message}")
            }
        }
    }
    
    /**
     * Enable microphone (start transmitting) - creates and publishes a fresh audio track
     */
    @PluginMethod
    fun enableMicrophone(call: PluginCall) {
        Log.d(TAG, "Enabling microphone - creating and publishing audio track")
        
        val currentRoom = room
        if (!isConnected || currentRoom == null) {
            call.reject("Not connected to a room")
            return
        }
        
        pluginScope.launch {
            try {
                // Clean up any existing track first
                localAudioTrack?.let { track ->
                    Log.d(TAG, "Cleaning up existing audio track before creating new one")
                    try {
                        // unpublishTrack with stopOnUnpublish=true handles stopping
                        currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                    } catch (e: Exception) {
                        Log.w(TAG, "Error unpublishing existing track: ${e.message}")
                    }
                    localAudioTrack = null
                }
                
                // Create a fresh audio track via LocalParticipant
                val track = currentRoom.localParticipant.createAudioTrack("microphone")
                localAudioTrack = track
                
                // Publish the track to the room
                currentRoom.localParticipant.publishAudioTrack(track)
                
                isMicEnabled = true
                
                Log.d(TAG, "Audio track created and published successfully")
                
                val result = JSObject().apply {
                    put("success", true)
                    put("enabled", true)
                }
                
                call.resolve(result)
                notifyListeners("microphoneEnabled", result)
                
            } catch (e: Exception) {
                Log.e(TAG, "Failed to enable microphone", e)
                call.reject("Failed to enable microphone: ${e.message}")
            }
        }
    }
    
    /**
     * Disable microphone (stop transmitting) - unpublishes and stops the audio track
     */
    @PluginMethod
    fun disableMicrophone(call: PluginCall) {
        Log.d(TAG, "Disabling microphone - unpublishing audio track")
        
        val currentRoom = room
        if (!isConnected || currentRoom == null) {
            call.reject("Not connected to a room")
            return
        }
        
        pluginScope.launch {
            try {
                // Unpublish and stop the audio track (stopOnUnpublish=true handles cleanup)
                localAudioTrack?.let { track ->
                    Log.d(TAG, "Unpublishing audio track with stopOnUnpublish=true")
                    currentRoom.localParticipant.unpublishTrack(track, stopOnUnpublish = true)
                    
                    localAudioTrack = null
                    Log.d(TAG, "Audio track unpublished and stopped")
                } ?: run {
                    Log.w(TAG, "No audio track to unpublish")
                }
                
                isMicEnabled = false
                
                val result = JSObject().apply {
                    put("success", true)
                    put("enabled", false)
                }
                
                call.resolve(result)
                notifyListeners("microphoneDisabled", result)
                
            } catch (e: Exception) {
                Log.e(TAG, "Failed to disable microphone", e)
                call.reject("Failed to disable microphone: ${e.message}")
            }
        }
    }
    
    /**
     * Get current connection state
     */
    @PluginMethod
    fun getState(call: PluginCall) {
        val result = JSObject().apply {
            put("isConnected", isConnected)
            put("isMicEnabled", isMicEnabled)
            put("currentChannel", currentChannel)
            room?.let {
                put("roomState", it.state.name)
            }
        }
        call.resolve(result)
    }
    
    /**
     * Check if native LiveKit is available
     */
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
                    isConnected = false
                    isMicEnabled = false
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
                    isConnected = true
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
                        // Emit event to clear receiving state as fallback when ActiveSpeakersChanged doesn't fire
                        notifyListeners("trackUnsubscribed", JSObject().apply {
                            put("identity", identity)
                            put("kind", "audio")
                        })
                        // Also emit activeSpeakerChanged with speaking=false as immediate fallback
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
                        // When someone mutes, they're no longer speaking
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", "")
                            put("speaking", false)
                        })
                    }
                }
                is RoomEvent.ActiveSpeakersChanged -> {
                    // This is the key event - it fires when someone starts/stops speaking
                    val speakers = event.speakers.filter { it.identity?.value != room.localParticipant.identity?.value }
                    Log.d(TAG, "Active speakers changed: ${speakers.map { it.identity?.value }}")
                    
                    if (speakers.isNotEmpty()) {
                        // Someone is speaking
                        val speaker = speakers.first()
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", speaker.identity?.value ?: "unknown")
                            put("speaking", true)
                        })
                    } else {
                        // No one is speaking
                        notifyListeners("activeSpeakerChanged", JSObject().apply {
                            put("identity", "")
                            put("speaking", false)
                        })
                    }
                }
                else -> {
                    // Handle other events as needed
                }
            }
        }
    }
    
    /**
     * Set speakerphone on or off
     */
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
        
        // Clean up audio track
        localAudioTrack?.let { track ->
            try {
                room?.localParticipant?.unpublishTrack(track, stopOnUnpublish = true)
            } catch (e: Exception) {
                Log.w(TAG, "Error unpublishing track on destroy: ${e.message}")
            }
            localAudioTrack = null
        }
        
        // Restore audio settings
        restoreAudioSettings()
        
        pluginScope.launch {
            room?.disconnect()
            room = null
        }
        
        // Cancel the scope after a small delay to let disconnect complete
        pluginScope.launch {
            delay(500)
            pluginScope.cancel()
        }
    }
}
