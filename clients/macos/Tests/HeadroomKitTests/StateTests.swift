// The schedule, the server address, saving a server and its token (with failures put in), taking a read's result, and the card's
// layout: the same cases as the Windows client's tests.

import Foundation
import XCTest
@testable import HeadroomKit

/** A settings file and keychain in memory, which fail when told to */
private final class FakeKeep: Keep {
    var file: Settings?
    var entries: [String: String] = [:]
    var failWrite = false, failStore = false, failDelete = false
    /** The slot numbers handed out, in turn (then counting on) */
    var slots: [UInt64] = []
    var next: UInt64 = 0

    private func key(_ origin: String, _ slot: UInt64) -> String { "\(origin)#\(slot)" }

    func write(_ s: Settings) throws {
        if failWrite { throw SaveError("Couldn't write the settings") }
        file = s
    }
    func store(origin: String, slot: UInt64, token: String) throws {
        if failStore { throw SaveError("Couldn't save the token") }
        entries[key(origin, slot)] = token
    }
    func delete(origin: String, slot: UInt64) throws {
        if failDelete { throw SaveError("Couldn't remove the token") }
        entries[key(origin, slot)] = nil
    }
    func read(_ s: Settings) -> String? { entries[key(s.url, s.tokenSlot)] }
    func has(origin: String, slot: UInt64) -> Bool { entries[key(origin, slot)] != nil }
    func newSlot() -> UInt64 {
        if !slots.isEmpty { return slots.removeFirst() }
        next += 1
        return next
    }
}

private let A = "https://a.example"
private let B = "https://b.example"

/** What the reader would send, and what a restart would read */
private func used(_ s: State, _ keep: FakeKeep) -> [String?] {
    [keep.read(s.settings), keep.file.flatMap { keep.read($0) }]
}

private func view(_ version: Int) -> Result<View?, ReadError> {
    .success(sanitizeView(.object(["view_version": .number(1), "data_version": .number(Double(version)), "claude": .null, "codex": .null])))
}

final class StateTests: XCTestCase {
    func testScheduleWaitsAndBacksOff() {
        var s = Schedule()
        XCTAssertTrue(s.mayRead(0))
        s.succeeded(0)
        XCTAssertFalse(s.mayRead(60_000))
        XCTAssertTrue(s.mayRead(5 * 60_000))
        s.failed(5 * 60_000)
        s.failed(10 * 60_000)
        XCTAssertEqual(s.nextAt, 20 * 60_000)
        s.newToken()
        XCTAssertEqual(s.nextAt, 15 * 60_000, "5 minutes after the last read")
        s.readAnyway(14 * 60_000)
        XCTAssertEqual(s.nextAt, 19 * 60_000)
    }

    func testTheAddressIsAnHttpsOriginOnly() {
        XCTAssertEqual(normalizeBaseURL(" https://Headroom.Example.workers.dev/ "), "https://headroom.example.workers.dev")
        XCTAssertEqual(normalizeBaseURL("https://h.example:8443"), "https://h.example:8443")
        XCTAssertEqual(normalizeBaseURL("https://h.example:00443"), "https://h.example")
        for bad in ["http://h.example", "h.example", "https://", "https://h.example/v2", "https://h.example?x=1", "https://user@h.example",
                    "https://h.example:port", "https://h..example", "https://h.example:65536", "https://h.example:0"] {
            XCTAssertNil(normalizeBaseURL(bad), bad)
        }
        XCTAssertEqual(viewURL("https://h.example", "America/Port-au-Prince"), "https://h.example/v2/view?tz=America%2FPort-au-Prince")
    }

    func testAFailedSaveLeavesTheTokenInUseAsItWas() throws {
        let keep = FakeKeep()
        var s = State()
        try s.save(url: A, token: "one", demo: false, keep: keep)
        XCTAssertEqual(used(s, keep), ["one", "one"])
        keep.failWrite = true
        XCTAssertThrowsError(try s.save(url: A, token: "two", demo: false, keep: keep))
        XCTAssertEqual(used(s, keep), ["one", "one"])
        XCTAssertThrowsError(try s.save(url: B, token: "three", demo: false, keep: keep))
        XCTAssertEqual(used(s, keep), ["one", "one"])
        XCTAssertEqual(s.settings.url, A)
        XCTAssertEqual(keep.entries.count, 1, "the failed saves' items went")
        keep.failWrite = false
        keep.failStore = true
        XCTAssertThrowsError(try s.save(url: B, token: "four", demo: false, keep: keep))
        XCTAssertEqual(used(s, keep), ["one", "one"])
    }

