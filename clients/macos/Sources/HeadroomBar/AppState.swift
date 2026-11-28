// The state the reading thread and the screen share, and the reading loop. The keychain and the settings file are used on the
// reading thread or the settings queue, never on the main thread; the reader reads the token outside the lock.

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
    /** Saving and removing, one at a time, off the main thread */
    private let saving = DispatchQueue(label: "Headroom settings")
    let keep = KeychainKeep()
    /** Told (on the main thread) whenever the state may have changed */
    var onChange: (() -> Void)?
    /** Whether the keychain has said whether the settings' token is there (asked on the reading thread) */
    private var tokenKnown = false

    init() {
        // The settings file only (the keychain is asked on the reading thread)
        let settings = keep.loadSettings()
        state.settings = settings
        // Until the keychain answers, a server with a token named is taken to have it (nothing is read before it answers)
        state.hasToken = settings.tokenSlot != 0 && !settings.url.isEmpty
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

    /** Saves on the settings queue; `done` gets the error (nil when saved), on the main thread */
    func save(url: String, token: String?, demo: Bool, done: @escaping (SaveError?) -> Void) {
        saving.async { [self] in
            // Under the lock, so no read's result comes in between (a save is rare, and the screen waits for it at most briefly);
            // the main thread never waits on the keychain for it
            let outcome: SaveError?
            do {
                try with { try $0.save(url: url, token: token, demo: demo, keep: keep) }
                tokenKnown = true
                outcome = nil
            } catch let e as SaveError {
                outcome = e
            } catch {
                outcome = SaveError("Couldn't save the settings")
            }
            nudge()
            DispatchQueue.main.async {
                done(outcome)
                self.onChange?()
            }
        }
    }

    /** Removes the token on the settings queue; `done` gets the error (nil when removed), on the main thread */
    func removeToken(done: @escaping (SaveError?) -> Void) {
        saving.async { [self] in
            let outcome: SaveError?
            do {
                try with { try $0.removeToken(keep: keep) }
                outcome = nil
            } catch let e as SaveError {
                outcome = e
            } catch {
                outcome = SaveError("Couldn't remove the token")
            }
            nudge()
            DispatchQueue.main.async {
                done(outcome)
                self.onChange?()
            }
        }
    }

    private func changed() {
        DispatchQueue.main.async { self.onChange?() }
    }

    /** Asks the keychain whether the settings' token is there (until it has said so) */
    private func checkToken() {
        if tokenKnown { return }
        let settings = with { $0.settings }
        switch keep.lookUp(settings) {
        case .token:
            tokenKnown = true
            with { $0.hasToken = true }
        case .none:
            tokenKnown = true
            with { $0.hasToken = false }
        case .unknown:
            // Asked again on the next turn (a nudge, waking from sleep, or an hour)
            with { $0.error = "Couldn't read the keychain" }
        }
    }

    /** Reads the server when the schedule allows it, and tells the screen. Sleeps until the next allowed time or a nudge */
    func startReading() {
        let thread = Thread { [self] in
            while true {
                checkToken()
                // The settings and the generation together; the token is read for exactly those settings, outside the lock
                let job: (UInt64, Settings)? = with { s in
                    tokenKnown && s.mode == .live && s.schedule.mayRead(monoMs()) ? (s.generation, s.settings) : nil
                }
                if let (generation, settings) = job {
                    let result: Result<JSON, ReadError> = keep.read(settings).map { readView(base: settings.url, token: $0, tz: TimeZone.current.identifier) }
                        ?? .failure(.notSetUp)
                    // Checked before taking the lock (a large answer doesn't hold up the screen)
                    let checked = result.map { sanitizeView($0) }
                    with { s in
                        if s.generation == generation {
                            s.take(checked, now: nowMs(), mono: monoMs())
                        } else {
                            // Settings changed meanwhile: the result isn't shown, but the server was read, so its 5 minutes count
                            s.withSchedule(of: settings.url) { $0.readAnyway(monoMs()) }
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
