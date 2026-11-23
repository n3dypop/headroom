//! Converts usage limits from the official Codex App Server to schema v2.

mod rpc;

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use super::claude::resolve_bin;
use super::{Grant, Outcome, Provider, Run};
use crate::config::CodexConfig;
use crate::push::{EpochRead, clock_epoch};
use crate::schema::{
    ErrorCode, ProviderSnapshot, ProviderStatus, UsageWindow, make_window, window_id_from_seconds,
};
use crate::store::{Logger, backoff_ms, fnv1a_hex, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms, now_ms};

const STATE_FILE: &str = "state-codex.json";
const MIN_INTERVAL_MS: i64 = 5 * MINUTE_MS;
const STALE_AFTER_MS: i64 = 20 * MINUTE_MS;
const LOCK_RETRY_MS: i64 = 30_000;
const BLOCKED_RULE_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
enum FetchError {
    MissingCli,
    SignedOut,
    WrongAuth,
    AccountChanged,
    AccountIdentityUnknown,
    AccessDenied,
    RateLimited {
        retry_ms: Option<i64>,
    },
    GrantExpired,
    ClockChanged,
    Start,
    Timeout,
    /// Cut off because the computer slept while the request waited (its wait ran out, or the server went away): an ordinary
    /// failure, tried again. Saved as a timeout, so a state an earlier version reads back stays readable
    #[serde(rename(serialize = "Timeout"))]
    Suspended,
    Disconnected,
    Protocol,
    Unsupported,
    Remote,
    StateIo,
    StateUnreadable,
}

impl FetchError {
    fn message(self) -> &'static str {
        match self {
            Self::MissingCli => "Codex CLI not found (set codex_bin or HEADROOM_CODEX_BIN)",
            Self::SignedOut => "Sign in to the Codex CLI with ChatGPT (codex login)",
            Self::WrongAuth => {
                "The Codex CLI authentication method does not provide access to ChatGPT usage limits"
            }
            Self::AccountChanged => {
                "Fetching paused after a Codex account switch (run headroom collect --provider codex --accept-account to resume)"
            }
            Self::AccountIdentityUnknown => "Could not confirm the Codex account identity",
            Self::AccessDenied => crate::schedule::DENIED_TEXT,
            Self::RateLimited { .. } => "Codex usage limit requests are rate limited",
            Self::ClockChanged => "The clock epoch changed or could not be confirmed",
            Self::GrantExpired => "The Codex fetch turn expired before the request",
            Self::Start => "Could not start Codex App Server",
            Self::Timeout => "Timed out waiting for a response from Codex App Server",
            Self::Suspended => {
                "The Codex App Server request was cut off because the computer slept while it ran; tries again at the next check"
            }
            Self::Disconnected => "Lost the connection to Codex App Server",
            Self::Protocol => "Could not interpret the Codex App Server response",
            Self::Unsupported => {
                "The Codex CLI does not support the required RPC (update the standalone CLI)"
            }
            Self::Remote => "Codex App Server failed to fetch usage limits",
            Self::StateIo => "Could not save or lock the Codex fetch state",
            Self::StateUnreadable => {
                "The Codex fetch state can't be read right now. Headroom will retry automatically. If this persists, check the Headroom folder's permissions."
            }
        }
    }

    /// No values shown while it lasts (signed out, or a sign-in that gives no ChatGPT limits). A CLI that can't be found keeps the last
    /// values shown as old, as for every provider: it may be mid-update, or not on PATH yet at logon
    fn unavailable(self) -> bool {
        matches!(self, Self::SignedOut | Self::WrongAuth)
    }

    fn code(self) -> ErrorCode {
        match self {
            Self::MissingCli => ErrorCode::NotInstalled,
            Self::SignedOut | Self::WrongAuth => ErrorCode::LoginRequired,
            Self::AccountChanged => ErrorCode::AccountChanged,
            Self::AccessDenied => ErrorCode::AccessDenied,
            _ => ErrorCode::FetchFailed,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct State {
    last_attempt_ms: Option<i64>,
    // Setup failures back off without moving the last poll or its scheduled interval.
    #[serde(default)]
    setup_failed_ms: Option<i64>,
    // Older state only recorded the local attempt, which may have stopped during initialization.
    #[serde(default)]
    last_query_ms: Option<i64>,
    #[serde(default)]
    failures: u32,
    last_error: Option<FetchError>,
    #[serde(default, deserialize_with = "read_observation")]
    last_ok: Option<Observation>,
    identity: Identity,
    #[serde(default)]
    account_changed: bool,
    #[serde(default)]
    switch_mark: i64,
    #[serde(default)]
    pending_identity: Identity,
    account_accepted_ms: Option<i64>,
}

fn load_state(path: &Path) -> io::Result<State> {
    match fs::read(path) {
        // A valid state file is a JSON object with the accepted account identity for comparison.
        Ok(bytes) if bytes.iter().find(|byte| !byte.is_ascii_whitespace()) == Some(&b'{') => {
            Ok(serde_json::from_slice(&bytes).unwrap_or_else(|_| State::recovery_required()))
        }
        Ok(_) => Ok(State::recovery_required()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error),
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Observation {
    #[serde(default)]
    epoch: Option<u64>,
    fetched_ms: i64,
    snapshot: ProviderSnapshot,
    #[serde(default)]
    blocked_rule_version: u8,
}

fn read_observation<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Observation>, D::Error> {
    let mut value = Value::deserialize(d)?;
    let mut usage_allowed = None;
    if let Some(snapshot) = value.get_mut("snapshot").and_then(Value::as_object_mut)
        && let Some(account) = snapshot.remove("account")
    {
        // Migrate legacy v2 observations. Keep the last attempt time and backoff even if the observation is unreadable.
        snapshot.insert("plan".into(), account["plan"].clone());
        let limit = snapshot.remove("limit").unwrap_or(Value::Null);
        usage_allowed = limit["usage_allowed"].as_bool();
        let blocked = if usage_allowed == Some(false) {
            Some(true)
        } else {
            limit["reached"].as_bool().or(usage_allowed)
        };
        snapshot.insert("blocked".into(), json!(blocked));
        if let Some(windows) = snapshot.get_mut("windows").and_then(Value::as_array_mut) {
            for window in windows.iter_mut().filter_map(Value::as_object_mut) {
                let group = window.remove("group").filter(|v| v.is_string());
                let label = window.remove("group_label").filter(|v| v.is_string());
                window.remove("model");
                window.insert(
                    "scope".into(),
                    group.and_then(|g| label.or(Some(g))).unwrap_or(Value::Null),
                );
            }
        }
    }
    let Ok(mut observation) = serde_json::from_value::<Observation>(value) else {
        return Ok(None);
    };
    if observation.blocked_rule_version < BLOCKED_RULE_VERSION {
        let observed = &mut observation.snapshot;
        let inferred = blocked(&observed.windows, false, usage_allowed);
        // An extra group may have set blocked to true in older caches. Treat it as unknown without evidence of a global block.
        observed.blocked = if observed.blocked == Some(true) && inferred != Some(true) {
            None
        } else {
            inferred
        };
        observation.blocked_rule_version = BLOCKED_RULE_VERSION;
    }
    Ok(Some(observation))
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct Identity {
    user_hash: Option<String>,
    workspace_hash: Option<String>,
}

impl Identity {
    /// As kept beside the state (crate::store::keep_account): the user's hash, and the workspace's after a slash
    fn kept(&self) -> Option<String> {
        let user = self.user_hash.as_deref()?;
        Some(match self.workspace_hash.as_deref() {
            Some(workspace) => format!("{user}/{workspace}"),
            None => user.to_string(),
        })
    }

    fn from_kept(kept: &str) -> Self {
        let (user, workspace) = match kept.split_once('/') {
            Some((user, workspace)) => (user, Some(workspace)),
            None => (kept, None),
        };
        Self {
            user_hash: Some(user.to_string()).filter(|u| !u.is_empty()),
            workspace_hash: workspace.map(str::to_string).filter(|w| !w.is_empty()),
        }
    }

    fn differs_from(&self, other: &Self) -> bool {
        changed(&self.user_hash, &other.user_hash)
            || changed(&self.workspace_hash, &other.workspace_hash)
    }

    fn with_observed(self, observed: Self) -> Self {
        Self {
            user_hash: observed.user_hash.or(self.user_hash),
            workspace_hash: observed.workspace_hash.or(self.workspace_hash),
        }
    }
}

impl State {
    fn recovery_required() -> Self {
        Self {
            account_changed: true,
            last_error: Some(FetchError::StateUnreadable),
            ..Self::default()
        }
    }

    fn pending_switch(&self) -> Option<i64> {
        self.account_changed.then_some(self.switch_mark)
    }

    fn stop_message(&self) -> Option<&'static str> {
        self.account_changed.then_some(match self.last_error {
            Some(FetchError::StateUnreadable) => {
                "The Codex fetch state is corrupt or invalid (run headroom collect --provider codex --accept-account to recover)"
            }
            _ => FetchError::AccountChanged.message(),
        })
    }

    fn observation(&self, epoch: Option<u64>) -> Option<&Observation> {
        let epoch = epoch?;
        self.last_ok.as_ref().filter(|o| o.epoch == Some(epoch))
    }

    fn future_observation(&self, now: i64, epoch: Option<u64>) -> bool {
        self.observation(epoch).is_some_and(|o| o.fetched_ms > now)
    }

    fn needs_clock_repair(&self, now: i64, epoch: Option<u64>) -> bool {
        self.last_attempt_ms.is_some_and(|t| t > now)
            || self.last_query_ms.is_some_and(|t| t > now)
            || self.future_observation(now, epoch)
    }

    fn due_ms(&self, now: i64, interval: i64, epoch: Option<u64>) -> i64 {
        let delay = backoff_ms(interval, self.failures).max(interval);
        let attempt = if self.needs_clock_repair(now, epoch) {
            Some(now)
        } else {
            self.last_attempt_ms
        };
        let due = match attempt {
            Some(last) => {
                let normal = last.saturating_add(delay);
                self.observation(epoch)
                    .filter(|o| o.fetched_ms <= now)
                    .and_then(|observation| observation.snapshot.blocked_until_ms(last))
                    .map_or(normal, |blocked_until| normal.max(blocked_until))
            }
            None => now,
        };
        self.setup_failed_ms
            .map_or(due, |last| due.max(last.min(now).saturating_add(delay)))
    }

    fn snapshot(
        &self,
        now: i64,
        error: Option<FetchError>,
        epoch: Option<u64>,
    ) -> ProviderSnapshot {
        let error = error.or(self.last_error);
        let mut snapshot = if let Some(message) = self.stop_message() {
            ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                message,
                Some(ErrorCode::AccountChanged),
            )
        } else if let Some(error) = error.filter(|e| e.unavailable()) {
            ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                error.message(),
                Some(error.code()),
            )
        } else if let Some(last) = self.observation(epoch).filter(|o| o.fetched_ms <= now) {
            let mut snapshot = last.snapshot.clone();
            if let Some(error) = error {
                snapshot.status = ProviderStatus::Stale;
                snapshot.error = Some(error.message().into());
                snapshot.error_code = Some(error.code());
            } else if now.saturating_sub(last.fetched_ms) > STALE_AFTER_MS {
                snapshot.status = ProviderStatus::Stale;
                snapshot.error =
                    Some("Codex usage limits have not been updated for over 20 minutes".into());
            }
            snapshot
        } else {
            ProviderSnapshot::empty(
                // No values: a CLI not found is unavailable, as for every provider (an error would hide another PC's sign-in stop)
                if error == Some(FetchError::MissingCli) {
                    ProviderStatus::Unavailable
                } else {
                    ProviderStatus::Error
                },
                error.map_or(
                    "Codex usage limits have not been fetched yet",
                    FetchError::message,
                ),
                error.map(FetchError::code),
            )
        };
        snapshot.history_since = self.account_accepted_ms.map(iso_from_ms);
        snapshot
    }
}

fn trusted_epoch(home: &Path) -> Option<u64> {
    match clock_epoch(home) {
        EpochRead::Read {
            epoch,
            trusted: true,
            in_flight: None,
        } => Some(epoch),
        _ => None,
    }
}

fn changed(previous: &Option<String>, current: &Option<String>) -> bool {
    matches!((previous, current), (Some(a), Some(b)) if a != b)
}

/// Codex status for the CLI. The running agent supplies the next run through schedule.json.
pub(crate) struct CodexStatus {
    /// None while the state can't be read (not known)
    pub failures: Option<u32>,
    pub last_error: &'static str,
    /// Why no fetch is scheduled, when the reason is absent from the agent schedule.
    pub not_scheduled: Option<&'static str>,
}

struct Query<'a> {
    expected: &'a Identity,
    home: &'a Path,
    epoch: u64,
    grant: Option<Grant>,
    clock: Option<fn() -> i64>,
    collected_ms: i64,
    run: &'a mut Option<Run>,
    last_query_ms: &'a mut Option<i64>,
}

impl Query<'_> {
    fn now(&self) -> i64 {
        self.clock.map_or(self.collected_ms, |clock| clock())
    }

    fn check_grant(&self) -> Result<i64, FetchError> {
        if trusted_epoch(self.home) != Some(self.epoch) {
            return Err(FetchError::ClockChanged);
        }
        let now = self.now();
        if self.grant.is_some_and(|grant| grant.passed(now)) {
            return Err(FetchError::GrantExpired);
        }
        Ok(now)
    }

    fn before_write(&mut self) -> Result<(), FetchError> {
        let now = self.check_grant()?;
        if *self.run == Some(Run::NotRun) {
            *self.last_query_ms = Some(now);
        }
        *self.run = Some(Run::Unknown);
        Ok(())
    }
}

