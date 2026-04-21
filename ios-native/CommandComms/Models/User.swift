import Foundation

struct User: Codable, Equatable {
    let id: Int
    let username: String
    let role: String?
    let unitId: String?
    let email: String?

    enum CodingKeys: String, CodingKey {
        case id
        case username
        case role
        case unitId = "unit_id"
        case email
    }
}

struct LoginResponse: Codable {
    let user: User
}
