//! Claude provider.
//!
//! - **Never does anything that consumes usage quota.**
//! - Primary: runs the official `claude -p "/usage"` on the common schedule (about every 15 minutes) and reads the usage text the CLI
//!   prints (no model is called).
//! - Secondary: statusLine captures (values while the CLI is in use). Per window, the newer value wins; each window keeps its own fetch time.
//! - Safety guards (layered):
//!   1. Pass a nonexistent model name. Also pass a different nonexistent name to `--fallback-model`,
//!      and use `--setting-sources local` so user/project fallback settings are not loaded (verified on a real machine).
//!   2. Check the CLI version before running; don't fetch if it is older than the verified version.
//!   3. After running, stop auto-fetching unless the local-command marker, turn count, cost and token counts are all explicitly 0.
//!      Also stop if this can't be confirmed after launch (timeout, not JSON).
//! - Never touches Claude credentials. Raw CLI output is never written to state, logs or snapshots; only fixed diagnostics are kept.

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, TryLockError};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use crate::time::slept_during;

use super::{Event, Provider};
use crate::config::{ClaudeConfig, claude_json_path};
use crate::schema::{
    ErrorCode, ProviderSnapshot, ProviderStatus, UsageWindow, known_scope, known_window,
    make_window,
};
use crate::statusline::{capture_at, raise_claude_gen, read_capture_since};
use crate::store::{Logger, backoff_ms, fnv1a_hex, read_json, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms};

/// Values older than this are stale (judged at collection time; the display side re-judges with freshnessOf). 20 minutes
pub const STALE_AFTER_MS: i64 = 20 * MINUTE_MS;
const USAGE_TIMEOUT: Duration = Duration::from_secs(60);
const AUTH_TIMEOUT: Duration = Duration::from_secs(15);
/// Max wait for the state-file lock (the other process's /usage run time plus margin)
const LOCK_WAIT: Duration = Duration::from_secs(90);
const STATE_FILE: &str = "state-claude.json";
const LOCK_FILE: &str = "state-claude.lock";
/// How far a saved value's time may be ahead of the clock and still be used (the destination refuses a clock off by more than 2 minutes)
const AHEAD_SLACK_MS: i64 = 2 * MINUTE_MS;
const STATE_VERSION: u32 = 2;
/// Safety guard: a nonexistent model name. `/usage` doesn't use a model, so it is unaffected
pub const GUARD_MODEL: &str = "headroom-no-model-guard";
/// Safety guard: the fallback is also a nonexistent name (if it equals the main model it is dropped as a duplicate and the configured fallback is used)
pub const GUARD_FALLBACK_MODEL: &str = "headroom-no-fallback-guard";
/// Minimum CLI version on which the guards above were verified on a real machine
pub const MIN_VERIFIED_CLI: (u32, u32, u32) = (2, 1, 325);
const WEEK_SECS: i64 = 7 * 24 * 60 * 60;
/// Interval for re-running `claude --version` and `claude auth status`
const AUTH_INTERVAL_MS: i64 = 60 * MINUTE_MS;

/// Fixed diagnostics. Raw CLI output never goes to state, logs or display (it may contain email addresses or tokens).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Diag {
    CliNotFound,
    CliStartFailed,
    UnsupportedCli,
    LoginRequired,
    LoggedOut,
    CliError,
    UnrecognizedOutput,
    UsageTimeout,
    Unverifiable,
    NotLocal,
    AuthTimeout,
    AuthFailed,
    /// The previous /usage was interrupted before its result was checked (abnormal process exit, etc.)
    Interrupted,
    /// An account switch was detected (a single account is assumed)
    AccountChanged,
    /// Cannot write the state file (the attempt marker can't be saved, so /usage is not run)
    StateWriteFailed,
    /// The state file exists but can't be read, or a stop flag in it has an unexpected type. Earlier safety stops can't be
    /// confirmed, so auto-fetch stops
    StateUnreadable,
    /// `/usage` couldn't get new values and showed previous ones (`Showing last-known usage`). Not treated as a new observation
    LastKnownUsage,
    /// `/usage` fetching was rate limited (`rate limited until …`)
    RateLimited,
    /// Signed in with something other than a claude.ai subscription (API key, Bedrock, etc.). No usage-limit lines are shown
    NotSubscription,
    /// Organization managed settings exist, or an organization plan (Team / Enterprise). Disallowed model names are replaced
    /// with the default model, so the nonexistent-model guard doesn't work. /usage is not run
    ManagedPolicy,
    /// The plan or organization managed settings can't be verified (err on the side of not running /usage; resumes on the next check)
    PolicyUnknown,
    /// `claude auth status` doesn't confirm a claude.ai subscription sign-in (unknown `authMethod`). /usage is not run
    AuthUnknown,
    /// The service denies this account (on hold, or not allowed: a 403), shown by a run that confirmed zero use
    AccessDenied,
    /// The service denies this account, shown by a run whose zero use can't be confirmed: both stops (the shared one and the
    /// safety stop)
    AccessDeniedUnverified,
    /// `/usage` didn't finish because the computer slept while it ran: an ordinary failure, tried again at the next check
    Suspended,
}

impl Diag {
    pub fn message(self) -> &'static str {
        match self {
            Diag::CliNotFound => {
                "claude CLI not found (set claude.claude_bin in config.toml, or PATH)"
            }
            Diag::Suspended => {
                "/usage was cut off because the computer slept while it ran; tries again at the next check"
            }
            Diag::CliStartFailed => "Cannot start the claude CLI",
            Diag::UnsupportedCli => {
                "Not running /usage: the claude CLI version can't be checked or is older than the version the safety guards were verified on (2.1.325)"
            }
            Diag::LoginRequired => {
                "Claude CLI sign-in required (run claude auth login in a terminal)"
            }
            Diag::LoggedOut => {
                "Claude CLI signed out, so previous values were discarded (resume with claude auth login)"
            }
            Diag::CliError => "The claude CLI returned an error",
            Diag::UnrecognizedOutput => {
                "Cannot read the /usage output (the format may have changed)"
            }
            Diag::UsageTimeout => {
                "Auto-fetch stopped: /usage did not finish in time, so it can't be confirmed that no quota was consumed. Resume with headroom collect --provider claude --force"
            }
            Diag::Unverifiable => {
                "Auto-fetch stopped: the /usage result doesn't confirm that no quota was consumed. Resume with headroom collect --provider claude --force"
            }
            Diag::NotLocal => {
                "Auto-fetch stopped: /usage may have been sent to a model. Resume with headroom collect --provider claude --force"
            }
            Diag::AuthTimeout => "claude auth status did not finish in time",
            Diag::AuthFailed => "Cannot read the claude auth status result",
            Diag::Interrupted => {
                "Auto-fetch stopped: the previous /usage was interrupted before its result was checked. Resume with headroom collect --provider claude --force"
            }
            Diag::AccountChanged => {
                "Fetching stopped because the Claude account changed. If this is the right account, resume with headroom collect --provider claude --accept-account"
            }
            Diag::StateWriteFailed => "Not running /usage: cannot write the state file",
            Diag::StateUnreadable => {
                "Auto-fetch stopped: the state file couldn't be read, so earlier safety stops can't be confirmed. Resume with headroom collect --provider claude --force"
            }
            Diag::LastKnownUsage => {
                "/usage couldn't get new values and showed previous ones (not treated as a new observation)"
            }
            Diag::RateLimited => "/usage fetching was temporarily rate limited",
            Diag::NotSubscription => {
                "Claude CLI is signed in with something other than a claude.ai subscription (API keys etc. have no usage-limit display)"
            }
            Diag::AuthUnknown => {
                "Not running /usage: claude auth status doesn't confirm a claude.ai subscription sign-in (resumes once confirmed)"
            }
            Diag::PolicyUnknown => {
                "Not running /usage: the plan or organization managed settings can't be verified (resumes once verified)"
            }
            Diag::ManagedPolicy => {
                "Not running /usage: with organization managed settings or an organization plan (Team / Enterprise), zero quota use can't be guaranteed (only statusLine values are used)"
            }
            Diag::AccessDenied => {
                "The service denied access to this Claude account (on hold, or not allowed). Fetching stopped on every PC: check the account, then run the command headroom status shows"
            }
            Diag::AccessDeniedUnverified => {
                "Auto-fetch stopped: the service denied access to this Claude account, and zero quota use couldn't be confirmed. Check the account, then run the command headroom status shows (with --force)"
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
            Diag::LoginRequired | Diag::LoggedOut | Diag::NotSubscription => {
                ErrorCode::LoginRequired
            }
            Diag::UnsupportedCli
            | Diag::UsageTimeout
            | Diag::Unverifiable
            | Diag::NotLocal
            | Diag::Interrupted
            | Diag::StateUnreadable
            | Diag::ManagedPolicy
            | Diag::AccessDeniedUnverified => ErrorCode::SafetyStop,
            Diag::AccessDenied => ErrorCode::AccessDenied,
            Diag::AccountChanged => ErrorCode::AccountChanged,
            _ => ErrorCode::FetchFailed,
        }
    }
}

/// Failure of a `/usage` run
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    /// Clock epoch read when the fetch started (clock.rs): used only while that epoch is current and trusted. None from earlier
    /// versions (never used)
    #[serde(default)]
    pub epoch: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct AccountInfo {
    pub plan: Option<String>,
    pub logged_in: Option<bool>,
    /// Whether signed in with a claude.ai subscription (`authMethod`). None if unknown
    #[serde(default)]
    pub subscription: Option<bool>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ClaudeState {
    pub state_version: u32,
    /// Result of the last successful `/usage`
    pub last_ok: Option<Observation>,
    pub failures: u32,
    /// The last attempt, also one that never launched (the backoff counts from it)
    pub last_attempt_ms: i64,
    /// The last /usage launched (a query that may have gone upstream; 0 = none known). The common schedule compares passive values
    /// with it: an attempt that never launched replaced nothing
    pub last_query_ms: i64,
    pub last_error: Option<Diag>,
    /// Hash of accountUuid + organizationUuid (the values themselves are not stored)
    pub account_hash: Option<String>,
    /// statusLine captures older than this are ignored (account switch / sign-out)
    pub account_switched_ms: i64,
    /// Counts the account switches found (pending_switch): an acceptance is made only for the one the user saw
    pub switch_seq: u64,
    /// The statusLine acceptance generation this state was last accepted in: a record of one before isn't used
    pub accept_gen: u64,
    /// Auto-fetch is stopped because it couldn't be confirmed that no quota was consumed
    pub guard_tripped: bool,
    /// Result of `claude auth status` (no email address or organization ID kept)
    pub account: Option<AccountInfo>,
    pub last_auth_ms: i64,
    pub cli_version: Option<String>,
    /// Whether the CLI version is one with verified safety guards (None = not checked yet)
    pub cli_supported: Option<bool>,
    /// Attempt start time, saved right before launching `/usage` and cleared once the result is checked.
    /// If the next process finds it still set, the attempt's zero use is unverified, so auto-fetch stops
    pub usage_in_flight_ms: Option<i64>,
    /// Stopped after detecting an account switch (resume with a manual --accept-account)
    pub account_changed: bool,
    /// When an account switch was last accepted (0 = never). Used as the history boundary on the server
    pub account_accepted_ms: i64,
    /// The state was started again because it couldn't be read: no statusLine record from before is used, and the next
    /// identification starts a new history (a boundary), as whose history it continues can't be told
    #[serde(default)]
    pub recover_identity: bool,
    /// Organization managed settings or an organization plan were found (/usage is not run, even with --force)
    pub managed_policy: bool,
    /// The latest `claude auth status` was readable. If not, /usage is not run and auth is rechecked at the next fetch opportunity
    pub auth_verified: bool,
    /// Consecutive `claude auth status` failures (the recheck interval grows 1 -> 2 -> 4 ... minutes)
    pub auth_failures: u32,
    /// Time of a statusLine value found stamped ahead of the clock (it has since gone back). That value is never used, also once the
    /// time catches up with it (it would be taken for a fetch at that time); a newer statusLine value replaces it
    pub capture_ahead_ms: Option<i64>,
}

/// Read the state file field by field. Even if observations can't be read (old format etc.), stop flags, intervals and backoff carry over.
/// Only a missing file starts from the initial state. A file that can't be read or parsed, or a stop flag of the wrong type,
/// keeps auto-fetch stopped (a corrupt file must not clear a safety stop)
pub fn load_state(path: &Path) -> ClaudeState {
    state_from(std::fs::read(path))
}

/// The state as load_state reads it, or None when the file exists but can't be read (an I/O error: a later read may still find the values
/// in it). Contents that aren't a state are read as load_state reads them (never as values)
fn read_state(path: &Path) -> Option<ClaudeState> {
    match std::fs::read(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => None,
        read => Some(state_from(read)),
    }
}

fn state_from(read: std::io::Result<Vec<u8>>) -> ClaudeState {
    let initial = ClaudeState {
        state_version: STATE_VERSION,
        ..Default::default()
    };
    let unreadable = ClaudeState {
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
    // A stop flag that is present but not a boolean (or a marker that is not a number) is treated as "stopped"
    // A state of this version always carries its safety stop: one without it can't say it isn't stopped
    let current = v["state_version"].as_u64() == Some(STATE_VERSION as u64);
    let flag_ok = |k: &str| match v.get(k) {
        None => !(current && k == "guard_tripped"),
        Some(x) => x.is_boolean(),
    };
    let flags_ok = ["guard_tripped", "account_changed", "managed_policy"]
        .iter()
        .all(|k| flag_ok(k))
        && v.get("usage_in_flight_ms")
            .is_none_or(|x| x.is_null() || x.is_i64());
    let i = |k: &str| v[k].as_i64().unwrap_or(0);
    fn from<T: serde::de::DeserializeOwned>(v: &Value, k: &str) -> Option<T> {
        serde_json::from_value(v[k].clone()).ok()
    }
    ClaudeState {
        state_version: STATE_VERSION,
        // The old format (v1 windows) can't be read as v2 types, so it is discarded
        last_ok: from(&v, "last_ok"),
        failures: v["failures"]
            .as_u64()
            .map_or(0, |n| n.min(u32::MAX as u64) as u32),
        last_attempt_ms: i("last_attempt_ms"),
        last_query_ms: i("last_query_ms"),
        // Drop the old free-text last_error (it may contain CLI text)
        last_error: if flags_ok {
            from(&v, "last_error")
        } else {
            Some(Diag::StateUnreadable)
        },
        account_hash: v["account_hash"].as_str().map(str::to_string),
        account_switched_ms: i("account_switched_ms"),
        switch_seq: v["switch_seq"].as_u64().unwrap_or(0),
        accept_gen: v["accept_gen"].as_u64().unwrap_or(0),
        guard_tripped: v["guard_tripped"].as_bool().unwrap_or(false) || !flags_ok,
        account: from(&v, "account"),
        last_auth_ms: i("last_auth_ms"),
        cli_version: v["cli_version"].as_str().map(str::to_string),
        cli_supported: v["cli_supported"].as_bool(),
        usage_in_flight_ms: v["usage_in_flight_ms"].as_i64(),
        account_changed: v["account_changed"].as_bool().unwrap_or(false),
        account_accepted_ms: i("account_accepted_ms"),
        recover_identity: v["recover_identity"].as_bool().unwrap_or(false) || !flags_ok,
        managed_policy: v["managed_policy"].as_bool().unwrap_or(false),
        auth_verified: v["auth_verified"].as_bool().unwrap_or(false),
        capture_ahead_ms: v["capture_ahead_ms"].as_i64(),
        auth_failures: v["auth_failures"]
            .as_u64()
            .map_or(0, |n| n.min(u32::MAX as u64) as u32),
    }
}

/// Calls to the claude CLI. Replaced in tests.
pub trait ClaudeCli: Send {
    fn version(&mut self) -> Result<String, Diag>;
    fn auth_status(&mut self) -> Result<AccountInfo, Diag>;
    fn usage(&mut self, cwd: &Path) -> Result<String, UsageError>;
    /// What the next usage call needs found first (the executable), done before the go's last check: between that check and the
    /// launch, nothing but the launch. Default: nothing
    fn prepare_usage(&mut self) {}
    /// Whether this PC has organization managed settings (files / policies). Contents are not read
    fn managed_settings(&mut self) -> Managed;
}

pub struct RealCli {
    bin: String,
    /// The executable found by prepare_usage, for the next usage call only
    prepared: Option<Option<PathBuf>>,
}

impl RealCli {
    pub fn new(bin: String) -> Self {
        Self {
            bin,
            prepared: None,
        }
    }

    fn command(&self) -> Result<Command, Diag> {
        let path = resolve_bin(&self.bin).ok_or(Diag::CliNotFound)?;
        Ok(Self::command_at(&path))
    }

    fn command_at(path: &Path) -> Command {
        let mut cmd = background_command(&path.to_string_lossy());
        strip_host_env(&mut cmd);
        cmd
    }
}

impl ClaudeCli for RealCli {
    fn version(&mut self) -> Result<String, Diag> {
        let mut cmd = self.command()?;
        cmd.arg("--version");
        let out = run_with_timeout(cmd, AUTH_TIMEOUT).map_err(|e| match e {
            RunError::NotFound => Diag::CliNotFound,
            RunError::StartFailed => Diag::CliStartFailed,
            RunError::Timeout | RunError::Suspended => Diag::AuthTimeout,
        })?;
        parse_version(&out.stdout)
            .map(|(a, b, c)| format!("{a}.{b}.{c}"))
            .ok_or(Diag::UnrecognizedOutput)
    }

    fn auth_status(&mut self) -> Result<AccountInfo, Diag> {
        let mut cmd = self.command()?;
        cmd.args(["auth", "status"]);
        let out = run_with_timeout(cmd, AUTH_TIMEOUT).map_err(|e| match e {
            RunError::NotFound => Diag::CliNotFound,
            RunError::StartFailed => Diag::CliStartFailed,
            RunError::Timeout | RunError::Suspended => Diag::AuthTimeout,
        })?;
        match serde_json::from_str::<Value>(out.stdout.trim()) {
            Ok(v) => Ok(parse_auth_status(&v, out.success)),
            // Exit code 1 means not signed in (official CLI reference). Decidable even if the body can't be read
            Err(_) if !out.success => Ok(AccountInfo {
                logged_in: Some(false),
                ..AccountInfo::default()
            }),
            Err(_) => Err(Diag::AuthFailed),
        }
    }

    fn managed_settings(&mut self) -> Managed {
        managed_settings_state()
    }

    fn prepare_usage(&mut self) {
        self.prepared = Some(resolve_bin(&self.bin));
    }

    fn usage(&mut self, cwd: &Path) -> Result<String, UsageError> {
        // The working folder and the executable were found before the go's last check: nothing more but the launch here (a folder
        // that isn't there fails the launch)
        let mut cmd = match self.prepared.take() {
            Some(found) => Self::command_at(&found.ok_or(UsageError::Retry(Diag::CliNotFound))?),
            None => self.command().map_err(UsageError::Retry)?,
        };
        cmd.args(usage_args()).current_dir(cwd);
        classify_usage_run(run_capturing(cmd, USAGE_TIMEOUT))
    }
}

/// State-file lock (used by both the resident agent and manual collection). The OS releases it when the file is closed.
struct StateLock {
    _file: File,
}

impl StateLock {
    fn acquire(home: &Path, wait: Duration) -> Option<Self> {
        std::fs::create_dir_all(home).ok()?;
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(home.join(LOCK_FILE))
            .ok()?;
        let deadline = Instant::now() + wait;
        loop {
            match file.try_lock() {
                Ok(()) => return Some(Self { _file: file }),
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100))
                }
                Err(_) => return None,
            }
        }
    }
}

pub struct ClaudeProvider {
    home: PathBuf,
    cfg: ClaudeConfig,
    log: Logger,
    pub state: ClaudeState,
    claude_json: PathBuf,
    /// The account this process identified last (in memory: a state read back that doesn't know it reads .claude.json again)
    identified_hash: Option<String>,
    /// The state file couldn't be read: when it is read again (nothing is due before)
    state_retry_at: Option<i64>,
    claude_json_mtime: Option<SystemTime>,
    plan: Option<String>,
    capture: Option<(i64, Vec<UsageWindow>)>,
    /// What the last collect did upstream (take_run)
    run: Option<super::Run>,
    /// The go this collect was allowed by: its time limit (this PC's clock) and when it was given (monotonic). Past either, the query
    /// isn't started (the destination may have replaced the go)
    fetch_deadline: Option<super::Grant>,
    /// The user's explicit go past a safety stop, for the next collect only
    safety_confirmed: bool,
    /// The switch the next acceptance is for (the mark pending_switch gave when the user asked)
    accept_target: Option<i64>,
    /// This collect only takes the statusLine record (take_passive): no CLI is started
    passive_only: bool,
    capture_dirty: bool,
    tz: TimeZone,
    cli: Box<dyn ClaudeCli>,
    /// On the next collect, clear the stop caused by an account switch
    accept_account_pending: bool,
    /// Hold off `/usage` until this time (the resident agent's fetch scheduling; statusLine capture continues)
    fetch_hold_until_ms: i64,
    /// The clock read once the state file is locked and read again (None in tests: the time passed to collect)
    clock: Option<fn() -> i64>,
    /// Clock epoch read when the current collect started (clock.rs). Values are taken in and used only under it; None: none usable
    epoch: Option<u64>,
    /// The account switch the last collect accepted: Some(true) once saved, Some(false) if accepting or saving failed
    accepted: Option<bool>,
}

impl ClaudeProvider {
    pub fn new(home: &Path, cfg: ClaudeConfig, log: Logger) -> Self {
        let cli = Box::new(RealCli::new(claude_bin(&cfg)));
        let mut p = Self::with_cli(home, cfg, log, cli);
        p.claude_json = claude_json_path();
        p.clock = Some(crate::time::now_ms);
        p
    }

    pub fn with_cli(home: &Path, cfg: ClaudeConfig, log: Logger, cli: Box<dyn ClaudeCli>) -> Self {
        Self {
            home: home.to_path_buf(),
            cfg,
            log,
            state: load_state(&home.join(STATE_FILE)),
            claude_json: home.join("nonexistent-claude.json"),
            identified_hash: None,
            state_retry_at: None,
            claude_json_mtime: None,
            plan: None,
            capture: None,
            run: None,
            passive_only: false,
            fetch_deadline: None,
            safety_confirmed: false,
            accept_target: None,
            capture_dirty: true,
            tz: TimeZone::system(),
            cli,
            accept_account_pending: false,
            // The epoch now (each collect reads it again)
            epoch: crate::clock::usable_epoch(home),
            accepted: None,
            fetch_hold_until_ms: 0,
            clock: None,
        }
    }

