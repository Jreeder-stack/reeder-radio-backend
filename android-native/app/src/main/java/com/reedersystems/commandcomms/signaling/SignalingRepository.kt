package com.reedersystems.commandcomms.signaling

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

class SignalingRepository(private val client: SignalingClient) {

    val connectionState: StateFlow<ConnectionState> = client.connectionState
    val events: SharedFlow<SignalingEvent> = client.events

    fun connect(unitId: String, username: String) = client.connect(unitId, username)
    fun disconnect() = client.disconnect()

    fun joinChannel(channelKey: String) = client.joinChannel(channelKey)
    fun leaveChannel(channelKey: String) = client.leaveChannel(channelKey)

    fun transmitPre(channelKey: String) = client.emitPttPre(channelKey)
    fun transmitStart(channelKey: String) = client.emitPttStart(channelKey)
    fun transmitEnd(channelKey: String) = client.emitPttEnd(channelKey)

    fun setStatus(status: String) = client.emitStatusUpdate(status)

    fun emergencyStart(channelKey: String) = client.emitEmergencyStart(channelKey)
    fun emergencyEnd(channelKey: String) = client.emitEmergencyEnd(channelKey)

    fun sendLocationUpdate(lat: Double, lon: Double, accuracy: Float, heading: Float?, speed: Float?) =
        client.emitLocationUpdate(lat, lon, accuracy, heading, speed)
}
