package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

private const val TAG = "[UdpTransport]"
private const val DEFAULT_RELAY_PORT = 5100
private const val RECEIVE_BUFFER_SIZE = 4096
private const val RECEIVE_TIMEOUT_MS = 100
private const val RADIO_HEADER_FIXED_LEN = 1 + 1 + 2 + 2 + 4 + 1 + 2
private const val PACKET_VERSION: Byte = 1
private const val FLAG_FEC_HINT = 0x01
private const val KEEPALIVE_INTERVAL_MS = 8_000L
private const val KEEPALIVE_FAST_INTERVAL_MS = 3_000L
private const val KEEPALIVE_FAST_DURATION_MS = 30_000L
private const val MAX_RECEIVE_RECONNECT_ATTEMPTS = 5

enum class TransportHealth { CONNECTED, RECONNECTING, DISCONNECTED }

data class OpusRadioPacket(
    val channelIndex: Int,
    val senderUnitId: String,
    val sequence: Int,
    val timestampMs: Long,
    val flags: Int,
    val opusPayload: ByteArray
)

class UdpAudioTransport(
    private var relayHost: String = "",
    private var relayPort: Int = DEFAULT_RELAY_PORT
) {

    private var socket: DatagramSocket? = null
    private var receiveJob: Job? = null
    private var sendJob: Job? = null
    private var keepaliveJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var sequenceNumber: Int = 0
    @Volatile
    var rxPacketCount: Long = 0
        private set

    @Volatile
    private var cachedAddress: InetAddress? = null
    private var cachedHost: String = ""

    private val _connectionHealth = MutableStateFlow(TransportHealth.DISCONNECTED)
    val connectionHealth: StateFlow<TransportHealth> = _connectionHealth.asStateFlow()

    @Volatile
    private var fastKeepaliveUntilMs: Long = 0L

    private val rxSeqTracker = mutableMapOf<String, Int>()
    private val SEQ_GAP_THRESHOLD = 3

    var channelId: String = ""
    var channelIndex: Int = 0
    var unitId: String = ""
    var onPacketReceived: ((packet: OpusRadioPacket) -> Unit)? = null
    val localPort: Int?
        get() = socket?.localPort

    private val txRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)
    private val rxRateLimiter = RadioDiagLog.RateLimiter(detailCount = 5)

    fun resetTxDetailLogging() {
        txRateLimiter.reset()
    }
    private var txSummaryBytes: Long = 0
    private var txFailures: Long = 0
    private var rxSummaryBytes: Long = 0
    private var rxDropped: Long = 0
    @Volatile
    var txPacketCount: Long = 0
        private set

    fun configure(host: String, port: Int) {
        this.relayHost = host
        this.relayPort = port
        if (host != cachedHost) {
            cachedAddress = null
            cachedHost = ""
        }
        Log.d(TAG, "Configured relay: $host:$port ${RadioDiagLog.elapsedTag()}")
    }

    fun resetCounters() {
        sequenceNumber = 0
        rxPacketCount = 0
        txPacketCount = 0
        txRateLimiter.reset(); rxRateLimiter.reset()
        txSummaryBytes = 0; txFailures = 0; rxSummaryBytes = 0; rxDropped = 0
        rxSeqTracker.clear()
        Log.d(TAG, "COUNTERS_RESET ${RadioDiagLog.elapsedTag()}")
        sendImmediateKeepalive()
    }

    private fun sendImmediateKeepalive() {
        val sock = socket ?: return
        scope.launch {
            try {
                val keepalivePacket = buildKeepalivePacket()
                val address = resolveAddress() ?: return@launch
                val dgram = DatagramPacket(keepalivePacket, keepalivePacket.size, address, relayPort)
                sock.send(dgram)
                Log.d(TAG, "UDP_KEEPALIVE_IMMEDIATE_SENT to=$relayHost:$relayPort ${RadioDiagLog.elapsedTag()}")
            } catch (e: Exception) {
                Log.w("[RadioError]", "UDP immediate keepalive send error: ${e::class.simpleName}: ${e.message} dest=$relayHost:$relayPort method=sendImmediateKeepalive")
            }
        }
    }

    fun start() {
        if (socket != null) {
            Log.w(TAG, "start() called but socket already open — ignoring")
            return
        }
        try {
            val sock = DatagramSocket()
            sock.soTimeout = RECEIVE_TIMEOUT_MS
            socket = sock
            _connectionHealth.value = TransportHealth.CONNECTED
            Log.d(TAG, """{"event":"UDP_SOCKET_OPENED","localPort":${sock.localPort},"timeoutMs":$RECEIVE_TIMEOUT_MS}""")
            startReceiveLoop()
            startSendLoop()
            startKeepaliveLoop()
        } catch (e: Exception) {
            _connectionHealth.value = TransportHealth.DISCONNECTED
            Log.e("[RadioError]", "Failed to open UDP socket: ${e::class.simpleName}: ${e.message} method=start", e)
        }
    }

    fun stop() {
        keepaliveJob?.cancel()
        keepaliveJob = null
        receiveJob?.cancel()
        receiveJob = null
        sendJob?.cancel()
        sendJob = null
        socket?.close()
        socket = null
        sequenceNumber = 0
        cachedAddress = null
        cachedHost = ""
        _connectionHealth.value = TransportHealth.DISCONNECTED
        fastKeepaliveUntilMs = 0L
        rxSeqTracker.clear()
        Log.d(TAG, "UDP transport stopped txTotal=$txPacketCount rxTotal=$rxPacketCount txFailures=$txFailures rxDropped=$rxDropped ${RadioDiagLog.elapsedTag()}")
        rxPacketCount = 0
        txPacketCount = 0
    }

    private fun activateFastKeepalive() {
        fastKeepaliveUntilMs = System.currentTimeMillis() + KEEPALIVE_FAST_DURATION_MS
        Log.d(TAG, """{"event":"FAST_KEEPALIVE_ACTIVATED","durationMs":$KEEPALIVE_FAST_DURATION_MS}""")
    }

    private fun recreateSocket(): DatagramSocket? {
        return try {
            socket?.close()
            val sock = DatagramSocket()
            sock.soTimeout = RECEIVE_TIMEOUT_MS
            socket = sock
            cachedAddress = null
            cachedHost = ""
            Log.d(TAG, """{"event":"SOCKET_RECREATED","localPort":${sock.localPort}}""")
            sock
        } catch (e: Exception) {
            Log.e("[RadioError]", """{"event":"SOCKET_RECREATE_FAILED","error":"${e::class.simpleName}","message":"${e.message}"}""")
            null
        }
    }

    private data class QueuedPacket(val framed: ByteArray, val payloadBytes: Int)

    private val sendPacketQueue = Channel<QueuedPacket>(capacity = 64)

    fun send(data: ByteArray) {
        if (relayHost.isBlank()) {
            Log.w("[RadioError]", "Cannot send — relay host not configured method=send")
            return
        }
        val payloadBytes = data.size
        val framed = framePacket(data)
        sendPacketQueue.trySend(QueuedPacket(framed, payloadBytes))
    }

    private fun startSendLoop() {
        sendJob = scope.launch {
            try {
                for (qp in sendPacketQueue) {
                    val sock = socket ?: break
                    val framed = qp.framed
                    try {
                        val address = resolveAddress()
                        if (address != null) {
                            val packet = DatagramPacket(framed, framed.size, address, relayPort)
                            sock.send(packet)
                            txPacketCount++
                            txSummaryBytes += framed.size

                            txRateLimiter.tick()
                            if (txRateLimiter.shouldLogDetail()) {
                                Log.d(TAG, "TX_PACKET seq=${sequenceNumber - 1} payloadBytes=${qp.payloadBytes} framedBytes=${framed.size} dest=$relayHost:$relayPort channelIdx=$channelIndex ${RadioDiagLog.elapsedTag()}")
                            } else if (txRateLimiter.shouldLogSummary()) {
                                val cnt = txRateLimiter.resetSummaryAccumulator()
                                Log.d(TAG, "TX_SUMMARY packets=$cnt totalPkts=$txPacketCount totalBytes=$txSummaryBytes failures=$txFailures dest=$relayHost:$relayPort ${RadioDiagLog.elapsedTag()}")
                            }
                        } else {
                            txFailures++
                            Log.w("[RadioError]", "TX_SEND_FAILED reason=dns_resolve_failed host=$relayHost method=sendLoop")
                        }
                    } catch (e: Exception) {
                        txFailures++
                        Log.w("[RadioError]", "UDP send error: ${e::class.simpleName}: ${e.message} dest=$relayHost:$relayPort method=sendLoop")
                    }
                }
            } catch (e: Exception) {
                Log.e("[RadioError]", "SEND_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=sendLoop", e)
            }
        }
    }

    private fun resolveAddress(): InetAddress? {
        val host = relayHost
        if (host == cachedHost && cachedAddress != null) {
            return cachedAddress
        }
        return try {
            val addr = InetAddress.getByName(host)
            cachedAddress = addr
            cachedHost = host
            addr
        } catch (e: Exception) {
            Log.w("[RadioError]", "DNS resolve failed for $host: ${e::class.simpleName}: ${e.message} method=resolveAddress")
            null
        }
    }

    private fun framePacket(audioData: ByteArray): ByteArray {
        val seq = sequenceNumber++
        val senderBytes = unitId.toByteArray(Charsets.UTF_8)
        val senderLen = senderBytes.size.coerceAtMost(255)
        val channelNumeric = channelIndex
        val timestampMs = (System.currentTimeMillis() and 0xFFFFFFFFL).toInt()
        val frame = ByteArray(RADIO_HEADER_FIXED_LEN + senderLen + audioData.size)
        var offset = 0
        frame[offset++] = PACKET_VERSION
        frame[offset++] = FLAG_FEC_HINT.toByte()
        frame[offset++] = ((channelNumeric shr 8) and 0xFF).toByte()
        frame[offset++] = (channelNumeric and 0xFF).toByte()
        frame[offset++] = ((seq shr 8) and 0xFF).toByte()
        frame[offset++] = (seq and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 24) and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 16) and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 8) and 0xFF).toByte()
        frame[offset++] = (timestampMs and 0xFF).toByte()
        frame[offset++] = senderLen.toByte()
        System.arraycopy(senderBytes, 0, frame, offset, senderLen)
        offset += senderLen
        frame[offset++] = ((audioData.size shr 8) and 0xFF).toByte()
        frame[offset++] = (audioData.size and 0xFF).toByte()
        System.arraycopy(audioData, 0, frame, offset, audioData.size)
        return frame
    }

    private fun startReceiveLoop() {
        receiveJob = scope.launch {
            val buffer = ByteArray(RECEIVE_BUFFER_SIZE)
            var consecutiveErrors = 0
            var reconnectAttempts = 0
            try {
                while (isActive) {
                    val sock = socket ?: break
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        sock.receive(packet)
                        val parsed = parseRelayPacket(buffer, packet.length)
                        consecutiveErrors = 0
                        reconnectAttempts = 0
                        if (_connectionHealth.value != TransportHealth.CONNECTED) {
                            _connectionHealth.value = TransportHealth.CONNECTED
                        }
                        if (parsed != null) {
                            if (parsed.senderUnitId == unitId) {
                                Log.d(TAG, "SELF_AUDIO_SUPPRESSED senderUnitId=${parsed.senderUnitId} seq=${parsed.sequence}")
                            } else {
                                rxPacketCount++
                                rxSummaryBytes += packet.length

                                val lastSeq = rxSeqTracker[parsed.senderUnitId]
                                rxSeqTracker[parsed.senderUnitId] = parsed.sequence
                                if (lastSeq != null) {
                                    val gap = parsed.sequence - lastSeq
                                    if (gap > SEQ_GAP_THRESHOLD) {
                                        Log.w(TAG, """{"event":"RX_SEQ_GAP","sender":"${parsed.senderUnitId}","expected":${lastSeq + 1},"got":${parsed.sequence},"gap":$gap}""")
                                        activateFastKeepalive()
                                    }
                                }

                                val channelMatch = parsed.channelIndex == channelIndex
                                val acceptReason = if (channelMatch) "channel_match" else "forwarded"

                                rxRateLimiter.tick()
                                if (rxRateLimiter.shouldLogDetail()) {
                                    Log.d(TAG, "RX_PACKET seq=${parsed.sequence} sender=${parsed.senderUnitId} payload=${parsed.opusPayload.size} ch=${parsed.channelIndex} localCh=$channelIndex channelMatch=$channelMatch accept=$acceptReason ${RadioDiagLog.elapsedTag()}")
                                } else if (rxRateLimiter.shouldLogSummary()) {
                                    val cnt = rxRateLimiter.resetSummaryAccumulator()
                                    Log.d(TAG, "RX_SUMMARY packets=$cnt totalPkts=$rxPacketCount totalBytes=$rxSummaryBytes dropped=$rxDropped ${RadioDiagLog.elapsedTag()}")
                                }

                                onPacketReceived?.invoke(parsed)
                            }
                        } else {
                            rxDropped++
                            if (packet.length > 0) {
                                Log.w(TAG, "RX_PARSE_FAILED packetLen=${packet.length} — dropped")
                            }
                        }
                    } catch (e: java.net.SocketTimeoutException) {
                    } catch (e: java.net.SocketException) {
                        if (!isActive) break
                        reconnectAttempts++
                        if (reconnectAttempts > MAX_RECEIVE_RECONNECT_ATTEMPTS) {
                            Log.e("[RadioError]", """{"event":"RECEIVE_LOOP_RECONNECT_EXHAUSTED","attempts":$reconnectAttempts}""")
                            _connectionHealth.value = TransportHealth.DISCONNECTED
                            break
                        }
                        _connectionHealth.value = TransportHealth.RECONNECTING
                        val backoffMs = 500L * (1L shl (reconnectAttempts - 1).coerceAtMost(4))
                        Log.w(TAG, """{"event":"RECEIVE_LOOP_RECONNECTING","attempt":$reconnectAttempts,"backoffMs":$backoffMs,"error":"${e.message}"}""")
                        delay(backoffMs)
                        val newSock = recreateSocket()
                        if (newSock != null) {
                            activateFastKeepalive()
                            sendImmediateKeepalive()
                            Log.d(TAG, """{"event":"RECEIVE_LOOP_SOCKET_RECOVERED","attempt":$reconnectAttempts}""")
                        } else {
                            Log.e("[RadioError]", """{"event":"RECEIVE_LOOP_SOCKET_RECREATE_FAILED","attempt":$reconnectAttempts}""")
                        }
                        continue
                    } catch (e: Exception) {
                        if (isActive) {
                            consecutiveErrors++
                            Log.w("[RadioError]", "UDP receive error (transient, continuing): ${e::class.simpleName}: ${e.message} consecutiveErrors=$consecutiveErrors method=receiveLoop")
                            if (consecutiveErrors >= 10) {
                                Log.w("[RadioError]", "UDP receive: $consecutiveErrors consecutive errors, backing off 100ms method=receiveLoop")
                                delay(100)
                            } else if (consecutiveErrors >= 3) {
                                delay(20)
                            }
                        }
                        continue
                    }
                }
            } catch (e: Exception) {
                Log.e("[RadioError]", "RECEIVE_LOOP_EXCEPTION ${e::class.simpleName}: ${e.message} method=receiveLoop", e)
            }
        }
    }

    private fun startKeepaliveLoop() {
        keepaliveJob = scope.launch {
            while (isActive) {
                val now = System.currentTimeMillis()
                val isFast = now < fastKeepaliveUntilMs
                val interval = if (isFast) KEEPALIVE_FAST_INTERVAL_MS else KEEPALIVE_INTERVAL_MS
                delay(interval)
                val sock = socket ?: break
                try {
                    val keepalivePacket = buildKeepalivePacket()
                    val address = resolveAddress() ?: continue
                    val dgram = DatagramPacket(keepalivePacket, keepalivePacket.size, address, relayPort)
                    sock.send(dgram)
                    Log.d(TAG, """{"event":"UDP_KEEPALIVE_SENT","dest":"$relayHost:$relayPort","fast":$isFast,"intervalMs":$interval}""")
                } catch (e: Exception) {
                    Log.w("[RadioError]", """{"event":"UDP_KEEPALIVE_FAILED","error":"${e::class.simpleName}","message":"${e.message}","dest":"$relayHost:$relayPort"}""")
                    activateFastKeepalive()
                }
            }
        }
    }

    private fun buildKeepalivePacket(): ByteArray {
        val senderBytes = unitId.toByteArray(Charsets.UTF_8)
        val senderLen = senderBytes.size.coerceAtMost(255)
        val channelNumeric = channelIndex
        val timestampMs = (System.currentTimeMillis() and 0xFFFFFFFFL).toInt()
        val frame = ByteArray(RADIO_HEADER_FIXED_LEN + senderLen)
        var offset = 0
        frame[offset++] = PACKET_VERSION
        frame[offset++] = 0
        frame[offset++] = ((channelNumeric shr 8) and 0xFF).toByte()
        frame[offset++] = (channelNumeric and 0xFF).toByte()
        frame[offset++] = 0
        frame[offset++] = 0
        frame[offset++] = ((timestampMs shr 24) and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 16) and 0xFF).toByte()
        frame[offset++] = ((timestampMs shr 8) and 0xFF).toByte()
        frame[offset++] = (timestampMs and 0xFF).toByte()
        frame[offset++] = senderLen.toByte()
        System.arraycopy(senderBytes, 0, frame, offset, senderLen)
        offset += senderLen
        frame[offset++] = 0
        frame[offset] = 0
        return frame
    }

    fun release() {
        stop()
        scope.cancel()
    }

    private fun parseRelayPacket(buffer: ByteArray, packetLength: Int): OpusRadioPacket? {
        if (packetLength < RADIO_HEADER_FIXED_LEN) return null
        var offset = 0
        val version = buffer[offset++].toInt() and 0xFF
        if (version != PACKET_VERSION.toInt()) {
            Log.w("[RadioError]", "Unsupported relay packet version=$version expected=${PACKET_VERSION.toInt()} method=parseRelayPacket")
            return null
        }
        val flags = buffer[offset++].toInt() and 0xFF
        val channelNumeric = ((buffer[offset++].toInt() and 0xFF) shl 8) or (buffer[offset++].toInt() and 0xFF)
        val sequence = ((buffer[offset++].toInt() and 0xFF) shl 8) or (buffer[offset++].toInt() and 0xFF)
        val timestampMs = ((buffer[offset++].toLong() and 0xFF) shl 24) or
            ((buffer[offset++].toLong() and 0xFF) shl 16) or
            ((buffer[offset++].toLong() and 0xFF) shl 8) or
            (buffer[offset++].toLong() and 0xFF)
        val senderLen = buffer[offset++].toInt() and 0xFF
        if (packetLength < RADIO_HEADER_FIXED_LEN + senderLen) {
            Log.w("[RadioError]", "Truncated packet: senderLen=$senderLen totalLen=$packetLength method=parseRelayPacket")
            return null
        }
        val sender = if (senderLen > 0) {
            String(buffer, offset, senderLen, Charsets.UTF_8)
        } else {
            ""
        }
        offset += senderLen
        if (packetLength < offset + 2) {
            Log.w("[RadioError]", "Truncated packet: missing payload length totalLen=$packetLength method=parseRelayPacket")
            return null
        }
        val payloadLength = ((buffer[offset++].toInt() and 0xFF) shl 8) or (buffer[offset++].toInt() and 0xFF)
        if (payloadLength <= 0 || packetLength < offset + payloadLength) {
            if (payloadLength > 0) {
                Log.w("[RadioError]", "Truncated packet: payloadLen=$payloadLength available=${packetLength - offset} method=parseRelayPacket")
            }
            return null
        }
        val payload = buffer.copyOfRange(offset, offset + payloadLength)
        return OpusRadioPacket(
            channelIndex = channelNumeric,
            senderUnitId = sender,
            sequence = sequence,
            timestampMs = timestampMs,
            flags = flags,
            opusPayload = payload
        )
    }
}
