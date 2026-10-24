package com.reedersystems.commandcomms.audio.led

import android.content.Context
import android.util.Log
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.audio.radio.RadioStateManager
import com.reedersystems.commandcomms.audio.scan.T320ScanAudioController

/**
 * T320 build: LED is driven by NotificationChannel lights configured in
 * `CommandCommsApp.createNotificationChannels`. The flavor hook also owns the
 * T320-only scan receiver so scan can monitor multiple authorized channels
 * without changing the shared SD7/phone audio path.
 */
object RadioFlavorLed : RadioFlavorLedDriver {
    private const val TAG = "[RadioLED-T320]"

    @Volatile
    private var scanController: T320ScanAudioController? = null

    override fun start(context: Context, stateManager: RadioStateManager) {
        Log.d(TAG, "T320 RadioFlavorLed: LED driven by NotificationChannels")
        if (scanController != null) return

        val app = context.applicationContext as? CommandCommsApp
        if (app == null) {
            Log.w(TAG, "Unable to start T320 scan controller: unexpected application context")
            return
        }

        synchronized(this) {
            if (scanController == null) {
                scanController = T320ScanAudioController(app).also { it.start() }
                Log.d(TAG, "T320 scan controller initialized")
            }
        }
    }
}
