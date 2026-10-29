package com.reedersystems.commandcomms.ui.radio

import android.Manifest
import android.content.pm.PackageManager
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.GpsFixed
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.SignalCellularAlt
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
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
import com.reedersystems.commandcomms.hd760.Hd760MeterModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext

private val Ink = Color(0xFF17212E)
private val Muted = Color(0xFF556577)
private val Bottom = Color(0xFF172735)

/** The Motorola-style scan zigzag is drawn white directly on the bar, with no tile. */
@Composable
private fun ScanZ(modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val p = Path().apply {
            moveTo(w * .12f, h * .14f)
            lineTo(w * .87f, h * .14f)
            lineTo(w * .16f, h * .78f)
            lineTo(w * .79f, h * .78f)
            moveTo(w * .56f, h * .56f)
            lineTo(w * .79f, h * .78f)
            lineTo(w * .56f, h * .97f)
        }
        drawPath(p, Color.White, style = Stroke(width = 2.0f,
            cap = StrokeCap.Square, join = StrokeJoin.Miter))
    }
}

private enum class StatusIcon { LOCK, SCAN, GPS, BLUETOOTH, WIFI, CELLULAR }

/**
 * Slots never collapse. Unavailable indicators are fully invisible but still
 * reserve their fixed footprint, including the mini signal-meter area.
 */
