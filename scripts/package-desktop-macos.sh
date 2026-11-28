#!/usr/bin/env bash
# Builds the macOS desktop client's release package (the notch and the menu bar item, a preview; Apple silicon):
#   dist/headroom-desktop-<version>-macos-arm64.tar.gz and dist/headroom-desktop-<version>-macos-arm64.tar.gz.sha256
# <version> is the release's (agent/Cargo.toml). Run on a Mac with Xcode or the Xcode Command Line Tools:
#   scripts/package-desktop-macos.sh
# The binary gets an ad-hoc signature only (not notarized), so download it with curl, not a browser (see docs/install.md).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/agent/Cargo.toml" | head -n 1)"
[ -n "$version" ] || { echo "version not found in agent/Cargo.toml" >&2; exit 1; }

package="$root/clients/macos"
swift build -c release --arch arm64 --package-path "$package"
bin="$(swift build -c release --arch arm64 --package-path "$package" --show-bin-path)/HeadroomBar"

name="headroom-desktop-$version-macos-arm64"
dist="$root/dist"
stage="$dist/$name"
rm -rf "$stage"
mkdir -p "$stage/docs"

cp "$bin" "$stage/HeadroomBar"
lipo "$stage/HeadroomBar" -verify_arch arm64
codesign --force --sign - "$stage/HeadroomBar"

cp "$root/README.md" "$stage/"
cp "$root/docs/install.md" "$stage/docs/"
if [ -f "$root/LICENSE" ]; then cp "$root/LICENSE" "$stage/"; fi

# One top-level folder named after the version
tarball="$dist/$name.tar.gz"
rm -f "$tarball"
tar -C "$dist" -czf "$tarball" "$name"
rm -rf "$stage"

(cd "$dist" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
echo "Built $tarball"
cat "$tarball.sha256"
