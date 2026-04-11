package com.reedersystems.commandcomms.signaling

sealed class SignalingEvent {
    data class PttPre(val unitId: String, val channelId: String) : SignalingEvent()
    data class PttStart(val unitId: String, val channelId: String) : SignalingEvent()
    data class PttEnd(val unitId: String, val channelId: String) : SignalingEvent()
    data class UnitJoined(val unitId: String, val channelId: String) : SignalingEvent()
    data class UnitLeft(val unitId: String, val channelId: String) : SignalingEvent()
    data class EmergencyStart(val unitId: String, val channelId: String) : SignalingEvent()
    data class EmergencyEnd(val unitId: String, val channelId: String) : SignalingEvent()
    data class ClearAirStart(val channelId: String) : SignalingEvent()
    data class ClearAirEnd(val channelId: String) : SignalingEvent()
    data class PttBusy(val channelId: String, val transmittingUnit: String) : SignalingEvent()
    data class LocationTrackStart(val requestedBy: String, val emergency: Boolean) : SignalingEvent()
    object LocationTrackStop : SignalingEvent()
    data class UnitStatusChanged(val unitId: String, val status: String) : SignalingEvent()

    data class RadioChannelJoined(val channelId: String) : SignalingEvent()
    data class RadioPttGranted(val channelId: String, val senderUnitId: String) : SignalingEvent()
    data class RadioPttDenied(val channelId: String, val reason: String, val heldBy: String) : SignalingEvent()
    data class RadioTxStart(val senderUnitId: String, val channelId: String) : SignalingEvent()
    data class RadioTxStop(val senderUnitId: String, val channelId: String) : SignalingEvent()
    data class RadioChannelBusy(val channelId: String, val heldBy: String) : SignalingEvent()
    data class RadioChannelIdle(val channelId: String) : SignalingEvent()
    data class RadioDspConfig(val config: org.json.JSONObject) : SignalingEvent()
    data class TxSilenceWarning(val unitId: String, val channelId: String, val silenceMs: Long) : SignalingEvent()
    object RadioLocked : SignalingEvent()
    object RadioUnlocked : SignalingEvent()
}
