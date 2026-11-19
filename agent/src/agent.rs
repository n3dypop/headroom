//! Background loop (`headroom agent`).
//! Sleeps until the next scheduled time or a file change. Never busy-loops.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use crate::config::{self, Config, collector_id};
use crate::install::{STOP_FILE, take_stop_request};
use crate::providers::claude::ClaudeProvider;
use crate::providers::codex::CodexProvider;
use crate::providers::{Event, Provider};
use crate::push::Pusher;
use crate::schedule::{
    Coordinator, NextRun, SCHEDULE_FILE, SESSION_FILE, SESSION_LOCK_FILE, Schedule, TurnAsker,
};
use crate::schema::{ProviderSnapshot, build_snapshot};
use crate::statusline::CAPTURE_FILE;
use crate::store::{Logger, write_json_atomic};
use crate::time::{MINUTE_MS, now_ms};

/// Wake at least this often even with nothing scheduled (guards against clock changes and resume from sleep)
const MAX_SLEEP_MS: i64 = 5 * MINUTE_MS;
const MIN_SLEEP_MS: i64 = 1_000;

pub fn make_providers(home: &Path, cfg: &Config, log: &Logger) -> Vec<Box<dyn Provider>> {
    vec![
        Box::new(ClaudeProvider::new(home, cfg.claude.clone(), log.clone())),
        Box::new(CodexProvider::new(home, cfg.codex.clone(), log.clone())),
    ]
}

pub fn write_snapshot(
    home: &Path,
    latest: &BTreeMap<String, ProviderSnapshot>,
    now: i64,
    collector: &str,
) -> std::io::Result<()> {
    write_json_atomic(
        &home.join("snapshot.json"),
        &build_snapshot(latest.clone(), now, collector),
    )
}

