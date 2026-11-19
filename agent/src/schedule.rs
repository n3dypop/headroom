//! Fetch coordination.
//!
//! - **Turn-taking:** if push is configured, ask the destination "may I fetch?" before each fetch (a query to Anthropic / OpenAI),
//!   and defer until the turn expires if another PC holds it, asking again at least once per normal turn (interval + 2 minutes) so a
//!   long lease that was released is noticed. If the destination is unreachable or push is not configured, fetch on this PC as before
//!   (correctness does not depend on the destination). On a failed fetch, and when the agent stops, release the turn so another PC can take over.
//! - **Safety net:** even while deferring, fetch on this PC at least once per `own_fetch_min` (default 60 minutes) to notice account
//!   switches, expired sign-ins or CLI version changes on this PC. The first fetch after startup is also done on this PC.
//! - **Stretching the interval when nothing changes:** if values do not change for 30 minutes and overall limit usage is below 80 %,
//!   stretch the fetch interval to `idle_interval_min` (default 10 minutes). It returns to normal when a value changes.
//!
//! All times are this PC's clock (ms). Only relative times (minutes / seconds) are exchanged with the destination.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::ScheduleConfig;
use crate::schema::{ProviderSnapshot, ProviderStatus};
use crate::store::Logger;
use crate::time::{MINUTE_MS, iso_from_ms};

/// File in HEADROOM_HOME where the running agent records when it next checks each provider, for `headroom status` only (never sent)
pub const SCHEDULE_FILE: &str = "schedule.json";
/// File in HEADROOM_HOME holding the running agent's session ID (new on every start). `status` uses the schedule only if it
/// carries the same ID, so a schedule left by an earlier agent process is never shown as the current one's
pub const SESSION_FILE: &str = "agent.session";
/// Held with an exclusive lock by the agent that wrote SESSION_FILE, for its lifetime. `status` only probes it with a
/// shared lock (so concurrent `status` runs never block each other): if the probe succeeds, that agent is gone
pub const SESSION_LOCK_FILE: &str = "agent.session.lock";

/// Contents of SCHEDULE_FILE
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    pub session: String,
    pub providers: BTreeMap<String, NextRun>,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Waiting {
    /// Another PC holds the fetch turn
    Turn,
    /// Values have not changed, so the interval is stretched
    Idle,
}

impl NextRun {
    /// Text for `headroom status`
    pub fn describe(&self) -> String {
        if self.disabled {
            return "none (disabled)".into();
        }
        let Some(at) = self.at_ms else {
            return "none (not scheduled)".into();
        };
        let note = match self.waiting {
            Some(Waiting::Turn) => " (another PC holds the fetch turn; checks again then)",
            Some(Waiting::Idle) => " (no recent changes; interval stretched)",
            None => "",
        };
        format!("{}{note}", iso_from_ms(at))
    }
}

/// Start stretching the interval when values have not changed for this many minutes
const IDLE_AFTER_MIN: i64 = 30;
/// Do not stretch when an overall limit is at or above this usage (so near-limit notifications are not delayed)
const IDLE_MAX_PERCENT: f64 = 80.0;
/// Margin (minutes) added to the turn's lease, so another PC does not take over before the holder extends it on its next fetch
const TURN_GRACE_MIN: i64 = 2;
/// A deferring PC asks again a little after the lease expires (so the holder can extend it first)
const RETRY_AFTER_MS: i64 = 5_000;
/// Longest lease to ask for, in minutes (no extension is requested beyond this)
const TURN_MAX_MIN: i64 = 70;

/// The destination's answer
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnReply {
    /// This PC holds the turn (may fetch)
    pub go: bool,
    /// If not holding the turn, time until the lease expires (ms)
    pub wait_ms: i64,
}

/// Who to ask for the turn (the destination). None if unreachable
pub trait TurnAsker {
    /// Requests to hold the turn for `minutes` minutes (0 releases it)
    fn ask_turn(&mut self, provider: &str, minutes: i64) -> Option<TurnReply>;
}

