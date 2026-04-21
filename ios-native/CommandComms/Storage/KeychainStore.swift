import Foundation
import KeychainAccess

final class KeychainStore {
    private let keychain: Keychain

    private enum Keys {
        static let sessionCookie = "sessionCookie"
        static let userJSON = "userJSON"
    }

    init(service: String = "com.reedersystems.commandcomms") {
        self.keychain = Keychain(service: service)
            .accessibility(.afterFirstUnlock)
    }

    var sessionCookie: String? {
        get { try? keychain.get(Keys.sessionCookie) }
        set {
            if let value = newValue {
                try? keychain.set(value, key: Keys.sessionCookie)
            } else {
                try? keychain.remove(Keys.sessionCookie)
            }
        }
    }

    var user: User? {
        get {
            guard let data = try? keychain.getData(Keys.userJSON) else { return nil }
            return try? JSONDecoder().decode(User.self, from: data)
        }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) {
                try? keychain.set(data, key: Keys.userJSON)
            } else {
                try? keychain.remove(Keys.userJSON)
            }
        }
    }

    func clear() {
        try? keychain.removeAll()
    }
}