pub fn run(home: &Path) -> i32 {
    let log = Logger::file(home);
    let _ = std::fs::create_dir_all(home);

    // Prevent a second instance (OS file lock; released automatically if the process dies)
    let lock = match std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join("agent.lock"))
    {
        Ok(f) => f,
        Err(e) => {
            log.log(&format!("Cannot open the lock file: {e}"));
            return 1;
        }
    };
    if lock.try_lock().is_err() {
        log.log("Another agent is running; exiting");
        return 0;
    }
    // A new session ID on every start: `status` shows the schedule only if it carries the ID in SESSION_FILE and this
    // process still holds its lock, so a schedule left by an earlier (or crashed) agent process is never shown as current.
    // The session file is published together with the schedule below, with the same retry
    let _ = std::fs::remove_file(home.join(SCHEDULE_FILE));
    let session = new_session_id();
    let mut session_file: Option<std::fs::File> = None;

    let cfg = match config::load(home) {
        Ok(c) => c,
        Err(e) => {
            log.log(&e);
            return 2;
        }
    };
    let collector = collector_id(&cfg);
    let (tx, rx) = mpsc::channel();
    let _watcher = start_watcher(home, tx, &log); // held to keep it alive
    let mut providers = make_providers(home, &cfg, &log);
    // Keep collecting even if the push config is invalid (the reason is logged)
    let mut pusher = match Pusher::from_config(home, &cfg, log.clone()) {
        Ok(p) => p,
        Err(e) => {
            log.log(&format!("Not pushing: {e}"));
            None
        }
    };
    let mut latest: BTreeMap<String, ProviderSnapshot> = BTreeMap::new();
    // Fetch turn-taking and interval stretching (schedule.rs). honors = providers that can keep doing passive work while holding off
    let mut coord = Coordinator::new(cfg.schedule.clone(), log.clone());
    let mut honors: BTreeMap<&'static str, bool> = BTreeMap::new();
    // Next check per provider last written for `headroom status` (written only when it changes)
    let mut planned: Option<BTreeMap<String, NextRun>> = None;
    // After a failed write, wait before writing again (events such as statusLine updates can wake the loop often).
    // Measured with the monotonic clock, so clock corrections do not shorten or stretch the wait
    let mut plan_retry_at: Option<Instant> = None;
    let mut last_plan_error_log: Option<Instant> = None;
    log.log(&format!("agent started (collector={collector})"));
    let _ = take_stop_request(home); // a stop request left over from before startup does not stop us

    loop {
        // Stop requests are only honored between fetches (never in the middle of /usage)
        if take_stop_request(home) {
            log.log("Stop requested; exiting");
            // Hand the fetch turns back so another PC takes over at its next check instead of waiting out the lease
            coord.release_turns(pusher.as_mut().map(|x| x as &mut dyn TurnAsker));
            drop(session_file.take()); // releases the session lock
            let _ = std::fs::remove_file(home.join(SCHEDULE_FILE));
            let _ = std::fs::remove_file(home.join(SESSION_FILE));
            return 0;
        }
        let mut changed = false;
        for p in providers.iter_mut() {
            let now = now_ms();
            let id = p.id();
            // When a fetch is due, check the turn and interval stretching. If holding off, tell the provider
            let mut fetching = false;
            let mut skip = false;
            if p.fetch_due_ms(now) <= now {
                let asker = pusher.as_mut().map(|x| x as &mut dyn TurnAsker);
                if coord.before_fetch(id, interval_min(&cfg, id), latest.get(id), asker, now) {
                    fetching = true;
                } else {
                    let passive = p.hold_fetch_until(coord.hold_until(id));
                    honors.insert(id, passive);
                    skip = !passive;
                }
            }
            if !skip && p.next_due_ms(now) <= now {
                let attempted = p.last_fetch_attempt_ms();
                let snap = p.collect(now, false);
                coord.observe(id, &snap, now);
                if fetching {
                    let asker = pusher.as_mut().map(|x| x as &mut dyn TurnAsker);
                    let next = p.fetch_due_ms(now_ms());
                    coord.after_fetch(id, &snap, next, interval_min(&cfg, id), asker, now);
                } else if p.last_fetch_attempt_ms() > attempted {
                    coord.record_fetch(id, now); // fetched without going through the coordinator
                }
                if latest.get(p.id()) != Some(&snap) {
                    latest.insert(p.id().to_string(), snap);
                    changed = true;
                }
            }
        }
        if changed && let Err(e) = write_snapshot(home, &latest, now_ms(), &collector) {
            log.log(&format!("Failed to write snapshot.json: {e}"));
        }
        if let Some(p) = pusher.as_mut() {
            p.record(&latest, changed, now_ms());
            // Stamped after saving the queue, right before sending (the destination checks the send time against its clock)
            let now = now_ms();
            p.push(&build_snapshot(latest.clone(), now, &collector), now);
            // Values from a PC whose clock the destination refuses can't be delivered: hand back any turn it holds, and forget the
            // latest values (stamped by that clock, they would pass as current once the clock is fixed; the next fetches replace them)
            if p.clock_skewed() {
                coord.release_turns(Some(p as &mut dyn TurnAsker));
                latest.clear();
            }
        }

        let now = now_ms();
        let plan: BTreeMap<String, NextRun> = providers
            .iter()
            .map(|p| {
                let id = p.id();
                let mut run = coord.next_run(id, p.fetch_due_ms(now), now);
                run.disabled = !provider_enabled(&cfg, id);
                (id.to_string(), run)
            })
            .collect();
        let retry_ok = plan_retry_at.is_none_or(|t| Instant::now() >= t);
        if planned.as_ref() != Some(&plan) && retry_ok {
            let file = Schedule {
                session: session.clone(),
                providers: plan.clone(),
            };
            let written = match session_file {
                Some(_) => Ok(()),
                None => publish_session(home, &session).map(|f| session_file = Some(f)),
            }
            .and_then(|()| write_json_atomic(&home.join(SCHEDULE_FILE), &file));
            match written {
                Ok(()) => {
                    planned = Some(plan);
                    plan_retry_at = None;
                }
                Err(e) => {
                    // Retried after a minute (not on every wake-up); logged at most every 10 minutes
                    let t = Instant::now();
                    plan_retry_at = Some(t + Duration::from_secs(60));
                    if last_plan_error_log
                        .is_none_or(|l| t.duration_since(l) >= Duration::from_secs(600))
                    {
                        log.log(&format!(
                            "Failed to write the schedule for headroom status: {e}"
                        ));
                        last_plan_error_log = Some(t);
                    }
                }
            }
        }
        let next = providers
            .iter()
            .map(|p| {
                // A provider that cannot do passive work while holding off is not woken until the hold ends
                let hold = coord.hold_until(p.id());
                let due = p.next_due_ms(now);
                if hold > now && !honors.get(p.id()).copied().unwrap_or(false) {
                    due.max(hold)
                } else {
                    due
                }
            })
            .chain(pusher.as_ref().map(Pusher::due_ms))
            .min()
            .unwrap_or(i64::MAX);
        let wait = next.saturating_sub(now).clamp(MIN_SLEEP_MS, MAX_SLEEP_MS);
        match rx.recv_timeout(Duration::from_millis(wait as u64)) {
            Ok(Event::StopRequested) => {}
            Ok(ev) => {
                dispatch(&mut providers, &ev);
                while let Ok(ev) = rx.try_recv() {
                    dispatch(&mut providers, &ev); // consecutive writes produce bursts of events, so handle them together
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                std::thread::sleep(Duration::from_millis(wait as u64))
            }
        }
    }
}

