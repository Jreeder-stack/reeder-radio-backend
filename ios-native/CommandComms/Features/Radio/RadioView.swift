import SwiftUI
import Combine

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
    @State private var isPressing: Bool = false
    @StateObject private var ptt: PTTBinding

    init(signaling: SignalingClient, defaultChannel: String) {
        self.signaling = signaling
        self.defaultChannel = defaultChannel
        _ptt = StateObject(wrappedValue: PTTBinding(signaling: signaling))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 20) {
                        statusCard
                        channelCard
                        indicators
                        pttButton
                        accessoryStatus
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
                ptt.start()
            }
            .onDisappear {
                ptt.stop()
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
            indicator(label: "TX", color: .red, active: signaling.isTransmitting)
            indicator(label: "RX", color: .green, active: signaling.isReceiving)
            indicator(label: "PTT", color: .cyan, active: signaling.isFloorRequestPending || signaling.isTransmitting)
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

    private var pttButton: some View {
        let canTransmit = signaling.state == .authenticated && (signaling.currentChannel?.isEmpty == false)
        let active = signaling.isTransmitting || signaling.isFloorRequestPending || isPressing
        return VStack(spacing: 8) {
            ZStack {
                Circle()
                    .fill(active ? Color.red : Color.red.opacity(0.25))
                    .frame(width: 200, height: 200)
                    .overlay(Circle().stroke(Color.red, lineWidth: 4))
                    .shadow(color: active ? Color.red.opacity(0.6) : .clear, radius: 24)
                VStack(spacing: 4) {
                    Image(systemName: "mic.fill")
                        .font(.system(size: 56))
                        .foregroundColor(.white)
                    Text(active ? "TRANSMIT" : "PUSH TO TALK")
                        .font(.system(.headline, design: .monospaced))
                        .foregroundColor(.white)
                }
            }
            .opacity(canTransmit ? 1.0 : 0.4)
            .scaleEffect(active ? 1.04 : 1.0)
            .animation(.easeInOut(duration: 0.1), value: active)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard canTransmit, !isPressing else { return }
                        isPressing = true
                        signaling.requestFloor()
                    }
                    .onEnded { _ in
                        guard isPressing else { return }
                        isPressing = false
                        signaling.releaseFloor()
                    }
            )
            if let denial = signaling.lastFloorDenialReason {
                Text("Floor denied: \(denial)")
                    .font(.footnote)
                    .foregroundColor(.orange)
            }
        }
        .padding(.top, 12)
    }

    private var accessoryStatus: some View {
        Group {
            if let name = ptt.accessoryName {
                Label("MFi PTT: \(name)", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.footnote)
                    .foregroundColor(.cyan)
            } else {
                Label("No MFi PTT accessory", systemImage: "antenna.radiowaves.left.and.right.slash")
                    .font(.footnote)
                    .foregroundColor(.gray)
            }
        }
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

@MainActor
private final class PTTBinding: ObservableObject {
    @Published var accessoryName: String?

    private let signaling: SignalingClient
    private var manager: MFiPTTAccessoryManager?
    private var cancellables = Set<AnyCancellable>()

    init(signaling: SignalingClient) {
        self.signaling = signaling
    }

    func start() {
        guard manager == nil else { return }
        let mgr = MFiPTTAccessoryManager(
            onPress: { [weak self] in
                self?.signaling.requestFloor()
            },
            onRelease: { [weak self] in
                self?.signaling.releaseFloor()
            }
        )
        self.manager = mgr
        mgr.start()
        mgr.$connectedAccessoryName
            .receive(on: RunLoop.main)
            .sink { [weak self] name in
                self?.accessoryName = name
            }
            .store(in: &cancellables)
    }

    func stop() {
        manager?.stop()
        manager = nil
        cancellables.removeAll()
        accessoryName = nil
    }
}

#Preview {
    RadioView().environmentObject(AppState())
}
