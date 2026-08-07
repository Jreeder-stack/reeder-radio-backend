package com.reedersystems.commandcomms.ui.radio

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.MailOutline
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material.icons.filled.VerifiedUser
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material.icons.filled.WifiOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.KeyAction
import com.reedersystems.commandcomms.MainActivity
import com.reedersystems.commandcomms.data.model.PttState

private val PhoneBg = Color(0xFFF3F4F6)
private val CardBorder = Color(0xFFD9DEE5)
private val Accent = Color(0xFF1595C5)
private val Danger = Color(0xFFD92D27)
private val Muted = Color(0xFF667085)
private val Ink = Color(0xFF111827)
private val Success = Color(0xFF16A34A)

/**
 * Native handset screen. The main radio deck intentionally has NO scrolling.
 * Its order and proportions mirror the mobile-browser RadioDeckView:
 * status -> channel -> Scan/Contacts/More -> Messages -> Emergency -> PTT -> function buttons.
 */
@Composable
fun PhoneRadioScreen(
    onLocked: (() -> Unit)? = null,
    onUnassigned: (() -> Unit)? = null,
    onReassigned: ((String) -> Unit)? = null,
    onSettings: (() -> Unit)? = null,
    assignedFromUnit: String? = null,
    viewModel: RadioViewModel = viewModel()
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val app = context.applicationContext as CommandCommsApp

    var showScan by remember { mutableStateOf(false) }
    var showContacts by remember { mutableStateOf(false) }
    var showMore by remember { mutableStateOf(false) }
    var showAudio by remember { mutableStateOf(false) }
    var showReadiness by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }

    LaunchedEffect(state.isRadioLocked) { if (state.isRadioLocked) onLocked?.invoke() }
    LaunchedEffect(state.isRadioUnassigned) {
        if (state.isRadioUnassigned) {
            viewModel.consumeRadioUnassigned()
            onUnassigned?.invoke()
        }
    }
    LaunchedEffect(state.reassignedUnitId) {
        state.reassignedUnitId?.let {
            viewModel.consumeReassigned()
            onReassigned?.invoke(it)
        }
    }

    LifecycleResumeEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        viewModel.setMicPermissionGranted(granted)
        onPauseOrDispose { }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = PhoneBg) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val tight = maxHeight < 720.dp
            val gap = if (tight) 4.dp else 6.dp
            val pad = if (tight) 6.dp else 8.dp

            Column(
                modifier = Modifier.fillMaxSize().padding(pad),
                verticalArrangement = Arrangement.spacedBy(gap)
            ) {
                if (state.isClearAir) {
                    ClearAirBanner(Modifier.weight(0.34f))
                }

                StatusCard(state, viewModel::cycleStatus, Modifier.weight(0.70f))
                ChannelCard(
                    state,
                    viewModel::prevZone,
                    viewModel::nextZone,
                    viewModel::prevChannel,
                    viewModel::nextChannel,
                    Modifier.weight(1.42f)
                )

                Row(
                    modifier = Modifier.fillMaxWidth().weight(0.76f),
                    horizontalArrangement = Arrangement.spacedBy(gap)
                ) {
                    QuickTile("Scan Lists", Icons.Default.List, Modifier.weight(1f)) { showScan = true }
                    QuickTile("Contacts", Icons.Default.PhoneAndroid, Modifier.weight(1f)) { showContacts = true }
                    QuickTile("More", Icons.Default.MoreHoriz, Modifier.weight(1f)) { showMore = true }
                }

                MessagesCard(Modifier.weight(0.82f))
                EmergencyButton(
                    state,
                    Modifier.weight(0.52f),
                    { app.keyEventFlow.tryEmit(KeyAction.EmergencyDown) },
                    { app.keyEventFlow.tryEmit(KeyAction.EmergencyUp) }
                )
                PttButton(state, Modifier.weight(0.72f), viewModel::onPttDown, viewModel::onPttUp)
                FunctionGrid(Modifier.weight(1.18f))
            }
        }
    }

    if (showScan) ScanSheet(state, viewModel) { showScan = false }
    if (showContacts) SimpleSheet("Contacts", "Unit contacts will appear here.") { showContacts = false }
    if (showAudio) AudioRouteSheet { showAudio = false }
    if (showReadiness) ReadinessSheet { showReadiness = false }

    if (showMore) {
        MoreSheet(
            onAudio = { showMore = false; showAudio = true },
            onReadiness = { showMore = false; showReadiness = true },
            onSettings = { showMore = false; onSettings?.invoke() },
            onLogout = { showMore = false; confirmLogout = true },
            onDismiss = { showMore = false }
        )
    }

    if (confirmLogout) {
        AlertDialog(
            onDismissRequest = { confirmLogout = false },
            title = { Text("Log out of Command Comms?") },
            text = { Text("This signs out the current user and stops their background radio connection. This phone keeps its permanent device identity and device settings.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLogout = false
                    viewModel.logout {
                        val restart = Intent(context, MainActivity::class.java).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        }
                        context.startActivity(restart)
                    }
                }) { Text("LOG OUT", color = Danger, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("CANCEL") } }
        )
    }

    if (state.showPageAlert) {
        AlertDialog(
            onDismissRequest = viewModel::dismissPageAlert,
            icon = { Icon(Icons.Default.WarningAmber, null, tint = Danger) },
            title = { Text(state.pageAlertSender.ifBlank { "DISPATCH" }) },
            text = { Text(state.pageAlertMessage) },
            confirmButton = { TextButton(onClick = viewModel::dismissPageAlert) { Text("ACKNOWLEDGE") } }
        )
    }
}

