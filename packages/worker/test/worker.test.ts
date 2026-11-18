import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { nextSendSeq, type Snapshot } from "../../core/src/index.ts";
import { MAX_COLLECTORS, parseTokens, sha256Hex } from "../src/auth.ts";
import { handle, refreshDerived, repairPublicState, runCron, type Env } from "../src/index.ts";
import { DAILY_BUDGET, RESERVE, daysToReserve, endOfDays, reserve, settle } from "../src/budget.ts";
import { MAX_WINDOWS, WITHHELD_ERROR } from "../src/sanitize.ts";
import { sanitizeUpload } from "../src/sanitize.ts";
import { EVENT_FEED_SQL, MAX_STORED_COLLECTORS, PRUNE_EVENTS, PRUNE_ROWS, dataVersionOf, loadObservations, loadPublicRow, prune, rebuildEventFeed, saveDerived, savePublicState, saveUpload, saveWeekly, loadWeekly, type D1Like } from "../src/store.ts";
import { sqliteD1 } from "./d1-sqlite.ts";

const READ = "read-token-for-iphone-0123456789";
const MAC = "write-token-for-mac-0123456789ab";
const WIN = "write-token-for-win-0123456789ab";
const NOW = new Date("2026-11-16T13:00:00.000Z");
const fixture = (): Snapshot =>
  JSON.parse(readFileSync(new URL("../../../fixtures/snapshot/v2-basic.json", import.meta.url), "utf8"));

async function setup() {
  const { db, raw } = sqliteD1();
  const tokens = [
    { name: "iphone", sha256: await sha256Hex(READ), role: "read" },
    { name: "mac", sha256: await sha256Hex(MAC), role: "write", collector: "mac" },
    { name: "win-desktop", sha256: await sha256Hex(WIN), role: "write", collector: "win-desktop" },
  ];
  const env: Env = {
    DB: db,
    TOKENS: JSON.stringify(tokens),
    COLLECTOR_PRIORITY: "win-desktop,mac",
    ALLOWED_HOST: "headroom.example",
  };
  const call = (method: string, path: string, token?: string, body?: unknown, at = NOW, host = "headroom.example") =>
    handle(
      new Request(`https://${host}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      env,
      () => at,
    );
  return { raw, db, call, env };
}

function upload(seq: number, snapshot: Snapshot = fixture(), observations: unknown[] = []) {
  return { seq, snapshot, observations };
}

const obs = (window_id: string, used_percent: number, observed_at: string, provider = "claude") => ({
  provider, window_id, used_percent, observed_at, resets_at: "2026-11-16T16:00:00.000Z",
});

/** Joins every column of every D1 table into one string (to check that no forbidden value is stored) */
function dumpAll(raw: ReturnType<typeof sqliteD1>["raw"]): string {
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map((t) => JSON.stringify(raw.prepare(`SELECT * FROM ${t.name}`).all())).join("\n");
}

test("missing or wrong Worker credential returns 401", async () => {
  const { call } = await setup();
  assert.equal((await call("GET", "/v2/view")).status, 401);
  assert.equal((await call("GET", "/v2/view", "wrong-token-0123456789abcdef")).status, 401);
  assert.equal((await call("PUT", "/v2/snapshots/mac", undefined, upload(1))).status, 401);
});

test("writes or reads with a mismatched role or PC name return 403", async () => {
  const { call, raw } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/mac", READ, upload(1))).status, 403, "PUT with a read credential");
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", MAC, upload(1))).status, 403, "another PC name");
  assert.equal((await call("GET", "/v2/snapshot", MAC)).status, 403, "PCs have no read permission");
  assert.equal(dumpAll(raw).includes("prolite"), false, "rejected uploads are not stored");
});

test("written values are merged and readable; responses are not cacheable and CORS is not allowed", async () => {
  const { call } = await setup();
  const put = await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 10, "2026-11-16T12:59:30.000Z")]));
  assert.equal(put.status, 204);
  const res = await call("GET", "/v2/snapshot", READ);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  const merged = (await res.json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "win-desktop");
  assert.equal(merged.providers.codex?.plan, "prolite");

  const view = await call("GET", "/v2/view?tz=Asia/Tokyo", READ);
  assert.equal(view.status, 200);
  const v = (await view.json()) as { claude: { windows: Record<string, { used_percent: number }> } };
  assert.equal(v.claude.windows.five_hour?.used_percent, 10);
  assert.equal((await call("GET", "/v2/view?tz=Not/AZone", READ)).status, 400);
});

test("extra fields and email addresses never reach D1", async () => {
  const { call, raw } = await setup();
  const snap = fixture() as unknown as Record<string, any>;
  snap.email = "leak@example.com";
  snap.providers.claude.account = { email: "leak@example.com", accountUuid: "123e4567-e89b-12d3-a456-426614174000" };
  snap.providers.claude.error = "denied for leak@example.com";
  snap.providers.claude.plan = "max leak@example.com";
  snap.providers.claude.windows[0].label = "token sk-ant-AAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  snap.providers.claude.windows[0].raw = "C:\\Users\\someone\\.claude";
  snap.collector = "someones-macbook";
  const body = { ...upload(1, snap as Snapshot, [{ ...obs("five_hour", 10, "2026-11-16T12:59:00Z"), note: "leak@example.com" }]), extra: "leak@example.com" };
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, body)).status, 204);
  const all = dumpAll(raw);
  for (const forbidden of ["@", "123e4567", "sk-ant", "Users", "someones-macbook", "account", "email", "note", "extra"]) {
    assert.equal(all.includes(forbidden), false, `${forbidden} is stored`);
  }
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.claude?.error, WITHHELD_ERROR);
  assert.equal(merged.providers.claude?.plan, null);
  assert.equal(merged.providers.claude?.windows[0]?.label, "5h", "the Worker builds the label");
});

test("diagnostics, paths and short identifiers that pass character checks still don't reach D1 or the read endpoint", async () => {
  const { call, raw } = await setup();
  const snap = fixture() as unknown as Record<string, any>;
  // CLI text without an email address, a /Volumes/ path, a short identifier
  snap.providers.claude.error = "Failed to read /Volumes/work/.claude/state for org acme7x";
  snap.providers.claude.error_code = "fetch_failed";
  snap.providers.codex.error = "stale: ws_42ab";
  snap.providers.codex.plan = "team_ab123";
  snap.providers.claude.windows[2].scope = "/Volumes/work";
  snap.providers.claude.windows[2].label = "acct 9f3e1";
  snap.providers.codex.windows[1].scope = "acct9f3e1";
  snap.providers.codex.windows.push({ ...snap.providers.codex.windows[0], id: "acct_9f3e1", scope: null });
  snap.providers.codex.windows.push({ ...snap.providers.codex.windows[0], id: "org7d2c9_seven_day", scope: "x" });
  const observations = [
    obs("five_hour", 10, "2026-11-16T12:59:00Z"),
    { ...obs("five_hour", 10, "2026-11-16T12:59:00Z"), provider: "codex", window_id: "acct_9f3e1" },
  ];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap as Snapshot, observations))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  for (const text of [dumpAll(raw), JSON.stringify(merged)]) {
    for (const forbidden of ["Volumes", "acme7x", "ws_42ab", "ab123", "9f3e1", "7d2c9", "Failed"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} is exposed`);
    }
  }
  assert.equal(merged.providers.claude?.error, "Fetch failed (see headroom status on the PC)");
  assert.equal(merged.providers.codex?.error, WITHHELD_ERROR);
  assert.equal(merged.providers.codex?.plan, null);
  const claudeModel = merged.providers.claude?.windows.find((w) => w.id === "seven_day_fable");
  assert.deepEqual([claudeModel?.scope, claudeModel?.label], ["Fable", "Weekly Fable"], "scope is derived from the known name in the id");
  // Known model and group limits needed for display remain
  assert.deepEqual(merged.providers.codex?.windows.map((w) => [w.id, w.scope, w.label]), [
    ["seven_day", null, "Weekly"],
    ["codex_other_seven_day", "codex_other", "Weekly codex_other"],
  ]);
});

test("short identifiers that can't be told apart by shape are not stored unless known", async () => {
  const { call, raw } = await setup();
  const snap = fixture() as unknown as Record<string, any>;
  snap.providers.claude.plan = "acme";
  snap.providers.claude.windows[2].scope = "acme7x";
  snap.providers.claude.windows.push({ ...snap.providers.claude.windows[2], id: "seven_day_acme7x", scope: "acme7x" });
  snap.providers.codex.windows.push({ ...snap.providers.codex.windows[0], id: "acme_seven_day", scope: "acme" });
  const observations = [{ ...obs("seven_day_acme7x", 5, "2026-11-16T12:59:00Z") }];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap as Snapshot, observations))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  const view = await (await call("GET", "/v2/view", READ)).text();
  for (const text of [dumpAll(raw), JSON.stringify(merged), view]) {
    assert.equal(text.includes("acme"), false, "acme is exposed");
  }
  assert.equal(merged.providers.claude?.plan, null);
  assert.equal(merged.providers.codex?.plan, "prolite", "known plan names remain");
});

test("window id parsing and labels", async () => {
  const { parseWindowId, windowLabel } = await import("../src/sanitize.ts");
  const label = (id: string) => {
    const parts = parseWindowId(id);
    return parts === null ? null : [parts.scope, windowLabel(id, parts)];
  };
  assert.deepEqual(label("five_hour"), [null, "5h"]);
  assert.deepEqual(label("seven_day_fable"), ["Fable", "Weekly Fable"]);
  assert.deepEqual(label("seven_day_opus"), ["Opus", "Weekly Opus"]);
  assert.deepEqual(label("codex_other_seven_day"), ["codex_other", "Weekly codex_other"]);
  assert.deepEqual(label("window_300m"), [null, "5h"]);
  assert.deepEqual(label("window_90m"), [null, "90m"]);
  assert.deepEqual(label("extra_usage"), [null, "Extra usage"]);
  // Codex limits of unknown duration, and the suffixes that avoid collisions
  assert.deepEqual(label("primary"), [null, "Primary"]);
  assert.deepEqual(label("secondary"), [null, "Secondary"]);
  assert.deepEqual(label("codex_other_primary"), ["codex_other", "Primary codex_other"]);
  assert.deepEqual(label("seven_day_primary"), [null, "Weekly"]);
  assert.deepEqual(label("codex_other_seven_day_secondary_2"), ["codex_other", "Weekly codex_other"]);
  // An extra group seen in a recorded real response
  // Not tied to a model name; labeled so it is distinguishable from the overall limit
  assert.deepEqual(label("codex_bengalfox_five_hour"), ["Codex extra", "5h Codex extra"]);
  assert.deepEqual(label("codex_bengalfox_seven_day"), ["Codex extra", "Weekly Codex extra"]);
  for (const id of ["current_session_usage_for_acme", "seven_day_acme7x", "acme_seven_day", "acct_9f3e1", "seven_day-x"]) {
    assert.equal(parseWindowId(id), null, id);
  }
});

test("Codex limits of unknown duration (primary / secondary) are stored and exposed on the read endpoint", async () => {
  const { call, raw } = await setup();
  const snap = fixture();
  snap.providers.codex!.windows = [
    { ...snap.providers.codex!.windows[0]!, id: "primary", kind: "other", label: "primary" },
    { ...snap.providers.codex!.windows[0]!, id: "secondary", kind: "other", label: "secondary" },
  ];
  const observations = [obs("primary", 20, "2026-11-16T12:59:00Z", "codex")];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap, observations))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.deepEqual(merged.providers.codex?.windows.map((w) => [w.id, w.label]), [["primary", "Primary"], ["secondary", "Secondary"]]);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations WHERE window_id = 'primary'").get() as { n: number }).n, 1);
});

test("only a newer upload (greater seq) replaces the PC's latest value", async () => {
  const { call } = await setup();
  const first = nextSendSeq(null, Date.parse("2026-11-16T12:50:00Z")); // PC whose clock was ahead
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(first))).status, 204);
  const logout = fixture();
  logout.providers.claude = {
    ...logout.providers.claude!, status: "unavailable", fetched_at: null, error: "Sign-in required",
    error_code: "login_required", windows: [], blocked: null,
  };
  const second = nextSendSeq(first, Date.parse("2026-11-16T12:06:00Z")); // after clock correction
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(second, logout))).status, 204);
  // A resend of the pre-correction upload doesn't roll back (the latest value isn't replaced, so 409 with the saved seq)
  const stale = await call("PUT", "/v2/snapshots/mac", MAC, upload(first));
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: "stale_seq", seq: second });
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.claude?.error_code, "login_required");
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(0))).status, 400, "seq must be a positive integer");
});

test("a PC that lost its local state learns the saved seq from 409 and can resend the latest value with the next seq", async () => {
  const { call, raw } = await setup();
  const ahead = Date.parse("2027-01-01T00:00:00Z"); // an upload made while the clock was far ahead
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(ahead))).status, 204);
  // The clock was fixed and outbox.json was lost too. Send a logout with a small seq
  const logout = fixture();
  logout.providers.claude = { ...logout.providers.claude!, status: "unavailable", error_code: "login_required", windows: [] };
  const small = nextSendSeq(null, NOW.getTime());
  const res = await call("PUT", "/v2/snapshots/mac", MAC, upload(small, logout, [obs("five_hour", 10, "2026-11-16T12:59:00Z")]));
  assert.equal(res.status, 409, "not replacing the latest value is not reported as success");
  const { seq } = (await res.json()) as { seq: number };
  assert.equal(seq, ahead);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 1, "observation is saved");
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(nextSendSeq(seq, NOW.getTime()), logout))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.claude?.error_code, "login_required");
});

test("a resent observation is stored once; computation time is clamped to the first received time", async () => {
  const { call, raw } = await setup();
  const future = obs("five_hour", 12, "2026-11-16T13:05:00.000Z"); // PC whose clock is 5 minutes ahead
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture(), [future]), new Date("2026-11-16T13:00:00Z"));
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, fixture(), [future]), new Date("2026-11-16T13:01:00Z"));
  const rows = raw.prepare("SELECT observed_at, first_received_at FROM observations").all() as Record<string, string>[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.first_received_at, "2026-11-16T13:00:00.000Z");
});

test("observations of a provider stopped by an account switch are not stored", async () => {
  const { call, raw } = await setup();
  const snap = fixture();
  snap.providers.codex = { ...snap.providers.codex!, status: "unavailable", error_code: "account_changed", windows: [] };
  const body = upload(1, snap, [obs("seven_day", 30, "2026-11-16T12:59:00Z", "codex"), obs("five_hour", 10, "2026-11-16T12:59:00Z")]);
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, body)).status, 204);
  const rows = raw.prepare("SELECT provider FROM observations").all() as { provider: string }[];
  assert.deepEqual(rows.map((r) => r.provider), ["claude"]);
});

