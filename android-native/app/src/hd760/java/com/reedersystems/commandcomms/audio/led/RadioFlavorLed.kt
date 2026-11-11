package com.reedersystems.commandcomms.audio.led

import android.content.Context
import android.util.Log
import com.reedersystems.commandcomms.audio.radio.RadioStateManager

/** The HD760 has no verified OEM LED control API; do not emit guessed broadcasts. */
object RadioFlavorLed : RadioFlavorLedDriver {
    override fun start(context: Context, stateManager: RadioStateManager) {
        Log.i("[HD760]", "HD760 LED vendor API unverified; leaving hardware LED unchanged")
    }
}
