// Headroom's iPhone widget (Scriptable).
//
// - Reads GET /v2/view from the server and draws 0-100% bars for the 5-hour, weekly and other limits. Recent consumption is gray inside the bar
// - Credentials (the server origin and the Worker read token) are kept only in Scriptable's
//   Keychain, never in the script body, URLs, logs or the saved view. On first use, run it in the app and enter them
// - The widget parameter chooses which limits to show: empty (Codex and Claude, and any other provider with values), one to three
//   providers (gemini; claude, gemini; codex, claude, gemini), top, claude.five_hour,codex.seven_day (a list of window keys)
// - When fetching fails, shows the previous view (saved on the device; only the needed fields, no account info) marked as old
// - Staleness and "reset (estimated)" are recomputed at draw time (the widget may be shown later than it was fetched)
//
// From here down to "Widget rendering below" everything is a pure function that doesn't use the Scriptable API (tested with Node).
// Startup is at the end (main runs after all constants are defined)

const HEADROOM_VERSION = 69;
/** View version this script can read (VIEW_VERSION in packages/core) */
const VIEW_VERSION = 1;
/** Settings are stored as JSON in a single Keychain item (so the server and credentials are always read as a pair) */
const KEYCHAIN_CONFIG = "headroom.config";
/**
 * Since version 65 each settings generation keeps its own items (settings and switches), and this item only names the current
 * generation. A run of older settings removes only its own items, so it can never remove settings or switches saved meanwhile; this
 * item is never removed (it holds no secret: a generation whose items are gone reads as no settings). The single items of earlier
 * versions are still read until the next save
 */
const KEYCHAIN_CURRENT = "headroom.current";
function configKey(id) {
  return `headroom.config.${id}`;
}
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
const FRESH_MAX_MINUTES = 20;
const CAUTION_MAX_MINUTES = 75;
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
/**
 * Provider colors (Claude orange, Codex blue-violet to match its icon, Gemini a light blue apart from Codex's). Fixed colors because
 * they are also passed to DrawContext
 */
const BRAND_COLORS = { claude: "#D97757", codex: "#6E7CF7", gemini: "#1A9FD6" };
/** Wording when there is no 5-hour limit */
const NOT_AVAILABLE = "Not available";
/** Order of providers (from the left / top; Codex first) */
const PROVIDER_ORDER = ["codex", "claude", "gemini"];
/** Shown when the parameter names none: these, then any other provider the view has values of (in PROVIDER_ORDER) */
const DEFAULT_PROVIDERS = ["codex", "claude"];
/** Providers shown side by side at most (the parameter names one to this many) */
const MAX_PROVIDERS = 3;
/**
 * Providers the view has carried from its first version: a view without one of them is malformed. A later one may be absent (from an
 * earlier Worker) and reads as no value
 */
const VIEW_PROVIDERS = ["claude", "codex"];
/**
 * Providers whose fetch isn't verified on a real machine yet: turned off on the PCs by default, so without values of theirs they are
 * shown as not supported (not as missing data)
 */
const UNVERIFIED_PROVIDERS = ["gemini"];
/** Short provider names for the lock screen's line when the names don't fit otherwise (three providers) */
const SHORT_PROVIDER_NAMES = { codex: "Cx", claude: "Cl", gemini: "Gm" };
/** Shown where the limits (and on the lock screen, the limit name) of a provider not supported yet would be */
const NOT_SUPPORTED = "Not supported";
/** Without an icon image: the SF Symbol, the letter drawn in the lock screen ring and the mark of the details screen */
const FALLBACK_MARKS = {
  claude: { symbol: "asterisk", letter: "C", css: "✳︎" },
  codex: { symbol: "terminal", letter: "X", css: ">_" },
  gemini: { symbol: "sparkle", letter: "G", css: "✦" },
};
/**
 * Usage warning mark. The only warning is "likely to run out before reset" (a low remaining amount is fine if it won't run out).
 * Conveyed with a monochrome ⚠ and text, not color (bars use only the provider color and gray). Medium, large and the lock screen rectangle show ⚠ and the run-out time
 * in place of the reset time in the time row; small, which has no time row, puts ⚠ before the remaining number
 */
// Add the text variation selector (U+FE0E). Without it iOS may draw a yellow emoji
const WARN_MARK = "⚠︎";
/**
 * Mark of a value whose reset time has passed since its fetch (shown as 0% used until a newer value comes). The same symbol as the reset
 * time, so sizes without a time row (small, lock screen circle and line) put it before the value, as ⚠ is
 */
const RESET_MARK = "↻";
/**
 * Icon images (base64 PNG). Not kept in the repository (they are the vendors' logos). scripts/build.ts embeds
 * packages/scriptable/icons/<provider>.png and writes dist/Headroom.js. If empty, SF Symbols are used instead
 */
const ICONS = { claude: "", codex: "", gemini: "" }; // @icons

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

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
/** Plan display names (KNOWN_PLANS in packages/core) */
const PLAN_NAMES = {
  free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", max: "Max", ultra: "Ultra",
  team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu",
};
/** Reasons for a missing value (ErrorCode in packages/core) */
const ERROR_NAMES = {
  login_required: "Sign in required", not_installed: "Not installed", fetch_failed: "Couldn't fetch",
  safety_stop: "Paused for safety", account_changed: "Account changed, paused", access_denied: "Access denied",
};
/** Short display names for some scopes (names from KNOWN_SCOPES in packages/core) */
const SCOPE_NAMES = { "Codex extra": "Extra", codex_other: "Other", "Claude and GPT": "Claude/GPT" };
/**
 * Display name of a scope: its short name if known, the scope itself if it is one plain word (letters, digits, . _ -, up to 24), otherwise
 * "Other" (what a notification or the lock screen shows never carries an unexpected string)
 */
function scopeName(scope) {
  if (!scope) return null;
  return SCOPE_NAMES[scope] ?? (/^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/.test(scope) ? scope : "Other");
}
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
    // Span of the recent consumption (the gray part of the bar) in minutes: 60 for the 5-hour limit, 1440 for the weekly limit
    recent_minutes: num(w.recent_minutes),
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
    // Shown in the details only (e.g. Gemini's Claude and GPT models): never on the widget unless named, nor in reminders. Absent from
    // older servers, which have no such window
    detail_only: w.detail_only === true,
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
  const error_code = oneOf(p.error_code, Object.keys(ERROR_NAMES));
  // Stopped by an access denial: none of its values is shown (they would read as current), only the stop
  const denied = error_code === "access_denied";
  return {
    status: oneOf(p.status, PROVIDER_STATUSES),
    plan: oneOf(p.plan, Object.keys(PLAN_NAMES)),
    error_code,
    // At its limit (true / false / unknown); the header dot turns red while values stop updating at the limit
    blocked: typeof p.blocked === "boolean" ? p.blocked : null,
    main_window_ids: denied ? [] : main, window_ids: denied ? [] : all, windows: denied ? {} : windows,
  };
}

/**
 * Validate the server response and keep only the fields needed for display (also the saved shape; extra fields and unknown versions are neither saved nor shown).
 * null if unreadable
 */
function sanitizeView(body) {
  if (!body || typeof body !== "object" || body.view_version !== VIEW_VERSION) return null;
  if (!VIEW_PROVIDERS.every((p) => p in body)) return null;
  // A valid response with every provider null (no values, or the previous account's values were removed) is a success and replaces the
  // previous view. A provider the view may not carry (an earlier Worker's) reads as null
  const providers = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, sanitizeProvider(body[p])]));
  if (Object.values(providers).some((p) => p === undefined)) return null;
  // Number of the data read (compared with the previous view to tell which is newer; the order of the data, not when the response was made)
  const dataVersion = body.data_version;
  if (!Number.isSafeInteger(dataVersion) || dataVersion < 0) return null;
  return { view_version: VIEW_VERSION, data_version: dataVersion, boundaries: sanitizeBoundaries(body.boundaries), ...providers };
}

/**
 * Per-provider boundary stamp (time and sequence number only). null if malformed (falls back to not showing the trend). A provider the
 * stamps may not carry (an earlier Worker's, an earlier version's saved state) is null there: its stamp isn't known
 */
const STAMP = /^([0-9TZ:.\-]{0,40}#\d{1,15})?$/;
function sanitizeBoundaries(b) {
  if (!b || typeof b !== "object") return null;
  const ok = (v) => typeof v === "string" && STAMP.test(v);
  if (!VIEW_PROVIDERS.every((p) => ok(b[p]))) return null;
  if (PROVIDER_ORDER.some((p) => b[p] !== undefined && b[p] !== null && !ok(b[p]))) return null;
  return Object.fromEntries(PROVIDER_ORDER.map((p) => [p, ok(b[p]) ? b[p] : null]));
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
  // Judged on the time itself; only the minutes shown are rounded down
  const ms = Number.isFinite(fetched) ? Math.max(0, now.getTime() - fetched) : null;
  const age = ms === null ? null : Math.floor(ms / 60000);
  const status = passed ? "reset_estimated"
    : ms === null ? null
    : ms <= FRESH_MAX_MINUTES * 60000 ? "fresh" : ms <= CAUTION_MAX_MINUTES * 60000 ? "stale" : "old";
  const used = passed ? 0 : w.used_percent;
  // A limit at 100% can't be used further, so once the recent span has passed since the fetch, nothing was used in it
  const settledAt = recentSettledAt(w);
  const settled = !passed && settledAt !== null && settledAt <= now.getTime();
  const recentQuality = passed ? "unknown" : settled ? "exact" : w.recent_quality;
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
    recent_consumed_percent: passed ? null : settled ? 0 : w.recent_consumed_percent,
    recent_quality: recentQuality,
    reset_passed: passed,
    value_status: status,
    age_minutes: age,
    status_text: [valueText, recentText, forecastText].filter(Boolean).join(" · "),
  };
}

/**
 * When the recent consumption of a limit at 100% becomes 0 (its fetch plus the recent span; nothing more can be used at the limit).
 * null if the limit isn't at 100%, has no recent consumption, or its span or fetch time is unknown
 */
function recentSettledAt(w) {
  const fetched = Date.parse(w.fetched_at ?? "");
  const span = typeof w.recent_minutes === "number" && w.recent_minutes > 0 ? w.recent_minutes : null;
  if (w.used_percent < 100 || !(w.recent_consumed_percent > 0) || span === null || !Number.isFinite(fetched)) return null;
  return fetched + span * 60000;
}

/**
 * Short mark (lock screen). ↻ for a value whose reset time has passed since its fetch (shown as 0% used until a newer value comes; left out
 * where a time row says "↻ Reset"), or the age the home screen shows next to its gray dot (32m, 2h; over 15 minutes).
 * The lock screen has no colors, so the dot itself isn't drawn: fresh values, values of unknown age (gray dot alone) and values at the limit
 * (red dot alone) get no mark, as at home. Approximate values get no mark either
 */
function shortMark(w, timeRow = false) {
  if (w.value_status === "reset_estimated") return timeRow ? "" : RESET_MARK;
  if ((w.value_status === "stale" || w.value_status === "old") && !w.provider_blocked) return formatDuration(w.age_minutes);
  return "";
}

/** A limit as shown on the lock screen: its display-time values and whether its provider is at its limit (for the staleness mark) */
function lockWindow(view, provider, w, now) {
  return { ...atDisplayTime(w, now), provider_blocked: view?.[provider]?.blocked === true };
}

/**
 * The providers a parameter names on its own, one to MAX_PROVIDERS in its order ("gemini", "claude, gemini", "codex claude gemini").
 * null if it names anything else (empty, top, window keys)
 */
function providerList(parameter) {
  const words = String(parameter ?? "").trim().toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0 || !words.every((w) => PROVIDER_ORDER.includes(w))) return null;
  return [...new Set(words)].slice(0, MAX_PROVIDERS);
}

/** The providers shown when the parameter names none: the default ones, then any other the view has values of */
function defaultProviders(view) {
  return [...DEFAULT_PROVIDERS, ...PROVIDER_ORDER.filter((p) => !DEFAULT_PROVIDERS.includes(p) && view?.[p])].slice(0, MAX_PROVIDERS);
}

/** Why a provider shown has no value: not supported yet (a provider whose fetch isn't verified, turned off on the PCs), or no data */
function missingText(provider) {
  return UNVERIFIED_PROVIDERS.includes(provider) ? NOT_SUPPORTED : "No data";
}

/**
 * Choose the windows to show. Returns a list of { provider, providerName, window } in display order; windows are recomputed at draw time.
 * By default the providers' overall limits (main_window_ids) come first; per-model and per-group limits are appended only at 100%.
 * A limit shown in the details only is never chosen unless the parameter names it
 */
