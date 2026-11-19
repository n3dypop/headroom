// Headroom's iPhone widget (Scriptable).
//
// - Reads GET /v2/view from the server and draws 0-100% bars for the 5-hour, weekly and other limits. Recent consumption is gray inside the bar
// - Credentials (the server origin and the Worker read token) are kept only in Scriptable's
//   Keychain, never in the script body, URLs, logs or the saved view. On first use, run it in the app and enter them
// - The widget parameter chooses which limits to show: empty (overall limits of both providers), claude, codex, top,
//   claude.five_hour,codex.seven_day (a list of window keys)
// - When fetching fails, shows the previous view (saved on the device; only the needed fields, no account info) marked as old
// - Staleness and "reset (estimated)" are recomputed at draw time (the widget may be shown later than it was fetched)
//
// From here down to "Widget rendering below" everything is a pure function that doesn't use the Scriptable API (tested with Node).
// Startup is at the end (main runs after all constants are defined)

const HEADROOM_VERSION = 53;
/** View version this script can read (VIEW_VERSION in packages/core) */
const VIEW_VERSION = 1;
/** Settings are stored as JSON in a single Keychain item (so the server and credentials are always read as a pair) */
const KEYCHAIN_CONFIG = "headroom.config";
/** Items from older versions (moved into the single item and deleted when saving in the app; Access items are deleted unread, since Access support was removed) */
const KEYCHAIN_LEGACY = {
  url: "headroom.url",
  token: "headroom.token",
  accessId: "headroom.access_id",
  accessSecret: "headroom.access_secret",
};
/** Desired refresh interval (iOS decides the actual interval) */
const REFRESH_MINUTES = 15;
/** Staleness thresholds for values (same as freshness.ts in packages/core) */
const FRESH_MAX_MINUTES = 15;
const CAUTION_MAX_MINUTES = 60;
/** Rows shown per provider group (two groups side by side / a single group) */
const MAX_WINDOWS = { small: 2, medium: 2, large: 3, extraLarge: 3, accessoryRectangular: 2 };
const MAX_WINDOWS_SINGLE = { small: 3, medium: 4, large: 6, extraLarge: 6 };
/** Padding (points; the same on all four sides) */
const PADDING = { small: 13, medium: 14, large: 16, extraLarge: 16, accessoryRectangular: 0, accessoryCircular: 0, accessoryInline: 0 };
/**
 * iPhone home screen widget sizes (points; from the Widgets table in Apple's Human Interface Guidelines).
 * Per screen width. For a width not in the table, use the closest row below it (draws slightly smaller, never overflows)
 */
const WIDGET_SIZES = [
  { screen: [430, 932], small: [170, 170], medium: [364, 170], large: [364, 382] },
  { screen: [428, 926], small: [170, 170], medium: [364, 170], large: [364, 382] },
  { screen: [414, 896], small: [169, 169], medium: [360, 169], large: [360, 379] },
  { screen: [414, 736], small: [159, 159], medium: [348, 157], large: [348, 357] },
  { screen: [393, 852], small: [158, 158], medium: [338, 158], large: [338, 354] },
  { screen: [390, 844], small: [158, 158], medium: [338, 158], large: [338, 354] },
  { screen: [375, 812], small: [155, 155], medium: [329, 155], large: [329, 345] },
  { screen: [375, 667], small: [148, 148], medium: [321, 148], large: [321, 324] },
  { screen: [360, 780], small: [155, 155], medium: [329, 155], large: [329, 345] },
  { screen: [320, 568], small: [141, 141], medium: [292, 141], large: [292, 311] },
];
/**
 * The widget { width, height } for this size, from the screen size ({ width, height }; either orientation).
 * If the screen is not in the table, the largest row whose width and height are both at most the screen's (never overflows). If unknown, the 390×844 row
 */
function widgetSize(family, screen) {
  const key = family === "extraLarge" ? "large" : family;
  let row = WIDGET_SIZES.find((r) => r.screen[0] === 390 && r.screen[1] === 844);
  if (screen && Number.isFinite(screen.width) && Number.isFinite(screen.height)) {
    const w = Math.min(screen.width, screen.height);
    const h = Math.max(screen.width, screen.height);
    const exact = WIDGET_SIZES.find((r) => r.screen[0] === w && r.screen[1] === h);
    const fits = WIDGET_SIZES.filter((r) => r.screen[0] <= w && r.screen[1] <= h)
      .sort((a, b) => b.screen[0] - a.screen[0] || b.screen[1] - a.screen[1]);
    row = exact ?? fits[0] ?? WIDGET_SIZES[WIDGET_SIZES.length - 1];
  }
  const [width, height] = row[key] ?? row.medium;
  return { width, height };
}
/**
 * Items shown per size.
 * 5h, weekly limits, recent consumption (gray), the amount likely used before reset (forecast, drawn lighter inside the bar) and icons are shown at every size.
 * reset: reset (↻ and timer) / marks: confidence marks (approx., est.) / plan: plan / pace: consumption rate /
 * forecastTime: if it will likely run out, replace the reset time in the time row with the run-out time (⚠) / scoped: always show per-model and per-group limits / trend: 7-day weekly trend /
 * freshness: value freshness dot (with elapsed time when old)
 */
const SIZE_CONTENT = {
  small: { reset: false, marks: false, plan: false, pace: false, forecastTime: false, scoped: false, trend: false, freshness: true },
  medium: { reset: true, marks: true, plan: true, pace: false, forecastTime: true, scoped: false, trend: false, freshness: true },
  large: { reset: true, marks: true, plan: true, pace: true, forecastTime: true, scoped: true, trend: true, freshness: true },
};
SIZE_CONTENT.extraLarge = SIZE_CONTENT.large;
/** Provider colors (Claude orange, Codex blue-violet to match its icon). Fixed colors because they are also passed to DrawContext */
const BRAND_COLORS = { claude: "#D97757", codex: "#6E7CF7" };
/** Wording when there is no 5-hour limit */
const NOT_AVAILABLE = "Not available";
/** Order of providers (from the left / top; Codex first) */
const PROVIDER_ORDER = ["codex", "claude"];
/**
 * Usage warning mark. The only warning is "likely to run out before reset" (a low remaining amount is fine if it won't run out).
 * Conveyed with a monochrome ⚠ and text, not color (bars use only the provider color and gray). Medium, large and the lock screen rectangle show ⚠ and the run-out time
 * in place of the reset time in the time row; small, which has no time row, puts ⚠ before the remaining number
 */
// Add the text variation selector (U+FE0E). Without it iOS may draw a yellow emoji
const WARN_MARK = "⚠︎";
/**
 * Icon images (base64 PNG). Not kept in the repository (they are the vendors' logos). scripts/build.ts embeds
 * packages/scriptable/icons/<provider>.png and writes dist/Headroom.js. If empty, SF Symbols are used instead
 */
const ICONS = { claude: "", codex: "" }; // @icons

/** Accept only the server origin (https://host[:port]). No path, userinfo, query or fragment */
function normalizeBaseUrl(raw) {
  const text = String(raw ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i.test(text)
    ? text.toLowerCase()
    : null;
}

/** Request for the view. Credentials go only in headers */
function buildRequest(cfg, timeZone) {
  const base = normalizeBaseUrl(cfg.url);
  if (!base || !cfg.token) return null;
  // Send a User-Agent (so the workers.dev Browser Integrity Check doesn't block the default one)
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/json", "User-Agent": "headroom-scriptable" };
  return { url: `${base}/v2/view?tz=${encodeURIComponent(timeZone || "Asia/Tokyo")}`, headers };
}

/** Validate setup input (the server's https origin and the read token) */
function validateSetup(input) {
  const url = normalizeBaseUrl(input.url);
  const token = String(input.token ?? "").trim();
  if (!url) return { error: "Enter an https:// URL with the host name only (no path)" };
  if (!token) return { error: "Enter the read token" };
  return { url, token };
}

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" };
/** Plan display names (KNOWN_PLANS in packages/core) */
const PLAN_NAMES = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", max: "Max", ultra: "Ultra",
  team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu",
};
/** Reasons for a missing value (ErrorCode in packages/core) */
const ERROR_NAMES = {
  login_required: "Sign in required", not_installed: "Not installed", fetch_failed: "Couldn't fetch",
  safety_stop: "Paused for safety", account_changed: "Account changed, paused",
};
/** Short display names for some scopes (names from KNOWN_SCOPES in packages/core) */
const SCOPE_NAMES = { "Codex extra": "Extra", codex_other: "Other" };
const PROVIDER_STATUSES = ["ok", "stale", "error", "unavailable"];
const str = (v, max = 80) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);
const ID = /^[a-z0-9_]{1,64}$/;

function sanitizeWindow(w) {
  if (!w || typeof w !== "object" || !ID.test(String(w.id)) || num(w.used_percent) === null) return null;
  return {
    id: w.id,
    label: str(w.label, 24) ?? w.id,
    scope: str(w.scope, 32),
    used_percent: w.used_percent,
    recent_consumed_percent: num(w.recent_consumed_percent),
    recent_quality: oneOf(w.recent_quality, ["exact", "approx", "unknown"]) ?? "unknown",
    confidence: oneOf(w.confidence, ["high", "medium", "low", "insufficient"]),
    fetched_at: str(w.fetched_at, 40),
    resets_at: str(w.resets_at, 40),
    // Forecast and consumption rate (derived values computed by Cron; used for the forecast and rate display)
    eta_at: str(w.eta_at, 40),
    reset_first: typeof w.reset_first === "boolean" ? w.reset_first : null,
    rate_60m: num(w.rate_60m),
    rate_24h: num(w.rate_24h),
    eta_minutes: num(w.eta_minutes),
    rate_15m: num(w.rate_15m),
    // Rate used for the forecast (the server's rate_pace; undefined from older servers without the field)
    ...("rate_pace" in w ? { rate_pace: num(w.rate_pace) } : {}),
  };
}

/** Provider part. undefined if malformed (the whole response is invalid). null means "no value for that provider" */
function sanitizeProvider(p) {
  if (p === null || p === undefined) return null;
  if (typeof p !== "object" || Array.isArray(p) || !p.windows || typeof p.windows !== "object" || Array.isArray(p.windows)) {
    return undefined;
  }
  // If any window is invalid, the whole response is invalid (don't drop just that window and save an empty view)
  const windows = {};
  for (const [id, w] of Object.entries(p.windows)) {
    const clean = sanitizeWindow(w);
    if (!clean || clean.id !== id) return undefined;
    windows[id] = clean;
  }
  // The window list must match the windows exactly without duplicates, and the overall-limit list must match the windows whose scope is null
  const ids = (v) => String(v ?? "").split(",").filter(Boolean);
  const main = ids(p.main_window_ids);
  const all = ids(p.window_ids);
  const sameSet = (list, expected) =>
    new Set(list).size === list.length && list.length === expected.length && expected.every((id) => list.includes(id));
  const keys = Object.keys(windows);
  if (!sameSet(all, keys) || !sameSet(main, keys.filter((id) => windows[id].scope === null))) return undefined;
  return {
    status: oneOf(p.status, PROVIDER_STATUSES),
    plan: oneOf(p.plan, Object.keys(PLAN_NAMES)),
    error_code: oneOf(p.error_code, Object.keys(ERROR_NAMES)),
    main_window_ids: main, window_ids: all, windows,
  };
}

/**
 * Validate the server response and keep only the fields needed for display (also the saved shape; extra fields and unknown versions are neither saved nor shown).
 * null if unreadable
 */
function sanitizeView(body) {
  if (!body || typeof body !== "object" || body.view_version !== VIEW_VERSION) return null;
  if (!("claude" in body) || !("codex" in body)) return null;
  const claude = sanitizeProvider(body.claude);
  const codex = sanitizeProvider(body.codex);
  // A valid response with both null (no values, or the previous account's values were removed) is a success and replaces the previous view
  if (claude === undefined || codex === undefined) return null;
  // Number of the data read (compared with the previous view to tell which is newer; the order of the data, not when the response was made)
  const dataVersion = body.data_version;
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) return null;
  return { view_version: VIEW_VERSION, data_version: dataVersion, boundaries: sanitizeBoundaries(body.boundaries), claude, codex };
}