@Composable
private fun ClearAirBanner(modifier: Modifier) {
    Surface(modifier = modifier.fillMaxWidth(), color = Color(0xFF1D4ED8), shape = RoundedCornerShape(8.dp)) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("CLEAR AIR — EMERGENCY TRAFFIC ONLY", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        }
    }
}

@Composable
private fun StatusCard(state: RadioUiState, onCycle: () -> Unit, modifier: Modifier) {
    val connected = state.isConnected
    Card(
        onClick = onCycle,
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = if (connected) Color.White else Color(0xFFFFF3F3)),
        border = BorderStroke(1.dp, if (connected) CardBorder else Color(0xFFFFA3A3)),
        shape = RoundedCornerShape(9.dp)
    ) {
        Row(
            Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column {
                Text("My Status", color = Muted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                Text(
                    if (connected) STATUS_LABELS[state.currentStatus].orEmpty().ifBlank { state.currentStatus.uppercase() } else "CAD DISCONNECTED",
                    color = if (connected) Ink else Danger,
                    fontSize = 18.sp,
                    fontWeight = FontWeight.Bold
                )
            }
            Text(if (connected) "Tap to cycle" else "No CAD connection", color = Color(0xFF98A2B3), fontSize = 10.sp)
        }
    }
}

@Composable
private fun ChannelCard(
    state: RadioUiState,
    onPrevZone: () -> Unit,
    onNextZone: () -> Unit,
    onPrevChannel: () -> Unit,
    onNextChannel: () -> Unit,
    modifier: Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = Color.White),
        border = BorderStroke(1.dp, CardBorder),
        shape = RoundedCornerShape(9.dp)
    ) {
        Row(Modifier.fillMaxSize().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.Center) {
                Text(state.currentZone?.name ?: "---", color = Muted, fontSize = 11.sp, fontWeight = FontWeight.Medium)
                Text(state.currentChannel?.name ?: "NO CHANNEL", color = Ink, fontSize = 23.sp, fontWeight = FontWeight.Black, maxLines = 1)
                if (state.activeTransmittingUnit != null) {
                    Text("RX: ${state.activeTransmittingUnit}", color = Accent, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                }
                Spacer(Modifier.weight(1f))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (state.isScanning) Text("SCAN  ", color = Success, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    if (state.myEmergencyActive) Text("EMERG  ", color = Danger, fontSize = 10.sp, fontWeight = FontWeight.Bold)
                    Icon(if (state.isConnected) Icons.Default.Wifi else Icons.Default.WifiOff, null, tint = if (state.isConnected) Success else Danger, modifier = Modifier.size(13.dp))
                    Spacer(Modifier.width(3.dp))
                    Text("CAD", color = if (state.isConnected) Success else Danger, fontSize = 10.sp)
                }
            }
            Spacer(Modifier.width(6.dp))
            ChannelStepper("ZN", onNextZone, onPrevZone)
            Spacer(Modifier.width(5.dp))
            ChannelStepper("CH", onNextChannel, onPrevChannel)
        }
    }
}

