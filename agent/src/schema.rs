//! Rust copy of snapshot schema v2.
//! The source of truth is packages/core/src/schema.ts. Drift is caught by the tests on fixtures/snapshot/.
//! Rule: every provider has the same keys; values that do not apply are null (keys are never omitted).

use serde::{Deserialize, Serialize, Serializer};
use std::collections::BTreeMap;

use crate::time::{MINUTE_MS, iso_from_ms};

pub const SCHEMA_VERSION: u32 = 2;

/// Fetch interval while an overall limit is reached. Values do not change until the reset, so the interval is stretched
pub const BLOCKED_INTERVAL_MS: i64 = 60 * MINUTE_MS;
/// Margin after the reset time before fetching (so stale values are not read right after a reset)
pub const RESET_GRACE_MS: i64 = MINUTE_MS;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStatus {
    Ok,
    Stale,
    Error,
    Unavailable,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    LoginRequired,
    NotInstalled,
    FetchFailed,
    SafetyStop,
    /// The PC detected an account switch and has stopped fetching / pushing for that provider
    AccountChanged,
    /// The service denied access (403): fetching stopped on every PC until the user resumes it
    AccessDenied,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowKind {
    Session,
    Weekly,
    Monthly,
    Other,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageWindow {
    pub id: String,
    pub label: String,
    pub kind: WindowKind,
    /// The old Claude cache stored per-model limits under `model`.
    #[serde(alias = "model")]
    pub scope: Option<String>,
    /// 0–100. Integral values are written as `41`, same as TS
    #[serde(serialize_with = "serialize_number")]
    pub used_percent: f64,
    pub resets_at: Option<String>,
    /// When this window's value was actually fetched. Differs from the provider's fetched_at when windows come from different sources
    pub fetched_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProviderSnapshot {
    pub status: ProviderStatus,
    pub fetched_at: Option<String>,
    pub collector: Option<String>,
    pub error: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub plan: Option<String>,
    pub blocked: Option<bool>,
    /// History boundary: when an account switch was accepted. Observations before this belong to another account and
    /// are dropped from history by the destination. null if no switch was accepted
    #[serde(default)]
    pub history_since: Option<String>,
    pub windows: Vec<UsageWindow>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct CollectorInfo {
    pub id: String,
    pub generated_at: String,
    /// When the destination last received data from this PC (added by the destination when merging; the PC never sets it)
    #[serde(default)]
    pub received_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub schema_version: u32,
    pub generated_at: String,
    /// Keys are "claude" / "codex". BTreeMap keeps the output order stable
    pub providers: BTreeMap<String, ProviderSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collectors: Option<Vec<CollectorInfo>>,
}

impl ProviderSnapshot {
    pub fn empty(
        status: ProviderStatus,
        error: impl Into<String>,
        error_code: Option<ErrorCode>,
    ) -> Self {
        Self {
            status,
            fetched_at: None,
            collector: None,
            error: Some(error.into()),
            error_code,
            plan: None,
            blocked: None,
            history_since: None,
            windows: Vec::new(),
        }
    }

    /// Earliest time the next fetch is allowed while an overall limit is reached (`blocked: true`).
    /// The earlier of: the earliest reset among the overall limits that are at 100% plus the margin, and last attempt + 60 minutes.
    /// Fetch at the earliest reset; if another limit is still reached, reschedule from that result
    /// (does not rely on whether a weekly reset also restores the 5-hour limit).
    /// If no reset time is known, last attempt + 60 minutes. None if not blocked (normal interval).
    /// Callers use the later of the normal schedule and this time (minimum interval and backoff are kept).
    pub fn blocked_until_ms(&self, last_attempt_ms: i64) -> Option<i64> {
        if self.blocked != Some(true) {
            return None;
        }
        let slow = last_attempt_ms.saturating_add(BLOCKED_INTERVAL_MS);
        let earliest_reset = self
            .windows
            .iter()
            .filter(|w| w.scope.is_none() && w.used_percent >= 100.0)
            .filter_map(|w| w.resets_at.as_deref()?.parse::<jiff::Timestamp>().ok())
            .map(|t| t.as_millisecond())
            .min();
        Some(earliest_reset.map_or(slow, |r| slow.min(r.saturating_add(RESET_GRACE_MS))))
    }
}

pub fn build_snapshot(
    providers: BTreeMap<String, ProviderSnapshot>,
    now_ms: i64,
    collector: &str,
) -> Snapshot {
    let providers = providers
        .into_iter()
        .map(|(k, mut p)| {
            p.collector = Some(collector.to_string());
            (k, p)
        })
        .collect();
    Snapshot {
        schema_version: SCHEMA_VERSION,
        generated_at: iso_from_ms(now_ms),
        providers,
        collector: Some(collector.to_string()),
        collectors: None,
    }
}

const WEEK: i64 = 7 * 24 * 60 * 60;

/// Known windows (keep in sync with KNOWN_WINDOWS in TS): (label, kind, window_seconds)
pub fn known_window(id: &str) -> Option<(&'static str, WindowKind, Option<i64>)> {
    use WindowKind::*;
    Some(match id {
        "five_hour" => ("5h", Session, Some(5 * 60 * 60)),
        "seven_day" => ("Weekly", Weekly, Some(WEEK)),
        "monthly" => ("Monthly", Monthly, None),
        "seven_day_opus" => ("Weekly Opus", Weekly, Some(WEEK)),
        "seven_day_sonnet" => ("Weekly Sonnet", Weekly, Some(WEEK)),
        _ => return None,
    })
}

/// Names of per-model / per-group windows: (slug in the window id, display name). Keep in sync with KNOWN_SCOPES in TS.
/// Only these names leave the PC; windows of other models or groups are not sent
pub const KNOWN_SCOPES: &[(&str, &str)] = &[
    ("fable", "Fable"),
    ("opus", "Opus"),
    ("sonnet", "Sonnet"),
    ("haiku", "Haiku"),
    ("codex_other", "codex_other"),
    ("codex_bengalfox", "Codex extra"),
];

/// Names only one provider's windows may carry: (provider, slug, display name). Another provider's window with such a name stays
/// on the PC (an unknown Codex group named "partner" is not sent)
pub const PROVIDER_SCOPES: &[(&str, &str, &str)] = &[
    // Gemini: a model with limits of its own, and the Claude and GPT models one uses through Antigravity (shown in details only)
    ("gemini", "argon", "Argon"),
    ("gemini", "partner", "Claude and GPT"),
];

/// The names a provider's windows may carry: the shared ones, then its own
fn scopes_of(provider: &str) -> impl Iterator<Item = (&'static str, &'static str)> + '_ {
    KNOWN_SCOPES.iter().copied().chain(
        PROVIDER_SCOPES
            .iter()
            .filter(move |(p, _, _)| *p == provider)
            .map(|(_, slug, name)| (*slug, *name)),
    )
}

/// Plan names that may be sent (keep in sync with KNOWN_PLANS in TS). Anything else is sent as null
pub const KNOWN_PLANS: &[&str] = &[
    "free",
    "go",
    "plus",
    "pro",
    "prolite",
    "max",
    "ultra",
    "team",
    "business",
    "enterprise",
    "edu",
];

/// Display name of a known per-model / per-group slug
pub fn known_scope(slug: &str) -> Option<&'static str> {
    KNOWN_SCOPES
        .iter()
        .find(|(s, _)| *s == slug)
        .map(|(_, name)| *name)
}

/// The id shape the destination accepts: 1–64 of `a-z`, `0-9`, `_`
pub fn is_window_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Base forms that express a window's length (`primary` / `secondary` are Codex limits of unknown duration)
fn is_base_window(s: &str) -> bool {
    matches!(
        s,
        "five_hour" | "seven_day" | "monthly" | "primary" | "secondary"
    ) || s
        .strip_prefix("window_")
        .and_then(|r| r.strip_suffix('m'))
        .is_some_and(|d| (1..=6).contains(&d.len()) && d.bytes().all(|b| b.is_ascii_digit()))
}

/// Removes the suffix Codex appends on an id collision: `_primary` / `_secondary`, optionally followed by `_<1–2 digits>`.
/// A number alone is not a collision suffix (`seven_day_opus_4` is not `seven_day_opus`)
fn strip_collision_suffix(id: &str) -> &str {
    let mut s = id;
    if let Some((head, n)) = s.rsplit_once('_')
        && (1..=2).contains(&n.len())
        && n.bytes().all(|b| b.is_ascii_digit())
        && (head.ends_with("_primary") || head.ends_with("_secondary"))
    {
        s = head;
    }
    s.strip_suffix("_primary")
        .or_else(|| s.strip_suffix("_secondary"))
        .unwrap_or(s)
}

/// Whether a window id has the collision form `<sendable id>_primary` / `_secondary` (optionally `_N`). An older version gave
/// such ids to groups it didn't know, so they can't be told apart from a real collision without the window itself
pub fn is_collision_id(id: &str) -> bool {
    let core = strip_collision_suffix(id);
    core != id && sendable_scope(core).is_some()
}

/// Whether a window id may leave the PC, and its scope's display name (same rule as `parseWindowId` in the Worker).
/// None: not sent (not a length form or known id, or a model/group name that isn't known).
/// Some(None): an overall limit. Some(Some(name)): a per-model / per-group limit with a known name. Only the shared names: a
/// provider's own ones count through `sendable_scope_in`
pub fn sendable_scope(id: &str) -> Option<Option<&'static str>> {
    sendable_scope_in("", id)
}

/// `sendable_scope` for a window of `provider`: the shared names and the provider's own
pub fn sendable_scope_in(provider: &str, id: &str) -> Option<Option<&'static str>> {
    if !is_window_id(id) {
        return None;
    }
    if known_window(id).is_some() && !is_base_window(id) {
        return Some(
            scopes_of(provider)
                .find(|(s, _)| id.strip_suffix(s).is_some_and(|r| r.ends_with('_')))
                .map(|(_, name)| name),
        );
    }
    for core in [id, strip_collision_suffix(id)] {
        if is_base_window(core) {
            return Some(None);
        }
        for (slug, name) in scopes_of(provider) {
            let prefixed = core.strip_prefix(slug).and_then(|r| r.strip_prefix('_'));
            let suffixed = core.strip_suffix(slug).and_then(|r| r.strip_suffix('_'));
            if prefixed.is_some_and(is_base_window) || suffixed.is_some_and(is_base_window) {
                return Some(Some(name));
            }
        }
    }
    None
}

