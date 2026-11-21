# Fresh review of the Vault fixes (89868ea..e522859), 2026-11-21

Reviewer verdict: fix first. Reviewer's own run: npm test 66/66; probe tests (left in the review worktree only):
tests/zz-review-probe-tab.test.mjs, tests/zz-review-probe-media.test.mjs.

1. bug (CONFIRMED, probe M-A): Media Vault bucket dropped and re-added within one save window is set then removed — list lost on disk. background.js markDirty/flushSave.
2. bug (CONFIRMED, probe E): Reopen window opens every tab twice when windows.create fails (openSetNow falls back and returns ok; manager also falls back).
3. bug (CONFIRMED, probes A, B): two batch restores can run at once and mix URLs (job reserved only after awaits).
4. ux (CONFIRMED, probe C): new restore right after Cancel refused; cancel at the very start ignored.
5. risk (PLAUSIBLE): status 'loading' without url can come from iframe navigations (Chromium code review 1156043002) — list cleared mid-playback.
6. risk (code reading): storage.local writes (openJob with full URL list per tab; Media Vault buckets) are delivered to every content script's storage.onChanged.
7. risk (PLAUSIBLE): Media Vault sheet intent relay checks e.origin against the content script's dynamic getURL; the framed page may post with the static origin.
8. risk (PLAUSIBLE): userscript upgrade — a reloaded tab's gone-marked entry stays in the legacy live map; 1.0.0 tabs sweep it into Closed.
9. risk (CONFIRMED by regex trace): movie_part1.mp4 / movie_part2.mp4 fold into one row; playlist.m3u8?id=A / ?id=B become one row.
10. ux (PLAUSIBLE): child-frame video button opens the overlay and launches apps inside the iframe.
11. ux (trace): closedOp failures throw without a toast (manager Forget / Clear).
12. nit (PLAUSIBLE): a pending 10 s History title update is cancelled by the next SPA URL change.

Checked and found correct (reviewer): withClosed cannot be poisoned; all manager closed-list writes go through closedOp;
import validation; mirror in storage.session; render merge; no liveRev ping-pong; twin split; sweep lease with no
visible tab; loadMedia migration keeps private buckets in memory; settings invalidation; refusal notice; userscript
streams/byUrl guard; __MV gating; safePkg in all buildIntent copies; eruda SRI hash. Doc claims true except "Reload
clears" (see 5) and "ad frames stay idle" (they still ask for settings and run a 5 s check).

Sources the reviewer cited: https://codereview.chromium.org/1156043002 ,
https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Nr3QNKFv74c/m/PYLvA7dOAAAJ
