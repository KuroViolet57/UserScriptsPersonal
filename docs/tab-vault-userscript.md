# Tab Vault (userscript)

[`tab-vault.user.js`](../tab-vault.user.js) is the [Tab Vault extension](../tab-manager/README.md)
rebuilt as a userscript, for browsers and setups where you'd rather install a
script than an extension. It replaces the older
[Via Tab Saver](tab-saver.md) (`via-tab-saver.user.js`). The two can be
installed side by side, but they keep separate data. To carry the old list
over, export JSON from Tab Saver and import it here; it lands in **History**.

It uses the extension's look (same colours, cards, nav and bottom sheet), its
JSON export/import format, and its two-gesture quick access. Where a userscript
can't do what the extension does, it gets as close as a script inside the page
can, and the UI says what's approximated.

## Why some things are approximations

A userscript runs **inside one page**. It can't list the browser's tabs, read
its tab groups or history, or create, move or unload tabs. What it does have is
`GM_setValue` storage that every tab and every site share. So each tab running
the script writes itself into one shared registry, and the manager reads that
registry from any tab. That's the same trick Tab Saver used, done more carefully.

## Extension vs userscript

| Feature | Extension | Userscript | How / why |
| --- | --- | --- | --- |
| **Open**: list of open tabs | Real (`tabs.query`) | **Approximated** | Each tab registers an id, URL, title, favicon and a heartbeat. With Tampermonkey's `GM_getTabs`, TM decides which tabs are open. Otherwise a tab counts as open until it unloads, or until it has been silent for the *lost contact* window (default 60 min). |
| Tabs opened before install | Listed | Listed once visited | The script has to run in a tab before it can register it. |
| Tap a row to switch to that tab | Always works | **Best effort** | The target tab calls `window.focus()`. It works where the manager grants `window.focus` (Tampermonkey, Violentmonkey). It also reports back, so you're told when the browser ignored the request. |
| Close a tab (✕, bulk close) | Always works | **Best effort** | The target tab calls `window.close()` and reports *closed / refused / no answer*. Browsers refuse it for tabs the script didn't open, unless the manager grants `window.close` (TM/VM do). Tabs asleep in the background can't answer. |
| Windows | Grouped by window | Not available | Window ids are invisible to page scripts. Everything appears as one list. |
| Search, multi-select, long-press range select, select all | ✓ | ✓ | Same code. |
| **Groups** | Real `chrome.tabGroups` + saved groups | **Tab Vault groups only** | A script can't see or change native groups. Tab Vault groups (name + the same 9 colours) store their tabs in the script. You can add to them from Open, History, Closed or Saved, then restore, edit, export or delete them. They use the extension's `savedGroups` format. |
| **Closed** tabs | Captured by `tabs.onRemoved` | **Approximated** | See [closed detection](#how-closed-detection-works). Newest first; reopen one or bulk-reopen. |
| Closed **windows** | Captured | Imported only | Closed windows from an extension export are shown and can be reopened (as tabs), saved or forgotten. The script can't capture new ones. |
| **History** | Browser history (`history.search`) | **Pages Tab Vault has seen** | A log of every page the script ran on (URL, title, first/last seen, visit count), capped at 1000 by default. It has the same Today / Yesterday / 7 d / 30 d / pick-a-day / all-time filter and the same *between … and …* time-of-day window (wraps past midnight). |
| **Saved** sessions | ✓ | ✓ | Save a selection or the whole Open list. Restore all at once or in batches. Export `bookmarks.html` (Netscape format), session JSON, or copy URLs. |
| Restore without popup blocking | `tabs.create`, never blocked | `GM_openInTab` | Opens with `{active:false, insert:true}`. Without `GM_openInTab` it falls back to `window.open`, and blocked tabs are counted in the final toast. |
| Restore tabs *unloaded* (discarded) | ✓ | Not available | Scripts can't discard tabs. Use batches (size + delay in Setup) for big restores, and keep the restoring tab in front until it finishes. |
| Write to native bookmarks | `chrome.bookmarks` | Not available | Export `bookmarks.html` and import it in the browser. |
| JSON export / import / paste | ✓ | ✓ **compatible** | See [data](#data--json-compatibility). |
| Settings, caps, diagnostics | ✓ | ✓ | Setup → Capabilities lists the script handler + version, which GM APIs exist, how cross-tab updates arrive, where the tab id came from, and how much data is stored. |
| Two configurable gestures | Content script | ✓ ported | 3-/4-finger tap, 3-finger swipe up/down, each opening either the **full manager** (bottom sheet) or the **current-group switcher**. *Native browser sheet* and *full-page tab* targets don't exist for a script. |
| Current-group switcher | Native group of the tab | Tab Vault group(s) containing this page | When several groups contain the page, chips switch between them. If none does, the full manager opens on Groups. |
| Toolbar button | ✓ | **Corner launcher** + menu | Draggable button with a live-tab count. Tap opens the manager, long-press opens Setup. The position is remembered across sites, and the button can be turned off. The manager's script menu has *Tab Vault*, *Current group switcher*, *Tab Vault setup* and *Toggle corner button*. |
| Dark theme | Dark only | Dark only | The extension ignores `prefers-color-scheme`, so the port does too. |

## How Open works

- Every tab gets a **tab id**. Under Tampermonkey (and any manager with
  `GM_getTab`/`GM_saveTab`) the id lives in TM's per-tab object, so it survives
  cross-site navigation and is never copied into a duplicated tab. Otherwise it
  lives in `sessionStorage`, which survives reloads and same-site navigation. If
  a duplicated tab shares an id with its original, the two notice and split.
- Each tab writes its entry when it loads, on SPA URL or title changes, when it
  becomes visible or hidden, and as a **heartbeat** (default every 20 s while
  visible, 3× slower in the background). Writes are debounced, so a tab writes
  about once per heartbeat. Entries are capped at 250 tabs.
- Other tabs see the change at once through `GM_addValueChangeListener`. Without
  it, the open manager polls every few seconds.
- Row badges: **this tab**, **● active** (visible and heard from recently),
  **● open**, or *last heard 12m ago* (probably asleep in the background).
  **TM ✓** means Tampermonkey confirms the tab is open.

## How closed detection works

1. On `pagehide` with `persisted=false`, the tab marks its entry as *gone*.
   A bfcache `pagehide` (`persisted=true`), a link click, a form submit, or a
   page-started navigation (Navigation API) is treated as a **navigation** and
   just removes the entry.
2. If the same tab id re-registers within **N seconds** (default 10, set
   *Closed after* in Setup), it was a reload, and nothing is filed. A new page
   whose `document.referrer` matches a just-gone page is also treated as that
   tab navigating.
3. Otherwise any running tab files the page under **Closed** (newest first,
   duplicates by source skipped, capped by *Keep closed tabs*).
4. A tab silent for longer than *Lost contact after* is filed as **lost
   contact — may still be open**. Android freezes background tabs and sometimes
   kills them without any event, so this is how those tabs are recovered. If such
   a tab wakes up, it removes its own Closed entry.
5. With **Tampermonkey's `GM_getTabs`**, steps 1–4 give way to TM's answer: a tab
   that leaves TM's list is closed, and one still in it is open.

Known false positives without TM's tab API: typing a new address or opening a
bookmark in an existing tab looks like a close, since the old page can't tell
where the tab went. You'll see an extra Closed entry; tick it and tap Forget.

## Data & JSON compatibility

**Export JSON** writes:

```json
{ "exportedAt": "…", "source": "tab-vault-userscript", "version": "1.0.0",
  "sessions": [ { "id", "name", "savedAt", "tabs": [ { "url", "title" } ] } ],
  "savedGroups": [ { "id", "name", "color", "savedAt", "tabs": [ … ] } ],
  "closedWindows": [ … ], "closedTabs": [ { "id", "closedAt", "url", "title", "favIconUrl" } ],
  "pages": [ { "url", "title", "firstSeen", "lastSeen", "visits" } ] }
```

- That's the extension's export format plus a `pages` list. The **extension can
  import the userscript's file** (it ignores `pages`), and the **userscript
  imports the extension's file**.
- Import is **additive**, using the extension's rules: existing entries win, and
  duplicates are skipped by `id`, falling back to the same content keys the
  extension uses. Importing the same backup twice adds nothing.
- The old **Tab Saver** JSON (a bare array) imports into History.
- **Paste JSON** and **Copy JSON** are there for browsers whose file picker or
  downloads are unreliable (common on Android).
- Data lives in the manager's script storage. Uninstalling the script usually
  deletes it, so export first.

## Install

The `@downloadURL`/`@updateURL` point at:
<https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/tab-vault.user.js>.
Open that link with a userscript manager installed and it offers to install.

### Tampermonkey or Violentmonkey on Vivaldi (desktop)

1. Install the manager from the Chrome Web Store (Vivaldi uses it directly).
2. **Chromium 138 and newer** (current Vivaldi) only run user scripts when the
   manager's per-extension **Allow User Scripts** toggle is on. Open
   `vivaldi://extensions`, click **Details** on Tampermonkey (or Violentmonkey),
   and switch on **Allow User Scripts**. On older builds, turn on
   **Developer mode** at the top right of `vivaldi://extensions` instead.
3. Open the raw link above and click **Install**.
4. Reload any tabs that were already open, or just visit them once. They join
   the Open list the first time the script runs in them.

### Vivaldi on Android (8.2+, Chromium-based)

Vivaldi Android 8.2+ installs extensions from the Chrome Web Store.

1. Open the Chrome Web Store page for **Tampermonkey** (or Violentmonkey) in
   Vivaldi and tap **Add to Vivaldi**.
2. Open `vivaldi://extensions` → **Details** on the manager → turn on
   **Allow User Scripts** (Chromium 138+). Older builds need **Developer mode**
   on that page instead.
3. Open the raw link above and install.
4. The **corner button** (bottom-left, draggable) opens the manager. The default
   gesture is a **3-finger swipe up**; change it, or add a second one for the
   group switcher, under **Setup → Quick access**.

### Chrome / Edge / Firefox

Install Tampermonkey or Violentmonkey from the browser's store. On Chrome/Edge
138+, turn on **Allow User Scripts** in the manager's details page (or
Developer mode on older versions). Firefox needs no extra toggle. Then open the
raw link. Greasemonkey 4 (promise-only `GM.*` API) isn't supported.

### Via / XBrowser / ScriptCat (Quetta)

- **Via:** Menu → Tools → **Userscripts** → **+** and paste the file, or open the
  raw link and let Via install it.
- **XBrowser:** open the raw link (it recognises `.user.js`), or add it from
  XBrowser's script manager. Menu names vary between versions.
- **ScriptCat / Quetta:** open the raw link, or add a new script and paste it.
  The script deliberately doesn't `@grant GM_info`, because that grant broke
  installs there. `GM_info` is read without a grant.

These managers often lack `GM_addValueChangeListener` or the tab APIs. The
script then polls (remote commands every 1.5 s, the open manager every 3 s) and
uses the heartbeat registry. Check **Setup → Capabilities** to see what your
manager provides. With no `GM_setValue` at all, it falls back to `localStorage`,
which only covers the current site. The Open tab warns you when that happens.

If a manager rejects the `@grant window.close` / `@grant window.focus` lines,
delete those two lines. Everything else works the same; remote close and focus
just get refused more often.

## Settings (Setup)

| Setting | Default | Notes |
| --- | --- | --- |
| List this tab under Open | on | Off: this browser's tabs stop registering. |
| Heartbeat | 20 s | 15–120. Hidden tabs heartbeat 3× slower. |
| Lost contact after | 60 min | Silent tabs leave Open and are filed under Closed as *lost contact*. |
| Keep a History log / size | on / 1000 | 50–5000 pages, oldest dropped. |
| Never track URLs containing | — | Substrings, comma- or line-separated. Matching pages are never registered or logged. |
| Show site icons | on | Favicons come from the page's declared icon, loaded with no referrer. |
| Capture closed tabs / Closed after / Keep closed tabs | on / 10 s / 300 | |
| Batch size / delay | 10 / 3 s | For restores of more than 10 tabs (you choose batches or all at once). |
| Corner button, gestures | on, 3-finger swipe up → manager, 2nd off | Same options as the extension, minus the targets a script can't reach. |

Also in Setup: Export / Copy / Import / Paste JSON, Clear closed, Clear
History, **Rebuild open-tab list** (empties the registry, and every running tab
re-registers within a heartbeat), and **Capabilities** with a copy button.

## Notes

- The UI lives in a **closed Shadow DOM**, so page CSS can't restyle it.
  Keystrokes typed into it don't reach page shortcuts, for example YouTube's
  `k`/`f`. On phones it undoes the zoom-out of desktop-only sites, so the sheet
  stays finger-sized.
- Titles and URLs from pages are always inserted as text, never as HTML.
- Everything stays in your userscript manager's storage. Nothing is sent
  anywhere.
- Opening many tabs: keep the restoring tab in front until the progress bar
  finishes. Background tabs get their timers throttled.
