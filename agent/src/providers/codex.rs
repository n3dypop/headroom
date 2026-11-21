//! Converts usage limits from the official Codex App Server to schema v2.

mod rpc;

use std::collections::BTreeSet;
use std::fs::{self, OpenOptions, TryLockError};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};

use super::Provider;
use super::claude::resolve_bin;
use crate::config::CodexConfig;
use crate::push::{EpochRead, clock_epoch};
use crate::schema::{
    ErrorCode, ProviderSnapshot, ProviderStatus, UsageWindow, make_window, window_id_from_seconds,
};
use crate::store::{Logger, backoff_ms, fnv1a_hex, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms, now_ms};

const STATE_FILE: &str = "state-codex.json";
const MIN_INTERVAL_MS: i64 = 5 * MINUTE_MS;
const STALE_AFTER_MS: i64 = 15 * MINUTE_MS;
const LOCK_RETRY_MS: i64 = 30_000;
const BLOCKED_RULE_VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
enum FetchError {
    MissingCli,
    SignedOut,
    WrongAuth,
    AccountChanged,
    AccountIdentityUnknown,
    Start,
    Timeout,
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
            Self::AccountIdentityUnknown => {
                "Cannot resume fetching because the Codex account identity is unavailable"
            }
            Self::Start => "Could not start Codex App Server",
            Self::Timeout => "Timed out waiting for a response from Codex App Server",
            Self::Disconnected => "Lost the connection to Codex App Server",
            Self::Protocol => "Could not interpret the Codex App Server response",
            Self::Unsupported => {
                "The Codex CLI does not support the required RPC (update the standalone CLI)"
            }
            Self::Remote => "Codex App Server failed to fetch usage limits",
            Self::StateIo => "Could not save or lock the Codex fetch state",
            Self::StateUnreadable => {
                "Fetching paused because the Codex fetch state is unreadable (check permissions on state-codex.json and run headroom collect --provider codex --accept-account to resume)"
            }
        }
    }

    fn unavailable(self) -> bool {
        matches!(self, Self::MissingCli | Self::SignedOut | Self::WrongAuth)
    }

    fn code(self) -> ErrorCode {
        match self {
            Self::MissingCli => ErrorCode::NotInstalled,
            Self::SignedOut | Self::WrongAuth => ErrorCode::LoginRequired,
            Self::AccountChanged => ErrorCode::AccountChanged,
            _ => ErrorCode::FetchFailed,
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct State {
    last_attempt_ms: Option<i64>,
    #[serde(default)]
    failures: u32,
    last_error: Option<FetchError>,
    #[serde(default, deserialize_with = "read_observation")]
    last_ok: Option<Observation>,
    identity: Identity,
    #[serde(default)]
    account_changed: bool,
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

#[derive(Serialize, Deserialize)]
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

#[derive(Serialize, Deserialize, Default)]
struct Identity {
    user_hash: Option<String>,
    workspace_hash: Option<String>,
}

impl Identity {
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

    fn stop_reason(&self) -> Option<FetchError> {
        self.account_changed.then_some(match self.last_error {
            Some(FetchError::StateUnreadable) => FetchError::StateUnreadable,
            _ => FetchError::AccountChanged,
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
        self.last_attempt_ms.is_some_and(|t| t > now) || self.future_observation(now, epoch)
    }

    fn due_ms(&self, now: i64, interval: i64, epoch: Option<u64>) -> i64 {
        let delay = backoff_ms(interval, self.failures).max(interval);
        let attempt = if self.needs_clock_repair(now, epoch) {
            Some(now)
        } else {
            self.last_attempt_ms
        };
        match attempt {
            Some(last) => {
                let normal = last.saturating_add(delay);
                self.observation(epoch)
                    .filter(|o| o.fetched_ms <= now)
                    .and_then(|observation| observation.snapshot.blocked_until_ms(last))
                    .map_or(normal, |blocked_until| normal.max(blocked_until))
            }
            None => now,
        }
    }

    fn snapshot(
        &self,
        now: i64,
        error: Option<FetchError>,
        epoch: Option<u64>,
    ) -> ProviderSnapshot {
        let error = error.or(self.last_error);
        let mut snapshot = if let Some(reason) = self.stop_reason() {
            ProviderSnapshot::empty(
                ProviderStatus::Unavailable,
                reason.message(),
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
                    Some("Codex usage limits have not been updated for over 15 minutes".into());
            }
            snapshot
        } else {
            ProviderSnapshot::empty(
                ProviderStatus::Error,
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
    pub failures: u32,
    pub last_error: &'static str,
    /// Why no fetch is scheduled, when the reason is absent from the agent schedule.
    pub not_scheduled: Option<&'static str>,
}

pub struct CodexProvider {
    home: PathBuf,
    cfg: CodexConfig,
    log: Logger,
    clock: Option<fn() -> i64>,
    state: State,
    last_collect_ms: i64,
    retry_at: Option<i64>,
    fetch_hold_until_ms: i64,
    accept_account_requested: bool,
    unsaved_account_stop: bool,
}

impl CodexProvider {
    pub fn new(home: &Path, cfg: CodexConfig, log: Logger) -> Self {
        Self {
            home: home.to_path_buf(),
            cfg,
            log,
            clock: Some(crate::time::now_ms),
            state: load_state(&home.join(STATE_FILE))
                .unwrap_or_else(|_| State::recovery_required()),
            last_collect_ms: i64::MIN,
            // Include cached data in the daemon's first snapshot. Check whether the RPC is due under the lock.
            retry_at: Some(i64::MIN),
            fetch_hold_until_ms: i64::MIN,
            accept_account_requested: false,
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

    fn state_error(&mut self, now: i64) -> ProviderSnapshot {
        self.retry_at = Some(now.saturating_add(self.interval_ms()));
        self.log.log(FetchError::StateIo.message());
        self.snapshot(now, Some(FetchError::StateIo))
    }

    fn state_read_error(&mut self, now: i64) -> ProviderSnapshot {
        self.retry_at = Some(now.saturating_add(self.interval_ms()));
        // Leave the file untouched after a permissions or I/O error and withhold current values until it is resolved.
        State::recovery_required().snapshot(now, None, None)
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
        Ok(lock)
    }

    fn collect_with(
        &mut self,
        now: i64,
        force: bool,
        fetch: impl FnOnce(&Path, &Path, &Identity) -> (Identity, Result<Observation, FetchError>),
    ) -> ProviderSnapshot {
        let accept_requested = std::mem::take(&mut self.accept_account_requested);
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
                self.retry_at = Some(now.saturating_add(LOCK_RETRY_MS));
                return self.snapshot(now, None);
            }
            Err(FetchError::StateUnreadable) => return self.state_read_error(now),
            Err(_) => return self.state_error(now),
        };
        self.retry_at = None;
        let epoch = trusted_epoch(&self.home);
        if self.state.needs_clock_repair(now, epoch) {
            self.state.last_attempt_ms = Some(now);
            if self.state.future_observation(now, epoch) {
                self.state.last_ok = None;
            }
            if write_json_atomic(&state_path, &self.state).is_err() {
                return self.state_error(now);
            }
        }
        let accepting = accept_requested && self.state.account_changed;
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
        self.state.last_attempt_ms = Some(now);
        if write_json_atomic(&state_path, &self.state).is_err() {
            return self.state_error(now);
        }

        let empty_identity = Identity::default();
        let expected = if accepting {
            &empty_identity
        } else {
            &self.state.identity
        };
        let (identity, result) = fetch(
            &codex_bin(&self.cfg),
            &self.home.join("codex-cwd"),
            expected,
        );
        if expected.differs_from(&identity) || matches!(result, Err(FetchError::AccountChanged)) {
            self.state.account_changed = true;
            self.state.last_ok = None;
            self.state.last_error = Some(FetchError::AccountChanged);
            self.log.log(FetchError::AccountChanged.message());
            self.unsaved_account_stop = true;
            if write_json_atomic(&state_path, &self.state).is_err() {
                return self.state_error(now);
            }
            self.unsaved_account_stop = false;
            self.retry_at = Some(now.saturating_add(self.interval_ms()));
            return self.snapshot(now, None);
        }
        let result = match result {
            Ok(_) if accepting && identity.user_hash.is_none() => {
                Err(FetchError::AccountIdentityUnknown)
            }
            result => result,
        };
        let previous_accepted_ms = self.state.account_accepted_ms;
        // A new observation is stamped when the RPC completes, after the attempt began.
        let snapshot_ms = result.as_ref().map_or(now, |o| now.max(o.fetched_ms));
        match result {
            Ok(mut observation) => {
                observation.epoch = Some(start_epoch);
                self.state.identity = if accepting {
                    // Use the first new observation's timestamp to keep it within the receiver's history boundary.
                    self.state.account_accepted_ms = Some(observation.fetched_ms);
                    identity
                } else {
                    std::mem::take(&mut self.state.identity).with_observed(identity)
                };
                self.state.account_changed = false;
                self.state.last_ok = Some(observation);
                self.state.failures = 0;
                self.state.last_error = None;
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
                self.log.log(error.message());
            }
        }
        if write_json_atomic(&state_path, &self.state).is_err() {
            if accepting {
                self.state.account_changed = true;
                self.state.account_accepted_ms = previous_accepted_ms;
                self.state.last_ok = None;
            }
            return self.state_error(now);
        }
        self.snapshot(snapshot_ms, None)
    }

    pub(crate) fn status_parts(home: &Path, cfg: &CodexConfig) -> Option<CodexStatus> {
        let path = home.join(STATE_FILE);
        if matches!(path.try_exists(), Ok(false)) {
            return None;
        }
        let state = load_state(&path).unwrap_or_else(|_| State::recovery_required());
        let last_error = state
            .stop_reason()
            .or(state.last_error)
            .map_or("none", FetchError::message);
        let not_scheduled = if state.account_changed {
            Some("waiting for manual resume")
        } else if !cfg.enabled {
            Some("disabled")
        } else {
            None
        };
        Some(CodexStatus {
            failures: state.failures,
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

    fn fetch_due_ms(&self, now: i64) -> i64 {
        if !self.cfg.enabled || self.state.account_changed {
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
        let Ok(Some(_lock)) = self.try_state_lock() else {
            return false;
        };
        let path = self.home.join(STATE_FILE);
        let Ok(saved) = load_state(&path) else {
            return false;
        };
        if !self.unsaved_account_stop {
            self.state = saved;
        }
        if self.state.last_ok.take().is_none() && !self.unsaved_account_stop {
            return true;
        }
        if write_json_atomic(&path, &self.state).is_err() {
            return false;
        }
        self.unsaved_account_stop = false;
        true
    }

    fn accept_account(&mut self) {
        self.accept_account_requested = true;
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
    expected: &Identity,
) -> (Identity, Result<Observation, FetchError>) {
    let mut identity = Identity::default();
    let result = (|| {
        let mut server = rpc::AppServer::start(bin, cwd)?;
        server.request(
            1,
            "initialize",
            json!({"clientInfo":{"name":"headroom","version":env!("CARGO_PKG_VERSION")}}),
        )?;
        server.notify_initialized()?;
        let account = server.request(2, "account/read", json!({"refreshToken":false}))?;
        identity = account_identity(&account)?;
        if expected.differs_from(&identity) {
            return Err(FetchError::AccountChanged);
        }

        let limits = server.request(
            3,
            "account/rateLimits/read",
            json!({"excludeResetCreditDetails":true}),
        )?;
        let fetched_ms = now_ms();
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
            ..CodexProvider::new(home, CodexConfig::default(), Logger::stderr())
        }
    }

    #[test]
    fn a_fetch_keeps_its_starting_epoch_across_rejection_and_recovery() {
        let (_root, home) = temp_home("fetch-epoch");
        let mut provider = test_provider(&home);
        let late = provider.collect_with(NOW, true, |_, _, _| {
            set_epoch(&home, 2, false, None);
            set_epoch(&home, 3, true, None);
            let mut sample = observation();
            sample.snapshot.blocked = Some(true);
            sample.snapshot.windows[0].used_percent = 100.0;
            sample.snapshot.windows[0].resets_at = Some(iso_from_ms(NOW + 60 * MINUTE_MS));
            (Identity::default(), Ok(sample))
        });
        assert!(late.windows.is_empty());
        let saved = load_state(&home.join(STATE_FILE)).unwrap();
        assert_eq!(saved.last_ok.unwrap().epoch, Some(1));
        let mut again = test_provider(&home);
        assert_eq!(again.fetch_due_ms(NOW), NOW + MIN_INTERVAL_MS);
        let cached = again.collect_with(NOW, false, |_, _, _| panic!("early poll"));
        assert!(cached.windows.is_empty());
        let fresh = again.collect_with(NOW + MIN_INTERVAL_MS, false, |_, _, _| {
            let sample = observation_at(NOW + MIN_INTERVAL_MS);
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

        daemon.collect_with(due, false, |_, _, _| {
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
            assert_eq!(second.next_due_ms(NOW), NOW + LOCK_RETRY_MS);
            (Identity::default(), Ok(observation()))
        });
        let result = second.collect_with(NOW + LOCK_RETRY_MS, false, |_, _, _| {
            panic!("uses committed first result")
        });
        assert_eq!(result.status, ProviderStatus::Ok);
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
        let switched = provider.collect_with(NOW + 1, true, |_, _, expected| {
            let new = identity("synthetic-second");
            assert!(expected.differs_from(&new));
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
        restarted.accept_account();
        let failed = restarted.collect_with(NOW + 3, false, |_, _, _| {
            (identity("synthetic-second"), Err(FetchError::Remote))
        });
        assert_eq!(failed.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(failed.history_since, None);
        restarted.accept_account();
        let unknown = restarted.collect_with(NOW + 4, false, |_, _, _| {
            (Identity::default(), Ok(observation()))
        });
        assert_eq!(unknown.error_code, Some(ErrorCode::AccountChanged));
        assert_eq!(unknown.history_since, None);
        restarted.accept_account();
        let accepted_ms = NOW + 6;
        let boundary = Some(iso_from_ms(accepted_ms));
        let accepted = restarted.collect_with(NOW + 5, false, |_, _, expected| {
            let new = identity("synthetic-second");
            assert!(!expected.differs_from(&new));
            let mut fresh = observation();
            fresh.fetched_ms = accepted_ms;
            fresh.snapshot.fetched_at = boundary.clone();
            fresh.snapshot.windows[0].fetched_at = boundary.clone();
            (new, Ok(fresh))
        });
        assert_eq!(accepted.status, ProviderStatus::Ok);
        assert_eq!(accepted.history_since, boundary);
        assert_eq!(accepted.windows[0].fetched_at, boundary);
        assert_eq!(
            load_state(&home.join(STATE_FILE))
                .unwrap()
                .account_accepted_ms,
            Some(accepted_ms)
        );

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
        let status = CodexProvider::status_parts(&home, &CodexConfig::default()).unwrap();
        assert!(status.last_error.contains("--accept-account"));
        assert_eq!(status.not_scheduled, Some("waiting for manual resume"));

        provider.accept_account();
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

        restarted.accept_account();
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
    }
}
