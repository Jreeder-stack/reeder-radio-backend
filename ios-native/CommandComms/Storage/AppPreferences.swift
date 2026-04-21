import Foundation

struct AppPreferences: Codable, Equatable {
    var signalingURL: String
    var defaultChannelId: String
    var pttAccessoryModel: PTTAccessoryModel

    static let defaultURL = "https://comms.reeder-systems.com"
    static let defaultChannel = "default"

    static func load() -> AppPreferences {
        let defaults = UserDefaults.standard
        let storedModel = defaults.string(forKey: Keys.pttAccessoryModel)
            .flatMap(PTTAccessoryModel.init(rawValue:)) ?? .generic
        return AppPreferences(
            signalingURL: defaults.string(forKey: Keys.signalingURL) ?? defaultURL,
            defaultChannelId: defaults.string(forKey: Keys.defaultChannel) ?? defaultChannel,
            pttAccessoryModel: storedModel
        )
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(signalingURL, forKey: Keys.signalingURL)
        defaults.set(defaultChannelId, forKey: Keys.defaultChannel)
        defaults.set(pttAccessoryModel.rawValue, forKey: Keys.pttAccessoryModel)
    }

    private enum Keys {
        static let signalingURL = "pref.signalingURL"
        static let defaultChannel = "pref.defaultChannel"
        static let pttAccessoryModel = "pref.pttAccessoryModel"
    }
}
