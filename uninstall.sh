#!/usr/bin/env bash
set -euo pipefail

if ! command -v spicetify >/dev/null 2>&1; then
    echo "Spicetify is not on PATH." >&2
    exit 1
fi

USERDATA="$(spicetify path userdata 2>/dev/null | head -n 1 || true)"
if [[ -z "$USERDATA" ]]; then
    USERDATA="${XDG_CONFIG_HOME:-$HOME/.config}/spicetify"
fi

spicetify config extensions localfill.js- >/dev/null 2>&1 || true
rm -f "$USERDATA/Extensions/localfill.js"
spicetify apply >/dev/null

echo "LocalFill removed. Stored audio mappings were left in Spotify's app storage."
