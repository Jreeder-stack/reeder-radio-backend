package com.reedersystems.commandcomms.ui.radio

import android.app.Application
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.reedersystems.commandcomms.CommandCommsApp
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject

private const val TAG = "[RadioSocketVM]"

sealed class RadioSocketEvent {
    data class Assigned(val unitId: String) : RadioSocketEvent()
    object Locked : RadioSocketEvent()
    object Unlocked : RadioSocketEvent()
    object Unassigned : RadioSocketEvent()
}

class RadioSocketViewModel(application: Application) : AndroidViewModel(application) {

    private val app get() = getApplication<CommandCommsApp>()

    private val _radioEvent = MutableStateFlow<RadioSocketEvent?>(null)
    val radioEvent: StateFlow<RadioSocketEvent?> = _radioEvent.asStateFlow()

    private var socket: Socket? = null

    fun connect() {
        if (socket?.connected() == true) return

        val token = app.radioTokenStore.getToken() ?: run {
            Log.w(TAG, "No radio token found — cannot connect socket")
            return
        }

        val serverUrl = app.apiClient.baseUrl
        Log.d(TAG, "Connecting radio socket to $serverUrl with radioToken")

        try {
            val options = IO.Options.builder()
                .setPath("/signaling")
                .setTransports(arrayOf(WebSocket.NAME))
                .setReconnection(true)
                .setReconnectionDelay(3_000)
                .setReconnectionAttempts(Integer.MAX_VALUE)
                .setQuery("radioToken=$token")
                .build()

            val s = IO.socket(serverUrl, options)
            socket = s

            s.on(Socket.EVENT_CONNECT) {
                Log.d(TAG, "Radio socket connected")
            }

            s.on(Socket.EVENT_CONNECT_ERROR) { args ->
                Log.w(TAG, "Radio socket connect error: ${args.firstOrNull()}")
            }

            s.on(Socket.EVENT_DISCONNECT) { _ ->
                Log.d(TAG, "Radio socket disconnected")
            }

            s.on("radio:assigned") { args ->
                try {
                    val json = args.firstOrNull() as? JSONObject
                    val unitId = json?.optString("unitId").orEmpty().trim()
                    Log.d(TAG, "radio:assigned event unitIdPresent=${unitId.isNotBlank()}")
                    if (unitId.isBlank()) {
                        Log.w(TAG, "radio:assigned received with blank unitId — ignoring")
                        return@on
                    }
                    app.radioTokenStore.saveAssignedUnit(unitId)
                    app.sessionPrefs.unitId = unitId
                    app.sessionPrefs.username = unitId
                    app.signalingClient.setRadioToken(app.radioTokenStore.getToken())
                    viewModelScope.launch {
                        _radioEvent.value = RadioSocketEvent.Assigned(unitId)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "radio:assigned parse error: ${e.message}")
                }
            }

            s.on("radio:locked") { _ ->
                Log.d(TAG, "radio:locked event")
                viewModelScope.launch {
                    _radioEvent.value = RadioSocketEvent.Locked
                }
            }

            s.on("radio:unlocked") { _ ->
                Log.d(TAG, "radio:unlocked event")
                viewModelScope.launch {
                    _radioEvent.value = RadioSocketEvent.Unlocked
                }
            }

            s.on("radio:unassigned") { _ ->
                Log.d(TAG, "radio:unassigned event — clearing assigned unit")
                app.radioTokenStore.clearAssignedUnit()
                app.sessionPrefs.unitId = null
                app.sessionPrefs.username = null
                viewModelScope.launch {
                    _radioEvent.value = RadioSocketEvent.Unassigned
                }
            }

            s.connect()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create radio socket: ${e.message}")
        }
    }

    fun disconnect() {
        socket?.disconnect()
        socket?.off()
        socket = null
        Log.d(TAG, "Radio socket disconnected (dispose)")
    }

    override fun onCleared() {
        super.onCleared()
        disconnect()
    }
}
