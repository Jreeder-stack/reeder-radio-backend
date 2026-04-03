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

    @Volatile
    var activeChannelKey: String? = null

    @Volatile
    var txPipelineRunning: Boolean = false

    @Volatile
    var rxPipelineRunning: Boolean = false

    fun transitionTo(newState: RadioState, reason: String = "") {
        val old = _state.value
        if (old == newState) return
        _state.value = newState
        Log.d(TAG, "State transition: $old -> $newState reason=${reason.ifEmpty { "direct" }} activeChannel=${activeChannelKey ?: "none"} txPipeline=$txPipelineRunning rxPipeline=$rxPipelineRunning ${RadioDiagLog.elapsedTag()}")
    }

    fun setTransmittingUnit(unitId: String?) {
        _transmittingUnitId.value = unitId
    }

    fun isTransmitting(): Boolean = _state.value == RadioState.TRANSMITTING

    fun isReceiving(): Boolean = _state.value == RadioState.RECEIVING

    fun isIdle(): Boolean = _state.value == RadioState.IDLE

    fun reset() {
        val old = _state.value
        _state.value = RadioState.IDLE
        _transmittingUnitId.value = null
        txPipelineRunning = false
        rxPipelineRunning = false
        Log.d(TAG, "State RESET: $old -> IDLE activeChannel=${activeChannelKey ?: "none"}")
    }
}
