import Foundation

struct ServerAddress: Equatable {
    // Distribution stamps this into the built Info.plist before signing. An
    // invalid override must never relax the origin/HTTPS policy. Existing saved
    // server choices still take precedence in AppModel.
    static let defaultURL = defaultURL(configuration: Bundle.main.infoDictionary ?? [:])

    static func defaultURL(configuration: [String: Any]) -> URL {
        if let value = configuration["SwarmDefaultServerOrigin"] as? String,
           let address = try? ServerAddress(value) {
            return address.url
        }
        return URL(string: "https://swarm-team.fly.dev")!
    }
    let url: URL

    init(_ text: String, allowLocalHTTP: Bool = false) throws {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/",
              parts.port == nil || (1...65535).contains(parts.port!) else {
            throw AddressError.invalid
        }
        let local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host.lowercased())
        guard parts.scheme?.lowercased() == "https" ||
                (allowLocalHTTP && local && parts.scheme?.lowercased() == "http") else {
            throw AddressError.insecure
        }
        parts.scheme = parts.scheme?.lowercased()
        parts.host = host.lowercased()
        parts.path = "/"
        guard let url = parts.url else { throw AddressError.invalid }
        self.url = url
    }

    func contains(_ other: URL) -> Bool {
        func port(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }
        return other.user == nil && other.password == nil &&
            other.scheme?.lowercased() == url.scheme && other.host?.lowercased() == url.host && port(other) == port(url)
    }

    enum AddressError: LocalizedError {
        case invalid, insecure
        var errorDescription: String? {
            switch self {
            case .invalid: return "Enter your server’s address without a path, password, or query, such as https://swarm.example.com."
            case .insecure: return "Your server must use HTTPS. Debug builds also support HTTP on localhost."
            }
        }
    }
}
