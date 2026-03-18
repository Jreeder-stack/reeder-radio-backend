package com.reedersystems.commandcomms.ui.radio

import androidx.compose.animation.core.*
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.data.model.PttState
import com.reedersystems.commandcomms.signaling.ConnectionState

private val BgWhite   = Color(0xFFFFFFFF)
private val BgTopBar  = Color(0xFFF0F0F0)
private val BgBottom  = Color(0xFF1A1A1A)
private val BgEmerg   = Color(0xFFFF0000)
private val TextMain  = Color(0xFF111111)
private val TextMuted = Color(0xFF555555)
private val Green     = Color(0xFF008844)
private val Red       = Color(0xFFCC0000)
private val Amber     = Color(0xFFCC8800)
private val White     = Color.White

@Composable
fun RadioScreen(
    onLogout: () -> Unit,
    viewModel: RadioViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    var showLogoutDialog by remember { mutableStateOf(false) }

    val infiniteTransition = rememberInfiniteTransition(label = "main")
    val flashAlpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.35f,
        animationSpec = infiniteRepeatable(tween(500), RepeatMode.Reverse),
        label = "flash"
    )

    val bgColor = if (state.myEmergencyActive)
        BgEmerg.copy(alpha = flashAlpha)
    else BgWhite

    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false },
            title = { androidx.compose.material3.Text("Sign Out") },
            text = { androidx.compose.material3.Text("Sign out of Command Comms?") },
            confirmButton = {
                TextButton(onClick = {
                    showLogoutDialog = false
                    viewModel.logout(onLogout)
                }) { androidx.compose.material3.Text("Sign Out") }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutDialog = false }) {
                    androidx.compose.material3.Text("Cancel")
                }
            }
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(bgColor)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {

            TopStatusBar(state)

            state.emergencyHoldProgress?.let { progress ->
                EmergencyHoldBar(progress, state.myEmergencyActive)
            }

            if (state.isClearAir) {
                ClearAirBanner()
            }

            CenterDisplay(
                state = state,
                onPttDown = viewModel::onPttDown,
                onPttUp = viewModel::onPttUp,
                modifier = Modifier.weight(1f)
            )

            EmergencyTouchButton(
                myEmergencyActive = state.myEmergencyActive,
                onHoldStart = viewModel::holdEmergencyStart,
                onHoldCancel = viewModel::holdEmergencyCancel
            )

            BottomBar(
                state = state,
                onScnl = { viewModel.setShowScanOverlay(true) },
                onCycleStatus = viewModel::cycleStatus,
                onLogoutRequest = { showLogoutDialog = true }
            )
        }

        if (state.showScanOverlay) {
            ScanOverlay(
                state = state,
                onToggleScanning = viewModel::toggleScanning,
                onToggleChannel = viewModel::toggleScanChannel,
                onDismiss = { viewModel.setShowScanOverlay(false) }
            )
        }
    }
}

@Composable
private fun TopStatusBar(state: RadioUiState) {
    val isEmergency = state.myEmergencyActive
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(if (isEmergency) Color.Transparent else BgTopBar)
            .padding(horizontal = 8.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        T320Text(state.clockTime, color = if (isEmergency) White else TextMuted, bold = true, size = 11)

        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (state.isKeyLocked) {
                T320Text("LCK", color = if (isEmergency) White else Amber, bold = true, size = 11)
            }
            if (state.isScanning) {
                T320Text("SCN", color = if (isEmergency) White else Green, bold = true, size = 11)
            }
            val dotColor = when {
                isEmergency -> White
                state.signalingState == ConnectionState.AUTHENTICATED -> Green
                else -> Red
            }
            T320Text(
                if (state.signalingState == ConnectionState.AUTHENTICATED) "●" else "○",
                color = dotColor, bold = true, size = 13
            )
            state.batteryLevel?.let { bat ->
                val batColor = when {
                    isEmergency -> White
                    bat <= 20 -> Red
                    else -> TextMuted
                }
                T320Text("$bat%", color = batColor, bold = true, size = 11)
            }
        }
    }
}

