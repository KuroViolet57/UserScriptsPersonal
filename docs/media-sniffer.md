# Better Media Sniffer

A userscript media sniffer built for Android browsers with a built-in userscript
manager (tested against **Via Browser**, also works in Violentmonkey /
Tampermonkey). It replaces the browser's basic sniffer with an organized,
detailed media list and an on-video pop-up player.

## Why

The sniffer built into Via just dumps a list of raw links — no preview, no size,
no obvious name. You have to guess which link is the video you actually want.
This script fixes that.

## Features

- **Floating button on the video** — a play button appears in a corner of every
  real `<video>` element (size/opacity/corner configurable).
- **Pop-up player** — tapping the button opens a floating, **resizable**
  (drag the bottom-right corner) and **draggable** (drag the title bar) player
  that scales with your screen (`vw`/`vh` capped). You see exactly what you're
  about to download.
- **Organized media list** — every detected media resource with its
  **name, extension, type (video/audio) and file size**.
- **Filters** — by type (video/audio), by extension, by minimum size, and a
  name search box.
- **Three actions** on each item / in the player:
  1. **Download** — triggers a normal browser download so Via hands it to your
     selected download manager (Via internal / System / **1DM+** / **ADM**).
  2. **Open in player** — launches a third-party Android player via an
     `intent:` URL (set a default in Settings, or use the system chooser).
  3. **Copy link** — copies the direct media URL.
- **Settings page** — floating button size / opacity / corner, default
  third-party player, download method, minimum video size, and network capture
  toggles.
- **Corner launcher (FAB)** — a draggable 🎯 badge showing how many media items
  were detected. **Tap** to open the list, **long-press** to open Settings. Can
  be turned off in Settings.

## Opening Settings

Via Browser doesn't reliably surface `GM_registerMenuCommand`, so Settings is
reachable straight from the UI:

- **Long-press the 🎯 corner launcher**, or
- Open the media list and tap the **⚙️ gear** in its header.

(The `GM_registerMenuCommand` entries are still registered for managers that
support them.)

## Install (Via Browser)

1. Open **Via Browser → Menu → Tools → Userscripts** (or `Settings → Userscript`).
2. Add a new script and paste the contents of
   [`media-sniffer.user.js`](../media-sniffer.user.js), **or** open the raw file
   URL from GitHub and Via will offer to install it.
3. Reload the page. Play a video and the 🎯 launcher / on-video button appear.

> The script header requests `GM_xmlhttpRequest` with `@connect *` so it can read
> file sizes cross-origin. Via will ask you to allow this the first time.

## Downloading (important)

On Android, a plain download link to a **cross-origin** media file gets ignored
by the WebView and the video just **opens in a new tab** instead of downloading.
To avoid that, the download methods work like this:

- **Direct download (save file)** *(default)* — the script fetches the file as a
  blob (bypassing CORS) and saves it, so it actually downloads instead of opening
  a tab. Best "just works" option. Note: the whole file is buffered in memory, so
  very large files (multi-GB) are better sent to a real download manager below.
- **Send to 1DM+** / **Send to ADM** — hands the real media URL to that app via an
  android `intent:`, so 1DM+/ADM does the downloading (resumable, backgrounded).
  This is the option to use if you specifically want your download manager to
  handle it. The app must be installed.
- **Send to app (chooser)** — same, but lets Android show the app chooser.
- **Userscript (GM_download)** — downloads through the userscript manager; falls
  back to Direct download if unsupported.

> If **Direct download** ever fails (e.g. the manager can't read cross-origin
> headers), the script falls back to opening the link and shows a toast telling
> you what happened.

### Open in player

Builds `intent:<url>#Intent;action=VIEW;type=<mime>;package=<pkg>;end`. Pick your
player in Settings (MX Player, VLC, Just Player, nPlayer, Web Video Cast, or a
custom package name), or leave it on **Ask (system chooser)**.

## Notes & limitations

- **Streaming playlists (`.m3u8` / `.mpd`)** are detected and listed, but can't
  be previewed by the in-page player (Android WebView has no native HLS/DASH).
  Use **Download** or **Open in player** — external downloaders/players handle
  them.
- **`blob:` sources** (common on sites that stream via MSE) can be previewed and
  saved through the browser download, but can't be opened in an external app or
  copied as a usable link.
- The script runs in the **top frame only** (`@noframes`). Videos inside
  cross-origin iframes won't get an on-video button, but their network media is
  still often captured and shown in the list.
- Detection uses three sources: `fetch`/`XHR` interception, scanning
  `<video>/<audio>/<source>` elements, and a periodic re-scan.
