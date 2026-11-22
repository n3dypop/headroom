import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildSnapshot,
  computeMetrics,
  emptyProvider,
  formatDuration,
  makeWindow,
  mergeSnapshots,
  toView,
  type Snapshot,
  type UsageObservation,
} from "../src/index.ts";

const load = async (): Promise<Snapshot> =>
  JSON.parse(await readFile(new URL("../../../fixtures/snapshot/v2-basic.json", import.meta.url), "utf8"));

test("formatDuration: short form in minutes, hours and days", () => {
  assert.equal(formatDuration(13), "13m");
  assert.equal(formatDuration(60), "1h");
  assert.equal(formatDuration(133), "2h 13m");
  assert.equal(formatDuration(3 * 1440 + 4 * 60 + 30), "3d 4h");
  assert.equal(formatDuration(-5), "0m");
});

test("toView: values are reachable by path alone, and display-time values are computed", async () => {
  const merged = mergeSnapshots([await load()]);
  assert.ok(merged);
  const now = new Date("2026-11-16T13:47:00Z");
  const v = toView(merged, now);

  assert.equal(v.collectors, "win-desktop");
  assert.equal(v.claude?.windows.five_hour?.used_percent, 10);
  assert.equal(v.claude?.windows.five_hour?.resets_in_minutes, 133);
  assert.equal(v.claude?.windows.five_hour?.resets_in, "2h 13m");
  assert.equal(v.claude?.windows.five_hour?.resets_at_epoch, 1794844800);
  assert.equal(v.claude?.window_ids, "five_hour,seven_day,seven_day_fable");
  assert.equal(v.claude?.main_window_ids, "five_hour,seven_day");
  assert.equal(v.codex?.main_window_ids, "seven_day");
  assert.equal(v.claude?.age_minutes, 49);
  assert.equal(v.claude?.freshness, "caution");
  assert.equal(v.claude?.freshness_message, "⚠ Value from 49m ago");
  assert.equal(v.claude?.plan, "max");
  assert.equal(v.claude?.error_code, null);
  assert.equal(v.codex?.blocked, false);
  assert.equal(v.claude?.windows.seven_day_fable?.scope, "Fable");
  assert.equal(v.codex?.windows.codex_other_seven_day?.scope, "codex_other");
  assert.equal(v.codex?.windows.codex_other_seven_day?.resets_in, null);
  assert.equal(v.codex?.windows.five_hour, undefined);
  // The window with the least headroom
  assert.equal(v.codex?.top?.key, "codex.seven_day");
  assert.equal(v.claude?.top?.key, "claude.five_hour");
  // Values prepared for display
  // Seen from Tokyo 11/16 22:47, 11/17 1:00 is not "today", so the date is included
  assert.equal(v.claude?.windows.five_hour?.resets_at_local, "11/17 01:00");
  assert.equal(v.time_zone, "Asia/Tokyo");
  assert.equal(v.claude?.stale, true);
  assert.equal(v.claude?.summary, "5h 10% · Weekly 2%");
  assert.equal(v.summary, "Claude 5h 10% · Weekly 2% / Codex Weekly 29%");
});

test("toView: staleness is judged by each window's fetch time (when statusLine refreshes only some)", async () => {
  const merged = mergeSnapshots([await load()]);
  assert.ok(merged);
  const v = toView(merged, new Date("2026-11-16T13:18:40Z"));
  // The provider time is the oldest window (12:58) -> 20 minutes 40 seconds, caution
  assert.equal(v.claude?.freshness, "caution");
  // Only the 5-hour window was refreshed by statusLine at 12:59:30 (19 minutes 10 seconds: fresh)
  assert.equal(v.claude?.windows.five_hour?.freshness, "fresh");
  assert.equal(v.claude?.windows.five_hour?.fetched_at, "2026-11-16T12:59:30.000Z");
  assert.equal(v.claude?.windows.seven_day_fable?.freshness, "caution");
  assert.equal(v.claude?.windows.seven_day_fable?.age_minutes, 20);
});

test("a value its PC marked stale (a rate limit after it) isn't fresh, whatever its time; its windows keep their own time", async () => {
  const s = await load();
  const claude = s.providers.claude!;
  s.providers.claude = { ...claude, status: "stale", error: "Could not fetch", error_code: "fetch_failed" };
  const merged = mergeSnapshots([s]);
  assert.ok(merged);
  // 5 minutes after its fetch: fresh by time, old as the PC marked it
  const v = toView(merged, new Date(Date.parse(claude.fetched_at!) + 5 * 60_000));
  assert.equal(v.claude?.freshness, "caution");
  assert.equal(v.claude?.stale, true);
  assert.equal(v.claude?.freshness_message, "⚠ Value from 5m ago");
  assert.equal(v.claude?.windows.five_hour?.freshness, "fresh");
  // the control: as sent (ok)
  const ok = toView(mergeSnapshots([await load()])!, new Date(Date.parse(claude.fetched_at!) + 5 * 60_000));
  assert.equal(ok.claude?.freshness, "fresh");
});

test("toView: resets_at_local uses the given time zone, time only if today", async () => {
  const merged = mergeSnapshots([await load()]);
  assert.ok(merged);
  const now = new Date("2026-11-16T15:30:00Z"); // Tokyo 11/17 0:30
  const tokyo = toView(merged, now);
  assert.equal(tokyo.claude?.windows.five_hour?.resets_at_local, "01:00");
  assert.equal(tokyo.claude?.windows.seven_day?.resets_at_local, "11/20 16:00");
  const utc = toView(merged, now, { timeZone: "UTC" });
  assert.equal(utc.claude?.windows.five_hour?.resets_at_local, "16:00");
  assert.equal(utc.claude?.windows.seven_day?.resets_at_local, "11/20 07:00");
});

