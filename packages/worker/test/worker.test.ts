import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { nextSendSeq, type Snapshot } from "../../core/src/index.ts";
import { AGENT_PROTOCOL, MAX_COLLECTORS, parseTokens, sha256Hex } from "../src/auth.ts";
import { handle as handleRequest, refreshDerived, repairPublicState, runCron, type Env } from "../src/index.ts";
import { DAILY_BUDGET, MIN_BUDGET_PERCENT, RESERVE, budgetLimit, budgetRetrySeconds, daysToReserve, endOfDays, reserve, settle } from "../src/budget.ts";
import { MAX_WINDOWS, WITHHELD_ERROR } from "../src/sanitize.ts";
import { sanitizeUpload } from "../src/sanitize.ts";
import { PROVIDERS } from "../../core/src/index.ts";
import { CRON_HISTORY_ROWS, DERIVED_PUBLIC_SQL, EVENT_FEED_SQL, HISTORY_ROW_LIMIT, MAX_STORED_COLLECTORS, PRUNE_EVENTS, PRUNE_ROWS, dataVersionOf, loadObservations, loadPublicRow, prune, rebuildEventFeed, saveDerived, savePublicState, saveUpload, saveWeekly, loadWeekly, type D1Like } from "../src/store.ts";
import { sqliteD1 } from "./d1-sqlite.ts";

/** The Worker's handler, as reached by an agent of this protocol (a test that sets the header itself keeps its value) */
const handle: typeof handleRequest = (request, env, now) => {
  if (!request.headers.has("headroom-protocol")) request.headers.set("headroom-protocol", AGENT_PROTOCOL);
  return handleRequest(request, env, now);
};

/** The one-time cleanup run after deploying this version (upgrade/after-deploy.sql) */
const cleanup = () => readFileSync(new URL("../upgrade/after-deploy.sql", import.meta.url), "utf8");

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
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(sentAt(body, at)),
      }),
      env,
      () => at,
    );
  return { raw, db, call, env };
}

/**
 * Uploads in tests are sent by a PC with a right clock: the send time is the receive time, unless the test keeps its own
 * (`keepClock`, to test a PC whose clock is off). Values stamped after the send time are then dropped by the endpoint
 */
function sentAt(body: unknown, at: Date): unknown {
  if (typeof body !== "object" || body === null || !("snapshot" in body)) return body;
  const { keepClock, ...rest } = body as { keepClock?: boolean; snapshot: unknown };
  if (keepClock || typeof rest.snapshot !== "object" || rest.snapshot === null) return rest;
  return { ...rest, snapshot: { ...rest.snapshot, generated_at: at.toISOString() } };
}

/** An upload sent as it is (its own send time), for a PC whose clock is off */
const skewed = <T extends object>(u: T): T & { keepClock: true } => ({ ...u, keepClock: true });

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

test("a window id of another shape drops only that window and its observations", async () => {
  const { call, raw } = await setup();
  const snap = fixture() as unknown as Record<string, any>;
  snap.providers.codex.windows.push({ ...snap.providers.codex.windows[0], id: "Mystery-Group_five_hour", scope: "Mystery-Group" });
  snap.providers.codex.windows.push({ ...snap.providers.codex.windows[0], id: "x".repeat(80), scope: null });
  const observations = [
    obs("five_hour", 10, "2026-11-16T12:59:00Z"),
    { ...obs("five_hour", 10, "2026-11-16T12:59:00Z"), provider: "codex", window_id: "Mystery-Group_five_hour" },
    { ...obs("five_hour", 10, "2026-11-16T12:59:00Z"), provider: "codex", window_id: "seven_day" },
  ];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap as Snapshot, observations))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.deepEqual(
    merged.providers.codex?.windows.map((w) => w.id),
    (fixture().providers.codex?.windows ?? []).map((w) => w.id),
    "the known windows of the same upload are stored",
  );
  const stored = raw.prepare("SELECT provider, window_id FROM observations ORDER BY provider, window_id").all() as { provider: string; window_id: string }[];
  assert.deepEqual(stored.map((r) => `${r.provider}.${r.window_id}`), ["claude.five_hour", "codex.seven_day"]);
  assert.equal(dumpAll(raw).includes("Mystery"), false);
});

test("an older PC's limit flag set only by extra usage is not stored as a reached limit", async () => {
  const { call } = await setup();
  const snap = fixture();
  const claude = snap.providers.claude!;
  claude.windows = claude.windows.map((w) => ({ ...w, used_percent: 20 }));
  claude.windows.push({ ...claude.windows[0]!, id: "extra_usage", label: "Extra usage", kind: "other", scope: null, used_percent: 100 });
  claude.blocked = true;
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.claude?.blocked, null);
  assert.equal(merged.providers.claude?.windows.some((w) => w.id === "extra_usage"), false);
  // A stored overall window at the limit keeps the flag
  const full = fixture();
  full.providers.claude!.windows[0]!.used_percent = 100;
  full.providers.claude!.windows.push({ ...full.providers.claude!.windows[0]!, id: "extra_usage", kind: "other", scope: null });
  full.providers.claude!.blocked = true;
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(2, full))).status, 204);
  const again = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(again.providers.claude?.blocked, true);
});

test("the shared upload with an unknown group (also read by the agent's tests) keeps the known windows and observations", async () => {
  const { call, raw } = await setup();
  const body = JSON.parse(readFileSync(new URL("../../../fixtures/snapshot/upload-unknown-group.json", import.meta.url), "utf8"));
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, body)).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.deepEqual(merged.providers.codex?.windows.map((w) => w.id), ["seven_day", "codex_other_seven_day", "codex_bengalfox_five_hour"]);
  const stored = raw.prepare("SELECT window_id FROM observations WHERE provider = 'codex' ORDER BY window_id").all() as { window_id: string }[];
  assert.deepEqual(stored.map((r) => r.window_id), ["codex_bengalfox_five_hour", "seven_day"]);
  assert.equal(dumpAll(raw).toLowerCase().includes("mystery"), false);
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
  // Extra usage and spend limits are not usage-limit windows
  assert.equal(label("extra_usage"), null);
  assert.equal(label("spend_limit"), null);
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
  for (const id of ["current_session_usage_for_acme", "seven_day_acme7x", "acme_seven_day", "acct_9f3e1", "seven_day-x", "Codex-Bengalfox_five_hour", "seven_day_opus_4", "seven_day_2"]) {
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
  const ahead = obs("five_hour", 12, "2026-11-16T13:01:00.000Z"); // PC whose clock is a minute ahead (within the tolerance)
  const s = snapAt("2026-11-16T13:01:00.000Z");
  await call("PUT", "/v2/snapshots/mac", MAC, skewed(upload(1, s, [ahead])), new Date("2026-11-16T13:00:00Z"));
  await call("PUT", "/v2/snapshots/mac", MAC, skewed(upload(2, { ...s, generated_at: "2026-11-16T13:02:00.000Z" }, [ahead])), new Date("2026-11-16T13:01:00Z"));
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
  // A resend of an old upload (seq not above the saved one) with an earlier boundary deletes nothing
  const older = fixture();
  older.providers.claude!.history_since = "2026-11-16T12:10:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, older, [obs("five_hour", 4, "2026-11-16T12:50:00Z")]));
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
  // Observation time recorded as 12:31, but it actually arrived at 12:29:30 (clock 90 seconds ahead, within the tolerance)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, snapAt("2026-11-16T12:31:00.000Z"), [obs("five_hour", 60, "2026-11-16T12:31:00Z")])),
    new Date("2026-11-16T12:29:30Z"));
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 1, "stored before the switch");
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
  // PC with a clock a minute ahead: fetched 12:30:40 on its clock, received 12:29:40 (before the switch)
  const ahead = snapAt("2026-11-16T12:30:40.000Z");
  const old = skewed(upload(1, ahead, [obs("five_hour", 60, "2026-11-16T12:30:40Z")]));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, old, new Date("2026-11-16T12:29:40Z"));
  const accepted = fixture();
  accepted.providers.claude = { ...accepted.providers.claude!, windows: [], fetched_at: null, history_since: "2026-11-16T12:30:00.000Z" };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:30:00Z"));
  await prune(db, NOW); // Observations before the boundary are filtered on read; Cron deletes them gradually
  assert.equal(count(), 0);
  // Resend of the same observation and current value (arrives at 12:31; the PC sends at 12:32 on its clock)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed({ ...old, seq: 2, snapshot: { ...ahead, generated_at: "2026-11-16T12:32:00.000Z" } }), new Date("2026-11-16T12:31:00Z"));
  assert.equal(count(), 0, "deleted observations don't come back (stamped within the guard after the boundary)");
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:32:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.length ?? 0, 0, "the previous account's current-value windows are not shown");
  // New fetches after the guard are stored
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, snapAt("2026-11-16T12:35:00.000Z"), [obs("five_hour", 5, "2026-11-16T12:35:00Z")]),
    new Date("2026-11-16T12:36:00Z"));
  assert.equal(count(), 1);
});

test("the next switch after a clock fix also creates a new boundary, and a resend of an old upload doesn't roll it back", async () => {
  const { db, call, raw } = await setup();
  const visible = async () => (await loadObservations(db, "claude", new Date(0))).length;
  const accept = (since: string) => {
    const s = fixture();
    s.providers.claude!.history_since = since;
    return s;
  };
  // First switch: the PC reports 12:45 (arrives at 12:40; the boundary is held to the received time)
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accept("2026-11-16T12:45:00.000Z")), new Date("2026-11-16T12:40:00Z"));
  // Observation of the new account
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T12:46:00.000Z"), [obs("five_hour", 7, "2026-11-16T12:46:00Z")]),
    new Date("2026-11-16T12:46:00Z"));
  assert.equal(await visible(), 1);
  // Second switch after fixing the clock (reports 12:42, smaller than before)
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, accept("2026-11-16T12:42:00.000Z")), new Date("2026-11-16T12:47:00Z"));
  await prune(db, NOW);
  assert.equal(await visible(), 0, "the immediately previous account's history is not shown");
  assert.equal((raw.prepare("SELECT since FROM history_boundaries").get() as { since: string }).since, "2026-11-16T12:42:00.000Z");
  // A resend of the first upload doesn't bring it back
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accept("2026-11-16T12:45:00.000Z")), new Date("2026-11-16T12:48:00Z"));
  assert.equal((raw.prepare("SELECT source FROM boundary_sources").get() as { source: string }).source, "2026-11-16T12:42:00.000Z");
});

test("an acceptance time ahead of the received time (recorded while the clock ran ahead) makes the boundary at the received time", async () => {
  const { call, raw } = await setup();
  const accepted = fixture();
  accepted.providers.claude!.history_since = "2026-11-17T12:00:00.000Z";
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted))).status, 204);
  assert.deepEqual(raw.prepare("SELECT since, collector FROM history_boundaries").all().map((r) => ({ ...r })),
    [{ since: NOW.toISOString(), collector: "mac" }]);
});