    pub fn set_claude_json(&mut self, path: PathBuf) {
        self.claude_json = path;
        self.claude_json_mtime = None;
    }

    /// Time zone used when a `/usage` time has no zone name (defaults to the OS setting)
    pub fn set_time_zone(&mut self, tz: TimeZone) {
        self.tz = tz;
    }

    /// When `/usage` may next run (at least the floor between fetches after the last, the common schedule planning the interval;
    /// extended up to 60 minutes on repeated failures)
    pub fn usage_due_ms(&self, now: i64) -> i64 {
        let account = self.state.account.as_ref();
        // No schedule while /usage won't run (the next version/auth check wakes us; keeps the agent from waking every second)
        if !self.cfg.enabled
            || self.state.guard_tripped
            || self.state.account_changed
            || self.state.cli_supported != Some(true)
            || self.state.managed_policy
            || !self.state.auth_verified
            || account.is_none_or(|a| a.subscription != Some(true) || a.logged_in == Some(false))
        {
            return i64::MAX;
        }
        // An attempt saved while the clock ran ahead (it has since gone back): due now, so collect rewrites it to now once and the next
        // run then waits the interval (and backoff) from that time instead of until the clock catches up
        if self.state.last_attempt_ms > now {
            return now;
        }
        let interval = self.cfg.interval_min.max(1) * MINUTE_MS;
        // A value fetched ahead of the clock doesn't set the schedule (the attempt that fetched it does)
        let last_ok = self
            .state
            .last_ok
            .as_ref()
            .filter(|o| o.epoch.is_some() && o.epoch == crate::clock::usable_epoch(&self.home))
            .map_or(0, |o| o.fetched_ms);
        let last_ok = if last_ok > now { 0 } else { last_ok };
        let last_attempt = self.state.last_attempt_ms;
        let by_success = last_ok.saturating_add(interval);
        let by_attempt = last_attempt.saturating_add(backoff_ms(interval, self.state.failures));
        let normal = by_success.max(by_attempt);
        // If the overall limit is maxed out, extend the interval until reset (statusLine values are passive and unaffected)
        let blocked_until = self
            .build(now)
            .blocked_until_ms(last_attempt)
            .unwrap_or(i64::MIN);
        normal.max(blocked_until).max(self.fetch_hold_until_ms)
    }

    /// When to next check the version and auth. Independent of the `/usage` schedule; keeps checking while stopped or while the CLI is missing
    pub fn cli_check_due_ms(&self, now: i64) -> i64 {
        if !self.cfg.enabled {
            return i64::MAX;
        }
        if self.state.cli_supported.is_none() {
            return 0;
        }
        // If auth couldn't be verified, recheck after 1 -> 2 -> 4 ... minutes (max 60) instead of waiting an hour
        // (while stopped at the version check without checking auth, stay on the hourly version check)
        let wait = if self.state.auth_verified || self.state.auth_failures == 0 {
            AUTH_INTERVAL_MS
        } else {
            backoff_ms(MINUTE_MS, self.state.auth_failures.saturating_sub(1)).min(AUTH_INTERVAL_MS)
        };
        // A check saved while the clock ran ahead: due now, so collect rewrites it to now once (as for /usage)
        if self.state.last_auth_ms > now {
            return now;
        }
        self.state.last_auth_ms.saturating_add(wait)
    }

    fn log_diag(&self, what: &str, d: Diag) {
        self.log
            .log(&format!("claude: {what}: {} {}", d.code(), d.message()));
    }

    /// Invalidate previous observations (account switch / sign-out). Old statusLine captures are no longer used either.
    fn invalidate(&mut self, now: i64) {
        self.state.last_ok = None;
        self.state.failures = 0;
        self.state.account_switched_ms = now;
        self.capture = None;
    }

    /// The account .claude.json shows now, read whatever its time (None: it can't be read, or names no account)
    fn current_account_hash(&self) -> Option<String> {
        let v = read_json::<Value>(&self.claude_json)?;
        let acct = &v["oauthAccount"];
        let uuid = acct["accountUuid"].as_str()?;
        Some(fnv1a_hex(&[
            uuid,
            acct["organizationUuid"].as_str().unwrap_or(""),
        ]))
    }

    /// Read .claude.json only when it changed, to detect account switches and infer the plan.
    fn refresh_account(&mut self, now: i64) {
        let mtime = std::fs::metadata(&self.claude_json)
            .and_then(|m| m.modified())
            .ok();
        if mtime.is_none() || mtime == self.claude_json_mtime {
            return;
        }
        let Some(v) = read_json::<Value>(&self.claude_json) else {
            return;
        };
        let acct = &v["oauthAccount"];
        let Some(uuid) = acct["accountUuid"].as_str() else {
            return;
        };
        self.claude_json_mtime = mtime;
        let hash = fnv1a_hex(&[uuid, acct["organizationUuid"].as_str().unwrap_or("")]);
        // Identified again after the state was lost: a new history starts here
        if self.state.account_hash.is_none() && std::mem::take(&mut self.state.recover_identity) {
            self.state.account_accepted_ms = now;
            self.state.account_switched_ms = self.state.account_switched_ms.max(now);
            self.log.log("claude: identified the account again after the state was lost; a new history starts");
        }
        if self
            .state
            .account_hash
            .as_deref()
            .is_some_and(|prev| prev != hash)
        {
            self.invalidate(now);
            self.state.account = None;
            self.state.last_auth_ms = 0;
            // A single account is assumed. Stop until manually resumed so another account's values don't mix into history
            self.state.account_changed = true;
            self.state.switch_seq = self.state.switch_seq.wrapping_add(1);
            self.state.last_error = Some(Diag::AccountChanged);
            self.log_diag("account", Diag::AccountChanged);
        }
        self.state.account_hash = Some(hash);
        self.identified_hash = self.state.account_hash.clone();
        self.plan = [
            "userRateLimitTier",
            "organizationRateLimitTier",
            "billingType",
        ]
        .iter()
        .filter_map(|k| acct[*k].as_str())
        .find_map(plan_from_tier);
    }

    /// Check the CLI version and sign-in state every hour (both local, no quota use).
    fn refresh_cli(&mut self, now: i64, force: bool) {
        let due = now >= self.cli_check_due_ms(now);
        if !force && !due {
            return;
        }
        self.state.last_auth_ms = now;
        match self.cli.version() {
            Ok(v) => {
                let ok = parse_version(&v).is_some_and(|ver| ver >= MIN_VERIFIED_CLI);
                self.state.cli_version = Some(v);
                self.state.cli_supported = Some(ok);
                if !ok {
                    self.set_check_error(Diag::UnsupportedCli);
                    self.log_diag("version", Diag::UnsupportedCli);
                    return;
                }
                if self.state.last_error == Some(Diag::UnsupportedCli) {
                    self.state.last_error = None;
                }
            }
            Err(d) => {
                self.state.cli_supported = Some(false);
                self.set_check_error(d);
                self.log_diag("version", d);
                return;
            }
        }
        match self.cli.auth_status() {
            Ok(a) => {
                if a.logged_in == Some(false) {
                    if self.state.last_ok.is_some() || self.capture.is_some() {
                        self.log_diag("auth", Diag::LoggedOut);
                    }
                    self.invalidate(now);
                    self.set_check_error(Diag::LoggedOut);
                }
                if a.logged_in != Some(false) && a.subscription == Some(false) {
                    // API keys etc. show no usage-limit lines. Previous values aren't used either
                    self.invalidate(now);
                    self.set_check_error(Diag::NotSubscription);
                } else if self.state.last_error == Some(Diag::NotSubscription) {
                    self.state.last_error = None;
                }
                self.state.account = Some(a);
                self.state.auth_verified = true;
                self.state.auth_failures = 0;
            }
            Err(d) => {
                self.state.auth_verified = false;
                self.state.auth_failures = self.state.auth_failures.saturating_add(1);
                self.log_diag("auth", d);
            }
        }
        let check = self.policy_check();
        self.apply_policy(check);
    }

    /// With organization managed settings or an organization plan, a nonexistent model name is replaced with the default model and the guard doesn't work.
    /// Also err on the side of not running when the plan is unknown or managed settings can't be checked
    fn policy_check(&mut self) -> Option<Diag> {
        // Signed out / non-subscription already block /usage for another reason (keep that reason on display)
        let account = self.state.account.as_ref();
        if account.is_some_and(|a| a.logged_in == Some(false) || a.subscription == Some(false)) {
            return None;
        }
        let plan = account.and_then(|a| a.plan.as_deref());
        // If the latest auth check failed, don't trust the previous plan (the plan or account may have changed meanwhile)
        if !self.state.auth_verified {
            return Some(Diag::PolicyUnknown);
        }
        if account.and_then(|a| a.subscription) != Some(true) {
            return Some(Diag::AuthUnknown);
        }
        match plan {
            Some(p) if ORGANIZATION_PLANS.contains(&p) => return Some(Diag::ManagedPolicy),
            Some(p) if PERSONAL_PLANS.contains(&p) => {}
            _ => return Some(Diag::PolicyUnknown),
        }
        match self.cli.managed_settings() {
            Managed::Absent => None,
            Managed::Present => Some(Diag::ManagedPolicy),
            Managed::Unknown => Some(Diag::PolicyUnknown),
        }
    }

    fn apply_policy(&mut self, check: Option<Diag>) {
        if check.is_some() && !self.state.managed_policy {
            self.log_diag("policy", check.unwrap_or(Diag::ManagedPolicy));
        }
        self.state.managed_policy = check.is_some();
        match check {
            Some(d) => self.set_check_error(d),
            None if matches!(
                self.state.last_error,
                Some(Diag::ManagedPolicy | Diag::PolicyUnknown | Diag::AuthUnknown)
            ) =>
            {
                self.state.last_error = None
            }
            None => {}
        }
    }

    /// Record a problem found by the version/auth check. While stopped by a safety guard, don't overwrite the stop reason
    fn set_check_error(&mut self, d: Diag) {
        if !self.state.guard_tripped {
            self.state.last_error = Some(d);
        }
    }

    /// Whether the go this collect was allowed by is no longer to be used (`now`: read after the state lock was waited for)
    fn deadline_passed(&self, now: i64) -> bool {
        self.fetch_deadline.is_some_and(|g| g.passed(now))
    }

