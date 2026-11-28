// Headroom for Windows: a notch on the right edge of the screen and a tray icon, showing the usage limits the Headroom server
// has (read with a read token, every 5 minutes at most). It never touches Claude, Codex or Gemini itself.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod art;
mod demo;
mod gfx;
mod glass;
mod model;
mod notch;
mod prefs;
mod schedule;
mod screens;
mod server;
mod settings;
mod startup;
mod theme;
mod tray;

mod icons {
    include!(concat!(env!("OUT_DIR"), "/icons.rs"));
}

use model::View;
use schedule::Schedule;
use server::{ReadError, Settings};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::Controls::{
    InitCommonControlsEx, ICC_BAR_CLASSES, ICC_STANDARD_CLASSES, ICC_TAB_CLASSES,
    INITCOMMONCONTROLSEX,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::*;

/** The reader's state changed: the notch takes it again */
pub const WM_APP_STATE: u32 = WM_APP + 1;
/** The tray icon was clicked */
pub const WM_APP_TRAY: u32 = WM_APP + 2;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/** Milliseconds on a clock the PC's time setting doesn't move: the waits between reads are counted on it */
pub fn mono_ms() -> i64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as i64 + 1
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    /** A read token is kept for the server in the settings */
    has_token: bool,
    /** Moves on with every change of the server, the token or the sample switch: a read started before it isn't taken */
    generation: u64,
    /** When the server in the settings may be read next */
    schedule: Schedule,
    /** The same for servers used before (moving away and back doesn't read sooner) */
    waits: std::collections::HashMap<String, Schedule>,
    /** The last view the server gave that could be shown (checked) */
    view: Option<Arc<View>>,
    error: Option<String>,
    fetched_at: Option<i64>,
}

impl Inner {
    /** The schedule of a server: the current one's, or one used before */
    fn schedule_of(&mut self, url: &str) -> &mut Schedule {
        if url == self.settings.url {
            &mut self.schedule
        } else {
            self.waits.entry(url.to_string()).or_default()
        }
    }

    /** Another server in the settings: its own wait (none for one never read) */
    fn switch_server(&mut self, old: &str, new: &str) {
        let wait = std::mem::take(&mut self.schedule);
        if !old.is_empty() {
            self.waits.insert(old.to_string(), wait);
        }
        self.schedule = self.waits.remove(new).unwrap_or_default();
    }

    /** New settings: what was read before is dropped and a read started before is not taken (its timing still counts) */
    fn start_over(&mut self) {
        self.generation += 1;
        self.view = None;
        self.error = None;
        self.fetched_at = None;
    }
}

struct Shared {
    inner: Mutex<Inner>,
    wake: Mutex<mpsc::Sender<()>>,
}

static SHARED: OnceLock<Shared> = OnceLock::new();

fn inner() -> std::sync::MutexGuard<'static, Inner> {
    let shared = SHARED.get().expect("started");
    shared.inner.lock().unwrap_or_else(|e| e.into_inner())
}

