// Read the shared fixture (fixtures/snapshot/) from TS too, and check merging doesn't change the values.
// The Rust side reads the same file in agent/tests/snapshot_fixture.rs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { emptyProvider, makeWindow, mergeSnapshots, SCHEMA_VERSION, type Snapshot } from "../src/index.ts";

const load = async (name: string): Promise<Snapshot> =>
  JSON.parse(await readFile(new URL(`../../../fixtures/snapshot/${name}`, import.meta.url), "utf8"));

test("fixtures/snapshot/v2-basic.json: merging it alone doesn't change provider values", async () => {
  const snap = await load("v2-basic.json");
  assert.equal(snap.schema_version, SCHEMA_VERSION);
  const merged = mergeSnapshots([snap]);
  assert.deepEqual(merged?.providers, snap.providers);
  assert.equal(merged?.generated_at, snap.generated_at);
});

test("fixtures/snapshot/v2-basic.json: both Claude and Codex have all common fields", async () => {
  const snap = await load("v2-basic.json");
  const keys = Object.keys(emptyProvider("ok", null)).sort();
  const windowKeys = Object.keys(makeWindow("five_hour", 0, null)).sort();
  for (const id of ["claude", "codex"] as const) {
    assert.deepEqual(Object.keys(snap.providers[id] ?? {}).sort(), keys, id);
    for (const w of snap.providers[id]?.windows ?? []) {
      assert.deepEqual(Object.keys(w).sort(), windowKeys, w.id);
      assert.ok(!w.id.includes("."));
    }
  }
});
