// Headroom's delivery endpoint (Cloudflare Worker + D1).
//
//   PUT  /v2/snapshots/:collector  Write (only that PC's credential). Body is { seq, snapshot, observations }.
//                                  After saving, puts the merged latest value (with boundaries applied) into public_state
//   POST /v2/turns/:collector      Fetch turn (same credential as above). Body is { "claude": minutes, ... }; response is { "claude": { go, wait_s } }
//   GET  /v2/snapshot              Merged snapshot (read credential). Reads only the one public_state row
//   GET  /v2/view?tz=Asia/Tokyo    Display view (same). Reads only public_state and the derived-value rows, never history
//   GET  /v2/events?after=<seq>    Events (same). Only seq greater than after. Reads only the one event_feed row
//   GET  /v2/history?provider=claude&window=seven_day&hours=170  7-day series of the weekly limit (same). Reads only one derived_weekly row
//                                  and one boundary row (the 24-hour series derived_history was removed)
//   Cron (every 5 min)             Computes and saves derived values for changed providers, builds the weekly 7-day series once
//                                  an hour, judges and records events, and gradually deletes rows past retention
//
// D1 always stays within the free tier (budget.ts): GET reads at most 3 rows; everything else runs only within the daily budget.
// No credentials or bodies in logs. No CORS. Responses are not cacheable.
import {
  CLOCK_TOLERANCE_MS,
  EVENT_RETENTION_MS,
  computeMetrics,
  hourlySeries,
  judgeEvents,
  mergeSnapshots,
  toView,
  type ProviderId,
} from "../../core/src/index.ts";
import { COLLECTOR_NAME, authenticate, parseTokens } from "./auth.ts";
import {
  BudgetDeadline,
  RESERVE,
  budgetLimit,
  daysToReserve,
  endOfDays,
  metered,
  reserve,
  secondsUntilReset,
  settle,
  type Usage,
} from "./budget.ts";
import { sanitizeUpload, settleLimits, withoutUnstored, type CleanUpload } from "./sanitize.ts";
import {
  ALL_VERSION,
  loadDerived,
  hasSnapshots,
  loadBoundaryStamps,
  loadDerivedVersions,
  type BoundaryStamps,
  loadEventFeed,
  loadEventState,
  loadHourly,
  loadWeekly,
  saveWeekly,
  loadObservations,
  loadPublicBoundaries,
  loadPublicRow,
  loadPublicState,
  publicSnapshot,
  loadSnapshots,
  mayWrite,
  prune,
  pruneEvents,
  readDataVersion,
  rebuildEventFeed,
  recordEvents,
  saveDerived,
  savePublicState,
  stampOf,
  saveUpload,
  takeTurns,
  type D1Like,
} from "./store.ts";

export interface Env {
  DB: D1Like;
  /** Secret. Credential hashes and roles (auth.ts) */
  TOKENS?: string;
  /** Preferred PC names, comma-separated (e.g. "win-desktop,mac"). Used to pick between near-simultaneous observations and the current value */
  COLLECTOR_PRIORITY?: string;
  /**
   * Entry host name (e.g. "headroom.<account-subdomain>.workers.dev"). Requests to any other host (preview URLs etc.)
   * are rejected even with a valid Worker token. If unset, everything is rejected
   */
  ALLOWED_HOST?: string;
  /**
   * This D1's share of the daily budget in percent (1-100, unset for 100). Set it when one Cloudflare account has more than one
   * Headroom D1, so the shares add up to 100 or less (the free tier is per account). Use 13 or more (below that the Cron run never fits). Any other value refuses metered runs
   */
  D1_BUDGET_PERCENT?: string | number;
}

const MAX_BODY_BYTES = 1_000_000;
/**
 * Length of history read for derived values: the weekly limit's last-day usage and 24-hour rate (observations ±15 min around 24h ago) plus margin.
 * Export nothing but functions from this entry module (Workers reads named exports of the entry as functions or handler definitions and won't start otherwise)
 */
