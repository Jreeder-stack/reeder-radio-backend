package com.reedersystems.commandcomms.audio.led

import android.content.Context
import android.util.Log
import com.reedersystems.commandcomms.audio.radio.RadioStateManager

/**
 * Phone/tablet build: ordinary Android handsets do not expose the dedicated
 * radio indicator LED hardware used by the specialized device flavors.
 */
object RadioFlavorLed : RadioFlavorLedDriver {
    private const val TAG = "[RadioLED-PHONE]"

    override fun start(context: Context, stateManager: RadioStateManager) {
        Log.d(TAG, "Phone RadioFlavorLed: no dedicated hardware LED")
    }
}
