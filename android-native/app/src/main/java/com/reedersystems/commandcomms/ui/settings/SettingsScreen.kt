package com.reedersystems.commandcomms.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.reedersystems.commandcomms.data.prefs.PttKeyPrefs
import com.reedersystems.commandcomms.data.prefs.SpeakerBoostPrefs
import kotlin.math.roundToInt

private val BgDark = Color(0xFF006633)
private val BgBottom = Color(0xFF1A1A1A)
private val White = Color.White
private val Green = Color(0xFF00CC66)
private val Amber = Color(0xFFCC8800)
private val TextMuted = Color(0xFFAABBAA)
private val CaptureOverlayBg = Color(0xCC000000)

@Composable
fun SettingsScreen(
    pttKeyPrefs: PttKeyPrefs,
    speakerBoostPrefs: SpeakerBoostPrefs,
    isDeviceOwner: Boolean,
    isKioskActive: Boolean,
    kioskEnabled: Boolean,
    pinSet: Boolean,
    onKioskToggle: (Boolean) -> Unit,
    onSetPin: (String) -> Boolean,
    onClearPin: () -> Unit,
    onExitKiosk: (String) -> Boolean,
    isCapturing: Boolean,
    onStartCapture: () -> Unit,
    onStopCapture: () -> Unit,
    onBack: () -> Unit
) {
    var volumePttEnabled by remember { mutableStateOf(pttKeyPrefs.volumeButtonPttEnabled) }
    var customKeyLabel by remember { mutableStateOf(pttKeyPrefs.customKeyLabel) }
    var customKeyCode by remember { mutableStateOf(pttKeyPrefs.customKeyCode) }
    var receiveBoostMb by remember { mutableStateOf(speakerBoostPrefs.receiveBoostMb.toFloat()) }
    var pagerBoostMb by remember { mutableStateOf(speakerBoostPrefs.pagerBoostMb.toFloat()) }
    var amplifier by remember { mutableStateOf(speakerBoostPrefs.softwareAmplifier) }

    LaunchedEffect(isCapturing) {
        if (!isCapturing) {
            customKeyLabel = pttKeyPrefs.customKeyLabel
            customKeyCode = pttKeyPrefs.customKeyCode
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(BgDark)
    ) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFF004422))
                    .padding(horizontal = 12.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                SettingsText("SETTINGS", bold = true, size = 16)
                Box(
                    modifier = Modifier
                        .clickable(onClick = onBack)
                        .background(Green)
                        .padding(horizontal = 14.dp, vertical = 4.dp)
                ) {
                    SettingsText("BACK", color = Color.Black, bold = true, size = 12)
                }
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                SettingsText("PTT KEY MAPPING", color = Green, bold = true, size = 13)

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column {
                        SettingsText("VOLUME BUTTON PTT", bold = true, size = 12)
                        SettingsText("Use Volume Up as PTT", color = TextMuted, size = 10)
                    }
                    Switch(
                        checked = volumePttEnabled,
                        onCheckedChange = { enabled ->
                            volumePttEnabled = enabled
                            pttKeyPrefs.volumeButtonPttEnabled = enabled
                        },
                        colors = SwitchDefaults.colors(
                            checkedThumbColor = Green,
                            checkedTrackColor = Color(0xFF003311),
                            uncheckedThumbColor = Color(0xFF888888),
                            uncheckedTrackColor = Color(0xFF333333)
                        )
                    )
                }

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(Color(0xFF338855))
                )

                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SettingsText("CUSTOM PTT KEY", bold = true, size = 12)
                    SettingsText(
                        if (customKeyCode > 0) "Mapped: $customKeyLabel"
                        else "None",
                        color = if (customKeyCode > 0) Amber else TextMuted,
                        size = 11
                    )

                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(
                            modifier = Modifier
                                .clickable(onClick = onStartCapture)
                                .background(Color(0xFF004422))
                                .padding(horizontal = 14.dp, vertical = 6.dp)
                        ) {
                            SettingsText("CAPTURE KEY", color = Green, bold = true, size = 11)
                        }
                        if (customKeyCode > 0) {
                            Box(
                                modifier = Modifier
                                    .clickable {
                                        pttKeyPrefs.customKeyCode = -1
                                        pttKeyPrefs.customKeyLabel = ""
                                        customKeyCode = -1
                                        customKeyLabel = ""
                                    }
                                    .background(Color(0xFF442200))
                                    .padding(horizontal = 14.dp, vertical = 6.dp)
                            ) {
                                SettingsText("CLEAR", color = Color(0xFFFF6644), bold = true, size = 11)
                            }
                        }
                    }
                }

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(Color(0xFF338855))
                )

                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    SettingsText("DEFAULT PTT KEYS", bold = true, size = 12)
                    SettingsText("T320 F11 (141), Key 230 — always active", color = TextMuted, size = 10)
                }

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(Color(0xFF338855))
                )

                SettingsText("SPEAKER BOOST", color = Green, bold = true, size = 13)

                BoostSlider(
                    title = "RECEIVE BOOST",
                    valueDb = receiveBoostMb / 100f,
                    onValueChange = { db ->
                        val mb = (db * 100f).roundToInt()
                        receiveBoostMb = mb.toFloat()
                        speakerBoostPrefs.receiveBoostMb = mb
                    },
                    helper = "Adds extra loudness on top of the system volume. Higher values may distort on quiet voices."
                )

                BoostSlider(
                    title = "PAGER TONE BOOST",
                    valueDb = pagerBoostMb / 100f,
                    onValueChange = { db ->
                        val mb = (db * 100f).roundToInt()
                        pagerBoostMb = mb.toFloat()
                        speakerBoostPrefs.pagerBoostMb = mb
                    },
                    helper = "Boosts the dispatcher pager tone. Higher values are louder but may sound harsh."
                )

                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        SettingsText("SOFTWARE AMPLIFIER", bold = true, size = 12)
                        SettingsText("${formatAmp(amplifier)}x", color = Amber, bold = true, size = 12)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SpeakerBoostPrefs.AMPLIFIER_STEPS.forEach { step ->
                            val selected = kotlin.math.abs(amplifier - step) < 0.01f
                            Box(
                                modifier = Modifier
                                    .clickable {
                                        amplifier = step
                                        speakerBoostPrefs.softwareAmplifier = step
                                    }
                                    .background(if (selected) Green else Color(0xFF004422))
                                    .padding(horizontal = 14.dp, vertical = 6.dp)
                            ) {
                                SettingsText(
                                    "${formatAmp(step)}x",
                                    color = if (selected) Color.Black else Green,
                                    bold = true,
                                    size = 11
                                )
                            }
                        }
                    }
                    SettingsText(
                        "Software gain applied to incoming voice. Built-in limiter prevents clipping.",
                        color = TextMuted,
                        size = 10
                    )
                }

                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(Color(0xFF338855))
                )

                KioskSection(
                    isDeviceOwner = isDeviceOwner,
                    isKioskActive = isKioskActive,
                    kioskEnabled = kioskEnabled,
                    pinSet = pinSet,
                    onKioskToggle = onKioskToggle,
                    onSetPin = onSetPin,
                    onClearPin = onClearPin,
                    onExitKiosk = onExitKiosk
                )
            }
        }

        if (isCapturing) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(CaptureOverlayBg)
                    .clickable(onClick = onStopCapture),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    SettingsText("PRESS ANY KEY NOW...", color = Green, bold = true, size = 18)
                    SettingsText("Tap screen to cancel", color = TextMuted, size = 11)
                }
            }
        }
    }
}

