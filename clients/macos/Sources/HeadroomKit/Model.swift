// What the notch, its card and the menu show, from the server's view. These are the widget's own rules
// (packages/scriptable/Headroom.js: sanitizeView, groupsOf, timeShort, barSegmentsAt, remainingText, rowLabel, paceText,
// freshnessOf), as clients/windows/src/model.rs carries them too. clients/windows/tests/parity.json holds the widget's answers
// for a set of views; the tests check these functions give the same.
//
// Times are milliseconds since the epoch as Double, as in the widget: an unreadable time is NaN and every comparison with it is
// false, which is what the widget's rules rely on.

import Foundation

private let MINUTE = 60_000.0
private let DAY = 24.0 * 60.0 * MINUTE
/** Values up to this old are fresh; up to the next, a while ago; older, old */
private let FRESH_MAX_MINUTES = 20.0
private let CAUTION_MAX_MINUTES = 75.0
private let VIEW_VERSION = 1.0
/** At most this many limits per provider: the client's own bound (the widget has none; a view has a handful) */
let MAX_WINDOWS = 256

/** The providers in the order they are shown */
public let PROVIDER_ORDER = ["codex", "claude", "gemini"]
private let DEFAULT_PROVIDERS = ["codex", "claude"]
/** Every view carries these (possibly null) */
private let VIEW_PROVIDERS = ["claude", "codex"]
private let PROVIDER_STATUSES = ["ok", "stale", "error", "unavailable"]
private let RECENT_QUALITIES = ["exact", "approx", "unknown"]
private let CONFIDENCES = ["high", "medium", "low", "insufficient"]
private let NOT_AVAILABLE = "Not available"
private let NOT_STARTED = "On first use"
private let RESET_UNKNOWN = "Reset unknown"
private let GRAY = "#8e8e93"

private let PLAN_NAMES: [(String, String)] = [
    ("free", "Free"), ("go", "Go"), ("plus", "Plus"), ("pro", "Pro"), ("prolite", "Pro Lite"), ("max", "Max"), ("ultra", "Ultra"),
    ("team", "Team"), ("business", "Business"), ("enterprise", "Enterprise"), ("edu", "Edu"),
]
private let ERROR_NAMES: [(String, String)] = [
    ("login_required", "Sign in required"), ("not_installed", "Not installed"), ("fetch_failed", "Couldn't fetch"),
    ("safety_stop", "Paused for safety"), ("account_changed", "Account changed, paused"), ("access_denied", "Access denied"),
]
private let SCOPE_NAMES: [(String, String)] = [("Codex extra", "Extra"), ("codex_other", "Other"), ("Claude and GPT", "Claude/GPT")]
/** Shorter names where a column has room for about "Argon wk" */
private let WIDGET_SCOPE_NAMES: [(String, String)] = [("Claude and GPT", "C+G")]

private func lookup(_ table: [(String, String)], _ key: String) -> String? {
    table.first { $0.0 == key }?.1
}

public func providerName(_ provider: String) -> String {
    switch provider {
    case "claude": return "Claude"
    case "codex": return "Codex"
    default: return "Gemini"
    }
}

/** A provider's brand color (the ring, the bars) */
public func brandColor(_ provider: String) -> String {
    switch provider {
    case "claude": return "#D97757"
    case "codex": return "#6E7CF7"
    case "gemini": return "#1A9FD6"
    default: return GRAY
    }
}

private func freshColor(_ level: String) -> String {
    switch level {
    case "fresh": return "#34C759"
    case "limit": return "#FF3B30"
    default: return "#8E8E93"
    }
}

// MARK: - Reading the view

/** One limit of a provider, as the server sends it (only what the client shows) */
public struct Window {
    public var id: String
    public var label: String
    public var scope: String?
    public var usedPercent: Double
    public var recentConsumedPercent: Double?
    public var recentMinutes: Double?
    public var recentQuality: String
    public var confidence: String?
    public var fetchedAt: String?
    public var resetsAt: String?
    public var rate60m: Double?
    public var rate24h: Double?
    /** The rate the server's forecast used. nil when the field is absent (an older server: no forecast is drawn) */
    public var ratePace: Double??
    public var detailOnly: Bool
}

/** A provider's part of the view */
public struct Provider {
    public var status: String?
    public var plan: String?
    public var errorCode: String?
    public var blocked: Bool?
    public var mainWindowIds: [String]
    public var windowIds: [String]
    /** In the order of windowIds */
    public var windows: [Window]

    func window(_ id: String) -> Window? {
        windows.first { $0.id == id }
    }
}

/** The server's view, checked */
public struct View {
    /** The number of the data read: a view older than one already shown is not shown */
    public var dataVersion: UInt64
    /** In the order of PROVIDER_ORDER */
    var providers: [Provider?]

    public func provider(_ name: String) -> Provider? {
        guard let i = PROVIDER_ORDER.firstIndex(of: name) else { return nil }
        return providers[i]
    }
}