test("after accepting a switch, the previous account's observations are dropped for all PCs and late resends are not stored", async () => {
  const { db, call, raw } = await setup();
  // Number of observations visible on read (observations before the boundary are filtered on read; Cron deletes them from the table gradually)
  const count = async (provider: "claude" | "codex") => (await loadObservations(db, provider, new Date(0))).length;
  // Previous account's observations (two PCs)
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture(), [obs("five_hour", 60, "2026-11-16T12:00:00Z")]));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 61, "2026-11-16T12:05:00Z")]));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [obs("five_hour", 9, "2026-11-16T12:05:00Z", "codex")]));
  assert.equal(await count("claude"), 2);
  // mac accepted a switch (12:30)
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, accepted, [obs("five_hour", 3, "2026-11-16T12:40:00Z")]));
  await prune(db, NOW); // Observations before the boundary are filtered on read; Cron deletes them gradually
  assert.equal(await count("claude"), 1, "observations before the boundary are gone for all PCs");
  assert.equal(await count("codex"), 1, "other providers are not deleted");
  // Previous-account observations left over from a network outage are not stored even if they arrive late
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, fixture(), [obs("five_hour", 62, "2026-11-16T12:20:00Z")]));
  assert.equal(await count("claude"), 1);
  // A resend of an old upload (seq not above the saved one) with an earlier boundary, or a boundary too far in the future, deletes nothing
  const older = fixture();
  older.providers.claude!.history_since = "2026-11-16T12:10:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, older, [obs("five_hour", 4, "2026-11-16T12:50:00Z")]));
  const future = fixture();
  future.providers.claude!.history_since = "2026-11-17T12:00:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(4, future));
  assert.equal(await count("claude"), 2);
  assert.deepEqual(raw.prepare("SELECT provider, since FROM history_boundaries").all().map((r) => ({ ...r })), [
    { provider: "claude", since: "2026-11-16T12:30:00.000Z" },
  ]);
});

test("other PCs' current values fetched before the boundary are not exposed on the read endpoint either", async () => {
  const { call } = await setup();
  // Both PCs hold the previous account's values
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()), new Date("2026-11-16T12:59:30Z"));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()), new Date("2026-11-16T12:59:30Z"));
  // mac accepted the switch but has no value for the new account yet
  const accepted = fixture();
  accepted.providers.claude = {
    ...accepted.providers.claude!, status: "error", error_code: "fetch_failed", fetched_at: null, windows: [],
    history_since: "2026-11-16T13:00:00.000Z",
  };
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(2, accepted))).status, 204);
  // win-desktop resends the previous account's values
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture()), new Date("2026-11-16T13:01:00Z"));
  for (const path of ["/v2/snapshot", "/v2/view"]) {
    const text = await (await call("GET", path, READ, undefined, new Date("2026-11-16T13:02:00Z"))).text();
    const merged = JSON.parse(text);
    const claude = path === "/v2/snapshot" ? merged.providers.claude : merged.claude;
    assert.equal(claude?.error_code, "fetch_failed", `${path}: shows the accepting PC's state`);
    assert.equal(text.includes("seven_day_fable"), false, `${path}: doesn't show the previous account's window`);
  }
});

test("even if another request advances the boundary after it was read, an old resend doesn't bring back deleted history", async () => {
  const { db, raw } = await setup();
  const at = new Date("2026-11-16T13:00:00Z");
  const old = sanitizeUpload(upload(1, fixture(), [obs("five_hour", 60, "2026-11-16T12:00:00Z")]), "win-desktop");
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  const accept = sanitizeUpload(upload(1, accepted), "mac");
  assert.ok(!("error" in old) && !("error" in accept));
  let injected = false;
  // Right after an old resend reads the boundary (none yet), the acceptance request finishes first
  const racing: D1Like = {
    prepare(sql) {
      const st = db.prepare(sql);
      if (!sql.startsWith("SELECT provider, source FROM boundary_sources WHERE provider IN") || injected) return st;
      injected = true;
      // Read the acceptance record after bind (inject into bound statements too)
      const hook = (bound: typeof st): typeof st => ({
        ...bound,
        bind: (...values: unknown[]) => hook(bound.bind(...values)),
        all: async <T>() => {
          await saveUpload(db, accept, at);
          return { results: [] as T[] };
        },
      });
      return hook(st);
    },
    batch: (statements) => db.batch(statements),
  };
  await saveUpload(racing, old, at);
  assert.equal(injected, true);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0);
});

test("old observations from a PC with a fast clock are treated as before the boundary using the first received time", async () => {
  const { db, call, raw } = await setup();
  // Observation time recorded as 12:40, but it actually arrived at 12:20 (clock 20 minutes ahead)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 60, "2026-11-16T12:40:00Z")]),
    new Date("2026-11-16T12:20:00Z"));
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:31:00Z"));
  await prune(db, NOW); // Observations before the boundary are filtered on read; Cron deletes them gradually
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0);
  // The boundary is never after the received time (even if the accepting PC's clock is ahead, observations after receipt are kept)
  const ahead = fixture();
  ahead.providers.claude!.history_since = "2026-11-16T12:45:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, ahead), new Date("2026-11-16T12:40:00Z"));
  assert.deepEqual(raw.prepare("SELECT since FROM history_boundaries").all().map((r) => ({ ...r })), [
    { since: "2026-11-16T12:40:00.000Z" },
  ]);
  assert.deepEqual(raw.prepare("SELECT collector, source FROM boundary_sources").all().map((r) => ({ ...r })), [
    { collector: "mac", source: "2026-11-16T12:45:00.000Z" },
  ]);
});

test("observations deleted by the boundary don't come back when resent (even with a newer received time); same for current-value windows", async () => {
  const { db, call, raw } = await setup();
  const count = () => (raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  // PC with a clock 20 minutes ahead (recorded 12:40, arrived 12:20). The current-value window is also fetched at 12:40
  const skewed = fixture();
  skewed.providers.claude!.fetched_at = "2026-11-16T12:40:00.000Z";
  for (const w of skewed.providers.claude!.windows) w.fetched_at = "2026-11-16T12:40:00.000Z";
  const old = upload(1, skewed, [obs("five_hour", 60, "2026-11-16T12:40:00Z")]);
  await call("PUT", "/v2/snapshots/win-desktop", WIN, old, new Date("2026-11-16T12:20:00Z"));
  const accepted = fixture();
  accepted.providers.claude = { ...accepted.providers.claude!, windows: [], fetched_at: null, history_since: "2026-11-16T12:30:00.000Z" };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:30:00Z"));
  await prune(db, NOW); // Observations before the boundary are filtered on read; Cron deletes them gradually
  assert.equal(count(), 0);
  // Resend of the same observation and current value (arrives at 12:31)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, { ...old, seq: 2 }, new Date("2026-11-16T12:31:00Z"));
  assert.equal(count(), 0, "deleted observations don't come back");
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:32:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.length ?? 0, 0, "the previous account's current-value windows are not shown");
  // Observations after the marker in that PC's clock (new fetches) are stored
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, fixture(), [obs("five_hour", 5, "2026-11-16T12:55:00Z")]),
    new Date("2026-11-16T12:36:00Z"));
  assert.equal(count(), 1);
});

test("the next switch after a clock fix also creates a new boundary, and a resend of an old upload doesn't roll it back", async () => {
  const { db, call, raw } = await setup();
  const count = () => (raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  const accept = (since: string) => {
    const s = fixture();
    s.providers.claude!.history_since = since;
    return s;
  };
  // First switch: a PC with a fast clock sends 12:45 (arrives at 12:40)
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accept("2026-11-16T12:45:00.000Z")), new Date("2026-11-16T12:40:00Z"));
  // Observation of the new account
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 7, "2026-11-16T12:41:00Z")]),
    new Date("2026-11-16T12:41:00Z"));
  assert.equal(count(), 1);
  // Second switch after fixing the clock (sends 12:42, smaller than before)
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, accept("2026-11-16T12:42:00.000Z")), new Date("2026-11-16T12:42:30Z"));
  await prune(db, NOW); // Observations before the boundary are filtered on read; Cron deletes them gradually
  assert.equal(count(), 0, "the immediately previous account's history is deleted");
  assert.equal((raw.prepare("SELECT since FROM history_boundaries").get() as { since: string }).since, "2026-11-16T12:42:00.000Z");
  // A resend of the first upload doesn't bring it back
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accept("2026-11-16T12:45:00.000Z")), new Date("2026-11-16T12:43:00Z"));
  assert.equal((raw.prepare("SELECT source FROM boundary_sources").get() as { source: string }).source, "2026-11-16T12:42:00.000Z");
});

test("a resent current value without observations doesn't bring back windows removed by the boundary", async () => {
  const { call } = await setup();
  const skewed = fixture();
  skewed.providers.claude!.fetched_at = "2026-11-16T12:40:00.000Z";
  for (const w of skewed.providers.claude!.windows) w.fetched_at = "2026-11-16T12:40:00.000Z";
  // Only a current value had arrived, without observations (PC with a clock 20 minutes ahead)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, skewed), new Date("2026-11-16T12:20:00Z"));
  const accepted = fixture();
  accepted.providers.claude = { ...accepted.providers.claude!, windows: [], fetched_at: null, history_since: "2026-11-16T12:30:00.000Z" };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:30:00Z"));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, skewed), new Date("2026-11-16T12:31:00Z"));
  for (const path of ["/v2/snapshot", "/v2/view"]) {
    const text = await (await call("GET", path, READ, undefined, new Date("2026-11-16T12:32:00Z"))).text();
    assert.equal(text.includes("seven_day_fable"), false, `${path}: the previous account's window came back`);
  }
});

test("even for a PC that accepted earlier, a limit value from before the current boundary is not merged", async () => {
  const { call } = await setup();
  // win-desktop accepted at 12:00 and sent a limit-only value at 12:20
  const earlier = fixture();
  earlier.providers.claude = { ...earlier.providers.claude!, windows: [], blocked: true,
    fetched_at: "2026-11-16T12:20:00.000Z", history_since: "2026-11-16T12:00:00.000Z" };
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, earlier), new Date("2026-11-16T12:20:00Z"));
  // mac accepted the next switch at 12:30 (no value yet)
  const accepted = fixture();
  accepted.providers.claude = { ...accepted.providers.claude!, status: "error", error_code: "fetch_failed", windows: [],
    blocked: null, fetched_at: null, history_since: "2026-11-16T12:30:00.000Z" };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:30:00Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:31:00Z"))).json()) as Snapshot;
  assert.notEqual(merged.providers.claude?.blocked, true, "a limit value from before the boundary is not chosen");
  assert.equal(merged.providers.claude?.error_code, "fetch_failed", "a fetch failure right after acceptance is shown");
});

test("an upload whose seq became stale by save time doesn't change the boundary, acceptance record, or history", async () => {
  const { db, raw } = await setup();
  const accept = (seq: number, since: string) => {
    const s = fixture();
    s.providers.claude!.history_since = since;
    const u = sanitizeUpload(upload(seq, s), "mac");
    assert.ok(!("error" in u));
    return u;
  };
  await saveUpload(db, accept(1, "2026-11-16T12:30:00.000Z"), new Date("2026-11-16T12:30:00Z"));
  let injected = false;
  // After seq 2 reads the boundary and saved seq, seq 3's save finishes first, before the batch (only the in-SQL check protects this)
  const racing: D1Like = {
    prepare(sql) {
      const st = db.prepare(sql);
      if (!sql.startsWith("SELECT seq FROM collector_names") || injected) return st;
      injected = true;
      const bound = (...values: unknown[]) => {
        const b = st.bind(...values);
        return {
          ...b,
          all: async <T>() => {
            const rows = await b.all<T>();
            await saveUpload(db, accept(3, "2026-11-16T12:45:00.000Z"), new Date("2026-11-16T12:46:00Z"));
            return rows;
          },
        } as typeof b;
      };
      return { ...st, bind: bound } as typeof st;
    },
    batch: (statements) => db.batch(statements),
  };
  const result = await saveUpload(racing, accept(2, "2026-11-16T12:40:00.000Z"), new Date("2026-11-16T12:46:00Z"));
  assert.equal(injected, true);
  assert.equal(result.applied, false);
  assert.deepEqual(raw.prepare("SELECT source FROM boundary_sources").all().map((r) => ({ ...r })), [
    { source: "2026-11-16T12:45:00.000Z" },
  ]);
  assert.equal((raw.prepare("SELECT since FROM history_boundaries").get() as { since: string }).since, "2026-11-16T12:45:00.000Z");
  // Sending the same 12:45 later with seq 4 is not a new acceptance
  await saveUpload(db, sanitizeUpload(upload(4, (() => { const s = fixture(); s.providers.claude!.history_since = "2026-11-16T12:45:00.000Z"; return s; })(), [obs("five_hour", 3, "2026-11-16T13:05:00Z")]), "mac") as never, new Date("2026-11-16T13:05:00Z"));
  await saveUpload(db, accept(5, "2026-11-16T12:45:00.000Z"), new Date("2026-11-16T13:06:00Z"));
  assert.equal((raw.prepare("SELECT since FROM history_boundaries").get() as { since: string }).since, "2026-11-16T12:45:00.000Z");
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 1);
});

test("even if a concurrent request advances the boundary first, the new acceptance's correction (raising to the received time) is not lost", async () => {
  const { db, raw } = await setup();
  const accept = (seq: number, since: string, observations: unknown[] = []) => {
    const s = fixture();
    s.providers.claude!.history_since = since;
    const u = sanitizeUpload(upload(seq, s, observations), "mac");
    assert.ok(!("error" in u));
    return u;
  };
  let injected = false;
  // After seq 3 (accepted 12:30, received 12:55) reads the boundary, seq 2 (boundary 12:50) and another PC's 12:52 observation are saved first
  const racing: D1Like = {
    prepare(sql) {
      const st = db.prepare(sql);
      if (!sql.startsWith("SELECT provider, source FROM boundary_sources WHERE provider IN") || injected) return st;
      injected = true;
      // Read the acceptance record after bind (inject into bound statements too)
      const hook = (bound: typeof st): typeof st => ({
        ...bound,
        bind: (...values: unknown[]) => hook(bound.bind(...values)),
        all: async <T>() => {
          const results = (await bound.all<T>()).results;
          await saveUpload(db, accept(2, "2026-11-16T12:50:00.000Z"), new Date("2026-11-16T12:50:00Z"));
          const win = sanitizeUpload(upload(1, fixture(), [obs("five_hour", 40, "2026-11-16T12:52:00Z")]), "win-desktop");
          assert.ok(!("error" in win));
          await saveUpload(db, win, new Date("2026-11-16T12:52:00Z"));
          return { results };
        },
      });
      return hook(st);
    },
    batch: (statements) => db.batch(statements),
  };
  await saveUpload(racing, accept(3, "2026-11-16T12:30:00.000Z"), new Date("2026-11-16T12:55:00Z"));
  assert.equal(injected, true);
  assert.equal((raw.prepare("SELECT since FROM history_boundaries").get() as { since: string }).since, "2026-11-16T12:55:00.000Z");
  await prune(db, NOW); // Observations before the boundary are filtered on read; Cron deletes them gradually
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0, "the immediately previous account's history doesn't remain");
});

test("a post-boundary 'no windows, limit only' value from a PC that hasn't accepted the switch stays in the merge", async () => {
  const { call } = await setup();
  const accepted = fixture();
  accepted.providers.claude = { ...accepted.providers.claude!, status: "error", error_code: "fetch_failed", windows: [],
    fetched_at: null, history_since: "2026-11-16T12:30:00.000Z" };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:30:00Z"));
  const blockedOnly = fixture();
  blockedOnly.providers.claude = { ...blockedOnly.providers.claude!, windows: [], blocked: true,
    fetched_at: "2026-11-16T12:50:00.000Z" };
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, blockedOnly), new Date("2026-11-16T12:50:00Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:51:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.blocked, true);
});

