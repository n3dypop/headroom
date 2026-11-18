import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnapshot, emptyProvider, hourlySeries, makeWindow, toView, windowMetrics, type UsageObservation } from "../src/index.ts";

const base = Date.parse("2026-11-16T12:00:00Z");
const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
const window = (used: number, reset = 180) => makeWindow("five_hour", used, at(reset), { fetched_at: at(0) });
const observation = (offset: number, percent: number, reset = 180): UsageObservation => ({
  provider: "claude", window_id: "five_hour", collector: "win", resets_at: at(reset),
  used_percent: percent, observed_at: at(offset),
});

test("a Mac observation from 60 minutes ago and the current Windows value give an exact result", () => {
  const snapshot = buildSnapshot({
    claude: { ...emptyProvider("ok", null), collector: "win", windows: [window(26)] },
  });
  const actual = toView(snapshot, new Date(at(0)), { observations: [{ ...observation(-60, 20), collector: "mac" }] });
  const metrics = actual.claude?.windows.five_hour;
  assert.equal(metrics?.recent_consumed_percent, 6);
  assert.equal(metrics?.recent_quality, "exact");
  assert.equal(metrics?.eta_minutes, null);
});

test("observations from two PCs 1 minute apart: only the one chosen by priority and recency is used", () => {
  const higherPriority = { ...observation(-11, 54), collector: "mac" };
  const newer = observation(-10, 56);
  const next = observation(-5, 59);
  const both = [higherPriority, newer, next];
  const selection = { collectorPriority: ["mac", "win"] };
  assert.deepEqual(windowMetrics(window(60), both, undefined, selection),
    windowMetrics(window(60), [higherPriority, next]));
  assert.deepEqual(windowMetrics(window(60), both), windowMetrics(window(60), [newer, next]));
  assert.notEqual(windowMetrics(window(60), both, undefined, { simultaneousMinutes: 0 }).rate_15m,
    windowMetrics(window(60), both).rate_15m);
});

test("continuous history yields recent consumption and a limit forecast based on the last observation", () => {
  const rows = Array.from({ length: 12 }, (_, i) => observation((i - 12) * 5, 10 + i * 5));
  const metrics = windowMetrics(window(70), rows.reverse());
  assert.equal(metrics.recent_consumed_percent, 60);
  assert.equal(metrics.recent_quality, "exact");
  assert.deepEqual([metrics.rate_15m, metrics.rate_60m, metrics.rate_24h], [60, 60, 60]);
  assert.equal(metrics.eta_minutes, 30);
  assert.equal(metrics.eta_at, at(30));
  assert.equal(metrics.reset_first, false);
  assert.equal(metrics.confidence, "high");
  assert.equal(metrics.anomalous, false);
  assert.equal(metrics.unobserved_minutes, null);
});

test("observation gaps are excluded from the rate; returns a lower bound for recent usage and consumption during the gap", () => {
  const rows = [observation(-110, 35), observation(-100, 40), observation(-5, 60)];
  const resumed = windowMetrics(window(65), rows);
  assert.deepEqual([resumed.recent_consumed_percent, resumed.recent_quality], [5, "approx"]);
  assert.equal(resumed.unobserved_minutes, 95);
  assert.equal(resumed.unobserved_consumed_percent, 20);
  assert.equal(resumed.rate_60m, 60);
  assert.equal(resumed.eta_minutes, 35);
  assert.equal(resumed.confidence, "low");

  const first = windowMetrics(window(60), rows.slice(0, 2));
  assert.equal(first.recent_consumed_percent, null);
  assert.equal(first.recent_quality, "unknown");
  assert.equal(first.rate_60m, null);
  assert.equal(first.eta_minutes, null);
  assert.equal(first.confidence, "insufficient");
});

test("recent consumption across a reset counts only the current cycle; a 5-minute time difference is the same cycle", () => {
  const rows = [observation(-30, 90, -20), observation(-15, 3, 184), observation(-5, 8)];
  const metrics = windowMetrics(window(10), rows);
  assert.deepEqual([metrics.recent_consumed_percent, metrics.recent_quality], [10, "exact"]);
  assert.equal(metrics.rate_15m, 28);
  assert.equal(metrics.unobserved_minutes, null);
});

test("decreasing, duplicate and future resent observations don't change the rate", () => {
  const rows = [observation(-15, 42), observation(-10, 40), observation(-5, 45)];
  const result = windowMetrics(window(50), rows);
  const duplicate = windowMetrics(window(50), [...rows, ...rows, observation(0, 0), observation(5, 100)]);
  assert.deepEqual(duplicate, result);
  assert.equal(result.rate_15m, 60);
  // The decreasing interval (-15 -> -10 min) isn't in the rate, so confidence is decided by the remaining 3 points / 10 minutes
  assert.equal(result.confidence, "low");
});

