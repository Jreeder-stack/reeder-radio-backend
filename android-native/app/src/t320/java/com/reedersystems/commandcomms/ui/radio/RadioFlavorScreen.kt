package com.reedersystems.commandcomms.ui.radio

import androidx.compose.runtime.Composable

/**
 * T320 flavor: render the existing full-color, touch-friendly RadioScreen
 * unchanged. The same callable signature is provided by the SD7 source set
 * so AppNavigation in `src/main/` can stay flavor-agnostic.
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
