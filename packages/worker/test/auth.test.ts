// Worker credentials (auth.ts): token parsing and bearer authentication
import assert from "node:assert/strict";
import { test } from "node:test";
import { authenticate, MAX_COLLECTORS, parseTokens, sha256Hex, type TokenEntry } from "../src/auth.ts";

const SECRET = "fixture-secret-token-0123456789";
const OTHER = "another-fixture-token-9876543210";

async function entries(): Promise<TokenEntry[]> {
  return [{ name: "iphone", sha256: await sha256Hex(SECRET), role: "read" }];
}
const req = (auth?: string) => new Request("https://example.test/", auth === undefined ? {} : { headers: { authorization: auth } });

test("parseTokens: undefined, invalid JSON and non-arrays yield no tokens", () => {
  assert.deepEqual(parseTokens(undefined), []);
  assert.deepEqual(parseTokens("{not json"), []);
  assert.deepEqual(parseTokens('{"a":1}'), []);
});

test("parseTokens: drops malformed entries and normalises hashes", async () => {
  const h = await sha256Hex(SECRET);
  const raw = JSON.stringify([
    null,
    "str",
    { name: "a", sha256: "short", role: "read" },
    { name: 1, sha256: h, role: "read" },
    { name: "w", sha256: h, role: "write" },
    { name: "w", sha256: h, role: "write", collector: "Bad Name" },
    { name: "x", sha256: h, role: "admin" },
    { name: "r", sha256: h.toUpperCase(), role: "read" },
    { name: "w", sha256: h, role: "write", collector: "mac" },
  ]);
  assert.deepEqual(parseTokens(raw), [
    { name: "r", sha256: h, role: "read" },
    { name: "w", sha256: h, role: "write", collector: "mac" },
  ]);
});

test("parseTokens: too many collectors fails closed", async () => {
  const h = await sha256Hex(SECRET);
  const make = (n: number) =>
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ name: `n${i}`, sha256: h, role: "write", collector: `pc${i}` })));
  assert.equal(parseTokens(make(MAX_COLLECTORS)).length, MAX_COLLECTORS);
  assert.deepEqual(parseTokens(make(MAX_COLLECTORS + 1)), []);
});

test("authenticate: missing credentials returns null", async () => {
  assert.equal(await authenticate(req(), await entries()), null);
});

test("authenticate: malformed bearer values are rejected", async () => {
  const t = await entries();
  for (const h of ["", "Basic abc", `Bearer ${SECRET} extra`, "Bearer short", `Bearer ${"a".repeat(513)}`, `bearer ${SECRET}`]) {
    assert.equal(await authenticate(req(h), t), null, h);
  }
});

test("authenticate: well-formed but wrong credential is denied", async () => {
  assert.equal(await authenticate(req(`Bearer ${OTHER}`), await entries()), null);
  assert.equal(await authenticate(req(`Bearer ${SECRET}`), []), null);
});

test("authenticate: valid credential returns its entry (first match wins)", async () => {
  const t = await entries();
  const dup: TokenEntry = { name: "dup", sha256: t[0]!.sha256, role: "read" };
  assert.equal(await authenticate(req(`Bearer ${SECRET}`), [...t, dup]), t[0]);
});
