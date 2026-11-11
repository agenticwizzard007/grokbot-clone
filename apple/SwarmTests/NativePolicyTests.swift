import XCTest

final class NativePolicyTests: XCTestCase {
    func testVoiceShortcutExpiresRatherThanStartingUnexpectedlyLater() {
        let now = Date()
        let request = VoiceShortcutRequest(createdAt: now)
        XCTAssertTrue(request.isValid(at: now))
        XCTAssertTrue(request.isValid(at: now.addingTimeInterval(299)))
        XCTAssertFalse(request.isValid(at: now.addingTimeInterval(300)))
        XCTAssertFalse(request.isValid(at: now.addingTimeInterval(-1)))
        XCTAssertNotEqual(request.id, VoiceShortcutRequest(createdAt: now).id)
    }

    @MainActor
    func testVoiceShortcutSurvivesColdLaunchAndCoalescesRepeatedRequests() {
        let center = VoiceShortcutCenter()
        center.request()
        let first = center.pending!
        center.request()
        let second = center.pending!
        center.consume(first)
        XCTAssertEqual(center.pending, second)
        center.consume(second)
        XCTAssertNil(center.pending)
    }

    #if os(iOS)
    @MainActor
    func testActionButtonIntentQueuesTheMainAgentVoiceRequest() async throws {
        _ = try await TalkToSwarmIntent().perform()
        let request = try XCTUnwrap(VoiceShortcutCenter.shared.pending)
        XCTAssertTrue(request.isValid())
        VoiceShortcutCenter.shared.consume(request)
        XCTAssertTrue(TalkToSwarmIntent.openAppWhenRun)
    }
    #endif

    func testServerValidationAndOriginBoundary() throws {
        let address = try ServerAddress(" https://SWARM.example.com ")
        XCTAssertEqual(address.url.absoluteString, "https://swarm.example.com/")
        XCTAssertTrue(address.contains(URL(string: "https://swarm.example.com:443/api/events")!))
        for value in ["https://swarm.example.com.evil.test/", "https://swarm.example.com:444/", "http://swarm.example.com/", "https://user@swarm.example.com/"] {
            XCTAssertFalse(address.contains(URL(string: value)!))
        }
        for value in ["javascript:alert(1)", "file:///etc/passwd", "http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=a", "https://example.com/#fragment", "https://example.com:0"] {
            XCTAssertThrowsError(try ServerAddress(value))
        }
        XCTAssertThrowsError(try ServerAddress("http://localhost:8787"))
        XCTAssertNoThrow(try ServerAddress("http://localhost:8787", allowLocalHTTP: true))
        XCTAssertThrowsError(try ServerAddress("http://localhost.evil.test:8787", allowLocalHTTP: true))
    }

    func testReleaseDefaultServerOrigin() {
        XCTAssertEqual(ServerAddress.defaultURL(configuration: ["SwarmDefaultServerOrigin": "https://PLATFORM.example.com"]).absoluteString,
                       "https://platform.example.com/")
        for value in ["http://localhost:8787", "https://user@example.com", "https://example.com/path", "https://example.com?token=secret", "not a URL"] {
            XCTAssertEqual(ServerAddress.defaultURL(configuration: ["SwarmDefaultServerOrigin": value]).absoluteString,
                           "https://swarm-team.fly.dev")
        }
        XCTAssertEqual(ServerAddress.defaultURL(configuration: [:]).absoluteString, "https://swarm-team.fly.dev")
    }

    func testSignInRejectsUnsolicitedAndAmbiguousCallbacks() throws {
        let attempt = try SignInAttempt()
        let other = try SignInAttempt()
        XCTAssertEqual(attempt.verifier.count, 43)
        XCTAssertEqual(attempt.challenge.count, 43)
        XCTAssertNotEqual(attempt.verifier, other.verifier)
        let code = String(repeating: "a", count: 43)
        XCTAssertEqual(try attempt.code(from: URL(string: "so.swarms.app://auth?code=\(code)&state=\(attempt.state)")!), code)
        for callback in [
            "so.swarms.app://auth?code=\(code)&state=\(other.state)",
            "so.swarms.app://connected?code=\(code)&state=\(attempt.state)",
            "https://auth?code=\(code)&state=\(attempt.state)",
            "so.swarms.app://auth?code=\(code)&state=\(attempt.state)&state=\(attempt.state)",
            "so.swarms.app://auth?code=\(code)&state=\(attempt.state)&error=failed",
            "so.swarms.app://auth?code=short&state=\(attempt.state)"
        ] { XCTAssertThrowsError(try attempt.code(from: URL(string: callback)!)) }
    }
}