/** Per-provider boundary stamp (time and sequence number only). null if malformed (falls back to not showing the trend) */
const STAMP = /^([0-9TZ:.\-]{0,40}#\d{1,15})?$/;
function sanitizeBoundaries(b) {
  if (!b || typeof b !== "object") return null;
  if (typeof b.claude !== "string" || typeof b.codex !== "string" || !STAMP.test(b.claude) || !STAMP.test(b.codex)) return null;
  return { claude: b.claude, codex: b.codex };
}

/** Minutes -> "13m", "2h 13m", "3d 4h" */
function formatDuration(minutes) {
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

/**
 * The window at draw time (staleness and "reset (estimated)" recomputed). If the reset time has passed, 0% (estimated),
 * without the previous cycle's recent consumption (gray). Labels follow the same order as statusText in packages/core (wording in English)
 */
function atDisplayTime(w, now) {
  const reset = Date.parse(w.resets_at ?? "");
  const passed = Number.isFinite(reset) && reset <= now.getTime();
  const fetched = Date.parse(w.fetched_at ?? "");
  const age = Number.isFinite(fetched) ? Math.max(0, Math.floor((now.getTime() - fetched) / 60000)) : null;
  const status = passed ? "reset_estimated"
    : age === null ? null
    : age <= FRESH_MAX_MINUTES ? "fresh" : age <= CAUTION_MAX_MINUTES ? "stale" : "old";
  const used = passed ? 0 : w.used_percent;
  const recentQuality = passed ? "unknown" : w.recent_quality;
  const valueText = status === "stale" ? `${WARN_MARK} ${formatDuration(age)} ago`
    : status === "old" ? `Old (${formatDuration(age)} ago)`
    : status === "reset_estimated" ? "Reset (estimated)"
    : status === null ? "Fetch time unknown" : "";
  const recentText = recentQuality === "unknown" ? "Recent: no data" : recentQuality === "approx" ? "Recent: approx." : "";
  const forecastText = passed ? "" : w.confidence === "insufficient" ? "Forecast: no data" : w.confidence === "low" ? "Forecast: rough" : "";
  const usedInt = Math.round(used);
  return {
    ...w,
    used_percent: used,
    used_percent_int: usedInt,
    remaining_percent_int: Math.max(0, Math.min(100, 100 - usedInt)),
    remaining_percent: Math.max(0, Math.min(100, 100 - used)),
    recent_consumed_percent: passed ? null : w.recent_consumed_percent,
    recent_quality: recentQuality,
    reset_passed: passed,
    value_status: status,
    age_minutes: age,
    status_text: [valueText, recentText, forecastText].filter(Boolean).join(" · "),
  };
}

/** Short mark (lock screen; stacks the reset estimate and staleness. Approximate values get no mark) */
function shortMark(w) {
  const marks = [];
  if (w.value_status === "reset_estimated") marks.push("est.");
  else if (w.value_status === "old") marks.push("old");
  else if (w.value_status === "stale") marks.push(`${formatDuration(w.age_minutes)} ago`);
  else if (w.value_status === null) marks.push("time?");
  return marks.join(" · ");
}

/**
 * Choose the windows to show. Returns a list of { provider, providerName, window } in display order; windows are recomputed at draw time.
 * By default both providers' overall limits (main_window_ids) come first; per-model and per-group limits are appended only at 100%
 */
function selectWindows(view, parameter, now) {
  const param = String(parameter ?? "").trim().toLowerCase();
  const out = [];
  const push = (provider, id) => {
    const w = view?.[provider]?.windows?.[id];
    if (w && !out.some((x) => x.provider === provider && x.window.id === id)) {
      out.push({ provider, providerName: PROVIDER_NAMES[provider], window: atDisplayTime(w, now) });
    }
  };
  const main = (provider) => {
    for (const id of view?.[provider]?.main_window_ids ?? []) push(provider, id);
  };
  const full = (provider) => {
    for (const id of view?.[provider]?.window_ids ?? []) {
      const w = view[provider].windows[id];
      if (w.scope !== null && atDisplayTime(w, now).used_percent >= 100) push(provider, id);
    }
  };
  if (param === "top") {
    for (const provider of PROVIDER_ORDER) {
      const p = view?.[provider];
      if (!p) continue;
      const ids = p.main_window_ids.length > 0 ? p.main_window_ids : p.window_ids;
      const top = ids.reduce((a, id) => {
        const w = atDisplayTime(p.windows[id], now);
        return a === null || w.used_percent > a.used ? { id, used: w.used_percent } : a;
      }, null);
      if (top) push(provider, top.id);
    }
  } else if (param.includes(".")) {
    for (const key of param.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [provider, id] = key.split(".");
      if (provider === "claude" || provider === "codex") push(provider, id);
    }
  } else if (param === "claude" || param === "codex") {
    main(param);
    full(param);
  } else {
    for (const provider of PROVIDER_ORDER) main(provider);
    for (const provider of PROVIDER_ORDER) full(provider);
  }
  return out;
}

/**
 * Per-provider group (the display unit for medium, large and small). Each row is a window or a "no 5h limit" marker.
 * "No 5h limit" is shown only when that provider's values were fetched (ok, stale) and it has overall limits but no 5h limit
 * (not when fetching failed). Not shown when the parameter names windows, or with top
 */
function groupsOf(view, parameter, now, options = {}) {
  const param = String(parameter ?? "").trim().toLowerCase();
  const items = selectWindows(view, param, now);
  const listed = param === "" ? [...PROVIDER_ORDER] : param === "claude" || param === "codex" ? [param] : [];
  const order = [...listed];
  for (const x of items) if (!order.includes(x.provider)) order.push(x.provider);
  const groups = [];
  for (const provider of order) {
    const p = view?.[provider] ?? null;
    const rows = items.filter((x) => x.provider === provider).map((x) => ({ kind: "window", window: x.window }));
    // Always show per-model and per-group limits (large): append them after the overall limits even below 100%
    if (options.allScoped && listed.includes(provider) && p) {
      for (const id of p.window_ids) {
        if (p.windows[id].scope !== null && !rows.some((r) => r.window.id === id)) {
          rows.push({ kind: "window", window: atDisplayTime(p.windows[id], now) });
        }
      }
    }
    const canTellMissing = listed.includes(provider) && p && (p.status === "ok" || p.status === "stale");
    if (canTellMissing && p.main_window_ids.length > 0 && !p.main_window_ids.includes("five_hour")) {
      rows.unshift({ kind: "missing", text: NOT_AVAILABLE });
    }
    groups.push({
      provider,
      name: PROVIDER_NAMES[provider],
      plan: p?.plan ? PLAN_NAMES[p.plan] ?? null : null,
      message: !p ? "No data" : rows.length === 0 ? ERROR_NAMES[p.error_code] ?? "No limits to show" : null,
      rows,
    });
  }
  return groups;
}

/**
 * Bar segments (0-1). remaining is what's left (filled from the left); recent is the recently consumed part of used (gray, right after remaining).
 * No gray when recent consumption is "unknown". Old values fade the bar
 */
function barSegments(window) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const used = clamp((Number(window.used_percent) || 0) / 100);
  const known = window.recent_quality !== "unknown" && typeof window.recent_consumed_percent === "number";
  const recent = known ? Math.min(used, clamp(window.recent_consumed_percent / 100)) : 0;
  return { remaining: 1 - used, recent, faded: window.value_status === "old" };
}

/** Fill widths of the bar (pixels). Remaining is 0..remainingEnd, recent consumption remainingEnd..recentEnd (proportional) */
function barWidths(segments, width) {
  const remainingEnd = segments.remaining * width;
  return { remainingEnd, recentEnd: Math.min(width, remainingEnd + segments.recent * width) };
}

/**
 * The amount likely used before reset (the forecast drawn in the bar): of the remaining R (%), what will be used before reset at the current rate.
 * If it will run out before reset, runsOut (uses all of R). Only when forecast confidence is high or medium (otherwise null)
 */
function projectionOf(w, now) {
  if (w.reset_passed || w.used_percent >= 100) return null;
  if (w.confidence !== "high" && w.confidence !== "medium") return null;
  const remaining = Math.max(0, 100 - w.used_percent);
  const reset = Date.parse(w.resets_at ?? "");
  if (!Number.isFinite(reset) || reset <= now.getTime()) return null;
  // Derived values in the old format (no rate_pace field) draw no forecast
  if (!("rate_pace" in w)) return null;
  const pace = paceOf(w);
  // Rate too small to measure: nothing will be used before reset
  if (pace === null) return { consume: 0, runsOut: false, at: null };
  const perMinute = pace / 60;
  // Whether it runs out is decided as remaining / rate from when the value was fetched (from draw time if the fetch time is unknown)
  const observed = Date.parse(w.fetched_at ?? "");
  const from = Number.isFinite(observed) ? observed : now.getTime();
  // Round the time to run-out to whole milliseconds before comparing, like the server (core) does (a tie counts as lasting)
  const at = from + Math.round((remaining / perMinute) * 60000);
  if (at < reset) {
    // A forecast whose run-out time has passed (with no later observation) is stale, so don't draw it
    return at <= now.getTime() ? null : { consume: remaining, runsOut: true, at };
  }
  // Lasts until reset: the amount likely used from draw time until reset
  return { consume: Math.min(remaining, perMinute * ((reset - now.getTime()) / 60000)), runsOut: false, at: null };
}

/**
 * Rate used for the forecast (%/h). Uses the rate the server used for its forecast (rate_pace, unrounded) as is.
 * null for old-format derived values without the field (before the server recomputes them; no forecast is drawn)
 */
function paceOf(w) {
  return typeof w.rate_pace === "number" && Number.isFinite(w.rate_pace) && w.rate_pace > 0 ? w.rate_pace : null;
}

/** Values drawn in the bar: remaining and recent consumption (gray), plus the amount likely used before reset (projected) */
function barSegmentsAt(window, now) {
  const s = barSegments(window);
  const p = projectionOf(window, now);
  return { ...s, projected: p ? Math.min(s.remaining, p.consume / 100) : 0, runsOut: Boolean(p?.runsOut) };
}

/**
 * Bar fills (from the left): the part of remaining likely left after reset (solid color), the part likely used before reset (lighter color,
 * the same even if it will run out), and recent consumption (gray). Only the provider color and gray are used. Each piece's right end is rounded and the next piece's left end is concave along that curve
 */
function barPieces(segments, width, height, brandHex) {
  const widths = barWidths(segments, width);
  const { remainingEnd, recentEnd } = drawnJunction(widths.remainingEnd, Math.min(width, widths.recentEnd), height, width);
  const projected = Math.min(remainingEnd, (segments.projected ?? 0) * width);
  const solidEnd = remainingEnd - projected;
  const main = brandHex;
  const alpha = segments.faded ? 0.35 : 1;
  const pieces = [
    { x: 0, w: solidEnd, hex: main, alpha },
    { x: solidEnd, w: projected, hex: main, alpha: alpha * 0.35 },
    { x: remainingEnd, w: recentEnd - remainingEnd, hex: BAR_COLORS.recent, alpha },
  ].filter((p) => p.w > 0.01);
  // Make the first piece at least as wide as the bar height (if thinner, its left rounding is smaller than the track's and sticks out of the track).
  // Shift later pieces right by the added amount, and shorten the last pieces by whatever goes past the bar's right end
  const minFirst = Math.min(height, width);
  if (pieces.length > 0 && pieces[0].w < minFirst) {
    pieces[0].w = minFirst;
    // Trim the overflow from later pieces: the likely-used part (lighter color) first, gray only down to its minimum width (radius + 1pt)
    let over = pieces.reduce((sum, p) => sum + p.w, 0) - width;
    for (const p of pieces.slice(1)) {
      if (over <= 0) break;
      const floor = p.hex === BAR_COLORS.recent ? Math.min(p.w, height / 2 + 1) : 0;
      const cut = Math.min(over, p.w - floor);
      p.w -= cut;
      over -= cut;
    }
    let x = 0;
    for (const p of pieces) {
      p.x = x;
      x += p.w;
    }
    for (let i = pieces.length - 1; i > 0; i--) if (pieces[i].w <= 0.01) pieces.splice(i, 1);
  }
  // Round every right end. The first piece also has a rounded left end; later pieces are concave along the previous piece's curve
  const out = [];
  for (const [i, p] of pieces.entries()) {
    const rightCap = i === 0 ? Math.min(height / 2, p.w / 2) : Math.min(height / 2, p.w);
    const leftCap = i === 0 ? rightCap : out[i - 1].rightCap;
    out.push({ ...p, leftCap, rightCap, concaveLeft: i > 0 });
  }
  return out;
}

/** Freshness of a provider's values (the header dot), by time since fetch: fresh, caution (over 15 min), old (over 60 min) */
function freshnessOf(view, provider, now, ids = null) {
  const p = view?.[provider];
  const list = ids ?? (p?.main_window_ids?.length ? p.main_window_ids : Object.keys(p?.windows ?? {}));
  let oldest = null;
  for (const id of list) {
    const t = Date.parse(p?.windows?.[id]?.fetched_at ?? "");
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  if (oldest === null) return { level: "unknown", text: "" };
  const age = Math.max(0, Math.floor((now.getTime() - oldest) / 60000));
  if (age <= FRESH_MAX_MINUTES) return { level: "fresh", text: "" };
  return { level: age <= CAUTION_MAX_MINUTES ? "stale" : "old", text: formatDuration(age) };
}

/** Short form of the reset: a running timer within 24 hours, "Fri 9 AM" beyond that. null if passed */
function resetShort(window, now) {
  const date = resetDate(window, now);
  return date ? whenShort(date, now) : null;
}

/** Short time form: countdown (H:MM:SS) within 24 hours, weekday and time (Fri 4 PM) beyond that */
function whenShort(date, now) {
  if (date.getTime() - now.getTime() <= 24 * 60 * 60000) return { kind: "timer", date };
  return { kind: "text", text: clockText(date, now) };
}

/**
 * Time shown in the time row: if it will run out before reset, show the run-out time in place of the reset time,
 * in the same form, and replace the ↻ symbol with ⚠ (warn). "Soon" if less than a minute is left until run-out
 * (the widget cannot be redrawn sooner than a minute later). Otherwise the reset time
 */
function timeShort(window, now) {
  const p = projectionOf(window, now);
  if (p?.runsOut && p.at) {
    if (p.at - now.getTime() < 60000) return { warn: true, kind: "text", text: "Soon" };
    return { warn: true, ...whenShort(new Date(p.at), now) };
  }
  const reset = resetShort(window, now);
  return reset ? { warn: false, ...reset } : null;
}

/** Symbols for the time row (SF Symbols; both monochrome, tinted with the text color) */
const TIME_SYMBOLS = { reset: "arrow.clockwise", warn: "exclamationmark.triangle" };

/** Short row mark (only reset (estimated); staleness is shown by the header dot and approximations get no mark) */
function rowMark(w) {
  return w.value_status === "reset_estimated" ? "est." : "";
}

/** Name of the window length (5h, Weekly, Monthly, 90m, ...). Scoped ids (seven_day_fable, codex_other_seven_day) are also named by their length part */
function windowName(w) {
  const id = String(w.id);
  if (id.includes("five_hour")) return "5h";
  if (id.includes("seven_day")) return "Weekly";
  if (id.includes("monthly")) return "Monthly";
  if (id.includes("primary")) return "Primary";
  if (id.includes("secondary")) return "Secondary";
  const m = /window_(\d+)m/.exec(id);
  if (m) {
    const n = Number(m[1]);
    return n % 1440 === 0 ? `${n / 1440}d` : n % 60 === 0 ? `${n / 60}h` : `${n}m`;
  }
  return String(w.label ?? id);
}

/** Row heading (e.g. 5h limit, Weekly limit · Opus) */
function limitLabel(w) {
  const scope = w.scope ? SCOPE_NAMES[w.scope] ?? w.scope : null;
  // Per-model and per-group limits are short (e.g. Fable weekly) so long headings that don't fit the column aren't cut off
  return scope ? `${scope} ${windowName(w).toLowerCase()}` : `${windowName(w)} limit`;
}

/** Limit name in the heading of the lock screen rectangle (e.g. 5h, Weekly, Fable weekly) */
function limitName(w) {
  const scope = w.scope ? SCOPE_NAMES[w.scope] ?? w.scope : null;
  return scope ? `${scope} ${windowName(w).toLowerCase()}` : windowName(w);
}

/** Short name for the lock screen (e.g. 5h, Wk, Mo) */
function shortName(w) {
  const name = windowName(w);
  const short = name === "Weekly" ? "Wk" : name === "Monthly" ? "Mo" : name;
  const scope = w.scope ? SCOPE_NAMES[w.scope] ?? w.scope : null;
  return scope ? `${short} ${scope}` : short;
}

/** Remaining text (e.g. 78%; 0% when the limit is reached) and the short form for the lock screen (e.g. 78%) */
function percentText(window) {
  // Just the remaining number (the bar fills the remaining part from the left, so no "left")
  return remainingText(window);
}
function compactPercent(window) {
  return remainingText(window);
}

/** Remaining number: 0% when the limit is reached, one decimal place below 1% (e.g. 0.4%), otherwise an integer */
function remainingText(window) {
  if (window.used_percent >= 100) return "0%";
  // Absorb floating-point error such as 100 - 99.7 = 0.29999... before truncating
  const raw = typeof window.remaining_percent === "number" ? window.remaining_percent : 100 - window.used_percent;
  // Decide "below 1%" from the unrounded remaining, and show at least 0.1% (never 0% while something remains, even at 99.9996% used)
  if (raw > 0 && raw < 1) return `${Math.max(0.1, Math.floor((Math.round(raw * 1000) / 1000) * 10) / 10)}%`;
  return `${window.remaining_percent_int}%`;
}

/** One line on the lock screen (only the windows chosen by the parameter) */
/** Estimated width of the lock screen line (the narrowest device) */
const INLINE_WIDTH = 225;

/**
 * One line on the lock screen. Until the full text (including the demo prefix) fits: shorten the staleness mark (26m ago -> 26m) -> drop it ->
 * shorten scoped limit names (Wk Fable -> Fable) -> shorten the reset estimate to "~100%" -> drop limit names (5h, Wk) -> drop scoped names too.
 * The ⚠ for failed updates, the remaining value and the reset-estimate mark are kept
 */
function inlineText(items, cached, prefix = "") {
  const build = (step) => {
    const body = items.map((x) => {
      if (x.missing) return `${x.providerName} ${x.label.startsWith("5h:") ? "5h N/A" : x.label}`;
      const full = shortMark(x.window);
      const est = full.includes("est.") ? "est." : "";
      const mark = step === 0 ? full : step === 1 ? full.replace(/ ago$/, "") : step <= 3 ? est : "";
      const scope = x.window.scope ? SCOPE_NAMES[x.window.scope] ?? x.window.scope : null;
      const name = step >= 6 ? "" : step >= 3 && scope ? scope : step >= 5 ? "" : shortName(x.window);
      const value = step >= 4 && est ? `~${compactPercent(x.window)}` : compactPercent(x.window);
      return [x.providerName, name, value].filter(Boolean).join(" ") + (mark ? ` (${mark})` : "");
    }).join(" · ") || "Headroom";
    return `${prefix}${cached ? `${WARN_MARK} ${body}` : body}`;
  };
  const tries = [0, 1, 2, 3, 4, 5, 6].map(build);
  return tries.find((s) => textWidth(s, 11) <= INLINE_WIDTH) ?? tries[tries.length - 1];
}

/** Time used for the reset timer (null if passed) */
function resetDate(window, now) {
  if (!window.resets_at || window.reset_passed) return null;
  const t = Date.parse(window.resets_at);
  return Number.isFinite(t) && t > now.getTime() ? new Date(t) : null;
}

/** Heading when fetching failed (credentials and error bodies are not shown) */
function errorText(status) {
  if (status === 401 || status === 403) return "Check your credentials";
  if (status === 404) return "No data yet";
  if (status === 503) return "Server is temporarily unavailable";
  if (status === 200) return "Couldn't read the response";
  if (status === 0) return "Can't reach the server";
  return `Server error (${status})`;
}

/** Notice when showing the previous view (based on when it was saved) */
function cachedNote(savedAtIso, now) {
  const t = Date.parse(savedAtIso || "");
  if (!Number.isFinite(t)) return `${WARN_MARK} Can't update · showing last data`;
  const minutes = Math.max(0, Math.round((now.getTime() - t) / 60000));
  return `${WARN_MARK} Can't update · data from ${formatDuration(minutes)} ago`;
}

/** Short time form ("6:10 PM" within 24 hours, "Fri 6:10 PM" beyond that) */
function clockText(date, now) {
  const soon = date.getTime() - now.getTime() <= 24 * 60 * 60000;
  try {
    return new Intl.DateTimeFormat("en-US", soon ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date);
  } catch (_) {
    return date.toISOString().slice(soon ? 11 : 5, 16).replace("T", " ");
  }
}

/** Consumption rate (%/h): the last 60 minutes for the 5-hour limit, the last 24 hours otherwise. null if it can't be measured */
function paceText(w) {
  if (w.reset_passed || w.confidence === "insufficient") return null;
  const rate = String(w.id).includes("five_hour") ? w.rate_60m ?? w.rate_24h : w.rate_24h ?? w.rate_60m;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return null;
  return `${rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate)}%/h`;
}

/**
 * Validate the history response (GET /v2/history) and keep only one window's points. null if malformed.
 * Points are { at (ms), used (0-100), brk (don't connect the line to the previous point) } (last `hours` hours, up to 500 points; default is the weekly limit's 7 days)
 */
function sanitizeHistory(body, provider, windowId, now, hours = TREND_HOURS) {
  if (!body || typeof body !== "object" || body.provider !== provider || !body.windows || typeof body.windows !== "object") return null;
  const list = body.windows[windowId];
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 5000) return null;
  const since = now.getTime() - hours * 60 * 60000;
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== "object" || typeof p.at !== "string" || !Object.prototype.hasOwnProperty.call(p, "break")) return null;
    const at = Date.parse(p.at);
    const used = num(p.used_percent);
    if (!Number.isFinite(at) || used === null || used < 0 || used > 100) return null;
    const brk = p.break;
    if (brk !== null && brk !== "gap" && brk !== "reset") return null;
    if (at < since || at > now.getTime() + 60000) continue;
    out.push({ at, used, brk: brk !== null });
  }
  out.sort((a, b) => a.at - b.at);
  return thinPoints(out, 240);
}

