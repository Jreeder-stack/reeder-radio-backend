from pathlib import Path

client_path = Path('android-native/app/src/main/java/com/reedersystems/commandcomms/signaling/SignalingClient.kt')
server_path = Path('src/services/signalingService.js')
client = client_path.read_text()
server = server_path.read_text()

def swap(text, old, new, label):
    if old not in text:
        raise RuntimeError(f'missing {label}')
    return text.replace(old, new, 1)

client = swap(client, 'import java.util.Timer\n', 'import java.util.Timer\nimport java.util.UUID\n', 'UUID import')
client = swap(client,
'''    private val pendingEmergencyEndKeys = mutableSetOf<String>()
    private var authRetryTimer: Timer? = null
''',
'''    private val pendingEmergencyEndKeys = mutableSetOf<String>()
    private var authRetryTimer: Timer? = null
    @Volatile private var pendingPttRequestId: String? = null
    @Volatile private var pendingPttChannelId: String? = null
''', 'pending fields')
client = swap(client,
'''        s.on(Socket.EVENT_DISCONNECT) { _ ->
            Log.d(TAG, "Socket disconnected")
            _connectionState.value = ConnectionState.DISCONNECTED
        }
''',
'''        s.on(Socket.EVENT_DISCONNECT) { _ ->
            Log.d(TAG, "Socket disconnected")
            pendingPttRequestId = null
            pendingPttChannelId = null
            _connectionState.value = ConnectionState.DISCONNECTED
        }
''', 'disconnect clear')
client = swap(client,
'''        s.on("ptt:granted") { args -> parseAndEmit(args) { json ->
            val ch = json.optString("channelId")
            val sender = json.optString("senderUnitId")
            Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_GRANTED channelId=$ch senderUnitId=$sender")
            SignalingEvent.RadioPttGranted(
                channelId = ch,
                senderUnitId = sender
            )
        }}
''',
'''        s.on("ptt:granted") { args ->
            val json = args.firstOrNull() as? JSONObject ?: return@on
            val ch = json.optString("channelId")
            val sender = json.optString("senderUnitId", json.optString("unitId"))
            val requestId = json.optString("requestId")
            val targetDeviceId = json.optString("targetDeviceId")
            val expectedRequestId = pendingPttRequestId
            val expectedChannelId = pendingPttChannelId
            val ownDeviceId = deviceId
            val valid = expectedRequestId != null &&
                requestId == expectedRequestId &&
                ch == expectedChannelId &&
                (targetDeviceId.isBlank() || ownDeviceId == null || targetDeviceId == ownDeviceId)
            if (!valid) {
                Log.w(TAG, "[FloorCtrl] IGNORED_FOREIGN_PTT_GRANT channelId=$ch requestId=$requestId expectedRequestId=$expectedRequestId targetDeviceId=$targetDeviceId ownDeviceId=$ownDeviceId")
                return@on
            }
            pendingPttRequestId = null
            pendingPttChannelId = null
            Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_GRANTED channelId=$ch senderUnitId=$sender requestId=$requestId")
            _events.tryEmit(SignalingEvent.RadioPttGranted(channelId = ch, senderUnitId = sender))
        }
''', 'grant validation')
client = swap(client,
'''    fun emitRadioLeaveChannel(channelKey: String) {
        if (!isReady()) return
''',
'''    fun emitRadioLeaveChannel(channelKey: String) {
        pendingPttRequestId = null
        pendingPttChannelId = null
        if (!isReady()) return
''', 'leave clear')
client = swap(client,
'''    fun emitRadioPttRequest(channelKey: String) {
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
''',
'''    fun emitRadioPttRequest(channelKey: String) {
        if (!isReady()) {
            Log.w(TAG, "[RadioError] emitRadioPttRequest: not ready state=${_connectionState.value} channelKey=$channelKey")
            return
        }
        val requestId = UUID.randomUUID().toString()
        pendingPttRequestId = requestId
        pendingPttChannelId = channelKey
        Log.d(TAG, "[FloorCtrl] SIGNALING_FLOOR_REQUEST channelKey=$channelKey unitId=$unitId requestId=$requestId deviceId=${deviceId ?: "none"}")
        socket?.emit("ptt:request", JSONObject().apply {
            put("channelId", channelKey)
            put("unitId", unitId)
            put("requestId", requestId)
            deviceId?.let { put("deviceId", it) }
        })
    }
''', 'request correlation')
client = swap(client,
'''    fun emitRadioPttRelease(channelKey: String) {
        if (!isReady()) {
''',
'''    fun emitRadioPttRelease(channelKey: String) {
        pendingPttRequestId = null
        pendingPttChannelId = null
        if (!isReady()) {
''', 'release clear')
server = swap(server,
'''    socket.emit('ptt:granted', { channelId, unitId: socket.unitId, timestamp: Date.now() });
''',
'''    socket.emit('ptt:granted', {
      channelId,
      unitId: socket.unitId,
      senderUnitId: socket.unitId,
      requestId: data.requestId || null,
      targetDeviceId: socket.deviceId || null,
      originSocketId: socket.id,
      timestamp: Date.now(),
    });
''', 'server grant correlation')
client_path.write_text(client)
server_path.write_text(server)
Path('scripts/apply_t320_ptt_origin_fix.py').unlink()
Path('.github/workflows/apply-t320-ptt-origin-fix.yml').unlink()
