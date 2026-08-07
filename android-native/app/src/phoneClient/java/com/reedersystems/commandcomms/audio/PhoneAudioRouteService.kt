package com.reedersystems.commandcomms.audio

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Phone-flavor-only guard that keeps Command Comms on Android's normal media
 * route. Bluetooth receive audio therefore stays on A2DP instead of switching
 * into HFP/SCO, which Android/head units commonly present as an active phone
 * call.
 *
 * The phone flavor intentionally does not use the Bluetooth headset microphone:
 * Android exposes that microphone through HFP/SCO. TX uses the handset's normal
 * microphone path while RX follows the system media output (Bluetooth A2DP,
 * wired/USB, or speaker).
 */
class PhoneAudioRouteService : Service() {

    private lateinit var audioManager: AudioManager
    private var callback: AudioDeviceCallback? = null
    private var communicationListener: AudioManager.OnCommunicationDeviceChangedListener? = null

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createChannel()
        startForeground(NOTIFICATION_ID, notification())

        normalizeToMediaRoute("service_start")
        registerDeviceCallback()
        registerCommunicationRouteListener()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        normalizeToMediaRoute("start_command")
        return START_STICKY
    }

    override fun onDestroy() {
        callback?.let {
            runCatching { audioManager.unregisterAudioDeviceCallback(it) }
        }
        callback = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            communicationListener?.let {
                runCatching { audioManager.removeOnCommunicationDeviceChangedListener(it) }
            }
        }
        communicationListener = null
        normalizeToMediaRoute("service_destroy")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerDeviceCallback() {
        if (callback != null) return
        callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
                normalizeToMediaRoute("device_added")
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                normalizeToMediaRoute("device_removed")
            }
        }.also { audioManager.registerAudioDeviceCallback(it, null) }
    }

    private fun registerCommunicationRouteListener() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || communicationListener != null) return
        communicationListener = AudioManager.OnCommunicationDeviceChangedListener { device ->
            if (device != null) {
                Log.w(TAG, "PHONE_CALL_ROUTE_DETECTED device=${deviceName(device)} — clearing communication route")
                normalizeToMediaRoute("communication_device_changed")
            }
        }.also {
            audioManager.addOnCommunicationDeviceChangedListener(mainExecutor, it)
        }
    }

    /**
     * Remove every call-style routing primitive from the phone flavor. We do
     * not explicitly select an A2DP device here: MEDIA playback lets Android
     * follow the user's normal system media output automatically.
     */
    private fun normalizeToMediaRoute(reason: String) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (audioManager.communicationDevice != null) {
                    audioManager.clearCommunicationDevice()
                }
            } else {
                @Suppress("DEPRECATION")
                runCatching { audioManager.stopBluetoothSco() }
                @Suppress("DEPRECATION")
                runCatching { audioManager.isBluetoothScoOn = false }
            }

            if (audioManager.mode != AudioManager.MODE_NORMAL) {
                audioManager.mode = AudioManager.MODE_NORMAL
            }

            Log.d(TAG, "PHONE_MEDIA_ROUTE reason=$reason mode=NORMAL communicationDevice=none")
        } catch (e: SecurityException) {
            Log.w(TAG, "PHONE_MEDIA_ROUTE permission not ready reason=$reason: ${e.message}")
        } catch (e: Exception) {
            Log.w(TAG, "PHONE_MEDIA_ROUTE failed safely reason=$reason: ${e.message}")
        }
    }

    private fun deviceName(device: AudioDeviceInfo): String = when (device.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
        AudioDeviceInfo.TYPE_USB_DEVICE -> "USB_DEVICE"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "BUILTIN_EARPIECE"
        else -> "TYPE_${device.type}"
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Phone audio routing",
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Keeps Command Comms on the normal media audio route"
                setShowBadge(false)
            }
        )
    }

    private fun notification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
        .setContentTitle("Command Comms")
        .setContentText("Phone media audio routing active")
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .build()

    companion object {
        private const val TAG = "[PhoneAudioRoute]"
        private const val CHANNEL_ID = "phone_audio_route"
        private const val NOTIFICATION_ID = 1021
    }
}
