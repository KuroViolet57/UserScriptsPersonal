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

Downloads use **`chrome.downloads`** — the browser's real download manager, no
Referer/CORS tricks needed.

## What's inside

- **Popup** (violet): *This tab* / *All tabs* lists with search, type / format /
  min-size filters (persisted), colored tiles, size + host + age metadata,
  per-row **Download · Copy · Open**, multi-select with bulk download / copy.
  Badge on the toolbar icon shows the per-tab count.
- **On-video button** (content script): floating button over page videos —
  size/corner/min-size configurable — opening an in-page panel with **preview
  player**, Download, **Open in external player** (Android `intent:`, package
  configurable), Copy. `blob:`/MSE sources are listed and previewable there.
- **Setup** (cyan): button options, external player package, segment folding,
  min-size ignore threshold, per-tab cap.

## Quick access

A multi-finger **open gesture** (default: **3-finger tap**, configurable in
Setup) opens the on-page media panel directly — no toolbar trip. Pick a gesture
your phone's system doesn't already use (3-finger swipe down is often
screenshot).

## Install

1. Copy the `media-sniffer-ext/` folder (or zip it).
2. Browser → Extensions → enable Developer mode → **Load unpacked** / install
   from file.
3. Play a video, then open the popup — or tap the button on the video itself.

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
