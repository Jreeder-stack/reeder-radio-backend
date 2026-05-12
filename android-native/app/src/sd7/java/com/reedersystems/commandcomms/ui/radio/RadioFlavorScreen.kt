package com.reedersystems.commandcomms.ui.radio

import androidx.compose.runtime.Composable
import com.reedersystems.commandcomms.ui.sd7.Sd7RadioStatusScreen

/**
 * SD7 flavor: render the OLED-friendly Sd7RadioStatusScreen instead of the
 * full color touch RadioScreen. The signature mirrors the T320 flavor's
 * RadioFlavorScreen so AppNavigation in `src/main/` doesn't need a flavor
 * branch.
 *
 * NOTE: The visual design of the 128×64 OLED UI is intentionally minimal in
 * this task and meant to be iterated on in a follow-up (see task brief
 * "Out of scope"). It exposes everything dispatchers need for hardware
 * validation: current channel/zone, TX/RX state, signal/battery, last
 * talker, and an alert overlay for incoming pages and emergencies.
 */
@Composable
fun RadioFlavorScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?
) {
    Sd7RadioStatusScreen(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit
    )
}
