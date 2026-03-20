package com.reedersystems.commandcomms.signaling

sealed class SignalingEvent {
    data class PttPre(val unitId: String, val channelId: Int) : SignalingEvent()
    data class PttStart(val unitId: String, val channelId: Int) : SignalingEvent()
    data class PttEnd(val unitId: String, val channelId: Int) : SignalingEvent()
    data class UnitJoined(val unitId: String, val channelId: Int) : SignalingEvent()
    data class UnitLeft(val unitId: String, val channelId: Int) : SignalingEvent()
    data class EmergencyStart(val unitId: String, val channelId: Int) : SignalingEvent()
    data class EmergencyEnd(val unitId: String, val channelId: Int) : SignalingEvent()
    data class ClearAirStart(val channelId: Int) : SignalingEvent()
    data class ClearAirEnd(val channelId: Int) : SignalingEvent()
    data class PttBusy(val channelId: Int, val transmittingUnit: String) : SignalingEvent()
    data class LocationTrackStart(val requestedBy: String, val emergency: Boolean) : SignalingEvent()
    object LocationTrackStop : SignalingEvent()
    data class UnitStatusChanged(val unitId: String, val status: String) : SignalingEvent()
}
