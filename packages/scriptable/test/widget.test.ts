// Tests the Scriptable widget (Headroom.js) in Node. Pure functions are called directly; drawing runs with the Scriptable API stubbed.
// Views are built with toView from @headroom/core (the same shape the server returns). The draw clock is fixed
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { mergeSnapshots, toView, type Snapshot, type SnapshotView, type UsageObservation } from "../../core/src/index.ts";

const code = readFileSync(new URL("../Headroom.js", import.meta.url), "utf8");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Lib = Record<string, any>;

const NOW = new Date("2026-11-16T13:00:00.000Z");

/** Make only new Date() (no arguments) and Date.now() return clock.now (can be advanced during a test) */
function fixedDate(clock: { now: Date }): DateConstructor {
  class FixedDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now.getTime());
      else super(...(args as [string]));
    }
    static override now() {
      return clock.now.getTime();
    }
  }
  return FixedDate as unknown as DateConstructor;
}

/** Load only the pure functions (main doesn't run when module exists) */
function loadLib(): Lib {
  const module = { exports: {} as Lib };
  const context = vm.createContext({ module, console, Intl, Date, Math, JSON, encodeURIComponent, Number, String, Object, Boolean });
  vm.runInContext(`(async () => {\n${code}\n})()`, context);
  return module.exports;
}

const lib = loadLib();
/** Copy values created inside vm to this realm (deepEqual doesn't treat arrays/objects from another realm as equal) */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const TAG: string = lib.cacheTag({ id: lib.DEFAULT_CONFIG_ID }, "https://headroom.example.com");

const fixture = (): Snapshot =>
  JSON.parse(readFileSync(new URL("../../../fixtures/snapshot/v2-basic.json", import.meta.url), "utf8"));

/** Same shape as the server's GET /v2/view (toView + data_version) */
function sampleView(dataVersion = 10): SnapshotView & { data_version: number; boundaries: { claude: string; codex: string } } {
  const merged = mergeSnapshots([fixture()])!;
  const observations: UsageObservation[] = [
    { provider: "claude", window_id: "five_hour", collector: "win-desktop", resets_at: "2026-11-16T16:00:00.000Z", used_percent: 4, observed_at: "2026-11-16T12:00:00.000Z" },
  ];
  return { ...toView(merged, NOW, { observations }), data_version: dataVersion, boundaries: { claude: "#0", codex: "#0" } };
}

/** Contents of the previous-view file with the highest number */
function latestCache(files: Map<string, string>): string | undefined {
  const names = [...files.keys()].filter((p) => /headroom-view-[0-9a-f]+-\d+\.json$/.test(p));
  names.sort((a, b) => Number(/(\d+)\.json$/.exec(b)![1]) - Number(/(\d+)\.json$/.exec(a)![1]));
  return names[0] ? files.get(names[0]) : undefined;
}

test("The server is an https origin only; credentials go in headers, never in the URL", () => {
  assert.equal(lib.normalizeBaseUrl("https://Headroom.example.com/"), "https://headroom.example.com");
  assert.equal(lib.normalizeBaseUrl("https://headroom.example.com:8443"), "https://headroom.example.com:8443");
  assert.equal(lib.normalizeBaseUrl("https://headroom.example.com/api"), null, "no path");
  assert.equal(lib.normalizeBaseUrl("http://headroom.example.com"), null);
  assert.equal(lib.normalizeBaseUrl("https://user:pw@headroom.example.com"), null);
  assert.equal(lib.normalizeBaseUrl("https://headroom.example.com/?token=x"), null);
  const spec = lib.buildRequest({ url: "https://headroom.example.com", token: "read-token-xyz", accessId: "id.access", accessSecret: "secret-abc" }, "Asia/Tokyo");
  assert.equal(spec.url, "https://headroom.example.com/v2/view?tz=Asia%2FTokyo");
  assert.equal(spec.headers.Authorization, "Bearer read-token-xyz");
  assert.ok(!Object.keys(spec.headers).some((k) => k.startsWith("CF-Access")), "no Access headers (even with values saved by older versions; Access support was removed)");
  assert.equal(lib.buildRequest({ url: "https://x.example", token: "" }, "UTC"), null);
});

test("Setup input is only the server origin and the read token (no Access fields)", () => {
  assert.deepEqual(plain(lib.validateSetup({ url: "https://h.example", token: " t " })), { url: "https://h.example", token: "t" });
  assert.ok(lib.validateSetup({ url: "https://h.example/x", token: "t" }).error);
  assert.ok(lib.validateSetup({ url: "https://h.example", token: "" }).error);
});

test("Responses are checked for version and shape and trimmed to display fields; the previous view is used only for the same server", () => {
  const view = sampleView() as any;
  view.extra_secret = "should-not-be-kept";
  view.claude.windows.five_hour.injected = "x";
  const clean = lib.sanitizeView(view);
  assert.ok(clean);
  const text = JSON.stringify(clean);
  assert.ok(!text.includes("should-not-be-kept") && !text.includes("injected"));
  assert.equal(lib.sanitizeView({ ...view, view_version: 99 }), null, "unknown versions are not used");
  assert.equal(lib.sanitizeView({ error: "unauthorized" }), null);
  const saved = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://a.example", view: clean });
  assert.ok(lib.readCache(saved, "https://a.example"));
  assert.equal(lib.readCache(saved, "https://b.example"), null, "after changing servers, the old server's values are not shown");
  assert.equal(lib.readCache("not json", "https://a.example"), null);
});

test("Staleness and reset (estimated) are recomputed at draw time; after a reset, 0% without the previous cycle's gray", () => {
  const w = { id: "five_hour", label: "5h", scope: null, used_percent: 60, recent_consumed_percent: 10, recent_quality: "exact",
    confidence: "high", fetched_at: "2026-11-16T12:59:00.000Z", resets_at: "2026-11-16T15:00:00.000Z" };
  const fresh = lib.atDisplayTime(w, NOW);
  assert.equal(fresh.value_status, "fresh");
  assert.equal(fresh.status_text, "");
  const stale = lib.atDisplayTime(w, new Date("2026-11-16T13:30:00.000Z"));
  assert.equal(stale.status_text, "⚠︎ 31m ago");
  const old = lib.atDisplayTime(w, new Date("2026-11-16T14:01:00.000Z"));
  assert.equal(old.value_status, "old");
  assert.equal(lib.barSegments(old).faded, true, "old bars are faded");
  const reset = lib.atDisplayTime(w, new Date("2026-11-16T15:05:00.000Z"));
  assert.deepEqual([reset.used_percent, reset.value_status, reset.reset_passed], [0, "reset_estimated", true]);
  assert.equal(lib.barSegments(reset).recent, 0, "no gray from the previous cycle");
  assert.equal(reset.status_text, "Reset (estimated) · Recent: no data");
});

test("Overall limits come first; per-model and per-group limits are appended only at 100%", () => {
  const view = sampleView();
  const keys = (v: unknown, param: string) => plain(lib.selectWindows(lib.sanitizeView(v), param, NOW).map((x: any) => `${x.provider}.${x.window.id}`));
  assert.deepEqual(keys(view, ""), ["codex.seven_day", "claude.five_hour", "claude.seven_day"]);
  assert.deepEqual(keys(view, "codex"), ["codex.seven_day"]);
  assert.deepEqual(keys(view, "claude.seven_day, codex.seven_day"), ["claude.seven_day", "codex.seven_day"]);
  assert.deepEqual(keys(view, "top"), ["codex.seven_day", "claude.five_hour"]);
  const full = structuredClone(view);
  full.claude!.windows.seven_day_fable!.used_percent = 100;
  assert.deepEqual(keys(full, ""), ["codex.seven_day", "claude.five_hour", "claude.seven_day", "claude.seven_day_fable"],
    "scoped limits go last so the display cap never drops overall limits");
  // Even for a provider without overall limits, scoped limits below 100% are not shown
  const onlyScoped = structuredClone(view);
  onlyScoped.codex!.main_window_ids = "";
  assert.deepEqual(keys(onlyScoped, "codex"), []);
});

test("Bar widths are proportional; if recent consumption is all of used, all of used is gray", () => {
  const w = { used_percent: 1, recent_consumed_percent: 1, recent_quality: "exact", value_status: "fresh" };
  // Remaining from the left, recent consumption (gray) right after it
  assert.deepEqual(plain(lib.barWidths(lib.barSegments(w), 100)), { remainingEnd: 99, recentEnd: 100 });
  assert.deepEqual(plain(lib.barWidths(lib.barSegments({ ...w, used_percent: 40, recent_consumed_percent: 10 }), 100)), { remainingEnd: 60, recentEnd: 70 });
  assert.equal(lib.barSegments({ ...w, recent_quality: "unknown" }).recent, 0);
});

test("Notice texts: previous values and failed fetches (no bodies or credentials)", () => {
  assert.equal(lib.cachedNote("2026-11-16T12:40:00.000Z", NOW), "⚠︎ Can't update · data from 20m ago");
  assert.equal(lib.errorText(401), "Check your credentials");
  assert.equal(lib.errorText(200), "Couldn't read the response");
  assert.equal(lib.errorText(0), "Can't reach the server");
});

// ---- Drawing: run main with the Scriptable API stubbed ----

class Node {
  kind: string;
  children: Node[] = [];
  props: Record<string, unknown> = {};
  constructor(kind: string, props: Record<string, unknown> = {}) {
    this.kind = kind;
    Object.assign(this.props, props);
  }
}

function makeStack(kind: string): any {
  const node = new Node(kind);
  return {
    node,
    layoutHorizontally() {}, layoutVertically() {},
    centerAlignContent() { node.props.align = "center"; }, topAlignContent() { node.props.align = "top"; }, bottomAlignContent() { node.props.align = "bottom"; },
    setPadding(...a: number[]) { node.props.padding = a; },
    set size(v: any) { node.props.size = v; },
    addText(text: string) {
      const n = new Node("text", { text });
      node.children.push(n);
      return {
        set font(v: any) { n.props.font = v; }, set textColor(v: any) { n.props.color = v?.hex; }, set lineLimit(_v: unknown) {},
        set minimumScaleFactor(v: number) { n.props.minScale = v; }, centerAlignText() {},
      };
    },
    addStack() {
      const s = makeStack("stack");
      node.children.push(s.node);
      return s;
    },
    addSpacer(length?: number) { node.children.push(new Node("spacer", { length })); },
    addImage(img: any) {
      // Icons drawn inside the circular progress also count as icon symbols/data
      const n = new Node("image", { fills: img.fills, symbol: img.symbol ?? img.icon?.symbol, data: img.data ?? img.icon?.data, strokes: img.strokes, size: img.size, widths: img.widths, ellipses: img.ellipses, ring: img.ellipses > 0, drawnTexts: img.texts });
      node.children.push(n);
      return { set resizable(v: boolean) { n.props.resizable = v; }, set imageSize(v: unknown) { n.props.imageSize = v; }, set tintColor(v: any) { n.props.tint = v?.hex; } };
    },
    addDate(date: Date) {
      const d = new Node("date", { date: date.toISOString() });
      node.children.push(d);
      return { applyTimerStyle() { d.props.timer = true; }, set font(_v: unknown) {}, set textColor(_v: unknown) {} };
    },
  };
}

/** First stack matching the condition (depth-first) */
const findStack = (node: Node, pred: (n: Node) => boolean): Node | undefined =>
  node.kind !== "text" && pred(node) ? node : node.children.map((c) => findStack(c, pred)).find(Boolean);
/** Columns of the stack that puts Claude and Codex side by side */
/** The two provider columns: a stack whose two fixed-width children each name one provider (not the chart's legend or day labels) */
const columnsOf = (root: Node): Node[] =>
  findStack(root, (n) => {
    const kids = n.children.filter((c) => c.kind === "stack" && c.props.size);
    return kids.length === 2 && kids.every((k) => texts(k).includes("Claude") !== texts(k).includes("Codex"));
  })!.children.filter((c) => c.kind === "stack");

const textNodes = (node: Node): Node[] => [...(node.kind === "text" ? [node] : []), ...node.children.flatMap(textNodes)];
/** Methods available on Scriptable's Font (https://docs.scriptable.app/font/) */
const SCRIPTABLE_FONTS = new Set([
  "largeTitle", "title1", "title2", "title3", "headline", "subheadline", "body", "callout", "footnote", "caption1", "caption2",
  "systemFont", "ultraLightSystemFont", "thinSystemFont", "lightSystemFont", "regularSystemFont", "mediumSystemFont",
  "semiboldSystemFont", "boldSystemFont", "heavySystemFont", "blackSystemFont", "italicSystemFont",
  "ultraLightMonospacedSystemFont", "thinMonospacedSystemFont", "lightMonospacedSystemFont", "regularMonospacedSystemFont",
  "mediumMonospacedSystemFont", "semiboldMonospacedSystemFont", "boldMonospacedSystemFont", "heavyMonospacedSystemFont",
  "blackMonospacedSystemFont", "ultraLightRoundedSystemFont", "thinRoundedSystemFont", "lightRoundedSystemFont",
  "regularRoundedSystemFont", "mediumRoundedSystemFont", "semiboldRoundedSystemFont", "boldRoundedSystemFont",
  "heavyRoundedSystemFont", "blackRoundedSystemFont",
]);

const images = (node: Node): Node[] => [...(node.kind === "image" ? [node] : []), ...node.children.flatMap(images)];

const texts = (node: Node): string[] => [
  ...(node.kind === "text" ? [String(node.props.text)] : []),
  ...node.children.flatMap(texts),
];

interface RunOptions {
  family: string;
  parameter?: string;
  /** Response: body (a string or a value to JSON-encode) and status code. null means unreachable */
  response?: { status: number; body: unknown } | null;
  keychain?: Record<string, string>;
  cached?: string | null;
  now?: Date;
  /** Run in the app (settings screen): options to choose and inputs */
  app?: { menu?: number | number[]; form?: string[] };
  /** Advance the clock to this time while waiting for the fetch */
  advanceTo?: Date;
  /** Make Keychain.set and FileManager.writeString fail */
  keychainSetFails?: boolean;
  writeFails?: boolean;
  /** Make writes fail only for files whose name matches this */
  writeFailsFor?: RegExp;
  /** Called before returning the response (simulates settings changing during a fetch) */
  onLoad?: (keychain: Map<string, string>) => void;
  /** Called on every write (simulates another run interleaving) */
  onWrite?: (path: string, files: Map<string, string>) => void;
  removeFails?: boolean;
  keychainGetFails?: boolean;
  /** Place a previous view (string) as the file for the data number inside it. An array places several */
  cachedMany?: string[];
  /** Names of files whose contents don't matter (seen-number markers etc.) */
  extraFiles?: string[];
  /** Script to run (Headroom.js by default; e.g. a build with icons embedded) */
  code?: string;
  /** Device screen width (Device.screenSize; omit for no Device) */
  screen?: number;
  /** Image.fromData returns null (broken image) */
  badImage?: boolean;
  /** Response per URL (return undefined to use response) */
  responder?: (url: string) => { status: number; body: unknown } | undefined;
}

