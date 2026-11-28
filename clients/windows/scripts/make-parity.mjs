// Writes tests/parity.json: what the desktop client must show for a set of server views, as the widget's own functions
// (packages/scriptable/Headroom.js) judge and word it. src/model.rs is tested against this file, so the client and the widget
// never drift apart; CI runs this script again and fails if the file changes.
//
//   node scripts/make-parity.mjs          write the file
//   node scripts/make-parity.mjs --check  fail if the file is not what the widget gives now
//
// Clock times depend on the time zone, so the views are judged in a fixed one (the Rust test uses the same).
const TIME_ZONE = "Asia/Tokyo";
process.env.TZ = TIME_ZONE;

import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../../../packages/scriptable/Headroom.js", import.meta.url), "utf8");
const module = { exports: {} };
vm.runInContext(`(async () => {\n${code}\n})()`, vm.createContext({ module, console, Intl, Date, Math, JSON, encodeURIComponent, Number, String, Object, Boolean }));
const lib = module.exports;

// ---- What the notch, its card and the tray show (src/model.rs mirrors these) ----

/** The limit a provider's ring shows: its 5-hour limit, else its weekly one, else its first */
function headlineOf(group) {
  const windows = group.rows.filter((r) => r.kind === "window").map((r) => r.window);
  return windows.find((w) => w.id === "five_hour") ?? windows.find((w) => w.id === "seven_day") ?? windows[0] ?? null;
}

/** The thin outer ring: the weekly limit, when the ring itself shows another one */
function weeklyOf(group, headline) {
  if (!headline || headline.id === "seven_day") return null;
  return group.rows.find((r) => r.kind === "window" && r.window.id === "seven_day")?.window ?? null;
}

