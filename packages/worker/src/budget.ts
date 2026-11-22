// Keeps D1 usage strictly within the free tier.
//
// The D1 free tier is 5M rows read and 100k rows written per UTC day (counted as scanned rows; index updates count as writes).
// Exceeding it disables D1 until 00:00 UTC, so we operate so as never to exceed it:
// - Client reads (GET) only read rows prepared at upload time (at most 3 rows per request). The Workers free tier is 100k requests/day,
//   so GET reads at most 300k D1 rows a day. GET is not metered (metering would need writes)
// - Everything else (uploads from PCs, the fetch turn, Cron) first reserves the per-run maximum (RESERVE) from the per-UTC-day d1_budget
//   in one statement (if it doesn't fit, refuse without touching D1), then settles with the actual row counts D1 returns (meta.rows_read / rows_written)
// - The write side may use 4M rows read and 80k rows written (excluding GET's 300k rows and a margin)
// - The free tier is per Cloudflare account, while each D1 keeps its own d1_budget. When one account has more than one Headroom D1
//   (e.g. a test D1 next to the real one), give each a share with D1_BUDGET_PERCENT so the shares add up to 100 or less.
//   GET needs no share: the Workers request limit (100k a day) is per account as well

import type { D1Like, D1Statement } from "./store.ts";

export interface Usage {
  reads: number;
  writes: number;
}

/** Metered usage, and whether a failure with unknown outcome occurred (if so, the reserved amount is not returned) */
export interface Metered extends Usage {
  uncertain: boolean;
}

/** Daily amount the write side (uploads, turn, Cron) may use */
export const DAILY_BUDGET: Usage = { reads: 4_000_000, writes: 80_000 };

/** Smallest share at which every metered run (an upload, a turn and a Cron run) fits in the day's budget */
export const MIN_BUDGET_PERCENT = 13;

/**
 * This deployment's share of DAILY_BUDGET from D1_BUDGET_PERCENT: a whole number 1-100 (a string, or a number when wrangler.toml
 * gives one), unset or empty for 100. Any other value gives no budget (every metered run is refused), so a typo never lets the
 * account go over the free tier. Below MIN_BUDGET_PERCENT the Cron run never fits
 */
export function budgetLimit(percent: unknown): Usage {
  if (percent === undefined) return DAILY_BUDGET;
  const text = typeof percent === "number" ? String(percent) : typeof percent === "string" ? percent.trim() : "x";
  if (text === "") return DAILY_BUDGET;
  const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  if (!(n >= 1 && n <= 100)) return { reads: 0, writes: 0 };
  return { reads: Math.floor((DAILY_BUDGET.reads * n) / 100), writes: Math.floor((DAILY_BUDGET.writes * n) / 100) };
}

/** Estimated maximum per run. If less than this remains, don't start (never cross the limit mid-run) */
export const RESERVE = {
  put: { reads: 5_000, writes: 1_500 },
  // OVERHEAD_MAX and the turn's own statements (at most 9 reads and 9 writes as D1 counts them)
  turn: { reads: 50, writes: 30 },
  // Max writes is CRON_WRITE_BOUND (deleting observations and events, recording events with the max number of windows; includes index updates)
  cron: { reads: 25_000, writes: 10_000 },
} satisfies Record<string, Usage>;

/** D1 returns no row count for first(), so count the estimated rows for reading one row by primary key */
const FIRST_READS = 2;

interface Meta {
  meta?: { rows_read?: number; rows_written?: number };
}

function add(usage: Usage, result: unknown, fallbackReads = 0): void {
  const meta = (result as Meta | null)?.meta;
  usage.reads += Math.max(Number(meta?.rows_read ?? 0), fallbackReads);
  usage.writes += Number(meta?.rows_written ?? 0);
}

type Wrapped = D1Statement & { inner: D1Statement };

/** Aborted without starting a D1 statement because the reserved day has passed (no budget reserved for that day) */
export class BudgetDeadline extends Error {}

/** Deadline: no D1 statement is started after this time */
interface Deadline {
  clock: () => Date;
  until: number;
}

