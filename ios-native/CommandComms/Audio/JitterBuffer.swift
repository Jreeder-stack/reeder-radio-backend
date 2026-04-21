import Foundation

/// Simple sequence-ordered jitter buffer for incoming Opus packets.
final class JitterBuffer {
    private let lock = NSLock()
    private var packets: [Int: OpusRadioPacket] = [:]
    private var nextSequence: Int? = nil
    private var lastDeliveredTimestamp: UInt32 = 0
    private(set) var plcCount: Int = 0
    private(set) var dropCount: Int = 0

    private static let frameDurationMs: Double = 20.0
    private static let jitterAlpha: Double = 0.07
    private var lastArrivalNs: UInt64 = 0
    private var _estimatedJitterMs: Double = 0

    let targetDepth: Int
    let maxDepth: Int

    init(targetDepth: Int = 3, maxDepth: Int = 32) {
        self.targetDepth = targetDepth
        self.maxDepth = maxDepth
    }

    var depth: Int {
        lock.lock(); defer { lock.unlock() }
        return packets.count
    }

    var estimatedJitterMs: Double {
        lock.lock(); defer { lock.unlock() }
        return _estimatedJitterMs
    }

    func reset() {
        lock.lock(); defer { lock.unlock() }
        packets.removeAll()
        nextSequence = nil
        lastDeliveredTimestamp = 0
        plcCount = 0
        dropCount = 0
        lastArrivalNs = 0
        _estimatedJitterMs = 0
    }

    func push(_ packet: OpusRadioPacket) {
        lock.lock(); defer { lock.unlock() }
        let now = DispatchTime.now().uptimeNanoseconds
        if lastArrivalNs > 0 {
            let intervalMs = Double(now - lastArrivalNs) / 1_000_000.0
            let deviation = abs(intervalMs - Self.frameDurationMs)
            _estimatedJitterMs = (1 - Self.jitterAlpha) * _estimatedJitterMs + Self.jitterAlpha * deviation
        }
        lastArrivalNs = now
        if packets.count >= maxDepth {
            // drop oldest
            if let minSeq = packets.keys.min() {
                packets.removeValue(forKey: minSeq)
                dropCount += 1
            }
        }
        if let next = nextSequence, packet.sequence < next - 32 {
            // far-late, drop
            dropCount += 1
            return
        }
        packets[packet.sequence] = packet
        if nextSequence == nil { nextSequence = packet.sequence }
    }

    /// Pop the next packet to play.
    /// Returns (packet?, isPLC). If nil and isPLC=true, caller should generate a PLC frame.
    func pop() -> (OpusRadioPacket?, Bool) {
        lock.lock(); defer { lock.unlock() }
        guard !packets.isEmpty || nextSequence != nil else { return (nil, false) }
        guard packets.count >= 1 else {
            // No packet — synthesize PLC if we already started playing
            if nextSequence != nil {
                plcCount += 1
                nextSequence = (nextSequence! + 1) & 0xFFFF
                return (nil, true)
            }
            return (nil, false)
        }
        // Wait for buffer to fill to target depth on first pop
        if let next = nextSequence, packets[next] == nil && packets.count < targetDepth {
            return (nil, false)
        }
        guard var seq = nextSequence else { return (nil, false) }
        if let pkt = packets.removeValue(forKey: seq) {
            nextSequence = (seq + 1) & 0xFFFF
            lastDeliveredTimestamp = pkt.timestampMs
            return (pkt, false)
        }
        // Gap — emit PLC and advance
        plcCount += 1
        seq = (seq + 1) & 0xFFFF
        nextSequence = seq
        return (nil, true)
    }
}
