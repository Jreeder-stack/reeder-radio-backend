/**
 * RadioSignalingGateway — Abstraction layer for signaling operations.
 *
 * Module boundary: This interface decouples ALL radio engine modules from the concrete
 * SignalingClient implementation. Radio engine modules (FloorControlManager, RadioAudioEngine,
 * etc.) depend ONLY on this interface, never on SignalingClient directly. The concrete
 * implementation will be provided by the integration task that wires the radio engine
 * into the existing app architecture.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

interface RadioSignalingGateway {

    fun requestFloor(channelId: String)

    fun releaseFloor(channelId: String)

    fun joinChannel(channelId: String)

    fun leaveChannel(channelId: String)

    fun registerListener(listener: Listener)

    fun unregisterListener(listener: Listener)

    interface Listener {
        fun onFloorGranted(channelId: String)
        fun onFloorDenied(channelId: String)
        fun onFloorBusy(channelId: String, transmittingUnit: String)
        fun onFloorIdle(channelId: String)
        fun onFloorReleased(channelId: String)
    }
}
