package com.reedersystems.commandcomms.ui.radio

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
import com.reedersystems.commandcomms.data.model.PttState

private val PhoneBg = Color(0xFFF4F6F8)
private val CardBorder = Color(0xFFD8DDE3)
private val Accent = Color(0xFF3295B9)
private val Danger = Color(0xFFD92D27)
private val Muted = Color(0xFF667085)
private val Ink = Color(0xFF111827)

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
    var showAudio by remember { mutableStateOf(false) }
    var showReadiness by remember { mutableStateOf(false) }
    var showMore by remember { mutableStateOf(false) }

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
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item { StatusCard(state, viewModel::cycleStatus) }
            item {
                ChannelCard(
                    state = state,
                    onPrevZone = viewModel::prevZone,
                    onNextZone = viewModel::nextZone,
                    onPrevChannel = viewModel::prevChannel,
                    onNextChannel = viewModel::nextChannel
                )
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    QuickTile("Scan Lists", Icons.Default.List, Modifier.weight(1f)) { showScan = true }
                    QuickTile("Audio", Icons.Default.Headphones, Modifier.weight(1f)) { showAudio = true }
                    QuickTile("More", Icons.Default.MoreHoriz, Modifier.weight(1f)) { showMore = true }
                }
            }
            item { MessagesCard() }
            item {
                EmergencyButton(
                    active = state.myEmergencyActive,
                    onDown = { app.keyEventFlow.tryEmit(KeyAction.EmergencyDown) },
                    onUp = { app.keyEventFlow.tryEmit(KeyAction.EmergencyUp) }
                )
            }
            item { PttButton(state = state, onDown = viewModel::onPttDown, onUp = viewModel::onPttUp) }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FunctionTile("Person", "Query", Modifier.weight(1f))
                    FunctionTile("Vehicle", "Query", Modifier.weight(1f))
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FunctionTile("None", "F3", Modifier.weight(1f))
                    FunctionTile("None", "F4", Modifier.weight(1f))
                }
            }
            item { FunctionTile("Weather", "", Modifier.fillMaxWidth(), tall = true) }
            item {
                OutlinedButton(
                    onClick = { showReadiness = true },
                    modifier = Modifier.fillMaxWidth().height(54.dp),
                    shape = RoundedCornerShape(10.dp)
                ) {
                    Icon(Icons.Default.VerifiedUser, null)
                    Spacer(Modifier.width(8.dp))
                    Text("RADIO READINESS")
                }
            }
        }
    }

    if (showScan) ScanSheet(state, viewModel, onDismiss = { showScan = false })
    if (showAudio) AudioRouteSheet(onDismiss = { showAudio = false })
    if (showReadiness) ReadinessSheet(onDismiss = { showReadiness = false })
    if (showMore) MoreSheet(onSettings = onSettings, onReadiness = {
        showMore = false
        showReadiness = true
    }, onDismiss = { showMore = false })

    if (state.showPageAlert) {
        PageAlertOverlay(
            message = state.pageAlertMessage,
            sender = state.pageAlertSender,
            onDismiss = viewModel::dismissPageAlert
        )
    }
}

@Composable
private fun StatusCard(state: RadioUiState, onCycleStatus: () -> Unit) {
    val connected = state.isConnected
    val border = if (connected) CardBorder else Color(0xFFFF8585)
    val bg = if (connected) Color.White else Color(0xFFFFF3F3)
    Card(
        colors = CardDefaults.cardColors(containerColor = bg),
        border = androidx.compose.foundation.BorderStroke(1.dp, border),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column {
                Text("My Status", color = Muted, fontWeight = FontWeight.SemiBold)
                Text(
                    if (connected) (STATUS_LABELS[state.currentStatus] ?: state.currentStatus.uppercase()) else "CAD DISCONNECTED",
                    color = if (connected) Ink else Danger,
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp
                )
            }
            TextButton(onClick = onCycleStatus) {
                Text(if (connected) "Change" else "No CAD connection", color = if (connected) Accent else Color(0xFF98A2B3))
            }
        }
    }
}

