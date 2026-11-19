// Checks the server (Worker) applies when receiving a send from a PC. Pure functions with no D1 dependency.

import type { Snapshot } from "./schema.ts";

/**
 * Send sequence number (`seq`). The PC computes `max(previous seq + 1, current time in ms)` for each send and saves it locally.
 * It always exceeds the previous one even if the clock is turned back, and if the state is wiped it restarts from the
 * current time, so it usually exceeds the stored number. Same rule as the agent's (Rust) `next_send_seq()`.
 */
export function nextSendSeq(lastSeq: number | null, nowMs: number): number {
  return Math.max((lastSeq ?? 0) + 1, Math.trunc(nowMs));
}

/**
 * Whether to replace the per-PC latest snapshot (`collector_snapshots`) with the incoming one.
 *
 * Decided by the send sequence number `seq`, not by time.
 * - A logout (`fetched_at: null`) or a safety stop that keeps the previous value is applied if it is a newer send (window times are not compared).
 * - After the PC clock is turned back, new sends still have larger numbers and are applied. A delayed send from before the change doesn't roll back.
 * - A resend of the same send (same number) or an older send doesn't replace. A number that isn't a positive integer doesn't replace.
 * The observation history (`observations`) is appended by unique key regardless of this check.
 */
export function shouldReplaceCollectorSnapshot(storedSeq: number | null, incomingSeq: number): boolean {
  if (!Number.isSafeInteger(incomingSeq) || incomingSeq <= 0) return false;
  return storedSeq === null || incomingSeq > storedSeq;
}

/**
 * Unique key for history. Uses the `observed_at` recorded by the PC **as sent** (not clamped to the receive time).
 * Resending the same observation any number of times keeps the same key. Notation differences are normalized to UTC ISO 8601. null (not stored) if unreadable.
 */
export function observationKey(
  provider: string,
  windowId: string,
  collector: string,
  observedAt: string,
): string | null {
  const at = Date.parse(observedAt);
  if (!Number.isFinite(at)) return null;
  return [provider, windowId, collector, new Date(at).toISOString()].join("|");
}

/**
 * Observation time used for calculations. Clamped to the **first receive time** so it never lies in the future even if the PC clock runs a little ahead.
 * The first receive time is fixed when stored (not overwritten by resends), so resending doesn't change the calculation time.
 */
export function effectiveObservedAt(observedAt: string, firstReceivedAt: string): string | null {
  const at = Date.parse(observedAt);
  const received = Date.parse(firstReceivedAt);
  if (!Number.isFinite(at) || !Number.isFinite(received)) return null;
  return new Date(Math.min(at, received)).toISOString();
}

/**
 * How far a PC's clock may be from the endpoint's: an upload whose send time (`generated_at`) differs from its receive time by more is
 * refused, and the PC shows that its clock is off. Times from PCs are then used as they are
 */
export const CLOCK_TOLERANCE_MS = 2 * 60_000;

/**
 * After an account switch, a PC's values stamped within this span after the boundary may still be from before it: the accepting PC's
 * clock may run behind and another PC's ahead, each by up to the tolerance plus the time a request takes (2 x (2 min + 20 s) = 4 min
 * 40 s), so they are left out of history and of the latest values
 */
export const BOUNDARY_GUARD_MS = 5 * 60_000;
