//! Gemini provider (the Antigravity CLI, `agy`).
//!
//! - **Never does anything that consumes usage quota.**
//! - Runs the official CLI's `/usage` in print mode (`agy -p /usage --output-format json`, slash commands turned on for that run
//!   only) on the common schedule (schedule.rs), and takes the limits Antigravity gives its statusLine (`headroom statusline
//!   --gemini`) as passive values, which put the active fetch off. **The fetch is verified only on some OS and CLI versions**, so
//!   with `[gemini] enabled` left out it is on only there (Windows 11 with a verified agy; decided at the agent's start), and while it
//!   is off nothing of agy is ever started.
//! - Safety guards (layered):
//!   1. Check the version of the executable about to run (once per process, whenever another one would run, and hourly); don't
//!      fetch with one older than the verified version.
//!   2. Save "fetch in flight" before launching. A later process that finds it still set can't confirm the run used nothing, so it
//!      stops auto-fetching.
//!   3. A result is used only when it says, with exit 0, no turn, every token counter 0, no conversation and the `usage` command,
//!      that nothing was used. Anything else after launch (a timeout, output cut or not read whole, a turn, a token, a
//!      conversation) stops auto-fetching.
//! - The account is identified only from the Antigravity statusLine input (`headroom statusline --gemini`), as a hash kept on this
//!   PC. No value is fetched before the first identification. Nothing under `~/.gemini` is read.
//! - Raw CLI output (its error output included) is never written to state, logs or snapshots; only fixed diagnostics are kept.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::claude::{
    RunError, RunOutput, STALE_AFTER_MS, background_command, resolve_bin, run_capturing,
};
use super::{Event, Provider};
use crate::config::{GeminiConfig, user_home};
use crate::schema::{
    ErrorCode, ProviderSnapshot, ProviderStatus, UsageWindow, make_window, sendable_scope_in,
};
use crate::store::{FileLock, Logger, backoff_ms, fnv1a_hex, read_json, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms};

/// Epoch milliseconds of an RFC 3339 time (as Antigravity writes `reset_time`), or None
pub(crate) fn ms_from_iso(s: &str) -> Option<i64> {
    s.parse::<jiff::Timestamp>()
        .ok()
        .map(|t| t.as_millisecond())
}

const USAGE_TIMEOUT: Duration = Duration::from_secs(30);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
/// Maximum wait for the state lock (a manual collect and the agent may run at the same time)
const LOCK_WAIT: Duration = Duration::from_secs(90);
const STATE_FILE: &str = "state-gemini.json";
const LOCK_FILE: &str = "state-gemini.lock";
pub const CAPTURE_FILE: &str = "gemini-statusline.json";
/// Orders the statusLine writers (several agy terminals may run at once)
const CAPTURE_LOCK_FILE: &str = "gemini-statusline.lock";
const CAPTURE_LOCK_WAIT: Duration = Duration::from_millis(500);
/// Asks the next statusLine input to be written also when unchanged (the agent waits to see which account is used after an acceptance)
const CAPTURE_REFRESH_FILE: &str = "gemini-statusline.refresh";
/// A writer whose input is this little older than the record's took its input first and waited on the lock: the later input stands.
/// A clock set further back is written as usual
const CAPTURE_LATE_WRITER_MS: i64 = 5_000;
/// The same limits received again this soon keep the time they were first received (the record isn't written for each call)
const QUOTA_RECEIPT_MS: i64 = MINUTE_MS;
/// The acceptance generation (a number), raised by each acceptance under the writers' lock. A writer notes it before reading its input
/// and saves only if it is unchanged under the lock: an input that straddled an acceptance is passed over once
const ACCEPT_GEN_FILE: &str = "gemini-statusline.gen";
/// How long the agent waits for the statusLine writers to finish before an acceptance
const CAPTURE_ACCEPT_WAIT: Duration = Duration::from_secs(5);
const STATE_VERSION: u32 = 1;
/// A value saved by a clock up to this far ahead is still used (a send time may be up to 2 minutes after the observation)
const AHEAD_SLACK_MS: i64 = 2 * MINUTE_MS;
/// Oldest CLI version whose `/usage` answer, `--settings` override and exit codes were verified on a real machine
pub const MIN_VERIFIED_CLI: (u32, u32, u32) = (1, 5, 13);
const VERSION_INTERVAL_MS: i64 = 60 * MINUTE_MS;
/// Session-only settings: slash commands on, whatever the user's settings say (so `/usage` is never sent as a prompt)
pub const USAGE_SETTINGS: &str = r#"{"disableSlashCommands":false}"#;
const WEEK_SECS: i64 = 7 * 24 * 60 * 60;
const FIVE_HOURS_SECS: i64 = 5 * 60 * 60;

/// Fixed diagnostics (no CLI text). Saved in the state file as snake_case
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Diag {
    CliNotFound,
    CliStartFailed,
    VersionTimeout,
    UnrecognizedOutput,
    UnsupportedCli,
    /// On by default, and agy is a version with verified guards but not one verified for being on by default
    UnverifiedDefault,
    LoginRequired,
    ApiKey,
    FetchFailed,
    UsageTimeout,
    Unverifiable,
    Interrupted,
    StateWriteFailed,
    StateUnreadable,
    AccountUnidentified,
    AccountChanged,
    LimitsChanged,
    /// The service denies this account (a 403: suspended, or not eligible), shown by a run that confirmed zero use
    AccessDenied,
    /// The service denies this account, shown by a run whose zero use can't be confirmed: both stops
    AccessDeniedUnverified,
    /// The service rate limited the request (a 429, RESOURCE_EXHAUSTED), shown by a run that confirmed zero use: every PC waits
    RateLimited,
    /// `/usage` didn't finish because the computer slept while it ran: an ordinary failure, tried again at the next check
    Suspended,
}

impl Diag {
    pub fn message(self) -> &'static str {
        match self {
            Diag::Suspended => {
                "/usage was cut off because the computer slept while it ran; tries again at the next check"
            }
            Diag::CliNotFound => {
                "The Antigravity CLI (agy) was not found. Install it, or set [gemini] gemini_bin in config.toml"
            }
            Diag::CliStartFailed => "Could not start the Antigravity CLI (agy)",
            Diag::VersionTimeout => "agy --version did not finish in time",
            Diag::UnrecognizedOutput => "Could not read the Antigravity CLI's output",
            Diag::UnsupportedCli => {
                "This Antigravity CLI version is older than the verified one. Update it (agy update)"
            }
            Diag::UnverifiedDefault => {
                "Gemini is on by default only with the agy versions checked for it, and this one isn't. To use it, set enabled = true under [gemini] in config.toml, then restart the agent (headroom stop, then headroom start)"
            }
            Diag::LoginRequired => "Sign in to the Antigravity CLI (run agy once in a terminal)",
            Diag::ApiKey => {
                "The Antigravity CLI is set to use an API key, which has no plan usage limits. Sign in with a Google account"
            }
            Diag::FetchFailed => "Could not fetch the Gemini usage limits",
            Diag::RateLimited => {
                "Gemini usage fetching was temporarily rate limited by the service"
            }
            Diag::UsageTimeout => {
                "Auto-fetch stopped: /usage did not finish in time, so no use can't be confirmed. Resume with headroom collect --provider gemini --force"
            }
            Diag::Unverifiable => {
                "Auto-fetch stopped: the /usage result didn't confirm that nothing was used. Resume with headroom collect --provider gemini --force"
            }
            Diag::Interrupted => {
                "Auto-fetch stopped: the previous /usage was interrupted before its result was checked. Resume with headroom collect --provider gemini --force"
            }
            Diag::StateWriteFailed => "Not running /usage: cannot write the state file",
            Diag::StateUnreadable => {
                "Auto-fetch stopped: the state file couldn't be read, so earlier safety stops can't be confirmed (the next account seen starts a new history). Resume with headroom collect --provider gemini --force"
            }
            Diag::AccountUnidentified => {
                "Waiting for the Gemini account: run agy once in a terminal with Headroom's statusLine set (see the setup guide)"
            }
            Diag::AccountChanged => {
                "Fetching stopped because the Gemini account changed. If this is the right account, resume with headroom collect --provider gemini --accept-account"
            }
            Diag::LimitsChanged => {
                "Fetching paused: the Gemini limits changed. Same account (a plan change): headroom collect --provider gemini --same-account. Another account: --accept-account"
            }
            Diag::AccessDenied => {
                "The service denied access to this Google account (suspended, or not eligible). Fetching stopped on every PC: check the account, then run the command headroom status shows"
            }
            Diag::AccessDeniedUnverified => {
                "Auto-fetch stopped: the service denied access to this Google account, and it couldn't be confirmed that nothing was used. Check the account, then run the command headroom status shows (with --force)"
            }
        }
    }

    fn code(self) -> String {
        serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default()
    }

    fn error_code(self) -> ErrorCode {
        match self {
            Diag::CliNotFound => ErrorCode::NotInstalled,
            Diag::LoginRequired | Diag::ApiKey | Diag::AccountUnidentified => {
                ErrorCode::LoginRequired
            }
            Diag::AccountChanged => ErrorCode::AccountChanged,
            Diag::UsageTimeout
            | Diag::Unverifiable
            | Diag::Interrupted
            | Diag::StateUnreadable
            | Diag::AccessDeniedUnverified => ErrorCode::SafetyStop,
            Diag::AccessDenied => ErrorCode::AccessDenied,
            _ => ErrorCode::FetchFailed,
        }
    }
}

#[derive(Debug)]
pub enum UsageError {
    /// Ordinary failure (OK to retry with a longer interval)
    Retry(Diag),
    /// Cannot confirm that no quota was consumed. Stop auto-fetching
    Stop(Diag),
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Observation {
    pub fetched_ms: i64,
    pub windows: Vec<UsageWindow>,
    /// Clock epoch read when the fetch started (clock.rs): used only while that epoch is current and trusted
    pub epoch: Option<u64>,
    /// The acceptance generation it was taken in: a statusLine input of a later one is compared with it by time no more
    #[serde(default)]
    pub accept_gen: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct GeminiState {
    pub state_version: u32,
    /// Result of the last successful `/usage`
    pub last_ok: Option<Observation>,
    pub failures: u32,
    /// The last attempt, also one that never launched (the backoff counts from it)
    pub last_attempt_ms: i64,
    /// The last /usage launched (a query that may have gone upstream; 0 = none known)
    #[serde(default)]
    pub last_query_ms: i64,
    pub last_error: Option<Diag>,
    /// Auto-fetch is stopped because it couldn't be confirmed that no quota was consumed
    pub guard_tripped: bool,
    pub cli_version: Option<String>,
    /// The executable whose version was checked (a path on this PC, never sent)
    pub cli_path: Option<String>,
    /// Whether that version is one with verified guards (None = not checked yet)
    pub cli_supported: Option<bool>,
    pub last_version_ms: i64,
    /// Attempt start time, saved right before launching `/usage` and cleared once the result is checked
    pub usage_in_flight_ms: Option<i64>,
    /// Hash of the signed-in account's email, from the statusLine input (the email itself is never stored). None: not identified yet
    pub account_hash: Option<String>,
    /// Stopped after the statusLine input showed another account (resume with a manual --accept-account)
    pub account_changed: bool,
    /// The account the statusLine input showed when the switch was detected (taken on --accept-account)
    pub pending_hash: Option<String>,
    /// Clock epoch whose statusLine input last showed that account. Accepted only in that epoch (after a refusal of the clock, the
    /// account is seen again first)
    pub pending_hash_epoch: Option<u64>,
    /// The limits (known window ids) this account's /usage showed, sorted. Empty: not known yet
    pub known_windows: Vec<String>,
    /// Paused because /usage showed other limits than known_windows (a plan change, or another account of another plan)
    pub limits_changed: bool,
    /// The limits seen when the pause began (taken on --same-account or --accept-account)
    pub pending_windows: Vec<String>,
    /// The next limits seen wait for the user's confirmation whatever they are: a pause was dropped with its clock epoch (its limits
    /// may not be seen again: an earlier version's pause on a model's limit, or overall limits that went back while a model's limit
    /// changed). Its doubt is kept through the pauses it makes (also across another epoch change) until an acceptance is saved
    pub confirm_limits: bool,
    /// Clock epoch of the fetch that showed the pending limits. A pause of another epoch is dropped (the next fetch sees it again)
    pub pending_epoch: Option<u64>,
    /// Accepted as another account on other limits, before its email was seen: the next other email is that account (no second
    /// boundary)
    pub awaiting_email: bool,
    /// The other limits were taken as the same account's: the values before stay old until the next fetch
    pub refetch: bool,
    /// The state was started again because it couldn't be read: the next identification starts a new history (a boundary)
    pub recover_identity: bool,
    /// When an account switch was last accepted (0 = never). Used as the history boundary on the server
    pub account_accepted_ms: i64,
    /// When the statusLine's limits last handled were received (taken in, or paused on as other limits): the same input is never
    /// handled again (after an acceptance it isn't "the next fetch", nor taken back after its values were cleared)
    #[serde(default)]
    pub passive_seen_ms: Option<i64>,
    /// The clock epoch passive_seen_ms was taken in: in another one it says nothing (times of an earlier clock)
    #[serde(default)]
    pub passive_seen_epoch: Option<u64>,
    /// The acceptance generation this state was last accepted in (ACCEPT_GEN_FILE): a statusLine record of a generation before it
    /// came before that acceptance, and is never taken
    #[serde(default)]
    pub accept_gen: u64,
    /// When the statusLine limits in last_ok were received (None: last_ok came from a fetch, or none): the common schedule puts the
    /// active fetch off while they are recent
    #[serde(default)]
    pub passive_taken_ms: Option<i64>,
    /// Plan from the statusLine input (a known plan name), or None
    pub plan: Option<String>,
    /// Counts each switch or change of limits found waiting (pending_switch): an acceptance is made only for the one the user saw
    #[serde(default)]
    pub switch_seq: u64,
}

/// Read the state file. Only a missing file starts from the initial state. A file that can't be read or parsed, one without this
/// version's mark, or a stop flag of the wrong type keeps auto-fetch stopped (a corrupt file must not clear a safety stop)
pub fn load_state(path: &Path) -> GeminiState {
    state_from(std::fs::read(path))
}

/// The state as load_state reads it, or None when the file exists but can't be read now (an I/O error: nothing is decided on it)
fn read_state(path: &Path) -> Option<GeminiState> {
    match std::fs::read(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => None,
        read => Some(state_from(read)),
    }
}

fn state_from(read: std::io::Result<Vec<u8>>) -> GeminiState {
    let initial = GeminiState {
        state_version: STATE_VERSION,
        ..Default::default()
    };
    // What was known is lost: stopped, and whose history the next account continues can't be told
    let unreadable = GeminiState {
        guard_tripped: true,
        last_error: Some(Diag::StateUnreadable),
        recover_identity: true,
        ..initial.clone()
    };
    let v = match read {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return initial,
        Err(_) => return unreadable,
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) if v.is_object() => v,
            _ => return unreadable,
        },
    };
    // This version writes every field: its mark, and each stop flag and the in-flight marker with their types, are required (a state
    // without them, such as {"state_version":1}, can't say no stop was pending)
    let flag_ok = |k: &str| v.get(k).is_some_and(Value::is_boolean);
    let ok = v.get("state_version").and_then(Value::as_u64) == Some(u64::from(STATE_VERSION))
        && [
            "guard_tripped",
            "account_changed",
            "limits_changed",
            "recover_identity",
            "awaiting_email",
            "refetch",
        ]
        .iter()
        .all(|k| flag_ok(k))
        && v.get("usage_in_flight_ms")
            .is_some_and(|x| x.is_null() || x.is_i64());
    match serde_json::from_value::<GeminiState>(v) {
        Ok(s) if ok => s,
        _ => unreadable,
    }
}

/// What `headroom statusline --gemini` keeps from the Antigravity statusLine input (`gemini-statusline.json`): a hash of the account's
/// email, the plan as a known name, and the clock epoch read before the input. The email itself is never written
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Capture {
    /// When the input was taken (an unchanged input isn't written again unless the agent asks for it)
    pub captured_at_ms: i64,
    pub account_hash: String,
    #[serde(default)]
    pub plan: Option<String>,
    /// The input named a plan (an unknown name clears the plan; an input without one keeps it)
    #[serde(default)]
    pub plan_given: bool,
    #[serde(default)]
    pub epoch: Option<u64>,
    /// How many times the record changed accounts: a fetch spanning any change isn't used (also A, then B, then A again)
    #[serde(default)]
    pub changes: u64,
    /// The first input written after the agent asked for one (its request's mark, and that input's account). Kept by later writers
    /// until asked again, so the agent sees it also when other inputs replaced the record before its read
    #[serde(default)]
    pub first_after_ask: Option<FirstAfterAsk>,
    /// The limits the input showed (its `quota`), in the shape `parse_usage` reads: each limit's id, remaining fraction and reset
    /// time only. None: the input had none usable (kept from the record before, for the same account)
    #[serde(default)]
    pub quota: Option<Value>,
    /// Known limits the input marked as turned off (`disabled`): not shown, but still part of the account's set of limits
    #[serde(default)]
    pub quota_disabled: Vec<String>,
    /// When the limits above were received (an input without any keeps those of one before, with that one's time). None: no limits
    #[serde(default)]
    pub quota_at_ms: Option<i64>,
    /// The CLI version the input named (on this PC only)
    #[serde(default)]
    pub version: Option<String>,
    /// The acceptance generation the writer read before its input (ACCEPT_GEN_FILE)
    #[serde(default)]
    pub accept_gen: u64,
}

