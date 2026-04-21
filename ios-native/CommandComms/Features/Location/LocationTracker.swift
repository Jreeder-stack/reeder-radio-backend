import Foundation
import CoreLocation
import Combine

@MainActor
final class LocationTracker: NSObject, ObservableObject {
    @Published private(set) var authorizationStatus: CLAuthorizationStatus
    @Published private(set) var isTracking: Bool = false
    @Published private(set) var lastFix: CLLocation?

    weak var signaling: SignalingClient?

    private let manager = CLLocationManager()
    private var lastSentTime: Date = .distantPast
    private var oneShotPending: Bool = false
    private var wantsTracking: Bool = false

    private let stationarySpeedThreshold: CLLocationSpeed = 1.0
    private let stationarySendInterval: TimeInterval = 90
    private let oneShotCacheMaxAge: TimeInterval = 5

    override init() {
        self.authorizationStatus = CLLocationManager().authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5
        manager.pausesLocationUpdatesAutomatically = false
        manager.activityType = .automotiveNavigation
        manager.showsBackgroundLocationIndicator = true
    }

    func requestWhenInUse() {
        if authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    func startTracking() {
        wantsTracking = true
        switch authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            manager.requestAlwaysAuthorization()
            beginUpdates(background: false)
        case .authorizedAlways:
            beginUpdates(background: true)
        default:
            break
        }
    }

    func stopTracking() {
        wantsTracking = false
        guard isTracking else { return }
        manager.stopUpdatingLocation()
        manager.allowsBackgroundLocationUpdates = false
        isTracking = false
    }

    /// Captures a single fix and emits a `location:update`. Intended to be
    /// called on PTT press alongside TX start, mirroring Android behavior.
    func requestOneShotFix() {
        let status = authorizationStatus
        guard status == .authorizedWhenInUse || status == .authorizedAlways else { return }

        if let cached = manager.location,
           Date().timeIntervalSince(cached.timestamp) < oneShotCacheMaxAge {
            emit(location: cached, force: true)
            return
        }
        oneShotPending = true
        manager.requestLocation()
    }

    private func beginUpdates(background: Bool) {
        if background {
            manager.allowsBackgroundLocationUpdates = true
        }
        manager.startUpdatingLocation()
        isTracking = true
    }

    private func emit(location: CLLocation, force: Bool) {
        let now = Date()
        let speed = max(location.speed, 0)
        let elapsed = now.timeIntervalSince(lastSentTime)
        if !force {
            let isMoving = speed >= stationarySpeedThreshold
            if !isMoving && elapsed < stationarySendInterval { return }
        }
        lastSentTime = now
        lastFix = location
        signaling?.emitLocationUpdate(
            latitude: location.coordinate.latitude,
            longitude: location.coordinate.longitude,
            accuracy: location.horizontalAccuracy,
            heading: location.course >= 0 ? location.course : nil,
            speed: location.speed >= 0 ? location.speed : nil
        )
    }
}

extension LocationTracker: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorizationStatus = status
            guard self.wantsTracking else { return }
            switch status {
            case .authorizedWhenInUse:
                manager.requestAlwaysAuthorization()
                self.beginUpdates(background: false)
            case .authorizedAlways:
                self.beginUpdates(background: true)
            default:
                break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor in
            let force = self.oneShotPending
            self.oneShotPending = false
            self.emit(location: latest, force: force)
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            self.oneShotPending = false
        }
    }
}
