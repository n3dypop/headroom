// When the client may read the server next. One time only: success, failure and a manual refresh all follow it (the server's
// derived values change every 5 minutes, so reading more often shows nothing new and spends the free plan's requests).

/** After a successful read */
public let SUCCESS_WAIT_MS: Int64 = 5 * 60_000
/** After failures in a row: 5, 10, 20, then 30 minutes (back to 5 after a success) */
public let FAILURE_WAITS_MS: [Int64] = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000]

public struct Schedule: Equatable {
    /** The earliest time of the next read (ms on a clock that the Mac's time setting doesn't move); nil before the first one */
    public var nextAt: Int64?
    /** Failures in a row since the last success */
    public var failures = 0
    /** When the server was last read (whatever came of it) */
    public var lastAt: Int64?

    public init() {}

    /** Whether a read may start now (automatic or manual) */
    public func mayRead(_ now: Int64) -> Bool {
        nextAt.map { $0 <= now } ?? true
    }

    /** How long until the next read may start (0 when it may start now) */
    public func waitMs(_ now: Int64) -> Int64 {
        nextAt.map { max(0, $0 - now) } ?? 0
    }

    public mutating func succeeded(_ now: Int64) {
        failures = 0
        lastAt = now
        nextAt = now + SUCCESS_WAIT_MS
    }

    public mutating func failed(_ now: Int64) {
        failures += 1
        lastAt = now
        nextAt = now + FAILURE_WAITS_MS[min(failures - 1, FAILURE_WAITS_MS.count - 1)]
    }

    /** A read whose result isn't taken (the settings changed meanwhile): it still counts as a read, so the next one is at least 5
     * minutes after it; it neither adds a failure nor shortens a wait */
    public mutating func readAnyway(_ now: Int64) {
        lastAt = now
        nextAt = max(nextAt ?? 0, now + SUCCESS_WAIT_MS)
    }

    /** A new token for the server: the failures were likely the old token's, so the wait is cut back to 5 minutes after the last
     * read (never sooner: the 5 minutes always hold) */
    public mutating func newToken() {
        failures = 0
        if let next = nextAt, let last = lastAt { nextAt = min(next, last + SUCCESS_WAIT_MS) }
    }
}
