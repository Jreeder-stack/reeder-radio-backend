package com.reedersystems.commandcomms

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
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
// SD7 rotary-knob press. Not emitted by any T320 hardware path so adding
// this constant is a non-T320-affecting extension.
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

    /**
     * Receives [CommandCommsApp.ACTION_REMOTE_KIOSK_CHANGED] for the entire
     * lifetime of the activity (registered in [onCreate], unregistered in
     * [onDestroy]) so dispatcher Unlock/Re-lock commands trigger an
     * immediate `startLockTask` / `stopLockTask` regardless of whether the
     * activity is currently in `RESUMED` state. This avoids the race where
     * `startActivity(SINGLE_TOP)` only delivers `onNewIntent` (not
     * `onResume`) when MainActivity is already foregrounded.
     */
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

    /**
     * Activity-side complement to [CommandCommsApp.applyRemoteKioskState]:
     * the Application owns persistent enforcement (apply/clear Device
     * Owner policies, schedule auto-relock, react to dispatcher
     * unlock/relock broadcasts at process level). MainActivity contributes
     * the one piece that requires an Activity context —
     * [android.app.Activity.startLockTask] / [android.app.Activity.stopLockTask].
     *
     * This runs from `onResume`, `onNewIntent`, and the in-activity
     * broadcast receiver so the lock-task transition is guaranteed
     * regardless of which lifecycle path delivers the dispatcher command.
     */
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
        // Re-run the process-level reconciler so timers and policy bundle
        // stay in sync with what the activity just observed (idempotent).
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
        // Cover the singleTop / reorder-to-front relock path: when
        // CommandCommsApp.applyRemoteKioskState() brings an already-RESUMED
        // MainActivity to the front, neither onCreate nor onResume fires —
        // only onNewIntent. Triggering the lock-task transition here ensures
        // dispatcher Re-lock takes effect immediately.
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

    // ── DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────────
    private fun isPttKey(keyCode: Int): Boolean {
        // KEY_PTT_F11 (141) was historically mapped to PTT for some Inrico
        // T320 firmware variants. On the Siyata SD7 the *exact same*
        // keycode is the SOS button (handled via the SOS broadcast path),
        // so we must never treat F11 as PTT on the SD7 build — gate by
        // BuildConfig.FLAVOR.
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

    /**
     * SD7 rotary-knob press alias. Inrico T320 firmware emits
     * KEYCODE_DPAD_CENTER (23) for the channel-knob press, but on the
     * SD7 the same physical button surfaces as KEYCODE_F8 (141 is taken
     * by SOS). Only treated as DpadCenter on the SD7 flavor so the
     * T320 build's F8 behavior — if any — is unaffected.
     */
    private fun isSd7KnobPress(keyCode: Int): Boolean {
        return BuildConfig.FLAVOR == "sd7" && keyCode == KeyEvent.KEYCODE_F8
    }

    /**
     * SD7 side-button volume keys: short press = volume change (system
     * default — we never consume the down event), long press (~600 ms)
     * = scan toggle (top, VOLUME_UP) / scan-list toggle for current
     * channel (bottom, VOLUME_DOWN). Long-press detection happens in
     * [dispatchKeyEvent] off the event's own [KeyEvent.getDownTime] —
     * no state tracking required.
     *
     * Only true on the SD7 flavor AND when the key event originates
     * from an actual hardware input device that is **not** a typing
     * keyboard (the SD7 side buttons surface as gpio-keys with
     * [InputDevice.KEYBOARD_TYPE_NON_ALPHABETIC]; a paired BT keyboard
     * or USB keyboard reports `KEYBOARD_TYPE_ALPHABETIC` and is
     * deliberately excluded so dev rigs that plug a keyboard into an
     * SD7 build keep normal volume behavior). Returns false when the
     * event has no [InputDevice] attached at all (e.g., synthetic /
     * injected events) so we never accidentally claim a non-hardware
     * source. The T320 build never enters this path because of the
     * flavor gate.
     */
    private fun isSd7SideVolumeKey(keyCode: Int, event: KeyEvent?): Boolean {
        if (BuildConfig.FLAVOR != "sd7") return false
        if (keyCode != KeyEvent.KEYCODE_VOLUME_UP && keyCode != KeyEvent.KEYCODE_VOLUME_DOWN) return false
        val device = event?.device ?: return false
        if (device.isVirtual) return false
        if (device.keyboardType == InputDevice.KEYBOARD_TYPE_ALPHABETIC) return false
        return true
    }

    private fun isOurKey(keyCode: Int, @Suppress("UNUSED_PARAMETER") event: KeyEvent? = null): Boolean {
        if (isPttKey(keyCode)) return true
        if (isEmergencyKey(keyCode)) return true
        if (
            keyCode == KEY_DPAD_UP ||
            keyCode == KEY_DPAD_DOWN ||
            keyCode == KEY_DPAD_LEFT ||
            keyCode == KEY_DPAD_RIGHT ||
            keyCode == KEY_DPAD_CENTER  // SD7 rotary-knob press; ignored on T320
        ) return true
        if (isSd7KnobPress(keyCode)) return true
        // SD7 side-button volume keys are intentionally NOT included
        // here. They are handled in dispatchKeyEvent so the short-press
        // path stays uninterrupted by the activity's key-event routing
        // (the system gets the key-down/key-up untouched, the same way
        // it would on any other Android device).
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

    /**
     * First-chance interception so kiosk mode can swallow the green call key
     * before the framework dispatches it to the system dialer. Anything we
     * do NOT swallow here falls through to the normal `onKeyDown` / `onKeyUp`
     * path so PTT / emergency / D-pad handling is unaffected.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_CALL && app.kioskPrefs.kioskEnabled) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                Log.d(TAG, "Kiosk: swallowing KEYCODE_CALL to block dialer launch")
            }
            return true
        }

        // SD7 side-button volume long-press detection. We deliberately do
        // NOT consume the key-down — short-press must fall through to the
        // platform's normal volume handling untouched (correct stream,
        // correct policy/UI). On key-up we measure the held duration off
        // the event's own getDownTime/getEventTime; if it crossed the
        // long-press threshold, we emit the scan KeyAction and consume
        // the up so the system doesn't double-react on release. Short
        // presses still call super and the platform owns volume entirely.
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

            // SD7 rotary-knob press. Cycles unit status (see KeyAction.DpadCenter
            // doc-comment). T320 hardware never emits this keycode so this arm
            // is a no-op on the T320 build.
            keyCode == KEY_DPAD_CENTER -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadCenter)
                return true
            }

            // SD7 channel-knob press surfaces as KEYCODE_F8 on SD7
            // firmware. Aliased to KeyAction.DpadCenter so the same
            // status-cycle handler in RadioViewModel fires. SD7-only.
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
    // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────
}