import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSnapshot,
  emptyEventState,
  emptyProvider,
  judgeEvents,
  makeWindow,
  toView,
  type EventState,
  type JudgedEvent,
  type UsageObservation,
  type UsageWindow,
} from "../src/index.ts";

const base = Date.parse("2026-11-16T12:00:00Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
const session = (used: number, reset: number | null = 180, fetched = 0) =>
  makeWindow("five_hour", used, reset === null ? null : at(reset), { fetched_at: at(fetched) });

interface Options {
  now?: number;
  observations?: UsageObservation[];
  blocked?: boolean | null;
  error?: "login_required" | "safety_stop" | "fetch_failed" | null;
  received?: number | null;
  boundaries?: Record<string, string>;
  /** The provider the windows belong to (default Claude) */
  provider?: "claude" | "codex" | "gemini";
}

function judge(windows: UsageWindow[], state: EventState, o: Options = {}) {
  const now = new Date(at(o.now ?? 1));
  const snapshot = buildSnapshot({
    [o.provider ?? "claude"]: { ...emptyProvider("ok", null), collector: "win", windows, blocked: o.blocked ?? null, error_code: o.error ?? null },
  });
  const received = o.received === undefined ? (o.now ?? 1) : o.received;
  snapshot.collectors = [{ id: "win", generated_at: at(0), received_at: received === null ? null : at(received) }];
  const view = toView(snapshot, now, { observations: o.observations ?? [] });
  return judgeEvents(view, state, { last_received_at: view.last_received_at }, now, o.boundaries ? { boundaries: o.boundaries } : undefined);
}

const visible = (events: JudgedEvent[]) => events.filter((e) => e.visible).map((e) => e.key);
const hidden = (events: JudgedEvent[]) => events.filter((e) => !e.visible).map((e) => e.key);

test("thresholds: show only the largest crossed, mark smaller ones done; the cycle is decided by reset time", () => {
  const first = judge([session(85)], emptyEventState());
  assert.deepEqual(visible(first.events), [`threshold:claude:five_hour:${at(180)}:80`]);
  assert.equal(first.state.cycles["claude.five_hour"]?.alerted, true);

  const jump = judge([session(96)], emptyEventState());
  assert.deepEqual(visible(jump.events), [`threshold:claude:five_hour:${at(180)}:95`]);
  assert.deepEqual(hidden(jump.events), [`threshold:claude:five_hour:${at(180)}:80`]);

  // A 3-minute reset-time shift is the same cycle (the key is the first reset time seen)
  const drift = judge([makeWindow("five_hour", 96, at(183), { fetched_at: at(5) })], first.state, { now: 6 });
  assert.ok(visible(drift.events).includes(`threshold:claude:five_hour:${at(180)}:95`));
});

test("limit: an overall window at 100% also marks thresholds done; a per-model window only gets a limit and isn't a reset condition", () => {
  const model = { ...makeWindow("seven_day_fable", 100, at(5000), { fetched_at: at(0) }), scope: "Fable" };
  const result = judge([session(100), model], emptyEventState());
  assert.deepEqual(visible(result.events).sort(), [
    `limit:claude:five_hour:${at(180)}`, `limit:claude:seven_day_fable:${at(5000)}`,
  ].sort());
  assert.equal(hidden(result.events).length, 2);
  assert.equal(result.state.cycles["claude.seven_day_fable"]?.alerted, false);

  // Codex's API confirmed blocked but no window is at 100%: limit on the most-used overall window
  const blocked = judge([session(70)], emptyEventState(), { blocked: true, provider: "codex" });
  const limit = blocked.events.find((e) => e.body.kind === "limit");
  assert.equal(limit?.key, `limit:codex:five_hour:${at(180)}`);
  assert.equal(limit?.body.blocked, true);
  // Claude's and Gemini's flag follows from an overall window at 100%: with none now, nothing stands in for it
  for (const provider of ["claude", "gemini"] as const) {
    const r = judge([session(70)], emptyEventState(), { blocked: true, provider });
    assert.equal(r.events.some((e) => e.body.kind === "limit"), false, provider);
  }
  // Claude's without any window (an earlier agent reported it so) is still told; Gemini's isn't
  assert.equal(judge([], emptyEventState(), { blocked: true }).events.filter((e) => e.body.kind === "limit").length, 1);
  assert.equal(judge([], emptyEventState(), { blocked: true, provider: "gemini" }).events.filter((e) => e.body.kind === "limit").length, 0);
});

test("reset: when a notified cycle ends and a new one is observed, one confirmed reset; none if not notified", () => {
  const alerted = judge([session(90)], emptyEventState()).state;
  const next = judge([session(3, 480, 200)], alerted, { now: 201 });
  const reset = next.events.find((e) => e.body.kind === "reset");
  assert.equal(reset?.key, `reset:claude:five_hour:${at(180)}`);
  assert.equal(reset?.body.confirmed, true);
  assert.equal(next.state.cycles["claude.five_hour"]?.cycle, at(480));
  assert.equal(next.state.cycles["claude.five_hour"]?.alerted, false);

  const quiet = judge([session(50)], emptyEventState()).state;
  assert.equal(judge([session(3, 480, 200)], quiet, { now: 201 }).events.length, 0);

  // Claude's 5-hour window: not started after a reset (0%, no reset time) is also a new cycle
  const idle = judge([session(0, null, 190)], alerted, { now: 191 });
  assert.deepEqual(visible(idle.events), [`reset:claude:five_hour:${at(180)}`]);
  assert.equal(idle.state.cycles["claude.five_hour"], undefined);
});

test("estimated reset: with no live PC past the reset time, an estimated one after 10 minutes; not duplicated when observed later", () => {
  // Collection stopped is a separate event, so mark it as already notified here
  const alerted = { ...judge([session(90)], emptyEventState()).state, stopped: true };
  // If a PC is alive (received after the reset), wait for its observation
  const waiting = judge([session(90)], alerted, { now: 195, received: 185 });
  assert.deepEqual(waiting.events.map((e) => e.body.kind), ["collection_resumed"], "no estimated reset is created");
  // Not created until 10 minutes have passed
  assert.equal(judge([session(90)], alerted, { now: 185, received: 100 }).events.length, 0);
  const estimated = judge([session(90)], alerted, { now: 191, received: 100 });
  const reset = estimated.events.find((e) => e.body.kind === "reset");
  assert.equal(reset?.body.confirmed, false);
  assert.equal(estimated.state.cycles["claude.five_hour"]?.reset_sent, true);
  assert.equal(judge([session(90)], estimated.state, { now: 196, received: 100 }).events.length, 0);
  // Observing the new cycle later doesn't create a duplicate reset
  const observed = judge([session(2, 480, 300)], estimated.state, { now: 301 });
  assert.equal(observed.events.filter((e) => e.body.kind === "reset").length, 0);
});

test("limit soon: show only the smallest minutes crossed at the faster rate; none while confidence is low", () => {
  const rows: UsageObservation[] = Array.from({ length: 12 }, (_, i) => ({
    provider: "claude", window_id: "five_hour", collector: "win", resets_at: at(180),
    used_percent: 30 + i * 5, observed_at: at(-60 + i * 5),
  }));
  // 60% in 60 minutes (1%/minute). 10% left, about 10 minutes
  const result = judge([session(90)], emptyEventState(), { observations: rows });
  const soon = result.events.filter((e) => e.body.kind === "soon");
  assert.deepEqual(soon.filter((e) => e.visible).map((e) => e.body.threshold), [15]);
  assert.deepEqual(soon.filter((e) => !e.visible).map((e) => e.body.threshold), [30]);
  assert.equal(soon[0]?.body.confidence, "high");

  // With only 2 observations (low confidence), none is created (prevents false alerts)
  const early = judge([session(90)], emptyEventState(), { observations: rows.slice(-1) });
  assert.equal(early.events.filter((e) => e.body.kind === "soon").length, 0);
});

test("sign-in expired / safety stop: once on change; created again if it recurs after recovering", () => {
  const first = judge([session(10)], emptyEventState(), { error: "login_required" });
  assert.equal(first.events.filter((e) => e.body.kind === "provider_error").length, 1);
  assert.equal(judge([session(10)], first.state, { error: "login_required" }).events.length, 0);
  // fetch_failed isn't notified. Clear the state on recovery
  const other = judge([session(10)], first.state, { error: "fetch_failed" });
  assert.equal(other.events.length, 0);
  assert.equal(other.state.errors.claude, null);
  assert.equal(judge([session(10)], other.state, { error: "login_required" }).events.length, 1);
});

test("collection stopped: once after 30 minutes without data from any PC, once on recovery", () => {
  const alive = judge([session(10)], emptyEventState(), { now: 20, received: 0 });
  assert.equal(alive.events.length, 0);
  const stopped = judge([session(10)], alive.state, { now: 31, received: 0 });
  assert.deepEqual(stopped.events.map((e) => e.body.kind), ["collection_stopped"]);
  assert.equal(stopped.state.stopped, true);
  assert.equal(judge([session(10)], stopped.state, { now: 40, received: 0 }).events.length, 0);
  const resumed = judge([session(10)], stopped.state, { now: 45, received: 44 });
  assert.deepEqual(resumed.events.map((e) => e.body.kind), ["collection_resumed"]);
  assert.equal(resumed.state.stopped, false);
});

test("event body holds the values media use and the reliability label (no account information)", () => {
  const [event] = judge([session(85)], emptyEventState()).events;
  assert.deepEqual(Object.keys(event!.body).sort(), [
    "blocked", "boundary", "confidence", "confirmed", "cycle", "error_code", "eta_minutes", "kind", "label", "last_received_at",
    "provider", "resets_at", "scope", "status_text", "threshold", "used_percent", "window_id",
  ]);
  assert.equal(event!.body.boundary, null, "judged without boundaries");
  assert.equal(event!.body.used_percent, 85);
  assert.equal(event!.body.label, "5h");
  assert.ok(Date.parse(event!.keep_until) >= base + 8 * 24 * 3_600_000);
});

test("repeating the same input returns neither events nor state changes (no writes)", () => {
  const first = judge([session(96)], emptyEventState());
  const again = judge([session(96)], first.state);
  assert.equal(again.events.length, 0);
  assert.deepEqual(again.state, first.state);
});

test("same window fetch time: no new usage/forecast events even if late observations change derived values", () => {
  const rows: UsageObservation[] = Array.from({ length: 12 }, (_, i) => ({
    provider: "claude", window_id: "five_hour", collector: "win", resets_at: at(180),
    used_percent: 30 + i * 5, observed_at: at(-60 + i * 5),
  }));
  const base = judge([session(90)], emptyEventState(), { observations: rows.slice(-1) });
  assert.equal(base.events.filter((e) => e.body.kind === "soon").length, 0, "confidence is low with 2 observations");
  // Even if old observations arrive later and enable a forecast, nothing is created while the window fetch time is unchanged
  const late = judge([session(90)], base.state, { observations: rows });
  assert.equal(late.events.length, 0);
  // Judge when a newly fetched value arrives
  const fresh = judge([session(91, 180, 1)], base.state, { now: 2, observations: rows });
  assert.ok(fresh.events.some((e) => e.body.kind === "soon"));
});

test("estimated reset uses the same 30-minute liveness criterion as collection stopped", () => {
  const alerted = { ...judge([session(90)], emptyEventState()).state, stopped: true };
  // 11 minutes since a receive 1 minute before reset (alive): wait for the observation
  const waiting = judge([session(90)], alerted, { now: 190, received: 179 });
  assert.equal(waiting.events.filter((e) => e.body.kind === "reset").length, 0);
  // 31 minutes since a receive 1 minute after reset (stopped): one estimated reset
  const late = judge([session(90)], alerted, { now: 212, received: 181 });
  assert.equal(late.events.filter((e) => e.body.kind === "reset").length, 1);
});

test("blocked without windows gives one limit; not repeated when windows come back while blocked", () => {
  const none = judge([], emptyEventState(), { blocked: true });
  assert.deepEqual(none.events.map((e) => [e.body.kind, e.visible]), [["limit", true]]);
  assert.equal(judge([], none.state, { blocked: true }).events.length, 0, "not created on repetition");
  const back = judge([session(100)], none.state, { blocked: true });
  assert.equal(back.events.filter((e) => e.body.kind === "limit" && e.visible).length, 0, "not repeated when windows come back");
  // After the block ends, notify again when blocked next time
  const cleared = judge([session(40, 480, 200)], back.state, { now: 201, blocked: false });
  const again = judge([], cleared.state, { now: 300, blocked: true });
  assert.equal(again.events.filter((e) => e.body.kind === "limit").length, 1);
});

test("state written by a later judgment isn't advanced by an earlier one (a Cron that read the state late)", () => {
  const stopped = judge([session(10)], emptyEventState(), { now: 35, received: 0 });
  assert.deepEqual(stopped.events.map((e) => e.body.kind), ["collection_stopped"]);
  const late = judge([session(10)], stopped.state, { now: 20, received: 0 });
  assert.equal(late.events.length, 0, "no resume event without new receives");
  assert.equal(late.changed, false);
});

test("windows whose derived values are behind aren't judged this round and their state doesn't advance", () => {
  const now = new Date(at(1));
  const snapshot = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector: "win", windows: [session(85)] } });
  snapshot.collectors = [{ id: "win", generated_at: at(0), received_at: at(1) }];
  const view = toView(snapshot, now);
  const pending = judgeEvents(view, emptyEventState(), { last_received_at: at(1) }, now, { pending: ["claude.five_hour"] });
  assert.equal(pending.events.length, 0);
  assert.equal(pending.state.cycles["claude.five_hour"], undefined);
  assert.equal(judgeEvents(view, pending.state, { last_received_at: at(1) }, now).events.length, 1);
});

