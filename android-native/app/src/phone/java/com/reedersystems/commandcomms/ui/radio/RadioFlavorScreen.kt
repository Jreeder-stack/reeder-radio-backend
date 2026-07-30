package com.reedersystems.commandcomms.ui.radio

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.audio.bridge.UhfBridgeDirection
import com.reedersystems.commandcomms.audio.bridge.UhfBridgeRuntime
import com.reedersystems.commandcomms.audio.bridge.UhfBridgeService
import com.reedersystems.commandcomms.data.prefs.UhfBridgePrefs
import kotlin.math.roundToInt

private val BridgeGreen = Color(0xFF008844)
private val BridgeRed = Color(0xFFB00020)
private val BridgeOrange = Color(0xFFF57C00)
private val BridgeDark = Color(0xFF171717)

/**
 * Phone/tablet flavor. The normal radio UI remains available, with a dedicated
 * UHF Bridge control layered on top. T320 and SD7 source sets are unchanged.
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
    val prefs = remember { UhfBridgePrefs(context.applicationContext) }
    val status by UhfBridgeRuntime.status.collectAsState()
    var showBridgeSettings by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (prefs.enabled) {
            startBridge(context)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        RadioScreen(
            onLocked = onLocked,
            onUnassigned = onUnassigned,
            onReassigned = onReassigned,
            onSettings = onSettings,
            assignedFromUnit = assignedFromUnit
        )

        BridgeQuickButton(
            running = prefs.enabled || status.running,
            direction = status.direction,
            inputDb = status.inputDb,
            onClick = { showBridgeSettings = true },
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 10.dp, end = 10.dp)
        )
    }

    if (showBridgeSettings) {
        BridgeSettingsDialog(
            prefs = prefs,
            onDismiss = { showBridgeSettings = false },
            onStart = { startBridge(context) },
            onStop = { stopBridge(context) },
            onReload = { reloadBridge(context) }
        )
    }
}

@Composable
private fun BridgeQuickButton(
    running: Boolean,
    direction: UhfBridgeDirection,
    inputDb: Float,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val color = when (direction) {
        UhfBridgeDirection.RF_TO_POC -> BridgeGreen
        UhfBridgeDirection.POC_TO_RF -> BridgeOrange
        UhfBridgeDirection.ERROR -> BridgeRed
        UhfBridgeDirection.LOCKOUT -> Color(0xFF6A4B00)
        UhfBridgeDirection.STARTING -> Color(0xFF3F51B5)
        else -> if (running) Color(0xFF37474F) else Color(0xFF555555)
    }
    val label = when (direction) {
        UhfBridgeDirection.RF_TO_POC -> "UHF→POC"
        UhfBridgeDirection.POC_TO_RF -> "POC→UHF"
        UhfBridgeDirection.ERROR -> "BRIDGE ERR"
        UhfBridgeDirection.LOCKOUT -> "LOCKOUT"
        UhfBridgeDirection.STARTING -> "STARTING"
        UhfBridgeDirection.IDLE -> "BRIDGE ON"
        else -> "BRIDGE"
    }

    Column(
        modifier = modifier
            .background(color)
            .border(1.dp, Color.White.copy(alpha = 0.6f))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 7.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(label, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 11.sp)
        if (running) {
            Text(
                text = "${inputDb.roundToInt()} dB",
                color = Color.White.copy(alpha = 0.85f),
                fontSize = 9.sp
            )
        }
    }
}

@Composable
private fun BridgeSettingsDialog(
    prefs: UhfBridgePrefs,
    onDismiss: () -> Unit,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onReload: () -> Unit
) {
    val status by UhfBridgeRuntime.status.collectAsState()

    var enabled by remember { mutableStateOf(prefs.enabled) }
    var activationDb by remember { mutableFloatStateOf(prefs.activationDb) }
    var deactivationDb by remember { mutableFloatStateOf(prefs.deactivationDb) }
    var triggerMs by remember { mutableFloatStateOf(prefs.triggerMs.toFloat()) }
    var hangMs by remember { mutableFloatStateOf(prefs.hangMs.toFloat()) }
    var lockoutMs by remember { mutableFloatStateOf(prefs.lockoutMs.toFloat()) }
    var minimumTxMs by remember { mutableFloatStateOf(prefs.minimumTxMs.toFloat()) }
    var maximumTxSeconds by remember { mutableFloatStateOf(prefs.maximumTxMs / 1_000f) }
    var inputGain by remember { mutableFloatStateOf(prefs.inputGain) }
    var outputGain by remember { mutableFloatStateOf(prefs.outputGain) }
    var voxLeadInMs by remember { mutableFloatStateOf(prefs.voxLeadInMs.toFloat()) }

    fun saveSettings() {
        prefs.activationDb = activationDb
        prefs.deactivationDb = deactivationDb.coerceAtMost(activationDb - 1f)
        deactivationDb = prefs.deactivationDb
        prefs.triggerMs = triggerMs.roundToInt()
        prefs.hangMs = hangMs.roundToInt()
        prefs.lockoutMs = lockoutMs.roundToInt()
        prefs.minimumTxMs = minimumTxMs.roundToInt()
        prefs.maximumTxMs = (maximumTxSeconds * 1_000f).roundToInt()
        prefs.inputGain = inputGain
        prefs.outputGain = outputGain
        prefs.voxLeadInMs = voxLeadInMs.roundToInt()
        onReload()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text("UHF ↔ PoC Bridge", fontWeight = FontWeight.Bold)
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text("Bridge Mode", fontWeight = FontWeight.Bold)
                        Text(
                            if (enabled) "Automatic two-way gateway enabled" else "Normal phone radio mode",
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    Switch(
                        checked = enabled,
                        onCheckedChange = { checked ->
                            enabled = checked
                            prefs.enabled = checked
                            if (checked) onStart() else onStop()
                        }
                    )
                }

                BridgeStatusCard(status)

                Text("RF input VOX", fontWeight = FontWeight.Bold)
                LiveInputMeter(
                    inputDb = status.inputDb,
                    activationDb = activationDb,
                    deactivationDb = deactivationDb
                )

                BridgeSlider(
                    label = "Activation threshold",
                    value = activationDb,
                    valueRange = -60f..-10f,
                    valueText = "${activationDb.roundToInt()} dB",
                    onValueChange = { activationDb = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Deactivation threshold",
                    value = deactivationDb,
                    valueRange = -65f..-15f,
                    valueText = "${deactivationDb.roundToInt()} dB",
                    onValueChange = { deactivationDb = it.coerceAtMost(activationDb - 1f) },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Trigger time",
                    value = triggerMs,
                    valueRange = 50f..1_000f,
                    valueText = "${triggerMs.roundToInt()} ms",
                    onValueChange = { triggerMs = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Hang time",
                    value = hangMs,
                    valueRange = 200f..3_000f,
                    valueText = "${hangMs.roundToInt()} ms",
                    onValueChange = { hangMs = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Post-transmission lockout",
                    value = lockoutMs,
                    valueRange = 100f..2_000f,
                    valueText = "${lockoutMs.roundToInt()} ms",
                    onValueChange = { lockoutMs = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Minimum transmission",
                    value = minimumTxMs,
                    valueRange = 200f..2_000f,
                    valueText = "${minimumTxMs.roundToInt()} ms",
                    onValueChange = { minimumTxMs = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Maximum transmission timeout",
                    value = maximumTxSeconds,
                    valueRange = 15f..180f,
                    valueText = "${maximumTxSeconds.roundToInt()} sec",
                    onValueChange = { maximumTxSeconds = it },
                    onValueChangeFinished = ::saveSettings
                )

                Spacer(Modifier.height(4.dp))
                Text("Audio levels", fontWeight = FontWeight.Bold)
                BridgeSlider(
                    label = "Radio input gain",
                    value = inputGain,
                    valueRange = 0.5f..3.0f,
                    valueText = String.format("%.1fx", inputGain),
                    onValueChange = { inputGain = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Radio output gain",
                    value = outputGain,
                    valueRange = 0.5f..2.0f,
                    valueText = String.format("%.1fx", outputGain),
                    onValueChange = { outputGain = it },
                    onValueChangeFinished = ::saveSettings
                )
                BridgeSlider(
                    label = "Baofeng VOX lead-in tone",
                    value = voxLeadInMs,
                    valueRange = 0f..500f,
                    valueText = "${voxLeadInMs.roundToInt()} ms",
                    onValueChange = { voxLeadInMs = it },
                    onValueChangeFinished = ::saveSettings
                )

                Text(
                    "The deactivation threshold should stay below activation. Trigger time, hang time, and lockout prevent cable clicks and squelch tails from causing ghost key-ups.",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFF555555)
                )
            }
        },
        confirmButton = {
            Button(onClick = {
                saveSettings()
                onDismiss()
            }) {
                Text("DONE")
            }
        },
        dismissButton = {
            OutlinedButton(onClick = {
                saveSettings()
                if (enabled) {
                    prefs.enabled = false
                    enabled = false
                    onStop()
                } else {
                    prefs.enabled = true
                    enabled = true
                    onStart()
                }
            }) {
                Text(if (enabled) "STOP BRIDGE" else "START BRIDGE")
            }
        }
    )
}

@Composable
private fun BridgeStatusCard(status: com.reedersystems.commandcomms.audio.bridge.UhfBridgeStatus) {
    val statusColor = when (status.direction) {
        UhfBridgeDirection.RF_TO_POC -> BridgeGreen
        UhfBridgeDirection.POC_TO_RF -> BridgeOrange
        UhfBridgeDirection.ERROR -> BridgeRed
        UhfBridgeDirection.LOCKOUT -> Color(0xFF8D6E00)
        UhfBridgeDirection.IDLE -> Color(0xFF2E5D44)
        UhfBridgeDirection.STARTING -> Color(0xFF3F51B5)
        else -> BridgeDark
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(statusColor.copy(alpha = 0.12f))
            .border(1.dp, statusColor.copy(alpha = 0.55f))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text(status.message, color = statusColor, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatusDot("Cable in", status.wiredInput)
            StatusDot("Cable out", status.wiredOutput)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            StatusDot("Server", status.signalingReady)
            StatusDot("Channel", status.channelJoined)
        }
    }
}

@Composable
private fun StatusDot(label: String, active: Boolean) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(8.dp)
                .background(if (active) BridgeGreen else BridgeRed)
        )
        Spacer(Modifier.width(4.dp))
        Text(label, fontSize = 11.sp)
    }
}

@Composable
private fun LiveInputMeter(inputDb: Float, activationDb: Float, deactivationDb: Float) {
    val normalized = ((inputDb + 90f) / 90f).coerceIn(0f, 1f)
    val activationPosition = ((activationDb + 90f) / 90f).coerceIn(0f, 1f)
    val deactivationPosition = ((deactivationDb + 90f) / 90f).coerceIn(0f, 1f)
    val active = inputDb >= activationDb

    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text("Live input", fontSize = 11.sp)
            Text("${inputDb.roundToInt()} dB", fontSize = 11.sp, fontWeight = FontWeight.Bold)
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(14.dp)
                .background(Color(0xFFD7D7D7))
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(normalized)
                    .height(14.dp)
                    .background(if (active) BridgeGreen else Color(0xFF607D8B))
            )
            Box(
                modifier = Modifier
                    .fillMaxWidth(deactivationPosition)
                    .height(14.dp)
                    .border(0.dp, Color.Transparent)
            )
            Box(
                modifier = Modifier
                    .fillMaxWidth(activationPosition)
                    .height(14.dp)
                    .border(1.dp, BridgeRed)
            )
        }
    }
}

@Composable
private fun BridgeSlider(
    label: String,
    value: Float,
    valueRange: ClosedFloatingPointRange<Float>,
    valueText: String,
    onValueChange: (Float) -> Unit,
    onValueChangeFinished: () -> Unit
) {
    Column {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(label, fontSize = 12.sp)
            Text(valueText, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Slider(
            value = value.coerceIn(valueRange.start, valueRange.endInclusive),
            onValueChange = onValueChange,
            onValueChangeFinished = onValueChangeFinished,
            valueRange = valueRange
        )
    }
}

private fun startBridge(context: Context) {
    UhfBridgePrefs(context.applicationContext).enabled = true
    val intent = Intent(context, UhfBridgeService::class.java).apply {
        action = UhfBridgeService.ACTION_START
    }
    ContextCompat.startForegroundService(context, intent)
}

private fun stopBridge(context: Context) {
    UhfBridgePrefs(context.applicationContext).enabled = false
    val intent = Intent(context, UhfBridgeService::class.java).apply {
        action = UhfBridgeService.ACTION_STOP
    }
    ContextCompat.startForegroundService(context, intent)
}

private fun reloadBridge(context: Context) {
    val intent = Intent(context, UhfBridgeService::class.java).apply {
        action = UhfBridgeService.ACTION_RELOAD
    }
    ContextCompat.startForegroundService(context, intent)
}
