import Foundation
import Network
import os.log

enum TransportHealth: String {
    case connected, reconnecting, disconnected
}

final class UdpAudioTransport {
    private let log = Logger(subsystem: "CommandComms", category: "UdpTransport")
    private let queue = DispatchQueue(label: "udp.audio.transport")

    private(set) var relayHost: String = ""
    private(set) var relayPort: UInt16 = 5100

    private var connection: NWConnection?
    private var keepaliveTimer: DispatchSourceTimer?

    private var sequenceNumber: Int = 0
    private(set) var txPacketCount: UInt64 = 0
    private(set) var rxPacketCount: UInt64 = 0
    private var txFailures: UInt64 = 0

    var channelIndex: Int = 0
    var unitId: String = ""

    private(set) var health: TransportHealth = .disconnected {
        didSet { onHealthChange?(health) }
    }
    var onHealthChange: ((TransportHealth) -> Void)?
    var onPacketReceived: ((OpusRadioPacket) -> Void)?

    private static let keepaliveInterval: TimeInterval = 8

    func configure(host: String, port: Int) {
        queue.async {
            self.relayHost = host
            self.relayPort = UInt16(port)
            self.log.debug("Configured relay \(host):\(port)")
        }
    }

    func start() {
        queue.async {
            guard self.connection == nil else { return }
            guard !self.relayHost.isEmpty, self.relayPort > 0 else {
                self.log.error("Cannot start UDP transport — relay not configured")
                return
            }
            let host = NWEndpoint.Host(self.relayHost)
            let port = NWEndpoint.Port(rawValue: self.relayPort)!
            let params = NWParameters.udp
            params.allowLocalEndpointReuse = true
            let conn = NWConnection(host: host, port: port, using: params)
            self.connection = conn
            conn.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                self.queue.async {
                    switch state {
                    case .ready:
                        self.health = .connected
                        self.log.info("UDP socket ready -> \(self.relayHost):\(self.relayPort)")
                        self.startReceive()
                        self.sendKeepalive()
                    case .failed(let err):
                        self.log.error("UDP failed: \(String(describing: err))")
                        self.health = .reconnecting
                        self.recreate()
                    case .cancelled:
                        self.health = .disconnected
                    case .waiting(let err):
                        self.log.warning("UDP waiting: \(String(describing: err))")
                        self.health = .reconnecting
                    default:
                        break
                    }
                }
            }
            conn.start(queue: self.queue)
            self.startKeepaliveLoop()
        }
    }

    func stop() {
        queue.async {
            self.keepaliveTimer?.cancel()
            self.keepaliveTimer = nil
            self.connection?.cancel()
            self.connection = nil
            self.health = .disconnected
            self.sequenceNumber = 0
            self.txPacketCount = 0
            self.rxPacketCount = 0
            self.txFailures = 0
        }
    }

    func resetCounters() {
        queue.async {
            self.sequenceNumber = 0
            self.txPacketCount = 0
            self.rxPacketCount = 0
            self.txFailures = 0
        }
    }

    func sendOpusPayload(_ payload: Data) {
        queue.async {
            guard let conn = self.connection, conn.state == .ready else {
                self.txFailures += 1
                return
            }
            let seq = self.sequenceNumber
            self.sequenceNumber = (self.sequenceNumber + 1) & 0xFFFF
            let frame = RadioPacketCodec.frame(
                payload: payload,
                sequence: seq,
                channelIndex: self.channelIndex,
                senderUnitId: self.unitId
            )
            conn.send(content: frame, completion: .contentProcessed { [weak self] err in
                guard let self else { return }
                self.queue.async {
                    if let err {
                        self.txFailures += 1
                        self.log.warning("UDP send err: \(String(describing: err))")
                    } else {
                        self.txPacketCount += 1
                    }
                }
            })
        }
    }

    private func sendKeepalive() {
        guard let conn = connection, conn.state == .ready else { return }
        let frame = RadioPacketCodec.keepalive(channelIndex: channelIndex, senderUnitId: unitId)
        conn.send(content: frame, completion: .contentProcessed { _ in })
    }

    private func startKeepaliveLoop() {
        keepaliveTimer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + Self.keepaliveInterval, repeating: Self.keepaliveInterval)
        t.setEventHandler { [weak self] in self?.sendKeepalive() }
        t.resume()
        keepaliveTimer = t
    }

    private func recreate() {
        connection?.cancel()
        connection = nil
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.0) { [weak self] in
            self?.start()
        }
    }

    private func startReceive() {
        guard let conn = connection else { return }
        conn.receiveMessage { [weak self] data, _, _, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.queue.async {
                    if let pkt = RadioPacketCodec.parse(data) {
                        if pkt.senderUnitId != self.unitId {
                            self.rxPacketCount += 1
                            self.onPacketReceived?(pkt)
                        }
                    }
                }
            }
            if error == nil, conn.state == .ready {
                self.startReceive()
            }
        }
    }
}