async function runWidget(opts: RunOptions) {
  const keychain = new Map(Object.entries(opts.keychain ?? { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" }));
  const sheets = Array.isArray(opts.app?.menu) ? [...opts.app!.menu] : [];
  const shownSizes: string[] = [];
  const files = new Map<string, string>();
  for (const c of [...(opts.cached ? [opts.cached] : []), ...(opts.cachedMany ?? [])]) {
    files.set(`/docs/${lib.cacheFileName(lib.cacheTag({ id: lib.DEFAULT_CONFIG_ID }, JSON.parse(c).origin), JSON.parse(c).view.data_version)}`, c);
  }
  for (const name of opts.extraFiles ?? []) files.set(`/docs/${name}`, "");
  const requests: any[] = [];
  let shown: any = null;
  class Color {
    hex: string;
    alpha: number;
    constructor(hex: string, alpha = 1) { this.hex = hex; this.alpha = alpha; }
    static dynamic(light: Color) { return Object.assign(new Color(light.hex), { dynamic: true }); }
  }
  const presented: any[] = [];
  const clock = { now: opts.now ?? NOW };
  const globals = {
    console, Intl, Math, JSON, encodeURIComponent, Number, String, Object, Boolean, structuredClone,
    Date: fixedDate(clock),
    config: { runsInWidget: !opts.app, widgetFamily: opts.family },
    args: { widgetParameter: opts.parameter ?? null },
    Script: { setWidget(w: any) { shown = w; }, complete() {} },
    // Scriptable also defines module (exports is an empty object) for every script. main must still run
    module: { exports: {} },
    Keychain: {
      contains: (k: string) => keychain.has(k),
      get: (k: string) => { if (opts.keychainGetFails) throw new Error("removed"); return keychain.get(k); },
      set: (k: string, v: string) => { if (opts.keychainSetFails) throw new Error("keychain"); keychain.set(k, v); },
      remove: (k: string) => keychain.delete(k),
    },
    Request: class {
      url: string;
      headers: Record<string, string> = {};
      timeoutInterval = 0;
      onRedirect: unknown = undefined;
      response: { statusCode: number } | null = null;
      constructor(url: string) { this.url = url; }
      async load() {
        requests.push(this);
        if (opts.advanceTo) clock.now = opts.advanceTo;
        opts.onLoad?.(keychain);
        const r = opts.responder?.(this.url) ?? (opts.response === undefined ? { status: 200, body: sampleView() } : opts.response);
        if (r === null) throw new Error("offline");
        this.response = { statusCode: r.status };
        const raw = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return { toRawString: () => raw };
      }
    },
    FileManager: {
      local: () => ({
        documentsDirectory: () => "/docs",
        joinPath: (a: string, b: string) => `${a}/${b}`,
        writeString: (p: string, s: string) => {
          if (opts.writeFails || opts.writeFailsFor?.test(p)) throw new Error("disk");
          files.set(p, s);
          opts.onWrite?.(p, files);
        },
        readString: (p: string) => files.get(p),
        fileExists: (p: string) => files.has(p),
        remove: (p: string) => { if (opts.removeFails) throw new Error("disk"); files.delete(p); },
        listContents: (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
      }),
    },
    ListWidget: class {
      constructor() {
        const root = makeStack("widget");
        return Object.assign(root, {
          refreshAfterDate: null,
          async presentSmall() { shown = root; shownSizes.push("small"); },
          async presentMedium() { shown = root; shownSizes.push("medium"); },
          async presentLarge() { shown = root; shownSizes.push("large"); },
        });
      }
    },
    DrawContext: class {
      size: unknown; opaque = true; respectScreenScale = false; fills: unknown[] = []; strokes = 0; widths: number[] = [];
      addPath() {} setFillColor(c: unknown) { this.fills.push(c); } fillPath() {}
      setStrokeColor() {} setLineWidth(w: number) { this.widths.push(w); } strokePath() { this.strokes++; } fillEllipse() {}
      strokeEllipse() { this.ellipses++; } ellipses = 0; drawn: any[] = []; drawImageInRect(img: any) { this.drawn.push(img); }
      texts: string[] = []; setFont() {} setTextColor() {} setTextAlignedCenter() {} drawTextInRect(text: string) { this.texts.push(text); }
      getImage() { return { fills: this.fills, strokes: this.strokes, size: this.size, widths: this.widths, ellipses: this.ellipses, icon: this.drawn[0], texts: this.texts }; }
    },
    Size: class { w: number; h: number; constructor(w: number, h: number) { this.w = w; this.h = h; } },
    Rect: class { x: number; y: number; w: number; h: number; constructor(x: number, y: number, w: number, h: number) { this.x = x; this.y = y; this.w = w; this.h = h; } },
    Path: class { addRoundedRect() {} move() {} addLine() {} addQuadCurve() {} closeSubpath() {} },
    Point: class { x: number; y: number; constructor(x: number, y: number) { this.x = x; this.y = y; } },
    Color,
    Font: new Proxy({}, { get: (_t, name) => {
      if (typeof name !== "string" || !SCRIPTABLE_FONTS.has(name)) throw new TypeError(`Font.${String(name)} is not a function`);
      return (size?: number) => ({ name, size });
    } }),
    SFSymbol: { named: (name: string) => ({ image: { symbol: name } }) },
    ...(opts.screen ? { Device: { screenSize: () => ({ width: opts.screen, height: ({ 430: 932, 393: 852, 390: 844, 375: 812, 320: 568 } as Record<number, number>)[opts.screen!] ?? 900 }) } } : {}),
    Data: { fromBase64String: (s: string) => ({ base64: s }) },
    Image: { fromData: (d: { base64: string }) => (opts.badImage ? null : { data: d.base64 }) },
    Alert: class {
      title = ""; message = "";
      fields: string[] = [];
      addAction() {} addDestructiveAction() {} addCancelAction() {}
      addTextField() { this.fields.push(""); } addSecureTextField() { this.fields.push(""); }
      async presentSheet() {
        presented.push("menu");
        // A number picks the same option every time; an array picks in order (Cancel once exhausted)
        return Array.isArray(opts.app?.menu) ? (sheets.shift() ?? -1) : opts.app?.menu ?? 0;
      }
      async present() { presented.push(this.fields.length ? "form" : "notice"); return 0; }
      textFieldValue(i: number) { return opts.app?.form?.[i] ?? ""; }
    },
  };
  const context = vm.createContext(globals);
  let error: unknown = null;
  try {
    await vm.runInContext(`(async () => {\n${opts.code ?? code}\n})()`, context);
  } catch (e) {
    error = e;
  }
  return { widget: shown, requests, files, keychain, presented, error, shownSizes };
}

test("Widget (medium): shows headings, usage, bars and reset timers, doesn't follow redirects, and saves the previous view with trimmed fields", async () => {
  const { widget, requests, files } = await runWidget({ family: "medium" });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/headroom\.example\.com\/v2\/view\?tz=/);
  assert.equal(requests[0].headers.Authorization, "Bearer read-token-xyz");
  assert.equal(typeof requests[0].onRedirect, "function");
  assert.equal(requests[0].onRedirect({}), null, "redirects are stopped");
  const all = texts(widget.node);
  // Claude and Codex groups showing remaining (Claude 5h 10% used -> 90%, Codex weekly 29% -> 71%)
  assert.ok(all.includes("Claude") && all.includes("Max") && all.includes("Codex") && all.includes("Pro Lite"), all.join(" | "));
  assert.equal(all[all.indexOf("5h limit", all.indexOf("Claude")) + 1], "90%");
  assert.ok(all.includes("71%"));
  assert.ok(all.includes("Not available"), "shows that Codex has no 5h limit");
  const bars = images(widget.node).filter((n) => n.props.fills);
  assert.ok(bars.length >= 4, "a bar per window plus an empty bar for the missing 5h");
  for (const img of bars) {
    for (const color of img.props.fills as any[]) assert.ok(!color.dynamic, "no dynamic colors passed to DrawContext");
  }
  assert.ok(bars.some((b) => (b.props.fills as any[]).some((c) => c.hex === lib.BRAND_COLORS.claude)), "Claude bars are orange");
  assert.ok(bars.some((b) => (b.props.fills as any[]).some((c) => c.hex === lib.BRAND_COLORS.codex)), "Codex bars are blue-violet");
  assert.deepEqual(images(widget.node).filter((n) => n.props.symbol === "asterisk" || n.props.symbol === "terminal").map((n) => n.props.symbol), ["terminal", "asterisk"], "icons (SF Symbols when none are embedded)");
  assert.ok(images(widget.node).some((n) => n.props.symbol === "arrow.clockwise"), "reset uses the ↻ symbol");
  assert.equal((JSON.stringify(widget.node).match(/"timer":true/g) ?? []).length, 1, "resets within 24 hours are timers (clock fixed)");
  assert.ok(all.some((x) => /^\w{3} \d{1,2}(:\d{2})? [AP]M$/.test(x)), "later ones are weekday and time (Fri 4 PM)");
  assert.ok(!all.some((x) => x.startsWith("Updated") || x.startsWith("Resets")), "less text (last update is a dot, reset is a symbol)");
  const saved = latestCache(files)!;
  assert.ok(saved && !saved.includes("read-token-xyz") && JSON.parse(saved).origin === "https://headroom.example.com");
});


test("When fetching fails, shows the same server's previous view with staleness and reset estimate at draw time", async () => {
  const clean = lib.sanitizeView(sampleView());
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: clean });
  // Can't connect at 16:30, after the 5-hour reset (16:00)
  const late = new Date("2026-11-16T16:30:00.000Z");
  const stale = await runWidget({ family: "medium", response: null, cached, now: late });
  const all = texts(stale.widget.node);
  const i = all.indexOf("5h limit", all.indexOf("Claude"));
  assert.equal(all[i + 1], "100%", "0% used after reset (estimated)");
  assert.ok(all.includes("Reset (est.)"));
  assert.ok(all.some((t) => /data from 3h 30m ago/.test(t)), all.join(" | "));
  const inline = await runWidget({ family: "accessoryInline", response: null, cached, now: late });
  assert.match(texts(inline.widget.node)[0]!, /^⚠︎ /, "the inline widget also shows the update failed");
  const otherOrigin = await runWidget({ family: "medium", response: null, cached, keychain: { "headroom.url": "https://other.example", "headroom.token": "t" } });
  assert.deepEqual(texts(otherOrigin.widget.node), ["Can't reach the server"], "another server's previous values are not shown");
});

test("Distinguishes HTML 401, invalid 200 and unreachable, without showing bodies or credentials", async () => {
  const html = await runWidget({ family: "medium", response: { status: 403, body: "<html>Forbidden by Access</html>" } });
  assert.deepEqual(texts(html.widget.node), ["Check your credentials"]);
  const bad = await runWidget({ family: "medium", response: { status: 200, body: { hello: "world" } } });
  assert.deepEqual(texts(bad.widget.node), ["Couldn't read the response"]);
  assert.equal(bad.files.size, 0, "unreadable responses are not saved");
  const offline = await runWidget({ family: "medium", response: null });
  assert.deepEqual(texts(offline.widget.node), ["Can't reach the server"]);
  const unset = await runWidget({ family: "medium", keychain: {} });
  assert.deepEqual(texts(unset.widget.node), ["Run in Scriptable to set up"]);
  assert.equal(unset.requests.length, 0, "no request without settings");
});

test("When setting up again, older Access items are deleted, and changing the server deletes the previous view", async () => {
  const keychain = {
    "headroom.url": "https://old.example", "headroom.token": "old-token",
    "headroom.access_id": "old-id", "headroom.access_secret": "old-secret",
  };
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://old.example", view: lib.sanitizeView(sampleView()) });
  const run = await runWidget({ family: "medium", keychain, cached, app: { menu: 2, form: ["https://new.example", "new-token"] } });
  const saved = JSON.parse(run.keychain.get("headroom.config")!);
  assert.deepEqual([saved.url, saved.token, "accessId" in saved], ["https://new.example", "new-token", false]);
  assert.deepEqual([...run.keychain.keys()].filter((k) => !k.startsWith("headroom.seen.")), ["headroom.config"], "older versions' separate items are not kept");
  assert.equal(run.requests[0].headers["CF-Access-Client-Id"], undefined, "no Access headers");
  assert.ok(!latestCache(run.files)?.includes("old.example"), "the old server's values are not kept");
  // An empty token is not saved (the previous settings remain)
  const empty = await runWidget({ family: "medium", keychain, app: { menu: 2, form: ["https://new.example", ""] } });
  assert.equal(empty.keychain.has("headroom.config"), false, "not saved when the token is empty");
  assert.equal(empty.keychain.get("headroom.url"), "https://old.example");
  // Delete settings
  const removed = await runWidget({ family: "medium", keychain, cached, app: { menu: 3 } });
  assert.equal(removed.keychain.size, 0);
  assert.equal(removed.files.size, 0);
});

test("A valid response with both providers null replaces the previous view; a malformed response doesn't overwrite it", async () => {
  assert.deepEqual(plain(lib.sanitizeView({ view_version: 1, data_version: 11, claude: null, codex: null })), { view_version: 1, data_version: 11, boundaries: null, claude: null, codex: null });
  assert.equal(lib.sanitizeView({ view_version: 1, data_version: 11, claude: { windows: [] }, codex: null }), null, "windows as an array is invalid");
  assert.equal(lib.sanitizeView({ view_version: 1, data_version: 11, claude: null }), null, "a missing provider key is invalid");
  assert.equal(lib.sanitizeView({ view_version: 1, claude: null, codex: null }), null, "a missing data number is invalid");
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView()) });
  const empty = await runWidget({ family: "medium", cached, response: { status: 200, body: { view_version: 1, data_version: 11, claude: null, codex: null } } });
  assert.deepEqual(texts(empty.widget.node), ["No data yet"]);
  // Even if the next fetch fails, the previous account's values (the view before replacement) don't come back
  const after = await runWidget({ family: "medium", cached: latestCache(empty.files)!, response: null });
  assert.ok(!texts(after.widget.node).includes("90%"));
  const bad = await runWidget({ family: "medium", cached, response: { status: 200, body: { view_version: 1, data_version: 11, claude: { windows: [] }, codex: null } } });
  assert.equal(latestCache(bad.files), cached, "malformed responses are not saved");
});

test("Settings are stored and read as a pair in one item; the widget never rewrites settings (older versions are only read)", async () => {
  const legacy = await runWidget({ family: "medium", keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" } });
  assert.deepEqual([...legacy.keychain.keys()].filter((k) => !k.startsWith("headroom.seen.")), ["headroom.url", "headroom.token"], "the widget doesn't migrate (no overlap with saving in the app)");
  assert.equal(legacy.requests[0].headers.Authorization, "Bearer read-token-xyz");
  const config = JSON.stringify({ url: "https://headroom.example.com", token: "tok-2", accessId: "id-2", accessSecret: "sec-2" });
  const run = await runWidget({ family: "medium", keychain: { "headroom.config": config } });
  assert.equal(run.requests[0].headers.Authorization, "Bearer tok-2");
  assert.equal(run.requests[0].headers["CF-Access-Client-Id"], undefined, "Access values saved by older versions are not used");
  const broken = await runWidget({ family: "medium", keychain: { "headroom.config": "{not json" } });
  assert.deepEqual(texts(broken.widget.node), ["Run in Scriptable to set up"]);
});

test("If a reset passes while waiting for the fetch, drawing uses the time after waiting: 0% (estimated) and no timer", async () => {
  const before = new Date("2026-11-16T15:59:50.000Z");
  const after = new Date("2026-11-16T16:00:30.000Z"); // after the 5-hour reset (16:00)
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView()) });
  const run = await runWidget({ family: "medium", response: null, cached, now: before, advanceTo: after });
  const all = texts(run.widget.node);
  assert.equal(all[all.indexOf("5h limit", all.indexOf("Claude")) + 1], "100%");
  const fiveHourTimer = JSON.stringify(run.widget.node).includes("2026-11-16T16:00:00.000Z");
  assert.equal(fiveHourTimer, false, "no timer for a passed reset");
});


test("Saving in the app writes the new item before deleting the old ones; if the write fails the old settings remain", async () => {
  const keychain = { "headroom.url": "https://old.example", "headroom.token": "old-token" };
  const saved = await runWidget({ family: "medium", keychain, app: { menu: 2, form: ["https://new.example", "new-token", "", ""] } });
  assert.deepEqual([...saved.keychain.keys()].filter((k) => !k.startsWith("headroom.seen.")), ["headroom.config"]);
  const failed = await runWidget({ family: "medium", keychain, keychainSetFails: true, app: { menu: 2, form: ["https://new.example", "new-token", "", ""] } });
  assert.ok(failed.error, "the write failed");
  // On failure the old items remain (not deleted before writing)
  assert.deepEqual([...failed.keychain.keys()].filter((k) => !k.startsWith("headroom.seen.")), ["headroom.url", "headroom.token"]);
});

test("The data number decides old vs new: an old response never restores a newer previous view, and values older than the seen number aren't shown even if saving or deleting fails", async () => {
  const newer = { ...lib.sanitizeView(sampleView(12)) };
  newer.claude = null; // view after a switch, with the previous account's values removed (number 12)
  const cachedNewer = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: newer });
  // A response that read the earlier value (number 10) arrives late
  const delayed = await runWidget({ family: "medium", cached: cachedNewer });
  assert.ok(!texts(delayed.widget.node).includes("90%"), "the previous account's values from the old response are not shown");
  assert.deepEqual([...delayed.files.keys()], [`/docs/${lib.cacheFileName(TAG, 12)}`], "old responses are not saved");
  // A response older than the seen number (marker file) is not shown even without a previous view
  const seen = await runWidget({ family: "medium", extraFiles: [lib.seenFileName(TAG, 12)] });
  assert.deepEqual(texts(seen.widget.node), ["Response is older than the last one"]);
  // The marker for a new response (number 20) was created, but saving the previous view and deleting old files failed: the next outage must not show old values
  const oldCache = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView(10)) });
  const emptyResponse = { status: 200, body: { view_version: 1, data_version: 20, claude: null, codex: null } };
  const failed = await runWidget({ family: "medium", cached: oldCache, response: emptyResponse, writeFailsFor: /headroom-view-/, removeFails: true });
  const names = [...failed.files.keys()].map((p) => p.split("/").pop()!);
  assert.ok(names.includes(lib.seenFileName(TAG, 20)), names.join(","));
  assert.ok(names.includes(lib.cacheFileName(TAG, 10)), "the old file that couldn't be deleted remains");
  const next = await runWidget({ family: "medium", cached: oldCache, response: null, extraFiles: [lib.seenFileName(TAG, 20)] });
  assert.deepEqual(texts(next.widget.node), ["Can't reach the server"], "previous views older than the seen number are not shown");
  // Neither can the marker be created nor old files deleted (device storage unusable): the previous view shows as "can't update" with a staleness mark (accepted limitation)
  const broken = await runWidget({ family: "medium", cached: oldCache, response: emptyResponse, writeFails: true, removeFails: true });
  assert.ok(![...broken.files.keys()].some((p) => p.includes("headroom-seen-")));
  // If two runs overlap and an older number's file is written later, the highest-numbered file is still used
  const older = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView(9)) });
  const both = await runWidget({ family: "medium", cachedMany: [cachedNewer, older], response: null });
  assert.ok(!texts(both.widget.node).includes("90%"), "number 12 (previous account's values removed) is used");
});

