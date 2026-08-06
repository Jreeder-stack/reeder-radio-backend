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
 * Phone-flavor-only audio route guard.
 *
 * The shared radio engine was designed around dedicated radio hardware and
 * intentionally prefers wired audio or the built-in loudspeaker. On a normal
 * Android handset we instead want Android communication routing to follow
 * external accessories first, including Bluetooth headsets.
 *
 * This class exists only in src/phoneClient, so T320/SD7/bridge builds never
 * compile or run it.
 */
class PhoneAudioRouteService : Service() {

    private lateinit var audioManager: AudioManager
    private var callback: AudioDeviceCallback? = null

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(AUDIO_SERVICE) as AudioManager
        createChannel()
        startForeground(NOTIFICATION_ID, notification())
        registerDeviceCallback()
        applyPreferredPhoneRoute("service_start")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        applyPreferredPhoneRoute("start_command")
        return START_STICKY
    }

    override fun onDestroy() {
        callback?.let {
            try { audioManager.unregisterAudioDeviceCallback(it) } catch (_: Exception) {}
        }
        callback = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerDeviceCallback() {
        if (callback != null) return
        callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
                applyPreferredPhoneRoute("device_added")
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                applyPreferredPhoneRoute("device_removed")
            }
        }.also { audioManager.registerAudioDeviceCallback(it, null) }
    }

    /**
     * Phone routing priority:
     *  1. Bluetooth communication headset/device
     *  2. Wired/USB headset
     *  3. Built-in loudspeaker
     *
     * setCommunicationDevice() controls the communication route as a pair, so
     * Android will use the matching headset microphone where the device exposes
     * one. This intentionally does not run on dedicated radio flavors.
     */
    private fun applyPreferredPhoneRoute(reason: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val devices = audioManager.availableCommunicationDevices
            val target = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
                ?: devices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                        it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                        it.type == AudioDeviceInfo.TYPE_USB_DEVICE
                }
                ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }

            if (target != null && audioManager.communicationDevice?.id != target.id) {
                val ok = audioManager.setCommunicationDevice(target)
                Log.d(TAG, "PHONE_ROUTE reason=$reason target=${deviceName(target)} applied=$ok")
            } else {
                Log.d(TAG, "PHONE_ROUTE reason=$reason target=${target?.let(::deviceName) ?: "none"} unchanged=true")
            }
            return
        }

        @Suppress("DEPRECATION")
        val bluetoothAvailable = audioManager.isBluetoothScoAvailableOffCall
        @Suppress("DEPRECATION")
        if (bluetoothAvailable) {
            try {
                audioManager.startBluetoothSco()
                audioManager.isBluetoothScoOn = true
                audioManager.isSpeakerphoneOn = false
                Log.d(TAG, "PHONE_ROUTE reason=$reason target=BLUETOOTH_SCO legacy=true")
                return
            } catch (e: Exception) {
                Log.w(TAG, "PHONE_ROUTE legacy Bluetooth failed: ${e.message}")
            }
        }

        val wired = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_USB_DEVICE
        }
        @Suppress("DEPRECATION")
        audioManager.isSpeakerphoneOn = !wired
        Log.d(TAG, "PHONE_ROUTE reason=$reason target=${if (wired) "WIRED" else "SPEAKER"} legacy=true")
    }

    private fun deviceName(device: AudioDeviceInfo): String = when (device.type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
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
                description = "Keeps Command Comms routed to the active phone headset or speaker"
                setShowBadge(false)
            }
        )
    }

    private fun notification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
        .setContentTitle("Command Comms")
        .setContentText("Phone audio routing active")
        .setOngoing(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .build()

    companion object {
        private const val TAG = "[PhoneAudioRoute]"
        private const val CHANNEL_ID = "phone_audio_route"
        private const val NOTIFICATION_ID = 1021
    }
}
