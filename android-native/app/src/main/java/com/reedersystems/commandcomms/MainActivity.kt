package com.reedersystems.commandcomms

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.InputDevice
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
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.data.prefs.formatKeyLabel
import com.reedersystems.commandcomms.data.prefs.isNonCapturableKey
import com.reedersystems.commandcomms.navigation.AppNavigation
import com.reedersystems.commandcomms.ui.theme.CommandCommsTheme
import kotlinx.coroutines.launch

private const val TAG = "[PTT-DIAG]"

private const val KEY_PTT_F11 = 141
private const val KEY_PTT = 230
private const val KEY_EMERGENCY = 233
private const val KEY_TV_TELETEXT = 349
private const val KEY_ACC = 231
private const val KEY_STAR = 17
private const val KEY_DPAD_UP = 19
private const val KEY_DPAD_DOWN = 20
private const val KEY_DPAD_CENTER = 23
private const val KEY_DPAD_LEFT = 21
private const val KEY_DPAD_RIGHT = 22

private const val ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENTS =
    "android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENTS"

class MainActivity : ComponentActivity() {

    private val app get() = application as CommandCommsApp

    private var starDownTime = 0L
    private var lastCapturedKeyCode = -1
    private val rootFocusRequester = FocusRequester()
    private var lastT320VolumeDetentAtMs = 0L
    private var lastT320VolumeDirection = 0

    private var pendingBatteryPromptAfterFullScreenIntent = false
    private var pendingOverlayPromptAfterBattery = false

