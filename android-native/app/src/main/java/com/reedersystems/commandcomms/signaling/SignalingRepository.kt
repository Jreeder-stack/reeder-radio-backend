package com.reedersystems.commandcomms.signaling

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

class SignalingRepository(private val client: SignalingClient) {

    val connectionState: StateFlow<ConnectionState> = client.connectionState
    val events: SharedFlow<SignalingEvent> = client.events

    fun connect(unitId: String, username: String) = client.connect(unitId, username)
    fun disconnect() = client.disconnect()

    fun joinChannel(channelId: Int) = client.joinChannel(channelId)
    fun leaveChannel(channelId: Int) = client.leaveChannel(channelId)

    fun transmitPre(channelId: Int) = client.emitPttPre(channelId)
    fun transmitStart(channelId: Int) = client.emitPttStart(channelId)
    fun transmitEnd(channelId: Int) = client.emitPttEnd(channelId)

    fun setStatus(status: String) = client.emitStatusUpdate(status)

    fun emergencyStart(channelId: Int) = client.emitEmergencyStart(channelId)
    fun emergencyEnd(channelId: Int) = client.emitEmergencyEnd(channelId)

    fun sendLocationUpdate(lat: Double, lon: Double, accuracy: Float, heading: Float?, speed: Float?) =
        client.emitLocationUpdate(lat, lon, accuracy, heading, speed)
}
