//! What the notch, its card and the tray show, from the server's view. These are the widget's own rules
//! (packages/scriptable/Headroom.js: sanitizeView, groupsOf, timeShort, barSegmentsAt, remainingText, rowLabel, paceText,
//! freshnessOf), ported so the client words and judges everything as the widget does. tests/parity.json holds the widget's
//! answers for a set of views (scripts/make-parity.mjs writes it); the test at the end checks these functions give the same.
//!
//! Times are milliseconds since the epoch as f64, as in the widget: an unreadable time is NaN and every comparison with it is
//! false, which is what the widget's rules rely on.

use jiff::civil::DateTime;
use jiff::tz::TimeZone;
use jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashSet;

const MINUTE: f64 = 60_000.0;
const DAY: f64 = 24.0 * 60.0 * MINUTE;
/** Values up to this old are fresh; up to the next, a while ago; older, old */
const FRESH_MAX_MINUTES: f64 = 20.0;
const CAUTION_MAX_MINUTES: f64 = 75.0;
const VIEW_VERSION: f64 = 1.0;
/** At most this many limits per provider: the client's own bound (the widget has none; a view has a handful), so a huge answer
 * can't stall the screen */
const MAX_WINDOWS: usize = 256;

/** The providers in the order they are shown */
pub const PROVIDER_ORDER: [&str; 3] = ["codex", "claude", "gemini"];
/** Shown even without values (they say why); any other only when the view has its values */
const DEFAULT_PROVIDERS: [&str; 2] = ["codex", "claude"];
/** Every view carries these (possibly null) */
const VIEW_PROVIDERS: [&str; 2] = ["claude", "codex"];
const PROVIDER_STATUSES: [&str; 4] = ["ok", "stale", "error", "unavailable"];
const RECENT_QUALITIES: [&str; 3] = ["exact", "approx", "unknown"];
const CONFIDENCES: [&str; 4] = ["high", "medium", "low", "insufficient"];
const NOT_AVAILABLE: &str = "Not available";
const NOT_STARTED: &str = "On first use";
const RESET_UNKNOWN: &str = "Reset unknown";
const GRAY: &str = "#8e8e93";

const PLAN_NAMES: [(&str, &str); 11] = [
    ("free", "Free"),
    ("go", "Go"),
    ("plus", "Plus"),
    ("pro", "Pro"),
    ("prolite", "Pro Lite"),
    ("max", "Max"),
    ("ultra", "Ultra"),
    ("team", "Team"),
    ("business", "Business"),
    ("enterprise", "Enterprise"),
    ("edu", "Edu"),
];
const ERROR_NAMES: [(&str, &str); 6] = [
    ("login_required", "Sign in required"),
    ("not_installed", "Not installed"),
    ("fetch_failed", "Couldn't fetch"),
    ("safety_stop", "Paused for safety"),
    ("account_changed", "Account changed, paused"),
    ("access_denied", "Access denied"),
];
const SCOPE_NAMES: [(&str, &str); 3] = [
    ("Codex extra", "Extra"),
    ("codex_other", "Other"),
    ("Claude and GPT", "Claude/GPT"),
];
/** Shorter names where a column has room for about "Argon wk" */
const WIDGET_SCOPE_NAMES: [(&str, &str); 1] = [("Claude and GPT", "C+G")];

fn lookup(table: &[(&'static str, &'static str)], key: &str) -> Option<&'static str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

/** The name shown for a provider */
pub fn provider_name(provider: &str) -> &'static str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        _ => "Gemini",
    }
}

/** A provider's brand color (the ring, the bars) */
pub fn brand_color(provider: &str) -> &'static str {
    match provider {
        "claude" => "#D97757",
        "codex" => "#6E7CF7",
        "gemini" => "#1A9FD6",
        _ => GRAY,
    }
}

fn fresh_color(level: &str) -> &'static str {
    match level {
        "fresh" => "#34C759",
        "limit" => "#FF3B30",
        _ => "#8E8E93",
    }
}

// ---- Reading the view ----

/** One limit of a provider, as the server sends it (only what the client shows) */
#[derive(Clone, Debug)]
pub struct Window {
    pub id: String,
    pub label: String,
    pub scope: Option<String>,
    pub used_percent: f64,
    pub recent_consumed_percent: Option<f64>,
    pub recent_minutes: Option<f64>,
    pub recent_quality: &'static str,
    pub confidence: Option<&'static str>,
    pub fetched_at: Option<String>,
    pub resets_at: Option<String>,
    pub rate_60m: Option<f64>,
    pub rate_24h: Option<f64>,
    /** The rate the server's forecast used. None when the field is absent (an older server: no forecast is drawn) */
    pub rate_pace: Option<Option<f64>>,
    /** Shown in the details only unless named (other makers' models a provider offers) */
    pub detail_only: bool,
}

/** A provider's part of the view */
#[derive(Clone, Debug)]
pub struct Provider {
    pub status: Option<&'static str>,
    pub plan: Option<&'static str>,
    pub error_code: Option<&'static str>,
    pub blocked: Option<bool>,
    pub main_window_ids: Vec<String>,
    pub window_ids: Vec<String>,
    /** In the order of window_ids */
    pub windows: Vec<Window>,
}

impl Provider {
    fn window(&self, id: &str) -> Option<&Window> {
        self.windows.iter().find(|w| w.id == id)
    }
}

/** The server's view, checked */
#[derive(Clone, Debug)]
pub struct View {
    /** The number of the data read: a view older than one already shown is not shown */
    pub data_version: u64,
    /** In the order of PROVIDER_ORDER */
    providers: [Option<Provider>; 3],
}

impl View {
    pub fn provider(&self, name: &str) -> Option<&Provider> {
        let i = PROVIDER_ORDER.iter().position(|p| *p == name)?;
        self.providers[i].as_ref()
    }
}

