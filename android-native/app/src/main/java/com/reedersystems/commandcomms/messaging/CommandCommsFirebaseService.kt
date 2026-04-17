package com.reedersystems.commandcomms.messaging

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import kotlin.math.sin
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.R
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
        Log.d(TAG, "FCM message received: ${remoteMessage.data}")

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
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setColorized(true)
            .setColor(0xFFCC0000.toInt())
            .setAutoCancel(false)
            .setOngoing(true)
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
     * Plays the dispatch console's "Tone A" alert — a 2.5s, 1000 Hz sine wave — by
     * synthesizing PCM on-device and rendering it through an AudioTrack on
     * STREAM_ALARM. No file download, no codec, no resampler: the tone is identical
     * on every device and matches client/src/audio/toneEngine.js#playToneA exactly.
     */
    private fun playPagingTone(app: CommandCommsApp) {
        scope.launch(Dispatchers.Main) {
            var track: AudioTrack? = null
            var raisedVolume = false
            val am = applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val prevVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)

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
                val pcmByteSize = numSamples * 2

                val maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
                try {
                    am.setStreamVolume(AudioManager.STREAM_ALARM, maxVolume, 0)
                    raisedVolume = true
                } catch (e: SecurityException) {
                    Log.w(TAG, "Cannot override alarm volume (DnD policy?): ${e.message}")
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

                val newTrack = AudioTrack.Builder()
                    .setAudioAttributes(attributes)
                    .setAudioFormat(format)
                    .setBufferSizeInBytes(pcmByteSize)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                track = newTrack
                runCatching { newTrack.setVolume(AudioTrack.getMaxVolume()) }
                newTrack.write(pcm, 0, numSamples)

                val restoreVolume = raisedVolume
                newTrack.setNotificationMarkerPosition(numSamples)
                newTrack.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
                    override fun onMarkerReached(t: AudioTrack) {
                        finishPagingPlayback(t, am, prevVolume, restoreVolume)
                    }
                    override fun onPeriodicNotification(t: AudioTrack) { /* unused */ }
                })

                synchronized(playerLock) {
                    currentPagingTrack?.let { prev ->
                        runCatching { prev.pause() }
                        runCatching { prev.flush() }
                        runCatching { prev.release() }
                    }
                    currentPagingTrack = newTrack
                    pagingAudioManager = am
                    previousAlarmVolume = prevVolume
                }

                newTrack.play()
                Log.d(TAG, "Paging tone playing: synthesized 1000Hz sine ${durationMs}ms at STREAM_ALARM max=$maxVolume (was $prevVolume)")
            } catch (e: Exception) {
                Log.w(TAG, "Paging tone playback exception: ${e.message}")
                runCatching { track?.release() }
                if (raisedVolume) {
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
    }

    private fun finishPagingPlayback(
        track: AudioTrack,
        am: AudioManager,
        prevVolume: Int,
        restoreVolume: Boolean
    ) {
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
        @Volatile private var pagingAudioManager: AudioManager? = null
        @Volatile private var previousAlarmVolume: Int = -1

        fun stopPagingTone() {
            synchronized(playerLock) {
                currentPagingTrack?.let { t ->
                    runCatching { t.pause() }
                    runCatching { t.flush() }
                    runCatching { t.release() }
                }
                currentPagingTrack = null
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
