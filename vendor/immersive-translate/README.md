# Immersive Translate (vendored copy)

An unmodified copy of the official **Immersive Translate** release, kept here
so it's at hand when testing browsers. It isn't my code.

- **Version:** 1.35.4 (the official repo's `dist` was updated 2026-11-20)
- **Source:** <https://github.com/immersive-translate/immersive-translate/releases/tag/v1.35.4>
- **Website:** <https://immersivetranslate.com/>
- **License:** proprietary freeware. The vendor says the project is not open
  source; their GitHub repo only hosts release builds. All rights belong to
  Immersive Translate.

| File | Use it for | SHA-256 |
| --- | --- | --- |
| `chrome-immersive-translate-1.35.4.zip` | Vivaldi, Chrome, Edge, Brave (Load unpacked) | `59f146a7bbc86b267f05339c29f430ccdf99cd319a42b33224da3500ff584554` |
| `firefox-immersive-translate-1.35.4.zip` | Firefox (temporary add-on) | `0130b112ee640c16118965d425099f6684337d8f48d61f95beaa29f69031a6c2` |
| `immersive-translate.user.js` | Any userscript manager (Tampermonkey, Violentmonkey, ScriptCat, Via, XBrowser…) | `25af8fe6f87582b2fdf120d033b98acc834725fe7aeda652fc05fd9308b8023f` |

The checksums match the files on the official release page, downloaded on
2026-11-21.

## Which one to install

**Vivaldi (Android 8.2+ or desktop):** the easiest way is the Chrome Web
Store, because Vivaldi installs from it directly and keeps the extension
updated. Search for *Immersive Translate*, or open
<https://chrome.google.com/webstore/detail/bpoadfkcbjbfhfodiogcnhhhpibjhbnh>.
On Android, keep *Desktop site* turned on for the store page. To use the zip
in this folder instead:

1. Unzip `chrome-immersive-translate-1.35.4.zip` to a folder you'll keep,
   for example `Download/extensions/immersive-translate/`.
2. Open `vivaldi://extensions`, turn on **Developer mode**, then tap **Load
   unpacked** and pick the folder that contains `manifest.json`.
3. To update, extract a newer zip over the same folder and tap **Update**.

Don't run the store copy and the unpacked copy at the same time, or pages
get translated twice.

**Any browser with a userscript manager:** open the raw
`immersive-translate.user.js` link below and the manager offers to install
it. Its `@updateURL` points at the official download server, so after that
it updates itself.

<https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/vendor/immersive-translate/immersive-translate.user.js>

On Chromium 138 or newer (Vivaldi 8.x included), Tampermonkey and
Violentmonkey need the **Allow User Scripts** toggle turned on. It's on the
manager's details page (`vivaldi://extensions` → Details).

**Firefox:** go to `about:debugging#/runtime/this-firefox`, choose **Load
Temporary Add-on**, and pick the Firefox zip. A temporary add-on is removed
when Firefox restarts, so for everyday use install it from addons.mozilla.org.

## Refreshing this copy

```bash
scripts/update-immersive-translate.sh          # newest release
scripts/update-immersive-translate.sh v1.35.4  # a specific tag
```

The script downloads all three files from the official GitHub release and
checks the version inside them. After running it, update the version and
checksums in this README.
