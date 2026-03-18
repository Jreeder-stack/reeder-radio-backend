package com.reedersystems.commandcomms.ui.radio

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
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
import com.reedersystems.commandcomms.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RadioScreen(
    onLogout: () -> Unit,
    viewModel: RadioViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    var showEmergencyDialog by remember { mutableStateOf(false) }
    var showClearEmergencyDialog by remember { mutableStateOf(false) }
    var showStatusSheet by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ColorBackground)
    ) {
        if (uiState.isClearAir) {
            ClearAirBanner(modifier = Modifier.align(Alignment.TopCenter))
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 12.dp)
                .let { if (uiState.isClearAir) it.padding(top = 32.dp) else it },
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            RadioHeader(
                unitId = uiState.unitId,
                signalingState = uiState.signalingState,
                currentStatus = uiState.currentStatus,
                onStatusClick = { showStatusSheet = true },
                onLogout = { viewModel.logout(onLogout) }
            )

            if (uiState.isLoading) {
                Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ColorCyan)
                }
            } else if (uiState.error != null) {
                Box(modifier = Modifier.weight(1f), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(text = uiState.error ?: "", color = ColorRed, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(8.dp))
                        Text("Check connection and try again", color = ColorTextSecondary, fontSize = 11.sp)
                    }
                }
            } else {
                ZoneChannelDisplay(
                    zoneName = uiState.currentZone?.name ?: "NO ZONE",
                    channelName = uiState.currentChannel?.name ?: "NO CHANNEL",
                    onPrevZone = viewModel::prevZone,
                    onNextZone = viewModel::nextZone,
                    onPrevChannel = viewModel::prevChannel,
                    onNextChannel = viewModel::nextChannel
                )

                if (uiState.activeTransmittingUnit != null) {
                    ActiveTransmitBanner(unitId = uiState.activeTransmittingUnit!!)
                }

                if (uiState.channelEmergencyActive) {
                    EmergencyBanner(isMyEmergency = uiState.myEmergencyActive)
                }

                Spacer(modifier = Modifier.weight(1f))

                PttButton(
                    pttState = uiState.pttState,
                    enabled = uiState.isConnected && uiState.currentChannel != null &&
                        !uiState.myEmergencyActive,
                    onPttDown = viewModel::onPttDown,
                    onPttUp = viewModel::onPttUp
                )

                Spacer(Modifier.height(12.dp))

                EmergencyButton(
                    myEmergencyActive = uiState.myEmergencyActive,
                    onActivate = { showEmergencyDialog = true },
                    onClear = { showClearEmergencyDialog = true }
                )

                Spacer(Modifier.height(8.dp))
            }
        }
    }

    if (showEmergencyDialog) {
        EmergencyConfirmDialog(
            onConfirm = {
                showEmergencyDialog = false
                viewModel.onEmergencyActivate()
            },
            onDismiss = { showEmergencyDialog = false }
        )
    }

    if (showClearEmergencyDialog) {
        AlertDialog(
            onDismissRequest = { showClearEmergencyDialog = false },
            title = { Text("Clear Emergency?", color = ColorTextPrimary) },
            text = { Text("This will notify dispatch that the emergency has been cleared.", color = ColorTextSecondary) },
            confirmButton = {
                TextButton(onClick = { showClearEmergencyDialog = false; viewModel.onEmergencyClear() }) {
                    Text("CLEAR", color = ColorGreen, fontFamily = FontFamily.Monospace)
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearEmergencyDialog = false }) {
                    Text("Cancel", color = ColorTextSecondary)
                }
            },
            containerColor = ColorSurface
        )
    }

    if (showStatusSheet) {
        StatusBottomSheet(
            currentStatus = uiState.currentStatus,
            onStatusSelected = { key -> viewModel.setStatus(key); showStatusSheet = false },
            onDismiss = { showStatusSheet = false }
        )
    }
}

@Composable
private fun RadioHeader(
    unitId: String,
    signalingState: ConnectionState,
    currentStatus: String,
    onStatusClick: () -> Unit,
    onLogout: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "COMMAND COMMS",
            color = ColorCyan,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 2.sp
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            SignalingIndicator(state = signalingState)
            Box(
                modifier = Modifier
                    .border(1.dp, Color(0xFF444444), RoundedCornerShape(4.dp))
                    .clickable(onClick = onStatusClick)
                    .padding(horizontal = 6.dp, vertical = 2.dp)
            ) {
                Text(
                    text = UNIT_STATUSES.find { it.first == currentStatus }?.second ?: currentStatus,
                    color = ColorTextSecondary,
                    fontSize = 9.sp,
                    fontFamily = FontFamily.Monospace
                )
            }
            Text(
                text = unitId.ifBlank { "UNIT" },
                color = ColorTextSecondary,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace
            )
            IconButton(onClick = onLogout, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Logout, contentDescription = "Logout", tint = ColorTextSecondary, modifier = Modifier.size(18.dp))
            }
        }
    }
    HorizontalDivider(color = Color(0xFF333333))
}

