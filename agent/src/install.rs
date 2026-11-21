//! Registering, unregistering, starting and stopping the background agent.
//!
//! - `install`: stops a running agent, copies the executables to `~/.headroom/bin`, registers autostart at login and starts it.
//! - `uninstall`: stops the agent and removes the registration. State, logs and config are kept.
//! - `stop`: drops a stop-request file and waits for the agent to stop after its current fetch. Killing it in the middle of `/usage`
//!   means zero quota use cannot be confirmed and the provider goes into a safety stop, so the process is never killed.
//! - Windows uses the registry `HKCU\...\Run` (windowless `headroomw.exe agent`); Mac uses a LaunchAgent.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::config::{Config, claude_config_dir, user_home};
use crate::providers::claude::{claude_bin, resolve_bin};

pub const STOP_FILE: &str = "stop-request";
pub const LOCK_FILE: &str = "agent.lock";
/// Wait longer than one fetch can take (Claude's `/usage` timeout of 60 seconds plus margin)
pub const STOP_WAIT: Duration = Duration::from_secs(120);
pub const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "Headroom";
pub const LAUNCH_LABEL: &str = "com.headroom.agent";

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn bin_dir(home: &Path) -> PathBuf {
    home.join("bin")
}

/// Whether the agent is running (running if agent.lock cannot be acquired). For display; `start` uses `agent_lock_state`
pub fn agent_running(home: &Path) -> bool {
    agent_lock_state(home).unwrap_or(false)
}

/// Ok(true) only when another process holds agent.lock. A missing home (before the first `install`) means not running.
/// A lock file that cannot be opened or locked for another reason is an error, so `start` does not launch an agent
/// that would exit at once on the same lock, and `stop` does not report a stop it cannot confirm
fn agent_lock_state(home: &Path) -> Result<bool, String> {
    if matches!(home.try_exists(), Ok(false)) {
        return Ok(false);
    }
    let lock = open_lock(home)?;
    lock_is_held(&lock, home)
}

fn open_lock(home: &Path) -> Result<File, String> {
    let path = home.join(LOCK_FILE);
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("Cannot open {}: {e}", path.display()))
}

/// Takes agent.lock and holds it while the returned file lives (the agent can't start meanwhile). Err if the agent is running or the
/// lock can't be checked (not taken for "stopped")
pub fn hold_agent_lock(home: &Path) -> Result<File, String> {
    let lock = open_lock(home)?;
    match lock_is_held(&lock, home)? {
        false => Ok(lock),
        true => Err(
            "The background agent is running. Stop it first (headroom stop), then run this again"
                .into(),
        ),
    }
}

/// Ok(true) if another process holds the lock. Taking it (Ok(false)) holds it until `lock` is dropped
fn lock_is_held(lock: &File, home: &Path) -> Result<bool, String> {
    match lock.try_lock() {
        Ok(()) => Ok(false),
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(std::fs::TryLockError::Error(e)) => Err(format!(
            "Cannot lock {}: {e}",
            home.join(LOCK_FILE).display()
        )),
    }
}

/// Asks the agent to stop and waits until it does. Ok(false) if it was not running.
/// The wait watches the same lock file handle it first found held, so renaming the folder meanwhile cannot look like a stop.
/// (The stop request itself is still written and removed by path, so renaming the folder during the wait is not supported)
pub fn stop(home: &Path, wait: Duration) -> Result<bool, String> {
    if matches!(home.try_exists(), Ok(false)) {
        return Ok(false);
    }
    let lock = open_lock(home)?;
    if !lock_is_held(&lock, home)? {
        let _ = std::fs::remove_file(home.join(STOP_FILE));
        return Ok(false);
    }
    File::create(home.join(STOP_FILE)).map_err(|_| "Cannot write the stop request".to_string())?;
    let result = wait_for_release(&lock, home, wait);
    // Whatever the outcome, remove the request so an agent started later is not stopped by it
    let _ = std::fs::remove_file(home.join(STOP_FILE));
    result
}

