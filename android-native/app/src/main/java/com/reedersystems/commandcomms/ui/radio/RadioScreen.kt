package com.reedersystems.commandcomms.ui.radio

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.ui.theme.*

@Composable
fun RadioScreen(
    onLogout: () -> Unit,
    viewModel: RadioViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ColorBackground)
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            RadioHeader(
                unitId = uiState.unitId,
                onLogout = { viewModel.logout(onLogout) }
            )

            if (uiState.isLoading) {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = ColorCyan)
                }
            } else if (uiState.error != null) {
                Text(
                    text = uiState.error ?: "",
                    color = ColorRed,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
            } else {
                ZoneChannelDisplay(
                    zoneName = uiState.currentZone?.name ?: "NO ZONE",
                    channelName = uiState.currentChannel?.name ?: "NO CHANNEL",
                    onPrevZone = viewModel::prevZone,
                    onNextZone = viewModel::nextZone,
                    onPrevChannel = viewModel::prevChannel,
                    onNextChannel = viewModel::nextChannel
                )

                Spacer(modifier = Modifier.weight(1f))

                ReadyBadge(unitId = uiState.unitId, username = uiState.username)

                Spacer(modifier = Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun RadioHeader(unitId: String, onLogout: () -> Unit) {
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
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = unitId.ifBlank { "UNIT" },
                color = ColorTextSecondary,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace
            )
            Spacer(modifier = Modifier.width(8.dp))
            IconButton(onClick = onLogout, modifier = Modifier.size(32.dp)) {
                Icon(
                    Icons.Default.Logout,
                    contentDescription = "Logout",
                    tint = ColorTextSecondary,
                    modifier = Modifier.size(18.dp)
                )
            }
        }
    }

    HorizontalDivider(color = Color(0xFF333333))
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
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "ZONE",
                color = ColorTextSecondary,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 2.sp
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onPrevZone, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.ChevronLeft, contentDescription = "Prev zone", tint = ColorCyan)
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
                    Icon(Icons.Default.ChevronRight, contentDescription = "Next zone", tint = ColorCyan)
                }
            }
        }

        HorizontalDivider(color = Color(0xFF333333))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "CHANNEL",
                color = ColorTextSecondary,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 2.sp
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onPrevChannel, modifier = Modifier.size(32.dp)) {
                    Icon(Icons.Default.KeyboardArrowUp, contentDescription = "Prev channel", tint = ColorCyan)
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
                    Icon(Icons.Default.KeyboardArrowDown, contentDescription = "Next channel", tint = ColorCyan)
                }
            }
        }
    }
}

@Composable
private fun ReadyBadge(unitId: String, username: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .border(1.dp, ColorGreen.copy(alpha = 0.4f), RoundedCornerShape(6.dp))
            .background(ColorGreen.copy(alpha = 0.08f), RoundedCornerShape(6.dp))
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(ColorGreen, shape = androidx.compose.foundation.shape.CircleShape)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = "CONNECTED",
                color = ColorGreen,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 2.sp
            )
        }
        Text(
            text = unitId.ifBlank { username },
            color = ColorTextSecondary,
            fontSize = 11.sp,
            fontFamily = FontFamily.Monospace
        )
    }

    Spacer(modifier = Modifier.height(8.dp))

    Text(
        text = "PTT, audio, and signaling will be added in the next build phase.",
        color = ColorTextSecondary,
        fontSize = 11.sp,
        textAlign = TextAlign.Center,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier.fillMaxWidth()
    )
}
