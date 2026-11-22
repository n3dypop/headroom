//! Common provider interface. Each provider only knows "when to run next" and "fetch and return a ProviderSnapshot".

pub mod claude;
pub mod codex;
pub mod gemini;

use crate::schema::ProviderSnapshot;

/// Every provider id, in a fixed order (the agent's counterpart of core's PROVIDERS)
pub const PROVIDER_IDS: [&str; 3] = ["claude", "codex", "gemini"];

/// Providers whose fetch isn't verified on a real machine yet: shown as not supported while turned off
pub const UNVERIFIED_PROVIDERS: &[&str] = &["gemini"];

/// Passive values a provider holds (its statusLine): when they were received, and the windows they carry
#[derive(Debug, Clone, PartialEq)]
pub struct Passive {
    pub at_ms: i64,
    pub windows: Vec<String>,
}

/// What an active fetch came to, as the provider classified it (only an upstream answer it could tell apart)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Failed,
    /// Rate limited upstream (429), with the wait it named if it named one
    RateLimited {
        retry_ms: Option<i64>,
    },
    /// Access denied upstream (403)
    AccessDenied,
}

/// What a collect did upstream
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Run {
    /// Nothing went upstream (a cached value, a lock held elsewhere, a launch that failed before the query)
    NotRun,
    /// The query ran and its outcome is known
    Ran(Outcome),
    /// The query may have run and its outcome can't be confirmed (a timeout, output cut): the shared state waits for the user
    Unknown,
}

/// Events delivered to the main loop from file watching and the like.
#[derive(Debug, Clone)]
pub enum Event {
    /// The statusLine capture file was updated
    ClaudeStatuslineCaptured,
    /// The Antigravity statusLine capture file (gemini-statusline.json) was updated
    GeminiStatuslineCaptured,
    /// The resident agent was asked to stop (`headroom stop` / `install` / `uninstall`). Not used by providers
    StopRequested,
    /// A manual collect asked the resident agent (it wakes to take it). Not used by providers
    CollectRequested,
}

/// Whether a CLI's error text says the service denies this account (an HTTP 403 of the service, an account on hold or suspended, an
/// organization that doesn't allow it), as the services document or report it. Text only, never kept: a match stops the provider on
/// every PC until the user resumes it (a wrong match stops fetching, never the other way). Shapes (from public sources, not seen here):
/// - Claude Code: `Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted` (error
///   code `account_on_hold` in -p mode), `Your organization has disabled Claude subscription access for Claude Code`
///   (`oauth_org_not_allowed`), `OAuth authentication is currently not allowed for this organization`, `API Error: 403 {...}` with
///   `permission_error` or `forbidden`
/// - Antigravity CLI: `Eligibility check failed: PERMISSION_DENIED (code 403): This service has been disabled in this account for
///   violation of Terms of Service. ...`, `403 PERMISSION_DENIED`
pub fn says_access_denied(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| t.contains(w));
    any(&[
        "your account is on hold",
        "https://claude.ai/restricted",
        "has disabled claude subscription access",
        "oauth authentication is currently not allowed for this organization",
        "this organization has been disabled",
        // The Antigravity message in full (the phrase alone may be in a local error, as a file's name)
        "service has been disabled in this account for violation of terms of service",
    ]) || (t.contains("api error: 403") && any(&["permission_error", "forbidden"]))
        || (t.contains("permission_denied") && any(&["code 403", "403 permission_denied"]))
}

/// Whether an error code a CLI gives (a field of its result, never free text: a local file may be named so) says the service denies
/// the account (Claude Code's -p codes)
pub fn is_denial_code(code: &str) -> bool {
    matches!(code.trim(), "account_on_hold" | "oauth_org_not_allowed")
}

/// The go of one attempt: usable until both deadlines, fixed right before the turn was asked (this PC's clock and the monotonic one).
/// Never counted again from a later moment: a late answer, a wait for a lock or a save in between all come out of it
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Grant {
    pub until_ms: i64,
    pub until: std::time::Instant,
}