    fn fetch_usage(&mut self, now: i64) {
        let before = self.state.last_attempt_ms;
        self.state.last_attempt_ms = now;
        // Save "in flight" before launching. If it can't be saved, don't launch
        self.state.usage_in_flight_ms = Some(now);
        if write_json_atomic(&self.home.join(STATE_FILE), &self.state).is_err() {
            self.state.usage_in_flight_ms = None;
            self.state.failures = self.state.failures.saturating_add(1);
            self.state.last_error = Some(Diag::StateWriteFailed);
            self.log_diag("usage", Diag::StateWriteFailed);
            return;
        }
        let _ = std::fs::create_dir_all(self.home.join("claude-cwd"));
        self.cli.prepare_usage();
        // The go checked again right before the launch, after the save (a sleep while saving): past it, nothing is launched
        let launch_now = self.clock.map_or(now, |clock| clock());
        if self.deadline_passed(launch_now) {
            self.state.usage_in_flight_ms = None;
            self.state.last_attempt_ms = before;
            let _ = write_json_atomic(&self.home.join(STATE_FILE), &self.state);
            self.log.log(
                "claude: the fetch turn came too long ago; not fetched (asked again next round)",
            );
            return;
        }
        let cwd = self.home.join("claude-cwd");
        let tz = self.tz.clone();
        // From here the query may run: its outcome is unknown until checked below
        self.run = Some(super::Run::Unknown);
        let query_before = self.state.last_query_ms;
        self.state.last_query_ms = now;
        let result = self.cli.usage(&cwd).and_then(|text| {
            let lower = text.to_ascii_lowercase();
            // Rate limited also when the last-known values are shown with it (they aren't a new observation either way)
            if super::says_rate_limited(&lower) {
                return Err(UsageError::Retry(Diag::RateLimited));
            }
            if lower.contains("last-known usage") {
                return Err(UsageError::Retry(Diag::LastKnownUsage));
            }
            let windows = parse_usage_text(&text, now, &tz);
            if windows.is_empty() {
                Err(UsageError::Retry(Diag::UnrecognizedOutput))
            } else {
                Ok(windows)
            }
        });
        // The result was checked (failed to launch, confirmed zero use, or safety-stopped), so clear the marker
        self.state.usage_in_flight_ms = None;
        // A safety stop leaves the outcome unknown
        self.run = Some(match &result {
            Ok(_) => super::Run::Ran(super::Outcome::Ok),
            Err(UsageError::Retry(Diag::CliNotFound | Diag::CliStartFailed)) => {
                // Never launched: not a query (the backoff still counts the attempt)
                self.state.last_query_ms = query_before;
                super::Run::NotRun
            }
            Err(UsageError::Retry(Diag::RateLimited)) => {
                super::Run::Ran(super::Outcome::RateLimited { retry_ms: None })
            }
            // The service denied the account: shared with every PC (also beside a safety stop)
            Err(UsageError::Retry(Diag::AccessDenied))
            | Err(UsageError::Stop(Diag::AccessDeniedUnverified)) => {
                super::Run::Ran(super::Outcome::AccessDenied)
            }
            Err(UsageError::Retry(_)) => super::Run::Ran(super::Outcome::Failed),
            Err(UsageError::Stop(_)) => super::Run::Unknown,
        });
        // Used only in the clock epoch it started in and for the account it started with (read again now)
        let account_before = self.state.account_hash.clone();
        let same_epoch = crate::clock::usable_epoch(&self.home) == self.epoch;
        if result.is_ok() && same_epoch {
            self.refresh_account(now);
        }
        // An account known before is read again now, whatever the file's time: one that can't be read (gone, or naming no account)
        // isn't the one the fetch started with
        let same_account = !self.state.account_changed
            && self.state.account_hash == account_before
            && (account_before.is_none() || self.current_account_hash() == account_before);
        if result.is_ok() && !(same_epoch && same_account) {
            self.run = Some(super::Run::Ran(super::Outcome::Failed));
            self.log.log(
                "claude: the clock state or the account changed during the fetch: its result isn't used",
            );
            return;
        }
        match result {
            Ok(windows) => {
                self.state.last_ok = Some(Observation {
                    fetched_ms: now,
                    windows,
                    epoch: self.epoch,
                });
                self.state.failures = 0;
                self.state.last_error = None;
                self.state.guard_tripped = false;
            }
            Err(UsageError::Retry(d)) => {
                self.state.failures = self.state.failures.saturating_add(1);
                if d == Diag::LoginRequired {
                    // Sign-in expired: don't keep showing the previous account's values
                    self.invalidate(now);
                    self.state.failures = 1;
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

    /// Overlay newer statusLine windows on the `/usage` windows. Each window carries its actual fetch time,
    /// and the provider's fetched_at and status come from the **oldest window** (old windows never look fresh).
    fn build(&self, now: i64) -> ProviderSnapshot {
        // The clock epoch usable now: values of another one are neither shown nor used for the schedule
        let epoch = crate::clock::usable_epoch(&self.home);
        if self.state.account_changed {
            // While stopped by a switch, the switch stop wins over other version/auth diagnostics, and no values are shown
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                Diag::AccountChanged.message(),
                Some(ErrorCode::AccountChanged),
            );
        }
        // A value stamped ahead of the clock (fetched while it ran ahead; it has since gone back) is neither shown nor used for the
        // schedule: it would hold the next fetch off, and a statusLine value ahead would replace a newer /usage value
        let in_time = |at: i64| at <= now.saturating_add(AHEAD_SLACK_MS);
        let usage = self
            .state
            .last_ok
            .as_ref()
            .filter(|u| u.epoch.is_some() && u.epoch == epoch && in_time(u.fetched_ms));
        // Only Claude's usage-limit windows (values saved by an older version may hold others, such as extra usage).
        // blocked is computed from these alone
        let mut windows: Vec<_> = usage
            .into_iter()
            .flat_map(|u| u.windows.iter().map(|w| (w.clone(), u.fetched_ms)))
            .filter(|(w, _)| is_claude_window(&w.id))
            .collect();
        if let Some((at, ws)) = &self.capture
            && self.epoch.is_some()
            && self.epoch == epoch
            && in_time(*at)
            && usage.is_none_or(|u| *at > u.fetched_ms)
        {
            for w in ws.iter().filter(|w| is_claude_window(&w.id)) {
                let sample = (w.clone(), *at);
                match windows.iter_mut().find(|(m, _)| m.id == w.id) {
                    Some(m) => *m = sample,
                    None => windows.push(sample),
                }
            }
        }
        // While stopped by a safety guard, return safety_stop even if there are other diagnostics
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
        let plan = self
            .state
            .account
            .as_ref()
            .and_then(|a| a.plan.clone())
            .or_else(|| self.plan.clone());
        let history_since = (self.state.account_accepted_ms > 0)
            .then(|| iso_from_ms(self.state.account_accepted_ms));
        let Some(fetched) = windows.iter().map(|(_, at)| *at).min() else {
            return ProviderSnapshot {
                plan,
                history_since,
                ..ProviderSnapshot::empty(
                    match error_code {
                        Some(
                            ErrorCode::LoginRequired
                            | ErrorCode::NotInstalled
                            | ErrorCode::AccountChanged,
                        ) => ProviderStatus::Unavailable,
                        _ => ProviderStatus::Error,
                    },
                    message.unwrap_or_else(|| "No value yet".into()),
                    error_code,
                )
            };
        };
        let age = now - fetched;
        // After a rate limit (429), the values before are shown as old, with their own time
        let fresh = age <= STALE_AFTER_MS && self.state.last_error != Some(Diag::RateLimited);
        // Only "blocked" when the overall limit (scope: null) is maxed out. Per-model limits don't count
        let blocked = windows
            .iter()
            .any(|(w, _)| w.scope.is_none() && w.used_percent >= 100.0);
        ProviderSnapshot {
            status: if fresh {
                ProviderStatus::Ok
            } else {
                ProviderStatus::Stale
            },
            fetched_at: Some(iso_from_ms(fetched)),
            collector: None,
            error: if fresh {
                message
            } else {
                Some(message.unwrap_or_else(|| format!("Not updated for {}m", age / MINUTE_MS)))
            },
            error_code,
            plan,
            blocked: Some(blocked),
            history_since,
            windows: windows
                .into_iter()
                .map(|(w, at)| w.with_fetched_ms(at))
                .collect(),
        }
    }
}

impl Provider for ClaudeProvider {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn next_due_ms(&self, now: i64) -> i64 {
        // A state that couldn't be read is read again a minute on: nothing is due before
        if let Some(at) = crate::time::reread_due(self.state_retry_at, now) {
            return at;
        }
        // A record written is taken at once, unless turned off (nothing is taken then)
        if self.capture_dirty && self.cfg.enabled {
            return now;
        }
        self.usage_due_ms(now).min(self.cli_check_due_ms(now))
    }

    fn collect(&mut self, now: i64, force: bool) -> ProviderSnapshot {
        self.run = Some(super::Run::NotRun);
        // Asked for this collect only, and taken before anything can end it early: an acceptance never waits for a later one, and
        // one this collect doesn't make is reported as not made
        let asked = std::mem::take(&mut self.accept_account_pending);
        let target = self.accept_target.take();
        let confirmed = std::mem::take(&mut self.safety_confirmed);
        self.accepted = asked.then_some(false);
        if !self.cfg.enabled {
            self.capture_dirty = false;
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                "Disabled in config",
                None,
            );
        }
        // The resident agent and manual collection share state, so reload the latest state under the lock before deciding and saving.
        // Without the lock, neither fetch nor save (never write back stale state).
        let Some(_lock) = StateLock::acquire(&self.home, LOCK_WAIT) else {
            self.log
                .log("claude: skipped this round: could not lock the state file");
            // A state still unread is read again a minute on (not every second while the lock is held)
            if self.state_retry_at.is_some() {
                self.state_retry_at = Some(self.clock.map_or(now, |clock| clock()) + MINUTE_MS);
            }
            return self.build(now);
        };
        let state_path = self.home.join(STATE_FILE);
        let state_gone = !state_path.exists();
        let Some(state) = read_state(&state_path) else {
            // Read again a minute on (said once until it can be read): a record waiting is taken then
            if self.state_retry_at.is_none() {
                self.log
                    .log("claude: skipped this round: the state file couldn't be read (read again every minute)");
            }
            self.state_retry_at = Some(self.clock.map_or(now, |clock| clock()) + MINUTE_MS);
            return self.build(now);
        };
        self.state_retry_at = None;
        self.state = state;
        // A state that is gone starts again knowing the account it knew (another one seen is a switch)
        if state_gone && self.state.account_hash.is_none() {
            self.state.account_hash = crate::store::known_account(&self.home, "claude");
            self.identified_hash = self.state.account_hash.clone();
        }
        // A generation file broken since the last acceptance is written again with this state's
        if crate::statusline::repair_claude_gen(&self.home, self.state.accept_gen) {
            self.log
                .log("claude: the statusLine generation file was broken; written again");
        }
        // A state that doesn't know the account this process identified last (that save failed, or another process saved): the file
        // is read again, whatever its time
        if self.state.account_hash != self.identified_hash {
            self.claude_json_mtime = None;
        }
        // Started again from a state that couldn't be read: .claude.json is read again, and no statusLine record from before now
        // is used (whose account it was can't be told)
        if self.state.recover_identity {
            self.claude_json_mtime = None;
            if self.state.account_switched_ms == 0 {
                self.state.account_switched_ms = self.clock.map_or(now, |clock| clock());
            }
        }
        // The clock epoch this collect works under: values of another one are neither used nor shown, and nothing is fetched
        // without one (the clock isn't trusted now)
        self.epoch = crate::clock::usable_epoch(&self.home);
        // The time is read again now: while this run waited (for the lock or the fetch turn), another process (a manual collect) may
        // have fetched and saved, and that is not ahead of the clock
        let now = self.clock.map_or(now, |clock| clock());
        // Times saved while the clock ran ahead (it has since gone back) are taken as now, once: the minimum interval and the backoff
        // then count from this moment
        self.state.last_attempt_ms = self.state.last_attempt_ms.min(now);
        self.state.last_auth_ms = self.state.last_auth_ms.min(now);
        // A /usage value stamped ahead of the clock is dropped (another process's save came before this read, so it isn't ahead): once
        // the time caught up with it, it would pass for a value fetched then
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
        // The account as it is now first: an acceptance is for the switch the user saw, never one found after it
        if asked {
            self.refresh_account(now);
        }
        // An acceptance only under a usable clock epoch (one that can't be confirmed now isn't made; the switch stays pending), and only
        // of the switch the user saw (another seen since isn't the one they checked)
        if asked && !self.state.account_changed {
            self.log
                .log("claude: no account switch waits to be accepted; nothing was accepted");
        }
        if asked && self.state.account_changed && target != Some(self.state.switch_seq as i64) {
            self.log.log(
                "claude: the account switch shown changed since you asked (check headroom status, then accept again); nothing was accepted",
            );
        }
        // The account switched to must be the one .claude.json shows now (one that can't be read isn't confirmed)
        let shown_now = self.current_account_hash();
        let confirmed_account =
            shown_now.is_some() && shown_now.as_deref() == self.state.account_hash.as_deref();
        if asked
            && self.state.account_changed
            && target == Some(self.state.switch_seq as i64)
            && !confirmed_account
        {
            self.log.log(
                "claude: the account can't be read now (sign in again, then accept again); nothing was accepted",
            );
        }
        // Under the statusLine writers' lock, with the generation raised (an input of the account before is never saved after)
        let raised = (asked
            && self.state.account_changed
            && target == Some(self.state.switch_seq as i64)
            && confirmed_account
            && self.epoch.is_some())
        .then(|| raise_claude_gen(&self.home, self.state.accept_gen));
        if let Some(Err(e)) = &raised {
            self.log.log(&format!(
                "claude: couldn't mark the acceptance for the statusLine ({}); nothing was accepted",
                e.kind()
            ));
        }
        if let Some(Ok((next_gen, _writers))) = raised {
            // Saved at once and by itself, before anything else is saved or run: what is said (and logged) is what was saved. One
            // that can't be saved isn't made (the switch stays pending, so nothing is fetched)
            let before = (
                self.state.account_changed,
                self.state.account_accepted_ms,
                self.state.last_error,
            );
            let gen_before = self.state.accept_gen;
            self.state.account_changed = false;
            self.state.account_accepted_ms = now;
            self.state.accept_gen = next_gen;
            if self.state.last_error == Some(Diag::AccountChanged) {
                self.state.last_error = None;
            }
            match write_json_atomic(&state_path, &self.state) {
                Ok(()) => {
                    self.accepted = Some(true);
                    self.log
                        .log("claude: accepted the account switch and resumed fetching");
                }
                Err(e) => {
                    (
                        self.state.account_changed,
                        self.state.account_accepted_ms,
                        self.state.last_error,
                    ) = before;
                    self.state.accept_gen = gen_before;
                    self.log.log(&format!(
                        "claude: couldn't save the account acceptance: {}",
                        e.kind()
                    ));
                }
            }
        }
        self.refresh_account(now);
        let switched = self.state.account_switched_ms;
        let account_now_unknown = self.state.account_hash.is_some()
            && self.current_account_hash() != self.state.account_hash;
        let capture = if self.state.account_changed || account_now_unknown {
            None
        } else {
            // Of the last acceptance's generation or later, as the state says it or as the statusLine writers' mark does (a state
            // that can't be read starts at 0)
            let min_gen = self
                .state
                .accept_gen
                .max(crate::statusline::read_claude_gen(&self.home));
            read_capture_since(&self.home, self.epoch, min_gen).filter(|(at, _)| *at >= switched)
        };
        // The clock is read again after the statusLine value (one written since the time above isn't ahead of it)
        let capture_now = self.clock.map_or(now, |clock| clock());
        if let Some((at, _)) = &capture
            && *at > capture_now
        {
            self.state.capture_ahead_ms = Some(*at);
        }
        self.capture = capture.filter(|(at, _)| self.state.capture_ahead_ms != Some(*at));
        if !self.passive_only {
            self.refresh_cli(now, force);
        }
        self.capture_dirty = false;
        let allowed = !self.passive_only
            && self.epoch.is_some()
            && self.state.cli_supported == Some(true)
            && !self.state.account_changed
            // Only a confirmed claude.ai subscription sign-in (an unknown sign-in method is not enough)
            && self.state.account.as_ref().and_then(|a| a.subscription) == Some(true)
            // Don't run when signed out
            && self.state.account.as_ref().and_then(|a| a.logged_in) != Some(false)
            && !self.state.managed_policy
            // Past a safety stop only on the user's explicit --force (checked on the state read under the lock, so a stop restored
            // just now counts)
            && (confirmed || !self.state.guard_tripped);
        let kept_before = self.state.last_ok.clone();
        if allowed && (force || self.usage_due_ms(now) <= now) {
            // Check managed settings again right before launch (in case they appeared between hourly checks)
            let check = self.policy_check();
            self.apply_policy(check);
            if self.deadline_passed(now) {
                self.log
                    .log("claude: the fetch turn came too long ago; not fetched (asked again next round)");
            } else if check.is_none() {
                self.fetch_usage(now);
            }
        }
        match write_json_atomic(&state_path, &self.state) {
            // The account accepted (one switched to waits until accepted)
            Ok(()) if !self.state.account_changed => {
                if !crate::store::keep_account(
                    &self.home,
                    "claude",
                    self.state.account_hash.as_deref(),
                ) {
                    self.log
                        .log("claude: couldn't keep the account beside the state (kept at the next save)");
                }
            }
            Ok(()) => {}
            Err(e) => {
                self.log
                    .log(&format!("claude: failed to save state: {}", e.kind()));
                // A value that couldn't be kept isn't a success to share (no lease, no resume, no end of a rate limit), nor shown or
                // sent
                if self.run == Some(super::Run::Ran(super::Outcome::Ok)) {
                    self.run = Some(super::Run::Ran(super::Outcome::Failed));
                    self.state.last_ok = kept_before;
                }
            }
        }
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

    fn last_passive(&self) -> Option<super::Passive> {
        self.capture.as_ref().map(|(at, windows)| super::Passive {
            at_ms: *at,
            windows: windows.iter().map(|w| w.id.clone()).collect(),
        })
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
        saved.account_changed.then_some(saved.switch_seq as i64)
    }

    fn accept_target(&mut self, target: Option<i64>) {
        self.accept_target = target;
    }

    fn takes_passive_values(&self) -> bool {
        true
    }

    fn forget_cached(&mut self) -> bool {
        // Under the state lock (a manual collect may be saving); without it, tried again next round
        let Some(_lock) = StateLock::acquire(&self.home, LOCK_WAIT) else {
            return false;
        };
        let state_path = self.home.join(STATE_FILE);
        // A file that exists but can't be read may still hold a value (it would come back once readable): not forgotten, tried again
        let Some(state) = read_state(&state_path) else {
            self.log
                .log("claude: couldn't read the state to forget the cached values");
            self.state_retry_at =
                Some(self.clock.map_or_else(crate::time::now_ms, |clock| clock()) + MINUTE_MS);
            return false;
        };
        self.state = state;
        // The /usage value and the statusLine value (both stamped by the refused clock) are not used again
        let Ok(capture) = capture_at(&self.home) else {
            self.log
                .log("claude: couldn't read the statusLine value to forget it");
            return false;
        };
        // The epoch usable now. When that can't be told (the state can't be read now, or a send's result is pending), nothing is
        // tidied: a value of the current epoch would be taken for one of another (tried again next round)
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
            _ => {
                self.log.log(
                    "claude: the clock state can't be told now; the cached values are tidied later",
                );
                return false;
            }
        };
        let stale_ok = self
            .state
            .last_ok
            .as_ref()
            .is_some_and(|o| o.epoch.is_none() || o.epoch != current);
        let stale_capture = capture
            .filter(|(_, e)| e.is_none() || *e != current)
            .map(|(at, _)| at);
        if !stale_ok && (stale_capture.is_none() || self.state.capture_ahead_ms == stale_capture) {
            return true;
        }
        if stale_ok {
            self.state.last_ok = None;
        }
        if stale_capture.is_some() {
            self.state.capture_ahead_ms = stale_capture;
            self.capture = None;
        }
        match write_json_atomic(&state_path, &self.state) {
            Ok(()) => true,
            Err(e) => {
                self.log
                    .log(&format!("claude: couldn't save the state: {e}"));
                false
            }
        }
    }

    fn last_fetch_attempt_ms(&self) -> Option<i64> {
        Some(self.state.last_query_ms).filter(|&t| t > 0)
    }

    fn on_event(&mut self, event: &Event) {
        match event {
            Event::ClaudeStatuslineCaptured => self.capture_dirty = true,
            Event::GeminiStatuslineCaptured | Event::StopRequested | Event::CollectRequested => {}
        }
    }

    fn accept_account(&mut self) {
        self.accept_account_pending = true;
    }
}

/// Plans whose organization admins can restrict models (`claude auth status` subscriptionType).
/// Organization model restrictions come from claude.ai rather than a settings file, so they can't be checked locally; decide by plan
const ORGANIZATION_PLANS: &[&str] = &["team", "enterprise"];

/// Personal plans (`claude auth status` subscriptionType). For anything else (organization plans, unknown names) /usage is not run
const PERSONAL_PLANS: &[&str] = &["pro", "max"];

/// Whether organization managed settings exist. Unknown if it can't be checked (errs on the side of not running /usage)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Managed {
    Absent,
    Present,
    Unknown,
}

/// Registry key of the Windows managed settings (under HKLM / HKCU; value `Settings`)
pub const POLICY_REGISTRY_KEY: &str = r"SOFTWARE\Policies\ClaudeCode";

/// Whether a path exists. Unknown if it can't be checked (permissions etc.)
fn path_state(path: &Path) -> Managed {
    match path.try_exists() {
        Ok(true) => Managed::Present,
        Ok(false) => Managed::Absent,
        Err(_) => Managed::Unknown,
    }
}

/// The most severe one (Present > Unknown > Absent)
fn worst(a: Managed, b: Managed) -> Managed {
    match (a, b) {
        (Managed::Present, _) | (_, Managed::Present) => Managed::Present,
        (Managed::Unknown, _) | (_, Managed::Unknown) => Managed::Unknown,
        _ => Managed::Absent,
    }
}

/// Whether this PC has organization managed settings (checks existence only; contents are not read).
/// Official locations: https://code.claude.com/docs/en/managed-settings
/// (Windows: files and `SOFTWARE\Policies\ClaudeCode` under HKLM / HKCU; macOS: files and configuration profiles; Linux: files).
/// Settings delivered from claude.ai (server-managed settings) can't be seen here, so the plan (ORGANIZATION_PLANS) covers them
pub fn managed_settings_state() -> Managed {
    let dir: PathBuf = if cfg!(windows) {
        match std::env::var_os("ProgramFiles") {
            Some(p) => PathBuf::from(p).join("ClaudeCode"),
            None => return Managed::Unknown,
        }
    } else if cfg!(target_os = "macos") {
        PathBuf::from("/Library/Application Support/ClaudeCode")
    } else {
        PathBuf::from("/etc/claude-code")
    };
    let mut state = managed_files_state(&dir);
    if cfg!(target_os = "macos") {
        let base = Path::new("/Library/Managed Preferences");
        state = worst(
            state,
            path_state(&base.join("com.anthropic.claudecode.plist")),
        );
        if let Some(user) = std::env::var_os("USER").filter(|u| !u.is_empty()) {
            let per_user = base.join(user).join("com.anthropic.claudecode.plist");
            state = worst(state, path_state(&per_user));
        }
    }
    #[cfg(windows)]
    {
        state = worst(state, registry_policy_state(HKEY_LOCAL_MACHINE));
        state = worst(state, registry_policy_state(HKEY_CURRENT_USER));
    }
    state
}

/// Whether the managed settings locations (file and drop-in directory) exist
fn managed_files_state(dir: &Path) -> Managed {
    worst(
        path_state(&dir.join("managed-settings.json")),
        path_state(&dir.join("managed-settings.d")),
    )
}

/// Predefined keys (Win32 HKEY_LOCAL_MACHINE / HKEY_CURRENT_USER; handles are sign-extended LONGs)
#[cfg(windows)]
const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
#[cfg(windows)]
const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;

/// Check whether the registry managed settings (value `Settings` of `SOFTWARE\Policies\ClaudeCode`) exist via Win32 RegGetValueW.
/// Distinguishes "absent" (ERROR_FILE_NOT_FOUND) from "can't check" such as access denied (reg.exe exits with 1
/// in both cases, so it can't tell them apart). The value's contents are not read (only its size is queried)
#[cfg(windows)]
fn registry_policy_state(root: isize) -> Managed {
    registry_value_state(root, POLICY_REGISTRY_KEY, "Settings")
}

/// Whether a registry value exists (contents are not read)
#[cfg(windows)]
fn registry_value_state(root: isize, sub_key: &str, value_name: &str) -> Managed {
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            hkey: isize,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut core::ffi::c_void,
            size: *mut u32,
        ) -> i32;
    }
    const RRF_RT_ANY: u32 = 0x0000_ffff;
    const ERROR_SUCCESS: i32 = 0;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_MORE_DATA: i32 = 234;
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(sub_key);
    let value = wide(value_name);
    let mut size = 0u32;
    // SAFETY: the strings are NUL-terminated UTF-16. data is null (only the size is queried) and size is a valid write target
    let ret = unsafe {
        RegGetValueW(
            root,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_ANY,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    match ret {
        ERROR_SUCCESS | ERROR_MORE_DATA => Managed::Present,
        ERROR_FILE_NOT_FOUND => Managed::Absent,
        _ => Managed::Unknown,
    }
}

fn plan_from_tier(tier: &str) -> Option<String> {
    let t = tier.to_ascii_lowercase();
    ["ultra", "max", "pro"]
        .iter()
        .find(|p| t.contains(*p))
        .map(|p| p.to_string())
}

pub fn claude_bin(cfg: &ClaudeConfig) -> String {
    if !cfg.claude_bin.is_empty() {
        return cfg.claude_bin.clone();
    }
    std::env::var("HEADROOM_CLAUDE_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "claude".into())
}

/// Locate the executable (existence if a path is given, PATH lookup for a bare name). If not found, nothing is launched.
pub fn resolve_bin(bin: &str) -> Option<PathBuf> {
    let p = Path::new(bin);
    if p.components().count() > 1 || p.is_absolute() {
        return p.is_file().then(|| p.to_path_buf());
    }
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_ascii_lowercase())
            .chain(std::iter::once(String::new()))
            .collect()
    } else {
        vec![String::new()]
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| exts.iter().map(move |e| dir.join(format!("{bin}{e}"))))
        .find(|c| c.is_file())
}

/// Arguments for running `/usage` (including safety guards; verified on 2.1.325).
/// `--disable-slash-commands` is not passed because it disables `/usage` itself.
pub fn usage_args() -> Vec<String> {
    [
        "-p",
        "--output-format",
        "json",
        "--model",
        GUARD_MODEL,
        "--fallback-model",
        GUARD_FALLBACK_MODEL,
        "--setting-sources",
        "local",
        "--no-session-persistence",
        "--tools",
        "",
        "--strict-mcp-config",
        "/usage",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// Prepare a child process to launch with no window and low priority. Also used by the Codex provider.
pub fn background_command(bin: &str) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
        let mut c = Command::new(bin);
        c.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
        c
    }
    #[cfg(not(windows))]
    {
        // By its full path where it is (macOS, Linux): no search of PATH at the launch
        let nice = ["/usr/bin/nice", "/bin/nice"]
            .into_iter()
            .find(|p| Path::new(p).is_file())
            .unwrap_or("nice");
        let mut c = Command::new(nice);
        c.args(["-n", "10", bin]);
        c
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdOutput {
    pub stdout: String,
    pub success: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunError {
    NotFound,
    StartFailed,
    Timeout,
    /// Past its deadline, after the computer slept while it ran: cut off by the sleep, not hung on its own
    Suspended,
}

/// Run a child process with a deadline. Past the deadline, kill and reap it and return.
/// Reads up to 4 MB of stdout. stderr is not used (to avoid bringing in raw CLI text).
pub fn run_with_timeout(cmd: Command, timeout: Duration) -> Result<CmdOutput, RunError> {
    run_child(cmd, timeout, false).map(|(out, stdout_utf8)| CmdOutput {
        // As before: output that isn't UTF-8 reads as none (a cut at the size limit is kept)
        stdout: if stdout_utf8 {
            out.stdout
        } else {
            String::new()
        },
        success: out.code == Some(0),
    })
}

/// What a run printed, its error output and its exit code (None: ended by a signal). The error output is for classifying the run in
/// memory only: it is never logged or saved
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    /// Both outputs were read whole, as UTF-8 (none cut at its size limit, none left unread when the child ended). Text that isn't
    /// UTF-8 is kept with replacement characters
    pub complete: bool,
}

/// `run_with_timeout`, keeping the error output (up to 64 KiB; the rest is read and dropped so the child never waits on it) and the
/// exit code
pub fn run_capturing(cmd: Command, timeout: Duration) -> Result<RunOutput, RunError> {
    run_child(cmd, timeout, true).map(|(out, _)| out)
}

/// One output of a child: its text, and whether it was read whole as UTF-8
struct PipeText {
    text: String,
    whole: bool,
    utf8: bool,
}

fn run_child(
    cmd: Command,
    timeout: Duration,
    keep_stderr: bool,
) -> Result<(RunOutput, bool), RunError> {
    run_child_with(cmd, timeout, keep_stderr, crate::time::sleep_clocks)
}

/// run_child with the clocks that tell a sleep (`clocks`: crate::time::sleep_clocks, or a stand-in in tests)
fn run_child_with(
    mut cmd: Command,
    timeout: Duration,
    keep_stderr: bool,
    clocks: fn(crate::time::ReadFirst) -> Option<(Duration, Duration)>,
) -> Result<(RunOutput, bool), RunError> {
    // Read before the child starts, so a sleep at any point of the run counts
    let before = clocks(crate::time::ReadFirst::Stopping);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(if keep_stderr {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => RunError::NotFound,
        _ => RunError::StartFailed,
    })?;
    let read_all = |pipe: Option<Box<dyn Read + Send>>, limit: u64| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let mut whole = true;
            if let Some(mut pipe) = pipe {
                // One byte past the limit tells a cut; the rest is read and dropped so the child never waits on it
                whole = (&mut pipe).take(limit + 1).read_to_end(&mut bytes).is_ok();
                if bytes.len() as u64 > limit {
                    bytes.truncate(limit as usize);
                    whole = false;
                }
                let _ = std::io::copy(&mut pipe, &mut std::io::sink());
            }
            let (text, utf8) = match String::from_utf8(bytes) {
                Ok(text) => (text, true),
                Err(e) => (String::from_utf8_lossy(e.as_bytes()).into_owned(), false),
            };
            let _ = tx.send(PipeText { text, whole, utf8 });
        });
        rx
    };
    let stdout = child.stdout.take().ok_or(RunError::StartFailed)?;
    let stdout_rx = read_all(Some(Box::new(stdout)), 4 * 1024 * 1024);
    let stderr_rx = read_all(
        child
            .stderr
            .take()
            .map(|e| Box::new(e) as Box<dyn Read + Send>),
        64 * 1024,
    );
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // The child has exited. Wait briefly for the output read to finish (so we can return even if a grandchild holds the pipe)
                let unread = || PipeText {
                    text: String::new(),
                    whole: false,
                    utf8: true,
                };
                let stdout = stdout_rx
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap_or_else(|_| unread());
                let stderr = stderr_rx
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap_or_else(|_| unread());
                let complete = stdout.whole && stdout.utf8 && stderr.whole && stderr.utf8;
                return Ok((
                    RunOutput {
                        stdout: stdout.text,
                        stderr: stderr.text,
                        code: status.code(),
                        complete,
                    },
                    stdout.utf8,
                ));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                // Read once the timeout is decided, so a sleep up to that point counts (Windows' Instant runs on while asleep,
                // macOS's stops: either way the two clocks tell)
                let slept = slept_during(before, clocks(crate::time::ReadFirst::RunningOn));
                let _ = child.kill();
                let _ = child.wait();
                return Err(if slept {
                    RunError::Suspended
                } else {
                    RunError::Timeout
                });
            }
        }
    }
}

/// Environment variables that a Claude Code host (desktop app, another Claude session) passes to child processes.
/// Inheriting them would make the CLI use the host's connection instead of its own sign-in, so they are removed.
pub fn is_host_injected_env(name: &str) -> bool {
    const PREFIXES: [&str; 4] = [
        "CLAUDE_CODE_",
        "CLAUDE_AGENT_SDK_",
        "CLAUDE_PREVIEW_",
        "CLAUDECODE",
    ];
    const EXACT: [&str; 3] = ["CLAUDE_PID", "CLAUDE_EFFORT", "ANTHROPIC_BASE_URL"];
    PREFIXES.iter().any(|p| name.starts_with(p)) || EXACT.contains(&name)
}

fn strip_host_env(cmd: &mut Command) {
    // Remove ANTHROPIC_BASE_URL only when launched from inside a Claude Code host (keep a value the user set themselves)
    let inside_host = std::env::var_os("CLAUDECODE").is_some()
        || std::env::var_os("CLAUDE_CODE_ENTRYPOINT").is_some();
    for (name, _) in std::env::vars_os() {
        let Some(name) = name.to_str() else { continue };
        if is_host_injected_env(name) && (name != "ANTHROPIC_BASE_URL" || inside_host) {
            cmd.env_remove(name);
        }
    }
}

/// Classify the result after launch. Only launch failures are ordinary failures; anything unverifiable after launch is a stop.
/// classify_usage_output for a run whose output may not have been read whole: one cut (at its size limit, left unread) can't confirm
/// zero use whatever its first part says
pub fn classify_usage_run(r: Result<RunOutput, RunError>) -> Result<String, UsageError> {
    let out = match r {
        Ok(out) => out,
        Err(e) => return classify_usage_output(Err(e)),
    };
    let complete = out.complete;
    let denied_on_stderr = super::says_access_denied(&out.stderr);
    // Told on the error output, and not against what the reply says (a failure status of another kind there is that failure)
    let rate_limited_on_stderr = super::says_rate_limited(&out.stderr)
        && super::says_rate_limited(&format!("{} {}", out.stdout, out.stderr));
    let result = if complete {
        classify_usage_output(Ok(CmdOutput {
            stdout: out.stdout,
            success: out.code == Some(0),
        }))
    } else {
        Err(UsageError::Stop(Diag::Unverifiable))
    };
    match result {
        // A denial told only on the error output: with zero use confirmed, the service's denial; without, both stops
        Err(UsageError::Retry(d)) if denied_on_stderr && d != Diag::AccessDenied => {
            Err(UsageError::Retry(Diag::AccessDenied))
        }
        Err(UsageError::Stop(d)) if denied_on_stderr && d != Diag::AccessDeniedUnverified => {
            Err(UsageError::Stop(Diag::AccessDeniedUnverified))
        }
        // A rate limit told only on the error output, with zero use confirmed: every PC waits
        Err(UsageError::Retry(d))
            if rate_limited_on_stderr && !matches!(d, Diag::AccessDenied | Diag::RateLimited) =>
        {
            Err(UsageError::Retry(Diag::RateLimited))
        }
        r => r,
    }
}

