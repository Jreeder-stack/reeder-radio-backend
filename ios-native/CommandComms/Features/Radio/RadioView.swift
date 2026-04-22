import SwiftUI
import Combine
import AVFoundation
import CoreLocation
import UserNotifications

struct RadioView: View {
    @EnvironmentObject var appState: AppState
    @EnvironmentObject var emergencyCenter: EmergencyAlertCenter

    var body: some View {
        RadioContent(
            signaling: appState.signaling,
            radio: appState.radio,
            locationTracker: appState.locationTracker,
            permissions: appState.permissions,
            emergencyCenter: emergencyCenter,
            defaultChannel: appState.settings.defaultChannelId,
            accessoryModel: appState.settings.pttAccessoryModel
        )
    }
}

private struct RadioContent: View {
    @ObservedObject var signaling: SignalingClient
    @ObservedObject var radio: RadioAudioEngine
    @ObservedObject var locationTracker: LocationTracker
    @ObservedObject var permissions: PermissionsCoordinator
    @ObservedObject var emergencyCenter: EmergencyAlertCenter
    let defaultChannel: String
    @State private var channelInput: String = ""
    @State private var micPermissionDenied: Bool = false
    @StateObject private var ptt: PTTBinding
    @Environment(\.scenePhase) private var scenePhase

    let accessoryModel: PTTAccessoryModel

