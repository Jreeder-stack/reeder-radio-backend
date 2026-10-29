package com.reedersystems.commandcomms.ui.radio

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.os.Build
import android.telephony.CellInfoCdma
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoWcdma
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.hd760.Hd760MeterModel

/** Real Android platform readings. Null strength denotes unsupported/unavailable, not zero. */
data class Hd760Connectivity(
    val wifiConnected: Boolean = false,
    val wifiBars: Int? = null,
    val cellConnected: Boolean = false,
    val cellBars: Int? = null,
    val gpsFix: Boolean = false,
    val gpsBars: Int? = null,
    val bluetoothConnected: Boolean = false,
    val bluetoothBars: Int? = null
)

object Hd760ConnectivityReader {
    fun read(context: Context): Hd760Connectivity {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        @Suppress("DEPRECATION")
        val wifiConnected = runCatching {
            connectivity?.getNetworkInfo(ConnectivityManager.TYPE_WIFI)?.isConnected == true
        }.getOrDefault(false)
        @Suppress("DEPRECATION")
        val cellConnected = runCatching {
            connectivity?.getNetworkInfo(ConnectivityManager.TYPE_MOBILE)?.isConnected == true
        }.getOrDefault(false)

        val wifiBars = if (wifiConnected) runCatching {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            val rssi = wifi.connectionInfo?.rssi
            Hd760MeterModel.wifiBars(rssi)
        }.getOrNull() else null

        val cellBars = if (cellConnected &&
            (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED)) runCatching {
            val telephony = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
            @Suppress("DEPRECATION")
            val registered = telephony.allCellInfo?.firstOrNull { it.isRegistered }
            val level = when (registered) {
                is CellInfoLte -> registered.cellSignalStrength.level
                is CellInfoGsm -> registered.cellSignalStrength.level
                is CellInfoWcdma -> registered.cellSignalStrength.level
                is CellInfoCdma -> registered.cellSignalStrength.level
                else -> null
            }
            Hd760MeterModel.cellularBars(level)
        }.getOrNull() else null

        val gpsBars = if (ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED) runCatching {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) null
            else {
                @Suppress("MissingPermission")
                val fix = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                Hd760MeterModel.gpsBars(
                    if (fix?.hasAccuracy() == true) fix.accuracy else null,
                    if (fix == null) Long.MAX_VALUE else System.currentTimeMillis() - fix.time
                )
            }
        }.getOrNull() else null

        val bluetoothConnected = runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) false
            else {
                @Suppress("DEPRECATION")
                val adapter = BluetoothAdapter.getDefaultAdapter()
                @Suppress("DEPRECATION")
                adapter?.isEnabled == true &&
                    (adapter.getProfileConnectionState(BluetoothProfile.HEADSET) ==
                        BluetoothProfile.STATE_CONNECTED ||
                        adapter.getProfileConnectionState(BluetoothProfile.A2DP) ==
                        BluetoothProfile.STATE_CONNECTED)
            }
        }.getOrDefault(false)

        // No reliable Classic Bluetooth RSSI is exposed by Android's connection-state API.
        return Hd760Connectivity(
            wifiConnected = wifiConnected, wifiBars = wifiBars,
            cellConnected = cellConnected, cellBars = cellBars,
            gpsFix = gpsBars != null, gpsBars = gpsBars,
            bluetoothConnected = bluetoothConnected, bluetoothBars = null
        )
    }
}
