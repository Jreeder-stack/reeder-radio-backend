package com.reedersystems.commandcomms.data.model

data class RadioTransportConfig(
    val transportMode: String,
    val signalingUrl: String,
    val audioRelayHost: String,
    val audioRelayPort: Int,
    val useTls: Boolean
)
