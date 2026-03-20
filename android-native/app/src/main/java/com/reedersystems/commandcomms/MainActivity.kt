package com.reedersystems.commandcomms

import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
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
import android.view.accessibility.AccessibilityManager
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.accessibility.PttAccessibilityService
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
private const val KEY_ACCESSIBILITY_PROMPT_SHOWN = "accessibility_prompt_shown"
private const val KEY_BATTERY_OPT_PROMPT_SHOWN = "battery_opt_prompt_shown"
private const val PTT_DEDUP_WINDOW_MS = 150L

class MainActivity : ComponentActivity() {

    private val app get() = application as CommandCommsApp

    private var starDownTime = 0L

    private val requestNotificationsLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.d(TAG, "POST_NOTIFICATIONS granted=$granted")
        app.sessionPrefs.notificationPermissionGranted = granted
    }

    private val requestLocationLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.d(TAG, "ACCESS_FINE_LOCATION granted=$granted")
        app.sessionPrefs.locationPermissionGranted = granted
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestNotificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    private val requestMicLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        Log.d(TAG, "RECORD_AUDIO granted=$granted")
        app.sessionPrefs.micPermissionGranted = granted
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestLocationLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            requestNotificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
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
        promptForAccessibilityServiceIfNeeded()
        requestBatteryOptimizationExemptionIfNeeded()
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

        app.sessionPrefs.micPermissionGranted = micGranted
        app.sessionPrefs.locationPermissionGranted = locationGranted
        app.sessionPrefs.notificationPermissionGranted = notifGranted

        if (!micGranted) {
            requestMicLauncher.launch(Manifest.permission.RECORD_AUDIO)
        } else if (!locationGranted) {
            requestLocationLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        } else if (!notifGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun isPttAccessibilityServiceEnabled(): Boolean {
        val am = getSystemService(ACCESSIBILITY_SERVICE) as AccessibilityManager
        val enabled = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
        return enabled.any {
            it.resolveInfo.serviceInfo.packageName == packageName &&
                it.resolveInfo.serviceInfo.name.contains("PttAccessibilityService")
        }
    }

    private fun promptForAccessibilityServiceIfNeeded() {
        if (isPttAccessibilityServiceEnabled()) return

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        if (prefs.getBoolean(KEY_ACCESSIBILITY_PROMPT_SHOWN, false)) return

        prefs.edit().putBoolean(KEY_ACCESSIBILITY_PROMPT_SHOWN, true).apply()

        AlertDialog.Builder(this)
            .setTitle("Enable Background PTT")
            .setMessage(
                "To use the PTT button when the app is in the background or the screen is off, " +
                "enable \"Command Comms\" in Accessibility Settings."
            )
            .setPositiveButton("Open Settings") { _, _ ->
                startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            }
            .setNegativeButton("Later", null)
            .show()
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
        val accessEnabled = isPttAccessibilityServiceEnabled()
        Log.d(TAG, "Diagnostics: AccessibilityService=${if (accessEnabled) "ENABLED" else "DISABLED"} " +
            "lastPttDownMs=${PttAccessibilityService.lastPttDownMs} " +
            "lastPttUpMs=${PttAccessibilityService.lastPttUpMs}")
    }

    private fun isPttKey(keyCode: Int) = keyCode == KEY_PTT_F11 || keyCode == KEY_PTT

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when {
            isPttKey(keyCode) -> {
                if (event?.repeatCount == 0) {
                    val now = System.currentTimeMillis()
                    val repeat = event?.repeatCount ?: 0
                    if (isPttAccessibilityServiceEnabled()) {
                        val delta = now - PttAccessibilityService.lastPttDownMs
                        if (delta < PTT_DEDUP_WINDOW_MS) {
                            Log.d(TAG, "MainActivity PTT DOWN suppressed source=MainActivity code=$keyCode action=DOWN repeat=$repeat ts=$now (AccessSvc handled ${delta}ms ago)")
                            return true
                        }
                    }
                    Log.d(TAG, "MainActivity PTT DOWN source=MainActivity code=$keyCode action=DOWN repeat=$repeat ts=$now — dual-path")
                    if (app.sessionPrefs.micPermissionGranted) {
                        app.keyEventFlow.tryEmit(KeyAction.PttDown)
                        startForegroundService(
                            Intent(this, BackgroundAudioService::class.java).apply {
                                action = BackgroundAudioService.ACTION_PTT_DOWN
                            }
                        )
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
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        when {
            isPttKey(keyCode) -> {
                val now = System.currentTimeMillis()
                if (isPttAccessibilityServiceEnabled()) {
                    val delta = now - PttAccessibilityService.lastPttUpMs
                    if (delta < PTT_DEDUP_WINDOW_MS) {
                        Log.d(TAG, "MainActivity PTT UP suppressed source=MainActivity code=$keyCode action=UP ts=$now (AccessSvc handled ${delta}ms ago)")
                        return true
                    }
                }
                Log.d(TAG, "MainActivity PTT UP source=MainActivity code=$keyCode action=UP ts=$now — dual-path")
                app.keyEventFlow.tryEmit(KeyAction.PttUp)
                startForegroundService(
                    Intent(this, BackgroundAudioService::class.java).apply {
                        action = BackgroundAudioService.ACTION_PTT_UP
                    }
                )
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
        return super.onKeyUp(keyCode, event)
    }

}
