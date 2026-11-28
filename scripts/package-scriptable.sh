#!/usr/bin/env bash
# Puts the iPhone widget (the Scriptable script) in the release: dist/Headroom.js and dist/Headroom.js.sha256.
# The file keeps its name, which Scriptable shows as the script's name.
#   scripts/package-scriptable.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/packages/scriptable/Headroom.js"
grep -Eq '^const HEADROOM_VERSION = [0-9]+;' "$src" || { echo "HEADROOM_VERSION not found in $src" >&2; exit 1; }

dist="$root/dist"
mkdir -p "$dist"
cp "$src" "$dist/Headroom.js"
(cd "$dist" && sha256sum --text Headroom.js > Headroom.js.sha256)
echo "Built $dist/Headroom.js (widget version $(sed -n 's/^const HEADROOM_VERSION = \([0-9]*\);/\1/p' "$src"))"
cat "$dist/Headroom.js.sha256"