test("a later acceptance that lands on the same boundary time becomes the setting PC", async () => {
  const { call, raw } = await setup();
  // both acceptances, receipts and fetches at exactly 12:00 (the boundary time is the same, so only >= keeps the later one)
  const at = "2026-11-16T12:00:00.000Z";
  const first = snapAt(at);
  first.providers.claude!.history_since = at;
  first.providers.claude!.windows[0]!.used_percent = 94;
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, first), new Date(at))).status, 204);
  const second = snapAt(at);
  second.providers.claude!.history_since = at;
  second.providers.claude!.windows[0]!.used_percent = 7;
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, second), new Date(at))).status, 204);
  assert.deepEqual(raw.prepare("SELECT since, collector FROM history_boundaries WHERE provider = 'claude'").all().map((r) => ({ ...r })),
    [{ since: at, collector: "win-desktop" }], "the later acceptance at the same time sets the boundary");
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:01:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "win-desktop");
  assert.equal(merged.providers.claude?.windows.some((w) => w.used_percent === 7), true, "the setting PC's own 7% from its acceptance time");
  assert.equal(merged.providers.claude?.windows.some((w) => w.used_percent === 94), false);
});

test("a PC that accepted while its clock ran ahead shows its values fetched after the clock was fixed", async () => {
  const { call } = await setup();
  // The switch was accepted at 18:00 on a clock six hours ahead; the clock was fixed before sending (received 12:01)
  const accepted = snapAt("2026-11-16T12:01:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T18:00:00.000Z";
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:01:00Z"))).status, 204);
  // A new fetch at 12:10 of the new account
  const later = snapAt("2026-11-16T12:10:00.000Z");
  later.providers.claude!.history_since = "2026-11-16T18:00:00.000Z";
  later.providers.claude!.windows[0]!.used_percent = 12;
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(2, later), new Date("2026-11-16T12:10:00Z"))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:11:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.some((w) => w.used_percent === 12), true, "not hidden until 18:00");
});

test("a re-acceptance raised to the received time keeps the accepting PC's own new windows", async () => {
  const { call } = await setup();
  const first = snapAt("2026-11-16T12:00:00.000Z");
  first.providers.claude!.history_since = "2026-11-16T12:00:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, first), new Date("2026-11-16T12:00:00Z"));
  // win-desktop re-accepts at 11:59 (before the current boundary, so the boundary is raised to the received time 12:01:30), fetched 11:59:15
  const again = snapAt("2026-11-16T11:59:15.000Z");
  again.providers.claude!.history_since = "2026-11-16T11:59:00.000Z";
  again.generated_at = "2026-11-16T11:59:30.000Z";
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, again)), new Date("2026-11-16T12:01:30Z"))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:02:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "win-desktop");
  assert.ok((merged.providers.claude?.windows.length ?? 0) > 0);
});

test("a limit flag that came only from a fetch stamped after the send time is dropped too", async () => {
  const { call } = await setup();
  for (const provider of ["claude", "codex"] as const) {
    const s = snapAt("2026-11-16T12:00:30.000Z");
    s.generated_at = "2026-11-16T12:00:00.000Z";
    s.providers[provider] = { ...s.providers[provider]!, blocked: true };
    await call("PUT", "/v2/snapshots/mac", MAC, skewed(upload(provider === "claude" ? 1 : 2, s)), new Date("2026-11-16T12:00:00Z"));
    const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:01:00Z"))).json()) as Snapshot;
    assert.notEqual(merged.providers[provider]?.blocked, true, provider);
  }
});

test("a latest value an earlier Worker kept from before a switch is not shown again under the new rules", async () => {
  const { call, raw } = await setup();
  // Saved as an earlier Worker did: a value fetched at 13:00 on a clock an hour ahead, received 12:00
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T12:00:00.000Z")), new Date("2026-11-16T12:00:00Z"));
  const row = raw.prepare("SELECT snapshot FROM collector_snapshots WHERE collector = 'win-desktop'").get() as { snapshot: string };
  const old = JSON.parse(row.snapshot) as Snapshot;
  for (const p of Object.values(old.providers)) {
    if (!p) continue;
    p.fetched_at = "2026-11-16T13:00:00.000Z";
    for (const w of p.windows) { w.fetched_at = "2026-11-16T13:00:00.000Z"; w.used_percent = 94; }
  }
  raw.prepare("UPDATE collector_snapshots SET snapshot = ? WHERE collector = 'win-desktop'").run(JSON.stringify(old));
  // mac accepts the switch at 12:10 and sends 10% at 12:15
  const accepted = snapAt("2026-11-16T12:15:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:10:00.000Z";
  accepted.providers.claude!.windows[0]!.used_percent = 10;
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:15:00Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:16:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.some((w) => w.used_percent === 94), false);
});

test("when every PC's latest value is past retention, the merged value is withdrawn as an empty one under a newer version", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()));
  const before = ((await (await call("GET", "/v2/view", READ)).json()) as { data_version: number }).data_version;
  const later = new Date(NOW.getTime() + 32 * 24 * 3_600_000);
  await runCron(env, later);
  await runCron(env, later);
  const res = await call("GET", "/v2/view", READ, undefined, later);
  assert.equal(res.status, 200);
  const view = (await res.json()) as { claude: unknown; codex: unknown; data_version: number };
  assert.deepEqual([view.claude, view.codex], [null, null]);
  assert.ok(view.data_version > before, "newer than what an iPhone saved");
  // withdrawn once: later Crons write nothing more
  await runCron(env, later);
  assert.equal(((await (await call("GET", "/v2/view", READ, undefined, later)).json()) as { data_version: number }).data_version, view.data_version);
});

test("a resent current value without observations doesn't bring back windows removed by the boundary", async () => {
  const { call } = await setup();
  // Only a current value had arrived, without observations (PC with a clock a minute ahead: fetched 12:30:40, received 12:29:40)
  const ahead = snapAt("2026-11-16T12:30:40.000Z");
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, ahead)), new Date("2026-11-16T12:29:40Z"));
  const before = await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:29:50Z"))).text();
  assert.ok(before.includes("seven_day_fable"), "shown before the switch");
  const accepted = fixture();
  accepted.providers.claude = { ...accepted.providers.claude!, windows: [], fetched_at: null, history_since: "2026-11-16T12:30:00.000Z" };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:30:00Z"));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(2, { ...ahead, generated_at: "2026-11-16T12:32:00.000Z" })), new Date("2026-11-16T12:31:00Z"));
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
  await saveUpload(db, sanitizeUpload(upload(4, (() => { const s = fixture(); s.generated_at = "2026-11-16T13:05:00.000Z"; s.providers.claude!.history_since = "2026-11-16T12:45:00.000Z"; return s; })(), [obs("five_hour", 3, "2026-11-16T13:05:00Z")]), "mac") as never, new Date("2026-11-16T13:05:00Z"));
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

test("if the daily D1 budget doesn't fit, uploads are refused without touching D1 and no turn is granted", async () => {
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
  // asked again in 15 minutes (another run's reservation may be what doesn't leave room), never after the reset
  assert.deepEqual(await res.json(), { error: "d1_budget", retry_after_s: 15 * 60 });
  assert.equal(budgetRetrySeconds(new Date("2026-11-16T23:55:00.000Z")), 5 * 60);
  assert.equal(budgetRetrySeconds(new Date("2026-11-16T23:59:59.500Z")), 1);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, before);
  // A sharing PC never fetches without a go: refused as an upload is, it asks again only after the wait
  const turn = await call("POST", "/v2/turns/mac", MAC, { claude: { kind: "fetch", attempt: "0123456789abcdef", base: 0 } });
  assert.equal(turn.status, 503);
  assert.deepEqual(await turn.json(), { error: "d1_budget", retry_after_s: 15 * 60 });
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM provider_holds").get() as { n: number }).n, 0);
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
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 6000 - PRUNE_ROWS);
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

test("a latest value saved by an earlier Worker is read under today's rules", async () => {
  const { call, raw, db } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()))).status, 204);
  // As an earlier Worker stored it: extra usage at 100% and the limit flag it set
  const row = raw.prepare("SELECT snapshot FROM collector_snapshots WHERE collector = 'mac'").get() as { snapshot: string };
  const stored = JSON.parse(row.snapshot) as Snapshot;
  stored.providers.claude!.windows.push({ ...stored.providers.claude!.windows[0]!, id: "extra_usage", label: "Extra usage", kind: "other", used_percent: 100 });
  stored.providers.claude!.blocked = true;
  raw.prepare("UPDATE collector_snapshots SET snapshot = ? WHERE collector = 'mac'").run(JSON.stringify(stored));
  const { loadSnapshots } = await import("../src/store.ts");
  const claude = (await loadSnapshots(db)).snapshots[0]!.providers.claude!;
  assert.equal(claude.windows.some((w) => w.id === "extra_usage"), false);
  assert.equal(claude.blocked, null);
});

test("Codex's limit flag is kept even when a window of another shape is dropped", async () => {
  const { call } = await setup();
  const snap = fixture();
  snap.providers.codex!.windows.push({ ...snap.providers.codex!.windows[0]!, id: "Mystery-Group", scope: null, used_percent: 100 });
  snap.providers.codex!.blocked = true;
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.codex?.blocked, true, "Codex knows its limit apart from the windows");
});

test("observations saved before a switch from a PC whose clock runs a little ahead stay out after a resend", async () => {
  const { call, db } = await setup();
  // win-desktop runs 5 s ahead: weekly 94% observed at 12:00:03 on its clock, received 11:59:58
  const s = snapAt("2026-11-16T12:00:03.000Z");
  const rows = [obs("seven_day", 94, "2026-11-16T12:00:03.000Z")];
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, s, rows)), new Date("2026-11-16T11:59:58Z"))).status, 204);
  // The same PC accepts a switch at 12:00 (received 12:00:00)
  const accepted = snapAt("2026-11-16T12:00:05.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:00:00.000Z";
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(2, accepted)), new Date("2026-11-16T12:00:00Z"))).status, 204);
  await prune(db, new Date("2026-11-16T12:01:00Z"));
  // Resending the first upload doesn't bring the observation back
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, s, rows)), new Date("2026-11-16T12:01:30Z"))).status, 409);
  assert.equal((await loadObservations(db, "claude", new Date(0))).some((o) => o.used_percent === 94), false);
});

