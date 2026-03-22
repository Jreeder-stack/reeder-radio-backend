/**
 * RadioAudioEngine — Top-level coordinator for the custom radio audio pipeline.
 *
 * Module boundary: This class composes all radio engine modules (AudioCapture, AudioPlayback,
 * OpusCodec, UdpAudioTransport, JitterBuffer, FloorControlManager, RadioStateManager) and
 * exposes a simple API for transmit/receive lifecycle. It does NOT replace the existing
 * PttAudioEngine or BackgroundAudioService — it is a standalone building block for the
 * future integration task.
 *
 * Floor control integration: startTransmit() requests floor via FloorControlManager.
 * Audio capture only begins when the floor is granted via the FloorControlListener callback.
 * If denied or busy, transmit is aborted. stopTransmit() releases the floor and stops
 * capture/transport.
 *
 * Network changes: Call onNetworkChanged() when connectivity changes to rebind the UDP
 * transport socket. The integration layer should wire Android ConnectivityManager callbacks
 * to this method.
 *
 * All dependencies are provided via constructor injection (including injectable factories
 * for AudioCapture, AudioPlayback, UdpAudioTransport, and JitterBuffer). The engine does
 * not create Android services, register broadcast receivers, or interact with hardware buttons.
 *
 * Hardware safety: This module does not interact with any hardware buttons, key codes,
 * scan codes, broadcast receivers, or accessibility hooks. PTT detection is handled
 * entirely outside the radio engine module boundary.
 */
package com.reedersystems.commandcomms.audio.radio

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val TAG = "[RadioEngine]"
private const val PLAYBACK_INTERVAL_MS = 20L

fun interface AudioCaptureFactory {
    fun create(sampleRate: Int, frameSizeSamples: Int, onFrame: (ShortArray) -> Unit): AudioCapture
}

fun interface AudioPlaybackFactory {
    fun create(sampleRate: Int, frameSizeSamples: Int): AudioPlayback
}

fun interface UdpTransportFactory {
    fun create(sessionToken: String, onFrameReceived: (Int, Int, ByteArray) -> Unit): UdpAudioTransport
}

fun interface JitterBufferFactory {
    fun create(): JitterBuffer
}

