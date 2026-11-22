// Fetch turns, attempts and the shared stops (holds.ts): the agreed examples
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Snapshot } from "../../core/src/index.ts";
import { AGENT_PROTOCOL, sha256Hex } from "../src/auth.ts";
import { DAILY_BUDGET, metered, OVERHEAD_MAX, RESERVE, reserve, settle } from "../src/budget.ts";
import {
  PENDING_STUCK_MS,
  applyResult,
  decideTurn,
  parseResult,
  parseTurnRequest,
  type HoldRow,
  type TurnRequest,
} from "../src/holds.ts";
import { handle as handleRequest, runCron, type Env } from "../src/index.ts";
import { MAX_STORED_COLLECTORS } from "../src/store.ts";
import { sqliteD1 } from "./d1-sqlite.ts";

const READ = "read-token-for-iphone-0123456789";
const WIN = "write-token-for-win-0123456789ab";
const MAC = "write-token-for-mac-0123456789ab";
const NOW = new Date("2026-11-16T13:00:00.000Z");
const MIN = 60_000;
/** The one-time cleanup run after deploying this version (upgrade/after-deploy.sql) */
const cleanup = () => readFileSync(new URL("../upgrade/after-deploy.sql", import.meta.url), "utf8");
const A1 = "0123456789abcdef";
const A2 = "fedcba9876543210";
const A3 = "00000000000000a3";
const B1 = "00000000000000b1";
const B2 = "00000000000000b2";
const B3 = "00000000000000b3";

const fixture = (): Snapshot =>
  JSON.parse(readFileSync(new URL("../../../fixtures/snapshot/v2-basic.json", import.meta.url), "utf8"));

async function setup(strict = false) {
  const { db, raw } = sqliteD1({ strict });
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
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    request.headers.set("headroom-protocol", AGENT_PROTOCOL);
    return handleRequest(request, env, () => at);
  };
  const pcs = { mac: [MAC, "mac"], win: [WIN, "win-desktop"] } as const;
  type Pc = keyof typeof pcs;
  const post = async (pc: Pc, entry: Record<string, unknown>, at: Date) => {
    const [token, name] = pcs[pc];
    const res = await call("POST", `/v2/turns/${name}`, token, { claude: entry }, at);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(/mac|win-desktop/.test(text), false, "PC names are never returned");
    return (JSON.parse(text) as Record<string, any>).claude;
  };
  /** The kind each attempt was granted as (its result names it) */
  const kinds = new Map<string, string>();
  /** A turn request as a PC makes it: against the row's version it last saw (read with a peek first unless given) */
  const turn = async (
    pc: Pc,
    kind: string,
    attempt: string | null,
    at = NOW,
    gen?: number,
    opts: { base?: number; replace?: string; again?: boolean } = {},
  ) => {
    const grantable = !["peek", "release"].includes(kind);
    const base = grantable ? (opts.base ?? (await post(pc, { kind: "peek" }, at)).state?.version ?? 0) : undefined;
    const answer = await post(pc, {
      kind, attempt,
      ...(gen === undefined ? {} : { gen }),
      ...(base === undefined ? {} : { base }),
      ...(opts.replace ? { replace: opts.replace } : {}),
      ...(opts.again ? { again: true } : {}),
    }, at);
    if (answer.go && attempt) kinds.set(attempt, kind);
    return answer;
  };
  const result = async (pc: Pc, attempt: string, outcome: string, at = NOW, extra: Record<string, unknown> = {}) => {
    const [token, name] = pcs[pc];
    const kind = kinds.get(attempt) ?? "fetch";
    const res = await call("POST", `/v2/turns/${name}/result`, token, { claude: { attempt, kind, outcome, interval_s: 900, minutes: 18, ...extra } }, at);
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as Record<string, any>).claude : null };
  };
  const at = (m: number) => new Date(NOW.getTime() + m * MIN);
  const upload = (seq: number, snapshot: Snapshot) => ({ seq, snapshot: { ...snapshot, generated_at: NOW.toISOString() }, observations: [] });
  return { raw, db, call, env, turn, result, at, upload, post };
}

const row = (over: Partial<HoldRow> = {}): HoldRow => ({
  provider: "claude", version: 1, holder: null, holder_attempt: null, holder_until: null, pending_collector: null, pending_attempt: null,
  pending_kind: null, pending_since: null, rate_stage: 0, rate_until: null, denied: 0, denied_gen: 0, denied_since: null,
  result_attempt: null, retired: null, ...over,
});
const req = (kind: TurnRequest["kind"], attempt: string | null = A1, gen: number | null = null, over: Partial<TurnRequest> = {}): TurnRequest =>
  ({ kind, attempt, gen, base: ["peek", "release"].includes(kind) ? null : 1, replace: null, again: false, ...over });
const t = NOW.getTime();
const iso = (ms: number) => new Date(ms).toISOString();

