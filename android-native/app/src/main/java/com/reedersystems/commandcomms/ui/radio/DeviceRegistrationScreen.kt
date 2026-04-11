package com.reedersystems.commandcomms.ui.radio

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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

private const val UNABLE_TO_READ_PLACEHOLDER = "Unable to read automatically — please enter manually"

@Composable
fun DeviceRegistrationScreen(
    onRegistrationSuccess: () -> Unit,
    viewModel: DeviceRegistrationViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    val deviceIdentity by viewModel.deviceIdentity.collectAsStateWithLifecycle()

    LaunchedEffect(uiState) {
        if (uiState is RegistrationUiState.Success) {
            onRegistrationSuccess()
        }
    }

    var serial by remember { mutableStateOf("") }
    var imei by remember { mutableStateOf("") }

    LaunchedEffect(deviceIdentity) {
        deviceIdentity?.let { id ->
            if (id.serial != null) serial = id.serial
            if (id.imei != null) imei = id.imei
        }
    }

    val isLoading = uiState is RegistrationUiState.Loading
    val errorMessage = (uiState as? RegistrationUiState.Error)?.message

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ColorBackground),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .imePadding()
                .padding(horizontal = 32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(0.dp)
        ) {
            Text(
                text = "DEVICE",
                color = ColorPrimary,
                fontSize = 28.sp,
                fontWeight = FontWeight.Black,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 6.sp
            )
            Text(
                text = "REGISTRATION",
                color = ColorPrimary,
                fontSize = 28.sp,
                fontWeight = FontWeight.Black,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp
            )
            Text(
                text = "REEDER SYSTEMS",
                color = ColorTextSecondary,
                fontSize = 10.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 4.sp
            )

            Spacer(modifier = Modifier.height(28.dp))

            Text(
                text = "SERIAL NUMBER",
                color = ColorTextSecondary,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 2.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp)
            )

            val serialAutoFilled = deviceIdentity?.serial != null
            OutlinedTextField(
                value = serial,
                onValueChange = {
                    serial = it
                    if (errorMessage != null) viewModel.clearError()
                },
                placeholder = {
                    Text(
                        text = UNABLE_TO_READ_PLACEHOLDER,
                        color = ColorTextSecondary,
                        fontSize = 12.sp
                    )
                },
                singleLine = true,
                enabled = !isLoading,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ColorPrimary,
                    unfocusedBorderColor = if (serialAutoFilled) ColorPrimary.copy(alpha = 0.5f) else Color(0xFFAAAAAA),
                    focusedTextColor = ColorTextPrimary,
                    unfocusedTextColor = ColorTextPrimary,
                    cursorColor = ColorPrimary,
                    focusedLabelColor = ColorPrimary,
                    unfocusedLabelColor = ColorTextSecondary
                ),
                modifier = Modifier.fillMaxWidth()
            )

            Spacer(modifier = Modifier.height(16.dp))

            Text(
                text = "IMEI",
                color = ColorTextSecondary,
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 2.sp,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 4.dp)
            )

            val imeiAutoFilled = deviceIdentity?.imei != null
            OutlinedTextField(
                value = imei,
                onValueChange = {
                    imei = it
                    if (errorMessage != null) viewModel.clearError()
                },
                placeholder = {
                    Text(
                        text = UNABLE_TO_READ_PLACEHOLDER,
                        color = ColorTextSecondary,
                        fontSize = 12.sp
                    )
                },
                singleLine = true,
                enabled = !isLoading,
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ColorPrimary,
                    unfocusedBorderColor = if (imeiAutoFilled) ColorPrimary.copy(alpha = 0.5f) else Color(0xFFAAAAAA),
                    focusedTextColor = ColorTextPrimary,
                    unfocusedTextColor = ColorTextPrimary,
                    cursorColor = ColorPrimary,
                    focusedLabelColor = ColorPrimary,
                    unfocusedLabelColor = ColorTextSecondary
                ),
                modifier = Modifier.fillMaxWidth()
            )

            if (errorMessage != null) {
                Spacer(modifier = Modifier.height(10.dp))
                Text(
                    text = errorMessage,
                    color = ColorRed,
                    fontSize = 13.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            Spacer(modifier = Modifier.height(20.dp))

            Button(
                onClick = { viewModel.register(serial, imei) },
                enabled = !isLoading,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(52.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = ColorPrimary,
                    contentColor = Color.White,
                    disabledContainerColor = ColorPrimaryVariant.copy(alpha = 0.4f),
                    disabledContentColor = Color.White.copy(alpha = 0.4f)
                )
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        color = Color.White,
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp
                    )
                } else {
                    Text(
                        text = "SUBMIT",
                        fontWeight = FontWeight.Bold,
                        fontFamily = FontFamily.Monospace,
                        letterSpacing = 3.sp
                    )
                }
            }
        }
    }
}
