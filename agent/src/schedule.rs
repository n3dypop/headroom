//! Fetch coordination.
//!
//! - **Turn-taking:** if push is configured, ask the destination "may I fetch?" before each fetch (a query to Anthropic / OpenAI),
//!   and defer until the turn expires if another PC holds it. If the destination is unreachable or push is not configured, fetch
//!   on this PC as before (correctness does not depend on the destination). On a failed fetch, release the turn so another PC can take over.
//! - **Safety net:** even while deferring, fetch on this PC at least once per `own_fetch_min` (default 60 minutes) to notice account
//!   switches, expired sign-ins or CLI version changes on this PC. The first fetch after startup is also done on this PC.
//! - **Stretching the interval when nothing changes:** if values do not change for 30 minutes and overall limit usage is below 80 %,
//!   stretch the fetch interval to `idle_interval_min` (default 10 minutes). It returns to normal when a value changes.
//!
//! All times are this PC's clock (ms). Only relative times (minutes / seconds) are exchanged with the destination.

use std::collections::BTreeMap;

use crate::config::ScheduleConfig;
use crate::schema::{ProviderSnapshot, ProviderStatus};
use crate::store::Logger;
use crate::time::MINUTE_MS;

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
                // Never hold off past the safety-net time
                slot.hold_until =
                    (now + wait_ms.max(0) + RETRY_AFTER_MS).min(slot.last_fetch + own_ms);
                false
            }
            // Destination unreachable or answer unreadable: fetch on this PC
            None => true,
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
            let _ = asker.ask_turn(id, 0);
            slot.holder = false;
            slot.granted_until = 0;
            self.log.log(&format!("{id}: released the fetch turn"));
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
            T0 + 60 * MINUTE_MS,
            "never holds off past the safety net"
        );
        assert!(c.before_fetch("claude", 5, Some(&s), Some(&mut w), T0 + 60 * MINUTE_MS));
        assert_eq!(w.calls.len(), 1, "the safety-net fetch does not ask");
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
