// Fetch turns, attempts and the shared stops of each provider (one row per provider in provider_holds).
//
// - A PC that shares (push set up) starts an active fetch only on a `go` this Worker gave for that provider and attempt id. The grant
//   marks the attempt pending: no other attempt of the provider is granted until its result comes (or, for one whose result never
//   came, until the user's explicit recovery on a PC). The normal turn's lease is taken only by the result of a successful `fetch`.
// - A rate limit (429) holds every PC off for its stage's wait; an access denial (403) stops the provider on every PC until a `resume`
//   the user asked for, of that stop, succeeds. The stop is marked on the public row in the same batch (the read endpoint applies it).
// - Nothing about an account is kept: PC names (already registered), attempt ids (random), times and counters only.

import { PROVIDERS, type ProviderId } from "../../core/src/index.ts";
import { EVENT_RETENTION_MS } from "../../core/src/events.ts";
import { writableSql, type D1Like } from "./store.ts";

export type TurnKind = "fetch" | "own" | "force" | "resume" | "release" | "peek";
export type Outcome = "ok" | "failed" | "not_run" | "rate_limited" | "access_denied";
export type Reason = "turn" | "pending" | "rate_limited" | "access_denied" | "unavailable" | "stale_gen" | "moved" | "gone";

const KINDS: readonly TurnKind[] = ["fetch", "own", "force", "resume", "release", "peek"];
const OUTCOMES: readonly Outcome[] = ["ok", "failed", "not_run", "rate_limited", "access_denied"];

/** The longest lease (minutes) a successful fetch takes */
export const LEASE_MAX_MINUTES = 90;
/** A pending attempt older than this (ms) may be replaced by the user's explicit recovery (force, or a resume of the same stop) */
export const PENDING_STUCK_MS = 5 * 60_000;
/** The waits (minutes) of the 429 stages, the first rate limit and those after it */
export const RATE_STAGES_MIN = [30, 60, 120, 240] as const;
/** The longest wait (seconds) a PC may report as named by the service (366 days: a long one is kept, not cut) */
export const MAX_RETRY_S = 366 * 86_400;
/** Fixed text of a provider stopped by an access denial (the read endpoint shows it) */
export const DENIED_TEXT = "Access denied by the service: fetching stopped on every PC (see headroom status on the PC)";
/** Attempt ids are 16 lowercase hex digits (random on the PC) */
const ATTEMPT = /^[0-9a-f]{16}$/;

export interface TurnRequest {
  kind: TurnKind;
  attempt: string | null;
  /** resume: the stop (denied_gen) the user confirmed */
  gen: number | null;
  /** The row's version the attempt was made against (required for every kind that can be granted): a new reservation is made only
   * on it, so a late copy of a request finds the row moved */
  base: number | null;
  /** force, resume: the pending attempt the user confirmed replacing (only that one is replaced) */
  replace: string | null;
  /** Asked again (its first answer was lost): a refusal of it is kept, so a late copy of it is never granted */
  again: boolean;
}

export interface ResultReport {
  attempt: string;
  /** The kind the attempt was granted as (applied only to the pending attempt of that kind) */
  kind: TurnKind;
  outcome: Outcome;
  /** The wait the service named (seconds), if it named one */
  retry_s: number | null;
  /** The PC's normal interval (seconds): a rate limit waits at least this */
  interval_s: number;
  /** A successful fetch's lease (minutes, at most LEASE_MAX_MINUTES; 0 takes none) */
  minutes: number;
}

export interface HoldRow {
  provider: string;
  version: number;
  holder: string | null;
  holder_attempt: string | null;
  holder_until: string | null;
  pending_collector: string | null;
  pending_attempt: string | null;
  pending_kind: string | null;
  pending_since: string | null;
  rate_stage: number;
  rate_until: string | null;
  denied: number;
  denied_gen: number;
  denied_since: string | null;
  result_attempt: string | null;
  retired: string | null;
}

