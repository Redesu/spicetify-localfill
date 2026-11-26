#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$ROOT/extension.js"

if [[ ! -f "$SOURCE" ]]; then
    echo "extension.js was not found next to install.sh." >&2
    exit 1
fi

if ! command -v spicetify >/dev/null 2>&1; then
    echo "Spicetify is not on PATH. Install it first: https://spicetify.app/docs/getting-started" >&2
    exit 1
fi

USERDATA="$(spicetify path userdata 2>/dev/null | head -n 1 || true)"
if [[ -z "$USERDATA" ]]; then
    USERDATA="${XDG_CONFIG_HOME:-$HOME/.config}/spicetify"
fi

mkdir -p "$USERDATA/Extensions"
cp "$SOURCE" "$USERDATA/Extensions/localfill.js"

# Remove a previous entry first so repeated installs do not duplicate it.
spicetify config extensions localfill.js- >/dev/null 2>&1 || true
spicetify config extensions localfill.js >/dev/null
spicetify apply >/dev/null

echo
echo "LocalFill installed."
echo "  Extension: $USERDATA/Extensions/localfill.js"
echo "  Repository: https://github.com/Redesu/spicetify-localfill"
echo
echo "If Spotify did not restart automatically, restart it manually."
