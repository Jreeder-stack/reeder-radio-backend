import Foundation

struct RadioTransportConfig: Decodable {
    let transportMode: String?
    let signalingUrl: String?
    let audioRelayHost: String
    let audioRelayPort: Int
    let useTls: Bool?
}

final class RadioConfigService {
    private let api: ApiClient

    init(api: ApiClient) {
        self.api = api
    }

    func fetchConfig() async throws -> RadioTransportConfig {
        let req = try api.makeRequest(path: "api/radio/config")
        let (data, response) = try await api.session.data(for: req)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ApiError.server("Failed to fetch radio config")
        }
        do {
            return try JSONDecoder().decode(RadioTransportConfig.self, from: data)
        } catch {
            throw ApiError.decoding
        }
    }
}
