package com.reedersystems.commandcomms.audio.led

import android.content.Context
import com.reedersystems.commandcomms.audio.radio.RadioStateManager

/**
 * Per-flavor radio status LED driver.
 *
 * The T320 uses NotificationChannel-based LED routing already configured
 * in `CommandCommsApp.createNotificationChannels` (`ptt_service_connected`
 * green / `ptt_service_disconnected` red / `ptt_service_degraded` amber)
 * so its `RadioFlavorLed` is a no-op. The Siyata SD7 status LED is not
 * exposed through NotificationChannel lights on its firmware — it is
 * driven by vendor broadcasts, so the SD7 flavor overrides this object
 * to send those broadcasts on every TX/RX/IDLE transition.
 *
 * Both flavors must provide a `RadioFlavorLed` object with this exact
 * fully-qualified name and `start(...)` signature. `CommandCommsApp.onCreate`
 * calls it once after the `RadioStateManager` is created. Flavor-specific
 * implementations live in:
 *   - app/src/t320/.../audio/led/RadioFlavorLed.kt  (no-op)
 *   - app/src/sd7/.../audio/led/RadioFlavorLed.kt   (Siyata broadcasts)
 *
 * The interface intentionally takes the bare collaborators it needs
 * (Context + RadioStateManager) instead of the whole CommandCommsApp so
 * the per-flavor implementations don't need to import application-layer
 * types.
 */
interface RadioFlavorLedDriver {
    fun start(context: Context, stateManager: RadioStateManager)
}