@Composable
private fun FixedIndicatorSlot(kind: StatusIcon, active: Boolean, bars: Int? = null) {
    Column(
        modifier = Modifier.width(13.dp).height(23.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Box(Modifier.size(12.dp), contentAlignment = Alignment.Center) {
            if (active) when (kind) {
                StatusIcon.LOCK -> Icon(Icons.Filled.Lock, "Keypad locked",
                    modifier = Modifier.size(12.dp), tint = Color.White)
                StatusIcon.SCAN -> ScanZ(Modifier.size(11.dp))
                StatusIcon.GPS -> Icon(Icons.Filled.GpsFixed, "GPS fix",
                    modifier = Modifier.size(12.dp), tint = Color.White)
                StatusIcon.BLUETOOTH -> Icon(Icons.Filled.Bluetooth, "Bluetooth connected",
                    modifier = Modifier.size(12.dp), tint = Color.White)
                StatusIcon.WIFI -> Icon(Icons.Filled.Wifi, "Wi-Fi connected",
                    modifier = Modifier.size(12.dp), tint = Color.White)
                StatusIcon.CELLULAR -> Icon(Icons.Filled.SignalCellularAlt, "Cellular connected",
                    modifier = Modifier.size(12.dp), tint = Color.White)
            }
        }
        Spacer(Modifier.height(1.dp))
        Box(Modifier.height(6.dp), contentAlignment = Alignment.Center) {
            if (active && kind !in setOf(StatusIcon.LOCK, StatusIcon.SCAN)) {
                Row(horizontalArrangement = Arrangement.spacedBy(1.dp),
                    verticalAlignment = Alignment.Bottom) {
                    repeat(4) { index ->
                        // Unknown RSSI stays unfilled. Never invent Bluetooth strength.
                        val fill = bars?.let { index < (it * 4 + 4) / 5 } == true
                        Box(Modifier.width(2.dp).height((2 + index).dp)
                            .background(Color.White.copy(alpha = if (fill) 1f else .28f)))
                    }
                }
            }
        }
    }
}

@Composable
private fun SharedTxRxMeter(tx: Boolean, rx: Boolean, rxBars: Int?) {
    // Fixed-height space stays completely blank when idle.
    Box(Modifier.fillMaxWidth().height(29.dp), contentAlignment = Alignment.Center) {
        if (tx || rx) {
            val known = if (tx) null else rxBars
            val count = known ?: 0
            val filled = when {
                known == null -> Muted
                count <= 1 -> Color(0xFFB42318)
                count <= 3 -> Color(0xFFB67508)
                else -> Color(0xFF16784A)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text(if (tx) "TX" else "RX",
                    color = Ink, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                Row(Modifier.height(23.dp), horizontalArrangement = Arrangement.spacedBy(3.dp),
                    verticalAlignment = Alignment.Bottom) {
                    repeat(5) { i ->
                        Box(Modifier.width(10.dp).height((10 + i * 3).dp).background(
                            if (i < count) filled else Color(0xFFC9D1D9)
                        ))
                    }
                }
            }
        }
    }
}

/** HD760: single-line compact status header and fixed non-scrolling radio information. */
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

    val indicators by produceState(initialValue = Hd760Connectivity(), context) {
        while (isActive) {
            value = withContext(Dispatchers.IO) { Hd760ConnectivityReader.read(context) }
            delay(4_000L)
        }
    }
    val tx = state.pttState == PttState.TRANSMITTING
    val rx = !tx && state.radioState == RadioState.RECEIVING
    val emergency = state.myEmergencyActive
    val accent = if (emergency) Color(0xFFB71C1C) else Color(0xFF17618F)

    BoxWithConstraints(
        Modifier.fillMaxSize().background(if (emergency) Color(0xFFFFD9D9) else Color(0xFFF8FAFC))
    ) {
        val compact = maxWidth < 240.dp || maxHeight < 320.dp
        val channelSize = if (compact) 32.sp else 39.sp
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().height(31.dp).background(Bottom)
                    .padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("COMMAND COMMS", color = Color.White, fontSize = 11.sp,
                    fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
                Spacer(Modifier.weight(1f))
                Row(horizontalArrangement = Arrangement.spacedBy(1.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    FixedIndicatorSlot(StatusIcon.LOCK, state.isKeyLocked)
                    FixedIndicatorSlot(StatusIcon.SCAN, state.isScanning)
                    FixedIndicatorSlot(StatusIcon.GPS, indicators.gpsFix, indicators.gpsBars)
                    FixedIndicatorSlot(StatusIcon.BLUETOOTH, indicators.bluetoothConnected,
                        indicators.bluetoothBars)
                    FixedIndicatorSlot(StatusIcon.WIFI, indicators.wifiConnected, indicators.wifiBars)
                    FixedIndicatorSlot(StatusIcon.CELLULAR, indicators.cellConnected,
                        indicators.cellBars)
                }
                Spacer(Modifier.width(3.dp))
                Text((state.batteryLevel?.toString() ?: "--") + "%",
                    color = Color.White, fontSize = 10.sp, maxLines = 1)
            }

            if (state.hd760MenuOpen) {
                Column(
                    Modifier.weight(1f).fillMaxWidth().padding(8.dp),
                    verticalArrangement = Arrangement.SpaceEvenly
                ) {
                    if (state.hd760ScanListOpen) {
                        val channels = state.scanChannels
                        val idx = state.hd760ScanListIndex.coerceIn(
                            0, (channels.size - 1).coerceAtLeast(0))
                        fun label(index: Int): String {
                            val item = channels.getOrNull(index) ?: return ""
                            val zone = state.zones.firstOrNull { z ->
                                z.channels.any { it.id == item.id }
                            }?.name ?: ""
                            return (if (item.enabled) "☑ " else "☐ ") + zone + ": " + item.name
                        }
                        Text("SCAN LIST " + (idx + 1) + "/" + channels.size,
                            color = Muted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                        Text(label(idx - 1), color = Muted, fontSize = 11.sp, maxLines = 1)
                        Text(label(idx), color = Ink, fontWeight = FontWeight.Bold,
                            fontSize = 15.sp, maxLines = 2)
                        Text(label(idx + 1), color = Muted, fontSize = 11.sp, maxLines = 1)
                        Text("UP/DOWN: MOVE  OK: CHECK", color = Muted, fontSize = 9.sp)
                    } else {
                        val items = model.hd760MenuLabels
                        val index = state.hd760MenuIndex
                        Text("MENU " + (index + 1) + "/" + items.size,
                            color = Muted, fontSize = 12.sp)
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
                    Modifier.weight(1f).fillMaxWidth()
                        .padding(horizontal = 5.dp, vertical = 3.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.SpaceEvenly
                ) {
                    Text("ZN", fontSize = 13.sp, color = Muted, fontWeight = FontWeight.Medium)
                    Text(state.currentZone?.name?.uppercase() ?: "NO ZONE",
                        color = Ink, fontWeight = FontWeight.Bold,
                        fontSize = if (compact) 22.sp else 25.sp,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center)
                    Text("CH", fontSize = 13.sp, color = Muted, fontWeight = FontWeight.Medium)
                    Text(if (state.hd760SlotEmpty) "UNPROGRAMMED" else
                        state.currentChannel?.name ?: "NO CHANNEL",
                        fontSize = channelSize, color = Ink,
                        fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                        lineHeight = if (compact) 35.sp else 42.sp)

                    // Always reserve the same room for caller ID and lock feedback.
                    Box(Modifier.fillMaxWidth().height(35.dp),
                        contentAlignment = Alignment.Center) {
                        val label = when {
                            state.hd760LockFeedback != null -> state.hd760LockFeedback
                            emergency -> "EMERGENCY"
                            rx -> state.scanActiveUnit ?: state.activeTransmittingUnit
                            else -> null
                        }
                        if (!label.isNullOrBlank()) {
                            Text(label, color = if (emergency) Color(0xFFB71C1C) else Ink,
                                fontWeight = FontWeight.Bold,
                                fontSize = if (compact) 17.sp else 20.sp,
                                maxLines = 1, overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center)
                        }
                    }
                    if (state.error != null) {
                        Text(state.error ?: "", color = Color.Red,
                            fontSize = 9.sp, maxLines = 1)
                    }
                }
            }

            if (!state.hd760MenuOpen) {
                SharedTxRxMeter(
                    tx = tx,
                    rx = rx,
                    rxBars = Hd760MeterModel.receiveBars(state.signalQuality)
                )
            } else {
                Spacer(Modifier.height(29.dp))
            }

            Row(
                Modifier.fillMaxWidth().background(Bottom).padding(5.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(state.unitId.ifBlank { "UNASSIGNED" }, color = Color.White,
                    fontSize = 10.sp, maxLines = 1)
                Text(if (state.isConnected) "ONLINE" else "OFFLINE",
                    color = if (state.isConnected) Color(0xFF7DE3A7) else Color(0xFFFFB4B4),
                    fontSize = 10.sp, maxLines = 1)
            }
        }
    }
}
