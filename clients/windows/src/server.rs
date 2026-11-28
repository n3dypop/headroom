//! The server: its address (in the settings file), the read token (in the OS credential store) and reading the view.
//! Only GET with a read token; the token goes in the Authorization header only, never in a URL; redirects are not followed.

use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};

const CREDENTIAL_SERVICE: &str = "headroom-desktop";
const CREDENTIAL_USER: &str = "read";
const USER_AGENT: &str = concat!("headroom-desktop/", env!("CARGO_PKG_VERSION"));
/// A view is a few kilobytes; anything far larger is not one
const MAX_BODY_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Settings {
    /// The server's https origin (no path), e.g. https://headroom.example.workers.dev
    #[serde(default)]
    pub url: String,
    /// Show the built-in sample instead of reading the server
    #[serde(default)]
    pub demo: bool,
    /// Which credential entry holds the server's read token (0: none). Each saved token gets a new one, so a save takes effect
    /// only when this file is written, and an entry it doesn't name is never read
    #[serde(default)]
    pub token_slot: u64,
}

/// %APPDATA%\Headroom\desktop.json (macOS: ~/Library/Application Support/Headroom/desktop.json)
pub fn settings_path() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }?;
    Some(base.join("Headroom").join("desktop.json"))
}

/// The saved settings. An address that isn't an https origin (the file edited by hand) is dropped: no token is ever sent there
pub fn load_settings() -> Settings {
    let mut s: Settings = settings_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    s.url = normalize_base_url(&s.url).unwrap_or_default();
    s
}

pub fn save_settings(s: &Settings) -> Result<(), String> {
    let path = settings_path().ok_or("No folder for the settings")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "Couldn't create the settings folder")?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(s).map_err(|_| "Couldn't write the settings")?;
    std::fs::write(&tmp, text).map_err(|_| "Couldn't write the settings")?;
    std::fs::rename(&tmp, &path).map_err(|_| "Couldn't write the settings")?;
    Ok(())
}

/// The credential entry of a server's read token: one per server, so saving one never touches another's, and a token is only
/// ever looked up (and sent) for the server it was given for
/// A credential entry: the server's origin and the slot the settings name (a token is only looked up, and sent, for the server it
/// was given for)
fn entry(origin: &str, slot: u64) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        CREDENTIAL_SERVICE,
        &format!("{CREDENTIAL_USER}:{origin}#{slot}"),
    )
    .map_err(|_| "The credential store isn't available".to_string())
}

/// A new slot number: the clock in nanoseconds plus a count, so two calls never give the same one (never 0). The caller still
/// checks it is free
pub fn new_slot() -> u64 {
    static COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos() as u64);
    ns.wrapping_add(COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
        .max(1)
}

/// Whether an entry is there. Only a store that says there is none counts as free: when it can't tell, the slot isn't used
pub fn has_entry(origin: &str, slot: u64) -> bool {
    !matches!(
        entry(origin, slot).map(|e| e.get_password()),
        Ok(Err(keyring::Error::NoEntry))
    )
}

/// The read token the settings name (None when they name none, or it isn't there)
pub fn read_token(s: &Settings) -> Option<String> {
    if s.url.is_empty() || s.token_slot == 0 {
        return None;
    }
    entry(&s.url, s.token_slot)
        .ok()?
        .get_password()
        .ok()
        .filter(|t| !t.trim().is_empty())
}

pub fn store_token(origin: &str, slot: u64, token: &str) -> Result<(), String> {
    entry(origin, slot)?
        .set_password(token.trim())
        .map_err(|_| "Couldn't save the token in the credential store".to_string())
}

pub fn delete_token(origin: &str, slot: u64) -> Result<(), String> {
    if origin.is_empty() || slot == 0 {
        return Ok(());
    }
    match entry(origin, slot)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Couldn't remove the token from the credential store".to_string()),
    }
}

/// The server's origin from what the user typed: https only, host (and port) only, no user info, path, query or fragment.
/// None when it isn't one
pub fn normalize_base_url(input: &str) -> Option<String> {
    let s = input.trim().trim_end_matches('/');
    let rest = s.strip_prefix("https://").or_else(|| {
        s.get(..8)
            .filter(|p| p.eq_ignore_ascii_case("https://"))
            .map(|_| &s[8..])
    })?;
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', ' ', '\\']) {
        return None;
    }
    // A port is 1 to 65535, written once (an out-of-range one would make the request go to 443 instead); 443 is the default
    let (host, port) = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.len() <= 5 && p.chars().all(|c| c.is_ascii_digit()) => {
            match p.parse::<u16>() {
                Ok(0) | Err(_) => return None,
                Ok(443) => (h, None),
                Ok(n) => (h, Some(n)),
            }
        }
        Some(_) => return None,
        None => (rest, None),
    };
    let ok_host = !host.is_empty()
        && host
            .split('.')
            .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    if !ok_host {
        return None;
    }
    let host = host.to_ascii_lowercase();
    Some(match port {
        Some(p) => format!("https://{host}:{p}"),
        None => format!("https://{host}"),
    })
}