test("an older Claude agent's value whose windows are all dropped neither blocks nor wins", async () => {
  const { call } = await setup();
  const old = snapAt("2026-11-16T12:10:00.000Z");
  old.providers.claude = { ...old.providers.claude!, blocked: true,
    windows: [{ ...old.providers.claude!.windows[0]!, id: "extra_usage", kind: "other", used_percent: 100 }] };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, old), new Date("2026-11-16T12:10:00Z"));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T12:05:00.000Z")), new Date("2026-11-16T12:10:00Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:11:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "win-desktop");
  assert.equal(merged.providers.claude?.blocked, false);
  // Not even with false
  const notBlocked = { ...old, providers: { ...old.providers, claude: { ...old.providers.claude!, blocked: false } } };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, notBlocked), new Date("2026-11-16T12:12:00Z"));
  const again = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:13:00Z"))).json()) as Snapshot;
  assert.equal(again.providers.claude?.collector, "win-desktop");
});

test("values stamped after the PC's own send time are dropped (its clock was turned back after the fetch)", async () => {
  const { call, raw } = await setup();
  // Fetched at 12:10:30 on a clock that was then turned back; sent at 12:10 with the old times
  const s = snapAt("2026-11-16T12:09:00.000Z");
  s.providers.claude!.windows[0]!.fetched_at = "2026-11-16T12:10:30.000Z";
  s.generated_at = "2026-11-16T12:10:00.000Z";
  const rows = [obs("five_hour", 94, "2026-11-16T12:10:30.000Z"), obs("seven_day", 20, "2026-11-16T12:09:00.000Z")];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, skewed(upload(1, s, rows)), new Date("2026-11-16T12:10:00Z"))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:11:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.length, s.providers.claude!.windows.length - 1);
  assert.ok(merged.providers.claude!.windows.every((w) => w.fetched_at! <= "2026-11-16T12:10:00.000Z"));
  assert.deepEqual(raw.prepare("SELECT used_percent FROM observations").all().map((r) => ({ ...r })), [{ used_percent: 20 }]);
});

test("an upload from a PC whose clock is off by more than the tolerance is refused without touching D1", async () => {
  const { call, raw } = await setup();
  for (const [sent, ok] of [
    ["2026-11-16T12:02:00.000Z", true], ["2026-11-16T11:58:00.000Z", true],
    ["2026-11-16T12:02:00.001Z", false], ["2026-11-16T11:57:59.999Z", false], ["2026-11-16T13:00:00.000Z", false],
  ] as const) {
    const s = snapAt("2026-11-16T11:57:00.000Z");
    s.generated_at = sent;
    const res = await call("PUT", "/v2/snapshots/mac", MAC, skewed(upload(1, s)), new Date("2026-11-16T12:00:00Z"));
    assert.equal(res.status, ok ? 204 : 422, sent);
    if (!ok) assert.equal(((await res.json()) as { error: string }).error, "clock_skew");
    raw.exec("DELETE FROM collector_snapshots; DELETE FROM collector_names; DELETE FROM d1_budget");
  }
  const s = snapAt("2026-11-16T12:59:00.000Z");
  const res = await call("PUT", "/v2/snapshots/mac", MAC, skewed(upload(1, s, [obs("five_hour", 5, "2026-11-16T12:59:00.000Z")])), new Date("2026-11-16T12:00:00Z"));
  assert.deepEqual(await res.json(), { error: "clock_skew", offset_s: 3540 });
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM d1_budget").get() as { n: number }).n, 0, "no budget reserved");
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0);
});

test("after a switch, values stamped within the guard are left out, except the accepting PC's own latest values", async () => {
  const { call, db } = await setup();
  // mac accepts a switch at 12:00 and fetches the new account at 12:01
  const accepted = snapAt("2026-11-16T12:01:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:00:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted, [obs("five_hour", 3, "2026-11-16T12:01:00.000Z")]), new Date("2026-11-16T12:01:00Z"));
  // win-desktop (not switched yet as far as the endpoint knows) fetched at 12:02; it may be a minute or two ahead
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T12:02:00.000Z"), [obs("five_hour", 90, "2026-11-16T12:02:00.000Z")]), new Date("2026-11-16T12:02:00Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:02:30Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "mac", "the accepting PC's own new values are shown");
  assert.deepEqual((await loadObservations(db, "claude", new Date(0))).map((o) => o.used_percent), [], "history starts after the guard");
  // After the guard, both PCs' values count
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, snapAt("2026-11-16T12:06:00.000Z"), [obs("five_hour", 4, "2026-11-16T12:06:00.000Z")]), new Date("2026-11-16T12:06:00Z"));
  assert.deepEqual((await loadObservations(db, "claude", new Date(0))).map((o) => o.used_percent), [4]);
});

test("an observation of a refused window is dropped before its fields are checked", async () => {
  const { call, raw } = await setup();
  const snap = fixture();
  snap.providers.codex!.windows.push({ ...snap.providers.codex!.windows[0]!, id: "codex_other_five_hour_primary", scope: "codex_other_five_hour" });
  const observations = [
    obs("five_hour", 10, "2026-11-16T12:59:00.000Z"),
    { provider: "codex", window_id: "codex_other_five_hour_primary", used_percent: 5, resets_at: null, observed_at: "" },
  ];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap, observations))).status, 204);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM observations").get() as { n: number }).n, 1);
});

test("the guarded boundary in SQL and in TypeScript agree", async () => {
  const { guarded } = await import("../src/store.ts");
  const db = new DatabaseSync(":memory:");
  for (const since of ["2026-11-16T12:00:00.000Z", "2026-11-16T23:58:30.123Z"]) {
    const row = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', julianday(?) + 300000 / 86400000.0) AS v").get(since) as { v: string };
    assert.equal(row.v, guarded(since), since);
  }
  assert.equal(guarded(""), "");
});

test("an older Claude agent's limit flag set by a per-model window sent without its model is not a reached limit", async () => {
  const { call } = await setup();
  const snap = fixture();
  const claude = snap.providers.claude!;
  claude.windows = claude.windows.filter((w) => w.scope === null).map((w) => ({ ...w, used_percent: 20 }));
  claude.windows.push({ ...claude.windows[0]!, id: "seven_day_opus", label: "Weekly Opus", kind: "other", scope: null, used_percent: 100 });
  claude.blocked = true;
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.find((w) => w.id === "seven_day_opus")?.scope, "Opus");
  assert.equal(merged.providers.claude?.blocked, null);
});

test("dropping an older agent's window takes Claude's fetch time from the remaining windows", async () => {
  const { call } = await setup();
  const old = snapAt("2026-11-16T12:15:00.000Z");
  old.providers.claude!.windows.push({ ...old.providers.claude!.windows[0]!, id: "extra_usage", kind: "other", fetched_at: "2026-11-16T11:00:00.000Z" });
  old.providers.claude!.fetched_at = "2026-11-16T11:00:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, old), new Date("2026-11-16T12:16:00Z"));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T11:55:00.000Z")), new Date("2026-11-16T12:16:00Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:17:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "mac");
  assert.equal(merged.providers.claude?.fetched_at, "2026-11-16T12:15:00.000Z");
});

test("an older agent's unknown group whose name starts with a known group's is not stored", async () => {
  const { call, raw } = await setup();
  const snap = fixture();
  snap.providers.codex!.windows.push({ ...snap.providers.codex!.windows[0]!, id: "codex_other_five_hour_primary", scope: "codex_other_five_hour" });
  const observations = [{ ...obs("codex_other_five_hour_primary", 5, "2026-11-16T12:59:00.000Z"), provider: "codex" }];
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snap, observations))).status, 204);
  const merged = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.equal(merged.providers.codex?.windows.some((w) => w.id === "codex_other_five_hour_primary"), false);
  // Its observation in the same upload is not stored either
  assert.equal((raw.prepare("SELECT count(*) AS n FROM observations WHERE window_id = 'codex_other_five_hour_primary'").get() as { n: number }).n, 0);
});

test("Cron rebuilds a public row an earlier Worker put, even with no PC sending", async () => {
  const { call, raw, env } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()))).status, 204);
  const row = raw.prepare("SELECT body FROM public_state WHERE id = 1").get() as { body: string };
  const body = JSON.parse(row.body) as Snapshot;
  body.providers.claude!.windows.push({ ...body.providers.claude!.windows[0]!, id: "extra_usage", label: "Extra usage", kind: "other", used_percent: 100 });
  body.providers.claude!.blocked = true;
  raw.prepare("UPDATE public_state SET body = ? WHERE id = 1").run(JSON.stringify(body));
  await repairPublicState(env.DB, env);
  const after = JSON.parse((raw.prepare("SELECT body FROM public_state WHERE id = 1").get() as { body: string }).body) as Snapshot;
  assert.equal(after.providers.claude?.windows.some((w) => w.id === "extra_usage"), false);
  assert.equal(after.providers.claude?.blocked, false);
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
  // what the run used (the reserve statement included), and settle's own two statements
  const settled = 600 + 2 * 2;
  await settle(env.DB, days, RESERVE.put, { reads: 10, writes: 600 }, new Date("2026-11-17T00:00:10Z"));
  assert.deepEqual(rows().map((r) => r.writes), [settled, settled]);
  // If it ends on the same day, the next day's reservation is returned
  assert.equal(await reserve(env.DB, days, RESERVE.put), "reserved");
  await settle(env.DB, days, RESERVE.put, { reads: 10, writes: 600 }, new Date("2026-11-16T23:55:00Z"));
  assert.deepEqual(rows().map((r) => r.writes), [settled * 2, settled]);
});

test("D1_BUDGET_PERCENT gives this D1 a share of the daily budget, and a bad value gives none", async () => {
  assert.deepEqual(budgetLimit(undefined), DAILY_BUDGET);
  assert.deepEqual(budgetLimit(" "), DAILY_BUDGET);
  assert.deepEqual(budgetLimit("80"), { reads: 3_200_000, writes: 64_000 });
  assert.deepEqual(budgetLimit("20"), { reads: 800_000, writes: 16_000 });
  for (const bad of ["0", "101", "50%", "-5", "1e2", "abc", 0, 20.5, true, {}, null]) {
    assert.deepEqual(budgetLimit(bad), { reads: 0, writes: 0 }, String(bad));
  }
  // wrangler.toml may give a number
  assert.deepEqual(budgetLimit(20), budgetLimit("20"));
  // At the smallest documented share every run fits
  for (const r of Object.values(RESERVE)) assert.ok(budgetLimit(String(MIN_BUDGET_PERCENT)).writes >= r.writes);
  assert.ok(budgetLimit(String(MIN_BUDGET_PERCENT - 1)).writes < RESERVE.cron.writes);
  const share = budgetLimit("80").writes + budgetLimit("20").writes;
  assert.ok(share <= DAILY_BUDGET.writes, "shares that add up to 100 stay within one D1's budget");

  const { call, raw, env } = await setup();
  env.D1_BUDGET_PERCENT = "20";
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-16', 0, ?)").run(16_000 - RESERVE.put.writes + 1);
  const res = await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T12:00:00.000Z")]));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: string }).error, "d1_budget");
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n, 0);
  env.D1_BUDGET_PERCENT = "40";
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()))).status, 204);
  env.D1_BUDGET_PERCENT = "forty";
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture()))).status, 503);
  // Two days are reserved together or not at all
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-17', 0, ?)").run(16_000);
  const before = raw.prepare("SELECT day, writes FROM d1_budget ORDER BY day").all().map((r) => ({ ...r }));
  assert.equal(await reserve(env.DB, ["2026-11-16", "2026-11-17"], RESERVE.put, budgetLimit("20")), "exhausted");
  assert.deepEqual(raw.prepare("SELECT day, writes FROM d1_budget ORDER BY day").all().map((r) => ({ ...r })), before);
});