test("same seq with different content returns 409; a resend of the same upload returns 204", async () => {
  const { call } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(5))).status, 204);
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(5))).status, 204, "resend of the same upload");
  const logout = fixture();
  logout.providers.claude = { ...logout.providers.claude!, status: "unavailable", error_code: "login_required", windows: [] };
  const res = await call("PUT", "/v2/snapshots/mac", MAC, upload(5, logout));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "stale_seq", seq: 5 });
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(6, logout))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.claude?.error_code, "login_required");
});

test("hosts other than the entry host (ALLOWED_HOST), such as preview URLs, are rejected even with a valid token", async () => {
  const { call, raw, env } = await setup();
  for (const host of ["headroom.someone.workers.dev", "abc123-headroom.someone.workers.dev", "headroom.example.evil.test"]) {
    assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1), NOW, host)).status, 404, host);
    assert.equal((await call("GET", "/v2/view", READ, undefined, NOW, host)).status, 404, host);
  }
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM collector_snapshots").get() as { n: number }).n, 0);
  delete env.ALLOWED_HOST;
  assert.equal((await call("GET", "/v2/view", READ)).status, 503, "everything is rejected if unset");
});

test("a PC name with invalid percent-encoding returns 4xx and writes nothing to D1", async () => {
  const { call, raw } = await setup();
  for (const path of ["/v2/snapshots/%", "/v2/snapshots/%E0%A4%A", "/v2/snapshots/m%ac"]) {
    const res = await call("PUT", path, MAC, upload(1));
    assert.equal(res.status, 404, path);
  }
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM collector_snapshots").get() as { n: number }).n, 0);
});

test("invalid bodies, paths and methods are rejected", async () => {
  const { call } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, "{not json")).status, 400);
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, { seq: 1, snapshot: { schema_version: 1 } })).status, 400);
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, "x".repeat(1_000_001))).status, 413);
  assert.equal((await call("GET", "/v2/snapshots/mac", MAC)).status, 405);
  assert.equal((await call("GET", "/v2/view?token=" + READ)).status, 401, "a token in the URL is not accepted");
  assert.equal((await call("GET", "/", READ)).status, 404);
  assert.equal((await call("GET", "/v2/snapshot", READ)).status, 404, "no value yet");
});

test("rows past retention are deleted", async () => {
  const { call, raw, db } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture(), [obs("five_hour", 10, "2026-11-01T00:00:00Z")]), new Date("2026-11-01T00:00:00Z"));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 11, "2026-11-16T12:00:00Z")]), new Date("2026-11-16T12:00:00Z"));
  const count = (t: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  assert.equal(count("observations"), 2);
  await prune(db, new Date("2026-12-05T00:00:00Z"));
  assert.equal(count("observations"), 0, "observations older than 8 days");
  assert.equal(count("collector_snapshots"), 1, "only PCs without an update for 30 days are deleted");
});

test("Cron computes and saves derived values; GET doesn't read the observation table and reads at most 3 rows", async () => {
  const { call, raw, env } = await setup();
  const snap = fixture();
  const used = snap.providers.claude!.windows.find((w) => w.id === "five_hour")!.used_percent;
  const history = [obs("five_hour", used - 6, "2026-11-16T11:59:30.000Z"), obs("five_hour", used - 3, "2026-11-16T12:29:30.000Z")];
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snap, history))).status, 204);
  assert.equal(await runCron(env, NOW), true);
  const rows = raw.prepare("SELECT provider FROM derived_metrics ORDER BY provider").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ provider: "claude" }, { provider: "codex" }]);

  for (const path of ["/v2/view", "/v2/snapshot"]) {
    const reads: string[] = [];
    let rowsRead = 0;
    const watched: D1Like = {
      prepare(sql) {
        reads.push(sql);
        const st = env.DB.prepare(sql);
        const count = (b: typeof st): typeof st => ({
          ...b,
          bind: (...v: unknown[]) => count(b.bind(...v)),
          all: async <T>() => {
            const r = await b.all<T>();
            rowsRead += r.results.length;
            return r;
          },
          first: async <T>() => {
            const r = await b.first<T>();
            rowsRead += r ? 1 : 0;
            return r;
          },
        });
        return count(st);
      },
      batch: (statements) => env.DB.batch(statements),
    };
    const res = await handle(new Request(`https://headroom.example${path}`, { headers: { authorization: `Bearer ${READ}` } }),
      { ...env, DB: watched }, () => NOW);
    assert.equal(res.status, 200);
    assert.equal(reads.some((sql) => /FROM observations|collector_snapshots|history_boundaries/.test(sql)), false, path);
    assert.ok(rowsRead <= 3, `${path}: ${rowsRead} rows`);
    if (path === "/v2/view") {
      const v = (await res.json()) as { claude: { windows: Record<string, { recent_consumed_percent: number | null; recent_quality: string }> } };
      assert.equal(v.claude.windows.five_hour?.recent_consumed_percent, 6);
      assert.equal(v.claude.windows.five_hour?.recent_quality, "exact");
    }
  }
});

test("derived values don't mix in other providers' observations", async () => {
  const { call, env } = await setup();
  const snap = fixture();
  const used = snap.providers.claude!.windows.find((w) => w.id === "five_hour")!.used_percent;
  // Even if codex has observations with the same window id, they don't enter claude's computation
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snap, [
    obs("five_hour", 0, "2026-11-16T11:59:30.000Z", "codex"),
    obs("five_hour", used - 2, "2026-11-16T11:59:30.000Z"),
  ]));
  await runCron(env, NOW);
  const v = (await (await call("GET", "/v2/view", READ)).json()) as { claude: { windows: Record<string, { recent_consumed_percent: number | null }> } };
  assert.equal(v.claude.windows.five_hour?.recent_consumed_percent, 2);
});

test("one fetch turn holder per provider; it rotates on expiry or release, and PC names are not returned", async () => {
  const { call } = await setup();
  const at = (m: number) => new Date(NOW.getTime() + m * 60_000);
  const ask = async (token: string, pc: string, body: unknown, m: number) => {
    const res = await call("POST", `/v2/turns/${pc}`, token, body, at(m));
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(/mac|win-desktop/.test(text), false, "PC names are not returned");
    return JSON.parse(text) as Record<string, { go: boolean; wait_s: number }>;
  };
  assert.deepEqual(await ask(MAC, "mac", { claude: 7, codex: 7 }, 0), { claude: { go: true, wait_s: 0 }, codex: { go: true, wait_s: 0 } });
  assert.deepEqual(await ask(WIN, "win-desktop", { claude: 7 }, 1), { claude: { go: false, wait_s: 360 } });
  // The turn can be extended (up to 70 minutes, for the long interval while at the limit)
  assert.deepEqual(await ask(MAC, "mac", { claude: 600 }, 5), { claude: { go: true, wait_s: 0 } });
  assert.deepEqual(await ask(WIN, "win-desktop", { claude: 7 }, 6), { claude: { go: false, wait_s: 69 * 60 } });
  // On release another PC takes the turn. A release by a PC not holding the turn changes nothing
  assert.deepEqual(await ask(WIN, "win-desktop", { codex: 0 }, 6), { codex: { go: false, wait_s: 60 } });
  assert.deepEqual(await ask(MAC, "mac", { claude: 0 }, 7), { claude: { go: false, wait_s: 0 } });
  assert.deepEqual(await ask(WIN, "win-desktop", { claude: 7 }, 7), { claude: { go: true, wait_s: 0 } });
  // On expiry the turn rotates
  assert.deepEqual(await ask(WIN, "win-desktop", { codex: 7 }, 7), { codex: { go: true, wait_s: 0 } });
});

test("turn requests need a write credential for the PC's own name; invalid bodies return 400", async () => {
  const { call } = await setup();
  assert.equal((await call("POST", "/v2/turns/mac", READ, { claude: 7 })).status, 403);
  assert.equal((await call("POST", "/v2/turns/mac", WIN, { claude: 7 })).status, 403);
  assert.equal((await call("POST", "/v2/turns/mac")).status, 401);
  assert.equal((await call("GET", "/v2/turns/mac", MAC)).status, 405);
  for (const body of [{}, [], { claude: -1 }, { claude: "7" }, { other: 7 }, { claude: 2000 }, "x"]) {
    assert.equal((await call("POST", "/v2/turns/mac", MAC, body)).status, 400, JSON.stringify(body));
  }
});

test("with overlapping Crons, derived values computed from older observations and written later don't roll back", async () => {
  const { call, env } = await setup();
  const snap = fixture();
  const used = snap.providers.claude!.windows.find((w) => w.id === "five_hour")!.used_percent;
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN,
    upload(1, snap, [obs("five_hour", used - 3, "2026-11-16T12:10:00.000Z")]))).status, 204);
  // Just before Cron A (only the 12:10 observation) saves derived values, the 11:59:30 observation's upload and Cron B finish completely
  const racing = onDerivedSave(env.DB, async () => {
    const res = await call("PUT", "/v2/snapshots/win-desktop", WIN,
      upload(2, fixture(), [obs("five_hour", used - 8, "2026-11-16T11:59:30.000Z")]));
    assert.equal(res.status, 204);
    assert.equal(await runCron(env, NOW), true);
  });
  assert.equal(await runCron({ ...env, DB: racing.db }, NOW), true);
  assert.equal(racing.done(), true);
  const v = (await (await call("GET", "/v2/view", READ)).json()) as { claude: { windows: Record<string, { recent_consumed_percent: number | null }> } };
  assert.equal(v.claude.windows.five_hour?.recent_consumed_percent, 8, "the later computation (with both observations) remains");
});

test("Cron doesn't read history for providers whose merged value, observations and boundary are unchanged", async () => {
  const { call, env } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T12:00:00.000Z")]))).status, 204);
  await runCron(env, NOW);
  const reads: string[] = [];
  const watched: D1Like = {
    prepare(sql) {
      reads.push(sql);
      return env.DB.prepare(sql);
    },
    batch: (statements) => env.DB.batch(statements),
  };
  const historyReads = () => reads.filter((sql) => /FROM observations WHERE provider = \? AND first_received_at >=/.test(sql)).length;
  // Resending the same value
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), []))).status, 204);
  await runCron({ ...env, DB: watched }, NOW);
  assert.equal(historyReads(), 0, "resending the same value");
  // Only codex observations increased
  reads.length = 0;
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, fixture(), [obs("five_hour", 2, "2026-11-16T12:05:00.000Z", "codex")]))).status, 204);
  await runCron({ ...env, DB: watched }, NOW);
  assert.equal(historyReads(), 1, "only codex, which has observations");
});

test("if the daily D1 budget doesn't fit, uploads are refused without touching D1 and turns are left to each PC", async () => {
  const { call, raw } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T12:00:00.000Z")]))).status, 204);
  const used = raw.prepare("SELECT day, reads, writes FROM d1_budget").get() as { day: string; reads: number; writes: number };
  assert.equal(used.day, "2026-11-16");
  assert.ok(used.reads > 0 && used.writes > 0, "rows used are counted");

  // Less than one run's maximum remains
  raw.prepare("UPDATE d1_budget SET writes = ?").run(DAILY_BUDGET.writes - RESERVE.turn.writes + 1);
  const before = (raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  const res = await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [obs("five_hour", 2, "2026-11-16T12:05:00.000Z")]));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "d1_budget", retry_after_s: 11 * 3600 });
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, before);
  const turn = await call("POST", "/v2/turns/mac", MAC, { claude: 7 });
  assert.deepEqual(await turn.json(), { claude: { go: true, wait_s: 0 } });
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM fetch_turns").get() as { n: number }).n, 0);
  assert.equal((await call("GET", "/v2/view", READ)).status, 200, "client reads continue");

  // Restored on the next UTC day
  const next = new Date("2026-11-17T00:00:05.000Z");
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, fixture(), []), next)).status, 204);
  // The previous day's row is kept for one day (settlement target for runs that end after the day boundary)
  assert.deepEqual(raw.prepare("SELECT day FROM d1_budget ORDER BY day").all().map((r) => ({ ...r })),
    [{ day: "2026-11-16" }, { day: "2026-11-17" }]);
});

