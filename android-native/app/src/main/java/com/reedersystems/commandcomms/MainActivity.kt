package com.reedersystems.commandcomms

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.data.prefs.formatKeyLabel
import com.reedersystems.commandcomms.data.prefs.isNonCapturableKey
import com.reedersystems.commandcomms.navigation.AppNavigation
import com.reedersystems.commandcomms.ui.theme.CommandCommsTheme

private const val TAG = "[PTT-DIAG]"

private const val KEY_PTT_F11       = 141
private const val KEY_PTT           = 230
private const val KEY_EMERGENCY     = 233
private const val KEY_TV_TELETEXT   = 349
private const val KEY_ACC           = 231
private const val KEY_STAR      = 17
private const val KEY_DPAD_UP   = 19
private const val KEY_DPAD_DOWN = 20
private const val KEY_DPAD_LEFT = 21
private const val KEY_DPAD_RIGHT = 22

private const val ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS =
    "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENTS"

class MainActivity : ComponentActivity() {

    private val app get() = application as CommandCommsApp

    private var starDownTime = 0L
    private var lastCapturedKeyCode = -1

    /**
     * Set to true when we have launched ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS.
     * On the next onResume we open battery optimization settings instead of doing it
     * immediately (which would conflict with the settings activity still on screen).
     */
    private var pendingBatteryPromptAfterFullScreenIntent = false

    /**
     * Set to true when we have launched ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS.
     * On the next onResume we open overlay (SYSTEM_ALERT_WINDOW) settings if not yet granted.
     */
    private var pendingOverlayPromptAfterBattery = false

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
        Log.d(TAG, "APP_START")
        // Allow emergency activation to wake the screen and show over the lockscreen
        setTurnScreenOn(true)
        setShowWhenLocked(true)
        enableEdgeToEdge()
        requestAppPermissions()
        setContent {
            CommandCommsTheme {
                val focusRequester = FocusRequester()
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .focusRequester(focusRequester)
                        .focusable()
                        .onPreviewKeyEvent(::handlePreviewKeyEvent)
                ) {
                    AppNavigation()
                }
                LaunchedEffect(Unit) {
                    focusRequester.requestFocus()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        logDiagnostics()
        if (pendingBatteryPromptAfterFullScreenIntent) {
            pendingBatteryPromptAfterFullScreenIntent = false
            openBatteryOptimizationSettingsIfNeeded()
        } else if (pendingOverlayPromptAfterBattery) {
            pendingOverlayPromptAfterBattery = false
            requestOverlayPermissionIfNeeded()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Re-assert screen-on/lock flags for a singleTop Activity brought to front
        setTurnScreenOn(true)
        setShowWhenLocked(true)
        if (intent.getBooleanExtra(BackgroundAudioService.EXTRA_EMERGENCY_KEY_DOWN, false)) {
            Log.d(TAG, "onNewIntent: emergency DOWN — routing to ViewModel")
            app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
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
        openBatteryOptimizationSettingsIfNeeded()
    }

    private fun openBatteryOptimizationSettingsIfNeeded() {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            // Battery opt already exempted — go straight to overlay check
            requestOverlayPermissionIfNeeded()
            return
        }

        Log.d(TAG, "Requesting battery optimization exemption")
        pendingOverlayPromptAfterBattery = true
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (e: Exception) {
            Log.w(TAG, "Direct battery opt request unavailable — falling back to settings list")
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun requestOverlayPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Log.d(TAG, "Requesting SYSTEM_ALERT_WINDOW (overlay) permission")
            try {
                startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION).apply {
                        data = Uri.parse("package:$packageName")
                    }
                )
            } catch (e: Exception) {
                Log.w(TAG, "Overlay permission request unavailable: ${e.message}")
            }
        }
    }

    private fun logDiagnostics() {
        Log.d(TAG, "Diagnostics: PTT via PttHardwareReceiver (T320 vendor broadcasts)")
    }

    // ── DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────────
    private fun isPttKey(keyCode: Int): Boolean {
        if (keyCode == KEY_PTT_F11 || keyCode == KEY_PTT) return true
        if (app.pttKeyPrefs.volumeButtonPttEnabled && keyCode == KeyEvent.KEYCODE_VOLUME_UP) return true
        val custom = app.pttKeyPrefs.customKeyCode
        if (custom > 0 && keyCode == custom) return true
        return false
    }

    private fun isEmergencyKey(keyCode: Int): Boolean {
        return keyCode == KEY_EMERGENCY || keyCode == KEY_TV_TELETEXT
    }