@Composable
private fun KioskSection(
    isDeviceOwner: Boolean,
    isKioskActive: Boolean,
    kioskEnabled: Boolean,
    pinSet: Boolean,
    onKioskToggle: (Boolean) -> Unit,
    onSetPin: (String) -> Boolean,
    onClearPin: () -> Unit,
    onExitKiosk: (String) -> Boolean
) {
    var pinInput by remember { mutableStateOf("") }
    var confirmInput by remember { mutableStateOf("") }
    var pinFeedback by remember { mutableStateOf<String?>(null) }
    var pinFeedbackOk by remember { mutableStateOf(false) }

    var exitInput by remember { mutableStateOf("") }
    var exitFeedback by remember { mutableStateOf<String?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        SettingsText("KIOSK MODE", color = Green, bold = true, size = 13)

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            SettingsText("Device Owner", bold = true, size = 11)
            SettingsText(
                if (isDeviceOwner) "YES" else "NO",
                color = if (isDeviceOwner) Green else Color(0xFFFF6644),
                bold = true,
                size = 11
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            SettingsText("Kiosk Active", bold = true, size = 11)
            SettingsText(
                if (isKioskActive) "ON" else "OFF",
                color = if (isKioskActive) Green else TextMuted,
                bold = true,
                size = 11
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            SettingsText("Admin PIN", bold = true, size = 11)
            SettingsText(
                if (pinSet) "SET" else "NOT SET",
                color = if (pinSet) Green else Amber,
                bold = true,
                size = 11
            )
        }

        if (!isDeviceOwner) {
            SettingsText(
                "This device is not provisioned as Device Owner. Kiosk lock cannot be enabled. " +
                    "See KIOSK_PROVISIONING.md to enroll the device via ADB or QR code.",
                color = TextMuted,
                size = 10
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                SettingsText("ENABLE KIOSK MODE", bold = true, size = 12)
                SettingsText(
                    if (isDeviceOwner) "Lock the device to this app on next resume."
                    else "Requires Device Owner provisioning.",
                    color = TextMuted,
                    size = 10
                )
            }
            Switch(
                enabled = isDeviceOwner && pinSet,
                checked = kioskEnabled,
                onCheckedChange = { enabled -> onKioskToggle(enabled) },
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Green,
                    checkedTrackColor = Color(0xFF003311),
                    uncheckedThumbColor = Color(0xFF888888),
                    uncheckedTrackColor = Color(0xFF333333),
                    disabledCheckedThumbColor = Color(0xFF555555),
                    disabledCheckedTrackColor = Color(0xFF222222),
                    disabledUncheckedThumbColor = Color(0xFF555555),
                    disabledUncheckedTrackColor = Color(0xFF222222)
                )
            )
        }
        if (isDeviceOwner && !pinSet) {
            SettingsText(
                "Set an admin PIN below before enabling kiosk mode.",
                color = Amber,
                size = 10
            )
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Color(0xFF338855))
        )

        SettingsText("ADMIN PIN", bold = true, size = 12)
        SettingsText(
            "4–12 digits. Used to exit kiosk mode and to disable the lock.",
            color = TextMuted,
            size = 10
        )

        OutlinedTextField(
            value = pinInput,
            onValueChange = { pinInput = it.filter { ch -> ch.isDigit() }.take(12) },
            label = { SettingsText("New PIN", color = TextMuted, size = 10) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            colors = pinFieldColors(),
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = confirmInput,
            onValueChange = { confirmInput = it.filter { ch -> ch.isDigit() }.take(12) },
            label = { SettingsText("Confirm PIN", color = TextMuted, size = 10) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            colors = pinFieldColors(),
            modifier = Modifier.fillMaxWidth()
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(
                modifier = Modifier
                    .clickable {
                        when {
                            pinInput.length < 4 -> {
                                pinFeedback = "PIN must be at least 4 digits."
                                pinFeedbackOk = false
                            }
                            pinInput != confirmInput -> {
                                pinFeedback = "PINs do not match."
                                pinFeedbackOk = false
                            }
                            else -> {
                                val ok = onSetPin(pinInput)
                                if (ok) {
                                    pinInput = ""
                                    confirmInput = ""
                                    pinFeedback = "PIN saved."
                                    pinFeedbackOk = true
                                } else {
                                    pinFeedback = "Failed to save PIN."
                                    pinFeedbackOk = false
                                }
                            }
                        }
                    }
                    .background(Color(0xFF004422))
                    .padding(horizontal = 14.dp, vertical = 6.dp)
            ) {
                SettingsText(
                    if (pinSet) "CHANGE PIN" else "SET PIN",
                    color = Green,
                    bold = true,
                    size = 11
                )
            }
            if (pinSet) {
                Box(
                    modifier = Modifier
                        .clickable {
                            if (kioskEnabled) {
                                pinFeedback = "Disable kiosk mode before clearing the PIN."
                                pinFeedbackOk = false
                            } else {
                                onClearPin()
                                pinFeedback = "PIN cleared."
                                pinFeedbackOk = true
                            }
                        }
                        .background(Color(0xFF442200))
                        .padding(horizontal = 14.dp, vertical = 6.dp)
                ) {
                    SettingsText("CLEAR", color = Color(0xFFFF6644), bold = true, size = 11)
                }
            }
        }
        pinFeedback?.let { msg ->
            SettingsText(
                msg,
                color = if (pinFeedbackOk) Green else Color(0xFFFF6644),
                size = 10
            )
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(Color(0xFF338855))
        )

        SettingsText("EXIT KIOSK", bold = true, size = 12)
        SettingsText(
            "Enter the admin PIN to turn kiosk mode off.",
            color = TextMuted,
            size = 10
        )
        OutlinedTextField(
            value = exitInput,
            onValueChange = { exitInput = it.filter { ch -> ch.isDigit() }.take(12) },
            label = { SettingsText("Admin PIN", color = TextMuted, size = 10) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            colors = pinFieldColors(),
            modifier = Modifier.fillMaxWidth(),
            enabled = pinSet
        )
        Box(
            modifier = Modifier
                .clickable(enabled = pinSet) {
                    val ok = onExitKiosk(exitInput)
                    if (ok) {
                        exitInput = ""
                        exitFeedback = "Kiosk disabled."
                    } else {
                        exitFeedback = "Incorrect PIN."
                    }
                }
                .background(if (pinSet) Color(0xFF442200) else Color(0xFF222222))
                .padding(horizontal = 14.dp, vertical = 8.dp)
        ) {
            SettingsText(
                "EXIT KIOSK",
                color = if (pinSet) Color(0xFFFF6644) else TextMuted,
                bold = true,
                size = 12
            )
        }
        exitFeedback?.let { msg ->
            SettingsText(
                msg,
                color = if (msg.startsWith("Kiosk disabled")) Green else Color(0xFFFF6644),
                size = 10
            )
        }
    }
}

@Composable
private fun pinFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = White,
    unfocusedTextColor = White,
    disabledTextColor = TextMuted,
    cursorColor = Green,
    focusedBorderColor = Green,
    unfocusedBorderColor = Color(0xFF338855),
    disabledBorderColor = Color(0xFF335544)
)

@Composable
private fun BoostSlider(
    title: String,
    valueDb: Float,
    onValueChange: (Float) -> Unit,
    helper: String
) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            SettingsText(title, bold = true, size = 12)
            SettingsText("+${"%.1f".format(valueDb)} dB", color = Amber, bold = true, size = 12)
        }
        Slider(
            value = valueDb,
            onValueChange = onValueChange,
            valueRange = 0f..12f,
            steps = 23,
            colors = SliderDefaults.colors(
                thumbColor = Green,
                activeTrackColor = Green,
                inactiveTrackColor = Color(0xFF003311)
            )
        )
        SettingsText(helper, color = TextMuted, size = 10)
    }
}

private fun formatAmp(value: Float): String {
    val rounded = (value * 10f).roundToInt() / 10f
    return if (rounded == rounded.toInt().toFloat()) "${rounded.toInt()}.0" else "%.1f".format(rounded)
}

@Composable
private fun SettingsText(
    text: String,
    color: Color = White,
    bold: Boolean = false,
    size: Int = 12
) {
    Text(
        text = text,
        color = color,
        fontSize = size.sp,
        fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
        fontFamily = FontFamily.Monospace,
        textAlign = TextAlign.Start
    )
}
