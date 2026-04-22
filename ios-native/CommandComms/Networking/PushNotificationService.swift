import Foundation

/// Forwards APNs device tokens to the backend so dispatch pages and emergency
/// alerts can target this iPhone. Holds the latest token in memory and replays
/// it once the user signs in.
@MainActor
final class PushNotificationService {
    static let shared = PushNotificationService()

    private var api: ApiClient?
    private var lastToken: String?
    private var lastUploadedToken: String?
    private var isAuthenticated = false
    private let environment: String = {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }()

    private init() {}

    /// Wires the service to the shared API client. Called once at app start.
    func configure(api: ApiClient) {
        self.api = api
    }

    /// Called whenever the user signs in / out. While signed out we hold the
    /// token but don't try to register it (the server requires a session).
    func setAuthenticated(_ authenticated: Bool) {
        let wasAuthenticated = isAuthenticated
        isAuthenticated = authenticated
        if !wasAuthenticated && authenticated {
            // Replay any cached token now that we have a session.
            if let token = lastToken {
                upload(token: token, force: true)
            }
        }
        if !authenticated {
            lastUploadedToken = nil
        }
    }

    /// Called from AppDelegate when APNs hands us a fresh device token (also
    /// fires on token refresh because iOS calls didRegister again).
    func handleNewToken(_ hexToken: String) {
        let trimmed = hexToken.lowercased()
        lastToken = trimmed
        guard isAuthenticated else {
            print("[Push] Token cached; will upload after sign-in")
            return
        }
        upload(token: trimmed, force: false)
    }

    private func upload(token: String, force: Bool) {
        guard let api = api else { return }
        if !force, let last = lastUploadedToken, last == token {
            return
        }
        Task { [weak self] in
            do {
                let bundleId = Bundle.main.bundleIdentifier ?? ""
                let body: [String: Any] = [
                    "token": token,
                    "bundleId": bundleId,
                    "environment": self?.environment ?? "production"
                ]
                let request = try api.makeRequest(path: "api/devices/apns-token", method: "POST", json: body)
                let (_, response) = try await api.session.data(for: request)
                if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                    await MainActor.run { self?.lastUploadedToken = token }
                    print("[Push] APNs token uploaded (env=\(self?.environment ?? "?") len=\(token.count))")
                } else {
                    let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                    print("[Push] APNs token upload failed: status=\(status)")
                }
            } catch {
                print("[Push] APNs token upload error: \(error.localizedDescription)")
            }
        }
    }
}
