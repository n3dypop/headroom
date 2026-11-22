// D1 reads and writes. Only the parts of the Worker's D1 binding we use are typed (no external type definitions).
import { DENIED_TEXT, type Holds } from "./holds.ts";

/** Fixed text of a provider whose access denial ended, while its values are of before (until its next fetch) */
const RESUMED_TEXT = "Access was restored; waiting for the next fetch";
import {
  EVENT_RETENTION_MS,
  BOUNDARY_GUARD_MS,
  emptyEventState,
  observationKey,
  type EventBody,
  type EventState,
  type JudgedEvent,
  type HourlyRow,
  type SeriesPoint,
  type CachedWindowMetrics,
  type MetricsCache,
  type ProviderId,
  type Snapshot,
  type UsageObservation,
} from "../../core/src/index.ts";
import { PROVIDERS } from "../../core/src/index.ts";
import { heldToClock, settleLimits, withinClock, withoutUnstored, type CleanUpload } from "./sanitize.ts";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

const DAY_MS = 24 * 60 * 60_000;
/** Observation retention (weekly limit plus margin) */
export const OBSERVATION_RETENTION_MS = 8 * DAY_MS;
/** Retention of per-PC latest values */
export const SNAPSHOT_RETENTION_MS = 30 * DAY_MS;
/**
 * Marks this Worker's writes to the rows the upgrade cleanup holds (collector_snapshots, observations, observation_hourly, public_state).
 * After the cleanup, triggers refuse a write without it: a request an earlier Worker was still handling can't put back what the cleanup removed
 */
export const WRITER = 2;

/**
 * Max observations one Cron reads for derived values, all providers together. Turning them into values and computing takes the Cron's
 * CPU (10 ms on the free plan)
 */
export const CRON_HISTORY_ROWS = 10_000;
/** Max observations read per provider for derived values (newest first): an equal share of the run's rows, so every provider due is
 * computed in one run (with heavy use the 24-hour rate covers a shorter span) */
export const HISTORY_ROW_LIMIT = Math.floor(CRON_HISTORY_ROWS / PROVIDERS.length);
/** Rows deleted per kind and provider per Cron (deletes count as writes: 3 rows per item, the row and 2 indexes; 3 providers fit the
 * Cron's write reserve with 200; the rest go next Cron) */
export const PRUNE_ROWS = 200;

/** Whether a stored provider name is one of the providers */
export function isProvider(p: string): p is ProviderId {
  return (PROVIDERS as readonly string[]).includes(p);
}
/** Windows aggregated hourly (the chart is fixed to the weekly limit's 7 days) */
export const ROLLUP_WINDOWS: readonly string[] = ["seven_day"];
/**
 * Number of PC names that can be registered in D1 (twice the writing-PC limit of 16, to allow replacing PCs). A name, once registered
 * in collector_names, is never deleted (deleting it would drop that name's acceptance records, turning a past acceptance into a new
 * switch). Reuse the same name when replacing a PC. If used up, recreate D1 (see docs/install.md).
 * A new name is registered in the first statement of the upload batch, and the CHECK on the number (slot) keeps it within the limit (even with concurrent uploads).
 * Per-PC table names never exceed this number, so it also bounds the per-PC rows read on upload
 */
export const MAX_STORED_COLLECTORS = 32;
/** Rows per aggregation statement (5 values per row; fits D1's limit of 100 values per statement) */
export const ROLLUP_ROWS_PER_INSERT = 16;
/** Upper bound on observation times aggregated (from the received time; tolerates a little PC clock skew) */
export const ROLLUP_FUTURE_MS = 5 * 60_000;

/** Rows that fit D1's per-statement bind limit (100) */
const ROWS_PER_INSERT = 14;

