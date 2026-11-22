// The examples agreed for Gemini (three providers): what the Worker stores, serves and judges
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Snapshot } from "../../core/src/index.ts";
import { AGENT_PROTOCOL, sha256Hex } from "../src/auth.ts";
import { handle as handleRequest, judge, refreshDerived, runCron, type Env } from "../src/index.ts";
import { DERIVED_PUBLIC_SQL, saveDerived, type D1Like } from "../src/store.ts";
import { sqliteD1 } from "./d1-sqlite.ts";

const READ = "read-token-for-iphone-0123456789";
const WIN = "write-token-for-win-0123456789ab";
const MAC = "write-token-for-mac-0123456789ab";
const NOW = new Date("2026-11-16T13:00:00.000Z");
const RESET_5H = "2026-11-16T16:00:00.000Z";
const RESET_7D = "2026-11-20T00:00:00.000Z";

const fixture = (): Snapshot =>
  JSON.parse(readFileSync(new URL("../../../fixtures/snapshot/v2-basic.json", import.meta.url), "utf8"));

async function setup() {
  const { db, raw } = sqliteD1();
  const tokens = [
    { name: "iphone", sha256: await sha256Hex(READ), role: "read" },
    { name: "win-desktop", sha256: await sha256Hex(WIN), role: "write", collector: "win-desktop" },
    { name: "mac", sha256: await sha256Hex(MAC), role: "write", collector: "mac" },
  ];
  const env: Env = { DB: db, TOKENS: JSON.stringify(tokens), COLLECTOR_PRIORITY: "win-desktop", ALLOWED_HOST: "headroom.example" };
  const call = (method: string, path: string, token?: string, body?: unknown, at = NOW) => {
    const request = new Request(`https://headroom.example${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(sentAt(body, at)),
    });
    request.headers.set("headroom-protocol", AGENT_PROTOCOL);
    return handleRequest(request, env, () => at);
  };
  return { raw, db, call, env };
}

function sentAt(body: unknown, at: Date): unknown {
  if (typeof body !== "object" || body === null || !("snapshot" in body)) return body;
  const b = body as { snapshot: Snapshot };
  return { ...b, snapshot: { ...b.snapshot, generated_at: at.toISOString() } };
}

const win = (id: string, used: number, scope: string | null, resets = id.includes("five") ? RESET_5H : RESET_7D, fetched = NOW.toISOString()) => ({
  id, label: id, kind: id.includes("five") ? "session" : "weekly", scope, used_percent: used, resets_at: resets, fetched_at: fetched,
});

/** Claude and Codex from the shared fixture, and Gemini with the given windows */
function withGemini(windows: ReturnType<typeof win>[], blocked: boolean | null = false, history_since: string | null = null): Snapshot {
  const s = fixture();
  s.providers.gemini = {
    status: "ok", fetched_at: NOW.toISOString(), collector: null, error: null, error_code: null, plan: "pro", blocked, history_since, windows,
  } as Snapshot["providers"]["claude"] & object;
  return s;
}

const upload = (seq: number, snapshot: Snapshot, observations: unknown[] = []) => ({ seq, snapshot, observations });
const obs = (provider: string, window_id: string, used_percent: number, observed_at = NOW.toISOString(), resets_at = RESET_5H) =>
  ({ provider, window_id, used_percent, observed_at, resets_at });

async function view(call: Awaited<ReturnType<typeof setup>>["call"], at = NOW) {
  return (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as Record<string, any>;
}

async function events(call: Awaited<ReturnType<typeof setup>>["call"], at = NOW) {
  return ((await (await call("GET", "/v2/events", READ, undefined, at)).json()) as { events: Record<string, any>[] }).events;
}

test("f: a mixed PUT stores Gemini's own names, and another provider's window or observation with them is left out", async () => {
  const { call, raw } = await setup();
  const s = withGemini([win("five_hour", 10, null), win("seven_day_argon", 20, "Argon"), win("partner_five_hour", 30, "Claude and GPT")]);
  s.providers.codex!.windows.push(win("partner_five_hour", 5, "Claude and GPT") as never);
  s.providers.claude!.windows.push(win("seven_day_argon", 5, "Argon") as never);
  const res = await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s, [
    obs("gemini", "seven_day_argon", 20), obs("gemini", "partner_five_hour", 30),
    obs("codex", "partner_five_hour", 5), obs("claude", "seven_day_argon", 5), obs("claude", "five_hour", 12),
  ]));
  assert.equal(res.status, 204);
  const rows = raw.prepare("SELECT provider, window_id FROM observations ORDER BY provider, window_id").all() as { provider: string; window_id: string }[];
  assert.deepEqual(rows.map((r) => `${r.provider}.${r.window_id}`), ["claude.five_hour", "gemini.partner_five_hour", "gemini.seven_day_argon"]);
  const v = await view(call);
  assert.deepEqual(Object.keys(v.gemini.windows).sort(), ["five_hour", "partner_five_hour", "seven_day_argon"]);
  assert.equal(v.gemini.windows.seven_day_argon.scope, "Argon");
  assert.equal("partner_five_hour" in v.codex.windows, false);
  assert.equal("seven_day_argon" in v.claude.windows, false);
  // a resend of observations whose windows aren't in the value (stamped before the send): the same rule, the others are saved
  const resend = withGemini([win("five_hour", 10, null)]);
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, resend, [
    obs("codex", "partner_five_hour", 6, "2026-11-16T12:59:30.000Z"), obs("codex", "seven_day", 6, "2026-11-16T12:59:30.000Z", RESET_7D),
    obs("gemini", "partner_seven_day", 7, "2026-11-16T12:59:30.000Z", RESET_7D),
  ]))).status, 204);
  const codex = raw.prepare("SELECT window_id FROM observations WHERE provider = 'codex'").all() as { window_id: string }[];
  assert.deepEqual(codex.map((r) => r.window_id), ["seven_day"], "the valid one saved, the refused name not");
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations WHERE provider = 'gemini' AND window_id = 'partner_seven_day'").get() as { n: number }).n, 1);
});

test("a: a limit shown in details only is kept in the details but is never the top window, in summaries or events", async () => {
  const { call, env } = await setup();
  const s = withGemini([win("five_hour", 40, null), win("seven_day", 20, null), win("partner_five_hour", 100, "Claude and GPT")]);
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s, [obs("gemini", "partner_five_hour", 100)]));
  await runCron(env, NOW);
  const v = await view(call);
  assert.equal(v.gemini.top.id, "five_hour");
  assert.equal(v.gemini.windows.partner_five_hour.detail_only, true);
  assert.equal(v.gemini.windows.five_hour.detail_only, false);
  assert.equal(v.gemini.main_window_ids, "five_hour,seven_day");
  assert.equal(v.gemini.summary.includes("Claude and GPT"), false);
  assert.equal(v.summary.includes("Gemini"), true);
  assert.equal((await events(call)).filter((e) => e.provider === "gemini").length, 0, "no event of the partner limit");
});

test("b: a reached Gemini model limit (Argon) is told once, as Fable is", async () => {
  const { call, env } = await setup();
  const s = withGemini([win("five_hour", 10, null), win("seven_day", 20, null), win("seven_day_argon", 100, "Argon")]);
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s, [obs("gemini", "seven_day_argon", 100, NOW.toISOString(), RESET_7D)]));
  await runCron(env, NOW);
  const limits = (await events(call)).filter((e) => e.provider === "gemini" && e.kind === "limit");
  assert.equal(limits.length, 1);
  assert.equal(limits[0]!.window_id, "seven_day_argon");
  assert.equal((await view(call)).gemini.blocked, false);
  await runCron(env, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal((await events(call)).filter((e) => e.provider === "gemini" && e.kind === "limit").length, 1, "not told again");
});

test("c: Gemini's limit flag without an overall window behind it is unknown, not reached", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withGemini([win("partner_five_hour", 100, "Claude and GPT")], true)));
  await runCron(env, NOW);
  const v = await view(call);
  assert.equal(v.gemini.top, null);
  assert.equal(v.gemini.blocked, null);
  assert.equal((await events(call)).filter((e) => e.provider === "gemini").length, 0, "no windowless limit");
  const later = new Date(NOW.getTime() + 60_000).toISOString();
  const paths: [string, ReturnType<typeof win>[]][] = [
    ["with no window at all", []],
    // stamped after the send: dropped by the Worker
    ["the overall window dropped", [win("five_hour", 100, null, RESET_5H, later), win("partner_five_hour", 100, "Claude and GPT")]],
    ["every window dropped, the fetch time left", [win("five_hour", 100, null, RESET_5H, later), win("seven_day", 100, null, RESET_7D, later)]],
  ];
  // through an accepted account's boundary: the overall window fetched before it (the account before), the partner's after
  {
    const { call: c3, env: e3 } = await setup();
    const before = new Date(NOW.getTime() - 30 * 60_000).toISOString();
    const accepted = new Date(NOW.getTime() - 20 * 60_000).toISOString();
    const s = withGemini([win("five_hour", 100, null, RESET_5H, before), win("partner_five_hour", 100, "Claude and GPT")], true, accepted);
    assert.equal((await c3("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s))).status, 204);
    await runCron(e3, NOW);
    const v3 = await view(c3);
    assert.deepEqual(Object.keys(v3.gemini.windows), ["partner_five_hour"], "the window before the boundary is dropped");
    assert.equal(v3.gemini.top, null);
    assert.equal(v3.gemini.blocked, null, "the boundary path");
    assert.equal((await events(c3)).filter((e) => e.provider === "gemini" && e.kind === "limit").length, 0);
  }
  for (const [label, windows] of paths) {
    const { call: c2, env: e2 } = await setup();
    assert.equal((await c2("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withGemini(windows, true)))).status, 204, label);
    await runCron(e2, NOW);
    const v2 = await view(c2);
    assert.equal(v2.gemini.top, null, label);
    assert.equal(v2.gemini.blocked, null, label);
    assert.equal((await events(c2)).filter((e) => e.provider === "gemini" && e.kind === "limit").length, 0, `${label}: no windowless limit`);
  }
});

test("e: a public row of two providers is served as before, with Gemini absent and its boundary known as none", async () => {
  const { call, env, raw } = await setup();
  // A value of two providers with Claude past 80% and Codex at its limit, judged once (as by a Worker of two providers)
  const two = fixture();
  two.providers.claude!.windows = two.providers.claude!.windows.map((w) => (w.id === "five_hour" ? { ...w, used_percent: 85 } : w));
  two.providers.codex!.blocked = true;
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, two))).status, 204);
  await runCron(env, NOW);
  const before = await events(call);
  assert.ok(before.length >= 2, JSON.stringify(before));
  // The judgment state and the public row in the shape of two providers (no Gemini key anywhere)
  const state = JSON.parse((raw.prepare("SELECT body FROM event_state WHERE id = 1").get() as { body: string }).body);
  for (const k of ["errors", "blocked", "boundaries", "switches"]) if (state[k]) delete state[k].gemini;
  state.boundaries = { claude: "", codex: "" };
  raw.prepare("UPDATE event_state SET body = ? WHERE id = 1").run(JSON.stringify(state));
  raw.prepare("UPDATE public_state SET boundaries = ?, current_boundaries = ? WHERE id = 1").run("{}", "{}");
  const v = await view(call);
  assert.equal(v.gemini, null);
  assert.equal(v.boundaries.gemini, "");
  assert.notEqual(v.claude, null);
  assert.notEqual(v.codex, null);
  // The first Cron of this Worker tells nothing again, and Claude and Codex read as they did
  const at = new Date(NOW.getTime() + 5 * 60_000);
  const shown = async () => { const x = await view(call, at); return JSON.stringify([x.claude, x.codex]); };
  const was = await shown();
  await runCron(env, at);
  assert.deepEqual((await events(call, at)).map((e) => e.seq), before.map((e) => e.seq), "nothing told again");
  assert.equal(await shown(), was);
});

test("g: GET reads three rows by primary key whatever the number of providers, and serves every provider's derived values", async () => {
  const { call, env, raw, db } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withGemini([win("five_hour", 10, null)]), [
    // Claude's 5-hour climbs to its 10% (at 12:59:30) faster than Gemini's to its 10% (at 13:00)
    obs("claude", "five_hour", 2, "2026-11-16T12:46:00.000Z"), obs("claude", "five_hour", 6, "2026-11-16T12:52:00.000Z"),
    obs("gemini", "five_hour", 7, "2026-11-16T12:46:00.000Z"), obs("gemini", "five_hour", 8.5, "2026-11-16T12:52:00.000Z"),
    // Codex's weekly climbs to its value too (its 5-hour isn't in the fixture)
    obs("codex", "seven_day", 30, "2026-11-16T12:46:00.000Z", "2026-11-20T10:51:04.000Z"), obs("codex", "seven_day", 35, "2026-11-16T12:52:00.000Z", "2026-11-20T10:51:04.000Z"),
  ]));
  await runCron(env, NOW);
  const derived = raw.prepare("SELECT provider FROM derived_metrics ORDER BY provider").all() as { provider: string }[];
  assert.deepEqual(derived.map((r) => r.provider), ["claude", "codex", "gemini"]);
  // the SQL the GET ran
  const seen: string[] = [];
  const wrapped: D1Like = { ...db, prepare: (sql: string) => { seen.push(sql); return db.prepare(sql); } } as D1Like;
  (env as { DB: D1Like }).DB = wrapped;
  const v = await view(call);
  const rates = [v.claude.windows.five_hour.rate_60m, v.gemini.windows.five_hour.rate_60m, v.codex.windows.seven_day.rate_60m];
  assert.ok(rates.every((r) => typeof r === "number" && r > 0), JSON.stringify(rates));
  assert.equal(new Set(rates).size, 3, `each provider's own: ${JSON.stringify(rates)}`);
  const reads = seen.filter((q) => /^\s*SELECT/i.test(q) && /public_state/.test(q));
  assert.equal(reads.length, 1);
  const plan = raw.prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all() as { detail: string }[];
  const details = plan.map((p) => p.detail);
  assert.equal(details.some((d) => /^SCAN/.test(d)), false, details.join(" | "));
  assert.equal(details.filter((d) => /^SEARCH .*(INTEGER PRIMARY KEY|PRIMARY KEY)/.test(d)).length, 3, details.join(" | "));
});

test("the read endpoint's row holds only what is stored for the current generation (overlapping saves, a moved generation)", async () => {
  const { raw, db } = sqliteD1();
  const generation = (raw.prepare("SELECT generation FROM data_generation WHERE id = 1").get() as { generation: number }).generation;
  // two providers saved by different runs: both stay
  await saveDerived(db, "claude", { five_hour: { fetched_at: null, resets_at: null, used_percent: 1, metrics: {} as never } }, 1, NOW, "", null, 0, generation);
  await saveDerived(db, "gemini", { five_hour: { fetched_at: null, resets_at: null, used_percent: 2, metrics: {} as never } }, 1, NOW, "", null, 0, generation);
  const body = () => JSON.parse((raw.prepare("SELECT body FROM derived_public WHERE id = 1").get() as { body: string }).body) as { provider: string }[];
  assert.deepEqual(body().map((r) => r.provider).sort(), ["claude", "gemini"]);
  const served = () => (raw.prepare(`SELECT (SELECT CASE WHEN x.generation = g.generation THEN x.body END FROM derived_public x, data_generation g WHERE x.id = 1 AND g.id = 1) AS d`).get() as { d: string | null }).d;
  // the generation moved on (the cleanup): the row of the generation before isn't served, before anything is computed again
  raw.exec("UPDATE data_generation SET generation = generation + 1 WHERE id = 1");
  assert.equal(served(), null);
  // a late save of the generation before isn't stored; the row is rebuilt from what the new generation has (nothing yet)
  await saveDerived(db, "codex", { five_hour: { fetched_at: null, resets_at: null, used_percent: 3, metrics: {} as never } }, 1, NOW, "", null, 0, generation);
  assert.deepEqual(body(), []);
  assert.equal(served(), "[]");
  // one provider computed in the new generation: only that one
  await saveDerived(db, "gemini", { five_hour: { fetched_at: null, resets_at: null, used_percent: 4, metrics: {} as never } }, 2, NOW, "", null, 0, generation + 1);
  assert.deepEqual(body().map((r) => r.provider), ["gemini"]);
  raw.exec(DERIVED_PUBLIC_SQL);
  assert.deepEqual(body().map((r) => r.provider), ["gemini"]);
});

test("the Worker waits for a window's derived values, but not for a window shown in details only", async () => {
  const { call, env, db, raw } = await setup();
  const s = withGemini([win("seven_day", 20, null), win("seven_day_argon", 100, "Argon"), win("partner_seven_day", 50, "Claude and GPT")]);
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s))).status, 204);
  await refreshDerived(db, env, NOW);
  const limits = () => raw.prepare("SELECT key FROM events WHERE visible = 1 AND key LIKE 'limit:gemini:%'").all() as { key: string }[];
  // Argon's derived values behind: it waits
  raw.exec("UPDATE derived_metrics SET body = json_remove(body, '$.seven_day_argon') WHERE provider = 'gemini'");
  await judge(db, env, NOW);
  assert.equal(limits().length, 0, "waits for its own derived values");
  // only the partner's behind: Argon's limit is told
  raw.exec("UPDATE data_versions SET version = version + 1 WHERE provider = 'gemini'");
  await refreshDerived(db, env, new Date(NOW.getTime() + 1));
  raw.exec("UPDATE derived_metrics SET body = json_remove(body, '$.partner_seven_day') WHERE provider = 'gemini'");
  await judge(db, env, new Date(NOW.getTime() + 60_000));
  assert.deepEqual(limits().map((r) => r.key.split(":")[2]), ["seven_day_argon"]);
});

