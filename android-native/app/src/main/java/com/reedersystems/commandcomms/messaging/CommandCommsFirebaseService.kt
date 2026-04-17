package com.reedersystems.commandcomms.messaging

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.ToneGenerator
import android.util.Log
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

    private fun playPagingTone(app: CommandCommsApp) {
        scope.launch(Dispatchers.Main) {
            val url = "${app.apiClient.baseUrl}/api/paging-tone/active"
            var tmpFile: java.io.File? = null
            var mp: MediaPlayer? = null
            var raisedVolume = false
            val am = applicationContext.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val prevVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)

            try {
                val request = Request.Builder().url(url).get().build()

                val response = kotlinx.coroutines.withContext(Dispatchers.IO) {
                    app.apiClient.httpClient.newCall(request).execute().use { resp ->
                        val bytes = if (resp.isSuccessful) resp.body?.bytes() else null
                        val ct = resp.body?.contentType()?.toString()
                        Triple(resp.code, bytes, ct)
                    }
                }

                val (code, bytes, contentType) = response
                if (bytes == null || bytes.isEmpty()) {
                    Log.w(TAG, "No active paging tone (HTTP $code, ${bytes?.size ?: 0} bytes from $url) — using fallback beep")
                    playFallbackBeep(app)
                    return@launch
                }

                val ext = extensionForContentType(contentType, bytes)
                tmpFile = java.io.File.createTempFile("paging_tone", ".$ext", cacheDir)
                tmpFile.writeBytes(bytes)
                Log.d(TAG, "Paging tone fetched: ${bytes.size} bytes, content-type=$contentType, ext=$ext")

                val maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
                try {
                    am.setStreamVolume(AudioManager.STREAM_ALARM, maxVolume, 0)
                    raisedVolume = true
                } catch (e: SecurityException) {
                    Log.w(TAG, "Cannot override alarm volume (DnD policy?): ${e.message}")
                }

                val player = MediaPlayer()
                mp = player
                player.setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                player.setDataSource(tmpFile.absolutePath)
                player.isLooping = false
                runCatching { player.setVolume(1f, 1f) }

                val capturedTmp = tmpFile
                val restoreVolume = raisedVolume
                player.setOnCompletionListener { p ->
                    runCatching { p.release() }
                    finishPagingPlayback(p, am, prevVolume, restoreVolume, capturedTmp)
                }
                player.setOnErrorListener { p, what, extra ->
                    Log.w(TAG, "Paging tone playback error: what=$what extra=$extra")
                    runCatching { p.release() }
                    finishPagingPlayback(p, am, prevVolume, restoreVolume, capturedTmp)
                    true
                }

                synchronized(playerLock) {
                    currentPagingPlayer?.let { prev ->
                        runCatching { prev.stop() }
                        runCatching { prev.release() }
                    }
                    currentPagingPlayer = player
                    pagingAudioManager = am
                    previousAlarmVolume = prevVolume
                    pagingTempFile = capturedTmp
                }

                player.prepare()
                player.start()
                Log.d(TAG, "Paging tone playing from $url at STREAM_ALARM max=$maxVolume (was $prevVolume)")
            } catch (e: Exception) {
                Log.w(TAG, "Paging tone playback exception: ${e.message} (url=$url) — using fallback beep")
                runCatching { mp?.release() }
                if (raisedVolume) {
                    runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0) }
                }
                runCatching { tmpFile?.delete() }
                synchronized(playerLock) {
                    if (currentPagingPlayer === mp) {
                        currentPagingPlayer = null
                        pagingAudioManager = null
                        previousAlarmVolume = -1
                        pagingTempFile = null
                    }
                }
                playFallbackBeep(app)
            }
        }
    }

    private fun extensionForContentType(contentType: String?, bytes: ByteArray): String {
        val ct = contentType?.lowercase() ?: ""
        return when {
            ct.contains("mpeg") || ct.contains("mp3") -> "mp3"
            ct.contains("wav") -> "wav"
            ct.contains("ogg") -> "ogg"
            ct.contains("aac") || ct.contains("mp4") || ct.contains("m4a") -> "m4a"
            ct.contains("x-ms-wma") || ct.contains("wma") || ct.contains("asf") -> "wma"
            ct.contains("flac") -> "flac"
            else -> sniffExtensionFromMagic(bytes)
        }
    }

    private fun sniffExtensionFromMagic(bytes: ByteArray): String {
        if (bytes.size < 4) return "mp3"
        // ASF/WMA: 30 26 B2 75 8E 66 CF 11
        if (bytes[0] == 0x30.toByte() && bytes[1] == 0x26.toByte() &&
            bytes[2] == 0xB2.toByte() && bytes[3] == 0x75.toByte()
        ) return "wma"
        // RIFF (WAV)
        if (bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() &&
            bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte()
        ) return "wav"
        // OggS
        if (bytes[0] == 'O'.code.toByte() && bytes[1] == 'g'.code.toByte() &&
            bytes[2] == 'g'.code.toByte() && bytes[3] == 'S'.code.toByte()
        ) return "ogg"
        // ID3 / MP3 frame
        if ((bytes[0] == 'I'.code.toByte() && bytes[1] == 'D'.code.toByte() && bytes[2] == '3'.code.toByte()) ||
            (bytes[0] == 0xFF.toByte() && (bytes[1].toInt() and 0xE0) == 0xE0)
        ) return "mp3"
        // ftyp (MP4/M4A) at offset 4
        if (bytes.size >= 12 &&
            bytes[4] == 'f'.code.toByte() && bytes[5] == 't'.code.toByte() &&
            bytes[6] == 'y'.code.toByte() && bytes[7] == 'p'.code.toByte()
        ) return "m4a"
        // fLaC
        if (bytes[0] == 'f'.code.toByte() && bytes[1] == 'L'.code.toByte() &&
            bytes[2] == 'a'.code.toByte() && bytes[3] == 'C'.code.toByte()
        ) return "flac"
        return "mp3"
    }

    private fun finishPagingPlayback(
        player: MediaPlayer,
        am: AudioManager,
        prevVolume: Int,
        restoreVolume: Boolean,
        tmpFile: java.io.File?
    ) {
        if (restoreVolume) {
            runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prevVolume, 0) }
        }
        runCatching { tmpFile?.delete() }
        synchronized(playerLock) {
            if (currentPagingPlayer === player) {
                currentPagingPlayer = null
                pagingAudioManager = null
                previousAlarmVolume = -1
                pagingTempFile = null
            }
        }
    }

    private fun playFallbackBeep(app: CommandCommsApp) {
        try {
            val tg = ToneGenerator(AudioManager.STREAM_ALARM, ToneGenerator.MAX_VOLUME)
            tg.startTone(ToneGenerator.TONE_PROP_BEEP2, 500)
            scope.launch {
                kotlinx.coroutines.delay(700)
                runCatching { tg.release() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Fallback beep failed: ${e.message}")
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
        @Volatile private var currentPagingPlayer: MediaPlayer? = null
        @Volatile private var pagingAudioManager: AudioManager? = null
        @Volatile private var previousAlarmVolume: Int = -1
        @Volatile private var pagingTempFile: java.io.File? = null

        fun stopPagingTone() {
            synchronized(playerLock) {
                currentPagingPlayer?.let { mp ->
                    runCatching { mp.stop() }
                    runCatching { mp.release() }
                }
                currentPagingPlayer = null
                val am = pagingAudioManager
                val prev = previousAlarmVolume
                if (am != null && prev >= 0) {
                    runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, prev, 0) }
                }
                pagingAudioManager = null
                previousAlarmVolume = -1
                runCatching { pagingTempFile?.delete() }
                pagingTempFile = null
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
