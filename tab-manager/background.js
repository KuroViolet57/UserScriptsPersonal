/* ==========================================================================
 * Tab Vault — background service worker
 *
 * Two jobs:
 *  1. Keep a PERSISTED mirror of every window and its tabs. MV3 service
 *     workers are killed when idle, so the mirror lives in chrome.storage,
 *     not memory — otherwise a window closing after a sleep would be lost.
 *  2. Capture windows/tabs at the moment they close (using that mirror, since
 *     by the time onRemoved fires the real thing is already gone) so they can
 *     be reopened later — the Brave-style "reopen closed window".
 * ========================================================================== */
'use strict';

const K = {
    MIRROR: 'mirror',
    CLOSED_WINDOWS: 'closedWindows',
    CLOSED_TABS: 'closedTabs',
    SESSIONS: 'sessions',
    SAVED_GROUPS: 'savedGroups',
    SETTINGS: 'settings',
    OPEN_JOB: 'openJob'
};

const DEFAULT_SETTINGS = {
    batchSize: 10,
    batchDelaySec: 3,
    captureClosed: true,
    maxClosedWindows: 50,
    maxClosedTabs: 300,
    restoreUnloaded: true,
    bookmarkParent: 'auto',
    showPrivate: true
};

/* ------------------------------ storage ------------------------------ */
function get(key, def) {
    return new Promise(res => chrome.storage.local.get({ [key]: def }, o => res(o[key])));
}
function set(key, val) {
    return new Promise(res => chrome.storage.local.set({ [key]: val }, () => res()));
}
async function getSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, await get(K.SETTINGS, {}));
}

/* Only http(s) can be reliably restored; internal pages refuse to reopen. */
function isRestorable(url) { return /^https?:\/\//i.test(url || ''); }

function slimTab(t) {
    return {
        id: t.id,
        url: t.url || t.pendingUrl || '',
        title: t.title || '',
        favIconUrl: storableIcon(t.favIconUrl),
        pinned: !!t.pinned,
        groupId: (t.groupId == null ? -1 : t.groupId),
        index: t.index,
        windowId: t.windowId,
        active: !!t.active,
        incognito: !!t.incognito
    };
}

/* --------------------------- window mirror ---------------------------
 * Kept in storage.session (in memory, survives worker restarts, "not exposed
 * to content scripts" by default — so pages are not sent a copy on every
 * change). Rebuilt at startup anyway. storage.local only where session is
 * missing. */
const MIRROR_AREA = (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
function getMirror() { return new Promise(res => MIRROR_AREA.get({ [K.MIRROR]: {} }, o => res((o && o[K.MIRROR]) || {}))); }
function setMirror(v) { return new Promise(res => MIRROR_AREA.set({ [K.MIRROR]: v }, () => res())); }
if (MIRROR_AREA !== chrome.storage.local) { try { chrome.storage.local.remove(K.MIRROR); } catch (e) {} }

/* Keeps the EARLIEST pending deadline: a title-only change (slow) never
 * postpones a structural change (fast) that is already waiting. */
let rebuildTimer = null, rebuildDue = 0;
function scheduleRebuild(delay) {
    const due = Date.now() + (delay || 400);
    if (rebuildTimer && rebuildDue <= due) return;
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildDue = due;
    rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuildDue = 0; rebuildMirror(); }, due - Date.now());
}

async function rebuildMirror() {
    try {
        const tabs = await chrome.tabs.query({});
        const mirror = {};
        for (const t of tabs) {
            // Private tabs (Vivaldi 8.3+ lets extensions run in them, VAB-13631)
            // are never mirrored: the mirror lives on disk, and anything not in
            // it can't be captured as "closed" either. Private stays private.
            if (t.incognito) continue;
            const w = mirror[t.windowId] || (mirror[t.windowId] = { id: t.windowId, tabs: [], groups: [] });
            w.tabs.push(slimTab(t));
        }
        if (chrome.tabGroups) {
            try {
                const groups = await chrome.tabGroups.query({});
                for (const g of groups) {
                    const w = mirror[g.windowId];
                    if (w) w.groups.push({ id: g.id, title: g.title || '', color: g.color, collapsed: !!g.collapsed });
                }
            } catch (e) { /* tabGroups unsupported on this build */ }
        }
        const now = Date.now();
        for (const id in mirror) mirror[id].updatedAt = now;
        await setMirror(mirror);
    } catch (e) { /* transient */ }
}

