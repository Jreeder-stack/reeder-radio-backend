import Foundation
import Combine
import ExternalAccessory

@MainActor
final class MFiPTTAccessoryManager: NSObject, ObservableObject {
    @Published private(set) var connectedAccessoryName: String?
    @Published private(set) var lastError: String?

    private var sessions: [Int: EASession] = [:]
    private var streamDelegates: [Int: PTTStreamDelegate] = [:]
    private var notificationObservers: [NSObjectProtocol] = []
    private var supportedProtocols: Set<String> = []

    private let onPress: @MainActor () -> Void
    private let onRelease: @MainActor () -> Void

    init(onPress: @escaping @MainActor () -> Void, onRelease: @escaping @MainActor () -> Void) {
        self.onPress = onPress
        self.onRelease = onRelease
        super.init()
    }

    deinit {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    func start() {
        loadSupportedProtocols()
        guard !supportedProtocols.isEmpty else { return }

        let center = NotificationCenter.default
        let manager = EAAccessoryManager.shared()
        manager.registerForLocalNotifications()

        let connectObserver = center.addObserver(
            forName: .EAAccessoryDidConnect,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let accessory = note.userInfo?[EAAccessoryKey] as? EAAccessory else { return }
            Task { @MainActor in self?.openSession(for: accessory) }
        }
        let disconnectObserver = center.addObserver(
            forName: .EAAccessoryDidDisconnect,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let accessory = note.userInfo?[EAAccessoryKey] as? EAAccessory else { return }
            Task { @MainActor in self?.closeSession(for: accessory) }
        }
        notificationObservers = [connectObserver, disconnectObserver]

        for accessory in manager.connectedAccessories {
            openSession(for: accessory)
        }
    }

    func stop() {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        notificationObservers.removeAll()
        let anyPressed = streamDelegates.values.contains(where: { $0.isPressed })
        for (_, session) in sessions {
            session.inputStream?.close()
            session.inputStream?.remove(from: .main, forMode: .default)
            session.outputStream?.close()
        }
        sessions.removeAll()
        streamDelegates.removeAll()
        connectedAccessoryName = nil
        EAAccessoryManager.shared().unregisterForLocalNotifications()
        if anyPressed { onRelease() }
    }

    private func loadSupportedProtocols() {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "UISupportedExternalAccessoryProtocols") as? [String] else {
            supportedProtocols = []
            return
        }
        supportedProtocols = Set(raw)
    }

    private func matchProtocol(for accessory: EAAccessory) -> String? {
        return accessory.protocolStrings.first(where: { supportedProtocols.contains($0) })
    }

    private func openSession(for accessory: EAAccessory) {
        guard sessions[accessory.connectionID] == nil,
              let proto = matchProtocol(for: accessory) else { return }
        guard let session = EASession(accessory: accessory, forProtocol: proto) else {
            lastError = "Failed to open MFi session for \(accessory.name)"
            return
        }
        let press = self.onPress
        let release = self.onRelease
        let delegate = PTTStreamDelegate(
            onPress: { Task { @MainActor in press() } },
            onRelease: { Task { @MainActor in release() } }
        )
        session.inputStream?.delegate = delegate
        session.inputStream?.schedule(in: .main, forMode: .default)
        session.inputStream?.open()
        sessions[accessory.connectionID] = session
        streamDelegates[accessory.connectionID] = delegate
        connectedAccessoryName = accessory.name
    }

    private func closeSession(for accessory: EAAccessory) {
        guard let session = sessions.removeValue(forKey: accessory.connectionID) else { return }
        session.inputStream?.close()
        session.inputStream?.remove(from: .main, forMode: .default)
        session.outputStream?.close()
        let wasPressed = streamDelegates.removeValue(forKey: accessory.connectionID)?.isPressed ?? false
        if sessions.isEmpty {
            connectedAccessoryName = nil
        }
        if wasPressed { onRelease() }
    }
}

private final class PTTStreamDelegate: NSObject, StreamDelegate {
    private let onPress: () -> Void
    private let onRelease: () -> Void
    private(set) var isPressed: Bool = false
    private var buffer = [UInt8](repeating: 0, count: 64)

    init(onPress: @escaping () -> Void, onRelease: @escaping () -> Void) {
        self.onPress = onPress
        self.onRelease = onRelease
    }

    func stream(_ aStream: Stream, handle eventCode: Stream.Event) {
        guard eventCode == .hasBytesAvailable, let input = aStream as? InputStream else { return }
        while input.hasBytesAvailable {
            let n = input.read(&buffer, maxLength: buffer.count)
            guard n > 0 else { break }
            // Common MFi PTT byte protocol: first byte non-zero == pressed, zero == released.
            let pressed = buffer[0] != 0
            if pressed != isPressed {
                isPressed = pressed
                DispatchQueue.main.async { [self] in
                    if pressed { onPress() } else { onRelease() }
                }
            }
        }
    }
}
