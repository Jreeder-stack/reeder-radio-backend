package com.reedersystems.commandcomms.ui.radio

import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.audio.PhoneAudioRouteService

/**
 * Regular Android phone/tablet flavor.
 *
 * Uses the dedicated touch-first handset UI that mirrors the mobile browser
 * radio deck instead of the hardware-radio/T320 presentation.
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

    // Phone flavor only: keep normal handset communication routing alive even
    // when the screen is off/backgrounded. The dedicated radio flavors never
    // compile PhoneAudioRouteService and remain untouched.
    LaunchedEffect(Unit) {
        ContextCompat.startForegroundService(
            context,
            Intent(context, PhoneAudioRouteService::class.java)
        )
    }

    PhoneRadioScreen(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit
    )
}
