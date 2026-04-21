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

    init() {
        let prefs = AppPreferences.load()
        self.settings = prefs
        let api = ApiClient(baseURL: prefs.signalingURL)
        self.api = api
        self.auth = AuthService(api: api, keychain: KeychainStore())
        self.signaling = SignalingClient(serverURL: prefs.signalingURL)

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
            signaling.disconnect()
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

    private func connectSignaling(for user: User) {
        signaling.serverURL = settings.signalingURL
        let cookie = keychain.sessionCookie
            ?? api.sessionCookieString(for: api.baseURL)
        signaling.connect(unitId: user.unitId ?? user.username,
                          username: user.username,
                          defaultChannel: settings.defaultChannelId,
                          sessionCookie: cookie)
    }
}