/** The first `max` UTF-16 units of a text (as JavaScript's slice), never splitting a character */
func utf16Prefix(_ s: String, _ max: Int) -> String {
    var units = 0
    var out = ""
    for c in s.unicodeScalars {
        units += String(c).utf16.count
        if units > max { break }
        out.unicodeScalars.append(c)
    }
    return out
}

private func text(_ v: JSON?, _ max: Int) -> String? {
    v?.string.map { utf16Prefix($0, max) }
}

private func num(_ v: JSON?) -> Double? {
    v?.number
}

private func oneOf(_ v: JSON?, _ list: [String]) -> String? {
    guard let s = v?.string else { return nil }
    return list.contains(s) ? s : nil
}

private func isWindowId(_ id: String) -> Bool {
    let b = Array(id.utf8)
    return (1...64).contains(b.count) && b.allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 }
}

/** One plain word: letters, digits, . _ -, up to 24, starting with a letter or digit */
func plainWord(_ s: String) -> Bool {
    let b = Array(s.utf8)
    let alnum = { (c: UInt8) in (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) }
    return (1...24).contains(b.count) && alnum(b[0]) && b.allSatisfy { alnum($0) || $0 == 46 || $0 == 95 || $0 == 45 }
}

/** A number as JavaScript writes it in text */
func jsNumber(_ x: Double) -> String {
    if x == 0 { return "0" }
    if x.isNaN { return "NaN" }
    if x.isInfinite { return x > 0 ? "Infinity" : "-Infinity" }
    // Swift's shortest digits, laid out as JavaScript lays them out
    let d = "\(abs(x))"
    var digits = ""
    var exp = 0
    if let e = d.firstIndex(where: { $0 == "e" || $0 == "E" }) {
        let mantissa = String(d[..<e])
        exp = Int(d[d.index(after: e)...]) ?? 0
        let parts = mantissa.split(separator: ".", omittingEmptySubsequences: false)
        digits = String(parts[0]) + (parts.count > 1 ? String(parts[1]) : "")
        exp += parts[0].count
    } else {
        let parts = d.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0])
        let frac = parts.count > 1 ? String(parts[1]) : ""
        digits = whole + frac
        exp = whole.count
    }
    // Strip leading zeros (moving the point) and trailing zeros
    while digits.count > 1 && digits.hasPrefix("0") {
        digits.removeFirst()
        exp -= 1
    }
    while digits.count > 1 && digits.hasSuffix("0") {
        digits.removeLast()
    }
    let sign = x < 0 ? "-" : ""
    let n = digits.count
    // exp: the decimal point sits after `exp` digits
    if exp >= 22 || exp <= -6 {
        let e = exp - 1
        let mantissa = n == 1 ? digits : String(digits.prefix(1)) + "." + String(digits.dropFirst())
        return "\(sign)\(mantissa)e\(e >= 0 ? "+" : "-")\(abs(e))"
    }
    if exp >= n {
        return sign + digits + String(repeating: "0", count: exp - n)
    }
    if exp > 0 {
        return sign + String(digits.prefix(exp)) + "." + String(digits.dropFirst(exp))
    }
    return sign + "0." + String(repeating: "0", count: -exp) + digits
}

/** JavaScript's String() of a value, for the id lists */
private func jsString(_ v: JSON) -> String {
    switch v {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .number(let n): return jsNumber(n)
    case .string(let s): return s
    case .array(let a): return a.map { $0.isNull ? "" : jsString($0) }.joined(separator: ",")
    case .object: return "[object Object]"
    }
}

/** The ids in a list. nil past the bound on limits (such a list can't name only the provider's windows anyway) */
func idList(_ v: JSON?) -> [String]? {
    let s: String
    switch v {
    case nil, .null?: s = ""
    case let v?: s = jsString(v)
    }
    var ids: [String] = []
    for part in s.split(separator: ",", omittingEmptySubsequences: true) {
        ids.append(String(part))
        if ids.count > MAX_WINDOWS { return nil }
    }
    return ids
}

private func sameSet(_ list: [String], _ expected: [String]) -> Bool {
    let seen = Set(list)
    return seen.count == list.count && list.count == expected.count && expected.allSatisfy { seen.contains($0) }
}

private func sanitizeWindow(_ w: JSON) -> Window? {
    guard let o = w.object, let id = o["id"]?.string, isWindowId(id), let used = num(o["used_percent"]) else { return nil }
    return Window(
        id: id,
        label: text(o["label"], 24) ?? id,
        scope: text(o["scope"], 32),
        usedPercent: used,
        recentConsumedPercent: num(o["recent_consumed_percent"]),
        recentMinutes: num(o["recent_minutes"]),
        recentQuality: oneOf(o["recent_quality"], RECENT_QUALITIES) ?? "unknown",
        confidence: oneOf(o["confidence"], CONFIDENCES),
        fetchedAt: text(o["fetched_at"], 40),
        resetsAt: text(o["resets_at"], 40),
        rate60m: num(o["rate_60m"]),
        rate24h: num(o["rate_24h"]),
        ratePace: o.keys.contains("rate_pace") ? .some(num(o["rate_pace"])) : nil,
        detailOnly: o["detail_only"] == .bool(true)
    )
}

