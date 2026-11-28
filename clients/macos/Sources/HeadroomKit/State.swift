// What the client knows between reads: its settings, the last view, the schedule of each server, and the rules for saving a
// server and its token and for taking a read's result. Kept apart from the app so the tests can run it with stand-ins.

import Foundation

/** The saved settings (~/Library/Application Support/Headroom/desktop.json) */
public struct Settings: Codable, Equatable {
    /** The server's https origin (no path) */
    public var url = ""
    /** Show the built-in sample instead of reading the server */
    public var demo = false
    /** Which keychain item holds the server's read token (0: none). Each saved token gets a new one, so a save takes effect only
     * when the settings file is written, and an item the file doesn't name is never read */
    public var tokenSlot: UInt64 = 0

    enum CodingKeys: String, CodingKey {
        case url, demo
        case tokenSlot = "token_slot"
    }

    public init(url: String = "", demo: Bool = false, tokenSlot: UInt64 = 0) {
        self.url = url
        self.demo = demo
        self.tokenSlot = tokenSlot
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = (try? c.decode(String.self, forKey: .url)) ?? ""
        demo = (try? c.decode(Bool.self, forKey: .demo)) ?? false
        tokenSlot = (try? c.decode(UInt64.self, forKey: .tokenSlot)) ?? 0
    }
}

/** Why a read failed, in words for the user (never the server's own text) */
public enum ReadError: Error, Equatable {
    case notSetUp, tokenRejected, notFound, busy, server(Int), network, badBody

    public var text: String {
        switch self {
        case .notSetUp: return "Set the server and the read token in Settings"
        case .tokenRejected: return "The server didn't accept the token"
        case .notFound: return "No Headroom server at this address"
        case .busy: return "The server is busy; trying again later"
        case .server(let code): return "The server answered \(code)"
        case .network: return "Couldn't reach the server"
        case .badBody: return "The server's answer isn't a Headroom view"
        }
    }
}

public enum Mode: Equatable {
    /** The built-in sample */
    case demo
    /** No server or token yet */
    case setup
    case live
}

/** Where the settings and the token are kept: the settings file and the keychain (a stand-in in the tests) */
public protocol Keep {
    func write(_ s: Settings) throws
    func store(origin: String, slot: UInt64, token: String) throws
    func delete(origin: String, slot: UInt64) throws
    func read(_ s: Settings) -> String?
    /** Whether an item is there; true when the store can't tell (the slot isn't used then) */
    func has(origin: String, slot: UInt64) -> Bool
    func newSlot() -> UInt64
}

public struct SaveError: Error, Equatable {
    public var text: String
    public init(_ text: String) { self.text = text }
}

public struct State {
    public var settings = Settings()
    /** A read token is kept for the server in the settings */
    public var hasToken = false
    /** Moves on with every change of the server or the token: a read started before it isn't taken */
    public var generation: UInt64 = 0
    /** When the server in the settings may be read next */
    public var schedule = Schedule()
    /** The same for servers used before (moving away and back doesn't read sooner) */
    public var waits: [String: Schedule] = [:]
    /** The last view the server gave that could be shown (checked) */
    public var view: View?
    public var error: String?
    public var fetchedAt: Int64?

    public init() {}

    public var mode: Mode {
        if settings.demo { return .demo }
        if settings.url.isEmpty || !hasToken { return .setup }
        return .live
    }

    /** New settings: what was read before is dropped and a read started before is not taken (its timing still counts) */
    mutating func startOver() {
        generation += 1
        view = nil
        error = nil
        fetchedAt = nil
    }

    /** Another server in the settings: its own wait (none for one never read) */
    mutating func switchServer(from old: String, to new: String) {
        if !old.isEmpty { waits[old] = schedule }
        schedule = waits.removeValue(forKey: new) ?? Schedule()
    }

    /** The schedule of a server: the current one's, or one used before */
    public mutating func withSchedule(of url: String, _ change: (inout Schedule) -> Void) {
        if url == settings.url {
            change(&schedule)
        } else {
            var s = waits[url] ?? Schedule()
            change(&s)
            waits[url] = s
        }
    }

    /** Saves the server and (when given) its token: persist, then apply. The token goes to the keychain only, never to a file or a
     * log; each saved token gets an item of its own, which only the settings file names, so the save takes effect when the file is
     * written */
    public mutating func save(url: String, token: String?, demo: Bool, keep: Keep) throws {
        apply(try State.persist(settings: settings, hasToken: hasToken, url: url, token: token, demo: demo, keep: keep))
    }

    /** Forgets the token: persist, then apply */
    public mutating func removeToken(keep: Keep) throws {
        apply(try State.persistRemoval(settings: settings, keep: keep))
    }

