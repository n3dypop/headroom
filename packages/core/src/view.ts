// The "view" for displays: turns a snapshot into an object with fixed keys and no arrays, and adds values that depend
// on display time (elapsed time, time until reset, staleness, estimated value after reset).
//
// Goal: both scripts like Scriptable and no-code widget apps that pick values by path can get what they need
// by path alone, e.g. `claude.windows.five_hour.used_percent`.
// Every provider has the same keys; values that don't apply are null (so paths don't break).

import { formatAge, freshnessOf } from "./freshness.ts";
import { windowMetrics, type WindowMetrics } from "./history.ts";
import { RESET_TOLERANCE_MS, type CollectorSelection } from "./collector-selection.ts";
import { effectiveUsedPercent } from "./normalize.ts";
import {
  PROVIDERS,
  PROVIDER_NAMES,
  SCHEMA_VERSION,
  isDetailOnly,
  type ProviderId,
  type ProviderSnapshot,
  type Snapshot,
  type UsageObservation,
  type UsageWindow,
  type WindowKind,
} from "./schema.ts";

export const VIEW_VERSION = 1;
export type ValueStatus = "fresh" | "stale" | "old" | "reset_estimated";

export interface WindowView extends WindowMetrics {
  id: string;
  key: string;
  label: string;
  kind: UsageWindow["kind"];
  scope: string | null;
  /** Shown in details only (told from the provider and the window id): never the top window, in a summary or in events */
  detail_only: boolean;
  /** 0 (estimated) once the reset time has passed. Use this for display */
  used_percent: number;
  remaining_percent: number;
  /** used_percent rounded to an integer (for display) */
  used_percent_int: number;
  /** The reset time has passed and the value is an estimate */
  reset_passed: boolean;
  resets_at: string | null;
  /** resets_at in epoch seconds (for apps that can't handle ISO) */
  resets_at_epoch: number | null;
  /** Display time in the given time zone: "15:00" if today, otherwise "11/20 16:00" */
  resets_at_local: string | null;
  /** Minutes until reset (0 if passed) */
  resets_in_minutes: number | null;
  /** Display string for the time until reset (e.g. 2h 13m). "Reset" if passed */
  resets_in: string | null;
  /** When this window's value was fetched and its staleness at display time (per window; statusLine may refresh only some) */
  fetched_at: string | null;
  age_minutes: number | null;
  freshness: ReturnType<typeof freshnessOf>["level"];
  stale: boolean;
  eta_at_local: string | null;
  value_status: ValueStatus | null;
  status_text: string;
}

export interface ProviderView {
  status: ProviderSnapshot["status"];
  fetched_at: string | null;
  /** Minutes since fetch (at display time) */
  age_minutes: number | null;
  freshness: ReturnType<typeof freshnessOf>["level"];
  /** Warning text when stale (e.g. ⚠ Value from 23m ago). null when fresh */
  freshness_message: string | null;
  /** Older than 15 minutes (freshness other than fresh) */
  stale: boolean;
  /** One-line summary of the overall windows only (e.g. 5h 10% · Weekly 2%). For lock-screen inline widgets */
  summary: string;
  collector: string | null;
  error: string | null;
  error_code: ProviderSnapshot["error_code"];
  plan: string | null;
  blocked: boolean | null;
  /** Comma-separated window ids (display order) */
  window_ids: string;
  /** Comma-separated ids of the overall windows (default display) */
  main_window_ids: string;
  /** Window id -> window */
  windows: Record<string, WindowView>;
  /** The window with the least headroom (largest used_percent). null if there are no windows */
  top: WindowView | null;
  observed_until: string | null;
  limiting_key: string | null;
  eta_minutes: number | null;
  eta_at: string | null;
  eta_at_local: string | null;
  status_text: string;
}

export interface SnapshotView {
  view_version: typeof VIEW_VERSION;
  schema_version: typeof SCHEMA_VERSION;
  generated_at: string;
  /** When this view was made */
  now: string;
  /** Collectors that sent values (comma-separated) */
  collectors: string;
  /** When the server last received from any PC (liveness signal). null if unknown */
  last_received_at: string | null;
  /** Nothing received from any PC for STOPPED_AFTER_MINUTES minutes (collection has stopped). null if unknown */
  collection_stopped: boolean | null;
  /** PC name -> that PC's liveness (last receive time, minutes since, whether alive) */
  pcs: Record<string, PcView>;
  /** Time zone of resets_at_local */
  time_zone: string;
  /** One-line summary of everything (e.g. Claude 5h 10% · Weekly 2% / Codex Weekly 29%) */
  summary: string;
  claude: ProviderView | null;
  codex: ProviderView | null;
  gemini: ProviderView | null;
}

