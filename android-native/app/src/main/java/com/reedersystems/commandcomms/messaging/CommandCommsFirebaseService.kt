package com.reedersystems.commandcomms.messaging

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.media.MediaPlayer
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.MainActivity
import com.reedersystems.commandcomms.R
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

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(MainActivity.EXTRA_PAGE_ID, pageId)
            putExtra(MainActivity.EXTRA_PAGE_MESSAGE, message)
            putExtra(MainActivity.EXTRA_PAGE_SENDER, sender)
            putExtra(MainActivity.EXTRA_PAGING_CHANNEL_ID, pagingChannelId ?: "")
        }

        val pendingIntent = PendingIntent.getActivity(
            this, pageId.hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, PAGING_CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("PAGE from $sender")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(false)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true)
            .build()

        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(PAGE_NOTIFICATION_ID, notification)

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
            try {
                val request = Request.Builder()
                    .url("${app.apiClient.baseUrl}/api/paging-tone/active")
                    .get()
                    .build()

                val responseBytes = kotlinx.coroutines.withContext(Dispatchers.IO) {
                    app.apiClient.httpClient.newCall(request).execute().use { resp ->
                        if (resp.isSuccessful) resp.body?.bytes() else null
                    }
                } ?: run {
                    Log.w(TAG, "No active paging tone found, using fallback beep")
                    app.toneEngine.playTalkPermitTone()
                    return@launch
                }

                val tmpFile = java.io.File.createTempFile("paging_tone", ".mp3", cacheDir)
                tmpFile.writeBytes(responseBytes)

                val mp = MediaPlayer()
                mp.setDataSource(tmpFile.absolutePath)
                mp.isLooping = false
                mp.setOnCompletionListener { player ->
                    player.release()
                    tmpFile.delete()
                }
                mp.prepare()
                mp.start()
                Log.d(TAG, "Paging tone playing from downloaded audio")
            } catch (e: Exception) {
                Log.w(TAG, "Paging tone playback error: ${e.message}, using fallback")
                app.toneEngine.playTalkPermitTone()
            }
        }
    }

    companion object {
        const val PAGING_CHANNEL_ID = "channel_paging"
        const val PAGE_NOTIFICATION_ID = 7777
        const val ACTION_PAGE_RECEIVED = "com.reedersystems.commandcomms.PAGE_RECEIVED"
        const val EXTRA_PAGE_ID = "page_id"
        const val EXTRA_PAGE_MESSAGE = "page_message"
        const val EXTRA_PAGE_SENDER = "page_sender"
        const val EXTRA_PAGING_CHANNEL_ID = "paging_channel_id"
    }
}