@Composable
private fun ChannelStepper(label: String, onUp: () -> Unit, onDown: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        OutlinedIconButton(onClick = onUp, modifier = Modifier.size(36.dp), shape = RoundedCornerShape(6.dp), contentPadding = PaddingValues(0.dp)) {
            Icon(Icons.Default.KeyboardArrowUp, null, modifier = Modifier.size(21.dp))
        }
        Text(label, color = Muted, fontSize = 9.sp, modifier = Modifier.padding(vertical = 1.dp))
        OutlinedIconButton(onClick = onDown, modifier = Modifier.size(36.dp), shape = RoundedCornerShape(6.dp), contentPadding = PaddingValues(0.dp)) {
            Icon(Icons.Default.KeyboardArrowDown, null, modifier = Modifier.size(21.dp))
        }
    }
}

@Composable
private fun QuickTile(label: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = modifier.fillMaxHeight(), colors = CardDefaults.cardColors(containerColor = Color.White), border = BorderStroke(1.dp, CardBorder), shape = RoundedCornerShape(9.dp)) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(icon, null, tint = Accent, modifier = Modifier.size(22.dp))
            Spacer(Modifier.height(3.dp))
            Text(label, color = Color(0xFF475467), fontSize = 10.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
        }
    }
}

@Composable
private fun MessagesCard(modifier: Modifier) {
    Card(modifier = modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = Color.White), border = BorderStroke(1.dp, CardBorder), shape = RoundedCornerShape(9.dp)) {
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.weight(1f).padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.ChatBubbleOutline, null, tint = Accent, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(7.dp))
                Column {
                    Text("Messages", color = Ink, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                    Text("No new messages", color = Muted, fontSize = 10.sp)
                }
            }
            HorizontalDivider(color = CardBorder)
            Row(Modifier.weight(0.68f).fillMaxWidth()) {
                TextButton(onClick = {}, modifier = Modifier.weight(1f), contentPadding = PaddingValues(0.dp)) {
                    Text("+  New Conversation", color = Accent, fontSize = 10.sp)
                }
                VerticalDivider(Modifier.fillMaxHeight(), color = CardBorder)
                TextButton(onClick = {}, modifier = Modifier.weight(1f), contentPadding = PaddingValues(0.dp)) {
                    Icon(Icons.Default.MailOutline, null, tint = Accent, modifier = Modifier.size(13.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("All Messages", color = Accent, fontSize = 10.sp)
                }
            }
        }
    }
}

@Composable
private fun EmergencyButton(state: RadioUiState, modifier: Modifier, onDown: () -> Unit, onUp: () -> Unit) {
    val progress = state.emergencyHoldProgress?.coerceIn(0f, 1f)
    val label = when {
        state.isEmergencyCancelling && progress != null -> "HOLD TO CANCEL  ${(progress * 100).toInt()}%"
        state.emergencyArming -> "EMERGENCY ARMING  ${state.emergencyArmingSecondsRemaining}"
        state.myEmergencyActive -> "EMERGENCY ACTIVE — HOLD TO CLEAR"
        else -> "EMERGENCY"
    }
    val active = state.myEmergencyActive || state.emergencyArming || state.isEmergencyCancelling
    Surface(
        modifier = modifier.fillMaxWidth().pointerInput(active) {
            detectTapGestures(onPress = {
                onDown()
                tryAwaitRelease()
                onUp()
            })
        },
        color = if (active) Color(0xFFFFECEA) else Color.White,
        shape = RoundedCornerShape(9.dp),
        border = BorderStroke(if (active) 2.dp else 1.dp, Danger)
    ) {
        Box(Modifier.fillMaxSize()) {
            if (progress != null) {
                Box(Modifier.fillMaxHeight().fillMaxWidth(progress).background(Danger.copy(alpha = 0.12f)))
            }
            Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
                Icon(Icons.Default.WarningAmber, null, tint = Danger, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(label, color = Danger, fontWeight = FontWeight.Bold, fontSize = 11.sp)
            }
        }
    }
}

