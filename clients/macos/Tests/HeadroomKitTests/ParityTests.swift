// The client words and judges every limit as the widget does: clients/windows/tests/parity.json holds the widget's own answers
// (clients/windows/scripts/make-parity.mjs writes it from packages/scriptable/Headroom.js); these tests check HeadroomKit gives the
// same, as the Windows client's do.

import Foundation
import XCTest
@testable import HeadroomKit

private let fixtureURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("windows/tests/parity.json")

private func fixture() throws -> JSON {
    let data = try Data(contentsOf: fixtureURL)
    return try XCTUnwrap(JSON.parse(data), "parity.json")
}

/** A value built by HeadroomKit as JSON (Bool, Double, String, NSNull, arrays, dictionaries) */
private func toJSON(_ v: Any) -> JSON {
    switch v {
    case is NSNull: return .null
    case let b as Bool: return .bool(b)
    case let n as Double: return .number(n)
    case let n as Int: return .number(Double(n))
    case let s as String: return .string(s)
    case let a as [Any]: return .array(a.map(toJSON))
    case let o as [String: Any]: return .object(o.mapValues(toJSON))
    default: return .string("\(v)")
    }
}

/** Equal as JSON, numbers within rounding; the first difference, or nil */
private func diff(_ a: JSON, _ b: JSON, _ path: String) -> String? {
    switch (a, b) {
    case let (.number(x), .number(y)):
        return abs(x - y) <= 1e-12 * max(abs(x), 1) ? nil : "\(path): \(x) != \(y)"
    case let (.array(x), .array(y)):
        if x.count != y.count { return "\(path): \(x.count) items != \(y.count)" }
        for (i, (p, q)) in zip(x, y).enumerated() { if let d = diff(p, q, "\(path)[\(i)]") { return d } }
        return nil
    case let (.object(x), .object(y)):
        for k in Set(x.keys).union(y.keys).sorted() {
            if let d = diff(x[k] ?? .null, y[k] ?? .null, "\(path).\(k)") { return d }
        }
        return nil
    default:
        return a == b ? nil : "\(path): \(a) != \(b)"
    }
}

/** A case's view: given as JSON text (its numbers as written) or as JSON */
private func bodyOf(_ c: JSON) -> JSON {
    if let t = c["text"]?.string { return JSON.parse(t) ?? .null }
    return c["body"] ?? .null
}

final class ParityTests: XCTestCase {
    func testTheWidgetAndTheClientShowTheSame() throws {
        let f = try fixture()
        let tz = try XCTUnwrap(TimeZone(identifier: try XCTUnwrap(f["time_zone"]?.string)))
        var checked = 0
        for v in try XCTUnwrap(f["views"]?.array) {
            let name = v["name"]?.string ?? "?"
            let view = try XCTUnwrap(sanitizeView(bodyOf(v)), "\(name): refused")
            for s in try XCTUnwrap(v["shown"]?.array) {
                let nowText = s["now"]?.string
                let now = parseTimeForTest(nowText, zone: tz)
                let cells = notchModel(view, now, tz)
                let at = "\(name) at \(nowText ?? "?")"
                if let d = diff(toJSON(cells.map(\.json)), s["cells"] ?? .null, "\(at): cells") { XCTFail(d) }
                let tray = trayModel(cells, footer: nil)
                if let d = diff(toJSON(["lines": tray.lines, "tooltip": tray.tooltip] as [String: Any]), s["tray"] ?? .null, "\(at): tray") { XCTFail(d) }
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 50)
    }

    func testTheClientRefusesWhatTheWidgetRefuses() throws {
        for r in try XCTUnwrap(fixture()["refused"]?.array) {
            XCTAssertNil(sanitizeView(bodyOf(r)), r["name"]?.string ?? "?")
        }
    }

    func testTimesAreReadAsDateParseReadsThem() throws {
        for zone in try XCTUnwrap(fixture()["dates"]?.array) {
            let tz = try XCTUnwrap(TimeZone(identifier: try XCTUnwrap(zone["zone"]?.string)))
            for d in try XCTUnwrap(zone["times"]?.array) {
                let text = d["text"]?.string
                let got = parseTimeForTest(text, zone: tz)
                if let ms = d["ms"]?.number {
                    XCTAssertEqual(got, ms, "\(text ?? "nil") in \(tz.identifier)")
                } else {
                    XCTAssertTrue(got.isNaN, "\(text ?? "nil") in \(tz.identifier): \(got)")
                }
            }
        }
    }

    func testTheSampleIsTheWidgetsOwn() throws {
        let f = try fixture()
        let tz = try XCTUnwrap(TimeZone(identifier: try XCTUnwrap(f["time_zone"]?.string)))
        let three = try XCTUnwrap(f["views"]?.array?.first { $0["name"]?.string == "demo three" })
        let shown = try XCTUnwrap(three["shown"]?.array)
        // The widget's sample was made at the first time it is shown at
        let made = parseTimeForTest(shown[0]["now"]?.string, zone: tz)
        let view = try XCTUnwrap(sanitizeView(demoBody(made)))
        for s in shown {
            let cells = notchModel(view, parseTimeForTest(s["now"]?.string, zone: tz), tz)
            if let d = diff(toJSON(cells.map(\.json)), s["cells"] ?? .null, "demo") { XCTFail(d) }
        }
    }

    func testSmallHelpers() {
        XCTAssertEqual(countdownText(30_000), "<1m")
        XCTAssertEqual(countdownText(45 * 60_000), "45m")
        XCTAssertEqual(countdownText(125 * 60_000), "2h 05m")
        XCTAssertEqual(utf16Prefix("a😀b", 2), "a")
        XCTAssertEqual(utf16Prefix("a😀b", 3), "a😀")
        XCTAssertTrue(plainWord("Fable") && !plainWord("two words") && !plainWord("-x") && !plainWord(String(repeating: "x", count: 25)))
        XCTAssertEqual(idList(.array([.string("a"), .string("b"), .null])), ["a", "b"])
        XCTAssertNil(idList(.string(String(repeating: "a,", count: MAX_WINDOWS + 1))))
        for (x, text) in [(1.5e-7, "1.5e-7"), (1e21, "1e+21"), (1e-6, "0.000001"), (0.1, "0.1"), (-0.0, "0"), (12.0, "12"), (2.5e25, "2.5e+25"), (1e16, "10000000000000000"), (123.456, "123.456")] {
            XCTAssertEqual(jsNumber(x), text)
        }
        XCTAssertEqual(jsRound(0.49999999999999994), 0)
        XCTAssertEqual(jsRound(2.5), 3)
        XCTAssertTrue(parseTimeForTest("not a time", zone: TimeZone(identifier: "UTC")!).isNaN)
    }
}
