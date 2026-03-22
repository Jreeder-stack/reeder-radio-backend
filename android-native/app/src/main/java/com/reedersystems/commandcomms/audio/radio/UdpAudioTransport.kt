package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import kotlinx.coroutines.*
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

private const val TAG = "[UdpTransport]"
private const val DEFAULT_RELAY_PORT = 5600
private const val RECEIVE_BUFFER_SIZE = 4096
private const val RECEIVE_TIMEOUT_MS = 100
private const val HEADER_SIZE = 8
private const val PROTOCOL_VERSION: Byte = 1
private const val PACKET_TYPE_AUDIO: Byte = 0x01

class UdpAudioTransport(
    private var relayHost: String = "",
    private var relayPort: Int = DEFAULT_RELAY_PORT
) {

    private var socket: DatagramSocket? = null
    private var receiveJob: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var sequenceNumber: Int = 0

    var channelId: String = ""
    var unitId: String = ""
    var onPacketReceived: ((ByteArray) -> Unit)? = null

    fun configure(host: String, port: Int) {
        this.relayHost = host
        this.relayPort = port
        Log.d(TAG, "Configured relay: $host:$port")
    }

    fun start() {
        if (socket != null) return
        try {
            val sock = DatagramSocket()
            sock.soTimeout = RECEIVE_TIMEOUT_MS
            socket = sock
            Log.d(TAG, "UDP socket opened on local port ${sock.localPort}")
            startReceiveLoop()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open UDP socket: ${e.message}", e)
        }
    }

    fun stop() {
        receiveJob?.cancel()
        receiveJob = null
        socket?.close()
        socket = null
        sequenceNumber = 0
        Log.d(TAG, "UDP transport stopped")
    }

    fun send(data: ByteArray) {
        val sock = socket ?: return
        if (relayHost.isBlank()) {
            Log.w(TAG, "Cannot send — relay host not configured")
            return
        }
        scope.launch {
            try {
                val address = InetAddress.getByName(relayHost)
                val framed = framePacket(data)
                val packet = DatagramPacket(framed, framed.size, address, relayPort)
                sock.send(packet)
            } catch (e: Exception) {
                Log.w(TAG, "UDP send error: ${e.message}")
            }
        }
    }

    private fun framePacket(audioData: ByteArray): ByteArray {
        val channelHash = channelId.hashCode()
        val seq = sequenceNumber++
        val frame = ByteArray(HEADER_SIZE + audioData.size)
        frame[0] = PROTOCOL_VERSION
        frame[1] = PACKET_TYPE_AUDIO
        frame[2] = ((seq shr 8) and 0xFF).toByte()
        frame[3] = (seq and 0xFF).toByte()
        frame[4] = ((channelHash shr 24) and 0xFF).toByte()
        frame[5] = ((channelHash shr 16) and 0xFF).toByte()
        frame[6] = ((channelHash shr 8) and 0xFF).toByte()
        frame[7] = (channelHash and 0xFF).toByte()
        System.arraycopy(audioData, 0, frame, HEADER_SIZE, audioData.size)
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
                    if (packet.length > HEADER_SIZE) {
                        if (buffer[0] != PROTOCOL_VERSION || buffer[1] != PACKET_TYPE_AUDIO) {
                            Log.w(TAG, "Invalid packet header — discarding")
                            continue
                        }
                        val audioData = buffer.copyOfRange(HEADER_SIZE, packet.length)
                        onPacketReceived?.invoke(audioData)
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
}