export interface PcView {
  received_at: string | null;
  received_minutes_ago: number | null;
  /** Received within STOPPED_AFTER_MINUTES minutes */
  alive: boolean | null;
}

/** If nothing is received from any PC for this many minutes, collection is considered stopped */
export const STOPPED_AFTER_MINUTES = 30;

function pcView(receivedAt: string | null, now: Date): PcView {
  const t = Date.parse(receivedAt ?? "");
  if (!Number.isFinite(t)) return { received_at: null, received_minutes_ago: null, alive: null };
  const minutes = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  return { received_at: receivedAt, received_minutes_ago: minutes, alive: now.getTime() - t <= STOPPED_AFTER_MINUTES * 60_000 };
}

/** Minutes -> "13m", "2h 13m", "3d 4h" */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return h === 0 ? `${d}d` : `${d}d ${h}h`;
}

export interface ViewOptions extends CollectorSelection {
  /** IANA time zone for resets_at_local (e.g. Asia/Tokyo). Defaults to Asia/Tokyo */
  timeZone?: string;
  /** Observations loaded from D1. History before the window's fetched_at is used in calculations */
  observations?: readonly UsageObservation[];
  recentMinutes?: Partial<Record<WindowKind, number>>;
  /**
   * Derived values computed and stored by the server's Cron (`computeMetrics`, based on the latest value up to 5 minutes old).
   * When given, these are used instead of reading history. Windows whose reset time differs from when they were computed
   * (the cycle changed) and windows already reset are recomputed without history
   */
  metrics?: MetricsCache;
}

/** The window value when derived values were computed, and the result */
export interface CachedWindowMetrics {
  fetched_at: string | null;
  resets_at: string | null;
  used_percent: number;
  metrics: WindowMetrics;
}

/** provider -> window id -> stored derived values */
export type MetricsCache = Partial<Record<ProviderId, Record<string, CachedWindowMetrics>>>;

/**
 * Compute derived values from history for each window of a merged snapshot (once, when the server receives observations).
 * Forecasts and rates are based on the last observation, so the result doesn't change with display time
 */
export function computeMetrics(
  s: Snapshot,
  observations: readonly UsageObservation[],
  opts: CollectorSelection & { recentMinutes?: Partial<Record<WindowKind, number>> } = {},
  providers: readonly ProviderId[] = PROVIDERS,
): MetricsCache {
  const out: MetricsCache = {};
  for (const id of providers) {
    const p = s.providers[id];
    if (!p) continue;
    const rows = observations.filter((o) => o.provider === id);
    out[id] = Object.fromEntries(p.windows.map((w) => [w.id, {
      fetched_at: w.fetched_at,
      resets_at: w.resets_at,
      used_percent: w.used_percent,
      metrics: windowMetrics(w, rows, opts.recentMinutes?.[w.kind], opts),
    }]));
  }
  return out;
}

/** Whether stored derived values belong to the same cycle (later value changes are picked up by the next Cron) */
/**
 * Whether stored derived values belong to the same cycle (reset-time jitter within 5 minutes counts as the same cycle; Codex's
 * reset time can shift by 1 second per fetch, and exact comparison would discard derived values on a new fetch between Crons).
 * Later value changes are picked up by the next Cron
 */
function samePeriod(c: CachedWindowMetrics, w: UsageWindow): boolean {
  if (c.resets_at === w.resets_at) return true;
  const a = Date.parse(c.resets_at ?? "");
  const b = Date.parse(w.resets_at ?? "");
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= RESET_TOLERANCE_MS;
}

const DEFAULT_TIME_ZONE = "Asia/Tokyo";

/** "15:00" (today) or "11/20 16:00" in the given time zone */
export function formatLocal(iso: string, now: Date, timeZone: string): string {
  const t = new Date(iso);
  const parts = (d: Date) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(d)
        .map((p) => [p.type, p.value]),
    );
  const a = parts(t);
  const b = parts(now);
  const time = `${a.hour}:${a.minute}`;
  return a.year === b.year && a.month === b.month && a.day === b.day ? time : `${a.month}/${a.day} ${time}`;
}