pub struct CodexProvider {
    home: PathBuf,
    cfg: CodexConfig,
    log: Logger,
    clock: Option<fn() -> i64>,
    state: State,
    last_collect_ms: i64,
    retry_at: Option<i64>,
    state_retry_at: Option<i64>,
    grant: Option<Grant>,
    run: Option<Run>,
    fetch_hold_until_ms: i64,
    accept_account_requested: bool,
    accept_target: Option<i64>,
    accepted: Option<bool>,
    unsaved_account_stop: bool,
}

impl CodexProvider {
    pub fn new(home: &Path, cfg: CodexConfig, log: Logger) -> Self {
        Self {
            home: home.to_path_buf(),
            cfg,
            log,
            clock: Some(now_ms),
            state: load_state(&home.join(STATE_FILE))
                .unwrap_or_else(|_| State::recovery_required()),
            last_collect_ms: i64::MIN,
            // Include cached data in the daemon's first snapshot. Check whether the RPC is due under the lock.
            retry_at: Some(i64::MIN),
            state_retry_at: None,
            grant: None,
            run: None,
            fetch_hold_until_ms: i64::MIN,
            accept_account_requested: false,
            accept_target: None,
            accepted: None,
            unsaved_account_stop: false,
        }
    }

    fn interval_ms(&self) -> i64 {
        self.cfg
            .interval_min
            .saturating_mul(MINUTE_MS)
            .max(MIN_INTERVAL_MS)
    }

    fn next_due_in_epoch(&self, now: i64, epoch: Option<u64>) -> i64 {
        // A state that couldn't be read is read again a minute on: nothing is due before (neither a read nor a fetch)
        if let Some(at) = crate::time::reread_due(self.state_retry_at, now) {
            return at;
        }
        if self.last_collect_ms > now
            || (self.retry_at.is_none() && self.state.needs_clock_repair(now, epoch))
        {
            return now;
        }
        self.retry_at
            .unwrap_or_else(|| self.state.due_ms(now, self.interval_ms(), epoch))
    }

    fn snapshot(&self, now: i64, error: Option<FetchError>) -> ProviderSnapshot {
        self.state.snapshot(now, error, trusted_epoch(&self.home))
    }

    /// Keeps the account this state knows beside it (not while a switch waits to be accepted), so a state that is gone starts again
    /// knowing it
    fn keep_account(&self) {
        if !self.state.account_changed
            && !crate::store::keep_account(
                &self.home,
                "codex",
                self.state.identity.kept().as_deref(),
            )
        {
            self.log
                .log("codex: couldn't keep the account beside the state (kept at the next save)");
        }
    }

    /// A state still unread whose read couldn't be made now (the lock): read again a minute on, not every second
    fn reread_later(&mut self, now: i64) {
        if self.state_retry_at.is_some() {
            self.state_retry_at = Some(now.saturating_add(MINUTE_MS));
        }
    }

    fn state_error(&mut self, now: i64) -> ProviderSnapshot {
        self.reread_later(now);
        self.retry_at = Some(now.saturating_add(self.interval_ms()));
        self.log
            .log(&format!("codex: {}", FetchError::StateIo.message()));
        let error = match self.run {
            Some(Run::Ran(Outcome::AccessDenied)) => FetchError::AccessDenied,
            Some(Run::Ran(Outcome::RateLimited { retry_ms })) => {
                FetchError::RateLimited { retry_ms }
            }
            _ => FetchError::StateIo,
        };
        self.snapshot(now, Some(error))
    }

    fn state_read_error(&mut self, now: i64) -> ProviderSnapshot {
        // Read again a minute on (said once until it can be read)
        if self.state_retry_at.is_none() {
            self.log.log(
                "codex: skipped this round: the state file couldn't be read (read again every minute)",
            );
        }
        self.state_retry_at = Some(now.saturating_add(MINUTE_MS));
        self.retry_at = self.state_retry_at;
        // Leave the file untouched after a permissions or I/O error and withhold current values until it is resolved.
        ProviderSnapshot::empty(
            ProviderStatus::Error,
            FetchError::StateUnreadable.message(),
            Some(ErrorCode::FetchFailed),
        )
    }

    fn try_state_lock(&self) -> Result<Option<fs::File>, FetchError> {
        fs::create_dir_all(&self.home).map_err(|_| FetchError::StateIo)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.home.join("codex-poll.lock"))
            .map_err(|_| FetchError::StateIo)?;
        match lock.try_lock() {
            Ok(()) => Ok(Some(lock)),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(_)) => Err(FetchError::StateIo),
        }
    }

    // Keep the file locked through the fetch and its final state write.
    fn reload_for_collect(&mut self, path: &Path) -> Result<Option<fs::File>, FetchError> {
        let lock = self.try_state_lock()?;
        if self.unsaved_account_stop {
            if lock.is_none() {
                return Ok(None);
            }
            write_json_atomic(path, &self.state).map_err(|_| FetchError::StateIo)?;
            self.unsaved_account_stop = false;
        }
        self.state = load_state(path).map_err(|_| FetchError::StateUnreadable)?;
        // Looked at after the read: a state deleted meanwhile counts as gone too (one written meanwhile can't be: the lock is held)
        let gone = matches!(path.try_exists(), Ok(false));
        // A state that is gone starts again knowing the account it knew (another one seen is a switch to accept)
        if gone
            && self.state.identity.user_hash.is_none()
            && let Some(kept) = crate::store::known_account(&self.home, "codex")
        {
            self.state.identity = Identity::from_kept(&kept);
        }
        self.state_retry_at = None;
        Ok(lock)
    }

    fn collect_with(
        &mut self,
        now: i64,
        force: bool,
        fetch: impl FnOnce(&Path, &Path, &mut Query<'_>) -> (Identity, Result<Observation, FetchError>),
    ) -> ProviderSnapshot {
        self.run = Some(Run::NotRun);
        let accepting = std::mem::take(&mut self.accept_account_requested);
        let target = self.accept_target.take();
        let grant = self.grant.take();
        // A requested acceptance only succeeds once the new identity and observation are saved.
        self.accepted = accepting.then_some(false);
        if !self.cfg.enabled {
            return ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                "Disabled in config",
                None,
            );
        }
        // The daemon used local state when it checked which collector was on duty. If reloading makes a fetch due,
        // return cached data and wait for the next duty check before sending an RPC.
        let fetch_was_due = self.fetch_due_ms(now) <= now;
        let state_path = self.home.join(STATE_FILE);
        let lock = self.reload_for_collect(&state_path);
        let now = self.clock.map_or(now, |c| c());
        if self.last_collect_ms > now {
            // Recheck the turn before the next RPC on the corrected clock.
            self.fetch_hold_until_ms = i64::MIN;
        }
        self.last_collect_ms = now;

        let _lock = match lock {
            Ok(Some(lock)) => lock,
            Ok(None) => {
                self.log.log(
                    "codex: skipped this round: another process holds the state lock (tried again in 30 seconds)",
                );
                self.retry_at = Some(now.saturating_add(LOCK_RETRY_MS));
                return self.snapshot(now, None);
            }
            Err(FetchError::StateUnreadable) => return self.state_read_error(now),
            Err(_) => return self.state_error(now),
        };
        self.retry_at = None;
        let epoch = trusted_epoch(&self.home);
        let repair_poll = self.state.needs_clock_repair(now, epoch);
        if repair_poll || self.state.setup_failed_ms.is_some_and(|t| t > now) {
            if repair_poll {
                self.state.last_attempt_ms = Some(now);
            }
            self.state.setup_failed_ms = self.state.setup_failed_ms.map(|t| t.min(now));
            self.state.last_query_ms = self.state.last_query_ms.map(|t| t.min(now));
            if self.state.future_observation(now, epoch) {
                self.state.last_ok = None;
            }
            if write_json_atomic(&state_path, &self.state).is_err() {
                return self.state_error(now);
            }
        }
        if accepting
            && (target.is_none()
                || target != self.state.pending_switch()
                || grant.is_none_or(|g| g.passed(now)))
        {
            if self.state.account_changed {
                self.retry_at = Some(now.saturating_add(self.interval_ms()));
            }
            return self.snapshot(now, None);
        }
        if self.state.account_changed && !accepting {
            // Check for a manual resume from another process on the next scheduled poll.
            self.retry_at = Some(now.saturating_add(self.interval_ms()));
            return self.snapshot(now, None);
        }
        if !force
            && !accepting
            && (!fetch_was_due || self.state.due_ms(now, self.interval_ms(), epoch) > now)
        {
            if self.fetch_hold_until_ms > now {
                self.retry_at = Some(
                    now.saturating_add(self.interval_ms())
                        .min(self.fetch_hold_until_ms),
                );
            }
            return self.snapshot(now, None);
        }

        let Some(start_epoch) = epoch.filter(|e| trusted_epoch(&self.home) == Some(*e)) else {
            self.retry_at = Some(now.saturating_add(LOCK_RETRY_MS));
            return self.state.snapshot(now, None, None);
        };
        if grant.is_some_and(|g| g.passed(now)) {
            self.log.log(
                "codex: the fetch turn came too long ago; not fetched (asked again next round)",
            );
            return self.snapshot(now, None);
        }
        let previous_attempt = self.state.last_attempt_ms;
        self.state.last_attempt_ms = Some(now);
        if write_json_atomic(&state_path, &self.state).is_err() {
            self.state.last_attempt_ms = previous_attempt;
            return self.state_error(now);
        }

        let expected = if accepting {
            &self.state.pending_identity
        } else {
            &self.state.identity
        };
        let (identity, result) = fetch(
            &codex_bin(&self.cfg),
            &self.home.join("codex-cwd"),
            &mut Query {
                expected,
                home: &self.home,
                epoch: start_epoch,
                grant,
                clock: self.clock,
                collected_ms: now,
                run: &mut self.run,
                last_query_ms: &mut self.state.last_query_ms,
            },
        );
        if result.is_ok() {
            // Both replies are known. The observation still has to be accepted and saved.
            self.run = Some(Run::Ran(Outcome::Failed));
        }
        if self.run == Some(Run::NotRun) {
            self.state.last_attempt_ms = previous_attempt;
            if matches!(
                result,
                Err(FetchError::GrantExpired | FetchError::ClockChanged)
            ) {
                self.log.log(match result {
                    Err(FetchError::GrantExpired) => {
                        "codex: the fetch turn ran out before the request; not fetched (asked again next round)"
                    }
                    _ => "codex: the clock changed before the request; not fetched (fetched again next time)",
                });
                if write_json_atomic(&state_path, &self.state).is_err() {
                    return self.state_error(now);
                }
                return self.snapshot(now, None);
            }
            self.state.setup_failed_ms = Some(now);
        } else {
            self.state.setup_failed_ms = None;
        }
        if expected.differs_from(&identity) || matches!(result, Err(FetchError::AccountChanged)) {
            self.state.account_changed = true;
            self.state.switch_mark = self.state.switch_mark.wrapping_add(1);
            self.state.pending_identity = identity;
            self.state.last_ok = None;
            self.state.last_error = Some(FetchError::AccountChanged);
            self.log
                .log(&format!("codex: {}", FetchError::AccountChanged.message()));
            self.unsaved_account_stop = true;
            if write_json_atomic(&state_path, &self.state).is_err() {
                return self.state_error(now);
            }
            self.unsaved_account_stop = false;
            self.retry_at = Some(now.saturating_add(self.interval_ms()));
            return self.snapshot(now, None);
        }
        // The poll lock pins the account state. Pin the clock only for adoption and its save.
        let clock_lock = if result.is_ok() {
            crate::clock::try_clock_lock(&self.home).ok().flatten()
        } else {
            None
        };
        let result = match result {
            Ok(_) if clock_lock.is_none() || trusted_epoch(&self.home) != Some(start_epoch) => {
                Err(FetchError::ClockChanged)
            }
            Ok(_)
                if ((accepting || expected.user_hash.is_some())
                    && identity.user_hash.is_none())
                    || (expected.workspace_hash.is_some() && identity.workspace_hash.is_none()) =>
            {
                Err(FetchError::AccountIdentityUnknown)
            }
            result => result,
        };
        let snapshot_ms = result.as_ref().map_or(now, |o| now.max(o.fetched_ms));
        match result {
            Ok(mut observation) => {
                let mut next = self.state.clone();
                observation.epoch = Some(start_epoch);
                next.identity = if accepting {
                    next.account_accepted_ms = Some(observation.fetched_ms);
                    next.pending_identity = Identity::default();
                    identity
                } else {
                    std::mem::take(&mut next.identity).with_observed(identity)
                };
                next.account_changed = false;
                next.last_ok = Some(observation);
                next.failures = 0;
                next.last_error = None;
                if write_json_atomic(&state_path, &next).is_err() {
                    return self.state_error(now);
                }
                self.state = next;
                self.keep_account();
                self.run = Some(Run::Ran(Outcome::Ok));
                if accepting {
                    self.accepted = Some(true);
                }
            }
            // The clock changed during the fetch (its values are of another epoch, or the clock couldn't be pinned to save them):
            // dropped, as for every provider, but nothing upstream failed, so neither a failure counted nor a longer wait
            Err(FetchError::ClockChanged) => {
                self.log.log(
                    "codex: the clock changed during the fetch; its values aren't used (fetched again next time)",
                );
                // The query was made: its time is kept, as for every provider
                if write_json_atomic(&state_path, &self.state).is_err() {
                    return self.state_error(now);
                }
            }
            Err(error) => {
                if matches!(error, FetchError::SignedOut | FetchError::WrongAuth) {
                    self.state.last_ok = None;
                }
                if !accepting {
                    self.state.identity =
                        std::mem::take(&mut self.state.identity).with_observed(identity);
                }
                self.state.failures = self.state.failures.saturating_add(1);
                self.state.last_error = Some(error);
                self.log.log(&format!("codex: {}", error.message()));
                if write_json_atomic(&state_path, &self.state).is_err() {
                    return self.state_error(now);
                }
                self.keep_account();
            }
        }
        self.snapshot(snapshot_ms, None)
    }

    /// `enabled`: whether Codex is turned on, as the shared status line has it (None: not known). A state that can't be read, or isn't
    /// one at all, says nothing for a provider turned off (its old file isn't used), as for every provider
    pub(crate) fn status_parts(home: &Path, enabled: Option<bool>) -> Option<CodexStatus> {
        let path = home.join(STATE_FILE);
        if matches!(path.try_exists(), Ok(false)) {
            return None;
        }
        let state = match load_state(&path) {
            Ok(state) => state,
            Err(_) if enabled == Some(false) => return None,
            Err(_) => {
                return Some(CodexStatus {
                    failures: None,
                    last_error: FetchError::StateUnreadable.message(),
                    not_scheduled: Some("waiting to retry the state read"),
                });
            }
        };
        if enabled == Some(false)
            && state.last_error == Some(FetchError::StateUnreadable)
            && state.account_changed
        {
            return None;
        }
        let last_error = state
            .stop_message()
            .or(state.last_error.map(FetchError::message))
            .unwrap_or("none");
        let not_scheduled = if state.account_changed {
            Some("waiting for manual resume")
        } else if enabled == Some(false) {
            Some("disabled")
        } else {
            None
        };
        // A state that wasn't one (read as corrupt): its failures aren't known
        let corrupt =
            state.account_changed && state.last_error == Some(FetchError::StateUnreadable);
        Some(CodexStatus {
            failures: (!corrupt).then_some(state.failures),
            last_error,
            not_scheduled,
        })
    }
}