function check(deadline: Deadline | undefined): void {
  if (deadline && deadline.clock().getTime() >= deadline.until) throw new BudgetDeadline();
}

/** Calls D1. On failure, whether it ran and how much it used are unknown, so mark it and rethrow */
async function call<T>(usage: Metered, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    usage.uncertain = true;
    throw e;
  }
}

function wrap(st: D1Statement, usage: Metered, deadline?: Deadline): Wrapped {
  return {
    inner: st,
    bind: (...values: unknown[]) => wrap(st.bind(...values), usage, deadline),
    run: async () => {
      check(deadline);
      const result = await call(usage, () => st.run());
      add(usage, result);
      return result;
    },
    all: async <T>() => {
      check(deadline);
      const result = await call(usage, () => st.all<T>());
      add(usage, result, result.results.length);
      return result;
    },
    first: async <T>() => {
      check(deadline);
      const row = await call(usage, () => st.first<T>());
      usage.reads += FIRST_READS;
      return row;
    },
  };
}

/**
 * Wrapper that meters D1 usage, accumulating it into usage. With `deadline`, a statement started after that time
 * is not run and BudgetDeadline is thrown (HTTP handling has no run-time limit, so D1 must not be used on an unreserved day)
 */
export function metered(db: D1Like, deadline?: Deadline): { db: D1Like; usage: Metered } {
  const usage: Metered = { reads: 0, writes: 0, uncertain: false };
  return {
    usage,
    db: {
      prepare: (sql) => wrap(db.prepare(sql), usage, deadline),
      batch: async (statements) => {
        check(deadline);
        const results = await call(usage, () => db.batch(statements.map((s) => (s as Partial<Wrapped>).inner ?? s)));
        for (const r of results) add(usage, r);
        return results;
      },
    },
  };
}

/**
 * Latest time a D1 statement may start: 60 seconds before the last reserved day (`days`) ends. D1 aborts a statement or batch
 * after 30 seconds, so a statement started by then finishes within the reserved days (no day boundary crossed while waiting or running).
 * [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
 */
export const STATEMENT_GUARD_MS = 60_000;

export function endOfDays(days: readonly string[]): number {
  return Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000 - STATEMENT_GUARD_MS;
}

export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

