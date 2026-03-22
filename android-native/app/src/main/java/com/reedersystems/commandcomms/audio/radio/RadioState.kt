package com.reedersystems.commandcomms.audio.radio

enum class RadioState {
    IDLE,
    REQUESTING_FLOOR,
    TRANSMITTING,
    RECEIVING,
    CHANNEL_BUSY
}
