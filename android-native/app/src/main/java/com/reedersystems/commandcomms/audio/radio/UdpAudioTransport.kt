/**
 * UdpAudioTransport — Sends and receives encoded audio frames over UDP.
 *
 * Module boundary: This module handles network I/O only. It does not encode/decode audio
 * or manage signaling. It sends outbound Opus frames and delivers inbound frames to a
 * callback. Socket lifecycle, binding, and reconnect on network change are managed here.
 *
 * Packet format (matches backend relay):
 *   [session token (variable length bytes)] [channelId uint16 BE] [sequence uint16 BE] [Opus payload]
 *
 * The session token length is communicated out-of-band (known at construction time).
 * Both sender and receiver use the same fixed token length for framing.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketException
import java.nio.ByteBuffer
import java.nio.ByteOrder

private const val TAG = "[RadioUDP]"
private const val MAX_PACKET_SIZE = 1500
private const val RECEIVE_TIMEOUT_MS = 5000

class UdpAudioTransport(
    private val sessionToken: String,
    private val onFrameReceived: (sequenceNumber: Int, channelId: Int, opusData: ByteArray) -> Unit
) {
    private var socket: DatagramSocket? = null
    private var receiveThread: Thread? = null
    @Volatile
    private var isRunning = false
    private var remoteAddress: InetAddress? = null
    private var remotePort: Int = 0
    private var sendSequence: Int = 0

    private val tokenBytes: ByteArray = sessionToken.toByteArray(Charsets.UTF_8)

    fun bind(relayHost: String, relayPort: Int) {
        close()

        remoteAddress = InetAddress.getByName(relayHost)
        remotePort = relayPort
        sendSequence = 0

        val sock = DatagramSocket()
        sock.soTimeout = RECEIVE_TIMEOUT_MS
        sock.broadcast = false
        socket = sock
        isRunning = true

        receiveThread = Thread({
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO)
            val recvBuffer = ByteArray(MAX_PACKET_SIZE)
            val packet = DatagramPacket(recvBuffer, recvBuffer.size)
            while (isRunning) {
                try {
                    sock.receive(packet)
                    parseInboundPacket(recvBuffer, packet.length)
                } catch (_: java.net.SocketTimeoutException) {
                } catch (e: SocketException) {
                    if (isRunning) {
                        Log.w(TAG, "Socket exception: ${e.message}")
                    }
                    break
                } catch (e: Exception) {
                    Log.e(TAG, "Receive error: ${e.message}")
                }
            }
        }, "RadioUdpReceive").also { it.start() }

        Log.d(TAG, "UdpAudioTransport bound to $relayHost:$relayPort")
    }

    fun send(channelId: Int, opusData: ByteArray) {
        val sock = socket ?: return
        val addr = remoteAddress ?: return

        val headerSize = tokenBytes.size + 4
        val packetData = ByteArray(headerSize + opusData.size)
        val bb = ByteBuffer.wrap(packetData).order(ByteOrder.BIG_ENDIAN)

        bb.put(tokenBytes)
        bb.putShort(channelId.toShort())
        bb.putShort(sendSequence.toShort())
        bb.put(opusData)

        sendSequence = (sendSequence + 1) and 0xFFFF

        try {
            val packet = DatagramPacket(packetData, packetData.size, addr, remotePort)
            sock.send(packet)
        } catch (e: Exception) {
            Log.w(TAG, "Send error: ${e.message}")
        }
    }

    fun close() {
        isRunning = false
        socket?.close()
        receiveThread?.join(2000)
        receiveThread = null
        socket = null
        sendSequence = 0
        Log.d(TAG, "UdpAudioTransport closed")
    }

    fun rebind() {
        val host = remoteAddress?.hostAddress ?: return
        val port = remotePort
        close()
        bind(host, port)
    }

    private fun parseInboundPacket(data: ByteArray, length: Int) {
        val minSize = tokenBytes.size + 4
        if (length < minSize) return

        for (i in tokenBytes.indices) {
            if (data[i] != tokenBytes[i]) return
        }

        val headerStart = tokenBytes.size
        val bb = ByteBuffer.wrap(data, headerStart, 4).order(ByteOrder.BIG_ENDIAN)
        val channelId = bb.short.toInt() and 0xFFFF
        val sequenceNumber = bb.short.toInt() and 0xFFFF

        val payloadStart = headerStart + 4
        val payloadLength = length - payloadStart
        if (payloadLength <= 0) return

        val opusPayload = data.copyOfRange(payloadStart, payloadStart + payloadLength)
        onFrameReceived(sequenceNumber, channelId, opusPayload)
    }
}
