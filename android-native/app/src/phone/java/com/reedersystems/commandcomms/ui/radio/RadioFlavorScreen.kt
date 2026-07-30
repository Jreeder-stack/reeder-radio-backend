package com.reedersystems.commandcomms.ui.radio

import androidx.compose.runtime.Composable

/**
 * Phone/tablet flavor: dedicated bridge dashboard with touch channel controls.
 * T320 and SD7 continue using their own unchanged flavor implementations.
 */
@Composable
fun RadioFlavorScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?
) {
    PhoneBridgeDashboard(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit
    )
}