/** The boundary moved forward by the guard (BOUNDARY_GUARD_MS), in SQL over a column or subquery giving the boundary */
const guardedSql = (since: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${since}) + ${BOUNDARY_GUARD_MS} / 86400000.0)`;
/** The same in code ('' when there is no boundary) */
export const guarded = (since: string): string =>
  since === "" ? "" : new Date(Date.parse(since) + BOUNDARY_GUARD_MS).toISOString();

/**
 * History boundaries. Kept in 2 tables (times only, no account information):
 * - `since` (per provider): the boundary in the endpoint's time. Observations before it are deleted. Moves forward only. `setters` is the PC
 *   that created the boundary (that PC's provider stays in the merge right after acceptance even without windows)
 * - `sources` (per provider and PC): the last `history_since` accepted from that PC. Repeats of the same value are not new acceptances.
 *   An acceptance after a clock fix (a smaller value than before) is also a new acceptance if the value changed
 * Uploads from PCs whose clock is off by more than CLOCK_TOLERANCE_MS are refused, so a PC's times are within the guard
 * (BOUNDARY_GUARD_MS) of the real ones: values stamped before the boundary plus the guard may be from before the switch and are left out
 * (except the setting PC's own values after its acceptance). Boundaries are not updated from uploads whose seq has become stale by save
 * time (checked inside SQL)
 */
export interface Boundaries {
  since: Map<string, string>;
  setters: Map<string, string>;
  sources: Map<string, string>;
}

const pcKey = (provider: string, collector: string) => `${provider}/${collector}`;

export async function loadBoundaries(db: D1Like): Promise<Boundaries> {
  const since = await db
    .prepare("SELECT provider, since, collector FROM history_boundaries")
    .all<{ provider: string; since: string; collector: string }>();
  const sources = await db
    .prepare("SELECT provider, collector, source FROM boundary_sources")
    .all<{ provider: string; collector: string; source: string }>();
  return {
    since: new Map(since.results.map((r) => [r.provider, r.since])),
    setters: new Map(since.results.map((r) => [r.provider, r.collector])),
    sources: new Map(sources.results.map((r) => [pcKey(r.provider, r.collector), r.source])),
  };
}

/** Save result. If `applied` is false the latest value was not replaced (`seq` is the saved seq) */
export interface SaveResult {
  seq: number;
  applied: boolean;
  /** Registrable PC names are used up and an upload under a new name was refused (nothing written) */
  limited?: true;
}

/**
 * Appends observations and replaces the PC's latest value if seq is greater than the saved one. Done in one batch (transaction).
 * When a PC that accepted an account switch sends a new boundary (history_since), observations before that provider's boundary
 * are deleted for all PCs. Observations before the boundary are rejected inside the save SQL (so concurrent requests can't bring back
 * deleted history through old resends)
 */
export async function saveUpload(
  db: D1Like,
  upload: CleanUpload,
  receivedAt: Date,
  /** PC priority (earlier is higher; used when aggregating observations at the same time) */
  collectorPriority: readonly string[] = [],
): Promise<SaveResult> {
  const received = receivedAt.toISOString();
  const collector = upload.snapshot.collector ?? "";
  const statements: D1Statement[] = [];
  // Register a new PC name before writing (registration is the batch's first statement; if the CHECK on the number exceeds the limit, the whole batch fails and nothing is written).
  // Checks one row each of the primary key and the number index (no table count; reads are counted by rows D1 returns)
  let named = await registeredName(db, collector);
  if (named === null && await namesFull(db)) {
    // Even when full, accept if a concurrent upload has finished registering the same name
    named = await registeredName(db, collector);
    if (named === null) return { seq: 0, applied: false, limited: true };
  }
  const registering = named === null;
  if (registering) {
    statements.push(
      db
        .prepare(
          `INSERT INTO collector_names (name, slot, seq)
           SELECT ?, coalesce((SELECT slot FROM collector_names ORDER BY slot DESC LIMIT 1), -1) + 1, 0
           WHERE NOT EXISTS (SELECT 1 FROM collector_names WHERE name = ?)`,
        )
        .bind(collector, collector),
    );
  }
  // Look up only this PC's acceptance records by primary key (don't read all PCs)
  const accepted = await db
    .prepare(`SELECT provider, source FROM boundary_sources WHERE provider IN (${PROVIDERS.map((p) => `'${p}'`).join(", ")}) AND collector = ?`)
    .bind(collector)
    .all<{ provider: string; source: string }>();
  const acceptedSource = new Map(accepted.results.map((r) => [r.provider, r.source]));
  // Don't create a boundary from a resend of an old upload (seq not above the saved one; don't roll back to a previous acceptance). The same
  // check runs inside each SQL in case concurrent requests make it stale by save time
  // The seq compared is the last accepted seq kept in the registration table (it survives the latest value expiring after 30 days)
  const fresh = named === null || upload.seq > named.seq;
  const notStale = "NOT EXISTS (SELECT 1 FROM collector_names n0 WHERE n0.name = ? AND n0.seq >= ?)";
  for (const [provider, p] of Object.entries(upload.snapshot.providers)) {
    const source = p?.history_since ?? null;
    if (source === null || !fresh) continue;
    if (acceptedSource.get(provider) === source) continue;
    // A new acceptance. The boundary is never after the received time (an acceptance time ahead of it was recorded while the PC's clock
    // ran ahead). If it doesn't move past the boundary at save time, use the received time (acceptance after a clock fix). The comparison target is read inside SQL (so the correction isn't lost if a concurrent request moved the boundary first)
    const candidate = source < received ? source : received;
    const currentSince = "(SELECT since FROM history_boundaries WHERE provider = ?)";
    // Don't apply the same acceptance (PC, provider, history_since) twice. Even if two concurrent uploads both pass the pre-check, the batch
    // checks the acceptance record (boundary_sources), which is written last (batch statements run one by one in order)
    const unseen =
      "NOT EXISTS (SELECT 1 FROM boundary_sources s WHERE s.provider = ? AND s.collector = ? AND s.source = ?)";
    statements.push(
      // Advance the boundary epoch on every acceptance (even if since doesn't change, the setting PC and its acceptance time change)
      db
        .prepare(
          `INSERT INTO boundary_epochs (provider, epoch) SELECT ?, 1 WHERE ${notStale} AND ${unseen}
           ON CONFLICT (provider) DO UPDATE SET epoch = boundary_epochs.epoch + 1`,
        )
        .bind(provider, collector, upload.seq, provider, collector, source),
      // The boundary moved, so recompute this provider's derived values (advance the counter in the same batch as the save)
      db
        .prepare(
          `INSERT INTO data_versions (provider, version) SELECT ?, 1 WHERE ${notStale} AND ${unseen}
           ON CONFLICT (provider) DO UPDATE SET version = data_versions.version + 1`,
        )
        .bind(provider, collector, upload.seq, provider, collector, source),
      db
        .prepare(
          `INSERT INTO history_boundaries (provider, since, collector)
           SELECT ?, CASE WHEN ? > coalesce(${currentSince}, '') THEN ? ELSE ? END, ? WHERE ${notStale} AND ${unseen}
           ON CONFLICT (provider) DO UPDATE SET since = excluded.since, collector = excluded.collector
           -- A later acceptance at the same boundary time also becomes the setting PC
           WHERE excluded.since >= history_boundaries.since`,
        )
        .bind(provider, candidate, provider, candidate, received, collector, collector, upload.seq, provider, collector, source),
      // The acceptance record goes last (the statements above only apply to an acceptance not yet recorded)
      db
        .prepare(
          `INSERT INTO boundary_sources (provider, collector, source) SELECT ?, ?, ? WHERE ${notStale}
           ON CONFLICT (provider, collector) DO UPDATE SET source = excluded.source`,
        )
        .bind(provider, collector, source, collector, upload.seq),
    );
  }
  const unique = new Map<string, UsageObservation>();
  for (const o of upload.observations) {
    const key = observationKey(o.provider, o.window_id, o.collector, o.observed_at);
    if (key !== null && !unique.has(key)) unique.set(key, o);
  }
  const rows = [...unique.values()];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO observations
             (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent, writer)
           SELECT column1, column2, column3, column4, column5, column6, column7, ${WRITER} FROM (VALUES ${placeholders}) AS v
           -- Received before the boundary, or stamped before the boundary plus the guard (may be from before the switch)
           WHERE NOT EXISTS (
             SELECT 1 FROM history_boundaries b
             WHERE b.provider = v.column1 AND (v.column5 < b.since OR v.column4 < ${guardedSql("b.since")})
           )
           -- At or before the marker an earlier Worker kept for that PC (observations it removed at a boundary; a resend doesn't bring them back)
           AND NOT EXISTS (
             SELECT 1 FROM boundary_watermarks w WHERE w.provider = v.column1 AND w.collector = v.column3 AND v.column4 <= w.until
           )`,
        )
        .bind(
          ...chunk.flatMap((o) => [
            o.provider, o.window_id, o.collector, o.observed_at, received, o.resets_at, o.used_percent,
          ]),
        ),
    );
  }
  // Hourly aggregation of the weekly limit (7-day trend). For the weekly observations in this upload (up to 200),
  // look up the saved observations by primary key (values and first receipt as saved; unsaved observations aren't found; no scan of the observation table).
  // The hour bucket and chart time are the earlier of observation and first receipt. Per hour the best valid observation is the representative, written only if better than the current one or the current
  // one became invalid under the current boundary. Better means: newer time (effective_at), higher PC priority, newer observation time
  // recorded by the PC, then smaller PC name (so arrival order doesn't change the representative even when rounded to the same time).
  // From 8 days before to 5 minutes after the received time
  const rank = collectorPriority.indexOf(collector) >= 0 ? collectorPriority.indexOf(collector) : collectorPriority.length;
  const earliest = receivedAt.getTime() - OBSERVATION_RETENTION_MS;
  const latest = receivedAt.getTime() + ROLLUP_FUTURE_MS;
  const candidates = rows.filter((o) => {
    const at = Date.parse(o.observed_at);
    return ROLLUP_WINDOWS.includes(o.window_id) && Number.isFinite(at) && at >= earliest && at <= latest;
  });
  const lookup = (column: string) =>
    `(SELECT o.${column} FROM observations o
       WHERE o.provider = v.column1 AND o.window_id = v.column2 AND o.collector = v.column3 AND o.observed_at = v.column4)`;
  /** Whether the row is valid under the current boundary (same condition as saving and reads) */
  const valid = (t: string) =>
    `NOT EXISTS (SELECT 1 FROM history_boundaries b
       WHERE b.provider = ${t}.provider AND (${t}.first_received_at < b.since OR ${t}.observed_at < ${guardedSql("b.since")}))`;
  for (let i = 0; i < candidates.length; i += ROLLUP_ROWS_PER_INSERT) {
    const chunk = candidates.slice(i, i + ROLLUP_ROWS_PER_INSERT);
    statements.push(
      db
        .prepare(
          `INSERT INTO observation_hourly
             (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority, writer)
           SELECT provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector,
             priority, ${WRITER}
           FROM (
             SELECT *, row_number() OVER (
                 PARTITION BY provider, window_id, hour
                 ORDER BY effective_at DESC, priority ASC, observed_at DESC, collector ASC) AS pick
             FROM (
               SELECT *, min(observed_at, first_received_at) AS effective_at,
                 substr(min(observed_at, first_received_at), 1, 13) AS hour
               FROM (
                 SELECT v.column1 AS provider, v.column2 AS window_id, v.column3 AS collector, v.column4 AS observed_at,
                   v.column5 AS priority,
                   ${lookup("used_percent")} AS used_percent, ${lookup("resets_at")} AS resets_at,
                   ${lookup("first_received_at")} AS first_received_at
                 FROM (VALUES ${chunk.map(() => "(?, ?, ?, ?, ?)").join(", ")}) AS v
               ) AS s
               WHERE s.first_received_at IS NOT NULL AND ${valid("s")}
             ) AS c
           ) AS r
           WHERE pick = 1
           ON CONFLICT (provider, window_id, hour) DO UPDATE SET
             used_percent = excluded.used_percent, resets_at = excluded.resets_at, observed_at = excluded.observed_at,
             effective_at = excluded.effective_at, first_received_at = excluded.first_received_at,
             collector = excluded.collector, priority = excluded.priority, writer = excluded.writer
           WHERE excluded.effective_at > observation_hourly.effective_at
              OR (excluded.effective_at = observation_hourly.effective_at AND (
                excluded.priority < observation_hourly.priority
                OR (excluded.priority = observation_hourly.priority AND (
                  excluded.observed_at > observation_hourly.observed_at
                  OR (excluded.observed_at = observation_hourly.observed_at AND excluded.collector < observation_hourly.collector)))))
              OR NOT (${valid("observation_hourly")})`,
        )
        .bind(...chunk.flatMap((o) => [o.provider, o.window_id, o.collector, o.observed_at, rank])),
    );
  }
  // The latest value is stored as sent
  const body = JSON.stringify(upload.snapshot);
  // Change counters advance in the same batch as the save (never a case where only the counter fails and nothing is recomputed or published).
  // The global counter advances per upload (used by the latest-value re-put to detect a save after reading)
  statements.push(
    db.prepare(
      `INSERT INTO data_versions (provider, version) VALUES ('${ALL_VERSION}', 1)
       ON CONFLICT (provider) DO UPDATE SET version = data_versions.version + 1`,
    ),
  );
  // A provider's counter advances only if it has observations in this upload or this PC's latest value for it is replaced
  // (Cron doesn't re-read history of unchanged providers). Replacement is judged against the row before the save
  for (const provider of PROVIDERS) {
    const path = `$.providers.${provider}`;
    const observed = rows.some((o) => o.provider === provider) ? 1 : 0;
    statements.push(
      db
        .prepare(
          `INSERT INTO data_versions (provider, version) SELECT ?, 1
           WHERE ? = 1 OR (${notStale} AND json_extract(
             coalesce((SELECT snapshot FROM collector_snapshots WHERE collector = ?), '{}'), ?) IS NOT json_extract(?, ?))
           ON CONFLICT (provider) DO UPDATE SET version = data_versions.version + 1`,
        )
        .bind(provider, observed, collector, upload.seq, collector, path, body, path),
    );
  }
  statements.push(
    db
      .prepare(
        // Don't rebuild a latest value from an old resend after it has expired
        `INSERT INTO collector_snapshots (collector, seq, snapshot, received_at, writer) SELECT ?, ?, ?, ?, ${WRITER} WHERE ${notStale}
         ON CONFLICT (collector) DO UPDATE SET
           seq = excluded.seq, snapshot = excluded.snapshot, received_at = excluded.received_at, writer = excluded.writer
         WHERE excluded.seq > collector_snapshots.seq`,
      )
      .bind(collector, upload.seq, body, received, collector, upload.seq),
    // Record the accepted seq in the registration table (after replacing the latest value; earlier statements in this batch judge by the previous seq)
    db.prepare("UPDATE collector_names SET seq = ? WHERE name = ? AND seq < ?").bind(upload.seq, collector, upload.seq),
    // The database is used from the first save on (writes only that once)
    db.prepare("UPDATE data_generation SET used = 1 WHERE id = 1 AND used = 0"),
  );
  // Put the current boundaries into the latest-value row in the same transaction as the boundary save (write only on change)
  statements.push(
    db.prepare(
      // Also keep the global counter at the time of the put (already advanced by earlier statements in this batch)
      `UPDATE public_state SET current_boundaries = (${CURRENT_BOUNDARIES_SQL}),
         current_version = (SELECT version FROM data_versions WHERE provider = '${ALL_VERSION}'), writer = ${WRITER}
       WHERE id = 1 AND current_boundaries IS NOT (${CURRENT_BOUNDARIES_SQL})`,
    ),
  );
  try {
    await db.batch(statements);
  } catch (e) {
    // A concurrent upload used the last number first (the CHECK on the number failed the whole batch). Nothing was written
    if (registering && await registeredName(db, collector) === null && await namesFull(db)) {
      return { seq: 0, applied: false, limited: true };
    }
    throw e;
  }
  // Whether it was replaced. Same seq with different content is not replaced. A resend of the same upload counts as replaced
  const stored = await db
    .prepare(
      `SELECT n.seq AS seq, c.snapshot AS snapshot FROM collector_names n
       LEFT JOIN collector_snapshots c ON c.collector = n.name WHERE n.name = ?`,
    )
    .bind(collector)
    .first<{ seq: number; snapshot: string | null }>();
  const seq = Number(stored?.seq ?? upload.seq);
  return { seq, applied: seq === upload.seq && stored?.snapshot === body };
}

