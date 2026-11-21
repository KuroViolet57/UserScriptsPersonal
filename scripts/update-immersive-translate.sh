#!/usr/bin/env bash
# Refresh vendor/immersive-translate/ with the newest official Immersive
# Translate release (Chrome zip, Firefox zip, userscript) from its GitHub
# releases. Usage: scripts/update-immersive-translate.sh [vX.Y.Z]
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=immersive-translate/immersive-translate
TAG="${1:-}"
if [ -z "$TAG" ]; then
    # The releases/latest redirect names the newest tag without needing the API.
    TAG=$(curl -sSIL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" | sed 's#.*/tag/##')
fi
V="${TAG#v}"
case "$V" in ''|*/*) echo "could not resolve the latest tag (got '$TAG'); pass one, e.g. v1.35.4" >&2; exit 1;; esac
OUT=vendor/immersive-translate
TMP=$(mktemp -d)
for f in "chrome-immersive-translate-$V.zip" "firefox-immersive-translate-$V.zip" immersive-translate.user.js; do
    echo "fetching $f"
    curl -fsSL -o "$TMP/$f" "https://github.com/$REPO/releases/download/$TAG/$f"
done
unzip -p "$TMP/chrome-immersive-translate-$V.zip" manifest.json | grep -q "\"version\": *\"$V\"" \
    || { echo "chrome zip manifest is not version $V" >&2; exit 1; }
grep -q "@version *$V" "$TMP/immersive-translate.user.js" \
    || { echo "userscript is not version $V" >&2; exit 1; }
rm -f "$OUT"/chrome-immersive-translate-*.zip "$OUT"/firefox-immersive-translate-*.zip
mv "$TMP"/* "$OUT"/
rmdir "$TMP"
( cd "$OUT" && sha256sum ./*.zip immersive-translate.user.js )
echo "Updated to $V — update the version/date/checksums in $OUT/README.md"
