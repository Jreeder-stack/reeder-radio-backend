package com.reedersystems.commandcomms.ui.radio

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.data.model.PttState

/**
 * Compact keypad-first radio screen for HD760's non-touch 2-inch display.
 * Existing RadioViewModel and audio/floor/signaling services are shared.
 */
@Composable
fun RadioFlavorScreen(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?
) {
    val model: RadioViewModel = viewModel()
    val state by model.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current

    LaunchedEffect(state.isRadioLocked) {
        if (state.isRadioLocked) onLocked?.invoke()
    }
    LaunchedEffect(state.isRadioUnassigned) {
        if (state.isRadioUnassigned) {
            model.consumeRadioUnassigned()
            onUnassigned?.invoke()
        }
    }
    LaunchedEffect(state.reassignedUnitId) {
        state.reassignedUnitId?.let {
            model.consumeReassigned()
            onReassigned?.invoke(it)
        }
    }
    LifecycleResumeEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        model.setMicPermissionGranted(granted)
        onPauseOrDispose {}
    }

    val tx = state.pttState == PttState.TRANSMITTING ||
        state.radioState == RadioState.TRANSMITTING
    val rx = state.radioState == RadioState.RECEIVING
    val status = when {
        state.myEmergencyActive -> "EMERGENCY"
        tx -> "TRANSMITTING"
        rx -> "RECEIVING"
        state.isChannelBusy -> "CHANNEL BUSY"
        !state.isConnected -> "CONNECTING"
        else -> "STANDBY"
    }
    val accent = when {
        state.myEmergencyActive -> Color(0xFFFF6666)
        tx -> Color(0xFF6EE7B7)
        rx -> Color(0xFFFFC76A)
        else -> Color(0xFF9CCBFF)
    }
    Column(
        Modifier.fillMaxSize().background(Color(0xFF0F172A)).padding(6.dp),
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        Text("COMMAND COMMS", color = accent, fontWeight = FontWeight.Bold,
            fontSize = 13.sp, maxLines = 1)
        Text(state.currentZone?.name ?: "NO ZONE", color = Color.LightGray,
            fontSize = 12.sp, maxLines = 1)
        Text(state.currentChannel?.name ?: "NO CHANNEL", color = Color.White,
            fontWeight = FontWeight.Bold, fontSize = 23.sp, maxLines = 2)
        Text(status, color = accent, fontWeight = FontWeight.Bold,
            fontSize = 16.sp, maxLines = 1)
        if (rx && !state.activeTransmittingUnit.isNullOrBlank()) {
            Text("FROM: ${state.activeTransmittingUnit}", color = Color.White,
                fontSize = 11.sp, maxLines = 1)
        }
        if (state.error != null) {
            Text("ERROR: ${state.error}", color = Color(0xFFFF7777),
                fontSize = 10.sp, maxLines = 2)
        }
        Text(
            "${state.unitId.ifBlank { "UNASSIGNED" }} | ${if (state.isConnected) "ONLINE" else "OFFLINE"}",
            color = Color.LightGray, fontSize = 10.sp, maxLines = 1
        )
        Text("KNOB: CHANNEL   ◀▶: ZONE   ↑↓: CH", color = Color.LightGray,
            fontSize = 9.sp, maxLines = 1)
    }
}