private enum Sanitized {
    case none
    case provider(Provider)
    case invalid
}

/** A provider's part: none when it has no values, invalid when malformed (the whole view is refused) */
private func sanitizeProvider(_ p: JSON?) -> Sanitized {
    guard let p, !p.isNull else { return .none }
    guard let o = p.object, let raw = o["windows"]?.object, raw.count <= MAX_WINDOWS else { return .invalid }
    // If any window is invalid, the whole view is (no view with a limit silently dropped)
    var windows: [Window] = []
    for (id, w) in raw {
        guard let clean = sanitizeWindow(w), clean.id == id else { return .invalid }
        // The widget's object can't hold this key, so the widget drops it
        if id != "__proto__" { windows.append(clean) }
    }
    guard let main = idList(o["main_window_ids"]), let all = idList(o["window_ids"]) else { return .invalid }
    let keys = windows.map(\.id)
    let overall = windows.filter { $0.scope == nil }.map(\.id)
    if !sameSet(all, keys) || !sameSet(main, overall) { return .invalid }
    let errorCode = oneOf(o["error_code"], ERROR_NAMES.map(\.0))
    // Stopped by an access denial: none of its values is shown (they would read as current), only the stop
    let denied = errorCode == "access_denied"
    windows.sort { (all.firstIndex(of: $0.id) ?? 0) < (all.firstIndex(of: $1.id) ?? 0) }
    return .provider(Provider(
        status: oneOf(o["status"], PROVIDER_STATUSES),
        plan: oneOf(o["plan"], PLAN_NAMES.map(\.0)),
        errorCode: errorCode,
        blocked: denied ? nil : o["blocked"]?.bool,
        mainWindowIds: denied ? [] : main,
        windowIds: denied ? [] : all,
        windows: denied ? [] : windows
    ))
}

/** The server's view, checked as the widget checks it. nil if it can't be shown (the client keeps what it showed) */
public func sanitizeView(_ body: JSON) -> View? {
    guard let o = body.object, o["view_version"]?.number == VIEW_VERSION else { return nil }
    guard VIEW_PROVIDERS.allSatisfy({ o.keys.contains($0) }) else { return nil }
    var providers: [Provider?] = []
    for p in PROVIDER_ORDER {
        switch sanitizeProvider(o[p]) {
        case .none: providers.append(nil)
        case .provider(let v): providers.append(v)
        case .invalid: return nil
        }
    }
    guard let v = o["data_version"]?.number, v.rounded(.towardZero) == v, v >= 0, v <= 9_007_199_254_740_991 else { return nil }
    return View(dataVersion: UInt64(v), providers: providers)
}

// MARK: - Times

/** The time zone a time without an offset is read in (JavaScript reads it as local time); set by notchModel */
var displayZone = TimeZone(identifier: "UTC")!

/** Days from 1970-01-01 to a civil date (proleptic Gregorian) */
private func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = m <= 2 ? y0 - 1 : y0
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let mp = (m + 9) % 12
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097 + doe - 719_468
}

/** Digits of a fixed count at the start of a text */
private func digits(_ s: Substring, _ n: Int) -> (Int, Substring)? {
    guard s.count >= n else { return nil }
    let head = s.prefix(n)
    guard head.allSatisfy({ $0.isASCII && $0.isNumber }), let v = Int(head) else { return nil }
    return (v, s.dropFirst(n))
}

/** Local civil milliseconds (as if UTC) to an instant in a time zone: a time skipped by a clock change moves forward, a repeated
 * one is the first (as JavaScript reads it) */
private func localToUTC(_ local: Double, _ tz: TimeZone) -> Double {
    let offset = { (t: Double) in Double(tz.secondsFromGMT(for: Date(timeIntervalSince1970: t / 1000))) * 1000 }
    // The offsets on either side of a change near this time; an instant is right when its own offset is the one it used
    let before = offset(local - 86_400_000)
    let after = offset(local + 86_400_000)
    let valid = [before, after].map { local - $0 }.filter { u in offset(u) == local - u }
    // Repeated: the first; skipped: read with the offset before the change, which moves it forward
    return valid.min() ?? local - before
}

/** A time in the format JavaScript's Date.parse defines, as far as the server writes it: YYYY[-MM[-DD]] read as UTC, or with
 * THH:mm[:ss[.fraction]] and Z, ±HH:mm or no offset (local time). Not read (NaN), though Date.parse reads them: 24:00, six-digit
 * years, and the other forms Date.parse falls back to. Milliseconds since the epoch */