/* --------------------------- closed capture ---------------------------
 * Every change to the closed lists (captures here, Forget / Clear / Import
 * from the manager via the closedOp message) runs through ONE queue: a bulk
 * close fires many onRemoved events at once, and unqueued read-modify-write
 * kept only the last one. */
let closedQ = Promise.resolve();
function withClosed(fn) {
    const p = closedQ.then(fn, fn);
    closedQ = p.catch(() => {});
    return p;
}

function pushClosedWindow(win) { return withClosed(() => pushClosedWindowNow(win)); }
function pushClosedTab(tab) { return withClosed(() => pushClosedTabNow(tab)); }

async function pushClosedWindowNow(win) {
    const s = await getSettings();
    if (!s.captureClosed) return;
    const tabs = (win.tabs || []).filter(t => isRestorable(t.url));
    if (!tabs.length) return;

    // Preserve group membership by name so a restored window can regroup.
    const groupById = {};
    for (const g of (win.groups || [])) groupById[g.id] = g;

    const list = await get(K.CLOSED_WINDOWS, []);
    list.unshift({
        id: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        closedAt: Date.now(),
        tabs: tabs.map(t => ({
            url: t.url,
            title: t.title,
            pinned: t.pinned,
            group: groupById[t.groupId] ? { title: groupById[t.groupId].title, color: groupById[t.groupId].color } : null
        }))
    });
    await set(K.CLOSED_WINDOWS, list.slice(0, s.maxClosedWindows));
}

async function pushClosedTabNow(tab) {
    const s = await getSettings();
    if (!s.captureClosed || !isRestorable(tab.url)) return;
    const list = await get(K.CLOSED_TABS, []);
    // de-dupe consecutive identical closes
    if (list.length && list[0].url === tab.url) list.shift();
    list.unshift({
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        closedAt: Date.now(),
        url: tab.url,
        title: tab.title,
        favIconUrl: storableIcon(tab.favIconUrl)
    });
    await set(K.CLOSED_TABS, list.slice(0, s.maxClosedTabs));
}

/* data: favicons are often several KB each; keep only real URLs. */
function storableIcon(u) { return (u && /^https?:/i.test(u) && u.length < 600) ? u : ''; }

/* ------------------------------ import ------------------------------
 * Merge a previous "Export all data" JSON. Additive: existing entries win,
 * duplicates (by id, falling back to content identity) are skipped, entries
 * with the wrong shape are ignored, and each list is re-sorted newest first
 * and capped, so the counts report what actually stays. */
const hasTabs = x => !!x && typeof x === 'object' && Array.isArray(x.tabs) && x.tabs.some(t => t && typeof t.url === 'string');
const hasUrl = x => !!x && typeof x === 'object' && typeof x.url === 'string';
const cleanTabs = x => Object.assign({}, x, { tabs: x.tabs.filter(t => t && typeof t.url === 'string') });

