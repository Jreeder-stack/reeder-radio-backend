package com.reedersystems.commandcomms.signaling

import android.util.Log
import io.socket.client.IO
import io.socket.client.Manager
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.util.Timer
import kotlin.concurrent.schedule

private const val TAG = "[PTT-DIAG]"
private const val STARTUP_TAG = "[APP-STARTUP]"

enum class ConnectionState { DISCONNECTED, CONNECTING, CONNECTED, AUTHENTICATED }

class SignalingClient(var serverUrl: String, private var radioToken: String? = null, var deviceId: String? = null) {

    private var socket: Socket? = null

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _events = MutableSharedFlow<SignalingEvent>(extraBufferCapacity = 32)
    val events: SharedFlow<SignalingEvent> = _events.asSharedFlow()

    private val pendingEmergencyEndKeys = mutableSetOf<String>()
    private var authRetryTimer: Timer? = null

    private var unitId: String = ""
    private var username: String = ""

    var onAuthenticated: (() -> Unit)? = null

    fun setRadioToken(token: String?) {
        radioToken = token
    }

    fun connect(unitId: String, username: String) {
        if (_connectionState.value != ConnectionState.DISCONNECTED) return
        this.unitId = unitId
        this.username = username

        Log.d(TAG, "SignalingClient connecting to $serverUrl")
        Log.d(STARTUP_TAG, "SIGNALING_CONNECT_ATTEMPT url=$serverUrl unitId=$unitId")
        _connectionState.value = ConnectionState.CONNECTING

        val optionsBuilder = IO.Options.builder()
            .setPath("/signaling")
            .setTransports(arrayOf(WebSocket.NAME))
            .setReconnection(true)
            .setReconnectionDelay(2_000)
            .setReconnectionAttempts(Integer.MAX_VALUE)

        val token = radioToken
        if (token != null) {
            Log.d(STARTUP_TAG, "SIGNALING_CONNECT_RADIO_AUTH radioToken present")
            optionsBuilder.setQuery("radioToken=$token")
        }

        val options = optionsBuilder.build()
        val s = IO.socket(serverUrl, options)
        socket = s

        s.on(Socket.EVENT_CONNECT) {
            Log.d(TAG, "Socket connected, authenticating as $unitId")
            Log.d(STARTUP_TAG, "SIGNALING_CONNECTED")
            _connectionState.value = ConnectionState.CONNECTED
            val auth = JSONObject().apply {
                put("unitId", unitId)
                put("username", username)
                put("agencyId", "default")
                put("isDispatcher", false)
                deviceId?.let { put("deviceId", it) }
                put("deviceType", if (radioToken != null) "radio" else "desktop")
                put("clientType", "radio")
            }
            Log.d(STARTUP_TAG, "SIGNALING_AUTH_SENT unitId=$unitId deviceId=${deviceId ?: "none"}")
            s.emit("authenticate", auth)

            authRetryTimer?.cancel()
            authRetryTimer = Timer("auth-retry", true).apply {
                schedule(3_000L) {
                    if (_connectionState.value == ConnectionState.CONNECTED) {
                        Log.w(STARTUP_TAG, "SIGNALING_AUTH_RETRY state still CONNECTED after 3s, re-emitting authenticate")
                        s.emit("authenticate", auth)
                    }
                }
            }
        }

        s.on("authenticated") { _ ->
            Log.d(TAG, "Signaling authenticated: $unitId")
            Log.d(STARTUP_TAG, "SIGNALING_AUTH_SUCCESS unitId=$unitId")
            authRetryTimer?.cancel()
            authRetryTimer = null
            _connectionState.value = ConnectionState.AUTHENTICATED
            flushPendingEmergencyEnds()
            onAuthenticated?.invoke()
        }

        s.on("unauthorized") { args ->
            Log.e(STARTUP_TAG, "SIGNALING_AUTH_FAILED reason=${args.firstOrNull()}")
            _connectionState.value = ConnectionState.DISCONNECTED
        }

        s.on("auth:error") { args ->
            Log.e(STARTUP_TAG, "SIGNALING_AUTH_FAILED reason=${args.firstOrNull()}")
            _connectionState.value = ConnectionState.DISCONNECTED
        }

        s.on(Socket.EVENT_DISCONNECT) { _ ->
            Log.d(TAG, "Socket disconnected")
            _connectionState.value = ConnectionState.DISCONNECTED
        }

        s.on(Socket.EVENT_CONNECT_ERROR) { args ->
            Log.w(TAG, "Socket connect error: ${args.firstOrNull()}")
            Log.e(STARTUP_TAG, "SIGNALING_AUTH_FAILED reason=connect_error ${args.firstOrNull()}")
            _connectionState.value = ConnectionState.DISCONNECTED
        }

        s.io().on(Manager.EVENT_RECONNECT_FAILED) {
            Log.e(TAG, "Signaling reconnection attempts exhausted — connection lost")
            _connectionState.value = ConnectionState.DISCONNECTED
        }

        s.on("ptt:pre") { args -> parseAndEmit(args) { json ->
            SignalingEvent.PttPre(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("ptt:start") { args -> parseAndEmit(args) { json ->
            SignalingEvent.PttStart(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("ptt:end") { args -> parseAndEmit(args) { json ->
            SignalingEvent.PttEnd(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("ptt:busy") { args -> parseAndEmit(args) { json ->
            SignalingEvent.PttBusy(
                channelId = json.optString("channelId"),
                transmittingUnit = json.optString("transmittingUnit")
            )
        }}

        s.on("channel:join") { args -> parseAndEmit(args) { json ->
            SignalingEvent.UnitJoined(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("channel:leave") { args -> parseAndEmit(args) { json ->
            SignalingEvent.UnitLeft(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("emergency:start") { args -> parseAndEmit(args) { json ->
            SignalingEvent.EmergencyStart(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("emergency:end") { args -> parseAndEmit(args) { json ->
            SignalingEvent.EmergencyEnd(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("clear_air:start") { args -> parseAndEmit(args) { json ->
            SignalingEvent.ClearAirStart(channelId = json.optString("channelId"))
        }}

        s.on("clear_air:alert") { args -> parseAndEmit(args) { json ->
            SignalingEvent.ClearAirStart(channelId = json.optString("channelId"))
        }}

        s.on("clear_air:end") { args -> parseAndEmit(args) { json ->
            SignalingEvent.ClearAirEnd(channelId = json.optString("channelId"))
        }}

        s.on("unit:status") { args -> parseAndEmit(args) { json ->
            SignalingEvent.UnitStatusChanged(
                unitId = json.optString("unitId"),
                status = json.optString("status")
            )
        }}

        s.on("location:track_start") { args ->
            try {
                val json = args.firstOrNull() as? JSONObject
                val event = SignalingEvent.LocationTrackStart(
                    requestedBy = json?.optString("requestedBy") ?: "dispatch",
                    emergency = json?.optBoolean("emergency", false) ?: false
                )
                _events.tryEmit(event)
            } catch (e: Exception) { Log.w(TAG, "location:track_start parse error") }
        }

        s.on("location:track_stop") { _ ->
            _events.tryEmit(SignalingEvent.LocationTrackStop)
        }

        s.on("radio:channelJoined") { args -> parseAndEmit(args) { json ->
            SignalingEvent.RadioChannelJoined(
                channelId = json.optString("channelId")
            )
        }}

        s.on("ptt:granted") { args -> parseAndEmit(args) { json ->
            val ch = json.optString("channelId")
            val sender = json.optString("senderUnitId")
            Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_GRANTED channelId=$ch senderUnitId=$sender")
            SignalingEvent.RadioPttGranted(
                channelId = ch,
                senderUnitId = sender
            )
        }}

        s.on("ptt:denied") { args -> parseAndEmit(args) { json ->
            val ch = json.optString("channelId")
            val reason = json.optString("reason", "")
            val heldBy = json.optString("heldBy")
            Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_DENIED channelId=$ch reason=$reason heldBy=$heldBy")
            SignalingEvent.RadioPttDenied(
                channelId = ch,
                reason = reason,
                heldBy = heldBy
            )
        }}

        s.on("tx:start") { args -> parseAndEmit(args) { json ->
            SignalingEvent.RadioTxStart(
                senderUnitId = json.optString("senderUnitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("tx:stop") { args -> parseAndEmit(args) { json ->
            SignalingEvent.RadioTxStop(
                senderUnitId = json.optString("senderUnitId"),
                channelId = json.optString("channelId")
            )
        }}

        s.on("channel:busy") { args -> parseAndEmit(args) { json ->
            SignalingEvent.RadioChannelBusy(
                channelId = json.optString("channelId"),
                heldBy = json.optString("heldBy")
            )
        }}

        s.on("channel:floor_taken") { args -> parseAndEmit(args) { json ->
            SignalingEvent.RadioFloorTaken(
                channelId = json.optString("channelId"),
                heldBy = json.optString("heldBy")
            )
        }}

        s.on("channel:idle") { args -> parseAndEmit(args) { json ->
            SignalingEvent.RadioChannelIdle(
                channelId = json.optString("channelId")
            )
        }}

        s.on("radio:dsp_config") { args ->
            try {
                val json = args.firstOrNull() as? JSONObject ?: return@on
                Log.d(TAG, "radio:dsp_config received: $json")
                _events.tryEmit(SignalingEvent.RadioDspConfig(json))
            } catch (e: Exception) {
                Log.w(TAG, "radio:dsp_config parse error: ${e.message}")
            }
        }

        s.on("tx:silence_warning") { args -> parseAndEmit(args) { json ->
            SignalingEvent.TxSilenceWarning(
                unitId = json.optString("unitId"),
                channelId = json.optString("channelId"),
                silenceMs = json.optLong("silenceMs", 0)
            )
        }}

        s.on("radio:locked") { _ ->
            Log.d(TAG, "radio:locked received on main signaling socket")
            _events.tryEmit(SignalingEvent.RadioLocked)
        }

        s.on("radio:unlocked") { _ ->
            Log.d(TAG, "radio:unlocked received on main signaling socket")
            _events.tryEmit(SignalingEvent.RadioUnlocked)
        }

        s.on("radio:unassigned") { _ ->
            Log.d(TAG, "radio:unassigned received on main signaling socket")
            _events.tryEmit(SignalingEvent.RadioUnassigned)
        }

        s.on("radio:kiosk_unlock") { args ->
            try {
                val json = args.firstOrNull() as? JSONObject
                val expiresAt = json?.optLong("expiresAt", 0L) ?: 0L
                val durationMinutes = json?.optInt("durationMinutes", 0) ?: 0
                Log.d(TAG, "radio:kiosk_unlock received expiresAt=$expiresAt durationMinutes=$durationMinutes")
                if (expiresAt > 0L) {
                    _events.tryEmit(SignalingEvent.RemoteKioskUnlock(expiresAt, durationMinutes))
                } else {
                    Log.w(TAG, "radio:kiosk_unlock missing expiresAt — ignoring")
                }
            } catch (e: Exception) {
                Log.w(TAG, "radio:kiosk_unlock parse error: ${e.message}")
            }
        }

        s.on("radio:kiosk_relock") { _ ->
            Log.d(TAG, "radio:kiosk_relock received")
            _events.tryEmit(SignalingEvent.RemoteKioskRelock)
        }

        s.on("radio:assigned") { args ->
            try {
                val json = args.firstOrNull() as? JSONObject
                val assignedUnitId = json?.optString("unitId").orEmpty().trim()
                Log.d(TAG, "radio:assigned received on main signaling socket unitId=$assignedUnitId")
                if (assignedUnitId.isNotBlank()) {
                    _events.tryEmit(SignalingEvent.RadioAssigned(assignedUnitId))
                }
            } catch (e: Exception) {
                Log.w(TAG, "radio:assigned parse error: ${e.message}")
            }
        }

        s.on("ptt:revoked") { args -> parseAndEmit(args) { json ->
            SignalingEvent.PttRevoked(
                channelId = json.optString("channelId"),
                reason = json.optString("reason", "dispatcher_takeover")
            )
        }}

        s.on("ping") { s.emit("pong") }

        s.connect()
    }

    fun disconnect() {
        authRetryTimer?.cancel()
        authRetryTimer = null
        socket?.disconnect()
        socket?.off()
        socket = null
        _connectionState.value = ConnectionState.DISCONNECTED
    }

    fun joinChannel(channelKey: String) {
        if (!isReady()) return
        Log.d(TAG, "joinChannel $channelKey")
        socket?.emit("channel:join", JSONObject().put("channelId", channelKey))
    }

    fun leaveChannel(channelKey: String) {
        if (socket?.connected() != true) return
        Log.d(TAG, "leaveChannel $channelKey")
        socket?.emit("channel:leave", JSONObject().put("channelId", channelKey))
    }

    fun emitPttPre(channelKey: String) {
        if (!isReady()) return
        Log.d(TAG, "emitPttPre $channelKey")
        socket?.emit("ptt:pre", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
        })
    }

    fun emitStatusUpdate(status: String) {
        if (!isReady()) return
        socket?.emit("unit:status", JSONObject().apply {
            put("unitId", unitId)
            put("status", status)
        })
    }

    fun emitEmergencyStart(channelKey: String) {
        if (!isReady()) return
        Log.d(TAG, "emitEmergencyStart $channelKey")
        socket?.emit("emergency:start", JSONObject().put("channelId", channelKey))
    }

    fun emitEmergencyEnd(channelKey: String) {
        if (!isReady()) {
            Log.w(TAG, "emitEmergencyEnd: not authenticated — queuing channelKey=$channelKey for retry on reconnect")
            synchronized(pendingEmergencyEndKeys) {
                pendingEmergencyEndKeys.add(channelKey)
            }
            return
        }
        Log.d(TAG, "emitEmergencyEnd $channelKey")
        synchronized(pendingEmergencyEndKeys) {
            pendingEmergencyEndKeys.remove(channelKey)
        }
        socket?.emit("emergency:end", JSONObject().put("channelId", channelKey))
    }

    fun emitLocationUpdate(lat: Double, lon: Double, accuracy: Float, heading: Float?, speed: Float?) {
        if (socket?.connected() != true) return
        socket?.emit("location:update", JSONObject().apply {
            put("latitude", lat)
            put("longitude", lon)
            put("accuracy", accuracy)
            if (heading != null) put("heading", heading)
            if (speed != null) put("speed", speed)
        })
    }

    fun emitRadioJoinChannel(channelKey: String, udpPort: Int? = null, udpAddress: String? = null) {
        if (!isReady()) return
        Log.d(TAG, "emitRadioJoinChannel $channelKey udpPort=${udpPort ?: "none"} udpAddress=${udpAddress ?: "none"}")
        socket?.emit("radio:joinChannel", JSONObject().apply {
            put("channelId", channelKey)
            if (udpPort != null && udpPort > 0) put("udpPort", udpPort)
            if (!udpAddress.isNullOrBlank() && udpAddress != "0.0.0.0" && udpAddress != "::") put("udpAddress", udpAddress)
        })
    }

    fun emitRadioLeaveChannel(channelKey: String) {
        if (!isReady()) return
        Log.d(TAG, "emitRadioLeaveChannel $channelKey")
        socket?.emit("radio:leaveChannel", JSONObject().put("channelId", channelKey))
    }

    fun emitRadioPttRequest(channelKey: String) {
        if (!isReady()) {
            Log.w(TAG, "[RadioError] emitRadioPttRequest: not ready state=${_connectionState.value} channelKey=$channelKey")
            return
        }
        Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_REQUEST channelKey=$channelKey unitId=$unitId sessionTokenPresent=${socket?.connected() == true}")
        socket?.emit("ptt:request", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
        })
    }

    fun emitRadioTxStart(channelKey: String) {
        if (!isReady()) {
            Log.w(TAG, "[RadioError] emitRadioTxStart: not ready state=${_connectionState.value} channelKey=$channelKey")
            return
        }
        Log.d(TAG, "[FloorCtrl] SIGNALING_TX_START channelKey=$channelKey unitId=$unitId")
        socket?.emit("tx:start", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
        })
    }

    fun emitRadioPttRelease(channelKey: String) {
        if (!isReady()) {
            Log.w(TAG, "[RadioError] emitRadioPttRelease: not ready state=${_connectionState.value} channelKey=$channelKey")
            return
        }
        Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_RELEASE channelKey=$channelKey unitId=$unitId")
        socket?.emit("ptt:release", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
        })
    }

    fun emitRadioTxStop(channelKey: String) {
        if (!isReady()) {
            Log.w(TAG, "[RadioError] emitRadioTxStop: not ready state=${_connectionState.value} channelKey=$channelKey")
            return
        }
        Log.d(TAG, "[FloorCtrl] SIGNALING_TX_STOP channelKey=$channelKey unitId=$unitId")
        socket?.emit("tx:stop", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
        })
    }

    fun emitRadioSignalQuality(channelKey: String, quality: String, lossPct: Double, jitterMs: Double) {
        if (!isReady()) return
        socket?.emit("radio:signalQuality", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
            put("quality", quality)
            put("lossPct", lossPct)
            put("jitterMs", jitterMs)
            put("timestamp", System.currentTimeMillis())
        })
    }

    fun queryEmergencyStatus(channelKey: String) {
        if (!isReady()) return
        Log.d(TAG, "queryEmergencyStatus channelKey=$channelKey")
        socket?.emit("emergency:status", JSONObject().put("channelId", channelKey),
            io.socket.client.Ack { args ->
                try {
                    val json = args.firstOrNull() as? JSONObject ?: return@Ack
                    val active = json.optBoolean("active", false)
                    val emergencyUnitId = json.optString("unitId", "").ifBlank { null }
                    Log.d(TAG, "emergency:status response channelKey=$channelKey active=$active unitId=$emergencyUnitId")
                    _events.tryEmit(
                        SignalingEvent.EmergencyStatusResponse(
                            channelId = channelKey,
                            active = active,
                            unitId = emergencyUnitId
                        )
                    )
                } catch (e: Exception) {
                    Log.w(TAG, "emergency:status ack parse error: ${e.message}")
                }
            }
        )
    }

    private fun isReady() = _connectionState.value == ConnectionState.AUTHENTICATED

    private fun flushPendingEmergencyEnds() {
        val keys: List<String>
        synchronized(pendingEmergencyEndKeys) {
            keys = pendingEmergencyEndKeys.toList()
        }
        if (keys.isEmpty()) return
        for (key in keys) {
            if (!isReady()) {
                Log.w(TAG, "flushPendingEmergencyEnds: lost auth mid-flush — keeping remaining keys")
                return
            }
            Log.d(TAG, "flushPendingEmergencyEnds: emitting emergency:end for channelKey=$key")
            socket?.emit("emergency:end", JSONObject().put("channelId", key))
            synchronized(pendingEmergencyEndKeys) {
                pendingEmergencyEndKeys.remove(key)
            }
        }
    }

    private inline fun parseAndEmit(
        args: Array<Any>,
        crossinline mapper: (JSONObject) -> SignalingEvent
    ) {
        try {
            val json = args.firstOrNull() as? JSONObject ?: return
            val event = mapper(json)
            _events.tryEmit(event)
        } catch (e: Exception) {
            Log.w(TAG, "parseAndEmit error: ${e.message}")
        }
    }
}