test("while blocked, another window newly reaching 100% gets its own limit notification", () => {
  const week = makeWindow("seven_day", 100, at(5000), { fetched_at: at(0) });
  const first = judge([session(70), week], emptyEventState(), { blocked: true });
  assert.deepEqual(first.events.filter((e) => e.visible).map((e) => e.key), [`limit:claude:seven_day:${at(5000)}`]);
  const next = judge([session(100, 180, 5), makeWindow("seven_day", 100, at(5000), { fetched_at: at(5) })], first.state, { now: 6, blocked: true });
  assert.deepEqual(next.events.filter((e) => e.visible).map((e) => e.key), [`limit:claude:five_hour:${at(180)}`]);
});

test("same fetch time but a different value from a newly chosen observation is judged; repeating the same value adds nothing", () => {
  const first = judge([session(50)], emptyEventState());
  assert.equal(first.events.length, 0);
  const switched = judge([session(90)], first.state, { now: 2 });
  assert.ok(switched.events.some((e) => e.body.kind === "threshold"), "90% at the same fetch time is judged");
  assert.equal(judge([session(90)], switched.state, { now: 3 }).events.length, 0);
});

test("with windows whose derived values are behind, blocked isn't notified as windowless; the window limit is notified once they catch up", () => {
  const now = new Date(at(1));
  // Codex: its limit comes from its API, so it stands in on a window
  const snapshot = buildSnapshot({ codex: { ...emptyProvider("ok", null), collector: "win", windows: [session(70)], blocked: true } });
  snapshot.collectors = [{ id: "win", generated_at: at(0), received_at: at(1) }];
  const view = toView(snapshot, now);
  const live = { last_received_at: at(1) };
  const waiting = judgeEvents(view, emptyEventState(), live, now, { pending: ["codex.five_hour"] });
  assert.equal(waiting.events.length, 0, "no windowless limit");
  const ready = judgeEvents(view, waiting.state, live, now);
  assert.deepEqual(ready.events.filter((e) => e.visible).map((e) => e.key), [`limit:codex:five_hour:${at(180)}`]);
  // That cycle was notified, so a reset is notified on the new cycle
  const after = judge([session(3, 480, 200)], ready.state, { now: 201, provider: "codex" });
  assert.ok(after.events.some((e) => e.body.kind === "reset"));
});