test("decideTurn: a stop, another pending attempt, a rate limit and another PC's lease hold in that order; own, force and resume pass a lease only", () => {
  const go = (r: HoldRow, q: TurnRequest, writable = true) => decideTurn(r, "mac", q, t, writable);
  assert.equal(go(row(), req("fetch")).answer.go, true);
  assert.deepEqual(go(row(), req("fetch")).update, { pending_collector: "mac", pending_attempt: A1, pending_kind: "fetch", pending_since: iso(t) });
  // a resend of the attempt granted: the same go, nothing written
  const mine = row({ pending_collector: "mac", pending_attempt: A1, pending_kind: "fetch", pending_since: iso(t - 4 * MIN) });
  assert.deepEqual([go(mine, req("fetch")).answer.go, go(mine, req("fetch")).update], [true, { pending_since: iso(t) }], "the 5 minutes count again");
  assert.equal(go(mine, req("own")).answer.reason, "pending", "only for the same kind");
  assert.equal(go(mine, req("fetch"), false).answer.reason, "unavailable", "only while it can deliver");
  // an attempt that ended or was replaced, asked for late: never granted again
  assert.equal(go(row({ retired: JSON.stringify([A1]) }), req("fetch")).answer.reason, "pending");
  // a PC that can't deliver gets nothing
  assert.equal(go(row(), req("fetch"), false).answer.reason, "unavailable");
  // a stop holds every kind but a resume of it
  const denied = row({ denied: 1, denied_gen: 2, denied_since: iso(t - MIN) });
  for (const k of ["fetch", "own", "force"] as const) assert.equal(go(denied, req(k)).answer.reason, "access_denied", k);
  assert.equal(go(denied, req("resume", A1, 1)).answer.reason, "stale_gen", "an earlier stop's resume");
  assert.equal(go(denied, req("resume", A1, 2)).answer.go, true);
  assert.equal(go(row(), req("resume", A1, 1)).answer.reason, "stale_gen", "nothing stopped");
  // another pending attempt holds every kind, also this PC's other one; only an explicit recovery replaces one left 5 minutes
  const other = row({ pending_collector: "win-desktop", pending_attempt: A2, pending_kind: "fetch", pending_since: iso(t - MIN) });
  for (const k of ["fetch", "own", "force"] as const) assert.equal(go(other, req(k)).answer.reason, "pending", k);
  assert.equal(go({ ...other, pending_collector: "mac" }, req("fetch")).answer.reason, "pending", "this PC's other attempt");
  const stuck = { ...other, pending_since: iso(t - PENDING_STUCK_MS) };
  assert.equal(go(stuck, req("fetch")).answer.reason, "pending");
  assert.equal(go(stuck, req("own")).answer.reason, "pending");
  assert.equal(go(stuck, req("force", A1, null, { replace: A2 })).answer.go, true, "the user's force replaces the attempt they named, left pending");
  assert.equal(go(stuck, req("force")).answer.reason, "pending", "not without naming it");
  assert.equal(go(stuck, req("force", A1, null, { replace: A3 })).answer.reason, "gone", "nor another one (it isn't pending)");
  assert.equal(go(row(), req("force", A1, null, { replace: A2 })).answer.reason, "gone", "nor one no longer pending");
  assert.equal(go({ ...stuck, pending_since: iso(t - PENDING_STUCK_MS + 1) }, req("force", A1, null, { replace: A2 })).answer.reason, "pending");
  const stuckResume = row({ denied: 1, denied_gen: 2, pending_collector: "win-desktop", pending_attempt: A2, pending_kind: "resume", pending_since: iso(t - PENDING_STUCK_MS) });
  assert.equal(go(stuckResume, req("resume", A1, 2, { replace: A2 })).answer.go, true, "a resume of the same stop replaces a resume left pending");
  assert.equal(go(stuckResume, req("force")).answer.reason, "access_denied");
  // a rate limit holds every kind
  const limited = row({ rate_stage: 2, rate_until: iso(t + 21_600_000) });
  for (const k of ["fetch", "own", "force"] as const) {
    const a = go(limited, req(k)).answer;
    assert.deepEqual([a.reason, a.wait_s], ["rate_limited", 21_600], k);
  }
  // another PC's lease holds a fetch only; one of a PC that can't deliver holds nothing
  const leased = row({ holder: "win-desktop", holder_attempt: A2, holder_until: iso(t + 10 * MIN) });
  assert.deepEqual([go(leased, req("fetch")).answer.reason, go(leased, req("fetch")).answer.wait_s], ["turn", 600]);
  for (const k of ["own", "force"] as const) assert.equal(go(leased, req(k)).answer.go, true, k);
  assert.equal(decideTurn(leased, "mac", req("fetch"), t, true, false).answer.go, true);
  assert.equal(go(row({ holder: "mac", holder_attempt: A2, holder_until: iso(t + 10 * MIN) }), req("fetch")).answer.go, true, "its own lease");
  // peek and release grant nothing; a release returns only the lease the attempt took
  assert.deepEqual(go(row(), req("peek", null)), { answer: { go: false, kind: "peek", attempt: null, state: { denied: false, denied_gen: 0, rate_stage: 0, rate_wait_s: 0, version: 1 } } });
  // made against another version of the row: moved (asked again with a new attempt); a refusal of a request asked again is kept
  assert.equal(go(row({ version: 2 }), req("fetch")).answer.reason, "moved");
  assert.equal(go(row({ version: 2 }), req("fetch")).update, undefined);
  assert.deepEqual(go(row({ version: 2 }), req("fetch", A1, null, { again: true })).update, { retired: JSON.stringify([A1]) });
  assert.deepEqual(go(leased, req("fetch", A1, null, { again: true })).update, { retired: JSON.stringify([A1]) });
  const held = row({ holder: "mac", holder_attempt: A1, holder_until: iso(t + 10 * MIN) });
  assert.deepEqual(go(held, req("release", A1)).update, { holder: null, holder_attempt: null, holder_until: null });
  assert.equal(go(held, req("release", A2)).update, undefined, "another attempt's lease (taken again since) stays");
});

