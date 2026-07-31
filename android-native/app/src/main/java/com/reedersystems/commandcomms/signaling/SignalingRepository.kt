package com.reedersystems.commandcomms.signaling

import com.reedersystems.commandcomms.audio.radio.PttGrantGuard
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.filter

class SignalingRepository(private val client: SignalingClient) {

    val connectionState: StateFlow<ConnectionState> = client.connectionState

    /**
     * Only pass a floor grant to the radio audio service when this physical
     * device recently issued the matching floor request. This prevents a CAD
     * console or sibling radio using the same callsign from keying this radio.
     */
    val events: Flow<SignalingEvent> = client.events.filter { event ->
        when (event) {
            is SignalingEvent.RadioPttGranted ->
                PttGrantGuard.consumeGrant(event.channelId)
            is SignalingEvent.RadioPttDenied -> {
                PttGrantGuard.clear("floor_denied")
                true
            }
            else -> true
        }
    }

    fun connect(unitId: String, username: String) = client.connect(unitId, username)

    fun disconnect() {
        PttGrantGuard.clear("signaling_disconnect")
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
