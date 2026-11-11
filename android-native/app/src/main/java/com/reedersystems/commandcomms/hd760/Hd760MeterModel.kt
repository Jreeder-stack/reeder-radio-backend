package com.reedersystems.commandcomms.hd760

import com.reedersystems.commandcomms.audio.radio.SignalQuality

/** Display-only quality levels. Null means there is no trustworthy reading. */
object Hd760MeterModel {
    fun wifiBars(rssiDbm: Int?): Int? {
        val value = rssiDbm ?: return null
        if (value >= 0 || value <= -127) return null
        return when {
            value >= -55 -> 5
            value >= -65 -> 4
            value >= -75 -> 3
            value >= -85 -> 2
            else -> 1
        }
    }

    fun gpsBars(accuracyMeters: Float?, ageMillis: Long): Int? {
        val accuracy = accuracyMeters ?: return null
        if (accuracy <= 0f || ageMillis < 0 || ageMillis > 30_000L) return null
        return when {
            accuracy <= 5f -> 5
            accuracy <= 10f -> 4
            accuracy <= 20f -> 3
            accuracy <= 50f -> 2
            else -> 1
        }
    }

    fun cellularBars(platformLevel: Int?): Int? =
        platformLevel?.takeIf { it in 0..4 }?.let { if (it == 0) 1 else it + 1 }

    /** Live PCM RMS in signed 16-bit units, not a synthetic signal-strength meter. */
    fun audioBars(rms: Double): Int = when {
        !rms.isFinite() || rms < 80.0 -> 0
        rms < 250.0 -> 1
        rms < 650.0 -> 2
        rms < 1_600.0 -> 3
        rms < 4_000.0 -> 4
        else -> 5
    }

    fun receiveBars(quality: SignalQuality): Int? = when (quality) {
        SignalQuality.EXCELLENT -> 5
        SignalQuality.GOOD -> 4
        SignalQuality.FAIR -> 3
        SignalQuality.POOR -> 1
        SignalQuality.NONE -> null
    }
}