test("The window list matches the windows without duplicates, and the overall-limit list matches the windows with null scope", () => {
  const view = sampleView() as any;
  const dup = structuredClone(view);
  dup.claude.window_ids = "five_hour,five_hour,seven_day";
  assert.equal(lib.sanitizeView(dup), null);
  const scoped = structuredClone(view);
  scoped.claude.main_window_ids = "five_hour,seven_day,seven_day_fable";
  assert.equal(lib.sanitizeView(scoped), null, "a scoped limit in the overall-limit list");
  const missing = structuredClone(view);
  missing.claude.main_window_ids = "five_hour";
  assert.equal(lib.sanitizeView(missing), null, "an overall limit is missing");
});

test("If older-version settings are deleted mid-read, treat it as no settings and still draw", async () => {
  const run = await runWidget({ family: "medium", keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "t" }, keychainGetFails: true });
  assert.equal(run.error, null);
  assert.deepEqual(texts(run.widget.node), ["Run in Scriptable to set up"]);
});

test("A response with an invalid window or a mismatch with the window list is invalid as a whole, not just that window", () => {
  const view = sampleView() as any;
  const badWindow = structuredClone(view);
  badWindow.codex.windows.seven_day.used_percent = "29";
  assert.equal(lib.sanitizeView(badWindow), null);
  const mismatch = structuredClone(view);
  mismatch.claude.main_window_ids = "five_hour,missing";
  assert.equal(lib.sanitizeView(mismatch), null);
  assert.ok(lib.sanitizeView(view));
});

test("The seen number lives only in marker files; they are only created and higher numbers never deleted, so overlapping runs can't go backwards", () => {
  assert.equal(lib.seenFrom([lib.seenFileName(TAG, 20), lib.seenFileName(TAG, 10)], TAG), 20);
  assert.equal(lib.seenFrom([lib.seenFileName(lib.cacheTag({}, "https://other.example"), 99)], TAG), 0, "another server's markers are not counted");
  assert.equal(lib.pickCache([lib.cacheFileName(TAG, 10), lib.cacheFileName(TAG, 30)], TAG, 20).version, 30);
  assert.equal(lib.pickCache([lib.cacheFileName(TAG, 10)], TAG, 20), null);
});

test("When a number-10 run and a number-20 run overlap, the 20 marker remains and the next outage doesn't show 10", async () => {
  const ten = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView(10)) });
  // State where the number-20 run created its marker, then the number-10 run (having compared before seeing 20) wrote its 10 marker and previous view
  const run = await runWidget({ family: "medium", cachedMany: [ten], response: null, extraFiles: [lib.seenFileName(TAG, 20), lib.seenFileName(TAG, 10)] });
  assert.deepEqual(texts(run.widget.node), ["Can't reach the server"], "the number-10 previous view is not shown");
});

test("Numbers and previous views are per server (the tag is the origin itself, so it never equals another server's)", async () => {
  assert.notEqual(lib.originTag("https://fixture-12v660y.test"), lib.originTag("https://fixture-17y1c4a.test"));
  const oldOrigin = "https://old.example";
  const run = await runWidget({ family: "medium", response: { status: 200, body: sampleView(1) }, extraFiles: [lib.seenFileName(lib.cacheTag({}, oldOrigin), 100)] });
  assert.ok(texts(run.widget.node).includes("5h limit"), "number 1 of the new server is used");
  assert.ok(run.files.has(`/docs/${lib.seenFileName(TAG, 1)}`));
});

test("Deleting settings removes only Headroom's files (user scripts with the same prefix remain); the seen number is cleared so a recreated server's number 1 works", async () => {
  const keychain = { "headroom.config": JSON.stringify({ url: "https://headroom.example.com", token: "t", accessId: "", accessSecret: "" }) };
  const own = [lib.seenFileName(TAG, 100), lib.cacheFileName(TAG, 100), "headroom-view.json"];
  const user = ["headroom-notes.js", "headroom-view-backup.json", "headroom-seen-mine.txt"];
  const removed = await runWidget({ family: "medium", keychain, extraFiles: [...own, ...user], app: { menu: 3 } });
  assert.deepEqual([...removed.files.keys()].map((p) => p.split("/").pop()).sort(), [...user].sort());
  for (const name of user) assert.equal(lib.OWN_FILE.test(name), false, name);
  // Register the same URL again (D1 recreated, numbers start from 1)
  const again = await runWidget({ family: "medium", keychain, extraFiles: user, response: { status: 200, body: sampleView(1) } });
  assert.ok(texts(again.widget.node).includes("5h limit"));
});

test("If another run saves a newer number after the comparison, this run draws the newer one instead of the old response", async () => {
  const newer = { ...lib.sanitizeView(sampleView(20)) };
  newer.claude = null;
  const newerText = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: newer });
  let injected = false;
  const run = await runWidget({
    family: "medium",
    response: { status: 200, body: sampleView(10) },
    onWrite: (_p, files) => {
      if (injected) return;
      injected = true;
      // While number 10 was being saved, another run saved the number-20 marker and view
      files.set(`/docs/${lib.seenFileName(TAG, 20)}`, "");
      files.set(`/docs/${lib.cacheFileName(TAG, 20)}`, newerText);
    },
  });
  assert.equal(injected, true);
  assert.ok(!texts(run.widget.node).includes("90%"), "number 10 (previous account's values) is not drawn");
});

test("Re-saving settings changes the generation, so numbers from fetches started earlier don't affect the new settings", async () => {
  const id = "abcdef0123456789";
  const keychain = { "headroom.config": JSON.stringify({ url: "https://headroom.example.com", token: "t", accessId: "", accessSecret: "", id }) };
  // The previous generation (a fetch started before the settings were deleted) left a number-100 marker
  const run = await runWidget({ family: "medium", keychain, response: { status: 200, body: sampleView(1) }, extraFiles: [lib.seenFileName(TAG, 100)] });
  assert.ok(texts(run.widget.node).includes("5h limit"), "number 1 of the new generation is used");
  assert.ok(run.files.has(`/docs/${lib.seenFileName(lib.cacheTag({ id }, "https://headroom.example.com"), 1)}`));
  // Every save in the app makes a new generation
  const saved = await runWidget({ family: "medium", keychain, app: { menu: 2, form: ["https://headroom.example.com", "t", "", ""] } });
  const newId = JSON.parse(saved.keychain.get("headroom.config")!).id;
  assert.match(newId, /^[0-9a-f]{16}$/);
  assert.notEqual(newId, id);
});

test("If settings are deleted or re-saved during a fetch, the old settings' values are not drawn", async () => {
  const config = (id: string) => JSON.stringify({ url: "https://headroom.example.com", token: "t", accessId: "", accessSecret: "", id });
  const keychain = { "headroom.config": config("1111111111111111") };
  const removed = await runWidget({ family: "medium", keychain, onLoad: (k) => k.delete("headroom.config") });
  assert.deepEqual(texts(removed.widget.node), ["Settings changed. Updates on next refresh"]);
  const replaced = await runWidget({ family: "medium", keychain, onLoad: (k) => k.set("headroom.config", config("2222222222222222")) });
  assert.deepEqual(texts(replaced.widget.node), ["Settings changed. Updates on next refresh"]);
  // A fetch after re-registering can use number 1 under the new generation
  const next = await runWidget({ family: "medium", keychain: { "headroom.config": config("2222222222222222") }, response: { status: 200, body: sampleView(1) },
    extraFiles: [lib.seenFileName(lib.cacheTag({ id: "1111111111111111" }, "https://headroom.example.com"), 100)] });
  assert.ok(texts(next.widget.node).includes("5h limit"));
  const unchanged = await runWidget({ family: "medium", keychain });
  assert.ok(texts(unchanged.widget.node).includes("5h limit"), "drawn if unchanged");
});


test("Shows there is no 5h limit only for providers whose values were fetched; not when fetching failed or windows are named", async () => {
  const groups = (v: unknown, param = "") => plain(lib.groupsOf(lib.sanitizeView(v), param, NOW));
  const view = sampleView();
  const codex = groups(view).find((g: any) => g.provider === "codex");
  assert.deepEqual(codex.rows[0], { kind: "missing", text: "Not available" });
  assert.equal(groups(view).find((g: any) => g.provider === "claude").rows[0].window.id, "five_hour", "Claude has a 5h limit");
  const failed = structuredClone(view);
  failed.codex!.status = "error";
  assert.ok(!JSON.stringify(groups(failed)).includes("Not available"), "doesn't claim it's missing when fetching failed");
  assert.ok(!JSON.stringify(groups(view, "top")).includes("Not available"));
  assert.ok(!JSON.stringify(groups(view, "codex.seven_day")).includes("Not available"));
  assert.ok(JSON.stringify(groups(view, "codex")).includes("Not available"));
  // Shown in the small widget too
  const small = await runWidget({ family: "small" });
  const st = texts(small.widget.node);
  const i = st.indexOf("5h limit", st.indexOf("Codex"));
  assert.ok(i >= 0 && st[i + 1] === "—", st.join(" | "));
});

test("Headings are English, built from window length and scope; a missing provider value shows the reason", () => {
  const label = (w: object) => lib.limitLabel({ scope: null, ...w });
  assert.equal(label({ id: "five_hour" }), "5h limit");
  assert.equal(label({ id: "seven_day" }), "Weekly limit");
  assert.equal(label({ id: "seven_day_fable", scope: "Fable" }), "Fable weekly", "scoped limits are short");
  assert.equal(label({ id: "codex_other_seven_day", scope: "codex_other" }), "Other weekly");
  assert.equal(label({ id: "window_90m" }), "90m limit");
  assert.equal(label({ id: "window_1440m" }), "1d limit");
  assert.equal(lib.shortName({ id: "seven_day", scope: null }), "Wk");
  assert.equal(lib.percentText({ used_percent: 100, remaining_percent_int: 0 }), "0%");
  const view = sampleView() as any;
  view.claude = null;
  view.codex.windows = {};
  view.codex.window_ids = "";
  view.codex.main_window_ids = "";
  view.codex.status = "error";
  view.codex.error_code = "login_required";
  const groups = plain(lib.groupsOf(lib.sanitizeView(view), "", NOW));
  assert.deepEqual(groups.map((g: any) => g.message), ["Sign in required", "No data"]);
});


test("Large stacks full-width groups top to bottom (no confidence row); small packs two providers (no timers)", async () => {
  const large = await runWidget({ family: "large", now: new Date("2026-11-16T13:30:00.000Z") });
  const l = texts(large.widget.node);
  assert.ok(!l.some((t) => t.includes("Recent:") || t.includes("Forecast:")), l.join(" | "));
  assert.ok(l.includes("32m"), `when old, the header dot shows the time since the oldest fetch among the shown limits:${l.join(" | ")}`);
  assert.equal(large.widget.node.children.some((c: Node) => c.kind === "stack" && c.children.filter((x) => x.kind === "stack").length === 2 && texts(c).includes("Claude") && texts(c).includes("Codex")), false, "not two side-by-side columns");
  const small = await runWidget({ family: "small" });
  const all = texts(small.widget.node);
  assert.ok(all.includes("Claude") && all.includes("Codex") && all.includes("90%"));
  assert.equal(JSON.stringify(small.widget.node).includes('"timer":true'), false);
});

test("Icons: there is a line for scripts/build.ts to embed into, and embedded images are used when present", async () => {
  const marker = /^const ICONS = \{ claude: "", codex: "" \}; \/\/ @icons$/m;
  assert.ok(marker.test(code), "the line build.ts replaces");
  const embedded = code.replace(marker, () => `const ICONS = {"claude":"QUJD","codex":""};`);
  const run = await runWidget({ family: "medium", code: embedded });
  const icons = images(run.widget.node).filter((n) => n.props.data || n.props.symbol);
  assert.deepEqual(icons.filter((n) => n.props.symbol !== "arrow.clockwise").map((n) => n.props.data ?? n.props.symbol), ["terminal", "QUJD"], "Claude uses the embedded image, Codex SF Symbols");
});

test("Bar joins: the previous piece's right end is rounded and the next piece's left end is concave along it (neither is a vertical line)", () => {
  const ops = (...a: unknown[]) => plain(lib.segmentShape(...a)) as unknown[][];
  // Color (0-60): both ends rounded. The right end is the 57-60 curve
  const color = ops(0, 60, 6, 3, 3, false);
  assert.ok(color.some((o) => o[0] === "quad" && o[1] === 60 && o[2] === 3), "right end is rounded");
  assert.ok(color.some((o) => o[0] === "quad" && o[1] === 0), "left end (bar start) is rounded");
  assert.ok(!color.some((o) => o[0] === "line" && o[1] === 60), "no vertical line at the right end");
  // Gray (60-70): the left end is concave along the color's curve (57-60). Same curve (control point on the vertical line x = 60)
  const gray = ops(60, 10, 6, 3, 3, true);
  assert.deepEqual(gray[0], ["move", 57, 0], "starts at the base of the color's curve");
  const colorCap = color.filter((o) => o[0] === "quad" && (o[1] === 60 || o[3] === 60));
  const grayCap = gray.filter((o) => o[0] === "quad" && o[3] === 60);
  assert.deepEqual(grayCap.map((o) => [o[3], o[4]]).sort(), colorCap.map((o) => [o[3], o[4]]).sort(), "same control points (no gap or overlap)");
  assert.ok(!gray.some((o) => o[0] === "line" && o[1] === 60), "no vertical line at the left end");
  assert.ok(gray.some((o) => o[0] === "quad" && o[1] === 70), "right end is rounded");
});

test("Medium: a column without a 5h limit has the same row layout as the other (heading, bar, reset row)", async () => {
  const run = await runWidget({ family: "medium" });
  const cols = columnsOf(run.widget.node);
  assert.equal(cols.length, 2, "Claude and Codex columns");
  const shape = (col: Node) => col.children.map((c) => c.kind);
  assert.deepEqual(shape(cols[1]!), shape(cols[0]!), "rows line up");
  assert.ok(texts(cols[0]!).includes("Not available"));
});

/** A view where Codex's weekly limit will likely run out before reset (forecast shown) */
function forecastView() {
  const view = sampleView();
  const w = view.codex!.windows.seven_day! as any;
  Object.assign(w, { confidence: "high", reset_first: false, eta_at: "2026-11-16T15:10:00.000Z", eta_minutes: 131, rate_24h: 33, rate_pace: 33 });
  const c = view.claude!.windows.five_hour! as any;
  Object.assign(c, { confidence: "medium", reset_first: true, eta_at: "2026-11-16T20:00:00.000Z", eta_minutes: 420, rate_60m: 0.42, rate_pace: null });
  return view;
}

test("Consumption rate text", () => {
  assert.equal(lib.paceText({ id: "five_hour", confidence: "high", rate_60m: 6, rate_24h: 1 }), "6%/h");
  assert.equal(lib.paceText({ id: "five_hour", confidence: "high", rate_60m: 0.42, rate_24h: 1 }), "0.4%/h");
  assert.equal(lib.paceText({ id: "seven_day", confidence: "high", rate_60m: 9, rate_24h: 12.4 }), "12%/h");
  assert.equal(lib.paceText({ id: "seven_day", confidence: "insufficient", rate_24h: 3 }), null);
});

