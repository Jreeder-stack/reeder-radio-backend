package com.reedersystems.commandcomms.audio.bridge

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class UhfBridgeDirection {
    OFF,
    STARTING,
    IDLE,
    RF_TO_POC,
    POC_TO_RF,
    LOCKOUT,
    ERROR
}

data class UhfBridgeStatus(
    val running: Boolean = false,
    val direction: UhfBridgeDirection = UhfBridgeDirection.OFF,
    val inputDb: Float = -90f,
    val wiredInput: Boolean = false,
    val wiredOutput: Boolean = false,
    val signalingReady: Boolean = false,
    val channelJoined: Boolean = false,
    val message: String = "Bridge off"
)

object UhfBridgeRuntime {
    private val _status = MutableStateFlow(UhfBridgeStatus())
    val status: StateFlow<UhfBridgeStatus> = _status.asStateFlow()

    fun update(transform: (UhfBridgeStatus) -> UhfBridgeStatus) {
        _status.value = transform(_status.value)
    }

    fun set(status: UhfBridgeStatus) {
        _status.value = status
    }

    fun reset() {
        _status.value = UhfBridgeStatus()
    }
}
