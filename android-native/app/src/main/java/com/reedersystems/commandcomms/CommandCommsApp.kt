package com.reedersystems.commandcomms

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.UUID
import com.reedersystems.commandcomms.audio.ToneEngine
import com.reedersystems.commandcomms.audio.radio.RadioStateManager
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.prefs.KioskPrefs
import com.reedersystems.commandcomms.data.prefs.PttKeyPrefs
import com.reedersystems.commandcomms.data.prefs.RadioTokenStore
import com.reedersystems.commandcomms.data.prefs.SpeakerBoostPrefs
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import com.reedersystems.commandcomms.data.prefs.SessionPrefs
import com.reedersystems.commandcomms.device.KioskPolicyManager
import com.reedersystems.commandcomms.data.model.RadioTransportConfig
import com.reedersystems.commandcomms.data.repository.AuthRepository
import com.reedersystems.commandcomms.data.repository.ChannelRepository
import com.reedersystems.commandcomms.data.repository.RadioConfigRepository
import com.reedersystems.commandcomms.signaling.SignalingClient
import com.reedersystems.commandcomms.signaling.SignalingEvent
import com.reedersystems.commandcomms.signaling.SignalingRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

class CommandCommsApp : Application() {

    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    lateinit var apiClient: ApiClient
        private set

    lateinit var sessionPrefs: SessionPrefs
        private set

    lateinit var serviceConnectionPrefs: ServiceConnectionPrefs
        private set

    lateinit var authRepository: AuthRepository
        private set

    lateinit var channelRepository: ChannelRepository
        private set

    lateinit var signalingClient: SignalingClient
        private set

    lateinit var signalingRepository: SignalingRepository
        private set

    lateinit var radioConfigRepository: RadioConfigRepository
        private set

    lateinit var pttKeyPrefs: PttKeyPrefs
        private set

    lateinit var speakerBoostPrefs: SpeakerBoostPrefs
        private set

    lateinit var kioskPrefs: KioskPrefs
        private set

    lateinit var kioskPolicyManager: KioskPolicyManager
        private set

    lateinit var radioTokenStore: RadioTokenStore
        private set

    lateinit var toneEngine: ToneEngine
        private set

    var radioStateManager: RadioStateManager? = null
        private set

    @Volatile
    var radioTransportConfig: RadioTransportConfig? = null

    val keyEventFlow = MutableSharedFlow<KeyAction>(extraBufferCapacity = 16)
    val keyCapturingFlow = MutableStateFlow(false)

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        apiClient = ApiClient.getInstance(this)
        sessionPrefs = SessionPrefs(this)
        serviceConnectionPrefs = ServiceConnectionPrefs(this)
        pttKeyPrefs = PttKeyPrefs(this)
        speakerBoostPrefs = SpeakerBoostPrefs(this)
        kioskPrefs = KioskPrefs(this)
        kioskPolicyManager = KioskPolicyManager(this)
        val currentVersionCode = packageManager
            .getPackageInfo(packageName, 0)
            .let { if (Build.VERSION.SDK_INT >= 28) it.longVersionCode else it.versionCode.toLong() }
        if (sessionPrefs.lastVersionCode != currentVersionCode) {
            Log.d("CommandCommsApp", "Version changed (${sessionPrefs.lastVersionCode} → $currentVersionCode), clearing session")
            sessionPrefs.clear()
            serviceConnectionPrefs.clear()
            apiClient.cookieJar.clear()
            sessionPrefs.lastVersionCode = currentVersionCode
        }

        radioTokenStore = RadioTokenStore(this)
        val storedRadioToken = radioTokenStore.getToken()
        if (storedRadioToken != null) {
            apiClient.radioToken = storedRadioToken
        }
        val assignedUnit = radioTokenStore.getAssignedUnitId()
        if (assignedUnit != null) {
            if (sessionPrefs.unitId.isNullOrBlank()) sessionPrefs.unitId = assignedUnit
            if (sessionPrefs.username.isNullOrBlank()) sessionPrefs.username = assignedUnit
        }
        authRepository = AuthRepository(apiClient)
        channelRepository = ChannelRepository(apiClient)
        val persistedDeviceId = getOrCreateDeviceId()
        signalingClient = SignalingClient(apiClient.baseUrl, storedRadioToken, persistedDeviceId)
        signalingClient.onAuthenticated = {
            Log.d("CommandCommsApp", "Socket authenticated — re-registering persisted FCM token")
            apiClient.registerPersistedFcmToken(appScope)
        }
        signalingRepository = SignalingRepository(signalingClient)
        radioConfigRepository = RadioConfigRepository(apiClient)
        toneEngine = ToneEngine(this)

