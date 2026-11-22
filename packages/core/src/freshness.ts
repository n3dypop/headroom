// Staleness of the fetch time (for clients). Judged against the current time at display.
// ProviderSnapshot.status is the judgment at collection time, so displays must always use this instead.

/** At or below this: normal display */
export const FRESH_MAX_MINUTES = 20;
/** At or below this: "caution"; above it: "old" */
export const CAUTION_MAX_MINUTES = 75;

export type FreshnessLevel = "fresh" | "caution" | "old" | "unknown";

export interface Freshness {
  level: FreshnessLevel;
  /** Minutes since fetch. null if the time is unknown; 0 if clock skew puts it in the future */
  age_minutes: number | null;
  /** Warning text for display. null when fresh */
  message: string | null;
}

export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function freshnessOf(fetchedAt: string | null | undefined, now: Date = new Date()): Freshness {
  const t = fetchedAt ? Date.parse(fetchedAt) : Number.NaN;
  if (Number.isNaN(t)) return { level: "unknown", age_minutes: null, message: "⚠ Fetch time unknown" };
  // Judged on the time itself; only the minutes shown are rounded down
  const ms = Math.max(0, now.getTime() - t);
  const age = Math.floor(ms / 60_000);
  if (ms <= FRESH_MAX_MINUTES * 60_000) return { level: "fresh", age_minutes: age, message: null };
  if (ms <= CAUTION_MAX_MINUTES * 60_000) {
    return { level: "caution", age_minutes: age, message: `⚠ Value from ${formatAge(age)} ago` };
  }
  return { level: "old", age_minutes: age, message: `⚠ Value from ${formatAge(age)} ago (old)` };
}
