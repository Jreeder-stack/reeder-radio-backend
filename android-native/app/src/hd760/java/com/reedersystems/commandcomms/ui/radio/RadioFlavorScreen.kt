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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.data.model.PttState

private val Ink = Color(0xFF17212E)
private val Muted = Color(0xFF556577)
private val Bottom = Color(0xFF172735)

/** Non-touch, T320-style radio hierarchy: zone, channel, active talker, status and scan. */
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
    val app = context.applicationContext as CommandCommsApp

    DisposableEffect(Unit) {
        app.hd760RadioScreenActive = true
        onDispose { app.hd760RadioScreenActive = false }
    }
    LaunchedEffect(state.hd760SettingsRequested) {
        if (state.hd760SettingsRequested) {
            model.consumeHd760SettingsRequest()
            onSettings?.invoke()
        }
    }
    LaunchedEffect(state.isRadioLocked) { if (state.isRadioLocked) onLocked?.invoke() }
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
        model.setMicPermissionGranted(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        )
        onPauseOrDispose {}
    }

    val tx = state.pttState == PttState.TRANSMITTING ||
        state.radioState == RadioState.TRANSMITTING
    val rx = state.radioState == RadioState.RECEIVING
    val emergency = state.myEmergencyActive
    val accent = when {
        emergency -> Color(0xFFB71C1C)
        tx -> Color(0xFF147D48)
        rx -> Color(0xFFC07806)
        else -> Color(0xFF17618F)
    }
    val status = when {
        emergency -> "EMERGENCY"
        state.emergencyArming -> "SOS ARMING: " + state.emergencyArmingSecondsRemaining
        tx -> "TRANSMITTING"
        rx -> "RECEIVING"
        state.isChannelBusy -> "CHANNEL BUSY"
        !state.isConnected -> "CONNECTING"
        else -> "STANDBY"
    }

    BoxWithConstraints(
        Modifier.fillMaxSize().background(if (emergency) Color(0xFFFFD9D9) else Color(0xFFF8FAFC))
    ) {
        val compact = maxWidth < 240.dp || maxHeight < 320.dp
        val channelSize = if (compact) 24.sp else 31.sp
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().background(Bottom).padding(horizontal = 6.dp, vertical = 5.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("COMMAND COMMS", fontWeight = FontWeight.Bold,
                    color = Color.White, fontSize = 11.sp, maxLines = 1)
                Text((state.batteryLevel?.toString() ?: "--") + "%", color = Color.White, fontSize = 10.sp)
            }

            if (state.hd760MenuOpen) {
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(8.dp),
                    verticalArrangement = Arrangement.SpaceEvenly
                ) {
                    if (state.hd760ProgrammingSlot) {
                        val channels = state.currentZone?.channels.orEmpty()
                        val candidate = channels.getOrNull(state.hd760ProgramChannelIndex)
                        Text("PROGRAM SLOT " + (state.hd760KnobPosition?.toString() ?: "?"),
                            color = Muted, fontWeight = FontWeight.Bold, fontSize = 13.sp)
                        Text(candidate?.name ?: "EMPTY / DISABLED", fontSize = 19.sp,
                            color = Ink, fontWeight = FontWeight.Bold, maxLines = 2)
                        Text("UP/DOWN: CHOOSE   OK: SAVE", color = Muted, fontSize = 10.sp)
                    } else {
                        val items = model.hd760MenuLabels
                        val index = state.hd760MenuIndex
                        Text("MENU " + (index + 1) + "/" + items.size, color = Muted, fontSize = 12.sp)
                        Text(items.getOrNull((index - 1 + items.size) % items.size) ?: "",
                            color = Muted, fontSize = 11.sp, maxLines = 1)
                        Text(items.getOrNull(index) ?: "", color = accent,
                            fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 2)
                        Text(items.getOrNull((index + 1) % items.size) ?: "",
                            color = Muted, fontSize = 11.sp, maxLines = 1)
                        Text("UP/DOWN: MOVE   OK: SELECT", color = Muted, fontSize = 9.sp)
                    }
                }
            } else {
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(horizontal = 6.dp, vertical = 3.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.SpaceEvenly
                ) {
                    Text("ZN", fontSize = 10.sp, color = Muted)
                    Text(state.currentZone?.name?.uppercase() ?: "NO ZONE", color = Ink,
                        fontWeight = FontWeight.Bold, fontSize = if (compact) 16.sp else 20.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                    Text("CH • SLOT " + (state.hd760KnobPosition?.toString() ?: "--") + "/15",
                        fontSize = 10.sp, color = Muted)
                    Text(
                        if (state.hd760SlotEmpty) "UNPROGRAMMED" else
                            (state.currentChannel?.name ?: "NO CHANNEL"),
                        fontSize = channelSize, color = Ink, fontWeight = FontWeight.Bold,
                        textAlign = TextAlign.Center, maxLines = 2,
                        overflow = TextOverflow.Ellipsis, lineHeight = if (compact) 26.sp else 33.sp
                    )
                    Text(status, color = accent, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                    val from = when {
                        state.scanActiveChannel != null ->
                            "SCAN: " + state.scanActiveChannel + "  " + state.scanActiveUnit.orEmpty()
                        rx || state.isChannelBusy ->
                            "FROM: " + (state.activeTransmittingUnit ?: "--")
                        state.channelEmergencyActive ->
                            "SOS: " + (state.channelEmergencyUnitId ?: "OTHER UNIT")
                        state.isScanning -> "SCAN ON"
                        else -> ""
                    }
                    Text(from, color = Muted, fontSize = 11.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (state.error != null) {
                        Text(state.error ?: "", color = Color.Red, fontSize = 9.sp, maxLines = 1)
                    }
                    if (state.isKeyLocked) {
                        Text("KEYS LOCKED", color = Muted, fontSize = 9.sp)
                    }
                }
            }

            Row(
                Modifier.fillMaxWidth().background(Bottom).padding(5.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(state.unitId.ifBlank { "UNASSIGNED" },
                    color = Color.White, fontSize = 10.sp, maxLines = 1)
                Text(if (state.isConnected) "ONLINE" else "OFFLINE",
                    color = if (state.isConnected) Color(0xFF7DE3A7) else Color(0xFFFFB4B4),
                    fontSize = 10.sp, maxLines = 1)
            }
        }
    }
}
