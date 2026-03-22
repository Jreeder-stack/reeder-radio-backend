package com.reedersystems.commandcomms.audio.radio

interface RadioSignalingGateway {
    fun requestFloor(channelKey: String)
    fun releaseFloor(channelKey: String)
    fun joinChannel(channelKey: String)
    fun leaveChannel(channelKey: String)
    fun notifyTxStart(channelKey: String)
    fun notifyTxStop(channelKey: String)
}