/** The registered PC name and its last accepted seq (one row by primary key) */
export async function registeredName(db: D1Like, collector: string): Promise<{ seq: number } | null> {
  const { results } = await db.prepare("SELECT seq FROM collector_names WHERE name = ?").bind(collector).all<{ seq: number }>();
  return results[0] === undefined ? null : { seq: Number(results[0].seq) };
}

/** Whether registrable PC names are used up (one row of the number index) */
export async function namesFull(db: D1Like): Promise<boolean> {
  const { results } = await db
    .prepare("SELECT slot FROM collector_names ORDER BY slot DESC LIMIT 1")
    .all<{ slot: number }>();
  return Number(results[0]?.slot ?? -1) + 1 >= MAX_STORED_COLLECTORS;
}

/** In SQL, whether the PC name (expression) can write (registered, or still registrable; one row each of primary key and number index) */
/** SQL that is true while the PC name (a bound parameter or a column) can write: registered, or still registrable */
export const writableSql = (name: string) => writable(name);

const writable = (name: string) =>
  `(EXISTS (SELECT 1 FROM collector_names WHERE name = ${name})
    OR coalesce((SELECT slot FROM collector_names ORDER BY slot DESC LIMIT 1), -1) + 1 < ${MAX_STORED_COLLECTORS})`;

