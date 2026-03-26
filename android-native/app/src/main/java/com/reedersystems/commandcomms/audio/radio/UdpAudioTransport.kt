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
private const val CHANNEL_ID_LEN = 2
private const val SEQUENCE_LEN = 2
private const val TX_HEADER_SIZE = SESSION_TOKEN_LEN + CHANNEL_ID_LEN + SEQUENCE_LEN
private const val RX_HEADER_SIZE = CHANNEL_ID_LEN + SEQUENCE_LEN

class UdpAudioTransport(
    private var relayHost: String = "",
    private var relayPort: Int = DEFAULT_RELAY_PORT
) {

    private var socket: DatagramSocket? = null
    private var receiveJob: Job? = null
    private var sendJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var sequenceNumber: Int = 0
    private val sendQueue = Channel<ByteArray>(capacity = 64)

    // Cached DNS resolution
    @Volatile
    private var cachedAddress: InetAddress? = null
    private var cachedHost: String = ""

    var channelId: String = ""
    var unitId: String = ""
    var onPacketReceived: ((sequence: Int, data: ByteArray) -> Unit)? = null

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

    fun setSessionToken(hexToken: String) {
        sessionTokenBytes = hexStringToByteArray(hexToken)
        Log.d(TAG, "Session token set (${hexToken.length / 2} bytes)")
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
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open UDP socket: ${e.message}", e)
        }
    }

    fun stop() {
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
        val frame = ByteArray(TX_HEADER_SIZE + audioData.size)
        System.arraycopy(token, 0, frame, 0, SESSION_TOKEN_LEN)
        frame[SESSION_TOKEN_LEN] = 0
        frame[SESSION_TOKEN_LEN + 1] = 0
        frame[SESSION_TOKEN_LEN + 2] = ((seq shr 8) and 0xFF).toByte()
        frame[SESSION_TOKEN_LEN + 3] = (seq and 0xFF).toByte()
        System.arraycopy(audioData, 0, frame, TX_HEADER_SIZE, audioData.size)
        return frame
    }

    private fun startReceiveLoop() {
        receiveJob = scope.launch {
            val buffer = ByteArray(RECEIVE_BUFFER_SIZE)
            while (isActive) {
                val sock = socket ?: break
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    sock.receive(packet)
                    if (packet.length > RX_HEADER_SIZE) {
                        val seq = ((buffer[CHANNEL_ID_LEN].toInt() and 0xFF) shl 8) or
                                   (buffer[CHANNEL_ID_LEN + 1].toInt() and 0xFF)
                        val audioData = buffer.copyOfRange(RX_HEADER_SIZE, packet.length)
                        onPacketReceived?.invoke(seq, audioData)
                    }
                } catch (e: java.net.SocketTimeoutException) {
                } catch (e: Exception) {
                    if (isActive) {
                        Log.w(TAG, "UDP receive error: ${e.message}")
                    }
                    break
                }
            }
        }
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
}