test("a save whose rebuild of the read row fails is rolled back whole, and the next Cron puts both", async () => {
  const { call, env, raw } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withGemini([win("five_hour", 10, null)])))).status, 204);
  const original = env.DB;
  let failed = 0;
  // the rebuild of the read row fails inside the first save's batch (the batch is one transaction)
  env.DB = {
    prepare: (sql: string) => original.prepare(sql.includes("INSERT INTO derived_public") && failed++ === 0 ? sql.replace("derived_public", "no_such_table") : sql),
    batch: (st: Parameters<D1Like["batch"]>[0]) => original.batch(st),
  } as D1Like;
  await assert.rejects(runCron(env, NOW));
  env.DB = original;
  const count = (t: string) => (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  assert.equal(count("derived_metrics"), 0, "the derived row went back with it");
  await runCron(env, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal(count("derived_metrics"), 3);
  const body = JSON.parse((raw.prepare("SELECT body FROM derived_public WHERE id = 1").get() as { body: string }).body) as { provider: string }[];
  assert.deepEqual(body.map((r) => r.provider).sort(), ["claude", "codex", "gemini"]);
});

test("h: a Cron of three providers scans no large table (observations, hourly aggregates, events), so its reads stay within the reserve", async () => {
  const { call, env, raw } = await setup();
  const s3 = withGemini([win("five_hour", 85, null), win("seven_day", 20, null)]);
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s3))).status, 204);
  const ins = raw.prepare("INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const p of ["claude", "codex", "gemini"]) {
    for (let i = 0; i < 1500; i++) {
      const t = new Date(NOW.getTime() - 60_000 - i * 14_000).toISOString();
      ins.run(p, i % 2 ? "five_hour" : "seven_day", "mac", t, t, RESET_5H, i % 100);
    }
    for (let i = 0; i < 300; i++) {
      const t = new Date(NOW.getTime() - 20 * 86_400_000 - i * 60_000).toISOString();
      ins.run(p, "five_hour", "mac", t, t, null, 1);
    }
  }
  raw.exec("COMMIT");
  // every statement the Cron runs, with its values (also those of a batch)
  const seen: { sql: string; params: unknown[] }[] = [];
  type St = ReturnType<D1Like["prepare"]> & { sql?: string; params?: unknown[]; inner?: ReturnType<D1Like["prepare"]> };
  const original = env.DB;
  const wrap = (sql: string, st: ReturnType<D1Like["prepare"]>, params: unknown[] = []): St => ({
    sql, params, inner: st,
    bind: (...v: unknown[]) => wrap(sql, st.bind(...v), v),
    run: () => (seen.push({ sql, params }), st.run()),
    all: <T>() => (seen.push({ sql, params }), st.all<T>()),
    first: <T>() => (seen.push({ sql, params }), st.first<T>()),
  });
  const capture: D1Like = {
    prepare: (sql) => wrap(sql, original.prepare(sql)),
    batch: (st) => {
      for (const x of st as St[]) seen.push({ sql: x.sql ?? "", params: x.params ?? [] });
      return original.batch((st as St[]).map((x) => x.inner ?? x));
    },
  };
  assert.equal(await runCron({ ...env, DB: capture }, NOW), true);
  assert.ok(seen.length > 20, String(seen.length));
  const LARGE = ["observations", "observation_hourly", "events"];
  // Every column of each large table's primary key (a search by its first columns only reads, say, one provider's rows)
  const keyOf = new Map(LARGE.map((t) => [t, (raw.prepare(`PRAGMA table_info(${t})`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0).map((c) => c.name)]));
  const scans: string[] = [];
  for (const { sql, params } of seen) {
    // the table each name in the statement stands for (an alias, or the table itself)
    const names = new Map<string, string>(LARGE.map((t) => [t, t]));
    for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi)) {
      if (LARGE.includes(m[1]!) && m[2] && !/^(WHERE|ON|JOIN|LEFT|INNER|ORDER|GROUP|LIMIT|SET|VALUES|USING)$/i.test(m[2])) names.set(m[2], m[1]!);
    }
    const plan = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[];
    const touchesLarge = plan.some((p) => /^(SCAN|SEARCH) (\w+)/.test(p.detail) && names.has(/^(?:SCAN|SEARCH) (\w+)/.exec(p.detail)![1]!));
    for (const p of plan) {
      const m = /^(SCAN|SEARCH) (\w+)(.*)$/.exec(p.detail);
      const table = m ? names.get(m[2]!) : undefined;
      if (m && table && m[1] === "SCAN") scans.push(`${p.detail} <= ${sql.slice(0, 80)}`);
      // a search of a large table must be bounded: by keys that name rows (a row id, equalities of every column of a primary key, every
      // column of the observations' key), or by a range of an index with both ends; an index's equality alone (one provider's rows), the
      // first columns of a primary key, and a LIMIT alone (other conditions may skip every row it reads) are none
      const detail = m?.[3] ?? "";
      const equal = [...detail.matchAll(/(\w+)=\?/g)].map((x) => x[1]!);
      const key = keyOf.get(table ?? "") ?? [];
      const wholeKey = key.length > 0 && key.every((c) => equal.includes(c));
      const one = /\((rowid=\?|key=\?|id=\?)\)/.test(detail) || (/USING PRIMARY KEY/.test(detail) && !/[<>]/.test(detail) && wholeKey)
        || /\(provider=\? AND window_id=\? AND collector=\? AND observed_at=\?\)/.test(detail);
      const ends = (detail.match(/[<>]/g) ?? []).length;
      // the columns the statement compares with a parameter that no search of its plan uses: conditions left to check row by row
      const searched = plan.map((x) => x.detail).join(" ");
      const residual = [...sql.matchAll(/\b(\w+)\s*(?:=|<=|>=|<|>)\s*\?/g)].map((x) => x[1]!)
        .filter((c) => !new RegExp(`\\b${c}[=<>]`).test(searched));
      const ranged = /USING (COVERING )?(INDEX|PRIMARY KEY)/.test(detail) && ends > 0
        && (ends >= 2 || (/\bLIMIT\b/i.test(sql) && residual.length === 0));
      if (m && table && m[1] === "SEARCH" && !one && !ranged) scans.push(`unbounded ${p.detail} <= ${sql.slice(0, 80)}`);
      if (touchesLarge && /USE TEMP B-TREE/.test(p.detail)) scans.push(`sort ${p.detail} <= ${sql.slice(0, 80)}`);
    }
  }
  assert.deepEqual(scans, []);
});

