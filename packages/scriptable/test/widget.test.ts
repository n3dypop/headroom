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

/** The id of the settings generation the Keychain names now (null: settings of an earlier version, or none) */
function currentId(k: Map<string, string>): string | null {
  const current = k.get(lib.KEYCHAIN_CURRENT);
  return current === undefined ? null : JSON.parse(current).id;
}

/** The settings saved now, in either form (a generation's own item, or the single item of earlier versions); null without */
function savedConfig(k: Map<string, string>): any {
  const id = currentId(k);
  const text = id === null ? k.get(lib.KEYCHAIN_CONFIG) : k.get(`headroom.config.${id}`);
  return text === undefined ? null : JSON.parse(text);
}

/** The Keychain's item names (seen markers left out), with the current generation's id shown as <id> */
function itemNames(k: Map<string, string>): string[] {
  const id = currentId(k);
  return [...k.keys()].filter((x) => !x.startsWith("headroom.seen.")).map((x) => (id ? x.replace(id, "<id>") : x)).sort();
}

/** Settings saved by another run of this version: their own items, then the item naming them */
function saveAs(k: Map<string, string>, config: string, switches: string | null = null): void {
  const id = JSON.parse(config).id;
  if (switches !== null) k.set(`headroom.notify.${id}`, switches);
  k.set(`headroom.config.${id}`, config);
  k.set(lib.KEYCHAIN_CURRENT, JSON.stringify({ id }));
}

/** The stored switches of the settings saved now (their generation's item, or the shared one of earlier versions); null without */
function savedSwitches(k: Map<string, string>): string | null {
  const id = currentId(k);
  return k.get(id === null ? lib.KEYCHAIN_NOTIFY : `headroom.notify.${id}`) ?? null;
}
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
  assert.equal(lib.atDisplayTime(w, new Date("2026-11-16T13:19:00.000Z")).value_status, "fresh", "20 minutes: fresh");
  assert.equal(lib.atDisplayTime(w, new Date("2026-11-16T14:14:00.000Z")).value_status, "stale", "75 minutes: stale");
  const old = lib.atDisplayTime(w, new Date("2026-11-16T14:15:00.000Z"));
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
  // a limit named: that one of each provider named, in their order (Codex has no 5h)
  assert.deepEqual(keys(view, "claude, codex, wk"), ["claude.seven_day", "codex.seven_day"]);
  assert.deepEqual(keys(view, "5h"), ["claude.five_hour"]);
  assert.deepEqual(keys(view, "WK  Claude"), ["claude.seven_day"], "any order, case and separator");
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

/** Whether the stand-in stacks have addRefreshButton (Scriptable 1.8 or newer), per run */
let refreshButtons = false;
/** A Scriptable 1.8 whose stack action fails (the refresh control must not stay as words that can't be tapped) */
let actionThrows = false;

function makeStack(kind: string): any {
  const node = new Node(kind);
  const refresh = refreshButtons
    ? { addRefreshButton(title: string) { node.children.push(new Node("refresh", { title })); }, setAction(title: string, o: { id: string }) { if (actionThrows) throw new Error("no action"); node.props.action = { title, id: o.id }; } }
    : {};
  return {
    ...refresh,
    node,
    layoutHorizontally() { node.props.dir = "h"; }, layoutVertically() { node.props.dir = "v"; },
    centerAlignContent() { node.props.align = "center"; }, topAlignContent() { node.props.align = "top"; }, bottomAlignContent() { node.props.align = "bottom"; },
    setPadding(...a: number[]) { node.props.padding = a; },
    set size(v: any) { node.props.size = v; },
    set backgroundColor(v: any) { node.props.background = v; },
    set url(v: string) { node.props.url = v; },
    get url() { return node.props.url as string; },
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
      const n = new Node("image", { fills: img.fills, symbol: img.symbol ?? img.icon?.symbol, data: img.data ?? img.icon?.data, strokes: img.strokes, size: img.size, widths: img.widths, ellipses: img.ellipses, ring: img.ellipses > 0, drawnTexts: img.texts, iconRect: img.iconRect });
      node.children.push(n);
      return { set resizable(v: boolean) { n.props.resizable = v; }, set imageSize(v: unknown) { n.props.imageSize = v; }, set tintColor(v: any) { n.props.tint = v?.hex; } };
    },
    addDate(date: Date) {
      const d = new Node("date", { date: date.toISOString() });
      node.children.push(d);
      return { applyTimerStyle() { d.props.timer = true; }, set font(v: any) { d.props.font = v; }, set textColor(_v: unknown) {}, set lineLimit(_v: unknown) {},
        set minimumScaleFactor(v: number) { d.props.minScale = v; }, rightAlignText() { d.props.align = "right"; } };
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
  onLoad?: (keychain: Map<string, string>, url: string) => void;
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
  /**
   * Test only: draw this sample as the app's Widget › Preview sample data does (render(demoResult(...)) with the parameter given, else
   * the sample's own), in place of the widget's run
   */
  demo?: string;
  /** Device screen width (Device.screenSize; omit for no Device) */
  screen?: number;
  /** Device.systemVersion (gives a Device without a screen size when no screen is given) */
  systemVersion?: string;
  /** Image.fromData returns null (broken image) */
  badImage?: boolean;
  /** Response per URL (return undefined to use response) */
  responder?: (url: string) => { status: number; body: unknown } | undefined;
  /** Run outside a widget without the menu (opened by a URL or a shortcut) */
  inApp?: boolean;
  /** args.queryParameters (opened by a URL) and args.shortcutParameter */
  query?: Record<string, string>;
  shortcut?: unknown;
  /** Device files and notifications kept across runs (a new set when omitted) */
  files?: Map<string, string>;
  notifier?: Notifier;
  /** URLScheme.forRunningScript() (null: no URLScheme) */
  scriptUrl?: string | null;
  /** Make Notification.schedule fail */
  scheduleFails?: boolean;
  /** Make FileManager.listContents fail */
  listFails?: boolean;
  /** Let this many Notification.schedule calls succeed, then fail */
  scheduleFailsAfter?: number;
}

/** Notifications on the stub device: pending (with a trigger), delivered, and everything scheduled in order */
interface Notifier {
  pending: Map<string, any>;
  delivered: Map<string, any>;
  log: any[];
}
const newNotifier = (): Notifier => ({ pending: new Map(), delivered: new Map(), log: [] });

async function runWidget(opts: RunOptions) {
  refreshButtons = Boolean((opts as any).refreshButtons);
  actionThrows = Boolean((opts as any).actionThrows);
  const keychain = new Map(Object.entries(opts.keychain ?? { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" }));
  const sheets = Array.isArray(opts.app?.menu) ? [...opts.app!.menu] : [];
  const shownSizes: string[] = [];
  const files = opts.files ?? new Map<string, string>();
  const notifier = opts.notifier ?? newNotifier();
  const webPages: string[] = [];
  const alertTitles: string[] = [];
  const actionLabels: string[] = [];
  let deliveredCalls = 0;
  const copied: string[] = [];
  let shortcutOutput: unknown = undefined;
  for (const c of [...(opts.cached ? [opts.cached] : []), ...(opts.cachedMany ?? [])]) {
    files.set(`/docs/${lib.cacheFileName(lib.cacheTag({ id: lib.DEFAULT_CONFIG_ID }, JSON.parse(c).origin), JSON.parse(c).view.data_version)}`, c);
  }
  for (const name of opts.extraFiles ?? []) files.set(`/docs/${name}`, "");
  const requests: any[] = [];
  const listed = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
  let shown: any = null;
  class Color {
    hex: string;
    alpha: number;
    constructor(hex: string, alpha = 1) { this.hex = hex; this.alpha = alpha; }
    static dynamic(light: Color, dark?: Color) { return Object.assign(new Color(light.hex), { dynamic: true, dark: dark?.hex }); }
  }
  const presented: any[] = [];
  const clock = { now: opts.now ?? NOW };
  const globals = {
    console, Intl, Math, JSON, encodeURIComponent, Number, String, Object, Boolean, structuredClone,
    Date: fixedDate(clock),
    config: { runsInWidget: !opts.app && !opts.inApp, widgetFamily: opts.family },
    args: { widgetParameter: opts.parameter ?? null, queryParameters: opts.query ?? {}, shortcutParameter: opts.shortcut ?? null },
    Script: { setWidget(w: any) { shown = w; }, complete() {}, setShortcutOutput(v: unknown) { shortcutOutput = v; } },
    ...(opts.scriptUrl === null ? {} : { URLScheme: { forRunningScript: () => opts.scriptUrl ?? "scriptable:///run/Headroom" } }),
    Notification: class {
      identifier = ""; title = ""; body = ""; threadIdentifier = ""; sound: string | null = null; openURL: string | null = null; userInfo: any = {};
      trigger: Date | null = null;
      setTriggerDate(d: Date) { this.trigger = d; }
      async schedule() {
        (opts as any).onSchedule?.(this.identifier, notifier, files);
        if (opts.scheduleFails) throw new Error("not allowed");
        if (opts.scheduleFailsAfter !== undefined && notifier.log.length >= opts.scheduleFailsAfter) throw new Error("failed");
        const n = { id: this.identifier, title: this.title, body: this.body, openURL: this.openURL, trigger: this.trigger?.getTime() ?? null, at: clock.now.getTime(), userInfo: this.userInfo };
        notifier.log.push(n);
        if (n.trigger !== null) notifier.pending.set(n.id, n);
        else notifier.delivered.set(n.id, n);
      }
      static async allPending() {
        if ((opts as any).pendingFails) throw new Error("notifications");
        (opts as any).onAllPending?.(keychain, notifier);
        return [...notifier.pending.values()].map((n) => ({ identifier: n.id }));
      }
      static async allDelivered() {
        deliveredCalls++;
        if ((opts as any).deliveredFailsOnCall === deliveredCalls) throw new Error("notifications");
        (opts as any).onAllDelivered?.(notifier, deliveredCalls);
        return [...notifier.delivered.values()].map((n) => ({ identifier: n.id, title: n.title, body: n.body, userInfo: n.userInfo ?? {} }));
      }
      static async removePending(ids: string[]) {
        for (const id of ids) notifier.pending.delete(id);
        // removed, then the run stops (nothing after it in that run)
        if ((opts as any).removePendingThenFails) throw new Error("stopped");
      }
      static async removeDelivered(ids: string[]) { for (const id of ids) notifier.delivered.delete(id); }
    },
    Pasteboard: { copyString: (text: string) => { copied.push(text); } },
    WebView: class {
      async loadHTML(html: string) { webPages.push(html); (opts as any).onLoadHTML?.(keychain); }
      async present() {}
    },
    // Scriptable also defines module (exports is an empty object) for every script. main must still run
    module: { exports: {} },
    Keychain: {
      contains: (k: string) => {
        (opts as any).onKeychainContains?.(keychain, k);
        return keychain.has(k);
      },
      get: (k: string) => {
        if (opts.keychainGetFails || (opts as any).keychainGetFailsFor === k || (opts as any).keychainGetFailsWhen?.(k)) throw new Error("removed");
        return keychain.get(k);
      },
      set: (k: string, v: string) => { if (opts.keychainSetFails) throw new Error("keychain"); (opts as any).onKeychainSet?.(k, v); keychain.set(k, v); },
      remove: (k: string) => {
        if ((opts as any).removeKeychainFails) throw new Error("keychain");
        (opts as any).keychainRemove?.(k);
        return keychain.delete(k);
      },
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
        opts.onLoad?.(keychain, this.url);
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
          if (opts.writeFails || opts.writeFailsFor?.test(p) || (opts as any).writeFailsWhen?.(p, s)) throw new Error("disk");
          files.set(p, s);
          opts.onWrite?.(p, files);
        },
        readString: (p: string) => {
          if ((opts as any).readFailsWhen?.(p)) throw new Error("disk");
          return files.get(p);
        },
        fileExists: (p: string) => files.has(p),
        remove: (p: string) => { if (opts.removeFails) throw new Error("disk"); files.delete(p); },
        listContents: (dir: string) => { if (opts.listFails || (opts as any).listFailsWhen?.()) throw new Error("disk"); return listed(dir); },
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
          async presentAccessoryRectangular() { shown = root; shownSizes.push("accessoryRectangular"); },
          async presentAccessoryCircular() { shown = root; shownSizes.push("accessoryCircular"); },
          async presentAccessoryInline() { shown = root; shownSizes.push("accessoryInline"); },
        });
      }
    },
    DrawContext: class {
      size: unknown; opaque = true; respectScreenScale = false; fills: unknown[] = []; strokes = 0; widths: number[] = [];
      addPath() {} setFillColor(c: unknown) { this.fills.push(c); } fillPath() {}
      setStrokeColor() {} setLineWidth(w: number) { this.widths.push(w); } strokePath() { this.strokes++; } strokeRect() { this.strokes++; } fillEllipse() {}
      strokeEllipse() { this.ellipses++; } ellipses = 0; drawn: any[] = []; iconRects: any[] = []; drawImageInRect(img: any, rect: any) { this.drawn.push(img); this.iconRects.push(rect); }
      texts: string[] = []; setFont() {} setTextColor() {} setTextAlignedCenter() {} drawTextInRect(text: string) { this.texts.push(text); } drawText(text: string) { this.texts.push(text); }
      getImage() { return { fills: this.fills, strokes: this.strokes, size: this.size, widths: this.widths, ellipses: this.ellipses, icon: this.drawn[0], iconRect: this.iconRects[0], texts: this.texts }; }
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
    ...(opts.screen || opts.systemVersion ? { Device: {
      ...(opts.screen ? { screenSize: () => ({ width: opts.screen, height: ({ 430: 932, 393: 852, 390: 844, 375: 812, 320: 568 } as Record<number, number>)[opts.screen!] ?? 900 }) } : {}),
      systemVersion: () => opts.systemVersion ?? "26.0",
    } } : {}),
    Data: { fromBase64String: (s: string) => ({ base64: s }) },
    Image: { fromData: (d: { base64: string }) => (opts.badImage ? null : { data: d.base64 }) },
    Alert: class {
      title = ""; message = "";
      fields: string[] = [];
      addAction(label: string) { actionLabels.push(label); } addDestructiveAction(label: string) { actionLabels.push(label); } addCancelAction() {}
      addTextField() { this.fields.push(""); } addSecureTextField() { this.fields.push(""); }
      async presentSheet() {
        presented.push("menu");
        (opts as any).onSheet?.(keychain, presented.filter((p) => p === "menu").length);
        // A number picks the same option every time; an array picks in order (Cancel once exhausted)
        return Array.isArray(opts.app?.menu) ? (sheets.shift() ?? -1) : opts.app?.menu ?? 0;
      }
      async present() { presented.push(this.fields.length ? "form" : "notice"); alertTitles.push(this.title); (opts as any).beforeConfirm?.(keychain); return (opts as any).answers?.shift() ?? 0; }
      textFieldValue(i: number) { return opts.app?.form?.[i] ?? ""; }
    },
  };
  const demoHook = `async function main() {
  if (typeof __demo !== "undefined") {
    const now = new Date();
    Script.setWidget(render(demoResult(__demo.name, now), config.widgetFamily, __demo.parameter ?? demoParameter(__demo.name), now));
    Script.complete();
    return;
  }`;
  const source = opts.demo ? (opts.code ?? code).replace("async function main() {", demoHook) : opts.code ?? code;
  const demoGlobals = opts.demo ? { __demo: { name: opts.demo, parameter: opts.parameter ?? null } } : {};
  const context = vm.createContext({ ...globals, ...demoGlobals, ...((opts as any).globals ?? {}) });
  let error: unknown = null;
  try {
    await vm.runInContext(`(async () => {\n${source}\n})()`, context);
  } catch (e) {
    error = e;
  }
  return { widget: shown, requests, files, keychain, presented, error, shownSizes, notifier, webPages, shortcutOutput, copied, alertTitles, actionLabels };
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
  assert.ok(all.includes("Claude") && all.includes("Codex"), all.join(" | "));
  assert.ok(!all.includes("Max") && !all.includes("Pro Lite"), "the plans are in the details only");
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
  assert.ok(all.some((x) => /^\w{3} \d{2}:\d{2}$/.test(x)), "later ones are weekday and time on the 24-hour clock (Fri 16:00)");
  assert.ok(!all.some((x) => /\b[AP]M\b/.test(x)), "no AM or PM anywhere");
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
  assert.ok(all.includes("Reset"), "the time row keeps ↻ and says Reset once the reset time has passed");
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
  const run = await runWidget({ family: "medium", keychain, cached, app: { menu: [3, 0], form: ["https://new.example", "new-token"] } });
  const saved = savedConfig(run.keychain);
  assert.deepEqual([saved.url, saved.token, "accessId" in saved], ["https://new.example", "new-token", false]);
  assert.deepEqual(itemNames(run.keychain), ["headroom.config.<id>", "headroom.current", "headroom.notify.<id>"], "older versions' separate items are not kept");
  assert.equal(run.requests.length, 0, "saving goes back to the menu without fetching");
  assert.ok(!latestCache(run.files)?.includes("old.example"), "the old server's values are not kept");
  // An empty token is not saved (the previous settings remain)
  const empty = await runWidget({ family: "medium", keychain, app: { menu: [3, 0], form: ["https://new.example", ""] } });
  assert.ok(currentId(empty.keychain) === null && !empty.keychain.has("headroom.config"), "not saved when the token is empty");
  assert.equal(empty.keychain.get("headroom.url"), "https://old.example");
  // Delete settings
  const removed = await runWidget({ family: "medium", keychain, cached, app: { menu: [3, 2, 1] } });
  assert.equal(removed.keychain.size, 0);
  assert.equal(removed.files.size, 0);
});

test("A valid response with both providers null replaces the previous view; a malformed response doesn't overwrite it", async () => {
  assert.deepEqual(plain(lib.sanitizeView({ view_version: 1, data_version: 11, claude: null, codex: null })), { view_version: 1, data_version: 11, boundaries: null, claude: null, codex: null, gemini: null }, "a view of an earlier Worker, without Gemini");
  assert.equal(lib.sanitizeView({ view_version: 1, data_version: 11, claude: null, codex: null, gemini: { windows: [] } }), null, "a malformed later provider is invalid too");
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
  const saved = await runWidget({ family: "medium", keychain, app: { menu: [3, 0], form: ["https://new.example", "new-token", "", ""] } });
  assert.deepEqual(itemNames(saved.keychain), ["headroom.config.<id>", "headroom.current", "headroom.notify.<id>"]);
  const failed = await runWidget({ family: "medium", keychain, keychainSetFails: true, app: { menu: [3, 0], form: ["https://new.example", "new-token", "", ""] } });
  assert.equal(failed.error, null);
  assert.ok(failed.presented.includes("notice"), "says it couldn't save");
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
  const removed = await runWidget({ family: "medium", keychain, extraFiles: [...own, ...user], app: { menu: [3, 2, 1] } });
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
  const saved = await runWidget({ family: "medium", keychain, app: { menu: [3, 0], form: ["https://headroom.example.com", "t", "", ""] } });
  const newId = savedConfig(saved.keychain).id;
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


test("Shows there is no 5h limit only for providers whose values were fetched; not when fetching failed; a limit named says so in its place", async () => {
  const groups = (v: unknown, param = "") => plain(lib.groupsOf(lib.sanitizeView(v), param, NOW));
  const view = sampleView();
  const codex = groups(view).find((g: any) => g.provider === "codex");
  assert.deepEqual(codex.rows[0], { kind: "missing", text: "Not available" });
  assert.equal(groups(view).find((g: any) => g.provider === "claude").rows[0].window.id, "five_hour", "Claude has a 5h limit");
  const failed = structuredClone(view);
  failed.codex!.status = "error";
  assert.ok(!JSON.stringify(groups(failed)).includes("Not available"), "doesn't claim it's missing when fetching failed");
  assert.ok(!JSON.stringify(groups(view, "codex, wk")).includes("Not available"), "Codex has its weekly limit");
  assert.deepEqual(groups(view, "codex, 5h")[0].rows, [{ kind: "missing", text: "Not available", label: "5h limit", fitLabel: "5h limit" }], "the 5h named: none");
  assert.ok(JSON.stringify(groups(view, "codex")).includes("Not available"));
  // Small uses the shortest limit every provider has (the weekly, Codex having no 5h), so it never needs Not available
  const small = await runWidget({ family: "small" });
  const st = texts(small.widget.node);
  assert.ok(st.filter((x) => x === "Wk limit").length === 2 && !st.includes("—"), st.join(" | "));
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

test("A provider stopped by an access denial shows only the stop (also with values), in the details with what to do, and notifies", () => {
  const view = sampleView() as any;
  view.codex.status = "error";
  view.codex.error_code = "access_denied";
  const clean = lib.sanitizeView(view);
  assert.deepEqual(plain([clean.codex.window_ids, Object.keys(clean.codex.windows)]), [[], []], "none of its values reads as current");
  for (const parameter of ["", "codex", "top", "codex.five_hour,claude.five_hour"]) {
    const groups = plain(lib.groupsOf(clean, parameter, NOW));
    const codex = groups.find((g: any) => g.provider === "codex");
    if (codex) assert.equal(codex.message, "Access denied", parameter);
  }
  assert.equal(lib.SHORT_ERROR_NAMES.access_denied, "Denied");
  assert.match(lib.detailHtml({ view: clean, events: null, trends: {}, now: NOW, provider: null, note: "" }), /Access denied[\s\S]*--resume-access/);
  const told = { limits: [], warned: [] };
  const alerts = lib.selectAlerts([ev(1, "provider_error", { window_id: null, provider: "codex", error_code: "access_denied" })], null, NOTE_NOW, { told, times: true });
  assert.deepEqual(plain(titles(alerts)), [`codex ${S.runout} Access denied`]);
});


test("Large stacks full-width groups top to bottom (no confidence row); small packs two providers (no timers)", async () => {
  const large = await runWidget({ family: "large", now: new Date("2026-11-16T13:30:00.000Z") });
  const l = texts(large.widget.node);
  assert.ok(!l.some((t) => t.includes("Recent:") || t.includes("Forecast:")), l.join(" | "));
  assert.ok(!l.includes("32m"), `when old, the header dot shows no age (the details page does):${l.join(" | ")}`);
  assert.equal(large.widget.node.children.some((c: Node) => c.kind === "stack" && c.children.filter((x) => x.kind === "stack").length === 2 && texts(c).includes("Claude") && texts(c).includes("Codex")), false, "not two side-by-side columns");
  const small = await runWidget({ family: "small" });
  const all = texts(small.widget.node);
  assert.ok(all.includes("Claude") && all.includes("Codex") && all.includes("98%"), all.join(" | "));
  assert.equal(JSON.stringify(small.widget.node).includes('"timer":true'), false);
});

test("Icons: there is a line for scripts/build.ts to embed into, and embedded images are used when present", async () => {
  const marker = /^const ICONS = \{ claude: "", codex: "", gemini: "" \}; \/\/ @icons$/m;
  assert.ok(marker.test(code), "the line build.ts replaces");
  const embedded = code.replace(marker, () => `const ICONS = {"claude":"QUJD","codex":"","gemini":""};`);
  const run = await runWidget({ family: "medium", code: embedded });
  const icons = images(run.widget.node).filter((n) => n.props.data || n.props.symbol);
  const statusSymbols = Object.values(lib.TIME_SYMBOLS) as string[];
  assert.deepEqual(icons.filter((n) => !statusSymbols.includes(n.props.symbol as string)).map((n) => n.props.data ?? n.props.symbol), ["terminal", "QUJD"], "Claude uses the embedded image, Codex SF Symbols");
});

test("Icons: a second set embedded beside the first; Settings › Display switches each provider's icon on every widget, for the whole iPhone", async () => {
  const marker = /^const ICONS = \{ claude: "", codex: "", gemini: "" \}; \/\/ @icons$/m;
  const altMarker = /^const ALT_ICONS = \{ claude: "", codex: "", gemini: "" \}; \/\/ @alt-icons$/m;
  assert.ok(altMarker.test(code), "the line build.ts replaces");
  const embedded = code.replace(marker, () => `const ICONS = {"claude":"QUJD","codex":"","gemini":""};`)
    .replace(altMarker, () => `const ALT_ICONS = {"claude":"Q0w=","codex":"T1BFTg==","gemini":""};`);
  const statusSymbols = Object.values(lib.TIME_SYMBOLS) as string[];
  const used = (run: any) => images(run.widget.node).filter((n) => (n.props.data || n.props.symbol) && !statusSymbols.includes(n.props.symbol as string))
    .map((n) => n.props.data ?? n.props.symbol);
  const signedIn = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  // not chosen: the default set
  assert.deepEqual(plain(used(await runWidget({ family: "medium", code: embedded }))), ["terminal", "QUJD"]);
  // chosen for Codex only: Codex's second icon, Claude its first
  const chosen = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "codex" } });
  assert.deepEqual(plain(used(chosen)), ["T1BFTg==", "QUJD"]);
  // for Claude only
  const claudeOnly = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "claude" } });
  assert.deepEqual(plain(used(claudeOnly)), ["terminal", "Q0w="]);
  // saved by an earlier version ("alt"): every provider's second, where it has one
  const all = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "alt" } });
  assert.deepEqual(plain(used(all)), ["T1BFTg==", "Q0w="]);
  // the lock screen too
  const lock = await runWidget({ family: "accessoryRectangular", parameter: "codex, wk", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "alt" } });
  assert.ok(images(lock.widget.node).some((n) => n.props.ring && n.props.data === "T1BFTg=="), "the ring's icon");
  // without a second set the choice changes nothing, and Settings has no switch
  const noSecond = await runWidget({ family: "medium", keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "alt" } });
  assert.deepEqual(plain(used(noSecond)), plain(used(await runWidget({ family: "medium" }))));
  const plainMenu = await runWidget({ family: "medium", app: { menu: [3, 1] } });
  assert.ok(!plainMenu.actionLabels.some((l: string) => l.includes(" icon: ")), plainMenu.actionLabels.join(" | "));
  // Settings › Display: a line for each provider with a second icon (Codex, then Claude), each switched on its own
  const on = await runWidget({ family: "medium", code: embedded, app: { menu: [3, 1, 2] } });
  assert.ok(on.actionLabels.includes("Codex icon: Default") && on.actionLabels.includes("Claude icon: Default"), on.actionLabels.join(" | "));
  assert.ok(!on.actionLabels.some((l: string) => l.startsWith("Gemini icon")), "no line without a second icon");
  assert.equal(on.keychain.get(lib.KEYCHAIN_ICONS), "claude");
  assert.ok(on.actionLabels.includes("Claude icon: Alternate"), "the menu shows the new choice");
  const both = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "claude" }, app: { menu: [3, 1, 1] } });
  assert.equal(both.keychain.get(lib.KEYCHAIN_ICONS), "codex,claude");
  const off = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "claude" }, app: { menu: [3, 1, 2] } });
  assert.equal(off.keychain.has(lib.KEYCHAIN_ICONS), false, "all on their first: no item left");
  // Remove all settings also removes the choice
  const removed = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "codex" }, app: { menu: [3, 2, 1] } });
  assert.ok(!removed.keychain.has("headroom.url") && !removed.keychain.has(lib.KEYCHAIN_ICONS), [...removed.keychain.keys()].join(" | "));
});

test("Icons: each is cut to what is visible; a wide one is drawn wider and shorter, as large to the eye as a square one", async () => {
  // a PNG header of the given size, as base64 (the widget reads the shape from it)
  const png = (w: number, h: number) => {
    const head = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
    head.writeUInt32BE(13, 8);
    head.write("IHDR", 12, "latin1");
    head.writeUInt32BE(w, 16);
    head.writeUInt32BE(h, 20);
    return Buffer.concat([head, Buffer.from([8, 6, 0, 0, 0, 0, 0, 0])]).toString("base64");
  };
  assert.equal(lib.pngAspect(png(128, 82)), 128 / 82);
  assert.equal(lib.pngAspect(png(128, 128)), 1);
  assert.equal(lib.pngAspect("QUJD"), 1, "too short to read: square");
  assert.equal(lib.pngAspect("!!!!" + png(128, 82).slice(4)), 1, "not base64: square");
  // the same area as the square: wider and shorter; at most 1.5 × as wide; a tall one fits the height
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const wide = lib.iconBox(1.6, 20);
  assert.ok(near(wide.w * wide.h, 400) && near(wide.w / wide.h, 1.6), JSON.stringify(wide));
  assert.deepEqual(plain(lib.iconBox(1, 20)), { w: 20, h: 20 });
  const long = lib.iconBox(4, 20);
  assert.ok(near(long.w, 30) && near(long.w / long.h, 4), JSON.stringify(long));
  assert.deepEqual(plain(lib.iconBox(0.5, 20)), { w: 10, h: 20 });
  // on the widget: a wide Claude icon in the header, drawn wider at the square's area
  const marker = /^const ICONS = \{ claude: "", codex: "", gemini: "" \}; \/\/ @icons$/m;
  const embedded = code.replace(marker, () => `const ICONS = {"claude":"${png(128, 80)}","codex":"${png(64, 64)}","gemini":""};`);
  const run = await runWidget({ family: "medium", code: embedded });
  const sizeOf = (data: string) => images(run.widget.node).find((n) => n.props.data === data)!.props.imageSize as any;
  const claude = sizeOf(png(128, 80)), codex = sizeOf(png(64, 64));
  assert.ok(near(claude.w / claude.h, 1.6) && near(claude.w * claude.h, codex.w * codex.h), JSON.stringify([claude, codex]));
  assert.equal(codex.w, codex.h, "a square one as before");
  // in a ring: the same shape, centred where the square icon was
  const lock = await runWidget({ family: "accessoryRectangular", parameter: "claude, wk", code: embedded });
  const ring = images(lock.widget.node).find((n) => n.props.ring)!;
  const rect = ring.props.iconRect as any;
  const geom = lib.LOCK_RINGS.rectangular;
  assert.ok(near(rect.w / rect.h, 1.6) && near(rect.w * rect.h, geom.icon ** 2), JSON.stringify(rect));
  assert.ok(near(rect.x + rect.w / 2, geom.size / 2) && near(rect.y + rect.h / 2, geom.size / 2), "centred");
  // on the details page: the wide one's box is wider at the same height
  assert.ok(!/width:calc/.test(lib.iconCss()), "no embedded icons: tiles as before");
  const module = { exports: {} as Lib };
  vm.runInContext(`(async () => {\n${embedded}\n})()`, vm.createContext({ module, console, Intl, Date, Math, JSON, encodeURIComponent, Number, String, Object, Boolean }));
  const css: string = module.exports.iconCss();
  const factor = Math.round(Math.sqrt(1.6) * 1000) / 1000;
  assert.ok(css.includes(`center/contain no-repeat;width:calc(var(--s)*${factor});margin:0 calc(var(--s)*0)}`), css.replace(/base64,[^)]*/g, "…"));
  // every icon in the slot of the widest (its width and side margins add up to it): a square one centred with margins, and an
  // element without a provider's icon too; so in the history's rows and the headers, what follows an icon starts at one place
  const margin = Math.round(((factor - 1) / 2) * 1000) / 1000;
  assert.ok(new RegExp(`\\.ic-codex\\{background:url\\([^)]*\\) center/contain no-repeat;margin:0 calc\\(var\\(--s\\)\\*${margin}\\)\\}`).test(css), css.replace(/base64,[^)]*/g, "…"));
  assert.ok(css.startsWith(`.ic{margin:0 calc(var(--s)*${margin})}`), "the base (an event without a provider)");
  assert.ok(new RegExp(`\\.ic-gemini\\{background:#[0-9A-Fa-f]{6};border-radius:28%;margin:0 calc\\(var\\(--s\\)\\*${margin}\\)\\}`).test(css), "a tile too");
  assert.equal(module.exports.iconSlot(), Math.sqrt(1.6));
  assert.equal(lib.iconSlot(), 1, "all square: no slot wider than the icon");
  // the home header: the square icon centred in a slot as wide as the wide one, so the names start at the same place
  const stacks = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(stacks)];
  const before = (data: string) => {
    const header = stacks(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "image" && c.props.data === data))!;
    const lead = header.children.slice(0, header.children.findIndex((c: any) => c.kind === "stack"));
    return lead.reduce((sum: number, c: any) => sum + (c.kind === "spacer" ? c.props.length : (c.props.imageSize as any).w), 0);
  };
  assert.ok(near(before(png(128, 80)), before(png(64, 64))), String([before(png(128, 80)), before(png(64, 64))]));
});

test("A limit named that a provider hasn't, with another named, draws in every size; notify after spaces; only the table's words; no history without a chart", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("no5h", now).view;
  const no5h = { status: 200, body: { ...view, data_version: 1, view_version: 1 } };
  for (const [parameter, rows] of [["codex, 5h, wk", ["missing", "seven_day"]], ["codex, wk, 5h", ["seven_day", "missing"]]] as const) {
    for (const family of ["small", "medium", "large"]) {
      const run = await runWidget({ family, parameter, response: no5h, now });
      assert.equal(run.error, null, `${parameter} ${family}: ${run.error}`);
    }
    const codex = lib.groupsOf(view, parameter, now).find((g: any) => g.provider === "codex");
    assert.deepEqual(plain(codex.rows.map((r: any) => (r.kind === "window" ? r.window.id : r.kind))), rows, parameter);
  }
  // notify after spaces, as after commas (as the parameter is read)
  assert.deepEqual(plain(lib.splitNotify("claude 5h notify")), { display: "claude, 5h", notify: true });
  assert.deepEqual(plain(lib.splitNotify("claude, 5h, notify")), { display: "claude, 5h", notify: true });
  assert.equal(lib.splitNotify("claude 5h").notify, false);
  // a word an object has of its own (constructor) is unknown, not a limit
  const q = lib.parseParameter("codex, constructor");
  assert.deepEqual(plain([q.limits, q.unknown]), [[], ["constructor"]]);
  // no weekly history is read for a large widget that draws no chart (most)
  const three = lib.demoResult("three", now).view;
  assert.deepEqual(plain(lib.trendWindows(three, "large", "most, 5h", now)), {});
  assert.ok(Object.keys(lib.trendWindows(three, "large", "", now)).length > 0, "the chart's histories otherwise");
});

test("Settings › Display: an icon setting that can't be read is left as it is; a saved provider without a second icon keeps its place", async () => {
  const marker = /^const ICONS = \{ claude: "", codex: "", gemini: "" \}; \/\/ @icons$/m;
  const altMarker = /^const ALT_ICONS = \{ claude: "", codex: "", gemini: "" \}; \/\/ @alt-icons$/m;
  const embedded = code.replace(marker, () => `const ICONS = {"claude":"QUJD","codex":"","gemini":""};`)
    .replace(altMarker, () => `const ALT_ICONS = {"claude":"Q0w=","codex":"T1BFTg==","gemini":""};`);
  const signedIn = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  // Codex's line while the setting can't be read: nothing written, said so
  const unread = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "codex,claude" },
    keychainGetFailsFor: lib.KEYCHAIN_ICONS, app: { menu: [3, 1, 1] } } as any);
  assert.equal(unread.keychain.get(lib.KEYCHAIN_ICONS), "codex,claude");
  assert.ok(unread.alertTitles.includes("Can't read"), unread.alertTitles.join(" | "));
  // Gemini saved (no second icon in this build) stays when Claude is switched
  const kept = await runWidget({ family: "medium", code: embedded, keychain: { ...signedIn, [lib.KEYCHAIN_ICONS]: "gemini,codex" }, app: { menu: [3, 1, 2] } });
  assert.equal(kept.keychain.get(lib.KEYCHAIN_ICONS), "codex,claude,gemini");
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

test("Per-size content: small is compact with one forecast; medium adds reset, marks, forecast and last update; large also adds scoped limits and trend", async () => {
  const later = new Date("2026-11-16T13:05:00.000Z");
  const small = await runWidget({ family: "small", response: { status: 200, body: forecastView() }, now: later });
  const s = texts(small.widget.node);
  assert.ok(!s.some((x) => x.startsWith("Resets")) && !s.includes("Max") && !s.some((x) => x.startsWith("Updated")), s.join(" | "));
  assert.ok(!s.some((x) => /runs out|Runs out|[AP]M/.test(x)), "small doesn't show the run-out time");
  // one limit each, the shortest every provider has: Codex has no 5h, so the weekly for both (no Not available)
  assert.deepEqual(s.filter((x) => /limit$/.test(x)), ["Wk limit", "Wk limit"], s.join(" | "));
  assert.ok(!s.includes("—"), s.join(" | "));
  assert.ok(s.includes(`${lib.WARN_MARK} 71%`), "small puts ⚠️ on the remaining number of a limit likely to run out");

  const medium = await runWidget({ family: "medium", response: { status: 200, body: forecastView() }, now: later });
  const m = texts(medium.widget.node);
  assert.ok(!m.includes("Max") && images(medium.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), m.join(" | "));
  assert.equal(images(medium.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn).length, 1, "only limits likely to run out replace the reset time with ⚠ and the run-out time");
  assert.ok(!m.some((x) => x.startsWith("⚠")), "no ⚠ on the remaining number (medium, large)");
  assert.ok(!m.some((x) => x.startsWith("Updated") || x === "Lasts until reset"), "less text");
  assert.ok(!m.some((x) => x.includes("%/h")), "medium doesn't show the rate");
  assert.ok(!m.includes("Fable wk"), "medium shows scoped limits only at 100%");

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
  assert.ok(!l.some((x) => x.includes("%/h")) && !l.includes("Max"), "the rate and the plan are in the details only");
  assert.ok(l.includes("Fable wk") && !l.includes("Fable weekly"), "large always shows scoped limits, their length short");
  assert.ok(l.includes("Weekly usage") && l.includes("Claude") && l.includes("Codex"), l.join(" | "));
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

test("Small: content is centered (even padding) with a gap between Claude and Codex. Large shows the missing 5h limit in the same form as other limits", async () => {
  const small = await runWidget({ family: "small" });
  const kids = small.widget.node.children;
  assert.deepEqual(kids.map((c: Node) => (c.kind === "spacer" ? `spacer:${c.props.length ?? "flex"}` : c.kind)), ["spacer:flex", "stack", "spacer:2", "spacer:flex"], "centered vertically with flexible spacers (visual center lifted 2pt)");
  const page = kids[1]!;
  assert.deepEqual(page.children.map((c: Node) => (c.kind === "spacer" ? `spacer:${c.props.length ?? "flex"}` : c.kind)), ["spacer:flex", "stack", "spacer:flex"], "centered horizontally too");
  const body = page.children[1]!;
  assert.equal((body.props.size as any).w, 158 - 2 * lib.PADDING.small, "inner width (the 390 row when the screen width is unknown)");
  // the gap between them: the usual 10 plus a share of the room left (inside the padding)
  const gapIndex = body.children.findIndex((c: Node) => c.kind === "spacer" && (c.props.length as number) >= 10 && (c.props.length as number) <= 10 + lib.SMALL_SPREAD_MAX);
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
  assert.ok(texts(cols[0]!).includes("5h limit") && texts(cols[1]!).includes("Wk limit"));
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
  assert.deepEqual(plain(lib.freshnessOf(view, "claude", new Date("2026-11-16T13:30:00.000Z"))), { level: "stale", text: "" }, "from the oldest fetch among overall limits (12:58), with no age");
  assert.equal(lib.freshnessOf(view, "claude", new Date("2026-11-16T15:30:00.000Z")).level, "old");
  assert.equal(lib.resetShort({ resets_at: "2026-11-16T15:00:00.000Z", reset_passed: false }, NOW).kind, "timer");
  assert.match(lib.resetShort({ resets_at: "2026-11-20T07:00:00.000Z", reset_passed: false }, NOW).text, /^Fri \d{2}:\d{2}$/);
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

test("Even small puts ↻ before limits that are reset (estimated), and the header dot uses the oldest fetch among the shown limits", async () => {
  const view = sampleView();
  view.claude!.windows.five_hour!.fetched_at = "2026-11-16T15:35:00.000Z";
  view.claude!.windows.seven_day!.fetched_at = "2026-11-16T16:00:00.000Z";
  // Claude alone keeps its rows, its 5h reset among them
  const run = await runWidget({ family: "small", parameter: "claude", response: { status: 200, body: view }, now: new Date("2026-11-16T16:01:00.000Z") });
  assert.ok(texts(run.widget.node).includes("↻ 100%"), texts(run.widget.node).join(" | "));
  assert.deepEqual(plain(lib.freshnessOf(lib.sanitizeView(view), "claude", new Date("2026-11-16T16:01:00.000Z"))), { level: "stale", text: "" });
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
  const list = Array.from({ length: 618 }, (_, i) => ({ at: new Date(NOW.getTime() - (618 - i) * 140000).toISOString(), used_percent: 10 + i / 100, resets_at: null, break: i === 300 ? "gap" : i === 400 ? "reset" : null }));
  const points = lib.sanitizeHistory({ provider: "codex", windows: { seven_day: list } }, "codex", "seven_day", NOW);
  assert.ok(points && points.length <= 260 && points.length > 200, String(points?.length));
  assert.equal(points.filter((p: any) => p.brk).length, 1, "a reset's break is kept; a gap's is joined straight");
  // across a gap the line goes on; at a reset it is split
  const line = (b: string | null) => [{ at: "2026-11-16T10:00:00.000Z", used_percent: 20, break: null }, { at: "2026-11-16T12:00:00.000Z", used_percent: 30, break: b }];
  const lines = (b: string | null) => lib.sparkLines(lib.sanitizeHistory({ provider: "codex", windows: { seven_day: line(b) } }, "codex", "seven_day", NOW), NOW, 100, 40).length;
  assert.equal(lines("gap"), 1);
  assert.equal(lines("reset"), 2);
  assert.equal(lines(null), 1);
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

test("When a limit is named, the freshness dot uses the fetch times of the shown limits", async () => {
  const view = sampleView();
  view.claude!.windows.seven_day!.fetched_at = "2026-11-16T12:30:00.000Z";
  const run = await runWidget({ family: "small", parameter: "claude, wk", response: { status: 200, body: view } });
  assert.ok(!texts(run.widget.node).includes("30m"), `the dot alone, no age: ${texts(run.widget.node).join(" | ")}`);
  assert.equal(lib.freshnessOf(lib.sanitizeView(view), "claude", NOW, ["seven_day"]).level, "stale");
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
  // Fable at 100% is shown after the overall limits (medium shows per-model limits only at 100%)
  view.claude!.windows.seven_day_fable!.used_percent = 100;
  const param = "claude, codex";
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

test("(After fixing the chart to weekly) with one provider named, the chart shows that provider's weekly limit for 7 days", async () => {
  const run = await runWidget({ family: "large", parameter: "claude", responder: historyFor([{ at: "2026-11-16T12:00:00.000Z", used_percent: 1 }]) });
  const all = texts(run.widget.node);
  assert.ok(all.includes("Fable wk") && all.includes("Weekly usage") && all.includes("Claude"), all.join(" | "));
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

test("The rate is in the details only (the widget shows the run-out time, never the rate)", async () => {
  const view = forecastView();
  const wide = await runWidget({ family: "large", response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z") });
  const all = texts(wide.widget.node);
  assert.ok(images(wide.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), "Codex shows the run-out time");
  assert.ok(!all.some((x) => x.includes("%/h")), "no rate on the widget");
  const narrow = await runWidget({ family: "large", response: { status: 200, body: view }, now: new Date("2026-11-16T13:05:00.000Z"), screen: 320 });
  assert.ok(!texts(narrow.widget.node).some((x) => x.includes("%/h")), "the rate is omitted on devices with columns narrower than 140pt");
});

test("If one trend is missing it uses a short label; if both are missing, one line", async () => {
  const partial = await runWidget({ family: "large", responder: (url) => (url.includes("provider=codex") ? { status: 503, body: "" } : historyFor([{ at: "2026-11-16T12:00:00.000Z", used_percent: 4 }])(url)) });
  const p = texts(partial.widget.node);
  assert.ok(p.includes("Weekly usage") && p.includes("Claude") && p.includes("Codex") && !p.some((x) => x.endsWith(" –")), p.join(" | "));
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
    normal: /Fable wk/, runout: /Wk limit/, no5h: /Not available|5h limit/, stale: /Wk limit/,
    reset: /Reset \(est\.\)|^0%$/, offline: /Can't update/, error: /Sign in required/, nochart: /No weekly data yet/,
    three: /^Argon wk$/, unsupported: /^Not set up$/, reached: /^0%$/, firstuse: /On first use/, attention: /Paused|Sign in required/,
  };
  for (const s of lib.DEMO_SCENARIOS) {
    for (const family of ["small", "medium", "large", "accessoryRectangular", "accessoryCircular", "accessoryInline"]) {
      const run = await runWidget({ family, demo: s.name, now });
      assert.equal(run.error, null, `${s.name} ${family}: ${run.error}`);
      assert.equal(run.requests.length, 0, `${s.name} ${family}: no network`);
      assert.equal([...run.files.keys()].filter((p) => p.includes("headroom-view")).length, 0, `${s.name} ${family}: no saving`);
      const all = texts(run.widget.node);
      assert.ok(all.some((x) => /\bDemo\b/.test(x)), `${s.name} ${family}: ${all.join(" | ")}`);
      if (family === "large") assert.ok(all.some((x) => expect[s.name]!.test(x)), `${s.name}: ${all.join(" | ")}`);
    }
  }
  // The widget's parameter has no demo (the app's Preview sample data shows the samples): the word is said to be unknown, and the
  // values are the real ones
  const word = await runWidget({ family: "medium", parameter: "demo:normal" });
  assert.ok(texts(word.widget.node).includes("Unknown: demo:normal") && word.requests.length === 1, texts(word.widget.node).join(" | "));
  const chart = await runWidget({ family: "large", demo: "normal", now });
  assert.ok(images(chart.widget.node).some((n) => (n.props.strokes as number) >= 5), "draws the demo 7-day trend");
});

test("The app menu's 'Preview widget' > 'Sample data': choose a sample and sizes to show, and choose again after closing (no network)", async () => {
  // Menu: Preview widget -> Sample data -> runs out -> Large -> Back -> old values -> Small -> Back, Back, Back, Close
  const run = await runWidget({ family: "medium", runsInWidget: false, app: { menu: [1, 1, 2, 2, -1, 7, 0] } } as any);
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
  const run = await runWidget({ family: "medium", demo: "runout", now });
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
  const only = await runWidget({ family: "medium", parameter: "codex, 5h", response: { status: 200, body }, now });
  assert.equal((only.widget as any).refreshAfterDate.getTime(), now.getTime() + 15 * 60000, texts(only.widget.node).join(" | "));
});

test("Weekday times in narrow columns stay at 0.7x or more; demos that failed to fetch draw no trend", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const s = lib.SCALES.large;
  const need = s.small + 1 + lib.textWidth("Fri 22:01", s.small);
  assert.ok(123 / need >= 0.7, String(need));
  const off = await runWidget({ family: "large", demo: "offline", now });
  assert.ok(texts(off.widget.node).includes("No weekly data yet"), texts(off.widget.node).join(" | "));
});

test("Lock screen: circular progress around the icon. The rectangle shows the one limit with the least remaining; the circle shows the limit's name inside", async () => {
  const later = new Date("2026-11-16T13:30:00.000Z"); // 30 minutes after the fetch
  const rect = await runWidget({ family: "accessoryRectangular", now: later });
  const rings = images(rect.widget.node).filter((n) => n.props.ring);
  assert.equal(rings.length, 1);
  // The test script has no PNG embedded, so the ring holds the initial (the icon if there is a PNG)
  assert.ok(rings[0]!.props.data || (rings[0]!.props.drawnTexts as string[]).includes("X"), "the icon is inside the ring");
  const r = texts(rect.widget.node);
  assert.ok(r.includes("Wk limit") && !r.some((x) => x.includes("Codex")) && r.includes("71%") && !r.includes("31m"), r.join(" | "));
  assert.ok(images(rect.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.reset), "reset time");
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex" });
  // the weekday and time in the device's time zone (the test machine's)
  const line = texts(inline.widget.node);
  assert.equal(line.length, 1);
  assert.match(line[0]!, /^Codex wk 71% · ↻ \w{3} \d{2}:\d{2}$/, "one limit: the provider, the limit, what is left and its time");
  const circular = await runWidget({ family: "accessoryCircular", now: later });
  const ring = images(circular.widget.node).find((n) => n.props.ring);
  assert.equal((ring?.props.drawnTexts as string[]).at(-1), "wk", "the limit's name is inside the ring (below the icon)");
  assert.deepEqual(texts(circular.widget.node), ["71%"], "what is left under it, with no age");
  // The ring is the shown limit's remaining (matches the number)
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view;
  assert.equal(lib.ringOf(lib.atDisplayTime(view.claude.windows.five_hour, now)).fraction, 0.3);
  assert.equal(lib.ringOf(lib.atDisplayTime(view.claude.windows.seven_day, now)).fraction, 0.7);
  assert.equal(lib.ringOf(null), null);
  // The icon is small to leave space inside the ring
  for (const g of Object.values(lib.LOCK_RINGS) as any[]) assert.ok(g.icon <= (g.size - 2 * g.width) * 0.5, JSON.stringify(g));
  // If it will run out, the rectangle also shows ⚠ in place of the reset time
  const warn = await runWidget({ family: "accessoryRectangular", demo: "runout", now });
  assert.ok(images(warn.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), texts(warn.widget.node).join(" | "));
});

test("Lock screen marks: the reset estimate, never the age (also with the previous-value ⚠)", async () => {
  // No age, old or not (the details page shows it)
  assert.equal(lib.shortMark({ value_status: "old", age_minutes: 130, recent_quality: "approx" }), "");
  assert.equal(lib.shortMark({ value_status: "stale", age_minutes: 20 }), "");
  assert.equal(lib.shortMark({ value_status: null }), "");
  assert.equal(lib.shortMark({ value_status: "fresh", age_minutes: 3 }), "");
  assert.equal(lib.shortMark({ value_status: "reset_estimated", recent_quality: "unknown" }), "↻");
  assert.equal(lib.shortMark({ value_status: "reset_estimated" }, true), "", "left to the time row (↻ Reset) where there is one");
  const cached = JSON.stringify({ saved_at: NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView()) });
  const late = new Date("2026-11-16T16:30:00.000Z");
  const inline = await runWidget({ family: "accessoryInline", parameter: "claude, 5h", response: null, cached, now: late });
  assert.equal(texts(inline.widget.node)[0], "⚠︎ Claude 5h ↻100%");
  const circular = await runWidget({ family: "accessoryCircular", parameter: "claude, 5h", response: null, cached, now: late });
  assert.deepEqual(texts(circular.widget.node), ["100% ⚠︎ ↻"]);
  assert.equal((images(circular.widget.node).find((n) => n.props.ring)?.props.drawnTexts as string[]).at(-1), "5h");
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "claude, 5h", response: null, cached, now: late });
  assert.ok(texts(rect.widget.node).some((x) => x.includes("Can't update")), texts(rect.widget.node).join(" | "));
  assert.ok(texts(rect.widget.node).includes("↻"), "with no time row (the failure note instead), ↻ goes next to the value");
  const fresh = { ...lib.sanitizeView(sampleView()), data_version: 1, view_version: 1 };
  const reset = await runWidget({ family: "accessoryRectangular", parameter: "claude, 5h", response: { status: 200, body: fresh }, now: late });
  const all = texts(reset.widget.node);
  assert.ok(all.includes("Reset") && !all.includes("↻"), all.join(" | "));
});

test("Without embedded icons, the provider's initial is drawn inside the ring (no untinted fallback symbol)", async () => {
  const run = await runWidget({ family: "accessoryCircular", badImage: true });
  const ring = images(run.widget.node).find((n) => n.props.ring);
  assert.ok((ring?.props.drawnTexts as string[] | undefined)?.some((x: string) => x === "C" || x === "X"), JSON.stringify(ring?.props.drawnTexts));
});

test("Lock screen parameter: only the providers' own 5h and weekly limits; providers named, a limit named, and others", () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view; // left: Claude 5h 30%, weekly 70%; Codex 5h 85%, weekly 35%
  const pick = (p: string, v: any = view) => [...lib.lockPicks(v, p, now)].map((x: any) => (x.missing ? `${x.provider}:missing` : `${x.provider}.${x.window.id}`));
  assert.deepEqual(pick(""), ["claude.five_hour"], "empty is the limit with the least remaining");
  assert.deepEqual(pick("wk"), ["codex.seven_day"], "that limit, of the provider with the least left");
  assert.deepEqual(pick("weekly"), ["codex.seven_day"], "weekly reads as wk");
  assert.deepEqual(pick("5h"), ["claude.five_hour"]);
  assert.deepEqual(pick("Codex WK"), ["codex.seven_day"], "any order, case and separator");
  assert.deepEqual(pick("claude"), ["claude.five_hour"], "a provider named: its tightest");
  assert.deepEqual(pick("claude, codex, 5h"), ["claude.five_hour", "codex.five_hour"], "two named: side by side, in their order");
  assert.deepEqual(pick("codex claude"), ["codex.seven_day", "claude.five_hour"]);
  // others: the providers other than the one with the least left (a rectangle beside one of that one)
  assert.deepEqual(pick("5h, others"), ["codex.five_hour"]);
  assert.deepEqual(pick("wk, others"), ["claude.seven_day"]);
  assert.deepEqual(pick("others"), ["codex.seven_day"]);
  assert.deepEqual(pick("a, b, c"), ["claude.five_hour"], "words not understood are left out");
  // per-model limits never, even at 100%
  const normal = lib.demoResult("normal", now).view;
  normal.claude.windows.seven_day_fable.used_percent = 100;
  assert.ok(pick("claude", normal).every((k) => k === "claude.five_hour" || k === "claude.seven_day"), JSON.stringify(pick("claude", normal)));
  const no5h = lib.demoResult("no5h", now).view;
  assert.deepEqual(pick("codex, 5h", no5h), ["codex:missing"], "a limit the provider hasn't");
});

test("Two side by side in the lock screen rectangle: each has a ring (icon and remaining), limit name and time row; each ring shows its own remaining", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "accessoryRectangular", demo: "runout", now });
  assert.equal(images(run.widget.node).filter((n) => n.props.ring).length, 1, "the demo default is one");
  const view = lib.demoResult("runout", now).view;
  const body = { ...view, data_version: 1, view_version: 1 };
  const pair = await runWidget({ family: "accessoryRectangular", parameter: "claude, codex, 5h", response: { status: 200, body }, now });
  const rings = images(pair.widget.node).filter((n) => n.props.ring);
  assert.equal(rings.length, 2);
  assert.deepEqual(rings.map((n) => (n.props.drawnTexts as string[]).at(-1)), ["30%", "85%"], "each ring shows its limit's remaining");
  const all = texts(pair.widget.node);
  assert.equal(all.filter((x) => x === "5h limit").length, 2, all.join(" | "));
  assert.ok(images(pair.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.warn), "Claude 5h will likely run out (⚠)");
  // others: the rings of the providers other than the one with the least left
  const others = await runWidget({ family: "accessoryRectangular", parameter: "wk, others", response: { status: 200, body }, now });
  // one alone (Claude, beside Codex at 35%): ②'s ring alone, no text
  const ringOf = (run: any) => images(run.widget.node).filter((n) => n.props.ring);
  assert.equal(ringOf(others).length, 1);
  assert.equal((ringOf(others)[0]!.props.imageSize as any).w, lib.LOCK_RINGS.rectangular.size);
  assert.deepEqual(plain(texts(others.widget.node)), [], "no name, percentage or time");
  assert.ok(!images(others.widget.node).some((n) => n.props.symbol === lib.TIME_SYMBOLS.reset || n.props.symbol === lib.TIME_SYMBOLS.warn), "no time");
  // Codex without a 5-hour limit shows "5h Not available"
  const no5h = lib.demoResult("no5h", now).view;
  const missing = await runWidget({ family: "accessoryRectangular", parameter: "codex, claude, 5h", response: { status: 200, body: { ...no5h, data_version: 1, view_version: 1 } }, now });
  assert.ok(texts(missing.widget.node).includes("5h Not available"), texts(missing.widget.node).join(" | "));
  // The circle and inline widgets are chosen with the same parameter
  const circ = await runWidget({ family: "accessoryCircular", parameter: "codex, wk", response: { status: 200, body }, now });
  assert.equal((images(circ.widget.node).find((n) => n.props.ring)?.props.drawnTexts as string[]).at(-1), "wk");
  assert.ok(texts(circ.widget.node)[0]!.startsWith("35%"), texts(circ.widget.node).join(" | "));
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex, claude, wk", response: { status: 200, body }, now });
  assert.ok(/Codex wk 35%.*Claude wk 70%/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
});

test("Lock screen ② and ③ rings fill the rectangle's height, the same size, ②'s where ③'s left one is; what is left inside ③'s", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("three", now).view;
  const body = { status: 200, body: { ...view, data_version: 1, view_version: 1 } };
  const rings = (run: any) => images(run.widget.node).filter((n) => n.props.ring);
  // the same size, near the lowest rectangle's height (about 67pt)
  assert.equal(lib.LOCK_RINGS.others.size, lib.LOCK_RINGS.rectangular.size);
  assert.ok(lib.LOCK_RINGS.rectangular.size >= 60 && lib.LOCK_RINGS.rectangular.size <= 64, String(lib.LOCK_RINGS.rectangular.size));
  // ②: the ring, its heading beside it (fitted to the narrower column)
  const least = await runWidget({ family: "accessoryRectangular", parameter: "5h", response: body, now });
  assert.equal((rings(least)[0]!.props.imageSize as any).w, lib.LOCK_RINGS.rectangular.size);
  assert.ok(texts(least.widget.node).some((x) => x.includes("5h limit")), texts(least.widget.node).join(" | "));
  assert.equal(lib.LOCK_TITLE_WIDTH, lib.LOCK_RINGS.others.size);
  // ③: two rings of ②'s size with the icon and what is left inside; no name or time beside them (no text squeezes the rings)
  const others = await runWidget({ family: "accessoryRectangular", parameter: "5h, others", response: body, now });
  assert.equal(rings(others).length, 2);
  const picksInside = lib.lockPicks(view, "5h, others", now);
  rings(others).forEach((r, i) => {
    assert.equal((r.props.imageSize as any).w, lib.LOCK_RINGS.rectangular.size, "②'s size");
    assert.equal((r.props.drawnTexts as string[]).at(-1), lib.compactPercent(picksInside[i].window), "what is left inside");
  });
  assert.deepEqual(plain(texts(others.widget.node)), [], "no text beside the rings");
  assert.equal(images(others.widget.node).filter((n) => !n.props.ring).length, 0, "no time marks");
  // side by side with flexible space around each (evenly spaced), centred top to bottom
  const stacks = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(stacks)];
  const kinds = (node: any) => node.children.map((c: any) => (c.kind === "spacer" ? (c.props.length == null ? "flex" : "gap") : c.kind));
  // ③: two ring-wide slots with the same space before, between and after them
  const row = stacks(others.widget.node).find((x) => kinds(x).join() === "flex,image,flex,image,flex");
  assert.ok(row, "rings evenly spaced");
  // ②: the same slots (equal flexible spaces around two pieces of the ring's width): its ring in the left one, where ③'s left ring
  // is, and its text in the right one, a column of the ring's width (its centre on ③'s right ring's), lines to the right
  const twoRow = stacks(least.widget.node).find((x) => x.children.some((c: any) => c.kind === "image" && c.props.ring));
  assert.deepEqual(kinds(twoRow), ["flex", "image", "flex", "stack", "flex"]);
  const column = twoRow.children[3];
  assert.equal((column.props.size as any).w, lib.LOCK_RINGS.others.size);
  assert.equal((twoRow.children[1].props.imageSize as any).w, lib.LOCK_RINGS.others.size, "the same width as ③'s ring");
  assert.equal(column.props.dir, "v");
  // each line to the right: a flexible space before a text, or (a countdown) a fixed one sized to end the line at the column's edge
  for (const l of column.children) {
    const countdown = l.children.some((c: any) => c.kind === "stack" && c.children.some((d: any) => d.kind === "date"));
    assert.ok(countdown ? !kinds(l).includes("flex") : kinds(l)[0] === "flex", JSON.stringify(kinds(l)));
  }
  assert.deepEqual(column.children.map((l: any) => texts(l)[0]), ["5h limit", texts(least.widget.node)[1], texts(least.widget.node)[2]].slice(0, column.children.length));
  // one alone: in the left slot, where ②'s ring is (the right slot kept empty)
  const one = await runWidget({ family: "accessoryRectangular", parameter: "wk, others",
    response: { status: 200, body: { ...lib.demoResult("runout", now).view, data_version: 1, view_version: 1 } }, now });
  const oneRow = stacks(one.widget.node).find((x) => x.children.some((c: any) => c.kind === "image" && c.props.ring));
  assert.deepEqual(kinds(oneRow), ["flex", "image", "flex", "gap", "flex"]);
  assert.equal(oneRow.children[3].props.length, lib.LOCK_RINGS.others.size);
  assert.deepEqual([row.props.dir, row.props.align], ["h", "center"]);
  // each ring is its provider's, in order
  const picks = lib.lockPicks(view, "5h, others", now);
  const letters: Record<string, string> = { claude: "C", codex: "X", gemini: "G" };
  const drawn = row.children.filter((c: any) => c.kind === "image").map((c: any) => c.props.drawnTexts as string[]);
  picks.forEach((p: any, i: number) => assert.ok(drawn[i]!.includes(letters[p.provider]!), p.provider));
  // without a value, the empty ring says why inside (it doesn't read as nothing left)
  assert.equal(lib.othersMissing({ label: "5h: Not available", short: "5h Not available" }), "N/A");
  assert.equal(lib.othersMissing({ label: "Not set up", short: "Not set up" }), "N/A");
  assert.equal(lib.othersMissing({ label: "No data", short: "No data" }), "–");
  const no5h = { status: 200, body: { ...lib.demoResult("no5h", now).view, data_version: 1, view_version: 1 } };
  const missing = await runWidget({ family: "accessoryRectangular", parameter: "5h, others", response: no5h, now });
  assert.ok(rings(missing).some((r) => (r.props.drawnTexts as string[]).includes("N/A")), JSON.stringify(rings(missing).map((r) => r.props.drawnTexts)));
});

test("Lock screen ⚠ times also trigger a redraw; ②'s heading is the limit alone (the ring's icon says whose), its rows a little larger", async () => {
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
  const late = new Date("2026-11-16T13:30:00.000Z");
  const short = await runWidget({ family: "accessoryRectangular", parameter: "codex, wk", now: late });
  const head = texts(short.widget.node)[0]!;
  assert.equal(head, "Wk limit", texts(short.widget.node).join(" | "));
  // the rows keep their proportions (12 : 22 : 11 : 10), a little larger; the heading fits the narrowest column as it is
  const ratios = [lib.LOCK_TEXT.head / 12, lib.LOCK_TEXT.pct / 22, lib.LOCK_TEXT.time / 11, lib.LOCK_TEXT.mark / 10];
  assert.ok(ratios.every((r: number) => Math.abs(r - ratios[0]!) < 0.01) && ratios[0]! > 1 && ratios[0]! <= 1.15, JSON.stringify(plain(lib.LOCK_TEXT)));
  for (const name of ["Wk limit", "5h limit"]) assert.ok(lib.textWidth(name, lib.LOCK_TEXT.head, true) * 0.8 <= lib.LOCK_TITLE_WIDTH, name);
  // sizes as drawn: the heading and what is left
  const fonts = (node: any): any[] => [...(node.kind === "text" ? [[node.props.text, node.props.font]] : []), ...node.children.flatMap(fonts)];
  const drawn = Object.fromEntries(fonts(short.widget.node));
  assert.equal((drawn["Wk limit"] as any)?.size, lib.LOCK_TEXT.head, JSON.stringify(drawn));
  const left = texts(short.widget.node).find((x) => /^\d+(\.\d)?%$/.test(x))!;
  assert.equal((drawn[left] as any)?.size, lib.LOCK_TEXT.pct, JSON.stringify(drawn));
  assert.ok(!texts(short.widget.node).some((x) => /^\d+m$/.test(x)), "no age next to the remaining value");
});

test("Why a limit is missing (No 5h vs a failed fetch), each provider named, and short marks for two side by side", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const pick = (view: any, p: string) => [...lib.lockPicks(view, p, now)].map((x: any) => (x.missing ? `${x.provider}:${x.label}` : `${x.provider}.${x.window.id}`));
  const runout = lib.demoResult("runout", now).view;
  assert.deepEqual(pick(runout, "claude, codex"), ["claude.five_hour", "codex.seven_day"], "each one's tightest");
  const no5h = lib.demoResult("no5h", now).view;
  assert.deepEqual(pick(no5h, "codex, 5h"), ["codex:5h: Not available"]);
  const error = lib.demoResult("error", now).view;
  assert.deepEqual(pick(error, "claude, 5h"), ["claude:Sign in required"], "a failed fetch isn't shown as No 5h");
  const body = (v: any) => ({ status: 200, body: { ...v, data_version: 1, view_version: 1 } });
  // The circle and inline widgets show the reason too
  const circ = await runWidget({ family: "accessoryCircular", parameter: "codex, 5h", response: body(no5h), now });
  assert.ok(texts(circ.widget.node).includes("5h Not available"), texts(circ.widget.node).join(" | "));
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex, claude, 5h", response: body(no5h), now });
  assert.ok(/(Codex|Cx) 5h(: Not available| N\/A).*(Claude|Cl) 5h \d+%/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
  const least = await runWidget({ family: "accessoryInline", response: body(runout), now });
  assert.ok(/^Claude 5h 30%/.test(texts(least.widget.node)[0]!), `nothing named: the one with the least left: ${texts(least.widget.node)[0]}`);
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "claude, 5h", response: body(error), now });
  assert.ok(texts(rect.widget.node).includes("Claude: Sign in required"), texts(rect.widget.node).join(" | "));
  // Two side by side: the limit's name with no age, also when old
  const late = new Date("2026-11-16T13:30:00.000Z");
  const pair = await runWidget({ family: "accessoryRectangular", parameter: "claude, codex, wk", now: late });
  const labels = texts(pair.widget.node);
  assert.ok(labels.includes("Wk limit") && !labels.some((x) => /\d+m$/.test(x)), labels.join(" | "));
  for (const x of labels.filter((x) => /Wk|wk/.test(x))) assert.ok(lib.textWidth(x, 9) * 0.8 <= 76, x);
});

test("Reasons when no provider is given, reasons for providers named on the line and the circle demo, and label width when two are side by side", async () => {
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
  // The line with providers named also shows the reason for one whose fetch failed
  const runout = JSON.parse(JSON.stringify(lib.demoResult("runout", now).view));
  runout.codex = { status: "error", plan: null, error_code: "login_required", main_window_ids: [], window_ids: [], windows: {} };
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex, claude", response: body(runout), now });
  assert.ok(/Codex Sign in required/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
  const demoCirc = await runWidget({ family: "accessoryCircular", demo: "error", now });
  assert.ok(texts(demoCirc.widget.node).some((x) => x.includes("Sign in")), texts(demoCirc.widget.node).join(" | "));
  const demoInline = await runWidget({ family: "accessoryInline", demo: "error", now });
  assert.ok(texts(demoInline.widget.node)[0]!.includes("Sign in required"), texts(demoInline.widget.node).join(" | "));
  // Labels fit the column when two are side by side
  const pair = await runWidget({ family: "accessoryRectangular", parameter: "claude, codex, wk", response: body(signIn), now });
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
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex, claude", response: body(noCode), now });
  assert.ok(/Codex No data/.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
});

test("Time row: the run-out time is the same gray as the reset time, and no rate (details only)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "large", demo: "runout", now });
  const warn = images(run.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn);
  assert.ok(warn.length > 0 && warn.every((n) => n.props.tint === "#6e6e73"), "the ⚠ symbol is gray");
  const reset = images(run.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.reset);
  assert.ok(reset.every((n) => n.props.tint === "#6e6e73"), "same color as ↻");
  const all = texts(run.widget.node);
  assert.ok(!all.some((x) => x.includes("%/h")), all.join(" | "));
  assert.equal(lib.PROVIDER_ORDER.join(","), "codex,claude,gemini", "Codex on the left / top, Gemini last");
});

test("The line keeps the providers' named order even with reasons; the lock screen time row is gray too", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const body = (v: any) => ({ status: 200, body: { ...v, data_version: 1, view_version: 1 } });
  const view = JSON.parse(JSON.stringify(lib.demoResult("runout", now).view));
  view.codex = { status: "error", plan: null, error_code: "login_required", main_window_ids: [], window_ids: [], windows: {} };
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex, claude", response: body(view), now });
  assert.ok(/^Codex Sign in required · Claude /.test(texts(inline.widget.node)[0]!), texts(inline.widget.node).join(" | "));
  for (const parameter of ["claude 5h", "claude, codex, 5h"]) {
    const rect = await runWidget({ family: "accessoryRectangular", parameter, response: body(lib.demoResult("runout", now).view), now });
    const symbols = images(rect.widget.node).filter((n) => n.props.symbol === lib.TIME_SYMBOLS.warn || n.props.symbol === lib.TIME_SYMBOLS.reset);
    assert.ok(symbols.length > 0 && symbols.every((n) => n.props.tint === "#6e6e73"), parameter);
  }
});

test("Version 46: weekday times to the minute; chart heading (Usage) on the left with a right-aligned legend; the lower line in front; Not available without a 5-hour limit", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  assert.equal(lib.whenShort(new Date("2026-11-20T07:00:00.000Z"), now).text, lib.clockText(new Date("2026-11-20T07:00:00.000Z"), now));
  assert.match(lib.whenShort(new Date("2026-11-20T07:00:00.000Z"), now).text, /^\w{3} \d{2}:\d{2}$/, "Fri 16:00 form");
  const run = await runWidget({ family: "large", demo: "normal", now });
  const all = texts(run.widget.node);
  const usage = all.indexOf("Weekly usage");
  assert.ok(usage >= 0 && !all.some((t) => t.includes("This week")), all.join(" | "));
  // Legend row: heading -> flexible spacer -> legend (right-aligned)
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const legend = rows(run.widget.node).find((s) => s.children.some((c: any) => c.kind === "text" && c.props.text === "Weekly usage"));
  assert.equal(legend.children[0].props.text, "Weekly usage");
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
  const small = await runWidget({ family: "small", demo: "no5h", now });
  const s = texts(small.widget.node);
  assert.ok(s.filter((x) => x === "Wk limit").length === 2 && !s.includes("—") && !s.includes(lib.NOT_AVAILABLE), "small shows the weekly limit both have");
  const m = texts((await runWidget({ family: "medium", demo: "no5h", now })).widget.node);
  assert.ok(m.includes(lib.NOT_AVAILABLE) && !m.includes("No 5h limit"), "medium and large show Not available");
});

test("Rows are fixed to the column width (remaining number right-aligned; device feedback)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "large", demo: "runout", now });
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const timeSymbol = (c: any) => c.kind === "image" && (c.props.symbol === lib.TIME_SYMBOLS.warn || c.props.symbol === lib.TIME_SYMBOLS.reset);
  const sub = rows(run.widget.node).find((s) => s.children.some(timeSymbol));
  const cols = columnsOf(run.widget.node);
  const width = (cols[0]!.props.size as any).w;
  assert.equal((sub.props.size as any)?.w, width, "time row is the column width");
  const line = rows(run.widget.node).find((s) => s.children.some((c: any) => c.kind === "text" && c.props.text === "5h limit"));
  assert.equal((line.props.size as any)?.w, width, "heading row is the column width too");
  const hasName = (x: any) => x.kind === "stack" && x.children.some((d: any) => d.kind === "text" && d.props.text === "Codex");
  const header = rows(cols[0]!).find((x) => x.children.some((c: any) => c.kind === "stack" && c.children.some(hasName)));
  assert.equal((header.props.size as any)?.w, width, "provider header row is the column width too");
  const legend = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === "Weekly usage"));
  assert.ok((legend.props.size as any)?.w > width, "chart heading row is the chart width");
});

test("Inline without a 5-hour limit is short (5h N/A). The rectangle demo's Demo goes next to the remaining value (not in the time row)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const inline = await runWidget({ family: "accessoryInline", parameter: "codex, claude, 5h", response: { status: 200, body: { ...lib.demoResult("no5h", now).view, data_version: 1, view_version: 1 } }, now });
  const text = texts(inline.widget.node)[0]!;
  assert.ok(/^(Codex|Cx) 5h(: Not available| N\/A) · (Claude|Cl) 5h/.test(text), text);
  assert.ok(lib.textWidth(text, 11) <= 225, `${text}: ${lib.textWidth(text, 11)}`);
  const rect = await runWidget({ family: "accessoryRectangular", demo: "normal", now });
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
  const rect = await runWidget({ family: "accessoryRectangular", demo: "offline", now });
  const side = texts(rect.widget.node).find((x) => x.includes("Demo"))!;
  assert.ok(!side.includes(" ago"), side);
});

test("Inline measures width including the demo prefix and drops the staleness mark if it doesn't fit (keeps ⚠ and remaining)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const off = await runWidget({ family: "accessoryInline", demo: "offline", now });
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

test("Header: icon, name and freshness dot are centered; no plan (details only; device feedback)", async () => {
  const run = await runWidget({ family: "medium" });
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  const nameBox = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === "Codex"));
  const names = rows(run.widget.node).find((x) => x.children.includes(nameBox));
  assert.equal(names.props.align, "bottom", "name and plan at the bottom edge");
  assert.ok((nameBox.props.size as any)?.w >= lib.textWidth("Codex", lib.SCALES.medium.name, true), "the name has a box as wide as its text (never shortened)");
  assert.ok(!texts(run.widget.node).includes("Pro Lite"), "the plan is in the details only");
  const header = rows(run.widget.node).find((x) => x.children.includes(names));
  assert.equal(header.props.align, "center", "the row is centered");
  assert.equal((header.props.size as any).h, lib.SCALES.medium.header, "header height is fixed");
});

test("Compacting the inline text keeps the ↻ reset estimate; with two scoped limits the names are shortened", () => {
  const w = (id: string, used: number, extra: any = {}) => ({ id, used_percent: used, remaining_percent: 100 - used, remaining_percent_int: 100 - used, value_status: "fresh", scope: null, ...extra });
  const est = lib.inlineText([
    { provider: "codex", providerName: "Codex", window: w("five_hour", 0, { value_status: "reset_estimated" }) },
    { provider: "claude", providerName: "Claude", window: w("five_hour", 0, { value_status: "reset_estimated" }) },
  ], true, "Demo · ");
  assert.equal((est.match(/↻/g) ?? []).length, 2, `reset marks kept on both: ${est}`);
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
  assert.ok(text.startsWith(lib.WARN_MARK) && (text.match(/↻/g) ?? []).length === 2, text);
});

test("Medium/large Not available is left-aligned (the row width is fixed, so a flexible spacer follows)", async () => {
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  for (const family of ["medium", "large"]) {
    const run = await runWidget({ family });
    const sub = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === lib.NOT_AVAILABLE));
    assert.equal(sub.children[0].props.symbol, lib.TIME_SYMBOLS.none, `${family}: led by ✕`);
    assert.equal(sub.children.find((c: any) => c.kind === "text").props.text, lib.NOT_AVAILABLE, family);
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

test("A countdown asks for a redraw when it reaches zero (it would count up after that)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("normal", now).view;
  view.claude.windows.five_hour.resets_at = new Date(now.getTime() + 7 * 60000).toISOString();
  view.claude.windows.five_hour.rate_pace = 0;
  const body = { ...view, data_version: 1, view_version: 1 };
  const run = await runWidget({ family: "medium", response: { status: 200, body }, now });
  assert.equal((run.widget as any).refreshAfterDate.getTime(), now.getTime() + 7 * 60000);
});

test("The large chart's scale is always 0-100% and says so at its ends", async () => {
  const run = await runWidget({ family: "large", responder: historyFor([{ at: "2026-11-16T12:00:00.000Z", used_percent: 4 }]) });
  const chart = images(run.widget.node).find((n) => Array.isArray((n.props as any).drawnTexts) && (n.props as any).drawnTexts.length > 0);
  assert.deepEqual((chart?.props as any)?.drawnTexts, ["100%", "0%"]);
  assert.equal(lib.trendY(100, 60, 3), 3);
  assert.equal(lib.trendY(0, 60, 3), 57);
});

test("While a provider is at its limit, values that stopped updating get a red dot", () => {
  const raw = sampleView();
  raw.claude!.blocked = true;
  const view = lib.sanitizeView(raw);
  assert.equal(view.claude.blocked, true, "the limit flag survives reading the response");
  assert.notEqual(lib.sanitizeView(sampleView()).claude.blocked, true);
  assert.equal(lib.freshnessOf(lib.sanitizeView(sampleView()), "claude", NOW).level, "fresh");
  assert.equal(lib.freshnessOf(view, "claude", NOW).level, "limit", "red right after a fetch too (fetching slows to hourly at the limit)");
  assert.deepEqual(plain(lib.freshnessOf(view, "claude", new Date("2026-11-16T13:30:00.000Z"))), { level: "limit", text: "" }, "no age next to the red dot");
  assert.equal(lib.FRESH_COLORS.limit, "#FF3B30");
});

test("Once every shown limit at 100% is past its reset, the dot goes back to the age", () => {
  const raw = sampleView();
  raw.claude!.blocked = true;
  const view = lib.sanitizeView(raw);
  const ids = view.claude.main_window_ids as string[];
  for (const id of ids) view.claude.windows[id].used_percent = 100;
  const resets = ids.map((id) => Date.parse(view.claude.windows[id].resets_at));
  const before = new Date(Math.max(...resets) - 60000);
  assert.equal(lib.freshnessOf(view, "claude", before).level, "limit");
  const after = new Date(Math.max(...resets) + 60000);
  assert.notEqual(lib.freshnessOf(view, "claude", after).level, "limit");
  // None at 100% before any reset (the limit that blocks isn't among the shown ones): still red
  for (const id of ids) view.claude.windows[id].used_percent = 50;
  assert.equal(lib.freshnessOf(view, "claude", new Date(Math.min(...resets) - 60000)).level, "limit");
  // a view the server built after the reset shows the passed limit as 0% with the flag still set: the dot goes back to the age
  const rebuilt = lib.sanitizeView(raw);
  rebuilt.claude.windows[ids[0]!].used_percent = 0;
  const pastFirst = new Date(Math.min(...resets) + 60000);
  for (const id of ids.slice(1)) rebuilt.claude.windows[id].used_percent = 40;
  assert.notEqual(lib.freshnessOf(rebuilt, "claude", pastFirst).level, "limit");
  // Red even when the fetch time is unknown (still at 100% with the reset ahead)
  const unknown = lib.sanitizeView(raw);
  for (const id of ids) Object.assign(unknown.claude.windows[id], { used_percent: 100, fetched_at: null });
  assert.equal(lib.freshnessOf(unknown, "claude", new Date(Math.min(...resets) - 60000)).level, "limit");
});

test("After the run-out time passes with no newer value, the row keeps ⚠ and says Limit; after a reset time, ↻ Reset", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("runout", now).view;
  const five = view.claude.windows.five_hour;
  const at = lib.projectionOf(lib.atDisplayTime(five, now), now).at as number;
  const later = new Date(at + 2 * 60000);
  assert.deepEqual(plain(lib.timeShort(lib.atDisplayTime(five, later), later)), { warn: true, kind: "text", text: "Limit" });
  const run = await runWidget({ family: "medium", response: { status: 200, body: { ...view, data_version: 1, view_version: 1 } }, now: later });
  assert.ok(texts(run.widget.node).includes("Limit"), texts(run.widget.node).join(" | "));
  const small = await runWidget({ family: "small", response: { status: 200, body: { ...view, data_version: 1, view_version: 1 } }, now: later });
  assert.ok(texts(small.widget.node).some((t) => t.startsWith("⚠︎ ")), "small (no time row) puts ⚠ before the value");
  // A newer value at 100% shows the reset again, and past the reset it is ↻ Reset
  assert.equal(lib.timeShort(lib.atDisplayTime({ ...five, used_percent: 100, fetched_at: later.toISOString() }, later), later).warn, false);
  const afterReset = new Date(Date.parse(five.resets_at) + 60000);
  assert.deepEqual(plain(lib.timeShort(lib.atDisplayTime(five, afterReset), afterReset)), { warn: false, kind: "text", text: "Reset" });
});

test("The provider name is never cut off, and no plan beside it at any width (details only)", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("normal", now).view;
  // Values 2 hours old: the header shows "2h" next to the dot
  for (const p of [view.codex, view.claude]) for (const w of Object.values(p.windows) as any[]) w.fetched_at = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const body = { ...view, data_version: 1, view_version: 1 };
  const narrow = await runWidget({ family: "medium", response: { status: 200, body }, now, screen: 320 });
  const all = texts(narrow.widget.node);
  assert.ok(all.includes("Codex") && all.includes("Claude"), all.join(" | "));
  const wide = await runWidget({ family: "medium", response: { status: 200, body }, now, screen: 430 });
  assert.ok(!texts(wide.widget.node).includes("Plus") && texts(wide.widget.node).includes("Codex"), "no plan even when it would fit");
});

test("Large uses medium's sizes throughout, and the chart takes the room left", () => {
  for (const key of ["icon", "name", "headerSmall", "label", "pct", "small", "bar", "gapBar", "gapSub", "gapRow", "gapHeader", "header"] as const) {
    assert.equal(lib.SCALES.large[key], lib.SCALES.medium[key], key);
  }
});

test("At 100%, the gray part (recent use) goes away once its span has passed since the fetch: 1 hour for 5h, 1 day for the weekly limit", async () => {
  const now = new Date("2026-11-19T13:00:00.000Z");
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
  const win = (id: string, span: number, used: number, ago: number) => lib.sanitizeView({
    view_version: 1, data_version: 1,
    claude: { status: "ok", plan: "max", error_code: null, blocked: used >= 100, main_window_ids: id, window_ids: id, windows: {
      [id]: { id, label: id, scope: null, used_percent: used, recent_consumed_percent: 30, recent_minutes: span, recent_quality: "exact",
        confidence: "high", fetched_at: at(ago), resets_at: "2026-11-20T10:00:00.000Z" } } },
    codex: null,
  }).claude.windows[id];
  assert.equal(lib.atDisplayTime(win("five_hour", 60, 100, 59), now).recent_consumed_percent, 30, "within the hour it stays");
  assert.equal(lib.atDisplayTime(win("five_hour", 60, 100, 60), now).recent_consumed_percent, 0, "an hour after the fetch it is gone");
  assert.equal(lib.atDisplayTime(win("seven_day", 1440, 100, 23 * 60), now).recent_consumed_percent, 30, "the weekly limit keeps it for a day");
  assert.equal(lib.atDisplayTime(win("seven_day", 1440, 100, 24 * 60), now).recent_consumed_percent, 0);
  assert.equal(lib.atDisplayTime(win("five_hour", 60, 90, 90), now).recent_consumed_percent, 30, "below the limit more may have been used, so it stays");
  assert.equal(lib.recentSettledAt(win("five_hour", 60, 100, 50)), now.getTime() + 10 * 60000);
});

test("The widget asks to be redrawn when the gray part of a limit at 100% goes away", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("normal", now).view;
  const five = view.claude.windows.five_hour;
  Object.assign(five, { used_percent: 100, recent_consumed_percent: 20, recent_minutes: 60, fetched_at: new Date(now.getTime() - 52 * 60000).toISOString() });
  view.claude.blocked = true;
  const body = { ...view, data_version: 1, view_version: 1 };
  const run = await runWidget({ family: "medium", response: { status: 200, body }, now });
  assert.equal((run.widget as any).refreshAfterDate.getTime(), now.getTime() + 8 * 60000);
});

test("Lock screen: a provider at its limit shows no age, like the red dot at home", async () => {
  const later = new Date("2026-11-16T13:30:00.000Z");
  const raw = sampleView();
  raw.codex!.blocked = true;
  const body = { ...raw, data_version: 1, view_version: 1 };
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "codex weekly", response: { status: 200, body }, now: later });
  assert.ok(!texts(rect.widget.node).some((x) => /^\d+m$/.test(x)), texts(rect.widget.node).join(" | "));
  const home = await runWidget({ family: "medium", response: { status: 200, body }, now: later });
  assert.ok(images(home.widget.node).some((n) => (n.props.fills as any[])?.some((c) => c?.hex === lib.FRESH_COLORS.limit)), "the home screen shows the red dot");
});

test("The large chart marks each provider's weekly reset times this week with a dashed line", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const range = lib.weekRange(now);
  const reset = new Date("2026-11-20T19:51:00").getTime();
  // This cycle's reset and the one before it (the start of this cycle) when both fall in the week; the next one is in next week
  assert.deepEqual(plain(lib.resetTimes({ resets_at: new Date(reset).toISOString() }, range)), [reset]);
  const early = new Date("2026-11-17T10:00:00").getTime();
  assert.deepEqual(plain(lib.resetTimes({ resets_at: new Date(early + 7 * 86_400_000).toISOString() }, range)), [early]);
  assert.deepEqual(plain(lib.resetTimes({ resets_at: null }, range)), []);
  const strokes = async (resets: boolean) => {
    const view = lib.demoResult("normal", now).view;
    if (!resets) for (const p of [view.codex, view.claude]) for (const w of Object.values(p.windows) as any[]) w.resets_at = null;
    const run = await runWidget({ family: "large", response: { status: 200, body: { ...view, data_version: 1, view_version: 1 } }, now });
    const chart = images(run.widget.node).find((n) => ((n.props as any).drawnTexts ?? []).includes("100%"));
    return chart!.props.strokes as number;
  };
  assert.ok(await strokes(true) > await strokes(false), "reset lines are drawn");
});

test("The large chart's even pace runs from 0% at the cycle start to 100% at the reset, clipped to the week", () => {
  const now = new Date("2026-11-19T12:00:00");
  const range = lib.weekRange(now);
  const week = 7 * 86_400_000;
  const reset = new Date("2026-11-20T19:51:00").getTime();
  const guide = plain(lib.paceGuide({ resets_at: new Date(reset).toISOString() }, range, now));
  assert.deepEqual(guide[1], [reset, 100], "ends at 100% at the reset");
  assert.equal(guide[0][0], range.start, "starts at the week's start when the cycle began last week");
  assert.ok(Math.abs(guide[0][1] - (100 * (range.start - (reset - week))) / week) < 1e-9, "interpolated at the edge");
  // A reset that passed since the fetch: the next cycle starts at that time
  const passed = new Date("2026-11-19T10:00:00").getTime();
  const next = plain(lib.paceGuide({ resets_at: new Date(passed).toISOString() }, range, now));
  assert.deepEqual(next[0], [passed, 0]);
  assert.equal(next[1][0], range.end);
  assert.equal(lib.paceGuide({ resets_at: null }, range, now), null);
});

test("The large chart's forecast continues at the bar's rate to the run-out time (ring) or to the reset", () => {
  const now = new Date("2026-11-19T12:00:00");
  const range = lib.weekRange(now);
  const fetched = now.getTime() - 60_000;
  const w = (o: Record<string, unknown>) => ({ id: "seven_day", used_percent: 60, confidence: "high", fetched_at: new Date(fetched).toISOString(),
    resets_at: new Date(now.getTime() + 3 * 86_400_000).toISOString(), rate_pace: 2, ...o });
  // 40% left at 2%/h runs out in 20 hours, before the reset in 3 days
  const fast = plain(lib.forecastSegment(w({}), range, now));
  assert.equal(fast.runsOut, true);
  assert.deepEqual(fast.segment[0], [fetched, 60]);
  assert.deepEqual(fast.segment[1], [fetched + 20 * 3_600_000, 100]);
  // 0.1%/h lasts until the reset; the line is cut at the end of the week (Sunday 00:00) and isn't a run-out
  const slow = plain(lib.forecastSegment(w({ rate_pace: 0.1 }), range, now));
  assert.equal(slow.runsOut, false);
  assert.equal(slow.segment[1][0], range.end);
  assert.ok(slow.segment[1][1] < 100);
  // Same conditions as the bar's forecast
  assert.equal(lib.forecastSegment(w({ confidence: "low" }), range, now), null);
  assert.equal(lib.forecastSegment(w({ used_percent: 100 }), range, now), null);
  assert.equal(lib.forecastSegment(w({ rate_pace: 0 }), range, now), null, "a rate too small to measure draws nothing");
});

test("The large chart draws the even pace and a dotted forecast with a ring where it runs out", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const chartOf = async (view: any) => {
    const run = await runWidget({ family: "large", response: { status: 200, body: { ...view, data_version: 1, view_version: 1 } }, now });
    return images(run.widget.node).find((n) => ((n.props as any).drawnTexts ?? []).includes("100%"))!.props as any;
  };
  // Demo "runs out": Codex weekly 65% at 1.2%/h runs out in about a day, before its reset in 3 days
  const runout = await chartOf(lib.demoResult("runout", now).view);
  assert.equal(runout.ellipses, 1, "a ring where Codex runs out");
  assert.ok(runout.widths.includes(1.5), "dotted forecast");
  const normal = await chartOf(lib.demoResult("normal", now).view);
  assert.equal(normal.ellipses, 0, "no ring when both last until the reset");
  const marks = plain(lib.trendMarks([{ provider: "codex", window: lib.demoResult("runout", now).view.codex.windows.seven_day }], lib.weekRange(now), now, 300, 100));
  assert.equal(marks.guides.length, 1);
  assert.equal(marks.forecasts.length, 1);
  assert.equal(marks.forecasts[0].runsOut, true);
  assert.ok(marks.forecasts[0].to[1] < marks.forecasts[0].from[1], "heads up toward 100%");
});

// ---- Notifications and the details screen ----

const NOTE_NOW = new Date("2026-11-19T12:00:00Z");
/** A sanitized event (defaults: Claude 5h, cycle ending at 15:00Z, created a minute before NOTE_NOW) */
const ev = (seq: number, kind: string, o: Record<string, unknown> = {}) => ({
  seq, created_at: new Date(NOTE_NOW.getTime() - 60_000).toISOString(), kind, provider: "claude", window_id: "five_hour", label: "5h", scope: null,
  cycle: "2026-11-19T15:00:00.000Z", threshold: null, used_percent: null, eta_minutes: null, resets_at: "2026-11-19T15:00:00.000Z",
  blocked: null, error_code: null, confirmed: null, last_received_at: null, ...o,
});
/** What each alert says: provider, limit and text ("claude 5h ⊘ Limit reached · ↻ 15:00") */
const titles = (r: any) => plain(r.alerts.map((a: any) => [a.provider, a.limit, a.text].filter(Boolean).join(" ")));
const S = lib.SYMBOLS;

test("Notifications: \"notify\" in the parameter chooses the notifying widget; the rest chooses what to show", () => {
  assert.deepEqual(plain(lib.splitNotify("notify")), { display: "", notify: true });
  assert.deepEqual(plain(lib.splitNotify("claude, notify")), { display: "claude", notify: true });
  assert.deepEqual(plain(lib.splitNotify("claude.five_hour, NOTIFY, codex.seven_day")), { display: "claude.five_hour, codex.seven_day", notify: true });
  assert.deepEqual(plain(lib.splitNotify("claude.five_hour,codex.seven_day")), { display: "claude.five_hour,codex.seven_day", notify: false }, "unchanged without notify");
  assert.deepEqual(plain(lib.splitNotify(null)), { display: null, notify: false });
  assert.equal(lib.splitNotify("notifyme").notify, false);
  assert.deepEqual(plain(lib.notifyPrefs(null)), { events: true, times: true, rev: 0, times_off_at: null, cancel_pending: false, cancelled: [], cancels: [] }, "both on until turned off");
  assert.deepEqual(plain(lib.notifyPrefs('{"times":false,"rev":3,"times_off_at":5}')), { events: true, times: false, rev: 3, times_off_at: 5, cancel_pending: false, cancelled: [], cancels: [] });
  assert.equal(lib.notifyPrefs("not json"), null, "a corrupt value is not taken for the defaults");
  // an earlier format: identifiers alone, cancelled when time reminders were last turned off
  assert.deepEqual(plain(lib.notifyPrefs('{"times":false,"times_off_at":7,"cancelled":["headroom.0000000000000000.back.claude.all.1"]}')).cancelled,
    [{ id: "headroom.0000000000000000.back.claude.all.1", at: 7 }]);
});

test("Time reminders: one at the latest reset of a provider at its limit, one 15 minutes before a forecast run-out", () => {
  const now = NOTE_NOW;
  // Demo "reset": Codex 5h at 100% resets in 2 hours (Claude's 5h reset has passed)
  const view = plain(lib.demoResult("reset", now).view);
  const back = plain(lib.reminderPlan(view, now));
  assert.deepEqual(back.map((x: any) => [x.kind, x.provider, x.window_id]), [["back", "codex", "five_hour"]]);
  assert.equal(back[0].fire_at, now.getTime() + 120 * 60_000);
  assert.equal(back[0].title, "Codex · 5h limit", "the provider's name first, then the limit's full name");
  assert.equal(back[0].body, `${S.reset} Reset · usable again`);
  // Both limits at 100%: it can't be used until the later one resets, so only that one
  view.codex.windows.seven_day.used_percent = 100;
  const both = plain(lib.reminderPlan(view, now));
  assert.equal(both.length, 1);
  assert.equal(both[0].window_id, "seven_day");
  assert.equal(both[0].fire_at, Date.parse(view.codex.windows.seven_day.resets_at));
  // Demo "runs out": Claude 5h runs out in about an hour, Codex weekly in about a day
  const runout = plain(lib.reminderPlan(plain(lib.demoResult("runout", now).view), now));
  assert.deepEqual(runout.map((x: any) => [x.kind, x.provider, x.window_id]), [["runout", "codex", "seven_day"], ["runout", "claude", "five_hour"]]);
  const claude = runout[1];
  assert.equal(claude.fire_at, now.getTime() - 60_000 + 60 * 60_000 - lib.RUNOUT_LEAD_MINUTES * 60_000, "15 minutes before the run-out time");
  assert.equal(claude.title, "Claude · 5h limit");
  assert.ok(claude.body.startsWith(`${S.runout} ~15 min left (runs out `), claude.body);
  // Less than 15 minutes left: right away, with the minutes left
  const close = plain(lib.demoResult("runout", now).view);
  close.claude.windows.five_hour.used_percent = 95;
  const soon = plain(lib.reminderPlan(close, now)).find((x: any) => x.provider === "claude");
  assert.equal(soon.fire_at, now.getTime());
  assert.match(soon.body, new RegExp(`^${S.runout} ~9 min left`));
});

test("Time reminders are scheduled once per cycle: moved while pending, cancelled when no longer planned, never rung twice", () => {
  const now = NOTE_NOW.getTime();
  const gen = "0123456789abcdef";
  const reset = now + 3 * 3_600_000;
  const item = { kind: "runout", provider: "claude", window_id: "five_hour", cycle: reset, fire_at: now + 44 * 60_000, title: "t", body: "b" };
  const first = plain(lib.reconcileReminders([], [item], NOTE_NOW, gen));
  assert.equal(first.schedule.length, 1);
  // no account stamp in the plan (x), then the operation's own mark
  const id = first.schedule[0].id;
  assert.match(id, new RegExp(`^headroom\\.${gen}\\.runout\\.claude\\.five_hour\\.${Math.round(reset / 60_000)}\\.x\\.[0-9a-f]{8}$`));
  const same = plain(lib.reconcileReminders(first.reminders, [{ ...item, cycle: reset + 90_000, fire_at: item.fire_at + 60_000 }], new Date(now + 60_000), gen));
  assert.deepEqual([same.schedule.length, same.cancel.length], [0, 0], "a jittering reset time or a minute's change doesn't reschedule");
  const moved = plain(lib.reconcileReminders(first.reminders, [{ ...item, fire_at: item.fire_at - 10 * 60_000 }], NOTE_NOW, gen));
  assert.equal(moved.schedule.length, 1);
  assert.notEqual(moved.schedule[0].id, id, "a new time is a new operation, under its own identifier");
  assert.deepEqual(plain(moved.cancel), [id], "and the old one is cancelled");
  const gone = plain(lib.reconcileReminders(first.reminders, [], NOTE_NOW, gen));
  assert.deepEqual(gone.cancel, [id], "cancelled when the forecast no longer runs out");
  assert.deepEqual(gone.reminders, []);
  const after = new Date(item.fire_at + 60_000);
  const rung = plain(lib.reconcileReminders(first.reminders, [{ ...item, fire_at: after.getTime() + 5 * 60_000 }], after, gen));
  assert.deepEqual([rung.schedule.length, rung.cancel.length, rung.reminders.length], [0, 0, 1], "a reminder that rang isn't scheduled again in its cycle");
  const kept = plain(lib.reconcileReminders(first.reminders, [], after, gen));
  assert.deepEqual([kept.cancel.length, kept.reminders.length], [0, 1], "remembered after it rang");
  const lost = plain(lib.reconcileReminders(first.reminders, [item], NOTE_NOW, gen, new Set()));
  assert.deepEqual(plain(lost.schedule.map((x: any) => x.id)), [id], "a pending one the device no longer has is scheduled again");
  const there = plain(lib.reconcileReminders(first.reminders, [item], NOTE_NOW, gen, new Set([id])));
  assert.equal(there.schedule.length, 0, "not while the device still has it");
  const forgotten = plain(lib.reconcileReminders(first.reminders, [], new Date(item.fire_at + 9 * 86_400_000), gen));
  assert.equal(forgotten.reminders.length, 0, "forgotten after 8 days");
});

test("Events: the response is validated; a malformed event is skipped", () => {
  assert.equal(lib.sanitizeEvents(null), null);
  assert.equal(lib.sanitizeEvents({ last_seq: -1, events: [] }), null);
  assert.equal(lib.sanitizeEvents({ last_seq: 3, events: "x" }), null);
  const clean = plain(lib.sanitizeEvents({ last_seq: 9, oldest_seq: 2, events: [
    { ...ev(5, "limit"), extra: "dropped" }, { seq: "6", kind: "limit" }, { ...ev(7, "unknown") }, { ...ev(4, "reset"), window_id: null, provider: "x" },
  ] }));
  assert.deepEqual(clean.events.map((e: any) => e.seq), [4, 5], "sorted, malformed ones skipped");
  assert.equal(clean.events[0].window_id, null);
  assert.equal(clean.events[0].provider, null);
  assert.ok(!("extra" in clean.events[1]));
  assert.equal(clean.last_seq, 9);
});

test("Alerts: a limit that runs out rings at most three times per cycle (warning, limit, reset); time reminders take the warning", () => {
  const told = { limits: [], warned: [] };
  const batch = [ev(1, "soon", { threshold: 30, eta_minutes: 30 }), ev(2, "threshold", { threshold: 95 }), ev(3, "soon", { threshold: 15, eta_minutes: 15 })];
  // Time reminders off: the first warning of the cycle only
  const warn = lib.selectAlerts(batch, null, NOTE_NOW, { told, times: false });
  assert.deepEqual(titles(warn), [`claude 5h ${S.runout} ~29 min left at this pace`], "counted from now (created a minute ago)");
  assert.deepEqual(titles(lib.selectAlerts([ev(4, "threshold", { threshold: 95 })], null, NOTE_NOW, { told: warn.told, times: false })), [], "once per cycle");
  // Time reminders on: their run-out reminder rings on time, so the events' warnings are not told
  assert.deepEqual(titles(lib.selectAlerts(batch, null, NOTE_NOW, { told, times: true })), []);
  // Limit reached, then the reset of that cycle
  const limit = lib.selectAlerts([ev(5, "limit", { blocked: true })], null, NOTE_NOW, { told, times: true });
  assert.equal(titles(limit).length, 1);
  assert.equal(titles(limit)[0], `claude 5h ${S.limit} Limit reached · ${S.reset} ${lib.clockText(new Date("2026-11-19T15:00:00Z"), NOTE_NOW)}`, "when it comes back");
  assert.equal(titles(lib.selectAlerts([ev(7, "limit")], null, NOTE_NOW, { told: limit.told })).length, 1, "another limit event of the cycle is another account's (the same event is kept from repeating by the cursor and the numbers told)");
  const later = new Date("2026-11-19T15:06:00Z");
  const reset = ev(6, "reset", { confirmed: true, created_at: "2026-11-19T15:05:00Z", resets_at: "2026-11-19T20:00:00Z" });
  const told2 = plain(limit.told);
  assert.deepEqual(titles(lib.selectAlerts([reset], null, later, { told: told2, times: true })), [`claude 5h ${S.reset} Reset · usable again`]);
  assert.deepEqual(titles(lib.selectAlerts([{ ...reset, confirmed: false }], null, later, { told: told2 })), [`claude 5h ${S.reset} Reset (estimated) · usable again`]);
  const rang = [{ kind: "back", provider: "claude", cycle: Date.parse("2026-11-19T15:00:30Z"), fire_at: Date.parse("2026-11-19T15:00:30Z") }];
  assert.deepEqual(titles(lib.selectAlerts([reset], null, later, { told: told2, reminders: rang, times: true })), [], "the reminder already rang at the reset");
  assert.deepEqual(titles(lib.selectAlerts([reset], null, later, { told: told2, reminders: rang, times: false })), [], "a reminder that rang counts even with time reminders now off");
  const soonToRing = [{ ...rang[0], fire_at: later.getTime() + 30_000 }];
  assert.deepEqual(titles(lib.selectAlerts([reset], null, later, { told: told2, reminders: soonToRing })), [], "one ringing within a minute counts too (no second notification 30 seconds apart)");
  assert.deepEqual(titles(lib.selectAlerts([reset], null, later, { told })), [], "no reset without a told limit");
  // A provider still at another limit: its reset isn't good news yet
  const full = plain(lib.demoResult("reset", later).view);
  const codexReset = { ...reset, provider: "codex", window_id: "seven_day", label: "Weekly" };
  const codexTold = { limits: [{ key: `codex.seven_day.${reset.cycle}`, at: later.getTime() }], warned: [] };
  assert.deepEqual(titles(lib.selectAlerts([codexReset], full, later, { told: codexTold })), []);
});

test("Alerts: weekly 80%, collection and sign-in problems are told; noise, stale and old events are not", () => {
  const told = { limits: [], warned: [] };
  const pick = (events: any[], now = NOTE_NOW) => titles(lib.selectAlerts(events, null, now, { told, times: true }));
  assert.deepEqual(pick([ev(1, "threshold", { threshold: 80, window_id: "seven_day", label: "Weekly", resets_at: "2026-11-21T00:00:00Z" })]), [`claude Weekly ${S.left} 20% left · ${S.reset} ${lib.clockText(new Date("2026-11-21T00:00:00Z"), NOTE_NOW)}`]);
  assert.deepEqual(pick([ev(1, "threshold", { threshold: 80 })]), [], "not the 5h limit's 80%");
  assert.deepEqual(pick([ev(1, "soon", { threshold: 5, eta_minutes: 5 }), ev(2, "anomalous")]), []);
  assert.deepEqual(pick([ev(1, "limit", { window_id: "seven_day_fable", scope: "Fable", label: "Fable" })]), [`claude Fable weekly ${S.limit} Limit reached · ${S.reset} ${lib.clockText(new Date("2026-11-19T15:00:00Z"), NOTE_NOW)}`], "per-model limits only when reached");
  assert.deepEqual(pick([ev(1, "provider_error", { window_id: null, error_code: "login_required" }), ev(2, "provider_error", { window_id: null, error_code: "fetch_failed" })]), [`claude ${S.runout} Sign in required`]);
  const stop = ev(1, "collection_stopped", { provider: null, window_id: null, last_received_at: "2026-11-19T11:20:00Z" });
  assert.deepEqual(pick([stop]), [`${S.stopped} No new values from the PCs since ${lib.clockText(new Date("2026-11-19T11:20:00Z"), NOTE_NOW)}`]);
  assert.deepEqual(pick([stop, ev(2, "collection_resumed", { provider: null, window_id: null })]), [], "stopped and resumed in one batch cancel out");
  assert.deepEqual(pick([ev(1, "limit")], new Date("2026-11-19T15:01:00Z")), [], "a limit whose reset has passed");
  assert.deepEqual(pick([ev(1, "limit", { created_at: "2026-11-18T23:00:00Z" })]), [], "older than 12 hours");
  assert.deepEqual(titles(lib.selectAlerts([ev(1, "soon", { threshold: 30, eta_minutes: 30, created_at: "2026-11-19T11:20:00Z" })], null, NOTE_NOW, { told, times: false })), [], "a warning whose time has passed");
  // One notification per provider in a run, titled with the provider's name and the limit's full name
  assert.deepEqual(plain(lib.alertNotifications([])), []);
  const one = plain(lib.alertNotifications(lib.selectAlerts([ev(1, "limit", { window_id: "seven_day_fable", scope: "Fable", label: "Fable" })], null, NOTE_NOW, { told }).alerts));
  assert.equal(one.length, 1);
  assert.equal(one[0].title, "Claude · Fable weekly limit", "the full name, not the short one");
  const alerts = [
    { seq: 1, provider: null, limit: null, title_limit: null, text: "stop" }, { seq: 2, provider: "codex", limit: "Weekly", title_limit: "Weekly limit", text: "a" },
    ...Array.from({ length: 7 }, (_, i) => ({ seq: 3 + i, provider: "claude", limit: "5h", title_limit: "5h limit", text: `t${i}` })),
  ];
  const many = plain(lib.alertNotifications(alerts));
  assert.deepEqual(many.map((n: any) => n.title), ["Codex · Weekly limit", "Claude · 7 updates", "Headroom"], "Codex, Claude, then the rest; several say how many");
  assert.deepEqual(many[1].body.split("\n"), ["5h limit t0", "5h limit t1", "5h limit t2", "5h limit t3", "5h limit t4", "+2 more"]);
  assert.equal(lib.fullLimitName({ id: "five_hour", scope: null }), "5h limit");
  assert.equal(lib.fullLimitName({ id: "codex_other_seven_day", scope: "codex_other" }), "Other weekly limit");
});

test("Notification state: unreadable parts start empty; the lock expires", () => {
  const recent = Date.now() - 1000;
  assert.deepEqual(plain(lib.readNotifyState("garbage")), { reminders: [], told: { limits: [], warned: [] }, sent: [], view_version: null, sending: null, boundaries: null, boundaries_version: null, checked_at: null });
  const state = plain(lib.readNotifyState(JSON.stringify({
    reminders: [{ id: "headroom.0123456789abcdef.back.codex.all.29000000", kind: "back", provider: "codex", window_id: "five_hour", cycle: 1, fire_at: 1 },
      { id: "other.app", kind: "back", provider: "codex", cycle: 1, fire_at: 1 }],
    told: { limits: [{ key: "k", at: recent }, { key: 5 }, { key: "claude.five_hour.2099-11-25T00:00:00Z", at: 2 }, { key: "old", at: 1 }] }, checked_at: "2026-11-19T12:00:00Z",
  })));
  assert.equal(state.reminders.length, 1, "only Headroom's identifiers");
  const keep = 8 * 24 * 60 * 60_000;
  assert.deepEqual(state.told, { limits: [{ key: "k", at: recent, until: recent + keep },
    { key: "claude.five_hour.2099-11-25T00:00:00Z", at: 2, until: Date.parse("2099-11-26T00:00:00Z") }], warned: [] },
  "an entry without a keep time is kept until a day after its cycle's reset (at least the usual time); one past that is dropped");
  // Over 2000: those kept longest stay (a weekly cycle isn't pushed out by many short ones)
  const many = Array.from({ length: 2100 }, (_, i) => ({ key: `claude.five_hour.${i}`, at: recent, until: recent + 3_600_000 + i }));
  const long = { key: "claude.seven_day.x", at: recent - 5000, until: recent + 7 * 86_400_000 };
  const kept = lib.readNotifyState(JSON.stringify({ told: { limits: [long, ...many] } })).told.limits;
  assert.equal(kept.length, 2000);
  assert.ok(kept.some((x: any) => x.key === "claude.seven_day.x"));
  assert.equal(lib.lockFree("", NOTE_NOW), true);
  assert.equal(lib.lockFree(`abc ${NOTE_NOW.getTime() + 1000}`, NOTE_NOW), false);
  assert.equal(lib.lockFree(`abc ${NOTE_NOW.getTime()}`, NOTE_NOW), true);
  assert.equal(lib.eventsCursor([`headroom-events-${TAG}-3`, `headroom-events-${TAG}-12`, "headroom-events-ff-99"], TAG), 12);
  assert.equal(lib.eventsCursor([], TAG), null);
  assert.ok(lib.OWN_FILE.test(`headroom-notify-${TAG}.json`) && lib.OWN_FILE.test(`headroom-lock-${TAG}`) && lib.OWN_FILE.test(lib.eventsFileName(TAG, 7)));
});

/** View body for runWidget from a demo */
const demoBody = (name: string, now: Date) => ({ ...plain(lib.demoResult(name, now).view), data_version: 1, view_version: 1 });

test("The notifying widget schedules reminders, marks where the events are on the first read, then tells each new event once", async () => {
  const files = new Map<string, string>();
  const notifier = newNotifier();
  const now = NOTE_NOW;
  const body = demoBody("reset", now);
  let events: any = { last_seq: 3, oldest_seq: 1, events: [ev(3, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })] };
  const responder = (url: string) => (url.includes("/v2/events") ? { status: 200, body: events } : undefined);
  const run = (at: Date, parameter = "claude, notify") => runWidget({ family: "medium", parameter, response: { status: 200, body }, responder, files, notifier, now: at });
  const first = await run(now);
  assert.equal(texts(first.widget.node).includes("Claude"), true, "draws as without notify");
  assert.ok(first.requests.some((r: any) => /\/v2\/events\?after=0$/.test(r.url)));
  assert.equal(notifier.log.length, 1, "only the reminder (events before the first read are not told)");
  assert.equal(notifier.log[0].trigger, Date.parse(body.codex.windows.five_hour.resets_at));
  assert.match(notifier.log[0].id, /^headroom\.0{16}\.back\.codex\.all\.\d+\.[0-9a-f]{16}\.[0-9a-f]{8}$/, "the account's mark, then the operation's");
  assert.equal(notifier.log[0].openURL, "scriptable:///run/Headroom?open=details&provider=codex", "tapping opens the details");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-3`));
  events = { last_seq: 5, oldest_seq: 1, events: [ev(5, "limit", { window_id: "seven_day", label: "Weekly", cycle: "2026-11-20T00:00:00Z", resets_at: "2026-11-20T00:00:00Z" })] };
  const second = await run(new Date(now.getTime() + 15 * 60_000));
  assert.ok(second.requests.some((r: any) => /\/v2\/events\?after=3$/.test(r.url)));
  assert.equal(notifier.log.length, 2, "the reminder isn't scheduled again");
  assert.equal(notifier.log[1].title, "Claude · Weekly limit");
  assert.match(notifier.log[1].body, new RegExp(`^${S.limit} Limit reached`));
  assert.match(notifier.log[1].id, /^headroom.0{16}.events.5.claude$/);
  assert.equal(notifier.log[1].trigger, null, "told right away");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-5`) && !files.has(`/docs/headroom-events-${TAG}-3`), "the cursor moved on");
  await run(new Date(now.getTime() + 30 * 60_000));
  assert.equal(notifier.log.length, 2, "nothing new");
  assert.ok(!files.has(`/docs/headroom-lock-${TAG}`), "the lock is released");
  const quiet = await run(new Date(now.getTime() + 45 * 60_000), "claude");
  assert.ok(!quiet.requests.some((r: any) => r.url.includes("/v2/events")), "a widget without notify reads no events");
  // Turned off in the app menu: the reminder is cancelled and the cursor forgotten
  const off = await runWidget({ family: "medium", parameter: "notify", response: { status: 200, body }, responder, files, notifier, now,
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: '{"events":false,"times":false}' } });
  assert.ok(!off.requests.some((r: any) => r.url.includes("/v2/events")));
  assert.equal(notifier.pending.size, 0);
  assert.ok(![...files.keys()].some((k) => k.includes("headroom-events-")));
});

test("Notifying: settings changed during the events read undo what this run scheduled and keep the cursor", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const body = demoBody("reset", NOTE_NOW);
  const events = { last_seq: 5, oldest_seq: 1, events: [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })] };
  await runWidget({
    family: "medium", parameter: "notify", response: { status: 200, body }, files, notifier, now: NOTE_NOW,
    responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : undefined),
    onLoad: (k, url) => { if (url.includes("/v2/events")) k.set(lib.KEYCHAIN_CONFIG, JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" })); },
  });
  assert.equal(notifier.pending.size, 0, "the reminder scheduled before the change was removed");
  assert.equal(notifier.delivered.size, 0, "the event isn't told");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-3`) && !files.has(`/docs/headroom-events-${TAG}-5`));
  const saved = files.get(`/docs/headroom-notify-${TAG}.json`);
  assert.ok(!saved || JSON.parse(saved).told.limits.length === 0, "the limit isn't remembered as told");
});

test("A shortcut with \"notify\" only notifies (no menu, no screen) and returns a summary", async () => {
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", response: { status: 200, body: demoBody("reset", NOTE_NOW) }, notifier, now: NOTE_NOW,
    responder: (url) => (url.includes("/v2/events") ? { status: 200, body: { last_seq: 0, oldest_seq: null, events: [] } } : undefined) });
  assert.equal(run.widget, null);
  assert.deepEqual(run.presented, []);
  assert.equal(run.shortcutOutput, "No new alerts · 1 reminder scheduled");
  assert.equal(notifier.pending.size, 1);
});

test("Tapping the widget opens the details: each column its own provider, the lock screen its limit's provider; not the demo", async () => {
  const medium = await runWidget({ family: "medium" });
  assert.equal(medium.widget.url, "scriptable:///run/Headroom?open=details");
  const cols = columnsOf(medium.widget.node);
  assert.deepEqual(cols.map((c) => c.props.url), ["scriptable:///run/Headroom?open=details&provider=codex", "scriptable:///run/Headroom?open=details&provider=claude"]);
  const single = await runWidget({ family: "small", parameter: "claude" });
  assert.equal(single.widget.url, "scriptable:///run/Headroom?open=details&provider=claude");
  const lock = await runWidget({ family: "accessoryRectangular", parameter: "claude 5h" });
  assert.equal(lock.widget.url, "scriptable:///run/Headroom?open=details&provider=claude");
  const demo = await runWidget({ family: "medium", demo: "runout" });
  assert.equal(demo.widget.url, undefined);
  const noScheme = await runWidget({ family: "medium", scriptUrl: null });
  assert.equal(noScheme.widget.url, undefined);
  assert.equal(lib.detailUrl("scriptable:///run/Headroom?x=1", "codex"), "scriptable:///run/Headroom?x=1&open=details&provider=codex");
});

test("The details screen reads the view, the events and the weekly series, and shows only the tapped provider", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const body = demoBody("runout", now);
  const events = { last_seq: 2, oldest_seq: 1, events: [ev(1, "threshold", { threshold: 80, created_at: new Date(now.getTime() - 3_600_000).toISOString() }),
    ev(2, "limit", { provider: "codex", created_at: new Date(now.getTime() - 60_000).toISOString() })] };
  const run = await runWidget({ family: "medium", inApp: true, query: { open: "details", provider: "claude" }, response: { status: 200, body }, now,
    responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : url.includes("/v2/history") ? { status: 404, body: {} } : undefined) });
  assert.equal(run.webPages.length, 1);
  assert.deepEqual(run.presented, [], "no menu");
  assert.deepEqual(plain(run.requests.map((r: any) => new URL(r.url).pathname + (r.url.includes("provider=") ? `?${/provider=\w+/.exec(r.url)![0]}` : ""))),
    ["/v2/view", "/v2/events", "/v2/history?provider=claude"]);
  const html = run.webPages[0]!;
  assert.ok(html.includes(">Claude") && !html.includes(">Codex"), "only Claude");
  assert.ok(html.includes(`<div class="tile warn"><em>${S.runout} Forecast</em>`) && html.includes("<span>runs out</span>"), "the forecast");
  assert.ok(html.includes("Weekly usage") && html.includes("<svg"), "the weekly chart (even pace and forecast without a series)");
  assert.ok(html.includes(`${S.left} 20% left`) && !html.includes("ic-codex\"></i><span class=\"lim\""), "the provider's history");
  assert.ok(html.includes("<h4>Today</h4>"), "grouped by day");
  const none = await runWidget({ family: "medium", inApp: true, query: { open: "details" }, keychain: {}, app: { form: [] } } as any);
  assert.equal(none.webPages.length, 0, "without settings, the setup comes first");
});

test("The details page escapes what it shows and lists every limit with its pace, forecast and confidence", () => {
  const now = new Date("2026-11-19T12:00:00");
  const view = plain(lib.demoResult("normal", now).view);
  view.claude.windows.seven_day_fable.scope = "<b>x</b>";
  const html: string = lib.detailHtml({ view, events: [ev(1, "anomalous", { scope: "<img src=x>", window_id: "seven_day_fable" })], trends: {}, now, provider: null, note: "" });
  assert.ok(!html.includes("<b>x</b>") && html.includes("Other weekly"), "an unexpected scope is shown as Other");
  assert.ok(!html.includes("<img"));
  assert.equal(lib.scopeName("Fable"), "Fable");
  assert.equal(lib.scopeName("codex_other"), "Other");
  assert.equal(lib.scopeName("Jane Doe <jane@example.com>"), "Other");
  assert.equal(lib.scopeName("Jane Doe"), "Other", "one plain word only");
  // Names every object inherits are plain words, never the inherited function's source
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.equal(lib.scopeName(name), name);
    assert.equal(lib.widgetScopeName(name), name);
    assert.equal(lib.rowLabel({ id: "seven_day_x", scope: name }), `${name} wk`);
  }
  assert.equal(lib.scopeName("__proto__"), "Other", "not a plain word (it starts with _)");
  assert.equal(lib.windowName({ id: "odd", label: "Team plan" }, "odd"), "Limit", "an unknown window's label only if it is one plain word");
  assert.equal(lib.windowName({ id: "odd", label: "Burst" }, "odd"), "Burst");
  assert.equal(lib.fullLimitName({ id: "seven_day_x", scope: "<b>x</b>" }), "Other weekly limit");
  for (const caption of [`${S.reset} Reset`, `${S.lasts} Forecast`, `${S.pace} Pace`, `${S.recent} Recent`, "Confidence"]) assert.ok(html.includes(`<em>${caption}</em>`), caption);
  assert.equal((html.match(/<div class="tiles">/g) ?? []).length, 5, "a grid of tiles for every limit (Codex 2, Claude 3)");
  assert.ok(html.includes('class="dot" style="background:#34C759"'), "freshness dot");
  // Confidence: the word in the same style as the other values, and the worst case (demo Claude 5h: 65% left at 4%/h outlasts the reset)
  assert.ok(html.includes("<em>Confidence</em><b>High</b><span>worst: lasts</span>"), "confidence word and the worst case");
  // Demo "runs out": Claude 5h has 30% left at 30%/h, fetched a minute ago, so at worst it runs out in 59 minutes
  const runout = plain(lib.demoResult("runout", now).view);
  assert.equal(lib.worstText(lib.atDisplayTime(runout.claude.windows.five_hour, now), now), "worst: 59m");
  // The faster 15-minute rate: 30% left at 60%/h runs out in 30 minutes from the fetch (a minute ago)
  assert.equal(lib.worstText({ ...runout.claude.windows.five_hour, rate_15m: 60 }, now), "worst: 29m");
  assert.equal(lib.worstText(runout.claude.windows.five_hour, new Date(now.getTime() + 70 * 60_000)), "worst: now");
  assert.equal(lib.worstText({ ...runout.claude.windows.five_hour, rate_pace: 0 }, now), "worst: lasts", "a rate too small to measure");
  const older = { ...runout.claude.windows.five_hour };
  delete older.rate_pace;
  assert.equal(lib.worstText(older, now), "", "nothing for derived values of the old format");
  // a newer value with older derived values: the worst case follows the newer value, as the forecast does
  const newer = { ...runout.claude.windows.five_hour, used_percent: 85 };
  assert.equal(lib.worstText(newer, now), "worst: 29m", "15% left at 30%/h");
  assert.ok(!html.includes("●●"), "no meter");
  const low = plain(lib.demoResult("normal", now).view);
  low.claude.windows.five_hour.confidence = "low";
  assert.ok(lib.detailHtml({ view: low, events: null, trends: {}, now, provider: "claude", note: "" }).includes("<em>Confidence</em><b>Low</b><span>not drawn</span>"));
  assert.ok(html.includes(".ic-claude{") && html.includes('<i class="ic ic-claude">'), "provider icons");
  assert.ok(!html.includes("<h3>Symbols</h3>") && !html.includes("<em>Updated</em>"), "no key and no Updated tile (the age is beside the header dot)");
  assert.ok(html.includes(`<span class="fresh"><span class="pc">desktop ·</span><span>1m</span><i class="dot"`), "the PC the values came from and their age beside the freshness dot");
  // the PC's name only as the server registers one; none for a denied provider (its values are withheld) or from an older server
  const named = (collector: unknown, error_code: string | null = null) => {
    const v = plain(lib.demoResult("normal", now).view) as any;
    return lib.sanitizeView({ ...v, claude: { ...v.claude, collector, error_code, main_window_ids: v.claude.main_window_ids.join(","), window_ids: v.claude.window_ids.join(",") } })?.claude.collector;
  };
  assert.equal(named("macbook"), "macbook");
  for (const bad of ["Mac Book", "<b>pc</b>", "-pc", "a".repeat(33), 7, undefined]) assert.equal(named(bad), null, String(bad));
  assert.equal(named("macbook", "access_denied"), null, "denied");
  const unnamed = plain(lib.demoResult("normal", now).view) as any;
  unnamed.claude.collector = null;
  assert.ok(lib.detailHtml({ view: unnamed, events: null, trends: {}, now, provider: "claude", note: "" }).includes(`<span class="fresh"><span>1m</span><i class="dot"`), "the age alone without a name");
  assert.ok(html.includes(`<div class="tile wide"><em>${S.pace} Pace</em>`), "Pace takes two columns");
  // Not available, as on the widget
  const no5h = lib.detailHtml({ view: plain(lib.demoResult("no5h", now).view), events: null, trends: {}, now, provider: "codex", note: "" });
  assert.ok(no5h.includes(`<span class="name">5h limit</span><b>—</b>`) && no5h.includes(`>✕ ${lib.NOT_AVAILABLE}<`), "led by ✕");
  assert.ok(no5h.includes("Other weekly"), "per-group limits too");
  assert.ok(!/https?:\/\//.test(html), "nothing loaded from the network");
  assert.equal(lib.esc(`a&"'`), "a&amp;&quot;&#39;");
});

test("Notifying: a notification that can't be scheduled keeps the cursor, so the next run tries again", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const events = { last_seq: 5, oldest_seq: 1, events: [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })] };
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", response: { status: 200, body: demoBody("normal", NOTE_NOW) }, files, now: NOTE_NOW,
    scheduleFails: true, responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : undefined) });
  assert.equal(run.shortcutOutput, "Couldn't notify");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-3`) && !files.has(`/docs/headroom-events-${TAG}-5`));
  assert.ok(!files.has(`/docs/headroom-lock-${TAG}`), "the lock is released");
});

test("Sample notifications show every kind per provider, built like the real ones", () => {
  const S = lib.SYMBOLS;
  const claude = plain(lib.sampleNotifications(["claude"], NOTE_NOW));
  assert.deepEqual(claude.map((n: any) => n.title), ["Claude · 5h limit", "Claude · 5h limit", "Claude · 5h limit", "Claude · 5h limit", "Claude · 5h limit",
    "Claude · Weekly limit", "Claude", "Headroom", "Headroom"]);
  const bodies = claude.map((n: any) => n.body);
  assert.ok(bodies[0].startsWith(`${S.runout} ~15 min left (runs out `), bodies[0]);
  assert.equal(bodies[1], `${S.runout} ~30 min left at this pace`, "the event's warning too");
  assert.ok(bodies[2].startsWith(`${S.limit} Limit reached · ${S.reset} `), bodies[2]);
  assert.equal(bodies[3], `${S.reset} Reset · usable again`);
  assert.equal(bodies[4], `${S.reset} Reset (estimated) · usable again`);
  assert.ok(bodies[5].startsWith(`${S.left} 20% left · ${S.reset} `), bodies[5]);
  assert.equal(bodies[6], `${S.runout} Sign in required`);
  assert.ok(bodies[7].startsWith(`${S.stopped} No new values from the PCs since `), bodies[7]);
  assert.equal(bodies[8], `${S.resumed} Values updating again`, "and collection resumed");
  const both = plain(lib.sampleNotifications(["claude", "codex"], NOTE_NOW));
  assert.equal(both.length, 16, "seven per provider and two without");
  assert.deepEqual([...new Set(both.map((n: any) => n.provider))], ["codex", "claude", null], "Codex first, as on the widget");
  assert.ok(both.filter((n: any) => n.provider === "codex").every((n: any) => n.title.startsWith("Codex")));
});

test("The app menu sends the sample notifications of the chosen provider right away", async () => {
  const notifier = newNotifier();
  // Main menu: Notifications (2) -> Send sample notifications (0) -> Codex (0) -> Back -> Close
  const run = await runWidget({ family: "medium", notifier, app: { menu: [2, 0, 0] } });
  assert.equal(run.error, null);
  assert.equal(notifier.log.length, 9);
  assert.ok(notifier.log.every((n: any) => n.trigger === null), "right away");
  assert.ok(notifier.log.slice(0, 7).every((n: any) => n.title.startsWith("Codex") && n.openURL === "scriptable:///run/Headroom?open=details&provider=codex"));
  assert.ok(notifier.log.every((n: any) => /^headroom\.0{16}\.sample\.\d+$/.test(n.id)), "kept apart from real notifications");
  assert.equal(run.requests.length, 0, "nothing is read");
});

test("The details list a provider's overall limits, then its model limits, then other providers' models; 5h before weekly", () => {
  const now = new Date("2026-11-19T12:00:00");
  const demo = lib.demoResult("three", now);
  // in the order a PC reports them (other providers' models first, the weekly overall limit last)
  const g = demo.view.gemini;
  const view = { ...demo.view, gemini: { ...g,
    window_ids: ["partner_seven_day", "partner_five_hour", "seven_day", "seven_day_argon", "five_hour"],
    main_window_ids: ["seven_day", "five_hour"] } };
  const html: string = lib.detailHtml({ view, events: [], trends: demo.trends, now, provider: "gemini", note: "" });
  const names = [...html.matchAll(/<span class="name">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(names, ["5h limit", "Weekly limit", "Argon weekly", "Claude/GPT 5h", "Claude/GPT weekly"]);
});

test("Small: one limit per provider, the shortest every provider has; a named provider keeps its rows", () => {
  const now = new Date("2026-11-19T12:00:00");
  const view = lib.demoResult("three", now).view;
  const shown = (v: any, parameter = "") => plain(lib.layoutGroups(v, "small", parameter, now).groups)
    .map((g: any) => `${g.provider}:${g.rows.map((r: any) => (r.kind === "missing" ? `${r.label}=NA` : r.window.id)).join("+")}`);
  assert.deepEqual(shown(view), ["codex:five_hour", "claude:five_hour", "gemini:five_hour"]);
  // no 5h anywhere: the weekly limit for all
  const drop = (p: any) => ({ ...p, main_window_ids: p.main_window_ids.filter((id: string) => id !== "five_hour"),
    window_ids: p.window_ids.filter((id: string) => id !== "five_hour") });
  const weekly = { ...view, codex: drop(view.codex), claude: drop(view.claude), gemini: drop(view.gemini) };
  assert.deepEqual(shown(weekly), ["codex:seven_day", "claude:seven_day", "gemini:seven_day"]);
  // one provider without 5h: the weekly for all (no Not available)
  const one = { ...view, codex: drop(view.codex) };
  assert.deepEqual(shown(one), ["codex:seven_day", "claude:seven_day", "gemini:seven_day"]);
  // none shared (one has only a 5h, another only a weekly): the shortest, the other says it has none
  const only = (p: any, id: string) => ({ ...p, main_window_ids: [id], window_ids: [id] });
  const apart = { ...view, codex: only(view.codex, "seven_day"), claude: only(view.claude, "five_hour"), gemini: only(view.gemini, "five_hour") };
  assert.deepEqual(shown(apart), ["codex:5h limit=NA", "claude:five_hour", "gemini:five_hour"]);
  // a single provider named: its limits as before (more than one row)
  assert.ok(lib.layoutGroups(view, "small", "claude", now).groups[0].rows.length >= 2);
});

test("A limit not started yet (nothing used, no reset time) says its countdown starts on first use", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const demo = lib.demoResult("three", now);
  const unused = { ...demo.view.gemini.windows.five_hour, used_percent: 0, used_percent_int: 0, remaining_percent: 100,
    remaining_percent_int: 100, resets_at: null, reset_passed: false, recent_consumed_percent: 0 };
  assert.deepEqual(plain(lib.timeShort(unused, now)), { warn: false, kind: "text", text: "On first use", symbol: "start" });
  // in use, or reset since its fetch: not this
  const used = { ...unused, used_percent: 3, used_percent_int: 3, remaining_percent: 97, remaining_percent_int: 97 };
  assert.notEqual(lib.timeShort(used, now)?.text, "On first use");
  assert.notEqual(lib.timeShort({ ...unused, reset_passed: true }, now)?.text, "On first use");
  const view = { ...demo.view, gemini: { ...demo.view.gemini, windows: { ...demo.view.gemini.windows, five_hour: unused } } };
  const html: string = lib.detailHtml({ view, events: [], trends: demo.trends, now, provider: "gemini", note: "" });
  assert.ok(html.includes("Not started") && html.includes("on first use"), "the details' reset tile");
  const run = await runWidget({ family: "medium", response: { status: 200, body: { ...view, data_version: 1, view_version: 1 } }, now });
  assert.ok(texts(run.widget.node).includes("On first use"), texts(run.widget.node).join(" | "));
});

test("Row labels are sized between the short name drawn and the long one (Wk limit and Weekly limit)", () => {
  const now = new Date("2026-11-19T12:00:00");
  const view = lib.demoResult("three", now).view;
  const layout = lib.layoutGroups(view, "medium", "", now);
  const opts = { scale: layout.scale, width: layout.colWidth, now, rows: Infinity, content: layout.content };
  const fit = lib.fittedSizes(layout.groups, opts);
  const plans = layout.groups.flatMap((g: any) => g.rows.map((r: any) => lib.rowPlan(r, opts)));
  assert.ok(plans.some((p: any) => p.label === "Wk limit" && p.fitLabel === "Weekly limit"), JSON.stringify(plans.map((p: any) => p.label)));
  const k = (v: number) => Math.max(0.7, Math.min(1, v));
  const room = (p: any) => opts.width - (p.showPct ? 8 + lib.textWidth(p.pct, layout.scale.pct, !p.missing) : 0);
  const sizeFor = (w: (p: any) => number) => Math.floor(layout.scale.label * k(Math.min(...plans.map((p: any) => room(p) / w(p)))) * 2) / 2;
  const wide = (x: string) => lib.textWidth(x, layout.scale.label);
  const long = sizeFor((p) => wide(p.fitLabel));
  const short = sizeFor((p) => wide(p.label));
  const mid = sizeFor((p) => (wide(p.label) + wide(p.fitLabel)) / 2);
  assert.equal(fit.label, mid);
  assert.ok(long <= mid && mid <= short && long < short, `${long} ${mid} ${short}`);
});

test("Every status under a bar is led by a monochrome mark: ↻ reset, ⚠ run-out, ✕ Not available, ⧗ On first use, ? Reset unknown", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const demo = lib.demoResult("three", now);
  const g = demo.view.gemini.windows;
  const unused = { ...g.five_hour, used_percent: 0, used_percent_int: 0, remaining_percent: 100, remaining_percent_int: 100, resets_at: null, reset_passed: false, recent_consumed_percent: 0 };
  const unknown = { ...g.seven_day, resets_at: null, reset_passed: false };
  assert.equal(lib.timeMarkOf(lib.timeShort(unused, now)), "start");
  assert.deepEqual(plain(lib.timeShort(unknown, now)), { warn: false, kind: "text", text: "Reset unknown", symbol: "unknown" });
  assert.equal(lib.timeMarkOf(lib.timeShort(g.seven_day, now)), "reset");
  for (const key of Object.keys(lib.TIME_SYMBOLS)) assert.ok(lib.TIME_MARKS[key], `a text mark for ${key}`);
  // drawn: each text status follows its symbol in the same row
  const view = { ...demo.view, gemini: { ...demo.view.gemini, windows: { ...g, five_hour: unused, seven_day: unknown } } };
  const run = await runWidget({ family: "medium", response: { status: 200, body: { ...view, data_version: 1, view_version: 1 } }, now });
  const rows = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(rows)];
  for (const [text, key] of [["On first use", "start"], ["Reset unknown", "unknown"]] as const) {
    const row = rows(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "text" && c.props.text === text));
    assert.ok(row, text);
    assert.equal(row.children[0].props.symbol, lib.TIME_SYMBOLS[key], text);
  }
});

test("Most (large): by the limit named, the provider using most of it with all its own limits, then the others side by side; no chart", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const view = lib.demoResult("three", now).view;
  const used = (p: string, id: string) => lib.atDisplayTime(view[p].windows[id], now).used_percent;
  for (const [parameter, id] of [["most, 5h", "five_hour"], ["most", "five_hour"], ["wk most", "seven_day"]] as const) {
    const layout = lib.layoutGroups(view, "large", parameter, now);
    assert.equal(layout.most, true, parameter);
    assert.equal(layout.trendHeight, 0, `${parameter}: no chart`);
    const expected = ["codex", "claude", "gemini"].sort((a, b) => used(b, id) - used(a, id));
    assert.deepEqual(plain(layout.groups.map((g: any) => g.provider)), expected, parameter);
    const [first, ...rest] = layout.groups;
    const ids = plain(first.rows.map((r: any) => r.window?.id));
    assert.ok(ids.includes("five_hour") && ids.includes("seven_day"), `${parameter}: the first shows all its own limits: ${ids}`);
    // its own per-model limits too, also below 100%
    const own = view[first.provider].window_ids.filter((w: string) => view[first.provider].windows[w].scope !== null && !view[first.provider].windows[w].detail_only);
    for (const w of own) assert.ok(ids.includes(w), `${parameter}: ${w} of ${first.provider} (${ids})`);
    assert.ok(own.length > 0 || parameter !== "most, 5h", "the sample's first has one");
    assert.ok(!ids.some((x: string) => x?.startsWith("partner_")), "never another provider's models");
    for (const g of rest) assert.ok(g.rows.length <= 2 && g.rows.every((r: any) => r.kind === "missing" || r.window.scope === null), `${parameter}: ${g.provider}`);
    assert.equal(layout.colWidth, Math.floor((layout.inner - layout.gap * (rest.length - 1)) / rest.length), "the others side by side");
  }
  assert.deepEqual(plain(lib.layoutGroups(view, "large", "most, claude, gemini", now).groups.map((g: any) => g.provider)).sort(), ["claude", "gemini"], "among those named");
  assert.equal(lib.layoutGroups(view, "medium", "most, 5h", now).most, false, "medium: not a mode there");
  const run = await runWidget({ family: "large", demo: "three", parameter: "most, 5h", now });
  assert.equal(run.error, null, String(run.error));
  const all = texts(run.widget.node);
  assert.ok(!all.includes("Weekly usage"), all.join(" | "));
  const order = ["Codex", "Claude", "Gemini"].sort((a, b) => all.indexOf(a) - all.indexOf(b));
  assert.equal(order[0], lib.PROVIDER_NAMES[lib.layoutGroups(view, "large", "most, 5h", now).groups[0].provider], "the first drawn first");
});

test("Widget rows: the overall limits first (5h, then weekly), then the provider's own per-model ones, then other makers' models, whatever the view's order", () => {
  const now = new Date("2026-11-19T12:00:00");
  const demo = lib.demoResult("three", now).view;
  const g = demo.gemini;
  const view = { ...demo, gemini: { ...g, window_ids: ["partner_seven_day", "seven_day_argon", "seven_day", "partner_five_hour", "five_hour"], main_window_ids: ["seven_day", "five_hour"] } };
  const rows = plain(lib.groupsOf(view, "gemini", now, { allScoped: true })[0].rows.map((r: any) => r.window.id));
  assert.deepEqual(rows, ["five_hour", "seven_day", "seven_day_argon", "partner_five_hour", "partner_seven_day"]);
});

test("Legend dots keep the provider's color also without a trend this week (details and the large widget)", async () => {
  const now = new Date("2026-11-19T12:00:00");
  const demo = lib.demoResult("normal", now);
  const html: string = lib.detailHtml({ view: demo.view, events: [], trends: { ...demo.trends, codex: null }, now, provider: null, note: "" });
  assert.ok(html.includes(`<i class="dot" style="background:${lib.BRAND_COLORS.codex}"></i>Codex</span>`) && !html.includes("Codex –"),
    "Codex without a trend: its color and name, no –");
  const history = (url: string) => {
    if (!url.includes("/v2/history")) return undefined;
    const q = new URL(url).searchParams;
    const points = q.get("provider") === "claude" ? [{ at: "2026-11-16T12:00:00.000Z", used_percent: 8, resets_at: null, break: null }] : [];
    return { status: 200, body: { provider: q.get("provider"), since: null, boundary: "#0", windows: { [q.get("window")!]: points } } };
  };
  const run = await runWidget({ family: "large", responder: history });
  const find = (node: Node): Node | null =>
    node.children.some((c) => c.kind === "text" && c.props.text === "Weekly usage") ? node : node.children.map(find).find(Boolean) ?? null;
  const legend = find(run.widget.node);
  assert.ok(legend && !texts(legend).some((x) => x.endsWith(" –")), "the legend, no –");
  const at = legend!.children.findIndex((c) => c.kind === "text" && c.props.text === "Codex");
  const dot = legend!.children.slice(0, at).reverse().find((c) => c.kind === "image")!;
  assert.deepEqual((dot.props.fills as any[]).map((c) => c.hex), [lib.BRAND_COLORS.codex]);
});

test("The details page heads the chart with the providers' dots and lines up the history's times", () => {
  const now = new Date("2026-11-19T12:00:00");
  const demo = lib.demoResult("normal", now);
  const events = [ev(1, "threshold", { threshold: 80, created_at: new Date("2026-11-19T09:05:00").toISOString() })];
  const html: string = lib.detailHtml({ view: demo.view, events, trends: demo.trends, now, provider: null, note: "" });
  assert.ok(html.includes(`<div class="chead"><h3>Weekly usage</h3><div class="plegend"><span><i class="dot" style="background:${lib.BRAND_COLORS.codex}"></i>Codex</span>`),
    "Codex then Claude as colored dots, at the top as on the widget");
  assert.ok(html.includes("<time>09:05</time>"), "two-digit hours on the 24-hour clock");
  assert.ok(!/\b[AP]M\b/.test(html), "no AM or PM in the details");
  assert.ok(html.includes('<span class="pn"><h2'), "the name and the plan share a baseline");
  const none = lib.detailHtml({ view: demo.view, events: [], trends: {}, now, provider: null, note: "" });
  assert.ok(none.includes("<span>No weekly data yet</span>"));
});

test("The app menu: Details, Preview widget, Notifications and Settings, each coming back to the menu until Close", async () => {
  // Details, then Close
  const details = await runWidget({ family: "medium", app: { menu: [0] }, responder: (url) => (url.includes("/v2/events") ? { status: 200, body: { last_seq: 0, oldest_seq: null, events: [] } } : undefined) });
  assert.equal(details.webPages.length, 1);
  assert.deepEqual(details.presented, ["menu", "menu"], "back to the menu after the details");
  // Preview widget -> Current values -> Medium, then Lock screen · Rectangular (the same values, read for each size)
  const live = await runWidget({ family: "medium", app: { menu: [1, 0, 1, 3] } });
  assert.deepEqual(live.shownSizes, ["medium", "accessoryRectangular"]);
  assert.ok(live.requests.every((r: any) => r.url.includes("/v2/view")), "current values come from the server");
  assert.ok(texts(live.widget.node).length > 0);
  // Notifications -> Limit alerts: On becomes Off
  const toggled = await runWidget({ family: "medium", app: { menu: [2, 1] } });
  assert.deepEqual(plain(lib.notifyPrefs(savedSwitches(toggled.keychain))), { events: false, times: true, rev: 1, times_off_at: null, cancel_pending: false, cancelled: [], cancels: [] }, "each change moves the counter");
  // Settings -> Reset saved data (confirmed): the saved files go, the server and token stay (under a new generation)
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""], [`/docs/headroom-notify-${TAG}.json`, "{}"]]);
  const reset = await runWidget({ family: "medium", files, app: { menu: [3, 2, 0] } });
  assert.equal(files.size, 0);
  const kept = savedConfig(reset.keychain);
  assert.deepEqual([kept.url, kept.token], ["https://headroom.example.com", "read-token-xyz"]);
  // Without settings: the form first, then the menu
  const first = await runWidget({ family: "medium", keychain: {}, app: { menu: [], form: ["https://headroom.example.com", "t"] } });
  assert.deepEqual(first.presented, ["form", "menu"]);
  assert.ok(savedConfig(first.keychain) !== null);
});

test("The parameter guide lists what the Parameter can say; every builder choice is a parameter the widget reads", () => {
  assert.equal(lib.buildParameter("claude", true), "claude, notify");
  assert.equal(lib.buildParameter("", true), "notify");
  assert.equal(lib.buildParameter("", false), "", "empty means leave it empty");
  const now = new Date("2026-11-19T12:00:00");
  const view = lib.demoResult("three", now).view;
  // Lock screen choices pick limits of the right providers (one, or two side by side)
  const picks = (p: string) => plain(lib.lockPicks(view, lib.splitNotify(lib.buildParameter(p, true)).display, now).map((x: any) => `${x.provider}.${x.window.id}`));
  const lock = Object.fromEntries(plain(lib.PARAMETER_CHOICES.lock).map(([label, p]: [string, string]) => [label, picks(p)]));
  assert.deepEqual(lock["Claude 5h"], ["claude.five_hour"]);
  assert.deepEqual(lock["Codex weekly"], ["codex.seven_day"]);
  assert.deepEqual(lock["Gemini weekly"], ["gemini.seven_day"]);
  assert.equal(lock["The tightest limit for its time left"].length, 1);
  assert.equal(lock["5h, of the tightest provider"].length, 1);
  assert.equal(lock["5h of the others (beside the one above)"].length, 2, "the three but the tightest");
  assert.ok(!lock["5h of the others (beside the one above)"].includes(lock["5h, of the tightest provider"][0]));
  // Home screen choices show the right groups
  const groups = (p: string) => plain(lib.groupsOf(view, lib.splitNotify(lib.buildParameter(p, true)).display, now).map((g: any) => g.provider));
  const home = Object.fromEntries(plain(lib.PARAMETER_CHOICES.home).map(([label, p]: [string, string]) => [label, groups(p)]));
  assert.deepEqual(home, {
    "Codex and Claude (and any other with values)": ["codex", "claude", "gemini"], "All three": ["codex", "claude", "gemini"],
    "Claude only": ["claude"], "Codex only": ["codex"], "Gemini only": ["gemini"], "Codex and Claude only": ["codex", "claude"],
    "Claude and Gemini": ["claude", "gemini"], "Codex and Gemini": ["codex", "gemini"],
    "The 5h limit of each": ["codex", "claude", "gemini"], "The weekly limit of each": ["codex", "claude", "gemini"],
    "Large: most used 5h first": ["codex", "claude", "gemini"], "Large: most used weekly first": ["codex", "claude", "gemini"],
  });
  // every choice is read whole (no word left unknown)
  for (const [, p] of [...plain(lib.PARAMETER_CHOICES.home), ...plain(lib.PARAMETER_CHOICES.lock)] as [string, string][]) {
    assert.deepEqual(plain(lib.parseParameter(p).unknown), [], p);
  }
  // Without Gemini's values: the default is the two; Gemini named shows as not supported
  const two = lib.demoResult("normal", now).view;
  assert.deepEqual(plain(lib.groupsOf(two, "", now).map((g: any) => g.provider)), ["codex", "claude"]);
  assert.deepEqual(plain(lib.groupsOf(two, "claude, gemini", now).map((g: any) => [g.provider, g.message])), [["claude", null], ["gemini", "Not set up"]]);
  const html: string = lib.parameterGuideHtml();
  for (const p of ["claude", "5h", "wk", "notify", "most, 5h", "claude, 5h", "5h, others", "claude, codex, 5h"]) assert.ok(html.includes(`<code>${p}</code>`), p);
  for (const p of ["top", "both", "demo", "claude.five_hour", "+"]) assert.ok(!html.includes(`<code>${p}`) && !html.includes(`${p}</code>`), `no ${p}`);
  assert.ok(!/\bdemo\b/i.test(html), "no demo word");
  assert.ok(html.includes("Preview sample data"), "the samples are in the app");
  assert.ok(html.includes("Edit Widget") && !/https?:\/\//.test(html));
});

test("The app menu's Widget > Make a parameter copies the parameter or previews it; the guide opens as a page", async () => {
  // Widget -> Make a parameter -> Lock screen -> Claude 5h -> Yes (notifications) -> Copy
  const copy = await runWidget({ family: "medium", app: { menu: [1, 2, 1, 5, 1, 0] } });
  assert.deepEqual(copy.copied, ["claude, 5h, notify"]);
  assert.equal(copy.requests.length, 0, "nothing read just to copy");
  // Widget -> Make a parameter -> Home screen -> Claude only -> No -> Preview -> Medium (home sizes only)
  const preview = await runWidget({ family: "medium", app: { menu: [1, 2, 0, 2, 0, 1, 1] } });
  assert.deepEqual(preview.shownSizes, ["medium"]);
  const all = texts(preview.widget.node);
  assert.ok(all.includes("Claude") && !all.includes("Codex"), "drawn with the parameter claude");
  // An empty parameter has nothing to copy: Widget -> Make -> Home -> Codex and Claude -> No -> Done
  const empty = await runWidget({ family: "medium", app: { menu: [1, 2, 0, 0, 0, -1] } });
  assert.deepEqual(empty.copied, []);
  // Widget -> Parameter guide
  const guide = await runWidget({ family: "medium", app: { menu: [1, 3] } });
  assert.equal(guide.webPages.length, 1);
  assert.ok(guide.webPages[0]!.includes("<h1>Widget parameter</h1>"));
});

test("a folder that can't be listed stops the notifying run instead of reading it as the first run", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-40`, ""]]);
  const notifier = newNotifier();
  const events = { last_seq: 41, oldest_seq: 1, events: [ev(41, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })] };
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, listFails: true,
    response: { status: 200, body: demoBody("normal", NOTE_NOW) }, responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : undefined) });
  assert.equal(run.shortcutOutput, "Couldn't read this iPhone's files");
  assert.ok(!run.requests.some((r: any) => r.url.includes("/v2/events")), "no events read");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-40`) && !files.has(`/docs/headroom-events-${TAG}-41`), "the cursor stays");
  assert.equal(notifier.log.length, 0);
  // Listed again: event 41 is told
  const again = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("normal", NOTE_NOW) }, responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : undefined) });
  assert.equal(again.shortcutOutput, "1 alert · 0 reminders scheduled");
  assert.equal(notifier.log[0].title, "Claude · Weekly limit");
});

test("after an account switch, the new account's limit in the same cycle is told again and its reminders start afresh", () => {
  const key = "claude.seven_day.2026-11-20T00:00:00Z";
  const state = { reminders: [{ id: "headroom.0000000000000000.back.claude.all.1", kind: "back", provider: "claude", window_id: "seven_day", cycle: 1, fire_at: 1 },
    { id: "headroom.0000000000000000.back.codex.all.1", kind: "back", provider: "codex", window_id: "seven_day", cycle: 1, fire_at: 1 }],
    told: { limits: [{ key, at: 1 }, { key: "codex.seven_day.x", at: 1 }], warned: [] }, boundaries: { claude: "2026-11-19T00:00:00.000Z#1", codex: "#0" }, checked_at: null };
  const same = plain(lib.forgetSwitched(state, { claude: "2026-11-19T00:00:00.000Z#1", codex: "#0" }));
  assert.deepEqual(same.switched, []);
  assert.equal(same.state.told.limits.length, 2);
  const switched = plain(lib.forgetSwitched(state, { claude: "2026-11-20T09:00:00.000Z#2", codex: "#0" }));
  assert.deepEqual(switched.switched, ["claude"]);
  assert.deepEqual(switched.cancel, ["headroom.0000000000000000.back.claude.all.1"]);
  assert.deepEqual(switched.state.told.limits.map((x: any) => x.key), ["codex.seven_day.x"], "only Claude's told cycles are forgotten");
  assert.deepEqual(switched.state.reminders.map((r: any) => r.provider), ["codex"]);
  assert.equal(switched.state.boundaries.claude, "2026-11-20T09:00:00.000Z#2");
  const first = plain(lib.forgetSwitched({ ...state, boundaries: null }, { claude: "a#1", codex: "#0" }));
  assert.deepEqual(first.switched, [], "the first stamps seen are only remembered");
  assert.equal(plain(lib.forgetSwitched(state, null)).state.boundaries.claude, "2026-11-19T00:00:00.000Z#1", "a view not fetched now changes nothing");
});

test("the notifying widget tells the new account's limit although the old account's was told in the same cycle", async () => {
  const cycle = "2026-11-20T00:00:00Z";
  const state = { reminders: [], told: { limits: [{ key: `claude.seven_day.${cycle}`, at: NOTE_NOW.getTime() }], warned: [] },
    boundaries: { claude: "2026-11-18T00:00:00.000Z#1", codex: "#0" }, checked_at: null };
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-5`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify(state)]]);
  const notifier = newNotifier();
  const body = { ...demoBody("normal", NOTE_NOW), boundaries: { claude: "2026-11-19T12:00:00.000Z#2", codex: "#0" } };
  const events = { last_seq: 6, oldest_seq: 1, events: [ev(6, "limit", { window_id: "seven_day", label: "Weekly", cycle, resets_at: cycle })] };
  await runWidget({ family: "medium", parameter: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body },
    responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : undefined) });
  assert.deepEqual(notifier.log.map((n: any) => n.title), ["Claude · Weekly limit"]);
  assert.equal(JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).boundaries.claude, "2026-11-19T12:00:00.000Z#2");
});

test("after the server's database is recreated, Reset saved data lets the new numbers 1, 2, ... show and be told", async () => {
  const config = JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" });
  const tag = lib.cacheTag({ id: "1111111111111111" }, "https://headroom.example.com");
  const oldView = JSON.stringify({ saved_at: NOTE_NOW.toISOString(), origin: "https://headroom.example.com", view: lib.sanitizeView(sampleView(900)) });
  const files = new Map<string, string>([[`/docs/${lib.cacheFileName(tag, 900)}`, oldView], [`/docs/${lib.seenFileName(tag, 900)}`, ""],
    [`/docs/headroom-events-${tag}-800`, ""], [`/docs/headroom-notify-${tag}.json`, "{}"]]);
  const notifier = newNotifier();
  notifier.pending.set("headroom.1111111111111111.back.claude.all.1", { id: "headroom.1111111111111111.back.claude.all.1" });
  const keychain = { [lib.KEYCHAIN_CONFIG]: config };
  // Before the reset, the recreated server's number 1 is taken for an old response
  const before = await runWidget({ family: "medium", keychain, files: new Map(files), response: { status: 200, body: sampleView(1) } });
  assert.ok(texts(before.widget.node).includes("90%"), "the old view (number 900) is shown instead");
  // Settings -> Reset saved data
  const reset = await runWidget({ family: "medium", keychain, files, notifier, app: { menu: [3, 2, 0] } });
  const saved = savedConfig(reset.keychain);
  assert.notEqual(saved.id, "1111111111111111", "a new generation");
  assert.deepEqual([saved.url, saved.token], ["https://headroom.example.com", "t"]);
  assert.deepEqual([...files.keys()], [], "saved views, seen numbers, the cursor and the state are gone");
  assert.equal(notifier.pending.size, 0, "scheduled reminders are cancelled");
  // A run that started before the reset and returns late writes under the old generation, which the new settings never read
  const after = await runWidget({ family: "medium", keychain: { [lib.KEYCHAIN_CONFIG]: JSON.stringify(saved) }, files, response: { status: 200, body: { ...sampleView(1), claude: null } } });
  assert.ok(!texts(after.widget.node).includes("Response is older than the last one"));
  assert.ok(files.has(`/docs/${lib.seenFileName(lib.cacheTag(saved, "https://headroom.example.com"), 1)}`), "number 1 is the new generation's");
});

/** Events response for the notifying tests */
const feed = (lastSeq: number, events: any[]) => ({ last_seq: lastSeq, oldest_seq: 1, events });
const eventsAt = (body: any) => (url: string) => (url.includes("/v2/events") ? { status: 200, body } : undefined);

test("a notification that went out is saved at once, so a later failure in the same run never sends it again", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  // Codex's and Claude's limits reached: two notifications; the second fails
  const body = feed(5, [ev(4, "limit", { provider: "codex", window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" }),
    ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })]);
  const run = (fails?: number) => runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, scheduleFailsAfter: fails,
    response: { status: 200, body: demoBody("normal", NOTE_NOW) }, responder: eventsAt(body) });
  const first = await run(1);
  assert.equal(first.shortcutOutput, "Couldn't notify");
  assert.deepEqual(notifier.log.map((n: any) => n.title), ["Codex · Weekly limit"]);
  assert.ok(files.has(`/docs/headroom-events-${TAG}-3`) && !files.has(`/docs/headroom-events-${TAG}-5`), "the cursor waits for the failed one");
  const again = await run();
  assert.deepEqual(notifier.log.map((n: any) => n.title), ["Codex · Weekly limit", "Claude · Weekly limit"], "only the one that failed is sent");
  assert.equal(again.shortcutOutput, "1 alert · 0 reminders scheduled");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-5`));
});

test("a run whose lock was taken while it waited stops before notifying", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })])),
    onLoad: (_k, url) => { if (url.includes("/v2/events")) files.set(`/docs/headroom-lock-${TAG}`, `other ${NOTE_NOW.getTime() + 60_000}`); } });
  assert.equal(run.shortcutOutput, "Another run is notifying");
  assert.equal(notifier.delivered.size, 0, "the event isn't told by this run");
  assert.equal(notifier.pending.size, 1, "its reminder is left to the run that took over (the same plan under the same identifier)");
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`));
  assert.equal(files.get(`/docs/headroom-lock-${TAG}`), `other ${NOTE_NOW.getTime() + 60_000}`, "the other run's lock is left alone");
});

test("switching in the menu takes effect at once: reminders off cancels pending ones, alerts restart from then", async () => {
  const files = new Map<string, string>();
  const notifier = newNotifier();
  await runWidget({ family: "medium", parameter: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body: demoBody("reset", NOTE_NOW) },
    responder: eventsAt(feed(3, [])) });
  assert.equal(notifier.pending.size, 1, "the reset reminder");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-3`));
  // Notifications -> Time reminders: Off
  const off = await runWidget({ family: "medium", files, notifier, now: NOTE_NOW, app: { menu: [2, 2] } });
  assert.equal(notifier.pending.size, 0, "cancelled without waiting for the next run");
  assert.deepEqual(JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).reminders, [], "the menu (holding the runs' lock) drops what it cancelled");
  await runWidget({ family: "medium", parameter: "notify", files, notifier, now: NOTE_NOW, keychain: Object.fromEntries(off.keychain),
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier.pending.size, 0, "not scheduled again while off");
  assert.deepEqual(JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).reminders, [], "the next run drops it");
  // Notifications -> Limit alerts: Off, then On: where they left off is forgotten
  await runWidget({ family: "medium", files, notifier, now: NOTE_NOW, app: { menu: [2, 1, 1] } });
  assert.ok(![...files.keys()].some((k) => k.includes("headroom-events-")), "the next run starts from then");
});

test("saving new settings cancels the old generation's reminders; an older run never removes the new generation's", async () => {
  const notifier = newNotifier();
  const keychain = { [lib.KEYCHAIN_CONFIG]: JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" }) };
  notifier.pending.set("headroom.1111111111111111.back.claude.all.1", { id: "headroom.1111111111111111.back.claude.all.1" });
  const saved = await runWidget({ family: "medium", keychain, notifier, app: { menu: [3, 0], form: ["https://other.example", "t2"] } });
  assert.equal(notifier.pending.size, 0);
  // A run of the older settings, whose pending list comes back after the settings changed
  const newId = savedConfig(saved.keychain).id;
  notifier.pending.set(`headroom.${newId}.back.codex.all.2`, { id: `headroom.${newId}.back.codex.all.2` });
  const files = new Map<string, string>();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", keychain, notifier, files, now: NOTE_NOW, response: { status: 200, body: demoBody("normal", NOTE_NOW) },
    responder: eventsAt(feed(0, [])),
    onLoad: (k, url) => { if (url.includes("/v2/view")) k.set(lib.KEYCHAIN_CONFIG, saved.keychain.get(lib.KEYCHAIN_CONFIG)!); } });
  assert.ok(notifier.pending.has(`headroom.${newId}.back.codex.all.2`), "the new generation's reminder stays");
});

test("no reset reminder without every reset time; monthly cycles are kept; failed reads say so; 80% and collection rules", async () => {
  // the weekly limit at 100% has no reset time
  const view = plain(lib.demoResult("reset", NOTE_NOW).view);
  view.codex.windows.seven_day.used_percent = 100;
  view.codex.windows.seven_day.resets_at = null;
  assert.deepEqual(plain(lib.reminderPlan(view, NOTE_NOW)).filter((x: any) => x.provider === "codex"), []);
  // a monthly limit told on the 1st is still known on the 20th (its reset is later)
  const monthly = ev(1, "limit", { window_id: "monthly", label: "Monthly", cycle: "2026-12-01T00:00:00Z", resets_at: "2026-12-01T00:00:00Z" });
  const told = lib.selectAlerts([monthly], null, NOTE_NOW, { told: { limits: [], warned: [] } }).told;
  const later = new Date("2026-11-30T12:00:00Z");
  const reset = { ...monthly, seq: 2, kind: "reset", confirmed: true, created_at: "2026-11-30T11:59:00Z", resets_at: "2026-12-31T00:00:00Z" };
  assert.equal(lib.selectAlerts([reset], null, later, { told: plain(told), times: false }).alerts.length, 1, "told after 29 days");
  // 80% of a 90-minute limit is not told
  assert.equal(lib.selectAlerts([ev(3, "threshold", { threshold: 80, window_id: "window_90m", label: "90m" })], null, NOTE_NOW, {}).alerts.length, 0);
  // resumed then stopped in one read: neither
  const pair = [ev(4, "collection_resumed", { provider: null, window_id: null }), ev(5, "collection_stopped", { provider: null, window_id: null })];
  assert.equal(lib.selectAlerts(pair, null, NOTE_NOW, {}).alerts.length, 0);
  // a failed read is not "No new alerts", and the last check stays
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, now: NOTE_NOW, response: { status: 200, body: demoBody("normal", NOTE_NOW) },
    responder: (url) => (url.includes("/v2/events") ? { status: 401, body: {} } : undefined) });
  assert.equal(run.shortcutOutput, "Couldn't check alerts · 0 reminders scheduled");
  assert.equal(JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).checked_at, null);
});

test("the details show nothing of settings changed while reading; a sample drawn with a parameter never notifies", async () => {
  // Settings removed while the details read the events
  const run = await runWidget({ family: "medium", inApp: true, query: { open: "details" }, now: NOTE_NOW,
    responder: eventsAt(feed(0, [])), onLoad: (k, url) => { if (url.includes("/v2/events")) k.clear(); } });
  const html = run.webPages[0]!;
  assert.ok(html.includes("Settings changed") && !html.includes("<div class=\"tiles\">"), "no values of the removed settings");
  // claude, demo:normal, notify: the sample (no network, no notifications), showing Claude only
  const notifier = newNotifier();
  const demo = await runWidget({ family: "medium", demo: "normal", parameter: "claude, notify", notifier });
  assert.equal(demo.requests.length, 0);
  assert.equal(notifier.log.length, 0);
  const all = texts(demo.widget.node);
  assert.ok(all.includes("Claude") && !all.includes("Codex"));
  // notify is a word of the parameter, never an unknown one
  assert.deepEqual(plain(lib.parseParameter("claude, notify")), { providers: ["claude"], limits: [], most: false, others: false, notify: true, unknown: [] });
});

test("lock screen taps open the one provider shown; reset lines follow the cycle of now; saving survives a failed cleanup", async () => {
  // A Codex without a 5h limit, named on the rectangle; the line naming only Codex
  const no5h = { ...demoBody("no5h", NOTE_NOW) };
  const rect = await runWidget({ family: "accessoryRectangular", parameter: "codex 5h", response: { status: 200, body: no5h } });
  assert.equal(rect.widget.url, "scriptable:///run/Headroom?open=details&provider=codex");
  const line = await runWidget({ family: "accessoryInline", parameter: "codex weekly", response: { status: 200, body: no5h } });
  assert.equal(line.widget.url, "scriptable:///run/Headroom?open=details&provider=codex");
  // A cached reset time three weeks old: the reset lines and the even pace mark the same cycle
  const now = new Date("2026-11-20T12:00:00");
  const range = lib.weekRange(now);
  const old = { resets_at: new Date("2026-11-05T09:00:00").toISOString() };
  const resets = plain(lib.resetTimes(old, range, now));
  const guide = plain(lib.paceGuide(old, range, now));
  assert.ok(resets.includes(lib.cycleEnd(old, now) - 7 * 86_400_000) || resets.includes(lib.cycleEnd(old, now)), String(resets));
  assert.equal(guide[0][0], Math.max(range.start, lib.cycleEnd(old, now) - 7 * 86_400_000), "the guide starts where a reset line is");
  // The new item is written but removing an older version's item fails: saved, no "Can't save"
  const keychain = { "headroom.url": "https://old.example", "headroom.token": "old" };
  const run = await runWidget({ family: "medium", keychain, app: { menu: [3, 0], form: ["https://new.example", "t"] }, removeKeychainFails: true } as any);
  assert.equal(savedConfig(run.keychain).url, "https://new.example");
  assert.ok(!run.presented.includes("notice"), "no failure shown");
});

test("a new account's limit in the same cycle is told even when the view can't be read or old events come first", async () => {
  const cycle = "2026-11-20T00:00:00Z";
  // The old account's limit was told; the view now fails, the events read works
  const state = { reminders: [], told: { limits: [{ key: `claude.seven_day.${cycle}`, at: NOTE_NOW.getTime() }], warned: [] }, sent: [],
    boundaries: { claude: "a#1", codex: "#0" }, checked_at: null };
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-5`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify(state)]]);
  const notifier = newNotifier();
  // Seq 6 is the old account's limit read late, seq 7 the new account's in the same cycle
  const events = feed(7, [ev(6, "limit", { window_id: "seven_day", label: "Weekly", cycle, resets_at: cycle }),
    ev(7, "limit", { window_id: "seven_day", label: "Weekly", cycle, resets_at: cycle })]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    responder: (url) => (url.includes("/v2/events") ? { status: 200, body: events } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) });
  assert.equal(notifier.log.length, 1, "one notification");
  assert.equal(notifier.log[0].title, "Claude · 2 updates", "both limits told (the second is the new account's)");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-7`));
});

test("a view older than the one the stamps came from is not taken for an account switch", () => {
  const state = { reminders: [{ id: "headroom.0000000000000000.back.claude.all.1", kind: "back", provider: "claude", window_id: "five_hour", cycle: 1, fire_at: 1 }],
    told: { limits: [], warned: [] }, sent: [], boundaries: { claude: "b#2", codex: "#0" }, boundaries_version: 20, checked_at: null };
  const older = plain(lib.forgetSwitched(state, { claude: "a#1", codex: "#0" }, 19));
  assert.deepEqual(older.switched, []);
  assert.equal(older.state.boundaries.claude, "b#2", "the stamps don't go back");
  const newer = plain(lib.forgetSwitched(state, { claude: "c#3", codex: "#0" }, 21));
  assert.deepEqual(newer.switched, ["claude"]);
  assert.equal(newer.state.boundaries_version, 21);
});

test("Reset saved data works only on the generation it replaces, says what it couldn't remove, and stops if the settings changed", async () => {
  const id = "1111111111111111";
  const keychain = { [lib.KEYCHAIN_CONFIG]: JSON.stringify({ url: "https://headroom.example.com", token: "t", id }) };
  const oldTag = lib.cacheTag({ id }, "https://headroom.example.com");
  // A widget of the new generation schedules and writes while the reset lists the notifications
  const notifier = newNotifier();
  notifier.pending.set(`headroom.${id}.back.claude.all.1`, { id: `headroom.${id}.back.claude.all.1` });
  const files = new Map<string, string>([[`/docs/headroom-events-${oldTag}-800`, ""]]);
  const run = await runWidget({ family: "medium", keychain, files, notifier, app: { menu: [3, 2, 0] },
    onWrite: () => {} });
  const newGen = savedConfig(run.keychain).id;
  const newTag = lib.cacheTag({ id: newGen }, "https://headroom.example.com");
  assert.ok(!notifier.pending.has(`headroom.${id}.back.claude.all.1`), "the old generation's reminder is cancelled");
  assert.ok(!files.has(`/docs/headroom-events-${oldTag}-800`));
  // The same reset with a new generation's reminder and files already there: they stay
  notifier.pending.set(`headroom.${newGen}.back.codex.all.2`, { id: `headroom.${newGen}.back.codex.all.2` });
  files.set(`/docs/headroom-events-${newTag}-3`, "");
  const again = await runWidget({ family: "medium", keychain: Object.fromEntries(run.keychain), files, notifier, app: { menu: [3, 2, 0] } });
  const third = savedConfig(again.keychain).id;
  assert.notEqual(third, newGen);
  assert.ok(!notifier.pending.has(`headroom.${newGen}.back.codex.all.2`), "a generation it replaces is cleared");
  // a removal that fails is reported
  const failing = await runWidget({ family: "medium", keychain, files: new Map([[`/docs/headroom-events-${oldTag}-9`, ""]]), removeFails: true, app: { menu: [3, 2, 0] } });
  assert.ok(failing.alertTitles.includes("Partly reset"), "a removal that failed is reported");
  // the settings changed while the confirmation was open: nothing is reset
  const changed = await runWidget({ family: "medium", keychain, app: { menu: [3, 2, 0] },
    onLoad: () => {}, beforeConfirm: (k: Map<string, string>) => k.set(lib.KEYCHAIN_CONFIG, JSON.stringify({ url: "https://other.example", token: "x", id: "2222222222222222" })) } as any);
  assert.equal(savedConfig(changed.keychain).url, "https://other.example", "the newer settings are kept");
});

test("a slow view response of older settings doesn't write its files back after a reset", async () => {
  const files = new Map<string, string>();
  const run = await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(5) },
    onLoad: (k, url) => { if (url.includes("/v2/view")) k.set(lib.KEYCHAIN_CONFIG, JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "3333333333333333" })); } });
  assert.deepEqual([...files.keys()], [], "nothing written for the replaced settings");
  assert.deepEqual(texts(run.widget.node), ["Settings changed. Updates on next refresh"]);
});

test("Notification state keeps every told event above the cursor and the view version it used", () => {
  const sent = Array.from({ length: 300 }, (_, i) => i + 1);
  const state = plain(lib.readNotifyState(JSON.stringify({ sent, view_version: 42 })));
  assert.equal(state.sent.length, 300, "not cut at 200");
  assert.equal(state.view_version, 42);
});

test("an account switch seen late keeps what was told after the new account was accepted", () => {
  const accepted = Date.parse("2026-11-19T10:00:00Z");
  const state = { reminders: [], told: { limits: [{ key: "claude.seven_day.2026-11-20T00:00:00Z", at: accepted - 60_000, event_at: accepted - 60_000 },
    { key: "claude.five_hour.2026-11-19T15:00:00Z", at: accepted + 60_000, event_at: accepted + 60_000 },
    { key: "claude.five_hour.2026-11-19T20:00:00Z", at: accepted + 60_000 }], warned: [] }, sent: [], boundaries: { claude: "a#1", codex: "#0" },
    boundaries_version: 5, checked_at: null };
  const r = plain(lib.forgetSwitched(state, { claude: "2026-11-19T10:00:00.000Z#2", codex: "#0" }, 6));
  assert.deepEqual(r.switched, ["claude"]);
  assert.deepEqual(r.state.told.limits.map((x: any) => x.key), ["claude.five_hour.2026-11-19T15:00:00Z"], "the old account's cycle is forgotten, the new one's stays");
});

test("a run-out warning is not told when the shown limit no longer runs out", () => {
  const view = plain(lib.demoResult("normal", NOTE_NOW).view);
  const w = view.claude.windows.five_hour;
  assert.ok(!lib.projectionOf(lib.atDisplayTime(w, NOTE_NOW), NOTE_NOW)?.runsOut, "the demo's 5h limit lasts");
  const told = { limits: [], warned: [] };
  assert.deepEqual(titles(lib.selectAlerts([ev(1, "soon", { threshold: 30, eta_minutes: 30 })], view, NOTE_NOW, { told, times: false })), []);
  assert.equal(titles(lib.selectAlerts([ev(1, "soon", { threshold: 30, eta_minutes: 30 })], null, NOTE_NOW, { told, times: false })).length, 1, "without the view, the event's time decides");
});

test("the red dot stays while any overall limit of the provider is still at 100%", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  const p = { main_window_ids: ["five_hour", "seven_day"], windows: {
    five_hour: { used_percent: 100, resets_at: "2026-11-19T11:00:00Z" },
    seven_day: { used_percent: 100, resets_at: "2026-11-21T00:00:00Z" } } };
  assert.equal(lib.limitLifted(p, ["five_hour"], now), false, "the weekly limit (not listed) still blocks");
  p.windows.seven_day.used_percent = 80;
  assert.equal(lib.limitLifted(p, ["five_hour"], now), true);
});

test("a notifying run stops when the preferences change meanwhile, even back to the same values", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })])),
    onLoad: (k, url) => { if (url.includes("/v2/events")) k.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: true, times: true, rev: 2 })); } });
  assert.equal(run.shortcutOutput, "Settings changed");
  assert.equal(notifier.pending.size + notifier.delivered.size, 0, "what it scheduled is taken back");
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`));
});

test("a view older than the last run's changes no reminder", async () => {
  const files = new Map<string, string>([[`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [], view_version: 9 })]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 8 } }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier.pending.size, 0, "older than version 9: nothing scheduled");
  assert.equal(JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).view_version, 9, "the version doesn't go back");
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 10 } }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier.pending.size, 1, "a newer view schedules it");
});

test("settings saved or removed meanwhile by another run are neither overwritten nor removed", async () => {
  const other = JSON.stringify({ url: "https://other.example", token: "x", id: "2222222222222222" });
  const keychain = { [lib.KEYCHAIN_CONFIG]: JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" }) };
  // Server and token: another run saved new settings while the form was open
  const edit = await runWidget({ family: "medium", keychain, app: { menu: [3, 0], form: ["https://mine.example", "t2"] },
    beforeConfirm: (k: Map<string, string>) => { if (k.get(lib.KEYCHAIN_CONFIG) !== other) k.set(lib.KEYCHAIN_CONFIG, other); } } as any);
  assert.equal(edit.keychain.get(lib.KEYCHAIN_CONFIG), other);
  assert.ok(edit.alertTitles.includes("Not saved"));
  // Remove all settings: the same
  const removed = await runWidget({ family: "medium", keychain, app: { menu: [3, 2, 1] },
    beforeConfirm: (k: Map<string, string>) => { if (k.get(lib.KEYCHAIN_CONFIG) !== other) k.set(lib.KEYCHAIN_CONFIG, other); } } as any);
  assert.equal(removed.keychain.get(lib.KEYCHAIN_CONFIG), other);
  assert.ok(removed.alertTitles.includes("Not removed"));
});

test("the details page shows none of the old settings' values if they change while it loads", async () => {
  const run = await runWidget({ family: "medium", app: { menu: [0] },
    responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: { last_seq: 0, oldest_seq: null, events: [] } } : undefined),
    onLoadHTML: (k: Map<string, string>) => k.set(lib.KEYCHAIN_CONFIG, JSON.stringify({ url: "https://other.example", token: "x", id: "2222222222222222" })) } as any);
  assert.equal(run.webPages.length, 2);
  assert.ok(run.webPages[1]!.includes("Settings changed"));
  assert.ok(!run.webPages[1]!.includes("<em>Confidence</em>"), "no limits of the old settings");
});

test("a reminder of this generation on the device that the plan doesn't keep is cancelled", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const notifier = newNotifier();
  const stray = `headroom.${gen}.runout.claude.five_hour.29918280`;
  notifier.pending.set(stray, { id: stray });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("normal", NOTE_NOW) }, responder: eventsAt(feed(3, [])) });
  assert.ok(!notifier.pending.has(stray));
});

test("a state from before the view version was kept still refuses an older view", async () => {
  const files = new Map<string, string>([[`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [], boundaries: { claude: "#0", codex: "#0" }, boundaries_version: 9 })]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 8 } }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier.pending.size, 0);
  assert.equal(lib.readNotifyState(JSON.stringify({ boundaries_version: 9 })).view_version, 9);
});

test("a reminder cancelled by turning time reminders off is not taken for one that rang", () => {
  const offAt = NOTE_NOW.getTime() - 10 * 60_000;
  const r = { id: "headroom.0000000000000000.back.claude.all.1", kind: "back", provider: "claude", window_id: "five_hour", cycle: NOTE_NOW.getTime(),
    fire_at: NOTE_NOW.getTime() - 60_000, set_at: offAt - 3_600_000 };
  const prefs = { times_off_at: offAt, cancelled: [{ id: r.id, at: offAt }] };
  assert.deepEqual(plain(lib.withoutCancelled([r], prefs)), [], "removed by the menu: cancelled");
  assert.equal(lib.withoutCancelled([r], { times_off_at: offAt, cancelled: [] }).length, 1, "not removed (it rang, or couldn't be removed)");
  assert.equal(lib.withoutCancelled([{ ...r, set_at: offAt + 1 }], prefs).length, 1, "scheduled again after it was turned on");
  // Turned off, on and off again before a notifying run: both cancellations count, each against its own time
  const twice = { cancelled: [{ id: r.id, at: offAt }, { id: "headroom.0000000000000000.runout.codex.five_hour.2", at: offAt + 120_000 }] };
  assert.equal(lib.withoutCancelled([r, { ...r, id: "headroom.0000000000000000.runout.codex.five_hour.2", kind: "runout", set_at: offAt + 60_000 }], twice).length, 0);
  // The limit was told; its reset comes after the cancelled reminder's time: told
  const cycle = "2026-11-19T11:59:00.000Z";
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const reset = ev(9, "reset", { cycle, resets_at: cycle });
  const reminders = [{ ...r, cycle: Date.parse(cycle) }];
  assert.equal(titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders, times: false })).length, 0, "taken for one that rang");
  assert.equal(titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: lib.withoutCancelled(reminders, prefs), times: false })).length, 1);
});

test("a cycle told for the account before the switch doesn't hold back the new account's alerts", () => {
  const cycle = "2026-11-19T15:00:00.000Z";
  const since = { claude: Date.parse("2026-11-19T11:00:00Z"), codex: Number.NaN };
  // the old account's warning, made at 10:59 but read at 11:01 (after the switch)
  const old = { key: `claude.five_hour.${cycle}`, at: Date.parse("2026-11-19T11:01:00Z"), event_at: Date.parse("2026-11-19T10:59:00Z"), until: NOTE_NOW.getTime() + 86_400_000 };
  const warn = ev(5, "threshold", { threshold: 95 });
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [old] }, times: false })).length, 0, "without the switch time, taken as told");
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [old] }, times: false, since })).length, 1);
  const picked = lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [] }, times: false, since });
  assert.equal(picked.alerts[0].mark.event_at, Date.parse(warn.created_at), "the mark keeps the event's server time");
  // A switch seen late keeps what an event of the new account told, by the event's time (not the iPhone's)
  const state = { reminders: [], told: { limits: [], warned: [{ ...old, at: since.claude - 30_000, event_at: since.claude + 10_000 }] }, sent: [],
    boundaries: { claude: "a#1", codex: "#0" }, boundaries_version: 1, checked_at: null };
  const r = plain(lib.forgetSwitched(state, { claude: "2026-11-19T11:00:00.000Z#2", codex: "#0" }, 2));
  assert.equal(r.state.told.warned.length, 1);
});

test("the notification switches are shown again when another run changed them meanwhile; failures are told", async () => {
  // Notifications -> (another run turns limit alerts off) -> Time reminders
  const moved = await runWidget({ family: "medium", app: { menu: [2, 2] },
    onSheet: (k: Map<string, string>, n: number) => { if (n === 2) k.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: false, times: true, rev: 4 })); } } as any);
  assert.ok(moved.alertTitles.includes("Changed meanwhile"));
  assert.deepEqual(plain(lib.notifyPrefs(savedSwitches(moved.keychain))), { events: false, times: true, rev: 4, times_off_at: null, cancel_pending: false, cancelled: [], cancels: [] }, "not changed by the old menu");
  // Time reminders off while the pending list can't be read
  const failing = await runWidget({ family: "medium", app: { menu: [2, 2] }, pendingFails: true } as any);
  assert.ok(failing.alertTitles.includes("Partly changed"));
  const off = lib.notifyPrefs(savedSwitches(failing.keychain));
  assert.equal(off.times, false);
  assert.ok(Number.isFinite(off.times_off_at), "when they were turned off");
});

test("Remove all settings offers to try the Keychain again at once", async () => {
  // The first try fails, the second works
  let fails = 1;
  const notifier = newNotifier();
  const gen = lib.DEFAULT_CONFIG_ID;
  notifier.pending.set(`headroom.${gen}.back.claude.all.1`, { id: `headroom.${gen}.back.claude.all.1` });
  let pendingAtRetry = -1;
  const ok = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, notifier,
    keychainRemove: () => { if (fails-- > 0) throw new Error("keychain"); },
    // at the retry question (the first try has failed)
    beforeConfirm: () => { if (pendingAtRetry < 0 && fails <= 0) pendingAtRetry = notifier.pending.size; } } as any);
  assert.equal(ok.error, null);
  assert.ok(ok.alertTitles.includes("Not fully removed"), "offered to try again");
  assert.equal(pendingAtRetry, 0, "the reminders are gone before the question (closing the app there leaves none)");
  assert.ok(!ok.keychain.has(lib.KEYCHAIN_CONFIG) && !ok.keychain.has("headroom.url"), "removed on the second try");
});

test("a run that lost the lock leaves its reminders to the new owner even when a switch changed meanwhile", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(3, [])),
    onLoad: (k, url) => {
      if (!url.includes("/v2/events")) return;
      files.set(`/docs/headroom-lock-${TAG}`, `other ${NOTE_NOW.getTime() + 60_000}`);
      k.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: false, times: true, rev: 1 }));
    } });
  assert.equal(run.shortcutOutput, "Another run is notifying");
  assert.equal(notifier.pending.size, 1, "the reminder the new owner plans too stays");
});

test("turning time reminders off records which reminders it removed; one delivered meanwhile is not among them", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const notifier = newNotifier();
  const waiting = `headroom.${gen}.back.claude.all.29918280`;
  const rang = `headroom.${gen}.runout.codex.five_hour.29918280`;
  notifier.pending.set(waiting, { id: waiting });
  notifier.pending.set(rang, { id: rang });
  // the second one rings while the menu removes the first
  const run = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier,
    onAllPending: (_k: Map<string, string>, n: any) => { const x = n.pending.get(rang); n.pending.delete(rang); n.delivered.set(rang, x); } } as any);
  const prefs = lib.notifyPrefs(savedSwitches(run.keychain));
  assert.equal(prefs.times, false);
  assert.deepEqual(plain(prefs.cancelled.map((c: any) => c.id)), [waiting]);
  assert.equal(notifier.pending.size, 0);
});

test("a notification already on the device with the same words is not sent again (its state couldn't be saved last time)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const events = feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })]);
  // the first run tells it, but its state isn't saved
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1);
  files.delete(`/docs/headroom-notify-${TAG}.json`);
  files.delete(`/docs/headroom-events-${TAG}-5`);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1, "not told twice");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-5`), "and the cursor moves on");
});

test("the notifying run removes files of other settings, and told numbers the server no longer holds", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""], ["/docs/headroom-events-abcdef12-9", ""], ["/docs/headroom-notify-abcdef12.json", "{}"],
    ["/docs/headroom-view.json", "{}"], ["/docs/other-script.json", "{}"],
    [`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [], sent: [1, 2, 4, 7] })]]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, now: NOTE_NOW,
    responder: eventsAt({ ...feed(3, []), oldest_seq: 5 }) });
  assert.ok(!files.has("/docs/headroom-events-abcdef12-9") && !files.has("/docs/headroom-notify-abcdef12.json") && !files.has("/docs/headroom-view.json"));
  assert.ok(files.has("/docs/other-script.json"), "not Headroom's");
  assert.deepEqual(JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).sent, [7], "below the oldest held (5) can't come back");
  assert.deepEqual(plain(lib.orphanFiles([`headroom-lock-${TAG}`, "headroom-lock-abcdef12"], TAG)), ["headroom-lock-abcdef12"]);
});

test("events tell one account from the next by the boundary stamp they were judged under", () => {
  const old = "2026-11-18T00:00:00.000Z#1";
  const now = "2026-11-19T11:00:00.000Z#2";
  // the old account's limit and the new account's 95% (same reset time) in one batch: the warning is told
  const batch = [ev(4, "limit", { boundary: old }), ev(5, "threshold", { threshold: 95, boundary: now })];
  const picked = titles(lib.selectAlerts(batch, null, NOTE_NOW, { told: { limits: [], warned: [] }, times: false }));
  assert.equal(picked.length, 2, picked.join(" / "));
  // the same account: the limit takes the warning's place
  assert.equal(titles(lib.selectAlerts([ev(4, "limit", { boundary: now }), ev(5, "threshold", { threshold: 95, boundary: now })], null, NOTE_NOW,
    { told: { limits: [], warned: [] }, times: false })).length, 1);
  // a mark keeps the stamp of the event it told
  const told = lib.selectAlerts([ev(6, "threshold", { threshold: 95, boundary: now })], null, NOTE_NOW, { told: { limits: [], warned: [] }, times: false });
  assert.equal(told.alerts[0].mark.boundary, now);
  assert.equal(plain(lib.sanitizeEvents({ last_seq: 1, events: [{ ...ev(1, "limit"), boundary: "<x>#1" }] })).events[0].boundary, null, "only a stamp's shape");
});

test("Remove all keeps the notifications of settings saved while it lists them", async () => {
  const notifier = newNotifier();
  const old = lib.DEFAULT_CONFIG_ID;
  notifier.pending.set(`headroom.${old}.back.claude.all.1`, { id: `headroom.${old}.back.claude.all.1` });
  const newer = "2222222222222222";
  const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, notifier,
    onAllPending: (k: Map<string, string>, n: any) => {
      if (n.pending.has(`headroom.${newer}.back.codex.all.2`)) return;
      k.set(lib.KEYCHAIN_CONFIG, JSON.stringify({ url: "https://other.example", token: "x", id: newer }));
      n.pending.set(`headroom.${newer}.back.codex.all.2`, { id: `headroom.${newer}.back.codex.all.2` });
    } } as any);
  assert.equal(run.error, null);
  assert.ok(!notifier.pending.has(`headroom.${old}.back.claude.all.1`), "the removed settings' reminder goes");
  assert.ok(notifier.pending.has(`headroom.${newer}.back.codex.all.2`), "the new settings' reminder stays");
});

test("a run whose lock only expired takes it again to take back what the new switches don't want", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(3, [])),
    onLoad: (k, url) => {
      if (!url.includes("/v2/events")) return;
      files.set(`/docs/headroom-lock-${TAG}`, `other ${NOTE_NOW.getTime() - 1000}`);
      k.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: true, times: false, rev: 1 }));
    } });
  assert.equal(run.shortcutOutput, "Settings changed");
  assert.equal(notifier.pending.size, 0, "time reminders are off now: taken back");
});

test("a notification whose told record couldn't be saved is told again only when the device shows no trace of it and its run is gone", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const keychain = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  const events = feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })]);
  // handed to iOS, but its told record can't be saved afterwards (the intent was saved before)
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, keychain, now: NOTE_NOW, responder: eventsAt(events),
    writeFailsWhen: (p: string) => p.includes("headroom-told-") } as any);
  assert.equal(notifier.log.length, 1);
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`), "the cursor stays before it");
  // still on the device: not told again
  const later = new Date(NOTE_NOW.getTime() + 60_000);
  const files2 = new Map(files);
  const kept = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier, keychain, now: later, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1, "on the device: not told twice");
  assert.ok(String(kept.shortcutOutput).startsWith("No new alerts"), String(kept.shortcutOutput));
  // dismissed from the device meanwhile: while the run that handed it over may still be going, it waits; once that run is gone, nothing
  // tells it was told, so it is told again (a duplicate is allowed only here)
  notifier.delivered.clear();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, keychain, now: later, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1, "its run may still be going: held");
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`));
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, keychain, now: new Date(NOTE_NOW.getTime() + 5 * 60_000), responder: eventsAt(events) });
  assert.equal(notifier.log.length, 2, "told again");
  // the control: a told record that was saved says it was told, also once dismissed (no duplicate)
  const files3 = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier3 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files3, notifier: notifier3, keychain, now: NOTE_NOW, responder: eventsAt(events),
    writeFailsWhen: (p: string) => p.includes("headroom-notify-") } as any);
  notifier3.delivered.clear();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files3, notifier: notifier3, keychain, now: new Date(NOTE_NOW.getTime() + 5 * 60_000), responder: eventsAt(events) });
  assert.equal(notifier3.log.length, 1);
});

test("a notification another run already put on the device (by its event numbers) is not told again", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  notifier.delivered.set("x", { id: `headroom.${lib.DEFAULT_CONFIG_ID}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    responder: eventsAt(feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })])) });
  assert.equal(notifier.log.length, 0);
  assert.ok(files.has(`/docs/headroom-events-${TAG}-5`));
});

test("a reminder due now whose state couldn't be saved afterwards rings once", async () => {
  const files = new Map<string, string>();
  const notifier = newNotifier();
  const body = demoBody("runout", NOTE_NOW);
  let fails = 1;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body }, responder: eventsAt(feed(3, [])),
    writeFailsWhen: (p: string) => p.includes("headroom-notify-") && notifier.log.length > 0 && fails-- > 0 } as any);
  assert.ok(notifier.log.length >= 1);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: new Date(NOTE_NOW.getTime() + 60_000), response: { status: 200, body }, responder: eventsAt(feed(3, [])) });
  const ids = notifier.log.map((n: any) => n.id);
  assert.equal(new Set(ids).size, ids.length, `no reminder scheduled twice: ${ids.join(", ")}`);
});

test("told numbers below the server's oldest are dropped also when a later notification fails", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [], sent: [2, 3, 10] })]]);
  const notifier = newNotifier();
  const events = { last_seq: 12, oldest_seq: 9, events: [ev(11, "limit", { provider: "claude", window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" }),
    ev(12, "limit", { provider: "codex", window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })] };
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events), scheduleFailsAfter: 1 });
  const sent = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).sent;
  assert.ok(!sent.includes(2) && !sent.includes(3), JSON.stringify(sent));
  assert.ok(sent.includes(10));
});

test("files are told apart by their exact settings tag (one tag can start another)", () => {
  const short = lib.cacheTag({ id: lib.DEFAULT_CONFIG_ID }, "https://quota.example");
  const long = lib.cacheTag({ id: lib.DEFAULT_CONFIG_ID }, "https://quota.example:8443");
  assert.ok(long.startsWith(short));
  assert.equal(lib.fileTag(`headroom-notify-${long}.json`), long);
  assert.deepEqual(plain(lib.orphanFiles([`headroom-notify-${long}.json`, `headroom-events-${short}-4`, "headroom-view-12.json"], short)),
    [`headroom-notify-${long}.json`, "headroom-view-12.json"]);
});

test("the stamp from before any switch is a known stamp; the view counts only for events of its own account", () => {
  assert.equal(lib.sanitizeEvents({ last_seq: 1, events: [{ ...ev(1, "limit"), boundary: "" }] }).events[0].boundary, "");
  // the old account's limit (stamp "") and the new account's 95% (after the first switch)
  const batch = [ev(4, "limit", { boundary: "" }), ev(5, "threshold", { threshold: 95, boundary: "2026-11-19T11:00:00.000Z#1" })];
  assert.equal(titles(lib.selectAlerts(batch, null, NOTE_NOW, { told: { limits: [], warned: [] }, times: false })).length, 2);
  // a soon event of the new account with a view still of the old one: the view's forecast (it lasts) doesn't drop it
  const view = plain(lib.demoResult("normal", NOTE_NOW).view);
  view.boundaries = { claude: "", codex: "" };
  const soon = ev(6, "soon", { threshold: 30, eta_minutes: 30, boundary: "2026-11-19T11:00:00.000Z#1" });
  assert.equal(titles(lib.selectAlerts([soon], view, NOTE_NOW, { told: { limits: [], warned: [] }, times: false })).length, 1);
  assert.equal(titles(lib.selectAlerts([{ ...soon, boundary: "" }], view, NOTE_NOW, { told: { limits: [], warned: [] }, times: false })).length, 0, "same account: the view decides");
});

test("a mark of an earlier version (no stamp, no server time) doesn't hold back alerts after a switch", () => {
  const legacy = { key: "claude.five_hour.2026-11-19T15:00:00.000Z", at: NOTE_NOW.getTime() - 60_000, until: NOTE_NOW.getTime() + 86_400_000 };
  const since = { claude: Date.parse("2026-11-19T11:00:00Z") };
  const warn = ev(5, "threshold", { threshold: 95 });
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [legacy] }, times: false })).length, 0, "no switch: it counts");
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [legacy] }, times: false, since })).length, 1);
});

test("notification switches that can't be read are not taken for on", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, keychainGetFailsFor: lib.KEYCHAIN_NOTIFY,
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ times: false, events: false }) },
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(5, [ev(5, "limit")])) } as any);
  assert.equal(run.shortcutOutput, "Couldn't read the notification settings");
  assert.equal(notifier.log.length, 0);
});

test("Remove all retries only the values it found, and never keeps the settings it removes", async () => {
  const gen = "1111111111111111";
  const keychain = { [lib.KEYCHAIN_CONFIG]: JSON.stringify({ url: "https://headroom.example.com", token: "t", id: gen }) };
  const notifier = newNotifier();
  notifier.pending.set(`headroom.${gen}.back.claude.all.1`, { id: `headroom.${gen}.back.claude.all.1` });
  const other = JSON.stringify({ url: "https://other.example", token: "x", id: "2222222222222222" });
  let fails = 1;
  let questions = 0;
  const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain, notifier,
    keychainRemove: () => { if (fails-- > 0) throw new Error("keychain"); },
    // another run saves new settings while the retry question is open (the second question)
    beforeConfirm: (k: Map<string, string>) => { if (++questions === 2) saveAs(k, other); } } as any);
  assert.equal(run.error, null);
  assert.ok(!notifier.pending.has(`headroom.${gen}.back.claude.all.1`), "the removed settings' reminder goes although its item was still there");
  assert.equal(JSON.stringify(savedConfig(run.keychain)), other, "the settings saved meanwhile stay");
});

test("turning time reminders off waits for a notifying run's lock", async () => {
  const files = new Map<string, string>([[`/docs/headroom-lock-${TAG}`, `other ${Date.now() + 600_000}`]]);
  const run = await runWidget({ family: "medium", app: { menu: [2, 2] }, files });
  assert.ok(run.alertTitles.includes("Busy"));
  assert.equal(lib.notifyPrefs(savedSwitches(run.keychain))!.times, true, "unchanged");
});

test("a reminder still waiting on the device hasn't rung, whatever its time", () => {
  const gen = "0123456789abcdef";
  const t = NOTE_NOW.getTime();
  const r = { id: `headroom.${gen}.back.claude.all.1`, kind: "back", provider: "claude", window_id: "five_hour", cycle: t + 30_000, fire_at: t + 30_000 };
  const off = plain(lib.reconcileReminders([r], [], NOTE_NOW, gen, new Set([r.id]), null, true));
  assert.deepEqual(off.cancel, [r.id], "withdrawn 30 seconds before: cancelled");
  const kept = plain(lib.reconcileReminders([r], [], NOTE_NOW, gen, new Set([r.id])));
  assert.deepEqual([kept.cancel.length, kept.reminders.length], [0, 1], "no longer planned but due: kept, so its delivery is matched when its reset is told");
  const gone = plain(lib.reconcileReminders([r], [], NOTE_NOW, gen, new Set()));
  assert.deepEqual([gone.cancel.length, gone.reminders.length], [0, 1], "no longer waiting: it rang");
});

test("a run whose lock expired leaves what a run that held it meanwhile saved as its own", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(3, [])),
    onLoad: (k, url) => {
      if (!url.includes("/v2/events")) return;
      // B took the lock, kept the same reminder and finished; then the switches changed (limit alerts only)
      const id = [...notifier.pending.keys()][0]!;
      files.set(`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [{ id, kind: "back", provider: "claude", window_id: "five_hour", cycle: 1, fire_at: NOTE_NOW.getTime() + 3_600_000 }] }));
      files.delete(`/docs/headroom-lock-${TAG}`);
      k.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: false, times: true, rev: 1 }));
    } });
  assert.equal(notifier.pending.size, 1, "B's reminder stays");
});

test("Remove all removes nothing it can't tell apart when the Keychain can't be read", async () => {
  const gen = "1111111111111111";
  const keychain = { [lib.KEYCHAIN_CONFIG]: JSON.stringify({ url: "https://headroom.example.com", token: "t", id: gen }) };
  const notifier = newNotifier();
  const newer = "2222222222222222";
  notifier.pending.set(`headroom.${newer}.back.claude.all.1`, { id: `headroom.${newer}.back.claude.all.1` });
  // while the reminders are listed, another run saves new settings, and then the Keychain can't be read
  let failing = false;
  await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain, notifier,
    onAllPending: (k: Map<string, string>) => {
      k.set(lib.KEYCHAIN_CONFIG, JSON.stringify({ url: "https://other.example", token: "x", id: newer }));
      failing = true;
    },
    keychainGetFailsWhen: (k: string) => failing && k === lib.KEYCHAIN_CONFIG } as any);
  assert.ok(notifier.pending.has(`headroom.${newer}.back.claude.all.1`), "not removed on settings it couldn't read");
});

test("the wait after taking the lock is given to Scriptable's timer in milliseconds", async () => {
  const intervals: number[] = [];
  const timer = { schedule: (ms: number, _repeats: boolean, done: () => void) => { intervals.push(ms); done(); } };
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", now: NOTE_NOW, responder: eventsAt(feed(3, [])), globals: { Timer: timer } } as any);
  assert.deepEqual(intervals, [lib.LOCK_SETTLE_MS]);
  assert.equal(lib.LOCK_SETTLE_MS, 1500);
});

test("of two alerts, the one another run told just before is only remembered; the other is still told", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const gen = lib.DEFAULT_CONFIG_ID;
  const limit = ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" });
  const warn = ev(6, "threshold", { threshold: 80, window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(6, [limit, warn])),
    // another run tells 5 right before this one's notification
    onAllDelivered: (n: any, call: number) => {
      if (call === 2) n.delivered.set("other", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } });
    } } as any);
  assert.equal(notifier.log.length, 1, "6 is told");
  assert.ok(String(notifier.log[0].body).includes("left"), String(notifier.log[0].body));
  const state = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!);
  assert.ok(state.told.limits.some((m: any) => m.key.startsWith("claude.seven_day.")), "the limit 5 told is remembered");
});

test("when the device's list can't be read before a notification, nothing more is told and the cursor stays", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, deliveredFailsOnCall: 2,
    responder: eventsAt(feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })])) } as any);
  assert.equal(notifier.log.length, 0);
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`), "the cursor stays");
  assert.ok(String(run.shortcutOutput).startsWith("Couldn't check alerts"), String(run.shortcutOutput));
});

test("with time reminders off, one still waiting on the device is cancelled also when the view can't be read", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const id = `headroom.${gen}.back.claude.all.29918280`;
  notifier.pending.set(id, { id });
  const keychain = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ times: false }) };
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, keychain, now: NOTE_NOW,
    responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: feed(3, []) } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) });
  assert.equal(notifier.pending.size, 0);
  // and the reset of an alert isn't held back by a reminder still waiting
  const cycle = "2026-11-19T11:59:00.000Z";
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const waiting = [{ id, kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: NOTE_NOW.getTime() - 60_000 }];
  const reset = ev(9, "reset", { cycle, resets_at: cycle });
  assert.equal(titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: waiting, times: false, pending: new Set([id]) })).length, 1);
});

test("without a stamp on one side, accounts are told apart by the server's times", () => {
  // the view's account was accepted at 11:50; an event without a stamp made at 11:45 is the previous account's
  const view = plain(lib.demoResult("normal", NOTE_NOW).view);
  view.boundaries = { claude: "2026-11-19T11:50:00.000Z#1", codex: "" };
  const soon = ev(6, "soon", { threshold: 30, eta_minutes: 30, created_at: "2026-11-19T11:45:00.000Z" });
  assert.equal(titles(lib.selectAlerts([soon], view, new Date("2026-11-19T11:46:00Z"), { told: { limits: [], warned: [] }, times: false })).length, 1,
    "the new account's view (its forecast lasts) doesn't drop it");
  // the view hasn't seen a switch yet, but the event's stamp names one: a mark of an earlier version doesn't hold it back
  const legacy = { key: "claude.five_hour.2026-11-19T15:00:00.000Z", at: NOTE_NOW.getTime() - 60_000, until: NOTE_NOW.getTime() + 86_400_000 };
  const warn = ev(5, "threshold", { threshold: 95, boundary: "2026-11-19T11:00:00.000Z#1" });
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [legacy] }, times: false })).length, 1);
});

test("a corrupt notification setting stops the notifying run instead of turning both on", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: "{not json" },
    response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(5, [ev(5, "limit")])) });
  assert.equal(run.shortcutOutput, "Couldn't read the notification settings");
  assert.equal(notifier.log.length, 0);
});

test("the notification menu checks again once it holds the lock, and an item Remove all can't remove isn't counted as removed", async () => {
  // the lock is held at first; while the menu waits, another menu changes the switches and lets the lock go
  const files = new Map<string, string>([[`/docs/headroom-lock-${TAG}`, `other ${Date.now() + 600_000}`]]);
  let keychainRef: Map<string, string> | null = null;
  const timer = { schedule: (_ms: number, _r: boolean, done: () => void) => {
    files.delete(`/docs/headroom-lock-${TAG}`);
    keychainRef?.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: false, times: true, rev: 7 }));
    done();
  } };
  const run = await runWidget({ family: "medium", app: { menu: [2, 2] }, files, globals: { Timer: timer },
    onSheet: (k: Map<string, string>) => { keychainRef = k; } } as any);
  assert.ok(run.alertTitles.includes("Changed meanwhile"));
  assert.equal(lib.notifyPrefs(savedSwitches(run.keychain))!.rev, 7, "the other menu's change stays");
  // Remove all: the settings item can't be removed the first time
  let fails = 1;
  const removed = await runWidget({ family: "medium", app: { menu: [3, 2, 1] },
    keychain: { [lib.KEYCHAIN_CONFIG]: JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" }) },
    keychainRemove: (k: string) => { if (k === lib.KEYCHAIN_CONFIG && fails-- > 0) throw new Error("keychain"); } } as any);
  assert.ok(removed.alertTitles.includes("Not fully removed"), "offered to try again");
  assert.equal(savedConfig(removed.keychain), null, "removed on the retry");
});

// ---- Guarantees on the iPhone: withdrawn values and late responses
const emptyView = (dataVersion: number) => ({ view_version: 1, data_version: dataVersion, claude: null, codex: null, boundaries: { claude: "#0", codex: "#0" } });
const notifyWith = (files: Map<string, string>, notifier: Notifier, response: { status: number; body: unknown }) =>
  runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response, responder: eventsAt(feed(3, [])) });

test("a withdrawn value reaches the iPhone; a late old response or a failure after it plans nothing from the old value", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const withValues = { ...demoBody("reset", NOTE_NOW), data_version: 5 };
  await notifyWith(files, notifier, { status: 200, body: withValues });
  assert.equal(notifier.pending.size, 1, "the value plans a reset reminder");
  await notifyWith(files, notifier, { status: 200, body: emptyView(6) });
  assert.equal(notifier.pending.size, 0, "withdrawn: its reminder is cancelled");
  await notifyWith(files, notifier, { status: 200, body: withValues });
  assert.equal(notifier.pending.size, 0, "the late old response plans nothing");
  await notifyWith(files, notifier, { status: 503, body: {} });
  assert.equal(notifier.pending.size, 0, "nor does a failure after it");
});

test("a newer response with new boundaries, then a late older one: the newer boundaries stay", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const newer = { ...demoBody("normal", NOTE_NOW), data_version: 8, boundaries: { claude: "2026-11-19T11:00:00.000Z#1", codex: "#0" } };
  const older = { ...demoBody("normal", NOTE_NOW), data_version: 7, boundaries: { claude: "#0", codex: "#0" } };
  await notifyWith(files, notifier, { status: 200, body: newer });
  await notifyWith(files, notifier, { status: 200, body: older });
  const state = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!);
  assert.equal(state.boundaries.claude, "2026-11-19T11:00:00.000Z#1");
  assert.ok([...files.keys()].some((k) => k.includes(`headroom-view-${TAG}-8`)), "the newer view is the saved one");
});

test("an ordinary network failure keeps the previous value (shown as old) and its version", async () => {
  const files = new Map<string, string>();
  const ok = await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(5) } });
  assert.equal(ok.error, null);
  const failed = await runWidget({ family: "medium", files, response: { status: 503, body: {} } });
  assert.ok(texts(failed.widget.node).length > 1, "the previous value is still drawn");
  assert.ok([...files.keys()].some((k) => k.includes(`headroom-view-${TAG}-5`)), "and kept");
});

test("values after a withdrawal show; a late empty response doesn't take them away", async () => {
  const files = new Map<string, string>();
  await runWidget({ family: "medium", files, response: { status: 200, body: emptyView(6) } });
  await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(7) } });
  const late = await runWidget({ family: "medium", files, response: { status: 200, body: emptyView(6) } });
  assert.ok([...files.keys()].some((k) => k.includes(`headroom-view-${TAG}-7`)));
  assert.ok(texts(late.widget.node).some((x) => /%/.test(x)), "the values are drawn");
});

// ---- Guarantees for the settings and the notifications: each counterexample with its control
const CONFIG_A = JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" });
const CONFIG_B = JSON.stringify({ url: "https://headroom.example.com", token: "t2", id: "2222222222222222" });

test("new settings saved at any moment of Remove all (right before each item is removed, also on a retry) keep their settings and switches", async () => {
  const keyed = (k: Map<string, string>) => saveAs(k, CONFIG_A, JSON.stringify({ times: false }));
  // another run of the script under test saves B its own way (an earlier version wrote the single items)
  const saveB = (k: Map<string, string>) => {
    if (lib.KEYCHAIN_CURRENT) saveAs(k, CONFIG_B, JSON.stringify({ events: false }));
    else { k.set(lib.KEYCHAIN_CONFIG, CONFIG_B); k.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ events: false })); }
  };
  for (const start of ["this version", "an earlier version"]) {
    // the removing run reaches Keychain.remove for each of its items in turn; another run saves B right before the n-th
    for (let n = 1; n <= 6; n++) {
      const keychain = new Map<string, string>();
      if (start === "this version") keyed(keychain);
      else { keychain.set(lib.KEYCHAIN_CONFIG, CONFIG_A); keychain.set(lib.KEYCHAIN_NOTIFY, JSON.stringify({ times: false })); }
      let calls = 0;
      let fails = 1;
      const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain: Object.fromEntries(keychain),
        keychainRemove: (k: string) => {
          if (++calls === n) saveB(runKeychain!);
          // the first removal fails once: a retry goes over the items again
          if (fails-- > 0) throw new Error("keychain");
        },
        onKeychainContains: (k: Map<string, string>) => { runKeychain = k; } } as any);
      const label = `${start}, saved before removal ${n}`;
      if (calls < n) continue;
      assert.equal(JSON.stringify(savedConfig(run.keychain)), CONFIG_B, label);
      assert.equal(savedSwitches(run.keychain), JSON.stringify({ events: false }), `${label}: the new switches stay`);
      assert.ok(![...run.keychain.values()].includes(CONFIG_A), `${label}: nothing of A is left`);
    }
  }
});
let runKeychain: Map<string, string> | null = null;

test("a switches item that can't be removed leaves Remove all unfinished and asks to retry; quitting there, a new setup starts with its own switches", async () => {
  // can't be read: nothing needs reading to remove it (each generation's items are its own), so it goes
  const keychain = new Map<string, string>();
  saveAs(keychain, CONFIG_A, JSON.stringify({ times: false }));
  const unreadable = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain: Object.fromEntries(keychain),
    keychainGetFailsWhen: (k: string) => k.startsWith("headroom.notify.") } as any);
  assert.ok(!unreadable.alertTitles.includes("Not fully removed"));
  assert.ok(![...unreadable.keychain.keys()].some((k) => k.startsWith("headroom.notify.") || k.startsWith("headroom.config.")), "removed");
  // can't be removed: unfinished, and the retry clears it once the fault is gone
  let failing = true;
  let questions = 0;
  const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain: Object.fromEntries(keychain),
    keychainRemove: (k: string) => { if (failing && k.startsWith("headroom.notify.")) throw new Error("keychain"); },
    // the fault goes away when the retry is offered (the second question)
    beforeConfirm: () => { if (++questions === 2) failing = false; } } as any);
  assert.ok(run.alertTitles.includes("Not fully removed"));
  assert.equal(savedConfig(run.keychain), null);
  assert.ok(![...run.keychain.keys()].some((k) => k.startsWith("headroom.notify.")), "cleared on the retry");
  // quitting at the retry question: the old switches are left, but a new setup doesn't take them
  const quit = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain: Object.fromEntries(keychain), answers: [0, -1],
    keychainRemove: (k: string) => { if (k.startsWith("headroom.notify.")) throw new Error("keychain"); } } as any);
  assert.equal(savedConfig(quit.keychain), null);
  assert.ok(quit.keychain.has("headroom.notify.1111111111111111"), "left by the quit");
  const setup = await runWidget({ family: "medium", keychain: Object.fromEntries(quit.keychain), app: { menu: [], form: ["https://headroom.example.com", "t3"] } });
  assert.equal(savedConfig(setup.keychain).token, "t3");
  const fresh = lib.notifyPrefs(savedSwitches(setup.keychain))!;
  assert.deepEqual([fresh.events, fresh.times, fresh.cancels.length], [true, true, 0], "both on: nothing carried over from the removed settings");
  // control: editing the server or the token keeps the switches
  const edit = await runWidget({ family: "medium", keychain: Object.fromEntries(keychain), app: { menu: [3, 0], form: ["https://headroom.example.com", "t4"] } });
  const carried = JSON.parse(savedSwitches(edit.keychain)!);
  assert.deepEqual([carried.events, carried.times], [true, false]);
  assert.ok(carried.cancels.some((c: any) => c.gen === "1111111111111111"), "the replaced generation's reminders are owed a cancel");
});
let run0 = 0;

test("a stored switch value of the wrong shape stops the run; a re-read failing just before cancelling keeps the reminders", async () => {
  for (const stored of ["", "[]", JSON.stringify({ times: "false" })]) {
    assert.equal(lib.notifyPrefs(stored), null, JSON.stringify(stored));
    const notifier = newNotifier();
    const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", notifier, now: NOTE_NOW,
      keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: stored },
      response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(5, [ev(5, "limit")])) });
    assert.equal(run.shortcutOutput, "Couldn't read the notification settings", JSON.stringify(stored));
    assert.equal(notifier.log.length, 0);
  }
  // the controls: no item yet is both on; a saved false is off
  assert.equal(lib.notifyPrefs(null)!.times, true);
  assert.equal(lib.notifyPrefs(JSON.stringify({ times: false }))!.times, false);
  // the first read works, the re-read just before cancelling fails: the reminder stays
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  await notifyWith(files, notifier, { status: 200, body: demoBody("reset", NOTE_NOW) });
  assert.equal(notifier.pending.size, 1);
  let reads = 0;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ times: true }) },
    keychainGetFailsWhen: (k: string) => k === lib.KEYCHAIN_NOTIFY && ++reads >= 3,
    response: { status: 200, body: demoBody("normal", NOTE_NOW) }, responder: eventsAt(feed(3, [])) } as any);
  assert.equal(notifier.pending.size, 1, "not cancelled on a read that failed");
});

test("with nothing in the way, Remove all removes the settings, switches, saved data and notifications", async () => {
  const gen = "1111111111111111";
  const tag = lib.cacheTag({ id: gen }, "https://headroom.example.com");
  const notifier = newNotifier();
  notifier.pending.set(`headroom.${gen}.back.claude.all.1`, { id: `headroom.${gen}.back.claude.all.1` });
  notifier.delivered.set(`headroom.${gen}.events.5.claude`, { id: `headroom.${gen}.events.5.claude` });
  const files = new Map<string, string>([[`/docs/headroom-notify-${tag}.json`, "{}"], [`/docs/headroom-events-${tag}-5`, ""]]);
  const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, files, notifier,
    keychain: { [lib.KEYCHAIN_CONFIG]: CONFIG_A, [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ times: false }) } });
  assert.equal(run.keychain.size, 0);
  assert.equal(notifier.pending.size + notifier.delivered.size, 0);
  assert.ok(![...files.keys()].some((k) => k.includes(tag)));
});

test("turning time reminders off cancels at once; unconfirmed, it shows cancel pending until a notifying run confirms", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const id = `headroom.${gen}.back.claude.all.29918280`;
  // confirmed: nothing left on the device
  const ok = newNotifier();
  ok.pending.set(id, { id });
  const done = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier: ok });
  assert.equal(ok.pending.size, 0);
  assert.equal(lib.notifyPrefs(savedSwitches(done.keychain))!.cancel_pending, false);
  // the list can't be read: off, shown as cancel pending
  const bad = newNotifier();
  bad.pending.set(id, { id });
  const pendingRun = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier: bad, pendingFails: true } as any);
  const prefs = lib.notifyPrefs(savedSwitches(pendingRun.keychain))!;
  assert.equal(prefs.times, false);
  assert.equal(prefs.cancel_pending, true);
  // the next notifying run cancels it (with no view) and clears the note
  const after = await runWidget({ family: "medium", inApp: true, shortcut: "notify", notifier: bad, now: NOTE_NOW,
    keychain: Object.fromEntries(pendingRun.keychain), files: new Map([[`/docs/headroom-events-${TAG}-3`, ""]]),
    responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: feed(3, []) } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) });
  assert.equal(bad.pending.size, 0);
  assert.equal(lib.notifyPrefs(savedSwitches(after.keychain))!.cancel_pending, false);
});

test("a stopped already on the device and a resumed not yet: the resumed is told, then the cursor passes it", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  notifier.delivered.set("s", { id: `headroom.${gen}.events.5.all`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  const events = feed(6, [ev(5, "collection_stopped", { provider: null, window_id: null }), ev(6, "collection_resumed", { provider: null, window_id: null })]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1);
  assert.ok(String(notifier.log[0].body).includes("again"), String(notifier.log[0].body));
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`));
  // telling it fails: the cursor stays before 6
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier2 = newNotifier();
  notifier2.delivered.set("s", { id: `headroom.${gen}.events.5.all`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, responder: eventsAt(events), scheduleFails: true });
  assert.ok(!files2.has(`/docs/headroom-events-${TAG}-6`));
});

test("limits of two providers both on the device just before: none told again, both cycles remembered (also past their reset)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const claude = ev(4, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z", cycle: "2026-11-20T00:00:00Z" });
  const codex = ev(5, "limit", { provider: "codex", window_id: "seven_day", label: "Weekly", resets_at: "2026-11-21T00:00:00Z", cycle: "2026-11-21T00:00:00Z" });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(5, [claude, codex])),
    onAllDelivered: (n: any, call: number) => {
      if (call !== 2) return;
      n.delivered.set("a", { id: `headroom.${gen}.events.4.claude`, title: "t", body: "b", userInfo: { seqs: [4] } });
      n.delivered.set("b", { id: `headroom.${gen}.events.5.codex`, title: "t", body: "b", userInfo: { seqs: [5] } });
    } } as any);
  assert.equal(notifier.log.length, 0);
  const told = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).told.limits.map((m: any) => m.key);
  assert.ok(told.some((k: string) => k.startsWith("claude.seven_day")) && told.some((k: string) => k.startsWith("codex.seven_day")), told.join(", "));
  // one already on the device whose reset has passed is still remembered; one not on the device gets no mark
  const passed = { ...codex, resets_at: "2026-11-19T11:00:00Z", cycle: "2026-11-19T11:00:00Z" };
  assert.equal(lib.selectAlerts([passed], null, NOTE_NOW, { told: { limits: [], warned: [] }, times: true, delivered: new Set([5]) }).told.limits.length, 1);
  assert.equal(lib.selectAlerts([passed], null, NOTE_NOW, { told: { limits: [], warned: [] }, times: true }).told.limits.length, 0);
});

test("a reset whose reminder can't be checked is held; the next run tells it only if the reminder was cancelled before ringing", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const cycle = "2026-11-19T11:59:00.000Z";
  const id = `headroom.${gen}.back.claude.all.${Math.round(Date.parse(cycle) / 60000)}.0123abcd`;
  const state = { reminders: [{ id, kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: Date.parse(cycle), set_at: 1, confirmed: true }],
    told: { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] }, sent: [] };
  const reset = ev(5, "reset", { cycle, resets_at: cycle });
  const make = () => new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify(state)]]);
  const files = make();
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(5, [reset])), pendingFails: true } as any);
  assert.equal(notifier.log.length, 0);
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`), "held: the cursor waits before it");
  // the reminder rang (on the device): nothing more
  notifier.delivered.set("r", { id, title: "t", body: "b" });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(5, [reset])) });
  assert.equal(notifier.log.length, 0);
  // cancelled before it rang (recorded by the menu): the reset is told once
  const files2 = make();
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, responder: eventsAt(feed(5, [reset])),
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz",
      [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ times: true, cancelled: [{ id, at: 2 }] }) } });
  assert.equal(notifier2.log.length, 1);
});

test("an old view without a stamp, or an earlier switch's mark, doesn't hold back the new account's warning", () => {
  // 701: time reminders off; a view without stamps forecasts "lasts"; the new account's soon is told
  const view = plain(lib.demoResult("normal", NOTE_NOW).view);
  delete view.boundaries;
  const soon = ev(6, "soon", { threshold: 30, eta_minutes: 30, boundary: "2026-11-19T11:40:00.000Z#2" });
  assert.equal(titles(lib.selectAlerts([soon], view, NOTE_NOW, { told: { limits: [], warned: [] }, times: false })).length, 1);
  assert.equal(titles(lib.selectAlerts([{ ...soon, boundary: "" }], view, NOTE_NOW, { told: { limits: [], warned: [] }, times: false })).length, 0, "\"\" is the first account: the view counts");
  // 702: saved switch 11:00, a mark without a stamp at 11:30 (server time), the event's own switch 11:40, the new 95% at 11:45
  const since = { claude: Date.parse("2026-11-19T11:00:00Z") };
  const old = { key: "claude.five_hour.2026-11-19T15:00:00.000Z", at: 1, event_at: Date.parse("2026-11-19T11:30:00Z"), until: NOTE_NOW.getTime() + 86_400_000 };
  const warn = ev(7, "threshold", { threshold: 95, boundary: "2026-11-19T11:40:00.000Z#2", created_at: "2026-11-19T11:45:00.000Z" });
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [old] }, times: false, since })).length, 1);
  // the control: the same account's mark (after 11:40) holds it back
  const same = { ...old, event_at: Date.parse("2026-11-19T11:42:00Z") };
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [same] }, times: false, since })).length, 0);
});

test("an unshown stopped and resumed cancel out in either order; a single alert is told once over runs", async () => {
  const a = ev(5, "collection_stopped", { provider: null, window_id: null });
  const b = ev(6, "collection_resumed", { provider: null, window_id: null });
  assert.equal(titles(lib.selectAlerts([a, b], null, NOTE_NOW, {})).length, 0);
  assert.equal(titles(lib.selectAlerts([b, a], null, NOTE_NOW, {})).length, 0);
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  const events = feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1);
});

test("a reset reminder that couldn't be scheduled is made up by the event's reset; one that was delivered isn't", () => {
  const cycle = "2026-11-19T11:59:00.000Z";
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const reset = ev(9, "reset", { cycle, resets_at: cycle });
  // the reminder failed to schedule: no entry was kept
  assert.equal(titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: [], times: true, pending: new Set() })).length, 1);
  // the reminder rang (no longer waiting on the device): nothing more from the event
  const rang = [{ id: "headroom.0000000000000000.back.claude.all.1.0123abcd", kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: Date.parse(cycle), confirmed: true }];
  assert.equal(titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: rang, times: true, pending: new Set() })).length, 0);
});

test("a run whose lock expired after it scheduled keeps its reminder whichever read of the switches fails (the order)", async () => {
  const LEGACY = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ times: true }) };
  for (let k = 1; k <= 4; k++) {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
    const notifier = newNotifier();
    let expired = false;
    let reads = 0;
    await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, keychain: LEGACY,
      // right as its reminder is scheduled, the run's lock expires (nobody else holds it)
      onSchedule: () => { expired = true; files.set(`/docs/headroom-lock-${TAG}`, `other ${NOTE_NOW.getTime() - 1}`); },
      keychainGetFailsWhen: (key: string) => expired && key === lib.KEYCHAIN_NOTIFY && ++reads === k,
      response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(3, [])) } as any);
    assert.equal(notifier.pending.size, 1, `read ${k} after the lock expired failed: the reminder stays`);
  }
});

test("Off is saved together with cancel pending, and the menu shows it until confirmed (stopping right after turning off)", async () => {
  const id = `headroom.${lib.DEFAULT_CONFIG_ID}.back.claude.all.29918280`;
  const notifier = newNotifier();
  notifier.pending.set(id, { id });
  const writes: string[] = [];
  await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier,
    onKeychainSet: (k: string, v: string) => { if (k === lib.KEYCHAIN_NOTIFY) writes.push(v); } } as any);
  const first = lib.notifyPrefs(writes[0])!;
  assert.deepEqual([first.times, first.cancel_pending], [false, true], "the first write already says pending");
  const menuWith = (stored: string) => runWidget({ family: "medium", app: { menu: [2] },
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: stored } });
  // the app stopped right after that write: the menu says so
  const stopped = await menuWith(writes[0]!);
  assert.ok(stopped.actionLabels.includes("Time reminders: Off · cancel pending"), stopped.actionLabels.join(" | "));
  // control: confirmed, it is plain Off
  assert.equal(lib.notifyPrefs(writes[writes.length - 1])!.cancel_pending, false);
  const done = await menuWith(writes[writes.length - 1]!);
  assert.ok(done.actionLabels.includes("Time reminders: Off"), done.actionLabels.join(" | "));
});

test("an intent for 5 and 6 with only 5 on the device (told by another run) tells 6 again (per number)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const weekly = { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-21T00:00:00.000Z", cycle: "2026-11-21T00:00:00.000Z" };
  const events = feed(6, [ev(5, "limit"), ev(6, "threshold", { threshold: 80, ...weekly })]);
  const state = { reminders: [], told: { limits: [], warned: [] }, sent: [],
    sending: { id: `headroom.${gen}.events.5.claude`, seqs: [5, 6], marks: [{ list: "limits", key: "claude.five_hour.2026-11-19T15:00:00.000Z", at: 1, event_at: 1, until: NOTE_NOW.getTime() + 86_400_000, seq: 5 }] } };
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify(state)]]);
  const notifier = newNotifier();
  notifier.delivered.set("other", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1, "6 is told");
  assert.deepEqual(plain(notifier.log[0].userInfo.seqs), [6]);
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`));
  const saved = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!);
  assert.ok(saved.told.limits.some((m: any) => m.key === "claude.five_hour.2026-11-19T15:00:00.000Z" && m.seq === undefined), "5's cycle is remembered");
  // control: both on the device, nothing more
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify(state)]]);
  const notifier2 = newNotifier();
  notifier2.delivered.set("mine", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5, 6] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier2.log.length, 0);
});

test("a stopped another run tells while this one is about to tell a later limit: its resumed is told too (late evidence)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  const events = feed(7, [ev(5, "collection_stopped", { provider: null, window_id: null }), ev(6, "collection_resumed", { provider: null, window_id: null }),
    ev(7, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-21T00:00:00.000Z", cycle: "2026-11-21T00:00:00.000Z" })]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events),
    onAllDelivered: (n: any, call: number) => {
      if (call === 2) n.delivered.set("s", { id: `headroom.${gen}.events.5.all`, title: "t", body: "b", userInfo: { seqs: [5] } });
    } } as any);
  const told = notifier.log.flatMap((n: any) => plain(n.userInfo.seqs));
  assert.deepEqual(told.sort(), [6, 7], JSON.stringify(told));
  assert.ok(files.has(`/docs/headroom-events-${TAG}-7`));
  // control: neither on the device, the pair cancels out and only the limit is told; the cursor passes the pair
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, responder: eventsAt(events) });
  assert.deepEqual(notifier2.log.flatMap((n: any) => plain(n.userInfo.seqs)), [7]);
  assert.ok(files2.has(`/docs/headroom-events-${TAG}-7`));
});

test("limits shown by another run only at the re-read, one already past its reset: both cycles remembered (late evidence)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const claude = ev(4, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z", cycle: "2026-11-20T00:00:00Z" });
  const codex = ev(5, "limit", { provider: "codex", window_id: "seven_day", label: "Weekly", resets_at: "2026-11-19T11:00:00Z", cycle: "2026-11-19T11:00:00Z" });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(5, [claude, codex])),
    onAllDelivered: (n: any, call: number) => {
      if (call !== 2) return;
      n.delivered.set("a", { id: `headroom.${gen}.events.4.claude`, title: "t", body: "b", userInfo: { seqs: [4] } });
      n.delivered.set("b", { id: `headroom.${gen}.events.5.codex`, title: "t", body: "b", userInfo: { seqs: [5] } });
    } } as any);
  assert.equal(notifier.log.length, 0);
  const told = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).told.limits.map((m: any) => m.key);
  assert.ok(told.some((k: string) => k.startsWith("claude.seven_day")) && told.some((k: string) => k.startsWith("codex.seven_day")), told.join(", "));
});

test("a reset reminder saved but never known to be scheduled doesn't count as rung, unless the device shows it delivered (unconfirmed)", () => {
  const cycle = "2026-11-19T11:59:00.000Z";
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const reset = ev(9, "reset", { cycle, resets_at: cycle });
  const id = "headroom.0000000000000000.back.claude.all.1.0123456789abcdef.0a0a0a0a";
  const reminder = { id, kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: Date.parse(cycle) };
  const pick = (r: any, deliveredIds = new Set<string>()) => titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: [r], times: true, pending: new Set(), deliveredIds })).length;
  assert.equal(pick({ ...reminder, confirmed: false }), 1, "stopped before scheduling: the event tells it");
  assert.equal(pick({ ...reminder, confirmed: false }, new Set([id])), 0, "delivered after all");
  assert.equal(pick({ ...reminder, confirmed: true }), 0);
  assert.equal(pick(reminder), 1, "an earlier version's entry isn't known to be scheduled: the event tells it");
  // an identifier of an earlier version names no account: its delivery proves nothing for this one
  const legacy = { ...reminder, id: "headroom.0000000000000000.back.claude.all.1", confirmed: false };
  assert.equal(pick(legacy, new Set([legacy.id])), 1);
  // delivery wins over a pending list read before it
  assert.equal(titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: [{ ...reminder, confirmed: true }], times: true, pending: new Set([id]), deliveredIds: new Set([id]) })).length, 0);
});

test("a switch between an old mark and a new warning makes them different accounts, whichever switch it is (a later switch known)", () => {
  // a mark without a stamp at 11:30, the event's own switch 11:40, the warning 11:45, a later switch the device knows at 11:50
  const since = { claude: Date.parse("2026-11-19T11:50:00Z") };
  const old = { key: "claude.five_hour.2026-11-19T15:00:00.000Z", at: 1, event_at: Date.parse("2026-11-19T11:30:00Z"), until: NOTE_NOW.getTime() + 86_400_000 };
  const warn = ev(7, "threshold", { threshold: 95, boundary: "2026-11-19T11:40:00.000Z#2", created_at: "2026-11-19T11:45:00.000Z" });
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [old] }, times: false, since })).length, 1);
  // control: a mark after 11:40 (and before 11:50, like the warning) is the same account's
  const same = { ...old, event_at: Date.parse("2026-11-19T11:42:00Z") };
  assert.equal(titles(lib.selectAlerts([warn], null, NOTE_NOW, { told: { limits: [], warned: [same] }, times: false, since })).length, 0);
});

test("the reset reminder's scheduling fails, and the event's reset tells it; one that rang isn't told again (a real failure)", async () => {
  const cycle = "2026-11-19T14:00:00.000Z";
  const at = new Date("2026-11-19T14:01:00Z");
  const state = JSON.stringify({ reminders: [], told: { limits: [{ key: `codex.five_hour.${cycle}`, at: 1, event_at: NOTE_NOW.getTime() - 120_000, boundary: "#0", until: at.getTime() + 86_400_000 }], warned: [] }, sent: [] });
  const reset = ev(5, "reset", { provider: "codex", cycle, resets_at: cycle, boundary: "#0", created_at: "2026-11-19T14:00:30.000Z" });
  for (const fails of [true, false]) {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/headroom-notify-${TAG}.json`, state]]);
    const notifier = newNotifier();
    // the reminder for the codex 5h reset at 14:00 is scheduled now; it fails, or works
    const first = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
      response: { status: 200, body: demoBody("reset", NOTE_NOW) }, responder: eventsAt(feed(4, [])),
      onSchedule: (id: string) => { if (fails && id.includes(".back.")) throw new Error("failed"); } } as any);
    assert.equal(notifier.pending.size, fails ? 0 : 1, String(first.shortcutOutput));
    // it rang at 14:00 (iOS moves it to delivered)
    for (const [id, n] of notifier.pending) {
      notifier.delivered.set(id, n);
      notifier.pending.delete(id);
    }
    await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: at, response: null, responder: eventsAt(feed(5, [reset])) });
    const usable = notifier.log.filter((n: any) => n.trigger === null && String(n.body).includes("usable again"));
    assert.equal(usable.length, fails ? 1 : 0, fails ? "made up by the event" : "the reminder said it");
  }
});

test("a replacement publishes only what it replaces as read: a removal or a switch change meanwhile stops it; one after the check is carried over", async () => {
  const A = "1111111111111111";
  const start = () => {
    const k = new Map<string, string>();
    saveAs(k, CONFIG_A, JSON.stringify({ events: true, times: true, rev: 1 }));
    return Object.fromEntries(k);
  };
  // Remove all (another run) takes A away while Reset saved data reads it
  let removed = false;
  const gone = await runWidget({ family: "medium", app: { menu: [3, 2, 0] }, keychain: start(),
    onKeychainContains: (k: Map<string, string>, key: string) => {
      if (!removed && key === `headroom.notify.${A}`) {
        removed = true;
        k.delete(`headroom.config.${A}`);
        k.delete(`headroom.notify.${A}`);
      }
    } } as any);
  assert.equal(savedConfig(gone.keychain), null, "no new generation with the defaults");
  assert.ok(gone.alertTitles.includes("Not reset"));
  // time reminders turned off on A (another menu) after the switches were copied: not published
  let keychainRef: Map<string, string> | null = null;
  const changed = await runWidget({ family: "medium", app: { menu: [3, 2, 0] }, keychain: start(),
    onKeychainContains: (k: Map<string, string>) => { keychainRef = k; },
    onKeychainSet: (key: string) => {
      if (key.startsWith("headroom.notify.") && key !== `headroom.notify.${A}`) keychainRef!.set(`headroom.notify.${A}`, JSON.stringify({ events: true, times: false, rev: 2 }));
    } } as any);
  assert.equal(JSON.stringify(savedConfig(changed.keychain)), CONFIG_A, "A stays current");
  assert.equal(lib.notifyPrefs(savedSwitches(changed.keychain))!.times, false, "with the change");
  // turned off right after the check, before the new generation is named: carried over to it
  const late = await runWidget({ family: "medium", app: { menu: [3, 2, 0] }, keychain: start(),
    onKeychainContains: (k: Map<string, string>) => { keychainRef = k; },
    onKeychainSet: (key: string) => {
      if (key === lib.KEYCHAIN_CURRENT) keychainRef!.set(`headroom.notify.${A}`, JSON.stringify({ events: true, times: false, rev: 2 }));
    } } as any);
  assert.notEqual(currentId(late.keychain), A);
  assert.equal(lib.notifyPrefs(savedSwitches(late.keychain))!.times, false, "the change carried over");
  // the control: a plain reset keeps the switches
  const plainReset = await runWidget({ family: "medium", app: { menu: [3, 2, 0] }, keychain: start() });
  assert.notEqual(currentId(plainReset.keychain), A);
  assert.equal(lib.notifyPrefs(savedSwitches(plainReset.keychain))!.times, true);
});

test("a cancel owed when time reminders were turned off follows each replacement, and goes only once nothing of it waits", async () => {
  const A = "1111111111111111";
  const id = `headroom.${A}.back.claude.all.29918280.0123abcd`;
  const k = new Map<string, string>();
  saveAs(k, CONFIG_A, JSON.stringify({ events: true, times: false, rev: 1, cancel_pending: true, cancels: [{ op: "0a0a0a0a", gen: A, before: NOTE_NOW.getTime() }] }));
  const notifier = newNotifier();
  notifier.pending.set(id, { id });
  // replaced twice while the list of pending reminders can't be read (A to B, B to C)
  let keychain = Object.fromEntries(k);
  for (let i = 0; i < 2; i++) {
    const reset = await runWidget({ family: "medium", app: { menu: [3, 2, 0] }, keychain, notifier, pendingFails: true } as any);
    keychain = Object.fromEntries(reset.keychain);
  }
  const menu = await runWidget({ family: "medium", app: { menu: [2] }, keychain, notifier });
  assert.ok(menu.actionLabels.includes("Time reminders: Off · cancel pending"), menu.actionLabels.join(" | "));
  assert.equal(notifier.pending.size, 1, "still waiting");
  // a notifying run of C that can read the list cancels it; what is owed for A is settled only once A's runs can't hand anything more
  // to iOS (its lock's time after the cancel was owed)
  const notify = (now: Date, kc: Record<string, string>) => runWidget({ family: "medium", inApp: true, shortcut: "notify", keychain: kc, notifier, now,
    responder: (url: string) => (url.includes("/v2/view") ? { status: 503, body: {} } : undefined) } as any);
  const early = await notify(new Date(NOTE_NOW.getTime() + 30_000), keychain);
  assert.equal(notifier.pending.size, 0);
  assert.equal(lib.notifyPrefs(savedSwitches(early.keychain))!.cancel_pending, true, "A's runs may still be going");
  const run = await notify(new Date(NOTE_NOW.getTime() + 3 * 60_000), Object.fromEntries(early.keychain));
  const after = await runWidget({ family: "medium", app: { menu: [2] }, keychain: Object.fromEntries(run.keychain), notifier });
  assert.ok(after.actionLabels.includes("Time reminders: Off"), after.actionLabels.join(" | "));
});

// ---- Records of the notifying runs (a file per operation)
const stoppedEv = (n: number) => ev(n, "collection_stopped", { provider: null, window_id: null });
const resumedEv = (n: number) => ev(n, "collection_resumed", { provider: null, window_id: null });

test("a stopped another run is handing to iOS is neither cancelled out nor passed; once it is delivered, its resumed is told", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""],
    [`/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`, JSON.stringify({ seqs: [5], at: NOTE_NOW.getTime() - 30_000 })]]);
  const notifier = newNotifier();
  const events = feed(6, [stoppedEv(5), resumedEv(6)]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 0, "neither told nor cancelled out");
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`) && !files.has(`/docs/headroom-events-${TAG}-6`), "the cursor stays before 5");
  // the other run's stopped arrives: the resumed is told
  notifier.delivered.set("s", { id: `headroom.${gen}.events.5.all`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.deepEqual(notifier.log.flatMap((n: any) => plain(n.userInfo.seqs)), [6]);
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`));
  // the other order: a pair another run is cancelling out was recorded first; this run's intent for the stopped is dropped before iOS
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""],
    [`/docs/${lib.recordName("pair", TAG, 5, 6, "bbbbbbbb")}`, JSON.stringify({ at: NOTE_NOW.getTime() })]]);
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, responder: eventsAt(feed(5, [stoppedEv(5)])) });
  assert.equal(notifier2.log.length, 0, "not handed to iOS");
  assert.ok([...files2.keys()].some((k) => k.includes("headroom-abort-")), "dropped, and recorded so");
  // the control: neither on its way, both settle without a notification and the cursor passes them
  const files3 = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier3 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files3, notifier: notifier3, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier3.log.length, 0);
  assert.ok(files3.has(`/docs/headroom-events-${TAG}-6`));
});

test("the told records outlive a cursor that couldn't be written and a slower run's older state: nothing told twice, both cycles kept", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const limits = feed(5, [ev(4, "limit", { provider: "codex", window_id: "five_hour", cycle: "2026-11-19T14:00:00.000Z", resets_at: "2026-11-19T14:00:00.000Z" }),
    ev(5, "limit", { window_id: "five_hour" })]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(limits),
    writeFailsWhen: (p: string) => p.includes("headroom-events-") } as any);
  assert.equal(notifier.log.length, 2);
  // a slower run writes back the state from before (no told numbers, no cycles)
  files.set(`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [], told: { limits: [], warned: [] }, sent: [] }));
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(limits) });
  assert.equal(notifier.log.length, 2, "not told twice");
  // both resets come: each cycle is still known, so each is told
  const resets = feed(7, [...limits.events, ev(6, "reset", { provider: "codex", window_id: "five_hour", cycle: "2026-11-19T14:00:00.000Z", resets_at: "2026-11-19T14:00:00.000Z" }),
    ev(7, "reset", { window_id: "five_hour" })]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(resets) });
  assert.equal(notifier.log.filter((n: any) => String(n.body).includes("usable again")).length, 2);
});

test("version 64's notification about to be told (5 and 6), with only 5 on the device: 5's cycle is kept, 6 and the reset 7 are told", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const weekly = { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-21T00:00:00.000Z", cycle: "2026-11-21T00:00:00.000Z" };
  const state = { reminders: [], told: { limits: [], warned: [] }, sent: [],
    sending: { id: `headroom.${gen}.events.5.claude`, seqs: [5, 6], marks: [{ list: "limits", key: "claude.five_hour.2026-11-19T15:00:00.000Z", at: 1, event_at: 1, until: NOTE_NOW.getTime() + 86_400_000 }] } };
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify(state)]]);
  const notifier = newNotifier();
  notifier.delivered.set("five", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  const events = feed(7, [ev(5, "limit"), ev(6, "threshold", { threshold: 80, ...weekly }), ev(7, "reset")]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  const told = notifier.log.flatMap((n: any) => plain(n.userInfo.seqs)).sort();
  assert.deepEqual(told, [6, 7]);
});

// ---- Newer saved views and withdrawals on the iPhone
const saveViewFile = (files: Map<string, string>, body: unknown) => {
  const v = (body as { data_version: number }).data_version;
  files.set(`/docs/${lib.cacheFileName(TAG, v)}`, JSON.stringify({ origin: "https://headroom.example.com", view: body }));
  files.set(`/docs/headroom-seen-${TAG}-${v}`, "");
};

test("a widget saved a newer view with new boundaries; the notifying run that read an older one takes the newer (the iPhone)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const older = { ...demoBody("reset", NOTE_NOW), data_version: 7, boundaries: { claude: "#0", codex: "#0" } };
  await notifyWith(files, notifier, { status: 200, body: older });
  const newer = { ...demoBody("reset", NOTE_NOW), data_version: 8, boundaries: { claude: "2026-11-19T11:00:00.000Z#1", codex: "#0" } };
  // the notifying run gets the older response; a widget that only shows saves the newer one while it waits for the lock
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body: older },
    responder: eventsAt(feed(3, [])),
    onWrite: (p: string) => { if (p.includes("headroom-lock-") && !files.has(`/docs/headroom-seen-${TAG}-8`)) saveViewFile(files, newer); } } as any);
  const state = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!);
  assert.equal(state.boundaries.claude, "2026-11-19T11:00:00.000Z#1");
  assert.equal(state.view_version, 8);
});

test("a withdrawal saved by another widget while the notifying run waited plans nothing from the older value", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } },
    responder: eventsAt(feed(3, [])),
    onWrite: (p: string) => { if (p.includes("headroom-lock-") && !files.has(`/docs/headroom-seen-${TAG}-6`)) saveViewFile(files, emptyView(6)); } } as any);
  assert.equal(notifier.pending.size, 0);
});

test("when the saved files can't be listed, a late older response is neither shown nor saved", async () => {
  const files = new Map<string, string>();
  await runWidget({ family: "medium", files, response: { status: 200, body: emptyView(6) } });
  const late = await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(5) }, listFails: true });
  assert.ok(![...files.keys()].some((k) => k.includes(`headroom-view-${TAG}-5`)), "not saved");
  assert.ok(!texts(late.widget.node).some((x) => /%/.test(x)), "the older values aren't drawn");
});

// ---- The device's floor and its withdrawals (the newest version seen here)
const withdrawnMarker = (files: Map<string, string>, v: number) => files.set(`/docs/headroom-seen-${TAG}-${v}`, "withdrawn");

test("a withdrawal recorded in its seen marker holds without its body: no older value shown, saved or planned from", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  saveViewFile(files, { ...demoBody("reset", NOTE_NOW), data_version: 5 });
  // the empty 6 was received (its marker says so) but its body couldn't be kept
  withdrawnMarker(files, 6);
  const late = await runWidget({ family: "medium", files, response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } } });
  assert.ok(!texts(late.widget.node).some((x) => /%/.test(x)), "the late 5 isn't drawn");
  const offline = await runWidget({ family: "medium", files, response: null });
  assert.ok(!texts(offline.widget.node).some((x) => /%/.test(x)), "nor the saved 5 when the server can't be reached");
  // the notifying run reads 5 late: plans nothing from it, and cancels what was planned before
  const notifier = newNotifier();
  const id = `headroom.${lib.DEFAULT_CONFIG_ID}.back.codex.all.29918280.07c87886`;
  notifier.pending.set(id, { id });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier.pending.size, 0);
  // the control: a marker that isn't a withdrawal, with its body unreadable, plans nothing but shows no older value either
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  saveViewFile(files2, { ...demoBody("reset", NOTE_NOW), data_version: 5 });
  files2.set(`/docs/headroom-seen-${TAG}-6`, "");
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier2.log.length, 0, "held");
});

test("a withdrawal seen before a reminder is handed to iOS stops it; one landing after it is cancelled by the next run", async () => {
  const body = { ...demoBody("reset", NOTE_NOW), data_version: 5 };
  // seen before: no schedule call at all
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  let listed = 0;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body },
    responder: eventsAt(feed(3, [])),
    onAllPending: () => { if (++listed === 1) withdrawnMarker(files, 6); } } as any);
  assert.equal(notifier.log.length, 0, "nothing scheduled from 5");
  // landing right after iOS took it: the next run (with the empty 6) cancels it
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, response: { status: 200, body },
    responder: eventsAt(feed(3, [])), onSchedule: () => withdrawnMarker(files2, 6) } as any);
  assert.equal(notifier2.pending.size, 1);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, response: { status: 200, body: emptyView(6) },
    responder: eventsAt(feed(3, [])) });
  assert.equal(notifier2.pending.size, 0);
  // the control: nothing newer, one reminder
  const files3 = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier3 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files3, notifier: notifier3, now: NOTE_NOW, response: { status: 200, body },
    responder: eventsAt(feed(3, [])) });
  assert.equal(notifier3.pending.size, 1);
});

test("a run with an older view never cancels a reminder planned from a newer one", () => {
  const gen = "0123456789abcdef";
  const t = NOTE_NOW.getTime();
  const newer = { id: `headroom.${gen}.back.codex.all.1.0123abcd`, kind: "back", provider: "codex", window_id: "five_hour", cycle: t + 3_600_000, fire_at: t + 3_600_000, from: 8 };
  const slow = plain(lib.reconcileReminders([newer], [], NOTE_NOW, gen, new Set([newer.id]), 7));
  assert.deepEqual(slow.cancel, [], "planned from 8, not 7's to cancel");
  const current = plain(lib.reconcileReminders([newer], [], NOTE_NOW, gen, new Set([newer.id]), 9));
  assert.deepEqual(current.cancel, [newer.id], "the control: a newer view cancels what it doesn't plan");
});

test("two accounts' reset reminders of the same minute have their own identifiers; one's delivery never stands for the other's", () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const cycle = "2026-11-19T11:59:00.000Z";
  const item = (boundary: string | null) => ({ kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: Date.parse(cycle), boundary });
  const a = lib.reminderId(gen, item("2026-11-19T10:00:00.000Z#1"));
  const b = lib.reminderId(gen, item("2026-11-19T12:00:00.000Z#2"));
  assert.notEqual(a, b);
  assert.notEqual(lib.reminderId(gen, item("")), lib.reminderId(gen, item(null)), "the first account's stamp is a mark of its own");
  // B's reminder was saved, never known to be scheduled; A's is delivered: B's recovery is told
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, boundary: "2026-11-19T12:00:00.000Z#2", until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const reset = ev(9, "reset", { cycle, resets_at: cycle, boundary: "2026-11-19T12:00:00.000Z#2" });
  const reminders = [{ id: b, ...item("2026-11-19T12:00:00.000Z#2"), confirmed: false }];
  const pick = (delivered: string[]) => titles(lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders, times: true, pending: new Set(), deliveredIds: new Set(delivered) })).length;
  assert.equal(pick([a]), 1);
  assert.equal(pick([b]), 0, "the control: its own delivery");
});

// ---- Settings that can't be read, and items shared with earlier versions
test("the settings form changes nothing when the saved settings can't be read, when it opens or when it saves", async () => {
  const keychain = new Map<string, string>();
  saveAs(keychain, CONFIG_A, JSON.stringify({ events: true, times: true }));
  // from the Settings menu on, the item naming the settings can't be read
  let failing = false;
  const open = await runWidget({ family: "medium", keychain: Object.fromEntries(keychain), app: { menu: [3, 0], form: ["https://mine.example", "t2"] },
    onSheet: (_k: Map<string, string>, n: number) => { if (n === 2) failing = true; },
    keychainGetFailsWhen: (k: string) => failing && k === lib.KEYCHAIN_CURRENT } as any);
  assert.ok(open.alertTitles.includes("Can't read"), open.alertTitles.join(" | "));
  assert.equal(savedConfig(open.keychain).token, "t", "kept");
  // the read at saving fails (after the form was filled)
  let failing2 = false;
  const save = await runWidget({ family: "medium", keychain: Object.fromEntries(keychain), app: { menu: [3, 0], form: ["https://mine.example", "t2"] },
    beforeConfirm: () => { failing2 = true; },
    keychainGetFailsWhen: (k: string) => failing2 && k === lib.KEYCHAIN_CURRENT } as any);
  assert.ok(save.alertTitles.includes("Can't read"), save.alertTitles.join(" | "));
  failing2 = false;
  assert.equal(savedConfig(save.keychain).token, "t", "kept");
  // the control: readable, it saves
  const ok = await runWidget({ family: "medium", keychain: Object.fromEntries(keychain), app: { menu: [3, 0], form: ["https://mine.example", "t2"] } });
  assert.equal(savedConfig(ok.keychain).token, "t2", ok.alertTitles.join(" | "));
});

test("Remove all reads an item shared with earlier versions before removing it; one it can't read stays and it asks to retry (shared items)", async () => {
  const keychain = { [lib.KEYCHAIN_CONFIG]: CONFIG_A, [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ events: true, times: false }) };
  // the shared switches can't be read once Remove all is confirmed; the fault goes when the retry is offered
  let questions = 0;
  let failing = false;
  const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain,
    beforeConfirm: () => { questions++; failing = questions === 1; },
    keychainGetFailsWhen: (k: string) => failing && k === lib.KEYCHAIN_NOTIFY } as any);
  assert.ok(run.alertTitles.includes("Not fully removed"), run.alertTitles.join(" | "));
  assert.ok(!run.keychain.has(lib.KEYCHAIN_NOTIFY), "removed on the retry, once read");
  // quitting at the retry: the item it couldn't read stays
  const quit = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain, answers: [0, -1],
    beforeConfirm: () => { failing = true; },
    keychainGetFailsWhen: (k: string) => failing && k === lib.KEYCHAIN_NOTIFY } as any);
  assert.ok(quit.keychain.has(lib.KEYCHAIN_NOTIFY), "not removed unread");
});

// ---- Turning time reminders off and on again
test("turning time reminders on again keeps the cancel still owed; the next notifying run cancels the old reminder (on again)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const old = `headroom.${gen}.back.claude.five_hour.29918280.0123456789abcdef.0a0a0a0a`;
  const notifier = newNotifier();
  notifier.pending.set(old, { id: old });
  // off while the device's list can't be read: owed
  const off = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier, now: NOTE_NOW, pendingFails: true } as any);
  assert.equal(lib.notifyPrefs(savedSwitches(off.keychain))!.cancels.length, 1);
  // on again before any notifying run
  const on = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier, now: NOTE_NOW, keychain: Object.fromEntries(off.keychain) });
  const prefs = lib.notifyPrefs(savedSwitches(on.keychain))!;
  assert.deepEqual([prefs.times, prefs.cancels.length], [true, 1], "on, and still owed");
  // the next notifying run cancels it and settles what was owed
  const run = await runWidget({ family: "medium", inApp: true, shortcut: "notify", notifier, now: new Date(NOTE_NOW.getTime() + 60_000),
    keychain: Object.fromEntries(on.keychain), files: new Map([[`/docs/headroom-events-${TAG}-3`, ""]]),
    responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: feed(3, []) } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) });
  assert.ok(!notifier.pending.has(old), "the old reminder is cancelled");
  assert.equal(lib.notifyPrefs(savedSwitches(run.keychain))!.cancels.length, 0, "settled");
});

test("turning off isn't confirmed while a reminder saved as about to be scheduled may still reach iOS (on its way)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const t = NOTE_NOW.getTime() + 3_600_000;
  const id = `headroom.${gen}.back.claude.five_hour.${Math.round(t / 60_000)}.0123456789abcdef.0a0a0a0a`;
  const state = (confirmed: boolean) => JSON.stringify({ reminders: [{ id, kind: "back", provider: "claude", window_id: "five_hour", cycle: t, fire_at: t, confirmed }],
    told: { limits: [], warned: [] }, sent: [] });
  const files = new Map([[`/docs/headroom-notify-${TAG}.json`, state(false)]]);
  const off = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier: newNotifier(), files, now: NOTE_NOW });
  assert.equal(lib.notifyPrefs(savedSwitches(off.keychain))!.cancel_pending, true, "not on the device yet, but it may land");
  // the control: one known scheduled and no longer waiting (it rang or was cancelled) doesn't hold it
  const files2 = new Map([[`/docs/headroom-notify-${TAG}.json`, state(true)]]);
  const off2 = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier: newNotifier(), files: files2, now: NOTE_NOW });
  assert.equal(lib.notifyPrefs(savedSwitches(off2.keychain))!.cancel_pending, false);
});

// ---- Reminders being cancelled, and deliveries of the same identifier under another stamp
test("a reminder saved as being cancelled doesn't count as rung unless the device shows it delivered; a delivery counts only with its own stamp", () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const cycle = "2026-11-19T11:59:00.000Z";
  const stamp = "2026-11-19T10:00:00.000Z#1";
  const item = { kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: Date.parse(cycle), boundary: stamp };
  const id = lib.reminderId(gen, item);
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, boundary: stamp, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const reset = ev(9, "reset", { cycle, resets_at: cycle, boundary: stamp });
  const pick = (r: any, delivered: Map<string, string | null>) => titles(lib.selectAlerts([reset], null, NOTE_NOW,
    { told, reminders: [r], times: true, pending: new Set(), deliveredIds: new Set(delivered.keys()), deliveredStamps: delivered })).length;
  // removed from the device, then the run stopped: it never rang, so the reset is told
  assert.equal(pick({ id, ...item, confirmed: true, cancelling: true }, new Map()), 1);
  // it rang before it was removed (delivered, with its stamp): not told again
  assert.equal(pick({ id, ...item, confirmed: true, cancelling: true }, new Map([[id, stamp]])), 0);
  // the control: known scheduled, no longer waiting, not being cancelled: it rang
  assert.equal(pick({ id, ...item, confirmed: true }, new Map()), 0);
  // the same identifier delivered under another account's stamp proves nothing for this one
  assert.equal(pick({ id, ...item, confirmed: false }, new Map([[id, "2026-11-19T12:00:00.000Z#2"]])), 1);
  assert.equal(pick({ id, ...item, confirmed: false }, new Map([[id, stamp]])), 0, "under its own stamp, it rang");
});

// ---- The seen marker and the list of files on the iPhone
test("a view whose seen marker can't be saved is shown, but neither saved nor planned from (the marker)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const run = await runWidget({ family: "medium", parameter: "notify", files, notifier, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } }, responder: eventsAt(feed(3, [])),
    writeFailsWhen: (p: string) => p.includes("headroom-seen-") } as any);
  assert.ok(texts(run.widget.node).some((x) => /%/.test(x)), "shown");
  assert.ok(![...files.keys()].some((k) => k.includes(`headroom-view-${TAG}-5`)), "not saved");
  assert.equal(notifier.log.length, 0, "nothing scheduled");
  // the control: received, its reset reminder is scheduled
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", parameter: "notify", files: files2, notifier: notifier2, now: NOTE_NOW,
    response: { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } }, responder: eventsAt(feed(3, [])) });
  assert.equal(notifier2.pending.size, 1);
});

test("when the files can't be listed after the response is saved, a withdrawal saved meanwhile isn't hidden by older values (the list)", async () => {
  const files = new Map<string, string>();
  // another run saves the empty 6 while this one saves 5; then the list fails
  let failing = false;
  const run = await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(5) },
    onWrite: (p: string) => { if (p.includes(`headroom-view-${TAG}-5`) && !failing) { withdrawnMarker(files, 6); failing = true; } },
    listFailsWhen: () => failing } as any);
  assert.ok(!texts(run.widget.node).some((x) => /%/.test(x)), "the older values aren't drawn");
  // the list works: the withdrawal is shown
  const run2 = await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(5) } });
  assert.ok(!texts(run2.widget.node).some((x) => /%/.test(x)));
});

test("a withdrawal whose marker lands while the notifying run waits for the lock cancels what was planned (no response)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  await notifyWith(files, notifier, { status: 200, body: { ...demoBody("reset", NOTE_NOW), data_version: 5 } });
  assert.equal(notifier.pending.size, 1);
  // no view at all this time: the saved body is gone (only its marker is left)
  files.delete(`/docs/${lib.cacheFileName(TAG, 5)}`);
  // the server can't be reached; another widget records the withdrawal 6 (its marker only) while this run waits for the lock
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 503, body: {} },
    responder: eventsAt(feed(3, [])),
    onWrite: (p: string) => { if (p.includes("headroom-lock-") && !files.has(`/docs/headroom-seen-${TAG}-6`)) withdrawnMarker(files, 6); } } as any);
  assert.equal(notifier.pending.size, 0, "cancelled");
});

// ---- Records of the notifying runs: pairs, intents and told records
test("a stopped and resumed that cancel out are settled by one record, or neither when it can't be written (one record)", async () => {
  const events = feed(6, [stoppedEv(5), resumedEv(6)]);
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events),
    writeFailsWhen: (p: string) => p.includes("headroom-told-") } as any);
  assert.equal(notifier.log.length, 0);
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`) && !files.has(`/docs/headroom-events-${TAG}-6`), "neither settled: the cursor stays before 5");
  // settled, but the cursor can't be written: the one record names both (read back, both are settled)
  const later = new Date(NOTE_NOW.getTime() + 5 * 60_000);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: later, responder: eventsAt(events),
    writeFailsWhen: (p: string) => p.includes("headroom-events-") } as any);
  const told5 = JSON.parse(files.get(`/docs/${lib.recordName("told", TAG, 5)}`) ?? "null");
  assert.equal(told5?.pair, 6);
  assert.ok(!files.has(`/docs/${lib.recordName("told", TAG, 6)}`));
  const fm = { documentsDirectory: () => "/docs", joinPath: (a: string, b: string) => `${a}/${b}`, readString: (p: string) => files.get(p) };
  const records = lib.readRecords(fm, [lib.recordName("told", TAG, 5)], TAG);
  assert.deepEqual([...records.told.keys()].sort(), [5, 6]);
  // the next run tells neither and passes both
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: later, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 0, "the resumed is never told alone");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`));
});

test("a pair left by a run long gone doesn't stop a sender; a fresh one does (a gone run's pair)", async () => {
  const pairAt = (at: number) => new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""],
    [`/docs/${lib.recordName("pair", TAG, 5, 6, "bbbbbbbb")}`, JSON.stringify({ at })]]);
  const stale = pairAt(NOTE_NOW.getTime() - 10 * 60_000);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: stale, notifier, now: NOTE_NOW, responder: eventsAt(feed(5, [stoppedEv(5)])) });
  assert.equal(notifier.log.length, 1, "told");
  const fresh = pairAt(NOTE_NOW.getTime());
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: fresh, notifier: notifier2, now: NOTE_NOW, responder: eventsAt(feed(5, [stoppedEv(5)])) });
  assert.equal(notifier2.log.length, 0, "held while that run may be cancelling them out");
});

test("a stopped another run starts handing over is neither taken as told nor cancelled out; both wait (an intent after the pair)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const events = feed(6, [stoppedEv(5), resumedEv(6)]);
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  const intent = `/docs/${lib.recordName("intent", TAG, 5, "cccccccc")}`;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events),
    onWrite: (p: string, f: Map<string, string>) => { if (p.includes("headroom-pair-") && !f.has(intent)) f.set(intent, JSON.stringify({ seqs: [5], at: NOTE_NOW.getTime() })); } } as any);
  assert.equal(notifier.log.length, 0);
  assert.ok(!files.has(`/docs/${lib.recordName("told", TAG, 5)}`), "not taken as told");
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`) && !files.has(`/docs/headroom-events-${TAG}-6`), "the cursor stays before 5");
  assert.ok(![...files.keys()].some((k) => k.includes("headroom-pair-")), "its pair is taken back");
  // the other run's stopped shows on the device: the resumed is told
  notifier.delivered.set("s", { id: `headroom.${gen}.events.5.all`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.deepEqual(notifier.log.flatMap((n: any) => plain(n.userInfo.seqs)), [6]);
});

test("a notification another run settles after this one chose it isn't handed to iOS (settled meanwhile)", async () => {
  const events = feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })]);
  for (const [what, settle] of [
    ["the cursor passed it", (f: Map<string, string>) => f.set(`/docs/headroom-events-${TAG}-5`, "")],
    ["its told record", (f: Map<string, string>) => f.set(`/docs/${lib.recordName("told", TAG, 5)}`, JSON.stringify({ mark: null }))],
  ] as const) {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
    const notifier = newNotifier();
    let done = false;
    await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events),
      onWrite: (p: string, f: Map<string, string>) => { if (p.includes("headroom-intent-") && !done) { done = true; settle(f); } } } as any);
    assert.equal(notifier.log.length, 0, what);
    assert.ok([...files.keys()].some((k) => k.includes("headroom-abort-")), `${what}: dropped, and recorded so`);
  }
});

test("a notification iOS took whose told record can't be written isn't sent again in the same run (in one run)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  const events = feed(5, [ev(5, "limit", { window_id: "seven_day", label: "Weekly", resets_at: "2026-11-20T00:00:00Z" })]);
  // the device's list doesn't show it yet
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events),
    writeFailsWhen: (p: string) => p.includes("headroom-told-"), onAllDelivered: (n: Notifier) => n.delivered.clear() } as any);
  assert.equal(notifier.log.length, 1);
  assert.ok(!files.has(`/docs/headroom-events-${TAG}-5`), "the cursor stays before it");
});

test("a notification found delivered after its event left the feed still remembers its cycle (kept by the intent)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const limit = ev(5, "limit");
  const mark = lib.eventMark(limit);
  const reset = ev(7, "reset");
  const run = async (marks: unknown) => {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""],
      [`/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`, JSON.stringify({ seqs: [5], ...(marks ? { marks } : {}), at: NOTE_NOW.getTime() - 10 * 60_000 })]]);
    const notifier = newNotifier();
    notifier.delivered.set("five", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
    // the server no longer holds 5 (the oldest is 6)
    await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
      responder: eventsAt({ last_seq: 7, oldest_seq: 6, events: [ev(6, "threshold", { threshold: 80, provider: "codex" }), reset] }) });
    return { files, notifier };
  };
  const kept = await run({ 5: mark });
  assert.deepEqual(JSON.parse(kept.files.get(`/docs/${lib.recordName("told", TAG, 5)}`) ?? "null")?.mark?.key, mark.key, "its cycle, from the intent");
  assert.ok(kept.notifier.log.some((n: any) => plain(n.userInfo.seqs).includes(7)), "so its reset is told");
  // the control: an intent without the cycles (an earlier version's) can't tell the reset belongs to a told limit
  const plainIntent = await run(null);
  assert.ok(!plainIntent.notifier.log.some((n: any) => plain(n.userInfo?.seqs ?? []).includes(7)));
});

test("an intent stays until all its numbers are passed; a told record that can't be read stays; a corrupt one goes (cleanup)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  // an intent for 5 and 7 whose run may still be going; 5 is on the device
  const intent = `/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [intent, JSON.stringify({ seqs: [5, 7], at: NOTE_NOW.getTime() - 30_000 })]]);
  const notifier = newNotifier();
  notifier.delivered.set("five", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    responder: eventsAt(feed(7, [ev(5, "limit"), ev(6, "threshold", { threshold: 80, provider: "codex" }), ev(7, "limit", { provider: "codex" })])) });
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`) && !files.has(`/docs/headroom-events-${TAG}-7`), "the cursor waits before 7");
  assert.ok(files.has(intent), "kept: 7 isn't passed");
  // a told record passed by the cursor, with a cycle that still matters, whose read fails at the cleanup
  const told5 = `/docs/${lib.recordName("told", TAG, 5)}`;
  const mark = { ...lib.eventMark(ev(5, "limit")), until: NOTE_NOW.getTime() + 86_400_000 };
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-5`, ""], [told5, JSON.stringify({ mark })]]);
  let reads = 0;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: newNotifier(), now: NOTE_NOW, responder: eventsAt(feed(5, [])),
    readFailsWhen: (p: string) => p === told5 && ++reads > 1 } as any);
  assert.ok(files2.has(told5), "kept");
  // a corrupt one passed by the cursor holds nothing: it goes (and doesn't stop the run)
  const files3 = new Map<string, string>([[`/docs/headroom-events-${TAG}-5`, ""], [told5, "{"]]);
  const corrupt = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files3, notifier: newNotifier(), now: NOTE_NOW, responder: eventsAt(feed(5, [])) });
  assert.ok(!files3.has(told5));
  assert.ok(!String(corrupt.shortcutOutput).startsWith("Couldn't"), String(corrupt.shortcutOutput));
});

// ---- Fixes after the second check (realistic ones)
test("Remove all removes none of the shared items unless it read them all; settings keep their switches (a shared item read last)", async () => {
  const keychain = { [lib.KEYCHAIN_CONFIG]: CONFIG_A, [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ events: false, times: false }) };
  // after the confirmation, the second read of the shared settings (the one Remove all makes before removing) fails once
  let armed = false;
  let gets = 0;
  const quit = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain, answers: [0, -1],
    beforeConfirm: () => { armed = true; },
    keychainGetFailsWhen: (k: string) => armed && k === lib.KEYCHAIN_CONFIG && ++gets === 2 } as any);
  assert.ok(quit.alertTitles.includes("Not fully removed"), quit.alertTitles.join(" | "));
  assert.ok(quit.keychain.has(lib.KEYCHAIN_CONFIG) && quit.keychain.has(lib.KEYCHAIN_NOTIFY), "both kept");
  const prefs = lib.notifyPrefs(quit.keychain.get(lib.KEYCHAIN_NOTIFY))!;
  assert.deepEqual([prefs.events, prefs.times], [false, false], "still both off");
  // the control: read, all go
  const done = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain });
  assert.ok(!done.keychain.has(lib.KEYCHAIN_CONFIG) && !done.keychain.has(lib.KEYCHAIN_NOTIFY));
});

test("a told record whose content is corrupt settles nothing; the pair is decided again (a record cut short)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/${lib.recordName("told", TAG, 5)}`, "{"]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(6, [stoppedEv(5), resumedEv(6)])) });
  assert.equal(notifier.log.length, 0, "the resumed isn't told alone");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`), "both settled");
});

test("a corrupt told record doesn't take the cycle an intent kept; the reset is told (a record cut short)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const mark = lib.eventMark(ev(5, "limit"));
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/${lib.recordName("told", TAG, 5)}`, "{"],
    [`/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`, JSON.stringify({ seqs: [5], marks: { 5: mark }, at: NOTE_NOW.getTime() - 10 * 60_000 })]]);
  const notifier = newNotifier();
  notifier.delivered.set("five", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    responder: eventsAt({ last_seq: 7, oldest_seq: 6, events: [ev(6, "threshold", { threshold: 80, provider: "codex" }), ev(7, "reset")] }) });
  assert.ok(notifier.log.some((n: any) => plain(n.userInfo.seqs).includes(7)));
});

test("an intent's number that shows on the device only at the last check still gives its cycle (seen at the re-read)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const mark = lib.eventMark(ev(5, "limit"));
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""],
    [`/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`, JSON.stringify({ seqs: [5], marks: { 5: mark }, at: NOTE_NOW.getTime() - 10 * 60_000 })]]);
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
    responder: eventsAt({ last_seq: 7, oldest_seq: 6, events: [ev(6, "threshold", { threshold: 80, provider: "codex" }), ev(7, "reset")] }),
    onAllDelivered: (n: Notifier, call: number) => {
      if (call === 2) n.delivered.set("five", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } });
    } } as any);
  assert.ok(notifier.log.some((n: any) => plain(n.userInfo.seqs).includes(7)), "the reset is told");
  assert.equal(JSON.parse(files.get(`/docs/${lib.recordName("told", TAG, 5)}`) ?? "null")?.mark?.key, mark.key);
});

test("a reset whose reminder is due but still waiting on the device is held; long past its time, it is told (still waiting)", () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const cycle = "2026-11-19T11:59:00.000Z";
  const stamp = "2026-11-19T10:00:00.000Z#1";
  const told = { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, boundary: stamp, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] };
  const reset = ev(9, "reset", { cycle, resets_at: cycle, boundary: stamp });
  const row = (fireAt: number) => {
    const item = { kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: fireAt, boundary: stamp };
    return { id: lib.reminderId(gen, item), ...item, confirmed: true };
  };
  const pick = (r: any, times = true) => lib.selectAlerts([reset], null, NOTE_NOW, { told, reminders: [r], times, pending: new Set([r.id]), deliveredIds: new Set(), deliveredStamps: new Map() });
  const soon = pick(row(NOTE_NOW.getTime() - 30_000));
  assert.deepEqual([soon.alerts.length, plain(soon.held)], [0, [9]], "it rings in a moment: held");
  assert.equal(pick(row(NOTE_NOW.getTime() - 20 * 60_000)).alerts.length, 1, "iOS kept it waiting: the event tells it");
  assert.equal(pick(row(NOTE_NOW.getTime() - 30_000), false).alerts.length, 1, "with time reminders off it is being cancelled");
});

test("a reminder saved as about to be scheduled no longer holds a cancel once its run is gone (a stop before iOS)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const t = NOTE_NOW.getTime() + 3_600_000;
  const id = `headroom.${gen}.back.claude.five_hour.${Math.round(t / 60_000)}.0123456789abcdef.0a0a0a0a`;
  const run = async (setAt: number) => {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify({
      reminders: [{ id, kind: "back", provider: "claude", window_id: "five_hour", cycle: t, fire_at: t, set_at: setAt, confirmed: false }],
      told: { limits: [], warned: [] }, sent: [] })]]);
    const keychain = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz",
      [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ events: true, times: false, rev: 1, cancel_pending: true, cancels: [{ op: "0a0a0a0a", gen, before: NOTE_NOW.getTime() }] }) };
    const r = await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier: newNotifier(), keychain, now: NOTE_NOW,
      responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: feed(3, []) } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) });
    return lib.notifyPrefs(savedSwitches(r.keychain))!;
  };
  assert.equal((await run(NOTE_NOW.getTime() - 10 * 60_000)).cancel_pending, false, "its run is long gone: it never reached iOS");
  assert.equal((await run(NOTE_NOW.getTime() - 30_000)).cancel_pending, true, "its run may still be handing it over");
});

test("turning time reminders off marks a reminder as being cancelled before removing it; a stop there leaves the reset to be told (the menu)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const cycle = "2026-11-19T11:59:00.000Z";
  const item = { kind: "back", provider: "claude", window_id: "five_hour", cycle: Date.parse(cycle), fire_at: NOTE_NOW.getTime() - 60_000, boundary: null };
  const id = lib.reminderId(gen, item);
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], [`/docs/headroom-notify-${TAG}.json`, JSON.stringify({
    reminders: [{ id, ...item, set_at: NOTE_NOW.getTime() - 3_600_000, confirmed: true }],
    told: { limits: [{ key: `claude.five_hour.${cycle}`, at: 1, event_at: 1, until: NOTE_NOW.getTime() + 86_400_000 }], warned: [] }, sent: [] })]]);
  const notifier = newNotifier();
  notifier.pending.set(id, { id });
  // removed from the device, then the menu stops (iOS took the cancel, nothing after it ran)
  const off = await runWidget({ family: "medium", app: { menu: [2, 2] }, notifier, files, now: NOTE_NOW, removePendingThenFails: true } as any);
  const state = JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!);
  assert.equal(state.reminders.find((r: any) => r.id === id)?.cancelling, true, "marked before it was removed");
  // the reset comes: the reminder never rang, so the event tells it
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, keychain: Object.fromEntries(off.keychain), now: NOTE_NOW,
    responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: feed(5, [ev(5, "reset", { cycle, resets_at: cycle })]) } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) });
  assert.ok(notifier.log.some((n: any) => String(n.body).includes("usable again")), "told");
});

test("a reminder being cancelled, or one of another account's stamp, is planned again under a new identifier (taking over)", () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const c = NOTE_NOW.getTime() + 3_600_000;
  const item = { kind: "back", provider: "claude", window_id: "five_hour", cycle: c, fire_at: c, boundary: "2026-11-19T12:00:00.000Z#2", title: "t", body: "b" };
  const prev = (o: Record<string, unknown>) => ({ id: `headroom.${gen}.back.claude.five_hour.${Math.round(c / 60_000)}.0123456789abcdef.0a0a0a0a`,
    kind: "back", provider: "claude", window_id: "five_hour", cycle: c, fire_at: c, set_at: 1, confirmed: true, boundary: item.boundary, ...o });
  const plan = (p: any) => plain(lib.reconcileReminders([p], [item], NOTE_NOW, gen, new Set([p.id])));
  for (const [what, o] of [["being cancelled", { cancelling: true }], ["an old one without a stamp", { boundary: null }],
    ["another account's", { boundary: "2026-11-19T10:00:00.000Z#1" }]] as const) {
    const p = prev(o);
    const r = plan(p);
    assert.equal(r.schedule.length, 1, what);
    assert.notEqual(r.schedule[0].id, p.id, `${what}: a new identifier`);
    assert.deepEqual(r.cancel, [p.id], `${what}: the old one cancelled`);
    assert.equal(r.reminders[0].confirmed, undefined, `${what}: not taken as known scheduled`);
  }
  // the control: the same account's, not being cancelled, is kept as it is
  const same = plan(prev({}));
  assert.deepEqual([same.schedule.length, same.cancel.length, same.reminders[0].id], [0, 0, prev({}).id]);
});

test("a received withdrawal's seen marker says so; a view with values says nothing (what the marker says)", async () => {
  const files = new Map<string, string>();
  await runWidget({ family: "medium", files, response: { status: 200, body: sampleView(5) } });
  assert.equal(files.get(`/docs/headroom-seen-${TAG}-5`), "");
  await runWidget({ family: "medium", files, response: { status: 200, body: emptyView(6) } });
  assert.equal(files.get(`/docs/headroom-seen-${TAG}-6`), "withdrawn");
});

test("a stopped another run told while this one cancels the pair out is taken; its resumed is told (told meanwhile)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  const notifier = newNotifier();
  const told5 = `/docs/${lib.recordName("told", TAG, 5)}`;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(feed(6, [stoppedEv(5), resumedEv(6)])),
    onWrite: (p: string, f: Map<string, string>) => { if (p.includes("headroom-pair-") && !f.has(told5)) f.set(told5, JSON.stringify({ mark: null })); } } as any);
  assert.deepEqual(notifier.log.flatMap((n: any) => plain(n.userInfo.seqs)), [6]);
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`));
  assert.ok(![...files.keys()].some((k) => k.includes("headroom-pair-")), "its pair is taken back");
});

test("a notification's intent keeps each number's cycle, read from its event (what the intent holds)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""]]);
  let written: any = null;
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier: newNotifier(), now: NOTE_NOW, responder: eventsAt(feed(5, [ev(5, "limit")])),
    onWrite: (p: string, f: Map<string, string>) => { if (p.includes("headroom-intent-") && written === null) written = JSON.parse(f.get(p)!); } } as any);
  assert.deepEqual(plain(written?.seqs), [5]);
  assert.equal(written?.marks?.[5]?.key, lib.eventMark(ev(5, "limit")).key);
});

test("a reminder is saved as being cancelled before it is removed, when cancelling what is owed and when withdrawn (the notifying run)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const t = NOTE_NOW.getTime() + 3_600_000;
  const id = `headroom.${gen}.back.claude.five_hour.${Math.round(t / 60_000)}.0123456789abcdef.0a0a0a0a`;
  const row = { id, kind: "back", provider: "claude", window_id: "five_hour", cycle: t, fire_at: t, set_at: NOTE_NOW.getTime() - 3_600_000, confirmed: true, from: 5 };
  const setup = () => new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""],
    [`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [row], told: { limits: [], warned: [] }, sent: [], view_version: 5 })]]);
  const cancelling = (files: Map<string, string>) => JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).reminders.find((r: any) => r.id === id)?.cancelling;
  // time reminders off: what is owed is cancelled
  const owed = setup();
  const n1 = newNotifier();
  n1.pending.set(id, { id });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: owed, notifier: n1, now: NOTE_NOW, removePendingThenFails: true,
    keychain: { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", [lib.KEYCHAIN_NOTIFY]: JSON.stringify({ events: true, times: false }) },
    responder: (url: string) => (url.includes("/v2/events") ? { status: 200, body: feed(3, []) } : url.includes("/v2/view") ? { status: 503, body: {} } : undefined) } as any);
  assert.equal(cancelling(owed), true, "owed");
  // a withdrawal: the plan cancels it
  const withdrawn = setup();
  const n2 = newNotifier();
  n2.pending.set(id, { id });
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: withdrawn, notifier: n2, now: NOTE_NOW, removePendingThenFails: true,
    response: { status: 200, body: emptyView(6) }, responder: eventsAt(feed(3, [])) } as any);
  assert.equal(cancelling(withdrawn), true, "withdrawn");
});

// ---- Fixes after the limitations check
test("a stopped in flight that shows on the device only at the last check lets its resumed be told in that run (shown at the re-read)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""],
    [`/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`, JSON.stringify({ seqs: [5], at: NOTE_NOW.getTime() - 30_000 })]]);
  const notifier = newNotifier();
  const events = feed(6, [stoppedEv(5), resumedEv(6)]);
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events),
    onAllDelivered: (n: Notifier, call: number) => {
      if (call === 2) n.delivered.set("s", { id: `headroom.${gen}.events.5.all`, title: "t", body: "b", userInfo: { seqs: [5] } });
    } } as any);
  assert.deepEqual(notifier.log.flatMap((n: any) => plain(n.userInfo.seqs)), [6], "the resumed is told");
  assert.ok(files.has(`/docs/headroom-events-${TAG}-6`));
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, responder: eventsAt(events) });
  assert.equal(notifier.log.length, 1, "not again");
});

test("a reminder being cancelled or of another account is planned again also within its last minute (taking over, due)", () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const c = NOTE_NOW.getTime() + 30_000;
  const item = { kind: "runout", provider: "claude", window_id: "five_hour", cycle: c, fire_at: c, boundary: "2026-11-19T12:00:00.000Z#2", title: "t", body: "b" };
  const prev = (o: Record<string, unknown>) => ({ id: `headroom.${gen}.runout.claude.five_hour.${Math.round(c / 60_000)}.0123456789abcdef.0a0a0a0a`,
    kind: "runout", provider: "claude", window_id: "five_hour", cycle: c, fire_at: c, set_at: 1, confirmed: true, boundary: item.boundary, ...o });
  // being cancelled and still waiting (its cancel hasn't gone through): planned again under a new identifier
  const waiting = prev({ cancelling: true });
  assert.equal(plain(lib.reconcileReminders([waiting], [item], NOTE_NOW, gen, new Set([waiting.id]))).schedule.length, 1);
  // being cancelled and gone, whether it rang unknown (the notifying run settles it by the device first): held as it is
  const gone = plain(lib.reconcileReminders([prev({ cancelling: true })], [item], NOTE_NOW, gen, new Set()));
  assert.deepEqual([gone.schedule.length, gone.reminders[0].cancelling], [0, true]);
  // another account's, gone (it rang for that account): this account's is planned
  assert.equal(plain(lib.reconcileReminders([prev({ boundary: null })], [item], NOTE_NOW, gen, new Set())).schedule.length, 1);
  // the control: the same account's, gone from the device within its minute, rang
  assert.equal(plain(lib.reconcileReminders([prev({})], [item], NOTE_NOW, gen, new Set())).schedule.length, 0);
});

test("a reminder left as being cancelled is forgotten once gone, and taken as rung once delivered (settled by the device)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  // its time has passed (a reminder delivered has rung)
  const t = NOTE_NOW.getTime() - 60_000;
  const id = `headroom.${gen}.back.claude.five_hour.${Math.round(t / 60_000)}.0123456789abcdef.0a0a0a0a`;
  const row = { id, kind: "back", provider: "claude", window_id: "five_hour", cycle: t, fire_at: t, set_at: 1, confirmed: true, cancelling: true };
  const run = async (delivered: string | null | undefined, opts: Record<string, unknown> = {}) => {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""],
      [`/docs/headroom-notify-${TAG}.json`, JSON.stringify({ reminders: [row], told: { limits: [], warned: [] }, sent: [] })]]);
    const notifier = newNotifier();
    if (delivered !== undefined) notifier.delivered.set(id, { id, title: "t", body: "b", userInfo: { boundary: delivered } });
    await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
      response: { status: 200, body: emptyView(6) }, responder: eventsAt(feed(3, [])), ...opts } as any);
    return JSON.parse(files.get(`/docs/headroom-notify-${TAG}.json`)!).reminders.find((r: any) => r.id === id);
  };
  assert.equal(await run(undefined), undefined, "the cancel went through: forgotten");
  assert.equal((await run(null))?.cancelling, false, "delivered under its own stamp: it rang");
  assert.equal(await run("2026-11-19T10:00:00.000Z#1"), undefined, "delivered under another account's stamp: not this one");
  assert.equal((await run(null, { deliveredFailsOnCall: 1 }))?.cancelling, true, "the list can't be read: left as it is");
});

test("the cycle an intent kept is used whichever of two intents for the number is read first (two intents)", async () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const mark = lib.eventMark(ev(5, "limit"));
  const good = [`/docs/${lib.recordName("intent", TAG, 5, "bbbbbbbb")}`, JSON.stringify({ seqs: [5], marks: { 5: mark }, at: NOTE_NOW.getTime() - 10 * 60_000 })] as const;
  const bad = [`/docs/${lib.recordName("intent", TAG, 5, "aaaaaaaa")}`, "{"] as const;
  for (const order of [[bad, good], [good, bad]]) {
    const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-4`, ""], ...order.map(([k, v]) => [k, v] as [string, string])]);
    const notifier = newNotifier();
    notifier.delivered.set("five", { id: `headroom.${gen}.events.5.claude`, title: "t", body: "b", userInfo: { seqs: [5] } } as any);
    await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW,
      responder: eventsAt({ last_seq: 7, oldest_seq: 6, events: [ev(6, "threshold", { threshold: 80, provider: "codex" }), ev(7, "reset")] }) });
    assert.ok(notifier.log.some((n: any) => plain(n.userInfo.seqs).includes(7)), order[0] === bad ? "the corrupt one first" : "the good one first");
  }
});

test("nothing is planned from the older body in the run that read the newer view (a marker not saved, the older body kept)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  saveViewFile(files, { ...demoBody("reset", NOTE_NOW), data_version: 5 });
  const notifier = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body: emptyView(6) },
    responder: eventsAt(feed(3, [])), writeFailsWhen: (p: string) => p.includes(`headroom-seen-${TAG}-6`) } as any);
  assert.equal(notifier.log.length, 0, "no reminder from 5");
  // the control: no newer view read, the saved 5 plans its reminder
  const files2 = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  saveViewFile(files2, { ...demoBody("reset", NOTE_NOW), data_version: 5 });
  const notifier2 = newNotifier();
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files: files2, notifier: notifier2, now: NOTE_NOW, response: { status: 503, body: {} },
    responder: eventsAt(feed(3, [])) } as any);
  assert.equal(notifier2.pending.size, 1);
});

test("its reminder due within a minute is cancelled; the other provider's is kept (one provider withdrawn)", () => {
  const gen = lib.DEFAULT_CONFIG_ID;
  const c = NOTE_NOW.getTime() + 30_000;
  const row = (provider: string) => ({ id: `headroom.${gen}.back.${provider}.all.${Math.round(c / 60_000)}.0123456789abcdef.0a0a0a0a`,
    kind: "back", provider, window_id: "all", cycle: c, fire_at: c, set_at: 1, confirmed: true, from: 5 });
  const codex = row("codex");
  const claude = row("claude");
  const r = plain(lib.reconcileReminders([codex, claude], [], NOTE_NOW, gen, new Set([codex.id, claude.id]), 8, new Set(["codex"])));
  assert.deepEqual(r.cancel, [codex.id], "codex withdrawn: cancelled");
  assert.ok(r.reminders.some((x: any) => x.id === claude.id), "claude's kept (it rings in a moment)");
});

test("a reminder being cancelled whose fate can't be told isn't planned again in that run (the list unreadable)", async () => {
  const files = new Map<string, string>([[`/docs/headroom-events-${TAG}-3`, ""]]);
  const notifier = newNotifier();
  const body = { ...demoBody("reset", NOTE_NOW), data_version: 5 };
  await notifyWith(files, notifier, { status: 200, body });
  assert.equal(notifier.log.length, 1);
  // left as being cancelled and gone from the device (cancelled, or it rang)
  const path = `/docs/headroom-notify-${TAG}.json`;
  const st = JSON.parse(files.get(path)!);
  files.set(path, JSON.stringify({ ...st, reminders: st.reminders.map((r: any) => ({ ...r, cancelling: true })) }));
  notifier.pending.clear();
  // the delivered list can't be read for the check: nothing is planned again for it
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body },
    responder: eventsAt(feed(3, [])), deliveredFailsOnCall: 1 } as any);
  assert.equal(notifier.log.length, 1, "not scheduled again");
  // readable and not delivered: the cancel went through, so it is planned again
  await runWidget({ family: "medium", inApp: true, shortcut: "notify", files, notifier, now: NOTE_NOW, response: { status: 200, body },
    responder: eventsAt(feed(3, [])) } as any);
  assert.equal(notifier.log.length, 2);
});

// ------------------------------------------------------------------------------------------------
// Three providers (Gemini): which are shown, side by side, and what one without values says

/** A view of three providers as the server builds it (core's toView), Gemini with a limit shown in the details only */
function threeView(): any {
  const s = fixture();
  const at = "2026-11-16T12:59:00.000Z";
  const w = (id: string, used: number, scope: string | null, kind: "session" | "weekly") =>
    ({ id, label: id, kind, scope, used_percent: used, resets_at: kind === "session" ? "2026-11-16T16:00:00.000Z" : "2026-11-20T00:00:00.000Z", fetched_at: at });
  s.providers.gemini = {
    status: "ok", fetched_at: at, collector: "win-desktop", error: null, error_code: null, plan: "pro", blocked: false, history_since: null,
    windows: [w("five_hour", 30, null, "session"), w("seven_day", 40, null, "weekly"), w("seven_day_argon", 100, "Argon", "weekly"),
      w("partner_five_hour", 100, "Claude and GPT", "session")],
  } as never;
  const view = toView(mergeSnapshots([s])!, NOW);
  return lib.sanitizeView({ ...view, data_version: 3, boundaries: { claude: "#0", codex: "#0", gemini: "" } });
}

test("a view of three providers is read whole; an earlier Worker's reads Gemini as none; a limit for the details only is kept so", () => {
  const view = threeView();
  assert.ok(view, "the server's view of three providers");
  assert.deepEqual(Object.keys(view.gemini.windows).sort(), ["five_hour", "partner_five_hour", "seven_day", "seven_day_argon"]);
  assert.equal(view.gemini.windows.partner_five_hour.detail_only, true);
  assert.equal(view.gemini.windows.seven_day_argon.detail_only, false);
  assert.equal(view.boundaries.gemini, "");
  // stamps: an earlier Worker's carry no Gemini (not known); a bad one makes them unreadable
  assert.deepEqual(plain(lib.sanitizeBoundaries({ claude: "", codex: "#1" })), { codex: "#1", claude: "", gemini: null });
  assert.equal(lib.sanitizeBoundaries({ claude: "", codex: "", gemini: 5 }), null);
  assert.equal(lib.sanitizeBoundaries({ claude: "", gemini: "" }), null, "the first providers must be there");
});

test("the parameter names one to three providers in its order; empty shows Codex and Claude, then any other with values", () => {
  assert.deepEqual(plain(lib.providerList("gemini")), ["gemini"]);
  assert.deepEqual(plain(lib.providerList(" Claude, Gemini ")), ["claude", "gemini"]);
  assert.deepEqual(plain(lib.providerList("codex claude gemini claude")), ["codex", "claude", "gemini"]);
  for (const p of ["", "claude 5h", "most", "5h, others"]) assert.equal(lib.providerList(p), null, `${p}: names more than providers`);
  // words not understood are left out of what is shown (and said on the widget)
  assert.deepEqual(plain(lib.parseParameter("claude, top, claude.five_hour").unknown), ["top", "claude.five_hour"]);
  const three = threeView();
  const two = lib.demoResult("normal", NOW).view;
  const shown = (view: any, p: string) => plain(lib.groupsOf(view, p, NOW).map((g: any) => [g.provider, g.message]));
  assert.deepEqual(shown(three, ""), [["codex", null], ["claude", null], ["gemini", null]]);
  assert.deepEqual(shown(two, ""), [["codex", null], ["claude", null]], "Gemini without values isn't added");
  assert.deepEqual(shown(two, "gemini"), [["gemini", "Not set up"]]);
  assert.deepEqual(shown(two, "claude, codex, gemini"), [["claude", null], ["codex", null], ["gemini", "Not set up"]]);
  assert.deepEqual(plain(lib.groupsOf(two, "codex, claude", NOW).map((g: any) => g.provider)), ["codex", "claude"]);
});

test("the header dot: another maker's model at 100% (Gemini's C+G) never keeps the provider at its limit", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  const at = "2026-11-20T11:55:00.000Z";
  const w = (id: string, used: number, resets: string, extra: any = {}) => ({ id, label: id, kind: id.includes("five") ? "session" : "weekly", scope: null, used_percent: used, resets_at: resets, fetched_at: at, ...extra });
  const gemini = {
    status: "ok", plan: "pro", blocked: true, error_code: null, main_window_ids: ["five_hour", "seven_day"], window_ids: ["five_hour", "seven_day", "partner_seven_day"],
    windows: {
      five_hour: w("five_hour", 100, "2026-11-20T11:58:00.000Z"),
      seven_day: w("seven_day", 40, "2026-11-25T00:00:00.000Z"),
      partner_seven_day: w("partner_seven_day", 100, "2026-11-24T00:00:00.000Z", { scope: "Claude and GPT", detail_only: true }),
    },
  };
  const view = { gemini };
  // its own 5h limit has reset since: lifted, whatever C+G shows
  assert.notEqual(lib.freshnessOf(view, "gemini", now, ["five_hour", "seven_day", "partner_seven_day"]).level, "limit");
  assert.equal(lib.freshnessOf(view, "gemini", now, ["five_hour", "seven_day"]).level, lib.freshnessOf(view, "gemini", now, ["five_hour", "seven_day", "partner_seven_day"]).level);
  // its own limit still at 100% ahead: at its limit
  const held = { gemini: { ...gemini, windows: { ...gemini.windows, seven_day: w("seven_day", 100, "2026-11-25T00:00:00.000Z") } } };
  assert.equal(lib.freshnessOf(held, "gemini", now, ["five_hour", "seven_day", "partner_seven_day"]).level, "limit");
});

test("other makers' models a provider offers (Gemini's Claude and GPT): last on the home screen widget where rows leave room, never on the lock screen or in reminders", () => {
  const view = threeView();
  for (const allScoped of [false, true]) {
    const [gemini] = lib.groupsOf(view, "gemini", NOW, { allScoped });
    const ids = gemini.rows.map((r: any) => r.window.id);
    assert.equal(ids[ids.length - 1], "partner_five_hour", `${allScoped}: ${ids}`);
    assert.ok(ids.includes("seven_day_argon"), "Gemini's own model limit at 100%, as Fable");
    // not when the parameter names limits
    assert.ok(!lib.groupsOf(view, "gemini, wk", NOW, { allScoped })[0].rows.some((r: any) => r.window?.id?.startsWith("partner_")));
  }
  // dropped first for room: after the provider's own limits, the weekly one before the 5h one
  const both = { ...view, gemini: { ...view.gemini, window_ids: [...view.gemini.window_ids, "partner_seven_day"], windows: { ...view.gemini.windows, partner_seven_day: { ...view.gemini.windows.partner_five_hour, id: "partner_seven_day" } } } };
  const rows = lib.groupsOf(both, "gemini", NOW, { allScoped: true })[0].rows;
  const kept = (n: number) => plain(lib.visibleRows(rows, n).map((r: any) => r.window.id));
  assert.deepEqual(kept(5), ["five_hour", "seven_day", "seven_day_argon", "partner_five_hour", "partner_seven_day"]);
  assert.deepEqual(kept(4), ["five_hour", "seven_day", "seven_day_argon", "partner_seven_day"], "the weekly one when only one fits");
  assert.deepEqual(kept(3), ["five_hour", "seven_day", "seven_day_argon"], "never in place of the provider's own");
  assert.ok(lib.rowRank({ kind: "window", window: { scope: "Argon", detail_only: false, id: "seven_day_argon" } }) < lib.rowRank(rows[4]));
  // across providers, too: the rows dropped for height are these first (three columns of three on the large widget)
  const large = lib.layoutGroups(both, "large", "", NOW, { screen: { width: 390, height: 844 } });
  const gem = large.groups.find((g: any) => g.provider === "gemini");
  assert.deepEqual(plain(gem.rows.map((r: any) => r.window.id)), ["five_hour", "seven_day", "seven_day_argon"]);
  // most: other makers' models only when it names no limit (5h, wk name the provider's own)
  for (const [p, has] of [["gemini, most, 5h", false], ["gemini, claude, most, wk", false], ["gemini, most", true]] as const) {
    const g = lib.layoutGroups(both, "large", p, NOW, { screen: { width: 430, height: 932 } }).groups.find((x: any) => x.provider === "gemini");
    assert.equal(g.rows.some((r: any) => r.window?.detail_only), has, p);
  }
  const alone = lib.layoutGroups(both, "large", "gemini", NOW, { screen: { width: 390, height: 844 } });
  assert.ok(alone.groups[0].rows.some((r: any) => r.window.id === "partner_seven_day"), "Gemini alone: there is room");
  // without Argon (its own model limit gone): Claude/GPT wk takes the third row of the large widget's three columns
  const noArgon = { ...both, gemini: { ...both.gemini, window_ids: both.gemini.window_ids.filter((id: string) => id !== "seven_day_argon") } };
  const third = lib.layoutGroups(noArgon, "large", "", NOW, { screen: { width: 390, height: 844 } }).groups.find((g: any) => g.provider === "gemini");
  assert.deepEqual(plain(third.rows.map((r: any) => r.window.id)), ["five_hour", "seven_day", "partner_seven_day"]);
  // a short name on the widgets (a column has room for about "Argon wk"); the details keep Claude/GPT
  assert.equal(lib.rowLabel(third.rows[2].window), "C+G wk");
  assert.equal(lib.rowLabel({ ...third.rows[2].window, id: "partner_five_hour" }), "C+G 5h");
  assert.equal(lib.limitLabel(third.rows[2].window), "Claude/GPT weekly");
  const sc = lib.SCALES.large;
  const room = Math.floor((lib.widgetSize("large", { width: 375, height: 667 }).width - 2 * lib.PADDING.large - 20) / 3) - lib.textWidth("100%", sc.pct, true) - 4;
  assert.ok(lib.textWidth("C+G wk", sc.label) <= room, `fits beside 100% in a 375pt iPhone column (narrower ones shrink the text, as for Argon wk) (${room})`);
  assert.ok(lib.textWidth("C+G wk", sc.label) <= lib.textWidth("Argon wk", sc.label));
  for (const p of ["", "5h", "gemini, wk"]) assert.ok(!lib.selectWindows(view, p, NOW).some((x: any) => x.window.id.startsWith("partner_")), p);
  assert.ok(!lib.lockPicks(view, "gemini", NOW).some((x: any) => x.window?.id === "partner_five_hour"));
  assert.ok(!lib.reminderPlan(view, NOW).some((r: any) => r.window_id === "partner_five_hour"));
});

test("medium and large draw three columns of one width; a demo says Demo once at the bottom; Not set up where the limits go", async () => {
  const view = lib.demoResult("three", NOW).view;
  for (const family of ["medium", "large"]) {
    const layout = lib.layoutGroups(view, family, "", NOW, { demo: true });
    assert.equal(layout.groups.length, 3);
    assert.equal(layout.gap, 10);
    assert.equal(layout.colWidth, Math.floor((layout.inner - 20) / 3));
    assert.equal(layout.demoNote, true);
  }
  assert.equal(lib.layoutGroups(lib.demoResult("normal", NOW).view, "medium", "", NOW, { demo: true }).demoNote, false, "two columns: Demo in the headers");
  const medium = texts((await runWidget({ family: "medium", demo: "three", now: NOW })).widget.node);
  for (const name of ["Codex", "Claude", "Gemini"]) assert.ok(medium.includes(name), medium.join(" | "));
  assert.equal(medium.filter((t) => /\bDemo\b/.test(t)).length, 1, medium.join(" | "));
  assert.ok(!medium.some((t) => t.includes("Claude/GPT")), "two rows a column: Gemini's own first, no room for Claude and GPT");
  const large = texts((await runWidget({ family: "large", demo: "three", now: NOW })).widget.node);
  assert.ok(large.includes("Argon wk") && large.includes("Weekly usage"), large.join(" | "));
  assert.equal(large.filter((t) => t === "Gemini").length, 2, "its column and the chart's legend");
  const off = texts((await runWidget({ family: "medium", demo: "unsupported", now: NOW })).widget.node);
  assert.ok(off.includes("Gemini") && off.includes("Not set up"), off.join(" | "));
  const small = texts((await runWidget({ family: "small", demo: "three", now: NOW })).widget.node);
  for (const name of ["Codex", "Claude", "Gemini"]) assert.ok(small.includes(name), small.join(" | "));
});

test("the lock screen takes Gemini as any provider, and one not supported says so", async () => {
  const pick = (view: any, p: string) => plain(lib.lockPicks(view, p, NOW).map((x: any) => (x.missing ? `${x.provider}:${x.label}` : `${x.provider}.${x.window.id}`)));
  const three = threeView();
  assert.deepEqual(pick(three, "gemini 5h"), ["gemini.five_hour"]);
  // both limits named: each provider's tightest, the least left at its reset at the current pace (no pace in this view: Gemini's
  // weekly, 60% left, before its 5h, 70% left)
  assert.deepEqual(pick(three, "gemini weekly, claude 5h"), ["gemini.seven_day", "claude.five_hour"]);
  assert.deepEqual(pick(lib.demoResult("normal", NOW).view, "gemini"), ["gemini:Not set up"]);
  const rect = texts((await runWidget({ family: "accessoryRectangular", demo: "unsupported", parameter: "gemini", now: NOW })).widget.node);
  assert.ok(rect.some((t) => t.includes("Gemini: Not set up")), rect.join(" | "));
  const circle = texts((await runWidget({ family: "accessoryCircular", demo: "unsupported", parameter: "gemini", now: NOW })).widget.node);
  assert.ok(circle.some((t) => t.includes("Not set up")), circle.join(" | "));
});

test("Lock screen ②'s time line fits its column: a countdown keeps counting over the whole width, right-aligned; texts fitted", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const stacks = (node: any): any[] => [...(node.kind === "stack" ? [node] : []), ...node.children.flatMap(stacks)];
  const kinds = (node: any) => node.children.map((c: any) => (c.kind === "spacer" ? (c.props.length == null ? "flex" : "gap") : c.kind));
  const hours = (h: number) => new Date(now.getTime() + h * 3600000).toISOString();
  const cases: [string, any][] = [];
  for (const demo of ["runout", "three", "reached", "firstuse", "reset", "stale"]) {
    cases.push([demo, { status: 200, body: { ...lib.demoResult(demo, now).view, data_version: 1, view_version: 1 } }]);
  }
  // a weekly reset more than a day away (weekday and time), one within a day (two hour digits), and one in use without a reset time
  for (const [name, h] of [["weekday", 60], ["day", 23.5]] as const) {
    const v = structuredClone(lib.demoResult("three", now).view);
    for (const p of ["codex", "claude", "gemini"]) Object.assign(v[p].windows.seven_day, { used_percent: 97, used_percent_int: 97, remaining_percent: 3, resets_at: hours(h), rate_pace: 0 });
    cases.push([name, { status: 200, body: { ...v, data_version: 1, view_version: 1 } }]);
  }
  const u = structuredClone(lib.demoResult("three", now).view);
  for (const p of ["codex", "claude", "gemini"]) Object.assign(u[p].windows.five_hour, { used_percent: 90, used_percent_int: 90, remaining_percent: 10, resets_at: null, rate_pace: 0 });
  cases.push(["unknown", { status: 200, body: { ...u, data_version: 1, view_version: 1 } }]);
  const seen: string[] = [];
  let countdowns = 0;
  for (const [name, response] of cases) {
    for (const parameter of ["5h", "wk", "gemini, 5h"]) {
      const run = await runWidget({ family: "accessoryRectangular", parameter, response, now });
      const row = stacks(run.widget.node).find((x) => x.children.some((c: any) => c.kind === "image" && c.props.ring));
      const column = row?.children[3];
      if (!column || column.kind !== "stack") continue;
      const line = column.children.at(-1);
      const holder = line.children.find((c: any) => c.kind === "stack" && c.children.some((d: any) => d.kind === "date"));
      if (holder) {
        // the countdown: a fixed space (or none), the mark, its box; together the column's whole width, the countdown right-aligned
        countdowns++;
        const date = holder.children[0];
        const size = date.props.font.size;
        assert.ok(date.props.timer && date.props.align === "right", `${name} ${parameter}: a countdown, right-aligned`);
        assert.ok(!kinds(line).includes("flex"), "no flexible space: the whole width");
        const lead = line.children[0].kind === "spacer" ? line.children[0].props.length : 0;
        assert.ok(Math.abs(lead + size + 3 + (holder.props.size as any).w - lib.LOCK_TITLE_WIDTH) < 1e-9, `${name} ${parameter}: the whole column`);
        assert.ok(lead >= 0 && size >= 8, `${name} ${parameter}: ${size}`);
        continue;
      }
      const text = line.children.find((c: any) => c.kind === "text");
      if (!text) continue;
      const size = (text.props.font as any).size;
      seen.push(text.props.text);
      assert.equal(kinds(line)[0], "flex", "a text pushed right");
      assert.ok(size + 3 + lib.textWidth(text.props.text, size) * 0.8 <= lib.LOCK_LINE_WIDTH + 1e-9, `${name} ${parameter}: ${text.props.text} at ${size}`);
      assert.ok(size >= 8, "still readable");
    }
  }
  assert.ok(countdowns > 0, "countdowns were checked");
  assert.ok(seen.includes("First use") && !seen.includes("On first use"), `the short word: ${seen.join(" | ")}`);
  assert.ok(seen.some((t) => /^\w{3} \d{2}:\d{2}$/.test(t)), `a weekday: ${seen.join(" | ")}`);
  assert.ok(seen.includes("Unknown"), seen.join(" | "));
  // within the hour "mm:ss", else "h:mm:ss" (a wider estimate for two hour digits)
  assert.ok(lib.countdownWidth(new Date(now.getTime() + 30 * 60000), now, 12) < lib.countdownWidth(new Date(now.getTime() + 2 * 3600000), now, 12));
  assert.ok(lib.countdownWidth(new Date(now.getTime() + 2 * 3600000), now, 12) < lib.countdownWidth(new Date(now.getTime() + 20 * 3600000), now, 12));
  // the pair's columns keep their countdown as before
  const pair = await runWidget({ family: "accessoryRectangular", demo: "runout", parameter: "claude, codex, 5h", now });
  assert.ok(JSON.stringify(pair.widget.node).includes('"timer":true'), "the pair still counts down");
});

test("Lock screen ② picks the tightest limit (the least left at its reset at the current pace), never one used up; ③ follows the same order", () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const hours = (h: number) => new Date(now.getTime() + h * 3600000).toISOString();
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  // slack: what is left, less the reliable pace times the hours to the reset
  assert.ok(near(lib.lockSlack({ used_percent: 80, resets_at: hours(4), rate_pace: 3, confidence: "high" }, now), 20 - 12));
  assert.equal(lib.lockSlack({ used_percent: 80, resets_at: hours(4), rate_pace: 3, confidence: "low" }, now), 20, "a rough pace isn't used");
  assert.equal(lib.lockSlack({ used_percent: 0, resets_at: null, rate_pace: 0, confidence: "high" }, now), 100, "not used yet: all of it");
  assert.equal(lib.lockSlack({ used_percent: 30, resets_at: hours(-1), rate_pace: 30, confidence: "high" }, now), 70, "past its reset: nothing known used");
  const view = (limits: Record<string, [number, number | null]>) => {
    const v = structuredClone(lib.demoResult("three", now).view);
    for (const [p, [used, h]] of Object.entries(limits)) {
      Object.assign(v[p].windows.five_hour, { used_percent: used, used_percent_int: Math.round(used), remaining_percent: 100 - used,
        resets_at: h === null ? null : hours(h), fetched_at: now.toISOString(), ...(h === null ? { rate_pace: 0 } : {}) });
    }
    return v;
  };
  const pick = (v: any, p: string) => plain(lib.lockPicks(v, p, now).map((x: any) => x.provider));
  // the sample's paces: Codex 3, Claude 4, Gemini 3 %/hour. Claude has the least left (15%) but resets in 10 minutes (about 14 left
  // then); Codex has 20% for 4 hours (8 left then): Codex is the tighter; Gemini, 50% for an hour (47 left), the roomiest
  const timed = view({ codex: [80, 4], claude: [85, 1 / 6], gemini: [50, 1] });
  assert.deepEqual(pick(timed, "5h"), ["codex"]);
  assert.deepEqual(pick(timed, "5h, others"), ["claude", "gemini"]);
  // not used yet (100% left, no reset time): the last
  const unused = view({ codex: [30, 2], claude: [40, 3], gemini: [0, null] });
  assert.deepEqual(pick(unused, "5h"), ["claude"], "Claude: 60 less 4 x 3 = 48 left at its reset; Codex: 70 less 3 x 2 = 64");
  assert.deepEqual(pick(unused, "5h, others"), ["codex", "gemini"]);
  // used up (0% left): never ②'s while another has something left, and on ③'s right
  const used = view({ codex: [100, 2], claude: [60, 3], gemini: [20, 4] });
  assert.deepEqual(pick(used, "5h"), ["claude"]);
  assert.deepEqual(pick(used, "5h, others"), ["gemini", "codex"]);
  // all used up: the one back soonest
  const all = view({ codex: [100, 2], claude: [100, 0.5], gemini: [100, 4] });
  assert.deepEqual(pick(all, "5h"), ["claude"]);
  assert.deepEqual(pick(all, "5h, others"), ["codex", "gemini"]);
  // the circle without a provider named takes the same pick
  assert.equal(lib.lockPicks(timed, "5h", now)[0].provider, "codex");
});

test("Appearance: Auto follows the iPhone (dynamic colors), Light and Dark are fixed; one switch in Settings for every widget and the pages", async () => {
  const signedIn = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  const colors = (node: any): string[] => [...(node.kind === "text" && node.props.color ? [node.props.color] : []), ...node.children.flatMap(colors)];
  // Auto (nothing chosen): the home widget's background and texts follow the iPhone
  const auto = await runWidget({ family: "medium" });
  const bg = auto.widget.node.props.background as any;
  assert.deepEqual([bg.hex, bg.dark, bg.dynamic], [lib.WIDGET_BG.light, lib.WIDGET_BG.dark, true]);
  // Light and Dark: fixed colors
  const light = await runWidget({ family: "medium", keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "light" } });
  assert.deepEqual([(light.widget.node.props.background as any).hex, (light.widget.node.props.background as any).dynamic], [lib.WIDGET_BG.light, undefined]);
  assert.ok(colors(light.widget.node).includes("#1c1c1e") && !colors(light.widget.node).includes("#f2f2f7"), colors(light.widget.node).join(" "));
  const dark = await runWidget({ family: "medium", keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "dark" } });
  assert.equal((dark.widget.node.props.background as any).hex, lib.WIDGET_BG.dark);
  assert.ok(colors(dark.widget.node).includes("#f2f2f7") && !colors(dark.widget.node).includes("#1c1c1e"), colors(dark.widget.node).join(" "));
  // the lock screen keeps its transparent background
  const lock = await runWidget({ family: "accessoryRectangular", keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "light" } });
  assert.equal(lock.widget.node.props.background, undefined);
  // the pages: both by the iPhone for Auto, one alone otherwise
  const css = ":root{color-scheme:light dark;--text:#1c1c1e}\n@media (prefers-color-scheme:dark){:root{--text:#f2f2f7}}\nbody{}";
  assert.equal(lib.pageAppearance(css), css);
  // Settings › Appearance: Auto → Light (saved for the whole iPhone), then back to Auto (the item removed)
  const toLight = await runWidget({ family: "medium", app: { menu: [3, 1, 0, 1] } });
  assert.ok(toLight.actionLabels.includes("Appearance: Auto") && toLight.actionLabels.includes("Auto (iPhone setting) ✓"), toLight.actionLabels.join(" | "));
  assert.equal(toLight.keychain.get(lib.KEYCHAIN_APPEARANCE), "light");
  assert.ok(toLight.actionLabels.includes("Appearance: Light"), "the menu shows the new choice");
  const toAuto = await runWidget({ family: "medium", keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "dark" }, app: { menu: [3, 1, 0, 0] } });
  assert.equal(toAuto.keychain.has(lib.KEYCHAIN_APPEARANCE), false);
  // Remove all settings also removes the choice
  const removed = await runWidget({ family: "medium", keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "dark" }, app: { menu: [3, 2, 1] } });
  assert.ok(!removed.keychain.has(lib.KEYCHAIN_APPEARANCE) && !removed.keychain.has("headroom.url"), [...removed.keychain.keys()].join(" | "));
});

test("Layout guides (Settings › Display): drawn as the Home Screen widget's background, the layout as without them; off by default", async () => {
  const signedIn = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  const on = { ...signedIn, [lib.KEYCHAIN_GUIDES]: "on" };
  const response = { status: 200, body: demoBody("normal", new Date()) };
  const strip = (node: any): any => ({ kind: node.kind, props: node.props, children: node.children.map(strip) });
  for (const [family, screen, size] of [["small", 390, "158×158 pad 13"], ["medium", 390, "338×158 pad 14"], ["large", 390, "338×354 pad 16"], ["large", 430, "364×382 pad 16"]] as const) {
    const plainRun = await runWidget({ family, screen, response } as any);
    const guided = await runWidget({ family, screen, response, keychain: on } as any);
    const image = (guided.widget as any).backgroundImage;
    assert.ok(image, `${family} ${screen}`);
    // the edge, the padding's edge and the two middle lines (rectangles) and the rounded corners (a path)
    assert.equal(image.strokes, 5);
    assert.deepEqual(plain(image.texts), [`v${lib.HEADROOM_VERSION} · ${size}`]);
    assert.equal((plainRun.widget as any).backgroundImage, undefined);
    // nothing else changes: the same tree, the same background color under the guides
    assert.deepEqual(plain(strip(guided.widget.node)), plain(strip(plainRun.widget.node)), `${family} ${screen}`);
  }
  // not on the lock screen
  const lock = await runWidget({ family: "accessoryRectangular", screen: 390, response, keychain: on } as any);
  assert.equal((lock.widget as any).backgroundImage, undefined);
  // turned on and off in Settings › Display (after the appearance and the icons); off leaves no item
  const index = 1 + lib.PROVIDER_ORDER.filter((p: string) => lib.ALT_ICONS[p]).length;
  const turnedOn = await runWidget({ family: "medium", keychain: signedIn, app: { menu: [3, 1, index] } });
  assert.equal(turnedOn.keychain.get(lib.KEYCHAIN_GUIDES), "on", turnedOn.actionLabels.join(" | "));
  assert.ok(turnedOn.actionLabels.includes("Layout guides: Off"), turnedOn.actionLabels.join(" | "));
  const turnedOff = await runWidget({ family: "medium", keychain: on, app: { menu: [3, 1, index] } });
  assert.equal(turnedOff.keychain.has(lib.KEYCHAIN_GUIDES), false);
  assert.ok(turnedOff.actionLabels.includes("Layout guides: On"));
  // Remove all settings removes it too
  const removed = await runWidget({ family: "medium", keychain: on, app: { menu: [3, 2, 1] } });
  assert.equal(removed.keychain.has(lib.KEYCHAIN_GUIDES), false);
  // one that can't be read keeps neither the server nor the token (display preferences are removed apart)
  const unreadable = await runWidget({ family: "medium", keychain: on, keychainGetFailsFor: lib.KEYCHAIN_GUIDES, app: { menu: [3, 2, 1] } } as any);
  assert.deepEqual([...unreadable.keychain.keys()], [], [...unreadable.keychain.keys()].join(" | "));
  // an unfinished removal (a connection item that can't be read, the retry declined) keeps the display preferences with it
  const legacy = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz", "headroom.access_id": "id", [lib.KEYCHAIN_GUIDES]: "on", [lib.KEYCHAIN_APPEARANCE]: "dark" };
  const kept = await runWidget({ family: "medium", keychain: legacy, keychainGetFailsFor: "headroom.access_id", app: { menu: [3, 2, 1] }, answers: [0, -1] } as any);
  assert.ok(kept.alertTitles.includes("Not fully removed"), kept.alertTitles.join(" | "));
  assert.equal(kept.keychain.get(lib.KEYCHAIN_GUIDES), "on");
  assert.equal(kept.keychain.get(lib.KEYCHAIN_APPEARANCE), "dark");
  // a retry that succeeds after another run saved settings of its own (and display preferences) meanwhile: those are kept
  {
    const k = new Map<string, string>();
    saveAs(k, JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" }), JSON.stringify({ times: false }));
    k.set(lib.KEYCHAIN_GUIDES, "on");
    let failing = true;
    let questions = 0;
    const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain: Object.fromEntries(k),
      keychainRemove: (key: string) => { if (failing && key.startsWith("headroom.notify.")) throw new Error("keychain"); },
      beforeConfirm: (kc: Map<string, string>) => {
        if (++questions !== 2) return;
        // at the retry question: another run saves new settings and an appearance; the fault goes away
        saveAs(kc, JSON.stringify({ url: "https://headroom.example.com", token: "t2", id: "2222222222222222" }));
        kc.set(lib.KEYCHAIN_APPEARANCE, "dark");
        failing = false;
      } } as any);
    assert.ok(run.alertTitles.includes("Not fully removed"));
    assert.ok(!run.keychain.has("headroom.notify.1111111111111111"), "the removed settings' items are gone");
    assert.equal(JSON.parse(run.keychain.get("headroom.config.2222222222222222")!).token, "t2", "the new settings stay");
    assert.equal(run.keychain.get(lib.KEYCHAIN_APPEARANCE), "dark", "their display preferences stay");
    assert.equal(run.keychain.get(lib.KEYCHAIN_GUIDES), "on");
  }
  // the settings can't be read once the connection is gone: the display preferences are kept and the removal is unfinished; the retry
  // removes them
  {
    const k = new Map<string, string>();
    saveAs(k, JSON.stringify({ url: "https://headroom.example.com", token: "t", id: "1111111111111111" }));
    k.set(lib.KEYCHAIN_GUIDES, "on");
    let armed = false;
    let failures = 0;
    const run = await runWidget({ family: "medium", app: { menu: [3, 2, 1] }, keychain: Object.fromEntries(k),
      keychainRemove: (key: string) => { if (key.startsWith("headroom.config.")) armed = true; },
      keychainGetFailsWhen: (key: string) => armed && key === lib.KEYCHAIN_CURRENT && failures++ === 0 } as any);
    assert.ok(run.alertTitles.includes("Not fully removed"), run.alertTitles.join(" | "));
    assert.equal(failures > 0, true);
    // everything but the pointer to the current settings (it names none now: kept, as on every removal)
    assert.deepEqual([...run.keychain.keys()].filter((key) => key !== lib.KEYCHAIN_CURRENT), [], [...run.keychain.keys()].join(" | "));
  }
  // with Transparent: the guides are drawn (Scriptable's transparent style would replace the image), the widget as Auto
  const transparent = { ...on, [lib.KEYCHAIN_APPEARANCE]: "transparent" };
  const both = await runWidget({ family: "medium", screen: 390, response, keychain: transparent, systemVersion: "27.2", refreshButtons: true } as any);
  assert.equal((both.widget as any).backgroundStyle, undefined);
  assert.ok((both.widget as any).backgroundImage);
  const bg = both.widget.node.props.background as any;
  assert.deepEqual([bg.hex, bg.dark, bg.dynamic], [lib.WIDGET_BG.light, lib.WIDGET_BG.dark, true]);
  const alone = await runWidget({ family: "medium", screen: 390, response, keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "transparent" }, systemVersion: "27.2", refreshButtons: true } as any);
  assert.equal((alone.widget as any).backgroundStyle, "transparent", "without the guides, Transparent as before");
});

test("Appearance: Transparent shows the wallpaper behind Home Screen widgets on iOS 27.2 or newer, and draws as Auto before", async () => {
  const signedIn = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  const keychain = { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: "transparent" };
  const colors = (node: any): any[] => [...(node.kind === "text" && node.props.color ? [node.props.color] : []), ...node.children.flatMap(colors)];
  for (const version of ["27.2", "27.2.1", "28.0"]) {
    const run = await runWidget({ family: "medium", keychain, systemVersion: version, refreshButtons: true } as any);
    assert.equal((run.widget as any).backgroundStyle, "transparent", version);
    assert.equal(run.widget.node.props.background, undefined, "no background color over the wallpaper");
  }
  // texts as Auto (the wallpaper may be light or dark)
  const auto = await runWidget({ family: "medium", keychain: signedIn, systemVersion: "27.2", refreshButtons: true } as any);
  const shown = await runWidget({ family: "medium", keychain, systemVersion: "27.2", refreshButtons: true } as any);
  assert.deepEqual(colors(shown.widget.node), colors(auto.widget.node));
  // before iOS 27.2, with no version to read, or on a Scriptable before 1.8 (iOS 27.2 or not): as Auto, its background drawn
  for (const [version, newer] of [["27.1", true], ["26.4", true], [undefined, true], ["27.2", false], ["28.0", false]] as const) {
    const run = await runWidget({ family: "medium", keychain, ...(version ? { systemVersion: version } : {}), refreshButtons: newer } as any);
    assert.equal((run.widget as any).backgroundStyle, undefined, `${version} ${newer}`);
    const bg = run.widget.node.props.background as any;
    assert.deepEqual([bg.hex, bg.dark, bg.dynamic], [lib.WIDGET_BG.light, lib.WIDGET_BG.dark, true], `${version} ${newer}`);
  }
  // the lock screen keeps its own transparent background
  const lock = await runWidget({ family: "accessoryRectangular", keychain, systemVersion: "27.2", refreshButtons: true } as any);
  assert.equal((lock.widget as any).backgroundStyle, undefined);
  // Settings › Display › Appearance offers it, and saves it for the whole iPhone
  const chosen = await runWidget({ family: "medium", app: { menu: [3, 1, 0, 3] } });
  assert.ok(chosen.actionLabels.includes("Transparent (iOS 27.2 or newer)"), chosen.actionLabels.join(" | "));
  assert.equal(chosen.keychain.get(lib.KEYCHAIN_APPEARANCE), "transparent");
  assert.ok(chosen.actionLabels.includes("Appearance: Transparent"), "the menu shows the new choice");
});

test("Appearance on the pages: Light drops the dark colors, Dark keeps only them", async () => {
  const css = ":root{color-scheme:light dark;--text:#1c1c1e}\n@media (prefers-color-scheme:dark){:root{--text:#f2f2f7}}\nbody{}";
  const signedIn = { "headroom.url": "https://headroom.example.com", "headroom.token": "read-token-xyz" };
  const pageOf = async (mode: string) => {
    const run = await runWidget({ family: "medium", keychain: { ...signedIn, [lib.KEYCHAIN_APPEARANCE]: mode }, app: { menu: [0] } });
    return String(run.webPages.at(-1) ?? "");
  };
  const lightPage = await pageOf("light");
  assert.ok(lightPage.includes("color-scheme:light;") && !lightPage.includes("prefers-color-scheme:dark"), "light alone");
  const darkPage = await pageOf("dark");
  assert.ok(darkPage.includes("color-scheme:dark;") && !darkPage.includes("prefers-color-scheme") && darkPage.includes("--text:#f2f2f7"), "dark alone");
  void css;
});

test("events, notification titles and account switches take Gemini as the others", () => {
  const events = lib.sanitizeEvents({ last_seq: 1, events: [{ seq: 1, kind: "limit", provider: "gemini", window_id: "five_hour", created_at: NOW.toISOString() }] });
  assert.equal(events.events[0].provider, "gemini");
  assert.equal(lib.notifyTitle("gemini", "5h"), "Gemini · 5h");
  const state = (boundaries: unknown) => ({ reminders: [], told: { limits: [], warned: [] }, sent: [], boundaries, boundaries_version: null });
  // a state saved before Gemini was known: not a switch of Gemini
  assert.deepEqual(plain(lib.forgetSwitched(state({ claude: "", codex: "" }), { claude: "", codex: "", gemini: "" }).switched), []);
  assert.deepEqual(plain(lib.forgetSwitched(state({ claude: "", codex: "", gemini: "a#1" }), { claude: "", codex: "", gemini: "b#2" }).switched), ["gemini"]);
  // a stamp not known now (an earlier Worker's view) keeps the one known before
  const kept = lib.forgetSwitched(state({ claude: "", codex: "", gemini: "a#1" }), { claude: "", codex: "", gemini: null });
  assert.deepEqual(plain(kept.switched), []);
  assert.equal(kept.state.boundaries.gemini, "a#1");
});

test("the details list the providers the widget shows by default, Gemini's details-only limit among Gemini's, and a tapped one without values says why", () => {
  const html: string = lib.detailHtml({ view: threeView(), events: [], trends: {}, now: NOW });
  for (const name of ["Codex", "Claude", "Gemini"]) assert.ok(html.includes(`>${name}</h2>`), name);
  assert.ok(html.includes("Claude/GPT"), "the details-only limit is in the details");
  const two: string = lib.detailHtml({ view: lib.demoResult("normal", NOW).view, events: [], trends: {}, now: NOW });
  assert.ok(!two.includes(">Gemini</h2>"), "not listed without values");
  const tapped: string = lib.detailHtml({ view: lib.demoResult("normal", NOW).view, events: [], trends: {}, now: NOW, provider: "gemini" });
  assert.ok(tapped.includes("Not set up"));
  // and how to set it up
  assert.ok(tapped.includes(lib.esc(lib.NOT_SET_UP_HINT)), "the note under it");
  assert.ok(!two.includes(lib.esc(lib.NOT_SET_UP_HINT)), "only for the provider without values");
  // an access denial: the stop's number, as headroom status shows it; and no red limit dot from before the denial
  assert.match(lib.DENIED_HINT, /--resume-access <stop>/);
  const denied = structuredClone(threeView());
  Object.assign(denied.claude, { error_code: "access_denied", blocked: true });
  const clean = lib.sanitizeView({ ...denied, data_version: 3 });
  assert.deepEqual(plain([clean.claude.blocked, Object.keys(clean.claude.windows).length]), [null, 0]);
  const limited = structuredClone(threeView());
  limited.claude.blocked = true;
  assert.equal(lib.sanitizeView({ ...limited, data_version: 3 }).claude.blocked, true, "a limit without a denial stays");
});

test("an empty provider's details give one next step, once, only without a more specific hint or any limit (also from the saved view)", () => {
  const at = "2026-11-16T12:59:00.000Z";
  const w = (id: string, used: number, kind: "session" | "weekly") =>
    ({ id, label: id, kind, scope: null, used_percent: used, resets_at: kind === "session" ? "2026-11-16T16:00:00.000Z" : "2026-11-20T00:00:00.000Z", fetched_at: at });
  const producer = (windows: unknown[], error_code: string | null = null) => {
    const s = fixture();
    s.providers.gemini = { status: "ok", fetched_at: at, collector: "win-desktop", error: null, error_code, plan: "pro", blocked: false, history_since: null, windows } as never;
    return lib.sanitizeView({ ...toView(mergeSnapshots([s])!, NOW), data_version: 3, boundaries: { claude: "#0", codex: "#0", gemini: "" } });
  };
  const page = (view: any) => lib.detailHtml({ view, events: [], trends: {}, now: NOW, provider: "gemini" }) as string;
  const hint = lib.esc(lib.EMPTY_HINT);
  const count = (s: string, part: string) => s.split(part).length - 1;
  // default: the tapped provider without any limit shows the sentence once, beside the unchanged message and no unavailable 5h tile
  const empty = producer([]);
  assert.equal(empty.gemini.window_ids.length, 0, "the producer's confirmed-empty provider");
  const html = page(empty);
  assert.equal(count(html, "No limits to show"), 1);
  assert.equal(count(html, hint), 1);
  assert.ok(!html.includes(`<span class="name">5h limit</span>`), "no unavailable 5h tile");
  // the not-set-up branch keeps its own hint only
  const none = page({ ...empty, gemini: null });
  assert.ok(none.includes(lib.esc(lib.NOT_SET_UP_HINT)) && !none.includes(hint));
  // an access denial keeps its recovery hint and gets no generic one
  const denied = page(producer([], "access_denied"));
  assert.ok(denied.includes(lib.esc(lib.errorHint("access_denied", "gemini"))), "the denial's own hint");
  assert.ok(!denied.includes(hint) && !denied.includes("No limits to show"));
  // a weekly-only provider: its weekly tile stays, the existing unavailable 5h tile stays, and no generic sentence
  const weeklyView = producer([w("seven_day", 40, "weekly")]);
  const weekly = page(weeklyView);
  const wk = lib.atDisplayTime(weeklyView.gemini.windows.seven_day, NOW);
  assert.ok(lib.remainingText(wk).includes("60%"), lib.remainingText(wk));
  assert.ok(weekly.includes(`<span class="name">${lib.esc(lib.limitLabel(wk))}</span><b>${lib.esc(lib.remainingText(wk))}</b>`), "the weekly tile and its value");
  assert.ok(weekly.includes(`<span class="name">5h limit</span>`) && !weekly.includes(hint) && !weekly.includes("No limits to show"));
  // a populated view shows its limits without the sentence
  const full = producer([w("five_hour", 30, "session"), w("seven_day", 40, "weekly")]);
  assert.ok(!page(full).includes(hint));
  // the saved-view round trip (the fallback when a fetch fails), empty and populated: same pages, no new fields in the saved payload
  for (const [view, expectHint] of [[empty, true], [full, false]] as const) {
    const files = new Map<string, string>();
    const fm = { documentsDirectory: () => "/docs", joinPath: (a: string, b: string) => `${a}/${b}`, writeString: (p: string, t: string) => void files.set(p, t),
      readString: (p: string) => files.get(p)!, listContents: () => [...files.keys()].map((p) => p.replace("/docs/", "")), remove: (p: string) => void files.delete(p) };
    assert.equal(lib.saveCache(fm, TAG, "https://headroom.example.com", view), true);
    const saved = JSON.parse(files.get(`/docs/${lib.cacheFileName(TAG, 3)}`)!);
    assert.deepEqual(Object.keys(saved).sort(), ["origin", "saved_at", "view"]);
    assert.deepEqual(saved.view, plain(view), "the saved view is the received one");
    assert.ok(!JSON.stringify(saved).includes(lib.EMPTY_HINT), "no hint text saved");
    const loaded = lib.loadCache(fm, TAG, "https://headroom.example.com");
    assert.equal(count(page(loaded.view), hint), expectHint ? 1 : 0);
    assert.equal(page(loaded.view), page(view), "the same page from the saved view");
  }
});

test("past 50 time reminders, the earliest are planned and every one planned is read back (none rings twice)", () => {
  // 17 overall windows per provider, each running out at its own time
  const now = NOW;
  const at = (m: number) => new Date(now.getTime() + m * 60_000).toISOString();
  const provider = (k: number) => {
    const windows: Record<string, unknown> = {};
    for (let i = 0; i < 17; i++) {
      const id = `window_${300 + i * 7 + k}m`;
      windows[id] = { id, label: id, scope: null, used_percent: 90, recent_consumed_percent: null, recent_minutes: 60, recent_quality: "unknown",
        confidence: "high", fetched_at: at(0), resets_at: at(600), eta_at: null, reset_first: false, eta_minutes: null, rate_15m: null,
        rate_60m: 20 + i + k, rate_24h: 20, rate_pace: 20 + i + k };
    }
    const ids = Object.keys(windows).join(",");
    return { status: "ok", plan: null, error_code: null, main_window_ids: ids, window_ids: ids, windows };
  };
  const view = lib.sanitizeView({ view_version: 1, data_version: 1, boundaries: { claude: "", codex: "", gemini: "" }, claude: provider(0), codex: provider(1), gemini: provider(2) });
  const gen = "0123456789abcdef";
  const plan = lib.reminderPlan(view, now);
  assert.equal(plan.length, 51, "every candidate is planned");
  // at most 50 wait on the device: the earliest to ring
  const first = lib.reconcileReminders([], plan, now, gen);
  assert.equal(first.schedule.length, lib.MAX_REMINDERS);
  const latest = Math.max(...first.schedule.map((r: any) => r.fire_at));
  const left = plan.filter((r: any) => !first.schedule.some((x: any) => x.kind === r.kind && x.provider === r.provider && x.window_id === r.window_id));
  assert.equal(left.length, 1);
  assert.ok(left[0].fire_at >= latest, "the one left rings last");
  // saved and read back: every one waiting stays (so a run reading it again schedules nothing twice)
  const save = (reminders: unknown) => lib.readNotifyState(JSON.stringify({ reminders, told: { limits: [], warned: [] }, sent: [] })).reminders;
  const state = save(first.reminders);
  assert.equal(state.length, lib.MAX_REMINDERS);
  assert.equal(lib.reconcileReminders(state, lib.reminderPlan(view, now), now, gen).schedule.length, 0, "nothing scheduled again");
  // The 50 rang (no longer waiting on the device): they are records, and the one left takes a place
  const after = new Date(latest + 2 * 60_000);
  const next = lib.reconcileReminders(state, lib.reminderPlan(view, now), after, gen, new Set());
  assert.equal(next.schedule.length, 1);
  assert.equal(next.schedule[0].window_id, left[0].window_id);
  assert.equal(next.cancel.length, 0);
  // Day after day of records, the ones waiting are never dropped from the state (read back latest first)
  let records = next.reminders;
  for (let day = 1; day <= 5; day++) {
    const shifted = records.map((r: any) => ({ ...r, id: r.id.replace(/\.\d+\.x\./, `.${day}.x.`), fire_at: r.fire_at - day * 86_400_000 }));
    records = [...records, ...shifted];
  }
  const kept = save(records);
  assert.ok(kept.length <= lib.KEPT_REMINDERS);
  assert.ok(next.schedule.every((s: any) => kept.some((r: any) => r.id === s.id)), "the one waiting is read back");
});

test("a limit named still shows a provider named without values and why one has none", () => {
  const view = lib.demoResult("unsupported", NOW).view;
  const shown = (v: any, p: string) => plain(lib.groupsOf(v, p, NOW).map((g: any) => [g.provider, g.message, g.rows.length]));
  assert.deepEqual(shown(view, "gemini, 5h"), [["gemini", "Not set up", 0]]);
  assert.deepEqual(shown(view, "claude, gemini, 5h"), [["claude", null, 1], ["gemini", "Not set up", 0]]);
  // a provider whose fetch failed says so
  const failed = lib.demoResult("error", NOW).view;
  assert.deepEqual(shown(failed, "codex, claude, 5h"), [["codex", "No data", 0], ["claude", "Sign in required", 0]]);
  // a limit the provider has: no "Not available" row
  const no5h = lib.demoResult("no5h", NOW).view;
  assert.ok(!lib.groupsOf(no5h, "codex, wk", NOW)[0].rows.some((r: any) => r.kind === "missing"));
});

test("the large chart is drawn at its own size (iOS never shrinks it off the padding's edges), closer to the rows, never lower than before", async () => {
  const all = (node: any): any[] => [node, ...node.children.flatMap(all)];
  for (const screen of [320, 390, 430]) {
    const run = await runWidget({ family: "large", screen, demo: "three" });
    // the chart: the image after the legend row (Weekly usage), as wide as that row and the day labels' row
    const legend = all(run.widget.node).find((n: any) => n.children.some((c: any) => c.kind === "text" && c.props.text === "Weekly usage"));
    const parent = all(run.widget.node).find((n: any) => n.children.includes(legend));
    // Weekly usage at the provider names' size and weight; its row's height is counted in the chart's chrome
    const heading = legend.children.find((c: any) => c.kind === "text" && c.props.text === "Weekly usage");
    assert.deepEqual(plain(heading.props.font), { name: "semiboldSystemFont", size: lib.SCALES.large.name });
    assert.equal(lib.trendChrome(lib.SCALES.large), lib.TREND_GAP + lib.SCALES.large.name * 1.25 + 4 + 3 + lib.SCALES.large.small * 1.25);
    // the heading row fits across with three providers, on the smallest iPhone
    const sc = lib.SCALES.large;
    const across = lib.textWidth("Weekly usage", sc.name, true) + ["Claude", "Codex", "Gemini"].reduce((w: number, n: string, i: number) => w + (i ? 10 : 0) + 11 + lib.textWidth(n, sc.small), 0);
    assert.ok(across <= lib.widgetSize("large", { width: 320, height: 568 }).width - 2 * lib.PADDING.large, String(across));
    const chart = parent.children.find((c: any) => c.kind === "image");
    assert.ok(chart, String(screen));
    assert.equal(chart.props.resizable, false, "not shrunk by iOS");
    assert.equal(chart.props.imageSize.w, legend.props.size.w, "on the padding's edges, as wide as the legend");
    const view = lib.demoResult("three", new Date()).view;
    const layout = lib.layoutGroups(view, "large", "", new Date(), { demo: true, screen: { width: screen, height: ({ 430: 932, 390: 844, 320: 568 } as Record<number, number>)[screen] } });
    assert.ok(Math.abs(chart.props.imageSize.h - layout.trendHeight) <= 2, `${chart.props.imageSize.h} vs ${layout.trendHeight}`);
    const labels = parent.children.find((c: any) => c !== legend && c.kind === "stack" && c.children.length === 7);
    assert.equal(labels.props.size.w, chart.props.imageSize.w);
  }
  assert.equal(lib.TREND_GAP, 8);
  // never lower than before, and never past the room left (it isn't shrunk): the floor is the old room with the old gap
  const now = new Date("2026-11-16T13:05:00.000Z");
  // one row (the case that overflowed): the chart as tall as the room lets it, the lift and the refresh control giving way first
  {
    const screen = { width: 390, height: 844 };
    const l = lib.layoutGroups(lib.demoResult("normal", now).view, "large", "claude,wk", now, { screen, refresh: true });
    const room = l.size.height - 2 * l.pad - 2;
    const columns = lib.groupHeight(l.scale, l.groups[0].rows.length);
    assert.ok(columns + lib.trendChrome(l.scale) + l.trendHeight + l.refreshInside + l.lift <= room, `${columns} ${l.trendHeight} ${l.refreshInside} ${l.lift} > ${room}`);
    const before = Math.floor(room - columns * 1.1 - lib.trendChrome(l.scale) - 10);
    assert.ok(l.trendHeight >= before, `${l.trendHeight} < ${before}`);
  }
  for (const screen of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
    for (const name of ["three", "normal", "no5h", "firstuse"]) {
      for (const refresh of [false, true]) {
        const l = lib.layoutGroups(lib.demoResult(name, now).view, "large", "", now, { screen, refresh });
        if (!(l.trendHeight > lib.TREND_MIN_HEIGHT)) continue;
        const room = l.size.height - 2 * l.pad - (l.showNote ? 4 + l.scale.small * 1.25 : 0) - 2;
        const columns = Math.max(...l.groups.map((g: any) => lib.groupHeight(l.scale, g.rows.length, g.rows.length > 0 ? 0 : l.scale.label * 1.25)));
        assert.ok(columns + lib.trendChrome(l.scale) + l.trendHeight + l.refreshInside + (l.lift) <= room + 1, `${name} ${JSON.stringify(screen)} ${refresh}`);
      }
    }
  }
});

test("the refresh control: small Refresh and its symbol at the bottom right of the content, centered on the padding's edge; the rows as without it", async () => {
  const now = new Date();
  const all = (node: any): any[] => [node, ...node.children.flatMap(all)];
  const strip = (node: any): any => ({ kind: node.kind, props: { ...node.props, padding: undefined }, children: node.children.map(strip) });
  for (const [family, screen, name] of [["small", 390, "normal"], ["small", 320, "three"], ["medium", 390, "normal"], ["medium", 430, "three"], ["large", 390, "three"], ["large", 320, "normal"], ["extraLarge", 390, "normal"]] as const) {
    const response = { status: 200, body: demoBody(name, now) };
    const without = await runWidget({ family, screen, response } as any);
    const run = await runWidget({ family, screen, response, refreshButtons: true } as any);
    const where = `${family} ${screen} ${name}`;
    const pad = lib.PADDING[family];
    // its middle on the padding's edge, REFRESH_GAP under the content, where the rows leave room for it; else lower, down to its top on
    // the edge (the three stacked in the smallest small)
    const tight = family === "small" && name === "three" && screen === 320;
    const [top, left, bottom, right] = plain(run.widget.node.props.padding);
    assert.deepEqual([top, left, right], [pad, pad, pad], where);
    assert.ok(tight ? bottom < pad - lib.REFRESH_ROW / 2 && bottom >= pad - lib.REFRESH_ROW : bottom === pad - lib.REFRESH_ROW / 2, `${where}: ${bottom}`);
    assert.deepEqual(plain(without.widget.node.props.padding), [pad, pad, pad, pad], where);
    const kids = run.widget.node.children;
    const row = kids[kids.length - 1];
    assert.equal(row.props.size.h, lib.REFRESH_ROW, where);
    if (!tight && lib.REFRESH_GAP > 0) assert.deepEqual([kids[kids.length - 2].kind, kids[kids.length - 2].props.length], ["spacer", lib.REFRESH_GAP], where);
    // across: a frame of the content's width, centered as the content is, the control at its right (never past the content's edge)
    const frame = row.children.find((c: any) => c.kind === "stack");
    const heights: Record<number, number> = { 430: 932, 390: 844, 320: 568 };
    assert.equal(frame.props.size.w, lib.widgetSize(family, { width: screen, height: heights[screen] }).width - 2 * pad, where);
    assert.deepEqual(row.children.map((c: any) => c.kind), ["spacer", "stack", "spacer"], where);
    assert.equal(frame.children[0].kind, "spacer");
    // its right edge on the content's: the control ends the frame, as the providers end the large chart's legend row (of the same width)
    assert.equal(frame.children[frame.children.length - 1].props.action?.id, "refresh", where);
    if (family === "large") {
      const legend = all(run.widget.node).find((n: any) => n.children.some((c: any) => c.kind === "text" && c.props.text === "Weekly usage"));
      if (legend) assert.equal(frame.props.size.w, legend.props.size.w, where);
    }
    const above = kids.slice(0, tight || lib.REFRESH_GAP === 0 ? -1 : -2);
    // the same rows and texts above it; medium (no chart, no spreading) is drawn exactly as without it
    const words = (nodes: any[]) => nodes.flatMap(all).filter((n: any) => n.kind === "text").map((n: any) => n.props.text);
    assert.deepEqual(plain(words(above)), plain(words(without.widget.node.children)), where);
    if (family === "medium") assert.deepEqual(plain(above.map(strip)), plain(without.widget.node.children.map(strip)), where);
    // at the right: Refresh, then the symbol, small, in the gray; tapping it redraws
    const control = all(row).find((n: any) => n.props.action);
    assert.deepEqual(plain(control.props.action), { title: lib.REFRESH_TITLE, id: "refresh" }, where);
    const [text, image] = control.children.filter((c: any) => c.kind !== "spacer");
    assert.equal(text.props.text, "Refresh");
    assert.equal(text.props.font.size, lib.REFRESH_FONT);
    assert.equal(image.props.symbol, lib.REFRESH_SYMBOL);
    assert.equal(lib.REFRESH_SYMBOL, "arrow.triangle.2.circlepath");
  }
  // a fetch that failed with nothing saved: the message in the middle, Refresh at the bottom to try again (not on the lock screen)
  const failed = await runWidget({ family: "medium", response: { status: 503, body: "Service Unavailable" }, refreshButtons: true } as any);
  const fk = failed.widget.node.children;
  assert.deepEqual(fk.map((c: any) => (c.kind === "spacer" ? "flex" : c.kind)), ["flex", "text", "flex", "stack"]);
  assert.ok(all(fk[3]).some((n: any) => n.props.action?.id === "refresh"));
  assert.deepEqual(plain(failed.widget.node.props.padding), [14, 14, 14 - lib.REFRESH_ROW / 2, 14]);
  const failedLock = await runWidget({ family: "accessoryRectangular", response: { status: 503, body: "Service Unavailable" }, refreshButtons: true } as any);
  assert.ok(!all(failedLock.widget.node).some((n: any) => n.props.action));
  // a stack action that fails: no words that can't be tapped, the row left empty (the layout as with it)
  const broken = await runWidget({ family: "medium", screen: 390, response: { status: 200, body: demoBody("normal", now) }, refreshButtons: true, actionThrows: true } as any);
  const last = broken.widget.node.children[broken.widget.node.children.length - 1];
  assert.equal(last.props.size.h, lib.REFRESH_ROW);
  assert.ok(!all(last).some((n: any) => n.kind === "text" || n.kind === "image"), "no Refresh drawn");
  // not on a Scriptable without stack actions, nor in the demo, nor on the lock screen
  const response = { status: 200, body: demoBody("normal", now) };
  for (const run of [
    await runWidget({ family: "medium", response } as any),
    await runWidget({ family: "medium", demo: "normal", refreshButtons: true } as any),
    await runWidget({ family: "accessoryRectangular", response, refreshButtons: true } as any),
  ]) {
    assert.ok(!all(run.widget.node).some((n: any) => n.props.action), "no refresh control");
  }
});

test("large's lift comes only out of the room its rows leave: no row is dropped for it", () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  // A provider with more limits (its weekly copied with scopes): the rows need nearly all the height
  const scoped = (name: string) => {
    const view = plain(lib.demoResult(name, now).view);
    for (const p of ["claude", "codex", "gemini"]) {
      const pv = view[p];
      if (!pv?.windows?.seven_day) continue;
      for (const scope of ["Fable", "Sonnet", "Argon"]) {
        const id = `seven_day_${scope.toLowerCase()}`;
        pv.windows[id] = { ...pv.windows.seven_day, id, scope };
      }
      pv.window_ids = Object.keys(pv.windows);
    }
    return lib.sanitizeView(view);
  };
  // a tight case: four rows and the chart's least, with less room left for the refresh control (no row dropped for it)
  const tight = lib.layoutGroups(scoped("normal"), "large", "claude", now, { screen: { width: 375, height: 812 }, refresh: true });
  assert.equal(tight.groups[0].rows.length, 4);
  assert.ok(tight.refreshInside >= 0 && tight.refreshInside <= lib.REFRESH_ROW / 2 + lib.REFRESH_GAP, String(tight.refreshInside));
  assert.equal(tight.lift, 0, "no lift with the refresh control: the chart reaches down to it");
  const lifted = lib.layoutGroups(scoped("normal"), "large", "claude", now, { screen: { width: 375, height: 812 } });
  assert.equal(lifted.groups[0].rows.length, 4, "the same rows without it");
  assert.ok(tight.trendHeight >= lib.TREND_MIN_HEIGHT && tight.trendHeight < lib.TREND_MIN_HEIGHT + 10, String(tight.trendHeight));
  // everywhere: the rows, the chart (at its least) and the lift fit in the inside of the padding
  for (const screen of [{ width: 320, height: 568 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
    for (const name of ["normal", "firstuse", "attention", "three"]) {
      for (const parameter of ["", "claude", "codex", "gemini", "claude,gemini,most"]) {
        for (const [cached, refresh] of [[false, false], [true, false], [false, true], [true, true]]) {
          const l = lib.layoutGroups(scoped(name), "large", parameter, now, { screen, cached, refresh });
          const plainRows = lib.layoutGroups(scoped(name), "large", parameter, now, { screen, cached }).groups.map((g: any) => g.rows.length);
          assert.deepEqual(plain(l.groups.map((g: any) => g.rows.length)), plain(plainRows), "the same rows with the refresh control");
          const room = l.size.height - 2 * l.pad - (l.showNote ? 4 + l.scale.small * 1.25 : 0) - 2;
          const columns = Math.max(0, ...l.groups.map((g: any) => lib.groupHeight(l.scale, g.rows.length, g.rows.length > 0 ? 0 : l.scale.label * 1.25)));
          const chart = l.trendHeight > 0 ? lib.trendChrome(l.scale) + lib.TREND_MIN_HEIGHT : 0;
          const where = `${name} ${parameter} ${JSON.stringify(screen)} ${cached} ${refresh}`;
          assert.ok(l.lift >= 0 && l.lift <= lib.LARGE_LIFT, where);
          assert.ok(l.refreshInside >= 0 && l.refreshInside <= (refresh ? lib.REFRESH_ROW / 2 + lib.REFRESH_GAP : 0), where);
          if (refresh) assert.equal(l.lift, 0, where);
          if (!l.most) assert.ok(columns + chart + l.lift + l.refreshInside <= room + 1e-9, `${where}: ${columns} + ${chart} + ${l.lift} + ${l.refreshInside} > ${room}`);
        }
      }
    }
  }
});

test("large sits a little above the middle with its chart taller than before; small spreads its providers inside the padding", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  for (const screen of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
    for (const name of ["three", "normal", "no5h"]) {
      const view = lib.demoResult(name, now).view;
      // large: the chart takes the room left beside CHART_ROWS_MARGIN (it was 10%), with no upper bound, never lower than before
      const l = lib.layoutGroups(view, "large", "", now, { screen });
      if (l.trendHeight > 0) {
        const columns = Math.max(...l.groups.map((g: any) => lib.groupHeight(l.scale, g.rows.length)));
        const available = l.size.height - 2 * l.pad - l.lift - 2 - (l.showNote ? 4 + l.scale.small * 1.25 : 0);
        const before = Math.max(lib.TREND_MIN_HEIGHT, Math.min(320, Math.floor(available + l.lift - columns * 1.1 - lib.trendChrome(l.scale))));
        assert.equal(l.trendHeight, Math.max(before, Math.floor(available - columns * (1 + lib.CHART_ROWS_MARGIN) - lib.trendChrome(l.scale))));
        assert.ok(l.trendHeight >= before, `${name} ${JSON.stringify(screen)}: ${l.trendHeight} < ${before}`);
      }
      assert.equal(l.lift, lib.LARGE_LIFT);
      // small: more space between the providers, all still inside the padding
      const s = lib.layoutGroups(view, "small", "", now, { screen });
      if (s.groups.length >= 2) {
        const usual = s.groups.length >= 3 ? 6 : 10;
        assert.ok(s.between >= usual && s.between <= usual + lib.SMALL_SPREAD_MAX, `${name} ${JSON.stringify(screen)}: ${s.between}`);
        const used = s.groups.reduce((sum: number, g: any) => sum + lib.groupHeight(s.scale, g.rows.length, g.rows.length > 0 ? 0 : s.scale.label * 1.25), 0) + s.between * (s.groups.length - 1);
        assert.ok(used <= s.size.height - 2 * s.pad - s.lift - 2, `${name} ${JSON.stringify(screen)}: ${used}`);
      }
      // two providers with room to spare: the most more space
      if (name === "normal" && screen.width >= 390) assert.equal(s.between, 10 + lib.SMALL_SPREAD_MAX, JSON.stringify(screen));
      // medium: as it was (no spreading, centered)
      const m = lib.layoutGroups(view, "medium", "", now, { screen });
      assert.equal(m.lift, 0);
    }
  }
  // drawn: large centered with the extra space under it, small as before (2)
  const large = await runWidget({ family: "large", screen: 390, demo: "three" });
  const kinds = (node: any) => node.children.map((c: any) => (c.kind === "spacer" ? `spacer:${c.props.length ?? "flex"}` : c.kind));
  assert.deepEqual(kinds(large.widget.node), ["spacer:flex", "stack", `spacer:${lib.LARGE_LIFT}`, "spacer:flex"]);
});

test("the details page says a provider's error and what to do, also while values from before are shown", () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const view = lib.demoResult("three", now).view;
  // Gemini's fetch failed (its values from before still shown), Codex saw another account (no values)
  const failing = { ...view, gemini: { ...view.gemini, status: "stale", error_code: "fetch_failed" }, codex: { ...view.codex, status: "unavailable", error_code: "account_changed", windows: {}, window_ids: [], main_window_ids: [] } };
  const page = lib.detailHtml({ view: failing, events: null, trends: {}, now });
  const section = (name: string) => page.split("<section>").find((x: string) => x.includes(`>${name}</h2>`)) ?? "";
  assert.ok(section("Gemini").includes(lib.esc(lib.ERROR_NAMES.fetch_failed)) && section("Gemini").includes("headroom status"), "said beside the values from before");
  assert.ok(section("Gemini").includes('class="limit'), "its values still shown");
  assert.ok(section("Codex").includes(lib.esc(lib.DETAIL_ERROR_NAMES.account_changed)) && section("Codex").includes("--provider codex --accept-account"));
  // the heading doesn't state a cause the code can't tell
  assert.ok(!section("Codex").includes(lib.esc(lib.ERROR_NAMES.account_changed)));
  // no more than the code tells: see the PC's status before accepting (an acceptance starts a new history)
  assert.ok(section("Codex").includes("headroom status") && section("Codex").includes("new history"));
  assert.ok(!section("Claude").includes(lib.esc(lib.ERROR_NAMES.fetch_failed)), "nothing for one without an error");
  for (const code of Object.keys(lib.ERROR_NAMES)) assert.ok(lib.errorHint(code, "claude").length > 10, code);
  // the hint is escaped on the page
  assert.ok(!page.includes("<provider>"));
});

test("three stacked in small fit the smallest phones with a row each", () => {
  const view = lib.demoResult("three", NOW).view;
  for (const screen of [{ width: 320, height: 568 }, { width: 375, height: 667 }, { width: 390, height: 844 }]) {
    const l = lib.layoutGroups(view, "small", "", NOW, { screen });
    assert.equal(l.groups.length, 3);
    assert.ok(l.groups.every((g: any) => g.rows.length >= 1), JSON.stringify(screen));
    const used = l.groups.reduce((sum: number, g: any) => sum + lib.groupHeight(l.scale, g.rows.length), 0) + l.between * 2;
    const available = l.size.height - 2 * l.pad - l.lift - 2;
    assert.ok(used <= available, `${JSON.stringify(screen)}: ${used} > ${available}`);
  }
});

test("in a column of three, the header keeps the name and dot (the staleness text is shortened, then left out), and the labels fit", async () => {
  const now = new Date("2026-11-16T13:05:00.000Z");
  const run = await runWidget({ family: "medium", demo: "three", parameter: "codex, claude, gemini, 5h", now });
  const all = texts(run.widget.node);
  assert.equal(all.filter((x) => x === "5h limit").length, 3, all.join(" | "));
  assert.ok(!all.includes("Argon wk"), "only the limit named");
  const layout = lib.layoutGroups(lib.demoResult("three", now).view, "medium", "codex, claude, gemini, 5h", now);
  for (const x of all.filter((t) => / limit$| wk$/.test(t))) assert.ok(lib.textWidth(x, layout.scale.label) < layout.colWidth, x);
  // an old value's staleness in a column of 96pt: the name and the dot stay
  const stale = await runWidget({ family: "medium", demo: "stale", parameter: "codex, claude, gemini", now });
  const texts3 = texts(stale.widget.node);
  for (const name of ["Codex", "Claude"]) assert.ok(texts3.includes(name), texts3.join(" | "));
  assert.ok(!texts3.some((t) => /^\d+h \d+m$/.test(t)), "no two-part staleness text in a column of three");
});

test("the lock screen's line takes three providers named, and fits with their short names when it must", () => {
  const view = lib.demoResult("three", NOW).view;
  assert.equal(lib.lockPicks(view, "codex, claude, gemini", NOW, lib.MAX_PROVIDERS).length, 3);
  assert.equal(lib.lockPicks(view, "codex, claude, gemini", NOW).length, 2, "the rectangle: two");
  const items = lib.lockPicks(view, "codex, claude, gemini", NOW, lib.MAX_PROVIDERS).map((x: any) => ({ ...x, window: { ...x.window, used_percent: 100, value_status: "reset_estimated" } }));
  const line = lib.inlineText(items, true, "Demo · ", NOW);
  assert.ok(lib.textWidth(line, 11) <= lib.INLINE_WIDTH, `${line}: ${lib.textWidth(line, 11)}`);
  assert.ok(line.includes("Cx") && line.includes("Gm"), line);
});

test("a provider named by its window is drawn with its reason, and the lock screen's line fits the reasons of three", async () => {
  const named = texts((await runWidget({ family: "medium", demo: "error", parameter: "codex, wk", now: NOW })).widget.node);
  assert.ok(named.includes("Codex") && named.includes("No data") && !named.includes("No data yet"), named.join(" | "));
  const empty = texts((await runWidget({ family: "medium", response: { status: 200, body: { view_version: 1, data_version: 11, claude: null, codex: null } } })).widget.node);
  assert.deepEqual(empty, ["No data yet"], "nothing named, nothing there");
  const items = [
    { missing: true, provider: "codex", providerName: "Codex", label: "No data", short: "No data" },
    { missing: true, provider: "claude", providerName: "Claude", label: "Sign in required", short: "Sign in" },
    { missing: true, provider: "gemini", providerName: "Gemini", label: "Not set up", short: "Not set up" },
  ];
  const line = lib.inlineText(items, false, "Demo · ");
  assert.ok(lib.textWidth(line, 11) <= lib.INLINE_WIDTH, `${line}: ${lib.textWidth(line, 11)}`);
  assert.ok(line.includes("Gm N/A") && line.includes("Cl Sign in"), line);
  const off = texts((await runWidget({ family: "accessoryInline", demo: "unsupported", now: NOW })).widget.node);
  assert.ok(lib.textWidth(off[0], 11) <= lib.INLINE_WIDTH, off.join(" | "));
});
