package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences

data class UhfBridgeConfig(
    val enabled: Boolean = false,
    val activationDb: Float = -35f,
    val deactivationDb: Float = -40f,
    val triggerMs: Int = 150,
    val hangMs: Int = 750,
    val lockoutMs: Int = 500,
    val minimumTxMs: Int = 400,
    val maximumTxMs: Int = 90_000,
    val inputGain: Float = 1.0f,
    val outputGain: Float = 1.0f,
    val voxLeadInMs: Int = 200
)

class UhfBridgePrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) = prefs.edit().putBoolean(KEY_ENABLED, value).apply()

    var activationDb: Float
        get() = prefs.getFloat(KEY_ACTIVATION_DB, -35f)
        set(value) = prefs.edit().putFloat(KEY_ACTIVATION_DB, value.coerceIn(-60f, -10f)).apply()

    var deactivationDb: Float
        get() = prefs.getFloat(KEY_DEACTIVATION_DB, -40f)
        set(value) = prefs.edit().putFloat(KEY_DEACTIVATION_DB, value.coerceIn(-65f, -15f)).apply()

    var triggerMs: Int
        get() = prefs.getInt(KEY_TRIGGER_MS, 150)
        set(value) = prefs.edit().putInt(KEY_TRIGGER_MS, value.coerceIn(50, 1_000)).apply()

    var hangMs: Int
        get() = prefs.getInt(KEY_HANG_MS, 750)
        set(value) = prefs.edit().putInt(KEY_HANG_MS, value.coerceIn(200, 3_000)).apply()

    var lockoutMs: Int
        get() = prefs.getInt(KEY_LOCKOUT_MS, 500)
        set(value) = prefs.edit().putInt(KEY_LOCKOUT_MS, value.coerceIn(100, 2_000)).apply()

    var minimumTxMs: Int
        get() = prefs.getInt(KEY_MIN_TX_MS, 400)
        set(value) = prefs.edit().putInt(KEY_MIN_TX_MS, value.coerceIn(200, 2_000)).apply()

    var maximumTxMs: Int
        get() = prefs.getInt(KEY_MAX_TX_MS, 90_000)
        set(value) = prefs.edit().putInt(KEY_MAX_TX_MS, value.coerceIn(15_000, 180_000)).apply()

    var inputGain: Float
        get() = prefs.getFloat(KEY_INPUT_GAIN, 1.0f)
        set(value) = prefs.edit().putFloat(KEY_INPUT_GAIN, value.coerceIn(0.5f, 3.0f)).apply()

    var outputGain: Float
        get() = prefs.getFloat(KEY_OUTPUT_GAIN, 1.0f)
        set(value) = prefs.edit().putFloat(KEY_OUTPUT_GAIN, value.coerceIn(0.5f, 2.0f)).apply()

    var voxLeadInMs: Int
        get() = prefs.getInt(KEY_VOX_LEAD_IN_MS, 200)
        set(value) = prefs.edit().putInt(KEY_VOX_LEAD_IN_MS, value.coerceIn(0, 500)).apply()

    fun load(): UhfBridgeConfig {
        val activation = activationDb
        val deactivation = deactivationDb.coerceAtMost(activation - 1f)
        return UhfBridgeConfig(
            enabled = enabled,
            activationDb = activation,
            deactivationDb = deactivation,
            triggerMs = triggerMs,
            hangMs = hangMs,
            lockoutMs = lockoutMs,
            minimumTxMs = minimumTxMs,
            maximumTxMs = maximumTxMs,
            inputGain = inputGain,
            outputGain = outputGain,
            voxLeadInMs = voxLeadInMs
        )
    }

    companion object {
        const val PREFS_NAME = "CommandCommsUhfBridgePrefs"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_ACTIVATION_DB = "activation_db"
        private const val KEY_DEACTIVATION_DB = "deactivation_db"
        private const val KEY_TRIGGER_MS = "trigger_ms"
        private const val KEY_HANG_MS = "hang_ms"
        private const val KEY_LOCKOUT_MS = "lockout_ms"
        private const val KEY_MIN_TX_MS = "minimum_tx_ms"
        private const val KEY_MAX_TX_MS = "maximum_tx_ms"
        private const val KEY_INPUT_GAIN = "input_gain"
        private const val KEY_OUTPUT_GAIN = "output_gain"
        private const val KEY_VOX_LEAD_IN_MS = "vox_lead_in_ms"
    }
}
