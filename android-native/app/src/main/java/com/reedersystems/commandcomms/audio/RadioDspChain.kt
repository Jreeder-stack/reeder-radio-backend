package com.reedersystems.commandcomms.audio

import android.media.audiofx.DynamicsProcessing
import android.media.audiofx.Equalizer
import android.os.Build
import android.util.Log

private const val TAG = "[RadioDSP]"

/**
 * Applies a "real radio" audio effect chain to the output mix while a LiveKit
 * voice session is active.
 *
 * Uses Android AudioEffect with sessionId=0 (global output mix), which is the
 * correct approach when the underlying audio session ID (from WebRTC/LiveKit) is
 * not accessible. Effects are enabled on connect and disabled on disconnect so
 * they do not affect other app audio (tones, etc.) when the radio is idle.
 *
 * EQ curve produces a classic narrowband radio character:
 *   < 300 Hz  → cut heavily  (remove bass/rumble)
 *   300–800 Hz → slight cut  (reduce muddiness)
 *   800–2500 Hz → flat/boost (voice presence — the "radio crack")
 *   > 2500 Hz  → cut heavily (remove hiss, simulate bandwidth limit)
 *
 * DynamicsProcessing (API 28+) compresses the dynamic range to give the
 * squished, "hot" sound of a transmitter limiter.
 */
class RadioDspChain {

    private var equalizer: Equalizer? = null
    private var dynamics: DynamicsProcessing? = null

    fun enable() {
        disable()
        try {
            applyEqualizer()
        } catch (e: Exception) {
            Log.w(TAG, "Equalizer failed: ${e.message}")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                applyDynamics()
            } catch (e: Exception) {
                Log.w(TAG, "DynamicsProcessing failed: ${e.message}")
            }
        }
        Log.d(TAG, "RadioDspChain enabled")
    }

    fun disable() {
        equalizer?.enabled = false
        equalizer?.release()
        equalizer = null
        dynamics?.enabled = false
        dynamics?.release()
        dynamics = null
        Log.d(TAG, "RadioDspChain disabled")
    }

    private fun applyEqualizer() {
        val eq = Equalizer(0, 0).also { equalizer = it }
        val numBands = eq.numberOfBands
        if (numBands < 5) {
            Log.w(TAG, "EQ has only $numBands bands — skipping")
            return
        }

        // Android equalizer band gains are in milliBels (mB). 0 mB = flat, -1500 mB = -15 dB.
        // Bands vary by device. Typical 5-band layout: 60Hz, 230Hz, 910Hz, 3.6kHz, 14kHz.
        // We target: cut lows, boost mids, cut highs.
        val bandGains = when (numBands.toInt()) {
            5 -> intArrayOf(-1200, -600, 400, 200, -1500)  // 60, 230, 910, 3.6k, 14k Hz
            6 -> intArrayOf(-1200, -700, -200, 400, 200, -1500)
            else -> {
                // Generic: weight toward cutting bottom and top bands, boost middle
                IntArray(numBands.toInt()) { i ->
                    val pos = i.toFloat() / (numBands - 1)  // 0.0 = low, 1.0 = high
                    when {
                        pos < 0.25f -> -1200  // cut lows
                        pos < 0.45f -> -400   // mild cut low-mids
                        pos < 0.65f -> 500    // boost presence
                        pos < 0.80f -> 0      // flat high-mids
                        else        -> -1500  // cut highs
                    }
                }
            }
        }

        for (band in 0 until minOf(numBands.toInt(), bandGains.size)) {
            val minLevel = eq.getBandLevelRange()[0]
            val maxLevel = eq.getBandLevelRange()[1]
            val clamped = bandGains[band].coerceIn(minLevel.toInt(), maxLevel.toInt()).toShort()
            eq.setBandLevel(band.toShort(), clamped)
        }
        eq.enabled = true
        Log.d(TAG, "Equalizer applied: $numBands bands, gains=${bandGains.toList()}")
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.P)
    private fun applyDynamics() {
        // Single-band compressor: ~6:1 ratio, -24 dBFS threshold, fast attack, moderate release.
        // This gives the "squished transmitter" sound without killing intelligibility.
        val config = DynamicsProcessing.Config.Builder(
            DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
            /* numChannels = */ 2,
            /* preEqInUse = */ false, /* numPreEqBands = */ 1,
            /* mbcInUse = */ false, /* numMbcBands = */ 1,
            /* postEqInUse = */ false, /* numPostEqBands = */ 1,
            /* limiterInUse = */ true
        ).build()

        val dp = DynamicsProcessing(0, 0, config).also { dynamics = it }

        // Set limiter: threshold -9 dBFS, ratio 10:1 (hard limit), attack 5ms, release 100ms
        for (ch in 0 until 2) {
            val limiter = dp.getLimiterByChannelIndex(ch)
            limiter.apply {
                isEnabled = true
                linkGroup = 0
                attackTime = 5f
                releaseTime = 100f
                ratio = 10f
                threshold = -9f
                postGain = 3f
            }
            dp.setLimiterByChannelIndex(ch, limiter)
        }
        dp.enabled = true
        Log.d(TAG, "DynamicsProcessing (limiter) applied")
    }
}
