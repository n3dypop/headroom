// Where the settings and the token are kept: ~/Library/Application Support/Headroom/desktop.json and the login keychain. Each
// saved token is an item of its own ("read:<origin>#<slot>"), which only the settings file names.

import Foundation
import HeadroomKit
import Security

private let SERVICE = "headroom-desktop"

final class KeychainKeep: Keep {
    private var count: UInt64 = 0

    private var settingsURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Headroom").appendingPathComponent("desktop.json")
    }

    /** The saved settings. An address that isn't an https origin (the file edited by hand) is dropped: no token is sent there */
    func loadSettings() -> Settings {
        guard let url = settingsURL, let data = try? Data(contentsOf: url), var s = try? JSONDecoder().decode(Settings.self, from: data)
        else { return Settings() }
        s.url = normalizeBaseURL(s.url) ?? ""
        return s
    }

    func write(_ s: Settings) throws {
        guard let url = settingsURL else { throw SaveError("No folder for the settings") }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(s)
            try data.write(to: url, options: .atomic)
        } catch {
            throw SaveError("Couldn't write the settings")
        }
    }

    private func query(_ origin: String, _ slot: UInt64) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: SERVICE, kSecAttrAccount as String: "read:\(origin)#\(slot)"]
    }

    func store(origin: String, slot: UInt64, token: String) throws {
        var q = query(origin, slot)
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw SaveError("Couldn't save the token in the keychain") }
    }

    func delete(origin: String, slot: UInt64) throws {
        if origin.isEmpty || slot == 0 { return }
        let status = SecItemDelete(query(origin, slot) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SaveError("Couldn't remove the token from the keychain") }
    }

    func read(_ s: Settings) -> String? {
        if s.url.isEmpty || s.tokenSlot == 0 { return nil }
        var q = query(s.url, s.tokenSlot)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              let token = String(data: data, encoding: .utf8), !token.trimmingCharacters(in: .whitespaces).isEmpty
        else { return nil }
        return token
    }

    /** Only a keychain that says there is no such item counts as free: when it can't tell, the slot isn't used */
    func has(origin: String, slot: UInt64) -> Bool {
        SecItemCopyMatching(query(origin, slot) as CFDictionary, nil) != errSecItemNotFound
    }

    /** The clock in nanoseconds plus a count, so two calls never give the same one (the caller still checks it is free) */
    func newSlot() -> UInt64 {
        count += 1
        return max(1, UInt64(Date().timeIntervalSince1970 * 1_000_000_000) &+ count)
    }
}
