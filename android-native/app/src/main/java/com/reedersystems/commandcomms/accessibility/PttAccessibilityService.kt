package com.reedersystems.commandcomms.accessibility

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import com.reedersystems.commandcomms.audio.BackgroundAudioService

private const val TAG = "[PTT-DIAG]"

class PttAccessibilityService : AccessibilityService() {

    private var pttHeld = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d(TAG, "PttAccessibilityService connected — intercepting hardware keys globally")
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        val action = event.action
        val actionLabel = if (action == KeyEvent.ACTION_DOWN) "DOWN" else if (action == KeyEvent.ACTION_UP) "UP" else "OTHER"
        val repeat = event.repeatCount
        val ts = System.currentTimeMillis()

        Log.d(TAG, "AccessSvc onKeyEvent source=AccessibilityService code=$code action=$actionLabel repeat=$repeat ts=$ts pttHeld=$pttHeld")

        val isPtt = code == KEYCODE_F11 || code == KEY_PTT_LEGACY
        if (!isPtt) return false

        return when (action) {
            KeyEvent.ACTION_DOWN -> {
                if (repeat > 0 || pttHeld) {
                    Log.d(TAG, "AccessSvc PTT DOWN suppressed source=AccessibilityService code=$code repeat=$repeat pttHeld=$pttHeld ts=$ts")
                    true
                } else {
                    Log.d(TAG, "AccessSvc PTT DOWN forwarding source=AccessibilityService code=$code repeat=$repeat ts=$ts")
                    pttHeld = true
                    lastPttDownMs = ts
                    startForegroundService(
                        Intent(this, BackgroundAudioService::class.java).apply {
                            action = BackgroundAudioService.ACTION_PTT_DOWN
                        }
                    )
                    true
                }
            }
            KeyEvent.ACTION_UP -> {
                if (!pttHeld) {
                    Log.d(TAG, "AccessSvc PTT UP suppressed source=AccessibilityService code=$code ts=$ts (not held)")
                    true
                } else {
                    Log.d(TAG, "AccessSvc PTT UP forwarding source=AccessibilityService code=$code ts=$ts")
                    pttHeld = false
                    lastPttUpMs = ts
                    startForegroundService(
                        Intent(this, BackgroundAudioService::class.java).apply {
                            action = BackgroundAudioService.ACTION_PTT_UP
                        }
                    )
                    true
                }
            }
            else -> false
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // No-op: we only need key event interception, not accessibility events
    }

    override fun onInterrupt() {
        Log.d(TAG, "AccessSvc onInterrupt")
    }

    override fun onDestroy() {
        super.onDestroy()
        pttHeld = false
        Log.d(TAG, "PttAccessibilityService destroyed")
    }

    companion object {
        const val KEYCODE_F11 = 141
        const val KEY_PTT_LEGACY = 230

        @Volatile var lastPttDownMs: Long = 0L
        @Volatile var lastPttUpMs: Long = 0L
    }
}