function selectWindows(view, parameter, now) {
  const param = String(parameter ?? "").trim().toLowerCase();
  const named = providerList(param);
  const out = [];
  const push = (provider, id) => {
    const w = view?.[provider]?.windows?.[id];
    if (w && !out.some((x) => x.provider === provider && x.window.id === id)) {
      out.push({ provider, providerName: PROVIDER_NAMES[provider], window: lockWindow(view, provider, w, now) });
    }
  };
  const main = (provider) => {
    for (const id of view?.[provider]?.main_window_ids ?? []) push(provider, id);
  };
  const full = (provider) => {
    for (const id of view?.[provider]?.window_ids ?? []) {
      const w = view[provider].windows[id];
      if (w.scope !== null && !w.detail_only && atDisplayTime(w, now).used_percent >= 100) push(provider, id);
    }
  };
  if (param === "top") {
    for (const provider of defaultProviders(view)) {
      const p = view?.[provider];
      if (!p) continue;
      const ids = p.main_window_ids.length > 0 ? p.main_window_ids : p.window_ids.filter((id) => !p.windows[id].detail_only);
      const top = ids.reduce((a, id) => {
        const w = atDisplayTime(p.windows[id], now);
        return a === null || w.used_percent > a.used ? { id, used: w.used_percent } : a;
      }, null);
      if (top) push(provider, top.id);
    }
  } else if (param.includes(".")) {
    for (const key of param.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [provider, id] = key.split(".");
      if (PROVIDER_ORDER.includes(provider)) push(provider, id);
    }
  } else {
    const providers = named ?? defaultProviders(view);
    for (const provider of providers) main(provider);
    for (const provider of providers) full(provider);
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
  // Shown in full (the "no 5h" row, per-model limits on large): the providers listed, or by default
  const listed = param === "" ? defaultProviders(view) : providerList(param) ?? [];
  // Shown even without a limit to draw (so a provider named without values, or one whose fetch failed, says why): those listed, the
  // providers named in window keys, or the default ones of top
  const keyed = param.includes(".")
    ? [...new Set(param.split(",").map((k) => k.trim().split(".")[0]).filter((p) => PROVIDER_ORDER.includes(p)))]
    : null;
  const shown = param === "top" ? defaultProviders(view) : keyed ?? listed;
  const order = [...shown];
  for (const x of items) if (!order.includes(x.provider)) order.push(x.provider);
  const groups = [];
  for (const provider of order) {
    const p = view?.[provider] ?? null;
    const rows = items.filter((x) => x.provider === provider).map((x) => ({ kind: "window", window: x.window }));
    // Always show per-model and per-group limits (large): append them after the overall limits even below 100%
    if (options.allScoped && listed.includes(provider) && p) {
      for (const id of p.window_ids) {
        if (p.windows[id].scope !== null && !p.windows[id].detail_only && !rows.some((r) => r.window.id === id)) {
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
      message: !p ? missingText(provider) : rows.length === 0 ? ERROR_NAMES[p.error_code] ?? "No limits to show" : null,
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

/**
 * Freshness of a provider's values (the header dot), by time since fetch: fresh, caution (over 15 min), old (over 60 min).
 * While the provider is at its limit the dot is "limit" (red) whatever the age: fetching slows down to about once an hour until the reset,
 * so a dot by age would turn green for a few minutes after each fetch. Once the limit has most likely lifted (limitLifted), the dot goes
 * back to the age. At the limit the dot is red even when the fetch time is unknown
 */
function freshnessOf(view, provider, now, ids = null) {
  const p = view?.[provider];
  const list = ids ?? (p?.main_window_ids?.length ? p.main_window_ids : Object.keys(p?.windows ?? {}));
  let oldest = null;
  for (const id of list) {
    const t = Date.parse(p?.windows?.[id]?.fetched_at ?? "");
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  // At the limit the red dot says enough (values are expected to stop updating), so no age is shown
  if (p?.blocked === true && !limitLifted(p, list, now)) return { level: "limit", text: "" };
  if (oldest === null) return { level: "unknown", text: "" };
  const ms = Math.max(0, now.getTime() - oldest);
  if (ms <= FRESH_MAX_MINUTES * 60000) return { level: "fresh", text: "" };
  return { level: ms <= CAUTION_MAX_MINUTES * 60000 ? "stale" : "old", text: formatDuration(Math.floor(ms / 60000)) };
}

/**
 * Whether a provider's limit has most likely lifted since its values were fetched: some listed limit's reset time has passed, and no
 * listed or overall limit of the provider is still at 100% with its reset ahead. (A view the server built after the reset already shows the passed limit as 0%,
 * so the limit that was hit can't be told from the values; the flag only says the provider was at a limit when fetched)
 */
function limitLifted(p, ids, now) {
  const windows = ids.map((id) => p?.windows?.[id]).filter(Boolean);
  const overall = (p?.main_window_ids ?? []).map((id) => p?.windows?.[id]).filter(Boolean);
  const passed = (w) => {
    const reset = Date.parse(w.resets_at ?? "");
    return Number.isFinite(reset) && reset <= now.getTime();
  };
  return windows.some(passed) && ![...windows, ...overall].some((w) => w.used_percent >= 100 && !passed(w));
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
 * (the widget cannot be redrawn sooner than a minute later). Each countdown, once passed with no newer value, leaves its symbol and
 * names what it counted down to: ⚠ "Limit" (the run-out time passed: the limit is likely reached) until the reset, and ↻ "Reset" (the
 * reset time passed: shown as 0% used until a newer value comes). Otherwise the reset time
 */
function timeShort(window, now) {
  const p = projectionOf(window, now);
  if (p?.runsOut && p.at) {
    if (p.at - now.getTime() < 60000) return { warn: true, kind: "text", text: "Soon" };
    return { warn: true, ...whenShort(new Date(p.at), now) };
  }
  if (runOutPassed(window, now)) return { warn: true, kind: "text", text: "Limit" };
  const reset = resetShort(window, now);
  if (reset) return { warn: false, ...reset };
  return resetPassed(window, now) ? { warn: false, kind: "text", text: "Reset" } : null;
}

/** Whether the limit's reset time has passed */
function resetPassed(w, now) {
  const reset = Date.parse(w.resets_at ?? "");
  return Number.isFinite(reset) && reset <= now.getTime();
}

/**
 * Whether the forecast run-out time has passed with no newer value, before the reset (the same forecast projectionOf draws until then)
 */
function runOutPassed(w, now) {
  const reset = Date.parse(w.resets_at ?? "");
  if (!Number.isFinite(reset) || reset <= now.getTime()) return false;
  const before = projectionOf(w, new Date(Date.parse(w.fetched_at ?? "")));
  return Boolean(before?.runsOut && before.at !== null && before.at <= now.getTime() && before.at < reset);
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
  // An unknown window is named by its label only if it is one plain word (never an unexpected string)
  const label = String(w.label ?? "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,23}$/.test(label) ? label : "Limit";
}

/** Row heading (e.g. 5h limit, Weekly limit · Opus) */
function limitLabel(w) {
  const scope = scopeName(w.scope);
  // Per-model and per-group limits are short (e.g. Fable weekly) so long headings that don't fit the column aren't cut off
  return scope ? `${scope} ${windowName(w).toLowerCase()}` : `${windowName(w)} limit`;
}

/** Limit name in the heading of the lock screen rectangle (e.g. 5h, Weekly, Fable weekly) */
function limitName(w) {
  const scope = scopeName(w.scope);
  return scope ? `${scope} ${windowName(w).toLowerCase()}` : windowName(w);
}

/** Short name for the lock screen (e.g. 5h, Wk, Mo) */
function shortName(w) {
  const name = windowName(w);
  const short = name === "Weekly" ? "Wk" : name === "Monthly" ? "Mo" : name;
  const scope = scopeName(w.scope);
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
 * One line on the lock screen. Until the full text (including the demo prefix) fits: drop the staleness mark ->
 * shorten scoped limit names (Wk Fable -> Fable) -> drop limit names (5h, Wk) -> drop scoped names too.
 * The ⚠ for failed updates, the remaining value and the ↻ before a value reset since its fetch are kept
 */
function inlineText(items, cached, prefix = "") {
  const build = (step) => {
    const body = items.map((x) => {
      // Last of all, the provider's short name
      const who = step >= 7 ? SHORT_PROVIDER_NAMES[x.provider] ?? x.providerName : x.providerName;
      if (x.missing) {
        // Last of all, the reason's short form too (Not supported as N/A)
        const reason = step >= 7 ? (x.label === NOT_SUPPORTED ? "N/A" : x.short ?? x.label) : x.label;
        return `${who} ${reason.startsWith("5h:") || reason.startsWith("5h ") ? "5h N/A" : reason}`;
      }
      const reset = x.window.value_status === "reset_estimated";
      const mark = step <= 1 && !reset ? shortMark(x.window) : "";
      const scope = scopeName(x.window.scope);
      const name = step >= 6 ? "" : step >= 3 && scope ? scope : step >= 5 ? "" : shortName(x.window);
      const value = reset ? `${RESET_MARK}${compactPercent(x.window)}` : compactPercent(x.window);
      return [who, name, value].filter(Boolean).join(" ") + (mark ? ` (${mark})` : "");
    }).join(" · ") || "Headroom";
    return `${prefix}${cached ? `${WARN_MARK} ${body}` : body}`;
  };
  const tries = [0, 1, 2, 3, 5, 6, 7].map(build);
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
const OWN_FILE = /^(headroom-view-[0-9a-f]{2,600}-\d{1,15}\.json|headroom-seen-[0-9a-f]{2,600}-\d{1,15}|headroom-view(-\d{1,15})?\.json|headroom-events-[0-9a-f]{2,600}-\d{1,15}|headroom-notify-[0-9a-f]{2,600}\.json|headroom-lock-[0-9a-f]{2,600}|headroom-(intent|told|pair|abort)-[0-9a-f]{2,600}-[0-9a-f-]{1,60}(\.json)?)$/;

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

// ---- Notifications (pure part) ----
// Only one run notifies: the widget whose parameter includes "notify", or a shortcut that runs this script with "notify" (several
// notifying runs would ring the same alert more than once). Two kinds, each can be turned off in the app menu:
// - Time reminders: scheduled on the device from the view, so they ring on time even if the widget isn't redrawn
// - Limit alerts: events the server judged (GET /v2/events), told on the next run (as late as iOS redraws the widget)

/** Keychain item for notification preferences ({ events, times }; both on when absent) */
const KEYCHAIN_NOTIFY = "headroom.notify";
/** The switches' item of these settings (their own generation's; settings saved by an earlier version keep the shared one) */
function notifyKey(cfg) {
  return cfg?.keyed ? `headroom.notify.${configId(cfg)}` : KEYCHAIN_NOTIFY;
}
/** The run-out reminder rings this many minutes before the forecast run-out time */
const RUNOUT_LEAD_MINUTES = 15;
/**
 * Time reminders waiting on the device at most (the earliest to ring, among those not rung yet): iOS keeps 64 pending notifications per
 * app, and the rest are left for limit alerts. The ones that rang are records apart (to match deliveries) and never take a place
 */
const MAX_REMINDERS = 50;
/** Reminders the state keeps, the latest to ring first (every one waiting, then those that rang), the oldest dropped */
const KEPT_REMINDERS = 200;
/** Events older than this when read are not told (the moment has passed) */
const ALERT_MAX_AGE_MINUTES = 12 * 60;
/** Most alerts listed in one notification */
const MAX_ALERT_LINES = 5;
/** How long a notifying run holds its lock (longer than its reads can take; a run past it stops before changing anything) */
const LOCK_SECONDS = 120;
/** How long told cycles and fired reminders are remembered */
const NOTIFY_KEEP_MS = 8 * 24 * 60 * 60000;
/** Reset times this close are the same cycle (providers' reset times jitter by seconds to minutes) */
const CYCLE_TOLERANCE_MS = 10 * 60000;
/** Errors worth a notification (the kinds the server makes provider_error events of; a failed fetch retries on its own) */
/** What the details screen says to do about an access denial */
const DENIED_HINT = "The service denied access, so fetching stopped on every PC. Check the account, then run headroom collect --provider <name> --resume-access on a PC";
const ALERT_ERRORS = ["login_required", "safety_stop", "access_denied"];
/**
 * Monochrome symbols shared by the notifications and the details screen (characters without a color emoji form, or with the text
 * variation selector U+FE0E, so iOS draws them in the text color)
 */
const SYMBOLS = {
  reset: RESET_MARK, runout: WARN_MARK, lasts: "✓", limit: "⊘", pace: "↗︎", recent: "◔", left: "◑",
  sudden: "⇡", stopped: "⏸︎", resumed: "▶︎", unknown: "…",
};
/**
 * Notification title: the provider's name first, then the limit's full name, separated by a middle dot ("Claude · 5h limit"). iOS shows every Scriptable notification with
 * Scriptable's icon, so the name leads; notifications are also grouped per provider in Notification Center (threadIdentifier)
 */
function notifyTitle(provider, limit = null) {
  return [PROVIDER_NAMES[provider], limit].filter(Boolean).join(" · ");
}

/** Split the widget parameter into what to show and whether this run notifies ("notify" as one of its comma-separated items) */
function splitNotify(parameter) {
  const raw = String(parameter ?? "");
  const items = raw.split(",").map((s) => s.trim());
  if (!items.some((s) => s.toLowerCase() === "notify")) return { display: parameter ?? null, notify: false };
  return { display: items.filter((s) => s && s.toLowerCase() !== "notify").join(", "), notify: true };
}

/**
 * Notification preferences from the stored text (both on unless turned off). rev counts every change, so a run in flight notices a
 * switch turned off and on again (the same values, but its state may have been reset meanwhile). times_off_at and cancelled: when time
 * reminders were last turned off, and the identifiers of the reminders the menu cancelled then (removed while pending and not
 * delivered, so they never rang)
 */
function notifyPrefs(text) {
  const reminderId = /^headroom\.[0-9a-f]{16}\.(back|runout)\.[a-z]+\.[a-z0-9_]+\.\d+(\.[0-9a-fx]{1,16})?(\.[0-9a-f]{8})?$/;
  let p;
  try {
    // No stored value (null): both on. A stored value is read as it is (an empty one is not "none")
    p = text === null || text === undefined ? {} : JSON.parse(text);
  } catch (_) {
    // A stored value that can't be read is not taken for the defaults (null: the caller stops)
    return null;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if ((p.events !== undefined && typeof p.events !== "boolean") || (p.times !== undefined && typeof p.times !== "boolean")
    || (p.rev !== undefined && !Number.isSafeInteger(p.rev))) return null;
  const offAt = Number.isFinite(p.times_off_at) ? p.times_off_at : null;
  const cancels = Array.isArray(p.cancels)
    ? p.cancels.filter((c) => c && /^[0-9a-f]{8}$/.test(c.op ?? "") && /^[0-9a-f]{16}$/.test(c.gen ?? "") && Number.isFinite(c.before))
      .map((c) => ({ op: c.op, gen: c.gen, before: c.before })).slice(-20)
    : [];
  // An earlier format kept the identifiers alone: they were cancelled when time reminders were last turned off
  const entry = (c) => (typeof c === "string" ? { id: c, at: offAt ?? 0 } : c);
  return { events: p.events !== false, times: p.times !== false, rev: Number.isSafeInteger(p.rev) ? p.rev : 0, times_off_at: offAt,
    // Time reminders turned off, but cancelling them couldn't be confirmed yet (the next notifying run cancels and clears it)
    cancel_pending: p.cancel_pending === true || cancels.length > 0,
    // What each turning off still owes: the reminders of that generation scheduled before it (op names it, so settling one never settles
    // another)
    cancels,
    cancelled: Array.isArray(p.cancelled)
      ? p.cancelled.map(entry).filter((c) => c && typeof c.id === "string" && reminderId.test(c.id) && Number.isFinite(c.at)).map((c) => ({ id: c.id, at: c.at })).slice(-100)
      : [] };
}

/**
 * Reminders the menu cancelled when time reminders were turned off: those it removed (by identifier), scheduled before it was turned
 * off. They are forgotten, so an event doesn't take them for reminders that rang. A reminder that rang (delivered) is never among them
 */
function withoutCancelled(reminders, prefs) {
  const cancelled = prefs?.cancelled ?? [];
  if (cancelled.length === 0) return reminders;
  return reminders.filter((r) => !cancelled.some((c) => c.id === r.id && (Number.isFinite(r.set_at) ? r.set_at : 0) < c.at));
}

/**
 * Time reminders planned from the view (overall limits only):
 * - back: a provider at the limit gets one reminder at the latest reset among its overall limits at 100% (it can't be used until all of
 *   them reset)
 * - runout: an overall limit forecast to run out before its reset (the same forecast as the ⚠ in the widget) gets one reminder
 *   RUNOUT_LEAD_MINUTES before the run-out time, or right away if that has passed
 * { kind, provider, window_id, cycle (reset time, ms), fire_at (ms), title, body }
 */
function reminderPlan(view, now) {
  const out = [];
  for (const provider of PROVIDER_ORDER) {
    const p = view?.[provider];
    if (!p) continue;
    const windows = p.main_window_ids.map((id) => atDisplayTime(p.windows[id], now));
    const full = windows.filter((w) => !w.reset_passed && w.used_percent >= 100);
    if (full.length > 0) {
      // Usable again only once every limit at 100% resets: with a reset time unknown there is no time to remind at
      if (!full.every((w) => resetDate(w, now))) continue;
      const last = full.reduce((a, w) => (Date.parse(w.resets_at) > Date.parse(a.resets_at) ? w : a));
      const at = Date.parse(last.resets_at);
      out.push({ kind: "back", provider, window_id: last.id, cycle: at, fire_at: at, boundary: view.boundaries?.[provider] ?? null,
        title: notifyTitle(provider, fullLimitName(last)), body: `${SYMBOLS.reset} Reset · usable again` });
      continue;
    }
    for (const w of windows) {
      const p2 = projectionOf(w, now);
      if (!p2?.runsOut || !p2.at) continue;
      const fire = Math.max(now.getTime(), p2.at - RUNOUT_LEAD_MINUTES * 60000);
      const minutes = Math.max(1, Math.round((p2.at - fire) / 60000));
      out.push({ kind: "runout", provider, window_id: w.id, cycle: Date.parse(w.resets_at), fire_at: fire, boundary: view.boundaries?.[provider] ?? null,
        title: notifyTitle(provider, fullLimitName(w)), body: `${SYMBOLS.runout} ~${minutes} min left (runs out ${clockText(new Date(p2.at), now)})` });
    }
  }
  // Every candidate: the ones that rang are matched as records, and at most MAX_REMINDERS of the others wait (reconcileReminders)
  return out;
}

/** Same reminder in the same cycle (a back reminder is per provider) */
function sameReminder(a, b) {
  return a.kind === b.kind && a.provider === b.provider && (a.kind === "back" || a.window_id === b.window_id)
    && Math.abs(a.cycle - b.cycle) <= CYCLE_TOLERANCE_MS;
}

/** Identifier of a reminder (includes the settings generation, so an older run never touches a newer generation's reminders) */
function reminderId(gen, item, op = runMark()) {
  return `headroom.${gen}.${item.kind}.${item.provider}.${item.kind === "back" ? "all" : item.window_id}.${Math.round(item.cycle / 60000)}.${accountMark(item.boundary)}.${op}`;
}

/**
 * Short mark of the account a reminder is for (its provider's boundary stamp): "x" when there is none, a hash otherwise ("" is the first
 * account's stamp, a mark of its own). Two accounts' reminders of the same minute get different identifiers, so one's delivery is never
 * taken for the other's
 */
function accountMark(boundary) {
  if (typeof boundary !== "string") return "x";
  // Two 32-bit FNV-1a passes from different offsets (64 bits): the identifier never takes the place of comparing the stamps (the
  // delivery carries the stamp itself)
  const pass = (h) => {
    for (let i = 0; i < boundary.length; i++) h = Math.imul(h ^ boundary.charCodeAt(i), 0x01000193) >>> 0;
    return h.toString(16).padStart(8, "0");
  };
  return pass(0x811c9dc5) + pass(0x050c5d1f);
}

/** Whether a reminder's identifier names its account (identifiers of earlier versions don't: their delivery proves nothing about one) */
function marksAccount(id) {
  return /\.\d+\.[0-9a-f]{16}\.[0-9a-f]{8}$/.test(id);
}

/** How long past its time a reminder still waiting on the device holds its reset back (iOS rings it in a moment) */
const REMINDER_WAIT_MS = 10 * 60000;

/**
 * Compare planned reminders with the ones already scheduled (previous). Returns { schedule, cancel, reminders }:
 * - a reminder that has rung (or rings within a minute) is never scheduled again in its cycle (rescheduling a delivered identifier
 *   rings it again); it is remembered for NOTIFY_KEEP_MS
 * - a pending one keeps its identifier and moves only if its time changed by more than 2 minutes, or is scheduled again when the
 *   device's pending list (pending, a Set; null: not known) doesn't have it
 * - one being cancelled, or one of another account's stamp, is never taken over: planned again, it gets a new identifier
 * - a pending one no longer planned is cancelled (the forecast eased, the limit lifted early, or reminders were turned off)
 */
function reconcileReminders(previous, plan, now, gen, pending = null, version = null, cancelDue = false) {
  // cancelDue: true (every provider withdrawn), or a Set of the providers withdrawn
  const t = now.getTime();
  // Still waiting in the state but not on the device (taken back by a run that lost its lock, or removed by iOS): scheduled again
  const missing = (r) => pending !== null && !pending.has(r.id);
  // Rang (or rings within a minute) and no longer waiting on the device (one still waiting hasn't rung, whatever its time)
  const rung = (r) => r.fire_at <= t + 60000 && !(pending !== null && pending.has(r.id));
  const schedule = [];
  const cancel = [];
  const reminders = [];
  /** Planned and not rung: the cap below picks which of them wait */
  const waiting = [];
  /** Kept as waiting from before (due and still on the device, or planned from a newer view): they take places first */
  let held = 0;
  const used = new Set();
  for (const item of plan) {
    const index = previous.findIndex((r, i) => !used.has(i) && sameReminder(r, item));
    const prev = index >= 0 ? previous[index] : null;
    if (prev) used.add(index);
    // One being cancelled, or one for another account's stamp (an old one without a stamp included), is never taken over, also when
    // it is due: planned again, it is a new operation
    // One being cancelled that no longer waits on the device, whose fate isn't known (the delivered list couldn't be read): held as it
    // is this time (planned again it could ring a second time)
    if (prev && prev.cancelling === true && !(pending !== null && pending.has(prev.id))) {
      reminders.push(prev);
      continue;
    }
    const another = prev && (prev.cancelling === true || (item.boundary != null && (prev.boundary ?? null) !== item.boundary));
    if (prev && !another && rung(prev)) {
      reminders.push(prev);
      // Due this minute, with the device's list unknown: it may still be waiting, so it keeps its place
      if (pending === null && prev.fire_at > t - 60000) held += 1;
      continue;
    }
    // A new time is a new operation too (its own identifier: a late cancel of the old one can't take the new one). A retry of one
    // missing from the device keeps its operation's identifier
    const retimed = prev && (another || Math.abs(prev.fire_at - item.fire_at) > 2 * 60000);
    const id = prev && !retimed ? prev.id : reminderId(gen, item);
    if (retimed) cancel.push(prev.id);
    const moved = !prev || retimed || missing(prev);
    waiting.push({ item: { ...item, id }, moved, onDevice: Boolean(prev) && !moved, entry: { id, kind: item.kind, provider: item.provider, window_id: item.window_id, cycle: item.cycle, fire_at: moved ? item.fire_at : prev.fire_at,
      set_at: moved ? t : prev.set_at ?? t, boundary: retimed ? item.boundary ?? null : item.boundary ?? prev?.boundary ?? null,
      // The view version it was planned from (a run with an older view never cancels it)
      ...(Number.isSafeInteger(version) ? { from: moved ? version : prev.from ?? version } : {}),
      // Whether it is known to be scheduled (one saved just before scheduling stays unconfirmed until it was)
      ...(moved || prev.confirmed === undefined ? {} : { confirmed: prev.confirmed }) } });
  }
  for (const [i, r] of previous.entries()) {
    if (used.has(i)) continue;
    // Planned from a newer view than this one (by a run that read it): not this run's to cancel
    if (Number.isSafeInteger(version) && Number.isSafeInteger(r.from) && r.from > version) {
      reminders.push(r);
      if (!rung(r)) held += 1;
      continue;
    }
    // Due (or ringing within a minute) and still waiting: kept, so its delivery is matched when its reset is told (unless its provider
    // is withdrawn, which cancels it)
    const withdrawnHere = cancelDue === true || (typeof cancelDue?.has === "function" && cancelDue.has(r.provider));
    if (!withdrawnHere && r.fire_at <= t + 60000 && pending !== null && pending.has(r.id)) {
      reminders.push(r);
      held += 1;
      continue;
    }
    if (!rung(r)) cancel.push(r.id);
    else if (r.fire_at > t - NOTIFY_KEEP_MS) reminders.push(r);
  }
  // At most MAX_REMINDERS wait on the device: the earliest to ring of those not rung (in the plan's order). One past them isn't
  // scheduled, and one waiting on the device is taken back; it is planned again once a place is free
  const room = Math.max(0, MAX_REMINDERS - held);
  const chosen = new Set([...waiting].sort((a, b) => a.entry.fire_at - b.entry.fire_at).slice(0, room));
  for (const w of waiting) {
    if (chosen.has(w)) {
      if (w.moved) schedule.push(w.item);
      reminders.push(w.entry);
    } else if (w.onDevice) {
      cancel.push(w.entry.id);
    }
  }
  return { schedule, cancel, reminders };
}

const EVENT_KINDS = ["threshold", "limit", "reset", "soon", "anomalous", "provider_error", "collection_stopped", "collection_resumed"];

/**
 * Validate the events response (GET /v2/events) and keep only the fields used. A malformed event is skipped (the cursor still moves
 * past it). null if the response itself is malformed
 */
function sanitizeEvents(body) {
  if (!body || typeof body !== "object" || !Number.isSafeInteger(body.last_seq) || body.last_seq < 0) return null;
  if (!Array.isArray(body.events) || body.events.length > 1000) return null;
  const events = [];
  for (const e of body.events) {
    if (!e || typeof e !== "object" || !Number.isSafeInteger(e.seq) || e.seq < 1 || !EVENT_KINDS.includes(e.kind)) continue;
    events.push({
      seq: e.seq, created_at: str(e.created_at, 40), kind: e.kind,
      provider: oneOf(e.provider, PROVIDER_ORDER),
      window_id: typeof e.window_id === "string" && ID.test(e.window_id) ? e.window_id : null,
      label: str(e.label, 24), scope: str(e.scope, 32), cycle: str(e.cycle, 40),
      threshold: num(e.threshold), used_percent: num(e.used_percent), eta_minutes: num(e.eta_minutes), resets_at: str(e.resets_at, 40),
      blocked: typeof e.blocked === "boolean" ? e.blocked : null, error_code: oneOf(e.error_code, Object.keys(ERROR_NAMES)),
      confirmed: typeof e.confirmed === "boolean" ? e.confirmed : null, last_received_at: str(e.last_received_at, 40),
      boundary: typeof e.boundary === "string" && STAMP.test(e.boundary) ? e.boundary : null,
    });
  }
  events.sort((a, b) => a.seq - b.seq);
  return { last_seq: body.last_seq, oldest_seq: Number.isSafeInteger(body.oldest_seq) ? body.oldest_seq : null, events };
}

/** Short name of an event's limit (e.g. 5h, Weekly, Fable weekly). null for an event without a limit */
function eventLimit(e) {
  return e.window_id ? limitName({ id: e.window_id, scope: e.scope, label: e.label }) : null;
}

/** Full name of a limit, as notification titles say it (5h limit, Weekly limit, Fable weekly limit) */
function fullLimitName(w) {
  const scope = scopeName(w.scope);
  return scope ? `${scope} ${windowName(w).toLowerCase()} limit` : `${windowName(w)} limit`;
}

/**
 * An event in a few words, led by its symbol. The notifications and the details screen's history use the same words, and remaining
 * amounts are said as what is left (like the widget): "◑ 20% left", "⊘ Limit reached", "↻ Reset (estimated)", "⚠︎ ~30 min left"
 */
function eventPhrase(e) {
  switch (e.kind) {
    case "threshold": return `${SYMBOLS.left} ${Math.max(0, 100 - (e.threshold ?? 0))}% left`;
    case "limit": return e.window_id ? `${SYMBOLS.limit} Limit reached` : `${SYMBOLS.limit} At its limit`;
    case "reset": return `${SYMBOLS.reset} Reset${e.confirmed ? "" : " (estimated)"}`;
    case "soon": return `${SYMBOLS.runout} ~${e.threshold ?? "?"} min left`;
    case "anomalous": return `${SYMBOLS.sudden} Sudden use`;
    case "provider_error": return `${SYMBOLS.runout} ${ERROR_NAMES[e.error_code] ?? "Error"}`;
    case "collection_stopped": return `${SYMBOLS.stopped} No new values from the PCs`;
    case "collection_resumed": return `${SYMBOLS.resumed} Values updating again`;
    default: return "";
  }
}

/**
 * Choose what to tell from new events, so a limit that runs out rings at most three times per cycle:
 * - warning: the first of "limit soon" (30 and 15 minutes) and 95% in a cycle, overall limits only. Left to the time reminder's run-out
 *   warning when time reminders are on (it rings on time; an event is told only on the next redraw). "Limit soon" is checked against the
 *   view's forecast at this moment (the minutes left are counted from now), so a late read never says "~15 min left" after that time
 * - limit reached: always (per-model and per-group limits too), unless its reset has already passed. Each event is told once (cursor and
 *   numbers told); a second limit event in a cycle is another account's after a switch, so it is told too
 * - reset: only after a limit reached that was told, and not when a reset reminder rang (or rings within a minute) at that reset, or
 *   another limit of the provider is still at 100%
 * - 80% of a weekly or monthly limit (they move slowly, so it is an early hint)
 * - collection stopped and resumed (both in one batch cancel out, in either order), sign-in required, safety stop
 * - not told: sudden consumption, "limit soon" at 5 minutes (arrives with the limit), events older than ALERT_MAX_AGE_MINUTES
 * told: { limits: [{ key, at, until }], warned: [...] } cycles already told; each is kept until its cycle's reset has passed (a monthly
 * reset can be weeks away) and at least NOTIFY_KEEP_MS.
 * Returns { alerts: [{ seq, provider, limit (short name or null), title_limit (full name or null), text, mark }], told }. mark is the told
 * entry an alert adds ({ list, key, at, until }); a caller that sends notifications one by one adds it only once its notification went out
 */
function selectAlerts(events, view, now, opts = {}) {
  const { told = { limits: [], warned: [] }, reminders = [], times = true, since = {}, pending = null, delivered = new Set(), deliveredIds = new Set(), deliveredStamps = null } = opts;
  const held = [];
  const t = now.getTime();
  const keyOf = (e) => `${e.provider}.${e.window_id}.${e.cycle}`;
  // A cycle told for the account before the provider's last accepted switch (by the events' server times) is another account's
  const markTime = (x) => (Number.isFinite(x.event_at) ? x.event_at : x.at);
  const eventAt = (e) => {
    const x = Date.parse(e.created_at ?? "");
    return Number.isFinite(x) ? x : t;
  };
  // Whether a mark (or another event) belongs to the same account as event e: by the boundary stamps both were judged under, otherwise
  // by which side of the provider's last accepted switch (server times) each was made on
  const known = (b) => typeof b === "string";
  // When the account of event e was accepted: the provider's last accepted switch, or the one e's own stamp names
  const stampTime = (b) => (known(b) ? Date.parse(b.split("#")[0]) : Number.NaN);
  // The latest switch known: the provider's saved one, or a later one the event's own stamp names
  const cutOf = (e) => {
    const cuts = [since[e.provider], stampTime(e.boundary)].filter(Number.isFinite);
    return cuts.length ? Math.max(...cuts) : Number.NaN;
  };
  const sameAccount = (boundary, at, e) => {
    if (known(boundary) && known(e.boundary)) return boundary === e.boundary;
    // Every switch known (the provider's saved one, and those the event's and the mark's stamps name): one between the two times makes
    // them different accounts
    const cuts = [since[e.provider], stampTime(e.boundary), stampTime(boundary)].filter(Number.isFinite);
    if (cuts.length === 0) return true;
    // Neither a stamp nor a server time (a mark of an earlier version): it can't count across a switch
    if (!Number.isFinite(at)) return false;
    const lo = Math.min(at, eventAt(e));
    const hi = Math.max(at, eventAt(e));
    return !cuts.some((c) => lo < c && c <= hi);
  };
  const markAt = (x) => (Number.isFinite(x.event_at) ? x.event_at : known(x.boundary) ? x.at : Number.NaN);
  const has = (list, e) => list.some((x) => x.key === keyOf(e) && sameAccount(x.boundary, markAt(x), e));
  // The view says something about an event only if it was built under the same account (the view and the events are read apart)
  const viewFor = (e) => {
    const b = view?.boundaries?.[e.provider];
    if (known(b) && known(e.boundary)) return b !== e.boundary ? null : view;
    // A view without a stamp can't be the account of an event whose stamp names a switch ("" names none: the first account)
    if (!known(b) && known(e.boundary)) return Number.isFinite(stampTime(e.boundary)) ? null : view;
    // A stamp missing on either side: an event made before the view's account was accepted is another account's
    const accepted = stampTime(b);
    return Number.isFinite(accepted) && eventAt(e) < accepted ? null : view;
  };
  // A reminder counts for an event of the same account only: by stamps, and one without a stamp only while no switch is known
  const reminderOf = (r, e) => (known(r.boundary) && known(e.boundary) ? r.boundary === e.boundary : !Number.isFinite(cutOf(e)));
  const alive = (x) => (Number.isFinite(x.until) ? x.until : x.at + NOTIFY_KEEP_MS) > t;
  const limits = told.limits.filter(alive);
  const warned = told.warned.filter(alive);
  const future = (iso) => {
    const x = Date.parse(iso ?? "");
    return Number.isFinite(x) && x > t;
  };
  const untilOf = (e) => Math.max(t + NOTIFY_KEEP_MS, (Date.parse(e.resets_at ?? "") || 0) + 24 * 60 * 60000);
  const list = events.filter((e) => {
    const created = Date.parse(e.created_at ?? "");
    return Number.isFinite(created) && t - created <= ALERT_MAX_AGE_MINUTES * 60000;
  });
  // Stopped and resumed in one batch cancel out, only when neither is on the device already (a stopped already shown needs its resumed)
  const untold = list.filter((e) => !delivered.has(e.seq));
  const bothCollection = untold.some((e) => e.kind === "collection_stopped") && untold.some((e) => e.kind === "collection_resumed");
  // The pair cancelled out (a caller settles it only once no run is handing either to iOS)
  const cancelled = bothCollection
    ? [untold.find((e) => e.kind === "collection_stopped").seq, untold.find((e) => e.kind === "collection_resumed").seq]
    : [];
  const limitsInBatch = list.filter((e) => e.kind === "limit" && e.window_id);
  const limitInBatch = (e) => limitsInBatch.some((l) => keyOf(l) === keyOf(e) && sameAccount(l.boundary, eventAt(l), e));
  const stillFull = (e) => (viewFor(e)?.[e.provider]?.main_window_ids ?? []).some((id) => {
    const w = atDisplayTime(viewFor(e)[e.provider].windows[id], now);
    return !w.reset_passed && w.used_percent >= 100;
  });
  const alerts = [];
  const push = (e, text, mark = null) => alerts.push({ seq: e.seq, provider: e.provider, limit: eventLimit(e),
    title_limit: e.window_id ? fullLimitName({ id: e.window_id, scope: e.scope, label: e.label }) : null, text, mark });
  for (const e of list) {
    const overall = e.window_id !== null && e.scope === null;
    // When the limit comes back, after the phrase: "⊘ Limit reached · ↻ 3:00 PM"
    const back = future(e.resets_at) ? ` · ${SYMBOLS.reset} ${clockText(new Date(Date.parse(e.resets_at)), now)}` : "";
    if (e.kind === "limit") {
      if (!e.provider) continue;
      if (e.window_id === null) {
        push(e, eventPhrase(e));
        continue;
      }
      // Not dropped as "already told in this cycle": the server makes one limit event per account and cycle (another account's limit in
      // the same cycle is a new event), and the cursor and the numbers told keep one event from being told twice
      // Its reset passed: not told (but one already on the device is remembered, so its reset is handled)
      if (!future(e.resets_at) && !delivered.has(e.seq)) continue;
      const mark = { list: "limits", key: keyOf(e), at: t, event_at: eventAt(e), boundary: e.boundary ?? null, until: untilOf(e) };
      limits.push(mark);
      push(e, `${eventPhrase(e)}${back}`, mark);
    } else if (e.kind === "reset") {
      if (!e.provider || !e.window_id || !has(limits, e)) continue;
      const cycle = Date.parse(e.cycle ?? "");
      // A reset reminder that rang (or rings within a minute, as reconcileReminders counts it) already said so, whatever the switch is now
      const due = reminders.filter((r) => r.kind === "back" && r.provider === e.provider && r.fire_at <= t + 60000
        && Number.isFinite(cycle) && Math.abs(r.cycle - cycle) <= CYCLE_TOLERANCE_MS && reminderOf(r, e));
      // Whether its reminder rang can't be told without the device's list: held (not told, and the cursor waits before it)
      if (due.length > 0 && pending === null) {
        held.push(e.seq);
        continue;
      }
      // It rang if the device shows it delivered (an identifier that names this account; delivery wins over an older pending list),
      // or it is known to have been scheduled and no longer waits. An entry not known to be scheduled (also one of an earlier version)
      // proves nothing: the event tells it (a duplicate is allowed only then)
      const stampOk = (r) => deliveredStamps === null || (deliveredStamps.has(r.id) && deliveredStamps.get(r.id) === (r.boundary ?? null));
      const rang = due.some((r) => (marksAccount(r.id) && deliveredIds.has(r.id) && stampOk(r))
        || (!pending.has(r.id) && r.confirmed === true && r.cancelling !== true));
      if (rang || stillFull(e)) continue;
      // Still waiting on the device though due (iOS rings it in a moment): held, so it and the reset aren't both told. Not for long
      // past its time (one iOS keeps waiting doesn't hold the events back). With time reminders off it is being cancelled: not held
      if (times && due.some((r) => pending.has(r.id) && r.cancelling !== true && r.fire_at > t - REMINDER_WAIT_MS)) {
        held.push(e.seq);
        continue;
      }
      push(e, `${eventPhrase(e)} · usable again`);
    } else if ((e.kind === "soon" && (e.threshold === 30 || e.threshold === 15)) || (e.kind === "threshold" && e.threshold === 95)) {
      if (times || !overall || !e.provider || has(warned, e) || limitInBatch(e) || has(limits, e)) continue;
      let text = `${eventPhrase(e)}${back}`;
      if (e.kind === "soon") {
        // The run-out time: the view's forecast now if it has the limit (a forecast that lasts drops the warning), otherwise at the
        // latest the event's creation plus its minutes (the minutes count from the observation, which came before)
        const w = viewFor(e)?.[e.provider]?.windows?.[e.window_id];
        const p = w ? projectionOf(atDisplayTime(w, now), now) : null;
        if (w && !p?.runsOut) continue;
        const at = p?.runsOut ? p.at : Date.parse(e.created_at) + (e.eta_minutes ?? 0) * 60000;
        if (!(at > t)) continue;
        text = `${SYMBOLS.runout} ~${Math.max(1, Math.round((at - t) / 60000))} min left at this pace`;
      } else if (!future(e.resets_at)) {
        continue;
      }
      const mark = { list: "warned", key: keyOf(e), at: t, event_at: eventAt(e), boundary: e.boundary ?? null, until: untilOf(e) };
      warned.push(mark);
      push(e, text, mark);
    } else if (e.kind === "threshold" && e.threshold === 80) {
      const name = windowName({ id: e.window_id ?? "" });
      if (!overall || !e.provider || (name !== "Weekly" && name !== "Monthly") || !future(e.resets_at)) continue;
      push(e, `${eventPhrase(e)}${back}`);
    } else if (e.kind === "collection_stopped" || e.kind === "collection_resumed") {
      if (bothCollection) continue;
      const last = Date.parse(e.last_received_at ?? "");
      push(e, e.kind === "collection_stopped" && Number.isFinite(last) ? `${eventPhrase(e)} since ${clockText(new Date(last), now)}` : eventPhrase(e));
    } else if (e.kind === "provider_error" && e.provider && ALERT_ERRORS.includes(e.error_code)) {
      push(e, eventPhrase(e));
    }
  }
  return { alerts, told: { limits, warned }, held, cancelled };
}

/**
 * Notifications for the alerts of a run: one per provider (Codex, Claude, then those without a provider), so the title says whose it is.
 * One alert: "Claude · 5h limit" / "⊘ Limit reached · ↻ 3:00 PM" (the limit's full name in the title). Several: "Claude · 2 updates" with a
 * line each ("5h limit ⊘ Limit reached"), up to MAX_ALERT_LINES. [{ provider, title, body, alerts (the alerts in it) }]
 */
function alertNotifications(alerts) {
  const out = [];
  for (const provider of [...PROVIDER_ORDER, null]) {
    const list = alerts.filter((a) => (PROVIDER_ORDER.includes(a.provider) ? a.provider : null) === provider);
    if (list.length === 0) continue;
    const title = (limit) => (provider ? notifyTitle(provider, limit) : "Headroom");
    if (list.length === 1) {
      out.push({ provider, title: title(list[0].title_limit ?? list[0].limit), body: list[0].text, alerts: list });
      continue;
    }
    const lines = list.slice(0, MAX_ALERT_LINES).map((a) => {
      const limit = a.title_limit ?? a.limit;
      return limit ? `${limit} ${a.text}` : a.text;
    });
    if (list.length > MAX_ALERT_LINES) lines.push(`+${list.length - MAX_ALERT_LINES} more`);
    out.push({ provider, title: `${title(null)} · ${list.length} updates`, body: lines.join("\n"), alerts: list });
  }
  return out;
}

/**
 * Sample notifications of each kind for the providers (the app menu's Notifications > "Send sample notifications"). Made with the same functions as
 * the real ones (reminderPlan, selectAlerts, alertNotifications) from made-up values, so they look exactly like them:
 * the run-out reminder, the event's "limit soon" (told when time reminders are off), limit reached, the reset reminder, a reset told by an
 * event, weekly 80% and sign-in required per provider, then collection stopped and resumed (no provider) once. [{ provider, title, body }]
 */
function sampleNotifications(providers, now) {
  const t = now.getTime();
  const at = (minutes) => new Date(t + minutes * 60000).toISOString();
  const fiveHour = (used, rate) => ({
    id: "five_hour", label: "5h", scope: null, used_percent: used, recent_consumed_percent: null, recent_minutes: null, recent_quality: "unknown",
    confidence: "high", fetched_at: now.toISOString(), resets_at: at(180), eta_at: null, reset_first: null, eta_minutes: null,
    rate_15m: null, rate_60m: rate, rate_24h: rate, rate_pace: rate,
  });
  const viewWith = (provider, w) => ({ [provider]: { status: "ok", plan: null, error_code: null, blocked: w.used_percent >= 100, main_window_ids: ["five_hour"], window_ids: ["five_hour"], windows: { five_hour: w } } });
  const ev = (provider, kind, o) => ({
    seq: 1, created_at: now.toISOString(), kind, provider, window_id: "five_hour", label: "5h", scope: null, cycle: at(180), threshold: null,
    used_percent: null, eta_minutes: null, resets_at: at(180), blocked: null, error_code: null, confirmed: null, last_received_at: null, ...o,
  });
  const alert = (event, opts = {}) => alertNotifications(selectAlerts([event], null, now, { times: true, ...opts }).alerts);
  const out = [];
  for (const provider of PROVIDER_ORDER.filter((p) => providers.includes(p))) {
    const reminder = (w) => reminderPlan(viewWith(provider, w), now).map(({ title, body }) => ({ provider, title, body }));
    // 10% left at 40%/h: runs out in 15 minutes
    out.push(...reminder(fiveHour(90, 40)));
    // The event's warning, told when time reminders are off
    out.push(...alert(ev(provider, "soon", { threshold: 30, eta_minutes: 30 }), { times: false }));
    out.push(...alert(ev(provider, "limit", { blocked: true })));
    out.push(...reminder(fiveHour(100, null)));
    const key = `${provider}.five_hour.${at(-120)}`;
    out.push(...alert(ev(provider, "reset", { cycle: at(-120), resets_at: at(180), confirmed: false }), { told: { limits: [{ key, at: t }], warned: [] }, times: false }));
    out.push(...alert(ev(provider, "threshold", { threshold: 80, window_id: "seven_day", label: "Weekly", resets_at: at(3 * 1440) })));
    out.push(...alert(ev(provider, "provider_error", { window_id: null, label: null, error_code: "login_required" })));
  }
  out.push(...alert(ev(null, "collection_stopped", { window_id: null, label: null, last_received_at: at(-40) })));
  out.push(...alert(ev(null, "collection_resumed", { window_id: null, label: null })));
  return out;
}

/** File name of the events cursor marker (only created, the highest kept, so overlapping runs can't move the cursor back) */
function eventsFileName(tag, seq) {
  return `headroom-events-${tag}-${seq}`;
}

/** Events cursor (the highest marker). null before the first read (nothing is told on the first read) */
function eventsCursor(names, tag) {
  const re = new RegExp(`^headroom-events-${tag}-(\\d{1,15})$`);
  let best = null;
  for (const name of names) {
    const m = re.exec(name);
    if (m && (best === null || Number(m[1]) > best)) best = Number(m[1]);
  }
  return best;
}

/**
 * Saved notification state (reminders scheduled, cycles told, numbers of events told in the reads the cursor hasn't passed yet, the
 * boundary stamps they belong to, last successful check). Unreadable parts start empty
 */
/**
 * Records of the notifying runs, a file per operation (only its writer creates it; no run rewrites another's):
 * - told-<n>: event n was told (by any run, or found on the device), with the cycle it told (from the event alone, so every run writes
 *   the same). Kept until the cursor has passed it and its cycle no longer matters
 * - intent-<first>-<run>: a run is about to hand a notification of those numbers to iOS (written before; a run stopped after handing it
 *   over is recognized next time)
 * - pair-<a>-<b>-<run>: a stopped and a resumed are being cancelled out (written before the intents are read again)
 * - abort-<first>-<run>: that intent was dropped before reaching iOS (a pair was being cancelled out)
 */
function recordName(kind, tag, ...parts) {
  return `headroom-${kind}-${tag}-${parts.join("-")}${kind === "abort" ? "" : ".json"}`;
}

/** A record's name read back ({ kind, seqs, run } and, for told, seq), or null */
function parseRecord(name, tag) {
  const m = /^headroom-(intent|told|pair|abort)-([0-9a-f]{2,600})-([0-9a-f-]{1,60})(?:\.json)?$/.exec(name);
  if (!m || m[2] !== tag) return null;
  const parts = m[3].split("-");
  const num = (x) => (/^\d{1,15}$/.test(x ?? "") ? Number(x) : null);
  if (m[1] === "told") return num(parts[0]) === null || parts.length !== 1 ? null : { kind: "told", seq: num(parts[0]), seqs: [num(parts[0])], run: null };
  if (m[1] === "pair") {
    if (parts.length !== 3 || num(parts[0]) === null || num(parts[1]) === null) return null;
    return { kind: "pair", a: num(parts[0]), b: num(parts[1]), seqs: [num(parts[0]), num(parts[1])], run: parts[2] };
  }
  if (parts.length !== 2 || num(parts[0]) === null) return null;
  return { kind: m[1], seqs: [num(parts[0])], run: parts[1] };
}

/**
 * The records of these settings: { told: Map(number -> cycle mark or null), intents: [{ seqs, at, run }], pairs: [{ a, b, run }], aborts:
 * Set("first-run") }. null when the list can't be read, or a told record or an intent can't (nothing is decided on a part)
 */
function readRecords(fm, names, tag) {
  if (names === null) return null;
  const out = { told: new Map(), intents: [], pairs: [], aborts: new Set() };
  for (const name of names) {
    const rec = parseRecord(name, tag);
    if (!rec) continue;
    if (rec.kind === "abort") {
      out.aborts.add(`${rec.seqs[0]}-${rec.run}`);
      continue;
    }
    const read = readRecordFile(fm, name);
    if (!read.ok) return null;
    const body = read.body;
    if (rec.kind === "pair") {
      // Its time: a pair a gone run left behind (older than the lock, or corrupt) doesn't stop a sender
      out.pairs.push({ ...rec, at: Number(body?.at) || 0 });
      continue;
    }
    if (rec.kind === "told") {
      // A corrupt one (a write cut short) settles nothing: its number is decided again (from the device, an intent, or the pair), and
      // the record written then replaces it
      if (body === null || typeof body !== "object") continue;
      out.told.set(rec.seq, recordMark(body.mark));
      // A cancelled-out pair: its other number is settled by the same record (without a cycle)
      if (Number.isSafeInteger(body?.pair) && !out.told.has(body.pair)) out.told.set(body.pair, null);
    } else if (Array.isArray(body?.seqs) && body.seqs.every(Number.isSafeInteger)) {
      // Each number's cycle as the intent's run read it from its event
      const marks = new Map(body.seqs.map((n) => [n, recordMark(body.marks?.[n])]));
      out.intents.push({ seqs: body.seqs, marks, at: Number.isFinite(body.at) ? body.at : 0, run: rec.run });
    } else {
      // A corrupt intent: only its first number is known, taken as a gone run's (told again unless the device shows it)
      out.intents.push({ seqs: rec.seqs.slice(0, 1), marks: new Map(), at: 0, run: rec.run });
    }
  }
  return out;
}

/**
 * A record's content: ok false when it can't be read now (it may matter: nothing is decided from it), body null when what was read isn't
 * JSON (a write cut short: it holds nothing usable)
 */
function readRecordFile(fm, name) {
  let text;
  try {
    text = fm.readString(fm.joinPath(fm.documentsDirectory(), name));
  } catch (_) {
    return { ok: false, body: null };
  }
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch (_) {
    return { ok: true, body: null };
  }
}

/**
 * Whether a reminder saved as about to be scheduled may still reach iOS: only while the run that saved it may still be handing it over
 * (its lock's time). Later, it either shows on the device or never will
 */
function mayLand(r) {
  return r.confirmed === false && !(Number.isFinite(r.set_at) && r.set_at <= Date.now() - LOCK_SECONDS * 1000);
}

/** A told cycle read back from a record, or null when it has none (or not one of the right shape) */
function recordMark(m) {
  return m && (m.list === "limits" || m.list === "warned") && typeof m.key === "string" && Number.isFinite(m.until) ? m : null;
}

/**
 * The cycle an event tells, if it tells one (a limit, or a warning of the run-out or 95%), from the event alone: { list, key, at, event_at,
 * boundary, until }. null otherwise
 */
function eventMark(e) {
  if (!e || !e.provider || !e.window_id) return null;
  const list = e.kind === "limit" ? "limits"
    : (e.kind === "soon" && (e.threshold === 30 || e.threshold === 15)) || (e.kind === "threshold" && e.threshold === 95) ? "warned" : null;
  const at = Date.parse(e.created_at ?? "");
  if (!list || !Number.isFinite(at)) return null;
  return { list, key: `${e.provider}.${e.window_id}.${e.cycle}`, at, event_at: at, boundary: e.boundary ?? null,
    until: Math.max(at + NOTIFY_KEEP_MS, (Date.parse(e.resets_at ?? "") || 0) + 24 * 60 * 60000) };
}

/** A mark of this run (8 hex digits): its records are told apart from another run's */
function runMark() {
  let id = "";
  for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

function readNotifyState(text) {
  const empty = { reminders: [], told: { limits: [], warned: [] }, sent: [], view_version: null, sending: null, boundaries: null, boundaries_version: null, checked_at: null };
  let s;
  try {
    s = JSON.parse(text ?? "");
  } catch (_) {
    return empty;
  }
  if (!s || typeof s !== "object") return empty;
  const reminder = (r) => r && typeof r.id === "string" && /^headroom\.[0-9a-f]{16}\.[a-z]+\.[a-z]+\.[a-z0-9_]+\.\d+(\.[0-9a-fx]{1,16})?(\.[0-9a-f]{8})?$/.test(r.id)
    && (r.kind === "back" || r.kind === "runout") && PROVIDER_ORDER.includes(r.provider)
    && Number.isFinite(r.cycle) && Number.isFinite(r.fire_at);
  const told = (x) => x && typeof x.key === "string" && x.key.length <= 120 && Number.isFinite(x.at) && (x.until === undefined || Number.isFinite(x.until))
    && (x.event_at === undefined || Number.isFinite(x.event_at))
    && (x.boundary === undefined || x.boundary === null || (typeof x.boundary === "string" && x.boundary.length <= 60));
  // An entry of the earlier form (no until) is kept until its cycle's reset (the key ends with it) has passed, as new ones are
  const withUntil = (x) => {
    if (Number.isFinite(x.until)) return x;
    const cycle = Date.parse(x.key.split(".").slice(2).join("."));
    return { ...x, until: Math.max(x.at + NOTIFY_KEEP_MS, Number.isFinite(cycle) ? cycle + 24 * 60 * 60000 : 0) };
  };
  return {
    // The latest to ring first: every one waiting (they ring later than any that rang) stays, the oldest records go
    reminders: Array.isArray(s.reminders) ? s.reminders.filter(reminder).sort((a, b) => b.fire_at - a.fire_at).slice(0, KEPT_REMINDERS) : [],
    told: {
      limits: Array.isArray(s.told?.limits) ? keepTold(s.told.limits.filter(told).map(withUntil)) : [],
      warned: Array.isArray(s.told?.warned) ? keepTold(s.told.warned.filter(told).map(withUntil)) : [],
    },
    // Numbers of events told past the cursor (kept until the cursor passes them, however many)
    sent: Array.isArray(s.sent) ? s.sent.filter((n) => Number.isSafeInteger(n) && n > 0).slice(-5000) : [],
    // A state from before this was kept: the version its account stamps came from (also a view the last run used)
    view_version: Number.isSafeInteger(s.view_version) ? s.view_version : Number.isSafeInteger(s.boundaries_version) ? s.boundaries_version : null,
    // A notification saved as about to be told (its numbers and the cycles it tells)
    sending: s.sending && typeof s.sending.id === "string" && s.sending.id.length <= 120 && Array.isArray(s.sending.seqs) && Array.isArray(s.sending.marks)
      ? { id: s.sending.id, seqs: s.sending.seqs.filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 100),
        marks: s.sending.marks.filter((m) => told(m) && (m.list === "limits" || m.list === "warned")).slice(0, 100).map(withUntil) }
      : null,
    boundaries: sanitizeBoundaries(s.boundaries),
    boundaries_version: Number.isSafeInteger(s.boundaries_version) ? s.boundaries_version : null,
    checked_at: str(s.checked_at, 40),
  };
}

/**
 * Forget what was told for a provider whose account switched (its history boundary stamp in the view changed): the next account's
 * limits are new even in the same cycle. boundaries are the freshly fetched view's (null: keep the state as it is). Returns
 * { state (with these boundaries), cancel (reminder identifiers of those providers), switched }
 */
function forgetSwitched(state, boundaries, version = null) {
  // A view older than the one the stamps came from (read before another run took the lock) says nothing about a switch
  if (!boundaries || (Number.isSafeInteger(state.boundaries_version) && !(version >= state.boundaries_version))) return { state, cancel: [], switched: [] };
  // A provider whose stamp isn't known on one side (an earlier version's saved state, an earlier Worker's view) isn't taken as switched
  const switched = PROVIDER_ORDER.filter((p) => state.boundaries && typeof state.boundaries[p] === "string" && typeof boundaries[p] === "string"
    && state.boundaries[p] !== boundaries[p]);
  const gone = (provider) => switched.includes(provider);
  // A cycle told for an event made after the new account was accepted (both server times) is the new account's: it stays (a switch
  // can be seen late, when the view couldn't be read at the time an event of the new account was told)
  const accepted = (p) => Date.parse(String(boundaries[p] ?? "").split("#")[0]);
  const markTime = (x) => (Number.isFinite(x.event_at) ? x.event_at : x.at);
  // A mark made under the new stamp is the new account's; one without a stamp, by its event's time against the acceptance
  // A mark with neither (an earlier version's) can't be told apart: it goes with the switch
  const ofNew = (x, p) => (typeof x.boundary === "string" ? x.boundary === boundaries[p]
    : Number.isFinite(x.event_at) && Number.isFinite(accepted(p)) && x.event_at >= accepted(p));
  const keep = (x) => !switched.some((p) => x.key.startsWith(`${p}.`) && !ofNew(x, p));
  return {
    switched,
    cancel: state.reminders.filter((r) => gone(r.provider)).map((r) => r.id),
    state: {
      ...state,
      reminders: state.reminders.filter((r) => !gone(r.provider)),
      told: { limits: state.told.limits.filter(keep), warned: state.told.warned.filter(keep) },
      // A stamp not known now keeps the one known before (it is compared again once known)
      boundaries: Object.fromEntries(PROVIDER_ORDER.map((p) => [p, boundaries[p] ?? state.boundaries?.[p] ?? null])),
      boundaries_version: Number.isSafeInteger(version) ? version : null,
    },
  };
}

/** The settings tag in one of Headroom's file names (null for the untagged files of old versions and other names) */
function fileTag(name) {
  const m = /^headroom-(?:view|seen|events)-([0-9a-f]{2,600})-\d{1,15}(?:\.json)?$/.exec(name)
    ?? /^headroom-notify-([0-9a-f]{2,600})\.json$/.exec(name) ?? /^headroom-lock-([0-9a-f]{2,600})$/.exec(name)
    ?? /^headroom-(?:intent|told|pair|abort)-([0-9a-f]{2,600})-[0-9a-f-]{1,60}(?:\.json)?$/.exec(name);
  return m ? m[1] : null;
}

/** Headroom's file names that belong to settings other than tag's (and the untagged files of old versions) */
function orphanFiles(names, tag) {
  return names.filter((n) => OWN_FILE.test(n) && fileTag(n) !== tag);
}

/** The saved settings, or ok: false when the Keychain can't be read (not taken for "no settings") */
function readConfigState() {
  try {
    return { ok: true, cfg: readConfig() };
  } catch (_) {
    return { ok: false, cfg: null };
  }
}

/**
 * Told cycles that still matter (keep time not passed), up to 2000: when there are more, those kept longest stay (a weekly or monthly
 * cycle isn't pushed out by many short ones)
 */
function keepTold(list) {
  const t = Date.now();
  const alive = list.filter((x) => x.until > t);
  if (alive.length <= 2000) return alive;
  return [...alive].sort((a, b) => b.until - a.until).slice(0, 2000);
}

/** Whether the lock text ("<owner> <until ms>") leaves the lock free at now */
function lockFree(text, now) {
  const until = Number(String(text ?? "").split(" ")[1]);
  return !Number.isFinite(until) || until <= now.getTime();
}

/** URL that opens the details in Scriptable (base is URLScheme.forRunningScript(); provider narrows it to one) */
function detailUrl(base, provider = null) {
  if (typeof base !== "string" || !base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}open=details${provider ? `&provider=${provider}` : ""}`;
}

// ---- Details screen (pure part): an HTML page shown in Scriptable when the widget or a notification is tapped ----

/** Escape text for HTML */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Time of day with a two-digit hour ("02:10 PM"), so the history's times line up */
function timeOfDay(date) {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(date);
  } catch (_) {
    return date.toISOString().slice(11, 16);
  }
}

/** Day heading of the history: Today, Yesterday, or "Wed, Nov 18" (local days) */
function dayLabel(date, now) {
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  try {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
  } catch (_) {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Provider icons for the page as CSS classes (.ic-claude, .ic-codex): the embedded image, or without one a tile in the provider color
 * with the sign the widget's SF Symbols show (an asterisk for Claude, a prompt for Codex). Defined once, so an image isn't repeated
 */
function iconCss() {
  return PROVIDER_ORDER.map((p) => (ICONS[p]
    ? `.ic-${p}{background:url(data:image/png;base64,${ICONS[p]}) center/contain no-repeat}`
    : `.ic-${p}{background:${BRAND_COLORS[p]};border-radius:28%}.ic-${p}::after{content:"${FALLBACK_MARKS[p].css}"}`)).join("");
}

/** Minutes since the oldest fetch among a provider's overall limits (all limits without overall ones). null if unknown */
function providerAge(p, now) {
  const list = p.main_window_ids.length > 0 ? p.main_window_ids : Object.keys(p.windows);
  let oldest = null;
  for (const id of list) {
    const t = Date.parse(p.windows[id]?.fetched_at ?? "");
    if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
  }
  return oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest) / 60000));
}

/** Rate (%/h) as a number with the widget's rounding. null if not measured */
function rateNumber(rate) {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? (rate < 10 ? Math.round(rate * 10) / 10 : Math.round(rate)) : null;
}

const CONFIDENCE_NAMES = { high: "High", medium: "Medium", low: "Low", insufficient: "Too little" };

/**
 * A time for a tile, short enough for a third of the phone's width: the clock time as the value, and under it the weekday (beyond
 * 24 hours) and a tail ("Mon · in 3d", "in 2h 10m", "Sat · runs out")
 */
function tileTime(date, now, tail) {
  const left = (date.getTime() - now.getTime()) / 60000;
  const format = (options, fallback) => {
    try {
      return new Intl.DateTimeFormat("en-US", options).format(date);
    } catch (_) {
      return fallback;
    }
  };
  const main = format({ hour: "numeric", minute: "2-digit" }, date.toISOString().slice(11, 16));
  const day = left > 24 * 60 ? format({ weekday: "short" }, "") : "";
  const text = typeof tail === "function" ? tail(left) : tail;
  return { main: esc(main), sub: [day, text].filter(Boolean).join(" · ") };
}

/**
 * The worst case under the confidence: time left until the limit at the faster of the forecast's rate and the last 15 minutes' rate (the
 * rule of the server's "limit soon" events), from the same remaining amount and fetch time as the forecast (projectionOf), so the two never
 * disagree when a newer value came with older derived values. "worst: 2h 10m", "worst: lasts" when even that reaches the reset first or
 * the rate is too small to measure, "worst: now" once it has passed. "" for derived values of the old format
 */
function worstText(w, now) {
  if (w.used_percent >= 100) return "worst: now";
  const fetched = Date.parse(w.fetched_at ?? "");
  const reset = Date.parse(w.resets_at ?? "");
  if (!("rate_pace" in w) || !Number.isFinite(fetched)) return "";
  const pace = paceOf(w);
  if (pace === null) return "worst: lasts";
  const fast = typeof w.rate_15m === "number" && Number.isFinite(w.rate_15m) ? w.rate_15m : 0;
  const at = fetched + Math.round(((100 - w.used_percent) / Math.max(pace, fast)) * 3600000);
  if (Number.isFinite(reset) && at >= reset) return "worst: lasts";
  const left = (at - now.getTime()) / 60000;
  return left < 1 ? "worst: now" : `worst: ${formatDuration(left)}`;
}

/** "in 45m", "in 3h 10m", "in 3d" (days only beyond 48 hours, to keep the tile's line short) */
function inText(minutes) {
  return `in ${minutes >= 48 * 60 ? `${Math.round(minutes / 1440)}d` : formatDuration(minutes)}`;
}

/**
 * Facts of one limit as tiles in a 3-column grid, so each fact sits in the same place on every limit:
 * row 1 ↻ Reset · Forecast · Confidence (the word, and the worst case), row 2 ↗︎ Pace (two columns wide, since its line lists every
 * rate) · ◔ Recent.
 * Each tile is a caption led by its symbol, a main value and one gray line, kept short so nothing is cut off at the phone's width.
 * The freshness is in the provider's header (dot and age). [{ caption, main (HTML), sub, warn, wide }]
 */
function detailTiles(w, now) {
  const tiles = [];
  const reset = resetDate(w, now);
  tiles.push({ caption: `${SYMBOLS.reset} Reset`, ...(reset ? tileTime(reset, now, inText)
    : w.reset_passed ? { main: "Passed", sub: "shown as 0%" } : { main: "—", sub: "unknown" }) });
  const p = projectionOf(w, now);
  const passed = runOutPassed(w, now);
  tiles.push(w.reset_passed ? { caption: "Forecast", main: "—", sub: "next value" }
    : w.used_percent >= 100 ? { caption: `${SYMBOLS.limit} Forecast`, main: "At limit", sub: "until reset" }
    : p?.runsOut ? { caption: `${SYMBOLS.runout} Forecast`, ...tileTime(new Date(p.at), now, "runs out"), warn: true }
    : p ? { caption: `${SYMBOLS.lasts} Forecast`, main: `+${Math.round(p.consume)}%`, sub: "by the reset" }
    : passed ? { caption: `${SYMBOLS.runout} Forecast`, main: "Likely", sub: "at the limit", warn: true }
    : { caption: "Forecast", main: "—", sub: w.confidence === "insufficient" ? "no data yet" : w.confidence === "low" ? "uncertain" : "unavailable" });
  // Under the confidence, the worst case: the time to the limit at the faster of the forecast's rate and the last 15 minutes'. Low and
  // too little data draw no forecast
  const drawn = w.confidence === "high" || w.confidence === "medium";
  tiles.push(w.confidence && !w.reset_passed
    ? { caption: "Confidence", main: esc(CONFIDENCE_NAMES[w.confidence]), sub: drawn ? worstText(w, now) : "not drawn" }
    : { caption: "Confidence", main: "—", sub: "no forecast" });
  const five = String(w.id).includes("five_hour");
  const rates = [["15m", w.rate_15m], ["1h", w.rate_60m], ["24h", w.rate_24h]].filter(([, v]) => rateNumber(v) !== null);
  const lead = rates.find(([k]) => k === (five ? "1h" : "24h")) ?? rates.find(([k]) => k === (five ? "24h" : "1h")) ?? rates[0];
  tiles.push(w.reset_passed || !lead ? { caption: `${SYMBOLS.pace} Pace`, main: "—", sub: "not measured", wide: true }
    : { caption: `${SYMBOLS.pace} Pace`, main: `${rateNumber(lead[1])}%/h`, wide: true,
      sub: [`over ${lead[0]}`, ...rates.filter((r) => r !== lead).map(([k, v]) => `${k} ${rateNumber(v)}%/h`)].join(" · ") });
  const recent = !w.reset_passed && w.recent_quality !== "unknown" && typeof w.recent_consumed_percent === "number";
  tiles.push(recent
    ? { caption: `${SYMBOLS.recent} Recent`, main: `${w.recent_quality === "approx" ? "≈" : ""}${Math.round(w.recent_consumed_percent * 10) / 10}%`,
      sub: w.recent_minutes ? `last ${formatDuration(w.recent_minutes)}` : "recently" }
    : { caption: `${SYMBOLS.recent} Recent`, main: "—", sub: "no data" });
  return tiles;
}

/** HTML of the tiles (the grid of a limit) */
function tilesHtml(tiles) {
  return `<div class="tiles">${tiles.map((t) => `<div class="tile${t.warn ? " warn" : ""}${t.wide ? " wide" : ""}"><em>${esc(t.caption)}</em><b>${t.main}</b><span>${esc(t.sub)}</span></div>`).join("")}</div>`;
}

/** Weekly chart of the details screen as SVG (the same lines and marks as the large widget's chart). "" without a weekly limit */
function detailChart(view, trends, providers, now) {
  const width = 340;
  const height = 140;
  const range = weekRange(now);
  const series = providers.map((provider) => {
    const window = view?.[provider]?.windows?.[TREND_WINDOW] ?? null;
    const t = trends?.[provider];
    const points = window && t && t.windowId === window.id ? t.points.filter((p) => p.at >= range.start && p.at < range.end) : null;
    return { provider, window, points };
  }).filter((s) => s.window);
  if (series.length === 0) return "";
  const marks = trendMarks(series, range, now, width, height);
  const line = (pts) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  const out = [];
  for (const t of range.days.slice(1, -1)) {
    const x = trendX(t, range, width);
    out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" class="day"/>`);
  }
  for (const level of [0, 50, 100]) {
    const y = trendY(level, height, TREND_INSET);
    out.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" class="grid"/>`);
  }
  for (const r of marks.resets) out.push(`<line x1="${r.x}" y1="0" x2="${r.x}" y2="${height}" stroke="${r.hex}" class="reset"/>`);
  for (const g of marks.guides) out.push(`<path d="${line([g.from, g.to])}" stroke="${g.hex}" class="guide"/>`);
  for (const s of trendDrawOrder(series.filter((x) => x.points && x.points.length > 0))) {
    for (const pts of sparkLines(s.points, now, width, height, TREND_INSET, TREND_HOURS, range)) {
      if (pts.length === 1) out.push(`<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="2.5" fill="${BRAND_COLORS[s.provider]}"/>`);
      else out.push(`<path d="${line(pts)}" stroke="${BRAND_COLORS[s.provider]}" class="use"/>`);
    }
  }
  for (const f of marks.forecasts) {
    out.push(`<path d="${line([f.from, f.to])}" stroke="${f.hex}" class="forecast"/>`);
    if (f.runsOut) out.push(`<circle cx="${f.to[0]}" cy="${f.to[1]}" r="3" stroke="${f.hex}" class="ring"/>`);
  }
  const today = now.getDay();
  const labels = WEEKDAYS.map((d, i) => {
    const x = (trendX(range.days[i], range, width) + trendX(range.days[i + 1], range, width)) / 2;
    return `<text x="${x}" y="${height + 13}"${i === today ? " class=\"today\"" : ""}>${d}</text>`;
  });
  const scale = `<text x="4" y="${trendY(100, height, TREND_INSET) + 10}" class="scale">100%</text><text x="4" y="${trendY(0, height, TREND_INSET) - 3}" class="scale">0%</text>`;
  // Heading on the left and the providers on the right, as in the large widget: a dot in each provider's color, gray with "–" for a
  // provider without a series this week, or "No weekly data yet" when neither has one
  const has = (s) => Boolean(s.points && s.points.length > 0);
  const legend = series.some(has)
    ? series.map((s) => `<span><i class="dot" style="background:${has(s) ? BRAND_COLORS[s.provider] : BAR_COLORS.track}"></i>${esc(PROVIDER_NAMES[s.provider])}${has(s) ? "" : " –"}</span>`).join("")
    : "<span>No weekly data yet</span>";
  return `<div class="chead"><h3>Weekly usage</h3><div class="plegend">${legend}</div></div>` +
    `<svg class="chart" viewBox="0 0 ${width} ${height + 16}" role="img" aria-label="Weekly usage this week">` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="8" class="plot"/>${out.join("")}${scale}${labels.join("")}</svg>` +
    // What the lines are, under the chart
    `<div class="llegend">${[["s-use", "Used"], ["s-forecast", "Forecast"], ["s-guide", "Even pace"], ["s-reset", "Reset"]]
      .map(([cls, text]) => `<span><svg class="sample" viewBox="0 0 18 8"><line x1="0" y1="4" x2="18" y2="4" class="${cls}"/></svg>${text}</span>`).join("")}</div>`;
}

/** Whether to show "5h limit: Not available" for a provider (the same rule as the widget: values fetched, overall limits but no 5h) */
function missingFiveHour(p) {
  return Boolean(p && (p.status === "ok" || p.status === "stale") && p.main_window_ids.length > 0 && !p.main_window_ids.includes("five_hour"));
}

/**
 * The details page (HTML). input: { view, events (sanitized list or null), trends, now, provider (one, or null for both), note }.
 * Every limit is listed, a missing 5h limit as Not available too. Facts are tiles in a fixed grid led by monochrome symbols, with the widget's
 * freshness dot with the age of the values and the providers' icons. Everything shown is escaped; nothing is loaded from
 * the network (the page is self-contained)
 */
function detailHtml(input) {
  const { view, events, trends, now, provider = null, note = "" } = input;
  // The providers the widget shows by default (Codex, Claude and any other with values), or the one tapped
  const providers = provider ? [provider] : defaultProviders(view);
  const sections = providers.map((id) => {
    const p = view?.[id] ?? null;
    const fresh = p ? freshnessOf(view, id, now) : { level: "unknown", text: "" };
    // The age of the values beside the dot, always (the widget shows it only when old; here it stands in for each limit's own)
    const age = p ? providerAge(p, now) : null;
    const ageText = age === null ? "" : age < 1 ? "now" : formatDuration(age);
    // As the widget's header: the icon, the name group and the freshness dot are centered in the row, the name and the plan share a baseline
    const head = `<header class="ph"><i class="ic ic-${id}"></i><span class="pn"><h2 style="color:${BRAND_COLORS[id]}">${esc(PROVIDER_NAMES[id])}</h2>` +
      `${p?.plan ? `<span class="plan">${esc(PLAN_NAMES[p.plan] ?? "")}</span>` : ""}</span>` +
      `<span class="fresh">${ageText ? `<span>${esc(ageText)}</span>` : ""}<i class="dot" style="background:${FRESH_COLORS[fresh.level]}"></i></span></header>`;
    if (!p) return `<section>${head}<p class="message">${esc(SYMBOLS.unknown)} ${esc(missingText(id))}</p></section>`;
    const message = p.window_ids.length === 0 ? `<p class="message">${esc(SYMBOLS.runout)} ${esc(ERROR_NAMES[p.error_code] ?? "No limits to show")}</p>` +
      (p.error_code === "access_denied" ? `<p class="na-note">${esc(DENIED_HINT)}</p>` : "") : "";
    const missing = missingFiveHour(p)
      ? `<div class="limit na"><div class="top"><span class="name">5h limit</span><b>—</b></div><div class="bar"></div>` +
        `<p class="na-note">${esc(NOT_AVAILABLE)}</p></div>`
      : "";
    const ids = [...p.main_window_ids, ...p.window_ids.filter((x) => !p.main_window_ids.includes(x))];
    const limits = ids.map((wid) => {
      const w = atDisplayTime(p.windows[wid], now);
      const s = barSegmentsAt(w, now);
      const pct = (x) => `${Math.max(0, Math.round(x * 1000) / 10)}%`;
      const bar = `<div class="bar${s.faded ? " faded" : ""}"><i style="width:${pct(s.remaining - s.projected)};background:${BRAND_COLORS[id]}"></i>` +
        `<i class="projected" style="width:${pct(s.projected)};background:${BRAND_COLORS[id]}"></i><i class="recent" style="width:${pct(s.recent)}"></i></div>`;
      const mark = w.reset_passed ? `${RESET_MARK} ` : "";
      return `<div class="limit${w.value_status === "old" ? " old" : ""}"><div class="top"><span class="name">${esc(limitLabel(w))}</span><b>${esc(mark + remainingText(w))}</b></div>${bar}` +
        `${tilesHtml(detailTiles(w, now))}</div>`;
    }).join("");
    return `<section>${head}${message}${missing}${limits}</section>`;
  }).join("");
  const chart = detailChart(view, trends, providers, now);
  const chartSection = chart ? `<section>${chart}</section>` : "";
  // History: newest first, by day; each row is the time, the provider's icon, the limit and what happened
  const shown = (events ?? []).filter((e) => !provider || e.provider === provider || e.provider === null).slice(-30).reverse();
  let history = "";
  let day = null;
  for (const e of shown) {
    const at = Date.parse(e.created_at ?? "");
    const date = Number.isFinite(at) ? new Date(at) : null;
    const label = date ? dayLabel(date, now) : "";
    if (label !== day) {
      history += `${day === null ? "" : "</ul>"}<h4>${esc(label)}</h4><ul class="events">`;
      day = label;
    }
    const limit = eventLimit(e);
    history += `<li><time>${esc(date ? timeOfDay(date) : "")}</time><i class="ic${e.provider ? ` ic-${e.provider}` : ""}"></i>` +
      `${limit ? `<span class="lim">${esc(limit)}</span>` : ""}<span class="what">${esc(eventPhrase(e))}</span></li>`;
  }
  if (day !== null) history += "</ul>";
  const historySection = events === null ? "" : `<section><h3>History</h3>${history || `<p class="message">Nothing in the last 8 days</p>`}</section>`;
  const css = `
:root{color-scheme:light dark;--text:#1c1c1e;--sub:#6e6e73;--line:rgba(142,142,147,.22);--track:rgba(142,142,147,.2);--chip:rgba(142,142,147,.12);--bg:#f2f2f7;--card:#fff}
@media (prefers-color-scheme:dark){:root{--text:#f2f2f7;--sub:#a1a1a6;--bg:#000;--card:#1c1c1e;--chip:rgba(142,142,147,.2)}}
*{font-variant-emoji:text}
body{margin:0;padding:16px 14px 28px;font:15px -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);font-variant-numeric:tabular-nums}
.page{display:flex;align-items:baseline;justify-content:space-between;margin:2px 4px 12px}h1{font-size:24px;margin:0}.page span{color:var(--sub);font-size:13px}
section{background:var(--card);border-radius:16px;padding:14px;margin-bottom:12px}
.ph{display:flex;align-items:center;gap:8px;margin-bottom:2px}.pn{display:flex;align-items:baseline;gap:6px}
.ph h2{font-size:18px;line-height:1;margin:0}.plan{color:var(--sub);font-size:13px;line-height:1}
.fresh{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--sub);font-size:13px;line-height:1}.fresh .dot{width:9px;height:9px;margin:0}
.ic{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;color:#fff;font:600 12px ui-monospace,monospace}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:middle;flex:none}
.limit{padding:20px 0 10px}.limit:last-child{padding-bottom:2px}.limit+.limit,.na+.limit{border-top:1px solid var(--line)}
.top{display:flex;justify-content:space-between;align-items:baseline}.name{font-size:15px;font-weight:400;color:var(--text)}.top b{font-size:24px;font-weight:600}.old .top b{color:var(--sub)}
.bar{display:flex;height:8px;border-radius:4px;background:var(--track);overflow:hidden;margin:6px 0 8px}
.bar i{display:block;height:100%}.bar .projected{opacity:.35}.bar .recent{background:#6B7280}.bar.faded{opacity:.35}
.na .name,.na .top b{color:var(--sub)}.na .bar{opacity:.5}
.tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.tile{background:var(--chip);border-radius:10px;padding:6px 8px;min-width:0}.tile.wide{grid-column:span 2}.tile.warn{box-shadow:inset 0 0 0 1.5px rgba(142,142,147,.55)}
.tile em{display:block;font-style:normal;font-size:11px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tile b{display:block;font-size:15px;font-weight:600;margin:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile span{display:block;font-size:11px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:1.2em}
.na-note{color:var(--sub);font-size:13px;margin:0}.lim{color:var(--sub);font-size:11px}
.message{color:var(--sub);margin:6px 0}
h3{font-size:16px;margin:0 0 10px}h4{font-size:12px;color:var(--sub);margin:12px 0 4px;text-transform:uppercase;letter-spacing:.04em}h4:first-of-type{margin-top:0}
.chart{width:100%;height:auto;display:block}.plot{fill:var(--track);opacity:.5}.grid,.day{stroke:var(--line);stroke-width:.5}
.reset{stroke-width:1;stroke-dasharray:3 3;opacity:.8}.guide{stroke-width:1;opacity:.45;fill:none}.use{stroke-width:2.5;fill:none;stroke-linejoin:round;stroke-linecap:round}
.forecast{stroke-width:1.5;stroke-dasharray:2 2.5;opacity:.9;fill:none}.ring{fill:none;stroke-width:1.5}
text{font-size:10px;fill:var(--sub);text-anchor:middle}text.today{fill:var(--text);font-weight:600}text.scale{text-anchor:start;font-size:8px}
.chead{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.chead h3{margin:0}
.plegend{display:flex;gap:12px;font-size:13px;color:var(--sub)}.plegend span{display:inline-flex;align-items:center}.plegend .dot{width:7px;height:7px}
.sample{width:18px;height:8px;vertical-align:middle}.sample line{stroke:var(--sub)}
.s-use{stroke-width:2.5}.s-forecast{stroke-width:1.5;stroke-dasharray:2 2.5}.s-guide{stroke-width:1;opacity:.6}.s-reset{stroke-width:1;stroke-dasharray:3 3}
.llegend{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 12px;font-size:12px;color:var(--sub);margin-top:6px}.llegend span{display:inline-flex;align-items:center;gap:4px}
.events{list-style:none;margin:0;padding:0}.events li{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:14px}
.events li:first-child{border-top:0}.events time{min-width:70px;color:var(--sub);font-size:13px}.events .ic{width:16px;height:16px;font-size:8px}
${iconCss()}`;
  const sub = note ? `${SYMBOLS.runout} ${note.replace(/^⚠︎ /, "")}` : `As of ${clockText(now, now)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Headroom</title><style>${css}</style></head><body><div class="page"><h1>Headroom</h1><span>${esc(sub)}</span></div>` +
    `${sections}${chartSection}${historySection}</body></html>`;
}

// ---- Parameter guide (pure part): what the widget's Parameter can say, and the builder's choices ----

/** Choices of "Make a parameter" per place: [label, parameter before notify] */
const PARAMETER_CHOICES = {
  home: [
    ["Codex and Claude (and any other with values)", ""], ["All three", "codex, claude, gemini"], ["Claude only", "claude"],
    ["Codex only", "codex"], ["Gemini only", "gemini"], ["Codex and Claude only", "codex, claude"], ["Claude and Gemini", "claude, gemini"],
    ["Codex and Gemini", "codex, gemini"], ["Tightest limit of each", "top"],
  ],
  lock: [
    ["Tightest limit", ""], ["Claude 5h", "claude 5h"], ["Claude weekly", "claude weekly"], ["Codex 5h", "codex 5h"],
    ["Codex weekly", "codex weekly"], ["Gemini 5h", "gemini 5h"], ["Gemini weekly", "gemini weekly"],
    ["5h of Codex and Claude, side by side", "both 5h"], ["Weekly of Codex and Claude, side by side", "both weekly"],
    ["Claude 5h and weekly", "claude 5h, claude weekly"],
  ],
};

/** The parameter from a choice and whether this widget notifies ("claude, notify"; "" means leave it empty) */
function buildParameter(base, notify) {
  return [String(base ?? "").trim(), notify ? "notify" : ""].filter(Boolean).join(", ");
}

/** The guide: sections of [parameters (alternatives joined with " · "), what it shows] */
const PARAMETER_GUIDE = [
  ["Home screen", [
    ["(empty)", "Codex and Claude, and Gemini once it has values: their overall limits. Per-model limits only at 100% (on Large, always)"],
    ["claude · codex · gemini", "That provider only"],
    ["codex, claude, gemini · claude, gemini", "Those providers side by side (up to three), in that order. One without values shows Not supported (Gemini) or No data"],
    ["top", "The tightest limit of each provider"],
    ["claude.five_hour, gemini.seven_day", "Those limits, in that order"],
  ]],
  ["Lock screen", [
    ["(empty)", "The limit with the least left (Inline: each provider's tightest)"],
    ["5h · weekly", "That limit, of the provider with less left"],
    ["claude 5h · gemini weekly", "That limit of that provider"],
    ["claude · codex · gemini", "That provider's tightest limit"],
    ["claude 5h, codex 5h · codex 5h + codex weekly", "Two side by side on Rectangular (Circular shows the first, Inline both)"],
    ["both · both 5h · both weekly", "Codex and Claude side by side"],
  ]],
  ["Add to any", [
    ["notify", "This widget also sends notifications, as in claude, notify. Add it to one widget only"],
    ["demo · demo:runout", "Sample data instead of your values: normal, runout, no5h, stale, reset, offline, error, nochart, three, unsupported"],
  ]],
];

/** The parameter guide page (HTML; self-contained, the details screen's look) */
function parameterGuideHtml() {
  const sections = PARAMETER_GUIDE.map(([title, rows]) => `<section><h3>${esc(title)}</h3>${rows.map(([params, what]) =>
    `<div class="row"><div>${params.split(" · ").map((p) => p === "(empty)" ? `<span class="empty">Empty</span>` : `<code>${esc(p)}</code>`).join(" ")}</div>` +
    `<p>${esc(what)}</p></div>`).join("")}</section>`).join("");
  const css = `
:root{color-scheme:light dark;--text:#1c1c1e;--sub:#6e6e73;--line:rgba(142,142,147,.22);--chip:rgba(142,142,147,.14);--bg:#f2f2f7;--card:#fff}
@media (prefers-color-scheme:dark){:root{--text:#f2f2f7;--sub:#a1a1a6;--bg:#000;--card:#1c1c1e;--chip:rgba(142,142,147,.24)}}
body{margin:0;padding:16px 14px 28px;font:15px -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text)}
h1{font-size:24px;margin:2px 4px 6px}.how{color:var(--sub);font-size:13px;margin:0 4px 12px;line-height:1.45}
section{background:var(--card);border-radius:16px;padding:14px;margin-bottom:12px}h3{font-size:16px;margin:0 0 4px}
.row{padding:10px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}.row p{margin:5px 0 0;color:var(--sub);font-size:13px;line-height:1.4}
code,.empty{display:inline-block;font:600 13.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--chip);padding:2px 7px;border-radius:6px;margin:0 4px 4px 0}
.empty{font-family:-apple-system,system-ui,sans-serif;font-weight:500;color:var(--sub)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Widget parameter</title><style>${css}</style></head><body><h1>Widget parameter</h1>` +
    `<p class="how">Long-press the widget, choose Edit Widget, and type into Parameter. Upper or lower case doesn't matter; separate items with commas. ` +
    `In the app menu, Widget › Make a parameter builds one and copies it.</p>${sections}</body></html>`;
}

// ------------------------------------------------------------------------------------------------
// Widget rendering below (uses the Scriptable API)

/**
 * Demo, so every display state can be checked. Draws with made-up values only: no network, never reads
 * or saves the previous view (never mixed with real values). Shows Demo in the header and on the lock screen.
 * Chosen with the widget parameter demo (= runout) or demo:<name>, or Widget > "Preview sample data" in the app menu
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
  // Gemini with values: three columns by default (its own model limit at 100%, the Claude and GPT models in the details only)
  { name: "three", title: "Three providers (Gemini on)" },
  // Drawn with all three named (the widget's parameter, when it names nothing else, or the preview's)
  { name: "unsupported", title: "Gemini not supported yet (all three)", parameter: "gemini, codex, claude" },
];

/**
 * If one of the parameter's comma-separated items is a demo, its name (demo alone is runout; unknown names are runout too). null otherwise.
 * The other items still choose what to show (claude, demo:normal)
 */
function demoName(parameter) {
  for (const item of String(parameter ?? "").split(",")) {
    const m = /^demo(?:[:\s]+(\w+))?$/i.exec(item.trim());
    if (!m) continue;
    const name = (m[1] ?? "runout").toLowerCase();
    return DEMO_SCENARIOS.some((s) => s.name === name) ? name : "runout";
  }
  return null;
}

/** What a demo draws when the widget's parameter names nothing else (a scenario that needs more providers than the default) */
function demoParameter(name) {
  return DEMO_SCENARIOS.find((x) => x.name === name)?.parameter ?? "";
}

/** The parameter without its demo item (what the demo shows) */
function withoutDemo(parameter) {
  return String(parameter ?? "").split(",").map((x) => x.trim()).filter((x) => x && !/^demo(?:[:\s]+\w+)?$/i.test(x)).join(", ");
}

/** Demo result (in the shape passed to render). The view and trend go through the same validation as real data (sanitizeView, sanitizeHistory) */
function demoResult(name, now) {
  const at = (minutes) => new Date(now.getTime() + minutes * 60000).toISOString();
  const win = (id, used, o = {}) => ({
    id, label: id, scope: o.scope ?? null, used_percent: used,
    recent_consumed_percent: o.recent ?? null, recent_quality: o.recent === undefined ? "unknown" : "exact", recent_minutes: id.includes("five_hour") ? 60 : 1440,
    confidence: "high", fetched_at: at(-(o.age ?? 1)),
    resets_at: at(o.resets ?? (id.includes("five_hour") ? 180 : 3 * 1440)),
    eta_at: null, reset_first: null, eta_minutes: null, rate_15m: null,
    rate_60m: o.rate ?? null, rate_24h: o.rate ?? null, rate_pace: o.rate ?? 0,
    detail_only: o.detail === true,
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
  // Gemini (only in "three"; in the others it is turned off on the PCs, as by default, so the view has none): its own model limit
  // (Argon) at 100%, and the Claude and GPT models it offers (shown in the details only)
  const gemini = () => [win("five_hour", 28, { recent: 4, rate: 3, age }), win("seven_day", 33, { recent: 4, rate: 0.4, age }),
    win("seven_day_argon", 100, { scope: "Argon", resets: 2 * 1440, age }),
    win("partner_five_hour", 8, { scope: "Claude and GPT", detail: true, age }), win("partner_seven_day", 5, { scope: "Claude and GPT", detail: true, age })];
  const body = {
    view_version: VIEW_VERSION, data_version: 1, boundaries: { claude: "#0", codex: "#0", gemini: "#0" },
    claude: name === "error"
      ? { status: "error", plan: "max", error_code: "login_required", main_window_ids: "", window_ids: "", windows: {} }
      : provider("max", (claude[name] ?? claude.normal)()),
    codex: name === "error" ? null : provider("plus", (codex[name] ?? codex.normal)()),
    gemini: name === "three" ? provider("pro", gemini()) : null,
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
  const trends = Object.fromEntries(PROVIDER_ORDER.flatMap((p) => (trend(p) ? [[p, trend(p)]] : [])));
  return { view, trends, demo: true, ...(name === "offline" ? { cachedAt: at(-25) } : {}) };
}

/** Sizes the preview offers: [label, widget family, Scriptable's method, place] (the lock screen's need iOS 16) */
const PREVIEW_SIZES = [
  ["Small", "small", "presentSmall", "home"], ["Medium", "medium", "presentMedium", "home"], ["Large", "large", "presentLarge", "home"],
  ["Lock screen · Rectangular", "accessoryRectangular", "presentAccessoryRectangular", "lock"],
  ["Lock screen · Circular", "accessoryCircular", "presentAccessoryCircular", "lock"],
  ["Lock screen · Inline", "accessoryInline", "presentAccessoryInline", "lock"],
];

/**
 * Choose a size and show the widget in it, again after closing until Back. load(family) gives what to draw (as render takes it);
 * place limits the sizes to the home or lock screen; parameter is drawn as the widget's Parameter
 */
async function previewSizes(title, load, place = null, parameter = "") {
  const sizes = PREVIEW_SIZES.filter((s) => !place || s[3] === place);
  for (;;) {
    const pick = new Alert();
    pick.title = title;
    for (const [label] of sizes) pick.addAction(label);
    pick.addCancelAction("Back");
    const index = await pick.presentSheet();
    if (index < 0 || index >= sizes.length) return;
    const [, family, method] = sizes[index];
    const result = await load(family);
    const widget = render(result, family, parameter, new Date());
    try {
      await widget[method]();
    } catch (_) { /* this size can't be previewed on this device */ }
  }
}

/** A sheet of choices: the chosen index, or -1 for the cancel button */
async function choose(title, message, labels, cancel = "Back") {
  const pick = new Alert();
  pick.title = title;
  if (message) pick.message = message;
  for (const label of labels) pick.addAction(label);
  pick.addCancelAction(cancel);
  const index = await pick.presentSheet();
  return index >= 0 && index < labels.length ? index : -1;
}

/**
 * "Widget": preview it with the current values (read from the server as a widget refresh does) or with sample data for each state
 * (no network, nothing saved) in every size, make a parameter, or read the parameter guide
 */
async function widgetMenu() {
  for (;;) {
    const choice = await choose("Widget", null, ["Preview current values", "Preview sample data", "Make a parameter", "Parameter guide"]);
    if (choice === 0) await previewSizes("Current values", (family) => loadResult(loadConfig(), family, ""));
    else if (choice === 1) await sampleMenu();
    else if (choice === 2) await parameterBuilder();
    else if (choice === 3) await showPage(parameterGuideHtml());
    else return;
  }
}

/** Sample data: each display state with made-up values (the widget parameter demo:<name> shows the same on a widget) */
async function sampleMenu() {
  for (;;) {
    const index = await choose("Sample data", "Made-up values for each state. No network, nothing saved.", DEMO_SCENARIOS.map((s) => s.title));
    if (index < 0) return;
    await previewSizes(DEMO_SCENARIOS[index].title, () => demoResult(DEMO_SCENARIOS[index].name, new Date()), null, demoParameter(DEMO_SCENARIOS[index].name));
  }
}

/**
 * "Make a parameter": asks where the widget is, what it shows and whether it sends notifications, then shows the parameter to copy
 * (to paste into the widget's Parameter) or to preview with the current values in that place's sizes
 */
async function parameterBuilder() {
  const where = await choose("Make a parameter", "Where is the widget?", ["Home screen", "Lock screen"]);
  if (where < 0) return;
  const place = where === 0 ? "home" : "lock";
  const options = PARAMETER_CHOICES[place];
  const what = await choose("What it shows", null, options.map(([label]) => label));
  if (what < 0) return;
  const notifies = await choose("Notifications", "Send notifications from this widget? Only one widget should.", ["No", "Yes"]);
  if (notifies < 0) return;
  const parameter = buildParameter(options[what][1], notifies === 1);
  const display = splitNotify(parameter).display ?? "";
  for (;;) {
    const actions = parameter ? ["Copy", "Preview"] : ["Preview"];
    const index = await choose(parameter || "Leave it empty",
      parameter ? "Long-press the widget, choose Edit Widget, and paste this into Parameter." : "This widget needs no parameter.", actions, "Done");
    const action = index < 0 ? null : actions[index];
    if (action === "Copy") {
      try {
        Pasteboard.copyString(parameter);
      } catch (_) { /* nothing copied */ }
      return;
    }
    if (action !== "Preview") return;
    await previewSizes(parameter || "No parameter", (family) => loadResult(loadConfig(), family, display), place, display);
  }
}

/** Show a self-contained HTML page in the app */
async function showPage(html) {
  const web = new WebView();
  await web.loadHTML(html);
  await web.present();
}

/**
 * What a widget draws: the view (or the previous one when fetching fails) and, at sizes with the chart, the weekly trend read only for
 * a freshly fetched view. Shared by widget refreshes and the app's preview
 */
async function loadResult(cfg, family, display) {
  let result = cfg ? await loadView(cfg) : { error: "Run in Scriptable to set up" };
  if (cfg && result.fetched && SIZE_CONTENT[family]?.trend) {
    // Discard a provider's trend if an account switch happened while reading it (boundary stamps differ). The view is what the server
    // returned when read, so show it as is; it is replaced on the next refresh (same as normal staleness). This keeps two accounts'
    // values from being mixed within one draw. (Re-fetching the view in this case was removed)
    result = { ...result, trends: await loadTrends(cfg, result.view, trendWindows(result.view, family, display, new Date(), screenSize()), new Date()) };
    // If another run saved a newer number while waiting for the trend, don't draw this view and trend; show the newer previous view
    result = newestView(cfg, result);
  }
  // Settings were deleted or re-saved during the fetch: don't draw the old settings' values
  if (cfg && !sameConfig(cfg, loadConfig())) result = { error: "Settings changed. Updates on next refresh" };
  return result;
}

async function main() {
  // "notify" in the widget parameter chooses the one widget that also notifies; the rest of the parameter chooses what to show
  const { display, notify } = splitNotify(config.runsInWidget ? args.widgetParameter : null);
  // Parameter demo / demo:<name> (alone or with other items): draw only the demo (no network, no saving, no notifications)
  const demo = config.runsInWidget ? demoName(display) : null;
  if (demo !== null) {
    const now = new Date();
    const widget = render(demoResult(demo, now), config.widgetFamily, withoutDemo(display) || demoParameter(demo), now);
    Script.setWidget(widget);
    Script.complete();
    return;
  }
  // From a shortcut with "notify": only the notification work, no menu or screen (the summary is the shortcut's output)
  if (!config.runsInWidget && splitNotify(typeof args.shortcutParameter === "string" ? args.shortcutParameter : "").notify) {
    const cfg = loadConfig();
    const viewed = cfg ? await loadView(cfg) : null;
    Script.setShortcutOutput(cfg ? await notifyRun(cfg, viewed?.unreceived ? null : viewed?.view ?? null, Boolean(viewed?.fetched), viewed?.unreceived ? viewed.view?.data_version ?? null : null) : "Run Headroom in Scriptable to set it up");
    Script.complete();
    return;
  }
  // Opened by tapping the widget or a notification: the details
  const query = args.queryParameters ?? {};
  if (!config.runsInWidget && query.open === "details" && loadConfig()) {
    await showDetails(loadConfig(), oneOf(query.provider, PROVIDER_ORDER));
    Script.complete();
    return;
  }
  // Run in the app: the menu
  if (!config.runsInWidget) {
    await appMenu();
    Script.complete();
    return;
  }
  const cfg = loadConfig();
  const family = config.widgetFamily;
  const result = await loadResult(cfg, family, display);
  // Files of other settings (left by a reset or a server change that couldn't remove them)
  const cfgOrigin = normalizeBaseUrl(cfg?.url);
  if (cfg && cfgOrigin) removeCache(cacheTag(cfg, cfgOrigin));
  // Take the draw time after waiting for the fetch (so a reset crossed while waiting doesn't show the previous cycle's values)
  const widget = render({ ...result, tap: scriptUrl() }, family, display, new Date());
  Script.setWidget(widget);
  // The widget chosen with "notify" also schedules time reminders and tells new events (after the widget is set, so a slow
  // notification step never leaves the widget blank)
  if (notify && cfg) await notifyRun(cfg, result.unreceived ? null : result.view ?? null, Boolean(result.fetched), result.unreceived ? result.view?.data_version ?? null : null);
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

/** The saved settings, or null when there are none (or the saved value is corrupt). A Keychain that can't be read throws */
function readConfig() {
  if (Keychain.contains(KEYCHAIN_CURRENT)) {
    const text = Keychain.get(KEYCHAIN_CURRENT);
    let id = null;
    try {
      id = JSON.parse(text)?.id ?? null;
    } catch (_) { /* a corrupt pointer names no settings */ }
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id) || !Keychain.contains(configKey(id))) return null;
    const own = Keychain.get(configKey(id));
    try {
      const c = JSON.parse(own);
      return c && typeof c.url === "string" && typeof c.token === "string" && c.id === id ? { url: c.url, token: c.token, id, keyed: true } : null;
    } catch (_) {
      return null;
    }
  }
  if (Keychain.contains(KEYCHAIN_CONFIG)) {
    const text = Keychain.get(KEYCHAIN_CONFIG);
    try {
      const c = JSON.parse(text);
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
 * Save the settings as a new generation (only when saving in the app): its switches (those of previous, the settings it replaces; none
 * for a first setup, so switches left by removed settings never carry over), its settings in a single write, then the item naming it.
 * Then the replaced generation's items and earlier versions' items go (only cleanup: they are no longer read). Throws if the previous
 * switches can't be read or a write fails (the previous settings stay current). A half-swapped server and credentials are never read
 */
function saveConfig(checked, previous = null) {
  let id = "";
  for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
  const c = { url: checked.url, token: checked.token, id };
  const own = notifyKey({ ...c, keyed: true });
  // The switches it replaces, as read (a generation of this version always has its item: one missing was removed meanwhile)
  const k = previous ? notifyKey(previous) : null;
  const before = k && Keychain.contains(k) ? Keychain.get(k) : null;
  if (previous?.keyed && before === null) throw new Error("changed");
  const p = notifyPrefs(before);
  if (p === null) throw new Error("switches");
  // Written explicitly, also the defaults of a first setup
  Keychain.set(own, JSON.stringify(previous ? successorSwitches(p, configId(previous)) : { events: true, times: true }));
  Keychain.set(configKey(id), JSON.stringify(c));
  // Published only while what it replaces is as read: settings removed or replaced meanwhile, or switches changed, stop it (its items go)
  if (previous) {
    const now = Keychain.contains(k) ? Keychain.get(k) : null;
    if (now !== before || !sameConfig(previous, readConfig())) {
      for (const item of [own, configKey(id)]) {
        try {
          Keychain.remove(item);
        } catch (_) { /* never named by the current item */ }
      }
      throw new Error("changed");
    }
  }
  Keychain.set(KEYCHAIN_CURRENT, JSON.stringify({ id }));
  // A change of the replaced switches between that check and the publish is carried over to the new generation
  if (previous) {
    try {
      const after = Keychain.contains(k) ? Keychain.get(k) : null;
      const q = after !== null && after !== before ? notifyPrefs(after) : null;
      if (q) Keychain.set(own, JSON.stringify(successorSwitches(q, configId(previous))));
    } catch (_) { /* the switches as copied stay */ }
  }
  const old = [KEYCHAIN_CONFIG, KEYCHAIN_NOTIFY, ...Object.values(KEYCHAIN_LEGACY)];
  if (previous?.keyed) old.push(configKey(configId(previous)), notifyKey(previous));
  for (const k of old) {
    try {
      if (Keychain.contains(k)) Keychain.remove(k);
    } catch (_) { /* not read anymore; removed by Remove all */ }
  }
  return { ...c, keyed: true };
}

/**
 * The switches a new generation takes over from the one it replaces: limit alerts and time reminders, and the cancelling still owed (its
 * own, and the replaced generation's reminders if time reminders were off or a cancel was pending)
 */
function successorSwitches(p, previousGen) {
  const owed = p.cancels.slice();
  if (!p.times || p.cancel_pending) owed.push({ op: runMark(), gen: previousGen, before: Date.now() });
  return { events: p.events, times: p.times, cancels: owed, cancel_pending: owed.length > 0 };
}

/**
 * Remove the settings cfg from the Keychain (Remove all): this generation's items and earlier versions' items. Settings saved meanwhile
 * by another run are another generation in items of their own, and stay with their switches. false if an item couldn't be removed
 */
function removeSettingsOf(cfg) {
  // Each group's settings before its switches: settings a failure leaves behind keep their switches (alone, they would read as both on)
  const own = cfg?.keyed ? [configKey(configId(cfg)), notifyKey(cfg)] : [];
  const shared = [KEYCHAIN_CONFIG, ...Object.values(KEYCHAIN_LEGACY), KEYCHAIN_NOTIFY];
  // The items shared with earlier versions are all read before any of them is removed: one that can't be read leaves them all (not
  // counted as done). A generation's own items need no reading
  let sharedRead = true;
  for (const k of shared) {
    try {
      if (Keychain.contains(k)) Keychain.get(k);
    } catch (_) {
      sharedRead = false;
    }
  }
  let ok = sharedRead;
  for (const group of [own, sharedRead ? shared : []]) {
    for (const k of group) {
      try {
        if (Keychain.contains(k)) Keychain.remove(k);
      } catch (_) {
        // The rest of this group stays with it
        ok = false;
        break;
      }
    }
  }
  return ok;
}

/** Only the names of files Headroom created */
function fileNames(fm) {
  return ownFiles(fm) ?? [];
}

/** Names of Headroom's files, or null when the folder can't be listed (a cursor must not read that as "no marker yet") */
function ownFiles(fm) {
  try {
    return fm.listContents(fm.documentsDirectory()).filter((n) => OWN_FILE.test(n));
  } catch (_) {
    return null;
  }
}

/** Delete previous views and seen-number markers (only Headroom's files, for every server; when the server changes or settings are deleted) */
function removeCache(keepTag = null, dropTag = null) {
  const fm = FileManager.local();
  const names = ownFiles(fm);
  if (names === null) return false;
  // The settings saved now keep theirs (read after the list, so settings saved meanwhile keep theirs too), unless they are the ones
  // being removed. Settings that can't be read: nothing is removed
  const saved = readConfigState();
  if (!saved.ok) return false;
  const savedOrigin = normalizeBaseUrl(saved.cfg?.url);
  const keep = new Set([keepTag, saved.cfg && savedOrigin ? cacheTag(saved.cfg, savedOrigin) : null].filter((x) => x && x !== dropTag));
  let ok = true;
  for (const name of names) {
    if (keep.has(fileTag(name))) continue;
    try {
      fm.remove(fm.joinPath(fm.documentsDirectory(), name));
    } catch (_) {
      ok = false; // keep going; reported by the caller
    }
  }
  return ok;
}

/**
 * Save the received view to that number's file, create the seen-number marker and delete older numbers' files (display continues if any of this fails).
 * The seen number lives only in the marker files (only created, higher numbers never deleted, so overlapping runs can't go backwards).
 * If the marker can't be created, the previous view isn't saved either (so only previous views not older than the seen number remain)
 */
function saveCache(fm, tag, origin, view) {
  return saveCacheBody(fm, tag, origin, view);
}

/** saveCache's work: true once the seen marker is written (the view is received), false otherwise */
function saveCacheBody(fm, tag, origin, view) {
  const dir = fm.documentsDirectory();
  const v = view.data_version;
  try {
    // An empty view (both providers withdrawn) says so in its marker: a notifying run that can't read the body still knows
    fm.writeString(fm.joinPath(dir, seenFileName(tag, v)), PROVIDER_ORDER.every((p) => view[p] === null) ? "withdrawn" : "");
  } catch (_) {
    // Can't create the marker (device storage not writable): don't save the previous view and don't delete anything. The view isn't
    // received (false): shown this time, but nothing is planned from it
    return false;
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
  return true;
}

/** Whether the seen marker of version v says it was a withdrawal (an empty view) */
function withdrawnAt(fm, tag, v) {
  try {
    return fm.readString(fm.joinPath(fm.documentsDirectory(), seenFileName(tag, v))) === "withdrawn";
  } catch (_) {
    return false;
  }
}

/** The empty view of a withdrawal at version v (both providers withdrawn) */
function emptyViewAt(v) {
  return { view_version: VIEW_VERSION, data_version: v, boundaries: null, ...Object.fromEntries(PROVIDER_ORDER.map((p) => [p, null])) };
}

/**
 * Usable previous view (same server, not older than the seen number, newest), decided from one list of the files (names; read now when
 * not given). null if none
 */
function loadCache(fm, tag, origin, names = fileNames(fm)) {
  const best = pickCache(names, tag, seenFrom(names, tag));
  if (!best) return null;
  try {
    return readCache(fm.readString(fm.joinPath(fm.documentsDirectory(), best.name)), origin);
  } catch (_) {
    return null;
  }
}

/** The server's host for the menus (no scheme, no token) */
function hostOf(cfg) {
  return normalizeBaseUrl(cfg?.url)?.replace(/^https:\/\//, "") ?? "";
}

/**
 * Menu when the script runs in the app. Asks for the settings first when there are none. Every choice comes back here (Back in a
 * submenu); Close ends:
 * - Details: the details screen (the same as tapping the widget)
 * - Widget: preview it with current values or sample data in every size, make a parameter, the parameter guide
 * - Notifications: sample notifications, each kind on or off
 * - Settings: server and token, reset saved data, remove everything
 */
async function appMenu() {
  if (!loadConfig() && !(await editSettings())) return;
  for (;;) {
    const cfg = loadConfig();
    // All settings were removed
    if (!cfg) return;
    const menu = new Alert();
    menu.title = "Headroom";
    menu.message = hostOf(cfg);
    menu.addAction("Details");
    menu.addAction("Widget");
    menu.addAction("Notifications");
    menu.addAction("Settings");
    menu.addCancelAction("Close");
    const choice = await menu.presentSheet();
    if (choice === 0) await showDetails(cfg, null);
    else if (choice === 1) await widgetMenu();
    else if (choice === 2) await notificationMenu();
    else if (choice === 3) await settingsMenu();
    else return;
  }
}

/** A destructive action's confirmation (true to go ahead) */
async function confirmAlert(title, message, action) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addDestructiveAction(action);
  alert.addCancelAction("Cancel");
  return (await alert.present()) === 0;
}

/** A short notice with OK */
async function notice(title, message) {
  const alert = new Alert();
  alert.title = title;
  alert.message = message;
  alert.addAction("OK");
  await alert.present();
}

/** "Settings": the server and token, resetting saved data, removing everything (both asked to confirm) */
async function settingsMenu() {
  for (;;) {
    const cfg = loadConfig();
    if (!cfg) return;
    const menu = new Alert();
    menu.title = "Settings";
    menu.message = `Server: ${hostOf(cfg)}`;
    menu.addAction("Server and token");
    menu.addDestructiveAction("Reset saved data");
    menu.addDestructiveAction("Remove all settings");
    menu.addCancelAction("Back");
    const choice = await menu.presentSheet();
    if (choice === 0) {
      await editSettings();
    } else if (choice === 1) {
      if (await confirmAlert("Reset saved data?", "Forgets saved values, scheduled reminders and where alerts left off. Use this after the server's database is recreated.", "Reset")) {
        await resetSavedData(cfg);
      }
    } else if (choice === 2) {
      if (await confirmAlert("Remove all settings?", "Removes the server, the token, saved values and notifications from this iPhone.", "Remove")) {
        if (!sameConfig(cfg, loadConfig())) {
          await notice("Not removed", "The settings changed meanwhile. Nothing was removed.");
          continue;
        }
        // These settings only: settings saved meanwhile by another run stay (also on a retry); an item that can't be read isn't removed
        let keys = removeSettingsOf(cfg);
        // Removed before asking to retry the Keychain (closing the app at that question leaves no reminder that could still ring).
        // Settings saved meanwhile keep their files and notifications; what is left of these settings is never kept
        const removedTag = cacheTag(cfg, normalizeBaseUrl(cfg.url));
        const files = removeCache(null, removedTag);
        const notifications = await removeNotifications(null, configId(cfg));
        while (!keys && (await confirmAlert("Not fully removed", "Some settings couldn't be removed from the Keychain.", "Try again"))) keys = removeSettingsOf(cfg);
        if (!files || !notifications) {
          await notice("Partly removed", "Some saved data or notifications couldn't be removed. The data isn't used anymore, but a scheduled reminder may still ring once.");
        }
        return;
      }
    } else {
      return;
    }
  }
}

/**
 * "Reset saved data" (after the server's database is recreated, whose data numbers and event numbers start again): saves the same
 * server and token under a new settings generation first, so a run still in flight can't write its old numbers into the new state
 * (its files carry the old generation, and it stops when it sees the settings changed). Then removes saved views, seen numbers, the
 * events cursor, notification state, and Headroom's scheduled and delivered notifications
 */
async function resetSavedData(cfg) {
  // Settings saved meanwhile (another run of the app) are not overwritten with the ones this menu showed
  if (!sameConfig(cfg, loadConfig())) {
    await notice("Not reset", "The settings changed meanwhile. Nothing was reset.");
    return;
  }
  let next;
  try {
    next = saveConfig({ url: cfg.url, token: cfg.token }, cfg);
  } catch (e) {
    if (e?.message === "changed") await notice("Not reset", "The settings changed meanwhile. Nothing was reset.");
    else await notice("Can't reset", "Couldn't write to the Keychain. Nothing was changed.");
    return;
  }
  // Only what belongs to the generation it replaced: a newer one (made meanwhile by another run) keeps its files and notifications
  void next;
  const files = removeCache(null, cacheTag(cfg, normalizeBaseUrl(cfg.url)));
  const notifications = await removeNotifications(null, configId(cfg));
  if (!files || !notifications) await notice("Partly reset", "Some old saved data or notifications couldn't be removed. They aren't used anymore; they are removed on a later run.");
}

/** Enter the server URL and the read token, and save them as a pair. true if saved */
async function editSettings() {
  const read = readConfigState();
  if (!read.ok) {
    await notice("Can't read", "Couldn't read the settings from the Keychain. Nothing was changed.");
    return false;
  }
  const before = read.cfg;
  const form = new Alert();
  form.title = "Server and token";
  form.message = "Enter the server URL (https host only) and your read token. They're stored only in this iPhone's Keychain.";
  form.addTextField("https://headroom.example.workers.dev", "");
  form.addSecureTextField("Read token", "");
  form.addAction("Save");
  form.addCancelAction("Cancel");
  if ((await form.present()) !== 0) return false;
  const checked = validateSetup({ url: form.textFieldValue(0), token: form.textFieldValue(1) });
  if (checked.error) {
    await notice("Can't save", checked.error);
    return false;
  }
  // Settings saved meanwhile by another run are not overwritten (their reminders would be left behind); unreadable ones either
  const nowRead = readConfigState();
  if (!nowRead.ok) {
    await notice("Can't read", "Couldn't read the settings from the Keychain. Nothing was changed.");
    return false;
  }
  const now = nowRead.cfg;
  if (before ? !sameConfig(before, now) : now !== null) {
    await notice("Not saved", "The settings changed meanwhile. Open Server and token again.");
    return false;
  }
  try {
    // Replace in a single write (Access credentials saved by older versions don't remain either); the switches carry over
    saveConfig(checked, before);
  } catch (e) {
    // The old settings remain (nothing is deleted before the write)
    if (e?.message === "changed") await notice("Not saved", "The settings changed meanwhile. Open Server and token again.");
    else await notice("Can't save", "Couldn't write to the Keychain. The previous settings are kept.");
    return false;
  }
  // If the server changed, don't keep the old server's values. The replaced generation's reminders would ring for settings that are gone
  let files = true;
  if (!before) files = removeCache();
  else if (before.url !== checked.url) files = removeCache(null, cacheTag(before, normalizeBaseUrl(before.url)));
  const notifications = before ? await removeNotifications(null, configId(before)) : true;
  if (!files || !notifications) {
    await notice("Saved", "The new settings are saved, but some data or reminders of the previous ones couldn't be removed. They aren't used anymore.");
  }
  return true;
}

/**
 * Read the 7-day weekly trend (GET /v2/history; once per provider, for that provider's weekly limit). Credentials only in headers,
 * redirects not followed. Providers that couldn't be read are left out (the rest of the display continues without a trend). Not saved
 */
async function loadTrends(cfg, view, windows, now) {
  const spec = buildRequest(cfg, "UTC");
  const base = normalizeBaseUrl(cfg.url);
  const out = {};
  if (!spec || !base) return out;
  for (const [provider, windowId] of Object.entries(windows)) {
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
    const names = ownFiles(fm);
    if (names === null) return { error: "Couldn't read this iPhone's files" };
    const floor = seenFrom(names, tag);
    if (floor <= result.view.data_version) return result;
    const latest = loadCache(fm, tag, origin, names);
    if (latest) return { view: latest.view, fromCache: true };
    return withdrawnAt(fm, tag, floor) ? { view: emptyViewAt(floor), fromCache: true } : { error: "Response is older than the last one" };
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
        // One list of the saved files decides on the response: without it the newest saved version is unknown, so the response is
        // neither shown nor saved (it may be older)
        const names = ownFiles(fm);
        if (names === null) return { error: "Couldn't read this iPhone's files" };
        // A response older than the seen number or the saved previous view (arrived late, or read an earlier value) is neither shown nor saved.
        // Show the newer previous view if there is one (or the withdrawal the newest marker records)
        const floor = seenFrom(names, tag);
        const newer = loadCache(fm, tag, origin, names);
        if (newer && newer.view.data_version > view.data_version) return { view: newer.view, fromCache: true };
        if (view.data_version < floor) {
          return withdrawnAt(fm, tag, floor) ? { view: emptyViewAt(floor), fromCache: true } : { error: "Response is older than the last one" };
        }
        // Settings reset or changed while waiting: don't write this generation's files again
        if (!sameConfig(cfg, loadConfig())) return { error: "Settings changed. Updates on next refresh" };
        const received = saveCache(fm, tag, origin, view);
        // If another run saved a newer number after the comparison, show that one instead of this response (or the withdrawal its
        // marker records). Without the list, whether one came is unknown: nothing is shown
        const after = ownFiles(fm);
        if (after === null) return { error: "Couldn't read this iPhone's files" };
        const top = seenFrom(after, tag);
        if (top > view.data_version) {
          const latest = loadCache(fm, tag, origin, after);
          if (latest && latest.view.data_version >= top) return { view: latest.view, fromCache: true };
          return withdrawnAt(fm, tag, top) ? { view: emptyViewAt(top), fromCache: true } : { error: "Response is older than the last one" };
        }
        // Its seen marker couldn't be saved: not received, so shown only (nothing planned from it)
        return received ? { view, fetched: true } : { view, fetched: true, unreceived: true };
      }
    }
  } catch (_) {
    status = 0;
  }
  const fm = FileManager.local();
  const names = ownFiles(fm);
  if (names !== null) {
    const cached = loadCache(fm, tag, origin, names);
    if (cached) return { view: cached.view, cachedAt: cached.savedAt ?? "" };
    // The newest version seen here was a withdrawal whose body wasn't kept: nothing older is shown
    const floor = seenFrom(names, tag);
    if (floor > 0 && withdrawnAt(fm, tag, floor)) return { view: emptyViewAt(floor), cachedAt: "" };
  }
  return { error: errorText(status) };
}

/** Read events after a sequence number (GET /v2/events; one D1 row). Credentials only in headers, redirects not followed. null on failure */
async function loadEvents(cfg, after) {
  const spec = buildRequest(cfg, "UTC");
  const base = normalizeBaseUrl(cfg.url);
  if (!spec || !base || !Number.isSafeInteger(after) || after < 0) return null;
  try {
    const req = new Request(`${base}/v2/events?after=${after}`);
    req.headers = spec.headers;
    req.timeoutInterval = 15;
    req.onRedirect = () => null;
    const data = await req.load();
    if (req.response?.statusCode !== 200) return null;
    return sanitizeEvents(JSON.parse(data.toRawString()));
  } catch (_) {
    return null;
  }
}

/** Notification preferences (Keychain; both on unless turned off in the app menu) */
/** The notification switches, or null when the Keychain can't be read (not taken for the defaults) */
function loadNotifyPrefs(cfg) {
  try {
    const k = notifyKey(cfg);
    // A generation of this version always has its switches item: one missing was removed meanwhile (not taken for the defaults)
    if (cfg?.keyed && !Keychain.contains(k)) return null;
    return notifyPrefs(Keychain.contains(k) ? Keychain.get(k) : null);
  } catch (_) {
    return null;
  }
}

/** URL that runs this script (for tapping the widget or a notification). null if unavailable */
function scriptUrl() {
  try {
    return typeof URLScheme !== "undefined" ? URLScheme.forRunningScript() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Take the notifying run's lock: write our mark, then read it back. null if another run holds an unexpired lock. Scriptable has no
 * exclusive file creation, so two runs starting together may both pass (an alert may then ring twice; accepted)
 */
function takeLock(fm, path, now) {
  try {
    if (fm.fileExists(path) && !lockFree(fm.readString(path), now)) return null;
    const mine = `${Math.random().toString(16).slice(2, 12)} ${now.getTime() + LOCK_SECONDS * 1000}`;
    fm.writeString(path, mine);
    return fm.readString(path) === mine ? mine : null;
  } catch (_) {
    return null;
  }
}

/** Whether the lock is still this run's and unexpired */
function holdsLock(fm, path, mine, now) {
  try {
    return fm.fileExists(path) && fm.readString(path) === mine && !lockFree(mine, now);
  } catch (_) {
    return false;
  }
}

function releaseLock(fm, path, mine) {
  try {
    if (fm.fileExists(path) && fm.readString(path) === mine) fm.remove(path);
  } catch (_) { /* it expires on its own */ }
}

/**
 * Schedule one notification (at null or within 5 seconds: right away). Grouped per provider in Notification Center; tapping it opens
 * that provider's details
 */
async function scheduleNotification(id, title, body, at, now, provider, userInfo = null) {
  const n = new Notification();
  n.identifier = id;
  if (userInfo) n.userInfo = userInfo;
  n.title = title;
  n.body = body;
  n.threadIdentifier = `headroom.${provider ?? "all"}`;
  n.sound = "default";
  const url = detailUrl(scriptUrl(), provider);
  if (url) n.openURL = url;
  if (at !== null && at > now.getTime() + 5000) n.setTriggerDate(new Date(at));
  await n.schedule();
}

/** Identifiers of Headroom's pending notifications */
/** How long a run waits after taking the lock before it checks it again (two runs that found it free at once both wrote it) */
const LOCK_SETTLE_MS = 1500;

/** Wait (Scriptable's Timer; no wait where there is none, as in the tests) */
function pause(ms) {
  if (typeof Timer === "undefined" || typeof Timer.schedule !== "function") return Promise.resolve();
  // timeInterval is in milliseconds
  return new Promise((resolve) => Timer.schedule(ms, false, resolve));
}

/** Event numbers told by this generation's delivered notifications (each carries them in userInfo) */
function deliveredSeqs(list, gen) {
  const out = new Set();
  for (const n of list ?? []) {
    if (typeof n?.identifier !== "string" || !n.identifier.startsWith(`headroom.${gen}.events.`)) continue;
    for (const seq of Array.isArray(n.userInfo?.seqs) ? n.userInfo.seqs : []) if (Number.isSafeInteger(seq)) out.add(seq);
  }
  return out;
}

/** Headroom's delivered notifications ({ identifier, title, body, userInfo }), or null when the list can't be read */
async function deliveredNotifications() {
  try {
    return (await Notification.allDelivered()).filter((n) => typeof n?.identifier === "string" && n.identifier.startsWith("headroom."));
  } catch (_) {
    return null;
  }
}

/** Identifiers of Headroom's pending notifications, or null when the list can't be read */
async function pendingIds() {
  try {
    return (await Notification.allPending()).map((n) => n.identifier).filter((id) => typeof id === "string" && id.startsWith("headroom."));
  } catch (_) {
    return null;
  }
}

/**
 * The notifying run: schedule time reminders from the view and tell new events. view is null when none could be read (scheduled
 * reminders are then left as they are); fetched says it was read from the server just now (only then can it show an account switch).
 * Each change waits on this run still being current: the same settings generation and notification preferences, and the lock still
 * its own (a run back from a long wait after its lock expired stops). Every notification is saved right after it is scheduled
 * (reminders by identifier, events by number and the cycle they told), so a failure later in the run never makes one ring twice; the
 * events cursor moves only once every notification of the read went out. Returns a short summary (the shortcut's output)
 */
async function notifyRun(cfg, view, fetched = false, unreceived = null) {
  const origin = normalizeBaseUrl(cfg?.url);
  if (!origin) return "Check your settings";
  const gen = configId(cfg);
  const tag = cacheTag(cfg, origin);
  const fm = FileManager.local();
  const dir = fm.documentsDirectory();
  const lockPath = fm.joinPath(dir, `headroom-lock-${tag}`);
  const statePath = fm.joinPath(dir, `headroom-notify-${tag}.json`);
  const lock = takeLock(fm, lockPath, new Date());
  if (!lock) return "Another run is notifying";
  const prefs = loadNotifyPrefs(cfg);
  // Switches that can't be read are not taken for "on": nothing is scheduled, told or moved on this time
  if (prefs === null) {
    releaseLock(fm, lockPath, lock);
    return "Couldn't read the notification settings";
  }
  let prefsText = JSON.stringify(prefs);
  let lockNow = lock;
  const current = () => sameConfig(cfg, loadConfig()) && JSON.stringify(loadNotifyPrefs(cfg)) === prefsText && holdsLock(fm, lockPath, lockNow, new Date());
  // Thrown when this run is no longer current: nothing more is cancelled, scheduled or saved
  const stale = new Error("stale");
  const check = () => {
    if (!current()) throw stale;
  };
  const scheduled = [];
  // What this run last wrote to the state (another run that took the lock meanwhile writes something else)
  let lastWritten = null;
  // Stopped because the settings or the switches changed: what this run scheduled is taken back. Stopped because another run took the
  // lock over: it is left (that run plans the same reminders under the same identifiers, and removes those it doesn't plan)
  const undo = async () => {
    // Read once, and compared as read: settings or switches that can't be read now don't say they changed, so what this run scheduled
    // is left (the next run reconciles it)
    const savedNow = readConfigState();
    const prefsNow = savedNow.ok ? loadNotifyPrefs(cfg) : null;
    if (!savedNow.ok || prefsNow === null) return "Couldn't read the settings";
    const settings = !sameConfig(cfg, savedNow.cfg);
    const switches = JSON.stringify(prefsNow) !== prefsText;
    let keep = new Set();
    if (!settings) {
      if (!switches) return "Another run is notifying";
      // Same settings, other switches: only while this run holds the lock, or takes it again because it only expired (no run holds
      // it). What a run that held it meanwhile saved as its own stays
      if (!holdsLock(fm, lockPath, lockNow, new Date())) {
        const again = takeLock(fm, lockPath, new Date());
        if (!again) return "Another run is notifying";
        lockNow = again;
        const text = fm.fileExists(statePath) ? fm.readString(statePath) : "";
        if (text !== lastWritten) keep = new Set(readNotifyState(text).reminders.map((r) => r.id));
      }
    }
    try {
      const back = scheduled.filter((id) => !keep.has(id));
      if (back.length) await Notification.removePending(back);
    } catch (_) { /* the next run of the new settings removes this generation's reminders */ }
    return "Settings changed";
  };
  try {
    // Two runs that found the lock free at the same moment both wrote it: the later write stays, and the run that wrote first sees
    // that after this pause and stops before doing anything
    await pause(LOCK_SETTLE_MS);
    let now = new Date();
    check();
    // The events cursor lives in the file names: if they can't be listed, stop (reading it as "no cursor" would skip new events)
    const names = ownFiles(fm);
    if (names === null) return "Couldn't read this iPhone's files";
    const saved = readNotifyState(fm.fileExists(statePath) ? fm.readString(statePath) : "");
    // A newer view saved on this iPhone meanwhile (by a widget that only shows): used instead of the one this run read. Below the
    // device's floor (the newest version seen here, from the same list): a withdrawal there plans nothing; a newer view whose body can't
    // be read plans nothing either (held)
    const floorSeen = seenFrom(names, tag);
    const newest = loadCache(fm, tag, origin, names);
    if (newest && newest.view.data_version > (view?.data_version ?? -1)) view = newest.view;
    if (floorSeen > 0 && (view?.data_version ?? -1) < floorSeen) view = withdrawnAt(fm, tag, floorSeen) ? emptyViewAt(floorSeen) : null;
    // A newer version this run read but couldn't record (its seen marker couldn't be saved): nothing older is planned from (held)
    if (Number.isSafeInteger(unreceived) && (view?.data_version ?? -1) < unreceived) view = null;
    // A view older than the one the last run used (read before that run took the lock) changes no reminder and shows no switch
    const usable = view && !(Number.isSafeInteger(saved.view_version) && view.data_version < saved.view_version) ? view : null;
    // A provider whose account switched starts afresh (its reminders are cancelled, its cycles told before the switch forgotten)
    const fresh = forgetSwitched(saved, usable ? usable.boundaries ?? null : null, usable?.data_version ?? null);
    void fetched;
    const state = { ...fresh.state, reminders: withoutCancelled(fresh.state.reminders, prefs) };
    if (fresh.cancel.length) await Notification.removePending(fresh.cancel);
    let reminders = state.reminders;
    // When each provider's current account was accepted (server time): what was told before it was for another account
    const since = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, Date.parse(String(state.boundaries?.[p] ?? "").split("#")[0])]));
    const told = { limits: [...state.told.limits], warned: [...state.told.warned] };
    const sent = [...state.sent];
    let sending = state.sending;
    let checkedAt = state.checked_at;
    const cursor = eventsCursor(names, tag);
    // Numbers told are kept until the cursor passes them
    let floor = cursor ?? 0;
    const save = () => {
      check();
      const t = Date.now();
      const alive = (x) => (Number.isFinite(x.until) ? x.until : x.at + NOTIFY_KEEP_MS) > t;
      const text = JSON.stringify({ reminders, told: { limits: told.limits.filter(alive), warned: told.warned.filter(alive) },
        sent: sent.filter((n) => n > floor), sending, view_version: Math.max(usable?.data_version ?? 0, state.view_version ?? 0) || null,
        boundaries: state.boundaries, boundaries_version: state.boundaries_version, checked_at: checkedAt });
      fm.writeString(statePath, text);
      lastWritten = text;
    };
    if (fresh.switched.length > 0) save();
    // Reminders left by earlier settings. Checked again after the wait, so a run of older settings never removes a newer one's
    const pending = await pendingIds();
    check();
    const others = (pending ?? []).filter((id) => !id.startsWith(`headroom.${gen}.`));
    if (others.length) await Notification.removePending(others);
    // The cancelling owed: while time reminders are off, whatever of this generation still waits on the device (forgotten: it never
    // rang); and for each turning off still owed (also one carried over from settings this replaced), the reminders of its generation
    // scheduled before it. One is settled only once none of them waits on the device and none of this generation's is on its way to iOS
    const owed = [...prefs.cancels, ...(!prefs.times ? [{ op: null, gen, before: Number.POSITIVE_INFINITY }] : [])];
    if (pending !== null && (owed.length > 0 || prefs.cancel_pending)) {
      const target = (ob, id) => /^headroom\.[0-9a-f]{16}\.(back|runout)\./.test(id) && id.startsWith(`headroom.${ob.gen}.`)
        && (ob.gen !== gen || !reminders.some((r) => r.id === id && Number.isFinite(r.set_at) && r.set_at >= ob.before));
      const ids = [...new Set(owed.flatMap((ob) => pending.filter((id) => target(ob, id))))];
      if (ids.length) {
        reminders = reminders.map((x) => (ids.includes(x.id) ? { ...x, cancelling: true } : x));
        save();
        await Notification.removePending(ids);
        reminders = reminders.filter((r) => !ids.includes(r.id));
        save();
      }
      const left = await pendingIds();
      check();
      if (left !== null) {
        const onTheWay = (ob) => ob.gen === gen && reminders.some((r) => mayLand(r) && !(Number.isFinite(r.set_at) && r.set_at >= ob.before));
        const settledFor = (ob) => ob.gen === gen || Date.now() >= ob.before + LOCK_SECONDS * 1000;
        const done = owed.filter((ob) => !left.some((id) => target(ob, id)) && !onTheWay(ob) && settledFor(ob));
        const ops = new Set(done.map((ob) => ob.op).filter(Boolean));
        const settled = done.length === owed.length;
        if (ops.size > 0 || (prefs.cancel_pending && settled)) {
          try {
            // Only on the switches this run read (a change meanwhile keeps what it owes; the next run settles it)
            const stored = loadNotifyPrefs(cfg);
            if (stored && JSON.stringify(stored) === prefsText) {
              const cancels = stored.cancels.filter((c) => !ops.has(c.op));
              // "Cancel pending" stays while anything owed is left
              const cleared = { ...stored, cancels, cancel_pending: cancels.length > 0 || !settled };
              Keychain.set(notifyKey(cfg), JSON.stringify(cleared));
              prefsText = JSON.stringify(notifyPrefs(JSON.stringify(cleared)));
            }
          } catch (_) { /* settled next time */ }
        }
      }
    }
    // A reminder left as being cancelled (a run stopped after cancelling it) is settled by the device: delivered, it rang; neither
    // waiting nor delivered, the cancel went through (forgotten: it never rang, and planned again it is a new operation)
    if (pending !== null && reminders.some((x) => x.cancelling === true && !pending.includes(x.id))) {
      const shown = await deliveredNotifications();
      check();
      if (shown !== null) {
        // Delivered under its own account stamp (as the delivery carries it): it rang. Otherwise the cancel went through
        const stamps = new Map(shown.filter((n) => n.userInfo && "boundary" in n.userInfo).map((n) => [n.identifier, n.userInfo.boundary ?? null]));
        const rang = (x) => stamps.has(x.id) && stamps.get(x.id) === (x.boundary ?? null);
        reminders = reminders.flatMap((x) => (x.cancelling !== true || pending.includes(x.id) ? [x] : rang(x) ? [{ ...x, cancelling: false }] : []));
        save();
      }
    }
    if (usable) {
      // A provider the view withdrew (null): its reminders are cancelled also when due (one planned from an older view included)
      const withdrawn = new Set(PROVIDER_ORDER.filter((p) => usable[p] === null));
      const r = reconcileReminders(reminders, prefs.times ? reminderPlan(usable, now) : [], now, gen, pending === null ? null : new Set(pending), usable.data_version, withdrawn);
      check();
      // Also this generation's reminders on the device that the plan doesn't keep (left by a run that lost the lock)
      const kept = new Set(r.reminders.map((x) => x.id));
      const strays = (pending ?? []).filter((id) => /^headroom\.[0-9a-f]{16}\.(back|runout)\./.test(id) && id.startsWith(`headroom.${gen}.`) && !kept.has(id));
      const cancel = [...new Set([...r.cancel, ...strays])];
      if (cancel.length) {
        // Recorded first: a reminder being cancelled doesn't count as one that rang (also if this run stops right after asking iOS)
        reminders = reminders.map((x) => (cancel.includes(x.id) ? { ...x, cancelling: true } : x));
        save();
        await Notification.removePending(cancel);
      }
      // Until each new time is scheduled, the reminder keeps its previous entry (or none)
      const moving = new Set(r.schedule.map((x) => x.id));
      const prior = reminders;
      reminders = [...r.reminders.filter((x) => !moving.has(x.id)), ...prior.filter((x) => moving.has(x.id))];
      save();
      const fromHere = [];
      for (const item of r.schedule) {
        check();
        // A newer version reached this iPhone meanwhile (a withdrawal, or newer values): nothing more is scheduled from this view, and
        // what this run scheduled from it is taken back (the next run plans from the newer one)
        const listed = ownFiles(fm);
        if (listed === null || seenFrom(listed, tag) > usable.data_version) {
          try {
            if (fromHere.length) await Notification.removePending(fromHere);
            reminders = reminders.filter((x) => !fromHere.includes(x.id));
          } catch (_) { /* the next run cancels them: they aren't in its plan */ }
          save();
          break;
        }
        // Saved before it is scheduled: if saving after it fails, the next run still knows it (a reminder due now rings at once and
        // would ring again)
        // Saved as not confirmed yet: if this run stops before it is scheduled, a later run doesn't take it for one that rang (unless
        // the device shows it delivered)
        const before = reminders;
        reminders = [...reminders.filter((x) => x.id !== item.id), { ...r.reminders.find((x) => x.id === item.id), confirmed: false }];
        save();
        try {
          // The delivery carries the account stamp it was planned for (compared as it is, not by the identifier's hash)
          await scheduleNotification(item.id, item.title, item.body, item.fire_at, now, item.provider, { boundary: item.boundary ?? null });
        } catch (e) {
          reminders = before;
          save();
          throw e;
        }
        scheduled.push(item.id);
        fromHere.push(item.id);
        reminders = reminders.map((x) => (x.id === item.id ? { ...x, confirmed: true } : x));
        save();
      }
    }
    // This run's mark on its records
    const run = runMark();
    let toldCount = 0;
    let readFailed = false;
    let heldBelow = null;
    let next = cursor;
    if (prefs.events) {
      const events = await loadEvents(cfg, cursor ?? 0);
      // Notifications already on the device, by the event numbers they carry (told by a run whose state wasn't saved afterwards, or by
      // another run at the same time)
      const delivered = events ? await deliveredNotifications() : null;
      if (!events || delivered === null) {
        readFailed = true;
      } else {
        now = new Date();
        // Numbers below the oldest the server still holds can't be read again
        if (Number.isSafeInteger(events.oldest_seq)) floor = Math.max(floor, events.oldest_seq - 1);
        let covered = deliveredSeqs(delivered, gen);
        let deliveredIds = new Set(delivered.map((n) => n.identifier));
        const stampsOf = (list) => new Map(list.filter((n) => n.userInfo && "boundary" in n.userInfo).map((n) => [n.identifier, n.userInfo.boundary ?? null]));
        let deliveredStamps = stampsOf(delivered);
        const byNumber = new Map(events.events.map((e) => [e.seq, e]));
        const join = (name) => fm.joinPath(dir, name);
        // Numbers whose told record couldn't be written: the cursor stays before them (the next run writes it from the device's list)
        const unwritten = new Set();
        // Numbers this run handed to iOS: never chosen again in it
        const handed = new Set();
        // A number told (by this run, another, or one found on the device): its record, whose content follows from the event alone, so
        // every run writes the same and none takes it back; and the cycle it told, remembered
        const markTold = (seq, kept = null) => {
          if (sent.includes(seq)) return;
          // From the event; one no longer in the feed, from what its intent kept
          const mark = byNumber.has(seq) ? eventMark(byNumber.get(seq)) : kept;
          try {
            fm.writeString(join(recordName("told", tag, seq)), JSON.stringify({ mark }));
          } catch (_) {
            unwritten.add(seq);
            return;
          }
          sent.push(seq);
          if (mark) told[mark.list].push(mark);
        };
        let records = readRecords(fm, ownFiles(fm) ?? names, tag);
        if (records === null) {
          readFailed = true;
        } else {
          for (const [seq, mark] of records.told) {
            if (!sent.includes(seq)) sent.push(seq);
            if (mark) told[mark.list].push(mark);
          }
          // Intents left by runs (also version 64's, kept in the state): each number on the device was told; one not there whose run may
          // still be handing it to iOS is in flight (neither told again nor cancelled out yet); one whose run is gone is told again (its
          // delivery is unknown: a duplicate is allowed only then)
          const intents = [...records.intents, ...(sending ? [{ seqs: sending.seqs, at: 0, run: null }] : [])];
          // Each number's cycle as any intent kept it (whichever intent is read first)
          const keptMarks = new Map();
          for (const intent of intents) {
            for (const seq of intent.seqs) {
              const m = intent.marks?.get(seq) ?? null;
              if (m && !keptMarks.has(seq)) keptMarks.set(seq, m);
            }
          }
          const inFlight = new Set();
          for (const intent of intents) {
            const aborted = intent.run !== null && records.aborts.has(`${intent.seqs[0]}-${intent.run}`);
            for (const seq of intent.seqs) {
              if (sent.includes(seq) || aborted) continue;
              if (covered.has(seq)) markTold(seq, keptMarks.get(seq) ?? null);
              else if (intent.at > Date.now() - LOCK_SECONDS * 1000) inFlight.add(seq);
            }
          }
          if (sending) {
            sending = null;
            save();
          }
          // A stopped or resumed in flight holds every stopped and resumed of the read (told in their order, never cancelled across it).
          // Decided again on every choice: one that shows on the device meanwhile no longer holds the others
          const collection = (e) => e.kind === "collection_stopped" || e.kind === "collection_resumed";
          const holdCollection = () => [...inFlight].some((n) => byNumber.has(n) && collection(byNumber.get(n)));
          // The first read only marks where we are (what happened before isn't told)
          if (cursor !== null) {
            const pendingSet = pending === null ? null : new Set(pending);
            let stopped = false;
            for (;;) {
              now = new Date();
              const open = (e) => e.seq > cursor && !sent.includes(e.seq) && !inFlight.has(e.seq) && !handed.has(e.seq) && !(collection(e) && holdCollection());
              const unsent = events.events.filter(open);
              // Chosen over every event not passed yet (also those already on the device, so the cycles they told are remembered), and
              // again whenever the device shows more of them told
              const picked = selectAlerts(unsent, usable, now, { told, reminders, times: prefs.times, since, pending: pendingSet, delivered: covered, deliveredIds, deliveredStamps });
              heldBelow = picked.held.length ? Math.min(...picked.held) : null;
              // On the device already: told (with their cycles, also of one this choice wouldn't tell now)
              for (const e of unsent) if (covered.has(e.seq)) markTold(e.seq);
              const note = alertNotifications(picked.alerts.filter((a) => !covered.has(a.seq)))[0];
              check();
              // Checked against the device right before anything is settled (also with nothing to tell: a stopped and resumed that
              // cancel out, or the cursor moving on); more of them told, or a reminder delivered, means choosing again
              const now2 = await deliveredNotifications();
              check();
              if (now2 === null) {
                // Can't tell what is on the device now: nothing more is told, and the cursor stays (next time tells the rest)
                stopped = true;
                break;
              }
              const told2 = deliveredSeqs(now2, gen);
              // An intent's number that shows on the device only now (its event may have left the feed): told with the cycle the
              // intent kept, and everything chosen again
              let fromIntent = false;
              for (const intent of intents) {
                if (intent.run !== null && records.aborts.has(`${intent.seqs[0]}-${intent.run}`)) continue;
                for (const seq of intent.seqs) {
                  if (sent.includes(seq) || covered.has(seq) || !told2.has(seq)) continue;
                  markTold(seq, keptMarks.get(seq) ?? null);
                  inFlight.delete(seq);
                  fromIntent = true;
                }
              }
              const more = fromIntent || [...told2].some((n) => !covered.has(n) && unsent.some((e) => e.seq === n))
                || now2.some((n) => !deliveredIds.has(n.identifier) && /\.(back|runout)\./.test(n.identifier));
              covered = new Set([...covered, ...told2]);
              deliveredIds = new Set([...deliveredIds, ...now2.map((n) => n.identifier)]);
              deliveredStamps = new Map([...deliveredStamps, ...stampsOf(now2)]);
              if (more) {
                save();
                continue;
              }
              // A stopped and resumed that cancel out: the pair is recorded first, then the runs' intents read again. A live intent for
              // either (another run handing it to iOS) means it may be told: both then wait for a later run (told in their order once it
              // shows on the device, or cancelled out once that intent is gone)
              if (picked.cancelled.length > 0) {
                const [a, b] = picked.cancelled;
                try {
                  fm.writeString(join(recordName("pair", tag, a, b, run)), JSON.stringify({ at: Date.now() }));
                } catch (_) {
                  stopped = true;
                  break;
                }
                records = readRecords(fm, ownFiles(fm), tag);
                if (records === null) {
                  stopped = true;
                  break;
                }
                // One of them told by another run meanwhile: not cancelled out here. What it told is taken (with its cycle), this
                // run's pair taken back, and the rest chosen again (a resumed after a stopped told is told)
                if (records.told.has(a) || records.told.has(b)) {
                  for (const [n, m] of records.told) {
                    if (sent.includes(n)) continue;
                    sent.push(n);
                    if (m) told[m.list].push(m);
                  }
                  try {
                    fm.remove(join(recordName("pair", tag, a, b, run)));
                  } catch (_) { /* expires */ }
                  continue;
                }
                const live = (i) => i.at > Date.now() - LOCK_SECONDS * 1000;
                const sending = records.intents.some((i) => i.run !== run && live(i) && !records.aborts.has(`${i.seqs[0]}-${i.run}`)
                  && i.seqs.some((n) => n === a || n === b));
                if (sending) {
                  // Another run is handing one of them to iOS: both wait (told in their order once it shows, or cancelled once it's gone),
                  // and this run's pair is taken back (left, it expires with the lock)
                  inFlight.add(a);
                  inFlight.add(b);
                  try {
                    fm.remove(join(recordName("pair", tag, a, b, run)));
                  } catch (_) { /* expires */ }
                  continue;
                }
                // Neither is on its way: both are settled without a notification, by one record
                try {
                  fm.writeString(join(recordName("told", tag, a)), JSON.stringify({ mark: null, pair: b }));
                } catch (_) {
                  // Not settled: this run tells nothing more (the cursor stays before both; the next run decides them again)
                  stopped = true;
                  break;
                }
                sent.push(a, b);
                save();
                continue;
              }
              if (!note) break;
              const id = `headroom.${gen}.events.${note.alerts[0].seq}.${note.provider ?? "all"}`;
              const seqs = note.alerts.map((a) => a.seq);
              // The intent first (a run stopped after handing it to iOS is recognized next time), then the pairs read again: one recorded
              // by another run for these numbers means they are being cancelled out, so this one isn't handed over (aborted)
              try {
                fm.writeString(join(recordName("intent", tag, seqs[0], run)),
                  JSON.stringify({ seqs, marks: Object.fromEntries(seqs.map((n) => [n, eventMark(byNumber.get(n))])), at: Date.now() }));
              } catch (_) {
                stopped = true;
                break;
              }
              const listing = ownFiles(fm);
              records = readRecords(fm, listing, tag);
              if (records === null) {
                stopped = true;
                break;
              }
              const passedNow = eventsCursor(listing, tag);
              const settled = seqs.some((n) => records.told.has(n) || (passedNow !== null && n <= passedNow));
              if (settled || records.pairs.some((p) => p.run !== run && p.at > Date.now() - LOCK_SECONDS * 1000 && seqs.some((n) => n === p.a || n === p.b))) {
                try {
                  fm.writeString(join(recordName("abort", tag, seqs[0], run)), "");
                } catch (_) {
                  stopped = true;
                  break;
                }
                for (const n of seqs) inFlight.add(n);
                continue;
              }
              try {
                await scheduleNotification(id, note.title, note.body, null, now, note.provider, { seqs });
              } catch (e) {
                // iOS refused it (not handed over): the intent is dropped, so the next run tells it without waiting
                try {
                  fm.writeString(join(recordName("abort", tag, seqs[0], run)), "");
                } catch (_) { /* told again once its run is gone */ }
                throw e;
              }
              scheduled.push(id);
              for (const n of seqs) {
                handed.add(n);
                markTold(n);
              }
              save();
              toldCount += note.alerts.length;
            }
            if (stopped) readFailed = true;
          }
          if (!readFailed) {
            // The cursor stays before a held event, one in flight, and one whose told record couldn't be written (what was told after it
            // stays remembered above the cursor)
            const waitBefore = [heldBelow, ...inFlight, ...unwritten].filter((n) => n !== null && n > (cursor ?? 0));
            next = waitBefore.length ? Math.max(cursor ?? 0, Math.min(...waitBefore) - 1) : events.last_seq;
            checkedAt = new Date().toISOString();
          }
        }
      }
    } else {
      // Off: forget the cursor, so turning it on again starts from then (old events are not told)
      next = null;
      if (view) checkedAt = new Date().toISOString();
    }
    check();
    // The told records and the state first, then the cursor (a failure in between tells nothing twice: the records say what was told)
    save();
    if (next !== null && next !== cursor) fm.writeString(fm.joinPath(dir, eventsFileName(tag, next)), "");
    if (next !== null) floor = Math.max(floor, next);
    save();
    // Files and delivered notifications of other settings (left by a reset or a server change that couldn't remove them)
    removeCache(tag);
    await removeNotifications(gen, null, { pending: false });
    // Older markers (and all of them when alerts are off), and records the cursor has passed (a told record with a cycle stays until the
    // cycle no longer matters: a later state saved by a slower run can't take it back)
    const names2 = ownFiles(fm) ?? names;
    for (const name of names2) {
      const seq = eventsCursor([name], tag);
      const passed = (n) => next === null || n <= next;
      let drop = seq !== null && (next === null || seq < next);
      const rec = parseRecord(name, tag);
      if (rec && rec.kind === "told" && passed(rec.seq)) {
        // One that can't be read now is kept (its cycle may still matter); a corrupt one holds nothing and goes
        const read = readRecordFile(fm, name);
        const mark = read.body?.mark;
        drop = read.ok && (!mark || !(mark.until > Date.now())) && (!Number.isSafeInteger(read.body?.pair) || passed(read.body.pair));
      }
      // An intent, pair or abort once the cursor has passed its numbers (it passes only what was settled); an intent by all of its numbers
      // (from its content; one that can't be read now is kept)
      if (rec && rec.kind !== "told") {
        let seqs = rec.seqs;
        if (rec.kind === "intent") {
          const read = readRecordFile(fm, name);
          if (!read.ok) seqs = [Number.POSITIVE_INFINITY];
          else if (Array.isArray(read.body?.seqs) && read.body.seqs.every(Number.isSafeInteger)) seqs = read.body.seqs;
        }
        if (seqs.every(passed)) drop = true;
      }
      if (drop) {
        try {
          fm.remove(fm.joinPath(dir, name));
        } catch (_) { /* removed next time */ }
      }
    }
    const waiting = reminders.filter((r) => r.fire_at > Date.now()).length;
    const alertsText = readFailed ? "Couldn't check alerts" : toldCount === 0 ? "No new alerts" : toldCount === 1 ? "1 alert" : `${toldCount} alerts`;
    return `${alertsText} · ${waiting === 1 ? "1 reminder" : `${waiting} reminders`} scheduled`;
  } catch (e) {
    if (e === stale) return await undo();
    return "Couldn't notify";
  } finally {
    releaseLock(fm, lockPath, lockNow);
  }
}

/**
 * Details screen (in the app): reads the view, the recent events and the weekly series (8 D1 rows: view 3, events 1, two series 2 each)
 * and shows them as a page. provider shows only that provider
 */
async function showDetails(cfg, provider) {
  if (!cfg) return;
  let result = await loadView(cfg);
  const changed = () => !sameConfig(cfg, loadConfig());
  if (changed()) result = { error: "Settings changed" };
  const view = result.view ?? null;
  const events = view ? await loadEvents(cfg, 0) : null;
  const windows = {};
  for (const p of provider ? [provider] : PROVIDER_ORDER) if (view?.[p]?.windows?.[TREND_WINDOW]) windows[p] = TREND_WINDOW;
  let trends = view && result.fetched ? await loadTrends(cfg, view, windows, new Date()) : {};
  // Settings changed while reading: show none of the old settings' values. A newer view saved meanwhile: show it (without the series)
  let shown = view;
  if (changed()) {
    result = { error: "Settings changed" };
    shown = null;
  } else if (result.fetched) {
    const newest = newestView(cfg, { ...result, trends });
    if (newest.view !== view) {
      shown = newest.view ?? null;
      trends = {};
    }
  }
  const now = new Date();
  const note = result.error ?? (result.cachedAt !== undefined ? cachedNote(result.cachedAt, now) : "");
  const web = new WebView();
  await web.loadHTML(detailHtml({ view: shown, events: shown ? events?.events ?? null : null, trends, now, provider, note }));
  // Settings changed while the page loaded: show none of the old settings' values
  if (changed()) await web.loadHTML(detailHtml({ view: null, events: null, trends: {}, now, provider, note: "Settings changed" }));
  await web.present();
}


/**
 * Remove Headroom's pending and delivered notifications (when settings or saved data are removed), except a generation's that replaced
 * them (keepGen). false if listing or removing failed (nothing is known to be left; the caller tells the user)
 */
async function removeNotifications(keepGen = null, dropGen = null, { pending = true, delivered = true } = {}) {
  // Also the generation saved meanwhile (read again after each list comes back), unless it is the one being removed. Settings that
  // can't be read: nothing is removed
  const kept = () => {
    const saved = readConfigState();
    if (!saved.ok) return null;
    return [keepGen, saved.cfg ? configId(saved.cfg) : null].filter((g) => g && g !== dropGen);
  };
  const ours = (ids) => {
    const keep = kept();
    if (keep === null) return null;
    return ids.filter((id) => typeof id === "string" && id.startsWith("headroom.") && !keep.some((g) => id.startsWith(`headroom.${g}.`)));
  };
  let ok = true;
  if (pending) {
    try {
      const ids = ours((await Notification.allPending()).map((n) => n.identifier));
      if (ids === null) ok = false;
      else if (ids.length) await Notification.removePending(ids);
    } catch (_) {
      ok = false;
    }
  }
  if (delivered) {
    try {
      const ids = ours((await Notification.allDelivered()).map((n) => n.identifier));
      if (ids === null) ok = false;
      else if (ids.length) await Notification.removeDelivered(ids);
    } catch (_) {
      ok = false;
    }
  }
  return ok;
}


/**
 * Send the sample notifications of Claude, Codex or both right away (made-up values; nothing is read or saved). Their identifiers
 * are separate from the real ones, so they never replace or block a real notification
 */
async function sendSamples(cfg) {
  const pick = new Alert();
  pick.title = "Sample notifications";
  pick.message = "Each kind of notification, with made-up values. They arrive right away.";
  const choices = [...PROVIDER_ORDER.map((p) => [PROVIDER_NAMES[p], [p]]), ["All", [...PROVIDER_ORDER]]];
  for (const [label] of choices) pick.addAction(label);
  pick.addCancelAction("Cancel");
  const index = await pick.presentSheet();
  if (index < 0 || index >= choices.length) return;
  const now = new Date();
  const samples = sampleNotifications(choices[index][1], now);
  try {
    for (const [i, n] of samples.entries()) {
      await scheduleNotification(`headroom.${configId(cfg)}.sample.${i}`, n.title, n.body, null, now, n.provider);
    }
  } catch (_) { /* no permission */ }
}

/**
 * Make a change of the notification switches take effect now, not on the next notifying run: turning time reminders off cancels the
 * pending ones on the device; switching limit alerts either way forgets where they left off, so they start from then (events while off
 * are not told late). A run in flight sees the change counter moved and stops
 */
async function applyPrefs(cfg, before, after) {
  const origin = normalizeBaseUrl(cfg?.url);
  if (!origin) return { ok: true, cancelled: [], confirmed: true };
  const tag = cacheTag(cfg, origin);
  const fm = FileManager.local();
  const dir = fm.documentsDirectory();
  let ok = true;
  let confirmed = true;
  const cancelled = [];
  if (before.times && !after.times) {
    confirmed = false;
    // Every reminder still waiting on the device (also one about to ring), one at a time, so those removed are known. One delivered
    // meanwhile rang: it isn't counted. The state file is left to the next notifying run, which forgets those removed (one that rang
    // stays remembered, so an event doesn't repeat it)
    const gen = configId(cfg);
    const pending = await pendingIds();
    if (pending === null) {
      ok = false;
    } else {
      let ids = pending.filter((id) => /^headroom\.[0-9a-f]{16}\.(back|runout)\./.test(id) && id.startsWith(`headroom.${gen}.`));
      // Marked as being cancelled first (a run after a stop here doesn't take one removed for one that rang). If that can't be saved,
      // nothing is removed: the next notifying run cancels them (marking them itself)
      const statePath = fm.joinPath(dir, `headroom-notify-${tag}.json`);
      try {
        if (ids.length > 0 && fm.fileExists(statePath)) {
          const st = readNotifyState(fm.readString(statePath));
          if (st.reminders.some((r) => ids.includes(r.id))) {
            fm.writeString(statePath, JSON.stringify({ ...st, reminders: st.reminders.map((r) => (ids.includes(r.id) ? { ...r, cancelling: true } : r)) }));
          }
        }
      } catch (_) {
        ids = [];
        ok = false;
      }
      for (const id of ids) {
        try {
          await Notification.removePending([id]);
          cancelled.push({ id, at: Date.now() });
        } catch (_) {
          ok = false;
        }
      }
      // One delivered meanwhile rang. When that can't be read, all count as cancelled (a reset may then be told besides a reminder
      // that rang in that moment, never missed)
      const delivered = await deliveredNotifications();
      if (delivered !== null) {
        const rang = new Set(delivered.map((n) => n.identifier));
        for (let i = cancelled.length - 1; i >= 0; i--) if (rang.has(cancelled[i].id)) cancelled.splice(i, 1);
      }
      // Confirmed only when the device shows none of them left, and none is on its way to iOS (saved by a run as about to be
      // scheduled, never known scheduled: it may still land; a notifying run cancels it once it can tell)
      const after = await pendingIds();
      let onTheWay = true;
      try {
        const path = fm.joinPath(dir, `headroom-notify-${tag}.json`);
        onTheWay = fm.fileExists(path) && readNotifyState(fm.readString(path)).reminders.some((r) => mayLand(r) && String(r.id).startsWith(`headroom.${gen}.`));
      } catch (_) { /* can't tell: not confirmed */ }
      confirmed = ok && !onTheWay && after !== null && !after.some((id) => /^headroom\.[0-9a-f]{16}\.(back|runout)\./.test(id) && id.startsWith(`headroom.${gen}.`));
    }
  }
  if (before.events !== after.events) {
    const names = ownFiles(fm);
    if (names === null) ok = false;
    for (const name of names ?? []) {
      if (eventsCursor([name], tag) === null) continue;
      try {
        fm.remove(fm.joinPath(dir, name));
      } catch (_) {
        ok = false;
      }
    }
  }
  return { ok, cancelled, confirmed };
}

/**
 * "Notifications": send the sample notifications (the first time, iOS asks to allow them), and turn each kind on or off. Resetting
 * the notification state is under Settings
 */
async function notificationMenu() {
  for (;;) {
    const cfg = loadConfig();
    const prefs = loadNotifyPrefs(cfg);
    if (prefs === null) {
      await notice("Can't read", "Couldn't read the notification settings from the Keychain. Try again later.");
      return;
    }
    let checked = null;
    try {
      const origin = normalizeBaseUrl(cfg?.url);
      const fm = FileManager.local();
      const path = origin ? fm.joinPath(fm.documentsDirectory(), `headroom-notify-${cacheTag(cfg, origin)}.json`) : null;
      if (path && fm.fileExists(path)) checked = Date.parse(readNotifyState(fm.readString(path)).checked_at ?? "");
    } catch (_) { /* never checked */ }
    const menu = new Alert();
    menu.title = "Notifications";
    menu.message = [
      "Sent by the one widget whose parameter includes \"notify\" (for example: claude, notify), or a shortcut running this script with \"notify\".",
      Number.isFinite(checked) ? `Last check: ${formatDuration((Date.now() - checked) / 60000)} ago.` : "Not checked yet.",
    ].join("\n\n");
    menu.addAction("Send sample notifications");
    menu.addAction(`Limit alerts: ${prefs.events ? "On" : "Off"}`);
    menu.addAction(`Time reminders: ${prefs.times ? "On" : prefs.cancel_pending ? "Off · cancel pending" : "Off"}`);
    menu.addCancelAction("Back");
    const choice = await menu.presentSheet();
    if (choice === 0) {
      await sendSamples(cfg);
    } else if (choice === 1 || choice === 2) {
      // Changed meanwhile by another run (new settings, or the switches): the menu is shown again with what is saved now
      if (!sameConfig(cfg, loadConfig()) || JSON.stringify(loadNotifyPrefs(cfg)) !== JSON.stringify(prefs)) {
        await notice("Changed meanwhile", "The settings changed in another run. Here they are again.");
        continue;
      }
      const changedPrefs = choice === 1 ? { ...prefs, events: !prefs.events } : { ...prefs, times: !prefs.times };
      const turnedOff = choice === 2 && prefs.times;
      // Cancelled reminders are kept 8 days, added up over turning off and on again (until a notifying run has seen them)
      const recent = prefs.cancelled.filter((c) => c.at > Date.now() - NOTIFY_KEEP_MS);
      // Off is saved as "cancel pending" in the same write: if this stops before the reminders are confirmed cancelled, the menu says so
      // and the next notifying run cancels them
      const op = runMark();
      const gen = configId(cfg);
      const cancels = turnedOff ? [...prefs.cancels, { op, gen, before: Date.now() }] : prefs.cancels;
      const nextPrefs = { ...changedPrefs, rev: prefs.rev + 1, times_off_at: turnedOff ? Date.now() : prefs.times_off_at, cancelled: recent,
        cancels, cancel_pending: cancels.length > 0 || (!changedPrefs.times && prefs.cancel_pending && !turnedOff) };
      // Made while holding the notifying runs' lock: no run reads the switches between the change and the record of what it cancelled
      const origin = normalizeBaseUrl(cfg?.url);
      const fm = FileManager.local();
      const lockPath = origin ? fm.joinPath(fm.documentsDirectory(), `headroom-lock-${cacheTag(cfg, origin)}`) : null;
      let lock = lockPath ? takeLock(fm, lockPath, new Date()) : "none";
      for (let i = 0; !lock && i < 10; i++) {
        await pause(1000);
        lock = takeLock(fm, lockPath, new Date());
      }
      if (!lock) {
        await notice("Busy", "A notifying run is in progress. Try again in a moment.");
        continue;
      }
      // Changed while this waited for the lock (another menu or new settings): shown again
      if (!sameConfig(cfg, loadConfig()) || JSON.stringify(loadNotifyPrefs(cfg)) !== JSON.stringify(prefs)) {
        if (lockPath) releaseLock(fm, lockPath, lock);
        await notice("Changed meanwhile", "The settings changed in another run. Here they are again.");
        continue;
      }
      // What turning off cancels is decided now, holding the lock: a reminder a notifying run scheduled while this waited is among it
      if (turnedOff) {
        const at = Date.now();
        nextPrefs.cancels = [...prefs.cancels, { op, gen, before: at }];
        nextPrefs.times_off_at = at;
      }
      try {
        try {
          Keychain.set(notifyKey(cfg), JSON.stringify(nextPrefs));
        } catch (_) {
          await notice("Can't change", "Couldn't write to the Keychain.");
          continue;
        }
        const applied = await applyPrefs(cfg, prefs, nextPrefs);
        // The reminders it removed (so a notifying run doesn't take them for reminders that rang): dropped from the state right away
        // (no run is in it while this holds the lock), and kept with the switches too (if writing the state fails)
        if (applied.cancelled.length > 0) {
          const still = () => !lockPath || holdsLock(fm, lockPath, lock, new Date());
          let kept = false;
          if (still() && origin) {
            try {
              const path = fm.joinPath(fm.documentsDirectory(), `headroom-notify-${cacheTag(cfg, origin)}.json`);
              if (fm.fileExists(path)) {
                const st = readNotifyState(fm.readString(path));
                const gone = new Set(applied.cancelled.map((c) => c.id));
                fm.writeString(path, JSON.stringify({ ...st, reminders: st.reminders.filter((r) => !gone.has(r.id)) }));
              }
              kept = true;
            } catch (_) { /* the switches keep them below */ }
          }
          try {
            if (still() && JSON.stringify(loadNotifyPrefs(cfg)) === JSON.stringify(notifyPrefs(JSON.stringify(nextPrefs)))) {
              Keychain.set(notifyKey(cfg), JSON.stringify({ ...nextPrefs, cancelled: [...recent, ...applied.cancelled].slice(-100) }));
              kept = true;
            }
          } catch (_) { /* kept in the state above, if that worked */ }
          if (!kept) applied.ok = false;
        }
        // Confirmed that none is left: no longer pending. Otherwise it stays pending, and the next notifying run cancels (also without a view)
        if (turnedOff && applied.confirmed) {
          try {
            const now = loadNotifyPrefs(cfg);
            if (now && now.rev === nextPrefs.rev) {
              const cancels = now.cancels.filter((c) => c.op !== op);
              Keychain.set(notifyKey(cfg), JSON.stringify({ ...now, cancels, cancel_pending: cancels.length > 0 }));
            }
          } catch (_) { /* stays pending until a notifying run confirms it */ }
        }
        if (!applied.ok) {
        await notice("Partly changed", choice === 2
          ? "Time reminders are off, but cancelling the scheduled ones couldn't be confirmed (shown as cancel pending). The next notifying run cancels them."
          : "Limit alerts are changed, but where they left off couldn't be cleared. Turn them off and on again to retry.");
        }
      } finally {
        if (lockPath) releaseLock(fm, lockPath, lock);
      }
    } else {
      return;
    }
  }
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
    const symbol = SFSymbol.named(FALLBACK_MARKS[provider]?.symbol ?? "circle");
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
const FRESH_COLORS = { fresh: "#34C759", stale: "#8E8E93", old: "#8E8E93", unknown: "#8E8E93", limit: "#FF3B30" };

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
const SHORT_ERROR_NAMES = { login_required: "Sign in", not_installed: "Not installed", fetch_failed: "Fetch failed", safety_stop: "Paused", account_changed: "Paused", access_denied: "Denied" };
const LOCK_WINDOW_NAMES = { "5h": "five_hour", "5": "five_hour", five_hour: "five_hour", weekly: "seven_day", week: "seven_day", wk: "seven_day", seven_day: "seven_day" };
function lockPicks(view, parameter, now, max = 2) {
  const param = String(parameter ?? "").trim().toLowerCase();
  let selectors;
  if (/^both\b/.test(param)) {
    const rest = param.replace(/^both\s*/, "");
    selectors = DEFAULT_PROVIDERS.map((p) => `${p} ${rest}`);
  } else {
    selectors = param.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
    if (selectors.length === 0) selectors = [""];
  }
  const out = [];
  for (const selector of selectors.slice(0, max)) {
    let provider = null;
    let windowId = null;
    if (selector.includes(".")) {
      // Older form (claude.five_hour). The window id is used as is
      const [p, id] = selector.split(".");
      provider = PROVIDER_ORDER.includes(p) ? p : null;
      windowId = id || null;
    } else {
      const words = selector.split(/\s+/).filter(Boolean);
      provider = words.find((w) => PROVIDER_ORDER.includes(w)) ?? null;
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
        // A limit shown in the details only is taken only when named
        if (!w || (w.detail_only && !windowId)) continue;
        const shown = lockWindow(view, p, w, now);
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
    // A provider named without any value: not supported yet, or no data
    const none = withError || withMain ? null : provider && !view?.[provider] ? missingText(provider) : "No data";
    const label = withError ? ERROR_NAMES[code] ?? "No data" : withMain ? `5h: ${NOT_AVAILABLE}` : none;
    const short = withError ? SHORT_ERROR_NAMES[code] ?? "No data" : withMain ? `5h ${NOT_AVAILABLE}` : none;
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
    ctx.drawTextInRect(FALLBACK_MARKS[provider]?.letter ?? "?", new Rect(c - geom.icon / 2, iconTop, geom.icon, geom.icon));
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
    const mark = w ? [cached ? WARN_MARK : "", shortMark(w, true)].filter(Boolean).join(" ") : "";
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

/** Lock screen time row (same as home: ⚠ and the run-out time if it will run out, otherwise ↻ and the reset time; ⚠ Limit and ↻ Reset once passed) */
function addLockTime(stack, w, now, size, outs = null) {
  const time = timeShort(w, now);
  if (!time) return;
  if (time.warn && outs) {
    const p = projectionOf(w, now);
    if (p?.at) outs.push(p.at);
  }
  // A countdown keeps counting up after zero, so the widget asks to be redrawn then (the row then shows the reset as passed)
  if (time.kind === "timer" && outs) outs.push(time.date.getTime());
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
  // The name is never shortened: it gets a box as wide as its text. The plan, then "Demo", are left out when the row is too narrow
  const nameBox = names.addStack();
  nameBox.size = new Size(Math.ceil(textWidth(group.name, s.name, true)) + 2, 0);
  const name = nameBox.addText(group.name);
  name.font = Font.semiboldSystemFont(s.name);
  name.textColor = new Color(BRAND_COLORS[group.provider]);
  name.lineLimit = 1;
  const f = opts.content.freshness ? group.freshness : null;
  const extras = [group.plan && opts.content.plan ? group.plan : null, opts.demo ? "Demo" : null].filter(Boolean);
  // The staleness text beside the dot. A demo keeps its mark longer than this text (the dot stays): a narrow column of three still says Demo
  let freshText = f?.text ?? "";
  if (opts.width) {
    const fixed = () => (icon ? s.icon + 5 : 0) + textWidth(group.name, s.name, true) + 2 + (f ? 6 + (freshText ? textWidth(freshText, s.headerSmall) + 3 : 0) : 0) + 4;
    const over = () => fixed() + extras.reduce((sum, t) => sum + 5 + textWidth(t, s.headerSmall), 0) > opts.width;
    while (extras.length > 0 && over()) {
      if (extras.length === 1 && extras[0] === "Demo" && freshText) freshText = "";
      else extras.shift();
    }
    // Still too wide (a narrow column of three): the staleness text loses its last part ("1h 30m" → "1h"), then goes
    while (freshText && over()) {
      const parts = freshText.split(" ");
      freshText = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
    }
  }
  for (const text of extras) {
    names.addSpacer(5);
    addSmallText(names, text, s.headerSmall, SUB());
  }
  row.addSpacer(null);
  if (f) {
    if (freshText) {
      addSmallText(row, freshText, s.headerSmall, SUB());
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
  const value = missing ? "—" : percentText(w);
  const reset = !missing && c.reset ? timeShort(w, opts.now) : null;
  // Sizes without a time row put the time row's symbol before the value: ⚠ if it will run out or its run-out time has passed, ↻ if reset
  const lead = missing || c.forecastTime ? "" : runsOut || runOutPassed(w, opts.now) ? WARN_MARK : w.reset_passed && !c.reset ? RESET_MARK : "";
  const parts = [];
  if (!missing && c.marks && rowMark(w) && !w.reset_passed) parts.push(rowMark(w));
  // The rate goes at the right end of the time row
  const pace = !missing && c.pace && paceText(w) && opts.width >= 140 ? paceText(w) : "";
  return {
    missing, w,
    label: missing ? "5h limit" : limitLabel(w),
    showPct: true,
    pct: lead ? `${lead} ${value}` : value,
    sub: c.reset || c.marks || c.pace || c.forecastTime,
    reset,
    partsText: parts.length > 0 ? `${reset ? " · " : ""}${parts.join(" · ")}` : "",
    pace,
    // Run-out time of the drawn warning (decides when to redraw)
    outAt: runsOut ? projection.at : null,
    // When the drawn countdown reaches zero (a countdown keeps counting up after it, so the widget asks to be redrawn then)
    timerAt: reset?.kind === "timer" ? reset.date.getTime() : null,
    // When the gray part of a limit at 100% goes away (the widget asks to be redrawn then)
    grayEndsAt: missing ? null : recentSettledAt(w),
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
  if (p.timerAt !== null && opts.outs) opts.outs.push(p.timerAt);
  if (p.grayEndsAt !== null && p.grayEndsAt > opts.now.getTime() && opts.outs) opts.outs.push(p.grayEndsAt);
  const line = stack.addStack();
  line.layoutHorizontally();
  line.bottomAlignContent();
  line.size = new Size(opts.width, lineHeight(s));
  // Don't shrink text (its size is already aligned across all columns). A label too long even at the smallest size (a long per-model
  // name in a column of three) is cut in a box that leaves the remaining value its room
  const room = Math.floor(opts.width - (p.showPct ? 8 + textWidth(p.pct, s.pct, !p.missing) : 0));
  let holder = line;
  if (textWidth(p.label, fit.label) > room) {
    holder = line.addStack();
    holder.size = new Size(Math.max(0, room), 0);
  }
  const label = holder.addText(p.label);
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
const TREND_MAX_HEIGHT = 320;

/** Length of the weekly limit's cycle */
const WEEK_MS = 7 * 24 * 60 * 60000;

/**
 * Reset times of a weekly limit inside the chart's week (ms, ascending): the end of the cycle containing now, and the cycle before and
 * after it (the weekly cycle is 7 days, so the previous reset is the start of the current cycle). A reset time that has passed is moved on
 * by whole weeks, as the even pace does (cycleEnd), so both mark the same cycle. None if the reset time is unknown
 */
function resetTimes(window, range, now = null) {
  const reset = cycleEnd(window, now);
  if (reset === null) return [];
  return [-1, 0, 1].map((k) => reset + k * WEEK_MS).filter((t) => t >= range.start && t < range.end);
}

/** End of the weekly cycle containing now (ms; the reset time moved on by whole weeks if it has passed). now null: the reset time as is */
function cycleEnd(window, now) {
  let reset = Date.parse(window?.resets_at ?? "");
  if (!Number.isFinite(reset)) return null;
  if (now && reset <= now.getTime()) reset += Math.ceil((now.getTime() - reset + 1) / WEEK_MS) * WEEK_MS;
  return reset;
}

/** The part of the segment a-b ([time ms, used %] each, a before b) inside the range, interpolated at the edges. null if none */
function clipSegment(a, b, range) {
  const t0 = Math.max(a[0], range.start);
  const t1 = Math.min(b[0], range.end);
  if (!(t1 > t0)) return null;
  const at = (t) => a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
  return [[t0, at(t0)], [t1, at(t1)]];
}

/**
 * Even pace of the weekly limit's current cycle (the one containing now): a straight line from 0% at the cycle start to 100% at its reset,
 * clipped to the chart's week ([[t, used], [t, used]]). Usage above the line is ahead of an even pace. A reset that has passed since the
 * fetch starts the next cycle. null if the reset time is unknown or the cycle is outside the week
 */
function paceGuide(window, range, now) {
  const reset = cycleEnd(window, now);
  if (reset === null) return null;
  return clipSegment([reset - WEEK_MS, 0], [reset, 100], range);
}

/**
 * Forecast continuation of the weekly limit, with the same rate and conditions as the bar's forecast (projectionOf): from the latest value
 * to the run-out time if it comes before the reset (runsOut, ending at 100%), otherwise to the reset. { segment (clipped to the range),
 * runsOut }; null when the bar draws no forecast or the rate is too small to measure
 */
function forecastSegment(window, range, now) {
  const p = window ? projectionOf(window, now) : null;
  const pace = window ? paceOf(window) : null;
  if (!p || pace === null) return null;
  const fetched = Date.parse(window.fetched_at ?? "");
  const from = Number.isFinite(fetched) ? fetched : now.getTime();
  const end = p.runsOut ? p.at : Date.parse(window.resets_at);
  const used = p.runsOut ? 100 : Math.min(100, window.used_percent + (pace * (end - from)) / 3600000);
  const segment = clipSegment([from, window.used_percent], [end, used], range);
  return segment ? { segment, runsOut: p.runsOut && segment[1][0] === end } : null;
}

/** Dashed straight line from one point to another (pixels; DrawContext has no dash pattern, so short segments) */
function dashedSegment(ctx, from, to, hex, alpha, width, dash = 3, gap = 3) {
  const [x0, y0] = from;
  const [x1, y1] = to;
  const length = Math.hypot(x1 - x0, y1 - y0);
  if (!(length > 0)) return;
  const point = (d) => new Point(x0 + ((x1 - x0) * d) / length, y0 + ((y1 - y0) * d) / length);
  const path = new Path();
  for (let d = 0; d < length; d += dash + gap) {
    path.move(point(d));
    path.addLine(point(Math.min(length, d + dash)));
  }
  ctx.addPath(path);
  ctx.setStrokeColor(new Color(hex, alpha));
  ctx.setLineWidth(width);
  ctx.strokePath();
}

/** Dashed vertical line at x in a provider's color (a reset time in the large chart) */
function dashedLine(ctx, x, height, hex) {
  dashedSegment(ctx, [x, 0], [x, height], hex, 0.8, 1);
}

/**
 * Overlaid trend image (large). Draws one line per provider (lightly filled below) in a single 0-100% frame, a faint line at 50%,
 * and a dot at each current position. marks (all in pixels, each with the provider's hex):
 * - days: x of the faint lines between days
 * - resets: { x } each provider's weekly reset times, dashed vertical lines
 * - guides: { from, to } even pace of the current cycle, a thin faint line under the usage
 * - forecasts: { from, to, runsOut } the forecast continuation, dotted, ending in a ring where it runs out before the reset
 */
function combinedTrendImage(series, width, height, inset = TREND_INSET, marks = {}) {
  const { days: dayLines = [], resets: resetLines = [], guides = [], forecasts = [] } = marks;
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
  // Reset times and even pace (under the usage lines)
  for (const { x, hex } of resetLines) dashedLine(ctx, x, height, hex);
  for (const { from, to, hex } of guides) {
    const guide = new Path();
    guide.move(new Point(from[0], from[1]));
    guide.addLine(new Point(to[0], to[1]));
    ctx.addPath(guide);
    ctx.setStrokeColor(new Color(hex, 0.45));
    ctx.setLineWidth(1);
    ctx.strokePath();
  }
  // Guide lines are drawn with the same coordinate calculation as the values. The scale is always 0-100%: its ends (0%, 100%) and
  // 50% are stronger, 25% and 75% fainter
  for (const level of [0, 0.25, 0.5, 0.75, 1]) {
    const y = trendY(level * 100, height, inset);
    const grid = new Path();
    grid.move(new Point(0, y));
    grid.addLine(new Point(width, y));
    ctx.addPath(grid);
    ctx.setStrokeColor(new Color(BAR_COLORS.track, level === 0.25 || level === 0.75 ? 0.15 : 0.3));
    ctx.setLineWidth(0.5);
    ctx.strokePath();
  }
  // The ends of the scale, at the left edge (under the lines drawn next)
  ctx.setFont(Font.systemFont(TREND_LABEL_SIZE));
  ctx.setTextColor(new Color(BAR_COLORS.track, 0.9));
  ctx.drawTextInRect("100%", new Rect(4, trendY(100, height, inset) + 1, 40, TREND_LABEL_SIZE + 3));
  ctx.drawTextInRect("0%", new Rect(4, trendY(0, height, inset) - TREND_LABEL_SIZE - 4, 40, TREND_LABEL_SIZE + 3));
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
  // Forecasts on top (dotted), with a ring where the limit would be reached before the reset
  for (const { from, to, hex, runsOut } of forecasts) {
    dashedSegment(ctx, from, to, hex, 0.9, 1.5, 2, 2.5);
    if (runsOut) {
      ctx.setStrokeColor(new Color(hex));
      ctx.setLineWidth(1.5);
      ctx.strokeEllipse(new Rect(to[0] - 3, to[1] - 3, 6, 6));
    }
  }
  return ctx.getImage();
}

/** Inner margin for lines in the large chart (radius of the large current-position dot) */
const TREND_INSET = 3;
/** Font size of the scale labels (100%, 0%) inside the large chart */
const TREND_LABEL_SIZE = 8;

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

/**
 * Marks on the large chart per provider (pixels): reset times, the even pace of the current cycle and the forecast continuation. Drawn also
 * for a provider without a trend yet (when its limit resets and where it is heading are useful on their own)
 */
function trendMarks(series, range, now, width, height) {
  const point = ([t, used]) => [trendX(t, range, width), trendY(used, height, TREND_INSET)];
  const out = { resets: [], guides: [], forecasts: [] };
  for (const s of series) {
    const hex = BRAND_COLORS[s.provider];
    for (const t of resetTimes(s.window, range, now)) out.resets.push({ x: trendX(t, range, width), hex });
    const guide = paceGuide(s.window, range, now);
    if (guide) out.guides.push({ from: point(guide[0]), to: point(guide[1]), hex });
    const forecast = forecastSegment(s.window, range, now);
    if (forecast) out.forecasts.push({ from: point(forecast.segment[0]), to: point(forecast.segment[1]), hex, runsOut: forecast.runsOut });
  }
  return out;
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
  const title = legend.addText("Weekly usage");
  title.font = Font.semiboldSystemFont(opts.scale.small);
  title.textColor = TEXT();
  title.lineLimit = 1;
  legend.addSpacer(null);
  if (!series.some(has)) {
    // Neither trend available: one line instead of the legend
    addSmallText(legend, "No weekly data yet", opts.scale.small, SUB());
  } else {
    // What the chart is (the weekly limit, this week) is said by the heading and the day labels; the legend shows only the providers
    for (const [i, s] of series.entries()) {
      if (i > 0) legend.addSpacer(10);
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
  stack.addImage(combinedTrendImage(drawn, opts.width, opts.height, TREND_INSET, {
    days: starts.slice(1, -1).map((t) => trendX(t, range, opts.width)),
    ...trendMarks(series, range, opts.now, opts.width, opts.height),
  }));
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
function layoutGroups(view, family, parameter, now, { cached = false, screen = null, demo = false } = {}) {
  const content = SIZE_CONTENT[family] ?? SIZE_CONTENT.medium;
  let scale = SCALES[family] ?? SCALES.medium;
  const pad = PADDING[family] ?? 0;
  const size = widgetSize(family, screen);
  const inner = size.width - 2 * pad;
  const large = family === "large" || family === "extraLarge";
  // In small, two stacked groups pull the visual center down, so add a little space below to lift them
  const lift = family === "small" ? 2 : 0;
  const groups = groupsOf(view, String(parameter ?? "").trim(), now, { allScoped: content.scoped });
  const two = groups.length >= 2;
  const smallThree = family === "small" && groups.length >= 3;
  if (smallThree) scale = SCALES.smallThree;
  // Three columns leave a header no room for Demo: the demo says so in the note row at the bottom instead (as the offline notice)
  const demoNote = demo && groups.length >= 3 && family !== "small";
  const showNote = (cached || demoNote) && family !== "small";
  // Height budget: the inside of the padding minus the visual correction, the note row and estimation error (2pt)
  const available = size.height - 2 * pad - lift - (showNote ? 4 + scale.small * 1.25 : 0) - 2;
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
    between = smallThree ? 4 : family === "small" ? 8 : 12;
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
  // Side by side (medium and large): columns of a fixed equal width (long text doesn't widen one), closer together when three
  const gap = groups.length >= 3 ? 10 : 14;
  const colWidth = two ? Math.floor((inner - gap * (groups.length - 1)) / groups.length) : inner;
  return { content, scale, pad, size, inner, large, lift, showNote, demoNote, two, between, trendHeight, gap, colWidth, groups: laid };
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
  // headerSmall is the plan and freshness text in the header. Large uses medium's sizes throughout (header, rows, bars); the chart takes the room left
  small: { compact: true, icon: 13, name: 12, headerSmall: 9, label: 10, pct: 10, small: 9, bar: 5, gapBar: 2, gapSub: 2, gapRow: 3, gapHeader: 3, header: 15 },
  // Small with three providers stacked: a smaller header and less space under it (rows as small)
  smallThree: { compact: true, icon: 11, name: 11, headerSmall: 9, label: 10, pct: 10, small: 9, bar: 5, gapBar: 2, gapSub: 2, gapRow: 3, gapHeader: 1, header: 13 },
  medium: { compact: false, icon: 15, name: 13, headerSmall: 10, label: 12, pct: 13, small: 10, bar: 8, gapBar: 3, gapSub: 2, gapRow: 7, gapHeader: 6, header: 16 },
  large: { compact: false, icon: 15, name: 13, headerSmall: 10, label: 12, pct: 13, small: 10, bar: 8, gapBar: 3, gapSub: 2, gapRow: 7, gapHeader: 6, header: 16 },
};
// The height of one limit (for estimating visible rows) is built from the same formula as the fixed height used when drawing (so they don't drift)
for (const [family, s] of Object.entries(SCALES)) s.rowHeight = rowHeightOf(s, SIZE_CONTENT[family] ?? SIZE_CONTENT.small);
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
  // Tapping opens the details (one provider when only one is shown). Not for the demo
  const tap = result.demo ? null : result.tap ?? null;
  const tapTo = (provider = null) => detailUrl(tap, provider);
  if (tap) widget.url = tapTo();
  const note = cached ? cachedNote(result.cachedAt, now) : "";
  const param = String(parameter ?? "").trim();
  if (family === "accessoryInline") {
    const items = param && param.toLowerCase() !== "top" ? lockPicks(result.view, param, now, MAX_PROVIDERS) : selectWindows(result.view, "top", now);
    if (!(param && param.toLowerCase() !== "top")) {
      for (const p of PROVIDER_ORDER) {
        // A failure without a reason code is also No data
        const v = result.view?.[p];
        const failed = Boolean(v?.error_code) || v?.status === "error";
        if (failed && !items.some((x) => x.provider === p)) {
          items.push({ missing: true, provider: p, providerName: PROVIDER_NAMES[p], label: ERROR_NAMES[v.error_code] ?? "No data", short: SHORT_ERROR_NAMES[v.error_code] ?? "No data" });
        }
      }
      items.sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider));
    }
    if (tap && items.length > 0 && items.every((x) => x.provider === items[0].provider)) widget.url = tapTo(items[0].provider);
    widget.addText(inlineText(items, cached, result.demo ? "Demo · " : ""));
    return widget;
  }
  if (family === "accessoryCircular") {
    const pick = lockPicks(result.view, param, now)[0];
    const top = pick && !pick.missing ? pick : null;
    const provider = pick?.provider ?? "claude";
    const icon = iconImage(provider);
    const ring = top ? ringOf(top.window) : null;
    if (tap && pick) widget.url = tapTo(provider);
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
      if (tap && picks.every((x) => x.provider === picks[0].provider)) widget.url = tapTo(picks[0].provider);
      drawLockPair(widget, picks, result, now, cached);
      return widget;
    }
    const top = picks[0] && !picks[0].missing ? picks[0] : null;
    if (!top) {
      const missing = picks[0]?.missing
        ? `${picks[0].providerName}${picks[0].label.startsWith("5h:") ? " " : ": "}${picks[0].label}`
        : "No data yet";
      if (tap && picks[0]?.missing) widget.url = tapTo(picks[0].provider);
      addSmallText(widget, result.demo ? `Demo · ${missing}` : missing, 11, SUB());
      return widget;
    }
    const w = top.window;
    if (tap) widget.url = tapTo(top.provider);
    const row = widget.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    const ringImg = row.addImage(ringImage(iconImage(top.provider), ringOf(w), BRAND_COLORS[top.provider], LOCK_RINGS.rectangular, top.provider));
    ringImg.imageSize = new Size(LOCK_RINGS.rectangular.size, LOCK_RINGS.rectangular.size);
    row.addSpacer(8);
    const col = row.addStack();
    col.layoutVertically();
    const mark = shortMark(w, !note);
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
  const layout = layoutGroups(result.view, family, param, now, { cached, screen: screenSize(), demo: Boolean(result.demo) });
  const { content, scale, inner, groups, two, large } = layout;
  const body = centeredBody(widget, inner, layout.lift);
  if (tap && groups.length === 1) widget.url = tapTo(groups[0].provider);
  // A demo says Demo in each header, or once in the note row when three columns leave the headers no room
  const base = { content, now, trends: result.trends ?? null, rows: Infinity, demo: Boolean(result.demo) && !layout.demoNote, outs: [] };
  const namesNothing = param === "" || param.toLowerCase() === "top";
  if (groups.length === 0 || (namesNothing && groups.every((g) => g.rows.length === 0 && g.message === "No data"))) {
    addSmallText(body, "No data yet", 12, SUB());
  } else if (large || (two && family !== "small")) {
    // Medium and large: the providers side by side (two or three columns of a fixed equal width); large adds one full-width chart
    // below overlaying their weekly trends
    if (two) {
      const cols = body.addStack();
      cols.layoutHorizontally();
      cols.topAlignContent();
      for (const [index, group] of groups.entries()) {
        if (index > 0) cols.addSpacer(layout.gap);
        const col = cols.addStack();
        col.layoutVertically();
        col.size = new Size(layout.colWidth, 0);
        if (tap) col.url = tapTo(group.provider);
        drawGroup(col, group, withFit(groups, { ...base, scale, width: layout.colWidth }));
      }
    } else {
      drawGroup(body, groups[0], withFit(groups.slice(0, 1), { ...base, scale, width: inner }));
    }
    if (large && layout.trendHeight > 0) {
      body.addSpacer(TREND_GAP);
      drawCombinedTrend(body, groups, { ...base, scale, width: inner, height: layout.trendHeight, view: result.view });
    }
  } else {
    // Small, or a single provider: stacked top to bottom
    for (const [index, group] of groups.entries()) {
      if (index > 0) body.addSpacer(layout.between);
      drawGroup(body, group, withFit(groups, { ...base, scale, width: inner }));
    }
  }
  widget.__outs = base.outs;
  // Only when showing previous values (or a demo of three columns), put that notice at the bottom (small has only the ⚠ in the header)
  if (layout.showNote) {
    body.addSpacer(4);
    const row = body.addStack();
    row.layoutHorizontally();
    row.addSpacer(null);
    addSmallText(row, [layout.demoNote ? "Demo" : "", note].filter(Boolean).join(" · "), 9, SUB());
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
    HEADROOM_VERSION, VIEW_VERSION, KEYCHAIN_CONFIG, KEYCHAIN_CURRENT, KEYCHAIN_LEGACY, MAX_WINDOWS, normalizeBaseUrl, buildRequest, validateSetup, sanitizeView,
    atDisplayTime, recentSettledAt, shortMark, selectWindows, groupsOf, barSegments, barWidths, windowName, limitLabel, shortName,
    percentText, compactPercent, demoName, withoutDemo, demoResult, DEMO_SCENARIOS, rowPlan, textWidth, fittedSizes, ringOf, ringImage, LOCK_RINGS, lockPicks, drawLockPair, LOCK_TITLE_WIDTH, INLINE_WIDTH, SHORT_ERROR_NAMES, timeShort, whenShort, TIME_SYMBOLS, limitName, refreshAfter, inlineText, segmentShape, BRAND_COLORS, ICONS,
    SIZE_CONTENT, paceText, sanitizeHistory, sparkLines, trendWindows, clockText, widgetSize, PADDING, drawnJunction,
    projectionOf, barSegmentsAt, barPieces, freshnessOf, resetShort, rowMark, SCALES, WARN_MARK, BAR_COLORS, PROVIDER_ORDER, NOT_AVAILABLE, trendDrawOrder, lineHeight, subHeight, rowHeightOf, FRESH_COLORS, fitRows, groupHeight, thinPoints, paceOf, visibleRows, sanitizeBoundaries, layoutGroups, rowRank, trendSeries, timerWidth, remainingText, trendY, TREND_HOURS, weekRange, dayStarts, trendX, WEEKDAYS, resetTimes, cycleEnd, scopeName, RESET_MARK, limitLifted, clipSegment, paceGuide, forecastSegment, trendMarks,
    splitNotify, notifyPrefs, reminderPlan, reconcileReminders, reminderId, sanitizeEvents, selectAlerts, alertNotifications, sampleNotifications, eventPhrase, notifyTitle, SYMBOLS, eventsFileName, eventsCursor,
    readNotifyState, readRecords, forgetSwitched, withdrawnAt, accountMark, emptyViewAt, recordName, parseRecord, eventMark, lockFree, holdsLock, withoutCancelled, orphanFiles, fileTag, deliveredSeqs, keepTold, readConfigState, LOCK_SETTLE_MS, detailUrl, parameterGuideHtml, buildParameter, PARAMETER_CHOICES, PARAMETER_GUIDE, detailHtml, detailTiles, tilesHtml, tileTime, providerAge, worstText, fullLimitName, detailChart, dayLabel, iconCss, missingFiveHour, esc, KEYCHAIN_NOTIFY, RUNOUT_LEAD_MINUTES,
    resetDate, errorText, cachedNote, readCache, originTag, cacheTag, sameConfig, DEFAULT_CONFIG_ID, cacheFileName, seenFileName, pickCache, seenFrom, OWN_FILE, formatDuration,
    providerList, defaultProviders, missingText, demoParameter, MAX_REMINDERS, KEPT_REMINDERS, SHORT_PROVIDER_NAMES, NOT_SUPPORTED, UNVERIFIED_PROVIDERS, DEFAULT_PROVIDERS, MAX_PROVIDERS, VIEW_PROVIDERS, FALLBACK_MARKS, PROVIDER_NAMES,
  };
}
