/**
 * FloorControlManager — Manages the PTT floor request/grant/deny/busy state machine.
 *
 * Module boundary: This class depends ONLY on RadioSignalingGateway and RadioStateManager.
 * It never references SignalingClient or any other concrete signaling implementation.
 * It sends floor requests via the gateway and listens for granted/denied/busy/idle
 * callbacks, emitting state transitions to RadioStateManager accordingly.
 *
 * Engine-level observers can register via [registerEngineListener] to receive callbacks
 * when the floor state changes (e.g., to start/stop audio capture on grant/release).
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class FloorState {
    IDLE,
    REQUESTING,
    GRANTED,
    DENIED,
    BUSY
}

interface FloorControlListener {
    fun onGranted(channelId: String)
    fun onDenied(channelId: String)
    fun onBusy(channelId: String, transmittingUnit: String)
    fun onReleased(channelId: String)
}

class FloorControlManager(
    private val gateway: RadioSignalingGateway,
    private val stateManager: RadioStateManager
) : RadioSignalingGateway.Listener {

    private val _floorState = MutableStateFlow(FloorState.IDLE)
    val floorState: StateFlow<FloorState> = _floorState.asStateFlow()

    private var activeChannelId: String? = null
    private val engineListeners = mutableListOf<FloorControlListener>()

    fun start() {
        gateway.registerListener(this)
    }

    fun stop() {
        gateway.unregisterListener(this)
        _floorState.value = FloorState.IDLE
        activeChannelId = null
    }

    fun registerEngineListener(listener: FloorControlListener) {
        if (!engineListeners.contains(listener)) {
            engineListeners.add(listener)
        }
    }

    fun unregisterEngineListener(listener: FloorControlListener) {
        engineListeners.remove(listener)
    }

    fun requestFloor(channelId: String) {
        if (_floorState.value == FloorState.REQUESTING || _floorState.value == FloorState.GRANTED) {
            return
        }
        activeChannelId = channelId
        _floorState.value = FloorState.REQUESTING
        stateManager.transitionTo(RadioState.REQUESTING_TX)
        gateway.requestFloor(channelId)
    }

    fun releaseFloor() {
        val channelId = activeChannelId ?: return
        _floorState.value = FloorState.IDLE
        gateway.releaseFloor(channelId)
        activeChannelId = null
    }

    override fun onFloorGranted(channelId: String) {
        if (channelId != activeChannelId) return
        _floorState.value = FloorState.GRANTED
        stateManager.transitionTo(RadioState.TRANSMITTING)
        engineListeners.forEach { it.onGranted(channelId) }
    }

    override fun onFloorDenied(channelId: String) {
        if (channelId != activeChannelId) return
        _floorState.value = FloorState.DENIED
        stateManager.transitionTo(RadioState.IDLE)
        activeChannelId = null
        engineListeners.forEach { it.onDenied(channelId) }
    }

    override fun onFloorBusy(channelId: String, transmittingUnit: String) {
        if (channelId != activeChannelId) return
        _floorState.value = FloorState.BUSY
        stateManager.transitionTo(RadioState.IDLE)
        engineListeners.forEach { it.onBusy(channelId, transmittingUnit) }
    }

    override fun onFloorIdle(channelId: String) {
        if (_floorState.value == FloorState.BUSY && channelId == activeChannelId) {
            _floorState.value = FloorState.IDLE
            stateManager.transitionTo(RadioState.IDLE)
            activeChannelId = null
        }
    }

    override fun onFloorReleased(channelId: String) {
        if (channelId == activeChannelId) {
            _floorState.value = FloorState.IDLE
            stateManager.transitionTo(RadioState.IDLE)
            activeChannelId = null
            engineListeners.forEach { it.onReleased(channelId) }
        }
    }
}
