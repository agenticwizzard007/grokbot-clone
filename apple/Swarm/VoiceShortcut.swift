import Combine
import Foundation

struct VoiceShortcutRequest: Equatable, Sendable {
    let id = UUID().uuidString
    let createdAt: Date
    static let lifetime: TimeInterval = 300

    init(createdAt: Date = Date()) { self.createdAt = createdAt }

    func isValid(at now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(createdAt)
        return age >= 0 && age < Self.lifetime
    }
}

/// Retains a shortcut invoked before SwiftUI has created its first window.
@MainActor
final class VoiceShortcutCenter: ObservableObject {
    static let shared = VoiceShortcutCenter()
    @Published private(set) var pending: VoiceShortcutRequest?

    func request() { pending = VoiceShortcutRequest() }

    func consume(_ request: VoiceShortcutRequest) {
        if pending?.id == request.id { pending = nil }
    }
}