impl UsageWindow {
    /// The window as sent to the destination. None if the destination would not store it, including a per-model /
    /// per-group limit without a known name. The label and scope are rebuilt from known names, so no text from a CLI leaves the PC
    pub fn for_upload(&self) -> Option<UsageWindow> {
        self.for_upload_in("")
    }

    /// `for_upload` for a window of `provider` (its own names count too)
    pub fn for_upload_in(&self, provider: &str) -> Option<UsageWindow> {
        let scope = sendable_scope_in(provider, &self.id)?;
        // A per-model / per-group window must carry the same known name its id has (an unknown group whose id happens to
        // contain a known name, such as `codex_other_five_hour_primary` with scope `codex_other_five_hour`, is not sent)
        match (&self.scope, scope) {
            (Some(_), None) => return None,
            (Some(own), Some(name)) if own != name => return None,
            _ => {}
        }
        Some(UsageWindow {
            id: self.id.clone(),
            label: known_window(&self.id).map_or_else(|| self.id.clone(), |k| k.0.to_string()),
            kind: self.kind,
            scope: scope.map(str::to_string),
            used_percent: clamp_percent(self.used_percent),
            resets_at: self.resets_at.clone(),
            fetched_at: self.fetched_at.clone(),
        })
    }
}

/// Fixed text sent in place of a provider's error message (the destination stores only whether there is one)
pub const WITHHELD_ERROR: &str = "See headroom status on the PC for details";