test("a body over 1 MB is cut off while reading, even without Content-Length", async () => {
  const { readBody } = await import("../src/index.ts");
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(chunk);
    },
  });
  const request = new Request("https://headroom.example/v2/snapshots/mac", { method: "PUT", body: endless, duplex: "half" } as RequestInit);
  assert.equal(request.headers.get("content-length"), null);
  await assert.rejects(readBody(request), RangeError);
  assert.ok(pulled <= 1_000_000 / chunk.byteLength + 3, `stopped right after the limit (${pulled} chunks)`);
  // Just under the limit is read, and multibyte text split across chunks decodes intact
  const text = JSON.stringify({ note: "あ".repeat(1000) });
  const bytes = new TextEncoder().encode(text);
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 11));
      controller.enqueue(bytes.slice(11));
      controller.close();
    },
  });
  const ok = new Request("https://headroom.example/", { method: "PUT", body: split, duplex: "half" } as RequestInit);
  assert.deepEqual(await readBody(ok), JSON.parse(text));
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
  const body = JSON.stringify(sentAt(upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T23:39:00.000Z")]), new Date("2026-11-16T23:40:00Z")));
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
    body: JSON.stringify(sentAt(upload(1, fixture(), [obs("five_hour", 1, "2026-11-16T23:39:00.000Z")]), new Date("2026-11-16T23:40:00Z"))),
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

test("Cloudflare free plan: at most 50 D1 queries per invocation (heavy cases of upload, turn, GET, Cron), with three providers", async () => {
  const { raw, env } = await setup();
  // Give every provider history (as much as lets all three be computed in one Cron) and old observations to be deleted
  const ins = raw.prepare("INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const p of PROVIDERS) {
    for (let i = 0; i < 1500; i++) {
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
    obs("five_hour", 50, new Date(NOW.getTime() - 50_000 + i * 100).toISOString(), PROVIDERS[i % PROVIDERS.length]));
  // Gemini's value beside the other two (its overall windows)
  const three = fixture();
  three.providers.gemini = { ...three.providers.claude!, windows: three.providers.claude!.windows.filter((w) => w.scope === null) };
  await measure("upload (200 observations)", async () => assert.equal((await req("PUT", "/v2/snapshots/mac", MAC, upload(1, three, many))).status, 204));
  await measure("peek", async () => assert.equal((await req("POST", "/v2/turns/mac", MAC, { claude: { kind: "peek" } })).status, 200));
  await measure("turn", async () => assert.equal((await req("POST", "/v2/turns/mac", MAC, { claude: { kind: "fetch", attempt: "0123456789abcdef", base: 0 } })).status, 200));
  // the heaviest result: an access denial (the row, the counter, the public mark and the event in one batch)
  await measure("result", async () => assert.equal((await req("POST", "/v2/turns/mac/result", MAC,
    { claude: { attempt: "0123456789abcdef", kind: "fetch", outcome: "access_denied", interval_s: 900, minutes: 18 } })).status, 200));
  await measure("GET", async () => assert.equal((await req("GET", "/v2/view", READ)).status, 200));
  await measure("GET events", async () => assert.equal((await req("GET", "/v2/events", READ)).status, 200));
  await measure("Cron (compute every provider, delete old observations)", async () => assert.equal(await runCron(e, NOW), true));
  assert.deepEqual((raw.prepare("SELECT provider FROM derived_metrics ORDER BY provider").all() as { provider: string }[]).map((r) => r.provider), [...PROVIDERS].sort(), "every provider computed in that Cron");
  await measure("GET history", async () => assert.equal((await req("GET", "/v2/history?provider=claude", READ)).status, 200));
});

test("at most 50 D1 queries also for a Cron that repairs the public row while it computes all three, builds the weekly series and adds events", async () => {
  for (const repair of ["counter behind", "merged otherwise"] as const) {
    const { raw, env, call } = await setup();
    const three = fixture();
    // Claude's 5-hour at 85% and Codex's weekly at 96%: two visible events
    three.providers.claude!.windows[0]!.used_percent = 85;
    three.providers.codex!.windows[0]!.used_percent = 96;
    three.providers.gemini = { ...three.providers.claude!, windows: three.providers.claude!.windows.filter((w) => w.scope === null).map((w) => ({ ...w, used_percent: 40 })) };
    const week = (p: string) => obs("seven_day", 10, "2026-11-16T12:59:00.000Z", p);
    assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, three, PROVIDERS.map(week)))).status, 204);
    const ins = raw.prepare("INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?,?,?,?,?,?,?)");
    for (const p of PROVIDERS) for (let i = 0; i < 300; i++) {
      const t = new Date(NOW.getTime() - 20 * 86_400_000 - i * 60_000).toISOString();
      ins.run(p, "five_hour", "mac", t, t, null, 1);
    }
    if (repair === "counter behind") raw.exec("UPDATE data_versions SET version = version + 1 WHERE provider = 'all'");
    else {
      const row = raw.prepare("SELECT body FROM public_state WHERE id = 1").get() as { body: string };
      raw.prepare("UPDATE public_state SET body = ? WHERE id = 1").run(JSON.stringify({ ...JSON.parse(row.body), generated_at: "2026-11-16T12:00:00.000Z" }));
    }
    const counted = countQueries(env.DB);
    assert.equal(await runCron({ ...env, DB: counted.db }, NOW), true);
    assert.ok(counted.queries() <= 50, `${repair}: ${counted.queries()} queries`);
    assert.equal((raw.prepare("SELECT count(*) AS n FROM derived_metrics").get() as { n: number }).n, 3, "every provider computed");
    assert.equal((raw.prepare("SELECT count(*) AS n FROM derived_weekly").get() as { n: number }).n, 3, "every weekly series built");
    assert.equal((raw.prepare("SELECT count(*) AS n FROM events WHERE visible = 1").get() as { n: number }).n, 2, "the events added");
    const version = (raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get() as { version: number }).version;
    assert.equal((raw.prepare("SELECT version FROM public_state WHERE id = 1").get() as { version: number }).version, version, `${repair}: put again`);
    const body = JSON.parse((raw.prepare("SELECT body FROM public_state WHERE id = 1").get() as { body: string }).body) as Snapshot;
    assert.notEqual(body.generated_at, "2026-11-16T12:00:00.000Z", `${repair}: today's merge`);
  }
});

test("one Cron reads each provider's equal share of the observations (3,333 of 10,000) and computes every provider due in that run", async () => {
  const { raw, env, call } = await setup();
  const three = fixture();
  three.providers.gemini = { ...three.providers.claude!, windows: three.providers.claude!.windows.filter((w) => w.scope === null) };
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, three))).status, 204);
  const ins = raw.prepare("INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent) VALUES (?,?,?,?,?,?,?)");
  raw.exec("BEGIN");
  for (const p of PROVIDERS) for (let i = 0; i < 5_000; i++) {
    const t = new Date(NOW.getTime() - 60_000 - i * 14_000).toISOString();
    ins.run(p, i % 2 ? "five_hour" : "seven_day", "mac", t, t, "2026-11-16T16:00:00.000Z", i % 100);
  }
  raw.exec("COMMIT");
  assert.equal(HISTORY_ROW_LIMIT, 3_333);
  assert.ok(HISTORY_ROW_LIMIT * PROVIDERS.length <= CRON_HISTORY_ROWS);
  const original = env.DB;
  const read: number[] = [];
  const reading: D1Like = {
    prepare: (sql) => {
      const wrap = (s: ReturnType<D1Like["prepare"]>): ReturnType<D1Like["prepare"]> => ({
        ...s,
        bind: (...v: unknown[]) => wrap(s.bind(...v)),
        all: async <T>() => {
          const r = await s.all<T>();
          if (sql.includes("FROM observations WHERE provider = ?")) read.push(r.results.length);
          return r;
        },
      });
      return wrap(original.prepare(sql));
    },
    batch: (s) => original.batch(s),
  };
  assert.equal(await runCron({ ...env, DB: reading }, NOW), true);
  assert.deepEqual(read, [HISTORY_ROW_LIMIT, HISTORY_ROW_LIMIT, HISTORY_ROW_LIMIT]);
  const computed = (raw.prepare("SELECT provider FROM derived_metrics WHERE computed_at = ? ORDER BY provider").all(NOW.toISOString()) as { provider: string }[]).map((r) => r.provider);
  assert.deepEqual(computed, ["claude", "codex", "gemini"]);
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
  // Sent right after the fetch (the PC's clock is right)
  s.generated_at = fetchedAt;
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

test("GET /v2/history returns only the weekly 7-day series (provider required, hours 1-170, weekly window only)", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), [obs("seven_day", 10, "2026-11-16T12:30:00.000Z")]));
  await runCron(env, NOW);
  const res = await call("GET", "/v2/history?provider=claude&window=seven_day&hours=24", READ);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { windows: Record<string, { used_percent: number }[]> };
  assert.deepEqual(Object.keys(body.windows), ["seven_day"]);
  assert.equal((await call("GET", "/v2/history", READ)).status, 400);
  assert.equal((await call("GET", "/v2/history?provider=claude&hours=0", READ)).status, 400);
  assert.equal((await call("GET", "/v2/history?provider=claude&hours=171", READ)).status, 400, "up to 7 days and 2 hours (170 hours)");
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
  const P = PROVIDERS.length;
  const observationPrune = P * 2 * PRUNE_ROWS * 3; // provider x (retention and boundary) x (row and 2 indexes)
  const hourlyPrune = P * PRUNE_ROWS; // observation_hourly is WITHOUT ROWID (no separate index)
  const eventPrune = PRUNE_EVENTS * 4; // row, key, keep-until, visible-events indexes
  // Max events per window: at limit + 2 thresholds, or 2 thresholds + 3 near-limit + 1 sudden usage, plus 1 reset of the previous cycle
  const perWindow = 7;
  const newEvents = (P * MAX_WINDOWS * perWindow + P /* stop reasons */ + P /* at limit */ + 1 /* collection */) * 5; // row, 3 indexes, sequence
  const rest = P * 2 * 2 /* derived values and series */ + P /* the read endpoint's derived row, rebuilt with each save */
    + 4 /* repairing the public row: version and body */ + 1 /* data_versions after deletes */
    + 2 /* state */ + 2 /* list */ + 2 * 100 /* deleting PC latest values */ + 10 /* budget */;
  const bound = observationPrune + hourlyPrune + eventPrune + newEvents + rest;
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
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(sentAt(body, at)),
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
          const res = await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(3, withSession(12, "2026-11-16T13:04:30.000Z")), at);
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
  const at = new Date("2026-11-16T13:09:00Z");
  const accepted = (used: number, fetched: string) => {
    const s = withSession(used, fetched);
    s.providers.claude!.history_since = "2026-11-16T13:00:00.000Z";
    return s;
  };
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted(8, "2026-11-16T13:08:00.000Z"), [obs("five_hour", 8, "2026-11-16T13:08:00.000Z")]), at);
  // win hasn't accepted the switch yet and sends the previous account's observations (after the boundary time and its guard)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(4, "2026-11-16T13:05:30.000Z"), [obs("five_hour", 4, "2026-11-16T13:05:30.000Z")]), at);
  await runCron(env, at);
  const consumed = async () => (await fiveHour(call, at))?.recent_consumed_percent ?? null;
  assert.equal(await consumed(), 4, "before the switch, computed from both PCs' observations (4% -> 8%)");
  // win also accepts the switch at the same received time (the boundary time doesn't change; only win's exclusion marker advances)
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, accepted(8, "2026-11-16T13:08:30.000Z")), at)).status, 204);
  assert.equal(await consumed(), null, "values computed from the excluded previous-account observations are not used");
  await runCron(env, at);
  assert.equal(await consumed(), null, "the next Cron doesn't use excluded observations either (once the boundary advances to the received time, earlier observations are dropped for all PCs)");
});

