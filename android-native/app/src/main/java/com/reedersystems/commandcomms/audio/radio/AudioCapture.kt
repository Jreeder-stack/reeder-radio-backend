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
        if (audioSource == null) {
            Log.e("[RadioError]", "CAPTURE_START_ABORTED reason=all_audio_sources_rejected")
            return
        }

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

    private data class SourceProbeResult(
        val source: Int,
        val sourceName: String,
        val avgRms: Double,
        val accepted: Boolean,
        val reason: String
    )

    private fun probeAudioSource(source: Int, sourceName: String): SourceProbeResult {
        val rate = sampleRate
        val probeFrameCount = 5
        val silenceThreshold = 2.0
        try {
            val testMinBuf = AudioRecord.getMinBufferSize(
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            if (testMinBuf <= 0) {
                val reason = "init_failed_bad_buffer_size"
                Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason minBuf=$testMinBuf")
                return SourceProbeResult(source, sourceName, 0.0, false, reason)
            }
            val testRecord = AudioRecord(
                source,
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                testMinBuf
            )
            try {
                if (testRecord.state != AudioRecord.STATE_INITIALIZED) {
                    val reason = "init_failed_not_initialized"
                    Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason")
                    return SourceProbeResult(source, sourceName, 0.0, false, reason)
                }

                try {
                    testRecord.startRecording()
                } catch (e: Exception) {
                    val reason = "start_recording_failed"
                    Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason err=${e.message}")
                    return SourceProbeResult(source, sourceName, 0.0, false, reason)
                }

                val frameSizeSamples = (rate * 20) / 1000
                val frameSizeBytes = frameSizeSamples * 2
                val readBuf = ByteArray(frameSizeBytes)
                var totalRms = 0.0
                var globalMin = Short.MAX_VALUE.toInt()
                var globalMax = Short.MIN_VALUE.toInt()
                var validFrames = 0

                for (i in 0 until probeFrameCount) {
                    val bytesRead = testRecord.read(readBuf, 0, frameSizeBytes)
                    if (bytesRead > 0) {
                        val stats = RadioDiagLog.pcmStats(readBuf, bytesRead)
                        totalRms += stats.rms
                        if (stats.min < globalMin) globalMin = stats.min
                        if (stats.max > globalMax) globalMax = stats.max
                        validFrames++
                        Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeFrame=$i $stats")
                    } else {
                        Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeFrame=$i readRet=$bytesRead")
                    }
                }

                if (validFrames == 0) {
                    val reason = "read_failed_no_valid_frames"
                    Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason")
                    return SourceProbeResult(source, sourceName, 0.0, false, reason)
                }

                val avgRms = totalRms / validFrames
                val accepted = avgRms >= silenceThreshold
                val reason = if (accepted) "rms_above_threshold" else "rms_too_low"
                Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=${if (accepted) "OK" else "REJECT"} avgRms=${String.format("%.1f", avgRms)} min=$globalMin max=$globalMax validFrames=$validFrames reason=$reason threshold=$silenceThreshold")
                return SourceProbeResult(source, sourceName, avgRms, accepted, reason)

            } finally {
                try { testRecord.stop() } catch (_: Exception) {}
                try { testRecord.release() } catch (_: Exception) {}
            }

        } catch (e: Exception) {
            val reason = "exception"
            Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE source=$sourceName probeRate=$rate result=REJECT reason=$reason err=${e.message}")
            return SourceProbeResult(source, sourceName, 0.0, false, reason)
        }
    }

    private fun selectAudioSource(): Int? {
        data class Candidate(val source: Int, val name: String)
        val candidates = mutableListOf(
            Candidate(MediaRecorder.AudioSource.MIC, "MIC"),
            Candidate(MediaRecorder.AudioSource.VOICE_RECOGNITION, "VOICE_RECOGNITION"),
            Candidate(MediaRecorder.AudioSource.VOICE_COMMUNICATION, "VOICE_COMMUNICATION")
        )
        if (Build.VERSION.SDK_INT >= 24) {
            candidates.add(Candidate(MediaRecorder.AudioSource.UNPROCESSED, "UNPROCESSED"))
        }

        Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_PROBE_BEGIN candidates=${candidates.map { it.name }}")

        val allResults = candidates.map { c -> probeAudioSource(c.source, c.name) }
        val validResults = allResults.filter { it.accepted }
        val best = validResults.maxByOrNull { it.avgRms }

        if (best != null) {
            Log.d(DIAG_TAG, "CAPTURE_AUDIO_SOURCE selected=${best.sourceName} avgRms=${String.format("%.1f", best.avgRms)} reason=best_valid_source")
            return best.source
        }

        val readableResults = allResults.filter { it.reason == "rms_too_low" }
        val fallback = readableResults.maxByOrNull { it.avgRms }
        if (fallback != null) {
            Log.w(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_FALLBACK source=${fallback.sourceName} avgRms=${String.format("%.1f", fallback.avgRms)} reason=below_threshold_fallback")
            return fallback.source
        }

        Log.e(DIAG_TAG, "CAPTURE_AUDIO_SOURCE_ALL_REJECTED — no valid source above silence threshold")
        return null
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
