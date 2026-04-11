package com.reedersystems.commandcomms.ui.radio

import android.util.Log
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
import com.reedersystems.commandcomms.ui.theme.ColorRed

private const val TAG = "[LockedScreen]"

@Composable
fun LockedScreen(
    radioId: String,
    onUnlocked: () -> Unit,
    viewModel: RadioSocketViewModel = viewModel()
) {
    val event by viewModel.radioEvent.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        Log.d(TAG, "LockedScreen — listening for radio:unlocked radioId=$radioId")
        viewModel.connect()
    }

    LaunchedEffect(event) {
        if (event is RadioSocketEvent.Unlocked) {
            Log.d(TAG, "radio:unlocked received — recovering")
            onUnlocked()
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
                text = "RADIO LOCKED",
                color = ColorRed,
                fontSize = 28.sp,
                fontWeight = FontWeight.Black,
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
        }
    }
}