const HISTORY_MS = (24 * 60 + 30) * 60_000;
const PROVIDERS: readonly ProviderId[] = ["claude", "codex"];
/** Derived-value format version. 2: added rate_pace */
const METRICS_FORMAT = 2;

function json(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const problem = (status: number, error: string) => json(status, { error });

function priority(env: Env): string[] {
  return (env.COLLECTOR_PRIORITY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload handling (within budget): saves, then re-puts the merged latest value with boundaries applied into public_state.
 * Change counters advance in the same batch as the save: the global one on every upload, a provider's only when it has observations or
 * that PC's latest value for that provider is replaced (Cron recomputes derived values only for that provider, so a Claude-only statusLine
 * change doesn't read Codex history). The latest value is re-put only if no save happened after reading (publish)
 */
async function receive(db: D1Like, env: Env, upload: CleanUpload, received: Date) {
  // Save and change counters are one batch. Then re-put the latest value
  const saved = await saveUpload(db, upload, received, priority(env));
  if (saved.limited) return saved; // Nothing was written, so don't re-put
  await publish(db, env);
  return saved;
}

/**
 * Merges the saved per-PC latest values and puts them into public_state with the current boundaries. Reads the global counter and boundaries
 * before the latest values, and puts only if no save happened before writing (if one did, that upload or the next Cron puts it)
 */
async function publish(db: D1Like, env: Env): Promise<void> {
  const version = await readDataVersion(db, ALL_VERSION);
  const stamps = await loadBoundaryStamps(db);
  const loaded = await loadSnapshots(db);
  const merged = mergeSnapshots(loaded.snapshots, { collectorPriority: priority(env) });
  if (!merged) {
    // No PC's latest value is left (all past retention): the old merged value is not shown either (unless an upload put a new one)
    if (loaded.snapshots.length === 0) {
      await db
        .prepare("DELETE FROM public_state WHERE id = 1 AND version <= ? AND NOT EXISTS (SELECT 1 FROM collector_snapshots)")
        .bind(version)
        .run();
    }
    return;
  }
  // Attach each PC's last received time (liveness marker, used by clients and to detect stopped collection)
  for (const c of merged.collectors ?? []) c.received_at = loaded.received.get(c.id) ?? null;
  await savePublicState(db, merged, version, stamps);
}

/**
 * Cron: only for changed providers (data_versions newer than the saved derived-value counter), computes derived values from the merged
 * latest value and recent history. History for that provider is read newest first, up to a limit, back to HISTORY_MS before the oldest window's fetch time.
 * The counter is read before computing, and a save loses to a computation with a newer counter
 */
export async function refreshDerived(db: D1Like, env: Env, at: Date): Promise<void> {
  const stored = await loadDerivedVersions(db);
  // Read boundaries before observations. If a boundary moves mid-computation, the stamp is saved stale and the next Cron recomputes
  const boundaries = await loadBoundaryStamps(db);
  for (const id of PROVIDERS) {
    const version = await readDataVersion(db, id);
    const saved = stored.get(id);
    const row = await loadPublicRow(db);
    const merged = row?.snapshot;
    const p = merged?.providers[id];
    if (!row || !merged || !p) continue;
    // If the latest-value row hasn't been re-put with the current boundaries (before the re-put by the upload that saved a switch), skip this provider.
    // Don't stamp values computed from the previous account's latest value with the new boundary (the Cron after the re-put computes it)
    if (stampOf(row.boundaries, id) !== stampOf(boundaries, id)) continue;
    // Include the derived-value format version in the basis (bump it when adding fields so old-format rows get recomputed)
    const basis = `${METRICS_FORMAT}:${JSON.stringify(p)}`;
    // Recompute if the counter advanced, it was computed under a different boundary, never computed, or the latest value differs from when computed
    const stale = saved === undefined || saved.boundary !== stampOf(boundaries, id) || saved.basis !== basis;
    if (version <= (saved?.version ?? 0) && !stale) continue;
    const times = p.windows.map((w) => Date.parse(w.fetched_at ?? "")).filter(Number.isFinite);
    const oldest = Math.min(at.getTime(), ...times);
    const observations = await loadObservations(db, id, new Date(oldest - HISTORY_MS));
    const metrics = computeMetrics(merged, observations, { collectorPriority: priority(env) }, [id])[id] ?? {};
    await saveDerived(db, id, metrics, version, at, stampOf(boundaries, id), basis, row.version);
  }
}

/** Runs within the D1 budget. Reserves the per-run maximum before starting and settles with actual usage afterwards */
async function withinBudget<T>(
  env: Env,
  at: Date,
  amount: Usage,
  work: (db: D1Like) => Promise<T>,
  clock: () => Date = () => new Date(),
): Promise<{ ok: true; value: T } | { ok: false; reason: "exhausted" | "unavailable" }> {
  // A run starting just before 00:00 UTC also reserves the next day
  const days = daysToReserve(at);
  // Refusals aren't metered (only the few rows the reserve statement reads; even at Workers' 100k requests/day that's a few hundred thousand rows, within the margin outside the write-side budget)
  const reservation = await reserve(env.DB, days, amount, budgetLimit(env.D1_BUDGET_PERCENT));
  if (reservation !== "reserved") return { ok: false, reason: reservation };
  // Once past the reserved day, abort without starting D1 statements
  const m = metered(env.DB, { clock, until: endOfDays(days) });
  try {
    return { ok: true, value: await work(m.db) };
  } catch (e) {
    if (e instanceof BudgetDeadline) return { ok: false, reason: "unavailable" };
    throw e;
  } finally {
    await settle(env.DB, days, amount, m.usage, clock());
  }
}

/** Budget exhaustion returns seconds until 00:00 UTC. Transient D1 failures/aborts get a different response, and the PC resends after its normal wait */
const refused = (reason: "exhausted" | "unavailable", at: Date) =>
  reason === "exhausted"
    ? json(503, { error: "d1_budget", retry_after_s: secondsUntilReset(at) })
    : json(503, { error: "unavailable" });

/** Turn body { "claude": minutes, "codex": minutes }. Minutes are 0-1440 (0 releases; the upper bound is clamped in store) */
function parseTurns(body: unknown): Map<ProviderId, number> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const out = new Map<ProviderId, number>();
  for (const [key, value] of Object.entries(body)) {
    if (!PROVIDERS.includes(key as ProviderId)) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1440) return null;
    out.set(key as ProviderId, value);
  }
  return out.size === 0 ? null : out;
}

/**
 * Reads the JSON body, at most MAX_BODY_BYTES. The size is counted while reading, so a larger body (with or without
 * Content-Length) is cut off right after the limit instead of being read whole. RangeError if too large
 */
export async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new RangeError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RangeError();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function handle(request: Request, env: Env, now: () => Date = () => new Date()): Promise<Response> {
  const url = new URL(request.url);
  // Close hosts other than the entry host (preview URLs etc.) in the Worker
  const allowedHost = env.ALLOWED_HOST?.trim().toLowerCase() ?? "";
  if (allowedHost === "") return problem(503, "host_not_configured");
  if (url.hostname !== allowedHost) return problem(404, "not_found");
  const put = /^\/v2\/snapshots\/([^/]+)$/.exec(url.pathname);
  const turn = /^\/v2\/turns\/([^/]+)$/.exec(url.pathname);
  const isRead = ["/v2/snapshot", "/v2/view", "/v2/events", "/v2/history"].includes(url.pathname);
  if (!put && !turn && !isRead) return problem(404, "not_found");
  if ((put && request.method !== "PUT") || (turn && request.method !== "POST") || (isRead && request.method !== "GET")) {
    return problem(405, "method_not_allowed");
  }

  const token = await authenticate(request, parseTokens(env.TOKENS));
  if (!token) return problem(401, "unauthorized");

  const writer = put ?? turn;
  let collector = "";
  if (writer) {
    try {
      collector = decodeURIComponent(writer[1] ?? "");
    } catch {
      return problem(404, "not_found"); // Invalid percent-encoding
    }
    if (!COLLECTOR_NAME.test(collector)) return problem(404, "not_found");
    if (token.role !== "write" || token.collector !== collector) return problem(403, "forbidden");
  }

  if (turn) {
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (e) {
      return e instanceof RangeError ? problem(413, "too_large") : problem(400, "invalid_json");
    }
    const requests = parseTurns(body);
    if (!requests) return problem(400, "invalid_turns");
    const at = now();
    // No turn for a PC that can't deliver because registrable PC names are used up (don't delay fetching by PCs that can deliver)
    const result = await withinBudget(env, at, RESERVE.turn, async (db) =>
      (await mayWrite(db, collector)) ? takeTurns(db, collector, requests, at) : null, now);
    if (result.ok && result.value !== null) return json(200, result.value);
    // On days without budget, or for PCs that can't deliver, no turn is decided (each PC fetches on its own; uploads are refused too, so D1 is untouched)
    return json(200, Object.fromEntries([...requests.keys()].map((id) => [id, { go: true, wait_s: 0 }])));
  }

  if (put) {
    let body: unknown;
    try {
      body = await readBody(request);
    } catch (e) {
      return e instanceof RangeError ? problem(413, "too_large") : problem(400, "invalid_json");
    }
    const upload = sanitizeUpload(body, collector);
    if ("error" in upload) return problem(400, upload.error);
    const received = now();
    // A PC whose clock is off by more than the tolerance is refused before D1 is touched (its times would be taken as they are).
    // The PC keeps its observations and shows the offset until its clock is fixed
    const offset = Date.parse(upload.snapshot.generated_at) - received.getTime();
    if (Math.abs(offset) > CLOCK_TOLERANCE_MS) return json(422, { error: "clock_skew", offset_s: Math.round(offset / 1000) });
    const result = await withinBudget(env, received, RESERVE.put, (db) => receive(db, env, upload, received), now);
    // No D1 budget left today. The PC keeps observations and resends after the wait
    if (!result.ok) return refused(result.reason, received);
    // Registrable PC names are used up and the new name was not accepted (nothing was written)
    if (result.value.limited) return problem(403, "collector_limit");
    // Observations were saved but the latest value was not replaced (seq not above the saved one, or same seq with different content).
    // The PC resends with a seq greater than this
    if (!result.value.applied) return json(409, { error: "stale_seq", seq: result.value.seq });
    return json(204, null);
  }

  if (token.role !== "read") return problem(403, "forbidden");
  // Client reads only read rows put at upload time (at most 3 rows; not counted against the budget, see budget.ts)
  if (url.pathname === "/v2/events") return readEvents(env.DB, url, now());
  if (url.pathname === "/v2/history") return readHistory(env.DB, url, now());
  const timeZone = url.searchParams.get("tz") ?? "Asia/Tokyo";
  if (url.pathname === "/v2/view" && !validTimeZone(timeZone)) return problem(400, "invalid_time_zone");
  const row = await loadPublicRow(env.DB);
  if (!row) return problem(404, "no_data");
  // Don't expose a provider's latest value not re-put after a boundary move. Use only derived values computed under the current boundary
  const { snapshot, stamps } = publicSnapshot(row);
  if (url.pathname === "/v2/snapshot") return json(200, snapshot);
  const metrics = await loadDerived(env.DB, stamps);
  // data_version: the counter of this latest-value row (advances on every save). Clients order responses by it (by the order of data read,
  // not response creation time, so a late old response doesn't revert a newer display)
  // boundaries: per-provider history boundary stamps (only accepted time and sequence number; no account info). Clients compare with
  // /v2/history's boundary and, if different (an account switch happened between reads), don't use that series
  const boundaries = { claude: stampOf(stamps, "claude"), codex: stampOf(stamps, "codex") };
  return json(200, { ...toView(snapshot, now(), { timeZone, metrics, collectorPriority: priority(env) }), data_version: row.dataVersion, boundaries });
}

/** Events: only seq greater than after (default 0). Clients remember the response's last_seq and pass it as after next time (reads one row) */
async function readEvents(db: D1Like, url: URL, now: Date): Promise<Response> {
  const raw = url.searchParams.get("after") ?? "0";
  if (!/^[0-9]{1,15}$/.test(raw)) return problem(400, "invalid_after");
  const after = Number(raw);
  const feed = await loadEventFeed(db);
  // Events past retention are not shown even if an older list is written later
  const keepFrom = new Date(now.getTime() - EVENT_RETENTION_MS).toISOString();
  feed.events = feed.events.filter((e) => e.created_at >= keepFrom);
  // The continuation seq is the largest seq in the returned list (never below after, even if the list is old or empty). It is derived
  // from the list rather than a saved counter, so out-of-order replacements don't skip events the client hasn't seen
  const newest = feed.events.reduce((n, e) => Math.max(n, e.seq), 0);
  return json(200, {
    last_seq: Math.max(after, newest),
    /** Oldest seq shown. If after is 1 or more below this, the gap is past retention and can't be read */
    oldest_seq: feed.events[0]?.seq ?? null,
    events: feed.events.filter((e) => e.seq > after),
  });
}

/**
 * 7-day series of the weekly limit: provider (required), window (omitted or seven_day), hours (1-170, default 168). Reads only the two rows
 * of the series Cron built from hourly aggregates and the boundary (the 24-hour series was removed)
 */
async function readHistory(db: D1Like, url: URL, now: Date): Promise<Response> {
  const provider = url.searchParams.get("provider") as ProviderId | null;
  if (!provider || !PROVIDERS.includes(provider)) return problem(400, "invalid_provider");
  const window = url.searchParams.get("window");
  if (window !== null && window !== "seven_day") return problem(400, "invalid_window");
  const rawHours = url.searchParams.get("hours") ?? "168";
  const hours = /^[0-9]{1,3}$/.test(rawHours) ? Number(rawHours) : Number.NaN;
  if (!(hours >= 1 && hours <= WEEKLY_HOURS)) return problem(400, "invalid_hours");
  const weekly = await loadWeekly(db, provider);
  if (!weekly) return problem(404, "no_data");
  const current = await loadPublicBoundaries(db);
  // boundary: the boundary stamp this series was built with (same shape as /v2/view's boundaries; a series built under another boundary is not shown)
  const boundary = stampOf(current, provider);
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const until = now.toISOString();
  const points = weekly.boundary === boundary ? weekly.series.filter((p) => p.at >= since && p.at <= until) : [];
  return json(200, { provider, since, boundary, windows: { seven_day: points } });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    await runCron(env, new Date(), () => new Date());
  },
};