test("Cron also does nothing if the budget doesn't fit", async () => {
  const { call, raw, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T12:00:00.000Z")]));
  raw.prepare("UPDATE d1_budget SET reads = ?").run(DAILY_BUDGET.reads - RESERVE.cron.reads + 1);
  assert.equal(await runCron(env, NOW), false);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM derived_metrics").get() as { n: number }).n, 0);
});

test("even an upload that creates a boundary stays within one run's estimated D1 usage (Cron deletes the previous account's observations gradually)", async () => {
  const { call, raw, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
  // The previous account has many observations
  const insert = raw.prepare(`INSERT INTO observations
    (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 6000; i++) {
    const at = new Date(Date.parse("2026-11-16T00:00:00Z") + i * 1000).toISOString();
    insert.run("claude", "five_hour", "win-desktop", at, at, "2026-11-16T16:00:00.000Z", 10);
  }
  const before = raw.prepare("SELECT reads, writes FROM d1_budget").get() as { reads: number; writes: number };
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:31:00Z"))).status, 204);
  const after = raw.prepare("SELECT reads, writes FROM d1_budget").get() as { reads: number; writes: number };
  assert.ok(after.writes - before.writes <= RESERVE.put.writes, `writes ${after.writes - before.writes}`);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 6000, "uploads don't delete");
  assert.equal((await loadObservations(env.DB, "claude", new Date(0))).length, 0, "filtered on read");
  // One Cron run deletes up to the limit
  assert.equal(await runCron(env, new Date("2026-11-16T12:35:00Z")), true);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 6000 - 300);
});

test("budget check and reservation happen in one statement, so concurrent requests don't use the same remainder", async () => {
  const { raw, env } = await setup();
  const day = "2026-11-16";
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES (?, 0, ?)").run(day, DAILY_BUDGET.writes - RESERVE.cron.writes - 10);
  const results = await Promise.all(Array.from({ length: 5 }, () => reserve(env.DB, [day], RESERVE.cron)));
  assert.equal(results.filter((r) => r === "reserved").length, 1);
  assert.equal(results.filter((r) => r === "exhausted").length, 4);
  const used = raw.prepare("SELECT writes FROM d1_budget").get() as { writes: number };
  assert.ok(used.writes <= DAILY_BUDGET.writes);
});

test("even if Cron runs mid-upload, derived values for the new latest value are always computed by the next Cron", async () => {
  const { call, env } = await setup();
  const at = (used: number) => {
    const s = fixture();
    s.providers.claude!.windows.find((w) => w.id === "five_hour")!.used_percent = used;
    return s;
  };
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, at(10)));
  await runCron(env, NOW);
  let injected = false;
  // Cron runs just before the upload puts the new latest value (20%)
  const racing: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (!sql.includes("INSERT INTO public_state") || injected) return st;
      const bound = (...values: unknown[]) => {
        const b = st.bind(...values);
        return {
          ...b,
          run: async () => {
            injected = true;
            await runCron(env, NOW);
            return b.run();
          },
        } as typeof b;
      };
      return { ...st, bind: bound } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  const body = JSON.stringify(upload(2, at(20)));
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" }, body,
  }), { ...env, DB: racing }, () => NOW);
  assert.equal(res.status, 204);
  assert.equal(injected, true);
  await runCron(env, NOW);
  const row = (env.DB.prepare("SELECT body FROM derived_metrics WHERE provider = 'claude'"));
  const derived = JSON.parse(((await row.first<{ body: string }>())!).body) as Record<string, { used_percent: number }>;
  assert.equal(derived.five_hour?.used_percent, 20, "the next Cron computes from the new latest value");
});

test("markers are built without gaps from each PC's latest saved observation time, and resends of old observations deleted by Cron don't come back", async () => {
  const { call, raw, env } = await setup();
  // Observations from when the clock was ahead (large observed_at) are among the older ones, followed by many observations
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 95, "2026-11-16T14:00:00.000Z")]), new Date("2026-11-16T10:00:00Z"));
  for (let i = 0; i < 5; i++) {
    await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2 + i, fixture(), [obs("five_hour", 10 + i, `2026-11-16T11:0${i}:00.000Z`)]), new Date(`2026-11-16T11:0${i}:30Z`));
  }
  assert.deepEqual(raw.prepare("SELECT latest FROM observation_marks WHERE provider = 'claude'").all().map((r) => ({ ...r })),
    [{ latest: "2026-11-16T14:00:00.000Z" }]);
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:31:00Z"));
  // After Cron deletes the previous account's observations, resends of observations from when the clock was ahead don't come back
  for (let i = 0; i < 3; i++) await runCron(env, new Date("2026-11-16T12:35:00Z"));
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations WHERE provider = 'claude'").get() as { n: number }).n, 0);
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(10, fixture(), [obs("five_hour", 95, "2026-11-16T14:00:00.000Z")]), new Date("2026-11-16T12:40:00Z"));
  assert.equal((await loadObservations(env.DB, "claude", new Date(0))).length, 0);
});

test("a run starting just before 00:00 UTC reserves two days and doesn't exceed the next day's remainder", async () => {
  const { raw, env } = await setup();
  const late = new Date("2026-11-16T23:50:00Z");
  assert.deepEqual(daysToReserve(late), ["2026-11-16", "2026-11-17"]);
  assert.deepEqual(daysToReserve(new Date("2026-11-16T23:40:00Z")), ["2026-11-16"]);
  // If the next day's remainder is small, a run starting on the previous day is refused too (never reserve only one day)
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-17', 0, ?)").run(DAILY_BUDGET.writes - 100);
  assert.equal(await reserve(env.DB, daysToReserve(late), RESERVE.put), "exhausted");
  assert.equal(raw.prepare("SELECT writes FROM d1_budget WHERE day = '2026-11-16'").get() === undefined
    || (raw.prepare("SELECT writes FROM d1_budget WHERE day = '2026-11-16'").get() as { writes: number }).writes === 0, true);
  // With room, both days are reserved; if it ends on the next day, the actual amount is counted on both
  raw.prepare("UPDATE d1_budget SET writes = 0 WHERE day = '2026-11-17'").run();
  const days = daysToReserve(late);
  assert.equal(await reserve(env.DB, days, RESERVE.put), "reserved");
  // Even overlapping a run started on the next day, the reserved amount is counted
  const rows = () => raw.prepare("SELECT day, writes FROM d1_budget ORDER BY day").all().map((r) => ({ ...r })) as { day: string; writes: number }[];
  assert.deepEqual(rows().map((r) => r.writes), [RESERVE.put.writes, RESERVE.put.writes]);
  await settle(env.DB, days, RESERVE.put, { reads: 10, writes: 600 }, new Date("2026-11-17T00:00:10Z"));
  assert.deepEqual(rows().map((r) => r.writes), [608, 608]);
  // If it ends on the same day, the next day's reservation is returned
  assert.equal(await reserve(env.DB, days, RESERVE.put), "reserved");
  await settle(env.DB, days, RESERVE.put, { reads: 10, writes: 600 }, new Date("2026-11-16T23:55:00Z"));
  assert.deepEqual(rows().map((r) => r.writes), [608 * 2, 608]);
});

test("d1_budget's limit (CHECK constraint) equals DAILY_BUDGET in budget.ts", () => {
  const sql = readFileSync(new URL("../migrations/0003_derived_and_turns.sql", import.meta.url), "utf8");
  assert.match(sql, new RegExp(`reads BETWEEN 0 AND ${DAILY_BUDGET.reads}\\)`));
  assert.match(sql, new RegExp(`writes BETWEEN 0 AND ${DAILY_BUDGET.writes}\\)`));
});

test("an upload past the reserved day aborts without starting D1 statements (no budget reserved for that day)", async () => {
  const { raw, env } = await setup();
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-17', 0, ?)").run(DAILY_BUDGET.writes);
  // An upload started at 23:40 continues into the next day (no budget) midway
  let calls = 0;
  const clock = () => new Date(++calls <= 1 ? "2026-11-16T23:40:00Z" : "2026-11-17T00:01:00Z");
  const body = JSON.stringify(upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T23:39:00.000Z")]));
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" }, body,
  }), env, clock);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM collector_snapshots").get() as { n: number }).n, 0);
  const next = raw.prepare("SELECT writes FROM d1_budget WHERE day = '2026-11-17'").get() as { writes: number };
  assert.equal(next.writes, DAILY_BUDGET.writes, "the next day's budget is not used");
});

test("transient D1 failures are distinguished from budget exhaustion and don't make clients wait until 00:00 UTC", async () => {
  const { env } = await setup();
  let failed = false;
  const flaky: D1Like = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      if (!failed) {
        failed = true;
        throw new Error("D1_ERROR: Network connection lost.");
      }
      return env.DB.batch(statements);
    },
  };
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(1, fixture())),
  }), { ...env, DB: flaky }, () => NOW);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "unavailable" });
  assert.equal(await reserve(env.DB, ["2026-11-16"], RESERVE.put), "reserved", "reservation works once the failure clears");
});

test("no D1 statement starts within 60 seconds of the reserved day's end (D1 aborts a statement or batch after 30 seconds)", async () => {
  const { raw, env } = await setup();
  // Starts at 23:40 (next day not reserved) and tries to start the save batch at 23:59:10
  let calls = 0;
  const clock = () => new Date(++calls <= 1 ? "2026-11-16T23:40:00Z" : "2026-11-16T23:59:10Z");
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T23:39:00.000Z")])),
  }), env, clock);
  assert.equal(res.status, 503);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0);
  assert.equal(endOfDays(["2026-11-16"]), Date.parse("2026-11-16T23:59:00Z"));
  assert.equal(endOfDays(["2026-11-16", "2026-11-17"]), Date.parse("2026-11-17T23:59:00Z"));
});

test("a failure where D1's response was lost doesn't return the reserved amount (it may have been saved)", async () => {
  const { raw, env } = await setup();
  let lost = false;
  let batches = 0;
  // The save batch after the reservation (first batch) ran, but its response never arrives
  const lossy: D1Like = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      const results = await env.DB.batch(statements);
      if (!lost && ++batches === 2) {
        lost = true;
        throw new Error("D1_ERROR: Network connection lost.");
      }
      return results;
    },
  };
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T12:59:00.000Z")])),
  }), { ...env, DB: lossy }, () => NOW).catch(() => null);
  assert.equal(lost, true);
  void res;
  const used = raw.prepare("SELECT reads, writes FROM d1_budget").get() as { reads: number; writes: number };
  assert.ok(used.writes >= RESERVE.put.writes, `writes ${used.writes}`);
  assert.ok(used.reads >= RESERVE.put.reads, `reads ${used.reads}`);
});


/** Counts D1 calls (per D1's docs, each statement execution and each db.batch() counts as one query) */
function countQueries(db: D1Like): { db: D1Like; queries: () => number } {
  let n = 0;
  type St = ReturnType<D1Like["prepare"]>;
  const wrap = (st: St): St & { inner: St } => ({
    inner: st,
    bind: (...v: unknown[]) => wrap(st.bind(...v)),
    run: () => (n++, st.run()),
    all: <T>() => (n++, st.all<T>()),
    first: <T>() => (n++, st.first<T>()),
  });
  return {
    queries: () => n,
    db: {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: (statements) => (n++, db.batch(statements.map((s) => (s as Partial<{ inner: St }>).inner ?? s))),
    },
  };
}

test("Cloudflare free plan: at most 50 D1 queries per invocation (heavy cases of upload, turn, GET, Cron)", async () => {
  const { raw, env } = await setup();
  // Give both providers history beyond the computation limit (5,000 items) and old observations to be deleted
  const ins = raw.prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const p of ["claude", "codex"]) {
    for (let i = 0; i < 6000; i++) {
      const t = new Date(NOW.getTime() - 60_000 - i * 14_000).toISOString();
      ins.run(p, i % 2 ? "five_hour" : "seven_day", "mac", t, t, "2026-11-16T16:00:00.000Z", i % 100);
    }
    for (let i = 0; i < 700; i++) {
      const t = new Date(NOW.getTime() - 20 * 86_400_000 - i * 60_000).toISOString();
      ins.run(p, "five_hour", "mac", t, t, null, 1);
    }
  }
  raw.exec("COMMIT");
  const counted = countQueries(env.DB);
  const e = { ...env, DB: counted.db };
  const req = (method: string, path: string, token: string, body?: unknown) =>
    handle(new Request(`https://headroom.example${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }), e, () => NOW);
  const limit = 50;
  const measure = async (label: string, run: () => Promise<unknown>) => {
    const before = counted.queries();
    await run();
    const used = counted.queries() - before;
    assert.ok(used <= limit, `${label}: ${used} queries`);
  };
  const many = Array.from({ length: 200 }, (_, i) =>
    obs("five_hour", 50, new Date(NOW.getTime() - 50_000 + i * 100).toISOString(), i % 2 ? "claude" : "codex"));
  await measure("upload (200 observations)", async () => assert.equal((await req("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture(), many))).status, 204));
  await measure("turn", async () => assert.equal((await req("POST", "/v2/turns/mac", MAC, { claude: 7, codex: 7 })).status, 200));
  await measure("GET", async () => assert.equal((await req("GET", "/v2/view", READ)).status, 200));
  await measure("GET events", async () => assert.equal((await req("GET", "/v2/events", READ)).status, 200));
  await measure("Cron (compute both providers, delete old observations)", async () => assert.equal(await runCron(e, NOW), true));
  await measure("GET history", async () => assert.equal((await req("GET", "/v2/history?provider=claude", READ)).status, 200));
});

test("Workers entry: index.ts has only function named exports (exporting a number etc. keeps the Workers runtime from starting)", async () => {
  const entry = await import("../src/index.ts");
  for (const [name, value] of Object.entries(entry)) {
    if (name === "default") continue;
    assert.equal(typeof value, "function", `${name} is not a function`);
  }
});

/** Snapshot with a changed usage (Claude's 5-hour limit) */
function withSession(used: number, fetchedAt = "2026-11-16T12:59:30.000Z"): Snapshot {
  const s = fixture();
  const w = s.providers.claude!.windows.find((x) => x.id === "five_hour")!;
  w.used_percent = used;
  w.fetched_at = fetchedAt;
  return s;
}

test("Cron records an event once, and GET /v2/events returns only those after `after` with a one-row read", async () => {
  const { call, env, raw } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(85)))).status, 204);
  assert.equal(await runCron(env, NOW), true);
  // One event even if Crons overlap or repeat
  await Promise.all([runCron(env, NOW), runCron(env, NOW)]);
  const rows = raw.prepare("SELECT key, visible FROM events").all() as { key: string; visible: number }[];
  assert.deepEqual(rows.map((r) => r.key), ["threshold:claude:five_hour:2026-11-16T16:00:00.000Z:80"]);

  const first = await call("GET", "/v2/events", READ);
  assert.equal(first.status, 200);
  const body = (await first.json()) as { last_seq: number; oldest_seq: number; events: { seq: number; kind: string; used_percent: number }[] };
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0]?.kind, "threshold");
  assert.equal(body.events[0]?.used_percent, 85);
  assert.equal(body.last_seq, body.events[0]?.seq);
  const again = (await (await call("GET", `/v2/events?after=${body.last_seq}`, READ)).json()) as { events: unknown[] };
  assert.equal(again.events.length, 0, "nothing after the continuation point");

  // Crossing 95% adds only 95
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, withSession(96, "2026-11-16T13:04:30.000Z")), new Date("2026-11-16T13:05:00Z"));
  await runCron(env, new Date("2026-11-16T13:05:00Z"));
  const next = (await (await call("GET", `/v2/events?after=${body.last_seq}`, READ)).json()) as { events: { threshold: number }[] };
  assert.deepEqual(next.events.map((e) => e.threshold), [95]);

  assert.equal((await call("GET", "/v2/events?after=-1", READ)).status, 400);
  assert.equal((await call("GET", "/v2/events", MAC)).status, 403, "PCs have no read permission");
  assert.equal((await call("PUT", "/v2/events", READ)).status, 405);
});

test("GET /v2/history returns only the weekly 7-day series (provider required, hours 1-168, weekly window only)", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("seven_day", 10, "2026-11-16T12:30:00.000Z")]));
  await runCron(env, NOW);
  const res = await call("GET", "/v2/history?provider=claude&window=seven_day&hours=24", READ);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { windows: Record<string, { used_percent: number }[]> };
  assert.deepEqual(Object.keys(body.windows), ["seven_day"]);
  assert.equal((await call("GET", "/v2/history", READ)).status, 400);
  assert.equal((await call("GET", "/v2/history?provider=claude&hours=0", READ)).status, 400);
  assert.equal((await call("GET", "/v2/history?provider=claude&hours=169", READ)).status, 400, "up to 7 days (168 hours)");
  assert.equal((await call("GET", "/v2/history?provider=claude&hours=24&window=five_hour", READ)).status, 400, "weekly only");
});

test("the view shows each PC's last received time, and resends without observations don't trigger derived-value computation", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 10, "2026-11-16T12:59:30.000Z")]));
  await runCron(env, NOW);
  const versions = () => JSON.stringify(raw.prepare("SELECT provider, version FROM data_versions WHERE provider != 'all' ORDER BY provider").all());
  const before = versions();
  // Liveness resend 15 minutes later (no observations, same latest value)
  const later = new Date("2026-11-16T13:15:00Z");
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2), later)).status, 204);
  assert.equal(versions(), before, "provider change counters don't advance");
  const view = (await (await call("GET", "/v2/view", READ, undefined, new Date("2026-11-16T13:20:00Z"))).json()) as {
    last_received_at: string; collection_stopped: boolean; pcs: Record<string, { received_at: string; alive: boolean }>;
  };
  assert.equal(view.last_received_at, later.toISOString());
  assert.equal(view.collection_stopped, false);
  assert.equal(view.pcs["win-desktop"]?.alive, true);
  // After 30 minutes it's stopped. Cron creates one event
  const stoppedAt = new Date("2026-11-16T13:50:00Z");
  await runCron(env, stoppedAt);
  await runCron(env, stoppedAt);
  const kinds = raw.prepare("SELECT body FROM events").all() as { body: string }[];
  assert.deepEqual(kinds.map((r) => JSON.parse(r.body).kind), ["collection_stopped"]);
});

