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

        // All PTT events are forwarded to BackgroundAudioService regardless of screen state.
        // The service's CONNECTING/TRANSMITTING guard prevents double-firing if both
        // the key-event path and the broadcast path arrive simultaneously.

        val pttAction: String? = when (action) {
            // Internal self-sent actions (legacy / foreground callers)
            ACTION_PTT_DOWN     -> BackgroundAudioService.ACTION_PTT_DOWN
            ACTION_PTT_UP       -> BackgroundAudioService.ACTION_PTT_UP
            ACTION_EMERGENCY_DOWN -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            ACTION_EMERGENCY_UP   -> BackgroundAudioService.ACTION_EMERGENCY_UP

            // Generic Android PTT broadcast with pttKeyState extra (some Inrico firmware)
            "android.intent.action.PTT" -> {
                val state = intent.getIntExtra("pttKeyState", -1)
                Log.d(TAG, "PTT broadcast pttKeyState=$state")
                if (state == 1) BackgroundAudioService.ACTION_PTT_DOWN
                else if (state == 0) BackgroundAudioService.ACTION_PTT_UP
                else null
            }

            // Inrico T320 firmware — confirmed primary actions from Zello logcat (dot-separated, lowercase)
            "android.intent.action.PTT.down"      -> BackgroundAudioService.ACTION_PTT_DOWN
            "android.intent.action.PTT.up"        -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — underscore variant
            "android.intent.action.PTT_DOWN"      -> BackgroundAudioService.ACTION_PTT_DOWN
            "android.intent.action.PTT_UP"        -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — standard Android namespace (_KEY_ variant)
            "android.intent.action.PTT_KEY_DOWN"  -> BackgroundAudioService.ACTION_PTT_DOWN
            "android.intent.action.PTT_KEY_UP"    -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — vendor namespace (lowercase, confirmed)
            "com.inrico.ptt.down"                 -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.inrico.ptt.up"                   -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — vendor namespace (PTT_KEY_ prefix variant)
            "com.inrico.ptt.PTT_KEY_DOWN"         -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.inrico.ptt.PTT_KEY_UP"           -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — vendor namespace with intent.action prefix
            "com.inrico.intent.action.PTT_DOWN"   -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.inrico.intent.action.PTT_UP"     -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 firmware — telecom namespace (seen on some ROM versions)
            "com.android.server.telecom.PushToTalk.action.PTT_KEY_DOWN" -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.android.server.telecom.PushToTalk.action.PTT_KEY_UP"   -> BackgroundAudioService.ACTION_PTT_UP

            // Inrico T320 emergency button broadcasts
            // Dot-separated lowercase (mirrors the confirmed PTT.down / PTT.up pattern)
            "android.intent.action.EMERGENCY.down"        -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "android.intent.action.EMERGENCY.up"          -> BackgroundAudioService.ACTION_EMERGENCY_UP
            // Underscore variants
            "android.intent.action.EMERGENCY_DOWN"        -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "android.intent.action.EMERGENCY_UP"          -> BackgroundAudioService.ACTION_EMERGENCY_UP
            // Vendor namespace
            "com.inrico.emergency.down"                   -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "com.inrico.emergency.up"                     -> BackgroundAudioService.ACTION_EMERGENCY_UP
            "com.inrico.emergency.EMERGENCY.down"         -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "com.inrico.emergency.EMERGENCY.up"           -> BackgroundAudioService.ACTION_EMERGENCY_UP
            "com.inrico.intent.action.EMERGENCY_DOWN"     -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "com.inrico.intent.action.EMERGENCY_UP"       -> BackgroundAudioService.ACTION_EMERGENCY_UP
            "com.inrico.intent.action.EMERGENCY.down"     -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "com.inrico.intent.action.EMERGENCY.up"       -> BackgroundAudioService.ACTION_EMERGENCY_UP
            // SOS variants (some Inrico firmware labels emergency as SOS)
            "android.intent.action.SOS_KEY_DOWN"          -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "android.intent.action.SOS_KEY_UP"            -> BackgroundAudioService.ACTION_EMERGENCY_UP
            "com.inrico.sos.down"                         -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "com.inrico.sos.up"                           -> BackgroundAudioService.ACTION_EMERGENCY_UP
            "com.inrico.intent.action.SOS_KEY_DOWN"       -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "com.inrico.intent.action.SOS_KEY_UP"         -> BackgroundAudioService.ACTION_EMERGENCY_UP

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
            if (pttAction == BackgroundAudioService.ACTION_PTT_DOWN) {
                putExtra(BackgroundAudioService.EXTRA_NEEDS_SIGNALING, true)
            }
        }
        try {
            context.startForegroundService(serviceIntent)
        } catch (e: Exception) {
            Log.e(TAG, "PttHardwareReceiver: startForegroundService failed — ${e::class.simpleName}: ${e.message}")
        }
    }

    companion object {
        const val ACTION_PTT_DOWN       = "com.reedersystems.commandcomms.PTT_DOWN"
        const val ACTION_PTT_UP         = "com.reedersystems.commandcomms.PTT_UP"
        const val ACTION_EMERGENCY_DOWN = "com.reedersystems.commandcomms.EMERGENCY_DOWN"
        const val ACTION_EMERGENCY_UP   = "com.reedersystems.commandcomms.EMERGENCY_UP"

        private const val WAKE_LOCK_TAG       = "CommandComms:PttReceiver"
        private const val WAKE_LOCK_TIMEOUT_MS = 5_000L
    }
}
