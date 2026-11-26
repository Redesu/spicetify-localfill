param(
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command spicetify -ErrorAction SilentlyContinue)) {
    throw "Spicetify is not on PATH."
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

$target = Join-Path (Join-Path $userdata "Extensions") "localfill.js"

& spicetify config extensions localfill.js- *> $null

if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Force
}

if ($NoRestart) {
    & spicetify apply -n | Out-Null
} else {
    & spicetify apply | Out-Null
}

Write-Host "LocalFill removed. Stored audio mappings were left in Spotify's app storage."
