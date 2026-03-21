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
    private lateinit var servicePrefs: ServiceConnectionPrefs
    private val app get() = application as CommandCommsApp

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

        audioEngine = PttAudioEngine(applicationContext)
        audioEngine.onDisconnected = {
            Log.d(TAG, "LiveKit unexpected disconnect — resetting session state")
            gracePeriodJob?.cancel()
            gracePeriodJob = null
            sessionDeadlineMs = -1L
        }
        servicePrefs = ServiceConnectionPrefs(applicationContext)
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
            addAction("com.inrico.emergency.down")
            addAction("com.inrico.emergency.up")
            addAction("com.inrico.intent.action.EMERGENCY_DOWN")
            addAction("com.inrico.intent.action.EMERGENCY_UP")
        }
        val receiver = PttHardwareReceiver()
        ContextCompat.registerReceiver(this, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
        dynamicPttReceiver = receiver
        Log.d(TAG, "Dynamic PttHardwareReceiver registered")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PTT_DOWN -> handlePttDown(intent.getBooleanExtra(EXTRA_NEEDS_SIGNALING, false))
            ACTION_PTT_UP -> handlePttUp()
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
                    ensureBackgroundSignalingConnected()
                    scope.launch { syncBackgroundSignalingChannel() }
                }
            }
            ACTION_STOP -> {
                Log.d(TAG, "Service stop requested")
                scope.launch { audioEngine.disconnect() }
                stopSelf()
            }
        }
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
            if (signaling && !ensureBackgroundSignalingReady(channelId)) {
                Log.e(TAG, "Screen-off PTT: signaling not ready")
                pttState = PttState.IDLE
                updateNotification("Radio — Standby")
                sendPttTxFailed()
                return@launch
            }

            if (signaling) {
                app.signalingRepository.transmitPre(roomKey)
                Log.d(TAG, "Screen-off PTT: transmitPre sent for roomKey $roomKey")
            }
            val tokenResult = app.liveKitTokenRepository.getToken(identity = unitId, room = roomKey)
            if (tokenResult.isFailure) {
                Log.e(TAG, "Token fetch failed: ${tokenResult.exceptionOrNull()?.message}")
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
                pttState = PttState.IDLE
                updateNotification("Radio — Standby")
                sendPttTxFailed()
                return@launch
            }

            pttState = PttState.TRANSMITTING
            updateNotification("TRANSMITTING")
            sendPttTxStarted()
            httpPttStart(serverUrl, channelId, unitId)

            if (signaling) {
                app.signalingRepository.transmitStart(roomKey)
                app.toneEngine.playTalkPermitTone()
                Log.d(TAG, "Screen-off PTT: transmitStart + talk-permit tone for roomKey $roomKey")
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
            httpPttEnd(serverUrl, channelId, unitId)
            if (wasSignaling) {
                app.signalingRepository.transmitEnd(roomKey)
                app.toneEngine.playEndOfTxTone()
                Log.d(TAG, "Screen-off PTT: transmitEnd + end-of-TX tone for roomKey $roomKey")
            }
            rescheduleGracePeriod()
        }
    }

    private fun handleEmergencyDown() {
        Log.d(TAG, "handleEmergencyDown — waking screen and launching MainActivity")

        // Wake the screen. SCREEN_BRIGHT_WAKE_LOCK + ACQUIRE_CAUSES_WAKEUP turns the
        // display on. KeyAction.EmergencyDown is emitted in MainActivity.onNewIntent
        // once the Activity is visible so the keyEventFlow collector is running.
        @Suppress("DEPRECATION")
        val wl = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(
            PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP,
            "CommandComms:EmergencyWake"
        ).apply { setReferenceCounted(false) }
        wl.acquire(5_000L)

        val wakeIntent = Intent(this, MainActivity::class.java).apply {
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            )
            putExtra(EXTRA_EMERGENCY_KEY_DOWN, true)
        }
        startActivity(wakeIntent)
    }

    private fun handleEmergencyUp() {
        Log.d(TAG, "handleEmergencyUp — routing to ViewModel")
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

    private fun httpPttStart(serverUrl: String, channelId: Int, unitId: String) {
        val json = """{"channelId":$channelId,"unitId":"$unitId"}"""
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

    private fun httpPttEnd(serverUrl: String, channelId: Int, unitId: String) {
        val json = """{"channelId":$channelId,"unitId":"$unitId"}"""
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
        const val EXTRA_CHANNEL_ID = "channel_id"
        const val EXTRA_ROOM_KEY = "room_key"
        const val EXTRA_CHANNEL_NAME = "channel_name"
        const val EXTRA_NEEDS_SIGNALING = "needs_signaling"
        const val EXTRA_EMERGENCY_KEY_DOWN = "emergency_key_down"

        private const val WAKE_LOCK_TAG = "CommandComms:PttService"
    }
}