    func testASlotInUseIsNeverWrittenOver() throws {
        let keep = FakeKeep()
        var s = State()
        keep.slots = [7]
        try s.save(url: A, token: "one", demo: false, keep: keep)
        keep.slots = [7, 7]
        keep.failWrite = true
        XCTAssertThrowsError(try s.save(url: A, token: "two", demo: false, keep: keep))
        XCTAssertEqual(used(s, keep), ["one", "one"])
        keep.failWrite = false
        keep.slots = [7]
        try s.save(url: B, token: "three", demo: false, keep: keep)
        XCTAssertEqual(used(s, keep), ["three", "three"])
        XCTAssertEqual(keep.entries.count, 1)
    }

    func testAnItemTheSettingsDontNameIsNeverTakenUp() throws {
        let keep = FakeKeep()
        var s = State()
        try s.save(url: A, token: "one", demo: false, keep: keep)
        keep.failDelete = true
        try s.save(url: B, token: "two", demo: false, keep: keep)
        XCTAssertThrowsError(try s.save(url: A, token: nil, demo: false, keep: keep), "a token is needed for A")
        try s.save(url: A, token: nil, demo: true, keep: keep)
        XCTAssertEqual(used(s, keep), [nil, nil])
        XCTAssertFalse(s.hasToken)
    }

    func testRemovingTheTokenStopsItsUseEvenIfItsItemStays() throws {
        let keep = FakeKeep()
        var s = State()
        try s.save(url: A, token: "one", demo: false, keep: keep)
        keep.failDelete = true
        try s.removeToken(keep: keep)
        XCTAssertEqual(used(s, keep), [nil, nil])
    }

    func testTheWaitIsKeptPerServer() throws {
        let keep = FakeKeep()
        var s = State()
        try s.save(url: A, token: "one", demo: false, keep: keep)
        s.take(view(1), now: 1_000, mono: 1)
        XCTAssertFalse(s.schedule.mayRead(2))
        // The same token again changes nothing; a new one waits as long; away to B and back to A keeps A's wait
        let generation = s.generation
        try s.save(url: A, token: "one", demo: false, keep: keep)
        XCTAssertEqual(s.generation, generation)
        XCTAssertNotNil(s.view, "what is shown stays")
        try s.save(url: A, token: "two", demo: false, keep: keep)
        XCTAssertFalse(s.schedule.mayRead(2))
        try s.save(url: B, token: "b", demo: false, keep: keep)
        XCTAssertTrue(s.schedule.mayRead(2), "B was never read")
        try s.save(url: A, token: "two", demo: false, keep: keep)
        XCTAssertFalse(s.schedule.mayRead(2), "A's wait came back")
        // After failures, a new token waits only until 5 minutes after the last read
        s.take(.failure(.tokenRejected), now: 2_000, mono: 300_001)
        s.take(.failure(.tokenRejected), now: 3_000, mono: 600_002)
        try s.save(url: A, token: "three", demo: false, keep: keep)
        XCTAssertFalse(s.schedule.mayRead(900_001))
        XCTAssertTrue(s.schedule.mayRead(900_002))
    }

    func testAnOlderViewNeverReplacesANewerOne() {
        var s = State()
        s.take(view(42), now: 1_000, mono: 1)
        s.take(view(41), now: 2_000, mono: 2)
        XCTAssertEqual(s.view?.dataVersion, 42)
        XCTAssertEqual(s.fetchedAt, 2_000)
        s.take(.success(nil), now: 3_000, mono: 3)
        XCTAssertEqual(s.view?.dataVersion, 42)
        XCTAssertEqual(s.error, ReadError.badBody.text)
    }

