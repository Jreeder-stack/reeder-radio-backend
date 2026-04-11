package com.reedersystems.commandcomms.navigation

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.ui.login.LoginScreen
import com.reedersystems.commandcomms.ui.radio.DeviceRegistrationScreen
import com.reedersystems.commandcomms.ui.radio.LockedScreen
import com.reedersystems.commandcomms.ui.radio.RadioScreen
import com.reedersystems.commandcomms.ui.radio.UnassignedScreen
import com.reedersystems.commandcomms.ui.settings.SettingsScreen

object Routes {
    const val LOGIN = "login"
    const val RADIO = "radio?assignedUnit={assignedUnit}"
    const val SETTINGS = "settings"
    const val DEVICE_REGISTRATION = "device_registration"
    const val UNASSIGNED = "unassigned/{radioId}"
    const val LOCKED = "locked/{radioId}"

    fun unassigned(radioId: String) = "unassigned/$radioId"
    fun locked(radioId: String) = "locked/$radioId"
    fun radio(assignedUnit: String? = null) =
        if (assignedUnit != null) "radio?assignedUnit=$assignedUnit" else "radio"
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val app = context.applicationContext as CommandCommsApp

    val radioToken = app.radioTokenStore.getToken()
    val radioId = app.radioTokenStore.getRadioId() ?: ""
    val assignedUnitId = app.radioTokenStore.getAssignedUnitId()

    val startDestination = when {
        radioToken == null -> Routes.DEVICE_REGISTRATION
        assignedUnitId != null -> Routes.radio(assignedUnitId)
        else -> Routes.unassigned(radioId)
    }

    NavHost(navController = navController, startDestination = startDestination) {

        composable(Routes.DEVICE_REGISTRATION) {
            DeviceRegistrationScreen(
                onRegistrationSuccess = {
                    val rid = app.radioTokenStore.getRadioId() ?: ""
                    navController.navigate(Routes.unassigned(rid)) {
                        popUpTo(Routes.DEVICE_REGISTRATION) { inclusive = true }
                    }
                }
            )
        }

        composable(Routes.LOGIN) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Routes.radio()) {
                        popUpTo(Routes.LOGIN) { inclusive = true }
                    }
                }
            )
        }

        composable(
            route = Routes.RADIO,
            arguments = listOf(navArgument("assignedUnit") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            })
        ) { backStackEntry ->
            val assignedUnit = backStackEntry.arguments?.getString("assignedUnit")
            val isRadioDevice = app.radioTokenStore.getToken() != null
            val currentRadioId = app.radioTokenStore.getRadioId() ?: ""
            RadioScreen(
                onLocked = if (isRadioDevice) {
                    {
                        app.radioTokenStore.clearAssignedUnit()
                        navController.navigate(Routes.locked(currentRadioId)) {
                            popUpTo(Routes.RADIO) { inclusive = true }
                        }
                    }
                } else null,
                assignedFromUnit = assignedUnit
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

        composable(
            route = Routes.UNASSIGNED,
            arguments = listOf(navArgument("radioId") { type = NavType.StringType })
        ) { backStackEntry ->
            val rid = backStackEntry.arguments?.getString("radioId") ?: ""
            UnassignedScreen(
                radioId = rid,
                onAssigned = { unitId ->
                    navController.navigate(Routes.radio(unitId)) {
                        popUpTo(Routes.unassigned(rid)) { inclusive = true }
                    }
                },
                onLocked = {
                    navController.navigate(Routes.locked(rid)) {
                        popUpTo(Routes.unassigned(rid)) { inclusive = true }
                    }
                }
            )
        }

        composable(
            route = Routes.LOCKED,
            arguments = listOf(navArgument("radioId") { type = NavType.StringType })
        ) { backStackEntry ->
            val rid = backStackEntry.arguments?.getString("radioId") ?: ""
            LockedScreen(
                radioId = rid,
                onUnlocked = {
                    navController.navigate(Routes.unassigned(rid)) {
                        popUpTo(Routes.locked(rid)) { inclusive = true }
                    }
                }
            )
        }
    }
}
