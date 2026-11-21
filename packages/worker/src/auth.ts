// Worker credentials. The entry point is a single workers.dev host; Cloudflare Access is not used.
//
// The secret TOKENS holds a JSON array of each device's credential SHA-256 (hex) and role. The tokens themselves are not stored.
//   [{"name":"iphone","sha256":"…","role":"read"},
//    {"name":"mac","sha256":"…","role":"write","collector":"mac"}]
// read allows GET only; write allows only PUT to its own collector. PCs get no read permission.

export type Role = "read" | "write";

export interface TokenEntry {
  name: string;
  sha256: string;
  role: Role;
  /** For write: the PC name it may write to (collector_id) */
  collector?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
export const COLLECTOR_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Reads TOKENS. Malformed entries are dropped (fail closed: no credential gets through) */
export function parseTokens(raw: string | undefined): TokenEntry[] {
  let list: unknown;
  try {
    list = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const entries = list.flatMap((t): TokenEntry[] => {
    if (typeof t !== "object" || t === null) return [];
    const { name, sha256, role, collector } = t as Record<string, unknown>;
    if (typeof name !== "string" || typeof sha256 !== "string" || !HEX64.test(sha256.toLowerCase())) return [];
    if (role === "read") return [{ name, sha256: sha256.toLowerCase(), role }];
    if (role === "write" && typeof collector === "string" && COLLECTOR_NAME.test(collector)) {
      return [{ name, sha256: sha256.toLowerCase(), role, collector }];
    }
    return [];
  });
  // At most MAX_COLLECTORS writing PCs (bounds how many per-PC rows one upload writes at once).
  // A config over the limit is treated as an error and no credential is accepted (so it gets noticed)
  const collectors = new Set(entries.flatMap((e) => (e.role === "write" ? [e.collector] : [])));
  return collectors.size > MAX_COLLECTORS ? [] : entries;
}

/** Max number of writing PCs (the owner's PCs only) */
export const MAX_COLLECTORS = 16;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function equalConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The credential matching `Authorization: Bearer <token>`, or null (compares against every entry) */
export async function authenticate(request: Request, tokens: readonly TokenEntry[]): Promise<TokenEntry | null> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([\x21-\x7e]{16,512})$/.exec(header);
  if (!match?.[1]) return null;
  const hash = await sha256Hex(match[1]);
  let found: TokenEntry | null = null;
  for (const t of tokens) {
    if (equalConstantTime(hash, t.sha256) && found === null) found = t;
  }
  return found;
}

/** Protocol of the agents that may write (header Headroom-Protocol). Older agents are refused with 426 */
export const AGENT_PROTOCOL = "2";
