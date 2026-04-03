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

    @Volatile
    private var requestTimestampMs: Long = 0L

    fun requestFloor(channelKey: String) {
        requestTimestampMs = System.currentTimeMillis()
        val hasToken = pendingChannelKey != null
        Log.d(TAG, "requestFloor channelKey=$channelKey previousPending=$hasToken state=${stateManager.currentState} ${RadioDiagLog.elapsedTag()}")
        pendingChannelKey = channelKey
        cancelled = false
        stateManager.transitionTo(RadioState.REQUESTING_FLOOR, "floor_request")
        gateway.requestFloor(channelKey)
    }

    fun releaseFloor(channelKey: String) {
        Log.d(TAG, "releaseFloor channelKey=$channelKey state=${stateManager.currentState} ${RadioDiagLog.elapsedTag()}")
        pendingChannelKey = null
        cancelled = true
        gateway.releaseFloor(channelKey)
        stateManager.transitionTo(RadioState.IDLE, "floor_released")
        _events.tryEmit(FloorControlEvent.RELEASED)
    }

    fun cancelPending() {
        Log.d(TAG, "cancelPending (PTT released before grant) pendingChannel=$pendingChannelKey ${RadioDiagLog.elapsedTag()}")
        pendingChannelKey = null
        cancelled = true
    }

    fun onFloorGranted(channelKey: String? = null) {
        val latencyMs = if (requestTimestampMs > 0) System.currentTimeMillis() - requestTimestampMs else -1L
        if (stateManager.state.value == RadioState.TRANSMITTING) {
            Log.d(TAG, "Floor GRANTED but already TRANSMITTING — ignoring duplicate channelKey=$channelKey latency=${latencyMs}ms ${RadioDiagLog.elapsedTag()}")
            return
        }
        if (cancelled) {
            Log.d(TAG, "Floor GRANTED but PTT already released — ignoring channelKey=$channelKey latency=${latencyMs}ms ${RadioDiagLog.elapsedTag()}")
            if (channelKey != null) gateway.releaseFloor(channelKey)
            stateManager.transitionTo(RadioState.IDLE, "grant_after_cancel")
            return
        }
        if (channelKey != null && pendingChannelKey != null && channelKey != pendingChannelKey) {
            Log.w(TAG, "Floor GRANTED for wrong channel ($channelKey != $pendingChannelKey) — ignoring latency=${latencyMs}ms ${RadioDiagLog.elapsedTag()}")
            return
        }
        Log.d(TAG, "Floor GRANTED channelKey=${channelKey ?: pendingChannelKey} latencyMs=$latencyMs ${RadioDiagLog.elapsedTag()}")
        stateManager.transitionTo(RadioState.TRANSMITTING, "floor_granted")
        _events.tryEmit(FloorControlEvent.GRANTED)
    }

    fun onFloorDenied(channelKey: String? = null) {
        val latencyMs = if (requestTimestampMs > 0) System.currentTimeMillis() - requestTimestampMs else -1L
        if (channelKey != null && pendingChannelKey != null && channelKey != pendingChannelKey) {
            Log.w(TAG, "Floor DENIED for wrong channel ($channelKey != $pendingChannelKey) — ignoring latency=${latencyMs}ms ${RadioDiagLog.elapsedTag()}")
            return
        }
        Log.d(TAG, "Floor DENIED channelKey=${channelKey ?: pendingChannelKey} latencyMs=$latencyMs ${RadioDiagLog.elapsedTag()}")
        pendingChannelKey = null
        cancelled = true
        stateManager.transitionTo(RadioState.CHANNEL_BUSY, "floor_denied")
        _events.tryEmit(FloorControlEvent.DENIED)
    }

    fun onChannelBusy(transmittingUnitId: String) {
        Log.d(TAG, "Channel busy — transmitting unit: $transmittingUnitId state=${stateManager.currentState} ${RadioDiagLog.elapsedTag()}")
        stateManager.setTransmittingUnit(transmittingUnitId)
        if (stateManager.state.value != RadioState.TRANSMITTING) {
            stateManager.transitionTo(RadioState.RECEIVING, "channel_busy")
        }
    }

    fun onChannelIdle() {
        Log.d(TAG, "Channel idle state=${stateManager.currentState} ${RadioDiagLog.elapsedTag()}")
        stateManager.setTransmittingUnit(null)
        if (stateManager.state.value == RadioState.RECEIVING ||
            stateManager.state.value == RadioState.CHANNEL_BUSY) {
            stateManager.transitionTo(RadioState.IDLE, "channel_idle")
        }
    }
}
