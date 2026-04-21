import Foundation
import Combine

enum AuthStatus {
    case checking
    case signedOut
    case signedIn(User)
}

@MainActor
final class AppState: ObservableObject {
    @Published var authStatus: AuthStatus = .checking
    @Published var settings: AppPreferences

    let keychain = KeychainStore()
    let api: ApiClient
    let auth: AuthService
    let signaling: SignalingClient
    let locationTracker: LocationTracker
    let radio: RadioAudioEngine
    let radioConfig: RadioConfigService

    private var cancellables = Set<AnyCancellable>()

    init() {
        let prefs = AppPreferences.load()
        self.settings = prefs
        let api = ApiClient(baseURL: prefs.signalingURL)
        self.api = api
        self.auth = AuthService(api: api, keychain: KeychainStore())
        let signaling = SignalingClient(serverURL: prefs.signalingURL)
        self.signaling = signaling
        let tracker = LocationTracker()
        self.locationTracker = tracker
        tracker.signaling = signaling
        self.radio = RadioAudioEngine()
        self.radioConfig = RadioConfigService(api: api)
        self.radio.attach(signaling: signaling)

        signaling.locationTrackEvents
            .receive(on: DispatchQueue.main)
            .sink { [weak self] event in
                guard let self else { return }
                switch event {
                case .start:
                    self.locationTracker.startTracking()
                case .stop:
                    self.locationTracker.stopTracking()
                }
            }
            .store(in: &cancellables)

        signaling.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] state in
                if state == .disconnected {
                    self?.locationTracker.stopTracking()
                }
            }
            .store(in: &cancellables)

        Task { await restoreSession() }
    }

    func restoreSession() async {
        if let user = await auth.restore() {
            authStatus = .signedIn(user)
            connectSignaling(for: user)
        } else {
            authStatus = .signedOut
        }
    }

    func signedIn(_ user: User) {
        authStatus = .signedIn(user)
        connectSignaling(for: user)
    }

    func signOut() {
        Task {
            await auth.logout()
            radio.stopRadio()
            signaling.disconnect()
            locationTracker.stopTracking()
            authStatus = .signedOut
        }
    }

    func updateSignalingURL(_ url: String) {
        var prefs = settings
        prefs.signalingURL = url
        prefs.save()
        settings = prefs
        api.updateBaseURL(url)
        signaling.updateServerURL(url)
    }

    /// Captures a single fix and emits it to dispatch. Future PTT code should
    /// call this on PTT press alongside TX start to mirror Android behavior.
    func requestOneShotLocationFix() {
        locationTracker.requestOneShotFix()
    }

    private func connectSignaling(for user: User) {
        signaling.serverURL = settings.signalingURL
        let cookie = keychain.sessionCookie
            ?? api.sessionCookieString(for: api.baseURL)
        signaling.connect(unitId: user.unitId ?? user.username,
                          username: user.username,
                          defaultChannel: settings.defaultChannelId,
                          sessionCookie: cookie)
        locationTracker.requestWhenInUse()

        radio.unitId = user.unitId ?? user.username
        radio.channelId = settings.defaultChannelId

        Task { await fetchAndStartRadio() }
    }

    private func fetchAndStartRadio() async {
        do {
            let cfg = try await radioConfig.fetchConfig()
            radio.configureRelay(host: cfg.audioRelayHost, port: cfg.audioRelayPort)
            radio.startRadio()
        } catch {
            // No relay config yet — skip audio start; UI will report.
            print("RadioConfig fetch failed: \(error.localizedDescription)")
        }
    }
}
