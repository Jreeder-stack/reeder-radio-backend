package com.reedersystems.commandcomms.audio.led

import android.content.Context
import android.util.Log
import com.reedersystems.commandcomms.audio.radio.RadioStateManager

/**
 * T320 build: LED is driven by NotificationChannel lights configured in
 * `CommandCommsApp.createNotificationChannels`. No additional broadcast
 * driver is needed — this implementation is intentionally a no-op so the
 * verified T320 LED behavior is unchanged.
 */
object RadioFlavorLed : RadioFlavorLedDriver {
    private const val TAG = "[RadioLED-T320]"

    override fun start(context: Context, stateManager: RadioStateManager) {
        Log.d(TAG, "T320 RadioFlavorLed: no-op (LED driven by NotificationChannels)")
    }
}
