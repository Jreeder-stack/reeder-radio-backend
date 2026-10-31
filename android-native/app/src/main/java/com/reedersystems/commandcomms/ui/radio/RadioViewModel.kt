package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.BatteryManager
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.messaging.FirebaseMessaging
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.KeyAction
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.BuildConfig
import com.reedersystems.commandcomms.hd760.Hd760Preferences
import com.reedersystems.commandcomms.hd760.Hd760SideAction
import com.reedersystems.commandcomms.hd760.Hd760KnobMapping
import com.reedersystems.commandcomms.hd760.Hd760ChannelRecovery
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.audio.radio.SignalQuality
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.data.model.Zone
import com.reedersystems.commandcomms.messaging.CommandCommsFirebaseService
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

private const val TAG = "[PTT-DIAG]"
private const val STARTUP_TAG = "[APP-STARTUP]"

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
    val channelRetryPending: Boolean = false,
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
    val emergencyArming: Boolean = false,
    val emergencyArmingSecondsRemaining: Int = 0,
    val showScanOverlay: Boolean = false,
    val batteryLevel: Int? = null,
    val micPermissionGranted: Boolean = false,
    val radioState: RadioState = RadioState.IDLE,
    val isChannelBusy: Boolean = false,
    val isRadioLocked: Boolean = false,
    val isRadioUnassigned: Boolean = false,
    val reassignedUnitId: String? = null,
    val scanActiveChannel: String? = null,
    val scanActiveUnit: String? = null,
    val showPageAlert: Boolean = false,
    val pageAlertMessage: String = "",
    val pageAlertSender: String = "DISPATCH",
    val signalQuality: SignalQuality = SignalQuality.NONE,
    val txMediaActive: Boolean = false,
    val rxMediaActive: Boolean = false,
    val txAudioBars: Int = 0,
    val rxAudioBars: Int = 0,
    val hd760KnobPosition: Int? = null,
    val hd760SlotEmpty: Boolean = false,
    val hd760MenuOpen: Boolean = false,
    val hd760ScanListOpen: Boolean = false,
    val hd760ScanListIndex: Int = 0,
    val hd760LockFeedback: String? = null,
    val hd760MenuIndex: Int = 0,
    val hd760ProgrammingSlot: Boolean = false,
    val hd760ProgramChannelIndex: Int = 0,
    val hd760SettingsRequested: Boolean = false,
    val hd760MenuVersion: Int = 0,
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
    private val isHd760 = BuildConfig.FLAVOR == "hd760"
    private val hd760Prefs = if (isHd760) Hd760Preferences(application) else null
    private var hd760AnnouncementJob: Job? = null
    private var hd760LockFeedbackJob: Job? = null
    private var channelLoadJob: Job? = null

    private fun syncHd760ScanConfig() {
        if (!isHd760) return
        val state = _uiState.value
        val eligible = state.zones.flatMap { it.channels }.associateBy { it.id }
        val selected = state.scanChannels.filter { it.enabled }
            .mapNotNull { eligible[it.id] }
            .distinctBy { it.roomKey }
        val intent = Intent(getApplication(), BackgroundAudioService::class.java).apply {
            action = BackgroundAudioService.ACTION_SET_SCAN_CHANNELS
            putExtra(BackgroundAudioService.EXTRA_SCAN_ENABLED, state.isScanning)
            putStringArrayListExtra(BackgroundAudioService.EXTRA_SCAN_ROOM_KEYS,
                ArrayList(selected.map { it.roomKey }))
            putIntegerArrayListExtra(BackgroundAudioService.EXTRA_SCAN_NUMERIC_IDS,
                ArrayList(selected.map { it.id }))
        }
        ContextCompat.startForegroundService(getApplication<Application>(), intent)
    }


    val hd760MenuLabels: List<String>
        get() = listOf(
            "SCAN: " + if (_uiState.value.isScanning) "ON" else "OFF",
            "SCAN LIST",
            "SIDE 1 TAP: " + hd760Prefs?.buttonAction(1, false)?.label,
            "SIDE 1 HOLD: " + hd760Prefs?.buttonAction(1, true)?.label,
            "SIDE 2 TAP: " + hd760Prefs?.buttonAction(2, false)?.label,
            "SIDE 2 HOLD: " + hd760Prefs?.buttonAction(2, true)?.label,
            "CLOSE MENU"
        )

    private val locationTracker by lazy {
        com.reedersystems.commandcomms.field.LocationTracker(getApplication(), app.signalingRepository)
    }

    private val _uiState = MutableStateFlow(RadioUiState())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    private var emergencyJob: Job? = null
    private var cancelArmingJob: Job? = null
    private var armingJob: Job? = null
    @Volatile private var armingDeadlineMs: Long = 0L
    @Volatile private var armingExpired: Boolean = false
    @Volatile private var lastEmergencyDownAt: Long = 0L
    private var pttStartJob: Job? = null
    private var activeTransmittingUnitStaleJob: Job? = null
    private var scanClearJob: Job? = null

    companion object {
        private const val ACTIVE_TX_UNIT_STALE_MS = 45_000L
        private const val SCAN_DISPLAY_HOLD_MS = 2_000L
    }

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
                    if (s.pttState == PttState.TRANSMITTING || s.pttState == PttState.CONNECTING) {
                        // Real failure: ViewModel believes TX is active. Play error tone,
                        // clean up server signaling, then reset. If pttState is already IDLE
                        // (race-condition cancellation path), no error tone and no duplicate
                        // transmitEnd — the UP handler already cleaned both up.
                        app.toneEngine.playDeniedBonk()
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

                // Emergency broadcasts — service owns signaling, ViewModel owns UI only
                BackgroundAudioService.ACTION_EMERGENCY_ACTIVATED -> {
                    Log.d(TAG, "EMERGENCY_ACTIVATED received — updating UI to active state")
                    _uiState.update {
                        it.copy(
                            emergencyHoldProgress = null,
                            myEmergencyActive = true,
                            channelEmergencyActive = true
                        )
                    }
                    locationTracker.startTracking()
                }
                BackgroundAudioService.ACTION_EMERGENCY_CANCELLED -> {
                    Log.d(TAG, "EMERGENCY_CANCELLED received — dismissing emergency UI")
                    forceResetEmergencyState()
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
        if (isHd760) {
            viewModelScope.launch {
                app.hd760KeyLocked.collect { locked ->
                    val old = _uiState.value.isKeyLocked
                    _uiState.update {
                        it.copy(isKeyLocked = locked, hd760MenuOpen = if (locked) false else it.hd760MenuOpen,
                            hd760ScanListOpen = if (locked) false else it.hd760ScanListOpen)
                    }
                    if (old != locked) {
                        hd760LockFeedbackJob?.cancel()
                        _uiState.update { it.copy(hd760LockFeedback =
                            if (locked) "KEYPAD LOCKED" else "KEYPAD UNLOCKED") }
                        hd760LockFeedbackJob = viewModelScope.launch {
                            delay(1600L)
                            _uiState.update { it.copy(hd760LockFeedback = null) }
                        }
                    }
                }
            }
            viewModelScope.launch {
                app.hd760KnobPosition.collect { position ->
                    if (position != null) {
                        hd760Prefs?.savePosition(position)
                        selectHd760Position(position)
                    }
                }
            }
        }
        registerPttFailureReceiver()
        registerPageReceiver()
        observeRadioState()
        checkPendingPage()
        registerFcmToken()
        app.toneEngine.playStartupTone()
    }

    private fun checkPendingPage() {
        val pageId = app.pendingPageId ?: return
        val message = app.pendingPageMessage ?: return
        val sender = app.pendingPageSender ?: "DISPATCH"
        val channelId = app.pendingPageChannelId
        app.pendingPageId = null
        app.pendingPageMessage = null
        app.pendingPageSender = null
        app.pendingPageChannelId = null
        Log.d(TAG, "[PAGE] Consuming pending page id=$pageId")
        _uiState.update { it.copy(showPageAlert = true, pageAlertMessage = message, pageAlertSender = sender) }
        if (!channelId.isNullOrBlank()) {
            channelId.toIntOrNull()?.let { switchToChannelById(it, playAnnouncement = false) }
        }
    }

    private val pageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != CommandCommsFirebaseService.ACTION_PAGE_RECEIVED) return
            val message = intent.getStringExtra(CommandCommsFirebaseService.EXTRA_PAGE_MESSAGE) ?: return
            val sender = intent.getStringExtra(CommandCommsFirebaseService.EXTRA_PAGE_SENDER) ?: "DISPATCH"
            val channelId = intent.getStringExtra(CommandCommsFirebaseService.EXTRA_PAGING_CHANNEL_ID) ?: ""
            Log.d(TAG, "[PAGE] Broadcast received: message=$message sender=$sender channel=$channelId")
            _uiState.update { it.copy(showPageAlert = true, pageAlertMessage = message, pageAlertSender = sender) }
            if (channelId.isNotBlank()) {
                channelId.toIntOrNull()?.let { switchToChannelById(it, playAnnouncement = false) }
            }
        }
    }

    private fun registerPageReceiver() {
        val filter = IntentFilter(CommandCommsFirebaseService.ACTION_PAGE_RECEIVED)
        ContextCompat.registerReceiver(
            getApplication(),
            pageReceiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )
        Log.d(TAG, "Page broadcast receiver registered")
    }

    fun dismissPageAlert() {
        _uiState.update { it.copy(showPageAlert = false) }
    }

    fun switchToChannelById(targetChannelId: Int, playAnnouncement: Boolean = true) {
        val zones = _uiState.value.zones
        for (zoneIdx in zones.indices) {
            val channels = zones[zoneIdx].channels
            for (chIdx in channels.indices) {
                if (channels[chIdx].id == targetChannelId) {
                    val oldRoomKey = _uiState.value.currentChannel?.roomKey
                    _uiState.update { it.copy(currentZoneIndex = zoneIdx, currentChannelIndex = chIdx) }
                    onChannelChangedWithAnnouncement(oldRoomKey) {
                        if (playAnnouncement) {
                            playChannelAnnouncement(targetChannelId)
                        } else {
                            Log.d(TAG, "[PAGE] Skipping channel announcement for page-triggered switch id=$targetChannelId")
                        }
                    }
                    Log.d(TAG, "[PAGE] Switched to paging channel id=$targetChannelId zone=$zoneIdx ch=$chIdx announcement=$playAnnouncement")
                    return
                }
            }
        }
        Log.w(TAG, "[PAGE] Paging channel id=$targetChannelId not found in zones")
    }

    private fun registerFcmToken() {
        viewModelScope.launch {
            try {
                val token = FirebaseMessaging.getInstance().token.await()
                Log.d(TAG, "[FCM] Got token, registering with backend")
                val body = org.json.JSONObject().apply { put("fcmToken", token) }
                    .toString()
                    .toByteArray()
                val mediaType = "application/json".toMediaType()
                val request = okhttp3.Request.Builder()
                    .url("${app.apiClient.baseUrl}/api/radios/fcm-token")
                    .post(body.toRequestBody(mediaType))
                    .build()
                app.apiClient.httpClient.newCall(request).execute().use { resp ->
                    Log.d(TAG, "[FCM] Token registration response: ${resp.code}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "[FCM] Token registration failed: ${e.message}")
            }
        }
    }

    private fun registerPttFailureReceiver() {
        val filter = IntentFilter(BackgroundAudioService.ACTION_PTT_TX_FAILED).apply {
            addAction(BackgroundAudioService.ACTION_PTT_TX_ABORTED)
            addAction(BackgroundAudioService.ACTION_PTT_TX_STARTED)
            addAction(BackgroundAudioService.ACTION_PTT_TX_ENDED)
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
        // Single owner for the channel catalog fetch: HD760 retries transient errors
        // without launching parallel requests or recreating the PTT/audio service.
        if (channelLoadJob?.isActive == true) return
        channelLoadJob = viewModelScope.launch {
            var failedAttempts = 0
            _uiState.update { it.copy(isLoading = true, error = null, channelRetryPending = false) }
            while (isActive) {
                Log.d(STARTUP_TAG, "CHANNEL_FETCH_START attempt=${failedAttempts + 1}")
                val result = app.channelRepository.getZones()
                if (!isActive) return@launch
                if (result.isSuccess) {
                    val zones = result.getOrThrow()
                    Log.d(STARTUP_TAG, "CHANNEL_FETCH_SUCCESS zones=${zones.size} attempts=${failedAttempts + 1}")
                    val allChannels = zones.flatMap { it.channels }
                    val scanChannels = allChannels.map { ch ->
                        ScanChannelItem(ch.id, ch.name, loadScanEnabled(ch.id))
                    }
                    val savedScanning = scanPrefs.getBoolean(KEY_SCAN_ACTIVE, false)
                    if (isHd760) zones.forEach { hd760Prefs?.initializeZone(it) }

                    // Hardware PTT is owned by BackgroundAudioService, which can
                    // continue using a previously authorized saved channel while
                    // this screen has no zones due to an earlier DNS failure.
                    // Match BOTH unit identity and server-provided ID/room key.
                    // Do not switch its live TX to the first catalog channel.
                    val restored = if (isHd760) Hd760ChannelRecovery.findSavedChannel(
                        zones = zones,
                        currentUnitId = _uiState.value.unitId,
                        savedUnitId = app.serviceConnectionPrefs.unitId,
                        savedChannelId = app.serviceConnectionPrefs.channelId,
                        savedRoomKey = app.serviceConnectionPrefs.channelRoomKey
                    ) else null
                    _uiState.update {
                        it.copy(
                            zones = zones,
                            currentZoneIndex = restored?.zoneIndex ?: 0,
                            currentChannelIndex = restored?.channelIndex ?: 0,
                            isLoading = false,
                            error = null,
                            channelRetryPending = false,
                            scanChannels = scanChannels,
                            isScanning = savedScanning
                        )
                    }
                    if (isHd760) {
                        val position = hd760Prefs?.lastPosition()
                        if (restored != null) {
                            _uiState.update {
                                it.copy(hd760KnobPosition = position, hd760SlotEmpty = false)
                            }
                            app.hd760SlotActive.value = true
                            Log.i(STARTUP_TAG,
                                "HD760_CHANNEL_DISPLAY_RESTORED room=${app.serviceConnectionPrefs.channelRoomKey}")
                            // If the physical knob moved during an outage, honor
                            // it only while idle. Never abort an active transmission
                            // solely because the channel catalog recovered.
                            if (position != null) {
                                val mappedId = hd760Prefs?.channelIdForSlot(
                                    zones[restored.zoneIndex], position)
                                if (mappedId != app.serviceConnectionPrefs.channelId) {
                                    val txActive = _uiState.value.pttState != PttState.IDLE ||
                                        _uiState.value.txMediaActive
                                    if (!txActive) {
                                        selectHd760Position(
                                            position, app.serviceConnectionPrefs.channelRoomKey)
                                    } else {
                                        Log.w(STARTUP_TAG,
                                            "HD760_KNOB_RESYNC_DEFERRED reason=active_ptt")
                                    }
                                }
                            }
                        } else {
                            // Normal initial assignment flow; no validated saved
                            // service channel exists in this authorized response.
                            if (position != null) selectHd760Position(position)
                        }
                        syncHd760ScanConfig()
                    }
                    connectSignaling()
                    return@launch
                }
                failedAttempts++
                val failure = result.exceptionOrNull()
                    ?: IllegalStateException("Channel request failed")
                val retry = isHd760 && Hd760ChannelRecovery.shouldRetry(failure)
                Log.e(STARTUP_TAG,
                    "CHANNEL_FETCH_FAILED attempt=$failedAttempts retry=$retry reason=${failure.message}")
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        error = failure.message ?: "Failed to load channels",
                        channelRetryPending = retry
                    )
                }
                if (!retry) return@launch
                val backoffMs = Hd760ChannelRecovery.delayAfterFailureMs(failedAttempts)
                Log.w(STARTUP_TAG,
                    "CHANNEL_FETCH_RETRY_SCHEDULED attempt=$failedAttempts delayMs=$backoffMs")
                delay(backoffMs)
            }
        }
    }

    private fun connectSignaling() {
        val state = _uiState.value
        val unitId = state.unitId.ifBlank { return }
        val username = state.username.ifBlank { unitId }
        Log.d(STARTUP_TAG, "SIGNALING_CONNECT_ATTEMPT url=${app.signalingClient.serverUrl} unitId=$unitId")
        app.signalingRepository.connect(unitId, username)
    }

    private fun observeSignaling() {
        viewModelScope.launch {
            var hadPriorAuth = false
            app.signalingRepository.connectionState.collect { connState ->
                _uiState.update { it.copy(signalingState = connState) }
                if (connState == ConnectionState.AUTHENTICATED) {
                    val wasReconnect = hadPriorAuth
                    val hadEmergency = _uiState.value.myEmergencyActive
                    hadPriorAuth = true
                    val roomKey = _uiState.value.currentChannel?.roomKey
                    if (roomKey != null) {
                        Log.d(STARTUP_TAG, "CHANNEL_JOIN_ATTEMPT channel=$roomKey")
                        app.signalingRepository.joinChannel(roomKey)
                        updateServiceChannel()
                    } else {
                        Log.e(STARTUP_TAG, "CHANNEL_JOIN_FAILED reason=no_current_channel")
                    }
                    if (wasReconnect && hadEmergency && _uiState.value.myEmergencyActive && roomKey != null) {
                        Log.d(TAG, "Signaling reconnected — querying server for emergency status to reconcile local state")
                        app.signalingRepository.queryEmergencyStatus(roomKey)
                    }
                }
            }
        }
        viewModelScope.launch {
            app.signalingRepository.events.collect { event ->
                when (event) {
                    is SignalingEvent.PttStart -> {
                        val state = _uiState.value
                        if (event.unitId != state.unitId) {
                            val currentRoomKey = state.currentChannel?.roomKey
                            if (!state.isScanning || event.channelId == currentRoomKey) {
                                // Priority channel is transmitting — clear any active scan display and stop audio
                                if (state.isScanning && state.scanActiveUnit != null) {
                                    clearScanDisplay()
                                    sendServiceIntent(BackgroundAudioService.ACTION_STOP_SCAN_RX)
                                }
                                _uiState.update { it.copy(activeTransmittingUnit = event.unitId) }
                                activeTransmittingUnitStaleJob?.cancel()
                                activeTransmittingUnitStaleJob = viewModelScope.launch {
                                    delay(ACTIVE_TX_UNIT_STALE_MS)
                                    if (_uiState.value.activeTransmittingUnit == event.unitId) {
                                        Log.w(TAG, """{"event":"ACTIVE_TX_UNIT_STALE_CLEAR","unit":"${event.unitId}"}""")
                                        _uiState.update { it.copy(activeTransmittingUnit = null) }
                                    }
                                }
                            } else {
                                // Non-priority scanned channel — update scan display when:
                                // - no scanned channel is actively transmitting (scanActiveUnit == null), OR
                                // - we are in the 2s hold window after previous scanned RX ended (scanClearJob != null),
                                //   in which case the new transmission takes over and hold timer is cancelled.
                                // In both cases, priority channel must not be active.
                                val inScanList = state.zones.flatMap { it.channels }
                                    .firstOrNull { it.roomKey == event.channelId }
                                    ?.id?.let { id -> state.scanChannels.any { it.id == id && it.enabled } } == true
                                if (inScanList && (state.scanActiveUnit == null || scanClearJob != null) &&
                                    state.activeTransmittingUnit == null) {
                                    val channelName = state.zones.flatMap { it.channels }
                                        .firstOrNull { it.roomKey == event.channelId }?.name
                                    if (channelName != null) {
                                        Log.d(TAG, """{"event":"SCAN_DISPLAY_ACTIVATE","channel":"$channelName","unit":"${event.unitId}"}""")
                                        scanClearJob?.cancel()
                                        scanClearJob = null
                                        _uiState.update {
                                            it.copy(scanActiveChannel = channelName, scanActiveUnit = event.unitId)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    is SignalingEvent.PttEnd -> {
                        val state = _uiState.value
                        val currentRoomKey = state.currentChannel?.roomKey
                        if (event.unitId == state.activeTransmittingUnit) {
                            if (!state.isScanning || event.channelId == currentRoomKey) {
                                activeTransmittingUnitStaleJob?.cancel()
                                _uiState.update { it.copy(activeTransmittingUnit = null) }
                            }
                        }
                        // Check if the ended transmission was on the active scanned channel
                        if (state.isScanning && event.unitId == state.scanActiveUnit
                            && event.channelId != currentRoomKey) {
                            Log.d(TAG, """{"event":"SCAN_DISPLAY_HOLD_START","unit":"${event.unitId}"}""")
                            scanClearJob?.cancel()
                            scanClearJob = viewModelScope.launch {
                                delay(SCAN_DISPLAY_HOLD_MS)
                                Log.d(TAG, """{"event":"SCAN_DISPLAY_CLEAR","unit":"${event.unitId}"}""")
                                _uiState.update { it.copy(scanActiveChannel = null, scanActiveUnit = null) }
                                scanClearJob = null
                            }
                        }
                    }
                    is SignalingEvent.RadioFloorTaken -> {
                        val state = _uiState.value
                        val currentRoomKey = state.currentChannel?.roomKey
                        if (event.channelId == currentRoomKey && event.heldBy != state.unitId) {
                            _uiState.update { it.copy(activeTransmittingUnit = event.heldBy) }
                            activeTransmittingUnitStaleJob?.cancel()
                            activeTransmittingUnitStaleJob = viewModelScope.launch {
                                delay(ACTIVE_TX_UNIT_STALE_MS)
                                if (_uiState.value.activeTransmittingUnit == event.heldBy) {
                                    Log.w(TAG, """{"event":"ACTIVE_TX_UNIT_STALE_CLEAR","unit":"${event.heldBy}"}""")
                                    _uiState.update { it.copy(activeTransmittingUnit = null) }
                                }
                            }
                        }
                    }
                    is SignalingEvent.RadioChannelIdle -> {
                        val state = _uiState.value
                        val currentRoomKey = state.currentChannel?.roomKey
                        if (event.channelId == currentRoomKey && state.activeTransmittingUnit != null) {
                            activeTransmittingUnitStaleJob?.cancel()
                            _uiState.update { it.copy(activeTransmittingUnit = null) }
                        }
                    }
                    is SignalingEvent.EmergencyStart -> {
                        _uiState.update { it.copy(channelEmergencyActive = true, channelEmergencyUnitId = event.unitId) }
                    }
                    is SignalingEvent.EmergencyEnd -> {
                        val state = _uiState.value
                        val cleared = event.unitId == state.unitId
                        if (cleared || state.myEmergencyActive) {
                            // Server-driven clear of THIS unit's emergency (e.g. AI-ack
                            // after a 10-4 reply). Tear down all local state — arming
                            // overlay, cancel-hold, beeps, auto-PTT, GPS, service flag.
                            Log.d(TAG, "EmergencyEnd for own unit=${event.unitId} — full local reset")
                            if (state.pttState != PttState.IDLE) onPttUp()
                            sendServiceIntent(BackgroundAudioService.ACTION_EMERGENCY_CLEAR)
                            forceResetEmergencyState()
                        } else {
                            _uiState.update {
                                it.copy(
                                    channelEmergencyActive = false,
                                    channelEmergencyUnitId = null
                                )
                            }
                        }
                    }
                    is SignalingEvent.EmergencyStatusResponse -> {
                        val currentChannel = _uiState.value.currentChannel?.roomKey
                        if (event.channelId == currentChannel) {
                            if (!event.active && _uiState.value.myEmergencyActive) {
                                Log.d(TAG, "Server reports emergency no longer active — clearing local emergency state")
                                forceResetEmergencyState()
                            } else if (event.active) {
                                Log.d(TAG, "Server confirms emergency still active for unit=${event.unitId}")
                            }
                        }
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
                    is SignalingEvent.UnitJoined -> {
                        if (event.unitId == _uiState.value.unitId) {
                            Log.d(STARTUP_TAG, "CHANNEL_JOIN_SUCCESS channel=${event.channelId}")
                        }
                    }
                    is SignalingEvent.RadioLocked -> {
                        Log.d(TAG, "radio:locked — suspending radio functionality")
                        _uiState.update { it.copy(isRadioLocked = true) }
                    }
                    is SignalingEvent.RadioUnlocked -> {
                        Log.d(TAG, "radio:unlocked — resuming radio functionality")
                        _uiState.update { it.copy(isRadioLocked = false) }
                    }
                    is SignalingEvent.RadioUnassigned -> {
                        Log.d(TAG, "radio:unassigned — navigating to unassigned screen")
                        _uiState.update { it.copy(isRadioUnassigned = true) }
                    }
                    is SignalingEvent.RadioAssigned -> {
                        val newUnitId = event.unitId
                        val currentUnitId = _uiState.value.unitId
                        Log.d(TAG, "radio:assigned — newUnitId=$newUnitId currentUnitId=$currentUnitId")
                        if (newUnitId != currentUnitId && newUnitId.isNotBlank()) {
                            app.radioTokenStore.saveAssignedUnit(newUnitId)
                            app.sessionPrefs.unitId = newUnitId
                            app.sessionPrefs.username = newUnitId
                            _uiState.update { it.copy(reassignedUnitId = newUnitId) }
                        }
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
                    is KeyAction.Hd760Up -> if (isHd760 && !locked) hd760Navigate(-1)
                    is KeyAction.Hd760Down -> if (isHd760 && !locked) hd760Navigate(1)
                    is KeyAction.Hd760Left -> if (isHd760) prevZone()
                    is KeyAction.Hd760Right -> if (isHd760) nextZone()
                    is KeyAction.Hd760Select -> if (isHd760 && !locked) hd760Select()
                    is KeyAction.Hd760Back -> if (isHd760 && !locked) hd760Back()
                    is KeyAction.Hd760SideButton -> if (isHd760) hd760SidePressed(action.button, action.longPress)
                    else -> {
                        if (!locked) when (action) {
                            is KeyAction.DpadUp -> nextChannel()
                            is KeyAction.DpadDown -> prevChannel()
                            is KeyAction.DpadLeft -> prevZone()
                            is KeyAction.DpadRight -> nextZone()
                            is KeyAction.AccToggle -> toggleScanning()
                            // SD7 rotary-knob press → cycle unit status. T320
                            // hardware never emits DpadCenter so this branch
                            // only ever fires on the SD7 build.
                            is KeyAction.DpadCenter -> cycleStatus()
                            // SD7 top side button long-press → toggle scan.
                            is KeyAction.ScanToggle -> toggleScanning()
                            // SD7 bottom side button long-press → add/remove
                            // the currently-selected channel from the scan list.
                            is KeyAction.ScanListToggleCurrent -> {
                                _uiState.value.currentChannel?.id?.let { toggleScanChannel(it) }
                            }
                            else -> {}
                        }
                    }
                }
            }
        }
    }

    private fun observeRadioState() {
        val radioStateManager = app.radioStateManager ?: return
        viewModelScope.launch {
            radioStateManager.state.collect { radioState ->
                _uiState.update {
                    it.copy(
                        radioState = radioState,
                        isChannelBusy = radioState == RadioState.CHANNEL_BUSY || radioState == RadioState.RECEIVING
                    )
                }
                Log.d(TAG, "RadioState updated: $radioState")
            }
        }
        viewModelScope.launch {
            radioStateManager.signalQuality.collect { quality ->
                _uiState.update { it.copy(signalQuality = quality) }
            }
        }
        if (isHd760) {
            viewModelScope.launch {
                radioStateManager.txCaptureActive.collect { active ->
                    _uiState.update { it.copy(txMediaActive = active) }
                }
            }
            viewModelScope.launch {
                radioStateManager.rxMediaActive.collect { active ->
                    _uiState.update { it.copy(rxMediaActive = active) }
                }
            }
            viewModelScope.launch {
                radioStateManager.txAudioBars.collect { bars ->
                    _uiState.update { it.copy(txAudioBars = bars) }
                }
            }
            viewModelScope.launch {
                radioStateManager.rxAudioBars.collect { bars ->
                    _uiState.update { it.copy(rxAudioBars = bars) }
                }
            }
        }
    }

    fun setMicPermissionGranted(granted: Boolean) {
        app.sessionPrefs.micPermissionGranted = granted
        _uiState.update { it.copy(micPermissionGranted = granted) }
        Log.d(TAG, "Mic permission granted=$granted")
    }

    private fun clearScanDisplay() {
        scanClearJob?.cancel()
        scanClearJob = null
        _uiState.update { it.copy(scanActiveChannel = null, scanActiveUnit = null) }
    }

    fun onPttDown() {
        val state = _uiState.value
        if (state.pttState != PttState.IDLE) return
        if (!state.micPermissionGranted) {
            Log.w(TAG, "PTT DOWN: mic permission denied — blocked")
            app.toneEngine.playDeniedBonk()
            return
        }
        val channel = state.currentChannel ?: run {
            Log.w(TAG, "PTT DOWN: no channel selected")
            app.toneEngine.playDeniedBonk()
            return
        }
        // If a scanned channel is currently playing audio, stop it immediately
        if (state.scanActiveUnit != null) {
            Log.d(TAG, "PTT DOWN: stopping scanned channel audio, clearing scan display")
            clearScanDisplay()
            sendServiceIntent(BackgroundAudioService.ACTION_STOP_SCAN_RX)
        }
        // Busy check is always against the priority (selected) channel only
        if (state.activeTransmittingUnit != null && state.activeTransmittingUnit != state.unitId) {
            Log.w(TAG, "PTT DOWN: channel busy — unit=${state.activeTransmittingUnit}")
            app.toneEngine.startDeniedTone()
            return
        }
        Log.d(TAG, "onPttDown roomKey=${channel.roomKey}")
        if (com.reedersystems.commandcomms.BuildConfig.RADIO_DEVICE_TYPE == "android_phone") {
            _uiState.update { it.copy(pttState = PttState.CONNECTING) }
        } else {
            // Preserve existing handheld behavior for T320/other radio flavors.
            app.signalingRepository.transmitPre(channel.roomKey)
            _uiState.update { it.copy(pttState = PttState.TRANSMITTING) }
            app.toneEngine.playTalkPermitTone()
        }
        pttStartJob = viewModelScope.launch {
            sendServiceIntent(BackgroundAudioService.ACTION_PTT_DOWN)
        }
    }

    fun onPttUp() {
        app.toneEngine.stopDeniedTone()
        val state = _uiState.value
        if (state.pttState == PttState.IDLE) return
        pttStartJob?.cancel()
        pttStartJob = null
        val channel = state.currentChannel ?: return
        Log.d(TAG, "onPttUp roomKey=${channel.roomKey}")
        _uiState.update { it.copy(pttState = PttState.IDLE) }
        sendServiceIntent(BackgroundAudioService.ACTION_PTT_UP)
    }

    private fun forceResetEmergencyState() {
        emergencyJob?.cancel()
        emergencyJob = null
        cancelArmingJob?.cancel()
        cancelArmingJob = null
        armingJob?.cancel()
        armingJob = null
        armingDeadlineMs = 0L
        armingExpired = false
        app.toneEngine.stopCountdownBeep()
        _uiState.update {
            it.copy(
                emergencyHoldProgress = null,
                isEmergencyCancelling = false,
                emergencyArming = false,
                emergencyArmingSecondsRemaining = 0,
                myEmergencyActive = false,
                channelEmergencyActive = false,
                channelEmergencyUnitId = null
            )
        }
        locationTracker.stopTracking()
        Log.d(TAG, "Emergency state force-reset complete")
    }

    private fun onEmergencyDown() {
        // Dedup: BackgroundAudioService.handleEmergencyDown forwards to keyEventFlow
        // AND brings MainActivity to front; if a stale duplicate intent arrives via
        // onNewIntent we may see two events back-to-back. Drop any DOWN within 200ms
        // of the previous one — a real T320 user can't physically tap that fast.
        val now = SystemClock.elapsedRealtime()
        if (now - lastEmergencyDownAt < 200L) {
            Log.d(TAG, "onEmergencyDown: deduped (within 200ms of previous)")
            return
        }
        lastEmergencyDownAt = now

        val state = _uiState.value

        // Repeat-press guard: if any cancel-hold is already in progress (cancelling
        // either an arming countdown or an active emergency), additional presses
        // must NOT restart it or trigger anything else.
        if (cancelArmingJob != null || emergencyJob != null) {
            Log.d(TAG, "onEmergencyDown: ignored — cancel hold already in progress")
            return
        }

        when {
            // 1) Active emergency → press starts the 3s hold-to-clear.
            state.myEmergencyActive -> {
                Log.d(TAG, "onEmergencyDown: emergency active → start cancel-hold")
                startCancelHold()
            }
            // 2) Arming countdown running → press starts 3s hold-to-cancel-arming.
            state.emergencyArming -> {
                Log.d(TAG, "onEmergencyDown: arming → start cancel-arming hold")
                startCancelArming()
            }
            // 3) Idle → start the 5s arming countdown.
            else -> {
                Log.d(TAG, "onEmergencyDown: idle → start 5s arming")
                startArming()
            }
        }
    }

    private fun onEmergencyUp() {
        val state = _uiState.value
        when {
            // Releasing during the cancel-arming-hold debounce (<150ms): nothing
            // user-visible happened. If arming already expired during the brief
            // debounce, activate; otherwise arming keeps running to completion.
            cancelArmingJob != null && !state.isEmergencyCancelling -> {
                cancelArmingJob?.cancel()
                cancelArmingJob = null
                if (armingExpired) {
                    Log.d(TAG, "CANCEL ARMING: debounce release after deadline — activating")
                    completeArmingAndActivate()
                } else {
                    Log.d(TAG, "CANCEL ARMING: quick release in debounce — arming continues")
                }
            }
            // Releasing mid-cancel-arming-hold (after debounce, before 3s done):
            // abort the cancel. If the arming deadline elapsed during the hold,
            // activate immediately per spec; otherwise the arming job is still
            // counting down and will activate on its own.
            cancelArmingJob != null && state.isEmergencyCancelling -> {
                cancelArmingJob?.cancel()
                cancelArmingJob = null
                app.toneEngine.stopCountdownBeep()
                _uiState.update { it.copy(isEmergencyCancelling = false, emergencyHoldProgress = null) }
                if (armingExpired) {
                    Log.d(TAG, "CANCEL ARMING: released early but deadline elapsed — activating")
                    completeArmingAndActivate()
                } else {
                    Log.d(TAG, "CANCEL ARMING: released early — arming continues")
                }
            }
            // Releasing mid-cancel-hold for an ACTIVE emergency: abort the clear.
            emergencyJob != null && state.isEmergencyCancelling && state.myEmergencyActive -> {
                emergencyJob?.cancel()
                emergencyJob = null
                app.toneEngine.stopCountdownBeep()
                _uiState.update { it.copy(isEmergencyCancelling = false, emergencyHoldProgress = null) }
                Log.d(TAG, "CANCEL HOLD: aborted early")
            }
            // Releasing while arming with no cancel-hold in progress: ignore (the
            // arming runs autonomously to completion).
            else -> {
                Log.d(TAG, "onEmergencyUp: nothing to do (arming continues if running)")
            }
        }
    }

    private fun startArming() {
        armingExpired = false
        armingDeadlineMs = SystemClock.elapsedRealtime() + 5000L
        _uiState.update { it.copy(emergencyArming = true, emergencyArmingSecondsRemaining = 5) }
        app.toneEngine.playArmingBeep()

        armingJob = viewModelScope.launch {
            var lastSecondBeeped = 5
            while (true) {
                delay(100)
                val remaining = armingDeadlineMs - SystemClock.elapsedRealtime()
                if (remaining <= 0L) {
                    _uiState.update { it.copy(emergencyArmingSecondsRemaining = 0) }
                    if (cancelArmingJob != null) {
                        // User is holding to cancel — defer activation until we know
                        // whether the hold completes (cancel) or is released (activate).
                        Log.d(TAG, "ARMING: deadline reached during cancel-hold — deferring")
                        armingExpired = true
                        return@launch
                    }
                    break
                }
                val secsRemaining = ((remaining + 999) / 1000).toInt().coerceIn(1, 5)
                if (secsRemaining < lastSecondBeeped) {
                    lastSecondBeeped = secsRemaining
                    app.toneEngine.playArmingBeep()
                }
                _uiState.update { it.copy(emergencyArmingSecondsRemaining = secsRemaining) }
            }
            completeArmingAndActivate()
        }
    }

    private fun completeArmingAndActivate() {
        armingJob?.cancel()
        armingJob = null
        armingDeadlineMs = 0L
        armingExpired = false
        _uiState.update { it.copy(emergencyArming = false, emergencyArmingSecondsRemaining = 0) }
        onEmergencyActivate()
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
            // Held the full 3 seconds — cancel arming entirely (even if the arming
            // deadline elapsed mid-hold, holding to 3s ALWAYS wins per spec).
            cancelArmingJob = null
            armingJob?.cancel()
            armingJob = null
            armingDeadlineMs = 0L
            armingExpired = false
            app.toneEngine.stopCountdownBeep()
            _uiState.update {
                it.copy(
                    isEmergencyCancelling = false,
                    emergencyHoldProgress = null,
                    emergencyArming = false,
                    emergencyArmingSecondsRemaining = 0
                )
            }
            Log.d(TAG, "CANCEL ARMING: completed — arming cancelled")
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
        // Service owns the signaling broadcast (single source of truth) so other
        // surfaces — dispatchers + cross-channel units — are notified consistently.
        sendServiceIntent(BackgroundAudioService.ACTION_EMERGENCY_ACTIVATE)
        locationTracker.startTracking()
        Log.d(TAG, "EMERGENCY ACTIVE — automatic TX suppressed; PTT remains user-controlled")
    }

    private fun onEmergencyClear() {
        val channel = _uiState.value.currentChannel ?: return
        Log.d(TAG, "EMERGENCY CLEAR roomKey=${channel.roomKey}")
        _uiState.update { it.copy(myEmergencyActive = false) }
        app.signalingRepository.emergencyEnd(channel.roomKey)
        locationTracker.stopTracking()
        if (_uiState.value.pttState != PttState.IDLE) onPttUp()
        sendServiceIntent(BackgroundAudioService.ACTION_EMERGENCY_CLEAR)
    }

    fun cycleStatus() {
        val current = _uiState.value.currentStatus
        val idx = STATUS_CYCLE.indexOf(current)
        val next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.size]
        _uiState.update { it.copy(currentStatus = next) }
        app.signalingRepository.setStatus(next)
    }

    fun consumeRadioUnassigned() {
        _uiState.update { it.copy(isRadioUnassigned = false) }
    }

    fun consumeReassigned() {
        _uiState.update { it.copy(reassignedUnitId = null) }
    }

    fun toggleKeyLock() {
        if (isHd760) {
            val next = !app.hd760KeyLocked.value
            app.hd760KeyLocked.value = next
            getApplication<Application>().getSharedPreferences("HD760Hardware", Context.MODE_PRIVATE)
                .edit().putBoolean("key_locked", next).apply()
            app.toneEngine.playKeypadConfirmation()
        } else _uiState.update { it.copy(isKeyLocked = !it.isKeyLocked) }
    }

    fun toggleScanning() {
        val next = !_uiState.value.isScanning
        scanPrefs.edit().putBoolean(KEY_SCAN_ACTIVE, next).apply()
        if (!next) {
            clearScanDisplay()
        }
        _uiState.update { it.copy(isScanning = next) }
        syncHd760ScanConfig()
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
        syncHd760ScanConfig()
    }

    private fun loadScanEnabled(channelId: Int): Boolean =
        scanPrefs.getBoolean(scanPrefKey(channelId), true)

    private fun scanPrefKey(channelId: Int): String {
        if (!isHd760) return "scan_$channelId"
        val identity = app.radioTokenStore.getAssignedUnitId() ?: _uiState.value.unitId
        return "hd760:" + identity + ":scan:" + channelId
    }

    private fun saveScanEnabled(channelId: Int, enabled: Boolean) {
        scanPrefs.edit().putBoolean(scanPrefKey(channelId), enabled).apply()
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
        ContextCompat.startForegroundService(getApplication<Application>(), intent)
    }

    private fun sendServiceIntent(action: String) {
        val intent = Intent(getApplication(), BackgroundAudioService::class.java).apply {
            this.action = action
            putExtra(BackgroundAudioService.EXTRA_NEEDS_SIGNALING, false)
        }
        ContextCompat.startForegroundService(getApplication<Application>(), intent)
    }

    private fun selectHd760Position(position: Int, oldRoomKeyOverride: String? = null) {
        if (!isHd760 || position !in 0 until Hd760KnobMapping.SLOT_COUNT) return
        _uiState.update { it.copy(hd760KnobPosition = position, hd760ProgrammingSlot = false) }
        val zone = _uiState.value.currentZone ?: return
        val channelId = hd760Prefs?.channelIdForSlot(zone, position)
        val index = zone.channels.indexOfFirst { it.id == channelId }
        if (channelId == null || index < 0) {
            _uiState.update { it.copy(hd760SlotEmpty = true) }
            app.hd760SlotActive.value = false
            val previous = oldRoomKeyOverride ?: _uiState.value.currentChannel?.roomKey
            if (previous != null) app.signalingRepository.leaveChannel(previous)
            app.serviceConnectionPrefs.channelId = -1
            app.serviceConnectionPrefs.channelRoomKey = null
            app.serviceConnectionPrefs.channelName = null
            Log.w(TAG, "HD760_EMPTY_SLOT zone=" + zone.name + " position=" + position)
            return
        }
        val oldRoomKey = oldRoomKeyOverride ?: _uiState.value.currentChannel?.roomKey
        val wasActive = app.hd760SlotActive.value
        _uiState.update { it.copy(currentChannelIndex = index, hd760SlotEmpty = false) }
        app.hd760SlotActive.value = true
        val newRoomKey = _uiState.value.currentChannel?.roomKey
        if (oldRoomKey != newRoomKey || !wasActive) {
            // Join the target immediately; coalesce spoken announcements.
            onChannelChanged(if (wasActive) oldRoomKey else null)
            if (!wasActive && newRoomKey != null &&
                app.signalingRepository.connectionState.value == ConnectionState.AUTHENTICATED) {
                app.signalingRepository.joinChannel(newRoomKey)
            }
            hd760AnnouncementJob?.cancel()
            hd760AnnouncementJob = viewModelScope.launch {
                delay(250L)
                playChannelAnnouncement(channelId)
            }
        }
    }

    private fun hd760Navigate(direction: Int) {
        val state = _uiState.value
        if (!state.hd760MenuOpen) {
            _uiState.update { it.copy(hd760MenuOpen = true, hd760MenuIndex = 0) }
            return
        }
        if (state.hd760ScanListOpen) {
            val count = state.scanChannels.size
            if (count > 0) _uiState.update {
                it.copy(hd760ScanListIndex =
                    (it.hd760ScanListIndex + direction + count) % count)
            }
        } else {
            val count = hd760MenuLabels.size
            _uiState.update {
                it.copy(hd760MenuIndex = (it.hd760MenuIndex + direction + count) % count)
            }
        }
    }

    private fun hd760Back() {
        _uiState.update { state ->
            when {
                state.hd760ScanListOpen -> state.copy(hd760ScanListOpen = false)
                state.hd760MenuOpen -> state.copy(hd760MenuOpen = false)
                else -> state
            }
        }
    }

    private fun hd760Select() {
        val state = _uiState.value
        if (!state.hd760MenuOpen) {
            _uiState.update { it.copy(hd760MenuOpen = true, hd760MenuIndex = 0) }
            return
        }
        if (state.hd760ScanListOpen) {
            state.scanChannels.getOrNull(state.hd760ScanListIndex)
                ?.id?.let(::toggleScanChannel)
            return
        }
        when (state.hd760MenuIndex) {
            0 -> toggleScanning()
            1 -> _uiState.update { it.copy(hd760ScanListOpen = true, hd760ScanListIndex = 0) }
            in 2..5 -> {
                val button = if (state.hd760MenuIndex <= 3) 1 else 2
                val longPress = state.hd760MenuIndex == 3 || state.hd760MenuIndex == 5
                hd760Prefs?.cycleButtonAction(button, longPress)
                _uiState.update { it.copy(hd760MenuVersion = it.hd760MenuVersion + 1) }
            }
            6 -> _uiState.update { it.copy(hd760MenuOpen = false) }
        }
    }

    fun consumeHd760SettingsRequest() {
        _uiState.update { it.copy(hd760SettingsRequested = false) }
    }

    private fun hd760SidePressed(button: Int, longPress: Boolean) {
        when (hd760Prefs?.buttonAction(button, longPress)) {
            Hd760SideAction.NONE, null -> Unit
            Hd760SideAction.SCAN -> toggleScanning()
            Hd760SideAction.SCAN_LIST -> _uiState.update {
                it.copy(hd760MenuOpen = true, hd760ScanListOpen = true, hd760ScanListIndex = 0)
            }
            Hd760SideAction.MENU -> _uiState.update {
                it.copy(hd760MenuOpen = !it.hd760MenuOpen, hd760ScanListOpen = false)
            }
        }
    }

    fun nextZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val next = (_uiState.value.currentZoneIndex + 1) % zones.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentZoneIndex = next, currentChannelIndex = 0) }
        val newZone = _uiState.value.currentZone
        val newChannel = _uiState.value.currentChannel
        if (isHd760) {
            val position = hd760Prefs?.lastPosition()
            if (position != null) selectHd760Position(position, oldRoomKey)
            else onChannelChanged(oldRoomKey)
        } else onChannelChangedWithAnnouncement(oldRoomKey) {
            playZoneThenChannelAnnouncement(newZone?.id, newChannel?.id)
        }
    }

    fun prevZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val p = (_uiState.value.currentZoneIndex - 1 + zones.size) % zones.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentZoneIndex = p, currentChannelIndex = 0) }
        val newZone = _uiState.value.currentZone
        val newChannel = _uiState.value.currentChannel
        if (isHd760) {
            val position = hd760Prefs?.lastPosition()
            if (position != null) selectHd760Position(position, oldRoomKey)
            else onChannelChanged(oldRoomKey)
        } else onChannelChangedWithAnnouncement(oldRoomKey) {
            playZoneThenChannelAnnouncement(newZone?.id, newChannel?.id)
        }
    }

    fun nextChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val next = (_uiState.value.currentChannelIndex + 1) % channels.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentChannelIndex = next) }
        val newChannel = _uiState.value.currentChannel
        onChannelChangedWithAnnouncement(oldRoomKey) {
            newChannel?.id?.let { playChannelAnnouncement(it) }
        }
    }

    fun prevChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val p = (_uiState.value.currentChannelIndex - 1 + channels.size) % channels.size
        val oldRoomKey = _uiState.value.currentChannel?.roomKey
        _uiState.update { it.copy(currentChannelIndex = p) }
        val newChannel = _uiState.value.currentChannel
        onChannelChangedWithAnnouncement(oldRoomKey) {
            newChannel?.id?.let { playChannelAnnouncement(it) }
        }
    }

    private fun onChannelChanged(oldRoomKey: String? = null) {
        val newRoomKey = _uiState.value.currentChannel?.roomKey
        if (oldRoomKey != null && oldRoomKey != newRoomKey) {
            activeTransmittingUnitStaleJob?.cancel()
            _uiState.update { it.copy(activeTransmittingUnit = null) }
            if (app.signalingRepository.connectionState.value == ConnectionState.AUTHENTICATED) {
                app.signalingRepository.leaveChannel(oldRoomKey)
                if (newRoomKey != null) {
                    app.signalingRepository.joinChannel(newRoomKey)
                }
            }
        }
        updateServiceChannel()
    }

    private fun onChannelChangedWithAnnouncement(
        oldRoomKey: String?,
        announcementBlock: suspend () -> Unit
    ) {
        val newRoomKey = _uiState.value.currentChannel?.roomKey
        if (oldRoomKey != null && oldRoomKey != newRoomKey) {
            activeTransmittingUnitStaleJob?.cancel()
            _uiState.update { it.copy(activeTransmittingUnit = null) }
            if (app.signalingRepository.connectionState.value == ConnectionState.AUTHENTICATED) {
                app.signalingRepository.leaveChannel(oldRoomKey)
            }
        }
        viewModelScope.launch {
            announcementBlock()
            val activeRoomKey = _uiState.value.currentChannel?.roomKey
            if (activeRoomKey != null && activeRoomKey != oldRoomKey &&
                app.signalingRepository.connectionState.value == ConnectionState.AUTHENTICATED
            ) {
                app.signalingRepository.joinChannel(activeRoomKey)
            }
            updateServiceChannel()
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

    private suspend fun playPcmAudio(pcmBytes: ByteArray) = kotlinx.coroutines.withContext(
        kotlinx.coroutines.Dispatchers.IO
    ) {
        val sampleRate = 16000
        val channelConfig = AudioFormat.CHANNEL_OUT_MONO
        val encoding = AudioFormat.ENCODING_PCM_16BIT
        val minBuf = AudioTrack.getMinBufferSize(sampleRate, channelConfig, encoding)
        val bufSize = maxOf(minBuf, pcmBytes.size)
        var track: AudioTrack? = null
        try {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
            val format = AudioFormat.Builder()
                .setSampleRate(sampleRate)
                .setChannelMask(channelConfig)
                .setEncoding(encoding)
                .build()
            track = AudioTrack.Builder()
                .setAudioAttributes(attrs)
                .setAudioFormat(format)
                .setBufferSizeInBytes(bufSize)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(pcmBytes, 0, pcmBytes.size)
            track.play()
            val durationMs = (pcmBytes.size.toLong() * 1000L) / (sampleRate * 2)
            kotlinx.coroutines.delay(durationMs + 100)
        } catch (e: Exception) {
            Log.w(TAG, "Announcement PCM playback error: ${e.message}")
        } finally {
            runCatching { track?.stop() }
            runCatching { track?.release() }
        }
    }

    private suspend fun playChannelAnnouncement(channelId: Int) {
        val result = app.channelRepository.fetchChannelAnnouncementAudio(channelId)
        result.onSuccess { bytes ->
            playPcmAudio(bytes)
        }.onFailure { err ->
            Log.w(TAG, "Channel announcement fetch failed channelId=$channelId: ${err.message}")
        }
    }

    private suspend fun playZoneThenChannelAnnouncement(zoneId: Int?, channelId: Int?) {
        if (zoneId != null) {
            val zoneResult = app.channelRepository.fetchZoneAnnouncementAudio(zoneId)
            zoneResult.onSuccess { bytes ->
                playPcmAudio(bytes)
            }.onFailure { err ->
                Log.w(TAG, "Zone announcement fetch failed zoneId=$zoneId: ${err.message}")
            }
        }
        if (channelId != null) {
            val channelResult = app.channelRepository.fetchChannelAnnouncementAudio(channelId)
            channelResult.onSuccess { bytes ->
                playPcmAudio(bytes)
            }.onFailure { err ->
                Log.w(TAG, "Channel announcement fetch failed channelId=$channelId: ${err.message}")
            }
        }
    }

    override fun onCleared() {
        emergencyJob?.cancel()
        cancelArmingJob?.cancel()
        activeTransmittingUnitStaleJob?.cancel()
        scanClearJob?.cancel()
        app.toneEngine.stopCountdownBeep()
        locationTracker.stopTracking()
        runCatching { getApplication<Application>().unregisterReceiver(pttTxFailedReceiver) }
        runCatching { getApplication<Application>().unregisterReceiver(pageReceiver) }
        super.onCleared()
    }
}
