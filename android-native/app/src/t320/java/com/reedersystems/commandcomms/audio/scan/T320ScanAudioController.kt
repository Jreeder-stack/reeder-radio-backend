package com.reedersystems.commandcomms.audio.scan

import android.content.Context
import android.content.SharedPreferences
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import com.reedersystems.commandcomms.CommandCommsApp
import com.reedersystems.commandcomms.KeyAction
import com.reedersystems.commandcomms.audio.radio.AudioPlayback
import com.reedersystems.commandcomms.audio.radio.JitterBuffer
import com.reedersystems.commandcomms.audio.radio.OpusCodec
import com.reedersystems.commandcomms.audio.radio.OpusRadioPacket
import com.reedersystems.commandcomms.audio.radio.RadioState
import com.reedersystems.commandcomms.audio.radio.UdpAudioTransport
import com.reedersystems.commandcomms.data.model.Channel
import com.reedersystems.commandcomms.data.prefs.ServiceConnectionPrefs
import com.reedersystems.commandcomms.signaling.ConnectionState
import com.reedersystems.commandcomms.signaling.SignalingEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap

/**
 * Real multi-channel scan receiver for the T320 flavor.
 *
 * The normal [com.reedersystems.commandcomms.audio.BackgroundAudioService]
 * remains the sole owner of the selected channel and all transmit behavior.
 * This controller creates a receive-only UDP endpoint for enabled scan-list
 * channels, joins those channels on the existing authenticated signaling
 * socket, and plays exactly one scanned transmission at a time. The selected
 * channel always has priority and immediately suppresses scanned audio.
 */
