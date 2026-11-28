// The notch's settings in desktop.json (each key on its own, the server and its token never lost) and where the notch sits.

import Foundation
import XCTest
@testable import HeadroomKit

private func decode(_ text: String) throws -> Settings {
    try JSONDecoder().decode(Settings.self, from: Data(text.utf8))
}

/** A settings file as written, read back as JSON */
private func written(_ s: Settings) throws -> [String: JSON] {
    try XCTUnwrap(JSON.parse(try JSONEncoder().encode(s))?.object)
}

final class PrefsTests: XCTestCase {
    func testAFileWithoutThemIsTheDefaults() throws {
        let s = try decode(#"{"url":"https://a.example","demo":false,"token_slot":7}"#)
        XCTAssertEqual(s.prefs, Prefs())
        XCTAssertEqual(s.url, "https://a.example")
        XCTAssertEqual(s.tokenSlot, 7)
        let p = Prefs()
        XCTAssertEqual(p.display, "")
        XCTAssertEqual(p.position, 50)
        XCTAssertEqual(p.size, .normal)
        XCTAssertEqual(p.theme, .dark)
        XCTAssertTrue(p.glassBackdrop)
        XCTAssertEqual(p.glassTint, .clear)
        XCTAssertEqual(p.openOn, .hover)
        XCTAssertEqual(p.foldDelay, .normal)
        XCTAssertTrue(p.motion)
        XCTAssertTrue(p.hideFullscreen)
    }

    func testEveryValueIsRead() throws {
        let s = try decode("""
            {"url":"https://a.example","demo":true,"token_slot":3,"display":"screen:69733378","position":0,"size":"large",
             "theme":"glass","glass_backdrop":false,"glass_tint":"light","open_on":"click","fold_delay":"long","motion":false,
             "hide_fullscreen":false}
            """)
        var p = Prefs()
        p.display = "screen:69733378"
        p.position = 0
        p.size = .large
        p.theme = .glass
        p.glassBackdrop = false
        p.glassTint = .light
        p.openOn = .click
        p.foldDelay = .long
        p.motion = false
        p.hideFullscreen = false
        XCTAssertEqual(s.prefs, p)
        XCTAssertEqual(s.url, "https://a.example")
        XCTAssertTrue(s.demo)
        XCTAssertEqual(s.tokenSlot, 3)
        XCTAssertEqual(try decode(#"{"position":100}"#).prefs.position, 100)
        XCTAssertEqual(try decode(#"{"theme":"system"}"#).prefs.theme, .system)
        var q = Prefs()
        q.size = .small
        q.foldDelay = .short
        q.glassTint = .dark
        XCTAssertEqual(try decode(#"{"size":"small","fold_delay":"short","glass_tint":"dark"}"#).prefs, q)
    }

    func testAWrongTypeOrAnUnknownValueResetsThatKeyOnly() throws {
        let s = try decode("""
            {"url":"https://a.example","demo":false,"token_slot":9,"display":2,"position":"50","size":"huge","theme":"Dark",
             "glass_backdrop":1,"glass_tint":null,"open_on":true,"fold_delay":["long"],"motion":"no","hide_fullscreen":false}
            """)
        var p = Prefs()
        p.hideFullscreen = false
        XCTAssertEqual(s.prefs, p, "only the one good key is taken")
        XCTAssertEqual(s.url, "https://a.example")
        XCTAssertEqual(s.tokenSlot, 9)
        for bad in ["-1", "101", "50.5", "1e9", "true"] {
            XCTAssertEqual(try decode(#"{"position":\#(bad)}"#).prefs.position, 50, bad)
        }
        XCTAssertEqual(try decode(#"{"position":37.0}"#).prefs.position, 37, "a whole number written with a point")
        let long = String(repeating: "x", count: 65)
        XCTAssertEqual(try decode(#"{"display":"\#(long)"}"#).prefs.display, "", "longer than a screen's name")
        XCTAssertEqual(try decode(#"{"display":"screen:7"}"#).prefs.display, "screen:7")
    }

    func testBadPrefsNeverLoseTheServerOrTheToken() throws {
        let s = try decode(#"{"url":"https://b.example","demo":true,"token_slot":12,"theme":{},"position":[],"motion":null}"#)
        XCTAssertEqual(s.url, "https://b.example")
        XCTAssertTrue(s.demo)
        XCTAssertEqual(s.tokenSlot, 12)
        XCTAssertEqual(s.prefs, Prefs())
    }

    func testWrittenAndReadBackTheSame() throws {
        var p = Prefs()
        p.display = "screen:1"
        p.position = 73
        p.size = .small
        p.theme = .light
        p.glassBackdrop = false
        p.glassTint = .dark
        p.openOn = .click
        p.foldDelay = .short
        p.motion = false
        p.hideFullscreen = false
        let s = Settings(url: "https://a.example", demo: false, tokenSlot: 5, prefs: p)
        let data = try JSONEncoder().encode(s)
        XCTAssertEqual(try JSONDecoder().decode(Settings.self, from: data), s)
        let o = try written(s)
        XCTAssertEqual(Set(o.keys), Set(Prefs.keys + ["url", "demo", "token_slot"]))
        for (k, v) in p.json { XCTAssertEqual(o[k], v, k) }
        XCTAssertEqual(Prefs(json: p.json), p)
        // The position is a whole number in the file (the Windows client reads it as one)
        let text = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(text.contains(#""position":73"#), text)
        XCTAssertFalse(text.contains("73."), text)
        // The defaults too
        XCTAssertEqual(try JSONDecoder().decode(Settings.self, from: JSONEncoder().encode(Settings())), Settings())
    }

    func testTheSameTokenIgnoresThePrefs() {
        var a = Settings(url: "https://a.example", demo: false, tokenSlot: 1)
        let b = a
        a.prefs.theme = .glass
        a.demo = true
        XCTAssertTrue(a.sameToken(as: b))
        a.tokenSlot = 2
        XCTAssertFalse(a.sameToken(as: b))
    }

    func testTheGraceTimes() {
        XCTAssertEqual(FoldDelay.normal.foldSeconds, 0.45)
        XCTAssertEqual(FoldDelay.normal.cardSeconds, 0.25)
        XCTAssertLessThan(FoldDelay.short.foldSeconds, FoldDelay.normal.foldSeconds)
        XCTAssertGreaterThan(FoldDelay.long.foldSeconds, FoldDelay.normal.foldSeconds)
        XCTAssertEqual(NotchSize.small.scale, 0.85)
        XCTAssertEqual(NotchSize.normal.scale, 1.0)
        XCTAssertEqual(NotchSize.large.scale, 1.2)
    }

    // MARK: Where the notch sits

    func testTheMiddleIsTheCentredLayoutExactly() {
        for (area, win, pill) in [(982.0, 660.0, 288.0), (1117.0, 660.0, 212.0), (500.0, 500.0, 436.0), (875.5, 660.0, 364.0),
                                  (300.0, 300.0, 512.0)] {
            let at = notchPlace(areaHeight: area, winH: win, pillH: pill, position: 50)
            XCTAssertEqual(at.windowY, (area - win) / 2)
            XCTAssertEqual(at.pillY, (win - pill) / 2)
        }
    }

    func testTheEndsKeepTheMargin() {
        let top = notchPlace(areaHeight: 1000, winH: 660, pillH: 288, position: 0)
        XCTAssertEqual(top.windowY, 340, "the window's top at the area's top")
        XCTAssertEqual(top.pillY, PLACE_MARGIN)
        let bottom = notchPlace(areaHeight: 1000, winH: 660, pillH: 288, position: 100)
        XCTAssertEqual(bottom.windowY, 0)
        XCTAssertEqual(bottom.pillY, 660 - 288 - PLACE_MARGIN)
        let quarter = notchPlace(areaHeight: 1000, winH: 660, pillH: 288, position: 25)
        XCTAssertEqual(quarter.windowY, 255)
        XCTAssertEqual(quarter.pillY, PLACE_MARGIN + 0.25 * (660 - 288 - 2 * PLACE_MARGIN), accuracy: 1e-9)
        // Out of range is taken as the nearest end
        XCTAssertEqual(notchPlace(areaHeight: 1000, winH: 660, pillH: 288, position: -5), top)
        XCTAssertEqual(notchPlace(areaHeight: 1000, winH: 660, pillH: 288, position: 140), bottom)
    }

    func testAWindowAsTallAsTheAreaMovesOnlyThePill() {
        let a = notchPlace(areaHeight: 600, winH: 600, pillH: 200, position: 0)
        let b = notchPlace(areaHeight: 600, winH: 600, pillH: 200, position: 100)
        XCTAssertEqual(a.windowY, 0)
        XCTAssertEqual(b.windowY, 0)
        XCTAssertEqual(a.pillY, PLACE_MARGIN)
        XCTAssertEqual(b.pillY, 600 - 200 - PLACE_MARGIN)
    }

    func testAPillTooTallForTheMarginsStaysCentred() {
        for position in [0, 30, 100] {
            XCTAssertEqual(notchPlace(areaHeight: 600, winH: 600, pillH: 590, position: position).pillY, 5)
        }
    }

    func testTheChosenScreenOrTheOneFurthestRight() {
        let keys: [String?] = ["screen:1", "screen:2", nil]
        let edges = [1512.0, 3432.0, 0.0]
        XCTAssertEqual(chosenScreen(display: "", keys: keys, rightEdges: edges), 1)
        XCTAssertEqual(chosenScreen(display: "screen:1", keys: keys, rightEdges: edges), 0)
        XCTAssertEqual(chosenScreen(display: "screen:2", keys: keys, rightEdges: edges), 1)
        XCTAssertEqual(chosenScreen(display: "screen:9", keys: keys, rightEdges: edges), 1, "not connected: the one furthest right")
        XCTAssertEqual(chosenScreen(display: #"\\.\DISPLAY2"#, keys: keys, rightEdges: edges), 1, "a Windows name")
        XCTAssertNil(chosenScreen(display: "screen:1", keys: [], rightEdges: []))
        XCTAssertEqual(screenKey(69733378), "screen:69733378")
    }
}