test("the latest value is put only if no save happened after reading (an old value never overwrites even if read order and counter order differ)", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(8)));
  const before = Number((raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get() as { version: number }).version);
  // Before the upload that read 8% puts it, another upload saved and put 12%
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, withSession(12, "2026-11-16T12:59:45.000Z")));
  assert.equal(await savePublicState(env.DB, withSession(8), before), false, "an old read is not put");
  const row = await loadPublicRow(env.DB);
  assert.equal(row?.snapshot.providers.claude?.windows.find((w) => w.id === "five_hour")?.used_percent, 12);
});

test("if the re-put of the upload that saved 12% fails and an upload that read 8% tries to put later, the next Cron aligns to 12%", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(8)));
  const flaky = failPublicOnce(env.DB);
  await putWith(env, flaky.db, WIN, "win-desktop", upload(2, withSession(12, "2026-11-16T12:59:45.000Z")), NOW);
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
  // Fetched and received after the switch (12:10); the two observations are far enough apart not to count as simultaneous
  const accepted = (seq: number, used: number, fetched: string) => {
    const s = withSession(used, fetched);
    s.providers.claude!.history_since = "2026-11-16T12:10:00.000Z";
    return upload(seq, s, [obs("five_hour", used, fetched)]);
  };
  const at = new Date("2026-11-16T12:15:30Z");
  // After both pass the pre-check, the batches run in order
  await Promise.all([
    call("PUT", "/v2/snapshots/win-desktop", WIN, accepted(1, 39, "2026-11-16T12:15:00.000Z"), at),
    call("PUT", "/v2/snapshots/win-desktop", WIN, accepted(2, 40, "2026-11-16T12:22:00.000Z"), new Date("2026-11-16T12:25:00Z")),
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
  await saveDerived(env.DB, "claude", metrics(90), 1, NOW, "", null, 2, 1);
  // Computed from the old latest value (counter 1): provider counter 2 (newer observations but older latest value)
  await saveDerived(env.DB, "claude", metrics(10), 2, NOW, "", null, 1, 1);
  const body = JSON.parse((raw.prepare("SELECT body FROM derived_metrics WHERE provider = 'claude'").get() as { body: string }).body);
  assert.equal(body.five_hour.used_percent, 90);
  // A computation with neither counter smaller (the next Cron) replaces it
  await saveDerived(env.DB, "claude", metrics(91), 2, NOW, "", null, 2, 1);
  assert.equal(JSON.parse((raw.prepare("SELECT body FROM derived_metrics WHERE provider = 'claude'").get() as { body: string }).body).five_hour.used_percent, 91);
});

test("GET /v2/view returns the counter (data_version) of the latest-value row it read, which grows with every save", async () => {
  const { call } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, withSession(10)));
  const a = (await (await call("GET", "/v2/view", READ)).json()) as { data_version: number };
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, withSession(12, "2026-11-16T12:59:45.000Z")));
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
  assert.match(row.basis, /^5:/, "format version in the basis (5: the forecast's rate picked by reliability)");
  raw.prepare("UPDATE derived_metrics SET body = ?, basis = ? WHERE provider = 'claude'").run(JSON.stringify(drop(JSON.parse(row.body))), row.basis.replace(/^\d+:/, ""));
  // (the read endpoint's row taken from it, as this version's Cron does with a row an earlier Worker saved)
  raw.exec(DERIVED_PUBLIC_SQL);
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

test("pre-switch observations don't mix into the post-switch weekly trend", async () => {
  const { call, env, raw } = await setup();
  // win-desktop sends a pre-switch 90% at 12:04
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, snapAt("2026-11-16T12:04:00.000Z"), [weekObs(90, "2026-11-16T12:04:00.000Z")]), new Date("2026-11-16T12:04:00Z"));
  // mac accepts the switch at 12:05 and sends 3% after the guard
  const accepted = snapAt("2026-11-16T12:11:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:05:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted, [weekObs(3, "2026-11-16T12:11:00.000Z")]), new Date("2026-11-16T12:11:00Z"));
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
  await saveWeekly(db, "claude", point(12), "", "2026-11-16T12", new Date("2026-11-16T12:00:00Z"), 1);
  await saveWeekly(db, "claude", point(11), "", "2026-11-16T11", new Date("2026-11-16T11:55:00Z"), 1);
  assert.equal((await loadWeekly(db, "claude"))!.series[0]!.used_percent, 12, "an old computation doesn't replace");
  await saveWeekly(db, "claude", point(99), "2026-11-16T12:00:00.000Z#9", "2026-11-16T13", new Date("2026-11-16T13:00:00Z"), 1);
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
  // At 12:00, a 10% recorded by the PC as 12:01 arrives (clock a minute ahead)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, snapAt("2026-11-16T12:01:00.000Z"), [weekObs(10, "2026-11-16T12:01:00.000Z")])), new Date("2026-11-16T12:00:00Z"));
  // A resend of the same observation (same unique key) with a different value isn't saved (and doesn't change the aggregate)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(2, snapAt("2026-11-16T12:02:00.000Z"), [weekObs(90, "2026-11-16T12:01:00.000Z")])), new Date("2026-11-16T12:01:00Z"));
  const rows = raw.prepare("SELECT hour, used_percent, effective_at AS observed_at FROM observation_hourly").all() as { hour: string; used_percent: number; observed_at: string }[];
  assert.deepEqual(rows.map((r) => [r.hour, r.used_percent, r.observed_at]), [["2026-11-16T12", 10, "2026-11-16T12:00:00.000Z"]]);
});

/** A snapshot whose send and fetch times are all the given time */
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

test("if the current representative is invalid under the current boundary, even an older valid candidate replaces it", async () => {
  const { call, raw } = await setup();
  // Boundary 12:30. win's 12:31 representative is within the guard, so it is invalid
  raw.prepare("INSERT INTO history_boundaries (provider, since, collector) VALUES ('claude', '2026-11-16T12:30:00.000Z', 'mac')").run();
  raw.prepare(`INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
    VALUES ('claude', 'seven_day', '2026-11-16T12', 60, NULL, '2026-11-16T12:31:00.000Z', '2026-11-16T12:31:00.000Z', '2026-11-16T12:31:00.000Z', 'win-desktop', 0)`).run();
  // mac sends a valid 12:40 observation at 13:00
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snapAt("2026-11-16T12:40:00.000Z"), [weekObs(3, "2026-11-16T12:40:00.000Z")]), new Date("2026-11-16T13:00:00Z"));
  assert.deepEqual(hourlyOf(raw).map((r) => [r.hour, r.used_percent, r.collector]), [["2026-11-16T12", 3, "mac"]]);
});

test("the hour bucket is decided by the saved first receipt (a resent observation doesn't drop a point from another hour)", async () => {
  const { call, raw } = await setup();
  // An observation recorded as 13:00:30 at 12:59 (clock ahead; clamped 12:59 -> the 12:xx hour)
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, snapAt("2026-11-16T13:00:30.000Z"), [weekObs(10, "2026-11-16T13:00:30.000Z")])), new Date("2026-11-16T12:59:00Z"));
  // At 13:05, its resend and a new 13:00 observation
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [weekObs(10, "2026-11-16T13:00:30.000Z"), weekObs(12, "2026-11-16T13:00:00.000Z")]), new Date("2026-11-16T13:05:00Z"));
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

test("among observations with the same time and priority, the one with the newer PC-recorded observation time is the representative (regardless of arrival order)", async () => {
  const at = new Date("2026-11-16T12:00:00Z");
  const early = "2026-11-16T12:01:00.000Z";
  const late = "2026-11-16T12:01:30.000Z";
  // Both recorded after the receipt by a PC whose clock runs ahead, so both are placed at 12:00
  const sent = (rows: unknown[]) => skewed(upload(1, snapAt(late), rows));
  for (const order of [[0, 1], [1, 0]]) {
    const { call, raw } = await setup();
    const list = [weekObs(10, early), weekObs(40, late)];
    await call("PUT", "/v2/snapshots/win-desktop", WIN, sent(order.map((i) => list[i])), at);
    assert.deepEqual(hourlyOf(raw).map((r) => [r.hour, r.used_percent]), [["2026-11-16T12", 40]], `order ${order}`);
  }
  // Comparison with the saved representative works the same (replaced by a newer one, not by an older one)
  for (const [stored, incoming, expected] of [[early, late, 40], [late, early, 40]] as const) {
    const { call, raw } = await setup();
    raw.prepare(`INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
      VALUES ('claude', 'seven_day', '2026-11-16T12', ?, NULL, ?, '2026-11-16T12:00:00.000Z', '2026-11-16T12:00:00.000Z', 'win-desktop', 0)`)
      .run(stored === early ? 10 : 40, stored);
    await call("PUT", "/v2/snapshots/win-desktop", WIN, sent([weekObs(stored === early ? 40 : 10, incoming)]), at);
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

test("a late acceptance doesn't remove another PC's values received after the boundary time", async () => {
  const { call, env } = await setup();
  // mac sends the new account's weekly value at 12:06 without a switch of its own
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snapAt("2026-11-16T12:06:00.000Z"), [weekObs(13, "2026-11-16T12:06:00.000Z")]), new Date("2026-11-16T12:06:00Z"));
  // win-desktop accepted a switch at 12:00, but its upload arrives at 12:10
  const accepted = snapAt("2026-11-16T12:00:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:00:00.000Z";
  accepted.generated_at = "2026-11-16T12:10:00.000Z";
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, accepted), new Date("2026-11-16T12:10:00Z"));
  assert.deepEqual((await loadObservations(env.DB, "claude", new Date(0))).map((o) => o.used_percent), [13]);
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:11:00Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.windows.length ? merged.providers.claude?.collector : null, "mac");
});

