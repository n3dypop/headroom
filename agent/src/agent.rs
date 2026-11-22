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
use crate::providers::{Event, Provider, Run};
use crate::push::{ClockEpoch, EpochRead, Pusher, clock_epoch, usable_epoch};
use crate::requests::{self, Account, Request, RequestOutcome};
use crate::schedule::{
    Coordinator, Mode, NextRun, SCHEDULE_FILE, SESSION_FILE, SESSION_LOCK_FILE, Schedule, TurnAsker,
};
use crate::schema::{ProviderSnapshot, build_snapshot};
use crate::statusline::CAPTURE_FILE;
use crate::store::{Logger, write_json_atomic};
use crate::time::{MINUTE_MS, now_ms};

/// Wake at least this often even with nothing scheduled (guards against clock changes and resume from sleep)
const MAX_SLEEP_MS: i64 = 5 * MINUTE_MS;
const MIN_SLEEP_MS: i64 = 1_000;

pub fn make_providers(home: &Path, cfg: &Config, log: &Logger) -> Vec<Box<dyn Provider>> {
    // Each provider keeps only the floor between its fetches: the common schedule plans the interval with its jitter (schedule.rs)
    let floor = crate::config::MIN_INTERVAL_MIN;
    let mut list: Vec<Box<dyn Provider>> = vec![
        Box::new(ClaudeProvider::new(
            home,
            crate::config::ClaudeConfig {
                interval_min: floor,
                ..cfg.claude.clone()
            },
            log.clone(),
        )),
        Box::new(CodexProvider::new(
            home,
            crate::config::CodexConfig {
                interval_min: floor,
                ..cfg.codex.clone()
            },
            log.clone(),
        )),
    ];
    // Gemini only when turned on: an earlier destination refuses an upload with its values (the other providers' values with it)
    if cfg.gemini.enabled {
        list.push(Box::new(crate::providers::gemini::GeminiProvider::new(
            home,
            crate::config::GeminiConfig {
                interval_min: floor,
                ..cfg.gemini.clone()
            },
            log.clone(),
        )));
    }
    list
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
    let cfg = match config::load(home) {
        Ok(c) => c,
        Err(e) => {
            log.log(&e);
            return 2;
        }
    };
    // Published once the agent can run (its config read; tried again with the schedule if it fails): `start` reports the agent up
    // only then, a manual collect hands requests to this session only, and a stop names it
    let mut session_file: Option<std::fs::File> = publish_session(home, &session).ok();
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
    // A stop request left over from before startup (for another session) does not stop us
    crate::install::drop_other_stops(home, &session);
    requests::tidy(home, now_ms(), &log);
    let mut tidied_at = Instant::now();
    // A request's result that couldn't be written yet (written first, before another request is taken)
    let mut unsaved: Option<RequestOutcome> = None;

    loop {
        // Stop requests are only honored between fetches (never in the middle of /usage)
        if take_stop_request(home, &session) {
            log.log("Stop requested; exiting");
            // No request is taken any more: those waiting end as not done
            requests::close(home, &session, now_ms(), &log);
            if let Some(out) = unsaved.take()
                && requests::finish(home, &out).is_err()
            {
                log.log("Couldn't write a manual collect's result");
            }
            // Hand the fetch turns back so another PC takes over at its next check instead of waiting out the lease
            round
                .coord
                .release_turns(pusher.as_mut().map(|x| x as &mut dyn TurnAsker));
            drop(session_file.take()); // releases the session lock
            let _ = std::fs::remove_file(home.join(SCHEDULE_FILE));
            let _ = std::fs::remove_file(home.join(SESSION_FILE));
            return 0;
        }
        // A result not written yet goes first; then one manual collect asked of this agent is done in this round (the next waits
        // for the next round)
        if let Some(out) = unsaved.take()
            && requests::finish(home, &out).is_err()
        {
            unsaved = Some(out);
        }
        let (taken, more) = if unsaved.is_none() {
            match take_request(home, &session, &log) {
                Some(taken) => taken,
                // A stop came meanwhile: it goes first
                None => continue,
            }
        } else {
            (None, false)
        };
        let (write, outcome) = match &taken {
            Some(req) => {
                let (write, outcome) = round.run_request(&mut providers, pusher.as_mut(), req);
                (write, Some(outcome))
            }
            None => (round.run(&mut providers, pusher.as_mut()), None),
        };
        // snapshot.json (`headroom status`) shows what the push state lets out (nothing a refused clock stamped); written again
        // whenever that changes, also when only the marks did
        let now = now_ms();
        let shown = round.overlaid(match pusher.as_ref() {
            Some(p) => p.shown(&round.latest, now),
            None => round.latest.clone(),
        });
        let mut shown_saved = true;
        if write || last_shown.as_ref() != Some(&shown) {
            match write_snapshot(home, &shown, now, &collector, round.epoch) {
                Ok(()) => last_shown = Some(shown),
                Err(e) => {
                    shown_saved = false;
                    log.log(&format!("Failed to write snapshot.json: {e}"));
                }
            }
        }
        // The request's result after snapshot.json (a collect shows what the agent wrote). One that can't be written is tried again.
        // A round whose values couldn't be written didn't show what it did: the request fails
        if let Some(out) = outcome {
            unsaved = settle_request(home, out, shown_saved, &log);
        }
        if unsaved.is_none() && taken.is_none() && tidied_at.elapsed() >= Duration::from_secs(3600)
        {
            requests::tidy(home, now_ms(), &log);
            tidied_at = Instant::now();
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
                intervals: providers
                    .iter()
                    .filter(|p| provider_enabled(&cfg, p.id()))
                    .map(|p| (p.id().to_string(), cfg.interval_min(p.id())))
                    .collect(),
                idle_min: (
                    cfg.schedule.idle_interval_min,
                    cfg.schedule.idle_long_interval_min,
                ),
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
        // While the clock isn't trusted, or the push state can't be read, only the send that checks it is due (no provider fetches
        // meanwhile)
        let refused = round.epoch.is_none() || pusher.as_mut().is_some_and(|p| !p.may_fetch());
        let next = providers
            .iter()
            .filter(|p| !refused && provider_enabled(&cfg, p.id()))
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
            // A result's resend and a stop's recheck are due whatever the providers' schedules
            .chain((!refused).then(|| {
                let running: Vec<&str> = providers
                    .iter()
                    .map(|p| p.id())
                    .filter(|id| provider_enabled(&cfg, id))
                    .collect();
                round.coord.next_upkeep(&running, now)
            }))
            .min()
            .unwrap_or(i64::MAX);
        // More requests waiting (or a result to write): the next round comes at once
        let next = if more || unsaved.is_some() { now } else { next };
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

/// The next manual collect asked of this session, and whether more wait. None: a stop came after it was taken (it is given back as not
/// done; the stop goes first)
fn take_request(home: &Path, session: &str, log: &Logger) -> Option<(Option<Request>, bool)> {
    let (taken, more) = requests::take(home, session, now_ms(), log);
    if let Some(req) = &taken
        && crate::install::stop_requested(home, session)
    {
        requests::give_back(home, req, now_ms(), log);
        return None;
    }
    Some((taken, more))
}

/// Writes a request's result after its round. A round whose values couldn't be written to snapshot.json didn't show what it did: the
/// request fails. Returns the result if it couldn't be written (tried again before another request is taken)
fn settle_request(
    home: &Path,
    mut out: RequestOutcome,
    shown_saved: bool,
    log: &Logger,
) -> Option<RequestOutcome> {
    if !shown_saved {
        out.ok = false;
        out.notes.push(
            "snapshot.json couldn't be written, so the values shown may be older than this collect"
                .into(),
        );
    }
    if requests::finish(home, &out).is_err() {
        log.log("Couldn't write a manual collect's result; trying again");
        return Some(out);
    }
    None
}

/// What a provider whose state can't be read now shows
const STATE_UNREAD_TEXT: &str = "Its fetch state can't be read now; Headroom reads it again by itself (if this stays, check the Headroom folder's permissions)";

/// Whether the provider is enabled in the config this agent started with
pub(crate) fn provider_enabled(cfg: &Config, id: &str) -> bool {
    match id {
        "claude" => cfg.claude.enabled,
        "codex" => cfg.codex.enabled,
        "gemini" => cfg.gemini.enabled,
        _ => true,
    }
}

/// The provider's normal fetch interval (minutes): the common schedule's plan and the turn's lease
fn interval_min(cfg: &Config, id: &str) -> i64 {
    cfg.interval_min(id)
}

/// Hands the acceptance a request asks for to the provider (made by its next collect)
fn req_accept(req: &Request, p: &mut dyn Provider) {
    match req.account {
        Account::Accept => p.accept_account(),
        Account::Same => p.confirm_same_account(),
        Account::Keep => {}
    }
}

/// Takes the provider's values out of snapshot.json before an acceptance (they are the account's before): never shown again, also if
/// the next write fails. false if it couldn't be done (the acceptance isn't made)
fn hide_provider(home: &Path, id: &str) -> bool {
    let path = home.join("snapshot.json");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
        Err(_) => return false,
    };
    // One that can't be read as a snapshot shows nothing
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return true;
    };
    let Some(providers) = value.get_mut("providers").and_then(|p| p.as_object_mut()) else {
        return true;
    };
    if providers.remove(id).is_none() {
        return true;
    }
    write_json_atomic(&path, &value).is_ok()
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
        let sharing = !cfg.push.url.trim().is_empty();
        // A PC that doesn't share keeps its stops in the plan alone: started with that file gone, an access denial its last values
        // show stays a stop until resumed (one that shares reads the destination's)
        let plan_lost = !sharing && !home.join(crate::schedule::PLAN_FILE).exists();
        // The fetch times are spread with this PC's own random seed (made here once; the PC's name only when none can be kept)
        let seed = crate::store::schedule_seed(home, collector, true);
        let mut coord = Coordinator::with_plan(cfg.schedule.clone(), log, home, &seed, sharing);
        if plan_lost
            && let Some(shown) =
                crate::store::read_json::<crate::schema::Snapshot>(&home.join("snapshot.json"))
        {
            for (id, p) in &shown.providers {
                if p.error_code == Some(crate::schema::ErrorCode::AccessDenied) {
                    coord.keep_denied(id, clock());
                }
            }
        }
        Self {
            // Sharing comes from the config (push set up): such a PC fetches only on the destination's go
            coord,
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

    /// The values as shown (snapshot.json, headroom status): a provider stopped by an access denial shows the stop. What is sent and
    /// queued follows each provider's own state (an account switch still drops its queue; the destination shows the shared stop)
    pub(crate) fn overlaid(
        &self,
        values: BTreeMap<String, ProviderSnapshot>,
    ) -> BTreeMap<String, ProviderSnapshot> {
        values
            .into_iter()
            .map(|(id, s)| {
                let s = self.coord.overlay(&id, s);
                (id, s)
            })
            .collect()
    }

    /// Fetches what is due and sends. Returns whether snapshot.json must be written even if what it shows is unchanged
    pub(crate) fn run(
        &mut self,
        providers: &mut [Box<dyn Provider>],
        pusher: Option<&mut Pusher>,
    ) -> bool {
        self.run_with(providers, pusher, None).0
    }

    /// One round that also does what a manual collect asks: the providers it names are asked for in its way (its `--force`,
    /// `--resume-access`, acceptance), the others go on as usual
    pub(crate) fn run_request(
        &mut self,
        providers: &mut [Box<dyn Provider>],
        pusher: Option<&mut Pusher>,
        request: &Request,
    ) -> (bool, RequestOutcome) {
        let (write, outcome) = self.run_with(providers, pusher, Some(request));
        (write, outcome.unwrap_or_default())
    }

    fn run_with(
        &mut self,
        providers: &mut [Box<dyn Provider>],
        mut pusher: Option<&mut Pusher>,
        request: Option<&Request>,
    ) -> (bool, Option<RequestOutcome>) {
        let mut outcome = request.map(|r| RequestOutcome {
            id: r.id.clone(),
            provider: r.provider.clone(),
            ok: true,
            ..RequestOutcome::default()
        });
        let pushing = !self.cfg.push.url.trim().is_empty();
        let mut changed = self.follow_epoch(providers, pushing);
        // While the clock isn't trusted (refused by the destination, a send's result pending, or a state that can't be read), nothing
        // is fetched: a value stamped then couldn't be used. The send below only checks the clock
        // Nor for an agent the destination refuses as outdated (426): its values couldn't be sent
        // Nor while the push state can't be read: whether the destination refused this agent can't be told
        let refused = self.epoch.is_none() || pusher.as_deref_mut().is_some_and(|p| !p.may_fetch());
        if let Some((out, req)) = outcome.as_mut().zip(request) {
            out.refused = refused;
            // Something asked for that can't be done now (a fetch forced or resumed, an acceptance)
            if refused && (req.force || req.resume.is_some() || req.account != Account::Keep) {
                out.ok = false;
            }
            // A provider named that this agent doesn't run, or runs turned off (as config.toml said when it started)
            if let Some(name) = &req.provider
                && !providers
                    .iter()
                    .any(|p| p.id() == name && provider_enabled(&self.cfg, name))
            {
                out.ok = false;
                out.notes.push(format!(
                    "{name} isn't running in the background agent (turned off when it started). Restart it (headroom stop, then headroom start), then collect again"
                ));
            }
        }
        let mut targeted = false;
        for p in providers.iter_mut().filter(|_| !refused) {
            let now = (self.clock)();
            let id = p.id();
            // A provider turned off (built all the same) does nothing in a round: no fetch, no turn asked, no stop rechecked. Its
            // results and attempts only asked for are the upkeep of the providers not running, below
            if !provider_enabled(&self.cfg, id) {
                continue;
            }
            // When a fetch is due, check the turn and interval stretching. If holding off, tell the provider
            let mut fetching = false;
            let mut skip = false;
            // A hold set by a clock that has since gone back is dropped here and by the provider (it would keep the provider from
            // ever being due)
            if self.coord.notice_clock(id, now) {
                p.hold_fetch_until(self.coord.hold_until(id));
            }
            // Whatever the provider's fetch schedule: a result not acknowledged yet is sent again, and while stopped the destination is
            // asked again (nothing goes upstream)
            self.coord.maintain(
                id,
                interval_min(&self.cfg, id),
                pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker),
                now,
            );
            // A provider the manual collect names: done its way (one turned off never is: skipped above)
            if let Some(req) = request
                && req.names(id)
            {
                let out = outcome.as_mut().expect("an outcome with a request");
                targeted = true;
                changed |= self.requested(p.as_mut(), pusher.as_deref_mut(), req, now, out);
                continue;
            }
            // The passive record is taken first when a fetch is due, starting no CLI, so the fetch decided next sees a statusLine value
            // that just came (also one whose file event hasn't arrived yet). A new one taken in puts the round's CLI off (no fetch,
            // no version check) unless the fetch is allowed
            let mut took_passive = false;
            let fresh = p.passive_pending();
            let seen = p.passive_mark();
            if p.fetch_due_ms(now) <= now
                && p.takes_passive_values()
                && let Some(snap) = p.take_passive(now)
            {
                took_passive = fresh || p.passive_mark() != seen;
                if self
                    .coord
                    .observe(id, &snap, interval_min(&self.cfg, id), now)
                {
                    p.hold_fetch_until(self.coord.hold_until(id));
                }
                if self.latest.get(id) != Some(&snap) {
                    self.latest.insert(id.to_string(), snap);
                    changed = true;
                }
            }
            if p.fetch_due_ms(now) <= now {
                let asker = pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker);
                if self.coord.before_fetch(
                    id,
                    interval_min(&self.cfg, id),
                    self.latest.get(id),
                    p.last_passive().as_ref(),
                    p.last_fetch_attempt_ms(),
                    Mode::Auto,
                    asker,
                    now,
                ) {
                    fetching = true;
                    // A hold the coordinator dropped (the clock went back) is dropped by the provider too
                    p.hold_fetch_until(self.coord.hold_until(id));
                } else {
                    let passive = p.hold_fetch_until(self.coord.hold_until(id));
                    self.honors.insert(id, passive);
                    // The passive record was just taken: this round starts no CLI (a version check waits for the next one)
                    skip = !passive || took_passive;
                }
            } else if took_passive {
                // Taken in and no fetch due any more (a switch it showed holds the provider): no CLI this round either
                skip = true;
            }
            // A record waiting with no fetch allowed: taken in starting no CLI (a version check waits for a round with nothing new)
            if !fetching
                && !skip
                && !took_passive
                && p.takes_passive_values()
                && p.passive_pending()
            {
                if let Some(snap) = p.take_passive(now) {
                    if self
                        .coord
                        .observe(id, &snap, interval_min(&self.cfg, id), now)
                    {
                        p.hold_fetch_until(self.coord.hold_until(id));
                    }
                    if self.latest.get(id) != Some(&snap) {
                        self.latest.insert(id.to_string(), snap);
                        changed = true;
                    }
                }
                skip = true;
            }
            // A go is always followed by the collect it was for (an attempt left started would read as one whose result is unknown)
            if fetching || (!skip && p.next_due_ms(now) <= now) {
                // A round that only takes passive values (statusLine) doesn't fetch on its own, even if the fetch time passes while it
                // runs (the turn is checked on the next round first)
                let passive = !fetching && p.takes_passive_values();
                if passive {
                    p.hold_fetch_until(i64::MAX);
                }
                // The go is used only soon after it was asked for: a provider held up longer (its lock, a sleep) skips its query
                p.grant(fetching.then(|| self.coord.grant(id)).flatten());
                let attempted = p.last_fetch_attempt_ms();
                let snap = p.collect(now, false);
                let run = p.take_run();
                p.grant(None);
                if passive {
                    p.hold_fetch_until(self.coord.hold_until(id));
                }
                if self
                    .coord
                    .observe(id, &snap, interval_min(&self.cfg, id), now)
                {
                    p.hold_fetch_until(self.coord.hold_until(id));
                }
                // What went upstream: nothing (the plan stays), a result (reported), or one that can't be checked (held until forced).
                // A provider that doesn't say what it did counts as having fetched
                if fetching {
                    let asker = pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker);
                    let next = p.fetch_due_ms((self.clock)());
                    self.coord.after_fetch(
                        id,
                        run,
                        &snap,
                        next,
                        interval_min(&self.cfg, id),
                        asker,
                        now,
                    );
                    p.hold_fetch_until(self.coord.hold_until(id));
                } else if matches!(run, Some(Run::Ran(_) | Run::Unknown))
                    || (run.is_none() && p.last_fetch_attempt_ms() > attempted)
                {
                    // fetched without going through the coordinator: the next one is planned from it
                    self.coord
                        .record_fetch(id, interval_min(&self.cfg, id), Some(&snap), now);
                }
                if self.latest.get(p.id()) != Some(&snap) {
                    self.latest.insert(p.id().to_string(), snap);
                    changed = true;
                }
            }
        }
        // Nothing done for a request whose providers are all turned off
        if let Some(out) = outcome.as_mut()
            && !refused
            && !targeted
            && request.is_some_and(|r| r.provider.is_none())
        {
            out.ok = false;
            out.notes.push(
                "no provider is turned on in the background agent; nothing was fetched".into(),
            );
        }
        // Providers this agent doesn't run (turned off): their results not acknowledged are sent, and attempts only asked for end
        if !refused {
            let running: Vec<&str> = providers
                .iter()
                .map(|p| p.id())
                .filter(|id| provider_enabled(&self.cfg, id))
                .collect();
            self.coord.maintain_others(
                &running,
                pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker),
                (self.clock)(),
            );
        }
        // Right before sending: what the providers saved meanwhile (a manual collect may have accepted a switch or a change of limits)
        if !refused {
            let now = (self.clock)();
            for p in providers.iter_mut() {
                if let Some(snap) = p.sync_saved(now)
                    && self.latest.get(p.id()) != Some(&snap)
                {
                    self.latest.insert(p.id().to_string(), snap);
                    changed = true;
                }
            }
        }
        // A provider whose state can't be read now shows only that, as a fetch that failed: never as a stop or an account switch (its
        // read error says nothing of the account), here, in snapshot.json and to the destination. Only an enabled one: one
        // turned off shows nothing (a tidy on start may find its old state unreadable, and no round would replace what it showed)
        if !refused {
            let now = (self.clock)();
            for p in providers.iter() {
                if provider_enabled(&self.cfg, p.id())
                    && p.state_retry_at().is_some_and(|at| at > now)
                {
                    let shown = ProviderSnapshot::empty(
                        crate::schema::ProviderStatus::Error,
                        STATE_UNREAD_TEXT,
                        Some(crate::schema::ErrorCode::FetchFailed),
                    );
                    if self.latest.get(p.id()) != Some(&shown) {
                        self.latest.insert(p.id().to_string(), shown);
                        changed = true;
                    }
                }
            }
        }
        if let Some(out) = outcome.as_mut() {
            out.done_ms = (self.clock)();
        }
        let mut write = changed;
        if let Some(p) = pusher {
            // Queued observations of a provider turned off (an earlier destination refuses the whole request for them), or waiting for
            // the user's choice, stay queued
            // A provider whose state can't be read now: what it shows says nothing of its account (a read error shown as a stop),
            // so its queued observations stay as they are, neither sent nor dropped, and nothing of it is recorded
            let now = (self.clock)();
            let unread: std::collections::BTreeSet<String> = providers
                .iter()
                .filter(|x| x.state_retry_at().is_some_and(|at| at > now))
                .map(|x| x.id().to_string())
                .collect();
            p.hold_queued(
                providers
                    .iter()
                    .filter(|x| x.holds_queue())
                    .map(|x| x.id().to_string())
                    .chain(
                        crate::providers::PROVIDER_IDS
                            .iter()
                            .filter(|id| !provider_enabled(&self.cfg, id))
                            .map(|id| id.to_string()),
                    )
                    .chain(unread.iter().cloned())
                    .collect(),
            );
            let recorded: BTreeMap<String, ProviderSnapshot> = self
                .latest
                .iter()
                .filter(|(id, _)| !unread.contains(*id))
                .map(|(id, s)| (id.clone(), s.clone()))
                .collect();
            p.record(&recorded, changed, now);
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
        (write, outcome)
    }

    /// Whether an acceptance may be made now: the clock trusted in the epoch this round works in, and the push state read and not
    /// refused (a 426 or a refusal seen earlier in this round included)
    fn may_accept(&self, pusher: Option<&mut Pusher>) -> bool {
        let pushing = !self.cfg.push.url.trim().is_empty();
        self.epoch.is_some()
            && usable_epoch(&self.home) == self.epoch
            && match pusher {
                Some(p) => p.may_fetch(),
                // Push set up but no sender (its config couldn't be used): whether the destination refuses this PC can't be told
                None => !pushing,
            }
    }

    /// A provider a manual collect names, done its way. Nothing goes upstream without the destination's go (with push set up), and
    /// past a safety stop only on the user's explicit `--force`. An acceptance is made for the switch the user saw: by a provider
    /// that takes passive values with its first call (no fetch needed), by one that doesn't (Codex) only with the fetch allowed for it.
    /// What was asked for and not done makes the request fail. true if the latest values changed
    fn requested(
        &mut self,
        p: &mut dyn Provider,
        mut pusher: Option<&mut Pusher>,
        req: &Request,
        now: i64,
        out: &mut RequestOutcome,
    ) -> bool {
        let id = p.id();
        let interval = interval_min(&self.cfg, id);
        let what = if req.account == Account::Same {
            "the change of limits as the same account's"
        } else {
            "the account switch"
        };
        if req.account == Account::Same && !p.tracks_limits() {
            out.ok = false;
            out.notes.push(format!(
                "{id}: --same-account isn't used (it doesn't pause on a change of limits); nothing was fetched"
            ));
            return false;
        }
        // Its state can't be read now: nothing is taken or asked for (it reads it again on its own time)
        if p.state_retry_at().is_some_and(|at| at > now) {
            out.ok = false;
            out.notes.push(format!(
                "{id}: its state file can't be read now, so nothing was done (the agent reads it again on its own)"
            ));
            return false;
        }
        let mut changed = false;
        let local = p.takes_passive_values();
        // An acceptance rests on the clock and the push state as they are now, and the values shown before (the account before) go
        // first: never shown again, also if the next write fails
        let mut accept = req.account != Account::Keep;
        if accept && req.accept_target.is_none() {
            out.ok = false;
            out.notes.push(format!(
                "{id}: nothing waited to be accepted when you asked (see headroom status); nothing was accepted"
            ));
            return false;
        }
        if accept && !self.may_accept(pusher.as_deref_mut()) {
            accept = false;
            out.ok = false;
            out.notes.push(format!(
                "{id}: {what} was not accepted: this PC's clock or its push state doesn't allow it now (see headroom status)"
            ));
        }
        if accept && !hide_provider(&self.home, id) {
            accept = false;
            out.ok = false;
            out.notes.push(format!(
                "{id}: {what} was not accepted: snapshot.json couldn't be updated"
            ));
        }
        let mut accepted: Option<bool> = None;
        if accept {
            changed = true;
            self.latest.remove(id);
        }
        // A provider that takes passive values: its record first (starting no CLI), with the acceptance when asked (the input read
        // then is checked against what the user saw)
        if local {
            if accept {
                p.accept_target(req.accept_target);
                req_accept(req, p);
            }
            let taken = p.take_passive(now);
            // Its state found unreadable just now: nothing more is done, no turn asked for
            if p.state_retry_at().is_some_and(|at| at > now) {
                out.ok = false;
                out.notes.push(format!(
                    "{id}: its state file can't be read now, so nothing was done (the agent reads it again on its own)"
                ));
                return changed;
            }
            if let Some(snap) = taken {
                // A wait it shortened (a limit reached) is the provider's too
                if self.coord.observe(id, &snap, interval, now) {
                    p.hold_fetch_until(self.coord.hold_until(id));
                }
                if self.latest.get(id) != Some(&snap) {
                    self.latest.insert(id.to_string(), snap);
                    changed = true;
                }
            }
            if accept {
                accepted = p.account_accepted();
            }
        }
        let mode = match req.mode() {
            // Accepted with no fetch (or not accepted): the fetch follows the schedule
            Mode::Accept if local => Mode::Auto,
            m => m,
        };
        // Past a safety stop only on the user's explicit --force (the provider checks it again on its latest state)
        let confirmed = req.force;
        let blocked = p.safety_stopped() && !confirmed && !matches!(mode, Mode::Auto);
        if blocked {
            out.notes.push(format!(
                "{id}: a safety stop shows, so nothing was fetched. Check headroom status, then add --force (with --resume-access, in the same command)"
            ));
        }
        let query_accept = accept && !local;
        let due = match mode {
            Mode::Auto => p.fetch_due_ms(now) <= now,
            _ => true,
        };
        let go = due
            && !blocked
            && self.coord.before_fetch(
                id,
                interval,
                self.latest.get(id),
                p.last_passive().as_ref(),
                p.last_fetch_attempt_ms(),
                mode,
                pusher.as_deref_mut().map(|x| x as &mut dyn TurnAsker),
                now,
            );
        let mut fetched = false;
        if go {
            if query_accept {
                p.accept_target(req.accept_target);
                req_accept(req, p);
            }
            p.confirm_safety(confirmed);
            p.hold_fetch_until(self.coord.hold_until(id));
            p.grant(self.coord.grant(id));
            let snap = p.collect(now, !matches!(mode, Mode::Auto | Mode::Accept));
            let run = p.take_run();
            p.grant(None);
            p.confirm_safety(false);
            fetched = matches!(run, Some(Run::Ran(_)));
            let next = p.fetch_due_ms((self.clock)());
            self.coord.after_fetch(
                id,
                run,
                &snap,
                next,
                interval,
                pusher.map(|x| x as &mut dyn TurnAsker),
                now,
            );
            p.hold_fetch_until(self.coord.hold_until(id));
            if query_accept {
                accepted = p.account_accepted();
            }
            if self.coord.observe(id, &snap, interval, now) {
                p.hold_fetch_until(self.coord.hold_until(id));
            }
            if self.latest.get(id) != Some(&snap) {
                self.latest.insert(id.to_string(), snap);
                changed = true;
            }
        } else if !blocked {
            let next = self.coord.next_run(id, p.fetch_due_ms(now).max(now), now);
            out.notes.push(format!(
                "{id}: not fetched now; next check {}",
                next.describe_for(id)
            ));
        }
        // What was asked for, and whether it was done
        if accept {
            match accepted {
                Some(true) => out.notes.push(format!("{id}: accepted {what}")),
                _ if query_accept && !go => {
                    out.ok = false;
                    out.notes.push(format!(
                        "{id}: {what} can be accepted only with a fetch, which isn't allowed now; nothing was accepted"
                    ));
                }
                _ => {
                    out.ok = false;
                    out.notes.push(format!("{id}: {what} was not accepted"));
                }
            }
        }
        match mode {
            Mode::Force { .. } if !fetched => {
                out.ok = false;
                if go {
                    out.notes.push(format!(
                        "{id}: --force: nothing went upstream (see headroom status)"
                    ));
                }
            }
            // Resumed only by a fetch that went upstream and the stop ended on the destination's word (or this PC's, with no push)
            Mode::Resume { .. } if !fetched || self.coord.denied(id).is_some() => {
                out.ok = false;
                out.notes.push(format!(
                    "{id}: nothing was resumed: the access denial still stands, or that stop isn't the one standing (see headroom status)"
                ));
            }
            Mode::Resume { .. } => out.notes.push(format!("{id}: fetching goes on again")),
            _ => {}
        }
        changed
    }

    /// Follows the clock epoch usable now. On a change, the latest values of the epoch before are dropped (never shown or sent again;
    /// the providers use only values of the current one), and the providers tidy what they cached. true if the latest values changed
    fn follow_epoch(&mut self, providers: &mut [Box<dyn Provider>], pushing: bool) -> bool {
        settle_clock(&self.home, pushing);
        let usable = usable_epoch(&self.home);
        // What was planned or held under another epoch goes (the values it followed are gone); in the same one, after a restart, it
        // stands. The providers are told of a hold dropped
        if self.coord.follow_epoch(usable) {
            for provider in providers.iter_mut() {
                provider.hold_fetch_until(self.coord.hold_until(provider.id()));
            }
        }
        // A provider whose state can't be read now is tidied once it reads it again, not on each wake
        let now = (self.clock)();
        let waits = |p: &dyn Provider| p.state_retry_at().is_some_and(|at| at > now);
        if usable == self.epoch {
            // Tidying that failed is tried again (a value left behind isn't used meanwhile: its epoch is gone)
            for provider in providers.iter_mut() {
                if self.untidied.contains(provider.id())
                    && !waits(provider.as_ref())
                    && provider.forget_cached()
                {
                    self.untidied.remove(provider.id());
                }
            }
            return false;
        }
        self.epoch = usable;
        for provider in providers.iter_mut() {
            // Only tidying: a value left behind isn't used (its epoch is gone). One that fails is tried again next round
            if !waits(provider.as_ref()) && provider.forget_cached() {
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
        if ev.paths.iter().any(|p| {
            p.file_name()
                .is_some_and(|n| n == crate::providers::gemini::CAPTURE_FILE)
        }) {
            let _ = tx.send(Event::GeminiStatuslineCaptured);
        }
        if ev
            .paths
            .iter()
            .any(|p| p.file_name().is_some_and(|n| n == STOP_FILE))
        {
            let _ = tx.send(Event::StopRequested);
        }
        if ev.paths.iter().any(|p| {
            p.file_name()
                .is_some_and(|n| requests::is_pending_name(&n.to_string_lossy()))
        }) {
            let _ = tx.send(Event::CollectRequested);
        }
    })
    .map_err(|e| log.log(&format!("Cannot start the file watcher: {e}")))
    .ok()?;

    if let Err(e) = watcher.watch(home, RecursiveMode::NonRecursive) {
        log.log(&format!("Cannot watch {}: {e}", home.display()));
    }
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{Outcome, Passive};
    use crate::schedule::Waiting;
    use crate::schema::{ProviderStatus, make_window};
    use std::cell::RefCell;
    use std::rc::Rc;

    const T0: i64 = 1_800_000_000_000;

    thread_local! {
        static NOW: std::cell::Cell<i64> = const { std::cell::Cell::new(0) };
    }
    fn clock() -> i64 {
        NOW.with(|n| n.get())
    }

    /// A provider's upstream and statusLine, as the tests set them
    #[derive(Default)]
    struct Up {
        /// When a query went upstream
        fetches: Vec<i64>,
        /// When the statusLine values in the record were received
        passive: Option<i64>,
        /// The record as the provider last took it (a provider knows only what it took)
        seen: Option<i64>,
        /// A statusLine record written since the last collect
        dirty: bool,
        /// The next allowed fetch comes back from a cache (nothing goes upstream)
        cached: bool,
        hold: i64,
        last_attempt: i64,
        run: Option<Run>,
        /// The service denies access (a query that goes upstream gets a 403)
        deny: bool,
        /// The provider shows a safety stop
        safety: bool,
        /// Collects (any: a fetch, a version check)
        collects: u32,
        /// The next record taken in shows a switch: the fetch is held for good
        switch_on_passive: bool,
        /// A version check is due (the provider wants a collect though no fetch is)
        version_due: bool,
    }

    struct Fake(Rc<RefCell<Up>>, std::cell::Cell<bool>);

    /// The provider's value as it shows it now
    fn shown(u: &Up) -> ProviderSnapshot {
        let mut s = snap();
        if u.safety {
            s.error_code = Some(crate::schema::ErrorCode::SafetyStop);
        }
        s
    }

    fn snap() -> ProviderSnapshot {
        let mut p = ProviderSnapshot::empty(ProviderStatus::Ok, "", None);
        p.error = None;
        p.error_code = None;
        p.windows = vec![
            make_window("five_hour", 10.0, Some(T0 + 300 * MINUTE_MS)),
            make_window("seven_day", 20.0, Some(T0 + 3_000 * MINUTE_MS)),
        ];
        p
    }

    impl Provider for Fake {
        fn id(&self) -> &'static str {
            "claude"
        }
        fn next_due_ms(&self, now: i64) -> i64 {
            if self.0.borrow().dirty || self.0.borrow().version_due {
                now
            } else {
                self.fetch_due_ms(now)
            }
        }
        fn fetch_due_ms(&self, _now: i64) -> i64 {
            let u = self.0.borrow();
            (u.last_attempt + 10 * MINUTE_MS).max(u.hold)
        }
        fn hold_fetch_until(&mut self, until_ms: i64) -> bool {
            self.0.borrow_mut().hold = until_ms;
            true
        }
        fn takes_passive_values(&self) -> bool {
            true
        }
        fn passive_pending(&self) -> bool {
            self.0.borrow().dirty
        }
        fn last_passive(&self) -> Option<Passive> {
            self.0.borrow().seen.map(|at| Passive {
                at_ms: at,
                windows: vec!["five_hour".into(), "seven_day".into()],
            })
        }
        fn last_fetch_attempt_ms(&self) -> Option<i64> {
            Some(self.0.borrow().last_attempt).filter(|&t| t > 0)
        }
        fn take_passive(&mut self, _now: i64) -> Option<ProviderSnapshot> {
            let mut u = self.0.borrow_mut();
            u.dirty = false;
            u.seen = u.passive;
            if std::mem::take(&mut u.switch_on_passive) {
                u.hold = i64::MAX;
            }
            Some(shown(&u))
        }
        fn take_run(&mut self) -> Option<Run> {
            self.0.borrow_mut().run.take()
        }
        fn safety_stopped(&self) -> bool {
            self.0.borrow().safety
        }
        fn confirm_safety(&mut self, yes: bool) {
            self.1.set(yes);
        }
        fn collect(&mut self, now: i64, _force: bool) -> ProviderSnapshot {
            let confirmed = self.1.replace(false);
            let mut u = self.0.borrow_mut();
            u.collects += 1;
            u.version_due = false;
            u.dirty = false;
            u.seen = u.passive;
            u.run = Some(Run::NotRun);
            // Due, not stopped by its safety guard (or past it on the user's word), and not answered from a cache: a query goes upstream
            if now >= (u.last_attempt + 10 * MINUTE_MS).max(u.hold)
                && (!u.safety || confirmed)
                && !std::mem::take(&mut u.cached)
            {
                u.fetches.push(now);
                u.last_attempt = now;
                u.run = Some(Run::Ran(if u.deny {
                    Outcome::AccessDenied
                } else {
                    Outcome::Ok
                }));
            }
            shown(&u)
        }
    }

    fn setup(
        name: &str,
    ) -> (
        crate::test_util::TempHome,
        Rc<RefCell<Up>>,
        Vec<Box<dyn Provider>>,
    ) {
        let h = crate::test_util::TempHome::new(&format!("headroom-round-{name}"));
        let up = Rc::new(RefCell::new(Up::default()));
        let list: Vec<Box<dyn Provider>> =
            vec![Box::new(Fake(up.clone(), std::cell::Cell::new(false)))];
        (h, up, list)
    }

    fn round(h: &Path) -> Round {
        Round::new(&Config::default(), "mac", Logger::stderr(), clock, h)
    }

    fn run(r: &mut Round, list: &mut [Box<dyn Provider>], at: i64) {
        NOW.with(|n| n.set(at));
        r.run(list, None);
    }

    fn planned(r: &Round, now: i64) -> NextRun {
        r.coord.next_run("claude", now, now)
    }

    /// A new clock epoch (the clock refused, then lifted)
    fn new_epoch(h: &Path) {
        let _lock = crate::clock::hold_clock_lock(h).unwrap();
        let state = crate::clock::ensure_locked(h, || Ok(false)).unwrap();
        let state = crate::clock::advance_locked(h, &state, false).unwrap();
        crate::clock::advance_locked(h, &state, true).unwrap();
    }

    #[test]
    fn the_plan_stands_after_a_restart_in_the_same_epoch_and_goes_with_its_hold_in_another() {
        let (h, up, mut list) = setup("plan");
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        assert_eq!(up.borrow().fetches, [T0]);
        let plan = planned(&r, T0 + MINUTE_MS).at_ms.unwrap();
        assert!((T0 + 12 * MINUTE_MS..=T0 + 18 * MINUTE_MS).contains(&plan));
        // restarted 5 minutes later (the provider's own hold is gone with the process): the same plan
        up.borrow_mut().hold = 0;
        let mut r = round(&h);
        run(&mut r, &mut list, T0 + 5 * MINUTE_MS);
        assert_eq!(planned(&r, T0 + 5 * MINUTE_MS).at_ms, Some(plan));
        run(&mut r, &mut list, plan - 1_000);
        assert_eq!(
            up.borrow().fetches.len(),
            1,
            "held to the plan made before the restart"
        );
        run(&mut r, &mut list, plan);
        assert_eq!(up.borrow().fetches, [T0, plan]);
        // the next plan holds the provider off; a new clock epoch drops it and the hold the provider was given
        let next = planned(&r, plan + MINUTE_MS).at_ms.unwrap();
        run(&mut r, &mut list, plan + 10 * MINUTE_MS + 1_000);
        assert_eq!(up.borrow().hold, next);
        new_epoch(&h);
        run(&mut r, &mut list, plan + 11 * MINUTE_MS);
        assert_eq!(
            up.borrow().fetches.len(),
            3,
            "the plan of the epoch before goes"
        );
    }

    #[test]
    fn a_statusline_value_whose_file_event_hasnt_come_puts_the_fetch_off_too() {
        let (h, up, mut list) = setup("passive-no-event");
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        let plan = planned(&r, T0 + MINUTE_MS).at_ms.unwrap();
        // the record was written, its event not delivered
        up.borrow_mut().passive = Some(plan - 30_000);
        run(&mut r, &mut list, plan);
        assert_eq!(up.borrow().fetches.len(), 1, "no query");
        assert_eq!(planned(&r, plan).waiting, Some(Waiting::Passive));
    }

    #[test]
    fn a_statusline_value_that_came_with_the_fetch_due_puts_it_off_in_that_round() {
        let (h, up, mut list) = setup("passive-new");
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        let plan = planned(&r, T0 + MINUTE_MS).at_ms.unwrap();
        {
            let mut u = up.borrow_mut();
            u.passive = Some(plan - 30_000);
            u.dirty = true;
        }
        run(&mut r, &mut list, plan);
        assert_eq!(
            up.borrow().fetches.len(),
            1,
            "no query in the round the value came"
        );
        let next = planned(&r, plan);
        assert_eq!(next.waiting, Some(Waiting::Passive));
        assert_eq!(next.at_ms, Some(plan - 30_000 + 15 * MINUTE_MS));
        // reading the same record again puts nothing off again
        for k in 1..4 {
            up.borrow_mut().dirty = true;
            run(&mut r, &mut list, plan + k * MINUTE_MS);
        }
        run(&mut r, &mut list, plan - 30_000 + 15 * MINUTE_MS);
        assert_eq!(up.borrow().fetches.len(), 2);
    }

    #[test]
    fn a_statusline_value_the_fetch_replaced_puts_nothing_off() {
        let (h, up, mut list) = setup("passive-old");
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        assert_eq!(up.borrow().fetches, [T0]);
        let plan = planned(&r, T0 + MINUTE_MS).at_ms.unwrap();
        // a statusLine value at 4 minutes, then the provider's own fetch at 5 (a manual collect) replaced it, and it is still held
        {
            let mut u = up.borrow_mut();
            u.passive = Some(T0 + 4 * MINUTE_MS);
            u.last_attempt = T0 + 5 * MINUTE_MS;
            u.fetches.push(T0 + 5 * MINUTE_MS);
        }
        // due at the plan, or 10 minutes after the provider's fetch: not put off to 4 + 15 minutes
        let due = plan.max(T0 + 15 * MINUTE_MS);
        assert!(due < T0 + 19 * MINUTE_MS);
        run(&mut r, &mut list, due);
        assert_eq!(
            up.borrow().fetches,
            [T0, T0 + 5 * MINUTE_MS, due],
            "fetched when due"
        );
    }

    #[test]
    fn statusline_values_coming_on_put_the_first_fetch_off_60_minutes_from_joining_also_across_a_restart()
     {
        let (h, up, mut list) = setup("passive-cap");
        let mut r = round(&h);
        for m in 0..=90 {
            let t = T0 + m * MINUTE_MS;
            if m == 30 {
                up.borrow_mut().hold = 0;
                r = round(&h);
            }
            {
                let mut u = up.borrow_mut();
                u.passive = Some(t - 10_000);
                u.dirty = true;
            }
            run(&mut r, &mut list, t);
            if !up.borrow().fetches.is_empty() {
                break;
            }
        }
        assert_eq!(up.borrow().fetches, [T0 + 60 * MINUTE_MS]);
    }

    #[test]
    fn an_allowed_fetch_that_sent_nothing_upstream_plans_nothing() {
        let (h, up, mut list) = setup("not-run");
        let mut r = round(&h);
        up.borrow_mut().cached = true;
        run(&mut r, &mut list, T0);
        assert!(up.borrow().fetches.is_empty());
        assert_eq!(planned(&r, T0 + MINUTE_MS).waiting, None);
        run(&mut r, &mut list, T0 + MINUTE_MS);
        assert_eq!(
            up.borrow().fetches,
            [T0 + MINUTE_MS],
            "not held to a plan from a fetch that didn't happen"
        );
    }

    /// A provider that takes no passive values (as Codex): it queries only when allowed, and its acceptance needs a query
    #[derive(Default)]
    struct Far {
        queries: u32,
        accepts: u32,
        hold: i64,
        accepted: Option<bool>,
        run: Option<Run>,
        /// Shows a safety stop, saved by the provider
        safety: bool,
    }

    struct Remote(&'static str, Rc<RefCell<Far>>);

    impl Provider for Remote {
        fn id(&self) -> &'static str {
            self.0
        }
        fn next_due_ms(&self, now: i64) -> i64 {
            now.max(self.1.borrow().hold)
        }
        fn hold_fetch_until(&mut self, until_ms: i64) -> bool {
            self.1.borrow_mut().hold = until_ms;
            true
        }
        fn take_run(&mut self) -> Option<Run> {
            self.1.borrow_mut().run.take()
        }
        fn accept_account(&mut self) {
            self.1.borrow_mut().accepts += 1;
        }
        fn account_accepted(&self) -> Option<bool> {
            self.1.borrow().accepted
        }
        fn safety_stopped(&self) -> bool {
            self.1.borrow().safety
        }
        fn collect(&mut self, now: i64, force: bool) -> ProviderSnapshot {
            let mut f = self.1.borrow_mut();
            f.run = Some(Run::NotRun);
            if force || now >= f.hold {
                f.queries += 1;
                f.run = Some(Run::Ran(Outcome::Ok));
                // the switch is taken only with the new account's value
                f.accepted = (f.accepts > 0).then_some(true);
            } else if f.accepts > 0 {
                f.accepted = Some(false);
            }
            let mut s = snap();
            if f.safety {
                s.error_code = Some(crate::schema::ErrorCode::SafetyStop);
            }
            s
        }
    }

    /// The destination's turns: grants as told, keeps the shared stop, and records what was asked, reported and sent
    #[derive(Default)]
    struct Line {
        grant: bool,
        denied: bool,
        stop: u64,
        resuming: bool,
        asks: Vec<String>,
        results: Vec<String>,
        puts: u32,
        /// The row's version (moves on with every grant and result)
        version: u64,
        /// Results don't arrive (their answer is lost)
        results_down: bool,
        /// Uploads are refused for now (503): observations stay queued
        puts_down: bool,
        /// The bodies of the uploads taken
        bodies: Vec<serde_json::Value>,
    }

    #[derive(Clone, Default)]
    struct Wire(Rc<RefCell<Line>>);

    impl crate::push::Transport for Wire {
        fn put(
            &mut self,
            _url: &str,
            _headers: &[(&str, &str)],
            body: &str,
        ) -> Result<(u16, String), crate::push::SendError> {
            let mut l = self.0.borrow_mut();
            l.puts += 1;
            if l.puts_down {
                return Ok((503, r#"{"error":"unavailable"}"#.into()));
            }
            if let Ok(v) = serde_json::from_str(body) {
                l.bodies.push(v);
            }
            Ok((204, String::new()))
        }

        fn post(
            &mut self,
            url: &str,
            _headers: &[(&str, &str)],
            body: &str,
        ) -> Result<(u16, String), crate::push::SendError> {
            let asked: serde_json::Value = serde_json::from_str(body).unwrap();
            let mut l = self.0.borrow_mut();
            if url.ends_with("/result") && l.results_down {
                return Err(crate::push::SendError::NotSent);
            }
            let mut out = serde_json::Map::new();
            for (p, v) in asked.as_object().unwrap() {
                let attempt = v["attempt"].clone();
                let mut answer = if url.ends_with("/result") {
                    let outcome = v["outcome"].as_str().unwrap().to_string();
                    if outcome == "access_denied" && !l.denied {
                        l.denied = true;
                        l.stop += 1;
                    } else if outcome == "ok" && l.resuming {
                        l.denied = false;
                    }
                    l.resuming = false;
                    l.results.push(outcome);
                    l.version += 1;
                    serde_json::json!({"ack": true, "attempt": attempt, "kind": v["kind"], "applied": true})
                } else {
                    let kind = v["kind"].as_str().unwrap().to_string();
                    l.asks.push(kind.clone());
                    let go = match kind.as_str() {
                        "peek" | "release" => false,
                        "resume" => l.denied && v["gen"].as_u64() == Some(l.stop),
                        _ => l.grant && !l.denied,
                    };
                    l.resuming |= go && kind == "resume";
                    if go {
                        l.version += 1;
                    }
                    let mut a = serde_json::json!({"go": go, "kind": kind, "attempt": attempt});
                    if !go && kind != "peek" && kind != "release" {
                        a["reason"] =
                            serde_json::json!(if l.denied { "access_denied" } else { "turn" });
                        a["wait_s"] = serde_json::json!(600);
                    }
                    a
                };
                answer["state"] = serde_json::json!({"denied": l.denied, "denied_gen": l.stop, "rate_stage": 0, "rate_wait_s": 0, "version": l.version});
                out.insert(p.clone(), answer);
            }
            Ok((200, serde_json::Value::Object(out).to_string()))
        }
    }

    struct Token;
    impl crate::push::CredentialStore for Token {
        fn load(&self) -> Result<crate::push::Credentials, String> {
            Ok(crate::push::Credentials {
                token: "worker-token".into(),
            })
        }
    }

    /// A PC with push set up: its round, its sender and the destination it talks to
    fn shared(h: &Path) -> (Round, Pusher, Wire) {
        crate::test_util::trust_clock(h);
        let mut cfg = Config::default();
        cfg.push.url = "https://x.example".into();
        let wire = Wire::default();
        let pusher = Pusher::new(
            h,
            "https://x.example/v2/snapshots/mac",
            Logger::stderr(),
            Box::new(wire.clone()),
            Box::new(Token),
        );
        (
            Round::new(&cfg, "mac", Logger::stderr(), clock, h),
            pusher,
            wire,
        )
    }

    fn ask(provider: Option<&str>, force: bool, account: Account) -> Request {
        Request {
            id: "0123456789abcdef".into(),
            session: String::new(),
            created_ms: T0,
            provider: provider.map(str::to_string),
            force,
            resume: None,
            replace: None,
            account,
            // an acceptance asked for a switch seen waiting
            accept_target: (account != Account::Keep).then_some(0),
        }
    }

    #[test]
    fn a_manual_collect_asks_as_the_agent_does_its_fetch_moves_the_plan_and_it_sends_no_value_early()
     {
        let (h, up, mut list) = setup("u27-ask");
        let (mut r, mut p, wire) = shared(&h);
        NOW.with(|n| n.set(T0));
        // another PC holds the lease: nothing goes upstream (the provider's own interval long past)
        let (_, out) = r.run_request(&mut list, Some(&mut p), &ask(None, false, Account::Keep));
        assert!(up.borrow().fetches.is_empty());
        // the row's version read first, then the attempt made against it
        assert_eq!(wire.0.borrow().asks, ["peek", "fetch"]);
        assert!(
            out.notes.iter().any(|n| n.contains("not fetched now")),
            "{:?}",
            out.notes
        );
        // --force passes the lease, once; the plan follows the fetch
        wire.0.borrow_mut().grant = true;
        let t = T0 + MINUTE_MS;
        NOW.with(|n| n.set(t));
        r.run_request(&mut list, Some(&mut p), &ask(None, true, Account::Keep));
        assert_eq!(up.borrow().fetches, [t]);
        assert_eq!(
            wire.0.borrow().asks.last().map(String::as_str),
            Some("force")
        );
        assert_eq!(wire.0.borrow().results, ["ok"]);
        assert!(planned(&r, t).at_ms.unwrap() >= t + 12 * MINUTE_MS);
        // without --force the plan holds a manual collect too: nothing asked
        let asked = wire.0.borrow().asks.len();
        NOW.with(|n| n.set(t + MINUTE_MS));
        r.run_request(&mut list, Some(&mut p), &ask(None, false, Account::Keep));
        assert_eq!(
            (up.borrow().fetches.len(), wire.0.borrow().asks.len()),
            (1, asked)
        );
    }

    #[test]
    fn an_acceptance_that_needs_a_query_isnt_made_without_a_go_and_is_made_once_with_one() {
        for grant in [false, true] {
            let h = crate::test_util::TempHome::new(&format!("headroom-round-u27-accept-{grant}"));
            let (mut r, mut p, wire) = shared(&h);
            wire.0.borrow_mut().grant = grant;
            let far = Rc::new(RefCell::new(Far::default()));
            let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Remote("codex", far.clone()))];
            NOW.with(|n| n.set(T0));
            let (_, out) = r.run_request(
                &mut list,
                Some(&mut p),
                &ask(Some("codex"), false, Account::Accept),
            );
            let f = far.borrow();
            if grant {
                assert_eq!((f.queries, f.accepts, out.ok), (1, 1, true));
                assert!(
                    out.notes
                        .iter()
                        .any(|n| n.contains("accepted the account switch"))
                );
            } else {
                // no query at all, the switch stays pending, and the collect fails
                assert_eq!((f.queries, f.accepts, out.ok), (0, 0, false));
                assert!(
                    out.notes.iter().any(|n| n.contains("nothing was accepted")),
                    "{:?}",
                    out.notes
                );
            }
        }
    }

    #[test]
    fn a_request_the_agent_takes_leaves_its_other_providers_going_on() {
        let (h, up, mut list) = setup("u27-delegated");
        let far = Rc::new(RefCell::new(Far::default()));
        list.push(Box::new(Remote("codex", far.clone())));
        let mut r = round(&h);
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(&mut list, None, &ask(Some("codex"), true, Account::Keep));
        assert_eq!(far.borrow().queries, 1, "the named one, its way");
        assert_eq!(up.borrow().fetches, [T0], "the other one, as planned");
        assert!(out.ok, "the fetch forced went upstream");
        // a provider named that this agent doesn't run: the request fails
        let (_, out) = r.run_request(&mut list, None, &ask(Some("gemini"), true, Account::Keep));
        assert!(!out.ok);
        assert!(out.notes.iter().any(|n| n.contains("isn't running")));
    }

    #[test]
    fn a_resume_goes_only_for_the_stop_the_user_checked_and_past_a_safety_stop_only_with_force() {
        let (h, up, mut list) = setup("u27-resume");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        up.borrow_mut().deny = true;
        NOW.with(|n| n.set(T0));
        r.run(&mut list, Some(&mut p));
        assert_eq!(r.coord.denied("claude"), Some(1));
        assert_eq!(wire.0.borrow().results, ["access_denied"]);
        let resume = |stop| Request {
            resume: Some(stop),
            ..ask(Some("claude"), false, Account::Keep)
        };
        // another stop than the one standing: nothing asked, nothing fetched
        let t = T0 + 20 * MINUTE_MS;
        NOW.with(|n| n.set(t));
        r.run_request(&mut list, Some(&mut p), &resume(7));
        assert_eq!(up.borrow().fetches.len(), 1);
        assert!(!wire.0.borrow().asks.iter().any(|k| k == "resume"));
        // a safety stop shows too: only with --force as well
        {
            let mut u = up.borrow_mut();
            u.deny = false;
            u.safety = true;
        }
        let (_, out) = r.run_request(&mut list, Some(&mut p), &resume(1));
        assert_eq!(up.borrow().fetches.len(), 1);
        assert!(
            out.notes.iter().any(|n| n.contains("add --force")),
            "{:?}",
            out.notes
        );
        let t = t + MINUTE_MS;
        NOW.with(|n| n.set(t));
        r.run_request(
            &mut list,
            Some(&mut p),
            &Request {
                force: true,
                ..resume(1)
            },
        );
        assert_eq!(up.borrow().fetches.len(), 2);
        assert_eq!(
            wire.0
                .borrow()
                .asks
                .iter()
                .filter(|k| *k == "resume")
                .count(),
            1
        );
        assert!(r.coord.denied("claude").is_none() && !wire.0.borrow().denied);
    }

    #[test]
    fn the_cli_s_own_round_sees_a_safety_stop_the_provider_saved_before_a_resume() {
        let h = crate::test_util::TempHome::new("headroom-round-u27-safety");
        let far = Rc::new(RefCell::new(Far {
            safety: true,
            ..Far::default()
        }));
        let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Remote("codex", far.clone()))];
        // a new round (no value yet), as the CLI's own
        let mut r = round(&h);
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(
            &mut list,
            None,
            &Request {
                resume: Some(1),
                ..ask(Some("codex"), false, Account::Keep)
            },
        );
        assert_eq!(far.borrow().queries, 0);
        assert!(
            out.notes.iter().any(|n| n.contains("add --force")),
            "{:?}",
            out.notes
        );
    }

    #[test]
    fn the_values_of_the_account_before_go_from_snapshot_json_before_an_acceptance() {
        let (h, _up, mut list) = setup("u28-hide");
        crate::test_util::trust_clock(&h);
        let values = BTreeMap::from([
            ("claude".to_string(), snap()),
            ("codex".to_string(), snap()),
        ]);
        write_snapshot(&h, &values, T0, "mac", usable_epoch(&h)).unwrap();
        let mut r = round(&h);
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(
            &mut list,
            None,
            &ask(Some("claude"), false, Account::Accept),
        );
        // the fake doesn't say it accepted: the request fails, and claude's values before aren't shown again
        assert!(!out.ok);
        let saved: serde_json::Value = crate::store::read_json(&h.join("snapshot.json")).unwrap();
        assert!(saved["providers"].get("claude").is_none());
        assert!(saved["providers"].get("codex").is_some(), "the others stay");
    }

    #[test]
    fn a_round_that_took_a_new_statusline_value_starts_no_cli_also_when_the_fetch_isnt_due_any_more()
     {
        let (h, up, mut list) = setup("u28-passive-skip");
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        assert_eq!(up.borrow().fetches, [T0]);
        let plan = planned(&r, T0 + MINUTE_MS).at_ms.unwrap();
        let collects = up.borrow().collects;
        // a new record that shows a switch (the fetch held for good) while the version check is due
        {
            let mut u = up.borrow_mut();
            u.passive = Some(plan - 1_000);
            u.dirty = true;
            u.switch_on_passive = true;
            u.version_due = true;
        }
        run(&mut r, &mut list, plan);
        assert_eq!(
            up.borrow().collects,
            collects,
            "no CLI in the round it came"
        );
        // the next round, with nothing new, does its version check
        run(&mut r, &mut list, plan + MINUTE_MS);
        assert_eq!(up.borrow().collects, collects + 1);
    }
    #[test]
    fn a_provider_turned_off_is_never_a_request_s_target() {
        let (h, up, mut list) = setup("u30-off");
        // claude turned off (a provider built anyway: what it does says nothing went upstream)
        up.borrow_mut().cached = true;
        let far = Rc::new(RefCell::new(Far::default()));
        list.push(Box::new(Remote("codex", far.clone())));
        let mut cfg = Config::default();
        cfg.claude.enabled = false;
        let mut r = Round::new(&cfg, "mac", Logger::stderr(), clock, &h);
        NOW.with(|n| n.set(T0));
        // --force for all: only the ones running; the request succeeds with them
        let (_, out) = r.run_request(&mut list, None, &ask(None, true, Account::Keep));
        assert_eq!(far.borrow().queries, 1);
        assert!(out.ok, "{:?}", out.notes);
        // named: the request fails, saying it is turned off
        NOW.with(|n| n.set(T0 + MINUTE_MS));
        let (_, out) = r.run_request(&mut list, None, &ask(Some("claude"), true, Account::Keep));
        assert!(!out.ok);
        assert!(
            out.notes.iter().any(|n| n.contains("turned off")),
            "{:?}",
            out.notes
        );
    }

    #[test]
    fn a_resume_succeeds_only_when_the_stop_ended_on_the_destination_s_word() {
        // nothing stopped: nothing to resume, and the request fails
        let (h, up, mut list) = setup("u30-resume-none");
        let mut r = round(&h);
        NOW.with(|n| n.set(T0));
        let resume = |stop| Request {
            resume: Some(stop),
            ..ask(Some("claude"), false, Account::Keep)
        };
        let (_, out) = r.run_request(&mut list, None, &resume(1));
        assert!(up.borrow().fetches.is_empty());
        assert!(!out.ok);
        // stopped, fetched as resumed, but the result didn't reach the destination: the stop stands, and the request fails
        let (h, up, mut list) = setup("u30-resume-lost");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        up.borrow_mut().deny = true;
        NOW.with(|n| n.set(T0));
        r.run(&mut list, Some(&mut p));
        assert_eq!(r.coord.denied("claude"), Some(1));
        up.borrow_mut().deny = false;
        wire.0.borrow_mut().results_down = true;
        let t = T0 + 20 * MINUTE_MS;
        NOW.with(|n| n.set(t));
        let (_, out) = r.run_request(&mut list, Some(&mut p), &resume(1));
        assert_eq!(up.borrow().fetches.len(), 2, "fetched as resumed");
        assert!(r.coord.denied("claude").is_some());
        assert!(!out.ok, "{:?}", out.notes);
        assert!(out.notes.iter().any(|n| n.contains("nothing was resumed")));
    }

    #[test]
    fn no_acceptance_with_push_set_up_but_no_sender() {
        let (h, up, mut list) = setup("u30-accept-nosender");
        crate::test_util::trust_clock(&h);
        let mut cfg = Config::default();
        cfg.push.url = "https://x.example".into();
        let mut r = Round::new(&cfg, "mac", Logger::stderr(), clock, &h);
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(
            &mut list,
            None,
            &ask(Some("claude"), false, Account::Accept),
        );
        assert!(!out.ok);
        assert!(
            out.notes
                .iter()
                .any(|n| n.contains("was not accepted: this PC's clock or its push state")),
            "{:?}",
            out.notes
        );
        assert!(up.borrow().fetches.is_empty());
    }

    #[test]
    fn a_record_waiting_with_no_fetch_allowed_is_taken_starting_no_cli() {
        let (h, up, mut list) = setup("u30-passive-held");
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        let collects = up.borrow().collects;
        // well before the next fetch: a new record and a version check due
        {
            let mut u = up.borrow_mut();
            u.passive = Some(T0 + MINUTE_MS);
            u.dirty = true;
            u.version_due = true;
        }
        run(&mut r, &mut list, T0 + 2 * MINUTE_MS);
        assert!(!up.borrow().dirty, "taken in");
        assert_eq!(
            up.borrow().collects,
            collects,
            "no CLI in the round it came"
        );
        run(&mut r, &mut list, T0 + 3 * MINUTE_MS);
        assert_eq!(
            up.borrow().collects,
            collects + 1,
            "the version check after"
        );
    }
    #[test]
    fn a_stop_that_came_after_a_request_was_taken_goes_first_and_the_request_ends_not_done() {
        let h = crate::test_util::TempHome::new("headroom-round-u30-stop-take");
        let log = Logger::stderr();
        let mut req = ask(None, true, Account::Keep);
        req.session = "s1".into();
        req.created_ms = crate::time::now_ms();
        requests::publish(&h, &req, || true).unwrap();
        std::fs::write(h.join(crate::install::STOP_FILE), "s1").unwrap();
        assert!(take_request(&h, "s1", &log).is_none());
        assert!(matches!(
            requests::look(&h, &req.id),
            requests::Seen::Ended(RequestOutcome {
                finish: requests::Finish::NotDone,
                ok: false,
                ..
            })
        ));
        // control: with no stop, it is taken
        std::fs::remove_file(h.join(crate::install::STOP_FILE)).unwrap();
        let mut other = req.clone();
        other.id = "0123456789abcdee".into();
        requests::publish(&h, &other, || true).unwrap();
        assert_eq!(
            take_request(&h, "s1", &log).and_then(|t| t.0).map(|r| r.id),
            Some(other.id)
        );
    }

    #[test]
    fn a_request_whose_round_couldn_t_write_snapshot_json_fails() {
        let h = crate::test_util::TempHome::new("headroom-round-u30-unshown");
        let log = Logger::stderr();
        let done = |id: &str| RequestOutcome {
            id: id.into(),
            ok: true,
            done_ms: crate::time::now_ms(),
            ..RequestOutcome::default()
        };
        assert!(settle_request(&h, done("0123456789abcdef"), false, &log).is_none());
        let requests::Seen::Ended(out) = requests::look(&h, "0123456789abcdef") else {
            panic!("no result")
        };
        assert!(!out.ok);
        assert!(
            out.notes
                .iter()
                .any(|n| n.contains("snapshot.json couldn't be written"))
        );
        // control
        settle_request(&h, done("0123456789abcdee"), true, &log);
        assert!(matches!(
            requests::look(&h, "0123456789abcdee"),
            requests::Seen::Ended(RequestOutcome { ok: true, .. })
        ));
    }

    #[test]
    fn an_agent_whose_config_can_t_be_read_publishes_no_session() {
        let h = crate::test_util::TempHome::new("headroom-round-u30-bad-config");
        std::fs::write(h.join("config.toml"), b"[push\nurl = ").unwrap();
        assert_eq!(super::run(&h), 2);
        assert!(!h.join(SESSION_FILE).exists());
        assert!(crate::install::session_of(&h).is_none());
    }

    #[test]
    fn an_acceptance_with_nothing_seen_waiting_keeps_the_values() {
        let (h, _up, mut list) = setup("u31-accept-none");
        crate::test_util::trust_clock(&h);
        let values = BTreeMap::from([("claude".to_string(), snap())]);
        write_snapshot(&h, &values, T0, "mac", usable_epoch(&h)).unwrap();
        let mut r = round(&h);
        NOW.with(|n| n.set(T0));
        let req = Request {
            accept_target: None,
            ..ask(Some("claude"), false, Account::Accept)
        };
        let (_, out) = r.run_request(&mut list, None, &req);
        assert!(!out.ok);
        assert!(
            out.notes
                .iter()
                .any(|n| n.contains("nothing waited to be accepted")),
            "{:?}",
            out.notes
        );
        let saved: serde_json::Value = crate::store::read_json(&h.join("snapshot.json")).unwrap();
        assert!(
            saved["providers"].get("claude").is_some(),
            "its values stay"
        );
        // a provider whose acceptance needs a query: none goes upstream for it
        let far = Rc::new(RefCell::new(Far::default()));
        let mut remote: Vec<Box<dyn Provider>> = vec![Box::new(Remote("codex", far.clone()))];
        let req = Request {
            accept_target: None,
            ..ask(Some("codex"), false, Account::Accept)
        };
        let (_, out) = r.run_request(&mut remote, None, &req);
        assert!(!out.ok);
        assert_eq!((far.borrow().queries, far.borrow().accepts), (0, 0));
    }

    #[test]
    fn a_request_for_all_with_every_provider_turned_off_fails() {
        let (h, up, mut list) = setup("u31-all-off");
        let mut cfg = Config::default();
        cfg.claude.enabled = false;
        cfg.codex.enabled = false;
        cfg.gemini.enabled = false;
        up.borrow_mut().cached = true;
        let mut r = Round::new(&cfg, "mac", Logger::stderr(), clock, &h);
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(&mut list, None, &ask(None, true, Account::Keep));
        assert!(!out.ok);
        assert!(
            out.notes
                .iter()
                .any(|n| n.contains("no provider is turned on")),
            "{:?}",
            out.notes
        );
    }

    #[test]
    fn a_provider_turned_off_is_never_rechecked_for_its_stop() {
        let (h, up, mut list) = setup("u32-off-stop");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        up.borrow_mut().deny = true;
        NOW.with(|n| n.set(T0));
        r.run(&mut list, Some(&mut p));
        assert_eq!(r.coord.denied("claude"), Some(1));
        // the agent started again with claude turned off: its stop is never asked about
        let mut cfg = Config::default();
        cfg.push.url = "https://x.example".into();
        cfg.claude.enabled = false;
        let mut r = Round::new(&cfg, "mac", Logger::stderr(), clock, &h);
        let peeks = |w: &Wire| w.0.borrow().asks.iter().filter(|k| *k == "peek").count();
        let before = peeks(&wire);
        for m in [10, 20, 30] {
            NOW.with(|n| n.set(T0 + m * MINUTE_MS));
            r.run(&mut list, Some(&mut p));
        }
        assert_eq!(peeks(&wire), before);
        assert_eq!(r.coord.next_upkeep(&[], T0 + 30 * MINUTE_MS), i64::MAX);
    }

    #[test]
    fn a_stop_a_pc_that_doesn_t_share_found_stays_after_its_plan_file_is_lost() {
        let (h, up, mut list) = setup("u36-plan-lost");
        crate::test_util::trust_clock(&h);
        up.borrow_mut().deny = true;
        let mut r = round(&h);
        run(&mut r, &mut list, T0);
        assert_eq!(r.coord.denied("claude"), Some(1));
        let values = r.overlaid(r.latest.clone());
        write_snapshot(&h, &values, T0, "mac", usable_epoch(&h)).unwrap();
        // the agent stops; only its plan file is lost
        std::fs::remove_file(h.join(crate::schedule::PLAN_FILE)).unwrap();
        up.borrow_mut().deny = false;
        let fetches = up.borrow().fetches.len();
        NOW.with(|n| n.set(T0 + 120 * MINUTE_MS));
        let mut again = round(&h);
        run(&mut again, &mut list, T0 + 120 * MINUTE_MS);
        assert_eq!(again.coord.denied("claude"), Some(1));
        assert_eq!(
            up.borrow().fetches.len(),
            fetches,
            "nothing upstream before a resume"
        );
    }

    #[test]
    fn a_manual_collect_waits_while_the_state_can_t_be_read() {
        struct Waiting(Rc<RefCell<u32>>);
        impl Provider for Waiting {
            fn id(&self) -> &'static str {
                "claude"
            }
            fn next_due_ms(&self, _now: i64) -> i64 {
                i64::MAX
            }
            fn collect(&mut self, _now: i64, _force: bool) -> ProviderSnapshot {
                *self.0.borrow_mut() += 1;
                snap()
            }
            fn takes_passive_values(&self) -> bool {
                true
            }
            fn take_passive(&mut self, _now: i64) -> Option<ProviderSnapshot> {
                *self.0.borrow_mut() += 1;
                None
            }
            fn state_retry_at(&self) -> Option<i64> {
                Some(T0 + MINUTE_MS)
            }
        }
        let h = crate::test_util::TempHome::new("headroom-round-u36-state-wait");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        let calls = Rc::new(RefCell::new(0));
        let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Waiting(calls.clone()))];
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(
            &mut list,
            Some(&mut p),
            &ask(Some("claude"), true, Account::Keep),
        );
        assert!(!out.ok);
        assert_eq!(*calls.borrow(), 0, "nothing taken or run");
        assert!(
            !wire.0.borrow().asks.iter().any(|k| k == "force"),
            "no turn asked for"
        );
    }

    #[test]
    fn a_manual_force_that_finds_the_state_unreadable_asks_no_turn() {
        struct Finds(Rc<RefCell<(Option<i64>, u32)>>);
        impl Provider for Finds {
            fn id(&self) -> &'static str {
                "claude"
            }
            fn next_due_ms(&self, _now: i64) -> i64 {
                i64::MAX
            }
            fn collect(&mut self, _now: i64, _force: bool) -> ProviderSnapshot {
                self.0.borrow_mut().1 += 1;
                snap()
            }
            fn takes_passive_values(&self) -> bool {
                true
            }
            // its intake finds the state unreadable, this once
            fn take_passive(&mut self, now: i64) -> Option<ProviderSnapshot> {
                self.0.borrow_mut().0 = Some(now + MINUTE_MS);
                None
            }
            fn state_retry_at(&self) -> Option<i64> {
                self.0.borrow().0
            }
        }
        let h = crate::test_util::TempHome::new("headroom-round-u37-state-found");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        let seen = Rc::new(RefCell::new((None, 0)));
        let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Finds(seen.clone()))];
        NOW.with(|n| n.set(T0));
        let (_, out) = r.run_request(
            &mut list,
            Some(&mut p),
            &ask(Some("claude"), true, Account::Keep),
        );
        assert!(!out.ok);
        assert_eq!(seen.borrow().1, 0, "nothing run");
        assert!(
            !wire.0.borrow().asks.iter().any(|k| k == "force"),
            "no turn asked for"
        );
    }

    #[test]
    fn a_state_that_can_t_be_read_holds_its_queue_shows_a_fetch_failure_and_sends_the_queue_once_after()
     {
        /// A provider whose value moves with each collect, that can't read its state for a while (shown as a stop, as Codex shows it).
        /// Its value is fetched the given time before it's collected
        type State = Rc<RefCell<(bool, Option<i64>, f64, i64)>>;
        struct Flaky(State, Option<Run>);
        impl Provider for Flaky {
            fn id(&self) -> &'static str {
                "codex"
            }
            fn next_due_ms(&self, now: i64) -> i64 {
                now
            }
            fn hold_fetch_until(&mut self, _until_ms: i64) -> bool {
                true
            }
            fn take_run(&mut self) -> Option<Run> {
                self.1.take()
            }
            fn collect(&mut self, now: i64, _force: bool) -> ProviderSnapshot {
                let mut f = self.0.borrow_mut();
                if f.0 {
                    f.1 = Some(now + 5 * MINUTE_MS);
                    self.1 = Some(Run::NotRun);
                    let mut s = ProviderSnapshot::empty(ProviderStatus::Error, "paused", None);
                    s.error_code = Some(crate::schema::ErrorCode::AccountChanged);
                    return s;
                }
                f.1 = None;
                self.1 = Some(Run::Ran(Outcome::Ok));
                let at = Some(crate::time::iso_from_ms(now - f.3));
                let mut s = snap();
                s.fetched_at = at.clone();
                s.windows = vec![make_window("five_hour", f.2, Some(T0 + 300 * MINUTE_MS))];
                s.windows[0].fetched_at = at;
                s
            }
            fn state_retry_at(&self) -> Option<i64> {
                self.0.borrow().1
            }
        }
        let h = crate::test_util::TempHome::new("headroom-round-u40-unread-queue");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        let flaky = Rc::new(RefCell::new((false, None, 10.0, 2 * MINUTE_MS)));
        let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Flaky(flaky.clone(), None))];
        let at = |m: f64| T0 + (m * MINUTE_MS as f64) as i64;
        let round = |r: &mut Round, list: &mut [Box<dyn Provider>], p: &mut Pusher, t: i64| {
            NOW.with(|n| n.set(t));
            r.run(list, Some(p));
        };
        // a value fetched two minutes ago is sent; a new value half a minute on is observed (over a minute after the first) and queued (a
        // send waits a minute after a success)
        round(&mut r, &mut list, &mut p, at(0.0));
        flaky.borrow_mut().2 = 33.0;
        flaky.borrow_mut().3 = 0;
        round(&mut r, &mut list, &mut p, at(0.5));
        assert_eq!(wire.0.borrow().bodies.len(), 1, "queued");
        // the state can't be read for a while; a send goes out meanwhile
        flaky.borrow_mut().0 = true;
        round(&mut r, &mut list, &mut p, at(0.7));
        round(&mut r, &mut list, &mut p, at(20.0));
        assert!(flaky.borrow().1.is_some(), "found unreadable");
        let sent_33 = |w: &Wire| {
            w.0.borrow()
                .bodies
                .iter()
                .flat_map(|b| b["observations"].as_array().cloned().unwrap_or_default())
                .filter(|o| o["provider"] == "codex" && o["used_percent"] == 33.0)
                .count()
        };
        let last = wire.0.borrow().bodies.last().cloned().unwrap();
        assert_eq!(
            last["snapshot"]["providers"]["codex"]["error_code"], "fetch_failed",
            "not a switch"
        );
        assert!(
            wire.0.borrow().bodies.len() >= 2,
            "a send went out meanwhile"
        );
        assert_eq!(sent_33(&wire), 0, "held meanwhile");
        // read again: the value held goes out once
        flaky.borrow_mut().0 = false;
        flaky.borrow_mut().2 = 40.0;
        round(&mut r, &mut list, &mut p, at(30.0));
        round(&mut r, &mut list, &mut p, at(45.0));
        assert_eq!(sent_33(&wire), 1);
    }
    #[test]
    fn a_tidy_that_can_t_read_the_state_waits_for_the_retry_and_goes_once_it_reads() {
        /// A provider whose tidy can't read its state for now: the first failure starts a minute's wait (as Claude and Gemini do)
        struct Tidy(Rc<RefCell<(bool, Option<i64>, u32)>>);
        impl Provider for Tidy {
            fn id(&self) -> &'static str {
                "claude"
            }
            fn next_due_ms(&self, now: i64) -> i64 {
                now + 60 * MINUTE_MS
            }
            fn collect(&mut self, _now: i64, _force: bool) -> ProviderSnapshot {
                snap()
            }
            fn forget_cached(&mut self) -> bool {
                let mut t = self.0.borrow_mut();
                t.2 += 1;
                if t.0 {
                    t.1 = Some(NOW.with(|n| n.get()) + MINUTE_MS);
                    return false;
                }
                t.1 = None;
                true
            }
            fn state_retry_at(&self) -> Option<i64> {
                self.0.borrow().1
            }
        }
        let h = crate::test_util::TempHome::new("headroom-round-u40-tidy-wait");
        let (mut r, mut p, _wire) = shared(&h);
        // found unreadable before the start's tidy (a new epoch): a minute's wait already runs
        let tidy = Rc::new(RefCell::new((true, Some(T0 + MINUTE_MS), 0)));
        let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Tidy(tidy.clone()))];
        let round = |r: &mut Round, list: &mut [Box<dyn Provider>], p: &mut Pusher, secs: i64| {
            NOW.with(|n| n.set(T0 + secs * 1000));
            r.run(list, Some(p));
        };
        // neither the start's tidy nor the wakes meanwhile read it
        for secs in [0, 10, 20, 50] {
            round(&mut r, &mut list, &mut p, secs);
        }
        assert_eq!(tidy.borrow().2, 0);
        // past the wait, the tidy tries; still unreadable, it starts its own wait, and wakes meanwhile don't read again
        for secs in [70, 80, 100] {
            round(&mut r, &mut list, &mut p, secs);
        }
        assert_eq!(tidy.borrow().2, 1);
        // past that wait, it reads again and the tidy goes; then it's done
        tidy.borrow_mut().0 = false;
        round(&mut r, &mut list, &mut p, 140);
        round(&mut r, &mut list, &mut p, 150);
        assert_eq!(tidy.borrow().2, 2);
        assert_eq!(tidy.borrow().1, None);
    }
    #[test]
    fn a_provider_turned_off_whose_state_can_t_be_read_shows_nothing() {
        /// An enabled provider that fetches each round
        struct Good(Option<Run>);
        impl Provider for Good {
            fn id(&self) -> &'static str {
                "codex"
            }
            fn next_due_ms(&self, now: i64) -> i64 {
                now
            }
            fn hold_fetch_until(&mut self, _until_ms: i64) -> bool {
                true
            }
            fn take_run(&mut self) -> Option<Run> {
                self.0.take()
            }
            fn collect(&mut self, now: i64, _force: bool) -> ProviderSnapshot {
                self.0 = Some(Run::Ran(Outcome::Ok));
                let at = Some(crate::time::iso_from_ms(now));
                let mut s = snap();
                s.fetched_at = at.clone();
                s.windows = vec![make_window("five_hour", 10.0, Some(T0 + 300 * MINUTE_MS))];
                s.windows[0].fetched_at = at;
                s
            }
        }
        /// Gemini, off by default, whose old state the tidy on start couldn't read (waiting to read it again)
        struct Off;
        impl Provider for Off {
            fn id(&self) -> &'static str {
                "gemini"
            }
            fn next_due_ms(&self, _now: i64) -> i64 {
                i64::MAX
            }
            fn collect(&mut self, _now: i64, _force: bool) -> ProviderSnapshot {
                panic!("collected while turned off")
            }
            fn state_retry_at(&self) -> Option<i64> {
                Some(i64::MAX)
            }
        }
        let h = crate::test_util::TempHome::new("headroom-round-u41-off-unread");
        let (mut r, mut p, wire) = shared(&h);
        wire.0.borrow_mut().grant = true;
        let mut list: Vec<Box<dyn Provider>> = vec![Box::new(Good(None)), Box::new(Off)];
        for m in [0, 20] {
            NOW.with(|n| n.set(T0 + m * MINUTE_MS));
            r.run(&mut list, Some(&mut p));
        }
        assert!(!r.latest.contains_key("gemini"));
        let bodies = wire.0.borrow().bodies.clone();
        assert!(bodies.len() >= 2, "the enabled one is sent");
        for b in &bodies {
            assert_ne!(
                b["snapshot"]["providers"]["gemini"]["error_code"],
                "fetch_failed"
            );
            assert_eq!(b["snapshot"]["providers"]["codex"]["status"], "ok");
        }
    }

    #[test]
    fn the_agent_spreads_its_fetches_with_its_own_random_seed() {
        let h = crate::test_util::TempHome::new("headroom-round-u45-seed");
        let (_r, _p, _wire) = shared(&h);
        let seed = std::fs::read_to_string(h.join(crate::store::SCHEDULE_SEED_FILE)).unwrap();
        assert_eq!(seed.len(), 32, "made on start, not the PC's name");
        assert_ne!(seed, "mac");
    }
}
