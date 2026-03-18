package com.reedersystems.commandcomms

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
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

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { results ->
        results.forEach { (perm, granted) ->
            Log.d(TAG, "Permission $perm granted=$granted")
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
        val perms = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        permissionLauncher.launch(perms.toTypedArray())
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KEY_PTT -> {
                if (event?.repeatCount == 0) {
                    Log.d(TAG, "MainActivity PTT DOWN keyCode=$keyCode")
                    sendPttIntent(BackgroundAudioService.ACTION_PTT_DOWN)
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
                app.keyEventFlow.tryEmit(KeyAction.DpadUp)
                return true
            }
            KEY_DPAD_DOWN -> {
                app.keyEventFlow.tryEmit(KeyAction.DpadDown)
                return true
            }
            KEY_DPAD_LEFT -> {
                app.keyEventFlow.tryEmit(KeyAction.DpadLeft)
                return true
            }
            KEY_DPAD_RIGHT -> {
                app.keyEventFlow.tryEmit(KeyAction.DpadRight)
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
                Log.d(TAG, "MainActivity PTT UP keyCode=$keyCode")
                sendPttIntent(BackgroundAudioService.ACTION_PTT_UP)
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

    private fun sendPttIntent(action: String) {
        val intent = Intent(this, BackgroundAudioService::class.java).apply {
            this.action = action
        }
        startForegroundService(intent)
    }
}
