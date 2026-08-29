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
    restoreUnloaded: true
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
        favIconUrl: t.favIconUrl || '',
        pinned: !!t.pinned,
        groupId: (t.groupId == null ? -1 : t.groupId),
        index: t.index,
        windowId: t.windowId,
        active: !!t.active
    };
}

/* --------------------------- window mirror --------------------------- */
let rebuildTimer = null;
function scheduleRebuild(delay) {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { rebuildTimer = null; rebuildMirror(); }, delay || 400);
}

async function rebuildMirror() {
    try {
        const tabs = await chrome.tabs.query({});
        const mirror = {};
        for (const t of tabs) {
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
        await set(K.MIRROR, mirror);
    } catch (e) { /* transient */ }
}

/* --------------------------- closed capture --------------------------- */
async function pushClosedWindow(win) {
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

async function pushClosedTab(tab) {
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
        favIconUrl: tab.favIconUrl || ''
    });
    await set(K.CLOSED_TABS, list.slice(0, s.maxClosedTabs));
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
    if (info.url || info.title || info.status === 'complete' || info.groupId != null) scheduleRebuild();
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
        const mirror = await get(K.MIRROR, {});
        for (const wid in mirror) {
            const t = (mirror[wid].tabs || []).find(x => x.id === tabId);
            if (t) { await pushClosedTab(t); break; }
        }
    } catch (e) {}
    scheduleRebuild();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
    try {
        const mirror = await get(K.MIRROR, {});
        const win = mirror[windowId];
        if (win) {
            await pushClosedWindow(win);
            delete mirror[windowId];
            await set(K.MIRROR, mirror);
        }
    } catch (e) {}
    scheduleRebuild(900);
});

chrome.runtime.onStartup.addListener(() => rebuildMirror());
chrome.runtime.onInstalled.addListener(() => rebuildMirror());

/* --------------------------- batched opening ---------------------------
 * Run from the worker (not the popup) so it survives the popup closing.
 * Each batch is an API call, which resets the worker's idle timer, so a
 * delay below ~20s keeps it alive for the whole job.
 * --------------------------------------------------------------------- */
let job = null;

async function runOpenJob(urls, mode, windowId) {
    if (job) return { ok: false, error: 'A restore is already running' };
    const s = await getSettings();
    const unload = !!s.restoreUnloaded && !!(chrome.tabs && chrome.tabs.discard);

    // Create a background tab and immediately discard it: the tab exists with
    // its URL but nothing loads until the user taps it. This is what lets a
    // 400-tab restore actually produce 400 tabs instead of choking the
    // browser — memory/network stay flat.
    const mkTab = async props => {
        try {
            const t = await chrome.tabs.create(Object.assign({ active: false }, props));
            if (unload && t && t.id != null) { try { await chrome.tabs.discard(t.id); } catch (e) {} }
            return t;
        } catch (e) { return null; }
    };

    if (mode === 'window') {
        // When unloading, seed the window with just the first URL (a window
        // created with 30 URLs loads all 30 at once) and add the rest discarded.
        const chunk = unload ? urls.slice(0, 1) : urls.slice(0, 30);
        const win = await chrome.windows.create({ url: chunk });
        for (let i = chunk.length; i < urls.length; i++) {
            await mkTab({ url: urls[i], windowId: win.id });
        }
        return { ok: true, opened: urls.length };
    }

    if (mode === 'all') {
        for (const u of urls) await mkTab({ url: u, windowId });
        return { ok: true, opened: urls.length };
    }

    // batched
    job = { total: urls.length, done: 0, cancelled: false };
    const batch = Math.max(1, s.batchSize | 0);
    const delay = Math.max(0, Math.min(20, s.batchDelaySec)) * 1000;

    const step = async () => {
        if (!job || job.cancelled) { job = null; await set(K.OPEN_JOB, null); return; }
        const end = Math.min(job.done + batch, urls.length);
        for (; job.done < end; job.done++) {
            await mkTab({ url: urls[job.done], windowId });
        }
        await set(K.OPEN_JOB, { done: job.done, total: job.total });
        if (job.done < urls.length) setTimeout(step, delay);
        else { job = null; await set(K.OPEN_JOB, null); }
    };
    step();
    return { ok: true, started: true, total: urls.length };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            if (msg.type === 'openUrls') {
                sendResponse(await runOpenJob(msg.urls || [], msg.mode || 'batch', msg.windowId));
            } else if (msg.type === 'cancelOpen') {
                if (job) job.cancelled = true;
                await set(K.OPEN_JOB, null);
                sendResponse({ ok: true });
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