/**
 * Thin the points to at most max. Picks evenly, including the first and last; a break on a dropped point carries over to the next picked point
 * (so lines are never connected across a break)
 */
function thinPoints(points, max) {
  if (points.length <= max) return points;
  const picked = [];
  for (let k = 0; k < max; k++) picked.push(Math.round((k * (points.length - 1)) / (max - 1)));
  const out = [];
  let prev = -1;
  for (const i of [...new Set(picked)]) {
    let brk = false;
    for (let j = prev + 1; j <= i; j++) brk = brk || points[j].brk;
    out.push({ ...points[i], brk: out.length === 0 ? points[i].brk : brk });
    prev = i;
  }
  return out;
}

/** Vertical coordinate in the trend (0-100% -> height with a pad margin top and bottom; same calculation for points and guide lines) */
function trendY(used, height, inset = 0) {
  const pad = Math.max(1.5, inset);
  return Math.round((pad + (1 - used / 100) * (height - 2 * pad)) * 10) / 10;
}

/** Polyline of the 7-day weekly trend: point lists (pixels) split at each break (gap or reset) */
function sparkLines(points, now, width, height, inset = 0, hours = TREND_HOURS, range = null) {
  // The x axis: the given range (e.g. this week), or the last `hours` up to now
  const span = range ? range.end - range.start : hours * 60 * 60000;
  const since = range ? range.start : now.getTime() - span;
  const lines = [];
  let current = [];
  for (const p of points) {
    // Points outside the range aren't drawn (they would pile up at an edge)
    if (range && (p.at < range.start || p.at >= range.end)) continue;
    if (p.brk && current.length > 0) {
      lines.push(current);
      current = [];
    }
    const x = inset + Math.max(0, Math.min(width - 2 * inset, ((p.at - since) / span) * (width - 2 * inset)));
    current.push([Math.round(x * 10) / 10, trendY(p.used, height, inset)]);
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * Per-server tag (used in file names). The origin's characters in hex, so it never equals another server's tag (no hash collisions).
 * The origin is already ASCII lowercase via normalizeBaseUrl
 */
function originTag(origin) {
  let hex = "";
  for (let i = 0; i < origin.length; i++) hex += origin.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** Settings generation (16 hex digits, new on every save). Settings from older versions use all zeros */
const DEFAULT_CONFIG_ID = "0000000000000000";
function configId(cfg) {
  return typeof cfg?.id === "string" && /^[0-9a-f]{16}$/.test(cfg.id) ? cfg.id : DEFAULT_CONFIG_ID;
}

/**
 * Tag used in the names of the previous view and the seen-number markers: settings generation + server. A fetch that started before the settings
 * were deleted or re-saved cannot affect the new settings' numbers or view, even if it saves
 */
function cacheTag(cfg, origin) {
  return configId(cfg) + originTag(origin);
}

/** Same settings? (server and generation; replacing only the credentials also makes a new generation) */
function sameConfig(a, b) {
  return Boolean(a && b) && normalizeBaseUrl(a.url) === normalizeBaseUrl(b.url) && configId(a) === configId(b);
}

/** Names of the files Headroom creates (nothing else is deleted, so user scripts with the same prefix are kept) */
const OWN_FILE = /^(headroom-view-[0-9a-f]{2,600}-\d{1,15}\.json|headroom-seen-[0-9a-f]{2,600}-\d{1,15}|headroom-view(-\d{1,15})?\.json)$/;

/** File name of the previous view (per server and data number, so an old response never overwrites a newer number's file) */
function cacheFileName(tag, version) {
  return `headroom-view-${tag}-${version}.json`;
}
/** File name of the seen-number marker (only created, higher numbers never deleted, so overlapping runs can't go backwards) */
function seenFileName(tag, version) {
  return `headroom-seen-${tag}-${version}`;
}

/** From a list of names, that server's numbers (kind: view or seen) */
function versionsOf(names, kind, tag) {
  const re = new RegExp(`^headroom-${kind}-${tag}-(\\d{1,15})${kind === "view" ? "\\.json" : ""}$`);
  const out = [];
  for (const name of names) {
    const m = re.exec(name);
    if (m) out.push({ name, version: Number(m[1]) });
  }
  return out;
}

/** From the file names, the usable previous view (highest number, not below the seen number). null if none */
function pickCache(names, tag, seenVersion) {
  let best = null;
  for (const c of versionsOf(names, "view", tag)) {
    if (c.version >= seenVersion && (best === null || c.version > best.version)) best = c;
  }
  return best;
}

/** Seen number (highest number among the marker files). Markers are only created and higher numbers never deleted, so overlapping runs can't go backwards */
function seenFrom(names, tag) {
  return Math.max(0, ...versionsOf(names, "seen", tag).map((s) => s.version));
}

/** Read the saved previous view, only if it is for the same server (after a server change, the old server's values are not shown) */
function readCache(text, origin) {
  try {
    const cached = JSON.parse(text);
    if (!cached || cached.origin !== origin) return null;
    const view = sanitizeView(cached.view);
    return view ? { view, savedAt: str(cached.saved_at, 40) } : null;
  } catch (_) {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Widget rendering below (uses the Scriptable API)

/**
 * Demo, so every display state can be checked. Draws with made-up values only: no network, never reads
 * or saves the previous view (never mixed with real values). Shows Demo in the header and on the lock screen.
 * Chosen with the widget parameter demo (= runout) or demo:<name>, or "Show demo" in the app menu
 */
const DEMO_SCENARIOS = [
  { name: "normal", title: "Normal (plenty left, chart)" },
  { name: "runout", title: "Runs out before reset" },
  { name: "no5h", title: "Codex without a 5h limit" },
  { name: "stale", title: "Stale and old values" },
  { name: "reset", title: "Reset passed / limit reached" },
  { name: "offline", title: "Can't update (last data)" },
  { name: "error", title: "Sign-in required / no data" },
  { name: "nochart", title: "No chart data yet" },
];

/** If the parameter is a demo, its name (demo alone is runout; unknown names are runout too). null otherwise */
function demoName(parameter) {
  const m = /^demo(?:[:\s]+(\w+))?$/i.exec(String(parameter ?? "").trim());
  if (!m) return null;
  const name = (m[1] ?? "runout").toLowerCase();
  return DEMO_SCENARIOS.some((s) => s.name === name) ? name : "runout";
}

/** Demo result (in the shape passed to render). The view and trend go through the same validation as real data (sanitizeView, sanitizeHistory) */
function demoResult(name, now) {
  const at = (minutes) => new Date(now.getTime() + minutes * 60000).toISOString();
  const win = (id, used, o = {}) => ({
    id, label: id, scope: o.scope ?? null, used_percent: used,
    recent_consumed_percent: o.recent ?? null, recent_quality: o.recent === undefined ? "unknown" : "exact",
    confidence: "high", fetched_at: at(-(o.age ?? 1)),
    resets_at: at(o.resets ?? (id.includes("five_hour") ? 180 : 3 * 1440)),
    eta_at: null, reset_first: null, eta_minutes: null, rate_15m: null,
    rate_60m: o.rate ?? null, rate_24h: o.rate ?? null, rate_pace: o.rate ?? 0,
  });
  const provider = (plan, windows) => ({
    status: "ok", plan, error_code: null,
    main_window_ids: windows.filter((w) => !w.scope).map((w) => w.id).join(","),
    window_ids: windows.map((w) => w.id).join(","),
    windows: Object.fromEntries(windows.map((w) => [w.id, w])),
  });
  const age = name === "offline" ? 26 : 1;
  const claude = {
    normal: () => [win("five_hour", 35, { recent: 6, rate: 4, age }), win("seven_day", 22, { recent: 3, rate: 0.4, age }),
      win("seven_day_fable", 10, { scope: "Fable", age })],
    runout: () => [win("five_hour", 70, { recent: 25, rate: 30 }), win("seven_day", 30, { recent: 4, rate: 0.3 })],
    stale: () => [win("five_hour", 35, { recent: 6, rate: 4, age: 30 }), win("seven_day", 22, { recent: 3, rate: 0.4, age: 30 })],
    reset: () => [win("five_hour", 80, { resets: -20 }), win("seven_day", 45, { recent: 5, rate: 0.5 })],
  };
  const codex = {
    normal: () => [win("five_hour", 20, { recent: 2, rate: 3, age }), win("seven_day", 41, { recent: 5, rate: 0.5, age })],
    runout: () => [win("five_hour", 15, { recent: 2, rate: 2 }), win("seven_day", 65, { recent: 12, rate: 1.2 })],
    no5h: () => [win("seven_day", 41, { recent: 5, rate: 0.5 }), win("codex_other_seven_day", 12, { scope: "codex_other" })],
    stale: () => [win("five_hour", 20, { recent: 2, rate: 3, age: 90 }), win("seven_day", 41, { recent: 5, rate: 0.5, age: 90 })],
    reset: () => [win("five_hour", 100, { resets: 120 }), win("seven_day", 60, { recent: 6, rate: 0.6 })],
  };
  const body = {
    view_version: VIEW_VERSION, data_version: 1, boundaries: { claude: "#0", codex: "#0" },
    claude: name === "error"
      ? { status: "error", plan: "max", error_code: "login_required", main_window_ids: "", window_ids: "", windows: {} }
      : provider("max", (claude[name] ?? claude.normal)()),
    codex: name === "error" ? null : provider("plus", (codex[name] ?? codex.normal)()),
  };
  const view = sanitizeView(body);
  // 7-day trend: a sawtooth that drops to 0 at each weekly reset (ending at the current value). A break on the point right after each reset
  const trend = (p) => {
    const w = view?.[p]?.windows?.seven_day;
    if (!w || name === "nochart" || name === "error" || name === "offline") return null;
    const resetAgo = 7 * 1440 - (Date.parse(w.resets_at) - now.getTime()) / 60000;
    const list = [];
    for (let m = -TREND_HOURS * 60; m <= 0; m += 120) {
      const sinceReset = m + resetAgo;
      const used = sinceReset >= 0
        ? Math.max(0, w.used_percent * (sinceReset / Math.max(1, resetAgo)))
        : Math.min(95, 70 * ((sinceReset + 7 * 1440) / (7 * 1440)));
      list.push({ at: at(m), used_percent: Math.round(used * 10) / 10, break: sinceReset >= 0 && sinceReset < 120 ? "reset" : null });
    }
    const points = sanitizeHistory({ provider: p, windows: { seven_day: list } }, p, "seven_day", now, TREND_HOURS);
    return points ? { windowId: "seven_day", points } : null;
  };
  const trends = Object.fromEntries(["claude", "codex"].flatMap((p) => (trend(p) ? [[p, trend(p)]] : [])));
  return { view, trends, demo: true, ...(name === "offline" ? { cachedAt: at(-25) } : {}) };
}

/** Demo from the app menu: choose a demo and a size to show (choose again after closing; Cancel ends) */
async function showDemos() {
  for (;;) {
    const pick = new Alert();
    pick.title = "Demo";
    for (const s of DEMO_SCENARIOS) pick.addAction(s.title);
    pick.addCancelAction("Done");
    const index = await pick.presentSheet();
    if (index < 0 || index >= DEMO_SCENARIOS.length) return;
    const size = new Alert();
    size.title = DEMO_SCENARIOS[index].title;
    for (const label of ["Small", "Medium", "Large"]) size.addAction(label);
    size.addCancelAction("Back");
    const which = await size.presentSheet();
    if (which < 0 || which > 2) continue;
    const family = ["small", "medium", "large"][which];
    const now = new Date();
    const widget = render(demoResult(DEMO_SCENARIOS[index].name, now), family, "", now);
    if (family === "small") await widget.presentSmall();
    else if (family === "large") await widget.presentLarge();
    else await widget.presentMedium();
  }
}

async function main() {
  // Parameter demo / demo:<name>: draw only the demo (no network, no saving)
  const demo = config.runsInWidget ? demoName(args.widgetParameter) : null;
  if (demo !== null) {
    const now = new Date();
    const widget = render(demoResult(demo, now), config.widgetFamily, "", now);
    Script.setWidget(widget);
    Script.complete();
    return;
  }
  if (!config.runsInWidget) {
    const setup = await setupIfNeeded();
    if (setup === "demo") await showDemos();
    if (setup !== "ok") {
      Script.complete();
      return;
    }
  }
  const cfg = loadConfig();
  const family = config.runsInWidget ? config.widgetFamily : "medium";
  let result = cfg ? await loadView(cfg) : { error: "Run in Scriptable to set up" };
  // The 7-day weekly trend is read only when shown at this size, and only for a freshly fetched view (not the previous one)
  if (cfg && result.fetched && SIZE_CONTENT[family]?.trend) {
    // Discard a provider's trend if an account switch happened while reading it (boundary stamps differ). The view is what the server
    // returned when read, so show it as is; it is replaced on the next refresh (same as normal staleness). This keeps two accounts'
    // values from being mixed within one draw. (Re-fetching the view in this case was removed)
    result = { ...result, trends: await loadTrends(cfg, result.view, family, args.widgetParameter, new Date(), screenSize()) };
    // If another run saved a newer number while waiting for the trend, don't draw this view and trend; show the newer previous view
    result = newestView(cfg, result);
  }
  // Settings were deleted or re-saved during the fetch: don't draw the old settings' values
  if (cfg && !sameConfig(cfg, loadConfig())) result = { error: "Settings changed. Updates on next refresh" };
  // Take the draw time after waiting for the fetch (so a reset crossed while waiting doesn't show the previous cycle's values)
  const now = new Date();
  const widget = render(result, family, args.widgetParameter, now);
  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else {
    await widget.presentMedium();
  }
  Script.complete();
}

/** Read settings (from the single item; older versions' separate items are only read). Failures such as deletion mid-read mean "no settings" */
function loadConfig() {
  try {
    return readConfig();
  } catch (_) {
    return null;
  }
}

function readConfig() {
  if (Keychain.contains(KEYCHAIN_CONFIG)) {
    try {
      const c = JSON.parse(Keychain.get(KEYCHAIN_CONFIG));
      return c && typeof c.url === "string" && typeof c.token === "string" ? c : null;
    } catch (_) {
      return null;
    }
  }
  // Older versions' separate items are only read (the widget never rewrites settings; migration happens when saving in the app)
  if (!Keychain.contains(KEYCHAIN_LEGACY.url) || !Keychain.contains(KEYCHAIN_LEGACY.token)) return null;
  const get = (k) => (Keychain.contains(k) ? Keychain.get(k) : "");
  const checked = validateSetup({ url: get(KEYCHAIN_LEGACY.url), token: get(KEYCHAIN_LEGACY.token) });
  if (checked.error) return null;
  return { url: checked.url, token: checked.token };
}

/**
 * Store the settings in a single write, then delete older versions' items (only when saving in the app; if the write fails the old items remain).
 * A half-swapped server and credentials are never read
 */
function saveConfig(checked) {
  let id = "";
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
  const c = { url: checked.url, token: checked.token, id };
  Keychain.set(KEYCHAIN_CONFIG, JSON.stringify(c));
  for (const k of Object.values(KEYCHAIN_LEGACY)) if (Keychain.contains(k)) Keychain.remove(k);
  return c;
}

function clearConfig() {
  for (const k of [KEYCHAIN_CONFIG, ...Object.values(KEYCHAIN_LEGACY)]) if (Keychain.contains(k)) Keychain.remove(k);
}

/** Only the names of files Headroom created */
function fileNames(fm) {
  try {
    return fm.listContents(fm.documentsDirectory()).filter((n) => OWN_FILE.test(n));
  } catch (_) {
    return [];
  }
}

function seenVersion(fm, tag) {
  return seenFrom(fileNames(fm), tag);
}

/** Delete previous views and seen-number markers (only Headroom's files, for every server; when the server changes or settings are deleted) */
function removeCache() {
  const fm = FileManager.local();
  for (const name of fileNames(fm)) {
    try {
      fm.remove(fm.joinPath(fm.documentsDirectory(), name));
    } catch (_) { /* keep going even if it can't be deleted */ }
  }
}

/**
 * Save the received view to that number's file, create the seen-number marker and delete older numbers' files (display continues if any of this fails).
 * The seen number lives only in the marker files (only created, higher numbers never deleted, so overlapping runs can't go backwards).
 * If the marker can't be created, the previous view isn't saved either (so only previous views not older than the seen number remain)
 */
function saveCache(fm, tag, origin, view) {
  const dir = fm.documentsDirectory();
  const v = view.data_version;
  try {
    fm.writeString(fm.joinPath(dir, seenFileName(tag, v)), "");
  } catch (_) {
    // Can't create the marker (device storage not writable): don't save the previous view and don't delete anything (an accepted limitation)
    return;
  }
  try {
    fm.writeString(fm.joinPath(dir, cacheFileName(tag, v)), JSON.stringify({ saved_at: new Date().toISOString(), origin, view }));
  } catch (_) { /* the seen number has already advanced even if saving fails */ }
  const names = fileNames(fm);
  const latestSeen = Math.max(v, ...versionsOf(names, "seen", tag).map((s) => s.version));
  for (const old of [...versionsOf(names, "view", tag), ...versionsOf(names, "seen", tag)]) {
    if (old.version < v || (old.name.startsWith("headroom-seen-") && old.version < latestSeen)) {
      try {
        fm.remove(fm.joinPath(dir, old.name));
      } catch (_) { /* deleted on the next save */ }
    }
  }
}

/** Usable previous view (same server, not older than the seen number, newest). null if none */
function loadCache(fm, tag, origin) {
  const best = pickCache(fileNames(fm), tag, seenVersion(fm, tag));
  if (!best) return null;
  try {
    return readCache(fm.readString(fm.joinPath(fm.documentsDirectory(), best.name)), origin);
  } catch (_) {
    return null;
  }
}

/** When run in the app: ask for settings if there are none; otherwise choose "show / set up again / delete settings" */
async function setupIfNeeded() {
  if (loadConfig()) {
    const menu = new Alert();
    menu.title = "Headroom";
    menu.addAction("Show widget");
    menu.addAction("Show demo");
    menu.addAction("Edit settings");
    menu.addDestructiveAction("Remove settings");
    menu.addCancelAction("Close");
    const choice = await menu.presentSheet();
    if (choice === 0) return "ok";
    if (choice === 1) return "demo";
    if (choice === 3) {
      clearConfig();
      removeCache();
      return "cancelled";
    }
    if (choice !== 2) return "cancelled";
  }
  const form = new Alert();
  form.title = "Headroom settings";
  form.message = "Enter the server URL (https host only) and your read token. They're stored only in this iPhone's Keychain.";
  form.addTextField("https://headroom.example.workers.dev", "");
  form.addSecureTextField("Read token", "");
  form.addAction("Save");
  form.addCancelAction("Cancel");
  if ((await form.present()) !== 0) return "cancelled";
  const checked = validateSetup({ url: form.textFieldValue(0), token: form.textFieldValue(1) });
  if (checked.error) {
    const bad = new Alert();
    bad.title = "Can't save";
    bad.message = checked.error;
    bad.addAction("OK");
    await bad.present();
    return "cancelled";
  }
  // If the server changed, don't keep the old server's values
  const before = loadConfig();
  if (!before || before.url !== checked.url) removeCache();
  // Replace in a single write (Access credentials saved by older versions don't remain either)
  saveConfig(checked);
  return "ok";
}

/**
 * Read the 7-day weekly trend (GET /v2/history; once per provider, for that provider's weekly limit). Credentials only in headers,
 * redirects not followed. Providers that couldn't be read are left out (the rest of the display continues without a trend). Not saved
 */
async function loadTrends(cfg, view, family, parameter, now, screen = null) {
  const spec = buildRequest(cfg, "UTC");
  const base = normalizeBaseUrl(cfg.url);
  const out = {};
  if (!spec || !base) return out;
  for (const [provider, windowId] of Object.entries(trendWindows(view, family, parameter, now, screen))) {
    try {
      const req = new Request(`${base}/v2/history?provider=${provider}&window=${encodeURIComponent(windowId)}&hours=${TREND_HOURS}`);
      req.headers = spec.headers;
      req.timeoutInterval = 15;
      req.onRedirect = () => null;
      const data = await req.load();
      if (req.response?.statusCode !== 200) continue;
      const body = JSON.parse(data.toRawString());
      // A trend read across an account switch (boundary stamps differ) is not mixed with the view
      const stamp = view.boundaries?.[provider];
      if (typeof stamp !== "string" || body?.boundary !== stamp) continue;
      const points = sanitizeHistory(body, provider, windowId, now, TREND_HOURS);
      if (points) out[provider] = { windowId, points };
    } catch (_) { /* this provider's trend is not shown */ }
  }
  return out;
}

/** Right before drawing, if the seen number is ahead of this view, switch to the newest previous view (the trend is discarded) */
function newestView(cfg, result) {
  try {
    const origin = normalizeBaseUrl(cfg.url);
    const tag = cacheTag(cfg, origin);
    const fm = FileManager.local();
    if (seenVersion(fm, tag) <= result.view.data_version) return result;
    const latest = loadCache(fm, tag, origin);
    return latest ? { view: latest.view, fromCache: true } : { error: "Response is older than the last one" };
  } catch (_) {
    return result;
  }
}

/** Read the view. On failure, return the same server's previous view (marked as old) */
async function loadView(cfg) {
  let timeZone = "Asia/Tokyo";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
  } catch (_) { /* keep the default */ }
  const spec = buildRequest(cfg, timeZone);
  if (!spec) return { error: "Check your settings" };
  const origin = normalizeBaseUrl(cfg.url);
  const tag = cacheTag(cfg, origin);
  let status = 0;
  try {
    const req = new Request(spec.url);
    req.headers = spec.headers;
    req.timeoutInterval = 20;
    // Don't follow redirects (never send the credential header to another host)
    req.onRedirect = () => null;
    const data = await req.load();
    // Check the status code before parsing the body as JSON (also tells HTML 401/403 apart)
    status = req.response?.statusCode ?? 0;
    if (status === 200) {
      let view = null;
      try {
        view = sanitizeView(JSON.parse(data.toRawString()));
      } catch (_) { /* unreadable response */ }
      if (view) {
        const fm = FileManager.local();
        // A response older than the seen number or the saved previous view (arrived late, or read an earlier value) is neither shown nor saved.
        // Show the newer previous view if there is one
        const newer = loadCache(fm, tag, origin);
        if (newer && newer.view.data_version > view.data_version) return { view: newer.view, fromCache: true };
        if (view.data_version < seenVersion(fm, tag)) return { error: "Response is older than the last one" };
        saveCache(fm, tag, origin, view);
        // If another run saved a newer number after the comparison, show that one instead of this response
        if (seenVersion(fm, tag) > view.data_version) {
          const latest = loadCache(fm, tag, origin);
          return latest ? { view: latest.view, fromCache: true } : { error: "Response is older than the last one" };
        }
        return { view, fetched: true };
      }
    }
  } catch (_) {
    status = 0;
  }
  const cached = loadCache(FileManager.local(), tag, origin);
  if (cached) return { view: cached.view, cachedAt: cached.savedAt ?? "" };
  return { error: errorText(status) };
}

/** Bar colors. DrawContext takes fixed colors (Color.dynamic can't be used). Mid tones readable on both light and dark backgrounds */
/** Recent consumption (recent) is a darker gray than the track */
const BAR_COLORS = { recent: "#6B7280", track: "#8e8e93" };
const TEXT = () => Color.dynamic(new Color("#1c1c1e"), new Color("#f2f2f7"));
const SUB = () => Color.dynamic(new Color("#6e6e73"), new Color("#a1a1a6"));

/**
 * Shape of a band (from x, width w). The right end is rounded with radius rightCap. The left end is rounded with radius leftCap for the first piece;
 * for later pieces it is concave along the previous piece's rounded right end (radius leftCap). Pieces meet with no gap or overlap, and neither end
 * is a vertical line. Returns the list of commands for Path (a pure value, so tests can check the shape)
 */
function segmentShape(x, w, height, leftCap, rightCap, concaveLeft = false) {
  const h = height;
  const ops = [];
  const start = concaveLeft ? x - leftCap : x + leftCap;
  ops.push(["move", start, 0], ["line", x + w - rightCap, 0]);
  if (rightCap > 0) ops.push(["quad", x + w, h / 2, x + w, 0], ["quad", x + w - rightCap, h, x + w, h]);
  else ops.push(["line", x + w, h]);
  ops.push(["line", start, h]);
  // Left end: rounded (bulging outward) or concave along the previous piece's curve. Both use the same curve (control point on the vertical line at x)
  if (leftCap > 0) ops.push(["quad", x, h / 2, x, h], ["quad", start, 0, x, 0]);
  else ops.push(["line", x, 0]);
  ops.push(["close"]);
  return ops;
}

/** Fill a band. shape is segmentShape's arguments (leftCap, rightCap, concaveLeft). If omitted, both ends are rounded */
function fillBar(ctx, x, w, height, hex, alpha, shape = null) {
  if (w <= 0) return;
  const cap = Math.min(height / 2, w / 2);
  const { leftCap, rightCap, concaveLeft } = shape ?? { leftCap: cap, rightCap: cap, concaveLeft: false };
  const path = new Path();
  for (const [op, a, b, c, d] of segmentShape(x, w, height, leftCap, rightCap, concaveLeft)) {
    if (op === "move") path.move(new Point(a, b));
    else if (op === "line") path.addLine(new Point(a, b));
    else if (op === "quad") path.addQuadCurve(new Point(a, b), new Point(c, d));
    else path.closeSubpath();
  }
  ctx.addPath(path);
  ctx.setFillColor(new Color(hex, alpha));
  ctx.fillPath();
}

function newBar(width, height) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  return ctx;
}

/** Bar image. Fills the remaining part from the left in the provider color, then recent consumption in gray right after it */
/**
 * The boundary between color and gray when drawing. Gray thinner than the end radius gets eaten by the rounding and disappears, so gray gets a minimum width
 * (radius + 1pt) and the color is shortened by that much (off by at most a few % of the bar width; recent consumption is never missed)
 */
function drawnJunction(remainingEnd, recentEnd, height, width = Infinity) {
  if (recentEnd <= remainingEnd) return { remainingEnd, recentEnd };
  const minGray = height / 2 + 1;
  if (recentEnd - remainingEnd >= minGray) return { remainingEnd, recentEnd };
  // Extend to the right first. If the bar's right end is in the way, extend left by the shortfall (remaining only disappears when the bar is almost full)
  const end = Math.min(width, remainingEnd + minGray);
  return { remainingEnd: end - minGray >= remainingEnd - 1e-9 ? remainingEnd : Math.max(0, end - minGray), recentEnd: end };
}

function barImage(segments, width, height, brandHex) {
  const ctx = newBar(width, height);
  fillBar(ctx, 0, width, height, BAR_COLORS.track, 0.25);
  for (const p of barPieces(segments, width, height, brandHex)) fillBar(ctx, p.x, p.w, height, p.hex, p.alpha, p);
  return ctx.getImage();
}

/** Empty bar showing there is no limit (only the faint track) */
function emptyBarImage(width, height) {
  const ctx = newBar(width, height);
  fillBar(ctx, 0, width, height, BAR_COLORS.track, 0.12);
  return ctx.getImage();
}

/** Provider icon. The embedded image if any, otherwise SF Symbols (tinted with the provider color). null if neither works */
function iconImage(provider) {
  try {
    if (ICONS[provider]) {
      const data = Data.fromBase64String(ICONS[provider]);
      const image = data ? Image.fromData(data) : null;
      if (image) return { image, tint: false };
    }
    const symbol = SFSymbol.named(provider === "claude" ? "asterisk" : "terminal");
    return symbol ? { image: symbol.image, tint: true } : null;
  } catch (_) {
    return null;
  }
}

function addSmallText(stack, text, size, color, shrink = 0.8) {
  const t = stack.addText(text);
  t.font = Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = 1;
  t.minimumScaleFactor = shrink;
  return t;
}

/** Color of the freshness dot */
// Green only when fresh, gray otherwise (staleness is conveyed by the elapsed time next to it; one way of showing it)
const FRESH_COLORS = { fresh: "#34C759", stale: "#8E8E93", old: "#8E8E93", unknown: "#8E8E93" };

/** Freshness dot (round image) */
function dotImage(hex, size) {
  const ctx = newBar(size, size);
  ctx.setFillColor(new Color(hex));
  ctx.fillEllipse(new Rect(0, 0, size, size));
  return ctx.getImage();
}

/** Small SF Symbols symbol (null if unavailable) */
function symbolImage(name) {
  try {
    return SFSymbol.named(name)?.image ?? null;
  } catch (_) {
    return null;
  }
}

/** Group header: icon, provider name (in the provider color), plan and freshness dot (with elapsed time when old) */
/**
 * Circular progress on the lock screen (like ChatGPT's built-in lock screen widget).
 * The remaining amount of the shown limit (the number and ring agree; 5h and weekly side by side get separate rings). Faded for old values. null if there is no limit (track only)
 */
function ringOf(window) {
  if (!window) return null;
  const left = window.used_percent >= 100 ? 0
    : Math.max(0, Math.min(100, typeof window.remaining_percent === "number" ? window.remaining_percent : 100 - window.used_percent));
  return { fraction: left / 100, faded: window.value_status === "old" };
}

/**
 * Limits shown on the lock screen (up to 2). The parameter lists up to two "provider and limit" pairs separated by commas or + (case-insensitive):
 * empty = the one limit with the least remaining; `5h`, `weekly` = the provider with less remaining for that limit; `claude 5h`, `codex weekly`, `claude` =
 * that provider's limit (without a limit, the one with the least remaining); `claude 5h, codex 5h`, `codex 5h + codex weekly` = two side by side;
 * `both`, `both 5h`, `both weekly` = Claude and Codex side by side. The older `claude.five_hour` form is also read.
 * Pairs without such a limit are { missing: true } (e.g. Codex, which has no 5-hour limit)
 */
/** Reason for a failed fetch shown in tight spaces (the lock screen circle, two side by side) */
const SHORT_ERROR_NAMES = { login_required: "Sign in", not_installed: "Not installed", fetch_failed: "Fetch failed", safety_stop: "Paused", account_changed: "Paused" };
const LOCK_WINDOW_NAMES = { "5h": "five_hour", "5": "five_hour", five_hour: "five_hour", weekly: "seven_day", week: "seven_day", wk: "seven_day", seven_day: "seven_day" };
function lockPicks(view, parameter, now) {
  const param = String(parameter ?? "").trim().toLowerCase();
  let selectors;
  if (/^both\b/.test(param)) {
    const rest = param.replace(/^both\s*/, "");
    selectors = PROVIDER_ORDER.map((p) => `${p} ${rest}`);
  } else {
    selectors = param.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
    if (selectors.length === 0) selectors = [""];
  }
  const out = [];
  for (const selector of selectors.slice(0, 2)) {
    let provider = null;
    let windowId = null;
    if (selector.includes(".")) {
      // Older form (claude.five_hour). The window id is used as is
      const [p, id] = selector.split(".");
      provider = p === "claude" || p === "codex" ? p : null;
      windowId = id || null;
    } else {
      const words = selector.split(/\s+/).filter(Boolean);
      provider = words.find((w) => w === "claude" || w === "codex") ?? null;
      windowId = words.map((w) => LOCK_WINDOW_NAMES[w]).find(Boolean) ?? null;
    }
    const providers = provider ? [provider] : [...PROVIDER_ORDER];
    let best = null;
    for (const p of providers) {
      const v = view?.[p];
      if (!v) continue;
      const ids = windowId ? [windowId] : v.main_window_ids.length > 0 ? v.main_window_ids : v.window_ids;
      for (const id of ids) {
        const w = v.windows?.[id];
        if (!w) continue;
        const shown = atDisplayTime(w, now);
        if (best === null || shown.used_percent > best.window.used_percent) best = { provider: p, providerName: PROVIDER_NAMES[p], window: shown };
      }
    }
    if (best) {
      out.push(best);
      continue;
    }
    // Why there is no limit: if values were fetched and there are overall limits but no 5-hour limit (depends on the plan), No 5h. If not fetched, the reason
    // (e.g. sign-in required) or No data (a failed fetch is never presented as "no limit")
    // For a provider whose fetch failed, show the reason first even if a weekly limit remains (don't show No 5h)
    const failed = (x) => Boolean(view?.[x]?.error_code) || view?.[x]?.status === "error";
    const withError = providers.find(failed);
    const withMain = windowId === "five_hour"
      ? providers.find((x) => !failed(x) && (view?.[x]?.main_window_ids?.length ?? 0) > 0)
      : undefined;
    const p = withError ?? withMain ?? provider ?? "claude";
    const code = withError ? view[p].error_code : null;
    const label = withError ? ERROR_NAMES[code] ?? "No data" : withMain ? `5h: ${NOT_AVAILABLE}` : "No data";
    const short = withError ? SHORT_ERROR_NAMES[code] ?? "No data" : withMain ? `5h ${NOT_AVAILABLE}` : "No data";
    out.push({ missing: true, provider: p, providerName: PROVIDER_NAMES[p], windowId, label, short });
  }
  return out;
}

/** Lock screen ring dimensions (diameter, thickness, inner icon; the icon is small to leave space inside the ring) */
const LOCK_RINGS = {
  circular: { size: 54, width: 4, icon: 16, font: 12 },
  rectangular: { size: 50, width: 4, icon: 20, font: 12 },
  pair: { size: 42, width: 3.5, icon: 12, font: 10 },
};

/**
 * Circular progress image: draws the remaining amount clockwise from the top over a faded track of the same color. The icon is inside the ring (Scriptable's Path has no arcs,
 * so the ring is joined from short line segments with rounded ends). If text is given, it is drawn below the icon (remaining on the circular lock screen widget).
 * The fallback icon (no PNG) can't be tinted inside an image, so the provider's initial is drawn instead
 */
function ringImage(icon, ring, hex, geom, provider, text = null) {
  const { size, width: lw } = geom;
  const ctx = newBar(size, size);
  const r = size / 2 - lw / 2;
  const c = size / 2;
  ctx.setLineWidth(lw);
  ctx.setStrokeColor(new Color(hex, 0.25));
  ctx.strokeEllipse(new Rect(c - r, c - r, 2 * r, 2 * r));
  if (ring && ring.fraction > 0) {
    const alpha = ring.faded ? 0.4 : 1;
    const end = -Math.PI / 2 + 2 * Math.PI * Math.min(1, ring.fraction);
    const steps = Math.max(2, Math.ceil(ring.fraction * 120));
    const point = (a) => new Point(c + r * Math.cos(a), c + r * Math.sin(a));
    const arc = new Path();
    arc.move(point(-Math.PI / 2));
    for (let i = 1; i <= steps; i++) arc.addLine(point(-Math.PI / 2 + (end + Math.PI / 2) * (i / steps)));
    ctx.addPath(arc);
    ctx.setStrokeColor(new Color(hex, alpha));
    ctx.strokePath();
    ctx.setFillColor(new Color(hex, alpha));
    for (const a of [-Math.PI / 2, end]) {
      const p = point(a);
      ctx.fillEllipse(new Rect(p.x - lw / 2, p.y - lw / 2, lw, lw));
    }
  }
  const iconTop = text ? c - geom.icon + 1 : c - geom.icon / 2;
  if (icon && !icon.tint) {
    ctx.drawImageInRect(icon.image, new Rect(c - geom.icon / 2, iconTop, geom.icon, geom.icon));
  } else {
    ctx.setFont(Font.boldSystemFont(geom.icon * 0.8));
    ctx.setTextColor(new Color(hex));
    ctx.setTextAlignedCenter();
    ctx.drawTextInRect(provider === "claude" ? "C" : "X", new Rect(c - geom.icon / 2, iconTop, geom.icon, geom.icon));
  }
  if (text) {
    ctx.setFont(Font.boldSystemFont(geom.font));
    ctx.setTextColor(new Color("#ffffff"));
    ctx.setTextAlignedCenter();
    ctx.drawTextInRect(text, new Rect(c - r + lw, c + 2, 2 * (r - lw), geom.font + 3));
  }
  return ctx.getImage();
}

/**
 * Two side by side in the lock screen rectangle. Each has a circular progress (icon and remaining), the limit name and mark, and the time row
 * (same as home: ↻ and the reset time, or ⚠ and the run-out time if it will run out). Pairs without that limit show "No 5h" etc.
 */
function drawLockPair(widget, picks, result, now, cached) {
  const row = widget.addStack();
  row.layoutHorizontally();
  row.topAlignContent();
  for (const [index, pick] of picks.slice(0, 2).entries()) {
    if (index > 0) row.addSpacer(null);
    const col = row.addStack();
    col.layoutVertically();
    col.centerAlignContent();
    col.size = new Size(76, 0);
    const w = pick.missing ? null : pick.window;
    const img = col.addImage(ringImage(iconImage(pick.provider), ringOf(w), BRAND_COLORS[pick.provider], LOCK_RINGS.pair, pick.provider, w ? compactPercent(w) : "–"));
    img.imageSize = new Size(LOCK_RINGS.pair.size, LOCK_RINGS.pair.size);
    col.addSpacer(1);
    const mark = w ? [cached ? WARN_MARK : "", shortMark(w).replace(/ ago$/, "")].filter(Boolean).join(" ") : "";
    const demo = result.demo && index === 0 ? " · Demo" : "";
    const fits = (s) => textWidth(s, 9, true) * 0.8 <= 76;
    const shortWindow = w ? limitName(w).replace(/ weekly$/, " wk").replace(/^Weekly$/, "Weekly") : "";
    const candidates = w
      ? [`${limitName(w)}${mark ? ` ${mark}` : ""}${demo}`, `${shortWindow}${mark ? ` ${mark}` : ""}${demo}`, `${shortWindow}${demo}`]
      : [`${pick.short}${demo}`];
    const label = col.addText(candidates.find(fits) ?? candidates[candidates.length - 1]);
    label.font = Font.semiboldSystemFont(9);
    label.lineLimit = 1;
    label.minimumScaleFactor = 0.8;
    label.centerAlignText();
    if (w) {
      const time = col.addStack();
      time.layoutHorizontally();
      time.centerAlignContent();
      addLockTime(time, w, now, 9, widget.__outs);
    }
  }
}

/** Estimated width of the right column in the lock screen rectangle (the narrowest device's 153pt minus the ring and spacing) */
const LOCK_TITLE_WIDTH = 95;

/** Lock screen time row (same as home: ⚠ and the run-out time if it will run out, otherwise ↻ and the reset time) */
function addLockTime(stack, w, now, size, outs = null) {
  const time = timeShort(w, now);
  if (!time) return;
  if (time.warn && outs) {
    const p = projectionOf(w, now);
    if (p?.at) outs.push(p.at);
  }
  const symbol = symbolImage(time.warn ? TIME_SYMBOLS.warn : TIME_SYMBOLS.reset);
  if (symbol) {
    const a = stack.addImage(symbol);
    a.imageSize = new Size(size, size);
    a.tintColor = SUB();
    stack.addSpacer(3);
  } else if (time.warn) {
    addSmallText(stack, `${WARN_MARK} `, size, SUB(), 1);
  }
  if (time.kind === "timer") {
    const box = stack.addStack();
    box.size = new Size(timerWidth(time.date, now, size), 0);
    const d = box.addDate(time.date);
    d.applyTimerStyle();
    d.font = Font.systemFont(size);
    d.textColor = SUB();
    d.lineLimit = 1;
  } else {
    addSmallText(stack, time.text, size, SUB(), 1);
  }
}

function addHeader(stack, group, opts) {
  const s = opts.scale;
  const row = stack.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  // Fix the row width to the column width so the freshness dot is right-aligned. Also fix the height so headers line up across columns
  if (opts.width) row.size = new Size(opts.width, s.header);
  const icon = iconImage(group.provider);
  if (icon) {
    const img = row.addImage(icon.image);
    img.imageSize = new Size(s.icon, s.icon);
    if (icon.tint) img.tintColor = new Color(BRAND_COLORS[group.provider]);
    row.addSpacer(5);
  }
  // Align the name and plan (and Demo) on their bottom edge (on the same line even with different font sizes)
  const names = row.addStack();
  names.layoutHorizontally();
  names.bottomAlignContent();
  const name = names.addText(group.name);
  name.font = Font.semiboldSystemFont(s.name);
  name.textColor = new Color(BRAND_COLORS[group.provider]);
  name.lineLimit = 1;
  if (group.plan && opts.content.plan) {
    names.addSpacer(5);
    addSmallText(names, group.plan, s.small, SUB());
  }
  if (opts.demo) {
    names.addSpacer(5);
    addSmallText(names, "Demo", s.small, SUB());
  }
  row.addSpacer(null);
  if (opts.content.freshness && group.freshness) {
    const f = group.freshness;
    if (f.text) {
      addSmallText(row, f.text, s.small, SUB());
      row.addSpacer(3);
    }
    const dot = row.addImage(dotImage(FRESH_COLORS[f.level], 6));
    dot.imageSize = new Size(6, 6);
  }
}

/** One row: heading and remaining, the bar (including the forecast), and the line below it (reset, marks, rate; run-out time on the right) */
/**
 * When to ask for the next redraw: normally 15 minutes later. If a drawn warning (run-out time) is earlier, that time (never sooner than 1 minute,
 * Scriptable's minimum refresh). Forecasts for limits not shown don't make it earlier
 */
function refreshAfter(outs, now) {
  const regular = now.getTime() + REFRESH_MINUTES * 60000;
  const first = outs.length > 0 ? Math.min(...outs) : null;
  return new Date(first === null ? regular : Math.max(now.getTime() + 60000, Math.min(regular, first)));
}

/**
 * What a row draws (shared by drawing and by the estimate used to align font sizes).
 * The run-out mark goes in the time row for sizes that have one (medium, large) and before the remaining number for sizes that don't (small)
 */
function rowPlan(row, opts) {
  const c = opts.content;
  const s = opts.scale;
  const missing = row.kind === "missing";
  const w = missing ? null : row.window;
  const projection = missing ? null : projectionOf(w, opts.now);
  const runsOut = Boolean(projection?.runsOut && projection.at);
  const value = missing ? "—" : s.compact && w.reset_passed ? `${percentText(w)} · est.` : percentText(w);
  const reset = !missing && c.reset ? timeShort(w, opts.now) : null;
  const parts = [];
  if (!missing) {
    if (c.reset && !reset && w.reset_passed) parts.push("Reset (est.)");
    if (c.marks && rowMark(w) && !w.reset_passed) parts.push(rowMark(w));
  }
  // The rate goes at the right end of the time row
  const pace = !missing && c.pace && paceText(w) && opts.width >= 140 ? paceText(w) : "";
  return {
    missing, w,
    label: missing ? "5h limit" : limitLabel(w),
    showPct: true,
    pct: !missing && runsOut && !c.forecastTime ? `${WARN_MARK} ${value}` : value,
    sub: c.reset || c.marks || c.pace || c.forecastTime,
    reset,
    partsText: parts.length > 0 ? `${reset ? " · " : ""}${parts.join(" · ")}` : "",
    pace,
    // Run-out time of the drawn warning (decides when to redraw)
    outAt: runsOut ? projection.at : null,
    missingText: missing ? row.text : "",
  };
}

/** Estimated text width (SF Pro character widths as a ratio of the font size; slightly generous) */
function textWidth(text, size, bold = false) {
  let em = 0;
  for (const ch of String(text)) {
    em += ch === "\uFE0E" ? 0 : ch === " " ? 0.28 : ".,:;·'|()".includes(ch) ? 0.32 : ch === "%" ? 0.86 : ch === "\u26A0" ? 1.05
      : /[A-Z]/.test(ch) ? 0.68 : /[0-9]/.test(ch) ? 0.6 : /[a-z]/.test(ch) ? 0.56 : ch.charCodeAt(0) >= 0x2e80 ? 1 : 0.62;
  }
  return em * size * (bold ? 1.06 : 1);
}

/**
 * The same font size for rows in all columns (heading row, time row): the size at which the longest row fits the column width (if iOS shrinks per column
 * or per row, Claude and Codex end up with different text sizes). Down to 0.7x
 */
function fittedSizes(groups, opts) {
  const s = opts.scale;
  let label = 1;
  let small = 1;
  for (const group of groups) {
    for (const row of visibleRows(group.rows, opts.rows)) {
      const p = rowPlan(row, opts);
      const pctW = p.showPct ? 8 + textWidth(p.pct, s.pct, !p.missing) : 0;
      const labelW = textWidth(p.label, s.label);
      if (labelW > 0) label = Math.min(label, (opts.width - pctW) / labelW);
      if (!p.sub) continue;
      const resetW = p.reset
        ? s.small + 1 + (p.reset.kind === "timer" ? timerWidth(p.reset.date, opts.now, s.small) : textWidth(p.reset.text, s.small))
        : 0;
      const need = p.missing ? textWidth(p.missingText, s.small)
        : resetW + textWidth(p.partsText, s.small) + (p.pace ? 6 + textWidth(p.pace, s.small) : 0);
      if (need > 0) small = Math.min(small, opts.width / need);
    }
  }
  const k = (v) => Math.max(0.7, Math.min(1, v));
  return { label: Math.floor(s.label * k(label) * 2) / 2, small: Math.floor(s.small * k(small) * 2) / 2 };
}

/**
 * Height of the limit name row (the remaining number row's height; the same in every column). The row height estimate (SCALES.rowHeight) is built from this formula,
 * so the drawn height and the visible-row calculation don't drift apart
 */
function lineHeight(s) {
  return Math.ceil(s.pct * 1.2);
}

/** Height of the time row (the same for the symbol, time, rate and "Not available") */
function subHeight(s) {
  return Math.ceil(s.small * 1.2);
}

/** Height of one limit (limit name row, bar, time row; small has no time row). SCALES.rowHeight is built from this */
function rowHeightOf(s, content) {
  const sub = content.reset || content.marks || content.pace || content.forecastTime;
  return lineHeight(s) + s.gapBar + s.bar + (sub ? s.gapSub + subHeight(s) : 0);
}

/** Add the font sizes aligned across all columns to the per-column drawing options */
function withFit(groups, opts) {
  return { ...opts, fit: fittedSizes(groups, opts) };
}

function addRow(stack, group, row, opts) {
  const s = opts.scale;
  const fit = opts.fit ?? { label: s.label, small: s.small };
  const p = rowPlan(row, opts);
  const w = p.w;
  if (p.outAt !== null && opts.outs) opts.outs.push(p.outAt);
  const line = stack.addStack();
  line.layoutHorizontally();
  line.bottomAlignContent();
  line.size = new Size(opts.width, lineHeight(s));
  // Don't shrink text (its size is already aligned across all columns)
  const label = line.addText(p.label);
  label.font = Font.systemFont(fit.label);
  label.textColor = p.missing ? SUB() : TEXT();
  label.lineLimit = 1;
  line.addSpacer(null);
  if (p.showPct) {
    const pct = line.addText(p.pct);
    // The "—" of a row without a 5-hour limit uses the same size as the remaining value (row height unchanged, aligned with the neighboring column)
    pct.font = Font.semiboldSystemFont(s.pct);
    pct.textColor = p.missing || w.value_status === "old" ? SUB() : TEXT();
    pct.lineLimit = 1;
  }
  stack.addSpacer(s.gapBar);
  // Make the bar a non-resizable image (when content exceeds the height, iOS shrinks resizable images first and the bar can disappear.
  // On overflow the large chart shrinks instead)
  const bar = stack.addImage(p.missing ? emptyBarImage(opts.width, s.bar) : barImage(barSegmentsAt(w, opts.now), opts.width, s.bar, BRAND_COLORS[group.provider]));
  bar.resizable = false;
  bar.imageSize = new Size(opts.width, s.bar);
  if (!p.sub) return;
  stack.addSpacer(s.gapSub);
  const sub = stack.addStack();
  sub.layoutHorizontally();
  sub.centerAlignContent();
  // Fix the row width to the column width so the rate sits at the right end (otherwise the row is only as wide as its content and doesn't reach the right)
  sub.size = new Size(opts.width, subHeight(s));
  if (p.missing) {
    addSmallText(sub, p.missingText, fit.small, SUB(), 1);
    // The row width is fixed, so push left with a flexible spacer (otherwise it is centered)
    sub.addSpacer(null);
    return;
  }
  if (p.reset) {
    const color = SUB; // the run-out time uses the same color as the reset time
    const symbol = symbolImage(p.reset.warn ? TIME_SYMBOLS.warn : TIME_SYMBOLS.reset);
    if (symbol) {
      const a = sub.addImage(symbol);
      a.imageSize = new Size(fit.small - 1, fit.small - 1);
      a.tintColor = color();
      sub.addSpacer(2);
    } else if (p.reset.warn) {
      addSmallText(sub, `${WARN_MARK} `, fit.small, color(), 1);
    }
    if (p.reset.kind === "timer") {
      // The timer text expands to the full row width, so put it in a box as wide as the digits (no gap before the rate after it)
      const box = sub.addStack();
      box.size = new Size(timerWidth(p.reset.date, opts.now, fit.small), 0);
      const t = box.addDate(p.reset.date);
      t.applyTimerStyle();
      t.font = Font.systemFont(fit.small);
      t.textColor = color();
      t.lineLimit = 1;
    } else {
      addSmallText(sub, p.reset.text, fit.small, color(), 1);
    }
  }
  if (p.partsText) addSmallText(sub, p.partsText, fit.small, SUB(), 1);
  sub.addSpacer(null);
  if (p.pace) addSmallText(sub, p.pace, fit.small, SUB(), 1);
}

/**
 * Rows to show (up to limit). If there isn't room, keep in priority order: overall limits -> the "no 5h limit" row -> per-model and per-group limits.
 * Kept rows are shown in their original order (5h position, overall, scoped)
 */
/** Row priority (lower is kept first): overall limit 0, "no 5h limit" 1, per-model and per-group limits 2 */
const rowRank = (r) => (r.kind === "missing" ? 1 : r.window.scope === null ? 0 : 2);

function visibleRows(rows, limit) {
  if (rows.length <= limit) return rows;
  const rank = rowRank;
  const keep = new Set(rows.map((r, i) => [rank(r), i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, limit).map(([, i]) => i));
  return rows.filter((_, i) => keep.has(i));
}

function drawRows(stack, group, opts) {
  if (group.message) addSmallText(stack, group.message, opts.scale.label, SUB());
  for (const [index, row] of visibleRows(group.rows, opts.rows).entries()) {
    if (index > 0) stack.addSpacer(opts.scale.gapRow);
    addRow(stack, group, row, opts);
  }
}

function drawGroup(stack, group, opts) {
  addHeader(stack, group, opts);
  stack.addSpacer(opts.scale.gapHeader);
  drawRows(stack, group, opts);
}

/** Estimated width of the timer text (H:MM:SS; digits are about 0.62x the font size, plus a little margin) */
function timerWidth(date, now, size) {
  const hours = Math.floor(Math.max(0, date.getTime() - now.getTime()) / 3600000);
  const chars = String(hours).length + 6;
  return Math.ceil(size * 0.62 * chars + 4);
}

/**
 * Limit and period of the large chart (fixed to the weekly limit; 5h and weekly are not mixed). The chart shows this week from
 * Sunday; 170 hours are read so the week is covered even when it has 169 hours (daylight saving time) late on Saturday
 */
const TREND_WINDOW = "seven_day";
const TREND_HOURS = 170;

/** Spacing between the limits and the chart in large */
const TREND_GAP = 20;
/** Spacing between the chart and its day labels */
const TREND_LABEL_GAP = 3;
/** Day labels under the large chart (the week starts on Sunday) */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Start of each day of this week in local time: Sunday 00:00 to the next Sunday 00:00 (8 times in ms). Each day is built from its own
 * date, so a midnight skipped by daylight saving time (moved to 01:00) affects only that day
 */
function weekDays(now) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const sunday = now.getDate() - now.getDay();
  return Array.from({ length: 8 }, (_, i) => new Date(y, m, sunday + i).getTime());
}

/** This week in local time ({ start, end } in ms; a day may be 23 or 25 hours with DST) */
function weekRange(now) {
  const days = weekDays(now);
  return { start: days[0], end: days[7], days };
}

/** Local midnights inside the week (Monday to Saturday 00:00, ms), where the chart's day lines go */
function dayStarts(range) {
  return range.days.slice(1, 7);
}

/** Height the large chart needs besides its plot: spacing above, the heading row, and the day labels below */
function trendChrome(scale) {
  return TREND_GAP + scale.small * 1.25 + 4 + TREND_LABEL_GAP + scale.small * 1.25;
}
/** Height of the large trend chart (min and max) */
const TREND_MIN_HEIGHT = 56;
const TREND_MAX_HEIGHT = 150;

/**
 * Overlaid trend image (large). Draws one line per provider (lightly filled below) in a single 0-100% frame, a faint line at 50%,
 * and a dot at each current position
 */
function combinedTrendImage(series, width, height, inset = TREND_INSET, dayLines = []) {
  const ctx = newBar(width, height);
  const back = new Path();
  back.addRoundedRect(new Rect(0, 0, width, height), 8, 8);
  ctx.addPath(back);
  ctx.setFillColor(new Color(BAR_COLORS.track, 0.1));
  ctx.fillPath();
  // Faint lines between days (x positions)
  for (const x of dayLines) {
    const day = new Path();
    day.move(new Point(x, 0));
    day.addLine(new Point(x, height));
    ctx.addPath(day);
    ctx.setStrokeColor(new Color(BAR_COLORS.track, 0.15));
    ctx.setLineWidth(0.5);
    ctx.strokePath();
  }
  // Guide lines are drawn with the same coordinate calculation as the values (25%, 50%, 75%; lines are inset by inset)
  for (const level of [0.25, 0.5, 0.75]) {
    const y = trendY(level * 100, height, inset);
    const grid = new Path();
    grid.move(new Point(0, y));
    grid.addLine(new Point(width, y));
    ctx.addPath(grid);
    ctx.setStrokeColor(new Color(BAR_COLORS.track, level === 0.5 ? 0.3 : 0.15));
    ctx.setLineWidth(0.5);
    ctx.strokePath();
  }
  for (const { lines, hex } of series) {
    for (const line of lines) {
      if (line.length < 2) continue;
      const area = new Path();
      area.move(new Point(line[0][0], height));
      for (const [x, y] of line) area.addLine(new Point(x, y));
      area.addLine(new Point(line[line.length - 1][0], height));
      area.closeSubpath();
      ctx.addPath(area);
      ctx.setFillColor(new Color(hex, 0.12));
      ctx.fillPath();
    }
  }
  // All lines have the same width (when equal values overlap, the later line appears on top)
  for (const { lines, hex } of series) {
    const lineWidth = 2.5;
    const marker = 2.5;
    for (const line of lines) {
      if (line.length === 1) {
        ctx.setFillColor(new Color(hex));
        ctx.fillEllipse(new Rect(line[0][0] - marker, line[0][1] - marker, marker * 2, marker * 2));
        continue;
      }
      const path = new Path();
      path.move(new Point(line[0][0], line[0][1]));
      for (const [x, y] of line.slice(1)) path.addLine(new Point(x, y));
      ctx.addPath(path);
      ctx.setStrokeColor(new Color(hex));
      ctx.setLineWidth(lineWidth);
      ctx.strokePath();
    }
    const last = lines[lines.length - 1]?.[lines[lines.length - 1].length - 1];
    if (last) {
      ctx.setFillColor(new Color(hex));
      ctx.fillEllipse(new Rect(last[0] - marker, last[1] - marker, marker * 2, marker * 2));
    }
  }
  return ctx.getImage();
}

/** Inner margin for lines in the large chart (radius of the large current-position dot) */
const TREND_INSET = 3;

/**
 * Trends drawn in the large chart (per provider): each provider's weekly limit, only trends with the same boundary as the view.
 * { provider, name, window, points }
 */
function trendSeries(groups, trends, view) {
  const out = [];
  for (const g of groups) {
    // Fixed to the weekly limit. Drawn if the provider has a weekly limit even when it isn't among the shown rows (e.g. only a scoped limit was named)
    const week = view?.[g.provider]?.windows?.[TREND_WINDOW] ?? null;
    const t = trends?.[g.provider];
    out.push({ provider: g.provider, name: g.name, window: week, points: week && t && t.windowId === week.id ? t.points : null });
  }
  return out;
}

/** x position of a time on the large chart (same calculation as sparkLines with a range) */
function trendX(at, range, width, inset = TREND_INSET) {
  const span = range.end - range.start;
  return Math.round((inset + Math.max(0, Math.min(1, (at - range.start) / span)) * (width - 2 * inset)) * 10) / 10;
}

/** Large chart: legend (provider color dot, name, window), the overlaid trend for this week (Sunday start) and the day labels */
function drawCombinedTrend(stack, groups, opts) {
  const range = weekRange(opts.now);
  // Only points within this week, for both the legend and the lines (a provider with none shows as without a trend)
  const series = trendSeries(groups, opts.trends, opts.view).filter((s) => s.window)
    .map((s) => ({ ...s, points: s.points ? s.points.filter((p) => p.at >= range.start && p.at < range.end) : null }));
  const has = (s) => Boolean(s.points && s.points.length > 0);
  const legend = stack.addStack();
  legend.layoutHorizontally();
  legend.centerAlignContent();
  legend.size = new Size(opts.width, 0); // fix the row width to the chart width so the legend is right-aligned
  // Chart heading on the left, legend right-aligned
  const title = legend.addText("Usage");
  title.font = Font.semiboldSystemFont(opts.scale.small);
  title.textColor = TEXT();
  title.lineLimit = 1;
  legend.addSpacer(null);
  if (!series.some(has)) {
    // Neither trend available: one line instead of the legend
    addSmallText(legend, "No weekly data yet", opts.scale.small, SUB());
  } else {
    // What the trend is (the weekly limit's 7 days) appears once at the start of the legend; each provider shows only its name
    addSmallText(legend, "This week · Weekly", opts.scale.small, SUB());
    for (const s of series) {
      legend.addSpacer(10);
      // Providers without a trend get a gray dot and "–" (kept short)
      const dot = legend.addImage(dotImage(has(s) ? BRAND_COLORS[s.provider] : BAR_COLORS.track, 7));
      dot.imageSize = new Size(7, 7);
      legend.addSpacer(4);
      addSmallText(legend, `${s.name}${has(s) ? "" : " –"}`, opts.scale.small, SUB());
    }
  }
  stack.addSpacer(4);
  const drawn = trendDrawOrder(series.filter(has))
    .map((s) => ({ lines: sparkLines(s.points, opts.now, opts.width, opts.height, TREND_INSET, TREND_HOURS, range), hex: BRAND_COLORS[s.provider], provider: s.provider }));
  const starts = range.days;
  stack.addImage(combinedTrendImage(drawn, opts.width, opts.height, TREND_INSET, starts.slice(1, -1).map((t) => trendX(t, range, opts.width))));
  stack.addSpacer(TREND_LABEL_GAP);
  // Day labels, each centered under its day; today's stands out
  const labels = stack.addStack();
  labels.layoutHorizontally();
  labels.size = new Size(opts.width, 0);
  const today = new Date(opts.now.getTime()).getDay();
  let left = 0;
  for (let i = 0; i < 7; i++) {
    const right = i === 6 ? opts.width : trendX(starts[i + 1], range, opts.width);
    const cell = labels.addStack();
    cell.size = new Size(Math.max(0, right - left), 0);
    cell.addSpacer(null);
    const t = addSmallText(cell, WEEKDAYS[i], opts.scale.small, i === today ? TEXT() : SUB());
    if (i === today) t.font = Font.semiboldSystemFont(opts.scale.small);
    cell.addSpacer(null);
    left = right;
  }
}

/** Order of drawing lines: lower values in front (drawn in descending order of 7-day average; later lines appear on top) */
function trendDrawOrder(series) {
  const mean = (s) => s.points.reduce((sum, p) => sum + p.used, 0) / s.points.length;
  return [...series].sort((a, b) => mean(b) - mean(a));
}

/** Window to read the trend for (each provider's weekly limit). { provider: windowId } */
function trendWindows(view, family, parameter, now, screen = null) {
  const out = {};
  // Same choice as when drawing (the weekly limit of each shown provider)
  for (const s of trendSeries(layoutGroups(view, family, parameter, now, { screen }).groups, null, view)) {
    if (s.window) out[s.provider] = s.window.id;
  }
  return out;
}

/** Device screen size (points, { width, height }). null if unavailable */
function screenSize() {
  try {
    const s = Device.screenSize();
    return { width: s.width, height: s.height };
  } catch (_) {
    return null;
  }
}

/**
 * Home screen layout decision: from the size, padding and height budget, decide the rows shown per group (the result of visibleRows).
 * The header freshness, the trend windows and the drawing all use this result
 */
function layoutGroups(view, family, parameter, now, { cached = false, screen = null } = {}) {
  const content = SIZE_CONTENT[family] ?? SIZE_CONTENT.medium;
  const scale = SCALES[family] ?? SCALES.medium;
  const pad = PADDING[family] ?? 0;
  const size = widgetSize(family, screen);
  const inner = size.width - 2 * pad;
  const large = family === "large" || family === "extraLarge";
  // In small, two stacked groups pull the visual center down, so add a little space below to lift them
  const lift = family === "small" ? 2 : 0;
  const showNote = cached && family !== "small";
  // Height budget: the inside of the padding minus the visual correction, the offline notice and estimation error (2pt)
  const available = size.height - 2 * pad - lift - (showNote ? 4 + scale.small * 1.25 : 0) - 2;
  const groups = groupsOf(view, String(parameter ?? "").trim(), now, { allScoped: content.scoped });
  const two = groups.length >= 2;
  const message = scale.label * 1.25;
  const counts = (max) => groups.map((g) => Math.min(max, g.rows.length));
  const ranks = groups.map((g) => g.rows.map(rowRank));
  let limits;
  let between = 0;
  // Reserve the large chart's share first (spacing, legend, minimum height). Not if it isn't drawn (no shown provider has a weekly limit)
  const withChart = large && content.trend && groups.some((g) => view?.[g.provider]?.windows?.[TREND_WINDOW]);
  const chart = withChart ? trendChrome(scale) + TREND_MIN_HEIGHT : 0;
  if (large && !two) {
    limits = fitRows(counts(MAX_WINDOWS_SINGLE.large), scale, available - chart, 0, groups.map((g) => (g.rows.length > 0 ? 0 : message)), ranks);
  } else if (large) {
    limits = groups.map((g, i) => fitRows([Math.min(MAX_WINDOWS.large, g.rows.length)], scale, available - chart, 0, g.rows.length > 0 ? 0 : message, [ranks[i]])[0]);
  } else if (two && family !== "small") {
    limits = groups.map((g) => fitRows([Math.min(MAX_WINDOWS[family] ?? 2, g.rows.length)], scale, available, 0, g.rows.length > 0 ? 0 : message)[0]);
  } else {
    between = family === "small" ? 8 : 12;
    const mins = groups.map((g) => (g.rows.length > 0 ? 0 : message));
    limits = fitRows(counts(family === "small" && two ? MAX_WINDOWS.small : MAX_WINDOWS_SINGLE[family] ?? 4), scale, available, between, mins, ranks);
  }
  const laid = groups.map((g, i) => {
    const rows = visibleRows(g.rows, limits[i]);
    const shown = rows.filter((r) => r.kind === "window").map((r) => r.window.id);
    const fresh = view?.[g.provider] && shown.length > 0 ? freshnessOf(view, g.provider, now, shown) : null;
    // When showing previous values, add ⚠ to the header dot (small has no room for the notice row below)
    const freshness = fresh && cached ? { level: fresh.level === "fresh" ? "stale" : fresh.level, text: `${WARN_MARK} ${fresh.text}`.trim() } : fresh;
    return { ...g, rows, freshness };
  });
  // Height of the large chart: what's left after the two (or one) columns, between min and max
  const columns = Math.max(0, ...laid.map((g) => groupHeight(scale, g.rows.length, g.rows.length > 0 ? 0 : message)));
  // 0 means no chart
  const trendHeight = withChart
    // Allow 10% extra column height for estimation error (the chart can shrink, so the bars don't disappear on overflow)
    ? Math.max(TREND_MIN_HEIGHT, Math.min(TREND_MAX_HEIGHT, Math.floor(available - columns * 1.1 - trendChrome(scale))))
    : 0;
  return { content, scale, pad, size, inner, large, lift, showNote, two, between, trendHeight, groups: laid };
}

/** Estimated height of one group (header, rows, spacing) */
function groupHeight(scale, rows, minBody = 0) {
  return scale.header + scale.gapHeader + Math.max(minBody, rows * scale.rowHeight + Math.max(0, rows - 1) * scale.gapRow);
}

/**
 * Number of rows that fit the height. Reduce the per-group row counts `counts` one row at a time, from the group with the most rows
 * (the later one on a tie), until the total height fits `available` (later rows have lower priority: scoped limits come after overall ones)
 */
function fitRows(counts, scale, available, between, minBody = 0, ranks = null) {
  const rows = [...counts];
  const mins = Array.isArray(minBody) ? minBody : rows.map(() => minBody);
  // Row priorities per group (best first). The next row to drop is sorted[rows - 1]
  const sorted = (ranks ?? rows.map(() => [])).map((r) => [...r].sort((a, b) => a - b));
  const nextDrop = (i) => sorted[i][rows[i] - 1] ?? 0;
  const total = () => rows.reduce((sum, r, i) => sum + groupHeight(scale, r, mins[i] ?? 0), 0) + between * Math.max(0, rows.length - 1);
  while (total() > available) {
    let pick = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] <= 1) continue;
      // Drop lower-priority rows first (scoped limits, the no-5h row). On a tie, the group with more rows, then the later one
      if (pick < 0 || nextDrop(i) > nextDrop(pick) || (nextDrop(i) === nextDrop(pick) && rows[i] >= rows[pick])) pick = i;
    }
    if (pick < 0) break;
    rows[pick]--;
  }
  return rows;
}

