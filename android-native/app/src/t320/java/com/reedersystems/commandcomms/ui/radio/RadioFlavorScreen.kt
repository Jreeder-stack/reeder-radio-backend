package com.reedersystems.commandcomms.ui.radio

import android.content.Intent
import android.os.Build
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import com.reedersystems.commandcomms.ota.T320OtaService

/**
 * T320 flavor: render the existing full-color RadioScreen unchanged and start
 * the T320-only OTA service. SD7/phone/bridge source sets do not compile this
 * service and are unaffected.
 */
@Composable
fun RadioFlavorScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?
) {
    val context = LocalContext.current
    LaunchedEffect(Unit) {
        val intent = Intent(context, T320OtaService::class.java).apply {
            action = T320OtaService.ACTION_CHECK_NOW
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
    }

    RadioScreen(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit
    )
}
