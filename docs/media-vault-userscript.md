# Media Vault (userscript)

[`media-vault.user.js`](../media-vault.user.js) is the
[Media Vault extension](../media-sniffer-ext/README.md) (v1.5.0) rebuilt as a
userscript, as close to feature parity as a userscript can get. It replaces
[Better Media Sniffer](media-sniffer.md) (`media-sniffer.user.js` 1.4.1). Install
one or the other, not both: each draws its own on-video button. If the Media
Vault extension is installed in the same browser, turn one of them off for the
same reason.

**Raw install link:**
<https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/media-vault.user.js>

## What it does

- **Detects media** from five sources (details under *How detection works*):
  fetch/XHR response headers, the browser's Performance timeline, `<video>`,
  `<audio>` and `<source>` elements, same-origin iframes, and child frames that
  report up to the top page.
- **Folds segment floods.** Hundreds of `.ts`, `.m4s` or `.aac` requests, or
  numbered fMP4 segments such as `chunk-123.mp4`, become one entry with a
  segment count and the total bytes so far.
- **Bottom sheet** (the extension's popup). The *This page* list has search,
  type, format and min-size filters that are saved between visits. Each row has
  a coloured tile, the size, host and age, and **Download · Copy · Open · Play**
  buttons. You can select several rows and use the bulk bar (Download, Copy
  URLs, Remove, All/None). The sheet also has the **Setup** and
  **Diagnostics** tabs.
- **On-video button** with a size, corner, opacity and minimum video size you
  can set. It opens the **in-page panel**, which has a **preview player** and
  Download / Player / Copy for each item.
- **Corner launcher** that shows the count. Drag it to move it (the position is
  remembered), tap it for the list, or long-press it for Setup. You can turn
  it off.
- **Open gesture**, ported from the extension: 3-finger tap by default, with 4-finger tap
  and 3-finger swipe up/down as options. It opens the sheet or the panel. It
  also works when you touch inside an iframe: the frame passes the gesture to
  the top page.
- **Download with**, the same choices as the extension: browser downloader ·
  1DM+ · 1DM · 1DM Lite · ADM · ADM Pro · app chooser · custom package. There
  is an option to copy the link to the clipboard before handing it to an app
  (1DM and ADM watch the clipboard).
- **External player** presets: system chooser, VLC, MX Player, MX Player Pro,
  Just Player, mpv, or a custom package.
- **Min-size floor** ("Ignore media smaller than") applies to the list, the
  launcher count and the on-video buttons. Unknown sizes are looked up with a
  `HEAD` request, or a 1-byte range request if the server refuses `HEAD`, both
  sent through `GM_xmlhttpRequest` with a Referer. Streams, `blob:` sources and
  folded segment groups are exempt.
- **Menu commands**: Media list · Setup · Diagnostics · Debug console ·
  Download-with cycler · toggles (on-video button, corner launcher, size
  lookups, network capture) · Test "Open in player" · Clear list. When the
  manager has `GM_unregisterMenuCommand` (XBrowser, Tampermonkey,
  Violentmonkey), the toggles show their current state and update in place,
  which mirrors them into **XBrowser's native script menu**.

## Extension vs userscript

| Feature | Extension 1.5.0 | Userscript 1.0.0 |
| --- | --- | --- |
| Requests made by page JS (fetch/XHR) | webRequest | Hooks that read the **response** Content-Type / Length / Range |
| Extensionless CDN URLs, octet-stream MP4, `mpegurl` / `dash+xml` playlists | Content-Type + URL extension | Same `classify()`, from the hooked response headers |
| Requests not made by page JS (media element, CSS, preload/prefetch) | webRequest | `PerformanceObserver` (resource, buffered): URL extension + `initiatorType`, `contentType` where the browser exposes it, body size when non-zero |
| Sizes, including `Content-Range` totals on 206 responses | Response headers | Response headers when the server exposes them to the page; otherwise a HEAD / range probe |
| Segment folding | Yes | Same rule (`.ts/.m4s/.aac/.m2ts`), plus numbered fMP4/CMAF names |
| `<video>`/`<audio>`/`<source>`, `currentSrc`, `blob:` | Content script | Yes, plus media events and same-origin iframe documents |
| Media inside cross-origin iframes | webRequest sees every frame | The script runs in every frame. Child frames send their finds to the top by `postMessage` and shared GM storage (see below) |
| Requests from the browser's media stack or service workers, and frames the manager doesn't inject into (`about:blank`, sandboxed) | webRequest | **Not visible.** The Performance timeline covers some of them; same-origin `about:blank` frames are read directly by the top page |
| Per-page cap | 300 (setting) | 300 (setting) |
| Min-size floor (list, count, buttons) | Yes | Yes |
| Popup UI | Toolbar popup / sheet / full tab | Bottom sheet in a closed Shadow DOM (centred, 620 px wide on desktop) |
| On-video button + preview panel | Yes | Yes |
| Toolbar badge with count | Yes | **No toolbar.** The draggable corner launcher shows the count |
| "All tabs" list | Yes | **No.** A userscript only sees its own page |
| Downloads | `chrome.downloads` | `GM_download` with Referer (and XBrowser `tag`) → `GM_xmlhttpRequest` blob save → plain link / new tab |
| 1DM / ADM / chooser / custom app, copy-on-send | Yes | Yes (same package ids, broad `video/*` / `audio/*` intent) |
| External player presets | Yes | Yes, plus an intent-variant tester |
| Open gesture | Sheet / panel / native popup / full tab | Sheet / panel. Frames forward the gesture |
| Toolbar popup size, load-timing diagnostics | Yes | Not applicable. Diagnostics shows manager, API, hook-mode and detection counters instead |

### What can't be ported

- **`chrome.webRequest`.** A userscript can't observe requests made by the
  browser's own media stack or by service workers, can't see frames the manager
  doesn't inject into, and only reads response headers the server exposes to
  page JS. For cross-origin responses without CORS that means Content-Type and
  Content-Length, but not Content-Range. The Performance timeline and the size
  probes fill most of that gap. They can't recover a stream that only a service
  worker fetched.
- **`chrome.downloads`.** Downloads go through the manager's `GM_download`
  (Tampermonkey may ask you to whitelist a file extension: Settings →
  Downloads), or through a `GM_xmlhttpRequest` blob save. A blob save is
  buffered in memory, so very large files belong in 1DM or ADM.
- **Toolbar badge / popup / "All tabs".** These have no userscript equivalent.
  The corner launcher and the menu commands replace them.

## Install

### Vivaldi (desktop and Android 8.2+), Chrome, Edge: Tampermonkey or Violentmonkey

1. Install **Tampermonkey** or **Violentmonkey** from the Chrome Web Store.
   Vivaldi for Android 8.2+ installs Chrome Web Store extensions too.
2. **Chromium 138+ (Vivaldi on Chromium 156 included):** userscript managers
   only run scripts once their **"Allow User Scripts"** toggle is on. Open
   `vivaldi://extensions` (or `chrome://extensions`), tap **Details** on
   Tampermonkey or Violentmonkey, and turn on **Allow User Scripts**. On older
   Chromium builds, **Developer mode** on the extensions page did the same job.
   Without the toggle, the script installs but never runs.
3. Open the raw install link above. The manager shows its install page; confirm.
4. Reload a page with a video. The corner launcher appears once media is found
   (it can be turned off in Setup).

Tampermonkey runs the script in the page world (`@sandbox JavaScript`), so the
fetch/XHR hooks see everything the page's own JS loads. On desktop,
`GM_download` saves through the browser's download manager. The Android-only
intent actions (app hand-off, external player) are hidden on non-Android
browsers. **Setup → Android app actions → Always on** forces them on.

### Firefox: Violentmonkey or Tampermonkey

Install the same way (no extra toggle). When Violentmonkey falls back to its
isolated "content" mode on a strict-CSP site, the script detects that and hooks
fetch/XHR from an injected page script instead. If the CSP blocks that script
as well, the Performance timeline still catches most media. Diagnostics shows
which mode is active.

### Via

Menu → Tools → **Userscripts** → **+** → paste the raw URL, or open it and
accept. Via does not reliably surface menu commands, so use the corner
launcher: tap it for the list, long-press it for Setup. You can also use the
3-finger tap. If downloads open the video instead of saving it, set
**Setup → Browser downloader engine → Blob save**.

### XBrowser

Open the raw link and install. The menu entries, with their on/off state,
appear in XBrowser's native script menu. **Browser downloader** uses XBrowser's
own downloader through `GM_download`, sends a Referer, and saves into
**Download subfolder (XBrowser tag)** if you set one. If XBrowser opens a file
automatically after downloading it, that is XBrowser's own "open on
completion" setting.

### ScriptCat / Quetta

Install from the raw link. The script deliberately does **not** `@grant GM_info`
(that grant blocked installs on ScriptCat/Quetta). It only reads `GM_info` if
the manager provides it anyway, for the Diagnostics line.

## How detection works

| Source | Catches | Notes |
| --- | --- | --- |
| `net` | fetch/XHR the page makes | Classified from the response Content-Type, with the URL extension as fallback. A 206 response without a readable Content-Range gives no size (that would only be the chunk length); the size probe fills it in. |
| `perf` | Every resource entry, including requests page JS never made | Uses `initiatorType` video/audio, the URL extension, and `contentType` where the browser exposes it (recent Chromium does). The body size is used for segments, and for other files only when the status is 200 and the size is non-zero (cross-origin entries without Timing-Allow-Origin report 0). |
| `dom` | `<video>`/`<audio>`/`<source>`, `currentSrc`, `blob:` | MutationObserver, capture-phase media events, a 1.5 s rescan, and same-origin iframe documents up to 3 levels deep. |
| `frame` | Everything a child frame's own sniffers find | Child frames draw no UI. They send namespaced messages (`__mv: 'mv-us-1'`, `v: 1`) to `window.top`, and the top validates the shape and every field (http/https/blob URL ≤ 4 KB, kind, extension, size, MIME). Finds are also written to GM storage under `mvf_<top page id>`, or `mvf_o_<top origin>` until the frame learns that id. The top listens with `GM_addValueChangeListener`, because some managers strip cross-origin `postMessage` to the top. |

Lists reset when the page reloads, like the extension's per-tab lists.
**Remove** in the bulk bar hides items until the next reload.

## Downloads

| Download with | What happens |
| --- | --- |
| Browser downloader, engine **Auto** | `GM_download` with `Referer` set to the page or frame the media came from. Many hosts return 403 without it, which shows up as a download stuck in the queue. XBrowser `tag` subfolder when set. If that fails or times out, a blob save via `GM_xmlhttpRequest` (Referer, progress toasts); then the plain link or a new tab. |
| Browser downloader, engine **Blob save** | Starts at the blob step (best on Via). |
| Browser downloader, engine **Plain link** | Same-origin files get an `<a download>`; anything else opens in a new tab. |
| 1DM+ / 1DM / 1DM Lite / ADM / ADM Pro / chooser / custom | `intent:<url>#Intent;action=VIEW;type=video/*;package=…;end`, launched from your tap. The type is broad (`video/*` / `audio/*`) because exact codec MIME types resolve to nothing on real devices. The link is copied first if that option is on. A bulk download copies every link and hands the first one to the app. |

Streams (`m3u8`/`mpd`): Download saves the playlist file itself. Use Copy, or
the player/app hand-off, to get the actual video. `blob:` sources can only be
previewed (and only while the page hasn't attached them to a MediaSource).

## Diagnostics

The **Diagnostics** tab, also in the menu, shows:

- the manager (if it exposes `GM_info`) and which GM APIs it provides;
- whether `unsafeWindow` is a separate object;
- the hook mode: page world through `unsafeWindow`, or an injected script when
  the manager runs us in an isolated world;
- the Performance observer state and the UI scale;
- item counts by source, segment groups, and frame reports by `postMessage` vs
  GM storage;
- the size-probe counters, and the last download path and intent.

There are buttons to **Copy** the report, open the **Debug console** (eruda
3.4.3, fetched with `GM_xmlhttpRequest` so page CSP can't block it, and run only
if its SHA-384 matches the pinned hash), and run **Test
"Open in player"**. That test fires five intent variants (package + `video/*`,
`intent://` form, system chooser, exact MIME, no type) and can make the
`intent://` form the default.

## UI notes

- Everything is drawn inside a **closed Shadow DOM** on a randomly named host
  element. Styles come from a constructed stylesheet (`adoptedStyleSheets`),
  which works under `style-src` CSP. Page CSS can't restyle it, and nothing
  page-derived is ever parsed as HTML: there is no `innerHTML` anywhere, so
  Trusted-Types pages work too.
- **Interface size → Auto**: on a phone, desktop-width pages (no viewport meta,
  980 px layout) would render the UI at about 40 %. Auto scales it by
  `innerWidth / screen.width`. You can also pick a fixed 100–200 %.
- If the page goes fullscreen on a container element, the UI moves into that
  element so it stays visible.

## Settings reference

The keys match the extension where they exist: `buttonOn`, `buttonSize`,
`buttonCorner`, `minVideoPx`, `playerPackage`, `downloadMethod`,
`downloadPackage`, `copyOnSend`, `collapseSegments`, `maxPerTab`,
`minSniffBytes`, `gesture`, `gestureTarget`. Userscript extras:

- `buttonOpacity`, `showFab`;
- `captureNetwork`, `perfObserver`, `scanFrames`, `fetchSizes`;
- `browserEngine`, `gmTag`;
- `intents` (auto/on/off), `intentFormB`, `uiScale`.

Settings are stored with `GM_setValue`, or in `localStorage` when the manager
has no storage API. When `GM_addValueChangeListener` exists, settings sync live
between open tabs.

## Debug handle

`window.__MV` (items, settings, addItem, scan, diag) is only set when the GM
value `debugApi` is `true` (set it in the userscript manager's storage editor).
Where a manager shares `window` with the page, any site could otherwise change
settings for every site or inject list items. Package names for players and
download apps are checked (letters, digits, `_` and dots) before they go into an
intent.

## Limitations

- When the GM storage fallback is used before a frame has learned the top
  page's id, frames report under the top *origin*. Two tabs of the same site,
  both with cross-origin media iframes, could then briefly see each other's
  frame items.
- Players that put `<video>` inside a **shadow root** aren't scanned as
  elements, but their network requests are still caught by the hooks and the
  Performance timeline.
- `GM_download` options differ between managers (`headers`, `tag`). The
  fallback chain handles failures, but a manager that silently ignores
  `headers` won't send the Referer.
