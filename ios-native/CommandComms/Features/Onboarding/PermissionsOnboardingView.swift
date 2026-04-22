import SwiftUI

struct PermissionsOnboardingView: View {
    @ObservedObject var coordinator: PermissionsCoordinator
    @State private var stepIndex: Int = 0
    @State private var requesting: Bool = false

    private let steps = PermissionsCoordinator.Step.allCases

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 28) {
                header

                Spacer(minLength: 0)

                if stepIndex < steps.count {
                    rationaleCard(for: steps[stepIndex])
                }

                Spacer(minLength: 0)

                progressDots
                actionButtons
            }
            .padding(24)
        }
        .foregroundColor(.white)
        .task {
            await advancePastDecidedSteps()
        }
    }

    // MARK: - Subviews

    private var header: some View {
        VStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right.circle.fill")
                .font(.system(size: 56))
                .foregroundColor(.cyan)
            Text("Set up Command Comms")
                .font(.title2.bold())
            Text("Grant a few permissions so the radio works the moment you need it.")
                .font(.footnote)
                .foregroundColor(.gray)
                .multilineTextAlignment(.center)
        }
    }

    private func rationaleCard(for step: PermissionsCoordinator.Step) -> some View {
        VStack(spacing: 16) {
            Image(systemName: icon(for: step))
                .font(.system(size: 44))
                .foregroundColor(.cyan)
            Text(title(for: step))
                .font(.title3.bold())
            Text(rationale(for: step))
                .font(.body)
                .foregroundColor(.white.opacity(0.85))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(24)
        .background(Color.white.opacity(0.05))
        .cornerRadius(16)
    }

    private var progressDots: some View {
        HStack(spacing: 8) {
            ForEach(0..<steps.count, id: \.self) { i in
                Circle()
                    .fill(i <= stepIndex ? Color.cyan : Color.white.opacity(0.2))
                    .frame(width: 8, height: 8)
            }
        }
    }

    private var actionButtons: some View {
        VStack(spacing: 12) {
            Button {
                Task { await handleContinue() }
            } label: {
                Text(continueTitle)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .tint(.cyan)
            .disabled(requesting)

            Button("Skip") {
                Task { await handleSkip() }
            }
            .foregroundColor(.gray)
            .disabled(requesting)
        }
    }

    // MARK: - Behavior

    private var continueTitle: String {
        guard stepIndex < steps.count else { return "Continue" }
        switch steps[stepIndex] {
        case .microphone: return "Allow Microphone"
        case .notifications: return "Allow Notifications"
        case .location: return "Allow Location"
        }
    }

    private func handleContinue() async {
        guard stepIndex < steps.count else { return }
        requesting = true
        defer { requesting = false }
        switch steps[stepIndex] {
        case .microphone:
            await coordinator.requestMicrophone()
        case .notifications:
            await coordinator.requestNotifications()
        case .location:
            await coordinator.requestLocationWhenInUse()
        }
        await advance()
    }

    private func handleSkip() async {
        requesting = true
        defer { requesting = false }
        await advance()
    }

    private func advance() async {
        stepIndex += 1
        await advancePastDecidedSteps()
        if stepIndex >= steps.count {
            coordinator.markComplete()
        }
    }

    private func advancePastDecidedSteps() async {
        while stepIndex < steps.count, await coordinator.isDecided(steps[stepIndex]) {
            stepIndex += 1
        }
        if stepIndex >= steps.count {
            coordinator.markComplete()
        }
    }

    // MARK: - Copy

    private func icon(for step: PermissionsCoordinator.Step) -> String {
        switch step {
        case .microphone: return "mic.fill"
        case .notifications: return "bell.badge.fill"
        case .location: return "location.fill"
        }
    }

    private func title(for step: PermissionsCoordinator.Step) -> String {
        switch step {
        case .microphone: return "Microphone"
        case .notifications: return "Notifications"
        case .location: return "Location"
        }
    }

    private func rationale(for step: PermissionsCoordinator.Step) -> String {
        switch step {
        case .microphone:
            return "We need the microphone so you can transmit push-to-talk audio to your channel."
        case .notifications:
            return "Notifications let dispatch reach you with pages and channel alerts when the app is in the background."
        case .location:
            return "Sharing your location while the app is open lets dispatch see your unit position on the map."
        }
    }
}