#[derive(Debug, Default)]
struct Slot {
    /// Hold off fetching until this time
    hold_until: i64,
    /// Last time this PC fetched (0 = not yet since startup)
    last_fetch: i64,
    /// Last time a window value changed
    last_change: i64,
    last_values: Option<Vec<(String, u64, Option<String>)>>,
    /// Whether this PC holds the turn (per the destination). The destination owns the lease
    holder: bool,
    /// Lease expiry (estimate on this PC's clock)
    granted_until: i64,
    /// Whether deferring (for logging transitions)
    deferring: bool,
    /// Why `hold_until` was set (shown by `headroom status`)
    hold_reason: Option<Waiting>,
}

pub struct Coordinator {
    cfg: ScheduleConfig,
    log: Logger,
    slots: BTreeMap<String, Slot>,
}

impl Coordinator {
    pub fn new(cfg: ScheduleConfig, log: Logger) -> Self {
        Self {
            cfg,
            log,
            slots: BTreeMap::new(),
        }
    }

    /// Time until which fetching is held off (no hold once it has passed)
    pub fn hold_until(&self, id: &str) -> i64 {
        self.slots.get(id).map_or(0, |s| s.hold_until)
    }

    /// When the agent next decides whether to fetch the provider, for `headroom status`. Read-only: it never changes the schedule.
    /// `fetch_due_ms` is the provider's own schedule (i64::MAX = none); providers already include a hold passed to them,
    /// so a hold that equals it is still reported with its reason. A stretch or a deferral is only known once
    /// `before_fetch` applies it at the reported time
    pub fn next_run(&self, id: &str, fetch_due_ms: i64, now: i64) -> NextRun {
        if fetch_due_ms == i64::MAX {
            return NextRun {
                at_ms: None,
                waiting: None,
                disabled: false,
            };
        }
        match self.slots.get(id) {
            Some(slot) if slot.hold_until > now && slot.hold_until >= fetch_due_ms => NextRun {
                at_ms: Some(slot.hold_until),
                waiting: slot.hold_reason,
                disabled: false,
            },
            _ => NextRun {
                at_ms: Some(fetch_due_ms),
                waiting: None,
                disabled: false,
            },
        }
    }

    /// For a provider whose fetch is due, decides whether it may fetch now. If holding off, sets `hold_until` and returns false
    pub fn before_fetch(
        &mut self,
        id: &str,
        interval_min: i64,
        latest: Option<&ProviderSnapshot>,
        asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) -> bool {
        let idle_ms = self.cfg.idle_interval_min.max(0) * MINUTE_MS;
        let own_ms = self.cfg.own_fetch_min.max(1) * MINUTE_MS;
        let slot = self.slots.entry(id.to_string()).or_default();
        // If this PC has not fetched for a long time, fetch without asking even while holding off (safety net; checked before the lease)
        if slot.last_fetch > 0 && now - slot.last_fetch >= own_ms {
            return true;
        }
        if slot.hold_until > now {
            return false;
        }
        // Stretch the interval while nothing changes (same for the holder; its lease was already extended in after_fetch)
        if slot.last_fetch > 0
            && idle(&self.cfg, slot, latest, interval_min, now)
            && now < slot.last_fetch + idle_ms
        {
            slot.hold_until = slot.last_fetch + idle_ms;
            slot.hold_reason = Some(Waiting::Idle);
            return false;
        }
        // Right after startup, fetch without asking
        if slot.last_fetch == 0 {
            return true;
        }
        let Some(asker) = asker else {
            return true;
        };
        match asker.ask_turn(id, interval_min.max(1) + TURN_GRACE_MIN) {
            Some(TurnReply { go: true, .. }) => {
                if !slot.holder {
                    self.log.log(&format!("{id}: took the fetch turn"));
                }
                slot.holder = true;
                slot.deferring = false;
                slot.granted_until = now + (interval_min.max(1) + TURN_GRACE_MIN) * MINUTE_MS;
                true
            }
            Some(TurnReply { go: false, wait_ms }) => {
                if !slot.deferring {
                    self.log
                        .log(&format!("{id}: another PC holds the fetch turn; deferring"));
                }
                slot.holder = false;
                slot.deferring = true;
                // Ask again when the lease ends, but no later than one normal turn from now (a holder that stopped and
                // released a long lease, e.g. while a limit is reached, is replaced within that time). Never hold off past the safety-net time
                let recheck = now + (interval_min.max(1) + TURN_GRACE_MIN) * MINUTE_MS;
                slot.hold_until = (now + wait_ms.max(0) + RETRY_AFTER_MS)
                    .min(recheck)
                    .min(slot.last_fetch + own_ms);
                slot.hold_reason = Some(Waiting::Turn);
                false
            }
            // Destination unreachable or answer unreadable: fetch on this PC
            None => true,
        }
    }

