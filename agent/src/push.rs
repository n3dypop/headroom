//! Pushing to the destination, with retries. Only the background agent (`headroom agent`) pushes.
//!
//! - Observations: one per change of a provider window's `fetched_at` (sent even if the value is unchanged). Providers in `account_changed` are not sent.
//! - Account switches: unsent observations of a provider that became `account_changed` are dropped. On first seeing a new `history_since`
//!   (switch accepted), all observations queued so far for that provider are dropped regardless of their time (so the previous
//!   account's values are never sent, even if the switch and acceptance happened during an outage or after a clock fix).
//! - Unsent observations are queued in `~/.headroom/outbox.json` (up to 24 hours / 5,000 entries) and removed once sent.
//! - The send sequence number `seq` comes from `next_send_seq()`. The destination replaces each PC's latest value by this number.
//! - On failure, wait from 1 minute, doubling up to 60 minutes. Observations in a request whose body is rejected (400, 413) are dropped (so the same body is not sent forever).
//! - Only what the destination stores leaves the PC: the snapshot goes through `Snapshot::for_upload` (windows with unknown names
//!   are dropped, labels and scopes are rebuilt from known names, error text is fixed) and observations of such windows are not queued.
//! - Credentials are read from the OS credential store and never written to logs or files.
//! - Redirects (3xx) are not followed; following them could send the credential header to another host.
//! - 409 (observations stored, but `seq` was not above the stored one, so the latest value was not replaced) is not a success. Resend once
//!   with a number above the stored `seq` from the reply (so the latest value arrives even after losing local state or fixing the clock).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;

pub use crate::clock::{
    CLOCK_LOCK_FILE, ClockEpoch, EpochRead, clock_epoch, hold_clock_lock, usable_epoch,
};
use crate::clock::{advance_locked, ensure_locked, save_locked, try_clock_lock};
use crate::config::{Config, explicit_collector_id};
use crate::providers::claude::STALE_AFTER_MS;
use crate::schedule::{TurnAsker, TurnReply};
use crate::schema::{
    ErrorCode, ProviderSnapshot, ProviderStatus, Snapshot, is_collision_id, sendable_scope,
};
use crate::store::{Logger, backoff_ms, next_send_seq, read_json, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms};

pub const OUTBOX_FILE: &str = "outbox.json";
/// Protocol of this agent's writes (header Headroom-Protocol). A Worker of a later protocol refuses it with 426
const AGENT_PROTOCOL: &str = "2";
/// Outbox format. 1: queued observations of collision ids are known to be windows that are sent. 2: each queued observation carries
/// the clock epoch it was taken in (one without is never sent)
const OUTBOX_VERSION: u32 = 2;
const KEEP_MS: i64 = 24 * 60 * MINUTE_MS;
/// A day of observations is 2 providers × 3 windows × 288 fetches ≈ 1,700. Up to 5,000 for headroom
const MAX_QUEUED: usize = 5_000;
/// Max observations per request (200, same as the destination's limit; bounds D1 writes per request)
const MAX_PER_REQUEST: usize = 200;
const RETRY_BASE_MS: i64 = MINUTE_MS;
/// Minimum send interval. Even with a burst of statusLine updates, keep Worker requests (and the D1 reads/writes for storing and replacing the latest value) to once per minute
const MIN_SEND_INTERVAL_MS: i64 = MINUTE_MS;
/// Minimum interval between observations of the same window. No observation per statusLine update (bounds D1 writes; rate and forecast depend on the endpoints)
const MIN_OBSERVATION_INTERVAL_MS: i64 = MINUTE_MS;
/// Even with nothing to send, resend the latest value (no observations) this long after the last success. The destination uses the receive time as the PC's liveness signal.
/// This keeps the 30-minute stopped check from firing while no fetch happens for up to 60 minutes during a reached limit
const LIVENESS_INTERVAL_MS: i64 = 15 * MINUTE_MS;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/** The reply body is only read for the 409 `seq`, so longer bodies are not read */
const MAX_REPLY_BYTES: u64 = 4096;
/// Names in the credential store (Windows Credential Manager / Mac Keychain)
pub const CREDENTIAL_SERVICE: &str = "headroom";
pub const CREDENTIAL_USER: &str = "push";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Observation {
    pub provider: String,
    pub window_id: String,
    pub resets_at: Option<String>,
    pub used_percent: f64,
    pub observed_at: String,
    /// Clock epoch it was taken in (this PC only; not sent). Sent only while that epoch is current and trusted
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
}

/// An observation as sent (without what stays on this PC)
#[derive(Serialize)]
struct SentObservation<'a> {
    provider: &'a str,
    window_id: &'a str,
    resets_at: &'a Option<String>,
    used_percent: f64,
    observed_at: &'a str,
}

/// How a send ended, for the clock state
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SendOutcome {
    /// The destination answered without refusing the clock, or the request never reached it
    Cleared,
    /// A send that only checked the clock went through: trusted again, under a new epoch
    Lifted,
    /// Refused the clock, or the answer was lost (it may have refused): a new epoch, not trusted until a check goes through
    Refused,
}

/// Whether an earlier version's push state says the destination refused the clock (Err when it exists but can't be read)
fn refused_before(home: &Path) -> Result<bool, String> {
    let path = home.join(OUTBOX_FILE);
    match Outbox::read(&path) {
        Some(o) => Ok(o.clock_skewed),
        None => match std::fs::metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            _ => Err("The push state can't be read".into()),
        },
    }
}

/// A provider's value with nothing of it trusted (as strip_untrusted leaves it under a refused clock)
pub fn held(p: ProviderSnapshot) -> ProviderSnapshot {
    let mut one = BTreeMap::from([(String::new(), p)]);
    strip_untrusted(&mut one, true, None, &Marks::default(), 0);
    one.remove("")
        .unwrap_or_else(|| ProviderSnapshot::empty(ProviderStatus::Stale, "", None))
}

/// Makes sure the clock state exists (first start, or one broken), under the clock lock
pub fn ensure_clock(home: &Path) -> Result<ClockEpoch, String> {
    let _lock = hold_clock_lock(home)?;
    ensure_locked(home, || refused_before(home))
}

/// Without a destination (pushing isn't set up) nothing refuses the clock: a state left refused, or with a send pending, by earlier
/// pushing becomes trusted under a new epoch (its values aren't used)
pub fn trust_without_push(home: &Path) -> Result<ClockEpoch, String> {
    trust_without_push_as(home, false)
}

/// trust_without_push for the background agent (holding the agent lock: no send of its own is under way). A send an earlier run left
/// pending is resolved too: under a new epoch, so nothing taken in the pending one is used
pub fn trust_without_push_as_agent(home: &Path) -> Result<ClockEpoch, String> {
    trust_without_push_as(home, true)
}

fn trust_without_push_as(home: &Path, agent: bool) -> Result<ClockEpoch, String> {
    let _lock = hold_clock_lock(home)?;
    let state = ensure_locked(home, || Ok(false))?;
    if state.trusted && state.in_flight.is_none() {
        return Ok(state);
    }
    // A send left pending (by an agent started while pushing was set up) is the agent's to resolve: nothing is trusted meanwhile
    if state.in_flight.is_some() && !agent {
        return Err("A send's result is pending; the background agent resolves it".into());
    }
    advance_locked(home, &state, true)
}

/// (`provider.window_id`, fetch time) of every window, and (`provider`, fetch time) of each provider's own fetch (its limit flag
/// can come without windows)
fn fetch_stamps(providers: &BTreeMap<String, ProviderSnapshot>) -> Vec<(String, String)> {
    providers
        .iter()
        .flat_map(|(p, s)| {
            s.windows
                .iter()
                .filter_map(move |w| Some((format!("{p}.{}", w.id), w.fetched_at.clone()?)))
                .chain(s.fetched_at.clone().map(|t| (p.clone(), t)))
        })
        .collect()
}

/// Marks kept per window (or provider). Only what a provider still caches can come back (one value per window, Claude one from
/// /usage and one from statusLine), and a mark is seen again on every send while it is cached, so the most recently seen few are the
/// ones that matter; a clock refused for weeks doesn't grow the file
const MARKS_PER_KEY: usize = 8;

/// Fetches stamped by a clock that can't be trusted (`provider.window_id` or `provider`, and the fetch time), each with when it was last
/// seen (a counter). Such a fetch is never sent nor shown, however old: it is dropped only when newer marks of its window push it out
#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
#[serde(default)]
pub struct Marks {
    /// "<key> <fetch time>" -> last seen
    pub seen: BTreeMap<String, u64>,
    pub clock: u64,
}

impl Marks {
    fn id(key: &str, at: &str) -> String {
        format!("{key} {at}")
    }

    pub fn contains(&self, key: &str, at: &str) -> bool {
        self.seen.contains_key(&Self::id(key, at))
    }

    /// Marks these fetches (or marks them seen again). true if any was new
    fn note(&mut self, stamps: &[(String, String)]) -> bool {
        if stamps.is_empty() {
            return false;
        }
        self.clock += 1;
        let mut added = false;
        for (key, at) in stamps {
            added |= self.seen.insert(Self::id(key, at), self.clock).is_none();
        }
        self.cap();
        added
    }

    /// Marks seen again: those among these fetches that are marked already
    fn touch(&mut self, stamps: &[(String, String)]) {
        let known: Vec<String> = stamps
            .iter()
            .map(|(k, a)| Self::id(k, a))
            .filter(|id| self.seen.contains_key(id))
            .collect();
        if known.is_empty() {
            return;
        }
        self.clock += 1;
        for id in known {
            self.seen.insert(id, self.clock);
        }
    }

    /// Per key, the `MARKS_PER_KEY` most recently seen stay (ties: the later fetch)
    fn cap(&mut self) {
        let mut by_key: BTreeMap<String, Vec<(u64, String)>> = BTreeMap::new();
        for (id, seen) in &self.seen {
            let key = id.split(' ').next().unwrap_or_default().to_string();
            by_key.entry(key).or_default().push((*seen, id.clone()));
        }
        for (_, mut list) in by_key {
            if list.len() <= MARKS_PER_KEY {
                continue;
            }
            list.sort_by(|a, b| b.cmp(a));
            for (_, id) in list.into_iter().skip(MARKS_PER_KEY) {
                self.seen.remove(&id);
            }
        }
    }
}

/// Removes what a clock the destination refused (or one that has gone back) stamped, as of `at`: windows marked, stamped at or before
/// `distrust` or after `at`, and every window while the clock is refused. A provider with any window removed, or whose own fetch can't be
/// trusted, loses its limit flag (a flag without windows still counts as a current value at the destination); its fetch time becomes
/// the oldest remaining window's, and a staleness that only came from a removed window goes with it
fn strip_untrusted(
    providers: &mut BTreeMap<String, ProviderSnapshot>,
    skewed: bool,
    distrust: Option<i64>,
    marks: &Marks,
    at: i64,
) {
    let in_time =
        |t: &str| parse_ms(t).is_some_and(|ms| ms <= at && distrust.is_none_or(|d| ms > d));
    let trusted = |key: &str, t: &str| in_time(t) && !marks.contains(key, t);
    for (provider, p) in providers.iter_mut() {
        let windows = p.windows.len();
        p.windows.retain(|w| {
            !skewed
                && w.fetched_at
                    .as_deref()
                    .is_some_and(|t| trusted(&format!("{provider}.{}", w.id), t))
        });
        let removed = p.windows.len() != windows;
        let own = !skewed
            && p.fetched_at
                .as_deref()
                .is_some_and(|t| trusted(provider, t));
        if skewed || removed || !own {
            p.blocked = None;
        }
        // No window was held back, but the provider's own fetch (its only basis, e.g. a limit flag without windows) can't be trusted
        if !removed && p.windows.is_empty() && !own && p.fetched_at.is_some() {
            p.fetched_at = None;
            held_back(p);
            continue;
        }
        if !removed {
            continue;
        }
        match p.windows.iter().filter_map(|w| w.fetched_at.clone()).min() {
            Some(oldest) => {
                p.fetched_at = Some(oldest.clone());
                // Staleness by age (no error code) is judged again from what is left
                if p.status == ProviderStatus::Stale && p.error_code.is_none() {
                    let age = parse_ms(&oldest).map_or(i64::MAX, |t| at - t);
                    if age <= STALE_AFTER_MS {
                        p.status = ProviderStatus::Ok;
                        p.error = None;
                    } else {
                        p.error = Some(format!("Not updated for {}m", age / MINUTE_MS));
                    }
                }
            }
            None => {
                p.fetched_at = None;
                held_back(p);
            }
        }
    }
}

/// A provider with nothing left to trust: not "ok", and said so (a fetch error's own diagnosis is kept), until the next fetch
fn held_back(p: &mut ProviderSnapshot) {
    if p.status == ProviderStatus::Ok {
        p.status = ProviderStatus::Stale;
    }
    if p.error_code.is_none() {
        p.status = ProviderStatus::Stale;
        p.error = Some("Values held back until the next fetch (the clock was off)".into());
    }
}

/// The marks as stored by any version: today's form, or earlier ones (a list of [key, time] pairs, or key -> time)
fn marks_any<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Marks, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Any {
        PerKey(BTreeMap<String, String>),
        Now(Marks),
        Pairs(Vec<(String, String)>),
    }
    Ok(match Any::deserialize(d)? {
        Any::Now(m) => m,
        Any::Pairs(pairs) => {
            let mut m = Marks::default();
            m.note(&pairs);
            m
        }
        Any::PerKey(map) => {
            let mut m = Marks::default();
            m.note(&map.into_iter().collect::<Vec<_>>());
            m
        }
    })
}

/// This PC's latest values as they may be shown here (`headroom status`, `collect`): what the destination would refuse or this PC
/// holds back is left out, by the marks in the push state. Only while pushing is set up (a push state left from before pushing was
/// turned off says nothing about values fetched since); otherwise as they are
pub fn trusted_local(
    home: &Path,
    latest: &BTreeMap<String, ProviderSnapshot>,
    now: i64,
    pushing: bool,
) -> BTreeMap<String, ProviderSnapshot> {
    trusted_local_at(home, latest, now, pushing, usable_epoch(home).is_some())
}

/// trusted_local under a decision about the clock already made (usable: the clock is trusted for these values), so what is shown
/// and what is saved follow the same read of the clock
pub fn trusted_local_at(
    home: &Path,
    latest: &BTreeMap<String, ProviderSnapshot>,
    now: i64,
    pushing: bool,
    usable: bool,
) -> BTreeMap<String, ProviderSnapshot> {
    let mut shown = latest.clone();
    // Nothing is shown unless the clock is trusted (refused, a send's result pending, or a state that can't be read)
    let outbox = if pushing {
        Outbox::read(&home.join(OUTBOX_FILE))
    } else {
        None
    };
    match outbox {
        Some(o) => strip_untrusted(
            &mut shown,
            !usable,
            o.distrust_until_ms,
            &o.future_stamps,
            now,
        ),
        // A push state that exists but can't be read holds the marks: nothing is shown until it can be
        None if pushing
            && !matches!(std::fs::metadata(home.join(OUTBOX_FILE)), Err(e) if e.kind() == std::io::ErrorKind::NotFound) =>
        {
            strip_untrusted(&mut shown, true, None, &Marks::default(), now)
        }
        None => strip_untrusted(&mut shown, !usable, None, &Marks::default(), now),
    }
    shown
}