func parseTime(_ s: String?) -> Double {
    guard let s else { return .nan }
    func parse() -> Double? {
        var rest = Substring(s)
        guard let (year, r0) = digits(rest, 4) else { return nil }
        rest = r0
        var month = 1, day = 1
        if rest.first == "-" {
            guard let (m, r) = digits(rest.dropFirst(), 2) else { return nil }
            (month, rest) = (m, r)
            if rest.first == "-" {
                guard let (d, r2) = digits(rest.dropFirst(), 2) else { return nil }
                (day, rest) = (d, r2)
            }
        }
        var hour = 0, minute = 0, second = 0, millis = 0
        var offset: Int? = 0
        if rest.first == "T" || rest.first == "t" {
            guard let (h, r1) = digits(rest.dropFirst(), 2), r1.first == ":", let (mi, r2) = digits(r1.dropFirst(), 2) else { return nil }
            (hour, minute, rest) = (h, mi, r2)
            if rest.first == ":" {
                guard let (sec, r3) = digits(rest.dropFirst(), 2) else { return nil }
                (second, rest) = (sec, r3)
                if rest.first == "." {
                    let frac = rest.dropFirst().prefix { $0.isASCII && $0.isNumber }
                    if frac.isEmpty { return nil }
                    // Milliseconds only, the rest cut off (as Date.parse does)
                    millis = Int(String((String(frac) + "000").prefix(3))) ?? 0
                    rest = rest.dropFirst(1 + frac.count)
                }
            }
            if rest.isEmpty {
                offset = nil
            } else if rest == "Z" || rest == "z" {
                rest = ""
                offset = 0
            } else {
                let sign: Int
                switch rest.first {
                case "+": sign = 1
                case "-": sign = -1
                default: return nil
                }
                guard let (oh, r4) = digits(rest.dropFirst(), 2), r4.first == ":", let (om, r5) = digits(r4.dropFirst(), 2), oh <= 23, om <= 59
                else { return nil }
                rest = r5
                offset = sign * (oh * 60 + om)
            }
        }
        // Any day up to 31, carried into the next month as Date.parse does (February 30 is March 2)
        guard rest.isEmpty, (1...12).contains(month), (1...31).contains(day), hour <= 23, minute <= 59, second <= 59 else { return nil }
        let days = daysFromCivil(year, month, 1) + day - 1
        let local = Double(days) * 86_400_000 + Double(hour) * 3_600_000 + Double(minute) * 60_000 + Double(second) * 1000 + Double(millis)
        if let offset { return local - Double(offset) * 60_000 }
        return localToUTC(local, displayZone)
    }
    return parse() ?? .nan
}

/** Math.round (halves up; 0.49999999999999994 is 0) */
func jsRound(_ x: Double) -> Double {
    let f = x.rounded(.down)
    return x - f >= 0.5 ? f + 1 : f
}

/** Math.min, which gives NaN when either is */
private func jsMin(_ a: Double, _ b: Double) -> Double {
    a.isNaN || b.isNaN ? .nan : Swift.min(a, b)
}

// MARK: - A limit at draw time

/** A limit as drawn: its reset recomputed (past the reset: 0% used, estimated) and how old its value is */
public struct Shown {
    public var w: Window
    public var remainingPercent: Double
    public var remainingPercentInt: Double
    public var resetPassed: Bool
    public var valueStatus: String?
}

/** When the recent consumption of a limit at 100% becomes 0 (nothing more can be used at the limit) */
private func recentSettledAt(_ w: Window) -> Double? {
    let fetched = parseTime(w.fetchedAt)
    guard let span = w.recentMinutes, span > 0 else { return nil }
    let recent = w.recentConsumedPercent ?? 0
    if w.usedPercent < 100 || recent <= 0 || !fetched.isFinite { return nil }
    return fetched + span * MINUTE
}

private func atDisplayTime(_ w: Window, _ now: Double) -> Shown {
    let reset = parseTime(w.resetsAt)
    let passed = reset.isFinite && reset <= now
    let fetched = parseTime(w.fetchedAt)
    let status: String?
    if passed {
        status = "reset_estimated"
    } else if !fetched.isFinite {
        status = nil
    } else {
        let ms = Swift.max(0, now - fetched)
        status = ms <= FRESH_MAX_MINUTES * MINUTE ? "fresh" : ms <= CAUTION_MAX_MINUTES * MINUTE ? "stale" : "old"
    }
    let used = passed ? 0 : w.usedPercent
    let settled = !passed && (recentSettledAt(w).map { $0 <= now } ?? false)
    var shown = w
    shown.usedPercent = used
    shown.recentQuality = passed ? "unknown" : settled ? "exact" : w.recentQuality
    shown.recentConsumedPercent = passed ? nil : settled ? 0 : w.recentConsumedPercent
    return Shown(
        w: shown,
        remainingPercent: Swift.min(100, Swift.max(0, 100 - used)),
        remainingPercentInt: Swift.min(100, Swift.max(0, 100 - jsRound(used))),
        resetPassed: passed,
        valueStatus: status
    )
}

