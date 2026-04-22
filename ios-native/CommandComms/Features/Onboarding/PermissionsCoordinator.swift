import Foundation
import AVFoundation
import CoreLocation
import UserNotifications
import UIKit

@MainActor
final class PermissionsCoordinator: ObservableObject {
    enum Step: Int, CaseIterable {
        case microphone
        case notifications
        case location
    }

    @Published private(set) var isComplete: Bool

    private let locationTracker: LocationTracker
    private let userDefaults: UserDefaults
    private let completedKey = "onboarding.permissions.completed.v1"

    init(locationTracker: LocationTracker, userDefaults: UserDefaults = .standard) {
        self.locationTracker = locationTracker
        self.userDefaults = userDefaults
        self.isComplete = userDefaults.bool(forKey: completedKey)
    }

    func markComplete() {
        userDefaults.set(true, forKey: completedKey)
        isComplete = true
    }

    func resetForTesting() {
        userDefaults.removeObject(forKey: completedKey)
        isComplete = false
    }

    // MARK: - Status checks

    /// Returns true when the user has already responded (granted or denied).
    func isDecided(_ step: Step) async -> Bool {
        switch step {
        case .microphone:
            return micStatus() != .undetermined
        case .notifications:
            let status = await notificationStatus()
            return status != .notDetermined
        case .location:
            let status = locationTracker.authorizationStatus
            return status != .notDetermined
        }
    }

    func micStatus() -> AVAudioSession.RecordPermission {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return .granted
            case .denied: return .denied
            case .undetermined: return .undetermined
            @unknown default: return .undetermined
            }
        } else {
            return AVAudioSession.sharedInstance().recordPermission
        }
    }

    func notificationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    func locationStatus() -> CLAuthorizationStatus {
        locationTracker.authorizationStatus
    }

    // MARK: - Requests

    @discardableResult
    func requestMicrophone() async -> Bool {
        await withCheckedContinuation { continuation in
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    @discardableResult
    func requestNotifications() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])
            if granted {
                UIApplication.shared.registerForRemoteNotifications()
            }
            return granted
        } catch {
            return false
        }
    }

    /// Requests When-In-Use authorization. Returns when the user has responded
    /// to the prompt (or immediately if already decided).
    func requestLocationWhenInUse() async {
        guard locationTracker.authorizationStatus == .notDetermined else { return }
        locationTracker.requestWhenInUse()
        // Poll until the status changes off .notDetermined. The system prompt
        // dispatches synchronously on iOS, but the delegate callback that
        // updates `authorizationStatus` is async, so wait for it.
        let deadline = Date().addingTimeInterval(60)
        while locationTracker.authorizationStatus == .notDetermined && Date() < deadline {
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
    }
}