test("a limit flag that follows from windows isn't told on another window once the one at 100% has reset (Codex's from its API still is)", async () => {
  const { call, env } = await setup();
  const s = withGemini([win("five_hour", 100, null), win("seven_day", 40, null)], true);
  s.providers.claude!.blocked = true;
  s.providers.claude!.windows = s.providers.claude!.windows.map((w) => (w.id === "five_hour" ? { ...w, used_percent: 100 } : w));
  s.providers.codex!.blocked = true;
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s))).status, 204);
  // The first Cron after the 5-hour window reset
  const after = new Date(Date.parse(RESET_5H) + 5 * 60_000);
  await runCron(env, after);
  const limits = (await events(call, after)).filter((e) => e.kind === "limit");
  assert.deepEqual(limits.filter((e) => e.provider !== "codex"), [], JSON.stringify(limits));
  assert.equal(limits.filter((e) => e.provider === "codex").length, 1, "Codex's limit known from its API");
});

test("a limit is told by the Cron that receives it even when the others' history fills the rows (no window waits for a later Cron)", async () => {
  const { call, env, raw } = await setup();
  // Gemini's 5-hour at 100%, resetting 3 minutes later; Claude and Codex with 2,700 rows each
  const soon = new Date(NOW.getTime() + 3 * 60_000).toISOString();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withGemini([win("five_hour", 100, null, soon), win("seven_day", 40, null)], true)))).status, 204);
  const ins = raw.prepare("INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const p of ["claude", "codex"]) for (let i = 0; i < 2700; i++) {
    const t = new Date(NOW.getTime() - 60_000 - i * 20_000).toISOString();
    ins.run(p, "five_hour", "mac", t, t, RESET_5H, i % 100);
  }
  raw.exec("COMMIT");
  for (const at of [NOW, new Date(NOW.getTime() + 5 * 60_000)]) {
    await runCron(env, at);
    const limits = (await events(call, at)).filter((e) => e.provider === "gemini" && e.kind === "limit");
    assert.equal(limits.length, 1, at.toISOString());
  }
});

