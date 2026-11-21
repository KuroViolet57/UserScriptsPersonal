# UserScriptsPersonal

Personal userscripts and browser extensions. They're built mobile-first for
Vivaldi (Android 8.2+ and desktop) and Android browsers with a built-in
userscript manager, and they work in any desktop browser that runs
Tampermonkey or Violentmonkey.

## Userscripts

Each extension below also comes as a **userscript** that does as much of the
same job as a page script can. Use these in browsers that can't load
extensions, or to compare across browsers.

| Script | Description | Docs |
| ------ | ----------- | ---- |
| [`tab-vault.user.js`](tab-vault.user.js) | **Tab Vault (userscript)**: an approximate live tab list across every site (Tampermonkey's tab API is used when present), remote close/focus, Tab Vault groups, closed-tab capture, a page history with day and time-of-day filters, saved sessions with batched restore, and bookmarks.html / JSON export **compatible with the extension**. Opens with a corner launcher or multi-finger gestures. | [docs](docs/tab-vault-userscript.md) |
| [`media-vault.user.js`](media-vault.user.js) | **Media Vault (userscript)**: detects media from fetch/XHR response headers, the Performance timeline, `<video>`/`<audio>` elements and iframes, and folds segment floods. Lists them in a bottom sheet with filters and has an on-video preview panel. Downloads go through the manager (with Referer), 1DM / ADM / any Android app, or an external player. | [docs](docs/media-vault-userscript.md) |
| [`media-sniffer.user.js`](media-sniffer.user.js) | *Legacy* (1.4.1). The original media sniffer for Via and XBrowser, superseded by `media-vault.user.js`. | [docs](docs/media-sniffer.md) |
| [`via-tab-saver.user.js`](via-tab-saver.user.js) | *Legacy*. The original Via tab saver, superseded by `tab-vault.user.js` (which imports its JSON). | [docs](docs/tab-saver.md) |

**Install:** open the raw `*.user.js` link in a browser with a userscript
manager and it offers to install. Each script carries `@updateURL`, so it
updates itself from then on.

- <https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/tab-vault.user.js>
- <https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/media-vault.user.js>

> **Vivaldi and other Chromium 138+ browsers:** Tampermonkey and
> Violentmonkey only run scripts once **Allow User Scripts** is on in the
> manager's details page (`vivaldi://extensions` → Details). On Vivaldi for
> Android 8.2+, install the manager from the Chrome Web Store (keep
> *Desktop site* on for the store page), then turn the toggle on the same way.

## Browser extensions

| Extension | Description | Docs |
| --- | ----------- | ---- |
| [`tab-manager/`](tab-manager/) | **Tab Vault 1.14.0**: tab, group and window manager. Live tab list, real tab groups, saved sessions, browsing history, and automatic capture of closed windows and tabs so you can always reopen them. | [readme](tab-manager/README.md) |
| [`media-sniffer-ext/`](media-sniffer-ext/) | **Media Vault 1.7.0**: the media sniffer as an extension. Uses webRequest-level detection (any frame, any format, based on Content-Type), size and format filters, segment folding, an on-video button with an in-page player, and real `chrome.downloads` downloads. | [readme](media-sniffer-ext/README.md) |

Both are Manifest V3. Load them unpacked (or from a zip) in any Chromium
browser that allows local extensions. **What changed for Vivaldi 8.3 / 8.4**
(private tabs, runtime permission prompts, the tab-groups API on desktop,
bookmark defaults, toolbar pin state) is listed in each extension's README.

**One-tap downloads:** open the link on the phone, then install the
downloaded zip from the browser's extension screen. Thanks to the pinned IDs,
it updates in place.

- Tab Vault: <https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/dist/tab-vault.zip>
- Media Vault: <https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/dist/media-vault.zip>

## Third-party apps kept at hand

| App | What's here | Docs |
| --- | --- | --- |
| [Immersive Translate](vendor/immersive-translate/) 1.35.4 | The official, unmodified release: Chrome/Vivaldi zip, Firefox zip and userscript. It's proprietary freeware and not my code. `scripts/update-immersive-translate.sh` refreshes it. | [readme](vendor/immersive-translate/README.md) |

## Web apps

| App | Description | Docs |
| --- | ----------- | ---- |
| [`ai-search/`](ai-search/index.html) | Unfiltered AI search and chat front-end (18+). Bring your own model: an API key, a local server (Ollama/KoboldCpp), or an in-browser HuggingFace model. Optional SearXNG web search with citations. | [readme](ai-search/README.md) |

It's a single self-contained HTML file. Open it in a browser or host it
statically.