test("an upload received just before a boundary but saved after it doesn't bring its windows back on a resend", async () => {
  const { call } = await setup();
  const accepted = snapAt("2026-11-16T12:00:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:00:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:00:00Z"));
  // win-desktop runs a minute ahead: fetched at 12:00:10 on its clock, received 11:59:59 but saved after the boundary
  const old = snapAt("2026-11-16T12:00:10.000Z");
  old.generated_at = "2026-11-16T12:00:59.000Z";
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, old)), new Date("2026-11-16T11:59:59Z"));
  const resend = { ...old, generated_at: "2026-11-16T12:15:59.000Z" };
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(2, resend)), new Date("2026-11-16T12:14:59Z"));
  const merged = (await (await call("GET", "/v2/snapshot", READ, undefined, new Date("2026-11-16T12:15:30Z"))).json()) as Snapshot;
  assert.equal(merged.providers.claude?.collector, "mac");
});

test("an observation stamped after its own send time (clock turned back) is not stored even after a switch", async () => {
  const { call, env } = await setup();
  const accepted = snapAt("2026-11-16T12:00:00.000Z");
  accepted.providers.claude!.history_since = "2026-11-16T12:00:00.000Z";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, accepted), new Date("2026-11-16T12:00:00Z"));
  const s = snapAt("2026-11-16T12:04:00.000Z");
  s.generated_at = "2026-11-16T12:04:30.000Z";
  await call("PUT", "/v2/snapshots/win-desktop", WIN, skewed(upload(1, s, [weekObs(94, "2026-11-16T12:10:00.000Z")])), new Date("2026-11-16T12:05:00Z"));
  assert.equal((await loadObservations(env.DB, "claude", new Date(0))).some((o) => o.used_percent === 94), false);
});


test("a merged value left after an earlier Worker already deleted every PC's latest value is removed by the next Cron", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()));
  // As an earlier Worker left it: the PC rows were deleted, the merged value and counters stay as they were
  raw.exec("DELETE FROM collector_snapshots");
  assert.equal((await call("GET", "/v2/snapshot", READ)).status, 200);
  await runCron(env, NOW);
  const snap = (await (await call("GET", "/v2/snapshot", READ)).json()) as Snapshot;
  assert.deepEqual(snap.providers, {}, "withdrawn: no provider's value is left");
});

test("a PC row an earlier Worker kept from a clock off is not merged again; values stamped after its send time neither", async () => {
  const { call, raw, db, env } = await setup();
  const at = new Date("2026-11-16T12:00:00Z");
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snapAt("2026-11-16T11:59:00.000Z")), at);
  const view = async () => (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, unknown> } | null };
  assert.ok(Object.keys((await view()).claude?.windows ?? {}).length > 0);
  // what an earlier Worker could have kept: a row sent 22 minutes ahead of its receipt
  const ahead = snapAt("2026-11-16T12:21:00.000Z");
  raw.prepare("UPDATE collector_snapshots SET snapshot = ? WHERE collector = 'mac'").run(JSON.stringify(ahead));
  const versionOf = async () => ((await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { data_version: number }).data_version;
  const before = await versionOf();
  await repairPublicState(db, env);
  const gone = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: unknown; data_version: number };
  assert.equal(gone.claude, null, "no PC row today's rules use: withdrawn, with no PC sending");
  assert.ok(gone.data_version > before, "under a newer version (an iPhone replaces what it saved)");
  // a row within the tolerance, with one window stamped after its send time
  const row = snapAt("2026-11-16T12:00:00.000Z");
  row.providers.claude!.windows[0]!.fetched_at = "2026-11-16T12:01:00.000Z";
  raw.prepare("UPDATE collector_snapshots SET snapshot = ? WHERE collector = 'mac'").run(JSON.stringify(row));
  await repairPublicState(db, env);
  const shown = (await view()).claude?.windows ?? {};
  assert.ok(!(row.providers.claude!.windows[0]!.id in shown), "the window stamped after the send time is left out");
  assert.ok(row.providers.claude!.windows.slice(1).every((w) => w.id in shown), "its other windows are shown again");
  assert.ok((await versionOf()) > before, "under a new data version");
});

test("an earlier Worker's markers keep its removed observations and values out (resends and saved rows)", async () => {
  const { call, raw, db, env } = await setup();
  const at = new Date("2026-11-16T12:30:00Z");
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('claude', 'mac', '2026-11-16T12:10:00.000Z')").run();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, snapAt("2026-11-16T12:30:00.000Z"),
    [obs("five_hour", 50, "2026-11-16T12:05:00.000Z"), obs("five_hour", 55, "2026-11-16T12:20:00.000Z")]), at);
  const stored = raw.prepare("SELECT observed_at FROM observations WHERE collector = 'mac' ORDER BY observed_at").all().map((r: any) => r.observed_at);
  assert.deepEqual(stored, ["2026-11-16T12:20:00.000Z"], "the resend at or before the marker isn't stored");
  // a saved row with windows at or before the marker
  raw.prepare("UPDATE collector_snapshots SET snapshot = ? WHERE collector = 'mac'").run(JSON.stringify(snapAt("2026-11-16T12:10:00.000Z")));
  raw.prepare("UPDATE collector_snapshots SET received_at = '2026-11-16T12:10:00.000Z' WHERE collector = 'mac'").run();
  await repairPublicState(db, env);
  const view = (await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, unknown> } | null };
  assert.equal(Object.keys(view.claude?.windows ?? {}).length, 0);
});

test("the cleanup removes what an earlier Worker kept that today's rules don't accept, each rule on its own", () => {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  for (const n of names.filter((n) => n < "0014")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  // a boundary at 11:50 (guard to 11:55) for claude, and a marker for codex on win-desktop until 12:20
  raw.prepare("INSERT INTO history_boundaries (provider, since, collector) VALUES ('claude', '2026-11-16T11:50:00.000Z', 'mac')").run();
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('codex', 'win-desktop', '2026-11-16T12:20:00.000Z')").run();
  const add = raw.prepare(`INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent)
    VALUES (?, 'five_hour', ?, ?, ?, NULL, 10)`);
  const rows: [string, string, string, string, boolean][] = [
    // provider, PC, observed, first received, kept
    ["codex", "mac", "2026-11-16T12:03:01.000Z", "2026-11-16T12:00:00.000Z", false], // more than 2 minutes after its receipt
    ["codex", "mac", "2026-11-16T12:01:30.000Z", "2026-11-16T12:00:00.000Z", true], // within 2 minutes: a clock today's Worker accepts
    ["codex", "win-desktop", "2026-11-16T12:10:00.000Z", "2026-11-16T12:10:05.000Z", false], // at or before the marker
    ["codex", "win-desktop", "2026-11-16T12:25:00.000Z", "2026-11-16T12:25:05.000Z", true], // after the marker
    ["codex", "mac", "2026-11-16T12:10:00.000Z", "2026-11-16T12:10:05.000Z", true], // the marker is another PC's
    ["claude", "mac", "2026-11-16T11:52:00.000Z", "2026-11-16T11:58:00.000Z", false], // stamped within the guard after the boundary
    ["claude", "mac", "2026-11-16T11:57:00.000Z", "2026-11-16T11:49:00.000Z", false], // received before the boundary
    ["claude", "mac", "2026-11-16T11:56:00.000Z", "2026-11-16T11:56:05.000Z", true], // after the guard
  ];
  for (const [p, c, o, r] of rows) add.run(p, c, o, r);
  const hourly = raw.prepare(`INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
    VALUES (?, 'seven_day', ?, 10, NULL, ?, ?, ?, ?, 0)`);
  const reps: [string, string, string, string, string, boolean][] = [
    ["codex", "2026-11-16T09", "2026-11-16T09:03:01.000Z", "2026-11-16T09:00:00.000Z", "mac", false],
    ["codex", "2026-11-16T10", "2026-11-16T10:01:30.000Z", "2026-11-16T10:00:00.000Z", "mac", true],
    ["codex", "2026-11-16T11", "2026-11-16T11:10:00.000Z", "2026-11-16T11:10:05.000Z", "win-desktop", false],
    ["claude", "2026-11-16T11", "2026-11-16T11:52:00.000Z", "2026-11-16T11:58:00.000Z", "mac", false],
    ["claude", "2026-11-16T12", "2026-11-16T12:00:00.000Z", "2026-11-16T12:00:05.000Z", "mac", true],
  ];
  for (const [p, h, o, r, c] of reps) hourly.run(p, h, o, o < r ? o : r, r, c);
  for (const n of names.filter((n) => n >= "0014")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  raw.exec(cleanup());
  const left = new Set(raw.prepare("SELECT provider || ' ' || collector || ' ' || observed_at AS k FROM observations").all().map((r: any) => r.k));
  for (const [p, c, o, , kept] of rows) assert.equal(left.has(`${p} ${c} ${o}`), kept, `${p} ${c} ${o}`);
  const leftHours = new Set(raw.prepare("SELECT provider || ' ' || hour AS k FROM observation_hourly").all().map((r: any) => r.k));
  for (const [p, h, , , , kept] of reps) assert.equal(leftHours.has(`${p} ${h}`), kept, `${p} ${h}`);
});

test("the cleanup cuts a marker recorded by a clock ahead to now, and has the weekly series built again", () => {
  const raw = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  const names = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  for (const n of names.filter((n) => n < "0014")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('claude', 'mac', '2999-01-01T00:00:00.000Z')").run();
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('codex', 'mac', '2026-11-16T12:00:00.000Z')").run();
  raw.prepare("INSERT INTO derived_weekly (provider, body, boundary, built_hour, computed_at) VALUES ('claude', '{}', '', '2026-11-16T12', '2026-11-16T12:00:00.000Z')").run();
  for (const n of names.filter((n) => n >= "0014")) raw.exec(readFileSync(new URL(n, dir), "utf8"));
  raw.exec(cleanup());
  const until = (p: string) => (raw.prepare("SELECT until FROM boundary_watermarks WHERE provider = ?").get(p) as { until: string }).until;
  assert.ok(until("claude") < "2999", "cut to now");
  assert.equal(until("codex"), "2026-11-16T12:00:00.000Z", "a marker in the past stays");
  const weekly = raw.prepare("SELECT generation FROM derived_weekly").all() as { generation: number }[];
  const current = (raw.prepare("SELECT generation FROM data_generation").get() as { generation: number }).generation;
  assert.ok(weekly.every((w) => w.generation < current), "of an older generation: not shown, built again");
});

test("a PC row only an earlier Worker kept from a clock off leaves nothing behind (no state, no liveness, no public value)", async () => {
  const { call, raw, db, env } = await setup();
  const at = new Date("2026-11-16T12:00:00Z");
  const s = snapAt("2026-11-16T11:59:00.000Z");
  s.providers.claude!.error_code = "login_required";
  s.providers.claude!.error = "Sign in required";
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, s), at);
  const ahead = { ...s, generated_at: "2026-11-16T13:00:00.000Z" };
  raw.prepare("UPDATE collector_snapshots SET snapshot = ? WHERE collector = 'mac'").run(JSON.stringify(ahead));
  await repairPublicState(db, env);
  const left = raw.prepare("SELECT body FROM public_state").get() as { body: string };
  assert.deepEqual(JSON.parse(left.body).providers, {}, "no provider's value (and no error state) is left");
});

// ---- Guarantees: each counterexample with its control
const migration0014 = cleanup;
const rateOf = async (call: Awaited<ReturnType<typeof setup>>["call"], at = NOW) =>
  (((await (await call("GET", "/v2/view", READ, undefined, at)).json()) as { claude: { windows: Record<string, { rate_60m: number | null }> } | null }).claude?.windows.five_hour?.rate_60m ?? null);

test("removed observations leave no speed behind (at once after the migration, after the next Cron, and against a late save)", async () => {
  // every 5 minutes for the last hour, 1% at a time
  const good = Array.from({ length: 12 }, (_, i) => obs("five_hour", i, new Date(Date.parse("2026-11-16T11:59:00.000Z") + i * 5 * 60_000).toISOString()));
  // the control: the speed from the kept observations alone
  const control = await setup();
  await control.call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), good));
  await runCron(control.env, NOW);
  const expected = await rateOf(control.call);
  // an earlier Worker kept an observation stamped 5 minutes after its receipt, which changes the speed
  const { call, env, raw, db } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), good));
  raw.prepare(`INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent)
    VALUES ('claude', 'five_hour', 'win-desktop', '2026-11-16T12:52:00.000Z', '2026-11-16T12:46:00.000Z', '2026-11-16T16:00:00.000Z', 60)`).run();
  await runCron(env, NOW);
  const polluted = await rateOf(call);
  assert.notEqual(expected, null, "the kept observations give a speed");
  assert.notEqual(polluted, expected, "the old observation changes the speed (the case is real)");
  const stale = raw.prepare("SELECT version, body, boundary, basis, public_version FROM derived_metrics WHERE provider = 'claude'").get() as any;
  raw.exec(migration0014());
  assert.equal(await rateOf(call), null, "right after the migration: no speed until it is computed again");
  // a Cron that read the observations before the migration saves after it
  await saveDerived(db, "claude", JSON.parse(stale.body), stale.version, NOW, stale.boundary, stale.basis, stale.public_version, 1);
  assert.equal(await rateOf(call), null, "a late save of the old computation doesn't come back");
  await runCron(env, NOW);
  assert.equal(await rateOf(call), expected, "the next Cron, with no upload: the speed of the kept observations");

  // The first save of all comes only after the migration (no row before it): its counter, read before, is older
  const first = await setup();
  await first.call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), good));
  first.raw.prepare(`INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent)
    VALUES ('claude', 'five_hour', 'win-desktop', '2026-11-16T12:52:00.000Z', '2026-11-16T12:46:00.000Z', '2026-11-16T16:00:00.000Z', 60)`).run();
  const readBefore = (first.raw.prepare("SELECT version FROM data_versions WHERE provider = 'claude'").get() as { version: number }).version;
  first.raw.exec("DELETE FROM derived_metrics");
  first.raw.exec(migration0014());
  await saveDerived(first.db, "claude", JSON.parse(stale.body), readBefore, NOW, stale.boundary, stale.basis, stale.public_version, 1);
  assert.equal(await rateOf(first.call), null, "a late first save of the old computation doesn't come back");
  await runCron(first.env, NOW);
  assert.equal(await rateOf(first.call), expected);
});

