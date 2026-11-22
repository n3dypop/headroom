// Repacks the received body into only the fields defined by the schema. Unknown fields are dropped,
// and strings that may contain account information or CLI output are not stored. An invalid body returns a reason (fixed text).
//
// Strings: strings sent by a PC are never stored as is.
// - error: the Worker picks a fixed text from error_code (the PC's text is not used)
// - label: built by the Worker from the window id
// - window id: only a base length form (five_hour, seven_day, monthly, window_<minutes>m, primary / secondary of unknown duration) or a known id,
//   with a known model/group name (core's KNOWN_SCOPES, then the provider's own PROVIDER_SCOPES) as prefix or suffix, plus a number
//   to avoid collisions.
//   Windows that don't match (including ids of another shape), and their observations, are not stored; the rest of the upload is
//   (short org names can't be told apart by shape, so only known values are allowed)
// - scope: derived from the known name in the id (the scope string sent by the PC is not used)
// - plan: only known plan names (core's KNOWN_PLANS); anything else is null
import {
  KNOWN_PLANS,
  PROVIDERS,
  WINDOW_LIMIT_PROVIDERS,
  LIMIT_WITHOUT_WINDOWS,
  CLOCK_TOLERANCE_MS,
  KNOWN_WINDOWS,
  parseWindowId,
  type WindowIdParts,
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

const STATUSES: readonly ProviderStatus[] = ["ok", "stale", "error", "unavailable"];
const KINDS: readonly WindowKind[] = ["session", "weekly", "monthly", "other"];
const ERROR_CODES: readonly ErrorCode[] = [
  "login_required",
  "not_installed",
  "fetch_failed",
  "safety_stop",
  "account_changed",
  "access_denied",
];
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
  access_denied: "Access denied by the service: fetching stopped on every PC (see headroom status on the PC)",
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

export { parseWindowId, type WindowIdParts } from "../../core/src/index.ts";

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

/** Repacks a window of `provider`. null if the id is not a shape that may be stored (the window is not stored) */
function cleanWindow(v: unknown, provider: ProviderId): UsageWindow | null {
  if (!isRecord(v)) fail("invalid window shape");
  if (typeof v.id !== "string") fail("invalid window id");
  const parts = parseWindowId(v.id, provider);
  if (parts === null) return null;
  const sentScope = v.scope !== null && v.scope !== undefined;
  // A per-model/per-group limit without a known name is not stored (so it is never mistaken for the overall limit)
  if (sentScope && parts.scope === null) return null;
  // An unknown group whose name only starts with a known one (e.g. id `codex_other_five_hour_primary` sent with scope
  // `codex_other_five_hour` by an older agent) is not taken for the known group
  if (typeof v.scope === "string" && parts.slug !== null && slugOf(v.scope).startsWith(`${parts.slug}_`)) return null;
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

/** A name in the form ids use: lower case, anything but a-z and 0-9 as `_` */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

/**
 * Claude's and Gemini's limit flag means an overall window at 100% (that is how their agents set it). Gemini's is kept only while
 * such a window remains (one without windows, from the start or after they were dropped, says nothing about the limit). An older Claude agent also counted windows
 * that are not stored (extra usage) or per-model windows it sent without a model, and a history boundary can drop the window that
 * set it. When windows remain but none of the overall ones is at 100%, the limit is unknown rather than reached (a value with
 * no windows at all keeps its flag). Other providers can know the limit apart from the windows, so their flag is kept
 */
function limitFlag(
  provider: ProviderId,
  windows: readonly UsageWindow[],
  blocked: boolean | null,
  dropped = false,
): boolean | null {
  if (!WINDOW_LIMIT_PROVIDERS.includes(provider)) return blocked;
  // A value whose windows were all dropped says nothing about the limit (true or false). One that came without windows (every limit
  // turned off) is not at a limit (false stands, so it stays a value of its own over another PC's older one); at the limit (true) only
  // for a provider whose agent may report the limit that way
  if (windows.length === 0) return dropped ? null : blocked === true && !LIMIT_WITHOUT_WINDOWS.includes(provider) ? null : blocked;
  if (blocked !== true) return blocked;
  return windows.some((w) => w.scope === null && w.used_percent >= 100) ? true : null;
}

/** Claude's and Gemini's provider fetch time is its oldest window's. After windows are dropped it is taken from the remaining ones */
function providerFetchedAt(provider: ProviderId, fetchedAt: string | null, windows: readonly UsageWindow[], dropped: boolean) {
  if (!WINDOW_LIMIT_PROVIDERS.includes(provider) || !dropped) return fetchedAt;
  const times = windows.map((w) => w.fetched_at).filter((t): t is string => t !== null).sort();
  return times[0] ?? fetchedAt;
}

/** Applies the limit-flag rule to a latest value after boundaries were applied */
export function settleLimits(snapshot: Snapshot): Snapshot {
  let providers = snapshot.providers;
  for (const id of WINDOW_LIMIT_PROVIDERS) {
    const p = providers[id];
    if (!p || p.blocked !== true) continue;
    const blocked = limitFlag(id, p.windows, p.blocked);
    if (blocked !== p.blocked) providers = { ...providers, [id]: { ...p, blocked } };
  }
  return providers === snapshot.providers ? snapshot : { ...snapshot, providers };
}

/**
 * A latest value saved by an earlier Worker, held to today's rules: windows that would no longer be stored are dropped, and
 * Claude's limit flag and fetch time follow the remaining windows
 */
export function withoutUnstored(snapshot: Snapshot): Snapshot {
  const providers: Snapshot["providers"] = {};
  for (const [id, p] of Object.entries(snapshot.providers) as [ProviderId, ProviderSnapshot][]) {
    const kept = p.windows.filter((w) => {
      const parts = parseWindowId(w.id, id);
      return parts !== null && !(w.scope !== null && parts.scope === null);
    });
    const dropped = kept.length !== p.windows.length;
    const blocked = limitFlag(id, kept, p.blocked, dropped);
    providers[id] = !dropped && blocked === p.blocked
      ? p
      : { ...p, windows: kept, blocked, fetched_at: providerFetchedAt(id, p.fetched_at, kept, dropped) };
  }
  return { ...snapshot, providers };
}

function cleanProvider(id: ProviderId, v: unknown, collector: string): ProviderSnapshot {
  if (!isRecord(v)) fail("invalid provider shape");
  const windows = v.windows;
  if (!Array.isArray(windows) || windows.length > MAX_WINDOWS) fail("invalid windows");
  const cleaned = windows.map((w) => cleanWindow(w, id)).filter((w): w is UsageWindow => w !== null);
  const dropped = cleaned.length !== windows.length;
  const blocked = limitFlag(id, cleaned, typeof v.blocked === "boolean" ? v.blocked : null, dropped);
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
    fetched_at: providerFetchedAt(id, isoOrNull(v.fetched_at), cleaned, dropped),
    // Which PC fetched the value is decided by the URL name verified with the credential (the body's value is not used)
    collector,
    error,
    error_code: errorCode,
    plan: typeof v.plan === "string" && KNOWN_PLANS.includes(v.plan.toLowerCase()) ? v.plan.toLowerCase() : null,
    blocked,
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
    if (p !== undefined && p !== null) providers[id] = cleanProvider(id, p, collector);
  }
  return { schema_version: 2, generated_at: generatedAt, providers, collector };
}

/**
 * A PC's saved latest value held to today's clock rules (a row an earlier Worker kept may break them): a row sent with a clock off by more
 * than the tolerance from its receipt keeps no values (today it would have been refused), and values stamped after the row's send time
 * are dropped. Rows saved by today's Worker pass unchanged
 */
export function heldToClock(snapshot: Snapshot, receivedAt: string): Snapshot {
  const skewed = !withinClock(snapshot, receivedAt);
  const providers: Snapshot["providers"] = {};
  for (const [id, p] of Object.entries(snapshot.providers) as [ProviderId, ProviderSnapshot][]) {
    providers[id] = skewed ? { ...p, windows: [], fetched_at: null, blocked: null } : notAfterSend(id, p, snapshot.generated_at);
  }
  return { ...snapshot, providers };
}

/** Whether a saved row was sent with a clock today's Worker accepts (within the tolerance of its receipt) */
export function withinClock(snapshot: Snapshot, receivedAt: string): boolean {
  const sent = Date.parse(snapshot.generated_at);
  const received = Date.parse(receivedAt);
  return Number.isFinite(sent) && Number.isFinite(received) && Math.abs(sent - received) <= CLOCK_TOLERANCE_MS;
}

/**
 * Values stamped after the PC's own send time (`generated_at`) are dropped: the PC's clock was turned back after the fetch, so their
 * times are in a clock that no longer holds (when they really were is unknown)
 */
function notAfterSend(id: ProviderId, p: ProviderSnapshot, generatedAt: string): ProviderSnapshot {
  const windows = p.windows.filter((w) => w.fetched_at === null || w.fetched_at <= generatedAt);
  if (windows.length === p.windows.length && (p.fetched_at === null || p.fetched_at <= generatedAt)) return p;
  const fetchDropped = p.fetched_at !== null && p.fetched_at > generatedAt;
  const windowsDropped = windows.length !== p.windows.length;
  return {
    ...p,
    fetched_at: fetchDropped ? null : p.fetched_at,
    windows,
    // A limit flag that came from the dropped fetch says nothing (true or false)
    blocked: fetchDropped || (windowsDropped && windows.length === 0) ? null : limitFlag(id, windows, p.blocked, windowsDropped),
  };
}

function cleanObservation(v: unknown, collector: string): UsageObservation | null {
  if (!isRecord(v)) fail("invalid observation shape");
  if (typeof v.window_id !== "string") fail("invalid observation window_id");
  // The provider first: a window's names depend on it
  const provider = oneOf(v.provider, PROVIDERS, "observation provider");
  if (parseWindowId(v.window_id, provider) === null) return null;
  const windowId = v.window_id;
  return {
    provider,
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
    // Observations of windows this upload's own values show to be something not stored (e.g. an unknown group) are not stored either
    const refused = new Set<string>();
    if (isRecord(body.snapshot) && isRecord(body.snapshot.providers)) {
      for (const id of PROVIDERS) {
        const p = body.snapshot.providers[id];
        const kept = new Set(snapshot.providers[id]?.windows.map((w) => w.id) ?? []);
        if (!isRecord(p) || !Array.isArray(p.windows)) continue;
        for (const w of p.windows) if (isRecord(w) && typeof w.id === "string" && !kept.has(w.id)) refused.add(`${id}.${w.id}`);
      }
    }
    const observations = raw
      .filter((o) => !(isRecord(o) && refused.has(`${String(o.provider)}.${String(o.window_id)}`)))
      .map((o) => cleanObservation(o, collector))
      .filter((o): o is UsageObservation => o !== null && !stopped.has(o.provider) && o.observed_at <= snapshot.generated_at);
    // Windows stamped after the send time are dropped after the check above (their observations stamped before it are kept)
    const providers: Snapshot["providers"] = {};
    for (const [id, p] of Object.entries(snapshot.providers) as [ProviderId, ProviderSnapshot][]) {
      providers[id] = notAfterSend(id, p, snapshot.generated_at);
    }
    return { seq, snapshot: { ...snapshot, providers }, observations };
  } catch (e) {
    if (e instanceof Invalid) return { error: e.message };
    throw e;
  }
}
