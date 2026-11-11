#if os(macOS)
import AppKit
import ApplicationServices
import Combine
import CoreGraphics
import Darwin
import WebKit

@MainActor
final class MacControlController: NSObject, ObservableObject, WKHTTPCookieStoreObserver {
    @Published var consent = MacControlConsent() {
        didSet { if !consent.complete && running { stop(message: "Access approval was withdrawn. Mac control stopped.") } }
    }
    @Published var browserEndpoint = "" {
        didSet {
            if browserEndpoint != oldValue {
                browserEndpointApproved = false
                if running || busy { stop(message: "The browser endpoint changed. Mac control stopped; review and approve again.") }
            }
        }
    }
    @Published var browserEndpointApproved = false {
        didSet {
            if !browserEndpointApproved && !browserEndpoint.isEmpty && (running || busy) {
                stop(message: "Browser attachment approval was withdrawn. Mac control stopped.")
            }
        }
    }
    @Published private(set) var accountLabel = "Not signed in"
    @Published private(set) var accountID = ""
    @Published private(set) var serverLabel: String
    @Published private(set) var stopping = false
    @Published private(set) var running = false
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published private(set) var localSelected = false
    @Published private(set) var savedPairing = false
    @Published private(set) var accessibilityAllowed = false
    @Published private(set) var screenRecordingAllowed = false
    @Published private(set) var message: String?
    @Published private(set) var failure: String?

    private var address: ServerAddress
    private let api: MacControlAPI
    private let cookieStore: WKHTTPCookieStore
    private let tokens = MacControlTokenStore()
    private var identity: MacControlIdentity?
    private var child: Process?
    private let processLifecycle = MacControlProcessLifecycle()
    private var tokenFile: MacControlTokenFile?
    private var operation: Task<Void, Never>?
    private var monitor: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var generation = UUID()
    private var refreshing = false
    private var startedAt: Date?
    private var hasConnected = false

    var browserEndpointError: String? {
        guard !browserEndpoint.isEmpty else { return nil }
        do { _ = try MacControlPolicy.browserEndpoint(browserEndpoint, approved: true); return nil }
        catch { return error.localizedDescription }
    }
    private var browserReady: Bool { browserEndpoint.isEmpty || (browserEndpointApproved && browserEndpointError == nil) }
    var canStart: Bool { identity != nil && consent.complete && browserReady && !busy && !running && !stopping }
    var canDisconnect: Bool { identity != nil && !busy && (localSelected || savedPairing || running) }
    var statusLabel: String { stopping ? "Stopping…" : running ? (connected ? "Running · connected" : "Running · connecting") : "Stopped" }

