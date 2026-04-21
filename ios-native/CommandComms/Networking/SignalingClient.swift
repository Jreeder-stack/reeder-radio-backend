import Foundation
import Combine
import SocketIO

enum SignalingState: String {
    case disconnected
    case connecting
    case connected
    case authenticated
}

enum LocationTrackEvent {
    case start
    case stop
}

enum RadioSignalingEvent {
    case channelJoined(channelId: String, channelIndex: Int)
    case pttGranted(channelId: String, senderUnitId: String)
    case pttDenied(channelId: String, reason: String)
    case pttRevoked(channelId: String, reason: String)
    case txStart(senderUnitId: String, channelId: String)
    case txStop(senderUnitId: String, channelId: String)
    case channelBusy(channelId: String, heldBy: String)
    case channelIdle(channelId: String)
}

@MainActor
final class SignalingClient: ObservableObject {
    @Published var state: SignalingState = .disconnected
    @Published var currentChannel: String?
    @Published var lastError: String?
    @Published var isTransmitting: Bool = false
    @Published var isReceiving: Bool = false
    @Published var isFloorRequestPending: Bool = false
    @Published var lastFloorDenialReason: String?

    let locationTrackEvents = PassthroughSubject<LocationTrackEvent, Never>()

    var serverURL: String
    var sessionCookieHeader: String?

    private var manager: SocketManager?
    private var socket: SocketIOClient?
    private var unitId: String = ""
    private var username: String = ""
    private var pendingChannel: String?

    private let radioSubject = PassthroughSubject<RadioSignalingEvent, Never>()
    var radioEvents: AnyPublisher<RadioSignalingEvent, Never> {
        radioSubject.eraseToAnyPublisher()
    }

    init(serverURL: String) {
        self.serverURL = serverURL
    }

    func updateServerURL(_ url: String) {
        self.serverURL = url
    }

    func connect(unitId: String, username: String, defaultChannel: String?) {
        connect(unitId: unitId, username: username, defaultChannel: defaultChannel, sessionCookie: nil)
    }

