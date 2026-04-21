import Foundation

enum SignalQuality: String {
    case none = "NONE"
    case excellent = "EXCELLENT"
    case good = "GOOD"
    case fair = "FAIR"
    case poor = "POOR"

    static func classify(lossPct: Double, jitterMs: Double, framesInWindow: Int) -> SignalQuality {
        if framesInWindow < 10 { return .none }
        if lossPct < 2.0 && jitterMs < 15.0 { return .excellent }
        if lossPct < 8.0 && jitterMs < 30.0 { return .good }
        if lossPct < 20.0 && jitterMs < 60.0 { return .fair }
        return .poor
    }
}
