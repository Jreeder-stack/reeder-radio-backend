package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

private const val TAG = "[FloorCtrl]"

enum class FloorControlEvent {
    GRANTED,
    DENIED,
    RELEASED
}

class FloorControlManager(
    private val gateway: RadioSignalingGateway,
    private val stateManager: RadioStateManager
) {

    private val _events = MutableSharedFlow<FloorControlEvent>(extraBufferCapacity = 16)
    val events: SharedFlow<FloorControlEvent> = _events.asSharedFlow()

    @Volatile
    var pendingChannelKey: String? = null
        private set

    @Volatile
    var cancelled = false
        private set

    fun requestFloor(channelKey: String) {
        Log.d(TAG, "requestFloor channelKey=$channelKey")
        pendingChannelKey = channelKey
        cancelled = false
        stateManager.transitionTo(RadioState.REQUESTING_FLOOR)
        gateway.requestFloor(channelKey)
    }

    fun releaseFloor(channelKey: String) {
        Log.d(TAG, "releaseFloor channelKey=$channelKey")
        pendingChannelKey = null
        cancelled = true
        gateway.releaseFloor(channelKey)
        stateManager.transitionTo(RadioState.IDLE)
        _events.tryEmit(FloorControlEvent.RELEASED)
    }

    fun cancelPending() {
        Log.d(TAG, "cancelPending (PTT released before grant)")
        pendingChannelKey = null
        cancelled = true
    }

    fun onFloorGranted(channelKey: String? = null) {
        if (cancelled) {
            Log.d(TAG, "Floor GRANTED but PTT already released — ignoring")
            if (channelKey != null) gateway.releaseFloor(channelKey)
            stateManager.transitionTo(RadioState.IDLE)
            return
        }
        if (channelKey != null && pendingChannelKey != null && channelKey != pendingChannelKey) {
            Log.w(TAG, "Floor GRANTED for wrong channel ($channelKey != $pendingChannelKey) — ignoring")
            return
        }
        Log.d(TAG, "Floor GRANTED")
        stateManager.transitionTo(RadioState.TRANSMITTING)
        _events.tryEmit(FloorControlEvent.GRANTED)
    }

    fun onFloorDenied(channelKey: String? = null) {
        if (channelKey != null && pendingChannelKey != null && channelKey != pendingChannelKey) {
            Log.w(TAG, "Floor DENIED for wrong channel ($channelKey != $pendingChannelKey) — ignoring")
            return
        }
        Log.d(TAG, "Floor DENIED")
        pendingChannelKey = null
        cancelled = true
        stateManager.transitionTo(RadioState.CHANNEL_BUSY)
        _events.tryEmit(FloorControlEvent.DENIED)
    }

    fun onChannelBusy(transmittingUnitId: String) {
        Log.d(TAG, "Channel busy — transmitting unit: $transmittingUnitId")
        stateManager.setTransmittingUnit(transmittingUnitId)
        if (stateManager.state.value != RadioState.TRANSMITTING) {
            stateManager.transitionTo(RadioState.RECEIVING)
        }
    }

    fun onChannelIdle() {
        Log.d(TAG, "Channel idle")
        stateManager.setTransmittingUnit(null)
        if (stateManager.state.value == RadioState.RECEIVING ||
            stateManager.state.value == RadioState.CHANNEL_BUSY) {
            stateManager.transitionTo(RadioState.IDLE)
        }
    }
}
