package com.reedersystems.commandcomms.ui.login

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.DevConfig
import com.reedersystems.commandcomms.data.model.User
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

sealed class LoginUiState {
    object Idle : LoginUiState()
    object CheckingSession : LoginUiState()
    object Loading : LoginUiState()
    data class Success(val user: User) : LoginUiState()
    data class Error(val message: String) : LoginUiState()
}

class LoginViewModel(application: Application) : AndroidViewModel(application) {
    private companion object {
        const val STARTUP_TAG = "[APP-STARTUP]"
    }

    private val app get() = getApplication<CommandCommsApp>()

    val isAutoLoginMode = DevConfig.AUTO_LOGIN_ENABLED

    private val _uiState = MutableStateFlow<LoginUiState>(
        if (DevConfig.AUTO_LOGIN_ENABLED) LoginUiState.Loading else LoginUiState.CheckingSession
    )
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    init {
        if (DevConfig.AUTO_LOGIN_ENABLED) {
            performAutoLogin()
        } else {
            checkExistingSession()
        }
    }

    private fun performAutoLogin() {
        viewModelScope.launch {
            Log.d(STARTUP_TAG, "AUTH_REQUEST_SENT method=auto_login unitId=${DevConfig.AUTO_LOGIN_UNIT_ID}")
            Log.d("LoginViewModel", "Auto-login enabled, logging in as ${DevConfig.AUTO_LOGIN_UNIT_ID}")
            val result = app.authRepository.login(
                DevConfig.AUTO_LOGIN_UNIT_ID,
                DevConfig.AUTO_LOGIN_PASSWORD
            )
            if (result.isSuccess) {
                val user = result.getOrThrow()
                Log.d(STARTUP_TAG, "AUTH_SUCCESS user=${user.username} unitId=${user.unitId ?: "none"}")
                saveUserPrefs(user)
                fetchAndStoreRadioConfig()
                _uiState.value = LoginUiState.Success(user)
            } else {
                Log.e(STARTUP_TAG, "AUTH_FAILED method=auto_login reason=${result.exceptionOrNull()?.message}")
                Log.w("LoginViewModel", "Auto-login failed: ${result.exceptionOrNull()?.message}")
                _uiState.value = LoginUiState.Error(
                    "Auto-login failed: ${result.exceptionOrNull()?.message ?: "Unknown error"}"
                )
            }
        }
    }

    private fun checkExistingSession() {
        viewModelScope.launch {
            Log.d(STARTUP_TAG, "SESSION_CHECK_START")
            _uiState.value = LoginUiState.CheckingSession
            val result = app.authRepository.me()
            if (result.isSuccess) {
                val user = result.getOrThrow()
                Log.d(STARTUP_TAG, "SESSION_CHECK_RESULT hasSession=true user=${user.username}")
                saveUserPrefs(user)
                fetchAndStoreRadioConfig()
                _uiState.value = LoginUiState.Success(user)
            } else {
                Log.w(STARTUP_TAG, "SESSION_CHECK_RESULT hasSession=false reason=${result.exceptionOrNull()?.message}")
                _uiState.value = LoginUiState.Idle
            }
        }
    }

    fun login(username: String, password: String) {
        if (username.isBlank() || password.isBlank()) {
            _uiState.value = LoginUiState.Error("Unit ID and password are required")
            return
        }
        viewModelScope.launch {
            _uiState.value = LoginUiState.Loading
            Log.d(STARTUP_TAG, "AUTH_REQUEST_SENT method=manual_login unitId=${username.trim()}")
            val result = app.authRepository.login(username.trim(), password)
            if (result.isSuccess) {
                val user = result.getOrThrow()
                Log.d(STARTUP_TAG, "AUTH_SUCCESS user=${user.username} unitId=${user.unitId ?: "none"}")
                saveUserPrefs(user)
                fetchAndStoreRadioConfig()
                _uiState.value = LoginUiState.Success(user)
            } else {
                Log.e(STARTUP_TAG, "AUTH_FAILED method=manual_login reason=${result.exceptionOrNull()?.message}")
                _uiState.value = LoginUiState.Error(
                    result.exceptionOrNull()?.message ?: "Login failed"
                )
            }
        }
    }

    fun clearError() {
        if (_uiState.value is LoginUiState.Error) {
            _uiState.value = LoginUiState.Idle
        }
    }

    private fun saveUserPrefs(user: User) {
        app.sessionPrefs.userId = user.id
        app.sessionPrefs.username = user.username
        app.sessionPrefs.unitId = user.unitId
        app.sessionPrefs.userRole = user.role
    }

    private suspend fun fetchAndStoreRadioConfig() {
        Log.d(STARTUP_TAG, "RADIO_CONFIG_FETCH_START")
        val result = app.radioConfigRepository.fetchConfig()
        if (result.isSuccess) {
            val config = result.getOrThrow()
            Log.d(STARTUP_TAG, "RADIO_CONFIG_FETCH_SUCCESS host=${config.audioRelayHost} port=${config.audioRelayPort} signalingUrl=${config.signalingUrl}")
            app.radioTransportConfig = config
            val prefs = app.serviceConnectionPrefs
            prefs.transportMode = config.transportMode
            prefs.relayHost = config.audioRelayHost
            prefs.relayPort = config.audioRelayPort
            prefs.signalingUrl = config.signalingUrl
            prefs.useTls = config.useTls
            app.signalingClient.serverUrl = config.signalingUrl
            Log.d("LoginViewModel", "Radio transport config persisted: host=${config.audioRelayHost} port=${config.audioRelayPort} signalingUrl=${config.signalingUrl}")
        } else {
            Log.e(STARTUP_TAG, "RADIO_CONFIG_FETCH_FAILED reason=${result.exceptionOrNull()?.message}")
            Log.w("LoginViewModel", "Radio config fetch failed, using defaults: ${result.exceptionOrNull()?.message}")
        }
    }
}