/** Whether the PC name can write (registered, or still registrable; checked before deciding the turn) */
export async function mayWrite(db: D1Like, collector: string): Promise<boolean> {
  return (await registeredName(db, collector)) !== null || !(await namesFull(db));
}

/**
 * Per-PC latest values. For providers with a boundary, a value received before the boundary is removed, and windows fetched before the
 * boundary plus the guard are removed (the setting PC's windows: before its own acceptance time, in its own clock). For a PC that hasn't accepted the switch, a provider with no remaining windows and a provider fetch time
 * before the boundary is omitted (so the merge never picks the previous account's value; a post-boundary "no windows, limit only" value is kept)
 */
export async function loadSnapshots(db: D1Like): Promise<{ snapshots: Snapshot[]; received: Map<string, string> }> {
  const boundaries = await loadBoundaries(db);
  const marks = await loadWatermarks(db);
  const { results: all } = await db
    .prepare("SELECT collector, snapshot, received_at FROM collector_snapshots")
    .all<{ collector: string; snapshot: string; received_at: string }>();
  // A row an earlier Worker kept from a PC whose clock today's Worker refuses: left out entirely (its values, state and liveness)
  const rows = all.map((r) => ({ ...r, parsed: JSON.parse(r.snapshot) as Snapshot })).filter((r) => withinClock(r.parsed, r.received_at));
  return {
    // Held to today's rules (rows saved by an earlier Worker: unstored windows, values after the send time, its markers), then boundaries applied
    snapshots: rows.map((r) =>
      settleLimits(applyBoundaries(belowMarks(heldToClock(withoutUnstored(r.parsed), r.received_at), r.collector, marks), r.received_at, boundaries))
    ),
    // Each PC's last received time (liveness marker)
    received: new Map(rows.map((r) => [r.collector, r.received_at])),
  };
}

/** The markers an earlier Worker kept per provider and PC (`provider/collector` -> time; values at or before it are not used) */
async function loadWatermarks(db: D1Like): Promise<Map<string, string>> {
  const { results } = await db
    .prepare("SELECT provider, collector, until FROM boundary_watermarks")
    .all<{ provider: string; collector: string; until: string }>();
  return new Map(results.map((r) => [pcKey(r.provider, r.collector), r.until]));
}

/** Windows at or before an earlier Worker's marker for that PC are left out (with the limit flag of a provider that loses them) */
export function belowMarks(snapshot: Snapshot, collector: string, marks: Map<string, string>): Snapshot {
  if (marks.size === 0) return snapshot;
  const providers: Snapshot["providers"] = {};
  for (const [id, p] of Object.entries(snapshot.providers) as [string, Snapshot["providers"][keyof Snapshot["providers"]]][]) {
    const until = marks.get(pcKey(id, collector));
    if (!p || until === undefined) {
      if (p) providers[id as ProviderId] = p;
      continue;
    }
    const windows = p.windows.filter((w) => w.fetched_at !== null && w.fetched_at > until);
    const fetchedOk = p.fetched_at !== null && p.fetched_at > until;
    providers[id as ProviderId] = windows.length === p.windows.length && fetchedOk ? p : {
      ...p, windows, fetched_at: windows.map((w) => w.fetched_at as string).sort()[0] ?? (fetchedOk ? p.fetched_at : null), blocked: null,
    };
  }
  return { ...snapshot, providers };
}

export function applyBoundaries(snapshot: Snapshot, receivedAt: string, boundaries: Boundaries): Snapshot {
  const providers: Snapshot["providers"] = {};
  const collector = snapshot.collector ?? "";
  for (const id of PROVIDERS) {
    const p = snapshot.providers[id];
    if (p === undefined) continue;
    const since = boundaries.since.get(id);
    if (since === undefined) {
      providers[id] = p;
      continue;
    }
    // Every PC: received after the boundary (a row kept by an earlier Worker may have been received before it) and stamped after the
    // boundary plus the guard. The PC that set the boundary may also show values from its own acceptance time (its clock) on, so its new
    // account shows right after the acceptance; an acceptance time recorded while its clock ran ahead (later than the boundary, which is
    // never after the received time) doesn't hide its values fetched after the clock was fixed
    const source = boundaries.setters.get(id) === collector ? boundaries.sources.get(pcKey(id, collector)) : undefined;
    const guard = guarded(since);
    const after = (t: string | null) =>
      t !== null && ((t >= guard && receivedAt >= since) || (source !== undefined && t >= source));
    const windows = p.windows.filter((w) => after(w.fetched_at));
    const providerAfter = after(p.fetched_at);
    if (windows.length === p.windows.length && providerAfter) {
      providers[id] = p;
      continue;
    }
    // The provider of the PC that created the current boundary shows its state (e.g. fetch failure) right after acceptance even without values
    const setter = boundaries.setters.get(id) === collector && p.history_since !== null &&
      boundaries.sources.get(pcKey(id, collector)) === p.history_since;
    if (windows.length === 0 && !providerAfter && !setter) continue;
    const fresh = windows.length > 0 || providerAfter;
    const fetched = windows.length > 0
      ? windows.map((w) => w.fetched_at as string).sort()[0]!
      : (providerAfter ? p.fetched_at : null);
    // If only pre-boundary values exist, the limit marker also belongs to the previous account, so omit it
    providers[id] = { ...p, windows, fetched_at: fetched, blocked: fresh ? p.blocked : null };
  }
  return { ...snapshot, providers };
}

/**
 * A provider's observations received since `since`. Times used for computation are clamped to the first received time. Observations received
 * before the history boundary or stamped before it plus the guard are not returned (same as the save-time check).
 * Reads only that provider's range via the (provider, first_received_at) index (keeps D1 rows read down)
 */