// MARK: - Which limits a provider shows

/** One row of a provider: a limit, or a limit it hasn't */
public enum Row {
    case window(Shown)
    case missing(label: String?, text: String)

    var shown: Shown? {
        if case .window(let s) = self { return s }
        return nil
    }
}

/** A provider as the widget's large size shows it: every limit it has, in the widget's order */
public struct Group {
    public var provider: String
    public var name: String
    public var plan: String?
    /** Why there is nothing to draw (no values, an error) */
    public var message: String?
    public var rows: [Row]
}

private func defaultProviders(_ view: View) -> [String] {
    var out = DEFAULT_PROVIDERS
    out += PROVIDER_ORDER.filter { !DEFAULT_PROVIDERS.contains($0) && view.provider($0) != nil }
    return Array(out.prefix(3))
}

/** The overall limits first, then the provider's own per-model ones, then other makers'; in each, 5h, then weekly, then others */
private func sortRows(_ rows: [Row]) -> [Row] {
    func rank(_ r: Row) -> (Int, Int) {
        guard let w = r.shown?.w else { return (0, 0) }
        let group = w.scope == nil ? 0 : w.detailOnly ? 2 : 1
        let length = w.id.contains("five_hour") ? 0 : w.id.contains("seven_day") ? 1 : 2
        return (group, length)
    }
    // A stable sort: equal ranks keep their order
    return rows.enumerated().sorted { a, b in
        let (ra, rb) = (rank(a.element), rank(b.element))
        return ra != rb ? ra < rb : a.offset < b.offset
    }.map(\.element)
}

/** The groups the client shows (the widget's groupsOf with no parameter and every per-model limit) */
func groupsOf(_ view: View, _ now: Double) -> [Group] {
    let listed = defaultProviders(view)
    // The widget's selectWindows: the overall limits of every provider, then the per-model ones at 100%
    var items: [(String, Shown)] = []
    func push(_ provider: String, _ w: Window) {
        if !items.contains(where: { $0.0 == provider && $0.1.w.id == w.id }) { items.append((provider, atDisplayTime(w, now))) }
    }
    for provider in listed {
        guard let p = view.provider(provider) else { continue }
        for id in p.mainWindowIds { if let w = p.window(id) { push(provider, w) } }
    }
    for provider in listed {
        guard let p = view.provider(provider) else { continue }
        for id in p.windowIds {
            if let w = p.window(id), w.scope != nil, !w.detailOnly, atDisplayTime(w, now).w.usedPercent >= 100 { push(provider, w) }
        }
    }
    return listed.map { provider in
        let p = view.provider(provider)
        var rows: [Row] = items.filter { $0.0 == provider }.map { .window($0.1) }
        if let p {
            // Every per-model limit, after the overall ones; then other makers' models the provider offers
            for detail in [false, true] {
                for id in p.windowIds {
                    guard let w = p.window(id) else { continue }
                    let wanted = detail ? w.detailOnly : (w.scope != nil && !w.detailOnly)
                    if wanted && !rows.contains(where: { $0.shown?.w.id == id }) { rows.append(.window(atDisplayTime(w, now))) }
                }
            }
        }
        rows = sortRows(rows)
        if let p, p.status == "ok" || p.status == "stale", !p.mainWindowIds.isEmpty, !p.mainWindowIds.contains("five_hour") {
            rows.insert(.missing(label: nil, text: NOT_AVAILABLE), at: 0)
        }
        let message: String?
        if let p {
            message = rows.isEmpty ? (p.errorCode.flatMap { lookup(ERROR_NAMES, $0) } ?? "No limits to show") : nil
        } else {
            message = provider == "gemini" ? "Not set up" : "No data"
        }
        return Group(provider: provider, name: providerName(provider), plan: p?.plan.flatMap { lookup(PLAN_NAMES, $0) }, message: message, rows: rows)
    }
}

// MARK: - Freshness

/** Whether a provider's limit has most likely lifted since its values were fetched */
private func limitLifted(_ p: Provider, _ ids: [String], _ now: Double) -> Bool {
    let windows = ids.compactMap { p.window($0) }.filter { !$0.detailOnly }
    let overall = p.mainWindowIds.compactMap { p.window($0) }
    func passed(_ w: Window) -> Bool {
        let reset = parseTime(w.resetsAt)
        return reset.isFinite && reset <= now
    }
    return windows.contains(where: passed) && !(windows + overall).contains { $0.usedPercent >= 100 && !passed($0) }
}

