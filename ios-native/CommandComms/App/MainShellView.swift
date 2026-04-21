import SwiftUI

struct MainShellView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        TabView {
            RadioView()
                .tabItem {
                    Label("Radio", systemImage: "antenna.radiowaves.left.and.right")
                }

            DeviceRegistrationView()
                .tabItem {
                    Label("Device", systemImage: "iphone.radiowaves.left.and.right")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gearshape")
                }
        }
        .tint(.cyan)
    }
}
