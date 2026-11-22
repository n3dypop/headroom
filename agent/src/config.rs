//! Config (~/.headroom/config.toml) and paths. Works with defaults when there is no config file.

use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct Config {
    /// Display name of this collector. Defaults to the host name
    pub collector_id: Option<String>,
    pub claude: ClaudeConfig,
    pub codex: CodexConfig,
    pub gemini: GeminiConfig,
    pub push: PushConfig,
    pub schedule: ScheduleConfig,
    /// The providers whose `interval_min` the config file sets (read on load: an unset one takes DEFAULT_INTERVAL_MIN)
    #[serde(skip)]
    pub set_intervals: Vec<&'static str>,
}

/// The shortest interval (minutes) between active fetches of a provider, whatever the config says (less load on the services)
pub const MIN_INTERVAL_MIN: i64 = 10;
/// A provider's interval (minutes) when the config doesn't set one
pub const DEFAULT_INTERVAL_MIN: i64 = 15;
/// The longest interval (minutes) a setting may give (a day)
const MAX_SETTING_MIN: i64 = 1_440;

/// Fetch coordination: the interval and its jitter, turn-taking across PCs, and stretching the interval when nothing changes
#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct ScheduleConfig {
    /// If values do not change for 30 minutes, stretch the fetch interval to this many minutes. Not stretched if this is at or below the
    /// provider's interval
    pub idle_interval_min: i64,
    /// If values do not change for 2 hours, stretch it to this many minutes
    pub idle_long_interval_min: i64,
    /// Fetch on this PC at least once per this many minutes even when another PC has the turn (to notice account switches etc. on this PC)
    pub own_fetch_min: i64,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            idle_interval_min: 30,
            idle_long_interval_min: 60,
            own_fetch_min: 120,
        }
    }
}

impl Config {
    /// A provider's interval between active fetches (minutes): the provider's `interval_min` when the config sets it, raised to
    /// MIN_INTERVAL_MIN (an earlier example's 5 is 10), else DEFAULT_INTERVAL_MIN
    pub fn interval_min(&self, id: &str) -> i64 {
        let set = match id {
            "claude" => self.claude.interval_min,
            "codex" => self.codex.interval_min,
            "gemini" => self.gemini.interval_min,
            _ => return DEFAULT_INTERVAL_MIN,
        };
        if self.set_intervals.contains(&id) {
            set.max(MIN_INTERVAL_MIN)
        } else {
            DEFAULT_INTERVAL_MIN
        }
    }

    /// The config as read from `text`: which intervals it sets, and every number in its range (a value out of range is an error, so a
    /// plan or a lease is never computed from it)
    pub fn parse(text: &str) -> Result<Config, String> {
        let mut cfg: Config = toml::from_str(text).map_err(|e| e.to_string())?;
        let table: toml::Table = toml::from_str(text).map_err(|e| e.to_string())?;
        for id in ["claude", "codex", "gemini"] {
            if table.get(id).and_then(|t| t.get("interval_min")).is_some() {
                cfg.set_intervals.push(id);
            }
        }
        let checks = [
            ("claude.interval_min", cfg.claude.interval_min, 1),
            ("codex.interval_min", cfg.codex.interval_min, 1),
            ("gemini.interval_min", cfg.gemini.interval_min, 1),
            (
                "schedule.idle_interval_min",
                cfg.schedule.idle_interval_min,
                1,
            ),
            (
                "schedule.idle_long_interval_min",
                cfg.schedule.idle_long_interval_min,
                1,
            ),
            (
                "schedule.own_fetch_min",
                cfg.schedule.own_fetch_min,
                MIN_INTERVAL_MIN,
            ),
        ];
        for (key, value, low) in checks {
            if !(low..=MAX_SETTING_MIN).contains(&value) {
                return Err(format!(
                    "{key} must be from {low} to {MAX_SETTING_MIN} minutes (it is {value})"
                ));
            }
        }
        Ok(cfg)
    }
}

/// Push to the destination. Nothing is sent if url is empty
#[derive(Deserialize, Debug, Clone, Default)]
#[serde(default)]
pub struct PushConfig {
    /// Destination URL (e.g. https://headroom.example.workers.dev)
    pub url: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct ClaudeConfig {
    pub enabled: bool,
    /// If empty, HEADROOM_CLAUDE_BIN; failing that, `claude` on PATH
    pub claude_bin: String,
    /// Interval (minutes) for running `/usage`. Uses no quota
    pub interval_min: i64,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            claude_bin: String::new(),
            interval_min: 5,
        }
    }
}

#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct CodexConfig {
    pub enabled: bool,
    pub codex_bin: String,
    pub interval_min: i64,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            codex_bin: String::new(),
            interval_min: 5,
        }
    }
}

