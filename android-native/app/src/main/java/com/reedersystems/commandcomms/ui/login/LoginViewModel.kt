package com.reedersystems.commandcomms.ui.login

import android.app.Application
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

    private val app get() = getApplication<CommandCommsApp>()

    private val _uiState = MutableStateFlow<LoginUiState>(LoginUiState.CheckingSession)
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    init {
        checkExistingSession()
    }

    private fun checkExistingSession() {
        viewModelScope.launch {
            _uiState.value = LoginUiState.CheckingSession
            val result = app.authRepository.me()
            if (result.isSuccess) {
                val user = result.getOrThrow()
                saveUserPrefs(user)
                _uiState.value = LoginUiState.Success(user)
            } else {
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
            val result = app.authRepository.login(username.trim(), password)
            if (result.isSuccess) {
                val user = result.getOrThrow()
                saveUserPrefs(user)
                _uiState.value = LoginUiState.Success(user)
            } else {
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
}