test("after the migration, the same PC's new fetches on a fixed clock are taken into history and speed", async () => {
  const { call, env, raw } = await setup();
  // a marker recorded by a clock far ahead; the migration cuts it to now (the real clock)
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('claude', 'win-desktop', '2999-01-01T00:00:00.000Z')").run();
  raw.exec(migration0014());
  const at = new Date(Date.now() + 60 * 60_000);
  const iso = (min: number) => new Date(at.getTime() - min * 60_000).toISOString();
  // the account switch the boundary records, 65 minutes before; its guard (5 minutes) is over before the first observation
  raw.prepare("INSERT INTO history_boundaries (provider, since, collector) VALUES ('claude', ?, 'win-desktop')").run(iso(65));
  const s = snapAt(iso(1));
  // every 5 minutes for the last hour, 1% at a time, with resets ahead of then
  const resets = new Date(at.getTime() + 3 * 3_600_000).toISOString();
  for (const p of Object.values(s.providers)) for (const w of p?.windows ?? []) w.resets_at = resets;
  // (all after the cut marker: the first one minutes after the migration ran)
  const rows = Array.from({ length: 12 }, (_, i) => ({ ...obs("five_hour", i, iso(56 - i * 5)), resets_at: resets }));
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, s, rows), at);
  const stored = raw.prepare("SELECT count(*) AS n FROM observations WHERE collector = 'win-desktop'").get() as { n: number };
  assert.equal(stored.n, rows.length, "taken into history");
  await runCron(env, at);
  assert.notEqual(await rateOf(call, at), null, "and used for the speed");
});

test("boundaries put again by Cron (no upload) go under a strictly newer data version", async () => {
  const { call, env, raw, db } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
  const versionOf = async () => ((await (await call("GET", "/v2/view", READ)).json()) as { data_version: number; boundaries: Record<string, string> });
  const before = await versionOf();
  // an acceptance saved whose put of the merged value failed (the values are the same, only the boundary moved)
  raw.prepare("INSERT INTO history_boundaries (provider, since, collector) VALUES ('claude', '2026-11-16T12:00:00.000Z', 'win-desktop')").run();
  raw.prepare("INSERT INTO boundary_epochs (provider, epoch) VALUES ('claude', 1)").run();
  await repairPublicState(db, env);
  const after = await versionOf();
  assert.ok(after.data_version > before.data_version, `${after.data_version} > ${before.data_version}`);
  assert.notEqual(after.boundaries.claude, before.boundaries.claude);
});

test("after a withdrawal, a new upload's value comes under a newer version than the empty one", async () => {
  const { call, env } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()));
  const later = new Date(NOW.getTime() + 32 * 24 * 3_600_000);
  await runCron(env, later);
  await runCron(env, later);
  const empty = (await (await call("GET", "/v2/view", READ, undefined, later)).json()) as { claude: unknown; data_version: number };
  assert.equal(empty.claude, null);
  await call("PUT", "/v2/snapshots/mac", MAC, upload(2, snapAt(new Date(later.getTime() - 60_000).toISOString())), later);
  const back = (await (await call("GET", "/v2/view", READ, undefined, later)).json()) as { claude: unknown; data_version: number };
  assert.notEqual(back.claude, null);
  assert.ok(back.data_version > empty.data_version);
});

// ---- Migration and withdrawal: each found order as a counterexample, with its control
const proxied = (db: D1Like, onSql: (sql: string) => Promise<void> | void): D1Like => ({
  prepare(sql) {
    const st = db.prepare(sql);
    const wrap = (s: typeof st): typeof st => ({
      ...s,
      bind: (...v: unknown[]) => wrap(s.bind(...v)),
      all: async () => { const r = await s.all(); await onSql(sql); return r; },
    }) as typeof st;
    return wrap(st);
  },
  batch: (statements) => db.batch(statements),
});

test("a withdrawal that found no PC never replaces an upload that came meanwhile", async () => {
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()));
  const later = new Date(NOW.getTime() + 32 * 24 * 3_600_000);
  // the Cron reads the PC rows (none left), then an upload completes before it withdraws
  raw.exec("DELETE FROM collector_snapshots");
  let done = false;
  const db = proxied(env.DB, async (sql) => {
    if (done || !sql.startsWith("SELECT collector, snapshot, received_at FROM collector_snapshots")) return;
    done = true;
    await call("PUT", "/v2/snapshots/mac", MAC, upload(2, snapAt(new Date(later.getTime() - 60_000).toISOString())), later);
  });
  await repairPublicState(db, env);
  const view = (await (await call("GET", "/v2/view", READ, undefined, later)).json()) as { claude: unknown };
  assert.notEqual(view.claude, null, "the upload's value stays");
});

test("a merged value an earlier Worker already deleted (with every PC row) is withdrawn under a newer version", async () => {
  const { call, env, raw, db } = await setup();
  await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()));
  const before = ((await (await call("GET", "/v2/view", READ)).json()) as { data_version: number }).data_version;
  raw.exec("DELETE FROM collector_snapshots");
  raw.exec("DELETE FROM public_state");
  assert.equal((await call("GET", "/v2/view", READ)).status, 404);
  await repairPublicState(db, env);
  const res = await call("GET", "/v2/view", READ);
  assert.equal(res.status, 200);
  const view = (await res.json()) as { claude: unknown; data_version: number };
  assert.equal(view.claude, null);
  assert.ok(view.data_version > before);
  // the control: a database that never had a value stays "no value yet"
  const fresh = await setup();
  await repairPublicState(fresh.db, fresh.env);
  assert.equal((await fresh.call("GET", "/v2/view", READ)).status, 404);
});

test("the migration applies each marker as it was recorded to what was saved before it, then cuts it", async () => {
  const { raw } = await setup();
  const t = Date.now();
  const iso = (ms: number) => new Date(t + ms).toISOString();
  raw.prepare("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('claude', 'mac', ?)").run(iso(3_600_000));
  raw.prepare(`INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent)
    VALUES ('claude', 'five_hour', 'mac', ?, ?, NULL, 92)`).run(iso(60_000), iso(-15_000));
  raw.prepare("INSERT INTO collector_snapshots (collector, seq, snapshot, received_at) VALUES ('mac', 1, ?, ?)").run(JSON.stringify(snapAt(iso(0))), iso(0));
  raw.exec(migration0014());
  assert.equal((raw.prepare("SELECT count(*) AS n FROM observations WHERE collector = 'mac'").get() as { n: number }).n, 0, "by the marker as recorded");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_snapshots WHERE collector = 'mac'").get() as { n: number }).n, 0, "its saved latest value too");
  const until = (raw.prepare("SELECT until FROM boundary_watermarks").get() as { until: string }).until;
  assert.ok(until < iso(3_600_000), "then cut to now");
});

