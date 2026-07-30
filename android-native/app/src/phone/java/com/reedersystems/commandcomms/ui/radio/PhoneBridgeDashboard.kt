package com.reedersystems.commandcomms.ui.radio

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.weight
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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

private val PhoneBridgeDark = Color(0xFF111820)
private val PhoneBridgePanel = Color(0xFF1D2935)
private val PhoneBridgeGreen = Color(0xFF0B8F55)
private val PhoneBridgeOrange = Color(0xFFF57C00)
private val PhoneBridgeRed = Color(0xFFB3261E)
private val PhoneBridgeBlue = Color(0xFF1565C0)

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
    val bridgePrefs = remember { UhfBridgePrefs(context.applicationContext) }
    var bridgeEnabled by remember { mutableStateOf(bridgePrefs.enabled) }
    var showAdvancedSettings by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        if (bridgePrefs.enabled) {
            startBridge(context)
        }
    }

    val bridgeRunning = bridgeEnabled || bridgeStatus.running
    val channelControlsEnabled = !bridgeRunning && !radioState.isLoading && radioState.currentChannel != null

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
    ) {
        PhoneBridgeHeader(
            zoneName = radioState.currentZone?.name ?: if (radioState.isLoading) "LOADING" else "NO ZONE",
            channelName = radioState.currentChannel?.name ?: if (radioState.isLoading) "LOADING" else "NO CHANNEL",
            connected = radioState.isConnected,
            bridgeEnabled = bridgeEnabled,
            bridgeStatus = bridgeStatus.direction,
            bridgeMessage = bridgeStatus.message,
            inputDb = bridgeStatus.inputDb,
            wiredInput = bridgeStatus.wiredInput,
            wiredOutput = bridgeStatus.wiredOutput,
            controlsEnabled = channelControlsEnabled,
            onPreviousZone = radioViewModel::prevZone,
            onNextZone = radioViewModel::nextZone,
            onPreviousChannel = radioViewModel::prevChannel,
            onNextChannel = radioViewModel::nextChannel,
            onToggleBridge = {
                if (bridgeEnabled) {
                    bridgeEnabled = false
                    bridgePrefs.enabled = false
                    stopBridge(context)
                } else {
                    bridgeEnabled = true
                    bridgePrefs.enabled = true
                    startBridge(context)
                }
            },
            onAdvancedSettings = { showAdvancedSettings = true }
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

    if (showAdvancedSettings) {
        BridgeAdvancedSettingsDialog(
            prefs = bridgePrefs,
            bridgeEnabled = bridgeEnabled,
            onBridgeEnabledChanged = { enabled ->
                bridgeEnabled = enabled
                bridgePrefs.enabled = enabled
                if (enabled) startBridge(context) else stopBridge(context)
            },
            onApply = { reloadBridge(context) },
            onDismiss = { showAdvancedSettings = false }
        )
    }
}

@Composable
private fun PhoneBridgeHeader(
    zoneName: String,
    channelName: String,
    connected: Boolean,
    bridgeEnabled: Boolean,
    bridgeStatus: UhfBridgeDirection,
    bridgeMessage: String,
    inputDb: Float,
    wiredInput: Boolean,
    wiredOutput: Boolean,
    controlsEnabled: Boolean,
    onPreviousZone: () -> Unit,
    onNextZone: () -> Unit,
    onPreviousChannel: () -> Unit,
    onNextChannel: () -> Unit,
    onToggleBridge: () -> Unit,
    onAdvancedSettings: () -> Unit
) {
    val bridgeColor = when (bridgeStatus) {
        UhfBridgeDirection.RF_TO_POC -> PhoneBridgeGreen
        UhfBridgeDirection.POC_TO_RF -> PhoneBridgeOrange
        UhfBridgeDirection.ERROR -> PhoneBridgeRed
        UhfBridgeDirection.STARTING -> PhoneBridgeBlue
        UhfBridgeDirection.LOCKOUT -> Color(0xFF7A5A00)
        else -> if (bridgeEnabled) PhoneBridgeGreen else Color(0xFF546E7A)
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(PhoneBridgeDark)
            .border(2.dp, bridgeColor)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "COMMAND COMMS UHF BRIDGE",
                    color = Color.White,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Black,
                    fontFamily = FontFamily.Monospace
                )
                Text(
                    text = if (connected) "POC CONNECTED" else "POC CONNECTING",
                    color = if (connected) Color(0xFF4ADE80) else Color(0xFFFFC107),
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace
                )
            }
            Text(
                text = "${inputDb.roundToInt()} dB",
                color = Color.White,
                fontSize = 13.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CompactControlButton(
                text = "◀ ZONE",
                enabled = controlsEnabled,
                onClick = onPreviousZone,
                modifier = Modifier.weight(1f)
            )
            Column(
                modifier = Modifier.weight(1.4f),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("ZONE", color = Color(0xFF9FB3C8), fontSize = 9.sp)
                Text(
                    text = zoneName.uppercase(),
                    color = Color.White,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp,
                    maxLines = 1,
                    textAlign = TextAlign.Center
                )
            }
            CompactControlButton(
                text = "ZONE ▶",
                enabled = controlsEnabled,
                onClick = onNextZone,
                modifier = Modifier.weight(1f)
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CompactControlButton(
                text = "◀ CHANNEL",
                enabled = controlsEnabled,
                onClick = onPreviousChannel,
                modifier = Modifier.weight(1f)
            )
            Column(
                modifier = Modifier.weight(1.4f),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text("CHANNEL", color = Color(0xFF9FB3C8), fontSize = 9.sp)
                Text(
                    text = channelName.uppercase(),
                    color = Color.White,
                    fontWeight = FontWeight.Black,
                    fontSize = 15.sp,
                    maxLines = 1,
                    textAlign = TextAlign.Center
                )
            }
            CompactControlButton(
                text = "CHANNEL ▶",
                enabled = controlsEnabled,
                onClick = onNextChannel,
                modifier = Modifier.weight(1f)
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Button(
                onClick = onToggleBridge,
                enabled = channelName != "NO CHANNEL" && channelName != "LOADING",
                modifier = Modifier.weight(1f).height(42.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (bridgeEnabled) PhoneBridgeRed else PhoneBridgeGreen,
                    contentColor = Color.White
                )
            ) {
                Text(
                    text = if (bridgeEnabled) "STOP BRIDGE" else "START BRIDGE",
                    fontWeight = FontWeight.Black,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp
                )
            }
            OutlinedButton(
                onClick = onAdvancedSettings,
                modifier = Modifier.weight(0.65f).height(42.dp)
            ) {
                Text("VOX SETTINGS", fontSize = 10.sp, fontWeight = FontWeight.Bold)
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = bridgeMessage.ifBlank { if (bridgeEnabled) "Bridge enabled" else "Bridge stopped" },
                color = Color(0xFFD7E3EF),
                fontSize = 10.sp,
                maxLines = 1
            )
            Text(
                text = "CABLE IN ${if (wiredInput) "OK" else "--"}  OUT ${if (wiredOutput) "OK" else "--"}",
                color = if (wiredInput && wiredOutput) Color(0xFF4ADE80) else Color(0xFFFFC107),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold
            )
        }

        if (bridgeEnabled) {
            Text(
                text = "Stop Bridge Mode before changing zones or channels.",
                color = Color(0xFFFFD54F),
                fontSize = 10.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center
            )
        }
    }
}

@Composable
private fun CompactControlButton(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(38.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp, vertical = 2.dp)
    ) {
        Text(text, fontSize = 10.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun BridgeAdvancedSettingsDialog(
    prefs: UhfBridgePrefs,
    bridgeEnabled: Boolean,
    onBridgeEnabledChanged: (Boolean) -> Unit,
    onApply: () -> Unit,
    onDismiss: () -> Unit
) {
    val bridgeStatus by UhfBridgeRuntime.status.collectAsState()
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
        prefs.voxLeadInMs = voxLeadInMs.roundToInt()
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
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(PhoneBridgePanel)
                        .padding(10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            if (bridgeEnabled) "BRIDGE MODE ON" else "BRIDGE MODE OFF",
                            color = Color.White,
                            fontWeight = FontWeight.Black
                        )
                        Text(
                            bridgeStatus.message,
                            color = Color(0xFFD7E3EF),
                            fontSize = 11.sp
                        )
                    }
                    Button(
                        onClick = { onBridgeEnabledChanged(!bridgeEnabled) },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (bridgeEnabled) PhoneBridgeRed else PhoneBridgeGreen
                        )
                    ) {
                        Text(if (bridgeEnabled) "STOP" else "START")
                    }
                }

                BridgeSlider("Activation threshold", activationDb, -60f..-10f, 49, "${activationDb.roundToInt()} dB") {
                    activationDb = it
                    if (deactivationDb >= activationDb) deactivationDb = activationDb - 1f
                }
                BridgeSlider("Deactivation threshold", deactivationDb, -70f..-11f, 58, "${deactivationDb.roundToInt()} dB") {
                    deactivationDb = it.coerceAtMost(activationDb - 1f)
                }
                BridgeSlider("Trigger time", triggerMs, 20f..1_000f, 48, "${triggerMs.roundToInt()} ms") { triggerMs = it }
                BridgeSlider("Hang time", hangMs, 100f..3_000f, 57, "${hangMs.roundToInt()} ms") { hangMs = it }
                BridgeSlider("Post-TX lockout", lockoutMs, 0f..3_000f, 60, "${lockoutMs.roundToInt()} ms") { lockoutMs = it }
                BridgeSlider("Minimum TX", minimumTxMs, 100f..2_000f, 38, "${minimumTxMs.roundToInt()} ms") { minimumTxMs = it }
                BridgeSlider("Maximum TX", maximumTxSeconds, 10f..180f, 33, "${maximumTxSeconds.roundToInt()} sec") { maximumTxSeconds = it }
                BridgeSlider("Radio input gain", inputGain, 0.25f..4f, 14, String.format("%.2fx", inputGain)) { inputGain = it }
                BridgeSlider("Radio output gain", outputGain, 0.25f..4f, 14, String.format("%.2fx", outputGain)) { outputGain = it }
                BridgeSlider("Baofeng VOX lead-in", voxLeadInMs, 0f..1_000f, 40, "${voxLeadInMs.roundToInt()} ms") { voxLeadInMs = it }

                Spacer(Modifier.height(4.dp))
                Text(
                    "Current wired input: ${bridgeStatus.inputDb.roundToInt()} dB",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Bold
                )
            }
        },
        confirmButton = {
            Button(onClick = { save(); onDismiss() }) {
                Text("APPLY")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("CANCEL")
            }
        }
    )
}

@Composable
private fun BridgeSlider(
    label: String,
    value: Float,
    range: ClosedFloatingPointRange<Float>,
    steps: Int,
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
            valueRange = range,
            steps = steps
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
