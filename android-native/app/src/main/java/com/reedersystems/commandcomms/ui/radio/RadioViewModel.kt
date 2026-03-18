package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import android.content.Intent
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.field.LocationTracker
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val TAG = "[PTT-DIAG]"

data class RadioUiState(
    val username: String = "",
    val unitId: String = "",
    val zones: List<Zone> = emptyList(),
    val currentZoneIndex: Int = 0,
    val currentChannelIndex: Int = 0,
    val isLoading: Boolean = true,
    val error: String? = null,
    val signalingState: ConnectionState = ConnectionState.DISCONNECTED,
    val pttState: PttState = PttState.IDLE,
    val activeTransmittingUnit: String? = null,
    val myEmergencyActive: Boolean = false,
    val channelEmergencyActive: Boolean = false,
    val isClearAir: Boolean = false,
    val currentStatus: String = "online"
) {
    val currentZone: Zone? get() = zones.getOrNull(currentZoneIndex)
    val currentChannel: Channel? get() = currentZone?.channels?.getOrNull(currentChannelIndex)
    val isTransmitting: Boolean get() = pttState == PttState.TRANSMITTING
    val isConnected: Boolean get() = signalingState == ConnectionState.AUTHENTICATED
}

val UNIT_STATUSES = listOf(
    "online" to "On Duty",
    "available" to "Available",
    "busy" to "Unavailable",
    "on-scene" to "On Scene",
    "out-of-service" to "Out of Service"
)

class RadioViewModel(application: Application) : AndroidViewModel(application) {

    private val app get() = getApplication<CommandCommsApp>()
    private val locationTracker: LocationTracker by lazy {
        LocationTracker(getApplication(), app.signalingRepository)
    }

    private val _uiState = MutableStateFlow(RadioUiState())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    init {
        val prefs = app.sessionPrefs
        _uiState.update {
            it.copy(
                username = prefs.username ?: "",
                unitId = prefs.unitId ?: prefs.username ?: ""
            )
        }
        loadChannels()
        observeSignaling()
    }