test("confidence is decided only by the observations behind the forecast rate, not by decreasing intervals excluded from it", () => {
  const rows = [observation(-20, 96), observation(-5, 95.5)];
  const result = windowMetrics(window(96.5), rows);
  assert.equal(result.rate_60m, 12);
  assert.equal(result.eta_minutes, 17.5);
  assert.equal(result.confidence, "low");
});

test("an integer 1% step doesn't linger in long-period rates and forecasts (weekly window: +1% in 5 minutes, then no change for 60 minutes)", () => {
  const weekly = (offset: number, percent: number): UsageObservation => ({
    provider: "codex", window_id: "seven_day", collector: "win", resets_at: at(62 * 60),
    used_percent: percent, observed_at: at(offset),
  });
  const rows = [weekly(-65, 32), ...Array.from({ length: 12 }, (_, i) => weekly(-60 + i * 5, 33))];
  const metrics = windowMetrics(makeWindow("seven_day", 33, at(62 * 60), { fetched_at: at(0) }), rows);
  assert.deepEqual([metrics.rate_15m, metrics.rate_60m], [0, 0]);
  assert.equal(metrics.rate_24h, 0.92, "1% / 65 minutes");
  assert.equal(metrics.reset_first, true, "forecast reaches the limit in about 73 hours; the reset (in 62 hours) comes first");
  assert.ok(metrics.eta_minutes !== null && metrics.eta_minutes > 62 * 60);
  // Right after the step (5 minutes observed) it looks like 12%/hour, but confidence is low
  const early = windowMetrics(makeWindow("seven_day", 33, at(62 * 60), { fetched_at: at(0) }), [weekly(-5, 32)]);
  assert.equal(early.rate_24h, 12);
  assert.equal(early.confidence, "low");
});

test("with an unknown reset time, the history cycle isn't guessed", () => {
  const metrics = windowMetrics({ ...window(50), resets_at: null }, [observation(-5, 45)]);
  assert.equal(metrics.recent_quality, "unknown");
  assert.equal(metrics.rate_15m, null);
  assert.equal(metrics.reset_first, null);
  assert.equal(metrics.anomalous, null);
});

test("judges whether the reset comes first and returns the fast-side forecast for sudden consumption", () => {
  const rows = Array.from({ length: 12 }, (_, i) => observation(-60 + i * 5, i < 10 ? 10 : 10 + (i - 9) * 5, 25));
  const result = windowMetrics(window(25, 25), rows);
  assert.ok(result.eta_fast_minutes !== null && result.eta_minutes !== null);
  assert.ok(result.eta_fast_minutes < result.eta_minutes);
  assert.equal(result.reset_first, true);
  assert.equal(result.anomalous, true);
  assert.equal(result.confidence, "medium");
});

test("toView picks the earliest limit forecast from overall windows only and drops the old cycle's forecast after a reset", () => {
  const model = { ...window(100), id: "five_hour_fable", scope: "Fable" };
  const snapshot = buildSnapshot({
    claude: { ...emptyProvider("ok", null), windows: [window(95), model] },
    codex: { ...emptyProvider("ok", null), windows: [window(50)] },
  });
  const rows = [observation(-35, 60), observation(-15, 80), observation(-10, 85), observation(-5, 90)];
  const current = toView(snapshot, new Date(at(1)), { observations: rows, recentMinutes: { session: 30 } });
  assert.equal(current.claude?.limiting_key, "claude.five_hour");
  assert.equal(current.claude?.eta_at, at(5));
  assert.equal(current.claude?.eta_at_local, "21:05");
  assert.equal(current.claude?.observed_until, at(0));
  assert.equal(current.claude?.windows.five_hour?.recent_consumed_percent, 35);
  assert.equal(current.claude?.windows.five_hour?.recent_minutes, 30);
  assert.equal(current.codex?.windows.five_hour?.rate_15m, null);

  const reset = toView(snapshot, new Date(at(181)), { observations: rows });
  assert.equal(reset.claude?.limiting_key, null);
  assert.equal(reset.claude?.windows.five_hour?.used_percent, 0);
  assert.equal(reset.claude?.windows.five_hour?.recent_consumed_percent, null);
  assert.equal(reset.claude?.windows.five_hour?.value_status, "reset_estimated");
  assert.match(reset.claude?.status_text ?? "", /Reset \(estimated\)/);
});

test("window and provider combine staleness, approximation and forecast reliability", () => {
  const snapshot = buildSnapshot({ claude: { ...emptyProvider("ok", null), windows: [window(65)] } });
  const rows = [observation(-100, 40), observation(-5, 60)];
  const view = toView(snapshot, new Date(at(23)), { observations: rows });
  const provider = view.claude;
  assert.equal(provider?.windows.five_hour?.value_status, "stale");
  assert.equal(provider?.status_text, "⚠ 23m ago · Recent usage: approximate · Forecast: low confidence");
  assert.equal(provider?.windows.five_hour?.status_text, provider?.status_text);
});

