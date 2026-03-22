package com.reedersystems.commandcomms.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.reedersystems.commandcomms.data.prefs.PttKeyPrefs

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
    isCapturing: Boolean,
    onStartCapture: () -> Unit,
    onStopCapture: () -> Unit,
    onBack: () -> Unit
) {
    var volumePttEnabled by remember { mutableStateOf(pttKeyPrefs.volumeButtonPttEnabled) }
    var customKeyLabel by remember { mutableStateOf(pttKeyPrefs.customKeyLabel) }
    var customKeyCode by remember { mutableStateOf(pttKeyPrefs.customKeyCode) }

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
