import Foundation
import AVFoundation
import os.log

/// Centralised AVAudioSession ownership for the radio.
///
/// The radio runs in two background-relevant scenarios:
///   * Receive: incoming traffic must continue to play when the screen is
///     locked or the app is backgrounded.
///   * Transmit: a hardware / Bluetooth PTT accessory may key up while the
///     app is not in the foreground.
///
/// Both rely on a single shared AVAudioSession that stays active for the
/// lifetime of the radio engine. Per-node start/stop must NOT toggle the
/// session active flag, otherwise iOS tears the engine down and we lose the
/// ability to keep playing while backgrounded.
final class AudioSessionManager {
    private let log = Logger(subsystem: "CommandComms", category: "AudioSession")

    /// Notifications fired when the system-managed audio engine needs to be
    /// rebuilt. Listeners are expected to stop and restart their AVAudioEngine
    /// instances on the main actor.
    var onShouldRestartEngines: (() -> Void)?

    /// Fired when an interruption begins (incoming call, Siri, alarm). The
    /// engine should treat this like a forced PTT release.
    var onInterruptionBegan: (() -> Void)?

    /// Fired when an interruption ends with `.shouldResume`. The engine should
    /// re-prime its playback path.
    var onInterruptionEnded: (Bool) -> Void = { _ in }

    private var observers: [NSObjectProtocol] = []
    private var isActive = false

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    /// Configures and activates the shared session. Safe to call multiple
    /// times; subsequent calls re-apply the configuration (helpful after a
    /// `mediaServicesWereReset` event).
    func activate() throws {
        let session = AVAudioSession.sharedInstance()
        // .playAndRecord + mode .voiceChat keeps the session alive in the
        // background under the `audio` and `voip` UIBackgroundModes.
        // .duckOthers (instead of .mixWithOthers) lets iOS attribute audible
        // playback to us so the OS does not suspend the engine during
        // silent gaps — this, combined with the silent keep-alive in
        // AudioPlayback, is what lets RX continue while the screen is off.
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .duckOthers]
        )
        try session.setPreferredSampleRate(OpusCodec.sampleRate)
        try session.setPreferredIOBufferDuration(0.02)
        try session.setActive(true, options: [])
        isActive = true
        installObserversIfNeeded()
        log.info("AudioSession activated; route=\(session.currentRoute.outputs.map { $0.portName }.joined(separator: ","))")
    }

    /// Releases the session. Should only be called when the radio is fully
    /// shutting down (sign-out, app exit) — never in the per-PTT path.
    func deactivate() {
        guard isActive else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            log.error("AudioSession deactivate failed: \(error.localizedDescription)")
        }
        isActive = false
    }

    private func installObserversIfNeeded() {
        guard observers.isEmpty else { return }
        let nc = NotificationCenter.default

        observers.append(nc.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleInterruption(note)
        })

        observers.append(nc.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            self?.handleRouteChange(note)
        })

        observers.append(nc.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleMediaServicesReset()
        })
    }

    private func handleInterruption(_ note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            log.info("AudioSession interruption began")
            onInterruptionBegan?()
        case .ended:
            var shouldResume = false
            if let optsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                shouldResume = AVAudioSession.InterruptionOptions(rawValue: optsRaw).contains(.shouldResume)
            }
            log.info("AudioSession interruption ended shouldResume=\(shouldResume)")
            // Re-activate before letting listeners restart their engines.
            do { try AVAudioSession.sharedInstance().setActive(true, options: []) }
            catch { log.error("Re-activate after interruption failed: \(error.localizedDescription)") }
            onInterruptionEnded(shouldResume)
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
            let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
        else { return }

        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable, .override, .categoryChange:
            log.info("AudioSession route changed reason=\(raw); restarting engines")
            onShouldRestartEngines?()
        default:
            break
        }
    }

    private func handleMediaServicesReset() {
        log.error("AudioSession mediaServicesWereReset — rebuilding")
        try? activate()
        onShouldRestartEngines?()
    }
}
