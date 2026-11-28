# Builds the Windows desktop client's release package (the notch and the tray icon, a preview):
#   dist/headroom-desktop-<version>-windows-x64.zip and dist/headroom-desktop-<version>-windows-x64.zip.sha256
# <version> is the release's (agent/Cargo.toml). Run on Windows with Rust (stable) and the x86_64-pc-windows-msvc target:
#   pwsh scripts/package-desktop-windows.ps1
# The provider icons are built in only when packages/scriptable/icons/ has them (never in the published package: the rings show
# letters, and the icons can be added as described in docs/install.md)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$match = Select-String -Path (Join-Path $root 'agent/Cargo.toml') -Pattern '^version = "(.+)"' | Select-Object -First 1
if (-not $match) { throw 'version not found in agent/Cargo.toml' }
$version = $match.Matches[0].Groups[1].Value

$manifest = Join-Path $root 'clients/windows/Cargo.toml'
$target = 'x86_64-pc-windows-msvc'
$targetDir = Join-Path $root 'clients/windows/target'
cargo build --release --locked --manifest-path $manifest --target $target --target-dir $targetDir
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
$exe = Join-Path $targetDir "$target/release/headroom-desktop.exe"

# x64 (PE machine type 0x8664)
$bytes = [System.IO.File]::ReadAllBytes($exe)
$pe = [BitConverter]::ToInt32($bytes, 0x3C)
$machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
if ($machine -ne 0x8664) { throw ('{0} is not x64 (machine 0x{1:X4})' -f $exe, $machine) }

$name = "headroom-desktop-$version-windows-x64"
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist $name
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage 'docs') | Out-Null

Copy-Item $exe $stage
Copy-Item (Join-Path $root 'README.md') $stage
Copy-Item (Join-Path $root 'docs/install.md') (Join-Path $stage 'docs')
$license = Join-Path $root 'LICENSE'
if (Test-Path $license) { Copy-Item $license $stage }

$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# One top-level folder named after the version
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
"$hash  $name.zip" | Set-Content -Encoding ascii -NoNewline "$zip.sha256"
Write-Output "Built $zip"
Write-Output "SHA-256 $hash"
