//! Manual collect requests: `headroom collect` asks the running agent through files in HEADROOM_HOME, and only the agent (the holder
//! of agent.lock) does the round.
//!
//! - One file per request (`collect-request-<id>.json`), written in full first and moved in. The agent takes the oldest one at a
//!   time (moved to `collect-taken-<id>.json` before it is read), does it in a round and writes `collect-result-<id>.json`.
//! - A short lock (`collect-request.lock`, never held across a fetch) orders publishing, taking, withdrawing and closing: a request
//!   the CLI withdraws is never done, and one the agent took is never withdrawn. A stopping agent closes its session first, so no
//!   request is published after its last look, and answers every request still waiting as not done.
//! - A result holds what was done, never values (`collect` shows the agent's snapshot.json). Results are kept for a day.
//! - Nothing of an account is written: ids are random, providers named, times and fixed text only.

use std::fs::File;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::schedule::Mode;
use crate::store::{Logger, read_json, write_json_atomic};
use crate::time::MINUTE_MS;

pub const LOCK_FILE: &str = "collect-request.lock";
const REQUEST_PREFIX: &str = "collect-request-";
const TAKEN_PREFIX: &str = "collect-taken-";
const RESULT_PREFIX: &str = "collect-result-";
const CLOSED_PREFIX: &str = "collect-closed-";
/// How long a manual collect waits, all in all, and how old a request may be when the agent takes it
pub const REQUEST_WAIT_MS: i64 = 120_000;
/// How long a result is kept after it was written
pub const RESULT_KEEP_MS: i64 = 24 * 60 * MINUTE_MS;
/// A temporary file older than this was left by a command that stopped while writing it
const STALE_TMP_MS: i64 = 10 * MINUTE_MS;
const LOCK_WAIT: Duration = Duration::from_secs(5);

pub fn pending_file(id: &str) -> String {
    format!("{REQUEST_PREFIX}{id}.json")
}

fn tmp_file(id: &str) -> String {
    format!("{REQUEST_PREFIX}{id}.json.tmp")
}

pub fn taken_file(id: &str) -> String {
    format!("{TAKEN_PREFIX}{id}.json")
}

pub fn result_file(id: &str) -> String {
    format!("{RESULT_PREFIX}{id}.json")
}

fn closed_file(session: &str) -> String {
    format!("{CLOSED_PREFIX}{session}")
}

/// Whether a file name is a request waiting (a file event of one wakes the agent)
pub fn is_pending_name(name: &str) -> bool {
    id_in(name, REQUEST_PREFIX).is_some()
}

/// The id in `<prefix><id>.json`, if the name is one
fn id_in<'a>(name: &'a str, prefix: &str) -> Option<&'a str> {
    name.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(".json"))
        .filter(|id| is_id(id))
}

/// 16 lowercase hex digits (a request or attempt id as the commands print them)
pub fn is_id(v: &str) -> bool {
    v.len() == 16 && v.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// What a manual collect does with an account switch or a change of limits
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Account {
    #[default]
    Keep,
    /// `--accept-account`: another account (a history boundary)
    Accept,
    /// `--same-account`: the same account with other limits (no boundary)
    Same,
}

/// A manual collect, as the CLI hands it to the running agent
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Request {
    pub id: String,
    /// The agent session it was made for: another session never does it
    pub session: String,
    /// When it was made (this PC's clock): past REQUEST_WAIT_MS it isn't done
    pub created_ms: i64,
    /// The provider named (None: every one)
    pub provider: Option<String>,
    /// `--force`: fetch now, and past a safety stop
    pub force: bool,
    /// `--resume-access <stop>`
    pub resume: Option<u64>,
    /// `--replace <attempt>`: the attempt whose result is unknown that the user checked
    pub replace: Option<String>,
    pub account: Account,
    /// The switch the user saw pending when asking (the provider's own mark; None: none was seen): only that one is accepted
    #[serde(default)]
    pub accept_target: Option<i64>,
}

impl Request {
    pub fn names(&self, id: &str) -> bool {
        self.provider.as_deref().is_none_or(|p| p == id)
    }

    pub fn mode(&self) -> Mode {
        let replace = self
            .replace
            .as_deref()
            .and_then(|a| u64::from_str_radix(a, 16).ok());
        match (self.resume, self.force) {
            (Some(stop), _) => Mode::Resume { stop, replace },
            (None, true) => Mode::Force { replace },
            (None, false) if self.account != Account::Keep => Mode::Accept,
            (None, false) => Mode::Auto,
        }
    }
}

/// How a request ended
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Finish {
    /// Done in a round (what it did is in `ok` and the notes)
    #[default]
    Done,
    /// Not done (the agent stopped first, or it came too late or for another agent)
    NotDone,
    /// The agent stopped while doing it: whether it fetched or accepted can't be told (never done again; see headroom status)
    Unknown,
}

/// What a manual collect did (the result file; no values)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct RequestOutcome {
    pub id: String,
    pub provider: Option<String>,
    pub finish: Finish,
    /// Everything asked for was done (a fetch forced, a stop resumed, an acceptance saved)
    pub ok: bool,
    /// The clock (or the push state) let nothing be fetched
    pub refused: bool,
    /// What was or wasn't done, for the user
    pub notes: Vec<String>,
    /// When it ended (this PC's clock): kept for RESULT_KEEP_MS from then
    pub done_ms: i64,
}

