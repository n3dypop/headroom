//! Registering, unregistering, starting and stopping the background agent.
//!
//! - `install`: stops a running agent, copies the executables to `~/.headroom/bin`, registers autostart at login and starts it.
//! - `uninstall`: stops the agent and removes the registration. State, logs and config are kept.
//! - `stop`: drops a stop-request file naming the running agent's session and waits for it to stop after its current fetch. Killing it
//!   in the middle of `/usage` means zero quota use cannot be confirmed and the provider goes into a safety stop, so the process is never
//!   killed. A stop it couldn't wait out stays (the agent stops when its fetch ends); an agent started later never takes it.
//! - `start`: reports a start only once the agent's session is up.
//! - Windows uses a shortcut in the user's Startup folder (windowless `headroomw.exe agent`; earlier versions' `HKCU\...\Run` entry is
//!   removed); Mac uses a LaunchAgent.

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
/// How long `start` waits for the agent's session to come up
const START_WAIT: Duration = Duration::from_secs(30);
/// Where earlier versions registered the agent on Windows (removed on install and uninstall)
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

/// The running agent's session: only while its writer holds the session lock (a session file an earlier agent left isn't one). The
/// agent publishes it right after taking agent.lock
pub fn session_of(home: &Path) -> Option<String> {
    let probe = File::open(home.join(crate::schedule::SESSION_LOCK_FILE)).ok()?;
    match probe.try_lock_shared() {
        Err(std::fs::TryLockError::WouldBlock) => {}
        Ok(()) | Err(std::fs::TryLockError::Error(_)) => return None,
    }
    drop(probe);
    std::fs::read_to_string(home.join(crate::schedule::SESSION_FILE))
        .ok()
        .filter(|s| !s.is_empty())
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
/// The request names the agent's session: one held by another command (agent.lock with no session) is never stopped, and a request
/// that outlives this wait stops that agent only (an agent started later drops it)
pub fn stop(home: &Path, wait: Duration) -> Result<bool, String> {
    if matches!(home.try_exists(), Ok(false)) {
        return Ok(false);
    }
    let lock = open_lock(home)?;
    if !lock_is_held(&lock, home)? {
        let _ = std::fs::remove_file(home.join(STOP_FILE));
        return Ok(false);
    }
    // An agent starting publishes its session at once: it is waited for a moment
    let begin = Instant::now();
    let session = loop {
        if let Some(s) = session_of(home) {
            break s;
        }
        if !lock_is_held(&lock, home)? {
            return Ok(false);
        }
        if begin.elapsed() >= wait.min(Duration::from_secs(10)) {
            return Err(
                "Another command holds the background agent's lock (or it is starting); try again"
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    std::fs::write(home.join(STOP_FILE), &session)
        .map_err(|_| "Cannot write the stop request".to_string())?;
    let result = wait_for_release(&lock, home, wait);
    if result.is_ok() && std::fs::read_to_string(home.join(STOP_FILE)).is_ok_and(|s| s == session) {
        let _ = std::fs::remove_file(home.join(STOP_FILE));
    }
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
    Err("The agent is still in a fetch; it stops when that ends (it is never stopped in the middle of one)".into())
}

/// Whether a stop request for this session (or of an earlier version, naming none) waits: taken (removed) if so. One naming another
/// session is dropped
pub fn take_stop_request(home: &Path, session: &str) -> bool {
    let path = home.join(STOP_FILE);
    match std::fs::read_to_string(&path) {
        Ok(named) => {
            let _ = std::fs::remove_file(&path);
            named.is_empty() || named == session
        }
        Err(_) => false,
    }
}

/// Whether a stop request for this session (or naming none) waits, left in place (the loop takes it at its top)
pub fn stop_requested(home: &Path, session: &str) -> bool {
    std::fs::read_to_string(home.join(STOP_FILE))
        .is_ok_and(|named| named.is_empty() || named == session)
}

/// At the agent's start: a stop request left for another session (or naming none) is dropped; one naming this session stays
pub fn drop_other_stops(home: &Path, session: &str) {
    let path = home.join(STOP_FILE);
    if std::fs::read_to_string(&path).is_ok_and(|named| named != session) {
        let _ = std::fs::remove_file(path);
    }
}

/// Starts the agent in the background (runs until logout; does not change the autostart registration).
/// Ok(false) if it was already running
pub fn start(home: &Path) -> Result<bool, String> {
    crate::config::check_home(home)?;
    if session_of(home).is_some() {
        return Ok(false);
    }
    // agent.lock held with no session: an agent starting, or another command holding it for a while (waited for)
    let begin = Instant::now();
    while agent_lock_state(home)? {
        if session_of(home).is_some() {
            return Ok(false);
        }
        if begin.elapsed() >= Duration::from_secs(10) {
            return Err(
                "Another command holds the background agent's lock; try again when it ends".into(),
            );
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let program = installed_agent(home);
    if !program.is_file() {
        return Err(format!(
            "{} not found (run headroom install first)",
            program.display()
        ));
    }
    spawn_detached(&program, home)?;
    // Started once its session is up (an agent that exits at once isn't)
    let begin = Instant::now();
    while begin.elapsed() < START_WAIT {
        if session_of(home).is_some() {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err("The background agent didn't come up (see agent.log in HEADROOM_HOME)".into())
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
    lines.extend(gemini_default_note(cfg, &cli));
    Ok(lines)
}

/// Where Gemini may be on by default (left out of config.toml, a verified OS, agy found): how to let it fetch, and how to keep it off.
/// Whether agy is a verified version is told by the agent when it starts (nothing of agy runs here)
fn gemini_default_note(cfg: &Config, cli: &Path) -> Option<String> {
    (cfg.gemini.enabled.is_none()
        && crate::providers::gemini::default_on_os()
        && crate::providers::gemini::gemini_bin(&cfg.gemini).is_some())
    .then(|| {
        format!(
            "Gemini: {} (headroom status says which). For it to fetch, set Antigravity's statusLine command to {} (docs/install.md 2.8); to keep it off, set enabled = false under [gemini] in config.toml",
            crate::agent::default_on_note("gemini").unwrap_or_default(),
            serde_json::json!(gemini_statusline_command(cli))
        )
    })
}

/// Antigravity's statusLine command for Headroom: the path quoted, as Antigravity runs the command with `cmd /c` (Windows) or `sh -c`
/// (macOS), and a folder may contain spaces
fn gemini_statusline_command(cli: &Path) -> String {
    format!("\"{}\" statusline --gemini", cli.display())
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
    .chain(
        (cfg.gemini.enabled == Some(true) && crate::providers::gemini::gemini_bin(&cfg.gemini).is_none()).then(|| {
            "Note: agy (the Antigravity CLI) was not found on PATH or in its install folders. Install it, or set an absolute path in [gemini] gemini_bin in config.toml".to_string()
        }),
    )
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

// ---------------- Windows: a shortcut in the Startup folder ----------------

/// The shortcut's name in the user's Startup folder
#[cfg(windows)]
pub const SHORTCUT_NAME: &str = "Headroom.lnk";

/// The user's Startup folder as Windows itself has it (FOLDERID_Startup: also where it was moved elsewhere). None if Windows can't say
#[cfg(windows)]
pub fn startup_folder() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    // shell32 and ole32 are loaded here, only for this lookup (install, uninstall, status), and let go after: linked to the program,
    // they would load with the background agent too and stay in its memory for nothing
    type GetKnownFolderPath =
        unsafe extern "system" fn(*const Guid, u32, isize, *mut *mut u16) -> i32;
    type TaskMemFree = unsafe extern "system" fn(*mut core::ffi::c_void);
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryExW(name: *const u16, file: isize, flags: u32) -> isize;
        fn GetProcAddress(module: isize, name: *const u8) -> *const core::ffi::c_void;
        fn FreeLibrary(module: isize) -> i32;
    }
    /// From the system folder only, never one found elsewhere
    const LOAD_LIBRARY_SEARCH_SYSTEM32: u32 = 0x0000_0800;
    struct Library(isize);
    impl Library {
        fn load(name: &str) -> Option<Library> {
            let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
            // SAFETY: a NUL-terminated wide name; a failure returns 0
            let handle = unsafe { LoadLibraryExW(wide.as_ptr(), 0, LOAD_LIBRARY_SEARCH_SYSTEM32) };
            (handle != 0).then(|| Library(handle))
        }
        fn get(&self, name: &[u8]) -> Option<*const core::ffi::c_void> {
            // SAFETY: a loaded module and a NUL-terminated name; a failure returns null
            let f = unsafe { GetProcAddress(self.0, name.as_ptr()) };
            (!f.is_null()).then_some(f)
        }
    }
    impl Drop for Library {
        fn drop(&mut self) {
            // SAFETY: a module this value loaded, freed once; nothing from it is used after (the functions are dropped before)
            unsafe { FreeLibrary(self.0) };
        }
    }
    let shell32 = Library::load("shell32.dll")?;
    let ole32 = Library::load("ole32.dll")?;
    // SAFETY: the documented signatures of SHGetKnownFolderPath and CoTaskMemFree
    let (get_path, free): (GetKnownFolderPath, TaskMemFree) = unsafe {
        (
            std::mem::transmute::<*const core::ffi::c_void, GetKnownFolderPath>(
                shell32.get(b"SHGetKnownFolderPath\0")?,
            ),
            std::mem::transmute::<*const core::ffi::c_void, TaskMemFree>(
                ole32.get(b"CoTaskMemFree\0")?,
            ),
        )
    };
    // FOLDERID_Startup {B97D20BB-F46A-4C97-BA10-5E3608430854}
    const STARTUP: Guid = Guid {
        data1: 0xB97D_20BB,
        data2: 0xF46A,
        data3: 0x4C97,
        data4: [0xBA, 0x10, 0x5E, 0x36, 0x08, 0x43, 0x08, 0x54],
    };
    // The path also while the folder is missing or can't be reached (a moved folder on a share that is away): registering creates it,
    // and unregistering can tell a shortcut that isn't there from one it can't reach
    const KF_FLAG_DONT_VERIFY: u32 = 0x0000_4000;
    let mut path: *mut u16 = std::ptr::null_mut();
    // SAFETY: the GUID has the Win32 layout; on success the function hands over a NUL-terminated wide string it allocated, read up to
    // its NUL and then freed with CoTaskMemFree as documented (also on failure, where it may be null)
    unsafe {
        let ok = get_path(&STARTUP, KF_FLAG_DONT_VERIFY, 0, &mut path) >= 0 && !path.is_null();
        let folder = ok.then(|| {
            let len = (0..).take_while(|&i| *path.add(i) != 0).count();
            PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
                path, len,
            )))
        });
        free(path.cast());
        folder.filter(|f| f.is_absolute())
    }
}

/// Saves a shortcut with Windows' own WScript.Shell. Its paths come from the environment, never written into the script, so no
/// quoting is needed. It starts `<headroomw.exe> agent` minimized (headroomw has no window anyway)
#[cfg(windows)]
pub const SHORTCUT_SCRIPT: &str = "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:HEADROOM_SHORTCUT); \
     $s.TargetPath = $env:HEADROOM_TARGET; $s.Arguments = 'agent'; $s.WorkingDirectory = $env:HEADROOM_TARGET_DIR; \
     $s.WindowStyle = 7; $s.Description = 'Headroom agent'; $s.Save()";

/// The PowerShell run that saves the shortcut at `shortcut` to start `target` (Windows PowerShell from the system folder, not one
/// found on PATH)
#[cfg(windows)]
pub fn shortcut_command(shortcut: &Path, target: &Path) -> Command {
    let system = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let mut c =
        Command::new(PathBuf::from(system).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
    c.args(["-NoProfile", "-NonInteractive", "-Command", SHORTCUT_SCRIPT])
        .env("HEADROOM_SHORTCUT", shortcut)
        .env("HEADROOM_TARGET", target)
        .env("HEADROOM_TARGET_DIR", target.parent().unwrap_or(target))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    c
}

/// Saves the shortcut; true once it is there
#[cfg(windows)]
pub fn save_shortcut(shortcut: &Path, target: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    let _ = std::fs::remove_file(shortcut);
    shortcut_command(shortcut, target)
        .creation_flags(0x0800_0000)
        .status()
        .is_ok_and(|s| s.success())
        && shortcut.is_file()
}

#[cfg(windows)]
fn shortcut_path() -> Result<PathBuf, String> {
    startup_folder()
        .map(|f| f.join(SHORTCUT_NAME))
        .ok_or_else(|| "Cannot find the Startup folder (Windows didn't say where it is)".into())
}

#[cfg(windows)]
fn registration_label() -> String {
    shortcut_path().map_or_else(|e| e, |p| p.display().to_string())
}

/// The registry entry earlier versions started the agent from (HKCU Run). Windows can leave it unstarted at sign-in, so the Startup
/// folder replaced it: it is removed on install and uninstall
#[cfg(windows)]
fn remove_run_entry() -> bool {
    use std::os::windows::process::CommandExt;
    let reg = |args: &[&str]| {
        Command::new("reg")
            .args(args)
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    };
    !reg(&["query", RUN_KEY, "/v", RUN_VALUE]) || reg(&["delete", RUN_KEY, "/v", RUN_VALUE, "/f"])
}

#[cfg(windows)]
fn register(home: &Path, _cfg: &Config) -> Result<(), String> {
    let shortcut = shortcut_path()?;
    if let Some(folder) = shortcut.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if !save_shortcut(&shortcut, &installed_agent(home)) {
        return Err(format!(
            "Cannot register autostart (couldn't save {})",
            shortcut.display()
        ));
    }
    // A leftover entry would start a second agent at sign-in (it ends at once, the lock being held), so it goes; failing that is harmless
    let _ = remove_run_entry();
    Ok(())
}

#[cfg(windows)]
fn unregister() -> Result<(), String> {
    let shortcut = shortcut_path()?;
    if !shortcut_removed(&shortcut) {
        return Err(format!(
            "Cannot remove the autostart registration ({} couldn't be removed or reached)",
            shortcut.display()
        ));
    }
    if !remove_run_entry() {
        return Err(
            "Cannot remove the earlier autostart registration (the Run registry entry)".into(),
        );
    }
    Ok(())
}

/// Whether no shortcut is left at `shortcut`: none there, or removed now. Not when it can't be removed, nor when its drive or share
/// can't be reached (Windows reads a path on a drive that is away as missing too: the shortcut may come back with it). A folder that
/// is missing on a drive that is there holds nothing
#[cfg(windows)]
pub fn shortcut_removed(shortcut: &Path) -> bool {
    match std::fs::symlink_metadata(shortcut) {
        Ok(_) => std::fs::remove_file(shortcut).is_ok(),
        // The nearest folder above it that is there must be reached through: not a link (a junction) left pointing at a drive that
        // is away, and not a drive or share that is away (none of it is there)
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => shortcut
            .ancestors()
            .skip(1)
            .find(|a| std::fs::symlink_metadata(a).is_ok())
            .is_some_and(Path::is_dir),
        Err(_) => false,
    }
}

#[cfg(windows)]
pub fn registered() -> bool {
    shortcut_path().is_ok_and(|p| p.is_file())
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
    // agy is found by its path (not by PATH), but its own child processes may need its folder. Added also while Gemini is turned
    // off, so turning it on later doesn't need another install
    if let Some(dir) = crate::providers::gemini::gemini_bin(&cfg.gemini)
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        add(dir);
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
    #[test]
    fn the_gemini_statusline_command_quotes_its_path_for_a_folder_with_spaces() {
        let cli = std::path::Path::new(r"C:\My Tools\Headroom\bin\headroom.exe");
        assert_eq!(
            gemini_statusline_command(cli),
            r#""C:\My Tools\Headroom\bin\headroom.exe" statusline --gemini"#
        );
        // as printed in the note (JSON): the quotes kept, escaped
        assert_eq!(
            serde_json::json!(gemini_statusline_command(cli)).to_string(),
            r#""\"C:\\My Tools\\Headroom\\bin\\headroom.exe\" statusline --gemini""#
        );
    }

    use super::*;

    #[test]
    fn install_tells_how_gemini_fetches_where_it_may_be_on_by_default() {
        let h = crate::test_util::TempHome::new("headroom-install-gemini-note");
        let agy = h.join("agy.exe");
        std::fs::write(&agy, "").unwrap();
        let mut cfg = Config::default();
        cfg.gemini.gemini_bin = agy.display().to_string();
        let cli = h.join("bin").join("headroom.exe");
        let note = gemini_default_note(&cfg, &cli);
        if crate::providers::gemini::default_on_os() {
            let note = note.unwrap();
            assert!(note.contains("statusline --gemini"), "{note}");
            assert!(note.contains("enabled = false under [gemini]"), "{note}");
            assert!(note.contains("1.5.14"), "{note}");
        } else {
            assert_eq!(note, None, "not on by default here");
        }
        // chosen in config.toml, or no agy: nothing to tell
        for chosen in [Some(true), Some(false)] {
            cfg.gemini.enabled = chosen;
            assert_eq!(gemini_default_note(&cfg, &cli), None);
        }
        cfg.gemini.enabled = None;
        cfg.gemini.gemini_bin = h.join("missing.exe").display().to_string();
        assert_eq!(gemini_default_note(&cfg, &cli), None);
    }

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
        // Stand-in for the agent: holds the lock, publishes its session and releases them on seeing the stop request for it
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
            let session = crate::agent::publish_session(&h2, "s1").unwrap();
            ready_tx.send(()).unwrap();
            while !take_stop_request(&h2, "s1") {
                std::thread::sleep(Duration::from_millis(50));
            }
            drop(session);
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
    fn stop_gives_up_without_killing_keeps_its_request_for_that_session_only_and_never_stops_another_command()
     {
        let h = home("stuck");
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(h.join(LOCK_FILE))
            .unwrap();
        f.try_lock().unwrap();
        // agent.lock held by another command (no session): nothing is asked of it
        assert!(stop(&h, Duration::from_millis(500)).is_err());
        assert!(!h.join(STOP_FILE).exists());
        // an agent stuck in a fetch: the request for its session stays, so it stops once the fetch ends
        let session = crate::agent::publish_session(&h, "s1").unwrap();
        assert!(stop(&h, Duration::from_millis(500)).is_err());
        assert_eq!(std::fs::read_to_string(h.join(STOP_FILE)).unwrap(), "s1");
        // an agent started later (another session) drops it, and isn't stopped by it
        drop_other_stops(&h, "s2");
        assert!(!take_stop_request(&h, "s2"));
        drop(session);
        drop(f);
        let _ = std::fs::remove_dir_all(h);
    }

    /// The DLL names a Windows program imports (its PE import table)
    #[cfg(windows)]
    fn imported_dlls(exe: &[u8]) -> Vec<String> {
        let u16_at = |o: usize| u16::from_le_bytes([exe[o], exe[o + 1]]) as usize;
        let u32_at = |o: usize| u32::from_le_bytes(exe[o..o + 4].try_into().unwrap()) as usize;
        let pe = u32_at(0x3C);
        assert_eq!(&exe[pe..pe + 4], b"PE\0\0");
        let sections = u16_at(pe + 6);
        let optional = pe + 24;
        let optional_size = u16_at(pe + 20);
        // PE32+ (64-bit): the import table's address is data directory 1
        assert_eq!(u16_at(optional), 0x20B);
        let imports = u32_at(optional + 112 + 8);
        let table = optional + optional_size;
        let offset = |rva: usize| {
            (0..sections)
                .map(|i| table + i * 40)
                .find_map(|s| {
                    let (va, size, raw) = (
                        u32_at(s + 12),
                        u32_at(s + 8).max(u32_at(s + 16)),
                        u32_at(s + 20),
                    );
                    (va..va + size).contains(&rva).then(|| rva - va + raw)
                })
                .unwrap()
        };
        let mut names = Vec::new();
        let mut d = offset(imports);
        while u32_at(d + 12) != 0 {
            let name = offset(u32_at(d + 12));
            let end = exe[name..].iter().position(|&b| b == 0).unwrap();
            names.push(String::from_utf8_lossy(&exe[name..name + end]).to_ascii_lowercase());
            d += 20;
        }
        names
    }

    #[cfg(windows)]
    #[test]
    fn the_program_doesn_t_link_the_shell_libraries_the_background_agent_never_uses() {
        // this test program is built from the same code as headroom.exe and headroomw.exe
        let dlls = imported_dlls(&std::fs::read(std::env::current_exe().unwrap()).unwrap());
        assert!(dlls.iter().any(|d| d == "kernel32.dll"), "{dlls:?}");
        for heavy in ["shell32.dll", "ole32.dll", "combase.dll", "oleaut32.dll"] {
            assert!(
                !dlls.iter().any(|d| d == heavy),
                "{heavy} is linked: {dlls:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_startup_folder_is_the_one_windows_reports() {
        let folder = startup_folder().expect("Windows names the Startup folder");
        let told = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Environment]::GetFolderPath('Startup')",
            ])
            .output()
            .unwrap();
        assert_eq!(
            folder,
            PathBuf::from(String::from_utf8_lossy(&told.stdout).trim())
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_startup_shortcut_starts_the_windowless_agent_with_its_paths_given_apart_from_the_script()
    {
        let target = Path::new(r"C:\Users\a b\.headroom\bin\headroomw.exe");
        let shortcut = Path::new(r"C:\Users\a b\AppData\Roaming\Startup\Headroom.lnk");
        let c = shortcut_command(shortcut, target);
        assert!(
            c.get_program()
                .to_string_lossy()
                .ends_with(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            "Windows PowerShell from the system folder"
        );
        let args: Vec<_> = c
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            ["-NoProfile", "-NonInteractive", "-Command", SHORTCUT_SCRIPT]
        );
        // the paths only in the environment (a space or a quote in them can't break the script)
        assert!(!SHORTCUT_SCRIPT.contains(r"C:\"));
        let env: std::collections::BTreeMap<_, _> = c
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert_eq!(
            env["HEADROOM_SHORTCUT"].as_deref(),
            Some(shortcut.to_str().unwrap())
        );
        assert_eq!(
            env["HEADROOM_TARGET"].as_deref(),
            Some(target.to_str().unwrap())
        );
        assert_eq!(
            env["HEADROOM_TARGET_DIR"].as_deref(),
            Some(r"C:\Users\a b\.headroom\bin")
        );
        assert!(
            SHORTCUT_SCRIPT.contains("$s.Arguments = 'agent'")
                && SHORTCUT_SCRIPT.contains("$s.Save()")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_startup_shortcut_is_saved_where_asked_also_in_a_folder_with_spaces() {
        // a temporary folder, never the user's Startup folder
        let dir = std::env::temp_dir().join(format!("headroom shortcut {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let shortcut = dir.join(SHORTCUT_NAME);
        let target = dir.join("headroomw.exe");
        std::fs::write(&target, b"").unwrap();
        assert!(save_shortcut(&shortcut, &target));
        let bytes = std::fs::read(&shortcut).unwrap();
        // a shell link's header: its size (76) and its class ID
        assert_eq!(&bytes[..4], &[0x4C, 0, 0, 0]);
        assert_eq!(&bytes[4..8], &[0x01, 0x14, 0x02, 0x00]);
        // it starts the agent: read back by Windows itself
        let read = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:HEADROOM_SHORTCUT); $s.TargetPath + '|' + $s.Arguments",
            ])
            .env("HEADROOM_SHORTCUT", &shortcut)
            .output()
            .unwrap();
        let told = String::from_utf8_lossy(&read.stdout).trim().to_string();
        let (path, args) = told.rsplit_once('|').expect("path|arguments");
        assert_eq!(args, "agent");
        // the same file (Windows may write it with the long names of a folder given by its short name, as RUNNER~1)
        assert_eq!(
            std::fs::canonicalize(path).unwrap(),
            std::fs::canonicalize(&target).unwrap(),
            "{told}"
        );
        // saved again over the earlier one
        assert!(save_shortcut(&shortcut, &target));
        // removed: then none is left; none in a folder that is there is removed too
        assert!(shortcut_removed(&shortcut));
        assert!(!shortcut.exists());
        assert!(shortcut_removed(&shortcut));
        // a folder that isn't there on a drive that is: nothing in it, so nothing left
        assert!(shortcut_removed(&dir.join("gone").join(SHORTCUT_NAME)));
        // on a drive that is away: not known to be removed
        let away = ('D'..='Z')
            .map(|d| format!(r"{d}:\"))
            .find(|root| !Path::new(root).exists())
            .expect("a drive letter not in use");
        assert!(!shortcut_removed(
            &Path::new(&away).join(r"Startup\Headroom.lnk")
        ));
        assert!(!shortcut_removed(Path::new(
            r"\\headroom-no-such-host.invalid\share\Startup\Headroom.lnk"
        )));
        // through a junction whose target is away (a drive taken out): not known to be removed
        let target = dir.join("external");
        std::fs::create_dir_all(target.join("Startup")).unwrap();
        let junction = dir.join("linked");
        let made = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .stdout(Stdio::null())
            .status()
            .unwrap();
        assert!(made.success());
        let through = junction.join("Startup").join(SHORTCUT_NAME);
        assert!(shortcut_removed(&through), "reached: nothing there");
        std::fs::remove_dir_all(&target).unwrap();
        assert!(!shortcut_removed(&through), "its target away");
        let _ = std::fs::remove_dir(&junction);
        let _ = std::fs::remove_dir_all(&dir);
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
