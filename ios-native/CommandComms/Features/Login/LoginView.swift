import SwiftUI

struct LoginView: View {
    @EnvironmentObject var appState: AppState
    @StateObject private var viewModel = LoginViewModel()
    @State private var username: String = ""
    @State private var password: String = ""
    @State private var showPassword = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 16) {
                    Spacer(minLength: 40)

                    VStack(spacing: 4) {
                        Text("COMMAND")
                            .font(.system(size: 32, weight: .black, design: .monospaced))
                            .tracking(8)
                            .foregroundColor(.cyan)
                        Text("COMMS")
                            .font(.system(size: 32, weight: .black, design: .monospaced))
                            .tracking(8)
                            .foregroundColor(.cyan)
                        Text("REEDER SYSTEMS")
                            .font(.system(size: 10, design: .monospaced))
                            .tracking(4)
                            .foregroundColor(.gray)
                    }
                    .padding(.bottom, 24)

                    TextField("Signaling URL", text: Binding(
                        get: { appState.settings.signalingURL },
                        set: { appState.updateSignalingURL($0) }
                    ))
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)

                    HStack {
                        Image(systemName: "person.fill").foregroundColor(.gray)
                        TextField("Unit ID", text: $username)
                            .textInputAutocapitalization(.never)
                            .disableAutocorrection(true)
                            .textContentType(.username)
                    }
                    .padding(12)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.5)))

                    HStack {
                        Image(systemName: "lock.fill").foregroundColor(.gray)
                        if showPassword {
                            TextField("Password", text: $password)
                                .textInputAutocapitalization(.never)
                                .disableAutocorrection(true)
                        } else {
                            SecureField("Password", text: $password)
                                .textContentType(.password)
                        }
                        Button(action: { showPassword.toggle() }) {
                            Image(systemName: showPassword ? "eye.slash" : "eye")
                                .foregroundColor(.gray)
                        }
                    }
                    .padding(12)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray.opacity(0.5)))

                    if let error = viewModel.errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundColor(.red)
                            .multilineTextAlignment(.center)
                    }

                    Button(action: submit) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8)
                                .fill(canSubmit ? Color.cyan : Color.cyan.opacity(0.4))
                                .frame(height: 52)
                            if viewModel.isLoading {
                                ProgressView().tint(.white)
                            } else {
                                Text("SIGN IN")
                                    .font(.system(.body, design: .monospaced))
                                    .fontWeight(.bold)
                                    .tracking(3)
                                    .foregroundColor(.white)
                            }
                        }
                    }
                    .disabled(!canSubmit || viewModel.isLoading)

                    Spacer()
                }
                .padding(.horizontal, 32)
            }
        }
        .foregroundColor(.white)
    }

    private var canSubmit: Bool {
        !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty
    }

    private func submit() {
        Task {
            if let user = await viewModel.login(
                username: username.trimmingCharacters(in: .whitespaces),
                password: password,
                appState: appState
            ) {
                appState.signedIn(user)
            }
        }
    }
}

#Preview {
    LoginView().environmentObject(AppState())
}