/** Wakes the reader (it reads only when the schedule allows it) */
pub fn nudge() {
    if let Some(s) = SHARED.get() {
        if let Ok(tx) = s.wake.lock() {
            let _ = tx.send(());
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /** The built-in sample */
    Demo,
    /** No server or token yet */
    Setup,
    Live,
}

fn mode_of(i: &Inner) -> Mode {
    if i.settings.demo {
        Mode::Demo
    } else if i.settings.url.is_empty() || !i.has_token {
        Mode::Setup
    } else {
        Mode::Live
    }
}

/** What the notch shows, taken from the reader's state */
pub struct Snapshot {
    pub mode: Mode,
    pub view: Option<Arc<View>>,
    pub error: Option<String>,
    pub fetched_at: Option<i64>,
}

pub fn snapshot() -> Snapshot {
    let i = inner();
    let mode = mode_of(&i);
    Snapshot {
        mode,
        view: if mode == Mode::Live {
            i.view.clone()
        } else {
            None
        },
        error: if mode == Mode::Setup {
            Some(ReadError::NotSetUp.text())
        } else {
            i.error.clone()
        },
        fetched_at: i.fetched_at,
    }
}

/** The line under the card: where the values come from and how old they are; and whether it warns */
pub fn footer(s: &Snapshot, now: i64) -> (String, bool) {
    match s.mode {
        Mode::Demo => ("Sample data (Settings to connect)".to_string(), false),
        Mode::Setup => (
            s.error
                .clone()
                .unwrap_or_else(|| "Set the server in Settings".to_string()),
            true,
        ),
        Mode::Live => match (&s.error, s.fetched_at) {
            (Some(e), _) => (format!("⚠ {e}"), true),
            (None, None) => ("Reading…".to_string(), false),
            (None, Some(at)) => {
                let minutes = (now - at).div_euclid(60_000);
                (
                    if minutes < 1 {
                        "Read just now".to_string()
                    } else {
                        format!("Read {minutes} min ago")
                    },
                    false,
                )
            }
        },
    }
}

/** A click on a ring: reads now if the schedule allows it, else says how long until it may (minutes, rounded up) */
pub fn refresh_now() -> i64 {
    let wait = inner().schedule.wait_ms(mono_ms());
    if wait == 0 {
        nudge();
    }
    (wait + 59_999) / 60_000
}

pub fn refresh_from_menu() {
    if inner().schedule.may_read(mono_ms()) {
        nudge();
    }
}

/** The server address, whether a token is kept for it, and the sample switch */
pub fn settings_now() -> (String, bool, bool) {
    let i = inner();
    (i.settings.url.clone(), i.has_token, i.settings.demo)
}

/** Saves the server and (when given) its token. The token goes to the credential store only, never to a file or a log, and is
 * kept with the server it was given for: another server never receives it */
pub fn save_settings(url: &str, token: Option<String>, demo: bool) -> Result<(), String> {
    // All under the state's lock, which the reader also takes to pick the server, its token and the generation together
    let mut i = inner();
    apply_save(&mut i, &OsKeep, url, token, demo)?;
    drop(i);
    nudge();
    notch::post_state();
    Ok(())
}

/** How the notch looks and behaves now */
pub fn prefs() -> prefs::Prefs {
    inner().settings.prefs.clone()
}

/** Takes new prefs and shows them; with `write`, also writes them to the settings file (with the server and the token as they
 * are). When the file can't be written they are still shown, until the app ends, and the error says so */
pub fn set_prefs(p: prefs::Prefs, write: bool) -> Result<(), String> {
    let saved = {
        let mut i = inner();
        apply_prefs(&mut i, &OsKeep, p, write)
    };
    notch::post_place();
    saved
}

fn apply_prefs(
    i: &mut Inner,
    keep: &impl Keep,
    p: prefs::Prefs,
    write: bool,
) -> Result<(), String> {
    let next = Settings {
        prefs: p,
        ..i.settings.clone()
    };
    let written = if write { keep.write(&next) } else { Ok(()) };
    i.settings = next;
    written
}

pub fn remove_token() -> Result<(), String> {
    let mut i = inner();
    apply_remove(&mut i, &OsKeep)?;
    drop(i);
    nudge();
    notch::post_state();
    Ok(())
}

/** Where the settings and the token are kept: the settings file and the credential store (a stand-in in the tests) */
trait Keep {
    fn write(&self, s: &Settings) -> Result<(), String>;
    fn store(&self, origin: &str, slot: u64, token: &str) -> Result<(), String>;
    fn delete(&self, origin: &str, slot: u64) -> Result<(), String>;
    fn read(&self, s: &Settings) -> Option<String>;
    fn has(&self, origin: &str, slot: u64) -> bool;
    fn new_slot(&self) -> u64;
}

struct OsKeep;

impl Keep for OsKeep {
    fn write(&self, s: &Settings) -> Result<(), String> {
        server::save_settings(s)
    }
    fn store(&self, origin: &str, slot: u64, token: &str) -> Result<(), String> {
        server::store_token(origin, slot, token)
    }
    fn delete(&self, origin: &str, slot: u64) -> Result<(), String> {
        server::delete_token(origin, slot)
    }
    fn read(&self, s: &Settings) -> Option<String> {
        server::read_token(s)
    }
    fn has(&self, origin: &str, slot: u64) -> bool {
        server::has_entry(origin, slot)
    }
    fn new_slot(&self) -> u64 {
        server::new_slot()
    }
}

/** Saves the server and (when given) its token. The token goes to the credential store only, never to a file or a log; each
 * saved token gets an entry of its own, which only the settings file names, so the save takes effect when the file is written
 * and an entry the file doesn't name (a failed save's, one that couldn't be removed) is never read */
fn apply_save(
    i: &mut Inner,
    keep: &impl Keep,
    url: &str,
    token: Option<String>,
    demo: bool,
) -> Result<(), String> {
    let url = if url.trim().is_empty() {
        String::new()
    } else {
        server::normalize_base_url(url)
            .ok_or("Enter an https:// address with the host name only (no path)")?
    };
    let token = token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if token.is_some() && url.is_empty() {
        return Err("Enter the server the token is for".into());
    }
    let same_server = url == i.settings.url;
    if !demo && (url.is_empty() || (token.is_none() && !(same_server && i.has_token))) {
        return Err("Enter the server and its read token, or choose the sample".into());
    }
    let old = i.settings.clone();
    // The same token for the same server again: nothing to store, and what is shown stays
    let token = token.filter(|t| !(same_server && keep.read(&old).as_deref() == Some(t.as_str())));
    let token_slot = match &token {
        Some(t) => {
            // A slot no entry of this server has (and never the one in use), so storing can't touch the token in use
            let slot = (0..8)
                .map(|_| keep.new_slot())
                .find(|&n| n != 0 && !(url == old.url && n == old.token_slot) && !keep.has(&url, n))
                .ok_or("Couldn't find a free place for the token")?;
            keep.store(&url, slot, t)?;
            slot
        }
        None if same_server => old.token_slot,
        None => 0,
    };
    let settings = Settings {
        url,
        demo,
        token_slot,
        prefs: old.prefs.clone(),
    };
    let new_entry = token.is_some();
    if let Err(e) = keep.write(&settings) {
        // The old settings and token stay as they were; the new entry goes
        if new_entry {
            let _ = keep.delete(&settings.url, token_slot);
        }
        return Err(e);
    }
    // The old entry is no longer named
    if (old.url.as_str(), old.token_slot) != (settings.url.as_str(), token_slot) {
        let _ = keep.delete(&old.url, old.token_slot);
    }
    let has_token = keep.read(&settings).is_some();
    let new_server = old.url != settings.url;
    if new_server {
        i.switch_server(&old.url, &settings.url);
    }
    // A new token: the wait is cut back to 5 minutes after the server's last read (failures were likely the old token's)
    if new_entry {
        i.schedule.new_token();
    }
    let new_source = new_server || new_entry || i.has_token != has_token;
    i.settings = settings;
    i.has_token = has_token;
    if new_source {
        i.start_over();
    }
    Ok(())
}

/** Forgets the token: the settings stop naming it first, then its entry goes */
fn apply_remove(i: &mut Inner, keep: &impl Keep) -> Result<(), String> {
    let settings = Settings {
        token_slot: 0,
        ..i.settings.clone()
    };
    keep.write(&settings)?;
    let _ = keep.delete(&i.settings.url, i.settings.token_slot);
    i.settings = settings;
    i.has_token = false;
    i.start_over();
    Ok(())
}

pub fn quit() {
    tray::remove();
    unsafe { PostQuitMessage(0) };
}

/** What a read brought, applied to the state of the generation it was started in */
fn take_result(i: &mut Inner, result: Result<Option<View>, ReadError>, now: i64, mono: i64) {
    match result {
        Ok(Some(view)) => {
            // A view older than the one shown (it arrived late, or the server read an earlier copy) is not shown, as on the widget
            if i.view
                .as_ref()
                .is_none_or(|v| view.data_version >= v.data_version)
            {
                i.view = Some(Arc::new(view));
            }
            i.error = None;
            i.fetched_at = Some(now);
            i.schedule.succeeded(mono);
        }
        // A view the widget would refuse isn't shown either: the last one stays, and the error says why
        Ok(None) => {
            i.error = Some(ReadError::BadBody.text());
            i.schedule.failed(mono);
        }
        Err(e) => {
            i.error = Some(e.text());
            i.schedule.failed(mono);
        }
    }
}

/** Reads the server when the schedule allows it, and tells the notch. Sleeps until the next allowed time or a nudge */
fn reader(rx: mpsc::Receiver<()>) {
    loop {
        // The server, its token and the generation are taken together, so a change in Settings meanwhile can't mix them
        let job = {
            let i = inner();
            (mode_of(&i) == Mode::Live && i.schedule.may_read(mono_ms())).then(|| {
                (
                    i.generation,
                    i.settings.url.clone(),
                    server::read_token(&i.settings),
                )
            })
        };
        if let Some((generation, url, token)) = job {
            let result = token
                .ok_or(ReadError::NotSetUp)
                .and_then(|token| server::read_view(&url, &token, &server::local_time_zone()));
            // Checked before taking the lock (a large answer doesn't hold up the screen)
            let checked = result.map(|body| model::sanitize_view(&body));
            let mut i = inner();
            if i.generation == generation {
                take_result(&mut i, checked, now_ms(), mono_ms());
            } else {
                // Settings changed meanwhile: the result isn't shown, but the server was read, so its 5 minutes count
                i.schedule_of(&url).read_anyway(mono_ms());
            }
        }
        let wait = {
            let i = inner();
            if mode_of(&i) == Mode::Live {
                i.schedule.wait_ms(mono_ms()).max(1_000)
            } else {
                3_600_000
            }
        };
        notch::post_state();
        let _ = rx.recv_timeout(Duration::from_millis(wait as u64));
    }
}

fn main() -> windows::core::Result<()> {
    unsafe {
        // One notch per sign-in
        let _single = CreateMutexW(None, true, w!("Local\\HeadroomDesktop"))?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return Ok(());
        }
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let icc = INITCOMMONCONTROLSEX {
            dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
            dwICC: ICC_STANDARD_CLASSES | ICC_TAB_CLASSES | ICC_BAR_CLASSES,
        };
        let _ = InitCommonControlsEx(&icc);
    }
    let (tx, rx) = mpsc::channel();
    let settings = server::load_settings();
    let has_token = server::read_token(&settings).is_some();
    let _ = SHARED.set(Shared {
        inner: Mutex::new(Inner {
            settings,
            has_token,
            ..Inner::default()
        }),
        wake: Mutex::new(tx),
    });

    // HEADROOM_DESKTOP_OPEN=1 keeps the notch open with its first card (for checking the look without the pointer)
    let pinned = std::env::var_os("HEADROOM_DESKTOP_OPEN").is_some();
    tray::create()?;
    notch::create(pinned)?;
    std::thread::spawn(move || reader(rx));
    // First run with nothing set: open Settings (development builds: also with HEADROOM_DESKTOP_SETTINGS=1, for checking it)
    let check_settings =
        cfg!(debug_assertions) && std::env::var_os("HEADROOM_DESKTOP_SETTINGS").is_some();
    if mode_of(&inner()) == Mode::Setup || check_settings {
        settings::open();
    }
    unsafe {
        let mut msg = MSG::default();
        // 0 is WM_QUIT, -1 a failure: both end the loop
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            if let Some(h) = settings::hwnd() {
                if IsDialogMessageW(h, &msg).as_bool() {
                    continue;
                }
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    tray::remove();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(mode: Mode, error: Option<&str>, fetched_at: Option<i64>) -> Snapshot {
        Snapshot {
            mode,
            view: None,
            error: error.map(str::to_string),
            fetched_at,
        }
    }

    #[test]
    fn the_footer_says_where_the_values_come_from() {
        assert_eq!(
            footer(&snap(Mode::Demo, None, None), 0).0,
            "Sample data (Settings to connect)"
        );
        assert!(footer(&snap(Mode::Setup, Some("Set up"), None), 0).1);
        assert_eq!(footer(&snap(Mode::Live, None, None), 0).0, "Reading…");
        assert_eq!(
            footer(&snap(Mode::Live, None, Some(0)), 59_000).0,
            "Read just now"
        );
        assert_eq!(
            footer(&snap(Mode::Live, None, Some(0)), 3 * 60_000).0,
            "Read 3 min ago"
        );
        assert_eq!(
            footer(
                &snap(Mode::Live, Some("Can't reach the server"), Some(0)),
                0
            ),
            ("⚠ Can't reach the server".to_string(), true)
        );
    }

    fn view(version: u64) -> Result<Option<View>, ReadError> {
        Ok(model::sanitize_view(&serde_json::json!({
            "view_version": 1, "data_version": version, "claude": null, "codex": null
        })))
    }

    #[test]
    fn an_older_view_never_replaces_a_newer_one() {
        let mut i = Inner::default();
        take_result(&mut i, view(42), 1_000, 1);
        assert_eq!(i.view.as_ref().map(|v| v.data_version), Some(42));
        take_result(&mut i, view(41), 2_000, 2);
        assert_eq!(
            i.view.as_ref().map(|v| v.data_version),
            Some(42),
            "a late answer with older data"
        );
        assert_eq!(i.fetched_at, Some(2_000), "the read itself worked");
        take_result(&mut i, view(43), 3_000, 3);
        assert_eq!(i.view.as_ref().map(|v| v.data_version), Some(43));
    }

    #[test]
    fn a_failed_or_refused_read_keeps_the_view_and_says_why() {
        let mut i = Inner::default();
        take_result(&mut i, view(7), 1_000, 1);
        take_result(
            &mut i,
            Ok(model::sanitize_view(
                &serde_json::json!({ "view_version": 2 }),
            )),
            2_000,
            2,
        );
        assert_eq!(i.view.as_ref().map(|v| v.data_version), Some(7));
        assert_eq!(i.error, Some(ReadError::BadBody.text()));
        take_result(&mut i, Err(ReadError::Network), 3_000, 3);
        assert_eq!(i.view.as_ref().map(|v| v.data_version), Some(7));
        assert_eq!(i.schedule.failures, 2);
        i.start_over();
        assert!(
            i.view.is_none() && i.error.is_none() && i.generation == 1,
            "new settings drop what was read"
        );
    }

    /** A settings file and credential store in memory, which fail when told to */
    #[derive(Default)]
    struct FakeKeep {
        file: std::cell::RefCell<Option<Settings>>,
        entries: std::cell::RefCell<std::collections::HashMap<(String, u64), String>>,
        fail_write: std::cell::Cell<bool>,
        fail_store: std::cell::Cell<bool>,
        fail_delete: std::cell::Cell<bool>,
        /** The slot numbers handed out, in turn (then counting on) */
        slots: std::cell::RefCell<Vec<u64>>,
        next: std::cell::Cell<u64>,
    }

    impl Keep for FakeKeep {
        fn write(&self, s: &Settings) -> Result<(), String> {
            if self.fail_write.get() {
                return Err("Couldn't write the settings".into());
            }
            *self.file.borrow_mut() = Some(s.clone());
            Ok(())
        }
        fn store(&self, origin: &str, slot: u64, token: &str) -> Result<(), String> {
            if self.fail_store.get() {
                return Err("Couldn't save the token".into());
            }
            self.entries
                .borrow_mut()
                .insert((origin.to_string(), slot), token.to_string());
            Ok(())
        }
        fn delete(&self, origin: &str, slot: u64) -> Result<(), String> {
            if self.fail_delete.get() {
                return Err("Couldn't remove the token".into());
            }
            self.entries
                .borrow_mut()
                .remove(&(origin.to_string(), slot));
            Ok(())
        }
        fn read(&self, s: &Settings) -> Option<String> {
            self.entries
                .borrow()
                .get(&(s.url.clone(), s.token_slot))
                .cloned()
        }
        fn has(&self, origin: &str, slot: u64) -> bool {
            self.entries
                .borrow()
                .contains_key(&(origin.to_string(), slot))
        }
        fn new_slot(&self) -> u64 {
            let mut given = self.slots.borrow_mut();
            if !given.is_empty() {
                return given.remove(0);
            }
            self.next.set(self.next.get() + 1);
            self.next.get()
        }
    }

    /** What the reader would send, and what a restart would read */
    fn used(i: &Inner, keep: &FakeKeep) -> (Option<String>, Option<String>) {
        let after_restart = keep.file.borrow().as_ref().and_then(|s| keep.read(s));
        (keep.read(&i.settings), after_restart)
    }

    const A: &str = "https://a.example";
    const B: &str = "https://b.example";

    #[test]
    fn a_failed_save_leaves_the_token_in_use_as_it_was() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        assert_eq!(used(&i, &keep), (Some("one".into()), Some("one".into())));
        // Same server, new token, the file can't be written: the old token stays in use, now and after a restart
        keep.fail_write.set(true);
        assert!(apply_save(&mut i, &keep, A, Some("two".into()), false).is_err());
        assert_eq!(used(&i, &keep), (Some("one".into()), Some("one".into())));
        // Another server: the same
        assert!(apply_save(&mut i, &keep, B, Some("three".into()), false).is_err());
        assert_eq!(used(&i, &keep), (Some("one".into()), Some("one".into())));
        assert_eq!(i.settings.url, A);
        assert_eq!(
            keep.entries.borrow().len(),
            1,
            "the failed saves' entries went"
        );
        // The token store fails: nothing changes either
        keep.fail_write.set(false);
        keep.fail_store.set(true);
        assert!(apply_save(&mut i, &keep, B, Some("four".into()), false).is_err());
        assert_eq!(used(&i, &keep), (Some("one".into()), Some("one".into())));
    }

    #[test]
    fn an_entry_the_settings_dont_name_is_never_taken_up() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        // A's entry can't be removed when moving to B
        keep.fail_delete.set(true);
        apply_save(&mut i, &keep, B, Some("two".into()), false).unwrap();
        assert_eq!(used(&i, &keep), (Some("two".into()), Some("two".into())));
        // Back to A without a token: A's old entry is still there, but isn't named, so it isn't used
        assert!(
            apply_save(&mut i, &keep, A, None, false).is_err(),
            "a token is needed for A"
        );
        apply_save(&mut i, &keep, A, None, true).unwrap();
        assert_eq!(used(&i, &keep), (None, None));
        assert!(!i.has_token);
        // A failed write while moving leaves its entry behind (removal failing too); a later save with no token doesn't take it
        keep.fail_write.set(true);
        assert!(apply_save(&mut i, &keep, B, Some("three".into()), true).is_err());
        keep.fail_write.set(false);
        apply_save(&mut i, &keep, B, None, true).unwrap();
        assert_eq!(used(&i, &keep), (None, None));
    }

    #[test]
    fn removing_the_token_stops_its_use_even_if_its_entry_stays() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        keep.fail_delete.set(true);
        apply_remove(&mut i, &keep).unwrap();
        assert_eq!(used(&i, &keep), (None, None));
        keep.fail_write.set(true);
        apply_save(&mut i, &keep, A, Some("two".into()), false).unwrap_err();
        assert_eq!(used(&i, &keep), (None, None));
    }

    #[test]
    fn a_slot_in_use_is_never_written_over() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        keep.slots.borrow_mut().push(7);
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        assert_eq!(i.settings.token_slot, 7);
        // The clock gives the same number again, and the file can't be written: the token in use stays
        keep.slots.borrow_mut().extend([7, 7]);
        keep.fail_write.set(true);
        assert!(apply_save(&mut i, &keep, A, Some("two".into()), false).is_err());
        assert_eq!(used(&i, &keep), (Some("one".into()), Some("one".into())));
        // Another server with the same number: a save that works removes only A's entry
        keep.fail_write.set(false);
        keep.slots.borrow_mut().push(7);
        apply_save(&mut i, &keep, B, Some("three".into()), false).unwrap();
        assert_eq!(
            used(&i, &keep),
            (Some("three".into()), Some("three".into()))
        );
        assert_eq!(keep.entries.borrow().len(), 1);
    }

    #[test]
    fn the_prefs_and_the_server_never_lose_each_other() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        let glass = prefs::Prefs {
            theme: prefs::Theme::Glass,
            position: 10,
            ..prefs::Prefs::default()
        };
        let generation = i.generation;
        apply_prefs(&mut i, &keep, glass.clone(), true).unwrap();
        assert_eq!(
            i.generation, generation,
            "the prefs don't read the server again"
        );
        assert_eq!(used(&i, &keep), (Some("one".into()), Some("one".into())));
        assert_eq!(
            keep.file.borrow().as_ref().map(|s| s.prefs.clone()),
            Some(glass.clone())
        );
        // A new token keeps the prefs
        apply_save(&mut i, &keep, A, Some("two".into()), false).unwrap();
        assert_eq!(i.settings.prefs, glass);
        assert_eq!(
            keep.file.borrow().as_ref().map(|s| s.prefs.clone()),
            Some(glass.clone())
        );
        // A file that can't be written: shown anyway, and said
        keep.fail_write.set(true);
        assert!(apply_prefs(&mut i, &keep, prefs::Prefs::default(), true).is_err());
        assert_eq!(i.settings.prefs, prefs::Prefs::default());
        assert_eq!(used(&i, &keep).0, Some("two".into()));
    }

    #[test]
    fn the_same_token_saved_again_changes_nothing() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        take_result(&mut i, view(1), 1_000, 1);
        let generation = i.generation;
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        assert_eq!(i.generation, generation);
        assert!(i.view.is_some(), "what is shown stays");
    }

    #[test]
    fn the_wait_is_kept_for_the_same_server_after_a_success() {
        let keep = FakeKeep::default();
        let mut i = Inner::default();
        apply_save(&mut i, &keep, A, Some("one".into()), false).unwrap();
        take_result(&mut i, view(1), 1_000, 1);
        assert!(!i.schedule.may_read(2));
        // A new token, or the token removed and entered again: no sooner read
        apply_save(&mut i, &keep, A, Some("two".into()), false).unwrap();
        assert!(!i.schedule.may_read(2));
        apply_remove(&mut i, &keep).unwrap();
        apply_save(&mut i, &keep, A, Some("two".into()), false).unwrap();
        assert!(!i.schedule.may_read(2));
        // Away to B and back to A: A's wait is still there
        apply_save(&mut i, &keep, B, Some("b".into()), false).unwrap();
        assert!(i.schedule.may_read(2), "B was never read");
        apply_save(&mut i, &keep, A, Some("two".into()), false).unwrap();
        assert!(!i.schedule.may_read(2), "A's wait came back");
        // The sample switch alone changes nothing of it
        let generation = i.generation;
        apply_save(&mut i, &keep, A, None, true).unwrap();
        assert_eq!(i.generation, generation);
        // After failures, a new token waits only until 5 minutes after the last read, and never less
        take_result(&mut i, Err(ReadError::TokenRejected), 2_000, 300_001);
        take_result(&mut i, Err(ReadError::TokenRejected), 3_000, 600_002);
        assert!(
            !i.schedule.may_read(1_000_000),
            "20 minutes after two failures"
        );
        apply_save(&mut i, &keep, A, Some("three".into()), false).unwrap();
        assert!(!i.schedule.may_read(900_001));
        assert!(i.schedule.may_read(900_002));
        // An answer to a read made before the change: 5 minutes from it, no backoff
        take_result(&mut i, Ok(None), 4_000, 900_002);
        apply_save(&mut i, &keep, A, Some("four".into()), false).unwrap();
        let mut late = i.schedule.clone();
        late.read_anyway(1_000_000);
        assert_eq!(late.next_at, Some(1_300_000));
    }
}