@Composable
private fun EmergencyHoldBar(progress: Float, isEmergency: Boolean) {
    val label = if (isEmergency) "CANCEL" else "EMERG"
    val barColor = if (isEmergency) Green else Red
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 10.dp, vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        T320Text(
            "HOLD... $label ${(progress * 100).toInt()}%",
            color = barColor, bold = true, size = 11
        )
        Spacer(Modifier.height(3.dp))
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(4.dp)
                .background(Color(0xFFDDDDDD))
        ) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(progress)
                    .fillMaxHeight()
                    .background(barColor)
            )
        }
    }
}

@Composable
private fun ClearAirBanner() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF0044CC))
            .padding(vertical = 4.dp),
        contentAlignment = Alignment.Center
    ) {
        T320Text("CLEAR AIR — EMERGENCY TRAFFIC ONLY", color = White, bold = true, size = 10)
    }
}

@Composable
private fun CenterDisplay(
    state: RadioUiState,
    onPttDown: () -> Unit,
    onPttUp: () -> Unit,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "center")
    val txAlpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.5f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "txAlpha"
    )
    val rxAlpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.65f,
        animationSpec = infiniteRepeatable(tween(900), RepeatMode.Reverse),
        label = "rxAlpha"
    )

    val isEmergency = state.myEmergencyActive
    val textColor = if (isEmergency) White else TextMain
    val pttEnabled = state.isConnected && state.currentChannel != null && !state.isKeyLocked

    Box(
        modifier = modifier
            .fillMaxWidth()
            .pointerInput(pttEnabled) {
                awaitEachGesture {
                    val down = awaitFirstDown()
                    down.consume()
                    if (pttEnabled) onPttDown()
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.all { !it.pressed }) {
                            event.changes.forEach { it.consume() }
                            if (pttEnabled) onPttUp()
                            break
                        }
                    } while (true)
                }
            },
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            when {
                state.isLoading -> {
                    T320Text("---", color = textColor, bold = true, size = 20)
                }
                state.error != null -> {
                    T320Text("ERROR", color = Red, bold = true, size = 16)
                    T320Text(state.error, color = if (isEmergency) White else TextMuted, size = 10)
                }
                state.pttState == PttState.TRANSMITTING -> {
                    T320Text(
                        "TX",
                        color = Red.copy(alpha = txAlpha),
                        bold = true, size = 36
                    )
                }
                isEmergency && state.activeTransmittingUnit == null -> {
                    T320Text(
                        "EMERGENCY",
                        color = White.copy(alpha = txAlpha),
                        bold = true, size = 22
                    )
                }
                else -> {
                    T320Text(
                        state.currentZone?.name?.uppercase() ?: "NO ZONE",
                        color = textColor.copy(alpha = 0.7f),
                        bold = true, size = 14
                    )
                    Spacer(Modifier.height(4.dp))
                    T320Text(
                        state.currentChannel?.name ?: if (state.isLoading) "---" else "NO CH",
                        color = textColor,
                        bold = true, size = 30
                    )
                    state.activeTransmittingUnit?.let { unitId ->
                        Spacer(Modifier.height(8.dp))
                        T320Text(
                            "ID: $unitId",
                            color = if (isEmergency) White else Green,
                            bold = true, size = 14
                        )
                        T320Text(
                            "RX",
                            color = (if (isEmergency) White else Green).copy(alpha = rxAlpha),
                            bold = true, size = 12
                        )
                    }
                }
            }

            if (state.pttState == PttState.IDLE && !isEmergency && state.activeTransmittingUnit == null) {
                Spacer(Modifier.height(16.dp))
                T320Text(
                    if (!pttEnabled) "SELECT CHANNEL" else "▼  HOLD TO TALK  ▼",
                    color = TextMuted,
                    size = 10
                )
            }

            if (state.isKeyLocked) {
                Spacer(Modifier.height(4.dp))
                T320Text("KEYS LOCKED", color = if (isEmergency) White else Amber, bold = true, size = 10)
            }
        }
    }
}

