import Foundation
import Combine
import SocketIO

enum SignalingState: String {
    case disconnected
    case connecting
    case connected
    case authenticated
}

@MainActor
final class SignalingClient: ObservableObject {
    @Published var state: SignalingState = .disconnected
    @Published var currentChannel: String?
    @Published var lastError: String?

    var serverURL: String
    var sessionCookieHeader: String?

    private var manager: SocketManager?
    private var socket: SocketIOClient?
    private var unitId: String = ""
    private var username: String = ""
    private var pendingChannel: String?

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

        socket.on("channel:join") { [weak self] data, _ in
            Task { @MainActor in
                if let payload = data.first as? [String: Any],
                   let channelId = payload["channelId"] as? String,
                   payload["unitId"] as? String == self?.unitId {
                    self?.currentChannel = channelId
                }
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
        currentChannel = channelId
    }

    func disconnect() {
        socket?.disconnect()
        socket = nil
        manager = nil
        state = .disconnected
        currentChannel = nil
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
