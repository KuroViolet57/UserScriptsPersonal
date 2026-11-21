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
- [x] F0 Harness (done when `npm test` runs real worker files) — commit
- [x] T1 closed-list queue + `closedOp` message (remove / clear / import) in `tab-manager/background.js`; manager uses it (Forget, Clear, Forget selected, Clear all, Import)
- [x] T4 import validation + sort by closedAt + cap (worker); sessions/groups validated (userscript already does)
- [x] T2/T12 `openSet` in the worker: new window or here, group by name/colour, create→group→discard per tab; manager's reopenWindow / restoreGroup / openTabsGrouped / New window use it
- [x] T7 persisted open job `{urls, done, total, windowId}` resumed at worker start
- [x] T9 mirror in `storage.session`, no data: favicons, title-only changes debounced longer
- [x] T3 render generation guard + 200 ms search debounce in manager.js
- [x] T13 batch delay 0 allowed
- [x] Live Open list: tabs.* events → debounced re-render while Open/Groups is shown; ✕ on a gone tab doesn't throw
- [x] T8/M17 `use_dynamic_url: true` in both manifests
- [x] T14 content.js sheet in a closed shadow root
- [x] T15 popup-size.js records `unhandledrejection` (both copies identical)
- [x] T5/T11 userscript per-tab live keys + revision key + sweep lease
- [x] T6 userscript twin split re-subscribes cmd listener
- [x] T10 userscript logPage debounce / skip unchanged
- [x] M1 loadMedia promise cache
- [x] M2 clear on top-frame `loading` (reload) in background.js
- [x] M3 prune dead tab buckets on startup; save only changed buckets
- [x] M4 `__MV` setters only when debug on; package-name validation
- [x] M5 stream dedupe on origin+path (ext + userscript)
- [x] M6 extensionless segments by Content-Type; port `isSegmentUrl` into the extension
- [x] M7 DOM item names via ported `makeName/sanitizeName`
- [x] M8 bulk Remove via a worker `remove` message
- [x] M9 content.js `reported` reset on clear
- [x] M10 206 without total → size unknown
- [x] M11 userscript reads content-range only for media
- [x] M12 webRequest `types` filter, cached settings, debounced badge
- [x] M13 popup search filters locally
- [x] M14 userscript frames: hello tick stops, child frames scan lazily, `mvf_o_` keys cleaned
- [x] M15 content script `all_frames: true`, child frames report DOM media only
- [x] M16 eruda pinned with integrity check
- [x] M18 (changed): not buildable as a DNR rule — Chromium hides browser-initiated non-navigation requests from extensions (chrome_extensions_api_client.cc ShouldHideBrowserNetworkRequest); built a page notice on SERVER_FORBIDDEN / SERVER_UNAUTHORIZED instead
- [x] Versions, docs/READMEs, dist zips
- [ ] Fresh review + recheck

## Execution notes
- Commits: 46d2917 harness · ae3ffc1 T1/T4 · aa1b5f2 T2/T7/T9/T12/T3/T13/live list · 343af83 T8/T14/T15/M17 · 62b672d T5/T6/T10/T11 · 29d0294 Media Vault ext · 58ff0e8 Media Vault userscript · e522859 versions/docs/zips.
- Reproduced before fixing (test fails on the old file): T1 (10 closes → 1 kept), T3 (15 rows for 5), T13 (0 saved as 3), live list, M1 (4 of 5 kept), M2, M6 (10 rows), M7, M10, M12 (40 settings reads), M8/M13 (popup tests fail on old media.js).
- T6 test reaches the new splitTwin hook, so on the old file it fails at "splitTwin is exposed", not on the behaviour itself.
- Gotchas: fake storage on Windows rounds 1 ms timers up to the clock tick — tests wait for results (until()) instead of fixed sleeps; `until()` must await async checks; jsdom window.top is not redefinable, use a real iframe; bash heredocs mangle long edit scripts — write them as files.
- Tests: 66 passing (npm test).

## Review (2026-11-21) — fresh review of 89868ea..e522859, report in docs/reviews/2026-11-21-fresh-review-of-fixes.md
Tests: tests/review-fixes.test.mjs (R1–R12); 16 of 18 failed before the fixes.
1. Bucket dropped and re-added in one save window lost → markDirty clears it from `removed`; flushSave never removes a key that still has a bucket (R1).
2. Reopen window twice when windows.create fails → openSetNow returns ok:false, no fallback inside (R2).
3. Two restores mixing → `job` reserved synchronously in startBatch/resumeJob, each step bound to its own job (R3 ×2).
4. Cancel → clears `job` at once (R4).
5. Reload detection → top frame sends pageStart with performance.timeOrigin; only older items dropped; loading-without-url no longer clears (R5 ×3).
6. Storage copies to content scripts → Media Vault lists and the restore job in storage.session; content scripts get settings by message, no storage.onChanged listener (R6 ×3).
7. Sheet intent relay → accepts the static extension origin as well as the dynamic one (R7).
8. Upgrade sweep → a 1.1.0 tab deletes its own entry from the legacy map on register (R8).
9. Distinct files folding → streams keep non-volatile query params; anything reporting > 25 MB is never a segment (R9 ×2).
10. Child-frame overlay → the frame's button asks the worker to open the overlay in frame 0 (R10).
11. closedOp failures → toasts on Forget / Clear / Forget selected / Clear all (R11).
12. History title → the pending update remembers its URL and is flushed before a new visit (R12).

## Recheck 1 (2026-11-21, commit 3e9c3c5) — reviewer: 10 fixed, 1 partial (9), 1 needs a device (7); 5 new
Tests added to tests/review-fixes.test.mjs (N1–N4, R9 tokens); all 5 failed before the fix.
- N1 first Restore after idle refused → resumeJob no longer holds the slot; runOpenJob waits for resumeP, then decides.
- N2 reloaded HLS page lost its playlist row → every dedupe hit refreshes `ts`.
- N3 big 1.6.0 store → only tabs still open are migrated; the old copy is deleted only after a session write succeeds; a refused write retries with each list cut to its newest 100 items.
- N4 Open as group with no windows → retries in the current window.
- 9 (partial) → md5, hash, hdnea, __token__, lsig, wmsAuthSign added to the ignored token params.
Accepted edge cases (registered, on the device checklist):
- A1 numbered part files under 25 MB each (or of unknown size) still fold into one segment row.
- A2 pages where content scripts cannot run (Web Store, PDF viewer, chrome://) keep their list on reload; a new URL still clears it.
- A3 (finding 7) the static-origin rule for the sheet's intent relay comes from Chromium's browser test comment; confirm on the phone (Download with / Open in player from the bottom sheet).
