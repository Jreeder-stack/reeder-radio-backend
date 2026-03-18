package com.reedersystems.commandcomms.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.reedersystems.commandcomms.ui.login.LoginScreen
import com.reedersystems.commandcomms.ui.radio.RadioScreen

object Routes {
    const val LOGIN = "login"
    const val RADIO = "radio"
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()

    NavHost(navController = navController, startDestination = Routes.LOGIN) {
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
                }
            )
        }
    }
}