impl Provider for CodexProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn next_due_ms(&self, now: i64) -> i64 {
        if self.cfg.enabled {
            let Some(epoch) = trusted_epoch(&self.home) else {
                return now.saturating_add(LOCK_RETRY_MS);
            };
            self.next_due_in_epoch(now, Some(epoch))
        } else {
            i64::MAX
        }
    }

    fn collect(&mut self, now: i64, force: bool) -> ProviderSnapshot {
        self.collect_with(now, force, fetch)
    }

    fn state_retry_at(&self) -> Option<i64> {
        self.state_retry_at
    }

    fn take_run(&mut self) -> Option<Run> {
        self.run.take()
    }

    fn last_fetch_attempt_ms(&self) -> Option<i64> {
        self.state.last_query_ms
    }

    fn grant(&mut self, grant: Option<Grant>) {
        self.grant = grant;
    }

    fn fetch_due_ms(&self, now: i64) -> i64 {
        // No turn is asked for while the state can't be read: it is read again first (its own collect), and only a read that succeeds
        // lets a fetch be due again
        if !self.cfg.enabled || self.state.account_changed || self.state_retry_at.is_some() {
            return i64::MAX;
        }
        let Some(epoch) = trusted_epoch(&self.home) else {
            return i64::MAX;
        };
        self.next_due_in_epoch(now, Some(epoch))
            .max(self.state.due_ms(now, self.interval_ms(), Some(epoch)))
            .max(self.fetch_hold_until_ms)
    }

    fn hold_fetch_until(&mut self, until_ms: i64) -> bool {
        self.fetch_hold_until_ms = until_ms;
        true
    }

    fn forget_cached(&mut self) -> bool {
        let path = self.home.join(STATE_FILE);
        // Nothing saved on this PC: nothing cached to forget, and nothing is made (not even the lock)
        if matches!(path.try_exists(), Ok(false)) && !self.unsaved_account_stop {
            return true;
        }
        let Ok(Some(_lock)) = self.try_state_lock() else {
            return false;
        };
        // A file that exists but can't be read may still hold a value (it would come back once readable): not forgotten, tried again
        let Ok(saved) = load_state(&path) else {
            self.log
                .log("codex: couldn't read the state to forget the cached values");
            self.state_retry_at = Some(
                self.clock
                    .map_or_else(now_ms, |clock| clock())
                    .saturating_add(MINUTE_MS),
            );
            return false;
        };
        if !self.unsaved_account_stop {
            self.state = saved;
        }
        let EpochRead::Read {
            epoch,
            in_flight: None,
            ..
        } = clock_epoch(&self.home)
        else {
            return false;
        };
        // A value of another epoch, or of none (cached before epochs were kept), was stamped by a clock no longer trusted
        if let Some(cached) = self.state.last_ok.as_ref()
            && cached.epoch != Some(epoch)
        {
            self.state.last_ok = None;
        } else if !self.unsaved_account_stop {
            return true;
        }
        if write_json_atomic(&path, &self.state).is_err() {
            return false;
        }
        self.unsaved_account_stop = false;
        true
    }

    fn pending_switch(&self) -> Option<i64> {
        load_state(&self.home.join(STATE_FILE))
            .ok()?
            .pending_switch()
    }

    fn accept_target(&mut self, target: Option<i64>) {
        self.accept_target = target;
    }

    fn accept_account(&mut self) {
        self.accept_account_requested = true;
    }

    fn account_accepted(&self) -> Option<bool> {
        self.accepted
    }
}

fn codex_bin(cfg: &CodexConfig) -> PathBuf {
    if !cfg.codex_bin.trim().is_empty() {
        return cfg.codex_bin.as_str().into();
    }
    if let Some(path) = std::env::var_os("HEADROOM_CODEX_BIN").filter(|path| !path.is_empty()) {
        return path.into();
    }
    resolve_bin("codex")
        .or_else(standalone_codex_bin)
        .unwrap_or_else(|| PathBuf::from("codex"))
}

fn standalone_codex_bin() -> Option<PathBuf> {
    let (base_var, relative_path) = if cfg!(windows) {
        ("LOCALAPPDATA", "Programs/OpenAI/Codex/bin/codex.exe")
    } else {
        ("HOME", ".local/bin/codex")
    };
    let base = PathBuf::from(std::env::var_os(base_var)?);
    if !base.is_absolute() {
        return None;
    }
    let path = base.join(relative_path);
    path.is_file().then_some(path)
}

fn fetch(
    bin: &Path,
    cwd: &Path,
    query: &mut Query<'_>,
) -> (Identity, Result<Observation, FetchError>) {
    rpc::AppServer::start(bin, cwd, || query.check_grant().map(|_| ()))
        .and_then(|mut server| {
            let mut rpc = server.connection()?;
            Ok(read_limits(&mut rpc, query))
        })
        .unwrap_or_else(|error| (Identity::default(), Err(error)))
}

