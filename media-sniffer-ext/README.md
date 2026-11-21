# Media Vault

The [media sniffer userscript](../docs/media-sniffer.md) rebuilt as a proper
browser extension — same idea, drastically better coverage. Sibling of
[Tab Vault](../tab-manager/), same visual language.

## Why the extension catches what the userscript missed

A userscript only sees what the page's own JavaScript loads (patched
`fetch`/XHR) plus `<video>` elements in the top frame. Everything else slipped
through. The extension's background worker observes **`chrome.webRequest`** —
every response the browser receives, no matter who asked for it:

| Slipped through the userscript | Caught now, and how |
| --- | --- |
| Extensionless CDN URLs (`/stream/vfile?id=99`) | Classified by **Content-Type header**, not URL guessing |
| MP4s served as `application/octet-stream` | Header + URL extension cross-check |
| Media inside cross-origin **iframes** | webRequest sees all frames' traffic |
| Requests from the browser's own media stack / service workers | Same |
| HLS/DASH playlists with no extension | Content-Type (`mpegurl` / `dash+xml`) |
| File sizes (needed extra HEAD probes) | Read from response headers; `Content-Range` totals for 206 partials |
| Hundreds of `.ts`/`.m4s` segment requests flooding the list | **Folded** into one entry with a segment count + accumulated bytes |

Downloads use **`chrome.downloads`** — the browser's real download manager. It
cannot send a Referer (its headers are limited to what XMLHttpRequest allows),
so a host that only serves its own pages answers 401/403: Media Vault then
shows a notice on the page pointing to **Download with** 1DM / ADM or **Open in
player**.

## What's inside

- **Popup** (violet): *This tab* / *All tabs* lists with search, type / format /
  min-size filters (persisted), colored tiles, size + host + age metadata,
  per-row **Download · Copy · Open**, multi-select with bulk download / copy.
  Badge on the toolbar icon shows the per-tab count.
- **On-video button** (content script): floating button over page videos —
  size/corner/min-size configurable — opening an in-page panel with **preview
  player**, Download, **Open in external player** (Android `intent:`, package
  configurable), Copy. `blob:`/MSE sources are listed and previewable there.
- **Setup** (cyan): button options, **Downloads → Download with** (browser
  downloader · 1DM+ · 1DM · 1DM Lite · ADM · ADM Pro · app chooser · custom
  package), external player presets (VLC, MX Player, Just Player, mpv, custom),
  segment folding, min-size ignore threshold, per-tab cap.

## Quick access

A multi-finger **open gesture** (default: **3-finger tap**, configurable in
Setup) opens the media UI directly — no toolbar trip. **"Gesture opens"**
chooses the target: **bottom sheet** (the full Media Vault UI sliding over the
page — default), the compact on-page panel, the browser's native popup sheet
(where supported), or the full-page manager tab. Pick a gesture
your phone's system doesn't already use (3-finger swipe down is often
screenshot).

The Setup **"Ignore media smaller than (MB)"** floor now applies everywhere —
list, panel and badge — including items whose size is only learned later
(missing sizes are resolved with a HEAD probe). Streams and `blob:` sources are
exempt since their size can't be known.

## Install

1. **Easiest:** open the prebuilt zip link on the phone —
   <https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/dist/media-vault.zip> — it downloads ready to install.
   (Or copy the `media-sniffer-ext/` folder and zip it yourself.)
2. Browser → Extensions → enable Developer mode → **Load unpacked** / install
   from file. On **Vivaldi** (Android 8.2+ or desktop): unzip to a permanent
   folder, Load unpacked from it on `vivaldi://extensions`, and for updates
   extract the new zip over that folder and tap **Update**.
3. Play a video, then open the popup — or tap the button on the video itself.

## What changed in 1.7.0

- **No detections lost when the worker wakes** (several arriving at once used
  to overwrite each other), and settings are read once instead of per hit.
- **Reload clears the tab's list**; a `#hash` change keeps it. Lists from the
  previous browser session are dropped at startup.
