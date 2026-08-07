package com.reedersystems.commandcomms.ui.radio

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.ui.sd7.Sd7OledController
import com.reedersystems.commandcomms.ui.sd7.Sd7RadioStatusScreen

/**
 * SD7 flavor entry point.
 *
 * In addition to the Compose debug surface, this drives the SD7's real
 * 128x64 top OLED through the vendor `smallcd` system service. The physical
 * OLED renderer is SD7-flavor-only and therefore cannot affect T320 or phone
 * builds.
 */
@Composable
fun RadioFlavorScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?
) {
    val radioViewModel: RadioViewModel = viewModel()
    val state by radioViewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val txActive = state.pttState == PttState.TRANSMITTING ||
        state.radioState == RadioState.TRANSMITTING
    val rxActive = state.radioState == RadioState.RECEIVING
    val oledStatus = when {
        state.myEmergencyActive -> "EMERGENCY"
        txActive -> "TX"
        rxActive -> "RX ${state.activeTransmittingUnit.orEmpty()}".trim()
        state.isChannelBusy -> "BUSY"
        else -> "IDLE"
    }

    LaunchedEffect(
        state.currentZone?.name,
        state.currentChannel?.name,
        state.unitId,
        oledStatus,
        state.batteryLevel
    ) {
        Sd7OledController.render(
            context = context,
            zoneName = state.currentZone?.name.orEmpty(),
            channelName = state.currentChannel?.name.orEmpty(),
            unitId = state.unitId,
            status = oledStatus,
            batteryPercent = state.batteryLevel
        )
    }

    Sd7RadioStatusScreen(
        onLocked = onLocked,
        onUnassigned = onUnassigned,
        onReassigned = onReassigned,
        onSettings = onSettings,
        assignedFromUnit = assignedFromUnit,
        viewModel = radioViewModel
    )
}