    init(cookies: WKHTTPCookieStore, address: ServerAddress) {
        self.cookieStore = cookies
        self.api = MacControlAPI(cookies: cookies)
        self.address = address
        self.serverLabel = address.url.absoluteString
        super.init()
        cookies.add(self)
        refreshPermissions()
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.shutdown() }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refreshPermissions(); await self?.refresh() }
        })
        monitor = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard !Task.isCancelled, let self else { return }
                self.refreshPermissions()
                self.processLifecycle.reap()
                self.stopping = self.processLifecycle.isStopping
                tick += 1
                if tick % 3 == 0 { await self.refresh() }
            }
        }
    }

    func refreshPermissions() {
        let previouslyAccessible = accessibilityAllowed
        let previouslyRecording = screenRecordingAllowed
        accessibilityAllowed = AXIsProcessTrusted()
        screenRecordingAllowed = CGPreflightScreenCaptureAccess()
        if running && ((previouslyAccessible && !accessibilityAllowed) || (previouslyRecording && !screenRecordingAllowed)) {
            stop(message: "A required macOS permission was withdrawn. Mac control stopped. Allow access in System Settings and approve again.")
            consent = MacControlConsent()
        }
    }

    func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        refreshPermissions()
    }

    func requestScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
        refreshPermissions()
    }

    func openPrivacy(_ pane: String) {
        let allowed = ["Privacy_Accessibility", "Privacy_ScreenCapture", "Privacy_AllFiles", "Privacy_Automation"]
        guard allowed.contains(pane), let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") else { return }
        NSWorkspace.shared.open(url)
    }

    // No web message handler can call Start; only the native consent view invokes it.
    func start() {
        guard canStart, let approved = identity else { failure = MacControlError.consent.localizedDescription; return }
        let approvedConsent = consent
        let approvedEndpoint = try? MacControlPolicy.browserEndpoint(browserEndpoint, approved: browserEndpointApproved)
        let expected = generation
        let target = address
        failure = nil
        message = "Verifying your account and bundled Mac runtime…"
        busy = true
        operation = Task { [weak self] in
            guard let self else { return }
            defer { if self.generation == expected { self.busy = false; self.operation = nil } }
            do {
                let payload = try MacControlPayload.locate(browserCDP: approvedEndpoint)
                let current = try await self.api.identity(address: target)
                try self.check(expected, binding: approved.binding, current: current.binding, consent: approvedConsent, address: target, browserEndpoint: approvedEndpoint)
                self.refreshPermissions()
                let status = try await self.api.status(identity: current, address: target)
                try self.check(expected, binding: approved.binding, current: current.binding, consent: approvedConsent, address: target, browserEndpoint: approvedEndpoint)
                var grant = try self.tokens.read(current.binding.scope)
                if !status.enabled || !status.paired { grant = nil }
                if grant == nil {
                    let token = try await self.api.pair(identity: current, address: target)
                    try self.check(expected, binding: approved.binding, current: current.binding, consent: approvedConsent, address: target, browserEndpoint: approvedEndpoint)
                    // Recheck account identity, not just the presence of a cookie, after issuing a grant.
                    let verified = try await self.api.identity(address: target)
                    try self.check(expected, binding: approved.binding, current: verified.binding, consent: approvedConsent, address: target, browserEndpoint: approvedEndpoint)
                    grant = MacControlGrant(scope: current.binding.scope, token: token, consent: approvedConsent, version: 1)
                    try self.tokens.save(grant!)
                }
                try await self.api.validate(current, address: target)
                try self.check(expected, binding: approved.binding, current: current.binding, consent: approvedConsent, address: target, browserEndpoint: approvedEndpoint)
                self.refreshPermissions()
                let file = try MacControlTokenFile(token: grant!.token)
                let process = Process()
                process.executableURL = payload.host
                process.arguments = [payload.node.path] + MacControlPolicy.arguments(companion: payload.companion, tokenFile: file.url,
                                    address: target, parentPID: getpid(), playwright: payload.playwright, browserCDP: approvedEndpoint)
                process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
                process.environment = payload.environment()
                // Companion messages can contain credentials or task data. Do not persist or echo them.
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                process.standardInput = FileHandle.nullDevice
                process.terminationHandler = { [weak self] stopped in
                    Task { @MainActor in self?.childExited(stopped) }
                }
                self.tokenFile = file
                self.child = process
                try process.run()
                self.running = true
                self.connected = false
                self.hasConnected = false
                self.startedAt = Date()
                self.localSelected = true
                self.savedPairing = true
                self.message = "Connecting this Mac. Keep Swarm open while bots use your computer."
            } catch is CancellationError { /* Stop or a context change already updated the UI. */ }
            catch {
                guard self.generation == expected else { return }
                self.stop(message: "Mac control could not start.")
                self.failure = self.safeMessage(error)
            }
        }
    }

    private func check(_ expected: UUID, binding: MacControlBinding, current: MacControlBinding, consent: MacControlConsent, address: ServerAddress, browserEndpoint: String?) throws {
        try Task.checkCancellation()
        let currentEndpoint = try MacControlPolicy.browserEndpoint(self.browserEndpoint, approved: browserEndpointApproved)
        guard currentEndpoint == browserEndpoint, generation == expected, self.address == address, identity?.binding == binding,
              binding.permits(current, consent: consent), self.consent == consent else { throw MacControlError.contextChanged }
    }

    func stop(message: String = "Mac control stopped. Your account stays in local mode while this Mac is offline.") {
        generation = UUID()
        operation?.cancel()
        operation = nil
        busy = false
        if let child { processLifecycle.stop(child) }
        stopping = processLifecycle.isStopping
        child = nil
        tokenFile?.remove()
        tokenFile = nil
        running = false
        connected = false
        startedAt = nil
        hasConnected = false
        self.message = message
    }

    func disconnect() {
        guard let approved = identity else { failure = MacControlError.signIn.localizedDescription; return }
        stop(message: "Stopping this Mac and revoking its local pairing…")
        let expected = generation
        let target = address
        busy = true
        failure = nil
        operation = Task { [weak self] in
            guard let self else { return }
            defer { if self.generation == expected { self.busy = false; self.operation = nil } }
            do {
                let current = try await self.api.identity(address: target)
                guard self.generation == expected, current.binding == approved.binding else { throw MacControlError.contextChanged }
                try await self.api.disconnect(identity: current, address: target)
                guard self.generation == expected else { return }
                try self.tokens.remove(current.binding.scope)
                self.savedPairing = false
                self.localSelected = false
                self.consent = MacControlConsent()
                self.message = "Disconnected. This account now uses the server’s default computer."
            } catch is CancellationError {}
            catch {
                guard self.generation == expected else { return }
                self.failure = "Mac control is stopped. Disconnect could not be confirmed. Your account may remain in local mode; reconnect to this server and retry Disconnect. \(self.safeMessage(error))"
            }
        }
    }

    func refresh() async {
        guard !refreshing, !busy else { return }
        refreshing = true
        defer { refreshing = false }
        let target = address
        var expected = generation
        do {
            let current = try await api.identity(address: target)
            guard generation == expected, address == target else { return }
            if let previous = identity, previous.binding != current.binding {
                forgetIdentity(message: MacControlError.contextChanged.localizedDescription)
                expected = generation
            }
            if identity == nil { failure = nil }
            identity = current
            accountLabel = current.label
            accountID = current.binding.scope.accountID
            let status = try await api.status(identity: current, address: target)
            guard generation == expected, identity?.binding == current.binding, address == target else { return }
            localSelected = status.enabled
            savedPairing = try tokens.read(current.binding.scope) != nil
            if running {
                if !status.enabled || !status.paired { stop(message: "The server disabled or revoked this Mac connection."); return }
                if status.connected {
                    guard status.desktop && status.browser else {
                        stop(message: "The companion did not report the required desktop and browser capabilities. Update the installed Mac control payload.")
                        return
                    }
                    connected = true
                    hasConnected = true
                    message = accessibilityAllowed && screenRecordingAllowed
                        ? "Bots can use this Mac for the approved account while Swarm stays open."
                        : "Terminal and Playwright are connected. Desktop screenshots need Screen Recording; clicking and typing need Accessibility. Approve them in macOS when you want desktop access."
                    // The companion has read the secret; retain only the Keychain copy.
                    tokenFile?.remove()
                    tokenFile = nil
                } else {
                    connected = false
                    if hasConnected || Date().timeIntervalSince(startedAt ?? .distantPast) > 25 {
                        stop(message: "The local companion did not stay connected. Your account remains local and offline.")
                        failure = "Check your server connection and Mac permissions. If the grant expired before first connection, use Disconnect, then approve Start again."
                    }
                }
            }
        } catch {
            guard generation == expected, address == target else { return }
            if running { stop(message: "Mac control stopped because the account or server connection could not be verified.") }
            failure = safeMessage(error)
            // Failed identity verification must not leave an old account available for Start.
            forgetIdentity(message: message)
        }
    }

    func contextChanged(address next: ServerAddress? = nil, clearAll: Bool = false) {
        forgetIdentity(message: "Mac control stopped. Sign in and approve again before using this Mac.")
        if clearAll {
            do { try tokens.removeAll() } catch { failure = safeMessage(error) }
        }
        if let next { address = next; serverLabel = next.url.absoluteString }
    }

    private func forgetIdentity(message: String?) {
        let scope = identity?.binding.scope
        stop(message: message ?? MacControlError.contextChanged.localizedDescription)
        if let scope {
            do { try tokens.remove(scope) } catch { failure = safeMessage(error) }
        }
        identity = nil
        accountLabel = "Not signed in"
        accountID = ""
        consent = MacControlConsent()
        browserEndpoint = ""
        browserEndpointApproved = false
        savedPairing = false
        localSelected = false
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor [weak self] in
            guard let self, let identity = self.identity else { return }
            do { try await self.api.validate(identity, address: self.address) }
            catch { self.forgetIdentity(message: MacControlError.contextChanged.localizedDescription) }
        }
    }

    private func childExited(_ process: Process) {
        guard child === process else { return }
        // Also reap descendants after unexpected exits. Never restart without native approval.
        stop(message: "The Mac companion stopped. Your account stays local and offline.")
        failure = "Companion exited (status \(process.terminationStatus)). Check Accessibility, Screen Recording, Automation and your server connection. For an expired or revoked pairing, Disconnect and approve again. Reinstall the complete app if its bundled runtime is missing."
    }

    private func safeMessage(_ error: Error) -> String {
        if let policy = error as? MacControlError { return policy.localizedDescription }
        if error is DecodingError { return "The server returned an unsupported Mac control response. Update the app and server together." }
        if error is URLError { return "Could not verify your server connection. Check your network and server address, then refresh." }
        return "The Mac control operation failed. Check the installed app, Keychain, and your macOS permissions, then try again."
    }

    private func shutdown() {
        monitor?.cancel()
        stop(message: "Mac control stopped because Swarm is quitting.")
        processLifecycle.finishForQuit()
        stopping = processLifecycle.isStopping
        cookieStore.remove(self)
    }
}

