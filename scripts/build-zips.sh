#!/usr/bin/env bash
# Rebuild the installable extension zips in dist/.
# Run from the repo root after changing either extension, before committing —
# the raw links in the READMEs serve whatever is committed here.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

# popup-size.js is shared verbatim by both extensions (boot watchdog + popup
# sizing); refuse to ship if the copies ever drift apart.
cmp -s tab-manager/popup-size.js media-sniffer-ext/popup-size.js \
    || { echo "popup-size.js differs between tab-manager/ and media-sniffer-ext/" >&2; exit 1; }

build() {
    local dir="$1" out="$2"
    rm -f "dist/$out"
    ( cd "$dir" && zip -qr "../dist/$out" . -x '*.md' )
    local v
    v=$(python3 -c "import json;print(json.load(open('$dir/manifest.json'))['version'])")
    echo "dist/$out  <-  $dir (v$v)"
}

build tab-manager tab-vault.zip
build media-sniffer-ext media-vault.zip
