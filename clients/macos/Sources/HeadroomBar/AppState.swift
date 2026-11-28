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
    /** Told (on the main thread) when the notch's prefs changed: it is placed and drawn again */
    var onPrefs: (() -> Void)?
    /** Moves on with every prefs change (under the lock): a write that a later one follows is skipped */
    private var prefsChange: UInt64 = 0
    /** Whether the keychain has said whether the settings' token is there (read and written under the lock only) */
    private var tokenKnown = false

    private func isTokenKnown() -> Bool {
        with { _ in tokenKnown }
    }

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
            // The keychain and the file outside the lock (saves run one at a time on this queue, so the settings read here stay the
            // current ones until applied); then the state, briefly, under it
            let outcome: SaveError?
            do {
                let (settings, has) = with { ($0.settings, $0.hasToken) }
                let saved = try State.persist(settings: settings, hasToken: has, url: url, token: token, demo: demo, keep: keep)
                with { s in
                    s.apply(saved)
                    // The save asked the keychain for these settings
                    tokenKnown = true
                }
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

    /** Changes the notch's prefs (on the main thread): they take effect at once, and the settings file is written on the settings
     * queue, after any save before it and outside the lock. The server and the token are written as they are then. `done` gets the
     * error (nil when written), on the main thread; a change another one follows before it is written reports nothing */
    func setPrefs(_ change: (inout Prefs) -> Void, done: @escaping (SaveError?) -> Void) {
        let mine = with { s -> UInt64? in
            var p = s.settings.prefs
            change(&p)
            if p == s.settings.prefs { return nil }
            s.settings.prefs = p
            prefsChange += 1
            return prefsChange
        }
        guard let mine else { return done(nil) }
        onPrefs?()
        saving.async { [self] in
            // The settings as they are now (a later change writes for itself)
            let settings = with { s -> Settings? in prefsChange == mine ? s.settings : nil }
            guard let settings else { return }
            let outcome: SaveError?
            do {
                try keep.write(settings)
                outcome = nil
            } catch let e as SaveError {
                outcome = e
            } catch {
                outcome = SaveError("Couldn't write the settings")
            }
            DispatchQueue.main.async { done(outcome) }
        }
    }

    /** Removes the token on the settings queue; `done` gets the error (nil when removed), on the main thread */
    func removeToken(done: @escaping (SaveError?) -> Void) {
        saving.async { [self] in
            let outcome: SaveError?
            do {
                let saved = try State.persistRemoval(settings: with { $0.settings }, keep: keep)
                with { $0.apply(saved) }
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
        if isTokenKnown() { return }
        let settings = with { $0.settings }
        let found = keep.lookUp(settings)
        // Taken only for the settings it was asked about (a save meanwhile has said for itself)
        let current = with { s -> Bool in
            // A save meanwhile asked for itself: this answer is about settings no longer in use
            guard s.settings.sameToken(as: settings), !tokenKnown else { return false }
            switch found {
            case .token:
                s.hasToken = true
                tokenKnown = true
            case .none:
                s.hasToken = false
                tokenKnown = true
            case .unknown: break
            }
            return true
        }
        if !current { return }
        switch found {
        case .token, .none:
            break
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
                    self.tokenKnown && s.mode == .live && s.schedule.mayRead(monoMs()) ? (s.generation, s.settings) : nil
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
