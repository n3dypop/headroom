#!/usr/bin/env bash
# Builds the macOS release package of the Headroom agent (universal: Apple silicon + Intel):
#   dist/headroom-<version>-macos-universal.tar.gz and dist/headroom-<version>-macos-universal.tar.gz.sha256
# Run on a Mac with Xcode Command Line Tools and Rust (rustup) installed:
#   rustup target add aarch64-apple-darwin x86_64-apple-darwin
#   scripts/package-macos.sh
# The binaries get an ad-hoc signature only (not notarized), so install them with curl, not a browser.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$root/agent/Cargo.toml"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$manifest" | head -n 1)"
[ -n "$version" ] || { echo "version not found in $manifest" >&2; exit 1; }

# Fixed output directory, so the package never picks up binaries from another build
target_dir="$root/agent/target"
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  cargo build --release --locked --manifest-path "$manifest" --target "$t" --target-dir "$target_dir"
done

name="headroom-$version-macos-universal"
dist="$root/dist"
stage="$dist/$name"
rm -rf "$stage"
mkdir -p "$stage/docs"

for bin in headroom headroomw; do
  lipo -create -output "$stage/$bin" \
    "$target_dir/aarch64-apple-darwin/release/$bin" \
    "$target_dir/x86_64-apple-darwin/release/$bin"
  lipo "$stage/$bin" -verify_arch arm64 x86_64
  codesign --force --sign - "$stage/$bin"
done

reported="$("$stage/headroom" version)"
case "$reported" in
  *"$version"*) ;;
  *) echo "built binary reports '$reported', expected $version" >&2; exit 1 ;;
esac

# Same layout as the repository, so the README link to docs/install.md works inside the package
cp "$root/README.md" "$stage/"
cp "$root/docs/install.md" "$stage/docs/"
if [ -f "$root/LICENSE" ]; then cp "$root/LICENSE" "$stage/"; fi

# The archive holds one top-level folder named after the version (extract it into a new, empty folder)
tarball="$dist/$name.tar.gz"
rm -f "$tarball"
tar -C "$dist" -czf "$tarball" "$name"
rm -rf "$stage"

(cd "$dist" && shasum -a 256 "$name.tar.gz" > "$name.tar.gz.sha256")
echo "Built $tarball"
cat "$tarball.sha256"
