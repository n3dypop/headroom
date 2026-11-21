//! Command dispatch.

use std::collections::BTreeMap;

use crate::agent;
use crate::config::{self, collector_id, headroom_home};
use crate::providers::codex::CodexProvider;
use crate::push::{Credentials, EpochRead, OsCredentialStore, Pusher, clock_epoch, usable_epoch};
use crate::schedule::{NextRun, SCHEDULE_FILE, SESSION_FILE, SESSION_LOCK_FILE, Schedule};
use crate::schema::build_snapshot;
use crate::store::{Logger, read_json};
use crate::time::now_ms;

const HELP: &str = "headroom — background agent that collects Claude / Codex usage limits

Usage:
  headroom agent                          Run in the background (on Windows, use headroomw.exe)
  headroom statusline [--then \"<cmd>\"]    Called from Claude Code's statusLine
  headroom collect [--provider claude|codex] [--force] [--accept-account]
                                          Fetch once and print the result
                                          (--force ignores the interval; neither uses any quota)
  headroom status                         Show the last result and the current state
  headroom discard-queue                  Discard the observations waiting to be sent and the values the providers cached
                                          (agent stopped; for a planned stop)
  headroom credentials set | clear        Save / delete the destination credentials in the OS credential store
                                          (set reads one line from stdin: the Worker token)
  headroom install | uninstall            Register autostart and start / stop and unregister
                                          (install copies the executable to ~/.headroom/bin)
  headroom start | stop                   Start / stop the background agent (stop waits for the current fetch to finish)
  headroom version

State lives in ~/.headroom (override with HEADROOM_HOME).";

pub fn run(args: Vec<String>) -> i32 {
    let home = headroom_home();
    let rest = args.get(1..).unwrap_or_default();
    match args.first().map(String::as_str) {
        Some("agent") => agent::run(&home),
        Some("statusline") => crate::statusline::run(rest, &home),
        Some("collect") => collect(rest, &home),
        Some("status") => status(&home),
        Some("discard-queue") => discard_queue(&home),
        Some("credentials") => credentials(rest),
        // The folder is checked before config.toml is read, so a relative folder is reported first
        Some("install") => match config::check_home(&home).and_then(|()| config::load(&home)) {
            Ok(cfg) => report(crate::install::install(&home, &cfg)),
            Err(e) => {
                eprintln!("{e}");
                2
            }
        },
        Some("uninstall") => report(crate::install::uninstall(&home)),
        Some("stop") => match crate::install::stop(&home, crate::install::STOP_WAIT) {
            Ok(true) => {
                println!("Stopped the background agent");
                0
            }
            Ok(false) => {
                println!("The background agent is not running");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        Some("start") => report(crate::install::start(&home).map(|started| {
            vec![if started {
                "Started the background agent (the autostart registration is unchanged)".into()
            } else {
                "The background agent is already running".into()
            }]
        })),
        Some("version") | Some("--version") | Some("-V") => {
            println!("headroom {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("help") | Some("--help") | Some("-h") | None => {
            println!("{HELP}");
            0
        }
        Some(other) => {
            eprintln!("Unknown command: {other}\n\n{HELP}");
            2
        }
    }
}

const COLLECT_USAGE: &str =
    "Usage: headroom collect [--provider claude|codex] [--force] [--accept-account]
  --accept-account requires --provider (name exactly one provider to resume)";

#[derive(Debug, PartialEq, Eq)]
struct CollectArgs {
    provider: Option<&'static str>,
    force: bool,
    accept_account: bool,
}

/// Validates the collect arguments. On invalid input nothing is run.
fn parse_collect_args(args: &[String]) -> Result<CollectArgs, String> {
    let mut out = CollectArgs {
        provider: None,
        force: false,
        accept_account: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--force" => out.force = true,
            "--accept-account" => out.accept_account = true,
            "--provider" => {
                if out.provider.is_some() {
                    return Err("--provider was given twice".into());
                }
                out.provider = Some(match it.next().map(String::as_str) {
                    Some("claude") => "claude",
                    Some("codex") => "codex",
                    Some(other) => return Err(format!("Unknown provider: {other}")),
                    None => return Err("--provider needs a value".into()),
                });
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    if out.accept_account && out.provider.is_none() {
        return Err("--accept-account requires --provider claude or --provider codex".into());
    }
    Ok(out)
}

fn collect(args: &[String], home: &std::path::Path) -> i32 {
    let parsed = match parse_collect_args(args) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "{e}
{COLLECT_USAGE}"
            );
            return 2;
        }
    };
    let cfg = match config::load(home) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let CollectArgs {
        provider: only,
        force,
        accept_account,
    } = parsed;
    let log = Logger::stderr();
    let pushing = !cfg.push.url.trim().is_empty();
    let (results, epoch) = match run_collect(
        home,
        pushing,
        || agent::make_providers(home, &cfg, &log),
        only,
        force,
        accept_account,
    ) {
        Collected::Done(results, epoch) => (results, epoch),
        Collected::Unlocked(e) => {
            eprintln!(
                "{e}
The account switch was not accepted"
            );
            return 1;
        }
        Collected::Refused(state) => {
            // Nothing was run (no fetch, no sign-in check, no account acceptance): anything done now would be stamped by that clock
            eprintln!(
                "{}",
                match state {
                    EpochRead::Read {
                        in_flight: Some(_), ..
                    } =>
                        "Not fetched: the result of a send is pending (the destination may have refused this PC's clock). The background agent saves it, or takes it as refused when it starts; collect again after that",
                    EpochRead::Read { .. } =>
                        "Not fetched: the destination refuses this PC's clock. Set the clock automatically (sync it), then collect again",
                    _ =>
                        "Not fetched: the clock state (clock-epoch.json) can't be read. Start the background agent (it makes it again), then collect again",
                }
            );
            if accept_account {
                eprintln!(
                    "The account switch was not accepted (accept it after the clock is fixed)"
                );
                return 1;
            }
            // Shown under this decision (refused): nothing of a value comes out, also if the clock reads as trusted a moment later
            let providers = agent::read_snapshot_at(home, None)
                .map(|s| s.providers)
                .unwrap_or_default();
            let shown = crate::push::trusted_local_at(home, &providers, now_ms(), pushing, false);
            let snapshot = build_snapshot(shown, now_ms(), &collector_id(&cfg));
            println!(
                "{}",
                serde_json::to_string_pretty(&snapshot).unwrap_or_default()
            );
            return 0;
        }
        Collected::Stopped => {
            eprintln!(
                "Stopped: the destination refused this PC's clock meanwhile. Set the clock automatically (sync it), then collect again"
            );
            return 1;
        }
    };
    let collector = collector_id(&cfg);
    let now = now_ms();
    // One decision for saving and printing: only while the epoch the values were taken in is still usable (a refusal saved after the
    // fetches holds them back from both), and as the push state lets them out
    let usable = usable_epoch(home) == Some(epoch);
    let results = if usable {
        crate::push::trusted_local_at(home, &results, now, pushing, true)
    } else {
        eprintln!("Held back: the destination refused this PC's clock meanwhile");
        results
            .into_iter()
            .map(|(id, p)| (id, crate::push::held(p)))
            .collect()
    };
    if only.is_none()
        && usable
        && let Err(e) = agent::write_snapshot(home, &results, now, &collector, Some(epoch))
    {
        eprintln!("Failed to write snapshot.json: {e}");
    }
    let snapshot = build_snapshot(results, now, &collector);
    println!(
        "{}",
        serde_json::to_string_pretty(&snapshot).unwrap_or_default()
    );
    0
}

/// What a manual collect did
#[derive(Debug)]
enum Collected {
    /// What was fetched, and the clock epoch it was taken in
    Done(BTreeMap<String, crate::schema::ProviderSnapshot>, u64),
    /// Not run: the clock isn't trusted now (refused, a send's result pending, or a state that can't be read)
    Refused(EpochRead),
    /// Stopped: a refusal was saved meanwhile (what was fetched across it is not used). Never after an acceptance (see run_collect)
    Stopped,
    /// An acceptance couldn't take the clock lock (nothing was run)
    Unlocked(String),
}

/// Runs a manual collect unless this PC's clock is refused. An acceptance holds the clock lock from the first check to the end: a refusal
/// can't be saved in between (the agent saving one waits for it), so an acceptance is made only on a clock not refused, and one made is
/// reported as made
fn run_collect(
    home: &std::path::Path,
    pushing: bool,
    make: impl FnOnce() -> Vec<Box<dyn crate::providers::Provider>>,
    only: Option<&str>,
    force: bool,
    accept_account: bool,
) -> Collected {
    // The clock state: made here when there is none (a PC whose agent never ran), and trusted without pushing (nothing refuses it)
    let made = if pushing {
        match clock_epoch(home) {
            EpochRead::Missing => crate::push::ensure_clock(home).map(|_| ()),
            _ => Ok(()),
        }
    } else {
        match clock_epoch(home) {
            EpochRead::Read {
                trusted: true,
                in_flight: None,
                ..
            } => Ok(()),
            // Lifted only while no background agent runs: one started with the earlier settings may still be pushing (and be refused).
            // Holding its lock, this is the agent's to resolve, a send it left pending included
            _ => crate::install::hold_agent_lock(home)
                .and_then(|_lock| crate::push::trust_without_push_as_agent(home).map(|_| ())),
        }
    };
    if let Err(e) = made {
        return Collected::Unlocked(e);
    }
    let _lock = if accept_account {
        match crate::push::hold_clock_lock(home) {
            Ok(lock) => Some(lock),
            Err(e) => return Collected::Unlocked(e),
        }
    } else {
        None
    };
    let Some(epoch) = usable_epoch(home) else {
        return Collected::Refused(clock_epoch(home));
    };
    // Each provider is started and its result taken only in that epoch (a refusal and its lifting both within the fetch show as
    // another epoch)
    match collect_providers(make(), only, force, accept_account, &|| {
        usable_epoch(home) != Some(epoch)
    }) {
        Some(results) => Collected::Done(results, epoch),
        None => Collected::Stopped,
    }
}

/// Fetches with each provider (the one named, or all). The refusal of this PC's clock is checked before each provider's fetch or account
/// acceptance, and again after it: a refusal saved meanwhile (by the background agent) stops it, and what was fetched across it is
/// not used (None)
pub(crate) fn collect_providers(
    providers: Vec<Box<dyn crate::providers::Provider>>,
    only: Option<&str>,
    force: bool,
    accept_account: bool,
    refused: &dyn Fn() -> bool,
) -> Option<BTreeMap<String, crate::schema::ProviderSnapshot>> {
    let mut results = BTreeMap::new();
    for mut p in providers {
        if only.is_some_and(|o| o != p.id()) {
            continue;
        }
        if refused() {
            return None;
        }
        // Resume a provider that stopped on an account switch, using the new account (only the one named)
        if accept_account {
            p.accept_account();
        }
        let snap = p.collect(now_ms(), force);
        // What the acceptance did, as the provider saved it
        if accept_account {
            match p.account_accepted() {
                Some(true) => eprintln!("{}: accepted the account switch", p.id()),
                Some(false) => eprintln!("{}: the account switch was not accepted", p.id()),
                None => {}
            }
        }
        if refused() {
            return None;
        }
        results.insert(p.id().to_string(), snap);
    }
    Some(results)
}

/// Shown when `credentials set` is typed directly at a terminal (refused, because the input would show on screen)
pub const CREDENTIALS_TTY_HINT: &str = "Direct input from a terminal is not accepted, so the token never shows on screen. Pipe it in from a hidden prompt:\n  PowerShell: Read-Host -MaskInput 'Worker token' | headroom credentials set\n  macOS (zsh): read -rs 'T?Worker token: ' && printf '%s\\n' \"$T\" | headroom credentials set; unset T";

/// Credentials are read from stdin and never written to the screen, logs or files. Direct input from a terminal is
/// refused because the typed characters would be echoed (no extra dependency to turn off echo per OS; pipe it in instead)
fn credentials(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("set") => {
            if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
                eprintln!("{CREDENTIALS_TTY_HINT}");
                return 2;
            }
            let mut lines = std::io::stdin().lines().map_while(Result::ok);
            let c = Credentials {
                token: lines.next().unwrap_or_default().trim().to_string(),
            };
            if c.token.len() < 16 {
                eprintln!("The first line must be the Worker token");
                return 2;
            }
            match OsCredentialStore::save(&c) {
                Ok(()) => {
                    println!("Saved (Worker token)");
                    0
                }
                Err(e) => {
                    eprintln!("{e}");
                    1
                }
            }
        }
        Some("clear") => match OsCredentialStore::clear() {
            Ok(()) => {
                println!("Cleared");
                0
            }
            Err(e) => {
                eprintln!("{e}");
                1
            }
        },
        _ => {
            eprintln!("Usage: headroom credentials set | clear");
            2
        }
    }
}

fn report(r: Result<Vec<String>, String>) -> i32 {
    match r {
        Ok(lines) => {
            for l in lines {
                println!("{l}");
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// One provider line of `headroom status` (same layout for every provider)
fn provider_status_line(id: &str, failures: u64, last_error: &str, next_check: &str) -> String {
    format!(
        "{id}: {failures} consecutive failures / last error {last_error} / next check {next_check}"
    )
}

/// When the running agent next checks the provider (schedule.json written by the current agent process).
/// `unscheduled_reason` explains a check with no time when the provider knows why (e.g. waiting for a manual resume)
fn planned_check(
    plan: Option<&BTreeMap<String, NextRun>>,
    id: &str,
    running: bool,
    unscheduled_reason: Option<&str>,
) -> String {
    if !running {
        return "none (agent stopped)".into();
    }
    match plan.and_then(|p| p.get(id)) {
        None => "unknown (no schedule from the running agent)".into(),
        Some(run) if run.at_ms.is_none() && !run.disabled => match unscheduled_reason {
            Some(reason) => format!("none ({reason})"),
            None => run.describe(),
        },
        Some(run) => run.describe(),
    }
}

/// The running agent's schedule, only if its writer is still running and it carries that writer's session ID.
/// The agent holds an exclusive lock on SESSION_LOCK_FILE while it runs. This only probes it with a shared lock, so
/// concurrent `status` runs never block each other: if the probe succeeds, the writer is gone (e.g. it crashed and an
/// older agent version now runs), and the files it left are not used
fn current_schedule(home: &std::path::Path) -> Option<BTreeMap<String, NextRun>> {
    let probe = std::fs::File::open(home.join(SESSION_LOCK_FILE)).ok()?;
    match probe.try_lock_shared() {
        Err(std::fs::TryLockError::WouldBlock) => {}
        Ok(()) | Err(std::fs::TryLockError::Error(_)) => return None,
    }
    drop(probe);
    let session = std::fs::read_to_string(home.join(SESSION_FILE)).ok()?;
    let schedule: Schedule = read_json(&home.join(SCHEDULE_FILE))?;
    (!session.is_empty() && schedule.session == session).then_some(schedule.providers)
}

/// For a planned stop before a migration. Holds agent.lock throughout (the agent can't start and send the old queue meanwhile), has the
/// providers forget the values they cached (one could be queued again on the next start), then discards the queue
fn discard_queue(home: &std::path::Path) -> i32 {
    let _lock = match crate::install::hold_agent_lock(home) {
        Ok(lock) => lock,
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    let cfg = match config::load(home) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    // The clock epoch moves on first (with the queue emptied and read back): nothing taken before is sent or used, whatever follows
    let result = match Pusher::discard_queue(home) {
        Ok(Some(n)) => {
            println!("Discarded {n} unsent observations");
            0
        }
        Ok(None) => {
            println!("No push state: nothing to discard");
            0
        }
        Err(e) => {
            eprintln!("{e}");
            return 1;
        }
    };
    // Then the providers tidy what they cached (only tidying: a value left behind is of the epoch before and never used)
    let log = Logger::stderr();
    let mut tidied = true;
    for mut p in agent::make_providers(home, &cfg, &log) {
        tidied &= p.forget_cached();
    }
    if !tidied {
        eprintln!(
            "A provider's cached values couldn't be tidied away now (they aren't used); the agent tidies them later"
        );
    }
    result
}

fn status(home: &std::path::Path) -> i32 {
    let running = crate::install::agent_running(home);
    let plan = if running {
        current_schedule(home)
    } else {
        None
    };
    println!("HEADROOM_HOME: {}", home.display());
    println!(
        "Agent: {} / Autostart: {}",
        if running { "running" } else { "stopped" },
        if crate::install::registered() {
            "registered"
        } else {
            "not registered"
        }
    );
    // Shown as the push state lets it out now (a file written before the latest marks, or by an older version, may hold values a
    // refused clock stamped)
    let pushing = config::load(home).is_ok_and(|c| !c.push.url.trim().is_empty());
    // The clock state: values are shown only while it is trusted (and only those taken in its epoch)
    // One read of the clock for the line and the values below
    let clock = clock_epoch(home);
    let usable = match clock {
        EpochRead::Read {
            epoch,
            trusted: true,
            in_flight: None,
        } => Some(epoch),
        _ => None,
    };
    println!(
        "Clock: {}",
        match clock {
            EpochRead::Read {
                in_flight: Some(_), ..
            } => "a send's result is pending (values held back until it is saved)",
            EpochRead::Read { trusted: true, .. } => "trusted",
            EpochRead::Read { .. } =>
                "refused by the destination (values held back until a send goes through)",
            EpochRead::Missing => "not set up yet (the background agent sets it up)",
            EpochRead::Unreadable => "clock-epoch.json can't be read (values held back)",
        }
    );
    match agent::read_snapshot_at(home, usable) {
        Some(mut s) => {
            s.providers = crate::push::trusted_local_at(
                home,
                &s.providers,
                now_ms(),
                pushing,
                usable.is_some(),
            );
            println!(
                "snapshot.json:\n{}",
                serde_json::to_string_pretty(&s).unwrap_or_default()
            )
        }
        None => println!("snapshot.json: not yet"),
    }
    if let Some(v) = read_json::<serde_json::Value>(&home.join("state-claude.json")) {
        println!(
            "{}",
            provider_status_line(
                "claude",
                v["failures"].as_u64().unwrap_or(0),
                v["last_error"].as_str().unwrap_or("none"),
                &planned_check(plan.as_ref(), "claude", running, None),
            )
        );
    }
    // Whether Codex is enabled comes from the running agent's schedule, not from config.toml (which may have changed
    // since the agent started, or be mid-edit), so only the state-based reason is taken from the provider
    if let Some(s) = CodexProvider::status_parts(home, &config::CodexConfig::default()) {
        let next = planned_check(plan.as_ref(), "codex", running, s.not_scheduled);
        println!(
            "{}",
            provider_status_line("codex", s.failures.into(), s.last_error, &next)
        );
    }
    match Pusher::status_line(home) {
        Some(line) => println!("{line}"),
        None => {
            println!("Push: not yet (set url under [push] in config.toml and the agent will send)")
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::cell::Cell;
    use std::rc::Rc;

    /// A provider that counts its fetches and acceptances, and can run a step while fetching (the agent saving a refusal)
    struct Counting {
        id: &'static str,
        fetches: Rc<Cell<u32>>,
        accepted: Rc<Cell<u32>>,
        during: Option<Box<dyn Fn()>>,
    }

    impl crate::providers::Provider for Counting {
        fn id(&self) -> &'static str {
            self.id
        }
        fn next_due_ms(&self, now: i64) -> i64 {
            now
        }
        fn collect(&mut self, _now: i64, _force: bool) -> crate::schema::ProviderSnapshot {
            self.fetches.set(self.fetches.get() + 1);
            if let Some(f) = &self.during {
                f();
            }
            crate::schema::ProviderSnapshot::empty(crate::schema::ProviderStatus::Ok, "", None)
        }
        fn accept_account(&mut self) {
            self.accepted.set(self.accepted.get() + 1);
        }
    }

    type Counted = (
        Box<dyn crate::providers::Provider>,
        Rc<Cell<u32>>,
        Rc<Cell<u32>>,
    );

    fn counting(id: &'static str, during: Option<Box<dyn Fn()>>) -> Counted {
        let (f, a) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
        (
            Box::new(Counting {
                id,
                fetches: f.clone(),
                accepted: a.clone(),
                during,
            }),
            f,
            a,
        )
    }

    #[test]
    fn g3_i_what_is_shown_follows_the_clock_read_once_for_the_decision() {
        let home = crate::test_util::TempHome::new("headroom-cli-shown-once");
        crate::test_util::trust_clock(&home);
        let epoch = usable_epoch(&home).unwrap();
        let values = BTreeMap::from([(
            "claude".to_string(),
            crate::schema::ProviderSnapshot::empty(crate::schema::ProviderStatus::Ok, "", None),
        )]);
        agent::write_snapshot(&home, &values, 0, "pc", Some(epoch)).unwrap();
        // decided as refused: nothing comes out, though the clock now reads as trusted
        assert!(
            agent::read_snapshot_at(&home, None)
                .unwrap()
                .providers
                .is_empty()
        );
        assert_eq!(
            agent::read_snapshot_at(&home, Some(epoch))
                .unwrap()
                .providers
                .len(),
            1
        );
        assert_eq!(
            agent::read_snapshot_at(&home, Some(epoch + 1))
                .unwrap()
                .providers
                .len(),
            0
        );
    }

    #[test]
    fn g3_a_a_refusal_saved_while_fetching_stops_the_next_provider_and_drops_the_value() {
        let refused = Rc::new(Cell::new(false));
        let r = refused.clone();
        let (claude, claude_fetches, _) = counting("claude", Some(Box::new(move || r.set(true))));
        let (codex, codex_fetches, _) = counting("codex", None);
        let check = {
            let r = refused.clone();
            move || r.get()
        };
        assert!(
            collect_providers(vec![claude, codex], None, false, false, &check).is_none(),
            "the value fetched across it is not used"
        );
        assert_eq!((claude_fetches.get(), codex_fetches.get()), (1, 0));
    }

    #[test]
    fn g3_a_a_refusal_saved_just_before_accepting_stops_the_acceptance_and_the_fetch() {
        let (codex, fetches, accepted) = counting("codex", None);
        assert!(collect_providers(vec![codex], Some("codex"), false, true, &|| true).is_none());
        assert_eq!(
            (accepted.get(), fetches.get()),
            (0, 0),
            "the switch stays pending"
        );
    }

    #[test]
    fn g3_c_on_a_fixed_clock_a_named_provider_is_accepted_and_fetched() {
        let (codex, fetches, accepted) = counting("codex", None);
        let (claude, claude_fetches, _) = counting("claude", None);
        let got =
            collect_providers(vec![claude, codex], Some("codex"), false, true, &|| false).unwrap();
        assert_eq!(
            (accepted.get(), fetches.get(), claude_fetches.get()),
            (1, 1, 0)
        );
        assert!(got.contains_key("codex"));
    }

    fn temp_home(label: &str) -> std::path::PathBuf {
        let home =
            std::env::temp_dir().join(format!("headroom-cli-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        home
    }

    #[test]
    fn g3_a_an_acceptance_holds_the_clock_lock_from_its_check_to_its_end() {
        let home = temp_home("accept-lock");
        // what the agent saving a refusal would find while the provider accepts and fetches
        let busy = Rc::new(Cell::new(None));
        let (b, h) = (busy.clone(), home.clone());
        let probe = move || {
            let lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(h.join(crate::push::CLOCK_LOCK_FILE))
                .unwrap();
            b.set(Some(matches!(
                lock.try_lock(),
                Err(std::fs::TryLockError::WouldBlock)
            )));
        };
        let (codex, fetches, accepted) = counting("codex", Some(Box::new(probe.clone())));
        let got = run_collect(&home, true, || vec![codex], Some("codex"), false, true);
        assert!(matches!(got, Collected::Done(..)));
        assert_eq!(
            (accepted.get(), fetches.get(), busy.get()),
            (1, 1, Some(true)),
            "a refusal can't be saved between the check and the acceptance"
        );
        // control: a plain collect doesn't hold it (the agent isn't kept waiting by a fetch; what was fetched across a refusal is dropped)
        let (codex, _, _) = counting("codex", Some(Box::new(probe)));
        assert!(matches!(
            run_collect(&home, true, || vec![codex], None, false, false),
            Collected::Done(..)
        ));
        assert_eq!(busy.get(), Some(false));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn g3_d_without_pushing_a_refusal_is_lifted_only_while_no_background_agent_runs() {
        let home = temp_home("lift-local");
        crate::test_util::trust_clock(&home);
        {
            let _lock = crate::push::hold_clock_lock(&home).unwrap();
            let state = crate::clock::ensure_locked(&home, || Ok(false)).unwrap();
            crate::clock::advance_locked(&home, &state, false).unwrap();
        }
        // an agent started with the earlier settings (which pushed) still runs: not lifted, nothing fetched or accepted
        let agent = crate::install::hold_agent_lock(&home).unwrap();
        let (codex, fetches, accepted) = counting("codex", None);
        assert!(matches!(
            run_collect(&home, false, || vec![codex], None, false, true),
            Collected::Unlocked(_)
        ));
        assert_eq!((fetches.get(), accepted.get()), (0, 0));
        assert_eq!(usable_epoch(&home), None, "still refused");
        // the agent is gone: lifted under a new epoch, and the collect runs
        drop(agent);
        let (codex, fetches, _) = counting("codex", None);
        assert!(matches!(
            run_collect(&home, false, || vec![codex], None, false, false),
            Collected::Done(..)
        ));
        assert_eq!(fetches.get(), 1);
        assert!(usable_epoch(&home).is_some());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn g3_f_a_refusal_and_its_lifting_both_within_a_fetch_drop_its_value_and_stop_the_rest() {
        let home = temp_home("across");
        crate::test_util::trust_clock(&home);
        let h = home.clone();
        // while Claude fetches, the agent saves a refusal and then lifts it (two new epochs)
        let both = move || {
            for trusted in [false, true] {
                let _lock = crate::push::hold_clock_lock(&h).unwrap();
                let state = crate::clock::ensure_locked(&h, || Ok(false)).unwrap();
                crate::clock::advance_locked(&h, &state, trusted).unwrap();
            }
        };
        let (claude, claude_fetches, _) = counting("claude", Some(Box::new(both)));
        let (codex, codex_fetches, _) = counting("codex", None);
        let got = run_collect(&home, true, || vec![claude, codex], None, false, false);
        assert!(matches!(got, Collected::Stopped), "{got:?}");
        assert_eq!((claude_fetches.get(), codex_fetches.get()), (1, 0));
        // the control: the epoch stays, both are used
        let (claude, _, _) = counting("claude", None);
        let (codex, _, _) = counting("codex", None);
        let got = run_collect(&home, true, || vec![claude, codex], None, false, false);
        assert!(matches!(got, Collected::Done(ref r, _) if r.len() == 2));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn g3_a_an_earlier_push_state_that_cant_be_read_runs_nothing() {
        let home = temp_home("unreadable");
        std::fs::write(home.join(crate::push::OUTBOX_FILE), "{broken").unwrap();
        let (codex, fetches, accepted) = counting("codex", None);
        let got = run_collect(&home, true, || vec![codex], Some("codex"), false, true);
        assert!(
            matches!(got, Collected::Unlocked(_)),
            "no clock state made on a guess"
        );
        assert_eq!((accepted.get(), fetches.get()), (0, 0));
        // a refused clock runs nothing either
        let refused = temp_home("refused");
        crate::test_util::trust_clock(&refused);
        {
            let _lock = crate::push::hold_clock_lock(&refused).unwrap();
            let state = crate::clock::ensure_locked(&refused, || Ok(false)).unwrap();
            crate::clock::advance_locked(&refused, &state, false).unwrap();
        }
        let (codex, fetches, _) = counting("codex", None);
        let got = run_collect(&refused, true, || vec![codex], None, false, false);
        assert!(matches!(
            got,
            Collected::Refused(EpochRead::Read { trusted: false, .. })
        ));
        assert_eq!(fetches.get(), 0);
        let _ = std::fs::remove_dir_all(&refused);
        // control: without pushing there is no refusal to read
        let (codex, fetches, _) = counting("codex", None);
        assert!(matches!(
            run_collect(&home, false, || vec![codex], None, false, false),
            Collected::Done(..)
        ));
        assert_eq!(fetches.get(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn status_uses_only_the_current_sessions_schedule() {
        let home =
            std::env::temp_dir().join(format!("headroom-status-schedule-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let providers = BTreeMap::from([(
            "codex".to_string(),
            NextRun {
                at_ms: Some(1_800_000_000_000),
                waiting: None,
                disabled: false,
            },
        )]);
        let schedule = |session: &str| Schedule {
            session: session.into(),
            providers: providers.clone(),
        };
        // A crashed agent left both files of session "old"
        crate::store::write_json_atomic(&home.join(SCHEDULE_FILE), &schedule("old")).unwrap();
        std::fs::write(home.join(SESSION_FILE), "old").unwrap();
        assert_eq!(current_schedule(&home), None, "nobody holds the lock");
        // A new agent is publishing session "new": ID written, lock not taken yet
        std::fs::write(home.join(SESSION_FILE), "new").unwrap();
        assert_eq!(current_schedule(&home), None);
        // Lock taken: the leftover schedule carries another ID
        let held = crate::agent::hold_session_lock(&home).unwrap();
        assert_eq!(current_schedule(&home), None);
        // Written by the running one
        crate::store::write_json_atomic(&home.join(SCHEDULE_FILE), &schedule("new")).unwrap();
        assert_eq!(current_schedule(&home), Some(providers.clone()));
        // Its writer is gone (crashed) and both files remain, e.g. while an older agent version runs: not used
        drop(held);
        assert_eq!(current_schedule(&home), None);
        // Another `status` probing at the same moment (shared lock) is not mistaken for the agent
        let other_status = std::fs::File::open(home.join(SESSION_LOCK_FILE)).unwrap();
        other_status.try_lock_shared().unwrap();
        assert_eq!(current_schedule(&home), None);
        drop(other_status);
        // No session lock file (e.g. an older agent version): not used
        std::fs::remove_file(home.join(SESSION_LOCK_FILE)).unwrap();
        assert_eq!(current_schedule(&home), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn next_check_text() {
        let run = |at_ms, disabled| NextRun {
            at_ms,
            waiting: None,
            disabled,
        };
        let plan = BTreeMap::from([
            ("claude".to_string(), run(None, false)),
            ("codex".to_string(), run(None, true)),
        ]);
        assert_eq!(
            planned_check(Some(&plan), "claude", false, None),
            "none (agent stopped)"
        );
        assert_eq!(
            planned_check(None, "claude", true, None),
            "unknown (no schedule from the running agent)"
        );
        assert_eq!(
            planned_check(
                Some(&plan),
                "claude",
                true,
                Some("waiting for manual resume")
            ),
            "none (waiting for manual resume)"
        );
        assert_eq!(
            planned_check(Some(&plan), "claude", true, None),
            "none (not scheduled)"
        );
        assert_eq!(
            planned_check(
                Some(&plan),
                "codex",
                true,
                Some("waiting for manual resume")
            ),
            "none (disabled)"
        );
    }

    #[test]
    fn accept_account_requires_a_valid_provider() {
        assert_eq!(
            parse_collect_args(&args(&["--provider", "codex", "--accept-account"])),
            Ok(CollectArgs {
                provider: Some("codex"),
                force: false,
                accept_account: true
            })
        );
        assert!(
            parse_collect_args(&args(&["--accept-account"])).is_err(),
            "omitting the provider is rejected"
        );
        assert!(parse_collect_args(&args(&["--provider", "claud", "--accept-account"])).is_err());
        assert!(parse_collect_args(&args(&["--provider"])).is_err());
        assert!(
            parse_collect_args(&args(&["--provider", "claude", "--provider", "codex"])).is_err()
        );
        assert!(
            parse_collect_args(&args(&["--accept"])).is_err(),
            "unknown arguments are rejected"
        );
        assert_eq!(
            parse_collect_args(&args(&["--force"])),
            Ok(CollectArgs {
                provider: None,
                force: true,
                accept_account: false
            })
        );
    }

    #[test]
    fn invalid_collect_args_change_no_provider_state() {
        let home =
            std::env::temp_dir().join(format!("headroom-collect-args-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(collect(&args(&["--accept-account"]), &home), 2);
        assert!(!home.join("state-claude.json").exists());
        assert!(!home.join("state-codex.json").exists());
        let _ = std::fs::remove_dir_all(&home);
    }
}