export function windowView(
  provider: ProviderId,
  w: UsageWindow,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
  providerFetchedAt: string | null = null,
  observations: readonly UsageObservation[] = [],
  recentMinutes?: number,
  selection: CollectorSelection = {},
  /** Stored derived values. undefined: compute from history. null: nothing stored */
  cached?: CachedWindowMetrics | null,
): WindowView {
  const resetMs = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
  const hasReset = !Number.isNaN(resetMs);
  const passed = hasReset && resetMs <= now.getTime();
  const effective = effectiveUsedPercent(w, now);
  const minutes = hasReset ? Math.max(0, Math.round((resetMs - now.getTime()) / 60_000)) : null;
  // The 0% after a reset is a display estimate. Don't show the previous cycle's consumption or forecast as current.
  const basis = passed ? { ...w, fetched_at: null } : w;
  const metrics = cached === undefined
    ? windowMetrics(basis, observations, recentMinutes, selection)
    : !passed && cached !== null && samePeriod(cached, w)
      ? cached.metrics
      : windowMetrics(basis, [], recentMinutes, selection);
  const fresh = windowFreshness(w.fetched_at ?? providerFetchedAt, now);
  const valueStatus = passed ? "reset_estimated" : VALUE_STATUS[fresh.freshness];
  const view = {
    id: w.id,
    key: `${provider}.${w.id}`,
    label: w.label,
    kind: w.kind,
    scope: w.scope,
    detail_only: isDetailOnly(provider, w.id),
    used_percent: effective,
    remaining_percent: Math.round((100 - effective) * 100) / 100,
    used_percent_int: Math.round(effective),
    reset_passed: passed,
    resets_at: w.resets_at,
    resets_at_epoch: hasReset ? Math.floor(resetMs / 1000) : null,
    resets_at_local: w.resets_at && hasReset ? formatLocal(w.resets_at, now, timeZone) : null,
    resets_in_minutes: minutes,
    resets_in: minutes === null ? null : passed ? "Reset" : formatDuration(minutes),
    ...fresh,
    ...metrics,
    eta_at_local: metrics.eta_at === null ? null : formatLocal(metrics.eta_at, now, timeZone),
    value_status: valueStatus,
  };
  return { ...view, status_text: statusText([view]) };
}

function windowFreshness(fetchedAt: string | null, now: Date) {
  const f = freshnessOf(fetchedAt, now);
  return { fetched_at: fetchedAt, age_minutes: f.age_minutes, freshness: f.level, stale: f.level !== "fresh" };
}

const VALUE_STATUS: Record<WindowView["freshness"], ValueStatus | null> = {
  fresh: "fresh", caution: "stale", old: "old", unknown: null,
};
const VALUE_SEVERITY: Record<ValueStatus, number> = { fresh: 0, stale: 1, old: 2, reset_estimated: 3 };

type WindowStatus = Pick<WindowView, "value_status" | "age_minutes" | "recent_minutes" | "recent_quality" | "confidence">;

function valueText(window: WindowStatus): string {
  switch (window.value_status) {
    case "stale": return `⚠ ${window.age_minutes}m ago`;
    case "old": return `Old (${formatDuration(window.age_minutes ?? 0)} ago)`;
    case "reset_estimated": return "Reset (estimated)";
    case null: return "Fetch time unknown";
    case "fresh": return "";
  }
}

function statusText(windows: readonly WindowStatus[]): string {
  const severity = (w: WindowStatus) => w.value_status === null ? 2 : VALUE_SEVERITY[w.value_status];
  const worst = windows.reduce<WindowStatus | undefined>((worst, w) => {
    if (!worst || severity(w) > severity(worst)) return w;
    return severity(w) === severity(worst) && (w.age_minutes ?? Infinity) > (worst.age_minutes ?? Infinity) ? w : worst;
  }, undefined);
  const recent = windows.filter((w) => w.recent_minutes !== null);
  const recentText = recent.some((w) => w.recent_quality === "unknown") ? "Recent usage: not enough data"
    : recent.some((w) => w.recent_quality === "approx") ? "Recent usage: approximate" : "";
  const forecastText = windows.some((w) => w.confidence === "insufficient") ? "Forecast: not enough data"
    : windows.some((w) => w.confidence === "low") ? "Forecast: low confidence" : "";
  return [worst ? valueText(worst) : "", recentText, forecastText].filter(Boolean).join(" · ");
}

