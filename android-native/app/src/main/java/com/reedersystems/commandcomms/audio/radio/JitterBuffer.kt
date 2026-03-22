package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import java.util.concurrent.ConcurrentLinkedQueue

private const val TAG = "[JitterBuf]"
private const val MAX_BUFFER_SIZE = 50

class JitterBuffer {

    private val buffer = ConcurrentLinkedQueue<ByteArray>()
    @Volatile
    private var running = false

    fun start() {
        running = true
        buffer.clear()
        Log.d(TAG, "JitterBuffer started")
    }

    fun stop() {
        running = false
        buffer.clear()
        Log.d(TAG, "JitterBuffer stopped")
    }

    fun enqueue(packet: ByteArray) {
        if (!running) return
        if (buffer.size >= MAX_BUFFER_SIZE) {
            buffer.poll()
            Log.w(TAG, "JitterBuffer overflow — dropped oldest packet")
        }
        buffer.offer(packet)
    }

    fun dequeue(): ByteArray? {
        if (!running) return null
        return buffer.poll()
    }

    val size: Int get() = buffer.size
    val isEmpty: Boolean get() = buffer.isEmpty()
}
