package com.reedersystems.commandcomms

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.util.Log
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

class RadioVoiceDSP(private val sampleRate: Int = 48000) {
    
    companion object {
        private const val TAG = "RadioVoiceDSP"
        
        private const val HIGHPASS_FREQ = 300f
        private const val LOWPASS_FREQ = 3400f
        
        private const val COMPRESSOR_THRESHOLD = -24f
        private const val COMPRESSOR_RATIO = 8f
        private const val COMPRESSOR_ATTACK_MS = 3f
        private const val COMPRESSOR_RELEASE_MS = 150f
        
        private const val SATURATION_AMOUNT = 0.3f
        private const val OUTPUT_GAIN = 1.4f
    }
    
    private var highpassInputState = DoubleArray(2) { 0.0 }
    private var highpassOutputState = DoubleArray(2) { 0.0 }
    private var lowpassInputState = DoubleArray(2) { 0.0 }
    private var lowpassOutputState = DoubleArray(2) { 0.0 }
    
    private var highpassCoeffs = DoubleArray(5)
    private var lowpassCoeffs = DoubleArray(5)
    
    private var compressorEnvelope = 0.0
    private var attackCoeff = 0.0
    private var releaseCoeff = 0.0
    
    private var agc: AutomaticGainControl? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    
    init {
        calculateBiquadCoeffs()
        calculateCompressorCoeffs()
        Log.d(TAG, "RadioVoiceDSP initialized: sampleRate=$sampleRate")
    }
    
    private fun calculateBiquadCoeffs() {
        val omega = 2.0 * Math.PI * HIGHPASS_FREQ / sampleRate
        val sinOmega = Math.sin(omega)
        val cosOmega = Math.cos(omega)
        val alpha = sinOmega / (2.0 * 0.707)
        
        val a0 = 1.0 + alpha
        highpassCoeffs[0] = ((1.0 + cosOmega) / 2.0) / a0
        highpassCoeffs[1] = (-(1.0 + cosOmega)) / a0
        highpassCoeffs[2] = ((1.0 + cosOmega) / 2.0) / a0
        highpassCoeffs[3] = (-2.0 * cosOmega) / a0
        highpassCoeffs[4] = (1.0 - alpha) / a0
        
        val omegaLp = 2.0 * Math.PI * LOWPASS_FREQ / sampleRate
        val sinOmegaLp = Math.sin(omegaLp)
        val cosOmegaLp = Math.cos(omegaLp)
        val alphaLp = sinOmegaLp / (2.0 * 0.707)
        
        val a0Lp = 1.0 + alphaLp
        lowpassCoeffs[0] = ((1.0 - cosOmegaLp) / 2.0) / a0Lp
        lowpassCoeffs[1] = (1.0 - cosOmegaLp) / a0Lp
        lowpassCoeffs[2] = ((1.0 - cosOmegaLp) / 2.0) / a0Lp
        lowpassCoeffs[3] = (-2.0 * cosOmegaLp) / a0Lp
        lowpassCoeffs[4] = (1.0 - alphaLp) / a0Lp
    }
    
    private fun calculateCompressorCoeffs() {
        attackCoeff = Math.exp(-1.0 / (COMPRESSOR_ATTACK_MS * sampleRate / 1000.0))
        releaseCoeff = Math.exp(-1.0 / (COMPRESSOR_RELEASE_MS * sampleRate / 1000.0))
    }
    
    fun attachToAudioRecord(audioRecord: AudioRecord) {
        try {
            if (AutomaticGainControl.isAvailable()) {
                agc = AutomaticGainControl.create(audioRecord.audioSessionId)
                agc?.enabled = true
                Log.d(TAG, "AGC enabled")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to enable AGC: ${e.message}")
        }
        
        try {
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = NoiseSuppressor.create(audioRecord.audioSessionId)
                noiseSuppressor?.enabled = true
                Log.d(TAG, "Noise suppressor enabled")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to enable noise suppressor: ${e.message}")
        }
    }
    
    fun process(samples: ShortArray): ShortArray {
        val output = ShortArray(samples.size)
        
        for (i in samples.indices) {
            var sample = samples[i].toDouble() / 32768.0
            
            sample = applyBiquadHighpass(sample)
            sample = applyBiquadLowpass(sample)
            
            sample = applyCompressor(sample)
            
            sample = applySaturation(sample)
            
            sample *= OUTPUT_GAIN
            
            sample = max(-1.0, min(1.0, sample))
            
            output[i] = (sample * 32767.0).toInt().toShort()
        }
        
        return output
    }
    
    private fun applyBiquadHighpass(input: Double): Double {
        val output = highpassCoeffs[0] * input + 
                     highpassCoeffs[1] * highpassInputState[0] + 
                     highpassCoeffs[2] * highpassInputState[1] - 
                     highpassCoeffs[3] * highpassOutputState[0] - 
                     highpassCoeffs[4] * highpassOutputState[1]
        
        highpassInputState[1] = highpassInputState[0]
        highpassInputState[0] = input
        highpassOutputState[1] = highpassOutputState[0]
        highpassOutputState[0] = output
        
        return output
    }
    
    private fun applyBiquadLowpass(input: Double): Double {
        val output = lowpassCoeffs[0] * input + 
                     lowpassCoeffs[1] * lowpassInputState[0] + 
                     lowpassCoeffs[2] * lowpassInputState[1] - 
                     lowpassCoeffs[3] * lowpassOutputState[0] - 
                     lowpassCoeffs[4] * lowpassOutputState[1]
        
        lowpassInputState[1] = lowpassInputState[0]
        lowpassInputState[0] = input
        lowpassOutputState[1] = lowpassOutputState[0]
        lowpassOutputState[0] = output
        
        return output
    }
    
    private fun applyCompressor(input: Double): Double {
        val inputLevel = abs(input)
        val inputDb = if (inputLevel > 0.0001) 20.0 * Math.log10(inputLevel) else -80.0
        
        val coeff = if (inputLevel > compressorEnvelope) attackCoeff else releaseCoeff
        compressorEnvelope = coeff * compressorEnvelope + (1.0 - coeff) * inputLevel
        
        if (inputDb > COMPRESSOR_THRESHOLD) {
            val gainReduction = (inputDb - COMPRESSOR_THRESHOLD) * (1.0 - 1.0 / COMPRESSOR_RATIO)
            val gainLinear = 10.0.pow(-gainReduction / 20.0)
            return input * gainLinear
        }
        
        return input
    }
    
    private fun applySaturation(input: Double): Double {
        val deg = Math.PI / 180.0
        return ((3.0 + SATURATION_AMOUNT) * input * 20.0 * deg) / 
               (Math.PI + SATURATION_AMOUNT * abs(input))
    }
    
    fun reset() {
        highpassInputState.fill(0.0)
        highpassOutputState.fill(0.0)
        lowpassInputState.fill(0.0)
        lowpassOutputState.fill(0.0)
        compressorEnvelope = 0.0
        Log.d(TAG, "DSP state reset")
    }
    
    fun release() {
        try {
            agc?.release()
            agc = null
        } catch (e: Exception) {
            Log.w(TAG, "Error releasing AGC: ${e.message}")
        }
        
        try {
            noiseSuppressor?.release()
            noiseSuppressor = null
        } catch (e: Exception) {
            Log.w(TAG, "Error releasing noise suppressor: ${e.message}")
        }
        
        reset()
        Log.d(TAG, "RadioVoiceDSP released")
    }
}
