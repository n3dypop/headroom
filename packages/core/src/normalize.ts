import {
  KNOWN_WINDOWS,
  SCHEMA_VERSION,
  type ProviderId,
  type ProviderSnapshot,
  type Snapshot,
  type UsageWindow,
  type WindowKind,
} from "./schema.ts";

/** Epoch seconds / epoch milliseconds / date string to ISO8601 UTC. null if it can't be parsed. */
export function toIsoUtc(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Below 1e12 is treated as seconds (as milliseconds it would be before 2001, so no practical collision)
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value.trim() !== "") {
    if (/^\d+(\.\d+)?$/.test(value.trim())) return toIsoUtc(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Determine the kind from the window length (seconds) */
export function kindFromSeconds(seconds: number | null): WindowKind {
  if (seconds === 5 * 60 * 60) return "session";
  if (seconds === 7 * 24 * 60 * 60) return "weekly";
  if (seconds !== null && seconds >= 28 * 86400 && seconds <= 31 * 86400) return "monthly";
  return "other";
}

export interface WindowOptions {
  label?: string;
  kind?: WindowKind;
  window_seconds?: number | null;
  scope?: string | null;
  fetched_at?: string | null;
}

/** Build a UsageWindow, filling in label and kind for known ids. */
export function makeWindow(
  id: string,
  usedPercent: number,
  resetsAt: unknown,
  opts: WindowOptions = {},
): UsageWindow {
  const known = KNOWN_WINDOWS[id];
  const windowSeconds = opts.window_seconds ?? known?.window_seconds ?? null;
  const used = clampPercent(usedPercent);
  return {
    id,
    label: opts.label ?? known?.label ?? id,
    kind: opts.kind ?? known?.kind ?? kindFromSeconds(windowSeconds),
    scope: opts.scope ?? null,
    used_percent: used,
    resets_at: toIsoUtc(resetsAt),
    fetched_at: opts.fetched_at ?? null,
  };
}

/** Treat as 0 once resets_at has passed (a client-side estimate; displays must make clear it is estimated). */
export function effectiveUsedPercent(window: UsageWindow, now: Date = new Date()): number {
  if (window.resets_at && Date.parse(window.resets_at) <= now.getTime()) return 0;
  return window.used_percent;
}

export function emptyProvider(
  status: ProviderSnapshot["status"],
  error: string | null,
  errorCode: ProviderSnapshot["error_code"] = null,
): ProviderSnapshot {
  return {
    status,
    fetched_at: null,
    collector: null,
    error,
    error_code: errorCode,
    plan: null,
    blocked: null,
    history_since: null,
    windows: [],
  };
}

export function buildSnapshot(
  providers: Partial<Record<ProviderId, ProviderSnapshot>>,
  now: Date = new Date(),
): Snapshot {
  return { schema_version: SCHEMA_VERSION, generated_at: now.toISOString(), providers };
}