/// The acceptance generation now (0: none yet; a file that can't be read gives 0 too, so a writer that read it then passes over its
/// input, and a record saved with it is older than any acceptance)
pub fn read_accept_gen(home: &Path) -> u64 {
    std::fs::read_to_string(home.join(ACCEPT_GEN_FILE))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// The usable part of the statusLine input's `quota` (bucket id -> its status), received at `now`: the known limits with a remaining
/// fraction, and the known ones turned off (every one is checked; other ids are left out, so an input of unknown limits only says
/// nothing). A limit's reset time is its `reset_time`, else `now` plus its `reset_in_seconds`. None when no known limit is there,
/// or when one can't be read (an amount instead of a fraction, a bad value): a partial input would look like other limits. Every
/// known limit turned off is a value (none shown, the set of limits still known)
pub fn quota_from_input(input: &Value, now: i64) -> Option<(Value, Vec<String>)> {
    let quota = input.get("quota")?.as_object()?;
    let mut buckets = Vec::new();
    let mut disabled = Vec::new();
    for (id, status) in quota {
        let Some((window, _)) = window_of(id) else {
            continue;
        };
        if status.get("disabled").and_then(Value::as_bool) == Some(true) {
            disabled.push(window.to_string());
            continue;
        }
        let remaining = status
            .get("remaining_fraction")
            .and_then(Value::as_f64)
            .filter(|r| r.is_finite() && (0.0..=1.0).contains(r))?;
        let reset = status
            .get("reset_time")
            .and_then(Value::as_str)
            .filter(|t| t.len() <= 40 && ms_from_iso(t).is_some())
            .map(str::to_string)
            .or_else(|| {
                // Up to a little over a week ahead (the longest limit's length)
                status
                    .get("reset_in_seconds")
                    .and_then(Value::as_f64)
                    .filter(|s| s.is_finite() && (0.0..=8.0 * 86_400.0).contains(s))
                    .map(|s| iso_from_ms(now + (s * 1000.0).round() as i64))
            });
        buckets.push(
            serde_json::json!({"id": id, "remaining_fraction": remaining, "reset_time": reset}),
        );
    }
    disabled.sort();
    disabled.dedup();
    (!buckets.is_empty() || !disabled.is_empty()).then(|| {
        (
            serde_json::json!({"groups": [{"buckets": buckets}]}),
            disabled,
        )
    })
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct FirstAfterAsk {
    /// The request's mark (the acceptance's time)
    pub asked: i64,
    pub account_hash: String,
}

/// The account hash of an email (trimmed, lower case). Only this hash is kept, on this PC
pub fn account_hash(email: &str) -> String {
    fnv1a_hex(&["gemini", &email.trim().to_lowercase()])
}

/// A known plan name for Antigravity's `plan_tier` display string, matched as a whole name (case and spacing aside). Other names:
/// None
pub fn plan_from_tier(tier: &str) -> Option<String> {
    let name = tier
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
    let plan = match name.as_str() {
        "google ai pro" | "pro" => "pro",
        "google ai ultra" | "ultra" => "ultra",
        "google ai plus" | "plus" => "plus",
        "free" | "individual" => "free",
        "gemini enterprise"
        | "gemini enterprise standard"
        | "gemini enterprise standard emerging market"
        | "gemini enterprise plus"
        | "gemini enterprise pay-as-you-go"
        | "enterprise" => "enterprise",
        _ => return None,
    };
    Some(plan.to_string())
}

/// The part of the statusLine input that is kept, or None without an email
pub fn capture_from_input(input: &Value, now: i64, epoch: Option<u64>) -> Option<Capture> {
    let email = input.get("email")?.as_str().filter(|e| e.contains('@'))?;
    let quota = quota_from_input(input, now);
    Some(Capture {
        captured_at_ms: now,
        account_hash: account_hash(email),
        plan: input
            .get("plan_tier")
            .and_then(Value::as_str)
            .and_then(plan_from_tier),
        plan_given: input.get("plan_tier").is_some_and(Value::is_string),
        epoch,
        changes: 0,
        first_after_ask: None,
        quota_at_ms: quota.is_some().then_some(now),
        quota: quota.as_ref().map(|(q, _)| q.clone()),
        quota_disabled: quota.map(|(_, d)| d).unwrap_or_default(),
        accept_gen: 0,
        version: input
            .get("version")
            .and_then(Value::as_str)
            .filter(|v| {
                v.len() <= 32
                    && v.chars()
                        .all(|c| c.is_ascii_alphanumeric() || ".+-".contains(c))
            })
            .map(str::to_string),
    })
}

/// Save the capture, in the writers' order (a lock). An input read across an acceptance (the generation it noted is no longer the
/// current one) isn't saved: it may be of the time before. A writer that read an older clock epoch never replaces what a later one
/// saved (None, an unusable clock, is the oldest), nor one whose input came just before the record's. An input without the plan keeps
/// the plan known for the same account. An unchanged input isn't written again, unless the agent asked for the next one
pub fn save_capture(home: &Path, cap: &Capture) -> std::io::Result<bool> {
    let _lock = FileLock::acquire(home, CAPTURE_LOCK_FILE, CAPTURE_LOCK_WAIT)
        .ok_or_else(|| std::io::Error::other("the statusLine record is locked"))?;
    if read_accept_gen(home) != cap.accept_gen {
        return Ok(false);
    }
    let path = home.join(CAPTURE_FILE);
    let refresh = home.join(CAPTURE_REFRESH_FILE);
    let mut cap = cap.clone();
    if let Some(prev) = read_json::<Capture>(&path) {
        if prev.epoch > cap.epoch {
            return Ok(false);
        }
        let same_epoch = prev.epoch == cap.epoch;
        // A writer whose input came just before the record's (it waited on the lock) is told only within one acceptance generation: the
        // first input of a new one stands
        if same_epoch
            && prev.accept_gen == cap.accept_gen
            && (1..=CAPTURE_LATE_WRITER_MS).contains(&(prev.captured_at_ms - cap.captured_at_ms))
        {
            return Ok(false);
        }
        let same_account = prev.account_hash == cap.account_hash;
        cap.changes = prev.changes + u64::from(!same_account);
        // Kept within one clock epoch only (an input of an epoch before never decides an acceptance)
        cap.first_after_ask = prev.first_after_ask.clone().filter(|_| same_epoch);
        // The limits of a record from before an acceptance are never carried into this one, nor their time of receipt
        let same_gen = prev.accept_gen == cap.accept_gen;
        if same_account && same_epoch {
            if !cap.plan_given {
                cap.plan = prev.plan.clone();
                cap.plan_given = prev.plan_given;
            }
            // An input without usable limits keeps the last ones of this account (a value isn't broken by a partial input)
            if same_gen && cap.quota.is_none() {
                cap.quota = prev.quota.clone();
                cap.quota_disabled = prev.quota_disabled.clone();
                cap.quota_at_ms = prev.quota_at_ms;
            } else if same_gen
                && cap.quota == prev.quota
                && cap.quota_disabled == prev.quota_disabled
                && prev
                    .quota_at_ms
                    .is_some_and(|t| (0..QUOTA_RECEIPT_MS).contains(&(cap.captured_at_ms - t)))
            {
                // The same limits again within a minute: the time they were received stands (no write for every call). Later, the
                // receipt's time moves on, so a value received after an acceptance is taken as the next one
                cap.quota_at_ms = prev.quota_at_ms;
            }
            if cap.version.is_none() {
                cap.version = prev.version.clone();
            }
            let unchanged = same_gen
                && prev.plan == cap.plan
                && prev.plan_given == cap.plan_given
                && prev.quota == cap.quota
                && prev.quota_disabled == cap.quota_disabled
                && prev.quota_at_ms == cap.quota_at_ms
                && prev.version == cap.version;
            if unchanged && !refresh.exists() {
                return Ok(false);
            }
        }
    }
    // Asked for by the agent: this input is the first after the request, whatever comes next
    if let Ok(mark) = std::fs::read_to_string(&refresh) {
        let asked = mark.trim().parse().unwrap_or(0);
        // The first input after this request stands (a mark that couldn't be removed doesn't make a later input the first)
        if cap
            .first_after_ask
            .as_ref()
            .is_none_or(|f| f.asked != asked)
        {
            cap.first_after_ask = Some(FirstAfterAsk {
                asked,
                account_hash: cap.account_hash.clone(),
            });
        }
    }
    write_json_atomic(&path, &cap)?;
    let _ = std::fs::remove_file(&refresh);
    Ok(true)
}

/// The capture, if taken in `epoch` (Ok(None): none is used). Err: the record exists but can't be read now (nothing is decided on it)
pub fn read_capture_in(home: &Path, epoch: Option<u64>) -> std::io::Result<Option<Capture>> {
    let cap = match std::fs::read(home.join(CAPTURE_FILE)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e),
        Ok(bytes) => {
            Some(serde_json::from_slice::<Capture>(&bytes).map_err(std::io::Error::other)?)
        }
    };
    Ok(epoch.and_then(|e| cap.filter(|c| c.epoch == Some(e))))
}

/// Calls to the agy CLI. Replaced in tests.
pub trait GeminiCli: Send {
    /// The agy executable that would run now, looked up each time (it may be installed, updated or moved while the agent runs)
    fn locate(&self) -> Option<PathBuf>;
    fn version(&mut self, bin: &Path) -> Result<String, Diag>;
    /// `/usage` run with `bin` in print mode in `cwd` (an empty folder of its own): the result's `command.data`, only once the run said
    /// that nothing was used (check_usage_result)
    fn usage(&mut self, bin: &Path, cwd: &Path) -> Result<Value, UsageError>;
}

pub struct RealCli {
    cfg: GeminiConfig,
}

impl RealCli {
    pub fn new(cfg: GeminiConfig) -> Self {
        Self { cfg }
    }
}

fn agy_command(bin: &Path) -> Command {
    let mut cmd = background_command(&bin.to_string_lossy());
    // No update of the CLI during a run (it would replace the binary under the run, or wait on its lock)
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    cmd
}

impl GeminiCli for RealCli {
    fn locate(&self) -> Option<PathBuf> {
        // Absolute, so the version check and /usage (run in another folder) start the same file
        gemini_bin(&self.cfg)
            .filter(|p| p.is_file())
            .map(|p| std::path::absolute(&p).unwrap_or(p))
    }

    fn version(&mut self, bin: &Path) -> Result<String, Diag> {
        let mut cmd = agy_command(bin);
        cmd.arg("--version");
        version_from_output(run_capturing(cmd, VERSION_TIMEOUT))
    }

    fn usage(&mut self, bin: &Path, cwd: &Path) -> Result<Value, UsageError> {
        // The working folder was made before the go's last check: nothing more but the launch here (a folder that isn't there fails
        // the launch)
        let mut cmd = agy_command(bin);
        // The fixed arguments as they are (no shell), an empty standard input, hidden and at a low priority (run_capturing)
        cmd.args(usage_args()).current_dir(cwd);
        classify_usage_output(run_capturing(cmd, USAGE_TIMEOUT))
    }
}

/// The agy versions on which the whole fetch (the statusLine and `/usage`) was verified by hand on a verified OS: there Gemini is on
/// without an `enabled` in config.toml. Any other version, or another OS, starts it only when config.toml turns it on
pub const DEFAULT_ON_VERSIONS: &[&str] = &["1.5.14"];

/// Windows 11 is Windows NT build 22000 or later (Windows 10 is under it)
const WINDOWS_11_BUILD: u32 = 22_000;

/// Whether this OS is one the whole fetch was verified on: Windows 11, not Windows Server (the key read once from the registry,
/// hidden; anything that can't be read is not)
pub fn default_on_os() -> bool {
    if !cfg!(windows) {
        return false;
    }
    crate::providers::claude::background_command("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        ])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .is_some_and(|out| verified_windows(&String::from_utf8_lossy(&out.stdout)))
}

/// Whether `reg query ...\CurrentVersion` output is Windows 11's: a build of 22000 or later on a client installation (Windows Server
/// shares the build numbers; its InstallationType is "Server" or "Server Core")
pub fn verified_windows(text: &str) -> bool {
    reg_value(text, "CurrentBuildNumber")
        .and_then(|b| b.parse::<u32>().ok())
        .is_some_and(|build| build >= WINDOWS_11_BUILD)
        && reg_value(text, "InstallationType") == Some("Client")
}

/// A value in `reg query` output: the rest of the line whose name is exactly `name` ("    CurrentBuildNumber    REG_SZ    26300")
fn reg_value<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let rest = line.trim_start().strip_prefix(name)?;
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        let rest = rest.trim_start().strip_prefix("REG_")?;
        let (_, value) = rest.split_once(char::is_whitespace)?;
        Some(value.trim())
    })
}

/// Whether a version of agy is one to run: on by default, only one verified for that; turned on in config.toml, one with verified
/// guards (MIN_VERIFIED_CLI or later)
pub fn verified_version(version: &str, by_default: bool) -> bool {
    if by_default {
        DEFAULT_ON_VERSIONS.contains(&version)
    } else {
        parse_agy_version(version).is_some_and(|got| got >= MIN_VERIFIED_CLI)
    }
}

/// Whether Gemini is on for a config that leaves `enabled` out: on a verified OS, with agy found and its version one of
/// DEFAULT_ON_VERSIONS (asked once with `agy --version`; nothing else of agy runs). Elsewhere off, with nothing launched
pub fn default_on(cli: &mut dyn GeminiCli, verified_os: bool) -> bool {
    if !verified_os {
        return false;
    }
    let Some(bin) = cli.locate() else {
        return false;
    };
    cli.version(&bin)
        .is_ok_and(|v| DEFAULT_ON_VERSIONS.contains(&v.as_str()))
}

/// The version a run of `agy --version` printed: only from a clean exit whose output was read whole (text that isn't UTF-8 or was cut
/// could hide the CLI's own version and show another)
pub fn version_from_output(r: Result<RunOutput, RunError>) -> Result<String, Diag> {
    let out = r.map_err(|e| match e {
        RunError::NotFound => Diag::CliNotFound,
        RunError::StartFailed => Diag::CliStartFailed,
        RunError::Timeout | RunError::Suspended => Diag::VersionTimeout,
    })?;
    if out.code != Some(0) || !out.complete {
        return Err(Diag::UnrecognizedOutput);
    }
    parse_agy_version(&out.stdout)
        .map(|(a, b, c)| format!("{a}.{b}.{c}"))
        .ok_or(Diag::UnrecognizedOutput)
}

/// The version in `agy --version` output ("1.5.13", "agy 1.5.13", "v1.5.13", "1.5.13+build"). Only the first word of the first line
/// that looks like a version counts (the CLI's own; a newer release or a toolchain named after it doesn't). A pre-release
/// ("1.5.13-rc1") or anything else in that word is not taken: it isn't a verified release
pub fn parse_agy_version(s: &str) -> Option<(u32, u32, u32)> {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty())?;
    let word = line
        .split_whitespace()
        .map(|w| w.strip_prefix('v').unwrap_or(w))
        .find(|w| w.starts_with(|c: char| c.is_ascii_digit()))?;
    let core = word.split('+').next()?;
    let mut it = core.split('.');
    let v = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    it.next().is_none().then_some(v)
}

/// Arguments for running `/usage`, each passed as is (never through a shell: Git Bash would rewrite "/usage" into a path)
pub fn usage_args() -> Vec<String> {
    [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--settings",
        USAGE_SETTINGS,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Where agy is looked for when it isn't on PATH: the documented install folders, then the other folders seen on real machines
pub fn known_locations(home: &Path) -> Vec<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        vec![
            local.join("agy").join("bin").join("agy.exe"),
            home.join(".gemini").join("bin").join("agy.exe"),
            home.join(".gemini")
                .join("antigravity-cli")
                .join("bin")
                .join("agy.exe"),
        ]
    } else {
        vec![
            home.join(".local").join("bin").join("agy"),
            home.join(".gemini").join("bin").join("agy"),
            PathBuf::from("/opt/homebrew/bin/agy"),
            PathBuf::from("/usr/local/bin/agy"),
        ]
    }
}

/// The agy executable: `[gemini] gemini_bin`, then HEADROOM_GEMINI_BIN, then PATH, then the known folders. None if not found
pub fn gemini_bin(cfg: &GeminiConfig) -> Option<PathBuf> {
    if !cfg.gemini_bin.trim().is_empty() {
        return resolve_bin(cfg.gemini_bin.trim());
    }
    if let Some(bin) = std::env::var("HEADROOM_GEMINI_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        return resolve_bin(bin.trim());
    }
    resolve_bin("agy").or_else(|| {
        known_locations(&user_home())
            .into_iter()
            .find(|p| p.is_file())
    })
}

/// Classify a run of `/usage`. Launch failures and failures shown to have used nothing are ordinary; anything that can't be confirmed
/// after launch stops auto-fetching
pub fn classify_usage_output(r: Result<RunOutput, RunError>) -> Result<Value, UsageError> {
    match r {
        Err(RunError::NotFound) => Err(UsageError::Retry(Diag::CliNotFound)),
        Err(RunError::StartFailed) => Err(UsageError::Retry(Diag::CliStartFailed)),
        Err(RunError::Timeout) => Err(UsageError::Stop(Diag::UsageTimeout)),
        // Cut off by the computer's sleep: tried again like any failure, without a safety stop (the user's choice: a laptop sleeping
        // in the middle of a fetch needs no resume by hand)
        Err(RunError::Suspended) => Err(UsageError::Retry(Diag::Suspended)),
        // Output not read whole (cut at its size limit, not UTF-8, still held open when the run ended): what it said can't be seen
        Ok(out) if !out.complete => Err(UsageError::Stop(Diag::Unverifiable)),
        Ok(out) => {
            let stdout = out.stdout.trim();
            // A denial of the account shown by output that can't confirm nothing was used: both stops
            let denied = |text: &str| {
                super::says_access_denied(text) || super::says_access_denied(&out.stderr)
            };
            match serde_json::from_str::<Value>(stdout) {
                Ok(v) if v.is_object() => match check_usage_result(&v, out.code) {
                    Err(UsageError::Stop(_))
                        if denied(&format!("{} {v}", error_text(v.get("error")))) =>
                    {
                        Err(UsageError::Stop(Diag::AccessDeniedUnverified))
                    }
                    // Zero use confirmed, the denial told on the error output
                    Err(UsageError::Retry(d))
                        if d != Diag::AccessDenied && super::says_access_denied(&out.stderr) =>
                    {
                        Err(UsageError::Retry(Diag::AccessDenied))
                    }
                    // Zero use confirmed, a rate limit told by the result's error and the error output together (its code on one,
                    // what it says on the other)
                    Err(UsageError::Retry(d))
                        if !matches!(d, Diag::AccessDenied | Diag::RateLimited)
                            && super::says_rate_limited(&format!(
                                "{} {}",
                                error_text(v.get("error")),
                                out.stderr
                            )) =>
                    {
                        Err(UsageError::Retry(Diag::RateLimited))
                    }
                    r => r,
                },
                // Ended with an error before printing a result: ordinary only when its error output says plainly that it couldn't
                // sign in or uses an API key (neither reaches a model)
                _ if stdout.is_empty() && out.code.is_some_and(|c| c != 0) => {
                    match stderr_failure(&out.stderr.to_ascii_lowercase(), out.code) {
                        Some(d) => Err(UsageError::Retry(d)),
                        None if denied("") => Err(UsageError::Stop(Diag::AccessDeniedUnverified)),
                        None => Err(UsageError::Stop(Diag::Unverifiable)),
                    }
                }
                _ if denied(stdout) => Err(UsageError::Stop(Diag::AccessDeniedUnverified)),
                _ => Err(UsageError::Stop(Diag::Unverifiable)),
            }
        }
    }
}

/// Check the result of `agy -p /usage --output-format json` (and its exit code) and return its `command.data`.
/// A success must say, with the right types and exit 0, no turn, every counter 0, the `usage` command and no conversation. A failure
/// is an ordinary one only as `ERROR` with no turn, no tokens, no conversation and an error exit; anything else stops auto-fetching
pub fn check_usage_result(v: &Value, code: Option<i32>) -> Result<Value, UsageError> {
    let stop = || Err(UsageError::Stop(Diag::Unverifiable));
    // A conversation means a turn may have started: never an ordinary failure
    let conversation = v.get("conversation_id");
    if !conversation.is_none_or(|c| c.is_null() || c.as_str() == Some("")) {
        return stop();
    }
    let (Some(status), Some(turns), Some(usage)) = (
        v.get("status").and_then(Value::as_str),
        v.get("num_turns").and_then(Value::as_u64),
        v.get("usage").filter(|u| u.is_object()),
    ) else {
        return stop();
    };
    // The known counters as integers 0 (total_tokens required), and nothing else in `usage` but zeros
    let no_tokens = usage.get("total_tokens").and_then(Value::as_u64) == Some(0)
        && COUNTERS
            .iter()
            .all(|k| usage.get(*k).is_none_or(|v| v.as_u64() == Some(0)))
        && counters_zero(usage);
    if turns != 0 || !no_tokens {
        return stop();
    }
    match status {
        "SUCCESS" => {
            let command = v.get("command");
            let named_usage =
                command.and_then(|c| c.get("name")).and_then(Value::as_str) == Some("usage");
            let no_conversation = conversation.and_then(Value::as_str) == Some("");
            match command.and_then(|c| c.get("data")) {
                Some(data)
                    if code == Some(0) && named_usage && no_conversation && data.is_object() =>
                {
                    Ok(data.clone())
                }
                _ => stop(),
            }
        }
        // Nothing was used and the run ended with an error: an ordinary failure, told by its error text (never kept)
        "ERROR" if code.is_some_and(|c| c != 0) => Err(UsageError::Retry(failure_diag(
            &error_text(v.get("error")),
            code,
        ))),
        _ => stop(),
    }
}

/// The token counters agy 1.5.13 reports in `usage`
const COUNTERS: [&str; 5] = [
    "input_tokens",
    "output_tokens",
    "thinking_tokens",
    "cache_read_tokens",
    "total_tokens",
];

/// Whether every value in a `usage` object is an integer 0 (nested objects and lists included). Anything else (another number, null,
/// a string, true) can't confirm that nothing was used
fn counters_zero(v: &Value) -> bool {
    match v {
        Value::Number(n) => n.as_u64() == Some(0),
        Value::Object(m) => m.values().all(counters_zero),
        Value::Array(a) => a.iter().all(counters_zero),
        _ => false,
    }
}

/// A result's `error` as its text says it (lowercase, in memory only): a structured one (Google's `{code, status, message}`, or one
/// wrapped in `error`) as "403 permission_denied: message"
fn error_text(error: Option<&Value>) -> String {
    match error {
        Some(Value::String(s)) => s.to_ascii_lowercase(),
        Some(other) => {
            let e = other
                .get("error")
                .filter(|e| e.is_object())
                .unwrap_or(other);
            let field = |k: &str| match e.get(k) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Null) | None => String::new(),
                Some(x) => x.to_string(),
            };
            // Its code as "code N" (Google's RESOURCE_EXHAUSTED is 429 when the code isn't given)
            let code = match (field("code"), field("status")) {
                (c, _) if !c.is_empty() => format!("code {c}"),
                (_, st) if st.eq_ignore_ascii_case("resource_exhausted") => "code 429".to_string(),
                _ => String::new(),
            };
            format!("{code} {}: {} {other}", field("status"), field("message")).to_ascii_lowercase()
        }
        None => String::new(),
    }
}

/// Whether an error's text says the service rate limited the request (Google's 429 RESOURCE_EXHAUSTED, as its API errors carry it;
/// not seen on this PC)
fn says_api_key(text: &str) -> bool {
    ["api key", "api_key", "ai studio"]
        .iter()
        .any(|w| text.contains(w))
}

/// A run that printed nothing and ended with an error, told by its error output (in memory only): an ordinary failure only when that
/// says plainly that it isn't signed in, or uses an API key (exit 2, as the CLI documents). Neither reaches a model. None: anything
/// else, a crash among them (it can't be told apart from one after a turn)
fn stderr_failure(text: &str, code: Option<i32>) -> Option<Diag> {
    // A crash can't be told apart from one after a turn, and an output that also says something succeeded doesn't say plainly
    // that nothing could start
    if ["panic", "goroutine", "fatal error", "success"]
        .iter()
        .any(|w| text.contains(w))
    {
        return None;
    }
    // Not even the API key exit (its exact text isn't confirmed for this version): anything on the error output alone can't show
    // that nothing was used (a stop; the user's --force retries it). An API key failure that comes as a result (ERROR with every
    // counter 0) is an ordinary one
    let _ = code;
    // Anything else (a sign-in message among them: its real text isn't confirmed, and it could follow a turn) can't show that
    // nothing was used. A sign-in failure that comes as a result (ERROR with every counter 0) is still an ordinary one
    if !STDERR_SIGN_IN_IS_ORDINARY {
        return None;
    }
    const NOT_SIGNED_IN: [&str; 13] = [
        "not signed in",
        "not logged in",
        "please sign in",
        "please log in",
        "sign in to continue",
        "log in to continue",
        "login required",
        "authentication required",
        "unauthenticated",
        "not authenticated",
        "session expired",
        "token expired",
        "credentials expired",
    ];
    NOT_SIGNED_IN
        .iter()
        .any(|w| text.contains(w))
        .then_some(Diag::LoginRequired)
}

/// Whether a run that printed nothing and named a sign-in failure on its error output is an ordinary failure. Off: that text isn't
/// confirmed on a real machine, and nothing in it shows that no turn ran
const STDERR_SIGN_IN_IS_ORDINARY: bool = false;

/// The diagnostic of the documented failure (the run says it used nothing), from its error text (in memory only)
fn failure_diag(text: &str, code: Option<i32>) -> Diag {
    // The service denying the account (as it reports it), before any other reading of the text
    if super::says_access_denied(text) {
        return Diag::AccessDenied;
    }
    // Rate limited upstream: every PC waits (its stages), instead of each retrying on its own
    if super::says_rate_limited(text) {
        return Diag::RateLimited;
    }
    if code == Some(2) && says_api_key(text) {
        return Diag::ApiKey;
    }
    const SIGN_IN: [&str; 11] = [
        "sign in",
        "signed in",
        "sign-in",
        "log in",
        "logged in",
        "login",
        "authenticat",
        "unauthorized",
        "credential",
        "oauth",
        "reauth",
    ];
    let expired = text.contains("expired")
        && ["token", "session", "auth", "credential"]
            .iter()
            .any(|w| text.contains(w));
    if expired || SIGN_IN.iter().any(|w| text.contains(w)) {
        Diag::LoginRequired
    } else {
        Diag::FetchFailed
    }
}

/// A known Antigravity limit: (window id, length in seconds). Others are neither shown nor sent
fn window_of(bucket_id: &str) -> Option<(&'static str, i64)> {
    Some(match bucket_id {
        "gemini-5h" => ("five_hour", FIVE_HOURS_SECS),
        "gemini-weekly" => ("seven_day", WEEK_SECS),
        "gemini-argon-wtu-weekly" => ("seven_day_argon", WEEK_SECS),
        "3p-5h" => ("partner_five_hour", FIVE_HOURS_SECS),
        "3p-weekly" => ("partner_seven_day", WEEK_SECS),
        _ => return None,
    })
}

/// The windows of a `/usage` result and the sorted ids of the known limits it showed (its "shape"). Unknown limits are left out. A
/// result that can't be read whole (a group without its list, a limit without an id, a known limit with a bad value or shown twice)
/// isn't used at all: a partial one would look like other limits. An unused limit (remaining exactly 1) has no reset time:
/// Antigravity gives it "now plus the length"
pub fn parse_usage(data: &Value) -> Result<(Vec<UsageWindow>, Vec<String>), UsageError> {
    let unreadable = || UsageError::Retry(Diag::UnrecognizedOutput);
    let groups = data
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(unreadable)?;
    let mut windows: Vec<UsageWindow> = Vec::new();
    for group in groups {
        let buckets = group
            .get("buckets")
            .and_then(Value::as_array)
            .ok_or_else(unreadable)?;
        for bucket in buckets {
            let bucket_id = bucket
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(unreadable)?;
            let Some((id, secs)) = window_of(bucket_id) else {
                continue;
            };
            let remaining = bucket
                .get("remaining_fraction")
                .and_then(Value::as_f64)
                .filter(|r| r.is_finite() && (0.0..=1.0).contains(r))
                .ok_or_else(unreadable)?;
            if windows.iter().any(|w| w.id == id) {
                return Err(unreadable());
            }
            // Rounded to 0.1, and never up to 100 while anything is left (100 means the limit is reached)
            let used = if remaining > 0.0 {
                (((1.0 - remaining) * 1000.0).round() / 10.0).min(99.9)
            } else {
                100.0
            };
            let resets = if remaining == 1.0 {
                None
            } else {
                bucket
                    .get("reset_time")
                    .and_then(Value::as_str)
                    .and_then(ms_from_iso)
            };
            let mut w = make_window(id, used, resets).with_seconds(Some(secs));
            w.scope = sendable_scope_in("gemini", id)
                .flatten()
                .map(str::to_string);
            windows.push(w);
        }
    }
    if windows.is_empty() {
        return Err(unreadable());
    }
    let mut shape: Vec<String> = windows.iter().map(|w| w.id.clone()).collect();
    shape.sort();
    Ok((windows, shape))
}