        radioStateManager = RadioStateManager()

        registerRemoteKioskReceiver()
        observeRemoteKioskEvents()
        // Re-assert correct kiosk state on cold start in case the device
        // rebooted while a remote-unlock window was still in effect (or just
        // expired). Safe no-op on non-Device-Owner builds.
        applyRemoteKioskState(launchActivityIfPinning = false)
    }

    /**
     * Listen for dispatcher-issued kiosk override events on the signaling
     * channel and persist them into [KioskPrefs] so the change survives
     * process death / activity recreation. The matching local broadcast
     * triggers our process-level enforcement so policies/lock-task are
     * re-applied immediately regardless of whether MainActivity is in the
     * foreground.
     */
    private fun observeRemoteKioskEvents() {
        appScope.launch {
            signalingClient.events.collect { event ->
                when (event) {
                    is SignalingEvent.RemoteKioskUnlock -> {
                        Log.d(TAG, "Remote kiosk unlock until=${event.expiresAtMs} duration=${event.durationMinutes}m")
                        kioskPrefs.setRemoteUnlock(event.expiresAtMs)
                        sendBroadcast(Intent(ACTION_REMOTE_KIOSK_CHANGED).setPackage(packageName))
                    }
                    is SignalingEvent.RemoteKioskRelock -> {
                        Log.d(TAG, "Remote kiosk relock")
                        kioskPrefs.clearRemoteUnlock()
                        sendBroadcast(Intent(ACTION_REMOTE_KIOSK_CHANGED).setPackage(packageName))
                    }
                    else -> {}
                }
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * Process-level auto-relock. Fires at remote-unlock expiry and re-pins
     * the device whether or not MainActivity is foregrounded. Owned by the
     * Application so it survives activity destruction.
     */
    private val autoRelockRunnable = Runnable {
        Log.d(TAG, "autoRelockRunnable fired — clearing remote unlock and re-applying kiosk")
        try {
            kioskPrefs.clearRemoteUnlock()
        } catch (e: Exception) {
            Log.w(TAG, "autoRelockRunnable clearRemoteUnlock failed: ${e.message}")
        }
        applyRemoteKioskState(launchActivityIfPinning = true)
    }

    /**
     * Permanently-registered receiver that reacts to dispatcher kiosk
     * commands regardless of activity lifecycle. This is what makes the
     * "Re-lock" action take effect even when the radio app is backgrounded.
     */
    private val remoteKioskReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != ACTION_REMOTE_KIOSK_CHANGED) return
            Log.d(TAG, "ACTION_REMOTE_KIOSK_CHANGED received at app level")
            applyRemoteKioskState(launchActivityIfPinning = true)
        }
    }

    private fun registerRemoteKioskReceiver() {
        val filter = IntentFilter(ACTION_REMOTE_KIOSK_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(remoteKioskReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(remoteKioskReceiver, filter)
        }
    }

    /**
     * Apply (or clear) Device Owner kiosk policies based on the current
     * effective state in [KioskPrefs]. Re-arms or cancels the auto-relock
     * timer accordingly. When transitioning back into kiosk and
     * [launchActivityIfPinning] is true, MainActivity is brought to the
     * foreground so it can call [android.app.Activity.startLockTask] (which
     * is the one piece that requires an Activity context).
     *
     * Idempotent: safe to call repeatedly. Silent no-op when the app is not
     * Device Owner (per [KioskPolicyManager.applyKioskPolicies]).
     */
    fun applyRemoteKioskState(launchActivityIfPinning: Boolean) {
        val now = System.currentTimeMillis()
        val remoteUnlockUntil = kioskPrefs.remoteUnlockUntilMs
        val remoteUnlockActive = remoteUnlockUntil > now
        val shouldPin = kioskPrefs.kioskEnabled && kioskPolicyManager.isDeviceOwner && !remoteUnlockActive

        // Always cancel any pending auto-relock; re-schedule below if still
        // inside an active unlock window.
        mainHandler.removeCallbacks(autoRelockRunnable)

        try {
            if (shouldPin) {
                kioskPolicyManager.applyKioskPolicies()
                if (launchActivityIfPinning) {
                    val launchIntent = Intent(this, MainActivity::class.java).apply {
                        addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP
                        )
                    }
                    try {
                        startActivity(launchIntent)
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to bring MainActivity to front for relock: ${e.message}")
                    }
                }
            } else {
                kioskPolicyManager.clearKioskPolicies()
            }
        } catch (e: Exception) {
            Log.w(TAG, "applyRemoteKioskState policy step failed: ${e.message}")
        }

        if (remoteUnlockActive) {
            val delayMs = (remoteUnlockUntil - now).coerceAtLeast(0L)
            Log.d(TAG, "Scheduling auto-relock in ${delayMs}ms (until=$remoteUnlockUntil)")
            mainHandler.postDelayed(autoRelockRunnable, delayMs)
        } else if (remoteUnlockUntil != 0L) {
            // Window already expired by the time we got here — clear the
            // stale value so the next event starts from a clean slate.
            kioskPrefs.clearRemoteUnlock()
        }
    }

    companion object {
        const val ACTION_REMOTE_KIOSK_CHANGED = "com.reedersystems.commandcomms.REMOTE_KIOSK_CHANGED"
        private const val TAG = "CommandCommsApp"
    }

    private fun createNotificationChannels() {
        val nm = getSystemService(NotificationManager::class.java)

        val alarmSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val alarmAudioAttrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        val emergency = NotificationChannel(
            "channel_emergency",
            "Emergency",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "High-priority emergency alerts"
            enableVibration(true)
            setBypassDnd(true)
            setShowBadge(true)
            setSound(alarmSound, alarmAudioAttrs)
        }

        val pttService = NotificationChannel(
            "ptt_service",
            "PTT Service",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Keeps radio connection alive for PTT"
            setShowBadge(false)
        }

        val pttConnected = NotificationChannel(
            "ptt_service_connected",
            "PTT Service — Connected",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "PTT service LED: connected (green)"
            setShowBadge(false)
            enableLights(true)
            lightColor = 0xFF00FF00.toInt()
        }

        val pttDisconnected = NotificationChannel(
            "ptt_service_disconnected",
            "PTT Service — Disconnected",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "PTT service LED: disconnected (red)"
            setShowBadge(false)
            enableLights(true)
            lightColor = 0xFFFF0000.toInt()
        }

        val pttDegraded = NotificationChannel(
            "ptt_service_degraded",
            "PTT Service — Degraded",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "PTT service LED: degraded connection (amber)"
            setShowBadge(false)
            enableLights(true)
            lightColor = 0xFFFF8800.toInt()
        }

        val messages = NotificationChannel(
            "channel_messages",
            "Messages",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Incoming messages and communications"
            enableVibration(true)
            setShowBadge(true)
        }

        val system = NotificationChannel(
            "channel_system",
            "System",
            NotificationManager.IMPORTANCE_DEFAULT
        ).apply {
            description = "Status alerts and login events"
            enableVibration(true)
            setShowBadge(true)
        }

        try {
            nm.deleteNotificationChannel("channel_paging")
        } catch (_: Exception) {}

        val paging = NotificationChannel(
            "channel_paging_v2",
            "Paging",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Dispatch paging alerts — plays tone and shows full-screen overlay"
            enableVibration(false)
            setBypassDnd(true)
            setShowBadge(true)
            setSound(null, null)
        }

        nm.createNotificationChannels(listOf(emergency, pttService, pttConnected, pttDisconnected, pttDegraded, messages, system, paging))
    }

    @Volatile var pendingPageId: String? = null
    @Volatile var pendingPageMessage: String? = null
    @Volatile var pendingPageSender: String? = null
    @Volatile var pendingPageChannelId: String? = null

    private fun getOrCreateDeviceId(): String {
        val prefs = getSharedPreferences("commandcomms_device", Context.MODE_PRIVATE)
        val existing = prefs.getString("device_id", null)
        if (existing != null) return existing
        val newId = UUID.randomUUID().toString()
        prefs.edit().putString("device_id", newId).apply()
        Log.d("CommandCommsApp", "Generated new device ID: $newId")
        return newId
    }
}
