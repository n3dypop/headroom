// The sample the client shows until it is connected (or when chosen in Settings): the widget's "three" demo (Codex, Claude and
// Gemini on an ordinary day), built the way the widget's demoResult builds it, relative to now.

import Foundation

private let MINUTE = 60_000.0

private func at(_ now: Double, _ minutes: Double) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date(timeIntervalSince1970: ((now + minutes * MINUTE) / 1000).rounded(.down)))
}

private struct W {
    var scope: String?
    var recent: Double?
    var rate: Double?
    var resets: Double?? = nil
    var detail = false
}

private func win(_ now: Double, _ id: String, _ used: Double, _ o: W = W()) -> (String, JSON) {
    let five = id.contains("five_hour")
    let resets: JSON
    switch o.resets {
    case .some(.none): resets = .null
    case .some(.some(let m)): resets = .string(at(now, m))
    case .none: resets = .string(at(now, five ? 180 : 3 * 1440))
    }
    let n = { (v: Double?) in v.map(JSON.number) ?? .null }
    return (id, .object([
        "id": .string(id), "label": .string(id), "scope": o.scope.map(JSON.string) ?? .null, "used_percent": .number(used),
        "recent_consumed_percent": n(o.recent), "recent_quality": .string(o.recent == nil ? "unknown" : "exact"),
        "recent_minutes": .number(five ? 60 : 1440), "confidence": .string("high"), "fetched_at": .string(at(now, -1)), "resets_at": resets,
        "eta_at": .null, "reset_first": .null, "eta_minutes": .null, "rate_15m": .null,
        "rate_60m": n(o.rate), "rate_24h": n(o.rate), "rate_pace": .number(o.rate ?? 0), "detail_only": .bool(o.detail),
    ]))
}

private func provider(_ plan: String, _ collector: String, _ windows: [(String, JSON)]) -> JSON {
    let ids = { (main: Bool) in
        windows.filter { !main || $0.1["scope"]?.isNull == true }.map(\.0).joined(separator: ",")
    }
    return .object([
        "status": .string("ok"), "plan": .string(plan), "error_code": .null, "collector": .string(collector),
        "main_window_ids": .string(ids(true)), "window_ids": .string(ids(false)),
        "windows": .object(Dictionary(uniqueKeysWithValues: windows)),
    ])
}

private func r(_ recent: Double, _ rate: Double) -> W {
    W(recent: recent, rate: rate)
}

/** The sample view at `now` (milliseconds), in the server's shape */
public func demoBody(_ now: Double) -> JSON {
    let claude = provider("max", "desktop", [
        win(now, "five_hour", 35, r(6, 4)), win(now, "seven_day", 22, r(3, 0.4)), win(now, "seven_day_fable", 10, W(scope: "Fable")),
    ])
    let codex = provider("plus", "laptop", [win(now, "five_hour", 20, r(2, 3)), win(now, "seven_day", 41, r(5, 0.5))])
    let partner = { (id: String, used: Double) in win(now, id, used, W(scope: "Claude and GPT", detail: true)) }
    let gemini = provider("pro", "desktop", [
        win(now, "five_hour", 28, r(4, 3)), win(now, "seven_day", 33, r(4, 0.4)),
        win(now, "seven_day_argon", 100, W(scope: "Argon", resets: .some(2 * 1440))),
        partner("partner_five_hour", 8), partner("partner_seven_day", 5),
    ])
    return .object([
        "view_version": .number(1), "data_version": .number(1),
        "boundaries": .object(["claude": .string("#0"), "codex": .string("#0"), "gemini": .string("#0")]),
        "claude": claude, "codex": codex, "gemini": gemini,
    ])
}