/**
 * Frame for the content: fix the width to the inside of the padding (from the size table) and center it horizontally and vertically in the widget.
 * Even on devices larger than the table, content isn't off-center and padding is even on all sides. lift is the visual-center correction (extra space below)
 */
function centeredBody(widget, width, lift = 0) {
  widget.addSpacer(null);
  const page = widget.addStack();
  page.layoutHorizontally();
  page.addSpacer(null);
  const body = page.addStack();
  body.layoutVertically();
  body.size = new Size(width, 0);
  page.addSpacer(null);
  if (lift > 0) widget.addSpacer(lift);
  widget.addSpacer(null);
  return body;
}

/** Font, bar and spacing sizes per widget size (points) */
const SCALES = {
  // header is the estimated header height (a text line is about 1.2x the font size). rowHeight is built below from the same formula used for drawing
  small: { compact: true, icon: 13, name: 12, label: 10, pct: 10, small: 9, bar: 5, gapBar: 2, gapSub: 2, gapRow: 3, gapHeader: 3, header: 15 },
  medium: { compact: false, icon: 15, name: 13, label: 12, pct: 13, small: 10, bar: 8, gapBar: 3, gapSub: 2, gapRow: 7, gapHeader: 6, header: 16 },
  large: { compact: false, icon: 17, name: 15, label: 13, pct: 15, small: 11, bar: 10, gapBar: 3, gapSub: 2, gapRow: 8, gapHeader: 7, header: 18 },
};
// The height of one limit (for estimating visible rows) is built from the same formula as the fixed height used when drawing (so they don't drift)
for (const [family, s] of Object.entries(SCALES)) s.rowHeight = rowHeightOf(s, SIZE_CONTENT[family]);
SCALES.extraLarge = SCALES.large;

