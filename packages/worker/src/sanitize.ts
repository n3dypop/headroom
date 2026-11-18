// Repacks the received body into only the fields defined by the schema. Unknown fields are dropped,
// and strings that may contain account information or CLI output are not stored. An invalid body returns a reason (fixed text).
//
// Strings: strings sent by a PC are never stored as is.
// - error: the Worker picks a fixed text from error_code (the PC's text is not used)
// - label: built by the Worker from the window id
// - window id: only a base length form (five_hour, seven_day, monthly, window_<minutes>m, primary / secondary of unknown duration) or a known id,
//   with a known model/group name (core's KNOWN_SCOPES) as prefix or suffix, plus a number to avoid collisions.
//   Windows that don't match, and their observations, are not stored (short org names can't be told apart by shape, so only known values are allowed)
// - scope: derived from the known name in the id (the scope string sent by the PC is not used)
// - plan: only known plan names (core's KNOWN_PLANS); anything else is null
import {
  KNOWN_PLANS,
  KNOWN_SCOPES,
  KNOWN_WINDOWS,
  shouldReplaceCollectorSnapshot,
  type ErrorCode,
  type ProviderId,
  type ProviderSnapshot,
  type ProviderStatus,
  type Snapshot,
  type UsageObservation,
  type UsageWindow,
  type WindowKind,
} from "../../core/src/index.ts";

export interface CleanUpload {
  seq: number;
  snapshot: Snapshot;
  observations: UsageObservation[];
}

const PROVIDERS: readonly ProviderId[] = ["claude", "codex"];
const STATUSES: readonly ProviderStatus[] = ["ok", "stale", "error", "unavailable"];
const KINDS: readonly WindowKind[] = ["session", "weekly", "monthly", "other"];
const ERROR_CODES: readonly ErrorCode[] = [
  "login_required",
  "not_installed",
  "fetch_failed",
  "safety_stop",
  "account_changed",
];
const WINDOW_ID = /^[a-z0-9_]{1,64}$/;
/** Base forms of a window id that express its length (primary / secondary are Codex limits of unknown duration) */
const BASE_WINDOW = /^(five_hour|seven_day|monthly|window_(\d{1,6})m|primary|secondary)$/;
/** Suffix Codex appends when the same id would collide */
const ID_SUFFIX = /(?:_(?:primary|secondary))?(?:_\d{1,2})?$/;
export const MAX_WINDOWS = 32;
/** Max observations per upload. Keeps the rows written per request small. The PC sends them in batches of 200 */
export const MAX_OBSERVATIONS = 200;
/** Fixed text for diagnostics without an error_code (e.g. a stale-value warning) */
export const WITHHELD_ERROR = "See headroom status on the PC for details";
/** Fixed text per error_code. The error text sent by the PC is not stored */
export const ERROR_TEXT: Readonly<Record<ErrorCode, string>> = {
  login_required: "Sign-in required (see headroom status on the PC)",
  not_installed: "CLI not found (see headroom status on the PC)",
  fetch_failed: "Fetch failed (see headroom status on the PC)",
  safety_stop: "Fetching paused for safety (see headroom status on the PC)",
  account_changed: "Fetching paused after an account switch (see headroom status on the PC)",
};

class Invalid extends Error {}

function fail(message: string): never {
  throw new Invalid(message);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Normalizes an ISO 8601 time to UTC. null if unreadable or the year is implausible */
export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year >= 2000 && year <= 2100 ? new Date(t).toISOString() : null;
}

/** A parsed window id. scope is the display name of the known name (null for the overall limit) */
export interface WindowIdParts {
  base: string;
  minutes: number | null;
  scope: string | null;
}

/** Parses a window id. null if it is not a shape that may be stored */
export function parseWindowId(id: unknown): WindowIdParts | null {
  if (typeof id !== "string" || !WINDOW_ID.test(id)) return null;
  if (Object.hasOwn(KNOWN_WINDOWS, id) && !BASE_WINDOW.test(id)) {
    const slug = Object.keys(KNOWN_SCOPES).find((k) => id.endsWith(`_${k}`));
    return { base: id, minutes: null, scope: slug === undefined ? null : KNOWN_SCOPES[slug]! };
  }
  const candidates = [id, id.replace(ID_SUFFIX, "")];
  for (const core of candidates) {
    const forms: [string, string | null][] = [[core, null]];
    for (const slug of Object.keys(KNOWN_SCOPES)) {
      if (core.startsWith(`${slug}_`)) forms.push([core.slice(slug.length + 1), slug]);
      if (core.endsWith(`_${slug}`)) forms.push([core.slice(0, -slug.length - 1), slug]);
    }
    for (const [rest, slug] of forms) {
      const m = BASE_WINDOW.exec(rest);
      if (m) {
        return {
          base: m[1]!,
          minutes: m[2] === undefined ? null : Number(m[2]),
          scope: slug === null ? null : KNOWN_SCOPES[slug]!,
        };
      }
    }
  }
  return null;
}

