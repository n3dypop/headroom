// Event detection. The server's Cron judges every 5 minutes from the same view used for display.
//
// - Each event is recorded once per key (kind, provider, window, cycle anchor time, threshold). Keys created (or marked done) are
//   remembered in the state, so repeating the same input returns neither events nor state changes. The server's unique key also prevents duplicates
// - The cycle anchor is the first reset time seen in that cycle (jitter within 5 minutes is the same cycle). Kept per window in the state
// - If several thresholds are crossed, only the most severe (largest usage, smallest minutes for "limit soon") is shown;
//   the rest are "done" markers (visible: false)
// - Usage and forecast events are judged only on a new fetch of that window (no new events when only derived values change from late, old observations)
// - An accepted account switch (a new history boundary) starts the provider's state afresh: cycles, errors and the limit marker of the
//   previous account are dropped, and the provider's keys carry a switch count, so the new account's events are never taken for old ones

import { RESET_TOLERANCE_MS } from "./collector-selection.ts";
import type { ErrorCode, ProviderId } from "./schema.ts";
import type { Confidence } from "./history.ts";
import { STOPPED_AFTER_MINUTES, type ProviderView, type SnapshotView, type WindowView } from "./view.ts";

const MINUTE_MS = 60_000;
/**
 * For a state judged before fetch times were kept as the PC sent them (no judged_exact): the same value from the same PC with a fetch
 * time this close to the judged one is the same fetch (an earlier Worker adjusted fetch times by the send delay). A state judged since
 * compares fetch times exactly, so a real new fetch within a minute with the same value is judged
 */
const SAME_FETCH_MS = MINUTE_MS;

export type EventKind =
  | "threshold" | "limit" | "reset" | "soon" | "anomalous" | "provider_error"
  | "collection_stopped" | "collection_resumed";

export interface EventOptions {
  /** Usage thresholds (%). Default 80, 95 */
  thresholds?: readonly number[];
  /** "Limit soon" thresholds (minutes). Default 30, 15, 5 */
  soonMinutes?: readonly number[];
  /** Minutes without receiving from any PC before collection is considered stopped. Default 30 */
  stoppedAfterMinutes?: number;
  /** Minutes after the reset time, with no live PC, before creating an estimated reset. Default 10 */
  estimatedResetAfterMinutes?: number;
  /**
   * Windows whose derived values haven't yet been computed from that window's fetched value (`provider.window`; the server checks
   * before judging). They are not judged this round and their state is kept (so a new fetch isn't marked judged with old derived values)
   */
  pending?: readonly string[];
  /**
   * provider -> current history boundary stamp ("<accepted time>#<count>", or "" / "#0" if none). When it differs from the stamp the
   * state was judged under, the provider's state is started afresh. A state written before stamps were kept can't tell whether it
   * already saw an accepted switch (a switch can reach the server well after it was accepted), so after any switch it is started
   * afresh too: a notification may repeat once rather than one for the new account being missed. Omitted: boundaries are not tracked
   */
  boundaries?: Partial<Record<ProviderId, string>>;
}

const DEFAULTS = {
  thresholds: [80, 95],
  soonMinutes: [30, 15, 5],
  stoppedAfterMinutes: STOPPED_AFTER_MINUTES,
  estimatedResetAfterMinutes: 10,
  pending: [],
  boundaries: {},
} satisfies Required<EventOptions>;

/** Content shown to media (the server adds the number and creation time) */
export interface EventBody {
  kind: EventKind;
  provider: ProviderId | null;
  window_id: string | null;
  /** Window display name (e.g. 5h, Weekly Fable) */
  label: string | null;
  /** Target of a per-model / per-group window. null for the overall window */
  scope: string | null;
  /** Cycle anchor time (the first reset time seen in that cycle) */
  cycle: string | null;
  /** Threshold: usage (%); limit soon: minutes. Otherwise null */
  threshold: number | null;
  /** Usage at judgment time */
  used_percent: number | null;
  /** Minutes until the limit at judgment time (using the faster rate) */
  eta_minutes: number | null;
  resets_at: string | null;
  /** For limit: the PC confirmed it is at the limit (blocked) */
  blocked: boolean | null;
  error_code: ErrorCode | null;
  /** For reset: a new cycle was observed (true) or estimated from the time (false) */
  confirmed: boolean | null;
  confidence: Confidence | null;
  /** Reliability label at judgment time (the view's status_text) */
  status_text: string;
  /** Collection stopped/resumed: last receive time from any PC */
  last_received_at: string | null;
  /**
   * The provider's history boundary stamp the event was judged under ("<accepted time>#<count>"; no account info). Clients tell an
   * account's events apart from the next account's by it. null for events without a provider or judged without boundaries
   */
  boundary?: string | null;
}

