package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.model.Zone
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class RadioUiState(
    val username: String = "",
    val unitId: String = "",
    val zones: List<Zone> = emptyList(),
    val currentZoneIndex: Int = 0,
    val currentChannelIndex: Int = 0,
    val isLoading: Boolean = true,
    val error: String? = null
) {
    val currentZone: Zone? get() = zones.getOrNull(currentZoneIndex)
    val currentChannel: Channel? get() = currentZone?.channels?.getOrNull(currentChannelIndex)
}

class RadioViewModel(application: Application) : AndroidViewModel(application) {

    private val app get() = getApplication<CommandCommsApp>()

    private val _uiState = MutableStateFlow(RadioUiState())
    val uiState: StateFlow<RadioUiState> = _uiState.asStateFlow()

    init {
        val prefs = app.sessionPrefs
        _uiState.value = _uiState.value.copy(
            username = prefs.username ?: "",
            unitId = prefs.unitId ?: prefs.username ?: ""
        )
        loadChannels()
    }

    private fun loadChannels() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            val result = app.channelRepository.getZones()
            if (result.isSuccess) {
                val zones = result.getOrThrow()
                _uiState.value = _uiState.value.copy(
                    zones = zones,
                    isLoading = false,
                    currentZoneIndex = 0,
                    currentChannelIndex = 0
                )
            } else {
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = result.exceptionOrNull()?.message ?: "Failed to load channels"
                )
            }
        }
    }

    fun nextZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val next = (_uiState.value.currentZoneIndex + 1) % zones.size
        _uiState.value = _uiState.value.copy(currentZoneIndex = next, currentChannelIndex = 0)
    }

    fun prevZone() {
        val zones = _uiState.value.zones
        if (zones.isEmpty()) return
        val prev = (_uiState.value.currentZoneIndex - 1 + zones.size) % zones.size
        _uiState.value = _uiState.value.copy(currentZoneIndex = prev, currentChannelIndex = 0)
    }

    fun nextChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val next = (_uiState.value.currentChannelIndex + 1) % channels.size
        _uiState.value = _uiState.value.copy(currentChannelIndex = next)
    }

    fun prevChannel() {
        val channels = _uiState.value.currentZone?.channels ?: return
        if (channels.isEmpty()) return
        val prev = (_uiState.value.currentChannelIndex - 1 + channels.size) % channels.size
        _uiState.value = _uiState.value.copy(currentChannelIndex = prev)
    }

    fun logout(onComplete: () -> Unit) {
        viewModelScope.launch {
            app.authRepository.logout()
            app.sessionPrefs.clear()
            onComplete()
        }
    }
}