test("toView: a window past its reset time is marked as an estimated 0%", async () => {
  const merged = mergeSnapshots([await load()]);
  assert.ok(merged);
  const v = toView(merged, new Date("2026-11-16T16:30:00Z"));
  const five = v.claude?.windows.five_hour;
  assert.equal(merged.providers.claude?.windows[0]?.used_percent, 10);
  assert.equal(five?.used_percent, 0);
  assert.equal(five?.used_percent_int, 0);
  assert.equal(five?.remaining_percent, 100);
  assert.equal(five?.reset_passed, true);
  assert.equal(five?.resets_in, "Reset");
  assert.equal(v.claude?.freshness, "old");
});

test("toView: top prefers overall windows and ignores a higher per-model window", async () => {
  const snap = await load();
  const claude = snap.providers.claude;
  assert.ok(claude);
  const fable = claude.windows.find((w) => w.id === "seven_day_fable");
  assert.ok(fable);
  fable.used_percent = 100;
  const v = toView(snap, new Date("2026-11-16T13:47:00Z"));
  assert.equal(v.claude?.top?.key, "claude.five_hour", "overall window over a per-model 100%");

  // Only when there is no overall window, pick from per-model / per-group windows
  claude.windows = claude.windows.filter((w) => w.scope !== null);
  const only = toView(snap, new Date("2026-11-16T13:47:00Z"));
  assert.equal(only.claude?.top?.key, "claude.seven_day_fable");
});

test("stored derived values are used within the same cycle; windows whose cycle changed are recomputed without history", () => {
  const base = Date.parse("2026-11-16T12:00:00Z");
  const iso = (m: number) => new Date(base + m * 60_000).toISOString();
  const w = makeWindow("five_hour", 30, iso(180), { fetched_at: iso(0) });
  const history: UsageObservation[] = [-60, -45, -30, -15].map((m, i) => ({
    provider: "claude", window_id: "five_hour", collector: "win", resets_at: iso(180), used_percent: 20 + i * 2, observed_at: iso(m),
  }));
  const snap = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector: "win", windows: [w] } });
  const metrics = computeMetrics(snap, history);
  const now = new Date(iso(1));
  const direct = toView(snap, now, { observations: history }).claude!.windows.five_hour!;
  const cached = toView(snap, now, { metrics }).claude!.windows.five_hour!;
  assert.deepEqual(cached, direct);
  assert.equal(cached.recent_consumed_percent, 10);

  // Same cycle, only the value advanced (before the next Cron): use the stored derived values as is
  const newer = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector: "win",
    windows: [makeWindow("five_hour", 31, iso(180), { fetched_at: iso(5) })] } });
  assert.equal(toView(newer, now, { metrics }).claude!.windows.five_hour!.recent_consumed_percent, 10);
  // The cycle changed: don't use the previous cycle's derived values
  const nextPeriod = buildSnapshot({ claude: { ...emptyProvider("ok", null), collector: "win",
    windows: [makeWindow("five_hour", 1, iso(480), { fetched_at: iso(5) })] } });
  const stale = toView(nextPeriod, now, { metrics }).claude!.windows.five_hour!;
  assert.equal(stale.recent_quality, "unknown");
  assert.equal(stale.confidence, "insufficient");
  // Same for a provider/window with nothing stored
  assert.equal(toView(snap, now, { metrics: {} }).claude!.windows.five_hour!.recent_quality, "unknown");
});

test("stored derived values are used as the same cycle for a new fetch whose reset time shifted by seconds (Codex reset-time jitter)", () => {
  const snapshot = (resets: string, fetched: string): Snapshot => ({
    schema_version: 2, generated_at: fetched,
    providers: { codex: { status: "ok", fetched_at: fetched, collector: "win", error: null, error_code: null, plan: "plus",
      blocked: false, history_since: null,
      windows: [{ id: "seven_day", label: "Weekly", kind: "weekly", scope: null, used_percent: 33, resets_at: resets, fetched_at: fetched }] } },
  });
  const rows: UsageObservation[] = Array.from({ length: 12 }, (_, i) => ({
    provider: "codex", window_id: "seven_day", collector: "win", resets_at: "2026-11-20T10:51:04.000Z",
    used_percent: 20 + i, observed_at: new Date(Date.parse("2026-11-16T12:00:00Z") + i * 5 * 60_000).toISOString(),
  }));
  const metrics = computeMetrics(snapshot("2026-11-20T10:51:04.000Z", "2026-11-16T12:55:00.000Z"), rows);
  const now = new Date("2026-11-16T13:01:00Z");
  const jittered = toView(snapshot("2026-11-20T10:51:05.000Z", "2026-11-16T13:00:00.000Z"), now, { metrics });
  assert.equal(jittered.codex?.windows.seven_day?.recent_quality, metrics.codex?.seven_day?.metrics.recent_quality);
  assert.notEqual(jittered.codex?.windows.seven_day?.rate_60m, null, "derived values are not discarded");
  // A different cycle (reset time differs a lot) doesn't use them
  const other = toView(snapshot("2026-11-27T10:51:04.000Z", "2026-11-16T13:00:00.000Z"), now, { metrics });
  assert.equal(other.codex?.windows.seven_day?.rate_60m, null);
});