impl ProviderSnapshot {
    /// The provider's value as sent to the destination: windows through `UsageWindow::for_upload`, the error message
    /// replaced with fixed text and only known plan names
    pub fn for_upload(&self) -> ProviderSnapshot {
        self.for_upload_in("")
    }

    /// `for_upload` for the value of `provider` (its own names count too)
    pub fn for_upload_in(&self, provider: &str) -> ProviderSnapshot {
        ProviderSnapshot {
            error: self.error.as_ref().map(|_| WITHHELD_ERROR.to_string()),
            plan: self
                .plan
                .as_deref()
                .map(str::to_ascii_lowercase)
                .filter(|p| KNOWN_PLANS.contains(&p.as_str())),
            windows: self
                .windows
                .iter()
                .filter_map(|w| w.for_upload_in(provider))
                .collect(),
            ..self.clone()
        }
    }
}

impl Snapshot {
    /// The snapshot as sent to the destination (see `ProviderSnapshot::for_upload`)
    pub fn for_upload(&self) -> Snapshot {
        Snapshot {
            providers: self
                .providers
                .iter()
                .map(|(k, p)| (k.clone(), p.for_upload_in(k)))
                .collect(),
            ..self.clone()
        }
    }
}

/// Derives the kind from the window length (same as kindFromSeconds in TS)
pub fn kind_from_seconds(seconds: Option<i64>) -> WindowKind {
    match seconds {
        Some(18_000) => WindowKind::Session,
        Some(WEEK) => WindowKind::Weekly,
        Some(s) if (28 * 86_400..=31 * 86_400).contains(&s) => WindowKind::Monthly,
        _ => WindowKind::Other,
    }
}

