// Starting at login: a LaunchAgent of the user's own (~/Library/LaunchAgents/com.headroom.desktop.plist) that runs this executable.
// The app is a bare executable, not an app bundle, so the system's login items for apps don't apply. Kept by the system only: the
// settings file doesn't hold it. Used off the main thread.

import Foundation
import HeadroomKit

enum LoginItem {
    static let label = "com.headroom.desktop"

    enum Status: Equatable {
        case off
        /** It starts this executable */
        case on
        /** It starts another copy (moved or rebuilt elsewhere) */
        case other(String)
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

    static func status() -> Status {
        guard let data = try? Data(contentsOf: plistURL) else { return .off }
        let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
        let args = (plist as? [String: Any])?["ProgramArguments"] as? [String]
        guard let path = args?.first else { return .other("") }
        return path == program ? .on : .other(path)
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
