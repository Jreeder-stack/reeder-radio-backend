/**
 * AudioCapture — Captures microphone PCM using Android AudioRecord.
 *
 * Module boundary: This module handles raw audio input only. It does NOT detect PTT
 * button presses — it is started/stopped by the RadioAudioEngine when PTT state changes.
 * Captured PCM frames are delivered to an encoder callback for further processing.
 *
 * Configuration: Attempts UNPROCESSED or VOICE_RECOGNITION audio source to bypass
 * vendor speech enhancement, falling back to MIC. Detects the HAL-negotiated sample
 * rate and channel count rather than trusting the requested values.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log

private const val TAG = "[RadioCapture]"

class AudioCapture(
    private val sampleRate: Int = OpusCodec.DEFAULT_SAMPLE_RATE,
    private val frameSizeSamples: Int = OpusCodec.FRAME_SIZE,
    private val onFrame: (ShortArray) -> Unit
) {
    private var audioRecord: AudioRecord? = null
    @Volatile
    private var isRecording = false
    private var captureThread: Thread? = null

    var actualSampleRate: Int = sampleRate
        private set
    var actualChannelCount: Int = 1
        private set
    var actualFrameSizeSamples: Int = frameSizeSamples
        private set

    fun start() {
        if (isRecording) return

        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val bufferSize = maxOf(minBufferSize, frameSizeSamples * 2 * 4)

        val audioSource = selectAudioSource()

        val record = AudioRecord(
            audioSource,
            sampleRate,
            channelConfig,
            audioFormat,
            bufferSize
        )

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize")
            record.release()
            return
        }

        actualSampleRate = record.sampleRate
        actualChannelCount = record.channelCount
        actualFrameSizeSamples = (actualSampleRate * 20) / 1000
        val needsStereoDownmix = actualChannelCount == 2

        Log.d(TAG, "CAPTURE_HAL_NEGOTIATED actualSampleRate=$actualSampleRate actualChannelCount=$actualChannelCount requestedSampleRate=$sampleRate needsStereoDownmix=$needsStereoDownmix bufferSize=$bufferSize")

        if (actualSampleRate != sampleRate) {
            Log.w(TAG, "CAPTURE_SAMPLE_RATE_MISMATCH requested=$sampleRate actual=$actualSampleRate — adapting capture pipeline")
        }

        val readSamplesPerFrame = actualFrameSizeSamples * actualChannelCount

        audioRecord = record
        isRecording = true
        record.startRecording()

        captureThread = Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            val buffer = ShortArray(readSamplesPerFrame)
            while (isRecording) {
                val read = record.read(buffer, 0, readSamplesPerFrame)
                if (read == readSamplesPerFrame) {
                    val monoFrame: ShortArray
                    if (needsStereoDownmix) {
                        monoFrame = ShortArray(actualFrameSizeSamples)
                        for (i in 0 until actualFrameSizeSamples) {
                            val left = buffer[i * 2].toInt()
                            val right = buffer[i * 2 + 1].toInt()
                            monoFrame[i] = ((left + right) / 2).coerceIn(-32768, 32767).toShort()
                        }
                    } else {
                        monoFrame = buffer.copyOf()
                    }
                    onFrame(monoFrame)
                } else if (read < 0) {
                    Log.e(TAG, "AudioRecord read error: $read")
                    break
                }
            }
        }, "RadioAudioCapture").also { it.start() }

        Log.d(TAG, "AudioCapture started: ${actualSampleRate}Hz ch=$actualChannelCount, monoFrame=$actualFrameSizeSamples samples")
    }

    private fun probeAudioSource(source: Int, sourceName: String): Boolean {
        val probeRates = intArrayOf(sampleRate, 16000, 8000)
        for (rate in probeRates) {
            try {
                val testMinBuf = AudioRecord.getMinBufferSize(
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT
                )
                if (testMinBuf <= 0) continue
                val testRecord = AudioRecord(
                    source,
                    rate,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    testMinBuf
                )
                val ok = testRecord.state == AudioRecord.STATE_INITIALIZED
                testRecord.release()
                if (ok) {
                    Log.d(TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=OK")
                    return true
                }
            } catch (_: Exception) {}
        }
        return false
    }

    private fun selectAudioSource(): Int {
        if (Build.VERSION.SDK_INT >= 24) {
            if (probeAudioSource(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED")) {
                Log.d(TAG, "CAPTURE_AUDIO_SOURCE selected=UNPROCESSED")
                return MediaRecorder.AudioSource.UNPROCESSED
            }
        }

        if (probeAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION")) {
            Log.d(TAG, "CAPTURE_AUDIO_SOURCE selected=VOICE_RECOGNITION")
            return MediaRecorder.AudioSource.VOICE_RECOGNITION
        }

        Log.d(TAG, "CAPTURE_AUDIO_SOURCE selected=MIC (fallback)")
        return MediaRecorder.AudioSource.MIC
    }

    fun stop() {
        isRecording = false
        audioRecord?.stop()
        captureThread?.join(1000)
        captureThread = null
        audioRecord?.release()
        audioRecord = null
        Log.d(TAG, "AudioCapture stopped")
    }
}
