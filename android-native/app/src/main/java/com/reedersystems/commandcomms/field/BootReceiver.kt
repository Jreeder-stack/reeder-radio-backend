package com.reedersystems.commandcomms.field

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs

class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON"
        ) return

        Log.d("[PTT-DIAG]", "BootReceiver: device booted, checking session prefs")
        val prefs = ServiceConnectionPrefs(context)
        if (prefs.isValid()) {
            Log.d("[PTT-DIAG]", "BootReceiver: valid session found, starting service")
            val serviceIntent = Intent(context, BackgroundAudioService::class.java)
            context.startForegroundService(serviceIntent)
        }
    }
}