export interface JudgedEvent {
  key: string;
  /** false is only a "done" marker (not shown to media; prevents creating the same event later) */
  visible: boolean;
  /** How long to remember this key (the later of the end of the cycle and 8 days) */
  keep_until: string;
  body: EventBody;
}

export interface CycleState {
  /** Cycle anchor time */
  cycle: string;
  /** A limit or threshold event was created in this cycle (condition for a reset event) */
  alerted: boolean;
  /** The reset event for this cycle was created (not duplicated when observed after an estimated one) */
  reset_sent: boolean;
  /** Keys created (or marked done) in this cycle. Repeating the same judgment writes nothing */
  sent: string[];
  /** Fetch time of the window last judged. No new usage/forecast events until a newer fetch arrives */
  judged_at: string | null;
  /** Usage of the window last judged (judged again if the chosen observation changed the value, even with the same fetch time) */
  judged_used?: number | null;
  /** Reset time of the window last judged (jitter within the same cycle can still change forecast conditions) */
  judged_reset?: string | null;
  /** PC whose fetch was last judged (only a fetch from the same PC can be a resend of it) */
  judged_by?: string | null;
  /** judged_at is the fetch time as the PC sent it (compared exactly). Absent in states judged by an earlier Worker */
  judged_exact?: boolean;
}

export interface EventState {
  /** `provider.window` -> cycle */
  cycles: Record<string, CycleState>;
  /** provider -> last seen error_code (only login_required and safety_stop; otherwise null) */
  errors: Partial<Record<ProviderId, ErrorCode | null>>;
  /**
   * provider -> limit notification sent while blocked. `*`: notified without a window (not repeated when windows come back); a window id:
   * notified for that window (another window newly reaching 100% is still notified). null when not blocked
   */
  blocked: Partial<Record<ProviderId, string | null>>;
  /** Already notified that collection has stopped */
  stopped: boolean;
  /** Time of the judgment that wrote this state. Judgments for an earlier time (a Cron that read the state late) do nothing */
  judged_at: string | null;
  /** provider -> history boundary stamp the provider's state belongs to (absent in states written before this was tracked) */
  boundaries?: Partial<Record<ProviderId, string>>;
  /** provider -> number of account switches seen. Added to the provider's keys when above 0 */
  switches?: Partial<Record<ProviderId, number>>;
}

export const emptyEventState = (): EventState => ({ cycles: {}, errors: {}, blocked: {}, stopped: false, judged_at: null });

/** Marker: limit was notified without a window */
const WINDOWLESS = "*";

/** How long events are shown (media that read within this period can catch up) */
export const EVENT_RETENTION_MS = 8 * 24 * 60 * MINUTE_MS;

const NOTIFY_ERRORS: readonly ErrorCode[] = ["login_required", "safety_stop"];
/** Forecast-based events aren't created while confidence is low (avoids false alerts right after observation starts or from a 1% step) */
const TRUSTED: readonly Confidence[] = ["high", "medium"];

const time = (iso: string | null | undefined) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : null;
};

function blankBody(kind: EventKind): EventBody {
  return {
    kind, provider: null, window_id: null, label: null, scope: null, cycle: null, threshold: null,
    used_percent: null, eta_minutes: null, resets_at: null, blocked: null, error_code: null, confirmed: null,
    confidence: null, status_text: "", last_received_at: null,
  };
}

function windowBody(kind: EventKind, provider: ProviderId, w: WindowView, cycle: string): EventBody {
  return {
    ...blankBody(kind), provider, window_id: w.id, label: w.label, scope: w.scope, cycle,
    used_percent: w.used_percent, eta_minutes: w.eta_fast_minutes, resets_at: w.resets_at,
    confidence: w.confidence, status_text: w.status_text,
  };
}

/** Key-order-independent JSON (for comparing whether the state changed) */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stored blocked (the old-form true is read as notified without a window) */
function blockedOf(state: EventState): Partial<Record<ProviderId, string | null>> {
  const out: Partial<Record<ProviderId, string | null>> = {};
  for (const [id, v] of Object.entries(state.blocked ?? {}) as [ProviderId, unknown][]) {
    out[id] = v === true ? WINDOWLESS : typeof v === "string" ? v : null;
  }
  return out;
}

