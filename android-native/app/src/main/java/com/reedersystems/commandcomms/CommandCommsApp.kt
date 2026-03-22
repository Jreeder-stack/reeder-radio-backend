package com.reedersystems.commandcomms

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import com.reedersystems.commandcomms.audio.DndOverrideManager
import com.reedersystems.commandcomms.audio.ToneEngine
import com.reedersystems.commandcomms.audio.radio.RadioStateManager
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.prefs.PttKeyPrefs
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import com.reedersystems.commandcomms.data.prefs.SessionPrefs
import com.reedersystems.commandcomms.data.repository.AuthRepository
import com.reedersystems.commandcomms.data.repository.ChannelRepository
import com.reedersystems.commandcomms.data.repository.LiveKitTokenRepository
import com.reedersystems.commandcomms.signaling.SignalingClient
import com.reedersystems.commandcomms.signaling.SignalingRepository
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow

class CommandCommsApp : Application() {

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

    lateinit var liveKitTokenRepository: LiveKitTokenRepository
        private set

    lateinit var signalingClient: SignalingClient
        private set

    lateinit var signalingRepository: SignalingRepository
        private set

    lateinit var pttKeyPrefs: PttKeyPrefs
        private set

    lateinit var toneEngine: ToneEngine
        private set

    lateinit var dndOverrideManager: DndOverrideManager
        private set

    var radioStateManager: RadioStateManager? = null
        private set

    val keyEventFlow = MutableSharedFlow<KeyAction>(extraBufferCapacity = 16)
    val keyCapturingFlow = MutableStateFlow(false)

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
        apiClient = ApiClient.getInstance(this)
        sessionPrefs = SessionPrefs(this)
        serviceConnectionPrefs = ServiceConnectionPrefs(this)
        pttKeyPrefs = PttKeyPrefs(this)
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

        authRepository = AuthRepository(apiClient)
        channelRepository = ChannelRepository(apiClient)
        @Suppress("DEPRECATION")
        liveKitTokenRepository = LiveKitTokenRepository(apiClient)
        signalingClient = SignalingClient(apiClient.baseUrl)
        signalingRepository = SignalingRepository(signalingClient)
        toneEngine = ToneEngine(this)
        dndOverrideManager = DndOverrideManager(this)

        val prefs = ServiceConnectionPrefs(this)
        if (prefs.transportMode == "custom-radio") {
            radioStateManager = RadioStateManager()
        }
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

        nm.createNotificationChannels(listOf(emergency, pttService, messages, system))
    }
}
