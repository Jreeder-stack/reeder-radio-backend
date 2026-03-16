package com.reedersystems.commandcomms

import android.Manifest
import android.content.Context
import android.media.AudioManager
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

@CapacitorPlugin(
    name = "NativeLiveKit",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO]),
        Permission(alias = "audioSettings", strings = [Manifest.permission.MODIFY_AUDIO_SETTINGS])
    ]
)
class LiveKitPlugin : Plugin(), NativeRadioEngine.Listener {

    companion object {
        private const val DIAG_TAG = "PTT-DIAG"

        @Volatile
        private var instance: LiveKitPlugin? = null

        @JvmStatic
        fun getInstance(): LiveKitPlugin? = instance
    }

    private val pluginScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var audioManager: AudioManager? = null

    private val engine: NativeRadioEngine
        get() = NativeRadioEngine.getInstance(context.applicationContext)

    override fun load() {
        super.load()
        instance = this
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        engine.addListener(this)
        Log.d(DIAG_TAG, "LiveKitPlugin loaded as UI bridge")
    }

    fun isRoomConnected(): Boolean = engine.isConnected()
    fun isMicTransmitting(): Boolean = engine.isMicEnabled()
    fun getActiveChannel(): String? = engine.getActiveChannel()
    fun connectFromService(url: String, token: String, channelName: String): Boolean = engine.connect(url, token, channelName)
    fun startTransmit(): Boolean = engine.startTransmit()
    fun stopTransmit(): Boolean = engine.stopTransmit()

    @PluginMethod
    fun connect(call: PluginCall) {
        val url = call.getString("url")
        val token = call.getString("token")
        val channelName = call.getString("channelName") ?: "unknown"

        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            call.reject("Missing url or token parameter")
            return
        }

        pluginScope.launch {
            val connected = engine.connectSuspend(url, token, channelName)
            if (connected) {
                call.resolve(JSObject().apply {
                    put("success", true)
                    put("channelName", channelName)
                })
            } else {
                call.reject("Failed to connect")
            }
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        pluginScope.launch {
            val disconnected = engine.disconnectSuspend()
            if (disconnected) {
                call.resolve(JSObject().apply { put("success", true) })
            } else {
                call.reject("Failed to disconnect")
            }
        }
    }

    @PluginMethod
    fun enableMicrophone(call: PluginCall) {
        pluginScope.launch {
            val ok = engine.startTransmitSuspend()
            if (ok) {
                call.resolve(JSObject().apply {
                    put("success", true)
                    put("enabled", true)
                })
            } else {
                call.reject("Failed to enable microphone")
            }
        }
    }

    @PluginMethod
    fun disableMicrophone(call: PluginCall) {
        pluginScope.launch {
            val ok = engine.stopTransmitSuspend()
            if (ok) {
                call.resolve(JSObject().apply {
                    put("success", true)
                    put("enabled", false)
                })
            } else {
                call.reject("Failed to disable microphone")
            }
        }
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("isConnected", engine.isConnected())
            put("isMicEnabled", engine.isMicEnabled())
            put("currentChannel", engine.getActiveChannel())
        })
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("available", true)
            put("platform", "android")
        })
    }

    @PluginMethod
    fun setSpeakerphone(call: PluginCall) {
        val enabled = call.getBoolean("enabled", true) ?: true
        audioManager?.let {
            it.isSpeakerphoneOn = enabled
            call.resolve(JSObject().apply {
                put("success", true)
                put("enabled", enabled)
            })
        } ?: call.reject("AudioManager not available")
    }

    override fun onEngineEvent(event: String, data: Map<String, Any?>) {
        val payload = JSObject()
        data.forEach { (k, v) -> payload.put(k, v) }
        notifyListeners(event, payload)
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        engine.removeListener(this)
        pluginScope.cancel()
        instance = null
    }
}
