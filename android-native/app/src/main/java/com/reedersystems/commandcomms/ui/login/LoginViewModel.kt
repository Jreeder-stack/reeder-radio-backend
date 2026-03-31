package com.reedersystems.commandcomms.ui.login

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.reedersystems.commandcomms.CommandCommsApp
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
        const val LOGIN_TAG = "[LOGIN-FLOW]"
    }

    private val app get() = getApplication<CommandCommsApp>()

    private val _uiState = MutableStateFlow<LoginUiState>(LoginUiState.CheckingSession)
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()
    private val _manualInputDetected = MutableStateFlow(false)

    init {
        checkExistingSession()
    }

    private fun checkExistingSession() {
        viewModelScope.launch {
            Log.d(STARTUP_TAG, "SESSION_CHECK_START")
            Log.d(STARTUP_TAG, "AUTH_RESTORE_START hasSession=${app.sessionPrefs.hasSession} hasCookies=${app.apiClient.cookieJar.hasCookies()}")
            _uiState.value = LoginUiState.CheckingSession
            val result = app.authRepository.me()
            if (result.isSuccess) {
                val user = result.getOrThrow()
                Log.d(STARTUP_TAG, "AUTH_RESTORE_RESULT success=true user=${user.username}")
                Log.d(STARTUP_TAG, "SESSION_CHECK_RESULT hasSession=true user=${user.username}")
                Log.d(LOGIN_TAG, "SESSION_STATE_CHANGED state=authenticated source=session_check")
                saveUserPrefs(user)
                fetchAndStoreRadioConfig()
                _uiState.value = LoginUiState.Success(user)
            } else {
                Log.w(STARTUP_TAG, "AUTH_RESTORE_RESULT success=false reason=${result.exceptionOrNull()?.message}")
                Log.w(STARTUP_TAG, "SESSION_CHECK_RESULT hasSession=false reason=${result.exceptionOrNull()?.message}")
                clearStaleSession("session_check_failed")
                Log.d(LOGIN_TAG, "SESSION_STATE_CHANGED state=unauthenticated source=session_check_failed")
                _uiState.value = LoginUiState.Idle
            }
            logFormState("session_check_completed")
        }
    }

    fun login(username: String, password: String) {
        Log.d(LOGIN_TAG, "MANUAL_LOGIN_SUBMIT unitId=${username.trim()}")
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
                Log.d(LOGIN_TAG, "SESSION_STATE_CHANGED state=authenticated source=manual_login")
                saveUserPrefs(user)
                fetchAndStoreRadioConfig()
                _uiState.value = LoginUiState.Success(user)
            } else {
                Log.e(STARTUP_TAG, "AUTH_FAILED method=manual_login reason=${result.exceptionOrNull()?.message}")
                clearStaleSession("manual_login_failed")
                Log.d(LOGIN_TAG, "SESSION_STATE_CHANGED state=unauthenticated source=manual_login_failed")
                _uiState.value = LoginUiState.Error(
                    result.exceptionOrNull()?.message ?: "Login failed"
                )
            }
            logFormState("manual_login_completed")
        }
    }

    fun clearError() {
        if (_uiState.value is LoginUiState.Error) {
            _uiState.value = LoginUiState.Idle
            logFormState("error_cleared")
        }
    }

    fun onManualInputChanged(field: String, value: String) {
        Log.d(LOGIN_TAG, "LOGIN_INPUT_CHANGED field=$field length=${value.length}")
        if (!_manualInputDetected.value) {
            _manualInputDetected.value = true
        }
        logFormState("manual_input")
    }

    private fun saveUserPrefs(user: User) {
        app.sessionPrefs.userId = user.id
        app.sessionPrefs.username = user.username
        app.sessionPrefs.unitId = user.unitId
        app.sessionPrefs.userRole = user.role
    }

    private fun clearStaleSession(reason: String) {
        app.sessionPrefs.clear()
        app.apiClient.cookieJar.clear()
        Log.w(LOGIN_TAG, "SESSION_STATE_CHANGED state=cleared reason=$reason")
    }

    private fun logFormState(source: String) {
        Log.d(
            LOGIN_TAG,
            "LOGIN_FORM_STATE source=$source uiState=${_uiState.value::class.simpleName} manualInputDetected=${_manualInputDetected.value}"
        )
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
