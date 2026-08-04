package com.reedersystems.commandcomms.audio.led

import android.content.Context
import android.util.Log
import com.reedersystems.commandcomms.audio.radio.RadioStateManager

/** Regular Android phones do not expose a dedicated radio status LED. */
object RadioFlavorLed : RadioFlavorLedDriver {
    private const val TAG = "[RadioLED-PHONE]"

    override fun start(context: Context, stateManager: RadioStateManager) {
        Log.d(TAG, "Normal phone build: no dedicated hardware LED")
    }
}
