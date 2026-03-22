package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

private const val TAG = "[RadioState]"

class RadioStateManager {

    private val _state = MutableStateFlow(RadioState.IDLE)
    val state: StateFlow<RadioState> = _state.asStateFlow()

    private val _transmittingUnitId = MutableStateFlow<String?>(null)
    val transmittingUnitId: StateFlow<String?> = _transmittingUnitId.asStateFlow()

    val currentState: RadioState
        get() = _state.value

    fun transitionTo(newState: RadioState) {
        val old = _state.value
        if (old == newState) return
        _state.value = newState
        Log.d(TAG, "State transition: $old -> $newState")
    }

    fun setTransmittingUnit(unitId: String?) {
        _transmittingUnitId.value = unitId
    }

    fun isTransmitting(): Boolean = _state.value == RadioState.TRANSMITTING

    fun isReceiving(): Boolean = _state.value == RadioState.RECEIVING

    fun isIdle(): Boolean = _state.value == RadioState.IDLE

    fun reset() {
        _state.value = RadioState.IDLE
        _transmittingUnitId.value = null
    }
}
