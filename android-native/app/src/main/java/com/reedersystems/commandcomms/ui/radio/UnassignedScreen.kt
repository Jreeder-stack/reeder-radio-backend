package com.reedersystems.commandcomms.ui.radio

import android.util.Log
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel

private const val TAG = "[UnassignedScreen]"

@Composable
fun UnassignedScreen(
    radioId: String,
    onAssigned: (unitId: String) -> Unit,
    onLocked: () -> Unit,
    viewModel: RadioSocketViewModel = viewModel()
) {
    val event by viewModel.radioEvent.collectAsStateWithLifecycle()
    var assignedUnit by remember { mutableStateOf<String?>(null) }
    var showAssignedOverlay by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        Log.d(TAG, "Connecting socket for radioId=$radioId")
        viewModel.connect()
    }

    LaunchedEffect(event) {
        when (val e = event) {
            is RadioSocketEvent.Assigned -> {
                Log.d(TAG, "radio:assigned received unitId=${e.unitId}")
                assignedUnit = e.unitId
                showAssignedOverlay = true
                onAssigned(e.unitId)
            }
            is RadioSocketEvent.Locked -> {
                Log.d(TAG, "radio:locked received")
                onLocked()
            }
            null -> {}
            else -> {}
        }
    }

    DisposableEffect(Unit) {
        onDispose { viewModel.disconnect() }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0A0A)),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(horizontal = 32.dp)
        ) {
            Text(
                text = "STATEWIDE CONSTABLE",
                color = Color.White,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp,
                textAlign = TextAlign.Center
            )
            Text(
                text = "RADIO SYSTEM",
                color = Color.White,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp,
                textAlign = TextAlign.Center
            )

            Spacer(modifier = Modifier.height(32.dp))

            Text(
                text = radioId.padStart(6, '0'),
                color = Color(0xFFAAAAAA),
                fontSize = 36.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 8.sp,
                textAlign = TextAlign.Center
            )

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = "UNASSIGNED",
                color = Color(0xFF555555),
                fontSize = 12.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp,
                textAlign = TextAlign.Center
            )
        }

        AnimatedVisibility(
            visible = showAssignedOverlay,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.fillMaxSize()
        ) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xCC000000)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "Assigned — Unit ${assignedUnit ?: ""}",
                    color = Color.White,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}