/** The first `max` UTF-16 units of a text (as JavaScript's slice), never splitting a character */
fn utf16_prefix(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

fn text(v: Option<&Value>, max: usize) -> Option<String> {
    v.and_then(Value::as_str)
        .map(|s| utf16_prefix(s, max).to_string())
}

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

fn one_of(v: Option<&Value>, list: &[&'static str]) -> Option<&'static str> {
    let s = v.and_then(Value::as_str)?;
    list.iter().find(|x| **x == s).copied()
}

fn is_window_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/** One plain word: letters, digits, . _ -, up to 24, starting with a letter or digit */
fn plain_word(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=24).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/** A number as JavaScript writes it in text */
fn js_number(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    if !x.is_finite() {
        return if x.is_nan() {
            "NaN"
        } else if x > 0.0 {
            "Infinity"
        } else {
            "-Infinity"
        }
        .to_string();
    }
    let a = x.abs();
    if (1e-6..1e21).contains(&a) {
        return format!("{x}");
    }
    // "1e+21", "1.5e-7"
    let e = format!("{x:e}");
    let (mantissa, exp) = e.split_once('e').unwrap_or((&e, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    format!(
        "{mantissa}e{}{}",
        if exp >= 0 { '+' } else { '-' },
        exp.abs()
    )
}

/** JavaScript's String() of a value, for the id lists */
fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else {
                    js_string(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/** The ids in a list. None past the bound on limits (such a list can't name only the provider's windows anyway) */
fn id_list(v: Option<&Value>) -> Option<Vec<String>> {
    let s = match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    };
    let ids: Vec<String> = s
        .split(',')
        .filter(|x| !x.is_empty())
        .take(MAX_WINDOWS + 1)
        .map(str::to_string)
        .collect();
    (ids.len() <= MAX_WINDOWS).then_some(ids)
}

fn same_set(list: &[String], expected: &[&str]) -> bool {
    let seen: HashSet<&str> = list.iter().map(String::as_str).collect();
    seen.len() == list.len()
        && list.len() == expected.len()
        && expected.iter().all(|id| seen.contains(id))
}

fn sanitize_window(w: &Value) -> Option<Window> {
    let o = w.as_object()?;
    let id = o.get("id")?.as_str()?;
    if !is_window_id(id) {
        return None;
    }
    let used_percent = num(o.get("used_percent"))?;
    Some(Window {
        id: id.to_string(),
        label: text(o.get("label"), 24).unwrap_or_else(|| id.to_string()),
        scope: text(o.get("scope"), 32),
        used_percent,
        recent_consumed_percent: num(o.get("recent_consumed_percent")),
        recent_minutes: num(o.get("recent_minutes")),
        recent_quality: one_of(o.get("recent_quality"), &RECENT_QUALITIES).unwrap_or("unknown"),
        confidence: one_of(o.get("confidence"), &CONFIDENCES),
        fetched_at: text(o.get("fetched_at"), 40),
        resets_at: text(o.get("resets_at"), 40),
        rate_60m: num(o.get("rate_60m")),
        rate_24h: num(o.get("rate_24h")),
        rate_pace: o.contains_key("rate_pace").then(|| num(o.get("rate_pace"))),
        detail_only: o.get("detail_only") == Some(&Value::Bool(true)),
    })
}

/** A provider's part: Ok(None) when it has no values, Err when malformed (the whole view is refused) */
fn sanitize_provider(p: Option<&Value>) -> Result<Option<Provider>, ()> {
    let p = match p {
        None | Some(Value::Null) => return Ok(None),
        Some(p) => p.as_object().ok_or(())?,
    };
    let raw = p.get("windows").and_then(Value::as_object).ok_or(())?;
    if raw.len() > MAX_WINDOWS {
        return Err(());
    }
    // If any window is invalid, the whole view is (no view with a limit silently dropped)
    let mut windows: Vec<Window> = Vec::new();
    for (id, w) in raw {
        let clean = sanitize_window(w).ok_or(())?;
        if clean.id != *id {
            return Err(());
        }
        // The widget's object can't hold this key, so the widget drops it
        if id != "__proto__" {
            windows.push(clean);
        }
    }
    let main = id_list(p.get("main_window_ids")).ok_or(())?;
    let all = id_list(p.get("window_ids")).ok_or(())?;
    let keys: Vec<&str> = windows.iter().map(|w| w.id.as_str()).collect();
    let overall: Vec<&str> = windows
        .iter()
        .filter(|w| w.scope.is_none())
        .map(|w| w.id.as_str())
        .collect();
    if !same_set(&all, &keys) || !same_set(&main, &overall) {
        return Err(());
    }
    let error_code = one_of(p.get("error_code"), &ERROR_NAMES.map(|(k, _)| k));
    // Stopped by an access denial: none of its values is shown (they would read as current), only the stop
    let denied = error_code == Some("access_denied");
    windows.sort_by_key(|w| all.iter().position(|id| *id == w.id));
    Ok(Some(Provider {
        status: one_of(p.get("status"), &PROVIDER_STATUSES),
        plan: one_of(p.get("plan"), &PLAN_NAMES.map(|(k, _)| k)),
        error_code,
        blocked: if denied {
            None
        } else {
            p.get("blocked").and_then(Value::as_bool)
        },
        main_window_ids: if denied { Vec::new() } else { main },
        window_ids: if denied { Vec::new() } else { all },
        windows: if denied { Vec::new() } else { windows },
    }))
}

/** The server's view, checked as the widget checks it. None if it can't be shown (the client keeps what it showed) */
pub fn sanitize_view(body: &Value) -> Option<View> {
    let o = body.as_object()?;
    if o.get("view_version").and_then(Value::as_f64) != Some(VIEW_VERSION) {
        return None;
    }
    if !VIEW_PROVIDERS.iter().all(|p| o.contains_key(*p)) {
        return None;
    }
    let mut providers: [Option<Provider>; 3] = [None, None, None];
    for (i, p) in PROVIDER_ORDER.iter().enumerate() {
        providers[i] = sanitize_provider(o.get(*p)).ok()?;
    }
    let v = o.get("data_version").and_then(Value::as_f64)?;
    if v.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&v) {
        return None;
    }
    Some(View {
        data_version: v as u64,
        providers,
    })
}

// ---- A limit at draw time ----

thread_local! {
    /** The time zone a time without an offset is read in (JavaScript reads it as local time) */
    static ZONE: RefCell<TimeZone> = const { RefCell::new(TimeZone::UTC) };
}

/** Digits of a fixed count at the start of a text */
fn digits(s: &str, n: usize) -> Option<(i64, &str)> {
    let head = s.get(..n)?;
    head.bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| (head.parse().unwrap_or(0), &s[n..]))
}

/** A time in the format JavaScript's Date.parse defines, as far as the server writes it (its times are toISOString's): YYYY[-MM[-DD]]
 * read as UTC, or with THH:mm[:ss[.fraction]] and Z, ±HH:mm or no offset (local time; a time skipped by a clock change moves
 * forward, a repeated one is the first). Not read (NaN), though Date.parse reads them: 24:00, six-digit years, and the other
 * forms Date.parse falls back to (such as "Mon, 16 Nov 2026 14:05:00"). Milliseconds since the epoch */
fn parse_time(s: Option<&str>) -> f64 {
    let Some(s) = s else { return f64::NAN };
    let parse = || -> Option<f64> {
        let (year, mut rest) = digits(s, 4)?;
        let (mut month, mut day) = (1, 1);
        if let Some(r) = rest.strip_prefix('-') {
            (month, rest) = digits(r, 2)?;
            if let Some(r) = rest.strip_prefix('-') {
                (day, rest) = digits(r, 2)?;
            }
        }
        let (mut hour, mut minute, mut second, mut nanos) = (0, 0, 0, 0);
        let mut offset: Option<i64> = Some(0);
        if let Some(r) = rest.strip_prefix(['T', 't']) {
            (hour, rest) = digits(r, 2)?;
            (minute, rest) = digits(rest.strip_prefix(':')?, 2)?;
            if let Some(r) = rest.strip_prefix(':') {
                (second, rest) = digits(r, 2)?;
                if let Some(r) = rest.strip_prefix('.') {
                    let n = r.bytes().take_while(u8::is_ascii_digit).count();
                    if n == 0 {
                        return None;
                    }
                    // Milliseconds only, the rest cut off (as Date.parse does)
                    let ms: String = r[..n].chars().chain("000".chars()).take(3).collect();
                    nanos = ms.parse::<i64>().ok()? * 1_000_000;
                    rest = &r[n..];
                }
            }
            offset = if rest.is_empty() {
                None
            } else if rest == "Z" || rest == "z" {
                rest = "";
                Some(0)
            } else {
                let sign = match rest.as_bytes()[0] {
                    b'+' => 1,
                    b'-' => -1,
                    _ => return None,
                };
                let (h, r) = digits(&rest[1..], 2)?;
                let (m, r) = digits(r.strip_prefix(':')?, 2)?;
                if h > 23 || m > 59 {
                    return None;
                }
                rest = r;
                Some(sign * (h * 60 + m))
            };
        }
        if !rest.is_empty() || hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        // Any day up to 31, carried into the next month as Date.parse does (February 30 is March 2)
        if !(1..=31).contains(&day) {
            return None;
        }
        let dt = DateTime::new(
            year as i16,
            month as i8,
            1,
            hour as i8,
            minute as i8,
            second as i8,
            nanos as i32,
        )
        .ok()?
        .checked_add(jiff::Span::new().days(day - 1))
        .ok()?;
        let ms = match offset {
            Some(off) => {
                dt.to_zoned(TimeZone::UTC)
                    .ok()?
                    .timestamp()
                    .as_millisecond()
                    - off * 60_000
            }
            None => ZONE
                .with(|z| dt.to_zoned(z.borrow().clone()))
                .ok()?
                .timestamp()
                .as_millisecond(),
        };
        Some(ms as f64)
    };
    parse().unwrap_or(f64::NAN)
}

/** Math.round (halves up; 0.49999999999999994 is 0) */
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/** Math.min, which gives NaN when either is */
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/** A limit as drawn: its reset recomputed (past the reset: 0% used, estimated) and how old its value is */
#[derive(Clone, Debug)]
pub struct Shown {
    pub w: Window,
    pub remaining_percent: f64,
    pub remaining_percent_int: f64,
    pub reset_passed: bool,
    pub value_status: Option<&'static str>,
}

/** When the recent consumption of a limit at 100% becomes 0 (nothing more can be used at the limit) */
fn recent_settled_at(w: &Window) -> Option<f64> {
    let fetched = parse_time(w.fetched_at.as_deref());
    let span = w.recent_minutes.filter(|m| *m > 0.0)?;
    let recent = w.recent_consumed_percent.unwrap_or(0.0);
    if w.used_percent < 100.0 || recent <= 0.0 || !fetched.is_finite() {
        return None;
    }
    Some(fetched + span * MINUTE)
}

fn at_display_time(w: &Window, now: f64) -> Shown {
    let reset = parse_time(w.resets_at.as_deref());
    let passed = reset.is_finite() && reset <= now;
    let fetched = parse_time(w.fetched_at.as_deref());
    let status = if passed {
        Some("reset_estimated")
    } else if !fetched.is_finite() {
        None
    } else {
        let ms = (now - fetched).max(0.0);
        Some(if ms <= FRESH_MAX_MINUTES * MINUTE {
            "fresh"
        } else if ms <= CAUTION_MAX_MINUTES * MINUTE {
            "stale"
        } else {
            "old"
        })
    };
    let used = if passed { 0.0 } else { w.used_percent };
    let settled = !passed && recent_settled_at(w).is_some_and(|t| t <= now);
    let mut shown = w.clone();
    shown.used_percent = used;
    shown.recent_quality = if passed {
        "unknown"
    } else if settled {
        "exact"
    } else {
        w.recent_quality
    };
    shown.recent_consumed_percent = if passed {
        None
    } else if settled {
        Some(0.0)
    } else {
        w.recent_consumed_percent
    };
    Shown {
        w: shown,
        remaining_percent: (100.0 - used).clamp(0.0, 100.0),
        remaining_percent_int: (100.0 - js_round(used)).clamp(0.0, 100.0),
        reset_passed: passed,
        value_status: status,
    }
}

// ---- Which limits a provider shows ----

/** One row of a provider: a limit, or a limit it hasn't */
#[derive(Clone, Debug)]
#[allow(clippy::large_enum_variant)] // a few rows per provider
pub enum Row {
    Window(Shown),
    Missing {
        label: Option<&'static str>,
        text: &'static str,
    },
}

impl Row {
    fn window(&self) -> Option<&Shown> {
        match self {
            Row::Window(s) => Some(s),
            Row::Missing { .. } => None,
        }
    }
}

/** A provider as the widget's large size shows it: every limit it has, in the widget's order */
#[derive(Clone, Debug)]
pub struct Group {
    pub provider: &'static str,
    pub name: &'static str,
    pub plan: Option<&'static str>,
    /** Why there is nothing to draw (no values, an error) */
    pub message: Option<&'static str>,
    pub rows: Vec<Row>,
}

fn default_providers(view: &View) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = DEFAULT_PROVIDERS.to_vec();
    out.extend(
        PROVIDER_ORDER
            .iter()
            .filter(|p| !DEFAULT_PROVIDERS.contains(p) && view.provider(p).is_some()),
    );
    out.truncate(3);
    out
}

/** The overall limits first, then the provider's own per-model ones, then other makers'; in each, 5h, then weekly, then others */
fn sort_rows(rows: &mut [Row]) {
    let rank = |r: &Row| {
        let w = &r.window().expect("only limits are sorted").w;
        let group = if w.scope.is_none() {
            0
        } else if w.detail_only {
            2
        } else {
            1
        };
        let length = if w.id.contains("five_hour") {
            0
        } else if w.id.contains("seven_day") {
            1
        } else {
            2
        };
        (group, length)
    };
    rows.sort_by_key(rank);
}

/** The groups the client shows (the widget's groupsOf with no parameter and every per-model limit) */
pub fn groups_of(view: &View, now: f64) -> Vec<Group> {
    let listed = default_providers(view);
    // The widget's selectWindows: the overall limits of every provider, then the per-model ones at 100%
    let mut items: Vec<(&str, Shown)> = Vec::new();
    let push = |items: &mut Vec<(&str, Shown)>, provider: &'static str, w: &Window| {
        if !items.iter().any(|(p, s)| *p == provider && s.w.id == w.id) {
            items.push((provider, at_display_time(w, now)));
        }
    };
    for provider in &listed {
        if let Some(p) = view.provider(provider) {
            for id in &p.main_window_ids {
                if let Some(w) = p.window(id) {
                    push(&mut items, provider, w);
                }
            }
        }
    }
    for provider in &listed {
        if let Some(p) = view.provider(provider) {
            for id in &p.window_ids {
                let w = p.window(id).expect("listed windows exist");
                if w.scope.is_some()
                    && !w.detail_only
                    && at_display_time(w, now).w.used_percent >= 100.0
                {
                    push(&mut items, provider, w);
                }
            }
        }
    }
    listed
        .iter()
        .map(|&provider| {
            let p = view.provider(provider);
            let mut rows: Vec<Row> = items
                .iter()
                .filter(|(x, _)| *x == provider)
                .map(|(_, s)| Row::Window(s.clone()))
                .collect();
            if let Some(p) = p {
                // Every per-model limit, after the overall ones; then other makers' models the provider offers
                for detail in [false, true] {
                    for id in &p.window_ids {
                        let w = p.window(id).expect("listed windows exist");
                        let wanted = if detail {
                            w.detail_only
                        } else {
                            w.scope.is_some() && !w.detail_only
                        };
                        if wanted
                            && !rows
                                .iter()
                                .any(|r| r.window().is_some_and(|s| s.w.id == *id))
                        {
                            rows.push(Row::Window(at_display_time(w, now)));
                        }
                    }
                }
            }
            sort_rows(&mut rows);
            if let Some(p) = p {
                let can_tell = matches!(p.status, Some("ok" | "stale"));
                if can_tell
                    && !p.main_window_ids.is_empty()
                    && !p.main_window_ids.iter().any(|id| id == "five_hour")
                {
                    rows.insert(
                        0,
                        Row::Missing {
                            label: None,
                            text: NOT_AVAILABLE,
                        },
                    );
                }
            }
            let message = match p {
                None => Some(if provider == "gemini" {
                    "Not set up"
                } else {
                    "No data"
                }),
                Some(p) if rows.is_empty() => Some(
                    p.error_code
                        .and_then(|c| lookup(&ERROR_NAMES, c))
                        .unwrap_or("No limits to show"),
                ),
                Some(_) => None,
            };
            Group {
                provider,
                name: provider_name(provider),
                plan: p.and_then(|p| p.plan).and_then(|k| lookup(&PLAN_NAMES, k)),
                message,
                rows,
            }
        })
        .collect()
}

// ---- Freshness ----

/** Whether a provider's limit has most likely lifted since its values were fetched */
fn limit_lifted(p: &Provider, ids: &[String], now: f64) -> bool {
    let windows: Vec<&Window> = ids
        .iter()
        .filter_map(|id| p.window(id))
        .filter(|w| !w.detail_only)
        .collect();
    let overall: Vec<&Window> = p
        .main_window_ids
        .iter()
        .filter_map(|id| p.window(id))
        .collect();
    let passed = |w: &Window| {
        let reset = parse_time(w.resets_at.as_deref());
        reset.is_finite() && reset <= now
    };
    windows.iter().any(|w| passed(w))
        && !windows
            .iter()
            .chain(&overall)
            .any(|w| w.used_percent >= 100.0 && !passed(w))
}

/** The header dot: fresh, stale, old by the oldest value's age; limit while the provider is at its limit; unknown */
fn freshness_of(view: &View, provider: &str, now: f64) -> &'static str {
    let Some(p) = view.provider(provider) else {
        return "unknown";
    };
    let list: Vec<String> = if p.main_window_ids.is_empty() {
        p.windows.iter().map(|w| w.id.clone()).collect()
    } else {
        p.main_window_ids.clone()
    };
    let oldest = list
        .iter()
        .filter_map(|id| p.window(id))
        .map(|w| parse_time(w.fetched_at.as_deref()))
        .filter(|t| t.is_finite())
        .fold(None, |a: Option<f64>, t| Some(a.map_or(t, |a| a.min(t))));
    if p.blocked == Some(true) && !limit_lifted(p, &list, now) {
        return "limit";
    }
    let Some(oldest) = oldest else {
        return "unknown";
    };
    let ms = (now - oldest).max(0.0);
    if ms <= FRESH_MAX_MINUTES * MINUTE {
        "fresh"
    } else if ms <= CAUTION_MAX_MINUTES * MINUTE {
        "stale"
    } else {
        "old"
    }
}

// ---- Bars and forecasts ----

struct Projection {
    consume: f64,
    runs_out: bool,
    at: Option<f64>,
}

fn pace_of(w: &Window) -> Option<f64> {
    w.rate_pace.flatten().filter(|r| r.is_finite() && *r > 0.0)
}

/** Of the remaining part, what will likely be used before the reset; or that it runs out first, and when */
fn projection_of(s: &Shown, now: f64) -> Option<Projection> {
    let w = &s.w;
    if s.reset_passed || w.used_percent >= 100.0 || !matches!(w.confidence, Some("high" | "medium"))
    {
        return None;
    }
    let remaining = (100.0 - w.used_percent).max(0.0);
    let reset = parse_time(w.resets_at.as_deref());
    if !reset.is_finite() || reset <= now {
        return None;
    }
    w.rate_pace?;
    let Some(pace) = pace_of(w) else {
        return Some(Projection {
            consume: 0.0,
            runs_out: false,
            at: None,
        });
    };
    let per_minute = pace / 60.0;
    let observed = parse_time(w.fetched_at.as_deref());
    let from = if observed.is_finite() { observed } else { now };
    let at = from + js_round((remaining / per_minute) * 60_000.0);
    if at < reset {
        return if at <= now {
            None
        } else {
            Some(Projection {
                consume: remaining,
                runs_out: true,
                at: Some(at),
            })
        };
    }
    Some(Projection {
        consume: js_min(remaining, per_minute * ((reset - now) / 60_000.0)),
        runs_out: false,
        at: None,
    })
}

/** The pieces of a ring or a bar (fractions 0..1, from the start): likely left after the reset (solid), likely used before it
 * (light), and the recent consumption (gray) */
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pieces {
    pub solid: f64,
    pub projected: f64,
    pub recent: f64,
    pub faded: bool,
    pub runs_out: bool,
}

fn pieces(s: &Shown, now: f64) -> Pieces {
    let clamp = |x: f64| x.clamp(0.0, 1.0);
    let used = clamp(
        if s.w.used_percent.is_nan() {
            0.0
        } else {
            s.w.used_percent
        } / 100.0,
    );
    let recent = match s.w.recent_consumed_percent {
        Some(r) if s.w.recent_quality != "unknown" => js_min(used, clamp(r / 100.0)),
        _ => 0.0,
    };
    let remaining = 1.0 - used;
    let p = projection_of(s, now);
    let projected = p
        .as_ref()
        .map_or(0.0, |p| js_min(remaining, p.consume / 100.0));
    Pieces {
        solid: (remaining - projected).max(0.0),
        projected,
        recent,
        faded: s.value_status == Some("old"),
        runs_out: p.is_some_and(|p| p.runs_out),
    }
}

// ---- Words ----

enum When {
    Timer(f64),
    Text(String),
}

struct TimeShort {
    warn: bool,
    when: When,
    symbol: Option<&'static str>,
}

/** "18:10" within 24 hours, "Fri 18:10" beyond */
fn clock_text(date: f64, now: f64, tz: &TimeZone) -> String {
    let Ok(t) = Timestamp::from_millisecond(date as i64) else {
        return String::new();
    };
    let z = t.to_zoned(tz.clone());
    let clock = format!("{:02}:{:02}", z.hour(), z.minute());
    if date - now <= DAY {
        return clock;
    }
    let day = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        [z.weekday().to_monday_zero_offset() as usize];
    format!("{day} {clock}")
}

fn when_short(date: f64, now: f64, tz: &TimeZone) -> When {
    if date - now <= DAY {
        When::Timer(date)
    } else {
        When::Text(clock_text(date, now, tz))
    }
}

fn reset_passed(w: &Window, now: f64) -> bool {
    let reset = parse_time(w.resets_at.as_deref());
    reset.is_finite() && reset <= now
}

/** Whether the forecast run-out time has passed with no newer value, before the reset */
fn run_out_passed(s: &Shown, now: f64) -> bool {
    let reset = parse_time(s.w.resets_at.as_deref());
    if !reset.is_finite() || reset <= now {
        return false;
    }
    let before = projection_of(s, parse_time(s.w.fetched_at.as_deref()));
    before.is_some_and(|b| b.runs_out && b.at.is_some_and(|at| at <= now && at < reset))
}

fn text_time(warn: bool, text: &str, symbol: Option<&'static str>) -> Option<TimeShort> {
    Some(TimeShort {
        warn,
        when: When::Text(text.to_string()),
        symbol,
    })
}

/** The time of a limit: its run-out time when it will run out before the reset (warn), else its reset; or what they turned into */
fn time_short(s: &Shown, now: f64, tz: &TimeZone) -> Option<TimeShort> {
    if let Some(Projection {
        runs_out: true,
        at: Some(at),
        ..
    }) = projection_of(s, now)
    {
        if at - now < MINUTE {
            return text_time(true, "Soon", None);
        }
        return Some(TimeShort {
            warn: true,
            when: when_short(at, now, tz),
            symbol: None,
        });
    }
    if run_out_passed(s, now) {
        return text_time(true, "Limit", None);
    }
    let reset = parse_time(s.w.resets_at.as_deref());
    let has_reset = s.w.resets_at.as_deref().is_some_and(|r| !r.is_empty());
    if has_reset && !s.reset_passed && reset.is_finite() && reset > now {
        return Some(TimeShort {
            warn: false,
            when: when_short(reset, now, tz),
            symbol: None,
        });
    }
    if reset_passed(&s.w, now) {
        return text_time(false, "Reset", None);
    }
    if !has_reset && !s.reset_passed && s.w.used_percent == 0.0 {
        return text_time(false, NOT_STARTED, Some("start"));
    }
    if s.reset_passed {
        None
    } else {
        text_time(false, RESET_UNKNOWN, Some("unknown"))
    }
}

/** "45m", "2h 05m", "<1m" */
pub fn countdown_text(ms: f64) -> String {
    if ms < MINUTE {
        return "<1m".to_string();
    }
    let minutes = (ms / MINUTE).floor() as i64;
    if minutes < 60 {
        format!("{minutes}m")
    } else {
        format!("{}h {:02}m", minutes / 60, minutes % 60)
    }
}

/** The time line of a limit ("↻ 2h 05m", "⚠ 18m", "⧗ On first use") and whether it warns */
fn time_line(s: &Shown, now: f64, tz: &TimeZone) -> (String, bool) {
    let Some(t) = time_short(s, now, tz) else {
        return (String::new(), false);
    };
    let mark = if t.warn {
        "⚠"
    } else {
        match t.symbol {
            Some("start") => "⧗",
            Some("unknown") => "?",
            _ => "↻",
        }
    };
    let body = match t.when {
        When::Timer(at) => countdown_text(at - now),
        When::Text(s) => s,
    };
    (format!("{mark} {body}"), t.warn)
}

/** What is left: "0%" at the limit, one decimal below 1% (at least 0.1%), else a whole number */
fn remaining_text(s: &Shown) -> String {
    if s.w.used_percent >= 100.0 {
        return "0%".to_string();
    }
    let raw = s.remaining_percent;
    if raw > 0.0 && raw < 1.0 {
        let tenth = ((js_round(raw * 1000.0) / 1000.0) * 10.0).floor() / 10.0;
        return format!("{}%", js_number(tenth.max(0.1)));
    }
    format!("{}%", js_number(s.remaining_percent_int))
}

/** The length of a limit: 5h, Weekly, Monthly, 90m, ...; an unknown one by its label when that is one plain word */
fn window_name(w: &Window) -> String {
    let id = w.id.as_str();
    for (part, name) in [
        ("five_hour", "5h"),
        ("seven_day", "Weekly"),
        ("monthly", "Monthly"),
        ("primary", "Primary"),
        ("secondary", "Secondary"),
    ] {
        if id.contains(part) {
            return name.to_string();
        }
    }
    let mut rest = id;
    while let Some(i) = rest.find("window_") {
        rest = &rest[i + "window_".len()..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest.as_bytes().get(digits) == Some(&b'm') {
            let n: f64 = rest[..digits].parse().unwrap_or(0.0);
            return if n % 1440.0 == 0.0 {
                format!("{}d", js_number(n / 1440.0))
            } else if n % 60.0 == 0.0 {
                format!("{}h", js_number(n / 60.0))
            } else {
                format!("{}m", js_number(n))
            };
        }
    }
    if plain_word(&w.label) {
        w.label.clone()
    } else {
        "Limit".to_string()
    }
}

fn scope_name(scope: &str) -> &str {
    lookup(&WIDGET_SCOPE_NAMES, scope)
        .or_else(|| lookup(&SCOPE_NAMES, scope))
        .unwrap_or(if plain_word(scope) { scope } else { "Other" })
}

/** A row's heading: "5h limit", "Wk limit", "Fable wk", "C+G 5h" */
fn row_label(w: &Window) -> String {
    let name = window_name(w);
    let short = match name.as_str() {
        "Weekly" => "Wk".to_string(),
        "Monthly" => "Mo".to_string(),
        _ => name,
    };
    // An empty scope reads as none (it is falsy to the widget)
    match w.scope.as_deref().filter(|s| !s.is_empty()) {
        Some(scope) => format!("{} {}", scope_name(scope), short.to_lowercase()),
        None => format!("{short} limit"),
    }
}

/** The consumption rate: the last 60 minutes for a 5-hour limit, the last 24 hours otherwise. None if it can't be measured */
fn pace_text(s: &Shown) -> Option<String> {
    let w = &s.w;
    if s.reset_passed || w.confidence == Some("insufficient") {
        return None;
    }
    let rate = if w.id.contains("five_hour") {
        w.rate_60m.or(w.rate_24h)
    } else {
        w.rate_24h.or(w.rate_60m)
    }?;
    if !rate.is_finite() || rate < 0.0 {
        return None;
    }
    let shown = if rate < 10.0 {
        js_round(rate * 10.0) / 10.0
    } else {
        js_round(rate)
    };
    Some(format!("{}%/h", js_number(shown)))
}

// ---- What the notch, the card and the tray draw ----

#[derive(Clone, Debug, Serialize)]
pub struct Headline {
    pub id: String,
    pub text: String,
    pub pieces: Pieces,
    pub warn: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Weekly {
    pub pieces: Pieces,
}

#[derive(Clone, Debug, Serialize)]
pub struct Fresh {
    pub level: &'static str,
    pub color: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
pub enum CardRow {
    Missing {
        missing: bool,
        label: &'static str,
        text: &'static str,
    },
    Limit {
        missing: bool,
        id: String,
        label: String,
        left: String,
        pace: String,
        time: String,
        warn: bool,
        pieces: Pieces,
    },
}

/** One provider in the notch (its ring) and in the card (its rows) */
#[derive(Clone, Debug, Serialize)]
pub struct Cell {
    pub provider: &'static str,
    pub name: &'static str,
    pub plan: Option<&'static str>,
    pub color: &'static str,
    /** The ring: the 5-hour limit, else the weekly one, else the first */
    pub headline: Option<Headline>,
    /** The thin outer ring: the weekly limit, when the ring shows another one */
    pub weekly: Option<Weekly>,
    pub stale: bool,
    pub fresh: Fresh,
    pub message: Option<&'static str>,
    pub rows: Vec<CardRow>,
}

/** Everything the notch and its cards draw, one cell per provider shown */
pub fn notch_model(view: &View, now: f64, tz: &TimeZone) -> Vec<Cell> {
    ZONE.with(|z| *z.borrow_mut() = tz.clone());
    groups_of(view, now)
        .into_iter()
        .map(|g| {
            let windows: Vec<&Shown> = g.rows.iter().filter_map(Row::window).collect();
            let headline = windows
                .iter()
                .find(|s| s.w.id == "five_hour")
                .or_else(|| windows.iter().find(|s| s.w.id == "seven_day"))
                .or(windows.first())
                .copied();
            let weekly = headline
                .filter(|h| h.w.id != "seven_day")
                .and_then(|_| windows.iter().find(|s| s.w.id == "seven_day").copied());
            let level = freshness_of(view, g.provider, now);
            Cell {
                provider: g.provider,
                name: g.name,
                plan: g.plan,
                color: brand_color(g.provider),
                headline: headline.map(|h| Headline {
                    id: h.w.id.clone(),
                    text: remaining_text(h),
                    pieces: pieces(h, now),
                    warn: time_line(h, now, tz).1,
                }),
                weekly: weekly.map(|w| Weekly {
                    pieces: pieces(w, now),
                }),
                stale: matches!(level, "stale" | "old"),
                fresh: Fresh {
                    level,
                    color: fresh_color(level),
                },
                message: g.message,
                rows: g
                    .rows
                    .iter()
                    .map(|r| match r {
                        Row::Missing { label, text } => CardRow::Missing {
                            missing: true,
                            label: label.unwrap_or("5h limit"),
                            text,
                        },
                        Row::Window(s) => {
                            let (time, warn) = time_line(s, now, tz);
                            CardRow::Limit {
                                missing: false,
                                id: s.w.id.clone(),
                                label: row_label(&s.w),
                                left: format!("{} left", remaining_text(s)),
                                pace: pace_text(s).unwrap_or_default(),
                                time,
                                warn,
                                pieces: pieces(s, now),
                            }
                        }
                    })
                    .collect(),
            }
        })
        .collect()
}

/** The tray's menu lines and its tooltip */
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Tray {
    pub lines: Vec<String>,
    pub tooltip: String,
}

/** The tray tooltip holds 127 characters */
const TOOLTIP_MAX: usize = 127;

pub fn tray_model(cells: &[Cell], footer: Option<&str>) -> Tray {
    let mut lines: Vec<String> = cells
        .iter()
        .map(|c| {
            let Some(h) = &c.headline else {
                return format!("{} — {}", c.name, c.message.unwrap_or("No data"));
            };
            let row = c.rows.iter().find_map(|r| match r {
                CardRow::Limit {
                    id, label, time, ..
                } if *id == h.id => Some((label, time)),
                _ => None,
            });
            let label = row.map(|(l, _)| format!(" ({l})")).unwrap_or_default();
            let time = row
                .filter(|(_, t)| !t.is_empty())
                .map(|(_, t)| format!(" · {t}"))
                .unwrap_or_default();
            format!("{} — {} left{label}{time}", c.name, h.text)
        })
        .collect();
    if let Some(f) = footer.filter(|f| !f.is_empty()) {
        lines.push(f.to_string());
    }
    let parts: Vec<String> = cells
        .iter()
        .filter_map(|c| {
            c.headline
                .as_ref()
                .map(|h| format!("{} {}", c.name, h.text))
        })
        .collect();
    let tooltip = if parts.is_empty() {
        "Headroom".to_string()
    } else {
        format!("Headroom — {}", parts.join(" · "))
    };
    let units: usize = tooltip.encode_utf16().count();
    let tooltip = if units > TOOLTIP_MAX {
        format!("{}…", utf16_prefix(&tooltip, TOOLTIP_MAX - 1))
    } else {
        tooltip
    };
    Tray { lines, tooltip }
}

#[cfg(test)]
mod tests {
    use super::*;

    /** A case's view: given as JSON text (its numbers as written) or as JSON */
    fn body_of(case: &Value) -> Value {
        match case["text"].as_str() {
            Some(t) => serde_json::from_str(t).unwrap_or(Value::Null),
            None => case["body"].clone(),
        }
    }

    /** Equal as JSON, numbers within rounding */
    fn same(a: &Value, b: &Value, path: &str) -> Result<(), String> {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
                if (x - y).abs() <= 1e-12 * x.abs().max(1.0) {
                    Ok(())
                } else {
                    Err(format!("{path}: {x} != {y}"))
                }
            }
            (Value::Array(x), Value::Array(y)) => {
                if x.len() != y.len() {
                    return Err(format!("{path}: {} items != {}", x.len(), y.len()));
                }
                x.iter()
                    .zip(y)
                    .enumerate()
                    .try_for_each(|(i, (x, y))| same(x, y, &format!("{path}[{i}]")))
            }
            (Value::Object(x), Value::Object(y)) => {
                let mut keys: Vec<&String> = x.keys().chain(y.keys()).collect();
                keys.sort();
                keys.dedup();
                keys.into_iter().try_for_each(|k| {
                    same(
                        x.get(k).unwrap_or(&Value::Null),
                        y.get(k).unwrap_or(&Value::Null),
                        &format!("{path}.{k}"),
                    )
                })
            }
            _ if a == b => Ok(()),
            _ => Err(format!("{path}: {a} != {b}")),
        }
    }

    #[test]
    fn the_widget_and_the_client_show_the_same() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/parity.json")).unwrap();
        let tz = TimeZone::get(fixture["time_zone"].as_str().unwrap()).unwrap();
        let mut checked = 0;
        for v in fixture["views"].as_array().unwrap() {
            let name = v["name"].as_str().unwrap();
            let view = sanitize_view(&body_of(v)).unwrap_or_else(|| panic!("{name}: refused"));
            for s in v["shown"].as_array().unwrap() {
                let now = parse_time(s["now"].as_str());
                let cells = notch_model(&view, now, &tz);
                let at = format!("{name} at {}", s["now"].as_str().unwrap());
                same(
                    &serde_json::to_value(&cells).unwrap(),
                    &s["cells"],
                    &format!("{at}: cells"),
                )
                .unwrap();
                same(
                    &serde_json::to_value(tray_model(&cells, None)).unwrap(),
                    &s["tray"],
                    &format!("{at}: tray"),
                )
                .unwrap();
                checked += 1;
            }
        }
        assert!(checked > 50, "only {checked} views checked");
    }

    #[test]
    fn the_client_refuses_what_the_widget_refuses() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/parity.json")).unwrap();
        for r in fixture["refused"].as_array().unwrap() {
            assert!(sanitize_view(&body_of(r)).is_none(), "{}", r["name"]);
        }
    }

    #[test]
    fn the_sample_is_the_widgets_own() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/parity.json")).unwrap();
        let tz = TimeZone::get(fixture["time_zone"].as_str().unwrap()).unwrap();
        let three = fixture["views"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "demo three")
            .unwrap();
        // The widget's sample was made at the first time it is shown at
        let made = parse_time(three["shown"][0]["now"].as_str());
        let view = sanitize_view(&crate::demo::body(made)).unwrap();
        for s in three["shown"].as_array().unwrap() {
            let cells = notch_model(&view, parse_time(s["now"].as_str()), &tz);
            same(&serde_json::to_value(&cells).unwrap(), &s["cells"], "demo").unwrap();
        }
    }

    #[test]
    fn times_are_read_as_date_parse_reads_them() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/parity.json")).unwrap();
        for zone in fixture["dates"].as_array().unwrap() {
            let tz = TimeZone::get(zone["zone"].as_str().unwrap()).unwrap();
            ZONE.with(|z| *z.borrow_mut() = tz);
            for d in zone["times"].as_array().unwrap() {
                let text = d["text"].as_str().unwrap();
                let got = parse_time(Some(text));
                match d["ms"].as_f64() {
                    Some(ms) => assert_eq!(got, ms, "{text} in {}", zone["zone"]),
                    None => assert!(got.is_nan(), "{text} in {}: {got}", zone["zone"]),
                }
            }
        }
        ZONE.with(|z| *z.borrow_mut() = TimeZone::UTC);
    }

    #[test]
    fn small_helpers() {
        assert_eq!(countdown_text(30_000.0), "<1m");
        assert_eq!(countdown_text(45.0 * MINUTE), "45m");
        assert_eq!(countdown_text(125.0 * MINUTE), "2h 05m");
        assert_eq!(utf16_prefix("a😀b", 2), "a");
        assert_eq!(utf16_prefix("a😀b", 3), "a😀");
        assert!(
            plain_word("Fable")
                && !plain_word("two words")
                && !plain_word("-x")
                && !plain_word(&"x".repeat(25))
        );
        assert_eq!(
            id_list(Some(&serde_json::json!(["a", "b", null]))),
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert_eq!(
            id_list(Some(&Value::String("a,".repeat(MAX_WINDOWS + 1)))),
            None
        );
        for (x, text) in [
            (1.5e-7, "1.5e-7"),
            (1e21, "1e+21"),
            (1e-6, "0.000001"),
            (0.1, "0.1"),
            (-0.0, "0"),
            (12.0, "12"),
            (2.5e25, "2.5e+25"),
        ] {
            assert_eq!(js_number(x), text);
        }
        assert!(parse_time(Some("not a time")).is_nan() && parse_time(None).is_nan());
    }
}