test("a forecast is told by the Cron that receives the fetch, also when the others' history is long (each reads its share)", async () => {
  const { call, env, raw } = await setup();
  const reset = new Date(NOW.getTime() + 3 * 3_600_000).toISOString();
  // Gemini's 5-hour climbing from 60% to 90% in 30 minutes: about 10 minutes left at this pace
  const climb = [60, 65, 70, 75, 80, 85].map((u, i) => obs("gemini", "five_hour", u, new Date(NOW.getTime() - (30 - i * 5) * 60_000).toISOString(), reset));
  const s = withGemini([win("five_hour", 90, null, reset), win("seven_day", 40, null)]);
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s, climb))).status, 204);
  const ins = raw.prepare("INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const p of ["claude", "codex"]) for (let i = 0; i < 5000; i++) {
    const t = new Date(NOW.getTime() - 60_000 - i * 15_000).toISOString();
    ins.run(p, "five_hour", "mac", t, t, RESET_5H, i % 100);
  }
  raw.exec("COMMIT");
  await runCron(env, NOW);
  const soon = (await events(call)).filter((e) => e.provider === "gemini" && e.kind === "soon");
  assert.equal(soon.length, 1, JSON.stringify(soon));
  await runCron(env, new Date(NOW.getTime() + 5 * 60_000));
  assert.equal((await events(call, new Date(NOW.getTime() + 5 * 60_000))).filter((e) => e.provider === "gemini" && e.kind === "soon").length, 1, "once");
});

