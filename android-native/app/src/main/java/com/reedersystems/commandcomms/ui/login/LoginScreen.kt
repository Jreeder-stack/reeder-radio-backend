package com.reedersystems.commandcomms.ui.login

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.reedersystems.commandcomms.ui.theme.*
import android.util.Log

@Composable
fun LoginScreen(
    onLoginSuccess: () -> Unit,
    viewModel: LoginViewModel = viewModel()
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        Log.d("[LOGIN-FLOW]", "LOGIN_SCREEN_ENTER")
    }

    LaunchedEffect(uiState) {
        Log.d("[LOGIN-FLOW]", "SESSION_STATE_CHANGED uiState=${uiState::class.simpleName}")
        if (uiState is LoginUiState.Success) {
            Log.d("[LOGIN-FLOW]", "NAVIGATE_TO_CONNECTING_REASON auth_success")
            Log.d("[APP-STARTUP]", "CONNECTING_SCREEN_EXIT")
            onLoginSuccess()
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(ColorBackground),
        contentAlignment = Alignment.Center
    ) {
        when (uiState) {
            is LoginUiState.CheckingSession -> {
                CircularProgressIndicator(color = ColorPrimary)
            }
            else -> {
                LoginForm(
                    isLoading = uiState is LoginUiState.Loading,
                    errorMessage = (uiState as? LoginUiState.Error)?.message,
                    onLogin = { user, pass -> viewModel.login(user, pass) },
                    onErrorDismiss = viewModel::clearError,
                    onInputChanged = viewModel::onManualInputChanged
                )
            }
        }
    }
}

@Composable
private fun LoginForm(
    isLoading: Boolean,
    errorMessage: String?,
    onLogin: (String, String) -> Unit,
    onErrorDismiss: () -> Unit,
    onInputChanged: (String, String) -> Unit
) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current

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
            text = "COMMAND",
            color = ColorPrimary,
            fontSize = 32.sp,
            fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 8.sp
        )
        Text(
            text = "COMMS",
            color = ColorPrimary,
            fontSize = 32.sp,
            fontWeight = FontWeight.Black,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 8.sp
        )
        Text(
            text = "REEDER SYSTEMS",
            color = ColorTextSecondary,
            fontSize = 10.sp,
            fontFamily = FontFamily.Monospace,
            letterSpacing = 4.sp
        )

        Spacer(modifier = Modifier.height(24.dp))

        OutlinedTextField(
            value = username,
            onValueChange = {
                username = it
                onInputChanged("username", it)
                if (errorMessage != null) onErrorDismiss()
            },
            label = { Text("Unit ID") },
            leadingIcon = { Icon(Icons.Default.Person, contentDescription = null) },
            singleLine = true,
            enabled = !isLoading,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Text,
                imeAction = ImeAction.Next
            ),
            keyboardActions = KeyboardActions(
                onNext = { focusManager.moveFocus(FocusDirection.Down) }
            ),
            colors = radioTextFieldColors(),
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = password,
            onValueChange = {
                password = it
                onInputChanged("password", it)
                if (errorMessage != null) onErrorDismiss()
            },
            label = { Text("Password") },
            leadingIcon = { Icon(Icons.Default.Lock, contentDescription = null) },
            trailingIcon = {
                IconButton(onClick = { showPassword = !showPassword }) {
                    Icon(
                        if (showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                        contentDescription = if (showPassword) "Hide password" else "Show password"
                    )
                }
            },
            visualTransformation = if (showPassword) VisualTransformation.None
            else PasswordVisualTransformation(),
            singleLine = true,
            enabled = !isLoading,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done
            ),
            keyboardActions = KeyboardActions(
                onDone = {
                    focusManager.clearFocus()
                    onLogin(username, password)
                }
            ),
            colors = radioTextFieldColors(),
            modifier = Modifier.fillMaxWidth()
        )

        if (errorMessage != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = errorMessage,
                color = ColorRed,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth()
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        Button(
            onClick = { onLogin(username, password) },
            enabled = !isLoading && username.isNotBlank() && password.isNotBlank(),
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
                    text = "SIGN IN",
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 3.sp
                )
            }
        }
    }
}

@Composable
private fun radioTextFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = ColorPrimary,
    unfocusedBorderColor = Color(0xFFAAAAAA),
    focusedLabelColor = ColorPrimary,
    unfocusedLabelColor = ColorTextSecondary,
    focusedLeadingIconColor = ColorPrimary,
    unfocusedLeadingIconColor = ColorTextSecondary,
    cursorColor = ColorPrimary,
    focusedTextColor = ColorTextPrimary,
    unfocusedTextColor = ColorTextPrimary
)
