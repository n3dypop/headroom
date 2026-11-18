// Builds the Scriptable script with the icons embedded.
//
//   node packages/scriptable/scripts/build.ts
//
// If packages/scriptable/icons/claude.png and codex.png exist, they are base64-encoded into ICONS in Headroom.js
// and written to packages/scriptable/dist/Headroom.js (paste this one into the iPhone). The icons are the vendors' logos, so icons/ and dist/
// are kept out of the repository (.gitignore). Without a PNG, that provider is shown with SF Symbols.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("Headroom.js", root), "utf8");
const MARKER = /^const ICONS = \{ claude: "", codex: "" \}; \/\/ @icons$/m;
if (!MARKER.test(source)) {
  console.error("ICONS line (// @icons) not found in Headroom.js");
  process.exit(1);
}

/** Size limit per icon (before base64). Large icons slow down widget loading */
const MAX_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Minimal check that the file reads as a PNG: signature, first chunk is IHDR with width and height 16-1024, last chunk is IEND.
 * Keeps broken files with only a signature from being embedded (the widget also falls back to SF Symbols if it can't read one)
 */
function checkPng(provider: string, bytes: Buffer): void {
  const fail = (why: string) => {
    throw new Error(`${provider}.png: ${why}`);
  };
  if (bytes.length > MAX_BYTES) fail(`too large (${bytes.length} B; max ${MAX_BYTES} B)`);
  if (bytes.length < 8 + 25 + 12 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail("not a PNG");
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") fail("no IHDR");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 16 || width > 1024 || height < 16 || height > 1024) fail(`dimensions out of range (${width}×${height}; 16-1024)`);
  if (bytes.toString("latin1", bytes.length - 8, bytes.length - 4) !== "IEND") fail("does not end with IEND (truncated)");
}

function icon(provider: string): string {
  const file = new URL(`icons/${provider}.png`, root);
  if (!existsSync(file)) {
    console.log(`${provider}: icons/${provider}.png not found, using SF Symbols`);
    return "";
  }
  const bytes = readFileSync(file);
  checkPng(provider, bytes);
  console.log(`${provider}: embedding ${bytes.length} B`);
  return bytes.toString("base64");
}

const icons = { claude: icon("claude"), codex: icon("codex") };
const out = source.replace(MARKER, () => `const ICONS = ${JSON.stringify(icons)};`);
mkdirSync(new URL("dist/", root), { recursive: true });
writeFileSync(new URL("dist/Headroom.js", root), out);
console.log(`dist/Headroom.js (${Buffer.byteLength(out)} B)`);
