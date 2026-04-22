import SwiftUI

@main
struct CommandCommsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(appState)
                .environmentObject(NotificationRouter.shared)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        RootContent(permissions: appState.permissions, appState: appState)
    }
}

private struct RootContent: View {
    @ObservedObject var permissions: PermissionsCoordinator
    @ObservedObject var appState: AppState

    var body: some View {
        Group {
            if !permissions.isComplete {
                PermissionsOnboardingView(coordinator: permissions)
            } else {
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
