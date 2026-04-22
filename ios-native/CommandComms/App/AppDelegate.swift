import UIKit
import UserNotifications

/// Routing intent emitted from a tapped notification, consumed by the SwiftUI
/// shell to navigate to the relevant view (Pages tab, emergency banner, etc.).
enum NotificationRoute: Equatable {
    case page(id: String, message: String, sender: String)
    case emergency(unitId: String, channelId: String)
}

/// Shared, observable router so SwiftUI views can react to taps on remote
/// notifications. Lives as a singleton because UNUserNotificationCenterDelegate
/// callbacks happen outside SwiftUI's environment.
@MainActor
final class NotificationRouter: ObservableObject {
    static let shared = NotificationRouter()
    @Published var pending: NotificationRoute?
    private init() {}

    func consume() -> NotificationRoute? {
        let route = pending
        pending = nil
        return route
    }
}

/// AppDelegate adaptor used by SwiftUI to receive APNs registration callbacks
/// and remote notification payloads. The matching service that forwards the
/// hex token to the backend lives in `PushNotificationService`.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self

        // If the user is already authorized (e.g. permission granted in a prior
        // launch), make sure we re-register on every cold start so APNs can
        // hand us a fresh token if the previous one was invalidated.
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .authorized {
                DispatchQueue.main.async {
                    UIApplication.shared.registerForRemoteNotifications()
                }
            }
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        print("[Push] APNs token received: \(hex.prefix(12))… (\(hex.count) chars)")
        PushNotificationService.shared.handleNewToken(hex)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[Push] APNs registration failed: \(error.localizedDescription)")
    }

    // Foreground presentation: still show the alert + play sound, and also
    // capture the payload into the in-app history so the Pages tab is fresh
    // even if the user hasn't tapped the notification yet.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        recordIncoming(userInfo: notification.request.content.userInfo)
        completionHandler([.banner, .sound, .list])
    }

    // Tap handling: route the user to the relevant screen.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let type = (info["type"] as? String) ?? ""
        switch type {
        case "page":
            let id = (info["pageId"] as? String) ?? ""
            let message = (info["message"] as? String) ?? ""
            let sender = (info["sender"] as? String) ?? ""
            Task { @MainActor in
                PageHistoryStore.shared.record(id: id, message: message, sender: sender)
                NotificationRouter.shared.pending = .page(id: id, message: message, sender: sender)
            }
        case "emergency":
            let unitId = (info["unitId"] as? String) ?? ""
            let channelId = (info["channelId"] as? String) ?? ""
            Task { @MainActor in
                NotificationRouter.shared.pending = .emergency(unitId: unitId, channelId: channelId)
            }
        default:
            break
        }
        completionHandler()
    }

    /// Mirrors a notification payload into the in-app stores so the Pages tab
    /// stays in sync with delivered notifications even before they're tapped.
    private func recordIncoming(userInfo: [AnyHashable: Any]) {
        let type = (userInfo["type"] as? String) ?? ""
        switch type {
        case "page":
            let id = (userInfo["pageId"] as? String) ?? ""
            let message = (userInfo["message"] as? String) ?? ""
            let sender = (userInfo["sender"] as? String) ?? ""
            Task { @MainActor in
                PageHistoryStore.shared.record(id: id, message: message, sender: sender)
            }
        default:
            break
        }
    }
}
