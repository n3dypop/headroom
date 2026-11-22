//! Fetch coordination: when each provider's active fetch (a query to Anthropic / OpenAI / Google) may run.
//!
//! - **The plan:** after each fetch attempt, the next one is planned one interval later (15 minutes by default, never under 10) with a
//!   ±20 % jitter, so PCs and providers don't fetch on a fixed clock. The jitter comes from a hash of this PC, the provider and the
//!   attempt, and the plan is kept in PLAN_FILE: the same clock and inputs give the same plan after a restart.
//! - **Passive values first:** while a provider's passive values (its statusLine) were received within an interval, after this PC's
//!   last active fetch, and carry every overall limit (after its reset while one is reached), the active fetch is put off, but no
//!   further than the longest stretch after this PC's last active fetch, or after it first took part (limits the statusLine doesn't
//!   carry are fetched still).
//! - **Stretching when nothing changes:** if values don't change for 30 minutes and there is an overall limit, every one below 80 %, the
//!   interval is stretched to `idle_interval_min` (30), and after 2 hours to `idle_long_interval_min` (60). A change of the values or
//!   of the state (an error, a reached limit) returns it, and a stretched plan, to normal.
//! - **The clock epoch:** the plan, a hold and the start of an unchanged stretch belong to the clock epoch they were made in; they stand
//!   across a restart in the same epoch and are dropped in another.
//! - **Attempts and turns:** a PC that shares (push set up) starts an active fetch only on the destination's go for that provider and
//!   attempt: also the first after a start, its own fetch, a manual collect and `--force`. When the destination can't be asked or
//!   grants nothing it waits. Each attempt is saved before it is asked for and before the query starts, and its result is reported
//!   until acknowledged, before any next attempt. A PC without push decides alone. An attempt whose result is unknown (a run that
//!   stopped before its result was checked) holds the provider until the user's `--force`.
//! - **Shared stops:** a rate limit (429) holds every PC for its stage's wait (30, 60, 120, 240 minutes, at least the interval and the
//!   wait the service named); an access denial (403) stops the provider on every PC until a `--resume-access` of that stop succeeds. A
//!   PC that shares keeps the destination's word for both (asking it again now and then while stopped); one that doesn't keeps its own.
//! - **Safety net:** a PC that hasn't fetched a provider for `own_fetch_min` (120 minutes) since its last attempt, or since it first took
//!   part, asks for its own fetch: it passes another PC's lease (one at a time), never a stop or another attempt.
//!
//! All times are this PC's clock (ms). Only relative times (minutes / seconds) are exchanged with the destination.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::config::ScheduleConfig;
use crate::providers::{Outcome, Passive, Run};
use crate::schema::{ErrorCode, ProviderSnapshot, ProviderStatus};
use crate::store::{Logger, write_json_atomic};
use crate::time::{MINUTE_MS, iso_from_ms};

/// File in HEADROOM_HOME where the running agent records when it next checks each provider, for `headroom status` only (never sent)
pub const SCHEDULE_FILE: &str = "schedule.json";
/// File in HEADROOM_HOME holding the running agent's session ID (new on every start). `status` uses the schedule only if it
/// carries the same ID, so a schedule left by an earlier agent process is never shown as the current one's
pub const SESSION_FILE: &str = "agent.session";
/// Held with an exclusive lock by the agent that wrote SESSION_FILE, for its lifetime. `status` only probes it with a
/// shared lock (so concurrent `status` runs never block each other): if the probe succeeds, that agent is gone
pub const SESSION_LOCK_FILE: &str = "agent.session.lock";
/// File in HEADROOM_HOME keeping each provider's plan, attempt and stops (last fetch, last change, next planned fetch, the attempt in
/// progress or awaiting acknowledgement, the rate limit, the access denial) across restarts, in one file so they are saved together.
/// This PC only, never sent
pub const PLAN_FILE: &str = "schedule-plan.json";
/// Orders the agent's and a manual collect's reads and writes of PLAN_FILE
const PLAN_LOCK_FILE: &str = "schedule-plan.lock";
const PLAN_LOCK_WAIT: Duration = Duration::from_secs(5);

/// Contents of SCHEDULE_FILE
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    pub session: String,
    pub providers: BTreeMap<String, NextRun>,
    /// The interval (minutes) the running agent uses for each provider it fetches (the config it started with)
    #[serde(default)]
    pub intervals: BTreeMap<String, i64>,
    /// The stretched intervals (minutes) it uses while nothing changes
    #[serde(default)]
    pub idle_min: (i64, i64),
}

/// When the running agent next decides whether to fetch a provider. Not a promise to fetch: at that time the agent may
/// still defer (another PC holds the turn) or stretch the interval
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct NextRun {
    /// This PC's clock (ms). None when no fetch is scheduled (stopped, disabled or waiting for a manual resume)
    pub at_ms: Option<i64>,
    /// Why the fetch waits past the provider's own schedule
    pub waiting: Option<Waiting>,
    /// Disabled in the config the running agent started with (set by the agent, not by the coordinator)
    #[serde(default)]
    pub disabled: bool,
    /// The stop (its generation) a resume names, while stopped by an access denial
    #[serde(default)]
    pub stop: Option<u64>,
    /// The attempt whose result is unknown (its id as a number), while held for it
    #[serde(default)]
    pub attempt: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Waiting {
    /// Another PC holds the fetch turn
    Turn,
    /// Values have not changed, so the interval is stretched
    Idle,
    /// Passive values (the statusLine) came recently, so the active fetch is put off
    Passive,
    /// The destination couldn't be asked for the turn, or granted nothing it could decide now: the fetch waits and asks again
    Unconfirmed,
    /// Another fetch attempt of the provider is in progress (on this PC or another)
    Pending,
    /// Rate limited by the service (429): every PC waits until then
    RateLimited,
    /// Access denied by the service (403): stopped on every PC until resumed
    Denied,
    /// An attempt's result is unknown (the run stopped before it was checked): stopped until forced
    Unknown,
    /// The fetch state (PLAN_FILE) can't be read on a PC that doesn't share: its stops can't be told, so stopped until it is reset
    Unreadable,
    /// Allowed to fetch, but the provider ran nothing (its state can't be read, the go came too late): asked again after a wait that
    /// grows with each such round (1, 2, 4 … 60 minutes), so a provider that can't run doesn't ask for turns all the time
    NothingRun,
}

impl Waiting {
    fn note(self) -> &'static str {
        match self {
            Waiting::Turn => " (another PC holds the fetch turn; checks again then)",
            Waiting::Idle => " (no recent changes; interval stretched)",
            Waiting::Passive => " (recent values came from the statusLine; fetch put off)",
            Waiting::Unconfirmed => {
                " (couldn't ask the destination for the fetch turn; asks again then)"
            }
            Waiting::Pending => " (another fetch attempt is in progress; checks again then)",
            Waiting::RateLimited => " (rate limited by the service; every PC waits until then)",
            Waiting::Denied => {
                " (access denied by the service; check the account, then resume with headroom collect --provider <name> --resume-access)"
            }
            Waiting::Unknown => {
                " (the last fetch's result couldn't be checked; resume with headroom collect --provider <name> --force)"
            }
            Waiting::Unreadable => {
                " (schedule-plan.json can't be read; reset it with headroom collect --reset-fetch-state)"
            }
            Waiting::NothingRun => {
                " (allowed to fetch, but nothing was run, as the log says; asks again then)"
            }
        }
    }
}

impl NextRun {
    /// Whether it says the provider is stopped until the user acts (shown with its command, over any other reason)
    pub fn stopped(&self) -> bool {
        matches!(
            self.waiting,
            Some(Waiting::Denied | Waiting::Unknown | Waiting::Unreadable)
        )
    }

    /// Text for `headroom status`
    pub fn describe(&self) -> String {
        self.describe_for("<name>")
    }

    /// Text for `headroom status` of the provider `id`: a stop names the command that resumes it, with the values it takes
    pub fn describe_for(&self, id: &str) -> String {
        if self.disabled {
            return "none (disabled)".into();
        }
        let note = match (self.waiting, self.stop, self.attempt) {
            (Some(Waiting::Denied), Some(stop), Some(a)) => format!(
                " (access denied by the service, stop {stop}, and the result of fetch attempt {a:016x} couldn't be checked; check the account and headroom status, then run headroom collect --provider {id} --resume-access {stop} --replace {a:016x}; add --force if a safety stop shows too)"
            ),
            (Some(Waiting::Denied), Some(stop), None) => format!(
                " (access denied by the service, stop {stop}; check the account, then run headroom collect --provider {id} --resume-access {stop}; add --force if a safety stop shows too)"
            ),
            (Some(Waiting::Unknown), _, Some(a)) => format!(
                " (the result of fetch attempt {a:016x} couldn't be checked; check headroom status, then run headroom collect --provider {id} --force --replace {a:016x})"
            ),
            (w, _, _) => w.map_or(String::new(), |w| w.note().to_string()),
        };
        match self.at_ms {
            Some(at) => format!("{}{note}", iso_from_ms(at)),
            None if self.waiting.is_some() => format!("none{note}"),
            None => "none (not scheduled)".into(),
        }
    }
}

/// Start stretching the interval when values have not changed for this many minutes
const IDLE_AFTER_MIN: i64 = 30;
/// Stretch further when values have not changed for this many minutes
const IDLE_LONG_AFTER_MIN: i64 = 120;
/// Do not stretch when an overall limit is at or above this usage (so near-limit notifications are not delayed)
const IDLE_MAX_PERCENT: f64 = 80.0;
/// Margin (minutes) added to the turn's lease, so another PC does not take over before the holder extends it on its next fetch
const TURN_GRACE_MIN: i64 = 3;
/// A deferring PC asks again a little after the lease expires (so the holder can extend it first)
const RETRY_AFTER_MS: i64 = 5_000;
/// Longest lease (minutes) a successful fetch takes (the destination's limit too)
const LEASE_MAX_MIN: i64 = 90;
/// The jitter on a planned interval, in hundredths of a percent either way (±20 %)
const JITTER_BP: i64 = 2_000;
/// While the destination can't be asked, grants nothing it can decide now, or another attempt is pending, ask again this often
const UNCONFIRMED_RECHECK_MIN: i64 = 5;
/// A PC told another holds the turn asks again no later than this (minutes), whatever its interval
const TURN_RECHECK_MAX_MIN: i64 = 21;
/// While stopped (a rate limit, an access denial), a PC that shares asks the destination this often whether it still is
const STOP_RECHECK_MIN: i64 = 5;
/// The waits (minutes) of the rate limit's stages, for a PC that doesn't share (the destination's are the same)
pub const RATE_STAGES_MIN: [i64; 4] = [30, 60, 120, 240];

/// Whether an acknowledgement can be the destination's answer to a resume's result: one applied ends the stop it was for (an
/// acknowledgement showing another stop's state, or the stop standing, isn't its own)
fn resume_ack_fits(kind: Kind, r: Reported, stop: Option<u64>, ack: &Ack) -> bool {
    !(ack.applied
        && kind == Kind::Resume
        && r == Reported::Ok
        && (ack.shared.denied || Some(ack.shared.denied_gen) != stop))
}
/// A go is used only this soon after it came (a run held up longer, a sleep, asks again: the destination may have replaced it)
pub const GRANT_VALID_MS: i64 = 60_000;
/// Fixed text of a provider stopped by an access denial
pub const DENIED_TEXT: &str =
    "Access denied by the service: fetching stopped on every PC (see headroom status)";

/// What a turn request asks for
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A planned fetch
    Fetch,
    /// This PC's own fetch (the safety net): passes another PC's lease
    Own,
    /// The user's `--force`: passes another PC's lease, and replaces an attempt left pending
    Force,
    /// The user's `--resume-access` of a stop
    Resume,
    /// Hands back the lease a successful fetch took
    Release,
    /// Asks only for the shared state
    Peek,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Fetch => "fetch",
            Kind::Own => "own",
            Kind::Force => "force",
            Kind::Resume => "resume",
            Kind::Release => "release",
            Kind::Peek => "peek",
        }
    }
}

/// How a fetch is asked for: by the plan (the agent, a manual collect), by the user's `--force`, or by `--resume-access`. What the
/// user confirmed comes with it: the stop resumed (as `headroom status` showed it), and the attempt whose result is unknown that may be
/// replaced (its id). Nothing else is taken in their place (a stop read later, another attempt)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Auto,
    /// An acceptance that needs a query (the switch is taken only with the new account's value): asked for now, past the plan and the
    /// passive values, but not past the shared stops, another attempt or another PC's lease (never a force)
    Accept,
    Force {
        replace: Option<u64>,
    },
    Resume {
        stop: u64,
        replace: Option<u64>,
    },
}

impl Mode {
    /// The attempt the user confirmed replacing
    fn replace(self) -> Option<u64> {
        match self {
            Mode::Auto | Mode::Accept => None,
            Mode::Force { replace } | Mode::Resume { replace, .. } => replace,
        }
    }
}

/// How a turn request ended
enum Asked {
    Go,
    /// Not granted, and why (None: no answer, or nothing decided)
    No(Option<Reason>),
    /// The row moved on since the attempt's version: asked again once with a new attempt
    Moved,
}

/// The stop a request of this mode and kind confirms (a resume's only)
fn mode_stop(mode: Mode, kind: Kind) -> Option<u64> {
    match mode {
        Mode::Resume { stop, .. } if kind == Kind::Resume => Some(stop),
        _ => None,
    }
}

/// A pending attempt whose result is unknown is replaced no sooner than this after it began or was last granted
const REPLACE_AFTER_MS: i64 = 5 * MINUTE_MS;

/// An attempt id as the number `headroom status` shows and `--replace` takes (16 hex digits)
fn attempt_number(id: &str) -> Option<u64> {
    u64::from_str_radix(id, 16).ok()
}

/// Why the destination granted nothing
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Another PC holds the lease
    Turn,
    /// Another attempt is pending
    Pending,
    RateLimited,
    AccessDenied,
    /// Nothing could be decided now (no budget left, a PC that can't deliver)
    Unavailable,
    /// A resume of a stop that is over, or of another one
    StaleGen,
    /// The destination's row moved on since the version this attempt was made against (a new attempt is made against the new one)
    Moved,
    /// The attempt named to be replaced isn't pending any more (its result came, or it was replaced): nothing to replace
    Gone,
}

impl Reason {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "turn" => Reason::Turn,
            "pending" => Reason::Pending,
            "rate_limited" => Reason::RateLimited,
            "access_denied" => Reason::AccessDenied,
            "unavailable" => Reason::Unavailable,
            "stale_gen" => Reason::StaleGen,
            "moved" => Reason::Moved,
            "gone" => Reason::Gone,
            _ => return None,
        })
    }
}

/// The provider's shared state, as the destination answers it
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Shared {
    pub denied: bool,
    pub denied_gen: u64,
    pub rate_stage: u32,
    /// Time left of the rate limit's wait (0: none)
    pub rate_wait_ms: i64,
    /// The version of the destination's row for the provider (a new attempt is made against the one last seen)
    pub version: u64,
}

/// One turn request, with what was fixed when its attempt was made (asked again exactly so)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ask<'a> {
    pub kind: Kind,
    pub attempt: Option<&'a str>,
    /// resume: the stop the user confirmed
    pub stop: Option<u64>,
    /// The version of the destination's row the attempt was made against: a new reservation is made only on it (a late copy finds
    /// it moved)
    pub base: Option<u64>,
    /// The pending attempt the user confirmed replacing (force, resume)
    pub replace: Option<&'a str>,
    /// Asked again (its first answer was lost): a refusal of it holds for every copy of it
    pub again: bool,
}

impl<'a> Ask<'a> {
    /// The shared state only (no attempt)
    pub fn peek() -> Self {
        Self {
            kind: Kind::Peek,
            attempt: None,
            stop: None,
            base: None,
            replace: None,
            again: false,
        }
    }

    /// Hands back the lease the attempt took
    pub fn release(attempt: &'a str) -> Self {
        Self {
            kind: Kind::Release,
            attempt: Some(attempt),
            ..Self::peek()
        }
    }
}

/// The destination's acknowledgement of a result
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ack {
    pub shared: Shared,
    /// Applied to the pending attempt (false: it wasn't pending any more, as one replaced, or a result applied before whose
    /// acknowledgement was lost): the result is over either way, and only an applied one takes a lease
    pub applied: bool,
}

/// The destination's answer to a turn request, for the provider, attempt and kind asked (an answer for others is never one)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Answer {
    pub go: bool,
    pub reason: Option<Reason>,
    /// Time until the lease, or the rate limit's wait, ends (ms)
    pub wait_ms: i64,
    pub shared: Option<Shared>,
}

/// An attempt's result as reported (and kept until acknowledged)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reported {
    Ok,
    Failed,
    NotRun,
    RateLimited { retry_ms: Option<i64> },
    AccessDenied,
}

impl Reported {
    pub fn as_str(self) -> &'static str {
        match self {
            Reported::Ok => "ok",
            Reported::Failed => "failed",
            Reported::NotRun => "not_run",
            Reported::RateLimited { .. } => "rate_limited",
            Reported::AccessDenied => "access_denied",
        }
    }

    fn from_outcome(o: Outcome) -> Self {
        match o {
            Outcome::Ok => Reported::Ok,
            Outcome::Failed => Reported::Failed,
            Outcome::RateLimited { retry_ms } => Reported::RateLimited { retry_ms },
            Outcome::AccessDenied => Reported::AccessDenied,
        }
    }
}

