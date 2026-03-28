package com.reedersystems.commandcomms.audio

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
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
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.first
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private const val TAG = "[PTT-DIAG]"
private const val NOTIFICATION_ID = 1001
private const val CHANNEL_ID = "ptt_service"

class BackgroundAudioService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var radioEngine: RadioAudioEngine? = null
    private lateinit var servicePrefs: ServiceConnectionPrefs
    private val app get() = application as CommandCommsApp

    private lateinit var serviceWakeLock: PowerManager.WakeLock

    private var dynamicPttReceiver: BroadcastReceiver? = null

    private var pttState = PttState.IDLE

    @Volatile private var pttUpWhileConnecting = false

    @Volatile private var needsSignaling = false

    @Volatile private var joinedSignalingChannelId: String? = null

    private var emergencyActivatingJob: Job? = null

    @Volatile private var emergencyActive = false

    private var signalingConnectionJob: Job? = null
    private var signalingEventsJob: Job? = null

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
                    ensureBackgroundSignalingConnected()
                    scope.launch { syncBackgroundSignalingChannel() }
                }
            }
            ACTION_STOP -> {
                Log.d(TAG, "Service stop requested")
                radioEngine?.stop()
                stopSelf()
            }
        }
        // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────
        return START_STICKY
    }

    private fun handleEmergencyDown() {
        Log.d(TAG, "handleEmergencyDown emergencyActive=$emergencyActive")

        if (emergencyActive) {
            app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
            return
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
            emergencyActivatingJob = null
            activateEmergency(channelId, channelKey)
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
                        ConnectionState.AUTHENTICATED -> syncBackgroundSignalingChannel()
                        ConnectionState.DISCONNECTED -> joinedSignalingChannelId = null
                        else -> Unit
                    }
                }
            }
        }

        if (signalingEventsJob == null) {
            signalingEventsJob = scope.launch {
                app.signalingRepository.events.collectLatest { event ->
                    val currentRoomKey = servicePrefs.channelRoomKey
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
        return syncBackgroundSignalingChannel()
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
        joinedSignalingChannelId = targetRoomKey
        radioEngine?.startReceive()
        Log.d(TAG, "Background signaling joined RADIO channel $targetRoomKey (udpPort=${udpPort ?: "none"}) — RX restarted")
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

        val relayHost = servicePrefs.relayHost ?: run {
            Log.w(TAG, "No relay host from radio config, falling back to server URL derivation")
            val serverUrl = servicePrefs.serverUrl ?: app.apiClient.baseUrl
            try { java.net.URI(serverUrl).host ?: "" } catch (_: Exception) { "" }
        }
        val relayPort = servicePrefs.relayPort
        engine.udpTransport.configure(relayHost, relayPort)
        Log.d(TAG, "Radio transport configured: host=$relayHost port=$relayPort")
        engine.udpTransport.channelId = servicePrefs.channelRoomKey ?: ""
        engine.udpTransport.unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: ""

        engine.onDisconnected = {
            Log.d(TAG, "RadioAudioEngine unexpected stop — resetting state")
        }
        engine.start()
        engine.startReceive()
        radioEngine = engine
        observeRadioFloorEvents(engine)
        Log.d(TAG, "RadioAudioEngine initialized (custom-radio transport) — RX always-on")
    }

    private fun observeRadioFloorEvents(engine: RadioAudioEngine) {
        scope.launch {
            engine.floorControl?.events?.collect { event ->
                when (event) {
                    FloorControlEvent.GRANTED -> {
                        if (pttState == PttState.TRANSMITTING) {
                            Log.d(TAG, "Floor GRANTED but already TRANSMITTING — ignoring duplicate")
                            return@collect
                        }
                        Log.d(TAG, "Floor GRANTED — starting TX")
                        val txStarted = engine.startTransmit()
                        if (txStarted) {
                            pttState = PttState.TRANSMITTING
                            updateNotification("TRANSMITTING")
                            sendPttTxStarted()
                            if (needsSignaling) {
                                val rk = servicePrefs.channelRoomKey
                                if (rk != null) {
                                    app.signalingRepository.transmitStart(rk)
                                    Log.d(TAG, "Radio TX: transmitStart signaled for $rk")
                                }
                            }
                        } else {
                            Log.e(TAG, "Radio TX: startTransmit failed after floor granted")
                            app.toneEngine.playErrorTone()
                            pttState = PttState.IDLE
                            updateNotification("Radio — Standby")
                            sendPttTxFailed()
                        }
                    }
                    FloorControlEvent.DENIED -> {
                        Log.d(TAG, "Floor DENIED — aborting TX")
                        app.toneEngine.playBusyTone()
                        pttState = PttState.IDLE
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
                    is SignalingEvent.RadioSessionToken -> {
                        Log.d(TAG, "Session token received for channel ${event.channelId}")
                        engine.udpTransport.setSessionToken(event.token)
                    }
                    is SignalingEvent.RadioPttGranted -> {
                        engine.floorControl?.onFloorGranted(event.channelId)
                    }
                    is SignalingEvent.RadioPttDenied -> {
                        engine.floorControl?.onFloorDenied(event.channelId)
                    }
                    is SignalingEvent.RadioChannelBusy -> {
                        if (event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelBusy(event.transmittingUnit)
                        }
                    }
                    is SignalingEvent.RadioChannelIdle -> {
                        if (event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelIdle()
                        }
                    }
                    is SignalingEvent.RadioTxStart -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelBusy(event.unitId)
                        }
                    }
                    is SignalingEvent.RadioTxStop -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                            engine.floorControl?.onChannelIdle()
                        }
                    }
                    else -> {}
                }
            }
        }
    }

    private fun handleRadioPttDown(signaling: Boolean) {
        Log.d(TAG, "handleRadioPttDown pttState=$pttState signaling=$signaling")

        if (!app.sessionPrefs.micPermissionGranted) {
            Log.w(TAG, "Radio PTT DOWN: mic permission denied — blocked")
            app.toneEngine.playErrorTone()
            return
        }

        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING || pttState == PttState.CLEANING_UP) {
            Log.d(TAG, "Radio PTT DOWN ignored: pttState=$pttState")
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

        pttState = PttState.CONNECTING
        updateNotification("Requesting floor…")
        app.toneEngine.playTalkPermitTone()

        scope.launch {
            delay(200)

            if (signaling && !ensureBackgroundSignalingReady(servicePrefs.channelId)) {
                Log.e(TAG, "Radio PTT: signaling not ready")
                app.toneEngine.playErrorTone()
                pttState = PttState.IDLE
                updateNotification("Radio — Standby")
                sendPttTxFailed()
                return@launch
            }

            if (signaling) {
                app.signalingRepository.transmitPre(roomKey)
                Log.d(TAG, "Radio PTT: transmitPre sent for roomKey $roomKey")
            }

            engine.floorControl?.requestFloor(roomKey)
            val serverUrl = servicePrefs.serverUrl ?: app.apiClient.baseUrl
            val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: return@launch
            httpPttStart(serverUrl, roomKey, unitId)
        }
    }

    private fun handleRadioPttUp() {
        Log.d(TAG, "handleRadioPttUp pttState=$pttState")

        pttUpWhileConnecting = true

        if (pttState != PttState.TRANSMITTING) {
            if (pttState == PttState.CONNECTING) {
                radioEngine?.floorControl?.cancelPending()
                pttState = PttState.IDLE
                updateNotification("Radio — Standby")
                sendPttTxAborted()
            }
            return
        }

        val roomKey = servicePrefs.channelRoomKey ?: return
        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: return
        val serverUrl = servicePrefs.serverUrl ?: app.apiClient.baseUrl
        val wasSignaling = needsSignaling

        pttState = PttState.CLEANING_UP
        updateNotification("Radio — Standby")

        scope.launch {
            try {
                radioEngine?.stopTransmit()
                radioEngine?.udpTransport?.clearSessionToken()
                radioEngine?.floorControl?.releaseFloor(roomKey)
                sendPttTxEnded()
                if (wasSignaling) {
                    app.signalingRepository.transmitEnd(roomKey)
                    app.toneEngine.playEndOfTxTone()
                    Log.d(TAG, "Radio PTT UP: transmitEnd + end-of-TX tone for roomKey $roomKey")
                }
                httpPttEnd(serverUrl, roomKey, unitId)
            } finally {
                pttState = PttState.IDLE
                Log.d(TAG, "PTT cleanup complete — state is now IDLE")
            }
        }
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

    private fun httpPttStart(serverUrl: String, roomKey: String, unitId: String) {
        val json = """{"channelId":"$roomKey","unitId":"$unitId"}"""
        try {
            val req = Request.Builder()
                .url("$serverUrl/api/ptt/start")
                .post(json.toRequestBody("application/json".toMediaType()))
                .build()
            app.apiClient.httpClient.newCall(req).execute().close()
            Log.d(TAG, "HTTP ptt/start sent")
        } catch (e: Exception) {
            Log.w(TAG, "ptt/start HTTP failed (non-critical): ${e.message}")
        }
    }

    private fun httpPttEnd(serverUrl: String, roomKey: String, unitId: String) {
        val json = """{"channelId":"$roomKey","unitId":"$unitId"}"""
        try {
            val req = Request.Builder()
                .url("$serverUrl/api/ptt/end")
                .post(json.toRequestBody("application/json".toMediaType()))
                .build()
            app.apiClient.httpClient.newCall(req).execute().close()
            Log.d(TAG, "HTTP ptt/end sent")
        } catch (e: Exception) {
            Log.w(TAG, "ptt/end HTTP failed (non-critical): ${e.message}")
        }
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

    override fun onDestroy() {
        Log.d(TAG, "BackgroundAudioService destroyed")
        dynamicPttReceiver?.let {
            unregisterReceiver(it)
            dynamicPttReceiver = null
            Log.d(TAG, "Dynamic PttHardwareReceiver unregistered")
        }
        signalingConnectionJob?.cancel()
        signalingEventsJob?.cancel()
        radioEngine?.release()
        radioEngine = null
        scope.cancel()
        if (serviceWakeLock.isHeld) {
            serviceWakeLock.release()
            Log.d(TAG, "BackgroundAudioService: service-lifetime WakeLock released")
        }
        super.onDestroy()
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
        const val ACTION_EMERGENCY_ACTIVATED = "com.reedersystems.commandcomms.EMERGENCY_ACTIVATED"
        const val ACTION_EMERGENCY_CANCELLED = "com.reedersystems.commandcomms.EMERGENCY_CANCELLED"
        const val EXTRA_CHANNEL_ID = "channel_id"
        const val EXTRA_ROOM_KEY = "room_key"
        const val EXTRA_CHANNEL_NAME = "channel_name"
        const val EXTRA_NEEDS_SIGNALING = "needs_signaling"
        const val EXTRA_EMERGENCY_KEY_DOWN = "emergency_key_down"

        private const val WAKE_LOCK_TAG = "CommandComms:PttService"
    }
}
