package com.reedersystems.commandcomms.audio.bridge

import android.media.AudioDeviceInfo
import android.media.AudioRecord
import android.util.Log

/**
 * AudioRecord.setPreferredDevice returns Boolean, so it is not exposed as a
 * writable Kotlin synthetic property on every compiler/toolchain combination.
 * This package-local extension keeps the bridge source readable while still
 * logging whether Android accepted the wired input route.
 */
internal var AudioRecord.preferredDevice: AudioDeviceInfo?
    get() = routedDevice
    set(value) {
        val accepted = setPreferredDevice(value)
        Log.d("[UhfBridge]", "Bridge preferred input accepted=$accepted type=${value?.type ?: -1}")
    }
