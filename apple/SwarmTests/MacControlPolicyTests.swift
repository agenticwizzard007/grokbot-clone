#if os(macOS)
import XCTest

final class MacControlPolicyTests: XCTestCase {
    func testEveryCapabilityRequiresConsent() {
        let none = MacControlConsent()
        XCTAssertFalse(none.complete)
        let approved = MacControlConsent(terminal: true, files: true, browsers: true, desktop: true)
        XCTAssertTrue(approved.complete)
        for field in [\MacControlConsent.terminal, \.files, \.browsers, \.desktop] {
            var missing = approved
            missing[keyPath: field] = false
            XCTAssertFalse(missing.complete)
        }
    }

    func testBindingRejectsOtherOriginsAccountsAndSessions() throws {
        let first = try ServerAddress("https://swarm.example.com")
        let equivalent = try ServerAddress("https://SWARM.example.com:443/")
        let account = try MacControlScope(address: first, accountID: "account-a")
        XCTAssertEqual(account, try MacControlScope(address: equivalent, accountID: "account-a"))
        let binding = MacControlBinding(scope: account, sessionFingerprint: "session-a")
        let approved = MacControlConsent(terminal: true, files: true, browsers: true, desktop: true)
        XCTAssertTrue(binding.permits(binding, consent: approved))
        XCTAssertFalse(binding.permits(binding, consent: MacControlConsent()))
        let alternatives = [
            try MacControlScope(address: first, accountID: "account-b"),
            try MacControlScope(address: ServerAddress("https://swarm.example.com:444"), accountID: "account-a"),
            try MacControlScope(address: ServerAddress("https://other.example.com"), accountID: "account-a")
        ]
        for scope in alternatives {
            XCTAssertNotEqual(account.storageKey, scope.storageKey)
            XCTAssertFalse(binding.permits(MacControlBinding(scope: scope, sessionFingerprint: "session-a"), consent: approved))
        }
        XCTAssertFalse(binding.permits(MacControlBinding(scope: account, sessionFingerprint: "session-b"), consent: approved))
        XCTAssertFalse(account.storageKey.contains("account-a"))
        XCTAssertThrowsError(try MacControlScope(address: first, accountID: ""))
    }

    func testPairingCannotRedirectTheChildToAnotherServer() throws {
        let address = try ServerAddress("https://swarm.example.com")
        XCTAssertNoThrow(try MacControlPolicy.validatePairServer("https://swarm.example.com:443", address: address))
        for value in ["https://evil.test", "https://swarm.example.com.evil.test", "https://swarm.example.com:444", "https://swarm.example.com/path", "https://user@swarm.example.com", "http://swarm.example.com"] {
            XCTAssertThrowsError(try MacControlPolicy.validatePairServer(value, address: address))
        }
    }

    func testProcessArgumentsUseLocalTransportAndAFileInsteadOfTheToken() throws {
        let args = MacControlPolicy.arguments(companion: URL(fileURLWithPath: "/App Resources/swarm-companion.mjs"),
            tokenFile: URL(fileURLWithPath: "/private/random/token"), address: try ServerAddress("https://swarm.example.com"),
            parentPID: 123, playwright: URL(fileURLWithPath: "/App Resources/playwright/cli.js"))
        XCTAssertEqual(args, ["/App Resources/swarm-companion.mjs", "--desktop", "--local-device", "--token-file", "/private/random/token",
                              "--server", "https://swarm.example.com/", "--parent-pid", "123", "--playwright-mcp", "/App Resources/playwright/cli.js"])
        XCTAssertFalse(args.contains("--token"))
        XCTAssertFalse(args.contains("--run-as"))
        XCTAssertFalse(args.contains("sudo"))
    }

    func testBrowserAttachmentRequiresExplicitLoopbackApproval() throws {
        XCTAssertNil(try MacControlPolicy.browserEndpoint("", approved: false))
        XCTAssertThrowsError(try MacControlPolicy.browserEndpoint("http://localhost:9222", approved: false))
        XCTAssertEqual(try MacControlPolicy.browserEndpoint("http://localhost:9222", approved: true), "http://127.0.0.1:9222/")
        for endpoint in ["https://127.0.0.1:9222", "ws://127.0.0.1:9222/devtools/browser/123", "wss://[::1]:9222/devtools/browser/123"] {
            XCTAssertNotNil(try MacControlPolicy.browserEndpoint(endpoint, approved: true))
        }
        for endpoint in ["https://example.com:9222", "http://localhost.evil.test", "http://127.0.0.2", "http://0.0.0.0", "http://user@localhost:9222",
                         "http://localhost:9222?token=a", "http://localhost:9222#fragment", " http://localhost:9222", "http://localhost:9222/with space",
                         "file:///tmp/browser", "http://localhost:0", "http://localhost:65536", "http://localhost:9222/\\evil"] {
            XCTAssertThrowsError(try MacControlPolicy.browserEndpoint(endpoint, approved: true), endpoint)
        }
        let args = MacControlPolicy.arguments(companion: URL(fileURLWithPath: "/app/companion.mjs"), tokenFile: URL(fileURLWithPath: "/private/token"),
            address: try ServerAddress("https://swarm.example.com"), parentPID: 123, playwright: URL(fileURLWithPath: "/app/mcp.js"), browserCDP: "http://127.0.0.1:9222/")
        XCTAssertEqual(Array(args.suffix(2)), ["--browser-cdp", "http://127.0.0.1:9222/"])
    }

    func testTokenFileIsPrivateAndRemovedAfterUse() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = try MacControlTokenFile(token: "swc_secret_for_testing", temporaryDirectory: root)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.url.path)
        let folder = try FileManager.default.attributesOfItem(atPath: file.directory.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((folder[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual(try String(contentsOf: file.url), "swc_secret_for_testing")
        file.remove()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.url.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.directory.path))
    }

    func testInvalidTokensNeverReachKeychainOrChildFiles() throws {
        for value in ["", "token\nvalue", " token", "token\0value", String(repeating: "a", count: 4097)] {
            XCTAssertFalse(MacControlPolicy.validToken(value))
            XCTAssertThrowsError(try MacControlTokenFile(token: value))
        }
        XCTAssertTrue(MacControlPolicy.validToken("swc_valid-token_123"))
    }
}
#endif
