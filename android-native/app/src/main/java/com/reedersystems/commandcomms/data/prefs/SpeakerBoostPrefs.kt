package com.reedersystems.commandcomms.data.prefs

import android.content.Context
import android.content.SharedPreferences

/**
 * Per-device persisted speaker-boost settings used to make incoming radio
 * audio and pager tones audibly louder on the T320 (and other handsets) on
 * top of Android's stream-volume max.
 *
 * - receiveBoostMb / pagerBoostMb feed an Android `LoudnessEnhancer` audio
 *   effect attached to the playback session (in milli-Bels, 0..1200 = 0..12 dB).
 * - softwareAmplifier feeds the existing PCM gain stage in the RX DSP chain
 *   (replaces the previously hard-coded 2.5x).
 *
 * Backed by a single SharedPreferences file so cross-instance writes (e.g.
 * SettingsScreen vs. RadioAudioEngine) can be observed via
 * [SharedPreferences.OnSharedPreferenceChangeListener].
 */
class SpeakerBoostPrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var receiveBoostMb: Int
        get() = prefs.getInt(KEY_RECEIVE_BOOST_MB, DEFAULT_RECEIVE_BOOST_MB)
        set(value) {
            val clamped = value.coerceIn(0, MAX_BOOST_MB)
            prefs.edit().putInt(KEY_RECEIVE_BOOST_MB, clamped).apply()
        }

    var pagerBoostMb: Int
        get() = prefs.getInt(KEY_PAGER_BOOST_MB, DEFAULT_PAGER_BOOST_MB)
        set(value) {
            val clamped = value.coerceIn(0, MAX_BOOST_MB)
            prefs.edit().putInt(KEY_PAGER_BOOST_MB, clamped).apply()
        }

    var softwareAmplifier: Float
        get() = prefs.getFloat(KEY_SOFTWARE_AMPLIFIER, DEFAULT_SOFTWARE_AMPLIFIER)
        set(value) {
            val clamped = value.coerceIn(MIN_AMPLIFIER, MAX_AMPLIFIER)
            prefs.edit().putFloat(KEY_SOFTWARE_AMPLIFIER, clamped).apply()
        }

    /**
     * Sticky flag recording that the one-time STREAM_VOICE_CALL audible-floor
     * nudge has already been performed on this device. The radio route applier
     * consults this flag so it only ever raises the voice-call stream up to a
     * minimum audible level on the very first session after install / data
     * clear, and never overrides a level the operator has subsequently chosen
     * (e.g. via the T320 speaker-mic volume knob).
     */
    var voiceCallFloorApplied: Boolean
        get() = prefs.getBoolean(KEY_VOICE_CALL_FLOOR_APPLIED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_VOICE_CALL_FLOOR_APPLIED, value).apply()
        }

    fun registerOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
        prefs.registerOnSharedPreferenceChangeListener(listener)
    }

    fun unregisterOnChange(listener: SharedPreferences.OnSharedPreferenceChangeListener) {
        prefs.unregisterOnSharedPreferenceChangeListener(listener)
    }

    companion object {
        const val PREFS_NAME = "speaker_boost_prefs"

        const val KEY_RECEIVE_BOOST_MB = "receive_boost_mb"
        const val KEY_PAGER_BOOST_MB = "pager_boost_mb"
        const val KEY_SOFTWARE_AMPLIFIER = "software_amplifier"
        const val KEY_VOICE_CALL_FLOOR_APPLIED = "voice_call_floor_applied"

        const val DEFAULT_RECEIVE_BOOST_MB = 600
        const val DEFAULT_PAGER_BOOST_MB = 600
        const val DEFAULT_SOFTWARE_AMPLIFIER = 2.5f

        const val MAX_BOOST_MB = 1200
        const val MIN_AMPLIFIER = 1.0f
        const val MAX_AMPLIFIER = 2.5f

        /**
         * First-run minimum audible fraction of STREAM_VOICE_CALL max. Picked
         * so a freshly installed app is not silent if the device shipped with
         * the voice-call stream muted, but low enough that it never feels like
         * the app is hijacking the volume from the operator on subsequent runs.
         */
        const val VOICE_CALL_FIRST_RUN_FLOOR_FRACTION = 0.6

        val AMPLIFIER_STEPS: List<Float> = listOf(1.0f, 1.5f, 2.0f, 2.5f)
    }
}
