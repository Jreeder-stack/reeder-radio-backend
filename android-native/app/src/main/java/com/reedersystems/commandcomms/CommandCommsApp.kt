package com.reedersystems.commandcomms

import android.app.Application
import com.reedersystems.commandcomms.audio.ToneEngine
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import com.reedersystems.commandcomms.data.prefs.SessionPrefs
import com.reedersystems.commandcomms.data.repository.AuthRepository
import com.reedersystems.commandcomms.data.repository.ChannelRepository
import com.reedersystems.commandcomms.data.repository.LiveKitTokenRepository
import com.reedersystems.commandcomms.signaling.SignalingClient
import com.reedersystems.commandcomms.signaling.SignalingRepository
import kotlinx.coroutines.flow.MutableSharedFlow

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

    lateinit var toneEngine: ToneEngine
        private set

    val keyEventFlow = MutableSharedFlow<KeyAction>(extraBufferCapacity = 16)

    override fun onCreate() {
        super.onCreate()
        apiClient = ApiClient.getInstance(this)
        sessionPrefs = SessionPrefs(this)
        serviceConnectionPrefs = ServiceConnectionPrefs(this)
        authRepository = AuthRepository(apiClient)
        channelRepository = ChannelRepository(apiClient)
        liveKitTokenRepository = LiveKitTokenRepository(apiClient)
        signalingClient = SignalingClient(apiClient.baseUrl)
        signalingRepository = SignalingRepository(signalingClient)
        toneEngine = ToneEngine(this)
    }
}
