package com.reedersystems.commandcomms.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
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
    private var beepTrack: AudioTrack? = null
    private val beepTrackLock = Any()
    private var deniedPlayer: MediaPlayer? = null
    private val deniedLock = Any()
    private var endOfTxJob: Job? = null
    private var talkPermitJob: Job? = null
    private var talkPermitPlayer: MediaPlayer? = null
    private val talkPermitLock = Any()
    private var bonkPlayer: MediaPlayer? = null
    private val bonkLock = Any()

    init {
        initBeepTrack()
    }

    private fun initBeepTrack() {
        synchronized(beepTrackLock) {
            if (beepTrack != null) return
            try {
                val minBuf = AudioTrack.getMinBufferSize(
                    SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
                )
                val track = AudioTrack.Builder()
                    .setAudioAttributes(audioAttribs())
                    .setAudioFormat(audioFormat())
                    .setBufferSizeInBytes(maxOf(minBuf, SAMPLE_RATE * 2))
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build()
                beepTrack = track
                Log.d(TAG, "Beep AudioTrack pre-initialized")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to pre-initialize beep AudioTrack: ${e.message}")
            }
        }
    }

    fun playTalkPermitTone() {
        talkPermitJob?.cancel()
        talkPermitJob = scope.launch(Dispatchers.Main.immediate) {
            playTalkPermitToneAndAwait()
        }
    }

    fun stopTalkPermitTone() {
        talkPermitJob?.cancel()
        talkPermitJob = null
        synchronized(talkPermitLock) {
            talkPermitPlayer?.let { mp ->
                runCatching { mp.stop() }
                runCatching { mp.release() }
            }
            talkPermitPlayer = null
        }
    }

    suspend fun playTalkPermitToneAndAwait() {
        var mp: MediaPlayer? = null
        try {
            val deferred = CompletableDeferred<Unit>()
            mp = MediaPlayer.create(
                context,
                R.raw.talk_permit,
                audioAttribs(),
                AudioManager.AUDIO_SESSION_ID_GENERATE
            )
            if (mp == null) {
                Log.w(TAG, "MediaPlayer.create returned null, retrying once")
                delay(50)
                mp = MediaPlayer.create(
                    context,
                    R.raw.talk_permit,
                    audioAttribs(),
                    AudioManager.AUDIO_SESSION_ID_GENERATE
                )
            }
            if (mp != null) {
                synchronized(talkPermitLock) { talkPermitPlayer = mp }
                mp.setOnCompletionListener {
                    synchronized(talkPermitLock) { talkPermitPlayer = null }
                    it.release()
                    deferred.complete(Unit)
                }
                mp.start()
                try {
                    deferred.await()
                } catch (e: CancellationException) {
                    synchronized(talkPermitLock) { talkPermitPlayer = null }
                    runCatching { mp.stop() }
                    runCatching { mp.release() }
                    throw e
                }
                return
            }
            Log.w(TAG, "MediaPlayer.create returned null after retry, using oscillator fallback")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            runCatching { mp?.release() }
            Log.w(TAG, "WAV playback failed, using oscillator fallback: ${e.message}")
        }
        playBeeps(800f, count = 3, durationMs = 40, gapMs = 30, volume = 0.5f)
    }

    fun playEndOfTxTone() {
        if (endOfTxJob?.isActive == true) return
        endOfTxJob = scope.launch {
            playEndOfTxBeep()
            endOfTxJob = null
        }
    }

    private suspend fun playEndOfTxBeep() = withContext(Dispatchers.IO) {
        val rate = 16000
        val durationMs = 150
        val freqHz = 800.0
        val volume = 0.5
        val sampleCount = rate * durationMs / 1000
        val buf = ShortArray(sampleCount)
        val inc = 2.0 * PI * freqHz / rate
        var phase = 0.0
        for (i in buf.indices) {
            val env = when {
                i < sampleCount * 0.05 -> i / (sampleCount * 0.05)
                i > sampleCount * 0.85 -> (sampleCount - i) / (sampleCount * 0.15)
                else -> 1.0
            }
            buf[i] = (sin(phase) * volume * env * Short.MAX_VALUE).toInt().toShort()
            phase += inc
            if (phase > 2.0 * PI) phase -= 2.0 * PI
        }
        var track: AudioTrack? = null
        try {
            val minBuf = AudioTrack.getMinBufferSize(
                rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            track = AudioTrack.Builder()
                .setAudioAttributes(audioAttribs())
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(rate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build()
                )
                .setBufferSizeInBytes(maxOf(minBuf, sampleCount * 2))
                .setTransferMode(AudioTrack.MODE_STATIC)
                .build()
            track.write(buf, 0, buf.size)
            track.play()
            delay(durationMs.toLong() + 50)
        } catch (e: Exception) {
            Log.w(TAG, "End-of-TX beep error: ${e.message}")
        } finally {
            runCatching { track?.stop() }
            runCatching { track?.release() }
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

    fun startDeniedTone() {
        stopTalkPermitTone()
        stopDeniedTone()
        synchronized(deniedLock) {
            try {
                val mp = MediaPlayer.create(
                    context,
                    R.raw.apx_denied,
                    audioAttribs(),
                    AudioManager.AUDIO_SESSION_ID_GENERATE
                )
                if (mp != null) {
                    mp.isLooping = true
                    mp.start()
                    deniedPlayer = mp
                    Log.d(TAG, "Denied tone started (looping)")
                } else {
                    Log.w(TAG, "Failed to create denied tone MediaPlayer")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to start denied tone: ${e.message}")
            }
        }
    }

    fun stopDeniedTone() {
        synchronized(deniedLock) {
            deniedPlayer?.let { mp ->
                runCatching { mp.stop() }
                runCatching { mp.release() }
                Log.d(TAG, "Denied tone stopped")
            }
            deniedPlayer = null
        }
    }

    fun playDeniedBonk() {
        synchronized(bonkLock) {
            bonkPlayer?.let { mp ->
                runCatching { mp.stop() }
                runCatching { mp.release() }
            }
            bonkPlayer = null
            try {
                val mp = MediaPlayer.create(
                    context,
                    R.raw.apx_denied,
                    audioAttribs(),
                    AudioManager.AUDIO_SESSION_ID_GENERATE
                )
                if (mp != null) {
                    try {
                        mp.isLooping = false
                        mp.setOnCompletionListener { player ->
                            runCatching { player.release() }
                            synchronized(bonkLock) {
                                if (bonkPlayer === player) bonkPlayer = null
                            }
                        }
                        mp.start()
                        bonkPlayer = mp
                        Log.d(TAG, "Denied bonk played (one-shot)")
                    } catch (e: Exception) {
                        runCatching { mp.release() }
                        Log.w(TAG, "Failed to start denied bonk: ${e.message}")
                    }
                } else {
                    Log.w(TAG, "Failed to create denied bonk MediaPlayer")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to play denied bonk: ${e.message}")
            }
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

        repeat(count) { idx ->
            runCatching {
                val track = synchronized(beepTrackLock) { beepTrack }
                if (track != null) {
                    try {
                        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) {
                            track.play()
                        }
                        track.write(buf, 0, buf.size)
                        delay(durationMs.toLong() + 20)
                    } catch (e: Exception) {
                        Log.w(TAG, "Reusable beep track error, recreating: ${e.message}")
                        synchronized(beepTrackLock) {
                            runCatching { beepTrack?.stop() }
                            runCatching { beepTrack?.release() }
                            beepTrack = null
                        }
                        initBeepTrack()
                        playBeepFallback(buf, durationMs)
                    }
                } else {
                    playBeepFallback(buf, durationMs)
                }
                if (idx < count - 1 && gapMs > 0) delay(gapMs.toLong())
            }.onFailure { Log.w(TAG, "Beep error: ${it.message}") }
        }
    }

    private suspend fun playBeepFallback(buf: ShortArray, durationMs: Int) {
        val minBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
        )
        val track = AudioTrack.Builder()
            .setAudioAttributes(audioAttribs())
            .setAudioFormat(audioFormat())
            .setBufferSizeInBytes(maxOf(minBuf, buf.size * 2))
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        track.write(buf, 0, buf.size)
        track.play()
        delay(durationMs.toLong() + 20)
        track.stop()
        track.release()
    }

    private fun audioAttribs() = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private fun audioFormat() = AudioFormat.Builder()
        .setSampleRate(SAMPLE_RATE)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build()

    fun release() {
        stopBusyTone()
        stopDeniedTone()
        stopTalkPermitTone()
        stopCountdownBeep()
        synchronized(bonkLock) {
            bonkPlayer?.let { mp ->
                runCatching { mp.stop() }
                runCatching { mp.release() }
            }
            bonkPlayer = null
        }
        synchronized(beepTrackLock) {
            try { beepTrack?.stop() } catch (_: Exception) {}
            try { beepTrack?.release() } catch (_: Exception) {}
            beepTrack = null
        }
        scope.cancel()
    }
}