pub fn clamp_percent(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

/// Builds a window, filling in label and kind for known ids (same as makeWindow in TS).
pub fn make_window(id: &str, used_percent: f64, resets_at_ms: Option<i64>) -> UsageWindow {
    let known = known_window(id);
    UsageWindow {
        id: id.to_string(),
        label: known.map_or_else(|| id.to_string(), |k| k.0.to_string()),
        kind: known.map_or(WindowKind::Other, |k| k.1),
        scope: None,
        used_percent: clamp_percent(used_percent),
        resets_at: resets_at_ms.map(iso_from_ms),
        fetched_at: None,
    }
}

impl UsageWindow {
    /// Sets the length afterwards; if the kind is still undecided (other), derive it from the length
    pub fn with_seconds(mut self, secs: Option<i64>) -> Self {
        if self.kind == WindowKind::Other {
            self.kind = kind_from_seconds(secs);
        }
        self
    }

    pub fn with_fetched_ms(mut self, ms: i64) -> Self {
        self.fetched_at = Some(iso_from_ms(ms));
        self
    }
}

/// Derives the base id from the window length (5 hours, 7 days, month). Claude's `/usage` derives ids from headings (`window_identity`).
/// core, the Worker and the widget use the id as received.
pub fn window_id_from_seconds(seconds: Option<i64>, fallback: &str) -> String {
    match seconds {
        Some(s) if s > 0 => {
            if s == 5 * 60 * 60 {
                "five_hour".into()
            } else if s == WEEK {
                "seven_day".into()
            } else if (28 * 86_400..=31 * 86_400).contains(&s) {
                "monthly".into()
            } else {
                format!("window_{}m", (s as f64 / 60.0).round() as i64)
            }
        }
        _ => fallback.to_string(),
    }
}

fn serialize_number<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_ids_follow_duration() {
        assert_eq!(
            window_id_from_seconds(Some(300 * 60), "primary"),
            "five_hour"
        );
        assert_eq!(
            window_id_from_seconds(Some(10_080 * 60), "primary"),
            "seven_day"
        );
        assert_eq!(
            window_id_from_seconds(Some(30 * 86_400), "secondary"),
            "monthly"
        );
        assert_eq!(
            window_id_from_seconds(Some(90 * 60), "primary"),
            "window_90m"
        );
        assert_eq!(window_id_from_seconds(None, "secondary"), "secondary");
    }

    #[test]
    fn make_window_fills_known_and_clamps() {
        let w = make_window("five_hour", 120.0, None);
        assert_eq!(
            (w.label.as_str(), w.kind, w.used_percent, w.scope),
            ("5h", WindowKind::Session, 100.0, None)
        );
        let m = make_window("mystery", 5.0, None);
        assert_eq!((m.label.as_str(), m.kind), ("mystery", WindowKind::Other));
        assert_eq!(m.with_seconds(Some(30 * 86_400)).kind, WindowKind::Monthly);
    }

    #[test]
    fn integral_percent_serializes_without_decimal_and_nulls_are_kept() {
        let s = serde_json::to_string(&make_window("seven_day", 41.0, None)).unwrap();
        assert!(s.contains(r#""used_percent":41,"#), "{s}");
        assert!(
            s.contains(r#""scope":null"#),
            "keys are kept even for values that do not apply: {s}"
        );
        let p = serde_json::to_value(ProviderSnapshot::empty(ProviderStatus::Error, "x", None))
            .unwrap();
        for key in ["plan", "blocked", "error_code"] {
            assert_eq!(p.get(key), Some(&serde_json::Value::Null));
        }
    }
}

#[cfg(test)]
mod upload_tests {
    use super::*;

    #[test]
    fn sendable_ids_follow_the_worker_rule() {
        let cases: &[(&str, Option<Option<&str>>)] = &[
            ("five_hour", Some(None)),
            ("seven_day", Some(None)),
            ("window_90m", Some(None)),
            ("primary", Some(None)),
            ("five_hour_primary", Some(None)),
            ("seven_day_secondary_2", Some(None)),
            ("seven_day_opus", Some(Some("Opus"))),
            ("seven_day_fable", Some(Some("Fable"))),
            ("codex_bengalfox_five_hour", Some(Some("Codex extra"))),
            ("codex_other_seven_day_primary", Some(Some("codex_other"))),
            ("extra_usage", None),
            ("spend_limit", None),
            ("seven_day_acme", None),
            ("seven_day_opus_4", None),
            ("seven_day_2", None),
            (
                "codex_bengalfox_five_hour_primary_3",
                Some(Some("Codex extra")),
            ),
            ("acme_five_hour", None),
            ("Five_hour", None),
            ("codex-bengalfox_five_hour", None),
            ("window_1234567m", None),
            ("", None),
        ];
        for (id, want) in cases {
            assert_eq!(sendable_scope(id), *want, "{id}");
        }
        assert_eq!(sendable_scope(&"a".repeat(65)), None);
    }

    #[test]
    fn upload_drops_unknown_scopes_and_rebuilds_text() {
        let mut model = make_window("seven_day_opus", 5.0, None);
        model.label = "Weekly Opus (Acme)".into();
        model.scope = Some("Opus".into());
        let up = model.for_upload().unwrap();
        assert_eq!(
            (up.label.as_str(), up.scope.as_deref()),
            ("Weekly Opus", Some("Opus"))
        );
        // A per-group window whose id parses as an overall limit is still dropped when it carries an unknown scope
        let mut group = make_window("five_hour", 5.0, None);
        group.scope = Some("Acme".into());
        assert_eq!(group.for_upload(), None);
        // An unknown group whose id contains a known group's name
        let mut lookalike = make_window("codex_other_five_hour_primary", 5.0, None);
        lookalike.scope = Some("codex_other_five_hour".into());
        assert_eq!(lookalike.for_upload(), None);
        let mut known = make_window("codex_other_five_hour_primary", 5.0, None);
        known.scope = Some("codex_other".into());
        assert!(known.for_upload().is_some());
        let mut p = ProviderSnapshot::empty(ProviderStatus::Error, "raw CLI text", None);
        p.plan = Some("MAX".into());
        let up = p.for_upload();
        assert_eq!(up.error.as_deref(), Some(WITHHELD_ERROR));
        assert_eq!(up.plan.as_deref(), Some("max"));
    }
}

#[cfg(test)]
mod blocked_tests {
    use super::*;

    const T0: i64 = 1_794_834_000_000; // 2026-11-16T13:00:00Z

    fn snap(windows: Vec<UsageWindow>, blocked: Option<bool>) -> ProviderSnapshot {
        ProviderSnapshot {
            blocked,
            windows,
            ..ProviderSnapshot::empty(ProviderStatus::Ok, "", None)
        }
    }

    #[test]
    fn blocked_waits_for_reset_but_at_most_an_hour() {
        let far = make_window("five_hour", 100.0, Some(T0 + 180 * MINUTE_MS));
        let s = snap(vec![far.clone()], Some(true));
        assert_eq!(
            s.blocked_until_ms(T0),
            Some(T0 + 60 * MINUTE_MS),
            "every 60 minutes when the reset is far away"
        );
        let near = make_window("five_hour", 100.0, Some(T0 + 20 * MINUTE_MS));
        let s = snap(vec![near], Some(true));
        assert_eq!(
            s.blocked_until_ms(T0),
            Some(T0 + 21 * MINUTE_MS),
            "fetch right after the reset"
        );
        // If both are at the limit, fetch at the earlier reset (if still at the limit, reschedule from that result)
        let week = make_window("seven_day", 100.0, Some(T0 + 30 * MINUTE_MS));
        let five = make_window("five_hour", 100.0, Some(T0 + 10 * MINUTE_MS));
        assert_eq!(
            snap(vec![five, week.clone()], Some(true)).blocked_until_ms(T0),
            Some(T0 + 11 * MINUTE_MS)
        );
        // 5-hour limit is back but the weekly limit is still reached → follow the weekly reset
        let five_back = make_window("five_hour", 0.0, Some(T0 + 310 * MINUTE_MS));
        assert_eq!(
            snap(vec![five_back, week.clone()], Some(true)).blocked_until_ms(T0 + 11 * MINUTE_MS),
            Some(T0 + 31 * MINUTE_MS)
        );
        // Even with a window whose reset time is unknown, fetch at the reset of the window that has one
        let unknown = make_window("five_hour", 100.0, None);
        assert_eq!(
            snap(vec![unknown, week], Some(true)).blocked_until_ms(T0),
            Some(T0 + 31 * MINUTE_MS)
        );
    }

    #[test]
    fn unknown_reset_or_not_blocked() {
        let no_reset = make_window("five_hour", 100.0, None);
        assert_eq!(
            snap(vec![no_reset], Some(true)).blocked_until_ms(T0),
            Some(T0 + 60 * MINUTE_MS)
        );
        // Only Codex's limit-reached flag; the windows are below 100%
        let w = make_window("seven_day", 40.0, Some(T0 + 10 * MINUTE_MS));
        assert_eq!(
            snap(vec![w.clone()], Some(true)).blocked_until_ms(T0),
            Some(T0 + 60 * MINUTE_MS)
        );
        assert_eq!(snap(vec![w], Some(false)).blocked_until_ms(T0), None);
        assert_eq!(snap(vec![], None).blocked_until_ms(T0), None);
    }
}
