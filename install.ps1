# enconvert installer for Windows — https://enconvert.com/cli
#
#   irm https://get.enconvert.com/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://get.enconvert.com/install.ps1))) -Version 1.0.0 -Yes
#
# Downloads the Windows x64 zip from GitHub Releases, verifies its sha256
# against the release checksums file, and installs to
# %LOCALAPPDATA%\enconvert\bin (override with -InstallDir or ENCONVERT_INSTALL).
# The user PATH is only modified after an explicit prompt (or -Yes).
param(
    [string]$Version = "",
    [string]$InstallDir = "",
    [switch]$Yes
)

$ErrorActionPreference = "Stop"
# GitHub requires TLS 1.2+; old Windows PowerShell defaults can be lower.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Repo = "enconvert/cli"
$LatestUrl = "https://get.enconvert.com/latest-version"

function Write-Info([string]$Message) { Write-Host "install: $Message" }
function Fail([string]$Message) { Write-Error "error: $Message"; exit 1 }

# ── resolve version: parameter > ENCONVERT_VERSION > latest pointer ───────────
if (-not $Version -and $env:ENCONVERT_VERSION) { $Version = $env:ENCONVERT_VERSION }
if (-not $Version) {
    try {
        $Version = (Invoke-RestMethod -Uri $LatestUrl -TimeoutSec 10).ToString().Trim()
    } catch {
        # Fallback: GitHub's releases/latest API (no auth needed for public repos).
        try {
            $Version = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest").tag_name
        } catch {
            Fail "could not determine the latest version; pass -Version explicitly"
        }
    }
}
$Version = $Version.TrimStart("v")

# ── resolve install dir: parameter > ENCONVERT_INSTALL > LOCALAPPDATA ─────────
if (-not $InstallDir -and $env:ENCONVERT_INSTALL) { $InstallDir = $env:ENCONVERT_INSTALL }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "enconvert" }
$BinDir = Join-Path $InstallDir "bin"

$Archive = "enconvert_${Version}_windows_x64.zip"
$BaseUrl = "https://github.com/$Repo/releases/download/v$Version"

Write-Info "installing enconvert $Version to $BinDir"

# ── download archive + checksums ──────────────────────────────────────────────
$TmpDir = Join-Path ([IO.Path]::GetTempPath()) ("enconvert-install-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $TmpDir -Force | Out-Null
try {
    $ZipPath = Join-Path $TmpDir $Archive
    $SumsPath = Join-Path $TmpDir "checksums.txt"
    try {
        Invoke-WebRequest -Uri "$BaseUrl/$Archive" -OutFile $ZipPath -UseBasicParsing
    } catch {
        Fail "download failed: $BaseUrl/$Archive — does version $Version exist?"
    }
    try {
        Invoke-WebRequest -Uri "$BaseUrl/enconvert_${Version}_checksums.txt" -OutFile $SumsPath -UseBasicParsing
    } catch {
        Fail "could not download the checksums file — refusing to install unverified binaries"
    }

    # ── verify sha256 (hard fail on mismatch) ─────────────────────────────────
    $Actual = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $ExpectedLine = Get-Content $SumsPath | Where-Object { $_ -match [regex]::Escape($Archive) } | Select-Object -First 1
    if (-not $ExpectedLine) { Fail "checksums file has no entry for $Archive" }
    $Expected = ($ExpectedLine -split "\s+")[0].ToLowerInvariant()
    if ($Actual -ne $Expected) {
        Fail "sha256 mismatch for ${Archive}: expected $Expected, got $Actual. The download may be corrupted or tampered with. Not installing."
    }
    Write-Info "checksum verified"

    # ── extract ───────────────────────────────────────────────────────────────
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $ExtractDir = Join-Path $TmpDir "extracted"
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force
    Copy-Item -Path (Join-Path $ExtractDir "enconvert.exe") -Destination (Join-Path $BinDir "enconvert.exe") -Force
    $CompletionsSrc = Join-Path $ExtractDir "completions"
    if (Test-Path $CompletionsSrc) {
        $CompletionsDst = Join-Path $InstallDir "completions"
        if (Test-Path $CompletionsDst) { Remove-Item -Recurse -Force $CompletionsDst }
        Copy-Item -Recurse -Path $CompletionsSrc -Destination $CompletionsDst
    }
    # Record how enconvert got here so `enconvert upgrade` can delegate.
    Set-Content -Path (Join-Path $InstallDir "install-method") -Value "install-script" -NoNewline

    Write-Info "installed: $(Join-Path $BinDir 'enconvert.exe')"
} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}

# ── PATH handling: ask first, only touch the USER PATH, never the machine ─────
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $UserPath) { $UserPath = "" }
$OnPath = ($UserPath -split ";" | Where-Object { $_ -eq $BinDir }).Count -gt 0

if ($OnPath) {
    Write-Info "run 'enconvert --help' to get started"
} else {
    $DoAdd = $Yes
    if (-not $DoAdd) {
        $Answer = Read-Host "Add $BinDir to your user PATH? [y/N]"
        $DoAdd = $Answer -match "^[Yy]"
    }
    if ($DoAdd) {
        [Environment]::SetEnvironmentVariable("Path", ($UserPath.TrimEnd(";") + ";" + $BinDir), "User")
        Write-Info "added to user PATH — open a NEW terminal for it to take effect"
    } else {
        Write-Host ""
        Write-Host "  $BinDir is not on your PATH. Add it later with:"
        Write-Host "  [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$BinDir', 'User')"
        Write-Host ""
    }
}
