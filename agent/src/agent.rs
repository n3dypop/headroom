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
use crate::push::{ClockEpoch, EpochRead, Pusher, clock_epoch, usable_epoch};
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

/// Writes snapshot.json with the clock epoch its values were taken in (this PC only): shown only while that epoch is usable
pub fn write_snapshot(
    home: &Path,
    latest: &BTreeMap<String, ProviderSnapshot>,
    now: i64,
    collector: &str,
    epoch: Option<u64>,
) -> std::io::Result<()> {
    let mut value = serde_json::to_value(build_snapshot(latest.clone(), now, collector))?;
    value["clock_epoch"] = serde_json::json!(epoch);
    write_json_atomic(&home.join("snapshot.json"), &value)
}

/// snapshot.json as it may be shown now: its values only if written in the clock epoch usable now (none otherwise). None without one
pub fn read_snapshot(home: &Path) -> Option<crate::schema::Snapshot> {
    read_snapshot_at(home, usable_epoch(home))
}

/// read_snapshot under a read of the clock already made (usable: the epoch usable then, None if none)
pub fn read_snapshot_at(home: &Path, usable: Option<u64>) -> Option<crate::schema::Snapshot> {
    let value: serde_json::Value = crate::store::read_json(&home.join("snapshot.json"))?;
    let epoch = value.get("clock_epoch").and_then(serde_json::Value::as_u64);
    let mut snapshot: crate::schema::Snapshot = serde_json::from_value(value).ok()?;
    if epoch.is_none() || epoch != usable {
        snapshot.providers.clear();
    }
    Some(snapshot)
}