/** The header dot: fresh, stale, old by the oldest value's age; limit while the provider is at its limit; unknown */
private func freshnessOf(_ view: View, _ provider: String, _ now: Double) -> String {
    guard let p = view.provider(provider) else { return "unknown" }
    let list = p.mainWindowIds.isEmpty ? p.windows.map(\.id) : p.mainWindowIds
    let oldest = list.compactMap { p.window($0) }.map { parseTime($0.fetchedAt) }.filter(\.isFinite).min()
    if p.blocked == true && !limitLifted(p, list, now) { return "limit" }
    guard let oldest else { return "unknown" }
    let ms = Swift.max(0, now - oldest)
    return ms <= FRESH_MAX_MINUTES * MINUTE ? "fresh" : ms <= CAUTION_MAX_MINUTES * MINUTE ? "stale" : "old"
}

// MARK: - Bars and forecasts

private struct Projection {
    var consume: Double
    var runsOut: Bool
    var at: Double?
}

private func paceOf(_ w: Window) -> Double? {
    guard case .some(.some(let r)) = w.ratePace, r.isFinite, r > 0 else { return nil }
    return r
}

/** Of the remaining part, what will likely be used before the reset; or that it runs out first, and when */
private func projectionOf(_ s: Shown, _ now: Double) -> Projection? {
    let w = s.w
    if s.resetPassed || w.usedPercent >= 100 || !(w.confidence == "high" || w.confidence == "medium") { return nil }
    let remaining = Swift.max(0, 100 - w.usedPercent)
    let reset = parseTime(w.resetsAt)
    if !reset.isFinite || reset <= now { return nil }
    if w.ratePace == nil { return nil }
    guard let pace = paceOf(w) else { return Projection(consume: 0, runsOut: false, at: nil) }
    let perMinute = pace / 60
    let observed = parseTime(w.fetchedAt)
    let from = observed.isFinite ? observed : now
    let at = from + jsRound((remaining / perMinute) * 60_000)
    if at < reset {
        return at <= now ? nil : Projection(consume: remaining, runsOut: true, at: at)
    }
    return Projection(consume: jsMin(remaining, perMinute * ((reset - now) / 60_000)), runsOut: false, at: nil)
}

/** The pieces of a ring or a bar (fractions 0..1, from the start): likely left after the reset (solid), likely used before it
 * (light), and the recent consumption (gray) */
public struct Pieces {
    public var solid: Double
    public var projected: Double
    public var recent: Double
    public var faded: Bool
    public var runsOut: Bool

    var json: [String: Any] {
        ["solid": solid, "projected": projected, "recent": recent, "faded": faded, "runsOut": runsOut]
    }
}

private func pieces(_ s: Shown, _ now: Double) -> Pieces {
    let clamp = { (x: Double) in Swift.min(1, Swift.max(0, x)) }
    let used = clamp((s.w.usedPercent.isNaN ? 0 : s.w.usedPercent) / 100)
    var recent = 0.0
    if let r = s.w.recentConsumedPercent, s.w.recentQuality != "unknown" { recent = jsMin(used, clamp(r / 100)) }
    let remaining = 1 - used
    let p = projectionOf(s, now)
    let projected = p.map { jsMin(remaining, $0.consume / 100) } ?? 0
    return Pieces(solid: Swift.max(0, remaining - projected), projected: projected, recent: recent, faded: s.valueStatus == "old", runsOut: p?.runsOut ?? false)
}

// MARK: - Words

private enum When {
    case timer(Double)
    case text(String)
}

private struct TimeShort {
    var warn: Bool
    var when: When
    var symbol: String?
}

/** "18:10" within 24 hours, "Fri 18:10" beyond */
private func clockText(_ date: Double, _ now: Double) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = displayZone
    let d = Date(timeIntervalSince1970: (date / 1000).rounded(.down))
    let c = cal.dateComponents([.hour, .minute, .weekday], from: d)
    let clock = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    if date - now <= DAY { return clock }
    let day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][((c.weekday ?? 1) - 1) % 7]
    return "\(day) \(clock)"
}

private func whenShort(_ date: Double, _ now: Double) -> When {
    date - now <= DAY ? .timer(date) : .text(clockText(date, now))
}

private func resetPassed(_ w: Window, _ now: Double) -> Bool {
    let reset = parseTime(w.resetsAt)
    return reset.isFinite && reset <= now
}

/** Whether the forecast run-out time has passed with no newer value, before the reset */
private func runOutPassed(_ s: Shown, _ now: Double) -> Bool {
    let reset = parseTime(s.w.resetsAt)
    if !reset.isFinite || reset <= now { return false }
    guard let before = projectionOf(s, parseTime(s.w.fetchedAt)), before.runsOut, let at = before.at else { return false }
    return at <= now && at < reset
}

