package com.reedersystems.commandcomms.ui.radio

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.audio.bridge.UhfBridgeDirection
import com.reedersystems.commandcomms.audio.bridge.UhfBridgeRuntime
import com.reedersystems.commandcomms.audio.bridge.UhfBridgeService
import com.reedersystems.commandcomms.data.prefs.UhfBridgePrefs
import kotlin.math.roundToInt

private val BridgeDark = Color(0xFF111820)
private val BridgePanel = Color(0xFF1D2935)
private val BridgeGreen = Color(0xFF0B8F55)
private val BridgeOrange = Color(0xFFF57C00)
private val BridgeRed = Color(0xFFB3261E)
private val BridgeBlue = Color(0xFF1565C0)

@Composable
fun PhoneBridgeDashboard(
    onLocked: (() -> Unit)?,
    onUnassigned: (() -> Unit)?,
    onReassigned: ((String) -> Unit)?,
    onSettings: (() -> Unit)?,
    assignedFromUnit: String?,
    radioViewModel: RadioViewModel = viewModel()
) {
    val context = LocalContext.current
    val radioState by radioViewModel.uiState.collectAsStateWithLifecycle()
    val bridgeStatus by UhfBridgeRuntime.status.collectAsState()
    val prefs = remember { UhfBridgePrefs(context.applicationContext) }
    var bridgeEnabled by remember { mutableStateOf(prefs.enabled) }
    var showVoxSettings by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (prefs.enabled) startBridge(context)
    }

    val bridgeRunning = bridgeEnabled || bridgeStatus.running
    val channelControlsEnabled =
        !bridgeRunning && !radioState.isLoading && radioState.currentChannel != null

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        BridgeHeader(
            zoneName = radioState.currentZone?.name
                ?: if (radioState.isLoading) "LOADING" else "NO ZONE",
            channelName = radioState.currentChannel?.name
                ?: if (radioState.isLoading) "LOADING" else "NO CHANNEL",
            connected = radioState.isConnected,
            bridgeEnabled = bridgeEnabled,
            direction = bridgeStatus.direction,
            message = bridgeStatus.message,
            inputDb = bridgeStatus.inputDb,
            wiredInput = bridgeStatus.wiredInput,
            wiredOutput = bridgeStatus.wiredOutput,
            controlsEnabled = channelControlsEnabled,
            onPreviousZone = radioViewModel::prevZone,
            onNextZone = radioViewModel::nextZone,
            onPreviousChannel = radioViewModel::prevChannel,
            onNextChannel = radioViewModel::nextChannel,
            onToggleBridge = {
                bridgeEnabled = !bridgeEnabled
                prefs.enabled = bridgeEnabled
                if (bridgeEnabled) startBridge(context) else stopBridge(context)
            },
            onVoxSettings = { showVoxSettings = true }
        )

        Box(modifier = Modifier.weight(1f)) {
            RadioScreen(
                onLocked = onLocked,
                onUnassigned = onUnassigned,
                onReassigned = onReassigned,
                onSettings = onSettings,
                assignedFromUnit = assignedFromUnit,
                viewModel = radioViewModel
            )
        }
    }

    if (showVoxSettings) {
        VoxSettingsDialog(
            prefs = prefs,
            bridgeEnabled = bridgeEnabled,
            onBridgeEnabledChanged = { enabled ->
                bridgeEnabled = enabled
                prefs.enabled = enabled
                if (enabled) startBridge(context) else stopBridge(context)
            },
            onApply = { reloadBridge(context) },
            onDismiss = { showVoxSettings = false }
        )
    }
}

