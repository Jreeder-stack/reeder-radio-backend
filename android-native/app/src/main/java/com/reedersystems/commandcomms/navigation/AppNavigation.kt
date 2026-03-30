package com.reedersystems.commandcomms.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.ui.login.LoginScreen
import com.reedersystems.commandcomms.ui.radio.RadioScreen
import com.reedersystems.commandcomms.ui.settings.SettingsScreen

object Routes {
    const val LOGIN = "login"
    const val RADIO = "radio"
    const val SETTINGS = "settings"
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val app = context.applicationContext as CommandCommsApp

    val startDestination = Routes.LOGIN

    NavHost(navController = navController, startDestination = startDestination) {
        composable(Routes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Routes.RADIO) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                }
            )
        }
        composable(Routes.RADIO) {
            RadioScreen(
                onLogout = {
                    navController.navigate(Routes.LOGIN) {
                        popUpTo(Routes.RADIO) { inclusive = true }
                    }
                },
                onOpenSettings = {
                    navController.navigate(Routes.SETTINGS)
                }
            )
        }
        composable(Routes.SETTINGS) {
            val isCapturing by app.keyCapturingFlow.collectAsState()
            SettingsScreen(
                pttKeyPrefs = app.pttKeyPrefs,
                isCapturing = isCapturing,
                onStartCapture = { app.keyCapturingFlow.value = true },
                onStopCapture = { app.keyCapturingFlow.value = false },
                onBack = { navController.popBackStack() }
            )
        }
    }
}
