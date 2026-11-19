import { RESET_TOLERANCE_MS, preferCollector, simultaneousMs, type CollectorSelection } from "./collector-selection.ts";
import type { UsageObservation, UsageWindow, WindowKind } from "./schema.ts";

const MINUTE_MS = 60_000;
const MAX_GAP = 15;
const MIN_RATE = 0.01;

export type RecentQuality = "exact" | "approx" | "unknown";
export type Confidence = "high" | "medium" | "low" | "insufficient";

export interface WindowMetrics {
  recent_minutes: number | null;
  recent_consumed_percent: number | null;
  recent_quality: RecentQuality;
  /** %/hour. Rates during calculation are %/minute */
  rate_15m: number | null;
  rate_60m: number | null;
  rate_24h: number | null;
  /**
   * Rate used for the limit forecast (%/hour, unrounded): the first of rate_60m -> rate_15m -> rate_24h that exceeds the
   * minimum before rounding. Media draw the forecast from this and the remainder (re-picking from rounded values would disagree with the forecast)
   */
  rate_pace: number | null;
  eta_minutes: number | null;
  eta_at: string | null;
  eta_fast_minutes: number | null;
  reset_first: boolean | null;
  confidence: Confidence;
  anomalous: boolean | null;
  unobserved_minutes: number | null;
  unobserved_consumed_percent: number | null;
}

interface Sample {
  at: number;
  reset: number;
  used: number;
  collector: string | null;
}

const DEFAULT_RECENT_MINUTES: Partial<Record<WindowKind, number>> = {
  session: 60, weekly: 1440, monthly: 1440,
};

const roundPercent = (value: number) => Math.round(value * 100) / 100;
const elapsed = (from: Sample, to: Sample) => (to.at - from.at) / MINUTE_MS;
const consumed = (from: Sample, to: Sample) => roundPercent(Math.max(0, to.used - from.used));

function sample(at: string | null, resetsAt: string | null, used: number, collector: string | null): Sample | null {
  const time = Date.parse(at ?? "");
  const reset = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(time) || !Number.isFinite(reset) || reset <= time) return null;
  if (!Number.isFinite(used) || used < 0 || used > 100) return null;
  return { at: time, reset, used, collector };
}

function chooseHistory(points: readonly Sample[], latest: Sample, options: CollectorSelection): Sample[] {
  const within = simultaneousMs(options);
  // The current value is the observation mergeSnapshots chose. Don't overwrite it with history from the same time span.
  const selected = [latest];
  let end = points.length;
  let next = latest;
  while (end > 0) {
    const newest = points[end - 1]!;
    if (next.at - newest.at <= within) {
      end--;
      continue;
    }
    let start = end - 1;
    while (start > 0 && newest.at - points[start - 1]!.at <= within) start--;
    next = preferCollector(points.slice(start, end), (p) => p, options.collectorPriority)!;
    selected.push(next);
    end = start;
  }
  return selected.reverse();
}

function recentConsumption(
  latest: Sample,
  current: readonly Sample[],
  previous: Sample | undefined,
  minutes: number | null,
): Pick<WindowMetrics, "recent_consumed_percent" | "recent_quality"> {
  if (minutes === null) return { recent_consumed_percent: null, recent_quality: "unknown" };
  const start = latest.at - minutes * MINUTE_MS;
  if (previous && previous.reset >= start && previous.reset <= latest.at) {
    return { recent_consumed_percent: latest.used, recent_quality: "exact" };
  }

  let nearest: Sample | undefined;
  let firstInRange: Sample | undefined;
  for (const point of current) {
    if (point.at === latest.at) break;
    if (point.at >= start) firstInRange ??= point;
    const distance = Math.abs(point.at - start);
    // On a tie in distance take the later observation, so consumption isn't overstated.
    if (distance <= MAX_GAP * MINUTE_MS && (!nearest || distance <= Math.abs(nearest.at - start))) {
      nearest = point;
    }
  }
  if (nearest) return { recent_consumed_percent: consumed(nearest, latest), recent_quality: "exact" };
  if (firstInRange) return { recent_consumed_percent: consumed(firstInRange, latest), recent_quality: "approx" };
  return { recent_consumed_percent: null, recent_quality: "unknown" };
}

/**
 * Period average: sum of differences over intervals fully inside the period / total time of those intervals (%/minute). Intervals
 * that decreased (rounding, mix-ups) are excluded from both. A moving average anchored at the first difference is not used, because
 * a 1% step in integer usage would linger in long-period rates for hours
 */
interface Rate {
  /** %/minute */
  value: number;
  /** Observations at both ends of the intervals used (no duplicates) */
  samples: number;
  /** Total time of the intervals used (minutes) */
  minutes: number;
  /** Total increase over the intervals used */
  increase: number;
  integer: boolean;
}