    /** A save written to the keychain and the settings file, to be applied to the state */
    public struct Saved {
        public let old: Settings
        public let next: Settings
        /** A new token was stored */
        public let newEntry: Bool
        public let hasToken: Bool
    }

    /** Writes a save to the keychain and the settings file (no state is touched: this can take its time, outside any lock) */
    public static func persist(settings old: Settings, hasToken: Bool, url rawURL: String, token rawToken: String?, demo: Bool,
                               keep: Keep) throws -> Saved {
        let url: String
        if rawURL.trimmingCharacters(in: .whitespaces).isEmpty {
            url = ""
        } else {
            guard let u = normalizeBaseURL(rawURL) else { throw SaveError("Enter an https:// address with the host name only (no path)") }
            url = u
        }
        var token = rawToken?.trimmingCharacters(in: .whitespacesAndNewlines)
        if token?.isEmpty == true { token = nil }
        if token != nil && url.isEmpty { throw SaveError("Enter the server the token is for") }
        let sameServer = url == old.url
        if !demo && (url.isEmpty || (token == nil && !(sameServer && hasToken))) {
            throw SaveError("Enter the server and its read token, or choose the sample")
        }
        // The same token for the same server again: nothing to store, and what is shown stays
        if let t = token, sameServer, keep.read(old) == t { token = nil }
        var slot: UInt64 = sameServer ? old.tokenSlot : 0
        if let t = token {
            // A slot no item of this server has (and never the one in use), so storing can't touch the token in use
            guard let free = (0..<8).lazy.map({ _ in keep.newSlot() }).first(where: { n in
                n != 0 && !(url == old.url && n == old.tokenSlot) && !keep.has(origin: url, slot: n)
            }) else { throw SaveError("Couldn't find a free place for the token") }
            try keep.store(origin: url, slot: free, token: t)
            slot = free
        }
        let next = Settings(url: url, demo: demo, tokenSlot: slot)
        let newEntry = token != nil
        do {
            try keep.write(next)
        } catch {
            // The old settings and token stay as they were; the new item goes
            if newEntry { try? keep.delete(origin: next.url, slot: slot) }
            throw error
        }
        // The old item is no longer named
        if (old.url, old.tokenSlot) != (next.url, slot) { try? keep.delete(origin: old.url, slot: old.tokenSlot) }
        // Asked of the keychain itself (never a guess made before it answered)
        return Saved(old: old, next: next, newEntry: newEntry, hasToken: keep.read(next) != nil)
    }

    /** Writes a removal: the settings stop naming the token first, then its item goes */
    public static func persistRemoval(settings old: Settings, keep: Keep) throws -> Saved {
        var next = old
        next.tokenSlot = 0
        try keep.write(next)
        try? keep.delete(origin: old.url, slot: old.tokenSlot)
        return Saved(old: old, next: next, newEntry: false, hasToken: false)
    }

    /** Applies a written save to the state (brief: the reader's results meanwhile are kept, and a read started before is not taken
     * when the server or the token changed) */
    public mutating func apply(_ saved: Saved) {
        let newServer = saved.old.url != saved.next.url
        if newServer { switchServer(from: saved.old.url, to: saved.next.url) }
        // A new token: the wait is cut back to 5 minutes after the server's last read (failures were likely the old token's)
        if saved.newEntry { schedule.newToken() }
        let removed = saved.old.tokenSlot != 0 && saved.next.tokenSlot == 0
        let newSource = newServer || saved.newEntry || removed || hasToken != saved.hasToken
        settings = saved.next
        hasToken = saved.hasToken
        if newSource { startOver() }
    }

    /** What a read brought, applied to the state of the generation it was started in */
    public mutating func take(_ result: Result<View?, ReadError>, now: Int64, mono: Int64) {
        switch result {
        case .success(let view?):
            // A view older than the one shown (it arrived late, or the server read an earlier copy) is not shown, as on the widget
            if self.view.map({ view.dataVersion >= $0.dataVersion }) ?? true { self.view = view }
            error = nil
            fetchedAt = now
            schedule.succeeded(mono)
        case .success(nil):
            // A view the widget would refuse isn't shown either: the last one stays, and the error says why
            error = ReadError.badBody.text
            schedule.failed(mono)
        case .failure(let e):
            error = e.text
            schedule.failed(mono)
        }
    }

    /** The line under the card: where the values come from and how old they are; and whether it warns */
    public func footer(now: Int64) -> (String, Bool) {
        switch mode {
        case .demo: return ("Sample data (Settings to connect)", false)
        case .setup: return (ReadError.notSetUp.text, true)
        case .live:
            if let e = error { return ("⚠ \(e)", true) }
            guard let at = fetchedAt else { return ("Reading…", false) }
            let minutes = Int64((Double(now - at) / 60_000).rounded(.down))
            return (minutes < 1 ? "Read just now" : "Read \(minutes) min ago", false)
        }
    }
}
