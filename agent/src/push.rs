//! Pushing to the destination, with retries. Only the background agent (`headroom agent`) pushes.
//!
//! - Observations: one per change of a provider window's `fetched_at` (sent even if the value is unchanged). Providers in `account_changed` are not sent.
//! - Account switches: unsent observations of a provider that became `account_changed` are dropped. On first seeing a new `history_since`
//!   (switch accepted), all observations queued so far for that provider are dropped regardless of their time (so the previous
//!   account's values are never sent, even if the switch and acceptance happened during an outage or after a clock fix).
//! - Unsent observations are queued in `~/.headroom/outbox.json` (up to 24 hours / 5,000 entries) and removed once sent.
//! - The send sequence number `seq` comes from `next_send_seq()`. The destination replaces each PC's latest value by this number.
//! - On failure, wait from 1 minute, doubling up to 60 minutes. Observations in a request whose body is rejected (400, 413) are dropped (so the same body is not sent forever).
//! - Credentials are read from the OS credential store and never written to logs or files.
//! - Redirects (3xx) are not followed; following them could send the credential header to another host.
//! - 409 (observations stored, but `seq` was not above the stored one, so the latest value was not replaced) is not a success. Resend once
//!   with a number above the stored `seq` from the reply (so the latest value arrives even after losing local state or fixing the clock).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::config::{Config, explicit_collector_id};
use crate::schedule::{TurnAsker, TurnReply};
use crate::schema::{ErrorCode, ProviderSnapshot, Snapshot};
use crate::store::{Logger, backoff_ms, next_send_seq, read_json, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms};

