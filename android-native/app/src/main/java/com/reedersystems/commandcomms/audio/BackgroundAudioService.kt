package com.reedersystems.commandcomms.audio

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.MainActivity
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import kotlinx.coroutines.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private const val TAG = "[PTT-DIAG]"
private const val NOTIFICATION_ID = 1001
private const val CHANNEL_ID = "ptt_service"
private const val GRACE_PERIOD_MS = 15_000L

class BackgroundAudioService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var audioEngine: PttAudioEngine
    private lateinit var servicePrefs: ServiceConnectionPrefs
    private val app get() = application as CommandCommsApp

    private var pttState = PttState.IDLE
    private var gracePeriodJob: Job? = null

    /**
     * Set to true as soon as ACTION_PTT_UP is received, regardless of pttState.
     * Checked after the async connect completes in handlePttDown() to abort TX
     * if the user released PTT before the connection finished (race condition fix).
     * Always reset to false at the start of handlePttDown().
     */
    @Volatile private var pttUpWhileConnecting = false

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "BackgroundAudioService created")
        audioEngine = PttAudioEngine(applicationContext)
        servicePrefs = ServiceConnectionPrefs(applicationContext)
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Radio — Standby"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PTT_DOWN -> handlePttDown()
            ACTION_PTT_UP -> handlePttUp()
            ACTION_UPDATE_CHANNEL -> {
                val channelId = intent.getIntExtra(EXTRA_CHANNEL_ID, -1)
                val roomKey = intent.getStringExtra(EXTRA_ROOM_KEY)
                val channelName = intent.getStringExtra(EXTRA_CHANNEL_NAME)
                if (channelId >= 0 && roomKey != null) {
                    servicePrefs.channelId = channelId
                    servicePrefs.channelRoomKey = roomKey
                    if (channelName != null) servicePrefs.channelName = channelName
                    Log.d(TAG, "Channel updated: $channelId / $roomKey")
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

    private fun handlePttDown() {
        Log.d(TAG, "handlePttDown pttState=$pttState")

        if (!app.sessionPrefs.micPermissionGranted) {
            Log.w(TAG, "PTT DOWN service: mic permission denied — blocked")
            app.toneEngine.playErrorTone()
            return
        }

        if (pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING) return

        // Reset AFTER all early-return guards so a second DOWN while still CONNECTING
        // cannot clear the flag set by an intervening UP (race condition fix).
        pttUpWhileConnecting = false

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

            val connected = if (audioEngine.isConnected) true
            else audioEngine.connect(livekitUrl, token)

            if (!connected) {
                Log.e(TAG, "LiveKit connect failed")
                pttState = PttState.IDLE
                updateNotification("Radio — Standby")
                sendPttTxFailed()
                return@launch
            }

            if (pttUpWhileConnecting) {
                Log.d(TAG, "PTT_UP received during connect — aborting TX (race condition avoided)")
                pttState = PttState.IDLE
                updateNotification("Radio — Standby")
                scheduleGracePeriod()
                sendPttTxFailed()
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
            httpPttStart(serverUrl, channelId, unitId)
        }
    }

    private fun handlePttUp() {
        Log.d(TAG, "handlePttUp pttState=$pttState")

        pttUpWhileConnecting = true

        if (pttState != PttState.TRANSMITTING) return

        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId ?: return
        val channelId = servicePrefs.channelId.takeIf { it >= 0 } ?: return
        val serverUrl = servicePrefs.serverUrl ?: app.apiClient.baseUrl

        pttState = PttState.IDLE
        updateNotification("Radio — Standby")

        scope.launch {
            audioEngine.stopTransmit()
            httpPttEnd(serverUrl, channelId, unitId)
            scheduleGracePeriod()
        }
    }

    private fun scheduleGracePeriod() {
        gracePeriodJob?.cancel()
        gracePeriodJob = scope.launch {
            delay(GRACE_PERIOD_MS)
            if (pttState == PttState.IDLE) {
                Log.d(TAG, "Grace period expired, disconnecting LiveKit")
                audioEngine.disconnect()
            }
        }
    }

    /**
     * Broadcast PTT_TX_FAILED back to the ViewModel so it can reset pttState = IDLE.
     * Sent on all non-transmitting exits: token error, connect error, TX error, and
     * PTT_UP-during-connect cancellation. The ViewModel receiver only plays an error
     * tone when its own pttState is TRANSMITTING, so the cancellation path is a silent
     * no-op on the ViewModel side (pttState was already reset by onPttUp()).
     */
    private fun sendPttTxFailed() {
        Log.d(TAG, "Sending PTT_TX_FAILED broadcast")
        val intent = Intent(ACTION_PTT_TX_FAILED).apply { setPackage(packageName) }
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

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "PTT Radio Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps radio connection alive for PTT"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
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
        scope.launch { audioEngine.stopTransmit() }
        scope.cancel()
        audioEngine.release()
        super.onDestroy()
    }

    companion object {
        const val ACTION_PTT_DOWN = "com.reedersystems.commandcomms.SVC_PTT_DOWN"
        const val ACTION_PTT_UP = "com.reedersystems.commandcomms.SVC_PTT_UP"
        const val ACTION_UPDATE_CHANNEL = "com.reedersystems.commandcomms.UPDATE_CHANNEL"
        const val ACTION_STOP = "com.reedersystems.commandcomms.STOP"
        const val ACTION_PTT_TX_FAILED = "com.reedersystems.commandcomms.PTT_TX_FAILED"
        const val EXTRA_CHANNEL_ID = "channel_id"
        const val EXTRA_ROOM_KEY = "room_key"
        const val EXTRA_CHANNEL_NAME = "channel_name"
    }
}
