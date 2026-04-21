import Foundation
import Combine
import AVFoundation
import MediaPlayer
import UIKit
import os.log

enum RadioState: String {
    case idle, requestingFloor, transmitting, receiving, channelBusy
}

@MainActor
final class RadioAudioEngine: ObservableObject {
    private let log = Logger(subsystem: "CommandComms", category: "RadioEngine")

    @Published private(set) var state: RadioState = .idle
    @Published private(set) var transportHealth: TransportHealth = .disconnected
    @Published private(set) var transmittingUnitId: String?
    @Published private(set) var lastError: String?

    let transport = UdpAudioTransport()
    let codec = OpusCodec()
    let capture = AudioCapture()
    let playback = AudioPlayback()
    private let session = AudioSessionManager()
    private let jitter = JitterBuffer(targetDepth: 3, maxDepth: 32)

    private weak var signaling: SignalingClient?
    private var subs = Set<AnyCancellable>()
    private var rxTimer: DispatchSourceTimer?
    private let rxQueue = DispatchQueue(label: "radio.rx")
    private var codecReady = false
    private var sessionReady = false
    private var nowPlayingArmed = false

    private var qualityTimer: DispatchSourceTimer?
    private let qualityQueue = DispatchQueue(label: "radio.quality")
    private var rxDecodedCount: UInt64 = 0
    private var rxPlcCount: UInt64 = 0
    private var lastQualityDecoded: UInt64 = 0
    private var lastQualityPlc: UInt64 = 0
    private var qualityIdleCycles: Int = 0
    private var lastReportedQuality: SignalQuality?
    private var lastReportTimeMs: Int64 = 0
    private var currentQuality: SignalQuality = .none

    var unitId: String = "" {
        didSet { transport.unitId = unitId }
    }
    var channelId: String = "" {
        didSet {
            // The authoritative numeric channel index is supplied by the
            // server via `radio:channelJoined`. Until that arrives we leave
            // transport.channelIndex untouched (0 by default), which causes
            // the RX channel-match check to drop packets — that's safer
            // than guessing via a hash and routing audio to the wrong
            // listeners. See handleSignalingEvent / .channelJoined below.
            if channelId != oldValue {
                transport.channelIndex = 0
                log.info("channelId set to \(self.channelId, privacy: .public); awaiting server channelIndex")
            }
            updateNowPlaying()
        }
    }

    init() {
        transport.onHealthChange = { [weak self] h in
            Task { @MainActor in self?.transportHealth = h }
        }
        transport.onPacketReceived = { [weak self] pkt in
            self?.handleRxPacket(pkt)
        }

        session.onInterruptionBegan = { [weak self] in
            Task { @MainActor in self?.handleInterruptionBegan() }
        }
        session.onShouldRestartEngines = { [weak self] in
            Task { @MainActor in self?.restartAudioEngines() }
        }
        session.onInterruptionEnded = { [weak self] shouldResume in
            // We deliberately ignore `shouldResume`: this is a radio
            // monitoring app, so RX must continue after every interruption
            // (call, Siri, alarm) regardless of whether iOS thinks audio
            // should auto-resume. The user expects to keep hearing traffic.
            _ = shouldResume
            Task { @MainActor in self?.restartAudioEngines() }
        }
    }

    func attach(signaling: SignalingClient) {
        self.signaling = signaling
        signaling.radioEvents
            .receive(on: DispatchQueue.main)
            .sink { [weak self] ev in self?.handleSignalingEvent(ev) }
            .store(in: &subs)
    }

    func configureRelay(host: String, port: Int) {
        transport.configure(host: host, port: port)
    }

    func startRadio() {
        if !codecReady {
            do {
                if !sessionReady {
                    try session.activate()
                    sessionReady = true
                }
                try codec.initialize()
                try playback.start()
                codecReady = true
            } catch {
                lastError = "Audio init failed: \(error.localizedDescription)"
                log.error("startRadio failed: \(error.localizedDescription)")
                return
            }
        }
        transport.start()
        startRxLoop()
        startQualityMonitor()
        armNowPlaying()
        updateNowPlaying()
    }

    func stopRadio() {
        stopQualityMonitor()
        stopRxLoop()
        capture.stop()
        playback.stop()
        codec.release()
        transport.stop()
        codecReady = false
        if sessionReady {
            session.deactivate()
            sessionReady = false
        }
        clearNowPlaying()
        state = .idle
        transmittingUnitId = nil
    }

    // MARK: - PTT

    func pttPressed() {
        guard !channelId.isEmpty else {
            lastError = "No channel selected"
            return
        }
        guard state == .idle || state == .receiving else { return }
        state = .requestingFloor
        signaling?.emitPttRequest(channelId: channelId)
    }