/// Push state. Only observations, times and counts go to the file (no credentials, no reply bodies)
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
pub struct Outbox {
    pub last_seq: Option<i64>,
    /// `provider.window_id` → the `fetched_at` last recorded as an observation
    pub last_observed: BTreeMap<String, String>,
    pub observations: Vec<Observation>,
    pub failures: u32,
    pub last_attempt_ms: Option<i64>,
    pub last_success_ms: Option<i64>,
    /// Earliest next send time given by the destination (UTC midnight when the daily D1 budget is used up)
    #[serde(default)]
    pub retry_at_ms: Option<i64>,
    /// Last result (a fixed message)
    pub last_result: Option<String>,
    /// provider → last seen `history_since`. When it changes, the observations queued so far belong to the previous account
    pub history_since: BTreeMap<String, String>,
    /// Format version (`OUTBOX_VERSION`; 0 for a file written by an older version)
    pub version: u32,
    /// Written by earlier versions: the destination refused the clock. Read only by the first start of the clock state (clock.rs)
    pub clock_skewed: bool,
    /// The destination answered 426 to this protocol (the agent must be updated): nothing is sent or fetched until the agent writes another
    #[serde(default)]
    pub outdated_protocol: Option<String>,
    /// Values stamped at or before this time (ms) are not sent: they were stamped by a clock the destination refused (everything
    /// before the first send accepted after the refusal). Kept across restarts, so values a provider restores from its cache can't
    /// pass either
    pub distrust_until_ms: Option<i64>,
    /// Fetches stamped by a clock that can't be trusted: found ahead of the send time (the clock has since gone back), or seen while (or
    /// carried by a send) the destination refused the clock. Such a fetch is never sent, also once the time has caught up with it (a
    /// provider keeps handing back the same cached value). Kept by when each was last seen (see `Marks`); earlier forms are read too
    #[serde(deserialize_with = "marks_any")]
    pub future_stamps: Marks,
}

impl Outbox {
    /// The outbox this version starts without a file (its own queue is never taken for an older one; the clock state lives in
    /// clock-epoch.json)
    fn empty() -> Self {
        Self {
            version: OUTBOX_VERSION,
            ..Self::default()
        }
    }

    /// Reads the outbox, or an empty one without a readable file
    #[cfg(test)]
    fn load(path: &Path) -> Self {
        Self::read(path).unwrap_or_else(Self::empty)
    }

    /// Reads the outbox as it will be sent (None if there is none). Observations an older version queued under a collision id may be
    /// of an unknown group (and once the window is gone from the current values, nothing tells them apart), so they are dropped. Also used by `headroom status`, so the count matches the queue
    fn read(path: &Path) -> Option<Self> {
        let mut outbox: Self = read_json(path)?;
        if outbox.version < 1 {
            outbox
                .observations
                .retain(|o| !is_collision_id(&o.window_id));
        }
        outbox.version = outbox.version.max(OUTBOX_VERSION);
        Some(outbox)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credentials {
    /// Worker token (Authorization: Bearer). Access fields saved by older versions are ignored
    pub token: String,
}

pub trait CredentialStore {
    fn load(&self) -> Result<Credentials, String>;
}

/// Stored as a single JSON entry in the OS credential store
pub struct OsCredentialStore;

impl OsCredentialStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(CREDENTIAL_SERVICE, CREDENTIAL_USER)
            .map_err(|_| "Cannot open the credential store".to_string())
    }

    pub fn save(c: &Credentials) -> Result<(), String> {
        let text =
            serde_json::to_string(c).map_err(|_| "Cannot save the credentials".to_string())?;
        Self::entry()?
            .set_password(&text)
            .map_err(|_| "Cannot save the credentials".to_string())
    }

    pub fn clear() -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Cannot delete the credentials".into()),
        }
    }
}