@Composable
private fun EmergencyTouchButton(
    myEmergencyActive: Boolean,
    onHoldStart: () -> Unit,
    onHoldCancel: () -> Unit
) {
    val label = if (myEmergencyActive) "HOLD TO CANCEL EMERGENCY" else "HOLD TO ACTIVATE EMERGENCY"
    val color = if (myEmergencyActive) Green else Red

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp)
            .background(color.copy(alpha = 0.12f))
            .border(1.dp, color.copy(alpha = 0.5f))
            .pointerInput(Unit) {
                awaitEachGesture {
                    awaitFirstDown().consume()
                    onHoldStart()
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.all { !it.pressed }) {
                            event.changes.forEach { it.consume() }
                            onHoldCancel()
                            break
                        }
                    } while (true)
                }
            },
        contentAlignment = Alignment.Center
    ) {
        T320Text(label, color = color, bold = true, size = 11)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BottomBar(
    state: RadioUiState,
    onScnl: () -> Unit,
    onCycleStatus: () -> Unit,
    onLogoutRequest: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(48.dp)
            .background(BgBottom)
            .padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.SpaceAround,
        verticalAlignment = Alignment.CenterVertically
    ) {
        BottomBarButton(
            text = "SCNL",
            color = if (state.isScanning) Color(0xFF00FF77) else Color(0xFFE0E0E0),
            onClick = onScnl
        )
        Box(
            modifier = Modifier
                .combinedClickable(
                    onClick = {},
                    onLongClick = onLogoutRequest
                )
                .padding(horizontal = 8.dp, vertical = 6.dp),
            contentAlignment = Alignment.Center
        ) {
            T320Text(state.clockTime, color = White, bold = true, size = 12)
        }
        BottomBarButton(
            text = STATUS_LABELS[state.currentStatus] ?: state.currentStatus.uppercase(),
            color = Color(0xFF00BBFF),
            onClick = onCycleStatus
        )
        state.batteryLevel?.let { bat ->
            BottomBarButton(
                text = "$bat%",
                color = if (bat <= 20) Color(0xFFFF3333) else White,
                onClick = {}
            )
        }
    }
}

@Composable
private fun BottomBarButton(text: String, color: Color, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center
    ) {
        T320Text(text, color = color, bold = true, size = 12)
    }
}

@Composable
private fun ScanOverlay(
    state: RadioUiState,
    onToggleScanning: () -> Unit,
    onToggleChannel: (Int) -> Unit,
    onDismiss: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(BgWhite)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(BgTopBar)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                T320Text("SCAN LIST", bold = true, size = 13)
                Box(
                    modifier = Modifier
                        .background(if (state.isScanning) Green else Color(0xFF888888))
                        .clickable(onClick = onToggleScanning)
                        .padding(horizontal = 10.dp, vertical = 3.dp)
                ) {
                    T320Text(if (state.isScanning) "ON" else "OFF", color = White, bold = true, size = 11)
                }
            }

            LazyColumn(modifier = Modifier.weight(1f)) {
                items(state.scanChannels) { ch ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onToggleChannel(ch.id) }
                            .background(if (ch.enabled) Color(0xFFE6F7E6) else Color.Transparent)
                            .padding(horizontal = 6.dp, vertical = 10.dp)
                            .border(0.dp, Color.Transparent),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        Box(
                            modifier = Modifier
                                .size(18.dp)
                                .background(if (ch.enabled) Color(0xFF00AA44) else Color.White)
                                .border(1.dp, Color(0xFF333333)),
                            contentAlignment = Alignment.Center
                        ) {
                            if (ch.enabled) {
                                T320Text("✓", color = White, bold = true, size = 12)
                            }
                        }
                        T320Text(
                            ch.name,
                            color = TextMain,
                            bold = ch.enabled,
                            size = 13
                        )
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(1.dp)
                            .background(Color(0xFFDDDDDD))
                    )
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(BgBottom)
                    .padding(vertical = 6.dp, horizontal = 4.dp),
                horizontalArrangement = Arrangement.SpaceAround
            ) {
                BottomBarButton("BACK", color = Color(0xFF00CC66), onClick = onDismiss)
                BottomBarButton(
                    "NONE",
                    color = Color(0xFFCCCCCC),
                    onClick = {
                        state.scanChannels.filter { it.enabled }
                            .forEach { onToggleChannel(it.id) }
                    }
                )
            }
        }
    }
}

@Composable
private fun T320Text(
    text: String,
    color: Color = TextMain,
    bold: Boolean = false,
    size: Int = 12
) {
    androidx.compose.material3.Text(
        text = text,
        color = color,
        fontSize = size.sp,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        fontFamily = FontFamily.Monospace,
        textAlign = TextAlign.Center
    )
}
