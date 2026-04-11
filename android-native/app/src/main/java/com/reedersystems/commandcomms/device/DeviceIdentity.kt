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

private fun tryReadSerial(): String? {
    return try {
        val s = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Build.getSerial()
        } else {
            @Suppress("DEPRECATION")
            Build.SERIAL
        }
        if (s.isNullOrBlank() || s == Build.UNKNOWN) null else s
    } catch (e: SecurityException) {
        Log.w(TAG, "Cannot read serial — permission denied: ${e.message}")
        null
    } catch (e: Exception) {
        Log.w(TAG, "Cannot read serial: ${e.message}")
        null
    }
}

private fun tryReadImei(context: Context): String? {
    return try {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
            ?: return null
        val imei = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            tm.getImei(0)
        } else {
            @Suppress("DEPRECATION")
            tm.deviceId
        }
        if (imei.isNullOrBlank()) null else imei
    } catch (e: SecurityException) {
        Log.w(TAG, "Cannot read IMEI — permission denied: ${e.message}")
        null
    } catch (e: Exception) {
        Log.w(TAG, "Cannot read IMEI: ${e.message}")
        null
    }
}
