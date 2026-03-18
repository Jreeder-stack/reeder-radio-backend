package com.reedersystems.commandcomms.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class PttHardwareReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        Log.d("[PTT-DIAG]", "PttHardwareReceiver: $action")

        val serviceIntent = Intent(context, BackgroundAudioService::class.java)
        when (action) {
            ACTION_PTT_DOWN -> {
                serviceIntent.action = BackgroundAudioService.ACTION_PTT_DOWN
                context.startForegroundService(serviceIntent)
            }
            ACTION_PTT_UP -> {
                serviceIntent.action = BackgroundAudioService.ACTION_PTT_UP
                context.startForegroundService(serviceIntent)
            }
        }
    }

    companion object {
        const val ACTION_PTT_DOWN = "com.reedersystems.commandcomms.PTT_DOWN"
        const val ACTION_PTT_UP = "com.reedersystems.commandcomms.PTT_UP"
    }
}