pub fn classify_usage_output(r: Result<CmdOutput, RunError>) -> Result<String, UsageError> {
    match r {
        Err(RunError::NotFound) => Err(UsageError::Retry(Diag::CliNotFound)),
        Err(RunError::StartFailed) => Err(UsageError::Retry(Diag::CliStartFailed)),
        Err(RunError::Timeout) => Err(UsageError::Stop(Diag::UsageTimeout)),
        // Cut off by the computer's sleep: tried again like any failure, without a safety stop (the user's choice: a laptop sleeping
        // in the middle of a fetch needs no resume by hand)
        Err(RunError::Suspended) => Err(UsageError::Retry(Diag::Suspended)),
        // A denial of the account shown by output that can't confirm zero use: both stops
        Ok(out) => match serde_json::from_str::<Value>(out.stdout.trim()) {
            Ok(v) => match check_usage_result(&v) {
                Err(UsageError::Stop(_))
                    if super::says_access_denied(&v.to_string())
                        || super::is_denial_code(v["error"].as_str().unwrap_or_default()) =>
                {
                    Err(UsageError::Stop(Diag::AccessDeniedUnverified))
                }
                r => r,
            },
            Err(_) if super::says_access_denied(&out.stdout) => {
                Err(UsageError::Stop(Diag::AccessDeniedUnverified))
            }
            Err(_) => Err(UsageError::Stop(Diag::Unverifiable)),
        },
    }
}

/// Check the result of `claude -p --output-format json` and return the `/usage` body.
/// Rejects it unless the local-command marker, turn count, cost and token counts are explicitly 0, including their types.
pub fn check_usage_result(v: &Value) -> Result<String, UsageError> {
    let stop = |d| Err(UsageError::Stop(d));
    if v.get("local_command").and_then(Value::as_str) != Some("usage") {
        return stop(Diag::NotLocal);
    }
    // Turn count: integer 0 only
    match v.get("num_turns") {
        Some(n) if n.as_u64() == Some(0) => {}
        Some(n) if n.as_f64().is_some_and(|x| x != 0.0) => return stop(Diag::NotLocal),
        _ => return stop(Diag::Unverifiable),
    }
    // Cost: numeric 0 only
    match v.get("total_cost_usd").and_then(Value::as_f64) {
        Some(0.0) => {}
        Some(_) => return stop(Diag::NotLocal),
        None => return stop(Diag::Unverifiable),
    }
    // Token counts: the 4 required ones must be non-negative integer 0; any other counters present must be 0 too. Negative values cancelling out are rejected
    let usage = &v["usage"];
    if !usage.is_object() {
        return stop(Diag::Unverifiable);
    }
    for k in [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ] {
        match usage.get(k) {
            Some(n) if n.as_u64() == Some(0) => {}
            Some(n) if n.as_u64().is_some() => return stop(Diag::NotLocal),
            _ => return stop(Diag::Unverifiable),
        }
    }
    // Additional counters: when present, an object whose values are all integer 0. Any other shape or type can't confirm zero use
    for key in ["output_tokens_details", "server_tool_use", "cache_creation"] {
        let Some(value) = usage.get(key) else {
            continue;
        };
        let Some(obj) = value.as_object() else {
            return stop(Diag::Unverifiable);
        };
        for n in obj.values() {
            match n.as_u64() {
                Some(0) => {}
                Some(_) => return stop(Diag::NotLocal),
                None => return stop(Diag::Unverifiable),
            }
        }
    }
    // Model calls made by the command: when present, an empty array
    match usage.get("iterations") {
        None => {}
        Some(Value::Array(a)) if a.is_empty() => {}
        Some(Value::Array(_)) => return stop(Diag::NotLocal),
        Some(_) => return stop(Diag::Unverifiable),
    }
    // Zero use is confirmed at this point. Anything after this can be treated as an ordinary failure
    let text = v["result"].as_str().unwrap_or_default();
    if v["is_error"] == true {
        // The service denying the account (its text, or the error code -p mode gives), before a sign-in failure
        let (error, subtype) = (
            v["error"].as_str().unwrap_or_default(),
            v["subtype"].as_str().unwrap_or_default(),
        );
        let said = format!("{text} {error}");
        return Err(UsageError::Retry(
            if super::says_access_denied(&said)
                || super::is_denial_code(error)
                || super::is_denial_code(subtype)
            {
                Diag::AccessDenied
            } else if super::is_rate_limit_code(error) || super::says_rate_limited(&said) {
                // A rate limit told as an error (zero use confirmed above): every PC waits, as for the usage text's
                Diag::RateLimited
            } else if looks_like_login(text) {
                Diag::LoginRequired
            } else {
                Diag::CliError
            },
        ));
    }
    if text.is_empty() {
        return Err(UsageError::Retry(Diag::UnrecognizedOutput));
    }
    Ok(text.to_string())
}

fn looks_like_login(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["login", "log in", "authenticat", "401", "oauth"]
        .iter()
        .any(|k| t.contains(k))
}

/// `2.1.325 (Claude Code)` → (2, 1, 325)
pub fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let token = s.split_whitespace().next()?;
    let mut it = token.split('.').map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next()??))
}

/// Extract windows from the `/usage` body. Target lines look like:
/// `Current session: 9% used · resets Nov 17, 1am (Asia/Tokyo)`
/// The time is interpreted in the parenthesized time zone (default_tz if absent); if unresolvable, resets_at is null and the percentage is kept.
pub fn parse_usage_text(text: &str, now_ms: i64, default_tz: &TimeZone) -> Vec<UsageWindow> {
    let mut out: Vec<UsageWindow> = Vec::new();
    for line in text.lines().map(str::trim) {
        let Some((label, rest)) = line.split_once(": ") else {
            continue;
        };
        let Some((pct, after)) = rest.split_once("% used") else {
            continue;
        };
        let pct = pct.trim();
        // `<1%` means under 1%. Treated as 0
        let Ok(pct) = (if pct.starts_with('<') {
            Ok(0.0)
        } else {
            pct.parse::<f64>()
        }) else {
            continue;
        };
        let lower = after.to_ascii_lowercase();
        let resets = lower
            .find("resets ")
            .and_then(|i| parse_reset(after[i + 7..].trim(), now_ms, default_tz));
        // Only the session / weekly / monthly limits. Extra usage and other headings are not sent (Codex sends no
        // counterpart, and a maxed-out extra usage must not read as a reached limit)
        let Some(ident) = window_identity(label.trim()) else {
            continue;
        };
        let mut w = make_window(&ident.id, pct, resets).with_seconds(ident.secs);
        w.label = ident.label;
        w.scope = ident.model;
        if !out.iter().any(|o| o.id == w.id) {
            out.push(w);
        }
    }
    out
}

struct WindowIdentity {
    id: String,
    label: String,
    secs: Option<i64>,
    model: Option<String>,
}

/// `/usage` heading -> window id, display label, length and model. None for headings that are not a usage-limit window
fn window_identity(label: &str) -> Option<WindowIdentity> {
    let make = |id: &str, label: &str, secs: Option<i64>, model: Option<String>| {
        Some(WindowIdentity {
            id: id.to_string(),
            label: label.to_string(),
            secs,
            model,
        })
    };
    // Whole headings only, so a heading that merely contains these words (an extra allowance, a spend line) is never read as a limit.
    // The official wording renamed "session limit" to "5-hour limit" (2.1.312). Read either heading as the 5-hour window
    let lower = label.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "current session" | "current 5-hour limit" | "current 5 hour limit"
    ) {
        return make("five_hour", "5h", Some(5 * 60 * 60), None);
    }
    if lower == "current week" || lower == "current week (all models)" {
        return make("seven_day", "Weekly", Some(WEEK_SECS), None);
    }
    // `Current week (<model>)` for a known model only. An unknown model name (e.g. one with a version number) is not read,
    // so it can never be taken for a known one
    if let Some(model) = label
        .strip_prefix("Current week (")
        .and_then(|r| r.strip_suffix(')'))
    {
        // The whole name must be a known model (e.g. "Opus"); a name with anything else is another model
        let model_slug = slug(model);
        if !CLAUDE_MODELS.contains(&model_slug.as_str()) {
            return None;
        }
        let name = known_scope(&model_slug).filter(|n| n.eq_ignore_ascii_case(model.trim()))?;
        let id = format!("seven_day_{model_slug}");
        let label = known_window(&id).map_or_else(|| format!("Weekly {name}"), |k| k.0.to_string());
        return make(&id, &label, Some(WEEK_SECS), Some(name.to_string()));
    }
    if lower == "current month" {
        return make("monthly", "Monthly", None, None);
    }
    None
}

/// Model names Claude's per-model weekly windows may carry (a subset of `KNOWN_SCOPES`)
const CLAUDE_MODELS: &[&str] = &["fable", "opus", "sonnet", "haiku"];

/// Whether an id is a Claude window: `five_hour`, `seven_day`, `monthly` or `seven_day_<known model>`. Windows from older
/// versions' saved values and statusLine names are checked against this too, so nothing else (extra usage, other names) is used
pub fn is_claude_window(id: &str) -> bool {
    matches!(id, "five_hour" | "seven_day" | "monthly")
        || id
            .strip_prefix("seven_day_")
            .is_some_and(|m| CLAUDE_MODELS.contains(&m))
}

/// Take only the needed fields from the `claude auth status` JSON (email and organization are dropped).
/// Officially documented are the exit code (0 = signed in) and `authMethod`. `loggedIn` / `subscriptionType`
/// are not in the official docs, so they are used as hints when present
pub fn parse_auth_status(v: &Value, exit_ok: bool) -> AccountInfo {
    let s = |k: &str| v[k].as_str().filter(|x| !x.is_empty()).map(str::to_string);
    let method = s("authMethod");
    let subscription = match method.as_deref() {
        // claude.ai sign-in, and setup-token / CLAUDE_CODE_OAUTH_TOKEN (subscription tokens)
        Some("claude.ai" | "oauth_token") => Some(true),
        Some("api_key" | "api_key_helper" | "third_party") => Some(false),
        _ => None,
    };
    let logged_in = if method.as_deref() == Some("none") {
        Some(false)
    } else {
        v["loggedIn"].as_bool().or(Some(exit_ok))
    };
    AccountInfo {
        plan: s("subscriptionType").map(|p| p.to_ascii_lowercase()),
        logged_in,
        subscription,
    }
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    out.trim_matches('_').to_string()
}

fn weekday(s: &str) -> Option<jiff::civil::Weekday> {
    use jiff::civil::Weekday::*;
    let s = s.trim().to_ascii_lowercase();
    [
        ("mon", Monday),
        ("tue", Tuesday),
        ("wed", Wednesday),
        ("thu", Thursday),
        ("fri", Friday),
        ("sat", Saturday),
        ("sun", Sunday),
    ]
    .into_iter()
    .find(|(p, _)| s.len() >= 3 && s.len() <= 9 && s.starts_with(p) && !s.contains(' '))
    .map(|(_, w)| w)
}

