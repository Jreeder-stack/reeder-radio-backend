package com.reedersystems.commandcomms.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import android.util.Log
import com.reedersystems.commandcomms.R
import kotlinx.coroutines.*
import kotlin.math.PI
import kotlin.math.sin

private const val TAG = "[ToneEngine]"
private const val SAMPLE_RATE = 44100

class ToneEngine(private val context: Context) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var busyJob: Job? = null
    private var busyTrack: AudioTrack? = null

    fun playTalkPermitTone() {
        scope.launch {
            try {
                val mp = MediaPlayer.create(context, R.raw.talk_permit)
                if (mp != null) {
                    mp.setOnCompletionListener { it.release() }
                    mp.start()
                    return@launch
                }
            } catch (e: Exception) {
                Log.w(TAG, "WAV playback failed, using oscillator fallback: ${e.message}")
            }
            playBeeps(800f, count = 3, durationMs = 40, gapMs = 30, volume = 0.5f)
        }
    }

    fun playEndOfTxTone() {
        scope.launch {
            playBeeps(800f, count = 1, durationMs = 150, gapMs = 0, volume = 0.35f)
        }
    }

    fun playErrorTone() {
        scope.launch {
            playBeeps(800f, count = 1, durationMs = 100, gapMs = 50, volume = 0.4f)
            playBeeps(600f, count = 1, durationMs = 100, gapMs = 50, volume = 0.4f)
            playBeeps(400f, count = 1, durationMs = 100, gapMs = 0, volume = 0.4f)
        }
    }

    fun playBusyTone() {
        stopBusyTone()
        busyJob = scope.launch {
            repeat(3) {
                playBeeps(480f, count = 1, durationMs = 200, gapMs = 0, volume = 0.45f)
                delay(200L)
            }
            busyJob = null
        }
    }

    fun startBusyTone() {
        stopBusyTone()
        busyJob = scope.launch {
            val minBuf = AudioTrack.getMinBufferSize(
                SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val track = AudioTrack.Builder()
                .setAudioAttributes(audioAttribs())
                .setAudioFormat(audioFormat())
                .setBufferSizeInBytes(minBuf)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            busyTrack = track
            track.play()
            val buf = ShortArray(minBuf / 2)
            val freq = 480.0
            var phase = 0.0
            val inc = 2.0 * PI * freq / SAMPLE_RATE
            while (isActive && track.playState == AudioTrack.PLAYSTATE_PLAYING) {
                for (i in buf.indices) {
                    buf[i] = (sin(phase) * 0.3 * Short.MAX_VALUE).toInt().toShort()
                    phase += inc
                    if (phase > 2.0 * PI) phase -= 2.0 * PI
                }
                if (!isActive) break
                track.write(buf, 0, buf.size)
            }
        }
    }

    fun stopBusyTone() {
        busyJob?.cancel()
        busyJob = null
        try { busyTrack?.stop() } catch (_: Exception) {}
        try { busyTrack?.release() } catch (_: Exception) {}
        busyTrack = null
    }

    private var countdownBeepJob: Job? = null

    fun startCountdownBeep() {
        if (countdownBeepJob?.isActive == true) return
        countdownBeepJob = scope.launch {
            while (isActive) {
                playBeeps(880f, count = 1, durationMs = 80, gapMs = 0, volume = 0.6f)
                delay(400L)
            }
        }
    }

    fun stopCountdownBeep() {
        countdownBeepJob?.cancel()
        countdownBeepJob = null
    }

    private suspend fun playBeeps(
        freqHz: Float,
        count: Int,
        durationMs: Int,
        gapMs: Int,
        volume: Float
    ) = withContext(Dispatchers.IO) {
        val samples = SAMPLE_RATE * durationMs / 1000
        val buf = ShortArray(samples)
        val inc = 2.0 * PI * freqHz / SAMPLE_RATE
        var phase = 0.0
        for (i in buf.indices) {
            val env = when {
                i < samples * 0.05 -> i / (samples * 0.05)
                i > samples * 0.85 -> (samples - i) / (samples * 0.15)
                else -> 1.0
            }
            buf[i] = (sin(phase) * volume * env * Short.MAX_VALUE).toInt().toShort()
            phase += inc
            if (phase > 2.0 * PI) phase -= 2.0 * PI
        }
        val minBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        repeat(count) { idx ->
            runCatching {
                val track = AudioTrack.Builder()
                    .setAudioAttributes(audioAttribs())
                    .setAudioFormat(audioFormat())
                    .setBufferSizeInBytes(maxOf(minBuf, samples * 2))
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                track.write(buf, 0, buf.size)
                track.play()
                delay(durationMs.toLong() + 20)
                track.stop()
                track.release()
                if (idx < count - 1 && gapMs > 0) delay(gapMs.toLong())
            }.onFailure { Log.w(TAG, "Beep error: ${it.message}") }
        }
    }

    private fun audioAttribs() = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private fun audioFormat() = AudioFormat.Builder()
        .setSampleRate(SAMPLE_RATE)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build()

    fun release() {
        stopBusyTone()
        stopCountdownBeep()
        scope.cancel()
    }
}
