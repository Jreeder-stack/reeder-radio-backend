package com.reedersystems.commandcomms.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log

private const val TAG = "[PTT-DIAG]"

/**
 * Exported BroadcastReceiver that catches Inrico T320 firmware-level PTT broadcasts
 * regardless of screen state or app lifecycle — no accessibility service required.
 *
 * Known T320 vendor broadcast actions are mapped to BackgroundAudioService PTT commands.
 * A short-duration PARTIAL_WAKE_LOCK bridges the gap between broadcast delivery and
 * service startup so the CPU cannot sleep in that window.
 *
 * Internal self-sent actions (ACTION_PTT_DOWN / ACTION_PTT_UP) are also handled here
 * as before, for compatibility with any callers that still use the internal broadcast path.
 */
class PttHardwareReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return

        Log.d(TAG, "PttHardwareReceiver.onReceive action=$action extras=${intent.extras}")

        val pttAction: String? = when (action) {
            // Internal self-sent actions (legacy / foreground callers)
            ACTION_PTT_DOWN -> BackgroundAudioService.ACTION_PTT_DOWN
            ACTION_PTT_UP   -> BackgroundAudioService.ACTION_PTT_UP

            // Generic Android PTT broadcast with pttKeyState extra (some Inrico firmware)
            "android.intent.action.PTT" -> {
                val state = intent.getIntExtra("pttKeyState", -1)
                Log.d(TAG, "PTT broadcast pttKeyState=$state")
                if (state == 1) BackgroundAudioService.ACTION_PTT_DOWN
                else if (state == 0) BackgroundAudioService.ACTION_PTT_UP
                else null
            }

            // Inrico T320 firmware — standard Android namespace
            "android.intent.action.PTT_KEY_DOWN"  -> BackgroundAudioService.ACTION_PTT_DOWN
            "android.intent.action.PTT_KEY_UP"    -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — vendor namespace
            "com.inrico.ptt.PTT_KEY_DOWN"         -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.inrico.ptt.PTT_KEY_UP"           -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — telecom namespace (seen on some ROM versions)
            "com.android.server.telecom.PushToTalk.action.PTT_KEY_DOWN" -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.android.server.telecom.PushToTalk.action.PTT_KEY_UP"   -> BackgroundAudioService.ACTION_PTT_UP

            else -> {
                Log.d(TAG, "PttHardwareReceiver: unrecognised action=$action — ignoring")
                null
            }
        }

        if (pttAction == null) return

        Log.d(TAG, "PttHardwareReceiver: mapped action=$action -> svcAction=$pttAction")

        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            WAKE_LOCK_TAG
        ).apply { setReferenceCounted(false) }

        // Acquire with a timed timeout so the WakeLock acts as a true bridge between
        // broadcast delivery and service intent handling. We do NOT release it eagerly —
        // the 5 s timeout guarantees the CPU stays awake long enough for the service to
        // reach onStartCommand, even if the system is under load. The lock auto-releases
        // after the timeout so there is no risk of a permanent leak.
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS)
        Log.d(TAG, "PttHardwareReceiver: WakeLock acquired (auto-releases in ${WAKE_LOCK_TIMEOUT_MS}ms)")

        val serviceIntent = Intent(context, BackgroundAudioService::class.java).apply {
            this.action = pttAction
        }
        context.startForegroundService(serviceIntent)
    }

    companion object {
        const val ACTION_PTT_DOWN = "com.reedersystems.commandcomms.PTT_DOWN"
        const val ACTION_PTT_UP   = "com.reedersystems.commandcomms.PTT_UP"

        private const val WAKE_LOCK_TAG       = "CommandComms:PttReceiver"
        private const val WAKE_LOCK_TIMEOUT_MS = 5_000L
    }
}
