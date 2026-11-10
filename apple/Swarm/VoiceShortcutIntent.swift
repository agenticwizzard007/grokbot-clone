#if os(iOS)
import AppIntents

struct TalkToSwarmIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to Swarm"
    static var description = IntentDescription("Open a voice conversation with your main Swarm agent. Speak your request and your agent will take it from there.")
    // Also supports iOS 17–25, before supportedModes was introduced.
    static var openAppWhenRun: Bool = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @MainActor
    func perform() async throws -> some IntentResult {
        VoiceShortcutCenter.shared.request()
        return .result()
    }
}

struct SwarmShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: TalkToSwarmIntent(),
            phrases: ["Talk to \(.applicationName)", "Start a voice chat in \(.applicationName)"],
            shortTitle: "Talk to Swarm",
            systemImageName: "waveform"
        )
    }
}
#endif
