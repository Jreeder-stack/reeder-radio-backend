package com.reedersystems.commandcomms.messaging

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.audiofx.LoudnessEnhancer
import android.util.Log
import kotlin.math.sin
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.R
import com.reedersystems.commandcomms.data.prefs.SpeakerBoostPrefs
import com.reedersystems.commandcomms.ui.paging.PageAlertActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

private const val TAG = "[FCM-Service]"

class CommandCommsFirebaseService : FirebaseMessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d(TAG, "New FCM token received, persisting to SharedPreferences")
        val app = applicationContext as CommandCommsApp
        app.apiClient.saveFcmToken(token)
        if (app.apiClient.radioToken != null) {
            Log.d(TAG, "Radio token already present — registering FCM token with backend immediately")
            registerTokenWithBackend(token)
        } else {
            Log.d(TAG, "No radio token yet — FCM token saved, will re-register after authentication")
        }
    }

    private fun registerTokenWithBackend(token: String) {
        scope.launch {
            try {
                val app = applicationContext as CommandCommsApp
                val body = JSONObject().apply { put("fcmToken", token) }
                    .toString()
                    .toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("${app.apiClient.baseUrl}/api/radios/fcm-token")
                    .post(body)
                    .build()
                app.apiClient.httpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        Log.d(TAG, "FCM token registered successfully")
                    } else {
                        Log.w(TAG, "FCM token registration failed: ${response.code}")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to register FCM token: ${e.message}")
            }
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        Log.d(TAG, "[BUILD-TONE-A-V2] FCM message received: ${remoteMessage.data}")

        val data = remoteMessage.data
        val type = data["type"] ?: return

        if (type == "page") {
            val pageId = data["pageId"] ?: return
            val message = data["message"] ?: ""
            val sender = data["sender"] ?: "DISPATCH"
            val pagingChannelId = data["pagingChannelId"]

            handlePage(pageId, message, sender, pagingChannelId)
        }
    }

    private fun handlePage(pageId: String, message: String, sender: String, pagingChannelId: String?) {
        val app = applicationContext as CommandCommsApp

        sendAcknowledgment(pageId, app)

        val alertIntent = Intent(this, PageAlertActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_PAGE_ID, pageId)
            putExtra(EXTRA_PAGE_MESSAGE, message)
            putExtra(EXTRA_PAGE_SENDER, sender)
            putExtra(EXTRA_PAGING_CHANNEL_ID, pagingChannelId ?: "")
        }

        val pageAlertPendingIntent = PendingIntent.getActivity(
            this, pageId.hashCode(), alertIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, PAGING_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("PAGE from $sender")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setColorized(true)
            .setColor(0xFFCC0000.toInt())
            .setAutoCancel(false)
            .setOngoing(true)
            .setSound(null)
            .setDefaults(0)
            .setVibrate(longArrayOf(0L))
            .setContentIntent(pageAlertPendingIntent)
            .setFullScreenIntent(pageAlertPendingIntent, true)
            .build()

        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(PAGE_NOTIFICATION_ID, notification)

        try {
            startActivity(alertIntent)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to start PageAlertActivity directly: ${e.message}")
        }

        if (app.apiClient.radioToken != null) {
            playPagingTone(app)
        } else {
            Log.w(TAG, "[BUILD-TONE-A-V2] Skipping tone: radioToken is null (radio not authenticated)")
        }

        sendBroadcast(Intent(ACTION_PAGE_RECEIVED).apply {
            putExtra(EXTRA_PAGE_ID, pageId)
            putExtra(EXTRA_PAGE_MESSAGE, message)
            putExtra(EXTRA_PAGE_SENDER, sender)
            putExtra(EXTRA_PAGING_CHANNEL_ID, pagingChannelId ?: "")
            setPackage(packageName)
        })
    }

    private fun sendAcknowledgment(pageId: String, app: CommandCommsApp) {
        scope.launch {
            try {
                val body = JSONObject()
                    .toString()
                    .toRequestBody("application/json".toMediaType())
                val request = Request.Builder()
                    .url("${app.apiClient.baseUrl}/api/dispatch/page/$pageId/ack")
                    .post(body)
                    .build()
                app.apiClient.httpClient.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        Log.d(TAG, "Page $pageId acknowledged successfully")
                    } else {
                        Log.w(TAG, "Page ACK failed: ${response.code}")
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to send page ACK: ${e.message}")
            }
        }
    }

    /**
     * Plays the dispatcher's pager tone on STREAM_ALARM. Primary path decodes the
     * bundled R.raw.pager_tone WAV via MediaPlayer so the handset and the dispatch
     * console play identical audio. If the bundled WAV cannot be opened/prepared,
     * we fall back to the synthesized 1 kHz sine via AudioTrack so paging is never
     * silent. In both paths the alarm volume is bumped to max and restored on
     * completion, and any prior paging playback is cancelled before a new one starts.
     */
    private fun playPagingTone(app: CommandCommsApp) {
        Log.d(TAG, "[PAGER-WAV] playPagingTone ENTER — attempting bundled pager_tone.wav via MediaPlayer")
        scope.launch(Dispatchers.IO) {
            val am = applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val prevVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
            var raisedVolume = false
            val maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            try {
                am.setStreamVolume(AudioManager.STREAM_ALARM, maxVolume, 0)
                raisedVolume = true
            } catch (e: SecurityException) {
                Log.w(TAG, "[PAGER-WAV] Cannot override alarm volume (DnD policy?): ${e.message}")
            }
            val restoreVolume = raisedVolume

            val player = MediaPlayer()
            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()

            val prepared = try {
                player.setAudioAttributes(attributes)
                applicationContext.resources.openRawResourceFd(R.raw.pager_tone).use { afd ->
                    player.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                }
                player.setVolume(1.0f, 1.0f)
                player.prepare()
                true
            } catch (e: Exception) {
                Log.w(TAG, "[PAGER-WAV] Failed to open/prepare bundled WAV — falling back to synth: ${e.message}", e)
                runCatching { player.release() }
                false
            }

            if (!prepared) {
                playSynthesizedFallback(am, prevVolume, restoreVolume)
                return@launch
            }

            val pagerBoostMb = SpeakerBoostPrefs(applicationContext).pagerBoostMb
            val playerLE: LoudnessEnhancer? = try {
                LoudnessEnhancer(player.audioSessionId).apply {
                    setTargetGain(pagerBoostMb)
                    enabled = true
                }.also {
                    Log.d(TAG, "[LOUDNESS] LoudnessEnhancer attached sessionId=${player.audioSessionId} gainMb=$pagerBoostMb (pager-wav)")
                }
            } catch (e: Exception) {
                Log.w(TAG, "[LOUDNESS-FALLBACK] pager LoudnessEnhancer attach failed sessionId=${player.audioSessionId}: ${e::class.simpleName}: ${e.message} — paging tone plays without effect")
                null
            }

            synchronized(playerLock) {
                cancelCurrentPagingPlaybackLocked()
                currentPagingPlayer = player
                currentPagingLoudnessEnhancer = playerLE
                pagingAudioManager = am
                previousAlarmVolume = prevVolume
            }

            player.setOnCompletionListener {
                Log.d(TAG, "[PAGER-WAV] WAV playback completed")
                finishPagingPlayer(player, am, prevVolume, restoreVolume)
            }
            player.setOnErrorListener { _, what, extra ->
                Log.w(TAG, "[PAGER-WAV] MediaPlayer error what=$what extra=$extra")
                finishPagingPlayer(player, am, prevVolume, restoreVolume)
                true
            }

            try {
                player.start()
                Log.d(TAG, "[PAGER-WAV] WAV playing: STREAM_ALARM max=$maxVolume (was $prevVolume) durationMs=${player.duration}")
            } catch (e: Exception) {
                Log.w(TAG, "[PAGER-WAV] MediaPlayer.start failed — falling back to synth: ${e.message}", e)
                finishPagingPlayer(player, am, prevVolume, restoreVolume = false)
                playSynthesizedFallback(am, prevVolume, restoreVolume)
            }
        }
    }

    /**
     * Synthesized 1 kHz sine fallback that runs only when the bundled WAV cannot be
     * loaded. Mirrors the previous AudioTrack path so paging is never silent.
     */
    private fun playSynthesizedFallback(am: AudioManager, prevVolume: Int, restoreVolume: Boolean) {
        Log.d(TAG, "[PAGER-SYNTH-FALLBACK] Playing synthesized 1000Hz sine fallback")
        var track: AudioTrack? = null
        try {
            val sampleRate = 48000
            val frequencyHz = 1000.0
            val durationMs = 2500
            val numSamples = sampleRate * durationMs / 1000
            val amplitude = (Short.MAX_VALUE * 0.5).toInt()
            val pcm = ShortArray(numSamples)
            for (i in 0 until numSamples) {
                pcm[i] = (amplitude * sin(2.0 * Math.PI * frequencyHz * i / sampleRate)).toInt().toShort()
            }

            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build()

            val minBuf = AudioTrack.getMinBufferSize(
                sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT
            )
            val streamBufBytes = maxOf(minBuf, 8192)

            val newTrack = AudioTrack.Builder()
                .setAudioAttributes(attributes)
                .setAudioFormat(format)
                .setBufferSizeInBytes(streamBufBytes)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
            track = newTrack
            runCatching { newTrack.setVolume(AudioTrack.getMaxVolume()) }

            val pagerBoostMb = SpeakerBoostPrefs(applicationContext).pagerBoostMb
            val trackLE: LoudnessEnhancer? = try {
                LoudnessEnhancer(newTrack.audioSessionId).apply {
                    setTargetGain(pagerBoostMb)
                    enabled = true
                }.also {
                    Log.d(TAG, "[LOUDNESS] LoudnessEnhancer attached sessionId=${newTrack.audioSessionId} gainMb=$pagerBoostMb (pager-synth)")
                }
            } catch (e: Exception) {
                Log.w(TAG, "[LOUDNESS-FALLBACK] pager-synth LoudnessEnhancer attach failed sessionId=${newTrack.audioSessionId}: ${e::class.simpleName}: ${e.message}")
                null
            }

            synchronized(playerLock) {
                cancelCurrentPagingPlaybackLocked()
                currentPagingTrack = newTrack
                currentPagingLoudnessEnhancer = trackLE
                pagingAudioManager = am
                previousAlarmVolume = prevVolume
            }

            newTrack.play()

            var written = 0
            val chunk = 4096
            while (written < numSamples) {
                val toWrite = minOf(chunk, numSamples - written)
                val n = newTrack.write(pcm, written, toWrite)
                if (n <= 0) {
                    Log.w(TAG, "[PAGER-SYNTH-FALLBACK] AudioTrack.write returned $n — aborting")
                    break
                }
                written += n
                val stillActive = synchronized(playerLock) { currentPagingTrack === newTrack }
                if (!stillActive) break
            }

            runCatching {
                if (synchronized(playerLock) { currentPagingTrack === newTrack }) {
                    newTrack.stop()
                }
            }
            finishPagingPlayback(newTrack, am, prevVolume, restoreVolume)
        } catch (e: Exception) {
            Log.w(TAG, "[PAGER-SYNTH-FALLBACK] playback exception: ${e.message}", e)
            runCatching { track?.release() }
            if (restoreVolume) {
                runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0) }
            }
            synchronized(playerLock) {
                if (currentPagingTrack === track) {
                    currentPagingTrack = null
                    pagingAudioManager = null
                    previousAlarmVolume = -1
                }
            }
        }
    }

    private fun finishPagingPlayback(
        track: AudioTrack,
        am: AudioManager,
        prevVolume: Int,
        restoreVolume: Boolean
    ) {
        synchronized(playerLock) {
            if (currentPagingTrack === track) {
                releasePagingLoudnessEnhancerLocked()
            }
        }
        runCatching { track.release() }
        if (restoreVolume) {
            runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0) }
        }
        synchronized(playerLock) {
            if (currentPagingTrack === track) {
                currentPagingTrack = null
                pagingAudioManager = null
                previousAlarmVolume = -1
            }
        }
    }

    private fun finishPagingPlayer(
        player: MediaPlayer,
        am: AudioManager,
        prevVolume: Int,
        restoreVolume: Boolean
    ) {
        synchronized(playerLock) {
            if (currentPagingPlayer === player) {
                releasePagingLoudnessEnhancerLocked()
            }
        }
        runCatching { player.release() }
        if (restoreVolume) {
            runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0) }
        }
        synchronized(playerLock) {
            if (currentPagingPlayer === player) {
                currentPagingPlayer = null
                pagingAudioManager = null
                previousAlarmVolume = -1
            }
        }
    }

    companion object {
        const val PAGING_CHANNEL_ID = "channel_paging_v2"
        const val PAGE_NOTIFICATION_ID = 7777
        const val ACTION_PAGE_RECEIVED = "com.reedersystems.commandcomms.PAGE_RECEIVED"
        const val EXTRA_PAGE_ID = "page_id"
        const val EXTRA_PAGE_MESSAGE = "page_message"
        const val EXTRA_PAGE_SENDER = "page_sender"
        const val EXTRA_PAGING_CHANNEL_ID = "paging_channel_id"

        private val playerLock = Any()
        @Volatile private var currentPagingTrack: AudioTrack? = null
        @Volatile private var currentPagingPlayer: MediaPlayer? = null
        @Volatile private var currentPagingLoudnessEnhancer: LoudnessEnhancer? = null
        @Volatile private var pagingAudioManager: AudioManager? = null
        @Volatile private var previousAlarmVolume: Int = -1

        private fun releasePagingLoudnessEnhancerLocked() {
            currentPagingLoudnessEnhancer?.let { le ->
                runCatching { le.enabled = false }
                runCatching { le.release() }
                Log.d(TAG, "[LOUDNESS] paging LoudnessEnhancer released")
            }
            currentPagingLoudnessEnhancer = null
        }

        /**
         * Stop and release any active paging playback (WAV via MediaPlayer or
         * synthesized PCM via AudioTrack). Caller must already hold playerLock.
         * Leaves alarm-volume bookkeeping fields intact so they can be
         * overwritten by the new playback that follows.
         */
        private fun cancelCurrentPagingPlaybackLocked() {
            releasePagingLoudnessEnhancerLocked()
            currentPagingTrack?.let { prev ->
                runCatching { prev.pause() }
                runCatching { prev.flush() }
                runCatching { prev.release() }
            }
            currentPagingTrack = null
            currentPagingPlayer?.let { prev ->
                runCatching { prev.stop() }
                runCatching { prev.release() }
            }
            currentPagingPlayer = null
        }

        fun stopPagingTone() {
            synchronized(playerLock) {
                cancelCurrentPagingPlaybackLocked()
                val am = pagingAudioManager
                val prev = previousAlarmVolume
                if (am != null && prev >= 0) {
                    runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prev, 0) }
                }
                pagingAudioManager = null
                previousAlarmVolume = -1
            }
        }

        fun clearPagingNotification(context: Context) {
            runCatching {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(PAGE_NOTIFICATION_ID)
            }
        }
    }
}