    init(signaling: SignalingClient,
         radio: RadioAudioEngine,
         locationTracker: LocationTracker,
         permissions: PermissionsCoordinator,
         emergencyCenter: EmergencyAlertCenter,
         defaultChannel: String,
         accessoryModel: PTTAccessoryModel) {
        self.signaling = signaling
        self.radio = radio
        self.locationTracker = locationTracker
        self.permissions = permissions
        self.emergencyCenter = emergencyCenter
        self.defaultChannel = defaultChannel
        self.accessoryModel = accessoryModel
        _ptt = StateObject(wrappedValue: PTTBinding(radio: radio,
                                                    accessoryModel: accessoryModel))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 20) {
                        if let alert = emergencyCenter.active {
                            emergencyBanner(alert: alert)
                        }
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
                refreshMicPermissionStatus()
                Task { await permissions.refreshNotificationStatus() }
                ptt.start()
                ptt.updateAccessoryModel(accessoryModel)
            }
            .onChange(of: accessoryModel) { newModel in
                ptt.updateAccessoryModel(newModel)
            }
            .onChange(of: scenePhase) { phase in
                if phase == .active {
                    refreshMicPermissionStatus()
                    locationTracker.refreshAuthorizationStatus()
                    Task { await permissions.refreshNotificationStatus() }
                }
            }
            .onDisappear {
                ptt.stop()
            }
        }
        .foregroundColor(.white)
    }

    private func emergencyBanner(alert: EmergencyAlert) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.white)
                Text("EMERGENCY")
                    .font(.system(.headline, design: .monospaced))
                    .foregroundColor(.white)
                Spacer()
                Button {
                    emergencyCenter.clear()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(.white.opacity(0.85))
                }
                .buttonStyle(.plain)
            }
            Text("Unit \(alert.unitId) in distress")
                .font(.title3.bold())
                .foregroundColor(.white)
            Text("Channel: \(alert.channelId)")
                .font(.system(.footnote, design: .monospaced))
                .foregroundColor(.white.opacity(0.85))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.red.opacity(0.85))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.white.opacity(0.6), lineWidth: 1)
        )
        .shadow(color: Color.red.opacity(0.6), radius: 12)
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
                Spacer()
                Text("UDP \(radio.transportHealth.rawValue.uppercased())")
                    .font(.caption2)
                    .foregroundColor(udpColor)
            }
            if let err = signaling.lastError ?? radio.lastError {
                Text(err).font(.footnote).foregroundColor(.red)
            }
            if micPermissionDenied {
                permissionBanner(message: "Microphone disabled — enable it to transmit.")
            }
            if locationPermissionDenied {
                permissionBanner(message: "Location disabled — dispatch can't see you on the map.")
            }
            if notificationsPermissionDenied {
                permissionBanner(message: "Notifications disabled — you won't get alerts.")
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
                    radio.channelId = channelInput
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
            if let tx = radio.transmittingUnitId {
                Text("Transmitting: \(tx)")
                    .font(.caption)
                    .foregroundColor(.green)
            }
            if let denial = signaling.lastFloorDenialReason {
                Text("Floor denied: \(denial)")
                    .font(.footnote)
                    .foregroundColor(.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.white.opacity(0.05))
        .cornerRadius(12)
    }

    private var indicators: some View {
        HStack(spacing: 16) {
            indicator(label: "TX", color: .red, active: radio.state == .transmitting)
            indicator(label: "RX", color: .green, active: radio.transmittingUnitId != nil && radio.state != .transmitting)
            indicator(label: "REQ", color: .yellow, active: radio.state == .requestingFloor)
            indicator(label: "BUSY", color: .orange, active: radio.state == .channelBusy)
        }
    }

    private var pttButton: some View {
        let pressed = radio.state == .transmitting || radio.state == .requestingFloor
        return ZStack {
            Circle()
                .fill(pressed ? Color.red : Color.red.opacity(0.25))
                .frame(width: 200, height: 200)
                .overlay(Circle().stroke(Color.red, lineWidth: 4))
                .shadow(color: pressed ? Color.red.opacity(0.6) : .clear, radius: 24)
            VStack(spacing: 4) {
                Image(systemName: "mic.fill")
                    .font(.system(size: 48))
                    .foregroundColor(.white)
                Text(pressed ? "TRANSMITTING" : "PUSH TO TALK")
                    .font(.system(.headline, design: .monospaced))
                    .foregroundColor(.white)
                Text(radio.state.rawValue.uppercased())
                    .font(.caption2)
                    .foregroundColor(.white.opacity(0.8))
            }
        }
        .contentShape(Circle())
        .scaleEffect(pressed ? 1.04 : 1.0)
        .animation(.easeInOut(duration: 0.1), value: pressed)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pressed { radio.pttPressed() }
                }
                .onEnded { _ in
                    radio.pttReleased()
                }
        )
        .opacity(pttEnabled ? 1.0 : 0.4)
        .allowsHitTesting(pttEnabled)
        .padding(.top, 12)
    }

    private var pttEnabled: Bool {
        signaling.state == .authenticated &&
        signaling.currentChannel != nil &&
        radio.transportHealth == .connected &&
        !micPermissionDenied
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

    private var udpColor: Color {
        switch radio.transportHealth {
        case .connected: return .green
        case .reconnecting: return .yellow
        case .disconnected: return .gray
        }
    }

    private func permissionBanner(message: String) -> some View {
        HStack(spacing: 8) {
            Text(message)
                .font(.footnote).foregroundColor(.orange)
            Spacer()
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            .font(.footnote)
            .foregroundColor(.cyan)
        }
    }

    private var locationPermissionDenied: Bool {
        switch locationTracker.authorizationStatus {
        case .denied, .restricted: return true
        default: return false
        }
    }

    private var notificationsPermissionDenied: Bool {
        permissions.notificationAuthorization == .denied
    }

    private func refreshMicPermissionStatus() {
        let status: AVAudioSession.RecordPermission
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: status = .granted
            case .denied: status = .denied
            case .undetermined: status = .undetermined
            @unknown default: status = .undetermined
            }
        } else {
            status = AVAudioSession.sharedInstance().recordPermission
        }
        micPermissionDenied = (status == .denied)
    }
}

@MainActor
private final class PTTBinding: ObservableObject {
    @Published var accessoryName: String?

    private let radio: RadioAudioEngine
    private var manager: MFiPTTAccessoryManager?
    private var accessoryModel: PTTAccessoryModel
    private var cancellables = Set<AnyCancellable>()

    init(radio: RadioAudioEngine, accessoryModel: PTTAccessoryModel) {
        self.radio = radio
        self.accessoryModel = accessoryModel
    }

    func updateAccessoryModel(_ model: PTTAccessoryModel) {
        accessoryModel = model
        manager?.setAccessoryModel(model)
    }

    func start() {
        guard manager == nil else { return }
        let mgr = MFiPTTAccessoryManager(
            accessoryModel: accessoryModel,
            onPress: { [weak self] in
                self?.radio.pttPressed()
            },
            onRelease: { [weak self] in
                self?.radio.pttReleased()
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
    RadioView()
        .environmentObject(AppState())
        .environmentObject(EmergencyAlertCenter.shared)
}