    /// Releases every turn this PC holds, so another PC can take over at its next check (called when the agent stops)
    pub fn release_turns(&mut self, asker: Option<&mut dyn TurnAsker>) {
        let Some(asker) = asker else {
            return;
        };
        for (id, slot) in self.slots.iter_mut().filter(|(_, s)| s.holder) {
            let released = asker.ask_turn(id, 0).is_some();
            slot.holder = false;
            slot.granted_until = 0;
            self.log.log(&release_message(id, released));
        }
    }

    /// The provider fetched on its own without asking for the turn (e.g. the fetch following the version check at startup)
    pub fn record_fetch(&mut self, id: &str, now: i64) {
        self.slots.entry(id.to_string()).or_default().last_fetch = now;
    }

    /// After a fetch: on success extend the turn until the next fetch, on failure release it. `next_fetch_ms` is the provider's next scheduled fetch
    pub fn after_fetch(
        &mut self,
        id: &str,
        snapshot: &ProviderSnapshot,
        next_fetch_ms: i64,
        interval_min: i64,
        asker: Option<&mut dyn TurnAsker>,
        now: i64,
    ) {
        let idle_ms = self.cfg.idle_interval_min.max(0) * MINUTE_MS;
        let stretched = idle(
            &self.cfg,
            self.slots.entry(id.to_string()).or_default(),
            Some(snapshot),
            interval_min,
            now,
        );
        let slot = self.slots.entry(id.to_string()).or_default();
        slot.last_fetch = now;
        let Some(asker) = asker else {
            return;
        };
        if !slot.holder {
            return;
        }
        // Treat it as a failure even if a previous value was returned (Claude keeps status: ok while it has a recent previous value)
        let failed = snapshot.status != ProviderStatus::Ok
            || snapshot.error.is_some()
            || snapshot.error_code.is_some();
        if failed || next_fetch_ms == i64::MAX {
            // Cannot fetch / stopped: release so another PC can take over
            let released = asker.ask_turn(id, 0).is_some();
            slot.holder = false;
            slot.granted_until = 0;
            self.log.log(&release_message(id, released));
            return;
        }
        // If the next fetch is after the lease (limit reached or stretched interval), extend it (stretching is decided in the next before_fetch, so anticipate it)
        let next = if stretched {
            next_fetch_ms.max(now + idle_ms)
        } else {
            next_fetch_ms
        };
        let need = next.saturating_add(TURN_GRACE_MIN * MINUTE_MS);
        if need > slot.granted_until {
            let minutes = ((need - now + MINUTE_MS - 1) / MINUTE_MS).clamp(1, TURN_MAX_MIN);
            if let Some(TurnReply { go: true, .. }) = asker.ask_turn(id, minutes) {
                slot.granted_until = now + minutes * MINUTE_MS;
            }
        }
    }

    /// Records value changes from a collect result (used to decide on stretching the interval)
    pub fn observe(&mut self, id: &str, snapshot: &ProviderSnapshot, now: i64) {
        let slot = self.slots.entry(id.to_string()).or_default();
        let values: Vec<_> = snapshot
            .windows
            .iter()
            .map(|w| (w.id.clone(), w.used_percent.to_bits(), w.resets_at.clone()))
            .collect();
        if slot.last_values.as_ref() != Some(&values) {
            slot.last_values = Some(values);
            slot.last_change = now;
        }
    }
}

