import Foundation

@MainActor
final class LoginViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var errorMessage: String?

    func login(username: String, password: String, appState: AppState) async -> User? {
        guard !isLoading else { return nil }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let user = try await appState.auth.login(username: username, password: password)
            return user
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