    func pttReleased() {
        if state == .transmitting {
            stopTransmit()
        }
        signaling?.emitPttRelease(channelId: channelId)
        if state == .requestingFloor {
            state = .idle
        }
    }

    private func startTransmit() {
        guard state == .requestingFloor || state == .transmitting else { return }
        state = .transmitting
        signaling?.emitTxStart(channelId: channelId)
        capture.onFrame = { [weak self] frame in
            self?.encodeAndSend(frame)
        }
        do {
            try capture.start()
        } catch {
            lastError = "Mic start failed: \(error.localizedDescription)"
            log.error("capture.start error: \(error.localizedDescription)")
            stopTransmit()
        }
        updateNowPlaying()
    }

    private func stopTransmit() {
        capture.stop()
        capture.onFrame = nil
        if state == .transmitting {
            signaling?.emitTxStop(channelId: channelId)
            state = transmittingUnitId != nil ? .receiving : .idle
        }
        updateNowPlaying()
    }

    private func encodeAndSend(_ pcm: [Int16]) {
        guard let payload = codec.encode(pcm: pcm) else { return }
        transport.sendOpusPayload(payload)
    }

    // MARK: - RX

    private func startRxLoop() {
        stopRxLoop()
        let t = DispatchSource.makeTimerSource(queue: rxQueue)
        t.schedule(deadline: .now() + 0.02, repeating: 0.02)
        t.setEventHandler { [weak self] in self?.tickRx() }
        t.resume()
        rxTimer = t
    }

    private func stopRxLoop() {
        rxTimer?.cancel()
        rxTimer = nil
        jitter.reset()
    }

    private func handleRxPacket(_ pkt: OpusRadioPacket) {
        // accept only matching channel index
        if pkt.channelIndex != transport.channelIndex { return }
        jitter.push(pkt)
    }

    private func tickRx() {
        let (pkt, plc) = jitter.pop()
        if let pkt {
            if let pcm = codec.decode(pkt.opusPayload) {
                playback.enqueue(pcm: pcm)
                qualityQueue.async { [weak self] in self?.rxDecodedCount &+= 1 }
            }
        } else if plc {
            if let pcm = codec.decode(nil) {
                playback.enqueue(pcm: pcm)
                qualityQueue.async { [weak self] in self?.rxPlcCount &+= 1 }
            }
        }
    }

    // MARK: - Signal-quality monitor

    private func startQualityMonitor() {
        stopQualityMonitor()
        qualityQueue.async { [weak self] in
            guard let self else { return }
            self.lastQualityDecoded = self.rxDecodedCount
            self.lastQualityPlc = self.rxPlcCount
            self.qualityIdleCycles = 0
            self.lastReportedQuality = nil
            self.lastReportTimeMs = 0
            self.currentQuality = .none
        }
        let t = DispatchSource.makeTimerSource(queue: qualityQueue)
        t.schedule(deadline: .now() + 1.0, repeating: 1.0)
        t.setEventHandler { [weak self] in self?.tickQuality() }
        t.resume()
        qualityTimer = t
    }

    private func stopQualityMonitor() {
        qualityTimer?.cancel()
        qualityTimer = nil
        qualityQueue.async { [weak self] in
            guard let self else { return }
            self.rxDecodedCount = 0
            self.rxPlcCount = 0
            self.lastQualityDecoded = 0
            self.lastQualityPlc = 0
            self.qualityIdleCycles = 0
            self.lastReportedQuality = nil
            self.lastReportTimeMs = 0
            self.currentQuality = .none
        }
    }

    private func tickQuality() {
        let decodedNow = rxDecodedCount
        let plcNow = rxPlcCount
        let deltaDecoded = decodedNow &- lastQualityDecoded
        let deltaPlc = plcNow &- lastQualityPlc
        lastQualityDecoded = decodedNow
        lastQualityPlc = plcNow
        let totalFrames = Int(deltaDecoded &+ deltaPlc)

        let quality: SignalQuality
        let lossPct: Double
        let jitterMs: Double
        if totalFrames < 5 {
            qualityIdleCycles += 1
            if qualityIdleCycles < 2 { return }
            quality = .none
            lossPct = 0
            jitterMs = 0
        } else {
            qualityIdleCycles = 0
            let lostFrames = Int(deltaPlc)
            lossPct = totalFrames > 0 ? Double(lostFrames) * 100.0 / Double(totalFrames) : 0.0
            jitterMs = jitter.estimatedJitterMs
            quality = SignalQuality.classify(lossPct: lossPct, jitterMs: jitterMs, framesInWindow: totalFrames)
        }
        currentQuality = quality

        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let changed = lastReportedQuality != quality
        let heartbeatDue = quality != .none && (now - lastReportTimeMs) >= 5_000
        if !changed && !heartbeatDue { return }
        lastReportedQuality = quality
        lastReportTimeMs = now

        let qStr = quality.rawValue
        Task { @MainActor [weak self] in
            guard let self else { return }
            let channel = self.channelId
            guard !channel.isEmpty, let sig = self.signaling else { return }
            sig.emitRadioSignalQuality(
                channelId: channel,
                quality: qStr,
                lossPct: lossPct,
                jitterMs: jitterMs
            )
        }
    }

