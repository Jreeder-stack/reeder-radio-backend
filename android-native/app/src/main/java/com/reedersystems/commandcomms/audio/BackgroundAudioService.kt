package com.reedersystems.commandcomms.audio

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.KeyAction
import com.reedersystems.commandcomms.MainActivity
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import com.reedersystems.commandcomms.audio.radio.FloorControlEvent
import com.reedersystems.commandcomms.audio.radio.RadioAudioEngine
import com.reedersystems.commandcomms.audio.radio.RadioSignalingGatewayImpl
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.audio.radio.TransportHealth
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first

private const val TAG = "[PTT-DIAG]"
private const val NOTIFICATION_ID = 1001
private const val CHANNEL_ID = "ptt_service"

class BackgroundAudioService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var radioEngine: RadioAudioEngine? = null
    private lateinit var servicePrefs: ServiceConnectionPrefs
    private val app get() = application as CommandCommsApp

    private lateinit var serviceWakeLock: PowerManager.WakeLock
    private lateinit var wifiLock: WifiManager.WifiLock

    private lateinit var audioManager: AudioManager
    private var previousAudioMode: Int = AudioManager.MODE_NORMAL
    private var previousSpeakerphoneOn: Boolean = false

    private var dynamicPttReceiver: BroadcastReceiver? = null

    private var pttState = PttState.IDLE

    @Volatile private var pttUpWhileConnecting = false
    private var preCaptureSetupJob: Job? = null

    @Volatile private var needsSignaling = false

    @Volatile private var joinedSignalingChannelId: String? = null
    @Volatile private var lastAuthenticatedTimeMs: Long = 0L
    @Volatile private var cleaningUpSinceMs: Long = 0L
    @Volatile private var lastPttUpTimeMs: Long = 0L
    @Volatile private var lastErrorToneMs: Long = 0L
    @Volatile private var pendingSignalingChannelId: String? = null

    private var emergencyActivatingJob: Job? = null

    @Volatile private var emergencyActive = false

    private var signalingConnectionJob: Job? = null
    private var signalingEventsJob: Job? = null
    private var pendingFloorTimeoutJob: Job? = null

    @Volatile private var hadPriorAuthentication = false
    @Volatile private var reconnectStartTimeMs: Long = 0L
    @Volatile private var pendingFirstPttAfterReconnect = false

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "BackgroundAudioService created")

        val pm = getSystemService(POWER_SERVICE) as PowerManager
        serviceWakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            WAKE_LOCK_TAG
        ).apply { setReferenceCounted(false) }
        serviceWakeLock.acquire()
        Log.d(TAG, "BackgroundAudioService: service-lifetime WakeLock acquired")

        val wifiManager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        wifiLock = wifiManager.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "CommandComms::AudioServiceWifi"
        ).apply { setReferenceCounted(false) }
        wifiLock.acquire()
        Log.d(TAG, "BackgroundAudioService: WiFi WakeLock acquired")

        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        previousAudioMode = audioManager.mode
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            previousSpeakerphoneOn = audioManager.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        } else {
            @Suppress("DEPRECATION")
            previousSpeakerphoneOn = audioManager.isSpeakerphoneOn
        }
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val speakerDevice = audioManager.availableCommunicationDevices
                .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
            if (speakerDevice != null) {
                audioManager.setCommunicationDevice(speakerDevice)
            }
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = true
        }
        Log.d(TAG, "BackgroundAudioService: loudspeaker forced on (prev mode=$previousAudioMode, prev speaker=$previousSpeakerphoneOn)")

        servicePrefs = ServiceConnectionPrefs(applicationContext)

        initRadioEngine()
        observeRadioSignalingEvents()

        startForeground(NOTIFICATION_ID, buildNotification("Radio — Standby"))
        registerDynamicPttReceiver()
        startBackgroundSignalingObservers()
        ensureBackgroundSignalingConnected()
    }

    private fun registerDynamicPttReceiver() {
        val filter = IntentFilter().apply {
            addAction(PttHardwareReceiver.ACTION_PTT_DOWN)
            addAction(PttHardwareReceiver.ACTION_PTT_UP)
            addAction("android.intent.action.PTT")
            addAction("android.intent.action.PTT.down")
            addAction("android.intent.action.PTT.up")
            addAction("android.intent.action.PTT.longpress")
            addAction("android.intent.action.PTT_LONGPRESS")
            addAction("com.inrico.ptt.longpress")
            addAction("com.inrico.intent.action.PTT_LONGPRESS")
            addAction("android.intent.action.PTT_DOWN")
            addAction("android.intent.action.PTT_UP")
            addAction("android.intent.action.PTT_KEY_DOWN")
            addAction("android.intent.action.PTT_KEY_UP")
            addAction("com.inrico.ptt.down")
            addAction("com.inrico.ptt.up")
            addAction("com.inrico.ptt.PTT_KEY_DOWN")
            addAction("com.inrico.ptt.PTT_KEY_UP")
            addAction("com.inrico.intent.action.PTT_DOWN")
            addAction("com.inrico.intent.action.PTT_UP")
            addAction("com.android.server.telecom.PushToTalk.action.PTT_KEY_DOWN")
            addAction("com.android.server.telecom.PushToTalk.action.PTT_KEY_UP")
            addAction(PttHardwareReceiver.ACTION_EMERGENCY_DOWN)
            addAction(PttHardwareReceiver.ACTION_EMERGENCY_UP)
            addAction("android.intent.action.EMERGENCY_DOWN")
            addAction("android.intent.action.EMERGENCY_UP")
            addAction("android.intent.action.EMERGENCY.down")
            addAction("android.intent.action.EMERGENCY.up")
            addAction("com.inrico.emergency.down")
            addAction("com.inrico.emergency.up")
            addAction("com.inrico.emergency.EMERGENCY.down")
            addAction("com.inrico.emergency.EMERGENCY.up")
            addAction("com.inrico.intent.action.EMERGENCY_DOWN")
            addAction("com.inrico.intent.action.EMERGENCY_UP")
            addAction("com.inrico.intent.action.EMERGENCY.down")
            addAction("com.inrico.intent.action.EMERGENCY.up")
            addAction("android.intent.action.SOS.down")
            addAction("android.intent.action.SOS.up")
            addAction("android.intent.action.SOS.shortpress")
            addAction("android.intent.action.SOS_KEY_DOWN")
            addAction("android.intent.action.SOS_KEY_UP")
            addAction("com.inrico.sos.down")
            addAction("com.inrico.sos.up")
            addAction("com.inrico.intent.action.SOS_KEY_DOWN")
            addAction("com.inrico.intent.action.SOS_KEY_UP")
        }
        val receiver = PttHardwareReceiver()
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        dynamicPttReceiver = receiver
        Log.d(TAG, "Dynamic PttHardwareReceiver registered")
    }

    // ── DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────────
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PTT_DOWN -> {
                handleRadioPttDown(intent.getBooleanExtra(EXTRA_NEEDS_SIGNALING, false))
            }
            ACTION_PTT_UP -> {
                handleRadioPttUp()
            }
            ACTION_EMERGENCY_DOWN -> handleEmergencyDown()
            ACTION_EMERGENCY_UP -> handleEmergencyUp()
            ACTION_EMERGENCY_CLEAR -> handleEmergencyClear()
            ACTION_UPDATE_CHANNEL -> {
                val channelId = intent.getIntExtra(EXTRA_CHANNEL_ID, -1)
                val roomKey = intent.getStringExtra(EXTRA_ROOM_KEY)
                val channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME)
                if (channelId >= 0 && roomKey != null) {
                    servicePrefs.channelId = channelId
                    servicePrefs.channelRoomKey = roomKey
                    if (channelName != null) servicePrefs.channelName = channelName
                    Log.d(TAG, "Channel updated: $channelId / $roomKey")
                    radioEngine?.udpTransport?.channelId = roomKey
                    radioEngine?.udpTransport?.channelIndex = channelId
                    radioEngine?.stateManager?.activeChannelKey = roomKey
                    ensureBackgroundSignalingConnected()
                    scope.launch { syncBackgroundSignalingChannel() }
                }
            }
            ACTION_STOP -> {
                Log.d(TAG, "Service stop requested")
                restoreSpeakerState()
                radioEngine?.stop()
                stopSelf()
            }
        }
        // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────
        return START_STICKY
    }

    private fun handleEmergencyClear() {
        Log.d(TAG, "handleEmergencyClear emergencyActive=$emergencyActive pttState=$pttState")
        emergencyActive = false
        emergencyActivatingJob?.cancel()
        emergencyActivatingJob = null

        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING || pttState == PttState.CLEANING_UP) {
            handleRadioPttUp()
        }

        sendEmergencyCancelled()
        updateNotification("Radio — Standby")
        radioEngine?.startReceive()
        Log.d(TAG, "handleEmergencyClear: cleanup complete, RX pipeline ensured")
    }

    private fun handleEmergencyDown() {
        Log.d(TAG, "handleEmergencyDown emergencyActive=$emergencyActive")

        if (emergencyActive) {
            if (pttState == PttState.IDLE) {
                Log.w(TAG, "handleEmergencyDown: emergencyActive=true but pttState=IDLE — force-resetting stale flag")
                emergencyActive = false
            } else {
                app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
                return
            }
        }

        if (emergencyActivatingJob != null) return

        val channelId = servicePrefs.channelId.takeIf { it >= 0 } ?: run {
            Log.w(TAG, "Emergency: no channel selected")
            return
        }
        val channelKey = servicePrefs.channelRoomKey ?: run {
            Log.w(TAG, "Emergency: no room key")
            return
        }

        @Suppress("DEPRECATION")
        val wl = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "CommandComms:EmergencyWake"
        ).apply { setReferenceCounted(false) }
        wl.acquire(5_000L)

        emergencyActivatingJob = scope.launch {
            try {
                activateEmergency(channelId, channelKey)
            } finally {
                emergencyActivatingJob = null
            }
        }
    }

    private suspend fun activateEmergency(channelId: Int, channelKey: String) {
        Log.d(TAG, "activateEmergency channelId=$channelId channelKey=$channelKey")
        emergencyActive = true
        updateNotification("EMERGENCY ACTIVE")

        ensureBackgroundSignalingReady(channelId)

        app.signalingRepository.emergencyStart(channelKey)
        Log.d(TAG, "activateEmergency: emergencyStart signal sent for $channelKey")

        sendEmergencyActivated()

        handleRadioPttDown(signaling = true)
    }

    private fun handleEmergencyUp() {
        Log.d(TAG, "handleEmergencyUp active=$emergencyActive")
        app.keyEventFlow.tryEmit(KeyAction.EmergencyUp)
    }

    private fun startBackgroundSignalingObservers() {
        if (signalingConnectionJob == null) {
            signalingConnectionJob = scope.launch {
                app.signalingRepository.connectionState.collectLatest { state ->
                    when (state) {
                        ConnectionState.AUTHENTICATED -> {
                            lastAuthenticatedTimeMs = System.currentTimeMillis()
                            val isReconnect = hadPriorAuthentication
                            if (isReconnect) {
                                val reconnectDurationMs = if (reconnectStartTimeMs > 0) {
                                    System.currentTimeMillis() - reconnectStartTimeMs
                                } else 0L
                                Log.d(TAG, "RECONNECT_SIGNALING_REAUTHENTICATED reconnectDurationMs=$reconnectDurationMs")
                                pendingFirstPttAfterReconnect = true
                                reconnectStartTimeMs = 0L
                                triggerReconnectPipelineReset()
                            } else {
                                Log.d(TAG, "LATENCY_SIGNALING_FIRST_AUTH")
                            }
                            syncBackgroundSignalingChannel()
                            hadPriorAuthentication = true
                        }
                        ConnectionState.DISCONNECTED -> {
                            if (hadPriorAuthentication) {
                                reconnectStartTimeMs = System.currentTimeMillis()
                                Log.d(TAG, "RECONNECT_SIGNALING_DISCONNECTED — tracking reconnect latency")
                            }
                            joinedSignalingChannelId = null
                            pendingSignalingChannelId = null
                        }
                        else -> Unit
                    }
                }
            }
        }

        if (signalingEventsJob == null) {
            signalingEventsJob = scope.launch {
                app.signalingRepository.events.collect { event ->
                    when (event) {
                        is SignalingEvent.EmergencyEnd -> {
                            if (emergencyActive) {
                                emergencyActive = false
                                updateNotification("Radio — Standby")
                                Log.d(TAG, "Emergency ended")
                            }
                        }
                        is SignalingEvent.ClearAirStart -> {
                            Log.d(TAG, "Clear Air started")
                        }
                        is SignalingEvent.ClearAirEnd -> {
                            Log.d(TAG, "Clear Air ended")
                        }
                        else -> Unit
                    }
                }
            }
        }
    }

    private fun ensureBackgroundSignalingConnected() {
        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: return
        val username = app.sessionPrefs.username ?: unitId
        startBackgroundSignalingObservers()
        app.signalingRepository.connect(unitId, username)
    }

    private suspend fun ensureBackgroundSignalingReady(channelId: Int): Boolean {
        ensureBackgroundSignalingConnected()
        val authenticated = when (app.signalingRepository.connectionState.value) {
            ConnectionState.AUTHENTICATED -> true
            else -> withTimeoutOrNull(5_000L) {
                app.signalingRepository.connectionState.first { it == ConnectionState.AUTHENTICATED }
            } != null
        }
        if (!authenticated) return false

        servicePrefs.channelId = channelId
        if (!syncBackgroundSignalingChannel()) return false

        val targetRoomKey = currentTargetRoomKey() ?: return false
        return when {
            joinedSignalingChannelId == targetRoomKey -> true
            else -> withTimeoutOrNull(3_000L) {
                while (joinedSignalingChannelId != targetRoomKey) {
                    delay(50L)
                }
                true
            } != null
        }
    }

    private fun currentTargetRoomKey(): String? = servicePrefs.channelRoomKey

    private suspend fun syncBackgroundSignalingChannel(): Boolean {
        if (app.signalingRepository.connectionState.value != ConnectionState.AUTHENTICATED) {
            return false
        }

        val targetRoomKey = currentTargetRoomKey() ?: return false
        if (joinedSignalingChannelId == targetRoomKey) return true

        val previousRoomKey = joinedSignalingChannelId
        if (previousRoomKey != null) {
            app.signalingRepository.leaveRadioChannel(previousRoomKey)
        }
        val udpPort = radioEngine?.udpTransport?.localPort
        app.signalingRepository.joinRadioChannel(targetRoomKey, udpPort)
        pendingSignalingChannelId = targetRoomKey
        radioEngine?.startReceive()
        Log.d(TAG, "RADIO_CHANNEL_JOINED requested channelId=$targetRoomKey")
        Log.d(TAG, "RADIO_SUBSCRIBER_REGISTERED channelId=$targetRoomKey udpPort=${udpPort ?: "none"}")
        Log.d(TAG, "Background signaling join requested for RADIO channel $targetRoomKey (udpPort=${udpPort ?: "none"}) — awaiting join ack")
        return true
    }

    private fun initRadioEngine() {
        val engine = RadioAudioEngine(applicationContext)

        val appStateManager = app.radioStateManager
        if (appStateManager != null) {
            engine.useSharedStateManager(appStateManager)
        }

        val persistedSignalingUrl = servicePrefs.signalingUrl
        if (!persistedSignalingUrl.isNullOrBlank()) {
            app.signalingClient.serverUrl = persistedSignalingUrl
            Log.d(TAG, "SignalingClient serverUrl updated from config: $persistedSignalingUrl")
        }

        val gateway = RadioSignalingGatewayImpl(app.signalingClient)
        engine.wireFloorControl(gateway)

        val relayHost = servicePrefs.relayHost
        if (relayHost.isNullOrBlank()) {
            Log.e(TAG, "Radio transport config missing audioRelayHost from backend; aborting radio engine init")
            return
        }
        val relayPort = servicePrefs.relayPort
        if (relayPort <= 0) {
            Log.e(TAG, "Radio transport config invalid audioRelayPort=$relayPort; aborting radio engine init")
            return
        }
        engine.udpTransport.configure(relayHost, relayPort)
        Log.d(TAG, "Radio transport configured: host=$relayHost port=$relayPort")
        engine.udpTransport.channelId = servicePrefs.channelRoomKey ?: ""
        engine.udpTransport.channelIndex = servicePrefs.channelId
        engine.stateManager.activeChannelKey = servicePrefs.channelRoomKey
        engine.udpTransport.unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: ""

        engine.onDisconnected = {
            Log.d(TAG, "RadioAudioEngine unexpected stop — resetting state")
        }
        engine.onTxStall = { reason ->
            Log.e(TAG, "TX_STALL_DETECTED reason=$reason — playing error tone and stopping TX")
            Log.d("[ToneEvent]", """{"tone":"error","trigger":"tx_stall","reason":"$reason","state":"$pttState","ts":${System.currentTimeMillis()}}""")
            app.toneEngine.playErrorTone()
            scope.launch {
                transitionPttState(PttState.IDLE)
                updateNotification("Radio — TX Stall")
                try {
                    engine.stopTransmit()
                } catch (e: Exception) {
                    Log.e(TAG, "TX_STALL_STOP_TRANSMIT_ERROR: ${e.message}")
                }
                val channelKey = servicePrefs.channelRoomKey
                if (channelKey != null) {
                    engine.floorControl?.releaseFloor(channelKey)
                }
                sendPttTxFailed()
                updateNotification("Radio — Standby")
            }
        }
        engine.start()
        engine.startReceive()
        radioEngine = engine
        observeRadioFloorEvents(engine)
        observeTransportHealth(engine)
        observeSignalingConnection(engine)
        Log.d(TAG, "RadioAudioEngine initialized (custom-radio transport) — RX always-on")
    }

    private fun observeTransportHealth(engine: RadioAudioEngine) {
        scope.launch {
            engine.udpTransport.connectionHealth.collect { health ->
                when (health) {
                    TransportHealth.RECONNECTING -> {
                        Log.w(TAG, """{"event":"TRANSPORT_HEALTH_RECONNECTING"}""")
                    }
                    TransportHealth.DISCONNECTED -> {
                        Log.e(TAG, """{"event":"TRANSPORT_HEALTH_DISCONNECTED"}""")
                    }
                    TransportHealth.CONNECTED -> {
                        Log.d(TAG, """{"event":"TRANSPORT_HEALTH_CONNECTED"}""")
                    }
                }
            }
        }
    }

    private fun observeSignalingConnection(engine: RadioAudioEngine) {
        scope.launch {
            app.signalingClient.connectionState.collect { state ->
                if (state == ConnectionState.DISCONNECTED) {
                    val radioState = engine.stateManager.currentState
                    if (radioState != RadioState.TRANSMITTING) {
                        Log.w(TAG, """{"event":"SIGNALING_DISCONNECTED_RESET","previousState":"$radioState"}""")
                        engine.stateManager.transitionTo(RadioState.IDLE, "signaling_disconnected")
                        engine.stateManager.setTransmittingUnit(null)
                    }
                }
            }
        }
    }

    private fun observeRadioFloorEvents(engine: RadioAudioEngine) {
        scope.launch {
            engine.floorControl?.events?.collect { event ->
                when (event) {
                    FloorControlEvent.GRANTED -> {
                        cancelPendingFloorTimeout()
                        if (pttState == PttState.TRANSMITTING) {
                            Log.d(TAG, "Floor GRANTED but already TRANSMITTING — ignoring duplicate")
                            return@collect
                        }
                        if (pttState != PttState.CONNECTING || pttUpWhileConnecting) {
                            Log.d(TAG, "Floor GRANTED but PTT no longer active — ignoring late grant (pttState=$pttState pttUpWhileConnecting=$pttUpWhileConnecting)")
                            engine.abortPreCapture()
                            preCaptureSetupJob?.join()
                            preCaptureSetupJob = null
                            engine.stopPreCapture()
                            val roomKey = servicePrefs.channelRoomKey
                            if (roomKey != null) {
                                engine.floorControl?.releaseFloor(roomKey)
                            }
                            return@collect
                        }
                        Log.d(TAG, "Floor GRANTED — promoting pre-capture to live TX")
                        preCaptureSetupJob?.join()
                        preCaptureSetupJob = null
                        val txStarted = engine.promoteToLiveTransmit() || engine.startTransmit()
                        if (txStarted) {
                            transitionPttState(PttState.TRANSMITTING)
                            updateNotification("TRANSMITTING")
                            sendPttTxStarted()
                        } else {
                            Log.e(TAG, "Radio TX: promote/startTransmit failed after floor granted")
                            engine.stopPreCapture()
                            Log.d("[ToneEvent]", """{"tone":"denied","trigger":"floor_granted_tx_fail","state":"$pttState","ts":${System.currentTimeMillis()}}""")
                            app.toneEngine.startDeniedTone()
                            transitionPttState(PttState.IDLE)
                            updateNotification("Radio — Standby")
                            sendPttTxFailed()
                        }
                    }
                    FloorControlEvent.DENIED -> {
                        cancelPendingFloorTimeout()
                        Log.d(TAG, "Floor DENIED — aborting TX, discarding pre-buffer")
                        engine.abortPreCapture()
                        preCaptureSetupJob?.join()
                        preCaptureSetupJob = null
                        engine.stopPreCapture()
                        Log.d("[ToneEvent]", """{"tone":"denied","trigger":"floor_denied","state":"$pttState","ts":${System.currentTimeMillis()}}""")
                        app.toneEngine.startDeniedTone()
                        transitionPttState(PttState.IDLE)
                        updateNotification("Radio — Standby")
                        sendPttTxFailed()
                    }
                    FloorControlEvent.RELEASED -> {
                        Log.d(TAG, "Floor RELEASED")
                    }
                }
            }
        }
    }

    private fun observeRadioSignalingEvents() {
        scope.launch {
            app.signalingRepository.events.collectLatest { event ->
                val engine = radioEngine ?: return@collectLatest
                val currentRoomKey = servicePrefs.channelRoomKey
                when (event) {
                    is SignalingEvent.RadioChannelJoined -> {
                        joinedSignalingChannelId = event.channelId
                        if (pendingSignalingChannelId == event.channelId) {
                            pendingSignalingChannelId = null
                        }
                        Log.d(TAG, "RADIO_CHANNEL_JOINED channelId=${event.channelId}")
                        if (hadPriorAuthentication) {
                            Log.d(TAG, "RECONNECT_CHANNEL_REJOINED channelId=${event.channelId}")
                        } else {
                            Log.d(TAG, "LATENCY_CHANNEL_JOINED channelId=${event.channelId}")
                        }
                    }
                    is SignalingEvent.RadioPttGranted -> {
                        Log.d(TAG, "RADIO_PTT_GRANTED channelId=${event.channelId} senderUnitId=${event.senderUnitId}")
                        engine.floorControl?.onFloorGranted(event.channelId)
                    }
                    is SignalingEvent.RadioPttDenied -> {
                        Log.d(TAG, "RADIO_PTT_DENIED channelId=${event.channelId} reason=${event.reason} heldBy=${event.heldBy}")
                        engine.floorControl?.onFloorDenied(event.channelId)
                    }
                    is SignalingEvent.RadioChannelBusy -> {
                        if (event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelBusy(event.heldBy)
                        }
                    }
                    is SignalingEvent.RadioChannelIdle -> {
                        if (event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelIdle()
                        }
                    }
                    is SignalingEvent.RadioTxStart -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.senderUnitId != selfUnitId && event.channelId == currentRoomKey) {
                            Log.d(TAG, "RADIO_STATE_RX_ENTER channelId=${event.channelId} senderUnitId=${event.senderUnitId}")
                            engine.floorControl?.onChannelBusy(event.senderUnitId)
                        }
                    }
                    is SignalingEvent.RadioTxStop -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.senderUnitId != selfUnitId && event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelIdle()
                        }
                    }
                    is SignalingEvent.RadioDspConfig -> {
                        Log.d(TAG, "RADIO_DSP_CONFIG_RECEIVED: ${event.config}")
                        applyDspConfig(engine, event.config)
                    }
                    is SignalingEvent.TxSilenceWarning -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.unitId == selfUnitId) {
                            Log.e(TAG, "TX_SILENCE_WARNING_FROM_SERVER channelId=${event.channelId} silenceMs=${event.silenceMs} — playing denied tone and stopping TX")
                            Log.d("[ToneEvent]", """{"tone":"denied","trigger":"tx_silence_warning","channelId":"${event.channelId}","silenceMs":${event.silenceMs},"state":"$pttState","ts":${System.currentTimeMillis()}}""")
                            app.toneEngine.startDeniedTone()
                            transitionPttState(PttState.IDLE)
                            updateNotification("Radio — TX Silence Warning")
                            try {
                                engine.stopTransmit()
                            } catch (e: Exception) {
                                Log.e(TAG, "TX_SILENCE_STOP_TRANSMIT_ERROR: ${e.message}")
                            }
                            val channelKey = servicePrefs.channelRoomKey
                            if (channelKey != null) {
                                engine.floorControl?.releaseFloor(channelKey)
                            }
                            sendPttTxFailed()
                            updateNotification("Radio — Standby")
                        }
                    }
                    else -> {}
                }
            }
        }
    }

    private fun handleRadioPttDown(signaling: Boolean) {
        val channelKey = servicePrefs.channelRoomKey
        val channelId = servicePrefs.channelId
        Log.d(TAG, """{"event":"RADIO_PTT_DOWN","pttState":"$pttState","signaling":$signaling,"channelKey":"${channelKey ?: "none"}","channelId":"$channelId"}""")
        if (pendingFirstPttAfterReconnect) {
            pendingFirstPttAfterReconnect = false
            Log.d(TAG, "LATENCY_FIRST_PTT_AFTER_RECONNECT")
        }

        if (!app.sessionPrefs.micPermissionGranted) {
            Log.w(TAG, "Radio PTT DOWN: mic permission denied — blocked")
            Log.d("[ToneEvent]", """{"tone":"error","trigger":"mic_permission_denied","state":"$pttState","ts":${System.currentTimeMillis()}}""")
            playErrorToneDebounced()
            return
        }

        if (pttState == PttState.CLEANING_UP) {
            val stuckMs = if (cleaningUpSinceMs > 0) System.currentTimeMillis() - cleaningUpSinceMs else 0L
            if (stuckMs > 2_000L) {
                Log.w(TAG, """{"event":"CLEANING_UP_STUCK_RESET","stuckMs":$stuckMs}""")
                transitionPttState(PttState.IDLE)
                cleaningUpSinceMs = 0L
            } else {
                Log.d(TAG, "Radio PTT DOWN ignored: pttState=$pttState stuckMs=$stuckMs")
                return
            }
        }
        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING) {
            Log.d(TAG, "Radio PTT DOWN ignored: pttState=$pttState")
            return
        }

        val stateManager = radioEngine?.stateManager
        val transmittingUnit = stateManager?.transmittingUnitId?.value
        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
        val radioState = stateManager?.currentState
        val channelBusy = (transmittingUnit != null && transmittingUnit != selfUnitId) ||
            radioState == RadioState.CHANNEL_BUSY
        if (channelBusy) {
            Log.w(TAG, """{"event":"RADIO_PTT_DOWN_CHANNEL_BUSY","transmittingUnit":"$transmittingUnit","radioState":"$radioState"}""")
            Log.d("[ToneEvent]", """{"tone":"denied","trigger":"channel_busy","transmittingUnit":"$transmittingUnit","radioState":"$radioState","state":"$pttState","ts":${System.currentTimeMillis()}}""")
            app.toneEngine.startDeniedTone()
            return
        }

        pttUpWhileConnecting = false
        needsSignaling = signaling

        val roomKey = servicePrefs.channelRoomKey ?: run {
            Log.w(TAG, "Radio PTT DOWN ignored: no room key")
            sendPttTxFailed()
            return
        }

        val engine = radioEngine ?: run {
            Log.e(TAG, "Radio PTT DOWN: radioEngine not initialized")
            sendPttTxFailed()
            return
        }

        val readySync = evaluateReadinessForPttSync(signaling, roomKey)
        if (readySync == false) {
            return
        }

        transitionPttState(PttState.CONNECTING)
        updateNotification("Requesting floor…")
        Log.d("[ToneEvent]", """{"tone":"talk-permit","trigger":"ptt_down","state":"$pttState","channelKey":"${servicePrefs.channelRoomKey}","ts":${System.currentTimeMillis()}}""")

        scope.launch {
            app.toneEngine.playTalkPermitToneAndAwait()

            if (pttState != PttState.CONNECTING || pttUpWhileConnecting) {
                Log.d(TAG, "Radio PTT: state changed during tone — aborting (pttState=$pttState pttUpWhileConnecting=$pttUpWhileConnecting)")
                return@launch
            }

            if (readySync == null) {
                val (ready, blockedReason) = evaluateReadinessForPtt(signaling, roomKey)
                if (!ready) {
                    Log.w(TAG, "RADIO_READY_BLOCKED_REASON reason=$blockedReason")
                    Log.d("[ToneEvent]", """{"tone":"denied","trigger":"ready_blocked","reason":"$blockedReason","state":"$pttState","ts":${System.currentTimeMillis()}}""")
                    app.toneEngine.startDeniedTone()
                    transitionPttState(PttState.IDLE)
                    updateNotification("Radio — Standby")
                    sendPttTxFailed()
                    return@launch
                }
            }
            Log.d(TAG, """{"event":"RADIO_READY_FOR_PTT","roomKey":"$roomKey","signaling":$signaling}""")

            preCaptureSetupJob = scope.launch {
                val preStarted = engine.startPreCapture()
                if (!preStarted) {
                    Log.e(TAG, "Radio PTT: pre-capture failed to start")
                }
            }

            delay(50)

            if (pttState != PttState.CONNECTING || pttUpWhileConnecting) {
                Log.d(TAG, "Radio PTT: state changed during post-tone safety margin — aborting (pttState=$pttState pttUpWhileConnecting=$pttUpWhileConnecting)")
                engine.abortPreCapture()
                preCaptureSetupJob?.cancel()
                preCaptureSetupJob?.join()
                preCaptureSetupJob = null
                engine.stopPreCapture()
                return@launch
            }

            if (signaling && !ensureBackgroundSignalingReady(servicePrefs.channelId)) {
                Log.e(TAG, "Radio PTT: signaling not ready")
                engine.abortPreCapture()
                preCaptureSetupJob?.cancel()
                preCaptureSetupJob?.join()
                preCaptureSetupJob = null
                engine.stopPreCapture()
                Log.d("[ToneEvent]", """{"tone":"denied","trigger":"signaling_not_ready","state":"$pttState","ts":${System.currentTimeMillis()}}""")
                app.toneEngine.startDeniedTone()
                transitionPttState(PttState.IDLE)
                updateNotification("Radio — Standby")
                sendPttTxFailed()
                return@launch
            }

            if (signaling) {
                app.signalingRepository.transmitPre(roomKey)
                Log.d(TAG, "Radio PTT: transmitPre sent for roomKey $roomKey")
            }

            if (pttState != PttState.CONNECTING || pttUpWhileConnecting) {
                Log.d(TAG, "Radio PTT: state changed before floor request — aborting (pttState=$pttState pttUpWhileConnecting=$pttUpWhileConnecting)")
                engine.abortPreCapture()
                preCaptureSetupJob?.cancel()
                preCaptureSetupJob?.join()
                preCaptureSetupJob = null
                engine.stopPreCapture()
                return@launch
            }

            Log.d(TAG, "PTT_REQUEST_SENT channelId=$roomKey")
            Log.d(TAG, "RADIO_PTT_REQUEST_SENT channelId=$roomKey")
            engine.floorControl?.requestFloor(roomKey)
            startPendingFloorTimeout(roomKey)
        }
    }

    private fun handleRadioPttUp() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPttUpTimeMs < PTT_UP_DEBOUNCE_MS) {
            Log.d(TAG, """{"event":"RADIO_PTT_UP_DEBOUNCED","deltaMs":${now - lastPttUpTimeMs}}""")
            return
        }
        lastPttUpTimeMs = now
        lastErrorToneMs = 0L

        val channelKey = servicePrefs.channelRoomKey
        Log.d(TAG, """{"event":"RADIO_PTT_UP","pttState":"$pttState","channelKey":"${channelKey ?: "none"}"}""")

        app.toneEngine.stopDeniedTone()

        pttUpWhileConnecting = true

        if (pttState != PttState.TRANSMITTING) {
            if (pttState == PttState.CONNECTING) {
                cancelPendingFloorTimeout()
                radioEngine?.floorControl?.cancelPending()
                radioEngine?.abortPreCapture()
                val setupJob = preCaptureSetupJob
                preCaptureSetupJob = null
                scope.launch {
                    setupJob?.join()
                    radioEngine?.stopPreCapture()
                }
                transitionPttState(PttState.IDLE)
                updateNotification("Radio — Standby")
                sendPttTxAborted()
            }
            return
        }

        val roomKey = servicePrefs.channelRoomKey ?: return
        val wasSignaling = needsSignaling

        transitionPttState(PttState.CLEANING_UP)
        cleaningUpSinceMs = System.currentTimeMillis()
        updateNotification("Radio — Standby")

        scope.launch {
            try {
                radioEngine?.stopTransmit()
                radioEngine?.floorControl?.releaseFloor(roomKey)
                Log.d(TAG, """{"event":"PTT_RELEASE_SENT","channelId":"$roomKey"}""")
                sendPttTxEnded()
                delay(80)
                Log.d("[ToneEvent]", """{"tone":"end-of-tx","trigger":"ptt_up","state":"$pttState","signaling":$wasSignaling,"ts":${System.currentTimeMillis()}}""")
                app.toneEngine.playEndOfTxTone()
                Log.d(TAG, "Radio PTT UP: end-of-TX tone for roomKey $roomKey")
            } catch (e: Exception) {
                Log.e(TAG, """{"event":"PTT_CLEANUP_ERROR","error":"${e::class.simpleName}","message":"${e.message}"}""")
            } finally {
                val cleanupDurationMs = if (cleaningUpSinceMs > 0) System.currentTimeMillis() - cleaningUpSinceMs else 0L
                transitionPttState(PttState.IDLE)
                cleaningUpSinceMs = 0L
                Log.d(TAG, """{"event":"PTT_CLEANUP_COMPLETE","state":"IDLE","cleanupMs":$cleanupDurationMs}""")
            }
        }
    }

    private fun transitionPttState(newState: PttState) {
        val old = pttState
        if (old == newState) return
        pttState = newState
        val channelKey = servicePrefs.channelRoomKey
        when (newState) {
            PttState.CONNECTING -> Log.d(TAG, "PTT_STATE $old -> CONNECTING channelKey=${channelKey ?: "none"}")
            PttState.IDLE -> Log.d(TAG, "PTT_STATE $old -> IDLE channelKey=${channelKey ?: "none"}")
            PttState.TRANSMITTING -> Log.d(TAG, "PTT_STATE $old -> TRANSMITTING channelKey=${channelKey ?: "none"}")
            PttState.CLEANING_UP -> Log.d(TAG, "PTT_STATE $old -> CLEANING_UP channelKey=${channelKey ?: "none"}")
        }
    }

    private fun playErrorToneDebounced(): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (now - lastErrorToneMs < ERROR_TONE_DEBOUNCE_MS) {
            Log.d(TAG, "playErrorToneDebounced: suppressed duplicate (${now - lastErrorToneMs}ms since last)")
            return false
        }
        lastErrorToneMs = now
        app.toneEngine.playErrorTone()
        return true
    }

    private fun evaluateReadinessForPttSync(signaling: Boolean, roomKey: String): Boolean? {
        if (radioEngine == null) {
            Log.w(TAG, "RADIO_READY_BLOCKED_REASON reason=radio_engine_missing")
            Log.d("[ToneEvent]", """{"tone":"error","trigger":"ready_sync_blocked","reason":"radio_engine_missing","ts":${System.currentTimeMillis()}}""")
            playErrorToneDebounced()
            sendPttTxFailed()
            return false
        }
        if (!signaling) return true
        val state = app.signalingRepository.connectionState.value
        if (state == ConnectionState.AUTHENTICATED) {
            if (joinedSignalingChannelId != roomKey) {
                Log.w(TAG, "RADIO_READY_BLOCKED_REASON reason=channel_not_joined joined=$joinedSignalingChannelId target=$roomKey")
                Log.d("[ToneEvent]", """{"tone":"error","trigger":"ready_sync_blocked","reason":"channel_not_joined","ts":${System.currentTimeMillis()}}""")
                playErrorToneDebounced()
                sendPttTxFailed()
                return false
            }
            return true
        }
        val msSinceAuth = System.currentTimeMillis() - lastAuthenticatedTimeMs
        if (msSinceAuth < 3_000L && lastAuthenticatedTimeMs > 0L) {
            return null
        }
        Log.w(TAG, "RADIO_READY_BLOCKED_REASON reason=signaling_not_authenticated:$state")
        Log.d("[ToneEvent]", """{"tone":"error","trigger":"ready_sync_blocked","reason":"signaling_not_authenticated","ts":${System.currentTimeMillis()}}""")
        playErrorToneDebounced()
        sendPttTxFailed()
        return false
    }

    private suspend fun evaluateReadinessForPtt(signaling: Boolean, roomKey: String): Pair<Boolean, String?> {
        if (radioEngine == null) return false to "radio_engine_missing"
        if (!signaling) return true to null
        val state = app.signalingRepository.connectionState.value
        if (state != ConnectionState.AUTHENTICATED) {
            val msSinceAuth = System.currentTimeMillis() - lastAuthenticatedTimeMs
            if (msSinceAuth < 3_000L && lastAuthenticatedTimeMs > 0L) {
                Log.d(TAG, """{"event":"PTT_SIGNALING_GRACE_WAIT","state":"$state","msSinceAuth":$msSinceAuth}""")
                val graceWaitStart = System.currentTimeMillis()
                val recovered = withTimeoutOrNull(1_000L) {
                    app.signalingRepository.connectionState.first { it == ConnectionState.AUTHENTICATED }
                }
                if (recovered != null) {
                    Log.d(TAG, """{"event":"PTT_SIGNALING_GRACE_RECOVERED","waitMs":${System.currentTimeMillis() - graceWaitStart}}""")
                } else {
                    return false to "signaling_not_authenticated_after_grace:$state"
                }
            } else {
                return false to "signaling_not_authenticated:$state"
            }
        }
        if (joinedSignalingChannelId != roomKey) return false to "channel_not_joined joined=$joinedSignalingChannelId target=$roomKey"
        return true to null
    }

    private fun triggerReconnectPipelineReset() {
        val engine = radioEngine ?: return
        Log.d(TAG, "RECONNECT_AUTH_PIPELINE_RESET — transport cleanup on signaling re-auth, codec preserved")
        engine.jitterBuffer.flushForReconnect()
        engine.audioPlayback.clearStaleFrames()
        Log.d(TAG, "RECONNECT_AUTH_PIPELINE_RESET_COMPLETE — jitter, playback reset — codec untouched")
    }

    private fun startPendingFloorTimeout(roomKey: String) {
        cancelPendingFloorTimeout()
        pendingFloorTimeoutJob = scope.launch {
            delay(5_000L)
            if (pttState == PttState.CONNECTING) {
                Log.w(TAG, "RADIO_READY_BLOCKED_REASON reason=floor_response_timeout channelId=$roomKey")
                radioEngine?.floorControl?.cancelPending()
                radioEngine?.abortPreCapture()
                preCaptureSetupJob?.join()
                preCaptureSetupJob = null
                radioEngine?.stopPreCapture()
                Log.d("[ToneEvent]", """{"tone":"denied","trigger":"floor_response_timeout","channelId":"$roomKey","state":"$pttState","ts":${System.currentTimeMillis()}}""")
                app.toneEngine.startDeniedTone()
                transitionPttState(PttState.IDLE)
                updateNotification("Radio — Standby")
                sendPttTxFailed()
            }
        }
    }

    private fun cancelPendingFloorTimeout() {
        pendingFloorTimeoutJob?.cancel()
        pendingFloorTimeoutJob = null
    }

    private fun sendEmergencyActivated() {
        sendBroadcast(Intent(ACTION_EMERGENCY_ACTIVATED).apply { setPackage(packageName) })
    }

    private fun sendEmergencyCancelled() {
        sendBroadcast(Intent(ACTION_EMERGENCY_CANCELLED).apply { setPackage(packageName) })
    }

    private fun sendPttTxFailed() {
        Log.d(TAG, "Sending PTT_TX_FAILED broadcast")
        val intent = Intent(ACTION_PTT_TX_FAILED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    private fun sendPttTxAborted() {
        Log.d(TAG, "Sending PTT_TX_ABORTED broadcast")
        val intent = Intent(ACTION_PTT_TX_ABORTED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    private fun sendPttTxStarted() {
        Log.d(TAG, "Sending PTT_TX_STARTED broadcast")
        val intent = Intent(ACTION_PTT_TX_STARTED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    private fun sendPttTxEnded() {
        Log.d(TAG, "Sending PTT_TX_ENDED broadcast")
        val intent = Intent(ACTION_PTT_TX_ENDED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    private fun updateNotification(status: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID, buildNotification(status))
    }

    private fun buildNotification(status: String) =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Command Comms")
            .setContentText(status)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0,
                    Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .build()

    override fun onBind(intent: Intent?): IBinder? = null

    private var speakerStateRestored = false

    private fun restoreSpeakerState() {
        if (speakerStateRestored) return
        speakerStateRestored = true
        if (::audioManager.isInitialized) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (previousSpeakerphoneOn) {
                    val speakerDevice = audioManager.availableCommunicationDevices
                        .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                    if (speakerDevice != null) {
                        audioManager.setCommunicationDevice(speakerDevice)
                    }
                } else {
                    audioManager.clearCommunicationDevice()
                }
            } else {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = previousSpeakerphoneOn
            }
            audioManager.mode = previousAudioMode
            Log.d(TAG, "BackgroundAudioService: loudspeaker restored (mode=$previousAudioMode, speaker=$previousSpeakerphoneOn)")
        }
    }

    override fun onDestroy() {
        Log.d(TAG, "BackgroundAudioService destroyed")
        restoreSpeakerState()
        dynamicPttReceiver?.let {
            unregisterReceiver(it)
            dynamicPttReceiver = null
            Log.d(TAG, "Dynamic PttHardwareReceiver unregistered")
        }
        signalingConnectionJob?.cancel()
        signalingEventsJob?.cancel()
        radioEngine?.release()
        radioEngine = null
        cancelPendingFloorTimeout()
        scope.cancel()
        if (wifiLock.isHeld) {
            wifiLock.release()
            Log.d(TAG, "BackgroundAudioService: WiFi WakeLock released")
        }
        if (serviceWakeLock.isHeld) {
            serviceWakeLock.release()
            Log.d(TAG, "BackgroundAudioService: service-lifetime WakeLock released")
        }
        super.onDestroy()
    }

    private fun applyDspConfig(engine: com.reedersystems.commandcomms.audio.radio.RadioAudioEngine, config: org.json.JSONObject) {
        try {
            if (config.has("txHpAlpha")) engine.txHpAlpha = config.getDouble("txHpAlpha")
            if (config.has("txLpB0")) engine.txLpB0 = config.getDouble("txLpB0")
            if (config.has("txLpB1")) engine.txLpB1 = config.getDouble("txLpB1")
            if (config.has("txLpB2")) engine.txLpB2 = config.getDouble("txLpB2")
            if (config.has("txLpA1")) engine.txLpA1 = config.getDouble("txLpA1")
            if (config.has("txLpA2")) engine.txLpA2 = config.getDouble("txLpA2")
            if (config.has("txCompThresholdDb")) engine.txCompThresholdDb = config.getDouble("txCompThresholdDb")
            if (config.has("txCompRatio")) engine.txCompRatio = config.getDouble("txCompRatio")
            if (config.has("txCompAttackMs")) engine.txCompAttackMs = config.getDouble("txCompAttackMs")
            if (config.has("txCompReleaseMs")) engine.txCompReleaseMs = config.getDouble("txCompReleaseMs")
            if (config.has("txGain")) engine.txGain = config.getDouble("txGain")
            if (config.has("txGateThresholdDb")) engine.txGateThresholdDb = config.getDouble("txGateThresholdDb")
            if (config.has("txGateAttackMs")) engine.txGateAttackMs = config.getDouble("txGateAttackMs")
            if (config.has("txGateReleaseMs")) engine.txGateReleaseMs = config.getDouble("txGateReleaseMs")
            if (config.has("rxHpAlpha")) engine.audioPlayback.rxHpAlpha = config.getDouble("rxHpAlpha")
            if (config.has("rxLpB0")) engine.audioPlayback.rxLpB0 = config.getDouble("rxLpB0")
            if (config.has("rxLpB1")) engine.audioPlayback.rxLpB1 = config.getDouble("rxLpB1")
            if (config.has("rxLpB2")) engine.audioPlayback.rxLpB2 = config.getDouble("rxLpB2")
            if (config.has("rxLpA1")) engine.audioPlayback.rxLpA1 = config.getDouble("rxLpA1")
            if (config.has("rxLpA2")) engine.audioPlayback.rxLpA2 = config.getDouble("rxLpA2")
            if (config.has("rxGateThresholdDb")) engine.audioPlayback.rxGateThresholdDb = config.getDouble("rxGateThresholdDb")
            if (config.has("rxGain")) engine.audioPlayback.softwareGain = config.getDouble("rxGain").toFloat()
            if (config.has("opusBitrate")) engine.opusCodec.setBitrateRuntime(config.getInt("opusBitrate"))
            Log.d(TAG, "DSP config applied successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to apply DSP config: ${e.message}", e)
        }
    }

    companion object {
        const val ACTION_PTT_DOWN = "com.reedersystems.commandcomms.SVC_PTT_DOWN"
        const val ACTION_PTT_UP = "com.reedersystems.commandcomms.SVC_PTT_UP"
        const val ACTION_EMERGENCY_DOWN = "com.reedersystems.commandcomms.SVC_EMERGENCY_DOWN"
        const val ACTION_EMERGENCY_UP = "com.reedersystems.commandcomms.SVC_EMERGENCY_UP"
        const val ACTION_UPDATE_CHANNEL = "com.reedersystems.commandcomms.UPDATE_CHANNEL"
        const val ACTION_STOP = "com.reedersystems.commandcomms.STOP"
        const val ACTION_PTT_TX_FAILED = "com.reedersystems.commandcomms.PTT_TX_FAILED"
        const val ACTION_PTT_TX_ABORTED = "com.reedersystems.commandcomms.PTT_TX_ABORTED"
        const val ACTION_PTT_TX_STARTED = "com.reedersystems.commandcomms.PTT_TX_STARTED"
        const val ACTION_PTT_TX_ENDED = "com.reedersystems.commandcomms.PTT_TX_ENDED"
        const val ACTION_EMERGENCY_CLEAR = "com.reedersystems.commandcomms.SVC_EMERGENCY_CLEAR"
        const val ACTION_EMERGENCY_ACTIVATED = "com.reedersystems.commandcomms.EMERGENCY_ACTIVATED"
        const val ACTION_EMERGENCY_CANCELLED = "com.reedersystems.commandcomms.EMERGENCY_CANCELLED"
        const val EXTRA_CHANNEL_ID = "channel_id"
        const val EXTRA_ROOM_KEY = "room_key"
        const val EXTRA_CHANNEL_NAME = "channel_name"
        const val EXTRA_NEEDS_SIGNALING = "needs_signaling"
        const val EXTRA_EMERGENCY_KEY_DOWN = "emergency_key_down"

        private const val WAKE_LOCK_TAG = "CommandComms:PttService"
        private const val PTT_UP_DEBOUNCE_MS = 200L
        private const val ERROR_TONE_DEBOUNCE_MS = 300L
    }
}