const newCycle = (cycle: string): CycleState => ({ cycle, alerted: false, reset_sent: false, sent: [], judged_at: null });

export interface Liveness {
  /** Last time anything was received from any PC (server receive time). null if no record */
  last_received_at: string | null;
}

/**
 * From the view (same values as the display) and the previous state, return the events to create and the next state.
 * Keys once created (or marked done) are remembered, so repeating the same input returns neither events nor state changes
 */
export function judgeEvents(
  view: SnapshotView,
  state: EventState,
  liveness: Liveness,
  now: Date,
  options: EventOptions = {},
): { events: JudgedEvent[]; state: EventState; changed: boolean } {
  const o = { ...DEFAULTS, ...options };
  const at = now.getTime();
  // Don't advance state written by a later judgment with an earlier one
  const lastJudged = time(state.judged_at);
  if (lastJudged !== null && at < lastJudged) return { events: [], state, changed: false };
  const keepUntil = (cycle: string | null) =>
    new Date(Math.max(at + EVENT_RETENTION_MS, (time(cycle) ?? 0) + 24 * 60 * MINUTE_MS)).toISOString();
  const events: JudgedEvent[] = [];
  /** Cycle-bound events are created only if not already created in that cycle */
  const add = (key: string, visible: boolean, judged: EventBody, cycle?: CycleState) => {
    // The stamp given for this judgment (not one kept from an earlier one: an event judged without stamps says nothing about them)
    const body: EventBody = { ...judged, boundary: judged.provider ? (o.boundaries as Partial<Record<ProviderId, string>>)[judged.provider] ?? null : null };
    if (cycle) {
      if (cycle.sent.includes(key)) return;
      cycle.sent.push(key);
    }
    events.push({ key, visible, keep_until: keepUntil(body.cycle), body });
  };
  const copy = (c: CycleState): CycleState => ({ ...c, sent: [...(c.sent ?? [])], judged_at: c.judged_at ?? null });
  // An account switch since the last judgment: forget the provider's state from the previous account
  const boundaries: Partial<Record<ProviderId, string>> = { ...(state.boundaries ?? {}) };
  const switches: Partial<Record<ProviderId, number>> = { ...(state.switches ?? {}) };
  const prior: EventState = { ...state, cycles: { ...state.cycles }, errors: { ...state.errors }, blocked: blockedOf(state) };
  for (const [id, stamp] of Object.entries(o.boundaries) as [ProviderId, string][]) {
    const known = state.boundaries?.[id];
    // A state written before stamps were kept: start afresh if any switch was ever accepted (an accepted time before "#", or a
    // count after it above 0; boundaries saved before the count existed have a time and count 0)
    const [acceptedTime = "", count = "0"] = stamp.split("#");
    const accepted = acceptedTime !== "" || Number(count) > 0;
    const newToLegacy = known === undefined && accepted;
    if ((known !== undefined && known !== stamp) || newToLegacy) {
      for (const key of Object.keys(prior.cycles)) if (key.startsWith(`${id}.`)) delete prior.cycles[key];
      prior.errors[id] = null;
      prior.blocked[id] = null;
      switches[id] = (switches[id] ?? 0) + 1;
    }
    boundaries[id] = stamp;
  }
  /** The provider part of keys: the provider id, plus the switch count after an account switch */
  const pk = (id: ProviderId) => ((switches[id] ?? 0) > 0 ? `${id}#${switches[id]}` : id);
  const next: EventState = {
    cycles: {}, errors: { ...prior.errors }, blocked: { ...prior.blocked }, stopped: state.stopped,
    judged_at: state.judged_at ?? null,
    ...(Object.keys(boundaries).length > 0 ? { boundaries, switches } : {}),
  };
  const lastReceived = time(liveness.last_received_at);
  /** Some PC is alive (same criterion as collection stopped) */
  const alive = lastReceived !== null && at - lastReceived <= o.stoppedAfterMinutes * MINUTE_MS;
  /** Windows judged from the view this round (including windows whose cycle was cleared) */
  const handled = new Set<string>();

  for (const id of ["claude", "codex"] as const) {
    const p = view[id];
    if (p) judgeProvider(id, p);
  }

  // Keep windows that aren't in the view as they are
  for (const [key, c] of Object.entries(prior.cycles)) {
    if (!handled.has(key)) next.cycles[key] = c;
  }

  // Collection stopped/resumed. If the receive record is gone (stopped for long), wait with the stop already notified
  if (lastReceived !== null && !alive !== state.stopped) {
    const kind = alive ? "collection_resumed" : "collection_stopped";
    add(`${kind}:${liveness.last_received_at}`, true, {
      ...blankBody(kind), last_received_at: liveness.last_received_at,
      status_text: alive ? "" : "No recent uploads from any PC",
    });
    next.stopped = !alive;
  }
  // Advance the judgment time only when something changed (repeating the same input doesn't write state)
  const changed = events.length > 0 || canonical(next) !== canonical({ ...state, blocked: blockedOf(state), judged_at: state.judged_at ?? null });
  // (a boundary first recorded or changed makes next differ from state, so it is written)
  if (!changed) return { events, state, changed };
  next.judged_at = now.toISOString();
  return { events, state: next, changed };

  function judgeProvider(id: ProviderId, p: ProviderView) {
    // Sign-in expired / safety stop (per provider; only on change)
    const code = p.error_code !== null && NOTIFY_ERRORS.includes(p.error_code) ? p.error_code : null;
    if (code !== (prior.errors[id] ?? null)) {
      if (code !== null) {
        add(`provider_error:${pk(id)}:${code}:${p.fetched_at ?? now.toISOString()}`, true, {
          ...blankBody("provider_error"), provider: id, error_code: code, status_text: p.status_text,
        });
      }
      next.errors[id] = code;
    }

    const windows = Object.values(p.windows);
    for (const w of windows) judgeWindow(id, p, w);

    // The PC confirmed it is at the limit (blocked). If not already notified via an overall window at 100%, notify once while blocked
    if (p.blocked !== true) {
      next.blocked[id] = null;
      return;
    }
    if ((next.blocked[id] ?? null) !== null) return;
    // If any window's derived values are behind, don't decide this round (don't notify as windowless when windows exist)
    if (windows.some((w) => o.pending.includes(w.key))) return;
    const main = windows.filter((w) => w.scope === null && !w.reset_passed);
    if (!main.some((w) => w.used_percent >= 100)) {
      const w = main.reduce<WindowView | null>((a, b) => (a === null || b.used_percent > a.used_percent ? b : a), null);
      const c = w ? next.cycles[w.key] : undefined;
      if (w && c) {
        add(`limit:${pk(id)}:${w.id}:${c.cycle}`, true, { ...windowBody("limit", id, w, c.cycle), blocked: true }, c);
        c.alerted = true;
        next.blocked[id] = w.id;
      } else {
        // No windows (only the limit is known). Key on the fetch time at which blocked was learned
        add(`limit:${pk(id)}:blocked:${p.fetched_at ?? now.toISOString()}`, true, {
          ...blankBody("limit"), provider: id, blocked: true, status_text: p.status_text,
        });
        next.blocked[id] = WINDOWLESS;
      }
    }
  }

  function judgeWindow(id: ProviderId, p: ProviderView, w: WindowView) {
    // For windows whose derived values are behind, keep the state (not added to handled, so the previous cycle is remembered)
    if (o.pending.includes(w.key)) return;
    handled.add(w.key);
    const stored = prior.cycles[w.key];
    const previous = stored ? copy(stored) : undefined;
    const reset = time(w.resets_at);
    const fetched = time(w.fetched_at);
    const overall = w.scope === null;

    // The window hasn't started (0%, no reset time; Claude's 5-hour window): an observation after the previous cycle's reset means a new cycle
    if (reset === null) {
      if (previous && fetched !== null && fetched >= (time(previous.cycle) ?? Infinity) - RESET_TOLERANCE_MS) {
        resetEvent(id, w, previous, true);
      } else if (previous) {
        next.cycles[w.key] = previous;
      }
      return;
    }

    // The reset time has passed and the new cycle hasn't been observed yet (the view estimates 0%)
    if (w.reset_passed) {
      const c = previous ?? newCycle(w.resets_at!);
      next.cycles[w.key] = c;
      const due = Math.max(time(c.cycle) ?? reset, reset) + o.estimatedResetAfterMinutes * MINUTE_MS;
      // If any PC is alive, wait for its observation. If all have stopped, create an estimated one
      if (overall && c.alerted && !c.reset_sent && at >= due && !alive) {
        add(`reset:${pk(id)}:${w.id}:${c.cycle}`, true, { ...windowBody("reset", id, w, c.cycle), confirmed: false });
        c.reset_sent = true;
      }
      return;
    }

    let cycle: CycleState;
    const start = previous ? time(previous.cycle) : null;
    if (previous && start !== null && Math.abs(reset - start) <= RESET_TOLERANCE_MS) {
      cycle = previous;
    } else if (previous && start !== null && reset < start) {
      // Reset time earlier than the previous cycle (an old value arriving late). Don't roll the cycle back and don't judge
      next.cycles[w.key] = previous;
      return;
    } else {
      // New cycle. If the previous cycle was notified, create a "confirmed" reset
      if (previous) resetEvent(id, w, previous, false);
      cycle = newCycle(w.resets_at!);
    }
    next.cycles[w.key] = cycle;

    // Without a new fetched value, don't add usage/forecast events (e.g. a late resend changed only derived values)
    const judged = time(cycle.judged_at);
    const sameValue = (cycle.judged_used ?? null) === w.used_percent && (cycle.judged_reset ?? null) === w.resets_at;
    const samePc = (cycle.judged_by ?? null) === p.collector;
    if (fetched === null) return;
    if (cycle.judged_by === undefined && judged !== null) {
      // A state written by an earlier Worker (no judged_by): its fetch time may be in a PC's clock ahead of
      // the real one, so times aren't compared. The same value is the same fetch: its time and PC are taken over (from then on it is
      // compared like a current state) without events. Another value is judged (notified keys are kept)
      if (sameValue) {
        cycle.judged_at = w.fetched_at;
        cycle.judged_by = p.collector;
        cycle.judged_exact = true;
        return;
      }
    } else if (judged !== null) {
      const sameFetch = samePc && sameValue && (cycle.judged_exact === true ? fetched === judged : fetched - judged <= SAME_FETCH_MS);
      if (fetched < judged || sameFetch) return;
    }
    cycle.judged_at = w.fetched_at;
    cycle.judged_used = w.used_percent;
    cycle.judged_reset = w.resets_at;
    cycle.judged_by = p.collector;
    cycle.judged_exact = true;

    // Limit reached: when any window, overall or per-model / per-group, reaches 100%
    if (w.used_percent >= 100) {
      // If already notified windowless during the same block, don't repeat when windows come back. If notified via another window, notify this one
      const announced = overall && p.blocked === true && next.blocked[id] === WINDOWLESS;
      add(`limit:${pk(id)}:${w.id}:${cycle.cycle}`, !announced, {
        ...windowBody("limit", id, w, cycle.cycle), blocked: overall ? p.blocked : null,
      }, cycle);
      if (overall) {
        for (const t of o.thresholds) {
          add(`threshold:${pk(id)}:${w.id}:${cycle.cycle}:${t}`, false,
            { ...windowBody("threshold", id, w, cycle.cycle), threshold: t }, cycle);
        }
        cycle.alerted = true;
        if (p.blocked === true) next.blocked[id] = w.id;
      }
      return;
    }
    if (!overall) return;

    // Thresholds: show only the largest one crossed
    const crossed = o.thresholds.filter((t) => w.used_percent >= t).sort((a, b) => b - a);
    crossed.forEach((t, i) => add(`threshold:${pk(id)}:${w.id}:${cycle.cycle}:${t}`, i === 0, {
      ...windowBody("threshold", id, w, cycle.cycle), threshold: t,
    }, cycle));
    if (crossed.length > 0) cycle.alerted = true;

    const trusted = w.confidence !== null && TRUSTED.includes(w.confidence);
    // Limit soon: at the faster rate the limit comes before the reset. Show only the smallest minutes crossed
    const eta = w.eta_fast_minutes;
    if (trusted && w.reset_first === false && eta !== null) {
      const soon = o.soonMinutes.filter((m) => eta <= m).sort((a, b) => a - b);
      soon.forEach((m, i) => add(`soon:${pk(id)}:${w.id}:${cycle.cycle}:${m}`, i === 0, {
        ...windowBody("soon", id, w, cycle.cycle), threshold: m,
      }, cycle));
    }
    // Sudden consumption (once per cycle)
    if (trusted && w.anomalous === true) {
      add(`anomalous:${pk(id)}:${w.id}:${cycle.cycle}`, true, windowBody("anomalous", id, w, cycle.cycle), cycle);
    }
  }

  /** The previous cycle ended. For a notified overall window, create a reset (not if an estimated one was already created) */
  function resetEvent(id: ProviderId, w: WindowView, previous: CycleState, idle: boolean) {
    if (w.scope === null && previous.alerted && !previous.reset_sent) {
      add(`reset:${pk(id)}:${w.id}:${previous.cycle}`, true, {
        ...windowBody("reset", id, w, previous.cycle), confirmed: true,
        ...(idle ? { resets_at: null } : {}),
      });
    }
  }
}