impl CredentialStore for OsCredentialStore {
    fn load(&self) -> Result<Credentials, String> {
        match Self::entry()?.get_password() {
            Ok(text) => serde_json::from_str(&text).map_err(|_| {
                "Invalid credential format (set them again with headroom credentials set)".into()
            }),
            Err(keyring::Error::NoEntry) => {
                Err("No credentials (set them with headroom credentials set)".into())
            }
            Err(_) => Err("Cannot read the credential store".into()),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    /// The answer wasn't received (a timeout, a broken connection): the destination may have handled the request
    Network,
    /// The request never reached the destination (the host wasn't found, the connection couldn't be made)
    NotSent,
}

pub trait Transport {
    /// PUTs and returns the HTTP status code and the reply body (short ones only; empty if unreadable)
    fn put(
        &mut self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<(u16, String), SendError>;

    /// POST (asks for the fetch turn; schedule.rs). Defaults to unreachable (if it cannot ask, this PC fetches itself)
    fn post(
        &mut self,
        _url: &str,
        _headers: &[(&str, &str)],
        _body: &str,
    ) -> Result<(u16, String), SendError> {
        Err(SendError::Network)
    }
}

pub struct HttpTransport {
    agent: ureq::Agent,
}

impl HttpTransport {
    pub fn new() -> Self {
        use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
        // Use the OS TLS and certificate store (Windows: SChannel, Mac: Security.framework). No C build is needed,
        // and it works as is where corporate certificates are installed in the OS
        let tls = TlsConfig::builder()
            .provider(TlsProvider::NativeTls)
            .root_certs(RootCerts::PlatformVerifier)
            .build();
        let agent = ureq::Agent::config_builder()
            .tls_config(tls)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .http_status_as_error(false)
            // Do not follow redirects; return 3xx as is (never send credentials to the redirect target)
            .max_redirects(0)
            // workers.dev cannot turn off Browser Integrity Check, which may block the library's default User-Agent with 1010, so identify ourselves
            .user_agent(concat!("headroom-agent/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Self { agent }
    }
}

impl Default for HttpTransport {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpTransport {
    fn send(
        &mut self,
        mut req: ureq::RequestBuilder<ureq::typestate::WithBody>,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<(u16, String), SendError> {
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let mut res = req
            .content_type("application/json")
            .send(body)
            .map_err(|e| match e {
                ureq::Error::HostNotFound
                | ureq::Error::ConnectionFailed
                | ureq::Error::Timeout(ureq::Timeout::Resolve | ureq::Timeout::Connect) => {
                    SendError::NotSent
                }
                _ => SendError::Network,
            })?;
        let text = res
            .body_mut()
            .with_config()
            .limit(MAX_REPLY_BYTES)
            .read_to_string()
            .unwrap_or_default();
        Ok((res.status().as_u16(), text))
    }
}

impl Transport for HttpTransport {
    fn put(
        &mut self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<(u16, String), SendError> {
        let req = self.agent.put(url);
        self.send(req, headers, body)
    }

    fn post(
        &mut self,
        url: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Result<(u16, String), SendError> {
        let req = self.agent.post(url);
        self.send(req, headers, body)
    }
}

/// Validates `[push] url`: https, or a loopback address for testing (http://127.0.0.1, localhost, [::1] with a port) only.
/// Checks scheme and authority separately rather than by string prefix, and rejects userinfo (`user@host`), query and fragment
pub fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim().trim_end_matches('/');
    let err = || {
        "[push] url must be a destination URL starting with https:// (for testing, http://127.0.0.1:<port>)"
            .to_string()
    };
    if url.contains(['?', '#', '@', '\\', ' ']) || url.chars().any(char::is_control) {
        return Err(err());
    }
    let (https, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(err());
    };
    let authority = rest.split('/').next().unwrap_or_default();
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            (h, Some(p))
        }
        Some((h, _)) if !h.ends_with(']') => return Err(err()),
        _ => (authority, None),
    };
    let host_ok = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'));
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "[::1]");
    if host_ok && (https || (loopback && port.is_some())) {
        Ok(url.to_string())
    } else {
        Err(err())
    }
}

pub struct Pusher {
    /// Reads the OS clock for the send time (None in tests: the loop's time plus the wait)
    clock: Option<fn() -> i64>,
    home: PathBuf,
    endpoint: String,
    log: Logger,
    transport: Box<dyn Transport>,
    credentials: Box<dyn CredentialStore>,
    pub outbox: Outbox,
    /// The latest value changed since the last send (also sent once right after startup)
    dirty: bool,
    /// A send's result whose save failed (saved before anything more is sent)
    unsettled: Option<(u64, SendOutcome)>,
    /// outbox.json exists but couldn't be read: it is neither replaced nor sent from until it can be (its send number and marks
    /// would be lost)
    outbox_unreadable: bool,
}

impl Pusher {
    /// Builds from config. None if `[push] url` is empty (no push). Returns the reason if the config is invalid
    pub fn from_config(home: &Path, cfg: &Config, log: Logger) -> Result<Option<Self>, String> {
        if cfg.push.url.trim().is_empty() {
            return Ok(None);
        }
        let base = validate_url(&cfg.push.url)?;
        let collector = explicit_collector_id(cfg).ok_or(
            "To push, set collector_id in config.toml (lowercase letters, digits, -, up to 32 chars)",
        )?;
        let mut pusher = Self::new(
            home,
            &format!("{base}/v2/snapshots/{collector}"),
            log,
            Box::new(HttpTransport::new()),
            Box::new(OsCredentialStore),
        );
        pusher.clock = Some(crate::time::now_ms);
        Ok(Some(pusher))
    }

    pub fn new(
        home: &Path,
        endpoint: &str,
        log: Logger,
        transport: Box<dyn Transport>,
        credentials: Box<dyn CredentialStore>,
    ) -> Self {
        // One read decides both what the outbox holds and whether it was read (a second read could succeed where the first failed,
        // leaving an empty outbox taken for the saved one)
        let path = home.join(OUTBOX_FILE);
        let read = Outbox::read(&path);
        let unreadable = read.is_none()
            && !matches!(std::fs::metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
        Self {
            clock: None,
            home: home.to_path_buf(),
            endpoint: endpoint.to_string(),
            log,
            transport,
            credentials,
            outbox: read.unwrap_or_else(Outbox::empty),
            outbox_unreadable: unreadable,
            dirty: true,
            unsettled: None,
        }
    }

    /// Extracts new observations from the latest values and queues them. If the latest value changed, it is sent next
    pub fn record(&mut self, latest: &BTreeMap<String, ProviderSnapshot>, changed: bool, now: i64) {
        self.dirty |= changed;
        if !self.readable() {
            return;
        }
        let epoch = usable_epoch(&self.home);
        // Save when the contents change even if the count is the same (one dropped and one added)
        let mut modified = false;
        for (provider, snap) in latest {
            let accepted = snap
                .history_since
                .as_ref()
                .filter(|s| self.outbox.history_since.get(provider) != Some(*s));
            if snap.error_code == Some(ErrorCode::AccountChanged) || accepted.is_some() {
                let before = self.outbox.observations.len();
                self.outbox.observations.retain(|o| &o.provider != provider);
                modified |= self.outbox.observations.len() != before;
            }
            if let Some(since) = accepted {
                self.outbox
                    .history_since
                    .insert(provider.clone(), since.clone());
                modified = true;
            }
            // Nothing is queued unless the clock is trusted now (stamped by a refused clock, it would pass once the clock is fixed); each
            // such fetch is remembered instead, so it isn't sent later either
            if epoch.is_none() {
                modified |= self
                    .outbox
                    .future_stamps
                    .note(&fetch_stamps(&BTreeMap::from([(
                        provider.clone(),
                        snap.clone(),
                    )])));
                continue;
            }
            if snap.error_code == Some(ErrorCode::AccountChanged) {
                continue;
            }
            for w in snap.windows.iter().filter_map(|w| w.for_upload()) {
                let Some(at) = &w.fetched_at else { continue };
                let key = format!("{provider}.{}", w.id);
                let last = self.outbox.last_observed.get(&key);
                if last == Some(at) {
                    continue;
                }
                // Skip if less than 1 minute since the previous observation (record it if the fetch time went backwards)
                let elapsed = last.and_then(|l| Some(parse_ms(at)? - parse_ms(l)?));
                if elapsed.is_some_and(|e| (0..MIN_OBSERVATION_INTERVAL_MS).contains(&e)) {
                    continue;
                }
                self.outbox.last_observed.insert(key, at.clone());
                modified = true;
                self.outbox.observations.push(Observation {
                    provider: provider.clone(),
                    window_id: w.id,
                    resets_at: w.resets_at.clone(),
                    used_percent: w.used_percent,
                    observed_at: at.clone(),
                    epoch,
                });
            }
        }
        let before = self.outbox.observations.len();
        self.prune(now);
        if modified || self.outbox.observations.len() != before {
            self.save();
        }
    }

    fn prune(&mut self, now: i64) {
        let cutoff = iso_from_ms(now - KEEP_MS);
        // ISO 8601 UTC in the same format, so string comparison gives time order
        self.outbox.observations.retain(|o| o.observed_at >= cutoff);
        let extra = self.outbox.observations.len().saturating_sub(MAX_QUEUED);
        self.outbox.observations.drain(..extra);
    }

    fn save(&self) {
        if self.outbox_unreadable {
            return;
        }
        if write_json_atomic(&self.home.join(OUTBOX_FILE), &self.outbox).is_err() {
            self.log
                .log("Cannot write outbox.json (unsent observations may be lost on restart)");
        }
    }

    /// Whether the clock is refused now (or might be: a send's result pending, or a state that can't be read). Nothing is fetched,
    /// queued or shown meanwhile, and a send only checks the clock
    pub fn clock_skewed(&self) -> bool {
        usable_epoch(&self.home).is_none()
    }

    /// The destination refused this agent's protocol (426): it must be updated before anything is sent or fetched again
    pub fn outdated(&self) -> bool {
        self.outbox.outdated_protocol.as_deref() == Some(AGENT_PROTOCOL)
    }

    /// Whether this agent may fetch now: its push state is read (read again here if it couldn't be) and says nothing refuses this agent
    pub fn may_fetch(&mut self) -> bool {
        self.readable() && !self.outdated()
    }

    /// Whether the outbox is read: one that couldn't be is read again here (taken once it can be; one gone since starts anew, as
    /// without a file)
    fn readable(&mut self) -> bool {
        if self.outbox_unreadable {
            let path = self.home.join(OUTBOX_FILE);
            match Outbox::read(&path) {
                Some(o) => {
                    self.outbox = o;
                    self.outbox_unreadable = false;
                }
                None if matches!(std::fs::metadata(&path), Err(e) if e.kind() == std::io::ErrorKind::NotFound) =>
                {
                    self.outbox = Outbox::empty();
                    self.outbox_unreadable = false;
                }
                None => {}
            }
        }
        !self.outbox_unreadable
    }

    /// Saves the result of a send of `epoch` (under the clock lock). A result the state no longer waits for (a restart took it as a
    /// refusal) changes nothing
    fn settle(&self, epoch: u64, outcome: SendOutcome) -> Result<(), String> {
        let _lock = hold_clock_lock(&self.home)?;
        let state = ensure_locked(&self.home, || refused_before(&self.home))?;
        if state.in_flight != Some(epoch) {
            return Ok(());
        }
        match outcome {
            SendOutcome::Cleared => save_locked(
                &self.home,
                &ClockEpoch {
                    in_flight: None,
                    ..state
                },
            ),
            SendOutcome::Lifted => advance_locked(&self.home, &state, true).map(|_| ()),
            SendOutcome::Refused => advance_locked(&self.home, &state, false).map(|_| ()),
        }
    }

    /// The clock state a send goes under, with the mark that a send of its epoch is under way saved before the request (if this
    /// process stops before saving the result, the result is unknown: taken as a refusal). Ok(None) while the lock is held (an
    /// acceptance under way): not sent this time
    fn begin_send(&self) -> Result<Option<ClockEpoch>, String> {
        let Some(_lock) = try_clock_lock(&self.home)? else {
            return Ok(None);
        };
        let mut state = ensure_locked(&self.home, || refused_before(&self.home))?;
        // A send a process left pending (it stopped before saving the result): unknown, so taken as refused
        if state.in_flight.is_some() {
            state = advance_locked(&self.home, &state, false)?;
        }
        save_locked(
            &self.home,
            &ClockEpoch {
                in_flight: Some(state.epoch),
                ..state
            },
        )?;
        Ok(Some(state))
    }

    /// Next send time. With nothing to send, 15 minutes after the last success (liveness resend; i64::MAX if never succeeded)
    pub fn due_ms(&self) -> i64 {
        let after_retry = self.outbox.retry_at_ms.unwrap_or(0);
        let idle = !self.dirty && self.outbox.observations.is_empty();
        let due = match (self.outbox.last_attempt_ms, self.outbox.last_success_ms) {
            // After a failure, back off, including for the liveness resend
            (Some(last), _) if self.outbox.failures > 0 => {
                last.saturating_add(backoff_ms(RETRY_BASE_MS, self.outbox.failures - 1))
            }
            // With nothing to send, liveness resend 15 minutes after the last success
            (_, Some(ok)) if idle => ok.saturating_add(LIVENESS_INTERVAL_MS),
            // Wait 1 minute after a success (changes in between and observations beyond 200 go together in the next send)
            (_, Some(ok)) => ok.saturating_add(MIN_SEND_INTERVAL_MS),
            _ if idle => return i64::MAX,
            _ => 0,
        };
        due.max(after_retry)
    }

    /// This PC's latest values as `snapshot.json` shows them (what this push state holds back left out)
    pub fn shown(
        &self,
        latest: &BTreeMap<String, ProviderSnapshot>,
        now: i64,
    ) -> BTreeMap<String, ProviderSnapshot> {
        let mut shown = latest.clone();
        strip_untrusted(
            &mut shown,
            usable_epoch(&self.home).is_none(),
            self.outbox.distrust_until_ms,
            &self.outbox.future_stamps,
            now,
        );
        shown
    }

    /// URL for turn requests (`/v2/snapshots/:collector` → `/v2/turns/:collector`)
    fn turns_endpoint(&self) -> String {
        self.endpoint.replacen("/v2/snapshots/", "/v2/turns/", 1)
    }

    fn finish(&mut self, now: i64, ok: bool, result: &str) {
        self.outbox.last_attempt_ms = Some(now);
        self.outbox.last_result = Some(result.to_string());
        if ok {
            self.outbox.failures = 0;
            self.outbox.last_success_ms = Some(now);
        } else {
            self.outbox.failures = self.outbox.failures.saturating_add(1);
            self.log.log(&format!("Push: {result}"));
        }
        self.save();
    }

    /// Send time: the OS clock read right before the request, or (tests) the loop's time plus the whole seconds waited
    fn send_time(&self, now: i64, started: Instant) -> i64 {
        match self.clock {
            Some(clock) => clock(),
            None => now.saturating_add(started.elapsed().as_secs() as i64 * 1000),
        }
    }

    /// Credential header for the Worker, and the protocol this agent writes (the Worker refuses older agents with 426)
    fn auth_headers(&self) -> Result<Vec<(&'static str, String)>, String> {
        let creds = self.credentials.load()?;
        Ok(vec![
            ("Authorization", format!("Bearer {}", creds.token)),
            ("Headroom-Protocol", AGENT_PROTOCOL.to_string()),
        ])
    }

    /// Sends when due; queued observations go out in chunks of the per-request limit.
    // Every branch ends with return so each reply's result is written the same way
    #[allow(clippy::needless_return)]
    pub fn push(&mut self, snapshot: &Snapshot, now: i64) {
        // Times saved while the clock ran ahead (it has since been set back) don't hold the next send back
        self.outbox.last_attempt_ms = self.outbox.last_attempt_ms.map(|t| t.min(now));
        self.outbox.last_success_ms = self.outbox.last_success_ms.map(|t| t.min(now));
        if !self.readable() {
            self.log
                .log("Push: outbox.json can't be read; nothing is sent until it can be");
            return;
        }
        // A result not saved yet (saving it failed): saved first, also when this agent is outdated (a send's result left pending
        // would hold values back here); until then nothing more is sent
        if let Some((epoch, outcome)) = self.unsettled {
            match self.settle(epoch, outcome) {
                Ok(()) => self.unsettled = None,
                Err(e) => {
                    self.log
                        .log(&format!("Push: couldn't save the last send's result: {e}"));
                    return;
                }
            }
        }
        if self.outdated() {
            return;
        }
        if self.due_ms() > now {
            return;
        }
        let started = Instant::now();
        let headers = match self.auth_headers() {
            Ok(h) => h,
            Err(reason) => return self.finish(now, false, &reason),
        };
        let state = match self.begin_send() {
            Ok(Some(state)) => state,
            Ok(None) => return,
            Err(e) => {
                self.log.log(&format!("Push: not sent: {e}"));
                return;
            }
        };
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        {
            // Observations queued by an older version may name windows that are no longer sent: ids of another shape, and
            // windows the current values show to be something else (e.g. an unknown group whose id contains a known name)
            let refused: Vec<(String, String)> = snapshot
                .providers
                .iter()
                .flat_map(|(p, s)| {
                    s.windows
                        .iter()
                        .filter(|w| w.for_upload().is_none())
                        .map(move |w| (p.clone(), w.id.clone()))
                })
                .collect();
            self.outbox.observations.retain(|o| {
                sendable_scope(&o.window_id).is_some()
                    && !refused
                        .iter()
                        .any(|(p, id)| *p == o.provider && *id == o.window_id)
            });
            // The send time is read when the request goes out (reading the credentials may have waited, and the clock may have been
            // synced meanwhile), so the destination's clock check sees the request time
            let sent_at = self.send_time(now, started);
            // A fetch stamped after the send time was stamped by a clock that has since gone back. It is remembered and never sent,
            // also once the time catches up with it (the destination drops future values, but they would pass then). The whole queue
            // is checked, not only the part sent now
            let ahead = |t: &str| parse_ms(t).is_some_and(|t| t > sent_at);
            // Only what the latest values hold is remembered (a provider may hand it back); queued observations ahead are dropped below
            let current = fetch_stamps(&snapshot.providers);
            let found: Vec<(String, String)> =
                current.iter().filter(|(_, t)| ahead(t)).cloned().collect();
            self.outbox.future_stamps.touch(&current);
            let marked = self.outbox.future_stamps.note(&found);
            let distrust = self.outbox.distrust_until_ms;
            let stamps = self.outbox.future_stamps.clone();
            let trusted = |key: &str, t: &str| {
                parse_ms(t).is_some_and(|ms| ms <= sent_at && distrust.is_none_or(|d| ms > d))
                    && !stamps.contains(key, t)
            };
            let queued = self.outbox.observations.len();
            // Only observations taken in this epoch, while it is trusted (one of an earlier epoch is never sent)
            self.outbox
                .observations
                .retain(|o| o.epoch == Some(state.epoch));
            self.outbox
                .observations
                .retain(|o| trusted(&format!("{}.{}", o.provider, o.window_id), &o.observed_at));
            if marked || self.outbox.observations.len() != queued {
                self.save();
            }
            // While the clock is refused, a send only checks whether it is fixed: no window or observation stamped by it goes out
            let skewed = !state.trusted;
            let mut upload = snapshot.for_upload();
            upload.generated_at = iso_from_ms(sent_at);
            strip_untrusted(&mut upload.providers, skewed, distrust, &stamps, sent_at);
            let count = if skewed {
                0
            } else {
                self.outbox.observations.len().min(MAX_PER_REQUEST)
            };
            let seq = next_send_seq(self.outbox.last_seq, now);
            self.outbox.last_seq = Some(seq);
            let sent: Vec<SentObservation> = self.outbox.observations[..count]
                .iter()
                .map(|o| SentObservation {
                    provider: &o.provider,
                    window_id: &o.window_id,
                    resets_at: &o.resets_at,
                    used_percent: o.used_percent,
                    observed_at: &o.observed_at,
                })
                .collect();
            let body = json!({
                "seq": seq,
                "snapshot": upload,
                "observations": sent,
            })
            .to_string();
            let reply = self.transport.put(&self.endpoint, &headers, &body);
            let outcome = match reply
                .as_ref()
                .map(|(status, text)| (*status, text.as_str()))
            {
                Ok((200..=299, _)) if !state.trusted => SendOutcome::Lifted,
                // The destination answers 422 only for the clock: also when its body couldn't be read
                Ok((422, _)) => SendOutcome::Refused,
                // An answer that isn't about the clock, or a request that never reached the destination
                Ok(_) | Err(SendError::NotSent) => SendOutcome::Cleared,
                // The answer was lost: the destination may have refused the clock
                Err(SendError::Network) => SendOutcome::Refused,
            };
            if let Err(e) = self.settle(state.epoch, outcome) {
                self.log
                    .log(&format!("Push: couldn't save the send's result: {e}"));
                self.unsettled = Some((state.epoch, outcome));
            }
            match reply
                .as_ref()
                .map(|(status, text)| (*status, text.as_str()))
            {
                Ok((200..=299, _)) => {
                    if !state.trusted {
                        // The clock is fixed: values fetched at or before this send, by the wrong clock, are not sent (also those a
                        // provider restores)
                        self.outbox.distrust_until_ms = Some(
                            self.outbox
                                .distrust_until_ms
                                .map_or(sent_at, |d| d.max(sent_at)),
                        );
                    }
                    // One request per send. Remaining observations go 1 minute later (one send per minute)
                    self.outbox.observations.drain(..count);
                    self.dirty = false;
                    self.outbox.retry_at_ms = None;
                    return self.finish(sent_at, true, "Sent");
                }
                Ok((409, text)) => {
                    // Observations are stored, but the latest value was not replaced, so resend with a number above the stored seq.
                    // The resend also respects the send interval (the 1-minute wait)
                    self.outbox.observations.drain(..count);
                    let stored = serde_json::from_str::<serde_json::Value>(text)
                        .ok()
                        .and_then(|v| v["seq"].as_i64());
                    if let Some(stored) = stored {
                        self.outbox.last_seq = Some(seq.max(stored));
                    }
                    self.dirty = true;
                    return self.finish(
                        sent_at,
                        false,
                        "The destination did not replace the latest value (409). Resending with a higher number after the wait",
                    );
                }
                Ok((400 | 413, _)) => {
                    // Body rejected. Drop the observations so they are not sent forever
                    self.outbox.observations.drain(..count);
                    return self.finish(
                        sent_at,
                        false,
                        "The destination rejected the body (400, 413). Dropped the observations",
                    );
                }
                Ok((422, text)) => {
                    // (The new epoch was saved above, under the clock lock.) This PC's clock is off by more than the destination allows, so its times can't be used. The queued observations
                    // were stamped by that clock, so they are dropped (once the clock is fixed they would pass as new values).
                    // The latest value is sent again with the usual backoff. The fetches this send carried are remembered: stamped by
                    // the refused clock, they may be ahead of the corrected one's first accepted send and would pass after it
                    self.outbox
                        .future_stamps
                        .note(&fetch_stamps(&snapshot.providers));
                    self.outbox.observations.clear();
                    let offset_s = serde_json::from_str::<serde_json::Value>(text)
                        .ok()
                        .and_then(|v| v["offset_s"].as_i64());
                    let Some(offset_s) = offset_s else {
                        return self.finish(
                            sent_at,
                            false,
                            "Not accepted: this PC's clock is off (the answer couldn't be read). Set the clock automatically (sync it), then it is sent again",
                        );
                    };
                    let minutes = (offset_s.abs() + 30) / 60;
                    let way = if offset_s >= 0 { "ahead of" } else { "behind" };
                    return self.finish(
                        sent_at,
                        false,
                        &format!(
                            "Not accepted: this PC's clock is about {minutes} min {way} the destination's. Set the clock automatically (sync it), then it is sent again"
                        ),
                    );
                }
                Ok((401 | 403, _)) => {
                    return self.finish(sent_at, false, "The destination rejected the credentials (401, 403). Check the credentials and collector_id");
                }
                Ok((404, _)) => {
                    return self.finish(sent_at, false, "Destination URL not found (404)");
                }
                Ok((426, _)) => {
                    // The Worker takes writes only from a newer agent. Keep the observations (a newer agent sends them), and send or fetch
                    // nothing more with this protocol
                    self.outbox.outdated_protocol = Some(AGENT_PROTOCOL.to_string());
                    return self.finish(
                        sent_at,
                        false,
                        "The destination needs a newer agent (426). Update Headroom on this PC",
                    );
                }
                Ok((503, text)) if text.contains("d1_budget") => {
                    // The destination's daily D1 budget is used up (it resets at UTC midnight). Keep the observations and do not send until
                    // the time the destination gave (at most 24 hours). Observations older than 24 hours are dropped by the queue limit (leaving a gap)
                    let wait_s = serde_json::from_str::<serde_json::Value>(text)
                        .ok()
                        .and_then(|v| v["retry_after_s"].as_i64())
                        .unwrap_or(3600)
                        .clamp(60, 24 * 3600);
                    self.outbox.retry_at_ms = Some(sent_at.saturating_add(wait_s * 1000));
                    return self.finish(
                        sent_at,
                        false,
                        "Not accepted: the destination is near its daily D1 limit (resets at UTC midnight)",
                    );
                }
                Ok((300..=399, _)) => {
                    // Redirects are not followed. Keep the observations so they can be sent once the URL is fixed
                    return self.finish(
                        sent_at,
                        false,
                        "The destination returned a redirect (3xx). Redirects are not followed; check [push] url",
                    );
                }
                Ok(_) => return self.finish(sent_at, false, "The destination returned an error"),
                Err(_) => return self.finish(sent_at, false, "Cannot connect to the destination"),
            }
        }
    }

    /// Discards the observations waiting to be sent (a planned stop before a migration: what an older Worker accepted must not be
    /// sent again). The send number and the marks stay, so the next send's number is above the stored one. Ok(None) without a push state
    pub fn discard_queue(home: &Path) -> Result<Option<usize>, String> {
        // The clock epoch moves on first (its trust kept): what this PC queued or cached before is never sent or used again, also if
        // what follows fails or this stops before it. A send left pending is taken as refused
        {
            let _lock = hold_clock_lock(home)?;
            let state = ensure_locked(home, || refused_before(home))?;
            advance_locked(home, &state, state.trusted && state.in_flight.is_none())?;
        }
        let path = home.join(OUTBOX_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let mut o =
            Outbox::read(&path).ok_or("The push state can't be read; nothing was discarded")?;
        let n = o.observations.len();
        o.observations.clear();
        write_json_atomic(&path, &o).map_err(|e| format!("Couldn't save the push state: {e}"))?;
        // Read back: the queue is empty
        match Outbox::read(&path) {
            Some(back) if back.observations.is_empty() => Ok(Some(n)),
            _ => Err("The push state couldn't be read back empty; run this again".into()),
        }
    }

    pub fn status_line(home: &Path) -> Option<String> {
        let path = home.join(OUTBOX_FILE);
        let Some(o) = Outbox::read(&path) else {
            // A state that exists but can't be read: the count is unknown (not "none")
            return path
                .exists()
                .then(|| "Push: the push state can't be read (the number of unsent observations is unknown)".to_string());
        };
        Some(format!(
            "Push: {} unsent observations / {} consecutive failures / last result {} / last success {}",
            o.observations.len(),
            o.failures,
            o.last_result.as_deref().unwrap_or("none"),
            o.last_success_ms.map_or("none".into(), iso_from_ms),
        ))
    }
}

/// ISO 8601 time to epoch ms (None if unreadable)
fn parse_ms(iso: &str) -> Option<i64> {
    iso.parse::<jiff::Timestamp>()
        .ok()
        .map(|t| t.as_millisecond())
}

impl TurnAsker for Pusher {
    /// Asks the destination for the turn. None if unreachable, no credentials, or the answer is unreadable (this PC fetches itself).
    /// Not counted in the push state (failure count, backoff)
    fn ask_turn(&mut self, provider: &str, minutes: i64) -> Option<TurnReply> {
        // An outdated agent takes no turn and doesn't fetch on its own either
        if self.outdated() {
            return Some(TurnReply {
                go: false,
                wait_ms: 60 * 60 * 1000,
            });
        }
        // While the destination refuses this PC's clock, it takes no turn (it can still hand one back)
        if minutes > 0 && usable_epoch(&self.home).is_none() {
            return None;
        }
        let headers = self.auth_headers().ok()?;
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let body = json!({ provider: minutes }).to_string();
        let url = self.turns_endpoint();
        let (status, text) = self.transport.post(&url, &headers, &body).ok()?;
        // The destination takes writes only from a newer agent: this PC doesn't fetch on its own either (its values couldn't be sent)
        if status == 426 {
            // Kept like a 426 to an upload: also after a restart this agent sends and fetches nothing more
            if self.readable() {
                self.outbox.outdated_protocol = Some(AGENT_PROTOCOL.to_string());
                self.save();
            }
            return Some(TurnReply {
                go: false,
                wait_ms: 60 * 60 * 1000,
            });
        }
        if status != 200 {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(&text).ok()?;
        let go = v[provider]["go"].as_bool()?;
        let wait_s = v[provider]["wait_s"].as_i64()?;
        Some(TurnReply {
            go,
            wait_ms: wait_s.clamp(0, 70 * 60) * 1000,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{ProviderStatus, make_window};
    use std::sync::{Arc, Mutex};

    const NOW: i64 = 1_794_834_000_000;

    #[derive(Default)]
    struct Sent {
        bodies: Vec<serde_json::Value>,
        headers: Vec<Vec<(String, String)>>,
        replies: Vec<Result<u16, SendError>>,
        /// Reply bodies in the same order as replies (empty if none)
        reply_bodies: Vec<String>,
        /// POST (turn) targets and bodies, and their replies (unreachable if none)
        posts: Vec<(String, serde_json::Value)>,
        post_replies: Vec<(u16, String)>,
        /// Run once a PUT has arrived, before its reply (a fault right after the request went out)
        on_put: Option<Box<dyn FnMut() + Send>>,
    }

    #[derive(Clone, Default)]
    struct FakeTransport(Arc<Mutex<Sent>>);

    impl Transport for FakeTransport {
        fn put(
            &mut self,
            _url: &str,
            headers: &[(&str, &str)],
            body: &str,
        ) -> Result<(u16, String), SendError> {
            let mut s = self.0.lock().unwrap();
            s.bodies.push(serde_json::from_str(body).unwrap());
            if let Some(f) = s.on_put.as_mut() {
                f();
            }
            s.headers.push(
                headers
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
            );
            let text = if s.reply_bodies.is_empty() {
                String::new()
            } else {
                s.reply_bodies.remove(0)
            };
            if s.replies.is_empty() {
                Ok((204, text))
            } else {
                s.replies.remove(0).map(|code| (code, text))
            }
        }

        fn post(
            &mut self,
            url: &str,
            _headers: &[(&str, &str)],
            body: &str,
        ) -> Result<(u16, String), SendError> {
            let mut s = self.0.lock().unwrap();
            s.posts
                .push((url.to_string(), serde_json::from_str(body).unwrap()));
            if s.post_replies.is_empty() {
                Err(SendError::Network)
            } else {
                Ok(s.post_replies.remove(0))
            }
        }
    }

    struct FakeCreds(Result<Credentials, String>);
    impl CredentialStore for FakeCreds {
        fn load(&self) -> Result<Credentials, String> {
            self.0.clone()
        }
    }

    fn creds() -> Credentials {
        Credentials {
            token: "worker-token".into(),
        }
    }

    #[test]
    fn credentials_saved_by_the_access_era_still_load() {
        // Older versions also saved Access fields (the Access path was removed). They are ignored; only the token is used
        let old = r#"{"token":"worker-token","access_client_id":"","access_client_secret":""}"#;
        let c: Credentials = serde_json::from_str(old).unwrap();
        assert_eq!(c, creds());
    }

    fn home(label: &str) -> crate::test_util::TempHome {
        crate::test_util::TempHome::new(&format!("headroom-push-{label}"))
    }

    fn pusher(h: &Path, t: &FakeTransport, c: Result<Credentials, String>) -> Pusher {
        if clock_epoch(h) == EpochRead::Missing {
            crate::test_util::trust_clock(h);
        }
        Pusher::new(
            h,
            "https://x.example/v2/snapshots/mac",
            Logger::stderr(),
            Box::new(t.clone()),
            Box::new(FakeCreds(c)),
        )
    }

    fn latest(
        used: f64,
        fetched_ms: i64,
        code: Option<ErrorCode>,
    ) -> BTreeMap<String, ProviderSnapshot> {
        let w =
            make_window("five_hour", used, Some(NOW + 180 * MINUTE_MS)).with_fetched_ms(fetched_ms);
        let mut p = ProviderSnapshot::empty(ProviderStatus::Ok, "", code);
        p.error = None;
        p.windows = vec![w];
        BTreeMap::from([("claude".to_string(), p)])
    }

    fn snapshot(l: &BTreeMap<String, ProviderSnapshot>) -> Snapshot {
        crate::schema::build_snapshot(l.clone(), NOW, "mac")
    }

    #[test]
    fn each_fetch_is_one_observation_even_if_the_value_is_unchanged() {
        let h = home("obs");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let first = latest(10.0, NOW, None);
        p.record(&first, true, NOW);
        p.record(&first, false, NOW + 1000); // the same fetch (cache) adds nothing
        assert_eq!(p.outbox.observations.len(), 1);
        p.record(
            &latest(10.0, NOW + 5 * MINUTE_MS, None),
            false,
            NOW + 5 * MINUTE_MS,
        );
        assert_eq!(
            p.outbox.observations.len(),
            2,
            "a new fetch is an observation even with the same value"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn liveness_resend_every_15_minutes_without_observations() {
        let h = home("alive");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let l = latest(10.0, NOW, None);
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        // While not fetching because a limit is reached: the latest value does not change and no observations are added
        let quiet = NOW + 14 * MINUTE_MS;
        p.record(&l, false, quiet);
        p.push(&snapshot(&l), quiet);
        assert_eq!(
            t.0.lock().unwrap().bodies.len(),
            1,
            "not sent before 15 minutes"
        );
        let due = NOW + 15 * MINUTE_MS;
        p.record(&l, false, due);
        p.push(&snapshot(&l), due);
        let s = t.0.lock().unwrap();
        assert_eq!(s.bodies.len(), 2, "resent after 15 minutes");
        let resend = &s.bodies[1];
        assert_eq!(
            resend["observations"].as_array().map(Vec::len),
            Some(0),
            "no observations attached"
        );
        assert_eq!(
            resend["snapshot"]["providers"], s.bodies[0]["snapshot"]["providers"],
            "the latest value is unchanged, including the usage fetch time"
        );
        assert!(
            resend["seq"].as_i64() > s.bodies[0]["seq"].as_i64(),
            "the number advances"
        );
        drop(s);
        assert_eq!(p.due_ms(), due + 15 * MINUTE_MS);

        // If the resend fails, wait 1 → 2 → 4 minutes; back to 15 minutes on success
        let mut at = due + 15 * MINUTE_MS;
        t.0.lock().unwrap().replies = (0..3).map(|_| Err(SendError::NotSent)).collect();
        for wait in [1, 2, 4] {
            p.push(&snapshot(&l), at);
            assert_eq!(
                p.due_ms(),
                at + wait * MINUTE_MS,
                "{wait} minutes after a failure"
            );
            p.push(&snapshot(&l), at + 30_000);
            at += wait * MINUTE_MS;
        }
        p.push(&snapshot(&l), at);
        assert_eq!(
            p.due_ms(),
            at + 15 * MINUTE_MS,
            "back to 15 minutes on success"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn sends_snapshot_observations_seq_and_headers_then_clears_the_queue() {
        let h = home("send");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let l = latest(10.0, NOW, None);
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        let s = t.0.lock().unwrap();
        assert_eq!(s.bodies.len(), 1);
        assert_eq!(s.bodies[0]["seq"], NOW);
        assert_eq!(s.bodies[0]["observations"][0]["window_id"], "five_hour");
        assert_eq!(s.bodies[0]["snapshot"]["collector"], "mac");
        let names: Vec<_> = s.headers[0].iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(names, ["Authorization", "Headroom-Protocol"]);
        drop(s);
        assert!(p.outbox.observations.is_empty());
        assert_eq!(
            p.due_ms(),
            NOW + 15 * MINUTE_MS,
            "with nothing to send, liveness resend after 15 minutes"
        );
        let saved = std::fs::read_to_string(h.join(OUTBOX_FILE)).unwrap();
        assert!(
            !saved.contains("worker-token"),
            "credentials are not written to the file"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn only_known_names_leave_the_pc() {
        let h = home("d11");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let mut l = latest(10.0, NOW, None);
        let claude = l.get_mut("claude").unwrap();
        claude.error = Some("denied for Acme Corp".into());
        claude.plan = Some("Acme Corp plan".into());
        let mut model = make_window("seven_day_opus", 5.0, None).with_fetched_ms(NOW);
        model.scope = Some("Opus".into());
        model.label = "Weekly Acme Corp".into();
        let mut unknown_model = make_window("seven_day_acme_corp", 5.0, None).with_fetched_ms(NOW);
        unknown_model.scope = Some("Acme Corp".into());
        let mut unknown_heading = make_window("acme_corp_pool", 5.0, None).with_fetched_ms(NOW);
        unknown_heading.label = "Acme Corp pool".into();
        let mut unknown_group = make_window("acme_five_hour", 5.0, None).with_fetched_ms(NOW);
        unknown_group.scope = Some("acme".into());
        let bad_id = make_window("Acme-Corp", 5.0, None).with_fetched_ms(NOW);
        claude
            .windows
            .extend([model, unknown_model, unknown_heading, unknown_group, bad_id]);
        // An observation queued by an older version for a window that is no longer sent
        p.outbox.observations.push(Observation {
            provider: "claude".into(),
            window_id: "acme_corp_pool".into(),
            resets_at: None,
            used_percent: 1.0,
            observed_at: iso_from_ms(NOW - MINUTE_MS),
            epoch: Some(1),
        });
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        let s = t.0.lock().unwrap();
        let body = s.bodies[0].to_string();
        assert!(!body.to_ascii_lowercase().contains("acme"), "{body}");
        let windows = &s.bodies[0]["snapshot"]["providers"]["claude"]["windows"];
        let ids: Vec<_> = windows
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["five_hour", "seven_day_opus"]);
        assert_eq!(windows[1]["scope"], "Opus");
        assert_eq!(windows[1]["label"], "Weekly Opus");
        let claude = &s.bodies[0]["snapshot"]["providers"]["claude"];
        assert_eq!(claude["plan"], serde_json::Value::Null);
        assert_eq!(claude["error"], crate::schema::WITHHELD_ERROR);
        let observed: Vec<_> = s.bodies[0]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["window_id"].as_str().unwrap())
            .collect();
        assert_eq!(observed, ["five_hour", "seven_day_opus"]);
    }

    #[test]
    fn queued_observations_of_windows_not_sent_are_dropped() {
        let h = home("queued-unknown");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let mut l = latest(10.0, NOW, None);
        // An unknown group whose id contains a known group's name
        let mut lookalike =
            make_window("codex_other_five_hour_primary", 5.0, None).with_fetched_ms(NOW);
        lookalike.scope = Some("codex_other_five_hour".into());
        let mut codex = ProviderSnapshot::empty(ProviderStatus::Ok, "", None);
        codex.error = None;
        codex.windows = vec![lookalike];
        l.insert("codex".into(), codex);
        // Queued by an older version that sent it
        p.outbox.observations.push(Observation {
            provider: "codex".into(),
            window_id: "codex_other_five_hour_primary".into(),
            resets_at: None,
            used_percent: 5.0,
            observed_at: iso_from_ms(NOW - MINUTE_MS),
            epoch: Some(1),
        });
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        let s = t.0.lock().unwrap();
        let ids: Vec<_> = s.bodies[0]["observations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["window_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["five_hour"]);
    }

    #[test]
    fn an_older_outbox_drops_queued_collision_ids_only() {
        let h = home("legacy-outbox");
        let queued = |id: &str| Observation {
            provider: "codex".into(),
            window_id: id.into(),
            resets_at: None,
            used_percent: 5.0,
            observed_at: iso_from_ms(NOW - MINUTE_MS),
            epoch: Some(1),
        };
        let old = serde_json::json!({
            "observations": [queued("five_hour"), queued("codex_other_five_hour_primary"), queued("codex_other_five_hour")],
        });
        std::fs::write(h.join(OUTBOX_FILE), old.to_string()).unwrap();
        let t = FakeTransport::default();
        let p = pusher(&h, &t, Ok(creds()));
        let ids: Vec<_> = p
            .outbox
            .observations
            .iter()
            .map(|o| o.window_id.as_str())
            .collect();
        assert_eq!(ids, ["five_hour", "codex_other_five_hour"]);
        assert_eq!(p.outbox.version, OUTBOX_VERSION);
        assert!(
            Pusher::status_line(&h)
                .unwrap()
                .starts_with("Push: 2 unsent observations")
        );
        // A new outbox is written as this version, so its own collision ids survive a restart
        let fresh = home("fresh-outbox");
        let t2 = FakeTransport::default();
        let mut p2 = pusher(&fresh, &t2, Ok(creds()));
        assert_eq!(p2.outbox.version, OUTBOX_VERSION);
        p2.outbox
            .observations
            .push(queued("codex_other_five_hour_primary"));
        p2.save();
        assert_eq!(Outbox::load(&fresh.join(OUTBOX_FILE)).observations.len(), 1);
        // Written by this version: kept
        let mut current = Outbox {
            version: OUTBOX_VERSION,
            ..Outbox::default()
        };
        current
            .observations
            .push(queued("codex_other_five_hour_primary"));
        std::fs::write(
            h.join(OUTBOX_FILE),
            serde_json::to_string(&current).unwrap(),
        )
        .unwrap();
        assert_eq!(Outbox::load(&h.join(OUTBOX_FILE)).observations.len(), 1);
    }

    #[test]
    fn failures_keep_the_queue_and_back_off_then_resend_with_a_new_seq() {
        let h = home("retry");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Err(SendError::NotSent), Ok(503)];
        let mut p = pusher(&h, &t, Ok(creds()));
        let l = latest(10.0, NOW, None);
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        assert_eq!(p.outbox.observations.len(), 1);
        assert_eq!(p.due_ms(), NOW + MINUTE_MS);
        p.push(&snapshot(&l), NOW + 30_000);
        assert_eq!(
            t.0.lock().unwrap().bodies.len(),
            1,
            "not sent during the backoff"
        );
        p.push(&snapshot(&l), NOW + MINUTE_MS);
        assert_eq!(p.due_ms(), NOW + MINUTE_MS + 2 * MINUTE_MS, "doubles");
        // Unsent observations survive a restart
        let mut p2 = pusher(&h, &t, Ok(creds()));
        assert_eq!(p2.outbox.observations.len(), 1);
        p2.push(&snapshot(&l), NOW + 3 * MINUTE_MS);
        let s = t.0.lock().unwrap();
        assert_eq!(s.bodies.len(), 3);
        assert!(s.bodies[2]["seq"].as_i64() > s.bodies[1]["seq"].as_i64());
        drop(s);
        assert!(p2.outbox.observations.is_empty());
        assert_eq!(p2.outbox.failures, 0);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_clock_refusal_drops_the_queue_and_says_how_far_the_clock_is_off() {
        let h = home("clock-skew");
        let t = FakeTransport::default();
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(422)];
            s.reply_bodies = vec![r#"{"error":"clock_skew","offset_s":-430}"#.into()];
        }
        let mut p = pusher(&h, &t, Ok(creds()));
        p.record(&latest(10.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW);
        assert!(
            p.outbox.observations.is_empty(),
            "stamped by the wrong clock, so dropped"
        );
        assert!(p.clock_skewed());
        assert_eq!(p.outbox.failures, 1);
        let result = p.outbox.last_result.clone().unwrap();
        assert!(result.contains("about 7 min behind"), "{result}");
        // No turn is taken while refused (handing one back still goes out)
        assert!(p.ask_turn("claude", 7).is_none());
        assert!(t.0.lock().unwrap().posts.is_empty());
        // The clock was an hour ahead when it was refused; once set back, the next send isn't held back by that time
        p.outbox.last_attempt_ms = Some(NOW + 60 * MINUTE_MS);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW + 2 * MINUTE_MS);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW + 3 * MINUTE_MS);
        assert_eq!(
            t.0.lock().unwrap().bodies.len(),
            2,
            "sent again after the backoff"
        );
        assert!(!p.clock_skewed(), "accepted, so turns can be taken again");
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn rejected_bodies_are_dropped_and_credentials_errors_are_kept() {
        let h = home("reject");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Ok(400), Ok(401)];
        let mut p = pusher(&h, &t, Ok(creds()));
        p.record(&latest(10.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW);
        assert!(
            p.outbox.observations.is_empty(),
            "observations from a 400 are dropped"
        );
        p.record(
            &latest(11.0, NOW + 5 * MINUTE_MS, None),
            true,
            NOW + 5 * MINUTE_MS,
        );
        p.push(&snapshot(&latest(11.0, NOW, None)), NOW + 5 * MINUTE_MS);
        assert_eq!(
            p.outbox.observations.len(),
            1,
            "kept on 401, since fixing the credentials makes them sendable"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn account_changed_and_old_observations_are_not_sent() {
        let h = home("skip");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Err("No credentials".into()));
        p.record(
            &latest(10.0, NOW, Some(ErrorCode::AccountChanged)),
            true,
            NOW,
        );
        assert!(
            p.outbox.observations.is_empty(),
            "a provider stopped by an account switch is not sent"
        );
        p.record(&latest(10.0, NOW - 25 * 60 * MINUTE_MS, None), true, NOW);
        assert!(
            p.outbox.observations.is_empty(),
            "observations older than 24 hours are not queued"
        );
        p.record(&latest(10.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW);
        assert_eq!(
            t.0.lock().unwrap().bodies.len(),
            0,
            "not sent without credentials"
        );
        assert_eq!(p.outbox.observations.len(), 1);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn switching_accounts_drops_the_old_accounts_queue() {
        let h = home("switch");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Err(SendError::NotSent)];
        let mut p = pusher(&h, &t, Ok(creds()));
        // The previous account's observations are left over after an outage
        p.record(&latest(40.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(p.outbox.observations.len(), 1);
        // Switch detected: drop unsent observations
        p.record(
            &latest(40.0, NOW, Some(ErrorCode::AccountChanged)),
            true,
            NOW + MINUTE_MS,
        );
        assert!(p.outbox.observations.is_empty());

        // Switch accepted by another process without the agent seeing it: drop what came before history_since
        let mut p = pusher(&h, &t, Ok(creds()));
        p.record(
            &latest(40.0, NOW + 2 * MINUTE_MS, None),
            true,
            NOW + 2 * MINUTE_MS,
        );
        let mut after = latest(3.0, NOW + 10 * MINUTE_MS, None);
        after.get_mut("claude").unwrap().history_since = Some(iso_from_ms(NOW + 9 * MINUTE_MS));
        p.record(&after, true, NOW + 10 * MINUTE_MS);
        let queued: Vec<f64> = p
            .outbox
            .observations
            .iter()
            .map(|o| o.used_percent)
            .collect();
        assert_eq!(
            queued,
            [3.0],
            "the previous account's observations are not sent"
        );
        p.push(&snapshot(&after), NOW + 10 * MINUTE_MS);
        let s = t.0.lock().unwrap();
        let body = s.bodies.last().unwrap();
        assert_eq!(body["observations"].as_array().unwrap().len(), 1);
        assert_eq!(
            body["snapshot"]["providers"]["claude"]["history_since"],
            iso_from_ms(NOW + 9 * MINUTE_MS)
        );
        drop(s);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn clock_skewed_old_observations_are_dropped_and_the_swap_is_saved() {
        let h = home("skew");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Err(SendError::NotSent)];
        let mut p = pusher(&h, &t, Ok(creds()));
        // Previous account's observation while the clock was an hour fast (left unsent)
        p.record(&latest(70.0, NOW + 60 * MINUTE_MS, None), true, NOW);
        p.push(&snapshot(&latest(70.0, NOW, None)), NOW);
        assert!(
            p.outbox.observations.is_empty(),
            "stamped ahead of the send time (the clock was fast), so dropped from the queue at once"
        );
        // The switch was accepted after fixing the clock; the acceptance time is earlier than the previous observation
        let mut after = latest(2.0, NOW + 10 * MINUTE_MS, None);
        after.get_mut("claude").unwrap().history_since = Some(iso_from_ms(NOW + 9 * MINUTE_MS));
        p.record(&after, true, NOW + 10 * MINUTE_MS);
        let queued: Vec<f64> = p
            .outbox
            .observations
            .iter()
            .map(|o| o.used_percent)
            .collect();
        assert_eq!(
            queued,
            [2.0],
            "observations queued before acceptance are dropped regardless of time"
        );
        // Saved even though one was dropped and one added (same count)
        let reloaded = pusher(&h, &t, Ok(creds()));
        let queued: Vec<f64> = reloaded
            .outbox
            .observations
            .iter()
            .map(|o| o.used_percent)
            .collect();
        assert_eq!(queued, [2.0]);
        // Seeing the same history_since again does not drop observations made after acceptance
        let mut p = reloaded;
        let mut next = latest(4.0, NOW + 15 * MINUTE_MS, None);
        next.get_mut("claude").unwrap().history_since = Some(iso_from_ms(NOW + 9 * MINUTE_MS));
        p.record(&next, true, NOW + 15 * MINUTE_MS);
        assert_eq!(p.outbox.observations.len(), 2);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_409_is_not_success_and_resends_above_the_stored_seq_after_the_wait() {
        let h = home("stale-seq");
        let t = FakeTransport::default();
        let stored = NOW + 365 * 24 * 60 * MINUTE_MS; // seq stored while the clock was fast
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(409), Ok(204)];
            s.reply_bodies = vec![format!(r#"{{"error":"stale_seq","seq":{stored}}}"#)];
        }
        // A PC that lost outbox.json (no last_seq)
        let mut p = pusher(&h, &t, Ok(creds()));
        let l = latest(10.0, NOW, None);
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        assert_eq!(
            t.0.lock().unwrap().bodies.len(),
            1,
            "not resent immediately"
        );
        assert_eq!(p.outbox.failures, 1, "409 is not a success");
        assert_eq!(p.due_ms(), NOW + MINUTE_MS);
        p.push(&snapshot(&l), NOW + MINUTE_MS);
        let s = t.0.lock().unwrap();
        assert_eq!(s.bodies.len(), 2);
        assert_eq!(s.bodies[0]["seq"], NOW);
        assert_eq!(s.bodies[1]["seq"], stored + 1);
        assert_eq!(
            s.bodies[1]["observations"].as_array().unwrap().len(),
            0,
            "observations were already stored at the 409"
        );
        drop(s);
        assert_eq!(p.outbox.failures, 0);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn large_queues_are_split_into_several_requests() {
        let h = home("split");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let one = Observation {
            provider: "claude".into(),
            window_id: "five_hour".into(),
            resets_at: None,
            used_percent: 10.0,
            observed_at: iso_from_ms(NOW),
            epoch: Some(1),
        };
        p.outbox.observations = vec![one; MAX_PER_REQUEST + 5];
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1, "one request per send");
        assert_eq!(p.outbox.observations.len(), 5);
        assert_eq!(p.due_ms(), NOW + MINUTE_MS, "the rest 1 minute later");
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW + 30_000);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW + MINUTE_MS);
        let s = t.0.lock().unwrap();
        assert_eq!(s.bodies.len(), 2);
        assert_eq!(s.bodies[1]["observations"].as_array().unwrap().len(), 5);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn url_must_be_https_except_loopback() {
        assert!(validate_url("https://h.example.workers.dev/").is_ok());
        assert!(validate_url("https://h.example:8443/base").is_ok());
        assert!(validate_url("http://127.0.0.1:8787").is_ok());
        assert!(validate_url("http://localhost:8787/").is_ok());
        assert!(validate_url("http://[::1]:8787").is_ok());
        assert!(validate_url("http://h.example.workers.dev").is_err());
        assert!(validate_url("https://h.example/?token=x").is_err());
        // URLs with userinfo that a plain prefix check would let through
        assert!(validate_url("http://127.0.0.1:80@evil.example").is_err());
        assert!(validate_url("http://localhost:1@evil.example/").is_err());
        assert!(validate_url("https://user:pass@h.example").is_err());
        assert!(
            validate_url("http://127.0.0.1").is_err(),
            "loopback http needs an explicit port"
        );
        assert!(validate_url("http://127.0.0.1.evil.example:80").is_err());
        assert!(validate_url("https://h.example:x").is_err());
        assert!(validate_url("https://h.ex\\ample").is_err());
        assert!(validate_url("ftp://h.example").is_err());
    }

    #[test]
    fn redirects_keep_the_queue() {
        let h = home("redirect");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Ok(302)];
        let mut p = pusher(&h, &t, Ok(creds()));
        let l = latest(10.0, NOW, None);
        p.record(&l, true, NOW);
        p.push(&snapshot(&l), NOW);
        assert_eq!(p.outbox.observations.len(), 1, "3xx is not a success");
        assert_eq!(p.outbox.failures, 1);
        let _ = std::fs::remove_dir_all(h);
    }

    /// The real HTTP client does not follow a 302; neither credentials nor body reach the redirect target
    #[test]
    fn http_transport_does_not_follow_redirects() {
        use std::io::{BufRead, BufReader, Write};
        let target = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let target_port = target.local_addr().unwrap().port();
        target.set_nonblocking(true).unwrap();
        let origin = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = origin.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            use std::io::Read;
            let (stream, _) = origin.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut body_len = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    body_len = value.trim().parse().unwrap();
                }
                if line == "\r\n" || line.is_empty() {
                    break;
                }
            }
            // Read the body before replying: closing a socket with unread data resets the connection on Windows,
            // and the client could then fail before it reads the reply
            let mut body = vec![0; body_len];
            reader.read_exact(&mut body).unwrap();
            let mut stream = stream;
            let reply = format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target_port}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            stream.write_all(reply.as_bytes()).unwrap();
        });
        let (status, _) = HttpTransport::new()
            .put(
                &format!("http://127.0.0.1:{port}/v2/snapshots/mac"),
                &[("Authorization", "Bearer synthetic-secret")],
                r#"{"seq":1}"#,
            )
            .unwrap();
        server.join().unwrap();
        assert_eq!(status, 302);
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            matches!(target.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "does not connect to the redirect target"
        );
    }

    /// Whether real HTTPS (OS TLS and certificate store) can reach an outside server. Uses the network, so run it manually:
    /// cargo test -- --ignored https_reaches_a_public_server
    #[test]
    #[ignore]
    fn https_reaches_a_public_server() {
        let status = HttpTransport::new()
            .put("https://example.com/", &[], "{}")
            .map(|r| r.0);
        assert!(status.is_ok(), "TLS connection failed: {status:?}");
    }

    /// Checks that the real HTTP client's PUT reaches a simple loopback server
    #[test]
    fn http_transport_sends_headers_and_body() {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = Vec::new();
            let mut len = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
                head.push(line);
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).unwrap();
            let mut stream = stream;
            stream
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .unwrap();
            (head, String::from_utf8(body).unwrap())
        });
        let mut t = HttpTransport::new();
        let (status, _) = t
            .put(
                &format!("http://127.0.0.1:{port}/v2/snapshots/mac"),
                &[("Authorization", "Bearer abc")],
                r#"{"seq":1}"#,
            )
            .unwrap();
        let (head, body) = server.join().unwrap();
        assert_eq!(status, 204);
        assert!(head[0].starts_with("PUT /v2/snapshots/mac "));
        assert!(
            head.iter()
                .any(|l| l.eq_ignore_ascii_case("authorization: Bearer abc\r\n"))
        );
        assert_eq!(body, r#"{"seq":1}"#);
    }

    #[test]
    fn turns_are_asked_at_the_turns_endpoint_and_bad_replies_mean_fetch_yourself() {
        let h = home("turns");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        t.0.lock().unwrap().post_replies = vec![
            (200, r#"{"claude":{"go":false,"wait_s":120}}"#.into()),
            (200, r#"{"claude":{"go":true,"wait_s":0}}"#.into()),
            (404, String::new()),
            (200, "not json".into()),
        ];
        assert_eq!(
            p.ask_turn("claude", 7),
            Some(TurnReply {
                go: false,
                wait_ms: 120_000
            })
        );
        assert_eq!(
            p.ask_turn("claude", 7),
            Some(TurnReply {
                go: true,
                wait_ms: 0
            })
        );
        assert_eq!(
            p.ask_turn("claude", 7),
            None,
            "older destination (no turns)"
        );
        assert_eq!(p.ask_turn("claude", 7), None);
        assert_eq!(p.ask_turn("claude", 7), None, "unreachable");
        let s = t.0.lock().unwrap();
        assert_eq!(s.posts[0].0, "https://x.example/v2/turns/mac");
        assert_eq!(s.posts[0].1, json!({"claude": 7}));
        assert!(
            s.bodies.is_empty(),
            "turn requests do not count toward the push state"
        );
        drop(s);
        // Does not ask without credentials
        let t2 = FakeTransport::default();
        let mut p2 = pusher(&h, &t2, Err("none".into()));
        assert_eq!(p2.ask_turn("codex", 7), None);
        assert!(t2.0.lock().unwrap().posts.is_empty());
    }

    #[test]
    fn statusline_bursts_are_thinned_to_one_observation_and_one_send_per_minute() {
        let h = home("pacing");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        // statusLine values arrive every 10 seconds
        for i in 0..6 {
            let at = NOW + i * 10_000;
            p.record(&latest(10.0 + i as f64, at, None), true, at);
            p.push(&snapshot(&latest(10.0 + i as f64, at, None)), at);
        }
        assert_eq!(
            t.0.lock().unwrap().bodies.len(),
            1,
            "sent only once per minute"
        );
        assert_eq!(p.due_ms(), NOW + MINUTE_MS);
        let at = NOW + MINUTE_MS;
        p.record(&latest(20.0, at, None), true, at);
        p.push(&snapshot(&latest(20.0, at, None)), at);
        let s = t.0.lock().unwrap();
        assert_eq!(s.bodies.len(), 2);
        let observed: usize = s
            .bodies
            .iter()
            .map(|b| b["observations"].as_array().unwrap().len())
            .sum();
        assert_eq!(observed, 2, "one per window per minute");
        drop(s);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_d1_budget_refusal_keeps_the_queue_and_backs_off() {
        let h = home("budget");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(503)];
            s.reply_bodies = vec![r#"{"error":"d1_budget","retry_after_s":3600}"#.into()];
        }
        p.record(&latest(10.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW);
        assert_eq!(p.outbox.observations.len(), 1, "observations are kept");
        assert_eq!(p.outbox.failures, 1);
        assert!(p.outbox.last_result.as_deref().unwrap().contains("D1"));
        assert_eq!(
            p.due_ms(),
            NOW + 3600 * 1000,
            "not sent until the time the destination gave"
        );
        // Still waits after a restart (kept in outbox.json)
        let again = pusher(&h, &t, Ok(creds()));
        assert_eq!(again.due_ms(), NOW + 3600 * 1000);
        let _ = std::fs::remove_dir_all(h);
    }

    /// Windows of the last body sent (provider → fetch times)
    fn sent_windows(t: &FakeTransport) -> Vec<String> {
        let s = t.0.lock().unwrap();
        let body = s.bodies.last().unwrap();
        body["snapshot"]["providers"]["claude"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["fetched_at"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn while_the_clock_is_refused_nothing_is_queued_and_a_send_carries_no_values() {
        let h = home("skew-probe");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        refuse(&h);
        p.record(&latest(40.0, NOW, None), true, NOW);
        assert!(
            p.outbox.observations.is_empty(),
            "stamped by the refused clock"
        );
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        let s = t.0.lock().unwrap();
        let body = s.bodies.last().unwrap();
        assert!(
            body["snapshot"]["providers"]["claude"]["windows"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(body["observations"].as_array().unwrap().is_empty());
        drop(s);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn after_a_clock_refusal_values_stamped_before_the_fix_are_not_sent_even_after_a_restart() {
        // a send accepted after the refusal marks everything stamped before it
        let h = home("skew-fixed");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        refuse(&h);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 5 * MINUTE_MS);
        assert!(!p.clock_skewed());
        // Restarted: a provider hands back its cached value fetched by the wrong clock, and a new fetch comes
        let mut again = pusher(&h, &t, Ok(creds()));
        let mut both = latest(40.0, NOW, None);
        let fresh = make_window("seven_day", 7.0, Some(NOW + 3 * 24 * 60 * MINUTE_MS))
            .with_fetched_ms(NOW + 7 * MINUTE_MS);
        both.get_mut("claude").unwrap().windows.push(fresh);
        again.record(&both, true, NOW + 7 * MINUTE_MS);
        again.push(&snapshot(&both), NOW + 8 * MINUTE_MS);
        assert_eq!(
            sent_windows(&t),
            [iso_from_ms(NOW + 7 * MINUTE_MS)],
            "only the fetch after the fix"
        );
        let s = t.0.lock().unwrap();
        assert_eq!(
            s.bodies.last().unwrap()["observations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        drop(s);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_window_stamped_ahead_of_the_send_time_is_never_sent_also_once_the_time_catches_up() {
        // fetched at 12:03 on a clock that went back to 12:00 before the send
        let h = home("future-window");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let ahead = latest(100.0, NOW + 3 * MINUTE_MS, None);
        p.push(&snapshot(&ahead), NOW);
        assert!(sent_windows(&t).is_empty(), "ahead of the send time");
        // The liveness send 15 minutes later still carries the provider's cached value
        p.push(&snapshot(&ahead), NOW + 15 * MINUTE_MS);
        assert!(sent_windows(&t).is_empty(), "the same fetch stays out");
        // A new fetch goes out
        let newer = latest(100.0, NOW + 16 * MINUTE_MS, None);
        p.record(&newer, true, NOW + 16 * MINUTE_MS);
        p.push(&snapshot(&newer), NOW + 17 * MINUTE_MS);
        assert_eq!(sent_windows(&t), [iso_from_ms(NOW + 16 * MINUTE_MS)]);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn an_observation_ahead_of_the_send_time_is_dropped_from_the_whole_queue() {
        // 200 good observations, then one stamped ahead; the first send takes 200, the next must not take the last one
        let h = home("future-201");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        for i in 0..200 {
            p.outbox.observations.push(Observation {
                provider: "claude".into(),
                window_id: "five_hour".into(),
                resets_at: None,
                used_percent: i as f64 / 10.0,
                observed_at: iso_from_ms(NOW - (300 - i) * MINUTE_MS),
                epoch: Some(1),
            });
        }
        p.outbox.observations.push(Observation {
            provider: "claude".into(),
            window_id: "five_hour".into(),
            resets_at: None,
            used_percent: 50.0,
            observed_at: iso_from_ms(NOW + 30 * 1000),
            epoch: Some(1),
        });
        p.push(&snapshot(&latest(10.0, NOW - MINUTE_MS, None)), NOW);
        assert!(
            p.outbox.observations.is_empty(),
            "the one ahead was dropped, the 200 sent"
        );
        let s = t.0.lock().unwrap();
        let sent = s.bodies.last().unwrap()["observations"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(sent.len(), 200);
        assert!(
            sent.iter()
                .all(|o| o["used_percent"].as_f64() != Some(50.0)),
            "the one ahead is not sent"
        );
        drop(s);
        let _ = std::fs::remove_dir_all(h);
    }

    fn flagged(used: f64, fetched_ms: i64) -> BTreeMap<String, ProviderSnapshot> {
        let mut l = latest(used, fetched_ms, None);
        let c = l.get_mut("claude").unwrap();
        c.blocked = Some(true);
        c.fetched_at = Some(iso_from_ms(fetched_ms));
        l
    }

    fn sent_flag(t: &FakeTransport) -> serde_json::Value {
        let s = t.0.lock().unwrap();
        s.bodies.last().unwrap()["snapshot"]["providers"]["claude"]["blocked"].clone()
    }

    #[test]
    fn the_limit_flag_of_a_fetch_held_back_is_not_sent_either() {
        let h = home("flag-held");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        // stamped ahead of the send time: its windows and its flag stay out
        p.push(&snapshot(&flagged(100.0, NOW + 3 * MINUTE_MS)), NOW);
        assert!(sent_windows(&t).is_empty());
        assert!(
            sent_flag(&t).is_null(),
            "a flag without windows would count as a current value"
        );
        // a trusted fetch sends both
        let fresh = flagged(100.0, NOW + 4 * MINUTE_MS);
        p.record(&fresh, true, NOW + 4 * MINUTE_MS);
        p.push(&snapshot(&fresh), NOW + 5 * MINUTE_MS);
        assert_eq!(sent_windows(&t).len(), 1);
        assert_eq!(sent_flag(&t), serde_json::Value::Bool(true));
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_fetch_carried_by_a_refused_send_is_never_sent_once_the_clock_is_fixed() {
        // 13:00 on a clock an hour ahead: refused. The clock is fixed (12:00) and a send without windows is accepted. At 13:01 the
        // provider hands back that 13:00 value (restored from its cache): after the fix and no longer ahead, but stamped by the old clock
        let h = home("refused-stamps");
        let t = FakeTransport::default();
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(422)];
            s.reply_bodies = vec![r#"{"error":"clock_skew","offset_s":3600}"#.into()];
        }
        let mut p = pusher(&h, &t, Ok(creds()));
        let fast = NOW + 60 * MINUTE_MS;
        p.push(&snapshot(&latest(40.0, fast, None)), fast);
        assert!(p.clock_skewed());
        // the first try after the clock went back only restarts the backoff from the corrected time
        p.push(&snapshot(&BTreeMap::new()), NOW + 2 * MINUTE_MS);
        p.push(&snapshot(&BTreeMap::new()), NOW + 10 * MINUTE_MS);
        assert!(!p.clock_skewed(), "accepted");
        let mut again = pusher(&h, &t, Ok(creds()));
        let cached = latest(40.0, fast, None);
        again.record(&cached, true, fast + MINUTE_MS);
        again.push(&snapshot(&cached), fast + MINUTE_MS);
        assert!(sent_windows(&t).is_empty(), "remembered across a restart");
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn every_fetch_found_ahead_is_remembered_not_only_the_last_per_window() {
        // the current value at 12:06:30 and a queued one at 12:06:00 of the same window, both ahead of a 12:04 send
        let h = home("two-ahead");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let later = NOW + 6 * MINUTE_MS + 30_000;
        p.outbox.observations.push(Observation {
            provider: "claude".into(),
            window_id: "five_hour".into(),
            resets_at: None,
            used_percent: 30.0,
            observed_at: iso_from_ms(NOW + 6 * MINUTE_MS),
            epoch: Some(1),
        });
        p.push(&snapshot(&latest(40.0, later, None)), NOW + 4 * MINUTE_MS);
        assert!(sent_windows(&t).is_empty());
        // once the time has caught up, the current value still stays out
        p.push(&snapshot(&latest(40.0, later, None)), NOW + 20 * MINUTE_MS);
        assert!(
            sent_windows(&t).is_empty(),
            "the queued fetch didn't replace the current one's mark"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    fn flag_only(fetched_ms: i64) -> BTreeMap<String, ProviderSnapshot> {
        let mut p = ProviderSnapshot::empty(ProviderStatus::Ok, "", None);
        p.error = None;
        p.blocked = Some(true);
        p.fetched_at = Some(iso_from_ms(fetched_ms));
        BTreeMap::from([("codex".to_string(), p)])
    }

    fn sent_provider(t: &FakeTransport, provider: &str) -> serde_json::Value {
        let s = t.0.lock().unwrap();
        s.bodies.last().unwrap()["snapshot"]["providers"][provider].clone()
    }

    #[test]
    fn a_limit_flag_without_windows_fetched_ahead_stays_out_once_the_time_catches_up() {
        let h = home("flag-only");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let ahead = flag_only(NOW + 3 * MINUTE_MS);
        p.push(&snapshot(&ahead), NOW);
        assert!(sent_provider(&t, "codex")["blocked"].is_null());
        p.push(&snapshot(&ahead), NOW + 20 * MINUTE_MS);
        assert!(
            sent_provider(&t, "codex")["blocked"].is_null(),
            "the same fetch, now in the past"
        );
        let fresh = flag_only(NOW + 21 * MINUTE_MS);
        p.record(&fresh, true, NOW + 21 * MINUTE_MS);
        p.push(&snapshot(&fresh), NOW + 22 * MINUTE_MS);
        assert_eq!(
            sent_provider(&t, "codex")["blocked"],
            serde_json::Value::Bool(true)
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_fetch_seen_while_the_clock_is_refused_is_never_sent() {
        // refused at 13:00 (an hour ahead); a statusLine value at 13:00:20 comes while waiting; the clock is fixed, a probe is accepted,
        // and at 13:01 the provider hands that value back
        let h = home("seen-refused");
        let t = FakeTransport::default();
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(422)];
            s.reply_bodies = vec![r#"{"error":"clock_skew","offset_s":3600}"#.into()];
        }
        let mut p = pusher(&h, &t, Ok(creds()));
        let fast = NOW + 60 * MINUTE_MS;
        p.push(&snapshot(&latest(40.0, fast, None)), fast);
        let seen = latest(41.0, fast + 20_000, None);
        p.record(&seen, true, fast + 20_000);
        p.push(&snapshot(&BTreeMap::new()), NOW + 2 * MINUTE_MS);
        p.push(&snapshot(&BTreeMap::new()), NOW + 10 * MINUTE_MS);
        assert!(!p.clock_skewed());
        p.record(&seen, true, fast + MINUTE_MS);
        p.push(&snapshot(&seen), fast + MINUTE_MS);
        assert!(sent_windows(&t).is_empty());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn with_a_window_held_back_the_provider_time_is_the_oldest_sent() {
        // the weekly window was fetched before the fix (held back), the 5-hour one after it
        let h = home("oldest-sent");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        p.outbox.distrust_until_ms = Some(NOW);
        let mut l = latest(40.0, NOW + 10 * MINUTE_MS, None);
        let c = l.get_mut("claude").unwrap();
        c.windows.push(
            make_window("seven_day", 7.0, Some(NOW + 3 * 24 * 60 * MINUTE_MS))
                .with_fetched_ms(NOW - 5 * MINUTE_MS),
        );
        c.fetched_at = Some(iso_from_ms(NOW - 5 * MINUTE_MS));
        p.record(&l, true, NOW + 10 * MINUTE_MS);
        p.push(&snapshot(&l), NOW + 11 * MINUTE_MS);
        assert_eq!(sent_windows(&t), [iso_from_ms(NOW + 10 * MINUTE_MS)]);
        assert_eq!(
            sent_provider(&t, "claude")["fetched_at"],
            serde_json::Value::String(iso_from_ms(NOW + 10 * MINUTE_MS))
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn the_first_accepted_send_after_a_refusal_marks_its_own_millisecond_too() {
        let h = home("same-ms");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        refuse(&h);
        p.push(&snapshot(&BTreeMap::new()), NOW);
        assert_eq!(p.outbox.distrust_until_ms, Some(NOW));
        let both = {
            let mut l = latest(40.0, NOW, None);
            l.get_mut("claude").unwrap().windows.push(
                make_window("seven_day", 7.0, Some(NOW + 3 * 24 * 60 * MINUTE_MS))
                    .with_fetched_ms(NOW + 1),
            );
            l
        };
        p.record(&both, true, NOW + MINUTE_MS);
        p.push(&snapshot(&both), NOW + MINUTE_MS);
        assert_eq!(
            sent_windows(&t),
            [iso_from_ms(NOW + 1)],
            "the same millisecond stays out, the next one goes"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn marks_survive_a_clock_that_jumps_days_ahead_and_back() {
        // 12:03 seen ahead of a 12:00 send; then the clock jumps 2 days ahead (the send fails) and comes back to 12:04
        let h = home("jump-ahead");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let ahead = latest(40.0, NOW + 3 * MINUTE_MS, None);
        p.push(&snapshot(&ahead), NOW);
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(500)];
        }
        p.push(&snapshot(&ahead), NOW + 2 * 24 * 60 * MINUTE_MS);
        p.push(&snapshot(&ahead), NOW + 4 * MINUTE_MS);
        p.push(&snapshot(&ahead), NOW + 20 * MINUTE_MS);
        assert!(sent_windows(&t).is_empty(), "still marked");
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn marks_stay_a_few_per_window_while_the_clock_is_refused_for_long() {
        let h = home("marks-cap");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        refuse(&h);
        for i in 0..100 {
            p.record(
                &latest(40.0, NOW + i * 5 * MINUTE_MS, None),
                true,
                NOW + i * 5 * MINUTE_MS,
            );
        }
        let windows = p
            .outbox
            .future_stamps
            .seen
            .keys()
            .filter(|k| k.starts_with("claude.five_hour "))
            .count();
        assert_eq!(windows, MARKS_PER_KEY);
        assert!(
            p.outbox
                .future_stamps
                .contains("claude.five_hour", &iso_from_ms(NOW + 99 * 5 * MINUTE_MS)),
            "the newest is kept"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_new_mark_stays_even_behind_marks_further_ahead() {
        // four marks from a clock far ahead, then a small step back marks a value 3 minutes ahead: it is kept
        let h = home("marks-keep-new");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        for i in 0..MARKS_PER_KEY as i64 {
            p.outbox.future_stamps.note(&[(
                "claude.five_hour".to_string(),
                iso_from_ms(NOW + (60 + i) * 60 * MINUTE_MS),
            )]);
        }
        let ahead = latest(40.0, NOW + 3 * MINUTE_MS, None);
        p.push(&snapshot(&ahead), NOW);
        p.push(&snapshot(&ahead), NOW + 20 * MINUTE_MS);
        assert!(
            sent_windows(&t).is_empty(),
            "still marked once the time caught up"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn the_local_view_leaves_out_what_the_push_state_holds_back() {
        let h = home("local-view");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        // marked ahead at a 12:00 send
        let ahead = latest(40.0, NOW + 3 * MINUTE_MS, None);
        p.push(&snapshot(&ahead), NOW);
        let shown = trusted_local(&h, &ahead, NOW + 20 * MINUTE_MS, true);
        assert!(
            shown["claude"].windows.is_empty(),
            "the marked fetch stays out of status"
        );
        // while the clock is refused, nothing is shown
        refuse(&h);
        p.save();
        let fresh = latest(41.0, NOW + 21 * MINUTE_MS, None);
        assert!(
            trusted_local(&h, &fresh, NOW + 22 * MINUTE_MS, true)["claude"]
                .windows
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_mark_of_a_value_still_held_stays_past_24_hours() {
        let h = home("mark-held");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let ahead = latest(40.0, NOW + 3 * MINUTE_MS, None);
        p.push(&snapshot(&ahead), NOW);
        // two days later the provider still hands back that cached value
        let later = NOW + 2 * 24 * 60 * MINUTE_MS;
        p.push(&snapshot(&ahead), later);
        p.push(&snapshot(&ahead), later + 20 * MINUTE_MS);
        assert!(sent_windows(&t).is_empty(), "still marked while it is held");
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn staleness_that_came_from_a_window_held_back_goes_with_it() {
        let h = home("stale-held");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        p.outbox.distrust_until_ms = Some(NOW);
        let mut l = latest(40.0, NOW + 10 * MINUTE_MS, None);
        let c = l.get_mut("claude").unwrap();
        c.windows.push(
            make_window("seven_day", 7.0, Some(NOW + 3 * 24 * 60 * MINUTE_MS))
                .with_fetched_ms(NOW - 30 * MINUTE_MS),
        );
        c.fetched_at = Some(iso_from_ms(NOW - 30 * MINUTE_MS));
        c.status = ProviderStatus::Stale;
        c.error = Some("Not updated for 40m".into());
        p.record(&l, true, NOW + 10 * MINUTE_MS);
        p.push(&snapshot(&l), NOW + 11 * MINUTE_MS);
        let sent = sent_provider(&t, "claude");
        assert_eq!(sent["status"], serde_json::json!("ok"));
        assert!(sent["error"].is_null());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_mark_stays_while_its_value_is_not_shown_for_a_while() {
        // the value is marked, then the provider shows nothing for two days (its CLI was missing), then hands it back
        let h = home("mark-absent");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let ahead = latest(40.0, NOW + 3 * MINUTE_MS, None);
        p.push(&snapshot(&ahead), NOW);
        let later = NOW + 2 * 24 * 60 * MINUTE_MS;
        p.push(&snapshot(&BTreeMap::new()), later);
        p.push(&snapshot(&ahead), later + 20 * MINUTE_MS);
        assert!(sent_windows(&t).is_empty());
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_refused_send_remembers_the_latest_values_not_the_whole_queue() {
        let h = home("refused-queue");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        // eight observations of the same window queued (the destination couldn't be reached before)
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(422)];
            s.reply_bodies = vec![r#"{"error":"clock_skew","offset_s":3600}"#.into()];
        }
        for i in 0..8 {
            p.outbox.observations.push(Observation {
                provider: "claude".into(),
                window_id: "five_hour".into(),
                resets_at: None,
                used_percent: i as f64,
                observed_at: iso_from_ms(NOW - (8 - i) * 10 * MINUTE_MS),
                epoch: Some(1),
            });
        }
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 4 * MINUTE_MS);
        assert!(p.clock_skewed());
        assert_eq!(
            p.outbox.future_stamps.seen.len(),
            1,
            "only the latest value (the window)"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_provider_with_every_window_held_back_has_no_fetch_time_and_says_why() {
        let h = home("all-held");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let mut ahead = latest(40.0, NOW + 3 * MINUTE_MS, None);
        ahead.get_mut("claude").unwrap().fetched_at = Some(iso_from_ms(NOW + 3 * MINUTE_MS));
        p.push(&snapshot(&ahead), NOW);
        let shown = p.shown(&ahead, NOW + 20 * MINUTE_MS);
        assert!(shown["claude"].windows.is_empty());
        assert!(shown["claude"].fetched_at.is_none());
        assert_eq!(shown["claude"].status, ProviderStatus::Stale);
        // a stale window held back, a 20-minute-old one left: the text says 20m
        let mut l = latest(40.0, NOW - 20 * MINUTE_MS, None);
        let c = l.get_mut("claude").unwrap();
        c.windows.push(
            make_window("seven_day", 7.0, Some(NOW + 3 * 24 * 60 * MINUTE_MS))
                .with_fetched_ms(NOW - 600 * MINUTE_MS),
        );
        c.status = ProviderStatus::Stale;
        c.error = Some("Not updated for 600m".into());
        p.outbox.distrust_until_ms = Some(NOW - 300 * MINUTE_MS);
        let shown = p.shown(&l, NOW);
        assert_eq!(
            shown["claude"].error.as_deref(),
            Some("Not updated for 20m")
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn the_local_view_is_as_fetched_when_pushing_is_not_set_up() {
        let h = home("local-nopush");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        // an earlier version's refusal left in the push state says nothing without pushing
        p.outbox.clock_skewed = true;
        p.save();
        let fresh = latest(41.0, NOW, None);
        assert_eq!(
            trusted_local(&h, &fresh, NOW, false)["claude"]
                .windows
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn a_push_state_written_with_an_earlier_form_of_the_marks_keeps_its_queue_and_marks() {
        for (name, marks) in [
            (
                "pairs",
                r#"[["claude.five_hour","2026-11-16T12:03:00.000Z"]]"#,
            ),
            (
                "per-key",
                r#"{"claude.five_hour":"2026-11-16T12:03:00.000Z"}"#,
            ),
        ] {
            let h = home(&format!("old-marks-{name}"));
            let body = format!(
                r#"{{"version":1,"last_seq":7,"observations":[{{"provider":"claude","window_id":"five_hour","resets_at":null,"used_percent":5.0,"observed_at":"2026-11-16T11:00:00.000Z"}}],"failures":2,"retry_at_ms":123,"future_stamps":{marks}}}"#
            );
            std::fs::write(h.join(OUTBOX_FILE), body).unwrap();
            let o = Outbox::read(&h.join(OUTBOX_FILE)).expect(name);
            assert_eq!(o.observations.len(), 1, "{name}");
            assert_eq!(
                (o.last_seq, o.failures, o.retry_at_ms),
                (Some(7), 2, Some(123)),
                "{name}"
            );
            assert!(
                o.future_stamps
                    .contains("claude.five_hour", "2026-11-16T12:03:00.000Z"),
                "{name}"
            );
            let _ = std::fs::remove_dir_all(h);
        }
    }

    #[test]
    fn a_limit_flag_alone_whose_fetch_is_marked_leaves_no_fetch_time_nor_ok() {
        let h = home("flag-alone-shown");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let ahead = flag_only(NOW + 3 * MINUTE_MS);
        p.push(&snapshot(&ahead), NOW);
        let shown = p.shown(&ahead, NOW + 20 * MINUTE_MS);
        assert!(shown["codex"].fetched_at.is_none());
        assert!(shown["codex"].blocked.is_none());
        assert_eq!(shown["codex"].status, ProviderStatus::Stale);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn g1_b_discarding_the_queue_leaves_no_old_observation_and_the_next_number_above() {
        // a PUT the Worker accepted whose reply was lost: its observations are still queued
        let h = home("g1b");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        {
            // the Worker accepts the PUT, but the reply is lost: the observation stays queued
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Err(SendError::Network)];
        }
        p.record(&latest(40.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1, "sent once");
        // a stored number above any time-based one (the next must still be above it)
        let stored = NOW * 1000;
        p.outbox.last_seq = Some(stored);
        p.save();
        assert!(
            Pusher::status_line(&h)
                .unwrap()
                .starts_with("Push: 1 unsent")
        );
        assert_eq!(Pusher::discard_queue(&h), Ok(Some(1)));
        assert!(
            Pusher::status_line(&h)
                .unwrap()
                .starts_with("Push: 0 unsent"),
            "checked to be 0"
        );
        // restarted: the next send carries no old observation, under a number above the stored one
        let mut again = pusher(&h, &t, Ok(creds()));
        again.push(
            &snapshot(&latest(41.0, NOW + MINUTE_MS, None)),
            NOW + MINUTE_MS,
        );
        let s = t.0.lock().unwrap();
        let body = s.bodies.last().unwrap();
        assert!(body["observations"].as_array().unwrap().is_empty());
        assert!(body["seq"].as_i64().unwrap() > stored);
        drop(s);
        // a state that can't be read: the count is unknown, and nothing is discarded
        std::fs::write(h.join(OUTBOX_FILE), "{not json").unwrap();
        assert!(Pusher::status_line(&h).unwrap().contains("unknown"));
        assert!(Pusher::discard_queue(&h).is_err());
        let _ = std::fs::remove_dir_all(h);
    }

    // ---- Trust in this PC's clock by epoch, across the agent's rounds, restarts, sends and a manual acceptance

    /// Moves the clock state to a new epoch, refused (as a 422 does)
    fn refuse(h: &Path) {
        let _lock = hold_clock_lock(h).unwrap();
        let state = ensure_locked(h, || Ok(false)).unwrap();
        advance_locked(h, &state, false).unwrap();
    }

    fn state(h: &Path) -> ClockEpoch {
        match clock_epoch(h) {
            EpochRead::Read {
                epoch,
                trusted,
                in_flight,
            } => ClockEpoch {
                epoch,
                trusted,
                in_flight,
            },
            other => panic!("{other:?}"),
        }
    }

    static ROUND_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    fn round_clock() -> i64 {
        ROUND_MS.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// What a provider cached, kept outside it (as in its state file), with the epoch it was taken in. Handed back only in that epoch
    #[derive(Default)]
    struct Cache {
        value: Option<(i64, u64)>,
        fetches: u32,
    }

    struct Caching(std::rc::Rc<std::cell::RefCell<Cache>>, PathBuf);

    impl crate::providers::Provider for Caching {
        fn id(&self) -> &'static str {
            "claude"
        }
        fn next_due_ms(&self, now: i64) -> i64 {
            now
        }
        fn collect(&mut self, now: i64, _force: bool) -> ProviderSnapshot {
            let epoch = usable_epoch(&self.1).expect("collected only under a usable epoch");
            let mut c = self.0.borrow_mut();
            let at = match c.value {
                Some((at, e)) if e == epoch => at,
                _ => {
                    c.fetches += 1;
                    c.value = Some((now, epoch));
                    now
                }
            };
            latest(40.0, at, None).remove("claude").unwrap()
        }
    }

    #[test]
    fn g3_b_the_agent_fetches_nothing_while_refused_and_the_refused_epochs_values_never_come_back()
    {
        let h = home("g3b-rounds");
        let t = FakeTransport::default();
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(422)];
            s.reply_bodies = vec![r#"{"error":"clock_skew","offset_s":3600}"#.into()];
        }
        let cache = std::rc::Rc::new(std::cell::RefCell::new(Cache::default()));
        let providers = || -> Vec<Box<dyn crate::providers::Provider>> {
            vec![Box::new(Caching(cache.clone(), h.to_path_buf()))]
        };
        // pushing is set up (as the agent's config says)
        let mut cfg = crate::config::Config::default();
        cfg.push.url = "https://x.example/v2/snapshots/mac".into();
        let new_round = || crate::agent::Round::new(&cfg, "mac", Logger::stderr(), round_clock, &h);
        let at = |m: i64| ROUND_MS.store(NOW + m * MINUTE_MS, std::sync::atomic::Ordering::SeqCst);
        let mut p = pusher(&h, &t, Ok(creds()));
        let (mut list, mut round) = (providers(), new_round());
        at(0);
        round.run(&mut list, Some(&mut p));
        assert_eq!(cache.borrow().fetches, 1);
        assert!(p.clock_skewed(), "refused by the send");
        assert!(round.latest.is_empty());
        let refused = state(&h).epoch;
        // restarted while refused: nothing is fetched, nothing shown
        let mut again = pusher(&h, &t, Ok(creds()));
        let (mut list, mut round) = (providers(), new_round());
        at(5);
        round.run(&mut list, Some(&mut again));
        assert_eq!(cache.borrow().fetches, 1, "no fetch while refused");
        assert!(again.shown(&round.latest, NOW + 5 * MINUTE_MS).is_empty());
        // the check goes through: a new epoch, trusted
        assert!(!again.clock_skewed());
        assert!(state(&h).epoch > refused);
        // the value cached before is of another epoch: fetched anew, and only the new one goes out
        at(10);
        round.run(&mut list, Some(&mut again));
        assert_eq!(cache.borrow().fetches, 2);
        assert_eq!(sent_windows(&t), [iso_from_ms(NOW + 10 * MINUTE_MS)]);
    }

    /// A provider that never fetches and whose tidying answers from a list (true once it runs out), counting the tries
    struct Tidying(std::rc::Rc<std::cell::RefCell<(Vec<bool>, u32)>>);

    impl crate::providers::Provider for Tidying {
        fn id(&self) -> &'static str {
            "claude"
        }
        fn next_due_ms(&self, _now: i64) -> i64 {
            i64::MAX
        }
        fn collect(&mut self, _now: i64, _force: bool) -> ProviderSnapshot {
            ProviderSnapshot::empty(ProviderStatus::Ok, "", None)
        }
        fn forget_cached(&mut self) -> bool {
            let mut t = self.0.borrow_mut();
            t.1 += 1;
            if t.0.is_empty() { true } else { t.0.remove(0) }
        }
    }

    #[test]
    fn g3_e_tidying_that_failed_after_an_epoch_change_is_tried_again_on_the_next_rounds() {
        let h = home("tidy-again");
        crate::test_util::trust_clock(&h);
        let tidy = std::rc::Rc::new(std::cell::RefCell::new((vec![false, false], 0)));
        let mut list: Vec<Box<dyn crate::providers::Provider>> =
            vec![Box::new(Tidying(tidy.clone()))];
        let cfg = crate::config::Config::default();
        let mut round = crate::agent::Round::new(&cfg, "mac", Logger::stderr(), round_clock, &h);
        // the first round sees the epoch (a change from none): tidying fails, then fails again, then works; then it stops trying
        for _ in 0..4 {
            round.run(&mut list, None);
        }
        assert_eq!(tidy.borrow().1, 3);
    }

    #[test]
    fn g1_h_nothing_is_fetched_while_the_push_state_cant_be_read() {
        let h = home("fetch-unreadable");
        let t = FakeTransport::default();
        std::fs::create_dir(h.join(OUTBOX_FILE)).unwrap();
        let mut p = pusher(&h, &t, Ok(creds()));
        let cache = std::rc::Rc::new(std::cell::RefCell::new(Cache::default()));
        let mut list: Vec<Box<dyn crate::providers::Provider>> =
            vec![Box::new(Caching(cache.clone(), h.to_path_buf()))];
        let mut cfg = crate::config::Config::default();
        cfg.push.url = "https://x.example/v2/snapshots/mac".into();
        let mut round = crate::agent::Round::new(&cfg, "mac", Logger::stderr(), round_clock, &h);
        ROUND_MS.store(NOW, std::sync::atomic::Ordering::SeqCst);
        round.run(&mut list, Some(&mut p));
        assert_eq!(
            cache.borrow().fetches,
            0,
            "whether this agent is refused can't be told"
        );
        // readable again: fetched
        std::fs::remove_dir(h.join(OUTBOX_FILE)).unwrap();
        round.run(&mut list, Some(&mut p));
        assert_eq!(cache.borrow().fetches, 1);
    }

    #[test]
    fn g3_a_a_send_doesnt_start_while_an_acceptance_holds_the_clock_lock() {
        let h = home("g3a-lock");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let accepting = hold_clock_lock(&h).unwrap();
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(t.0.lock().unwrap().bodies.is_empty(), "not sent meanwhile");
        assert_eq!(state(&h).in_flight, None, "nothing pending either");
        drop(accepting);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1);
        assert_eq!(state(&h).in_flight, None, "the result is saved");
    }

    #[test]
    fn g3_d_a_send_whose_result_wasnt_saved_holds_everything_until_a_check_goes_through() {
        let h = home("g3d");
        let t = FakeTransport::default();
        let p = pusher(&h, &t, Ok(creds()));
        // stopped after the request, before saving its result
        assert!(p.begin_send().unwrap().is_some());
        let before = state(&h);
        assert_eq!(before.in_flight, Some(before.epoch));
        assert_eq!(usable_epoch(&h), None, "nothing accepted or used meanwhile");
        let held = trusted_local(&h, &latest(40.0, NOW, None), NOW, true);
        assert!(held["claude"].windows.is_empty());
        // restarted: taken as refused; the next send only checks the clock, and its success trusts a new epoch
        let mut again = pusher(&h, &t, Ok(creds()));
        again.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(sent_windows(&t).is_empty(), "a check carries no values");
        let after = state(&h);
        assert!(after.trusted && after.epoch > before.epoch + 1);
        // the control: a send whose result is saved leaves the epoch as it was
        let ok = home("g3d-ok");
        let mut p = pusher(&ok, &t, Ok(creds()));
        let epoch = state(&ok).epoch;
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(
            state(&ok),
            ClockEpoch {
                epoch,
                trusted: true,
                in_flight: None
            }
        );
    }

    #[test]
    fn g3_h_a_lost_answer_is_taken_as_a_refusal_one_that_never_left_isnt() {
        let h = home("g3h");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Err(SendError::Network)];
        let mut p = pusher(&h, &t, Ok(creds()));
        let epoch = state(&h).epoch;
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(p.clock_skewed(), "the destination may have refused");
        assert!(state(&h).epoch > epoch);
        // a check goes through: trusted again
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 5 * MINUTE_MS);
        assert!(!p.clock_skewed());
        // the control: a request that never reached the destination changes nothing
        let n = home("g3h-not-sent");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Err(SendError::NotSent)];
        let mut p = pusher(&n, &t, Ok(creds()));
        let epoch = state(&n).epoch;
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(
            state(&n),
            ClockEpoch {
                epoch,
                trusted: true,
                in_flight: None
            }
        );
    }

    #[test]
    fn g3_g_a_clock_lock_that_cant_be_opened_sends_nothing_until_it_can() {
        let h = home("g3g");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        std::fs::create_dir(h.join(CLOCK_LOCK_FILE)).unwrap();
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(t.0.lock().unwrap().bodies.is_empty());
        std::fs::remove_dir(h.join(CLOCK_LOCK_FILE)).unwrap();
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1);
    }

    #[test]
    fn g3_i_a_clock_state_that_cant_be_read_for_now_shows_and_sends_nothing() {
        let h = home("g3i");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let saved = std::fs::read(h.join(crate::clock::CLOCK_EPOCH_FILE)).unwrap();
        std::fs::remove_file(h.join(crate::clock::CLOCK_EPOCH_FILE)).unwrap();
        std::fs::create_dir(h.join(crate::clock::CLOCK_EPOCH_FILE)).unwrap();
        assert!(
            trusted_local(&h, &latest(40.0, NOW, None), NOW, true)["claude"]
                .windows
                .is_empty()
        );
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(
            t.0.lock().unwrap().bodies.is_empty(),
            "nothing replaced or sent on a guess"
        );
        // readable again: as before
        std::fs::remove_dir(h.join(crate::clock::CLOCK_EPOCH_FILE)).unwrap();
        std::fs::write(h.join(crate::clock::CLOCK_EPOCH_FILE), saved).unwrap();
        assert_eq!(
            trusted_local(&h, &latest(40.0, NOW, None), NOW, true)["claude"]
                .windows
                .len(),
            1
        );
    }

    #[test]
    fn an_earlier_versions_refusal_starts_the_clock_state_refused_and_its_unreadable_state_makes_none()
     {
        let h = home("first-refused");
        std::fs::write(h.join(OUTBOX_FILE), r#"{"version":1,"clock_skewed":true}"#).unwrap();
        assert!(!ensure_clock(&h).unwrap().trusted);
        let ok = home("first-ok");
        std::fs::write(
            ok.join(OUTBOX_FILE),
            r#"{"version":1,"clock_skewed":false}"#,
        )
        .unwrap();
        assert!(ensure_clock(&ok).unwrap().trusted);
        let broken = home("first-unreadable");
        std::fs::write(broken.join(OUTBOX_FILE), "{broken").unwrap();
        assert!(ensure_clock(&broken).is_err(), "not made on a guess");
        assert_eq!(clock_epoch(&broken), EpochRead::Missing);
        assert!(
            trusted_local(&broken, &latest(40.0, NOW, None), NOW, true)["claude"]
                .windows
                .is_empty()
        );
    }

    #[test]
    fn discarding_the_queue_moves_the_epoch_so_nothing_taken_before_is_sent_also_if_the_queue_stays()
     {
        let h = home("discard-epoch");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        p.record(&latest(40.0, NOW, None), true, NOW);
        let before = state(&h).epoch;
        assert_eq!(Pusher::discard_queue(&h), Ok(Some(1)));
        let after = state(&h);
        assert!(after.trusted && after.epoch > before);
        // the old pusher still holds the observation in memory (as a queue a stop left): never sent
        p.push(&snapshot(&BTreeMap::new()), NOW + MINUTE_MS);
        let body = t.0.lock().unwrap().bodies.last().cloned().unwrap();
        assert_eq!(body["observations"], json!([]));
    }

    #[test]
    fn g3_h_a_422_whose_body_couldnt_be_read_is_still_a_refusal() {
        let h = home("422-empty");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Ok(422)];
        let mut p = pusher(&h, &t, Ok(creds()));
        let epoch = state(&h).epoch;
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(p.clock_skewed());
        assert!(state(&h).epoch > epoch);
        assert!(
            p.outbox
                .last_result
                .clone()
                .unwrap()
                .contains("couldn't be read")
        );
    }

    /// Makes saving a send's result fail from the next PUT on (the clock lock file can't be opened); undone by the returned path
    fn fail_saving_after_put(h: &Path, t: &FakeTransport) -> std::path::PathBuf {
        let lock = h.join(CLOCK_LOCK_FILE);
        let at = lock.clone();
        t.0.lock().unwrap().on_put = Some(Box::new(move || {
            let _ = std::fs::remove_file(&at);
            let _ = std::fs::create_dir(&at);
        }));
        lock
    }

    #[test]
    fn g3_d_g_a_422_whose_result_couldnt_be_saved_holds_everything_and_is_saved_first_once_it_can_be()
     {
        let h = home("422-unsettled");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Ok(422)];
        let mut p = pusher(&h, &t, Ok(creds()));
        let epoch = state(&h).epoch;
        let lock = fail_saving_after_put(&h, &t);
        p.record(&latest(40.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(p.unsettled, Some((epoch, SendOutcome::Refused)));
        assert_eq!(state(&h).in_flight, Some(epoch), "still pending on disk");
        assert_eq!(
            usable_epoch(&h),
            None,
            "nothing accepted or shown meanwhile"
        );
        // still failing: nothing more is sent, however long it lasts
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 1000);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1);
        // recovered, before the backoff ends: the refusal is saved first, and by itself (one epoch on, not trusted, nothing pending,
        // still a single PUT)
        t.0.lock().unwrap().on_put = None;
        std::fs::remove_dir(&lock).unwrap();
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 2000);
        assert_eq!(
            state(&h),
            ClockEpoch {
                epoch: epoch + 1,
                trusted: false,
                in_flight: None
            }
        );
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1);
        // then a send only checks the clock; it goes through, so the clock is trusted again under a newer epoch still
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 60 * MINUTE_MS);
        let after = state(&h);
        assert!(after.epoch >= epoch + 2 && after.trusted, "{after:?}");
        assert_eq!(p.unsettled, None);
        let sent = t.0.lock().unwrap();
        assert_eq!(sent.bodies.len(), 2);
        assert_eq!(
            sent.bodies[1]["observations"],
            json!([]),
            "nothing taken in the refused epoch is sent"
        );
    }

    #[test]
    fn g3_g_a_426_whose_result_couldnt_be_saved_is_saved_once_it_can_be_though_nothing_more_is_sent()
     {
        let h = home("426-unsettled");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Ok(426)];
        let mut p = pusher(&h, &t, Ok(creds()));
        let lock = fail_saving_after_put(&h, &t);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(p.outdated() && p.unsettled.is_some());
        assert_eq!(usable_epoch(&h), None);
        t.0.lock().unwrap().on_put = None;
        std::fs::remove_dir(&lock).unwrap();
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW + 60 * MINUTE_MS);
        assert_eq!(p.unsettled, None);
        assert!(usable_epoch(&h).is_some(), "the send isn't pending anymore");
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1, "nothing more sent");
    }

    #[test]
    fn g1_h_a_426_to_the_turn_request_is_kept_too_also_after_a_restart() {
        let h = home("turn-426");
        let t = FakeTransport::default();
        t.0.lock().unwrap().post_replies = vec![(426, String::new())];
        let mut p = pusher(&h, &t, Ok(creds()));
        assert!(!p.ask_turn("claude", 5).unwrap().go);
        let mut again = pusher(&h, &t, Ok(creds()));
        assert!(again.outdated(), "kept in the outbox");
        again.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        let sent = t.0.lock().unwrap();
        assert_eq!((sent.bodies.len(), sent.posts.len()), (0, 1));
    }

    #[test]
    fn g3_d_without_pushing_a_send_left_pending_is_left_to_the_agent() {
        let h = home("nopush-pending");
        let t = FakeTransport::default();
        let p = pusher(&h, &t, Ok(creds()));
        assert!(p.begin_send().unwrap().is_some());
        let before = state(&h);
        assert!(
            trust_without_push(&h).is_err(),
            "not resolved by a collect whose config no longer pushes"
        );
        assert_eq!(state(&h), before);
        // the background agent (holding its lock) resolves it under a new epoch: nothing of the pending one is used
        let agent = trust_without_push_as_agent(&h).unwrap();
        assert!(agent.trusted && agent.in_flight.is_none() && agent.epoch > before.epoch);
        // the control: a refusal alone (no send pending) is trusted again without pushing
        let r = home("nopush-refused");
        crate::test_util::trust_clock(&r);
        refuse(&r);
        assert!(trust_without_push(&r).unwrap().trusted);
    }

    #[test]
    fn g3_d_a_result_that_couldnt_be_saved_holds_everything_and_is_saved_before_the_next_send() {
        let h = home("unsettled");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        let sending = p.begin_send().unwrap().unwrap();
        // the result can't be saved (the lock file can't be opened)
        std::fs::remove_file(h.join(CLOCK_LOCK_FILE)).unwrap();
        std::fs::create_dir(h.join(CLOCK_LOCK_FILE)).unwrap();
        assert!(p.settle(sending.epoch, SendOutcome::Cleared).is_err());
        p.unsettled = Some((sending.epoch, SendOutcome::Cleared));
        assert_eq!(
            usable_epoch(&h),
            None,
            "nothing accepted or shown meanwhile"
        );
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(
            t.0.lock().unwrap().bodies.is_empty(),
            "nothing sent before the result is saved"
        );
        // the lock can be taken again: the result is saved first, then sending goes on
        std::fs::remove_dir(h.join(CLOCK_LOCK_FILE)).unwrap();
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert_eq!(t.0.lock().unwrap().bodies.len(), 1);
        assert_eq!(state(&h).in_flight, None);
    }

    #[test]
    fn g1_b_an_outbox_that_cant_be_read_for_now_is_neither_replaced_nor_sent_from() {
        let h = home("outbox-unreadable");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        p.outbox.last_seq = Some(NOW * 1000);
        p.save();
        let saved = std::fs::read(h.join(OUTBOX_FILE)).unwrap();
        std::fs::remove_file(h.join(OUTBOX_FILE)).unwrap();
        std::fs::create_dir(h.join(OUTBOX_FILE)).unwrap();
        let mut again = pusher(&h, &t, Ok(creds()));
        again.record(&latest(40.0, NOW, None), true, NOW);
        again.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(t.0.lock().unwrap().bodies.is_empty(), "not sent");
        assert!(
            trusted_local(&h, &latest(40.0, NOW, None), NOW, true)["claude"]
                .windows
                .is_empty()
        );
        // readable again: its number is kept, so the next send goes above it
        std::fs::remove_dir(h.join(OUTBOX_FILE)).unwrap();
        std::fs::write(h.join(OUTBOX_FILE), saved).unwrap();
        again.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        let body = t.0.lock().unwrap().bodies.last().cloned().unwrap();
        assert!(body["seq"].as_i64().unwrap() > NOW * 1000);
    }

    #[test]
    fn g1_h_after_a_426_this_agent_sends_and_fetches_nothing_more_also_after_a_restart() {
        let h = home("outdated");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Ok(426)];
        let mut p = pusher(&h, &t, Ok(creds()));
        p.record(&latest(40.0, NOW, None), true, NOW);
        p.push(&snapshot(&latest(40.0, NOW, None)), NOW);
        assert!(p.outdated());
        let seq = p.outbox.last_seq;
        // long after any backoff, and after a restart: no request, the queue and its number kept
        let mut again = pusher(&h, &t, Ok(creds()));
        again.push(
            &snapshot(&latest(40.0, NOW, None)),
            NOW + 24 * 60 * MINUTE_MS,
        );
        let reply = again.ask_turn("claude", 5).unwrap();
        let sent = t.0.lock().unwrap();
        assert_eq!((sent.bodies.len(), sent.posts.len()), (1, 0));
        drop(sent);
        assert!(!reply.go, "no fetch on its own either");
        assert_eq!(
            (again.outbox.observations.len(), again.outbox.last_seq),
            (1, seq)
        );
        // the control: an agent of another protocol (updated) sends again
        again.outbox.outdated_protocol = Some("1".into());
        assert!(!again.outdated());
    }

    static CLOCK_MS: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    fn test_clock() -> i64 {
        CLOCK_MS.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[test]
    fn the_send_time_is_read_from_the_clock_after_the_credentials() {
        // the clock was synced while the credentials were read
        let h = home("send-clock");
        let t = FakeTransport::default();
        let mut p = pusher(&h, &t, Ok(creds()));
        p.clock = Some(test_clock);
        CLOCK_MS.store(NOW + 30 * 1000, std::sync::atomic::Ordering::SeqCst);
        p.push(&snapshot(&latest(10.0, NOW, None)), NOW + 10 * MINUTE_MS);
        let s = t.0.lock().unwrap();
        assert_eq!(
            s.bodies.last().unwrap()["snapshot"]["generated_at"],
            iso_from_ms(NOW + 30 * 1000)
        );
        drop(s);
        assert_eq!(
            p.outbox.last_success_ms,
            Some(NOW + 30 * 1000),
            "the next send waits from the send time"
        );
        // A 503 asks to wait 12 hours: counted from the send time too
        {
            let mut s = t.0.lock().unwrap();
            s.replies = vec![Ok(503)];
            s.reply_bodies = vec![r#"{"error":"d1_budget","retry_after_s":43200}"#.into()];
        }
        CLOCK_MS.store(NOW + 60 * MINUTE_MS, std::sync::atomic::Ordering::SeqCst);
        p.record(
            &latest(11.0, NOW + MINUTE_MS, None),
            true,
            NOW + 2 * MINUTE_MS,
        );
        p.push(
            &snapshot(&latest(11.0, NOW + MINUTE_MS, None)),
            NOW + 2 * MINUTE_MS,
        );
        assert_eq!(
            p.outbox.retry_at_ms,
            Some(NOW + 60 * MINUTE_MS + 43_200_000)
        );
        let _ = std::fs::remove_dir_all(h);
    }
}