fn wait_for_release(lock: &File, home: &Path, wait: Duration) -> Result<bool, String> {
    let start = Instant::now();
    while start.elapsed() < wait {
        std::thread::sleep(Duration::from_millis(300));
        if !lock_is_held(lock, home)? {
            return Ok(true);
        }
    }
    Err("The agent did not stop (stuck in a fetch). Wait a while and try again".into())
}

/// If a stop request exists, removes it and returns true (called by the agent loop)
pub fn take_stop_request(home: &Path) -> bool {
    let path = home.join(STOP_FILE);
    if path.exists() {
        let _ = std::fs::remove_file(path);
        true
    } else {
        false
    }
}

/// Starts the agent in the background (runs until logout; does not change the autostart registration).
/// Ok(false) if it was already running
pub fn start(home: &Path) -> Result<bool, String> {
    crate::config::check_home(home)?;
    if agent_lock_state(home)? {
        return Ok(false);
    }
    let program = installed_agent(home);
    if !program.is_file() {
        return Err(format!(
            "{} not found (run headroom install first)",
            program.display()
        ));
    }
    spawn_detached(&program, home).map(|()| true)
}

/// Executable used for the background agent (windowless headroomw on Windows)
pub fn installed_agent(home: &Path) -> PathBuf {
    bin_dir(home).join(exe(if cfg!(windows) {
        "headroomw"
    } else {
        "headroom"
    }))
}

