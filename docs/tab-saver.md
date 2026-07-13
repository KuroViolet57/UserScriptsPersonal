# Via Tab Saver / Session Exporter

Works around Via Browser's missing tab management: it lets you review the pages
open across all your tabs and **export them to a bookmarks file, JSON, or the
clipboard**.

## The important caveat (read this)

A userscript is **sandboxed to its own page** — it genuinely cannot read the
browser's open-tab list or write to Via's bookmarks directly. There is no API
for that.

This script gets the same result a different way: `GM_setValue` storage is
**shared across every tab and site**, so the script records each page it runs on
into **one shared list**. Open the manager from any tab and you see every page
logged across all your tabs, then export them.

Consequences:

- **Tabs opened *before* you installed the script won't appear** until you focus
  or reload each one once (the script has to run inside a tab to log it). Going
  forward, logging is automatic.
- The list is "pages seen", deduplicated by URL. A **Recently active (~open)**
  filter approximates your currently-open tabs using a heartbeat (pages seen
  within the configurable "active" window).

## Features

- **Auto-logs** every page you open (URL, title, first/last seen, visit count).
- **Manager UI** (📑 corner button, or userscript menu): search, filter
  (All / Recently active / Pinned), checkboxes, pin, open, remove.
- **Export**:
  - **Bookmarks.html** — standard Netscape format, importable into Via's
    bookmarks (Settings → Bookmarks → Import) or any browser.
  - **JSON** — full data with timestamps.
  - **Copy URLs** — newline-separated to the clipboard.
- If nothing is checked, export/copy acts on **everything currently shown** (so
  you can filter, then export all). Check specific rows to export just those.
- **Settings**: auto-log toggle, heartbeat toggle, "active" window (minutes),
  max entries, corner-button toggle, and a URL exclude list.

## Install (Via Browser)

1. **Menu → Tools → Userscripts**, add a new script, paste
   [`via-tab-saver.user.js`](../via-tab-saver.user.js) (or open the raw file and
   let Via install it).
2. Browse as usual. Tap the 📑 button (bottom-left) any time to manage/export.

> Needs `GM_setValue` (Via supports it). That shared storage is what makes the
> cross-tab list work — a `localStorage` fallback would only see one site at a
> time.

## Opening Settings

Like the media sniffer, Settings is reachable without relying on Via's menu:

- **Long-press the 📑 corner button**, or
- Open the manager and tap the **⚙️ gear** in its header.

## Typical use: "save all my open tabs to bookmarks"

1. Make sure the script has run in each tab (it does automatically as you open
   them; for pre-existing tabs, flick through them once).
2. Tap 📑 → optionally set filter to **Recently active (~open)**.
3. Tap **⭐ Bookmarks.html** → the file downloads.
4. Import it: Via **Settings → Bookmarks → Import** (or open it in any browser's
   bookmark importer).

## Notes

- "Open" (↗) on a row opens that URL in a new tab; opening many at once may be
  blocked by the browser — export/import is the reliable way to restore a set.
- The `pagehide`/`visibilitychange` events used to timestamp tabs are best-effort
  on mobile; the list still captures the page on load regardless.
