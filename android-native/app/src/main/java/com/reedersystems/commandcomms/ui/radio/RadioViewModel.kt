package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.util.Log
import androidx.core.content.ContextCompat
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
    val channelEmergencyUnitId: String? = null,
    val isClearAir: Boolean = false,
    val currentStatus: String = "off_duty",
    val isKeyLocked: Boolean = false,
    val isScanning: Boolean = false,
    val scanChannels: List<ScanChannelItem> = emptyList(),
    val emergencyHoldProgress: Float? = null,
    val isEmergencyCancelling: Boolean = false,
    val showScanOverlay: Boolean = false,
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
    private var cancelArmingJob: Job? = null
    private var pttStartJob: Job? = null

    /**
     * Receives PTT_TX_FAILED and PTT_TX_ABORTED broadcasts from BackgroundAudioService.
     * PTT_TX_FAILED is a real connection/TX error — plays an error tone and resets.
     * PTT_TX_ABORTED is a deliberate user-release during connect — resets silently, no tone.
     */
    private val pttTxFailedReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                BackgroundAudioService.ACTION_PTT_TX_FAILED -> {
                    Log.d(TAG, "PTT_TX_FAILED received — resetting to IDLE")
                    val s = _uiState.value
                    if (s.pttState == PttState.TRANSMITTING) {
                        // Real failure: ViewModel believes TX is active. Play error tone,
                        // clean up server signaling, then reset. If pttState is already IDLE
                        // (race-condition cancellation path), no error tone and no duplicate
                        // transmitEnd — the UP handler already cleaned both up.
                        app.toneEngine.playErrorTone()
                        s.currentChannel?.roomKey?.let { app.signalingRepository.transmitEnd(it) }
                        _uiState.update { it.copy(pttState = PttState.IDLE) }
                    }
                }
                BackgroundAudioService.ACTION_PTT_TX_ABORTED -> {
                    Log.d(TAG, "PTT_TX_ABORTED received — resetting to IDLE (no error tone)")
                    // Only reset if not actively TRANSMITTING — a rapid re-press may have
                    // already started a new TX before this delayed abort broadcast arrived.
                    val s = _uiState.value
                    if (s.pttState != PttState.TRANSMITTING) {
                        _uiState.update { it.copy(pttState = PttState.IDLE) }
                    }
                }
                BackgroundAudioService.ACTION_PTT_TX_STARTED -> {
                    Log.d(TAG, "PTT_TX_STARTED received — setting pttState = TRANSMITTING")
                    _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
                }
                BackgroundAudioService.ACTION_PTT_TX_ENDED -> {
                    Log.d(TAG, "PTT_TX_ENDED received — setting pttState = IDLE")
                    _uiState.update { it.copy(pttState = PttState.IDLE) }
                }

                // Emergency broadcasts — service owns arming/signaling/PTT, ViewModel owns UI only
                BackgroundAudioService.ACTION_EMERGENCY_ARMING -> {
                    Log.d(TAG, "EMERGENCY_ARMING received — starting arming UI animation")
                    startArming()
                }
                BackgroundAudioService.ACTION_EMERGENCY_ACTIVATED -> {
                    Log.d(TAG, "EMERGENCY_ACTIVATED received — updating UI to active state")
                    emergencyJob?.cancel()
                    emergencyJob = null
                    app.toneEngine.stopCountdownBeep()
                    _uiState.update {
                        it.copy(
                            emergencyHoldProgress = null,
                            myEmergencyActive = true,
                            channelEmergencyActive = true
                        )
                    }
                    locationTracker.startTracking()
                    // Service already started PTT via handlePttDown() — no TX needed here
                }
                BackgroundAudioService.ACTION_EMERGENCY_CANCELLED -> {
                    Log.d(TAG, "EMERGENCY_CANCELLED received — dismissing arming UI")
                    emergencyJob?.cancel()
                    emergencyJob = null
                    cancelArmingJob?.cancel()
                    cancelArmingJob = null
                    app.toneEngine.stopCountdownBeep()
                    _uiState.update { it.copy(emergencyHoldProgress = null, isEmergencyCancelling = false) }
                }
            }
        }
    }

    init {
        val prefs = app.sessionPrefs
        _uiState.update {
            it.copy(
                username = prefs.username ?: "",
                unitId = prefs.unitId ?: prefs.username ?: "",
                micPermissionGranted = prefs.micPermissionGranted
            )
        }
        updateBattery()
        viewModelScope.launch {
            while (true) {
                delay(10_000)
                updateBattery()
            }
        }
        loadChannels()
        observeSignaling()
        collectKeyEvents()
        registerPttFailureReceiver()
    }

    private fun registerPttFailureReceiver() {
        val filter = IntentFilter(BackgroundAudioService.ACTION_PTT_TX_FAILED).apply {
            addAction(BackgroundAudioService.ACTION_PTT_TX_ABORTED)
            addAction(BackgroundAudioService.ACTION_PTT_TX_STARTED)
            addAction(BackgroundAudioService.ACTION_PTT_TX_ENDED)
            addAction(BackgroundAudioService.ACTION_EMERGENCY_ARMING)
            addAction(BackgroundAudioService.ACTION_EMERGENCY_ACTIVATED)
            addAction(BackgroundAudioService.ACTION_EMERGENCY_CANCELLED)
        }
        ContextCompat.registerReceiver(
            getApplication(),
            pttTxFailedReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        Log.d(TAG, "PTT/Emergency service broadcast receiver registered")
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
                    val roomKey = _uiState.value.currentChannel?.roomKey
                    if (roomKey != null) {
                        app.signalingRepository.joinChannel(roomKey)
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
                    is SignalingEvent.PttPre -> {
                        val state = _uiState.value
                        if (event.unitId != state.unitId && event.channelId == state.currentChannel?.roomKey) {
                            sendServiceRxIntent(BackgroundAudioService.ACTION_RX_CONNECT, state.currentChannel?.id ?: -1)
                        }
                    }
                    is SignalingEvent.PttStart -> {
                        val state = _uiState.value
                        if (event.unitId != state.unitId) {
                            _uiState.update { it.copy(activeTransmittingUnit = event.unitId) }
                            if (event.channelId == state.currentChannel?.roomKey) {
                                sendServiceRxIntent(BackgroundAudioService.ACTION_RX_CONNECT, state.currentChannel?.id ?: -1)
                            }
                        }
                    }
                    is SignalingEvent.PttEnd -> {
                        val state = _uiState.value
                        if (event.unitId == state.activeTransmittingUnit) {
                            _uiState.update { it.copy(activeTransmittingUnit = null) }
                            if (event.channelId == state.currentChannel?.roomKey) {
                                sendServiceRxIntent(BackgroundAudioService.ACTION_RX_END, state.currentChannel?.id ?: -1)
                            }
                        }
                    }
                    is SignalingEvent.EmergencyStart -> {
                        _uiState.update { it.copy(channelEmergencyActive = true, channelEmergencyUnitId = event.unitId) }
                    }
                    is SignalingEvent.EmergencyEnd -> {
                        _uiState.update { it.copy(channelEmergencyActive = false, myEmergencyActive = false, channelEmergencyUnitId = null) }
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
                    is KeyAction.PttDown -> onPttDown()
                    is KeyAction.PttUp -> onPttUp()
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
        if (state.pttState != PttState.IDLE) return
        if (!state.micPermissionGranted) {
            Log.w(TAG, "PTT DOWN: mic permission denied — blocked")
            app.toneEngine.playErrorTone()
            return
        }
        val channel = state.currentChannel ?: run {
            Log.w(TAG, "PTT DOWN: no channel selected")
            app.toneEngine.playErrorTone()
            return
        }
        if (state.activeTransmittingUnit != null && state.activeTransmittingUnit != state.unitId) {
            Log.w(TAG, "PTT DOWN: channel busy — unit=${state.activeTransmittingUnit}")
            app.toneEngine.playBusyTone()
            return
        }
        Log.d(TAG, "onPttDown roomKey=${channel.roomKey}")
        app.signalingRepository.transmitPre(channel.roomKey)
        _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
        pttStartJob = viewModelScope.launch {
            app.toneEngine.playTalkPermitToneAndAwait()
            if (_uiState.value.pttState != PttState.TRANSMITTING) {
                Log.d(TAG, "PTT released during talk-permit tone — aborting TX")
                return@launch
            }
            app.signalingRepository.transmitStart(channel.roomKey)
            sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
        }
    }

    fun onPttUp() {
        val state = _uiState.value
        if (state.pttState == PttState.IDLE) return
        pttStartJob?.cancel()
        pttStartJob = null
        val channel = state.currentChannel ?: return
        Log.d(TAG, "onPttUp roomKey=${channel.roomKey}")
        app.toneEngine.playEndOfTxTone()
        _uiState.update { it.copy(pttState = PttState.IDLE) }
        app.signalingRepository.transmitEnd(channel.roomKey)
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_UP)
    }

    private fun onEmergencyDown() {
        val state = _uiState.value
        // Arming is handled entirely by BackgroundAudioService (ACTION_EMERGENCY_ARMING broadcast).
        // The ViewModel only needs to manage the cancel-hold UI when an emergency is already active.
        if (state.myEmergencyActive && !state.isEmergencyCancelling) {
            startCancelHold()
        }
    }

    private fun onEmergencyUp() {
        val state = _uiState.value
        when {
            cancelArmingJob != null && !state.isEmergencyCancelling -> {
                cancelArmingJob?.cancel()
                cancelArmingJob = null
                Log.d(TAG, "CANCEL ARMING: quick release in debounce — arming unaffected")
            }
            cancelArmingJob != null && state.isEmergencyCancelling -> {
                cancelArmingJob?.cancel()
                cancelArmingJob = null
                app.toneEngine.stopCountdownBeep()
                app.toneEngine.startCountdownBeep()
                _uiState.update { it.copy(isEmergencyCancelling = false) }
                Log.d(TAG, "CANCEL ARMING: aborted — arming resumes")
            }
            state.isEmergencyCancelling && state.myEmergencyActive -> {
                emergencyJob?.cancel()
                emergencyJob = null
                app.toneEngine.stopCountdownBeep()
                _uiState.update { it.copy(isEmergencyCancelling = false, emergencyHoldProgress = null) }
                Log.d(TAG, "CANCEL HOLD: aborted early")
            }
        }
    }

    private fun startArming() {
        // UI-only animation. BackgroundAudioService owns the real countdown, tones,
        // signaling, and PTT (same pattern as PTT unification). This coroutine drives
        // the progress arc and is cancelled by ACTION_EMERGENCY_CANCELLED or
        // ACTION_EMERGENCY_ACTIVATED broadcasts when the service finishes.
        if (emergencyJob != null) return  // Already animating
        emergencyJob = viewModelScope.launch {
            Log.d(TAG, "EMERGENCY ARMING: UI countdown started")
            var elapsed = 0L
            _uiState.update { it.copy(emergencyHoldProgress = 0f) }
            while (elapsed < 3000L) {
                delay(50)
                elapsed += 50
                _uiState.update { it.copy(emergencyHoldProgress = elapsed / 3000f) }
            }
            // Animation finished — wait for ACTION_EMERGENCY_ACTIVATED broadcast to update
            // the active state. The service fires that broadcast after its own 3-second delay.
            emergencyJob = null
            _uiState.update { it.copy(emergencyHoldProgress = null) }
        }
    }

    private fun startCancelArming() {
        cancelArmingJob = viewModelScope.launch {
            Log.d(TAG, "CANCEL ARMING: hold started")
            var elapsed = 0L
            while (elapsed < 150L) {
                delay(50)
                elapsed += 50
            }
            Log.d(TAG, "CANCEL ARMING: debounce cleared — showing cancel bar")
            app.toneEngine.stopCountdownBeep()
            app.toneEngine.startCountdownBeep()
            _uiState.update { it.copy(isEmergencyCancelling = true, emergencyHoldProgress = elapsed / 3000f) }
            while (elapsed < 3000L) {
                delay(50)
                elapsed += 50
                _uiState.update { it.copy(emergencyHoldProgress = elapsed / 3000f) }
            }
            cancelArmingJob = null
            emergencyJob?.cancel()
            emergencyJob = null
            app.toneEngine.stopCountdownBeep()
            _uiState.update { it.copy(isEmergencyCancelling = false, emergencyHoldProgress = null) }
            Log.d(TAG, "CANCEL ARMING: completed at ${elapsed}ms — arming cancelled")
        }
    }

    private fun startCancelHold() {
        emergencyJob = viewModelScope.launch {
            Log.d(TAG, "CANCEL HOLD: started")
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
            onEmergencyClear()
            Log.d(TAG, "CANCEL HOLD: completed")
        }
    }

    private fun onEmergencyActivate() {
        val channel = _uiState.value.currentChannel ?: return
        Log.d(TAG, "EMERGENCY ACTIVATE roomKey=${channel.roomKey}")
        _uiState.update { it.copy(myEmergencyActive = true, channelEmergencyActive = true) }
        app.signalingRepository.emergencyStart(channel.roomKey)
        locationTracker.startTracking()
        startEmergencyTx(channel.roomKey)
    }

    private fun startEmergencyTx(channelKey: String) {
        if (_uiState.value.pttState != PttState.IDLE) return
        Log.d(TAG, "EMERGENCY TX START roomKey=$channelKey (key-lock bypassed)")
        _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
        pttStartJob = viewModelScope.launch {
            app.toneEngine.playTalkPermitToneAndAwait()
            if (_uiState.value.pttState != PttState.TRANSMITTING) {
                Log.d(TAG, "PTT released during emergency talk-permit tone — aborting TX")
                return@launch
            }
            app.signalingRepository.transmitStart(channelKey)
            sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
        }
    }

    private fun onEmergencyClear() {
        val channel = _uiState.value.currentChannel ?: return
        Log.d(TAG, "EMERGENCY CLEAR roomKey=${channel.roomKey}")
        _uiState.update { it.copy(myEmergencyActive = false) }
        app.signalingRepository.emergencyEnd(channel.roomKey)
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
            putExtra(BackgroundAudioService.EXTRA_NEEDS_SIGNALING, false)
        }
        getApplication<Application>().startForegroundService(intent)
    }

    private fun sendServiceRxIntent(action: String, channelId: Int) {
        val intent = Intent(getApplication(), BackgroundAudioService::class.java).apply {
            this.action = action
            putExtra(BackgroundAudioService.EXTRA_CHANNEL_ID, channelId)
        }
        getApplication<Application>().startForegroundService(intent)
    }

    fun nextZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val next = (_uiState.value.currentZoneIndex + 1) % zones.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentZoneIndex = next, currentChannelIndex = 0) }
        onChannelChanged(oldRoomKey)
    }

    fun prevZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val p = (_uiState.value.currentZoneIndex - 1 + zones.size) % zones.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentZoneIndex = p, currentChannelIndex = 0) }
        onChannelChanged(oldRoomKey)
    }

    fun nextChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val next = (_uiState.value.currentChannelIndex + 1) % channels.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentChannelIndex = next) }
        onChannelChanged(oldRoomKey)
    }

    fun prevChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val p = (_uiState.value.currentChannelIndex - 1 + channels.size) % channels.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentChannelIndex = p) }
        onChannelChanged(oldRoomKey)
    }

    private fun onChannelChanged(oldRoomKey: String? = null) {
        val newRoomKey = _uiState.value.currentChannel?.roomKey
        if (oldRoomKey != null && oldRoomKey != newRoomKey &&
            app.signalingRepository.connectionState.value == ConnectionState.AUTHENTICATED) {
            app.signalingRepository.leaveChannel(oldRoomKey)
            if (newRoomKey != null) {
                app.signalingRepository.joinChannel(newRoomKey)
            }
        }
        updateServiceChannel()
    }

    fun refreshSession(onSessionExpired: () -> Unit) {
        viewModelScope.launch {
            val result = app.authRepository.me()
            if (result.isFailure) {
                Log.w(TAG, "Session expired on resume, logging out")
                logout(onSessionExpired)
            }
        }
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
        cancelArmingJob?.cancel()
        app.toneEngine.stopCountdownBeep()
        locationTracker.stopTracking()
        runCatching { getApplication<Application>().unregisterReceiver(pttTxFailedReceiver) }
        super.onCleared()
    }
}
