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
    pub push: PushConfig,
    pub schedule: ScheduleConfig,
}

/// Fetch coordination: turn-taking across PCs, and stretching the interval when nothing changes
#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct ScheduleConfig {
    /// If values do not change for 30 minutes, stretch the fetch interval to this many minutes. Not stretched if this is at or below the provider's interval
    pub idle_interval_min: i64,
    /// Fetch on this PC at least once per this many minutes even when another PC has the turn (to notice account switches etc. on this PC)
    pub own_fetch_min: i64,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            idle_interval_min: 10,
            own_fetch_min: 60,
        }
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
            toml::from_str(&text).map_err(|e| format!("Failed to read {}: {e}", path.display()))
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
}
