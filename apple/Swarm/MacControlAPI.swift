#if os(macOS)
import Foundation
import WebKit

struct MacControlIdentity {
    let binding: MacControlBinding
    let label: String
    let cookie: HTTPCookie
}

struct MacControlStatus: Decodable {
    let enabled: Bool
    let paired: Bool
    let connected: Bool
    let desktop: Bool
    let browser: Bool
}

private final class MacControlNoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

@MainActor
final class MacControlAPI {
    private let cookies: WKHTTPCookieStore
    init(cookies: WKHTTPCookieStore) { self.cookies = cookies }

    func sessionCookie(address: ServerAddress) async throws -> HTTPCookie {
        let matches = await cookies.allCookies().filter {
            $0.name == "swarm_session" && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == address.url.host?.lowercased()
                && $0.path == "/" && (!$0.isSecure || address.url.scheme == "https")
                && ($0.expiresDate == nil || $0.expiresDate! > Date())
        }
        guard matches.count == 1, let cookie = matches.first else { throw MacControlError.signIn }
        return cookie
    }

    func identity(address: ServerAddress) async throws -> MacControlIdentity {
        let cookie = try await sessionCookie(address: address)
        let data = try await request(path: "api/auth/me", address: address, cookie: cookie)
        struct User: Decodable { let id: String; let name: String?; let email: String? }
        struct Response: Decodable { let user: User? }
        guard let user = try JSONDecoder().decode(Response.self, from: data).user else { throw MacControlError.signIn }
        let scope = try MacControlScope(address: address, accountID: user.id)
        return MacControlIdentity(binding: MacControlBinding(scope: scope, sessionFingerprint: MacControlScope.digest(cookie.value)),
                                  label: user.email ?? user.name ?? "Signed-in account", cookie: cookie)
    }

    func validate(_ identity: MacControlIdentity, address: ServerAddress) async throws {
        let current = try await sessionCookie(address: address)
        guard MacControlScope.digest(current.value) == identity.binding.sessionFingerprint else { throw MacControlError.contextChanged }
    }

    func status(identity: MacControlIdentity, address: ServerAddress) async throws -> MacControlStatus {
        try await validate(identity, address: address)
        let data = try await request(path: "api/computer/local", address: address, cookie: identity.cookie)
        return try JSONDecoder().decode(MacControlStatus.self, from: data)
    }

    func pair(identity: MacControlIdentity, address: ServerAddress) async throws -> String {
        try await validate(identity, address: address)
        let data = try await request(path: "api/computer/local/pair", method: "POST", address: address,
                                     cookie: identity.cookie, body: ["desktop": true])
        struct Response: Decodable { let token: String; let server: String }
        let response = try JSONDecoder().decode(Response.self, from: data)
        try MacControlPolicy.validatePairServer(response.server, address: address)
        guard MacControlPolicy.validToken(response.token) else { throw MacControlError.token }
        return response.token
    }

    func disconnect(identity: MacControlIdentity, address: ServerAddress) async throws {
        try await validate(identity, address: address)
        let data = try await request(path: "api/computer/local", method: "DELETE", address: address, cookie: identity.cookie)
        struct Response: Decodable { let ok: Bool; let revoked: Int }
        guard try JSONDecoder().decode(Response.self, from: data).ok else { throw MacControlError.http(500) }
    }

    private func request(path: String, method: String = "GET", address: ServerAddress, cookie: HTTPCookie, body: [String: Bool]? = nil) async throws -> Data {
        let url = address.url.appendingPathComponent(path)
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("swarm_session=\(cookie.value)", forHTTPHeaderField: "Cookie")
        request.setValue(address.url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "Origin")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: MacControlNoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, let returnedURL = http.url, address.contains(returnedURL), returnedURL.path == url.path else {
            throw MacControlError.contextChanged
        }
        guard http.statusCode == 200 else { throw MacControlError.http(http.statusCode) }
        guard data.count <= 1_048_576 else { throw MacControlError.unavailable("The server returned an invalid Mac control response.") }
        let current = try await sessionCookie(address: address)
        guard current.value == cookie.value else { throw MacControlError.contextChanged }
        return data
    }
}
#endif
