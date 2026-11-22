// Gemini in the core: windows shown in details only, and what they don't hold back
import assert from "node:assert/strict";
import { test } from "node:test";
import { judgeEvents, toView, type Snapshot } from "../src/index.ts";

const NOW = new Date("2026-11-16T13:00:00.000Z");
const win = (id: string, used: number, scope: string | null) => ({
  id, label: id, kind: id.includes("five") ? "session" : "weekly", scope, used_percent: used,
  resets_at: "2026-11-20T00:00:00.000Z", fetched_at: NOW.toISOString(),
}) as Snapshot["providers"]["claude"] extends infer P ? P extends { windows: (infer W)[] } ? W : never : never;

function snapshot(windows: ReturnType<typeof win>[], blocked: boolean | null = false): Snapshot {
  return {
    schema_version: 2, generated_at: NOW.toISOString(),
    providers: { gemini: { status: "ok", fetched_at: NOW.toISOString(), collector: "pc", error: null, error_code: null, plan: "pro", blocked, history_since: null, windows } },
    collectors: [{ id: "pc", generated_at: NOW.toISOString(), received_at: NOW.toISOString() }],
  };
}

const judge = (s: Snapshot, pending: string[] = []) =>
  judgeEvents(toView(s, NOW), { cycles: {}, errors: {}, blocked: {}, stopped: false, judged_at: null }, { last_received_at: NOW.toISOString() }, NOW,
    { pending, boundaries: { claude: "", codex: "", gemini: "" } });

test("a window shown in details only waiting for its derived values doesn't hold back Argon's limit; Argon itself waiting does", () => {
  const s = snapshot([win("seven_day", 20, null), win("seven_day_argon", 100, "Argon"), win("partner_seven_day", 50, "Claude and GPT")]);
  const told = (r: ReturnType<typeof judge>) => r.events.filter((e) => e.visible && e.body.kind === "limit").map((e) => e.body.window_id);
  assert.deepEqual(told(judge(s, ["gemini.partner_seven_day"])), ["seven_day_argon"]);
  assert.deepEqual(told(judge(s, ["gemini.seven_day_argon"])), [], "its own derived values behind: it waits");
});

test("the view keeps a window shown in details only out of the top window, the main windows and the status text", () => {
  const v = toView(snapshot([win("partner_seven_day", 100, "Claude and GPT")], true), NOW);
  assert.equal(v.gemini?.top, null);
  assert.equal(v.gemini?.main_window_ids, "");
  assert.equal(v.gemini?.windows.partner_seven_day?.detail_only, true);
  const judged = judge(snapshot([win("partner_seven_day", 100, "Claude and GPT")], true));
  assert.equal(judged.events.filter((e) => e.body.provider === "gemini" && e.body.kind === "limit" && e.body.window_id === "partner_seven_day").length, 0);
});