test("applyResult: only the pending attempt's result applies; a fetch's ok takes the lease, a 429 moves its stage on, a 403 starts a stop once", () => {
  const rep = (outcome: any, extra = {}) => ({ attempt: A1, kind: "fetch" as const, outcome, retry_s: null, interval_s: 900, minutes: 18, ...extra });
  const pending = (kind = "fetch", over: Partial<HoldRow> = {}) =>
    row({ pending_collector: "mac", pending_attempt: A1, pending_kind: kind, pending_since: iso(t), ...over });
  assert.equal(applyResult(row(), "mac", rep("ok"), t), null, "nothing pending");
  assert.equal(applyResult(pending(), "win-desktop", rep("ok"), t), null, "another PC's");
  assert.equal(applyResult(pending(), "mac", { ...rep("ok"), attempt: A2 }, t), null, "another attempt's");
  assert.equal(applyResult(pending(), "mac", rep("ok", { kind: "force" }), t), null, "another kind's");
  const ok = applyResult(pending(), "mac", rep("ok"), t)!;
  assert.deepEqual([ok.update.holder, ok.update.holder_until, ok.update.pending_attempt, ok.mark], ["mac", iso(t + 18 * MIN), null, null]);
  assert.equal(applyResult(pending("fetch"), "mac", rep("ok", { minutes: 500 }), t)!.update.holder_until, iso(t + 90 * MIN), "at most 90 minutes");
  // own, force: the lease stays with its holder
  const leased = { holder: "win-desktop", holder_attempt: A2, holder_until: iso(t + 10 * MIN) };
  for (const k of ["own", "force"] as const) assert.equal(applyResult(pending(k, leased), "mac", rep("ok", { kind: k }), t)!.update.holder, undefined, k);
  // not run: only the pending attempt ends
  const notRun = applyResult(pending("fetch", { holder: "mac", holder_attempt: A2, holder_until: iso(t + 5 * MIN) }), "mac", rep("not_run"), t)!;
  assert.deepEqual(Object.keys(notRun.update).sort(), ["pending_attempt", "pending_collector", "pending_kind", "pending_since", "retired"]);
  // a failure hands this PC's lease back
  assert.equal(applyResult(pending("fetch", { holder: "mac" }), "mac", rep("failed"), t)!.update.holder, null);
  // 429: 30, 60, 120, 240 minutes, at least the interval and the wait named (6 hours stays 21,600 s)
  const stage = (s: number, extra = {}) => applyResult(pending("fetch", { rate_stage: s }), "mac", rep("rate_limited", extra), t)!.update;
  assert.deepEqual([stage(0).rate_stage, stage(0).rate_until], [1, iso(t + 30 * MIN)]);
  assert.deepEqual([stage(3).rate_stage, stage(3).rate_until], [4, iso(t + 240 * MIN)]);
  assert.equal(stage(4).rate_until, iso(t + 240 * MIN), "the last stage stays");
  assert.equal(stage(0, { retry_s: 21_600 }).rate_until, iso(t + 21_600_000));
  assert.equal(applyResult(pending("fetch", leased), "mac", rep("rate_limited"), t)!.update.holder, null, "the lease goes");
  // 403: a stop starts once (its generation), and a resume's success ends it
  const denied = applyResult(pending("fetch", { denied_gen: 3 }), "mac", rep("access_denied"), t)!;
  assert.deepEqual([denied.update.denied, denied.update.denied_gen, denied.mark], [1, 4, "start"]);
  assert.equal(applyResult(pending("resume", { denied: 1, denied_gen: 4 }), "mac", rep("access_denied", { kind: "resume" }), t)!.mark, null, "still the same stop");
  const resumed = applyResult(pending("resume", { denied: 1, denied_gen: 4, rate_stage: 2 }), "mac", rep("ok", { kind: "resume" }), t)!;
  assert.deepEqual([resumed.update.denied, resumed.update.rate_stage, resumed.mark], [0, 0, "end"]);
});

test("requests and results are parsed strictly: one provider, a known kind, an attempt id, no unknown fields", () => {
  assert.ok(parseTurnRequest({ claude: { kind: "fetch", attempt: A1, base: 0 } }));
  assert.ok(parseTurnRequest({ codex: { kind: "peek" } }));
  assert.ok(parseTurnRequest({ gemini: { kind: "resume", attempt: A1, gen: 1, base: 3, replace: A2, again: true } }));
  assert.ok(parseTurnRequest({ claude: { kind: "release", attempt: A1 } }));
  for (const bad of [
    {}, [], "x", { claude: 7 }, { other: { kind: "fetch", attempt: A1 } },
    { claude: { kind: "fetch", attempt: A1 }, codex: { kind: "fetch", attempt: A1 } },
    { claude: { kind: "fetch" } }, { claude: { kind: "fetch", attempt: "ABCDEF0123456789" } }, { claude: { kind: "go", attempt: A1 } },
    { claude: { kind: "peek", attempt: A1 } }, { claude: { kind: "resume", attempt: A1 } }, { claude: { kind: "fetch", attempt: A1, gen: 1 } },
    { claude: { kind: "fetch", attempt: A1, minutes: 7 } },
    { claude: { kind: "fetch", attempt: A1 } }, { claude: { kind: "fetch", attempt: A1, base: -1 } },
    { claude: { kind: "fetch", attempt: A1, base: 0, replace: A2 } }, { claude: { kind: "peek", base: 0 } },
    { claude: { kind: "force", attempt: A1, base: 0, replace: "x" } }, { claude: { kind: "fetch", attempt: A1, base: 0, again: 1 } },
  ]) assert.equal(parseTurnRequest(bad), null, JSON.stringify(bad));
  assert.ok(parseResult({ claude: { attempt: A1, kind: "fetch", outcome: "ok", interval_s: 900, minutes: 18 } }));
  assert.ok(parseResult({ claude: { attempt: A1, kind: "own", outcome: "rate_limited", retry_s: 366 * 86_400, interval_s: 900, minutes: 0 } }));
  for (const bad of [
    { claude: { attempt: A1, outcome: "unknown", interval_s: 900, minutes: 18 } },
    { claude: { attempt: A1, outcome: "ok", interval_s: 60, minutes: 18 } },
    { claude: { attempt: A1, outcome: "rate_limited", retry_s: -1, interval_s: 900, minutes: 0 } },
    { claude: { attempt: A1, outcome: "ok", interval_s: 900, minutes: 18, note: "x" } },
    { claude: { attempt: A1, outcome: "ok", interval_s: 900, minutes: 18 } },
    { claude: { attempt: A1, kind: "peek", outcome: "ok", interval_s: 900, minutes: 18 } },
    { claude: { attempt: A1, kind: "fetch", outcome: "rate_limited", retry_s: 366 * 86_400 + 1, interval_s: 900, minutes: 0 } },
  ]) assert.equal(parseResult(bad), null, JSON.stringify(bad));
});

