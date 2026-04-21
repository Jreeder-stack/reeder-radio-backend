import SwiftUI

@main
struct CommandCommsApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        Group {
            switch appState.authStatus {
            case .checking:
                LoadingView()
            case .signedOut:
                LoginView()
            case .signedIn:
                MainShellView()
            }
        }
    }
}

struct LoadingView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ProgressView()
                .progressViewStyle(.circular)
                .tint(.cyan)
        }
    }
}
