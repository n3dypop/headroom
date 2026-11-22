// For tests: reproduces the parts of D1 we use with Node's built-in SQLite (production D1 is SQLite too).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like, D1Statement } from "../src/store.ts";

/**
 * `strict`: meta counts as production D1 does, pessimistically: rows read are the rows each step of the query plan may scan (a whole
 * table for a scan, one row for a search by key; also for statements that write), and rows written count every index of the table too
 */
export function sqliteD1(opts: { strict?: boolean } = {}): { db: D1Like; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const count = (table: string) => {
    try {
      return (raw.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }).c;
    } catch {
      // not a table (an alias): counted as large, so a test notices
      return 1_000;
    }
  };
  // The longest list of values a statement looks keys up in (`IN (?, ?)`): a search by key reads one row for each
  const keysLooked = (sql: string) =>
    Math.max(1, ...[...sql.matchAll(/\bIN\s*\(([^()]*)\)/gi)].filter((m) => /^\s*\?(\s*,\s*\?)*\s*$/.test(m[1]!)).map((m) => m[1]!.split(",").length));
  const scanned = (sql: string, params: SQLInputValue[]) => {
    if (!opts.strict) return 0;
    let n = 0;
    for (const row of raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]) {
      const scan = /^SCAN (\w+)/.exec(row.detail);
      const search = /^SEARCH (\w+)/.exec(row.detail);
      if (scan && scan[1] !== "CONSTANT") n += count(scan[1]!);
      // A search by equality on a key reads one row for each key looked up; one over a range may read the whole table (counted so)
      else if (search) n += /[<>]/.test(row.detail) ? count(search[1]!) : keysLooked(sql);
    }
    return n;
  };
  // An insert into a table with AUTOINCREMENT may write its counter (sqlite_sequence), also when the row itself is ignored
  const sequence = (table: string) => {
    try {
      return (raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined)?.seq ?? null;
    } catch {
      return null;
    }
  };
  const insertTable = (sql: string) => /^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)/i.exec(sql)?.[1];
  // D1 counts a write to each index whose columns the write includes (an insert or a delete: every index; an update: the ones over a
  // column it sets). https://developers.cloudflare.com/d1/platform/pricing/
  const written = (sql: string, changes: number) => {
    if (!opts.strict || changes === 0) return changes;
    const m = /^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/i.exec(sql);
    if (!m) return changes;
    const table = m[2]!;
    const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as { name: string }[]).map((r) => r.name);
    let touched = names.length;
    if (/^UPDATE/i.test(m[1]!)) {
      const set = /\bSET\s+([\s\S]+?)(?:\s+WHERE\b|$)/i.exec(sql)?.[1] ?? "";
      const columns = new Set([...set.matchAll(/(\w+)\s*=/g)].map((c) => c[1]!.toLowerCase()));
      touched = names.filter((name) =>
        (raw.prepare(`PRAGMA index_info("${name}")`).all() as { name: string | null }[]).some(
          (c) => c.name !== null && columns.has(c.name.toLowerCase()),
        ),
      ).length;
    }
    return changes * (1 + touched);
  };
  const statement = (sql: string, params: SQLInputValue[] = []): D1Statement => ({
    bind: (...values: unknown[]) => statement(sql, values as SQLInputValue[]),
    // Mimics D1's meta (writes: changed rows; reads: returned rows. Production counts scanned rows: see `strict`)
    run: async () => {
      const reads = scanned(sql, params);
      const table = opts.strict ? insertTable(sql) : undefined;
      const seqBefore = table === undefined ? null : sequence(table);
      const r = raw.prepare(sql).run(...params);
      const counter = table !== undefined && sequence(table) !== seqBefore ? 1 : 0;
      return { ...r, meta: { rows_read: reads, rows_written: written(sql, Number(r.changes)) + counter, changes: Number(r.changes) } };
    },
    all: async <T>() => {
      const reads = scanned(sql, params);
      const results = raw.prepare(sql).all(...params) as T[];
      return { results, meta: { rows_read: Math.max(results.length, reads), rows_written: 0 } };
    },
    first: async <T>() => (raw.prepare(sql).get(...params) as T | undefined) ?? null,
  });
  let queue: Promise<unknown> = Promise.resolve();
  const db: D1Like = {
    prepare: (sql) => statement(sql),
    // Like D1, batches run one at a time in order, each in one transaction (never overlapping even if called concurrently)
    batch: (statements) => {
      const run = async () => {
        raw.exec("BEGIN");
        try {
          const out = [];
          for (const s of statements) out.push(await s.run());
          raw.exec("COMMIT");
          return out;
        } catch (e) {
          raw.exec("ROLLBACK");
          throw e;
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
  return { db, raw };
}
