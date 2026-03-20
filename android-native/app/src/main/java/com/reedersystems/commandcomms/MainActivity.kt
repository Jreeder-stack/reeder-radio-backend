package com.reedersystems.commandcomms

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
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

private const val KEY_PTT       = 230
private const val KEY_EMERGENCY = 233
private const val KEY_ACC       = 231
private const val KEY_STAR      = 17
private const val KEY_DPAD_UP   = 19
private const val KEY_DPAD_DOWN = 20
private const val KEY_DPAD_LEFT = 21
private const val KEY_DPAD_RIGHT = 22

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

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KEY_PTT -> {
                if (event?.repeatCount == 0) {
                    Log.d(TAG, "MainActivity PTT DOWN keyCode=$keyCode — dual-path: keyEventFlow + service")
                    if (app.sessionPrefs.micPermissionGranted) {
                        app.keyEventFlow.tryEmit(KeyAction.PttDown)
                        startForegroundService(
                            Intent(this, BackgroundAudioService::class.java).apply {
                                action = BackgroundAudioService.ACTION_PTT_DOWN
                            }
                        )
                    } else {
                        Log.w(TAG, "PTT DOWN hardware key: mic permission denied — blocked")
                        app.toneEngine.playErrorTone()
                    }
                }
                return true
            }
            KEY_EMERGENCY -> {
                if (event?.repeatCount == 0) {
                    Log.d(TAG, "MainActivity EMERGENCY DOWN")
                    app.keyEventFlow.tryEmit(KeyAction.EmergencyDown)
                }
                return true
            }
            KEY_DPAD_UP -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadUp)
                return true
            }
            KEY_DPAD_DOWN -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadDown)
                return true
            }
            KEY_DPAD_LEFT -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadLeft)
                return true
            }
            KEY_DPAD_RIGHT -> {
                if (event?.repeatCount == 0) app.keyEventFlow.tryEmit(KeyAction.DpadRight)
                return true
            }
            KEY_ACC -> {
                if (event?.repeatCount == 0) {
                    app.keyEventFlow.tryEmit(KeyAction.AccToggle)
                }
                return true
            }
            KEY_STAR -> {
                if (event?.repeatCount == 0) {
                    starDownTime = SystemClock.uptimeMillis()
                }
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KEY_PTT -> {
                Log.d(TAG, "MainActivity PTT UP keyCode=$keyCode — dual-path: keyEventFlow + service")
                app.keyEventFlow.tryEmit(KeyAction.PttUp)
                startForegroundService(
                    Intent(this, BackgroundAudioService::class.java).apply {
                        action = BackgroundAudioService.ACTION_PTT_UP
                    }
                )
                return true
            }
            KEY_EMERGENCY -> {
                Log.d(TAG, "MainActivity EMERGENCY UP")
                app.keyEventFlow.tryEmit(KeyAction.EmergencyUp)
                return true
            }
            KEY_STAR -> {
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
