import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveObservedAt, nextSendSeq, observationKey, shouldReplaceCollectorSnapshot } from "../src/index.ts";

const at = (hhmm: string) => `2026-11-17T${hhmm}:00.000Z`;

const ms = (hhmm: string) => Date.parse(at(hhmm));

test("a logout / safety stop arriving after a 12:00 success (window times empty or unchanged) is applied", () => {
  const success = nextSendSeq(null, ms("12:00"));
  const logout = nextSendSeq(success, ms("12:05"));
  assert.equal(shouldReplaceCollectorSnapshot(success, logout), true);
  const safetyStop = nextSendSeq(logout, ms("12:10"));
  assert.equal(shouldReplaceCollectorSnapshot(logout, safetyStop), true);
});

test("a resend of the same send or a late older send doesn't roll back", () => {
  const older = nextSendSeq(null, ms("12:00"));
  const newer = nextSendSeq(older, ms("12:05"));
  assert.equal(shouldReplaceCollectorSnapshot(newer, newer), false);
  assert.equal(shouldReplaceCollectorSnapshot(newer, older), false);
  assert.equal(shouldReplaceCollectorSnapshot(null, older), true);
  assert.equal(shouldReplaceCollectorSnapshot(null, 0), false);
  assert.equal(shouldReplaceCollectorSnapshot(null, 1.5), false);
});

test("new state after turning the clock back is applied; a resend from before doesn't roll back", () => {
  // With the clock ahead, a success is sent at 12:50 (really 12:01); after correction, a logout is sent at 12:06
  const aheadSuccess = nextSendSeq(null, ms("12:50"));
  const logoutAfterFix = nextSendSeq(aheadSuccess, ms("12:06"));
  assert.ok(logoutAfterFix > aheadSuccess, "the number increases even after the clock goes back");
  assert.equal(shouldReplaceCollectorSnapshot(aheadSuccess, logoutAfterFix), true);
  // A late resend of the pre-correction success doesn't overwrite the logout
  assert.equal(shouldReplaceCollectorSnapshot(logoutAfterFix, aheadSuccess), false);
  // A PC whose state was wiped and reinstalled starts from the current time and exceeds old numbers (numbers sent with a fast clock are exceeded once that time passes)
  assert.ok(nextSendSeq(null, ms("13:00")) > logoutAfterFix);
  assert.equal(nextSendSeq(null, ms("12:30")) > logoutAfterFix, false);
});

test("resending a future-dated observation keeps a single row and the calculation time doesn't change", () => {
  // Storage mimicking D1's INSERT OR IGNORE (the first receive time is fixed here and not overwritten by resends)
  const table = new Map<string, { observed_at: string; first_received_at: string }>();
  const receive = (observedAt: string, receivedAt: string) => {
    const key = observationKey("claude", "five_hour", "mac", observedAt);
    assert.ok(key);
    if (!table.has(key)) table.set(key, { observed_at: observedAt, first_received_at: receivedAt });
  };
  receive(at("12:05"), at("12:00")); // Observation from a PC with a fast clock, received at 12:00
  receive(at("12:05"), at("12:01")); // Resend of the same observation
  receive("2026-11-17T12:05:00Z", at("12:02")); // Notation variant
  assert.equal(table.size, 1);
  const row = [...table.values()][0];
  assert.ok(row);
  assert.equal(effectiveObservedAt(row.observed_at, row.first_received_at), at("12:00"));
  assert.equal(effectiveObservedAt(at("11:59"), at("12:00")), at("11:59"), "past observations are kept as is");
  assert.equal(observationKey("claude", "five_hour", "mac", "bad"), null);
});