private struct MacControlPayload {
    let host: URL
    let node: URL
    let companion: URL
    let playwright: URL

    static func locate(browserCDP: String?) throws -> Self {
        guard getuid() != 0, geteuid() == getuid() else {
            throw MacControlError.unavailable("Open Swarm as your normal signed-in Mac user. Elevated execution is not supported.")
        }
        guard let resources = Bundle.main.resourceURL else { throw MacControlError.unavailable("The app’s resource folder is missing. Reinstall Swarm.") }
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x64"
        #endif
        let root = resources.appendingPathComponent("MacControl")
        let payload = Self(host: root.appendingPathComponent("\(architecture)/control-host"), node: root.appendingPathComponent("\(architecture)/node"),
                           companion: root.appendingPathComponent("companion/swarm-companion.mjs"), playwright: root.appendingPathComponent("playwright/node_modules/@playwright/mcp/cli.js"))
        let fm = FileManager.default
        guard fm.isExecutableFile(atPath: payload.node.path), fm.isExecutableFile(atPath: payload.host.path),
              fm.isReadableFile(atPath: payload.companion.path), fm.isReadableFile(atPath: payload.playwright.path) else {
            throw MacControlError.unavailable("This build does not include the complete Mac control runtime. Install a packaged Swarm Mac app, or stage the payload with scripts/package-apple-mac.sh. Chat and voice remain available.")
        }
        let browsers = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
                        fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Google Chrome.app/Contents/MacOS/Google Chrome").path]
        guard browserCDP != nil || browsers.contains(where: { fm.isExecutableFile(atPath: $0) }) else {
            throw MacControlError.unavailable("Playwright needs Google Chrome or Chromium on this Mac. Install it in Applications, then start again. Your everyday browser can also be controlled through the approved desktop.")
        }
        return payload
    }

    func environment() -> [String: String] {
        // Avoid inheriting NODE_OPTIONS, DYLD injection, cloud credentials, or a toolchain HOME.
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let shell = getpwuid(getuid()).flatMap { $0.pointee.pw_shell }.map { String(cString: $0) } ?? "/bin/zsh"
        return ["HOME": home, "USER": NSUserName(), "LOGNAME": NSUserName(), "SHELL": shell,
                "PATH": node.deletingLastPathComponent().path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
                "TMPDIR": NSTemporaryDirectory(), "LANG": "en_US.UTF-8", "LC_CTYPE": "UTF-8"]
    }
}
#endif