pub const OUTBOX_FILE: &str = "outbox.json";
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
    /// Cannot connect, timeout, etc.
    Network,
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
            .map_err(|_| SendError::Network)?;
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
    home: PathBuf,
    endpoint: String,
    log: Logger,
    transport: Box<dyn Transport>,
    credentials: Box<dyn CredentialStore>,
    pub outbox: Outbox,
    /// The latest value changed since the last send (also sent once right after startup)
    dirty: bool,
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
        Ok(Some(Self::new(
            home,
            &format!("{base}/v2/snapshots/{collector}"),
            log,
            Box::new(HttpTransport::new()),
            Box::new(OsCredentialStore),
        )))
    }

    pub fn new(
        home: &Path,
        endpoint: &str,
        log: Logger,
        transport: Box<dyn Transport>,
        credentials: Box<dyn CredentialStore>,
    ) -> Self {
        Self {
            home: home.to_path_buf(),
            endpoint: endpoint.to_string(),
            log,
            transport,
            credentials,
            outbox: read_json(&home.join(OUTBOX_FILE)).unwrap_or_default(),
            dirty: true,
        }
    }

    /// Extracts new observations from the latest values and queues them. If the latest value changed, it is sent next
    pub fn record(&mut self, latest: &BTreeMap<String, ProviderSnapshot>, changed: bool, now: i64) {
        self.dirty |= changed;
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
            if snap.error_code == Some(ErrorCode::AccountChanged) {
                continue;
            }
            for w in &snap.windows {
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
                    window_id: w.id.clone(),
                    resets_at: w.resets_at.clone(),
                    used_percent: w.used_percent,
                    observed_at: at.clone(),
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
        if write_json_atomic(&self.home.join(OUTBOX_FILE), &self.outbox).is_err() {
            self.log
                .log("Cannot write outbox.json (unsent observations may be lost on restart)");
        }
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

    /// Credential header for the Worker
    fn auth_headers(&self) -> Result<Vec<(&'static str, String)>, String> {
        let creds = self.credentials.load()?;
        Ok(vec![("Authorization", format!("Bearer {}", creds.token))])
    }

    /// Sends when due; queued observations go out in chunks of the per-request limit.
    // Every branch ends with return so each reply's result is written the same way
    #[allow(clippy::needless_return)]
    pub fn push(&mut self, snapshot: &Snapshot, now: i64) {
        if self.due_ms() > now {
            return;
        }
        let headers = match self.auth_headers() {
            Ok(h) => h,
            Err(reason) => return self.finish(now, false, &reason),
        };
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        {
            let count = self.outbox.observations.len().min(MAX_PER_REQUEST);
            let seq = next_send_seq(self.outbox.last_seq, now);
            self.outbox.last_seq = Some(seq);
            let body = json!({
                "seq": seq,
                "snapshot": snapshot,
                "observations": &self.outbox.observations[..count],
            })
            .to_string();
            let reply = self.transport.put(&self.endpoint, &headers, &body);
            match reply
                .as_ref()
                .map(|(status, text)| (*status, text.as_str()))
            {
                Ok((200..=299, _)) => {
                    // One request per send. Remaining observations go 1 minute later (one send per minute)
                    self.outbox.observations.drain(..count);
                    self.dirty = false;
                    self.outbox.retry_at_ms = None;
                    return self.finish(now, true, "Sent");
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
                        now,
                        false,
                        "The destination did not replace the latest value (409). Resending with a higher number after the wait",
                    );
                }
                Ok((400 | 413, _)) => {
                    // Body rejected. Drop the observations so they are not sent forever
                    self.outbox.observations.drain(..count);
                    return self.finish(
                        now,
                        false,
                        "The destination rejected the body (400, 413). Dropped the observations",
                    );
                }
                Ok((401 | 403, _)) => {
                    return self.finish(now, false, "The destination rejected the credentials (401, 403). Check the credentials and collector_id");
                }
                Ok((404, _)) => {
                    return self.finish(now, false, "Destination URL not found (404)");
                }
                Ok((503, text)) if text.contains("d1_budget") => {
                    // The destination's daily D1 budget is used up (it resets at UTC midnight). Keep the observations and do not send until
                    // the time the destination gave (at most 24 hours). Observations older than 24 hours are dropped by the queue limit (leaving a gap)
                    let wait_s = serde_json::from_str::<serde_json::Value>(text)
                        .ok()
                        .and_then(|v| v["retry_after_s"].as_i64())
                        .unwrap_or(3600)
                        .clamp(60, 24 * 3600);
                    self.outbox.retry_at_ms = Some(now.saturating_add(wait_s * 1000));
                    return self.finish(
                        now,
                        false,
                        "Not accepted: the destination is near its daily D1 limit (resets at UTC midnight)",
                    );
                }
                Ok((300..=399, _)) => {
                    // Redirects are not followed. Keep the observations so they can be sent once the URL is fixed
                    return self.finish(
                        now,
                        false,
                        "The destination returned a redirect (3xx). Redirects are not followed; check [push] url",
                    );
                }
                Ok(_) => return self.finish(now, false, "The destination returned an error"),
                Err(_) => return self.finish(now, false, "Cannot connect to the destination"),
            }
        }
    }

    pub fn status_line(home: &Path) -> Option<String> {
        let o: Outbox = read_json(&home.join(OUTBOX_FILE))?;
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
        let headers = self.auth_headers().ok()?;
        let headers: Vec<(&str, &str)> = headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let body = json!({ provider: minutes }).to_string();
        let url = self.turns_endpoint();
        let (status, text) = self.transport.post(&url, &headers, &body).ok()?;
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
        t.0.lock().unwrap().replies = (0..3).map(|_| Err(SendError::Network)).collect();
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
        assert_eq!(names, ["Authorization"]);
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
    fn failures_keep_the_queue_and_back_off_then_resend_with_a_new_seq() {
        let h = home("retry");
        let t = FakeTransport::default();
        t.0.lock().unwrap().replies = vec![Err(SendError::Network), Ok(503)];
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
        t.0.lock().unwrap().replies = vec![Err(SendError::Network)];
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
        t.0.lock().unwrap().replies = vec![Err(SendError::Network)];
        let mut p = pusher(&h, &t, Ok(creds()));
        // Previous account's observation while the clock was an hour fast (left unsent)
        p.record(&latest(70.0, NOW + 60 * MINUTE_MS, None), true, NOW);
        p.push(&snapshot(&latest(70.0, NOW, None)), NOW);
        assert_eq!(p.outbox.observations.len(), 1);
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
}