export async function loadObservations(
  db: D1Like,
  provider: UsageObservation["provider"],
  since: Date,
  boundaries?: Pick<Boundaries, "since">,
): Promise<UsageObservation[]> {
  const b = boundaries ?? await loadBoundaries(db);
  // Newest first, up to the limit (walks the (provider, first_received_at) index backwards, so rows read stay within the limit)
  const { results } = await db
    .prepare(
      `SELECT window_id, collector, observed_at, first_received_at, resets_at, used_percent
       FROM observations WHERE provider = ? AND first_received_at >= ?
       ORDER BY first_received_at DESC LIMIT ?`,
    )
    .bind(provider, since.toISOString(), HISTORY_ROW_LIMIT)
    .all<{
      window_id: string;
      collector: string;
      observed_at: string;
      first_received_at: string;
      resets_at: string | null;
      used_percent: number;
    }>();
  const cut = b.since.get(provider);
  const guard = cut === undefined ? "" : guarded(cut);
  // Both times are stored as toISOString strings only (the Worker writes no other form), so the earlier one is the smaller string, as the
  // hourly aggregation takes it in SQL. No dates are parsed per row: the Cron's CPU with three providers of 5,000 rows each
  return results
    .filter((r) => cut === undefined || (r.first_received_at >= cut && r.observed_at >= guard))
    .map((r) => ({
      provider,
      window_id: r.window_id,
      collector: r.collector,
      resets_at: r.resets_at,
      used_percent: Number(r.used_percent),
      observed_at: r.observed_at < r.first_received_at ? r.observed_at : r.first_received_at,
    }));
}

/** Counter of the merged latest value. public_state compares with this; derived values compare with per-provider counters */
export const ALL_VERSION = "all";

/**
 * Advance the counter of the merged latest value from the value read before (a public value put without an upload). false if it moved
 * meanwhile (an upload saved and puts its own value, which stands)
 */
export async function bumpAllVersion(db: D1Like, expected: number): Promise<boolean> {
  const result = expected === 0
    ? await db
      .prepare(`INSERT INTO data_versions (provider, version) VALUES ('${ALL_VERSION}', 1)
        ON CONFLICT (provider) DO UPDATE SET version = 1 WHERE data_versions.version = 0`)
      .run()
    : await db
      .prepare(`UPDATE data_versions SET version = version + 1 WHERE provider = '${ALL_VERSION}' AND version = ?`)
      .bind(expected)
      .run();
  return changes(result) > 0;
}

/**
 * The data generation (moved on by the one-time cleanup after an upgrade). Derived values carry the generation they were computed in; one
 * of another generation is not shown and is computed again (it may come from rows the cleanup removed)
 */
export async function readGeneration(db: D1Like): Promise<number> {
  const row = await db.prepare("SELECT generation FROM data_generation WHERE id = 1").first<{ generation: number }>();
  return Number(row?.generation ?? 0);
}

/** Whether this database was ever used (a PC saved something, also before an earlier Worker removed it): then no value is a withdrawal, not "no value yet" */
export async function databaseUsed(db: D1Like): Promise<boolean> {
  const row = await db.prepare("SELECT used FROM data_generation WHERE id = 1").first<{ used: number }>();
  return Number(row?.used ?? 0) === 1;
}

export async function readDataVersion(db: D1Like, provider: ProviderId | typeof ALL_VERSION): Promise<number> {
  const row = await db
    .prepare("SELECT version FROM data_versions WHERE provider = ?")
    .bind(provider)
    .first<{ version: number }>();
  return Number(row?.version ?? 0);
}

/** provider -> history boundary (since; empty string if none). Used to stamp which boundary computed values were computed under */
export type BoundaryStamps = Partial<Record<ProviderId, string>>;

/** Per-provider boundary stamp "since#acceptance epoch" (ordered by provider) */
const STAMPS_SQL = `SELECT p.provider, coalesce(b.since, '') || '#' || coalesce(e.epoch, 0) AS stamp
  FROM (SELECT provider FROM history_boundaries UNION SELECT provider FROM boundary_epochs) p
  LEFT JOIN history_boundaries b ON b.provider = p.provider
  LEFT JOIN boundary_epochs e ON e.provider = p.provider
  ORDER BY p.provider`;

/** JSON of the current boundaries ({"claude":"…"}, ordered by provider). Same string as JSON.stringify(loadBoundaryStamps()) */
const CURRENT_BOUNDARIES_SQL = `SELECT json_group_object(provider, stamp) FROM (${STAMPS_SQL})`;

/** Current history boundaries (one row per provider, at most one per provider) */
export async function loadBoundaryStamps(db: D1Like): Promise<BoundaryStamps> {
  const { results } = await db.prepare(STAMPS_SQL).all<{ provider: string; stamp: string }>();
  const out: BoundaryStamps = {};
  for (const r of results) if (isProvider(r.provider)) out[r.provider] = r.stamp;
  return out;
}

export const stampOf = (stamps: BoundaryStamps | null | undefined, provider: ProviderId) => stamps?.[provider] ?? "";

/** The history boundaries (provider -> since) the stamps were read with: a stamp is "since#epoch", "" before "#" when there is none */
export function historySince(stamps: BoundaryStamps): Pick<Boundaries, "since"> {
  const since = new Map<string, string>();
  for (const [provider, stamp] of Object.entries(stamps)) {
    const at = (stamp ?? "").split("#")[0] ?? "";
    if (at !== "") since.set(provider, at);
  }
  return { since };
}

/** Every provider's change counter in one read (0 for one never counted) */
export async function loadDataVersions(db: D1Like): Promise<Map<ProviderId, number>> {
  const { results } = await db
    .prepare(`SELECT provider, version FROM data_versions WHERE provider IN (${PROVIDERS.map(() => "?").join(", ")})`)
    .bind(...PROVIDERS)
    .all<{ provider: string; version: number }>();
  const out = new Map<ProviderId, number>(PROVIDERS.map((p) => [p, 0]));
  for (const r of results) if (isProvider(r.provider)) out.set(r.provider, Number(r.version));
  return out;
}

/** Per-provider saved derived-value counter and boundary stamp (decides whether Cron recomputes) */
export async function loadDerivedVersions(
  db: D1Like,
): Promise<Map<string, { version: number; boundary: string; basis: string | null; generation: number; computedAt: string }>> {
  const { results } = await db
    .prepare("SELECT provider, version, boundary, basis, generation, computed_at FROM derived_metrics")
    .all<{ provider: string; version: number; boundary: string | null; basis: string | null; generation: number; computed_at: string | null }>();
  return new Map(results.map((r) => [r.provider, {
    version: Number(r.version), boundary: r.boundary ?? "", basis: r.basis, generation: Number(r.generation), computedAt: r.computed_at ?? "",
  }]));
}

/**
 * Saves the merged latest value (boundaries applied) and the history boundaries at that time. `version` is the global counter read before
 * reading the latest values; it is put only if it equals the global counter at write time (no save after reading = this body is newest; an optimistic
 * check so an old read never overwrites a newer body even if read order and counter order differ). A body that couldn't be put is put by a later upload or Cron
 */
export async function savePublicState(
  db: D1Like,
  snapshot: Snapshot,
  version: number,
  boundaries: BoundaryStamps = {},
): Promise<boolean> {
  const result = await db
    .prepare(
      // Take the current boundaries from the table at write time (if another upload moved them after reading, don't put old boundaries as "current")
      `INSERT INTO public_state (id, version, body, boundaries, current_boundaries, writer)
       SELECT 1, ?, ?, ?, (${CURRENT_BOUNDARIES_SQL}), ${WRITER}
       WHERE coalesce((SELECT version FROM data_versions WHERE provider = '${ALL_VERSION}'), 0) = ?
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, body = excluded.body, boundaries = excluded.boundaries,
         current_boundaries = excluded.current_boundaries, writer = excluded.writer`,
    )
    .bind(version, JSON.stringify(snapshot), JSON.stringify(boundaries), version)
    .run();
  return changes(result) > 0;
}

