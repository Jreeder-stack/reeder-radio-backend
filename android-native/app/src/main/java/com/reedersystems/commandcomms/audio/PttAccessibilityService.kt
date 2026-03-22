package com.reedersystems.commandcomms.audio

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.CommandCommsApp

private const val TAG = "[PTT-DIAG]"

// Inrico T320 key codes
private const val KEY_PTT_F11   = 141
private const val KEY_PTT       = 230
private const val KEY_EMERGENCY = 233

/**
 * Accessibility service that captures PTT and emergency hardware key events at the system level.
 *
 * Android only delivers key events to the Activity that holds the foreground window focus.
 * When the app is backgrounded (user pressed Home, device is showing a different app, or the
 * screen is on but locked), MainActivity.onKeyDown() never fires — so PTT/emergency presses
 * are silently dropped.
 *
 * This service uses the AccessibilityService.onKeyEvent() callback, which receives ALL key
 * events regardless of which window has focus. When it detects that our own app is NOT the
 * foreground window, it forwards the key to BackgroundAudioService so PTT/emergency still
 * works. When our app IS in the foreground the event is returned false (not consumed) so that
 * MainActivity.onKeyDown() handles it as normal — preventing double-fire.
 *
 * SETUP: The user must enable this service once in:
 *   Android Settings → Accessibility → Command Comms PTT
 */
class PttAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Not used — we only need key-event interception
    }

    override fun onInterrupt() {
        // Not used
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if (code != KEY_EMERGENCY && code != KEY_PTT && code != KEY_PTT_F11) return false

        // When our app already has focus, let MainActivity.onKeyDown() handle it normally.
        // Returning false here passes the event through without consuming it.
        if (isOurAppForeground()) {
            Log.d(TAG, "PttAccessibilityService: keyCode=$code — app is foreground, deferring to MainActivity")
            return false
        }

        // App is in the background — forward to BackgroundAudioService with a wake lock
        // to prevent the CPU from sleeping between broadcast delivery and service start.
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        val wl = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "CommandComms:AccessibilityWake"
        ).apply { setReferenceCounted(false) }
        wl.acquire(5_000L)

        val svcAction: String? = when {
            code == KEY_EMERGENCY && event.action == KeyEvent.ACTION_DOWN -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            code == KEY_EMERGENCY && event.action == KeyEvent.ACTION_UP   -> BackgroundAudioService.ACTION_EMERGENCY_UP
            (code == KEY_PTT || code == KEY_PTT_F11) && event.action == KeyEvent.ACTION_DOWN -> BackgroundAudioService.ACTION_PTT_DOWN
            (code == KEY_PTT || code == KEY_PTT_F11) && event.action == KeyEvent.ACTION_UP   -> BackgroundAudioService.ACTION_PTT_UP
            else -> null
        }

        if (svcAction == null) return false

        Log.d(TAG, "PttAccessibilityService: background key keyCode=$code → $svcAction")

        val intent = Intent(this, BackgroundAudioService::class.java).apply {
            action = svcAction
            if (svcAction == BackgroundAudioService.ACTION_PTT_DOWN) {
                putExtra(BackgroundAudioService.EXTRA_NEEDS_SIGNALING, true)
            }
        }
        try {
            ContextCompat.startForegroundService(this, intent)
        } catch (e: Exception) {
            Log.e(TAG, "PttAccessibilityService: startForegroundService failed — ${e.message}")
        }

        return true // Consumed — BackgroundAudioService owns this event
    }

    /**
     * Returns true if our app's window is currently the focused foreground window.
     * Uses AccessibilityService.getWindows() which is available when canRetrieveWindowContent
     * or canRequestFilterKeyEvents is true (both are set in ptt_accessibility_service.xml).
     */
    private fun isOurAppForeground(): Boolean {
        return try {
            windows.any { window -> window.isFocused && window.root?.packageName == packageName }
        } catch (e: Exception) {
            Log.w(TAG, "PttAccessibilityService: isOurAppForeground check failed — ${e.message}")
            false // Assume background to be safe (service handles it)
        }
    }
}