/// The mark of what waits to be accepted: the switches found, the kind waiting (another account, other limits, or both, and whose
/// email), and the account changes the statusLine record counted (a B→C→B the writers saw moves it, though the record shows B)
fn switch_mark(state: &GeminiState, changes: Option<u64>) -> i64 {
    let hex = crate::store::fnv1a_hex(&[
        &state.switch_seq.to_string(),
        &state.account_changed.to_string(),
        &state.limits_changed.to_string(),
        state.pending_hash.as_deref().unwrap_or(""),
        &changes.map_or("-".to_string(), |c| c.to_string()),
    ]);
    i64::from_str_radix(&hex[..15], 16).unwrap_or(0)
}

/// Who the state says the account is (the identified one, and a switch waiting for acceptance), and how many times the statusLine
/// record had changed accounts when last read
type Identity = (Option<String>, bool, Option<String>, Option<u64>);

/// An executable as checked: its absolute path, size and time of change (an update in place shows as another one)
#[derive(Clone, Debug, PartialEq)]
struct BinId {
    path: PathBuf,
    len: u64,
    modified: Option<std::time::SystemTime>,
}

fn bin_id(path: &Path) -> BinId {
    let meta = std::fs::metadata(path).ok();
    BinId {
        path: path.to_path_buf(),
        len: meta.as_ref().map_or(0, |m| m.len()),
        modified: meta.and_then(|m| m.modified().ok()),
    }
}

pub struct GeminiProvider {
    /// What the last collect did upstream (take_run)
    run: Option<super::Run>,
    /// The go this collect was allowed by: its time limit (this PC's clock) and when it was given (monotonic). Past either, the query
    /// isn't started (the destination may have replaced the go)
    fetch_deadline: Option<super::Grant>,
    /// The user's explicit go past a safety stop, for the next collect only
    safety_confirmed: bool,
    /// The switch the next acceptance is for (the mark pending_switch gave when the user asked)
    accept_target: Option<i64>,
    /// This collect only takes the statusLine record (take_passive): no agy is started
    passive_only: bool,
    home: PathBuf,
    cfg: GeminiConfig,
    log: Logger,
    pub state: GeminiState,
    cli: Box<dyn GeminiCli>,
    /// A statusLine input arrived since the last collect
    capture_dirty: bool,
    /// On the next collect, accept the account (or the limits) seen and resume
    accept_pending: bool,
    /// On the next collect, take the limits seen as this account's and resume (no history boundary)
    same_pending: bool,
    /// Hold off `/usage` until this time (the resident agent's fetch scheduling; statusLine input continues)
    fetch_hold_until_ms: i64,
    /// The clock read once the state file is locked and read again (None in tests: the time passed to collect)
    clock: Option<fn() -> i64>,
    /// Clock epoch read when the current collect started (clock.rs)
    epoch: Option<u64>,
    /// What the last collect did with an acceptance: Some(true) once saved, Some(false) if it couldn't be made or saved
    accepted: Option<bool>,
    /// The executable whose version this process checked (`/usage` runs only with that one, unchanged)
    checked_bin: Option<BinId>,
    /// This process has looked at the version (checked one, or found none)
    version_looked: bool,
    /// The saved state couldn't be read at the last look: its queued observations stay queued
    saved_unread: bool,
    /// The last collect couldn't save the state: its queued observations stay queued until a save works
    unsaved: bool,
    /// The statusLine record couldn't be read in this collect: no acceptance or fetch result is decided on it
    capture_unread: bool,
    /// How many times the statusLine record had changed accounts when last read (None: no record of this epoch)
    seen_changes: Option<u64>,
    /// When the statusLine record last read was written (None: none of this epoch): a new record, of limits or only of the account
    seen_record_ms: Option<i64>,
    /// The state file couldn't be read: when it is read again (nothing is due before)
    state_retry_at: Option<i64>,
}

impl GeminiProvider {
    pub fn new(home: &Path, cfg: GeminiConfig, log: Logger) -> Self {
        let cli = Box::new(RealCli::new(cfg.clone()));
        let mut p = Self::with_cli(home, cfg, log, cli);
        p.clock = Some(crate::time::now_ms);
        p
    }

    pub fn with_cli(home: &Path, cfg: GeminiConfig, log: Logger, cli: Box<dyn GeminiCli>) -> Self {
        Self {
            home: home.to_path_buf(),
            cfg,
            log,
            state: load_state(&home.join(STATE_FILE)),
            cli,
            capture_dirty: true,
            run: None,
            passive_only: false,
            fetch_deadline: None,
            safety_confirmed: false,
            accept_target: None,
            accept_pending: false,
            same_pending: false,
            fetch_hold_until_ms: 0,
            clock: None,
            epoch: crate::clock::usable_epoch(home),
            accepted: None,
            checked_bin: None,
            version_looked: false,
            saved_unread: false,
            unsaved: false,
            capture_unread: false,
            seen_changes: None,
            seen_record_ms: None,
            state_retry_at: None,
        }
    }

    fn stopped(&self) -> bool {
        self.state.guard_tripped
            || self.state.account_changed
            || self.state.limits_changed
            || self.state.account_hash.is_none()
    }

    /// The account as shown to the user (what an acceptance is for)
    fn account_view(&self) -> (Option<String>, bool, Option<String>) {
        (
            self.state.account_hash.clone(),
            self.state.account_changed,
            self.state.pending_hash.clone(),
        )
    }

    fn identity(&self) -> Identity {
        (
            self.state.account_hash.clone(),
            self.state.account_changed,
            self.state.pending_hash.clone(),
            self.seen_changes,
        )
    }

    /// The diagnostic still standing once a passing one clears: a switch or a pause waiting for the user's choice
    fn standing_diag(&self) -> Option<Diag> {
        if self.state.account_changed {
            Some(Diag::AccountChanged)
        } else if self.state.limits_changed {
            Some(Diag::LimitsChanged)
        } else {
            None
        }
    }

    /// When `/usage` may next run (at least the floor between fetches after the last, the common schedule planning the interval;
    /// extended on repeated failures and while a limit is reached)
    pub fn usage_due_ms(&self, now: i64) -> i64 {
        if self.cfg.enabled != Some(true)
            || self.stopped()
            || self.state.cli_supported != Some(true)
        {
            return i64::MAX;
        }
        if self.state.last_attempt_ms > now {
            return now;
        }
        let interval = self.cfg.interval_min.max(1) * MINUTE_MS;
        // Limits taken as the same account's: fetched again at once (the values before are old)
        let last_ok = if self.state.refetch {
            0
        } else {
            self.state
                .last_ok
                .as_ref()
                .filter(|o| o.epoch.is_some() && o.epoch == crate::clock::usable_epoch(&self.home))
                // A value taken from the statusLine doesn't move the active fetch's schedule (the common schedule puts it off for
                // passive values, within its limit)
                .filter(|o| self.state.passive_taken_ms != Some(o.fetched_ms))
                .map_or(0, |o| o.fetched_ms)
        };
        let last_ok = if last_ok > now { 0 } else { last_ok };
        let by_success = last_ok.saturating_add(interval);
        let by_attempt = self
            .state
            .last_attempt_ms
            .saturating_add(backoff_ms(interval, self.state.failures));
        let blocked_until = self
            .build(now)
            .blocked_until_ms(self.state.last_attempt_ms)
            .unwrap_or(i64::MIN);
        by_success
            .max(by_attempt)
            .max(blocked_until)
            .max(self.fetch_hold_until_ms)
    }

    /// When to next check the CLI version (hourly; at once in a new process and before the first check)
    pub fn version_due_ms(&self, now: i64) -> i64 {
        if self.cfg.enabled != Some(true) {
            return i64::MAX;
        }
        if !self.version_looked || self.state.cli_supported.is_none() {
            return 0;
        }
        if self.state.last_version_ms > now {
            return now;
        }
        self.state
            .last_version_ms
            .saturating_add(VERSION_INTERVAL_MS)
    }

    fn log_diag(&self, what: &str, d: Diag) {
        self.log
            .log(&format!("gemini: {what}: {} {}", d.code(), d.message()));
    }

    fn save(&self) -> std::io::Result<()> {
        write_json_atomic(&self.home.join(STATE_FILE), &self.state)
    }

    /// Check the version of the executable that would run now: when due, and whenever it isn't the one this process checked
    fn refresh_version(&mut self, now: i64, force: bool, bin: Option<&Path>, defer_periodic: bool) {
        let path = bin.map(|b| b.to_string_lossy().into_owned());
        let id = bin.map(bin_id);
        let another = id != self.checked_bin || path != self.state.cli_path;
        if !force && !another && (defer_periodic || self.version_due_ms(now) > now) {
            return;
        }
        self.version_looked = true;
        self.state.last_version_ms = now;
        self.checked_bin = id;
        self.state.cli_path = path;
        let result = match bin {
            Some(bin) => self.cli.version(bin),
            None => Err(Diag::CliNotFound),
        };
        match result {
            Ok(v) => {
                // On by default: only the versions verified for that, also when agy was updated while the agent runs
                let ok = verified_version(&v, self.cfg.by_default);
                let guarded = verified_version(&v, false);
                self.state.cli_version = Some(v);
                self.state.cli_supported = Some(ok);
                if !ok {
                    // A version with verified guards, only not one checked for being on by default: turning it on is the way, not
                    // an update
                    self.state.last_error = Some(if guarded {
                        Diag::UnverifiedDefault
                    } else {
                        Diag::UnsupportedCli
                    });
                } else if matches!(
                    self.state.last_error,
                    Some(
                        Diag::UnsupportedCli
                            | Diag::UnverifiedDefault
                            | Diag::CliNotFound
                            | Diag::CliStartFailed
                            | Diag::VersionTimeout
                            | Diag::UnrecognizedOutput
                    )
                ) {
                    self.state.last_error = self.standing_diag();
                }
            }
            Err(d) => {
                // The version can't be told: not run until it can (checked again hourly, or when another executable is found)
                self.state.cli_version = None;
                self.state.cli_supported = Some(false);
                self.state.last_error = Some(d);
                self.log_diag("version", d);
            }
        }
    }

    /// The account from the statusLine input: identified the first time, a switch when it shows another
    fn refresh_account(&mut self, now: i64) {
        let cap = match read_capture_in(&self.home, self.epoch) {
            Ok(cap) => cap,
            Err(_) => {
                // Can't be told now: no acceptance and no fetch result is decided on it (read again next round)
                self.capture_unread = true;
                return;
            }
        };
        self.seen_changes = cap.as_ref().map(|c| c.changes);
        self.seen_record_ms = cap.as_ref().map(|c| c.captured_at_ms);
        let Some(cap) = cap else {
            return;
        };
        // Waiting for the account accepted as another one: the first input after the acceptance decides, also when later inputs
        // replaced the record before this read (the account before: the wait ends; another: that is the account accepted)
        if let Some(first) = cap
            .first_after_ask
            .as_ref()
            .filter(|f| self.state.awaiting_email && f.asked == self.state.account_accepted_ms)
        {
            self.state.awaiting_email = false;
            if self.state.account_hash.as_deref() != Some(&first.account_hash) {
                self.state.account_hash = Some(first.account_hash.clone());
                self.log
                    .log("gemini: identified the account accepted before");
            }
        }
        match self.state.account_hash.clone() {
            // A state started again isn't identified by a record of before the last acceptance (it may be the account before:
            //); a newer one does
            None if self.state.recover_identity && cap.accept_gen < read_accept_gen(&self.home) => {
            }
            None => {
                self.state.account_hash = Some(cap.account_hash.clone());
                self.state.plan = cap.plan.clone();
                if std::mem::take(&mut self.state.recover_identity) {
                    // What was known before was lost: whose history this continues can't be told, so it starts at a boundary
                    self.state.account_accepted_ms = now;
                }
                if self.state.last_error == Some(Diag::AccountUnidentified) {
                    self.state.last_error = None;
                }
                self.log.log("gemini: identified the account");
            }
            Some(known) if known != cap.account_hash => {
                if std::mem::take(&mut self.state.awaiting_email) {
                    // The account accepted as another one before its email was seen: this is it (no second boundary)
                    self.state.account_hash = Some(cap.account_hash.clone());
                    self.state.plan = cap.plan.clone();
                    self.log
                        .log("gemini: identified the account accepted before");
                } else {
                    if !self.state.account_changed
                        || self.state.pending_hash.as_deref() != Some(&cap.account_hash)
                    {
                        // A pause on other limits stays as it is: only the user's choice resolves it
                        self.state.account_changed = true;
                        self.state.switch_seq += 1;
                        self.state.pending_hash = Some(cap.account_hash.clone());
                        self.state.last_ok = None;
                        self.state.last_error = Some(Diag::AccountChanged);
                        self.log_diag("account", Diag::AccountChanged);
                    }
                    // Seen in this epoch (also again, after a refusal of the clock): an acceptance may rest on it
                    self.state.pending_hash_epoch = self.epoch;
                }
            }
            Some(_) => {
                // Still the account before, seen after it was accepted as another: no other email is waited for
                if self.state.awaiting_email && cap.captured_at_ms > self.state.account_accepted_ms
                {
                    self.state.awaiting_email = false;
                }
                // An input without the plan doesn't clear the known one; while another account is awaited, this one's plan isn't taken
                if cap.plan_given && !self.state.awaiting_email {
                    self.state.plan = cap.plan.clone();
                }
                // Back on the known account before accepting another one: the switch is no longer pending
                if self.state.account_changed {
                    self.state.account_changed = false;
                    self.state.pending_hash = None;
                    self.state.pending_hash_epoch = None;
                    if self.state.last_error == Some(Diag::AccountChanged) {
                        self.state.last_error = self.standing_diag();
                    }
                }
            }
        }
    }

    /// The limits from the statusLine input, as a value of the identified account: only with no switch, pause or wait for an email,
    /// when newer than the value held, and through the same set-of-limits check as a fetch (a disabled known limit still counts in the
    /// set). Nothing else of the fetch's state (failures, a safety stop) changes
    fn take_passive(&mut self) {
        if self.capture_unread {
            return;
        }
        let Ok(Some(cap)) = read_capture_in(&self.home, self.epoch) else {
            return;
        };
        let (Some(data), Some(at)) = (cap.quota.as_ref(), cap.quota_at_ms) else {
            return;
        };
        // Handled already (taken in, or paused on) in this clock epoch: not again
        // (one saved without its epoch, by an earlier build, is taken as this epoch's: it holds back rather than letting a value back)
        if (self.state.passive_seen_epoch.is_none() || self.state.passive_seen_epoch == self.epoch)
            && self.state.passive_seen_ms.is_some_and(|seen| at <= seen)
        {
            return;
        }
        // Saved before the last acceptance (its writer read the generation before): of the time before it. The last acceptance's
        // generation as the state says it or as the writers' mark does (a state started again is at 0)
        if cap.accept_gen < self.state.accept_gen.max(read_accept_gen(&self.home)) {
            return;
        }
        let identified = self.state.account_hash.as_deref() == Some(cap.account_hash.as_str());
        if !identified
            || self.state.account_changed
            || self.state.limits_changed
            || self.state.awaiting_email
        {
            return;
        }
        // Only a value of this clock epoch and of this acceptance generation keeps an older input out (the first input after an
        // acceptance is the next value, whatever its time)
        let held = self.state.last_ok.as_ref().filter(|o| {
            o.epoch.is_some() && o.epoch == self.epoch && o.accept_gen == self.state.accept_gen
        });
        if held.is_some_and(|o| o.fetched_ms >= at) {
            return;
        }
        // Every known limit turned off: none to show, the set of limits still known
        let all_off = !cap.quota_disabled.is_empty()
            && data["groups"].as_array().is_some_and(|g| {
                g.iter()
                    .all(|g| g["buckets"].as_array().is_some_and(Vec::is_empty))
            });
        let (windows, mut shape) = match parse_usage(data) {
            Ok(r) => r,
            Err(_) if all_off => (Vec::new(), Vec::new()),
            Err(_) => return,
        };
        self.state.passive_seen_ms = Some(at);
        self.state.passive_seen_epoch = self.epoch;
        shape.extend(cap.quota_disabled.iter().cloned());
        shape.sort();
        shape.dedup();
        if self.state.confirm_limits || self.limits_differ(&shape) {
            self.state.limits_changed = true;
            self.state.switch_seq += 1;
            self.state.pending_windows = shape;
            self.state.pending_epoch = self.epoch;
            self.state.last_error = Some(Diag::LimitsChanged);
            self.log_diag("statusLine", Diag::LimitsChanged);
            return;
        }
        // The limits of one model or of the other vendors' models that came or went are taken as they are
        self.state.known_windows = shape;
        self.state.last_ok = Some(Observation {
            fetched_ms: at,
            windows,
            epoch: self.epoch,
            accept_gen: self.state.accept_gen,
        });
        self.state.passive_taken_ms = Some(at);
        self.state.refetch = false;
    }

    /// Whether a set of known limits differs from this account's where it tells of another plan or account: its overall limits (those
    /// of no model and not of the other vendors' models). A limit of one model, or the other vendors' group, comes and goes as the
    /// service changes (Antigravity dropped Argon's own weekly limit), and is taken as it is. None known yet: nothing to differ from
    fn limits_differ(&self, shape: &[String]) -> bool {
        let overall = |ids: &[String]| -> Vec<String> {
            ids.iter()
                .filter(|id| matches!(crate::schema::sendable_scope_in("gemini", id), Some(None)))
                .cloned()
                .collect()
        };
        !self.state.known_windows.is_empty() && overall(shape) != overall(&self.state.known_windows)
    }

    /// A pause on other limits seen in another clock epoch is dropped (an observation of an earlier epoch never leads to an
    /// acceptance), its doubt kept: the next limits seen in this one wait for a confirmation. true if dropped
    fn drop_old_pause(&mut self, current: Option<u64>) -> bool {
        if !self.state.limits_changed || current.is_none() || self.state.pending_epoch == current {
            return false;
        }
        // Its doubt isn't dropped with it: the next limits seen wait for the user's confirmation whatever they are (the limits it
        // waited on may not be seen again: an earlier version's pause on a model's limit, or overall limits that went back while
        // a model's limit changed)
        self.state.confirm_limits = true;
        self.state.limits_changed = false;
        self.state.pending_windows.clear();
        self.state.pending_epoch = None;
        if self.state.last_error == Some(Diag::LimitsChanged) {
            self.state.last_error = self.standing_diag();
        }
        true
    }