@Composable
private fun SignalingIndicator(state: ConnectionState) {
    val color = when (state) {
        ConnectionState.AUTHENTICATED -> ColorGreen
        ConnectionState.CONNECTED, ConnectionState.CONNECTING -> ColorAmber
        ConnectionState.DISCONNECTED -> ColorRed
    }
    val label = when (state) {
        ConnectionState.AUTHENTICATED -> "SIG"
        ConnectionState.CONNECTING -> "..."
        ConnectionState.CONNECTED -> "AUTH"
        ConnectionState.DISCONNECTED -> "OFF"
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(modifier = Modifier.size(6.dp).background(color, CircleShape))
        Text(text = label, color = color, fontSize = 9.sp, fontFamily = FontFamily.Monospace)
    }
}

@Composable
private fun ZoneChannelDisplay(
    zoneName: String,
    channelName: String,
    onPrevZone: () -> Unit,
    onNextZone: () -> Unit,
    onPrevChannel: () -> Unit,
    onNextChannel: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, Color(0xFF333333), RoundedCornerShape(8.dp))
            .background(ColorSurface, RoundedCornerShape(8.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("ZONE", color = ColorTextSecondary, fontSize = 10.sp, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onPrevZone, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.ChevronLeft, contentDescription = null, tint = ColorCyan)
                }
                Text(
                    text = zoneName,
                    color = ColorCyan,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.widthIn(min = 100.dp),
                    textAlign = TextAlign.Center
                )
                IconButton(onClick = onNextZone, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.ChevronRight, contentDescription = null, tint = ColorCyan)
                }
            }
        }
        HorizontalDivider(color = Color(0xFF333333))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("CH", color = ColorTextSecondary, fontSize = 10.sp, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onPrevChannel, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.KeyboardArrowUp, contentDescription = null, tint = ColorCyan)
                }
                Text(
                    text = channelName,
                    color = ColorTextPrimary,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.widthIn(min = 100.dp),
                    textAlign = TextAlign.Center
                )
                IconButton(onClick = onNextChannel, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.KeyboardArrowDown, contentDescription = null, tint = ColorCyan)
                }
            }
        }
    }
}

@Composable
private fun PttButton(
    pttState: PttState,
    enabled: Boolean,
    onPttDown: () -> Unit,
    onPttUp: () -> Unit
) {
    val isActive = pttState == PttState.TRANSMITTING || pttState == PttState.CONNECTING
    val isConnecting = pttState == PttState.CONNECTING

    val buttonColor by animateColorAsState(
        targetValue = when {
            isConnecting -> ColorAmber
            isActive -> ColorRed
            enabled -> Color(0xFF1A1A1A)
            else -> Color(0xFF0F0F0F)
        },
        animationSpec = tween(150),
        label = "pttColor"
    )
    val borderColor by animateColorAsState(
        targetValue = when {
            isConnecting -> ColorAmber
            isActive -> ColorRed
            enabled -> ColorCyan
            else -> Color(0xFF333333)
        },
        animationSpec = tween(150),
        label = "pttBorder"
    )
    val scale by animateFloatAsState(
        targetValue = if (isActive) 0.94f else 1.0f,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy),
        label = "pttScale"
    )

    val labelText = when (pttState) {
        PttState.CONNECTING -> "CONNECTING…"
        PttState.TRANSMITTING -> "TRANSMITTING"
        PttState.IDLE -> if (enabled) "PUSH TO TALK" else "SELECT CHANNEL"
    }
    val labelColor = when {
        isConnecting -> ColorAmber
        isActive -> ColorRed
        enabled -> ColorCyan
        else -> ColorTextSecondary
    }

    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = labelText,
            color = labelColor,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 3.sp
        )
        Box(
            modifier = Modifier
                .size(160.dp)
                .scale(scale)
                .clip(CircleShape)
                .background(buttonColor)
                .border(3.dp, borderColor, CircleShape)
                .pointerInput(enabled) {
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        if (enabled) { down.consume(); onPttDown() }
                        do {
                            val event = awaitPointerEvent()
                            val up = event.changes.all { !it.pressed }
                            if (up) {
                                event.changes.forEach { it.consume() }
                                if (enabled) onPttUp()
                                break
                            }
                        } while (true)
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Mic,
                contentDescription = "Push to Talk",
                tint = if (enabled) labelColor else ColorTextSecondary,
                modifier = Modifier.size(64.dp)
            )
        }
        if (isActive) {
            Text("RELEASE TO END", color = ColorTextSecondary, fontSize = 10.sp, fontFamily = FontFamily.Monospace, letterSpacing = 2.sp)
        }
    }
}