async function importDataNow(data) {
    if (!data || typeof data !== 'object') throw new Error('not an export file');
    const s = await getSettings();
    const lists = [
        ['sessions', K.SESSIONS, v => v.id || ('s|' + v.name + '|' + v.tabs.length), hasTabs, cleanTabs, v => v.savedAt, 0],
        ['savedGroups', K.SAVED_GROUPS, v => v.id || ('g|' + v.name + '|' + v.tabs.length), hasTabs, cleanTabs, v => v.savedAt, 0],
        ['closedWindows', K.CLOSED_WINDOWS, v => v.id || ('w|' + v.closedAt), hasTabs, cleanTabs, v => v.closedAt, s.maxClosedWindows],
        ['closedTabs', K.CLOSED_TABS, v => v.id || ('t|' + v.url + '|' + v.closedAt), hasUrl, v => v, v => v.closedAt, s.maxClosedTabs]
    ];
    if (!lists.some(([name]) => Array.isArray(data[name]))) throw new Error('no Tab Vault data found');
    const added = {}, dropped = {};
    for (const [name, key, idOf, valid, clean, ts, cap] of lists) {
        const incoming = Array.isArray(data[name]) ? data[name] : [];
        const current = (await get(key, [])).filter(x => x && typeof x === 'object');
        const seen = new Set(current.map(idOf));
        const fresh = [];
        for (const item of incoming) {
            if (!valid(item) || seen.has(idOf(item))) continue;
            seen.add(idOf(item));
            fresh.push(clean(item));
        }
        let kept = fresh.length;
        if (fresh.length) {
            let merged = current.concat(fresh).sort((a, b) => (+ts(b) || 0) - (+ts(a) || 0));
            if (cap > 0 && merged.length > cap) {
                const freshSet = new Set(fresh);
                kept = merged.slice(0, cap).filter(x => freshSet.has(x)).length;
                merged = merged.slice(0, cap);
            }
            if (kept) await set(key, merged);
        }
        added[name] = kept;
        dropped[name] = fresh.length - kept;
    }
    return { added, dropped };
}

async function closedOpNow(msg) {
    if (msg.op === 'remove') {
        const ids = new Set(msg.ids || []);
        await set(K.CLOSED_WINDOWS, (await get(K.CLOSED_WINDOWS, [])).filter(w => !ids.has(w.id)));
        await set(K.CLOSED_TABS, (await get(K.CLOSED_TABS, [])).filter(t => !ids.has(t.id)));
        return { ok: true };
    }
    if (msg.op === 'clear') {
        if (msg.what === 'tabs' || msg.what === 'all') await set(K.CLOSED_TABS, []);
        if (msg.what === 'windows' || msg.what === 'all') await set(K.CLOSED_WINDOWS, []);
        return { ok: true };
    }
    if (msg.op === 'import') return Object.assign({ ok: true }, await importDataNow(msg.data));
    return { ok: false, error: 'unknown closedOp' };
}

/* ------------------------------ events ------------------------------ */
/* Listeners must be registered synchronously at top level so the service
 * worker wakes for them after being suspended. */
chrome.tabs.onCreated.addListener(() => scheduleRebuild());
chrome.tabs.onMoved.addListener(() => scheduleRebuild());
chrome.tabs.onAttached.addListener(() => scheduleRebuild());
chrome.tabs.onDetached.addListener(() => scheduleRebuild());
chrome.tabs.onReplaced.addListener(() => scheduleRebuild());
chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.url || info.status === 'complete' || info.groupId != null || info.pinned != null) scheduleRebuild();
    else if (info.title) scheduleRebuild(2500);     // chat counters, timers: titles change constantly
});
chrome.windows.onCreated.addListener(() => scheduleRebuild());

if (chrome.tabGroups) {
    try {
        chrome.tabGroups.onCreated.addListener(() => scheduleRebuild());
        chrome.tabGroups.onUpdated.addListener(() => scheduleRebuild());
        chrome.tabGroups.onRemoved.addListener(() => scheduleRebuild());
    } catch (e) {}
}

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    // When a whole window goes, the window handler captures it as one unit —
    // and we must NOT rebuild the mirror here, or the window's tab list would
    // be emptied before windows.onRemoved gets to read it.
    if (removeInfo && removeInfo.isWindowClosing) return;
    try {
        const mirror = await getMirror();
        for (const wid in mirror) {
            const t = (mirror[wid].tabs || []).find(x => x.id === tabId);
            if (t) { await pushClosedTab(t); break; }
        }
    } catch (e) {}
    scheduleRebuild();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    try {
        const mirror = await getMirror();
        const win = mirror[windowId];
        if (win) {
            await pushClosedWindow(win);
            const fresh = await getMirror();
            delete fresh[windowId];
            await setMirror(fresh);
        }
    } catch (e) {}
    scheduleRebuild(900);
});