    // MARK: - Audio session recovery

    private func handleInterruptionBegan() {
        // Treat the interruption like a forced PTT release so we don't keep
        // emitting TX events into the void. Playback will be paused by iOS.
        if state == .transmitting {
            stopTransmit()
        }
    }

    private func restartAudioEngines() {
        guard codecReady else { return }
        let wasTransmitting = (state == .transmitting)
        if wasTransmitting { capture.stop() }
        playback.restart()
        if wasTransmitting {
            do { try capture.start() }
            catch { log.error("capture restart failed: \(error.localizedDescription)") }
        }
    }

    // MARK: - Now Playing presence
    //
    // Registering Now Playing info (and grabbing remote-control events) gives
    // iOS an explicit signal that we are an active audio app. Combined with
    // the `audio` UIBackgroundMode and the silent keep-alive in
    // AudioPlayback, this prevents the system from suspending the engine
    // during quiet periods between transmissions.

    private func armNowPlaying() {
        guard !nowPlayingArmed else { return }
        UIApplication.shared.beginReceivingRemoteControlEvents()
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.isEnabled = false
        cc.pauseCommand.isEnabled = false
        cc.togglePlayPauseCommand.isEnabled = false
        cc.nextTrackCommand.isEnabled = false
        cc.previousTrackCommand.isEnabled = false
        nowPlayingArmed = true
    }

    private func updateNowPlaying() {
        guard nowPlayingArmed else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: channelId.isEmpty ? "Radio" : "Channel \(channelId)",
            MPMediaItemPropertyArtist: "Command Comms",
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyPlaybackRate: 1.0
        ]
        if state == .transmitting {
            info[MPMediaItemPropertyAlbumTitle] = "Transmitting"
        } else if let sender = transmittingUnitId {
            info[MPMediaItemPropertyAlbumTitle] = "Receiving \(sender)"
        } else {
            info[MPMediaItemPropertyAlbumTitle] = "Monitoring"
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func clearNowPlaying() {
        if nowPlayingArmed {
            UIApplication.shared.endReceivingRemoteControlEvents()
            nowPlayingArmed = false
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    // MARK: - Signaling

    private func handleSignalingEvent(_ event: RadioSignalingEvent) {
        switch event {
        case .channelJoined(let channel, let index):
            guard !channel.isEmpty else { return }
            guard index >= 0 else {
                log.error("channelJoined for \(channel, privacy: .public) has no channelIndex; RX will drop until server supplies one")
                return
            }
            // The server may canonicalize the channel ID (e.g. "Alpha" ->
            // "default__alpha"). Adopt the canonical key so subsequent
            // signaling events (pttGranted/txStart/...) match. Setting
            // channelId triggers didSet which zeros channelIndex; we then
            // immediately overwrite with the server's authoritative value.
            if channel != channelId {
                log.info("adopting canonical channelId from server: \(channel, privacy: .public) (was \(self.channelId, privacy: .public))")
                channelId = channel
            }
            transport.channelIndex = index
            log.info("channelIndex set from server: channel=\(channel, privacy: .public) index=\(index)")
        case .pttGranted(let channel, _):
            guard channel == channelId else { return }
            log.info("Floor granted on \(channel)")
            startTransmit()
        case .pttDenied(let channel, let reason):
            guard channel == channelId else { return }
            lastError = "PTT denied: \(reason)"
            if state == .requestingFloor {
                state = transmittingUnitId != nil ? .channelBusy : .idle
            }
        case .pttRevoked(let channel, _):
            guard channel == channelId else { return }
            if state == .transmitting { stopTransmit() }
            state = .idle
        case .txStart(let sender, let channel):
            guard channel == channelId else { return }
            transmittingUnitId = sender
            if state != .transmitting { state = .receiving }
            updateNowPlaying()
        case .txStop(let sender, let channel):
            guard channel == channelId else { return }
            if transmittingUnitId == sender { transmittingUnitId = nil }
            if state == .receiving { state = .idle }
            updateNowPlaying()
        case .channelBusy(let channel, let heldBy):
            guard channel == channelId else { return }
            transmittingUnitId = heldBy
            if state != .transmitting { state = .channelBusy }
            updateNowPlaying()
        case .channelIdle(let channel):
            guard channel == channelId else { return }
            transmittingUnitId = nil
            if state == .channelBusy || state == .receiving { state = .idle }
            updateNowPlaying()
        }
    }
}