impl RequestOutcome {
    fn ended(req: &Request, finish: Finish, note: &str, now: i64) -> Self {
        Self {
            id: req.id.clone(),
            provider: req.provider.clone(),
            finish,
            ok: false,
            refused: false,
            notes: vec![note.to_string()],
            done_ms: now,
        }
    }
}

/// The short lock ordering publishing, taking, withdrawing and closing. None: it couldn't be taken in time
fn lock(home: &Path) -> Option<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join(LOCK_FILE))
        .ok()?;
    let start = Instant::now();
    loop {
        match file.try_lock() {
            Ok(()) => return Some(file),
            Err(std::fs::TryLockError::WouldBlock) if start.elapsed() < LOCK_WAIT => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    }
}

/// CLI: publishes a request, written in full first and moved in under the lock, only while `accepting` says the agent session it was
/// made for takes requests (and it hasn't closed). Err: not published (said why)
pub fn publish(home: &Path, req: &Request, accepting: impl Fn() -> bool) -> Result<(), String> {
    use std::io::Write;
    let tmp = home.join(tmp_file(&req.id));
    let body = serde_json::to_vec(req).map_err(|e| e.to_string())?;
    let written = std::fs::File::create(&tmp)
        .and_then(|mut f| f.write_all(&body).and_then(|()| f.sync_all()));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Couldn't ask the agent: {}", e.kind()));
    }
    let Some(_lock) = lock(home) else {
        let _ = std::fs::remove_file(&tmp);
        return Err("Couldn't ask the agent (its request lock is busy); nothing was done".into());
    };
    let path = home.join(pending_file(&req.id));
    if !accepting() || home.join(closed_file(&req.session)).exists() || path.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err("The background agent is stopping; nothing was done".into());
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Couldn't ask the agent: {}", e.kind())
    })
}

/// CLI: withdraws the request `id` if the agent hasn't taken it. true if withdrawn (it will never be done)
pub fn withdraw(home: &Path, id: &str) -> bool {
    let Some(_lock) = lock(home) else {
        return false;
    };
    std::fs::remove_file(home.join(pending_file(id))).is_ok()
}

/// The requests waiting, oldest first (by when they were made, then by id). Each one whose body can't be read, or whose name and id
/// differ, comes with None
fn waiting(home: &Path) -> Vec<(String, Option<Request>)> {
    let Ok(entries) = std::fs::read_dir(home) else {
        return Vec::new();
    };
    let mut list: Vec<(String, Option<Request>)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = id_in(&name, REQUEST_PREFIX)?.to_string();
            let req = read_json::<Request>(&e.path()).filter(|r| r.id == id);
            Some((id, req))
        })
        .collect();
    list.sort_by_key(|(id, r)| (r.as_ref().map_or(i64::MIN, |r| r.created_ms), id.clone()));
    list
}

/// Agent: takes the oldest request waiting for `session` (moved before it is read, under the lock). One made for another session (an
/// earlier agent), too old, from the future or unreadable ends as not done. Also whether more are waiting
pub fn take(home: &Path, session: &str, now: i64, log: &Logger) -> (Option<Request>, bool) {
    let Some(_lock) = lock(home) else {
        return (None, true);
    };
    let mut list = waiting(home).into_iter();
    for (id, req) in list.by_ref() {
        let path = home.join(pending_file(&id));
        let usable = req.filter(|r| {
            r.session == session
                && now - r.created_ms <= REQUEST_WAIT_MS
                && r.created_ms - now <= MINUTE_MS
        });
        let Some(req) = usable else {
            let ended = Request {
                id: id.clone(),
                ..Request::default()
            };
            // Its end is written before the request goes (one that can't be written stays, and is tried again)
            if end(
                home,
                &RequestOutcome::ended(
                    &ended,
                    Finish::NotDone,
                    "Not done: the request came too late, or was made for an agent that has since stopped",
                    now,
                ),
                log,
            ) {
                let _ = std::fs::remove_file(&path);
            }
            continue;
        };
        if std::fs::rename(&path, home.join(taken_file(&id))).is_err() {
            continue;
        }
        return (Some(req), list.next().is_some());
    }
    (None, false)
}