    /// A value with nothing of Gemini's in it but the boundary already known (a value without it would read as none). A switch seen
    /// here still says so: its queued observations go at once, as on any switch, saved or not
    fn held_snapshot(&self, why: &str) -> ProviderSnapshot {
        if self.state.account_changed {
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                Diag::AccountChanged.message(),
                Some(ErrorCode::AccountChanged),
            );
        }
        ProviderSnapshot {
            history_since: (self.state.account_accepted_ms > 0)
                .then(|| iso_from_ms(self.state.account_accepted_ms)),
            ..ProviderSnapshot::empty(ProviderStatus::Error, why, Some(ErrorCode::FetchFailed))
        }
    }

    fn refuse_acceptance(&mut self, why: &str) {
        self.accepted = Some(false);
        self.log.log(&format!("gemini: not accepted: {why}"));
    }

    /// The acceptance asked for (once): another account (`--accept-account`) or the same one with other limits (`--same-account`).
    /// Made only under a usable clock epoch and for what was shown before this collect (`moved`: the statusLine input changed it just
    /// now), saved at once by itself, and reported only as saved
    fn apply_acceptance(
        &mut self,
        now: i64,
        moved: bool,
        accept: bool,
        same: bool,
        target: Option<i64>,
    ) {
        if !self.state.account_changed && !self.state.limits_changed {
            return self.refuse_acceptance("nothing is waiting to be accepted");
        }
        if target != Some(switch_mark(&self.state, self.seen_changes)) {
            return self.refuse_acceptance(
                "what waits to be accepted changed since you asked. Check headroom status, then accept again",
            );
        }
        if self.epoch.is_none() {
            return self.refuse_acceptance("this PC's clock can't be used now");
        }
        if self.capture_unread {
            return self.refuse_acceptance("the statusLine record couldn't be read");
        }
        if moved {
            return self.refuse_acceptance(
                "the account shown changed just now. Check headroom status, then accept again",
            );
        }
        if self.state.account_changed && self.state.pending_hash_epoch != self.epoch {
            return self.refuse_acceptance(
                "the other account was seen before this PC's clock was refused. Use agy once in a terminal, then accept again",
            );
        }
        if same && !accept && self.state.account_changed {
            return self.refuse_acceptance(
                "another email was seen, so it can't be the same account (use --accept-account)",
            );
        }
        let before = self.state.clone();
        // Inputs read up to the acceptance are of the time before it: only one read after it is the next value. The generation is
        // raised under the writers' lock (held here), so the record now and any input a writer read before this point is of a
        // generation before (never taken; a writer still holding one doesn't save it). The time it was received isn't compared: an
        // input of the same millisecond after the acceptance is the next value
        let next_gen = read_accept_gen(&self.home).max(self.state.accept_gen) + 1;
        if let Err(e) = std::fs::write(self.home.join(ACCEPT_GEN_FILE), next_gen.to_string()) {
            return self.refuse_acceptance(&format!(
                "couldn't mark the acceptance for the statusLine ({})",
                e.kind()
            ));
        }
        self.state.accept_gen = next_gen;
        self.state.passive_seen_ms = None;
        self.state.passive_seen_epoch = None;
        if accept {
            self.state.account_accepted_ms = now;
            // Values of the account before are not shown or sent again, and its plan isn't this account's
            self.state.last_ok = None;
            self.state.plan = None;
            self.state.refetch = false;
            self.state.pending_hash_epoch = None;
            if let Some(h) = self.state.pending_hash.take() {
                // Another email: its limits are learned from its own first fetch
                self.state.account_hash = Some(h);
                self.state.known_windows.clear();
                self.state.awaiting_email = false;
            } else {
                // Other limits taken as another account whose email hasn't been seen: the next other email is this account
                self.state.known_windows = std::mem::take(&mut self.state.pending_windows);
                self.state.awaiting_email = true;
            }
        } else {
            // The same account: the values before stay, as old, until the next fetch (they put no fetch off)
            self.state.known_windows = std::mem::take(&mut self.state.pending_windows);
            self.state.refetch = true;
            self.state.passive_taken_ms = None;
        }
        self.state.pending_windows.clear();
        self.state.pending_epoch = None;
        self.state.account_changed = false;
        self.state.limits_changed = false;
        // A doubt kept from an earlier pause ends with the user's acceptance (also of another account), saved below
        self.state.confirm_limits = false;
        if matches!(
            self.state.last_error,
            Some(Diag::AccountChanged | Diag::LimitsChanged)
        ) {
            self.state.last_error = None;
        }
        match self.save() {
            Ok(()) => {
                self.accepted = Some(true);
                self.log.log(if accept {
                    "gemini: accepted the account and resumed fetching"
                } else {
                    "gemini: took the new limits as the same account's and resumed fetching"
                });
                if self.state.awaiting_email {
                    // The next input is written even if unchanged, and kept as the first after this acceptance: one of the account
                    // before ends the wait, another one is the account accepted
                    let mark = self.state.account_accepted_ms.to_string();
                    if let Err(e) = std::fs::write(self.home.join(CAPTURE_REFRESH_FILE), mark) {
                        self.log.log(&format!(
                            "gemini: couldn't ask for the next statusLine input: {}",
                            e.kind()
                        ));
                    }
                }
                if accept {
                    // The accepted account's plan, when its input is already here
                    self.refresh_account(now);
                }
            }
            Err(e) => {
                self.state = before;
                self.accepted = Some(false);
                self.log.log(&format!(
                    "gemini: couldn't save the account acceptance: {}",
                    e.kind()
                ));
            }
        }
    }

    /// Whether the go this collect was allowed by is no longer to be used (`now`: read after the state lock was waited for)
    fn deadline_passed(&self, now: i64) -> bool {
        self.fetch_deadline.is_some_and(|g| g.passed(now))
    }

    fn fetch_usage(&mut self, now: i64, bin: &Path) {
        let before = self.state.last_attempt_ms;
        self.state.last_attempt_ms = now;
        // Save "in flight" before launching. If it can't be saved, don't launch
        self.state.usage_in_flight_ms = Some(now);
        if self.save().is_err() {
            self.state.usage_in_flight_ms = None;
            self.state.failures = self.state.failures.saturating_add(1);
            self.state.last_error = Some(Diag::StateWriteFailed);
            self.log_diag("usage", Diag::StateWriteFailed);
            return;
        }
        let _ = std::fs::create_dir_all(self.home.join("gemini-cwd"));
        // The go checked again right before the launch, after the save (a sleep while saving): past it, nothing is launched
        let launch_now = self.clock.map_or(now, |clock| clock());
        if self.deadline_passed(launch_now) {
            self.state.usage_in_flight_ms = None;
            self.state.last_attempt_ms = before;
            let _ = self.save();
            self.log.log(
                "gemini: the fetch turn came too long ago; not fetched (asked again next round)",
            );
            return;
        }
        let seen = self.identity();
        let cwd = self.home.join("gemini-cwd");
        // From here the query may run: its outcome is unknown until checked below
        self.run = Some(super::Run::Unknown);
        let query_before = self.state.last_query_ms;
        self.state.last_query_ms = now;
        let raw = self.cli.usage(bin, &cwd);
        // The run said it used nothing: a panel that can't be read whole is an ordinary failure
        let result = raw.and_then(|data| parse_usage(&data));
        // What is reported is what was used: a value read whole (one left out below is a failure too), an ordinary failure, nothing
        // launched, or a run that can't be confirmed
        self.run = Some(match &result {
            Ok(_) => super::Run::Ran(super::Outcome::Ok),
            Err(UsageError::Retry(Diag::CliNotFound | Diag::CliStartFailed)) => {
                // Never launched: not a query (the backoff still counts the attempt)
                self.state.last_query_ms = query_before;
                super::Run::NotRun
            }
            // The service denied the account: shared with every PC (also beside a safety stop)
            Err(UsageError::Retry(Diag::AccessDenied))
            | Err(UsageError::Stop(Diag::AccessDeniedUnverified)) => {
                super::Run::Ran(super::Outcome::AccessDenied)
            }
            Err(UsageError::Retry(Diag::RateLimited)) => {
                super::Run::Ran(super::Outcome::RateLimited { retry_ms: None })
            }
            Err(UsageError::Retry(_)) => super::Run::Ran(super::Outcome::Failed),
            Err(UsageError::Stop(_)) => super::Run::Unknown,
        });
        let left_out = Some(super::Run::Ran(super::Outcome::Failed));
        // The result was checked (failed to launch, confirmed zero use, or safety-stopped), so clear the marker
        self.state.usage_in_flight_ms = None;
        // Used only in the clock epoch it started in and for the account it started with: an input that arrived meanwhile is taken
        // first. A safety stop holds either way
        let same_epoch = crate::clock::usable_epoch(&self.home) == self.epoch;
        // An input of the epoch before isn't taken (an acceptance must not rest on it)
        if same_epoch {
            self.refresh_account(now);
        }
        let same_account = !self.capture_unread && self.identity() == seen;
        match result {
            Ok(_) if !same_epoch => {
                self.run = left_out;
                self.log
                    .log("gemini: the clock state changed during the fetch: its result isn't used");
            }
            Ok(_) if !same_account => {
                self.run = left_out;
                self.log
                    .log("gemini: the account changed during the fetch: its result isn't used");
            }
            Ok((windows, shape)) => {
                if self.state.confirm_limits || self.limits_differ(&shape) {
                    // Other overall limits than this account's (or a doubt kept from an earlier pause): paused, and these values are
                    // neither shown nor sent until confirmed
                    self.state.limits_changed = true;
                    self.state.switch_seq += 1;
                    self.state.pending_windows = shape;
                    self.state.pending_epoch = self.epoch;
                    self.state.last_error = Some(Diag::LimitsChanged);
                    self.log_diag("usage", Diag::LimitsChanged);
                    self.run = left_out;
                    return;
                }
                // The limits of one model or of the other vendors' models that came or went are taken as they are
                self.state.known_windows = shape;
                self.state.last_ok = Some(Observation {
                    fetched_ms: now,
                    windows,
                    epoch: self.epoch,
                    accept_gen: self.state.accept_gen,
                });
                self.state.refetch = false;
                self.state.failures = 0;
                self.state.last_error = None;
                self.state.guard_tripped = false;
            }
            Err(UsageError::Retry(d)) => {
                self.state.failures = self.state.failures.saturating_add(1);
                if matches!(d, Diag::LoginRequired | Diag::ApiKey) {
                    // Signed out, or no plan: don't keep showing the previous values
                    self.state.last_ok = None;
                }
                self.state.last_error = Some(d);
                self.log_diag("usage", d);
            }
            Err(UsageError::Stop(d)) => {
                self.state.guard_tripped = true;
                self.state.last_error = Some(d);
                self.log_diag("usage (stopped by safety guard)", d);
            }
        }
    }

    fn build(&self, now: i64) -> ProviderSnapshot {
        let epoch = crate::clock::usable_epoch(&self.home);
        if self.state.account_changed {
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                Diag::AccountChanged.message(),
                Some(ErrorCode::AccountChanged),
            );
        }
        if self.state.account_hash.is_none() {
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                Diag::AccountUnidentified.message(),
                Some(ErrorCode::LoginRequired),
            );
        }
        let usage = self.state.last_ok.as_ref().filter(|u| {
            u.epoch.is_some()
                && u.epoch == epoch
                && u.fetched_ms <= now.saturating_add(AHEAD_SLACK_MS)
        });
        let diag = if self.state.guard_tripped {
            self.state
                .last_error
                .filter(|d| d.error_code() == ErrorCode::SafetyStop)
                .or(Some(Diag::Unverifiable))
        } else {
            self.state.last_error
        };
        let message = diag.map(|d| d.message().to_string());
        let error_code = diag.map(Diag::error_code);
        let history_since = (self.state.account_accepted_ms > 0)
            .then(|| iso_from_ms(self.state.account_accepted_ms));
        let plan = self.state.plan.clone();
        let Some(u) = usage else {
            return ProviderSnapshot {
                plan,
                history_since,
                ..ProviderSnapshot::empty(
                    match error_code {
                        Some(ErrorCode::LoginRequired | ErrorCode::NotInstalled) => {
                            ProviderStatus::Unavailable
                        }
                        _ => ProviderStatus::Error,
                    },
                    message.unwrap_or_else(|| "No value yet".into()),
                    error_code,
                )
            };
        };
        let age = now - u.fetched_ms;
        // Values of limits that changed (paused, or taken as the same account's and not fetched since) are shown as old, and say
        // nothing about a reached limit
        let outdated = self.state.limits_changed || self.state.refetch;
        // After a rate limit (429), the values before are shown as old, with their own time
        let fresh =
            age <= STALE_AFTER_MS && !outdated && self.state.last_error != Some(Diag::RateLimited);
        let blocked = (!outdated).then(|| {
            u.windows
                .iter()
                .any(|w| w.scope.is_none() && w.used_percent >= 100.0)
        });
        ProviderSnapshot {
            status: if fresh {
                ProviderStatus::Ok
            } else {
                ProviderStatus::Stale
            },
            fetched_at: Some(iso_from_ms(u.fetched_ms)),
            collector: None,
            error: if fresh {
                message
            } else {
                Some(message.unwrap_or_else(|| format!("Not updated for {}m", age / MINUTE_MS)))
            },
            error_code,
            plan,
            blocked,
            history_since,
            windows: u
                .windows
                .iter()
                .map(|w| w.clone().with_fetched_ms(u.fetched_ms))
                .collect(),
        }
    }
}

impl Provider for GeminiProvider {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn next_due_ms(&self, now: i64) -> i64 {
        // Turned off: never due (nothing of agy runs, its statusLine input isn't taken either)
        if self.cfg.enabled != Some(true) {
            return i64::MAX;
        }
        // A state that couldn't be read is read again a minute on: nothing is due before
        if let Some(at) = crate::time::reread_due(self.state_retry_at, now) {
            return at;
        }
        if self.capture_dirty {
            return now;
        }
        self.usage_due_ms(now).min(self.version_due_ms(now))
    }