test("same fetch time and usage, but a changed reset time from the chosen observation that changes forecast conditions is judged", () => {
  const rows = (reset: number): UsageObservation[] => Array.from({ length: 12 }, (_, i) => ({
    provider: "claude", window_id: "five_hour", collector: "win", resets_at: at(reset),
    used_percent: 30 + i * 5, observed_at: at(-60 + i * 5),
  }));
  // About 10 minutes to the limit. With the reset in 9 minutes, the reset comes first
  const early = judge([session(90, 9)], emptyEventState(), { observations: rows(9) });
  assert.equal(early.events.filter((e) => e.body.kind === "soon").length, 0);
  // Same cycle (4-minute jitter), reset now in 13 minutes: the limit comes first
  const later = judge([session(90, 13)], early.state, { now: 2, observations: rows(13) });
  assert.ok(later.events.some((e) => e.body.kind === "soon" && e.visible), "limit soon is created");
  assert.equal(judge([session(90, 13)], later.state, { now: 3, observations: rows(13) }).events.length, 0, "repeating the same observation adds nothing");
});


test("after an account switch, the new account's threshold is notified exactly once, even in the same or an earlier cycle", () => {
  const judgeAt = (windows: UsageWindow[], state: EventState, now: number, stamp: string) => {
    const snapshot = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector: "win", windows } });
    snapshot.collectors = [{ id: "win", generated_at: at(0), received_at: at(now) }];
    const view = toView(snapshot, new Date(at(now)), { observations: [] });
    return judgeEvents(view, state, { last_received_at: view.last_received_at }, new Date(at(now)), { boundaries: { claude: stamp } });
  };
  // The previous account crossed 80% in the cycle ending at 180
  const old = judgeAt([session(85)], emptyEventState(), 1, "");
  assert.deepEqual(visible(old.events), [`threshold:claude:five_hour:${at(180)}:80`]);
  // Same cycle after the switch: notified again for the new account, under a new key
  const sameCycle = judgeAt([session(82, 180, 10)], old.state, 11, "2026-11-16T12:09:00.000Z#1");
  assert.deepEqual(visible(sameCycle.events), [`threshold:claude#1:five_hour:${at(180)}:80`]);
  assert.equal(sameCycle.events.some((e) => e.body.kind === "reset"), false, "no reset for the previous account's cycle");
  // Once only
  const again = judgeAt([session(83, 180, 15)], sameCycle.state, 16, "2026-11-16T12:09:00.000Z#1");
  assert.deepEqual(visible(again.events), []);
  // A new account whose cycle resets earlier than the old one is judged, not taken for a late old value
  const earlier = judgeAt([session(90, 120, 20)], old.state, 21, "2026-11-16T12:19:00.000Z#1");
  assert.deepEqual(visible(earlier.events), [`threshold:claude#1:five_hour:${at(120)}:80`]);
  // A state written before stamps were kept (by an older version) ...
  const { boundaries: _b, switches: _s, ...legacyState } = old.state;
  assert.equal("boundaries" in legacyState, false);
  // ... keeps its keys when there was no switch since (no repeat after an upgrade)
  const upgraded = judgeAt([session(86, 180, 5)], legacyState, 6, "");
  assert.deepEqual(visible(upgraded.events), []);
  assert.equal(upgraded.state.boundaries?.claude, "");
  assert.deepEqual(visible(judgeAt([session(86, 180, 5)], legacyState, 6, "#0").events), [], "the server's stamp without a switch");
  // ... but after a switch, even one accepted before its last judgment (it may have reached the server late), the new account
  // starts afresh: notified once
  const switched = judgeAt([session(82, 180, 10)], legacyState, 11, `${at(-30)}#1`);
  // A boundary saved before the count existed ("<time>#0") is a switch too
  assert.deepEqual(visible(judgeAt([session(82, 180, 10)], legacyState, 11, `${at(-30)}#0`).events), [`threshold:claude#1:five_hour:${at(180)}:80`]);
  assert.deepEqual(visible(switched.events), [`threshold:claude#1:five_hour:${at(180)}:80`]);
  assert.deepEqual(visible(judgeAt([session(83, 180, 15)], switched.state, 16, `${at(-30)}#1`).events), []);
});