/// Who to ask for the turn (the destination)
pub trait TurnAsker {
    /// A turn request for one attempt. None: no answer this PC can act on (unreachable, an earlier destination, credentials that can't
    /// be read, an answer that doesn't match the request): the fetch waits
    fn ask(&mut self, provider: &str, ask: Ask<'_>) -> Option<Answer>;
    /// The attempt's result, with the lease a successful fetch takes (minutes). Some once acknowledged for this attempt and kind
    fn report(
        &mut self,
        provider: &str,
        attempt: &str,
        kind: Kind,
        outcome: Reported,
        interval_min: i64,
        lease_min: i64,
    ) -> Option<Ack>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AttemptState {
    /// Saved before the turn request (asked again with the same id when its answer was lost)
    Asking,
    /// Granted, saved before the query: found by a later run, its result is unknown
    Started,
    /// The query may have run and its result can't be checked: held until the user's force
    Unknown,
    /// The result, kept until the destination acknowledges it
    Done(Reported),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Attempt {
    id: String,
    kind: Kind,
    state: AttemptState,
    /// When it was made (this PC's clock)
    at: i64,
    /// The lease (minutes) its result takes, fixed when the result came (a resend reports the same)
    #[serde(default)]
    lease: i64,
    /// The interval (minutes) reported with its result, fixed when the result came
    #[serde(default)]
    interval: i64,
    /// The stop the user confirmed (resume), fixed with the attempt
    #[serde(default)]
    stop: Option<u64>,
    /// The pending attempt the user confirmed replacing, fixed with the attempt
    #[serde(default)]
    replace: Option<String>,
    /// The version of the destination's row it was made against, fixed with the attempt
    #[serde(default)]
    base: Option<u64>,
    /// The attempt it replaces, as it stood (its result unknown): given back if the replacement never began
    #[serde(default, skip_serializing_if = "Option::is_none")]
    replaced: Option<Box<Attempt>>,
}

impl Attempt {
    fn new(id: String, kind: Kind, state: AttemptState, at: i64) -> Self {
        Self {
            id,
            kind,
            state,
            at,
            lease: 0,
            interval: 0,
            stop: None,
            replace: None,
            base: None,
            replaced: None,
        }
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Slot {
    /// Hold off fetching until this time
    #[serde(skip)]
    hold_until: i64,
    /// Why `hold_until` was set (shown by `headroom status`)
    #[serde(skip)]
    hold_reason: Option<Waiting>,
    /// When `hold_until` was set (a clock that went back before it set the hold by its old time)
    #[serde(skip)]
    hold_set_at: i64,
    /// Last time this PC fetched (an attempt that went upstream; 0 = never)
    last_fetch: i64,
    /// Last time a window value changed
    last_change: i64,
    last_values: Option<Vec<(String, u64, Option<String>)>>,
    /// The state with those values (status, error code, reached limit): a change of it is a change too
    #[serde(default)]
    last_state: Option<String>,
    /// The next active fetch planned after the last one (0 = none): the jittered interval, normal or stretched
    #[serde(default)]
    plan_at: i64,
    /// Why the plan is later than the normal interval (stretched)
    #[serde(default)]
    plan_reason: Option<Waiting>,
    /// The clock epoch the plan and the unchanged stretch were made in (another epoch drops them)
    #[serde(default)]
    epoch: Option<u64>,
    /// When this PC first took part for this provider (0 = not yet): the start of the longest stretch and of the safety net before
    /// its first active fetch
    #[serde(default)]
    joined_at: i64,
    /// The attempt in progress, or its result awaiting acknowledgement
    #[serde(default)]
    attempt: Option<Attempt>,
    /// The rate limit's stage (0: none) and the time to wait until (this PC's clock)
    #[serde(default)]
    rate_stage: u32,
    #[serde(default)]
    rate_until: i64,
    /// When that wait was set (a clock gone back keeps its length, never its end)
    #[serde(default)]
    rate_set_at: i64,
    /// Stopped by an access denial, which stop (its generation), and since when
    #[serde(default)]
    denied: bool,
    #[serde(default)]
    denied_gen: u64,
    #[serde(default)]
    denied_since: i64,
    /// The attempt whose successful fetch took the lease (handed back when the agent stops)
    #[serde(default)]
    lease_attempt: Option<String>,
    /// When the destination was last asked for the shared state while stopped
    #[serde(skip)]
    peeked_at: i64,
    /// Rounds in a row that were allowed to fetch and ran nothing (the wait before asking again grows with them)
    #[serde(skip)]
    not_run: u32,
    /// Whether deferring (for logging transitions)
    #[serde(skip)]
    deferring: bool,
    /// When the go of the attempt in progress was asked for (monotonic, right before the request): it is used only within GRANT_VALID_MS
    #[serde(skip)]
    granted: Option<crate::providers::Grant>,
    /// The attempt this process was granted: a result is applied to it only
    #[serde(skip)]
    granted_attempt: Option<String>,
    /// The version of the destination's row last seen (a new attempt is made against it; read first when none is known)
    #[serde(default)]
    base: Option<u64>,
    /// What this slot holds couldn't be saved yet (a result among it): kept in memory over what the file says, and saved before
    /// anything is reported or asked
    #[serde(skip)]
    unsaved: bool,
    /// A result not acknowledged is sent again from this time (this PC's clock), and how many sends of it failed
    #[serde(skip)]
    resend_at: i64,
    #[serde(skip)]
    resend_fails: u32,
}

impl Slot {
    /// This slot as read from the file, with what is kept in memory only taken from `from`
    fn with_unsaved(mut self, from: &Slot) -> Slot {
        // Not saved yet: what memory holds is newer (this process is the only one writing)
        if from.unsaved {
            return from.clone();
        }
        self.resend_at = from.resend_at;
        self.resend_fails = from.resend_fails;
        self.hold_until = from.hold_until;
        self.hold_reason = from.hold_reason;
        self.hold_set_at = from.hold_set_at;
        self.peeked_at = from.peeked_at;
        self.deferring = from.deferring;
        self.not_run = from.not_run;
        self.granted = from.granted;
        self.granted_attempt = from.granted_attempt.clone();
        self
    }
}

pub struct Coordinator {
    cfg: ScheduleConfig,
    log: Logger,
    slots: BTreeMap<String, Slot>,
    /// Where the plan is kept across restarts (None: not kept)
    path: Option<PathBuf>,
    /// This PC's part of the jitter's hash (its collector name), so PCs don't plan alike
    salt: String,
    /// The clock epoch usable now (follow_epoch): plans are made in it
    epoch: Option<u64>,
    /// This PC shares the turns (push is set up): it fetches only on the destination's go
    sharing: bool,
    /// PLAN_FILE exists but couldn't be read at the last reading
    unreadable: bool,
    /// Attempts made by this process (part of each new id)
    made: u64,
}

impl Coordinator {
    /// A coordinator that keeps nothing across restarts
    pub fn new(cfg: ScheduleConfig, log: Logger) -> Self {
        Self {
            cfg,
            log,
            slots: BTreeMap::new(),
            path: None,
            salt: String::new(),
            epoch: None,
            sharing: false,
            unreadable: false,
            made: 0,
        }
    }

    /// The agent's (and a manual collect's) coordinator: the plan read from (and kept in) PLAN_FILE, the jitter salted with this PC's
    /// collector name. `sharing`: push is set up (from the config, never from whether the destination can be reached now)
    pub fn with_plan(
        cfg: ScheduleConfig,
        log: Logger,
        home: &Path,
        salt: &str,
        sharing: bool,
    ) -> Self {
        let path = home.join(PLAN_FILE);
        let mut c = Self {
            path: Some(path),
            salt: salt.to_string(),
            sharing,
            ..Self::new(cfg, log)
        };
        c.reload();
        c
    }

    /// Whether this PC shares the turns: from the config (push set up), never from whether the destination can be reached now
    pub fn sharing(mut self, on: bool) -> Self {
        self.sharing = on;
        self
    }

    /// Reads PLAN_FILE again (a manual collect may have written it): what it keeps is taken, what is in memory only stays. One that
    /// exists but can't be read leaves the slots as they were and is noted
    fn reload(&mut self) {
        let Some(path) = &self.path else {
            return;
        };
        let read = match std::fs::read(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(_) => Err(()),
            Ok(bytes) => serde_json::from_slice::<BTreeMap<String, Slot>>(&bytes).map_err(|_| ()),
        };
        match read {
            Ok(disk) => {
                if self.unreadable {
                    self.log
                        .log("The fetch state (schedule-plan.json) can be read again");
                }
                self.unreadable = false;
                for (id, slot) in disk {
                    let slot = match self.slots.get(&id) {
                        Some(cur) => slot.with_unsaved(cur),
                        None => slot,
                    };
                    self.slots.insert(id, slot);
                }
            }
            Err(()) => {
                if !self.unreadable {
                    self.log.log(if self.sharing {
                        "The fetch state (schedule-plan.json) can't be read; it is made again (the destination keeps the shared stops)"
                    } else {
                        "The fetch state (schedule-plan.json) can't be read: nothing is fetched until it is reset (headroom collect --reset-fetch-state)"
                    });
                }
                self.unreadable = true;
            }
        }
    }

    /// The lock ordering reads and writes of PLAN_FILE (None without a file). Err: it couldn't be taken in time
    fn locked(&self) -> Result<Option<std::fs::File>, ()> {
        let Some(path) = &self.path else {
            return Ok(None);
        };
        let dir = path.parent().ok_or(())?;
        let _ = std::fs::create_dir_all(dir);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(PLAN_LOCK_FILE))
            .map_err(|_| ())?;
        let start = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(Some(file)),
                Err(std::fs::TryLockError::WouldBlock) if start.elapsed() < PLAN_LOCK_WAIT => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => return Err(()),
            }
        }
    }

    /// Saves the plan. false if it couldn't be (logged): nothing that must be saved first goes on
    fn save(&mut self) -> bool {
        let Some(path) = &self.path else {
            for s in self.slots.values_mut() {
                s.unsaved = false;
            }
            return true;
        };
        // A PC that doesn't share never writes over a file it couldn't read (its stops would be lost)
        if self.unreadable && !self.sharing {
            return false;
        }
        match write_json_atomic(path, &self.slots) {
            Ok(()) => {
                for s in self.slots.values_mut() {
                    s.unsaved = false;
                }
                true
            }
            Err(e) => {
                self.log
                    .log(&format!("Couldn't save the fetch plan: {}", e.kind()));
                false
            }
        }
    }

    /// Resets the fetch state of a PC that doesn't share whose file can't be read (the user's `--reset-fetch-state`): its stops are
    /// gone with it. true if it was reset
    pub fn reset(&mut self) -> bool {
        let Ok(_lock) = self.locked() else {
            return false;
        };
        self.reload();
        // Only a state that can't be read, on a PC that doesn't share: a readable one keeps its stops and results
        if !self.unreadable || self.sharing {
            self.log.log(if self.sharing {
                "Not reset: with push set up the destination keeps the shared stops, and a state that can't be read is made again on its own"
            } else {
                "Not reset: schedule-plan.json can be read (its stops end only by their own resume)"
            });
            return false;
        }
        self.slots.clear();
        self.unreadable = false;
        self.save()
    }

    /// The provider's slot, made in the clock epoch usable now if it is new
    fn slot(&mut self, id: &str) -> &mut Slot {
        let epoch = self.epoch;
        self.slots.entry(id.to_string()).or_insert_with(|| Slot {
            epoch,
            ..Slot::default()
        })
    }

    /// A new attempt id: 16 hex digits from this PC's salt, the provider, the time, the process and a count (nothing of an account)
    fn new_attempt(&mut self, id: &str, now: i64) -> String {
        self.made += 1;
        crate::store::fnv1a_hex(&[
            &self.salt,
            id,
            &now.to_string(),
            &std::process::id().to_string(),
            &self.made.to_string(),
            &format!("{:?}", Instant::now()),
        ])
    }

    /// The interval with its jitter, for the attempt at `attempt_ms`: ±20 % from a hash of this PC, the provider and the attempt (so
    /// the same attempt always gets the same plan), never under the floor
    fn jittered(&self, id: &str, attempt_ms: i64, base_ms: i64) -> i64 {
        let h = u64::from_str_radix(
            &crate::store::fnv1a_hex(&[&self.salt, id, &attempt_ms.to_string()]),
            16,
        )
        .unwrap_or(0);
        let bp = (h % (2 * JITTER_BP as u64 + 1)) as i64 - JITTER_BP;
        (base_ms + base_ms * bp / 10_000).max(crate::config::MIN_INTERVAL_MIN * MINUTE_MS)
    }

    /// A rate limit's wait lengthened by up to 20 % (never shortened: its retries keep no fixed rhythm), from a hash of this PC, the
    /// provider and the moment it was told (the same report, the same wait)
    fn lengthened(&self, id: &str, told_ms: i64, wait_ms: i64) -> i64 {
        let h = u64::from_str_radix(
            &crate::store::fnv1a_hex(&[&self.salt, id, "rate", &told_ms.to_string()]),
            16,
        )
        .unwrap_or(0);
        let bp = (h % (JITTER_BP as u64 + 1)) as i64;
        wait_ms + wait_ms * bp / 10_000
    }

    /// The interval to plan after a fetch (minutes) and why it is longer than normal
    fn base_interval(
        &self,
        slot: &Slot,
        latest: Option<&ProviderSnapshot>,
        interval_min: i64,
        now: i64,
    ) -> (i64, Option<Waiting>) {
        let interval = interval_min.max(crate::config::MIN_INTERVAL_MIN);
        let unchanged = |after: i64| {
            slot.last_values.is_some()
                && now - slot.last_change >= after * MINUTE_MS
                && latest.is_some_and(quiet)
        };
        if self.cfg.idle_long_interval_min > interval && unchanged(IDLE_LONG_AFTER_MIN) {
            return (self.cfg.idle_long_interval_min, Some(Waiting::Idle));
        }
        if self.cfg.idle_interval_min > interval && unchanged(IDLE_AFTER_MIN) {
            return (self.cfg.idle_interval_min, Some(Waiting::Idle));
        }
        (interval, None)
    }

    /// Plans the next active fetch after the attempt at `now` and keeps the plan
    fn plan(&mut self, id: &str, interval_min: i64, latest: Option<&ProviderSnapshot>, now: i64) {
        let slot = self.slots.get(id).cloned().unwrap_or_default();
        let (base, reason) = self.base_interval(&slot, latest, interval_min, now);
        let at = now + self.jittered(id, now, base * MINUTE_MS);
        let epoch = self.epoch;
        let slot = self.slot(id);
        slot.last_fetch = now;
        slot.plan_at = at;
        slot.plan_reason = reason;
        slot.epoch = epoch;
        self.save();
    }

    /// Time until which fetching is held off (no hold once it has passed)
    pub fn hold_until(&self, id: &str) -> i64 {
        self.slots.get(id).map_or(0, |s| s.hold_until)
    }

    /// Whether the provider is stopped by an access denial (on this PC's word or the destination's), and which stop
    pub fn denied(&self, id: &str) -> Option<u64> {
        self.slots
            .get(id)
            .filter(|s| s.denied)
            .map(|s| s.denied_gen)
    }

    /// When the agent next decides whether to fetch the provider, for `headroom status`. Read-only: it never changes the schedule.
    /// `fetch_due_ms` is the provider's own schedule (i64::MAX = none); providers already include a hold passed to them,
    /// so a hold that equals it is still reported with its reason. A stop (an access denial, an attempt whose result is unknown, a
    /// state that can't be read) is reported whatever the provider's schedule. Passive values put a fetch off only once
    /// `before_fetch` sees them
    pub fn next_run(&self, id: &str, fetch_due_ms: i64, now: i64) -> NextRun {
        let stopped = |w| NextRun {
            at_ms: None,
            waiting: Some(w),
            disabled: false,
            stop: None,
            attempt: None,
        };
        let slot = self.slots.get(id);
        if self.unreadable && !self.sharing {
            return stopped(Waiting::Unreadable);
        }
        if let Some(slot) = slot {
            // An attempt whose result is unknown, shown with a stop too (one command resumes both)
            let unknown = slot
                .attempt
                .as_ref()
                .filter(|a| {
                    a.state == AttemptState::Unknown
                        || (a.state == AttemptState::Started && slot.granted.is_none())
                })
                .and_then(|a| attempt_number(&a.id));
            if slot.denied {
                return NextRun {
                    stop: Some(slot.denied_gen),
                    attempt: unknown,
                    ..stopped(Waiting::Denied)
                };
            }
            if unknown.is_some() {
                return NextRun {
                    attempt: unknown,
                    ..stopped(Waiting::Unknown)
                };
            }
        }
        if fetch_due_ms == i64::MAX {
            return NextRun {
                at_ms: None,
                waiting: None,
                disabled: false,
                stop: None,
                attempt: None,
            };
        }
        let at = |at_ms, waiting| NextRun {
            at_ms: Some(at_ms),
            waiting,
            disabled: false,
            stop: None,
            attempt: None,
        };
        match slot {
            Some(slot) if slot.rate_until > now && slot.rate_until >= fetch_due_ms => {
                at(slot.rate_until, Some(Waiting::RateLimited))
            }
            Some(slot) if slot.hold_until > now && slot.hold_until >= fetch_due_ms => {
                at(slot.hold_until, slot.hold_reason)
            }
            Some(slot) if slot.plan_at > now && slot.plan_at >= fetch_due_ms => {
                at(slot.plan_at, slot.plan_reason)
            }
            _ => at(fetch_due_ms, None),
        }
    }

    /// Notices a clock that went back past this PC's last fetch or past the time a hold was set: the hold, the plan and the lease were
    /// set by the old clock (they could hold off for as long as it went back), so they are dropped and counted again from now. Called on
    /// every round before the provider's schedule is checked (a provider holding off by the same hold would never reach `before_fetch`).
    /// A rate limit's wait is kept no longer than its longest stage from now. true if it dropped a hold
    pub fn notice_clock(&mut self, id: &str, now: i64) -> bool {
        let Ok(_lock) = self.locked() else {
            return false;
        };
        self.reload();
        self.notice_clock_locked(id, now)
    }

    /// notice_clock under the lock already held
    fn notice_clock_locked(&mut self, id: &str, now: i64) -> bool {
        let Some(slot) = self.slots.get_mut(id) else {
            return false;
        };
        if slot.last_fetch <= now && slot.hold_set_at <= now {
            return false;
        }
        slot.last_fetch = slot.last_fetch.min(now);
        slot.last_change = slot.last_change.min(now);
        slot.joined_at = slot.joined_at.min(now);
        slot.hold_until = 0;
        slot.hold_reason = None;
        slot.hold_set_at = 0;
        slot.plan_at = 0;
        slot.plan_reason = None;
        if slot.rate_until > now && slot.rate_set_at > now {
            slot.rate_until = now + (slot.rate_until - slot.rate_set_at).max(0);
            slot.rate_set_at = now;
        }
        self.save();
        true
    }

    /// Follows the clock epoch usable now. What a slot made in another epoch (its plan, its hold, the values and the start of the
    /// unchanged stretch) is dropped: the values it followed are gone. In the same epoch (a restart) it stands. Without a usable epoch
    /// nothing is dropped (nothing is fetched meanwhile). The attempt and the stops are kept in every epoch. true if a hold was dropped
    /// (the providers are told)
    pub fn follow_epoch(&mut self, epoch: Option<u64>) -> bool {
        self.epoch = epoch;
        let Some(e) = epoch else {
            return false;
        };
        // Read again under the lock first: nothing saved here writes over what the file holds now
        let Ok(_lock) = self.locked() else {
            return false;
        };
        self.reload();
        let mut dropped = false;
        let mut changed = false;
        for slot in self.slots.values_mut().filter(|s| s.epoch != Some(e)) {
            dropped |= slot.hold_until != 0;
            slot.plan_at = 0;
            slot.plan_reason = None;
            slot.hold_until = 0;
            slot.hold_reason = None;
            slot.hold_set_at = 0;
            slot.last_values = None;
            slot.last_state = None;
            slot.last_change = 0;
            slot.epoch = Some(e);
            changed = true;
        }
        if changed {
            self.save();
        }
        dropped
    }

    /// Holds the provider off until `until` for `reason` and returns false (not fetching now)
    fn hold(&mut self, id: &str, until: i64, reason: Option<Waiting>, now: i64) -> bool {
        let slot = self.slot(id);
        slot.hold_until = until;
        slot.hold_reason = reason;
        slot.hold_set_at = now;
        false
    }

    /// Takes the destination's word on the provider's shared state
    fn take_shared(&mut self, id: &str, shared: Shared, now: i64) {
        let slot = self.slot(id);
        if shared.denied && !(slot.denied && slot.denied_gen == shared.denied_gen) {
            slot.denied_since = now;
        }
        slot.denied = shared.denied;
        slot.denied_gen = shared.denied_gen;
        slot.rate_stage = shared.rate_stage;
        slot.rate_until = if shared.rate_wait_ms > 0 {
            now + shared.rate_wait_ms
        } else {
            0
        };
        slot.rate_set_at = now;
        slot.base = Some(shared.version);
    }

    /// The stops a result starts or ends on this PC's own word (a PC that doesn't share; one that does until the destination answers)
    fn take_result(&mut self, id: &str, kind: Kind, r: Reported, interval_min: i64, now: i64) {
        let sharing = self.sharing;
        let stage_after = (self.slot(id).rate_stage + 1).min(RATE_STAGES_MIN.len() as u32);
        let rate_wait = match r {
            Reported::RateLimited { retry_ms } => self.lengthened(
                id,
                now,
                (RATE_STAGES_MIN[stage_after as usize - 1] * MINUTE_MS)
                    .max(interval_min * MINUTE_MS)
                    .max(retry_ms.unwrap_or(0)),
            ),
            _ => 0,
        };
        let slot = self.slot(id);
        match r {
            Reported::Ok => {
                slot.rate_stage = 0;
                slot.rate_until = 0;
                if kind == Kind::Resume && !sharing {
                    slot.denied = false;
                }
            }
            Reported::RateLimited { .. } => {
                // The stage's wait (at least the interval and the wait named), lengthened a little (lengthened)
                slot.rate_stage = stage_after;
                slot.rate_until = now + rate_wait;
                slot.rate_set_at = now;
            }
            Reported::AccessDenied => {
                if !slot.denied {
                    slot.denied = true;
                    slot.denied_gen += 1;
                    slot.denied_since = now;
                }
            }
            Reported::Failed | Reported::NotRun => {}
        }
    }

    /// The lease (minutes) a successful planned fetch takes: until the next plan (or the provider's own later fetch) plus the margin
    fn lease_min(&self, id: &str, next_fetch_ms: i64, now: i64) -> i64 {
        let plan = self.slots.get(id).map_or(0, |s| s.plan_at);
        if next_fetch_ms == i64::MAX {
            return 0;
        }
        let need = next_fetch_ms
            .max(plan)
            .saturating_add(TURN_GRACE_MIN * MINUTE_MS);
        ((need - now + MINUTE_MS - 1) / MINUTE_MS).clamp(1, LEASE_MAX_MIN)
    }

    /// For a provider whose fetch is due (or that the user asks to fetch), decides whether it may fetch now. If holding off, sets
    /// `hold_until` and returns false. `passive` is the provider's passive values in use (None: none), `last_attempt` the provider's own
    /// record of its last active fetch (also one made outside this coordinator). In order: a state that can't be read (a PC that doesn't
    /// share), an attempt whose result is unknown (only the user's force goes on), a result not acknowledged yet (sent first), the shared
    /// stops (asked again while stopped), then by the plan, the passive values and the stretch (Auto only), and the destination's go
    #[allow(clippy::too_many_arguments)]
    pub fn before_fetch(
        &mut self,
        id: &str,
        interval_min: i64,
        latest: Option<&ProviderSnapshot>,
        passive: Option<&Passive>,
        last_attempt: Option<i64>,
        mode: Mode,
        mut asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) -> bool {
        let Ok(_lock) = self.locked() else {
            return self.hold(id, now + MINUTE_MS, Some(Waiting::Unconfirmed), now);
        };
        self.reload();
        let own_ms = self.cfg.own_fetch_min.max(1) * MINUTE_MS;
        let interval = interval_min.max(crate::config::MIN_INTERVAL_MIN);
        let recheck = |now: i64| now + UNCONFIRMED_RECHECK_MIN * MINUTE_MS;
        self.notice_clock_locked(id, now);
        if self.unreadable && !self.sharing {
            return self.hold(id, now + 60 * MINUTE_MS, Some(Waiting::Unreadable), now);
        }
        if self.slot(id).joined_at == 0 {
            self.slot(id).joined_at = now;
            self.save();
        }
        // An attempt a run started and never checked (an earlier owner of this PC's state: only the agent.lock's holder runs rounds):
        // its result is unknown. Only the user's explicit replacement of that attempt goes on (the destination replaces it only once it
        // is old enough)
        let started = self.slot(id).attempt.clone();
        let mut replacing: Option<String> = None;
        // The attempt being replaced, given back if the destination refuses the replacement
        let mut replaced: Option<Attempt> = None;
        // A replacement of it asked for earlier and not answered (no budget, an answer lost) is asked again as it was
        if let Some(r) = mode.replace()
            && let Some(a) = started.as_ref().filter(|a| {
                a.state == AttemptState::Asking
                    && a.replace.as_deref().and_then(attempt_number) == Some(r)
            })
        {
            replacing = a.replace.clone();
            replaced = a.replaced.as_deref().cloned();
        } else if let Some(r) = mode.replace()
            && !started.as_ref().is_some_and(|a| {
                matches!(a.state, AttemptState::Started | AttemptState::Unknown)
                    && attempt_number(&a.id) == Some(r)
            })
        {
            // Not the attempt standing now (it ended, or another one stands): nothing is replaced, and nothing is fetched for it
            self.log.log(&format!(
                "{id}: fetch attempt {r:016x} doesn't wait to be replaced (see headroom status); nothing was fetched"
            ));
            return false;
        }
        if let Some(a) =
            started.filter(|a| matches!(a.state, AttemptState::Started | AttemptState::Unknown))
        {
            let number = attempt_number(&a.id);
            if number.is_none() || mode.replace() != number {
                if a.state == AttemptState::Started {
                    self.slot(id).attempt = Some(Attempt {
                        state: AttemptState::Unknown,
                        ..a.clone()
                    });
                    self.save();
                }
                self.log.log(&format!(
                    "{id}: the result of fetch attempt {} couldn't be checked; fetching stops until headroom collect --provider {id} --force --replace {}",
                    a.id, a.id
                ));
                return self.hold(id, now + 60 * MINUTE_MS, Some(Waiting::Unknown), now);
            }
            // A PC that doesn't share replaces it no sooner than 5 minutes after it began (the destination does the same)
            if !self.sharing && now - a.at < REPLACE_AFTER_MS {
                self.log.log(&format!(
                    "{id}: fetch attempt {} began less than 5 minutes ago; replace it after that",
                    a.id
                ));
                return self.hold(id, a.at + REPLACE_AFTER_MS, Some(Waiting::Unknown), now);
            }
            replacing = Some(a.id.clone());
            replaced = Some(a.clone());
            self.slot(id).attempt = None;
        }
        // A result not acknowledged yet goes first (the next attempt waits for it), and while stopped the destination is asked again
        if !self.upkeep(
            id,
            interval,
            asker.as_mut().map(|a| &mut **a as &mut dyn TurnAsker),
            now,
        ) {
            let until = self.slot(id).resend_at.max(now + MINUTE_MS);
            return self.hold(id, until, Some(Waiting::Unconfirmed), now);
        }
        // A sharing PC makes an attempt against the version of the destination's row it saw last: read once when none is known
        if self.sharing && self.slot(id).base.is_none() {
            let shared = asker
                .as_mut()
                .and_then(|a| a.ask(id, Ask::peek()))
                .and_then(|a| a.shared);
            match shared {
                Some(shared) => {
                    self.take_shared(id, shared, now);
                    self.save();
                }
                None => return self.hold(id, recheck(now), Some(Waiting::Unconfirmed), now),
            }
        }
        // A manual attempt (force, resume) whose answer was lost, met by a round of another request: it ends as not run, and nothing of
        // it is done, before a stop or a wait standing is looked at (its reservation at the destination goes with the result)
        let manual = |k: Kind| matches!(k, Kind::Force | Kind::Resume);
        let asked_manual = match mode {
            Mode::Force { .. } => Some(Kind::Force),
            Mode::Resume { .. } => Some(Kind::Resume),
            Mode::Auto | Mode::Accept => None,
        };
        if self.sharing
            && let Some(a) = self.slot(id).attempt.clone().filter(|a| {
                a.state == AttemptState::Asking
                    && manual(a.kind)
                    && !(asked_manual == Some(a.kind) && a.stop == mode_stop(mode, a.kind))
            })
        {
            self.slot(id).attempt = Some(Attempt {
                state: AttemptState::Done(Reported::NotRun),
                ..a
            });
            self.save();
            self.log.log(&format!(
                "{id}: a manual fetch asked for earlier (its answer lost) ends as not run; nothing of it is done now"
            ));
            return self.hold(id, now + MINUTE_MS, Some(Waiting::Unconfirmed), now);
        }
        let slot = self.slot(id).clone();
        if slot.denied && !matches!(mode, Mode::Resume { .. }) {
            return self.hold(
                id,
                now + STOP_RECHECK_MIN * MINUTE_MS,
                Some(Waiting::Denied),
                now,
            );
        }
        if slot.rate_until > now {
            return self.hold(id, slot.rate_until, Some(Waiting::RateLimited), now);
        }
        let origin = if slot.last_fetch > 0 {
            slot.last_fetch
        } else {
            slot.joined_at
        };
        let kind = match mode {
            Mode::Force { .. } => Kind::Force,
            Mode::Accept => Kind::Fetch,
            Mode::Resume { stop, .. } if slot.denied && stop == slot.denied_gen => Kind::Resume,
            Mode::Resume { stop, .. } => {
                self.log.log(&if slot.denied {
                    format!(
                        "{id}: the stop now is {} (not {stop}); check headroom status, then resume that one",
                        slot.denied_gen
                    )
                } else {
                    format!("{id}: not stopped by an access denial; nothing to resume")
                });
                return false;
            }
            Mode::Auto => {
                if slot.hold_until > now {
                    return false;
                }
                // The plan made after the last fetch (jittered; stretched while nothing changes)
                if slot.plan_at > now {
                    return self.hold(id, slot.plan_at, slot.plan_reason, now);
                }
                // Passive values received within an interval put the active fetch off, but no further than the longest stretch
                // after the last active fetch (or after this PC first took part: a restart doesn't move it), so the limits the
                // statusLine doesn't carry are fetched still. Only values received after the last active fetch count (one it
                // replaced says nothing new), only ones that carry every overall limit, and none received before a reached limit's
                // reset (the fetch that sees a reset is never put off past it)
                let attempted = slot.last_fetch.max(last_attempt.unwrap_or(0));
                if let Some(p) =
                    passive.filter(|p| p.at_ms <= now && p.at_ms > attempted && covers(p, latest))
                {
                    let cap = origin + self.cfg.idle_long_interval_min.max(interval) * MINUTE_MS;
                    // One interval from their receipt, with no jitter that could make it shorter
                    let until = (p.at_ms + interval * MINUTE_MS).min(cap);
                    if until > now {
                        return self.hold(id, until, Some(Waiting::Passive), now);
                    }
                }
                // Not fetched on this PC for the safety net's time: its own fetch (passes another PC's lease, one at a time)
                if now - origin >= own_ms {
                    Kind::Own
                } else {
                    Kind::Fetch
                }
            }
        };
        if !self.sharing {
            // A PC that doesn't share decides alone
            let aid = self.new_attempt(id, now);
            self.slot(id).attempt = Some(Attempt::new(aid, kind, AttemptState::Started, now));
            if !self.save() {
                self.slot(id).attempt = None;
                return self.hold(id, now + MINUTE_MS, Some(Waiting::Unconfirmed), now);
            }
            let s = self.slot(id);
            s.granted = Some(crate::providers::Grant {
                until_ms: now + GRANT_VALID_MS,
                until: Instant::now() + Duration::from_millis(GRANT_VALID_MS as u64),
            });
            s.granted_attempt = s.attempt.as_ref().map(|a| a.id.clone());
            // Fetching now: a hold from before (a stop the user just resumed, a wait) no longer stands
            s.hold_until = 0;
            s.hold_reason = None;
            return true;
        }
        let Some(asker) = asker else {
            if self.slot(id).hold_reason != Some(Waiting::Unconfirmed) {
                self.log.log(&format!(
                    "{id}: can't ask the destination for the fetch turn; waiting"
                ));
            }
            return self.hold(id, recheck(now), Some(Waiting::Unconfirmed), now);
        };
        // An attempt whose answer was lost is asked for again as it was: its id, kind, stop, replacement and row version (the
        // destination grants an attempt once, and only as it was granted; a fetch asked again past this PC's own fetch time stays a fetch)
        let mut moved_once = false;
        loop {
            let slot = self.slot(id).clone();
            let attempt = match &slot.attempt {
                Some(a) if a.state == AttemptState::Asking => a.clone(),
                _ => Attempt {
                    // The stop the user confirmed (never one read meanwhile)
                    stop: mode_stop(mode, kind),
                    replace: replacing.clone(),
                    replaced: replaced.clone().map(Box::new),
                    base: slot.base,
                    ..Attempt::new(self.new_attempt(id, now), kind, AttemptState::Asking, now)
                },
            };
            let again = slot
                .attempt
                .as_ref()
                .is_some_and(|a| a.state == AttemptState::Asking && a.id == attempt.id);
            match self.ask_turn(
                id,
                attempt,
                again,
                &mut *asker,
                origin,
                own_ms,
                interval,
                now,
            ) {
                Asked::Moved if !moved_once => moved_once = true,
                Asked::Moved => {
                    self.give_back(id, replaced.take());
                    return self.hold(id, now + MINUTE_MS, Some(Waiting::Unconfirmed), now);
                }
                Asked::Go => return true,
                Asked::No(Some(Reason::Gone)) => return false,
                Asked::No(_) => {
                    self.give_back(id, replaced.take());
                    return false;
                }
            }
        }
    }

    /// Asks the destination for the turn of one attempt (saved as asking first) and takes its answer
    #[allow(clippy::too_many_arguments)]
    fn ask_turn(
        &mut self,
        id: &str,
        attempt: Attempt,
        again: bool,
        asker: &mut dyn TurnAsker,
        origin: i64,
        own_ms: i64,
        interval: i64,
        now: i64,
    ) -> Asked {
        let recheck = |now: i64| now + UNCONFIRMED_RECHECK_MIN * MINUTE_MS;
        let before = self.slot(id).attempt.clone();
        let (aid, kind) = (attempt.id.clone(), attempt.kind);
        self.slot(id).attempt = Some(attempt.clone());
        if !self.save() {
            self.slot(id).attempt = before;
            self.hold(id, now + MINUTE_MS, Some(Waiting::Unconfirmed), now);
            return Asked::No(None);
        }
        // The go is good for GRANT_VALID_MS from right before the request (a late answer never lengthens it)
        let asked = Instant::now();
        let request = Ask {
            kind,
            attempt: Some(&aid),
            stop: attempt.stop,
            base: attempt.base,
            replace: attempt.replace.as_deref(),
            again,
        };
        let Some(answer) = asker.ask(id, request) else {
            if self.slot(id).hold_reason != Some(Waiting::Unconfirmed) {
                self.log.log(&format!(
                    "{id}: couldn't ask the destination for the fetch turn; waiting"
                ));
            }
            self.hold(id, recheck(now), Some(Waiting::Unconfirmed), now);
            return Asked::No(None);
        };
        if let Some(shared) = answer.shared {
            self.take_shared(id, shared, now);
        }
        if answer.go {
            let s = self.slot(id);
            s.attempt = Some(Attempt {
                state: AttemptState::Started,
                ..attempt.clone()
            });
            if !self.save() {
                // The start can't be recorded: not started (the same id is asked for again, and granted again)
                self.slot(id).attempt = Some(attempt);
                self.hold(id, now + MINUTE_MS, Some(Waiting::Unconfirmed), now);
                return Asked::No(None);
            }
            let s = self.slot(id);
            // Both deadlines from right before the request: `now` was read before it (a late answer never lengthens them)
            s.granted = Some(crate::providers::Grant {
                until_ms: now + GRANT_VALID_MS,
                until: asked + Duration::from_millis(GRANT_VALID_MS as u64),
            });
            s.granted_attempt = Some(aid.clone());
            s.hold_until = 0;
            s.hold_reason = None;
            if s.deferring || kind != Kind::Fetch {
                s.deferring = false;
                self.log.log(&match kind {
                    Kind::Own => format!("{id}: fetching on this PC (its own fetch)"),
                    Kind::Force => format!("{id}: fetching as forced"),
                    Kind::Resume => format!("{id}: trying to fetch again after the access denial"),
                    _ => format!("{id}: took the fetch turn"),
                });
            }
            return Asked::Go;
        }
        // Nothing decided (no budget, a race): the attempt stays as asked (an earlier copy of it may have been granted)
        if matches!(answer.reason, Some(Reason::Unavailable) | None) {
            self.hold(id, recheck(now), Some(Waiting::Unconfirmed), now);
            return Asked::No(None);
        }
        // Refused: the request is over (the destination marked no attempt of it)
        self.slot(id).attempt = None;
        self.save();
        if answer.reason == Some(Reason::Moved) {
            return Asked::Moved;
        }
        let held = match answer.reason {
            Some(Reason::Turn) => {
                let slot = self.slot(id);
                if !slot.deferring {
                    slot.deferring = true;
                    self.log
                        .log(&format!("{id}: another PC holds the fetch turn; deferring"));
                }
                // Ask again when the lease ends, but no later than the longest jittered interval plus the margin from now (a holder
                // that stopped is replaced within that time), and no later than this PC's own fetch
                let longest = now
                    + (interval * MINUTE_MS * (10_000 + JITTER_BP) / 10_000
                        + TURN_GRACE_MIN * MINUTE_MS)
                        .min(TURN_RECHECK_MAX_MIN * MINUTE_MS);
                let mut until = (now + answer.wait_ms.max(0) + RETRY_AFTER_MS).min(longest);
                if origin + own_ms > now {
                    until = until.min(origin + own_ms);
                }
                self.hold(id, until, Some(Waiting::Turn), now)
            }
            Some(Reason::Pending) => self.hold(id, recheck(now), Some(Waiting::Pending), now),
            Some(Reason::RateLimited) => {
                let slot = self.slot(id);
                if slot.rate_until <= now {
                    slot.rate_until = now + answer.wait_ms.max(MINUTE_MS);
                    slot.rate_set_at = now;
                }
                let until = slot.rate_until;
                self.save();
                self.hold(id, until, Some(Waiting::RateLimited), now)
            }
            Some(Reason::AccessDenied) => {
                let slot = self.slot(id);
                if !slot.denied {
                    slot.denied = true;
                    slot.denied_since = now;
                }
                self.save();
                self.hold(
                    id,
                    now + STOP_RECHECK_MIN * MINUTE_MS,
                    Some(Waiting::Denied),
                    now,
                )
            }
            Some(Reason::StaleGen) => {
                self.log.log(&format!(
                    "{id}: that stop is over or another one stands (see headroom status); nothing was fetched"
                ));
                false
            }
            Some(Reason::Gone) => {
                self.log.log(&format!(
                    "{id}: the fetch attempt named isn't pending any more (its result came, or it was replaced); nothing was replaced or fetched. Run the command headroom status shows"
                ));
                false
            }
            Some(Reason::Unavailable | Reason::Moved) | None => false,
        };
        let _ = held;
        Asked::No(answer.reason)
    }

    /// What goes on whatever the provider's fetch schedule (every round, also with no fetch due or one held for ever): a result not
    /// acknowledged yet is sent again, as it was (its outcome and lease), and while stopped the destination is asked again now and then.
    /// Nothing goes upstream. Locked and read again (a manual collect may have written the file)
    pub fn maintain(
        &mut self,
        id: &str,
        interval_min: i64,
        asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) {
        if !self.sharing || asker.is_none() {
            return;
        }
        let Ok(_lock) = self.locked() else {
            return;
        };
        self.reload();
        if self.slots.contains_key(id) {
            let interval = interval_min.max(crate::config::MIN_INTERVAL_MIN);
            self.upkeep(id, interval, asker, now);
        }
    }

    /// The attempt a refused replacement was for is given back as it was (its result still unknown)
    fn give_back(&mut self, id: &str, replaced: Option<Attempt>) {
        if let Some(a) = replaced
            && self.slot(id).attempt.is_none()
        {
            self.slot(id).attempt = Some(a);
            self.save();
        }
    }

    /// The upkeep under the lock: false while a result waits to be acknowledged (no next attempt meanwhile)
    fn upkeep(
        &mut self,
        id: &str,
        interval: i64,
        mut asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) -> bool {
        // What couldn't be saved is saved first: nothing is reported or asked before it is
        if self.slot(id).unsaved && !self.save() {
            return false;
        }
        if let Some(Attempt {
            id: aid,
            kind,
            state: AttemptState::Done(r),
            lease,
            interval: fixed,
            stop,
            ..
        }) = self.slot(id).attempt.clone()
        {
            if !self.sharing {
                self.slot(id).attempt = None;
                self.save();
            } else {
                if now < self.slot(id).resend_at {
                    return false;
                }
                let Some(asker) = asker.as_deref_mut() else {
                    return false;
                };
                let interval = if fixed > 0 { fixed } else { interval };
                let Some(ack) = asker.report(id, &aid, kind, r, interval, lease) else {
                    self.resend_later(id, now);
                    return false;
                };
                if !resume_ack_fits(kind, r, stop, &ack) {
                    self.resend_later(id, now);
                    return false;
                }
                let applied = ack.applied;
                let back = self
                    .slot(id)
                    .attempt
                    .as_ref()
                    .and_then(|a| a.replaced.clone());
                self.acknowledged(id, &aid, kind, r, lease, ack, now);
                // A replacement that never began (not pending at the destination): the attempt it was for stands again as it was, so
                // the user can replace it
                if !applied
                    && r == Reported::NotRun
                    && let Some(x) = back
                    && self.slot(id).attempt.is_none()
                {
                    self.slot(id).attempt = Some(*x);
                    self.save();
                }
            }
        }
        // While stopped, a PC that shares asks the destination again now and then (another PC may have resumed, or the wait moved)
        let stopped = {
            let s = self.slot(id);
            s.denied || s.rate_until > now
        };
        if self.sharing
            && stopped
            && now - self.slot(id).peeked_at >= STOP_RECHECK_MIN * MINUTE_MS
            && let Some(asker) = asker
        {
            self.slot(id).peeked_at = now;
            if let Some(shared) = asker.ask(id, Ask::peek()).and_then(|a| a.shared) {
                self.take_shared(id, shared, now);
                self.save();
            }
        }
        true
    }

    /// A result whose send failed is sent again after 1, 2, 4, then every 5 minutes
    fn resend_later(&mut self, id: &str, now: i64) {
        let slot = self.slot(id);
        slot.resend_fails = slot.resend_fails.saturating_add(1);
        let minutes = (1i64 << (slot.resend_fails - 1).min(3)).min(5);
        slot.resend_at = now + minutes * MINUTE_MS;
    }

    /// The destination acknowledged the attempt's result: it is over. Only one applied takes (or ends) the lease
    #[allow(clippy::too_many_arguments)]
    fn acknowledged(
        &mut self,
        id: &str,
        aid: &str,
        kind: Kind,
        r: Reported,
        lease: i64,
        ack: Ack,
        now: i64,
    ) {
        self.take_shared(id, ack.shared, now);
        let slot = self.slot(id);
        slot.resend_at = 0;
        slot.resend_fails = 0;
        if ack.applied && lease > 0 {
            slot.lease_attempt = Some(aid.to_string());
        } else if ack.applied && kind == Kind::Fetch && r != Reported::NotRun {
            slot.lease_attempt = None;
        }
        slot.attempt = None;
        self.save();
    }

    /// When the upkeep of any provider is next due (a result's resend, a stop's recheck): the agent wakes for it
    /// `running`: the providers this agent runs (a stop's recheck is theirs only; a result is sent for any)
    pub fn next_upkeep(&self, running: &[&str], now: i64) -> i64 {
        if !self.sharing {
            return i64::MAX;
        }
        self.slots
            .iter()
            .filter_map(|(id, s)| {
                let resend = s
                    .attempt
                    .as_ref()
                    .is_some_and(|a| matches!(a.state, AttemptState::Done(_)))
                    .then_some(s.resend_at);
                // While stopped, as the upkeep sees it (a wait that is over needs no recheck)
                let peek = (running.contains(&id.as_str()) && (s.denied || s.rate_until > now))
                    .then_some(s.peeked_at + STOP_RECHECK_MIN * MINUTE_MS);
                resend.into_iter().chain(peek).min()
            })
            .min()
            .unwrap_or(i64::MAX)
    }

    /// A stop of an access denial the PC's last values show while its plan has none (the plan file was lost): kept as a stop until the
    /// user resumes it, as one this PC found. A PC that shares reads the destination's instead
    pub fn keep_denied(&mut self, id: &str, now: i64) {
        if self.sharing {
            return;
        }
        let Ok(_lock) = self.locked() else {
            return;
        };
        self.reload();
        let slot = self.slot(id);
        if slot.denied {
            return;
        }
        slot.denied = true;
        slot.denied_gen = slot.denied_gen.max(1);
        slot.denied_since = now;
        self.save();
        self.log.log(&format!(
            "{id}: the fetch state was gone; the access denial its last values show stays a stop (resume with headroom collect --provider {id} --resume-access 1)"
        ));
    }

    /// The upkeep of providers this agent doesn't run (turned off): a result not acknowledged is sent, and an attempt only asked for
    /// (it never started: the provider is off) ends as not run. Nothing is fetched for them
    pub fn maintain_others(
        &mut self,
        running: &[&str],
        mut asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) {
        if !self.sharing || asker.is_none() {
            return;
        }
        let Ok(_lock) = self.locked() else {
            return;
        };
        self.reload();
        let others: Vec<String> = self
            .slots
            .iter()
            .filter(|(id, s)| !running.contains(&id.as_str()) && s.attempt.is_some())
            .map(|(id, _)| id.clone())
            .collect();
        for id in others {
            if let Some(a) = self.slot(&id).attempt.as_mut()
                && a.state == AttemptState::Asking
            {
                a.state = AttemptState::Done(Reported::NotRun);
                self.save();
            }
            let floor = crate::config::MIN_INTERVAL_MIN;
            self.upkeep(
                &id,
                floor,
                asker.as_mut().map(|a| &mut **a as &mut dyn TurnAsker),
                now,
            );
        }
    }

    /// The go of the provider's attempt in progress, with its deadlines as fixed when it was asked for: the provider starts no query
    /// past it
    pub fn grant(&self, id: &str) -> Option<crate::providers::Grant> {
        self.slots.get(id)?.granted
    }

    /// After a collect the coordinator allowed: what it did upstream (`run`; None from a provider that doesn't say, read from the
    /// snapshot). Nothing upstream: nothing is planned and the attempt ends. A query: the next fetch is planned from it, the stops it
    /// started or ended are taken, and its result is reported (with the lease a successful planned fetch takes) until acknowledged. A
    /// query whose result is unknown holds the provider until the user's force (it isn't reported: the destination keeps it pending).
    /// `next_fetch_ms` is the provider's own next fetch (its backoff, or the wait while a limit is reached)
    #[allow(clippy::too_many_arguments)]
    pub fn after_fetch(
        &mut self,
        id: &str,
        run: Option<Run>,
        snapshot: &ProviderSnapshot,
        next_fetch_ms: i64,
        interval_min: i64,
        asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) {
        let lock = self.locked();
        if lock.is_ok() {
            self.reload();
        }
        let interval = interval_min.max(crate::config::MIN_INTERVAL_MIN);
        self.slot(id).granted = None;
        let mine = self.slot(id).granted_attempt.take();
        let reported = match run {
            Some(Run::NotRun) => Reported::NotRun,
            Some(Run::Ran(o)) => Reported::from_outcome(o),
            // The query may have run, its result can't be checked (a provider that doesn't say what it did is taken the same way:
            // a cached value is never taken for this attempt's success)
            Some(Run::Unknown) | None => {
                self.plan(id, interval, Some(snapshot), now);
                if let Some(a) = self
                    .slot(id)
                    .attempt
                    .as_mut()
                    .filter(|a| Some(&a.id) == mine.as_ref())
                {
                    a.state = AttemptState::Unknown;
                    let shown = a.id.clone();
                    if lock.is_err() || !self.save() {
                        self.slot(id).unsaved = true;
                    }
                    self.log.log(&format!(
                        "{id}: the result of fetch attempt {shown} couldn't be checked; fetching stops until headroom collect --provider {id} --force --replace {shown}"
                    ));
                }
                return;
            }
        };
        let Some(attempt) = self
            .slot(id)
            .attempt
            .clone()
            .filter(|a| a.state == AttemptState::Started && Some(&a.id) == mine.as_ref())
        else {
            // No attempt of this coordinator (one asked for by another process meanwhile): only the plan
            if reported != Reported::NotRun {
                self.plan(id, interval, Some(snapshot), now);
            }
            return;
        };
        if reported == Reported::NotRun {
            self.log.log(&format!(
                "{id}: allowed to fetch, but nothing was fetched; the plan stays"
            ));
            let slot = self.slot(id);
            slot.not_run = slot.not_run.saturating_add(1);
            let wait = (1i64 << (slot.not_run - 1).min(6)).min(60) * MINUTE_MS;
            self.hold(id, now + wait, Some(Waiting::NothingRun), now);
        } else {
            self.slot(id).not_run = 0;
            self.plan(id, interval, Some(snapshot), now);
        }
        self.take_result(id, attempt.kind, reported, interval, now);
        let lease = if attempt.kind == Kind::Fetch && reported == Reported::Ok {
            self.lease_min(id, next_fetch_ms, now)
        } else {
            0
        };
        self.slot(id).attempt = Some(Attempt {
            state: AttemptState::Done(reported),
            lease,
            interval,
            ..attempt.clone()
        });
        // Kept before it is reported: one that can't be saved now stays in memory (over what the file says) and is saved, then
        // reported, by the next upkeep
        if lock.is_err() || !self.save() {
            self.slot(id).unsaved = true;
            self.log.log(&format!(
                "{id}: couldn't save the fetch result; kept, and saved and reported next round"
            ));
            return;
        }
        if !self.sharing {
            self.slot(id).attempt = None;
            self.save();
            return;
        }
        let Some(asker) = asker else {
            return;
        };
        match asker.report(id, &attempt.id, attempt.kind, reported, interval, lease) {
            // The first report checked as a resend is
            Some(ack) if resume_ack_fits(attempt.kind, reported, attempt.stop, &ack) => {
                self.acknowledged(id, &attempt.id, attempt.kind, reported, lease, ack, now)
            }
            _ => self.resend_later(id, now),
        }
    }

    /// Hands back the lease this PC's successful fetch took, so another PC can take over at its next check (called when the agent
    /// stops, and when the destination refuses this PC's clock)
    pub fn release_turns(&mut self, asker: Option<&mut dyn TurnAsker>) {
        let Some(asker) = asker else {
            return;
        };
        let _lock = self.locked();
        self.reload();
        let leases: Vec<(String, String)> = self
            .slots
            .iter()
            .filter_map(|(id, s)| s.lease_attempt.clone().map(|a| (id.clone(), a)))
            .collect();
        for (id, aid) in leases {
            let released = asker.ask(&id, Ask::release(&aid)).is_some();
            if released {
                self.slot(&id).lease_attempt = None;
            }
            self.log.log(&release_message(&id, released));
        }
        self.save();
    }

    /// The provider fetched on its own without the coordinator (e.g. the fetch following the version check at startup): the next fetch
    /// is planned from it
    pub fn record_fetch(
        &mut self,
        id: &str,
        interval_min: i64,
        latest: Option<&ProviderSnapshot>,
        now: i64,
    ) {
        let _lock = self.locked();
        self.reload();
        self.plan(id, interval_min, latest, now);
    }

    /// The value shown and sent for the provider: while stopped by an access denial, the stop (a safety stop is shown first; both need
    /// the user), with its windows as they were fetched
    pub fn overlay(&self, id: &str, mut snapshot: ProviderSnapshot) -> ProviderSnapshot {
        if self.denied(id).is_some()
            && !matches!(
                snapshot.error_code,
                Some(ErrorCode::SafetyStop | ErrorCode::AccountChanged)
            )
        {
            snapshot.status = ProviderStatus::Error;
            snapshot.error = Some(DENIED_TEXT.to_string());
            snapshot.error_code = Some(ErrorCode::AccessDenied);
        }
        snapshot
    }

    /// Records value and state changes from a collect result (used to decide on stretching the interval). A change ends a stretch: a
    /// plan stretched while nothing changed comes back to the normal interval after the last fetch. true if the hold the provider was
    /// given changed (it is told again)
    pub fn observe(
        &mut self,
        id: &str,
        snapshot: &ProviderSnapshot,
        interval_min: i64,
        now: i64,
    ) -> bool {
        let values: Vec<_> = snapshot
            .windows
            .iter()
            .map(|w| (w.id.clone(), w.used_percent.to_bits(), w.resets_at.clone()))
            .collect();
        let state = format!(
            "{:?}/{:?}/{:?}/{:?}",
            snapshot.status, snapshot.error_code, snapshot.blocked, snapshot.history_since
        );
        let slot = self.slot(id).clone();
        if slot.last_values.as_ref() == Some(&values) && slot.last_state.as_ref() == Some(&state) {
            return false;
        }
        let interval = interval_min.max(crate::config::MIN_INTERVAL_MIN);
        let normal = (slot.plan_reason == Some(Waiting::Idle) && slot.last_fetch > 0)
            .then(|| slot.last_fetch + self.jittered(id, slot.last_fetch, interval * MINUTE_MS));
        let _lock = self.locked();
        self.reload();
        let slot = self.slot(id);
        slot.last_values = Some(values);
        slot.last_state = Some(state);
        slot.last_change = now;
        let mut told = false;
        // A wait for passive values made before this change is decided again (a limit reached since may need its fetch sooner)
        if slot.hold_reason == Some(Waiting::Passive) {
            slot.hold_until = 0;
            slot.hold_reason = None;
            told = true;
        }
        if let Some(normal) = normal {
            slot.plan_at = slot.plan_at.min(normal);
            slot.plan_reason = None;
            if slot.hold_reason == Some(Waiting::Idle) {
                slot.hold_until = slot.plan_at;
                slot.hold_reason = None;
                told = true;
            }
        }
        self.save();
        told
    }
}

fn release_message(id: &str, released: bool) -> String {
    if released {
        format!("{id}: released the fetch turn")
    } else {
        format!("{id}: could not release the fetch turn (it ends when its lease expires)")
    }
}

/// Fetches succeed, and there are overall limits, all far from full
fn quiet(p: &ProviderSnapshot) -> bool {
    let mut overall = p.windows.iter().filter(|w| w.scope.is_none()).peekable();
    p.status == ProviderStatus::Ok
        && p.error_code.is_none()
        && p.blocked != Some(true)
        && overall.peek().is_some()
        && overall.all(|w| w.used_percent < IDLE_MAX_PERCENT)
}

/// Whether passive values may put the active fetch off: they carry every overall limit of the latest values, and while an overall limit
/// is reached, they were received after its reset (the fetch that sees the reset is never put off past it; a reached limit without a
/// reset time is left to that fetch too)
fn covers(p: &Passive, latest: Option<&ProviderSnapshot>) -> bool {
    let Some(latest) = latest else {
        return false;
    };
    let overall: Vec<_> = latest
        .windows
        .iter()
        .filter(|w| w.scope.is_none())
        .collect();
    if overall.is_empty() || !overall.iter().all(|w| p.windows.contains(&w.id)) {
        return false;
    }
    overall.iter().filter(|w| w.used_percent >= 100.0).all(|w| {
        w.resets_at
            .as_deref()
            .and_then(crate::providers::gemini::ms_from_iso)
            .is_some_and(|reset| p.at_ms > reset)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{UsageWindow, WindowKind};
    use std::cell::RefCell;

    const T0: i64 = 1_800_000_000_000;

    fn snap(used: f64, status: ProviderStatus) -> ProviderSnapshot {
        let mut p = ProviderSnapshot::empty(status, "", None);
        p.error = None;
        p.error_code = None;
        p.status = status;
        p.windows = vec![UsageWindow {
            id: "five_hour".into(),
            label: "5h".into(),
            kind: WindowKind::Session,
            scope: None,
            used_percent: used,
            resets_at: Some("2027-01-15T08:00:00.000Z".into()),
            fetched_at: None,
        }];
        p
    }

    fn failing() -> ProviderSnapshot {
        let mut s = snap(10.0, ProviderStatus::Ok);
        s.error = Some("Fetch failed".into());
        s.error_code = Some(crate::schema::ErrorCode::FetchFailed);
        s
    }

    /// statusLine values received at `at`, carrying the window snap() has
    fn pas(at: i64) -> Passive {
        Passive {
            at_ms: at,
            windows: vec!["five_hour".into()],
        }
    }

    fn coord() -> Coordinator {
        Coordinator::new(ScheduleConfig::default(), Logger::stderr())
    }

    fn sharing() -> Coordinator {
        coord().sharing(true)
    }

    fn plan_of(c: &Coordinator, id: &str) -> i64 {
        c.slots.get(id).map_or(0, |s| s.plan_at)
    }

    const OK: Option<Run> = Some(Run::Ran(Outcome::Ok));

    /// The destination's rules for turns, attempts and stops (the Worker's holds.ts), shared by the PCs of a test, on a clock the test
    /// sets. Counts what each PC asked and reported
    #[derive(Default)]
    struct Desk {
        now: i64,
        /// (PC, attempt, until)
        holder: Option<(String, String, i64)>,
        /// (PC, attempt, kind, since)
        pending: Option<(String, String, Kind, i64)>,
        rate_stage: u32,
        rate_until: i64,
        denied: bool,
        stop_gen: u64,
        asks: Vec<(String, Kind)>,
        reports: Vec<(String, Reported)>,
        /// Unreachable (every request fails)
        down: bool,
        /// The next answer is lost after it is decided
        lose_next: bool,
        /// The row's version (moves on with every change)
        version: u64,
        /// Peeks asked (apart from the requests that can be granted)
        peeks: Vec<String>,
        /// Attempts that ended or were replaced
        retired: Vec<String>,
        /// The next request that can be granted is answered with no budget (nothing decided)
        unavailable_next: bool,
    }

    impl Desk {
        fn shared(&self) -> Shared {
            Shared {
                denied: self.denied,
                denied_gen: self.stop_gen,
                rate_stage: self.rate_stage,
                rate_wait_ms: (self.rate_until - self.now).max(0),
                version: self.version,
            }
        }
        fn asked(&self, pc: &str, kind: Kind) -> usize {
            if kind == Kind::Peek {
                return self.peeks.iter().filter(|p| *p == pc).count();
            }
            self.asks
                .iter()
                .filter(|(p, k)| p == pc && *k == kind)
                .count()
        }
        fn grants(&self, pc: &str) -> usize {
            self.asks
                .iter()
                .filter(|(p, k)| p == pc && !matches!(k, Kind::Peek | Kind::Release))
                .count()
        }
    }

    struct Pc<'a> {
        name: &'static str,
        desk: &'a RefCell<Desk>,
    }

    impl TurnAsker for Pc<'_> {
        fn ask(&mut self, _provider: &str, ask: Ask<'_>) -> Option<Answer> {
            let (kind, attempt, stop) = (ask.kind, ask.attempt, ask.stop);
            let mut d = self.desk.borrow_mut();
            if d.down {
                return None;
            }
            if kind == Kind::Peek {
                d.peeks.push(self.name.into());
            } else {
                d.asks.push((self.name.into(), kind));
            }
            let now = d.now;
            let shared = Some(d.shared());
            let no = |reason, wait_ms| Answer {
                go: false,
                reason: Some(reason),
                wait_ms,
                shared,
            };
            let attempt = attempt.unwrap_or("").to_string();
            if !matches!(kind, Kind::Peek | Kind::Release)
                && std::mem::take(&mut d.unavailable_next)
            {
                return Some(no(Reason::Unavailable, 0));
            }
            let answer = match kind {
                Kind::Peek => Answer {
                    go: false,
                    reason: None,
                    wait_ms: 0,
                    shared,
                },
                Kind::Release => {
                    if d.holder
                        .as_ref()
                        .is_some_and(|(p, a, _)| p == self.name && *a == attempt)
                    {
                        d.holder = None;
                        d.version += 1;
                    }
                    Answer {
                        go: false,
                        reason: None,
                        wait_ms: 0,
                        shared,
                    }
                }
                _ if d
                    .pending
                    .as_ref()
                    .is_some_and(|(p, a, _, _)| p == self.name && *a == attempt) =>
                {
                    Answer {
                        go: true,
                        reason: None,
                        wait_ms: 0,
                        shared,
                    }
                }
                _ if d.retired.contains(&attempt) => no(Reason::Pending, 0),
                _ if ask.base != Some(d.version) => no(Reason::Moved, 0),
                _ if ask.replace.is_some()
                    && d.pending.as_ref().map(|(_, a, _, _)| a.as_str()) != ask.replace =>
                {
                    no(Reason::Gone, 0)
                }
                _ if d.denied && kind != Kind::Resume => no(Reason::AccessDenied, 0),
                Kind::Resume if !d.denied || stop != Some(d.stop_gen) => no(Reason::StaleGen, 0),
                _ if d.pending.as_ref().is_some_and(|(_, a, k, since)| {
                    !(now - since >= 5 * MINUTE_MS
                        && ask.replace == Some(a.as_str())
                        && ((kind == Kind::Force && !d.denied)
                            || (kind == Kind::Resume && *k == Kind::Resume)))
                }) =>
                {
                    no(Reason::Pending, 0)
                }
                _ if d.rate_until > now => no(Reason::RateLimited, d.rate_until - now),
                _ if kind == Kind::Fetch
                    && d.holder
                        .as_ref()
                        .is_some_and(|(p, _, until)| p != self.name && *until > now) =>
                {
                    let until = d.holder.as_ref().unwrap().2;
                    no(Reason::Turn, until - now)
                }
                _ => {
                    if let Some((_, old, _, _)) = d.pending.take() {
                        d.retired.push(old);
                    }
                    d.pending = Some((self.name.into(), attempt, kind, now));
                    d.version += 1;
                    Answer {
                        go: true,
                        reason: None,
                        wait_ms: 0,
                        shared: Some(d.shared()),
                    }
                }
            };
            if kind != Kind::Peek && std::mem::take(&mut d.lose_next) {
                return None;
            }
            Some(answer)
        }

        fn report(
            &mut self,
            _provider: &str,
            attempt: &str,
            asked_kind: Kind,
            outcome: Reported,
            interval_min: i64,
            lease_min: i64,
        ) -> Option<Ack> {
            let mut d = self.desk.borrow_mut();
            if d.down {
                return None;
            }
            d.reports.push((self.name.into(), outcome));
            let now = d.now;
            let not_applied = |d: &Desk| {
                Some(Ack {
                    shared: d.shared(),
                    applied: false,
                })
            };
            let Some((p, a, kind, _)) = d.pending.clone() else {
                return not_applied(&d);
            };
            if p != self.name || a != attempt || kind != asked_kind {
                return not_applied(&d);
            }
            d.pending = None;
            d.retired.push(a.clone());
            d.version += 1;
            let mine = d.holder.as_ref().is_some_and(|(h, _, _)| h == self.name);
            match outcome {
                Reported::Ok => {
                    d.rate_stage = 0;
                    d.rate_until = 0;
                    if kind == Kind::Resume {
                        d.denied = false;
                    }
                    if kind == Kind::Fetch {
                        if lease_min > 0 {
                            d.holder =
                                Some((self.name.into(), a, now + lease_min.min(90) * MINUTE_MS));
                        } else if mine {
                            d.holder = None;
                        }
                    }
                }
                Reported::Failed if mine => d.holder = None,
                Reported::Failed | Reported::NotRun => {}
                Reported::RateLimited { retry_ms } => {
                    d.holder = None;
                    d.rate_stage = (d.rate_stage + 1).min(4);
                    let stage = [30, 60, 120, 240][d.rate_stage as usize - 1] * MINUTE_MS;
                    d.rate_until = now
                        + stage
                            .max(interval_min * MINUTE_MS)
                            .max(retry_ms.unwrap_or(0));
                }
                Reported::AccessDenied => {
                    d.holder = None;
                    if !d.denied {
                        d.denied = true;
                        d.stop_gen += 1;
                    }
                }
            }
            Some(Ack {
                shared: d.shared(),
                applied: true,
            })
        }
    }

    /// Asks for and makes one fetch at `now`, as the agent does: true if it went upstream
    fn fetch(
        c: &mut Coordinator,
        pc: &mut Pc,
        now: i64,
        run: Option<Run>,
        s: &ProviderSnapshot,
        next: i64,
    ) -> bool {
        pc.desk.borrow_mut().now = now;
        if !c.before_fetch("claude", 15, Some(s), None, None, Mode::Auto, Some(pc), now) {
            return false;
        }
        c.after_fetch("claude", run, s, next, 15, Some(pc), now);
        true
    }

    #[test]
    fn every_fetch_asks_the_turn_and_the_next_is_planned_within_20_percent_of_the_interval() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = sharing();
        let s = snap(10.0, ProviderStatus::Ok);
        assert!(fetch(&mut c, &mut pc, T0, OK, &s, T0 + 10 * MINUTE_MS));
        assert_eq!(
            desk.borrow().asked("mac", Kind::Fetch),
            1,
            "the first fetch after a start asks too"
        );
        let plan = plan_of(&c, "claude");
        assert!(
            (T0 + 12 * MINUTE_MS..=T0 + 18 * MINUTE_MS).contains(&plan),
            "{}",
            (plan - T0) / 1000
        );
        // the lease the success took covers the next planned fetch and the margin
        let until = desk.borrow().holder.as_ref().unwrap().2;
        assert!((plan + 3 * MINUTE_MS..plan + 4 * MINUTE_MS).contains(&until));
        assert_eq!(desk.borrow().reports, [("mac".into(), Reported::Ok)]);
        // the provider is due at its own 10 minutes: held to the plan, nothing asked
        assert!(!fetch(&mut c, &mut pc, T0 + 10 * MINUTE_MS, OK, &s, 0));
        assert_eq!(c.hold_until("claude"), plan);
        assert_eq!(desk.borrow().asks.len(), 1);
        assert!(fetch(&mut c, &mut pc, plan, OK, &s, plan + 10 * MINUTE_MS));
    }

    #[test]
    fn the_jitter_is_spread_stable_and_never_under_the_floor() {
        let a = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            Path::new("."),
            "mac",
            false,
        );
        let b = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            Path::new("."),
            "win",
            false,
        );
        let mut seen = std::collections::BTreeSet::new();
        let mut differs = 0;
        for k in 0..200 {
            let t = T0 + k * 61_000;
            let j = a.jittered("claude", t, 15 * MINUTE_MS);
            assert!((12 * MINUTE_MS..=18 * MINUTE_MS).contains(&j), "{j}");
            assert_eq!(
                j,
                a.jittered("claude", t, 15 * MINUTE_MS),
                "the same attempt, the same plan"
            );
            seen.insert(j / MINUTE_MS);
            differs += usize::from(j != b.jittered("claude", t, 15 * MINUTE_MS));
            // the floor holds under the jitter
            assert!(a.jittered("claude", t, 10 * MINUTE_MS) >= 10 * MINUTE_MS);
        }
        assert!(seen.len() >= 5, "{seen:?}");
        assert!(differs > 150, "PCs plan apart: {differs}");
    }

    #[test]
    fn the_plan_is_kept_across_a_restart() {
        let h = crate::test_util::TempHome::new("schedule-plan");
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            &h,
            "mac",
            false,
        );
        c.observe("codex", &s, 15, T0);
        assert!(c.before_fetch("codex", 15, Some(&s), None, None, Mode::Auto, None, T0));
        c.after_fetch("codex", OK, &s, T0 + 10 * MINUTE_MS, 15, None, T0);
        let plan = plan_of(&c, "codex");
        let again = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            &h,
            "mac",
            false,
        );
        assert_eq!(plan_of(&again, "codex"), plan);
        assert_eq!(
            again
                .next_run("codex", T0 + 10 * MINUTE_MS, T0 + MINUTE_MS)
                .at_ms,
            Some(plan)
        );
    }

    #[test]
    fn passive_values_put_the_active_fetch_off_no_further_than_the_longest_stretch() {
        let mut c = coord();
        let s = snap(10.0, ProviderStatus::Ok);
        c.record_fetch("claude", 15, Some(&s), T0);
        let plan = plan_of(&c, "claude");
        // statusLine values received just before the plan: put off one interval from their receipt
        let received = plan - MINUTE_MS;
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            Some(&pas(received)),
            None,
            Mode::Auto,
            None,
            plan
        ));
        assert_eq!(c.hold_until("claude"), received + 15 * MINUTE_MS);
        assert_eq!(
            c.next_run("claude", plan, plan).waiting,
            Some(Waiting::Passive)
        );
        // values coming on and on: never past 60 minutes after the last active fetch
        let mut t = c.hold_until("claude");
        let mut fetched = false;
        for _ in 0..10 {
            if c.before_fetch(
                "claude",
                15,
                Some(&s),
                Some(&pas(t - 30_000)),
                None,
                Mode::Auto,
                None,
                t,
            ) {
                fetched = true;
                break;
            }
            t = c.hold_until("claude");
        }
        assert!(fetched);
        assert!(t <= T0 + 60 * MINUTE_MS, "{}", (t - T0) / MINUTE_MS);
        // no passive values, or only old ones: fetched at the plan
        let mut c2 = coord();
        c2.record_fetch("claude", 15, Some(&s), T0);
        let p2 = plan_of(&c2, "claude");
        assert!(c2.before_fetch(
            "claude",
            15,
            Some(&s),
            Some(&pas(T0 - 20 * MINUTE_MS)),
            None,
            Mode::Auto,
            None,
            p2
        ));
    }

    #[test]
    fn unchanged_values_stretch_the_interval_to_30_then_60_minutes_and_a_change_returns_it() {
        let mut c = coord();
        let s = snap(10.0, ProviderStatus::Ok);
        c.observe("claude", &s, 15, T0);
        let gap =
            |c: &Coordinator| (plan_of(c, "claude") - c.slots["claude"].last_fetch) / MINUTE_MS;
        c.record_fetch("claude", 15, Some(&s), T0 + 10 * MINUTE_MS);
        assert!((12..=18).contains(&gap(&c)), "normal");
        c.record_fetch("claude", 15, Some(&s), T0 + 30 * MINUTE_MS);
        assert!(
            (24..=36).contains(&gap(&c)),
            "30 minutes unchanged: {}",
            gap(&c)
        );
        assert_eq!(c.slots["claude"].plan_reason, Some(Waiting::Idle));
        c.record_fetch("claude", 15, Some(&s), T0 + 120 * MINUTE_MS);
        assert!(
            (48..=72).contains(&gap(&c)),
            "2 hours unchanged: {}",
            gap(&c)
        );
        // a change: back to normal
        let changed = snap(11.0, ProviderStatus::Ok);
        c.observe("claude", &changed, 15, T0 + 130 * MINUTE_MS);
        c.record_fetch("claude", 15, Some(&changed), T0 + 130 * MINUTE_MS);
        assert!((12..=18).contains(&gap(&c)));
        assert_eq!(c.slots["claude"].plan_reason, None);
        // not stretched close to a limit (80 % or more)
        let high = snap(85.0, ProviderStatus::Ok);
        let mut c2 = coord();
        c2.observe("claude", &high, 15, T0);
        c2.record_fetch("claude", 15, Some(&high), T0 + 180 * MINUTE_MS);
        assert!(
            (12..=18).contains(&((plan_of(&c2, "claude") - (T0 + 180 * MINUTE_MS)) / MINUTE_MS))
        );
    }

    #[test]
    fn another_holder_defers_within_one_jittered_interval_and_its_own_fetch_after_2_hours_passes_the_lease_only()
     {
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let mut b = Pc {
            name: "b",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        // a holds a long lease (a limit reached: its next fetch 62 minutes on)
        let mut ca = sharing();
        assert!(fetch(&mut ca, &mut a, T0, OK, &s, T0 + 62 * MINUTE_MS));
        let mut cb = sharing();
        assert!(!fetch(&mut cb, &mut b, T0 + MINUTE_MS, OK, &s, 0));
        assert_eq!(
            cb.hold_until("claude"),
            T0 + MINUTE_MS + 21 * MINUTE_MS,
            "a long lease is checked again after 18 + 3 minutes"
        );
        assert_eq!(
            cb.next_run("claude", T0, T0 + MINUTE_MS).waiting,
            Some(Waiting::Turn)
        );
        // a renews its lease on each success; b keeps deferring, and asks for its own fetch 2 hours after it took part
        let mut t = cb.hold_until("claude");
        let mut next_a = T0 + 60 * MINUTE_MS;
        while desk.borrow().asked("b", Kind::Own) == 0 {
            if t >= next_a {
                assert!(fetch(
                    &mut ca,
                    &mut a,
                    next_a,
                    OK,
                    &s,
                    next_a + 62 * MINUTE_MS
                ));
                next_a += 60 * MINUTE_MS;
            }
            let fetched = fetch(&mut cb, &mut b, t, OK, &s, t + 10 * MINUTE_MS);
            // its own fetch made against a row a's fetches moved on is asked again once, against the new version
            assert_eq!(fetched, desk.borrow().asked("b", Kind::Own) >= 1);
            t = cb.hold_until("claude").max(t + MINUTE_MS);
            assert!(t < T0 + 200 * MINUTE_MS);
        }
        assert!(desk.borrow().asked("b", Kind::Own) >= 1);
        let own_at = cb.slots["claude"].last_fetch;
        assert!(
            (T0 + 101 * MINUTE_MS..=T0 + 121 * MINUTE_MS).contains(&own_at),
            "{}",
            (own_at - T0) / MINUTE_MS
        );
        assert_eq!(
            desk.borrow().holder.as_ref().unwrap().0,
            "a",
            "the lease stays with its holder"
        );
    }

    #[test]
    fn a_sharing_pc_waits_without_an_answer_and_a_pc_without_push_decides_alone() {
        let s = snap(10.0, ProviderStatus::Ok);
        // the destination unreachable (or its own refusal, or credentials that can't be read): waits, asks again in 5 minutes
        let desk = RefCell::new(Desk {
            down: true,
            ..Default::default()
        });
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = sharing();
        assert!(!fetch(&mut c, &mut pc, T0, OK, &s, 0));
        assert_eq!(c.hold_until("claude"), T0 + 5 * MINUTE_MS);
        assert_eq!(
            c.next_run("claude", T0, T0).waiting,
            Some(Waiting::Unconfirmed)
        );
        assert!(
            c.denied("claude").is_none(),
            "nothing of the destination's own refusal stops the provider"
        );
        desk.borrow_mut().down = false;
        assert!(fetch(&mut c, &mut pc, T0 + 5 * MINUTE_MS, OK, &s, 0));
        // push set up but no one to ask (its settings couldn't be read): waits
        let mut c = sharing();
        assert!(!c.before_fetch("claude", 15, Some(&s), None, None, Mode::Auto, None, T0));
        assert_eq!(
            c.next_run("claude", T0, T0).waiting,
            Some(Waiting::Unconfirmed)
        );
        // no push: decides alone
        assert!(coord().before_fetch("claude", 15, Some(&s), None, None, Mode::Auto, None, T0));
    }

    #[test]
    fn a_failed_fetch_hands_the_lease_back_and_a_long_wait_takes_a_long_lease() {
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        // limit reached and the provider's next fetch in 40 minutes: the lease reaches it
        assert!(fetch(&mut c, &mut a, T0, OK, &s, T0 + 40 * MINUTE_MS));
        assert_eq!(
            desk.borrow().holder.as_ref().unwrap().2,
            T0 + 43 * MINUTE_MS
        );
        // a failed fetch (also with a cached ok value): handed back
        let t = T0 + 40 * MINUTE_MS;
        assert!(fetch(
            &mut c,
            &mut a,
            t,
            Some(Run::Ran(Outcome::Failed)),
            &failing(),
            t + 15 * MINUTE_MS
        ));
        assert_eq!(desk.borrow().reports.last().unwrap().1, Reported::Failed);
        assert!(desk.borrow().holder.is_none());
    }

    #[test]
    fn the_holder_keeps_its_turn_through_the_stretched_interval() {
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let mut c = sharing();
        let s = snap(10.0, ProviderStatus::Ok);
        c.observe("claude", &s, 15, T0);
        c.record_fetch("claude", 15, Some(&s), T0 + 20 * MINUTE_MS);
        let t = T0 + 40 * MINUTE_MS;
        assert!(fetch(&mut c, &mut a, t, OK, &s, t + 10 * MINUTE_MS));
        let lease = (desk.borrow().holder.as_ref().unwrap().2 - t) / MINUTE_MS;
        assert!(
            (27..=39).contains(&lease),
            "the stretched plan plus 3 minutes: {lease}"
        );
    }

    #[test]
    fn a_stopping_holder_releases_and_the_other_pc_takes_over_within_one_jittered_turn() {
        let s = snap(10.0, ProviderStatus::Ok);
        for graceful in [true, false] {
            let desk = RefCell::new(Desk::default());
            let mut a = Pc {
                name: "a",
                desk: &desk,
            };
            let mut b = Pc {
                name: "b",
                desk: &desk,
            };
            let mut holder = sharing();
            assert!(fetch(&mut holder, &mut a, T0, OK, &s, T0 + 10 * MINUTE_MS));
            let lease_end = desk.borrow().holder.as_ref().unwrap().2;
            let mut other = sharing();
            other.record_fetch("claude", 15, Some(&s), T0 - MINUTE_MS);
            let mut due = plan_of(&other, "claude");
            let stopped_at = T0 + MINUTE_MS;
            let mut stopped = false;
            let took_over = loop {
                if !stopped && due >= stopped_at {
                    stopped = true;
                    if graceful {
                        holder.release_turns(Some(&mut a));
                    }
                }
                if fetch(&mut other, &mut b, due, OK, &s, due + 10 * MINUTE_MS) {
                    break due;
                }
                due = other.hold_until("claude").max(due + MINUTE_MS);
                assert!(due < T0 + 240 * MINUTE_MS, "never takes over");
            };
            if graceful {
                assert!(desk.borrow().holder.as_ref().unwrap().0 == "b");
                assert!(took_over <= T0 + 18 * MINUTE_MS, "at its own plan");
            } else {
                assert!(took_over >= lease_end, "an abrupt stop waits for the lease");
                assert!(took_over <= lease_end + 21 * MINUTE_MS);
            }
        }
    }

    #[test]
    fn an_attempt_is_saved_before_its_query_and_one_a_run_left_unchecked_holds_until_forced() {
        let h = crate::test_util::TempHome::new("schedule-attempt");
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let make =
            || Coordinator::with_plan(ScheduleConfig::default(), Logger::stderr(), &h, "mac", true);
        let mut c = make();
        desk.borrow_mut().now = T0;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        // the run stops before its result is checked: a later run finds the attempt started
        drop(c);
        let mut again = make();
        for m in [1, 30, 200] {
            let t = T0 + m * MINUTE_MS;
            desk.borrow_mut().now = t;
            assert!(
                !again.before_fetch(
                    "claude",
                    15,
                    Some(&s),
                    None,
                    None,
                    Mode::Auto,
                    Some(&mut pc),
                    t
                ),
                "{m}"
            );
        }
        assert_eq!(
            desk.borrow().grants("mac"),
            1,
            "nothing asked for while its result is unknown"
        );
        assert_eq!(
            again.next_run("claude", T0, T0 + 201 * MINUTE_MS).waiting,
            Some(Waiting::Unknown)
        );
        assert_eq!(
            desk.borrow().pending.as_ref().unwrap().0,
            "mac",
            "the destination keeps it pending (no other PC fetches)"
        );
        // the user's force: a new attempt replaces it once it is old enough
        let t = T0 + 201 * MINUTE_MS;
        desk.borrow_mut().now = t;
        // only by naming the attempt the user checked (another id, or none, replaces nothing)
        let unknown = attempt_number(&desk.borrow().pending.as_ref().unwrap().1);
        for wrong in [None, unknown.map(|a| a ^ 1)] {
            assert!(!again.before_fetch(
                "claude",
                15,
                Some(&s),
                None,
                None,
                Mode::Force { replace: wrong },
                Some(&mut pc),
                t
            ));
        }
        assert!(again.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Force { replace: unknown },
            Some(&mut pc),
            t
        ));
        assert_eq!(desk.borrow().asked("mac", Kind::Force), 1);
        again.after_fetch("claude", OK, &s, t + 10 * MINUTE_MS, 15, Some(&mut pc), t);
        assert!(desk.borrow().pending.is_none());
        // a query whose result can't be checked holds the provider the same way
        let t2 = t + 20 * MINUTE_MS;
        desk.borrow_mut().now = t2;
        assert!(again.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            t2
        ));
        again.after_fetch(
            "claude",
            Some(Run::Unknown),
            &s,
            t2 + 10 * MINUTE_MS,
            15,
            Some(&mut pc),
            t2,
        );
        assert!(!again.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            t2 + 60 * MINUTE_MS
        ));
        assert_eq!(
            again.next_run("claude", t2, t2).waiting,
            Some(Waiting::Unknown)
        );
    }

    #[test]
    fn a_result_is_sent_again_with_no_fetch_due_and_an_unanswered_attempt_is_asked_again_as_it_was()
    {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        desk.borrow_mut().now = T0;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        // a denial whose report doesn't get through; the provider then has no fetch due ever (a safety stop, say)
        desk.borrow_mut().down = true;
        c.after_fetch(
            "claude",
            Some(Run::Ran(Outcome::AccessDenied)),
            &s,
            i64::MAX,
            15,
            Some(&mut pc),
            T0,
        );
        desk.borrow_mut().down = false;
        desk.borrow_mut().now = T0 + MINUTE_MS;
        c.maintain("claude", 15, Some(&mut pc), T0 + MINUTE_MS);
        assert_eq!(
            desk.borrow().reports,
            [("mac".into(), Reported::AccessDenied)],
            "sent with no fetch due"
        );
        assert!(desk.borrow().denied);
        // an attempt asked for and not answered is asked for again with its id and kind, also past this PC's own fetch time
        let desk = RefCell::new(Desk {
            lose_next: true,
            ..Default::default()
        });
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = sharing();
        c.slot("claude").joined_at = T0;
        assert!(!fetch(&mut c, &mut pc, T0 + 100 * MINUTE_MS, OK, &s, 0));
        assert!(fetch(&mut c, &mut pc, T0 + 130 * MINUTE_MS, OK, &s, 0));
        assert_eq!(
            desk.borrow().asked("mac", Kind::Own),
            0,
            "not changed to its own fetch"
        );
        assert_eq!(desk.borrow().asked("mac", Kind::Fetch), 2);
        // the lease is the one fixed with the result, also when sent again later
        assert_eq!(desk.borrow().reports.len(), 1);
    }

    #[test]
    fn reset_only_what_cant_be_read_the_overlay_keeps_an_account_switch_and_waits_keep_their_length()
     {
        // a readable state isn't reset (its stop ends only by its own resume)
        let h = crate::test_util::TempHome::new("schedule-reset");
        let mut c = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            &h,
            "mac",
            false,
        );
        let s = snap(10.0, ProviderStatus::Ok);
        assert!(c.before_fetch("claude", 15, Some(&s), None, None, Mode::Auto, None, T0));
        c.after_fetch(
            "claude",
            Some(Run::Ran(Outcome::AccessDenied)),
            &s,
            0,
            15,
            None,
            T0,
        );
        assert!(!c.reset());
        let again = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            &h,
            "mac",
            false,
        );
        assert_eq!(again.denied("claude"), Some(1));
        // the overlay shows the stop, but never over an account switch (its queue is dropped on the provider's own state)
        let mut switched = snap(10.0, ProviderStatus::Unavailable);
        switched.error_code = Some(ErrorCode::AccountChanged);
        assert_eq!(
            again.overlay("claude", switched).error_code,
            Some(ErrorCode::AccountChanged)
        );
        assert_eq!(
            again.overlay("claude", s.clone()).error_code,
            Some(ErrorCode::AccessDenied)
        );
        // a 6-hour wait the service named keeps its length when the clock goes back
        let mut c = coord();
        assert!(c.before_fetch("claude", 15, Some(&s), None, None, Mode::Auto, None, T0));
        c.after_fetch(
            "claude",
            Some(Run::Ran(Outcome::RateLimited {
                retry_ms: Some(360 * MINUTE_MS),
            })),
            &s,
            0,
            15,
            None,
            T0,
        );
        let length = c.slots["claude"].rate_until - T0;
        assert_eq!(
            length,
            c.lengthened("claude", T0, 360 * MINUTE_MS),
            "the named wait, lengthened a little"
        );
        let back = T0 - 5 * MINUTE_MS;
        c.notice_clock("claude", back);
        assert_eq!(
            c.slots["claude"].rate_until,
            back + length,
            "its length kept"
        );
        // another PC's lease is checked again within 21 minutes, also with a 120-minute interval
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let mut b = Pc {
            name: "b",
            desk: &desk,
        };
        let mut ca = sharing();
        desk.borrow_mut().now = T0;
        assert!(ca.before_fetch(
            "claude",
            120,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut a),
            T0
        ));
        ca.after_fetch(
            "claude",
            OK,
            &s,
            T0 + 120 * MINUTE_MS,
            120,
            Some(&mut a),
            T0,
        );
        let mut cb = sharing();
        assert!(!cb.before_fetch(
            "claude",
            120,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut b),
            T0 + MINUTE_MS
        ));
        assert_eq!(cb.hold_until("claude"), T0 + MINUTE_MS + 21 * MINUTE_MS);
    }

    #[test]
    fn an_account_boundary_is_a_change_and_a_change_decides_a_passive_wait_again() {
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = coord();
        c.observe("claude", &s, 15, T0);
        let mut accepted = s.clone();
        accepted.history_since = Some("2027-01-15T07:00:00.000Z".into());
        c.observe("claude", &accepted, 15, T0 + 50 * MINUTE_MS);
        c.record_fetch("claude", 15, Some(&accepted), T0 + 60 * MINUTE_MS);
        assert_eq!(
            c.slots["claude"].plan_reason, None,
            "the stretch starts again at the boundary"
        );
        // a wait for passive values, then a limit reached: decided again at once (the fetch at a reset may be due sooner)
        let mut c = coord();
        c.record_fetch("claude", 15, Some(&s), T0);
        let plan = plan_of(&c, "claude");
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            Some(&pas(plan - MINUTE_MS)),
            None,
            Mode::Auto,
            None,
            plan
        ));
        assert_eq!(
            c.next_run("claude", plan, plan).waiting,
            Some(Waiting::Passive)
        );
        let full = snap(100.0, ProviderStatus::Ok);
        assert!(
            c.observe("claude", &full, 15, plan + MINUTE_MS),
            "the provider is told"
        );
        assert_eq!(c.hold_until("claude"), 0);
    }

    #[test]
    fn a_success_not_acknowledged_is_kept_and_sent_before_any_next_attempt() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        desk.borrow_mut().now = T0;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        desk.borrow_mut().down = true;
        c.after_fetch("claude", OK, &s, T0 + 10 * MINUTE_MS, 15, Some(&mut pc), T0);
        // still unreachable when the user forces: nothing new is asked for (the result would be lost under a new attempt)
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Force { replace: None },
            Some(&mut pc),
            T0 + MINUTE_MS
        ));
        desk.borrow_mut().down = false;
        let t = T0 + 20 * MINUTE_MS;
        desk.borrow_mut().now = t;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            t
        ));
        assert_eq!(
            desk.borrow().reports,
            [("mac".into(), Reported::Ok)],
            "the result went first"
        );
        assert_eq!(desk.borrow().grants("mac"), 2, "then the next attempt");
    }

    #[test]
    fn a_result_not_acknowledged_is_sent_again_before_the_next_attempt_and_nothing_is_asked_until_it_is()
     {
        let h = crate::test_util::TempHome::new("schedule-unacked");
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c =
            Coordinator::with_plan(ScheduleConfig::default(), Logger::stderr(), &h, "mac", true);
        desk.borrow_mut().now = T0;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        // an access denial whose report doesn't get through, and a restart
        desk.borrow_mut().down = true;
        c.after_fetch(
            "claude",
            Some(Run::Ran(Outcome::AccessDenied)),
            &s,
            0,
            15,
            Some(&mut pc),
            T0,
        );
        assert!(
            c.denied("claude").is_some(),
            "stopped on this PC's own word meanwhile"
        );
        let mut c =
            Coordinator::with_plan(ScheduleConfig::default(), Logger::stderr(), &h, "mac", true);
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0 + MINUTE_MS
        ));
        assert!(desk.borrow().reports.is_empty() && desk.borrow().asks.len() == 1);
        // once it can be reached, the result goes first (the destination's stop starts), and nothing is granted
        desk.borrow_mut().down = false;
        desk.borrow_mut().now = T0 + 6 * MINUTE_MS;
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Force { replace: None },
            Some(&mut pc),
            T0 + 6 * MINUTE_MS
        ));
        assert_eq!(
            desk.borrow().reports,
            [("mac".into(), Reported::AccessDenied)]
        );
        assert!(desk.borrow().denied && desk.borrow().pending.is_none());
        assert_eq!(
            desk.borrow().grants("mac"),
            1,
            "the force wasn't asked for: stopped"
        );
    }

    #[test]
    fn pc_a_s_six_hour_rate_limit_holds_pc_b_also_restarted_and_due_for_its_own_fetch() {
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let mut b = Pc {
            name: "b",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut ca = sharing();
        assert!(fetch(
            &mut ca,
            &mut a,
            T0,
            Some(Run::Ran(Outcome::RateLimited {
                retry_ms: Some(6 * 60 * MINUTE_MS)
            })),
            &s,
            0
        ));
        assert_eq!(desk.borrow().rate_until, T0 + 360 * MINUTE_MS);
        assert_eq!(
            ca.next_run("claude", T0, T0 + MINUTE_MS).waiting,
            Some(Waiting::RateLimited)
        );
        // b took part long ago and restarts: its own fetch is due, and still nothing goes upstream for 6 hours
        let mut cb = sharing();
        cb.slot("claude").joined_at = T0 - 300 * MINUTE_MS;
        let mut t = T0 + MINUTE_MS;
        while t < T0 + 360 * MINUTE_MS {
            assert!(
                !fetch(&mut cb, &mut b, t, OK, &s, 0),
                "{}",
                (t - T0) / MINUTE_MS
            );
            if t == T0 + 120 * MINUTE_MS {
                cb = sharing();
                cb.slot("claude").joined_at = T0 - 300 * MINUTE_MS;
            }
            t += 7 * MINUTE_MS;
        }
        assert_eq!(
            desk.borrow().grants("b"),
            0,
            "the wait came with the peek that read the row's version at each start; only peeks after"
        );
        assert!(desk.borrow().asked("b", Kind::Peek) > 0);
        assert!(
            !fetch(&mut ca, &mut a, T0 + 300 * MINUTE_MS, OK, &s, 0),
            "a waits too"
        );
        // after the wait, one PC goes, and its success ends the stage
        assert!(fetch(&mut cb, &mut b, T0 + 361 * MINUTE_MS, OK, &s, 0));
        assert_eq!(desk.borrow().rate_stage, 0);
    }

    #[test]
    fn an_access_denial_stops_every_kind_also_force_until_its_resume_succeeds() {
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let mut b = Pc {
            name: "b",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut ca = sharing();
        assert!(fetch(
            &mut ca,
            &mut a,
            T0,
            Some(Run::Ran(Outcome::AccessDenied)),
            &s,
            0
        ));
        assert_eq!(ca.denied("claude"), Some(1));
        assert_eq!(
            ca.overlay("claude", s.clone()).error_code,
            Some(ErrorCode::AccessDenied)
        );
        let asked = desk.borrow().asks.len();
        let t = T0 + 30 * MINUTE_MS;
        desk.borrow_mut().now = t;
        assert!(
            !ca.before_fetch(
                "claude",
                15,
                Some(&s),
                None,
                None,
                Mode::Force { replace: None },
                Some(&mut a),
                t
            ),
            "not with --force either"
        );
        assert!(!ca.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut a),
            t
        ));
        assert_eq!(
            desk.borrow().grants("a"),
            asked,
            "no grant asked for: only peeks"
        );
        // another PC learns of it from the destination and waits
        let mut cb = sharing();
        assert!(!fetch(&mut cb, &mut b, t, OK, &s, 0));
        assert_eq!(cb.denied("claude"), Some(1));
        assert!(
            cb.next_run("claude", t, t)
                .describe_for("claude")
                .contains("headroom collect --provider claude --resume-access 1"),
            "the stop is named with its command"
        );
        // the stop's own resume: on its success fetching goes on, and b learns of it when it asks again
        let t2 = t + 10 * MINUTE_MS;
        desk.borrow_mut().now = t2;
        assert!(ca.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Resume {
                stop: 1,
                replace: None
            },
            Some(&mut a),
            t2
        ));
        assert_eq!(desk.borrow().asked("a", Kind::Resume), 1);
        ca.after_fetch("claude", OK, &s, 0, 15, Some(&mut a), t2);
        assert!(ca.denied("claude").is_none() && !desk.borrow().denied);
        assert!(fetch(&mut cb, &mut b, t2 + 6 * MINUTE_MS, OK, &s, 0));
        assert!(cb.denied("claude").is_none());
    }

    #[test]
    fn a_rate_limit_s_wait_is_lengthened_by_up_to_a_fifth_never_shortened_and_spread() {
        let c = coord();
        let wait = 30 * MINUTE_MS;
        let all: Vec<i64> = (0..200)
            .map(|i| c.lengthened("claude", T0 + i * 1_000, wait))
            .collect();
        assert!(
            all.iter().all(|&w| w >= wait && w <= wait * 12 / 10),
            "{all:?}"
        );
        assert!(
            all.iter().any(|&w| w < wait * 102 / 100),
            "some near the stage's wait"
        );
        assert!(
            all.iter().any(|&w| w > wait * 118 / 100),
            "some near a fifth longer"
        );
        // the same report, the same wait
        assert_eq!(
            c.lengthened("claude", T0, wait),
            c.lengthened("claude", T0, wait)
        );
    }

    #[test]
    fn a_pc_without_push_keeps_its_own_stops() {
        let s = snap(10.0, ProviderStatus::Ok);
        let limited = |retry| Some(Run::Ran(Outcome::RateLimited { retry_ms: retry }));
        let mut c = coord();
        let step = |c: &mut Coordinator, t: i64, mode, run: Option<Run>| {
            let go = c.before_fetch("claude", 15, Some(&s), None, None, mode, None, t);
            if go {
                c.after_fetch("claude", run, &s, 0, 15, None, t);
            }
            go
        };
        // 30, then 60 minutes; a named wait longer than the stage wins. Each wait lengthened by up to 20 %, never shortened
        let waited = |c: &Coordinator, from: i64, minutes: i64| {
            let until = c.slots["claude"].rate_until;
            assert!(
                until >= from + minutes * MINUTE_MS
                    && until <= from + minutes * MINUTE_MS * 12 / 10,
                "{minutes} minutes from {from}: until {until}"
            );
            assert_eq!(
                until,
                from + c.lengthened("claude", from, minutes * MINUTE_MS),
                "the same report, the same wait"
            );
            until
        };
        assert!(step(&mut c, T0, Mode::Auto, limited(None)));
        let first = waited(&c, T0, 30);
        assert!(!step(
            &mut c,
            first - MINUTE_MS,
            Mode::Force { replace: None },
            OK
        ));
        assert!(step(&mut c, first, Mode::Auto, limited(None)));
        let second = waited(&c, first, 60);
        assert!(step(
            &mut c,
            second,
            Mode::Auto,
            limited(Some(300 * MINUTE_MS))
        ));
        let third = waited(&c, second, 300);
        assert!(step(&mut c, third, Mode::Auto, OK));
        assert_eq!(c.slots["claude"].rate_stage, 0);
        // a denial stops it, also forced, until a resume succeeds
        let t = third + 20 * MINUTE_MS;
        assert!(step(
            &mut c,
            t,
            Mode::Auto,
            Some(Run::Ran(Outcome::AccessDenied))
        ));
        assert!(!step(
            &mut c,
            t + 30 * MINUTE_MS,
            Mode::Force { replace: None },
            OK
        ));
        assert!(step(
            &mut c,
            t + 31 * MINUTE_MS,
            Mode::Resume {
                stop: 1,
                replace: None
            },
            OK
        ));
        assert!(c.denied("claude").is_none());
    }

    #[test]
    fn an_answer_lost_is_asked_for_again_with_its_attempt_and_granted_once() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        desk.borrow_mut().lose_next = true;
        assert!(!fetch(&mut c, &mut pc, T0, OK, &s, 0));
        let first = desk.borrow().pending.clone().unwrap().1;
        assert!(fetch(&mut c, &mut pc, T0 + 5 * MINUTE_MS, OK, &s, 0));
        assert_eq!(desk.borrow().reports.len(), 1);
        assert!(
            desk.borrow().pending.is_none(),
            "the same attempt ({first}) granted once and reported"
        );
    }

    #[test]
    fn a_state_that_cant_be_read_stops_a_pc_without_push_until_reset_and_is_made_again_on_a_sharing_pc()
     {
        let h = crate::test_util::TempHome::new("schedule-unreadable");
        std::fs::write(h.join(PLAN_FILE), "{not json").unwrap();
        let s = snap(10.0, ProviderStatus::Ok);
        let mut alone = Coordinator::with_plan(
            ScheduleConfig::default(),
            Logger::stderr(),
            &h,
            "mac",
            false,
        );
        assert!(!alone.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Force { replace: None },
            None,
            T0
        ));
        assert_eq!(
            alone.next_run("claude", T0, T0).waiting,
            Some(Waiting::Unreadable)
        );
        assert_eq!(
            std::fs::read_to_string(h.join(PLAN_FILE)).unwrap(),
            "{not json",
            "never written over"
        );
        assert!(alone.reset());
        assert!(alone.before_fetch("claude", 15, Some(&s), None, None, Mode::Auto, None, T0));
        std::fs::write(h.join(PLAN_FILE), "{not json").unwrap();
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut shared =
            Coordinator::with_plan(ScheduleConfig::default(), Logger::stderr(), &h, "mac", true);
        assert!(
            fetch(&mut shared, &mut pc, T0, OK, &s, 0),
            "the destination keeps the shared stops"
        );
    }

    #[test]
    fn a_hold_or_plan_set_before_the_clock_went_back_does_not_hold_off() {
        // fetched at 15:00 (planned about 15:15) and told to wait for the turn until 15:05; then the clock is set back to 12:00
        let mut c = coord();
        let fifteen = 15 * 60 * MINUTE_MS;
        c.record_fetch("claude", 15, None, fifteen);
        {
            let slot = c.slots.get_mut("claude").unwrap();
            slot.hold_until = fifteen + 5 * MINUTE_MS;
            slot.hold_reason = Some(Waiting::Turn);
            slot.hold_set_at = fifteen;
        }
        let noon = 12 * 60 * MINUTE_MS;
        assert!(
            c.before_fetch("claude", 15, None, None, None, Mode::Auto, None, noon),
            "not held off until 15:05 or 15:15"
        );
        assert_eq!(c.hold_until("claude"), 0);
        // a hold set after the last fetch, the clock going back before it
        let mut c2 = coord();
        c2.record_fetch("claude", 15, None, noon);
        {
            let slot = c2.slots.get_mut("claude").unwrap();
            slot.hold_until = noon + 26 * MINUTE_MS;
            slot.hold_reason = Some(Waiting::Turn);
            slot.hold_set_at = noon + 19 * MINUTE_MS;
        }
        assert!(c2.notice_clock("claude", noon + MINUTE_MS));
        assert_eq!(c2.hold_until("claude"), 0);
        assert!(!c2.notice_clock("claude", noon + 2 * MINUTE_MS), "once");
    }

    #[test]
    fn next_run_reports_the_plan_hold_stops_and_their_reasons() {
        let mut c = coord();
        let s = snap(10.0, ProviderStatus::Ok);
        let own = c.next_run("codex", T0 + MINUTE_MS, T0);
        assert_eq!((own.at_ms, own.waiting), (Some(T0 + MINUTE_MS), None));
        c.record_fetch("codex", 15, Some(&s), T0);
        let plan = plan_of(&c, "codex");
        assert_eq!(
            c.next_run("codex", T0 + 10 * MINUTE_MS, T0 + MINUTE_MS)
                .at_ms,
            Some(plan)
        );
        let none = c.next_run("claude", i64::MAX, T0);
        assert_eq!(none.describe(), "none (not scheduled)");
        let disabled = NextRun {
            disabled: true,
            ..none
        };
        assert_eq!(disabled.describe(), "none (disabled)");
        for (w, text) in [
            (Waiting::Turn, "another PC holds the fetch turn"),
            (Waiting::Idle, "interval stretched"),
            (Waiting::Passive, "statusLine"),
            (Waiting::Unconfirmed, "couldn't ask the destination"),
            (Waiting::Pending, "another fetch attempt"),
            (Waiting::RateLimited, "rate limited"),
            (Waiting::Denied, "--resume-access"),
            (Waiting::Unknown, "--force"),
            (Waiting::Unreadable, "--reset-fetch-state"),
        ] {
            let n = NextRun {
                at_ms: Some(T0),
                waiting: Some(w),
                disabled: false,
                stop: None,
                attempt: None,
            };
            assert!(n.describe().contains(text), "{}", n.describe());
        }
    }

    #[test]
    fn a_stretch_needs_an_overall_limit_and_any_change_brings_a_stretched_plan_back() {
        // only a model's limit: never stretched
        let mut only_model = snap(10.0, ProviderStatus::Ok);
        only_model.windows[0].scope = Some("Fable".into());
        let mut c = coord();
        c.observe("claude", &only_model, 15, T0);
        c.record_fetch("claude", 15, Some(&only_model), T0 + 180 * MINUTE_MS);
        assert_eq!(c.slots["claude"].plan_reason, None);
        // stretched, then the values change: the plan and the hold the provider was given come back to the normal interval
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = coord();
        c.observe("claude", &s, 15, T0);
        let fetched = T0 + 40 * MINUTE_MS;
        c.record_fetch("claude", 15, Some(&s), fetched);
        assert_eq!(c.slots["claude"].plan_reason, Some(Waiting::Idle));
        let stretched = plan_of(&c, "claude");
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            None,
            fetched + 10 * MINUTE_MS
        ));
        assert_eq!(c.hold_until("claude"), stretched);
        let higher = snap(85.0, ProviderStatus::Ok);
        assert!(
            c.observe("claude", &higher, 15, fetched + 11 * MINUTE_MS),
            "the provider is told"
        );
        let normal = plan_of(&c, "claude");
        assert!((fetched + 12 * MINUTE_MS..=fetched + 18 * MINUTE_MS).contains(&normal));
        assert!(normal < stretched);
        assert_eq!(c.hold_until("claude"), normal);
        assert_eq!(c.slots["claude"].plan_reason, None);
        // a failure and a recovery with the same values is a change too (the unchanged stretch starts again)
        let mut c = coord();
        c.observe("claude", &s, 15, T0);
        c.observe("claude", &failing(), 15, T0 + 50 * MINUTE_MS);
        c.observe("claude", &s, 15, T0 + 55 * MINUTE_MS);
        c.record_fetch("claude", 15, Some(&s), T0 + 60 * MINUTE_MS);
        assert_eq!(
            c.slots["claude"].plan_reason, None,
            "unchanged for 5 minutes only"
        );
    }

    #[test]
    fn passive_values_count_only_after_the_last_fetch_with_every_overall_limit_and_after_a_reached_reset()
     {
        let s = snap(10.0, ProviderStatus::Ok);
        let go =
            |c: &mut Coordinator, latest: &ProviderSnapshot, p: &Passive, last: i64, now: i64| {
                c.before_fetch(
                    "claude",
                    15,
                    Some(latest),
                    Some(p),
                    Some(last),
                    Mode::Auto,
                    None,
                    now,
                )
            };
        let mut c = coord();
        c.record_fetch("claude", 15, Some(&s), T0);
        let plan = plan_of(&c, "claude");
        // received before the provider's last fetch (one made outside the coordinator, which replaced them): nothing put off, although
        // one interval from their receipt is well after the plan
        assert!(go(
            &mut c,
            &s,
            &pas(plan - 2 * MINUTE_MS),
            plan - MINUTE_MS,
            plan
        ));
        // without every overall limit: nothing put off
        let mut c = coord();
        c.record_fetch("claude", 15, Some(&s), T0);
        let other = Passive {
            at_ms: plan - MINUTE_MS,
            windows: vec!["seven_day_fable".into()],
        };
        assert!(go(&mut c, &s, &other, T0, plan));
        // a reached overall limit: only values received after its reset put the fetch off
        let reset = T0 + 30 * MINUTE_MS;
        let mut full = snap(100.0, ProviderStatus::Ok);
        full.windows[0].resets_at = Some(iso_from_ms(reset));
        let mut c = coord();
        c.record_fetch("claude", 15, Some(&full), T0);
        let after = reset + MINUTE_MS;
        assert!(go(&mut c, &full, &pas(reset - MINUTE_MS), T0, after));
        let mut c = coord();
        c.record_fetch("claude", 15, Some(&full), T0);
        assert!(!go(&mut c, &full, &pas(reset + 30_000), T0, after));
        assert_eq!(c.hold_until("claude"), reset + 30_000 + 15 * MINUTE_MS);
        // one interval exactly from the receipt (no jitter shortens it)
        let mut c = coord();
        c.record_fetch("claude", 15, Some(&s), T0);
        assert!(!go(&mut c, &s, &pas(plan - 1_000), T0, plan));
        assert_eq!(c.hold_until("claude"), plan - 1_000 + 15 * MINUTE_MS);
    }

    #[test]
    fn a_result_that_cant_be_saved_is_kept_over_the_file_then_saved_and_reported_once() {
        let h = crate::test_util::TempHome::new("schedule-unsaved");
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c =
            Coordinator::with_plan(ScheduleConfig::default(), Logger::stderr(), &h, "mac", true);
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        // the plan can't be written now (a folder in its place): the 403 is kept in memory, not reported before it is saved
        std::fs::remove_file(h.join(PLAN_FILE)).unwrap();
        std::fs::create_dir(h.join(PLAN_FILE)).unwrap();
        c.after_fetch(
            "claude",
            Some(Run::Ran(Outcome::AccessDenied)),
            &s,
            0,
            15,
            Some(&mut pc),
            T0,
        );
        assert!(desk.borrow().reports.is_empty());
        c.maintain("claude", 15, Some(&mut pc), T0 + MINUTE_MS);
        assert!(desk.borrow().reports.is_empty(), "still not saved");
        assert!(c.denied("claude").is_some(), "its stop stands meanwhile");
        // the file can be written again: saved first, then reported once, with no fetch
        std::fs::remove_dir(h.join(PLAN_FILE)).unwrap();
        c.maintain("claude", 15, Some(&mut pc), T0 + 2 * MINUTE_MS);
        assert_eq!(
            desk.borrow().reports,
            [("mac".to_string(), Reported::AccessDenied)]
        );
        assert_eq!(desk.borrow().grants("mac"), 1);
        c.maintain("claude", 15, Some(&mut pc), T0 + 3 * MINUTE_MS);
        assert_eq!(desk.borrow().reports.len(), 1, "acknowledged: not again");
    }

    #[test]
    fn a_result_whose_send_failed_waits_1_2_4_then_5_minutes_and_wakes_the_agent() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        desk.borrow_mut().down = true;
        c.after_fetch("claude", OK, &s, 0, 15, Some(&mut pc), T0);
        assert_eq!(c.next_upkeep(&["claude"], T0), T0 + MINUTE_MS);
        let mut at = T0 + MINUTE_MS;
        for wait in [2, 4, 5, 5] {
            c.maintain("claude", 15, Some(&mut pc), at - 1_000);
            assert_eq!(c.next_upkeep(&["claude"], T0), at, "not before its time");
            c.maintain("claude", 15, Some(&mut pc), at);
            at += wait * MINUTE_MS;
            assert_eq!(c.next_upkeep(&["claude"], T0), at);
        }
        // reached again: sent, and nothing is due any more
        desk.borrow_mut().down = false;
        c.maintain("claude", 15, Some(&mut pc), at);
        assert_eq!(desk.borrow().reports, [("mac".to_string(), Reported::Ok)]);
        assert_eq!(c.next_upkeep(&["claude"], T0), i64::MAX);
    }

    #[test]
    fn a_result_acknowledged_but_not_applied_is_over_and_takes_no_lease() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        // replaced meanwhile (the destination no longer holds it pending)
        desk.borrow_mut().pending = None;
        c.after_fetch("claude", OK, &s, T0 + 20 * MINUTE_MS, 15, Some(&mut pc), T0);
        assert!(c.slots["claude"].lease_attempt.is_none());
        assert!(c.slots["claude"].attempt.is_none(), "over");
        assert!(desk.borrow().holder.is_none());
    }

    #[test]
    fn a_provider_turned_off_still_sends_its_result_and_ends_an_attempt_only_asked_for() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        // gemini fetched (its result's acknowledgement lost); codex only asked (its answer lost)
        assert!(c.before_fetch(
            "gemini",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        desk.borrow_mut().down = true;
        c.after_fetch("gemini", OK, &s, 0, 15, Some(&mut pc), T0);
        desk.borrow_mut().down = false;
        desk.borrow_mut().lose_next = true;
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        assert_eq!(
            c.slots["codex"].attempt.as_ref().map(|a| a.state.clone()),
            Some(AttemptState::Asking)
        );
        // both turned off: the agent runs claude only
        c.maintain_others(&["claude"], Some(&mut pc), T0 + 2 * MINUTE_MS);
        let reports = desk.borrow().reports.clone();
        assert_eq!(
            reports,
            [
                ("mac".to_string(), Reported::NotRun),
                ("mac".to_string(), Reported::Ok)
            ]
        );
        assert!(c.slots["codex"].attempt.is_none() && c.slots["gemini"].attempt.is_none());
        assert_eq!(
            desk.borrow().grants("mac"),
            2,
            "nothing more asked, nothing fetched"
        );
    }

    #[test]
    fn a_stop_and_an_attempt_whose_result_is_unknown_are_resumed_by_one_command() {
        let mut c = coord();
        let slot = c.slot("codex");
        slot.denied = true;
        slot.denied_gen = 3;
        slot.attempt = Some(Attempt::new(
            "00000000000000ab".into(),
            Kind::Fetch,
            AttemptState::Unknown,
            T0,
        ));
        let text = c.next_run("codex", T0, T0).describe_for("codex");
        assert!(
            text.contains(
                "headroom collect --provider codex --resume-access 3 --replace 00000000000000ab"
            ),
            "{text}"
        );
        // another attempt named than the one standing: nothing is replaced, nothing fetched
        let s = snap(10.0, ProviderStatus::Ok);
        c.slot("codex").denied = false;
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            Mode::Force {
                replace: Some(0xac)
            },
            None,
            T0 + 10 * MINUTE_MS
        ));
        // the one standing, named: replaced only 5 minutes after it began (a PC that doesn't share)
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            Mode::Force {
                replace: Some(0xab)
            },
            None,
            T0 + 4 * MINUTE_MS
        ));
        assert!(c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            Mode::Force {
                replace: Some(0xab)
            },
            None,
            T0 + 5 * MINUTE_MS
        ));
        c.after_fetch("codex", OK, &s, 0, 15, None, T0 + 5 * MINUTE_MS);
        // that attempt is over: naming it again replaces nothing and fetches nothing (not a plain force either)
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            Mode::Force {
                replace: Some(0xab)
            },
            None,
            T0 + 30 * MINUTE_MS
        ));
    }

    #[test]
    fn a_go_is_good_for_60_seconds_from_right_before_it_was_asked_on_both_clocks() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        let asked = Instant::now();
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0
        ));
        let g = c.grant("claude").unwrap();
        assert_eq!(g.until_ms, T0 + GRANT_VALID_MS);
        assert!(g.until <= Instant::now() + Duration::from_millis(GRANT_VALID_MS as u64));
        assert!(g.until >= asked + Duration::from_millis(GRANT_VALID_MS as u64));
        assert!(!g.passed(T0 + GRANT_VALID_MS - 1));
        assert!(g.passed(T0 + GRANT_VALID_MS), "this PC's clock");
        let late = crate::providers::Grant {
            until: Instant::now(),
            ..g
        };
        assert!(late.passed(T0), "the monotonic clock");
    }

    /// A coordinator that shares, with codex's attempt X (0xab) whose result is unknown, begun at T0
    fn unknown_x(desk: &RefCell<Desk>) -> Coordinator {
        let mut c = sharing();
        c.slot("codex").base = Some(desk.borrow().version);
        c.slot("codex").attempt = Some(Attempt::new(
            "00000000000000ab".into(),
            Kind::Fetch,
            AttemptState::Unknown,
            T0,
        ));
        c
    }

    #[test]
    fn a_replacement_goes_only_for_the_attempt_still_pending_and_a_refusal_gives_it_back() {
        let s = snap(10.0, ProviderStatus::Ok);
        let force = Mode::Force {
            replace: Some(0xab),
        };
        // X pending for 4 minutes only: refused, and the PC still holds X (its result unknown)
        let desk = RefCell::new(Desk::default());
        desk.borrow_mut().pending =
            Some(("mac".into(), "00000000000000ab".into(), Kind::Fetch, T0));
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = unknown_x(&desk);
        desk.borrow_mut().now = T0 + 4 * MINUTE_MS;
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            force,
            Some(&mut pc),
            T0 + 4 * MINUTE_MS
        ));
        assert_eq!(
            c.slots["codex"].attempt.as_ref().map(|a| a.id.as_str()),
            Some("00000000000000ab"),
            "given back"
        );
        // X no longer pending (its result came meanwhile): nothing is replaced, nothing fetched
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = unknown_x(&desk);
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            force,
            Some(&mut pc),
            T0 + 10 * MINUTE_MS
        ));
        assert_eq!(desk.borrow().reports.len(), 0);
        assert!(desk.borrow().pending.is_none(), "no new reservation");
    }

    #[test]
    fn a_manual_fetch_whose_answer_was_lost_is_never_done_by_a_later_round_of_another_kind() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        desk.borrow_mut().lose_next = true;
        let force = Mode::Force { replace: None };
        assert!(!c.before_fetch("claude", 15, Some(&s), None, None, force, Some(&mut pc), T0));
        assert!(desk.borrow().pending.is_some(), "granted, its answer lost");
        // the request is over; the next planned round (once the recheck is due) doesn't do the force: it ends as not run, and the
        // reservation goes
        let later = T0 + (UNCONFIRMED_RECHECK_MIN + 1) * MINUTE_MS;
        desk.borrow_mut().now = later;
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            later
        ));
        assert_eq!(
            desk.borrow().asked("mac", Kind::Force),
            1,
            "never asked again as a force"
        );
        c.maintain("claude", 15, Some(&mut pc), later + MINUTE_MS);
        assert_eq!(
            desk.borrow().reports,
            [("mac".to_string(), Reported::NotRun)]
        );
        assert!(desk.borrow().pending.is_none());
        // a planned fetch goes on after it
        let after = later + 2 * MINUTE_MS;
        desk.borrow_mut().now = after;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            after
        ));
        assert_eq!(desk.borrow().asked("mac", Kind::Fetch), 1);
    }

    #[test]
    fn an_acceptance_asks_as_a_planned_fetch_never_past_another_pc_s_lease() {
        let desk = RefCell::new(Desk::default());
        let mut a = Pc {
            name: "a",
            desk: &desk,
        };
        let mut b = Pc {
            name: "b",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut ca = sharing();
        assert!(fetch(&mut ca, &mut a, T0, OK, &s, T0 + 60 * MINUTE_MS));
        // b took part long ago (its own fetch would be due): its acceptance still waits for a's lease
        let mut cb = sharing();
        cb.slot("claude").joined_at = T0 - 300 * MINUTE_MS;
        desk.borrow_mut().now = T0 + MINUTE_MS;
        assert!(!cb.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Accept,
            Some(&mut b),
            T0 + MINUTE_MS
        ));
        assert_eq!(desk.borrow().asked("b", Kind::Own), 0);
        assert!(desk.borrow().asked("b", Kind::Fetch) >= 1);
    }

    #[test]
    fn the_agent_wakes_only_for_upkeep_it_does() {
        let mut c = sharing();
        // a provider turned off, stopped: no recheck is done for it, so none wakes the agent
        c.slot("gemini").denied = true;
        c.slot("gemini").peeked_at = T0;
        assert_eq!(c.next_upkeep(&["claude"], T0), i64::MAX);
        assert_eq!(
            c.next_upkeep(&["claude", "gemini"], T0),
            T0 + STOP_RECHECK_MIN * MINUTE_MS
        );
        // a wait that is over (a 429's, of a provider turned off but built): no recheck, so no wake
        c.slot("codex").rate_until = T0 - MINUTE_MS;
        c.slot("codex").peeked_at = T0 - 60 * MINUTE_MS;
        assert_eq!(c.next_upkeep(&["codex"], T0), i64::MAX);
        c.slot("codex").rate_until = T0 + 30 * MINUTE_MS;
        assert_eq!(
            c.next_upkeep(&["codex"], T0),
            T0 - 60 * MINUTE_MS + STOP_RECHECK_MIN * MINUTE_MS
        );
    }
    /// A destination whose acknowledgement shows the state given
    struct Acks(Shared, usize);
    impl TurnAsker for Acks {
        fn ask(&mut self, _provider: &str, _ask: Ask<'_>) -> Option<Answer> {
            None
        }
        fn report(
            &mut self,
            _provider: &str,
            _attempt: &str,
            _kind: Kind,
            _outcome: Reported,
            _interval_min: i64,
            _lease_min: i64,
        ) -> Option<Ack> {
            self.1 += 1;
            Some(Ack {
                shared: self.0,
                applied: true,
            })
        }
    }

    #[test]
    fn a_resume_is_acknowledged_only_with_its_own_stop_ended() {
        let resumed = |shared: Shared| {
            let mut c = sharing();
            c.slot("claude").attempt = Some(Attempt {
                stop: Some(3),
                ..Attempt::new(
                    "00000000000000c1".into(),
                    Kind::Resume,
                    AttemptState::Done(Reported::Ok),
                    T0,
                )
            });
            let mut d = Acks(shared, 0);
            c.maintain("claude", 15, Some(&mut d), T0);
            (c.slots["claude"].attempt.is_some(), d.1)
        };
        let ended = Shared {
            denied: false,
            denied_gen: 3,
            rate_stage: 0,
            rate_wait_ms: 0,
            version: 9,
        };
        assert_eq!(resumed(ended), (false, 1), "acknowledged");
        // the first report, as the fetch ended: the same check
        let first = |shared: Shared| {
            let mut c = sharing();
            {
                let slot = c.slot("claude");
                slot.denied = true;
                slot.denied_gen = 3;
                slot.granted_attempt = Some("00000000000000c1".into());
                slot.attempt = Some(Attempt {
                    stop: Some(3),
                    ..Attempt::new(
                        "00000000000000c1".into(),
                        Kind::Resume,
                        AttemptState::Started,
                        T0,
                    )
                });
            }
            let mut d = Acks(shared, 0);
            let s = snap(10.0, ProviderStatus::Ok);
            c.after_fetch("claude", OK, &s, 0, 15, Some(&mut d), T0);
            (
                c.slots["claude"].attempt.is_some(),
                c.slots["claude"].denied,
            )
        };
        assert_eq!(first(ended), (false, false));
        assert_eq!(
            first(Shared {
                denied_gen: 4,
                ..ended
            }),
            (true, true),
            "kept, the stop standing"
        );
        // another stop's state (or the stop standing): sent again later
        assert_eq!(
            resumed(Shared {
                denied_gen: 2,
                ..ended
            }),
            (true, 1)
        );
        assert_eq!(
            resumed(Shared {
                denied: true,
                ..ended
            }),
            (true, 1)
        );
    }

    #[test]
    fn a_replacement_the_destination_had_no_budget_for_can_be_asked_again_or_gives_the_attempt_back()
     {
        let s = snap(10.0, ProviderStatus::Ok);
        let force = Mode::Force {
            replace: Some(0xab),
        };
        let setup = || {
            let desk = RefCell::new(Desk::default());
            desk.borrow_mut().pending =
                Some(("mac".into(), "00000000000000ab".into(), Kind::Fetch, T0));
            desk.borrow_mut().now = T0 + 10 * MINUTE_MS;
            desk.borrow_mut().unavailable_next = true;
            desk
        };
        // no budget for it: nothing decided; naming the same attempt again asks again, and replaces it
        let desk = setup();
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = unknown_x(&desk);
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            force,
            Some(&mut pc),
            T0 + 10 * MINUTE_MS
        ));
        assert!(c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            force,
            Some(&mut pc),
            T0 + 11 * MINUTE_MS
        ));
        assert!(
            desk.borrow()
                .retired
                .contains(&"00000000000000ab".to_string())
        );
        // or a later round ends the request: the attempt it was for stands again, its result unknown, to be replaced
        let desk = setup();
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let mut c = unknown_x(&desk);
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            force,
            Some(&mut pc),
            T0 + 10 * MINUTE_MS
        ));
        assert!(!c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0 + 11 * MINUTE_MS
        ));
        c.maintain("codex", 15, Some(&mut pc), T0 + 12 * MINUTE_MS);
        assert_eq!(
            c.slots["codex"]
                .attempt
                .as_ref()
                .map(|a| (a.id.as_str(), a.state.clone())),
            Some(("00000000000000ab", AttemptState::Unknown))
        );
        assert!(c.before_fetch(
            "codex",
            15,
            Some(&s),
            None,
            None,
            force,
            Some(&mut pc),
            T0 + 13 * MINUTE_MS
        ));
    }

    #[test]
    fn a_resume_whose_answer_was_lost_ends_also_while_the_stop_stands() {
        let desk = RefCell::new(Desk::default());
        {
            let mut d = desk.borrow_mut();
            d.denied = true;
            d.stop_gen = 1;
            d.lose_next = true;
        }
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        let mut c = sharing();
        {
            let slot = c.slot("claude");
            slot.denied = true;
            slot.denied_gen = 1;
            slot.base = Some(0);
        }
        let resume = Mode::Resume {
            stop: 1,
            replace: None,
        };
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            resume,
            Some(&mut pc),
            T0
        ));
        assert!(desk.borrow().pending.is_some(), "granted, its answer lost");
        // the request is over; a planned round, the stop standing: it ends as not run, never resumed, and its reservation goes
        assert!(!c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            T0 + MINUTE_MS
        ));
        c.maintain("claude", 15, Some(&mut pc), T0 + 2 * MINUTE_MS);
        assert_eq!(desk.borrow().asked("mac", Kind::Resume), 1);
        assert_eq!(
            desk.borrow().reports,
            [("mac".to_string(), Reported::NotRun)]
        );
        assert!(desk.borrow().pending.is_none());
    }

    #[test]
    fn a_go_that_runs_nothing_waits_longer_each_time() {
        let desk = RefCell::new(Desk::default());
        let mut pc = Pc {
            name: "mac",
            desk: &desk,
        };
        let s = snap(10.0, ProviderStatus::Ok);
        // as the agent has it: the plan kept in its file, read again at each decision
        let h = crate::test_util::TempHome::new("headroom-schedule-not-run");
        let mut c =
            Coordinator::with_plan(ScheduleConfig::default(), Logger::stderr(), &h, "mac", true);
        let mut at = T0;
        for wait in [1, 2, 4, 8] {
            desk.borrow_mut().now = at;
            assert!(c.before_fetch(
                "claude",
                15,
                Some(&s),
                None,
                None,
                Mode::Auto,
                Some(&mut pc),
                at
            ));
            c.after_fetch("claude", Some(Run::NotRun), &s, 0, 15, Some(&mut pc), at);
            assert_eq!(c.hold_until("claude"), at + wait * MINUTE_MS);
            // not asked again before then
            assert!(!c.before_fetch(
                "claude",
                15,
                Some(&s),
                None,
                None,
                Mode::Auto,
                Some(&mut pc),
                at + wait * MINUTE_MS - 1_000
            ));
            at += wait * MINUTE_MS;
        }
        // a fetch that ran: the next one is as planned again
        desk.borrow_mut().now = at;
        assert!(c.before_fetch(
            "claude",
            15,
            Some(&s),
            None,
            None,
            Mode::Auto,
            Some(&mut pc),
            at
        ));
        c.after_fetch("claude", OK, &s, 0, 15, Some(&mut pc), at);
        assert_eq!(c.slots["claude"].not_run, 0);
    }
}
