package com.reedersystems.commandcomms.ota

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

class T320OtaBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != "android.intent.action.QUICKBOOT_POWERON" &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED
        ) return
        Log.d("[T320-OTA]", "Starting OTA service after $action")
        val service = Intent(context, T320OtaService::class.java).apply {
            this.action = T320OtaService.ACTION_CHECK_NOW
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(service)
        else context.startService(service)
    }
}