    func connect(unitId: String, username: String, defaultChannel: String?, sessionCookie: String?) {
        self.sessionCookieHeader = sessionCookie
        guard state == .disconnected else { return }
        guard let url = URL(string: serverURL) else {
            lastError = "Invalid signaling URL"
            return
        }
        self.unitId = unitId
        self.username = username
        self.pendingChannel = defaultChannel
        self.state = .connecting
        self.lastError = nil

        var config: SocketIOClientConfiguration = [
            .path("/signaling"),
            .forceWebsockets(true),
            .reconnects(true),
            .reconnectWait(2),
            .reconnectAttempts(-1),
            .compress
        ]
        if let cookieHeader = sessionCookieHeader, !cookieHeader.isEmpty {
            config.insert(.extraHeaders(["Cookie": cookieHeader]))
        }
        let manager = SocketManager(socketURL: url, config: config)
        self.manager = manager
        let socket = manager.defaultSocket
        self.socket = socket

        socket.on(clientEvent: .connect) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.state = .connected
                self.sendAuth()
            }
        }

        socket.on(clientEvent: .disconnect) { [weak self] _, _ in
            Task { @MainActor in
                self?.state = .disconnected
            }
        }

        socket.on(clientEvent: .error) { [weak self] data, _ in
            Task { @MainActor in
                self?.lastError = "\(data.first ?? "connect error")"
            }
        }

        socket.on("authenticated") { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                self.state = .authenticated
                if let channel = self.pendingChannel, !channel.isEmpty {
                    self.joinChannel(channel)
                }
            }
        }

        socket.on("unauthorized") { [weak self] data, _ in
            Task { @MainActor in
                self?.state = .disconnected
                self?.lastError = "unauthorized: \(data.first ?? "")"
            }
        }

        socket.on("auth:error") { [weak self] data, _ in
            Task { @MainActor in
                self?.state = .disconnected
                self?.lastError = "auth:error: \(data.first ?? "")"
            }
        }

        socket.on("location:track_start") { [weak self] _, _ in
            Task { @MainActor in
                self?.locationTrackEvents.send(.start)
            }
        }

        socket.on("location:track_stop") { [weak self] _, _ in
            Task { @MainActor in
                self?.locationTrackEvents.send(.stop)
            }
        }

        socket.on("channel:join") { [weak self] data, _ in
            Task { @MainActor in
                if let payload = data.first as? [String: Any],
                   let channelId = payload["channelId"] as? String,
                   payload["unitId"] as? String == self?.unitId {
                    self?.currentChannel = channelId
                }
            }
        }

        socket.on("radio:channelJoined") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                let idxAny = payload?["channelIndex"]
                let channelIndex: Int
                if let n = idxAny as? Int { channelIndex = n }
                else if let n = idxAny as? NSNumber { channelIndex = n.intValue }
                else if let s = idxAny as? String, let n = Int(s) { channelIndex = n }
                else { channelIndex = -1 }
                if !channel.isEmpty {
                    self.currentChannel = channel
                }
                self.radioSubject.send(.channelJoined(channelId: channel, channelIndex: channelIndex))
            }
        }

        socket.on("ptt:granted") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let sender = payload?["senderUnitId"] as? String
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                self.isFloorRequestPending = false
                self.lastFloorDenialReason = nil
                if sender == nil || sender == self.unitId {
                    self.isTransmitting = true
                }
                self.radioSubject.send(.pttGranted(channelId: channel, senderUnitId: sender ?? self.unitId))
            }
        }

        socket.on("ptt:denied") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                let reason = (payload?["reason"] as? String) ?? "denied"
                self.isFloorRequestPending = false
                self.isTransmitting = false
                self.lastFloorDenialReason = reason
                self.radioSubject.send(.pttDenied(channelId: channel, reason: reason))
            }
        }

        socket.on("ptt:revoked") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                let reason = (payload?["reason"] as? String) ?? "dispatcher_takeover"
                self.isFloorRequestPending = false
                self.isTransmitting = false
                self.radioSubject.send(.pttRevoked(channelId: channel, reason: reason))
            }
        }

        socket.on("tx:start") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let sender = (payload?["senderUnitId"] as? String) ?? ""
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                if sender != self.unitId {
                    self.isReceiving = true
                }
                self.radioSubject.send(.txStart(senderUnitId: sender, channelId: channel))
            }
        }

        socket.on("tx:stop") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let sender = (payload?["senderUnitId"] as? String) ?? ""
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                if sender == self.unitId {
                    self.isTransmitting = false
                } else {
                    self.isReceiving = false
                }
                self.radioSubject.send(.txStop(senderUnitId: sender, channelId: channel))
            }
        }

        socket.on("channel:floor_taken") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                let heldBy = (payload?["heldBy"] as? String) ?? ""
                self.isReceiving = true
                self.radioSubject.send(.channelBusy(channelId: channel, heldBy: heldBy))
            }
        }

        socket.on("channel:busy") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                let heldBy = (payload?["heldBy"] as? String) ?? ""
                self.radioSubject.send(.channelBusy(channelId: channel, heldBy: heldBy))
            }
        }

        socket.on("channel:idle") { [weak self] data, _ in
            Task { @MainActor in
                guard let self else { return }
                let payload = data.first as? [String: Any]
                let channel = (payload?["channelId"] as? String) ?? (self.currentChannel ?? "")
                self.isReceiving = false
                self.radioSubject.send(.channelIdle(channelId: channel))
            }
        }

        socket.connect()
    }

    func joinChannel(_ channelId: String) {
        guard state == .authenticated, let socket else {
            pendingChannel = channelId
            return
        }
        socket.emit("channel:join", ["channelId": channelId])
        socket.emit("radio:joinChannel", ["channelId": channelId])
        currentChannel = channelId
    }

    func leaveChannel(_ channelId: String) {
        guard let socket else { return }
        socket.emit("radio:leaveChannel", ["channelId": channelId])
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
        manager = nil
        state = .disconnected
        currentChannel = nil
        isTransmitting = false
        isReceiving = false
        isFloorRequestPending = false
    }

    func requestFloor() {
        guard state == .authenticated, let socket, let channel = currentChannel, !channel.isEmpty else {
            lastFloorDenialReason = "not_ready"
            return
        }
        guard !isTransmitting && !isFloorRequestPending else { return }
        isFloorRequestPending = true
        lastFloorDenialReason = nil
        socket.emit("ptt:request", ["channelId": channel, "unitId": unitId])
    }

    func releaseFloor() {
        guard let socket, let channel = currentChannel, !channel.isEmpty else {
            isFloorRequestPending = false
            isTransmitting = false
            return
        }
        let wasActive = isTransmitting || isFloorRequestPending
        isFloorRequestPending = false
        isTransmitting = false
        guard wasActive else { return }
        socket.emit("tx:stop", ["channelId": channel, "unitId": unitId])
        socket.emit("ptt:release", ["channelId": channel, "unitId": unitId])
    }

    func emitLocationUpdate(latitude: Double, longitude: Double, accuracy: Double, heading: Double?, speed: Double?) {
        guard state == .authenticated, let socket else { return }
        var payload: [String: Any] = [
            "latitude": latitude,
            "longitude": longitude,
            "accuracy": accuracy
        ]
        if let heading { payload["heading"] = heading }
        if let speed { payload["speed"] = speed }
        socket.emit("location:update", payload)
    }

    // MARK: - Floor / TX events (used by RadioAudioEngine)

    func emitPttRequest(channelId: String) {
        guard state == .authenticated, let socket else { return }
        isFloorRequestPending = true
        lastFloorDenialReason = nil
        socket.emit("ptt:request", ["channelId": channelId, "unitId": unitId])
    }

    func emitPttRelease(channelId: String) {
        guard state == .authenticated, let socket else { return }
        isFloorRequestPending = false
        isTransmitting = false
        socket.emit("ptt:release", ["channelId": channelId, "unitId": unitId])
    }

    func emitTxStart(channelId: String) {
        guard state == .authenticated, let socket else { return }
        socket.emit("tx:start", ["channelId": channelId, "unitId": unitId])
    }

    func emitTxStop(channelId: String) {
        guard state == .authenticated, let socket else { return }
        socket.emit("tx:stop", ["channelId": channelId, "unitId": unitId])
    }

    func emitRadioSignalQuality(channelId: String, quality: String, lossPct: Double, jitterMs: Double) {
        guard state == .authenticated, let socket else { return }
        let payload: [String: Any] = [
            "channelId": channelId,
            "unitId": unitId,
            "quality": quality,
            "lossPct": lossPct,
            "jitterMs": jitterMs,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000)
        ]
        socket.emit("radio:signalQuality", payload)
    }

    private func sendAuth() {
        guard let socket else { return }
        let payload: [String: Any] = [
            "unitId": unitId,
            "username": username,
            "agencyId": "default",
            "isDispatcher": false,
            "deviceType": "radio",
            "clientType": "radio"
        ]
        socket.emit("authenticate", payload)
    }
}
