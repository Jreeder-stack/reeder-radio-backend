package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.KeyAction
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

private const val TAG = "[PTT-DIAG]"

val STATUS_CYCLE = listOf("off_duty", "on_duty", "en_route", "arrived", "oos")
val STATUS_LABELS = mapOf(
    "off_duty" to "OFF DUTY",
    "on_duty" to "ON DUTY",
    "en_route" to "EN ROUTE",
    "arrived" to "ARRIVED",
    "oos" to "OOS"
)

data class ScanChannelItem(val id: Int, val name: String, val enabled: Boolean)

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
    val currentStatus: String = "off_duty",
    val isKeyLocked: Boolean = false,
    val isScanning: Boolean = false,
    val scanChannels: List<ScanChannelItem> = emptyList(),
    val emergencyHoldProgress: Float? = null,
    val isEmergencyCancelling: Boolean = false,
    val showScanOverlay: Boolean = false,
    val clockTime: String = "",
    val batteryLevel: Int? = null,
    val micPermissionGranted: Boolean = false,
) {
    val currentZone: Zone? get() = zones.getOrNull(currentZoneIndex)
    val currentChannel: Channel? get() = currentZone?.channels?.getOrNull(currentChannelIndex)
    val isTransmitting: Boolean get() = pttState == PttState.TRANSMITTING
    val isConnected: Boolean get() = signalingState == ConnectionState.AUTHENTICATED
}

class RadioViewModel(application: Application) : AndroidViewModel(application) {

    private val app get() = getApplication<CommandCommsApp>()
    private val scanPrefs = application.getSharedPreferences("ScanPrefs", android.content.Context.MODE_PRIVATE)
    private val KEY_SCAN_ACTIVE = "scan_active"

    private val locationTracker by lazy {
        com.reedersystems.commandcomms.field.LocationTracker(getApplication(), app.signalingRepository)
    }

    private val _uiState = MutableStateFlow(RadioUiState())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    private var emergencyJob: Job? = null

    init {
        val prefs = app.sessionPrefs
        _uiState.update {
            it.copy(
                username = prefs.username ?: "",
                unitId = prefs.unitId ?: prefs.username ?: "",
                micPermissionGranted = prefs.micPermissionGranted
            )
        }
        updateClock()
        updateBattery()
        viewModelScope.launch {
            while (true) {
                delay(10_000)
                updateClock()
                updateBattery()
            }
        }
        loadChannels()
        observeSignaling()
        collectKeyEvents()
    }

    private fun updateClock() {
        val cal = java.util.Calendar.getInstance()
        val h = "%02d".format(cal.get(java.util.Calendar.HOUR_OF_DAY))
        val m = "%02d".format(cal.get(java.util.Calendar.MINUTE))
        _uiState.update { it.copy(clockTime = "$h:$m") }
    }

    private fun updateBattery() {
        val intent = getApplication<Application>()
            .registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else null
        _uiState.update { it.copy(batteryLevel = pct) }
    }