export function providerView(
  provider: ProviderId,
  p: ProviderSnapshot,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
  options: ViewOptions = {},
): ProviderView {
  // By its time; a value its PC marked old (its next fetch failed, as a rate limit's, or its limits changed) isn't fresh whatever its
  // time. Each window keeps its own time (the statusLine may refresh some)
  const byTime = freshnessOf(p.fetched_at, now);
  const fresh = p.status === "stale" && byTime.level === "fresh"
    ? { level: "caution" as const, age_minutes: byTime.age_minutes, message: `⚠ Value from ${formatAge(byTime.age_minutes ?? 0)} ago` }
    : byTime;
  const history = new Map<string, UsageObservation[]>();
  for (const row of options.observations ?? []) {
    if (row.provider !== provider) continue;
    const rows = history.get(row.window_id);
    if (rows) rows.push(row);
    else history.set(row.window_id, [row]);
  }
  const list = p.windows.map((w) => windowView(
    provider, w, now, timeZone, p.fetched_at, history.get(w.id), options.recentMinutes?.[w.kind], options,
    options.metrics === undefined ? undefined : options.metrics[provider]?.[w.id] ?? null,
  ));
  // Windows shown in details only stay in `windows`, but nothing else is chosen from them
  const shown = list.filter((w) => !w.detail_only);
  const main = shown.filter((w) => w.scope === null);
  // Prefer overall windows. Pick from per-model / per-group windows only when there is no overall window
  const top = (main.length > 0 ? main : shown).reduce<WindowView | null>(
    (a, b) => (a === null || b.used_percent > a.used_percent ? b : a),
    null,
  );
  const limiting = main.reduce<WindowView | null>((earliest, w) => {
    if (w.eta_at === null || w.reset_first !== false) return earliest;
    return earliest?.eta_at && earliest.eta_at <= w.eta_at ? earliest : w;
  }, null);
  let observedUntil: string | null = null;
  let observedTime = Number.NEGATIVE_INFINITY;
  for (const window of p.windows) {
    const at = Date.parse(window.fetched_at ?? "");
    if (at > observedTime) {
      observedTime = at;
      observedUntil = window.fetched_at;
    }
  }
  return {
    status: p.status,
    fetched_at: p.fetched_at,
    age_minutes: fresh.age_minutes,
    freshness: fresh.level,
    freshness_message: fresh.message,
    stale: fresh.level !== "fresh",
    summary: main.map((w) => `${w.label} ${w.used_percent_int}%`).join(" · "),
    collector: p.collector,
    error: p.error,
    error_code: p.error_code,
    plan: p.plan,
    blocked: p.blocked,
    window_ids: list.map((w) => w.id).join(","),
    main_window_ids: main.map((w) => w.id).join(","),
    windows: Object.fromEntries(list.map((w) => [w.id, w])),
    top,
    observed_until: observedUntil,
    limiting_key: limiting?.key ?? null,
    eta_minutes: limiting?.eta_minutes ?? null,
    eta_at: limiting?.eta_at ?? null,
    eta_at_local: limiting?.eta_at_local ?? null,
    status_text: statusText(shown),
  };
}

/** Merged snapshot -> view for displays. The server (Worker) builds it on every GET (derived values come from the stored `metrics`) */
export function toView(s: Snapshot, now: Date = new Date(), opts: ViewOptions = {}): SnapshotView {
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const pv = (id: ProviderId) => {
    const p = s.providers[id];
    return p ? providerView(id, p, now, timeZone, opts) : null;
  };
  const views = Object.fromEntries(PROVIDERS.map((id) => [id, pv(id)])) as Record<ProviderId, ProviderView | null>;
  const summary = PROVIDERS.map((id) => {
    const v = views[id];
    return v && v.summary ? `${PROVIDER_NAMES[id]} ${v.summary}` : null;
  })
    .filter(Boolean)
    .join(" / ");
  const pcs = Object.fromEntries((s.collectors ?? []).map((c) => [c.id, pcView(c.received_at ?? null, now)]));
  const received = (s.collectors ?? []).map((c) => c.received_at ?? null).filter((t): t is string => t !== null && Number.isFinite(Date.parse(t)));
  const lastReceived = received.length === 0 ? null : received.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  const last = pcView(lastReceived, now);
  return {
    view_version: VIEW_VERSION,
    schema_version: SCHEMA_VERSION,
    generated_at: s.generated_at,
    now: now.toISOString(),
    collectors: (s.collectors ?? []).map((c) => c.id).join(",") || (s.collector ?? ""),
    last_received_at: lastReceived,
    collection_stopped: last.alive === null ? null : !last.alive,
    pcs,
    time_zone: timeZone,
    summary,
    claude: views.claude,
    codex: views.codex,
    gemini: views.gemini,
  };
}