test("right after an upload that accepts a switch, derived values computed for the previous account are not used; a failed derived-value save is fixed by the next Cron", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 60, "2026-11-16T12:00:00.000Z")]));
  await runCron(env, NOW);
  assert.equal(await derivedNow(call, raw), true);
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, accepted))).status, 204);
  assert.equal(await derivedNow(call, raw), false, "even before Cron, derived values computed for the previous account are not used");

  // If saving derived values fails, the next Cron recomputes even without a new upload
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, fixture(), [obs("five_hour", 5, "2026-11-16T12:50:00.000Z")]));
  const flaky = onDerivedSave(env.DB, async () => { throw new Error("D1_ERROR: storage operation failed"); });
  await runCron({ ...env, DB: flaky.db }, NOW).catch(() => undefined);
  assert.equal(flaky.done(), true);
  assert.equal(await derivedNow(call, raw), false);
  await runCron(env, new Date("2026-11-16T13:05:00Z"));
  assert.equal(await derivedNow(call, raw), true, "the next Cron fills in derived values");
});

test("rebuilding events and deleting old events walk indexes and never scan everything, even with many rows", async () => {
  const { raw } = await setup();
  const plan = (sql: string) =>
    (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("2026-11-01T00:00:00Z", 500) as { detail: string }[]).map((r) => r.detail).join(" / ");
  assert.match(plan(EVENT_FEED_SQL), /USING INDEX events_visible_by_created/);
  assert.doesNotMatch(plan(EVENT_FEED_SQL), /USE TEMP B-TREE/, "doesn't read all rows for sorting");
  const prunePlan = plan("SELECT rowid FROM events WHERE keep_until < ? LIMIT ?");
  assert.match(prunePlan, /USING (COVERING )?INDEX events_by_keep_until/);
});

test("if another Cron finishes after the state was read, this Cron doesn't record (no duplicate of the same cycle under another key)", async () => {
  const { call, env, raw } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(85)))).status, 204);
  let readState = false;
  let injected = false;
  const racing: D1Like = {
    prepare(sql) {
      if (sql.includes("FROM event_state")) readState = true;
      const st = env.DB.prepare(sql);
      if (!(/^SELECT (version, )?body/.test(sql) && sql.includes("FROM public_state")) || !readState || injected) return st;
      return {
        ...st,
        first: async <T,>() => {
          injected = true;
          // A new fetch with the reset time shifted by 3 minutes arrives and another Cron finishes first
          const moved = withSession(86, "2026-11-16T13:04:30.000Z");
          moved.providers.claude!.windows.find((w) => w.id === "five_hour")!.resets_at = "2026-11-16T16:03:00.000Z";
          await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, moved), new Date("2026-11-16T13:05:00Z"));
          assert.equal(await runCron(env, new Date("2026-11-16T13:05:00Z")), true);
          return st.first<T>();
        },
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  assert.equal(await runCron({ ...env, DB: racing }, NOW), true);
  assert.equal(injected, true);
  const keys = (raw.prepare("SELECT key FROM events WHERE key LIKE 'threshold:%'").all() as { key: string }[]).map((r) => r.key);
  assert.equal(keys.length, 1, keys.join(", "));
});

test("if replacing the event list fails, events appear on the next Cron; when all expire the list is emptied and the seq doesn't go back", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(85)));
  let failed = false;
  const flaky: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (failed || !sql.startsWith("INSERT INTO event_feed")) return st;
      return {
        ...st,
        bind: (...v: unknown[]) => ({ ...st.bind(...v), run: async () => { failed = true; throw new Error("D1_ERROR"); } }),
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  await runCron({ ...env, DB: flaky }, NOW).catch(() => undefined);
  assert.equal(failed, true);
  const read = async (at: Date) =>
    (await (await call("GET", "/v2/events", READ, undefined, at)).json()) as { last_seq: number; events: unknown[] };
  assert.equal((await read(NOW)).events.length, 0, "replacement failed");
  await runCron(env, new Date("2026-11-16T13:05:00Z"));
  const after = await read(NOW);
  assert.equal(after.events.length, 1, "appears on the next Cron even without new events");
  // 9 days later: earlier events pass the display period and disappear (new ones such as a collection stop at that time appear)
  const later = new Date("2026-11-25T13:10:00Z");
  await runCron(env, later);
  const next = await read(later);
  assert.ok(next.events.every((e) => (e as { seq: number }).seq > after.last_seq), "expired events are not shown");
  // When everything is gone, empty the list. The seq doesn't go back
  raw.exec("DELETE FROM events");
  await rebuildEventFeed(env.DB, later);
  const empty = (await (await call("GET", `/v2/events?after=${next.last_seq}`, READ, undefined, later)).json()) as { last_seq: number; events: unknown[] };
  assert.equal(empty.events.length, 0);
  assert.equal(empty.last_seq, next.last_seq, "the continuation seq doesn't go back");
});

test("even if the counter update after a boundary fails, the previous account's values aren't shown and the next Cron recomputes from new observations", async () => {
  const { call, env, raw } = await setup();
  const rows = Array.from({ length: 12 }, (_, i) =>
    obs("five_hour", 30 + i * 5, new Date(Date.parse("2026-11-16T12:00:00Z") + i * 5 * 60_000).toISOString()));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(90), rows));
  await runCron(env, NOW);
  // In the upload that accepts the switch, only the statement advancing the provider counter fails
  const accepted = withSession(4, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  let failed = false;
  const flaky: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (failed || !sql.startsWith("INSERT INTO data_versions")) return st;
      return {
        ...st,
        bind: (...v: unknown[]) => {
          const b = st.bind(...v);
          if (v[0] !== "claude") return b;
          return { ...b, run: async () => { failed = true; throw new Error("D1_ERROR"); } } as typeof b;
        },
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  const at = new Date("2026-11-16T13:05:00Z");
  const put = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(2, accepted, [obs("five_hour", 4, "2026-11-16T13:04:00.000Z")])),
  }), { ...env, DB: flaky }, () => at).catch(() => null);
  void put;
  assert.equal(failed, true);
  const view = async () =>
    ((await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number; eta_minutes: number | null }> } }).claude.windows.five_hour;
  // Counters advance in the same batch as the save, so the counter alone can't fail (this upload saves nothing). A resend aligns it
  assert.equal((await view())?.used_percent, 90, "the failed upload changed nothing");
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, accepted, [obs("five_hour", 4, "2026-11-16T13:04:00.000Z")]), at)).status, 204);
  const before = await view();
  assert.equal(before?.used_percent, 4);
  assert.equal(before?.eta_minutes, null, "the previous account's forecast is not attached to the new usage");
  await runCron(env, at);
  assert.equal(await derivedNow(call, raw, at), true, "the new account's derived values appear on the next Cron without another upload");
});

test("events past retention are not shown even if an old list is written later", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(85)));
  await runCron(env, NOW);
  const later = new Date("2026-11-25T13:10:00Z");
  const body = (await (await call("GET", "/v2/events", READ, undefined, later)).json()) as { events: unknown[] };
  assert.equal(body.events.length, 0, "a 9-day-old event is not shown even if it remains in the list");
  assert.ok((raw.prepare("SELECT body FROM event_feed").get() as { body: string }).body.length > 2);
});

test("Cron's maximum writes (max windows with records and deletes overlapping, including indexes and sequence) fit the reservation", () => {
  const observationPrune = 2 * 2 * PRUNE_ROWS * 3; // provider x (retention and boundary) x (row and 2 indexes)
  const eventPrune = PRUNE_EVENTS * 4; // row, key, keep-until, visible-events indexes
  // Max events per window: at limit + 2 thresholds, or 2 thresholds + 3 near-limit + 1 sudden usage, plus 1 reset of the previous cycle
  const perWindow = 7;
  const newEvents = (2 * MAX_WINDOWS * perWindow + 2 /* stop reasons */ + 2 /* at limit */ + 1 /* collection */) * 5; // row, 3 indexes, sequence
  const rest = 2 * 2 * 2 /* derived values and series */ + 2 /* state */ + 2 /* list */ + 2 * 100 /* deleting PC latest values */ + 10 /* budget */;
  const bound = observationPrune + eventPrune + newEvents + rest;
  assert.ok(bound <= RESERVE.cron.writes, `${bound} > ${RESERVE.cron.writes}`);
});

test("even if list replacements interleave and an old list remains, the continuation seq comes from the list and unseen events are not skipped", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(85)));
  await runCron(env, NOW);
  const fresh = (await (await call("GET", "/v2/events", READ)).json()) as { last_seq: number };
  assert.ok(fresh.last_seq >= 1);
  // An old replacement was written later (the seq remains, the list is empty)
  raw.prepare("UPDATE event_feed SET body = '[]'").run();
  const stale = (await (await call("GET", "/v2/events?after=0", READ)).json()) as { last_seq: number; events: unknown[] };
  assert.equal(stale.last_seq, 0, "doesn't advance to a seq not in the list");
  await runCron(env, new Date("2026-11-16T13:05:00Z"));
  const healed = (await (await call("GET", `/v2/events?after=${stale.last_seq}`, READ)).json()) as { events: unknown[] };
  assert.equal(healed.events.length, 1, "readable after the next Cron");
});

test("a provider with a new upload after derived-value computation is not marked judged in that round", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(50)));
  await runCron(env, NOW);
  let injected = false;
  const racing: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (injected || !sql.includes("FROM event_state")) return st;
      return {
        ...st,
        first: async <T,>() => {
          injected = true;
          // A new fetch arrives after derived-value computation and before judgment
          const res = await call("PUT", "/v2/snapshots/win-desktop", WIN,
            upload(2, withSession(85, "2026-11-16T13:04:30.000Z")), new Date("2026-11-16T13:05:00Z"));
          assert.equal(res.status, 204);
          return st.first<T>();
        },
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  await runCron({ ...env, DB: racing }, new Date("2026-11-16T13:05:00Z"));
  const judgedAt = () => {
    const state = JSON.parse((raw.prepare("SELECT body FROM event_state").get() as { body: string }).body);
    return state.cycles["claude.five_hour"]?.judged_at ?? null;
  };
  assert.notEqual(judgedAt(), "2026-11-16T13:04:30.000Z", "a new fetch is not marked judged with old derived values");
  await runCron(env, new Date("2026-11-16T13:10:00Z"));
  assert.equal(judgedAt(), "2026-11-16T13:04:30.000Z", "judged on the next Cron");
  const kinds = (raw.prepare("SELECT key FROM events WHERE visible = 1").all() as { key: string }[]).map((r) => r.key);
  assert.ok(kinds.some((k) => k.startsWith("threshold:claude:five_hour")));
});

test("even if re-putting the latest value fails after saving the boundary, the previous account's values aren't shown and the next Cron aligns them", async () => {
  const { call, env, raw } = await setup();
  const rows = Array.from({ length: 12 }, (_, i) =>
    obs("five_hour", 30 + i * 5, new Date(Date.parse("2026-11-16T12:00:00Z") + i * 5 * 60_000).toISOString()));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(90), rows));
  await runCron(env, NOW);
  const accepted = withSession(4, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  let failed = false;
  const flaky: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (failed || !sql.startsWith("INSERT INTO public_state")) return st;
      return { ...st, bind: (...v: unknown[]) => ({ ...st.bind(...v), run: async () => { failed = true; throw new Error("D1_ERROR"); } }) } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  const at = new Date("2026-11-16T13:05:00Z");
  await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(2, accepted, [obs("five_hour", 4, "2026-11-16T13:04:00.000Z")])),
  }), { ...env, DB: flaky }, () => at).catch(() => null);
  assert.equal(failed, true);
  const view = async () =>
    ((await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number }> } | null }).claude;
  assert.equal(await view(), null, "the previous account's latest value (90%) is not shown");
  await runCron(env, at);
  assert.equal((await view())?.windows.five_hour?.used_percent, 4, "the next Cron aligns to the new account's value");
  assert.equal(await derivedNow(call, raw, at), true);
});

test("a pre-migration latest-value row (no boundary stamp) is re-put with boundaries by the next Cron and derived values appear", async () => {
  const { call, env, raw } = await setup();
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, accepted, [obs("five_hour", 9, "2026-11-16T12:45:00.000Z")]));
  // Revert to the pre-migration shape
  raw.exec("UPDATE public_state SET boundaries = NULL, current_boundaries = NULL");
  raw.exec("DELETE FROM derived_metrics");
  await runCron(env, NOW);
  assert.equal((await fiveHour(call))?.used_percent, 10);
  assert.equal(await derivedNow(call, raw), true, "uses derived values after re-putting with boundaries");
});

/**
 * Whether claude's derived values are computed under the current boundary (same condition as the view uses for derived values). With the 24-hour
 * series removed, this checks "don't use values computed for the previous account" and "the next Cron aligns them"
 */
async function derivedNow(call: Awaited<ReturnType<typeof setup>>["call"], raw: DatabaseSync, at = NOW): Promise<boolean> {
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { boundaries: { claude: string } };
  const row = raw.prepare("SELECT boundary FROM derived_metrics WHERE provider = 'claude'").get() as { boundary: string | null } | undefined;
  return row !== undefined && (row.boundary ?? "") === view.boundaries.claude;
}

/** claude's 5-hour window in the view */
async function fiveHour(call: Awaited<ReturnType<typeof setup>>["call"], at = NOW) {
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as {
    claude: { windows: Record<string, { used_percent: number; recent_consumed_percent: number | null }> } | null;
  };
  return view.claude?.windows.five_hour;
}

/**
 * A D1 that runs action once just before claude's derived-value save (INSERT INTO derived_metrics) (if action throws, the save fails).
 * Works for a single-statement save (run) and for a save together with other rows (batch, if the 24-hour series is restored)
 */
function onDerivedSave(db: D1Like, action: () => Promise<void>): { db: D1Like; done: () => boolean } {
  let done = false;
  const claudeSave = new WeakSet<object>();
  const once = async () => { if (!done) { done = true; await action(); } };
  return {
    done: () => done,
    db: {
      prepare(sql) {
        const st = db.prepare(sql);
        if (!sql.includes("INSERT INTO derived_metrics")) return st;
        return {
          ...st,
          bind: (...v: unknown[]) => {
            const b = st.bind(...v);
            if (v[0] !== "claude") return b;
            const wrapped = { ...b, run: async () => { await once(); return b.run(); } } as typeof b;
            claudeSave.add(wrapped);
            return wrapped;
          },
        } as typeof st;
      },
      batch: async (statements) => {
        if (statements.some((s) => claudeSave.has(s))) await once();
        return db.batch(statements);
      },
    },
  };
}

/** A D1 that fails only the latest-value row's create/replace (INSERT INTO public_state) once */
function failPublicOnce(db: D1Like): { db: D1Like; failed: () => boolean } {
  let failed = false;
  return {
    failed: () => failed,
    db: {
      prepare(sql) {
        const st = db.prepare(sql);
        if (failed || !sql.startsWith("INSERT INTO public_state")) return st;
        return { ...st, bind: (...v: unknown[]) => ({ ...st.bind(...v), run: async () => { failed = true; throw new Error("D1_ERROR"); } }) } as typeof st;
      },
      batch: (statements) => db.batch(statements),
    },
  };
}