export interface PublicRow {
  /** Global counter read before reading the body (put after confirming no save happened since) */
  version: number;
  /** The shared stops (access denied) marked on the row: applied to the merged value it shows (holds.ts) */
  holds?: Holds;
  snapshot: Snapshot;
  /** Boundaries when the body was merged. null for pre-migration rows */
  boundaries: BoundaryStamps | null;
  /** Current boundaries (put in the same transaction as the boundary save). null for pre-migration rows */
  current: BoundaryStamps | null;
  /** Counter returned to clients: the greater of the body's counter and the counter when the current boundaries were put */
  dataVersion: number;
}

/**
 * Counter returned to clients, built from the body's counter V and the counter C when the current boundaries were put. While only the boundary has
 * advanced (C > V, before the body is re-put) it is 2C - 1; once the body catches up, 2V. A boundary-only response is always smaller than the response with that upload's body
 */
export function dataVersionOf(version: number, currentVersion: number): number {
  return currentVersion > version ? 2 * currentVersion - 1 : 2 * version;
}

const parseStamps = (s: string | null) => (s === null ? null : (JSON.parse(s) as BoundaryStamps));

/** Whether at least one latest value from a PC is saved */
export async function hasSnapshots(db: D1Like): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS one FROM collector_snapshots LIMIT 1").first<{ one: number }>()) !== null;
}

/** The merged latest value, the boundaries when it was put, and the current boundaries (one row) */
export async function loadPublicRow(db: D1Like): Promise<PublicRow | null> {
  const row = await db
    .prepare("SELECT version, body, boundaries, current_boundaries, current_version, holds FROM public_state WHERE id = 1")
    .first<{ version: number; body: string; boundaries: string | null; current_boundaries: string | null; current_version: number | null; holds: string | null }>();
  return row
    ? {
      version: Number(row.version),
      holds: JSON.parse(row.holds ?? "{}") as Holds,
      dataVersion: dataVersionOf(Number(row.version), Number(row.current_version ?? 0)),
      snapshot: JSON.parse(row.body) as Snapshot,
      boundaries: parseStamps(row.boundaries),
      current: parseStamps(row.current_boundaries),
    }
    : null;
}

/** Providers whose merge-time boundary differs from the current one (their latest value may belong to the previous account) */
export function staleProviders(row: PublicRow): ProviderId[] {
  const current = row.current ?? row.boundaries ?? {};
  return PROVIDERS.filter((id) => stampOf(row.boundaries, id) !== stampOf(current, id));
}

/**
 * Latest value exposed by the read endpoint, and boundaries to compare computed values with (providers that may hold the previous account's
 * values are removed). A provider stopped by an access denial shows it, whatever value a PC sent (another PC's older success never hides
 * it), with its windows as they were fetched; a safety stop is shown first (both need the user)
 */
export function publicSnapshot(row: PublicRow): { snapshot: Snapshot; stamps: BoundaryStamps } {
  const stale = staleProviders(row);
  const providers = { ...row.snapshot.providers };
  for (const id of stale) delete providers[id];
  for (const id of PROVIDERS) {
    if (!row.holds?.[id]) {
      // The stop mark is the only word on a shared access denial: one a PC's own value still carries after the stop ended (a resume
      // on another PC) shows its windows as old, or nothing
      const p = providers[id];
      if (p?.error_code === "access_denied") {
        if (p.windows.length > 0) providers[id] = { ...p, status: "stale", error: RESUMED_TEXT, error_code: null };
        else delete providers[id];
      }
      continue;
    }
    const p = providers[id];
    if (p?.error_code === "safety_stop") continue;
    providers[id] = {
      ...(p ?? { fetched_at: null, collector: null, plan: null, blocked: null, history_since: null, windows: [] }),
      status: "error",
      error: DENIED_TEXT,
      error_code: "access_denied",
    };
  }
  return { snapshot: { ...row.snapshot, providers }, stamps: row.current ?? row.boundaries ?? {} };
}

/** Merged latest value used for client reads (one row). null if none yet */
export async function loadPublicState(db: D1Like): Promise<Snapshot | null> {
  const row = await db.prepare("SELECT body FROM public_state WHERE id = 1").first<{ body: string }>();
  return row ? (JSON.parse(row.body) as Snapshot) : null;
}

/**
 * Saved derived values. Given `boundaries` (the boundaries at read time), derived values of providers computed under a different boundary are removed
 * (don't show the previous account's forecast)
 */
/**
 * The public row and the derived values of the current generation, read in one statement (one consistent read: a body read before the
 * upgrade cleanup is never paired with derived values computed after it). null without a public row
 */
export async function loadPublicView(db: D1Like): Promise<{ row: PublicRow; derived: { provider: string; body: string; boundary: string | null }[] } | null> {
  const r = await db
    .prepare(
      // Three rows by primary key: the public row, the one row of derived values, the generation (derived values of another
      // generation are not used)
      `SELECT p.version, p.body, p.boundaries, p.current_boundaries, p.current_version, p.holds,
         (SELECT CASE WHEN x.generation = g.generation THEN x.body END
           FROM derived_public x, data_generation g WHERE x.id = 1 AND g.id = 1) AS derived
       FROM public_state p WHERE p.id = 1`,
    )
    .first<{ version: number; body: string; boundaries: string | null; current_boundaries: string | null; current_version: number | null; holds: string | null; derived: string | null }>();
  if (!r) return null;
  return {
    row: {
      version: Number(r.version),
      holds: JSON.parse(r.holds ?? "{}") as Holds,
      dataVersion: dataVersionOf(Number(r.version), Number(r.current_version ?? 0)),
      snapshot: JSON.parse(r.body) as Snapshot,
      boundaries: parseStamps(r.boundaries),
      current: parseStamps(r.current_boundaries),
    },
    derived: JSON.parse(r.derived ?? "[]"),
  };
}

/** Derived values of the rows given, only those computed under the boundaries given (as loadDerived) */
export function metricsOf(rows: { provider: string; body: string; boundary: string | null }[], boundaries?: BoundaryStamps): MetricsCache {
  const out: MetricsCache = {};
  for (const r of rows) {
    if (!isProvider(r.provider)) continue;
    if (boundaries && (r.boundary ?? "") !== stampOf(boundaries, r.provider)) continue;
    out[r.provider] = JSON.parse(r.body);
  }
  return out;
}

export async function loadDerived(db: D1Like, boundaries?: BoundaryStamps): Promise<MetricsCache> {
  const { results } = await db
    .prepare(`SELECT provider, body, boundary FROM derived_metrics WHERE generation = (SELECT generation FROM data_generation WHERE id = 1)`)
    .all<{ provider: string; body: string; boundary: string | null }>();
  const out: MetricsCache = {};
  for (const r of results) {
    if (!isProvider(r.provider)) continue;
    if (boundaries && (r.boundary ?? "") !== stampOf(boundaries, r.provider)) continue;
    out[r.provider] = JSON.parse(r.body);
  }
  return out;
}

