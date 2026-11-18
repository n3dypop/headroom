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
}

function judge(windows: UsageWindow[], state: EventState, o: Options = {}) {
  const now = new Date(at(o.now ?? 1));
  const snapshot = buildSnapshot({
    claude: { ...emptyProvider("ok", null), collector: "win", windows, blocked: o.blocked ?? null, error_code: o.error ?? null },
  });
  const received = o.received === undefined ? (o.now ?? 1) : o.received;
  snapshot.collectors = [{ id: "win", generated_at: at(0), received_at: received === null ? null : at(received) }];
  const view = toView(snapshot, now, { observations: o.observations ?? [] });
  return judgeEvents(view, state, { last_received_at: view.last_received_at }, now);
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

  // The PC confirmed blocked but no window is at 100%: limit on the most-used overall window
  const blocked = judge([session(70)], emptyEventState(), { blocked: true });
  const limit = blocked.events.find((e) => e.body.kind === "limit");
  assert.equal(limit?.key, `limit:claude:five_hour:${at(180)}`);
  assert.equal(limit?.body.blocked, true);
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
    "blocked", "confidence", "confirmed", "cycle", "error_code", "eta_minutes", "kind", "label", "last_received_at",
    "provider", "resets_at", "scope", "status_text", "threshold", "used_percent", "window_id",
  ]);
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
  const snapshot = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector: "win", windows: [session(70)], blocked: true } });
  snapshot.collectors = [{ id: "win", generated_at: at(0), received_at: at(1) }];
  const view = toView(snapshot, now);
  const live = { last_received_at: at(1) };
  const waiting = judgeEvents(view, emptyEventState(), live, now, { pending: ["claude.five_hour"] });
  assert.equal(waiting.events.length, 0, "no windowless limit");
  const ready = judgeEvents(view, waiting.state, live, now);
  assert.deepEqual(ready.events.filter((e) => e.visible).map((e) => e.key), [`limit:claude:five_hour:${at(180)}`]);
  // That cycle was notified, so a reset is notified on the new cycle
  const after = judge([session(3, 480, 200)], ready.state, { now: 201 });
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