const putWith = (env: Env, db: D1Like, token: string, collector: string, body: unknown, at: Date) =>
  handle(new Request(`https://headroom.example/v2/snapshots/${collector}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, DB: db }, () => at).catch(() => null);

test("even if an upload that read an old latest value writes after another upload's boundary, the previous account's values aren't shown", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, withSession(91)));
  const at = new Date("2026-11-16T13:05:00Z");
  const accepted = withSession(4, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  let injected = false;
  // Right after mac's upload A reads the latest value (previous account's 91%), win's upload B saves the boundary and fails to re-put the latest value
  const racing: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (injected || !sql.startsWith("SELECT collector, snapshot, received_at FROM collector_snapshots")) return st;
      return {
        ...st,
        all: async <T,>() => {
          const result = await st.all<T>();
          injected = true;
          const flaky = failPublicOnce(env.DB);
          await putWith(env, flaky.db, WIN, "win-desktop", upload(1, accepted), at);
          assert.equal(flaky.failed(), true);
          return result;
        },
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  await putWith(env, racing, MAC, "mac", upload(2, withSession(91, "2026-11-16T13:01:00.000Z")), at);
  assert.equal(injected, true);
  const claude = async () =>
    ((await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number }> } | null }).claude;
  assert.equal(await claude(), null, "the previous account's 91% is not shown");
  await runCron(env, at);
  assert.equal((await claude())?.windows.five_hour?.used_percent, 4, "the new account's value on the next Cron");
});

test("if an upload puts a new value after the re-putting Cron read the latest value, Cron doesn't overwrite it with the old value", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(91)));
  const at = new Date("2026-11-16T13:05:00Z");
  const accepted = withSession(4, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  const flaky = failPublicOnce(env.DB);
  await putWith(env, flaky.db, WIN, "win-desktop", upload(2, accepted), at);
  assert.equal(flaky.failed(), true);
  let injected = false;
  const racing: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (injected || !sql.startsWith("SELECT collector, snapshot, received_at FROM collector_snapshots")) return st;
      return {
        ...st,
        all: async <T,>() => {
          const result = await st.all<T>();
          injected = true;
          // After Cron reads 4%, a new upload puts 12%
          const res = await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, withSession(12, "2026-11-16T13:06:00.000Z")), at);
          assert.equal(res.status, 204);
          return result;
        },
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  await runCron({ ...env, DB: racing }, at);
  assert.equal(injected, true);
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number }> } };
  assert.equal(view.claude.windows.five_hour?.used_percent, 12, "the new upload's value remains");
});

test("a row whose post-boundary re-put failed before migration doesn't show the previous account's values right after migration (before the first Cron)", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(90), [obs("five_hour", 90, "2026-11-16T12:50:00.000Z")]));
  await runCron(env, NOW);
  const accepted = withSession(4, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  const at = new Date("2026-11-16T13:05:00Z");
  const flaky = failPublicOnce(env.DB);
  await putWith(env, flaky.db, WIN, "win-desktop", upload(2, accepted), at);
  // Revert to the pre-0006 shape (no stamps), then apply the 0007 migration again
  raw.exec("UPDATE public_state SET boundaries = NULL, current_boundaries = NULL; UPDATE derived_metrics SET boundary = NULL");
  const sql = readFileSync(new URL("../migrations/0007_current_boundaries.sql", import.meta.url), "utf8");
  raw.exec(sql.slice(sql.indexOf("UPDATE public_state")));
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: unknown };
  assert.equal(view.claude, null, "the previous account's 90% is not shown");
  const snapshot = (await (await call("GET", "/v2/snapshot", READ, undefined, at)).json()) as Snapshot;
  assert.equal(snapshot.providers.claude, undefined);
  const history = (await (await call("GET", "/v2/history?provider=claude", READ, undefined, at)).json()) as { windows?: Record<string, unknown[]> };
  assert.equal(history.windows?.seven_day?.length ?? 0, 0, "the previous account's points are not shown");
  await runCron(env, at);
  const fixed = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number }> } };
  assert.equal(fixed.claude.windows.five_hour?.used_percent, 4);
});

test("even if the first upload fails to create the latest-value row, the next Cron exposes the saved latest value and derived values", async () => {
  const { call, env, raw } = await setup();
  const flaky = failPublicOnce(env.DB);
  await putWith(env, flaky.db, WIN, "win-desktop", upload(1, fixture(), [obs("five_hour", 10, "2026-11-16T12:59:30.000Z")]), NOW);
  assert.equal(flaky.failed(), true);
  assert.equal((await call("GET", "/v2/snapshot", READ)).status, 404);
  await runCron(env, NOW);
  assert.equal((await call("GET", "/v2/snapshot", READ)).status, 200);
  assert.equal(await derivedNow(call, raw), true);
});

test("even if a second PC's switch at the same received time doesn't change the boundary time, excluded observations aren't used for derived values", async () => {
  const { call, env } = await setup();
  const at = new Date("2026-11-16T13:05:00Z");
  const accepted = (used: number, fetched: string) => {
    const s = withSession(used, fetched);
    s.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
    return s;
  };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted(8, "2026-11-16T13:04:00.000Z"), [obs("five_hour", 8, "2026-11-16T13:04:00.000Z")]), at);
  // win hasn't accepted the switch yet and sends the previous account's observations (after the boundary time)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(4, "2026-11-16T13:01:00.000Z"), [obs("five_hour", 4, "2026-11-16T13:01:00.000Z")]), at);
  await runCron(env, at);
  const consumed = async () => (await fiveHour(call, at))?.recent_consumed_percent ?? null;
  assert.equal(await consumed(), 4, "before the switch, computed from both PCs' observations (4% -> 8%)");
  // win also accepts the switch at the same received time (the boundary time doesn't change; only win's exclusion marker advances)
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, accepted(8, "2026-11-16T13:04:30.000Z")), at)).status, 204);
  assert.equal(await consumed(), null, "values computed from the excluded previous-account observations are not used");
  await runCron(env, at);
  assert.equal(await consumed(), null, "the next Cron doesn't use excluded observations either (once the boundary advances to the received time, earlier observations are dropped for all PCs)");
});

test("the latest value is put only if no save happened after reading (an old value never overwrites even if read order and counter order differ)", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(8)));
  const before = Number((raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get() as { version: number }).version);
  // Before the upload that read 8% puts it, another upload saved and put 12%
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, withSession(12, "2026-11-16T13:01:00.000Z")));
  assert.equal(await savePublicState(env.DB, withSession(8), before), false, "an old read is not put");
  const row = await loadPublicRow(env.DB);
  assert.equal(row?.snapshot.providers.claude?.windows.find((w) => w.id === "five_hour")?.used_percent, 12);
});

test("if the re-put of the upload that saved 12% fails and an upload that read 8% tries to put later, the next Cron aligns to 12%", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(8)));
  const flaky = failPublicOnce(env.DB);
  await putWith(env, flaky.db, WIN, "win-desktop", upload(2, withSession(12, "2026-11-16T13:01:00.000Z")), NOW);
  assert.equal(flaky.failed(), true);
  await runCron(env, NOW);
  const view = (await (await call("GET", "/v2/view", READ)).json()) as { claude: { windows: Record<string, { used_percent: number }> } };
  assert.equal(view.claude.windows.five_hour?.used_percent, 12);
});

test("change counters advance in the same batch as the save; even if the re-put fails, the next Cron aligns latest value, derived values and events", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(10), [obs("five_hour", 10, "2026-11-16T12:50:00.000Z")]));
  await runCron(env, NOW);
  // Only the latest-value re-put of the upload that saved the 96% observation fails (the counter advanced with the save)
  const flaky = failPublicOnce(env.DB);
  const at = new Date("2026-11-16T13:05:00Z");
  await putWith(env, flaky.db, WIN, "win-desktop", upload(2, withSession(96, "2026-11-16T13:04:00.000Z"), [obs("five_hour", 96, "2026-11-16T13:04:00.000Z")]), at);
  assert.equal(flaky.failed(), true);
  await runCron(env, at);
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number }> } };
  assert.equal(view.claude.windows.five_hour?.used_percent, 96);
  assert.equal(await derivedNow(call, raw, at), true);
  assert.equal((await fiveHour(call, at))?.recent_consumed_percent, 86, "computed from both observations, 10% -> 96%");
  const keys = (raw.prepare("SELECT key FROM events WHERE visible = 1").all() as { key: string }[]).map((r) => r.key);
  assert.ok(keys.some((k) => k.startsWith("threshold:claude:five_hour") && k.endsWith(":95")), keys.join(", "));
  // If the save batch fails, the counter doesn't advance either (nothing is saved)
  const v = () => (raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get() as { version: number }).version;
  const before = v();
  const broken: D1Like = { prepare: (sql) => env.DB.prepare(sql), batch: async () => { throw new Error("D1_ERROR"); } };
  await putWith(env, broken, WIN, "win-desktop", upload(3, withSession(97)), at);
  assert.equal(v(), before);
});

test("if the same switch from the same PC arrives twice concurrently, the boundary advances once and post-switch observations remain", async () => {
  const { call, env, raw } = await setup();
  const accepted = (seq: number, used: number) => {
    const s = withSession(used, "2026-11-16T12:20:00.000Z");
    s.providers.claude!.history_since = "2026-11-16T12:10:00.000Z";
    return upload(seq, s, [obs("five_hour", used, `2026-11-16T12:2${seq}:00.000Z`)]);
  };
  const at = new Date("2026-11-16T12:15:00Z");
  // After both pass the pre-check, the batches run in order
  await Promise.all([
    call("PUT", "/v2/snapshots/win-desktop", WIN, accepted(1, 39), at),
    call("PUT", "/v2/snapshots/win-desktop", WIN, accepted(2, 40), new Date("2026-11-16T12:25:00Z")),
  ]);
  const epoch = raw.prepare("SELECT epoch FROM boundary_epochs WHERE provider = 'claude'").get() as { epoch: number };
  assert.equal(epoch.epoch, 1, "the same acceptance only once");
  await runCron(env, new Date("2026-11-16T12:30:00Z"));
  assert.equal(await derivedNow(call, raw, new Date("2026-11-16T12:30:00Z")), true);
  assert.equal((await fiveHour(call, new Date("2026-11-16T12:30:00Z")))?.recent_consumed_percent, 1, "the two post-switch observations (39% -> 40%) remain");
});

test("even if Cron runs between saving a switch and re-putting the latest value, no forecast computed from the previous account's latest value is shown", async () => {
  const { call, env } = await setup();
  const rows = Array.from({ length: 12 }, (_, i) =>
    obs("five_hour", 35 + i * 5, new Date(Date.parse("2026-11-16T12:00:00Z") + i * 5 * 60_000).toISOString()));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(90), rows));
  await runCron(env, NOW);
  const at = new Date("2026-11-16T13:05:00Z");
  const accepted = withSession(60, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  let injected = false;
  // After the upload saves and before the latest value is re-put (where the global counter is read), Cron runs to completion
  const racing: D1Like = {
    prepare(sql) {
      const st = env.DB.prepare(sql);
      if (injected || !sql.startsWith("SELECT version FROM data_versions")) return st;
      return {
        ...st,
        bind: (...v: unknown[]) => {
          const b = st.bind(...v);
          if (v[0] !== "all" || injected) return b;
          return {
            ...b,
            first: async <T,>() => {
              injected = true;
              assert.equal(await runCron(env, at), true);
              return b.first<T>();
            },
          } as typeof b;
        },
      } as typeof st;
    },
    batch: (statements) => env.DB.batch(statements),
  };
  assert.equal((await putWith(env, racing, WIN, "win-desktop", upload(2, accepted, [obs("five_hour", 60, "2026-11-16T13:04:00.000Z")]), at))?.status, 204);
  assert.equal(injected, true);
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { used_percent: number; eta_minutes: number | null }> } };
  assert.equal(view.claude.windows.five_hour?.used_percent, 60);
  assert.equal(view.claude.windows.five_hour?.eta_minutes, null, "no forecast computed from the previous account's 90%");
});

test("with the same provider counter, a computation from an old latest value finishing later doesn't overwrite one from the new latest value", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(10), [obs("five_hour", 10, "2026-11-16T12:50:00.000Z")]));
  await runCron(env, NOW);
  // 90% is saved but not yet put into the latest-value row (the provider counter has advanced)
  const clean = sanitizeUpload(upload(2, withSession(90, "2026-11-16T13:01:00.000Z"), [obs("five_hour", 90, "2026-11-16T13:01:00.000Z")]), "win-desktop");
  assert.ok(!("error" in clean));
  await saveUpload(env.DB, clean as Exclude<typeof clean, { error: string }>, NOW);
  // Computation A reads the old latest value (10%) and stops just before saving. Meanwhile the latest value is re-put and computation B saves with 90%
  const racing = onDerivedSave(env.DB, async () => {
    await repairPublicState(env.DB, env);
    await refreshDerived(env.DB, env, NOW);
  });
  await refreshDerived(racing.db, env, NOW);
  assert.equal(racing.done(), true);
  const body = JSON.parse((raw.prepare("SELECT body FROM derived_metrics WHERE provider = 'claude'").get() as { body: string }).body);
  assert.equal(body.five_hour.used_percent, 90, "the value computed from the new latest value remains");
});


test("a computation whose provider counter and latest-value row counter disagree in age doesn't overwrite the saved value", async () => {
  const { env, raw } = await setup();
  const metrics = (used: number) => ({ five_hour: { fetched_at: null, resets_at: null, used_percent: used, metrics: {} } }) as never;
  // Computed from the new latest value (counter 2): provider counter 1
  await saveDerived(env.DB, "claude", metrics(90), 1, NOW, "", null, 2);
  // Computed from the old latest value (counter 1): provider counter 2 (newer observations but older latest value)
  await saveDerived(env.DB, "claude", metrics(10), 2, NOW, "", null, 1);
  const body = JSON.parse((raw.prepare("SELECT body FROM derived_metrics WHERE provider = 'claude'").get() as { body: string }).body);
  assert.equal(body.five_hour.used_percent, 90);
  // A computation with neither counter smaller (the next Cron) replaces it
  await saveDerived(env.DB, "claude", metrics(91), 2, NOW, "", null, 2);
  assert.equal(JSON.parse((raw.prepare("SELECT body FROM derived_metrics WHERE provider = 'claude'").get() as { body: string }).body).five_hour.used_percent, 91);
});

test("GET /v2/view returns the counter (data_version) of the latest-value row it read, which grows with every save", async () => {
  const { call } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(10)));
  const a = (await (await call("GET", "/v2/view", READ)).json()) as { data_version: number };
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, withSession(12, "2026-11-16T13:01:00.000Z")));
  const b = (await (await call("GET", "/v2/view", READ)).json()) as { data_version: number };
  assert.ok(Number.isSafeInteger(a.data_version) && b.data_version > a.data_version, `${a.data_version} → ${b.data_version}`);
});

test("even if re-putting the latest value fails after saving the boundary, the response without the previous account's values has a larger data_version than before", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(90)));
  const before = (await (await call("GET", "/v2/view", READ)).json()) as { data_version: number; claude: unknown };
  assert.ok(before.claude);
  const accepted = withSession(4, "2026-11-16T13:04:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
  const flaky = failPublicOnce(env.DB);
  await putWith(env, flaky.db, WIN, "win-desktop", upload(2, accepted), new Date("2026-11-16T13:05:00Z"));
  assert.equal(flaky.failed(), true);
  const after = (await (await call("GET", "/v2/view", READ)).json()) as { data_version: number; claude: unknown };
  assert.equal(after.claude, null, "the previous account's values are removed");
  assert.ok(after.data_version > before.data_version, `${before.data_version} → ${after.data_version}`);
});

test("a boundary-only response's counter is always smaller than the response with that upload's body; migration 0011 fills counters of existing rows", async () => {
  assert.equal(dataVersionOf(10, 5), 20, "the body has caught up");
  assert.equal(dataVersionOf(10, 11), 21, "only the boundary advanced");
  assert.equal(dataVersionOf(11, 11), 22, "after putting the same upload's body");
  assert.ok(dataVersionOf(10, 11) > dataVersionOf(10, 10));
  // Pre-migration row (no current_version; only the boundary had advanced)
  const { call, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(90)));
  raw.exec(`UPDATE public_state SET current_version = NULL, boundaries = '{}', current_boundaries = '{"claude":"x#1"}'`);
  raw.exec(`UPDATE data_versions SET version = version + 5 WHERE provider = 'all'`);
  const sql = readFileSync(new URL("../migrations/0011_current_version.sql", import.meta.url), "utf8");
  raw.exec(sql.slice(sql.indexOf("UPDATE public_state")));
  const row = raw.prepare("SELECT version, current_version FROM public_state").get() as { version: number; current_version: number };
  const all = (raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get() as { version: number }).version;
  assert.equal(row.current_version, all, "a row where only the boundary had advanced gets the current global counter");
  assert.ok(dataVersionOf(row.version, row.current_version) > 2 * row.version);
});

test("view and history return boundary stamps of the same shape, which change after a switch (no account information)", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("seven_day", 60, "2026-11-16T12:00:00.000Z")]));
  await runCron(env, NOW);
  const view = async () => ((await (await call("GET", "/v2/view", READ)).json()) as { boundaries: Record<string, string> }).boundaries;
  const history = async () => ((await (await call("GET", "/v2/history?provider=claude", READ)).json()) as { boundary: string }).boundary;
  const before = await view();
  assert.equal(before.claude, await history());
  assert.match(before.claude!, /^([0-9TZ:.-]*#\d+)?$/, "only time and sequence number (empty if no boundary yet)");
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, accepted, [obs("seven_day", 4, "2026-11-16T12:45:00.000Z")]));
  await runCron(env, new Date("2026-11-16T13:05:00Z"));
  const after = await view();
  assert.notEqual(after.claude, before.claude, "the stamp changes after a switch");
  assert.match(after.claude!, /^[0-9TZ:.-]+#\d+$/, "accepted time and sequence number");
  assert.equal(after.claude, await history());
});

test("old-format derived values (without rate_pace) are recomputed by the next Cron even without new observations", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 60, "2026-11-16T12:00:00.000Z")]));
  await runCron(env, NOW);
  // Mimic a row put by an earlier Worker version: no rate_pace field and no format version in the basis
  const row = raw.prepare("SELECT body, basis FROM derived_metrics WHERE provider = 'claude'").get() as { body: string; basis: string };
  const drop = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(drop);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "rate_pace").map(([k, x]) => [k, drop(x)]));
    return v;
  };
  assert.match(row.basis, /^2:/, "format version in the basis");
  raw.prepare("UPDATE derived_metrics SET body = ?, basis = ? WHERE provider = 'claude'").run(JSON.stringify(drop(JSON.parse(row.body))), row.basis.replace(/^\d+:/, ""));
  const view = async () => ((await (await call("GET", "/v2/view", READ)).json()) as { claude: { windows: Record<string, Record<string, unknown>> } }).claude.windows.five_hour!;
  assert.equal("rate_pace" in (await view()), false, "still the old format");
  await runCron(env, new Date("2026-11-16T13:05:00Z"));
  assert.equal("rate_pace" in (await view()), true, "recomputed");
});

test("uploads put hourly weekly-limit aggregates, Cron builds the 7-day series once an hour, and GET reads only 2 rows", async () => {
  const { call, env, raw } = await setup();
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 16, h, m)).toISOString();
  const week = (used: number, observed: string) => ({ ...obs("seven_day", used, observed), resets_at: "2026-11-20T07:00:00.000Z" });
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [week(10, at(10, 5)), week(11, at(10, 35)), week(12, at(11, 5)), obs("five_hour", 30, at(11, 5))]));
  const hourly = () => raw.prepare("SELECT window_id, hour, used_percent FROM observation_hourly WHERE provider = 'claude' ORDER BY hour").all() as { window_id: string; hour: string; used_percent: number }[];
  assert.deepEqual(hourly().map((r) => [r.window_id, r.hour, r.used_percent]), [["seven_day", "2026-11-16T10", 11], ["seven_day", "2026-11-16T11", 12]], "newest observation per hour; the 5h window is not aggregated");
  // A resend of an old observation doesn't replace a newer aggregate
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [week(9, at(10, 1))]));
  assert.equal(hourly()[0]!.used_percent, 11);
  await runCron(env, new Date(at(12, 0)));
  const read = async () => (await (await call("GET", "/v2/history?provider=claude&hours=168", READ)).json()) as { boundary: string; windows: Record<string, { used_percent: number }[]> };
  assert.deepEqual((await read()).windows.seven_day!.map((p) => p.used_percent), [11, 12]);
  // A Cron in the same hour (12:xx UTC) doesn't rebuild (doesn't read the aggregate table)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, fixture(), [week(13, at(12, 5))]));
  const original = env.DB;
  let reads = 0;
  env.DB = {
    prepare: (sql: string) => {
      if (sql.includes("SELECT observed_at, used_percent, resets_at FROM observation_hourly")) reads++;
      return original.prepare(sql);
    },
    batch: (s: Parameters<D1Like["batch"]>[0]) => original.batch(s),
  } as D1Like;
  await runCron(env, new Date(at(12, 10)));
  env.DB = original;
  assert.equal(reads, 0, "a Cron in the same hour doesn't read aggregates");
  assert.deepEqual((await read()).windows.seven_day!.map((p) => p.used_percent), [11, 12]);
  await runCron(env, new Date(at(13, 0)));
  assert.deepEqual((await read()).windows.seven_day!.map((p) => p.used_percent), [11, 12, 13], "rebuilt in the next hour");
});


const weekObs = (used: number, observed: string) => ({ ...obs("seven_day", used, observed), resets_at: "2026-11-20T07:00:00.000Z" });
const hourlyOf = (raw: ReturnType<typeof sqliteD1>["raw"]) =>
  raw.prepare("SELECT hour, used_percent, collector FROM observation_hourly WHERE provider = 'claude' ORDER BY hour").all() as { hour: string; used_percent: number; collector: string }[];

test("upload aggregation doesn't read the observation table (built from the observations in that upload)", async () => {
  const { env } = await setup();
  const original = env.DB;
  const sqls: string[] = [];
  env.DB = {
    prepare: (sql: string) => (sqls.push(sql), original.prepare(sql)),
    batch: (s: Parameters<D1Like["batch"]>[0]) => original.batch(s),
  } as D1Like;
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(1, fixture(), [weekObs(10, "2026-11-16T12:30:00.000Z")])),
  }), env, () => NOW);
  env.DB = original;
  assert.equal(res.status, 204);
  const rollup = sqls.filter((s) => s.includes("INSERT INTO observation_hourly"));
  assert.equal(rollup.length, 1);
  // The observation table is only looked up by rows equal on every primary-key column (no scan)
  const lookups = rollup[0]!.match(/FROM observations o\s+WHERE[^)]*/g) ?? [];
  const pk = /o\.provider = v\.column1 AND o\.window_id = v\.column2 AND o\.collector = v\.column3 AND o\.observed_at = v\.column4/;
  assert.ok(lookups.length > 0 && lookups.every((l) => pk.test(l)), rollup[0]);
  assert.equal((rollup[0]!.match(/FROM\s+observations\b/g) ?? []).length, lookups.length, "the observation table is read only by primary-key lookups");
});

test("aggregated times are limited to 8 days before through 5 minutes after receipt (future or too-old observations don't add rows)", async () => {
  const { call, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [
    weekObs(10, "2026-11-16T12:30:00.000Z"),
    weekObs(11, "2026-11-16T14:00:00.000Z"),
    weekObs(12, "2026-11-01T00:00:00.000Z"),
  ]));
  assert.deepEqual(hourlyOf(raw).map((r) => r.hour), ["2026-11-16T12"]);
});

test("pre-switch observations from a PC with a fast clock don't mix into the post-switch weekly trend", async () => {
  const { call, env, raw } = await setup();
  // win-desktop (clock ahead) sends a pre-switch 90% at 12:00, recorded as 12:10
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [weekObs(90, "2026-11-16T12:10:00.000Z")]), new Date("2026-11-16T12:00:00Z"));
  // mac accepts the switch at 12:05 and sends 3%
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-16T12:05:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted, [weekObs(3, "2026-11-16T12:05:00.000Z")]), new Date("2026-11-16T12:05:00Z"));
  assert.deepEqual(hourlyOf(raw).map((r) => [r.hour, r.used_percent, r.collector]), [["2026-11-16T12", 3, "mac"]], "the pre-switch representative of the boundary hour is removed and replaced by the post-switch observation");
  await runCron(env, new Date("2026-11-16T13:00:00Z"));
  const res = await call("GET", "/v2/history?provider=claude&hours=168", READ, undefined, new Date("2026-11-16T13:00:00Z"));
  const body = (await res.json()) as { windows: Record<string, { used_percent: number }[]> };
  assert.deepEqual(body.windows.seven_day!.map((p) => p.used_percent), [3]);
});

test("late-finishing old computations and computations after a boundary move don't replace the 7-day series", async () => {
  const { call, db } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [weekObs(10, "2026-11-16T12:30:00.000Z")]));
  const point = (used: number) => [{ at: "2026-11-16T12:30:00.000Z", used_percent: used, resets_at: null, break: null }];
  await saveWeekly(db, "claude", point(12), "", "2026-11-16T12", new Date("2026-11-16T12:00:00Z"));
  await saveWeekly(db, "claude", point(11), "", "2026-11-16T11", new Date("2026-11-16T11:55:00Z"));
  assert.equal((await loadWeekly(db, "claude"))!.series[0]!.used_percent, 12, "an old computation doesn't replace");
  await saveWeekly(db, "claude", point(99), "2026-11-16T12:00:00.000Z#9", "2026-11-16T13", new Date("2026-11-16T13:00:00Z"));
  assert.equal((await loadWeekly(db, "claude"))!.series[0]!.used_percent, 12, "a computation with a stamp differing from the current boundary is not put");
});

test("observations at the same time are aggregated by PC priority, not arrival order", async () => {
  for (const order of [["mac", "win"], ["win", "mac"]] as const) {
    const { call, raw } = await setup();
    for (const [i, pc] of order.entries()) {
      const used = pc === "win" ? 20 : 60;
      await call("PUT", `/v2/snapshots/${pc === "win" ? "win-desktop" : "mac"}`, pc === "win" ? WIN : MAC, upload(i + 1, fixture(), [weekObs(used, "2026-11-16T12:30:00.000Z")]));
    }
    assert.equal(hourlyOf(raw)[0]!.used_percent, 20, `value from the higher-priority win-desktop (${order.join(" → ")})`);
  }
});

test("an aggregation statement gets at most 100 values (even with many hours and a 200-item upload)", async () => {
  const { env } = await setup();
  const original = env.DB;
  const counts: number[] = [];
  const wrapStatement = (st: ReturnType<D1Like["prepare"]>, sql: string): ReturnType<D1Like["prepare"]> => ({
    ...st,
    bind: (...v: unknown[]) => {
      if (sql.includes("INSERT INTO observation_hourly")) counts.push(v.length);
      return st.bind(...v);
    },
  });
  env.DB = { prepare: (sql: string) => wrapStatement(original.prepare(sql), sql), batch: (s: Parameters<D1Like["batch"]>[0]) => original.batch(s) } as D1Like;
  const rows = Array.from({ length: 200 }, (_, i) => weekObs(10, new Date(Date.parse("2026-11-16T12:59:00Z") - i * 30 * 60_000).toISOString()));
  const res = await handle(new Request("https://headroom.example/v2/snapshots/win-desktop", {
    method: "PUT", headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
    body: JSON.stringify(upload(1, fixture(), rows)),
  }), env, () => NOW);
  env.DB = original;
  assert.equal(res.status, 204);
  assert.ok(counts.length > 1 && counts.every((n) => n <= 100), JSON.stringify(counts));
});

test("aggregates use the saved observation values; the time is the earlier of observation and first receipt (no future points)", async () => {
  const { call, raw } = await setup();
  // At 12:00, a 10% recorded by the PC as 12:04 arrives (clock ahead)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [weekObs(10, "2026-11-16T12:04:00.000Z")]), new Date("2026-11-16T12:00:00Z"));
  // A resend of the same observation (same unique key) with a different value isn't saved (and doesn't change the aggregate)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [weekObs(90, "2026-11-16T12:04:00.000Z")]), new Date("2026-11-16T12:01:00Z"));
  const rows = raw.prepare("SELECT hour, used_percent, effective_at AS observed_at FROM observation_hourly").all() as { hour: string; used_percent: number; observed_at: string }[];
  assert.deepEqual(rows.map((r) => [r.hour, r.used_percent, r.observed_at]), [["2026-11-16T12", 10, "2026-11-16T12:00:00.000Z"]]);
});

/** Aligns snapshot fetch times (so per-PC exclusion markers land on times set by the test) */
function snapAt(iso: string): Snapshot {
  const s = fixture();
  s.generated_at = iso;
  for (const p of Object.values(s.providers)) {
    if (!p) continue;
    p.fetched_at = iso;
    for (const w of p.windows) w.fetched_at = iso;
  }
  return s;
}

test("at most 16 writing PCs (a config over the limit accepts no credential)", () => {
  const entry = (i: number) => ({ name: `pc${i}`, sha256: "a".repeat(64), role: "write", collector: `pc-${i}` });
  assert.equal(parseTokens(JSON.stringify(Array.from({ length: MAX_COLLECTORS }, (_, i) => entry(i)))).length, MAX_COLLECTORS);
  assert.deepEqual(parseTokens(JSON.stringify(Array.from({ length: MAX_COLLECTORS + 1 }, (_, i) => entry(i)))), []);
});

test("per-PC exclusion is checked by the observation time the PC recorded (valid points aren't removed by the clamped time)", async () => {
  const { call, env, raw } = await setup();
  const t = (m: number) => `2026-11-16T12:${String(m).padStart(2, "0")}:00.000Z`;
  // An observation win (clock ahead) recorded as 12:04 at 12:00
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt(t(4)), [weekObs(10, t(4))]), new Date(t(0)));
  // mac accepts the switch at 12:02 (win's exclusion marker is 12:04)
  const accepted = snapAt(t(2));
  accepted.providers.claude!.history_since = t(2);
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted, []), new Date(t(2)));
  // An observation win recorded as 12:06 at 12:03 (after 12:04, so valid; clamped time 12:03)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, snapAt(t(6)), [weekObs(11, t(6))]), new Date(t(3)));
  await runCron(env, new Date("2026-11-16T13:00:00Z"));
  const body = (await (await call("GET", "/v2/history?provider=claude&hours=168", READ, undefined, new Date("2026-11-16T13:00:00Z"))).json()) as { windows: Record<string, { used_percent: number; at: string }[]> };
  assert.deepEqual(body.windows.seven_day!.map((p) => [p.used_percent, p.at]), [[11, t(3)]]);
  assert.equal(hourlyOf(raw).length, 1);
});

test("if the current representative is invalid under the current boundary, even an older valid candidate replaces it", async () => {
  const { call, raw } = await setup();
  // Boundary 12:30, win's exclusion marker 12:55. win's 12:50 representative is invalid
  raw.prepare("INSERT INTO history_boundaries (provider, since, collector) VALUES ('claude', '2026-11-16T12:30:00.000Z', 'mac')").run();
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('claude', 'win-desktop', '2026-11-16T12:55:00.000Z')").run();
  raw.prepare(`INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
    VALUES ('claude', 'seven_day', '2026-11-16T12', 60, NULL, '2026-11-16T12:50:00.000Z', '2026-11-16T12:50:00.000Z', '2026-11-16T12:50:00.000Z', 'win-desktop', 0)`).run();
  // mac sends a valid 12:40 observation at 13:00
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snapAt("2026-11-16T12:40:00.000Z"), [weekObs(3, "2026-11-16T12:40:00.000Z")]), new Date("2026-11-16T13:00:00Z"));
  assert.deepEqual(hourlyOf(raw).map((r) => [r.hour, r.used_percent, r.collector]), [["2026-11-16T12", 3, "mac"]]);
});

test("the hour bucket is decided by the saved first receipt (a resent observation doesn't drop a point from another hour)", async () => {
  const { call, raw } = await setup();
  // An observation recorded as 13:01 at 12:59 (clamped 12:59 -> the 12:xx hour)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [weekObs(10, "2026-11-16T13:01:00.000Z")]), new Date("2026-11-16T12:59:00Z"));
  // At 13:05, its resend and a new 13:00 observation
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [weekObs(10, "2026-11-16T13:01:00.000Z"), weekObs(12, "2026-11-16T13:00:00.000Z")]), new Date("2026-11-16T13:05:00Z"));
  assert.deepEqual(hourlyOf(raw).map((r) => [r.hour, r.used_percent]), [["2026-11-16T12", 10], ["2026-11-16T13", 12]]);
});

test("when registrable PC names are used up, uploads under a new name are refused without writing anything (registered names are accepted)", async () => {
  const { call, raw } = await setup();
  const register = raw.prepare("INSERT INTO collector_names (name, slot) VALUES (?, ?)");
  register.run("win-desktop", 0);
  for (let i = 1; i < MAX_STORED_COLLECTORS; i++) register.run(`old-${i}`, i);
  const before = dumpAll(raw);
  const res = await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture(), [weekObs(10, "2026-11-16T12:50:00.000Z")]));
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "collector_limit" });
  raw.prepare("DELETE FROM d1_budget").run(); // Exclude budget records
  assert.equal(dumpAll(raw), before, "no observations, markers, latest values or registrations are written");
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1))).status, 204, "registered names are accepted");
});

test("a registered name keeps its slot after its latest value expires, and its acceptance records and exclusion markers remain", async () => {
  const { call, db, raw } = await setup();
  const accepted = snapAt("2026-11-16T12:56:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:30:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted, []), new Date("2026-11-16T13:00:00Z"));
  assert.deepEqual(raw.prepare("SELECT name, slot FROM collector_names").all().map((r) => ({ ...r })), [{ name: "mac", slot: 0 }]);
  // After the latest value expires 31 days later, registration and acceptance records remain (a resend of the same history_since isn't a new switch)
  await prune(db, new Date("2026-12-17T13:00:00Z"));
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_snapshots").get() as { n: number }).n, 0);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_names").get() as { n: number }).n, 1);
  const epoch = () => (raw.prepare("SELECT epoch FROM boundary_epochs WHERE provider = 'claude'").get() as { epoch: number }).epoch;
  const before = epoch();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, accepted, []), new Date("2026-12-17T13:05:00Z"));
  assert.equal(epoch(), before, "a resend of a past acceptance doesn't advance the boundary");
  assert.deepEqual(raw.prepare("SELECT name, slot FROM collector_names").all().map((r) => ({ ...r })), [{ name: "mac", slot: 0 }], "not re-registered");
});

test("even if concurrent new names race for the last number, the limit isn't exceeded and refused uploads write nothing", async () => {
  const { call, raw } = await setup();
  const register = raw.prepare("INSERT INTO collector_names (name, slot) VALUES (?, ?)");
  for (let i = 0; i < MAX_STORED_COLLECTORS - 1; i++) register.run(`old-${i}`, i);
  const [mac, win] = await Promise.all([
    call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture(), [weekObs(10, "2026-11-16T12:50:00.000Z")])),
    call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [weekObs(20, "2026-11-16T12:50:00.000Z")])),
  ]);
  assert.deepEqual([mac.status, win.status].sort(), [204, 403]);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_names").get() as { n: number }).n, MAX_STORED_COLLECTORS);
  const winner = mac.status === 204 ? "mac" : "win-desktop";
  assert.deepEqual(raw.prepare("SELECT DISTINCT collector FROM observations").all().map((r) => ({ ...r })), [{ collector: winner }]);
  assert.deepEqual(raw.prepare("SELECT collector FROM collector_snapshots").all().map((r) => ({ ...r })), [{ collector: winner }]);
});

test("migration 0012 registers existing PC names (without reading the observation table)", () => {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  for (const n of names.filter((n) => n < "0012")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  raw.prepare("INSERT INTO collector_snapshots (collector, seq, snapshot, received_at) VALUES ('mac', 1, '{}', '2026-11-16T12:00:00.000Z')").run();
  raw.prepare("INSERT INTO observation_marks (provider, collector, latest) VALUES ('claude', 'win-desktop', '2026-11-16T12:00:00.000Z')").run();
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('codex', 'win-desktop', '2026-11-16T12:00:00.000Z')").run();
  for (const n of names.filter((n) => n >= "0012")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  assert.deepEqual(raw.prepare("SELECT name, slot FROM collector_names ORDER BY slot").all().map((r) => ({ ...r })), [{ name: "mac", slot: 0 }, { name: "win-desktop", slot: 1 }]);
});

test("even with many saved names, acceptance exclusion markers are created for every PC (pre-switch values don't remain in the weekly trend)", async () => {
  const { call, env, raw } = await setup();
  // win's pre-switch 90% (12:40)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T12:40:00.000Z"), [weekObs(90, "2026-11-16T12:40:00.000Z")]), new Date("2026-11-16T12:40:00Z"));
  // 32 names of removed PCs (observation marks at 12:50)
  const mark = raw.prepare("INSERT INTO observation_marks (provider, collector, latest) VALUES ('claude', ?, '2026-11-16T12:50:00.000Z')");
  for (let i = 0; i < 32; i++) mark.run(`old-${i}`);
  // mac accepts boundary 12:10 at 13:00
  const accepted = snapAt("2026-11-16T13:00:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:10:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted, []), new Date("2026-11-16T13:00:00Z"));
  const win = raw.prepare("SELECT until FROM boundary_watermarks WHERE provider = 'claude' AND collector = 'win-desktop'").get() as { until: string } | undefined;
  assert.ok(win !== undefined && win.until >= "2026-11-16T12:40:00.000Z", "win's exclusion marker");
  await runCron(env, new Date("2026-11-16T13:00:00Z"));
  const body = (await (await call("GET", "/v2/history?provider=claude&hours=168", READ, undefined, new Date("2026-11-16T13:00:00Z"))).json()) as { windows: Record<string, { used_percent: number }[]> };
  assert.deepEqual((body.windows.seven_day ?? []).map((p) => p.used_percent), [], "the pre-switch 90% is not returned");
});

test("among observations with the same time and priority, the one with the newer PC-recorded observation time is the representative (regardless of arrival order)", async () => {
  const at = new Date("2026-11-16T12:00:00Z");
  for (const order of [[0, 1], [1, 0]]) {
    const { call, raw } = await setup();
    const list = [weekObs(10, "2026-11-16T12:01:00.000Z"), weekObs(40, "2026-11-16T12:04:00.000Z")];
    await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), order.map((i) => list[i])), at);
    assert.deepEqual(hourlyOf(raw).map((r) => [r.hour, r.used_percent]), [["2026-11-16T12", 40]], `order ${order}`);
  }
  // Comparison with the saved representative works the same (replaced by a newer one, not by an older one)
  for (const [stored, incoming, expected] of [["12:01", "12:04", 40], ["12:04", "12:01", 40]] as const) {
    const { call, raw } = await setup();
    raw.prepare(`INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
      VALUES ('claude', 'seven_day', '2026-11-16T12', ?, NULL, ?, '2026-11-16T12:00:00.000Z', '2026-11-16T12:00:00.000Z', 'win-desktop', 0)`)
      .run(stored === "12:01" ? 10 : 40, `2026-11-16T${stored}:00.000Z`);
    await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [weekObs(stored === "12:01" ? 40 : 10, `2026-11-16T${incoming}:00.000Z`)]), at);
    assert.deepEqual(hourlyOf(raw).map((r) => r.used_percent), [expected], `saved ${stored}, incoming ${incoming}`);
  }
});

test("migration 0012 fails on an old D1 with more than 32 names (stops reading at 33 distinct names per table)", () => {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  for (const n of names.filter((n) => n < "0012")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  const source = raw.prepare("INSERT INTO boundary_sources (provider, collector, source) VALUES ('claude', ?, '2026-11-16T12:00:00.000Z')");
  for (let i = 0; i < 1000; i++) source.run(`pc-${String(i).padStart(4, "0")}`);
  assert.throws(() => {
    for (const n of names.filter((n) => n >= "0012")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  }, /CHECK constraint failed/);
});

test("an old-seq resend after the latest value expired at 30 days doesn't advance the boundary or rebuild the latest value", async () => {
  const { call, db, raw } = await setup();
  const accept = (since: string) => {
    const s = snapAt(since);
    s.providers.claude!.history_since = since;
    return s;
  };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accept("2026-11-16T12:00:00.000Z")), new Date("2026-11-16T12:00:00Z"));
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, accept("2026-11-16T12:30:00.000Z")), new Date("2026-11-16T12:30:00Z"));
  await prune(db, new Date("2026-12-17T13:00:00Z"));
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_snapshots").get() as { n: number }).n, 0);
  const boundary = () => ({ ...(raw.prepare("SELECT since FROM history_boundaries b JOIN boundary_epochs e USING (provider) WHERE provider = 'claude'").get() as object) });
  const epoch = () => (raw.prepare("SELECT epoch FROM boundary_epochs WHERE provider = 'claude'").get() as { epoch: number }).epoch;
  const [since, before] = [boundary(), epoch()];
  const res = await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accept("2026-11-16T12:00:00.000Z")), new Date("2026-12-17T13:05:00Z"));
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "stale_seq", seq: 2 });
  assert.deepEqual([boundary(), epoch()], [since, before], "boundary and acceptance epoch unchanged");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_snapshots").get() as { n: number }).n, 0, "the latest value is not rebuilt");
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(3), new Date("2026-12-17T13:10:00Z"))).status, 204, "a new seq is accepted");
});

test("if the same name gets registered right after seeing the names full, the upload is saved rather than refused", async () => {
  const { db, raw } = await setup();
  const register = raw.prepare("INSERT INTO collector_names (name, slot) VALUES (?, ?)");
  for (let i = 0; i < MAX_STORED_COLLECTORS - 1; i++) register.run(`old-${i}`, i);
  let injected = false;
  // Right after checking the name (not there yet), another upload under the same name finishes registering with the last number
  const racing: D1Like = {
    prepare(sql) {
      const st = db.prepare(sql);
      if (!sql.startsWith("SELECT seq FROM collector_names") || injected) return st;
      injected = true;
      return {
        ...st,
        bind: (...values: unknown[]) => {
          const b = st.bind(...values);
          return {
            ...b,
            all: async <T>() => {
              const rows = await b.all<T>();
              register.run("mac", MAX_STORED_COLLECTORS - 1);
              return rows;
            },
          } as typeof b;
        },
      } as typeof st;
    },
    batch: (statements) => db.batch(statements),
  };
  const u = sanitizeUpload(upload(5, fixture(), [weekObs(10, "2026-11-16T12:50:00.000Z")]), "mac");
  assert.ok(!("error" in u));
  const result = await saveUpload(racing, u, NOW);
  assert.equal(injected, true);
  assert.deepEqual(result, { seq: 5, applied: true });
  assert.equal((raw.prepare("SELECT count(*) AS n FROM observations WHERE collector = 'mac'").get() as { n: number }).n, 1);
});

test("a PC name that can't be registered gets no turn (it fetches on its own and doesn't block turns for PCs that can deliver)", async () => {
  const { call, raw } = await setup();
  const register = raw.prepare("INSERT INTO collector_names (name, slot) VALUES (?, ?)");
  register.run("win-desktop", 0);
  for (let i = 1; i < MAX_STORED_COLLECTORS; i++) register.run(`old-${i}`, i);
  const mac = await call("POST", "/v2/turns/mac", MAC, { claude: 300 });
  assert.equal(mac.status, 200);
  assert.deepEqual(await mac.json(), { claude: { go: true, wait_s: 0 } });
  assert.equal((raw.prepare("SELECT count(*) AS n FROM fetch_turns").get() as { n: number }).n, 0, "doesn't take the turn");
  const win = (await (await call("POST", "/v2/turns/win-desktop", WIN, { claude: 300 })).json()) as Record<string, { go: boolean }>;
  assert.equal(win.claude!.go, true, "the registered PC takes the turn");
});

test("a turn held by a PC that can no longer write after the names filled up is taken over by a writable PC even before expiry", async () => {
  const { call, raw } = await setup();
  const register = raw.prepare("INSERT INTO collector_names (name, slot) VALUES (?, ?)");
  for (let i = 0; i < MAX_STORED_COLLECTORS - 1; i++) register.run(`old-${i}`, i);
  // While there is room, mac (not yet registered) takes the turn
  assert.deepEqual(await (await call("POST", "/v2/turns/mac", MAC, { claude: 10 })).json(), { claude: { go: true, wait_s: 0 } });
  // win registers in the last slot, and mac can no longer write
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1))).status, 204);
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1))).status, 403);
  assert.deepEqual(await (await call("POST", "/v2/turns/win-desktop", WIN, { claude: 10 })).json(), { claude: { go: true, wait_s: 0 } });
  assert.deepEqual({ ...(raw.prepare("SELECT collector FROM fetch_turns WHERE provider = 'claude'").get() as object) }, { collector: "win-desktop" });
});

test("the 24-hour series (derived_history) is removed: no table, and GET /v2/history returns only the weekly 7-day series", async () => {
  const { call, env, raw } = await setup();
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  assert.ok(!tables.includes("derived_history"), tables.join(","));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("seven_day", 10, "2026-11-16T12:30:00.000Z")]));
  await runCron(env, NOW);
  assert.equal((await call("GET", "/v2/history?provider=claude&window=five_hour", READ)).status, 400, "only the weekly window is readable");
  const res = await call("GET", "/v2/history?provider=claude", READ);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { windows: Record<string, unknown[]> };
  assert.deepEqual(Object.keys(body.windows), ["seven_day"], "defaults to the weekly 7-day series");
});