/** Deletes rows past retention (called from Cron) */
export async function prune(db: D1Like, now: Date): Promise<void> {
  const observationCutoff = new Date(now.getTime() - OBSERVATION_RETENTION_MS).toISOString();
  const snapshotCutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_MS).toISOString();
  // Limit deletes per run (deletes count as writes; the rest go next Cron). Walks the (provider, first_received_at) index.
  // Observations past retention, and observations received before the history boundary (previous account; already filtered on read)
  const old = (provider: ProviderId) =>
    db
      .prepare(
        `DELETE FROM observations WHERE rowid IN (
           SELECT rowid FROM observations WHERE provider = ? AND first_received_at < ? LIMIT ?)`,
      )
      .bind(provider, observationCutoff, PRUNE_ROWS);
  const beforeBoundary = (provider: ProviderId) =>
    db
      .prepare(
        `DELETE FROM observations WHERE rowid IN (
           SELECT rowid FROM observations
           WHERE provider = ? AND first_received_at < (SELECT since FROM history_boundaries WHERE provider = ?) LIMIT ?)`,
      )
      .bind(provider, provider, PRUNE_ROWS);
  const oldHourly = (provider: ProviderId) =>
    db
      .prepare(
        `DELETE FROM observation_hourly WHERE provider = ? AND window_id = ? AND hour IN (
           SELECT hour FROM observation_hourly WHERE provider = ? AND window_id = ? AND hour < ? LIMIT ?)`,
      )
      .bind(provider, ROLLUP_WINDOWS[0], provider, ROLLUP_WINDOWS[0], observationCutoff.slice(0, 13), PRUNE_ROWS);
  await db.batch([
    ...PROVIDERS.map(oldHourly),
    ...PROVIDERS.map(old),
    ...PROVIDERS.map(beforeBoundary),
    db.prepare("DELETE FROM collector_snapshots WHERE received_at < ?").bind(snapshotCutoff),
    // A PC's latest value removed: the merged latest value is rebuilt by the next Cron (repairPublicState sees the counter move)
    db.prepare(`UPDATE data_versions SET version = version + 1 WHERE provider = '${ALL_VERSION}' AND changes() > 0`),
  ]);
}


/** Judgment state (one row) and the replacement token */
export async function loadEventState(db: D1Like): Promise<{ token: string; state: EventState }> {
  const row = await db.prepare("SELECT token, body FROM event_state WHERE id = 1").first<{ token: string; body: string }>();
  const parsed = row ? (JSON.parse(row.body) as Partial<EventState>) : {};
  return {
    token: row?.token ?? "",
    state: { ...emptyEventState(), ...parsed },
  };
}

/** meta.changes of a result (D1 returns the number of changed rows) */
const changes = (result: unknown) => Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);

/**
 * Replaces the judgment state and records events (one batch; a D1 batch is one transaction).
 * The state is replaced only if unchanged since read, and events are recorded only if it was (no stacking of overlapping Crons' old judgments).
 * Returns the number of visible events newly recorded (existing keys are not counted)
 */
export async function recordEvents(
  db: D1Like,
  token: string,
  state: EventState,
  events: readonly JudgedEvent[],
  now: Date,
): Promise<number> {
  const mine = crypto.randomUUID();
  const at = now.toISOString();
  const statements = [
    db.prepare("INSERT OR IGNORE INTO event_state (id, token, body) VALUES (1, '', '{}')"),
    db.prepare("UPDATE event_state SET token = ?, body = ? WHERE id = 1 AND token = ?").bind(mine, JSON.stringify(state), token),
    ...events.map((e) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO events (key, visible, created_at, keep_until, body)
           SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM event_state WHERE id = 1 AND token = ?)`,
        )
        .bind(e.key, e.visible ? 1 : 0, at, e.keep_until, JSON.stringify(e.body), mine)),
  ];
  const results = await db.batch(statements);
  return events.reduce((n, e, i) => n + (e.visible ? changes(results[i + 2]) : 0), 0);
}

/** Max events deleted per Cron run */
export const PRUNE_EVENTS = 300;
/** Max events shown to clients (newest first within 8 days) */
export const EVENT_FEED_LIMIT = 500;

/** Deletes events past their keep-until time. Returns the number deleted */
export async function pruneEvents(db: D1Like, now: Date): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM events WHERE rowid IN (
         SELECT rowid FROM events WHERE keep_until < ? LIMIT ?)`,
    )
    .bind(now.toISOString(), PRUNE_EVENTS)
    .run();
  return changes(result);
}

export interface FeedEvent extends EventBody {
  seq: number;
  created_at: string;
}

export interface EventFeed {
  /** Largest seq of the events shown (0 if none yet) */
  last_seq: number;
  events: FeedEvent[];
}

/** SELECT for rebuilding the events shown to clients (walks the events_visible_by_created index newest first and stops at the limit) */
export const EVENT_FEED_SQL =
  `SELECT seq, created_at, body FROM events WHERE visible = 1 AND created_at >= ?
   ORDER BY created_at DESC, seq DESC LIMIT ?`;

/**
 * Rebuilds the events shown to clients (8 days) and puts them into one row if changed (every Cron; self-heals next time if the previous put failed).
 * last_seq never goes back (even if everything passes retention and the list is empty, the client's continuation seq doesn't regress)
 */
export async function rebuildEventFeed(db: D1Like, now: Date): Promise<void> {
  const since = new Date(now.getTime() - EVENT_RETENTION_MS).toISOString();
  const { results } = await db
    .prepare(EVENT_FEED_SQL)
    .bind(since, EVENT_FEED_LIMIT)
    .all<{ seq: number; created_at: string; body: string }>();
  const events = results
    .map((r) => ({ ...(JSON.parse(r.body) as EventBody), seq: Number(r.seq), created_at: r.created_at }))
    .sort((a, b) => a.seq - b.seq);
  const body = JSON.stringify(events);
  const stored = await db.prepare("SELECT body FROM event_feed WHERE id = 1").first<{ body: string }>();
  if (stored?.body === body) return;
  await db
    .prepare(
      `INSERT INTO event_feed (id, last_seq, body) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last_seq = max(event_feed.last_seq, excluded.last_seq), body = excluded.body`,
    )
    .bind(events.at(-1)?.seq ?? 0, body)
    .run();
}

/** Events shown to clients (one row). Empty if none yet */
export async function loadEventFeed(db: D1Like): Promise<EventFeed> {
  const row = await db.prepare("SELECT last_seq, body FROM event_feed WHERE id = 1").first<{ last_seq: number; body: string }>();
  return row ? { last_seq: Number(row.last_seq), events: JSON.parse(row.body) as FeedEvent[] } : { last_seq: 0, events: [] };
}

/**
 * Puts derived values in one statement (if the save fails, the counter and boundary stamp stay as before, so the next Cron recomputes).
 * Does not overwrite if older than the counter read before computing
 */