/** The time of a limit: its run-out time when it will run out before the reset (warn), else its reset; or what they turned into */
private func timeShort(_ s: Shown, _ now: Double) -> TimeShort? {
    if let p = projectionOf(s, now), p.runsOut, let at = p.at {
        if at - now < MINUTE { return TimeShort(warn: true, when: .text("Soon"), symbol: nil) }
        return TimeShort(warn: true, when: whenShort(at, now), symbol: nil)
    }
    if runOutPassed(s, now) { return TimeShort(warn: true, when: .text("Limit"), symbol: nil) }
    let reset = parseTime(s.w.resetsAt)
    let hasReset = !(s.w.resetsAt ?? "").isEmpty
    if hasReset && !s.resetPassed && reset.isFinite && reset > now { return TimeShort(warn: false, when: whenShort(reset, now), symbol: nil) }
    if resetPassed(s.w, now) { return TimeShort(warn: false, when: .text("Reset"), symbol: nil) }
    if !hasReset && !s.resetPassed && s.w.usedPercent == 0 { return TimeShort(warn: false, when: .text(NOT_STARTED), symbol: "start") }
    return s.resetPassed ? nil : TimeShort(warn: false, when: .text(RESET_UNKNOWN), symbol: "unknown")
}

/** "45m", "2h 05m", "<1m" */
public func countdownText(_ ms: Double) -> String {
    if ms < MINUTE { return "<1m" }
    let minutes = Int((ms / MINUTE).rounded(.down))
    if minutes < 60 { return "\(minutes)m" }
    return String(format: "%dh %02dm", minutes / 60, minutes % 60)
}

/** The time line of a limit ("↻ 2h 05m", "⚠ 18m", "⧗ On first use") and whether it warns */
private func timeLine(_ s: Shown, _ now: Double) -> (String, Bool) {
    guard let t = timeShort(s, now) else { return ("", false) }
    let mark = t.warn ? "⚠" : t.symbol == "start" ? "⧗" : t.symbol == "unknown" ? "?" : "↻"
    let body: String
    switch t.when {
    case .timer(let at): body = countdownText(at - now)
    case .text(let s): body = s
    }
    return ("\(mark) \(body)", t.warn)
}

/** What is left: "0%" at the limit, one decimal below 1% (at least 0.1%), else a whole number */
private func remainingText(_ s: Shown) -> String {
    if s.w.usedPercent >= 100 { return "0%" }
    let raw = s.remainingPercent
    if raw > 0 && raw < 1 {
        let tenth = ((jsRound(raw * 1000) / 1000) * 10).rounded(.down) / 10
        return "\(jsNumber(Swift.max(0.1, tenth)))%"
    }
    return "\(jsNumber(s.remainingPercentInt))%"
}

/** The length of a limit: 5h, Weekly, Monthly, 90m, ...; an unknown one by its label when that is one plain word */
private func windowName(_ w: Window) -> String {
    let id = w.id
    for (part, name) in [("five_hour", "5h"), ("seven_day", "Weekly"), ("monthly", "Monthly"), ("primary", "Primary"), ("secondary", "Secondary")] {
        if id.contains(part) { return name }
    }
    var rest = Substring(id)
    while let r = rest.range(of: "window_") {
        rest = rest[r.upperBound...]
        let digits = rest.prefix { $0.isASCII && $0.isNumber }
        if !digits.isEmpty && rest.dropFirst(digits.count).first == "m" {
            let n = Double(digits) ?? 0
            if n.truncatingRemainder(dividingBy: 1440) == 0 { return "\(jsNumber(n / 1440))d" }
            if n.truncatingRemainder(dividingBy: 60) == 0 { return "\(jsNumber(n / 60))h" }
            return "\(jsNumber(n))m"
        }
    }
    return plainWord(w.label) ? w.label : "Limit"
}

private func scopeName(_ scope: String) -> String {
    lookup(WIDGET_SCOPE_NAMES, scope) ?? lookup(SCOPE_NAMES, scope) ?? (plainWord(scope) ? scope : "Other")
}

/** A row's heading: "5h limit", "Wk limit", "Fable wk", "C+G 5h" */
private func rowLabel(_ w: Window) -> String {
    let name = windowName(w)
    let short = name == "Weekly" ? "Wk" : name == "Monthly" ? "Mo" : name
    // An empty scope reads as none (it is falsy to the widget)
    if let scope = w.scope, !scope.isEmpty { return "\(scopeName(scope)) \(short.lowercased())" }
    return "\(short) limit"
}

/** The consumption rate: the last 60 minutes for a 5-hour limit, the last 24 hours otherwise. nil if it can't be measured */
private func paceText(_ s: Shown) -> String? {
    let w = s.w
    if s.resetPassed || w.confidence == "insufficient" { return nil }
    guard let rate = w.id.contains("five_hour") ? (w.rate60m ?? w.rate24h) : (w.rate24h ?? w.rate60m), rate.isFinite, rate >= 0 else { return nil }
    let shown = rate < 10 ? jsRound(rate * 10) / 10 : jsRound(rate)
    return "\(jsNumber(shown))%/h"
}

