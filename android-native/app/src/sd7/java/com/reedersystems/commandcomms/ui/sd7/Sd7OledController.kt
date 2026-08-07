package com.reedersystems.commandcomms.ui.sd7

import android.content.Context
import android.util.Log

/**
 * Direct renderer for the Siyata SD7 128x64 top OLED.
 *
 * The SD7 exposes android.app.SmallcdManager as the public `smallcd` system
 * service, but that vendor framework class is not present in the normal Android
 * SDK used by CI. Reflection keeps the SD7 flavor buildable with the stock SDK
 * while still using the real framework service on-device.
 */
object Sd7OledController {
    private const val TAG = "[SD7-OLED]"
    private const val WIDTH = 128
    private const val HEIGHT = 64
    private const val DEVICE_PATH = "/dev/oled_display"

    @Volatile private var initialized = false
    private var service: Any? = null
    private var appId: Int = -1
    private var lastFrameKey: String? = null

    @Synchronized
    private fun ensureInitialized(context: Context): Boolean {
        if (initialized && service != null && appId >= 0) return true

        return try {
            val candidate = context.applicationContext.getSystemService("smallcd")
            if (candidate == null) {
                Log.w(TAG, "smallcd system service unavailable")
                return false
            }

            invoke(candidate, "init", WIDTH, HEIGHT, DEVICE_PATH)
            invoke(candidate, "setWrapText", false)
            val id = invoke(candidate, "getAppId", context.packageName) as? Int
            if (id == null || id < 0) {
                Log.w(TAG, "smallcd getAppId failed for ${context.packageName}: $id")
                return false
            }

            service = candidate
            appId = id
            initialized = true
            Log.i(TAG, "Initialized physical OLED appId=$appId")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "Unable to initialize physical OLED: ${t.message}", t)
            false
        }
    }

    fun render(
        context: Context,
        zoneName: String,
        channelName: String,
        unitId: String,
        status: String,
        batteryPercent: Int?
    ) {
        if (!ensureInitialized(context)) return
        val svc = service ?: return

        val zone = zoneName.trim().uppercase().ifBlank { "NO ZONE" }
        val channel = channelName.trim().uppercase().ifBlank { "NO CHANNEL" }
        val unit = unitId.trim().uppercase().ifBlank { "--" }
        val radioStatus = status.trim().uppercase().ifBlank { "IDLE" }
        val battery = batteryPercent?.let { "${it.coerceIn(0, 100)}%" } ?: "--%"
        val frameKey = "$zone|$channel|$unit|$radioStatus|$battery"
        if (frameKey == lastFrameKey) return

        try {
            val covert = (invokeOptional(svc, "getCovertModeStatus") as? Int) ?: 0
            if (covert > 0) {
                Log.d(TAG, "Covert mode active; OLED render skipped")
                return
            }

            invoke(svc, "fillRect", appId, 0, 0, WIDTH, HEIGHT, 0)

            // Make the selected channel the visual priority. It gets the largest
            // font and almost the full width of the display.
            drawFitted(svc, channel, x = 0, y = 0, fontSize = 18, maxWidth = WIDTH)
            drawFitted(svc, "ZN $zone", x = 0, y = 23, fontSize = 10, maxWidth = WIDTH)
            drawFitted(svc, radioStatus, x = 0, y = 38, fontSize = 12, maxWidth = 74)
            drawFitted(svc, "U $unit", x = 0, y = 52, fontSize = 9, maxWidth = 88)

            val batteryWidth = textWidth(svc, battery, 9)
            drawText(svc, battery, (WIDTH - batteryWidth).coerceAtLeast(90), 52, 9)

            val canvas = invoke(svc, "getCanvas", appId) as? ByteArray
            if (canvas == null) {
                Log.w(TAG, "getCanvas returned no framebuffer")
                return
            }
            invoke(svc, "refresh", appId, canvas, 0)
            lastFrameKey = frameKey
            Log.d(TAG, "Rendered OLED channel=$channel zone=$zone status=$radioStatus")
        } catch (t: Throwable) {
            Log.e(TAG, "OLED render failed: ${t.message}", t)
            // Allow a later state update to retry instead of permanently caching
            // a frame that never made it to the panel.
            lastFrameKey = null
        }
    }

    private fun drawFitted(service: Any, raw: String, x: Int, y: Int, fontSize: Int, maxWidth: Int) {
        var text = raw
        if (textWidth(service, text, fontSize) > maxWidth) {
            while (text.length > 2 && textWidth(service, "$text…", fontSize) > maxWidth) {
                text = text.dropLast(1)
            }
            text = "$text…"
        }
        drawText(service, text, x, y, fontSize)
    }

    private fun drawText(service: Any, text: String, x: Int, y: Int, fontSize: Int) {
        // SmallcdManager.drawText(appId, text, flags, x, y, fontSize,
        //                         color, alignH, alignV)
        invoke(service, "drawText", appId, text, 0, x, y, fontSize, 1, 0, 0)
    }

    private fun textWidth(service: Any, text: String, fontSize: Int): Int {
        return try {
            val bounds = invoke(service, "getTextBounds", text, fontSize) as? IntArray
            if (bounds != null && bounds.size >= 4) (bounds[2] - bounds[0]).coerceAtLeast(0)
            else text.length * (fontSize / 2).coerceAtLeast(1)
        } catch (_: Throwable) {
            text.length * (fontSize / 2).coerceAtLeast(1)
        }
    }

    private fun invoke(target: Any, name: String, vararg args: Any?): Any? {
        val method = target.javaClass.methods.firstOrNull { candidate ->
            candidate.name == name && candidate.parameterTypes.size == args.size
        } ?: error("SmallcdManager method not found: $name/${args.size}")
        method.isAccessible = true
        return method.invoke(target, *args)
    }

    private fun invokeOptional(target: Any, name: String, vararg args: Any?): Any? {
        return try {
            invoke(target, name, *args)
        } catch (_: Throwable) {
            null
        }
    }
}