test("a grant is pending until its result: another PC waits, a fetch's success takes the lease, and a PC's own fetch passes the lease only", async () => {
  const { turn, result, at } = await setup();
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  assert.equal((await turn("mac", "fetch", A1, at(0.1))).go, true, "a resend gets the same go");
  assert.equal((await turn("win", "fetch", A2)).reason, "pending");
  assert.equal((await turn("win", "own", A2)).reason, "pending", "also a PC's own fetch");
  const acked = (await result("mac", A1, "ok", at(0.5))).body;
  assert.deepEqual({ ...acked, state: { ...acked.state, version: 0 } }, { ack: true, attempt: A1, kind: "fetch", applied: true, state: { denied: false, denied_gen: 0, rate_stage: 0, rate_wait_s: 0, version: 0 } });
  assert.ok(acked.state.version > 0, "with the row's version");
  assert.equal((await result("mac", A1, "ok", at(0.6))).body.applied, false, "a resend of it changes nothing");
  const waiting = await turn("win", "fetch", A2, at(1));
  assert.deepEqual([waiting.go, waiting.reason, waiting.wait_s], [false, "turn", 17.5 * 60]);
  // win's own fetch passes the lease (one at a time), and leaves it with mac
  assert.equal((await turn("win", "own", A2, at(2))).go, true);
  assert.equal((await turn("mac", "fetch", A3, at(2.1))).reason, "pending");
  assert.equal((await result("win", A2, "ok", at(2.5))).body.applied, true);
  assert.equal((await turn("win", "fetch", A3, at(3))).reason, "turn");
  // a fetch that sent nothing upstream ends its attempt only
  assert.equal((await turn("mac", "fetch", A3, at(3))).go, true);
  assert.equal((await result("mac", A3, "not_run", at(3.1))).body.applied, true);
  assert.equal((await turn("win", "fetch", B1, at(4))).reason, "turn", "the lease from before stays");
  assert.equal((await turn("win", "fetch", A3, at(4))).reason, "pending", "an attempt that ended is never granted again");
  // the release names the attempt that took the lease
  assert.equal((await turn("mac", "release", A3, at(5))).go, false);
  assert.equal((await turn("win", "fetch", B2, at(5))).reason, "turn", "another attempt's release returns nothing");
  await turn("mac", "release", A1, at(5));
  assert.equal((await turn("win", "fetch", B3, at(5))).go, true);
});

test("PC-A's 6-hour rate limit holds PC-B, also restarted and due for its own fetch; the wait is the Worker's", async () => {
  const { turn, result, at } = await setup();
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  const limited = await result("mac", A1, "rate_limited", at(0.2), { retry_s: 21_600 });
  assert.deepEqual({ ...limited.body.state, version: 0 }, { denied: false, denied_gen: 0, rate_stage: 1, rate_wait_s: 21_600, version: 0 });
  for (const kind of ["fetch", "own", "force"]) {
    const a = await turn("win", kind, A2, at(120));
    assert.deepEqual([a.go, a.reason, a.wait_s], [false, "rate_limited", 21_600 - 119.8 * 60], kind);
  }
  // after the wait one PC is granted; its success ends the stage
  assert.equal((await turn("win", "own", A2, at(360.3))).go, true);
  assert.equal((await turn("mac", "fetch", A3, at(360.4))).reason, "pending");
  assert.equal((await result("win", A2, "ok", at(360.5))).body.state.rate_stage, 0);
});

test("an access denial stops the provider on every PC, shows on the read endpoint over another PC's older success, and makes one event per stop", async () => {
  const { call, turn, result, at, upload, env, raw } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()))).status, 204);
  const before = (await (await call("GET", "/v2/view", READ)).json()) as Record<string, any>;
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  const denied = await result("mac", A1, "access_denied", at(0.2));
  assert.deepEqual({ ...denied.body.state, version: 0 }, { denied: true, denied_gen: 1, rate_stage: 0, rate_wait_s: 0, version: 0 });
  assert.equal((await result("mac", A1, "access_denied", at(0.3))).body.applied, false, "a resend: nothing more");
  // every kind is held, on every PC, also a force
  for (const [pc, kind] of [["win", "fetch"], ["win", "own"], ["mac", "force"], ["win", "force"]] as const) {
    assert.equal((await turn(pc, kind, A2, at(1))).reason, "access_denied", `${pc} ${kind}`);
  }
  // shown at once (a newer data version), and still after another PC's PUT of an older success
  const shown = (await (await call("GET", "/v2/view", READ, undefined, at(1))).json()) as Record<string, any>;
  assert.ok(shown.data_version > before.data_version);
  assert.equal(shown.claude.error_code, "access_denied");
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, fixture()), at(2))).status, 204);
  await runCron(env, at(3));
  const again = (await (await call("GET", "/v2/view", READ, undefined, at(3))).json()) as Record<string, any>;
  assert.equal(again.claude.error_code, "access_denied");
  assert.ok(Object.keys(again.claude.windows).length > 0, "its windows as they were fetched");
  assert.equal(again.codex.error_code, before.codex.error_code, "the other providers go on");
  const feed = async (m: number) =>
    ((await (await call("GET", "/v2/events", READ, undefined, at(m))).json()) as { events: Record<string, any>[] }).events
      .filter((e) => e.kind === "provider_error" && e.error_code === "access_denied");
  assert.equal((await feed(3)).length, 1);
  // a resume of an earlier stop is refused; the stop's own resume ends it on its success
  assert.equal((await turn("win", "resume", A2, at(10), 9)).reason, "stale_gen");
  assert.equal((await turn("win", "resume", A2, at(10), 1)).go, true);
  assert.equal((await result("win", A2, "ok", at(10.5))).body.state.denied, false);
  const resumed = (await (await call("GET", "/v2/view", READ, undefined, at(11))).json()) as Record<string, any>;
  assert.notEqual(resumed.claude.error_code, "access_denied");
  // a second stop is a second event
  assert.equal((await turn("mac", "fetch", A3, at(20))).go, true);
  assert.equal((await result("mac", A3, "access_denied", at(20.2))).body.state.denied_gen, 2);
  await runCron(env, at(25));
  assert.equal((await feed(25)).length, 2);
  // nothing about an account in the table
  assert.equal(/@|token|Bearer/.test(JSON.stringify(raw.prepare("SELECT * FROM provider_holds").all())), false);
});