class RadioAudioEngine(
    private val stateManager: RadioStateManager,
    private val floorControl: FloorControlManager,
    private val codec: OpusCodec,
    private val sessionToken: String,
    private val channelIdMapper: (String) -> Int = { it.hashCode() and 0xFFFF },
    private val captureFactory: AudioCaptureFactory = AudioCaptureFactory { sr, fs, cb -> AudioCapture(sr, fs, cb) },
    private val playbackFactory: AudioPlaybackFactory = AudioPlaybackFactory { sr, fs -> AudioPlayback(sr, fs) },
    private val transportFactory: UdpTransportFactory = UdpTransportFactory { token, cb -> UdpAudioTransport(token, cb) },
    private val jitterBufferFactory: JitterBufferFactory = JitterBufferFactory { JitterBuffer() }
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var audioCapture: AudioCapture? = null
    private var audioPlayback: AudioPlayback? = null
    private var transport: UdpAudioTransport? = null
    private var jitterBuffer: JitterBuffer? = null
    private var playbackJob: Job? = null
    private var currentChannelId: String? = null
    private var relayHost: String? = null
    private var relayPort: Int = 0
    private var rxActive = false

    private val engineFloorListener = object : FloorControlListener {
        override fun onGranted(channelId: String) {
            if (channelId != currentChannelId) return
            onTransmitGranted()
        }

        override fun onDenied(channelId: String) {
            if (channelId != currentChannelId) return
            Log.w(TAG, "Floor denied for channel $channelId")
            stateManager.transitionTo(if (rxActive) RadioState.RECEIVING else RadioState.IDLE)
        }

        override fun onBusy(channelId: String, transmittingUnit: String) {
            if (channelId != currentChannelId) return
            Log.w(TAG, "Floor busy for channel $channelId (tx by $transmittingUnit)")
            stateManager.transitionTo(if (rxActive) RadioState.RECEIVING else RadioState.IDLE)
        }

        override fun onReleased(channelId: String) {
            if (channelId != currentChannelId) return
            teardownTransmitPipeline()
        }
    }

    fun init() {
        floorControl.start()
        floorControl.registerEngineListener(engineFloorListener)
    }

    fun startTransmit() {
        if (stateManager.isTransmitting() || stateManager.currentState == RadioState.REQUESTING_TX) {
            Log.w(TAG, "Already transmitting or requesting")
            return
        }
        val channelId = currentChannelId
        if (channelId == null) {
            Log.e(TAG, "Cannot transmit: no channel configured. Call setChannel() first.")
            return
        }
        floorControl.requestFloor(channelId)
        Log.d(TAG, "Floor requested for channel $channelId")
    }

    val state: StateFlow<RadioState>
        get() = stateManager.state

    fun stopTransmit() {
        val wasRequesting = stateManager.currentState == RadioState.REQUESTING_TX
        teardownTransmitPipeline()
        floorControl.releaseFloor()
        if (wasRequesting) {
            stateManager.transitionTo(if (rxActive) RadioState.RECEIVING else RadioState.IDLE)
        }
        Log.d(TAG, "Transmit stopped, floor released")
    }

    fun startReceive(relayHost: String, relayPort: Int) {
        if (rxActive) {
            Log.w(TAG, "Already receiving")
            return
        }

        this.relayHost = relayHost
        this.relayPort = relayPort

        codec.initDecoder()

        jitterBuffer = jitterBufferFactory.create()

        transport = transportFactory.create(sessionToken) { seq, ch, data ->
            handleReceivedFrame(seq, ch, data)
        }
        transport?.bind(relayHost, relayPort)

        audioPlayback = playbackFactory.create(OpusCodec.SAMPLE_RATE, OpusCodec.FRAME_SIZE)
        audioPlayback?.start()

        startPlaybackLoop()

        rxActive = true
        stateManager.transitionTo(RadioState.RECEIVING)
        Log.d(TAG, "Receive started: $relayHost:$relayPort")
    }

    fun stopReceive() {
        playbackJob?.cancel()
        playbackJob = null

        transport?.close()
        transport = null

        audioPlayback?.stop()
        audioPlayback = null

        jitterBuffer?.reset()
        jitterBuffer = null

        codec.releaseDecoder()

        rxActive = false
        if (stateManager.currentState == RadioState.RECEIVING) {
            stateManager.transitionTo(RadioState.IDLE)
        }
        Log.d(TAG, "Receive stopped")
    }

    fun setChannel(channelId: String) {
        currentChannelId = channelId
    }

    fun onNetworkChanged() {
        Log.d(TAG, "Network changed — rebinding UDP transport")
        transport?.rebind()
    }

    fun destroy() {
        stopTransmit()
        stopReceive()
        floorControl.unregisterEngineListener(engineFloorListener)
        floorControl.stop()
        scope.cancel()
        Log.d(TAG, "RadioAudioEngine destroyed")
    }

    private fun onTransmitGranted() {
        val host = relayHost
        val port = relayPort
        val channelId = currentChannelId

        if (host == null || channelId == null) {
            Log.e(TAG, "Floor granted but relay not configured")
            floorControl.releaseFloor()
            return
        }

        codec.initEncoder()

        if (transport == null) {
            transport = transportFactory.create(sessionToken) { _, _, _ -> }
            transport?.bind(host, port)
        }

        audioCapture = captureFactory.create(
            OpusCodec.SAMPLE_RATE,
            OpusCodec.FRAME_SIZE
        ) { pcmFrame -> handleCapturedFrame(pcmFrame) }
        audioCapture?.start()

        Log.d(TAG, "Transmit started on channel $channelId via $host:$port")
    }

    private fun teardownTransmitPipeline() {
        audioCapture?.stop()
        audioCapture = null

        if (!rxActive) {
            transport?.close()
            transport = null
        }

        codec.releaseEncoder()

        if (stateManager.isTransmitting()) {
            if (rxActive) {
                stateManager.transitionTo(RadioState.RECEIVING)
            } else {
                stateManager.transitionTo(RadioState.IDLE)
            }
        }
    }

    private fun handleCapturedFrame(pcmFrame: ShortArray) {
        val encoded = codec.encode(pcmFrame) ?: return
        val chId = currentChannelId ?: return
        transport?.send(channelIdMapper(chId), encoded)
    }

    private fun handleReceivedFrame(sequenceNumber: Int, channelId: Int, opusData: ByteArray) {
        val expectedChId = channelIdMapper(currentChannelId ?: return)
        if (channelId != expectedChId) return
        jitterBuffer?.push(sequenceNumber, opusData)
    }

    private fun startPlaybackLoop() {
        playbackJob?.cancel()
        playbackJob = scope.launch {
            while (isActive) {
                val frame = jitterBuffer?.pop()
                if (frame != null) {
                    val pcm = codec.decode(frame.data)
                    if (pcm != null) {
                        audioPlayback?.writePcm(pcm)
                    }
                } else if (jitterBuffer?.isReady == true) {
                    val plc = codec.decodePLC()
                    if (plc != null) {
                        audioPlayback?.writePcm(plc)
                    }
                }
                delay(PLAYBACK_INTERVAL_MS)
            }
        }
    }
}