test("a PC's value with every Gemini limit turned off stands over another PC's older one at 100%", async () => {
  const { call, env } = await setup();
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const full = withGemini([win("five_hour", 100, null, RESET_5H, at(0).toISOString())], true);
  full.collector = "mac";
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, full), at(0))).status, 204);
  const off = withGemini([], false);
  off.providers.gemini!.fetched_at = at(4).toISOString();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, off), at(4))).status, 204);
  await runCron(env, at(5));
  const v = await view(call, at(5));
  assert.deepEqual(Object.keys(v.gemini.windows), [], "the newer value: no limit shown");
  assert.equal(v.gemini.blocked, false);
  assert.equal((await events(call, at(5))).filter((e) => e.provider === "gemini" && e.kind === "limit").length, 0);
});

test("weekly history: Gemini's series from before an accepted account isn't shown after the boundary, and the one built again carries it", async () => {
  const { call, env } = await setup();
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const weekly = (used: number, m: number, history: string | null) => {
    const s = withGemini([win("seven_day", used, null, RESET_7D, at(m).toISOString())], false, history);
    s.providers.gemini!.fetched_at = at(m).toISOString();
    return upload(m + 1, s, [obs("gemini", "seven_day", used, at(m).toISOString(), RESET_7D)]);
  };
  const history = async (m: number) =>
    (await (await call("GET", "/v2/history?provider=gemini&hours=168", READ, undefined, at(m))).json()) as { boundary: string; windows: { seven_day: { used_percent: number }[] } };
  // A's 90% at 13:04
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, weekly(90, 4, null), at(4))).status, 204);
  await runCron(env, at(5));
  assert.deepEqual((await history(5)).windows.seven_day.map((p) => p.used_percent), [90]);
  assert.equal((await history(5)).boundary, "");
  // B accepted at 13:06, its 3% at 13:11: A's series isn't shown under B's boundary, even before Cron builds it again
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, weekly(3, 11, at(6).toISOString()), at(11))).status, 204);
  const between = await history(11);
  assert.notEqual(between.boundary, "");
  assert.deepEqual(between.windows.seven_day, [], "the series built under A's boundary is hidden");
  await runCron(env, at(12));
  const after = await history(12);
  assert.deepEqual(after.windows.seven_day.map((p) => p.used_percent), [3], "only B's");
  assert.equal(after.boundary, between.boundary);
  assert.equal((await view(call, at(12))).boundaries.gemini, after.boundary, "the same stamp as the view's");
  // the others' series aren't touched by Gemini's boundary
  assert.equal((await (await call("GET", "/v2/history?provider=claude&hours=168", READ, undefined, at(12))).json() as { boundary: string }).boundary, "");
});

