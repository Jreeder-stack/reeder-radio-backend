package com.reedersystems.commandcomms.signaling

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

class SignalingRepository(private val client: SignalingClient) {

    val connectionState: StateFlow<ConnectionState> = client.connectionState

    /**
     * SignalingClient validates device-targeted floor grants exactly once before
     * publishing them. Do not apply a second destructive grant guard here: this
     * flow has multiple collectors (UI, background audio, app-level observers),
     * and consuming a one-shot guard in a per-collector filter can cause the
     * first collector to steal a valid grant from the radio engine.
     */
    val events: Flow<SignalingEvent> = client.events

    fun connect(unitId: String, username: String) = client.connect(unitId, username)

    fun disconnect() {
        client.disconnect()
    }

    fun joinChannel(channelKey: String) = client.joinChannel(channelKey)
    fun leaveChannel(channelKey: String) = client.leaveChannel(channelKey)
    fun joinRadioChannel(channelKey: String, udpPort: Int? = null, udpAddress: String? = null) =
        client.emitRadioJoinChannel(channelKey, udpPort, udpAddress)
    fun leaveRadioChannel(channelKey: String) = client.emitRadioLeaveChannel(channelKey)

    fun transmitPre(channelKey: String) = client.emitPttPre(channelKey)

    fun setStatus(status: String) = client.emitStatusUpdate(status)

    fun emergencyStart(channelKey: String) = client.emitEmergencyStart(channelKey)
    fun emergencyEnd(channelKey: String) = client.emitEmergencyEnd(channelKey)
    fun queryEmergencyStatus(channelKey: String) = client.queryEmergencyStatus(channelKey)

    fun sendLocationUpdate(lat: Double, lon: Double, accuracy: Float, heading: Float?, speed: Float?) =
        client.emitLocationUpdate(lat, lon, accuracy, heading, speed)
}
