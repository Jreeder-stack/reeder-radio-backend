import Foundation

final class ApiClient {
    private(set) var baseURL: URL
    let session: URLSession
    let cookieStorage: HTTPCookieStorage

    init(baseURL: String) {
        self.baseURL = URL(string: baseURL) ?? URL(string: AppPreferences.defaultURL)!
        let config = URLSessionConfiguration.default
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        let storage = HTTPCookieStorage.shared
        config.httpCookieStorage = storage
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        self.cookieStorage = storage
        self.session = URLSession(configuration: config)
    }

    func updateBaseURL(_ urlString: String) {
        if let url = URL(string: urlString) {
            self.baseURL = url
        }
    }

    func makeRequest(path: String, method: String = "GET", json: [String: Any]? = nil) throws -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let json {
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        return request
    }

    func sessionCookieString(for url: URL) -> String? {
        let cookies = cookieStorage.cookies(for: url) ?? []
        guard !cookies.isEmpty else { return nil }
        return cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    func restoreCookie(_ cookieHeader: String) {
        let parts = cookieHeader.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        for part in parts {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            guard kv.count == 2, let host = baseURL.host else { continue }
            let props: [HTTPCookiePropertyKey: Any] = [
                .name: kv[0],
                .value: kv[1],
                .domain: host,
                .path: "/",
                .secure: baseURL.scheme == "https"
            ]
            if let cookie = HTTPCookie(properties: props) {
                cookieStorage.setCookie(cookie)
            }
        }
    }
}

enum ApiError: LocalizedError {
    case server(String)
    case decoding
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .server(let msg): return msg
        case .decoding: return "Unexpected response from server"
        case .transport(let err): return err.localizedDescription
        }
    }
}