@Composable
private fun ChannelCard(
    state: RadioUiState,
    onPrevZone: () -> Unit,
    onNextZone: () -> Unit,
    onPrevChannel: () -> Unit,
    onNextChannel: () -> Unit
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Color.White),
        elevation = CardDefaults.cardElevation(2.dp),
        shape = RoundedCornerShape(10.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(modifier = Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text(state.currentZone?.name ?: "Bull's Eye", color = Muted, fontWeight = FontWeight.SemiBold)
                Text(state.currentChannel?.name ?: "DISPATCH", color = Color.Black, fontWeight = FontWeight.Black, fontSize = 28.sp)
                Spacer(Modifier.height(32.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (state.isConnected) Icons.Default.Wifi else Icons.Default.WifiOff, null, tint = if (state.isConnected) Accent else Danger, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(if (state.isConnected) "CONNECTED" else "CAD", color = if (state.isConnected) Accent else Danger, fontSize = 13.sp)
                }
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ChannelStepper("ZN", onPrevZone, onNextZone)
                    ChannelStepper("CH", onPrevChannel, onNextChannel)
                }
            }
        }
    }
}

@Composable
private fun ChannelStepper(label: String, onUp: () -> Unit, onDown: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        OutlinedIconButton(onClick = onUp, modifier = Modifier.size(56.dp), shape = RoundedCornerShape(8.dp)) { Icon(Icons.Default.KeyboardArrowUp, null) }
        Text(label, color = Muted, modifier = Modifier.padding(vertical = 4.dp))
        OutlinedIconButton(onClick = onDown, modifier = Modifier.size(56.dp), shape = RoundedCornerShape(8.dp)) { Icon(Icons.Default.KeyboardArrowDown, null) }
    }
}

@Composable
private fun QuickTile(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, modifier: Modifier, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = modifier.height(126.dp), colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(2.dp)) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(icon, null, tint = Accent, modifier = Modifier.size(34.dp))
            Spacer(Modifier.height(8.dp))
            Text(label, color = Color(0xFF344054), fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun MessagesCard() {
    Card(colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(2.dp), modifier = Modifier.fillMaxWidth()) {
        Column {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.ChatBubbleOutline, null, tint = Accent)
                Spacer(Modifier.width(10.dp))
                Column {
                    Text("Messages", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                    Text("No new messages", color = Muted)
                }
            }
            HorizontalDivider(color = CardBorder)
            Row(Modifier.fillMaxWidth()) {
                TextButton(onClick = {}, modifier = Modifier.weight(1f)) { Text("+  New Conversation", color = Accent) }
                VerticalDivider(Modifier.height(52.dp), color = CardBorder)
                TextButton(onClick = {}, modifier = Modifier.weight(1f)) { Text("✉  All Messages", color = Accent) }
            }
        }
    }
}

@Composable
private fun EmergencyButton(active: Boolean, onDown: () -> Unit, onUp: () -> Unit) {
    val label = if (active) "HOLD TO CLEAR EMERGENCY" else "EMERGENCY"
    Surface(
        modifier = Modifier.fillMaxWidth().height(82.dp).pointerInput(active) {
            detectTapGestures(onPress = {
                onDown()
                tryAwaitRelease()
                onUp()
            })
        },
        color = if (active) Color(0xFFFFE9E7) else Color.White,
        shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, if (active) Danger else CardBorder),
        shadowElevation = 2.dp
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Icon(Icons.Default.WarningAmber, null, tint = Danger)
            Spacer(Modifier.width(10.dp))
            Text(label, color = Danger, fontWeight = FontWeight.Bold, fontSize = 18.sp)
        }
    }
}