chrome.runtime.onStartup.addListener(() => rebuildMirror());

/* Content scripts get settings changes by message: a storage.onChanged
 * listener in every page would be sent a copy of every storage write. */
chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== 'local' || !ch[K.SETTINGS]) return;
    try {
        const s = Object.assign({}, DEFAULT_SETTINGS, ch[K.SETTINGS].newValue || {});
        for (const t of await chrome.tabs.query({})) {
            if (t.id == null) continue;
            try { const p = chrome.tabs.sendMessage(t.id, { type: 'settingsChanged', settings: s }); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        }
    } catch (e) {}
});
chrome.runtime.onInstalled.addListener(() => rebuildMirror());

/* --------------------------- batched opening ---------------------------
 * Run from the worker (not the popup) so it survives the popup closing.
 * Each batch is an API call, which resets the worker's idle timer, so a
 * delay below ~20s keeps it alive for the whole job.
 * --------------------------------------------------------------------- */
let job = null;

/* Create a background tab and immediately discard it: the tab exists with
 * its URL but nothing loads until the user taps it. This is what lets a
 * 400-tab restore actually produce 400 tabs instead of choking the browser. */
async function makeTab(props, unload, afterCreate) {
    try {
        const t = await chrome.tabs.create(Object.assign({ active: false }, props));
        if (afterCreate && t) { try { await afterCreate(t); } catch (e) {} }
        if (unload && t && t.id != null) { try { await chrome.tabs.discard(t.id); } catch (e) {} }
        return t;
    } catch (e) { return null; }
}
async function unloadOn() {
    const s = await getSettings();
    return !!s.restoreUnloaded && !!(chrome.tabs && chrome.tabs.discard);
}
async function liveWindowId(id) {
    if (id == null) return undefined;
    try { await chrome.windows.get(id); return id; } catch (e) { return undefined; }
}

/* The restore job record lives in storage.session: it survives worker
 * restarts, and pages are not sent a copy every time it changes. */
