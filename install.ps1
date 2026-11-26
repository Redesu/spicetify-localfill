param(
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root "extension.js"

if (-not (Test-Path -LiteralPath $source)) {
    throw "extension.js was not found next to install.ps1."
}

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    throw "Spicetify is not on PATH. Install it first: https://spicetify.app/docs/getting-started"
}

$userdata = ""
try {
    $userdata = (& spicetify path userdata 2>$null | Out-String).Trim()
} catch {
    $userdata = ""
}

if ([string]::IsNullOrWhiteSpace($userdata)) {
    $userdata = Join-Path $env:APPDATA "spicetify"
}

$extensionsDir = Join-Path $userdata "Extensions"
$target = Join-Path $extensionsDir "localfill.js"

New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Force

# Remove a previous entry first so repeated installs do not duplicate it.
& spicetify config extensions localfill.js- *> $null
& spicetify config extensions localfill.js | Out-Null

if ($NoRestart) {
    & spicetify apply -n | Out-Null
} else {
    & spicetify apply | Out-Null
}

Write-Host ""
Write-Host "LocalFill installed."
Write-Host "  Extension: $target"
Write-Host "  Repository: https://github.com/Redesu/spicetify-localfill"
if ($NoRestart) {
    Write-Host ""
    Write-Host "Restart Spotify manually to load the extension."
}