    private fun loadChannels() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            val result = app.channelRepository.getZones()
            if (result.isSuccess) {
                val zones = result.getOrThrow()
                _uiState.update { it.copy(zones = zones, isLoading = false) }
                connectSignaling()
            } else {
                _uiState.update {
                    it.copy(isLoading = false, error = result.exceptionOrNull()?.message)
                }
            }
        }
    }

    private fun connectSignaling() {
        val state = _uiState.value
        val unitId = state.unitId.ifBlank { return }
        val username = state.username.ifBlank { unitId }
        app.signalingRepository.connect(unitId, username)

        viewModelScope.launch {
            app.signalingRepository.connectionState.collect { connState ->
                _uiState.update { it.copy(signalingState = connState) }
                if (connState == ConnectionState.AUTHENTICATED) {
                    val channelId = _uiState.value.currentChannel?.id
                    if (channelId != null) {
                        app.signalingRepository.joinChannel(channelId)
                        updateServiceChannel()
                    }
                }
            }
        }
    }

    private fun observeSignaling() {
        viewModelScope.launch {
            app.signalingRepository.events.collect { event ->
                when (event) {
                    is SignalingEvent.PttStart -> {
                        if (event.unitId != _uiState.value.unitId) {
                            _uiState.update { it.copy(activeTransmittingUnit = event.unitId) }
                        }
                    }
                    is SignalingEvent.PttEnd -> {
                        if (event.unitId == _uiState.value.activeTransmittingUnit) {
                            _uiState.update { it.copy(activeTransmittingUnit = null) }
                        }
                    }
                    is SignalingEvent.EmergencyStart -> {
                        _uiState.update { it.copy(channelEmergencyActive = true) }
                    }
                    is SignalingEvent.EmergencyEnd -> {
                        _uiState.update { it.copy(channelEmergencyActive = false) }
                        if (_uiState.value.myEmergencyActive) {
                            _uiState.update { it.copy(myEmergencyActive = false) }
                        }
                    }
                    is SignalingEvent.ClearAirStart -> {
                        _uiState.update { it.copy(isClearAir = true) }
                    }
                    is SignalingEvent.ClearAirEnd -> {
                        _uiState.update { it.copy(isClearAir = false) }
                    }
                    is SignalingEvent.LocationTrackStart -> {
                        Log.d(TAG, "Location tracking requested (emergency=${event.emergency})")
                        locationTracker.startTracking()
                    }
                    is SignalingEvent.LocationTrackStop -> {
                        locationTracker.stopTracking()
                    }
                    else -> {}
                }
            }
        }
    }

    fun onPttDown() {
        val state = _uiState.value
        if (state.pttState != PttState.IDLE) return
        val channelId = state.currentChannel?.id ?: run {
            Log.w(TAG, "PTT DOWN: no channel selected")
            return
        }
        Log.d(TAG, "onPttDown channelId=$channelId")
        _uiState.update { it.copy(pttState = PttState.CONNECTING) }
        app.signalingRepository.transmitStart(channelId)
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
    }

    fun onPttUp() {
        val state = _uiState.value
        if (state.pttState == PttState.IDLE) return
        val channelId = state.currentChannel?.id ?: return
        Log.d(TAG, "onPttUp channelId=$channelId")
        _uiState.update { it.copy(pttState = PttState.IDLE) }
        app.signalingRepository.transmitEnd(channelId)
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_UP)
    }

    fun onEmergencyActivate() {
        val channelId = _uiState.value.currentChannel?.id ?: return
        Log.d(TAG, "EMERGENCY ACTIVATE channelId=$channelId")
        _uiState.update { it.copy(myEmergencyActive = true) }
        app.signalingRepository.emergencyStart(channelId)
        locationTracker.startTracking()
        onPttDown()
    }

    fun onEmergencyClear() {
        val channelId = _uiState.value.currentChannel?.id ?: return
        Log.d(TAG, "EMERGENCY CLEAR channelId=$channelId")
        _uiState.update { it.copy(myEmergencyActive = false) }
        app.signalingRepository.emergencyEnd(channelId)
        locationTracker.stopTracking()
        if (_uiState.value.pttState != PttState.IDLE) onPttUp()
    }

    fun setStatus(statusKey: String) {
        _uiState.update { it.copy(currentStatus = statusKey) }
        app.signalingRepository.setStatus(statusKey)
    }

    private fun updateServiceChannel() {
        val channel = _uiState.value.currentChannel ?: return
        app.serviceConnectionPrefs.channelId = channel.id
        app.serviceConnectionPrefs.channelRoomKey = channel.roomKey
        app.serviceConnectionPrefs.channelName = channel.name
        app.serviceConnectionPrefs.unitId = _uiState.value.unitId
        app.serviceConnectionPrefs.serverUrl = app.apiClient.baseUrl

        val intent = Intent(getApplication(), BackgroundAudioService::class.java).apply {
            action = BackgroundAudioService.ACTION_UPDATE_CHANNEL
            putExtra(BackgroundAudioService.EXTRA_CHANNEL_ID, channel.id)
            putExtra(BackgroundAudioService.EXTRA_ROOM_KEY, channel.roomKey)
            putExtra(BackgroundAudioService.EXTRA_CHANNEL_NAME, channel.name)
        }
        getApplication<Application>().startForegroundService(intent)
    }

    private fun sendServiceIntent(action: String) {
        val intent = Intent(getApplication(), BackgroundAudioService::class.java).apply {
            this.action = action
        }
        getApplication<Application>().startForegroundService(intent)
    }

    fun nextZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val prevId = _uiState.value.currentChannel?.id
        val next = (_uiState.value.currentZoneIndex + 1) % zones.size
        _uiState.update { it.copy(currentZoneIndex = next, currentChannelIndex = 0) }
        onChannelChanged(prevId)
    }

    fun prevZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val prevId = _uiState.value.currentChannel?.id
        val p = (_uiState.value.currentZoneIndex - 1 + zones.size) % zones.size
        _uiState.update { it.copy(currentZoneIndex = p, currentChannelIndex = 0) }
        onChannelChanged(prevId)
    }

    fun nextChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val prevId = _uiState.value.currentChannel?.id
        val next = (_uiState.value.currentChannelIndex + 1) % channels.size
        _uiState.update { it.copy(currentChannelIndex = next) }
        onChannelChanged(prevId)
    }

    fun prevChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val prevId = _uiState.value.currentChannel?.id
        val p = (_uiState.value.currentChannelIndex - 1 + channels.size) % channels.size
        _uiState.update { it.copy(currentChannelIndex = p) }
        onChannelChanged(prevId)
    }

    private fun onChannelChanged(prevChannelId: Int?) {
        val newChannel = _uiState.value.currentChannel ?: return
        if (prevChannelId != null && prevChannelId != newChannel.id) {
            if (_uiState.value.isConnected) {
                app.signalingRepository.leaveChannel(prevChannelId)
                app.signalingRepository.joinChannel(newChannel.id)
            }
        }
        updateServiceChannel()
    }

    fun logout(onComplete: () -> Unit) {
        viewModelScope.launch {
            if (_uiState.value.myEmergencyActive) onEmergencyClear()
            locationTracker.stopTracking()
            sendServiceIntent(BackgroundAudioService.ACTION_STOP)
            app.signalingRepository.disconnect()
            app.authRepository.logout()
            app.sessionPrefs.clear()
            app.serviceConnectionPrefs.clear()
            onComplete()
        }
    }

    override fun onCleared() {
        locationTracker.stopTracking()
        super.onCleared()
    }
}