    private fun loadChannels() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            val result = app.channelRepository.getZones()
            if (result.isSuccess) {
                val zones = result.getOrThrow()
                val allChannels = zones.flatMap { it.channels }
                val scanChannels = allChannels.map { ch ->
                    ScanChannelItem(ch.id, ch.name, loadScanEnabled(ch.id))
                }
                val savedScanning = scanPrefs.getBoolean(KEY_SCAN_ACTIVE, false)
                _uiState.update { it.copy(zones = zones, isLoading = false, scanChannels = scanChannels, isScanning = savedScanning) }
                connectSignaling()
            } else {
                _uiState.update {
                    it.copy(isLoading = false, error = result.exceptionOrNull()?.message ?: "Failed to load channels")
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
                        _uiState.update { it.copy(channelEmergencyActive = false, myEmergencyActive = false) }
                    }
                    is SignalingEvent.ClearAirStart -> {
                        _uiState.update { it.copy(isClearAir = true) }
                    }
                    is SignalingEvent.ClearAirEnd -> {
                        _uiState.update { it.copy(isClearAir = false) }
                    }
                    is SignalingEvent.LocationTrackStart -> {
                        Log.d(TAG, "Location tracking requested")
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

    private fun collectKeyEvents() {
        viewModelScope.launch {
            app.keyEventFlow.collect { action ->
                val locked = _uiState.value.isKeyLocked
                when (action) {
                    is KeyAction.StarLongPress -> toggleKeyLock()
                    is KeyAction.EmergencyDown -> onEmergencyDown()
                    is KeyAction.EmergencyUp -> onEmergencyUp()
                    else -> {
                        if (!locked) when (action) {
                            is KeyAction.DpadUp -> nextChannel()
                            is KeyAction.DpadDown -> prevChannel()
                            is KeyAction.DpadLeft -> prevZone()
                            is KeyAction.DpadRight -> nextZone()
                            is KeyAction.AccToggle -> toggleScanning()
                            else -> {}
                        }
                    }
                }
            }
        }
    }

    fun setMicPermissionGranted(granted: Boolean) {
        app.sessionPrefs.micPermissionGranted = granted
        _uiState.update { it.copy(micPermissionGranted = granted) }
        Log.d(TAG, "Mic permission granted=$granted")
    }

    fun onPttDown() {
        val state = _uiState.value
        if (state.isKeyLocked) return
        if (state.pttState != PttState.IDLE) return
        if (!state.micPermissionGranted) {
            Log.w(TAG, "PTT DOWN: mic permission denied — blocked")
            app.toneEngine.playErrorTone()
            return
        }
        val channelId = state.currentChannel?.id ?: run {
            Log.w(TAG, "PTT DOWN: no channel selected")
            app.toneEngine.playErrorTone()
            return
        }
        if (state.activeTransmittingUnit != null && state.activeTransmittingUnit != state.unitId) {
            Log.w(TAG, "PTT DOWN: channel busy — unit=${state.activeTransmittingUnit}")
            app.toneEngine.playBusyTone()
            return
        }
        Log.d(TAG, "onPttDown channelId=$channelId")
        app.toneEngine.playTalkPermitTone()
        _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
        app.signalingRepository.transmitStart(channelId)
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
    }

    fun onPttUp() {
        val state = _uiState.value
        if (state.pttState == PttState.IDLE) return
        val channelId = state.currentChannel?.id ?: return
        Log.d(TAG, "onPttUp channelId=$channelId")
        app.toneEngine.playEndOfTxTone()
        _uiState.update { it.copy(pttState = PttState.IDLE) }
        app.signalingRepository.transmitEnd(channelId)
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_UP)
    }

    private fun onEmergencyDown() {
        val state = _uiState.value
        when {
            emergencyJob == null && !state.myEmergencyActive -> startArming()
            !state.isEmergencyCancelling -> startCancelHold()
        }
    }

    private fun onEmergencyUp() {
        val state = _uiState.value
        if (state.isEmergencyCancelling) {
            emergencyJob?.cancel()
            emergencyJob = null
            app.toneEngine.stopCountdownBeep()
            _uiState.update { it.copy(isEmergencyCancelling = false, emergencyHoldProgress = null) }
            Log.d(TAG, "CANCEL HOLD: aborted early")
        }
    }

    private fun startArming() {
        Log.d(TAG, "EMERGENCY ARMING: activating immediately")
        onEmergencyActivate()
    }

    private fun startCancelHold() {
        val wasArming = emergencyJob != null && !_uiState.value.myEmergencyActive
        if (wasArming) {
            emergencyJob?.cancel()
            emergencyJob = null
        }
        emergencyJob = viewModelScope.launch {
            Log.d(TAG, "CANCEL HOLD: started (wasArming=$wasArming)")
            app.toneEngine.startCountdownBeep()
            _uiState.update { it.copy(isEmergencyCancelling = true, emergencyHoldProgress = 0f) }
            var elapsed = 0L
            while (elapsed < 3000L) {
                delay(50)
                elapsed += 50
                _uiState.update { it.copy(emergencyHoldProgress = elapsed / 3000f) }
            }
            emergencyJob = null
            app.toneEngine.stopCountdownBeep()
            _uiState.update { it.copy(isEmergencyCancelling = false, emergencyHoldProgress = null) }
            if (_uiState.value.myEmergencyActive) {
                onEmergencyClear()
            }
            Log.d(TAG, "CANCEL HOLD: completed (wasArming=$wasArming)")
        }
    }

    private fun onEmergencyActivate() {
        val channelId = _uiState.value.currentChannel?.id ?: return
        Log.d(TAG, "EMERGENCY ACTIVATE channelId=$channelId")
        _uiState.update { it.copy(myEmergencyActive = true, channelEmergencyActive = true) }
        app.signalingRepository.emergencyStart(channelId)
        locationTracker.startTracking()
        startEmergencyTx(channelId)
    }

    private fun startEmergencyTx(channelId: Int) {
        if (_uiState.value.pttState != PttState.IDLE) return
        Log.d(TAG, "EMERGENCY TX START channelId=$channelId (key-lock bypassed)")
        app.toneEngine.playTalkPermitTone()
        _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
        app.signalingRepository.transmitStart(channelId)
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
    }

    private fun onEmergencyClear() {
        val channelId = _uiState.value.currentChannel?.id ?: return
        Log.d(TAG, "EMERGENCY CLEAR channelId=$channelId")
        _uiState.update { it.copy(myEmergencyActive = false) }
        app.signalingRepository.emergencyEnd(channelId)
        locationTracker.stopTracking()
        if (_uiState.value.pttState != PttState.IDLE) onPttUp()
    }

    fun cycleStatus() {
        val current = _uiState.value.currentStatus
        val idx = STATUS_CYCLE.indexOf(current)
        val next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.size]
        _uiState.update { it.copy(currentStatus = next) }
        app.signalingRepository.setStatus(next)
    }

    fun toggleKeyLock() {
        _uiState.update { it.copy(isKeyLocked = !it.isKeyLocked) }
    }

    fun toggleScanning() {
        val next = !_uiState.value.isScanning
        scanPrefs.edit().putBoolean(KEY_SCAN_ACTIVE, next).apply()
        _uiState.update { it.copy(isScanning = next) }
    }

    fun setShowScanOverlay(show: Boolean) {
        _uiState.update { it.copy(showScanOverlay = show) }
    }

    fun toggleScanChannel(channelId: Int) {
        val updated = _uiState.value.scanChannels.map { ch ->
            if (ch.id == channelId) ch.copy(enabled = !ch.enabled).also {
                saveScanEnabled(channelId, !ch.enabled)
            } else ch
        }
        _uiState.update { it.copy(scanChannels = updated) }
    }

    private fun loadScanEnabled(channelId: Int): Boolean =
        scanPrefs.getBoolean("scan_$channelId", true)

    private fun saveScanEnabled(channelId: Int, enabled: Boolean) {
        scanPrefs.edit().putBoolean("scan_$channelId", enabled).apply()
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
        if (prevChannelId != null && prevChannelId != newChannel.id && _uiState.value.isConnected) {
            app.signalingRepository.leaveChannel(prevChannelId)
            app.signalingRepository.joinChannel(newChannel.id)
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
        emergencyJob?.cancel()
        app.toneEngine.stopCountdownBeep()
        locationTracker.stopTracking()
        super.onCleared()
    }
}