function render(result, family, parameter, now) {
  const widget = drawWidget(result, family, parameter, now);
  // If a drawn warning (run-out time) is earlier than the next refresh, ask to be redrawn at that time
  widget.refreshAfterDate = refreshAfter(widget.__outs ?? [], now);
  return widget;
}

function drawWidget(result, family, parameter, now) {
  const widget = new ListWidget();
  const accessory = String(family).startsWith("accessory");
  // Same padding on all sides
  const pad = PADDING[family] ?? 0;
  widget.setPadding(pad, pad, pad, pad);
  if (result.error) {
    addSmallText(widget, family === "accessoryInline" ? `Headroom: ${result.error}` : result.error, 12, SUB());
    return widget;
  }
  const cached = result.cachedAt !== undefined;
  const note = cached ? cachedNote(result.cachedAt, now) : "";
  const param = String(parameter ?? "").trim();
  if (family === "accessoryInline") {
    const items = param && param.toLowerCase() !== "top" ? lockPicks(result.view, param, now) : selectWindows(result.view, "top", now);
    if (!(param && param.toLowerCase() !== "top")) {
      for (const p of PROVIDER_ORDER) {
        // A failure without a reason code is also No data
        const v = result.view?.[p];
        const failed = Boolean(v?.error_code) || v?.status === "error";
        if (failed && !items.some((x) => x.provider === p)) items.push({ missing: true, provider: p, providerName: PROVIDER_NAMES[p], label: ERROR_NAMES[v.error_code] ?? "No data" });
      }
      items.sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
    }
    widget.addText(inlineText(items, cached, result.demo ? "Demo · " : ""));
    return widget;
  }
  if (family === "accessoryCircular") {
    const pick = lockPicks(result.view, param, now)[0];
    const top = pick && !pick.missing ? pick : null;
    const provider = pick?.provider ?? "claude";
    const icon = iconImage(provider);
    const ring = top ? ringOf(top.window) : null;
    const img = widget.addImage(ringImage(icon, ring, BRAND_COLORS[provider], LOCK_RINGS.circular, provider, top ? compactPercent(top.window) : "–"));
    img.imageSize = new Size(LOCK_RINGS.circular.size, LOCK_RINGS.circular.size);
    img.centerAlignImage?.();
    // Limit name and marks (⚠ for previous values, reset estimate, staleness). Demo for the demo
    const mark = top ? [cached ? WARN_MARK : "", shortMark(top.window)].filter(Boolean).join(" ") : "";
    const reason = !top && pick?.missing ? pick.short : "";
    const name = reason ? (result.demo ? `Demo · ${reason}` : reason) : result.demo ? "Demo" : top ? shortName(top.window) : "";
    if (name || mark) {
      const s = widget.addText(mark ? `${name} ${mark}`.trim() : name);
      s.font = Font.systemFont(9);
      s.lineLimit = 1;
      s.minimumScaleFactor = 0.7;
      s.centerAlignText();
    }
    return widget;
  }
  if (accessory) {
    widget.__outs = [];
    // Lock screen (rectangle): the limits chosen by the parameter. One: ring on the left, text on the right; two: side by side
    const picks = lockPicks(result.view, param, now);
    if (picks.length >= 2) {
      drawLockPair(widget, picks, result, now, cached);
      return widget;
    }
    const top = picks[0] && !picks[0].missing ? picks[0] : null;
    if (!top) {
      const missing = picks[0]?.missing
        ? `${picks[0].providerName}${picks[0].label.startsWith("5h:") ? " " : ": "}${picks[0].label}`
        : "No data yet";
      addSmallText(widget, result.demo ? `Demo · ${missing}` : missing, 11, SUB());
      return widget;
    }
    const w = top.window;
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const ringImg = row.addImage(ringImage(iconImage(top.provider), ringOf(w), BRAND_COLORS[top.provider], LOCK_RINGS.rectangular, top.provider));
    ringImg.imageSize = new Size(LOCK_RINGS.rectangular.size, LOCK_RINGS.rectangular.size);
    row.addSpacer(8);
    const col = row.addStack();
    col.layoutVertically();
    const mark = shortMark(w);
    // The heading is "Codex · Weekly". If it doesn't fit, drop the provider name (the icon in the ring identifies it)
    const full = `${top.providerName} · ${limitName(w)}`;
    const head = col.addText(textWidth(full, 12) * 0.8 <= LOCK_TITLE_WIDTH ? full : limitName(w));
    head.font = Font.semiboldSystemFont(12);
    head.lineLimit = 1;
    head.minimumScaleFactor = 0.8;
    // Next to the large remaining value, small staleness and reset-estimate marks (keeps the heading short)
    const value = col.addStack();
    value.layoutHorizontally();
    value.bottomAlignContent();
    const pct = value.addText(compactPercent(w));
    pct.font = Font.boldSystemFont(22);
    pct.textColor = TEXT();
    pct.lineLimit = 1;
    if (mark || result.demo) {
      value.addSpacer(4);
      addSmallText(value, [result.demo ? mark.replace(/ ago$/, "") : mark, result.demo ? "Demo" : ""].filter(Boolean).join(" · "), 10, SUB());
    }
    const sub = col.addStack();
    sub.layoutHorizontally();
    sub.centerAlignContent();
    if (note) addSmallText(sub, `${WARN_MARK} Can't update`, 11, SUB());
    else addLockTime(sub, w, now, 11, widget.__outs);

    return widget;
  }

  // Home screen: compute the inner width from the device's widget size, then draw in a centered frame of that width
  const layout = layoutGroups(result.view, family, param, now, { cached, screen: screenSize() });
  const { content, scale, inner, groups, two, large } = layout;
  const body = centeredBody(widget, inner, layout.lift);
  const base = { content, now, trends: result.trends ?? null, rows: Infinity, demo: Boolean(result.demo), outs: [] };
  if (groups.length === 0 || groups.every((g) => g.rows.length === 0 && g.message === "No data")) {
    addSmallText(body, "No data yet", 12, SUB());
  } else if (large) {
    // Large: Claude and Codex side by side, with one full-width chart below overlaying both trends
    if (two) {
      const gap = 14;
      const colWidth = Math.floor((inner - gap) / 2);
      const cols = body.addStack();
      cols.layoutHorizontally();
      cols.topAlignContent();
      for (const [index, group] of groups.slice(0, 2).entries()) {
        if (index > 0) cols.addSpacer(gap);
        const col = cols.addStack();
        col.layoutVertically();
        col.size = new Size(colWidth, 0);
        drawGroup(col, group, withFit(groups.slice(0, 2), { ...base, scale, width: colWidth }));
      }
    } else {
      drawGroup(body, groups[0], withFit(groups.slice(0, 1), { ...base, scale, width: inner }));
    }
    if (layout.trendHeight > 0) {
      body.addSpacer(TREND_GAP);
      drawCombinedTrend(body, groups.slice(0, 2), { ...base, scale, width: inner, height: layout.trendHeight, view: result.view });
    }
  } else if (two && family !== "small") {
    // Medium: Claude and Codex side by side. Column width is fixed to half the inner width (long text doesn't widen a column)
    const gap = 14;
    const colWidth = Math.floor((inner - gap) / 2);
    const cols = body.addStack();
    cols.layoutHorizontally();
    cols.topAlignContent();
    for (const [index, group] of groups.slice(0, 2).entries()) {
      if (index > 0) cols.addSpacer(gap);
      const col = cols.addStack();
      col.layoutVertically();
      col.size = new Size(colWidth, 0);
      drawGroup(col, group, withFit(groups.slice(0, 2), { ...base, scale, width: colWidth }));
    }
  } else {
    // Small, or a single provider: stacked top to bottom
    for (const [index, group] of groups.entries()) {
      if (index > 0) body.addSpacer(layout.between);
      drawGroup(body, group, withFit(groups, { ...base, scale, width: inner }));
    }
  }
  widget.__outs = base.outs;
  // Only when showing previous values, put that notice at the bottom (small has only the ⚠ in the header)
  if (layout.showNote) {
    body.addSpacer(4);
    const row = body.addStack();
    row.layoutHorizontally();
    row.addSpacer(null);
    addSmallText(row, note, 9, SUB());
  }
  return widget;
}

