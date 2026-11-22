// Type definitions for snapshot schema v2 (source of truth).
//
// Policy: shape the values used to track and notify about usage limits into a form common to every provider (Claude, Codex, Gemini).
// Every provider has the same keys; values that don't apply are null (keys are never omitted).

export const SCHEMA_VERSION = 2;

export type ProviderId = "claude" | "codex" | "gemini";

/** Every provider, in a fixed order: the one source of every provider list (views, events, the server's lists and SQL) */
export const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "gemini"];

/** Display names of the providers */
export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

/** Providers whose `blocked` follows from their overall windows (Codex's comes from its API and is kept as sent) */
export const WINDOW_LIMIT_PROVIDERS: readonly ProviderId[] = ["claude", "gemini"];

/** Of those, providers whose agent may report the limit without any window (an earlier Claude agent did): their flag stays then */
export const LIMIT_WITHOUT_WINDOWS: readonly ProviderId[] = ["claude"];

export type ProviderStatus = "ok" | "stale" | "error" | "unavailable";
/**
 * account_changed: the PC detected an account switch and stopped fetching/sending for that provider (a single account is assumed).
 * access_denied: the service denied access (403): fetching stopped on every PC until the user resumes it
 */
export type ErrorCode = "login_required" | "not_installed" | "fetch_failed" | "safety_stop" | "account_changed" | "access_denied";

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

/**
 * Names only one provider's windows may carry (slug -> display name), after the shared KNOWN_SCOPES (the same table as the agent's
 * PROVIDER_SCOPES). Another provider's window with such a name isn't stored (an unknown Codex group named "partner" stays out)
 */
export const PROVIDER_SCOPES: Readonly<Partial<Record<ProviderId, Readonly<Record<string, string>>>>> = {
  // A Gemini model with limits of its own, and the Claude and GPT models one uses through Antigravity
  gemini: { argon: "Argon", partner: "Claude and GPT" },
};

/** The names a provider's windows may carry: the shared ones, then its own (the agent's scopes_of, in the same order) */
export function scopesOf(provider: ProviderId): readonly (readonly [string, string])[] {
  return [...Object.entries(KNOWN_SCOPES), ...Object.entries(PROVIDER_SCOPES[provider] ?? {})];
}

/** Slugs of windows shown in details only: never chosen for the normal display, the top window, summaries or events */
const DETAIL_ONLY_SLUGS: Readonly<Partial<Record<ProviderId, readonly string[]>>> = { gemini: ["partner"] };

/**
 * Whether a provider's window is shown in details only: its id read as the Worker reads it when storing (the known name around the
 * length, also before a collision suffix)
 */
export function isDetailOnly(provider: ProviderId, windowId: string): boolean {
  const slug = parseWindowId(windowId, provider)?.slug;
  return slug != null && (DETAIL_ONLY_SLUGS[provider] ?? []).includes(slug);
}

export const KNOWN_WINDOWS: Readonly<Record<string, KnownWindow>> = {
  five_hour: { label: "5h", kind: "session", window_seconds: 5 * 60 * 60 },
  seven_day: { label: "Weekly", kind: "weekly", window_seconds: WEEK },
  monthly: { label: "Monthly", kind: "monthly", window_seconds: null },
  seven_day_opus: { label: "Weekly Opus", kind: "weekly", window_seconds: WEEK },
  seven_day_sonnet: { label: "Weekly Sonnet", kind: "weekly", window_seconds: WEEK },
};

const WINDOW_ID = /^[a-z0-9_]{1,64}$/;
/** Base forms of a window id that express its length (primary / secondary are Codex limits of unknown duration) */
const BASE_WINDOW = /^(five_hour|seven_day|monthly|window_(\d{1,6})m|primary|secondary)$/;
/** Suffix Codex appends when the same id would collide (a number only follows _primary / _secondary) */
const ID_SUFFIX = /(?:_(?:primary|secondary)(?:_\d{1,2})?)?$/;

/** A parsed window id. scope is the display name of the known name (null for the overall limit) */
export interface WindowIdParts {
  base: string;
  minutes: number | null;
  scope: string | null;
  /** The known name as it appears in the id (null for the overall limit) */
  slug: string | null;
}

/**
 * Parses a window id of `provider` (its names: the shared ones, then its own; without a provider, the shared ones only). null if it
 * is not a shape that may be stored
 */
export function parseWindowId(id: unknown, provider?: ProviderId): WindowIdParts | null {
  if (typeof id !== "string" || !WINDOW_ID.test(id)) return null;
  const scopes = new Map(provider === undefined ? Object.entries(KNOWN_SCOPES) : scopesOf(provider));
  if (Object.hasOwn(KNOWN_WINDOWS, id) && !BASE_WINDOW.test(id)) {
    const slug = [...scopes.keys()].find((k) => id.endsWith(`_${k}`));
    return { base: id, minutes: null, scope: slug === undefined ? null : scopes.get(slug)!, slug: slug ?? null };
  }
  const candidates = [id, id.replace(ID_SUFFIX, "")];
  for (const core of candidates) {
    const forms: [string, string | null][] = [[core, null]];
    for (const slug of scopes.keys()) {
      if (core.startsWith(`${slug}_`)) forms.push([core.slice(slug.length + 1), slug]);
      if (core.endsWith(`_${slug}`)) forms.push([core.slice(0, -slug.length - 1), slug]);
    }
    for (const [rest, slug] of forms) {
      const m = BASE_WINDOW.exec(rest);
      if (m) {
        return {
          base: m[1]!,
          minutes: m[2] === undefined ? null : Number(m[2]),
          scope: slug === null ? null : scopes.get(slug)!,
          slug,
        };
      }
    }
  }
  return null;
}