test("a stop marked before any PC's value was put shows on the read endpoint; the Cron's repair keeps it", async () => {
  const { call, turn, result, at, env } = await setup();
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  await result("mac", A1, "access_denied", at(0.2));
  const v = (await (await call("GET", "/v2/view", READ, undefined, at(1))).json()) as Record<string, any>;
  assert.equal(v.claude.error_code, "access_denied");
  await runCron(env, at(5));
  assert.equal(((await (await call("GET", "/v2/view", READ, undefined, at(6))).json()) as Record<string, any>).claude.error_code, "access_denied");
});

test("no budget left, or a PC that can't deliver: nothing granted and nothing written; a result that can't be applied isn't acknowledged", async () => {
  const { raw, turn, result, at, call } = await setup();
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-16', 0, ?) ON CONFLICT (day) DO UPDATE SET writes = excluded.writes")
    .run(DAILY_BUDGET.writes - RESERVE.turn.writes + 1);
  const refused = await turn("win", "fetch", A2, at(1));
  assert.deepEqual([refused.go, refused.reason], [false, "unavailable"]);
  assert.equal((await result("mac", A1, "ok", at(1))).status, 503, "not acknowledged: the PC sends it again");
  raw.exec("DELETE FROM d1_budget");
  assert.equal((await result("mac", A1, "ok", at(2))).body.applied, true);
  // registrable names used up: an unregistered PC gets nothing, and a lease it took before holds no one off
  const { raw: raw2, turn: turn2, result: result2, call: call2, upload } = await setup();
  const register = raw2.prepare("INSERT INTO collector_names (name, slot) VALUES (?, ?)");
  for (let i = 0; i < MAX_STORED_COLLECTORS - 1; i++) register.run(`old-${i}`, i);
  assert.equal((await turn2("mac", "fetch", A1)).go, true);
  assert.equal((await result2("mac", A1, "ok", at(0.5))).body.applied, true);
  assert.equal((await call2("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()))).status, 204);
  assert.equal((await turn2("mac", "fetch", A3, at(1))).reason, "unavailable");
  assert.equal((await turn2("win", "fetch", A2, at(1))).go, true, "mac's lease holds no one off");
  void call;
});

test("a grant and the heaviest result (an access denial) each stay within one turn's D1 reservation, with room for the event's indexes", async () => {
  const { raw, turn, result, at, post } = await setup();
  const used = () => (raw.prepare("SELECT coalesce(sum(reads), 0) AS reads, coalesce(sum(writes), 0) AS writes FROM d1_budget").get() as { reads: number; writes: number });
  const delta = async (run: () => Promise<unknown>) => {
    const before = used();
    await run();
    const after = used();
    return { reads: after.reads - before.reads, writes: after.writes - before.writes };
  };
  const peeked = await delta(() => post("mac", { kind: "peek" }, NOW));
  const granted = await delta(() => turn("mac", "fetch", A1, NOW, undefined, { base: 0 }));
  assert.ok(peeked.reads <= RESERVE.turn.reads && peeked.writes <= RESERVE.turn.writes, "a peek");
  const denied = await delta(() => result("mac", A1, "access_denied", at(0.2)));
  // The stand-in counts changed rows only: the event's three indexes (key, keep_until, visible feed) add three writes in D1
  for (const [label, d] of [["grant", granted], ["denial", denied]] as const) {
    assert.ok(d.reads <= RESERVE.turn.reads, `${label} reads ${d.reads}`);
    assert.ok(d.writes + 3 <= RESERVE.turn.writes, `${label} writes ${d.writes}`);
  }
});

test("turn and result requests need this protocol and a write credential for the PC's own name; invalid bodies return 400", async () => {
  const { call } = await setup();
  const body = { claude: { kind: "fetch", attempt: A1, base: 0 } };
  assert.equal((await call("POST", "/v2/turns/mac", READ, body)).status, 403);
  assert.equal((await call("POST", "/v2/turns/mac", WIN, body)).status, 403);
  assert.equal((await call("POST", "/v2/turns/mac/result", WIN, { claude: { attempt: A1, kind: "fetch", outcome: "ok", interval_s: 900, minutes: 18 } })).status, 403);
  assert.equal((await call("POST", "/v2/turns/mac")).status, 401);
  assert.equal((await call("GET", "/v2/turns/mac", MAC)).status, 405);
  assert.equal((await call("GET", "/v2/turns/mac/result", MAC)).status, 405);
  assert.equal((await call("POST", "/v2/turns/mac", MAC, { claude: 7 })).status, 400, "the earlier form");
  assert.equal((await call("POST", "/v2/turns/mac/result", MAC, { claude: { attempt: A1 } })).status, 400);
});

test("a go asked for again after its answer was lost counts the 5 minutes again, so a force never overlaps it", async () => {
  const { turn, at } = await setup();
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  // the answer was lost; mac asks again 4 minutes 59 seconds later and is granted again (its go is good for 60 seconds from now)
  assert.equal((await turn("mac", "fetch", A1, at(4 + 59 / 60))).go, true);
  // win's force at 5 minutes: the attempt was granted 1 second ago, not left pending for 5 minutes
  assert.equal((await turn("win", "force", A2, at(5))).reason, "pending");
  assert.equal((await turn("win", "force", A2, at(10))).reason, "pending", "not without naming the attempt replaced");
  assert.equal((await turn("win", "force", A2, at(10), undefined, { replace: A1 })).go, true, "5 minutes after the last grant");
  // mac's late request of the replaced attempt isn't granted again
  assert.equal((await turn("mac", "fetch", A1, at(10.1))).reason, "pending");
});

test("a late copy of a request is never granted, also after 8 other attempts ended, nor after its own refusal and the lease's end", async () => {
  const { turn, result, at, post } = await setup();
  // X made against the row as it was; 9 other attempts end before the copy comes
  const base = (await post("mac", { kind: "peek" }, NOW)).state.version;
  const others = ["00000000000000c1", "00000000000000c2", "00000000000000c3", "00000000000000c4", "00000000000000c5",
    "00000000000000c6", "00000000000000c7", "00000000000000c8", "00000000000000c9"];
  for (const [i, a] of others.entries()) {
    assert.equal((await turn("win", "own", a, at(i))).go, true);
    await result("win", a, "not_run", at(i + 0.1));
  }
  const late = await turn("mac", "fetch", A1, at(20), undefined, { base });
  assert.deepEqual([late.go, late.reason], [false, "moved"], "the row moved on since");
  // X asked again (its first answer lost) and refused while win holds the lease; the lease ends by time, then the first copy of X comes
  const { turn: turn2, result: result2, at: at2, post: post2 } = await setup();
  assert.equal((await turn2("win", "fetch", A2)).go, true);
  await result2("win", A2, "ok", at2(0.1));
  const seen = (await post2("mac", { kind: "peek" }, at2(0.2))).state.version;
  const refused = await turn2("mac", "fetch", A1, at2(1), undefined, { base: seen, again: true });
  assert.equal(refused.reason, "turn");
  const copy = await turn2("mac", "fetch", A1, at2(30), undefined, { base: seen });
  assert.equal(copy.go, false, "no pending attempt is left behind for it");
});

test("two batches of the same result read at once: the one that loses writes nothing more", async () => {
  const { db, raw, env, turn, at } = await setup();
  assert.equal((await turn("mac", "fetch", A1)).go, true);
  const { reportResult } = await import("../src/holds.ts");
  const rep = { attempt: A1, kind: "fetch" as const, outcome: "access_denied" as const, retry_s: null, interval_s: 900, minutes: 0 };
  // the first batch is held until the second has run whole (both read the same row)
  let held: Promise<unknown> | null = null;
  const racing = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: Parameters<typeof db.batch>[0]) => {
      if (!held) {
        held = reportResult(db, "mac", "claude", rep, at(0.3), 2);
        await held;
      }
      return db.batch(statements);
    },
  };
  const first = await reportResult(racing, "mac", "claude", rep, at(0.2), 2);
  assert.equal(first?.applied, false, "read again: no longer pending");
  const versions = (raw.prepare("SELECT version FROM data_versions WHERE provider = 'all'").get() as { version: number }).version;
  assert.equal(versions, 1, "the global counter moved on once");
  const holds = JSON.parse((raw.prepare("SELECT holds FROM public_state WHERE id = 1").get() as { holds: string }).holds);
  assert.equal(holds.claude.since, at(0.3).toISOString(), "marked by the batch that won");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM events WHERE key LIKE 'access_denied:%'").get() as { n: number }).n, 1);
  void env;
});

test("right after the upgrade cleanup (writes marked by this Worker only), a denial is still marked, counted and told", async () => {
  const { raw, call, turn, result, at, upload } = await setup();
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, fixture()))).status, 204);
  raw.exec(cleanup());
  assert.equal((await turn("mac", "fetch", A1, at(1))).go, true);
  const r = await result("mac", A1, "access_denied", at(1.2));
  assert.deepEqual([r.status, r.body?.applied], [200, true]);
  const v = (await (await call("GET", "/v2/view", READ, undefined, at(2))).json()) as Record<string, any>;
  assert.equal(v.claude.error_code, "access_denied");
  // and the stop's end too
  assert.equal((await turn("mac", "resume", A2, at(3), 1)).go, true);
  assert.equal((await result("mac", A2, "ok", at(3.2))).status, 200);
});