test("start of a 5-hour window: the 0% before it starts (no reset time) anchors the cycle start, giving exact recent consumption", () => {
  const idle = (offset: number): UsageObservation => ({ ...observation(offset, 0), resets_at: null });
  // -70 to -35 min: the window hasn't started. Usage starts at -32 min; the first observation is 2% at -30 min
  const history = [idle(-70), idle(-65), idle(-60), idle(-55), idle(-50), idle(-45), idle(-40), idle(-35),
    observation(-30, 2), observation(-25, 3), observation(-20, 5), observation(-15, 6), observation(-10, 7), observation(-5, 8)];
  const metrics = windowMetrics(window(9), history);
  assert.equal(metrics.recent_consumed_percent, 9, "the initial 2% is counted too");
  assert.equal(metrics.recent_quality, "exact");
  // A 0% before the previous cycle's reset and a 0% after the current cycle's observations (a mix-up) aren't used
  const stray = windowMetrics(window(9), [observation(-200, 40, -100), idle(-120), ...history.slice(8), idle(-3)]);
  assert.equal(stray.recent_consumed_percent, 7);
  assert.equal(stray.recent_quality, "approx");
});

test("a window that hasn't started (0%, no reset time) has an exact recent consumption of 0", () => {
  const metrics = windowMetrics(makeWindow("five_hour", 0, null, { fetched_at: at(0) }), [observation(-30, 50, -10)]);
  assert.equal(metrics.recent_consumed_percent, 0);
  assert.equal(metrics.recent_quality, "exact");
  assert.equal(metrics.eta_minutes, null);
});

test("rate_pace is the rate used for the forecast (the first exceeding the minimum before rounding); not re-picked from the rounded rate_60m", () => {
  // The 60-minute rate is just below the minimum (0.01%/min = 0.6%/hour; 0.6 when rounded). The 15-minute rate is about 2%/hour
  const rows = [[-60, 98.4], [-50, 98.45], [-40, 98.5], [-30, 98.55], [-20, 98.6], [-10, 98.65], [-5, 98.83], [0, 99]]
    .map(([m, p]) => observation(m!, p!, 60));
  const metrics = windowMetrics(window(99, 60), rows.reverse());
  assert.equal(metrics.rate_60m, 0.6, "the rounded value looks exactly at the minimum");
  assert.ok(Math.abs(metrics.rate_pace! - metrics.rate_15m!) < 0.01, "below the minimum before rounding, so the forecast uses the 15-minute rate");
  assert.notEqual(metrics.rate_pace, Math.round(metrics.rate_pace! * 100) / 100, "not rounded");
  assert.equal(metrics.reset_first, false, "at that rate the limit is used up before the reset (in 60 minutes)");
});

test("the limit time is computed from the published rate_pace (no 1 ms drift from conversion)", () => {
  // Reviewer-supplied input: the old formula (dividing by the %/minute rate) runs out at 13:02:03.772; the current one hits the limit exactly at the reset (lasts)
  const latest = Date.parse("2026-11-16T12:00:00.000Z");
  const reset = "2026-11-16T13:02:03.773Z";
  const ob = (offsetMs: number, used: number): UsageObservation => ({
    provider: "claude", window_id: "five_hour", collector: "win", resets_at: reset, used_percent: used,
    observed_at: new Date(latest + offsetMs).toISOString(),
  });
  const rows = [ob(-1_200_255, 86.79), ob(-600_127, 88.40), ob(0, 90.01)];
  const metrics = windowMetrics(makeWindow("five_hour", 90.01, reset, { fetched_at: new Date(latest).toISOString() }), rows.reverse());
  assert.ok(metrics.rate_pace !== null && metrics.eta_at !== null, "a forecast is available");
  assert.equal(metrics.eta_at, reset, "limit and reset coincide");
  assert.equal(metrics.reset_first, true, "coinciding counts as lasting");
  // The media's calculation (convert the published rate_pace back to %/minute, divide, round to integer ms) gives the same time
  const widget = latest + Math.round(((100 - 90.01) / (metrics.rate_pace! / 60)) * 60000);
  assert.equal(new Date(widget).toISOString(), reset);
});


test("builds the weekly series from the hourly aggregate (split at gaps over 90 minutes and at cycle changes)", () => {
  const row = (iso: string, used: number, reset = "2026-11-20T07:00:00.000Z") => ({ observed_at: iso, used_percent: used, resets_at: reset });
  const series = hourlySeries([
    row("2026-11-16T10:55:00.000Z", 10),
    row("2026-11-16T11:55:00.000Z", 12),
    row("2026-11-16T14:55:00.000Z", 15),
    row("2026-11-16T15:55:00.000Z", 1, "2026-11-23T07:00:00.000Z"),
    row("2026-11-09T10:00:00.000Z", 50),
  ], new Date("2026-11-10T00:00:00.000Z"));
  assert.deepEqual(series.map((p) => [p.used_percent, p.break]), [[10, null], [12, null], [15, "gap"], [1, "reset"]], "points before since are dropped");
});