/**
 * Rebuilds the one row the read endpoint reads (derived_public) from the derived_metrics rows actually stored for the current
 * generation (never from values read before: a Cron finishing later can't drop another provider's newer values)
 */
export const DERIVED_PUBLIC_SQL = `INSERT INTO derived_public (id, generation, body)
  SELECT 1, g.generation, (SELECT json_group_array(json_object('provider', d.provider, 'body', d.body, 'boundary', d.boundary))
    FROM derived_metrics d WHERE d.generation = g.generation)
  FROM data_generation g WHERE g.id = 1
  ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, body = excluded.body`;

/** Rebuilds derived_public (Cron, when no save of this run did: e.g. an earlier Worker saved derived values only) */
export async function rebuildDerivedPublic(db: D1Like): Promise<void> {
  await db.prepare(DERIVED_PUBLIC_SQL).run();
}

export async function saveDerived(
  db: D1Like,
  provider: ProviderId,
  metrics: Record<string, CachedWindowMetrics>,
  version: number,
  computedAt: Date,
  /** History boundary before reading the observations used for computation */
  boundary = "",
  /** The provider part of the latest value used for computation */
  basis: string | null = null,
  /** Counter of the latest-value row used for computation */
  publicVersion = 0,
  /** Data generation read before reading anything this computation used */
  generation = 0,
): Promise<void> {
  // An old computation never overwrites a newer one
  // Only a computation with neither counter below the saved ones replaces it. A computation whose two counters disagree in age (newer observations
  // but older latest value, etc.) doesn't replace. Both counters only increase, so the next Cron computing with the current counters always replaces
  await db.batch([
    db.prepare(
      // Put only while the generation read before computing is current (a computation that read rows the cleanup removed never saves,
      // also as a first row). Within a generation, the counters decide; a row of an older generation is replaced whatever its counters
      `INSERT INTO derived_metrics (provider, computed_at, version, body, boundary, basis, public_version, generation)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT generation FROM data_generation WHERE id = 1) = ?
       ON CONFLICT (provider) DO UPDATE SET computed_at = excluded.computed_at, version = excluded.version,
         body = excluded.body, boundary = excluded.boundary, basis = excluded.basis, public_version = excluded.public_version,
         generation = excluded.generation
       WHERE derived_metrics.generation < excluded.generation
         OR (derived_metrics.generation = excluded.generation AND excluded.version >= derived_metrics.version
           AND coalesce(excluded.public_version, 0) >= coalesce(derived_metrics.public_version, 0))`,
    )
      .bind(provider, computedAt.toISOString(), version, JSON.stringify(metrics), boundary, basis, publicVersion, generation, generation),
    // The read endpoint's row, from what is now stored (in the same batch: a failed batch leaves both as they were)
    db.prepare(DERIVED_PUBLIC_SQL),
  ]);
}

/** For every provider, the boundary stamp and hour its weekly series of the current generation was built (one read; no series) */
export async function loadWeeklyBuilt(db: D1Like): Promise<Map<string, { boundary: string; builtHour: string }>> {
  const { results } = await db
    .prepare(`SELECT provider, boundary, built_hour FROM derived_weekly WHERE generation = (SELECT generation FROM data_generation WHERE id = 1)`)
    .all<{ provider: string; boundary: string; built_hour: string }>();
  return new Map(results.map((r) => [r.provider, { boundary: r.boundary, builtHour: r.built_hour }]));
}

/** Weekly 7-day series (one row per provider), with the boundary stamp and time it was built */
export async function loadWeekly(
  db: D1Like,
  provider: ProviderId,
): Promise<{ series: SeriesPoint[]; boundary: string; builtHour: string } | null> {
  const row = await db
    .prepare(`SELECT body, boundary, built_hour FROM derived_weekly WHERE provider = ? AND generation = (SELECT generation FROM data_generation WHERE id = 1)`)
    .bind(provider)
    .first<{ body: string; boundary: string; built_hour: string }>();
  return row ? { series: JSON.parse(row.body) as SeriesPoint[], boundary: row.boundary, builtHour: row.built_hour } : null;
}

/**
 * Reads hourly aggregates for hours fromHour..toHour only, by primary-key range (bounded). Rows received before the boundary (since) or stamped
 * before it plus the guard are excluded (same conditions as regular history)
 */
export async function loadHourly(
  db: D1Like,
  provider: ProviderId,
  windowId: string,
  fromHour: string,
  toHour: string,
  since: string,
): Promise<HourlyRow[]> {
  const { results } = await db
    .prepare(
      `SELECT effective_at AS observed_at, used_percent, resets_at FROM observation_hourly h
       WHERE provider = ? AND window_id = ? AND hour >= ? AND hour <= ?
         AND first_received_at >= ? AND observed_at >= ?
       ORDER BY hour LIMIT ?`,
    )
    .bind(provider, windowId, fromHour, toHour, since, guarded(since), HOURLY_READ_LIMIT)
    .all<HourlyRow>();
  return results ?? [];
}

/** Max aggregate rows read per call (7 days = 168 hours plus margin) */
export const HOURLY_READ_LIMIT = 200;

export async function saveWeekly(
  db: D1Like,
  provider: ProviderId,
  series: SeriesPoint[],
  boundary: string,
  builtHour: string,
  at: Date,
  /** Data generation read before reading the representatives */
  generation = 0,
): Promise<void> {
  // Don't put if the boundary moved during computation (differs from the current stamp) or it's an old late-finishing computation (time before the saved one)
  const current = `coalesce(json_extract((SELECT coalesce(current_boundaries, boundaries) FROM public_state WHERE id = 1), '$.' || ?), '')`;
  await db
    .prepare(
      // And only while the generation read before reading the representatives is current (also as a first row); a series of an older
      // generation is replaced whatever its time
      `INSERT INTO derived_weekly (provider, body, boundary, built_hour, computed_at, generation)
       SELECT ?, ?, ?, ?, ?, ? WHERE ? = ${current} AND (SELECT generation FROM data_generation WHERE id = 1) = ?
       ON CONFLICT (provider) DO UPDATE SET body = excluded.body, boundary = excluded.boundary,
         built_hour = excluded.built_hour, computed_at = excluded.computed_at, generation = excluded.generation
       WHERE derived_weekly.generation < excluded.generation
         OR (derived_weekly.generation = excluded.generation AND excluded.computed_at >= derived_weekly.computed_at)`,
    )
    .bind(provider, JSON.stringify(series), boundary, builtHour, at.toISOString(), generation, boundary, provider, generation)
    .run();
}

/** Only the current boundaries put in public_state (one row; for pre-migration rows, the body's boundaries) */
export async function loadPublicBoundaries(db: D1Like): Promise<BoundaryStamps | null> {
  const row = await db
    .prepare("SELECT boundaries, current_boundaries FROM public_state WHERE id = 1")
    .first<{ boundaries: string | null; current_boundaries: string | null }>();
  return row ? (parseStamps(row.current_boundaries) ?? parseStamps(row.boundaries) ?? {}) : null;
}
