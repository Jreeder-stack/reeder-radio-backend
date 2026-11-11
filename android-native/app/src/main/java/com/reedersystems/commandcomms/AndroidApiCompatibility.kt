package com.reedersystems.commandcomms

import android.os.Build

/**
 * Minimum platform versions for APIs shared by radio and phone flavors.
 * Keep these checks centralized so Android 7 radio builds never invoke
 * methods introduced after API 25, without weakening modern devices.
 */
internal object AndroidApiCompatibility {
    fun supportsLowLatencyAudioTrackMode(sdkInt: Int): Boolean =
        sdkInt >= Build.VERSION_CODES.O

    fun requiresBluetoothRuntimePermission(sdkInt: Int): Boolean =
        sdkInt >= Build.VERSION_CODES.S

    fun requiresNotificationRuntimePermission(sdkInt: Int): Boolean =
        sdkInt >= Build.VERSION_CODES.TIRAMISU
}