@Composable
private fun PttButton(state: RadioUiState, modifier: Modifier, onDown: () -> Unit, onUp: () -> Unit) {
    val tx = state.pttState == PttState.TRANSMITTING
    Surface(
        modifier = modifier.fillMaxWidth().pointerInput(state.micPermissionGranted, state.isChannelBusy) {
            detectTapGestures(onPress = {
                onDown()
                tryAwaitRelease()
                onUp()
            })
        },
        color = if (tx) Accent.copy(alpha = 0.16f) else Color.White,
        shape = RoundedCornerShape(9.dp),
        border = BorderStroke(if (tx) 2.dp else 1.dp, if (tx) Accent else CardBorder)
    ) {
        Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Icon(Icons.Default.Mic, null, tint = Accent, modifier = Modifier.size(22.dp))
            Spacer(Modifier.width(7.dp))
            Text(if (tx) "TRANSMITTING" else "HOLD TO TALK", color = Accent, fontWeight = FontWeight.Bold, fontSize = 13.sp)
        }
    }
}

@Composable
private fun FunctionGrid(modifier: Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            FunctionTile("Person", "Query", Modifier.weight(1f))
            FunctionTile("Vehicle", "Query", Modifier.weight(1f))
        }
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            FunctionTile("None", "F3", Modifier.weight(1f))
            FunctionTile("None", "F4", Modifier.weight(1f))
        }
    }
}

@Composable
private fun FunctionTile(label: String, sublabel: String, modifier: Modifier) {
    Card(modifier = modifier.fillMaxHeight(), colors = CardDefaults.cardColors(containerColor = Color.White), border = BorderStroke(1.dp, CardBorder), shape = RoundedCornerShape(9.dp)) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(label, color = Color(0xFF344054), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                Text(sublabel, color = Muted, fontSize = 10.sp)
            }
        }
    }
}

@Composable
private fun ScanSheet(state: RadioUiState, viewModel: RadioViewModel, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Scan Lists", fontSize = 21.sp, fontWeight = FontWeight.Bold)
            Switch(checked = state.isScanning, onCheckedChange = { viewModel.toggleScanning() })
        }
        LazyColumn(Modifier.fillMaxWidth().height(420.dp).padding(12.dp)) {
            items(state.scanChannels) { ch ->
                Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = ch.enabled, onCheckedChange = { viewModel.toggleScanChannel(ch.id) })
                    Text(ch.name, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun SimpleSheet(title: String, body: String, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(20.dp)) {
            Text(title, fontSize = 21.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(10.dp))
            Text(body, color = Muted)
            Spacer(Modifier.height(28.dp))
        }
    }
}

private data class AudioRoute(val id: Int, val name: String, val device: AudioDeviceInfo?)

@Composable
private fun AudioRouteSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val audioManager = remember { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    var selected by remember { mutableStateOf(currentRouteName(audioManager)) }
    val routes = remember { availableRoutes(audioManager) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("Audio", fontSize = 21.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp))
        Text("Current route: $selected", color = Muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        routes.forEach { route ->
            ListItem(
                headlineContent = { Text(route.name) },
                leadingContent = { Icon(routeIcon(route.device), null, tint = Accent) },
                trailingContent = { if (selected == route.name) Text("SELECTED", color = Success, fontSize = 10.sp, fontWeight = FontWeight.Bold) },
                modifier = Modifier.fillMaxWidth().pointerInput(route.id) {
                    detectTapGestures(onTap = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            if (route.device == null) audioManager.clearCommunicationDevice() else audioManager.setCommunicationDevice(route.device)
                        }
                        selected = currentRouteName(audioManager)
                    })
                }
            )
        }
        Spacer(Modifier.height(24.dp))
    }
}

