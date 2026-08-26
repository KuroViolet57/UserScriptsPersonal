# UserScriptsPersonal

Personal userscripts for Android browsers with a built-in userscript manager
(Via Browser, and compatible managers like Violentmonkey / Tampermonkey).

## Userscripts

| Script | Description | Docs |
| ------ | ----------- | ---- |
| [`media-sniffer.user.js`](media-sniffer.user.js) | Better media sniffer (Via + XBrowser): organized/detailed media list with size + extension filters, an on-video pop-up player, and download / open-in-external-player / copy-link actions. | [docs](docs/media-sniffer.md) |
| [`via-tab-saver.user.js`](via-tab-saver.user.js) | Tab manager workaround for Via: auto-logs pages across all tabs into one shared list, exports them to a bookmarks.html file, JSON, or the clipboard, and bulk-reopens a selection (all at once or in batches). | [docs](docs/tab-saver.md) |

Open your browser's userscript manager and add the raw `*.user.js` file, or paste
its contents. See each script's docs page for details.

## Browser extensions

| Extension | Description | Docs |
| --- | ----------- | ---- |
| [`tab-manager/`](tab-manager/) | **Tab Vault** — tab, group and window manager. Live tab list, real tab groups, saved sessions, and automatic capture of closed windows/tabs so you can always reopen them. | [readme](tab-manager/README.md) |

Manifest V3. Load it unpacked (or as a zip) in any Chromium browser that allows
local extensions.

## Web apps

| App | Description | Docs |
| --- | ----------- | ---- |
| [`ai-search/`](ai-search/index.html) | Unfiltered AI search + chat front-end (18+). Bring your own model — API key, local server (Ollama/KoboldCpp), or an in-browser HuggingFace model — with optional SearXNG web search and citations. | [readme](ai-search/README.md) |

Single self-contained HTML file — open it in a browser or host it statically.