/// Agent: a request taken but not begun, because the agent stops: it ends as not done (nothing of it was done)
pub fn give_back(home: &Path, req: &Request, now: i64, log: &Logger) {
    let out = RequestOutcome::ended(
        req,
        Finish::NotDone,
        "Not done: the background agent stopped before doing it",
        now,
    );
    if finish(home, &out).is_err() {
        log.log("Couldn't write a manual collect's result");
    }
}

/// Agent: stops taking requests for `session` (a CLI checks this under the same lock before publishing) and ends every request still
/// waiting as not done
pub fn close(home: &Path, session: &str, now: i64, log: &Logger) {
    let Some(_lock) = lock(home) else {
        log.log("Couldn't take the request lock while stopping; requests waiting end when they time out");
        return;
    };
    let _ = std::fs::write(home.join(closed_file(session)), b"");
    for (id, req) in waiting(home) {
        let req = req.unwrap_or(Request {
            id: id.clone(),
            ..Request::default()
        });
        if end(
            home,
            &RequestOutcome::ended(
                &req,
                Finish::NotDone,
                "Not done: the background agent stopped before doing it",
                now,
            ),
            log,
        ) {
            let _ = std::fs::remove_file(home.join(pending_file(&id)));
        }
    }
}

/// Agent: writes a request's result, then lets the request taken go. Err: the result couldn't be written (the request stays taken;
/// writing is tried again)
pub fn finish(home: &Path, outcome: &RequestOutcome) -> std::io::Result<()> {
    write_json_atomic(&home.join(result_file(&outcome.id)), outcome)?;
    let _ = std::fs::remove_file(home.join(taken_file(&outcome.id)));
    Ok(())
}

/// Writes an end; false if it couldn't be (the request is left as it is)
fn end(home: &Path, outcome: &RequestOutcome, log: &Logger) -> bool {
    if write_json_atomic(&home.join(result_file(&outcome.id)), outcome).is_err() {
        log.log("Couldn't write a manual collect's result");
        return false;
    }
    true
}

/// Agent start (and now and then): a request an earlier agent took and didn't finish ends as unknown (never done again; one whose
/// result was written already keeps it). Temporary files left behind, the closing marks and results older than a day go
pub fn tidy(home: &Path, now: i64, log: &Logger) {
    let Ok(entries) = std::fs::read_dir(home) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let age_ms = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .map_or(0, |d| d.as_millis() as i64);
        if let Some(id) = id_in(&name, TAKEN_PREFIX) {
            if read_json::<RequestOutcome>(&home.join(result_file(id))).is_none() {
                let req = read_json::<Request>(&path)
                    .filter(|r| r.id == id)
                    .unwrap_or(Request {
                        id: id.to_string(),
                        ..Request::default()
                    });
                let out = RequestOutcome::ended(
                    &req,
                    Finish::Unknown,
                    "Unknown: the background agent stopped while doing it, so whether it fetched or accepted can't be told (see headroom status)",
                    now,
                );
                if write_json_atomic(&home.join(result_file(id)), &out).is_err() {
                    log.log("Couldn't write a manual collect's result");
                    continue;
                }
            }
            let _ = std::fs::remove_file(&path);
        } else if name.starts_with(CLOSED_PREFIX)
            || (name.starts_with(REQUEST_PREFIX) && name.ends_with(".tmp") && age_ms > STALE_TMP_MS)
        {
            let _ = std::fs::remove_file(&path);
        } else if let Some(id) = id_in(&name, RESULT_PREFIX) {
            let old = match read_json::<RequestOutcome>(&path) {
                Some(out) => {
                    out.id != id
                        || now - out.done_ms > RESULT_KEEP_MS
                        || out.done_ms - now > MINUTE_MS
                }
                None => age_ms > RESULT_KEEP_MS,
            };
            if old {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// Where a request stands, as the CLI sees it
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// Waiting for the agent to take it
    Waiting,
    /// Taken: the agent is doing it (or stopped while doing it: it is ended as unknown when it starts again)
    Taken,
    Ended(RequestOutcome),
    /// No such request (never made, or its result is older than a day)
    None,
}

pub fn look(home: &Path, id: &str) -> Seen {
    let now = crate::time::now_ms();
    let kept =
        |o: &RequestOutcome| o.id == id && now - o.done_ms <= RESULT_KEEP_MS && o.done_ms <= now;
    if let Some(out) = read_json::<RequestOutcome>(&home.join(result_file(id))).filter(kept) {
        return Seen::Ended(out);
    }
    if home.join(taken_file(id)).exists() {
        return Seen::Taken;
    }
    if home.join(pending_file(id)).exists() {
        return Seen::Waiting;
    }
    // Taken and ended between the looks above
    match read_json::<RequestOutcome>(&home.join(result_file(id))).filter(kept) {
        Some(out) => Seen::Ended(out),
        None => Seen::None,
    }
}
