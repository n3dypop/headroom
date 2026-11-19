#!/usr/bin/env bash
# Builds the macOS release package of the Headroom agent (Apple silicon only; Intel Macs are not supported):
#   dist/headroom-<version>-macos-arm64.tar.gz and dist/headroom-<version>-macos-arm64.tar.gz.sha256
# Run on a Mac with Xcode Command Line Tools and Rust (rustup) installed:
#   rustup target add aarch64-apple-darwin
#   scripts/package-macos.sh
# The binaries get an ad-hoc signature only (not notarized), so install them with curl, not a browser.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$root/agent/Cargo.toml"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$manifest" | head -n 1)"
[ -n "$version" ] || { echo "version not found in $manifest" >&2; exit 1; }

target="aarch64-apple-darwin"
if command -v rustup >/dev/null 2>&1 && ! rustup target list --installed | grep -qx "$target"; then
  echo "Rust target $target is not installed. Run: rustup target add $target" >&2
  exit 1
fi

# Fixed target and output directory, so the package never picks up binaries from another build
target_dir="$root/agent/target"
cargo build --release --locked --manifest-path "$manifest" --target "$target" --target-dir "$target_dir"

name="headroom-$version-macos-arm64"
dist="$root/dist"
stage="$dist/$name"
rm -rf "$stage"
mkdir -p "$stage/docs"

for bin in headroom headroomw; do
  cp "$target_dir/$target/release/$bin" "$stage/$bin"
  lipo "$stage/$bin" -verify_arch arm64
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