/** Builds the display label from the id (the label sent by the PC is not used) */
export function windowLabel(id: string, parts: WindowIdParts): string {
  const known = KNOWN_WINDOWS[id];
  if (known) return known.label;
  const heads: Record<string, string> = {
    five_hour: "5h", seven_day: "Weekly", monthly: "Monthly", primary: "Primary", secondary: "Secondary",
  };
  const m = parts.minutes;
  const head = heads[parts.base] ?? (m !== null ? (m % 60 === 0 ? `${m / 60}h` : `${m}m`) : "Limit");
  return parts.scope === null ? head : `${head} ${parts.scope}`;
}

function percent(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) fail("used_percent is not a number");
  return Math.min(100, Math.max(0, v));
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v === "string" && (list as readonly string[]).includes(v)) return v as T;
  fail(`${what} is invalid`);
}

/** Repacks a window. null if the id is not a shape that may be stored (the window is not stored) */
function cleanWindow(v: unknown): UsageWindow | null {
  if (!isRecord(v)) fail("invalid window shape");
  if (typeof v.id !== "string" || !WINDOW_ID.test(v.id)) fail("invalid window id");
  const parts = parseWindowId(v.id);
  if (parts === null) return null;
  const sentScope = v.scope !== null && v.scope !== undefined;
  // A per-model/per-group limit without a known name is not stored (so it is never mistaken for the overall limit)
  if (sentScope && parts.scope === null) return null;
  const kind = oneOf(v.kind, KINDS, "window kind");
  return {
    id: v.id,
    label: windowLabel(v.id, parts),
    kind,
    scope: parts.scope,
    used_percent: percent(v.used_percent),
    resets_at: isoOrNull(v.resets_at),
    fetched_at: isoOrNull(v.fetched_at),
  };
}

function cleanProvider(v: unknown, collector: string): ProviderSnapshot {
  if (!isRecord(v)) fail("invalid provider shape");
  const windows = v.windows;
  if (!Array.isArray(windows) || windows.length > MAX_WINDOWS) fail("invalid windows");
  const cleaned = windows.map(cleanWindow).filter((w): w is UsageWindow => w !== null);
  if (new Set(cleaned.map((w) => w.id)).size !== cleaned.length) fail("duplicate window id");
  const errorCode = v.error_code === null || v.error_code === undefined
    ? null
    : oneOf(v.error_code, ERROR_CODES, "error_code");
  const error = errorCode !== null
    ? ERROR_TEXT[errorCode]
    : v.error === null || v.error === undefined
    ? null
    : WITHHELD_ERROR;
  return {
    status: oneOf(v.status, STATUSES, "status"),
    fetched_at: isoOrNull(v.fetched_at),
    // Which PC fetched the value is decided by the URL name verified with the credential (the body's value is not used)
    collector,
    error,
    error_code: errorCode,
    plan: typeof v.plan === "string" && KNOWN_PLANS.includes(v.plan.toLowerCase()) ? v.plan.toLowerCase() : null,
    blocked: typeof v.blocked === "boolean" ? v.blocked : null,
    history_since: isoOrNull(v.history_since),
    windows: cleaned,
  };
}

function cleanSnapshot(v: unknown, collector: string): Snapshot {
  if (!isRecord(v)) fail("invalid snapshot shape");
  if (v.schema_version !== 2) fail("schema_version is not 2");
  const generatedAt = isoOrNull(v.generated_at) ?? fail("invalid generated_at");
  if (!isRecord(v.providers)) fail("invalid providers shape");
  const providers: Snapshot["providers"] = {};
  for (const id of PROVIDERS) {
    const p = v.providers[id];
    if (p !== undefined && p !== null) providers[id] = cleanProvider(p, collector);
  }
  return { schema_version: 2, generated_at: generatedAt, providers, collector };
}

function cleanObservation(v: unknown, collector: string): UsageObservation | null {
  if (!isRecord(v)) fail("invalid observation shape");
  if (typeof v.window_id !== "string" || !WINDOW_ID.test(v.window_id)) fail("invalid observation window_id");
  if (parseWindowId(v.window_id) === null) return null;
  const windowId = v.window_id;
  return {
    provider: oneOf(v.provider, PROVIDERS, "observation provider"),
    window_id: windowId,
    collector,
    resets_at: isoOrNull(v.resets_at),
    used_percent: percent(v.used_percent),
    observed_at: isoOrNull(v.observed_at) ?? fail("invalid observation observed_at"),
  };
}

/** Repacks the PUT body `{ seq, snapshot, observations }`. Returns a fixed reason if invalid */
export function sanitizeUpload(body: unknown, collector: string): CleanUpload | { error: string } {
  try {
    if (!isRecord(body)) fail("invalid body shape");
    const seq = body.seq;
    if (typeof seq !== "number" || !shouldReplaceCollectorSnapshot(null, seq)) fail("seq is not a positive integer");
    const snapshot = cleanSnapshot(body.snapshot, collector);
    const raw = body.observations ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_OBSERVATIONS) fail("invalid observations");
    // Observations of a provider stopped by an account switch are not stored (don't mix another account's values into history)
    const stopped = new Set(
      PROVIDERS.filter((id) => snapshot.providers[id]?.error_code === "account_changed"),
    );
    const observations = raw
      .map((o) => cleanObservation(o, collector))
      .filter((o): o is UsageObservation => o !== null && !stopped.has(o.provider));
    return { seq, snapshot, observations };
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message };
    throw e;
  }
}