function rate(points: readonly Sample[], latest: Sample, minutes: number): Rate | null {
  let increase = 0;
  let duration = 0;
  const used = new Set<Sample>();
  let previous: Sample | undefined;
  for (const point of points) {
    if (elapsed(point, latest) > minutes) continue;
    if (previous && point.used >= previous.used) {
      increase += point.used - previous.used;
      duration += elapsed(previous, point);
      used.add(previous).add(point);
    }
    previous = point;
  }
  if (duration <= 0) return null;
  const integer = [...used].every((p) => Number.isInteger(p.used));
  return { value: increase / duration, samples: used.size, minutes: duration, increase, integer };
}

/** Decided by the count and duration of the observations behind the forecast rate (observations excluded from the rate, e.g. decreasing intervals, don't count) */
function confidenceOf(basis: Rate, fast: number | null, normal: number | null): Confidence {
  const lowResolution = basis.integer && basis.increase < 3;
  const divergent = fast !== null && normal !== null && Math.max(fast, normal) > 0
    && Math.max(fast, normal) >= 2.5 * Math.min(fast, normal);
  if (basis.samples >= 8 && basis.minutes >= 45) return lowResolution || divergent ? "medium" : "high";
  if (basis.samples >= 3 && basis.minutes >= 15 && !lowResolution) return "medium";
  return "low";
}

/** Compute values from the history of the same provider and window, based on the latest observed window. */
export function windowMetrics(
  window: UsageWindow,
  observations: readonly UsageObservation[],
  recentMinutes: number | undefined = undefined,
  selection: CollectorSelection = {},
): WindowMetrics {
  const minutes = recentMinutes !== undefined && Number.isFinite(recentMinutes) && recentMinutes > 0
    ? recentMinutes : DEFAULT_RECENT_MINUTES[window.kind] ?? null;
  const blank: WindowMetrics = {
    recent_minutes: minutes, recent_consumed_percent: null, recent_quality: "unknown",
    rate_15m: null, rate_60m: null, rate_24h: null, rate_pace: null,
    eta_minutes: null, eta_at: null, eta_fast_minutes: null, reset_first: null,
    confidence: "insufficient", anomalous: null, unobserved_minutes: null, unobserved_consumed_percent: null,
  };
  const latest = sample(window.fetched_at, window.resets_at, window.used_percent, null);
  if (!latest) {
    // The window hasn't started (0% with no reset time, e.g. Claude's 5-hour window). The previous cycle's consumption is before the reset, so it isn't counted
    const at = Date.parse(window.fetched_at ?? "");
    return window.resets_at === null && window.used_percent === 0 && Number.isFinite(at) && minutes !== null
      ? { ...blank, recent_consumed_percent: 0, recent_quality: "exact" }
      : blank;
  }

  const points: Sample[] = [];
  /** 0% before the window starts (no reset time). Used as the 0% at the start of the current cycle */
  const idle: UsageObservation[] = [];
  for (const o of observations) {
    if (o.window_id !== window.id) continue;
    const at = Date.parse(o.observed_at);
    if (o.resets_at === null && o.used_percent === 0 && Number.isFinite(at) && at < latest.at) idle.push(o);
    const point = sample(o.observed_at, o.resets_at, o.used_percent, o.collector);
    if (point && point.at < latest.at) points.push(point);
  }
  points.sort((a, b) => a.at - b.at);
  const previous = points.findLast((p) => p.reset <= latest.at && latest.reset - p.reset > RESET_TOLERANCE_MS);
  const period = points.filter((p) => Math.abs(p.reset - latest.reset) <= RESET_TOLERANCE_MS
    && (!previous || p.at >= previous.reset));
  const periodStart = period[0]?.at ?? latest.at;
  for (const o of idle) {
    const at = Date.parse(o.observed_at);
    // Only those after the previous cycle's reset and before the current cycle's first observation
    if (at < periodStart && (!previous || at >= previous.reset)) {
      period.push({ at, reset: latest.reset, used: 0, collector: o.collector });
    }
  }
  period.sort((a, b) => a.at - b.at);
  const current = chooseHistory(period, latest, selection);

  let continuousStart = current.length - 1;
  let gap: { before: Sample; after: Sample } | undefined;
  for (let i = continuousStart; i > 0; i--) {
    const before = current[i - 1]!;
    const after = current[i]!;
    if (elapsed(before, after) > MAX_GAP) {
      gap = { before, after };
      break;
    }
    continuousStart = i - 1;
  }
  const continuous = current.slice(continuousStart);
  const fastRate = rate(continuous, latest, 15);
  const normalRate = rate(continuous, latest, 60);
  const longRate = rate(continuous, latest, 1440);
  const fast = fastRate?.value ?? null;
  const normal = normalRate?.value ?? null;
  const long = longRate?.value ?? null;
  const paceRate = [normalRate, fastRate, longRate].find((r) => r !== null && r.value >= MIN_RATE) ?? null;
  const pace = paceRate?.value ?? null;
  /** Basis for confidence: the rate used for the forecast. Without a forecast, the first available rate in the order 60 min -> 15 min -> 24 h */
  const basis = paceRate ?? normalRate ?? fastRate ?? longRate;
  const remaining = 100 - latest.used;
  // The limit forecast is computed from the published rate (rate_pace in %/hour) converted back to %/minute. Media do the same
  // calculation from the same value, so the limit-vs-reset ordering agrees (no 1 ms drift from floating-point conversion)
  const pacePerHour = pace === null ? null : pace * 60;
  const eta = remaining === 0 ? 0 : pacePerHour !== null ? remaining / (pacePerHour / 60) : null;
  const etaMs = eta === null ? null : latest.at + Math.round(eta * MINUTE_MS);

  return {
    recent_minutes: minutes,
    ...recentConsumption(latest, current, previous, minutes),
    rate_15m: fast === null ? null : roundPercent(fast * 60),
    rate_60m: normal === null ? null : roundPercent(normal * 60),
    rate_24h: long === null ? null : roundPercent(long * 60),
    // Not rounded (so media can make the same limit judgment as core)
    rate_pace: pacePerHour,
    eta_minutes: eta === null ? null : roundPercent(eta),
    eta_at: etaMs === null ? null : new Date(etaMs).toISOString(),
    eta_fast_minutes: remaining === 0 ? 0 : pace === null ? null : roundPercent(remaining / Math.max(pace, fast ?? 0)),
    reset_first: etaMs === null ? null : latest.reset <= etaMs,
    confidence: basis === null ? "insufficient" : confidenceOf(basis, fast, normal),
    anomalous: fast === null || normal === null || continuous.length < 3 ? null : fast >= 0.10 && fast > normal * 1.75,
    unobserved_minutes: gap ? roundPercent(elapsed(gap.before, gap.after)) : null,
    unobserved_consumed_percent: gap ? consumed(gap.before, gap.after) : null,
  };
}

