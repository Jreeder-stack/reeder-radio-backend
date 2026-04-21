import Foundation
import AVFoundation
import os.log

/// Plays decoded 16 kHz mono Int16 PCM frames through AVAudioEngine.
///
/// To keep the AVAudioEngine alive while the app is backgrounded or the
/// screen is locked, we continuously schedule short silent buffers whenever
/// no real audio is queued. Without this, iOS sees a long stretch of
/// scheduling inactivity and suspends the engine, after which incoming radio
/// traffic stops playing until the user re-foregrounds the app.
final class AudioPlayback {
    private let log = Logger(subsystem: "CommandComms", category: "AudioPlayback")
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(
        standardFormatWithSampleRate: OpusCodec.sampleRate,
        channels: OpusCodec.channels
    )!  // Float32, deinterleaved — most compatible with AVAudioEngine

    private let queue = DispatchQueue(label: "radio.playback.keepalive")
    private var pendingScheduled = 0
    private let keepAliveTarget = 3              // queue depth in silent buffers
    private let keepAliveFrames: AVAudioFrameCount = 320 // 20 ms @ 16 kHz
    private var started = false

    func start() throws {
        if started { return }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.prepare()
        try engine.start()
        player.play()
        started = true
        primeKeepAlive()
        log.info("AudioPlayback started")
    }

    func stop() {
        if !started { return }
        player.stop()
        engine.stop()
        engine.detach(player)
        started = false
        queue.sync { pendingScheduled = 0 }
    }

    /// Tear down and rebuild the AVAudioEngine without touching the shared
    /// AVAudioSession. Required after `mediaServicesWereReset` or when the
    /// system pauses the engine across an interruption.
    func restart() {
        stop()
        do { try start() }
        catch { log.error("AudioPlayback restart failed: \(error.localizedDescription)") }
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
        scheduleBuffer(buf, isKeepAlive: false)
    }

    // MARK: - Silent keep-alive

    private func primeKeepAlive() {
        for _ in 0..<keepAliveTarget { scheduleSilentBuffer() }
    }

    private func scheduleSilentBuffer() {
        guard started,
              let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: keepAliveFrames)
        else { return }
        buf.frameLength = keepAliveFrames
        // Buffer is zero-initialised by AVAudioPCMBuffer; this is true silence
        // and is not perceptible, but iOS counts it as active playback so the
        // `audio` background mode keeps the process alive.
        scheduleBuffer(buf, isKeepAlive: true)
    }

    private func scheduleBuffer(_ buf: AVAudioPCMBuffer, isKeepAlive: Bool) {
        queue.sync { pendingScheduled += 1 }
        player.scheduleBuffer(buf, completionHandler: { [weak self] in
            guard let self else { return }
            self.queue.async {
                self.pendingScheduled -= 1
                if self.pendingScheduled < self.keepAliveTarget && self.started {
                    DispatchQueue.main.async { self.scheduleSilentBuffer() }
                }
            }
        })
    }
}