- **Stored per tab**, and only the tabs that changed are written.
- **Playlists re-polled with new query strings stay one row** (newest URL);
  extensionless `video/mp2t` / `video/iso.segment` segments and named fMP4
  segments (`seg-12.mp4`) fold into one row.
- **Remove** in the bulk bar really removes rows; search and filters no longer
  re-ask the worker on every keystroke.
- **Embedded players**: the content script runs in iframes too (their own
  on-video button; ad frames stay idle until they hold media).
- Page-found media gets a clean file name with an extension; a 206 response
  without a known total no longer shows the chunk size; package names are
  checked before they go into an intent; the popup page is only reachable
  through the per-session dynamic URL.

## Vivaldi 8.3 / 8.4 notes (Media Vault 1.6.0)

| Vivaldi change | Effect on Media Vault |
| --- | --- |
| **8.3 Android: extensions run in Private tabs** (VAB-13631) | Media from private tabs is kept in `chrome.storage.session` (memory only, gone when the browser closes) and never written to disk. Setup → Detection → **Ignore private tabs** skips them entirely. Allow it under the extension's details → *Allow in Incognito/Private*. |
| **8.3 Android: download location prompt fixed** (VAB-13554 — 8.2 always asked) | Setup → Downloads → **Ask where to save** (off by default) controls the browser downloader's save-as dialog. |
| **8.3 Android: extensions install with an external download manager enabled** (VAB-13693) | You can keep 1DM/ADM as Vivaldi's download handler and still install/update the zip. |
| **8.3 Android: runtime host-permission prompts work** (VAB-13594, VAB-13671) | Setup → Diagnostics shows site access; if Media Vault is switched off for some sites, **Allow on all sites** asks again (from the full page). |
| **8.3 Android: "Open in app" keeps the tab open** (VAB-13928, VAB-1720) | Handing a link to 1DM/ADM/VLC through an `intent:` no longer costs you the page. |
| **8.4: `action.getUserSettings().isOnToolbar`** (VB-125404) | Setup shows whether the icon is pinned to the toolbar. |

## Updating

The manifest pins the extension ID via a `key`
(`cnengdbbojabibofckbdilpdjjdbiajb`), so from v1.1.1 on, installing a newer zip
updates in place instead of creating a second copy. If you update from a
pre-key version, remove the old copy afterwards — Media Vault's data is
per-tab detections plus settings, so there is nothing precious to migrate.

## Notes & limits

- Streams (`m3u8`/`mpd`): "Download" fetches the playlist file itself; feed it
  to 1DM/VLC (Copy → paste, or the external-player button) for the actual video.
- `blob:` URLs live only inside their page — preview them via the on-page panel;
  they can't be downloaded directly by any tool.
- Per-tab lists reset on page reload (matching the browser's own sniffers);
  close of a tab drops its list.
- `chrome.downloads` may be missing on some Android forks — the popup then falls
  back to opening the file in a tab so the browser's downloader can take it.
- The detected-media store is capped per tab (default 300, configurable).
- **Popup slow or blank on an unpacked install** (Vivaldi 8.2): the styles are
  now inlined into `media.html` (one file fewer to read per open, never an
  unstyled popup), a spinner shows while `media.js` loads, and a **Reload**
  banner appears if it fails to load. Setup → Diagnostics → **Load timing**
  prints per-file load times, failures and time to first render. A stale
  `media.css` left in the folder is harmless.
- **Downloads: browser vs apps.** "Browser downloader" uses the browser's own
  download manager. Any app choice hands the *direct* link to that app through
  an Android `intent:` (broad `video/*` / `audio/*` type — exact codec MIMEs
  resolve to nothing on real devices). Android only lets a page launch an app
  from a tap, so: from the on-video panel and the bottom sheet the page does
  it directly; from the toolbar popup the page is asked to launch it, and if
  the page can't (internal pages, the full-page manager) a tap-to-open link
  appears. The link is also copied to the clipboard first (toggle in Setup) —
  1DM and ADM watch the clipboard and offer the download on their own. Bulk
  downloads to an app copy all links and hand over the first one.
