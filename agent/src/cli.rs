//! Command dispatch.

use std::collections::BTreeMap;

use crate::agent;
use crate::config::{self, Config, collector_id, headroom_home};
use crate::providers::codex::CodexProvider;
use crate::push::{Credentials, EpochRead, OsCredentialStore, Pusher, clock_epoch, usable_epoch};
use crate::requests::{self, Account, Finish, REQUEST_WAIT_MS, Request, RequestOutcome, Seen};
use crate::schedule::{
    Coordinator, NextRun, SCHEDULE_FILE, SESSION_FILE, SESSION_LOCK_FILE, Schedule,
};
use crate::schema::build_snapshot;
use crate::store::{Logger, read_json};
use crate::time::now_ms;

const HELP: &str = "headroom — background agent that collects Claude / Codex / Gemini usage limits

Usage:
  headroom agent                          Run in the background (on Windows, use headroomw.exe)
  headroom statusline [--then \"<cmd>\"]    Called from Claude Code's statusLine
  headroom statusline --gemini [--then \"<cmd>\"]
                                          Called from the Antigravity CLI's statusLine (keeps only a hash of the account)
  headroom collect [--provider claude|codex|gemini] [--force] [--accept-account | --same-account]
                  [--resume-access <stop>] [--replace <attempt>] | --result <request>
                                          Fetch once, as the agent would, and print the result (asks the running agent)
                                          (--force ignores the plan; nothing uses any quota)
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
    "Usage: headroom collect [--provider claude|codex|gemini] [--force] [--accept-account | --same-account]
       headroom collect --provider claude|codex|gemini --resume-access <stop> [--force]
       headroom collect [--provider ...] (--force | --resume-access <stop>) --replace <attempt>
       headroom collect --result <request>
       headroom collect --reset-fetch-state
  Asks the background agent to fetch (start it first) and waits up to 2 minutes in all: when the plan allows, and (with push set up)
  only on the destination's go. It prints the agent's values afterwards; it exits 1 when something asked for wasn't done
  --force fetches now (also after a safety stop), still not past another fetch in progress, a rate limit or an access denial
  --accept-account requires --provider (name exactly one provider to resume)
  --same-account (Gemini only) resumes after the limits changed, keeping the history (a plan change of the same account)
  --resume-access <stop> requires --provider: after the service denied access, check the account, then try once to fetch
    again (headroom status names the stop; add --force when a safety stop shows too)
  --replace <attempt> requires --provider: after checking a fetch attempt whose result is unknown, replace it (headroom status
    names it)
  --result <request> shows the result of a collect the agent was still doing when this command stopped waiting
  --reset-fetch-state starts schedule-plan.json anew when it can't be read on a PC without push (its stops are gone with it)";

#[derive(Debug, PartialEq, Eq)]
struct CollectArgs {
    provider: Option<&'static str>,
    force: bool,
    accept_account: bool,
    same_account: bool,
    /// `--resume-access <stop>`: the stop the user checked
    resume: Option<u64>,
    /// `--replace <attempt>`: the attempt whose result is unknown that the user checked
    replace: Option<String>,
    /// `--result <request>`
    result: Option<String>,
    reset_fetch_state: bool,
}

use crate::requests::is_id;

/// Validates the collect arguments. On invalid input nothing is run.
fn parse_collect_args(args: &[String]) -> Result<CollectArgs, String> {
    let mut out = CollectArgs {
        provider: None,
        force: false,
        accept_account: false,
        same_account: false,
        resume: None,
        replace: None,
        result: None,
        reset_fetch_state: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--force" => out.force = true,
            "--accept-account" => out.accept_account = true,
            "--same-account" => out.same_account = true,
            "--reset-fetch-state" => out.reset_fetch_state = true,
            "--resume-access" => {
                out.resume = Some(
                    it.next()
                        .and_then(|v| v.parse::<u64>().ok())
                        .filter(|&n| n > 0)
                        .ok_or(
                            "--resume-access needs the stop's number (headroom status names it)",
                        )?,
                );
            }
            "--replace" => {
                out.replace = Some(
                    it.next()
                        .filter(|v| is_id(v))
                        .ok_or("--replace needs the attempt's 16 hex digits (headroom status names it)")?
                        .clone(),
                );
            }
            "--result" => {
                out.result = Some(
                    it.next()
                        .filter(|v| is_id(v))
                        .ok_or("--result needs the request's 16 hex digits")?
                        .clone(),
                );
            }
            "--provider" => {
                if out.provider.is_some() {
                    return Err("--provider was given twice".into());
                }
                out.provider = Some(match it.next().map(String::as_str) {
                    Some("claude") => "claude",
                    Some("codex") => "codex",
                    Some("gemini") => "gemini",
                    Some(other) => return Err(format!("Unknown provider: {other}")),
                    None => return Err("--provider needs a value".into()),
                });
            }
            other => return Err(format!("Unknown argument: {other}")),
        }
    }
    if out.accept_account && out.provider.is_none() {
        return Err("--accept-account requires --provider claude, codex or gemini".into());
    }
    if out.same_account && out.provider.is_none() {
        return Err("--same-account requires --provider claude, codex or gemini".into());
    }
    if out.same_account && out.accept_account {
        return Err("Give either --accept-account or --same-account".into());
    }
    if out.resume.is_some() && out.provider.is_none() {
        return Err("--resume-access requires --provider claude, codex or gemini".into());
    }
    if out.replace.is_some() && !out.force && out.resume.is_none() {
        return Err("--replace goes with --force or --resume-access".into());
    }
    if out.replace.is_some() && out.provider.is_none() {
        return Err("--replace requires --provider claude, codex or gemini".into());
    }
    if out.reset_fetch_state && args.len() > 1 {
        return Err("--reset-fetch-state goes alone".into());
    }
    if out.result.is_some() && args.len() > 2 {
        return Err("--result goes alone".into());
    }
    Ok(out)
}

/// A new request id (16 hex digits from the time, the process and the monotonic clock; nothing of an account)
fn new_request_id() -> String {
    let marker = 0u8;
    crate::store::fnv1a_hex(&[
        "collect",
        &now_ms().to_string(),
        &std::process::id().to_string(),
        &format!("{:p}", &marker),
        &format!("{:?}", std::time::Instant::now()),
    ])
}

/// The account switch waiting for a provider: its own mark, read from its saved state (None: nothing waits). One whose on or off the
/// running agent decides at its start is read as well (built only to read what it saved; the agent answers if it runs it turned off)
fn pending_switch_of(home: &std::path::Path, cfg: &Config, id: &str, log: &Logger) -> Option<i64> {
    agent::make_providers(home, &agent::reading_saved(cfg, id), log)
        .into_iter()
        .find(|p| p.id() == id)
        .and_then(|p| p.pending_switch())
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
    if let Some(id) = &parsed.result {
        return show_result(home, id);
    }
    let cfg = match config::load(home) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let pushing = !cfg.push.url.trim().is_empty();
    let log = Logger::stderr();
    if parsed.reset_fetch_state {
        // Only while no agent runs (it would write its own state over it)
        let _lock = match crate::install::hold_agent_lock(home) {
            Ok(lock) => lock,
            Err(e) => {
                eprintln!("{e}");
                return 1;
            }
        };
        let mut coord = Coordinator::with_plan(
            cfg.schedule.clone(),
            log,
            home,
            &crate::store::schedule_seed(home, &collector_id(&cfg), true),
            pushing,
        );
        return if coord.reset() {
            eprintln!("The fetch state was started anew");
            0
        } else {
            eprintln!("Couldn't start the fetch state anew (see the messages above)");
            1
        };
    }
    // A provider named but turned off: said so before anything runs (whatever the clock state). One whose on or off the agent decides at
    // its start is asked of the agent (it answers if it's off)
    if let Some(id) = parsed.provider
        && !agent::provider_enabled(&cfg, id)
        && !agent::decided_at_start(&cfg, id)
    {
        eprintln!("{id} is turned off in config.toml (set enabled = true under [{id}] to use it)");
        return 1;
    }
    // Only the running agent does a round: it is asked through a request. The wait counts all in all, on the monotonic clock
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(REQUEST_WAIT_MS as u64);
    let session = loop {
        if let Some(s) = crate::install::session_of(home) {
            break s;
        }
        if !crate::install::agent_running(home) {
            eprintln!(
                "The background agent isn't running, so nothing was done. Start it (headroom start), then collect again"
            );
            return 1;
        }
        if std::time::Instant::now() >= deadline {
            eprintln!(
                "The background agent is busy (starting, or another command holds it); nothing was done. Try again"
            );
            return 1;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let account = if parsed.accept_account {
        Account::Accept
    } else if parsed.same_account {
        Account::Same
    } else {
        Account::Keep
    };
    // The switch the user saw pending (the provider's own mark, read from its saved state): only that one is accepted
    let accept_target = match (account, parsed.provider) {
        (Account::Keep, _) | (_, None) => None,
        (_, Some(id)) => pending_switch_of(home, &cfg, id, &log),
    };
    if account != Account::Keep && accept_target.is_none() {
        eprintln!(
            "Nothing waits to be accepted for {} (see headroom status); nothing was done",
            parsed.provider.unwrap_or("that provider")
        );
        return 1;
    }
    let req = Request {
        id: new_request_id(),
        session: session.clone(),
        created_ms: now_ms(),
        provider: parsed.provider.map(str::to_string),
        force: parsed.force,
        resume: parsed.resume,
        replace: parsed.replace,
        account,
        accept_target,
    };
    if let Err(e) = requests::publish(home, &req, || {
        crate::install::session_of(home).as_deref() == Some(session.as_str())
    }) {
        eprintln!("{e}");
        return 1;
    }
    eprintln!(
        "Asked the background agent (request {}); waiting up to 2 minutes",
        req.id
    );
    loop {
        if let Seen::Ended(out) = requests::look(home, &req.id) {
            return print_outcome(home, &cfg, &out);
        }
        if std::time::Instant::now() >= deadline {
            if requests::withdraw(home, &req.id) {
                eprintln!(
                    "The agent didn't take the request in time; it was withdrawn and nothing was done"
                );
                return 1;
            }
            match requests::look(home, &req.id) {
                Seen::Ended(out) => return print_outcome(home, &cfg, &out),
                Seen::Waiting => eprintln!(
                    "The request couldn't be withdrawn now, so the agent may still do it; see later with: headroom collect --result {id}",
                    id = req.id
                ),
                Seen::Taken if crate::install::session_of(home).is_some() => eprintln!(
                    "The agent is still doing request {id}; see its result with: headroom collect --result {id}",
                    id = req.id
                ),
                Seen::Taken => eprintln!(
                    "The background agent stopped while doing request {id}: it ends as unknown when the agent starts again (see headroom status)",
                    id = req.id
                ),
                Seen::None => eprintln!(
                    "No result for request {id}: the background agent may have stopped while doing it (see headroom status)",
                    id = req.id
                ),
            }
            return 1;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
}

/// `collect --result <id>`: where the request stands, and what it did once it ended (shown again until its result is a day old)
fn show_result(home: &std::path::Path, id: &str) -> i32 {
    match requests::look(home, id) {
        Seen::Ended(out) => {
            let cfg = config::load(home).unwrap_or_default();
            print_outcome(home, &cfg, &out)
        }
        Seen::Waiting => {
            eprintln!("Request {id} waits for the background agent to take it");
            1
        }
        Seen::Taken if crate::install::session_of(home).is_some() => {
            eprintln!("The background agent is doing request {id}");
            1
        }
        Seen::Taken => {
            eprintln!(
                "The background agent stopped while doing request {id}: it ends as unknown when the agent starts again (see headroom status)"
            );
            1
        }
        Seen::None => {
            eprintln!("No result for request {id} (results are kept for a day)");
            1
        }
    }
}

/// The agent's values as they may be shown now (snapshot.json under one read of the clock, held back as the push state says), of the
/// provider named or all
pub(crate) fn shown_now(
    home: &std::path::Path,
    cfg: &Config,
    only: Option<&str>,
) -> BTreeMap<String, crate::schema::ProviderSnapshot> {
    let pushing = !cfg.push.url.trim().is_empty()
        || config::load(home).map_or(true, |c| !c.push.url.trim().is_empty());
    let usable = usable_epoch(home);
    let providers: BTreeMap<_, _> = agent::read_snapshot_at(home, usable)
        .map(|s| s.providers)
        .unwrap_or_default()
        .into_iter()
        .filter(|(id, _)| only.is_none_or(|o| o == id))
        .collect();
    crate::push::trusted_local_at(home, &providers, now_ms(), pushing, usable.is_some())
}

/// Prints what a manual collect did (its notes), then the agent's values now. Non-zero unless everything asked for was done
fn print_outcome(home: &std::path::Path, cfg: &Config, out: &RequestOutcome) -> i32 {
    for note in &out.notes {
        eprintln!("{note}");
    }
    if out.refused {
        // Nothing was run (no fetch, no sign-in check, no account acceptance): anything done then would be stamped by that clock
        eprintln!(
            "{}",
            match clock_epoch(home) {
                EpochRead::Read {
                    in_flight: Some(_), ..
                } =>
                    "Not fetched: the result of a send is pending (the destination may have refused this PC's clock). The background agent saves it; collect again after that",
                EpochRead::Read { trusted: false, .. } =>
                    "Not fetched: the destination refuses this PC's clock. Set the clock automatically (sync it), then collect again",
                EpochRead::Read { .. } =>
                    "Not fetched: the destination refuses this agent (update it), or its push state can't be read (see headroom status)",
                _ =>
                    "Not fetched: the clock state (clock-epoch.json) can't be read (see headroom status)",
            }
        );
    }
    let snapshot = build_snapshot(
        shown_now(home, cfg, out.provider.as_deref()),
        now_ms(),
        &collector_id(cfg),
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&snapshot).unwrap_or_default()
    );
    if out.finish == Finish::Done && out.ok {
        0
    } else {
        1
    }
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

/// A provider's line from its own state file (failures and last error): None when it has none yet. One that is there but can't be
/// read, or isn't a state at all (not an object: the provider finds it corrupt too), says so, not as no failure; for a
/// provider turned off, nothing (its old file isn't used)
fn state_file_line(
    home: &std::path::Path,
    id: &str,
    file: &str,
    enabled: Option<bool>,
    next_check: &str,
) -> Option<String> {
    let path = home.join(file);
    if matches!(path.try_exists(), Ok(false)) {
        return None;
    }
    Some(
        match read_json::<serde_json::Value>(&path).filter(serde_json::Value::is_object) {
            None if enabled == Some(false) => return None,
            Some(v) => provider_status_line(
                id,
                v["failures"].as_u64().unwrap_or(0),
                v["last_error"].as_str().unwrap_or("none"),
                next_check,
            ),
            None => format!(
                "{id}: unknown consecutive failures / last error {file} can't be read now (if this stays, check the Headroom folder's permissions) / next check {next_check}"
            ),
        },
    )
}

/// When the running agent next checks the provider (schedule.json written by the current agent process).
/// `unscheduled_reason` explains a check with no time when the provider knows why (e.g. waiting for a manual resume)
/// Whether a provider is turned on: while an agent runs, as its schedule has it (the config it started with; None before it wrote one,
/// as config.toml may have changed since it started); with none running, as config.toml says (None when it can't be read)
fn provider_on(
    plan: Option<&BTreeMap<String, NextRun>>,
    running: bool,
    cfg: Option<&config::Config>,
    id: &str,
) -> Option<bool> {
    if running {
        return plan.map(|p| p.get(id).is_some_and(|r| !r.disabled));
    }
    cfg.map(|c| agent::provider_enabled(c, id))
}

fn planned_check(
    plan: Option<&BTreeMap<String, NextRun>>,
    id: &str,
    running: bool,
    unscheduled_reason: Option<&str>,
) -> String {
    if !running {
        // A stop shows with what resumes it (the plan given is then the stopped agent's stops)
        return match plan.and_then(|p| p.get(id)) {
            Some(run) if run.waiting.is_some() => {
                let text = run.describe_for(id);
                format!(
                    "none (agent stopped){}",
                    text.strip_prefix("none").unwrap_or(&text)
                )
            }
            _ => "none (agent stopped)".into(),
        };
    }
    match plan.and_then(|p| p.get(id)) {
        None => "unknown (no schedule from the running agent)".into(),
        Some(run) if run.at_ms.is_none() && !run.disabled && !run.stopped() => {
            match unscheduled_reason {
                Some(reason) => format!("none ({reason})"),
                None => run.describe_for(id),
            }
        }
        Some(run) => run.describe_for(id),
    }
}

/// The lines of the providers without one from their own state: a stop the fetch state holds, and a provider turned on whose state
/// isn't written yet (before its first fetch on this PC, as when another PC took that fetch: its next check and why show all the same)
fn unlisted_lines(
    listed: &[&str],
    source: Option<&BTreeMap<String, NextRun>>,
    running: bool,
    on: impl Fn(&str) -> Option<bool>,
) -> Vec<String> {
    crate::providers::PROVIDER_IDS
        .into_iter()
        .filter(|id| !listed.contains(id))
        .filter(|id| {
            on(id) == Some(true)
                || source
                    .and_then(|p| p.get(*id))
                    .is_some_and(NextRun::stopped)
        })
        .map(|id| provider_status_line(id, 0, "none", &planned_check(source, id, running, None)))
        .collect()
}

/// The `Fetch interval` line: each provider's interval, and the stretches only where they are longer than it
fn interval_line(intervals: &BTreeMap<String, i64>, idle: (i64, i64)) -> String {
    let parts: Vec<String> = intervals
        .iter()
        .map(|(id, m)| {
            let stretch: Vec<String> = [idle.0, idle.1]
                .iter()
                .filter(|&&x| x > *m)
                .map(|x| x.to_string())
                .collect();
            if stretch.is_empty() {
                format!("{id} {m} min")
            } else {
                format!(
                    "{id} {m} min (stretched to {} min while nothing changes)",
                    stretch.join(" and ")
                )
            }
        })
        .collect();
    format!(
        "Fetch interval: {} (±20 %; at least {} min)",
        parts.join(", "),
        crate::config::MIN_INTERVAL_MIN
    )
}

/// The running agent's schedule, only if its writer is still running and it carries that writer's session ID.
/// The agent holds an exclusive lock on SESSION_LOCK_FILE while it runs. This only probes it with a shared lock, so
/// concurrent `status` runs never block each other: if the probe succeeds, the writer is gone (e.g. it crashed and an
/// older agent version now runs), and the files it left are not used
/// The stops a stopped agent left in its fetch state (an access denial, an attempt whose result is unknown, a state that can't be
/// read), read only. None without config.toml
fn stopped_plan(home: &std::path::Path) -> Option<BTreeMap<String, NextRun>> {
    let cfg = config::load(home).ok()?;
    // Read only: the seed the agent keeps, never made here
    let coord = Coordinator::with_plan(
        cfg.schedule.clone(),
        Logger::stderr(),
        home,
        &crate::store::schedule_seed(home, &collector_id(&cfg), false),
        !cfg.push.url.trim().is_empty(),
    );
    let now = now_ms();
    Some(
        crate::providers::PROVIDER_IDS
            .iter()
            .map(|id| (id.to_string(), coord.next_run(id, i64::MAX, now)))
            .filter(|(_, run)| run.waiting.is_some())
            .collect(),
    )
}

fn current_schedule(home: &std::path::Path) -> Option<BTreeMap<String, NextRun>> {
    current_run(home).map(|s| s.providers)
}

/// What the running agent wrote for `status` (see current_schedule)
fn current_run(home: &std::path::Path) -> Option<Schedule> {
    let probe = std::fs::File::open(home.join(SESSION_LOCK_FILE)).ok()?;
    match probe.try_lock_shared() {
        Err(std::fs::TryLockError::WouldBlock) => {}
        Ok(()) | Err(std::fs::TryLockError::Error(_)) => return None,
    }
    drop(probe);
    let session = std::fs::read_to_string(home.join(SESSION_FILE)).ok()?;
    let schedule: Schedule = read_json(&home.join(SCHEDULE_FILE))?;
    (!session.is_empty() && schedule.session == session).then_some(schedule)
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
    if !tidy_cached(home, &cfg, &Logger::stderr()) {
        eprintln!(
            "A provider's cached values couldn't be tidied away now (they aren't used); the agent tidies them later"
        );
    }
    result
}

/// The providers tidy what they cached of the epoch before: also one whose on or off the agent decides at its start (its saved state
/// read; nothing of its CLI runs, and no state is made). false if one couldn't now
fn tidy_cached(home: &std::path::Path, cfg: &Config, log: &Logger) -> bool {
    let mut tidied = true;
    for mut p in agent::make_providers(home, &agent::reading_saved(cfg, "gemini"), log) {
        tidied &= p.forget_cached();
    }
    tidied
}

/// Whether status shows Gemini's saved state (its stop, its last error): turned on, or, with no running agent to say, left to the
/// agent's start (config.toml leaves `enabled` out). Never when config.toml turns it off
fn shows_left_out_state(on: Option<bool>, from_agent: bool, left_out: bool) -> bool {
    on == Some(true) || (!from_agent && left_out)
}

fn status(home: &std::path::Path) -> i32 {
    // Running only with its session up (agent.lock alone: an agent starting, or another command holding it)
    let running = crate::install::session_of(home).is_some();
    let locked = !running && crate::install::agent_running(home);
    let plan = if running {
        current_schedule(home)
    } else {
        None
    };
    // While the agent is stopped, its stops (read from the fetch state, never written): what resumes them is shown all the same
    let stops = if running { None } else { stopped_plan(home) };
    println!("HEADROOM_HOME: {}", home.display());
    println!(
        "Agent: {} / Autostart: {}",
        if running {
            "running"
        } else if locked {
            "starting (or another command holds its lock)"
        } else {
            "stopped"
        },
        if crate::install::registered() {
            "registered"
        } else {
            "not registered"
        }
    );
    // Shown as the push state lets it out now (a file written before the latest marks, or by an older version, may hold values a
    // refused clock stamped)
    // config.toml unreadable: held as with push set up (the outbox's marks apply, if it has any)
    let pushing = !matches!(config::load(home), Ok(c) if c.push.url.trim().is_empty());
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
    // On or off as the running agent has it (the config it started with, which config.toml may no longer say); config.toml only while
    // none runs
    let cfg = config::load(home).ok();
    let on = |id: &str| provider_on(plan.as_ref(), running, cfg.as_ref(), id);
    // Providers given a line (a stop the fetch state holds is shown for the others below)
    let mut listed: Vec<&str> = Vec::new();
    if let Some(line) = state_file_line(
        home,
        "claude",
        "state-claude.json",
        on("claude"),
        &planned_check(plan.as_ref().or(stops.as_ref()), "claude", running, None),
    ) {
        listed.push("claude");
        println!("{line}");
    }
    // Whether Codex is enabled comes from the running agent's schedule, not from config.toml (which may have changed
    // since the agent started, or be mid-edit), so only the state-based reason is taken from the provider
    if let Some(s) = CodexProvider::status_parts(home, &config::CodexConfig::default()) {
        listed.push("codex");
        let next = planned_check(
            plan.as_ref().or(stops.as_ref()),
            "codex",
            running,
            s.not_scheduled,
        );
        println!(
            "{}",
            provider_status_line("codex", s.failures.into(), s.last_error, &next)
        );
    }
    // The interval between active fetches each provider uses (jittered ±20 % by the schedule): the running agent's (the config it
    // started with), else the config's
    let effective = match current_run(home).filter(|s| running && !s.intervals.is_empty()) {
        Some(s) => Some((s.intervals, s.idle_min)),
        None => config::load(home).ok().map(|c| {
            let intervals = crate::providers::PROVIDER_IDS
                .iter()
                .filter(|id| agent::provider_enabled(&c, id))
                .map(|id| (id.to_string(), c.interval_min(id)))
                .collect();
            (
                intervals,
                (
                    c.schedule.idle_interval_min,
                    c.schedule.idle_long_interval_min,
                ),
            )
        }),
    };
    if let Some((intervals, idle)) = effective {
        println!("{}", interval_line(&intervals, idle));
    }
    // A provider turned off whose fetch isn't verified everywhere: why it is off and how to turn it on (nothing of its CLI is run)
    let from_agent = running && plan.is_some();
    for id in crate::providers::UNVERIFIED_PROVIDERS {
        let left_out = cfg.as_ref().is_some_and(|c| agent::decided_at_start(c, id));
        let default = agent::default_on_note(id).unwrap_or_default();
        match on(id) {
            Some(true) => {}
            Some(false) if from_agent && left_out => println!(
                "{id}: off ({default}; set enabled = true under [{id}] in config.toml to turn it on; nothing of its CLI is run)"
            ),
            Some(false) if from_agent => {
                println!("{id}: off (turned off in the running agent; nothing of its CLI is run)")
            }
            Some(false) if left_out => println!(
                "{id}: decided when the agent starts ({default}; set enabled under [{id}] in config.toml to choose)"
            ),
            Some(false) => println!(
                "{id}: off ([{id}] enabled = false in config.toml; nothing of its CLI is run)"
            ),
            None if running => println!(
                "{id}: unknown whether it is turned on (the running agent hasn't written its schedule yet)"
            ),
            None => println!("{id}: unknown whether it is turned on (config.toml can't be read)"),
        }
    }
    // Turned on, or (with no agent to say) left to the agent's start: its saved state shows (a stop, its last error)
    let gemini_left_out = cfg
        .as_ref()
        .is_some_and(|c| agent::decided_at_start(c, "gemini"));
    if shows_left_out_state(on("gemini"), from_agent, gemini_left_out)
        && let Some(line) = state_file_line(
            home,
            "gemini",
            "state-gemini.json",
            Some(true),
            &planned_check(plan.as_ref().or(stops.as_ref()), "gemini", running, None),
        )
    {
        listed.push("gemini");
        println!("{line}");
    }
    for line in unlisted_lines(&listed, plan.as_ref().or(stops.as_ref()), running, on) {
        println!("{line}");
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

    #[test]
    fn the_interval_line_shows_a_stretch_only_where_it_is_longer() {
        let intervals = BTreeMap::from([("claude".to_string(), 15), ("codex".to_string(), 120)]);
        assert_eq!(
            interval_line(&intervals, (30, 60)),
            "Fetch interval: claude 15 min (stretched to 30 and 60 min while nothing changes), codex 120 min (±20 %; at least 10 min)"
        );
    }

    use std::cell::Cell;
    use std::rc::Rc;

    /// A provider that queries only when allowed (its hold passed, or forced) and counts its queries and acceptances, saying what it
    /// did. It doesn't take passive values, as Codex: its acceptance needs a query
    struct Counting {
        id: &'static str,
        hold: i64,
        queries: Rc<Cell<u32>>,
        accepted: Rc<Cell<u32>>,
        run: Option<crate::providers::Run>,
    }

    impl crate::providers::Provider for Counting {
        fn id(&self) -> &'static str {
            self.id
        }
        fn next_due_ms(&self, now: i64) -> i64 {
            now.max(self.hold)
        }
        fn hold_fetch_until(&mut self, until_ms: i64) -> bool {
            self.hold = until_ms;
            true
        }
        fn collect(&mut self, now: i64, force: bool) -> crate::schema::ProviderSnapshot {
            self.run = Some(crate::providers::Run::NotRun);
            if force || now >= self.hold {
                self.queries.set(self.queries.get() + 1);
                self.run = Some(crate::providers::Run::Ran(crate::providers::Outcome::Ok));
            }
            let mut s =
                crate::schema::ProviderSnapshot::empty(crate::schema::ProviderStatus::Ok, "", None);
            s.error = None;
            s
        }
        fn take_run(&mut self) -> Option<crate::providers::Run> {
            self.run.take()
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

    fn counting(id: &'static str) -> Counted {
        let (q, a) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
        (
            Box::new(Counting {
                id,
                hold: 0,
                queries: q.clone(),
                accepted: a.clone(),
                run: None,
            }),
            q,
            a,
        )
    }

    /// A manual collect as the CLI makes it, for the agent session "s1"
    fn request(provider: Option<&str>, force: bool, account: Account) -> Request {
        Request {
            id: new_request_id(),
            session: "s1".into(),
            created_ms: now_ms(),
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
    fn what_is_shown_follows_the_clock_read_once_for_the_decision() {
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
        // what a collect shows: the provider named only, under one read of the clock
        let shown = shown_now(&home, &Config::default(), Some("codex"));
        assert!(shown.is_empty());
        assert_eq!(
            shown_now(&home, &Config::default(), Some("claude")).len(),
            1
        );
    }

    #[test]
    fn a_collect_with_no_agent_running_does_nothing() {
        let home = crate::test_util::TempHome::new("headroom-cli-no-agent");
        assert_eq!(
            collect(&args(&["--provider", "claude", "--force"]), &home),
            1
        );
        let names: Vec<String> = std::fs::read_dir(&*home)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            names
                .iter()
                .all(|n| !n.starts_with("collect-") && !n.starts_with("state-")),
            "no request, no fetch: {names:?}"
        );
        assert!(!home.join("schedule-plan.json").exists() && !home.join("outbox.json").exists());
    }

    #[test]
    fn discarding_the_queue_tidies_a_provider_left_to_the_agent_s_start_and_status_shows_its_state_while_stopped()
     {
        let home = crate::test_util::TempHome::new("headroom-cli-tidy-left-out");
        crate::test_util::trust_clock(&home);
        // a value of an epoch gone, saved by Gemini on by default (enabled left out of config.toml)
        crate::providers::gemini::save_test_state(&home, |s| {
            s.last_ok = Some(crate::providers::gemini::Observation {
                epoch: Some(999_999),
                ..Default::default()
            })
        });
        assert!(tidy_cached(&home, &Config::default(), &Logger::stderr()));
        let path = home.join("state-gemini.json");
        assert!(
            crate::providers::gemini::load_state(&path)
                .last_ok
                .is_none(),
            "the old value tidied away"
        );
        // nothing saved: none made
        let empty = crate::test_util::TempHome::new("headroom-cli-tidy-none");
        crate::test_util::trust_clock(&empty);
        assert!(tidy_cached(&empty, &Config::default(), &Logger::stderr()));
        assert!(!empty.join("state-gemini.json").exists());
        assert!(!empty.join("state-gemini.lock").exists(), "nor its lock");
        // status: shown when on, or left out with no running agent to say; never when turned off
        assert!(shows_left_out_state(Some(true), true, false));
        assert!(
            shows_left_out_state(Some(false), false, true),
            "stopped, left out"
        );
        assert!(
            !shows_left_out_state(Some(false), true, true),
            "the running agent turned it off"
        );
        assert!(
            !shows_left_out_state(Some(false), false, false),
            "turned off in config.toml"
        );
    }

    #[test]
    fn a_switch_waiting_for_a_provider_on_by_default_is_found_for_its_acceptance() {
        let home = crate::test_util::TempHome::new("headroom-cli-default-switch");
        crate::providers::gemini::save_test_state(&home, |s| s.account_changed = true);
        let log = Logger::stderr();
        // enabled left out of config.toml (the running agent decides it at its start): the provider's saved mark is read
        assert!(pending_switch_of(&home, &Config::default(), "gemini", &log).is_some());
        // turned off in config.toml: nothing waits
        let mut off = Config::default();
        off.gemini.enabled = Some(false);
        assert_eq!(pending_switch_of(&home, &off, "gemini", &log), None);
        // nothing pending: nothing waits
        crate::providers::gemini::save_test_state(&home, |_| {});
        assert_eq!(
            pending_switch_of(&home, &Config::default(), "gemini", &log),
            None
        );
    }

    #[test]
    fn same_account_is_reported_as_not_used_by_a_provider_that_doesnt_track_its_limits() {
        let home = crate::test_util::TempHome::new("headroom-cli-same");
        crate::test_util::trust_clock(&home);
        // Counting doesn't track its limits (the trait's default): nothing is fetched, and the request fails
        let (codex, queries, _) = counting("codex");
        let mut round =
            agent::Round::new(&Config::default(), "mac", Logger::stderr(), now_ms, &home);
        let (_, out) = round.run_request(
            &mut [codex],
            None,
            &request(Some("codex"), false, Account::Same),
        );
        assert_eq!((queries.get(), out.ok), (0, false));
        assert!(
            out.notes
                .iter()
                .any(|n| n.contains("--same-account isn't used"))
        );
    }

    #[test]
    fn refused_clock_runs_nothing_and_an_acceptance_asked_for_fails() {
        let home = crate::test_util::TempHome::new("headroom-cli-refused");
        crate::test_util::trust_clock(&home);
        {
            let _lock = crate::push::hold_clock_lock(&home).unwrap();
            let state = crate::clock::ensure_locked(&home, || Ok(false)).unwrap();
            crate::clock::advance_locked(&home, &state, false).unwrap();
        }
        // with push set up (the destination refused the clock): nothing is fetched or accepted
        let mut cfg = Config::default();
        cfg.push.url = "https://x.example".into();
        let (codex, queries, accepted) = counting("codex");
        let mut round = agent::Round::new(&cfg, "mac", Logger::stderr(), now_ms, &home);
        let (_, out) = round.run_request(
            &mut [codex],
            None,
            &request(Some("codex"), true, Account::Accept),
        );
        assert_eq!((queries.get(), accepted.get()), (0, 0));
        assert!(out.refused && !out.ok);
        assert_eq!(print_outcome(&home, &cfg, &out), 1);
    }

    #[test]
    fn a_request_is_published_whole_taken_once_withdrawn_only_before_and_ended_when_the_agent_stops()
     {
        let home = crate::test_util::TempHome::new("headroom-cli-requests");
        let log = Logger::stderr();
        let now = now_ms();
        // published only while its session takes requests
        let a = request(Some("claude"), true, Account::Keep);
        assert!(requests::publish(&home, &a, || false).is_err());
        assert_eq!(requests::look(&home, &a.id), Seen::None);
        requests::publish(&home, &a, || true).unwrap();
        assert_eq!(requests::look(&home, &a.id), Seen::Waiting);
        // withdrawn before it is taken: never done
        assert!(requests::withdraw(&home, &a.id));
        assert_eq!(requests::take(&home, "s1", now, &log).0, None);
        // two at once: each taken once, oldest first; one taken isn't withdrawn
        let mut b = request(None, false, Account::Keep);
        b.created_ms = now - 2_000;
        let mut c = request(None, false, Account::Keep);
        c.created_ms = now - 1_000;
        requests::publish(&home, &c, || true).unwrap();
        requests::publish(&home, &b, || true).unwrap();
        let (taken, more) = requests::take(&home, "s1", now, &log);
        assert_eq!((taken.map(|r| r.id), more), (Some(b.id.clone()), true));
        assert!(!requests::withdraw(&home, &b.id));
        assert_eq!(requests::look(&home, &b.id), Seen::Taken);
        // its result, shown again until it is a day old
        requests::finish(
            &home,
            &RequestOutcome {
                id: b.id.clone(),
                ok: true,
                done_ms: now,
                ..RequestOutcome::default()
            },
        )
        .unwrap();
        assert_eq!(show_result(&home, &b.id), 0);
        assert_eq!(show_result(&home, &b.id), 0, "shown again");
        // the agent stops: no request is taken any more, and the one waiting ends as not done
        requests::close(&home, "s1", now, &log);
        assert!(matches!(
            requests::look(&home, &c.id),
            Seen::Ended(RequestOutcome {
                finish: Finish::NotDone,
                ..
            })
        ));
        assert_eq!(show_result(&home, &c.id), 1);
        let d = request(None, false, Account::Keep);
        assert!(requests::publish(&home, &d, || true).is_err(), "closed");
    }

    #[test]
    fn a_request_whose_end_can_t_be_written_stays_and_ends_later() {
        let home = crate::test_util::TempHome::new("headroom-cli-unended");
        let log = Logger::stderr();
        let now = now_ms();
        let mut req = request(None, true, Account::Keep);
        req.session = "old".into();
        req.created_ms = now;
        requests::publish(&home, &req, || true).unwrap();
        // its result can't be written (a folder in its place): the request stays waiting, not lost
        let blocked = home.join(requests::result_file(&req.id));
        std::fs::create_dir(&blocked).unwrap();
        assert_eq!(requests::take(&home, "new", now, &log).0, None);
        assert_eq!(requests::look(&home, &req.id), Seen::Waiting);
        requests::close(&home, "new", now, &log);
        assert_eq!(requests::look(&home, &req.id), Seen::Waiting);
        // once it can be: ended as not done
        std::fs::remove_dir(&blocked).unwrap();
        assert_eq!(requests::take(&home, "other", now, &log).0, None);
        assert!(matches!(
            requests::look(&home, &req.id),
            Seen::Ended(RequestOutcome {
                finish: Finish::NotDone,
                ..
            })
        ));
    }

    #[test]
    fn with_the_config_unreadable_values_are_shown_as_the_push_state_lets_them_out() {
        let home = crate::test_util::TempHome::new("headroom-cli-unreadable-config");
        crate::test_util::trust_clock(&home);
        let at = crate::time::iso_from_ms(now_ms() - 60_000);
        let mut value =
            crate::schema::ProviderSnapshot::empty(crate::schema::ProviderStatus::Ok, "", None);
        let mut window = crate::schema::make_window("five_hour", 10.0, None);
        window.fetched_at = Some(at.clone());
        value.windows = vec![window];
        value.fetched_at = Some(at);
        let values = BTreeMap::from([("claude".to_string(), value)]);
        agent::write_snapshot(&home, &values, now_ms(), "mac", usable_epoch(&home)).unwrap();
        let windows = |home: &std::path::Path| {
            shown_now(home, &Config::default(), None)
                .get("claude")
                .map_or(0, |p| p.windows.len())
        };
        // a push state that can't be read holds everything back
        std::fs::write(home.join(crate::push::OUTBOX_FILE), b"{not json").unwrap();
        assert_eq!(windows(&home), 1, "the control: no push set up");
        // the config can't be read: whether push is set up can't be told, so the push state holds them back
        std::fs::write(home.join("config.toml"), b"[push\nurl = ").unwrap();
        assert_eq!(windows(&home), 0);
    }

    #[test]
    fn a_result_stamped_ahead_of_the_clock_isn_t_kept_longer() {
        let home = crate::test_util::TempHome::new("headroom-cli-future-result");
        let out = RequestOutcome {
            id: "0123456789abcdef".into(),
            ok: true,
            done_ms: now_ms() + 30_000,
            ..RequestOutcome::default()
        };
        requests::finish(&home, &out).unwrap();
        assert_eq!(requests::look(&home, "0123456789abcdef"), Seen::None);
    }

    #[test]
    fn push_set_up_as_the_config_says_now_also_after_a_first_read_failed() {
        let home = crate::test_util::TempHome::new("headroom-cli-config-reread");
        crate::test_util::trust_clock(&home);
        let at = crate::time::iso_from_ms(now_ms() - 60_000);
        let mut value =
            crate::schema::ProviderSnapshot::empty(crate::schema::ProviderStatus::Ok, "", None);
        let mut window = crate::schema::make_window("five_hour", 10.0, None);
        window.fetched_at = Some(at.clone());
        value.windows = vec![window];
        value.fetched_at = Some(at);
        let values = BTreeMap::from([("claude".to_string(), value)]);
        agent::write_snapshot(&home, &values, now_ms(), "mac", usable_epoch(&home)).unwrap();
        std::fs::write(home.join(crate::push::OUTBOX_FILE), b"{not json").unwrap();
        // the caller's first read failed (a default config passed); the config read now sets push up
        std::fs::write(
            home.join("config.toml"),
            b"[push]\nurl = \"https://x.example\"\n",
        )
        .unwrap();
        let shown = shown_now(&home, &Config::default(), None);
        assert_eq!(shown.get("claude").map_or(0, |p| p.windows.len()), 0);
    }

    #[test]
    fn a_result_older_than_a_day_isn_t_shown() {
        let home = crate::test_util::TempHome::new("headroom-cli-old-result");
        let now = now_ms();
        let out = |id: &str, done_ms| RequestOutcome {
            id: id.into(),
            ok: true,
            done_ms,
            ..RequestOutcome::default()
        };
        requests::finish(
            &home,
            &out("0123456789abcdef", now - requests::RESULT_KEEP_MS - 60_000),
        )
        .unwrap();
        assert_eq!(requests::look(&home, "0123456789abcdef"), Seen::None);
        assert_eq!(show_result(&home, "0123456789abcdef"), 1);
        // control: within the day
        requests::finish(
            &home,
            &out("0123456789abcdee", now - requests::RESULT_KEEP_MS + 60_000),
        )
        .unwrap();
        assert!(matches!(
            requests::look(&home, "0123456789abcdee"),
            Seen::Ended(_)
        ));
    }

    #[test]
    fn an_agent_takes_only_a_request_made_for_its_session_and_in_time() {
        let home = crate::test_util::TempHome::new("headroom-cli-take");
        let log = Logger::stderr();
        let place = |session: &str, created_ms: i64| {
            let mut req = request(None, true, Account::Keep);
            req.session = session.into();
            req.created_ms = created_ms;
            requests::publish(&home, &req, || true).unwrap();
            req.id
        };
        let now = now_ms();
        // an earlier agent's leftover --force: ended as not done, never done
        let old = place("old", now);
        assert_eq!(requests::take(&home, "new", now, &log).0, None);
        assert!(matches!(
            requests::look(&home, &old),
            Seen::Ended(RequestOutcome {
                finish: Finish::NotDone,
                ..
            })
        ));
        // too late, or from the future
        place("new", now - REQUEST_WAIT_MS - 1);
        assert_eq!(requests::take(&home, "new", now, &log).0, None);
        place("new", now + 2 * crate::time::MINUTE_MS);
        assert_eq!(requests::take(&home, "new", now, &log).0, None);
        // control
        place("new", now - 1_000);
        assert!(requests::take(&home, "new", now, &log).0.is_some());
    }

    #[test]
    fn a_request_left_taken_by_an_agent_that_stopped_ends_as_unknown_and_old_results_go() {
        let home = crate::test_util::TempHome::new("headroom-cli-tidy");
        let log = Logger::stderr();
        let now = now_ms();
        let a = request(None, true, Account::Keep);
        requests::publish(&home, &a, || true).unwrap();
        assert!(requests::take(&home, "s1", now, &log).0.is_some());
        // a second one taken whose result was written before the agent stopped keeps it
        let b = request(None, false, Account::Keep);
        requests::publish(&home, &b, || true).unwrap();
        assert!(requests::take(&home, "s1", now, &log).0.is_some());
        crate::store::write_json_atomic(
            &home.join(requests::result_file(&b.id)),
            &RequestOutcome {
                id: b.id.clone(),
                ok: true,
                done_ms: now,
                ..RequestOutcome::default()
            },
        )
        .unwrap();
        requests::tidy(&home, now, &log);
        assert!(matches!(
            requests::look(&home, &a.id),
            Seen::Ended(RequestOutcome {
                finish: Finish::Unknown,
                ..
            })
        ));
        assert!(matches!(
            requests::look(&home, &b.id),
            Seen::Ended(RequestOutcome { ok: true, .. })
        ));
        assert!(!home.join(requests::taken_file(&a.id)).exists());
        // a day later both go
        requests::tidy(&home, now + requests::RESULT_KEEP_MS + 1, &log);
        assert_eq!(requests::look(&home, &a.id), Seen::None);
        assert_eq!(requests::look(&home, &b.id), Seen::None);
    }

    #[test]
    fn parse_resume_replace_and_result() {
        let id = "0123456789abcdef";
        assert_eq!(
            parse_collect_args(&args(&[
                "--provider",
                "codex",
                "--resume-access",
                "7",
                "--force",
                "--replace",
                id
            ])),
            Ok(CollectArgs {
                provider: Some("codex"),
                force: true,
                accept_account: false,
                same_account: false,
                resume: Some(7),
                replace: Some(id.into()),
                result: None,
                reset_fetch_state: false
            })
        );
        // the stop's number is required (the user names the one they checked)
        assert!(parse_collect_args(&args(&["--provider", "codex", "--resume-access"])).is_err());
        assert!(
            parse_collect_args(&args(&["--provider", "codex", "--resume-access", "0"])).is_err()
        );
        assert!(parse_collect_args(&args(&["--resume-access", "7"])).is_err());
        // replacing an unknown attempt only with an explicit go, and only by its full id
        assert!(parse_collect_args(&args(&["--replace", id])).is_err());
        assert!(
            parse_collect_args(&args(&[
                "--provider",
                "claude",
                "--force",
                "--replace",
                "0123"
            ]))
            .is_err()
        );
        assert!(
            parse_collect_args(&args(&[
                "--provider",
                "claude",
                "--force",
                "--replace",
                "0123456789ABCDEF"
            ]))
            .is_err()
        );
        assert!(
            parse_collect_args(&args(&["--force", "--replace", id])).is_err(),
            "only for a provider named"
        );
        assert!(
            parse_collect_args(&args(&["--provider", "claude", "--force", "--replace", id]))
                .is_ok()
        );
        assert_eq!(
            parse_collect_args(&args(&["--result", id])).map(|a| a.result),
            Ok(Some(id.into()))
        );
        assert!(parse_collect_args(&args(&["--result", id, "--force"])).is_err());
        assert!(parse_collect_args(&args(&["--reset-fetch-state", "--force"])).is_err());
    }

    #[test]
    fn a_provider_turned_on_before_its_first_fetch_shows_its_next_check_and_why() {
        // a new PC that gave Codex's first fetch to another: no state-codex.json yet, the turn's wait in the agent's schedule
        let turn = NextRun {
            at_ms: Some(1_800_000_000_000),
            waiting: Some(crate::schedule::Waiting::Turn),
            disabled: false,
            stop: None,
            attempt: None,
        };
        let off = NextRun {
            at_ms: None,
            waiting: None,
            disabled: true,
            ..turn
        };
        let plan = BTreeMap::from([("codex".to_string(), turn), ("gemini".to_string(), off)]);
        let on = |id: &str| Some(id != "gemini");
        let lines = unlisted_lines(&["claude"], Some(&plan), true, on);
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].starts_with("codex: "), "{}", lines[0]);
        // the time and why on the same line
        assert!(
            lines[0].ends_with(&format!(
                "next check {} (another PC holds the fetch turn; checks again then)",
                crate::time::iso_from_ms(1_800_000_000_000)
            )),
            "{}",
            lines[0]
        );
        // one with a line of its own isn't given another; one turned off only when stopped
        assert!(unlisted_lines(&["claude", "codex"], Some(&plan), true, on).is_empty());
    }

    #[test]
    fn a_state_file_that_is_there_but_can_t_be_read_says_so_while_the_provider_is_on() {
        let h = crate::test_util::TempHome::new("headroom-status-u43-unread-state");
        let line = |enabled| state_file_line(&h, "claude", "state-claude.json", enabled, "x");
        assert_eq!(line(Some(true)), None, "none yet");
        std::fs::create_dir(h.join("state-claude.json")).unwrap();
        let unread = line(Some(true)).unwrap();
        assert!(unread.contains("unknown consecutive failures"), "{unread}");
        assert!(
            unread.contains("state-claude.json can't be read now"),
            "{unread}"
        );
        assert!(unread.ends_with("next check x"), "{unread}");
        assert_eq!(
            line(None).as_ref(),
            Some(&unread),
            "unknown whether it is on: said too"
        );
        // turned off: its old file isn't used, nothing said
        assert_eq!(line(Some(false)), None);
        // read, but not a state at all: the same (the provider finds it corrupt)
        std::fs::remove_dir(h.join("state-claude.json")).unwrap();
        for v in ["null", "[]", "3"] {
            std::fs::write(h.join("state-claude.json"), v).unwrap();
            assert_eq!(line(Some(true)).as_ref(), Some(&unread), "{v}");
        }
        std::fs::write(
            h.join("state-gemini.json"),
            r#"{"failures":2,"last_error":"boom"}"#,
        )
        .unwrap();
        assert_eq!(
            state_file_line(&h, "gemini", "state-gemini.json", Some(true), "x").as_deref(),
            Some("gemini: 2 consecutive failures / last error boom / next check x")
        );
    }

    #[test]
    fn status_names_the_stop_and_the_attempt_with_their_commands_also_while_the_agent_is_stopped() {
        let stop = NextRun {
            at_ms: None,
            waiting: Some(crate::schedule::Waiting::Denied),
            disabled: false,
            stop: Some(7),
            attempt: None,
        };
        let unknown = NextRun {
            waiting: Some(crate::schedule::Waiting::Unknown),
            stop: None,
            attempt: Some(0xab),
            ..stop
        };
        let plan = BTreeMap::from([("codex".to_string(), stop), ("claude".to_string(), unknown)]);
        for running in [true, false] {
            let codex = planned_check(Some(&plan), "codex", running, None);
            assert!(
                codex.contains("headroom collect --provider codex --resume-access 7"),
                "{codex}"
            );
            let claude = planned_check(Some(&plan), "claude", running, None);
            assert!(
                claude.contains(
                    "headroom collect --provider claude --force --replace 00000000000000ab"
                ),
                "{claude}"
            );
        }
        assert!(
            planned_check(Some(&plan), "codex", false, None).starts_with("none (agent stopped) (")
        );
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
                stop: None,
                attempt: None,
            },
        )]);
        let schedule = |session: &str| Schedule {
            session: session.into(),
            providers: providers.clone(),
            intervals: BTreeMap::new(),
            idle_min: (30, 60),
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
            stop: None,
            attempt: None,
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
                accept_account: true,
                same_account: false,
                resume: None,
                replace: None,
                result: None,
                reset_fetch_state: false
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
                accept_account: false,
                same_account: false,
                resume: None,
                replace: None,
                result: None,
                reset_fetch_state: false
            })
        );
        // the same account: for a named provider (each one says whether it takes it), and not together with --accept-account
        assert_eq!(
            parse_collect_args(&args(&["--provider", "gemini", "--same-account"])),
            Ok(CollectArgs {
                provider: Some("gemini"),
                force: false,
                accept_account: false,
                same_account: true,
                resume: None,
                replace: None,
                result: None,
                reset_fetch_state: false
            })
        );
        assert!(parse_collect_args(&args(&["--provider", "codex", "--same-account"])).is_ok());
        assert!(parse_collect_args(&args(&["--same-account"])).is_err());
        assert!(
            parse_collect_args(&args(&[
                "--provider",
                "gemini",
                "--same-account",
                "--accept-account"
            ]))
            .is_err()
        );
    }

    #[test]
    fn whether_gemini_is_on_comes_from_the_running_agent_then_from_the_config() {
        let mut on_cfg = config::Config::default();
        on_cfg.gemini.enabled = Some(true);
        let off_cfg = config::Config::default();
        let run = NextRun {
            at_ms: Some(1),
            waiting: None,
            disabled: false,
            stop: None,
            attempt: None,
        };
        let with = BTreeMap::from([("gemini".to_string(), run)]);
        let without = BTreeMap::from([("claude".to_string(), run)]);
        // started with it on, config.toml turned off since: still on until the agent restarts
        assert_eq!(
            provider_on(Some(&with), true, Some(&off_cfg), "gemini"),
            Some(true)
        );
        assert_eq!(
            provider_on(Some(&without), true, Some(&on_cfg), "gemini"),
            Some(false)
        );
        // no agent running: config.toml; neither readable: unknown
        assert_eq!(
            provider_on(Some(&with), false, Some(&off_cfg), "gemini"),
            Some(false)
        );
        // running, its schedule not written yet: not known (config.toml may have changed since it started)
        assert_eq!(provider_on(None, true, Some(&on_cfg), "gemini"), None);
        assert_eq!(provider_on(None, false, None, "gemini"), None);
    }

    #[test]
    fn a_provider_named_but_turned_off_is_an_error_before_anything_runs() {
        let home = crate::test_util::TempHome::new("headroom-collect-off");
        // Gemini is off by default; Claude turned off in the config
        assert_eq!(collect(&args(&["--provider", "gemini"]), &home), 1);
        std::fs::write(home.join("config.toml"), "[claude]\nenabled = false\n").unwrap();
        assert_eq!(
            collect(&args(&["--provider", "claude", "--accept-account"]), &home),
            1
        );
        assert!(!home.join("state-claude.json").exists());
        assert!(!home.join("clock-epoch.json").exists(), "nothing ran");
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
