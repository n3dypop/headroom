// For tests: reproduces the parts of D1 we use with Node's built-in SQLite (production D1 is SQLite too).
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like, D1Statement } from "../src/store.ts";

export function sqliteD1(): { db: D1Like; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const statement = (sql: string, params: SQLInputValue[] = []): D1Statement => ({
    bind: (...values: unknown[]) => statement(sql, values as SQLInputValue[]),
    // Mimics D1's meta (writes: changed rows; reads: returned rows. Production counts scanned rows)
    run: async () => {
      const r = raw.prepare(sql).run(...params);
      return { ...r, meta: { rows_read: 0, rows_written: Number(r.changes), changes: Number(r.changes) } };
    },
    all: async <T>() => {
      const results = raw.prepare(sql).all(...params) as T[];
      return { results, meta: { rows_read: results.length, rows_written: 0 } };
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
