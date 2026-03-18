package com.reedersystems.commandcomms

import android.content.Intent
import android.os.Bundle
import android.view.KeyEvent
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.navigation.AppNavigation
import com.reedersystems.commandcomms.ui.theme.CommandCommsTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CommandCommsTheme {
                AppNavigation()
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (isPttKey(keyCode) && event?.repeatCount == 0) {
            Log.d("[PTT-DIAG]", "MainActivity PTT DOWN keyCode=$keyCode")
            sendPttIntent(BackgroundAudioService.ACTION_PTT_DOWN)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (isPttKey(keyCode)) {
            Log.d("[PTT-DIAG]", "MainActivity PTT UP keyCode=$keyCode")
            sendPttIntent(BackgroundAudioService.ACTION_PTT_UP)
            return true
        }
        return super.onKeyUp(keyCode, event)
    }

    private fun isPttKey(keyCode: Int): Boolean =
        keyCode == KeyEvent.KEYCODE_PTT ||
        keyCode == 233 ||
        keyCode == 288

    private fun sendPttIntent(action: String) {
        val intent = Intent(this, BackgroundAudioService::class.java).apply {
            this.action = action
        }
        startForegroundService(intent)
    }
}