    func testEveryRowCanBeReachedHoweverShortTheWindow() throws {
        let now = 1_794_834_300_000.0
        let utc = TimeZone(identifier: "UTC")!
        let cells = notchModel(try XCTUnwrap(sanitizeView(demoBody(now))), now, utc)
        for c in cells {
            let all = c.rows.map(rowHeight).reduce(0, +)
            for h in stride(from: 60.0, through: 700.0, by: 2.0) {
                let fit = cardFit(c, winH: h, scroll: 0)
                if h >= MIN_SCROLL_WIN_H { XCTAssertLessThanOrEqual(fit.h, h - 16 + 1e-3, "\(c.name) at \(h)") }
                if fit.notice { XCTAssertLessThan(h, MIN_SCROLL_WIN_H); continue }
                if !fit.scrolls { XCTAssertEqual(fit.area, all, accuracy: 1e-3); continue }
                let end = cardFit(c, winH: h, scroll: .greatestFiniteMagnitude)
                XCTAssertEqual(end.offset + end.area, all, accuracy: 1e-3, "\(c.name) at \(h)")
            }
        }
    }

    func testTheFooterSaysWhereTheValuesComeFrom() {
        var s = State()
        XCTAssertEqual(s.footer(now: 0).0, ReadError.notSetUp.text)
        s.settings = Settings(url: A, demo: false, tokenSlot: 1)
        s.hasToken = true
        XCTAssertEqual(s.footer(now: 0).0, "Reading…")
        s.fetchedAt = 0
        XCTAssertEqual(s.footer(now: 3 * 60_000).0, "Read 3 min ago")
        s.settings.demo = true
        XCTAssertEqual(s.footer(now: 0).0, "Sample data (Settings to connect)")
    }

    func testSavingTheServerKeepsThePrefs() throws {
        let keep = FakeKeep()
        var s = State()
        s.settings.prefs.theme = .glass
        s.settings.prefs.position = 20
        try s.save(url: A, token: "one", demo: false, keep: keep)
        XCTAssertEqual(s.settings.prefs.theme, .glass)
        XCTAssertEqual(keep.file?.prefs.position, 20)
        try s.save(url: B, token: "two", demo: false, keep: keep)
        XCTAssertEqual(keep.file?.prefs.theme, .glass)
        try s.removeToken(keep: keep)
        XCTAssertEqual(keep.file?.prefs.theme, .glass)
        XCTAssertEqual(s.settings.prefs.position, 20)
    }

    func testPrefsChangedDuringASaveAreNotTakenBack() throws {
        let keep = FakeKeep()
        var s = State()
        // The save is written with the prefs of its start; the prefs change before it is applied
        let saved = try State.persist(settings: s.settings, hasToken: s.hasToken, url: A, token: "one", demo: false, keep: keep)
        s.settings.prefs.size = .large
        s.apply(saved)
        XCTAssertEqual(s.settings.prefs.size, .large)
        XCTAssertEqual(s.settings.url, A)
        XCTAssertEqual(used(s, keep), ["one", "one"])
    }

    func testAPrefsChangeKeepsTheServerAndTheToken() throws {
        let keep = FakeKeep()
        var s = State()
        try s.save(url: A, token: "one", demo: false, keep: keep)
        let generation = s.generation
        s.settings.prefs.openOn = .click
        try keep.write(s.settings)
        XCTAssertEqual(used(s, keep), ["one", "one"])
        XCTAssertEqual(keep.file?.url, A)
        XCTAssertEqual(keep.file?.prefs.openOn, .click)
        XCTAssertEqual(s.generation, generation, "what is shown stays")
    }

    func testTheNotchGoesOnTheScreenNothingIsRightOf() {
        XCTAssertNil(rightmostScreen(rightEdges: []))
        XCTAssertEqual(rightmostScreen(rightEdges: [1512]), 0)
        // The menu bar's screen in the middle, one on each side: the right one
        XCTAssertEqual(rightmostScreen(rightEdges: [1920, 3840, 0]), 1)
        // One left of the menu bar's screen: the menu bar's
        XCTAssertEqual(rightmostScreen(rightEdges: [1512, 0]), 0)
        // Stacked, reaching as far right: the first
        XCTAssertEqual(rightmostScreen(rightEdges: [1920, 1920]), 0)
    }
}
