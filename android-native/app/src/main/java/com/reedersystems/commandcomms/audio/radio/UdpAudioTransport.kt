package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

private const val TAG = "[UdpTransport]"
private const val DEFAULT_RELAY_PORT = 5100
private const val RECEIVE_BUFFER_SIZE = 4096
private const val RECEIVE_TIMEOUT_MS = 100
private const val SESSION_TOKEN_LEN = 16
private const val RADIO_HEADER_FIXED_LEN = 1 + 1 + 2 + 2 + 4 + 1 + 2
private const val PACKET_VERSION: Byte = 1
private const val FLAG_FEC_HINT = 0x01
private const val KEEPALIVE_INTERVAL_MS = 15_000L

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
    private val sendQueue = Channel<ByteArray>(capacity = 64)
    @Volatile
    var rxPacketCount: Long = 0
        private set

    // Cached DNS resolution
    @Volatile
    private var cachedAddress: InetAddress? = null
    private var cachedHost: String = ""

    var channelId: String = ""
    var channelIndex: Int = 0
    var unitId: String = ""
    var onPacketReceived: ((packet: OpusRadioPacket) -> Unit)? = null
    val localPort: Int?
        get() = socket?.localPort

    @Volatile
    private var sessionTokenBytes: ByteArray? = null

    fun configure(host: String, port: Int) {
        this.relayHost = host
        this.relayPort = port
        // Invalidate cached address when host changes
        if (host != cachedHost) {
            cachedAddress = null
            cachedHost = ""
        }
        Log.d(TAG, "Configured relay: $host:$port")
    }

    var onSessionTokenChanged: (() -> Unit)? = null

    fun setSessionToken(hexToken: String) {
        val hadPreviousToken = sessionTokenBytes != null
        sequenceNumber = 0
        rxPacketCount = 0
        sessionTokenBytes = hexStringToByteArray(hexToken)
        if (hadPreviousToken) {
            Log.d(TAG, "RECONNECT_SESSION_TOKEN_SET seqReset=true rxCountReset=true previousTokenCleared=true")
        } else {
            Log.d(TAG, "LATENCY_SESSION_TOKEN_READY tokenBytes=${hexToken.length / 2}")
        }
        Log.d(TAG, "Session token set (${hexToken.length / 2} bytes)")
        if (hadPreviousToken) {
            onSessionTokenChanged?.invoke()
        }
        sendImmediateKeepalive()
    }

    private fun sendImmediateKeepalive() {
        val token = sessionTokenBytes ?: return
        val sock = socket ?: return
        scope.launch {
            try {
                val keepalivePacket = buildKeepalivePacket(token)
                val address = resolveAddress() ?: return@launch
                val dgram = DatagramPacket(keepalivePacket, keepalivePacket.size, address, relayPort)
                sock.send(dgram)
                Log.d(TAG, "UDP_KEEPALIVE_IMMEDIATE_SENT to=$relayHost:$relayPort")
            } catch (e: Exception) {
                Log.w(TAG, "UDP immediate keepalive send error: ${e.message}")
            }
        }
    }

    fun clearSessionToken() {
        sessionTokenBytes = null
        sequenceNumber = 0
    }

    fun start() {
        if (socket != null) return
        try {
            val sock = DatagramSocket()
            sock.soTimeout = RECEIVE_TIMEOUT_MS
            socket = sock
            Log.d(TAG, "UDP socket opened on local port ${sock.localPort}")
            startReceiveLoop()
            startSendLoop()
            startKeepaliveLoop()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open UDP socket: ${e.message}", e)
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
        sessionTokenBytes = null
        cachedAddress = null
        cachedHost = ""
        rxPacketCount = 0
        Log.d(TAG, "UDP transport stopped")
    }

    fun send(data: ByteArray) {
        val token = sessionTokenBytes
        if (token == null) {
            Log.w(TAG, "Cannot send — no session token")
            return
        }
        if (relayHost.isBlank()) {
            Log.w(TAG, "Cannot send — relay host not configured")
            return
        }
        val framed = framePacket(token, data)
        sendQueue.trySend(framed)
    }

    private fun startSendLoop() {
        sendJob = scope.launch {
            for (framed in sendQueue) {
                val sock = socket ?: break
                try {
                    val address = resolveAddress()
                    if (address != null) {
                        val packet = DatagramPacket(framed, framed.size, address, relayPort)
                        sock.send(packet)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "UDP send error: ${e.message}")
                }
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
            Log.w(TAG, "DNS resolve failed for $host: ${e.message}")
            null
        }
    }

    private fun framePacket(token: ByteArray, audioData: ByteArray): ByteArray {
        val seq = sequenceNumber++
        val senderBytes = unitId.toByteArray(Charsets.UTF_8)
        val senderLen = senderBytes.size.coerceAtMost(255)
        val channelNumeric = channelIndex
        val timestampMs = (System.currentTimeMillis() and 0xFFFFFFFFL).toInt()
        val frame = ByteArray(SESSION_TOKEN_LEN + RADIO_HEADER_FIXED_LEN + senderLen + audioData.size)
        System.arraycopy(token, 0, frame, 0, SESSION_TOKEN_LEN)
        var offset = SESSION_TOKEN_LEN
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
            while (isActive) {
                val sock = socket ?: break
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    sock.receive(packet)
                    val parsed = parseRelayPacket(buffer, packet.length)
                    consecutiveErrors = 0
                    if (parsed != null) {
                        if (parsed.senderUnitId == unitId) {
                            Log.d(TAG, "SELF_AUDIO_SUPPRESSED senderUnitId=${parsed.senderUnitId} seq=${parsed.sequence}")
                        } else {
                            rxPacketCount++
                            onPacketReceived?.invoke(parsed)
                        }
                    }
                } catch (e: java.net.SocketTimeoutException) {
                } catch (e: java.net.SocketException) {
                    if (isActive) {
                        Log.e(TAG, "UDP socket error (unrecoverable): ${e.message}")
                    }
                    break
                } catch (e: Exception) {
                    if (isActive) {
                        Log.w(TAG, "UDP receive error (transient, continuing): ${e.message}")
                        consecutiveErrors++
                        if (consecutiveErrors >= 10) {
                            Log.w(TAG, "UDP receive: $consecutiveErrors consecutive errors, backing off 100ms")
                            delay(100)
                        } else if (consecutiveErrors >= 3) {
                            delay(20)
                        }
                    }
                    continue
                }
            }
        }
    }

    private fun startKeepaliveLoop() {
        keepaliveJob = scope.launch {
            while (isActive) {
                delay(KEEPALIVE_INTERVAL_MS)
                val token = sessionTokenBytes ?: continue
                val sock = socket ?: break
                try {
                    val keepalivePacket = buildKeepalivePacket(token)
                    val address = resolveAddress() ?: continue
                    val dgram = DatagramPacket(keepalivePacket, keepalivePacket.size, address, relayPort)
                    sock.send(dgram)
                    Log.d(TAG, "UDP_KEEPALIVE_SENT to=$relayHost:$relayPort")
                } catch (e: Exception) {
                    Log.w(TAG, "UDP keepalive send error: ${e.message}")
                }
            }
        }
    }

    private fun buildKeepalivePacket(token: ByteArray): ByteArray {
        val senderBytes = unitId.toByteArray(Charsets.UTF_8)
        val senderLen = senderBytes.size.coerceAtMost(255)
        val channelNumeric = channelIndex
        val timestampMs = (System.currentTimeMillis() and 0xFFFFFFFFL).toInt()
        val frame = ByteArray(SESSION_TOKEN_LEN + RADIO_HEADER_FIXED_LEN + senderLen)
        System.arraycopy(token, 0, frame, 0, SESSION_TOKEN_LEN)
        var offset = SESSION_TOKEN_LEN
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

    private fun hexStringToByteArray(hex: String): ByteArray {
        val len = hex.length
        val data = ByteArray(len / 2)
        var i = 0
        while (i < len) {
            data[i / 2] = ((Character.digit(hex[i], 16) shl 4) +
                    Character.digit(hex[i + 1], 16)).toByte()
            i += 2
        }
        return data
    }

    private fun parseRelayPacket(buffer: ByteArray, packetLength: Int): OpusRadioPacket? {
        if (packetLength < RADIO_HEADER_FIXED_LEN) return null
        var offset = 0
        val version = buffer[offset++].toInt() and 0xFF
        if (version != PACKET_VERSION.toInt()) {
            Log.w(TAG, "Unsupported relay packet version=$version")
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
        if (packetLength < RADIO_HEADER_FIXED_LEN + senderLen) return null
        val sender = if (senderLen > 0) {
            String(buffer, offset, senderLen, Charsets.UTF_8)
        } else {
            ""
        }
        offset += senderLen
        if (packetLength < offset + 2) return null
        val payloadLength = ((buffer[offset++].toInt() and 0xFF) shl 8) or (buffer[offset++].toInt() and 0xFF)
        if (payloadLength <= 0 || packetLength < offset + payloadLength) return null
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
