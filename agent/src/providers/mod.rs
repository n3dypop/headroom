//! Common provider interface. Each provider only knows "when to run next" and "fetch and return a ProviderSnapshot".

pub mod claude;
pub mod codex;

use crate::schema::ProviderSnapshot;

/// Events delivered to the main loop from file watching and the like.
#[derive(Debug, Clone)]
pub enum Event {
    /// The statusLine capture file was updated
    ClaudeStatuslineCaptured,
    /// The resident agent was asked to stop (`headroom stop` / `install` / `uninstall`). Not used by providers
    StopRequested,
}

pub trait Provider {
    fn id(&self) -> &'static str;
    /// Time (epoch ms) at which collect should run next. i64::MAX if nothing is scheduled
    fn next_due_ms(&self, now: i64) -> i64;
    /// Fetch and return the result. `force` means a manual run (ignores the interval limit)
    fn collect(&mut self, now: i64, force: bool) -> ProviderSnapshot;
    fn on_event(&mut self, _event: &Event) {}
    /// Time of the next planned query to Anthropic / OpenAI (excludes passive processing and local checks).
    /// Defaults to next_due_ms (for providers without passive input)
    fn fetch_due_ms(&self, now: i64) -> i64 {
        self.next_due_ms(now)
    }
    /// Hold off queries until this time (another PC is on duty, or the interval is extended while nothing changes; see schedule.rs).
    /// Providers that can keep doing passive processing only (statusLine etc.) return true. The default is false,
    /// in which case the resident agent does not call collect at all while holding off
    fn hold_fetch_until(&mut self, _until_ms: i64) -> bool {
        false
    }
    /// Forget the values cached so far (the destination refused this PC's clock: they were stamped by it, and one hidden behind a newer
    /// value of the same window could come back later). false if that couldn't be saved (tried again). Default: nothing cached beyond
    /// what the latest values show
    fn forget_cached(&mut self) -> bool {
        true
    }
    /// Whether a round can take passive values (statusLine etc.) besides fetching. Such a round is held from fetching on its own
    /// (the agent checks the fetch turn first). Default false
    fn takes_passive_values(&self) -> bool {
        false
    }
    /// Time of the last query attempt. Used to notice fetches the provider made on its own, outside the scheduler
    /// (e.g. a fetch following the version check right after startup). Default None (only scheduled fetches count)
    fn last_fetch_attempt_ms(&self) -> Option<i64> {
        None
    }
    /// Accept an account switch and resume fetching (manual `--accept-account`). Default: no-op
    fn accept_account(&mut self) {}
    /// After a collect with an acceptance: Some(true) if the switch was accepted and saved, Some(false) if not, None if this provider
    /// doesn't say
    fn account_accepted(&self) -> Option<bool> {
        None
    }
}