test("7-day weekly trend: validates the response and splits lines at each break", () => {
  const ok = { provider: "claude", since: null, windows: { seven_day: [
    { at: "2026-11-16T11:00:00.000Z", used_percent: 10, resets_at: null, break: null },
    { at: "2026-11-16T12:00:00.000Z", used_percent: 20, resets_at: null, break: null },
    { at: "2026-11-16T12:30:00.000Z", used_percent: 2, resets_at: null, break: "reset" },
    { at: "2026-11-09T10:00:00.000Z", used_percent: 50, resets_at: null, break: null },
  ] } };
  const points = plain(lib.sanitizeHistory(ok, "claude", "seven_day", NOW));
  assert.equal(points.length, 3, "points older than 7 days are dropped (default is the weekly limit's 7 days)");
  assert.equal(lib.sanitizeHistory({ ...ok, provider: "codex" }, "claude", "seven_day", NOW), null, "a response for another provider is not used");
  assert.equal(lib.sanitizeHistory({ ...ok, windows: { seven_day: [{ at: "x", used_percent: 1 }] } }, "claude", "seven_day", NOW), null);
  assert.equal(lib.sanitizeHistory({ ...ok, windows: { seven_day: [{ at: "2026-11-16T12:00:00.000Z", used_percent: 120 }] } }, "claude", "seven_day", NOW), null);
  assert.deepEqual(plain(lib.sanitizeHistory(ok, "claude", "five_hour", NOW)), [], "empty when that window has no points");
  const lines = plain(lib.sparkLines(points, NOW, 100, 20));
  assert.equal(lines.length, 2, "lines split at a reset");
  assert.deepEqual(lines[0][1], [99.4, 15.1], "12:00 (167/168 of 7 days; default is the weekly limit's 7 days), 20% (inside the 1.5 margin top and bottom)");
});

test("Per-size content: small is compact with one forecast; medium adds reset, marks, forecast and last update; large also adds rate, scoped limits and trend", async () => {
  const later = new Date("2026-11-16T13:05:00.000Z");
  const small = await runWidget({ family: "small", response: { status: 200, body: forecastView() }, now: later });
  const s = texts(small.widget.node);
  assert.ok(!s.some((x) => x.startsWith("Resets")) && !s.includes("Max") && !s.some((x) => x.startsWith("Updated")), s.join(" | "));
  assert.ok(!s.some((x) => /runs out|Runs out|[AP]M/.test(x)), "small doesn't show the run-out time");
  assert.ok(s.includes(`${lib.WARN_MARK} 71%`), "small puts ⚠️ on the remaining number of a limit likely to run out");

  const medium = await runWidget({ family: "medium", response: { status: 200, body: forecastView() }, now: later });
  const m = texts(medium.widget.node);
  assert.ok(m.includes("Max") && images(medium.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), m.join(" | "));
  assert.equal(images(medium.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn).length, 1, "only limits likely to run out replace the reset time with ⚠ and the run-out time");
  assert.ok(!m.some((x) => x.startsWith("⚠")), "no ⚠ on the remaining number (medium, large)");
  assert.ok(!m.some((x) => x.startsWith("Updated") || x === "Lasts until reset"), "less text");
  assert.ok(!m.some((x) => x.includes("%/h")), "medium doesn't show the rate");
  assert.ok(!m.includes("Fable weekly"), "medium shows scoped limits only at 100%");

  const history = (url: string) => {
    if (!url.includes("/v2/history")) return undefined;
    const provider = new URL(url).searchParams.get("provider")!;
    const window = new URL(url).searchParams.get("window")!;
    return { status: 200, body: { provider, since: null, boundary: "#0", windows: { [window]: [
      { at: "2026-11-16T10:00:00.000Z", used_percent: 3, resets_at: null, break: null },
      { at: "2026-11-16T12:00:00.000Z", used_percent: 8, resets_at: null, break: null },
    ] } } };
  };
  const large = await runWidget({ family: "large", response: { status: 200, body: forecastView() }, responder: history, now: later });
  const l = texts(large.widget.node);
  assert.ok(l.some((x) => x.includes("%/h")), l.join(" | "));
  assert.ok(l.includes("Fable weekly"), "large always shows scoped limits");
  assert.ok(l.includes("This week · Weekly") && l.includes("Claude") && l.includes("Codex"), l.join(" | "));
  const asked = large.requests.map((r: any) => r.url).filter((u: string) => u.includes("/v2/history")).map((u: string) => new URL(u).searchParams.get("window"));
  assert.deepEqual(asked, ["seven_day", "seven_day"], "Claude and Codex overlay the same weekly trend (Codex has no 5h)");
  const urls = large.requests.map((r: any) => r.url);
  assert.deepEqual(urls.filter((u: string) => u.includes("/v2/history")).map((u: string) => new URL(u).search),
    ["?provider=codex&window=seven_day&hours=170", "?provider=claude&window=seven_day&hours=170"]);
  for (const r of large.requests) assert.equal(r.onRedirect({}), null, "trend requests don't follow redirects either");
  assert.ok(images(large.widget.node).some((n) => (n.props.strokes as number) > 0), "draws the polyline");
  // Other display continues even if the trend can't be read
  const failed = await runWidget({ family: "large", response: { status: 200, body: forecastView() }, responder: (u) => (u.includes("/v2/history") ? { status: 500, body: "" } : undefined), now: later });
  assert.ok(texts(failed.widget.node).includes("5h limit") && texts(failed.widget.node).includes("No weekly data yet"));
  // Medium doesn't read the trend (one request)
  assert.equal(medium.requests.length, 1);
});

test("Dimensions: the widget size comes from the screen width, with even padding on all sides", async () => {
  assert.deepEqual(plain(lib.widgetSize("medium", { width: 393, height: 852 })), { width: 338, height: 158 });
  assert.deepEqual(plain(lib.widgetSize("large", { width: 375, height: 812 })), { width: 329, height: 345 });
  assert.deepEqual(plain(lib.widgetSize("medium", { width: 375, height: 667 })), { width: 321, height: 148 }, "same width, chosen by height");
  assert.deepEqual(plain(lib.widgetSize("medium", { width: 736, height: 414 })), { width: 348, height: 157 }, "same in landscape");
  assert.deepEqual(plain(lib.widgetSize("small", { width: 440, height: 956 })), { width: 170, height: 170 }, "a screen not in the table uses the largest row with width and height at most the screen's");
  assert.deepEqual(plain(lib.widgetSize("medium", { width: 402, height: 874 })), { width: 338, height: 158 });
  assert.deepEqual(plain(lib.widgetSize("medium", null)), { width: 338, height: 158 }, "the 390×844 row when unknown");
  for (const family of ["small", "medium", "large"]) {
    const run = await runWidget({ family, screen: 430 });
    const [top, left, bottom, right] = run.widget.node.props.padding as number[];
    assert.ok(top === left && left === bottom && bottom === right, `${family}: ${run.widget.node.props.padding}`);
  }
});

test("Medium: column width is half the inner width and bars match it (not shifted left on large screens)", async () => {
  const run = await runWidget({ family: "medium", screen: 430 });
  const pad = lib.PADDING.medium;
  const colWidth = Math.floor((364 - 2 * pad - 14) / 2);
  const cols = columnsOf(run.widget.node);
  assert.deepEqual(cols.map((c: Node) => plain(c.props.size)), [{ w: colWidth, h: 0 }, { w: colWidth, h: 0 }]);
  const bars = images(run.widget.node).filter((n) => n.props.fills && (n.props.size as any)?.h === lib.SCALES.medium.bar);
  assert.ok(bars.length >= 4 && bars.every((b) => (b.props.size as any).w === colWidth), JSON.stringify(bars.map((b) => b.props.size)));
});

test("Small: content is centered (even padding) with a fixed gap between Claude and Codex. Large shows the missing 5h limit in the same form as other limits", async () => {
  const small = await runWidget({ family: "small" });
  const kids = small.widget.node.children;
  assert.deepEqual(kids.map((c: Node) => (c.kind === "spacer" ? `spacer:${c.props.length ?? "flex"}` : c.kind)), ["spacer:flex", "stack", "spacer:2", "spacer:flex"], "centered vertically with flexible spacers (visual center lifted 2pt)");
  const page = kids[1]!;
  assert.deepEqual(page.children.map((c: Node) => (c.kind === "spacer" ? `spacer:${c.props.length ?? "flex"}` : c.kind)), ["spacer:flex", "stack", "spacer:flex"], "centered horizontally too");
  const body = page.children[1]!;
  assert.equal((body.props.size as any).w, 158 - 2 * lib.PADDING.small, "inner width (the 390 row when the screen width is unknown)");
  const gapIndex = body.children.findIndex((c: Node) => c.kind === "spacer" && c.props.length === 8);
  assert.ok(gapIndex > 0 && texts({ kind: "x", children: body.children.slice(0, gapIndex), props: {} } as Node).includes("Codex"));
  assert.ok(texts({ kind: "x", children: body.children.slice(gapIndex), props: {} } as Node).includes("Claude"));
  const large = await runWidget({ family: "large" });
  const l = texts(large.widget.node);
  const i = l.indexOf("Codex");
  assert.deepEqual(l.slice(i, l.indexOf("Claude")).filter((x) => ["5h limit", "—", "Not available"].includes(x)), ["5h limit", "—", "Not available"], l.join(" | "));
});

test("When the bar's gray is too thin, it gets a minimum width so the rounded end doesn't hide it", () => {
  assert.deepEqual(plain(lib.drawnJunction(100, 101, 6)), { remainingEnd: 100, recentEnd: 104 }, "1pt of gray becomes radius + 1pt (4pt), extending right (the used side) first");
  assert.deepEqual(plain(lib.drawnJunction(100, 101, 6, 102)), { remainingEnd: 98, recentEnd: 102 }, "extends left by what the right end can't fit");
  assert.deepEqual(plain(lib.drawnJunction(1.3, 1.4, 8, 132)), { remainingEnd: 1.3, recentEnd: 6.3 }, "color isn't erased even at 1% remaining");
  assert.deepEqual(plain(lib.drawnJunction(100, 110, 6)), { remainingEnd: 100, recentEnd: 110 }, "unchanged when wide enough");
  assert.deepEqual(plain(lib.drawnJunction(100, 100, 6)), { remainingEnd: 100, recentEnd: 100 }, "unchanged when there is no gray");
  assert.deepEqual(plain(lib.drawnJunction(0, 1, 6)), { remainingEnd: 0, recentEnd: 4 }, "extends right at the start of the bar");
});

test("Medium: freshness dots are inside the content frame too. Large: two column frames and a full-width overlaid chart", async () => {
  const medium = await runWidget({ family: "medium", screen: 430 });
  const body = findStack(medium.widget.node, (n) => (n.props.size as any)?.w === 364 - 2 * lib.PADDING.medium)!;
  assert.ok(body, "frame fixed to the inner width");
  assert.ok(images(body).filter((n) => (n.props.size as any)?.w === 6).length === 2, "freshness dots (per provider) are inside the frame");
  const history = (url: string) => {
    if (!url.includes("/v2/history")) return undefined;
    const q = new URL(url).searchParams;
    return { status: 200, body: { provider: q.get("provider"), since: null, boundary: "#0", windows: { [q.get("window")!]: [
      { at: "2026-11-16T10:00:00.000Z", used_percent: 3, resets_at: null, break: null },
      { at: "2026-11-16T12:00:00.000Z", used_percent: 8, resets_at: null, break: null },
    ] } } };
  };
  const large = await runWidget({ family: "large", response: { status: 200, body: forecastView() }, responder: history, now: new Date("2026-11-16T13:05:00.000Z") });
  const inner = 338 - 2 * lib.PADDING.large;
  const cols = columnsOf(large.widget.node);
  assert.equal(cols.length, 2, "large also puts Claude and Codex side by side");
  assert.ok(texts(cols[0]!).includes("5h limit") && texts(cols[1]!).includes("Weekly limit"));
  const chart = images(large.widget.node).find((n) => (n.props.size as any)?.w === inner && (n.props.strokes as number) > 0);
  assert.ok(chart, "lines are drawn in one full-width chart");
  assert.ok((chart!.props.strokes as number) >= 2 + 3, "two lines (plus guide lines) are overlaid");
  assert.ok(images(large.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), "Codex's weekly limit shows the run-out time");
});

test("Forecast in the bar: the amount likely used before reset is lighter, the same even if it will run out; pieces meet with a curve and a concave edge", () => {
  const NOW_MS = NOW.getTime();
  const iso = (m: number) => new Date(NOW_MS + m * 60000).toISOString();
  const w = { id: "five_hour", used_percent: 40, reset_passed: false, confidence: "high", fetched_at: NOW.toISOString(), resets_at: iso(120), rate_60m: 15, rate_pace: 15 };
  assert.deepEqual(plain(lib.projectionOf(w, NOW)), { consume: 30, runsOut: false, at: null }, "of 60% remaining, 30 used by the reset (in 2 hours) at 15%/h");
  assert.equal(lib.projectionOf({ ...w, rate_pace: 60 }, NOW).runsOut, true);
  assert.deepEqual(plain(lib.projectionOf({ ...w, rate_pace: null }, NOW)), { consume: 0, runsOut: false, at: null }, "rate too small to measure");
  assert.equal(lib.projectionOf({ ...w, confidence: "low" }, NOW), null);
  const seg = { remaining: 0.6, recent: 0.1, faded: false, level: "brand", projected: 0.3, runsOut: false };
  const pieces = plain(lib.barPieces(seg, 100, 8, "#D97757"));
  assert.deepEqual(pieces.map((p: any) => [p.x, p.w, p.leftCap, p.rightCap, p.concaveLeft]), [[0, 30, 4, 4, false], [30, 30, 4, 4, true], [60, 10, 4, 4, true]],
    "every piece has a rounded right end; later pieces are concave along the previous curve");
  assert.ok(pieces[1].alpha < 1 && pieces[1].hex === "#D97757", "the likely-used part is the same color, lighter");
  const out = plain(lib.barPieces({ ...seg, runsOut: true, projected: 0.6 }, 100, 8, "#D97757"));
  assert.ok(out[0].hex === "#D97757" && out[0].alpha < 1, "even when it will run out, a lighter provider color (the bar doesn't convey warnings)");
});

test("Freshness dot, short reset and marks", () => {
  const view = lib.sanitizeView(sampleView());
  assert.deepEqual(plain(lib.freshnessOf(view, "claude", NOW)), { level: "fresh", text: "" });
  assert.deepEqual(plain(lib.freshnessOf(view, "claude", new Date("2026-11-16T13:30:00.000Z"))), { level: "stale", text: "32m" }, "from the oldest fetch among overall limits (12:58)");
  assert.equal(lib.freshnessOf(view, "claude", new Date("2026-11-16T15:30:00.000Z")).level, "old");
  assert.equal(lib.resetShort({ resets_at: "2026-11-16T15:00:00.000Z", reset_passed: false }, NOW).kind, "timer");
  assert.match(lib.resetShort({ resets_at: "2026-11-20T07:00:00.000Z", reset_passed: false }, NOW).text, /^Fri \d{1,2}(:\d{2})? [AP]M$/);
  assert.equal(lib.rowMark({ value_status: "stale", recent_quality: "approx" }), "", "staleness is shown by the dot; approximations get no mark");
  assert.equal(lib.rowMark({ value_status: "reset_estimated", recent_quality: "unknown" }), "est.");
});

test("Draws completely at every size and state without calling methods Scriptable doesn't have", async () => {
  const later = new Date("2026-11-16T13:05:00.000Z");
  for (const family of ["small", "medium", "large", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
    for (const body of [sampleView(), forecastView()]) {
      const run = await runWidget({ family, response: { status: 200, body }, now: later });
      assert.equal(run.error, null, `${family}: ${run.error}`);
      assert.ok(run.widget, family);
    }
  }
});

test("If another run saves a newer number while waiting for the trend, the old view and trend are not drawn", async () => {
  const newer = { ...lib.sanitizeView(sampleView(20)) };
  newer.claude = null;
  const newerText = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: newer });
  let injected = false;
  const run = await runWidget({
    family: "large",
    response: { status: 200, body: sampleView(10) },
    responder: (url) => {
      if (!url.includes("/v2/history")) return undefined;
      if (!injected) {
        injected = true;
        // During the trend request, another run saved the number-20 marker and view
        run2Files.set(`/docs/${lib.seenFileName(TAG, 20)}`, "");
        run2Files.set(`/docs/${lib.cacheFileName(TAG, 20)}`, newerText);
      }
      return { status: 500, body: "" };
    },
    onWrite: (_p, files) => { run2Files = files; },
  });
  assert.equal(injected, true);
  assert.ok(!texts(run.widget.node).includes("90%"), "number 10's Claude is not drawn");
});
let run2Files = new Map<string, string>();

