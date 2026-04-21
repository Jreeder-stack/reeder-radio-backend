import Foundation

struct AppPreferences: Codable, Equatable {
    var signalingURL: String
    var defaultChannelId: String

    static let defaultURL = "https://comms.reeder-systems.com"
    static let defaultChannel = "default"

    static func load() -> AppPreferences {
        let defaults = UserDefaults.standard
        return AppPreferences(
            signalingURL: defaults.string(forKey: Keys.signalingURL) ?? defaultURL,
            defaultChannelId: defaults.string(forKey: Keys.defaultChannel) ?? defaultChannel
        )
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(signalingURL, forKey: Keys.signalingURL)
        defaults.set(defaultChannelId, forKey: Keys.defaultChannel)
    }

    private enum Keys {
        static let signalingURL = "pref.signalingURL"
        static let defaultChannel = "pref.defaultChannel"
    }
}
