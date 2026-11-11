package com.reedersystems.commandcomms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidApiCompatibilityTest {
    @Test
    fun hd760Android7DoesNotUseUnsupportedApis() {
        assertFalse(AndroidApiCompatibility.supportsLowLatencyAudioTrackMode(25))
        assertFalse(AndroidApiCompatibility.requiresBluetoothRuntimePermission(25))
        assertFalse(AndroidApiCompatibility.requiresNotificationRuntimePermission(25))
    }

    @Test
    fun lowLatencyAudioModeRemainsAvailableToNewerRadios() {
        assertFalse(AndroidApiCompatibility.supportsLowLatencyAudioTrackMode(25))
        assertTrue(AndroidApiCompatibility.supportsLowLatencyAudioTrackMode(26))
        assertTrue(AndroidApiCompatibility.supportsLowLatencyAudioTrackMode(34))
    }

    @Test
    fun bluetoothAndNotificationPermissionBoundaries() {
        assertFalse(AndroidApiCompatibility.requiresBluetoothRuntimePermission(30))
        assertTrue(AndroidApiCompatibility.requiresBluetoothRuntimePermission(31))
        assertFalse(AndroidApiCompatibility.requiresNotificationRuntimePermission(32))
        assertTrue(AndroidApiCompatibility.requiresNotificationRuntimePermission(33))
    }
}
