import CryptoKit
import Foundation
import Security

struct SignInAttempt {
    static let callbackScheme = "so.swarms.app"
    let verifier: String
    let state: String
    var challenge: String { Data(SHA256.hash(data: Data(verifier.utf8))).base64URL }

    init() throws {
        func random() throws -> String {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
                throw SignInError.random
            }
            return Data(bytes).base64URL
        }
        verifier = try random()
        state = try random()
    }

    func startURL(server: URL) -> URL {
        var parts = URLComponents(url: server.appendingPathComponent("api/auth/native/start"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "challenge", value: challenge), URLQueryItem(name: "state", value: state)]
        return parts.url!
    }

    func code(from callback: URL) throws -> String {
        guard callback.scheme == Self.callbackScheme, callback.host == "auth",
              callback.path.isEmpty || callback.path == "/",
              let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false) else { throw SignInError.invalid }
        let items = parts.queryItems ?? []
        guard items.filter({ $0.name == "state" }).count == 1,
              items.first(where: { $0.name == "state" })?.value == state else { throw SignInError.invalid }
        if items.contains(where: { $0.name == "error" }) { throw SignInError.denied }
        guard items.filter({ $0.name == "code" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value,
              code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw SignInError.invalid }
        return code
    }

    enum SignInError: LocalizedError {
        case random, invalid, denied, exchange
        var errorDescription: String? {
            switch self {
            case .random: return "Couldn’t start a secure sign-in. Please try again."
            case .invalid: return "This sign-in doesn’t match your request. Please start again."
            case .denied: return "Google sign-in wasn’t completed. Try again and approve the requested access."
            case .exchange: return "Sign-in expired or the server doesn’t support native sign-in yet. Update your Swarm server and try again."
            }
        }
    }
}

private extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