test("with no stop marked, a PC's own access denial in its value isn't shown (old windows, or none) on either read or to the Cron", async () => {
  const { call, at, upload, env } = await setup();
  const denied = fixture();
  denied.providers.claude = { ...denied.providers.claude!, status: "error", error: "Access denied", error_code: "access_denied" };
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(1, denied))).status, 204);
  const view = (await (await call("GET", "/v2/view", READ, undefined, at(1))).json()) as Record<string, any>;
  assert.notEqual(view.claude.error_code, "access_denied");
  assert.equal(view.claude.status, "stale", "its windows shown as old");
  const snap = (await (await call("GET", "/v2/snapshot", READ, undefined, at(1))).json()) as Record<string, any>;
  assert.notEqual(snap.providers.claude.error_code, "access_denied");
  await runCron(env, at(5));
  const feed = ((await (await call("GET", "/v2/events", READ, undefined, at(5))).json()) as { events: Record<string, any>[] }).events;
  assert.equal(feed.filter((e) => e.error_code === "access_denied").length, 0, "no event from it");
  // with no windows, nothing of it is shown
  const bare = fixture();
  bare.providers.claude = { ...bare.providers.claude!, windows: [], status: "error", error: "Access denied", error_code: "access_denied" };
  assert.equal((await call("PUT", "/v2/snapshots/win-desktop", WIN, upload(2, bare))).status, 204);
  const none = (await (await call("GET", "/v2/snapshot", READ, undefined, at(1))).json()) as Record<string, any>;
  assert.equal(none.providers.claude, undefined);
});