/// The Gemini provider (the Antigravity CLI, agy). On only once the destination accepts Gemini values (an earlier destination refuses
/// an upload holding them, with the other providers' values in it)
#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct GeminiConfig {
    /// On or off as config.toml says. Left out: on only where the whole fetch was verified by hand (providers::gemini::default_on,
    /// decided by the agent when it starts)
    pub enabled: Option<bool>,
    /// On because config.toml left it out (the agent's run sets it, never config.toml): every version check then takes only a version
    /// verified for that (providers::gemini::DEFAULT_ON_VERSIONS), also after agy is updated while the agent runs
    #[serde(skip)]
    pub by_default: bool,
    /// If empty, HEADROOM_GEMINI_BIN; failing that, `agy` on PATH, then the install folders it is known to use
    pub gemini_bin: String,
    /// Interval (minutes) for running `/usage`. Uses no quota
    pub interval_min: i64,
}

impl Default for GeminiConfig {
    fn default() -> Self {
        Self {
            enabled: None,
            by_default: false,
            gemini_bin: String::new(),
            interval_min: 5,
        }
    }
}

pub fn user_home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// `install` and `start` refuse a relative Headroom folder (from HEADROOM_HOME, or a home folder that could not be
/// found): the agent runs in that folder (Windows) or "/" (launchd), and at login in another folder again, so a
/// relative path would point somewhere else there
pub fn check_home(home: &std::path::Path) -> Result<(), String> {
    if home.is_absolute() {
        return Ok(());
    }
    Err(format!(
        "The Headroom folder must be an absolute path (it is {}). Set HEADROOM_HOME to an absolute path",
        home.display()
    ))
}

/// Headroom state directory. Override with HEADROOM_HOME; default ~/.headroom
pub fn headroom_home() -> PathBuf {
    std::env::var_os("HEADROOM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".headroom"))
}

/// Claude Code config directory (CLAUDE_CONFIG_DIR or ~/.claude)
pub fn claude_config_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".claude"))
}

/// .claude.json, which holds account info (inside CLAUDE_CONFIG_DIR if set, default ~/.claude.json)
pub fn claude_json_path() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(d) => PathBuf::from(d).join(".claude.json"),
        None => user_home().join(".claude.json"),
    }
}

pub fn load(home: &Path) -> Result<Config, String> {
    let path = home.join("config.toml");
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            Config::parse(&text).map_err(|e| format!("Failed to read {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(e) => Err(format!("Cannot open {}: {e}", path.display())),
    }
}

/// PC name sent to the destination. Must be set explicitly (collector_id or HEADROOM_COLLECTOR_ID) and is
/// returned only if it fits the destination's rule (lowercase letters, digits, -, up to 32 chars). The host name may contain a personal name, so it is not used
pub fn explicit_collector_id(cfg: &Config) -> Option<String> {
    cfg.collector_id
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HEADROOM_COLLECTOR_ID").ok())
        .filter(|id| {
            let b = id.as_bytes();
            !b.is_empty()
                && b.len() <= 32
                && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
                && b.iter()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        })
}

pub fn collector_id(cfg: &Config) -> String {
    if let Some(id) = cfg.collector_id.as_deref().filter(|s| !s.is_empty()) {
        return id.to_string();
    }
    if let Ok(id) = std::env::var("HEADROOM_COLLECTOR_ID")
        && !id.is_empty()
    {
        return id;
    }
    std::env::var(if cfg!(windows) {
        "COMPUTERNAME"
    } else {
        "HOSTNAME"
    })
    .ok()
    .filter(|s| !s.is_empty())
    .or_else(|| {
        std::process::Command::new("hostname")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    })
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_headroom_folder_is_refused() {
        use std::path::Path;
        assert!(check_home(&std::env::temp_dir().join("headroom-home")).is_ok());
        assert!(check_home(Path::new("state")).is_err());
        assert!(check_home(Path::new("./.headroom")).is_err());
    }

    #[test]
    fn partial_config_keeps_defaults() {
        // Still readable when old settings (probe_*) are left over
        let cfg: Config =
            toml::from_str("[claude]\ninterval_min = 10\nprobe_idle_min = 0\n").unwrap();
        assert_eq!(cfg.claude.interval_min, 10);
        assert!(cfg.claude.enabled);
        assert!(cfg.codex.enabled);
    }

    #[test]
    fn an_unset_interval_is_15_minutes_and_a_set_one_never_under_10() {
        let cfg =
            Config::parse("[codex]\ninterval_min = 5\n[gemini]\ninterval_min = 30\n").unwrap();
        assert_eq!(cfg.interval_min("claude"), 15, "unset");
        assert_eq!(cfg.interval_min("codex"), 10, "an earlier example's 5");
        assert_eq!(cfg.interval_min("gemini"), 30);
        assert_eq!(Config::default().interval_min("codex"), 15);
        // out of range: refused on load
        for bad in [
            "[claude]\ninterval_min = 0\n",
            "[codex]\ninterval_min = 99999999999\n",
            "[schedule]\nidle_interval_min = -5\n",
            "[schedule]\nown_fetch_min = 5\n",
            "[schedule]\nidle_long_interval_min = 2000\n",
        ] {
            assert!(Config::parse(bad).is_err(), "{bad}");
        }
        assert!(Config::parse("").is_ok());
    }
}