/// Writes SESSION_FILE, then takes an exclusive lock on SESSION_LOCK_FILE (the order matters: while the lock is held,
/// SESSION_FILE already has this session's ID, so files left by a crashed agent never match). agent.lock already makes
/// this process the only writer. The lock lasts as long as the returned handle (the agent's lifetime), so `status` can
/// tell that the session's writer is still running
pub(crate) fn publish_session(home: &Path, session: &str) -> std::io::Result<std::fs::File> {
    std::fs::write(home.join(SESSION_FILE), session)?;
    hold_session_lock(home)
}

pub(crate) fn hold_session_lock(home: &Path) -> std::io::Result<std::fs::File> {
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join(SESSION_LOCK_FILE))?;
    lock.try_lock().map_err(std::io::Error::other)?;
    Ok(lock)
}

/// A session ID that differs on every agent start (process ID, start time and a stack address; not secret)
fn new_session_id() -> String {
    let marker = 0u8;
    crate::store::fnv1a_hex(&[
        &std::process::id().to_string(),
        &now_ms().to_string(),
        &format!("{:p}", &marker),
        &format!("{:?}", Instant::now()),
    ])
}

/// Whether the provider is enabled in the config this agent started with
fn provider_enabled(cfg: &Config, id: &str) -> bool {
    match id {
        "claude" => cfg.claude.enabled,
        "codex" => cfg.codex.enabled,
        _ => true,
    }
}

/// The provider's normal fetch interval (minutes). Used as the length of a turn's lease
fn interval_min(cfg: &Config, id: &str) -> i64 {
    match id {
        "claude" => cfg.claude.interval_min,
        "codex" => cfg.codex.interval_min,
        _ => 5,
    }
}

fn dispatch(providers: &mut [Box<dyn Provider>], ev: &Event) {
    for p in providers.iter_mut() {
        p.on_event(ev);
    }
}

/// Watches the statusLine record file with the OS file watcher (no polling).
fn start_watcher(
    home: &Path,
    tx: Sender<Event>,
    log: &Logger,
) -> Option<notify::RecommendedWatcher> {
    use notify::{EventKind, RecursiveMode, Watcher};
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        if matches!(ev.kind, EventKind::Access(_)) {
            return;
        }
        if ev
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == CAPTURE_FILE))
        {
            let _ = tx.send(Event::ClaudeStatuslineCaptured);
        }
        if ev
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == STOP_FILE))
        {
            let _ = tx.send(Event::StopRequested);
        }
    })
    .map_err(|e| log.log(&format!("Cannot start the file watcher: {e}")))
    .ok()?;

    if let Err(e) = watcher.watch(home, RecursiveMode::NonRecursive) {
        log.log(&format!("Cannot watch {}: {e}", home.display()));
    }
    Some(watcher)
}