@Composable
private fun PttButton(state: RadioUiState, onDown: () -> Unit, onUp: () -> Unit) {
    val tx = state.pttState == PttState.TRANSMITTING
    Surface(
        modifier = Modifier.fillMaxWidth().height(96.dp).pointerInput(state.micPermissionGranted, state.isChannelBusy) {
            detectTapGestures(onPress = {
                onDown()
                tryAwaitRelease()
                onUp()
            })
        },
        color = if (tx) Accent.copy(alpha = 0.18f) else Color.White,
        shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(if (tx) 2.dp else 1.dp, if (tx) Accent else CardBorder),
        shadowElevation = 2.dp
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Icon(Icons.Default.Mic, null, tint = Accent, modifier = Modifier.size(30.dp))
            Spacer(Modifier.width(12.dp))
            Text(if (tx) "TRANSMITTING" else "HOLD TO TALK", color = Accent, fontWeight = FontWeight.Bold, fontSize = 19.sp)
        }
    }
}

@Composable
private fun FunctionTile(label: String, sublabel: String, modifier: Modifier, tall: Boolean = false) {
    Card(modifier = modifier.height(if (tall) 180.dp else 114.dp), colors = CardDefaults.cardColors(containerColor = Color.White), elevation = CardDefaults.cardElevation(2.dp)) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(label, color = Color(0xFF344054), fontWeight = FontWeight.Bold, fontSize = 18.sp)
                if (sublabel.isNotBlank()) Text(sublabel, color = Muted, fontSize = 16.sp)
            }
        }
    }
}

@Composable
private fun ScanSheet(state: RadioUiState, viewModel: RadioViewModel, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("Scan Lists", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Switch(checked = state.isScanning, onCheckedChange = { viewModel.toggleScanning() })
        }
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp).padding(12.dp)) {
            items(state.scanChannels) { ch ->
                Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = ch.enabled, onCheckedChange = { viewModel.toggleScanChannel(ch.id) })
                    Text(ch.name, modifier = Modifier.weight(1f))
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

private data class AudioRoute(val id: Int, val name: String, val device: AudioDeviceInfo?)

@Composable
private fun AudioRouteSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val audioManager = remember { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    var refresh by remember { mutableIntStateOf(0) }
    val routes = remember(refresh) { availableRoutes(context, audioManager) }
    var selectedName by remember { mutableStateOf(currentRouteName(audioManager)) }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("Audio Route", fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 20.dp))
        Text("Choose where radio traffic plays and which communication microphone Android pairs with it.", color = Muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        routes.forEach { route ->
            ListItem(
                headlineContent = { Text(route.name) },
                leadingContent = { Icon(routeIcon(route.device), null, tint = Accent) },
                trailingContent = { if (selectedName == route.name) Icon(Icons.Default.CheckCircle, null, tint = Accent) },
                modifier = Modifier.padding(horizontal = 8.dp)
            )
            TextButton(onClick = {
                applyRoute(audioManager, route)
                selectedName = route.name
                refresh++
            }, modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) { Text("Use ${route.name}") }
            HorizontalDivider()
        }
        Spacer(Modifier.height(24.dp))
    }
}

private fun availableRoutes(context: Context, am: AudioManager): List<AudioRoute> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) {
        val devices = am.availableCommunicationDevices
        if (devices.isNotEmpty()) {
            return devices.map { AudioRoute(it.id, deviceLabel(it), it) }
        }
    }
    return listOf(
        AudioRoute(-1, "Phone speaker", null),
        AudioRoute(-2, "Phone earpiece", null),
        AudioRoute(-3, "Bluetooth / headset", null)
    )
}

private fun deviceLabel(d: AudioDeviceInfo): String = when (d.type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Phone speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Phone earpiece"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> "Bluetooth: ${d.productName}"
    AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired: ${d.productName}"
    AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_DEVICE -> "USB: ${d.productName}"
    else -> d.productName?.toString()?.takeIf { it.isNotBlank() } ?: "Audio device"
}

private fun routeIcon(d: AudioDeviceInfo?) = when (d?.type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET, AudioDeviceInfo.TYPE_BLE_SPEAKER -> Icons.Default.Bluetooth
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> Icons.Default.VolumeUp
    else -> Icons.Default.Headphones
}

private fun currentRouteName(am: AudioManager): String {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        am.communicationDevice?.let(::deviceLabel) ?: "Automatic"
    } else if (am.isSpeakerphoneOn) "Phone speaker" else "Automatic"
}