    private fun isOurKey(keyCode: Int): Boolean {
        if (isPttKey(keyCode)) return true
        if (isEmergencyKey(keyCode)) return true
        if (keyCode == KEY_DPAD_UP || keyCode == KEY_DPAD_DOWN ||
            keyCode == KEY_DPAD_LEFT || keyCode == KEY_DPAD_RIGHT) return true
        if (keyCode == KEY_ACC || keyCode == KEY_STAR) return true
        return false
    }
    // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────

    private fun handleKeyCaptureIfActive(keyCode: Int): Boolean {
        val capturing = app.keyCapturingFlow.value
        if (!capturing) return false
        if (isNonCapturableKey(keyCode)) return true
        val label = formatKeyLabel(keyCode)
        app.pttKeyPrefs.customKeyCode = keyCode
        app.pttKeyPrefs.customKeyLabel = label
        lastCapturedKeyCode = keyCode
        app.keyCapturingFlow.value = false
        Log.d(TAG, "Key captured: code=$keyCode label=$label")
        return true
    }

    /**
     * Intercept our hardware keys during Compose's preview phase so D-pad navigation doesn't
     * consume them for focus traversal before the radio shortcuts can react.
     */
    private fun handlePreviewKeyEvent(event: androidx.compose.ui.input.key.KeyEvent): Boolean {
        val nativeEvent = event.nativeKeyEvent
        if (app.keyCapturingFlow.value) {
            if (event.type == KeyEventType.KeyDown) {
                return handleKeyCaptureIfActive(nativeEvent.keyCode)
            }
            return true
        }
        if (lastCapturedKeyCode == nativeEvent.keyCode && event.type == KeyEventType.KeyUp) {
            lastCapturedKeyCode = -1
            return true
        }
        if (!isOurKey(nativeEvent.keyCode)) return false

        return when (event.type) {
            KeyEventType.KeyDown -> handleKeyDown(nativeEvent.keyCode, nativeEvent)
            KeyEventType.KeyUp -> {
                handleKeyUp(nativeEvent.keyCode, nativeEvent)
                true
            }
            else -> false
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (handleKeyCaptureIfActive(keyCode)) return true
        if (isOurKey(keyCode)) return handleKeyDown(keyCode, event)
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (app.keyCapturingFlow.value) return true
        if (lastCapturedKeyCode == keyCode) {
            lastCapturedKeyCode = -1
            return true
        }
        if (isOurKey(keyCode)) return handleKeyUp(keyCode, event)
        return super.onKeyUp(keyCode, event)
    }

    // ── DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────────
    // Key dispatch routes hardware events to BackgroundAudioService via intents.
    // Only the service-side handler (what happens AFTER the intent) may change.
    private fun handleKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when {
            isPttKey(keyCode) -> {
                if (event?.repeatCount == 0) {
                    val now = System.currentTimeMillis()
                    val repeat = event.repeatCount
                    Log.d(TAG, "MainActivity PTT DOWN source=MainActivity code=$keyCode action=DOWN repeat=$repeat ts=$now")
                    if (app.sessionPrefs.micPermissionGranted) {
                        Log.d(TAG, "MainActivity PTT DOWN — forwarding to BackgroundAudioService (signaling=true)")
                        forwardPttToBackgroundService(BackgroundAudioService.ACTION_PTT_DOWN)
                    } else {
                        Log.w(TAG, "PTT DOWN source=MainActivity code=$keyCode: mic permission denied")
                        app.toneEngine.playErrorTone()
                    }
                }
                return true
            }
            isEmergencyKey(keyCode) -> {
                if (event?.repeatCount == 0) {
                    Log.d(TAG, "MainActivity EMERGENCY DOWN (keyCode=$keyCode) — forwarding to BackgroundAudioService")
                    forwardEmergencyToBackgroundService(BackgroundAudioService.ACTION_EMERGENCY_DOWN)
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
                Log.d(TAG, "MainActivity PTT UP source=MainActivity code=$keyCode action=UP ts=$now")
                Log.d(TAG, "MainActivity PTT UP — forwarding to BackgroundAudioService (signaling=true)")
                forwardPttToBackgroundService(BackgroundAudioService.ACTION_PTT_UP)
                return true
            }
            isEmergencyKey(keyCode) -> {
                Log.d(TAG, "MainActivity EMERGENCY UP (keyCode=$keyCode) — forwarding to BackgroundAudioService")
                forwardEmergencyToBackgroundService(BackgroundAudioService.ACTION_EMERGENCY_UP)
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
            putExtra(BackgroundAudioService.EXTRA_NEEDS_SIGNALING, true)
        }
        ContextCompat.startForegroundService(this, intent)
    }

    private fun forwardEmergencyToBackgroundService(action: String) {
        val intent = Intent(this, BackgroundAudioService::class.java).apply {
            this.action = action
        }
        ContextCompat.startForegroundService(this, intent)
    }
    // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────

}
