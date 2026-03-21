package com.reedersystems.commandcomms

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.KeyEvent
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.navigation.AppNavigation
import com.reedersystems.commandcomms.ui.theme.CommandCommsTheme

private const val TAG = "[PTT-DIAG]"

private const val KEY_PTT_F11   = 141
private const val KEY_PTT       = 230
private const val KEY_EMERGENCY = 233
private const val KEY_ACC       = 231
private const val KEY_STAR      = 17
private const val KEY_DPAD_UP   = 19
private const val KEY_DPAD_DOWN = 20
private const val KEY_DPAD_LEFT = 21
private const val KEY_DPAD_RIGHT = 22

private const val PREFS_NAME = "commandcomms_ui_prefs"
private const val KEY_BATTERY_OPT_PROMPT_SHOWN = "battery_opt_prompt_shown"
private const val ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS =
    "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENTS"

class MainActivity : ComponentActivity() {

    private val app get() = application as CommandCommsApp

    private var starDownTime = 0L

    /**
     * Set to true when we have launched ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS.
     * On the next onResume we fire the battery exemption prompt instead of doing it
     * immediately (which would conflict with the settings activity still on screen).
     */
    private var pendingBatteryPromptAfterFullScreenIntent = false

    private val requestBackgroundLocationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.d(TAG, "ACCESS_BACKGROUND_LOCATION granted=$granted")
        requestFullScreenIntentIfNeeded()
    }

    private val requestMultiplePermissionsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        fun isGranted(perm: String): Boolean =
            results[perm]
                ?: (ContextCompat.checkSelfPermission(this, perm) == PackageManager.PERMISSION_GRANTED)

        val micGranted = isGranted(Manifest.permission.RECORD_AUDIO)
        val locationGranted = isGranted(Manifest.permission.ACCESS_FINE_LOCATION)
        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            isGranted(Manifest.permission.POST_NOTIFICATIONS)
        else true

        Log.d(TAG, "Multi-permission results: mic=$micGranted location=$locationGranted notif=$notifGranted")

        app.sessionPrefs.micPermissionGranted = micGranted
        app.sessionPrefs.locationPermissionGranted = locationGranted
        app.sessionPrefs.notificationPermissionGranted = notifGranted

        if (locationGranted &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestBackgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        } else {
            requestFullScreenIntentIfNeeded()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        requestAppPermissions()
        setContent {
            CommandCommsTheme {
                AppNavigation()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        logDiagnostics()
        if (pendingBatteryPromptAfterFullScreenIntent) {
            pendingBatteryPromptAfterFullScreenIntent = false
            requestBatteryOptimizationExemptionIfNeeded()
        }
    }

    private fun requestAppPermissions() {
        val micGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        val locationGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val notifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        else true
        val bgLocationGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val btConnectGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
        else true
        val btScanGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) ==
                PackageManager.PERMISSION_GRANTED
        else true

        app.sessionPrefs.micPermissionGranted = micGranted
        app.sessionPrefs.locationPermissionGranted = locationGranted
        app.sessionPrefs.notificationPermissionGranted = notifGranted

        val permissionsToRequest = mutableListOf<String>()

        if (!micGranted) permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
        if (!locationGranted) permissionsToRequest.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (!notifGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
            permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
        if (!btConnectGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            permissionsToRequest.add(Manifest.permission.BLUETOOTH_CONNECT)
        if (!btScanGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            permissionsToRequest.add(Manifest.permission.BLUETOOTH_SCAN)

        if (permissionsToRequest.isNotEmpty()) {
            requestMultiplePermissionsLauncher.launch(permissionsToRequest.toTypedArray())
        } else if (!bgLocationGranted && locationGranted) {
            requestBackgroundLocationLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        } else {
            requestFullScreenIntentIfNeeded()
        }
    }

    private fun requestFullScreenIntentIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val nm = getSystemService(android.app.NotificationManager::class.java)
            if (!nm.canUseFullScreenIntent()) {
                Log.d(TAG, "Requesting USE_FULL_SCREEN_INTENT permission (API 34+)")
                pendingBatteryPromptAfterFullScreenIntent = true
                startActivity(
                    Intent(ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS).apply {
                        setData(Uri.parse("package:$packageName"))
                    }
                )
                return
            }
        }
        requestBatteryOptimizationExemptionIfNeeded()
    }

    private fun requestBatteryOptimizationExemptionIfNeeded() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        if (prefs.getBoolean(KEY_BATTERY_OPT_PROMPT_SHOWN, false)) return

        prefs.edit().putBoolean(KEY_BATTERY_OPT_PROMPT_SHOWN, true).apply()

        Log.d(TAG, "Requesting battery optimization exemption")
        startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:$packageName")
            }
        )
    }

    private fun logDiagnostics() {
        Log.d(TAG, "Diagnostics: PTT via PttHardwareReceiver (T320 vendor broadcasts)")
    }

    private fun isPttKey(keyCode: Int) = keyCode == KEY_PTT_F11 || keyCode == KEY_PTT

    private fun isOurKey(keyCode: Int) = isPttKey(keyCode) ||
        keyCode == KEY_EMERGENCY ||
        keyCode == KEY_DPAD_UP || keyCode == KEY_DPAD_DOWN ||
        keyCode == KEY_DPAD_LEFT || keyCode == KEY_DPAD_RIGHT ||
        keyCode == KEY_ACC || keyCode == KEY_STAR

    /**
     * Intercept our hardware keys before the Compose view hierarchy can consume them for
     * focus traversal. Without this override, Compose's clickable/combinedClickable elements
     * absorb D-pad events to move UI focus, meaning onKeyDown is only called after all
     * focusable elements have been exhausted — requiring 3+ presses to change a zone/channel.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (isOurKey(event.keyCode)) {
            return when (event.action) {
                KeyEvent.ACTION_DOWN -> handleKeyDown(event.keyCode, event)
                KeyEvent.ACTION_UP   -> { handleKeyUp(event.keyCode, event); true }
                else                 -> false
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (isOurKey(keyCode)) return handleKeyDown(keyCode, event)
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (isOurKey(keyCode)) return handleKeyUp(keyCode, event)
        return super.onKeyUp(keyCode, event)
    }

    private fun handleKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when {
            isPttKey(keyCode) -> {
                if (event?.repeatCount == 0) {
                    val now = System.currentTimeMillis()
                    val repeat = event?.repeatCount ?: 0
                    val interactive = isDeviceInteractive()
                    Log.d(TAG, "MainActivity PTT DOWN source=MainActivity code=$keyCode action=DOWN repeat=$repeat ts=$now")
                    if (!interactive) {
                        Log.d(TAG, "MainActivity PTT DOWN while screen-off — forwarding directly to BackgroundAudioService")
                        forwardPttToBackgroundService(BackgroundAudioService.ACTION_PTT_DOWN)
                    } else if (app.sessionPrefs.micPermissionGranted) {
                        app.keyEventFlow.tryEmit(KeyAction.PttDown)
                    } else {
                        Log.w(TAG, "PTT DOWN source=MainActivity code=$keyCode: mic permission denied")
                        app.toneEngine.playErrorTone()
                    }
                }
                return true
            }
            keyCode == KEY_EMERGENCY -> {
                if (event?.repeatCount == 0) {
                    Log.d(TAG, "MainActivity EMERGENCY DOWN")
                    app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
                }
                return true
            }
            keyCode == KEY_DPAD_UP -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadUp)
                return true
            }
            keyCode == KEY_DPAD_DOWN -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadDown)
                return true
            }
            keyCode == KEY_DPAD_LEFT -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadLeft)
                return true
            }
            keyCode == KEY_DPAD_RIGHT -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadRight)
                return true
            }
            keyCode == KEY_ACC -> {
                if (event?.repeatCount == 0) {
                    app.keyEventFlow.tryEmit(KeyAction.AccToggle)
                }
                return true
            }
            keyCode == KEY_STAR -> {
                if (event?.repeatCount == 0) {
                    starDownTime = SystemClock.uptimeMillis()
                }
                return true
            }
        }
        return false
    }

    private fun handleKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        when {
            isPttKey(keyCode) -> {
                val now = System.currentTimeMillis()
                val interactive = isDeviceInteractive()
                Log.d(TAG, "MainActivity PTT UP source=MainActivity code=$keyCode action=UP ts=$now")
                if (!interactive) {
                    Log.d(TAG, "MainActivity PTT UP while screen-off — forwarding directly to BackgroundAudioService")
                    forwardPttToBackgroundService(BackgroundAudioService.ACTION_PTT_UP)
                } else {
                    app.keyEventFlow.tryEmit(KeyAction.PttUp)
                }
                return true
            }
            keyCode == KEY_EMERGENCY -> {
                Log.d(TAG, "MainActivity EMERGENCY UP")
                app.keyEventFlow.tryEmit(KeyAction.EmergencyUp)
                return true
            }
            keyCode == KEY_STAR -> {
                val held = SystemClock.uptimeMillis() - starDownTime
                if (held >= 1000L) {
                    Log.d(TAG, "Star long press — toggling key lock")
                    app.keyEventFlow.tryEmit(KeyAction.StarLongPress)
                }
                return true
            }
        }
        return false
    }

    private fun isDeviceInteractive(): Boolean {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        return pm.isInteractive
    }

    private fun forwardPttToBackgroundService(action: String) {
        val intent = Intent(this, BackgroundAudioService::class.java).apply {
            this.action = action
            putExtra(BackgroundAudioService.EXTRA_NEEDS_SIGNALING, false)
        }
        ContextCompat.startForegroundService(this, intent)
    }

}
