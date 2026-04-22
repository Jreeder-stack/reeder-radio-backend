import SwiftUI

struct MainShellView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var router: NotificationRouter
    @State private var pagePresented: NotificationRoute?
    @State private var emergencyMessage: String?

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
        .onAppear { handleRoute(router.consume()) }
        .onChange(of: router.pending) { _, _ in
            handleRoute(router.consume())
        }
        .sheet(item: Binding(
            get: { pagePresented.map { PageRouteWrapper(route: $0) } },
            set: { wrapper in pagePresented = wrapper?.route }
        )) { wrapper in
            PageDetailSheet(route: wrapper.route) { pagePresented = nil }
        }
        .alert("Emergency", isPresented: Binding(
            get: { emergencyMessage != nil },
            set: { if !$0 { emergencyMessage = nil } }
        )) {
            Button("OK", role: .cancel) { emergencyMessage = nil }
        } message: {
            Text(emergencyMessage ?? "")
        }
    }

    private func handleRoute(_ route: NotificationRoute?) {
        guard let route else { return }
        switch route {
        case .page:
            pagePresented = route
        case .emergency(let unitId, let channelId):
            emergencyMessage = "Unit \(unitId) activated emergency on \(channelId)."
        }
    }
}

private struct PageRouteWrapper: Identifiable {
    let route: NotificationRoute
    var id: String {
        if case .page(let id, _, _) = route { return "page-\(id)" }
        return UUID().uuidString
    }
}

private struct PageDetailSheet: View {
    let route: NotificationRoute
    let onDismiss: () -> Void

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                if case .page(_, let message, let sender) = route {
                    Text("From \(sender.isEmpty ? "Dispatch" : sender)")
                        .font(.headline)
                        .foregroundColor(.cyan)
                    Text(message)
                        .font(.body)
                    Spacer()
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .navigationTitle("Page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { onDismiss() }
                }
            }
        }
    }
}
