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
private const val DIAG_TAG = "[AudioCapture]"

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

    private val readRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)
    private var summaryTotalFrames: Long = 0
    private var summaryPartials: Long = 0
    private var summaryZeros: Long = 0
    private var summarySilentFrames: Long = 0

    fun start() {
        if (isRecording) {
            Log.w(DIAG_TAG, "[RadioError] start() called while already recording — ignoring ${RadioDiagLog.elapsedTag()}")
            return
        }

        val channelConfig = AudioFormat.CHANNEL_IN_MONO
        val audioFormat = AudioFormat.ENCODING_PCM_16BIT
        val minBufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat)
        val bufferSize = maxOf(minBufferSize, frameSizeSamples * 2 * 4)

        Log.d(DIAG_TAG, "CAPTURE_INIT requestedRate=$sampleRate requestedFrameSize=$frameSizeSamples minBufSize=$minBufferSize allocBufSize=$bufferSize ${RadioDiagLog.elapsedTag()}")

        val audioSource = selectAudioSource()

        val record = try {
            AudioRecord(
                audioSource,
                sampleRate,
                channelConfig,
                audioFormat,
                bufferSize
            )
        } catch (e: Exception) {
            Log.e("[RadioError]", "AudioRecord constructor threw: ${e::class.simpleName}: ${e.message} source=$audioSource rate=$sampleRate bufSize=$bufferSize", e)
            return
        }

        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e("[RadioError]", "AudioRecord failed to initialize source=$audioSource rate=$sampleRate bufSize=$bufferSize recordState=${record.state}")
            record.release()
            return
        }

        actualSampleRate = record.sampleRate
        actualChannelCount = record.channelCount
        actualFrameSizeSamples = (actualSampleRate * 20) / 1000
        val needsStereoDownmix = actualChannelCount == 2

        Log.d(DIAG_TAG, "CAPTURE_HAL_NEGOTIATED requestedRate=$sampleRate actualRate=$actualSampleRate actualChannels=$actualChannelCount actualFormat=${record.audioFormat} needsStereoDownmix=$needsStereoDownmix bufferSize=$bufferSize ${RadioDiagLog.elapsedTag()}")

        if (actualSampleRate != sampleRate) {
            Log.w(DIAG_TAG, "CAPTURE_SAMPLE_RATE_MISMATCH requested=$sampleRate actual=$actualSampleRate — adapting capture pipeline")
        }

        val readSamplesPerFrame = actualFrameSizeSamples * actualChannelCount

        audioRecord = record
        isRecording = true
        readRateLimiter.reset()
        summaryTotalFrames = 0; summaryPartials = 0; summaryZeros = 0; summarySilentFrames = 0
        record.startRecording()

        Log.d(DIAG_TAG, "CAPTURE_POST_START recordingState=${record.recordingState} sessionId=${record.audioSessionId} ${RadioDiagLog.elapsedTag()}")

        captureThread = Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            val buffer = ShortArray(readSamplesPerFrame)
            while (isRecording) {
                try {
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

                        readRateLimiter.tick()
                        summaryTotalFrames++
                        val stats = RadioDiagLog.pcmStatsShort(monoFrame, monoFrame.size)
                        if (stats.silent) summarySilentFrames++

                        if (readRateLimiter.shouldLogDetail()) {
                            Log.d(DIAG_TAG, "CAPTURE_FRAME frame=${readRateLimiter.frameCount} read=$read $stats downmix=$needsStereoDownmix ${RadioDiagLog.elapsedTag()}")
                        } else if (readRateLimiter.shouldLogSummary()) {
                            val cnt = readRateLimiter.resetSummaryAccumulator()
                            Log.d(DIAG_TAG, "CAPTURE_SUMMARY frames=$cnt totalFrames=$summaryTotalFrames partials=$summaryPartials zeros=$summaryZeros silentFrames=$summarySilentFrames ${RadioDiagLog.elapsedTag()}")
                        }

                        onFrame(monoFrame)
                    } else if (read < 0) {
                        Log.e("[RadioError]", "AudioRecord read error: $read method=captureLoop ${RadioDiagLog.elapsedTag()}")
                        break
                    } else {
                        summaryPartials++
                        if (read == 0) summaryZeros++
                        if (readRateLimiter.shouldLogDetail()) {
                            Log.w(DIAG_TAG, "CAPTURE_PARTIAL_READ read=$read expected=$readSamplesPerFrame ${RadioDiagLog.elapsedTag()}")
                        }
                    }
                } catch (e: Exception) {
                    Log.e("[RadioError]", "CAPTURE_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=captureLoop", e)
                }
            }
        }, "RadioAudioCapture").also { it.start() }

        Log.d(DIAG_TAG, "AudioCapture started: ${actualSampleRate}Hz ch=$actualChannelCount, monoFrame=$actualFrameSizeSamples samples ${RadioDiagLog.elapsedTag()}")
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
                if (testMinBuf <= 0) {
                    Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=INVALID_BUF_SIZE($testMinBuf)")
                    continue
                }
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
                    Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=OK")
                    return true
                } else {
                    Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=INIT_FAILED")
                }
            } catch (e: Exception) {
                Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=EXCEPTION(${e.message})")
            }
        }
        return false
    }

    private fun selectAudioSource(): Int {
        if (Build.VERSION.SDK_INT >= 24) {
            if (probeAudioSource(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED")) {
                Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE selected=UNPROCESSED (API ${Build.VERSION.SDK_INT})")
                return MediaRecorder.AudioSource.UNPROCESSED
            }
        }

        if (probeAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION")) {
            Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE selected=VOICE_RECOGNITION")
            return MediaRecorder.AudioSource.VOICE_RECOGNITION
        }

        Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE selected=MIC (fallback)")
        return MediaRecorder.AudioSource.MIC
    }

    fun stop() {
        isRecording = false
        try {
            audioRecord?.stop()
        } catch (e: Exception) {
            Log.e("[RadioError]", "AudioRecord stop threw: ${e::class.simpleName}: ${e.message}", e)
        }
        captureThread?.join(1000)
        captureThread = null
        try {
            audioRecord?.release()
        } catch (e: Exception) {
            Log.e("[RadioError]", "AudioRecord release threw: ${e::class.simpleName}: ${e.message}", e)
        }
        audioRecord = null
        Log.d(DIAG_TAG, "AudioCapture stopped totalFrames=$summaryTotalFrames partials=$summaryPartials zeros=$summaryZeros silentFrames=$summarySilentFrames ${RadioDiagLog.elapsedTag()}")
    }
}
