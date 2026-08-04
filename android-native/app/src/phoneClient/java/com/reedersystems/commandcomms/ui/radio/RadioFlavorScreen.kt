package com.reedersystems.commandcomms.ui.radio

import androidx.compose.runtime.Composable

/**
 * Regular Android phone/tablet flavor.
 *
 * Uses the normal touch-friendly Command Comms PTT screen without the T320,
 * SD7, kiosk-radio, or UHF bridge presentation layers.
 */
@Composable
fun RadioFlavorScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?
) {
    RadioScreen(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit
    )
}
