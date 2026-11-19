// Type definitions for snapshot schema v2 (source of truth).
//
// Policy: shape the values used to track and notify about usage limits into a form common to Claude and Codex.
// Every provider has the same keys; values that don't apply are null (keys are never omitted).

export const SCHEMA_VERSION = 2;

export type ProviderId = "claude" | "codex";

export type ProviderStatus = "ok" | "stale" | "error" | "unavailable";
/** account_changed: the PC detected an account switch and stopped fetching/sending for that provider (a single account is assumed) */
export type ErrorCode = "login_required" | "not_installed" | "fetch_failed" | "safety_stop" | "account_changed";

/** Window kind. Lets displays pick "only the 5-hour window" or "only the weekly window" */
export type WindowKind = "session" | "weekly" | "monthly" | "other";

export interface UsageWindow {
  /** Unique within the provider. Contains no `.` (e.g. five_hour, seven_day_fable, codex_other_seven_day) */
  id: string;
  /** Short display name (e.g. 5h, Weekly, Weekly Fable) */
  label: string;
  kind: WindowKind;
  /** Target of a per-model / per-group window. null for the overall window */
  scope: string | null;
  /** 0-100 */
  used_percent: number;
  /** ISO8601 UTC */
  resets_at: string | null;
  /** When this window's value was actually fetched (ISO8601 UTC). The provider's fetched_at is the oldest window's time */
  fetched_at: string | null;
}

export interface ProviderSnapshot {
  status: ProviderStatus;
  /** With several windows, the fetch time of the oldest window (ISO8601 UTC) */
  fetched_at: string | null;
  /** Name of the collector that fetched this value */
  collector: string | null;
  error: string | null;
  error_code: ErrorCode | null;
  plan: string | null;
  /** Whether hitting the limit / being blocked was confirmed at observation time. null if unknown */
  blocked: boolean | null;
  /**
   * History boundary (ISO8601 UTC): when an account switch was accepted. Observations before it belong to another
   * account and the server drops them from history. null if no switch was accepted
   */
  history_since: string | null;
  windows: UsageWindow[];
}

export interface CollectorInfo {
  id: string;
  generated_at: string;
  /** When the server last received from this PC (server clock; the PC's liveness signal). null if unknown at merge time */
  received_at: string | null;
}

export interface Snapshot {
  schema_version: typeof SCHEMA_VERSION;
  /** When the collector made this snapshot. After merging, the newest of the inputs */
  generated_at: string;
  providers: Partial<Record<ProviderId, ProviderSnapshot>>;
  /** Collector that made this snapshot (omitted after merging) */
  collector?: string;
  /** Merged only: collectors that sent values */
  collectors?: CollectorInfo[];
}

/** An observed window value in history. collector is set on receipt from the request path. */
export interface UsageObservation {
  provider: ProviderId;
  window_id: string;
  collector: string;
  resets_at: string | null;
  used_percent: number;
  observed_at: string;
}

export interface KnownWindow {
  label: string;
  kind: WindowKind;
  window_seconds: number | null;
}

const WEEK = 7 * 24 * 60 * 60;

/**
 * Plan names the server stores. Anything else becomes null (short organization names can't be told apart by shape,
 * so only known values are kept). Add here when a provider starts returning a new plan name
 */
export const KNOWN_PLANS: readonly string[] = [
  "free", "go", "plus", "pro", "prolite", "max", "ultra", "team", "business", "enterprise", "edu",
];

/**
 * Names of per-model / per-group windows (slug around the window id -> display name). The server derives scope from here
 * and does not store the scope string sent by the PC. Windows with a name not listed here are not stored (overall windows
 * are unaffected). Claude uses model names (`seven_day_<model>`), Codex uses limit groups (`<group>_<length>`). Add new names here
 */
export const KNOWN_SCOPES: Readonly<Record<string, string>> = {
  fable: "Fable",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  codex_other: "codex_other",
  // An additional Codex limit group (limitId). Its model isn't fixed by the public types, so it is shown as "Codex extra"
  codex_bengalfox: "Codex extra",
};

export const KNOWN_WINDOWS: Readonly<Record<string, KnownWindow>> = {
  five_hour: { label: "5h", kind: "session", window_seconds: 5 * 60 * 60 },
  seven_day: { label: "Weekly", kind: "weekly", window_seconds: WEEK },
  monthly: { label: "Monthly", kind: "monthly", window_seconds: null },
  seven_day_opus: { label: "Weekly Opus", kind: "weekly", window_seconds: WEEK },
  seven_day_sonnet: { label: "Weekly Sonnet", kind: "weekly", window_seconds: WEEK },
};