test("When an old response leads to showing a newer previous view, the trend is not read", async () => {
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView(30)) });
  const run = await runWidget({ family: "large", cached, response: { status: 200, body: sampleView(10) } });
  assert.equal(run.requests.filter((r: any) => r.url.includes("/v2/history")).length, 0);
});

test("Even small adds est. to limits that are reset (estimated), and the header dot uses the oldest fetch among the shown limits", async () => {
  const view = sampleView();
  view.claude!.windows.five_hour!.fetched_at = "2026-11-16T15:35:00.000Z";
  view.claude!.windows.seven_day!.fetched_at = "2026-11-16T16:00:00.000Z";
  const run = await runWidget({ family: "small", response: { status: 200, body: view }, now: new Date("2026-11-16T16:01:00.000Z") });
  assert.ok(texts(run.widget.node).includes("100% · est."), texts(run.widget.node).join(" | "));
  assert.deepEqual(plain(lib.freshnessOf(lib.sanitizeView(view), "claude", new Date("2026-11-16T16:01:00.000Z"))), { level: "stale", text: "26m" });
});

test("The forecast uses Cron's rate and the remaining amount at draw time, from draw time until reset; not drawn after the run-out time passes", () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 16, h, m, 0)).toISOString();
  // After Cron computed 15%/h, 70% used was received at 10:05 in the same cycle. 13.75 over the 55 minutes until the 11:00 reset
  const w = { id: "five_hour", used_percent: 70, reset_passed: false, confidence: "high", fetched_at: at(10, 5), resets_at: at(11), rate_60m: 15, rate_pace: 15, eta_at: at(14), eta_minutes: 240 };
  assert.deepEqual(plain(lib.projectionOf(w, new Date(at(10, 5)))), { consume: 13.75, runsOut: false, at: null });
  // At 60%/h with 30% remaining, it runs out at 10:35. Before that it runs out; after that the forecast is stale and not drawn
  const out = { ...w, rate_pace: 60 };
  assert.equal(lib.projectionOf(out, new Date(at(10, 10))).runsOut, true);
  assert.equal(lib.projectionOf(out, new Date(at(10, 40))), null);
  assert.equal(lib.paceOf({ rate_60m: 0.5, rate_15m: 2, rate_24h: 9 }), null, "only the server's rate_pace is used (no re-selection)");
});

test("The number of rows fits the height budget (dropping from the last rows)", () => {
  const s = lib.SCALES.large;
  assert.deepEqual(plain(lib.fitRows([3, 3], s, 1000, 16)), [3, 3]);
  const two = lib.groupHeight(s, 3) * 2 + 16;
  assert.deepEqual(plain(lib.fitRows([3, 3], s, two - 1, 16)), [3, 2], "on a tie, from the later group");
  assert.deepEqual(plain(lib.fitRows([4], lib.SCALES.medium, 130, 0)), [2]);
});

test("History over 500 points is accepted and thinned; unknown break values are rejected", () => {
  const list = Array.from({ length: 618 }, (_, i) => ({ at: new Date(NOW.getTime() - (618 - i) * 140000).toISOString(), used_percent: 10 + i / 100, resets_at: null, break: i === 300 ? "gap" : null }));
  const points = lib.sanitizeHistory({ provider: "codex", windows: { seven_day: list } }, "codex", "seven_day", NOW);
  assert.ok(points && points.length <= 260 && points.length > 200, String(points?.length));
  assert.equal(points.filter((p: any) => p.brk).length, 1, "break points are kept");
  assert.equal(points[points.length - 1].at, Date.parse(list[617]!.at), "the last point is kept");
  const typo = { provider: "claude", windows: { five_hour: [{ at: "2026-11-16T11:00:00.000Z", used_percent: 80, break: null }, { at: "2026-11-16T12:00:00.000Z", used_percent: 2, break: "typo" }] } };
  assert.equal(lib.sanitizeHistory(typo, "claude", "five_hour", NOW), null);
});

test("The trend is drawn only for the same window as the first one on the left", async () => {
  const history = (url: string) => {
    if (!url.includes("/v2/history")) return undefined;
    const q = new URL(url).searchParams;
    // Treat it as history for a different window than requested (same as the first window changing before drawing)
    return { status: 200, body: { provider: q.get("provider"), since: null, boundary: "#0", windows: { other_window: [{ at: "2026-11-16T12:00:00.000Z", used_percent: 8, resets_at: null, break: null }] } } };
  };
  const run = await runWidget({ family: "large", responder: history });
  assert.ok(texts(run.widget.node).includes("No weekly data yet"));
});

test("Falls back to SF Symbols if an embedded image can't be read", async () => {
  const embedded = code.replace(/^const ICONS = \{ claude: "", codex: "" \}; \/\/ @icons$/m, () => `const ICONS = {"claude":"QUJD","codex":""};`);
  const run = await runWidget({ family: "medium", code: embedded, badImage: true });
  assert.equal(run.error, null);
  assert.ok(images(run.widget.node).some((n) => n.props.symbol === "asterisk"));
});

test("The trend is used only when its boundary stamp matches the view's (not mixed across an account switch while reading)", async () => {
  const history = (boundary: string) => (url: string) => {
    if (!url.includes("/v2/history")) return undefined;
    const q = new URL(url).searchParams;
    return { status: 200, body: { provider: q.get("provider"), since: null, boundary, windows: { [q.get("window")!]: [{ at: "2026-11-16T12:00:00.000Z", used_percent: 8, resets_at: null, break: null }] } } };
  };
  const same = await runWidget({ family: "large", responder: history("#0") });
  assert.equal(texts(same.widget.node).filter((x) => x === "No weekly data yet" || x.endsWith(" –")).length, 0);
  const switched = await runWidget({ family: "large", responder: history("2026-11-16T12:30:00.000Z#1") });
  assert.equal(texts(switched.widget.node).includes("No weekly data yet"), true);
  assert.equal(lib.sanitizeBoundaries({ claude: "x@y", codex: "#0" }), null, "null if malformed");
});

test("When rows run short, keep overall limits -> the no-5h row -> scoped limits, in that order", () => {
  const rows = [{ kind: "missing" }, { kind: "window", window: { id: "seven_day", scope: null } }, { kind: "window", window: { id: "codex_other_seven_day", scope: "codex_other" } }];
  const ids = (n: number) => plain(lib.visibleRows(rows, n)).map((r: any) => r.window?.id ?? "missing");
  assert.deepEqual(ids(1), ["seven_day"], "the weekly limit isn't pushed out");
  assert.deepEqual(ids(2), ["missing", "seven_day"]);
  assert.deepEqual(ids(3), ["missing", "seven_day", "codex_other_seven_day"]);
});

test("When limits are named, the freshness dot uses the fetch times of the shown limits", async () => {
  const view = sampleView();
  view.claude!.windows.seven_day_fable!.fetched_at = "2026-11-16T12:30:00.000Z";
  const run = await runWidget({ family: "small", parameter: "claude.seven_day_fable", response: { status: 200, body: view } });
  assert.ok(texts(run.widget.node).includes("30m"), texts(run.widget.node).join(" | "));
});

test("The large height estimate includes the trend's minimum height, and groups without rows get no trend", async () => {
  const s = lib.SCALES.large;
  assert.ok(lib.groupHeight(s, 1, s.small + 2 + 48) > lib.groupHeight(s, 1), "trend height is reserved even with one row");
  const view = sampleView();
  (view as any).codex = null;
  const run = await runWidget({ family: "large", response: { status: 200, body: view } });
  assert.equal(texts(run.widget.node).includes("No weekly data yet"), true);
  assert.ok(!texts(run.widget.node).some((x) => x.startsWith("Codex Weekly") || x.startsWith("Codex 5h")), "Codex without values is not in the chart legend");
});

test("Thinning respects the cap, carries breaks to the next kept point, and checks point shape strictly", () => {
  const points = Array.from({ length: 618 }, (_, i) => ({ at: i, used: i / 10, brk: i === 301 }));
  const thin = plain(lib.thinPoints(points, 240));
  assert.ok(thin.length <= 240, String(thin.length));
  assert.equal(thin.filter((p: any) => p.brk).length, 1, "breaks are kept (a dropped point's break moves to the next point)");
  assert.equal(thin[thin.length - 1].at, 617);
  const bad = (p: object) => lib.sanitizeHistory({ provider: "claude", windows: { five_hour: [p] } }, "claude", "five_hour", NOW);
  assert.equal(bad({ at: ["2026-11-16T12:00:00.000Z"], used_percent: 1, break: null }), null, "time must be a string");
  assert.equal(bad({ at: "2026-11-16T12:00:00.000Z", used_percent: 1 }), null, "points without a break field are rejected");
});

test("If the trend's boundary disagrees, only that trend is discarded (the view is shown as read, not re-fetched)", async () => {
  let views = 0;
  const run = await runWidget({
    family: "large",
    responder: (url) => {
      if (!url.includes("/v2/history")) {
        views++;
        return undefined;
      }
      const q = new URL(url).searchParams;
      return { status: 200, body: { provider: q.get("provider"), since: null, boundary: "2026-11-16T12:30:00.000Z#1", windows: { [q.get("window")!]: [{ at: "2026-11-16T12:00:00.000Z", used_percent: 4, resets_at: null, break: null }] } } };
    },
  });
  assert.equal(views, 1, "the view is not re-fetched");
  assert.ok(texts(run.widget.node).includes("90%"), "the view as read is shown");
  assert.equal(texts(run.widget.node).includes("No weekly data yet"), true, "the trend after the switch is not mixed in");
  assert.ok(JSON.parse(latestCache(run.files)!).view.claude, "the previous view is not rewritten");
});

test("When dropping rows, scoped limits and the no-5h row go first, across providers", () => {
  const s = lib.SCALES.small;
  // Claude: no-5h row + weekly; Codex: 5h + weekly. Dropping one row removes Claude's "no 5h" row
  const ranks = [[1, 0], [0, 0]];
  const all = lib.groupHeight(s, 2) * 2 + 8;
  assert.deepEqual(plain(lib.fitRows([2, 2], s, all - 1, 8, 0, ranks)), [1, 2]);
  assert.deepEqual(plain(lib.fitRows([2, 2], s, all - 1, 8, 0, [[0, 0], [0, 2]])), [2, 1], "Codex's scoped limit first");
});

test("The forecast rate is the server's rate_pace as is, not re-selected from rounded rates", () => {
  const w = { id: "five_hour", used_percent: 99, reset_passed: false, confidence: "low", rate_60m: 0.6, rate_15m: 2.1, rate_24h: 0.6, rate_pace: 2.1 };
  assert.equal(lib.paceOf(w), 2.1);
  assert.equal(lib.paceOf({ ...w, rate_pace: null }), null, "if the server says there is no rate, don't re-select");
  assert.equal(lib.projectionOf({ ...w, used_percent: 40, confidence: "high", resets_at: "2026-11-16T20:00:00.000Z", rate_pace: undefined, fetched_at: NOW.toISOString() } as any, NOW) !== null, true, "with the field present (even if undefined), the forecast shape is built");
  const legacy = { id: "five_hour", used_percent: 40, reset_passed: false, confidence: "high", resets_at: "2026-11-16T20:00:00.000Z", rate_60m: 0.6, rate_15m: 2.1 };
  assert.equal(lib.projectionOf(legacy, NOW), null, "no forecast for old-format derived values without the field");
});

test("After limiting rows, the shown limits decide the header dot and the trend window", async () => {
  const view = sampleView();
  view.claude!.windows.seven_day_fable!.fetched_at = "2026-11-16T11:00:00.000Z";
  const param = "claude.seven_day_fable,claude.five_hour,claude.seven_day,codex.seven_day";
  const layout = lib.layoutGroups(lib.sanitizeView(view), "medium", param, NOW, { screen: { width: 320, height: 568 } });
  const claude = layout.groups.find((g: any) => g.provider === "claude");
  assert.deepEqual(plain(claude.rows.map((r: any) => r.window.id)), ["five_hour", "seven_day"], "scoped limits dropped for lack of height");
  assert.equal(claude.freshness.level, "fresh", "the dropped Fable (2 hours old) doesn't make it stale");
  // The trend window is the first window shown in the large layout
  const large = lib.layoutGroups(lib.sanitizeView(view), "large", param, NOW, { screen: { width: 320, height: 568 } });
  const windows = plain(lib.trendWindows(lib.sanitizeView(view), "large", param, NOW, { width: 320, height: 568 }));
  // The trend is fixed to the weekly limit
  for (const g of large.groups) assert.equal(windows[g.provider], "seven_day");

});

test("Groups with only a reason reserve no trend height (the other group's rows aren't reduced)", () => {
  const view = lib.sanitizeView(sampleView());
  view.codex = null;
  const screen = { width: 390, height: 844 };
  const layout = lib.layoutGroups(view, "large", "", NOW, { cached: true, screen });
  const alone = lib.layoutGroups(view, "large", "claude", NOW, { cached: true, screen });
  const rows = (l: any) => l.groups.find((g: any) => g.provider === "claude").rows.length;
  assert.equal(rows(layout), rows(alone), "same row count as Claude alone, even with a Codex without values");
  assert.equal(rows(layout), 3);
});

test("When run-out and reset coincide, it counts as lasting (time to run-out rounded to whole ms, like the server)", () => {
  const observed = Date.UTC(2026, 10, 16, 12, 0, 0);
  // Using 59.99% remaining at 0.6%/h runs out 359,940,000 ms after the fetch
  const until = Math.round((59.99 / (0.6 / 60)) * 60000);
  const w = (resetOffset: number) => ({ id: "seven_day", used_percent: 40.01, reset_passed: false, confidence: "high", fetched_at: new Date(observed).toISOString(),
    resets_at: new Date(observed + until + resetOffset).toISOString(), rate_pace: 0.6 });
  const now = new Date(observed);
  assert.equal(lib.projectionOf(w(-1), now).runsOut, false, "reset 1 ms earlier");
  assert.equal(lib.projectionOf(w(0), now).runsOut, false, "simultaneous");
  assert.equal(lib.projectionOf(w(1), now).runsOut, true, "runs out if the reset is 1 ms later");
});

const historyFor = (points: { at: string; used_percent: number }[]) => (url: string) => {
  if (!url.includes("/v2/history")) return undefined;
  const q = new URL(url).searchParams;
  return { status: 200, body: { provider: q.get("provider"), since: null, boundary: "#0", windows: { [q.get("window")!]: points.map((p) => ({ ...p, resets_at: null, break: null })) } } };
};

test("All chart lines have the same width", async () => {
  const same = [{ at: "2026-11-16T11:00:00.000Z", used_percent: 3 }, { at: "2026-11-16T12:00:00.000Z", used_percent: 8 }];
  const run = await runWidget({ family: "large", responder: historyFor(same) });
  const chart = images(run.widget.node).find((n) => (n.props.strokes as number) > 3)!;
  const lineWidths = (chart.props.widths as number[]).filter((w) => w > 1);
  assert.deepEqual(lineWidths, [2.5, 2.5], "same width");
});

test("(After fixing the chart to weekly) even when only a scoped limit is named, the chart shows that provider's weekly limit for 7 days", async () => {
  const run = await runWidget({ family: "large", parameter: "claude.seven_day_fable", responder: historyFor([{ at: "2026-11-16T12:00:00.000Z", used_percent: 1 }]) });
  const all = texts(run.widget.node);
  assert.ok(all.includes("Fable weekly") && all.includes("This week · Weekly") && all.includes("Claude"), all.join(" | "));
  const asked = run.requests.map((r: any) => r.url).filter((u: string) => u.includes("/v2/history")).map((u: string) => new URL(u).searchParams.get("window"));
  assert.deepEqual(asked, ["seven_day"]);
});

test("Widening the first piece stays inside the bar, below 1% shows a decimal, and points and guide lines share coordinates", () => {
  const seg = { remaining: 0.99, recent: 0.01, faded: false, level: "brand", projected: 0.955, runsOut: false };
  const pieces = plain(lib.barPieces(seg, 146, 10, "#D97757"));
  const end = pieces[pieces.length - 1].x + pieces[pieces.length - 1].w;
  assert.ok(end <= 146 + 1e-9, JSON.stringify(pieces));
  assert.ok(pieces.some((p: any) => p.hex === lib.BAR_COLORS.recent && p.w >= 6 - 1e-9), "gray keeps its minimum width");
  assert.equal(lib.remainingText({ used_percent: 99.6, remaining_percent: 0.4, remaining_percent_int: 0 }), "0.4%");
  assert.equal(lib.remainingText({ used_percent: 100, remaining_percent: 0, remaining_percent_int: 0 }), "0%");
  assert.equal(lib.remainingText({ used_percent: 40, remaining_percent: 60, remaining_percent_int: 60 }), "60%");
  const height = 73;
  const point = plain(lib.sparkLines([{ at: NOW.getTime(), used: 25, brk: false }], NOW, 260, height, 3, 168))[0][0][1];
  assert.equal(point, lib.trendY(25, height, 3), "the 25% point and guide line are at the same height");
});

