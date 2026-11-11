import Foundation
import CryptoKit

// Pure policy shared by the macOS app and native policy tests. No credentials in defaults.
struct MacControlScope: Codable, Equatable {
    let origin: String
    let accountID: String

    init(address: ServerAddress, accountID: String) throws {
        guard !accountID.isEmpty, accountID.count <= 256 else { throw MacControlError.signIn }
        let url = address.url
        let port = url.port ?? (url.scheme == "https" ? 443 : 80)
        origin = "\(url.scheme!)://\(url.host!):\(port)"
        self.accountID = accountID
    }

    var storageKey: String { Self.digest(origin + "\n" + accountID) }
    static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

struct MacControlConsent: Codable, Equatable {
    var terminal = false
    var files = false
    var browsers = false
    var desktop = false
    var complete: Bool { terminal && files && browsers && desktop }
}

struct MacControlBinding: Equatable {
    let scope: MacControlScope
    let sessionFingerprint: String

    func permits(_ other: MacControlBinding, consent: MacControlConsent) -> Bool {
        consent.complete && self == other
    }
}

enum MacControlPolicy {
    static func validatePairServer(_ value: String, address: ServerAddress) throws {
        let returned = try ServerAddress(value, allowLocalHTTP: address.url.scheme == "http")
        guard address.contains(returned.url) else { throw MacControlError.contextChanged }
    }

    static func browserEndpoint(_ raw: String, approved: Bool) throws -> String? {
        if raw.isEmpty { return nil }
        guard approved else { throw MacControlError.browserApproval }
        guard raw == raw.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.contains(where: { $0.isWhitespace || $0.isNewline }),
              !raw.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !raw.contains("@"), !raw.contains("\\"), !raw.contains("?"), !raw.contains("#"),
              var parts = URLComponents(string: raw),
              let scheme = parts.scheme?.lowercased(), ["http", "https", "ws", "wss"].contains(scheme),
              let host = parts.host?.lowercased(), ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host),
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.port == nil || (1...65535).contains(parts.port!) else { throw MacControlError.browserEndpoint }
        parts.scheme = scheme
        // Match companion validateBrowserCdp: pin localhost without DNS/hosts-file resolution.
        if host == "localhost" { parts.host = "127.0.0.1" }
        if parts.path.isEmpty { parts.path = "/" }
        guard let url = parts.url else { throw MacControlError.browserEndpoint }
        return url.absoluteString
    }

    static func arguments(companion: URL, tokenFile: URL, address: ServerAddress, parentPID: Int32, playwright: URL, browserCDP: String? = nil) -> [String] {
        var args = [companion.path, "--desktop", "--local-device", "--token-file", tokenFile.path,
         "--server", address.url.absoluteString, "--parent-pid", String(parentPID), "--playwright-mcp", playwright.path]
        if let browserCDP { args += ["--browser-cdp", browserCDP] }
        return args
    }

    static func validToken(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 4096 && !value.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.union(.controlCharacters).contains($0) }
    }
}

enum MacControlError: LocalizedError {
    case signIn, contextChanged, consent, permissions, browserApproval, browserEndpoint, unavailable(String), http(Int), keychain, token
    var errorDescription: String? {
        switch self {
        case .signIn: return "Sign in to Swarm on this server, then refresh Use this Mac."
        case .contextChanged: return "Your server, account, or sign-in session changed. Mac control stopped. Review your account and approve again."
        case .consent: return "Approve all four kinds of access for the displayed account and server before starting."
        case .browserApproval: return "Approve attaching Playwright to the browser endpoint you entered, or clear the field to use managed Chrome."
        case .browserEndpoint: return "Enter a loopback http(s) or ws(s) endpoint on localhost, 127.0.0.1 or [::1], with no credentials, query, fragment, whitespace or backslash."
        case .permissions: return "Allow Accessibility and Screen Recording for Swarm in System Settings, then refresh permissions. macOS may require you to quit and reopen Swarm."
        case .unavailable(let message): return message
        case .http(401): return "Your sign-in session expired. Mac control stopped. Sign in again."
        case .http(403): return "The server refused Mac control for this account. Check your sign-in and server permissions."
        case .http(409): return "Computer tasks are running. Wait for them to finish, then approve Start again. Stop and Disconnect remain available."
        case .http(404): return "This server does not support Use this Mac. Update the server before pairing."
        case .http(let code): return "The Mac connection request failed (HTTP \(code)). Check your server and try again."
        case .keychain: return "Swarm could not access the pairing token in Keychain. Unlock your login keychain and try again."
        case .token: return "The server returned an invalid pairing grant. Update the server and try again."
        }
    }
}
