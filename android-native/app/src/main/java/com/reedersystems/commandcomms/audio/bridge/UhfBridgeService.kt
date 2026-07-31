package com.reedersystems.commandcomms.audio.bridge

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.MainActivity
import com.reedersystems.commandcomms.audio.BackgroundAudioService
import com.reedersystems.commandcomms.audio.radio.FloorControlEvent
import com.reedersystems.commandcomms.audio.radio.RadioAudioEngine
import com.reedersystems.commandcomms.audio.radio.RadioSignalingGatewayImpl
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import com.reedersystems.commandcomms.data.prefs.UhfBridgeConfig
import com.reedersystems.commandcomms.data.prefs.UhfBridgePrefs
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.ArrayDeque
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.log10
import kotlin.math.sqrt

private const val TAG = "[UhfBridge]"
private const val NOTIFICATION_CHANNEL_ID = "uhf_bridge"
private const val NOTIFICATION_ID = 1202
private const val SAMPLE_RATE = 16_000
private const val FRAME_MS = 20
private const val FRAME_SAMPLES = SAMPLE_RATE * FRAME_MS / 1_000
private const val FRAME_BYTES = FRAME_SAMPLES * 2
private const val IDLE_PREBUFFER_FRAMES = 25
private const val PENDING_PREBUFFER_FRAMES = 100
private const val LEVEL_UPDATE_INTERVAL_MS = 100L

class UhfBridgeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val app get() = application as CommandCommsApp

    private lateinit var bridgePrefs: UhfBridgePrefs
    private lateinit var servicePrefs: ServiceConnectionPrefs
    private lateinit var audioManager: AudioManager
    private lateinit var wakeLock: PowerManager.WakeLock

    @Volatile private var config = UhfBridgeConfig()
    @Volatile private var running = false
    @Volatile private var floorPending = false
    @Volatile private var txActive = false
    @Volatile private var remoteRxActive = false
    @Volatile private var channelJoined = false
    @Volatile private var signalingReady = false
    @Volatile private var cleanupComplete = false

    private var engine: RadioAudioEngine? = null
    private var gateway: RadioSignalingGatewayImpl? = null
    private var audioRecord: AudioRecord? = null
    private var captureJob: Job? = null
    private var senderJob: Job? = null
    private var signalingJob: Job? = null
    private var connectionJob: Job? = null
    private var floorJob: Job? = null

    private val txQueue = LinkedBlockingQueue<ByteArray>(250)
    private val preBuffer = ArrayDeque<ByteArray>()
    private val bridgeLock = Any()

    private var activationStartedMs = 0L
    private var lastVoiceMs = 0L
    private var txStartedMs = 0L
    private var lockoutUntilMs = 0L
    private var lastLevelUpdateMs = 0L
    private var toneGenerator: ToneGenerator? = null

    private val prefListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        config = bridgePrefs.load()
        engine?.audioPlayback?.softwareGain = config.outputGain
        Log.d(TAG, "Bridge settings reloaded: $config")
    }

    override fun onCreate() {
        super.onCreate()
        bridgePrefs = UhfBridgePrefs(applicationContext)
        servicePrefs = ServiceConnectionPrefs(applicationContext)
        config = bridgePrefs.load()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification("Bridge starting"))

        val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = powerManager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "CommandComms:UhfBridge"
        ).apply {
            setReferenceCounted(false)
            acquire()
        }

        getSharedPreferences(UhfBridgePrefs.PREFS_NAME, Context.MODE_PRIVATE)
            .registerOnSharedPreferenceChangeListener(prefListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                bridgePrefs.enabled = false
                scope.launch {
                    stopBridge(restartNormalRadio = true)
                    stopSelf()
                }
            }
            ACTION_RELOAD -> {
                config = bridgePrefs.load()
                engine?.audioPlayback?.softwareGain = config.outputGain
                if (!bridgePrefs.enabled && !running) stopSelf()
            }
            ACTION_START, null -> {
                bridgePrefs.enabled = true
                if (!running) scope.launch { startBridge() }
            }
        }
        return if (bridgePrefs.enabled) START_STICKY else START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private suspend fun startBridge() {
        if (running) return
        cleanupComplete = false
        running = true
        config = bridgePrefs.load().copy(enabled = true)
        UhfBridgeRuntime.set(
            UhfBridgeStatus(
                running = true,
                direction = UhfBridgeDirection.STARTING,
                message = "Stopping normal radio service"
            )
        )
        updateNotification("Bridge starting")

        stopNormalRadioService()
        delay(650)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            failBridge("Microphone permission is required")
            return
        }

        val wiredInput = findWiredInput()
        val wiredOutput = findWiredOutput()
        UhfBridgeRuntime.update {
            it.copy(wiredInput = wiredInput != null, wiredOutput = wiredOutput != null)
        }
        if (wiredInput == null || wiredOutput == null) {
            failBridge("Connect the Baofeng audio cable to the headset jack")
            return
        }

        val roomKey = servicePrefs.channelRoomKey
        val unitId = servicePrefs.unitId ?: app.sessionPrefs.unitId
        val relayHost = servicePrefs.relayHost
        val relayPort = servicePrefs.relayPort
        if (roomKey.isNullOrBlank() || unitId.isNullOrBlank() || relayHost.isNullOrBlank() || relayPort <= 0) {
            failBridge("Select a radio channel before starting Bridge Mode")
            return
        }

        if (!applyWiredAudioRoute(wiredOutput)) {
            failBridge("Android could not route audio through the connected headset cable")
            return
        }

        val newEngine = RadioAudioEngine(applicationContext)
        val sharedState = app.radioStateManager
        if (sharedState != null) newEngine.useSharedStateManager(sharedState)
        val newGateway = RadioSignalingGatewayImpl(app.signalingClient)
        newEngine.wireFloorControl(newGateway)
        newEngine.udpTransport.configure(relayHost, relayPort)
        newEngine.udpTransport.channelId = roomKey
        newEngine.udpTransport.channelIndex = servicePrefs.channelId
        newEngine.udpTransport.unitId = unitId
        newEngine.stateManager.activeChannelKey = roomKey
        newEngine.start()
        newEngine.startReceive()
        newEngine.audioPlayback.softwareGain = config.outputGain
        engine = newEngine
        gateway = newGateway

        observeFloorEvents(newEngine, roomKey)
        observeSignaling(roomKey, unitId)
        observeConnection(roomKey, unitId, newEngine)

        val record = createWiredAudioRecord(wiredInput)
        if (record == null) {
            failBridge("The wired headset microphone could not be opened")
            return
        }
        audioRecord = record
        record.startRecording()

        startSenderLoop(newEngine)
        startCaptureLoop(record, roomKey)

        UhfBridgeRuntime.update {
            it.copy(
                running = true,
                direction = UhfBridgeDirection.IDLE,
                wiredInput = true,
                wiredOutput = true,
                message = "Bridge ready — waiting for radio audio"
            )
        }
        updateNotification("Bridge ready")
        Log.d(TAG, "UHF bridge started channel=$roomKey unit=$unitId relay=$relayHost:$relayPort")
    }

    private fun observeConnection(roomKey: String, unitId: String, activeEngine: RadioAudioEngine) {
        connectionJob?.cancel()
        connectionJob = scope.launch {
            val client = app.signalingClient
            servicePrefs.signalingUrl?.takeIf { it.isNotBlank() }?.let { client.serverUrl = it }
            client.setRadioToken(app.radioTokenStore.getToken())
            client.deviceId = app.radioTokenStore.getRadioId()

            if (client.connectionState.value == ConnectionState.DISCONNECTED) {
                client.connect(unitId, unitId)
            }

            client.connectionState.collectLatest { state ->
                signalingReady = state == ConnectionState.AUTHENTICATED
                UhfBridgeRuntime.update { it.copy(signalingReady = signalingReady) }
                if (state == ConnectionState.AUTHENTICATED) {
                    delay(100)
                    client.emitRadioJoinChannel(
                        roomKey,
                        activeEngine.udpTransport.localPort,
                        activeEngine.udpTransport.localAddress
                    )
                    Log.d(TAG, "Bridge radio join requested room=$roomKey udpPort=${activeEngine.udpTransport.localPort}")
                } else if (state == ConnectionState.DISCONNECTED && running) {
                    channelJoined = false
                    UhfBridgeRuntime.update {
                        it.copy(channelJoined = false, message = "Reconnecting to Command Communications")
                    }
                }
            }
        }
    }

    private fun observeSignaling(roomKey: String, selfUnitId: String) {
        signalingJob?.cancel()
        signalingJob = scope.launch {
            app.signalingClient.events.collect { event ->
                when (event) {
                    is SignalingEvent.RadioChannelJoined -> if (event.channelId == roomKey) {
                        channelJoined = true
                        UhfBridgeRuntime.update {
                            it.copy(channelJoined = true, message = "Bridge ready — waiting for radio audio")
                        }
                    }
                    is SignalingEvent.RadioPttGranted -> if (event.channelId == roomKey) {
                        engine?.floorControl?.onFloorGranted(event.channelId)
                    }
                    is SignalingEvent.RadioPttDenied -> if (event.channelId == roomKey) {
                        engine?.floorControl?.onFloorDenied(event.channelId)
                    }
                    is SignalingEvent.RadioTxStart -> if (
                        event.channelId == roomKey && event.senderUnitId != selfUnitId
                    ) {
                        enterRemoteReceive(event.senderUnitId)
                    }
                    is SignalingEvent.RadioTxStop -> if (
                        event.channelId == roomKey && event.senderUnitId != selfUnitId
                    ) {
                        leaveRemoteReceive()
                    }
                    is SignalingEvent.RadioChannelBusy -> if (
                        event.channelId == roomKey && event.heldBy != selfUnitId
                    ) {
                        enterRemoteReceive(event.heldBy)
                    }
                    is SignalingEvent.RadioFloorTaken -> if (
                        event.channelId == roomKey && event.heldBy != selfUnitId
                    ) {
                        enterRemoteReceive(event.heldBy)
                    }
                    is SignalingEvent.RadioChannelIdle -> if (event.channelId == roomKey) {
                        leaveRemoteReceive()
                    }
                    is SignalingEvent.PttRevoked -> if (event.channelId == roomKey) {
                        stopRfTransmit("floor revoked")
                    }
                    is SignalingEvent.TxSilenceWarning -> if (
                        event.channelId == roomKey && event.unitId == selfUnitId
                    ) {
                        stopRfTransmit("server silence timeout")
                    }
                    else -> Unit
                }
            }
        }
    }

    private fun observeFloorEvents(activeEngine: RadioAudioEngine, roomKey: String) {
        floorJob?.cancel()
        floorJob = scope.launch {
            activeEngine.floorControl?.events?.collect { event ->
                when (event) {
                    FloorControlEvent.GRANTED -> {
                        if (!floorPending || remoteRxActive || !running) {
                            activeEngine.floorControl?.releaseFloor(roomKey)
                            return@collect
                        }
                        synchronized(bridgeLock) {
                            txActive = true
                            floorPending = false
                            txStartedMs = System.currentTimeMillis()
                            while (preBuffer.isNotEmpty()) {
                                txQueue.offer(preBuffer.removeFirst())
                            }
                        }
                        gateway?.notifyTxStart(roomKey)
                        UhfBridgeRuntime.update {
                            it.copy(
                                direction = UhfBridgeDirection.RF_TO_POC,
                                message = "Relaying UHF to PoC"
                            )
                        }
                        updateNotification("UHF → PoC")
                        Log.d(TAG, "VOX floor granted — TX active")
                    }
                    FloorControlEvent.DENIED -> {
                        synchronized(bridgeLock) {
                            floorPending = false
                            txActive = false
                            preBuffer.clear()
                            txQueue.clear()
                        }
                        enterLockout("Channel busy")
                    }
                    FloorControlEvent.RELEASED -> Unit
                }
            }
        }
    }

    private fun startCaptureLoop(record: AudioRecord, roomKey: String) {
        captureJob?.cancel()
        captureJob = scope.launch {
            val readBuffer = ByteArray(FRAME_BYTES * 4)
            val frameBuffer = ByteArray(FRAME_BYTES)
            var pendingBytes = 0

            while (isActive && running) {
                val read = try {
                    record.read(readBuffer, 0, readBuffer.size, AudioRecord.READ_BLOCKING)
                } catch (e: Exception) {
                    Log.e(TAG, "AudioRecord read failed: ${e.message}", e)
                    failBridge("Radio cable audio input stopped")
                    break
                }
                if (read <= 0) continue

                var offset = 0
                while (offset < read) {
                    val copied = minOf(FRAME_BYTES - pendingBytes, read - offset)
                    System.arraycopy(readBuffer, offset, frameBuffer, pendingBytes, copied)
                    pendingBytes += copied
                    offset += copied
                    if (pendingBytes == FRAME_BYTES) {
                        processInputFrame(frameBuffer.copyOf(), roomKey)
                        pendingBytes = 0
                    }
                }
            }
        }
    }

    private suspend fun processInputFrame(frame: ByteArray, roomKey: String) {
        val now = System.currentTimeMillis()
        val db = calculateDbfs(frame)
        if (now - lastLevelUpdateMs >= LEVEL_UPDATE_INTERVAL_MS) {
            lastLevelUpdateMs = now
            UhfBridgeRuntime.update { it.copy(inputDb = db) }
        }

        if (remoteRxActive) {
            activationStartedMs = 0L
            synchronized(bridgeLock) {
                preBuffer.clear()
            }
            return
        }

        val gainedFrame = applyGain(frame, config.inputGain)
        synchronized(bridgeLock) {
            if (txActive) {
                txQueue.offer(gainedFrame)
            } else {
                preBuffer.addLast(gainedFrame)
                val maxFrames = if (floorPending) PENDING_PREBUFFER_FRAMES else IDLE_PREBUFFER_FRAMES
                while (preBuffer.size > maxFrames) preBuffer.removeFirst()
            }
        }

        if (txActive || floorPending) {
            if (db >= config.deactivationDb) lastVoiceMs = now

            if (txActive && now - txStartedMs >= config.maximumTxMs) {
                stopRfTransmit("maximum TX timeout")
                return
            }

            val canRelease = !txActive || now - txStartedMs >= config.minimumTxMs
            if (canRelease && lastVoiceMs > 0L && now - lastVoiceMs >= config.hangMs) {
                stopRfTransmit("VOX silence")
            }
            return
        }

        if (now < lockoutUntilMs || !signalingReady || !channelJoined) {
            activationStartedMs = 0L
            return
        }

        if (db >= config.activationDb) {
            if (activationStartedMs == 0L) activationStartedMs = now
            if (now - activationStartedMs >= config.triggerMs) {
                activationStartedMs = 0L
                floorPending = true
                lastVoiceMs = now
                app.signalingClient.emitPttPre(roomKey)
                engine?.udpTransport?.activateFastKeepaliveExternal()
                engine?.floorControl?.requestFloor(roomKey)
                UhfBridgeRuntime.update {
                    it.copy(
                        direction = UhfBridgeDirection.RF_TO_POC,
                        message = "Radio detected — requesting channel"
                    )
                }
                updateNotification("Requesting PoC floor")
                Log.d(TAG, "VOX_TRIGGER db=$db activation=${config.activationDb} triggerMs=${config.triggerMs}")
            }
        } else {
            activationStartedMs = 0L
        }
    }

    private fun startSenderLoop(activeEngine: RadioAudioEngine) {
        senderJob?.cancel()
        senderJob = scope.launch {
            while (isActive && running) {
                val frame = txQueue.poll(100, TimeUnit.MILLISECONDS) ?: continue
                if (!txActive) continue
                val encoded = activeEngine.opusCodec.encode(frame)
                if (encoded != null && txActive) {
                    activeEngine.udpTransport.send(encoded)
                }
            }
        }
    }

    private suspend fun stopRfTransmit(reason: String) {
        val roomKey = servicePrefs.channelRoomKey ?: return
        val wasActive: Boolean
        val wasPending: Boolean
        synchronized(bridgeLock) {
            wasActive = txActive
            wasPending = floorPending
            txActive = false
            floorPending = false
            activationStartedMs = 0L
            lastVoiceMs = 0L
            txQueue.clear()
            preBuffer.clear()
        }
        if (wasActive) gateway?.notifyTxStop(roomKey)
        if (wasActive || wasPending) engine?.floorControl?.releaseFloor(roomKey)
        enterLockout(reason)
    }

    private fun enterRemoteReceive(senderUnitId: String) {
        if (remoteRxActive) return
        remoteRxActive = true
        scope.launch {
            if (txActive || floorPending) stopRfTransmit("incoming PoC traffic")
            activationStartedMs = 0L
            synchronized(bridgeLock) {
                preBuffer.clear()
                txQueue.clear()
            }
            playVoxLeadIn()
            UhfBridgeRuntime.update {
                it.copy(
                    direction = UhfBridgeDirection.POC_TO_RF,
                    message = "Relaying PoC to UHF — $senderUnitId"
                )
            }
            updateNotification("PoC → UHF")
        }
    }

    private fun leaveRemoteReceive() {
        if (!remoteRxActive) return
        remoteRxActive = false
        enterLockout("PoC transmission ended")
    }

    private fun enterLockout(reason: String) {
        lockoutUntilMs = System.currentTimeMillis() + config.lockoutMs
        UhfBridgeRuntime.update {
            it.copy(direction = UhfBridgeDirection.LOCKOUT, message = "$reason — lockout")
        }
        updateNotification("Bridge lockout")
        scope.launch {
            val remaining = lockoutUntilMs - System.currentTimeMillis()
            if (remaining > 0) delay(remaining)
            if (running && !remoteRxActive && !txActive && !floorPending) {
                UhfBridgeRuntime.update {
                    it.copy(direction = UhfBridgeDirection.IDLE, message = "Bridge ready — waiting for radio audio")
                }
                updateNotification("Bridge ready")
            }
        }
    }

    private fun playVoxLeadIn() {
        val duration = config.voxLeadInMs
        if (duration <= 0) return
        scope.launch(Dispatchers.Main) {
            try {
                toneGenerator?.release()
                toneGenerator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 18)
                toneGenerator?.startTone(ToneGenerator.TONE_DTMF_0, duration)
                delay(duration.toLong() + 50L)
                toneGenerator?.release()
                toneGenerator = null
            } catch (e: Exception) {
                Log.w(TAG, "VOX lead-in tone failed: ${e.message}")
            }
        }
    }

    private fun createWiredAudioRecord(input: AudioDeviceInfo): AudioRecord? {
        val minimum = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minimum <= 0) return null
        val bufferBytes = maxOf(minimum, FRAME_BYTES * 8)
        val sources = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) add(MediaRecorder.AudioSource.UNPROCESSED)
            add(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            add(MediaRecorder.AudioSource.MIC)
        }

        for (source in sources.distinct()) {
            try {
                val record = AudioRecord.Builder()
                    .setAudioSource(source)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(SAMPLE_RATE)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build()
                    )
                    .setBufferSizeInBytes(bufferBytes)
                    .build()
                if (record.state == AudioRecord.STATE_INITIALIZED) {
                    record.preferredDevice = input
                    Log.d(TAG, "Bridge AudioRecord initialized source=$source inputType=${input.type}")
                    return record
                }
                record.release()
            } catch (e: Exception) {
                Log.w(TAG, "Bridge AudioRecord source=$source failed: ${e.message}")
            }
        }
        return null
    }

    private fun calculateDbfs(frame: ByteArray): Float {
        val buffer = ByteBuffer.wrap(frame).order(ByteOrder.LITTLE_ENDIAN)
        var sumSquares = 0.0
        var samples = 0
        while (buffer.remaining() >= 2) {
            val sample = buffer.short.toDouble()
            sumSquares += sample * sample
            samples++
        }
        if (samples == 0) return -90f
        val rms = sqrt(sumSquares / samples.toDouble())
        if (rms < 1.0) return -90f
        return (20.0 * log10(rms / 32768.0)).toFloat().coerceIn(-90f, 0f)
    }

    private fun applyGain(frame: ByteArray, gain: Float): ByteArray {
        if (gain == 1.0f) return frame
        val output = frame.copyOf()
        val buffer = ByteBuffer.wrap(output).order(ByteOrder.LITTLE_ENDIAN)
        var offset = 0
        while (offset + 1 < output.size) {
            val sample = buffer.getShort(offset).toInt()
            val amplified = (sample * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            buffer.putShort(offset, amplified.toShort())
            offset += 2
        }
        return output
    }

    private fun findWiredInput(): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_USB_DEVICE
        }

    private fun findWiredOutput(): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).firstOrNull {
            it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                it.type == AudioDeviceInfo.TYPE_USB_DEVICE
        }

    private fun applyWiredAudioRoute(output: AudioDeviceInfo): Boolean {
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val communicationOutput = audioManager.availableCommunicationDevices.firstOrNull {
                it.id == output.id
            } ?: audioManager.availableCommunicationDevices.firstOrNull {
                it.type == output.type
            }
            if (communicationOutput == null) {
                Log.e(TAG, "Wired output is not exposed as a communication device type=${output.type}")
                false
            } else {
                val selected = audioManager.setCommunicationDevice(communicationOutput)
                Log.d(TAG, "Wired bridge route selected outputType=${communicationOutput.type} success=$selected")
                selected
            }
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
            Log.d(TAG, "Wired bridge route selected using legacy speakerphone=false outputType=${output.type}")
            true
        }
    }

    private suspend fun stopBridge(
        restartNormalRadio: Boolean,
        preserveStatus: Boolean = false
    ) {
        if (cleanupComplete) {
            if (restartNormalRadio) startNormalRadioService()
            return
        }
        cleanupComplete = true
        running = false
        try {
            if (txActive || floorPending) stopRfTransmit("Bridge stopped")
        } catch (_: Exception) {
        }

        captureJob?.cancel()
        senderJob?.cancel()
        signalingJob?.cancel()
        connectionJob?.cancel()
        floorJob?.cancel()
        captureJob = null
        senderJob = null
        signalingJob = null
        connectionJob = null
        floorJob = null

        try { audioRecord?.stop() } catch (_: Exception) {}
        try { audioRecord?.release() } catch (_: Exception) {}
        audioRecord = null
        toneGenerator?.release()
        toneGenerator = null

        servicePrefs.channelRoomKey?.let { app.signalingClient.emitRadioLeaveChannel(it) }
        try { engine?.release() } catch (e: Exception) { Log.w(TAG, "Engine release failed: ${e.message}") }
        engine = null
        gateway = null
        txQueue.clear()
        synchronized(bridgeLock) { preBuffer.clear() }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        }
        audioManager.mode = AudioManager.MODE_NORMAL

        if (!preserveStatus) {
            UhfBridgeRuntime.reset()
            updateNotification("Bridge off")
        }
        if (restartNormalRadio) startNormalRadioService()
    }

    private suspend fun failBridge(message: String) {
        Log.e(TAG, message)
        val errorStatus = UhfBridgeStatus(
            running = false,
            direction = UhfBridgeDirection.ERROR,
            inputDb = -90f,
            wiredInput = findWiredInput() != null,
            wiredOutput = findWiredOutput() != null,
            signalingReady = signalingReady,
            channelJoined = channelJoined,
            message = message
        )
        UhfBridgeRuntime.set(errorStatus)
        bridgePrefs.enabled = false
        updateNotification("Bridge error — $message")
        stopBridge(restartNormalRadio = true, preserveStatus = true)
        UhfBridgeRuntime.set(errorStatus)
        stopSelf()
    }

    private fun stopNormalRadioService() {
        val stopIntent = Intent(this, BackgroundAudioService::class.java).apply {
            action = BackgroundAudioService.ACTION_STOP
        }
        ContextCompat.startForegroundService(this, stopIntent)
    }

    private fun startNormalRadioService() {
        try {
            ContextCompat.startForegroundService(this, Intent(this, BackgroundAudioService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "Could not restart normal radio service: ${e.message}")
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    "UHF Bridge",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Keeps the Command Communications UHF bridge running"
                    setSound(null, null)
                }
            )
        }
    }

    private fun buildNotification(status: String): Notification {
        val openIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_headset)
            .setContentTitle("Command Communications Bridge")
            .setContentText(status)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
    }

    private fun updateNotification(status: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(status))
    }

    override fun onDestroy() {
        getSharedPreferences(UhfBridgePrefs.PREFS_NAME, Context.MODE_PRIVATE)
            .unregisterOnSharedPreferenceChangeListener(prefListener)
        val preserveError = UhfBridgeRuntime.status.value.direction == UhfBridgeDirection.ERROR
        runBlocking {
            stopBridge(
                restartNormalRadio = !bridgePrefs.enabled,
                preserveStatus = preserveError
            )
        }
        if (::wakeLock.isInitialized && wakeLock.isHeld) wakeLock.release()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_START = "com.reedersystems.commandcomms.UHF_BRIDGE_START"
        const val ACTION_STOP = "com.reedersystems.commandcomms.UHF_BRIDGE_STOP"
        const val ACTION_RELOAD = "com.reedersystems.commandcomms.UHF_BRIDGE_RELOAD"
    }
}
