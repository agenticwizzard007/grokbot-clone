#if os(macOS)
import Foundation
import Security
import Darwin

struct MacControlGrant: Codable {
    let scope: MacControlScope
    let token: String
    let consent: MacControlConsent
    let version: Int
}

struct MacControlTokenStore {
    private let service = "so.swarms.app.macos.local-computer.v1"

    private func query(_ scope: MacControlScope) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: scope.storageKey]
    }

    func read(_ scope: MacControlScope) throws -> MacControlGrant? {
        var fields = query(scope)
        fields[kSecReturnData as String] = true
        fields[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(fields as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw MacControlError.keychain }
        guard let grant = try? JSONDecoder().decode(MacControlGrant.self, from: data),
              grant.version == 1, grant.scope == scope, grant.consent.complete,
              MacControlPolicy.validToken(grant.token) else { throw MacControlError.keychain }
        return grant
    }

    func save(_ grant: MacControlGrant) throws {
        guard grant.consent.complete, MacControlPolicy.validToken(grant.token) else { throw MacControlError.consent }
        let data = try JSONEncoder().encode(grant)
        let fields = query(grant.scope)
        let changes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(fields as CFDictionary, changes as CFDictionary)
        if status == errSecItemNotFound {
            var new = fields
            for (key, value) in changes { new[key] = value }
            guard SecItemAdd(new as CFDictionary, nil) == errSecSuccess else { throw MacControlError.keychain }
        } else if status != errSecSuccess { throw MacControlError.keychain }
    }

    func remove(_ scope: MacControlScope) throws {
        let status = SecItemDelete(query(scope) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MacControlError.keychain }
    }

    func removeAll() throws {
        let status = SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw MacControlError.keychain }
    }
}

// A private, exclusive, mode-0600 file is the only on-disk token outside Keychain.
// Child arguments contain its random path, never the credential itself.
final class MacControlTokenFile {
    let directory: URL
    let url: URL

    init(token: String, temporaryDirectory: URL = FileManager.default.temporaryDirectory) throws {
        guard MacControlPolicy.validToken(token) else { throw MacControlError.token }
        var template = Array(temporaryDirectory.appendingPathComponent("swarm-control-XXXXXX").path.utf8CString)
        let folder = template.withUnsafeMutableBufferPointer { buffer -> String? in
            guard let base = buffer.baseAddress, let created = mkdtemp(base) else { return nil }
            return String(cString: created)
        }
        guard let folder else { throw MacControlError.unavailable("Could not create a private folder for the companion token.") }
        directory = URL(fileURLWithPath: folder, isDirectory: true)
        url = directory.appendingPathComponent("token")
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard fd >= 0 else {
            try? FileManager.default.removeItem(at: directory)
            throw MacControlError.unavailable("Could not create a private companion token file.")
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        do {
            guard fchmod(fd, S_IRUSR | S_IWUSR) == 0 else { throw MacControlError.token }
            try handle.write(contentsOf: Data(token.utf8))
            try handle.close()
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: directory)
            throw MacControlError.unavailable("Could not write the private companion token file.")
        }
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
    deinit { remove() }
}
#endif