// MARK: - What the notch, the card and the menu draw

public struct Headline {
    public var id: String
    public var text: String
    public var pieces: Pieces
    public var warn: Bool
}

public struct Fresh {
    public var level: String
    public var color: String
}

public enum CardRow {
    case missing(label: String, text: String)
    case limit(id: String, label: String, left: String, pace: String, time: String, warn: Bool, pieces: Pieces)
}

/** One provider in the notch (its ring) and in the card (its rows) */
public struct Cell {
    public var provider: String
    public var name: String
    public var plan: String?
    public var color: String
    /** The ring: the 5-hour limit, else the weekly one, else the first */
    public var headline: Headline?
    /** The thin outer ring: the weekly limit, when the ring shows another one */
    public var weekly: Pieces?
    public var stale: Bool
    public var fresh: Fresh
    public var message: String?
    public var rows: [CardRow]

    /** In the shape the widget's answers are written in (tests/parity.json) */
    public var json: [String: Any] {
        [
            "provider": provider, "name": name, "plan": plan ?? NSNull(), "color": color,
            "headline": headline.map { ["id": $0.id, "text": $0.text, "pieces": $0.pieces.json, "warn": $0.warn] as [String: Any] } ?? NSNull(),
            "weekly": weekly.map { ["pieces": $0.json] as [String: Any] } ?? NSNull(),
            "stale": stale, "fresh": ["level": fresh.level, "color": fresh.color], "message": message ?? NSNull(),
            "rows": rows.map { r -> [String: Any] in
                switch r {
                case .missing(let label, let text): return ["missing": true, "label": label, "text": text]
                case let .limit(id, label, left, pace, time, warn, pieces):
                    return ["missing": false, "id": id, "label": label, "left": left, "pace": pace, "time": time, "warn": warn, "pieces": pieces.json]
                }
            },
        ]
    }
}

/** Everything the notch and its cards draw, one cell per provider shown */
public func notchModel(_ view: View, _ now: Double, _ tz: TimeZone) -> [Cell] {
    displayZone = tz
    return groupsOf(view, now).map { g in
        let windows = g.rows.compactMap(\.shown)
        let headline = windows.first { $0.w.id == "five_hour" } ?? windows.first { $0.w.id == "seven_day" } ?? windows.first
        let weekly = headline.flatMap { h in h.w.id == "seven_day" ? nil : windows.first { $0.w.id == "seven_day" } }
        let level = freshnessOf(view, g.provider, now)
        return Cell(
            provider: g.provider,
            name: g.name,
            plan: g.plan,
            color: brandColor(g.provider),
            headline: headline.map { Headline(id: $0.w.id, text: remainingText($0), pieces: pieces($0, now), warn: timeLine($0, now).1) },
            weekly: weekly.map { pieces($0, now) },
            stale: level == "stale" || level == "old",
            fresh: Fresh(level: level, color: freshColor(level)),
            message: g.message,
            rows: g.rows.map { r in
                switch r {
                case .missing(let label, let text): return .missing(label: label ?? "5h limit", text: text)
                case .window(let s):
                    let (time, warn) = timeLine(s, now)
                    return .limit(id: s.w.id, label: rowLabel(s.w), left: "\(remainingText(s)) left", pace: paceText(s) ?? "", time: time, warn: warn, pieces: pieces(s, now))
                }
            }
        )
    }
}

/** The menu's lines and its tooltip */
public struct Tray: Equatable {
    public var lines: [String]
    public var tooltip: String
}

/** The menu bar's tooltip is kept as short as the Windows tray's (127 characters) */
private let TOOLTIP_MAX = 127

public func trayModel(_ cells: [Cell], footer: String?) -> Tray {
    var lines = cells.map { c -> String in
        guard let h = c.headline else { return "\(c.name) — \(c.message ?? "No data")" }
        var label = "", time = ""
        for r in c.rows {
            if case let .limit(id, l, _, _, t, _, _) = r, id == h.id {
                label = " (\(l))"
                time = t.isEmpty ? "" : " · \(t)"
                break
            }
        }
        return "\(c.name) — \(h.text) left\(label)\(time)"
    }
    if let footer, !footer.isEmpty { lines.append(footer) }
    let parts = cells.compactMap { c in c.headline.map { "\(c.name) \($0.text)" } }
    var tooltip = parts.isEmpty ? "Headroom" : "Headroom — \(parts.joined(separator: " · "))"
    if tooltip.utf16.count > TOOLTIP_MAX { tooltip = utf16Prefix(tooltip, TOOLTIP_MAX - 1) + "…" }
    return Tray(lines: lines, tooltip: tooltip)
}

/** What the tests compare: parseTime in a time zone */
public func parseTimeForTest(_ s: String?, zone: TimeZone) -> Double {
    displayZone = zone
    return parseTime(s)
}