test("every turn path stays within one turn's D1 reservation as D1 counts it (rows scanned, indexes written), also on a new UTC day", async () => {
  const { raw, turn, result, at, post } = await setup(true);
  // rows a scan would read (none of the turn's statements may scan them)
  const event = raw.prepare("INSERT INTO events (key, visible, created_at, keep_until, body) VALUES (?, 1, ?, ?, '{}')");
  for (let i = 0; i < 200; i++) event.run(`k${i}`, NOW.toISOString(), at(60 * 24 * 30).toISOString());
  const used = () => raw.prepare("SELECT coalesce(sum(reads), 0) AS reads, coalesce(sum(writes), 0) AS writes FROM d1_budget").get() as { reads: number; writes: number };
  const paths: [string, number, number][] = [];
  const within = async (label: string, run: () => Promise<unknown>) => {
    const before = used();
    await run();
    const after = used();
    const d = [after.reads - before.reads, after.writes - before.writes] as const;
    paths.push([label, ...d]);
    // What the budget row got is the turn's own statements plus those of reserving and settling it (as for a day row there already,
    // with nothing to delete): the turn's own fit in the reservation less the most those can use
    assert.ok(d[0] >= typical.reads && d[1] >= typical.writes, `${label}: its reserve and settle statements are accounted`);
    const business = [d[0] - typical.reads, d[1] - typical.writes] as const;
    assert.ok(
      business[0] <= RESERVE.turn.reads - OVERHEAD_MAX.reads && business[1] <= RESERVE.turn.writes - OVERHEAD_MAX.writes,
      `${label}: ${business[0]} reads, ${business[1]} writes of its own`,
    );
  };
  const { accounted: typical } = await overheadOf(["2026-11-16"], 0, true, new Date("2026-11-16T12:00:00Z"));
  const version = async (m: number) => (await post("mac", { kind: "peek" }, at(m))).state.version as number;
  await within("peek", () => post("mac", { kind: "peek" }, NOW));
  await within("grant", async () => assert.equal((await turn("mac", "fetch", A1, NOW, undefined, { base: 0 })).go, true));
  await within("grant asked again", async () => assert.equal((await turn("mac", "fetch", A1, at(0.2), undefined, { base: 0 })).go, true));
  let base = await version(0.25);
  await within("refused: pending", async () => assert.equal((await turn("win", "fetch", A2, at(0.3), undefined, { base })).reason, "pending"));
  await within("refused: moved", async () => assert.equal((await turn("win", "fetch", A2, at(0.4), undefined, { base: 999 })).reason, "moved"));
  await within("refused, asked again (kept)", async () =>
    assert.equal((await turn("win", "fetch", B1, at(0.5), undefined, { base, again: true })).reason, "pending"));
  await within("result: ok, a lease", async () => assert.equal((await result("mac", A1, "ok", at(1))).body.applied, true));
  await within("result: not applied", async () => assert.equal((await result("mac", A1, "ok", at(1.1))).body.applied, false));
  base = await version(1.5);
  await within("refused: lease", async () => assert.equal((await turn("win", "fetch", B2, at(2), undefined, { base })).reason, "turn"));
  await within("release", () => turn("mac", "release", A1, at(2.5)));
  base = await version(2.8);
  await within("grant: own", async () => assert.equal((await turn("mac", "own", A3, at(3), undefined, { base })).go, true));
  base = await version(8.9);
  await within("grant: a force replacing it", async () =>
    assert.equal((await turn("win", "force", B3, at(9), undefined, { base, replace: A3 })).go, true));
  await within("result: access denied (the event, the mark)", async () => assert.equal((await result("win", B3, "access_denied", at(9.5))).body.applied, true));
  base = await version(9.9);
  await within("refused: a stop over", async () =>
    assert.equal((await turn("win", "resume", "00000000000000c1", at(10), 9, { base })).reason, "stale_gen"));
  await within("grant: resume", async () =>
    assert.equal((await turn("win", "resume", "00000000000000c1", at(10.5), 1, { base })).go, true));
  await within("result: the stop ends", async () => assert.equal((await result("win", "00000000000000c1", "ok", at(11))).body.state.denied, false));
  // the next UTC day: a new budget row
  const tomorrow = new Date("2026-11-17T00:00:30.000Z");
  const before = raw.prepare("SELECT count(*) AS n FROM d1_budget").get() as { n: number };
  await post("mac", { kind: "peek" }, tomorrow);
  assert.equal((raw.prepare("SELECT count(*) AS n FROM d1_budget").get() as { n: number }).n, before.n + 1);
  const day2 = raw.prepare("SELECT reads, writes FROM d1_budget WHERE day = '2026-11-17'").get() as { reads: number; writes: number };
  assert.ok(day2.reads <= RESERVE.turn.reads && day2.writes <= RESERVE.turn.writes, JSON.stringify(day2));
  assert.ok(paths.length >= 15);
});

/**
 * Reserves and settles a run of no statements of its own, as withinBudget does: what each counted day got, and what the reserve and
 * settle statements used as D1 counts it. `older`: rows of days before kept by earlier reservations; `existing`: the days' rows are there
 */
