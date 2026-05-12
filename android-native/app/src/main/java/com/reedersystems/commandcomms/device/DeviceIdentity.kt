package com.reedersystems.commandcomms.device

import android.annotation.SuppressLint
import android.content.Context
import android.os.Build
import android.telephony.TelephonyManager
import android.util.Log

private const val TAG = "[DeviceIdentity]"

data class DeviceIdentity(val serial: String?, val imei: String?)

@SuppressLint("HardwareIds", "MissingPermission")
fun readDeviceIdentity(context: Context): DeviceIdentity {
    val serial = tryReadSerial()
    val imei = tryReadImei(context)
    return DeviceIdentity(serial = serial, imei = imei)
}

private fun getSystemProperty(key: String): String? {
    return try {
        val cls = Class.forName("android.os.SystemProperties")
        val method = cls.getMethod("get", String::class.java)
        val value = method.invoke(null, key) as? String
        if (value.isNullOrBlank() || value.equals("unknown", ignoreCase = true)) null else value
    } catch (e: Exception) {
        null
    }
}

private fun tryReadSerial(): String? {
    // Standard SDK — works on API < 29; throws SecurityException on API 29+ without READ_PRIVILEGED_PHONE_STATE
    try {
        val s = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Build.getSerial()
        } else {
            @Suppress("DEPRECATION")
            Build.SERIAL
        }
        if (!s.isNullOrBlank() && s != Build.UNKNOWN) {
            Log.d(TAG, "Serial read via Build API")
            return s
        }
    } catch (e: SecurityException) {
        Log.w(TAG, "Build.getSerial() denied (API 29+ restriction) — trying system properties")
    } catch (e: Exception) {
        Log.w(TAG, "Build.getSerial() failed: ${e.message}")
    }

    // SystemProperties fallback — works on most OEM PTT hardware without any permissions
    val sysPropKeys = listOf(
        "ro.serialno", "ro.boot.serialno", "ro.boot.serialnumber", "sys.serialnumber",
        // Siyata SD7-specific fallbacks — verified per-flavor on first boot
        "ro.siyata.serial", "ro.siyata.serialno", "ro.product.serial"
    )
    for (key in sysPropKeys) {
        val value = getSystemProperty(key)
        if (value != null) {
            Log.d(TAG, "Serial read via system property '$key'")
            return value
        }
    }

    Log.w(TAG, "Could not read serial number from any source")
    return null
}

@SuppressLint("HardwareIds", "MissingPermission")
private fun tryReadImei(context: Context): String? {
    // Standard SDK — returns null on API 29+ for non-system apps
    try {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        if (tm != null) {
            val imei = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                tm.getImei(0)
            } else {
                @Suppress("DEPRECATION")
                tm.deviceId
            }
            if (!imei.isNullOrBlank()) {
                Log.d(TAG, "IMEI read via TelephonyManager")
                return imei
            }
        }
    } catch (e: SecurityException) {
        Log.w(TAG, "TelephonyManager.getImei() denied — trying system properties")
    } catch (e: Exception) {
        Log.w(TAG, "TelephonyManager.getImei() failed: ${e.message}")
    }

    // SystemProperties fallback — common on Qualcomm/MediaTek PTT radio hardware
    val sysPropKeys = listOf(
        "gsm.imei", "ril.IMEI", "ril.imei", "gsm.imei.sv", "persist.radio.imei",
        // Siyata SD7-specific IMEI fallbacks
        "ro.siyata.imei", "persist.siyata.imei"
    )
    for (key in sysPropKeys) {
        val value = getSystemProperty(key)
        if (value != null && value.length >= 14) {
            Log.d(TAG, "IMEI read via system property '$key'")
            return value
        }
    }

    Log.w(TAG, "Could not read IMEI from any source")
    return null
}
