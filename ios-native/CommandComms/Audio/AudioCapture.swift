import Foundation
import AVFoundation
import os.log

/// Captures microphone PCM at 16 kHz mono and emits 320-sample (20 ms) Int16 frames.
///
/// The shared AVAudioSession is owned by `AudioSessionManager` — capture only
/// starts/stops the AVAudioEngine. Toggling the session active flag here would
/// tear down the parallel playback path, breaking background RX.
final class AudioCapture {
    private let log = Logger(subsystem: "CommandComms", category: "AudioCapture")
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let outFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: OpusCodec.sampleRate,
        channels: OpusCodec.channels,
        interleaved: true
    )!
    private var pendingSamples: [Int16] = []
    private let frameSamples = OpusCodec.frameSamples

    var onFrame: (([Int16]) -> Void)?

    func start() throws {
        if engine.isRunning { return }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        converter = AVAudioConverter(from: inputFormat, to: outFormat)
        pendingSamples.removeAll(keepingCapacity: true)

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
            self?.handleInput(buffer)
        }

        engine.prepare()
        try engine.start()
        log.info("AudioCapture started inputRate=\(inputFormat.sampleRate) ch=\(inputFormat.channelCount)")
    }

    func stop() {
        if engine.isRunning {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        pendingSamples.removeAll(keepingCapacity: false)
        converter = nil
    }

    /// Tear the engine down without releasing the shared session. Used by the
    /// session manager when iOS resets media services and we have to rebuild
    /// the AVAudioEngine from scratch.
    func reset() {
        stop()
    }

    private func handleInput(_ buffer: AVAudioPCMBuffer) {
        guard let converter else { return }
        let ratio = outFormat.sampleRate / buffer.format.sampleRate
        let outCapacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: outCapacity) else { return }
        var error: NSError?
        var supplied = false
        let status = converter.convert(to: outBuf, error: &error) { _, inputStatus in
            if supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            supplied = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error || error != nil { return }
        guard outBuf.frameLength > 0, let ch = outBuf.int16ChannelData else { return }
        let count = Int(outBuf.frameLength)
        let ptr = ch[0]
        var newSamples = [Int16](repeating: 0, count: count)
        newSamples.withUnsafeMutableBufferPointer { dst in
            dst.baseAddress!.update(from: ptr, count: count)
        }
        pendingSamples.append(contentsOf: newSamples)
        while pendingSamples.count >= frameSamples {
            let frame = Array(pendingSamples.prefix(frameSamples))
            pendingSamples.removeFirst(frameSamples)
            onFrame?(frame)
        }
    }
}
