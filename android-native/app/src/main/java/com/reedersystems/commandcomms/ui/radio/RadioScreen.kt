package com.reedersystems.commandcomms.ui.radio

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
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
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.data.model.PttState

private val BgWhite   = Color(0xFFFFFFFF)
private val BgTopBar  = Color(0xFFF0F0F0)
private val BgBottom  = Color(0xFF1A1A1A)
private val BgEmerg   = Color(0xFFFF0000)
private val TextMain  = Color(0xFF111111)
private val TextMuted = Color(0xFF555555)
private val Green     = Color(0xFF008844)
private val Orange    = Color(0xFFFF7700)
private val Red       = Color(0xFFCC0000)
private val Amber     = Color(0xFFCC8800)
private val White     = Color.White

@Composable
fun RadioScreen(
    onLogout: () -> Unit,
    onOpenSettings: () -> Unit = {},
    viewModel: RadioViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    var showLogoutDialog by remember { mutableStateOf(false) }
    val context = LocalContext.current

    LifecycleResumeEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED
        viewModel.setMicPermissionGranted(granted)
        viewModel.recheckDndPermission()
        onPauseOrDispose {}
    }

    val infiniteTransition = rememberInfiniteTransition(label = "main")
    val flashAlpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.35f,
        animationSpec = infiniteRepeatable(tween(500), RepeatMode.Reverse),
        label = "flash"
    )

    val bgColor = if (state.myEmergencyActive)
        BgEmerg.copy(alpha = flashAlpha)
    else BgWhite

    if (state.showDndPermissionDialog) {
        AlertDialog(
            onDismissRequest = { viewModel.dismissDndPermissionDialog(userDeclined = true) },
            title = { androidx.compose.material3.Text("Do Not Disturb Override") },
            text = { androidx.compose.material3.Text("This app needs to override Do Not Disturb to deliver emergency alerts. Please grant notification policy access on the next screen.") },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.dismissDndPermissionDialog()
                    viewModel.openDndPermissionSettings(context as? Activity)
                }) { androidx.compose.material3.Text("GRANT ACCESS") }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.dismissDndPermissionDialog(userDeclined = true) }) {
                    androidx.compose.material3.Text("NOT NOW")
                }
            }
        )
    }

    if (showLogoutDialog) {
        AlertDialog(
            onDismissRequest = { showLogoutDialog = false },
            title = { androidx.compose.material3.Text("Are you sure?") },
            text = { androidx.compose.material3.Text("Sign out of Command Comms?") },
            confirmButton = {
                TextButton(onClick = {
                    showLogoutDialog = false
                    viewModel.logout(onLogout)
                }) { androidx.compose.material3.Text("ACCEPT") }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutDialog = false }) {
                    androidx.compose.material3.Text("DENY")
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

            state.emergencyHoldProgress?.let { progress ->
                EmergencyHoldBar(progress, state.isEmergencyCancelling)
            }

            if (state.isClearAir) {
                ClearAirBanner()
            }

            val otherEmergencyUnitId = state.channelEmergencyUnitId
            if (state.channelEmergencyActive && !state.myEmergencyActive && otherEmergencyUnitId != null) {
                OtherUnitEmergencyBanner(unitId = otherEmergencyUnitId)
            }

            CenterDisplay(
                state = state,
                modifier = Modifier.weight(1f)
            )

            BottomBar(
                state = state,
                onScnl = { viewModel.setShowScanOverlay(true) },
                onLogoutRequest = { showLogoutDialog = true },
                onOpenSettings = onOpenSettings
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
private fun EmergencyHoldBar(progress: Float, isCancelling: Boolean) {
    val label = if (isCancelling) "CANCEL" else "EMERGENCY"
    val barColor = if (isCancelling) Green else Red
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
private fun OtherUnitEmergencyBanner(unitId: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(Red)
            .padding(vertical = 12.dp),
        contentAlignment = Alignment.Center
    ) {
        T320Text(unitId, color = White, bold = true, size = 18)
    }
}

@Composable
private fun CenterDisplay(
    state: RadioUiState,
    modifier: Modifier = Modifier
) {
    val infiniteTransition = rememberInfiniteTransition(label = "center")
    val txAlpha by infiniteTransition.animateFloat(
        initialValue = 1f, targetValue = 0.5f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "txAlpha"
    )

    val isEmergency = state.myEmergencyActive
    val textColor = if (isEmergency) White else TextMain

    Box(
        modifier = modifier.fillMaxWidth(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            if (state.isLoading) {
                T320Text("---", color = textColor, bold = true, size = 24)
            } else if (state.error != null) {
                T320Text("ERROR", color = Red, bold = true, size = 16)
                T320Text(state.error, color = if (isEmergency) White else TextMuted, size = 10)
            } else {
                T320Text(
                    "ZN",
                    color = textColor.copy(alpha = 0.5f),
                    bold = false, size = 14
                )
                T320Text(
                    state.currentZone?.name?.uppercase() ?: "NO ZONE",
                    color = textColor.copy(alpha = 0.7f),
                    bold = true, size = 28
                )
                Spacer(Modifier.height(6.dp))
                T320Text(
                    "CH",
                    color = textColor.copy(alpha = 0.5f),
                    bold = false, size = 14
                )
                T320Text(
                    state.currentChannel?.name ?: "NO CH",
                    color = textColor,
                    bold = true, size = 50
                )

                when {
                    state.pttState == PttState.TRANSMITTING -> {
                        Spacer(Modifier.height(6.dp))
                        T320Text("TX", color = Green, bold = true, size = 18)
                    }
                    state.activeTransmittingUnit != null -> {
                        val rxUnitId = state.activeTransmittingUnit
                        Spacer(Modifier.height(6.dp))
                        T320Text(rxUnitId, color = Orange, bold = true, size = 14)
                    }
                    isEmergency -> {
                        Spacer(Modifier.height(6.dp))
                        T320Text(
                            "EMERGENCY",
                            color = White.copy(alpha = txAlpha),
                            bold = true, size = 16
                        )
                    }
                    else -> {}
                }
            }

            if (state.isKeyLocked) {
                Spacer(Modifier.height(4.dp))
                T320Text("KEYS LOCKED", color = if (isEmergency) White else Amber, bold = true, size = 10)
            }
        }
    }
}

@Composable
private fun BottomBar(
    state: RadioUiState,
    onScnl: () -> Unit,
    onLogoutRequest: () -> Unit,
    onOpenSettings: () -> Unit
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
        BottomBarButton(
            text = "SET",
            color = Color(0xFFE0E0E0),
            onClick = onOpenSettings
        )
        BottomBarButton(
            text = "LOGOUT",
            color = Color(0xFFFF4444),
            onClick = onLogoutRequest
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
