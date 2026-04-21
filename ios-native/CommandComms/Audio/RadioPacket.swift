import Foundation

struct OpusRadioPacket {
    let channelIndex: Int
    let senderUnitId: String
    let sequence: Int
    let timestampMs: UInt32
    let flags: Int
    let opusPayload: Data
}

enum RadioPacketCodec {
    static let version: UInt8 = 1
    static let flagFecHint: UInt8 = 0x01
    static let headerFixedLen = 1 + 1 + 2 + 2 + 4 + 1 + 2

    static func frame(payload: Data, sequence: Int, channelIndex: Int, senderUnitId: String, flags: UInt8 = flagFecHint) -> Data {
        let senderBytes = Array(senderUnitId.utf8)
        let senderLen = min(senderBytes.count, 255)
        let timestampMs = UInt32(Date().timeIntervalSince1970 * 1000) & 0xFFFFFFFF
        var buf = Data(capacity: headerFixedLen + senderLen + payload.count)
        buf.append(version)
        buf.append(flags)
        buf.append(UInt8((channelIndex >> 8) & 0xFF))
        buf.append(UInt8(channelIndex & 0xFF))
        buf.append(UInt8((sequence >> 8) & 0xFF))
        buf.append(UInt8(sequence & 0xFF))
        buf.append(UInt8((timestampMs >> 24) & 0xFF))
        buf.append(UInt8((timestampMs >> 16) & 0xFF))
        buf.append(UInt8((timestampMs >> 8) & 0xFF))
        buf.append(UInt8(timestampMs & 0xFF))
        buf.append(UInt8(senderLen))
        if senderLen > 0 { buf.append(contentsOf: senderBytes.prefix(senderLen)) }
        buf.append(UInt8((payload.count >> 8) & 0xFF))
        buf.append(UInt8(payload.count & 0xFF))
        buf.append(payload)
        return buf
    }

    static func parse(_ data: Data) -> OpusRadioPacket? {
        guard data.count >= headerFixedLen else { return nil }
        let bytes = [UInt8](data)
        var off = 0
        let v = bytes[off]; off += 1
        guard v == version else { return nil }
        let flags = Int(bytes[off]); off += 1
        let ch = (Int(bytes[off]) << 8) | Int(bytes[off + 1]); off += 2
        let seq = (Int(bytes[off]) << 8) | Int(bytes[off + 1]); off += 2
        let ts = (UInt32(bytes[off]) << 24) | (UInt32(bytes[off + 1]) << 16) |
                 (UInt32(bytes[off + 2]) << 8) | UInt32(bytes[off + 3])
        off += 4
        let senderLen = Int(bytes[off]); off += 1
        guard bytes.count >= off + senderLen + 2 else { return nil }
        let sender: String
        if senderLen > 0 {
            sender = String(bytes: bytes[off..<(off + senderLen)], encoding: .utf8) ?? ""
        } else { sender = "" }
        off += senderLen
        let payloadLen = (Int(bytes[off]) << 8) | Int(bytes[off + 1]); off += 2
        guard payloadLen > 0, bytes.count >= off + payloadLen else { return nil }
        let payload = Data(bytes[off..<(off + payloadLen)])
        return OpusRadioPacket(
            channelIndex: ch,
            senderUnitId: sender,
            sequence: seq,
            timestampMs: ts,
            flags: flags,
            opusPayload: payload
        )
    }

    static func keepalive(channelIndex: Int, senderUnitId: String) -> Data {
        let senderBytes = Array(senderUnitId.utf8)
        let senderLen = min(senderBytes.count, 255)
        let timestampMs = UInt32(Date().timeIntervalSince1970 * 1000) & 0xFFFFFFFF
        var buf = Data(capacity: headerFixedLen + senderLen)
        buf.append(version)
        buf.append(0)
        buf.append(UInt8((channelIndex >> 8) & 0xFF))
        buf.append(UInt8(channelIndex & 0xFF))
        buf.append(0); buf.append(0)
        buf.append(UInt8((timestampMs >> 24) & 0xFF))
        buf.append(UInt8((timestampMs >> 16) & 0xFF))
        buf.append(UInt8((timestampMs >> 8) & 0xFF))
        buf.append(UInt8(timestampMs & 0xFF))
        buf.append(UInt8(senderLen))
        if senderLen > 0 { buf.append(contentsOf: senderBytes.prefix(senderLen)) }
        buf.append(0); buf.append(0)
        return buf
    }
}
