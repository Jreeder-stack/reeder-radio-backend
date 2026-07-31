from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"Expected text not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


client = "android-native/app/src/main/java/com/reedersystems/commandcomms/signaling/SignalingClient.kt"
server = "src/services/signalingService.js"

replace_once(
    client,
    "import java.util.Timer\n",
    "import java.util.Timer\nimport java.util.UUID\n",
)

replace_once(
    client,
    "    private var authRetryTimer: Timer? = null\n\n    private var unitId: String = \"\"\n",
    "    private var authRetryTimer: Timer? = null\n    @Volatile private var pendingPttRequestId: String? = null\n    @Volatile private var pendingPttChannelId: String? = null\n\n    private var unitId: String = \"\"\n",
)

replace_once(
    client,
    "        s.on(\"ptt:granted\") { args -> parseAndEmit(args) { json ->\n            val ch = json.optString(\"channelId\")\n            val sender = json.optString(\"senderUnitId\")\n            Log.d(TAG, \"[FloorCtrl] SIGNALING_FLOOR_GRANTED channelId=$ch senderUnitId=$sender\")\n            SignalingEvent.RadioPttGranted(\n                channelId = ch,\n                senderUnitId = sender\n            )\n        }}\n",
    "        s.on(\"ptt:granted\") { args ->\n            val json = args.firstOrNull() as? JSONObject ?: return@on\n            val ch = json.optString(\"channelId\")\n            val sender = json.optString(\"senderUnitId\", json.optString(\"unitId\"))\n            val requestId = json.optString(\"requestId\")\n            val targetDeviceId = json.optString(\"targetDeviceId\")\n            val expectedRequestId = pendingPttRequestId\n            val expectedChannelId = pendingPttChannelId\n            val ownDeviceId = deviceId\n\n            val valid = expectedRequestId != null &&\n                requestId == expectedRequestId &&\n                ch == expectedChannelId &&\n                (targetDeviceId.isBlank() || ownDeviceId == null || targetDeviceId == ownDeviceId)\n\n            if (!valid) {\n                Log.w(TAG, \"[FloorCtrl] IGNORED_FOREIGN_PTT_GRANT channelId=$ch requestId=$requestId expectedRequestId=$expectedRequestId targetDeviceId=$targetDeviceId ownDeviceId=$ownDeviceId\")\n                return@on\n            }\n\n            pendingPttRequestId = null\n            pendingPttChannelId = null\n            Log.d(TAG, \"[FloorCtrl] SIGNALING_FLOOR_GRANTED channelId=$ch senderUnitId=$sender requestId=$requestId\")\n            _events.tryEmit(SignalingEvent.RadioPttGranted(channelId = ch, senderUnitId = sender))\n        }\n",
)

replace_once(
    client,
    "        s.on(Socket.EVENT_DISCONNECT) { _ ->\n            Log.d(TAG, \"Socket disconnected\")\n            _connectionState.value = ConnectionState.DISCONNECTED\n        }\n",
    "        s.on(Socket.EVENT_DISCONNECT) { _ ->\n            Log.d(TAG, \"Socket disconnected\")\n            pendingPttRequestId = null\n            pendingPttChannelId = null\n            _connectionState.value = ConnectionState.DISCONNECTED\n        }\n",
)

replace_once(
    client,
    "    fun emitRadioPttRequest(channelKey: String) {\n        if (!isReady()) {\n            Log.w(TAG, \"[RadioError] emitRadioPttRequest: not ready state=${_connectionState.value} channelKey=$channelKey\")\n            return\n        }\n        Log.d(TAG, \"[FloorCtrl] SIGNALING_FLOOR_REQUEST channelKey=$channelKey unitId=$unitId sessionTokenPresent=${socket?.connected() == true}\")\n        socket?.emit(\"ptt:request\", JSONObject().apply {\n            put(\"channelId\", channelKey)\n            put(\"unitId\", unitId)\n        })\n    }\n",
    "    fun emitRadioPttRequest(channelKey: String) {\n        if (!isReady()) {\n            Log.w(TAG, \"[RadioError] emitRadioPttRequest: not ready state=${_connectionState.value} channelKey=$channelKey\")\n            return\n        }\n        val requestId = UUID.randomUUID().toString()\n        pendingPttRequestId = requestId\n        pendingPttChannelId = channelKey\n        Log.d(TAG, \"[FloorCtrl] SIGNALING_FLOOR_REQUEST channelKey=$channelKey unitId=$unitId requestId=$requestId deviceId=${deviceId ?: \\\"none\\\"}\")\n        socket?.emit(\"ptt:request\", JSONObject().apply {\n            put(\"channelId\", channelKey)\n            put(\"unitId\", unitId)\n            put(\"requestId\", requestId)\n            deviceId?.let { put(\"deviceId\", it) }\n        })\n    }\n",
)

replace_once(
    client,
    "    fun emitRadioPttRelease(channelKey: String) {\n        if (!isReady()) {\n",
    "    fun emitRadioPttRelease(channelKey: String) {\n        pendingPttRequestId = null\n        pendingPttChannelId = null\n        if (!isReady()) {\n",
)

replace_once(
    client,
    "    fun emitRadioLeaveChannel(channelKey: String) {\n        if (!isReady()) return\n",
    "    fun emitRadioLeaveChannel(channelKey: String) {\n        pendingPttRequestId = null\n        pendingPttChannelId = null\n        if (!isReady()) return\n",
)

replace_once(
    server,
    "    socket.emit('ptt:granted', { channelId, unitId: socket.unitId, timestamp: Date.now() });\n",
    "    socket.emit('ptt:granted', {\n      channelId,\n      unitId: socket.unitId,\n      senderUnitId: socket.unitId,\n      requestId: data.requestId || null,\n      targetDeviceId: socket.deviceId || null,\n      originSocketId: socket.id,\n      timestamp: Date.now(),\n    });\n",
)

# Remove this one-shot patch machinery from the resulting branch commit.
Path("scripts/apply_t320_ptt_origin_fix.py").unlink(missing_ok=True)
Path(".github/workflows/apply-t320-ptt-origin-fix.yml").unlink(missing_ok=True)
