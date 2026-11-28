// The state the reading thread and the screen share, and the reading loop. The server, its token and the generation are taken
// together under one lock, so a change in Settings meanwhile can't mix them.

import Foundation
import HeadroomKit

func nowMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000).rounded(.down))
}

/** Milliseconds on a clock the Mac's time setting doesn't move (it runs on while the Mac sleeps): the waits are counted on it */
func monoMs() -> Int64 {
    Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) + 1
}

final class AppState {
    private let lock = NSLock()
    private var state = State()
    private let wake = DispatchSemaphore(value: 0)
    let keep = KeychainKeep()
    /** Told (on the main thread) whenever the state may have changed */
    var onChange: (() -> Void)?

    init() {
        var s = State()
        s.settings = keep.loadSettings()
        s.hasToken = keep.read(s.settings) != nil
        state = s
    }

    func with<R>(_ f: (inout State) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try f(&state)
    }

    /** Wakes the reader (it reads only when the schedule allows it) */
    func nudge() {
        wake.signal()
    }

    /** A click on a ring: reads now if the schedule allows it, else says how long until it may (minutes, rounded up) */
    func refreshNow() -> Int64 {
        let wait = with { $0.schedule.waitMs(monoMs()) }
        if wait == 0 { nudge() }
        return (wait + 59_999) / 60_000
    }

    func save(url: String, token: String?, demo: Bool) throws {
        try with { try $0.save(url: url, token: token, demo: demo, keep: keep) }
        nudge()
        changed()
    }

    func removeToken() throws {
        try with { try $0.removeToken(keep: keep) }
        nudge()
        changed()
    }

    private func changed() {
        DispatchQueue.main.async { self.onChange?() }
    }

    /** Reads the server when the schedule allows it, and tells the screen. Sleeps until the next allowed time or a nudge */
    func startReading() {
        let thread = Thread { [self] in
            while true {
                let job: (UInt64, String, String?)? = with { s in
                    s.mode == .live && s.schedule.mayRead(monoMs()) ? (s.generation, s.settings.url, keep.read(s.settings)) : nil
                }
                if let (generation, url, token) = job {
                    let result: Result<JSON, ReadError> = token.map { readView(base: url, token: $0, tz: TimeZone.current.identifier) }
                        ?? .failure(.notSetUp)
                    // Checked before taking the lock (a large answer doesn't hold up the screen)
                    let checked = result.map { sanitizeView($0) }
                    with { s in
                        if s.generation == generation {
                            s.take(checked, now: nowMs(), mono: monoMs())
                        } else {
                            // Settings changed meanwhile: the result isn't shown, but the server was read, so its 5 minutes count
                            s.withSchedule(of: url) { $0.readAnyway(monoMs()) }
                        }
                    }
                }
                let wait = with { s in s.mode == .live ? max(1000, s.schedule.waitMs(monoMs())) : 3_600_000 }
                changed()
                _ = wake.wait(timeout: .now() + .milliseconds(Int(wait)))
            }
        }
        thread.name = "Headroom reader"
        thread.start()
    }
}
