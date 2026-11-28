//! When the client may read the server next. One time only: success, failure and a manual refresh all follow it (the server's
//! derived values change every 5 minutes, so reading more often shows nothing new and spends the free plan's requests).

/// After a successful read
pub const SUCCESS_WAIT_MS: i64 = 5 * 60_000;
/// After failures in a row: 5, 10, 20, then 30 minutes (back to 5 after a success)
pub const FAILURE_WAITS_MS: [i64; 4] = [5 * 60_000, 10 * 60_000, 20 * 60_000, 30 * 60_000];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Schedule {
    /// The earliest time of the next read (ms on a clock that the PC's time setting doesn't move); None before the first one
    pub next_at: Option<i64>,
    /// Failures in a row since the last success
    pub failures: u32,
    /// When the server was last read (whatever came of it)
    pub last_at: Option<i64>,
}

impl Schedule {
    /// Whether a read may start now (automatic or manual)
    pub fn may_read(&self, now: i64) -> bool {
        self.next_at.is_none_or(|t| t <= now)
    }

    /// How long until the next read may start (0 when it may start now)
    pub fn wait_ms(&self, now: i64) -> i64 {
        self.next_at.map_or(0, |t| (t - now).max(0))
    }

    pub fn succeeded(&mut self, now: i64) {
        self.failures = 0;
        self.last_at = Some(now);
        self.next_at = Some(now + SUCCESS_WAIT_MS);
    }

    pub fn failed(&mut self, now: i64) {
        self.failures = self.failures.saturating_add(1);
        self.last_at = Some(now);
        let step = (self.failures as usize - 1).min(FAILURE_WAITS_MS.len() - 1);
        self.next_at = Some(now + FAILURE_WAITS_MS[step]);
    }

    /// A read whose result isn't taken (the settings changed meanwhile): it still counts as a read, so the next one is at least
    /// 5 minutes after it; it neither adds a failure nor shortens a wait
    pub fn read_anyway(&mut self, now: i64) {
        self.last_at = Some(now);
        self.next_at = Some(
            self.next_at
                .map_or(now + SUCCESS_WAIT_MS, |t| t.max(now + SUCCESS_WAIT_MS)),
        );
    }

    /// A new token for the server: the failures were likely the old token's, so the wait is cut back to 5 minutes after the last
    /// read (never sooner: the 5 minutes always hold)
    pub fn new_token(&mut self) {
        self.failures = 0;
        if let (Some(next), Some(last)) = (self.next_at, self.last_at) {
            self.next_at = Some(next.min(last + SUCCESS_WAIT_MS));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_token_waits_at_most_five_minutes_and_never_less() {
        let mut s = Schedule::default();
        s.failed(0);
        s.failed(5 * 60_000);
        s.failed(15 * 60_000);
        assert_eq!(s.next_at, Some(35 * 60_000));
        s.new_token();
        assert_eq!(
            s.next_at,
            Some(20 * 60_000),
            "5 minutes after the last read"
        );
        assert_eq!(s.failures, 0);
        // A late answer to a read before the change: still 5 minutes from it, no more
        s.read_anyway(18 * 60_000);
        assert_eq!(s.next_at, Some(23 * 60_000));
        let mut fresh = Schedule::default();
        fresh.new_token();
        assert!(fresh.may_read(0), "never read: at once");
    }

    #[test]
    fn first_read_is_allowed_then_waits_five_minutes() {
        let mut s = Schedule::default();
        assert!(s.may_read(0));
        s.succeeded(1_000);
        assert!(!s.may_read(1_000 + SUCCESS_WAIT_MS - 1));
        assert!(s.may_read(1_000 + SUCCESS_WAIT_MS));
        assert_eq!(s.wait_ms(1_000), SUCCESS_WAIT_MS);
    }

    #[test]
    fn failures_back_off_and_a_success_resets() {
        let mut s = Schedule::default();
        let waits: Vec<i64> = (0..6)
            .map(|_| {
                s.failed(0);
                s.wait_ms(0)
            })
            .collect();
        assert_eq!(waits, [5, 10, 20, 30, 30, 30].map(|m| m * 60_000));
        s.succeeded(0);
        assert_eq!((s.failures, s.wait_ms(0)), (0, SUCCESS_WAIT_MS));
    }

    #[test]
    fn a_manual_refresh_follows_the_same_time() {
        let mut s = Schedule::default();
        s.succeeded(0);
        assert!(!s.may_read(60_000), "a minute later: not yet");
        assert!(s.may_read(5 * 60_000), "five minutes later");
    }
}