/** The provider's shared state, as every answer carries it (a stopped PC learns from it that another PC resumed) */
export interface SharedState {
  denied: boolean;
  denied_gen: number;
  rate_stage: number;
  rate_wait_s: number;
  /** The row's version (after this request's write): a PC makes its next attempt against it */
  version: number;
}

/** Attempts that ended or were replaced, kept (the latest) so a late request of one is never granted */
const RETIRED_KEPT = 8;

export function retiredOf(row: HoldRow): string[] {
  try {
    const list = JSON.parse(row.retired ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const retire = (row: HoldRow, ...ids: (string | null)[]) =>
  JSON.stringify([...ids.filter((x): x is string => x !== null), ...retiredOf(row)].slice(0, RETIRED_KEPT));

export interface TurnAnswer {
  go: boolean;
  kind: TurnKind;
  attempt: string | null;
  reason?: Reason;
  wait_s?: number;
  state: SharedState;
}

const emptyRow = (provider: string): HoldRow => ({
  provider, version: 0, holder: null, holder_attempt: null, holder_until: null, pending_collector: null, pending_attempt: null,
  pending_kind: null, pending_since: null, rate_stage: 0, rate_until: null, denied: 0, denied_gen: 0, denied_since: null,
  result_attempt: null, retired: null,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const wholeIn = (v: unknown, low: number, high: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= low && v <= high;

/** One provider's entry of a body ({ "<provider>": {...} }), or null */
function single(body: unknown): [ProviderId, Record<string, unknown>] | null {
  if (!isObject(body)) return null;
  const entries = Object.entries(body);
  if (entries.length !== 1) return null;
  const [key, value] = entries[0]!;
  if (!PROVIDERS.includes(key as ProviderId) || !isObject(value)) return null;
  return [key as ProviderId, value];
}

/** A turn request: one provider, a known kind, an attempt id (none only for peek), a stop's generation for resume only */
export function parseTurnRequest(body: unknown): { provider: ProviderId; req: TurnRequest } | null {
  const one = single(body);
  if (!one) return null;
  const [provider, v] = one;
  const kind = v.kind as TurnKind;
  if (!KINDS.includes(kind)) return null;
  const attempt = v.attempt ?? null;
  if (kind === "peek" ? attempt !== null : typeof attempt !== "string" || !ATTEMPT.test(attempt)) return null;
  const gen = v.gen ?? null;
  if (kind === "resume" ? !wholeIn(gen, 1, Number.MAX_SAFE_INTEGER) : gen !== null) return null;
  const grantable = !["peek", "release"].includes(kind);
  const base = v.base ?? null;
  if (grantable ? !wholeIn(base, 0, Number.MAX_SAFE_INTEGER) : base !== null) return null;
  const replace = v.replace ?? null;
  if (replace !== null && (!["force", "resume"].includes(kind) || typeof replace !== "string" || !ATTEMPT.test(replace))) return null;
  const again = v.again ?? false;
  if (typeof again !== "boolean" || (again && !grantable)) return null;
  for (const k of Object.keys(v)) if (!["kind", "attempt", "gen", "base", "replace", "again"].includes(k)) return null;
  return {
    provider,
    req: { kind, attempt: attempt as string | null, gen: gen as number | null, base: base as number | null, replace: replace as string | null, again },
  };
}

/** A result report: one provider, the attempt id, a known outcome and the numbers in range */
export function parseResult(body: unknown): { provider: ProviderId; rep: ResultReport } | null {
  const one = single(body);
  if (!one) return null;
  const [provider, v] = one;
  const outcome = v.outcome as Outcome;
  if (!OUTCOMES.includes(outcome) || typeof v.attempt !== "string" || !ATTEMPT.test(v.attempt)) return null;
  const kind = v.kind as TurnKind;
  if (!KINDS.includes(kind) || ["peek", "release"].includes(kind)) return null;
  const retry = v.retry_s ?? null;
  if (retry !== null && !wholeIn(retry, 0, MAX_RETRY_S)) return null;
  if (!wholeIn(v.interval_s, 600, 86_400) || !wholeIn(v.minutes, 0, 1_440)) return null;
  for (const k of Object.keys(v)) if (!["attempt", "kind", "outcome", "retry_s", "interval_s", "minutes"].includes(k)) return null;
  return { provider, rep: { attempt: v.attempt, kind, outcome, retry_s: retry as number | null, interval_s: v.interval_s, minutes: v.minutes } };
}

const msLeft = (iso: string | null, now: number) => (iso === null ? 0 : Math.max(0, Date.parse(iso) - now));

/** The most a rate limit's wait is lengthened (a share of it): never shortened, so its retries keep no fixed rhythm */
export const RATE_JITTER = 0.2;

/**
 * The share (0 to RATE_JITTER) a rate limit's wait is lengthened by: from a hash of the PC, the provider and the attempt (FNV-1a,
 * then mixed so a change at the end moves every bit), so the same report always gets the same wait, and the attempt's identifier
 * (the agent's random one) keeps it from being foretold
 */
export function rateJitter(collector: string, provider: string, attempt: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${collector}|${provider}|${attempt}`) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return ((h >>> 0) / 0x1_0000_0000) * RATE_JITTER;
}
const iso = (ms: number) => new Date(ms).toISOString();

export function stateOf(row: HoldRow, now: number): SharedState {
  return {
    denied: row.denied === 1,
    denied_gen: row.denied_gen,
    rate_stage: row.rate_stage,
    rate_wait_s: Math.ceil(msLeft(row.rate_until, now) / 1000),
    version: row.version,
  };
}

/**
 * Decides a turn request on the row as read (pure). In order: a peek or release changes no grant; a resend of the attempt granted gets
 * the same go; a PC that can't deliver gets none; a stop holds every kind but a resume of that stop; another pending attempt holds every
 * kind (the user's force, or a resume of the same stop, replaces one left pending for PENDING_STUCK_MS); a rate limit holds every kind;
 * another PC's lease holds a fetch only, and only while that PC can deliver (`holderWritable`: one whose name could no longer be
 * registered would hold the others off for nothing). Otherwise the attempt is granted and marked pending
 */
export function decideTurn(
  row: HoldRow,
  collector: string,
  req: TurnRequest,
  now: number,
  writable: boolean,
  holderWritable = true,
): { answer: TurnAnswer; update?: Partial<HoldRow> } {
  const state = stateOf(row, now);
  const answer = (go: boolean, extra: Partial<TurnAnswer> = {}): TurnAnswer => ({ go, kind: req.kind, attempt: req.attempt, state, ...extra });
  if (req.kind === "peek") return { answer: answer(false) };
  if (req.kind === "release") {
    const mine = row.holder === collector && row.holder_attempt === req.attempt;
    return mine ? { answer: answer(false), update: { holder: null, holder_attempt: null, holder_until: null } } : { answer: answer(false) };
  }
  if (!writable) return { answer: answer(false, { reason: "unavailable" }) };
  // A refusal of a request asked again is kept (its id retired), so a late copy of it is never granted
  const refuse = (reason: Reason, extra: Partial<TurnAnswer> = {}) => ({
    answer: answer(false, { reason, ...extra }),
    ...(req.again && req.attempt !== null ? { update: { retired: retire(row, req.attempt) } } : {}),
  });
  // A resend of the attempt granted (its answer was lost): the same go, only for the same kind (and stop), and the 5 minutes before an
  // explicit recovery may replace it count again from now (the PC uses a go for 60 seconds from its arrival)
  if (row.pending_attempt === req.attempt && row.pending_collector === collector) {
    const same = row.pending_kind === req.kind && (req.kind !== "resume" || (row.denied === 1 && req.gen === row.denied_gen));
    return same ? { answer: answer(true), update: { pending_since: iso(now) } } : { answer: answer(false, { reason: "pending" }) };
  }
  // An attempt that ended or was replaced, asked for late: never granted again (its PC has moved on)
  if (req.attempt !== null && retiredOf(row).includes(req.attempt)) return { answer: answer(false, { reason: "pending" }) };
  // Made against another version of the row: it moved on since (a late copy, or a PC that hasn't seen the latest); asked again with a
  // new attempt against this one
  if (req.base !== row.version) return refuse("moved");
  // A replacement only of the attempt named, while it is pending (its result came, or it was replaced: nothing to replace)
  if (req.replace !== null && row.pending_attempt !== req.replace) return refuse("gone");
  if (row.denied === 1 && req.kind !== "resume") return refuse("access_denied");
  if (req.kind === "resume" && (row.denied !== 1 || req.gen !== row.denied_gen)) return refuse("stale_gen");
  if (row.pending_attempt !== null) {
    // Replaced only on the user's word for that attempt, once it is old enough
    const stuck = now - Date.parse(row.pending_since ?? "") >= PENDING_STUCK_MS;
    const recovers = (req.kind === "force" && row.denied !== 1) || (req.kind === "resume" && row.pending_kind === "resume");
    if (!(stuck && recovers && req.replace === row.pending_attempt)) return refuse("pending");
  }
  const rate = msLeft(row.rate_until, now);
  if (rate > 0) return refuse("rate_limited", { wait_s: Math.ceil(rate / 1000) });
  const lease = row.holder !== null && row.holder !== collector && holderWritable ? msLeft(row.holder_until, now) : 0;
  if (lease > 0 && req.kind === "fetch") return refuse("turn", { wait_s: Math.ceil(lease / 1000) });
  return {
    answer: answer(true),
    // One replaced (left pending, recovered by the user) is retired: a late result or request of it changes nothing
    update: {
      pending_collector: collector, pending_attempt: req.attempt, pending_kind: req.kind, pending_since: iso(now),
      ...(row.pending_attempt !== null ? { retired: retire(row, row.pending_attempt) } : {}),
    },
  };
}

/** What a result does to the shared stop shown on the public row */
export type Mark = "start" | "end" | null;

/**
 * Applies a result to the row as read (pure): only the pending attempt's, from its PC (otherwise nothing: a resend of one applied, or a
 * late one). Every result ends the pending attempt. A successful fetch takes or extends the lease; a failure hands the PC's lease back;
 * a rate limit moves its stage on and holds every PC (the lease goes); an access denial stops the provider (the lease goes); a
 * successful resume ends the stop
 */
export function applyResult(row: HoldRow, collector: string, rep: ResultReport, now: number): { update: Partial<HoldRow>; mark: Mark } | null {
  if (row.pending_attempt !== rep.attempt || row.pending_collector !== collector || row.pending_kind !== rep.kind) return null;
  const update: Partial<HoldRow> = { pending_collector: null, pending_attempt: null, pending_kind: null, pending_since: null, retired: retire(row, rep.attempt) };
  const noLease = { holder: null, holder_attempt: null, holder_until: null };
  let mark: Mark = null;
  switch (rep.outcome) {
    case "not_run":
      break;
    case "ok":
      Object.assign(update, { rate_stage: 0, rate_until: null });
      if (row.pending_kind === "resume" && row.denied === 1) {
        update.denied = 0;
        mark = "end";
      }
      if (row.pending_kind === "fetch") {
        const minutes = Math.min(rep.minutes, LEASE_MAX_MINUTES);
        Object.assign(update, minutes > 0
          ? { holder: collector, holder_attempt: rep.attempt, holder_until: iso(now + minutes * 60_000) }
          : row.holder === collector ? noLease : {});
      }
      break;
    case "failed":
      if (row.holder === collector) Object.assign(update, noLease);
      break;
    case "rate_limited": {
      const stage = Math.min(row.rate_stage + 1, RATE_STAGES_MIN.length);
      // The stage's wait, at least the interval and the wait the service named, then lengthened a little (never shortened, and never
      // past the longest wait a PC takes: a long one named is kept as it is)
      const wait = Math.max(RATE_STAGES_MIN[stage - 1]! * 60, rep.interval_s, rep.retry_s ?? 0);
      const jittered = Math.min(
        Math.round(wait * 1000 * (1 + rateJitter(collector, row.provider, rep.attempt))),
        Math.max(wait, MAX_RETRY_S) * 1000,
      );
      Object.assign(update, noLease, { rate_stage: stage, rate_until: iso(now + jittered) });
      break;
    }
    case "access_denied":
      Object.assign(update, noLease);
      if (row.denied !== 1) {
        Object.assign(update, { denied: 1, denied_gen: row.denied_gen + 1, denied_since: iso(now) });
        mark = "start";
      }
      break;
  }
  return { update, mark };
}

const changes = (result: unknown) => Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);

/** The provider's row (an empty one if it has none yet) */
export async function loadHold(db: D1Like, provider: ProviderId): Promise<HoldRow> {
  const row = await db.prepare("SELECT * FROM provider_holds WHERE provider = ?").bind(provider).first<HoldRow>();
  return row ?? emptyRow(provider);
}

/** Every column but the key, in a fixed order */
const COLUMNS = Object.keys(emptyRow("")).filter((k) => k !== "provider") as (keyof HoldRow)[];

/**
 * Writes the row read at `row.version` with `update` (its first write inserts it): only if no other request changed it since, and, for
 * a grant, only while `grantee` can deliver (decided in the same statement: a PC taking the last registrable name meanwhile wins)
 */
async function writeHold(db: D1Like, row: HoldRow, update: Partial<HoldRow>, grantee: string | null): Promise<boolean> {
  const next = { ...row, ...update, version: row.version + 1 };
  const may = grantee === null ? "1" : writableSql("?");
  const mayArgs = grantee === null ? [] : [grantee];
  const result = await db
    .prepare(
      `INSERT INTO provider_holds (provider, ${COLUMNS.join(", ")}) SELECT ?, ${COLUMNS.map(() => "?").join(", ")} WHERE ${may}
       ON CONFLICT (provider) DO UPDATE SET ${COLUMNS.map((k) => `${k} = excluded.${k}`).join(", ")}
       WHERE provider_holds.version = ?`,
    )
    .bind(row.provider, ...COLUMNS.map((k) => next[k]), ...mayArgs, row.version)
    .run();
  return changes(result) > 0;
}

/** A turn request, decided on the row read and written only if unchanged since (read again once on a race) */
export async function takeTurn(
  db: D1Like,
  collector: string,
  provider: ProviderId,
  req: TurnRequest,
  now: Date,
  writable: (name: string) => Promise<boolean>,
): Promise<TurnAnswer | null> {
  const at = now.getTime();
  for (let tries = 0; tries < 2; tries++) {
    const row = await loadHold(db, provider);
    // Whether a PC can deliver is read only where it decides: this PC's for a request that could be granted, the holder's for a fetch
    // its lease would hold off
    const grantable = !["peek", "release"].includes(req.kind) && !(row.pending_attempt === req.attempt && row.pending_collector === collector);
    const leased = req.kind === "fetch" && row.holder !== null && row.holder !== collector && msLeft(row.holder_until, at) > 0;
    const d = decideTurn(
      row,
      collector,
      req,
      at,
      grantable ? await writable(collector) : true,
      grantable && leased ? await writable(row.holder!) : true,
    );
    if (!d.update) return d.answer;
    if (await writeHold(db, row, d.update, d.answer.go ? collector : null)) {
      return { ...d.answer, state: { ...d.answer.state, version: row.version + 1 } };
    }
  }
  return null;
}

/** The fixed body of the event a stop makes (once per stop: its key carries the stop's generation) */
function deniedEvent(provider: ProviderId) {
  return {
    kind: "provider_error", provider, window_id: null, label: null, scope: null, cycle: null, threshold: null, used_percent: null,
    eta_minutes: null, resets_at: null, blocked: null, error_code: "access_denied", confirmed: null, confidence: null,
    status_text: "Access denied", last_received_at: null,
  };
}

/** An empty public body, for a stop marked before any PC's value was put */
const EMPTY_BODY = JSON.stringify({ schema_version: 2, generated_at: new Date(0).toISOString(), providers: {}, collectors: [] });

/**
 * A result: applied (in one batch) only to the pending attempt of this PC, on the row as read, and only if unchanged since. A stop's start
 * or end moves the global counter on and marks (or unmarks) the public row in the same batch, and a start records its event once (keyed
 * by the stop's generation). null: the row moved on meanwhile twice (the PC sends the result again)
 */
export async function reportResult(
  db: D1Like,
  collector: string,
  provider: ProviderId,
  rep: ResultReport,
  now: Date,
  writer: number,
): Promise<{ attempt: string; kind: TurnKind; applied: boolean; state: SharedState } | null> {
  const at = now.getTime();
  for (let tries = 0; tries < 2; tries++) {
    const row = await loadHold(db, provider);
    const applied = applyResult(row, collector, rep, at);
    if (!applied) return { attempt: rep.attempt, kind: rep.kind, applied: false, state: stateOf(row, at) };
    // This batch's own mark: its statements after the first follow only its own update (another batch that read the same row and
    // lost writes nothing more)
    const mark = `${rep.attempt}:${crypto.randomUUID()}`;
    const next = { ...row, ...applied.update, version: row.version + 1, result_attempt: mark };
    const ours = "EXISTS (SELECT 1 FROM provider_holds WHERE provider = ? AND version = ? AND result_attempt = ?)";
    const oursArgs = [provider, next.version, mark];
    const allVersion = "(SELECT version FROM data_versions WHERE provider = 'all')";
    const statements = [
      db
        .prepare(`UPDATE provider_holds SET ${COLUMNS.map((k) => `${k} = ?`).join(", ")}
          WHERE provider = ? AND version = ? AND pending_attempt = ? AND pending_collector = ?`)
        .bind(...COLUMNS.map((k) => next[k]), provider, row.version, rep.attempt, collector),
    ];
    if (applied.mark !== null) {
      // The counter moves on, so a client holding the body before takes the marked one as newer (the body is put again under a
      // newer counter by the next Cron's repair)
      statements.push(
        db
          .prepare(`INSERT INTO data_versions (provider, version) SELECT 'all', 1 WHERE ${ours}
            ON CONFLICT (provider) DO UPDATE SET version = data_versions.version + 1`)
          .bind(...oursArgs),
      );
    }
    if (applied.mark === "start") {
      const since = iso(at);
      statements.push(
        // Marked also before any PC's value was put (an empty body, so the stop shows)
        db
          .prepare(`INSERT INTO public_state (id, version, body, writer, current_version, holds)
            SELECT 1, 0, ?, ?, ${allVersion}, json_object(?, json_object('since', ?, 'gen', ?)) WHERE ${ours}
            ON CONFLICT (id) DO UPDATE SET current_version = ${allVersion}, writer = excluded.writer,
              holds = json_set(coalesce(public_state.holds, '{}'), '$.${provider}', json_object('since', ?, 'gen', ?))`)
          .bind(EMPTY_BODY, writer, provider, since, next.denied_gen, ...oursArgs, since, next.denied_gen),
        db
          .prepare(`INSERT OR IGNORE INTO events (key, visible, created_at, keep_until, body) SELECT ?, 1, ?, ?, ? WHERE ${ours}`)
          .bind(`access_denied:${provider}:${next.denied_gen}`, since, iso(at + EVENT_RETENTION_MS), JSON.stringify(deniedEvent(provider)), ...oursArgs),
      );
    } else if (applied.mark === "end") {
      statements.push(
        db
          .prepare(`UPDATE public_state SET current_version = ${allVersion}, writer = ?, holds = json_remove(coalesce(holds, '{}'), '$.${provider}')
            WHERE id = 1 AND ${ours}`)
          .bind(writer, ...oursArgs),
      );
    }
    const results = await db.batch(statements);
    if (changes(results[0]) > 0) return { attempt: rep.attempt, kind: rep.kind, applied: true, state: stateOf(next, at) };
    // Lost to another request of the same row: read again (a resend of this result is then "not pending")
  }
  return null;
}

/** The stops marked on the public row (provider -> since, gen) */
export type Holds = Partial<Record<ProviderId, { since: string; gen: number }>>;