/// Runs the agent with HEADROOM_HOME as its working folder. Windows keeps a process's working folder in use, so
/// otherwise the folder `install` or `start` was run from (e.g. an extracted package) could not be deleted while the agent runs
#[cfg(windows)]
fn spawn_detached(program: &Path, home: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
    stop_inheriting_std_handles();
    let run = |flags: u32| {
        Command::new(program)
            .arg("agent")
            .current_dir(home)
            .creation_flags(flags)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    // Break away from the caller's job (e.g. a terminal) when possible, so the agent is not killed along with it
    run(base | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| run(base))
        .map(drop)
        .map_err(|_| "Cannot start the background agent".into())
}

/// Keeps the caller's standard handles (e.g. the pipe of a script that runs `headroom install`) out of the agent.
/// Windows gives a child every inheritable handle of its parent when handle inheritance is on, which Rust's `Command`
/// enables by default. The caller would then wait for its pipe to close for as long as the agent runs.
/// Only this process's handles change; the caller's own handles keep their flags. (A launcher that passes another
/// inheritable copy of its pipe, besides the standard handles, is not covered; Headroom itself does not)
#[cfg(windows)]
fn stop_inheriting_std_handles() {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetStdHandle(std_handle: u32) -> isize;
        fn SetHandleInformation(handle: isize, mask: u32, flags: u32) -> i32;
    }
    const STD_INPUT_HANDLE: u32 = -10i32 as u32;
    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;
    const INVALID_HANDLE_VALUE: isize = -1;
    for std_handle in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: GetStdHandle takes one of the STD_*_HANDLE constants and returns a handle, null or INVALID_HANDLE_VALUE.
        // SetHandleInformation is only called with a handle owned by this process and changes only its inherit flag;
        // a failure (e.g. a console pseudo-handle) leaves the handle as it was
        unsafe {
            let handle = GetStdHandle(std_handle);
            if handle != 0 && handle != INVALID_HANDLE_VALUE {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

#[cfg(not(windows))]
fn spawn_detached(_program: &Path, _home: &Path) -> Result<(), String> {
    // On Mac, let launchd start it (load the registered LaunchAgent; launchd runs it in "/", so no folder is kept in use)
    launchctl_load(&launch_agent_path())
}

/// Copies the executables to `~/.headroom/bin`, using headroom and headroomw from the current executable's folder
fn copy_binaries(home: &Path) -> Result<(), String> {
    let current = std::env::current_exe()
        .map_err(|_| "Cannot determine the executable's location".to_string())?;
    let src_dir = current
        .parent()
        .ok_or("Cannot determine the executable's location")?;
    let dest = bin_dir(home);
    std::fs::create_dir_all(&dest).map_err(|_| format!("Cannot create {}", dest.display()))?;
    for name in ["headroom", "headroomw"] {
        let src = src_dir.join(exe(name));
        let to = dest.join(exe(name));
        if !src.is_file() {
            return Err(format!(
                "{} not found (run it from the cargo build --release output)",
                src.display()
            ));
        }
        if same_file(&src, &to) {
            continue;
        }
        let tmp = dest.join(format!("{}.new", exe(name)));
        std::fs::copy(&src, &tmp)
            .and_then(|_| std::fs::rename(&tmp, &to))
            .map_err(|_| {
                format!(
                    "Cannot copy to {} (check that the agent is not running)",
                    to.display()
                )
            })?;
    }
    Ok(())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

pub fn install(home: &Path, cfg: &Config) -> Result<Vec<String>, String> {
    crate::config::check_home(home)?;
    stop(home, STOP_WAIT)?;
    copy_binaries(home)?;
    register(home, cfg)?;
    let started = start(home)?;
    let cli = bin_dir(home).join(exe("headroom"));
    let mut lines = vec![
        format!("Executables: {}", bin_dir(home).display()),
        format!("Autostart: {}", registration_label()),
        format!(
            "{} (check with {}\"{}\" status)",
            if started {
                "Started the background agent"
            } else {
                "The background agent is already running"
            },
            // PowerShell needs the call operator to run a quoted path
            if cfg!(windows) { "& " } else { "" },
            cli.display()
        ),
        format!(
            "To use statusLine, add to settings.json in {}: {}",
            claude_config_dir().display(),
            serde_json::json!({ "statusLine": { "type": "command", "command": format!(
                "\"{}\" statusline",
                cli.display().to_string().replace('\\', "/")
            ) } })
        ),
    ];
    lines.extend(missing_cli_notes(cfg));
    Ok(lines)
}

/// Warns if an enabled provider's CLI is not on the current PATH (the agent inherits the PATH of the environment that starts it)
fn missing_cli_notes(cfg: &Config) -> Vec<String> {
    let codex = if cfg.codex.codex_bin.trim().is_empty() {
        std::env::var("HEADROOM_CODEX_BIN").unwrap_or_else(|_| "codex".into())
    } else {
        cfg.codex.codex_bin.clone()
    };
    [
        (cfg.claude.enabled, "claude", claude_bin(&cfg.claude)),
        (cfg.codex.enabled, "codex", codex),
    ]
    .into_iter()
    .filter(|(enabled, _, bin)| *enabled && resolve_bin(bin).is_none())
    .map(|(_, name, _)| {
        format!(
            "Note: {name} was not found on PATH in this environment. It may be found when started at login; to be sure, set an absolute path in [{name}] {name}_bin in config.toml"
        )
    })
    .collect()
}

pub fn uninstall(home: &Path) -> Result<Vec<String>, String> {
    stop(home, STOP_WAIT)?;
    unregister()?;
    Ok(vec![
        "Stopped the background agent and removed the autostart registration".into(),
        format!(
            "State, logs, config and executables are left in {} (delete them if no longer needed)",
            home.display()
        ),
    ])
}

// ---------------- Windows: HKCU Run ----------------

/// Value written to Run: `"<headroomw.exe>" agent`
pub fn run_value(program: &Path) -> String {
    format!("\"{}\" agent", program.display())
}

#[cfg(windows)]
fn registration_label() -> String {
    format!(r"{RUN_KEY}\{RUN_VALUE}")
}

#[cfg(windows)]
fn reg(args: &[&str]) -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("reg")
        .args(args)
        .creation_flags(0x0800_0000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(windows)]
fn register(home: &Path, _cfg: &Config) -> Result<(), String> {
    let value = run_value(&installed_agent(home));
    if reg(&[
        "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f",
    ]) {
        Ok(())
    } else {
        Err("Cannot register autostart (reg add failed)".into())
    }
}

#[cfg(windows)]
fn unregister() -> Result<(), String> {
    if !reg(&["query", RUN_KEY, "/v", RUN_VALUE])
        || reg(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
    {
        Ok(())
    } else {
        Err("Cannot remove the autostart registration (reg delete failed)".into())
    }
}

#[cfg(windows)]
pub fn registered() -> bool {
    reg(&["query", RUN_KEY, "/v", RUN_VALUE])
}

// ---------------- Mac: LaunchAgent ----------------

pub fn launch_agent_path() -> PathBuf {
    user_home()
        .join("Library/LaunchAgents")
        .join(format!("{LAUNCH_LABEL}.plist"))
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// launchd has a narrow PATH (/usr/bin:/bin:/usr/sbin:/sbin), so add the claude / codex locations found at registration
/// and common install locations to PATH
pub fn launch_path(cfg: &Config) -> String {
    let mut dirs: Vec<String> = Vec::new();
    let mut add = |p: PathBuf| {
        let s = p.display().to_string();
        if !s.is_empty() && !dirs.contains(&s) {
            dirs.push(s);
        }
    };
    let codex = if cfg.codex.codex_bin.trim().is_empty() {
        "codex".to_string()
    } else {
        cfg.codex.codex_bin.clone()
    };
    for bin in [claude_bin(&cfg.claude), codex] {
        if let Some(dir) = resolve_bin(&bin).and_then(|p| p.parent().map(Path::to_path_buf)) {
            add(dir);
        }
    }
    add(user_home().join(".local/bin"));
    for d in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        add(PathBuf::from(d));
    }
    dirs.join(":")
}

pub fn launch_agent_plist(program: &Path, path: &str, headroom_home: Option<&Path>) -> String {
    let home_env = headroom_home.map_or(String::new(), |h| {
        format!(
            "\n    <key>HEADROOM_HOME</key><string>{}</string>",
            xml_escape(&h.display().to_string())
        )
    });
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>agent</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>{}</string>{home_env}
  </dict>
</dict>
</plist>
"#,
        xml_escape(&program.display().to_string()),
        xml_escape(path)
    )
}

#[cfg(not(windows))]
fn registration_label() -> String {
    launch_agent_path().display().to_string()
}

#[cfg(not(windows))]
fn gui_domain() -> Result<String, String> {
    let out = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|_| "Cannot get the user ID".to_string())?;
    let uid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("Cannot get the user ID".into());
    }
    Ok(format!("gui/{uid}"))
}

#[cfg(not(windows))]
fn launchctl(args: &[&str]) -> bool {
    Command::new("launchctl")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(windows))]
fn launchctl_load(plist: &Path) -> Result<(), String> {
    let domain = gui_domain()?;
    // If already loaded, unload first and then load (to apply config changes)
    launchctl(&["bootout", &format!("{domain}/{LAUNCH_LABEL}")]);
    if launchctl(&["bootstrap", &domain, &plist.display().to_string()]) {
        Ok(())
    } else {
        Err("launchctl bootstrap failed".into())
    }
}

#[cfg(not(windows))]
fn register(home: &Path, cfg: &Config) -> Result<(), String> {
    let plist = launch_agent_path();
    if let Some(dir) = plist.parent() {
        std::fs::create_dir_all(dir).map_err(|_| format!("Cannot create {}", dir.display()))?;
    }
    let custom_home = std::env::var_os("HEADROOM_HOME").map(PathBuf::from);
    let text = launch_agent_plist(
        &installed_agent(home),
        &launch_path(cfg),
        custom_home.as_deref(),
    );
    std::fs::write(&plist, text).map_err(|_| format!("Cannot write {}", plist.display()))
}

#[cfg(not(windows))]
fn unregister() -> Result<(), String> {
    let domain = gui_domain()?;
    launchctl(&["bootout", &format!("{domain}/{LAUNCH_LABEL}")]);
    match std::fs::remove_file(launch_agent_path()) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot delete the LaunchAgent plist".into()),
    }
}

