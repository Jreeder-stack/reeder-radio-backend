/**
 * AudioCapture — Captures microphone PCM using Android AudioRecord.
 *
 * Module boundary: This module handles raw audio input only. It does NOT detect PTT
 * button presses — it is started/stopped by the RadioAudioEngine when PTT state changes.
 * Captured PCM frames are delivered to an encoder callback for further processing.
 *
 * Configuration: Voice communication audio source, 48 kHz mono, 16-bit PCM.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log

private const val TAG = "[RadioCapture]"

class AudioCapture(
    private val sampleRate: Int = OpusCodec.SAMPLE_RATE,
    private val frameSizeSamples: Int = OpusCodec.FRAME_SIZE,
    private val onFrame: (ShortArray) -> Unit
) {
    private var audioRecord: AudioRecord? = null
    @Volatile
    private var isRecording = false
    private var captureThread: Thread? = null

    fun start() {
        if (isRecording) return

        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val bufferSize = maxOf(minBufferSize, frameSizeSamples * 2 * 4)

        val record = AudioRecord(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
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

        audioRecord = record
        isRecording = true
        record.startRecording()

        captureThread = Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            val buffer = ShortArray(frameSizeSamples)
            while (isRecording) {
                val read = record.read(buffer, 0, frameSizeSamples)
                if (read == frameSizeSamples) {
                    onFrame(buffer.copyOf())
                } else if (read < 0) {
                    Log.e(TAG, "AudioRecord read error: $read")
                    break
                }
            }
        }, "RadioAudioCapture").also { it.start() }

        Log.d(TAG, "AudioCapture started: ${sampleRate}Hz mono, frame=$frameSizeSamples samples")
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