private fun availableRoutes(audioManager: AudioManager): List<AudioRoute> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return listOf(AudioRoute(-1, "Phone", null))
    val result = mutableListOf(AudioRoute(-1, "Phone", null))
    audioManager.availableCommunicationDevices.forEach { d ->
        val name = when (d.type) {
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth — ${d.productName}"
            AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired — ${d.productName}"
            AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB — ${d.productName}"
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Phone Earpiece"
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Phone Speaker"
            else -> d.productName?.toString()?.ifBlank { "Audio device" } ?: "Audio device"
        }
        result.add(AudioRoute(d.id, name, d))
    }
    return result.distinctBy { it.id }
}

private fun currentRouteName(audioManager: AudioManager): String {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "Phone"
    val d = audioManager.communicationDevice ?: return "Phone"
    return when (d.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> "Bluetooth — ${d.productName}"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired — ${d.productName}"
        AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB — ${d.productName}"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Phone Earpiece"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Phone Speaker"
        else -> d.productName?.toString() ?: "Phone"
    }
}

private fun routeIcon(device: AudioDeviceInfo?): ImageVector = when (device?.type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> Icons.Default.Bluetooth
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> Icons.Default.Headphones
    AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> Icons.Default.Usb
    else -> Icons.Default.PhoneAndroid
}

@Composable
private fun MoreSheet(
    onAudio: () -> Unit,
    onReadiness: () -> Unit,
    onSettings: () -> Unit,
    onLogout: () -> Unit,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("More", fontSize = 21.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        ListItem(headlineContent = { Text("Audio") }, leadingContent = { Icon(Icons.Default.Headphones, null, tint = Accent) }, modifier = Modifier.pointerInput(Unit) { detectTapGestures(onTap = { onAudio() }) })
        ListItem(headlineContent = { Text("Radio Readiness") }, leadingContent = { Icon(Icons.Default.VerifiedUser, null, tint = Accent) }, modifier = Modifier.pointerInput(Unit) { detectTapGestures(onTap = { onReadiness() }) })
        ListItem(headlineContent = { Text("Settings") }, leadingContent = { Icon(Icons.Default.Settings, null, tint = Accent) }, modifier = Modifier.pointerInput(Unit) { detectTapGestures(onTap = { onSettings() }) })
        HorizontalDivider()
        ListItem(headlineContent = { Text("Logout", color = Danger, fontWeight = FontWeight.Bold) }, leadingContent = { Icon(Icons.Default.Logout, null, tint = Danger) }, modifier = Modifier.pointerInput(Unit) { detectTapGestures(onTap = { onLogout() }) })
        Spacer(Modifier.height(22.dp))
    }
}

@Composable
private fun ReadinessSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val mic = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val notifications = if (Build.VERSION.SDK_INT >= 33) ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED else true
    val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
    val unrestricted = power.isIgnoringBatteryOptimizations(context.packageName)
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("Radio Readiness", fontSize = 21.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp))
        ReadinessRow("Microphone", mic)
        ReadinessRow("Notifications", notifications)
        ReadinessRow("Unrestricted battery", unrestricted)
        ReadinessRow("Persistent phone identity", true)
        Spacer(Modifier.height(8.dp))
        OutlinedButton(
            onClick = {
                val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                }
                context.startActivity(intent)
            },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp)
        ) { Text("OPEN APP SETTINGS") }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun ReadinessRow(label: String, ready: Boolean) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label)
        Text(if (ready) "READY" else "NEEDS ATTENTION", color = if (ready) Success else Danger, fontWeight = FontWeight.Bold, fontSize = 11.sp)
    }
}