test("The rate is omitted when showing the run-out time or when the column is narrow", async () => {
  const view = forecastView();
  const wide = await runWidget({ family: "large", response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z") });
  const all = texts(wide.widget.node);
  assert.ok(images(wide.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), "Codex shows the run-out time");
  assert.ok(all.includes("33%/h"), "the rate is at the right end of the time row (also on rows likely to run out)");
  assert.ok(all.some((x) => x.includes("0.4%/h")), "shown on Claude's row");
  const narrow = await runWidget({ family: "large", response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z"), screen: 320 });
  assert.ok(!texts(narrow.widget.node).some((x) => x.includes("%/h")), "the rate is omitted on devices with columns narrower than 140pt");
});

test("If one trend is missing it uses a short label; if both are missing, one line", async () => {
  const partial = await runWidget({ family: "large", responder: (url) => (url.includes("provider=codex") ? { status: 503, body: "" } : historyFor([{ at: "2026-11-16T12:00:00.000Z", used_percent: 4 }])(url)) });
  const p = texts(partial.widget.node);
  assert.ok(p.includes("This week · Weekly") && p.includes("Claude") && p.includes("Codex –"), p.join(" | "));
  const none = await runWidget({ family: "large", responder: (url) => (url.includes("/v2/history") ? { status: 503, body: "" } : undefined) });
  assert.ok(texts(none.widget.node).includes("No weekly data yet") && !texts(none.widget.node).includes("Last 24h"));
});

test("Trend lines are drawn inset by the dot radius (not clipped at the edges)", () => {
  const lines = plain(lib.sparkLines([{ at: NOW.getTime(), used: 100, brk: false }], NOW, 260, 60, 3));
  assert.deepEqual(lines[0][0], [257, 3], "the now / 100% point is inside the top-right corner");
});

test("Device feedback: bars are non-resizable images (don't disappear on overflow), and the timer is in a box as wide as the digits", async () => {
  const run = await runWidget({ family: "large" });
  const bars = images(run.widget.node).filter((n) => n.props.fills && (n.props.size as any)?.h === lib.SCALES.large.bar);
  assert.ok(bars.length >= 4 && bars.every((b) => b.props.resizable === false), "bars are resizable = false");
  const timerBox = findStack(run.widget.node, (n) => n.children.some((c) => c.kind === "date"))!;
  assert.ok((timerBox.props.size as any)?.w > 0, "the timer box has a fixed width");
  assert.equal(lib.timerWidth(new Date(NOW.getTime() + 3 * 3600000), NOW, 11), Math.ceil(11 * 0.62 * 7 + 4));
});

test("The first piece is at least as wide as the bar height (never sticks out of the track's rounding even when thin)", () => {
  const seg = { remaining: 0.6, recent: 0.05, faded: false, level: "brand", projected: 0.59, runsOut: false };
  const pieces = plain(lib.barPieces(seg, 123, 8, "#D97757"));
  assert.ok(pieces[0].w >= 8, JSON.stringify(pieces));
  assert.equal(pieces[0].leftCap, 4, "left rounding has the same radius as the track");
  const end = pieces[pieces.length - 1].x + pieces[pieces.length - 1].w;
  assert.ok(end <= 123 + 1e-9, "doesn't go past the bar's right end");
  for (let i = 1; i < pieces.length; i++) assert.ok(Math.abs(pieces[i].x - (pieces[i - 1].x + pieces[i - 1].w)) < 1e-9, "pieces meet without gaps");
});

test("The chart is fixed to the weekly limit's 7 days (5h and weekly are not mixed)", async () => {
  const run = await runWidget({ family: "large" });
  const asked = run.requests.map((r: any) => r.url).filter((u: string) => u.includes("/v2/history")).map((u: string) => new URL(u).search);
  assert.deepEqual(asked, ["?provider=codex&window=seven_day&hours=170", "?provider=claude&window=seven_day&hours=170"]);
  assert.equal(lib.TREND_HOURS, 170);
});

test("Remaining at 99.7% used is 0.3% (not 0.2% from floating-point error, even through draw-time recomputation)", () => {
  const w = lib.atDisplayTime({ id: "seven_day", used_percent: 99.7, recent_quality: "unknown", confidence: null, fetched_at: NOW.toISOString(), resets_at: "2026-11-20T07:00:00.000Z" }, NOW);
  assert.equal(lib.percentText(w), "0.3%");
});


test("If anything remains, it's never shown as 0% (minimum 0.1%)", () => {
  assert.equal(lib.remainingText({ used_percent: 99.9996, remaining_percent: 0.0004, remaining_percent_int: 0 }), "0.1%");
});

test("Bars use only the provider color and gray (unchanged at 10% or less remaining or when likely to run out); the freshness dot is green only when fresh", async () => {
  const view = forecastView();
  view.claude!.windows.five_hour!.used_percent = 95;
  for (const family of ["small", "medium", "large"]) {
    const run = await runWidget({ family, response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z") });
    const bars = images(run.widget.node).filter((n) => (n.props.strokes as number | undefined) === undefined || (n.props.strokes as number) === 0);
    const allowed = new Set([...Object.values(lib.BRAND_COLORS) as string[], lib.BAR_COLORS.recent, lib.BAR_COLORS.track, "#34C759", "#8E8E93"]);
    for (const c of bars.flatMap((n) => (n.props.fills as any[]) ?? [])) assert.ok(allowed.has(c.hex), `${family}: ${c.hex}`);
  }
  const fresh = lib.FRESH_COLORS ?? null;
  if (fresh) assert.equal(fresh.stale, "#8E8E93");
});


test("In the drawn output, recent consumption is dark gray and the freshness dot is green only when fresh", async () => {
  assert.equal(lib.BAR_COLORS.recent, "#6B7280", "gray for recent consumption (darker)");
  const run = await runWidget({ family: "medium" });
  const fills = images(run.widget.node).flatMap((n) => (n.props.fills as any[]) ?? []).map((c) => c.hex);
  assert.ok(fills.includes("#6B7280"), "recent consumption is drawn dark gray in the bar");
  assert.ok(!fills.includes("#9ca3af"), "the old light gray is not used");
  const dots = (node: any) => images(node).filter((n) => (n.props.size as any)?.w === 6).flatMap((n) => (n.props.fills as any[]).map((c) => c.hex));
  assert.ok(dots(run.widget.node).every((h) => h === "#34C759") && dots(run.widget.node).length > 0, "green when fresh");
  for (const later of ["2026-11-16T13:30:00.000Z", "2026-11-16T15:00:00.000Z"]) {
    const old = await runWidget({ family: "medium", now: new Date(later) });
    assert.ok(dots(old.widget.node).length > 0 && dots(old.widget.node).every((h) => h === "#8E8E93"), `${later}: gray when old`);
  }
});

test("The dot for a value with an unknown fetch time is gray", async () => {
  const view = sampleView();
  for (const w of Object.values(view.claude!.windows)) (w as any).fetched_at = null;
  const run = await runWidget({ family: "medium", response: { status: 200, body: view } });
  const dots = images(run.widget.node).filter((n) => (n.props.size as any)?.w === 6).map((n) => (n.props.fills as any[])[0]?.hex);
  assert.deepEqual(dots, ["#34C759", "#8E8E93"], "Codex (fresh) is green, Claude (time unknown) is gray");
});


test("⚠ is always the monochrome glyph (with U+FE0E) so iOS doesn't draw a yellow emoji", async () => {
  const view = forecastView();
  view.codex!.windows.seven_day!.used_percent = 92;
  const cached = JSON.stringify({ saved_at: "2026-11-16T12:40:00.000Z", origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView()) });
  const runs = [
    ...await Promise.all(["small", "medium", "large"].map((family) => runWidget({ family, response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z") }))),
    ...await Promise.all(["medium", "accessoryRectangular", "accessoryCircular", "accessoryInline"].map((family) => runWidget({ family, response: null, cached, now: new Date("2026-11-16T13:30:00.000Z") }))),
  ];
  // Previous values with an unknown save time (the "showing last data" notice)
  const noTime = JSON.stringify({ saved_at: null, origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView()) });
  runs.push(await runWidget({ family: "medium", response: null, cached: noTime, now: new Date("2026-11-16T13:30:00.000Z") }));
  assert.ok(runs.some((r) => texts(r.widget.node).some((x) => x.includes("showing last data"))), "the notice with an unknown save time is drawn too");
  const all = runs.flatMap((r) => texts(r.widget.node)).filter((x) => x.includes("⚠"));
  assert.ok(all.length >= 4, all.join(" | "));
  for (const x of all) assert.ok(!/⚠(?!︎)/.test(x), JSON.stringify(x));
});


test("Low remaining alone doesn't warn unless it will run out (no battery symbol or Low)", async () => {
  const view = sampleView();
  view.codex!.windows.seven_day!.used_percent = 95;
  for (const family of ["small", "medium", "large", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
    const run = await runWidget({ family, parameter: family.startsWith("accessory") ? "codex" : undefined, response: { status: 200, body: view } });
    const all = texts(run.widget.node);
    assert.ok(!all.some((x) => x.includes("\u26A0") || /\bLow\b/.test(x)), `${family}: ${all.join(" | ")}`);
    assert.ok(!images(run.widget.node).some((n) => String(n.props.symbol ?? "").startsWith("battery")), family);
  }
});


test("Large/medium: limit names and time rows use the same font size across the Claude and Codex columns (not shrunk per row; device feedback)", async () => {
  const view = forecastView();
  for (const family of ["medium", "large"]) {
    const run = await runWidget({ family, response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z") });
    const cols = columnsOf(run.widget.node);
    const labels = cols.map((c) => textNodes(c).filter((n) => / limit$| weekly$/.test(String(n.props.text)) && !String(n.props.text).startsWith("No ")));
    assert.ok(labels.every((l) => l.length > 0), family);
    const sizes = new Set(labels.flat().map((n) => (n.props.font as any)?.size));
    assert.equal(sizes.size, 1, `${family}: limit name sizes ${labels.flat().map((n) => `${n.props.text}=${(n.props.font as any)?.size}`).join(", ")}`);
    assert.ok(labels.flat().every((n) => n.props.minScale === undefined), `${family}: limit names not shrunk`);
    const subs = cols.map((c) => textNodes(c).filter((n) => /^( · |Reset|Soon|\w{3} \d)/.test(String(n.props.text))));
    const subSizes = new Set(subs.flat().map((n) => (n.props.font as any)?.size));
    assert.ok(subSizes.size <= 1, `${family}: time row sizes ${[...subSizes].join(", ")}`);
    assert.ok(subs.flat().every((n) => n.props.minScale === 1), `${family}: time rows not shrunk`);
  }
  // A long name shrinks both columns by the same amount (estimate)
  const opts = { content: lib.SIZE_CONTENT.large, scale: lib.SCALES.large, now: NOW, width: 60, rows: Infinity };
  const groups = lib.groupsOf(lib.sanitizeView(sampleView()), "", NOW);
  const fit = lib.fittedSizes(groups, opts);
  assert.ok(fit.label < lib.SCALES.large.label && fit.label >= lib.SCALES.large.label * 0.7 - 0.5, JSON.stringify(fit));
});

test("Demo: draws every state with made-up values only (no network, no saving; Demo in the header and on the lock screen)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const expect: Record<string, RegExp> = {
    normal: /Fable weekly/, runout: /Weekly limit/, no5h: /Not available|5h limit/, stale: /^30m$|30m ago/,
    reset: /Reset \(est\.\)|^0%$/, offline: /Can't update/, error: /Sign in required/, nochart: /No weekly data yet/,
  };
  for (const s of lib.DEMO_SCENARIOS) {
    for (const family of ["small", "medium", "large", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
      const run = await runWidget({ family, parameter: `demo:${s.name}`, now });
      assert.equal(run.error, null, `${s.name} ${family}: ${run.error}`);
      assert.equal(run.requests.length, 0, `${s.name} ${family}: no network`);
      assert.equal([...run.files.keys()].filter((p) => p.includes("headroom-view")).length, 0, `${s.name} ${family}: no saving`);
      const all = texts(run.widget.node);
      assert.ok(all.some((x) => /\bDemo\b/.test(x)), `${s.name} ${family}: ${all.join(" | ")}`);
      if (family === "large") assert.ok(all.some((x) => expect[s.name]!.test(x)), `${s.name}: ${all.join(" | ")}`);
    }
  }
  assert.equal(lib.demoName("demo"), "runout");
  assert.equal(lib.demoName(" Demo:Stale "), "stale");
  assert.equal(lib.demoName("demo:unknown"), "runout");
  assert.equal(lib.demoName("claude"), null);
  const chart = await runWidget({ family: "large", parameter: "demo:normal", now });
  assert.ok(images(chart.widget.node).some((n) => (n.props.strokes as number) >= 5), "draws the demo 7-day trend");
});

test("The app menu's 'Show demo': choose a demo and size to show, and choose again after closing (no network)", async () => {
  // Menu: Show demo -> demo runout -> Large -> demo stale -> Small -> Done
  const run = await runWidget({ family: "medium", runsInWidget: false, app: { menu: [1, 1, 2, 3, 0, -1] } } as any);
  assert.equal(run.error, null, String(run.error));
  assert.deepEqual(run.shownSizes, ["large", "small"]);
  assert.equal(run.requests.length, 0);
});




test("If it will run out, the run-out time replaces the reset time in the same form, and the symbol changes from ↻ to ⚠", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view;
  const five = lib.atDisplayTime(view.claude.windows.five_hour, now);
  const week = lib.atDisplayTime(view.codex.windows.seven_day, now);
  const p5 = lib.projectionOf(five, now);
  const pw = lib.projectionOf(week, now);
  // Countdown within 24 hours, weekday and time beyond that (same form as the reset time)
  assert.deepEqual(plain(lib.timeShort(five, now)), { warn: true, kind: "timer", date: new Date(p5.at).toISOString() });
  assert.deepEqual(plain(lib.timeShort(week, now)), { warn: true, kind: "text", text: lib.clockText(new Date(pw.at), now).replace(":00 ", " ") });
  assert.equal(lib.timeShort(view.claude.windows.seven_day, now).warn, false, "a limit that lasts shows the reset time");
  const run = await runWidget({ family: "medium", parameter: "demo:runout", now });
  assert.equal(images(run.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn).length, 2, "Claude 5h and Codex weekly");
  assert.equal(images(run.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.reset).length, 2, "the others show reset");
  assert.ok(JSON.stringify(run.widget.node).includes(`"date":"${new Date(p5.at).toISOString()}","timer":true`), "countdown to run-out");
  // Under one minute it's Soon
  const soon = JSON.parse(JSON.stringify(view));
  soon.claude.windows.five_hour.rate_pace = 1000;
  assert.deepEqual(plain(lib.timeShort(lib.atDisplayTime(soon.claude.windows.five_hour, now), now)), { warn: true, kind: "text", text: "Soon" });
});

test("Asks to be redrawn at the drawn warning's run-out time; limits not shown don't make it earlier", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  assert.equal(lib.refreshAfter([], now).getTime(), now.getTime() + 15 * 60000, "15 minutes later without a warning");
  assert.equal(lib.refreshAfter([now.getTime() + 20000], now).getTime(), now.getTime() + 60000, "never sooner than 1 minute");
  const view = lib.demoResult("runout", now).view;
  view.claude.windows.five_hour.rate_pace = 300; // runs out 6 minutes after the fetch (1 minute ago)
  const body = { ...view, data_version: 1, view_version: 1 };
  const run = await runWidget({ family: "medium", response: { status: 200, body }, now });
  assert.equal((run.widget as any).refreshAfterDate.getTime(), Date.parse(view.claude.windows.five_hour.fetched_at) + 6 * 60000);
  const only = await runWidget({ family: "medium", parameter: "codex.five_hour", response: { status: 200, body }, now });
  assert.equal((only.widget as any).refreshAfterDate.getTime(), now.getTime() + 15 * 60000, texts(only.widget.node).join(" | "));
});

test("Weekday times in narrow columns stay at 0.7x or more; demos that failed to fetch draw no trend", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const s = lib.SCALES.large;
  const need = s.small + 1 + lib.textWidth("Fri 10:01 PM", s.small);
  assert.ok(123 / need >= 0.7, String(need));
  const off = await runWidget({ family: "large", parameter: "demo:offline", now });
  assert.ok(texts(off.widget.node).includes("No weekly data yet"), texts(off.widget.node).join(" | "));
});

test("Lock screen: circular progress around the icon. The rectangle shows the one limit with the least remaining; the circle shows remaining inside", async () => {
  const later = new Date("2026-11-16T13:30:00.000Z"); // 30 minutes after the fetch
  const rect = await runWidget({ family: "accessoryRectangular", now: later });
  const rings = images(rect.widget.node).filter((n) => n.props.ring);
  assert.equal(rings.length, 1);
  // The test script has no PNG embedded, so the ring holds the initial (the icon if there is a PNG)
  assert.ok(rings[0]!.props.data || (rings[0]!.props.drawnTexts as string[]).includes("X"), "the icon is inside the ring");
  const r = texts(rect.widget.node);
  assert.ok(r.includes("Codex · Weekly") && r.includes("71%") && r.includes("31m ago"), r.join(" | "));
  assert.ok(images(rect.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.reset), "reset time");
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex" });
  assert.deepEqual(texts(inline.widget.node), ["Codex Wk 71%"]);
  const circular = await runWidget({ family: "accessoryCircular", now: later });
  const ring = images(circular.widget.node).find((n) => n.props.ring);
  assert.equal((ring?.props.drawnTexts as string[]).at(-1), "71%", "remaining is inside the ring (below the icon)");
  assert.deepEqual(texts(circular.widget.node), ["Wk 31m ago"]);
  // The ring is the shown limit's remaining (matches the number)
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view;
  assert.equal(lib.ringOf(lib.atDisplayTime(view.claude.windows.five_hour, now)).fraction, 0.3);
  assert.equal(lib.ringOf(lib.atDisplayTime(view.claude.windows.seven_day, now)).fraction, 0.7);
  assert.equal(lib.ringOf(null), null);
  // The icon is small to leave space inside the ring
  for (const g of Object.values(lib.LOCK_RINGS) as any[]) assert.ok(g.icon <= (g.size - 2 * g.width) * 0.5, JSON.stringify(g));
  // If it will run out, the rectangle also shows ⚠ in place of the reset time
  const warn = await runWidget({ family: "accessoryRectangular", parameter: "demo:runout", now });
  assert.ok(images(warn.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), texts(warn.widget.node).join(" | "));
});

test("Lock screen marks stack reset estimate, staleness and approximation (also with the previous-value ⚠)", async () => {
  assert.equal(lib.shortMark({ value_status: "old", recent_quality: "approx" }), "old", "approximations get no mark");
  assert.equal(lib.shortMark({ value_status: "stale", age_minutes: 20, recent_quality: "approx" }), "20m ago");
  assert.equal(lib.shortMark({ value_status: "reset_estimated", recent_quality: "unknown" }), "est.");
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView()) });
  const late = new Date("2026-11-16T16:30:00.000Z");
  const inline = await runWidget({ family: "accessoryInline", parameter: "claude.five_hour", response: null, cached, now: late });
  assert.equal(texts(inline.widget.node)[0], "⚠︎ Claude 5h 100% (est.)");
  const circular = await runWidget({ family: "accessoryCircular", parameter: "claude.five_hour", response: null, cached, now: late });
  assert.deepEqual(texts(circular.widget.node), ["5h ⚠︎ est."]);
  assert.equal((images(circular.widget.node).find((n) => n.props.ring)?.props.drawnTexts as string[]).at(-1), "100%");
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "claude.five_hour", response: null, cached, now: late });
  assert.ok(texts(rect.widget.node).some((x) => x.includes("Can't update")), texts(rect.widget.node).join(" | "));
});

test("Without embedded icons, the provider's initial is drawn inside the ring (no untinted fallback symbol)", async () => {
  const run = await runWidget({ family: "accessoryCircular", badImage: true });
  const ring = images(run.widget.node).find((n) => n.props.ring);
  assert.ok((ring?.props.drawnTexts as string[] | undefined)?.some((x: string) => x === "C" || x === "X"), JSON.stringify(ring?.props.drawnTexts));
});

test("Lock screen parameter: choose 5h, weekly or a provider; up to two with a comma, + or both", () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view; // Claude 5h 30%, weekly 70%; Codex 5h 85%, weekly 35%
  const pick = (p: string) => [...lib.lockPicks(view, p, now)].map((x: any) => (x.missing ? `${x.provider}:missing` : `${x.provider}.${x.window.id}`));
  assert.deepEqual(pick(""), ["claude.five_hour"], "empty is the limit with the least remaining");
  assert.deepEqual(pick("weekly"), ["codex.seven_day"], "the weekly limit with less remaining");
  assert.deepEqual(pick("5h"), ["claude.five_hour"]);
  assert.deepEqual(pick("Codex Weekly"), ["codex.seven_day"]);
  assert.deepEqual(pick("claude"), ["claude.five_hour"], "without a limit, the provider's limit with the least remaining");
  assert.deepEqual(pick("claude 5h, codex 5h"), ["claude.five_hour", "codex.five_hour"]);
  assert.deepEqual(pick("codex 5h + codex weekly"), ["codex.five_hour", "codex.seven_day"]);
  assert.deepEqual(pick("both weekly"), ["codex.seven_day", "claude.seven_day"], "both is Codex -> Claude");
  assert.deepEqual(pick("both"), ["codex.seven_day", "claude.five_hour"]);
  assert.deepEqual(pick("claude.seven_day"), ["claude.seven_day"], "older form");
  assert.deepEqual(pick("a, b, c"), ["claude.five_hour", "claude.five_hour"], "a third and later are ignored");
  const no5h = lib.demoResult("no5h", now).view;
  assert.deepEqual([...lib.lockPicks(no5h, "codex 5h", now)].map((x: any) => x.missing), [true], "pair without the limit");
});

test("Two side by side in the lock screen rectangle: each has a ring (icon and remaining), limit name and time row; each ring shows its own remaining", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "accessoryRectangular", parameter: "demo:runout", now });
  assert.equal(images(run.widget.node).filter((n) => n.props.ring).length, 1, "the demo default is one");
  const view = lib.demoResult("runout", now).view;
  const body = { ...view, data_version: 1, view_version: 1 };
  const pair = await runWidget({ family: "accessoryRectangular", parameter: "claude 5h + claude weekly", response: { status: 200, body }, now });
  const rings = images(pair.widget.node).filter((n) => n.props.ring);
  assert.equal(rings.length, 2);
  assert.deepEqual(rings.map((n) => (n.props.drawnTexts as string[]).at(-1)), ["30%", "70%"], "each ring shows its limit's remaining");
  const all = texts(pair.widget.node);
  assert.ok(all.includes("5h") && all.includes("Weekly"), all.join(" | "));
  assert.ok(images(pair.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), "Claude 5h will likely run out (⚠)");
  assert.ok(images(pair.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.reset), "weekly shows reset (↻)");
  const both = await runWidget({ family: "accessoryRectangular", parameter: "both 5h", response: { status: 200, body }, now });
  assert.equal(images(both.widget.node).filter((n) => n.props.ring).length, 2);
  // Codex without a 5-hour limit shows "5h Not available"
  const no5h = lib.demoResult("no5h", now).view;
  const missing = await runWidget({ family: "accessoryRectangular", parameter: "both 5h", response: { status: 200, body: { ...no5h, data_version: 1, view_version: 1 } }, now });
  assert.ok(texts(missing.widget.node).includes("5h Not available"), texts(missing.widget.node).join(" | "));
  // The circle and inline widgets are chosen with the same parameter
  const circ = await runWidget({ family: "accessoryCircular", parameter: "codex weekly", response: { status: 200, body }, now });
  assert.equal((images(circ.widget.node).find((n) => n.props.ring)?.props.drawnTexts as string[]).at(-1), "35%");
  const inline = await runWidget({ family: "accessoryInline", parameter: "both weekly", response: { status: 200, body }, now });
  assert.ok(/Codex Wk 35%.*Claude Wk 70%/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
});