const changes = (result: unknown) =>
  Number((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0);

/** The most one settle statement uses: a d1_budget row read and written by its key, and that key's index entry */
const SETTLE_STATEMENT: Usage = { reads: 2, writes: 2 };
/**
 * The most the reserve and settle statements use together, as D1 counts them (index writes included). The reserve statement's own
 * usage is measured and settled; at most 9 reads and 12 writes (two new day rows, and the three rows an earlier two-day reservation
 * kept deleted). Settle counts SETTLE_STATEMENT for each of its statements: three at most (a run that ends past its one reserved day).
 * A run's own statements may use its reservation less this
 */
export const OVERHEAD_MAX: Usage = { reads: 16, writes: 16 };
/** Max time one run can take (Cron's 15-minute limit). If 00:00 UTC is closer than this, also reserve for the next day */
export const MAX_RUN_MS = 15 * 60_000;

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const previousDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** UTC days a run starting at this time may use (also the next day just before 00:00 UTC) */
export function daysToReserve(at: Date): string[] {
  const day = utcDay(at);
  return Date.parse(`${nextDay(day)}T00:00:00Z`) - at.getTime() < MAX_RUN_MS ? [day, nextDay(day)] : [day];
}

/**
 * Reserves the per-run maximum up front from the budget of the days the run may use (`days`). The limit is d1_budget's CHECK
 * constraint; an addition over the limit rolls back the whole transaction. Check and reservation are one transaction, so concurrent
 * requests can't use the same remainder, and never only one of two days gets reserved. If it doesn't fit, it fails (touching D1 only for this check)
 */
export type Reservation = "reserved" | "exhausted" | "unavailable";

export async function reserve(
  db: D1Like,
  days: readonly string[],
  amount: Usage,
  limit: Usage = DAILY_BUDGET,
): Promise<Reservation> {
  const placeholders = days.map(() => "?").join(", ");
  try {
    const results = await db.batch([
      ...days.map((day) => db.prepare("INSERT OR IGNORE INTO d1_budget (day, reads, writes) VALUES (?, 0, 0)").bind(day)),
      // All days or none: nothing is added if any day would go over this deployment's share (the CHECK constraint is the hard limit)
      db
        .prepare(
          `UPDATE d1_budget SET reads = reads + ?, writes = writes + ? WHERE day IN (${placeholders}) AND NOT EXISTS (` +
            `SELECT 1 FROM d1_budget WHERE day IN (${placeholders}) AND (reads + ? > ? OR writes + ? > ?))`,
        )
        .bind(amount.reads, amount.writes, ...days, ...days, amount.reads, limit.reads, amount.writes, limit.writes),
      // Keep the previous day's row for one day (settlement target for runs that end after the day boundary)
      db.prepare("DELETE FROM d1_budget WHERE day < ?").bind(previousDay(days[0]!)),
    ]);
    const updated = changes(results[days.length]);
    return updated === days.length ? "reserved" : updated === 0 ? "exhausted" : "unavailable";
  } catch (e) {
    // Over the limit (CHECK constraint) means budget exhausted. Anything else (e.g. a transient D1 failure) is kept distinct
    return /CHECK constraint failed/i.test(String((e as Error)?.message ?? e)) ? "exhausted" : "unavailable";
  }
}

/**
 * Corrects the reserved amount to the actual usage (`used`: the run's statements and the reserve statement, as measured; settle's own
 * statements are added here). Reserved days up to the day the run
 * ended get the actual amount; days not yet reached get 0 (the reservation is returned). If the end day was not reserved, it gets the full amount too.
 * The D1 free tier counts by execution day, so a run spanning days is counted in full on both (never underestimate).
 * The reservation is the per-run maximum so this normally won't exceed it, but cap at the limit anyway (so the constraint never fails settlement)
 */
export async function settle(
  db: D1Like,
  days: readonly string[],
  reserved: Usage,
  used: Usage & { uncertain?: boolean },
  endedAt: Date,
): Promise<void> {
  // After a failure with unknown outcome, count no less than the reservation (don't return what may have run)
  const floor = used.uncertain ? reserved : { reads: 0, writes: 0 };
  // The settle batch runs a moment after this time was read: the day it may run in is counted too, never only the day before
  const end = utcDay(new Date(endedAt.getTime() + STATEMENT_GUARD_MS));
  // Settle's own statements: one for each reserved day, two more for an end day not reserved
  const own = days.length + (days.includes(end) ? 0 : 2);
  const reads = Math.ceil(Math.max(used.reads + own * SETTLE_STATEMENT.reads, floor.reads));
  const writes = Math.ceil(Math.max(used.writes + own * SETTLE_STATEMENT.writes, floor.writes));
  const adjust = (day: string, r: number, w: number) =>
    db
      .prepare(
        `UPDATE d1_budget SET reads = max(0, min(?, reads + ?)), writes = max(0, min(?, writes + ?)) WHERE day = ?`,
      )
      .bind(DAILY_BUDGET.reads, r, DAILY_BUDGET.writes, w, day);
  const statements = days.map((day) =>
    day <= end ? adjust(day, reads - reserved.reads, writes - reserved.writes) : adjust(day, -reserved.reads, -reserved.writes));
  if (!days.includes(end)) {
    statements.push(
      db.prepare("INSERT OR IGNORE INTO d1_budget (day, reads, writes) VALUES (?, 0, 0)").bind(end),
      adjust(end, reads, writes),
    );
  }
  await db.batch(statements);
}

/** Seconds until 00:00 UTC */
export function secondsUntilReset(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * The wait (seconds) told with a refusal due to the limit: until 00:00 UTC, at most MAX_RUN_MS. A refusal may come from other runs'
 * reservations, not from the day's use: a run gives the unused part back when it settles, and runs for MAX_RUN_MS at most. The PC
 * asks again after that wait, never after the reset
 */
export function budgetRetrySeconds(now: Date): number {
  return Math.min(secondsUntilReset(now), MAX_RUN_MS / 1000);
}