/** Cron (every 5 min): within budget, computes derived values and deletes old rows */
export async function runCron(env: Env, at: Date, clock: () => Date = () => at): Promise<boolean> {
  const result = await withinBudget(env, at, RESERVE.cron, async (db) => {
    await repairPublicState(db, env);
    await refreshDerived(db, env, at);
    await refreshWeekly(db, at);
    await judge(db, env, at);
    await prune(db, at);
  }, clock);
  return result.ok;
}

/**
 * Span of the weekly series (upper bound of GET /v2/history's hours): 7 days plus 2 hours, so a client showing a calendar week
 * (169 hours when daylight saving time ends) still has its first hour late in the week
 */
const WEEKLY_HOURS = 7 * 24 + 2;

/**
 * Builds the weekly 7-day series only once an hour. If the build time (UTC hour) and boundary stamp match the saved ones,
 * nothing is read. When building, reads at most 170 hourly-aggregate rows per provider
 */
export async function refreshWeekly(db: D1Like, at: Date): Promise<void> {
  const boundaries = await loadPublicBoundaries(db);
  if (!boundaries) return;
  const hour = at.toISOString().slice(0, 13);
  // Read only WEEKLY_HOURS hours (including the current hour)
  const from = new Date(at.getTime() - (WEEKLY_HOURS - 1) * 3_600_000);
  for (const provider of PROVIDERS) {
    const stamp = stampOf(boundaries, provider);
    const saved = await loadWeekly(db, provider);
    if (saved && saved.builtHour === hour && saved.boundary === stamp) continue;
  // A boundary stamp is "accepted time#seq". Observations before that time (previous account) are not used
    const since = stamp.split("#")[0] ?? "";
    const fromHour = from.toISOString().slice(0, 13);
    const rows = await loadHourly(db, provider, "seven_day", fromHour, hour, since);
    await saveWeekly(db, provider, hourlySeries(rows, new Date(`${fromHour}:00:00.000Z`)), stamp, hour, at);
  }
}

