import Foundation
import AVFoundation
import Opus

/// Wraps libopus encode/decode for 16 kHz mono 20 ms frames (320 samples).
final class OpusCodec {
    static let sampleRate: Double = 16000
    static let channels: AVAudioChannelCount = 1
    static let frameSamples: Int = 320            // 20 ms @ 16 kHz
    static let maxEncodedSize: Int = 512

    private let format: AVAudioFormat
    private var encoder: Opus.Encoder?
    private var decoder: Opus.Decoder?

    init() {
        self.format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: Self.sampleRate,
            channels: Self.channels,
            interleaved: true
        )!
    }

    func initialize() throws {
        encoder = try Opus.Encoder(format: format, application: .voip)
        decoder = try Opus.Decoder(format: format)
    }

    func release() {
        encoder = nil
        decoder = nil
    }

    /// pcm should contain exactly `frameSamples` Int16 samples.
    func encode(pcm: [Int16]) -> Data? {
        guard let encoder else { return nil }
        guard pcm.count == Self.frameSamples else { return nil }
        let inBuf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Self.frameSamples))!
        inBuf.frameLength = AVAudioFrameCount(Self.frameSamples)
        if let dst = inBuf.int16ChannelData {
            pcm.withUnsafeBufferPointer { src in
                dst[0].update(from: src.baseAddress!, count: pcm.count)
            }
        }
        var out = Data(count: Self.maxEncodedSize)
        do {
            let n = try out.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Int in
                let mut = UnsafeMutableBufferPointer<UInt8>(
                    start: raw.bindMemory(to: UInt8.self).baseAddress, count: raw.count)
                return try encoder.encode(inBuf, to: mut)
            }
            return out.prefix(n)
        } catch {
            return nil
        }
    }

    /// Decode an Opus payload into a PCM frame; returns up to `frameSamples` Int16 samples.
    /// Pass `nil` for packet-loss concealment.
    func decode(_ payload: Data?) -> [Int16]? {
        guard let decoder else { return nil }
        let outBuf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Self.frameSamples))!
        do {
            let count: Int
            if let payload {
                count = try payload.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int in
                    let buf = UnsafeBufferPointer<UInt8>(
                        start: raw.bindMemory(to: UInt8.self).baseAddress, count: raw.count)
                    return try decoder.decode(buf, to: outBuf)
                }
            } else {
                count = try decoder.decode(nil, to: outBuf)
            }
            outBuf.frameLength = AVAudioFrameCount(count)
            guard let src = outBuf.int16ChannelData else { return nil }
            var out = [Int16](repeating: 0, count: count)
            out.withUnsafeMutableBufferPointer { dst in
                dst.baseAddress!.update(from: src[0], count: count)
            }
            return out
        } catch {
            return nil
        }
    }
}