test("a resend whose fetch time moved by seconds is the same fetch only in a state judged by an earlier Worker", () => {
  const first = judge([session(50, 180, 10)], emptyEventState(), { now: 11 });
  assert.equal(first.state.cycles["claude.five_hour"]?.judged_exact, true);
  const moved = makeWindow("five_hour", 50, at(180), { fetched_at: new Date(Date.parse(at(10)) + 2_000).toISOString() });
  // A state of an earlier Worker (fetch times adjusted by the send delay): a second off is the same fetch
  const { judged_exact: _exact, ...older } = first.state.cycles["claude.five_hour"]!;
  const legacy: EventState = { ...first.state, cycles: { "claude.five_hour": older } };
  const resend = judge([moved], legacy, { now: 12 });
  assert.equal(resend.state.cycles["claude.five_hour"]?.judged_at, first.state.cycles["claude.five_hour"]?.judged_at);
  // The same fetch time is the same fetch in a current state too
  const same = judge([session(50, 180, 10)], first.state, { now: 12 });
  assert.equal(same.events.length, 0);
  assert.equal(first.state.cycles["claude.five_hour"]?.judged_by, "win");
  // A new fetch with a new value is judged
  const next = judge([session(85, 180, 15)], first.state, { now: 16 });
  assert.deepEqual(visible(next.events), [`threshold:claude:five_hour:${at(180)}:80`]);
});

