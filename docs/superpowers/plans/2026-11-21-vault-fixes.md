# Plan: Vault review fixes (2026-11-21)

**Goal:** fix every finding in `docs/review-2026-11-21.md` (T1–T15 + live Open list, M1–M18) in the
Tab Vault and Media Vault extensions and userscripts. The three extras (auto-save snapshots, HLS to one
file, duplicate tabs) and "Download with AuraFiles" are a second plan after the design-studio approval.

**Branch:** `fix/vault-review` from `ccr-b432f84b-h7f7j6` (89868ea).
**Tech:** plain JS, MV3 service workers, Tampermonkey/Violentmonkey userscripts. Tests: `npm test`
(node:test, Node 24, jsdom 31.0.1 dev-only). Fake `chrome` in `tests/helpers/fake-chrome.mjs` loads the
real worker files; userscripts are loaded in jsdom with a fake GM store, and internals are reached by a
test-time source transform (nothing test-only ships).

## Global constraints
- MV3 listeners stay registered synchronously at top level.
- `storage.session` is "not exposed to content scripts" by default and holds 10 MB
  (developer.chrome.com/docs/extensions/reference/api/storage) — the tab mirror moves there; fall back
  to `storage.local` where `storage.session` is missing.
- `use_dynamic_url: true`: content-script `runtime.getURL()` returns the dynamic-ID URL
  (chromium `chrome/browser/extensions/web_accessible_resources_browsertest.cc`, Dynamic URL test).
- `tabs.onUpdated` `changeInfo.url` is sent only "if it has changed" (api/tabs) — reloads need `status`.
- webRequest `types` values: main_frame, sub_frame, stylesheet, script, image, font, object,
  xmlhttprequest, ping, csp_report, media, websocket, webbundle, other (api/webRequest).
- Stored data formats stay compatible with existing installs and with each other's exports; old userscript
  `live` map is still read during the switch to per-tab keys.
- Bump versions: Tab Vault ext 1.14.0, Media Vault ext 1.7.0, Tab Vault userscript 1.1.0,
  Media Vault userscript 1.1.0. Rebuild `dist/*.zip` with the build-zips rule.

## Review Focus (most likely to bite first)
1. Closed lists: worker and manager edits all go through the worker queue; a bulk close of N tabs
   keeps N (test: 10 concurrent closes → 10), and Forget/Clear/Import during a capture lose nothing.
2. Worker restart mid-job: a persisted restore resumes once, never twice, and a stale window id falls back.
3. Userscript per-tab keys: a closing tab's `gone` mark survives another tab's heartbeat (test with two tabs);
   old-version tabs still visible; sweep removes both forms.
4. Twin split re-subscribes the command listener to the new id (test).
5. Media Vault cold start: N concurrent detections keep N (test, repeated runs).
6. Reload clears the per-tab media list exactly once and does not clear on in-page hash changes.
7. Segment / stream dedupe must not fold distinct real files (two different .mp4 files stay two).
8. Filenames: hostile titles (`/`, `:`, `|`, emoji, 300 chars, empty) → safe name with extension.
9. Intent package names validated; `__MV` no longer exposes setters unless debug is on.
10. Shadow-root sheet still opens, drags and closes; page CSS `iframe{display:none}` cannot hide it.

## Tasks
- [ ] F0 Harness (done when `npm test` runs real worker files) — commit
- [ ] T1 closed-list queue + `closedOp` message (remove / clear / import) in `tab-manager/background.js`; manager uses it (Forget, Clear, Forget selected, Clear all, Import)
- [ ] T4 import validation + sort by closedAt + cap (worker); sessions/groups validated (userscript already does)
- [ ] T2/T12 `openSet` in the worker: new window or here, group by name/colour, create→group→discard per tab; manager's reopenWindow / restoreGroup / openTabsGrouped / New window use it
- [ ] T7 persisted open job `{urls, done, total, windowId}` resumed at worker start
- [ ] T9 mirror in `storage.session`, no data: favicons, title-only changes debounced longer
- [ ] T3 render generation guard + 200 ms search debounce in manager.js
- [ ] T13 batch delay 0 allowed
- [ ] Live Open list: tabs.* events → debounced re-render while Open/Groups is shown; ✕ on a gone tab doesn't throw
- [ ] T8/M17 `use_dynamic_url: true` in both manifests
- [ ] T14 content.js sheet in a closed shadow root
- [ ] T15 popup-size.js records `unhandledrejection` (both copies identical)
- [ ] T5/T11 userscript per-tab live keys + revision key + sweep lease
- [ ] T6 userscript twin split re-subscribes cmd listener
- [ ] T10 userscript logPage debounce / skip unchanged
- [ ] M1 loadMedia promise cache
- [ ] M2 clear on top-frame `loading` (reload) in background.js
- [ ] M3 prune dead tab buckets on startup; save only changed buckets
- [ ] M4 `__MV` setters only when debug on; package-name validation
- [ ] M5 stream dedupe on origin+path (ext + userscript)
- [ ] M6 extensionless segments by Content-Type; port `isSegmentUrl` into the extension
- [ ] M7 DOM item names via ported `makeName/sanitizeName`
- [ ] M8 bulk Remove via a worker `remove` message
- [ ] M9 content.js `reported` reset on clear
- [ ] M10 206 without total → size unknown
- [ ] M11 userscript reads content-range only for media
- [ ] M12 webRequest `types` filter, cached settings, debounced badge
- [ ] M13 popup search filters locally
- [ ] M14 userscript frames: hello tick stops, child frames scan lazily, `mvf_o_` keys cleaned
- [ ] M15 content script `all_frames: true`, child frames report DOM media only
- [ ] M16 eruda pinned with integrity check
- [ ] M18 Referer for extension downloads via a session DNR rule
- [ ] Versions, docs/READMEs, dist zips; fresh review + recheck

## Execution notes