test("Lock screen ⚠ times also trigger a redraw; long headings drop the provider name", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view;
  view.claude.windows.five_hour.rate_pace = 300; // runs out 6 minutes after the fetch (1 minute ago)
  const body = { ...view, data_version: 1, view_version: 1 };
  const expected = Date.parse(view.claude.windows.five_hour.fetched_at) + 6 * 60000;
  for (const parameter of ["claude 5h", "claude 5h, codex weekly"]) {
    const run = await runWidget({ family: "accessoryRectangular", parameter, response: { status: 200, body }, now });
    assert.equal((run.widget as any).refreshAfterDate.getTime(), expected, parameter);
  }
  const calm = await runWidget({ family: "accessoryRectangular", parameter: "claude weekly", response: { status: 200, body }, now });
  assert.equal((calm.widget as any).refreshAfterDate.getTime(), now.getTime() + 15 * 60000);
  // Long heading (Fable's weekly limit plus a staleness mark)
  const late = new Date("2026-11-16T13:30:00.000Z");
  const long = await runWidget({ family: "accessoryRectangular", parameter: "claude.seven_day_fable", now: late });
  const head = texts(long.widget.node)[0]!;
  assert.equal(head, "Fable weekly", "the provider name is dropped");
  assert.ok(texts(long.widget.node).some((x) => /^\d+m ago$/.test(x)), "the staleness mark is next to the remaining value");
  assert.ok(lib.textWidth(head, 12) * 0.8 <= lib.LOCK_TITLE_WIDTH + 1, head);
  const short = await runWidget({ family: "accessoryRectangular", parameter: "codex weekly", now: late });
  assert.equal(texts(short.widget.node)[0], "Codex · Weekly", texts(short.widget.node).join(" | "));
});

test("Why a limit is missing (No 5h vs a failed fetch), mixing old and new forms, short marks for two side by side, and top", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const pick = (view: any, p: string) => [...lib.lockPicks(view, p, now)].map((x: any) => (x.missing ? `${x.provider}:${x.label}` : `${x.provider}.${x.window.id}`));
  const runout = lib.demoResult("runout", now).view;
  assert.deepEqual(pick(runout, "claude 5h, codex.seven_day"), ["claude.five_hour", "codex.seven_day"], "mixing old and new forms");
  assert.deepEqual(pick(runout, "claude.five_hour + codex.seven_day"), ["claude.five_hour", "codex.seven_day"]);
  assert.deepEqual(pick(runout, "top"), ["claude.five_hour"], "top for the rectangle and circle is the same as empty");
  const no5h = lib.demoResult("no5h", now).view;
  assert.deepEqual(pick(no5h, "codex 5h"), ["codex:5h: Not available"]);
  const error = lib.demoResult("error", now).view;
  assert.deepEqual(pick(error, "claude 5h"), ["claude:Sign in required"], "a failed fetch isn't shown as No 5h");
  const body = (v: any) => ({ status: 200, body: { ...v, data_version: 1, view_version: 1 } });
  // The circle and inline widgets show the reason too
  const circ = await runWidget({ family: "accessoryCircular", parameter: "codex 5h", response: body(no5h), now });
  assert.ok(texts(circ.widget.node).includes("5h Not available"), texts(circ.widget.node).join(" | "));
  const inline = await runWidget({ family: "accessoryInline", parameter: "both 5h", response: body(no5h), now });
  assert.ok(/Codex 5h N\/A.*Claude 5h \d+%/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
  const top = await runWidget({ family: "accessoryInline", parameter: "top", response: body(runout), now });
  assert.ok(/Codex .*Claude /.test(texts(top.widget.node)[0]!), "inline top is per provider");
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "claude 5h", response: body(error), now });
  assert.ok(texts(rect.widget.node).includes("Claude: Sign in required"), texts(rect.widget.node).join(" | "));
  // Staleness marks are short when two are side by side
  const late = new Date("2026-11-16T13:30:00.000Z");
  const pair = await runWidget({ family: "accessoryRectangular", parameter: "claude.seven_day_fable + codex weekly", now: late });
  const labels = texts(pair.widget.node);
  assert.ok(labels.some((x) => /^Fable weekly \d+m$/.test(x)), labels.join(" | "));
  for (const x of labels.filter((x) => /weekly|Weekly/.test(x))) assert.ok(lib.textWidth(x, 9) * 0.8 <= 76, x);
});

test("Reasons when no provider is given, reasons for inline top and the circle demo, and label width when two are side by side", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const body = (v: any) => ({ status: 200, body: { ...v, data_version: 1, view_version: 1 } });
  // No Claude values and Codex has only weekly: "Codex 5h: Not available"
  const codexOnly = JSON.parse(JSON.stringify(lib.demoResult("no5h", now).view));
  codexOnly.claude = null;
  const p1 = [...lib.lockPicks(codexOnly, "5h", now)][0] as any;
  assert.equal(`${p1.providerName} ${p1.label}`, "Codex 5h: Not available");
  // No Claude values and Codex needs sign-in: Codex's reason
  const signIn = JSON.parse(JSON.stringify(codexOnly));
  signIn.codex = { status: "error", plan: null, error_code: "login_required", main_window_ids: [], window_ids: [], windows: {} };
  const p2 = [...lib.lockPicks(signIn, "5h", now)][0] as any;
  assert.equal(`${p2.providerName}: ${p2.label}`, "Codex: Sign in required");
  // Inline top also shows the reason for a provider whose fetch failed
  const runout = JSON.parse(JSON.stringify(lib.demoResult("runout", now).view));
  runout.codex = { status: "error", plan: null, error_code: "login_required", main_window_ids: [], window_ids: [], windows: {} };
  const inline = await runWidget({ family: "accessoryInline", parameter: "top", response: body(runout), now });
  assert.ok(/Codex Sign in required/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
  const demoCirc = await runWidget({ family: "accessoryCircular", parameter: "demo:error", now });
  assert.ok(texts(demoCirc.widget.node).some((x) => x.includes("Sign in")), texts(demoCirc.widget.node).join(" | "));
  const demoInline = await runWidget({ family: "accessoryInline", parameter: "demo:error", now });
  assert.ok(texts(demoInline.widget.node)[0]!.includes("Sign in required"), texts(demoInline.widget.node).join(" | "));
  // Labels fit the column when two are side by side
  const pair = await runWidget({ family: "accessoryRectangular", parameter: "claude weekly + codex weekly", response: body(signIn), now });
  for (const x of texts(pair.widget.node)) if (!/^\d|^[A-Z][a-z]{2} /.test(x)) assert.ok(lib.textWidth(x, 9, true) * 0.8 <= 76, x);
  assert.ok(texts(pair.widget.node).includes("Sign in"), texts(pair.widget.node).join(" | "));
});

test("A provider whose fetch failed shows the reason first even if a weekly limit remains; a failure without a reason code is also No data", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const body = (v: any) => ({ status: 200, body: { ...v, data_version: 1, view_version: 1 } });
  const view = JSON.parse(JSON.stringify(lib.demoResult("no5h", now).view));
  view.codex.status = "error";
  view.codex.error_code = "login_required";
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "codex 5h", response: body(view), now });
  assert.ok(texts(rect.widget.node).includes("Codex: Sign in required"), texts(rect.widget.node).join(" | "));
  const circ = await runWidget({ family: "accessoryCircular", parameter: "codex 5h", response: body(view), now });
  assert.ok(texts(circ.widget.node).includes("Sign in"), texts(circ.widget.node).join(" | "));
  const noCode = JSON.parse(JSON.stringify(lib.demoResult("runout", now).view));
  noCode.codex = { status: "error", plan: null, error_code: null, main_window_ids: [], window_ids: [], windows: {} };
  for (const parameter of ["top", ""]) {
    const inline = await runWidget({ family: "accessoryInline", parameter, response: body(noCode), now });
    assert.ok(/Codex No data/.test(texts(inline.widget.node)[0]!), `${parameter}: ${texts(inline.widget.node).join(" | ")}`);
  }
});

test("Time row: the run-out time is the same gray as the reset time, and the rate is at the right end (also on rows likely to run out)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "large", parameter: "demo:runout", now });
  const warn = images(run.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn);
  assert.ok(warn.length > 0 && warn.every((n) => n.props.tint === "#6e6e73"), "the ⚠ symbol is gray");
  const reset = images(run.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.reset);
  assert.ok(reset.every((n) => n.props.tint === "#6e6e73"), "same color as ↻");
  const all = texts(run.widget.node);
  assert.ok(all.includes("1.2%/h") && all.includes("30%/h"), all.join(" | "));
  // The rate is last in the time row (right end)
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const row = rows(run.widget.node).find((s) => s.children.some((c: any) => c.kind === "text" && c.props.text === "30%/h"));
  assert.equal(row.children.at(-1).props.text, "30%/h");
  assert.equal(row.children.at(-2).kind, "spacer");
  assert.equal(lib.PROVIDER_ORDER.join(","), "codex,claude", "Codex on the left / top");
});