    private val remoteKioskReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != CommandCommsApp.ACTION_REMOTE_KIOSK_CHANGED) return
            Log.d(TAG, "ACTION_REMOTE_KIOSK_CHANGED received in MainActivity — applying lock-task transition")
            applyKioskLockTaskTransition()
        }
    }

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
        val notifGranted = isGranted(Manifest.permission.POST_NOTIFICATIONS)

        Log.d(TAG, "Multi-permission results: mic=$micGranted location=$locationGranted notif=$notifGranted")

        app.sessionPrefs.micPermissionGranted = micGranted
        app.sessionPrefs.locationPermissionGranted = locationGranted
        app.sessionPrefs.notificationPermissionGranted = notifGranted

        if (
            locationGranted &&
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
        setTurnScreenOn(true)
        setShowWhenLocked(true)
        enableEdgeToEdge()
        hideSystemBars()
        requestAppPermissions()
        registerRemoteKioskReceiver()
        setContent {
            CommandCommsTheme {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .focusRequester(rootFocusRequester)
                        .focusable()
                        .onPreviewKeyEvent(::handlePreviewKeyEvent)
                ) {
                    AppNavigation()
                }
                LaunchedEffect(Unit) {
                    rootFocusRequester.requestFocus()
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        logDiagnostics()
        lifecycleScope.launch {
            try {
                rootFocusRequester.requestFocus()
            } catch (_: Exception) {
            }
        }
        if (pendingBatteryPromptAfterFullScreenIntent) {
            pendingBatteryPromptAfterFullScreenIntent = false
            openBatteryOptimizationSettingsIfNeeded()
        } else if (pendingOverlayPromptAfterBattery) {
            pendingOverlayPromptAfterBattery = false
            requestOverlayPermissionIfNeeded()
        }
        applyKioskLockTaskTransition()
    }

    override fun onDestroy() {
        try {
            unregisterReceiver(remoteKioskReceiver)
        } catch (_: Exception) {
        }
        super.onDestroy()
    }

    private fun registerRemoteKioskReceiver() {
        val filter = IntentFilter(CommandCommsApp.ACTION_REMOTE_KIOSK_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(remoteKioskReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(remoteKioskReceiver, filter)
        }
    }

    private fun applyKioskLockTaskTransition() {
        val policy = app.kioskPolicyManager
        val now = System.currentTimeMillis()
        val remoteUnlockActive = app.kioskPrefs.isRemoteUnlockActive(now)
        val wantKiosk = app.kioskPrefs.kioskEnabled && policy.isDeviceOwner && !remoteUnlockActive
        try {
            if (wantKiosk) {
                policy.applyKioskPolicies()
                policy.enterLockTask(this)
            } else {
                policy.exitLockTask(this)
            }
        } catch (e: Exception) {
            Log.w(TAG, "applyKioskLockTaskTransition failed: ${e.message}")
        }
        app.applyRemoteKioskState(launchActivityIfPinning = false)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        setTurnScreenOn(true)
        setShowWhenLocked(true)
        if (intent.getBooleanExtra(BackgroundAudioService.EXTRA_EMERGENCY_KEY_DOWN, false)) {
            Log.d(TAG, "onNewIntent: emergency DOWN — routing to ViewModel")
            app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
        }
        handlePageIntent(intent)
        applyKioskLockTaskTransition()
    }

    private fun handlePageIntent(intent: Intent) {
        val pageId = intent.getStringExtra(EXTRA_PAGE_ID) ?: return
        val message = intent.getStringExtra(EXTRA_PAGE_MESSAGE) ?: return
        val sender = intent.getStringExtra(EXTRA_PAGE_SENDER) ?: "DISPATCH"
        val channelId = intent.getStringExtra(EXTRA_PAGING_CHANNEL_ID) ?: ""
        Log.d(TAG, "Page intent received: id=$pageId message=$message")
        app.pendingPageId = pageId
        app.pendingPageMessage = message
        app.pendingPageSender = sender
        app.pendingPageChannelId = channelId
    }

    companion object {
        const val EXTRA_PAGE_ID = "page_id"
        const val EXTRA_PAGE_MESSAGE = "page_message"
        const val EXTRA_PAGE_SENDER = "page_sender"
        const val EXTRA_PAGING_CHANNEL_ID = "paging_channel_id"
    }

    private fun requestAppPermissions() {
        val micGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.RECORD_AUDIO
        ) == PackageManager.PERMISSION_GRANTED

        val locationGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED

        val notifGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED

        val bgLocationGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
                ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.ACCESS_BACKGROUND_LOCATION
                ) == PackageManager.PERMISSION_GRANTED

        val btConnectGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.BLUETOOTH_CONNECT
        ) == PackageManager.PERMISSION_GRANTED

        val btScanGranted = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.BLUETOOTH_SCAN
        ) == PackageManager.PERMISSION_GRANTED

        app.sessionPrefs.micPermissionGranted = micGranted
        app.sessionPrefs.locationPermissionGranted = locationGranted
        app.sessionPrefs.notificationPermissionGranted = notifGranted

        val permissionsToRequest = mutableListOf<String>()

        if (!micGranted) permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
        if (!locationGranted) permissionsToRequest.add(Manifest.permission.ACCESS_FINE_LOCATION)
        if (!notifGranted) permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
        if (!btConnectGranted) permissionsToRequest.add(Manifest.permission.BLUETOOTH_CONNECT)
        if (!btScanGranted) permissionsToRequest.add(Manifest.permission.BLUETOOTH_SCAN)

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
                        data = Uri.parse("package:$packageName")
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
        } catch (_: Exception) {
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

    private fun isPttKey(keyCode: Int): Boolean {
        if (keyCode == KEY_PTT_F11 && BuildConfig.FLAVOR == "t320") return true
        if (keyCode == KEY_PTT) return true
        if (app.pttKeyPrefs.volumeButtonPttEnabled && keyCode == KeyEvent.KEYCODE_VOLUME_UP) return true
        val custom = app.pttKeyPrefs.customKeyCode
        if (custom > 0 && keyCode == custom) return true
        return false
    }

    private fun isEmergencyKey(keyCode: Int): Boolean {
        return keyCode == KEY_EMERGENCY || keyCode == KEY_TV_TELETEXT
    }

    private fun isSd7KnobPress(keyCode: Int): Boolean {
        return BuildConfig.FLAVOR == "sd7" && keyCode == KeyEvent.KEYCODE_F8
    }

    private fun isSd7SideVolumeKey(keyCode: Int, event: KeyEvent?): Boolean {
        if (BuildConfig.FLAVOR != "sd7") return false
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) return false
        val device = event?.device ?: return false
        if (device.isVirtual) return false
        if (device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC) return false
        return true
    }

    private fun isT320VolumeKnobKey(keyCode: Int): Boolean {
        if (BuildConfig.FLAVOR != "t320") return false
        return keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS ||
            keyCode == KeyEvent.KEYCODE_MEDIA_NEXT
    }

    private fun adjustT320VolumeKnob(keyCode: Int) {
        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val now = SystemClock.uptimeMillis()
        val direction = if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
            AudioManager.ADJUST_RAISE
        } else {
            AudioManager.ADJUST_LOWER
        }
        val rapidSameDirection =
            lastT320VolumeDirection == direction &&
                now - lastT320VolumeDetentAtMs <= T320_VOLUME_ACCEL_WINDOW_MS
        val steps = if (rapidSameDirection) T320_VOLUME_ACCEL_STEPS else 1

        repeat(steps) {
            audioManager.adjustStreamVolume(
                AudioManager.STREAM_VOICE_CALL,
                direction,
                0
            )
        }

        lastT320VolumeDetentAtMs = now
        lastT320VolumeDirection = direction
        val current = audioManager.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
        val max = audioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
        Log.d(
            TAG,
            "T320 volume knob immediate keyCode=$keyCode direction=$direction steps=$steps volume=$current/$max"
        )
    }

    private fun isOurKey(keyCode: Int, @Suppress("UNUSED_PARAMETER") event: KeyEvent? = null): Boolean {
        if (isPttKey(keyCode)) return true
        if (isEmergencyKey(keyCode)) return true
        if (
            keyCode == KEY_DPAD_UP ||
            keyCode == KEY_DPAD_DOWN ||
            keyCode == KEY_DPAD_LEFT ||
            keyCode == KEY_DPAD_RIGHT ||
            keyCode == KEY_DPAD_CENTER
        ) return true
        if (isSd7KnobPress(keyCode)) return true
        if (keyCode == KEY_ACC || keyCode == KEY_STAR) return true
        return false
    }

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
        if (!isOurKey(nativeEvent.keyCode, nativeEvent)) return false

        return when (event.type) {
            KeyEventType.KeyDown -> handleKeyDown(nativeEvent.keyCode, nativeEvent)
            KeyEventType.KeyUp -> {
                handleKeyUp(nativeEvent.keyCode, nativeEvent)
                true
            }
            else -> false
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_CALL && app.kioskPrefs.kioskEnabled) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                Log.d(TAG, "Kiosk: swallowing KEYCODE_CALL to block dialer launch")
            }
            return true
        }

        if (isT320VolumeKnobKey(event.keyCode)) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (event.repeatCount == 0) {
                    adjustT320VolumeKnob(event.keyCode)
                }
                return true
            }
            if (event.action == KeyEvent.ACTION_UP) return true
        }

        if (
            event.action == KeyEvent.ACTION_UP &&
            isSd7SideVolumeKey(event.keyCode, event)
        ) {
            val held = event.eventTime - event.downTime
            if (held >= SD7_SIDE_LONGPRESS_MS) {
                val keyAction = if (event.keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
                    KeyAction.ScanToggle
                } else {
                    KeyAction.ScanListToggleCurrent
                }
                val descriptor = event.device?.descriptor ?: "?"
                Log.d(
                    TAG,
                    "SD7 side-button long-press (held=${held}ms code=${event.keyCode} " +
                        "deviceId=${event.deviceId} desc=$descriptor) — emit $keyAction"
                )
                app.keyEventFlow.tryEmit(keyAction)
                return true
            }
        }

        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (handleKeyCaptureIfActive(keyCode)) return true
        if (isOurKey(keyCode, event)) return handleKeyDown(keyCode, event)
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (app.keyCapturingFlow.value) return true
        if (lastCapturedKeyCode == keyCode) {
            lastCapturedKeyCode = -1
            return true
        }
        if (isOurKey(keyCode, event)) return handleKeyUp(keyCode, event)
        return super.onKeyUp(keyCode, event)
    }

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
                        app.toneEngine.playDeniedBonk()
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

            keyCode == KEY_DPAD_CENTER -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadCenter)
                return true
            }

            isSd7KnobPress(keyCode) -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadCenter)
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

    @Suppress("UNUSED_PARAMETER")
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

    private val SD7_SIDE_LONGPRESS_MS = 600L
    private val T320_VOLUME_ACCEL_WINDOW_MS = 180L
    private val T320_VOLUME_ACCEL_STEPS = 2

    @Suppress("unused")
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
}