@Composable
private fun EmergencyButton(
    myEmergencyActive: Boolean,
    onActivate: () -> Unit,
    onClear: () -> Unit
) {
    val infiniteTransition = rememberInfiniteTransition(label = "eBtnPulse")
    val pulseAlpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = if (myEmergencyActive) 0.5f else 1f,
        animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
        label = "eBtnAlpha"
    )

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (myEmergencyActive) ColorRed.copy(alpha = pulseAlpha * 0.85f) else Color(0xFF1A0000))
            .border(2.dp, ColorRed.copy(alpha = if (myEmergencyActive) pulseAlpha else 0.6f), RoundedCornerShape(8.dp))
            .clickable(onClick = if (myEmergencyActive) onClear else onActivate),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center
    ) {
        Icon(
            Icons.Default.Warning,
            contentDescription = null,
            tint = if (myEmergencyActive) Color.White else ColorRed,
            modifier = Modifier.size(20.dp)
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text = if (myEmergencyActive) "CLEAR EMERGENCY" else "EMERGENCY",
            color = if (myEmergencyActive) Color.White else ColorRed,
            fontSize = 14.sp,
            fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 3.sp
        )
    }
}

@Composable
private fun EmergencyConfirmDialog(onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = { Icon(Icons.Default.Warning, contentDescription = null, tint = ColorRed, modifier = Modifier.size(32.dp)) },
        title = { Text("ACTIVATE EMERGENCY?", color = ColorRed, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Black, letterSpacing = 2.sp) },
        text = {
            Text(
                "This will broadcast an emergency alert to dispatch and all units on this channel. " +
                    "GPS tracking will begin immediately.",
                color = ColorTextSecondary,
                textAlign = TextAlign.Center
            )
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                colors = ButtonDefaults.buttonColors(containerColor = ColorRed)
            ) {
                Text("ACTIVATE", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = Color.White)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel", color = ColorTextSecondary)
            }
        },
        containerColor = ColorSurface
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StatusBottomSheet(
    currentStatus: String,
    onStatusSelected: (String) -> Unit,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        containerColor = ColorSurface
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Text(
                "STATUS",
                color = ColorTextSecondary,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 3.sp,
                modifier = Modifier.padding(bottom = 8.dp)
            )
            UNIT_STATUSES.forEach { (key, label) ->
                val isSelected = key == currentStatus
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (isSelected) ColorCyan.copy(alpha = 0.12f) else Color.Transparent)
                        .clickable { onStatusSelected(key) }
                        .padding(horizontal = 12.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = label,
                        color = if (isSelected) ColorCyan else ColorTextPrimary,
                        fontSize = 15.sp,
                        fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Normal
                    )
                    if (isSelected) {
                        Icon(Icons.Default.Check, contentDescription = null, tint = ColorCyan, modifier = Modifier.size(18.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun ActiveTransmitBanner(unitId: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(ColorAmber.copy(alpha = 0.12f), RoundedCornerShape(6.dp))
            .border(1.dp, ColorAmber.copy(alpha = 0.4f), RoundedCornerShape(6.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(Icons.Default.Radio, contentDescription = null, tint = ColorAmber, modifier = Modifier.size(16.dp))
        Text(
            text = "$unitId TRANSMITTING",
            color = ColorAmber,
            fontSize = 12.sp,
            fontWeight = FontWeight.Bold,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 1.sp
        )
    }
}

@Composable
private fun EmergencyBanner(isMyEmergency: Boolean) {
    val infiniteTransition = rememberInfiniteTransition(label = "emergency")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.3f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "emergencyAlpha"
    )
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(ColorRed.copy(alpha = alpha * 0.2f), RoundedCornerShape(6.dp))
            .border(1.dp, ColorRed.copy(alpha = alpha), RoundedCornerShape(6.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center
    ) {
        Icon(Icons.Default.Warning, contentDescription = null, tint = ColorRed, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            text = if (isMyEmergency) "YOUR EMERGENCY ACTIVE" else "EMERGENCY ACTIVE",
            color = ColorRed,
            fontSize = 12.sp,
            fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 2.sp
        )
    }
}

@Composable
private fun ClearAirBanner(modifier: Modifier = Modifier) {
    val infiniteTransition = rememberInfiniteTransition(label = "clearAir")
    val alpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.5f,
        animationSpec = infiniteRepeatable(tween(800), RepeatMode.Reverse),
        label = "clearAirAlpha"
    )
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(ColorAmber.copy(alpha = alpha * 0.9f))
            .padding(vertical = 8.dp),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "CLEAR AIR — EMERGENCY TRAFFIC ONLY",
            color = Color.Black,
            fontSize = 11.sp,
            fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 2.sp
        )
    }
}
