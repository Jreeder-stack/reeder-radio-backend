package com.reedersystems.commandcomms

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.events.RoomEvent
import io.livekit.android.room.Room
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import io.livekit.android.events.collect
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val WATCHDOG_INTERVAL_MS = 500L

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
    private var roomEventsJob: Job? = null
    private var watchdogJob: Job? = null
    @Volatile private var isConnectedState = false
    @Volatile private var isMicEnabledState = false
    @Volatile private var currentChannelName: String? = null
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL
    private var wasSpeakerphoneOn: Boolean = false

    private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_GAIN,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT -> {
                Log.d(DIAG_TAG, "NativeRadioEngine: audio focus gained — re-asserting speakerphone")
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                enableSpeakerphone()
                setMaxVoiceCallVolume()
            }
            else -> {}
        }
    }

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
        Log.d(DIAG_TAG, "engine.connectSuspend() — url=$url channel=$channelName")
        return try {
            roomEventsJob?.cancel()
            roomEventsJob = null
            room?.disconnect()
            room = null
            configureAudioForSpeaker()

            val newRoom = LiveKit.create(appContext)
            currentChannelName = channelName
            newRoom.connect(url, token)
            room = newRoom
            isConnectedState = true
            roomEventsJob = setupRoomListeners(newRoom)

            // Re-apply routing at 300ms, 600ms, and 1500ms to catch all LiveKit init phases.
            engineScope.launch {
                delay(300)
                enableSpeakerphone()
                setMaxVoiceCallVolume()
                Log.d(DIAG_TAG, "engine: speaker routing re-applied after 300ms")
            }
            engineScope.launch {
                delay(600)
                enableSpeakerphone()
                setMaxVoiceCallVolume()
                Log.d(DIAG_TAG, "engine: speaker routing re-applied after 600ms")
            }
            engineScope.launch {
                delay(1500)
                enableSpeakerphone()
                setMaxVoiceCallVolume()
                Log.d(DIAG_TAG, "engine: speaker routing re-applied after 1500ms")
            }
            startWatchdog()

            emit("connected", mapOf("success" to true, "channelName" to channelName))
            Log.d(DIAG_TAG, "engine.connectSuspend() SUCCESS — channel=$channelName")
            true
        } catch (e: Exception) {
            isConnectedState = false
            stopWatchdog()
            restoreAudioSettings()
            Log.e(DIAG_TAG, "engine.connectSuspend() FAILED — ${e.javaClass.simpleName}: ${e.message}", e)
            false
        }
    }

    fun disconnect(): Boolean {
        engineScope.launch { disconnectSuspend() }
        return true
    }

    suspend fun disconnectSuspend(): Boolean {
        return try {
            val currentRoom = room
            if (isMicEnabledState && currentRoom != null) {
                try {
                    currentRoom.localParticipant.setMicrophoneEnabled(false)
                } catch (e: Exception) {
                    Log.w(DIAG_TAG, "engine.disconnectSuspend() — mic disable error: ${e.message}")
                }
            }
            isMicEnabledState = false
            stopWatchdog()
            roomEventsJob?.cancel()
            roomEventsJob = null
            room?.disconnect()
            room = null
            isConnectedState = false
            currentChannelName = null
            restoreAudioSettings()
            emit("disconnected", mapOf("success" to true))
            Log.d(DIAG_TAG, "engine.disconnectSuspend() SUCCESS")
            true
        } catch (e: Exception) {
            Log.e(DIAG_TAG, "engine.disconnectSuspend() FAILED — ${e.message}", e)
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
            Log.w(DIAG_TAG, "engine.startTransmitSuspend() FAILED — not connected (isConnected=$isConnectedState room=${currentRoom != null})")
            return false
        }
        if (isMicEnabledState) {
            Log.d(DIAG_TAG, "engine.startTransmitSuspend() — already transmitting")
            return true
        }

        return try {
            Log.d(DIAG_TAG, "engine.startTransmitSuspend() — calling setMicrophoneEnabled(true)")
            currentRoom.localParticipant.setMicrophoneEnabled(true)
            isMicEnabledState = true
            emit("microphoneEnabled", mapOf("success" to true, "enabled" to true))
            Log.d(DIAG_TAG, "engine.startTransmitSuspend() SUCCESS")
            true
        } catch (e: Exception) {
            Log.e(DIAG_TAG, "engine.startTransmitSuspend() FAILED — ${e.javaClass.simpleName}: ${e.message}", e)
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
            Log.w(DIAG_TAG, "engine.stopTransmitSuspend() — not connected, resetting state")
            return false
        }
        if (!isMicEnabledState) {
            Log.d(DIAG_TAG, "engine.stopTransmitSuspend() — not transmitting")
            return true
        }

        return try {
            Log.d(DIAG_TAG, "engine.stopTransmitSuspend() — calling setMicrophoneEnabled(false)")
            currentRoom.localParticipant.setMicrophoneEnabled(false)
            isMicEnabledState = false
            emit("microphoneDisabled", mapOf("success" to true, "enabled" to false))
            Log.d(DIAG_TAG, "engine.stopTransmitSuspend() SUCCESS")
            true
        } catch (e: Exception) {
            // Guard against Error -38 (dead AudioRecord object) when session is torn down
            // mid-read — always reset isMicEnabledState to prevent TX stuck open.
            isMicEnabledState = false
            emit("microphoneDisabled", mapOf("success" to false, "enabled" to false))
            Log.w(DIAG_TAG, "engine.stopTransmitSuspend() — mic disable exception (may be dead object -38): ${e.javaClass.simpleName}: ${e.message}")
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

    private fun enableSpeakerphone() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            enableSpeakerphoneModern()
        } else {
            enableSpeakerphoneLegacy()
        }
    }

    @Suppress("NewApi")
    private fun enableSpeakerphoneModern() {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val speakerDevice = audioManager.availableCommunicationDevices
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        if (speakerDevice != null) {
            val success = audioManager.setCommunicationDevice(speakerDevice)
            Log.d(DIAG_TAG, "AudioManager: mode=IN_COMMUNICATION setCommunicationDevice(SPEAKER) success=$success")
        } else {
            Log.w(DIAG_TAG, "AudioManager: TYPE_BUILTIN_SPEAKER not available — using legacy setSpeakerphoneOn fallback")
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = true
        }
    }

    @Suppress("DEPRECATION")
    private fun enableSpeakerphoneLegacy() {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        audioManager.isSpeakerphoneOn = true
        Log.d(DIAG_TAG, "AudioManager: mode=IN_COMMUNICATION speakerphone=ON (legacy API)")
    }

    private fun setMaxVoiceCallVolume() {
        val maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
        audioManager.setStreamVolume(AudioManager.STREAM_VOICE_CALL, maxVol, 0)
        Log.d(DIAG_TAG, "AudioManager: STREAM_VOICE_CALL volume set to max ($maxVol)")
    }

    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = engineScope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                if (isConnectedState) {
                    val needsReapply = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        @Suppress("NewApi")
                        val commDevice = audioManager.communicationDevice
                        audioManager.mode != AudioManager.MODE_IN_COMMUNICATION ||
                            commDevice?.type != AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                    } else {
                        @Suppress("DEPRECATION")
                        audioManager.mode != AudioManager.MODE_IN_COMMUNICATION ||
                            !audioManager.isSpeakerphoneOn
                    }
                    if (needsReapply) {
                        Log.w(DIAG_TAG, "NativeRadioEngine watchdog: routing reverted — re-asserting speakerphone")
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

    private fun configureAudioForSpeaker() {
        previousAudioMode = audioManager.mode
        wasSpeakerphoneOn = audioManager.isSpeakerphoneOn
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        enableSpeakerphone()
        setMaxVoiceCallVolume()
        audioManager.requestAudioFocus(
            audioFocusListener,
            AudioManager.STREAM_VOICE_CALL,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
        )
    }

    @Suppress("DEPRECATION")
    private fun restoreAudioSettings() {
        audioManager.abandonAudioFocus(audioFocusListener)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            @Suppress("NewApi")
            audioManager.clearCommunicationDevice()
        }
        audioManager.mode = previousAudioMode
        audioManager.isSpeakerphoneOn = wasSpeakerphoneOn
        Log.d(DIAG_TAG, "AudioManager: audio settings restored (mode=$previousAudioMode speakerphone=$wasSpeakerphoneOn)")
    }

    private fun setupRoomListeners(room: Room): Job {
        return engineScope.launch {
            room.events.collect { event: RoomEvent ->
                when (event) {
                    is RoomEvent.Disconnected -> {
                        isConnectedState = false
                        isMicEnabledState = false
                        stopWatchdog()
                        emit("disconnected", mapOf("reason" to (event.reason?.name ?: "unknown")))
                        Log.d(DIAG_TAG, "engine — room disconnected: reason=${event.reason?.name}")
                    }
                    is RoomEvent.Reconnecting -> {
                        emit("reconnecting")
                        Log.d(DIAG_TAG, "engine — room reconnecting")
                    }
                    is RoomEvent.Reconnected -> {
                        isConnectedState = true
                        // Re-assert speakerphone after reconnect since the stack may have reset it.
                        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                        enableSpeakerphone()
                        setMaxVoiceCallVolume()
                        emit("reconnected")
                        Log.d(DIAG_TAG, "engine — room reconnected, speakerphone re-asserted")
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
}