impl Grant {
    /// Whether it can't be used now (either deadline reached)
    pub fn passed(&self, now_ms: i64) -> bool {
        now_ms >= self.until_ms || std::time::Instant::now() >= self.until
    }
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
    /// The passive values in use (statusLine): the common schedule puts the active fetch off while they are recent and carry every
    /// overall limit (schedule.rs). None without any (the default)
    fn last_passive(&self) -> Option<Passive> {
        None
    }
    /// While the provider's state can't be read: when it reads it again (nothing is taken or asked for before, a manual collect
    /// included). Default: never waits
    fn state_retry_at(&self) -> Option<i64> {
        None
    }
    /// A mark that moves whenever a new passive record is taken in (the agent compares it around a take: a round that took one starts
    /// no CLI). Default: the time of the passive values in use
    fn passive_mark(&self) -> Option<i64> {
        self.last_passive().map(|p| p.at_ms)
    }
    /// Whether passive input waits to be taken (a statusLine record written since the last collect): the agent takes it, with no
    /// active fetch, before deciding on one. Default false
    fn passive_pending(&self) -> bool {
        false
    }
    /// Take the passive input (the statusLine record) and return the value with it, starting no CLI at all (no fetch, no version
    /// check). None for a provider without passive input (the default)
    fn take_passive(&mut self, _now: i64) -> Option<ProviderSnapshot> {
        None
    }
    /// The time (this PC's clock) after which the next collect must not start its query: the go it was allowed by is no longer used
    /// (the destination may have replaced it). None: no such limit. A provider that ignores it (the default) starts its query whenever
    /// its collect does
    fn fetch_deadline(&mut self, _until_ms: Option<i64>) {}
    /// The go of the next collect (None: none; the collect starts no query past it). Checked right before the launch and before each
    /// query is written. Default: passed on as fetch_deadline (its wall-clock part only)
    fn grant(&mut self, grant: Option<Grant>) {
        self.fetch_deadline(grant.map(|g| g.until_ms));
    }
    /// Whether the provider is stopped by its own safety guard (zero use couldn't be confirmed). Only the user's explicit --force
    /// goes past it. Default false (no such guard)
    fn safety_stopped(&self) -> bool {
        false
    }
    /// The user's explicit go past the safety stop, for the next collect only. A collect's `force` only brings the fetch
    /// forward; the provider checks this on its latest state right before a launch. Default: no-op
    fn confirm_safety(&mut self, _yes: bool) {}
    /// The switch waiting to be accepted (an account switch or a change of limits), as a mark of this provider's own (when it was
    /// seen): a request carries the one the user saw, and only that one is accepted. None: none waits (the default)
    fn pending_switch(&self) -> Option<i64> {
        None
    }
    /// The switch the next acceptance is for (the mark pending_switch gave when the user asked). Default: no-op
    fn accept_target(&mut self, _target: Option<i64>) {}
    /// What the last collect did upstream, set as it happened (Unknown right before the query, then its outcome). None: this
    /// provider doesn't say (the default; a fetch the common side allowed is then taken as one whose result is unknown)
    fn take_run(&mut self) -> Option<Run> {
        None
    }
    /// Time of the last query attempt. Used to notice fetches the provider made on its own, outside the scheduler
    /// (e.g. a fetch following the version check right after startup). Default None (only scheduled fetches count)
    fn last_fetch_attempt_ms(&self) -> Option<i64> {
        None
    }
    /// Accept an account switch and resume fetching (manual `--accept-account`). Default: no-op
    fn accept_account(&mut self) {}
    /// Whether this provider pauses on a change of its set of limits (and so takes `--same-account`). Default false
    fn tracks_limits(&self) -> bool {
        false
    }
    /// Take a change of the limits as the same account's and resume fetching, with no history boundary (manual `--same-account`,
    /// for a provider that tracks its limits). Reported through account_accepted. Default: no-op
    fn confirm_same_account(&mut self) {}
    /// After a collect with an acceptance: Some(true) if the switch was accepted and saved, Some(false) if not, None if this provider
    /// doesn't say
    fn account_accepted(&self) -> Option<bool> {
        None
    }
    /// Read again what this provider saved, right before a send: another process (a manual collect) may have accepted a switch or a
    /// change of limits meanwhile. Some(value) when the saved state differs from what the last collect used. Default: None
    fn sync_saved(&mut self, _now: i64) -> Option<ProviderSnapshot> {
        None
    }
    /// Whether this provider's queued observations stay queued (not sent) for now: they wait for the user's choice, or for a state
    /// that can be read. Default false
    fn holds_queue(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::says_access_denied;

    #[test]
    fn only_the_documented_denials_of_an_account_count() {
        for yes in [
            "Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted",
            "Your organization has disabled Claude subscription access for Claude Code",
            "OAuth authentication is currently not allowed for this organization.",
            r#"API Error: 403 {"error":{"type":"forbidden","message":"Request not allowed"}}"#,
            "Eligibility check failed: PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service.",
            "403 PERMISSION_DENIED",
        ] {
            assert!(says_access_denied(yes), "{yes}");
        }
        for no in [
            "permission denied: cannot open settings.json",
            "HTTP 403",
            "forbidden",
            "API Error: 403",
            "PERMISSION_DENIED",
            "Not logged in · Please run /login",
            "rate limited until 3pm",
            // a local error naming a file
            r#"cannot open local file "violation of terms of service.txt""#,
            r#"cannot open local file "account_on_hold.json""#,
            r#"cannot open local file "cache/claude.ai/restricted.json""#,
        ] {
            assert!(!says_access_denied(no), "{no}");
        }
    }
}
