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

    private val _signalQuality = MutableStateFlow(SignalQuality.NONE)
    val signalQuality: StateFlow<SignalQuality> = _signalQuality.asStateFlow()

    fun updateSignalQuality(quality: SignalQuality) {
        if (_signalQuality.value != quality) {
            _signalQuality.value = quality
        }
    }

    @Volatile
    var transmittingUnitSetAtMs: Long = 0L
        private set

    @Volatile
    var stateSetAtMs: Long = 0L
        private set

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
        stateSetAtMs = System.currentTimeMillis()
        Log.d(TAG, "State transition: $old -> $newState reason=${reason.ifEmpty { "direct" }} activeChannel=${activeChannelKey ?: "none"} txPipeline=$txPipelineRunning rxPipeline=$rxPipelineRunning ${RadioDiagLog.elapsedTag()}")
    }

    fun setTransmittingUnit(unitId: String?) {
        _transmittingUnitId.value = unitId
        transmittingUnitSetAtMs = if (unitId != null) System.currentTimeMillis() else 0L
    }

    fun isTransmitting(): Boolean = _state.value == RadioState.TRANSMITTING

    fun isReceiving(): Boolean = _state.value == RadioState.RECEIVING

    fun isIdle(): Boolean = _state.value == RadioState.IDLE

    fun reset() {
        val old = _state.value
        _state.value = RadioState.IDLE
        _transmittingUnitId.value = null
        transmittingUnitSetAtMs = 0L
        stateSetAtMs = System.currentTimeMillis()
        txPipelineRunning = false
        rxPipelineRunning = false
        _signalQuality.value = SignalQuality.NONE
        Log.d(TAG, "State RESET: $old -> IDLE activeChannel=${activeChannelKey ?: "none"}")
    }
}
