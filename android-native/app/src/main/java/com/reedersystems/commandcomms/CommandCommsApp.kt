package com.reedersystems.commandcomms

import android.app.Application
import com.reedersystems.commandcomms.data.api.ApiClient
import com.reedersystems.commandcomms.data.prefs.SessionPrefs
import com.reedersystems.commandcomms.data.repository.AuthRepository
import com.reedersystems.commandcomms.data.repository.ChannelRepository

class CommandCommsApp : Application() {

    lateinit var apiClient: ApiClient
        private set

    lateinit var sessionPrefs: SessionPrefs
        private set

    lateinit var authRepository: AuthRepository
        private set

    lateinit var channelRepository: ChannelRepository
        private set

    override fun onCreate() {
        super.onCreate()
        apiClient = ApiClient.getInstance(this)
        sessionPrefs = SessionPrefs(this)
        authRepository = AuthRepository(apiClient)
        channelRepository = ChannelRepository(apiClient)
    }
}
