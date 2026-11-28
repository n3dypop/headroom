// Starting at login: a LaunchAgent of the user's own (~/Library/LaunchAgents/com.headroom.desktop.plist) that runs this executable.
// The app is a bare executable, not an app bundle, so the system's login items for apps don't apply. Kept by the system only: the
// settings file doesn't hold it; whether it runs is the system's to say (the user can turn it off in System Settings > Login
// Items). Used off the main thread.

import Foundation
import HeadroomKit
import ServiceManagement

enum LoginItem {
    static let label = "com.headroom.desktop"

    enum Status: Equatable {
        /** No login item */
        case off
        /** Enabled, and it starts this executable */
        case on
        /** Enabled, but it starts another copy (moved or rebuilt elsewhere) */
        case other(String)
        /** Turned off in System Settings, or waiting for the user to allow it there */
        case needsApproval
        /** Written, but the system hasn't taken it up (yet) */
        case notRegistered
    }

    private static var plistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
            .appendingPathComponent("\(label).plist")
    }

    /** The running executable's full path */
    private static var program: String? {
        Bundle.main.executableURL?.resolvingSymlinksInPath().path
    }

    /** The login item as the system has it: on only when it is there and enabled */
    static func status() -> Status {
        let url = plistURL
        guard let data = try? Data(contentsOf: url) else { return .off }
        switch SMAppService.statusForLegacyPlist(at: url) {
        case .enabled:
            break
        case .requiresApproval:
            return .needsApproval
        case .notRegistered, .notFound:
            return .notRegistered
        @unknown default:
            return .notRegistered
        }
        let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        let args = (plist as? [String: Any])?["ProgramArguments"] as? [String]
        guard let path = args?.first else { return .other("") }
        return path == program ? .on : .other(path)
    }

    /** System Settings at Login Items, where the user allows it (on the main thread) */
    static func openSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }

    /** Writes the agent (for this executable) or removes it. It takes effect at the next login */
    static func set(_ on: Bool) throws {
        let url = plistURL
        if !on {
            if !FileManager.default.fileExists(atPath: url.path) { return }
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                throw SaveError("Couldn't remove the login item")
            }
            return
        }
        guard let path = program else { throw SaveError("Couldn't find this app's path") }
        let plist: [String: Any] = [
            "Label": label,
            "ProgramArguments": [path],
            "RunAtLoad": true,
            "ProcessType": "Interactive",
            "LimitLoadToSessionType": "Aqua",
        ]
        do {
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            throw SaveError("Couldn't write the login item")
        }
    }
}