test("a weekly series computed before the migration and saved after it doesn't come back", async () => {
  const { raw, db } = await setup();
  const before = new Date(Date.now() - 60_000);
  const hour = before.toISOString().slice(0, 13);
  await saveWeekly(db, "claude", [{ hour, used_percent: 92 } as any], "", hour, new Date(before.getTime() - 60_000), 1);
  raw.exec(migration0014());
  // the Cron that read the representatives before the cleanup (generation 1) saves now
  await saveWeekly(db, "claude", [{ hour, used_percent: 92 } as any], "", hour, before, 1);
  assert.equal(await loadWeekly(db, "claude"), null, "not shown: of the generation before the cleanup");
});

// ---- The upgrade: older agents refused, the data generation, the served version and a used database

test("an upload or a turn from an older agent is refused before D1 is touched; this version's agent writes", async () => {
  const { env, raw } = await setup();
  const before = (raw.prepare("SELECT count(*) AS n FROM collector_snapshots").get() as { n: number }).n;
  const send = (path: string, method: string, body: unknown, protocol: string | null) => {
    const request = new Request(`https://headroom.example${path}`, { method, headers: { authorization: `Bearer ${WIN}`, "content-type": "application/json" },
      body: JSON.stringify(body) });
    request.headers.set("headroom-protocol", protocol ?? "");
    if (protocol === null) request.headers.delete("headroom-protocol");
    return handleRequest(request, env, () => NOW);
  };
  for (const protocol of [null, "1", "2"]) {
    const put = await send("/v2/snapshots/win-desktop", "PUT", sentAt(upload(1, fixture()), NOW), protocol);
    assert.equal(put.status, 426, String(protocol));
    assert.deepEqual(await put.json(), { error: "agent_outdated" });
    assert.equal((await send("/v2/turns/win-desktop", "POST", { claude: 5 }, protocol)).status, 426);
  }
  assert.equal((raw.prepare("SELECT count(*) AS n FROM collector_snapshots").get() as { n: number }).n, before, "nothing saved");
  assert.equal((await send("/v2/snapshots/win-desktop", "PUT", sentAt(upload(1, fixture()), NOW), AGENT_PROTOCOL)).status, 204);
});

test("a speed of an older generation is not shown and is replaced by the next Cron, also without a provider counter and with a higher one", async () => {
  const good = Array.from({ length: 12 }, (_, i) => obs("five_hour", i, new Date(Date.parse("2026-11-16T11:59:00.000Z") + i * 5 * 60_000).toISOString()));
  const { call, env, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture(), good));
  await runCron(env, NOW);
  const expected = await rateOf(call);
  assert.notEqual(expected, null);
  // an earlier Worker's row: counter 7, no provider counters at all, a speed the kept observations don't give
  raw.exec("DELETE FROM data_versions WHERE provider IN ('claude', 'codex')");
  raw.exec(`UPDATE derived_metrics SET version = 7, generation = 0, body = json_set(body, '$.five_hour.metrics.rate_60m', 76.6) WHERE provider = 'claude'`);
  raw.exec(DERIVED_PUBLIC_SQL);
  assert.equal(await rateOf(call), null, "of another generation: not shown");
  await runCron(env, NOW);
  assert.equal(await rateOf(call), expected, "computed again in this generation, whatever its counter");
});

test("a first weekly series whose representatives were read before the cleanup is not saved after it", async () => {
  const { raw, db } = await setup();
  const hour = new Date(Date.now() - 60_000).toISOString().slice(0, 13);
  const read = (raw.prepare("SELECT generation FROM data_generation").get() as { generation: number }).generation;
  raw.exec(cleanup());
  await saveWeekly(db, "claude", [{ hour, used_percent: 92 } as any], "", hour, new Date(), read);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM derived_weekly").get()!.n, 0, "no first row either");
  // the control: a computation in the current generation saves
  await saveWeekly(db, "claude", [{ hour, used_percent: 40 } as any], "", hour, new Date(), read + 1);
  assert.equal((await loadWeekly(db, "claude"))!.series.length, 1);
});

test("right after the cleanup the served version is above every one served before, with no value; the values left come back above it", async () => {
  for (const boundaryOnly of [false, true]) {
    const { call, env, raw } = await setup();
    await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
    await call("PUT", "/v2/snapshots/mac", MAC, upload(1, fixture()));
    if (boundaryOnly) raw.exec("UPDATE public_state SET current_version = version + 3 WHERE id = 1"); // an odd version was served
    const view = async () => (await (await call("GET", "/v2/view", READ)).json()) as { data_version: number; claude: unknown; codex: unknown };
    const before = await view();
    // the cleanup removes the mac's saved value (a marker for it)
    raw.exec("INSERT INTO boundary_watermarks (provider, collector, until) VALUES ('claude', 'mac', '2026-11-16T00:00:00.000Z')");
    raw.exec(cleanup());
    const after = await view();
    assert.ok(after.data_version > before.data_version, `${boundaryOnly}: ${before.data_version} < ${after.data_version}`);
    assert.deepEqual([after.claude, after.codex], [null, null], "no value of a PC whose rows were removed shows");
    await runCron(env, NOW);
    const again = await view();
    // above C (the cleanup's counter): the empty one is 2C - 1, the first put again 2(C + 1) or more
    assert.ok(again.data_version >= after.data_version + 3, `the values left come back under a newer version: ${after.data_version} -> ${again.data_version}`);
    assert.notEqual(again.claude, null);
  }
});

test("a used database with nothing left answers with an empty view, also when no counter or public row is left; a new one with 404", async () => {
  for (const left of ["names", "observations", "hourly", "derived"] as const) {
    const { call, env, raw } = await setup();
    raw.exec("DELETE FROM data_generation");
    // an earlier Worker removed the latest values, the public row and the counters; only one kind of row is left
    if (left === "names") raw.exec("INSERT INTO collector_names (name, slot, seq) VALUES ('mac', 0, 3)");
    if (left === "observations") raw.exec(`INSERT INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent)
      VALUES ('claude', 'five_hour', 'mac', '2026-11-16T11:00:00.000Z', '2026-11-16T11:00:01.000Z', NULL, 10)`);
    if (left === "hourly") raw.exec(`INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
      VALUES ('claude', 'seven_day', '2026-11-16T11', 10, NULL, '2026-11-16T11:00:00.000Z', '2026-11-16T11:00:00.000Z', '2026-11-16T11:00:01.000Z', 'mac', 0)`);
    if (left === "derived") raw.exec("INSERT INTO derived_metrics (provider, computed_at, version, body) VALUES ('claude', '2026-11-16T11:00:00.000Z', 0, '{}')");
    // migration 0014 counts what is there before the cleanup removes anything
    raw.exec(readFileSync(new URL("../migrations/0014_data_generation.sql", import.meta.url), "utf8").replace(/^ALTER TABLE.*$/gm, ""));
    raw.exec(cleanup());
    await runCron(env, NOW);
    const res = await call("GET", "/v2/view", READ);
    assert.equal(res.status, 200, left);
    const body = (await res.json()) as { claude: unknown; codex: unknown };
    assert.deepEqual([body.claude, body.codex], [null, null], left);
  }
  // the control: a new database never used
  const fresh = await setup();
  await runCron(fresh.env, NOW);
  assert.equal((await fresh.call("GET", "/v2/view", READ)).status, 404);
});

test("after the cleanup, a write a request of the earlier Worker was still making is refused; this Worker's writes go through", async () => {
  const { call, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
  raw.exec(cleanup());
  // the earlier Worker's statements (no writer mark): a late batch commits nothing
  const late = [
    `INSERT OR IGNORE INTO observations (provider, window_id, collector, observed_at, first_received_at, resets_at, used_percent)
      VALUES ('claude', 'five_hour', 'mac', '2026-11-16T12:59:00.000Z', '2026-11-16T12:59:01.000Z', NULL, 60)`,
    `INSERT INTO collector_snapshots (collector, seq, snapshot, received_at) VALUES ('mac', 9, '{}', '2026-11-16T12:59:01.000Z')
      ON CONFLICT (collector) DO UPDATE SET seq = excluded.seq`,
    `UPDATE collector_snapshots SET seq = seq + 1 WHERE collector = 'win-desktop'`,
    `INSERT INTO observation_hourly (provider, window_id, hour, used_percent, resets_at, observed_at, effective_at, first_received_at, collector, priority)
      VALUES ('claude', 'seven_day', '2026-11-16T12', 60, NULL, '2026-11-16T12:59:00.000Z', '2026-11-16T12:59:00.000Z', '2026-11-16T12:59:01.000Z', 'mac', 0)`,
    `UPDATE public_state SET body = '{"providers":{"claude":{}}}' WHERE id = 1`,
  ];
  for (const sql of late) assert.throws(() => raw.exec(sql), /earlier Worker/, sql.slice(0, 40));
  assert.equal(raw.prepare("SELECT count(*) AS n FROM collector_snapshots WHERE collector = 'mac'").get()!.n, 0);
  // the control: this Worker's upload and Cron write as before
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture(), [obs("five_hour", 1, "2026-11-16T12:58:00.000Z")]))).status, 204);
  assert.equal((await call("GET", "/v2/view", READ)).status, 200);
});

test("the cleanup run a second time changes nothing and doesn't fail on its own guards", async () => {
  const { call, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
  raw.exec(cleanup());
  const snap = () => JSON.stringify([raw.prepare("SELECT generation FROM data_generation").get(), raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get(),
    raw.prepare("SELECT version, current_version, body FROM public_state").get()]);
  const once = snap();
  raw.exec(cleanup());
  assert.equal(snap(), once);
  // this Worker's writes still go through after it
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture()))).status, 204);
});

test("a used database whose public row is already gone answers with the empty view right after the cleanup", async () => {
  const { call, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
  // an earlier Worker removed the public row and the PC's row
  raw.exec("DELETE FROM public_state");
  raw.exec("DELETE FROM collector_snapshots");
  raw.exec(cleanup());
  const res = await call("GET", "/v2/view", READ);
  assert.equal(res.status, 200, "before any Cron");
  const body = (await res.json()) as { claude: unknown; codex: unknown };
  assert.deepEqual([body.claude, body.codex], [null, null]);
});

test("after the cleanup, an earlier Worker's late DELETE of the withdrawn public row is refused", async () => {
  const { call, raw } = await setup();
  await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()));
  raw.exec(cleanup());
  const before = await (await call("GET", "/v2/view", READ)).json() as { data_version: number };
  assert.throws(() => raw.exec("DELETE FROM public_state WHERE id = 1 AND version = 1"), /earlier Worker/);
  const res = await call("GET", "/v2/view", READ);
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { data_version: number }).data_version, before.data_version, "the same withdrawal");
});
