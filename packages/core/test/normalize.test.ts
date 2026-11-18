import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampPercent,
  effectiveUsedPercent,
  emptyProvider,
  makeWindow,
  toIsoUtc,
} from "../src/index.ts";

test("toIsoUtc: accepts epoch seconds, milliseconds, ISO strings and numeric strings", () => {
  assert.equal(toIsoUtc(1763305200), "2025-11-16T15:00:00.000Z");
  assert.equal(toIsoUtc(1763305200000), "2025-11-16T15:00:00.000Z");
  assert.equal(toIsoUtc("2026-11-16T15:00:00.000000+00:00"), "2026-11-16T15:00:00.000Z");
  assert.equal(toIsoUtc("1763305200"), "2025-11-16T15:00:00.000Z");
  assert.equal(toIsoUtc(null), null);
  assert.equal(toIsoUtc("not a date"), null);
});

test("clampPercent: clamps to 0-100", () => {
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(42.5), 42.5);
});

test("makeWindow: fills in display name and kind for known ids", () => {
  assert.deepEqual(makeWindow("five_hour", 10, null), {
    id: "five_hour",
    label: "5h",
    kind: "session",
    scope: null,
    used_percent: 10,
    resets_at: null,
    fetched_at: null,
  });
  const unknown = makeWindow("window_90m", 5, null, { window_seconds: 5400 });
  assert.equal(unknown.label, "window_90m");
  assert.equal(unknown.kind, "other");
  const month = makeWindow("monthly", 5, null, { window_seconds: 30 * 86400 });
  assert.equal(month.kind, "monthly");
});

test("emptyProvider: has all common fields, with null for values that don't apply", () => {
  const p = emptyProvider("unavailable", "x", "login_required");
  assert.deepEqual(Object.keys(p).sort(), [
    "blocked", "collector", "error", "error_code", "fetched_at", "history_since", "plan", "status", "windows",
  ]);
  assert.equal(p.plan, null);
  assert.equal(p.blocked, null);
  assert.equal(p.error_code, "login_required");
});

test("effectiveUsedPercent: 0 once the reset time has passed", () => {
  const w = makeWindow("five_hour", 80, "2026-11-16T15:00:00Z");
  assert.equal(effectiveUsedPercent(w, new Date("2026-11-16T14:59:59Z")), 80);
  assert.equal(effectiveUsedPercent(w, new Date("2026-11-16T15:00:00Z")), 0);
});
