import Foundation

/// User-selectable accessory model. Each model maps to a parser that knows how
/// to interpret that vendor's framing on the External Accessory input stream.
enum PTTAccessoryModel: String, CaseIterable, Codable, Identifiable {
    case generic
    case bluParrott
    case savox
    case pryme
    case reederSystems

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .generic: return "Generic / Auto-detect"
        case .bluParrott: return "BluParrott (B150 / BP200)"
        case .savox: return "Savox Communications"
        case .pryme: return "Pryme BT / PTT"
        case .reederSystems: return "Reeder Systems PTT"
        }
    }

    func makeParser() -> PTTFrameParser {
        switch self {
        case .generic: return GenericFirstBytePTTParser()
        case .bluParrott: return BluParrottPTTParser()
        case .savox: return SavoxPTTParser()
        case .pryme: return PrymePTTParser()
        case .reederSystems: return GenericFirstBytePTTParser()
        }
    }
}

enum PTTEvent {
    case pressed
    case released
}

/// Vendor-specific frame parser. Implementations are stateful and may emit zero
/// or more events per chunk of bytes received from the EA input stream.
protocol PTTFrameParser: AnyObject {
    func parse(_ bytes: UnsafePointer<UInt8>, count: Int) -> [PTTEvent]
}

/// Tracks the last reported pressed state so duplicate frames are coalesced.
private final class PressStateTracker {
    private(set) var isPressed: Bool = false

    func update(to pressed: Bool) -> PTTEvent? {
        guard pressed != isPressed else { return nil }
        isPressed = pressed
        return pressed ? .pressed : .released
    }
}

/// Default parser: any non-zero first byte means pressed. Used as the universal
/// fallback when the user hasn't picked a specific accessory model.
final class GenericFirstBytePTTParser: PTTFrameParser {
    private let tracker = PressStateTracker()

    func parse(_ bytes: UnsafePointer<UInt8>, count: Int) -> [PTTEvent] {
        guard count > 0 else { return [] }
        if let event = tracker.update(to: bytes[0] != 0) {
            return [event]
        }
        return []
    }
}

/// BluParrott B150 / BP200 framing: every report begins with a 0x01 report id;
/// the next byte is a bit field where bit 0 indicates the PTT button state.
final class BluParrottPTTParser: PTTFrameParser {
    private let tracker = PressStateTracker()

    func parse(_ bytes: UnsafePointer<UInt8>, count: Int) -> [PTTEvent] {
        var events: [PTTEvent] = []
        var i = 0
        while i < count {
            // Look for report id 0x01 followed by a state byte.
            if bytes[i] == 0x01, i + 1 < count {
                let pressed = (bytes[i + 1] & 0x01) != 0
                if let event = tracker.update(to: pressed) {
                    events.append(event)
                }
                i += 2
            } else {
                // Older BluParrott firmware sends single-byte 0x01/0x00 frames.
                if let event = tracker.update(to: bytes[i] != 0) {
                    events.append(event)
                }
                i += 1
            }
        }
        return events
    }
}

/// Savox Communications PTT: sends two-byte frames where byte 0 is a 0x02
/// report id and byte 1 is the state (0x01 pressed, 0x00 released). Frames
/// without the report id are ignored to avoid mistaking telemetry for a press.
final class SavoxPTTParser: PTTFrameParser {
    private let tracker = PressStateTracker()

    func parse(_ bytes: UnsafePointer<UInt8>, count: Int) -> [PTTEvent] {
        var events: [PTTEvent] = []
        var i = 0
        while i + 1 < count {
            if bytes[i] == 0x02 {
                let pressed = bytes[i + 1] != 0
                if let event = tracker.update(to: pressed) {
                    events.append(event)
                }
                i += 2
            } else {
                i += 1
            }
        }
        return events
    }
}

/// Pryme BT button: emits 4-byte HID-over-EA frames `[0xA1, modifier, key, 0]`
/// where the key byte is non-zero while the PTT button is held down.
final class PrymePTTParser: PTTFrameParser {
    private let tracker = PressStateTracker()

    func parse(_ bytes: UnsafePointer<UInt8>, count: Int) -> [PTTEvent] {
        var events: [PTTEvent] = []
        var i = 0
        while i + 3 < count {
            if bytes[i] == 0xA1 {
                let pressed = bytes[i + 2] != 0
                if let event = tracker.update(to: pressed) {
                    events.append(event)
                }
                i += 4
            } else {
                i += 1
            }
        }
        // If the device is in single-byte fallback mode, treat trailing bytes
        // as generic press/release signals.
        if events.isEmpty, count > 0, i == 0 {
            if let event = tracker.update(to: bytes[0] != 0) {
                events.append(event)
            }
        }
        return events
    }
}