/** A point for the chart (7 days of the weekly window). `break`: a new segment starts here (gap from the previous point, or the cycle changed at a reset) */
export interface SeriesPoint {
  at: string;
  used_percent: number;
  resets_at: string | null;
  break: "gap" | "reset" | null;
}

/** A row of the hourly aggregate (7 days of the weekly window; D1's observation_hourly) */
export interface HourlyRow {
  observed_at: string;
  used_percent: number;
  resets_at: string | null;
}

/** Interval treated as a "gap" in the hourly series: over 90 minutes with no observation */
export const HOURLY_GAP_MS = 90 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * Build a series from the hourly aggregate (chart of 7 days of the weekly window). Points before since are dropped.
 * break is a gap (gap), or a cycle change (reset time differs by more than 5 minutes; reset). Each point is the last observation of its UTC hour,
 * so points of adjacent hours can be up to 2 hours apart with observations in between: a gap is over 90 minutes with at least one whole hour
 * between the points that has no point (no observation)
 */
export function hourlySeries(rows: readonly HourlyRow[], since: Date): SeriesPoint[] {
  const points = rows
    .map((r) => ({ at: Date.parse(r.observed_at), used: r.used_percent, reset: r.resets_at === null ? null : Date.parse(r.resets_at) }))
    .filter((p) => Number.isFinite(p.at) && p.at >= since.getTime() && Number.isFinite(p.used) && p.used >= 0 && p.used <= 100
      && (p.reset === null || Number.isFinite(p.reset)))
    .sort((a, b) => a.at - b.at);
  return points.map((p, i) => {
    const before = points[i - 1];
    const sameCycle = before === undefined ? true
      : before.reset === null || p.reset === null ? before.reset === p.reset
      : Math.abs(before.reset - p.reset) <= RESET_TOLERANCE_MS;
    return {
      at: new Date(p.at).toISOString(),
      used_percent: p.used,
      resets_at: p.reset === null ? null : new Date(p.reset).toISOString(),
      break: before === undefined ? null : !sameCycle ? "reset"
        : p.at - before.at > HOURLY_GAP_MS && Math.floor(p.at / HOUR_MS) - Math.floor(before.at / HOUR_MS) > 1 ? "gap" : null,
    };
  });
}