class T320ScanAudioController(private val app: CommandCommsApp) :
    SharedPreferences.OnSharedPreferenceChangeListener {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val syncMutex = Mutex()
    private val playbackLock = Any()

    private val scanPrefs = app.getSharedPreferences(SCAN_PREFS_NAME, Context.MODE_PRIVATE)
    private val servicePrefs = app.getSharedPreferences(
        ServiceConnectionPrefs.PREFS_NAME,
        Context.MODE_PRIVATE
    )
    private val audioManager = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private val transport = UdpAudioTransport()
    private val channelsById = ConcurrentHashMap<Int, Channel>()
    private val channelsByRoomKey = ConcurrentHashMap<String, Channel>()
    private val joinedScanRooms = ConcurrentHashMap<String, Int>()

    @Volatile private var transportStarted = false
    @Volatile private var started = false
    @Volatile private var activeScanChannelId: Int? = null
    @Volatile private var activeScanRoomKey: String? = null
    @Volatile private var activeScanUnitId: String? = null
    @Volatile private var lastScanPacketAtMs = 0L
    @Volatile private var channelCacheLoadedAtMs = 0L

    private var jitterBuffer: JitterBuffer? = null
    private var codec: OpusCodec? = null
    private var playback: AudioPlayback? = null
    private var syncJob: Job? = null
    private var stopPlaybackJob: Job? = null

    private var scanRouteOwned = false
    private var previousAudioMode = AudioManager.MODE_NORMAL
    private var previousSpeakerphoneOn = false
    private var previousCommunicationDevice: AudioDeviceInfo? = null

    fun start() {
        if (started) return
        started = true

        scanPrefs.registerOnSharedPreferenceChangeListener(this)
        servicePrefs.registerOnSharedPreferenceChangeListener(this)
        transport.onPacketReceived = ::onScanPacket

        observeSignalingConnection()
        observeSignalingEvents()
        observeHardwareKeys()
        observeSelectedChannelState()
        startHealingLoop()
        scheduleSync("startup", forceChannelRefresh = true)

        Log.d(TAG, "T320 scan controller started")
    }

    override fun onSharedPreferenceChanged(sharedPreferences: SharedPreferences?, key: String?) {
        val forceRefresh = sharedPreferences === scanPrefs && key?.startsWith(SCAN_CHANNEL_PREFIX) == true
        scheduleSync("prefs:${key ?: "unknown"}", forceChannelRefresh = forceRefresh)
    }

    private fun observeSignalingConnection() {
        scope.launch {
            app.signalingRepository.connectionState.collectLatest { state ->
                when (state) {
                    ConnectionState.AUTHENTICATED -> scheduleSync("signaling_authenticated")
                    ConnectionState.DISCONNECTED -> {
                        syncMutex.withLock { joinedScanRooms.clear() }
                        stopScanPlayback("signaling_disconnected", restoreRoute = true)
                    }
                    else -> Unit
                }
            }
        }
    }

    private fun observeSignalingEvents() {
        scope.launch {
            app.signalingRepository.events.collect { event ->
                when (event) {
                    is SignalingEvent.RadioTxStart -> onTransmissionStarted(
                        event.channelId,
                        event.senderUnitId
                    )
                    is SignalingEvent.PttStart -> onTransmissionStarted(
                        event.channelId,
                        event.unitId
                    )
                    is SignalingEvent.RadioTxStop -> onTransmissionEnded(
                        event.channelId,
                        event.senderUnitId
                    )
                    is SignalingEvent.PttEnd -> onTransmissionEnded(
                        event.channelId,
                        event.unitId
                    )
                    is SignalingEvent.RadioChannelIdle -> onChannelIdle(event.channelId)
                    else -> Unit
                }
            }
        }
    }

    private fun observeHardwareKeys() {
        scope.launch {
            app.keyEventFlow.collect { action ->
                if (action is KeyAction.PttDown) {
                    stopScanPlayback("local_ptt_down", restoreRoute = false)
                }
            }
        }
    }

    private fun observeSelectedChannelState() {
        val manager = app.radioStateManager ?: return
        scope.launch {
            manager.state.collectLatest { state ->
                if (state != RadioState.IDLE) {
                    // The selected channel and local PTT always win. Do not restore
                    // the global communication route here; the main radio service
                    // is taking ownership of it for the priority traffic.
                    stopScanPlayback("selected_priority:$state", restoreRoute = false)
                }
            }
        }
    }

    private fun startHealingLoop() {
        scope.launch {
            while (isActive) {
                delay(5_000L)
                scheduleSync("healing_loop")
                val active = activeScanChannelId
                if (active != null && System.currentTimeMillis() - lastScanPacketAtMs > SCAN_STALE_TIMEOUT_MS) {
                    stopScanPlayback("scan_packet_timeout", restoreRoute = true)
                }
            }
        }
    }

    private fun scheduleSync(reason: String, forceChannelRefresh: Boolean = false) {
        syncJob?.cancel()
        syncJob = scope.launch {
            delay(SYNC_DEBOUNCE_MS)
            syncSubscriptions(reason, forceChannelRefresh)
        }
    }

    private suspend fun syncSubscriptions(reason: String, forceChannelRefresh: Boolean = false) {
        syncMutex.withLock {
            val scanning = scanPrefs.getBoolean(KEY_SCAN_ACTIVE, false)
            val selectedChannelId = selectedChannelId()
            val selectedRoomKey = selectedRoomKey()

            if (!scanning) {
                leaveUndesiredRooms(emptyMap(), selectedRoomKey)
                stopScanTransport("scan_disabled")
                stopScanPlayback("scan_disabled", restoreRoute = true)
                return
            }

            if (!refreshChannelsIfNeeded(forceChannelRefresh)) {
                Log.w(TAG, "Scan sync deferred: channel list unavailable reason=$reason")
                return
            }

            val desired = channelsById.values
                .asSequence()
                .filter { it.enabled && it.scannable }
                .filter { it.id != selectedChannelId }
                .filter { scanPrefs.getBoolean("$SCAN_CHANNEL_PREFIX${it.id}", true) }
                .sortedBy { it.id }
                .associate { it.roomKey to it.id }

            if (desired.isEmpty()) {
                leaveUndesiredRooms(emptyMap(), selectedRoomKey)
                stopScanTransport("no_enabled_scan_channels")
                stopScanPlayback("no_enabled_scan_channels", restoreRoute = true)
                return
            }

            if (!ensureTransportStarted(desired.values.first())) {
                Log.w(TAG, "Scan sync deferred: relay transport unavailable reason=$reason")
                return
            }

            if (app.signalingRepository.connectionState.value != ConnectionState.AUTHENTICATED) {
                Log.d(TAG, "Scan sync waiting for signaling auth reason=$reason")
                return
            }

            leaveUndesiredRooms(desired, selectedRoomKey)

            val newRooms = desired.filterKeys { !joinedScanRooms.containsKey(it) }
            for ((roomKey, channelId) in newRooms) {
                transport.channelId = roomKey
                transport.channelIndex = channelId
                app.signalingRepository.joinRadioChannel(
                    roomKey,
                    transport.localPort,
                    transport.localAddress
                )
                // Production signaling is behind a same-host reverse proxy, so
                // the server normally learns the real NAT endpoint from UDP.
                // Send a keepalive for every newly joined channel before moving
                // the shared scan socket to the next channel index.
                transport.activateFastKeepaliveExternal()
                delay(KEEPALIVE_REGISTRATION_GAP_MS)
                transport.activateFastKeepaliveExternal()
                delay(KEEPALIVE_REGISTRATION_GAP_MS)
                joinedScanRooms[roomKey] = channelId
                Log.d(TAG, "SCAN_SUBSCRIBED channel=$roomKey id=$channelId port=${transport.localPort}")
            }

            // One keepalive stream is enough to hold the single NAT mapping open;
            // each channel already learned this same endpoint during registration.
            desired.entries.firstOrNull()?.let { (roomKey, channelId) ->
                transport.channelId = roomKey
                transport.channelIndex = channelId
            }

            Log.d(
                TAG,
                "SCAN_SYNC_COMPLETE reason=$reason selected=$selectedChannelId desired=${desired.size} joined=${joinedScanRooms.size}"
            )
        }
    }

    private suspend fun refreshChannelsIfNeeded(force: Boolean): Boolean {
        val stale = System.currentTimeMillis() - channelCacheLoadedAtMs > CHANNEL_CACHE_TTL_MS
        if (!force && !stale && channelsById.isNotEmpty()) return true

        val result = app.channelRepository.getZones()
        val zones = result.getOrElse {
            Log.w(TAG, "Unable to refresh scan channels: ${it.message}")
            return channelsById.isNotEmpty()
        }

        channelsById.clear()
        channelsByRoomKey.clear()
        zones.flatMap { it.channels }.forEach { channel ->
            channelsById[channel.id] = channel
            channelsByRoomKey[channel.roomKey] = channel
        }
        channelCacheLoadedAtMs = System.currentTimeMillis()
        Log.d(TAG, "Scan channel cache refreshed count=${channelsById.size}")
        return channelsById.isNotEmpty()
    }

    private fun ensureTransportStarted(initialChannelId: Int): Boolean {
        val relayHost = app.serviceConnectionPrefs.relayHost?.trim().orEmpty()
        val relayPort = app.serviceConnectionPrefs.relayPort
        val unitId = app.serviceConnectionPrefs.unitId
            ?: app.sessionPrefs.unitId
            ?: return false
        if (relayHost.isBlank() || relayPort <= 0) return false

        transport.configure(relayHost, relayPort)
        transport.unitId = unitId
        transport.channelIndex = initialChannelId
        if (!transportStarted) {
            transport.start()
            transportStarted = transport.localPort != null
            if (transportStarted) {
                Log.d(TAG, "SCAN_UDP_STARTED port=${transport.localPort} relay=$relayHost:$relayPort")
            }
        }
        return transportStarted
    }

    private fun leaveUndesiredRooms(desired: Map<String, Int>, selectedRoomKey: String?) {
        val removed = joinedScanRooms.keys.filter { it !in desired }
        for (roomKey in removed) {
            joinedScanRooms.remove(roomKey)
            // Never issue leave for the currently selected room. The main radio
            // service owns that membership and subscriber endpoint.
            if (roomKey == selectedRoomKey) continue
            app.signalingRepository.leaveRadioChannel(roomKey)
            Log.d(TAG, "SCAN_UNSUBSCRIBED channel=$roomKey")
        }
    }

    private fun stopScanTransport(reason: String) {
        if (!transportStarted) return
        transport.stop()
        transportStarted = false
        Log.d(TAG, "SCAN_UDP_STOPPED reason=$reason")
    }

    private fun onTransmissionStarted(roomKey: String, unitId: String) {
        val selectedRoom = selectedRoomKey()
        if (roomKey == selectedRoom) {
            stopScanPlayback("selected_channel_started", restoreRoute = false)
            return
        }
        if (!isScanningEnabled()) return
        val channel = channelsByRoomKey[roomKey] ?: return
        if (!isChannelEnabledForScan(channel)) return
        if (selectedChannelHasPriority()) return

        val active = activeScanChannelId
        if (active == null || active == channel.id) {
            activeScanChannelId = channel.id
            activeScanRoomKey = roomKey
            activeScanUnitId = unitId
            lastScanPacketAtMs = System.currentTimeMillis()
            ensurePlaybackSession(channel.id, unitId, "signaling_start")
        }
    }

    private fun onTransmissionEnded(roomKey: String, unitId: String) {
        if (roomKey != activeScanRoomKey) return
        if (activeScanUnitId != null && unitId.isNotBlank() && activeScanUnitId != unitId) return
        schedulePlaybackStop("signaling_end")
    }

    private fun onChannelIdle(roomKey: String) {
        if (roomKey == activeScanRoomKey) schedulePlaybackStop("channel_idle")
    }

    private fun schedulePlaybackStop(reason: String) {
        stopPlaybackJob?.cancel()
        val packetSnapshot = lastScanPacketAtMs
        stopPlaybackJob = scope.launch {
            delay(SCAN_TAIL_HOLD_MS)
            if (lastScanPacketAtMs == packetSnapshot ||
                System.currentTimeMillis() - lastScanPacketAtMs >= SCAN_TAIL_HOLD_MS
            ) {
                stopScanPlayback(reason, restoreRoute = true)
            }
        }
    }

    private fun onScanPacket(packet: OpusRadioPacket) {
        if (!isScanningEnabled()) return
        if (selectedChannelHasPriority()) return

        val channel = channelsById[packet.channelIndex] ?: return
        if (!isChannelEnabledForScan(channel)) return
        if (packet.channelIndex == selectedChannelId()) return
        if (!joinedScanRooms.containsKey(channel.roomKey)) return

        val now = System.currentTimeMillis()
        val current = activeScanChannelId
        if (current != null && current != packet.channelIndex) {
            // First active scanned channel wins until it ends or becomes stale.
            if (now - lastScanPacketAtMs <= SCAN_STALE_TIMEOUT_MS) return
            stopScanPlayback("scan_channel_switch", restoreRoute = false)
        }

        activeScanChannelId = packet.channelIndex
        activeScanRoomKey = channel.roomKey
        activeScanUnitId = packet.senderUnitId
        lastScanPacketAtMs = now
        stopPlaybackJob?.cancel()

        ensurePlaybackSession(packet.channelIndex, packet.senderUnitId, "udp_packet")
        jitterBuffer?.enqueue(packet.sequence, packet.opusPayload)
    }

    private fun ensurePlaybackSession(channelId: Int, unitId: String, reason: String) {
        synchronized(playbackLock) {
            if (playback != null && jitterBuffer != null && codec != null) return
            if (selectedChannelHasPriority()) return

            val newCodec = OpusCodec().apply { initialize() }
            val newJitter = JitterBuffer().apply { start() }
            val newPlayback = AudioPlayback(newJitter, newCodec, app.speakerBoostPrefs)

            applyScanAudioRoute()
            newPlayback.start()

            codec = newCodec
            jitterBuffer = newJitter
            playback = newPlayback
            Log.d(TAG, "SCAN_AUDIO_STARTED channelId=$channelId unit=$unitId reason=$reason")
        }
    }

    private fun stopScanPlayback(reason: String, restoreRoute: Boolean) {
        synchronized(playbackLock) {
            stopPlaybackJob?.cancel()
            stopPlaybackJob = null

            val oldPlayback = playback
            val oldJitter = jitterBuffer
            val oldCodec = codec
            playback = null
            jitterBuffer = null
            codec = null

            try { oldJitter?.flushAndEnterIdle() } catch (_: Exception) {}
            try { oldJitter?.stop() } catch (_: Exception) {}
            try { oldPlayback?.release() } catch (e: Exception) {
                Log.w(TAG, "Scan AudioPlayback release failed: ${e.message}")
            }
            try { oldCodec?.release() } catch (e: Exception) {
                Log.w(TAG, "Scan OpusCodec release failed: ${e.message}")
            }

            if (restoreRoute) releaseScanAudioRoute()
            else relinquishScanAudioRoute()

            if (activeScanChannelId != null || oldPlayback != null) {
                Log.d(
                    TAG,
                    "SCAN_AUDIO_STOPPED channelId=$activeScanChannelId unit=$activeScanUnitId reason=$reason"
                )
            }
            activeScanChannelId = null
            activeScanRoomKey = null
            activeScanUnitId = null
            lastScanPacketAtMs = 0L
        }
    }

    private fun selectedChannelHasPriority(): Boolean =
        app.radioStateManager?.currentState?.let { it != RadioState.IDLE } ?: false

    private fun isScanningEnabled(): Boolean = scanPrefs.getBoolean(KEY_SCAN_ACTIVE, false)

    private fun isChannelEnabledForScan(channel: Channel): Boolean =
        channel.enabled &&
            channel.scannable &&
            channel.id != selectedChannelId() &&
            scanPrefs.getBoolean("$SCAN_CHANNEL_PREFIX${channel.id}", true)

    private fun selectedChannelId(): Int =
        servicePrefs.getInt(KEY_SELECTED_CHANNEL_ID, app.serviceConnectionPrefs.channelId)

    private fun selectedRoomKey(): String? =
        servicePrefs.getString(KEY_SELECTED_ROOM_KEY, app.serviceConnectionPrefs.channelRoomKey)

    private fun applyScanAudioRoute() {
        if (scanRouteOwned) return
        previousAudioMode = audioManager.mode
        previousCommunicationDevice = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.communicationDevice
        } else null
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            @Suppress("DEPRECATION")
            previousSpeakerphoneOn = audioManager.isSpeakerphoneOn
        }

        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        val wired = findWiredOutputDevice()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val target = wired ?: audioManager.availableCommunicationDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            }
            if (target != null) audioManager.setCommunicationDevice(target)
        } else {
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = wired == null
        }
        scanRouteOwned = true
        Log.d(TAG, "SCAN_AUDIO_ROUTE_APPLIED wired=${wired?.type ?: "none"}")
    }

    private fun releaseScanAudioRoute() {
        if (!scanRouteOwned) return
        // If priority traffic started while scan was stopping, the main service
        // owns the route now and will restore it at the proper time.
        if (selectedChannelHasPriority()) {
            relinquishScanAudioRoute()
            return
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val previous = previousCommunicationDevice
                if (previous != null) audioManager.setCommunicationDevice(previous)
                else audioManager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = previousSpeakerphoneOn
            }
            audioManager.mode = previousAudioMode
        } catch (e: Exception) {
            Log.w(TAG, "SCAN_AUDIO_ROUTE_RESTORE_FAILED: ${e.message}")
        } finally {
            scanRouteOwned = false
            previousCommunicationDevice = null
        }
    }

    private fun relinquishScanAudioRoute() {
        scanRouteOwned = false
        previousCommunicationDevice = null
    }

    private fun findWiredOutputDevice(): AudioDeviceInfo? {
        val wiredTypes = setOf(
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_USB_DEVICE
        )
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.availableCommunicationDevices.firstOrNull { it.type in wiredTypes }
        } else {
            audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                .firstOrNull { it.type in wiredTypes }
        }
    }

    companion object {
        private const val TAG = "[T320Scan]"
        private const val SCAN_PREFS_NAME = "ScanPrefs"
        private const val KEY_SCAN_ACTIVE = "scan_active"
        private const val SCAN_CHANNEL_PREFIX = "scan_"
        private const val KEY_SELECTED_CHANNEL_ID = "channel_id"
        private const val KEY_SELECTED_ROOM_KEY = "channel_room_key"

        private const val SYNC_DEBOUNCE_MS = 250L
        private const val KEEPALIVE_REGISTRATION_GAP_MS = 150L
        private const val CHANNEL_CACHE_TTL_MS = 60_000L
        private const val SCAN_TAIL_HOLD_MS = 300L
        private const val SCAN_STALE_TIMEOUT_MS = 900L
    }
}