/// Makes sure the clock state exists (and, without pushing, is trusted). Tried again on the next round if it can't be made now
fn settle_clock(home: &Path, pushing: bool) -> Option<ClockEpoch> {
    let state = clock_epoch(home);
    if pushing {
        if matches!(state, EpochRead::Read { .. }) {
            return None;
        }
        return crate::push::ensure_clock(home).ok();
    }
    match state {
        EpochRead::Read {
            trusted: true,
            in_flight: None,
            ..
        } => None,
        // A send an earlier run left pending (pushing was set up then) is this agent's to resolve
        _ => crate::push::trust_without_push_as_agent(home).ok(),
    }
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
    let mut round = Round::new(&cfg, &collector, log.clone(), now_ms, home);
    // Next check per provider last written for `headroom status` (written only when it changes)
    let mut planned: Option<BTreeMap<String, NextRun>> = None;
    // What snapshot.json last showed (written again when it changes)
    let mut last_shown: Option<BTreeMap<String, ProviderSnapshot>> = None;
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
            round
                .coord
                .release_turns(pusher.as_mut().map(|x| x as &mut dyn TurnAsker));
            drop(session_file.take()); // releases the session lock
            let _ = std::fs::remove_file(home.join(SCHEDULE_FILE));
            let _ = std::fs::remove_file(home.join(SESSION_FILE));
            return 0;
        }
        let write = round.run(&mut providers, pusher.as_mut());
        // snapshot.json (`headroom status`) shows what the push state lets out (nothing a refused clock stamped); written again
        // whenever that changes, also when only the marks did
        let now = now_ms();
        let shown = match pusher.as_ref() {
            Some(p) => p.shown(&round.latest, now),
            None => round.latest.clone(),
        };
        if write || last_shown.as_ref() != Some(&shown) {
            match write_snapshot(home, &shown, now, &collector, round.epoch) {
                Ok(()) => last_shown = Some(shown),
                Err(e) => log.log(&format!("Failed to write snapshot.json: {e}")),
            }
        }

        let now = now_ms();
        let plan: BTreeMap<String, NextRun> = providers
            .iter()
            .map(|p| {
                let id = p.id();
                let mut run = round.coord.next_run(id, p.fetch_due_ms(now), now);
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
        // While the clock isn't trusted, only the send that checks it is due (no provider fetches meanwhile)
        let refused = round.epoch.is_none();
        let next = providers
            .iter()
            .filter(|_| !refused)
            .map(|p| {
                // A provider that cannot do passive work while holding off is not woken until the hold ends
                let hold = round.coord.hold_until(p.id());
                let due = p.next_due_ms(now);
                if hold > now && !round.honors.get(p.id()).copied().unwrap_or(false) {
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

/// One pass of the loop: the fetches that are due and the send, with what they keep across passes
pub(crate) struct Round {
    /// Fetch turn-taking and interval stretching (schedule.rs)
    pub(crate) coord: Coordinator,
    /// Providers that can keep doing passive work while holding off
    pub(crate) honors: BTreeMap<&'static str, bool>,
    /// The latest value per provider (what the next send carries)
    pub(crate) latest: BTreeMap<String, ProviderSnapshot>,
    cfg: Config,
    collector: String,
    clock: fn() -> i64,
    home: std::path::PathBuf,
    /// The clock epoch usable at the last round (None: none usable). Its change drops the latest values of the one before
    pub(crate) epoch: Option<u64>,
    /// Providers whose tidying after an epoch change failed: tried again every round until it works
    untidied: std::collections::BTreeSet<&'static str>,
}

impl Round {
    pub(crate) fn new(
        cfg: &Config,
        collector: &str,
        log: Logger,
        clock: fn() -> i64,
        home: &Path,
    ) -> Self {
        Self {
            coord: Coordinator::new(cfg.schedule.clone(), log),
            honors: BTreeMap::new(),
            latest: BTreeMap::new(),
            cfg: cfg.clone(),
            collector: collector.to_string(),
            clock,
            home: home.to_path_buf(),
            epoch: None,
            untidied: std::collections::BTreeSet::new(),
        }
    }

    /// Fetches what is due and sends. Returns whether snapshot.json must be written even if what it shows is unchanged
    pub(crate) fn run(
        &mut self,
        providers: &mut [Box<dyn Provider>],
        mut pusher: Option<&mut Pusher>,
    ) -> bool {
        let pushing = !self.cfg.push.url.trim().is_empty();
        let mut changed = self.follow_epoch(providers, pushing);
        // While the clock isn't trusted (refused by the destination, a send's result pending, or a state that can't be read), nothing
        // is fetched: a value stamped then couldn't be used. The send below only checks the clock
        // Nor for an agent the destination refuses as outdated (426): its values couldn't be sent
        // Nor while the push state can't be read: whether the destination refused this agent can't be told
        let refused = self.epoch.is_none() || pusher.as_deref_mut().is_some_and(|p| !p.may_fetch());
        for p in providers.iter_mut().filter(|_| !refused) {
            let now = (self.clock)();
            let id = p.id();
            // When a fetch is due, check the turn and interval stretching. If holding off, tell the provider
            let mut fetching = false;
            let mut skip = false;
            // A hold set by a clock that has since gone back is dropped here and by the provider (it would keep the provider from
            // ever being due)
            if self.coord.notice_clock(id, now) {
                p.hold_fetch_until(self.coord.hold_until(id));
            }
            if p.fetch_due_ms(now) <= now {
                let asker = pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker);
                if self.coord.before_fetch(
                    id,
                    interval_min(&self.cfg, id),
                    self.latest.get(id),
                    asker,
                    now,
                ) {
                    fetching = true;
                    // A hold the coordinator dropped (the clock went back) is dropped by the provider too
                    p.hold_fetch_until(self.coord.hold_until(id));
                } else {
                    let passive = p.hold_fetch_until(self.coord.hold_until(id));
                    self.honors.insert(id, passive);
                    skip = !passive;
                }
            }
            if !skip && p.next_due_ms(now) <= now {
                // A round that only takes passive values (statusLine) doesn't fetch on its own, even if the fetch time passes while it
                // runs (the turn is checked on the next round first)
                let passive = !fetching && p.takes_passive_values();
                if passive {
                    p.hold_fetch_until(i64::MAX);
                }
                let attempted = p.last_fetch_attempt_ms();
                let snap = p.collect(now, false);
                if passive {
                    p.hold_fetch_until(self.coord.hold_until(id));
                }
                self.coord.observe(id, &snap, now);
                if fetching {
                    let asker = pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker);
                    let next = p.fetch_due_ms((self.clock)());
                    self.coord.after_fetch(
                        id,
                        &snap,
                        next,
                        interval_min(&self.cfg, id),
                        asker,
                        now,
                    );
                } else if p.last_fetch_attempt_ms() > attempted {
                    self.coord.record_fetch(id, now); // fetched without going through the coordinator
                }
                if self.latest.get(p.id()) != Some(&snap) {
                    self.latest.insert(p.id().to_string(), snap);
                    changed = true;
                }
            }
        }
        let mut write = changed;
        if let Some(p) = pusher {
            p.record(&self.latest, changed, (self.clock)());
            // Stamped after saving the queue, right before sending (the destination checks the send time against its clock)
            let now = (self.clock)();
            p.push(
                &build_snapshot(self.latest.clone(), now, &self.collector),
                now,
            );
            // Values from a PC whose clock the destination refuses can't be delivered: hand back any turn it holds
            if p.clock_skewed() {
                self.coord.release_turns(Some(p as &mut dyn TurnAsker));
            }
        }
        // The send may have moved the epoch (refused, or lifted): the latest values of the one before go
        write |= self.follow_epoch(providers, pushing);
        write
    }

    /// Follows the clock epoch usable now. On a change, the latest values of the epoch before are dropped (never shown or sent again;
    /// the providers use only values of the current one), and the providers tidy what they cached. true if the latest values changed
    fn follow_epoch(&mut self, providers: &mut [Box<dyn Provider>], pushing: bool) -> bool {
        settle_clock(&self.home, pushing);
        let usable = usable_epoch(&self.home);
        if usable == self.epoch {
            // Tidying that failed is tried again (a value left behind isn't used meanwhile: its epoch is gone)
            for provider in providers.iter_mut() {
                if self.untidied.contains(provider.id()) && provider.forget_cached() {
                    self.untidied.remove(provider.id());
                }
            }
            return false;
        }
        self.epoch = usable;
        for provider in providers.iter_mut() {
            // Only tidying: a value left behind isn't used (its epoch is gone). One that fails is tried again next round
            if provider.forget_cached() {
                self.untidied.remove(provider.id());
            } else {
                self.untidied.insert(provider.id());
            }
        }
        let had = !self.latest.is_empty();
        self.latest.clear();
        had
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
