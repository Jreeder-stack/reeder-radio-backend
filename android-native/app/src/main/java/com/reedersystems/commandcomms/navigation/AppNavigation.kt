package com.reedersystems.commandcomms.navigation

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import android.content.Intent
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.ui.login.LoginScreen
import com.reedersystems.commandcomms.ui.radio.DeviceRegistrationScreen
import com.reedersystems.commandcomms.ui.radio.LockedScreen
import com.reedersystems.commandcomms.ui.radio.RadioScreen
import com.reedersystems.commandcomms.ui.radio.UnassignedScreen
import com.reedersystems.commandcomms.ui.settings.SettingsScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

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

private const val TAG = "[AppNav]"

@Composable
fun AppNavigation() {
    val navController = rememberNavController()
    val context = LocalContext.current
    val app = context.applicationContext as CommandCommsApp

    var tokenValidated by remember { mutableStateOf(false) }

    val radioToken = app.radioTokenStore.getToken()
    val radioId = app.radioTokenStore.getRadioId()
    val assignedUnitId = app.radioTokenStore.getAssignedUnitId()

    val startDestination = remember {
        val needsRegistration = radioToken == null || radioId.isNullOrBlank()

        if (needsRegistration && radioToken != null) {
            Log.w(TAG, "Token present but radioId missing/blank — clearing stale prefs")
            app.radioTokenStore.clear()
            app.apiClient.radioToken = null
        }

        when {
            needsRegistration -> Routes.DEVICE_REGISTRATION
            assignedUnitId != null -> Routes.radio(assignedUnitId)
            else -> Routes.unassigned(radioId!!)
        }
    }

    val needsRegistration = radioToken == null || radioId.isNullOrBlank()

    if (!needsRegistration && !tokenValidated) {
        LaunchedEffect(Unit) {
            val localUnitBefore = app.radioTokenStore.getAssignedUnitId()
            val isValid = validateTokenWithServer(app)
            if (!isValid) {
                Log.w(TAG, "Stored token failed server validation — clearing prefs")
                app.radioTokenStore.clear()
                app.apiClient.radioToken = null
                navController.navigate(Routes.DEVICE_REGISTRATION) {
                    popUpTo(0) { inclusive = true }
                }
            } else {
                val localUnitAfter = app.radioTokenStore.getAssignedUnitId()
                if (localUnitAfter != null && localUnitAfter != localUnitBefore) {
                    Log.d(TAG, "Ping discovered assignment $localUnitAfter — navigating to RadioScreen")
                    navController.navigate(Routes.radio(localUnitAfter)) {
                        popUpTo(0) { inclusive = true }
                    }
                } else if (localUnitAfter == null && localUnitBefore != null) {
                    val rid = app.radioTokenStore.getRadioId() ?: ""
                    Log.d(TAG, "Ping cleared stale assignment — navigating to UnassignedScreen")
                    navController.navigate(Routes.unassigned(rid)) {
                        popUpTo(0) { inclusive = true }
                    }
                }
            }
            tokenValidated = true
        }
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
                onUnassigned = if (isRadioDevice) {
                    {
                        val stopIntent = Intent(context, BackgroundAudioService::class.java).apply {
                            action = BackgroundAudioService.ACTION_STOP
                        }
                        context.startForegroundService(stopIntent)
                        app.radioTokenStore.clearAssignedUnit()
                        app.sessionPrefs.unitId = null
                        app.sessionPrefs.username = null
                        navController.navigate(Routes.unassigned(currentRadioId)) {
                            popUpTo(Routes.RADIO) { inclusive = true }
                        }
                    }
                } else null,
                onReassigned = if (isRadioDevice) {
                    { newUnitId ->
                        Log.d(TAG, "Re-assigned to unit $newUnitId — navigating (keeping signaling alive)")
                        navController.navigate(Routes.radio(newUnitId)) {
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

private suspend fun validateTokenWithServer(app: CommandCommsApp): Boolean =
    withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url("${app.apiClient.baseUrl}/api/radios/ping")
                .post(okhttp3.RequestBody.create(null, ByteArray(0)))
                .build()
            val response = app.apiClient.httpClient.newCall(request).execute()
            val code = response.code
            val body = response.body?.string() ?: ""
            response.close()
            when {
                code in 200..299 -> {
                    Log.d(TAG, "Token validation succeeded ($code)")
                    try {
                        val json = org.json.JSONObject(body)
                        val serverUnitId = json.optString("unitId", "").ifBlank { null }
                        val serverAssignedId = if (json.isNull("assignedUnitId")) null else json.optString("assignedUnitId", "").ifBlank { null }
                        val localUnitId = app.radioTokenStore.getAssignedUnitId()
                        if (serverAssignedId != null && serverUnitId != null && serverUnitId != localUnitId) {
                            Log.d(TAG, "Ping reports assignment unitId=$serverUnitId (local=$localUnitId) — syncing")
                            app.radioTokenStore.saveAssignedUnit(serverUnitId)
                            app.sessionPrefs.unitId = serverUnitId
                            app.sessionPrefs.username = serverUnitId
                        } else if (serverAssignedId != null && serverUnitId == null) {
                            Log.w(TAG, "Ping reports assignedUnitId=$serverAssignedId but unitId unresolved — clearing local assignment")
                            app.radioTokenStore.clearAssignedUnit()
                            app.sessionPrefs.unitId = null
                            app.sessionPrefs.username = null
                        } else if (serverAssignedId == null && localUnitId != null) {
                            Log.d(TAG, "Ping reports no assignment but local has $localUnitId — clearing")
                            app.radioTokenStore.clearAssignedUnit()
                            app.sessionPrefs.unitId = null
                            app.sessionPrefs.username = null
                        }
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed to parse ping assignment data: ${e.message}")
                    }
                    true
                }
                (code == 401 || code == 403) && body.contains("RADIO_LOCKED") -> {
                    Log.d(TAG, "Token valid but radio is locked — keeping prefs")
                    true
                }
                code == 401 || code == 403 -> {
                    Log.w(TAG, "Token validation failed with $code — invalid token")
                    false
                }
                else -> {
                    Log.w(TAG, "Token validation got unexpected status $code — assuming valid")
                    true
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Token validation network error, assuming valid: ${e.message}")
            true
        }
    }