test("d: after another Gemini account is accepted, the same window and reset time at its limit is told once, under the new boundary", async () => {
  const { call, env } = await setup();
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const limitOf = (history: string | null) => withGemini([win("five_hour", 100, null, RESET_5H, NOW.toISOString()), win("seven_day", 20, null)], true, history);
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, limitOf(null), [obs("gemini", "five_hour", 100)]));
  await runCron(env, at(1));
  const limits = async (m: number) => (await events(call, at(m))).filter((e) => e.provider === "gemini" && e.kind === "limit");
  assert.equal((await limits(1)).length, 1, "A's limit");
  // B accepted: the boundary moves on, and B is at its limit in the same window with the same reset time
  const accepted = at(2).toISOString();
  const b = limitOf(accepted);
  b.providers.gemini!.windows = b.providers.gemini!.windows.map((w) => ({ ...w, fetched_at: at(3).toISOString() }));
  b.providers.gemini!.fetched_at = at(3).toISOString();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, b, [obs("gemini", "five_hour", 100, at(3).toISOString())]), at(3))).status, 204);
  await runCron(env, at(4));
  const after = await limits(4);
  assert.equal(after.length, 2, "B's limit told, not held back by A's");
  assert.notEqual(after[1]!.boundary, after[0]!.boundary);
  assert.equal((await view(call, at(4))).boundaries.gemini === "", false, "the view carries Gemini's boundary");
  await runCron(env, at(9));
  assert.equal((await limits(9)).length, 2, "not told again");
});