#[cfg(not(windows))]
pub fn registered() -> bool {
    launch_agent_path().is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_queue_discard_holds_the_agent_lock_and_refuses_while_it_is_held() {
        let home = std::env::temp_dir().join(format!("headroom-hold-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        // the agent holds it: refused
        let agent = open_lock(&home).unwrap();
        agent.try_lock().unwrap();
        assert!(hold_agent_lock(&home).is_err());
        drop(agent);
        // taken: an agent starting now can't take it until it is let go
        let held = hold_agent_lock(&home).unwrap();
        assert_eq!(agent_lock_state(&home), Ok(true));
        drop(held);
        assert_eq!(agent_lock_state(&home), Ok(false));
        let _ = std::fs::remove_dir_all(&home);
    }

    fn home(label: &str) -> PathBuf {
        let h =
            std::env::temp_dir().join(format!("headroom-install-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    #[test]
    fn a_missing_home_is_not_running_and_start_points_to_install() {
        let h =
            std::env::temp_dir().join(format!("headroom-install-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&h);
        assert_eq!(agent_lock_state(&h), Ok(false));
        assert_eq!(stop(&h, Duration::from_secs(1)), Ok(false));
        let err = start(&h).unwrap_err();
        assert!(err.contains("run headroom install first"), "{err}");
        assert!(!h.exists(), "nothing is created before install");
        let relative = start(Path::new("relative-home")).unwrap_err();
        assert!(relative.contains("must be an absolute path"), "{relative}");
    }

    #[test]
    fn stop_waits_until_the_running_agent_releases_the_lock() {
        let h = home("stop");
        assert_eq!(
            stop(&h, Duration::from_secs(1)),
            Ok(false),
            "does nothing when not running"
        );
        // Stand-in for the agent: holds the lock and releases it on seeing the stop request
        let h2 = h.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let agent = std::thread::spawn(move || {
            let f = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(h2.join(LOCK_FILE))
                .unwrap();
            f.try_lock().unwrap();
            ready_tx.send(()).unwrap();
            while !take_stop_request(&h2) {
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(f);
        });
        ready_rx.recv().unwrap();
        assert!(agent_running(&h));
        assert_eq!(stop(&h, Duration::from_secs(10)), Ok(true));
        agent.join().unwrap();
        assert!(
            !h.join(STOP_FILE).exists(),
            "the request is not left behind"
        );
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn stop_gives_up_without_killing_and_clears_the_request() {
        let h = home("stuck");
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(h.join(LOCK_FILE))
            .unwrap();
        f.try_lock().unwrap();
        assert!(stop(&h, Duration::from_millis(500)).is_err());
        assert!(!h.join(STOP_FILE).exists());
        drop(f);
        let _ = std::fs::remove_dir_all(h);
    }

    #[test]
    fn run_value_quotes_the_path() {
        let v = run_value(Path::new(r"C:\Users\a b\.headroom\bin\headroomw.exe"));
        assert_eq!(v, r#""C:\Users\a b\.headroom\bin\headroomw.exe" agent"#);
    }

    #[test]
    fn launch_agent_plist_escapes_and_sets_path() {
        let p = launch_agent_plist(
            Path::new("/Users/a&b/.headroom/bin/headroom"),
            "/Users/a&b/.local/bin:/usr/bin",
            Some(Path::new("/tmp/h")),
        );
        assert!(p.contains(
            "<string>/Users/a&amp;b/.headroom/bin/headroom</string><string>agent</string>"
        ));
        assert!(p.contains("<key>PATH</key><string>/Users/a&amp;b/.local/bin:/usr/bin</string>"));
        assert!(p.contains("<key>HEADROOM_HOME</key><string>/tmp/h</string>"));
        assert!(p.contains(LAUNCH_LABEL));
        let without = launch_agent_plist(Path::new("/x"), "/usr/bin", None);
        assert!(!without.contains("HEADROOM_HOME"));
    }

    #[test]
    fn launch_path_keeps_system_dirs_without_duplicates() {
        let path = launch_path(&Config::default());
        for d in ["/usr/bin", "/bin", "/opt/homebrew/bin"] {
            assert_eq!(path.split(':').filter(|x| *x == d).count(), 1);
        }
    }
}
