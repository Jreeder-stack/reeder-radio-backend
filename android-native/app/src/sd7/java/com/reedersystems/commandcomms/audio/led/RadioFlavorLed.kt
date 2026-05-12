package com.reedersystems.commandcomms.audio.led

import android.content.Context
import android.content.Intent
import android.util.Log
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.audio.radio.RadioStateManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

/**
 * SD7 build: drive the Siyata top status LED via vendor broadcasts.
 *
 *   - RadioState.IDLE          → LED off
 *   - RadioState.TRANSMITTING  → LED solid red
 *   - RadioState.RECEIVING     → LED solid green
 *
 * The exact broadcast action name and "color" extras vary by Siyata firmware
 * revision and have to be confirmed on real hardware. We send a wide-net
 * union of the conventions Siyata's PTT firmware is known to use; the
 * receiver side ignores anything it doesn't recognise so spurious
 * broadcasts cause no harm. Once ground truth is known on a physical SD7
 * the unused entries can be trimmed (tracked in
 * `SD7_DEVICE_VALIDATION_REPORT.md` Section D).
 *
 * Logged under `[RadioLED-SD7]` so QA can verify which broadcasts the
 * radio actually accepts.
 */
object RadioFlavorLed : RadioFlavorLedDriver {
    private const val TAG = "[RadioLED-SD7]"

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private const val COLOR_OFF = "off"
    private const val COLOR_RED = "red"
    private const val COLOR_GREEN = "green"

    // Broadcast action names sent on every state transition. Multiple are
    // emitted because Siyata firmware listens on different actions across
    // revisions; the OEM listener ignores unknown actions silently.
    private val LED_ACTIONS = listOf(
        "com.siyata.sd7.LED",
        "com.siyata.intent.action.LED",
        "com.siyata.led.set"
    )

    override fun start(context: Context, stateManager: RadioStateManager) {
        Log.d(TAG, "SD7 RadioFlavorLed: starting state observer")
        val appContext = context.applicationContext
        scope.launch {
            stateManager.state
                .distinctUntilChanged()
                .collect { state ->
                    val color = when (state) {
                        RadioState.IDLE         -> COLOR_OFF
                        RadioState.TRANSMITTING -> COLOR_RED
                        RadioState.RECEIVING    -> COLOR_GREEN
                    }
                    emitLed(appContext, color)
                }
        }
    }

    private fun emitLed(context: Context, color: String) {
        Log.d(TAG, "Setting SD7 status LED → $color")
        for (action in LED_ACTIONS) {
            try {
                val intent = Intent(action).apply {
                    setPackage(null) // system-wide broadcast — Siyata listener is in the firmware
                    putExtra("color", color)
                    putExtra("led_color", color)
                    putExtra("state", color)
                    // Most rugged-PTT LED listeners accept either solid or
                    // blink — we always request solid for unambiguous
                    // operator semantics.
                    putExtra("mode", "solid")
                    putExtra("on", color != COLOR_OFF)
                }
                context.sendBroadcast(intent)
            } catch (e: Exception) {
                Log.w(TAG, "LED broadcast '$action' failed: ${e.message}")
            }
        }
    }
}