    fn collect(&mut self, now: i64, force: bool) -> ProviderSnapshot {
        self.run = Some(super::Run::NotRun);
        // Asked for this collect only, and taken before anything can end it early: an acceptance never waits for a later one, and
        // one this collect doesn't make is reported as not made
        let accept = std::mem::take(&mut self.accept_pending);
        let same = std::mem::take(&mut self.same_pending);
        let target = self.accept_target.take();
        let confirmed = std::mem::take(&mut self.safety_confirmed);
        let asked = accept || same;
        self.accepted = asked.then_some(false);
        if self.cfg.enabled != Some(true) {
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                "Disabled in config",
                None,
            );
        }
        let Some(_lock) = FileLock::acquire(&self.home, LOCK_FILE, LOCK_WAIT) else {
            self.log
                .log("gemini: skipped this round: could not lock the state file");
            if asked {
                self.refuse_acceptance("the state file is locked");
            }
            // A state still unread is read again a minute on (not every second while the lock is held)
            if self.state_retry_at.is_some() {
                self.state_retry_at = Some(self.clock.map_or(now, |clock| clock()) + MINUTE_MS);
            }
            return self.build(now);
        };
        let state_path = self.home.join(STATE_FILE);
        let state_gone = !state_path.exists();
        let Some(state) = read_state(&state_path) else {
            // Can't be read now (an I/O error): nothing is run or written this round (the file keeps what it has). Read again a
            // minute on (said once until it can be read)
            if self.state_retry_at.is_none() {
                self.log
                    .log("gemini: skipped this round: could not read the state file (read again every minute)");
            }
            self.state_retry_at = Some(self.clock.map_or(now, |clock| clock()) + MINUTE_MS);
            self.saved_unread = true;
            if asked {
                self.refuse_acceptance("the state file couldn't be read");
            }
            return self.build(now);
        };
        self.saved_unread = false;
        self.state_retry_at = None;
        self.state = state;
        // A state that is gone starts again knowing the account it knew (another one seen is a switch)
        if state_gone && self.state.account_hash.is_none() {
            self.state.account_hash = crate::store::known_account(&self.home, "gemini");
        }
        // A generation file broken since the last acceptance is written again with this state's
        if crate::store::repair_gen_file(
            &self.home,
            ACCEPT_GEN_FILE,
            CAPTURE_LOCK_FILE,
            self.state.accept_gen,
        ) {
            self.log
                .log("gemini: the statusLine generation file was broken; written again");
        }
        self.epoch = crate::clock::usable_epoch(&self.home);
        let now = self.clock.map_or(now, |clock| clock());
        self.state.last_attempt_ms = self.state.last_attempt_ms.min(now);
        self.state.last_version_ms = self.state.last_version_ms.min(now);
        if self
            .state
            .last_ok
            .as_ref()
            .is_some_and(|o| o.fetched_ms > now)
        {
            self.state.last_ok = None;
        }
        if let Some(started) = self.state.usage_in_flight_ms.take() {
            // The previous process ended before checking the /usage result. Zero use can't be confirmed, so stop
            self.state.guard_tripped = true;
            self.state.last_error = Some(Diag::Interrupted);
            self.state.last_attempt_ms = self.state.last_attempt_ms.max(started);
            self.log_diag("usage (stopped by safety guard)", Diag::Interrupted);
        }
        self.drop_old_pause(self.epoch);
        // The account first (also while another PC is on duty or a limit is reached: no agy is started for it), then an acceptance:
        // one asked for what was shown before is refused if the input changed it just now. While accepting, the statusLine writers
        // wait (the record can't change between its reading and the acceptance's save)
        self.capture_unread = false;
        let writers = if asked {
            let lock = FileLock::acquire(&self.home, CAPTURE_LOCK_FILE, CAPTURE_ACCEPT_WAIT);
            if lock.is_none() {
                self.capture_unread = true;
            }
            lock
        } else {
            None
        };
        let seen = self.account_view();
        let record_before = self.seen_record_ms;
        self.refresh_account(now);
        let moved = self.account_view() != seen;
        if asked {
            self.apply_acceptance(now, moved, accept, same, target);
        }
        drop(writers);
        self.capture_dirty = false;
        // The limits Antigravity passed to the statusLine (no agy is started for them)
        self.take_passive();
        let bin = self.cli.locate();
        // A new record taken in this collect with no fetch allowed: the periodic version check waits for a collect with nothing new,
        // so this one starts no CLI (another executable is still checked before it could run)
        let took_record = self.seen_record_ms != record_before;
        let defer_periodic = took_record && self.fetch_deadline.is_none();
        if !self.passive_only {
            self.refresh_version(now, force, bin.as_deref(), defer_periodic);
        }
        let allowed = !self.passive_only
            && self.epoch.is_some()
            && self.state.cli_supported == Some(true)
            && bin.is_some()
            && self.checked_bin == bin.as_deref().map(bin_id)
            && !self.capture_unread
            && self.state.account_hash.is_some()
            && !self.state.account_changed
            && !self.state.limits_changed
            // Past a safety stop only on the user's explicit --force (checked on the state read under the lock, so a stop restored
            // just now counts)
            && (confirmed || !self.state.guard_tripped);
        if let Some(bin) = bin.filter(|_| allowed && (force || self.usage_due_ms(now) <= now)) {
            if self.deadline_passed(now) {
                self.log
                    .log("gemini: the fetch turn came too long ago; not fetched (asked again next round)");
            } else {
                self.fetch_usage(now, &bin);
            }
        }
        self.unsaved = match write_json_atomic(&state_path, &self.state) {
            Ok(()) => {
                // The account accepted (one switched to waits until accepted)
                if !self.state.account_changed
                    && !crate::store::keep_account(
                        &self.home,
                        "gemini",
                        self.state.account_hash.as_deref(),
                    )
                {
                    self.log.log(
                        "gemini: couldn't keep the account beside the state (kept at the next save)",
                    );
                }
                false
            }
            Err(e) => {
                self.log
                    .log(&format!("gemini: failed to save state: {}", e.kind()));
                // A value that couldn't be kept isn't a success to share (no lease, no resume, no end of a rate limit)
                if self.run == Some(super::Run::Ran(super::Outcome::Ok)) {
                    self.run = Some(super::Run::Ran(super::Outcome::Failed));
                }
                true
            }
        };
        self.build(now)
    }

    fn account_accepted(&self) -> Option<bool> {
        self.accepted
    }

    fn fetch_due_ms(&self, now: i64) -> i64 {
        // No turn is asked for while the state can't be read: it is read again first (its own collect), and only a read that succeeds
        // lets a fetch be due again
        if self.state_retry_at.is_some() {
            return i64::MAX;
        }
        self.usage_due_ms(now)
    }

    fn hold_fetch_until(&mut self, until_ms: i64) -> bool {
        self.fetch_hold_until_ms = until_ms;
        true
    }

    fn takes_passive_values(&self) -> bool {
        true
    }

    fn forget_cached(&mut self) -> bool {
        let state_path = self.home.join(STATE_FILE);
        // Nothing saved on this PC: nothing cached to forget, and nothing is made (not even the lock)
        if matches!(std::fs::symlink_metadata(&state_path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
        {
            self.state = state_from(Err(std::io::ErrorKind::NotFound.into()));
            return true;
        }
        let Some(_lock) = FileLock::acquire(&self.home, LOCK_FILE, LOCK_WAIT) else {
            return false;
        };
        let Some(state) = read_state(&state_path) else {
            self.log
                .log("gemini: couldn't read the state to forget the cached values");
            self.state_retry_at =
                Some(self.clock.map_or_else(crate::time::now_ms, |clock| clock()) + MINUTE_MS);
            return false;
        };
        self.state = state;
        // The epoch usable now; when it can't be told (the state can't be read now, or a send's result is pending), tried later
        let current = match crate::clock::clock_epoch(&self.home) {
            crate::clock::EpochRead::Read {
                epoch,
                trusted: true,
                in_flight: None,
            } => Some(epoch),
            crate::clock::EpochRead::Read {
                trusted: false,
                in_flight: None,
                ..
            } => None,
            _ => return false,
        };
        let stale = self
            .state
            .last_ok
            .as_ref()
            .is_some_and(|o| o.epoch.is_none() || o.epoch != current);
        if stale {
            self.state.last_ok = None;
        }
        let dropped = self.drop_old_pause(current);
        if !stale && !dropped {
            return true;
        }
        match write_json_atomic(&state_path, &self.state) {
            Ok(()) => true,
            Err(e) => {
                self.log
                    .log(&format!("gemini: couldn't save the state: {}", e.kind()));
                false
            }
        }
    }

    fn last_fetch_attempt_ms(&self) -> Option<i64> {
        Some(self.state.last_query_ms).filter(|&t| t > 0)
    }

    fn on_event(&mut self, event: &Event) {
        if matches!(event, Event::GeminiStatuslineCaptured) {
            self.capture_dirty = true;
        }
    }

    fn accept_account(&mut self) {
        self.accept_pending = true;
    }

    fn tracks_limits(&self) -> bool {
        true
    }

    fn last_passive(&self) -> Option<super::Passive> {
        self.state
            .last_ok
            .as_ref()
            .filter(|o| self.state.passive_taken_ms == Some(o.fetched_ms))
            .map(|o| super::Passive {
                at_ms: o.fetched_ms,
                windows: o.windows.iter().map(|w| w.id.clone()).collect(),
            })
    }

    fn passive_mark(&self) -> Option<i64> {
        self.seen_record_ms
    }

    fn state_retry_at(&self) -> Option<i64> {
        self.state_retry_at
    }

    fn passive_pending(&self) -> bool {
        // Not while the state can't be read: it is read again on its own time, not on each event
        self.capture_dirty && self.state_retry_at.is_none()
    }

    fn take_passive(&mut self, now: i64) -> Option<ProviderSnapshot> {
        self.passive_only = true;
        let snapshot = self.collect(now, false);
        self.passive_only = false;
        self.run = None;
        Some(snapshot)
    }

    fn take_run(&mut self) -> Option<super::Run> {
        self.run.take()
    }

    fn fetch_deadline(&mut self, until_ms: Option<i64>) {
        self.fetch_deadline = until_ms.map(|until_ms| super::Grant {
            until_ms,
            until: std::time::Instant::now()
                + std::time::Duration::from_millis(crate::schedule::GRANT_VALID_MS as u64),
        });
    }

    fn grant(&mut self, grant: Option<super::Grant>) {
        self.fetch_deadline = grant;
    }

    fn safety_stopped(&self) -> bool {
        // As saved: also an attempt left in flight (it becomes a safety stop when next read)
        let saved = load_state(&self.home.join(STATE_FILE));
        saved.guard_tripped || saved.usage_in_flight_ms.is_some()
    }

    fn confirm_safety(&mut self, yes: bool) {
        self.safety_confirmed = yes;
    }

    fn pending_switch(&self) -> Option<i64> {
        let saved = load_state(&self.home.join(STATE_FILE));
        let changes = read_capture_in(&self.home, crate::clock::usable_epoch(&self.home))
            .ok()
            .flatten()
            .map(|c| c.changes);
        (saved.account_changed || saved.limits_changed).then(|| switch_mark(&saved, changes))
    }

    fn accept_target(&mut self, target: Option<i64>) {
        self.accept_target = target;
    }

    fn confirm_same_account(&mut self) {
        self.same_pending = true;
    }

    fn sync_saved(&mut self, now: i64) -> Option<ProviderSnapshot> {
        if self.cfg.enabled != Some(true) {
            return None;
        }
        // This process couldn't save what it found (a switch, a pause, a result): the saved state is older and isn't taken, and
        // nothing of Gemini goes out (its values or its queued observations) until a collect saves
        if self.unsaved {
            return Some(self.held_snapshot("The Gemini state couldn't be saved"));
        }
        // While the state can't be read, it is read again on its own time, not before each send
        if crate::time::rereads_later(self.state_retry_at, now) {
            return Some(self.held_snapshot("The Gemini state can't be read now"));
        }
        let Some(saved) = read_state(&self.home.join(STATE_FILE)) else {
            // What it says now can't be told: nothing of Gemini goes out until it can, and it is read again a minute on
            self.saved_unread = true;
            if self.state_retry_at.is_none() {
                self.log.log(
                    "gemini: could not read the state file before a send (read again every minute)",
                );
            }
            self.state_retry_at = Some(self.clock.map_or(now, |clock| clock()) + MINUTE_MS);
            return Some(self.held_snapshot("The Gemini state can't be read now"));
        };
        let was_unread = std::mem::replace(&mut self.saved_unread, false);
        if saved == self.state && !was_unread {
            return None;
        }
        self.state = saved;
        Some(self.build(now))
    }

    fn holds_queue(&self) -> bool {
        // Waiting for the user's choice, for a state that can be read or saved, for the result of a fetch (another process's, or one
        // whose result couldn't be saved), or for the account after a lost state
        self.cfg.enabled == Some(true)
            && (self.saved_unread
                || self.unsaved
                || self.state.usage_in_flight_ms.is_some()
                || self.state.recover_identity
                || self.state.limits_changed
                || self.state.account_changed)
    }
}

/// Writes a saved state of this version, changed by `edit` (for other modules' tests)
#[cfg(test)]
pub(crate) fn save_test_state(home: &Path, edit: impl FnOnce(&mut GeminiState)) {
    let mut state = GeminiState {
        state_version: STATE_VERSION,
        ..Default::default()
    };
    edit(&mut state);
    std::fs::write(home.join(STATE_FILE), serde_json::to_vec(&state).unwrap()).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const NOW: i64 = 1_795_224_000_000;

    fn home(name: &str) -> crate::test_util::TempHome {
        let h = crate::test_util::TempHome::new(&format!("headroom-gemini-{name}"));
        crate::test_util::trust_clock(&h);
        h
    }

    fn fixture(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/gemini")
            .join(name);
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    type During = Box<dyn FnMut() + Send>;

    #[derive(Default)]
    struct Calls {
        versions: u32,
        usages: u32,
        version: Option<Result<String, Diag>>,
        /// Versions per executable (others: `version`, or 1.5.13)
        version_of: Vec<(PathBuf, String)>,
        replies: Vec<Result<Value, Diag>>,
        /// The executable found (default: agy-test; Some(None): none)
        bin: Option<Option<PathBuf>>,
        /// Executables /usage ran with
        ran: Vec<PathBuf>,
        /// Run while /usage runs (an input or a refusal arriving meanwhile)
        during: Option<During>,
    }

    #[derive(Clone, Default)]
    struct Fake(Arc<Mutex<Calls>>);

    impl GeminiCli for Fake {
        fn locate(&self) -> Option<PathBuf> {
            let c = self.0.lock().unwrap();
            c.bin
                .clone()
                .unwrap_or_else(|| Some(PathBuf::from("agy-test")))
        }
        fn version(&mut self, bin: &Path) -> Result<String, Diag> {
            let mut c = self.0.lock().unwrap();
            c.versions += 1;
            if let Some((_, v)) = c.version_of.iter().find(|(p, _)| p == bin) {
                return Ok(v.clone());
            }
            c.version.clone().unwrap_or(Ok("1.5.13".into()))
        }
        fn usage(&mut self, bin: &Path, _cwd: &Path) -> Result<Value, UsageError> {
            let during = {
                let mut c = self.0.lock().unwrap();
                c.usages += 1;
                c.ran.push(bin.to_path_buf());
                c.during.take()
            };
            if let Some(mut f) = during {
                f();
            }
            let mut c = self.0.lock().unwrap();
            let reply = if c.replies.is_empty() {
                Ok(fixture("usage-pro.json"))
            } else {
                c.replies.remove(0)
            };
            // A reply as the run gives it: a printed result, checked as the real one is, or a failure (a safety-stop one stops)
            match reply {
                Ok(v) => check_usage_result(&v, Some(0)),
                Err(d) if d.error_code() == ErrorCode::SafetyStop => Err(UsageError::Stop(d)),
                Err(d) => Err(UsageError::Retry(d)),
            }
        }
    }

    impl Fake {
        fn usages(&self) -> u32 {
            self.0.lock().unwrap().usages
        }
        fn reply(&self, replies: Vec<Result<Value, Diag>>) {
            self.0.lock().unwrap().replies = replies;
        }
    }

    fn provider(h: &Path, fake: &Fake) -> GeminiProvider {
        let cfg = GeminiConfig {
            enabled: Some(true),
            ..GeminiConfig::default()
        };
        GeminiProvider::with_cli(h, cfg, Logger::stderr(), Box::new(fake.clone()))
    }

    /// A statusLine writer now: notes the acceptance generation before its input, as `headroom statusline --gemini` does (one that
    /// read an older generation calls super::save_capture with it)
    fn save_capture(h: &Path, cap: &Capture) -> std::io::Result<bool> {
        let mut cap = cap.clone();
        cap.accept_gen = read_accept_gen(h);
        super::save_capture(h, &cap)
    }

    fn identify_as(h: &Path, email: &str, tier: &str, at: i64) {
        let cap = capture_from_input(
            &serde_json::json!({"email": email, "plan_tier": tier}),
            at,
            crate::clock::usable_epoch(h),
        )
        .unwrap();
        save_capture(h, &cap).unwrap();
    }

    fn identify(h: &Path, email: &str, at: i64) {
        identify_as(h, email, "Google AI Pro", at);
    }

    fn ids(s: &ProviderSnapshot) -> Vec<String> {
        s.windows.iter().map(|w| w.id.clone()).collect()
    }

    fn refuse_clock(h: &Path) {
        let _lock = crate::clock::hold_clock_lock(h).unwrap();
        let state = crate::clock::ensure_locked(h, || Ok(false)).unwrap();
        crate::clock::advance_locked(h, &state, false).unwrap();
    }

    fn lift_refusal(h: &Path) {
        let _lock = crate::clock::hold_clock_lock(h).unwrap();
        let state = crate::clock::ensure_locked(h, || Ok(false)).unwrap();
        crate::clock::advance_locked(h, &state, true).unwrap();
    }

    fn out(stdout: &str, stderr: &str, code: Option<i32>) -> Result<RunOutput, RunError> {
        Ok(RunOutput {
            stdout: stdout.into(),
            stderr: stderr.into(),
            code,
            complete: true,
        })
    }

    #[test]
    fn parses_the_real_usage_output_into_known_windows() {
        let data = fixture("usage-pro.json")["command"]["data"].clone();
        let (windows, shape) = parse_usage(&data).ok().unwrap();
        let five = windows.iter().find(|w| w.id == "five_hour").unwrap();
        assert_eq!(five.used_percent, 1.0);
        assert_eq!(five.resets_at.as_deref(), Some("2026-11-21T05:35:24.000Z"));
        assert_eq!(five.scope, None);
        let argon = windows.iter().find(|w| w.id == "seven_day_argon").unwrap();
        assert_eq!(argon.scope.as_deref(), Some("Argon"));
        assert_eq!(argon.resets_at, None, "unused: no reset time");
        let partner = windows
            .iter()
            .find(|w| w.id == "partner_seven_day")
            .unwrap();
        assert_eq!(partner.scope.as_deref(), Some("Claude and GPT"));
        assert_eq!(
            shape,
            [
                "five_hour",
                "partner_five_hour",
                "partner_seven_day",
                "seven_day",
                "seven_day_argon"
            ]
        );
        // every window may leave the PC as Gemini's, and the Gemini names only as Gemini's
        assert!(windows.iter().all(|w| w.for_upload_in("gemini").is_some()));
        assert!(argon.for_upload_in("codex").is_none());
        assert!(partner.for_upload().is_none());
        // a free plan shows the weekly limits only: another shape
        let free = fixture("usage-free.json")["command"]["data"].clone();
        assert_eq!(
            parse_usage(&free).ok().unwrap().1,
            ["partner_seven_day", "seven_day"]
        );
    }

    #[test]
    fn unknown_limits_are_left_out_and_a_result_not_read_whole_is_not_used() {
        let bucket = |id: &str, remaining: Value| serde_json::json!({"id": id, "window": "weekly", "remaining_fraction": remaining, "reset_time": "2026-11-28T00:35:24Z"});
        let data = |buckets: Vec<Value>| serde_json::json!({"groups": [{"buckets": buckets}]});
        let (windows, shape) = parse_usage(&data(vec![
            bucket("gemini-weekly", serde_json::json!(0.9972)),
            bucket("gemini-carbon-wtu-weekly", serde_json::json!(0.2)),
            bucket("gemini-carbon-wtu-weekly", serde_json::json!("x")),
        ]))
        .ok()
        .unwrap();
        assert_eq!(shape, ["seven_day"], "an unknown limit is left out");
        assert_eq!(windows[0].used_percent, 0.3);
        assert!(
            windows[0].resets_at.is_some(),
            "0.9972 is in use: its reset time stays"
        );
        // a known limit with a bad value, shown twice, a limit without an id, a group without its list: none of the round is used
        for bad in [
            data(vec![
                bucket("gemini-weekly", serde_json::json!(0.5)),
                bucket("gemini-5h", serde_json::json!("0.5")),
            ]),
            data(vec![
                bucket("gemini-weekly", serde_json::json!(0.5)),
                bucket("3p-5h", serde_json::json!(1.5)),
            ]),
            data(vec![
                bucket("gemini-weekly", serde_json::json!(0.5)),
                bucket("gemini-weekly", serde_json::json!(0.4)),
            ]),
            data(vec![
                bucket("gemini-weekly", serde_json::json!(0.5)),
                serde_json::json!({"remaining_fraction": 0.5}),
            ]),
            data(vec![
                bucket("gemini-weekly", serde_json::json!(0.5)),
                bucket(" ", serde_json::json!(0.5)),
            ]),
            serde_json::json!({"groups": [{"buckets": [bucket("gemini-weekly", serde_json::json!(0.5))]}, {"name": "x"}]}),
            serde_json::json!({"groups": []}),
        ] {
            assert!(
                matches!(
                    parse_usage(&bad),
                    Err(UsageError::Retry(Diag::UnrecognizedOutput))
                ),
                "{bad}"
            );
        }
        // anything left is never shown as reached
        let (w, _) = parse_usage(&data(vec![bucket(
            "gemini-weekly",
            serde_json::json!(0.0004),
        )]))
        .ok()
        .unwrap();
        assert_eq!(w[0].used_percent, 99.9);
        let (w, _) = parse_usage(&data(vec![bucket("gemini-weekly", serde_json::json!(0))]))
            .ok()
            .unwrap();
        assert_eq!(w[0].used_percent, 100.0);
    }

    /// The statusLine input's `quota` made from a fixture's /usage buckets (the same limits, as Antigravity passes them)
    fn quota_of(name: &str) -> Value {
        let data = fixture(name)["command"]["data"].clone();
        let mut q = serde_json::Map::new();
        for b in data["groups"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["buckets"].as_array().unwrap().clone())
        {
            q.insert(
                b["id"].as_str().unwrap().to_string(),
                serde_json::json!({"remaining_fraction": b["remaining_fraction"], "reset_time": b["reset_time"], "reset_in_seconds": 60}),
            );
        }
        Value::Object(q)
    }

    fn statusline(h: &Path, email: &str, quota: Option<Value>, at: i64) {
        let mut input = serde_json::json!({"email": email, "plan_tier": "Google AI Pro", "version": "1.5.13",
            "conversation_id": "c-1", "cwd": "/x", "transcript_path": "/x/t"});
        if let Some(q) = quota {
            input["quota"] = q;
        }
        let cap = capture_from_input(&input, at, crate::clock::usable_epoch(h)).unwrap();
        save_capture(h, &cap).unwrap();
    }

    #[test]
    fn the_statusline_quota_keeps_only_limits_and_refuses_a_partial_one() {
        let q = quota_of("usage-pro.json");
        let (data, disabled) = quota_from_input(&serde_json::json!({"quota": q}), NOW).unwrap();
        let (windows, shape) = parse_usage(&data).ok().unwrap();
        assert_eq!(shape.len(), 5);
        assert!(disabled.is_empty());
        assert_eq!(
            windows
                .iter()
                .find(|w| w.id == "five_hour")
                .unwrap()
                .used_percent,
            1.0
        );
        // a known limit turned off: left out of the values, kept as part of the set
        let mut off = q.clone();
        off["3p-5h"] = serde_json::json!({"disabled": true});
        let (data, disabled) = quota_from_input(&serde_json::json!({"quota": off}), NOW).unwrap();
        assert_eq!(disabled, ["partner_five_hour"]);
        assert_eq!(parse_usage(&data).ok().unwrap().1.len(), 4);
        // a known limit given as an amount, or with a bad value: the whole input isn't used; unknown and odd ids are left out
        let mut amount = q.clone();
        amount["gemini-5h"] = serde_json::json!({"remaining_amount": 30});
        assert!(quota_from_input(&serde_json::json!({"quota": amount}), NOW).is_none());
        let mut odd = q.clone();
        odd["new-limit"] = serde_json::json!({"remaining_amount": 3});
        odd["bad id!"] = serde_json::json!({"remaining_fraction": 0.5});
        assert!(quota_from_input(&serde_json::json!({"quota": odd}), NOW).is_some());
        assert!(quota_from_input(&serde_json::json!({"quota": {}}), NOW).is_none());
        assert!(quota_from_input(&serde_json::json!({}), NOW).is_none());
        // only the hash, plan, limits and version are kept: nothing of the conversation, paths or the email
        let h = home("statusline-kept");
        statusline(&h, "a@example.com", Some(q), NOW);
        let text = std::fs::read_to_string(h.join(CAPTURE_FILE)).unwrap();
        for absent in ["a@example.com", "c-1", "transcript", "/x"] {
            assert!(!text.contains(absent), "{absent}");
        }
        assert!(text.contains("1.5.13"));
    }

    #[test]
    fn the_statusline_limits_are_taken_as_values_without_starting_agy() {
        let h = home("passive-values");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        // another PC is on duty: no fetch, but the statusLine values are taken
        p.hold_fetch_until(NOW + 60 * MINUTE_MS);
        let s = p.collect(NOW + MINUTE_MS, false);
        assert_eq!(fake.usages(), 0);
        assert_eq!(s.status, ProviderStatus::Ok);
        assert_eq!(
            s.fetched_at.as_deref(),
            Some(iso_from_ms(NOW).as_str()),
            "the time it was received"
        );
        assert_eq!(ids(&s).len(), 5);
        // an input without limits keeps the last ones (a partial input doesn't break the value)
        statusline(&h, "a@example.com", None, NOW + 2 * MINUTE_MS);
        let rec = read_json::<Capture>(&h.join(CAPTURE_FILE)).unwrap();
        assert!(rec.quota.is_some());
        // newer limits replace the value; a fetch's value newer than them is kept
        let mut q = quota_of("usage-pro.json");
        q["gemini-5h"]["remaining_fraction"] = serde_json::json!(0.5);
        statusline(&h, "a@example.com", Some(q), NOW + 3 * MINUTE_MS);
        let s = p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(
            s.windows
                .iter()
                .find(|w| w.id == "five_hour")
                .unwrap()
                .used_percent,
            50.0
        );
        p.hold_fetch_until(0);
        p.collect(NOW + 20 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 1);
        let fetched = p.state.last_ok.clone();
        p.on_event(&Event::GeminiStatuslineCaptured);
        p.collect(NOW + 21 * MINUTE_MS, false);
        assert_eq!(
            p.state.last_ok, fetched,
            "the older statusLine values don't replace the fetch"
        );
    }

    #[test]
    fn statusline_limits_follow_the_account_and_the_set_of_limits() {
        let h = home("passive-guards");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        // a known limit turned off still counts in the set: no pause, and its window isn't shown
        let mut off = quota_of("usage-pro.json");
        off["3p-5h"] = serde_json::json!({"disabled": true});
        statusline(&h, "a@example.com", Some(off), NOW + 2 * MINUTE_MS);
        let s = p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert!(!ids(&s).contains(&"partner_five_hour".to_string()));
        // a model's own limit gone (Argon's, as on 2026-11-23): taken as it is, no pause
        let mut gone = quota_of("usage-pro.json");
        gone.as_object_mut()
            .unwrap()
            .remove("gemini-argon-wtu-weekly");
        statusline(
            &h,
            "a@example.com",
            Some(gone),
            NOW + 3 * MINUTE_MS + 10_000,
        );
        let s = p.collect(NOW + 3 * MINUTE_MS + 20_000, false);
        assert!(!p.state.limits_changed);
        assert!(!ids(&s).contains(&"seven_day_argon".to_string()));
        // other limits: paused, as from a fetch
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 4 * MINUTE_MS,
        );
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        // another account's limits: a switch, and its values aren't taken
        let h2 = home("passive-switch");
        statusline(&h2, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p2 = provider(&h2, &fake);
        p2.hold_fetch_until(i64::MAX);
        p2.collect(NOW + MINUTE_MS, false);
        statusline(
            &h2,
            "b@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        let s = p2.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(s.error_code, Some(ErrorCode::AccountChanged));
        assert!(p2.state.last_ok.is_none());
        assert_eq!(fake.usages(), 0);
    }

    #[test]
    fn on_by_default_only_windows_11_and_only_the_versions_verified_for_it_also_after_an_update() {
        let key = |build: &str, kind: &str| {
            format!(
                "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\r\n    CurrentBuild    REG_SZ    1\r\n    CurrentBuildNumber    REG_SZ    {build}\r\n    InstallationType    REG_SZ    {kind}\r\n    ProductName    REG_SZ    Windows 10 Home\r\n"
            )
        };
        assert!(
            verified_windows(&key("26300", "Client")),
            "Windows 11 (its ProductName still says 10)"
        );
        assert!(verified_windows(&key("22000", "Client")));
        assert!(!verified_windows(&key("19045", "Client")), "Windows 10");
        assert!(
            !verified_windows(&key("26100", "Server")),
            "Windows Server 2025"
        );
        assert!(!verified_windows(&key("26100", "Server Core")));
        assert!(
            !verified_windows("    CurrentBuildNumber    REG_SZ    26300"),
            "no installation type"
        );
        assert!(
            !verified_windows("    InstallationType    REG_SZ    Client"),
            "no build"
        );
        assert!(!verified_windows("nothing"));
        assert!(verified_version("1.5.14", true));
        assert!(
            !verified_version("1.5.15", true),
            "on by default: only a version verified for it"
        );
        assert!(
            verified_version("1.5.15", false),
            "turned on in config.toml: guards verified from 1.5.13"
        );
        assert!(!verified_version("1.5.12", false));
        // on by default, and agy updated to a version not verified for it while the agent runs: no /usage
        let h = home("default-update");
        let fake = Fake::default();
        fake.0.lock().unwrap().version = Some(Ok("1.5.15".into()));
        identify(&h, "a@example.com", NOW);
        let cfg = GeminiConfig {
            enabled: Some(true),
            by_default: true,
            ..GeminiConfig::default()
        };
        let mut p =
            GeminiProvider::with_cli(&h, cfg.clone(), Logger::stderr(), Box::new(fake.clone()));
        p.collect(NOW, true);
        assert_eq!(fake.usages(), 0, "nothing run");
        assert_eq!(p.state.cli_supported, Some(false));
        // the guidance: turn it on in config.toml (an update wouldn't make it one checked for being on by default)
        assert_eq!(p.state.last_error, Some(Diag::UnverifiedDefault));
        assert!(Diag::UnverifiedDefault.message().contains("enabled = true"));
        assert_eq!(Diag::UnverifiedDefault.error_code(), ErrorCode::FetchFailed);
        // older than the verified guards: an update
        let old = home("default-old");
        let fake = Fake::default();
        fake.0.lock().unwrap().version = Some(Ok("1.5.12".into()));
        identify(&old, "a@example.com", NOW);
        let mut p = GeminiProvider::with_cli(&old, cfg, Logger::stderr(), Box::new(fake.clone()));
        p.collect(NOW, true);
        assert_eq!(
            (fake.usages(), p.state.last_error),
            (0, Some(Diag::UnsupportedCli))
        );
    }

    #[test]
    fn gemini_is_on_by_default_only_with_a_verified_agy_on_a_verified_os() {
        let run =
            |verified_os: bool, bin: Option<Option<PathBuf>>, version: Result<String, Diag>| {
                let fake = Fake::default();
                {
                    let mut c = fake.0.lock().unwrap();
                    c.bin = bin;
                    c.version = Some(version);
                }
                let on = default_on(&mut fake.clone(), verified_os);
                let c = fake.0.lock().unwrap();
                (on, c.versions, c.usages)
            };
        // the verified version on a verified OS: on, after one version check and nothing else
        assert_eq!(run(true, None, Ok("1.5.14".into())), (true, 1, 0));
        // another version (older, newer, or one whose guards were checked but not the whole fetch): off
        for v in ["1.5.13", "1.5.15", "1.6.0"] {
            assert_eq!(run(true, None, Ok(v.into())), (false, 1, 0), "{v}");
        }
        assert!(!run(true, None, Err(Diag::UnrecognizedOutput)).0);
        // no agy, or an OS not verified: off with nothing launched
        assert_eq!(run(true, Some(None), Ok("1.5.14".into())), (false, 0, 0));
        assert_eq!(run(false, None, Ok("1.5.14".into())), (false, 0, 0));
    }

    #[test]
    fn nothing_of_agy_runs_while_gemini_is_turned_off() {
        let h = home("off");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        // left out of config.toml: off until the agent decides it at its start, and nothing runs meanwhile
        let cfg = GeminiConfig::default();
        assert_eq!(cfg.enabled, None);
        let mut p = GeminiProvider::with_cli(&h, cfg, Logger::stderr(), Box::new(fake.clone()));
        p.on_event(&Event::GeminiStatuslineCaptured);
        let s = p.collect(NOW, true);
        assert_eq!(s.status, ProviderStatus::Unavailable);
        assert_eq!(p.next_due_ms(NOW + MINUTE_MS), i64::MAX, "never due");
        assert_eq!(p.usage_due_ms(NOW + MINUTE_MS), i64::MAX);
        let c = fake.0.lock().unwrap();
        assert_eq!((c.versions, c.usages), (0, 0));
        assert!(
            !h.join(STATE_FILE).exists(),
            "not even its state is touched"
        );
    }

    #[test]
    fn only_a_result_that_says_nothing_was_used_passes() {
        let ok = fixture("usage-pro.json");
        assert!(check_usage_result(&ok, Some(0)).is_ok());
        let with = |path: &[&str], v: Value| {
            let mut x = ok.clone();
            let mut at = &mut x;
            for p in &path[..path.len() - 1] {
                at = at.get_mut(*p).unwrap();
            }
            at[path[path.len() - 1]] = v;
            x
        };
        for bad in [
            with(&["num_turns"], serde_json::json!(1)),
            with(&["num_turns"], serde_json::json!("0")),
            with(&["usage", "total_tokens"], serde_json::json!(12)),
            with(&["usage", "total_tokens"], serde_json::json!("0")),
            with(&["usage", "input_tokens"], serde_json::json!(3)),
            with(&["usage", "thinking_tokens"], serde_json::json!("0")),
            with(&["usage", "cache_read_tokens"], serde_json::json!(0.5)),
            with(&["usage", "input_tokens"], Value::Null),
            with(&["usage", "output_tokens"], serde_json::json!({})),
            with(&["usage", "per_model"], serde_json::json!({"x": null})),
            with(&["command", "name"], serde_json::json!("model")),
            with(&["conversation_id"], serde_json::json!("abc")),
            with(&["status"], serde_json::json!(5)),
            with(&["status"], serde_json::json!("CANCELLED")),
        ] {
            assert!(matches!(
                check_usage_result(&bad, Some(0)),
                Err(UsageError::Stop(Diag::Unverifiable))
            ));
        }
        let mut no_usage = ok.clone();
        no_usage.as_object_mut().unwrap().remove("usage");
        assert!(matches!(
            check_usage_result(&no_usage, Some(0)),
            Err(UsageError::Stop(_))
        ));
        // a success that then exits with an error: can't be confirmed
        assert!(matches!(
            check_usage_result(&ok, Some(1)),
            Err(UsageError::Stop(_))
        ));
        assert!(matches!(
            check_usage_result(&ok, None),
            Err(UsageError::Stop(_))
        ));
        // the documented failure is an ordinary one, told by its error
        let failed = |error: &str| serde_json::json!({"status": "ERROR", "num_turns": 0, "usage": {"total_tokens": 0}, "conversation_id": "", "error": error});
        assert!(matches!(
            check_usage_result(&failed("GEMINI_API_KEY has no account quota"), Some(2)),
            Err(UsageError::Retry(Diag::ApiKey))
        ));
        assert!(matches!(
            check_usage_result(&failed("not logged in"), Some(1)),
            Err(UsageError::Retry(Diag::LoginRequired))
        ));
        assert!(matches!(
            check_usage_result(&failed("the API key text, not exit 2"), Some(1)),
            Err(UsageError::Retry(Diag::FetchFailed))
        ));
        assert!(matches!(
            check_usage_result(&failed("network unreachable"), Some(1)),
            Err(UsageError::Retry(Diag::FetchFailed))
        ));
        // a failure that used something, names a conversation, isn't the documented one or exits 0: a stop
        let mut used = failed("x");
        used["num_turns"] = serde_json::json!(1);
        let mut talked = failed("x");
        talked["conversation_id"] = serde_json::json!("c-1");
        let mut unknown = failed("x");
        unknown["status"] = serde_json::json!("FAILED");
        for (bad, code) in [
            (used, Some(1)),
            (talked, Some(1)),
            (unknown, Some(1)),
            (failed("x"), Some(0)),
        ] {
            assert!(matches!(
                check_usage_result(&bad, code),
                Err(UsageError::Stop(_))
            ));
        }
    }

    #[test]
    fn a_run_is_told_by_its_output_its_error_output_and_its_exit_code() {
        let ok = fixture("usage-pro.json").to_string();
        assert!(classify_usage_output(out(&ok, "", Some(0))).is_ok());
        assert!(matches!(
            classify_usage_output(out(&ok, "", Some(1))),
            Err(UsageError::Stop(Diag::Unverifiable))
        ));
        // nothing printed: only the documented API key exit is an ordinary failure; a sign-in text on the error output can't show that
        // no turn ran (its real text isn't confirmed), so it stops
        assert!(matches!(
            classify_usage_output(out("", "Error: not logged in. Run agy", Some(1))),
            Err(UsageError::Stop(Diag::Unverifiable))
        ));
        assert!(matches!(
            classify_usage_output(out(
                "",
                "the model answered part of it\ntoken expired",
                Some(1)
            )),
            Err(UsageError::Stop(Diag::Unverifiable))
        ));
        // not even the API key exit: its exact text isn't confirmed, so an error output alone stops
        assert!(matches!(
            classify_usage_output(out("", "Use Google AI Studio for usage", Some(2))),
            Err(UsageError::Stop(Diag::Unverifiable))
        ));
        // a crash (its trace may name sign-in code), words of sign-in that don't say it failed, an unknown failure, a clean exit
        // without output: stops
        for (stderr, code) in [
            (
                "panic: runtime error\ngoroutine 1 [running]:\noauth2.(*Token)",
                Some(2),
            ),
            ("fatal error: concurrent map writes\nnot signed in", Some(1)),
            (
                "OAuth authenticated successfully\nError: request failed",
                Some(1),
            ),
            (
                "Successfully re-authenticated\nError: request failed",
                Some(1),
            ),
            (
                "Signed in successfully, but not signed in to the project",
                Some(1),
            ),
            ("something went wrong", Some(1)),
            ("not logged in", Some(0)),
            ("not logged in", None),
        ] {
            assert!(matches!(
                classify_usage_output(out("", stderr, code)),
                Err(UsageError::Stop(Diag::Unverifiable))
            ));
        }
        assert!(matches!(
            classify_usage_output(out("{\"status\":\"SUCC", "", Some(1))),
            Err(UsageError::Stop(Diag::Unverifiable))
        ));
        // an output not read whole (cut, not UTF-8, held open): a stop, also with a good result in it
        let mut cut = out(&ok, "", Some(0)).unwrap();
        cut.complete = false;
        assert!(matches!(
            classify_usage_output(Ok(cut)),
            Err(UsageError::Stop(Diag::Unverifiable))
        ));
        assert!(matches!(
            classify_usage_output(Err(RunError::Timeout)),
            Err(UsageError::Stop(Diag::UsageTimeout))
        ));
        // cut off by the computer's sleep: an ordinary failure, tried again (no safety stop)
        assert!(matches!(
            classify_usage_output(Err(RunError::Suspended)),
            Err(UsageError::Retry(Diag::Suspended))
        ));
        assert_eq!(Diag::Suspended.error_code(), ErrorCode::FetchFailed);
        assert!(matches!(
            classify_usage_output(Err(RunError::NotFound)),
            Err(UsageError::Retry(Diag::CliNotFound))
        ));
    }

    #[test]
    fn the_arguments_override_disabled_slash_commands_and_pass_usage_as_is() {
        let args = usage_args();
        assert_eq!(args[..2], ["-p", "/usage"]);
        let i = args.iter().position(|a| a == "--settings").unwrap();
        let settings: Value = serde_json::from_str(&args[i + 1]).unwrap();
        assert_eq!(settings, serde_json::json!({"disableSlashCommands": false}));
    }

    #[test]
    fn the_version_is_taken_only_from_a_clean_exit_read_whole() {
        assert_eq!(
            version_from_output(out("1.5.13", "", Some(0))),
            Ok("1.5.13".into())
        );
        assert_eq!(
            version_from_output(out("1.5.13", "", Some(1))),
            Err(Diag::UnrecognizedOutput)
        );
        let mut cut = out("\u{fffd}1.5.12 (latest 1.5.13 available)", "", Some(0)).unwrap();
        cut.complete = false;
        assert_eq!(version_from_output(Ok(cut)), Err(Diag::UnrecognizedOutput));
        assert_eq!(
            version_from_output(Err(RunError::Timeout)),
            Err(Diag::VersionTimeout)
        );
    }

    #[test]
    fn the_version_is_read_from_the_forms_agy_may_print() {
        for (text, want) in [
            ("1.5.13\n", Some((1, 5, 13))),
            ("agy 1.5.13", Some((1, 5, 13))),
            ("agy version v1.6.0+abc", Some((1, 6, 0))),
            ("1.5.13-rc1", None),
            ("agy 1.5.13-rc1 (latest 1.6.0 available)", None),
            ("agy 1.6.0 (go1.24.0)", Some((1, 6, 0))),
            ("1.5.13\n2.0.0", Some((1, 5, 13))),
            ("1.5", None),
            ("1.5.13.2", None),
            ("", None),
        ] {
            assert_eq!(parse_agy_version(text), want, "{text}");
        }
    }

    #[test]
    fn nothing_is_fetched_before_the_account_is_identified_then_it_is() {
        let h = home("identify");
        let fake = Fake::default();
        let mut p = provider(&h, &fake);
        let s = p.collect(NOW, false);
        assert_eq!(fake.usages(), 0);
        assert_eq!(s.error_code, Some(ErrorCode::LoginRequired));
        identify(&h, "a@example.com", NOW);
        p.on_event(&Event::GeminiStatuslineCaptured);
        let s = p.collect(NOW + MINUTE_MS, false);
        assert_eq!(fake.usages(), 1);
        assert_eq!(s.status, ProviderStatus::Ok);
        assert_eq!(s.plan.as_deref(), Some("pro"));
        assert!(ids(&s).contains(&"seven_day_argon".to_string()));
        // the email itself is never written
        for f in [CAPTURE_FILE, STATE_FILE] {
            let text = std::fs::read_to_string(h.join(f)).unwrap();
            assert!(!text.contains("a@example.com"), "{f}");
        }
    }

    #[test]
    fn a_capture_of_another_clock_epoch_is_not_used_nor_replaces_a_later_one() {
        let h = home("capture-epoch");
        let fake = Fake::default();
        let other = |email: &str, epoch: Option<u64>, at: i64| {
            capture_from_input(&serde_json::json!({"email": email}), at, epoch).unwrap()
        };
        save_capture(&h, &other("a@example.com", Some(999), NOW)).unwrap();
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert_eq!(fake.usages(), 0);
        assert_eq!(p.state.account_hash, None);
        // a writer that read an earlier epoch (or an unusable clock) doesn't replace a later one's record
        assert!(!save_capture(&h, &other("b@example.com", Some(998), NOW + 1)).unwrap());
        assert!(!save_capture(&h, &other("b@example.com", None, NOW + 2)).unwrap());
        assert_eq!(
            read_json::<Capture>(&h.join(CAPTURE_FILE))
                .unwrap()
                .account_hash,
            account_hash("a@example.com")
        );
        assert!(save_capture(&h, &other("b@example.com", Some(1000), NOW + 3)).unwrap());
    }

    #[test]
    fn a_safety_stop_holds_after_a_restart_until_forced() {
        let h = home("guard");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        // the run couldn't confirm that nothing was used (a stop)
        fake.reply(vec![Err(Diag::Unverifiable)]);
        let mut p = provider(&h, &fake);
        let s = p.collect(NOW, false);
        assert_eq!(s.error_code, Some(ErrorCode::SafetyStop));
        // restarted: still stopped, nothing launched however long it waits
        let mut again = provider(&h, &fake);
        again.collect(NOW + 60 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 1);
        assert_eq!(
            again.usage_due_ms(NOW + 60 * MINUTE_MS),
            i64::MAX,
            "no fetch planned"
        );
        // forced: runs once more
        let s = {
            again.confirm_safety(true);
            again.collect(NOW + 61 * MINUTE_MS, true)
        };
        assert_eq!(fake.usages(), 2);
        assert_eq!(s.status, ProviderStatus::Ok);
    }

    #[test]
    fn an_interrupted_fetch_is_a_stop_after_a_restart() {
        let h = home("interrupted");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        // a run that stopped between launching and checking the result
        let mut state = load_state(&h.join(STATE_FILE));
        state.usage_in_flight_ms = Some(NOW + MINUTE_MS);
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        let mut again = provider(&h, &fake);
        let s = again.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(s.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(fake.usages(), 1, "not launched again");
    }

    #[test]
    fn a_state_that_cant_be_read_now_skips_the_round_and_a_lost_one_starts_a_new_history() {
        let h = home("state-read");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert_eq!(fake.usages(), 1);
        // an I/O error (here a folder in its place): nothing run, nothing written, the acceptance not made
        let saved = std::fs::read(h.join(STATE_FILE)).unwrap();
        std::fs::remove_file(h.join(STATE_FILE)).unwrap();
        std::fs::create_dir(h.join(STATE_FILE)).unwrap();
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, true);
        assert_eq!(fake.usages(), 1);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(p.holds_queue(), "its queued values wait");
        assert!(h.join(STATE_FILE).is_dir(), "left as it is");
        // read again a minute on, not at once, and no turn asked for meanwhile
        assert_eq!(p.next_due_ms(NOW + 10 * MINUTE_MS), NOW + 11 * MINUTE_MS);
        assert!(p.fetch_due_ms(NOW + 10 * MINUTE_MS) >= NOW + 11 * MINUTE_MS);
        // a statusLine record that comes meanwhile wakes nothing before then
        p.on_event(&Event::GeminiStatuslineCaptured);
        assert!(!p.passive_pending());
        // nor the read before a send: held, the state not read
        assert!(p.sync_saved(NOW + 10 * MINUTE_MS).is_some());
        assert!(p.state_retry_at.is_some());
        // a read before a send that is the first to find it unreadable starts the wait too
        let mut fresh = provider(&h, &fake);
        assert!(fresh.sync_saved(NOW + 10 * MINUTE_MS).is_some());
        assert_eq!(fresh.state_retry_at, Some(NOW + 11 * MINUTE_MS));
        // so does a tidy
        let mut tidy = provider(&h, &fake);
        assert!(!tidy.forget_cached());
        assert!(tidy.state_retry_at.is_some());
        std::fs::remove_dir(h.join(STATE_FILE)).unwrap();
        std::fs::write(h.join(STATE_FILE), &saved).unwrap();
        // a file without this version's mark, without its stop flags (each guard alone), or a corrupt one: stopped, and the next
        // account seen starts a new history
        for lost in [
            &b"{}"[..],
            &br#"{"state_version":1}"#[..],
            &br#"{"state_version":1,"usage_in_flight_ms":null}"#[..],
            &br#"{"state_version":1,"guard_tripped":false,"account_changed":false,"limits_changed":false,"recover_identity":false,"awaiting_email":false,"refetch":false}"#[..],
            &b"{"[..],
        ] {
            std::fs::write(h.join(STATE_FILE), lost).unwrap();
            let mut broken = provider(&h, &fake);
            let s = broken.collect(NOW + 20 * MINUTE_MS, false);
            assert!(broken.state.guard_tripped);
            assert_eq!(fake.usages(), 1);
            assert_eq!(
                broken.state.account_hash,
                Some(account_hash("b@example.com"))
            );
            assert_eq!(
                s.history_since.as_deref(),
                Some(iso_from_ms(NOW + 20 * MINUTE_MS).as_str()),
                "a boundary"
            );
        }
    }

    #[test]
    fn another_account_stops_fetching_until_accepted_with_a_history_boundary() {
        let h = home("switch");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        identify_as(&h, "b@example.com", "Free", NOW + MINUTE_MS);
        p.on_event(&Event::GeminiStatuslineCaptured);
        let s = p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(s.error_code, Some(ErrorCode::AccountChanged));
        assert!(s.windows.is_empty(), "the account before isn't shown");
        assert_eq!(fake.usages(), 1, "not fetched meanwhile");
        // "the same account" can't be confirmed for another email
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 7 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        // accepted: resumes with the boundary, and nothing of the account before (its plan, its limits) carries over
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        p.accept_target(p.pending_switch());
        p.accept_account();
        let s = p.collect(NOW + 8 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert_eq!(
            s.history_since.as_deref(),
            Some(iso_from_ms(NOW + 8 * MINUTE_MS).as_str())
        );
        assert_eq!(fake.usages(), 2);
        assert_eq!(s.status, ProviderStatus::Ok, "its own limits, not a pause");
        assert_eq!(s.plan.as_deref(), Some("free"));
        assert_eq!(p.state.known_windows, ["partner_seven_day", "seven_day"]);
    }

    #[test]
    fn an_acceptance_for_what_was_shown_is_refused_when_the_input_changed_it_just_now() {
        let h = home("accept-moved");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.collect(NOW + 2 * MINUTE_MS, false);
        // C appears before the acceptance of B reaches the state
        identify(&h, "c@example.com", NOW + 3 * MINUTE_MS);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        assert_eq!(p.state.pending_hash, Some(account_hash("c@example.com")));
        assert_eq!(fake.usages(), 1);
        // asked again (now for C): accepted
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert_eq!(p.state.account_hash, Some(account_hash("c@example.com")));
        // nothing waiting: said so
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
    }

    #[test]
    fn a_model_s_limit_or_the_other_vendors_limits_coming_or_going_don_t_pause_other_overall_limits_do()
     {
        let h = home("limits-aux");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert!(
            p.state
                .known_windows
                .contains(&"seven_day_argon".to_string())
        );
        // Argon's own weekly limit dropped (as on 2026-11-23), then the other vendors' limits too: taken as they are
        let without = |ids: &[&str]| {
            let mut v = fixture("usage-pro.json");
            for g in v["command"]["data"]["groups"].as_array_mut().unwrap() {
                g["buckets"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|b| !ids.contains(&b["id"].as_str().unwrap()));
            }
            v
        };
        fake.reply(vec![Ok(without(&["gemini-argon-wtu-weekly"]))]);
        let s = p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert_eq!(s.status, ProviderStatus::Ok);
        assert!(!ids(&s).contains(&"seven_day_argon".to_string()));
        assert!(
            !p.state
                .known_windows
                .contains(&"seven_day_argon".to_string())
        );
        fake.reply(vec![Ok(without(&[
            "gemini-argon-wtu-weekly",
            "3p-5h",
            "3p-weekly",
        ]))]);
        let s = p.collect(NOW + 12 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert_eq!(s.status, ProviderStatus::Ok);
        // and one coming back the same
        fake.reply(vec![Ok(fixture("usage-pro.json"))]);
        p.collect(NOW + 18 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert!(
            p.state
                .known_windows
                .contains(&"seven_day_argon".to_string())
        );
        // an overall limit gone (the 5-hour one: another plan, or another account): paused as before
        fake.reply(vec![Ok(without(&["gemini-5h"]))]);
        let s = p.collect(NOW + 24 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        assert_eq!(s.error_code, Some(ErrorCode::FetchFailed));
    }

    #[test]
    fn other_limits_pause_and_resume_as_the_same_account_without_a_boundary_or_as_another_with_one()
    {
        let h = home("limits");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        let s = p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        assert!(p.holds_queue());
        // the values before stay, as old, and nothing of the new shape is shown or sent
        assert_eq!(s.status, ProviderStatus::Stale);
        assert_eq!(s.blocked, None);
        assert!(ids(&s).contains(&"five_hour".to_string()));
        assert_eq!(s.error_code, Some(ErrorCode::FetchFailed));
        assert_eq!(s.history_since, None);
        p.collect(NOW + 6 * MINUTE_MS + 30_000, true);
        assert_eq!(
            fake.usages(),
            2,
            "not fetched while paused, also when forced"
        );
        // the same account (a plan change), confirmed at once (the values before are only 7 minutes old): resumes with no
        // boundary and the new shape known, and the values before stay old until a fetch brings the new ones
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        fake.reply(vec![Err(Diag::FetchFailed), Ok(fixture("usage-free.json"))]);
        let s = p.collect(NOW + 7 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert!(!p.holds_queue());
        assert_eq!(
            fake.usages(),
            2,
            "the interval since the last attempt still holds"
        );
        assert_eq!(s.status, ProviderStatus::Stale);
        assert_eq!(s.blocked, None);
        assert_eq!(s.history_since, None);
        // the next fetch doesn't wait for the old values' interval; a failed one leaves them old
        assert_eq!(p.usage_due_ms(NOW + 7 * MINUTE_MS), NOW + 11 * MINUTE_MS);
        let s = p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 3);
        assert_eq!(s.status, ProviderStatus::Stale);
        let s = p.collect(NOW + 40 * MINUTE_MS, false);
        assert_eq!(s.status, ProviderStatus::Ok);
        assert_eq!(ids(&s), ["seven_day", "partner_seven_day"]);
        // the control: another shape again, taken as another account
        fake.reply(vec![Ok(fixture("usage-pro.json"))]);
        p.collect(NOW + 50 * MINUTE_MS, true);
        assert!(p.state.limits_changed);
        p.accept_target(p.pending_switch());
        p.accept_account();
        let s = p.collect(NOW + 51 * MINUTE_MS, false);
        assert_eq!(
            s.history_since.as_deref(),
            Some(iso_from_ms(NOW + 51 * MINUTE_MS).as_str())
        );
    }

    #[test]
    fn a_pause_and_a_switch_dont_undo_each_other_and_one_switch_makes_one_boundary() {
        let h = home("pause-and-switch");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        // B's email, then A's again: the switch is gone, the pause stays until chosen
        identify(&h, "b@example.com", NOW + 7 * MINUTE_MS);
        p.collect(NOW + 8 * MINUTE_MS, false);
        assert!(p.state.account_changed && p.state.limits_changed);
        identify(&h, "a@example.com", NOW + 9 * MINUTE_MS);
        let s = p.collect(NOW + 30 * MINUTE_MS, false);
        assert!(!p.state.account_changed);
        assert!(p.state.limits_changed);
        assert_eq!(s.error.as_deref(), Some(Diag::LimitsChanged.message()));
        assert_eq!(fake.usages(), 2, "not fetched before a choice");
        // the pause taken as another account; its email arrives later and is that account (no second boundary)
        p.accept_target(p.pending_switch());
        p.accept_account();
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        let s = p.collect(NOW + 31 * MINUTE_MS, false);
        let boundary = iso_from_ms(NOW + 31 * MINUTE_MS);
        assert_eq!(s.history_since.as_deref(), Some(boundary.as_str()));
        assert_eq!(s.plan, None, "the plan before isn't this account's");
        identify_as(&h, "b@example.com", "Free", NOW + 40 * MINUTE_MS);
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        let s = p.collect(NOW + 41 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert!(!p.state.account_changed);
        assert_eq!(p.state.account_hash, Some(account_hash("b@example.com")));
        assert_eq!(s.history_since.as_deref(), Some(boundary.as_str()));
        assert_eq!(s.plan.as_deref(), Some("free"));
        // a third account after that is a switch again
        identify(&h, "c@example.com", NOW + 50 * MINUTE_MS);
        p.collect(NOW + 51 * MINUTE_MS, false);
        assert!(p.state.account_changed);
    }

    #[test]
    fn an_account_or_clock_change_during_a_fetch_keeps_its_result_out() {
        let h = home("during");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        let first = p.state.last_ok.clone();
        // B signs in while /usage runs: its result isn't taken as A's, and the switch is seen at once
        let hb = h.to_path_buf();
        fake.0.lock().unwrap().during = Some(Box::new(move || {
            identify(&hb, "b@example.com", NOW + 6 * MINUTE_MS)
        }));
        let s = p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 2);
        assert_eq!(s.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(p.state.last_ok, None);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 7 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        p.collect(NOW + 12 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 3);
        // the clock refused while /usage runs: its result (here other limits) neither shows nor pauses anything
        let fetched = p.state.last_ok.clone();
        assert!(fetched.is_some());
        assert_ne!(fetched, first);
        let hc = h.to_path_buf();
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        fake.0.lock().unwrap().during = Some(Box::new(move || refuse_clock(&hc)));
        p.collect(NOW + 13 * MINUTE_MS, true);
        assert!(!p.state.limits_changed);
        assert_eq!(p.state.last_ok, fetched);
    }

    #[test]
    fn an_earlier_version_s_pause_on_a_model_s_limit_waits_for_a_confirmation_also_after_its_clock_epoch_is_gone()
     {
        let h = home("pause-inherited");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        // paused by an earlier version on Argon's limit gone (the overall limits the same), in an epoch since gone
        let mut state = load_state(&h.join(STATE_FILE));
        let mut pending = state.known_windows.clone();
        pending.retain(|id| id != "seven_day_argon");
        state.limits_changed = true;
        state.pending_windows = pending;
        state.pending_epoch = Some(12345);
        state.last_error = Some(Diag::LimitsChanged);
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        // its doubt is kept: the next fetch's limits, the same overall ones, wait for a confirmation in this epoch
        let usages = fake.usages();
        p.collect(NOW + 20 * MINUTE_MS, true);
        assert_eq!(fake.usages(), usages + 1, "fetched again in this epoch");
        assert!(p.state.limits_changed, "paused again, now in this epoch");
        assert_eq!(p.state.pending_epoch, crate::clock::usable_epoch(&h));
        // the epoch gone again before an acceptance: the doubt stays, the same limits pause again
        refuse_clock(&h);
        lift_refusal(&h);
        let usages = fake.usages();
        p.collect(NOW + 30 * MINUTE_MS, true);
        assert_eq!(fake.usages(), usages + 1);
        assert!(p.state.limits_changed, "still waits for a confirmation");
        assert!(p.state.confirm_limits);
        // confirmed as the same account: resumes, and the doubt is over
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 31 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert!(!p.state.limits_changed);
        assert!(!p.state.confirm_limits);

        // a pause on other overall limits (only the weekly one), dropped with its epoch, then the earlier overall limits back with
        // Argon's gone: still waits for a confirmation
        let h = home("pause-overall-then-aux");
        let mut p = provider(&h, &fake);
        identify(&h, "a@example.com", NOW);
        p.collect(NOW, false);
        let mut state = load_state(&h.join(STATE_FILE));
        state.limits_changed = true;
        state.pending_windows = vec!["partner_seven_day".into(), "seven_day".into()];
        state.pending_epoch = Some(12345);
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        let mut v = fixture("usage-pro.json");
        for g in v["command"]["data"]["groups"].as_array_mut().unwrap() {
            g["buckets"]
                .as_array_mut()
                .unwrap()
                .retain(|b| b["id"] != "gemini-argon-wtu-weekly");
        }
        fake.reply(vec![Ok(v)]);
        p.collect(NOW + 20 * MINUTE_MS, true);
        assert!(p.state.limits_changed, "waits for a confirmation");

        // the same when a statusLine input brings the next limits (no fetch)
        let h = home("pause-inherited-passive");
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        let mut state = load_state(&h.join(STATE_FILE));
        let mut pending = state.known_windows.clone();
        pending.retain(|id| id != "seven_day_argon");
        state.limits_changed = true;
        state.pending_windows = pending;
        state.pending_epoch = Some(12345);
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        let mut gone = quota_of("usage-pro.json");
        gone.as_object_mut()
            .unwrap()
            .remove("gemini-argon-wtu-weekly");
        statusline(&h, "a@example.com", Some(gone), NOW + 2 * MINUTE_MS);
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(p.state.limits_changed, "paused again, now in this epoch");
        assert_eq!(p.state.pending_epoch, crate::clock::usable_epoch(&h));
    }

    #[test]
    fn a_pause_seen_in_another_clock_epoch_is_dropped_and_seen_again() {
        let h = home("pause-epoch");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        // refused, then trusted again: another epoch
        refuse_clock(&h);
        lift_refusal(&h);
        assert!(p.forget_cached());
        assert!(!p.state.limits_changed, "an acceptance can't rest on it");
        // the same in a collect that finds it (saved by another process after the tidying)
        let mut state = load_state(&h.join(STATE_FILE));
        state.limits_changed = true;
        state.pending_windows = vec!["seven_day".into()];
        state.pending_epoch = Some(12345);
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        p.accept_target(p.pending_switch());
        p.accept_account();
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        p.collect(NOW + 20 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false), "nothing left to accept");
        assert!(p.state.limits_changed, "seen again by this epoch's fetch");
        assert_eq!(p.state.pending_epoch, crate::clock::usable_epoch(&h));
    }

    #[test]
    fn the_version_is_checked_for_the_executable_that_runs() {
        let h = home("version-path");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        let versions = fake.0.lock().unwrap().versions;
        assert_eq!((versions, fake.usages()), (1, 1));
        // another agy is found (an older one): checked before anything runs with it, and not run
        {
            let mut c = fake.0.lock().unwrap();
            c.bin = Some(Some(PathBuf::from("old-agy")));
            c.version_of = vec![(PathBuf::from("old-agy"), "1.5.12".into())];
        }
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(fake.0.lock().unwrap().versions, 2);
        assert_eq!(fake.usages(), 1);
        assert_eq!(p.state.cli_supported, Some(false));
        // a new process with the earlier agy back: its version is checked again first, then it runs
        fake.0.lock().unwrap().bin = None;
        let mut again = provider(&h, &fake);
        again.collect(NOW + 20 * MINUTE_MS, false);
        assert_eq!(fake.0.lock().unwrap().versions, 3);
        assert_eq!(fake.usages(), 2);
        assert_eq!(
            fake.0.lock().unwrap().ran,
            [PathBuf::from("agy-test"), PathBuf::from("agy-test")]
        );
        // none found: nothing runs, and it is looked for again on the next collect
        fake.0.lock().unwrap().bin = Some(None);
        let s = again.collect(NOW + 30 * MINUTE_MS, false);
        assert_eq!(s.error_code, Some(ErrorCode::NotInstalled));
        fake.0.lock().unwrap().bin = None;
        again.collect(NOW + 31 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 3);
    }

    #[test]
    fn an_older_cli_is_not_run() {
        let h = home("old-cli");
        let fake = Fake::default();
        fake.0.lock().unwrap().version = Some(Ok("1.5.12".into()));
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        let s = p.collect(NOW, true);
        assert_eq!(fake.usages(), 0);
        assert_eq!(p.state.cli_supported, Some(false));
        assert_eq!(s.error_code, Some(ErrorCode::FetchFailed));
    }

    #[test]
    fn a_reached_overall_limit_is_blocked_and_a_reached_group_limit_is_not() {
        let h = home("blocked");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut data = fixture("usage-pro.json");
        // the partner group at 0% left: not blocked
        data["command"]["data"]["groups"][1]["buckets"][0]["remaining_fraction"] =
            serde_json::json!(0.0);
        fake.reply(vec![Ok(data.clone())]);
        let mut p = provider(&h, &fake);
        assert_eq!(p.collect(NOW, false).blocked, Some(false));
        // the Gemini 5-hour limit with a little left: not blocked
        data["command"]["data"]["groups"][0]["buckets"][1]["remaining_fraction"] =
            serde_json::json!(0.0004);
        fake.reply(vec![Ok(data.clone())]);
        assert_eq!(p.collect(NOW + 6 * MINUTE_MS, true).blocked, Some(false));
        // at 0% left: blocked
        data["command"]["data"]["groups"][0]["buckets"][1]["remaining_fraction"] =
            serde_json::json!(0.0);
        fake.reply(vec![Ok(data)]);
        assert_eq!(p.collect(NOW + 12 * MINUTE_MS, true).blocked, Some(true));
    }

    #[test]
    fn the_account_is_watched_also_while_another_pc_is_on_duty_and_no_agy_is_started_for_it() {
        let h = home("passive");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert_eq!(fake.usages(), 1);
        // another PC is on duty for the next hour: this one only takes passive input
        assert!(p.hold_fetch_until(NOW + 60 * MINUTE_MS));
        assert!(p.takes_passive_values());
        identify(&h, "b@example.com", NOW + 2 * MINUTE_MS);
        p.on_event(&Event::GeminiStatuslineCaptured);
        assert_eq!(
            p.next_due_ms(NOW + 3 * MINUTE_MS),
            NOW + 3 * MINUTE_MS,
            "the input is taken at once"
        );
        let s = p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(s.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(fake.usages(), 1, "no agy started for it");
    }

    #[test]
    fn an_acceptance_needs_a_usable_clock() {
        let h = home("accept-clock");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.collect(NOW + 2 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        // the clock is refused: the acceptance isn't made, and the switch stays pending
        refuse_clock(&h);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(p.state.account_changed);
    }

    #[test]
    fn the_record_keeps_the_plan_unless_told_another_and_counts_its_account_changes() {
        let h = home("capture");
        let cap = |email: &str, tier: Option<&str>, at: i64| {
            let mut input = serde_json::json!({"email": email});
            if let Some(t) = tier {
                input["plan_tier"] = serde_json::json!(t);
            }
            capture_from_input(&input, at, Some(7)).unwrap()
        };
        let read = || read_json::<Capture>(&h.join(CAPTURE_FILE)).unwrap();
        assert!(save_capture(&h, &cap("c@example.com", Some("Google AI Pro"), NOW)).unwrap());
        // the same input later: not written; one without the plan keeps it; an unknown plan named clears it
        assert!(
            !save_capture(
                &h,
                &cap("c@example.com", Some("Google AI Pro"), NOW + 30 * MINUTE_MS)
            )
            .unwrap()
        );
        assert!(!save_capture(&h, &cap("c@example.com", None, NOW + 31 * MINUTE_MS)).unwrap());
        assert_eq!(
            (read().captured_at_ms, read().plan.as_deref()),
            (NOW, Some("pro"))
        );
        assert!(
            save_capture(
                &h,
                &cap("c@example.com", Some("Unprovisioned"), NOW + 32 * MINUTE_MS)
            )
            .unwrap()
        );
        assert_eq!(read().plan, None);
        // no plan given, then an unknown one named: written (the plan is told now)
        assert!(save_capture(&h, &cap("e@example.com", None, NOW + 34 * MINUTE_MS)).unwrap());
        assert!(
            save_capture(
                &h,
                &cap("e@example.com", Some("Unprovisioned"), NOW + 35 * MINUTE_MS)
            )
            .unwrap()
        );
        assert!(read().plan_given);
        assert!(
            save_capture(
                &h,
                &cap("c@example.com", Some("Unprovisioned"), NOW + 36 * MINUTE_MS)
            )
            .unwrap()
        );
        // asked for by the agent: the next input is written even if unchanged
        std::fs::write(h.join(CAPTURE_REFRESH_FILE), b"").unwrap();
        assert!(
            save_capture(
                &h,
                &cap("c@example.com", Some("Unprovisioned"), NOW + 33 * MINUTE_MS)
            )
            .unwrap()
        );
        assert!(!h.join(CAPTURE_REFRESH_FILE).exists());
        // each change of account is counted; a writer whose input came just before the record's (it waited) doesn't replace it
        assert_eq!(read().changes, 2, "c to e and back");
        assert!(save_capture(&h, &cap("d@example.com", None, NOW + 40 * MINUTE_MS)).unwrap());
        assert!(
            !save_capture(
                &h,
                &cap("c@example.com", None, NOW + 40 * MINUTE_MS - 2_000)
            )
            .unwrap()
        );
        assert!(save_capture(&h, &cap("c@example.com", None, NOW + 41 * MINUTE_MS)).unwrap());
        assert_eq!(
            (read().changes, read().account_hash.clone()),
            (4, account_hash("c@example.com"))
        );
        // a clock set back further than that is written as usual
        assert!(save_capture(&h, &cap("d@example.com", None, NOW + 20 * MINUTE_MS)).unwrap());
    }

    #[test]
    fn the_plan_follows_the_input_and_an_unknown_name_clears_it() {
        let h = home("plan");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        assert_eq!(p.collect(NOW, false).plan.as_deref(), Some("pro"));
        identify_as(&h, "a@example.com", "Unprovisioned", NOW + MINUTE_MS);
        assert_eq!(p.collect(NOW + 2 * MINUTE_MS, false).plan, None);
    }

    #[test]
    fn an_executable_changed_in_place_is_checked_again_before_it_runs() {
        let h = home("version-in-place");
        let fake = Fake::default();
        let bin = h.join("agy-file");
        std::fs::write(&bin, b"one").unwrap();
        {
            let mut c = fake.0.lock().unwrap();
            c.bin = Some(Some(bin.clone()));
            c.version_of = vec![(bin.clone(), "1.5.13".into())];
        }
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert_eq!(fake.usages(), 1);
        // replaced by an older one at the same path, within the hour: checked again, not run
        std::fs::write(&bin, b"older one").unwrap();
        fake.0.lock().unwrap().version_of = vec![(bin.clone(), "1.5.12".into())];
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(fake.0.lock().unwrap().versions, 2);
        assert_eq!(fake.usages(), 1);
    }

    #[test]
    fn a_state_that_cant_be_saved_or_a_fetch_still_in_flight_holds_the_queue() {
        let h = home("hold-unsaved");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert!(!p.holds_queue());
        // the result's save fails (the state file is replaced while /usage runs): held, and the state read before a send can't be
        // read either (nothing of Gemini goes out, its boundary kept)
        let hs = h.to_path_buf();
        fake.0.lock().unwrap().during = Some(Box::new(move || {
            std::fs::remove_file(hs.join(STATE_FILE)).unwrap();
            std::fs::create_dir(hs.join(STATE_FILE)).unwrap();
        }));
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(p.holds_queue());
        // nothing older taken, and none of the result that couldn't be saved goes out
        let s = p.sync_saved(NOW + 7 * MINUTE_MS).unwrap();
        assert!(s.windows.is_empty());
        assert!(p.state.last_ok.is_some(), "kept here until saved");
        assert!(p.holds_queue());
        // a process that never collected, finding the state unreadable before a send: nothing of Gemini goes out
        let mut other = provider(&h, &fake);
        let s = other.sync_saved(NOW + 7 * MINUTE_MS).unwrap();
        assert!(s.windows.is_empty());
        assert!(other.holds_queue());
        std::fs::remove_dir(h.join(STATE_FILE)).unwrap();
        // saved again: no longer held
        p.collect(NOW + 8 * MINUTE_MS, false);
        assert!(!p.holds_queue());
        // another process's fetch in flight: held until its result is saved
        let mut state = load_state(&h.join(STATE_FILE));
        state.usage_in_flight_ms = Some(NOW + 8 * MINUTE_MS);
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        assert!(
            p.sync_saved(NOW + 8 * MINUTE_MS).is_some(),
            "read again after the failure"
        );
        assert!(p.holds_queue());
        state.usage_in_flight_ms = None;
        write_json_atomic(&h.join(STATE_FILE), &state).unwrap();
        p.sync_saved(NOW + 9 * MINUTE_MS);
        assert!(!p.holds_queue());
    }

    #[test]
    fn a_switch_this_process_couldnt_save_isnt_undone_by_the_older_saved_state() {
        let h = home("unsaved-switch");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        let before = std::fs::read(h.join(STATE_FILE)).unwrap();
        // a passive round sees B; its save fails, so the file still says A
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.collect(NOW + 2 * MINUTE_MS, false);
        std::fs::write(h.join(STATE_FILE), &before).unwrap();
        p.unsaved = true;
        let held = p.sync_saved(NOW + 3 * MINUTE_MS).unwrap();
        assert!(held.windows.is_empty());
        assert_eq!(held.error_code, Some(ErrorCode::AccountChanged));
        assert!(p.state.account_changed);
        assert!(p.holds_queue());
    }

    struct NoNet;
    impl crate::push::Transport for NoNet {
        fn put(
            &mut self,
            _url: &str,
            _headers: &[(&str, &str)],
            _body: &str,
        ) -> Result<(u16, String), crate::push::SendError> {
            Err(crate::push::SendError::NotSent)
        }
    }
    struct NoCreds;
    impl crate::push::CredentialStore for NoCreds {
        fn load(&self) -> Result<crate::push::Credentials, String> {
            Err("none".into())
        }
    }

    #[test]
    fn a_switch_that_couldnt_be_saved_drops_the_queued_observations_in_that_round() {
        let h = home("unsaved-switch-queue");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        let first = p.collect(NOW, false);
        let mut pusher = crate::push::Pusher::new(
            &h,
            "https://x.example/v2/snapshots/t",
            Logger::stderr(),
            Box::new(NoNet),
            Box::new(NoCreds),
        );
        let mut latest = std::collections::BTreeMap::from([("gemini".to_string(), first)]);
        pusher.record(&latest, true, NOW);
        assert!(!pusher.outbox.observations.is_empty());
        let before = std::fs::read(h.join(STATE_FILE)).unwrap();
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.collect(NOW + 2 * MINUTE_MS, false);
        std::fs::write(h.join(STATE_FILE), &before).unwrap();
        p.unsaved = true;
        // the agent's round: the value read before the send replaces the latest one, then the queue is recorded
        latest.insert("gemini".into(), p.sync_saved(NOW + 3 * MINUTE_MS).unwrap());
        pusher.record(&latest, true, NOW + 3 * MINUTE_MS);
        assert!(
            pusher.outbox.observations.is_empty(),
            "A's queued observations dropped"
        );
        assert_eq!(
            latest["gemini"].history_since, None,
            "the boundary as it was"
        );
    }

    #[test]
    fn the_first_input_after_an_acceptance_decides_also_when_another_replaced_it() {
        for (first, then_switch) in [("a@example.com", true), ("b@example.com", true)] {
            let h = home("first-after");
            let fake = Fake::default();
            identify(&h, "a@example.com", NOW);
            let mut p = provider(&h, &fake);
            p.collect(NOW, false);
            fake.reply(vec![Ok(fixture("usage-free.json"))]);
            p.collect(NOW + 6 * MINUTE_MS, false);
            p.accept_target(p.pending_switch());
            p.accept_account();
            p.collect(NOW + 7 * MINUTE_MS, false);
            assert!(p.state.awaiting_email);
            // two inputs before the agent reads: the first after the acceptance, then C
            identify(&h, first, NOW + 8 * MINUTE_MS);
            identify(&h, "c@example.com", NOW + 9 * MINUTE_MS);
            p.collect(NOW + 10 * MINUTE_MS, false);
            assert!(!p.state.awaiting_email);
            // A first: the wait ended, C is a switch. B first: B is the account accepted, C is a switch from it
            assert_eq!(p.state.account_changed, then_switch, "{first}");
            assert_eq!(p.state.pending_hash, Some(account_hash("c@example.com")));
            assert_eq!(p.state.account_hash, Some(account_hash(first)));
        }
    }

    #[test]
    fn the_first_input_after_a_request_stands_and_stays_in_its_clock_epoch() {
        let h = home("first-after-record");
        let epoch = crate::clock::usable_epoch(&h);
        let cap = |email: &str, at: i64, epoch: Option<u64>| {
            capture_from_input(&serde_json::json!({"email": email}), at, epoch).unwrap()
        };
        let first = || {
            read_json::<Capture>(&h.join(CAPTURE_FILE))
                .unwrap()
                .first_after_ask
        };
        save_capture(&h, &cap("a@example.com", NOW, epoch)).unwrap();
        std::fs::write(h.join(CAPTURE_REFRESH_FILE), "7").unwrap();
        save_capture(&h, &cap("b@example.com", NOW + MINUTE_MS, epoch)).unwrap();
        // the request's mark left behind (its removal failed): C doesn't become the first
        std::fs::write(h.join(CAPTURE_REFRESH_FILE), "7").unwrap();
        save_capture(&h, &cap("c@example.com", NOW + 2 * MINUTE_MS, epoch)).unwrap();
        assert_eq!(
            first().map(|f| (f.asked, f.account_hash)),
            Some((7, account_hash("b@example.com")))
        );
        // another clock epoch: not carried into it
        save_capture(
            &h,
            &cap("c@example.com", NOW + 3 * MINUTE_MS, epoch.map(|e| e + 1)),
        )
        .unwrap();
        assert_eq!(first(), None);
    }

    #[test]
    fn an_account_change_and_back_during_a_fetch_keeps_its_result_out() {
        let h = home("aba");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        let first = p.state.last_ok.clone();
        let hb = h.to_path_buf();
        fake.0.lock().unwrap().during = Some(Box::new(move || {
            identify(&hb, "b@example.com", NOW + 6 * MINUTE_MS);
            identify(&hb, "a@example.com", NOW + 6 * MINUTE_MS + 10_000);
        }));
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 2);
        assert_eq!(p.state.last_ok, first, "B's values aren't taken as A's");
        assert!(!p.state.account_changed);
    }

    #[test]
    fn a_record_that_cant_be_read_stops_an_acceptance_and_a_fetch() {
        let h = home("capture-unread");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.collect(NOW + 2 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        std::fs::remove_file(h.join(CAPTURE_FILE)).unwrap();
        std::fs::create_dir(h.join(CAPTURE_FILE)).unwrap();
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(p.state.account_changed);
        std::fs::remove_dir(h.join(CAPTURE_FILE)).unwrap();
        // no switch pending, the record unreadable: nothing fetched
        identify(&h, "a@example.com", NOW + 4 * MINUTE_MS);
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert!(!p.state.account_changed);
        std::fs::remove_file(h.join(CAPTURE_FILE)).unwrap();
        std::fs::create_dir(h.join(CAPTURE_FILE)).unwrap();
        let before = fake.usages();
        p.collect(NOW + 30 * MINUTE_MS, true);
        assert_eq!(fake.usages(), before);
    }

    #[test]
    fn after_an_acceptance_as_another_the_account_before_seen_again_ends_the_wait() {
        let h = home("await-end");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        p.collect(NOW + 6 * MINUTE_MS, false);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 7 * MINUTE_MS, false);
        assert!(p.state.awaiting_email);
        // the same input of A right after (unchanged, so normally not written): written, and the wait ends
        identify(&h, "a@example.com", NOW + 8 * MINUTE_MS);
        p.collect(NOW + 8 * MINUTE_MS + 30_000, false);
        assert!(!p.state.awaiting_email);
        // so C is a switch, not the account accepted
        identify(&h, "c@example.com", NOW + 9 * MINUTE_MS);
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert!(p.state.account_changed);
    }

    #[test]
    fn a_switch_seen_before_a_refusal_of_the_clock_is_accepted_only_once_seen_again() {
        let h = home("switch-epoch");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        // B saved during a fetch that spans a refusal: not taken
        let hb = h.to_path_buf();
        fake.0.lock().unwrap().during = Some(Box::new(move || {
            identify(&hb, "b@example.com", NOW + 6 * MINUTE_MS);
            refuse_clock(&hb);
        }));
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(!p.state.account_changed);
        lift_refusal(&h);
        assert!(p.forget_cached());
        // a switch seen in one epoch, then the clock refused and lifted: seen again before it can be accepted
        identify(&h, "b@example.com", NOW + 7 * MINUTE_MS);
        p.collect(NOW + 8 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        refuse_clock(&h);
        lift_refusal(&h);
        assert!(p.forget_cached());
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 9 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        identify(&h, "b@example.com", NOW + 10 * MINUTE_MS);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert_eq!(p.state.account_hash, Some(account_hash("b@example.com")));
    }

    #[test]
    fn a_change_saved_by_another_process_is_seen_before_a_send() {
        let h = home("sync");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut agent = provider(&h, &fake);
        agent.collect(NOW, false);
        assert_eq!(agent.sync_saved(NOW + MINUTE_MS), None, "nothing changed");
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        agent.collect(NOW + 6 * MINUTE_MS, false);
        assert!(agent.holds_queue());
        // a manual collect accepts the pause as another account
        let mut manual = provider(&h, &fake);
        manual.accept_target(manual.pending_switch());
        manual.accept_account();
        manual.collect(NOW + 7 * MINUTE_MS, false);
        assert_eq!(manual.account_accepted(), Some(true));
        let s = agent.sync_saved(NOW + 8 * MINUTE_MS).unwrap();
        assert!(!agent.holds_queue());
        assert_eq!(
            s.history_since.as_deref(),
            Some(iso_from_ms(NOW + 7 * MINUTE_MS).as_str())
        );
        assert!(s.windows.is_empty());
    }

    #[test]
    fn the_plan_tier_display_names_become_known_plans() {
        for (tier, want) in [
            ("Google AI Pro", Some("pro")),
            ("google  ai pro", Some("pro")),
            ("Google AI Ultra", Some("ultra")),
            ("Gemini Enterprise", Some("enterprise")),
            ("Gemini Enterprise Plus", Some("enterprise")),
            ("Google AI Plus", Some("plus")),
            ("Free", Some("free")),
            ("Individual", Some("free")),
            ("Unprovisioned", None),
            ("Google Developer Program", None),
            ("Something else", None),
        ] {
            assert_eq!(plan_from_tier(tier).as_deref(), want, "{tier}");
        }
        assert!(capture_from_input(&serde_json::json!({"email": ""}), NOW, Some(1)).is_none());
        assert_eq!(
            account_hash(" A@Example.com "),
            account_hash("a@example.com")
        );
    }
    #[test]
    fn statusline_limits_kept_from_an_earlier_input_carry_that_inputs_time() {
        let h = home("passive-time");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 1, "fetched at 5 min");
        let fetched = p.state.last_ok.clone().unwrap();
        // an input of the same account without limits, with another plan: the limits of 0 min are kept, with their own time
        identify_as(&h, "a@example.com", "Google AI Ultra", NOW + 6 * MINUTE_MS);
        let rec = read_json::<Capture>(&h.join(CAPTURE_FILE)).unwrap();
        assert_eq!(rec.quota_at_ms, Some(NOW));
        p.on_event(&Event::GeminiStatuslineCaptured);
        p.collect(NOW + 7 * MINUTE_MS, false);
        assert_eq!(
            p.state.last_ok.as_ref(),
            Some(&fetched),
            "the older limits don't replace the fetch"
        );
    }

    #[test]
    fn a_statusline_input_is_handled_once_also_after_an_acceptance_or_cleared_values() {
        let h = home("passive-once");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        // other limits: paused on that input
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        // taken as the same account with no input since: the input that paused isn't the next fetch
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert!(p.state.refetch, "still waits for a new value");
        // signed out: the values are cleared, and the same input isn't taken back
        let h2 = home("passive-cleared");
        statusline(&h2, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let fake2 = Fake::default();
        fake2.0.lock().unwrap().replies = vec![Err(Diag::LoginRequired)];
        let mut p2 = provider(&h2, &fake2);
        p2.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(fake2.usages(), 1);
        assert!(p2.state.last_ok.is_none());
        p2.hold_fetch_until(i64::MAX);
        p2.collect(NOW + 7 * MINUTE_MS, false);
        assert!(p2.state.last_ok.is_none(), "not taken back");
    }

    #[test]
    fn the_time_handled_of_another_clock_epoch_doesnt_hold_back_a_new_input() {
        let h = home("passive-epoch");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        // handled a day ahead: under this clock epoch it holds the input back; under one refused since, it doesn't
        let current = crate::clock::usable_epoch(&h);
        for (epoch, taken) in [(current, false), (None, false), (Some(999_999), true)] {
            let mut p = provider(&h, &fake);
            p.hold_fetch_until(i64::MAX);
            p.state.passive_seen_ms = Some(NOW + 1_440 * MINUTE_MS);
            p.state.passive_seen_epoch = epoch;
            p.save().unwrap();
            p.collect(NOW + MINUTE_MS, false);
            assert_eq!(p.state.last_ok.is_some(), taken, "seen under {epoch:?}");
        }
    }

    #[test]
    fn after_same_account_only_a_receipt_after_it_is_the_next_value_also_of_the_same_limits() {
        let h = home("passive-receipt");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        // received while paused, before the acceptance (other values of the same set): not the next value
        let mut other = quota_of("usage-free.json");
        other["gemini-weekly"]["remaining_fraction"] = serde_json::json!(0.25);
        statusline(
            &h,
            "a@example.com",
            Some(other.clone()),
            NOW + 3 * MINUTE_MS + 30_000,
        );
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert!(p.state.refetch, "nothing received after the acceptance yet");
        // a writer that read its input before the acceptance and saves after it: passed over
        let straddling = Capture {
            accept_gen: p.state.accept_gen - 1,
            ..capture_from_input(
                &serde_json::json!({"email": "a@example.com", "quota": quota_of("usage-pro.json")}),
                NOW + 4 * MINUTE_MS - 1,
                crate::clock::usable_epoch(&h),
            )
            .unwrap()
        };
        assert!(!super::save_capture(&h, &straddling).unwrap());
        p.on_event(&Event::GeminiStatuslineCaptured);
        p.collect(NOW + 4 * MINUTE_MS + 10_000, false);
        assert!(p.state.refetch, "an input of the time before");
        // the same limits again within a minute of their receipt, read after the acceptance: a new receipt (the record before is
        // of the generation before), taken as the next value
        statusline(
            &h,
            "a@example.com",
            Some(other.clone()),
            NOW + 4 * MINUTE_MS + 20_000,
        );
        let record = read_json::<Capture>(&h.join(CAPTURE_FILE)).unwrap();
        assert_eq!(record.quota_at_ms, Some(NOW + 4 * MINUTE_MS + 20_000));
        assert_eq!(record.accept_gen, p.state.accept_gen);
        p.on_event(&Event::GeminiStatuslineCaptured);
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert!(!p.state.refetch);
        assert_eq!(
            p.state.last_ok.as_ref().map(|o| o.fetched_ms),
            Some(NOW + 4 * MINUTE_MS + 20_000)
        );
        // the same limits again within a minute: that receipt's time stands (not written again)
        statusline(&h, "a@example.com", Some(other), NOW + 5 * MINUTE_MS);
        assert_eq!(
            read_json::<Capture>(&h.join(CAPTURE_FILE))
                .unwrap()
                .quota_at_ms,
            Some(NOW + 4 * MINUTE_MS + 20_000)
        );
    }

    #[test]
    fn a_record_left_from_before_an_acceptance_is_never_taken_after_it() {
        let h = home("passive-gen");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        // other limits while paused (the record now), then accepted as the same account's
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(p.state.accept_gen, 1);
        assert_eq!(read_accept_gen(&h), 1);
        // the record before stays as it was: never taken however often it is read (no new receipt after the acceptance)
        for m in 5..8 {
            p.on_event(&Event::GeminiStatuslineCaptured);
            p.collect(NOW + m * MINUTE_MS, false);
        }
        assert!(p.state.refetch);
        assert_eq!(fake.usages(), 0, "the fetch is held");
        // restarted: still a record of the generation before
        let mut again = provider(&h, &fake);
        again.hold_fetch_until(i64::MAX);
        again.collect(NOW + 9 * MINUTE_MS, false);
        assert!(again.state.refetch);
    }

    #[test]
    fn an_input_written_just_before_the_acceptance_is_of_the_time_before_it() {
        let h = home("passive-race");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        // the collect takes its time (4 min); a writer saves other values of the same set (stamped 5 min) before the acceptance
        let mut other = quota_of("usage-free.json");
        other["gemini-weekly"]["remaining_fraction"] = serde_json::json!(0.0);
        statusline(&h, "a@example.com", Some(other), NOW + 5 * MINUTE_MS);
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert!(
            p.state.refetch,
            "the value received before the acceptance isn't the next one"
        );
    }

    #[test]
    fn statusline_limits_all_turned_off_unknown_ones_and_many_entries() {
        let h = home("passive-off");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        assert_eq!(ids(&p.collect(NOW + MINUTE_MS, false)).len(), 5);
        // every known limit turned off: none shown, the same set (no pause)
        let mut off = serde_json::Map::new();
        for id in [
            "gemini-5h",
            "gemini-weekly",
            "3p-5h",
            "3p-weekly",
            "gemini-argon-wtu-weekly",
        ] {
            off.insert(id.into(), serde_json::json!({"disabled": true}));
        }
        statusline(
            &h,
            "a@example.com",
            Some(Value::Object(off)),
            NOW + 2 * MINUTE_MS,
        );
        let s = p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(!p.state.limits_changed);
        assert!(ids(&s).is_empty(), "{:?}", ids(&s));
        // unknown limits only: says nothing (the value before stays)
        assert!(
            quota_from_input(
                &serde_json::json!({"quota": {"new-1": {"remaining_fraction": 0.5}}}),
                NOW
            )
            .is_none()
        );
        // a bad known limit after many others is still seen
        let mut many = serde_json::Map::new();
        many.insert(
            "3p-5h".into(),
            serde_json::json!({"remaining_fraction": 1.0}),
        );
        many.insert(
            "3p-weekly".into(),
            serde_json::json!({"remaining_fraction": 1.0}),
        );
        for i in 0..62 {
            many.insert(
                format!("a{i:02}"),
                serde_json::json!({"remaining_fraction": 0.5}),
            );
        }
        many.insert(
            "gemini-5h".into(),
            serde_json::json!({"remaining_amount": 3}),
        );
        assert!(
            quota_from_input(&serde_json::json!({"quota": Value::Object(many)}), NOW).is_none()
        );
    }

    #[test]
    fn a_statusline_reset_time_also_comes_from_the_seconds_left() {
        let q =
            serde_json::json!({"gemini-5h": {"remaining_fraction": 0.0, "reset_in_seconds": 1800}});
        let (data, _) = quota_from_input(&serde_json::json!({"quota": q}), NOW).unwrap();
        let (windows, _) = parse_usage(&data).ok().unwrap();
        assert_eq!(
            windows[0].resets_at.as_deref(),
            Some(iso_from_ms(NOW + 1_800_000).as_str())
        );
        // the reset time given wins; seconds out of range are not used
        let q =
            serde_json::json!({"gemini-5h": {"remaining_fraction": 0.5, "reset_in_seconds": 9e9}});
        let (data, _) = quota_from_input(&serde_json::json!({"quota": q}), NOW).unwrap();
        assert_eq!(parse_usage(&data).ok().unwrap().0[0].resets_at, None);
    }

    #[test]
    fn the_collect_says_what_went_upstream_and_the_passive_intake_starts_no_agy() {
        use crate::providers::{Outcome, Run};
        let h = home("print-run");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        // a new process: the version isn't checked yet, and the statusLine record is taken with no agy at all
        assert!(Provider::take_passive(&mut p, NOW).is_some());
        let c = fake.0.lock().unwrap();
        assert_eq!((c.versions, c.usages), (0, 0));
        drop(c);
        assert!(
            p.state.last_ok.is_some(),
            "the statusLine limits were taken"
        );
        assert_eq!(p.take_run(), None);
        // the active schedule counts from the last active fetch only (none yet): due although passive values just came
        assert!(p.usage_due_ms(NOW) <= NOW || p.state.cli_supported.is_none());
        p.collect(NOW + MINUTE_MS, true);
        assert_eq!(p.take_run(), Some(Run::Ran(Outcome::Ok)));
        // values from the statusLine after the fetch don't move its schedule
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        let mut q = quota_of("usage-pro.json");
        q["gemini-weekly"]["remaining_fraction"] = serde_json::json!(0.2);
        statusline(&h, "a@example.com", Some(q), NOW + 3 * MINUTE_MS);
        p.on_event(&Event::GeminiStatuslineCaptured);
        let _ = Provider::take_passive(&mut p, NOW + 3 * MINUTE_MS);
        assert_eq!(
            p.state.last_ok.as_ref().map(|o| o.fetched_ms),
            Some(NOW + 3 * MINUTE_MS),
            "taken"
        );
        assert_eq!(
            p.usage_due_ms(NOW + 4 * MINUTE_MS),
            NOW + MINUTE_MS + p.cfg.interval_min * MINUTE_MS
        );
        // a run cut off: unknown; a launch that failed: nothing went upstream
        fake.reply(vec![Err(Diag::Unverifiable)]);
        p.collect(NOW + 20 * MINUTE_MS, true);
        assert_eq!(p.take_run(), Some(Run::Unknown));
        fake.reply(vec![Err(Diag::CliStartFailed)]);
        p.collect(NOW + 40 * MINUTE_MS, true);
        assert_eq!(p.take_run(), Some(Run::NotRun));
    }

    #[test]
    fn a_zero_use_result_whose_panel_cant_be_read_is_an_ordinary_failure() {
        let h = home("print-unreadable");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut empty = fixture("usage-pro.json");
        empty["command"]["data"]["groups"] = serde_json::json!([]);
        fake.reply(vec![Ok(empty)]);
        let mut p = provider(&h, &fake);
        let s = p.collect(NOW, false);
        assert!(!p.state.guard_tripped, "the run said it used nothing");
        assert_eq!(p.state.last_error, Some(Diag::UnrecognizedOutput));
        assert_eq!(s.error_code, Some(ErrorCode::FetchFailed));
        assert!(p.state.last_ok.is_none());
    }

    #[test]
    fn the_five_limits_of_a_good_run_are_taken_and_a_token_or_a_cut_run_adds_nothing() {
        let h = home("print-guard");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        let s = p.collect(NOW, false);
        assert_eq!(s.status, ProviderStatus::Ok);
        assert_eq!(s.windows.len(), 5, "{:?}", ids(&s));
        let before = p.state.last_ok.clone();
        // one token used: a stop, and the values before stay as they were (no new observation)
        let mut used = fixture("usage-pro.json");
        used["usage"]["total_tokens"] = serde_json::json!(1);
        used["usage"]["output_tokens"] = serde_json::json!(1);
        fake.reply(vec![Ok(used)]);
        let s = {
            p.confirm_safety(true);
            p.collect(NOW + 20 * MINUTE_MS, true)
        };
        assert!(p.state.guard_tripped);
        assert_eq!(s.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(p.state.last_ok, before, "nothing new taken");
        // forced again, the run is cut (output not read whole): a stop, nothing taken
        fake.reply(vec![Err(Diag::Unverifiable)]);
        {
            p.confirm_safety(true);
            p.collect(NOW + 40 * MINUTE_MS, true)
        };
        assert!(p.state.guard_tripped);
        assert_eq!(p.state.last_ok, before);
        assert_eq!(fake.usages(), 3);
        // and no automatic run while stopped
        p.collect(NOW + 120 * MINUTE_MS, false);
        assert_eq!(fake.usages(), 3);
    }

    #[test]
    fn a_record_of_the_account_alone_moves_the_passive_mark() {
        let h = home("passive-mark");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        let before = p.passive_mark();
        // another account's email, with no limits: taken in, so the round starts no CLI
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        crate::providers::Provider::take_passive(&mut p, NOW + 2 * MINUTE_MS);
        assert!(p.state.account_changed);
        assert_ne!(p.passive_mark(), before);
        assert_eq!(p.last_passive(), None, "no limits taken");
    }

    #[test]
    fn a_denial_is_shared_also_when_zero_use_isn_t_confirmed_or_it_is_told_on_the_error_output() {
        let denied = fixture("usage-permission-denied.sample.json");
        let structured = serde_json::json!({"code": 403, "status": "PERMISSION_DENIED", "message": "Request not allowed"});
        // a turn counted: zero use isn't confirmed, so both stops
        let mut turned = denied.clone();
        turned["num_turns"] = serde_json::json!(1);
        turned["error"] = structured;
        assert!(matches!(
            classify_usage_output(out(&turned.to_string(), "", Some(1))),
            Err(UsageError::Stop(Diag::AccessDeniedUnverified))
        ));
        // zero use confirmed, the denial on the error output only: the service's denial
        let mut plain = denied.clone();
        plain["error"] = serde_json::json!("request failed");
        assert!(matches!(
            classify_usage_output(out(
                &plain.to_string(),
                "Eligibility check failed: PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service.",
                Some(1)
            )),
            Err(UsageError::Retry(Diag::AccessDenied))
        ));
        // the control: an ordinary failure stays one
        assert!(matches!(
            classify_usage_output(out(&plain.to_string(), "", Some(1))),
            Err(UsageError::Retry(Diag::FetchFailed))
        ));
    }

    #[test]
    fn a_rate_limit_upstream_is_a_shared_wait() {
        let mut limited = fixture("usage-permission-denied.sample.json");
        for error in [
            serde_json::json!({"code": 429, "status": "RESOURCE_EXHAUSTED", "message": "Quota exceeded"}),
            serde_json::json!("429 Too Many Requests"),
        ] {
            limited["error"] = error;
            assert!(
                matches!(
                    check_usage_result(&limited, Some(1)),
                    Err(UsageError::Retry(Diag::RateLimited))
                ),
                "{}",
                limited["error"]
            );
        }
        // a collect that met it reports it, so every PC waits
        let h = home("rate-limited");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        fake.reply(vec![Err(Diag::RateLimited)]);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::RateLimited { retry_ms: None }
            ))
        );
    }

    #[test]
    fn a_collect_that_took_a_new_record_puts_the_periodic_version_check_off() {
        let h = home("version-deferred");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        assert_eq!(fake.0.lock().unwrap().versions, 1);
        p.hold_fetch_until(i64::MAX);
        // the hourly check due, and a new record (another account) taken in that collect: no CLI
        let later = NOW + 2 * 60 * MINUTE_MS;
        identify(&h, "b@example.com", later - MINUTE_MS);
        p.collect(later, false);
        assert!(p.state.account_changed);
        assert_eq!(fake.0.lock().unwrap().versions, 1);
        // the next collect, with nothing new: the check
        p.collect(later + MINUTE_MS, false);
        assert_eq!(fake.0.lock().unwrap().versions, 2);
    }

    #[test]
    fn a_state_gone_while_a_switch_waits_still_waits_for_it() {
        let h = home("state-gone-switch");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        statusline(
            &h,
            "b@example.com",
            Some(quota_of("usage-free.json")),
            NOW + MINUTE_MS,
        );
        p.collect(NOW + 2 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        // only the state is gone: B is still a switch to accept, its values not taken as A's history
        std::fs::remove_file(h.join(STATE_FILE)).unwrap();
        let mut again = provider(&h, &fake);
        let s = again.collect(NOW + 3 * MINUTE_MS, false);
        assert!(again.state.account_changed, "the switch still waits");
        assert!(s.windows.is_empty(), "{:?}", ids(&s));
        assert_eq!(s.error_code, Some(ErrorCode::AccountChanged));
    }

    #[test]
    fn a_broken_generation_file_is_written_again_and_new_inputs_are_taken() {
        let h = home("gen-broken");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        statusline(
            &h,
            "b@example.com",
            Some(quota_of("usage-free.json")),
            NOW + MINUTE_MS,
        );
        p.collect(NOW + 2 * MINUTE_MS, false);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(p.state.accept_gen, 1);
        std::fs::write(h.join(ACCEPT_GEN_FILE), b"").unwrap();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(read_accept_gen(&h), 1, "written again");
        // gone: written again too
        std::fs::remove_file(h.join(ACCEPT_GEN_FILE)).unwrap();
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(read_accept_gen(&h), 1);
    }

    #[test]
    fn a_state_lost_after_an_acceptance_takes_no_record_of_before_it() {
        let h = home("lost-after-accept");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        statusline(
            &h,
            "b@example.com",
            Some(quota_of("usage-free.json")),
            NOW + MINUTE_MS,
        );
        p.collect(NOW + 2 * MINUTE_MS, false);
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        // the state is lost: the record left (of before the acceptance) neither identifies nor shows anything
        std::fs::write(h.join(STATE_FILE), b"{broken").unwrap();
        let mut again = provider(&h, &fake);
        let s = again.collect(NOW + 4 * MINUTE_MS, false);
        assert!(s.windows.is_empty(), "{:?}", ids(&s));
        assert_eq!(again.state.account_hash, None);
    }

    #[test]
    fn a_rate_limit_is_told_by_its_code_with_what_says_a_limit_also_on_the_error_output() {
        let mut limited = fixture("usage-permission-denied.sample.json");
        limited["error"] = serde_json::json!({"code": 429, "message": "Quota exceeded"});
        assert!(matches!(
            check_usage_result(&limited, Some(1)),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        // the word alone (a file's name) isn't one
        limited["error"] = serde_json::json!(r#"cannot open local file "resource_exhausted.json""#);
        assert!(!matches!(
            check_usage_result(&limited, Some(1)),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        // on the error output beside a zero-use failure
        limited["error"] = serde_json::json!("request failed");
        assert!(matches!(
            classify_usage_output(out(&limited.to_string(), "429 Too Many Requests", Some(1))),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        // its code on the result, what it says on the error output
        limited["error"] = serde_json::json!({"code": 429, "message": "request failed"});
        assert!(matches!(
            classify_usage_output(out(&limited.to_string(), "Quota exceeded", Some(1))),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        // a number in a name with the word isn't one
        for local in [
            r#"cannot open local quota cache "1429.json""#,
            r#"cannot open local quota cache "quota-429.json""#,
        ] {
            limited["error"] = serde_json::json!(local);
            assert!(!matches!(
                check_usage_result(&limited, Some(1)),
                Err(UsageError::Retry(Diag::RateLimited))
            ));
        }
        // a longer code isn't one; Google's "Error 429:" form is
        limited["error"] = serde_json::json!({"code": 4290, "message": "request failed"});
        assert!(!matches!(
            check_usage_result(&limited, Some(1)),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        limited["error"] = serde_json::json!("googleapi: Error 429: Quota exceeded");
        assert!(matches!(
            check_usage_result(&limited, Some(1)),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        // a structured code alone, the error output empty
        limited["error"] = serde_json::json!({"code": 429, "message": "request failed"});
        assert!(matches!(
            classify_usage_output(out(&limited.to_string(), "", Some(1))),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
        limited["error"] =
            serde_json::json!({"status": "RESOURCE_EXHAUSTED", "message": "request failed"});
        assert!(matches!(
            check_usage_result(&limited, Some(1)),
            Err(UsageError::Retry(Diag::RateLimited))
        ));
    }

    #[test]
    fn an_acceptance_is_for_the_kind_waiting_and_the_changes_the_writers_saw() {
        let h = home("mark-kind");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        fake.reply(vec![Ok(fixture("usage-free.json"))]);
        p.collect(NOW + 6 * MINUTE_MS, false);
        identify(&h, "b@example.com", NOW + 7 * MINUTE_MS);
        p.collect(NOW + 8 * MINUTE_MS, false);
        assert!(p.state.account_changed && p.state.limits_changed);
        // the user saw B's switch with other limits; back to A in another round, only the change of limits waits
        let seen = p.pending_switch();
        identify(&h, "a@example.com", NOW + 9 * MINUTE_MS);
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert!(!p.state.account_changed && p.state.limits_changed);
        p.accept_target(seen);
        p.accept_account();
        p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false), "not what the user saw");
        assert!(p.state.limits_changed);
        // B waiting; the writers saw C, then B again before the next round (the record shows B, its count moved)
        let h = home("mark-round-trip");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        let mut p = provider(&h, &fake);
        p.collect(NOW, false);
        identify(&h, "b@example.com", NOW + MINUTE_MS);
        p.collect(NOW + 2 * MINUTE_MS, false);
        let seen = p.pending_switch();
        identify(&h, "c@example.com", NOW + 3 * MINUTE_MS);
        identify(&h, "b@example.com", NOW + 3 * MINUTE_MS + 10_000);
        p.accept_target(seen);
        p.accept_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(p.state.account_changed);
        // the one now, seen: accepted
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
    }

    #[test]
    fn after_the_same_account_the_statusline_value_before_puts_no_fetch_off() {
        let h = home("same-passive");
        let fake = Fake::default();
        statusline(&h, "a@example.com", Some(quota_of("usage-pro.json")), NOW);
        let mut p = provider(&h, &fake);
        p.hold_fetch_until(i64::MAX);
        p.collect(NOW + MINUTE_MS, false);
        assert!(p.last_passive().is_some());
        statusline(
            &h,
            "a@example.com",
            Some(quota_of("usage-free.json")),
            NOW + 2 * MINUTE_MS,
        );
        p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(p.state.limits_changed);
        p.accept_target(p.pending_switch());
        p.confirm_same_account();
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert!(p.state.refetch);
        assert!(
            p.last_passive().is_none(),
            "the values before put no fetch off"
        );
    }

    #[test]
    fn an_account_the_service_denies_is_an_access_denial_shared_with_every_pc() {
        // the documented ERROR result with every counter 0 (synthetic): an access denial
        let denied = fixture("usage-permission-denied.sample.json");
        assert!(matches!(
            check_usage_result(&denied, Some(1)),
            Err(UsageError::Retry(Diag::AccessDenied))
        ));
        let mut location = denied.clone();
        location["error"] = serde_json::json!(
            "403 PERMISSION_DENIED: Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location."
        );
        assert!(matches!(
            check_usage_result(&location, Some(1)),
            Err(UsageError::Retry(Diag::AccessDenied))
        ));
        // structured, as Google's errors are, also wrapped in `error`
        for structured in [
            serde_json::json!({"code": 403, "status": "PERMISSION_DENIED", "message": "Request not allowed"}),
            serde_json::json!({"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "Request not allowed"}}),
        ] {
            let mut s = denied.clone();
            s["error"] = structured;
            assert!(
                matches!(
                    check_usage_result(&s, Some(1)),
                    Err(UsageError::Retry(Diag::AccessDenied))
                ),
                "{}",
                s["error"]
            );
        }
        // a permission error of another kind (a file), or a local error naming one, isn't one
        for local in [
            serde_json::json!("permission denied: cannot open settings.json"),
            serde_json::json!(r#"cannot open local file "violation of terms of service.txt""#),
            serde_json::json!({"code": 403}),
        ] {
            let mut file = denied.clone();
            file["error"] = local;
            assert!(!matches!(
                check_usage_result(&file, Some(1)),
                Err(UsageError::Retry(Diag::AccessDenied))
            ));
        }
        // on the error output alone (nothing used can't be confirmed): both stops
        assert!(matches!(
            classify_usage_output(out(
                "",
                "Eligibility check failed: PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service.",
                Some(1)
            )),
            Err(UsageError::Stop(Diag::AccessDeniedUnverified))
        ));
        // a collect that met it: an access denial upstream, shown as one; beside a safety stop when unconfirmed
        let h = home("denied");
        let fake = Fake::default();
        identify(&h, "a@example.com", NOW);
        fake.reply(vec![Err(Diag::AccessDenied)]);
        let mut p = provider(&h, &fake);
        let s = p.collect(NOW, false);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::AccessDenied
            ))
        );
        assert_eq!(s.error_code, Some(ErrorCode::AccessDenied));
        fake.reply(vec![Err(Diag::AccessDeniedUnverified)]);
        p.collect(NOW + 20 * MINUTE_MS, true);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::AccessDenied
            ))
        );
        assert!(p.safety_stopped());
    }
}
