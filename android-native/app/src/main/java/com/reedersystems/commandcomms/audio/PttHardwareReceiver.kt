package com.reedersystems.commandcomms.audio

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.util.Log
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.KeyAction

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
        val action = intent.action ?: run {
            Log.w(TAG, "[RadioError] PttHardwareReceiver.onReceive: null action — ignoring")
            return
        }

        Log.d(TAG, "PttHardwareReceiver.onReceive action=$action extras=${intent.extras} source=broadcast")

        // All PTT events are forwarded to BackgroundAudioService regardless of screen state.
        // The service's CONNECTING/TRANSMITTING guard prevents double-firing if both
        // the key-event path and the broadcast path arrive simultaneously.

        // ── DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────────
        // Every action→service mapping below has been verified against Inrico T320
        // firmware broadcasts and must not be changed, reordered, or removed.
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

            // Inrico T320 firmware — longpress (consume + abort to suppress built-in beep sounds)
            "android.intent.action.PTT.longpress",
            "android.intent.action.PTT_LONGPRESS",
            "com.inrico.ptt.longpress",
            "com.inrico.intent.action.PTT_LONGPRESS"  -> {
                Log.d(TAG, "PttHardwareReceiver: longpress consumed action=$action ordered=${isOrderedBroadcast} — suppressing T320 default beep")
                if (isOrderedBroadcast) {
                    abortBroadcast()
                    Log.d(TAG, "PttHardwareReceiver: ordered broadcast ABORTED for action=$action")
                } else {
                    Log.w(TAG, "PttHardwareReceiver: longpress is NORMAL broadcast (not ordered) — abortBroadcast not possible for action=$action")
                }
                null
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

            // Confirmed SOS broadcasts from PhoneWindowManager.interceptKeyBeforeQueueing on Inrico T320
            "android.intent.action.SOS.down"              -> BackgroundAudioService.ACTION_EMERGENCY_DOWN
            "android.intent.action.SOS.up"                -> BackgroundAudioService.ACTION_EMERGENCY_UP
            "android.intent.action.SOS.shortpress"        -> {
                Log.d(TAG, "PttHardwareReceiver: SOS.shortpress — firing emergency DOWN+UP sequence")
                BackgroundAudioService.ACTION_EMERGENCY_DOWN
            }

            // ── Siyata SD7 firmware mappings (confirmed via on-device
            // logcat capture, May 2026). These mappings are only reachable
            // when the SD7 manifest overlay (src/sd7/AndroidManifest.xml)
            // registers the corresponding intent-filters, so the T320
            // build is unaffected at runtime even though the `when` arms
            // are compiled in. The previous best-effort `com.siyata.*`
            // entries have been removed because the SD7 firmware never
            // emits them — confirmed on real hardware.

            // SD7 PTT (side big button) — Airbus PMR firmware namespace
            "com.airbus.pmr.action.PTT_START"             -> BackgroundAudioService.ACTION_PTT_DOWN
            "com.airbus.pmr.action.PTT_STOP"              -> BackgroundAudioService.ACTION_PTT_UP

            // SD7 SOS (top button). The firmware emits one-shot SOS
            // broadcasts without a paired UP we need to honor; we
            // synthesize EMERGENCY_UP after EMERGENCY_DOWN below
            // (same shape as android.intent.action.SOS.shortpress).
            "android.intent.action.SOS_BUTTON",
            "com.kodiak.intent.action.KEYCODE_SOS"        -> {
                Log.d(TAG, "PttHardwareReceiver: SD7 SOS one-shot ($action) — firing emergency DOWN+UP sequence")
                BackgroundAudioService.ACTION_EMERGENCY_DOWN
            }

            // SD7 channel knob rotation. Routed to the radio ViewModel
            // through KeyAction.DpadDown / DpadUp (which call
            // prevChannel() / nextChannel()) so no new VM wiring is
            // required. Handled below — no service intent to send.
            "android.intent.action.CHANNEL.prev",
            "com.airbus.pmr.action.GROUP_SELECT_PREVIOUS" -> {
                emitKeyAction(context, KeyAction.DpadDown, action)
                null
            }
            "android.intent.action.CHANNEL.next",
            "com.airbus.pmr.action.GROUP_SELECT_NEXT"     -> {
                emitKeyAction(context, KeyAction.DpadUp, action)
                null
            }

            else -> {
                Log.w(TAG, "[RadioError] PttHardwareReceiver: unrecognised action=$action — ignoring (no mapping found)")
                null
            }
        }
        // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────

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

        val isSosShortpress =
            action == "android.intent.action.SOS.shortpress" ||
            action == "android.intent.action.SOS_BUTTON" ||
            action == "com.kodiak.intent.action.KEYCODE_SOS"

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

        if (isSosShortpress) {
            val upIntent = Intent(context, BackgroundAudioService::class.java).apply {
                this.action = BackgroundAudioService.ACTION_EMERGENCY_UP
            }
            try {
                context.startForegroundService(upIntent)
                Log.d(TAG, "PttHardwareReceiver: SOS.shortpress follow-up EMERGENCY_UP sent")
            } catch (e: Exception) {
                Log.e(TAG, "PttHardwareReceiver: SOS.shortpress EMERGENCY_UP failed — ${e::class.simpleName}: ${e.message}")
            }
        }
    }

    /**
     * Emit a [KeyAction] onto the application's shared key-event flow so
     * RadioViewModel can react. Used for SD7 channel-knob rotation
     * broadcasts that are not service-level commands. Safe no-op if the
     * Application has not finished initializing yet.
     */
    private fun emitKeyAction(context: Context, key: KeyAction, action: String) {
        val app = context.applicationContext as? CommandCommsApp ?: run {
            Log.w(TAG, "PttHardwareReceiver: cannot emit $key for $action — Application not ready")
            return
        }
        val ok = app.keyEventFlow.tryEmit(key)
        Log.d(TAG, "PttHardwareReceiver: emitted KeyAction=$key for action=$action accepted=$ok")
    }

    // ── DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────────
    companion object {
        const val ACTION_PTT_DOWN       = "com.reedersystems.commandcomms.PTT_DOWN"
        const val ACTION_PTT_UP         = "com.reedersystems.commandcomms.PTT_UP"
        const val ACTION_EMERGENCY_DOWN = "com.reedersystems.commandcomms.EMERGENCY_DOWN"
        const val ACTION_EMERGENCY_UP   = "com.reedersystems.commandcomms.EMERGENCY_UP"

        private const val WAKE_LOCK_TAG       = "CommandComms:PttReceiver"
        private const val WAKE_LOCK_TIMEOUT_MS = 5_000L
    }
    // ── END DO NOT MODIFY — VERIFIED HARDWARE MAPPING ──────────────────
}