test("Inline default and top keep Codex first even with reasons added; the lock screen time row is gray too", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const body = (v: any) => ({ status: 200, body: { ...v, data_version: 1, view_version: 1 } });
  const view = JSON.parse(JSON.stringify(lib.demoResult("runout", now).view));
  view.codex = { status: "error", plan: null, error_code: "login_required", main_window_ids: [], window_ids: [], windows: {} };
  for (const parameter of ["", "top"]) {
    const inline = await runWidget({ family: "accessoryInline", parameter, response: body(view), now });
    assert.ok(/^Codex Sign in required · Claude /.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
  }
  for (const parameter of ["claude 5h", "claude 5h + claude weekly"]) {
    const rect = await runWidget({ family: "accessoryRectangular", parameter, response: body(lib.demoResult("runout", now).view), now });
    const symbols = images(rect.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn || n.props.symbol === lib.TIME_SYMBOLS.reset);
    assert.ok(symbols.length > 0 && symbols.every((n) => n.props.tint === "#6e6e73"), parameter);
  }
});

test("Version 46: weekday times to the minute; chart heading (Usage) on the left with a right-aligned legend; the lower line in front; Not available without a 5-hour limit", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  assert.equal(lib.whenShort(new Date("2026-11-20T07:00:00.000Z"), now).text, lib.clockText(new Date("2026-11-20T07:00:00.000Z"), now));
  assert.match(lib.whenShort(new Date("2026-11-20T07:00:00.000Z"), now).text, /^\w{3} \d{1,2}:\d{2} [AP]M$/, "Fri 4:00 PM form");
  const run = await runWidget({ family: "large", parameter: "demo:normal", now });
  const all = texts(run.widget.node);
  const usage = all.indexOf("Usage");
  assert.ok(usage >= 0 && all.indexOf("This week · Weekly") > usage, all.join(" | "));
  // Legend row: heading -> flexible spacer -> legend (right-aligned)
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const legend = rows(run.widget.node).find((s) => s.children.some((c: any) => c.kind === "text" && c.props.text === "Usage"));
  assert.equal(legend.children[0].props.text, "Usage");
  assert.equal(legend.children[1].kind, "spacer");
  assert.equal(legend.children[1].props.length, null, "flexible spacer (right-aligned)");
  // The lower value is drawn last (in front): the demo normal is Codex 41%, Claude 22%, so Claude last
  const chart = images(run.widget.node).find((n) => (n.props.strokes as number) >= 5)!;
  const fills = (chart.props.fills as any[]).map((c) => c.hex).filter((h) => h === lib.BRAND_COLORS.codex || h === lib.BRAND_COLORS.claude);
  assert.equal(fills.at(-1), lib.BRAND_COLORS.claude, "the lower one (Claude) is drawn last");
  const order = [...lib.trendDrawOrder([
    { provider: "codex", points: [{ used: 10 }, { used: 20 }] },
    { provider: "claude", points: [{ used: 50 }, { used: 60 }] },
  ])].map((x: any) => x.provider);
  assert.deepEqual(order, ["claude", "codex"], "if Codex is lower, Codex goes last (in front)");
  const small = await runWidget({ family: "small", parameter: "demo:no5h", now });
  const s = texts(small.widget.node);
  assert.ok(s.includes("5h limit") && s.includes("—") && !s.includes("No 5h limit") && !s.includes(lib.NOT_AVAILABLE), "small shows '5h limit —' like medium and large, without the row below the bar");
  const m = texts((await runWidget({ family: "medium", parameter: "demo:no5h", now })).widget.node);
  assert.ok(m.includes(lib.NOT_AVAILABLE) && !m.includes("No 5h limit"), "medium and large show Not available");
});

test("Rows are fixed to the column width (remaining number and rate right-aligned; device feedback)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "large", parameter: "demo:runout", now });
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const sub = rows(run.widget.node).find((s) => s.children.some((c: any) => c.kind === "text" && c.props.text === "30%/h"));
  const cols = columnsOf(run.widget.node);
  const width = (cols[0]!.props.size as any).w;
  assert.equal((sub.props.size as any)?.w, width, "time row is the column width");
  const line = rows(run.widget.node).find((s) => s.children.some((c: any) => c.kind === "text" && c.props.text === "5h limit"));
  assert.equal((line.props.size as any)?.w, width, "heading row is the column width too");
  const header = rows(cols[0]!).find((x) => x.children.some((c: any) => c.kind === "stack" && c.children.some((d: any) => d.kind === "text" && d.props.text === "Codex")));
  assert.equal((header.props.size as any)?.w, width, "provider header row is the column width too");
  const legend = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === "Usage"));
  assert.ok((legend.props.size as any)?.w > width, "chart heading row is the chart width");
});

test("Inline without a 5-hour limit is short (5h N/A). The rectangle demo's Demo goes next to the remaining value (not in the time row)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const inline = await runWidget({ family: "accessoryInline", parameter: "both 5h", response: { status: 200, body: { ...lib.demoResult("no5h", now).view, data_version: 1, view_version: 1 } }, now });
  const text = texts(inline.widget.node)[0]!;
  assert.ok(text.startsWith("Codex 5h N/A · Claude 5h"), text);
  assert.ok(lib.textWidth(text, 11) <= 225, `${text}: ${lib.textWidth(text, 11)}`);
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "demo:normal", now });
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const timeRow = rows(rect.widget.node).find((s) => s.children.some((c: any) => c.kind === "image" && (c.props.symbol === lib.TIME_SYMBOLS.reset || c.props.symbol === lib.TIME_SYMBOLS.warn)));
  assert.ok(!texts(timeRow).includes("Demo"), "Demo is not in the time row");
  assert.ok(texts(rect.widget.node).includes("Demo"), "Demo is next to the remaining value");
});

test("When width is short, the staleness mark is shortened (inline, rectangle demo)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("no5h", now).view;
  view.claude.windows.five_hour.fetched_at = "2026-11-16T12:39:00.000Z"; // 26 minutes ago (gets a staleness mark)
  const cached = JSON.stringify({ saved_at: "2026-11-16T12:39:00.000Z", origin: "https://headroom.example.com", view: lib.sanitizeView({ ...view, data_version: 1, view_version: 1 }) });
  const inline = await runWidget({ family: "accessoryInline", parameter: "both 5h", response: null, cached, now });
  const text = texts(inline.widget.node)[0]!;
  assert.ok(text.startsWith(lib.WARN_MARK), text);
  assert.ok(lib.textWidth(text, 11) <= lib.INLINE_WIDTH, `${text}: ${lib.textWidth(text, 11)}`);
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "demo:offline", now });
  const side = texts(rect.widget.node).find((x) => x.includes("Demo"))!;
  assert.ok(!side.includes(" ago"), side);
});

test("Inline measures width including the demo prefix and drops the staleness mark if it doesn't fit (keeps ⚠ and remaining)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const off = await runWidget({ family: "accessoryInline", parameter: "demo:offline", now });
  const text = texts(off.widget.node)[0]!;
  assert.ok(text.startsWith("Demo · ") && text.includes(lib.WARN_MARK), text);
  assert.ok(lib.textWidth(text, 11) <= lib.INLINE_WIDTH, `${text}: ${lib.textWidth(text, 11)}`);
  assert.ok(/\d+%/.test(text), "remaining is kept");
  const items = [
    { provider: "codex", providerName: "Codex", window: { id: "seven_day", used_percent: 41, remaining_percent: 59, remaining_percent_int: 59, value_status: "stale", age_minutes: 26 } },
    { provider: "claude", providerName: "Claude", window: { id: "five_hour", used_percent: 35, remaining_percent: 65, remaining_percent_int: 65, value_status: "stale", age_minutes: 26 } },
  ];
  const both = lib.inlineText(items, true);
  assert.ok(lib.textWidth(both, 11) <= lib.INLINE_WIDTH, `${both}: ${lib.textWidth(both, 11)}`);
  assert.ok(both.includes("59%") && both.includes("65%"), both);
});

test("Codex and Claude columns have equal heights: header, limit name and time rows have fixed heights, and the '—' of a row without a 5-hour limit uses the remaining value's font (device feedback)", async () => {
  for (const family of ["medium", "large"]) {
    const run = await runWidget({ family });
    const cols = columnsOf(run.widget.node);
    // Each column's children and row heights match
    const heights = (col: any) => col.children.filter((c: any) => c.kind === "stack").map((c: any) => (c.props.size as any)?.h);
    const [a, b] = cols.map(heights);
    const n = Math.min(a!.length, b!.length);
    assert.deepEqual(a!.slice(0, n), b!.slice(0, n), `${family}: ${JSON.stringify([a, b])}`);
    assert.ok(a!.slice(0, n).every((h: number) => h > 0), "heights are fixed");
    // The "—" of a row without a 5-hour limit uses the same font as the remaining number
    const dash = textNodes(cols[0]!).find((x) => x.props.text === "—");
    const pct = textNodes(cols[1]!).find((x) => /^\d+%$/.test(String(x.props.text)));
    assert.deepEqual(dash?.props.font, pct?.props.font, family);
  }
});

test("Header: icon, name and freshness dot are centered; the plan aligns with the name's bottom edge (device feedback)", async () => {
  const run = await runWidget({ family: "medium" });
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const names = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === "Codex"));
  assert.equal(names.props.align, "bottom", "name and plan at the bottom edge");
  assert.ok(texts(names).includes("Pro Lite"), "the plan is in the same group as the name");
  const header = rows(run.widget.node).find((x) => x.children.includes(names));
  assert.equal(header.props.align, "center", "the row is centered");
  assert.equal((header.props.size as any).h, lib.SCALES.medium.header, "header height is fixed");
});

test("Compacting the inline text keeps the est. reset estimate; with two scoped limits the names are shortened", () => {
  const w = (id: string, used: number, extra: any = {}) => ({ id, used_percent: used, remaining_percent: 100 - used, remaining_percent_int: 100 - used, value_status: "fresh", scope: null, ...extra });
  const est = lib.inlineText([
    { provider: "codex", providerName: "Codex", window: w("five_hour", 0, { value_status: "reset_estimated" }) },
    { provider: "claude", providerName: "Claude", window: w("five_hour", 0, { value_status: "reset_estimated" }) },
  ], true, "Demo · ");
  assert.equal((est.match(/est\.|~\d/g) ?? []).length, 2, `estimate marks (est. or ~) kept on both: ${est}`);
  assert.ok(lib.textWidth(est, 11) <= lib.INLINE_WIDTH, `${est}: ${lib.textWidth(est, 11)}`);
  const scoped = lib.inlineText([
    { provider: "codex", providerName: "Codex", window: w("codex_other_seven_day", 12, { scope: "codex_other", value_status: "stale", age_minutes: 26 }) },
    { provider: "claude", providerName: "Claude", window: w("seven_day_fable", 10, { scope: "Fable", value_status: "stale", age_minutes: 26 }) },
  ], true);
  assert.ok(lib.textWidth(scoped, 11) <= lib.INLINE_WIDTH, `${scoped}: ${lib.textWidth(scoped, 11)}`);
  assert.ok(scoped.includes("88%") && scoped.includes("90%") && scoped.startsWith(lib.WARN_MARK), scoped);
});

test("Fixed row heights match the visible-row estimate; inline fits even when both scoped limits are estimated", async () => {
  for (const family of ["small", "medium", "large"]) {
    assert.equal(lib.rowHeightOf(lib.SCALES[family], lib.SIZE_CONTENT[family]), lib.SCALES[family].rowHeight, family);
  }
  // Medium on the smallest screen: two rows fit inside the padding
  const layout = lib.layoutGroups(lib.sanitizeView(sampleView()), "medium", "", NOW, { screen: { width: 320, height: 568 } });
  const s = lib.SCALES.medium;
  const rows = Math.max(...layout.groups.map((g: any) => g.rows.length));
  const need = s.header + s.gapHeader + rows * lib.rowHeightOf(s, lib.SIZE_CONTENT.medium) + (rows - 1) * s.gapRow;
  assert.ok(need <= layout.size.height - 2 * layout.pad, `${need} > ${layout.size.height - 2 * layout.pad}`);
  const w = (id: string, scope: string) => ({ id, used_percent: 0, remaining_percent: 100, remaining_percent_int: 100, value_status: "reset_estimated", scope });
  const text = lib.inlineText([
    { provider: "codex", providerName: "Codex", window: w("codex_other_seven_day", "codex_other") },
    { provider: "claude", providerName: "Claude", window: w("seven_day_fable", "Fable") },
  ], true);
  assert.ok(lib.textWidth(text, 11) <= lib.INLINE_WIDTH, `${text}: ${lib.textWidth(text, 11)}`);
  assert.ok(text.startsWith(lib.WARN_MARK) && (text.match(/~\d/g) ?? []).length === 2, text);
});

test("Medium/large Not available is left-aligned (the row width is fixed, so a flexible spacer follows)", async () => {
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  for (const family of ["medium", "large"]) {
    const run = await runWidget({ family });
    const sub = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === lib.NOT_AVAILABLE));
    assert.equal(sub.children[0].props.text, lib.NOT_AVAILABLE, family);
    assert.equal(sub.children.at(-1).kind, "spacer", `${family}: trailing flexible spacer`);
    assert.equal(sub.children.at(-1).props.length, null);
  }
});

test("If no provider shown in large has a weekly limit, no chart height is reserved and those rows are shown instead", () => {
  // Claude only, with no weekly limit: a 5-hour limit and three per-model weekly limits (4 rows in total)
  const view = lib.sanitizeView(sampleView());
  const c = view.claude;
  const scoped = c.windows.seven_day_fable;
  for (const id of ["seven_day_opus", "seven_day_sonnet"]) c.windows[id] = { ...scoped, id };
  delete c.windows.seven_day;
  c.window_ids = ["five_hour", "seven_day_fable", "seven_day_opus", "seven_day_sonnet"];
  c.main_window_ids = c.main_window_ids.filter((id: string) => id !== "seven_day");
  const screen = { width: 320, height: 568 };
  const layout = lib.layoutGroups(view, "large", "claude", NOW, { screen });
  assert.equal(layout.trendHeight, 0, "no height for a chart that isn't drawn");
  assert.deepEqual(plain(layout.groups[0].rows.map((r: any) => r.window.id)), c.window_ids, "all 4 rows shown");
  // With a weekly limit, chart height is reserved
  const withWeek = lib.layoutGroups(lib.sanitizeView(sampleView()), "large", "claude", NOW, { screen });
  assert.ok(withWeek.trendHeight > 0);
});

test("The large chart runs from this week's Sunday to Saturday in local time, with a label under each day", async () => {
  const range = lib.weekRange(NOW);
  const start = new Date(range.start);
  assert.equal(start.getDay(), 0, "starts on Sunday");
  assert.equal(start.getHours() + start.getMinutes() + start.getSeconds() + start.getMilliseconds(), 0, "at local midnight");
  assert.ok(range.start <= NOW.getTime() && NOW.getTime() < range.end);
  const end = new Date(range.end);
  assert.equal(end.getDay(), 0);
  assert.equal(plain(lib.dayStarts(range)).length, 6);
  // Points before Sunday or from next week aren't drawn; one at the start of the week is at the left edge
  const lines = plain(lib.sparkLines([
    { at: range.start - 3600000, used: 50, brk: false },
    { at: range.start, used: 10, brk: false },
    { at: range.end + 5000, used: 20, brk: false },
  ], NOW, 260, 60, 3, 168, range));
  assert.deepEqual(lines.map((l: number[][]) => l.length), [1]);
  assert.equal(lines[0][0][0], 3);
  // Every day starts at its own local midnight
  for (const t of range.days) assert.equal(new Date(t).getHours() + new Date(t).getMinutes(), 0);
  const run = await runWidget({ family: "large", responder: historyFor([{ at: "2026-11-16T12:00:00.000Z", used_percent: 4 }]) });
  const all = texts(run.widget.node);
  for (const day of lib.WEEKDAYS) assert.ok(all.includes(day), `${day}: ${all.join(" | ")}`);
});

test("Without points this week, the legend says there is no weekly data yet", async () => {
  const range = lib.weekRange(NOW);
  const run = await runWidget({ family: "large", responder: historyFor([{ at: new Date(range.start - 60000).toISOString(), used_percent: 4 }]) });
  assert.ok(texts(run.widget.node).includes("No weekly data yet"), texts(run.widget.node).join(" | "));
});