/** "45m", "2h 18m", "<1m" */
function countdownText(ms) {
  if (ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The time line of a limit: the reset (↻) or, when it will run out first, the run-out time (⚠) */
function timeLine(w, now) {
  const t = lib.timeShort(w, now);
  if (!t) return { text: "", warn: false };
  const mark = t.warn ? "⚠" : t.symbol === "start" ? "⧗" : t.symbol === "unknown" ? "?" : "↻";
  const body = t.kind === "timer" ? countdownText(t.date.getTime() - now.getTime()) : t.text;
  return { text: `${mark} ${body}`, warn: Boolean(t.warn) };
}

/** The pieces of a ring or a bar (fractions 0..1): likely left after reset (solid), likely used before it (light), recent (gray) */
function pieces(w, now) {
  const s = lib.barSegmentsAt(w, now);
  return { solid: Math.max(0, s.remaining - s.projected), projected: s.projected, recent: s.recent, faded: Boolean(s.faded), runsOut: Boolean(s.runsOut) };
}

function notchModel(view, now) {
  return lib.groupsOf(view, "", now, { allScoped: true }).map((g) => {
    const headline = headlineOf(g);
    const weekly = weeklyOf(g, headline);
    const fresh = lib.freshnessOf(view, g.provider, now);
    const time = headline ? timeLine(headline, now) : { text: "", warn: false };
    return {
      provider: g.provider,
      name: g.name,
      plan: g.plan,
      color: lib.BRAND_COLORS[g.provider] ?? "#8e8e93",
      headline: headline && { id: headline.id, text: lib.remainingText(headline), pieces: pieces(headline, now), warn: time.warn },
      weekly: weekly && { pieces: pieces(weekly, now) },
      stale: fresh?.level === "stale" || fresh?.level === "old",
      fresh: fresh ? { level: fresh.level, color: lib.FRESH_COLORS[fresh.level] ?? "#8e8e93" } : null,
      message: g.message,
      rows: g.rows.map((r) => {
        if (r.kind !== "window") return { missing: true, label: r.label ?? "5h limit", text: r.text };
        const w = r.window;
        const t = timeLine(w, now);
        return { missing: false, id: w.id, label: lib.rowLabel(w), left: `${lib.remainingText(w)} left`, pace: lib.paceText(w) ?? "", time: t.text, warn: t.warn, pieces: pieces(w, now) };
      }),
    };
  });
}

/** The tray's menu lines and tooltip (the tooltip holds 127 characters) */
function trayModel(cells) {
  const lines = cells.map((c) => {
    if (!c.headline) return `${c.name} — ${c.message ?? "No data"}`;
    const row = c.rows.find((r) => r.id === c.headline.id);
    return `${c.name} — ${c.headline.text} left${row ? ` (${row.label})` : ""}${row?.time ? ` · ${row.time}` : ""}`;
  });
  const parts = cells.filter((c) => c.headline).map((c) => `${c.name} ${c.headline.text}`);
  const tooltip = parts.length > 0 ? `Headroom — ${parts.join(" · ")}` : "Headroom";
  return { lines, tooltip: tooltip.length > 127 ? `${tooltip.slice(0, 126)}…` : tooltip };
}

// ---- The views ----

const NOW = new Date("2026-11-16T13:05:00.000Z");
const at = (minutes, from = NOW) => new Date(from.getTime() + minutes * 60000).toISOString();

/** A sanitized view back in the server's shape (the id lists as comma-separated text) */
function serverShape(view) {
  const out = { view_version: view.view_version, data_version: view.data_version, boundaries: view.boundaries };
  for (const p of ["claude", "codex", "gemini"]) {
    const v = view[p];
    out[p] = v && { ...v, main_window_ids: v.main_window_ids.join(","), window_ids: v.window_ids.join(",") };
  }
  return out;
}

const win = (id, used, o = {}) => ({
  id, label: o.label ?? id, scope: o.scope ?? null, used_percent: used,
  recent_consumed_percent: o.recent ?? null, recent_quality: o.quality ?? (o.recent === undefined ? "unknown" : "exact"),
  recent_minutes: id.includes("five_hour") ? 60 : 1440, confidence: o.confidence ?? "high",
  fetched_at: o.fetched === null ? null : at(-(o.age ?? 1)),
  resets_at: o.resets === null ? null : at(o.resets ?? (id.includes("five_hour") ? 180 : 3 * 1440)),
  eta_at: null, reset_first: null, eta_minutes: null, rate_15m: null,
  rate_60m: o.rate60 ?? o.rate ?? null, rate_24h: o.rate ?? null,
  ...(o.noPace ? {} : { rate_pace: o.pace ?? o.rate ?? 0 }),
  detail_only: o.detail === true,
});
const provider = (windows, o = {}) => ({
  status: o.status ?? "ok", plan: o.plan ?? "pro", error_code: o.error ?? null, blocked: o.blocked ?? false, collector: "desktop",
  main_window_ids: windows.filter((w) => !w.scope).map((w) => w.id).join(","),
  window_ids: windows.map((w) => w.id).join(","),
  windows: Object.fromEntries(windows.map((w) => [w.id, w])),
});
const body = (providers) => ({ view_version: 1, data_version: 7, boundaries: null, claude: null, codex: null, ...providers });

const OFFSETS = [0, 2, 30, 4 * 60, 2 * 1440];
const cases = [];
for (const { name } of lib.DEMO_SCENARIOS) cases.push({ name: `demo ${name}`, body: serverShape(lib.demoResult(name, NOW).view), offsets: OFFSETS });

cases.push({
  name: "small remainders, odd names and scopes",
  body: body({
    claude: provider([
      win("five_hour", 99.7, { recent: 0.5, rate: 0.2 }),
      win("seven_day", 99.9996, { rate: 0.01, quality: "approx", recent: 0.1 }),
      win("window_120m", 40, { scope: "Opus" }),
      win("window_90m", 12, { scope: "two words!" }),
      win("window_2880m", 5, { scope: "Codex extra" }),
      win("burst", 3, { label: "Burst", scope: "Fable" }),
      win("odd", 3, { label: "not one word", scope: "Argon" }),
      win("monthly_x", 50, { scope: "codex_other", confidence: "low" }),
    ], { plan: "max" }),
    codex: provider([win("primary", 10, { label: "Primary" }), win("secondary", 20)], { plan: "plus" }),
  }),
  offsets: [0, 60],
});
cases.push({
  name: "runs out, then the run-out time passes",
  body: body({
    claude: provider([win("five_hour", 90, { recent: 20, rate: 30 }), win("seven_day", 40, { rate: 2.5, rate60: 12.34 })]),
    codex: provider([win("five_hour", 50, { rate: 600, resets: 3000 }), win("seven_day", 10, { rate: 0.05, noPace: true })]),
  }),
  offsets: [0, 19.5, 20.5, 25, 179, 181],
});
cases.push({
  name: "age, unknown times and limits",
  body: body({
    claude: provider([win("five_hour", 30, { age: 50, resets: null }), win("seven_day", 0, { age: 50, resets: null, rate: 0 })]),
    codex: provider([win("five_hour", 100, { resets: 40, recent: 10 }), win("seven_day", 70, { recent: 3, rate: 0.5, confidence: "insufficient" })], { blocked: true }),
    gemini: provider([win("five_hour", 5, { fetched: null, rate: 1 }), win("seven_day", 6, { fetched: null })], { status: "stale" }),
  }),
  offsets: [0, 30, 45, 61, 120],
});
cases.push({
  name: "stopped and failed providers",
  body: body({
    claude: { ...provider([win("five_hour", 30)], { error: "access_denied", status: "error" }), blocked: true },
    codex: { status: "error", plan: "nope", error_code: "fetch_failed", main_window_ids: "", window_ids: "", windows: {} },
    gemini: { status: "unavailable", plan: null, error_code: "weird", main_window_ids: "", window_ids: "", windows: {} },
  }),
  offsets: [0],
});
cases.push({
  name: "weekly only, scoped at the limit, other makers",
  body: body({
    claude: provider([win("seven_day", 20), win("seven_day_fable", 100, { scope: "Fable", resets: 600 }), win("five_hour_x", 100, { scope: "Claude and GPT", detail: true })]),
    codex: provider([win("seven_day", 41), win("codex_other_seven_day", 12, { scope: "codex_other" })], { status: "error" }),
  }),
  offsets: [0, 601],
});
cases.push({
  name: "a long label and extra fields",
  body: { ...body({ claude: provider([win("five_hour", 12.5, { label: "x".repeat(40) })]) }), extra: { a: 1 }, codex: null },
  offsets: [0],
});
{
  const b = body({ claude: provider([win("five_hour", 1)]) });
  delete b.gemini;
  cases.push({ name: "no gemini key", body: b, offsets: [0] });
}

cases.push({
  name: "rounding edges and numbers written in exponent form",
  body: body({
    claude: provider([
      win("five_hour", 0.49999999999999994, { rate: 1e21 }),
      win("seven_day", 99.5, { rate: 1.5e-7, recent: 0.5 }),
      win("window_60m", 12.5, { scope: "Fable", rate: 9.95 }),
    ]),
    codex: provider([win("five_hour", 2.5, { rate: 9.949999 }), win("seven_day", 50.5, { rate: 10.5 })]),
  }),
  offsets: [0],
});
{
  // An empty scope (falsy to the widget), a long label of an unknown limit, the id lists in another order than the windows
  const b = body({
    claude: provider([
      win("five_hour", 10),
      win("seven_day_blank", 20, { scope: "" }),
      win("burst_x", 30, { label: "Abcdefghijklmnopqrstuvwxyz0123", scope: "Fable" }),
      win("burst_y", 40, { label: "x".repeat(30), scope: "Opus" }),
    ]),
  });
  b.claude.window_ids = "burst_y,seven_day_blank,five_hour,burst_x";
  b.claude.main_window_ids = "five_hour";
  cases.push({ name: "empty scope, long labels, ids in another order", body: b, offsets: [0] });
}
{
  // Times in the other forms the date format allows: a date alone (UTC), no offset (local time), an offset, a long fraction,
  // and forms that aren't it. (Date.parse also reads other forms, like "Mon, 16 Nov 2026 14:05:00", with rules of its own; the server
  // writes the ISO form only, and the client reads no other)
  const w = (id, resets, fetched = at(-1)) => ({ ...win(id, 30, { rate: 3 }), resets_at: resets, fetched_at: fetched });
  cases.push({
    name: "times in other forms",
    body: body({
      claude: provider([
        w("five_hour", "2026-11-16T23:05:00+09:00", "2026-11-16T22:04:00.123456+09:00"),
        w("seven_day", "2026-11-19"),
        w("window_60m", "2026-11-16T23:35", "2026-11-16T22:00"),
        w("window_90m", "2026-11-16T23:05+09"),
        w("window_120m", "2026-02-30T10:00:00Z"),
        w("window_180m", "2026-11-16T25:00:00Z"),
        w("window_240m", "2026-11"),
        w("window_300m", "2026"),
      ].map((x) => ({ ...x, scope: x.id === "five_hour" || x.id === "seven_day" ? null : "Fable" }))),
    }),
    offsets: [0, 30, 1440],
  });
}
// Views given as JSON text, so the numbers reach both parsers as written
const texts = [
  { name: "a data version written past the last safe digit", text: '{"view_version":1,"data_version":9007199254740991.36,"claude":null,"codex":null}' },
  { name: "a used percent written with more digits than a double holds", text: `{"view_version":1,"data_version":1,"claude":${JSON.stringify(provider([win("five_hour", 1)])).replace('"used_percent":1,', '"used_percent":0.499999999999999972244,')},"codex":null}` },
];

// Bodies the widget refuses (the client keeps what it showed before)
const good = () => body({ claude: provider([win("five_hour", 10), win("seven_day_fable", 5, { scope: "Fable" })]) });
const bad = [];
const badCase = (name, edit) => {
  const b = good();
  edit(b);
  bad.push({ name, body: b });
};
badCase("unknown view version", (b) => (b.view_version = 2));
badCase("no codex key", (b) => delete b.codex);
badCase("negative data version", (b) => (b.data_version = -1));
badCase("fractional data version", (b) => (b.data_version = 1.5));
badCase("data version as text", (b) => (b.data_version = "7"));
badCase("window under another id", (b) => (b.claude.windows.five_hour.id = "seven_day"));
badCase("window list misses one", (b) => (b.claude.window_ids = "five_hour"));
badCase("window list repeats one", (b) => (b.claude.window_ids = "five_hour,five_hour,seven_day_fable"));
badCase("main list holds a scoped one", (b) => (b.claude.main_window_ids = "five_hour,seven_day_fable"));
badCase("used percent as text", (b) => (b.claude.windows.five_hour.used_percent = "10"));
badCase("bad window id", (b) => {
  b.claude.windows["Five"] = { ...b.claude.windows.five_hour, id: "Five" };
  delete b.claude.windows.five_hour;
  b.claude.window_ids = "Five,seven_day_fable";
  b.claude.main_window_ids = "Five";
});
badCase("provider is a list", (b) => (b.codex = []));
badCase("windows is a list", (b) => (b.claude.windows = []));
badCase("no windows", (b) => delete b.claude.windows);
bad.push({ name: "not an object", body: [1, 2] });
bad.push({ name: "too many limits for the client", body: body({ claude: provider(Array.from({ length: 257 }, (_, i) => win(`window_${i + 1}m`, 1, { scope: "Fable" }))) }), clientOnly: true });
const badTexts = [
  { name: "a data version past the largest safe one", text: '{"view_version":1,"data_version":9007199254740993,"claude":null,"codex":null}' },
  // The client refuses these on purpose (the widget takes them): a number too large for a double, a lone surrogate. Neither is
  // in what the server writes; the client keeps what it showed and says the answer isn't a view
  { name: "a number too large for a double", text: '{"view_version":1,"data_version":1,"claude":null,"codex":null,"x":1e400}', clientOnly: true },
  { name: "a lone surrogate", text: '{"view_version":1,"data_version":1,"claude":null,"codex":null,"x":"\\ud800"}', clientOnly: true },
];

// Times as Date.parse reads them, in a zone with daylight saving time too (offsetless times are local), and the forms the client
// doesn't read (it reads only what the server writes: see parse_time in src/model.rs)
const DATE_TEXTS = [
  "2026-11-16T13:05:00.000Z", "2026-11-16T13:05:00.123456Z", "2026-11-16T22:05:00+09:00", "2026-11-16T08:05-05:00",
  "2026-11-16", "2026-11", "2026", "2026-02-30", "2026-02-31T10:00:00Z", "2026-11-16T22:05", "2026-11-16T22:05:30.5",
  // New York: 2026-03-08 02:30 doesn't exist (moves forward), 2026-11-01 01:30 happens twice (the first)
  "2026-03-08T02:30", "2026-03-08T01:59:59", "2026-03-08T03:00", "2026-11-01T01:30", "2026-11-01T00:59", "2026-11-01T02:00",
  "2026-11-16T23:05+09", "2026-11-16T25:00:00Z", "2026-13-01", "2026-11-32", "2026-11-16T12:60Z", "2026-11-16T13:05:00.Z",
  "", "x", "2026-11-16t13:05:00z",
];
const NOT_READ = ["2026-11-16T24:00:00.000Z", "+002026-11-17T00:00:00.000Z", "Mon, 16 Nov 2026 14:05:00"];
function datesIn(zone) {
  process.env.TZ = zone;
  const times = DATE_TEXTS.map((text) => {
    const ms = Date.parse(text);
    return { text, ms: Number.isFinite(ms) ? ms : null };
  });
  for (const text of NOT_READ) times.push({ text, ms: null });
  process.env.TZ = TIME_ZONE;
  return { zone, times };
}
bad.push({ name: "null", body: null });

const out = {
  note: "Generated by scripts/make-parity.mjs from packages/scriptable/Headroom.js. Do not edit.",
  time_zone: TIME_ZONE,
  // Each view once, with what it shows at several times
  views: cases.map(({ name, body: raw, offsets }) => {
    const view = lib.sanitizeView(JSON.parse(JSON.stringify(raw)));
    if (!view) throw new Error(`the widget refuses the view of "${name}"`);
    return {
      name,
      body: raw,
      shown: offsets.map((m) => {
        const now = new Date(NOW.getTime() + m * 60000);
        const cells = notchModel(view, now);
        return { now: now.toISOString(), cells, tray: trayModel(cells) };
      }),
    };
  }).concat(texts.map(({ name, text }) => {
    const view = lib.sanitizeView(JSON.parse(text));
    if (!view) throw new Error(`the widget refuses the view of "${name}"`);
    const cells = notchModel(view, NOW);
    return { name, text, shown: [{ now: NOW.toISOString(), cells, tray: trayModel(cells) }] };
  })),
  dates: [datesIn("America/New_York"), datesIn(TIME_ZONE)],
  // The widget accepts the client-only ones (no bound on the number of limits; numbers and strings JSON.parse takes)
  refused: bad.map(({ name, body: raw, clientOnly }) => {
    if (!clientOnly && lib.sanitizeView(JSON.parse(JSON.stringify(raw))) !== null) throw new Error(`the widget accepts "${name}"`);
    return { name, body: raw };
  }).concat(badTexts.map(({ name, text, clientOnly }) => {
    if (!clientOnly && lib.sanitizeView(JSON.parse(text)) !== null) throw new Error(`the widget accepts "${name}"`);
    return { name, text };
  })),
};

const file = new URL("../tests/parity.json", import.meta.url);
const text = `${JSON.stringify(out, null, 1)}\n`;
if (process.argv.includes("--check")) {
  let before = "";
  try {
    before = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch (_) {}
  if (before !== text) {
    console.error("tests/parity.json is not what the widget gives now: run node scripts/make-parity.mjs, then fix src/model.rs until cargo test passes");
    process.exit(1);
  }
  console.log(`tests/parity.json is current (${out.views.length} views, ${out.refused.length} refused bodies)`);
} else {
  writeFileSync(file, text);
  console.log(`wrote tests/parity.json (${out.views.length} views, ${out.refused.length} refused bodies)`);
}
