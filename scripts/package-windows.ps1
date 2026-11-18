# Builds the Windows release package of the Headroom agent:
#   dist/headroom-<version>-windows-x64.zip and dist/headroom-<version>-windows-x64.zip.sha256
# Run on Windows with Rust (stable) and the x86_64-pc-windows-msvc target installed:
#   pwsh scripts/package-windows.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'agent/Cargo.toml'
$match = Select-String -Path $manifest -Pattern '^version = "(.+)"' | Select-Object -First 1
if (-not $match) { throw "version not found in $manifest" }
$version = $match.Matches[0].Groups[1].Value

# Fixed target and output directory, so the package never picks up binaries from another build
$target = 'x86_64-pc-windows-msvc'
$targetDir = Join-Path $root 'agent/target'
cargo build --release --locked --manifest-path $manifest --target $target --target-dir $targetDir
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
$release = Join-Path $targetDir "$target/release"

# Both executables must be x64 (PE machine type 0x8664)
function Assert-X64([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $pe = [BitConverter]::ToInt32($bytes, 0x3C)
  $machine = [BitConverter]::ToUInt16($bytes, $pe + 4)
  if ($machine -ne 0x8664) { throw ('{0} is not x64 (machine 0x{1:X4})' -f $path, $machine) }
}
foreach ($exe in 'headroom.exe', 'headroomw.exe') { Assert-X64 (Join-Path $release $exe) }

$reported = & (Join-Path $release 'headroom.exe') version
if ("$reported" -notmatch [regex]::Escape($version)) { throw "built binary reports '$reported', expected $version" }

$name = "headroom-$version-windows-x64"
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist $name
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force (Join-Path $stage 'docs') | Out-Null

Copy-Item (Join-Path $release 'headroom.exe') $stage
Copy-Item (Join-Path $release 'headroomw.exe') $stage
# Same layout as the repository, so the README link to docs/install.md works inside the package
Copy-Item (Join-Path $root 'README.md') $stage
Copy-Item (Join-Path $root 'docs/install.md') (Join-Path $stage 'docs')
$license = Join-Path $root 'LICENSE'
if (Test-Path $license) { Copy-Item $license $stage }

$zip = Join-Path $dist "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
# The archive holds one top-level folder named after the version (extract it into a new, empty folder)
Compress-Archive -Path $stage -DestinationPath $zip
Remove-Item -Recurse -Force $stage

$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
"$hash  $name.zip" | Set-Content -Encoding ascii -NoNewline "$zip.sha256"
Write-Output "Built $zip"
Write-Output "SHA-256 $hash"