test("another PC's fetch at the same time with the same value is judged on its own", () => {
  const snapshotFrom = (collector: string) => {
    const snapshot = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector, windows: [session(50, 180, 10)] } });
    snapshot.collectors = [{ id: collector, generated_at: at(10), received_at: at(11) }];
    return snapshot;
  };
  const now = new Date(at(11));
  const a = judgeEvents(toView(snapshotFrom("a"), now, { observations: [] }), emptyEventState(), { last_received_at: at(11) }, now);
  const b = judgeEvents(toView(snapshotFrom("b"), now, { observations: [] }), a.state, { last_received_at: at(11) }, now);
  assert.equal(b.state.cycles["claude.five_hour"]?.judged_by, "b");
});

test("a state written before fetch times were placed in real time doesn't hold back a newer fetch", () => {
  // The old version saved a fetch from a PC an hour ahead: 70% judged at 13:00 on that clock (12:00 real time)
  const first = judge([session(70, 180, 0)], emptyEventState());
  const cycle = first.state.cycles["claude.five_hour"]!;
  const { judged_by: _, ...legacy } = { ...cycle, judged_at: at(60) };
  const state: EventState = { ...first.state, cycles: { "claude.five_hour": legacy } };
  // After the update, 96% fetched at 12:05 real time
  const next = judge([session(96, 180, 5)], state, { now: 6 });
  assert.deepEqual(visible(next.events), [`threshold:claude:five_hour:${at(180)}:95`]);
  // Also when judged after that PC's old clock time (fetched 12:03, old record 12:04, judged at 12:05)
  const close = { ...state, cycles: { "claude.five_hour": { ...legacy, judged_at: at(4) } } };
  assert.deepEqual(visible(judge([session(96, 180, 3)], close, { now: 5 }).events), [`threshold:claude:five_hour:${at(180)}:95`]);
});

