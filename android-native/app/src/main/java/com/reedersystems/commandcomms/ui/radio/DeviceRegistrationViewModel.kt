package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.gson.JsonObject
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.device.DeviceIdentity
import com.reedersystems.commandcomms.device.readDeviceIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private const val TAG = "[DeviceReg]"

sealed class RegistrationUiState {
    object Idle : RegistrationUiState()
    object Loading : RegistrationUiState()
    data class Error(val message: String) : RegistrationUiState()
    object Success : RegistrationUiState()
}

class DeviceRegistrationViewModel(application: Application) : AndroidViewModel(application) {

    private val app get() = getApplication<CommandCommsApp>()

    private val _uiState = MutableStateFlow<RegistrationUiState>(RegistrationUiState.Idle)
    val uiState: StateFlow<RegistrationUiState> = _uiState.asStateFlow()

    private val _deviceIdentity = MutableStateFlow<DeviceIdentity?>(null)
    val deviceIdentity: StateFlow<DeviceIdentity?> = _deviceIdentity.asStateFlow()

    init {
        viewModelScope.launch(Dispatchers.IO) {
            val identity = readDeviceIdentity(application)
            _deviceIdentity.value = identity
            Log.d(TAG, "DeviceIdentity read: serialPresent=${identity.serial != null} imeiPresent=${identity.imei != null}")
        }
    }

    fun register(serial: String, imei: String) {
        val serialTrimmed = serial.trim()
        val imeiTrimmed = imei.trim()

        if (serialTrimmed.isBlank() || imeiTrimmed.isBlank()) {
            _uiState.value = RegistrationUiState.Error("Serial number and IMEI are required")
            return
        }

        viewModelScope.launch {
            _uiState.value = RegistrationUiState.Loading
            Log.d(TAG, "Registering device serialLen=${serialTrimmed.length} imeiLen=${imeiTrimmed.length}")
            val result = doRegister(serialTrimmed, imeiTrimmed)
            if (result.isSuccess) {
                val (radioId, token) = result.getOrThrow()
                app.radioTokenStore.saveToken(radioId, token)
                app.signalingClient.setRadioToken(token)
                app.apiClient.radioToken = token
                Log.d(TAG, "Registration success radioId=$radioId")
                _uiState.value = RegistrationUiState.Success
            } else {
                val msg = result.exceptionOrNull()?.message ?: "Registration failed"
                Log.e(TAG, "Registration failed: $msg")
                _uiState.value = RegistrationUiState.Error(msg)
            }
        }
    }

    private suspend fun doRegister(serial: String, imei: String): Result<Pair<String, String>> =
        withContext(Dispatchers.IO) {
            try {
                val jsonMediaType = "application/json; charset=utf-8".toMediaType()
                val bodyJson = app.apiClient.gson.toJson(
                    mapOf("serial" to serial, "imei" to imei)
                )
                val request = Request.Builder()
                    .url("${app.apiClient.baseUrl}/api/radios/register")
                    .post(bodyJson.toRequestBody(jsonMediaType))
                    .build()
                val response = app.apiClient.httpClient.newCall(request).execute()
                val body = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val errorMsg = runCatching {
                        app.apiClient.gson.fromJson(body, JsonObject::class.java)
                            ?.get("error")?.asString
                    }.getOrNull() ?: when (response.code) {
                        409 -> "This serial number is already registered"
                        else -> "Server error (${response.code})"
                    }
                    return@withContext Result.failure(Exception(errorMsg))
                }
                val obj = app.apiClient.gson.fromJson(body, JsonObject::class.java)
                val radioId = obj.get("radioId")?.asString
                    ?: return@withContext Result.failure(Exception("Invalid server response"))
                val token = obj.get("token")?.asString
                    ?: return@withContext Result.failure(Exception("Invalid server response"))
                Result.success(Pair(radioId, token))
            } catch (e: Exception) {
                val msg = if (e.message?.contains("Unable to resolve host") == true ||
                    e.message?.contains("failed to connect") == true ||
                    e.message?.contains("timeout", ignoreCase = true) == true
                ) {
                    "Could not connect to server — check network"
                } else {
                    e.message ?: "Registration failed"
                }
                Result.failure(Exception(msg))
            }
        }

    fun clearError() {
        if (_uiState.value is RegistrationUiState.Error) {
            _uiState.value = RegistrationUiState.Idle
        }
    }
}
