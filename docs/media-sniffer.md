# Better Media Sniffer

A userscript media sniffer built for Android browsers with a built-in userscript
manager (tested against **Via Browser** and **XBrowser**, also works in
Violentmonkey / Tampermonkey). It replaces the browser's basic sniffer with an
organized, detailed media list and an on-video pop-up player.

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
  name search box. Filters are **persistent** (saved across page reloads) and
  apply everywhere: the list, the corner-launcher count, **and** the on-video
  buttons. Set a minimum size and small thumbnail previews stop showing buttons —
  handy on sites full of preview clips.
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

On **XBrowser** you also get the full set of entries in the native script menu
(open list, open settings, cycle download method, and toggles for corner
button / fetch sizes / network capture).

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
The download methods avoid that:

- **GM download (manager + Referer)** — uses `GM_download`, adding a **`Referer`
  header** (the page URL). Many media hosts use hotlink protection and return
  403 without it, which shows up as a download **stuck in the queue** — the
  Referer fixes that. On **XBrowser** this is the default and recommended method;
  it hands the file to XBrowser's own downloader. Falls back to Direct on error.
- **Direct download (blob save)** — fetches the file as a blob (bypassing CORS,
  now also with a Referer header) and saves it. Default on **Via**. The file is
  buffered in memory, so multi-GB files are better sent to a manager below.
- **Send to 1DM+** / **Send to ADM** — hands the real URL to that app via an
  android `intent:` (resumable, backgrounded). The app must be installed.
- **Send to app (chooser)** — same, but Android shows the app chooser.

> Each method falls back gracefully (GM → Direct → open link) and shows a toast
> telling you what happened.

### XBrowser notes

- Set **Download method → GM download** (it's the default on XBrowser; a one-time
  tip reminds you if your carried-over setting was something else).
- **Download subfolder (tag)**: XBrowser's `GM_download` supports a `tag` that
  saves into a named subfolder — set it in Settings (e.g. `Videos`).
- If XBrowser **auto-opens a file after it downloads**, that's an XBrowser
  setting (Downloads → open on completion), not something the script controls.
- The settings toggles are mirrored into **XBrowser's native script menu** — tap
  the menu entries to flip *Corner button*, *Fetch file sizes*, *Network
  capture*, or to cycle the *Download method* without opening the panel.
  (Network-capture changes take effect on the next page load.)

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
