import SwiftUI

struct RadioView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        RadioContent(signaling: appState.signaling, defaultChannel: appState.settings.defaultChannelId)
    }
}

private struct RadioContent: View {
    @ObservedObject var signaling: SignalingClient
    let defaultChannel: String
    @State private var channelInput: String = ""

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 20) {
                        statusCard
                        channelCard
                        indicators
                        Spacer(minLength: 40)
                    }
                    .padding()
                }
            }
            .navigationTitle("Radio")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .onAppear {
                channelInput = signaling.currentChannel ?? defaultChannel
            }
        }
        .foregroundColor(.white)
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CONNECTION").font(.caption).foregroundColor(.gray).tracking(2)
            HStack(spacing: 12) {
                Circle()
                    .fill(stateColor)
                    .frame(width: 12, height: 12)
                Text(signaling.state.rawValue.uppercased())
                    .font(.system(.title3, design: .monospaced))
                    .foregroundColor(.cyan)
            }
            if let err = signaling.lastError {
                Text(err).font(.footnote).foregroundColor(.red)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.white.opacity(0.05))
        .cornerRadius(12)
    }

    private var channelCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CHANNEL").font(.caption).foregroundColor(.gray).tracking(2)
            HStack {
                TextField("Channel ID", text: $channelInput)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .disableAutocorrection(true)
                Button("Join") {
                    signaling.joinChannel(channelInput)
                }
                .buttonStyle(.borderedProminent)
                .tint(.cyan)
                .disabled(signaling.state != .authenticated || channelInput.isEmpty)
            }
            if let active = signaling.currentChannel {
                Text("Active: \(active)")
                    .font(.system(.body, design: .monospaced))
                    .foregroundColor(.cyan)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.white.opacity(0.05))
        .cornerRadius(12)
    }

    private var indicators: some View {
        HStack(spacing: 16) {
            indicator(label: "TX", color: .red, active: false)
            indicator(label: "RX", color: .green, active: false)
            indicator(label: "PTT", color: .cyan, active: false)
        }
    }

    private func indicator(label: String, color: Color, active: Bool) -> some View {
        VStack(spacing: 6) {
            Circle()
                .fill(active ? color : color.opacity(0.2))
                .frame(width: 56, height: 56)
                .overlay(Circle().stroke(color, lineWidth: 2))
            Text(label)
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(.gray)
        }
        .frame(maxWidth: .infinity)
    }

    private var stateColor: Color {
        switch signaling.state {
        case .authenticated: return .green
        case .connected: return .yellow
        case .connecting: return .orange
        case .disconnected: return .red
        }
    }
}

#Preview {
    RadioView().environmentObject(AppState())
}