/// `Nov 17, 1am (Asia/Tokyo)` / `Nov 17, 12:59am (...)` / `4pm (...)` / `Mon 12:00am` / `14:00` -> UTC epoch ms.
/// Converted using the parenthesized IANA time zone and that day's DST. None if the name can't be resolved.
/// The year isn't shown, so the nearest future date is assumed (resets are always in the future).
pub fn parse_reset(when: &str, now_ms: i64, default_tz: &TimeZone) -> Option<i64> {
    let (body, tz_name) = match when.rsplit_once(" (") {
        Some((b, t)) => (b.trim(), Some(t.trim_end_matches(')').trim())),
        None => (when.trim(), None),
    };
    let tz = match tz_name {
        Some(name) => TimeZone::get(name).ok()?,
        None => default_tz.clone(),
    };
    let body = body.replace(" at ", ", ");
    let (date_part, time_part) = match body.rsplit_once(", ") {
        Some((d, t)) => (Some(d.trim()), t.trim()),
        None => (None, body.trim()),
    };

    // The weekday-only form (`Mon 12:00am`) is split into date and time
    let (date_part, time_part) = match (date_part, time_part.split_once(' ')) {
        (None, Some((d, t))) => (Some(d.trim()), t.trim()),
        (d, _) => (d, time_part),
    };
    let t = time_part.to_ascii_lowercase();
    let (hm, ampm) = if let Some(x) = t.strip_suffix("am") {
        (x, Some(false))
    } else if let Some(x) = t.strip_suffix("pm") {
        (x, Some(true))
    } else {
        // 24-hour notation (`14:00`)
        (t.as_str(), None)
    };
    let (h, m) = match hm.trim().split_once(':') {
        Some((h, m)) => (h.parse::<i8>().ok()?, m.parse::<i8>().ok()?),
        None if ampm.is_some() => (hm.trim().parse::<i8>().ok()?, 0),
        None => return None,
    };
    if !(0..60).contains(&m) {
        return None;
    }
    let hour = match ampm {
        Some(pm) if (1..=12).contains(&h) => (h % 12) + if pm { 12 } else { 0 },
        None if (0..24).contains(&h) => h,
        _ => return None,
    };

    let now = Timestamp::from_millisecond(now_ms).ok()?;
    let today = now.to_zoned(tz.clone()).date();
    let at = |d: Date| -> Option<i64> {
        Some(
            d.at(hour, m, 0, 0)
                .to_zoned(tz.clone())
                .ok()?
                .timestamp()
                .as_millisecond(),
        )
    };
    match date_part {
        None => {
            let t = at(today)?;
            if t < now_ms - MINUTE_MS {
                at(today.tomorrow().ok()?)
            } else {
                Some(t)
            }
        }
        Some(d) if weekday(d).is_some() => {
            // The next such weekday (today if it is that weekday and the time hasn't passed)
            let target = weekday(d)?;
            let mut day = today;
            for _ in 0..8 {
                if day.weekday() == target
                    && let Some(t) = at(day)
                    && t >= now_ms - MINUTE_MS
                {
                    return Some(t);
                }
                day = day.tomorrow().ok()?;
            }
            None
        }
        Some(d) => {
            let (mon, day) = d.split_once(' ')?;
            const MONTHS: [&str; 12] = [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ];
            let month = MONTHS
                .iter()
                .position(|x| mon.to_ascii_lowercase().starts_with(x))?
                as i8
                + 1;
            let day: i8 = day.trim().parse().ok()?;
            // Interpret as this year; if more than a day in the past, use next year (a January reset shown in December)
            let this_year = at(Date::new(today.year(), month, day).ok()?)?;
            if this_year < now_ms - 86_400_000 {
                at(Date::new(today.year() + 1, month, day).ok()?)
            } else {
                Some(this_year)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// 2026-11-16T13:00:00Z (22:00 in Tokyo)
    const NOW: i64 = 1_794_834_000_000;

    fn tokyo() -> TimeZone {
        TimeZone::get("Asia/Tokyo").unwrap()
    }

    fn home(name: &str) -> crate::test_util::TempHome {
        let h = crate::test_util::TempHome::new(&format!("headroom-claude-{name}"));
        crate::test_util::trust_clock(&h);
        h
    }

    fn usage_text(session: u32) -> String {
        format!(
            "Current session: {session}% used · resets Nov 17, 1am (Asia/Tokyo)\nCurrent week (all models): 2% used · resets Nov 20, 4pm (Asia/Tokyo)\n"
        )
    }

    fn logged_in() -> AccountInfo {
        AccountInfo {
            plan: Some("max".into()),
            logged_in: Some(true),
            subscription: Some(true),
        }
    }

    struct FakeState {
        usage: VecDeque<Result<String, UsageError>>,
        usage_calls: usize,
        usage_delay: Duration,
        version: Result<String, Diag>,
        versions: VecDeque<Result<String, Diag>>,
        auth: Result<AccountInfo, Diag>,
        auth_calls: usize,
        /// State file read at the moment /usage is called (checks that the in-flight marker was already saved)
        marker_probe: Option<PathBuf>,
        marker_seen: Option<bool>,
        /// Organization managed settings on this PC
        managed: Managed,
        /// A file made unwritable while /usage runs (a folder put in its place)
        break_file: Option<PathBuf>,
        /// A file written while /usage runs (its path and new text)
        rewrite: Option<(PathBuf, String)>,
        /// How long the preparation (finding the executable) takes
        prepare_delay: Duration,
    }

    /// Stand-in CLI. Counts calls and returns the given results
    #[derive(Clone)]
    struct Fake(Arc<Mutex<FakeState>>);

    impl Fake {
        fn new(usage: Vec<Result<String, UsageError>>) -> Self {
            Self(Arc::new(Mutex::new(FakeState {
                usage: usage.into(),
                usage_calls: 0,
                usage_delay: Duration::ZERO,
                version: Ok("2.1.325".into()),
                versions: VecDeque::new(),
                auth: Ok(logged_in()),
                auth_calls: 0,
                marker_probe: None,
                marker_seen: None,
                managed: Managed::Absent,
                break_file: None,
                rewrite: None,
                prepare_delay: Duration::ZERO,
            })))
        }
        fn calls(&self) -> usize {
            self.0.lock().unwrap().usage_calls
        }
        fn set_auth(&self, a: Result<AccountInfo, Diag>) {
            self.0.lock().unwrap().auth = a;
        }
        fn push_usage(&self, r: Result<String, UsageError>) {
            self.0.lock().unwrap().usage.push_back(r);
        }
        fn set_managed(&self, m: Managed) {
            self.0.lock().unwrap().managed = m;
        }
    }

    impl ClaudeCli for Fake {
        fn prepare_usage(&mut self) {
            let delay = self.0.lock().unwrap().prepare_delay;
            std::thread::sleep(delay);
        }
        fn version(&mut self) -> Result<String, Diag> {
            let mut s = self.0.lock().unwrap();
            s.versions.pop_front().unwrap_or_else(|| s.version.clone())
        }
        fn auth_status(&mut self) -> Result<AccountInfo, Diag> {
            let mut s = self.0.lock().unwrap();
            s.auth_calls += 1;
            s.auth.clone()
        }
        fn managed_settings(&mut self) -> Managed {
            self.0.lock().unwrap().managed
        }
        fn usage(&mut self, _cwd: &Path) -> Result<String, UsageError> {
            let delay = {
                let mut s = self.0.lock().unwrap();
                s.usage_calls += 1;
                if let Some(p) = s.marker_probe.clone() {
                    s.marker_seen = Some(load_state(&p).usage_in_flight_ms.is_some());
                }
                if let Some(p) = s.break_file.take() {
                    let _ = std::fs::remove_file(&p);
                    std::fs::create_dir(&p).unwrap();
                }
                if let Some((p, text)) = s.rewrite.take() {
                    std::fs::write(p, text).unwrap();
                }
                s.usage_delay
            };
            std::thread::sleep(delay);
            self.0
                .lock()
                .unwrap()
                .usage
                .pop_front()
                .unwrap_or_else(|| Ok(usage_text(1)))
        }
    }

    fn provider_with(h: &Path, fake: &Fake, log: Logger) -> ClaudeProvider {
        crate::test_util::trust_clock(h);
        let mut p =
            ClaudeProvider::with_cli(h, ClaudeConfig::default(), log, Box::new(fake.clone()));
        p.set_time_zone(tokyo());
        p
    }

    fn provider(
        name: &str,
        usage: Vec<Result<String, UsageError>>,
    ) -> (ClaudeProvider, Fake, crate::test_util::TempHome) {
        let h = home(name);
        let fake = Fake::new(usage);
        (provider_with(&h, &fake, Logger::stderr()), fake, h)
    }

    fn real_fixture() -> Value {
        serde_json::from_str(include_str!("../../../fixtures/claude/usage-result.json")).unwrap()
    }

    // ---- Existing parsing ----

    #[test]
    fn parses_real_usage_output() {
        let text = check_usage_result(&real_fixture())
            .expect("the real-machine fixture passes the safety check");
        let ws = parse_usage_text(&text, NOW, &tokyo());
        let ids: Vec<_> = ws.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["five_hour", "seven_day", "seven_day_fable"]);
        assert_eq!(ws[0].used_percent, 9.0);
        assert_eq!(ws[0].resets_at.as_deref(), Some("2026-11-16T16:00:00.000Z"));
        assert_eq!(ws[1].resets_at.as_deref(), Some("2026-11-20T07:00:00.000Z"));
        assert_eq!(
            (ws[2].label.as_str(), ws[2].kind, ws[2].scope.as_deref()),
            (
                "Weekly Fable",
                crate::schema::WindowKind::Weekly,
                Some("Fable")
            )
        );
    }

    #[test]
    fn model_weeks_and_unknown_lines() {
        let text = "Current week (Sonnet): 5% used · resets Nov 20, 4pm (Asia/Tokyo)\nExtra usage: 10% used\nrandom line\n";
        let ws = parse_usage_text(text, NOW, &tokyo());
        assert_eq!(ws[0].id, "seven_day_sonnet");
        assert_eq!(ws[0].label, "Weekly Sonnet");
        assert_eq!(
            ws.len(),
            1,
            "extra usage and unknown headings are not windows"
        );
    }

    #[test]
    fn maxed_out_extra_usage_is_not_a_reached_limit() {
        let text = "Current session: 20% used · resets Nov 17, 1am (Asia/Tokyo)\nCurrent week (all models): 30% used · resets Nov 20, 4pm (Asia/Tokyo)\nExtra usage: 100% used · resets Dec 1 (Asia/Tokyo)\nAcme Corp pool: 100% used\n";
        let ws = parse_usage_text(text, NOW, &tokyo());
        let ids: Vec<_> = ws.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["five_hour", "seven_day"]);
        // Headings that only contain the words of a limit, and unknown models, are not read
        let lookalikes = "Current monthly spend: 100% used
Extra 5-hour allowance: 100% used
Current week (Opus 4): 5% used
Current week (Acme): 5% used
Current week (Opus 試用): 5% used
Current week (Opus-4): 5% used
Current session limit for org: 100% used
";
        assert!(parse_usage_text(lookalikes, NOW, &tokyo()).is_empty());
        let (p, _, _h) = provider("extra-usage", vec![Ok(text.into())]);
        let mut p = p;
        let snap = p.collect(NOW, false);
        assert_eq!(snap.blocked, Some(false), "{snap:?}");
        assert!(snap.windows.iter().all(|w| w.used_percent < 100.0));
    }

    #[test]
    fn auth_status_keeps_only_safe_fields() {
        let v = json!({"loggedIn": true, "subscriptionType": "max", "planTier": "max_5x", "loginExpiresAt": "2026-12-13T14:34:15.399Z", "email": "a@example.com", "orgId": "x"});
        let a = parse_auth_status(&v, true);
        assert_eq!(
            a,
            AccountInfo {
                plan: Some("max".into()),
                logged_in: Some(true),
                subscription: None,
            }
        );
    }

    #[test]
    fn snapshot_carries_plan_and_blocked() {
        let text = usage_text(100) + "Last 24h · 3 requests · 1 session\n";
        let (mut p, _fake, h) = provider("full", vec![Ok(text)]);
        let snap = p.collect(NOW, false);
        assert_eq!(snap.plan.as_deref(), Some("max"));
        assert_eq!(snap.blocked, Some(true));
        assert_eq!(snap.error_code, None);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn polls_every_5_minutes_and_backs_off() {
        let (mut p, fake, h) = provider(
            "schedule",
            vec![Ok(usage_text(1)), Err(UsageError::Retry(Diag::CliError))],
        );
        p.collect(NOW, false);
        assert_eq!(p.next_due_ms(NOW), NOW + 5 * MINUTE_MS);
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 1);
        p.collect(NOW + 5 * MINUTE_MS, false); // failure -> next in 10 minutes
        assert_eq!(fake.calls(), 2);
        assert_eq!(p.next_due_ms(NOW + 5 * MINUTE_MS), NOW + 15 * MINUTE_MS);
        let snap = p.collect(NOW + 14 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 2);
        assert_eq!(
            snap.windows[0].used_percent, 1.0,
            "keeps the previous value"
        );
        assert_eq!(snap.error.as_deref(), Some(Diag::CliError.message()));
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn account_switch_discards_previous_value() {
        let (mut p, _fake, h) = provider(
            "account",
            vec![Ok(usage_text(80)), Err(UsageError::Retry(Diag::CliError))],
        );
        let cj = h.join("claude.json");
        std::fs::write(&cj, r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o","userRateLimitTier":"default_claude_max_5x"}}"#).unwrap();
        p.set_claude_json(cj.clone());
        let snap = p.collect(NOW, false);
        assert_eq!(snap.windows[0].used_percent, 80.0);
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        let snap = p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(snap.status, ProviderStatus::Unavailable);
        assert_eq!(snap.error_code, Some(ErrorCode::AccountChanged));
        assert!(
            snap.windows.is_empty(),
            "does not show the previous account's values"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- An attempt interrupted mid-run is not carried over ----

    #[test]
    fn marker_is_saved_before_usage_and_cleared_after() {
        let (mut p, fake, h) = provider("marker", vec![]);
        fake.0.lock().unwrap().marker_probe = Some(h.join(STATE_FILE));
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);
        assert_eq!(
            fake.0.lock().unwrap().marker_seen,
            Some(true),
            "the in-flight marker is saved before launch"
        );
        assert_eq!(
            load_state(&h.join(STATE_FILE)).usage_in_flight_ms,
            None,
            "the marker is cleared once the result is checked"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn interrupted_attempt_stops_auto_fetch_until_forced() {
        let h = home("interrupted");
        // The previous process crashed during /usage (marker left behind)
        let crashed = json!({"usage_in_flight_ms": NOW - MINUTE_MS, "last_attempt_ms": NOW - MINUTE_MS, "cli_supported": true, "last_auth_ms": NOW - MINUTE_MS});
        std::fs::write(h.join(STATE_FILE), crashed.to_string()).unwrap();
        let fake = Fake::new(vec![]);
        let mut p = provider_with(&h, &fake, Logger::stderr());
        let snap = p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(
            fake.calls(),
            0,
            "no automatic run after an attempt whose zero use was not confirmed"
        );
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(snap.error.as_deref(), Some(Diag::Interrupted.message()));
        let saved = load_state(&h.join(STATE_FILE));
        assert!(saved.guard_tripped && saved.usage_in_flight_ms.is_none());
        p.collect(NOW + 120 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 0);
        {
            p.confirm_safety(true);
            p.collect(NOW + 121 * MINUTE_MS, true)
        };
        assert_eq!(fake.calls(), 1, "resumes with a manual --force");
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_maxed_out_model_week_from_statusline_does_not_block() {
        let h = home("statusline-model");
        let fake = Fake::new(vec![Ok(usage_text(10))]);
        let mut p = provider_with(&h, &fake, Logger::stderr());
        p.collect(NOW - MINUTE_MS, false);
        // written after that /usage (a value written ahead of the clock would never be used)
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 20}, "seven_day": {"used_percentage": 20}, "seven_day_opus": {"used_percentage": 100}}),
            NOW,
        )
        .unwrap();
        let snap = p.collect(NOW, false);
        let opus = snap
            .windows
            .iter()
            .find(|w| w.id == "seven_day_opus")
            .unwrap();
        assert_eq!(opus.scope.as_deref(), Some("Opus"));
        assert_eq!(snap.blocked, Some(false), "{snap:?}");
    }

    #[test]
    fn extra_usage_saved_by_an_older_version_does_not_block() {
        let h = home("old-extra");
        let mut five = make_window("five_hour", 20.0, None);
        five.kind = crate::schema::WindowKind::Session;
        let extra = UsageWindow {
            id: "extra_usage".into(),
            label: "Extra usage".into(),
            kind: crate::schema::WindowKind::Other,
            scope: None,
            used_percent: 100.0,
            resets_at: None,
            fetched_at: None,
        };
        let saved = ClaudeState {
            state_version: STATE_VERSION,
            last_ok: Some(Observation {
                fetched_ms: NOW - MINUTE_MS,
                windows: vec![five, extra],
                epoch: Some(1),
            }),
            cli_supported: Some(true),
            ..Default::default()
        };
        write_json_atomic(&h.join(STATE_FILE), &saved).unwrap();
        crate::statusline::save_capture(&h, &json!({"extra_usage": {"used_percentage": 100}}), NOW)
            .unwrap();
        let fake = Fake::new(vec![]);
        let p = provider_with(&h, &fake, Logger::stderr());
        let snap = p.build(NOW);
        assert_eq!(snap.blocked, Some(false), "{snap:?}");
        let ids: Vec<_> = snap.windows.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["five_hour"]);
    }

    #[test]
    fn corrupt_state_keeps_auto_fetch_stopped() {
        let stopped = json!({"guard_tripped": true, "last_error": "not_local", "cli_supported": true, "last_auth_ms": NOW - MINUTE_MS});
        let cases: Vec<(&str, String)> = vec![
            ("truncated", stopped.to_string()[..20].to_string()),
            ("not an object", "[1, 2]".into()),
            ("empty", String::new()),
            (
                "stop flag of another type",
                json!({"guard_tripped": "true", "cli_supported": true}).to_string(),
            ),
            (
                "account stop of another type",
                json!({"account_changed": 1}).to_string(),
            ),
            (
                "marker of another type",
                json!({"usage_in_flight_ms": "123"}).to_string(),
            ),
            (
                "stop flag null",
                json!({"guard_tripped": null, "cli_supported": true}).to_string(),
            ),
        ];
        for (name, content) in cases {
            let h = home("corrupt-state");
            std::fs::write(h.join(STATE_FILE), &content).unwrap();
            let fake = Fake::new(vec![]);
            let mut p = provider_with(&h, &fake, Logger::stderr());
            let snap = p.collect(NOW, false);
            // A restart reads the state the first run saved
            let mut again = provider_with(&h, &fake, Logger::stderr());
            again.collect(NOW + 120 * MINUTE_MS, false);
            assert_eq!(
                fake.calls(),
                0,
                "{name}: no automatic /usage after a restart"
            );
            assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop), "{name}");
            assert!(load_state(&h.join(STATE_FILE)).guard_tripped, "{name}");
            {
                again.confirm_safety(true);
                again.collect(NOW + 121 * MINUTE_MS, true)
            };
            assert_eq!(fake.calls(), 1, "{name}: resumes with a manual --force");
        }
        // Only a missing file starts fresh
        let (mut p, fake, _h) = provider("fresh-state", vec![]);
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);
    }

    // ---- The resident agent recovers from a temporarily missing CLI ----

    #[test]
    fn cli_recovers_after_temporary_absence() {
        let (mut p, fake, h) = provider("recover", vec![]);
        fake.0
            .lock()
            .unwrap()
            .versions
            .push_back(Err(Diag::CliNotFound));
        let snap = p.collect(NOW, false);
        assert_eq!(fake.calls(), 0);
        assert_eq!(snap.error_code, Some(ErrorCode::NotInstalled));
        assert_eq!(
            p.next_due_ms(NOW),
            NOW + 60 * MINUTE_MS,
            "the version check stays scheduled even while /usage is stopped"
        );
        p.collect(NOW + 61 * MINUTE_MS, false);
        assert_eq!(
            fake.calls(),
            1,
            "after reinstalling the CLI it is rechecked and fetching resumes"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn safety_stop_keeps_checking_version_and_auth() {
        let (mut p, fake, h) = provider("guard", vec![Err(UsageError::Stop(Diag::NotLocal))]);
        p.collect(NOW, false);
        assert!(p.state.guard_tripped);
        let auth_before = fake.0.lock().unwrap().auth_calls;
        assert_eq!(p.next_due_ms(NOW), NOW + 60 * MINUTE_MS);
        p.collect(NOW + 61 * MINUTE_MS, false);
        assert_eq!(
            fake.0.lock().unwrap().auth_calls,
            auth_before + 1,
            "version and auth are still checked while stopped"
        );
        assert_eq!(
            fake.calls(),
            1,
            "active fetching waits for an explicit resume"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- Stops on an account switch and resumes manually ----

    #[test]
    fn usage_text_variants_from_the_docs() {
        let tz = TimeZone::get("Asia/Tokyo").unwrap();
        // NOW = 2026-11-16T13:00Z = 22:00 JST (Monday)
        let text = "Current week (all models): <1% used · Resets 11pm (Asia/Tokyo)\n\
                    Current week (Fable): 12.5% used · resets Mon 12:00am (Asia/Tokyo)\n\
                    Current month: 3% used · resets 23:30 (Asia/Tokyo)\n";
        let ws = parse_usage_text(text, NOW, &tz);
        assert_eq!(
            ws.len(),
            3,
            "plans without Current session (Ultra) are fine too"
        );
        assert_eq!(ws[0].used_percent, 0.0);
        assert_eq!(
            ws[0].resets_at.as_deref(),
            Some("2026-11-16T14:00:00.000Z"),
            "capitalized Resets with no date"
        );
        assert_eq!(ws[1].used_percent, 12.5);
        assert_eq!(
            ws[1].resets_at.as_deref(),
            Some("2026-11-22T15:00:00.000Z"),
            "the weekday form means the next such weekday"
        );
        assert_eq!(
            ws[2].resets_at.as_deref(),
            Some("2026-11-16T14:30:00.000Z"),
            "24-hour notation"
        );
        assert_eq!(parse_reset("25:00 (Asia/Tokyo)", NOW, &tz), None);
        let renamed = parse_usage_text(
            "Current 5-hour limit: 4% used · resets 11pm (Asia/Tokyo)",
            NOW,
            &tz,
        );
        assert_eq!(
            renamed[0].id, "five_hour",
            "still the 5-hour window when the heading says 5-hour"
        );
    }

    #[test]
    fn last_known_or_rate_limited_usage_is_not_a_new_observation() {
        let cached = "Showing last-known usage\nCurrent session: 30% used · resets Nov 17, 1am (Asia/Tokyo)\n";
        let (mut p, fake, h) = provider(
            "last-known",
            vec![
                Ok(usage_text(10)),
                Ok(cached.into()),
                Ok("Usage is rate limited until 3:14am".into()),
            ],
        );
        p.collect(NOW, false);
        let snap = p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 2);
        assert_eq!(
            snap.windows[0].used_percent, 10.0,
            "previous values are not treated as a new observation"
        );
        assert_eq!(
            snap.windows[0].fetched_at.as_deref(),
            Some(iso_from_ms(NOW).as_str())
        );
        assert_eq!(p.state.last_error, Some(Diag::LastKnownUsage));
        p.collect(NOW + 20 * MINUTE_MS, false);
        assert_eq!(p.state.last_error, Some(Diag::RateLimited));
        assert_eq!(p.state.failures, 2, "retries with a longer interval");
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::RateLimited { retry_ms: None }
            ))
        );
        assert_eq!(p.take_run(), None, "taken once");
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_go_that_came_too_long_ago_starts_no_query() {
        use crate::providers::Run;
        let (mut p, fake, h) = provider("deadline", vec![Ok(usage_text(10)), Ok(usage_text(11))]);
        p.fetch_deadline(Some(NOW - 1));
        p.collect(NOW, false);
        assert_eq!((fake.calls(), p.take_run()), (0, Some(Run::NotRun)));
        p.fetch_deadline(Some(NOW + 60_000));
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn the_collect_says_what_went_upstream() {
        use crate::providers::{Outcome, Run};
        let both = "Showing last-known usage\nUsage is rate limited until 3:14am\n";
        let (mut p, fake, h) = provider(
            "run",
            vec![Ok(usage_text(10)), Ok(both.into()), Ok(usage_text(12))],
        );
        p.collect(NOW, false);
        assert_eq!(p.take_run(), Some(Run::Ran(Outcome::Ok)));
        // not due: nothing went upstream
        p.collect(NOW + MINUTE_MS, false);
        assert_eq!(p.take_run(), Some(Run::NotRun));
        // rate limited with the last-known values shown: rate limited
        p.collect(NOW + 20 * MINUTE_MS, false);
        assert_eq!(
            p.take_run(),
            Some(Run::Ran(Outcome::RateLimited { retry_ms: None }))
        );
        assert_eq!(p.state.last_error, Some(Diag::RateLimited));
        // the passive intake starts no CLI and says nothing of a run
        let calls = fake.calls();
        let _ = p.take_passive(NOW + 120 * MINUTE_MS);
        assert_eq!(fake.calls(), calls);
        assert_eq!(p.take_run(), None);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn managed_settings_or_organization_plans_never_run_usage() {
        // This PC has organization managed settings: the nonexistent model name may be replaced with the default model, so /usage is not run
        let (mut p, fake, h) = provider("managed", vec![Ok(usage_text(10))]);
        fake.set_managed(Managed::Present);
        let snap = p.collect(NOW, false);
        assert_eq!(fake.calls(), 0);
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(snap.error.as_deref(), Some(Diag::ManagedPolicy.message()));
        // Not run even with --force (the guard itself doesn't work)
        p.collect(NOW + 6 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 0, "not run even with --force");
        // Once the managed settings are gone, it resumes at the next (hourly) check, counted from the --force check
        fake.set_managed(Managed::Absent);
        let snap = p.collect(NOW + 67 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 1);
        assert_eq!(snap.error_code, None);
        let _ = std::fs::remove_dir_all(h);

        // Organization plan (Team / Enterprise): organization model restrictions come from claude.ai and can't be seen locally, so stop by plan
        for plan in ["team", "enterprise"] {
            let (mut p, fake, h) = provider(&format!("org-{plan}"), vec![Ok(usage_text(10))]);
            fake.set_auth(Ok(AccountInfo {
                plan: Some(plan.into()),
                ..logged_in()
            }));
            let snap = p.collect(NOW, false);
            assert_eq!(fake.calls(), 0, "{plan}");
            assert_eq!(snap.error.as_deref(), Some(Diag::ManagedPolicy.message()));
            let _ = std::fs::remove_dir_all(h);
        }
    }

    #[test]
    fn unknown_policy_or_settings_added_between_checks_never_run_usage() {
        // Whether managed settings exist can't be checked
        let (mut p, fake, h) = provider("policy-unknown", vec![Ok(usage_text(10))]);
        fake.set_managed(Managed::Unknown);
        let snap = p.collect(NOW, true);
        assert_eq!(fake.calls(), 0, "not run even with --force");
        assert_eq!(snap.error.as_deref(), Some(Diag::PolicyUnknown.message()));
        let _ = std::fs::remove_dir_all(h);

        // Plan unknown
        let (mut p, fake, h) = provider("plan-unknown", vec![Ok(usage_text(10))]);
        fake.set_auth(Ok(AccountInfo {
            plan: None,
            ..logged_in()
        }));
        p.collect(NOW, true);
        assert_eq!(fake.calls(), 0);
        let _ = std::fs::remove_dir_all(h);

        // Unknown plan name / signed out (even when subscription is unknown)
        for (label, account) in [
            (
                "plan-other",
                AccountInfo {
                    plan: Some("business_x".into()),
                    ..logged_in()
                },
            ),
            (
                "logged-out",
                AccountInfo {
                    plan: Some("max".into()),
                    logged_in: Some(false),
                    subscription: None,
                },
            ),
        ] {
            let (mut p, fake, h) = provider(label, vec![Ok(usage_text(10))]);
            fake.set_auth(Ok(account));
            p.collect(NOW, true);
            assert_eq!(fake.calls(), 0, "{label}");
            let _ = std::fs::remove_dir_all(h);
        }

        // Managed settings appeared after the hourly check: found right before the next /usage, which is not run
        let (mut p, fake, h) = provider("policy-added", vec![Ok(usage_text(10))]);
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);
        fake.set_managed(Managed::Present);
        let snap = p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(
            fake.calls(),
            1,
            "not run even when managed settings appear between checks"
        );
        assert_eq!(snap.error.as_deref(), Some(Diag::ManagedPolicy.message()));
        p.collect(NOW + 12 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn registry_key_has_separators() {
        assert_eq!(POLICY_REGISTRY_KEY, r"SOFTWARE\Policies\ClaudeCode");
    }

    #[test]
    fn c6_managed_setting_files_are_detected_by_existence_only() {
        let d = home("managed-files");
        assert_eq!(managed_files_state(&d), Managed::Absent);
        std::fs::create_dir_all(d.join("managed-settings.d")).unwrap();
        assert_eq!(
            managed_files_state(&d),
            Managed::Present,
            "the drop-in directory alone counts"
        );
        std::fs::remove_dir_all(d.join("managed-settings.d")).unwrap();
        std::fs::write(d.join("managed-settings.json"), "{}").unwrap();
        assert_eq!(managed_files_state(&d), Managed::Present);
        let _ = std::fs::remove_dir_all(d);
    }

    #[test]
    #[cfg(windows)]
    fn c6_registry_lookup_tells_present_from_absent_on_real_keys() {
        // Without changing any settings, check RegGetValueW's result for an existing value, a missing value and a missing key
        let current = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        assert_eq!(
            registry_value_state(HKEY_LOCAL_MACHINE, current, "ProductName"),
            Managed::Present
        );
        assert_eq!(
            registry_value_state(HKEY_LOCAL_MACHINE, current, "HeadroomNoSuchValue"),
            Managed::Absent
        );
        assert_eq!(
            registry_value_state(HKEY_CURRENT_USER, r"SOFTWARE\HeadroomNoSuchKey", "Settings"),
            Managed::Absent
        );
    }

    #[test]
    #[cfg(windows)]
    fn this_pc_has_no_managed_settings() {
        // Absent on the dev machine (no managed settings). Confirms the registry query actually works
        assert_eq!(managed_settings_state(), Managed::Absent);
    }

    #[test]
    fn non_subscription_login_skips_usage() {
        let api_key = parse_auth_status(&json!({"authMethod": "api_key"}), true);
        assert_eq!(api_key.subscription, Some(false));
        assert_eq!(api_key.logged_in, Some(true));
        assert_eq!(
            parse_auth_status(&json!({"authMethod": "none"}), true).logged_in,
            Some(false)
        );
        assert_eq!(
            parse_auth_status(&json!({}), false).logged_in,
            Some(false),
            "exit code 1 means not signed in"
        );
        assert_eq!(
            parse_auth_status(&json!({"authMethod": "claude.ai"}), true).subscription,
            Some(true)
        );
        // An unknown or missing sign-in method doesn't confirm a subscription, so /usage is never run
        for auth in [
            json!({"authMethod": "new_method", "loggedIn": true, "subscriptionType": "max"}),
            json!({"loggedIn": true, "subscriptionType": "max"}),
        ] {
            let unknown = parse_auth_status(&auth, true);
            assert_eq!(unknown.subscription, None);
            let (mut p, fake, _h) = provider("auth-unknown", vec![Ok(usage_text(10))]);
            fake.set_auth(Ok(unknown));
            let snap = p.collect(NOW, false);
            p.collect(NOW + 10 * MINUTE_MS, true);
            assert_eq!(fake.calls(), 0, "not even with --force: {auth}");
            assert_eq!(snap.error.as_deref(), Some(Diag::AuthUnknown.message()));
            assert_eq!(p.usage_due_ms(NOW), i64::MAX);
        }

        let (mut p, fake, h) = provider("api-key", vec![Ok(usage_text(10))]);
        fake.set_auth(Ok(api_key));
        let snap = p.collect(NOW, false);
        assert_eq!(
            fake.calls(),
            0,
            "/usage is not run because no usage-limit lines are shown"
        );
        assert_eq!(snap.error_code, Some(ErrorCode::LoginRequired));
        assert_eq!(snap.error.as_deref(), Some(Diag::NotSubscription.message()));
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_clock_that_went_back_doesnt_hold_the_next_usage_off_until_it_catches_up() {
        // fetched while the clock was 6 hours ahead, then the clock was set back
        let (mut p, fake, h) = provider("clock-back", vec![Ok(usage_text(10)), Ok(usage_text(11))]);
        let ahead = NOW + 6 * 60 * MINUTE_MS;
        p.collect(ahead, false);
        assert_eq!(fake.calls(), 1);
        // Back on the right clock: due at once, so the times are rewritten to now (no fetch yet: the interval counts from now)
        assert_eq!(p.next_due_ms(NOW), NOW);
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);
        assert_eq!(
            p.usage_due_ms(NOW),
            NOW + 5 * MINUTE_MS,
            "the interval from now, not from 6 hours ahead"
        );
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 2, "fetched again after the interval");
        let _ = std::fs::remove_dir_all(h);
    }

    static CLAUDE_CLOCK: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    fn claude_clock() -> i64 {
        CLAUDE_CLOCK.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn an_attempt_saved_by_another_process_while_waiting_is_not_taken_for_a_clock_gone_back() {
        // The agent read 12:00:00, then waited; a manual collect fetched at 12:00:30 meanwhile. The clock reads 12:00:40 under the lock
        let (mut p, fake, h) = provider("clock-race", vec![Ok(usage_text(10))]);
        let mut other = load_state(&h.join(STATE_FILE));
        other.last_attempt_ms = NOW + 30_000;
        write_json_atomic(&h.join(STATE_FILE), &other).unwrap();
        p.clock = Some(claude_clock);
        CLAUDE_CLOCK.store(NOW + 40_000, std::sync::atomic::Ordering::SeqCst);
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 0, "the other process's fetch counts");
        assert_eq!(
            load_state(&h.join(STATE_FILE)).last_attempt_ms,
            NOW + 30_000,
            "not rewritten to an earlier time"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_value_fetched_ahead_of_the_clock_neither_shows_nor_holds_the_schedule() {
        // 100% fetched while the clock ran 3 hours ahead; set back, the next fetch is due after the normal interval, not the 60 minutes
        // of a reached limit
        let (mut p, _fake, h) = provider("ahead-value", vec![Ok(usage_text(100))]);
        let ahead = NOW + 3 * 60 * MINUTE_MS;
        p.collect(ahead, false);
        let snap = p.collect(NOW, false);
        assert!(snap.windows.is_empty(), "not shown");
        assert_eq!(p.usage_due_ms(NOW), NOW + 5 * MINUTE_MS);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_statusline_value_stamped_ahead_is_never_used_also_once_the_time_catches_up() {
        // written at 12:06 by a clock 6 minutes ahead; the clock is synced to 12:00 before the agent reads it
        let (mut p, _fake, h) = provider("capture-ahead", vec![Ok(usage_text(10))]);
        p.collect(NOW, false);
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 55, "resets_at": 1794844800}}),
            NOW + 6 * MINUTE_MS,
        )
        .unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        p.collect(NOW + MINUTE_MS, false);
        // The next /usage fails, so nothing newer replaces either value
        _fake.push_usage(Err(UsageError::Retry(Diag::CliError)));
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let later = p.collect(NOW + 7 * MINUTE_MS, false);
        let five = later.windows.iter().find(|w| w.id == "five_hour").unwrap();
        assert_eq!(
            five.used_percent, 10.0,
            "the value from the clock ahead stays out, the /usage value stays"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_refused_clock_makes_claude_forget_what_it_cached() {
        // the /usage value and a newer statusLine value of the same window, both stamped by a clock the destination refused
        let (mut p, fake, h) = provider("forget-cached", vec![Ok(usage_text(10))]);
        p.collect(NOW, false);
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percent": 55, "used_percentage": 55, "resets_at": 1794844800}}),
            NOW + MINUTE_MS,
        )
        .unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        p.collect(NOW + MINUTE_MS, false);
        // the destination refused the clock, and lifted it again: both values are of the epoch before
        let step = |trusted: bool| {
            let _lock = crate::clock::hold_clock_lock(&h).unwrap();
            let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
            crate::clock::advance_locked(&h, &state, trusted).unwrap();
        };
        step(false);
        step(true);
        assert!(p.forget_cached());
        // the statusLine value goes away; neither comes back
        fake.push_usage(Err(UsageError::Retry(Diag::CliError)));
        let later = p.collect(NOW + 10 * MINUTE_MS, false);
        assert!(later.windows.is_empty(), "{later:?}");
        // a new statusLine value is used again
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 60, "resets_at": 1794844800}}),
            NOW + 11 * MINUTE_MS,
        )
        .unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let fresh = p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(fresh.windows.len(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn nothing_is_fetched_without_a_trusted_clock_and_no_value_of_an_earlier_epoch_shows() {
        let (mut p, _fake, h) = provider("epochs", vec![Ok(usage_text(10)), Ok(usage_text(20))]);
        let first = p.collect(NOW, false);
        let five = |s: &ProviderSnapshot| {
            s.windows
                .iter()
                .find(|w| w.id == "five_hour")
                .map(|w| w.used_percent)
        };
        assert_eq!(five(&first), Some(10.0));
        let step = |trusted: bool| {
            let _lock = crate::clock::hold_clock_lock(&h).unwrap();
            let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
            crate::clock::advance_locked(&h, &state, trusted).unwrap();
        };
        // refused: nothing fetched (also when forced), and the value before isn't shown
        step(false);
        let held = p.collect(NOW + 10 * MINUTE_MS, true);
        assert_eq!(five(&held), None);
        // lifted: the value of the epoch before still isn't shown; a new fetch is
        step(true);
        let again = p.collect(NOW + 11 * MINUTE_MS, true);
        assert_eq!(
            five(&again),
            Some(20.0),
            "fetched anew (the queued 20 was not used while refused)"
        );
    }

    #[test]
    fn values_of_an_epoch_gone_show_nowhere_also_between_collects_and_a_new_statusline_value_stays()
    {
        let (mut p, _fake, h) = provider("epoch-between", vec![Ok(usage_text(100))]);
        p.collect(NOW, false);
        let five = |s: &ProviderSnapshot| {
            s.windows
                .iter()
                .find(|w| w.id == "five_hour")
                .map(|w| w.used_percent)
        };
        assert_eq!(five(&p.build(NOW)), Some(100.0));
        let step = |trusted: bool| {
            let _lock = crate::clock::hold_clock_lock(&h).unwrap();
            let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
            crate::clock::advance_locked(&h, &state, trusted).unwrap();
        };
        step(false);
        step(true);
        // no collect since (e.g. the state lock was busy): the value of the epoch before is neither shown nor holds the fetch off
        assert_eq!(five(&p.build(NOW + MINUTE_MS)), None);
        // a statusLine value taken in the new epoch: tidying the old one leaves it
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 30, "resets_at": 1794844800}}),
            NOW + 2 * MINUTE_MS,
        )
        .unwrap();
        assert!(p.forget_cached());
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let after = p.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(five(&after), Some(30.0));
    }

    #[test]
    fn tidying_waits_while_the_clock_state_cant_be_read_so_a_new_statusline_value_stays() {
        let (mut p, _fake, h) = provider("epoch-unreadable", vec![Ok(usage_text(100))]);
        p.collect(NOW, false);
        let five = |s: &ProviderSnapshot| {
            s.windows
                .iter()
                .find(|w| w.id == "five_hour")
                .map(|w| w.used_percent)
        };
        let step = |trusted: bool| {
            let _lock = crate::clock::hold_clock_lock(&h).unwrap();
            let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
            crate::clock::advance_locked(&h, &state, trusted).unwrap();
        };
        step(false);
        step(true);
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 30, "resets_at": 1794844800}}),
            NOW + 2 * MINUTE_MS,
        )
        .unwrap();
        // the clock state can't be read just while tidying: nothing is tidied (a value of the current epoch isn't taken for an old one)
        let path = h.join("clock-epoch.json");
        let saved = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"{").unwrap();
        assert!(!p.forget_cached());
        std::fs::write(&path, saved).unwrap();
        assert!(p.forget_cached());
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let after = p.collect(NOW + 3 * MINUTE_MS, false);
        assert_eq!(five(&after), Some(30.0), "the new value is kept");
    }

    #[test]
    fn an_acceptance_is_made_only_under_a_trusted_clock_and_said_only_once_saved() {
        let (mut p, _fake, h) = provider("accept-epoch", vec![Ok(usage_text(10))]);
        signed_in_as(&mut p, &h, "b");
        p.state.account_changed = true;
        write_json_atomic(&h.join(STATE_FILE), &p.state).unwrap();
        {
            let _lock = crate::clock::hold_clock_lock(&h).unwrap();
            let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
            crate::clock::advance_locked(&h, &state, false).unwrap();
        }
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW, true);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(
            load_state(&h.join(STATE_FILE)).account_changed,
            "still pending"
        );
        // asked once: a later collect under a trusted clock doesn't accept it on its own
        crate::push::trust_without_push(&h).unwrap();
        p.collect(NOW + MINUTE_MS, true);
        assert!(load_state(&h.join(STATE_FILE)).account_changed);
        // the control: asked under a trusted clock, accepted and saved
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 2 * MINUTE_MS, true);
        assert_eq!(p.account_accepted(), Some(true));
        assert!(!load_state(&h.join(STATE_FILE)).account_changed);
    }

    #[test]
    fn an_acceptance_that_cant_be_saved_isnt_made_and_one_that_can_is_said() {
        let (mut p, _fake, h) =
            provider("accept-save", vec![Ok(usage_text(10)), Ok(usage_text(10))]);
        signed_in_as(&mut p, &h, "b");
        p.state.account_changed = true;
        write_json_atomic(&h.join(STATE_FILE), &p.state).unwrap();
        // the state can't be written (a folder where its temporary file goes)
        let tmp = h
            .join(STATE_FILE)
            .with_extension(format!("{}.tmp", std::process::id()));
        std::fs::create_dir(&tmp).unwrap();
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW, true);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(
            p.state.account_changed,
            "not made: nothing is fetched for the new account"
        );
        assert!(load_state(&h.join(STATE_FILE)).account_changed);
        // the control: it can be saved, so it is made and said (saved by itself before the fetch and the last save)
        std::fs::remove_dir(&tmp).unwrap();
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + MINUTE_MS, true);
        assert_eq!(p.account_accepted(), Some(true));
        assert!(!load_state(&h.join(STATE_FILE)).account_changed);
    }

    #[test]
    fn files_that_cant_be_read_are_not_taken_as_nothing_to_forget() {
        let (mut p, _fake, h) = provider("forget-unreadable", vec![Ok(usage_text(10))]);
        p.collect(NOW, false);
        // a new epoch: the value is of the one before, so there is something to forget
        {
            let _lock = crate::clock::hold_clock_lock(&h).unwrap();
            let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
            crate::clock::advance_locked(&h, &state, true).unwrap();
        }
        // the state holds the /usage value but can't be read while forgetting (a folder in its place stands for an I/O error)
        let state = h.join(STATE_FILE);
        let saved = std::fs::read(&state).unwrap();
        std::fs::remove_file(&state).unwrap();
        std::fs::create_dir(&state).unwrap();
        assert!(
            !p.forget_cached(),
            "not forgotten: the value may be read back later"
        );
        std::fs::remove_dir(&state).unwrap();
        std::fs::write(&state, &saved).unwrap();
        assert!(load_state(&state).last_ok.is_some(), "still there");
        // the statusLine value can't be read: not forgotten either
        let capture = h.join(crate::statusline::CAPTURE_FILE);
        let _ = std::fs::remove_file(&capture);
        std::fs::create_dir(&capture).unwrap();
        assert!(!p.forget_cached());
        std::fs::remove_dir(&capture).unwrap();
        // readable again: forgotten
        assert!(p.forget_cached());
        assert!(load_state(&state).last_ok.is_none());
        // contents that aren't a state are never read as values: nothing to forget (a broken file doesn't keep the refusal forever)
        std::fs::write(&state, "not a state").unwrap();
        assert!(p.forget_cached());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn blocked_slows_down_until_reset() {
        // 5-hour window at 100%, reset 3 hours after NOW (11/17 1:00 JST = 16:00Z)
        let (mut p, fake, h) = provider(
            "blocked",
            vec![Ok(usage_text(100)), Ok(usage_text(100)), Ok(usage_text(3))],
        );
        let snap = p.collect(NOW, false);
        assert_eq!(snap.blocked, Some(true));
        assert_eq!(
            p.usage_due_ms(NOW),
            NOW + 60 * MINUTE_MS,
            "every 60 minutes while maxed out"
        );
        p.collect(NOW + 5 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 1, "does not fetch at the normal 5 minutes");
        p.collect(NOW + 170 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 2);
        // 1 minute after the reset (NOW + 180 min). Later than the normal interval (175 min), so this one applies
        assert_eq!(p.usage_due_ms(NOW + 170 * MINUTE_MS), NOW + 181 * MINUTE_MS);
        p.collect(NOW + 181 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 3);
        assert_eq!(
            p.usage_due_ms(NOW + 181 * MINUTE_MS),
            NOW + 186 * MINUTE_MS,
            "back to the normal 5 minutes afterwards"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn safety_stop_survives_later_cli_diagnostics() {
        let (mut p, fake, h) = provider(
            "safety-stop-diag",
            vec![Err(UsageError::Stop(Diag::NotLocal))],
        );
        let snap = p.collect(NOW, false);
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        // The version check 61 minutes later can't find the CLI
        fake.0
            .lock()
            .unwrap()
            .versions
            .push_back(Err(Diag::CliNotFound));
        let snap = p.collect(NOW + 61 * MINUTE_MS, false);
        assert_eq!(
            snap.error_code,
            Some(ErrorCode::SafetyStop),
            "not overwritten with not_installed"
        );
        assert_eq!(
            snap.error.as_deref(),
            Some(Diag::NotLocal.message()),
            "keeps the stop reason"
        );
        // Even when the CLI is back and the version/auth checks pass, auto-fetch does not resume
        let snap = p.collect(NOW + 122 * MINUTE_MS, false);
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(fake.calls(), 1);
        // Even after a sign-out is found, the display stays safety_stop
        fake.0.lock().unwrap().auth = Ok(AccountInfo {
            plan: None,
            logged_in: Some(false),
            subscription: None,
        });
        let snap = p.collect(NOW + 183 * MINUTE_MS, false);
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        assert!(snap.windows.is_empty());
        assert_eq!(fake.calls(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn account_stop_outranks_cli_diagnostics_until_accepted() {
        let (mut p, fake, h) = provider("account-stop-diag", vec![Ok(usage_text(80))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);

        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        // In the same fetch as the switch, the CLI is temporarily missing
        fake.0
            .lock()
            .unwrap()
            .versions
            .push_back(Err(Diag::CliNotFound));
        let snap = p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        assert_eq!(snap.status, ProviderStatus::Unavailable);
        assert_eq!(
            snap.error_code,
            Some(ErrorCode::AccountChanged),
            "not overwritten with not_installed"
        );
        assert!(snap.windows.is_empty());

        // Even when the version/auth checks pass, the switch stop is returned until accepted
        let snap = p.collect(NOW + 70 * MINUTE_MS, false);
        assert_eq!(snap.error_code, Some(ErrorCode::AccountChanged));
        assert!(snap.windows.is_empty());
        assert_eq!(fake.calls(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn model_window_at_limit_does_not_block_the_provider() {
        let text = |session: u32| {
            format!(
                "{}Current week (Fable): 100% used · resets Nov 20, 4pm (Asia/Tokyo)
",
                usage_text(session)
            )
        };
        let (mut p, _fake, h) = provider("blocked-scope", vec![Ok(text(40)), Ok(text(100))]);
        let snap = p.collect(NOW, false);
        assert!(
            snap.windows
                .iter()
                .any(|w| w.scope.is_some() && w.used_percent >= 100.0)
        );
        assert_eq!(
            snap.blocked,
            Some(false),
            "usable overall when only a per-model window is at 100%"
        );
        let snap = p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(
            snap.blocked,
            Some(true),
            "blocked when the overall window is at 100%"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn account_switch_stops_until_accepted() {
        let (mut p, fake, h) = provider("account-switch", vec![Ok(usage_text(80))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 1);

        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        // statusLine values written by the CLI after the switch are not used either
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 3, "resets_at": 1794844800}}),
            NOW + 6 * MINUTE_MS,
        )
        .unwrap();
        let snap = p.collect(NOW + 6 * MINUTE_MS, false);
        assert_eq!(snap.error_code, Some(ErrorCode::AccountChanged));
        assert!(snap.windows.is_empty());
        assert_eq!(fake.calls(), 1, "no fetch after the switch");

        // Stays stopped after a restart
        let mut p2 = provider_with(&h, &fake, Logger::stderr());
        p2.set_claude_json(cj.clone());
        let snap = p2.collect(NOW + 60 * MINUTE_MS, false);
        assert_eq!(snap.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(fake.calls(), 1);
        assert_eq!(
            p2.next_due_ms(NOW + 60 * MINUTE_MS),
            p2.cli_check_due_ms(NOW + 60 * MINUTE_MS),
            "no /usage scheduled"
        );

        // Accepting manually resumes with the new account
        p2.accept_target(p2.pending_switch());
        p2.accept_account();
        let snap = p2.collect(NOW + 61 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 2);
        assert_eq!(snap.error_code, None);
        assert_eq!(snap.status, ProviderStatus::Ok);
        assert_eq!(
            snap.history_since.as_deref(),
            Some(iso_from_ms(NOW + 61 * MINUTE_MS).as_str()),
            "sends the acceptance time as the history boundary"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn usage_args_use_guards_and_keep_slash_commands() {
        let a = usage_args();
        assert!(a.windows(2).any(|w| w == ["--model", GUARD_MODEL]));
        assert!(
            a.windows(2)
                .any(|w| w == ["--fallback-model", GUARD_FALLBACK_MODEL])
        );
        assert_ne!(
            GUARD_MODEL, GUARD_FALLBACK_MODEL,
            "the same name would be dropped as a duplicate and the configured fallback used"
        );
        assert!(a.windows(2).any(|w| w == ["--setting-sources", "local"]));
        assert!(!a.contains(&"--disable-slash-commands".to_string()));
        assert_eq!(a.last().map(String::as_str), Some("/usage"));
    }

    #[test]
    fn host_injected_env_is_recognized() {
        for name in [
            "CLAUDECODE",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDE_AGENT_SDK_VERSION",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_PID",
        ] {
            assert!(is_host_injected_env(name), "{name}");
        }
        for name in [
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "PATH",
            "HEADROOM_CLAUDE_BIN",
        ] {
            assert!(!is_host_injected_env(name), "{name}");
        }
    }

    #[test]
    fn missing_binary_is_a_normal_failure() {
        assert_eq!(resolve_bin("headroom-no-such-claude-binary"), None);
        let mut cli = RealCli::new("headroom-no-such-claude-binary".into());
        assert_eq!(
            cli.usage(&std::env::temp_dir()),
            Err(UsageError::Retry(Diag::CliNotFound))
        );
        assert_eq!(cli.version(), Err(Diag::CliNotFound));
    }

    // ---- Strict zero-use check ----

    fn zero_result() -> Value {
        json!({
            "local_command": "usage", "num_turns": 0, "total_cost_usd": 0, "is_error": false,
            "usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
            "result": "Current session: 10% used"
        })
    }

    #[test]
    fn strict_zero_check() {
        assert!(check_usage_result(&zero_result()).is_ok());
        // Minimal response reproduced by Codex
        let minimal = json!({"local_command": "usage", "result": "Current session: 10% used"});
        assert_eq!(
            check_usage_result(&minimal),
            Err(UsageError::Stop(Diag::Unverifiable))
        );

        type Case = (&'static str, Box<dyn Fn(&mut Value)>, Diag);
        let cases: Vec<Case> = vec![
            (
                "no marker",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("local_command");
                }),
                Diag::NotLocal,
            ),
            (
                "marker has another value",
                Box::new(|v| v["local_command"] = json!("usage2")),
                Diag::NotLocal,
            ),
            (
                "no turn count",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("num_turns");
                }),
                Diag::Unverifiable,
            ),
            (
                "turn count is a string",
                Box::new(|v| v["num_turns"] = json!("0")),
                Diag::Unverifiable,
            ),
            (
                "turn count 1",
                Box::new(|v| v["num_turns"] = json!(1)),
                Diag::NotLocal,
            ),
            (
                "turn count 0.5",
                Box::new(|v| v["num_turns"] = json!(0.5)),
                Diag::NotLocal,
            ),
            (
                "no cost",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("total_cost_usd");
                }),
                Diag::Unverifiable,
            ),
            (
                "cost is a string",
                Box::new(|v| v["total_cost_usd"] = json!("0")),
                Diag::Unverifiable,
            ),
            (
                "nonzero cost",
                Box::new(|v| v["total_cost_usd"] = json!(0.0001)),
                Diag::NotLocal,
            ),
            (
                "no usage",
                Box::new(|v| {
                    v.as_object_mut().unwrap().remove("usage");
                }),
                Diag::Unverifiable,
            ),
            (
                "no input tokens",
                Box::new(|v| {
                    v["usage"].as_object_mut().unwrap().remove("input_tokens");
                }),
                Diag::Unverifiable,
            ),
            (
                "output tokens null",
                Box::new(|v| v["usage"]["output_tokens"] = Value::Null),
                Diag::Unverifiable,
            ),
            (
                "input 5",
                Box::new(|v| v["usage"]["input_tokens"] = json!(5)),
                Diag::NotLocal,
            ),
            (
                "positive and negative cancel out",
                Box::new(|v| {
                    v["usage"]["input_tokens"] = json!(5);
                    v["usage"]["output_tokens"] = json!(-5);
                }),
                Diag::NotLocal,
            ),
            (
                "negative value only",
                Box::new(|v| v["usage"]["cache_read_input_tokens"] = json!(-1)),
                Diag::Unverifiable,
            ),
            (
                "thinking tokens",
                Box::new(|v| v["usage"]["output_tokens_details"] = json!({"thinking_tokens": 3})),
                Diag::NotLocal,
            ),
            (
                "iterations present",
                Box::new(|v| v["usage"]["iterations"] = json!([{"input_tokens": 1}])),
                Diag::NotLocal,
            ),
            (
                "iterations is not an array",
                Box::new(|v| v["usage"]["iterations"] = json!({"count": 1})),
                Diag::Unverifiable,
            ),
            (
                "iterations null",
                Box::new(|v| v["usage"]["iterations"] = Value::Null),
                Diag::Unverifiable,
            ),
            (
                "additional counter is a string",
                Box::new(|v| v["usage"]["server_tool_use"] = json!({"web_search_requests": "1"})),
                Diag::Unverifiable,
            ),
            (
                "additional counter is nested",
                Box::new(|v| v["usage"]["cache_creation"] = json!({"ephemeral": {"tokens": 1}})),
                Diag::Unverifiable,
            ),
            (
                "additional counters are not an object",
                Box::new(|v| v["usage"]["output_tokens_details"] = json!(3)),
                Diag::Unverifiable,
            ),
        ];
        for (name, mutate, want) in cases {
            let mut v = zero_result();
            mutate(&mut v);
            assert_eq!(
                check_usage_result(&v),
                Err(UsageError::Stop(want)),
                "{name}"
            );
        }
    }

    #[test]
    fn after_spawn_unverifiable_stops_but_spawn_failure_retries() {
        let ok = |s: &str| {
            Ok(CmdOutput {
                stdout: s.into(),
                success: true,
            })
        };
        assert_eq!(
            classify_usage_output(Err(RunError::Timeout)),
            Err(UsageError::Stop(Diag::UsageTimeout))
        );
        assert_eq!(
            classify_usage_output(ok("not json")),
            Err(UsageError::Stop(Diag::Unverifiable))
        );
        assert_eq!(
            classify_usage_output(ok("")),
            Err(UsageError::Stop(Diag::Unverifiable))
        );
        assert_eq!(
            classify_usage_output(Err(RunError::NotFound)),
            Err(UsageError::Retry(Diag::CliNotFound))
        );
        assert_eq!(
            classify_usage_output(Err(RunError::StartFailed)),
            Err(UsageError::Retry(Diag::CliStartFailed))
        );
        assert!(classify_usage_output(ok(&real_fixture().to_string())).is_ok());
    }

    #[test]
    fn a_run_cut_off_by_the_computer_s_sleep_is_an_ordinary_failure_tried_again() {
        // the OS's two clocks (one runs on while asleep, one stops) drift apart only while asleep
        let s = Duration::from_secs;
        let at = |total: u64, awake: u64| Some((s(total), s(awake)));
        assert!(
            !slept_during(at(100, 100), at(130, 130)),
            "awake (also busy, or with the wall clock set)"
        );
        assert!(
            !slept_during(at(100, 100), at(134, 130)),
            "a few seconds' drift"
        );
        assert!(
            slept_during(at(100, 100), at(100 + 84 * 60, 130)),
            "asleep for 84 minutes"
        );
        assert!(
            !slept_during(None, at(9_000, 130)),
            "a reading missing: not slept (a timeout stays a safety stop)"
        );
        assert!(!slept_during(at(100, 100), None));
        // past the deadline after a sleep: tried again, no safety stop; without one, still a safety stop
        assert_eq!(
            classify_usage_output(Err(RunError::Suspended)),
            Err(UsageError::Retry(Diag::Suspended))
        );
        assert_eq!(
            classify_usage_run(Err(RunError::Suspended)),
            Err(UsageError::Retry(Diag::Suspended))
        );
        let (mut p, fake, h) = provider("suspended", vec![Err(UsageError::Retry(Diag::Suspended))]);
        let snap = p.collect(NOW, false);
        assert!(!p.state.guard_tripped, "no safety stop");
        assert_eq!(snap.error.as_deref(), Some(Diag::Suspended.message()));
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::Failed
            )),
            "the attempt ends as failed: the shared turn is handed back, other PCs fetch on"
        );
        assert_eq!(fake.calls(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn stopped_provider_does_not_resume_on_its_own() {
        let (mut p, fake, h) = provider("stop", vec![Err(UsageError::Stop(Diag::UsageTimeout))]);
        let snap = p.collect(NOW, false);
        assert!(p.state.guard_tripped);
        assert_eq!(snap.error.as_deref(), Some(Diag::UsageTimeout.message()));
        for m in [5, 60, 600] {
            p.collect(NOW + m * MINUTE_MS, false);
        }
        assert_eq!(
            fake.calls(),
            1,
            "does not resume except with a manual --force"
        );
        {
            p.confirm_safety(true);
            p.collect(NOW + 601 * MINUTE_MS, true)
        };
        assert_eq!(fake.calls(), 2);
        assert!(
            !p.state.guard_tripped,
            "resumes when the check passes with --force"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn unverified_cli_version_keeps_statusline_only() {
        let h = home("version");
        let fake = Fake::new(vec![]);
        fake.0.lock().unwrap().version = Ok("2.1.200".into());
        let mut p = provider_with(&h, &fake, Logger::stderr());
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 40, "resets_at": 1794844800}}),
            NOW,
        )
        .unwrap();
        let snap = p.collect(NOW, false);
        assert_eq!(
            fake.calls(),
            0,
            "/usage is not run on an unverified version"
        );
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(snap.windows[0].used_percent, 40.0);
        assert_eq!(snap.error.as_deref(), Some(Diag::UnsupportedCli.message()));
        assert_eq!(parse_version("2.1.325 (Claude Code)"), Some((2, 1, 325)));
        assert_eq!(parse_version("garbage"), None);
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- Safety stop carries over from old state ----

    #[test]
    fn v1_state_keeps_guard_and_interval() {
        let v1_window = json!({"id": "five_hour", "label": "5h", "used_percent": 10, "resets_at": null, "window_seconds": 18000});
        let write = |h: &Path, guard: bool| {
            let s = json!({
                "last_ok": {"fetched_ms": NOW - 60_000, "windows": [v1_window]},
                "failures": 0, "last_attempt_ms": NOW - 60_000,
                "last_error": "usage: user@example.com", "guard_tripped": guard
            });
            std::fs::write(h.join(STATE_FILE), s.to_string()).unwrap();
        };
        // Old state while stopped: no fetch even after a restart
        let h = home("v1-guard");
        write(&h, true);
        let fake = Fake::new(vec![]);
        let mut p = provider_with(&h, &fake, Logger::stderr());
        assert!(p.state.guard_tripped);
        assert!(
            p.state.last_ok.is_none(),
            "old-format observations are discarded"
        );
        assert_eq!(p.state.last_error, None, "old-format free text is dropped");
        let snap = p.collect(NOW, false);
        assert_eq!(snap.error_code, Some(ErrorCode::SafetyStop));
        assert_eq!(fake.calls(), 0);
        let _ = std::fs::remove_dir_all(h);
        // Old state, not stopped: no fetch within 5 minutes of the last attempt
        let h = home("v1-interval");
        write(&h, false);
        let fake = Fake::new(vec![]);
        let mut p = provider_with(&h, &fake, Logger::stderr());
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 0);
        p.collect(NOW + 4 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 1, "fetches 5 minutes after the last attempt");
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- The resident agent and manual collection share state ----

    #[test]
    fn second_provider_respects_stop_saved_by_first() {
        let h = home("shared");
        let fa = Fake::new(vec![Err(UsageError::Stop(Diag::NotLocal))]);
        let fb = Fake::new(vec![]);
        let mut a = provider_with(&h, &fa, Logger::stderr());
        let mut b = provider_with(&h, &fb, Logger::stderr()); // created before the stop (holds stale state)
        a.collect(NOW, false);
        b.collect(NOW + MINUTE_MS, false);
        assert_eq!(
            fb.calls(),
            0,
            "respects the stop saved by the other process"
        );
        assert!(
            load_state(&h.join(STATE_FILE)).guard_tripped,
            "does not overwrite the stop flag"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn concurrent_collects_fetch_once() {
        let h = home("concurrent");
        let fa = Fake::new(vec![]);
        let fb = Fake::new(vec![]);
        fa.0.lock().unwrap().usage_delay = Duration::from_millis(300);
        fb.0.lock().unwrap().usage_delay = Duration::from_millis(300);
        let mut a = provider_with(&h, &fa, Logger::stderr());
        let mut b = provider_with(&h, &fb, Logger::stderr());
        // Scoped: both threads finish before the scope returns (also when one panics), so the home outlives them
        let (sa, sb) = std::thread::scope(|s| {
            let ta = s.spawn(move || a.collect(NOW, false));
            let tb = s.spawn(move || b.collect(NOW, false));
            (ta.join().unwrap(), tb.join().unwrap())
        });
        assert_eq!(
            fa.calls() + fb.calls(),
            1,
            "no duplicate fetch within 5 minutes even when overlapping"
        );
        assert_eq!(sa.windows.len(), 2);
        assert_eq!(sb.windows.len(), 2);
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- Raw CLI errors are replaced with fixed diagnostics ----

    #[test]
    fn cli_text_never_reaches_log_state_or_snapshot() {
        const SECRETS: [&str; 3] = ["example.com", "sk-ant-TESTTOKEN", "123e4567-e89b"];
        let leak = "denied for test-user@example.com token sk-ant-TESTTOKEN id 123e4567-e89b-12d3-a456-426614174000";
        let mut err = zero_result();
        err["is_error"] = json!(true);
        err["result"] = json!(leak);
        let mut not_local = zero_result();
        not_local["local_command"] = json!(leak);
        let h = home("leak");
        let fake = Fake::new(vec![
            check_usage_result(&err).map(|_| String::new()),
            check_usage_result(&not_local).map(|_| String::new()),
        ]);
        // When auth status also contains unexpected values (an email address)
        fake.set_auth(Ok(parse_auth_status(
            &json!({"authMethod": "claude.ai", "planTier": "x@example.com", "loggedIn": true, "subscriptionType": "max"}),
            true,
        )));
        let mut p = provider_with(&h, &fake, Logger::file(&h));
        let s1 = p.collect(NOW, false);
        let s2 = p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(s1.error.as_deref(), Some(Diag::CliError.message()));
        assert_eq!(s2.error.as_deref(), Some(Diag::NotLocal.message()));
        let log = std::fs::read_to_string(h.join("logs").join("agent.log")).unwrap();
        let state = std::fs::read_to_string(h.join(STATE_FILE)).unwrap();
        let snaps = serde_json::to_string(&(s1, s2)).unwrap();
        for s in SECRETS {
            assert!(!log.contains(s), "log: {s}");
            assert!(!state.contains(s), "state: {s}");
            assert!(!snaps.contains(s), "snapshot: {s}");
        }
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn login_text_maps_to_fixed_login_diag() {
        let mut v = zero_result();
        v["is_error"] = json!(true);
        v["result"] = json!("Please run /login (user@example.com)");
        assert_eq!(
            check_usage_result(&v),
            Err(UsageError::Retry(Diag::LoginRequired))
        );
    }

    // ---- Mixing windows keeps the freshness of old values ----

    #[test]
    fn mixed_windows_keep_their_own_age() {
        let three_h_ago = NOW - 180 * MINUTE_MS;
        let text =
            usage_text(1) + "Current week (Fable): 30% used · resets Nov 20, 4pm (Asia/Tokyo)\n";
        let (mut p, fake, h) = provider("mixed", vec![Ok(text)]);
        p.collect(three_h_ago, false);
        for _ in 0..40 {
            fake.push_usage(Err(UsageError::Retry(Diag::CliError)));
        }
        crate::statusline::save_capture(&h, &json!({"five_hour": {"used_percentage": 50, "resets_at": 1794844800}, "seven_day": {"used_percentage": 3, "resets_at": 1795158000}}), NOW).unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW, false);
        let get = |id: &str| snap.windows.iter().find(|w| w.id == id).unwrap();
        assert_eq!(get("five_hour").used_percent, 50.0);
        assert_eq!(
            get("five_hour").fetched_at.as_deref(),
            Some(iso_from_ms(NOW).as_str())
        );
        assert_eq!(
            get("seven_day_fable").fetched_at.as_deref(),
            Some(iso_from_ms(three_h_ago).as_str()),
            "Fable stays at 3 hours ago"
        );
        assert_eq!(
            snap.fetched_at.as_deref(),
            Some(iso_from_ms(three_h_ago).as_str()),
            "the provider time is the oldest window"
        );
        assert_eq!(
            snap.status,
            ProviderStatus::Stale,
            "not treated as fresh when an old window exists"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- Old observations are invalidated once a sign-out is confirmed ----

    #[test]
    fn logout_discards_old_values_until_relogin() {
        let (mut p, fake, h) = provider("logout", vec![Ok(usage_text(70))]);
        p.collect(NOW, false);
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 71, "resets_at": 1794844800}}),
            NOW + MINUTE_MS,
        )
        .unwrap();
        // Sign-out confirmed (auth status runs hourly). The following /usage is a sign-in error too
        fake.set_auth(Ok(AccountInfo {
            logged_in: Some(false),
            ..Default::default()
        }));
        for _ in 0..10 {
            fake.push_usage(Err(UsageError::Retry(Diag::LoginRequired)));
        }
        let snap = p.collect(NOW + 61 * MINUTE_MS, false);
        assert!(snap.windows.is_empty(), "previous values are not shown");
        // While signed out, /usage is not run. The reason is the sign-out
        assert_eq!(snap.error.as_deref(), Some(Diag::LoggedOut.message()));
        assert_eq!(snap.error_code, Some(ErrorCode::LoginRequired));
        // A restart doesn't bring values back from old statusLine captures
        let mut p2 = provider_with(&h, &fake, Logger::stderr());
        let snap = p2.collect(NOW + 62 * MINUTE_MS, false);
        assert!(snap.windows.is_empty());
        // A fetch after signing back in returns to the normal display
        fake.set_auth(Ok(logged_in()));
        fake.0.lock().unwrap().usage.clear();
        let snap = p2.collect(NOW + 130 * MINUTE_MS, true);
        assert_eq!(snap.status, ProviderStatus::Ok);
        assert_eq!(snap.windows[0].used_percent, 1.0);
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- The auth check has a deadline too ----

    #[test]
    fn hanging_child_is_killed_within_deadline() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        cmd.env("HEADROOM_TEST", "1");
        let started = Instant::now();
        assert_eq!(
            run_with_timeout(cmd, Duration::from_secs(1)),
            Err(RunError::Timeout)
        );
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_child_past_its_deadline_after_a_sleep_is_told_apart_from_one_that_hung() {
        let hanging = || {
            let mut c = if cfg!(windows) {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
                c
            } else {
                let mut c = Command::new("sleep");
                c.arg("30");
                c
            };
            c.env("HEADROOM_TEST", "1");
            c
        };
        // stand-in clocks: read before the child starts, then when the timeout is decided
        static SLEPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        fn slept_10_minutes(_: crate::time::ReadFirst) -> Option<(Duration, Duration)> {
            let n = SLEPT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some((Duration::from_secs(600 * n), Duration::ZERO))
        }
        fn awake(_: crate::time::ReadFirst) -> Option<(Duration, Duration)> {
            Some((Duration::from_secs(1), Duration::from_secs(1)))
        }
        fn unreadable(_: crate::time::ReadFirst) -> Option<(Duration, Duration)> {
            None
        }
        let run =
            |clocks| run_child_with(hanging(), Duration::from_secs(1), true, clocks).map(|_| ());
        assert_eq!(run(slept_10_minutes), Err(RunError::Suspended));
        assert_eq!(run(awake), Err(RunError::Timeout));
        assert_eq!(
            run(unreadable),
            Err(RunError::Timeout),
            "unknown: stays a safety stop"
        );
    }

    #[test]
    fn blocked_states_have_no_usage_schedule_and_auth_retries_back_off() {
        let (mut p, fake, h) = provider("auth-backoff", vec![]);
        fake.set_auth(Err(Diag::AuthFailed));
        p.collect(NOW, false);
        assert_eq!(
            p.usage_due_ms(NOW),
            i64::MAX,
            "no schedule while not running"
        );
        // Rechecks after 1 -> 2 -> 4 minutes
        let mut at = NOW;
        for wait in [1, 2, 4] {
            assert_eq!(
                p.next_due_ms(at + 1000),
                at + wait * MINUTE_MS,
                "{wait} min"
            );
            at += wait * MINUTE_MS;
            p.collect(at, false);
        }
        assert_eq!(fake.calls(), 0, "/usage is not run while failing");
        fake.set_auth(Ok(logged_in()));
        at += 8 * MINUTE_MS;
        p.collect(at, false);
        assert_eq!(fake.calls(), 1, "back to normal fetching once verified");
        assert_eq!(p.cli_check_due_ms(at), at + AUTH_INTERVAL_MS);
        let _ = std::fs::remove_dir_all(h);

        // No schedule while stopped by organization managed settings either (next check in 1 hour)
        let (mut p, fake, h) = provider("policy-idle", vec![]);
        fake.set_managed(Managed::Present);
        p.collect(NOW, false);
        assert_eq!(p.next_due_ms(NOW + 1000), NOW + AUTH_INTERVAL_MS);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn auth_timeout_does_not_block_usage() {
        let (mut p, fake, h) = provider("auth-timeout", vec![]);
        p.collect(NOW, false);
        // If the auth check fails, the previous plan isn't trusted and /usage is not run. The display continues with the previous values
        fake.set_auth(Err(Diag::AuthTimeout));
        let snap = p.collect(NOW + 61 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 1, "not run when the auth check fails");
        assert!(
            !snap.windows.is_empty(),
            "keeps showing the previous values (the display side shows their age)"
        );
        p.collect(NOW + 67 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 1, "not run even with --force");
        // Rechecks at the next opportunity (without waiting an hour) and resumes once readable
        fake.set_auth(Ok(logged_in()));
        p.collect(NOW + 73 * MINUTE_MS, false);
        assert_eq!(fake.calls(), 2, "resumes once the recheck succeeds");
        // Not run if the plan has never been verified (organization plans can't be ruled out)
        let (mut p, fake, h2) = provider("auth-timeout-first", vec![]);
        fake.set_auth(Err(Diag::AuthTimeout));
        p.collect(NOW, false);
        assert_eq!(fake.calls(), 0);
        let _ = std::fs::remove_dir_all(h2);
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- Reset times are converted in the source time zone ----

    #[test]
    fn reset_uses_named_zone_and_dst() {
        let iso = |w: &str, now: i64| parse_reset(w, now, &tokyo()).map(iso_from_ms);
        // Reading New York times on a Tokyo PC (11/20 is EST)
        assert_eq!(
            iso("Nov 20, 4pm (America/New_York)", NOW).as_deref(),
            Some("2026-11-20T21:00:00.000Z")
        );
        // Across the end of DST (2026-11-01): even though it is EDT now, 11/2 is converted as EST
        let oct30 = 1_793_376_000_000; // 2026-10-30T16:00:00Z
        assert_eq!(
            iso("Nov 2, 4pm (America/New_York)", oct30).as_deref(),
            Some("2026-11-02T21:00:00.000Z")
        );
        assert_eq!(
            iso("Oct 31, 4pm (America/New_York)", oct30).as_deref(),
            Some("2026-10-31T20:00:00.000Z")
        );
        // The earlier JST / UTC examples
        assert_eq!(
            iso("Nov 17, 12:59am (Asia/Tokyo)", NOW).as_deref(),
            Some("2026-11-16T15:59:00.000Z")
        );
        assert_eq!(
            iso("Nov 20, 12pm (UTC)", NOW).as_deref(),
            Some("2026-11-20T12:00:00.000Z")
        );
        // Time only: today's 11pm (Tokyo) is still ahead; 9pm has passed, so it is tomorrow
        assert_eq!(
            iso("11pm (Asia/Tokyo)", NOW).as_deref(),
            Some("2026-11-16T14:00:00.000Z")
        );
        assert_eq!(
            iso("9pm (Asia/Tokyo)", NOW).as_deref(),
            Some("2026-11-17T12:00:00.000Z")
        );
        // Without parentheses, the default time zone
        assert_eq!(
            iso("Nov 20, 4pm", NOW).as_deref(),
            Some("2026-11-20T07:00:00.000Z")
        );
        // A January reset in December -> next year
        let dec = 1_797_465_600_000; // 2026-12-17T00:00:00Z
        assert_eq!(
            iso("Jan 2, 4pm (Asia/Tokyo)", dec).as_deref(),
            Some("2027-01-02T07:00:00.000Z")
        );
        // Unresolvable time zones / formats give null
        assert_eq!(iso("Nov 20, 4pm (Mars/Olympus_Mons)", NOW), None);
        assert_eq!(iso("soon", NOW), None);
    }

    #[test]
    fn unknown_zone_keeps_percent() {
        let ws = parse_usage_text(
            "Current session: 12% used · resets Nov 17, 1am (Mars/Olympus_Mons)\n",
            NOW,
            &tokyo(),
        );
        assert_eq!(
            (ws[0].used_percent, ws[0].resets_at.as_deref()),
            (12.0, None)
        );
    }

    /// .claude.json names this account, and the state knows it as the one switched to
    fn signed_in_as(p: &mut ClaudeProvider, h: &Path, uuid: &str) {
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            format!(r#"{{"oauthAccount":{{"accountUuid":"{uuid}","organizationUuid":"o"}}}}"#),
        )
        .unwrap();
        p.set_claude_json(cj);
        p.state.account_hash = Some(fnv1a_hex(&[uuid, "o"]));
    }

    /// A provider stopped by an account switch (the switch seen at NOW + 6 minutes)
    fn switched(name: &str) -> (ClaudeProvider, Fake, crate::test_util::TempHome) {
        let (mut p, fake, h) = provider(name, vec![Ok(usage_text(80)), Ok(usage_text(10))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.collect(NOW + 6 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        (p, fake, h)
    }

    #[test]
    fn an_acceptance_a_collect_couldnt_make_is_never_left_for_a_later_one() {
        let (mut p, fake, h) = switched("accept-once");
        // a collect that ends early (turned off meanwhile, a lock held elsewhere): not made, and said so
        p.cfg.enabled = false;
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        p.cfg.enabled = true;
        let _ = &h;
        // the next collect, not asked to, doesn't accept it
        p.collect(NOW + 20 * MINUTE_MS, false);
        assert!(p.state.account_changed);
        assert_eq!(p.account_accepted(), None);
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn only_the_switch_the_user_saw_is_accepted() {
        let (mut p, fake, _h) = switched("accept-target");
        let seen = p.pending_switch();
        assert!(seen.is_some());
        // another switch seen since (or none seen when asking): not accepted
        for target in [seen.map(|t| t - 1), None] {
            p.accept_target(target);
            p.accept_account();
            p.collect(NOW + 10 * MINUTE_MS, false);
            assert_eq!(p.account_accepted(), Some(false));
            assert!(p.state.account_changed);
        }
        p.accept_target(seen);
        p.accept_account();
        p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert_eq!(fake.calls(), 2);
    }

    #[test]
    fn a_forced_collect_passes_a_safety_stop_only_on_the_user_s_explicit_go() {
        let (mut p, fake, h) = provider(
            "confirm",
            vec![Err(UsageError::Stop(Diag::UsageTimeout)), Ok(usage_text(5))],
        );
        p.collect(NOW, false);
        assert!(p.safety_stopped());
        // brought forward (a resume, a fetch the user asked for) but not confirmed: nothing runs
        p.collect(NOW + 20 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 1);
        // confirmed: once; the confirmation is for that collect only
        p.confirm_safety(true);
        p.collect(NOW + 21 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 2);
        assert!(!p.safety_stopped());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn an_attempt_that_never_launched_isnt_a_query_and_a_value_that_couldnt_be_kept_isnt_a_success()
    {
        let (mut p, fake, h) = provider(
            "not-launched",
            vec![
                Err(UsageError::Retry(Diag::CliStartFailed)),
                Ok(usage_text(5)),
            ],
        );
        p.collect(NOW, true);
        assert_eq!(p.take_run(), Some(crate::providers::Run::NotRun));
        assert_eq!(p.last_fetch_attempt_ms(), None, "no query went upstream");
        // a value fetched whose state can't be saved: not a success to share
        fake.0.lock().unwrap().break_file = Some(h.join(STATE_FILE));
        let snap = p.collect(NOW + 20 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 2);
        // nor shown or sent
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 5.0),
            "{:?}",
            snap.windows
        );
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::Failed
            ))
        );
    }

    #[test]
    fn output_not_read_whole_never_confirms_zero_use() {
        let run = |complete| {
            Ok(RunOutput {
                stdout: real_fixture().to_string(),
                stderr: String::new(),
                code: Some(0),
                complete,
            })
        };
        assert!(classify_usage_run(run(true)).is_ok());
        assert_eq!(
            classify_usage_run(run(false)),
            Err(UsageError::Stop(Diag::Unverifiable))
        );
    }

    #[test]
    fn an_acceptance_reads_the_account_first_and_a_switch_found_then_isn_t_the_one_seen() {
        let (mut p, fake, h) = switched("accept-latest");
        let seen = p.pending_switch();
        // the account moved on again before the acceptance (not yet read)
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            h.join("claude.json"),
            r#"{"oauthAccount":{"accountUuid":"c","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.accept_target(seen);
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(p.state.account_changed);
        assert_ne!(p.pending_switch(), seen);
        // the one now, seen: accepted
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert_eq!(fake.calls(), 2);
    }

    #[test]
    fn a_statusline_record_of_the_account_before_isn_t_taken_after_the_acceptance() {
        let (mut p, _fake, h) = switched("accept-gen");
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        // a writer that read the account before's input saved it late (stamped after the acceptance, of the generation before)
        let late = crate::statusline::Capture {
            captured_at: iso_from_ms(NOW + 11 * MINUTE_MS),
            captured_at_ms: NOW + 11 * MINUTE_MS,
            rate_limits: json!({"five_hour": {"used_percentage": 77, "resets_at": 1794844800}}),
            epoch: crate::clock::usable_epoch(&h),
            accept_gen: p.state.accept_gen - 1,
        };
        crate::store::write_json_atomic(&h.join(crate::statusline::CAPTURE_FILE), &late).unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + 12 * MINUTE_MS, false);
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 77.0),
            "{:?}",
            snap.windows
        );
        // the control: the same record of the generation now is taken
        let now_gen = crate::statusline::Capture {
            accept_gen: p.state.accept_gen,
            captured_at_ms: NOW + 13 * MINUTE_MS,
            captured_at: iso_from_ms(NOW + 13 * MINUTE_MS),
            ..late
        };
        crate::store::write_json_atomic(&h.join(crate::statusline::CAPTURE_FILE), &now_gen)
            .unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + 14 * MINUTE_MS, false);
        assert!(
            snap.windows.iter().any(|w| w.used_percent == 77.0),
            "{:?}",
            snap.windows
        );
    }

    #[test]
    fn a_state_that_can_t_be_read_after_an_acceptance_brings_back_no_value_of_the_account_before() {
        let (mut p, _fake, h) = switched("accept-unreadable");
        // the account before's record, of the generation before the acceptance
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 66, "resets_at": 1794844800}}),
            NOW + 9 * MINUTE_MS,
        )
        .unwrap();
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        // the state can't be read once (it starts again at generation 0): the record before still isn't taken
        std::fs::write(h.join(STATE_FILE), b"{broken").unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + 11 * MINUTE_MS, false);
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 66.0),
            "{:?}",
            snap.windows
        );
    }

    #[test]
    fn an_acceptance_needs_the_account_switched_to_readable_now() {
        let (mut p, fake, h) = switched("accept-unreadable-account");
        let seen = p.pending_switch();
        // .claude.json names no account now
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(h.join("claude.json"), r#"{"oauthAccount":{}}"#).unwrap();
        p.accept_target(seen);
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(false));
        assert!(p.state.account_changed);
        // readable again as the account switched to: accepted
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            h.join("claude.json"),
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        assert_eq!(fake.calls(), 2);
    }

    #[test]
    fn a_fetch_during_which_the_account_can_t_be_read_any_more_isn_t_used() {
        let (mut p, fake, h) =
            provider("account-gone", vec![Ok(usage_text(10)), Ok(usage_text(44))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(crate::providers::Outcome::Ok))
        );
        // signed out while it ran: the file names no account
        fake.0.lock().unwrap().rewrite = Some((cj, r#"{"oauthAccount":{}}"#.into()));
        let snap = p.collect(NOW + 20 * MINUTE_MS, true);
        assert_eq!(fake.calls(), 2);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::Failed
            ))
        );
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 44.0),
            "{:?}",
            snap.windows
        );
    }

    #[test]
    fn a_provider_turned_off_never_asks_to_be_woken() {
        let (mut p, _fake, _h) = provider("off-wake", vec![]);
        p.cfg.enabled = false;
        p.on_event(&Event::ClaudeStatuslineCaptured);
        assert_eq!(p.next_due_ms(NOW), i64::MAX);
        p.collect(NOW, false);
        assert_eq!(p.next_due_ms(NOW), i64::MAX);
    }

    #[test]
    fn a_state_that_can_t_be_read_once_while_a_switch_waits_skips_the_round_and_keeps_it() {
        let (mut p, fake, h) = switched("pending-unreadable");
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 66, "resets_at": 1794844800}}),
            NOW + 7 * MINUTE_MS,
        )
        .unwrap();
        // the state can't be read now (a folder in its place): nothing is decided or saved, no value shown
        let state = h.join(STATE_FILE);
        let kept = std::fs::read(&state).unwrap();
        std::fs::remove_file(&state).unwrap();
        std::fs::create_dir(&state).unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + 8 * MINUTE_MS, false);
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 66.0),
            "{:?}",
            snap.windows
        );
        // read again a minute on, not at once, and no turn is asked for meanwhile
        assert_eq!(p.next_due_ms(NOW + 8 * MINUTE_MS), NOW + 9 * MINUTE_MS);
        assert!(p.fetch_due_ms(NOW + 8 * MINUTE_MS) >= NOW + 9 * MINUTE_MS);
        // nothing was decided on a stand-in: the switch still shows as waiting, not as a state that can't be read
        assert!(p.state.account_changed);
        assert_eq!(snap.error_code, Some(ErrorCode::AccountChanged));
        std::fs::remove_dir(&state).unwrap();
        std::fs::write(&state, kept).unwrap();
        assert!(load_state(&state).account_changed, "the switch still waits");
        assert_eq!(fake.calls(), 1);
    }

    #[test]
    fn a_state_lost_takes_no_record_from_before_also_with_no_account_read() {
        // .claude.json can't be read (none): no identification draws the line, the start again does
        let (mut p, _fake, h) = provider("state-lost-unidentified", vec![]);
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 66, "resets_at": 1794844800}}),
            NOW,
        )
        .unwrap();
        std::fs::write(h.join(STATE_FILE), b"{broken").unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + MINUTE_MS, false);
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 66.0),
            "{:?}",
            snap.windows
        );
    }

    #[test]
    fn a_state_lost_takes_no_record_from_before_and_starts_a_new_history() {
        let (mut p, _fake, h) = provider("state-lost", vec![]);
        signed_in_as(&mut p, &h, "a");
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 66, "resets_at": 1794844800}}),
            NOW,
        )
        .unwrap();
        std::fs::write(h.join(STATE_FILE), b"{broken").unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + MINUTE_MS, false);
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 66.0),
            "{:?}",
            snap.windows
        );
        assert_eq!(
            snap.history_since.as_deref(),
            Some(iso_from_ms(NOW + MINUTE_MS).as_str())
        );
        // a record after it is used
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 67, "resets_at": 1794844800}}),
            NOW + 2 * MINUTE_MS,
        )
        .unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + 3 * MINUTE_MS, false);
        assert!(
            snap.windows.iter().any(|w| w.used_percent == 67.0),
            "{:?}",
            snap.windows
        );
    }

    #[test]
    fn an_account_file_that_couldn_t_be_read_once_is_read_again() {
        let (mut p, _fake, h) = provider("account-reread", vec![Ok(usage_text(10))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        // B's file, read while half written (not JSON); later whole, with the same time
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&cj, b"{").unwrap();
        let at = std::fs::metadata(&cj).unwrap().modified().unwrap();
        p.collect(NOW + MINUTE_MS, false);
        assert!(!p.state.account_changed);
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        std::fs::File::options()
            .write(true)
            .open(&cj)
            .unwrap()
            .set_modified(at)
            .unwrap();
        p.collect(NOW + 2 * MINUTE_MS, false);
        assert!(p.state.account_changed, "the switch is found");
    }

    #[test]
    fn finding_the_executable_comes_before_the_go_s_last_check() {
        let (mut p, fake, _h) = provider("prepare-late", vec![Ok(usage_text(10))]);
        static AT: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
        fn at() -> i64 {
            AT.load(std::sync::atomic::Ordering::SeqCst)
        }
        AT.store(NOW, std::sync::atomic::Ordering::SeqCst);
        p.clock = Some(at);
        // a go good for a moment only; finding the executable takes longer
        fake.0.lock().unwrap().prepare_delay = Duration::from_millis(300);
        crate::providers::Provider::grant(
            &mut p,
            Some(crate::providers::Grant {
                until_ms: NOW + 60_000,
                until: std::time::Instant::now() + Duration::from_millis(100),
            }),
        );
        p.collect(NOW, true);
        assert_eq!(fake.calls(), 0, "nothing launched past the go");
    }

    #[test]
    fn a_rate_limit_told_as_an_error_or_on_the_error_output_is_a_rate_limit_every_pc_waits_for() {
        // an error reply with zero use confirmed, saying it is rate limited
        let mut limited = on_hold();
        limited["result"] = json!("Usage is rate limited until 3:14am");
        limited["error"] = Value::Null;
        limited["subtype"] = json!("error_during_execution");
        assert_eq!(
            check_usage_result(&limited),
            Err(UsageError::Retry(Diag::RateLimited))
        );
        // or saying so only by its error code, the field's whole value
        let mut coded = on_hold();
        coded["result"] = json!("Something went wrong");
        coded["error"] = json!("rate_limit");
        assert_eq!(
            check_usage_result(&coded),
            Err(UsageError::Retry(Diag::RateLimited))
        );
        coded["error"] = json!("cannot open rate_limit.json");
        assert_eq!(
            check_usage_result(&coded),
            Err(UsageError::Retry(Diag::CliError))
        );
        // a denial still wins over it
        assert_eq!(
            check_usage_result(&on_hold()),
            Err(UsageError::Retry(Diag::AccessDenied))
        );
        // told only on the error output, beside a reply that confirms zero use
        let mut failed = on_hold();
        failed["result"] = json!("Something went wrong");
        failed["error"] = Value::Null;
        let run = Ok(RunOutput {
            stdout: failed.to_string(),
            stderr: "API Error: 429 Too Many Requests".into(),
            code: Some(1),
            complete: true,
        });
        assert_eq!(
            classify_usage_run(run),
            Err(UsageError::Retry(Diag::RateLimited))
        );
        // not when the reply names a failure of another kind (that failure is what it is)
        let mut unavailable = failed.clone();
        unavailable["result"] = json!("API Error: 503 Service Unavailable");
        let run = Ok(RunOutput {
            stdout: unavailable.to_string(),
            stderr: "rate limited upstream".into(),
            code: Some(1),
            complete: true,
        });
        assert_eq!(
            classify_usage_run(run),
            Err(UsageError::Retry(Diag::CliError))
        );
        // the control: the same reply without it is an ordinary failure
        let plain = Ok(RunOutput {
            stdout: failed.to_string(),
            stderr: String::new(),
            code: Some(1),
            complete: true,
        });
        assert_eq!(
            classify_usage_run(plain),
            Err(UsageError::Retry(Diag::CliError))
        );
    }

    #[test]
    fn a_denial_code_counts_as_the_result_s_code_only() {
        let mut coded = on_hold();
        coded["result"] = json!("Something went wrong");
        assert_eq!(
            check_usage_result(&coded),
            Err(UsageError::Retry(Diag::AccessDenied)),
            "the -p error code"
        );
        // the same word in free text (a local file's name) isn't one
        let mut text = on_hold();
        text["result"] = json!(r#"cannot open local file "account_on_hold.json""#);
        text["error"] = Value::Null;
        assert_ne!(
            check_usage_result(&text),
            Err(UsageError::Retry(Diag::AccessDenied))
        );
    }

    #[test]
    fn a_current_state_without_its_safety_stop_is_stopped() {
        let (_p, _fake, h) = provider("guard-missing", vec![]);
        let path = h.join(STATE_FILE);
        std::fs::write(
            &path,
            format!(r#"{{"state_version":{STATE_VERSION},"failures":0}}"#),
        )
        .unwrap();
        assert!(load_state(&path).guard_tripped);
        // the control: written with it
        std::fs::write(
            &path,
            format!(r#"{{"state_version":{STATE_VERSION},"guard_tripped":false}}"#),
        )
        .unwrap();
        assert!(!load_state(&path).guard_tripped);
    }

    #[test]
    fn a_switch_whose_save_failed_is_found_again() {
        let (mut p, fake, h) = provider("switch-unsaved", vec![Ok(usage_text(10))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        // B signs in; the round that finds it can't save (a folder where the state goes)
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"b","organizationUuid":"o"}}"#,
        )
        .unwrap();
        fake.0.lock().unwrap().break_file = None;
        let tmp = h
            .join(STATE_FILE)
            .with_extension(format!("{}.tmp", std::process::id()));
        std::fs::create_dir(&tmp).unwrap();
        p.collect(NOW + MINUTE_MS, false);
        std::fs::remove_dir(&tmp).unwrap();
        assert!(
            !load_state(&h.join(STATE_FILE)).account_changed,
            "not saved"
        );
        // the next round reads the state of A back, and the file again: the switch is found
        p.collect(NOW + 2 * MINUTE_MS, false);
        assert!(p.state.account_changed);
    }

    #[test]
    fn no_statusline_record_is_used_while_the_account_can_t_be_read() {
        let (mut p, _fake, h) = provider("account-unread-capture", vec![Ok(usage_text(10))]);
        let cj = h.join("claude.json");
        std::fs::write(
            &cj,
            r#"{"oauthAccount":{"accountUuid":"a","organizationUuid":"o"}}"#,
        )
        .unwrap();
        p.set_claude_json(cj.clone());
        p.collect(NOW, false);
        // the file can't be read as an account now; a record came meanwhile
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&cj, b"{").unwrap();
        crate::statusline::save_capture(
            &h,
            &json!({"five_hour": {"used_percentage": 55, "resets_at": 1794844800}}),
            NOW + MINUTE_MS,
        )
        .unwrap();
        p.on_event(&Event::ClaudeStatuslineCaptured);
        let snap = p.collect(NOW + 2 * MINUTE_MS, false);
        assert!(
            !snap.windows.iter().any(|w| w.used_percent == 55.0),
            "{:?}",
            snap.windows
        );
    }

    #[test]
    fn values_before_a_rate_limit_are_shown_as_old() {
        let (mut p, _fake, _h) = provider(
            "rate-stale",
            vec![
                Ok(usage_text(10)),
                Err(UsageError::Retry(Diag::RateLimited)),
            ],
        );
        p.collect(NOW, false);
        let snap = p.collect(NOW + 15 * MINUTE_MS, true);
        assert_eq!(snap.status, ProviderStatus::Stale);
        assert_eq!(snap.fetched_at.as_deref(), Some(iso_from_ms(NOW).as_str()));
    }

    #[test]
    fn no_turn_is_asked_for_while_the_state_can_t_be_read() {
        let (mut p, _fake, h) = provider("state-unread-due", vec![Ok(usage_text(10))]);
        p.collect(NOW, false);
        let due = NOW + 20 * MINUTE_MS;
        assert!(p.fetch_due_ms(due) <= due, "the fetch is due");
        let state = h.join(STATE_FILE);
        let kept = std::fs::read(&state).unwrap();
        std::fs::remove_file(&state).unwrap();
        std::fs::create_dir(&state).unwrap();
        p.collect(due, false);
        assert_eq!(
            p.fetch_due_ms(due),
            i64::MAX,
            "no turn until a read succeeds"
        );
        assert_eq!(p.next_due_ms(due), due + MINUTE_MS);
        // a statusLine record that comes meanwhile wakes nothing before then
        p.on_event(&Event::ClaudeStatuslineCaptured);
        assert!(!p.passive_pending());
        assert_eq!(p.next_due_ms(due), due + MINUTE_MS);
        std::fs::remove_dir(&state).unwrap();
        std::fs::write(&state, kept).unwrap();
        // readable again: as planned
        p.collect(due + MINUTE_MS, false);
        assert!(p.state_retry_at.is_none());
        // a tidy that is the first to find it unreadable starts the wait too
        std::fs::remove_file(&state).unwrap();
        std::fs::create_dir(&state).unwrap();
        assert!(!p.forget_cached());
        assert!(p.state_retry_at.is_some());
    }

    #[test]
    fn claude_writes_a_broken_generation_file_again() {
        let (mut p, _fake, h) = switched("gen-broken-claude");
        p.accept_target(p.pending_switch());
        p.accept_account();
        p.collect(NOW + 10 * MINUTE_MS, false);
        assert_eq!(p.account_accepted(), Some(true));
        let accepted = p.state.accept_gen;
        assert!(accepted >= 1);
        std::fs::write(h.join("claude-statusline.gen"), b"").unwrap();
        p.collect(NOW + 11 * MINUTE_MS, false);
        assert_eq!(crate::statusline::read_claude_gen(&h), accepted);
        // gone: written again too
        std::fs::remove_file(h.join("claude-statusline.gen")).unwrap();
        p.collect(NOW + 12 * MINUTE_MS, false);
        assert_eq!(crate::statusline::read_claude_gen(&h), accepted);
    }

    #[test]
    fn a_claude_state_gone_while_a_switch_waits_still_waits_for_it() {
        let (_p, fake, h) = switched("state-gone-claude");
        // only the state is gone (the account switched to B is in .claude.json)
        std::fs::remove_file(h.join(STATE_FILE)).unwrap();
        let mut again = provider_with(&h, &fake, Logger::stderr());
        again.set_claude_json(h.join("claude.json"));
        let snap = again.collect(NOW + 10 * MINUTE_MS, false);
        assert!(again.state.account_changed, "the switch still waits");
        assert_eq!(snap.error_code, Some(ErrorCode::AccountChanged));
    }

    /// The account-on-hold result (synthetic: shaped after the documented message and -p error code, not seen on this PC)
    fn on_hold() -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/claude/usage-account-on-hold.sample.json"),
            )
            .unwrap(),
        )
        .unwrap()
    }

    #[test]
    fn an_account_the_service_denies_is_an_access_denial_shared_with_every_pc() {
        // zero use confirmed: an access denial, not a sign-in failure (its text names OAuth)
        assert!(matches!(
            check_usage_result(&on_hold()),
            Err(UsageError::Retry(Diag::AccessDenied))
        ));
        let mut org = on_hold();
        org["result"] =
            json!("OAuth authentication is currently not allowed for this organization.");
        org["error"] = json!("oauth_org_not_allowed");
        assert!(matches!(
            check_usage_result(&org),
            Err(UsageError::Retry(Diag::AccessDenied))
        ));
        let mut forbidden = on_hold();
        forbidden["result"] = json!(
            r#"API Error: 403 {"type":"error","error":{"type":"permission_error","message":"x"}}"#
        );
        forbidden["error"] = Value::Null;
        assert!(matches!(
            check_usage_result(&forbidden),
            Err(UsageError::Retry(Diag::AccessDenied))
        ));
        // other failures stay as they were
        let mut login = on_hold();
        login["result"] = json!("Not logged in · Please run /login");
        login["error"] = Value::Null;
        assert!(matches!(
            check_usage_result(&login),
            Err(UsageError::Retry(Diag::LoginRequired))
        ));
        // shown by output that can't confirm zero use: both stops
        let plain = CmdOutput {
            stdout: "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted\n".into(),
            success: false,
        };
        assert!(matches!(
            classify_usage_output(Ok(plain)),
            Err(UsageError::Stop(Diag::AccessDeniedUnverified))
        ));
        // on the error output alone: both stops, also when the output was cut; beside a result that confirms zero use, the
        // service's denial
        let run = |stdout: &str, complete| {
            Ok(RunOutput {
                stdout: stdout.into(),
                stderr: "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted".into(),
                code: Some(1),
                complete,
            })
        };
        for (stdout, complete) in [("", true), ("", false)] {
            assert_eq!(
                classify_usage_run(run(stdout, complete)),
                Err(UsageError::Stop(Diag::AccessDeniedUnverified))
            );
        }
        let mut failed = on_hold();
        failed["result"] = json!("Not logged in · Please run /login");
        failed["error"] = Value::Null;
        assert_eq!(
            classify_usage_run(run(&failed.to_string(), true)),
            Err(UsageError::Retry(Diag::AccessDenied))
        );
        // a collect that met it: an access denial upstream (the common side shares it), shown as one
        let (mut p, _fake, _h) =
            provider("denied", vec![Err(UsageError::Retry(Diag::AccessDenied))]);
        let snap = p.collect(NOW, false);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::AccessDenied
            ))
        );
        assert_eq!(snap.error_code, Some(ErrorCode::AccessDenied));
        assert!(!p.safety_stopped());
        let (mut p, _fake, _h) = provider(
            "denied-unverified",
            vec![Err(UsageError::Stop(Diag::AccessDeniedUnverified))],
        );
        let snap = p.collect(NOW, false);
        assert_eq!(
            p.take_run(),
            Some(crate::providers::Run::Ran(
                crate::providers::Outcome::AccessDenied
            ))
        );
        assert_eq!(
            snap.error_code,
            Some(ErrorCode::SafetyStop),
            "the safety stop shows first"
        );
        assert!(p.safety_stopped(), "and it stays until the user's --force");
    }
}
