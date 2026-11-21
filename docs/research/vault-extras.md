# Prior art for Tab Vault and Media Vault (2026-11-21)

Checked with `gh api repos/<repo>` on 2026-11-21 and greps of this repo at commit 89868ea.

| Idea | Prior art | What it does there | Already in the Vaults? |
| --- | --- | --- | --- |
| Interval auto-save snapshots of every window | [sienori/Tab-Session-Manager](https://github.com/sienori/Tab-Session-Manager) (MPL-2.0, 2494 stars, pushed 2026-08-17); logic in `src/background/autoSave.js` | Saves the whole browser state on a timer and on window close, keeps the last N, restore any of them | No: Tab Vault captures closed windows/tabs, no timed snapshots (grep for autosave / alarms found none) |
| Save an HLS stream as one file in the browser | [chandler-stimson/live-stream-downloader](https://github.com/chandler-stimson/live-stream-downloader) (MPL-2.0, 382 stars, pushed 2026-11-10) | Reads the .m3u8, fetches every segment, joins them into one local file | No: Media Vault lists the playlist and hands it to 1DM/ADM/player; no #EXTINF / #EXT-X-STREAM-INF parsing in the code |
| Find and close duplicate tabs | [Peuj/duplicate-tabs-closer](https://github.com/Peuj/duplicate-tabs-closer) (GPL-3.0, 231 stars, pushed 2026-11-02) | Detects tabs with the same URL (options: ignore hash/query), closes or focuses the older one | No dedicated feature found (grep for duplicate/dedupe only hits import de-duplication) |
| Hand a found link to the Command Center app | Own app: the owner's Command Center Android app (its manifest) | Registers action the app's own `…action.DOWNLOAD` and VIEW for `video/*` and `application/x-mpegurl` with label "Download with AuraFiles" | No: Media Vault's download apps are 1DM+, 1DM, 1DM Lite, ADM, ADM Pro, chooser, custom (`media-vault.user.js:146-154`) |

## How the prior art does the hard parts (read 2026-11-21)

**Tab Session Manager** (`src/background/autoSave.js`, MPL-2.0):
- Timed snapshot via `browser.alarms.create("autoSaveRegular", { periodInMinutes })`, re-created when the interval setting changes.
- Skips a snapshot when nothing changed (`isChangedAutoSaveSession`), keeps the last N (`removeOverLimit("regular", limit)`).
- Optional name from the active tab's title (`useTabTitleforAutoSave`).
- "When the browser exits": a `temp` session is refreshed 1.5 s after tab changes and kept as `browserExit` at next start.
- Chrome alarms fire at most once a second and may be delayed (alarms API docs, read 2026-11-21).

**live-stream-downloader** (`v3/`, MPL-2.0, MV3):
- Each download is a job in its own extension page (`v3/data/job/index.html`), not in the service worker.
- Parses HLS/DASH with `m3u8-parser.js` / `mpd-parser.js`, fetches segments in parallel (`mget/mget.js`), decrypts AES-128 (`mget/plugins/decrypt.js`), handles fMP4 with `mp4box.all.js`.
- Writes to disk with the File System Access API plus `file-picker-polyfill.js` (for browsers without `showSaveFilePicker`).
- Permissions: storage, contextMenus, webRequest, declarativeNetRequestWithHostAccess, declarativeContent, scripting, alarms.
  A fetch from an extension page is a renderer request, so a DNR rule can set Referer/Origin for segment fetches
  (unlike `chrome.downloads`, which Chromium hides from extensions).