/**
 * Event judgment: builds events from the same view as the display (using saved derived values) and the judgment state,
 * recording each once by key. Writes nothing if neither state nor events changed. If it recorded or deleted old events, rebuilds the one row shown to clients
 */
export async function judge(db: D1Like, env: Env, at: Date): Promise<void> {
  // Read the judgment state (token) before the view's sources (latest value, derived values). If a later-finishing Cron replaced the state,
  // this Cron's record stops on a token mismatch. An old view never overwrites a newer state.
  // A state written first by a later-time judgment is not advanced by an earlier-time judgment (judgeEvents)
  const { token, state } = await loadEventState(db);
  const row = await loadPublicRow(db);
  if (row) {
    const { snapshot, stamps } = publicSnapshot(row);
    const metrics = await loadDerived(db, stamps);
    // Windows whose derived values weren't computed from that window's fetched value are not judged this round (the read latest value and
    // derived values are compared per window, so an upload between reads can't mark a new fetch as judged with old derived values)
    const pending: string[] = [];
    for (const id of PROVIDERS) {
      for (const w of snapshot.providers[id]?.windows ?? []) {
        // Even with the same fetch time, a change in the chosen observation (PC priority) changes the value. Compare value and reset time too
        const c = metrics[id]?.[w.id];
        if (!c || c.fetched_at !== w.fetched_at || c.used_percent !== w.used_percent || c.resets_at !== w.resets_at) {
          pending.push(`${id}.${w.id}`);
        }
      }
    }
    const view = toView(snapshot, at, { metrics, collectorPriority: priority(env) });
    // The account-switch boundaries the view was built under (a switch starts the provider's notification state afresh)
    const boundaries = { claude: stampOf(stamps, "claude"), codex: stampOf(stamps, "codex") };
    const judged = judgeEvents(view, state, { last_received_at: view.last_received_at }, at, { pending, boundaries });
    if (judged.changed) await recordEvents(db, token, judged.state, judged.events, at);
  }
  await pruneEvents(db, at);
  // Rebuild every time and put only on change (self-heals next time even if the previous put failed or there are no new events)
  await rebuildEventFeed(db, at);
}

/**
 * Re-puts the latest-value row if it lags the current save (global counter) and boundaries (an upload's re-put failed, a save after reading
 * prevented putting, or a pre-migration row). Aligns on the next Cron without another upload
 */
export async function repairPublicState(db: D1Like, env: Env): Promise<void> {
  const version = await readDataVersion(db, ALL_VERSION);
  const current = await loadBoundaryStamps(db);
  const row = await loadPublicRow(db);
  const same = (s: BoundaryStamps | null) => s !== null && JSON.stringify(s) === JSON.stringify(current);
  // A row an earlier Worker put may hold values today's rules drop (e.g. extra usage); rebuild it even if no PC is sending
  const outdated = row !== null && JSON.stringify(settleLimits(withoutUnstored(row.snapshot))) !== JSON.stringify(row.snapshot);
  // A row left after every PC's latest value expired (also when an earlier Worker deleted them) is removed by publish
  if (row !== null && !(await hasSnapshots(db))) return publish(db, env);
  if (row ? row.version === version && same(row.boundaries) && same(row.current) && !outdated : !(await hasSnapshots(db))) return;
  await publish(db, env);
}