/// The view's URL for this PC's time zone
pub fn view_url(base: &str, tz: &str) -> String {
    let tz: String = tz
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("{base}/v2/view?tz={tz}")
}

/// The PC's IANA time zone (Asia/Tokyo when it can't be told)
pub fn local_time_zone() -> String {
    jiff::tz::TimeZone::system()
        .iana_name()
        .map(str::to_string)
        .unwrap_or_else(|| "Asia/Tokyo".to_string())
}

/// Why a read failed, in words for the user (never the server's own text)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    NotSetUp,
    TokenRejected,
    NotFound,
    Busy,
    Server(u16),
    Network,
    BadBody,
}

impl ReadError {
    pub fn text(&self) -> String {
        match self {
            Self::NotSetUp => "Set the server and the read token in Settings".into(),
            Self::TokenRejected => "The server didn't accept the token".into(),
            Self::NotFound => "No Headroom server at this address".into(),
            Self::Busy => "The server is busy; trying again later".into(),
            Self::Server(code) => format!("The server answered {code}"),
            Self::Network => "Couldn't reach the server".into(),
            Self::BadBody => "The server's answer isn't a Headroom view".into(),
        }
    }
}

/// Read the view. Returns its JSON (checked to be an object; model.rs checks the rest as the widget does)
pub fn read_view(base: &str, token: &str, tz: &str) -> Result<serde_json::Value, ReadError> {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    // Only to an https origin, checked again right before sending the token
    if normalize_base_url(base).as_deref() != Some(base) {
        return Err(ReadError::NotSetUp);
    }
    // The OS TLS and certificate store (SChannel), as the agent uses
    let tls = TlsConfig::builder()
        .provider(TlsProvider::NativeTls)
        .root_certs(RootCerts::PlatformVerifier)
        .build();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .tls_config(tls)
        .https_only(true)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .build()
        .into();
    let response = agent
        .get(&view_url(base, tz))
        .header("Authorization", &format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", USER_AGENT)
        .call()
        .map_err(|_| ReadError::Network)?;
    let status = response.status().as_u16();
    match status {
        200 => {}
        401 | 403 => return Err(ReadError::TokenRejected),
        404 => return Err(ReadError::NotFound),
        429 | 503 => return Err(ReadError::Busy),
        _ => return Err(ReadError::Server(status)),
    }
    let text = response
        .into_body()
        .with_config()
        .limit(MAX_BODY_BYTES)
        .read_to_string()
        .map_err(|_| ReadError::BadBody)?;
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) if v.is_object() => Ok(v),
        _ => Err(ReadError::BadBody),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_url_is_an_https_origin_only() {
        assert_eq!(
            normalize_base_url(" https://Headroom.Example.workers.dev/ ").as_deref(),
            Some("https://headroom.example.workers.dev")
        );
        assert_eq!(
            normalize_base_url("https://h.example:8443").as_deref(),
            Some("https://h.example:8443")
        );
        assert_eq!(
            normalize_base_url("https://h.example:00443").as_deref(),
            Some("https://h.example")
        );
        assert_eq!(
            normalize_base_url("https://h.example:08443").as_deref(),
            Some("https://h.example:8443")
        );
        for bad in [
            "https://h.example:65536",
            "https://h.example:0",
            "https://h.example:99999",
            "http://h.example",
            "h.example",
            "https://",
            "https://h.example/v2",
            "https://h.example?x=1",
            "https://user@h.example",
            "https://h.example:port",
            "https://h..example",
        ] {
            assert_eq!(normalize_base_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn view_url_encodes_the_time_zone() {
        assert_eq!(
            view_url("https://h.example", "Asia/Tokyo"),
            "https://h.example/v2/view?tz=Asia%2FTokyo"
        );
        assert_eq!(
            view_url("https://h.example", "America/Port-au-Prince"),
            "https://h.example/v2/view?tz=America%2FPort-au-Prince"
        );
    }

    /// Reads a real https site once (no Headroom server there: it must answer, not fail to connect). Run by hand:
    /// cargo test -- --ignored
    #[test]
    #[ignore]
    fn https_reads_reach_the_server() {
        let r = read_view("https://example.com", "not-a-token", "UTC");
        assert!(
            matches!(
                r,
                Err(ReadError::NotFound
                    | ReadError::Server(_)
                    | ReadError::TokenRejected
                    | ReadError::BadBody)
            ),
            "{r:?}"
        );
    }

    #[test]
    fn errors_never_carry_the_server_text() {
        assert_eq!(ReadError::Server(500).text(), "The server answered 500");
        assert!(!ReadError::TokenRejected.text().is_empty());
    }
}
