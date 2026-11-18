import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyProvider,
  freshnessOf,
  makeWindow,
  mergeSnapshots,
  type ProviderSnapshot,
  type Snapshot,
} from "../src/index.ts";

const NOW = new Date("2026-11-16T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

test("freshnessOf: within 15 minutes normal, within 60 caution, beyond that old", () => {
  assert.deepEqual(freshnessOf(minutesAgo(15), NOW), { level: "fresh", age_minutes: 15, message: null });
  assert.deepEqual(freshnessOf(minutesAgo(16), NOW), {
    level: "caution",
    age_minutes: 16,
    message: "⚠ Value from 16m ago",
  });
  assert.equal(freshnessOf(minutesAgo(61), NOW).level, "old");
  assert.equal(freshnessOf(minutesAgo(3 * 60), NOW).message, "⚠ Value from 3h ago (old)");
  assert.equal(freshnessOf(minutesAgo(3 * 24 * 60), NOW).message, "⚠ Value from 3d ago (old)");
  assert.equal(freshnessOf(null, NOW).level, "unknown");
});

test("freshnessOf: a future time from a collector with a fast clock counts as 0 minutes", () => {
  assert.deepEqual(freshnessOf(minutesAgo(-3), NOW), { level: "fresh", age_minutes: 0, message: null });
});

function provider(over: Partial<ProviderSnapshot>): ProviderSnapshot {
  return { ...emptyProvider("ok", null), ...over };
}

function snap(collector: string, generatedMin: number, providers: Snapshot["providers"]): Snapshot {
  return { schema_version: 2, generated_at: minutesAgo(generatedMin), collector, providers };
}

test("mergeSnapshots: per provider, takes the collector with the newest successful fetch and adds the collector list", () => {
  const w = (p: number) => [makeWindow("five_hour", p, null)];
  const mac = snap("mac", 1, {
    claude: provider({ fetched_at: minutesAgo(2), windows: w(30) }),
    codex: provider({ status: "error", error: "Not signed in" }),
  });
  const win = snap("win", 5, {
    claude: provider({ fetched_at: minutesAgo(20), windows: w(10), status: "stale" }),
    codex: provider({ fetched_at: minutesAgo(5), windows: w(70) }),
  });

  const merged = mergeSnapshots([win, mac]);
  assert.ok(merged);
  assert.equal(merged.generated_at, minutesAgo(1));
  assert.equal(merged.collector, undefined);
  assert.deepEqual(merged.collectors, [
    { id: "mac", generated_at: minutesAgo(1), received_at: null },
    { id: "win", generated_at: minutesAgo(5), received_at: null },
  ]);
  assert.equal(merged.providers.claude?.collector, "mac");
  assert.equal(merged.providers.claude?.windows[0]?.used_percent, 30);
  // Even though Codex isn't signed in on the Mac, the Windows value is used
  assert.equal(merged.providers.codex?.collector, "win");
  assert.equal(merged.providers.codex?.windows[0]?.used_percent, 70);
});

test("mergeSnapshots: takes a newer observation that only has availability", () => {
  const old = snap("win", 5, { codex: provider({
    fetched_at: minutesAgo(5), windows: [makeWindow("seven_day", 25, null)], blocked: false,
  }) });
  const latest = snap("mac", 1, { codex: provider({ fetched_at: minutesAgo(1), blocked: true }) });
  const chosen = mergeSnapshots([old, latest])?.providers.codex;
  assert.equal(chosen?.blocked, true);
  assert.equal(chosen?.collector, "mac");
  assert.deepEqual(chosen?.windows, []);
});

test("mergeSnapshots: with no values anywhere, error wins over unavailable", () => {
  const merged = mergeSnapshots([
    snap("a", 1, { claude: provider({ status: "unavailable" }) }),
    snap("b", 1, { claude: provider({ status: "error", error: "HTTP 500" }) }),
  ]);
  assert.equal(merged?.providers.claude?.status, "error");
  assert.equal(merged?.providers.claude?.collector, "b");
});

test("mergeSnapshots: within 2 minutes of fetch time, collector priority decides", () => {
  const mac = snap("mac", 0, { claude: provider({ fetched_at: minutesAgo(0), blocked: false }) });
  const win = snap("win", 1, { claude: provider({ fetched_at: minutesAgo(1), blocked: true }) });
  assert.equal(mergeSnapshots([win, mac])?.providers.claude?.collector, "mac");
  const options = { collectorPriority: ["win", "mac"] };
  assert.equal(mergeSnapshots([mac, win], options)?.providers.claude?.blocked, true);
  assert.equal(mergeSnapshots([win, mac], { ...options, simultaneousMinutes: 0 })?.providers.claude?.collector, "mac");
});

test("mergeSnapshots: after an observed reset, the new cycle wins over a higher-priority previous-cycle value", () => {
  const old = snap("win", 1, { claude: provider({
    fetched_at: minutesAgo(1), windows: [makeWindow("five_hour", 100, minutesAgo(0.5))],
  }) });
  const current = snap("mac", 0, { claude: provider({
    fetched_at: minutesAgo(0), windows: [makeWindow("five_hour", 0, minutesAgo(-300))],
  }) });
  assert.equal(mergeSnapshots([old, current], { collectorPriority: ["win"] })?.providers.claude?.collector, "mac");
});

test("mergeSnapshots: unknown schema_version is ignored; null if all are invalid", () => {
  const old = { ...snap("x", 0, {}), schema_version: 1 } as unknown as Snapshot;
  assert.equal(mergeSnapshots([old]), null);
  assert.equal(mergeSnapshots([]), null);
});