test("a state written before fetch times were placed in real time doesn't judge the same fetch again (even with more history)", () => {
  const rows: UsageObservation[] = Array.from({ length: 12 }, (_, i) => ({
    provider: "claude", window_id: "five_hour", collector: "win", resets_at: at(180),
    used_percent: 30 + i * 5, observed_at: at(-60 + i * 5),
  }));
  const base = judge([session(90)], emptyEventState(), { observations: rows.slice(-1) });
  const { judged_by: _, judged_exact: _exact, ...legacy } = { ...base.state.cycles["claude.five_hour"]!, judged_at: at(60) };
  const state: EventState = { ...base.state, cycles: { "claude.five_hour": legacy } };
  const late = judge([session(90)], state, { observations: rows, now: 5 });
  assert.equal(late.events.filter((e) => e.body.kind === "soon").length, 0);
  // The same fetch takes the state over, so a real new fetch with the same value is judged like a current state
  assert.equal(late.state.cycles["claude.five_hour"]?.judged_by, "win");
  assert.equal(late.state.cycles["claude.five_hour"]?.judged_at, at(0));
  assert.equal(late.state.cycles["claude.five_hour"]?.judged_exact, true);
  // 30 seconds later the same PC fetches 90% again: judged (not taken for the same fetch)
  const again = judge([makeWindow("five_hour", 90, at(180), { fetched_at: new Date(Date.parse(at(0)) + 30_000).toISOString() })], late.state, { observations: rows, now: 6 });
  assert.notEqual(again.state.cycles["claude.five_hour"]?.judged_at, at(0));
});

test("in a current state, a real new fetch within a minute with the same value is judged (its forecast can warn)", () => {
  // 90% judged first with too little history for a forecast
  const first = judge([session(90, 15, 0)], emptyEventState(), { now: 1 });
  const cycle = first.state.cycles["claude.five_hour"]!;
  assert.equal(cycle.judged_exact, true);
  // 30 seconds later the same PC fetches 90% again; the change of judged_at shows it was judged, not skipped
  const again = judge([makeWindow("five_hour", 90, at(15), { fetched_at: new Date(Date.parse(at(0)) + 30_000).toISOString() })], first.state, { now: 2 });
  assert.notEqual(again.state.cycles["claude.five_hour"]?.judged_at, cycle.judged_at);
});

test("an event carries the boundary stamp it was judged under (no account information, only the accepted time and count)", () => {
  const [event] = judge([session(85)], emptyEventState(), { boundaries: { claude: "2026-11-19T10:00:00.000Z#2", codex: "#0" } }).events;
  assert.equal(event!.body.boundary, "2026-11-19T10:00:00.000Z#2");
});

test("an event judged without stamps carries none, even if the state kept one", () => {
  const first = judge([session(85)], emptyEventState(), { boundaries: { claude: "2026-11-19T10:00:00.000Z#2", codex: "#0" } });
  const [event] = judge([session(96)], first.state).events;
  assert.equal(event!.body.boundary, null);
});
