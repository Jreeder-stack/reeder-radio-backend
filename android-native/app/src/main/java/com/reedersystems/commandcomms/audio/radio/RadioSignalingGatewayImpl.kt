package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import com.reedersystems.commandcomms.signaling.SignalingClient

private const val TAG = "[RadioSigGW]"

class RadioSignalingGatewayImpl(
    private val signalingClient: SignalingClient
) : RadioSignalingGateway {

    override fun requestFloor(channelKey: String) {
        Log.d(TAG, "requestFloor channelKey=$channelKey signalingReady=${signalingClient.connectionState.value} ${RadioDiagLog.elapsedTag()}")
        signalingClient.emitRadioPttRequest(channelKey)
    }

    override fun releaseFloor(channelKey: String) {
        Log.d(TAG, "releaseFloor channelKey=$channelKey ${RadioDiagLog.elapsedTag()}")
        signalingClient.emitRadioPttRelease(channelKey)
    }

    override fun joinChannel(channelKey: String) {
        Log.d(TAG, "joinChannel channelKey=$channelKey ${RadioDiagLog.elapsedTag()}")
        signalingClient.emitRadioJoinChannel(channelKey)
    }

    override fun leaveChannel(channelKey: String) {
        Log.d(TAG, "leaveChannel channelKey=$channelKey ${RadioDiagLog.elapsedTag()}")
        signalingClient.emitRadioLeaveChannel(channelKey)
    }

    override fun notifyTxStart(channelKey: String) {
        Log.d(TAG, "notifyTxStart channelKey=$channelKey ${RadioDiagLog.elapsedTag()}")
        signalingClient.emitRadioTxStart(channelKey)
    }

    override fun notifyTxStop(channelKey: String) {
        Log.d(TAG, "notifyTxStop channelKey=$channelKey ${RadioDiagLog.elapsedTag()}")
        signalingClient.emitRadioTxStop(channelKey)
    }
}
