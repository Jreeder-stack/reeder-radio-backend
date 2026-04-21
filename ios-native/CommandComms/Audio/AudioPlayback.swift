import Foundation
import AVFoundation
import os.log

/// Plays decoded 16 kHz mono Int16 PCM frames through AVAudioEngine.
final class AudioPlayback {
    private let log = Logger(subsystem: "CommandComms", category: "AudioPlayback")
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(
        standardFormatWithSampleRate: OpusCodec.sampleRate,
        channels: OpusCodec.channels
    )!  // Float32, deinterleaved — most compatible with AVAudioEngine

    private var started = false

    func start() throws {
        if started { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        player.play()
        started = true
        log.info("AudioPlayback started")
    }

    func stop() {
        if !started { return }
        player.stop()
        engine.stop()
        engine.detach(player)
        started = false
    }

    func enqueue(pcm: [Int16]) {
        guard started, !pcm.isEmpty else { return }
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count)) else { return }
        buf.frameLength = AVAudioFrameCount(pcm.count)
        if let dst = buf.floatChannelData {
            let ch = dst[0]
            for i in 0..<pcm.count {
                ch[i] = max(-1.0, min(1.0, Float(pcm[i]) / 32768.0))
            }
        }
        player.scheduleBuffer(buf, completionHandler: nil)
    }
}
