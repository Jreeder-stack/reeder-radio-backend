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
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "[PTT-DIAG]"
private const val NOTIFICATION_ID = 1001
private const val CHANNEL_ID = "ptt_service"
private const val GRACE_PERIOD_MS = 59_000L
private const val ACTIVITY_WINDOW_MS = 10_000L

class BackgroundAudioService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var audioEngine: PttAudioEngine
    private var radioEngine: RadioAudioEngine? = null
    private lateinit var servicePrefs: ServiceConnectionPrefs
    private val app get() = application as CommandCommsApp

    private val useCustomRadio: Boolean
        get() = servicePrefs.transportMode == "custom-radio"

    /**
     * Held for the entire service lifetime so the CPU stays awake during screen-off PTT.
     * Prevents Doze from interrupting audio or HTTP PTT calls mid-transmission.
     */
    private lateinit var serviceWakeLock: PowerManager.WakeLock

    /**
     * Dynamically-registered PttHardwareReceiver. Dynamic registration bypasses the Android 8.0
     * implicit broadcast restriction that blocks manifest-declared receivers from receiving
     * vendor PTT broadcasts (e.g. android.intent.action.PTT.down) when the app is backgrounded.
     */
    private var dynamicPttReceiver: BroadcastReceiver? = null

    private var pttState = PttState.IDLE
    private var gracePeriodJob: Job? = null

    /**
     * Absolute time (System.currentTimeMillis) when the LiveKit session should disconnect.
     * Set once on first connect, extended only if activity in last ACTIVITY_WINDOW_MS.
     * -1 = no active session.
     */
    @Volatile private var sessionDeadlineMs: Long = -1L

    /**
     * Last time any TX or RX activity occurred. Used by onGracePeriodExpired() to decide
     * whether to extend the session deadline.
     */
    @Volatile private var lastActivityMs: Long = 0L

    /**
     * Set to true as soon as ACTION_PTT_UP is received, regardless of pttState.
     * Checked after the async connect completes in handlePttDown() to abort TX
     * if the user released PTT before the connection finished (race condition fix).
     * Always reset to false at the start of handlePttDown().
     */
    @Volatile private var pttUpWhileConnecting = false

    /**
     * True when the current (or most recent) TX was initiated by PttHardwareReceiver
     * with EXTRA_NEEDS_SIGNALING=true (screen-off path). The service must emit all
     * Socket.IO signaling events itself because the ViewModel is asleep.
     * Reset to false at the top of handlePttDown() so it always reflects the current TX.
     */
    @Volatile private var needsSignaling = false

    /**
     * Channel roomKey currently joined on the background signaling socket.
     * Reset on disconnect so reconnects re-join the selected channel.
     */
    @Volatile private var joinedSignalingChannelId: String? = null

    /**
     * True while an RX-triggered LiveKit connect coroutine is in flight.
     * Prevents PttPre + PttStart arriving close together from launching two
     * concurrent connect attempts (collectLatest cancels the collector lambda
     * but not scope.launch coroutines already in flight).
     */
    private val rxConnecting = AtomicBoolean(false)

    /**
     * Coroutine running the emergency activation. Null when not activating.
     * Guards against duplicate DOWN events (race between key event and vendor broadcast).
     */
    private var emergencyActivatingJob: Job? = null

    /**
     * True after emergency:start has been signalled. Used to route a second button press
     * to the ViewModel cancel-hold flow.
     */
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

        @Suppress("DEPRECATION")
        audioEngine = PttAudioEngine(applicationContext)
        audioEngine.onDisconnected = {
            Log.d(TAG, "LiveKit unexpected disconnect — resetting session state")
            gracePeriodJob?.cancel()
            gracePeriodJob = null
            sessionDeadlineMs = -1L
        }
        servicePrefs = ServiceConnectionPrefs(applicationContext)

        if (useCustomRadio) {
            initRadioEngine()
            observeRadioSignalingEvents()
        }

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
            // Emergency button broadcasts
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
            // SOS variants (confirmed from PhoneWindowManager on Inrico T320)
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
    // Intent dispatch — the action constants and this when-block routing are
    // the termination point for all hardware button paths. Only what happens
    // INSIDE each handler may change (e.g. swapping LiveKit for RadioAudioEngine).
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PTT_DOWN -> {
                if (useCustomRadio) handleRadioPttDown(intent.getBooleanExtra(EXTRA_NEEDS_SIGNALING, false))
                else handlePttDown(intent.getBooleanExtra(EXTRA_NEEDS_SIGNALING, false))
            }
            ACTION_PTT_UP -> {
                if (useCustomRadio) handleRadioPttUp()
                else handlePttUp()
            }
            ACTION_EMERGENCY_DOWN -> handleEmergencyDown()
            ACTION_EMERGENCY_UP -> handleEmergencyUp()
            ACTION_RX_CONNECT -> {
                val channelId = intent.getIntExtra(EXTRA_CHANNEL_ID, -1)
                if (channelId >= 0) handleRxConnect(channelId)
            }
            ACTION_RX_END -> handleRxEnd()
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
                if (useCustomRadio) {
                    radioEngine?.stop()
                } else {
                    scope.launch { audioEngine.disconnect() }
                }
                stopSelf()
            }
        }
        // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────
        return START_STICKY
    }

    private fun handlePttDown(signaling: Boolean) {
        Log.d(TAG, "handlePttDown pttState=$pttState signaling=$signaling")

        if (!app.sessionPrefs.micPermissionGranted) {
            Log.w(TAG, "PTT DOWN service: mic permission denied — blocked")
            app.toneEngine.playErrorTone()
            return
        }

        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING) return

        // Reset AFTER all early-return guards so a second DOWN while still CONNECTING
        // cannot clear the flag set by an intervening UP (race condition fix).
        pttUpWhileConnecting = false
        needsSignaling = signaling

        gracePeriodJob?.cancel()
        gracePeriodJob = null

        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: run {
            Log.w(TAG, "PTT DOWN ignored: no unit ID")
            sendPttTxFailed()
            return
        }
        val channelId = servicePrefs.channelId.takeIf { it >= 0 } ?: run {
            Log.w(TAG, "PTT DOWN ignored: no channel selected")
            sendPttTxFailed()
            return
        }
        val roomKey = servicePrefs.channelRoomKey ?: run {
            Log.w(TAG, "PTT DOWN ignored: no room key")
            sendPttTxFailed()
            return
        }
        val serverUrl = servicePrefs.serverUrl ?: app.apiClient.baseUrl

        pttState = PttState.CONNECTING
        updateNotification("Connecting…")

        scope.launch {
            try {
                if (signaling && !ensureBackgroundSignalingReady(channelId)) {
                    Log.e(TAG, "Screen-off PTT: signaling not ready")
                    app.toneEngine.playErrorTone()
                    pttState = PttState.IDLE
                    updateNotification("Radio — Standby")
                    sendPttTxFailed()
                    return@launch
                }

                val tokenDeferred = async {
                    app.liveKitTokenRepository.getToken(identity = unitId, room = roomKey)
                }

                if (signaling) {
                    app.signalingRepository.transmitPre(roomKey)
                    Log.d(TAG, "Screen-off PTT: transmitPre sent for roomKey $roomKey")
                    app.toneEngine.playTalkPermitTone()
                }

                val tokenResult = tokenDeferred.await()
                if (tokenResult.isFailure) {
                    Log.e(TAG, "Token fetch failed: ${tokenResult.exceptionOrNull()?.message}")
                    app.toneEngine.playErrorTone()
                    pttState = PttState.IDLE
                    updateNotification("Radio — Standby")
                    sendPttTxFailed()
                    return@launch
                }
                val (token, livekitUrl) = tokenResult.getOrThrow()
                servicePrefs.livekitUrl = livekitUrl

                val wasAlreadyConnected = audioEngine.isConnected
                val connected = if (wasAlreadyConnected) true
                else audioEngine.connect(livekitUrl, token)

                if (!connected) {
                    Log.e(TAG, "LiveKit connect failed")
                    app.toneEngine.playErrorTone()
                    pttState = PttState.IDLE
                    updateNotification("Radio — Standby")
                    sendPttTxFailed()
                    return@launch
                }

                lastActivityMs = System.currentTimeMillis()
                if (!wasAlreadyConnected) startSessionTimer()

                if (pttUpWhileConnecting) {
                    Log.d(TAG, "PTT_UP received during connect — aborting TX (race condition avoided)")
                    pttState = PttState.IDLE
                    updateNotification("Radio — Standby")
                    rescheduleGracePeriod()
                    sendPttTxAborted()
                    return@launch
                }

                val txStarted = audioEngine.startTransmit()
                if (!txStarted) {
                    Log.e(TAG, "TX start failed after connect")
                    app.toneEngine.playErrorTone()
                    pttState = PttState.IDLE
                    updateNotification("Radio — Standby")
                    sendPttTxFailed()
                    return@launch
                }

                pttState = PttState.TRANSMITTING
                updateNotification("TRANSMITTING")
                sendPttTxStarted()

                if (signaling) {
                    app.signalingRepository.transmitStart(roomKey)
                    Log.d(TAG, "Screen-off PTT: transmitStart sent for roomKey $roomKey")
                }

                httpPttStart(serverUrl, roomKey, unitId)
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    Log.e(TAG, "Unhandled exception in PTT coroutine — resetting state", e)
                    pttState = PttState.IDLE
                    updateNotification("Radio — Standby")
                    sendPttTxFailed()
                }
                throw e
            }
        }
    }

    private fun handlePttUp() {
        Log.d(TAG, "handlePttUp pttState=$pttState needsSignaling=$needsSignaling")

        pttUpWhileConnecting = true

        if (pttState != PttState.TRANSMITTING) return

        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: return
        val channelId = servicePrefs.channelId.takeIf { it >= 0 } ?: return
        val roomKey = servicePrefs.channelRoomKey ?: return
        val serverUrl = servicePrefs.serverUrl ?: app.apiClient.baseUrl
        val wasSignaling = needsSignaling

        pttState = PttState.IDLE
        updateNotification("Radio — Standby")

        scope.launch {
            audioEngine.stopTransmit()
            sendPttTxEnded()
            if (wasSignaling) {
                app.signalingRepository.transmitEnd(roomKey)
                app.toneEngine.playEndOfTxTone()
                Log.d(TAG, "Screen-off PTT: transmitEnd + end-of-TX tone for roomKey $roomKey")
            }
            httpPttEnd(serverUrl, roomKey, unitId)
            rescheduleGracePeriod()
        }
    }

    private fun handleEmergencyDown() {
        Log.d(TAG, "handleEmergencyDown emergencyActive=$emergencyActive")

        // Second press while already in emergency → send to ViewModel for cancel-hold UI
        if (emergencyActive) {
            app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
            return
        }

        // Already activating — ignore duplicate DOWN (race between key event and vendor broadcast)
        if (emergencyActivatingJob != null) return

        val channelId = servicePrefs.channelId.takeIf { it >= 0 } ?: run {
            Log.w(TAG, "Emergency: no channel selected")
            return
        }
        val channelKey = servicePrefs.channelRoomKey ?: run {
            Log.w(TAG, "Emergency: no room key")
            return
        }

        // Wake the screen so the emergency UI is visible immediately
        @Suppress("DEPRECATION")
        val wl = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "CommandComms:EmergencyWake"
        ).apply { setReferenceCounted(false) }
        wl.acquire(5_000L)

        // Activate immediately — no arming countdown, no notification
        emergencyActivatingJob = scope.launch {
            emergencyActivatingJob = null
            activateEmergency(channelId, channelKey)
        }
    }

    private suspend fun activateEmergency(channelId: Int, channelKey: String) {
        Log.d(TAG, "activateEmergency channelId=$channelId channelKey=$channelKey")
        emergencyActive = true
        updateNotification("EMERGENCY ACTIVE")

        // Ensure signaling socket is connected and joined to the selected channel
        ensureBackgroundSignalingReady(channelId)

        // Send emergency:start Socket.IO event (notifies all units and dispatch console)
        app.signalingRepository.emergencyStart(channelKey)
        Log.d(TAG, "activateEmergency: emergencyStart signal sent for $channelKey")

        // Tell the ViewModel to update its UI state to "emergency active".
        sendEmergencyActivated()

        // Start emergency audio TX — reuse the existing PTT infrastructure.
        // signaling=true so transmitPre + transmitStart are emitted, which triggers
        // RX connect on other units so they can hear the emergency broadcast.
        handlePttDown(signaling = true)
    }

    private fun handleEmergencyUp() {
        Log.d(TAG, "handleEmergencyUp active=$emergencyActive")
        // Route to ViewModel so it can manage cancel-hold UI when Activity is in the foreground
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
                    val currentChannelId = servicePrefs.channelId
                    val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                    when (event) {
                        is SignalingEvent.PttPre -> {
                            if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                                handleRxConnect(currentChannelId)
                            }
                        }
                        is SignalingEvent.PttStart -> {
                            if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                                handleRxConnect(currentChannelId)
                            }
                        }
                        is SignalingEvent.PttEnd -> {
                            if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                                handleRxEnd()
                            }
                        }
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
            app.signalingRepository.leaveChannel(previousRoomKey)
        }
        app.signalingRepository.joinChannel(targetRoomKey)
        joinedSignalingChannelId = targetRoomKey
        Log.d(TAG, "Background signaling joined channel $targetRoomKey")
        return true
    }

    /**
     * Called when a remote unit starts transmitting (ptt:pre or ptt:start from ViewModel).
     * Ensures we are connected to LiveKit to receive the incoming audio.
     *
     * The AtomicBoolean [rxConnecting] prevents duplicate concurrent connects that arise
     * because PttPre + PttStart often arrive back-to-back: collectLatest cancels the
     * collector lambda, but scope.launch coroutines already in flight are NOT cancelled.
     * The old delay(100) + isConnected check also failed when onGracePeriodExpired's
     * async disconnect hadn't finished by the time the 100 ms elapsed.
     */
    private fun handleRxConnect(channelId: Int) {
        Log.d(TAG, "handleRxConnect channelId=$channelId pttState=$pttState connected=${audioEngine.isConnected} deadline=$sessionDeadlineMs")
        lastActivityMs = System.currentTimeMillis()

        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING) {
            return
        }

        // Active session — just extend the deadline and stay connected
        if (audioEngine.isConnected && sessionDeadlineMs > 0L) {
            sessionDeadlineMs = System.currentTimeMillis() + GRACE_PERIOD_MS
            rescheduleGracePeriod()
            return
        }

        // Deduplicate: skip if an RX connect coroutine is already in flight
        if (!rxConnecting.compareAndSet(false, true)) {
            Log.d(TAG, "RX connect: already in progress — skipping duplicate")
            return
        }

        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: run {
            Log.w(TAG, "RX connect: no unit ID")
            rxConnecting.set(false)
            return
        }
        val roomKey = servicePrefs.channelRoomKey ?: run {
            Log.w(TAG, "RX connect: no room key")
            rxConnecting.set(false)
            return
        }

        scope.launch {
            try {
                // Tear down any stale connection before reconnecting. This handles the
                // thread-race where onGracePeriodExpired's disconnect hasn't completed yet
                // when this coroutine starts (sessionDeadlineMs is already -1 but
                // audioEngine.isConnected is transiently still true).
                if (audioEngine.isConnected) {
                    Log.w(TAG, "RX connect: stale connection — disconnecting first")
                    audioEngine.disconnect()
                }
                val tokenResult = app.liveKitTokenRepository.getToken(identity = unitId, room = roomKey)
                if (tokenResult.isFailure) {
                    Log.w(TAG, "RX connect: token fetch failed — ${tokenResult.exceptionOrNull()?.message}")
                    return@launch
                }
                val (token, livekitUrl) = tokenResult.getOrThrow()
                servicePrefs.livekitUrl = livekitUrl
                val connected = audioEngine.connect(livekitUrl, token)
                if (connected) {
                    Log.d(TAG, "RX connect: LiveKit connected for receive")
                    startSessionTimer()
                }
            } finally {
                rxConnecting.set(false)
            }
        }
    }

    /**
     * Called when the remote unit's transmission ends (ptt:end from ViewModel).
     * Resumes the grace period countdown so the session can expire naturally.
     */
    private fun handleRxEnd() {
        Log.d(TAG, "handleRxEnd pttState=$pttState connected=${audioEngine.isConnected}")
        if (audioEngine.isConnected && pttState == PttState.IDLE && sessionDeadlineMs > 0L) {
            rescheduleGracePeriod()
        }
    }

    /**
     * Set the session deadline once on first LiveKit connect for this session.
     * Launches the grace-period countdown.
     */
    private fun startSessionTimer() {
        sessionDeadlineMs = System.currentTimeMillis() + GRACE_PERIOD_MS
        Log.d(TAG, "Session timer started, deadline in ${GRACE_PERIOD_MS}ms")
        rescheduleGracePeriod()
    }

    /**
     * Schedule (or reschedule) the grace-period job to fire at sessionDeadlineMs.
     * Does NOT reset the deadline — it resumes the countdown from wherever it is.
     */
    private fun rescheduleGracePeriod() {
        gracePeriodJob?.cancel()
        val remaining = sessionDeadlineMs - System.currentTimeMillis()
        if (remaining <= 0L) {
            scope.launch { onGracePeriodExpired() }
            return
        }
        gracePeriodJob = scope.launch {
            delay(remaining)
            onGracePeriodExpired()
        }
        Log.d(TAG, "Grace period rescheduled, ${remaining}ms remaining until deadline")
    }

    /**
     * Deadline reached. Extend if there was activity in the last ACTIVITY_WINDOW_MS,
     * otherwise disconnect. Never interrupts an active TX.
     *
     * suspend so that audioEngine.disconnect() fully runs before sessionDeadlineMs = -1L,
     * preventing a ptt:pre arriving right after the grace period from colliding with a
     * still-in-progress LiveKit teardown on its first reconnect attempt.
     */
    private suspend fun onGracePeriodExpired() {
        val now = System.currentTimeMillis()
        if (pttState != PttState.IDLE) {
            Log.d(TAG, "Grace period expired but PTT active — extending deadline")
            sessionDeadlineMs = now + GRACE_PERIOD_MS
            rescheduleGracePeriod()
            return
        }
        if (now - lastActivityMs < ACTIVITY_WINDOW_MS) {
            Log.d(TAG, "Grace period extended due to recent activity (${now - lastActivityMs}ms ago)")
            sessionDeadlineMs = now + GRACE_PERIOD_MS
            rescheduleGracePeriod()
            return
        }
        Log.d(TAG, "Grace period expired — disconnecting LiveKit")
        audioEngine.disconnect()
        sessionDeadlineMs = -1L
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
        radioEngine = engine
        observeRadioFloorEvents(engine)
        Log.d(TAG, "RadioAudioEngine initialized (custom-radio transport)")
    }

    private fun observeRadioFloorEvents(engine: RadioAudioEngine) {
        scope.launch {
            engine.floorControl.events.collect { event ->
                when (event) {
                    FloorControlEvent.GRANTED -> {
                        Log.d(TAG, "Floor GRANTED — starting TX")
                        val txStarted = engine.startTransmit()
                        if (txStarted) {
                            val roomKey = servicePrefs.channelRoomKey
                            if (roomKey != null) {
                                engine.floorControl.let { /* floor already transitioned */ }
                            }
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
                    is SignalingEvent.RadioPttGranted -> {
                        engine.floorControl.onFloorGranted(event.channelId)
                    }
                    is SignalingEvent.RadioPttDenied -> {
                        engine.floorControl.onFloorDenied(event.channelId)
                    }
                    is SignalingEvent.RadioChannelBusy -> {
                        if (event.channelId == currentRoomKey) {
                            engine.floorControl.onChannelBusy(event.transmittingUnit)
                            engine.startReceive()
                        }
                    }
                    is SignalingEvent.RadioChannelIdle -> {
                        if (event.channelId == currentRoomKey) {
                            engine.floorControl.onChannelIdle()
                            engine.stopReceive()
                        }
                    }
                    is SignalingEvent.RadioTxStart -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                            engine.floorControl.onChannelBusy(event.unitId)
                            engine.startReceive()
                        }
                    }
                    is SignalingEvent.RadioTxStop -> {
                        val selfUnitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
                        if (event.unitId != selfUnitId && event.channelId == currentRoomKey) {
                            engine.floorControl.onChannelIdle()
                            engine.stopReceive()
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

        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING) return

        pttUpWhileConnecting = false
        needsSignaling = signaling

        val roomKey = servicePrefs.channelRoomKey ?: run {
            Log.w(TAG, "Radio PTT DOWN ignored: no room key")
            sendPttTxFailed()
            return
        }

        val engine = radioEngine ?: run {
            Log.e(TAG, "Radio PTT DOWN: radioEngine not initialized — falling back to LiveKit")
            handlePttDown(signaling)
            return
        }

        pttState = PttState.CONNECTING
        updateNotification("Requesting floor…")
        app.toneEngine.playTalkPermitTone()

        scope.launch {
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

            engine.floorControl.requestFloor(roomKey)
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

        pttState = PttState.IDLE
        updateNotification("Radio — Standby")

        scope.launch {
            radioEngine?.stopTransmit()
            radioEngine?.floorControl?.releaseFloor(roomKey)
            sendPttTxEnded()
            if (wasSignaling) {
                app.signalingRepository.transmitEnd(roomKey)
                app.toneEngine.playEndOfTxTone()
                Log.d(TAG, "Radio PTT UP: transmitEnd + end-of-TX tone for roomKey $roomKey")
            }
            httpPttEnd(serverUrl, roomKey, unitId)
        }
    }

    private fun sendEmergencyActivated() {
        sendBroadcast(Intent(ACTION_EMERGENCY_ACTIVATED).apply { setPackage(packageName) })
    }

    private fun sendEmergencyCancelled() {
        sendBroadcast(Intent(ACTION_EMERGENCY_CANCELLED).apply { setPackage(packageName) })
    }

    /**
     * Broadcast PTT_TX_FAILED back to the ViewModel so it can reset pttState = IDLE
     * and play an error tone. Sent on real failures: token error, connect error, TX error.
     */
    private fun sendPttTxFailed() {
        Log.d(TAG, "Sending PTT_TX_FAILED broadcast")
        val intent = Intent(ACTION_PTT_TX_FAILED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    /**
     * Broadcast PTT_TX_ABORTED back to the ViewModel when the user released PTT before
     * the connection completed (deliberate early release). No error tone should play.
     */
    private fun sendPttTxAborted() {
        Log.d(TAG, "Sending PTT_TX_ABORTED broadcast")
        val intent = Intent(ACTION_PTT_TX_ABORTED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    /**
     * Broadcast PTT_TX_STARTED to the ViewModel so it can set pttState = TRANSMITTING
     * and update the PTT button visual state.
     */
    private fun sendPttTxStarted() {
        Log.d(TAG, "Sending PTT_TX_STARTED broadcast")
        val intent = Intent(ACTION_PTT_TX_STARTED).apply { setPackage(packageName) }
        sendBroadcast(intent)
    }

    /**
     * Broadcast PTT_TX_ENDED to the ViewModel so it can set pttState = IDLE
     * and update the PTT button visual state.
     */
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
        scope.launch { audioEngine.stopTransmit() }
        scope.cancel()
        audioEngine.release()
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
        const val ACTION_RX_CONNECT = "com.reedersystems.commandcomms.RX_CONNECT"
        const val ACTION_RX_END = "com.reedersystems.commandcomms.RX_END"
        const val ACTION_UPDATE_CHANNEL = "com.reedersystems.commandcomms.UPDATE_CHANNEL"
        const val ACTION_STOP = "com.reedersystems.commandcomms.STOP"
        const val ACTION_PTT_TX_FAILED = "com.reedersystems.commandcomms.PTT_TX_FAILED"
        const val ACTION_PTT_TX_ABORTED = "com.reedersystems.commandcomms.PTT_TX_ABORTED"
        const val ACTION_PTT_TX_STARTED = "com.reedersystems.commandcomms.PTT_TX_STARTED"
        const val ACTION_PTT_TX_ENDED = "com.reedersystems.commandcomms.PTT_TX_ENDED"
        /** Sent after emergency:start has been signalled. */
        const val ACTION_EMERGENCY_ACTIVATED = "com.reedersystems.commandcomms.EMERGENCY_ACTIVATED"
        /** Sent when an active emergency is cancelled (cancel-hold completed). */
        const val ACTION_EMERGENCY_CANCELLED = "com.reedersystems.commandcomms.EMERGENCY_CANCELLED"
        const val EXTRA_CHANNEL_ID = "channel_id"
        const val EXTRA_ROOM_KEY = "room_key"
        const val EXTRA_CHANNEL_NAME = "channel_name"
        const val EXTRA_NEEDS_SIGNALING = "needs_signaling"
        const val EXTRA_EMERGENCY_KEY_DOWN = "emergency_key_down"

        private const val WAKE_LOCK_TAG = "CommandComms:PttService"
    }
}