// ------------------------------------------------------------------------------------------------
// Startup (after all constants and functions are defined; Node tests receive only the pure functions)
// Whether we are inside Scriptable is decided by whether the Scriptable API exists. Scriptable also defines module (exports is an empty
// object) for every script, so the presence of module can't tell them apart (https://docs.scriptable.app/module/)

if (typeof Script !== "undefined" && typeof ListWidget !== "undefined") {
  await main();
} else if (typeof module !== "undefined") {
  module.exports = {
    HEADROOM_VERSION, VIEW_VERSION, KEYCHAIN_CONFIG, KEYCHAIN_LEGACY, MAX_WINDOWS, normalizeBaseUrl, buildRequest, validateSetup, sanitizeView,
    atDisplayTime, shortMark, selectWindows, groupsOf, barSegments, barWidths, windowName, limitLabel, shortName,
    percentText, compactPercent, demoName, demoResult, DEMO_SCENARIOS, rowPlan, textWidth, fittedSizes, ringOf, ringImage, LOCK_RINGS, lockPicks, drawLockPair, LOCK_TITLE_WIDTH, INLINE_WIDTH, SHORT_ERROR_NAMES, timeShort, whenShort, TIME_SYMBOLS, limitName, refreshAfter, inlineText, segmentShape, BRAND_COLORS, ICONS,
    SIZE_CONTENT, paceText, sanitizeHistory, sparkLines, trendWindows, clockText, widgetSize, PADDING, drawnJunction,
    projectionOf, barSegmentsAt, barPieces, freshnessOf, resetShort, rowMark, SCALES, WARN_MARK, BAR_COLORS, PROVIDER_ORDER, NOT_AVAILABLE, trendDrawOrder, lineHeight, subHeight, rowHeightOf, FRESH_COLORS, fitRows, groupHeight, thinPoints, paceOf, visibleRows, sanitizeBoundaries, layoutGroups, rowRank, trendSeries, timerWidth, remainingText, trendY, TREND_HOURS, weekRange, dayStarts, trendX, WEEKDAYS,
    resetDate, errorText, cachedNote, readCache, originTag, cacheTag, sameConfig, DEFAULT_CONFIG_ID, cacheFileName, seenFileName, pickCache, seenFrom, OWN_FILE, formatDuration,
  };
}