async function overheadOf(days: string[], older: number, existing: boolean, end: Date) {
  const { db, raw } = sqliteD1({ strict: true });
  const add = raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES (?, 0, 0)");
  for (const day of ["2026-11-10", "2026-11-11", "2026-11-12"].slice(0, older)) add.run(day);
  if (existing) for (const day of days) add.run(day);
  const r = metered(db);
  assert.equal(await reserve(r.db, days, RESERVE.turn), "reserved");
  const s = metered(db);
  await settle(s.db, days, RESERVE.turn, { reads: r.usage.reads, writes: r.usage.writes }, end);
  const rows = raw.prepare("SELECT reads, writes FROM d1_budget WHERE day >= '2026-11-16'").all() as { reads: number; writes: number }[];
  return {
    // a run spanning days is counted in full on each
    accounted: { reads: Math.max(...rows.map((x) => x.reads)), writes: Math.max(...rows.map((x) => x.writes)) },
    actual: { reads: r.usage.reads + s.usage.reads, writes: r.usage.writes + s.usage.writes },
  };
}

test("reserving and settling is accounted at least as D1 counts it, and never past OVERHEAD_MAX", async () => {
  const cases: [string[], Date][] = [
    [["2026-11-16"], new Date("2026-11-16T12:00:00Z")],
    // a run that ends past its one reserved day (settled on both)
    [["2026-11-16"], new Date("2026-11-17T00:00:10Z")],
    [["2026-11-16", "2026-11-17"], new Date("2026-11-17T00:00:10Z")],
  ];
  // the most older rows a reservation deletes are the three a two-day reservation kept (the day before and both days)
  for (const [days, end] of cases) for (const older of [0, 1, 3]) for (const existing of [false, true]) {
    const { accounted, actual } = await overheadOf(days, older, existing, end);
    const label = `${days.length} day(s) to ${end.toISOString()}, ${older} older, rows ${existing ? "there" : "new"}`;
    assert.ok(actual.reads <= accounted.reads && actual.writes <= accounted.writes, `${label}: used ${JSON.stringify(actual)}, accounted ${JSON.stringify(accounted)}`);
    assert.ok(accounted.reads <= OVERHEAD_MAX.reads && accounted.writes <= OVERHEAD_MAX.writes, `${label}: ${JSON.stringify(accounted)}`);
  }
});

test("a settle whose time was read just before 00:00 UTC counts the next day too (its batch may run then)", async () => {
  const { db, raw } = sqliteD1({ strict: true });
  const days = ["2026-11-16", "2026-11-17"];
  assert.equal(await reserve(db, days, RESERVE.turn), "reserved");
  await settle(db, days, RESERVE.turn, { reads: 3, writes: 2 }, new Date("2026-11-16T23:59:59.999Z"));
  const rows = raw.prepare("SELECT day, writes FROM d1_budget ORDER BY day").all() as { day: string; writes: number }[];
  assert.deepEqual(rows.map((r) => r.day), days);
  assert.ok(rows.every((r) => r.writes >= 2), JSON.stringify(rows));
});

test("the strict stand-in counts what D1 counts: a scan reads the table, a search by key one row, a write each index", async () => {
  const { db, raw } = sqliteD1({ strict: true });
  const meta = (r: unknown) => (r as { meta: { rows_read: number; rows_written: number } }).meta;
  const add = raw.prepare("INSERT INTO events (key, visible, created_at, keep_until, body) VALUES (?, 1, ?, ?, '{}')");
  for (let i = 0; i < 50; i++) add.run(`k${i}`, NOW.toISOString(), NOW.toISOString());
  const scan = await db.prepare("SELECT count(*) AS n FROM events WHERE body = ?").bind("x").all();
  assert.ok(meta(scan).rows_read >= 50, "a scan");
  const byKey = await db.prepare("SELECT * FROM provider_holds WHERE provider = ?").bind("claude").all();
  assert.equal(meta(byKey).rows_read, 1, "a search by key");
  const indexes = (raw.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").get() as { c: number }).c;
  assert.ok(indexes >= 2);
  const insert = await db.prepare("INSERT OR IGNORE INTO events (key, visible, created_at, keep_until, body) VALUES ('new', 1, ?, ?, '{}')")
    .bind(NOW.toISOString(), NOW.toISOString()).run();
  assert.equal(meta(insert).rows_written, 1 + indexes + 1, "the row, each index, and the AUTOINCREMENT counter");
  // an insert ignored still moves the counter
  const ignored = await db.prepare("INSERT OR IGNORE INTO events (key, visible, created_at, keep_until, body) VALUES ('new', 1, ?, ?, '{}')")
    .bind(NOW.toISOString(), NOW.toISOString()).run();
  assert.equal(meta(ignored).rows_written, 1, "the counter only");
  // an update writes only the indexes over a column it sets
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-16', 0, 0)").run();
  const counted = await db.prepare("UPDATE d1_budget SET reads = reads + 1 WHERE day = ?").bind("2026-11-16").run();
  assert.equal(meta(counted).rows_written, 1, "its key not set");
  // a search by key reads one row for each key looked up
  raw.prepare("INSERT INTO d1_budget (day, reads, writes) VALUES ('2026-11-17', 0, 0)").run();
  const two = await db.prepare("SELECT count(*) AS n FROM d1_budget WHERE day IN (?, ?)").bind("2026-11-16", "2026-11-17").all();
  assert.equal(meta(two).rows_read, 2, "two keys (one row returned)");
  const none = await db.prepare("UPDATE events SET visible = 0 WHERE body = ?").bind("nothing").run();
  assert.ok(meta(none).rows_read >= 50, "an update that changes nothing still scans");
  assert.equal(meta(none).rows_written, 0);
});
