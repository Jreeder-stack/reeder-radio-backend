package com.reedersystems.commandcomms.messaging

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.util.Log
import androidx.core.app.NotificationCompat
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.R
import com.reedersystems.commandcomms.ui.paging.PageAlertActivity
import org.json.JSONObject

/** Native authenticated paging fallback for devices without Google Play services. */
object NativeRadioPaging {
    private const val TAG = "NativeRadioPaging"
    private const val PREFS = "native_radio_paging"
    private val lock = Any()
    private var player: MediaPlayer? = null
    private var alarmManager: AudioManager? = null
    private var originalAlarmVolume: Int = -1

    fun receive(context: Context, page: JSONObject) {
        val app = context.applicationContext as CommandCommsApp
        val id = page.optString("pageId")
        val message = page.optString("message")
        val sender = page.optString("sender", "DISPATCH")
        val expiresAt = page.optLong("expiresAt", 0L)
        if (id.toLongOrNull() == null || id.toLong() <= 0 || message.isBlank() ||
            expiresAt <= System.currentTimeMillis()) {
            Log.w(TAG, "Rejected expired or invalid native page")
            return
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val firstDelivery = synchronized(lock) {
            if (prefs.getBoolean("shown:" + id, false)) false else {
                // Record the page before side effects, so reconnect retries do not
                // produce repeated full-volume alarms.
                prefs.edit().putBoolean("shown:" + id, true).apply()
                true
            }
        }
        if (firstDelivery) {
            val alert = Intent(context, PageAlertActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(CommandCommsFirebaseService.EXTRA_PAGE_ID, id)
                putExtra(CommandCommsFirebaseService.EXTRA_PAGE_MESSAGE, message)
                putExtra(CommandCommsFirebaseService.EXTRA_PAGE_SENDER, sender)
                putExtra(CommandCommsFirebaseService.EXTRA_PAGING_CHANNEL_ID,
                    page.optString("pagingChannelId", ""))
            }
            val pending = PendingIntent.getActivity(context, id.hashCode(), alert,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(
                context, CommandCommsFirebaseService.PAGING_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("PAGE from " + sender)
                .setContentText(message)
                .setStyle(NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setOngoing(true).setAutoCancel(false).setSound(null)
                .setContentIntent(pending).setFullScreenIntent(pending, true).build()
            try {
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(CommandCommsFirebaseService.PAGE_NOTIFICATION_ID, notification)
                context.startActivity(alert)
                playTone(context)
                context.sendBroadcast(Intent(CommandCommsFirebaseService.ACTION_PAGE_RECEIVED).apply {
                    setPackage(context.packageName)
                    putExtra(CommandCommsFirebaseService.EXTRA_PAGE_ID, id)
                    putExtra(CommandCommsFirebaseService.EXTRA_PAGE_MESSAGE, message)
                    putExtra(CommandCommsFirebaseService.EXTRA_PAGE_SENDER, sender)
                    putExtra(CommandCommsFirebaseService.EXTRA_PAGING_CHANNEL_ID,
                        page.optString("pagingChannelId", ""))
                })
            } catch (e: Exception) {
                Log.e(TAG, "Unable to display native page", e)
                // Do not mark delivered if Android could not display the page.
                prefs.edit().remove("shown:" + id).apply()
                return
            }
        }
        // Delivery receipt means the app accepted/displayed the page,
        // not that the operator acknowledged it.
        app.signalingClient.sendNativePageReceipt(id, "delivered")
    }

    fun acknowledge(context: Context, pageId: String) {
        stopTone()
        if (pageId.toLongOrNull() == null) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!prefs.getBoolean("shown:" + pageId, false)) return
        prefs.edit().putBoolean("pendingAck:" + pageId, true).apply()
        (context.applicationContext as? CommandCommsApp)
            ?.signalingClient?.sendNativePageReceipt(pageId, "acknowledged")
    }

    fun flushPendingAcks(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val client = (context.applicationContext as? CommandCommsApp)?.signalingClient ?: return
        for ((key, value) in prefs.all) {
            if (key.startsWith("pendingAck:") && value == true) {
                client.sendNativePageReceipt(key.removePrefix("pendingAck:"), "acknowledged")
            }
        }
    }

    fun confirmReceipt(context: Context, pageId: String, kind: String) {
        if (kind == "acknowledged") {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove("pendingAck:" + pageId).apply()
        }
    }

    fun stopTone() {
        synchronized(lock) {
            player?.let { runCatching { it.stop() }; runCatching { it.release() } }
            player = null
            if (originalAlarmVolume >= 0) {
                alarmManager?.let { am ->
                    runCatching { am.setStreamVolume(AudioManager.STREAM_ALARM, originalAlarmVolume, 0) }
                }
            }
            alarmManager = null
            originalAlarmVolume = -1
        }
    }

    private fun playTone(context: Context) {
        synchronized(lock) {
            stopTone()
            try {
                val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                alarmManager = am
                originalAlarmVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
                runCatching {
                    am.setStreamVolume(AudioManager.STREAM_ALARM,
                        am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
                }
                val mp = MediaPlayer()
                mp.setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                context.resources.openRawResourceFd(R.raw.pager_tone).use { afd ->
                    mp.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                }
                mp.prepare()
                mp.setOnCompletionListener {
                    synchronized(lock) {
                        if (player === it) {
                            stopTone()
                        } else runCatching { it.release() }
                    }
                }
                player = mp
                mp.start()
            } catch (e: Exception) {
                Log.e(TAG, "Native paging tone failed", e)
                stopTone()
            }
        }
    }
}
