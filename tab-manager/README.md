# Tab Vault

A browser extension that does properly what the
[tab-saver userscript](../docs/tab-saver.md) could only fake: real tab, **group**
and **window** management, including automatic capture of closed windows so you
can always reopen them.

Built as **Manifest V3**, mobile-first, for Chromium browsers that allow loading
a local/unpacked extension (Quetta, Kiwi-likes, Mises, desktop Chrome/Edge…).

## Why an extension instead of the userscript

A userscript is sandboxed to a single page — it can't see the browser's tab list
or bookmarks, so the userscript had to log each page as it loaded and only ever
*approximated* your open tabs. An extension with the `tabs` permission has none
of those limits:

| Userscript workaround | What this does instead |
| --- | --- |
| Log each page into shared GM storage | `chrome.tabs.query({})` — the real, live tab list |
| "Recently active" heartbeat approximating open tabs | Actually knows what's open |
| Tabs opened before install never appeared | All tabs, always |
| Export bookmarks.html → import by hand | `chrome.bookmarks` — writes straight into the browser |
| Bulk-open at risk of popup blocking | `chrome.tabs.create()` — never blocked |
| No groups at all | Real `chrome.tabGroups` groups |
| A button injected into every page | A proper toolbar popup |

## Features

### Open
Every window and tab, live. Search by title/URL, multi-select with checkboxes,
tap a row to jump to that tab, ✕ to close it. Per-window **select all** and
**save**. With a selection you get: 💾 save session · 🗂 group · 🪟 move to new
window · ⭐ bookmark · 📋 copy URLs · ✕ close.

### Groups
- **Live groups** — rename (with colour picker), select their tabs, ungroup,
  close, or **save** them for later.
- **Saved groups** — restore as tabs (re-grouped automatically under the same
  name/colour) or open in a new window.

### Closed  ← the Brave-style bit
- **Closed windows** are captured automatically *as they close*, with all their
  tabs and group membership. Reopen as a real window (groups rebuilt), reopen
  into the current window, or save as a session.
- **Closed tabs** are recorded individually, newest first, one tap to reopen.

Nothing is lost when a window closes — that's the whole point.

### Saved
Named sessions. Restore all at once or in batches, open in a new window,
write to native bookmarks, export a `bookmarks.html`, or copy the URLs.

### Settings
Capture on/off, restore batch size + delay, how many closed windows/tabs to
keep, a full JSON export, and a live report of whether the tab-groups API is
available on your build.

## Quick access (gesture & shortcuts)

- **Open gesture** — a content script listens for a multi-finger gesture on any
  page (default **3-finger swipe up**; configurable in ⚙ Setup, off / 3- or
  4-finger tap / 3-finger swipe up or down). **"Gesture opens"** chooses the
  target: a **bottom sheet** with the full manager sliding over the current page
  (drag the handle down or tap the backdrop to dismiss — you never leave the
  page; default), or the full-page manager in its own tab. If your phone's
  system grabs a gesture — 3-finger swipe *down* is screenshot on many skins —
  pick another.
- **Home screen**: open the manager full-page (⛶), then try the browser menu's
  *Add to home screen* / bookmark on that `chrome-extension://…/manager.html`
  URL. Browser support varies.
- Extensions cannot add buttons to the browser's own toolbar/menus — the
  gesture is the way around that wall.

## Install

Because the browser has to allow local extensions:

1. **Easiest:** open the prebuilt zip link on the phone —
   <https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/claude/media-sniffer-userscript-6npriz/dist/tab-vault.zip> — it downloads ready to install.
   (Or download/copy the `tab-manager/` folder and zip it yourself.)
2. In the browser: **Settings → Extensions** (or `chrome://extensions`), enable
   **Developer mode** if present.
3. **Load unpacked** / **Install from file** and pick the folder (or the `.zip`).
4. Open it from the toolbar / extensions menu.

Tap **⛶** in the header to open the manager as a full tab — recommended on a
phone, and more reliable for very large restores.

## Updating without losing your data

An extension's identity is its **ID**, and `chrome.storage` data lives under
that ID. A zip install normally gets its ID from the unpack folder — so each
new zip looked like a brand-new extension with empty storage.

Since v1.5.1 the manifest carries a **`key`** that pins the ID permanently:

> Tab Vault ID: `nmoplfoffnphabhdfmidmlohapijgadb`

so installing a newer zip should now **update in place**, keeping sessions and
history (verify on the extensions screen: both versions must never appear side
by side — if you still end up with two, remove the *old* one).

Belt and braces for any migration: **⚙ Setup → Export all data (JSON)** before
updating, and **Import data (JSON)** afterwards. Import is additive — existing
entries win, duplicates are skipped — so importing an old backup into a live
install is always safe.

> One-time step: this first keyed version still has a different ID than your
> current install, so carry data over once via Export → install v1.5.1+ →
> Import → remove the old copy. Every update after that lands in place.

> No icon files are included, so the browser shows its default extension icon.
> Drop `icon-48.png` / `icon-128.png` into the folder and add an `"icons"` block
> to `manifest.json` if you want a custom one.

## How closed-window capture works

MV3 service workers are killed when idle, so an in-memory copy of your tabs
wouldn't survive. Instead the worker keeps a **persisted mirror** of every window
and its tabs in `chrome.storage`, updated on every tab/window/group event.

When a window closes, Chrome fires `tabs.onRemoved` (with
`isWindowClosing: true`) for each tab *before* `windows.onRemoved` — so the
worker deliberately **skips the mirror rebuild** for those, keeping the snapshot
intact until the window handler can read it and file the whole window away.
That ordering is covered by tests in the repo's scratch harness.

## Limits & notes

- Only `http(s)` URLs are captured/restored — internal pages (`chrome://`,
  `about:`) refuse to be reopened programmatically.
- **`chrome.tabGroups` may be missing or inert** on some Android Chromium builds.
  Many of them group tabs in their *own* native UI without reporting those groups
  to extensions, so a group you can plainly see may return nothing from
  `tabGroups.query()`. Three-stage handling:
  1. Use the API when it reports groups.
  2. Otherwise **reconstruct groups from the tabs' own `groupId`** — names and
     colours are unavailable, but selecting/saving/ungrouping/closing all work.
  3. If neither yields anything, "Group" falls back to creating a *saved* group.

  **⚙ Settings → Run diagnostics** prints exactly what your browser exposes
  (API presence, `tabGroups.query()` result, the `groupId` distribution across
  your tabs, window list) with a 📋 button to copy it.
- Very large restores run in the service worker (not the popup) so they survive
  the popup closing; keep the batch delay ≤ 20 s so the worker stays alive.
- `chrome.windows` behaves differently across Android browsers — some treat
  every window as a tab. If "move to new window" misbehaves, that's the browser,
  and reopening "here" (into the current window) always works.
- Some Android builds return **the same global tab list for every window** from
  `windows.getAll({populate:true})`, which showed up as several identical
  windows. The tab list is therefore built from `tabs.query({})` grouped by each
  tab's own `windowId`, which can't duplicate; diagnostics reports whether your
  build has this quirk (`populate duplicates`).