@Suppress("DEPRECATION")
private fun applyRoute(am: AudioManager, route: AudioRoute) {
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && route.device != null) {
        am.setCommunicationDevice(route.device)
        return
    }
    when (route.id) {
        -1 -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false; am.isSpeakerphoneOn = true }
        -2 -> { am.stopBluetoothSco(); am.isBluetoothScoOn = false; am.isSpeakerphoneOn = false }
        -3 -> { am.isSpeakerphoneOn = false; am.startBluetoothSco(); am.isBluetoothScoOn = true }
    }
}

@Composable
private fun ReadinessSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val activity = context as? Activity
    var refresh by remember { mutableIntStateOf(0) }
    val notificationManager = remember { context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager }
    val powerManager = remember { context.getSystemService(Context.POWER_SERVICE) as PowerManager }

    val runtimeLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh++ }
    val mic = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    val notifications = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    val bluetooth = Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    val dnd = notificationManager.isNotificationPolicyAccessGranted
    val battery = powerManager.isIgnoringBatteryOptimizations(context.packageName)
    val fullScreen = Build.VERSION.SDK_INT < 34 || notificationManager.canUseFullScreenIntent()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Radio Readiness", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text("Emergency paging depends on these Android settings. Green means the phone is ready.", color = Muted)
            ReadinessRow("Microphone / PTT", mic) {
                val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
                if (Build.VERSION.SDK_INT >= 31) perms += Manifest.permission.BLUETOOTH_CONNECT
                if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
                runtimeLauncher.launch(perms.toTypedArray())
            }
            ReadinessRow("Notifications", notifications) {
                if (Build.VERSION.SDK_INT >= 33) runtimeLauncher.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                else context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
            }
            ReadinessRow("Bluetooth audio", bluetooth) {
                if (Build.VERSION.SDK_INT >= 31) runtimeLauncher.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT))
            }
            ReadinessRow("Do Not Disturb bypass", dnd) { context.startActivity(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS)) }
            ReadinessRow("Unrestricted battery", battery) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
                context.startActivity(intent)
            }
            ReadinessRow("Full-screen emergency alerts", fullScreen) {
                if (Build.VERSION.SDK_INT >= 34) {
                    context.startActivity(Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENTS", Uri.parse("package:${context.packageName}")))
                }
            }
            OutlinedButton(onClick = { refresh++ }, modifier = Modifier.fillMaxWidth()) { Text("RECHECK") }
            Button(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("DONE") }
            Spacer(Modifier.height(24.dp))
        }
    }

    LifecycleResumeEffect(refresh) { onPauseOrDispose { refresh++ } }
}

@Composable
private fun ReadinessRow(label: String, ready: Boolean, onFix: () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = if (ready) Color(0xFFF0FFF4) else Color(0xFFFFFAEB)), modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(if (ready) Icons.Default.CheckCircle else Icons.Default.ErrorOutline, null, tint = if (ready) Color(0xFF079455) else Color(0xFFDC6803))
            Spacer(Modifier.width(10.dp))
            Text(label, modifier = Modifier.weight(1f), fontWeight = FontWeight.SemiBold)
            if (!ready) TextButton(onClick = onFix) { Text("FIX") }
        }
    }
}

@Composable
private fun MoreSheet(onSettings: (() -> Unit)?, onReadiness: () -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        ListItem(headlineContent = { Text("Radio Readiness") }, leadingContent = { Icon(Icons.Default.VerifiedUser, null) }, modifier = Modifier.padding(horizontal = 8.dp))
        TextButton(onClick = onReadiness, modifier = Modifier.fillMaxWidth()) { Text("Open readiness check") }
        HorizontalDivider()
        ListItem(headlineContent = { Text("Settings") }, leadingContent = { Icon(Icons.Default.Settings, null) }, modifier = Modifier.padding(horizontal = 8.dp))
        TextButton(onClick = { onDismiss(); onSettings?.invoke() }, modifier = Modifier.fillMaxWidth()) { Text("Open settings") }
        Spacer(Modifier.height(24.dp))
    }
}
