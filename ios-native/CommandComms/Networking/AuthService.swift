import Foundation

@MainActor
final class AuthService {
    private let api: ApiClient
    private let keychain: KeychainStore

    init(api: ApiClient, keychain: KeychainStore) {
        self.api = api
        self.keychain = keychain
        if let cookie = keychain.sessionCookie {
            api.restoreCookie(cookie)
        }
    }

    func login(username: String, password: String) async throws -> User {
        let request = try api.makeRequest(
            path: "api/auth/login",
            method: "POST",
            json: ["username": username, "password": password]
        )
        let (data, response) = try await api.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ApiError.decoding
        }
        if !(200..<300).contains(http.statusCode) {
            let message = parseErrorMessage(data) ?? "Login failed (\(http.statusCode))"
            throw ApiError.server(message)
        }
        let decoded = try JSONDecoder().decode(LoginResponse.self, from: data)
        persistSession(user: decoded.user)
        return decoded.user
    }

    func restore() async -> User? {
        guard keychain.sessionCookie != nil else { return nil }
        do {
            let request = try api.makeRequest(path: "api/auth/me")
            let (data, response) = try await api.session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                return nil
            }
            let decoded = try JSONDecoder().decode(LoginResponse.self, from: data)
            persistSession(user: decoded.user)
            return decoded.user
        } catch {
            return nil
        }
    }

    func logout() async {
        if let request = try? api.makeRequest(path: "api/auth/logout", method: "POST", json: [:]) {
            _ = try? await api.session.data(for: request)
        }
        keychain.clear()
        if let cookies = api.cookieStorage.cookies {
            cookies.forEach { api.cookieStorage.deleteCookie($0) }
        }
    }

    private func persistSession(user: User) {
        keychain.user = user
        if let cookie = api.sessionCookieString(for: api.baseURL) {
            keychain.sessionCookie = cookie
        }
    }

    private func parseErrorMessage(_ data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json["error"] as? String
    }
}
