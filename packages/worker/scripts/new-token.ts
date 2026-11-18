// Creates a per-device credential. The token is stored only on the device; only a hash entry is added to the Worker secret TOKENS.
//
//   node packages/worker/scripts/new-token.ts read iphone
//   node packages/worker/scripts/new-token.ts write mac        # use the PC name (collector_id) as the name
//
// The token is shown only once. Store it in Scriptable's Keychain on the iPhone, and in the OS credential store on a PC.
import { webcrypto } from "node:crypto";
import { COLLECTOR_NAME, sha256Hex } from "../src/auth.ts";

const [role, name] = process.argv.slice(2);
if ((role !== "read" && role !== "write") || !name || !COLLECTOR_NAME.test(name)) {
  console.error("Usage: node packages/worker/scripts/new-token.ts <read|write> <name (lowercase letters, digits, -)>");
  process.exit(2);
}

const bytes = webcrypto.getRandomValues(new Uint8Array(32));
const token = Buffer.from(bytes).toString("base64url");
const entry = role === "write"
  ? { name, sha256: await sha256Hex(token), role, collector: name }
  : { name, sha256: await sha256Hex(token), role };

console.log(`Token (store it on ${name}; it can't be shown again):\n  ${token}\n`);
console.log("Line to add to the TOKENS array:");
console.log(`  ${JSON.stringify(entry)}`);