fn read_limits(
    server: &mut rpc::Connection<'_>,
    query: &mut Query<'_>,
) -> (Identity, Result<Observation, FetchError>) {
    let mut identity = Identity::default();
    let result = (|| {
        server.request(
            query,
            1,
            "initialize",
            json!({"clientInfo":{"name":"headroom","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        server.notify_initialized()?;
        let account = server.request(query, 2, "account/read", json!({"refreshToken":false}))?;
        identity = account_identity(&account)?;
        if query.expected.differs_from(&identity) {
            return Err(FetchError::AccountChanged);
        }

        let limits = server.request(
            query,
            3,
            "account/rateLimits/read",
            json!({"excludeResetCreditDetails":true}),
        )?;
        let fetched_ms = query.now();
        if let (Some(user), Some(workspace)) =
            (identity.user_hash.as_deref(), text(&limits, "accountId"))
        {
            identity.workspace_hash = Some(fnv1a_hex(&[user, workspace]));
        }
        let snapshot = normalize(&limits, text(&account["account"], "planType"), fetched_ms)?;
        Ok(Observation {
            epoch: None,
            fetched_ms,
            snapshot,
            blocked_rule_version: BLOCKED_RULE_VERSION,
        })
    })();
    (identity, result)
}

fn account_identity(account: &Value) -> Result<Identity, FetchError> {
    let kind = match account.get("account") {
        Some(Value::Null) => return Err(FetchError::SignedOut),
        Some(value) => text(value, "type").ok_or(FetchError::Protocol)?,
        None => return Err(FetchError::Protocol),
    };
    if matches!(kind, "apiKey" | "amazonBedrock") {
        return Err(FetchError::WrongAuth);
    }
    Ok(Identity {
        user_hash: text(account, "userId").map(|user| fnv1a_hex(&[user])),
        ..Identity::default()
    })
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn group_prefix(group: &str) -> String {
    group
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn normalize(
    limits: &Value,
    account_plan: Option<&str>,
    fetched_ms: i64,
) -> Result<ProviderSnapshot, FetchError> {
    let legacy = limits.get("rateLimits").filter(|bucket| bucket.is_object());
    let mut buckets: Vec<(&str, &Value)> = limits["rateLimitsByLimitId"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(id, bucket)| (id.as_str(), bucket))
        .collect();
    if buckets.is_empty()
        && let Some(bucket) = legacy
    {
        buckets.push((text(bucket, "limitId").unwrap_or("codex"), bucket));
    }
    if buckets.is_empty() {
        return Err(FetchError::Protocol);
    }
    buckets.sort_by_key(|(id, _)| (*id != "codex", *id));

    let global = buckets
        .iter()
        .find(|(id, _)| *id == "codex")
        .map(|(_, bucket)| *bucket)
        .or_else(|| legacy.filter(|bucket| text(bucket, "limitId").unwrap_or("codex") == "codex"));
    let main = global.or(legacy);
    let quota_plan = main
        .and_then(|b| text(b, "planType"))
        .or_else(|| buckets.iter().find_map(|(_, b)| text(b, "planType")));
    let mut windows = Vec::new();
    let mut ids = BTreeSet::new();
    let mut invalid_window = false;
    let mut explicit_null_window = false;
    for (group, bucket) in &buckets {
        if !bucket.is_object() {
            invalid_window = true;
            continue;
        }
        for position in ["primary", "secondary"] {
            let Some(window) = bucket.get(position) else {
                continue;
            };
            if window.is_null() {
                explicit_null_window = true;
                continue;
            }
            let Some(used) = window["usedPercent"].as_f64().filter(|n| n.is_finite()) else {
                invalid_window = true;
                continue;
            };
            let seconds = window["windowDurationMins"]
                .as_i64()
                .filter(|mins| *mins > 0)
                .and_then(|mins| mins.checked_mul(60));
            let resets_at = window["resetsAt"]
                .as_i64()
                .filter(|ts| (1..=253_402_300_799).contains(ts))
                .map(|ts| ts * 1000);
            let duration_id = window_id_from_seconds(seconds, position);
            let mut value = make_window(&duration_id, used, resets_at)
                .with_seconds(seconds)
                .with_fetched_ms(fetched_ms);
            let base_id = if *group == "codex" {
                duration_id
            } else {
                let prefix = group_prefix(group);
                let scope = crate::schema::known_scope(&prefix).unwrap_or(&prefix);
                value.scope = Some(scope.into());
                value.label = format!("{} {scope}", value.label);
                format!("{prefix}_{duration_id}")
            };
            let mut id = base_id.clone();
            let mut collision = 0;
            while !ids.insert(id.clone()) {
                collision += 1;
                id = if collision == 1 {
                    format!("{base_id}_{position}")
                } else {
                    format!("{base_id}_{position}_{collision}")
                };
            }
            value.id = id;
            windows.push(value);
        }
    }

    let reached_type = global.and_then(|bucket| text(bucket, "rateLimitReachedType"));
    let usage_allowed = limits["ordinaryUsageAllowed"].as_bool();
    let blocked = blocked(&windows, reached_type.is_some(), usage_allowed);
    let known_empty_bucket = quota_plan.is_some()
        || blocked.is_some()
        || main.is_some_and(|b| b["credits"].is_object() || b["spendControlReached"].is_boolean())
        || limits["rateLimitResetCredits"]["availableCount"].is_u64()
        || (explicit_null_window && account_plan.is_some());
    if windows.is_empty() && (invalid_window || !known_empty_bucket) {
        return Err(FetchError::Protocol);
    }

    Ok(ProviderSnapshot {
        status: ProviderStatus::Ok,
        fetched_at: Some(iso_from_ms(fetched_ms)),
        collector: None,
        error: None,
        error_code: None,
        plan: quota_plan.or(account_plan).map(str::to_string),
        blocked,
        history_since: None,
        windows,
    })
}

fn blocked(windows: &[UsageWindow], reached: bool, usage_allowed: Option<bool>) -> Option<bool> {
    let mut global_windows = windows
        .iter()
        .filter(|window| window.scope.is_none())
        .peekable();
    let has_global_window = global_windows.peek().is_some();
    if reached || usage_allowed == Some(false) || global_windows.any(|w| w.used_percent >= 100.0) {
        Some(true)
    } else if has_global_window || usage_allowed == Some(true) {
        Some(false)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::WindowKind;
    use crate::test_util::TempHome;
    use std::time::{Duration, Instant};

    const NOW: i64 = 1_795_000_000_000;

    fn observation() -> Observation {
        observation_at(NOW)
    }

    fn observation_at(fetched_ms: i64) -> Observation {
        let response: Value = serde_json::from_str(include_str!(
            "../../../fixtures/codex/app-server-rate-limits.json"
        ))
        .unwrap();
        Observation {
            epoch: Some(1),
            fetched_ms,
            snapshot: normalize(&response["result"], None, fetched_ms).unwrap(),
            blocked_rule_version: BLOCKED_RULE_VERSION,
        }
    }

    fn temp_home(label: &str) -> (TempHome, PathBuf) {
        let root = TempHome::new(&format!("headroom-codex-{label}"));
        let home = root.join("home");
        set_epoch(&home, 1, true, None);
        (root, home)
    }

    fn set_epoch(home: &Path, epoch: u64, trusted: bool, in_flight: Option<u64>) {
        write_json_atomic(
            &home.join("clock-epoch.json"),
            &json!({ "epoch": epoch, "trusted": trusted, "in_flight": in_flight }),
        )
        .unwrap();
    }

    fn test_provider(home: &Path) -> CodexProvider {
        CodexProvider {
            clock: None,
            ..CodexProvider::new(
                home,
                CodexConfig {
                    codex_bin: home
                        .join("missing-fixture-bin")
                        .to_string_lossy()
                        .into_owned(),
                    ..CodexConfig::default()
                },
                Logger::stderr(),
            )
        }
    }

    fn failures() -> Value {
        serde_json::from_str(include_str!(
            "../../../fixtures/codex/synthetic-rpc-errors.json"
        ))
        .unwrap()
    }

    fn initialize() -> Value {
        json!({"id":1,"result":{}})
    }

    fn account() -> Value {
        json!({"id":2,"result":{"account":{"type":"chatgpt"}}})
    }

    fn grant_until(until_ms: i64) -> Grant {
        Grant {
            until_ms,
            until: Instant::now() + Duration::from_secs(60),
        }
    }

    fn authorize_switch(p: &mut CodexProvider) {
        p.accept_target(Some(p.pending_switch().unwrap()));
        p.accept_account();
        p.grant(Some(grant_until(i64::MAX)));
    }

    fn successful_rpc(
        q: &mut Query<'_>,
        sent: &mut Vec<u8>,
    ) -> (Identity, Result<Observation, FetchError>) {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../fixtures/codex/synthetic-rpc-success.json"
        ))
        .unwrap();
        replay(
            q,
            fixture["replies"].as_array().unwrap(),
            FetchError::Disconnected,
            sent,
        )
    }

    fn targets(sent: &[u8]) -> Vec<String> {
        sent.split(|&b| b == b'\n')
            .filter(|line| !line.is_empty())
            .map(|line| serde_json::from_slice::<Value>(line).unwrap())
            .map(|frame| frame["method"].as_str().unwrap().to_owned())
            .filter(|method| method.starts_with("account/"))
            .collect()
    }

    // Feed stdio frames to the production handshake and capture every outgoing method.
    fn replay(
        query: &mut Query<'_>,
        frames: &[Value],
        end: FetchError,
        sent: &mut Vec<u8>,
    ) -> (Identity, Result<Observation, FetchError>) {
        let (tx, rx) = std::sync::mpsc::channel();
        for frame in frames {
            tx.send(Ok(serde_json::to_vec(frame).unwrap())).unwrap();
        }
        tx.send(Err(end)).unwrap();
        let mut rpc = rpc::Connection {
            input: sent,
            replies: &rx,
            deadline: Instant::now() + Duration::from_secs(5),
            asleep: rpc::Asleep::never(),
        };
        read_limits(&mut rpc, query)
    }

    #[test]
    fn only_a_matching_target_reply_completes_the_run() {
        let (_root, home) = temp_home("rpc-run");
        let mut p = test_provider(&home);
        let mut init_failure = failures()["denied"].clone();
        init_failure["id"] = json!(1);
        let mut notification = failures()["denied"].clone();
        notification["method"] = json!("account/rateLimits/updated");
        let mut wrong_id = failures()["denied"].clone();
        wrong_id["id"] = json!(42);
        let full = json!({"id":3,"result":{"ordinaryUsageAllowed":false,
            "rateLimits":{"primary":{"usedPercent":100,"windowDurationMins":300}}}});
        let eof = FetchError::Disconnected;
        for (frames, end, expected, writes) in [
            (vec![init_failure], eof, Run::NotRun, 1),
            (vec![initialize()], eof, Run::Unknown, 3),
            (
                vec![initialize(), account()],
                FetchError::Timeout,
                Run::Unknown,
                4,
            ),
            (
                vec![initialize(), json!({"id":2,"result":{"account":null}})],
                eof,
                Run::Ran(Outcome::Failed),
                3,
            ),
            (
                vec![initialize(), wrong_id, notification, account(), full],
                eof,
                Run::Ran(Outcome::Ok),
                4,
            ),
        ] {
            let mut sent = Vec::new();
            let snap = p.collect_with(NOW, true, |_, _, q| replay(q, &frames, end, &mut sent));
            assert_eq!(sent.iter().filter(|&&b| b == b'\n').count(), writes);
            assert_eq!(p.take_run(), Some(expected));
            assert_eq!(p.take_run(), None);
            assert_eq!(
                p.last_fetch_attempt_ms(),
                (expected != Run::NotRun).then_some(NOW)
            );
            if expected == Run::Ran(Outcome::Ok) {
                assert_eq!(snap.blocked, Some(true));
            }
        }
        assert_eq!(test_provider(&home).last_fetch_attempt_ms(), Some(NOW));
    }

    #[test]
    fn a_sign_in_refused_upstream_is_a_known_failure_that_asks_to_sign_in_again() {
        let (_root, home) = temp_home("rpc-401");
        let mut p = test_provider(&home);
        p.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        // synthetic: the 403 fixture's form with the status of a refused sign-in
        let mut refused = failures()["denied"].clone();
        refused["error"]["data"]["codexErrorInfo"]["httpConnectionFailed"] =
            json!({"httpStatusCode":401});
        let snap = p.collect_with(NOW + 1, true, |_, _, q| {
            replay(
                q,
                &[initialize(), refused],
                FetchError::Disconnected,
                &mut Vec::new(),
            )
        });
        assert_eq!(
            p.take_run(),
            Some(Run::Ran(Outcome::Failed)),
            "a reply is known"
        );
        assert_eq!(snap.error_code, Some(ErrorCode::LoginRequired));
        assert!(snap.windows.is_empty(), "the values before aren't shown");
    }

    #[test]
    fn confirmed_holds_survive_a_local_write_error_without_copying_the_rpc_error() {
        let f = failures();
        for (frames, outcome) in [
            (
                vec![initialize(), f["denied"].clone()],
                Outcome::AccessDenied,
            ),
            (
                vec![initialize(), account(), f["limited"].clone()],
                Outcome::RateLimited {
                    retry_ms: Some(21_600_000),
                },
            ),
            (
                vec![initialize(), account(), f["backend"].clone()],
                Outcome::RateLimited { retry_ms: None },
            ),
        ] {
            for fail_write in [false, true] {
                let (_root, home) = temp_home("rpc-hold");
                let mut p = test_provider(&home);
                p.log = Logger::file(&home);
                let path = home.join(STATE_FILE);
                let snap = p.collect_with(NOW, true, |_, _, q| {
                    let res = replay(q, &frames, FetchError::Disconnected, &mut Vec::new());
                    if fail_write {
                        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
                        fs::create_dir(tmp).unwrap();
                    }
                    res
                });
                assert_eq!(p.take_run(), Some(Run::Ran(outcome)));
                assert_eq!(p.state_retry_at(), None);
                let diag = if outcome == Outcome::AccessDenied {
                    FetchError::AccessDenied
                } else {
                    FetchError::RateLimited { retry_ms: None }
                };
                assert_eq!(snap.error.as_deref(), Some(diag.message()));
                for output in [
                    fs::read_to_string(&path).unwrap(),
                    fs::read_to_string(home.join("logs/agent.log")).unwrap(),
                    serde_json::to_string(&snap).unwrap(),
                ] {
                    assert!(!output.contains("synthetic-private-marker"));
                }
            }
        }
    }

    #[test]
    fn expired_grants_skip_setup_and_are_checked_again_at_each_target_write() {
        use std::sync::atomic::{AtomicI64, Ordering};
        static WALL: AtomicI64 = AtomicI64::new(NOW);
        let (_root, home) = temp_home("rpc-grant");
        let mut p = test_provider(&home);
        for late_monotonic in [false, true] {
            let mut grant = grant_until(if late_monotonic { NOW + 2 } else { NOW + 1 });
            if late_monotonic {
                grant.until = Instant::now();
            }
            p.grant(Some(grant));
            p.clock = Some(|| NOW + 1);
            p.collect_with(NOW, true, |_, _, _| panic!("expired before setup"));
            assert_eq!(p.take_run(), Some(Run::NotRun));
            assert_eq!(p.last_fetch_attempt_ms(), None);
        }
        p.clock = None;
        for (first_send, writes, run) in [
            (NOW + 1, 2, Run::NotRun),
            (NOW, 3, Run::Ran(Outcome::Failed)),
        ] {
            p.grant(Some(grant_until(NOW + 1)));
            let mut sent = Vec::new();
            p.collect_with(NOW, true, |_, _, q| {
                WALL.store(first_send, Ordering::Relaxed);
                q.clock = Some(|| WALL.fetch_add(1, Ordering::Relaxed));
                replay(
                    q,
                    &[initialize(), account()],
                    FetchError::Disconnected,
                    &mut sent,
                )
            });
            assert_eq!(sent.iter().filter(|&&b| b == b'\n').count(), writes);
            let methods = targets(&sent);
            if run == Run::NotRun {
                assert!(methods.is_empty());
            } else {
                assert_eq!(methods, ["account/read"]);
            }
            assert_eq!(p.take_run(), Some(run));
            if run == Run::NotRun {
                assert_eq!(p.last_fetch_attempt_ms(), None);
                assert_eq!(p.fetch_due_ms(NOW), NOW);
            }
        }
    }

    #[test]
    fn setup_and_preflight_write_failures_do_not_count_as_queries() {
        let (_root, home) = temp_home("rpc-setup");
        let mut p = test_provider(&home);
        p.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Err(FetchError::Start))
        });
        assert_eq!(p.take_run(), Some(Run::NotRun));
        assert_eq!(p.last_fetch_attempt_ms(), None);
        assert_eq!(p.state.last_attempt_ms, None);
        assert_eq!(
            test_provider(&home).fetch_due_ms(NOW),
            NOW + 2 * MIN_INTERVAL_MS
        );
        let tmp = home
            .join(STATE_FILE)
            .with_extension(format!("{}.tmp", std::process::id()));
        fs::create_dir(tmp).unwrap();
        p.collect_with(NOW, true, |_, _, _| panic!("attempt record was not saved"));
        assert_eq!(p.take_run(), Some(Run::NotRun));
        assert_eq!(p.last_fetch_attempt_ms(), None);
    }

    #[test]
    fn cached_limits_become_stale_just_after_twenty_minutes() {
        let s = State {
            last_ok: Some(observation()),
            ..State::default()
        };
        let at = NOW + 20 * MINUTE_MS;
        assert_eq!(s.snapshot(at, None, Some(1)).status, ProviderStatus::Ok);
        let stale = s.snapshot(at + 1, None, Some(1));
        assert_eq!(stale.status, ProviderStatus::Stale);
        assert_eq!(
            stale.error.as_deref(),
            Some("Codex usage limits have not been updated for over 20 minutes")
        );
    }

    #[test]
    fn a_completed_rpc_from_an_old_epoch_is_rejected() {
        let (_root, home) = temp_home("fetch-epoch");
        let mut provider = test_provider(&home);
        let late = provider.collect_with(NOW, true, |_, _, q| {
            let result = successful_rpc(q, &mut Vec::new());
            set_epoch(&home, 2, false, None);
            set_epoch(&home, 3, true, None);
            result
        });
        assert_eq!(provider.take_run(), Some(Run::Ran(Outcome::Failed)));
        assert!(late.windows.is_empty());
        let saved = load_state(&home.join(STATE_FILE)).unwrap();
        assert!(saved.last_ok.is_none());
        // nothing failed upstream: no failure counted, so no longer wait than the interval; the query made is kept
        assert_eq!((saved.failures, saved.last_error), (0, None));
        assert_eq!(saved.last_query_ms, Some(NOW));
        let mut again = test_provider(&home);
        let due = NOW + MIN_INTERVAL_MS;
        assert_eq!(again.fetch_due_ms(NOW), due);
        let cached = again.collect_with(NOW, false, |_, _, _| panic!("early poll"));
        assert!(cached.windows.is_empty());
        let fresh = again.collect_with(due, false, |_, _, _| {
            let sample = observation_at(due);
            (Identity::default(), Ok(sample))
        });
        assert!(!fresh.windows.is_empty());
    }

    #[test]
    fn an_unconfirmed_clock_withholds_even_a_matching_cache() {
        let (_root, home) = temp_home("clock-unconfirmed");
        let mut provider = test_provider(&home);
        provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        let probe = |provider: &mut CodexProvider| {
            provider.forget_cached();
            assert!(
                load_state(&home.join(STATE_FILE))
                    .unwrap()
                    .last_ok
                    .is_some()
            );
            assert_eq!(provider.fetch_due_ms(NOW), i64::MAX);
            let snap = provider.collect_with(NOW, true, |_, _, _| panic!("untrusted fetch"));
            assert!(snap.windows.is_empty());
        };
        set_epoch(&home, 1, true, Some(1));
        probe(&mut provider);
        set_epoch(&home, 1, false, None);
        probe(&mut provider);
        let file = home.join("clock-epoch.json");
        fs::write(&file, b"{").unwrap();
        probe(&mut provider);
        fs::remove_file(file).unwrap();
        probe(&mut provider);
    }

    #[test]
    fn discarded_codex_observations_stay_out_of_the_next_put() {
        use crate::push::{CredentialStore, Credentials, Pusher, SendError, Transport};
        use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

        #[derive(Clone, Default)]
        struct Receiver(Rc<RefCell<Vec<Value>>>);

        impl CredentialStore for Receiver {
            fn load(&self) -> Result<Credentials, String> {
                Ok(Credentials {
                    token: "test".into(),
                })
            }
        }

        impl Transport for Receiver {
            fn put(
                &mut self,
                _: &str,
                _: &[(&str, &str)],
                body: &str,
            ) -> Result<(u16, String), SendError> {
                let mut received = self.0.borrow_mut();
                received.push(serde_json::from_str(body).unwrap());
                if received.len() == 1 {
                    return Err(SendError::Network); // accepted, but the reply was lost
                }
                Ok((204, String::new()))
            }
        }

        let (_root, home) = temp_home("discard-put");
        let receiver = Receiver::default();
        let pusher = || {
            Pusher::new(
                &home,
                "https://example.invalid",
                Logger::stderr(),
                Box::new(receiver.clone()),
                Box::new(receiver.clone()),
            )
        };
        let send = |p: &mut Pusher, snap, now| {
            let latest = BTreeMap::from([("codex".to_string(), snap)]);
            p.record(&latest, true, now);
            p.push(&crate::schema::build_snapshot(latest, now, "pc"), now);
        };
        let at = NOW - 2 * MINUTE_MS;
        let mut provider = test_provider(&home);
        let old = provider.collect_with(at, true, |_, _, _| {
            (Identity::default(), Ok(observation_at(at)))
        });
        // The second collector caches a newer fetch before the first collector sends its snapshot.
        let cached = test_provider(&home).collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        assert_eq!(cached.fetched_at, Some(iso_from_ms(NOW)));
        send(&mut pusher(), old, NOW);
        assert!(provider.forget_cached());
        assert_eq!(Pusher::discard_queue(&home), Ok(Some(1)));
        drop(provider);

        let mut again = test_provider(&home);
        let mut sender = pusher();
        assert_eq!(again.state.last_attempt_ms, Some(NOW));
        assert!(again.state.last_ok.is_none());
        let tick = sender.due_ms();
        assert_eq!(again.fetch_due_ms(tick), i64::MAX);
        let held = again.collect_with(tick, false, |_, _, _| panic!("untrusted poll"));
        send(&mut sender, held, tick);
        let due = again.fetch_due_ms(tick);
        assert_eq!(due, NOW + MIN_INTERVAL_MS);
        let before_due = again.collect_with(tick, false, |_, _, _| panic!("poll before due"));
        assert!(before_due.windows.is_empty());
        assert!(before_due.fetched_at.is_none());
        let fresh = again.collect_with(due, false, |_, _, _| {
            (Identity::default(), Ok(observation_at(due)))
        });
        send(&mut sender, fresh, due);

        let puts = receiver.0.borrow();
        assert_eq!(puts.len(), 3);
        assert_eq!(puts[0]["observations"][0]["observed_at"], iso_from_ms(at));
        assert_eq!(puts[1]["observations"], json!([]));
        assert_eq!(
            puts[1]["snapshot"]["providers"]["codex"]["windows"],
            json!([])
        );
        assert!(puts[1]["seq"].as_i64().unwrap() > puts[0]["seq"].as_i64().unwrap());
        assert_eq!(puts[2]["observations"].as_array().unwrap().len(), 1);
        assert_eq!(puts[2]["observations"][0]["observed_at"], iso_from_ms(due));
        let windows = puts[2]["snapshot"]["providers"]["codex"]["windows"]
            .as_array()
            .unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0]["fetched_at"], iso_from_ms(due));
    }

    #[test]
    fn unreadable_state_sets_a_retry_deadline_until_reloaded() {
        let (_root, home) = temp_home("state-read-retry");
        let mut provider = test_provider(&home);
        let path = home.join(STATE_FILE);
        let initial = provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        assert_eq!(initial.status, ProviderStatus::Ok);
        assert_eq!(provider.state_retry_at(), None);

        let saved = home.join("saved-state.json");
        fs::rename(&path, &saved).unwrap();
        fs::create_dir(&path).unwrap();
        let failed_at = NOW + 1;
        let failed = provider.collect_with(failed_at, true, |_, _, _| {
            panic!("fetched with unreadable state")
        });
        assert_eq!(failed.error_code, Some(ErrorCode::FetchFailed));
        assert!(failed.windows.is_empty());
        let status = CodexProvider::status_parts(&home, Some(true)).unwrap();
        assert_eq!(status.failures, None, "not known while unreadable");
        assert!(
            CodexProvider::status_parts(&home, Some(false)).is_none(),
            "turned off: its old file isn't used"
        );
        assert!(status.last_error.contains("retry automatically"));
        assert!(status.last_error.contains("permissions"));
        assert!(!status.last_error.contains("--accept-account"));
        assert_eq!(
            status.not_scheduled,
            Some("waiting to retry the state read")
        );
        // read again a minute on, and no later than a minute from now on a clock set back
        let retry_at = failed_at + MINUTE_MS;
        assert_eq!(provider.state_retry_at(), Some(retry_at));
        let back = failed_at - 60 * MINUTE_MS;
        assert_eq!(
            provider.next_due_ms(back),
            back,
            "set back: read again at once"
        );
        // its time come (and a fetch due by then): read again first, no turn asked for before a read succeeds
        let late = retry_at + 10 * MINUTE_MS;
        assert_eq!(provider.next_due_ms(late), retry_at, "read again at once");
        assert_eq!(provider.fetch_due_ms(late), i64::MAX, "no turn before");
        // the lock can't be opened as it is read again: a minute on (not every second)
        let lock = home.join("codex-poll.lock");
        let _ = fs::remove_file(&lock);
        fs::create_dir(&lock).unwrap();
        provider.collect_with(late, false, |_, _, _| panic!("fetched while unread"));
        assert_eq!(provider.state_retry_at(), Some(late + MINUTE_MS));
        assert_eq!(provider.next_due_ms(late), late + MINUTE_MS);
        fs::remove_dir(&lock).unwrap();

        fs::remove_dir(&path).unwrap();
        fs::rename(saved, &path).unwrap();
        provider.hold_fetch_until(retry_at + MIN_INTERVAL_MS);
        let restored = provider.collect_with(retry_at, false, |_, _, _| {
            panic!("fetched before the hold expired")
        });
        assert_eq!(restored.status, ProviderStatus::Ok);
        assert_eq!(provider.state_retry_at(), None);
    }

    #[test]
    fn forgetting_a_cache_distinguishes_absence_and_corruption_from_io_errors() {
        let (_root, home) = temp_home("discard-errors");
        let mut provider = test_provider(&home);
        let path = home.join(STATE_FILE);
        assert!(provider.forget_cached());
        assert!(!path.exists());
        fs::write(&path, b"{broken").unwrap();
        assert!(provider.forget_cached());
        assert!(provider.state.account_changed);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(!provider.forget_cached());
        fs::remove_dir(&path).unwrap();

        provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        let lock = fs::File::create(home.join("codex-poll.lock")).unwrap();
        lock.try_lock().unwrap();
        assert!(!provider.forget_cached());
        drop(lock);
        set_epoch(&home, 2, true, None);
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        fs::create_dir(&tmp).unwrap();
        assert!(!provider.forget_cached());
        assert!(load_state(&path).unwrap().last_ok.is_some());
        fs::remove_dir(&tmp).unwrap();
        assert!(provider.forget_cached());
        assert!(load_state(&path).unwrap().last_ok.is_none());
    }

    #[test]
    fn lock_retry_preserves_a_newer_manual_collection() {
        use std::sync::atomic::{AtomicI64, Ordering};

        static CLOCK: AtomicI64 = AtomicI64::new(NOW);
        let (_root, home) = temp_home("lock-retry-clock");
        let mut daemon = test_provider(&home);
        daemon.clock = Some(|| CLOCK.load(Ordering::Relaxed));

        fs::create_dir_all(&home).unwrap();
        let lock = fs::File::create(home.join("codex-poll.lock")).unwrap();
        lock.try_lock().unwrap();
        daemon.collect_with(NOW, false, |_, _, _| panic!("lock held"));
        drop(lock);

        let tick = NOW + LOCK_RETRY_MS;
        assert_eq!(daemon.fetch_due_ms(tick), tick);
        let attempt = tick + 1;
        let fetched = attempt + 1;
        test_provider(&home).collect_with(attempt, true, |_, _, _| {
            (Identity::default(), Ok(observation_at(fetched)))
        });

        let after_reload = fetched + 1;
        CLOCK.store(after_reload, Ordering::Relaxed);
        let cached = daemon.collect_with(tick, false, |_, _, _| panic!("duplicate fetch"));
        assert_eq!(cached.fetched_at, Some(iso_from_ms(fetched)));
        let saved = load_state(&home.join(STATE_FILE)).unwrap();
        assert_eq!(saved.last_ok.unwrap().fetched_ms, fetched);
        assert_eq!(saved.last_attempt_ms, Some(attempt));
        let due = attempt + MIN_INTERVAL_MS;
        assert_eq!(daemon.fetch_due_ms(after_reload), due);
        assert_eq!(daemon.last_collect_ms, after_reload);

        let hold = due + MIN_INTERVAL_MS;
        daemon.hold_fetch_until(hold);
        daemon.collect_with(tick, false, |_, _, _| panic!("fetch during hold"));
        assert_eq!(daemon.fetch_due_ms(after_reload), hold);
    }

    /// Replies to the handshake, then none (the wait for the rest runs out), on the clocks given
    fn waits_out(
        query: &mut Query<'_>,
        frames: &[Value],
        asleep: rpc::Asleep,
        input: &mut dyn std::io::Write,
    ) -> (Identity, Result<Observation, FetchError>) {
        let (tx, rx) = std::sync::mpsc::channel();
        for frame in frames {
            tx.send(Ok(serde_json::to_vec(frame).unwrap())).unwrap();
        }
        let mut rpc = rpc::Connection {
            input,
            replies: &rx,
            deadline: Instant::now() + Duration::from_millis(200),
            asleep,
        };
        let out = read_limits(&mut rpc, query);
        drop(tx);
        out
    }

    #[test]
    fn a_sleep_while_a_request_is_got_ready_doesn_t_count_one_right_after_it_is_written_does() {
        use crate::time::ReadFirst;
        use std::sync::atomic::{AtomicBool, Ordering};
        // The turn's check before the target request is written reads this PC's clock: the computer sleeps there (while the
        // request is got ready). Each write wakes it again (the mark is cleared)
        static PREPARED: AtomicBool = AtomicBool::new(false);
        fn clock() -> i64 {
            PREPARED.store(true, Ordering::SeqCst);
            NOW
        }
        struct Writes;
        impl std::io::Write for Writes {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                PREPARED.store(false, Ordering::SeqCst);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        // asleep for ten minutes as the request was got ready, awake from its write until its wait ran out
        fn slept_preparing(first: ReadFirst) -> Option<(Duration, Duration)> {
            let s = Duration::from_secs;
            Some(match first {
                ReadFirst::Stopping if PREPARED.load(Ordering::SeqCst) => (s(600), s(1)),
                ReadFirst::Stopping => (s(0), s(0)),
                ReadFirst::RunningOn => (s(601), s(2)),
            })
        }
        let (_root, home) = temp_home("suspended-preparing");
        let mut provider = test_provider(&home);
        provider.clock = Some(clock);
        provider.collect_with(NOW, true, |_, _, q| {
            waits_out(
                q,
                &[initialize(), account()],
                rpc::Asleep::new(slept_preparing),
                &mut Writes,
            )
        });
        assert_eq!(provider.take_run(), Some(Run::Unknown), "not counted");
    }

    #[test]
    fn a_request_cut_off_by_the_computer_s_sleep_is_an_ordinary_failure_tried_again() {
        use crate::time::ReadFirst;
        use std::sync::atomic::{AtomicU32, Ordering};

        fn slept(first: ReadFirst) -> Option<(Duration, Duration)> {
            Some(match first {
                ReadFirst::Stopping => (Duration::ZERO, Duration::ZERO),
                ReadFirst::RunningOn => (Duration::from_secs(600), Duration::from_secs(1)),
            })
        }
        fn awake(first: ReadFirst) -> Option<(Duration, Duration)> {
            Some(match first {
                ReadFirst::Stopping => (Duration::ZERO, Duration::ZERO),
                ReadFirst::RunningOn => (Duration::from_secs(1), Duration::from_secs(1)),
            })
        }
        // awake when the wait ran out, asleep only later (as the server is shut down): read once, at the cut
        static READS: AtomicU32 = AtomicU32::new(0);
        fn asleep_later(first: ReadFirst) -> Option<(Duration, Duration)> {
            if first == ReadFirst::RunningOn && READS.fetch_add(1, Ordering::SeqCst) > 0 {
                return slept(first);
            }
            awake(first)
        }

        for (clocks, error, run) in [
            (
                slept as fn(_) -> _,
                FetchError::Suspended,
                Run::Ran(Outcome::Failed),
            ),
            (awake, FetchError::Timeout, Run::Unknown),
            (asleep_later, FetchError::Timeout, Run::Unknown),
        ] {
            let (_root, home) = temp_home("suspended");
            let mut provider = test_provider(&home);
            let snap = provider.collect_with(NOW, true, |_, _, q| {
                // the target request written, its reply never comes
                waits_out(
                    q,
                    &[initialize(), account()],
                    rpc::Asleep::new(clocks),
                    &mut Vec::new(),
                )
            });
            assert_eq!(provider.take_run(), Some(run), "{error:?}");
            assert_eq!(snap.error.as_deref(), Some(error.message()));
            assert_eq!(snap.error_code, Some(ErrorCode::FetchFailed));
            // saved as a timeout: an earlier version reads the state back
            let saved = load_state(&home.join(STATE_FILE)).unwrap();
            assert_eq!(
                (saved.failures, saved.last_error),
                (1, Some(FetchError::Timeout))
            );
            assert!(!saved.account_changed);
        }
        assert_eq!(
            READS.load(Ordering::SeqCst),
            1,
            "read once, when the wait ended"
        );
        // asleep before the request that ran out was written (while the server was got ready, or during the handshake), awake
        // through its wait:
        // its result stays unknown
        static BEGUN: AtomicU32 = AtomicU32::new(0);
        fn asleep_before(first: ReadFirst) -> Option<(Duration, Duration)> {
            let s = Duration::from_secs;
            Some(match first {
                ReadFirst::Stopping if BEGUN.fetch_add(1, Ordering::SeqCst) == 0 => (s(0), s(0)),
                ReadFirst::Stopping => (s(600), s(1)),
                ReadFirst::RunningOn => (s(601), s(2)),
            })
        }
        let (_root, home) = temp_home("suspended-before");
        let mut provider = test_provider(&home);
        provider.collect_with(NOW, true, |_, _, q| {
            waits_out(
                q,
                &[initialize(), account()],
                rpc::Asleep::new(asleep_before),
                &mut Vec::new(),
            )
        });
        assert_eq!(provider.take_run(), Some(Run::Unknown));
        assert_eq!(
            BEGUN.load(Ordering::SeqCst),
            4,
            "read right before each write"
        );
        // the handshake's own wait cut off: nothing was written, still not run
        let (_root, home) = temp_home("suspended-setup");
        let mut provider = test_provider(&home);
        provider.collect_with(NOW, true, |_, _, q| {
            waits_out(q, &[], rpc::Asleep::new(slept), &mut Vec::new())
        });
        assert_eq!(provider.take_run(), Some(Run::NotRun));
        // the target request couldn't be written (no wait for a reply): its result stays unknown, also after a sleep
        struct FailsAt(usize);
        impl std::io::Write for FailsAt {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0 = self.0.saturating_sub(1);
                if self.0 == 0 {
                    return Err(std::io::ErrorKind::BrokenPipe.into());
                }
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (_root, home) = temp_home("suspended-write");
        let mut provider = test_provider(&home);
        let snap = provider.collect_with(NOW, true, |_, _, q| {
            waits_out(q, &[initialize()], rpc::Asleep::new(slept), &mut FailsAt(3))
        });
        assert_eq!(provider.take_run(), Some(Run::Unknown));
        assert_ne!(snap.error.as_deref(), Some(FetchError::Suspended.message()));
    }

    #[test]
    fn crossing_a_hold_deadline_waits_for_the_next_duty_check() {
        use std::sync::atomic::{AtomicI64, Ordering};

        static CLOCK: AtomicI64 = AtomicI64::new(NOW + MIN_INTERVAL_MS + 1);
        let (_root, home) = temp_home("duty-clock");
        let mut daemon = test_provider(&home);
        let due = NOW + MIN_INTERVAL_MS;
        daemon.clock = Some(|| CLOCK.load(Ordering::Relaxed));
        daemon.hold_fetch_until(due);
        daemon.collect_with(due - 1, false, |_, _, _| panic!("fetch without a turn"));

        daemon.collect_with(due, false, |_, _, q| {
            q.before_write().unwrap();
            (Identity::default(), Err(FetchError::Timeout))
        });
        let attempt = due + 1;
        let saved = load_state(&home.join(STATE_FILE)).unwrap();
        assert_eq!(saved.last_attempt_ms, Some(attempt));
        assert_eq!(daemon.fetch_due_ms(attempt), attempt + 2 * MIN_INTERVAL_MS);
    }

    #[test]
    fn clock_repair_survives_restart_and_preserves_poll_delays() {
        let future = NOW + 3 * 60 * MINUTE_MS;
        for (attempt, fetched, failures, wait_min) in [
            (NOW - MIN_INTERVAL_MS, future, 0, 5),
            (future, future, 2, 20),
            (future, NOW - MINUTE_MS, 2, 60),
        ] {
            let (_root, home) = temp_home("clock-repair");
            fs::create_dir_all(&home).unwrap();
            let mut cached = observation_at(fetched);
            cached.snapshot.blocked = Some(true);
            cached.snapshot.windows[0].used_percent = 100.0;
            cached.snapshot.windows[0].resets_at = Some(iso_from_ms(future));
            let path = home.join(STATE_FILE);
            write_json_atomic(
                &path,
                &State {
                    last_attempt_ms: Some(attempt),
                    last_ok: Some(cached),
                    failures,
                    ..State::default()
                },
            )
            .unwrap();
            let open = || test_provider(&home);
            let mut p = open();
            let due = NOW + wait_min * MINUTE_MS;
            assert!(p.next_due_ms(NOW) <= NOW);
            assert_eq!(p.fetch_due_ms(NOW), due);
            let snap = p.collect_with(NOW, false, |_, _, _| panic!("early fetch"));
            assert_eq!(snap.windows.is_empty(), fetched > NOW);
            let saved = load_state(&path).unwrap();
            assert_eq!(saved.last_attempt_ms, Some(NOW));
            assert_eq!(saved.last_ok.is_some(), fetched <= NOW);
            assert_eq!(saved.failures, failures);

            let mut p = open();
            p.collect_with(due - 1, false, |_, _, _| panic!("early retry"));
            assert_eq!(p.next_due_ms(due - 1), due);
            let fresh = p.collect_with(due, false, |_, _, _| {
                (Identity::default(), Ok(observation_at(due + 1)))
            });
            assert_eq!(fresh.windows[0].fetched_at, Some(iso_from_ms(due + 1)));
        }
    }

    #[test]
    fn lock_retry_wakes_after_clock_rollback() {
        let (_root, home) = temp_home("clock-repair-lock");
        let open = || test_provider(&home);
        let mut owner = open();
        let mut waiter = open();
        owner.collect_with(NOW, false, |_, _, _| {
            waiter.collect_with(NOW, false, |_, _, _| panic!("lock held"));
            (Identity::default(), Ok(observation()))
        });
        let corrected = NOW - 60 * MINUTE_MS;
        assert_eq!(waiter.next_due_ms(corrected), corrected);
        waiter.collect_with(corrected, false, |_, _, _| panic!("early fetch"));
        assert_eq!(waiter.fetch_due_ms(corrected), corrected + MIN_INTERVAL_MS);
    }

    #[test]
    fn blocked_schedule_respects_reset_grace_normal_interval_and_backoff() {
        let mut last_ok = observation();
        last_ok.snapshot.blocked = Some(true);
        last_ok.snapshot.windows[0].used_percent = 100.0;
        let mut state = State {
            last_attempt_ms: Some(NOW),
            last_ok: Some(last_ok),
            ..State::default()
        };
        let interval = 5 * MINUTE_MS;
        let due = |state: &State| state.due_ms(NOW, interval, Some(1));

        for (reset_in, expected) in [(Some(180), 60), (Some(20), 21), (Some(1), 5), (None, 60)] {
            state.last_ok.as_mut().unwrap().snapshot.windows[0].resets_at =
                reset_in.map(|minutes| iso_from_ms(NOW + minutes * MINUTE_MS));
            assert_eq!(due(&state), NOW + expected * MINUTE_MS);
        }
        state.last_ok.as_mut().unwrap().snapshot.windows[0].resets_at = Some(iso_from_ms(NOW));
        state.failures = 3;
        assert_eq!(due(&state), NOW + backoff_ms(interval, state.failures));
        state.failures = 0;
        state.last_ok.as_mut().unwrap().snapshot.blocked = Some(false);
        assert_eq!(due(&state), NOW + interval);
    }

    #[test]
    fn restart_publishes_the_cached_limit_without_polling_early() {
        let (_root, home) = temp_home("blocked-restart");
        fs::create_dir_all(&home).unwrap();
        let mut last_ok = observation();
        last_ok.snapshot.blocked = Some(true);
        last_ok.snapshot.windows[0].used_percent = 100.0;
        last_ok.snapshot.windows[0].resets_at = Some(iso_from_ms(NOW + 180 * MINUTE_MS));
        write_json_atomic(
            &home.join(STATE_FILE),
            &State {
                last_attempt_ms: Some(NOW),
                last_ok: Some(last_ok),
                ..State::default()
            },
        )
        .unwrap();
        let now = NOW + MINUTE_MS;
        let mut provider = test_provider(&home);

        assert!(provider.next_due_ms(now) <= now);
        let snap = provider.collect_with(now, false, |_, _, _| {
            panic!("Fetched before the hold expired")
        });
        assert_eq!(snap.blocked, Some(true));
        assert_eq!(provider.next_due_ms(now), NOW + 60 * MINUTE_MS);
        // A manual fetch bypasses the hold while the usage limit is reached.
        let snap = provider.collect_with(now, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        assert_eq!(snap.blocked, Some(false));
    }

    #[test]
    fn a_named_round_and_restart_keep_the_cache_until_one_due_fetch() {
        use crate::{agent::Round, config::Config, requests::Request};

        struct Other;
        impl Provider for Other {
            fn id(&self) -> &'static str {
                "claude"
            }
            fn next_due_ms(&self, _: i64) -> i64 {
                i64::MAX
            }
            fn collect(&mut self, _: i64, _: bool) -> ProviderSnapshot {
                observation().snapshot
            }
            fn take_run(&mut self) -> Option<Run> {
                Some(Run::Ran(Outcome::Ok))
            }
        }

        let (_root, home) = temp_home("named-round");
        let mut p = test_provider(&home);
        let cached = p.collect_with(NOW, false, |_, _, q| successful_rpc(q, &mut Vec::new()));
        for restarted in [false, true] {
            let mut providers: Vec<Box<dyn Provider>> =
                vec![Box::new(Other), Box::new(test_provider(&home))];
            let mut round = Round::new(
                &Config::default(),
                "pc",
                Logger::stderr(),
                || NOW + 1,
                &home,
            );
            if restarted {
                round.run(&mut providers, None);
            } else {
                let req = Request {
                    provider: Some("claude".into()),
                    force: true,
                    ..Request::default()
                };
                assert!(round.run_request(&mut providers, None, &req).1.ok);
            }
            assert_eq!(round.latest["codex"], cached);
            let saved = load_state(&home.join(STATE_FILE)).unwrap();
            assert_eq!(saved.last_ok.unwrap().fetched_ms, NOW);
        }
        let due = NOW + MIN_INTERVAL_MS;
        let mut sent = Vec::new();
        p.grant(Some(grant_until(due + 60_000)));
        p.collect_with(due, false, |_, _, q| successful_rpc(q, &mut sent));
        assert_eq!(targets(&sent), ["account/read", "account/rateLimits/read"]);
        assert_eq!(p.take_run(), Some(Run::Ran(Outcome::Ok)));
        p.collect_with(due, false, |_, _, _| panic!("duplicate due fetch"));
        assert_eq!(p.take_run(), Some(Run::NotRun));
    }

    #[test]
    fn real_week_only_fixture_is_a_successful_v2_snapshot() {
        let snap = observation().snapshot;
        assert_eq!(snap.status, ProviderStatus::Ok);
        assert_eq!(snap.plan.as_deref(), Some("prolite"));
        assert_eq!(snap.windows.len(), 1);
        let week = &snap.windows[0];
        assert_eq!(week.id, "seven_day");
        assert_eq!(week.kind, WindowKind::Weekly);
        assert_eq!(week.fetched_at, snap.fetched_at);
        assert_eq!(week.resets_at.as_deref(), Some("2026-11-20T10:51:04.000Z"));
        assert_eq!(week.used_percent, 29.0);
        assert_eq!(week.scope, None);
        assert_eq!(snap.blocked, Some(false));
        assert_eq!(snap.error_code, None);
    }

    #[test]
    fn groups_use_duration_ids_and_keep_colliding_windows() {
        let snap = normalize(
            &json!({
                "rateLimits": {"primary":{"usedPercent":99,"windowDurationMins":300}},
                "rateLimitsByLimitId": {
                    "codex": {
                        "primary":{"usedPercent":40,"windowDurationMins":10080},
                        "secondary":{"usedPercent":30,"windowDurationMins":300,"resetsAt":null}
                    },
                    "codex.extra": {
                        "limitName":"Acme Corp","normalModelSlug":"test-model",
                        "rateLimitReachedType":"rateLimitReached",
                        "primary":{"usedPercent":100,"windowDurationMins":10080},
                        "secondary":{"usedPercent":20,"windowDurationMins":10080}
                    }
                }
            }),
            Some("plus"),
            NOW,
        )
        .unwrap();
        let ids: Vec<_> = snap
            .windows
            .iter()
            .map(|window| window.id.as_str())
            .collect();
        assert_eq!(
            ids,
            [
                "seven_day",
                "five_hour",
                "codex_extra_seven_day",
                "codex_extra_seven_day_secondary"
            ]
        );
        assert_eq!(snap.windows[1].used_percent, 30.0);
        assert!(snap.windows[1].resets_at.is_none());
        assert_eq!(snap.windows[2].scope.as_deref(), Some("codex_extra"));
        assert_eq!(snap.windows[2].label, "Weekly codex_extra");
        assert_eq!(snap.blocked, Some(false));
        assert!(snap.windows.iter().all(|w| {
            !w.label.contains("Acme Corp")
                && w.scope.as_deref().is_none_or(|s| !s.contains("Acme Corp"))
        }));
        assert_eq!(snap.for_upload().windows.as_slice(), &snap.windows[..2]);
    }

    #[test]
    fn known_group_uses_normalized_id_and_display_name() {
        let limits = json!({"rateLimitsByLimitId": {
            "Codex-Bengalfox": {
                "limitName": "Acme Corp",
                "primary": {"usedPercent": 10, "windowDurationMins": 300}
            }
        }});
        let snap = normalize(&limits, None, NOW).unwrap();
        let window = &snap.windows[0];
        assert_eq!(window.id, "codex_bengalfox_five_hour");
        assert!(crate::schema::is_window_id(&window.id));
        assert_eq!(
            crate::schema::sendable_scope(&window.id),
            Some(Some("Codex extra"))
        );
        assert_eq!(window.scope.as_deref(), Some("Codex extra"));
        assert_eq!(window.label, "5h Codex extra");
    }

    #[test]
    fn legacy_month_and_credit_only_responses_stay_usable() {
        let monthly = normalize(
            &json!({"rateLimitsByLimitId":{},"rateLimits":{
                "primary":{"usedPercent":10,"windowDurationMins":43200},
                "rateLimitReachedType":"workspaceOwnerUsageLimitReached"
            }}),
            Some("go"),
            NOW,
        )
        .unwrap();
        assert_eq!(monthly.windows[0].id, "monthly");
        assert_eq!(monthly.windows[0].kind, WindowKind::Monthly);
        assert_eq!(monthly.blocked, Some(true));

        let credit_only = normalize(
            &json!({"rateLimits":{"credits":{"balance":"3.5"}}}),
            None,
            NOW,
        )
        .unwrap();
        assert!(credit_only.windows.is_empty());
        assert_eq!(credit_only.blocked, None);
        assert!(matches!(
            normalize(
                &json!({"rateLimits":{"primary":{"usedPercent":"unknown"}}}),
                Some("go"),
                NOW
            ),
            Err(FetchError::Protocol)
        ));
        assert!(matches!(
            normalize(&json!({"rateLimits":{}}), Some("go"), NOW),
            Err(FetchError::Protocol)
        ));
    }

    #[test]
    fn ordinary_usage_denied_blocks_even_below_the_window_limit() {
        let limits = json!({
            "rateLimits": {"primary": {"usedPercent": 35, "windowDurationMins": 10080}},
            "ordinaryUsageAllowed": false
        });
        let snapshot = normalize(&limits, None, NOW).unwrap();
        assert_eq!(snapshot.blocked, Some(true));
        assert_eq!(snapshot.windows[0].used_percent, 35.0);

        let limits = json!({"rateLimits": {}, "ordinaryUsageAllowed": true});
        let snapshot = normalize(&limits, None, NOW).unwrap();
        assert_eq!(snapshot.blocked, Some(false));
        assert!(snapshot.windows.is_empty());
    }

    #[test]
    fn a_scoped_legacy_bucket_does_not_block_the_whole_provider() {
        let limits = json!({"rateLimits": {
            "limitId": "codex.other",
            "primary": {"usedPercent": 100, "windowDurationMins": 10080},
            "rateLimitReachedType": "rateLimitReached"
        }});
        let snapshot = normalize(&limits, None, NOW).unwrap();
        assert_eq!(snapshot.windows[0].scope.as_deref(), Some("codex_other"));
        assert_eq!(snapshot.blocked, None);

        let mut denied = limits;
        denied["ordinaryUsageAllowed"] = json!(false);
        assert_eq!(normalize(&denied, None, NOW).unwrap().blocked, Some(true));
    }

    #[test]
    fn a_full_global_window_still_blocks() {
        let limits =
            json!({"rateLimits": {"primary": {"usedPercent": 100, "windowDurationMins": 10080}}});
        assert_eq!(normalize(&limits, None, NOW).unwrap().blocked, Some(true));
    }

    #[test]
    fn an_old_ambiguous_block_is_withheld_but_a_current_account_denial_is_kept() {
        let mut sample = observation();
        let mut scoped = make_window("extra_seven_day", 100.0, None);
        scoped.scope = Some("Extra".into());
        sample.snapshot.windows.push(scoped);
        sample.snapshot.blocked = Some(true);

        let mut cached = serde_json::to_value(sample).unwrap();
        let state_with = |sample| {
            serde_json::from_value::<State>(json!({"identity": {}, "last_ok": sample})).unwrap()
        };
        let current = state_with(cached.clone()).snapshot(NOW, None, Some(1));
        assert_eq!(current.blocked, Some(true));

        cached
            .as_object_mut()
            .unwrap()
            .remove("blocked_rule_version");
        let old = state_with(cached).snapshot(NOW, None, Some(1));
        assert_eq!(old.blocked, None);
        assert_eq!(old.windows.len(), 2);
        assert_eq!(old.fetched_at, current.fetched_at);
    }

    #[test]
    fn ignores_untagged_observations_without_losing_poll_history() {
        let mut legacy = json!({
            "last_attempt_ms": NOW,
            "failures": 2,
            "last_error": "Remote",
            "identity": {"user_hash": "fixture-only"},
            "last_ok": {"fetched_ms": NOW - 1000, "snapshot": {
                "status": "ok", "account": {"plan": "prolite"},
                "limit": {"reached": false, "usage_allowed": false},
                "windows": [{"id": "extra_seven_day", "label": "Weekly Extra", "kind": "weekly",
                    "used_percent": 29, "model": "example-model", "group": "extra", "group_label": "Extra"}]
            }}
        });
        let state: State = serde_json::from_value(legacy.clone()).unwrap();
        let snapshot = state.snapshot(NOW, None, Some(1));
        assert_eq!(snapshot.status, ProviderStatus::Error);
        assert!(snapshot.windows.is_empty());
        assert_eq!(snapshot.plan, None);
        assert_eq!(state.identity.user_hash.as_deref(), Some("fixture-only"));
        assert_eq!(state.last_attempt_ms, Some(NOW));
        assert_eq!(state.failures, 2);
        assert_eq!(snapshot.error_code, Some(ErrorCode::FetchFailed));

        legacy["last_ok"] = json!("invalid cache");
        let invalid: State = serde_json::from_value(legacy).unwrap();
        assert!(invalid.last_ok.is_none());
        assert_eq!(invalid.last_attempt_ms, Some(NOW));
        assert_eq!(invalid.failures, 2);
    }

    #[test]
    fn retries_back_off_and_keep_cached_observation_until_recovery() {
        let (_root, home) = temp_home("backoff");
        let mut provider = test_provider(&home);
        assert_eq!(
            provider
                .collect_with(NOW, false, |_, _, _| (
                    Identity::default(),
                    Ok(observation())
                ))
                .status,
            ProviderStatus::Ok
        );

        let mut second = test_provider(&home);
        second.cfg.interval_min = 1;
        let cached = second.collect_with(NOW + MINUTE_MS, false, |_, _, _| panic!("poll interval"));
        assert_eq!(cached.status, ProviderStatus::Ok);
        let failed_at = NOW + MIN_INTERVAL_MS;
        let stale = provider.collect_with(failed_at, false, |_, _, _| {
            (Identity::default(), Err(FetchError::Timeout))
        });
        assert_eq!(stale.status, ProviderStatus::Stale);
        assert_eq!(stale.fetched_at, cached.fetched_at);
        assert_eq!(provider.state_retry_at(), None);
        assert_eq!(
            provider.next_due_ms(failed_at),
            failed_at + 2 * MIN_INTERVAL_MS
        );
        let reloaded = second.collect_with(failed_at + MINUTE_MS, false, |_, _, _| {
            panic!("backoff must persist")
        });
        assert_eq!(reloaded.status, ProviderStatus::Stale);
        let recovered = provider.collect_with(failed_at + 2 * MIN_INTERVAL_MS, false, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        assert_eq!(recovered.status, ProviderStatus::Ok);
        assert_eq!(provider.state.failures, 0);
    }

    #[test]
    fn manual_collection_cannot_bypass_the_active_poll_lock() {
        let (_root, home) = temp_home("lock");
        let mut first = test_provider(&home);
        let mut second = test_provider(&home);
        first.collect_with(NOW, true, |_, _, _| {
            let pending = second.collect_with(NOW, true, |_, _, _| {
                panic!("second process acquired a live lock")
            });
            assert!(pending.windows.is_empty());
            assert_eq!(second.take_run(), Some(Run::NotRun));
            assert_eq!(second.next_due_ms(NOW), NOW + LOCK_RETRY_MS);
            assert_eq!(second.state_retry_at(), None);
            (Identity::default(), Ok(observation()))
        });
        let result = second.collect_with(NOW + LOCK_RETRY_MS, false, |_, _, _| {
            panic!("uses committed first result")
        });
        assert_eq!(result.status, ProviderStatus::Ok);
        assert_eq!(second.take_run(), Some(Run::NotRun));
    }

    #[test]
    fn account_switch_survives_restart_and_requires_a_successful_acceptance() {
        let (_root, home) = temp_home("account");
        let mut provider = test_provider(&home);
        let identity =
            |user| account_identity(&json!({"account":{"type":"chatgpt"},"userId":user})).unwrap();
        let initial = provider.collect_with(NOW, true, |_, _, _| {
            (identity("synthetic-first"), Ok(observation()))
        });
        assert_eq!(initial.history_since, None);
        let switched = provider.collect_with(NOW + 1, true, |_, _, query| {
            let new = identity("<redacted>");
            assert!(query.expected.differs_from(&new));
            (new, Err(FetchError::AccountChanged))
        });
        assert_eq!(switched.status, ProviderStatus::Unavailable);
        assert_eq!(switched.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(switched.history_since, None);
        assert_eq!(provider.fetch_due_ms(NOW + MIN_INTERVAL_MS), i64::MAX);
        assert!(switched.windows.is_empty());
        assert!(provider.state.last_ok.is_none());
        let saved = fs::read_to_string(home.join(STATE_FILE)).unwrap();
        let published = serde_json::to_string(&switched).unwrap();
        assert!(!saved.contains("synthetic-"));
        assert!(!published.contains("hash"));

        let mut restarted = test_provider(&home);
        let held = restarted.collect_with(NOW + 2, true, |_, _, _| {
            panic!("force bypassed account stop")
        });
        assert_eq!(held.error_code, Some(ErrorCode::AccountChanged));
        let target = provider.pending_switch().unwrap();
        for (mark, grant) in [
            (target.wrapping_add(1), Some(grant_until(i64::MAX))),
            (target, None),
        ] {
            restarted.accept_target(Some(mark));
            restarted.accept_account();
            // The previous call's grant must already be gone.
            if let Some(grant) = grant {
                restarted.grant(Some(grant));
            }
            restarted.collect_with(NOW + 2, false, |_, _, _| panic!("unauthorized RPC"));
            assert_eq!(restarted.take_run(), Some(Run::NotRun));
            assert_eq!(restarted.account_accepted(), Some(false));
        }
        restarted.grant(Some(grant_until(i64::MAX)));
        restarted.collect_with(NOW + 2, true, |_, _, _| panic!("acceptance carried over"));
        assert_eq!(restarted.account_accepted(), None);
        set_epoch(&home, 1, false, None);
        authorize_switch(&mut restarted);
        restarted.collect_with(NOW + 2, false, |_, _, _| panic!("untrusted fetch"));
        assert_eq!(restarted.account_accepted(), Some(false));
        set_epoch(&home, 1, true, None);
        authorize_switch(&mut restarted);
        let failed = restarted.collect_with(NOW + 3, false, |_, _, _| {
            (identity("<redacted>"), Err(FetchError::Remote))
        });
        assert_eq!(failed.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(failed.history_since, None);
        assert_eq!(restarted.account_accepted(), Some(false));
        authorize_switch(&mut restarted);
        let unknown = restarted.collect_with(NOW + 4, false, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        assert_eq!(unknown.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(unknown.history_since, None);
        assert_eq!(restarted.account_accepted(), Some(false));
        authorize_switch(&mut restarted);
        let accepted_ms = NOW + 6;
        let boundary = Some(iso_from_ms(accepted_ms));
        let mut sent = Vec::new();
        let accepted = restarted.collect_with(NOW + 5, false, |_, _, q| {
            q.clock = Some(|| NOW + 6);
            successful_rpc(q, &mut sent)
        });
        assert_eq!(targets(&sent), ["account/read", "account/rateLimits/read"]);
        assert_eq!(restarted.take_run(), Some(Run::Ran(Outcome::Ok)));
        assert_eq!(provider.pending_switch(), None);
        assert_eq!(accepted.status, ProviderStatus::Ok);
        assert_eq!(accepted.history_since, boundary);
        assert_eq!(accepted.windows[0].fetched_at, boundary);
        assert_eq!(restarted.account_accepted(), Some(true));
        assert_eq!(
            load_state(&home.join(STATE_FILE))
                .unwrap()
                .account_accepted_ms,
            Some(accepted_ms)
        );
        restarted.collect_with(accepted_ms + 1, false, |_, _, _| panic!("early poll"));
        assert_eq!(restarted.account_accepted(), None);

        let mut after_restart = test_provider(&home);
        let cached = after_restart.collect_with(accepted_ms + 1, false, |_, _, _| {
            panic!("already has the accepted observation on disk")
        });
        assert_eq!(cached.history_since, boundary);
        let hold_until = NOW + 6 * MIN_INTERVAL_MS;
        assert!(provider.hold_fetch_until(hold_until));
        let resumed = provider.collect_with(NOW + MIN_INTERVAL_MS + 1, false, |_, _, _| {
            panic!("manual acceptance was already collected")
        });
        assert_eq!(resumed.status, ProviderStatus::Ok);
        assert_eq!(resumed.history_since, boundary);
        assert_eq!(provider.fetch_due_ms(NOW + MIN_INTERVAL_MS + 1), hold_until);
        let logout = after_restart.collect_with(NOW + MIN_INTERVAL_MS + 2, true, |_, _, _| {
            (Identity::default(), Err(FetchError::SignedOut))
        });
        assert_eq!(logout.error_code, Some(ErrorCode::LoginRequired));
        assert_eq!(logout.history_since, boundary);
    }

    #[test]
    fn acceptance_without_a_pending_switch_reports_false() {
        let (_root, home) = temp_home("accept-no-switch");
        let mut provider = test_provider(&home);
        provider.accept_account();
        provider.grant(Some(grant_until(i64::MAX)));
        provider.collect_with(NOW, true, |_, _, _| panic!("no pending switch"));
        assert_eq!(provider.take_run(), Some(Run::NotRun));
        assert_eq!(provider.account_accepted(), Some(false));
    }

    #[test]
    fn acceptance_reports_failure_when_the_final_state_write_fails() {
        let (_root, home) = temp_home("accept-save-failure");
        let path = home.join(STATE_FILE);
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        let mut provider = test_provider(&home);
        provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Err(FetchError::AccountChanged))
        });

        authorize_switch(&mut provider);
        fs::create_dir(&tmp).unwrap();
        provider.collect_with(NOW + 1, false, |_, _, _| panic!("preflight save failed"));
        assert_eq!(provider.take_run(), Some(Run::NotRun));
        assert_eq!(provider.account_accepted(), Some(false));
        fs::remove_dir(&tmp).unwrap();

        authorize_switch(&mut provider);
        let mut sent = Vec::new();
        let shown = provider.collect_with(NOW + 1, false, |_, _, q| {
            let result = successful_rpc(q, &mut sent);
            fs::create_dir(&tmp).unwrap();
            result
        });
        assert_eq!(targets(&sent), ["account/read", "account/rateLimits/read"]);
        assert_eq!(provider.take_run(), Some(Run::Ran(Outcome::Failed)));
        assert!(shown.windows.is_empty());
        assert!(tmp.is_dir());
        assert_eq!(provider.account_accepted(), Some(false));
        let saved = load_state(&path).unwrap();
        assert!(saved.account_changed);
        assert_eq!(saved.account_accepted_ms, None);
    }

    #[test]
    fn unreadable_state_withholds_cached_windows_until_explicit_recovery() {
        let (_root, home) = temp_home("unreadable-state");
        let state_path = home.join(STATE_FILE);
        let mut provider = test_provider(&home);
        provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        let old_state = r#"{"last_error":"UnknownFailureInAnotherVersion","identity":{"user_hash":"fixture-only"}}"#;
        fs::write(&state_path, old_state).unwrap();

        let stopped = provider.collect_with(NOW + 1, true, |_, _, _| {
            panic!("force must not clear unreadable state")
        });
        assert_eq!(stopped.status, ProviderStatus::Unavailable);
        assert_eq!(stopped.error_code, Some(ErrorCode::AccountChanged));
        assert!(stopped.windows.is_empty());
        assert_eq!(fs::read_to_string(&state_path).unwrap(), old_state);
        // turned off: its old file isn't used, so nothing is said of it
        assert!(CodexProvider::status_parts(&home, Some(false)).is_none());
        let status = CodexProvider::status_parts(&home, None).unwrap();
        assert_eq!(status.failures, None, "not known");
        assert!(status.last_error.contains("corrupt or invalid"));
        assert!(status.last_error.contains("--accept-account"));
        assert_eq!(status.not_scheduled, Some("waiting for manual resume"));

        authorize_switch(&mut provider);
        let failed = provider.collect_with(NOW + 2, false, |_, _, _| {
            assert!(
                load_state(&state_path).unwrap().account_changed,
                "stop must be saved before recovery starts"
            );
            (Identity::default(), Err(FetchError::MissingCli))
        });
        assert_eq!(failed.error_code, Some(ErrorCode::AccountChanged));
        let mut restarted = test_provider(&home);
        let automatic = restarted.collect_with(NOW + MIN_INTERVAL_MS, false, |_, _, _| {
            panic!("automatic recovery bypassed stop")
        });
        assert_eq!(automatic.error_code, Some(ErrorCode::AccountChanged));

        authorize_switch(&mut restarted);
        let recovered = restarted.collect_with(NOW + MIN_INTERVAL_MS + 1, false, |_, _, _| {
            let identity = account_identity(
                &json!({"account":{"type":"chatgpt"},"userId":"synthetic-current-user"}),
            )
            .unwrap();
            (identity, Ok(observation()))
        });
        assert_eq!(recovered.status, ProviderStatus::Ok);
        assert_eq!(recovered.error_code, None);
        assert_eq!(recovered.windows.len(), 1);
        assert!(!load_state(&state_path).unwrap().account_changed);
    }

    #[test]
    fn incomplete_state_cannot_reset_the_approved_identity() {
        let (_root, home) = temp_home("incomplete-state");
        fs::create_dir_all(&home).unwrap();
        let path = home.join(STATE_FILE);
        for incomplete in ["[]", "{}", r#"{"last_attempt_ms":123}"#] {
            fs::write(&path, incomplete).unwrap();
            let mut provider = test_provider(&home);
            let stopped = provider.collect_with(NOW, true, |_, _, _| {
                panic!("incomplete state must not be treated as a new installation")
            });
            assert_eq!(stopped.error_code, Some(ErrorCode::AccountChanged));
            assert!(stopped.windows.is_empty());
            assert_eq!(fs::read_to_string(&path).unwrap(), incomplete);
        }
    }

    #[test]
    fn logout_clears_windows_but_preserves_the_approved_identity() {
        let (_root, home) = temp_home("logout");
        let mut provider = test_provider(&home);
        let identity =
            |user| account_identity(&json!({"account":{"type":"chatgpt"},"userId":user})).unwrap();
        provider.collect_with(NOW, true, |_, _, _| {
            (identity("synthetic-first"), Ok(observation()))
        });
        let signed_out = provider.collect_with(NOW + 1, true, |_, _, _| {
            (
                Identity::default(),
                Err(account_identity(&json!({"account":null})).err().unwrap()),
            )
        });
        assert_eq!(signed_out.status, ProviderStatus::Unavailable);
        assert_eq!(signed_out.error_code, Some(ErrorCode::LoginRequired));
        assert_eq!(signed_out.blocked, None);
        assert!(signed_out.windows.is_empty());
        let switched = provider.collect_with(NOW + 2, true, |_, _, _| {
            (identity("synthetic-second"), Ok(observation()))
        });
        assert_eq!(switched.error_code, Some(ErrorCode::AccountChanged));
        assert!(switched.windows.is_empty());
    }

    #[test]
    fn a_state_that_is_gone_starts_again_knowing_its_account_so_another_one_is_a_switch() {
        let (_root, home) = temp_home("known-account");
        let mut provider = test_provider(&home);
        let identity = |user: &str, workspace: Option<&str>| Identity {
            user_hash: Some(user.into()),
            workspace_hash: workspace.map(Into::into),
        };
        provider.collect_with(NOW, true, |_, _, _| {
            (identity("first-user", Some("first-ws")), Ok(observation()))
        });
        assert_eq!(
            crate::store::known_account(&home, "codex").as_deref(),
            Some("first-user/first-ws")
        );
        // the state deleted: the same account carries on, another one (user or workspace) is a switch to accept
        for (other, switched) in [
            (identity("first-user", Some("first-ws")), false),
            (identity("second-user", Some("first-ws")), true),
            (identity("first-user", Some("second-ws")), true),
        ] {
            fs::remove_file(home.join(STATE_FILE)).unwrap();
            let mut again = test_provider(&home);
            let snap =
                again.collect_with(NOW + 1, true, |_, _, _| (other.clone(), Ok(observation())));
            assert_eq!(
                snap.error_code == Some(ErrorCode::AccountChanged),
                switched,
                "{:?}",
                other.kept()
            );
            assert!(load_state(&home.join(STATE_FILE)).unwrap().account_changed == switched);
            // a switch waiting keeps the account it knew
            assert_eq!(
                crate::store::known_account(&home, "codex").as_deref(),
                Some("first-user/first-ws")
            );
        }
        assert_eq!(Identity::from_kept("u").kept().as_deref(), Some("u"));
    }

    #[test]
    fn a_cli_that_can_t_be_found_keeps_the_last_values_shown_as_old() {
        let (_root, home) = temp_home("missing-cli");
        let mut provider = test_provider(&home);
        // none yet: unavailable (not an error, which would hide another PC's sign-in stop)
        let none = provider.collect_with(NOW - 1, true, |_, _, _| {
            (Identity::default(), Err(FetchError::MissingCli))
        });
        assert_eq!(
            (none.status, none.error_code),
            (ProviderStatus::Unavailable, Some(ErrorCode::NotInstalled))
        );
        provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        let missing = provider.collect_with(NOW + 1, true, |_, _, _| {
            (Identity::default(), Err(FetchError::MissingCli))
        });
        assert_eq!(missing.status, ProviderStatus::Stale);
        assert_eq!(missing.error_code, Some(ErrorCode::NotInstalled));
        assert!(!missing.windows.is_empty(), "the last values stay shown");
        // signed out: none shown
        let signed_out = provider.collect_with(NOW + 2, true, |_, _, _| {
            (Identity::default(), Err(FetchError::SignedOut))
        });
        assert!(signed_out.windows.is_empty());
        assert_eq!(signed_out.error_code, Some(ErrorCode::LoginRequired));
    }

    #[test]
    fn forgetting_makes_nothing_on_a_pc_with_no_state_and_reads_an_unreadable_one_again_a_minute_on()
     {
        let (_root, home) = temp_home("forget-none");
        let mut provider = test_provider(&home);
        assert!(provider.forget_cached());
        assert!(
            !home.join("codex-poll.lock").exists(),
            "not even the lock is made"
        );
        fs::create_dir_all(home.join(STATE_FILE)).unwrap();
        provider.clock = Some(|| NOW);
        assert!(!provider.forget_cached());
        assert_eq!(provider.state_retry_at(), Some(NOW + MINUTE_MS));
        assert_eq!(
            provider.next_due_ms(NOW),
            NOW + MINUTE_MS,
            "nothing due before"
        );
        assert!(
            provider.fetch_due_ms(NOW) >= NOW + MINUTE_MS,
            "no fetch either"
        );

        // a value cached before epochs were kept (of none): forgotten, as one of another epoch
        let (_root, home) = temp_home("forget-no-epoch");
        let mut provider = test_provider(&home);
        provider.collect_with(NOW, true, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        let path = home.join(STATE_FILE);
        let mut state = load_state(&path).unwrap();
        state.last_ok.as_mut().unwrap().epoch = None;
        write_json_atomic(&path, &state).unwrap();
        assert!(provider.forget_cached());
        assert!(load_state(&path).unwrap().last_ok.is_none());
    }

    #[test]
    fn a_workspace_change_drops_the_new_observation_before_it_can_be_returned() {
        let (_root, home) = temp_home("workspace");
        let mut provider = test_provider(&home);
        let identity = |workspace| Identity {
            user_hash: Some("same-user-hash".into()),
            workspace_hash: Some(workspace),
        };
        provider.collect_with(NOW, true, |_, _, _| {
            (identity("first".into()), Ok(observation()))
        });
        let switched = provider.collect_with(NOW + 1, true, |_, _, _| {
            (identity("second".into()), Ok(observation()))
        });
        assert_eq!(switched.error_code, Some(ErrorCode::AccountChanged));
        assert!(switched.windows.is_empty());
        let prior = provider.pending_switch().unwrap();
        authorize_switch(&mut provider);
        provider.collect_with(NOW + 1, false, |_, _, q| successful_rpc(q, &mut Vec::new()));
        assert_eq!(provider.account_accepted(), Some(false));
        assert_eq!(provider.take_run(), Some(Run::Ran(Outcome::Failed)));
        assert_ne!(test_provider(&home).pending_switch().unwrap(), prior);
        provider.accept_target(Some(prior));
        provider.accept_account();
        provider.grant(Some(grant_until(i64::MAX)));
        provider.collect_with(NOW + 1, false, |_, _, _| panic!("superseded acceptance"));
        assert_eq!(provider.take_run(), Some(Run::NotRun));
        assert_eq!(provider.account_accepted(), Some(false));
    }
}
