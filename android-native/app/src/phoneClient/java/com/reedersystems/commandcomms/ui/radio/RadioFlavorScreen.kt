package com.reedersystems.commandcomms.ui.radio

import androidx.compose.runtime.Composable

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
    PhoneRadioScreen(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit
    )
}