fn release_message(id: &str, released: bool) -> String {
    if released {
        format!("{id}: released the fetch turn")
    } else {
        format!("{id}: could not release the fetch turn (it ends when its lease expires)")
    }
}

/// Conditions for stretching: stretching is enabled, values unchanged for 30 minutes, fetches succeed and overall limits are far from full
fn idle(
    cfg: &ScheduleConfig,
    slot: &Slot,
    latest: Option<&ProviderSnapshot>,
    interval_min: i64,
    now: i64,
) -> bool {
    cfg.idle_interval_min > interval_min.max(1)
        && slot.last_values.is_some()
        && now - slot.last_change >= IDLE_AFTER_MIN * MINUTE_MS
        && latest.is_some_and(quiet)
}

/// Fetches succeed and overall limits are far from full
fn quiet(p: &ProviderSnapshot) -> bool {
    p.status == ProviderStatus::Ok
        && p.error_code.is_none()
        && p.blocked != Some(true)
        && p.windows
            .iter()
            .filter(|w| w.scope.is_none())
            .all(|w| w.used_percent < IDLE_MAX_PERCENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{UsageWindow, WindowKind};

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

    /// Stand-in for the destination. Holds a single turn
    #[derive(Default)]
    struct FakeWorker {
        calls: Vec<(String, i64)>,
        /// Some(go, wait_ms). None means unreachable
        reply: Option<(bool, i64)>,
    }

    impl TurnAsker for FakeWorker {
        fn ask_turn(&mut self, provider: &str, minutes: i64) -> Option<TurnReply> {
            self.calls.push((provider.into(), minutes));
            self.reply.map(|(go, wait_ms)| TurnReply { go, wait_ms })
        }
    }

    fn coord(idle: i64) -> Coordinator {
        Coordinator::new(
            ScheduleConfig {
                idle_interval_min: idle,
                own_fetch_min: 60,
            },
            Logger::stderr(),
        )
    }

    #[test]
    fn first_fetch_after_start_does_not_ask_then_the_holder_fetches() {
        let mut c = coord(0);
        let mut w = FakeWorker {
            reply: Some((true, 0)),
            ..Default::default()
        };
        let s = snap(10.0, ProviderStatus::Ok);
        assert!(c.before_fetch("claude", 5, Some(&s), Some(&mut w), T0));
        assert!(
            w.calls.is_empty(),
            "fetches without asking right after startup"
        );
        c.after_fetch("claude", &s, T0 + 5 * MINUTE_MS, 5, Some(&mut w), T0);
        assert!(c.before_fetch("claude", 5, Some(&s), Some(&mut w), T0 + 5 * MINUTE_MS));
        assert_eq!(w.calls, [("claude".to_string(), 7)]);
    }

    #[test]
    fn next_run_reports_the_hold_and_its_reason() {
        let mut c = coord(0);
        let s = snap(10.0, ProviderStatus::Ok);
        // Own schedule only
        let own = c.next_run("codex", T0 + MINUTE_MS, T0);
        assert_eq!(own.at_ms, Some(T0 + MINUTE_MS));
        assert_eq!(own.waiting, None);
        // Another PC holds the turn: the next check is the end of the hold, not the past due time
        let mut w = FakeWorker {
            reply: Some((false, 4 * MINUTE_MS)),
            ..Default::default()
        };
        assert!(c.before_fetch("codex", 5, Some(&s), Some(&mut w), T0));
        c.after_fetch("codex", &s, T0 + 5 * MINUTE_MS, 5, Some(&mut w), T0);
        let now = T0 + 5 * MINUTE_MS;
        assert!(!c.before_fetch("codex", 5, Some(&s), Some(&mut w), now));
        let hold = c.hold_until("codex");
        assert!(hold > now);
        let held = c.next_run("codex", now, now);
        assert_eq!(held.at_ms, Some(hold));
        assert_eq!(held.waiting, Some(Waiting::Turn));
        assert!(
            held.describe()
                .ends_with("(another PC holds the fetch turn; checks again then)")
        );
        // Providers already include the hold in their own due time: the reason is still shown
        let included = c.next_run("codex", hold, now);
        assert_eq!(included.at_ms, Some(hold));
        assert_eq!(included.waiting, Some(Waiting::Turn));
        // Nothing scheduled, and disabled
        let none = c.next_run("codex", i64::MAX, now);
        assert_eq!(none.at_ms, None);
        assert_eq!(none.describe(), "none (not scheduled)");
        let disabled = NextRun {
            disabled: true,
            ..none
        };
        assert_eq!(disabled.describe(), "none (disabled)");
    }

    #[test]
    fn a_stretch_is_reported_once_applied_even_after_deferring() {
        let mut c = coord(10);
        let s = snap(10.0, ProviderStatus::Ok);
        c.observe("codex", &s, T0);
        c.record_fetch("codex", T0 + 30 * MINUTE_MS);
        let last = T0 + 30 * MINUTE_MS;
        // Before the next decision, the next check is the provider's own due time (the stretch is not known yet)
        let before = c.next_run("codex", last + 5 * MINUTE_MS, last);
        assert_eq!(before.at_ms, Some(last + 5 * MINUTE_MS));
        assert_eq!(before.waiting, None);
        // At that time the stretch is applied and reported with its reason
        assert!(!c.before_fetch("codex", 5, Some(&s), None, last + 5 * MINUTE_MS));
        let stretched = c.next_run("codex", last + 5 * MINUTE_MS, last + 5 * MINUTE_MS);
        assert_eq!(stretched.at_ms, Some(last + 10 * MINUTE_MS));
        assert_eq!(stretched.waiting, Some(Waiting::Idle));
        // Then another PC holds the turn
        let mut w = FakeWorker {
            reply: Some((false, 2 * MINUTE_MS)),
            ..Default::default()
        };
        assert!(!c.before_fetch("codex", 5, Some(&s), Some(&mut w), last + 10 * MINUTE_MS));
        let deferred = c.next_run("codex", last + 10 * MINUTE_MS, last + 10 * MINUTE_MS);
        assert_eq!(deferred.waiting, Some(Waiting::Turn));
        // A later fetch on this PC, then a stretch: the reason changes to Idle even though the deferring flag stays set
        c.record_fetch("codex", last + 20 * MINUTE_MS);
        let next = last + 25 * MINUTE_MS;
        assert!(!c.before_fetch("codex", 5, Some(&s), Some(&mut w), next));
        let run = c.next_run("codex", next, next);
        assert_eq!(run.at_ms, Some(last + 30 * MINUTE_MS));
        assert_eq!(run.waiting, Some(Waiting::Idle));
    }

    #[test]
    fn another_holder_defers_until_its_turn_ends_and_the_safety_net_fetches_hourly() {
        let mut c = coord(0);
        let mut w = FakeWorker {
            reply: Some((false, 4 * MINUTE_MS)),
            ..Default::default()
        };
        let s = snap(10.0, ProviderStatus::Ok);
        assert!(c.before_fetch("codex", 5, Some(&s), Some(&mut w), T0));
        c.after_fetch("codex", &s, T0 + 5 * MINUTE_MS, 5, Some(&mut w), T0);
        let t = T0 + 5 * MINUTE_MS;
        assert!(!c.before_fetch("codex", 5, Some(&s), Some(&mut w), t));
        assert_eq!(c.hold_until("codex"), t + 4 * MINUTE_MS + RETRY_AFTER_MS);
        // Does not ask again before the lease expires
        assert!(!c.before_fetch("codex", 5, Some(&s), Some(&mut w), t + MINUTE_MS));
        assert_eq!(w.calls.len(), 1);
        // After 60 minutes without fetching on this PC, fetch without asking
        assert!(c.before_fetch("codex", 5, Some(&s), Some(&mut w), T0 + 60 * MINUTE_MS));
        assert_eq!(w.calls.len(), 1);
    }

    #[test]
    fn unreachable_worker_or_no_push_falls_back_to_fetching() {
        let mut c = coord(0);
        let s = snap(10.0, ProviderStatus::Ok);
        c.after_fetch("claude", &s, T0 + 5 * MINUTE_MS, 5, None, T0);
        assert!(c.before_fetch("claude", 5, Some(&s), None, T0 + 5 * MINUTE_MS));
        let mut down = FakeWorker::default();
        assert!(c.before_fetch("claude", 5, Some(&s), Some(&mut down), T0 + 10 * MINUTE_MS));
        assert_eq!(down.calls.len(), 1);
    }

    #[test]
    fn the_holder_releases_its_turn_when_fetching_fails_and_extends_it_for_long_waits() {
        let mut c = coord(0);
        let mut w = FakeWorker {
            reply: Some((true, 0)),
            ..Default::default()
        };
        let ok = snap(10.0, ProviderStatus::Ok);
        c.after_fetch("claude", &ok, T0 + 5 * MINUTE_MS, 5, Some(&mut w), T0);
        let t = T0 + 5 * MINUTE_MS;
        assert!(c.before_fetch("claude", 5, Some(&ok), Some(&mut w), t));
        // Limit reached and next fetch in 40 minutes: extend the lease
        c.after_fetch("claude", &ok, t + 40 * MINUTE_MS, 5, Some(&mut w), t);
        assert_eq!(w.calls.last(), Some(&("claude".to_string(), 42)));
        // Next fetch fails: release
        let t2 = t + 40 * MINUTE_MS;
        assert!(c.before_fetch("claude", 5, Some(&ok), Some(&mut w), t2));
        c.after_fetch(
            "claude",
            &snap(10.0, ProviderStatus::Error),
            t2 + 5 * MINUTE_MS,
            5,
            Some(&mut w),
            t2,
        );
        assert_eq!(w.calls.last(), Some(&("claude".to_string(), 0)));
    }

    #[test]
    fn unchanged_values_stretch_the_interval_until_they_change() {
        let mut c = coord(10);
        let s = snap(10.0, ProviderStatus::Ok);
        c.observe("claude", &s, T0);
        let mut t = T0;
        // Values unchanged for 30 minutes, fetching every 5 minutes
        while t < T0 + 30 * MINUTE_MS {
            assert!(c.before_fetch("claude", 5, Some(&s), None, t), "{t}");
            c.after_fetch("claude", &s, t + 5 * MINUTE_MS, 5, None, t);
            c.observe("claude", &s, t);
            t += 5 * MINUTE_MS;
        }
        // After 30 minutes: stretch to 10 minutes after the previous fetch
        assert!(!c.before_fetch("claude", 5, Some(&s), None, t));
        assert_eq!(c.hold_until("claude"), t + 5 * MINUTE_MS);
        assert!(c.before_fetch("claude", 5, Some(&s), None, t + 5 * MINUTE_MS));
        // Back to the normal interval once a value changes
        let changed = snap(11.0, ProviderStatus::Ok);
        c.after_fetch("claude", &changed, 0, 5, None, t + 5 * MINUTE_MS);
        c.observe("claude", &changed, t + 5 * MINUTE_MS);
        assert!(c.before_fetch("claude", 5, Some(&changed), None, t + 10 * MINUTE_MS));
        // Not stretched when close to the limit (80 % or more)
        let high = snap(85.0, ProviderStatus::Ok);
        let mut c2 = coord(10);
        c2.observe("claude", &high, T0);
        c2.after_fetch("claude", &high, 0, 5, None, T0 + 40 * MINUTE_MS);
        assert!(c2.before_fetch("claude", 5, Some(&high), None, T0 + 45 * MINUTE_MS));
    }

    #[test]
    fn the_safety_net_fetches_within_60_minutes_even_if_another_holder_extends_its_turn() {
        let mut c = coord(0);
        let mut w = FakeWorker {
            reply: Some((false, 62 * MINUTE_MS)),
            ..Default::default()
        };
        let s = snap(10.0, ProviderStatus::Ok);
        c.record_fetch("claude", T0);
        assert!(!c.before_fetch("claude", 5, Some(&s), Some(&mut w), T0 + 5 * MINUTE_MS));
        assert_eq!(
            c.hold_until("claude"),
            T0 + 12 * MINUTE_MS,
            "a long lease is checked again after one normal turn (5 + 2 minutes)"
        );
        let mut t = T0 + 12 * MINUTE_MS;
        while t < T0 + 60 * MINUTE_MS {
            assert!(!c.before_fetch("claude", 5, Some(&s), Some(&mut w), t));
            t = c.hold_until("claude");
        }
        assert_eq!(
            t,
            T0 + 60 * MINUTE_MS,
            "never holds off past the safety net"
        );
        let asked = w.calls.len();
        assert!(c.before_fetch("claude", 5, Some(&s), Some(&mut w), t));
        assert_eq!(w.calls.len(), asked, "the safety-net fetch does not ask");
    }

    /// Stand-in destination holding one provider's lease on a clock the test sets, shared by two PCs
    #[derive(Default)]
    struct Lease {
        holder: Option<&'static str>,
        until: i64,
        now: i64,
        releases: usize,
    }

    struct Pc<'a> {
        name: &'static str,
        lease: &'a std::cell::RefCell<Lease>,
    }

    impl TurnAsker for Pc<'_> {
        fn ask_turn(&mut self, _provider: &str, minutes: i64) -> Option<TurnReply> {
            let mut l = self.lease.borrow_mut();
            if minutes == 0 {
                if l.holder == Some(self.name) {
                    l.holder = None;
                    l.releases += 1;
                }
                return Some(TurnReply {
                    go: true,
                    wait_ms: 0,
                });
            }
            if l.holder.is_none() || l.holder == Some(self.name) || l.now >= l.until {
                l.holder = Some(self.name);
                l.until = l.now + minutes * MINUTE_MS;
                return Some(TurnReply {
                    go: true,
                    wait_ms: 0,
                });
            }
            Some(TurnReply {
                go: false,
                wait_ms: l.until - l.now,
            })
        }
    }

    #[test]
    fn a_stopping_holder_releases_and_the_other_pc_takes_over_within_one_turn() {
        let s = snap(10.0, ProviderStatus::Ok);
        // Normal, stretched and limit-reached leases (the holder's next fetch in 5, 10 and 60 minutes)
        for next_fetch_min in [5, 10, 60] {
            for graceful in [true, false] {
                let lease = std::cell::RefCell::new(Lease::default());
                let mut a = Pc {
                    name: "a",
                    lease: &lease,
                };
                let mut b = Pc {
                    name: "b",
                    lease: &lease,
                };
                // PC a takes the turn and extends it to its next fetch + 2 minutes
                let mut holder = coord(0);
                holder.record_fetch("codex", T0);
                lease.borrow_mut().now = T0 + 5 * MINUTE_MS;
                assert!(holder.before_fetch(
                    "codex",
                    5,
                    Some(&s),
                    Some(&mut a),
                    T0 + 5 * MINUTE_MS
                ));
                holder.after_fetch(
                    "codex",
                    &s,
                    T0 + (5 + next_fetch_min) * MINUTE_MS,
                    5,
                    Some(&mut a),
                    T0 + 5 * MINUTE_MS,
                );
                let lease_end = lease.borrow().until;
                assert_eq!(lease_end, T0 + (5 + next_fetch_min.max(5) + 2) * MINUTE_MS);
                // PC b fetched at startup; its fetch is due every 5 minutes. It asks only when due (the agent's path)
                let mut other = coord(0);
                other.record_fetch("codex", T0 + 30_000);
                let mut due = T0 + 5 * MINUTE_MS + 30_000;
                let stopped_at = T0 + 6 * MINUTE_MS;
                let mut stopped = false;
                let took_over = loop {
                    if !stopped && due >= stopped_at {
                        stopped = true;
                        if graceful {
                            holder.release_turns(Some(&mut a));
                        }
                    }
                    lease.borrow_mut().now = due;
                    if other.before_fetch("codex", 5, Some(&s), Some(&mut b), due) {
                        break due;
                    }
                    // The next decision is the later of the hold and the next due time
                    due = other.hold_until("codex").max(due + MINUTE_MS);
                    assert!(due < T0 + 120 * MINUTE_MS, "never takes over");
                };
                let name = format!("next fetch {next_fetch_min}m, graceful {graceful}");
                if graceful {
                    assert_eq!(lease.borrow().releases, 1, "{name}");
                    // The first ask was 30 s before the stop; the recheck is one turn (5 + 2 minutes) later at most
                    assert!(
                        took_over <= T0 + 5 * MINUTE_MS + 30_000 + 7 * MINUTE_MS,
                        "{name}"
                    );
                } else {
                    // An abrupt stop waits for the lease, checked once a turn, or the safety net (60 minutes) comes first
                    let bound = (lease_end + 7 * MINUTE_MS).min(T0 + 30_000 + 60 * MINUTE_MS);
                    assert!(took_over <= bound, "{name}: {took_over} > {bound}");
                    assert!(
                        took_over >= lease_end.min(T0 + 30_000 + 60 * MINUTE_MS),
                        "{name}"
                    );
                }
            }
        }
        // Releasing twice sends one release; a turn this PC doesn't hold isn't released
        let lease = std::cell::RefCell::new(Lease::default());
        let mut a = Pc {
            name: "a",
            lease: &lease,
        };
        let mut c = coord(0);
        c.release_turns(Some(&mut a));
        assert_eq!(lease.borrow().releases, 0);
    }

    #[test]
    fn a_failed_fetch_with_a_cached_ok_value_still_releases_the_turn() {
        let mut c = coord(0);
        let mut w = FakeWorker {
            reply: Some((true, 0)),
            ..Default::default()
        };
        let ok = snap(10.0, ProviderStatus::Ok);
        c.record_fetch("claude", T0);
        assert!(c.before_fetch("claude", 5, Some(&ok), Some(&mut w), T0 + 5 * MINUTE_MS));
        let mut cached = snap(10.0, ProviderStatus::Ok);
        cached.error = Some("Fetch failed".into());
        cached.error_code = Some(crate::schema::ErrorCode::FetchFailed);
        c.after_fetch(
            "claude",
            &cached,
            T0 + 15 * MINUTE_MS,
            5,
            Some(&mut w),
            T0 + 5 * MINUTE_MS,
        );
        assert_eq!(w.calls.last(), Some(&("claude".to_string(), 0)));
    }

    #[test]
    fn the_holder_keeps_its_turn_through_the_stretched_interval() {
        let mut c = coord(10);
        let mut w = FakeWorker {
            reply: Some((true, 0)),
            ..Default::default()
        };
        let s = snap(10.0, ProviderStatus::Ok);
        c.observe("claude", &s, T0);
        c.record_fetch("claude", T0);
        // Takes the turn and fetches after 30 minutes without changes
        let t = T0 + 30 * MINUTE_MS;
        assert!(c.before_fetch("claude", 5, Some(&s), Some(&mut w), t));
        assert_eq!(w.calls.last(), Some(&("claude".to_string(), 7)));
        // The stretched interval puts the next fetch 10 minutes out, so extend the lease to 12 minutes (no other PC fetches in between)
        c.after_fetch("claude", &s, t + 5 * MINUTE_MS, 5, Some(&mut w), t);
        assert_eq!(w.calls.last(), Some(&("claude".to_string(), 12)));
    }

    #[test]
    fn a_fetch_the_provider_made_by_itself_counts_as_the_first_fetch() {
        let mut c = coord(0);
        let mut w = FakeWorker {
            reply: Some((false, MINUTE_MS)),
            ..Default::default()
        };
        let s = snap(10.0, ProviderStatus::Ok);
        c.record_fetch("claude", T0);
        assert!(
            !c.before_fetch("claude", 5, Some(&s), Some(&mut w), T0 + 5 * MINUTE_MS),
            "asks from the second fetch on"
        );
        assert_eq!(w.calls.len(), 1);
    }
}
