import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @State private var signalingURL: String = ""
    @State private var defaultChannel: String = ""
    @State private var saved = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Signaling") {
                    TextField("Signaling URL", text: $signalingURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                    TextField("Default Channel", text: $defaultChannel)
                        .textInputAutocapitalization(.never)
                        .disableAutocorrection(true)
                    Button("Save") {
                        appState.updateSignalingURL(signalingURL)
                        var prefs = appState.settings
                        prefs.defaultChannelId = defaultChannel
                        prefs.save()
                        appState.settings = prefs
                        saved = true
                    }
                    .disabled(signalingURL.isEmpty)
                    if saved {
                        Text("Saved").font(.caption).foregroundColor(.green)
                    }
                }

                Section("Account") {
                    if case .signedIn(let user) = appState.authStatus {
                        LabeledContent("Username", value: user.username)
                        if let unit = user.unitId {
                            LabeledContent("Unit ID", value: unit)
                        }
                        if let role = user.role {
                            LabeledContent("Role", value: role)
                        }
                    }
                    Button("Sign Out", role: .destructive) {
                        appState.signOut()
                    }
                }

                Section("Build") {
                    LabeledContent("App", value: Bundle.main.appVersion)
                }
            }
            .navigationTitle("Settings")
            .onAppear {
                signalingURL = appState.settings.signalingURL
                defaultChannel = appState.settings.defaultChannelId
            }
        }
    }
}

private extension Bundle {
    var appVersion: String {
        let version = infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }
}

#Preview {
    SettingsView().environmentObject(AppState())
}