@Composable
private fun BridgeHeader(
    zoneName: String,
    channelName: String,
    connected: Boolean,
    bridgeEnabled: Boolean,
    direction: UhfBridgeDirection,
    message: String,
    inputDb: Float,
    wiredInput: Boolean,
    wiredOutput: Boolean,
    controlsEnabled: Boolean,
    onPreviousZone: () -> Unit,
    onNextZone: () -> Unit,
    onPreviousChannel: () -> Unit,
    onNextChannel: () -> Unit,
    onToggleBridge: () -> Unit,
    onVoxSettings: () -> Unit
) {
    val accent = when (direction) {
        UhfBridgeDirection.RF_TO_POC -> BridgeGreen
        UhfBridgeDirection.POC_TO_RF -> BridgeOrange
        UhfBridgeDirection.ERROR -> BridgeRed
        UhfBridgeDirection.STARTING -> BridgeBlue
        UhfBridgeDirection.LOCKOUT -> Color(0xFF7A5A00)
        else -> if (bridgeEnabled) BridgeGreen else Color(0xFF546E7A)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(BridgeDark)
            .border(2.dp, accent)
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    "COMMAND COMMS UHF BRIDGE",
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Black,
                    fontFamily = FontFamily.Monospace
                )
                Text(
                    if (connected) "POC CONNECTED" else "POC CONNECTING",
                    color = if (connected) Color(0xFF4ADE80) else Color(0xFFFFC107),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold
                )
            }
            Text(
                "${inputDb.roundToInt()} dB",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace
            )
        }

        SelectorRow(
            label = "ZONE",
            value = zoneName,
            enabled = controlsEnabled,
            onPrevious = onPreviousZone,
            onNext = onNextZone
        )
        SelectorRow(
            label = "CHANNEL",
            value = channelName,
            enabled = controlsEnabled,
            onPrevious = onPreviousChannel,
            onNext = onNextChannel
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = onToggleBridge,
                enabled = channelName != "NO CHANNEL" && channelName != "LOADING",
                modifier = Modifier
                    .weight(1f)
                    .height(42.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (bridgeEnabled) BridgeRed else BridgeGreen
                )
            ) {
                Text(
                    if (bridgeEnabled) "STOP BRIDGE" else "START BRIDGE",
                    fontWeight = FontWeight.Black,
                    fontFamily = FontFamily.Monospace
                )
            }
            OutlinedButton(
                onClick = onVoxSettings,
                modifier = Modifier
                    .weight(0.65f)
                    .height(42.dp)
            ) {
                Text("VOX SETTINGS", fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                message.ifBlank { if (bridgeEnabled) "Bridge enabled" else "Bridge stopped" },
                color = Color(0xFFD7E3EF),
                fontSize = 10.sp,
                maxLines = 1,
                modifier = Modifier.weight(1f)
            )
            Text(
                "IN ${if (wiredInput) "OK" else "--"}  OUT ${if (wiredOutput) "OK" else "--"}",
                color = if (wiredInput && wiredOutput) Color(0xFF4ADE80) else Color(0xFFFFC107),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold
            )
        }

        if (bridgeEnabled) {
            Text(
                "Stop Bridge Mode before changing zones or channels.",
                color = Color(0xFFFFD54F),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

@Composable
private fun SelectorRow(
    label: String,
    value: String,
    enabled: Boolean,
    onPrevious: () -> Unit,
    onNext: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        OutlinedButton(
            onClick = onPrevious,
            enabled = enabled,
            modifier = Modifier
                .weight(1f)
                .height(38.dp),
            contentPadding = PaddingValues(2.dp)
        ) {
            Text("◀ $label", fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
        Column(
            modifier = Modifier.weight(1.45f),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(label, color = Color(0xFF9FB3C8), fontSize = 9.sp)
            Text(
                value.uppercase(),
                color = Color.White,
                fontSize = if (label == "CHANNEL") 15.sp else 13.sp,
                fontWeight = FontWeight.Black,
                maxLines = 1,
                textAlign = TextAlign.Center
            )
        }
        OutlinedButton(
            onClick = onNext,
            enabled = enabled,
            modifier = Modifier
                .weight(1f)
                .height(38.dp),
            contentPadding = PaddingValues(2.dp)
        ) {
            Text("$label ▶", fontSize = 10.sp, fontWeight = FontWeight.Bold)
        }
    }
}

@Composable
private fun VoxSettingsDialog(
    prefs: UhfBridgePrefs,
    bridgeEnabled: Boolean,
    onBridgeEnabledChanged: (Boolean) -> Unit,
    onApply: () -> Unit,
    onDismiss: () -> Unit
) {
    val status by UhfBridgeRuntime.status.collectAsState()
    var activationDb by remember { mutableFloatStateOf(prefs.activationDb) }
    var deactivationDb by remember { mutableFloatStateOf(prefs.deactivationDb) }
    var triggerMs by remember { mutableFloatStateOf(prefs.triggerMs.toFloat()) }
    var hangMs by remember { mutableFloatStateOf(prefs.hangMs.toFloat()) }
    var lockoutMs by remember { mutableFloatStateOf(prefs.lockoutMs.toFloat()) }
    var minimumTxMs by remember { mutableFloatStateOf(prefs.minimumTxMs.toFloat()) }
    var maximumTxSeconds by remember { mutableFloatStateOf(prefs.maximumTxMs / 1_000f) }
    var inputGain by remember { mutableFloatStateOf(prefs.inputGain) }
    var outputGain by remember { mutableFloatStateOf(prefs.outputGain) }
    var leadInMs by remember { mutableFloatStateOf(prefs.voxLeadInMs.toFloat()) }

    fun save() {
        prefs.activationDb = activationDb
        prefs.deactivationDb = deactivationDb.coerceAtMost(activationDb - 1f)
        prefs.triggerMs = triggerMs.roundToInt()
        prefs.hangMs = hangMs.roundToInt()
        prefs.lockoutMs = lockoutMs.roundToInt()
        prefs.minimumTxMs = minimumTxMs.roundToInt()
        prefs.maximumTxMs = (maximumTxSeconds * 1_000f).roundToInt()
        prefs.inputGain = inputGain
        prefs.outputGain = outputGain
        prefs.voxLeadInMs = leadInMs.roundToInt()
        onApply()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("UHF Bridge VOX Settings", fontWeight = FontWeight.Black) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 620.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(7.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(BridgePanel)
                        .padding(8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            if (bridgeEnabled) "BRIDGE MODE ON" else "BRIDGE MODE OFF",
                            color = Color.White,
                            fontWeight = FontWeight.Black
                        )
                        Text(status.message, color = Color(0xFFD7E3EF), fontSize = 10.sp)
                    }
                    Button(
                        onClick = { onBridgeEnabledChanged(!bridgeEnabled) },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (bridgeEnabled) BridgeRed else BridgeGreen
                        )
                    ) {
                        Text(if (bridgeEnabled) "STOP" else "START")
                    }
                }

                SettingSlider("Activation", activationDb, -60f..-10f, "${activationDb.roundToInt()} dB") {
                    activationDb = it
                    if (deactivationDb >= activationDb) deactivationDb = activationDb - 1f
                }
                SettingSlider("Deactivation", deactivationDb, -70f..-11f, "${deactivationDb.roundToInt()} dB") {
                    deactivationDb = it.coerceAtMost(activationDb - 1f)
                }
                SettingSlider("Trigger", triggerMs, 20f..1_000f, "${triggerMs.roundToInt()} ms") { triggerMs = it }
                SettingSlider("Hang", hangMs, 100f..3_000f, "${hangMs.roundToInt()} ms") { hangMs = it }
                SettingSlider("Lockout", lockoutMs, 0f..3_000f, "${lockoutMs.roundToInt()} ms") { lockoutMs = it }
                SettingSlider("Minimum TX", minimumTxMs, 100f..2_000f, "${minimumTxMs.roundToInt()} ms") { minimumTxMs = it }
                SettingSlider("Maximum TX", maximumTxSeconds, 10f..180f, "${maximumTxSeconds.roundToInt()} sec") { maximumTxSeconds = it }
                SettingSlider("Input gain", inputGain, 0.25f..4f, String.format("%.2fx", inputGain)) { inputGain = it }
                SettingSlider("Output gain", outputGain, 0.25f..4f, String.format("%.2fx", outputGain)) { outputGain = it }
                SettingSlider("VOX lead-in", leadInMs, 0f..1_000f, "${leadInMs.roundToInt()} ms") { leadInMs = it }

                Text(
                    "Live radio input: ${status.inputDb.roundToInt()} dB",
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp
                )
            }
        },
        confirmButton = {
            Button(onClick = { save(); onDismiss() }) { Text("APPLY") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("CANCEL") }
        }
    )
}

@Composable
private fun SettingSlider(
    label: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    valueLabel: String,
    onValueChange: (Float) -> Unit
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(label, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Text(valueLabel, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
        }
        Slider(
            value = value.coerceIn(range.start, range.endInclusive),
            onValueChange = onValueChange,
            valueRange = range
        )
    }
}

private fun startBridge(context: Context) {
    val intent = Intent(context, UhfBridgeService::class.java).apply {
        action = UhfBridgeService.ACTION_START
    }
    ContextCompat.startForegroundService(context, intent)
}

private fun stopBridge(context: Context) {
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