const JOB_AREA = (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
function getJob() { return new Promise(res => JOB_AREA.get({ [K.OPEN_JOB]: null }, o => res(o ? o[K.OPEN_JOB] : null))); }
function setJob(v) { return new Promise(res => JOB_AREA.set({ [K.OPEN_JOB]: v }, () => res())); }

async function runOpenJob(urls, mode, windowId) {
    if (mode === 'window') return openSetNow({ tabs: urls.map(url => ({ url })), newWindow: true });
    if (mode === 'all') {
        const unload = await unloadOn();
        for (const u of urls) await makeTab({ url: u, windowId }, unload);
        return { ok: true, opened: urls.length };
    }
    if (resumeP) await resumeP;               // a restore saved before the worker slept goes first
    if (job) return { ok: false, error: 'A restore is already running' };
    startBatch(urls, 0, windowId);            // reserves `job` before any await
    return { ok: true, started: true, total: urls.length };
}

/* Batched restore. The URLs and progress are saved after every tab, so a
 * worker that is stopped mid-job resumes at the next start (resumeJob). */
function startBatch(urls, done, windowId) {
    // Reserved synchronously: a second restore asked for in the same moment
    // sees `job` and is refused instead of sharing its progress counter.
    const my = job = { urls, total: urls.length, done, windowId, cancelled: false };
    const live = () => job === my && !my.cancelled;
    const save = () => live() ? setJob({ urls: my.urls, done: my.done, total: my.total, windowId: my.windowId }) : Promise.resolve();
    (async () => {
        const s = await getSettings();
        const unload = await unloadOn();
        const batch = Math.max(1, s.batchSize | 0);
        const delay = Math.max(0, Math.min(20, +s.batchDelaySec || 0)) * 1000;
        const finish = async () => { if (job === my) { job = null; await setJob(null); } };
        const step = async () => {
            if (!live()) return finish();
            const end = Math.min(my.done + batch, urls.length);
            while (live() && my.done < end) {
                await makeTab({ url: urls[my.done], windowId: my.windowId }, unload);
                my.done++;
                await save();
            }
            if (live() && my.done < urls.length) setTimeout(step, delay);
            else await finish();
        };
        if (my.windowId != null) my.windowId = await liveWindowId(my.windowId);
        await save();
        step();
    })();
}
/* At worker start: resume a restore that was cut short. New restore requests
 * that arrive meanwhile wait for this (resumeP) and are then refused only if
 * a saved restore really was resumed. */
let resumeP = null;
function resumeJob() {
    resumeP = (async () => {
        let j = await getJob();
        if (!j) { const old = await get(K.OPEN_JOB, null); if (old) { j = old; await set(K.OPEN_JOB, null); } }   // 1.13.0 kept it in local
        if (!j || job) return;
        if (!Array.isArray(j.urls) || !(j.done < j.urls.length)) { await setJob(null); return; }  // old format or finished
        startBatch(j.urls, j.done | 0, j.windowId);
    })().catch(() => {}).finally(() => { resumeP = null; });
    return resumeP;
}

/* Open a set of tabs, here or in a new window, grouping as asked:
 *   tabs: [{url, group?: {title, color}}], groupAll?: {title, color}
 * Each tab is created, put in its group, then discarded before the next one
 * is created — no load flood, and grouping happens while the tab is loaded.
 * Runs in the worker so a closing popup cannot cut it short. */
async function openSetNow({ tabs, newWindow, groupAll, windowId }) {
    const items = (tabs || []).filter(t => t && isRestorable(t.url));
    if (!items.length) return { ok: false, error: 'Nothing restorable' };
    const unload = await unloadOn();
    const canGroup = !!(chrome.tabs && chrome.tabs.group);
    const gids = {};
    let groupFailed = !canGroup, groupedAny = false;
    const keyOf = it => groupAll ? '*' : (it.group && it.group.title ? it.group.title + '|' + (it.group.color || 'grey') : null);
    const specOf = it => groupAll || it.group;
    let winId = windowId;

    const addToGroup = async (tab, it) => {
        const key = keyOf(it);
        if (!key || groupFailed || !tab || tab.id == null) return;
        try {
            if (gids[key] != null) await chrome.tabs.group({ groupId: gids[key], tabIds: [tab.id] });
            else {
                const opts = { tabIds: [tab.id] };
                if (winId != null) opts.createProperties = { windowId: winId };
                gids[key] = await chrome.tabs.group(opts);
                const sp = specOf(it) || {};
                if (chrome.tabGroups && chrome.tabGroups.update) {
                    try { await chrome.tabGroups.update(gids[key], { title: sp.title || '', color: sp.color || 'blue' }); } catch (e) {}
                }
            }
            groupedAny = true;
        } catch (e) { groupFailed = true; }
    };

    let opened = 0, start = 0;
    if (newWindow) {
        // No silent fallback here: the caller decides (the manager restores in
        // the current window instead), so nothing is opened twice.
        try {
            const win = await chrome.windows.create({ url: items[0].url });
            winId = win.id; start = 1; opened = 1;
            await addToGroup((win.tabs || [])[0], items[0]);
        } catch (e) { return { ok: false, noWindow: true, error: 'Could not open a new window: ' + ((e && e.message) || e) }; }
    }
    for (let i = start; i < items.length; i++) {
        const t = await makeTab({ url: items[i].url, windowId: winId }, unload, tab => addToGroup(tab, items[i]));
        if (t) opened++;
    }
    const wanted = items.some(keyOf);
    return { ok: true, opened, windowId: winId, grouped: wanted && groupedAny && !groupFailed, groupFailed: wanted && groupFailed };
}

async function moveToNewWindow(tabIds) {
    const ids = (tabIds || []).filter(x => x != null);
    if (!ids.length) return { ok: false, error: 'No tabs' };
    const win = await chrome.windows.create({ tabId: ids[0] });
    if (ids.length > 1) await chrome.tabs.move(ids.slice(1), { windowId: win.id, index: -1 });
    return { ok: true, windowId: win.id };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg.type === 'openUrls') {
                sendResponse(await runOpenJob(msg.urls || [], msg.mode || 'batch', msg.windowId));
            } else if (msg.type === 'cancelOpen') {
                if (resumeP) await resumeP;                         // a restore being resumed is cancelled too
                if (job) { job.cancelled = true; job = null; }     // stops at once; a new restore may start right away
                await setJob(null);
                sendResponse({ ok: true });
            } else if (msg.type === 'openSet') {
                sendResponse(await openSetNow(msg));
            } else if (msg.type === 'moveToNewWindow') {
                sendResponse(await moveToNewWindow(msg.tabIds));
            } else if (msg.type === 'closedOp') {
                try { sendResponse(await withClosed(() => closedOpNow(msg))); }
                catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
            } else if (msg.type === 'rebuild') {
                await rebuildMirror();
                sendResponse({ ok: true });
            } else if (msg.type === 'getGroupSwitcher') {
                // Tabs of the sender tab's group, for the in-page group switcher.
                const tab = sender.tab;
                if (!tab) { sendResponse({ ok: false, error: 'no sender tab' }); return; }
                const NONE = (chrome.tabGroups && typeof chrome.tabGroups.TAB_GROUP_ID_NONE === 'number')
                    ? chrome.tabGroups.TAB_GROUP_ID_NONE : -1;
                const gid = (tab.groupId == null ? NONE : tab.groupId);
                const grouped = gid !== NONE && gid > 0;      // 0 is a junk sentinel on some builds
                let group = null, tabs = [];
                if (grouped) {
                    try { if (chrome.tabGroups && chrome.tabGroups.get) group = await chrome.tabGroups.get(gid); } catch (e) {}
                    try { tabs = await chrome.tabs.query({ groupId: gid }); } catch (e) {}
                }
                sendResponse({
                    ok: true, grouped,
                    group: group ? { title: group.title || '', color: group.color || 'grey' } : null,
                    activeId: tab.id,
                    tabs: tabs.map(t => ({
                        id: t.id, title: t.title || '', url: t.url || '',
                        favIconUrl: t.favIconUrl || '', active: !!t.active, index: t.index
                    })).sort((a, b) => a.index - b.index)
                });
            } else if (msg.type === 'activateTab') {
                try {
                    await chrome.tabs.update(msg.tabId, { active: true });
                    const t = await chrome.tabs.get(msg.tabId);
                    try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
                    sendResponse({ ok: true });
                } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
            } else if (msg.type === 'tryOpenPopup') {
                // Ask the browser to show the action popup — Quetta presents it
                // as its native bottom sheet. Not all builds allow this without
                // a toolbar click; the caller falls back to the custom sheet.
                if (chrome.action && chrome.action.openPopup) {
                    try { await chrome.action.openPopup(); sendResponse({ ok: true }); }
                    catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
                } else sendResponse({ ok: false, error: 'openPopup unsupported' });
            } else if (msg.type === 'openManager') {
                // gesture from the content script: open the full-page manager,
                // reusing an existing manager tab if one is already open
                const url = chrome.runtime.getURL('manager.html');
                const existing = await chrome.tabs.query({ url });
                if (existing.length) await chrome.tabs.update(existing[0].id, { active: true });
                else await chrome.tabs.create({ url });
                sendResponse({ ok: true });
            } else {
                sendResponse({ ok: false, error: 'unknown message' });
            }
        } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
    })();
    return true;  // keep the channel open for the async reply
});

rebuildMirror();
resumeJob();
