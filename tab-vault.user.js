// ==UserScript==
// @name         Tab Vault (userscript)
// @namespace    https://github.com/KuroViolet57/UserScriptsPersonal
// @version      1.1.0
// @description  Tab Vault as a userscript: approximate live tab list across all sites (shared GM storage + heartbeat, Tampermonkey's tab API when present), remote close/focus, Tab Vault groups, closed-tab capture, a page history log with day/time-of-day filters, saved sessions with batched restore, bookmarks.html / JSON export compatible with the Tab Vault extension, a corner launcher and multi-finger gestures.
// @author       KuroViolet57
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        window.close
// @grant        window.focus
// @run-at       document-idle
// @noframes
// @downloadURL  https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/tab-vault.user.js
// @updateURL    https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/tab-vault.user.js
// ==/UserScript==

/*
 * Tab Vault (userscript)
 * ----------------------
 * A port of the Tab Vault MV3 extension (tab-manager/) to a userscript, and
 * the successor of via-tab-saver.user.js.
 *
 * A userscript is sandboxed to the page it runs in: it cannot list the
 * browser's tabs, read its tab groups or history, or create/discard tabs. So
 * the parts that need those APIs are APPROXIMATED here:
 *
 *  - Open     every tab running this script registers itself (per-tab id,
 *             URL, title, favicon, heartbeat) in GM storage, which is shared
 *             by all tabs on all sites. Tampermonkey's GM_getTabs/GM_saveTab
 *             are used as the source of truth when the manager has them.
 *             Close/focus are requests the target tab carries out itself.
 *  - Groups   Tab Vault's own groups (same shape as the extension's saved
 *             groups) — browser-native groups are unreachable.
 *  - Closed   a page whose tab unloaded and did not come back within N
 *             seconds; tabs that stop answering are filed as "lost contact".
 *  - History  pages this script has seen, not the browser's history.
 *
 * Everything else (sessions, batched restore, bookmarks.html / JSON export,
 * additive import, gestures) behaves like the extension. Every GM_* call is
 * feature-detected; with no GM storage at all it falls back to localStorage,
 * which only covers the current site (shown in Setup → Capabilities).
 */

(function () {
    'use strict';
    if (window.top !== window.self) return;   // @noframes, belt and braces

    const VERSION = '1.1.0';

    /* ===================================================================== *
     *  GM compatibility layer (every API feature-detected)
     * ===================================================================== */
    function pick(f) { try { return f(); } catch (e) { return null; } }
    const API = {
        getValue:     pick(() => typeof GM_getValue === 'function' ? GM_getValue : null),
        setValue:     pick(() => typeof GM_setValue === 'function' ? GM_setValue : null),
        deleteValue:  pick(() => typeof GM_deleteValue === 'function' ? GM_deleteValue : null),
        listValues:   pick(() => typeof GM_listValues === 'function' ? GM_listValues : null),
        addListener:  pick(() => typeof GM_addValueChangeListener === 'function' ? GM_addValueChangeListener : null),
        menu:         pick(() => typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null),
        openInTab:    pick(() => typeof GM_openInTab === 'function' ? GM_openInTab : null),
        setClipboard: pick(() => typeof GM_setClipboard === 'function' ? GM_setClipboard : null),
        getTab:       pick(() => typeof GM_getTab === 'function' ? GM_getTab : null),
        saveTab:      pick(() => typeof GM_saveTab === 'function' ? GM_saveTab : null),
        getTabs:      pick(() => typeof GM_getTabs === 'function' ? GM_getTabs : null)
    };
    // GM_info is readable without a grant in TM/VM/ScriptCat; it is
    // deliberately NOT @grant-ed (that broke installs on ScriptCat/Quetta).
    const INFO = pick(() => (typeof GM_info !== 'undefined' && GM_info) ? GM_info : null);
    const HANDLER = (INFO && (INFO.scriptHandler || INFO.handler)) || (/XBrowser/i.test(navigator.userAgent) ? 'XBrowser?' : 'unknown');
    const HANDLER_VER = (INFO && INFO.version) || '';

    const LSP = '__tabvault_';
    const MODE = (API.getValue && API.setValue) ? 'gm' : 'local';

    function readRaw(k) {
        if (MODE === 'gm') { try { return API.getValue(k); } catch (e) { return undefined; } }
        try { const r = localStorage.getItem(LSP + k); return r == null ? undefined : JSON.parse(r); } catch (e) { return undefined; }
    }
    /* Typed read: the default's type is enforced, and a manager that hands
     * back JSON strings (some Android ones do) is tolerated. */
    function gv(k, d) {
        let v = readRaw(k);
        if (v === undefined || v === null) return d;
        if (typeof v === 'string' && d !== undefined && typeof d !== 'string') {
            try { v = JSON.parse(v); } catch (e) { return d; }
        }
        if (Array.isArray(d)) return Array.isArray(v) ? v : d;
        if (d && typeof d === 'object') return (v && typeof v === 'object' && !Array.isArray(v)) ? v : d;
        return v;
    }
    function gset(k, v) {
        if (MODE === 'gm') { try { API.setValue(k, v); return true; } catch (e) { return false; } }
        try { localStorage.setItem(LSP + k, JSON.stringify(v)); return true; } catch (e) { return false; }
    }
    function gdel(k) {
        if (MODE === 'gm') {
            try { if (API.deleteValue) API.deleteValue(k); else API.setValue(k, null); } catch (e) {}
            return;
        }
        try { localStorage.removeItem(LSP + k); } catch (e) {}
    }
    function glist() {
        if (MODE === 'gm') { try { return API.listValues ? (API.listValues() || []) : null; } catch (e) { return null; } }
        try { return Object.keys(localStorage).filter(k => k.startsWith(LSP)).map(k => k.slice(LSP.length)); } catch (e) { return null; }
    }
    /* Cross-tab change notification. Returns how changes will arrive. */
    const lsWatch = {};
    function onChange(k, fn) {
        if (MODE === 'gm' && API.addListener) {
            try { API.addListener(k, (name, oldV, newV, remote) => fn(newV, remote)); return 'listener'; } catch (e) {}
        }
        if (MODE === 'local') {
            lsWatch[LSP + k] = fn;
            return 'storage-event';
        }
        return 'poll';
    }
    if (MODE === 'local') {
        addEventListener('storage', e => {
            const fn = e.key && lsWatch[e.key];
            if (!fn) return;
            let v; try { v = e.newValue == null ? undefined : JSON.parse(e.newValue); } catch (x) { v = undefined; }
            fn(v, true);
        });
    }
    const CAN_LISTEN = (MODE === 'gm' && !!API.addListener) || MODE === 'local';

    /* ===================================================================== *
     *  Keys + settings (extension-compatible names where they overlap)
     * ===================================================================== */
    const K = {
        SESSIONS: 'sessions', SAVED_GROUPS: 'savedGroups',
        CLOSED_WINDOWS: 'closedWindows', CLOSED_TABS: 'closedTabs',
        SETTINGS: 'settings', LIVE: 'live', PAGES: 'pages', FABPOS: 'fabPos'
    };
    const DEFAULTS = {
        // shared with the extension
        batchSize: 10, batchDelaySec: 3, captureClosed: true,
        maxClosedWindows: 50, maxClosedTabs: 300,
        gesture: 'swipe3up', gestureTarget: 'sheet',
        gesture2: 'off', gestureTarget2: 'groupsheet',
        // userscript only
        showFab: true,
        trackLive: true,       // register this tab in the shared open-tab list
        logPages: true,        // keep the History log
        heartbeatSec: 20,      // how often a visible tab refreshes its entry
        staleMin: 60,          // silent this long -> dropped from Open ("lost contact")
        closedAfterSec: 10,    // unloaded and not back within this -> Closed
        maxPages: 1000,
        maxLive: 250,
        showFavicons: true,
        exclude: ''            // URL substrings never tracked
    };
    let settings = loadSettings();
    function loadSettings() { return Object.assign({}, DEFAULTS, gv(K.SETTINGS, {})); }

    const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
    const SECTIONS = ['open', 'groups', 'closed', 'hist', 'saved', 'settings'];

    /* ===================================================================== *
     *  Small helpers
     * ===================================================================== */
    const rid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const now = () => Date.now();
    function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } }
    function origin(u) { try { return new URL(u).origin; } catch (e) { return ''; } }
    function stripHash(u) { return String(u || '').split('#')[0]; }
    function normUrl(u) { return stripHash(u).replace(/\/$/, ''); }
    function isRestorable(u) { return /^https?:\/\//i.test(u || ''); }
    function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
    function relTime(ts) {
        const s = Math.floor((now() - ts) / 1000);
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
        const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
        return Math.floor(h / 24) + 'd ago';
    }
    const fmtTime = ts => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    function excludedUrl(url) {
        if (!isRestorable(url)) return true;
        const list = String(settings.exclude || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
        return list.some(sub => url.indexOf(sub) !== -1);
    }
    function faviconUrl() {
        try {
            const l = document.querySelector('link[rel~="icon"][href], link[rel="shortcut icon"][href], link[rel="apple-touch-icon"][href]');
            const h = l && l.href;
            return (h && /^https?:/i.test(h) && h.length < 600) ? h : '';
        } catch (e) { return ''; }
    }
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    /* ===================================================================== *
     *  Tab identity
     *  GM_getTab (Tampermonkey/ScriptCat) survives cross-site navigation and
     *  is never copied into a duplicated tab; sessionStorage is the fallback
     *  (same-site only, copied on "duplicate tab" — handled as a twin).
     * ===================================================================== */
    const INST = rid('i');            // this page load
    const BOOT_AT = now();
    const SS_KEY = '__tabvault_tabid';
    let TAB_ID = null, ID_SRC = '', tmTab = null, gone = false;
    function ssGet() { try { return sessionStorage.getItem(SS_KEY); } catch (e) { return null; } }
    function ssSet(v) { try { sessionStorage.setItem(SS_KEY, v); } catch (e) {} }
    function navType() { try { const n = performance.getEntriesByType('navigation')[0]; return (n && n.type) || ''; } catch (e) { return ''; } }

    function resolveTabId() {
        return new Promise(resolve => {
            const fallback = () => {
                let id = ssGet(), src = 'sessionStorage';
                if (id && navType() === 'navigate') {
                    // Duplicated tab: same id, same URL, and the original is alive.
                    const e = liveEntry(id);
                    if (e && !e.gone && e.url === location.href && now() - e.seen < settings.heartbeatSec * 4000) id = null;
                }
                if (!id) { id = rid('v'); src = 'new'; }
                ssSet(id);
                resolve({ id, src });
            };
            if (!API.getTab || !API.saveTab) return fallback();
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; fallback(); } }, 800);
            try {
                API.getTab(tab => {
                    if (done) return;
                    done = true; clearTimeout(t);
                    tab = (tab && typeof tab === 'object') ? tab : {};
                    let id = tab.tvId;
                    if (!id) { id = rid('v'); tab.tvId = id; try { API.saveTab(tab); } catch (e) {} }
                    tmTab = tab; ssSet(id);
                    resolve({ id, src: 'GM_getTab' });
                });
            } catch (e) { if (!done) { done = true; clearTimeout(t); fallback(); } }
        });
    }

    /* ===================================================================== *
     *  Live registry: one key per tab, live.<tabId>
     *  A tab only ever writes its own entry (a shared map let one tab's
     *  heartbeat overwrite another tab's "closing" mark). liveRev is bumped on
     *  real changes (register, navigate, close, sweep) so other tabs re-read;
     *  a heartbeat only refreshes the tab's own key. The 1.0.0 shared `live`
     *  map is still read (and swept) while old-version tabs are around.
     *  Without GM_listValues the shared map is used, as before.
     * ===================================================================== */
    const LIVE_P = 'live.';
    const PER_TAB = Array.isArray(glist());
    const liveKey = id => LIVE_P + id;
    function readLive() {
        const out = {};
        const legacy = gv(K.LIVE, {});
        for (const id in legacy) if (legacy[id] && typeof legacy[id] === 'object') out[id] = legacy[id];
        if (PER_TAB) for (const k of (glist() || [])) {
            if (k.indexOf(LIVE_P) !== 0) continue;
            const v = gv(k, null);
            if (v && typeof v === 'object') out[k.slice(LIVE_P.length)] = v;
        }
        return out;
    }
    function liveEntry(id) {
        if (!id) return null;
        if (PER_TAB) { const v = gv(liveKey(id), null); if (v && typeof v === 'object') return v; }
        const legacy = gv(K.LIVE, {});
        return (legacy[id] && typeof legacy[id] === 'object') ? legacy[id] : null;
    }
    function putLive(id, entry) {              // entry null = remove
        if (PER_TAB) { if (entry) gset(liveKey(id), entry); else gdel(liveKey(id)); return; }
        const live = gv(K.LIVE, {});
        if (entry) live[id] = entry; else delete live[id];
        capLive(live);
        gset(K.LIVE, live);
    }
    function removeLive(ids) {
        if (!ids.length) return;
        if (PER_TAB) ids.forEach(id => gdel(liveKey(id)));
        const legacy = gv(K.LIVE, {});
        let changed = false;
        ids.forEach(id => { if (legacy[id]) { delete legacy[id]; changed = true; } });
        if (changed) { if (Object.keys(legacy).length) gset(K.LIVE, legacy); else gdel(K.LIVE); }
        bumpLive();
    }
    function bumpLive() { if (PER_TAB) gset('liveRev', now() + Math.random()); }
    function resetLive() {
        if (PER_TAB) (glist() || []).filter(k => k.indexOf(LIVE_P) === 0).forEach(k => gdel(k));
        gdel(K.LIVE);
        lastSig = '';
        bumpLive();
    }
    let lastFocusAt = document.visibilityState === 'visible' ? BOOT_AT : 0;
    let lastLiveWrite = 0, liveTimer = null, lastHeal = 0, lastSig = '';
    function trackingOn() { return !!(TAB_ID && settings.trackLive && !excludedUrl(location.href)); }
    const sigOf = e => e.url + '\n' + e.title + '\n' + e.fav + '\n' + e.vis;

    function selfEntry() {
        return {
            id: TAB_ID, inst: INST, url: location.href,
            title: String(document.title || '').slice(0, 300), fav: faviconUrl(),
            at: BOOT_AT, seen: now(), vis: document.visibilityState === 'visible',
            foc: lastFocusAt, gone: 0
        };
    }
    function capLive(live) {
        const ids = Object.keys(live);
        const max = Math.max(20, settings.maxLive | 0);
        if (ids.length <= max) return;
        ids.filter(id => id !== TAB_ID).sort((a, b) => (live[a].seen || 0) - (live[b].seen || 0))
            .slice(0, ids.length - max).forEach(id => { delete live[id]; });
    }
    function writeLive() {
        clearTimeout(liveTimer); liveTimer = null;
        if (!trackingOn() || gone) return;
        const me = selfEntry();
        putLive(TAB_ID, me);
        lastLiveWrite = now();
        const sig = sigOf(me);
        if (sig !== lastSig) { lastSig = sig; bumpLive(); }      // a plain heartbeat tells nobody
        saveTabTM();
    }
    function scheduleLiveWrite(delay) {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(writeLive, delay);
    }
    function removeSelfFromLive() {
        if (!TAB_ID) return;
        const me = liveEntry(TAB_ID);
        if (me && me.inst === INST) { putLive(TAB_ID, null); lastSig = ''; bumpLive(); }
    }
    function saveTabTM() {
        if (!API.saveTab || !tmTab) return;
        try {
            Object.assign(tmTab, { tvId: TAB_ID, url: location.href, title: String(document.title || '').slice(0, 300), fav: faviconUrl(), seen: now() });
            API.saveTab(tmTab);
        } catch (e) {}
    }
    /* Tampermonkey's view of open tabs, keyed by our tab id. Only trusted when
     * it contains this very tab (otherwise it isn't tracking properly). */
    let tmWorks = null;
    function tmTabs() {
        return new Promise(res => {
            if (!API.getTabs || !tmTab) return res(null);
            let done = false;
            const t = setTimeout(() => { if (!done) { done = true; tmWorks = false; res(null); } }, 900);
            try {
                API.getTabs(tabs => {
                    if (done) return;
                    done = true; clearTimeout(t);
                    const map = {};
                    for (const k in (tabs || {})) {
                        const o = tabs[k];
                        if (o && typeof o === 'object' && o.tvId) map[o.tvId] = o;
                    }
                    tmWorks = !!map[TAB_ID];
                    res(tmWorks ? map : null);
                });
            } catch (e) { if (!done) { done = true; clearTimeout(t); tmWorks = false; res(null); } }
        });
    }

    /* First registration of this page load. */
    function registerSelf() {
        if (!trackingOn()) return;
        gone = false;
        const live = readLive();
        const t = now();
        const mine = live[TAB_ID];
        // Arrived by a link from a tab that just unloaded? Then that unload was
        // a navigation (cross-site, so sessionStorage could not carry the id).
        const ref = document.referrer;
        if (ref && !(mine && mine.gone)) {
            let best = null;
            for (const id in live) {
                const e = live[id];
                if (id === TAB_ID || !e.gone || e.nav) continue;
                if (t - e.gone > settings.closedAfterSec * 1000 + 5000) continue;
                if (refMatches(e.url, ref) && (!best || e.gone > best.gone)) best = e;
            }
            if (best) { best.nav = true; putLive(best.id, best); }
        }
        const me = selfEntry();
        putLive(TAB_ID, me);
        if (PER_TAB) {           // our own stale 1.0.0 entry: older tabs would sweep it into Closed
            const legacy = gv(K.LIVE, {});
            if (legacy[TAB_ID]) {
                delete legacy[TAB_ID];
                if (Object.keys(legacy).length) gset(K.LIVE, legacy); else gdel(K.LIVE);
            }
        }
        lastSig = sigOf(me);
        bumpLive();
        lastLiveWrite = t;
        saveTabTM();
        // This tab was filed as closed/lost but is evidently alive: un-file it.
        const ct = gv(K.CLOSED_TABS, []);
        const keep = ct.filter(c => !(c.tvId === TAB_ID && (c.lost || c.url === location.href) && t - c.closedAt < 3 * 86400000));
        if (keep.length !== ct.length) gset(K.CLOSED_TABS, keep);
    }
    function refMatches(u, ref) {
        if (!u || !ref) return false;
        if (stripHash(u) === stripHash(ref)) return true;
        try {
            const r = new URL(ref);
            return r.pathname === '/' && !r.search && origin(u) === r.origin;   // origin-only referrer
        } catch (e) { return false; }
    }

    /* Someone else wrote OUR key: a duplicated tab carrying our id (an older
     * live twin keeps it, we take a fresh one), or a sweep dropped us while we
     * are alive (re-add). */
    function isOlderTwin(e) {
        return !!e && !e.gone && e.inst !== INST && ID_SRC !== 'GM_getTab' && e.seen > BOOT_AT &&
            (e.at < BOOT_AT || (e.at === BOOT_AT && e.inst < INST));
    }
    function checkSelf() {
        if (!trackingOn() || gone) return;
        const me = liveEntry(TAB_ID);
        if (me && me.inst === INST) return;
        if (isOlderTwin(me)) splitTwin();
        else if (now() - lastHeal > 2000) {
            lastHeal = now(); lastSig = '';
            scheduleLiveWrite(300 + Math.random() * 700);
        }
    }
    function splitTwin() {
        TAB_ID = rid('v'); ID_SRC = 'new (twin split)'; ssSet(TAB_ID);
        lastSig = '';
        subscribeOwn();
        startCmdChannel();          // commands now arrive on cmd.<new id>
        scheduleLiveWrite(50 + Math.random() * 200);
    }
    function subscribeOwn() {
        if (!PER_TAB || !TAB_ID) return;
        const id = TAB_ID;
        onChange(liveKey(id), () => { if (id === TAB_ID) checkSelf(); });
    }
    /* The registry changed somewhere (liveRev, or the old shared map). */
    function onLiveChange() {
        checkSelf();
        liveChanged();
    }

    /* ---------------------- closed detection (sweep) ---------------------- */
    let sweeping = false;
    /* One sweeper at a time: the visible tab always sweeps; hidden tabs only
     * while they hold the lease (every tab sweeping on every heartbeat made
     * them overwrite each other's closed-list edits). */
    function takeSweepLease() {
        const l = gv('sweepLease', null), t = now();
        if (document.visibilityState !== 'visible' && l && l.id !== TAB_ID && l.until > t) return false;
        gset('sweepLease', { id: TAB_ID, until: t + Math.max(30, settings.heartbeatSec * 3) * 1000 });
        return true;
    }
    async function sweep() {
        if (sweeping || !TAB_ID) return;
        if (!takeSweepLease()) return;
        sweeping = true;
        try {
            const tm = await tmTabs();
            const live = readLive();
            const t = now();
            const closedAfter = settings.closedAfterSec * 1000, stale = settings.staleMin * 60000;
            const toFile = [], removed = [];
            for (const id in live) {
                if (id === TAB_ID) continue;
                const e = live[id];
                if (!e || typeof e !== 'object') { delete live[id]; continue; }
                if (tm) {
                    if (tm[id]) continue;                         // Tampermonkey: still open
                    if (t - (e.gone || e.seen) < 4000) continue;  // just registering
                    if (!e.nav) toFile.push(e);
                    delete live[id]; removed.push(id);
                    continue;
                }
                if (e.gone) {
                    if (t - e.gone < closedAfter) continue;
                    if (!e.nav) toFile.push(e);
                    delete live[id]; removed.push(id);
                } else if (t - e.seen > stale) {
                    toFile.push(Object.assign({}, e, { lost: true }));
                    delete live[id]; removed.push(id);
                }
            }
            // Too many entries: drop the longest-silent (not filed).
            const left = Object.keys(live).filter(id => id !== TAB_ID);
            const max = Math.max(20, settings.maxLive | 0);
            if (left.length + 1 > max) {
                left.sort((a, b) => (live[a].seen || 0) - (live[b].seen || 0))
                    .slice(0, left.length + 1 - max).forEach(id => removed.push(id));
            }
            if (!removed.length) return;
            removeLive(removed);
            removed.forEach(id => gdel('cmd.' + id));
            if (toFile.length && settings.captureClosed) fileClosed(toFile);
        } finally { sweeping = false; }
    }
    function fileClosed(entries) {
        const list = gv(K.CLOSED_TABS, []);
        const seen = new Set(list.map(c => c.src).filter(Boolean));
        let n = 0;
        entries.sort((a, b) => (a.gone || a.seen) - (b.gone || b.seen)).forEach(e => {
            if (!isRestorable(e.url)) return;
            const src = e.id + ':' + (e.gone || e.seen);
            if (seen.has(src)) return;
            seen.add(src);
            if (list.length && list[0].url === e.url && !e.lost) list.shift();   // consecutive duplicate
            list.unshift({
                id: rid('t'), closedAt: e.gone || e.seen, url: e.url, title: e.title || '',
                favIconUrl: e.fav || '', tvId: e.id, src, lost: !!e.lost || undefined
            });
            n++;
        });
        if (n) gset(K.CLOSED_TABS, list.slice(0, settings.maxClosedTabs));
    }

    /* ===================================================================== *
     *  History log (pages seen), newest first
     * ===================================================================== */
    let lastPageTouch = 0, pageT = null, pagePending = null;
    /* A new visit is logged at once; title/favicon updates are batched (10 s)
     * and skipped when nothing changed: the whole log is one value, and
     * pages with a ticking title rewrote it every 1.5 s. */
    function logPage(newVisit) {
        if (!settings.logPages || excludedUrl(location.href)) return;
        if (!newVisit) {
            // remember WHICH page the update is for (an SPA may change URL before it is written)
            pagePending = { url: location.href, title: String(document.title || '').slice(0, 300), fav: faviconUrl() };
            if (!pageT) pageT = setTimeout(() => { pageT = null; const p = pagePending; pagePending = null; logPageNow(false, p); }, 10000);
            return;
        }
        flushPageLog();
        logPageNow(true);
    }
    function flushPageLog() {
        clearTimeout(pageT); pageT = null;
        const p = pagePending; pagePending = null;
        if (p) logPageNow(false, p);
    }
    function logPageNow(newVisit, snap) {
        const url = snap ? snap.url : location.href, t = now();
        if (!settings.logPages || excludedUrl(url)) return;
        const docTitle = snap ? snap.title : String(document.title || '').slice(0, 300);
        const docFav = snap ? snap.fav : faviconUrl();
        const pages = gv(K.PAGES, []);
        const i = pages.findIndex(p => p && p.url === url);
        if (!newVisit && i === 0) {
            const cur = pages[0], f0 = docFav;
            const title = docTitle || cur.title;
            if (cur.title === title && (!f0 || cur.fav === f0) && t - (cur.lastSeen || 0) < 4.5 * 60000) { lastPageTouch = t; return; }
        }
        let e = i >= 0 ? pages.splice(i, 1)[0] : null;
        if (!e) e = { url, title: '', fav: '', firstSeen: t, lastSeen: t, visits: 0 };
        if (newVisit || !e.visits) e.visits = (e.visits || 0) + 1;
        e.lastSeen = t;
        if (docTitle) e.title = docTitle;
        const f = docFav; if (f) e.fav = f;
        pages.unshift(e);
        gset(K.PAGES, pages.slice(0, Math.max(50, settings.maxPages | 0)));
        lastPageTouch = t;
        if (newVisit) {   // a racing write from another tab can drop it: check once
            setTimeout(() => {
                if (!gv(K.PAGES, []).some(p => p && p.url === url)) logPageNow(false);
            }, 1800 + Math.random() * 800);
        }
    }

    /* ===================================================================== *
     *  Remote commands: per-target key cmd.<tabId> (written by the sender),
     *  answers in ack.<nonce> (written by the target).
     * ===================================================================== */
    const doneCmds = new Set();
    let cmdMode = 'poll', cmdPollTimer = null;
    function handleCmds() {
        if (!TAB_ID || gone) return;
        const list = gv('cmd.' + TAB_ID, []);
        for (const c of list) {
            if (!c || !c.n || doneCmds.has(c.n)) continue;
            doneCmds.add(c.n);
            if (now() - (c.at || 0) > 20000) continue;   // stale: never act on old requests
            if (c.a === 'close') {
                gset('ack.' + c.n, { s: 'closing', at: now() });
                try { window.close(); } catch (e) {}
                setTimeout(() => gset('ack.' + c.n, { s: 'refused', at: now() }), 800);
            } else if (c.a === 'focus') {
                try { window.focus(); } catch (e) {}
                setTimeout(() => gset('ack.' + c.n, {
                    s: document.visibilityState === 'visible' ? 'ok' : 'nochange', at: now()
                }), 700);
            }
        }
    }
    function startCmdChannel() {
        if (!TAB_ID) return;
        const id = TAB_ID;
        const m = onChange('cmd.' + id, () => { if (id === TAB_ID) handleCmds(); });
        cmdMode = m;
        if (m === 'poll') {
            clearInterval(cmdPollTimer);
            cmdPollTimer = setInterval(() => { if (document.visibilityState === 'visible' || Math.random() < 0.5) handleCmds(); }, 1500);
        }
        handleCmds();
    }
    /* Ask another tab to do something; resolves with its answer. */
    async function sendCmd(toId, action) {
        const n = rid('n');
        const key = 'cmd.' + toId;
        const list = gv(key, []).filter(c => c && now() - (c.at || 0) < 20000);
        list.push({ n, a: action, from: TAB_ID, at: now() });
        gset(key, list);
        const limit = action === 'close' ? 3200 : 2600;
        const t0 = now();
        let ack = null;
        while (now() - t0 < limit) {
            await sleep(200);
            ack = gv('ack.' + n, null);
            if (ack && ack.s !== 'closing') break;
            if (action === 'close' && ack && ack.s === 'closing') {
                const e = liveEntry(toId);
                if (!e || e.gone) break;   // it went away: closed
            }
        }
        gdel('ack.' + n);
        const rest = gv(key, []).filter(c => c && c.n !== n);
        if (rest.length) gset(key, rest); else gdel(key);
        if (!ack) return 'noanswer';
        if (ack.s === 'closing') return 'ok';
        return ack.s;
    }

    /* ===================================================================== *
     *  Opening tabs (single + batched restore job)
     * ===================================================================== */
    function openTab(url, active) {
        if (!isRestorable(url)) return false;
        if (API.openInTab) {
            try { API.openInTab(url, { active: !!active, insert: true, setParent: true }); return true; } catch (e) {}
        }
        try {
            const w = window.open(url, '_blank');
            if (w) { try { w.opener = null; } catch (e) {} return true; }
        } catch (e) {}
        return false;
    }
    let job = null;
    const OPEN_STAGGER_MS = 150;
    async function openUrls(urls, mode) {
        urls = (urls || []).filter(isRestorable);
        if (!urls.length) { toast('Nothing to open'); return; }
        if (job) { toast('A restore is already running — cancel it first'); return; }
        if (mode === 'batch' && urls.length > 10) {
            const c = await choice(`Open ${urls.length} tabs`, [
                { v: 'batch', label: `In batches of ${settings.batchSize} every ${settings.batchDelaySec}s`, cls: 'p', icon: 'loader' },
                { v: 'all', label: 'All at once', icon: 'zap' }
            ], 'Tabs open in the background from THIS tab — keep it in front until the restore finishes. Batch size and delay are in Setup.');
            if (!c) return;
            mode = c;
        }
        if (mode !== 'batch') mode = 'all';
        job = { urls, idx: 0, fails: 0, mode, timer: null };
        updateJobBar();
        stepJob();
    }
    function stepJob() {
        const q = job;
        if (!q) return;
        const end = q.mode === 'all' ? q.urls.length : Math.min(q.idx + Math.max(1, settings.batchSize | 0), q.urls.length);
        const one = () => {
            if (job !== q) return;
            if (q.idx >= q.urls.length) return finishJob();
            if (q.idx >= end) {
                updateJobBar('next batch in ' + settings.batchDelaySec + 's');
                q.timer = setTimeout(stepJob, Math.max(0, settings.batchDelaySec) * 1000);
                return;
            }
            if (!openTab(q.urls[q.idx], false)) q.fails++;
            q.idx++;
            updateJobBar();
            q.timer = setTimeout(one, OPEN_STAGGER_MS);
        };
        one();
    }
    function finishJob() {
        const q = job; job = null;
        updateJobBar();
        if (!q) return;
        toast('Opened ' + (q.idx - q.fails) + ' tab(s)' + (q.fails ? ' — ' + q.fails + ' blocked (allow pop-ups for this site)' : ''));
    }
    function cancelJob() {
        const q = job;
        if (!q) return;
        clearTimeout(q.timer); job = null; updateJobBar();
        toast('Stopped after ' + q.idx + ' of ' + q.urls.length);
    }

    /* ===================================================================== *
     *  Clipboard / files
     * ===================================================================== */
    async function copyText(text, what) {
        let ok = false;
        if (API.setClipboard) { try { API.setClipboard(text, 'text'); ok = true; } catch (e) {} }
        if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
            try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
        }
        if (!ok && root) {
            try {
                const ta = el('textarea'); ta.value = text;
                ta.style.cssText = 'position:absolute;left:-9999px;top:0;opacity:0';
                layer.appendChild(ta); ta.select();
                ok = document.execCommand('copy');
                ta.remove();
            } catch (e) {}
        }
        if (ok) toast(what || 'Copied');
        else showText('Copy this', text);
        return ok;
    }
    function downloadFile(filename, text, mime) {
        try {
            const blob = new Blob([text], { type: mime || 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.rel = 'noopener';
            (layer || document.body).appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            toast('Saved ' + filename);
        } catch (e) { toast('Download failed — use Copy instead'); }
    }
    function bookmarksHtml(tabs, name) {
        const t = Math.floor(now() / 1000);
        let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n' +
            '<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' +
            `    <DT><H3 ADD_DATE="${t}" LAST_MODIFIED="${t}">${esc(name || 'Tab Vault')}</H3>\n    <DL><p>\n`;
        for (const x of tabs) out += `        <DT><A HREF="${esc(x.url)}" ADD_DATE="${t}">${esc(x.title || x.url)}</A>\n`;
        return out + '    </DL><p>\n</DL><p>\n';
    }
    function exportBookmarksHtml(tabs, name) {
        const usable = (tabs || []).filter(t => isRestorable(t.url));
        if (!usable.length) { toast('Nothing to export'); return; }
        downloadFile('tabs-' + now() + '.html', bookmarksHtml(usable, name), 'text/html');
    }
    function copyUrls(tabs) {
        const urls = (tabs || []).filter(t => isRestorable(t.url)).map(t => t.url);
        if (!urls.length) { toast('Nothing to copy'); return; }
        copyText(urls.join('\n'), 'Copied ' + plural(urls.length, 'URL'));
    }

    /* ===================================================================== *
     *  Data: export / additive import (extension-compatible)
     * ===================================================================== */
    function exportData() {
        return {
            exportedAt: new Date().toISOString(),
            source: 'tab-vault-userscript', version: VERSION,
            sessions: gv(K.SESSIONS, []),
            savedGroups: gv(K.SAVED_GROUPS, []),
            closedWindows: gv(K.CLOSED_WINDOWS, []),
            closedTabs: gv(K.CLOSED_TABS, []),
            pages: gv(K.PAGES, [])
        };
    }
    const hasTabs = x => x && typeof x === 'object' && Array.isArray(x.tabs);
    const hasUrl = x => x && typeof x === 'object' && typeof x.url === 'string';
    /* Same rules as the extension's importData: existing entries win,
     * duplicates (by id, else content identity) are skipped. Also accepts the
     * via-tab-saver JSON export (a bare array of logged pages). */
    function importData(data) {
        if (Array.isArray(data)) data = { pages: data.filter(hasUrl).map(p => ({
            url: p.url, title: p.title || '', fav: '', firstSeen: p.firstSeen || p.lastSeen || now(),
            lastSeen: p.lastSeen || p.firstSeen || now(), visits: p.visits || 1 })) };
        if (!data || typeof data !== 'object') throw new Error('not an export file');
        const lists = [
            ['sessions', K.SESSIONS, s => s.id || ('s|' + s.name + '|' + (s.tabs || []).length), hasTabs],
            ['savedGroups', K.SAVED_GROUPS, g => g.id || ('g|' + g.name + '|' + (g.tabs || []).length), hasTabs],
            ['closedWindows', K.CLOSED_WINDOWS, w => w.id || ('w|' + w.closedAt), hasTabs],
            ['closedTabs', K.CLOSED_TABS, t => t.id || ('t|' + t.url + '|' + t.closedAt), hasUrl],
            ['pages', K.PAGES, p => p.url, hasUrl]
        ];
        if (!lists.some(([name]) => Array.isArray(data[name]))) throw new Error('no Tab Vault data found');
        const added = {};
        for (const [name, key, idOf, valid] of lists) {
            const incoming = Array.isArray(data[name]) ? data[name] : [];
            const current = gv(key, []);
            const seen = new Set(current.map(idOf));
            let n = 0;
            for (const item of incoming) {
                if (!valid(item) || seen.has(idOf(item))) continue;
                seen.add(idOf(item));
                current.push(item);
                n++;
            }
            if (n) {
                if (key === K.PAGES) {
                    current.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
                    gset(key, current.slice(0, Math.max(50, settings.maxPages | 0)));
                } else gset(key, current);
            }
            added[name] = n;
        }
        return added;
    }
    function importSummary(m) {
        return `Imported: ${m.sessions} sessions, ${m.savedGroups} groups, ${m.closedWindows} windows, ${m.closedTabs} closed tabs, ${m.pages} pages`;
    }

    /* ===================================================================== *
     *  Icons (constant SVG strings — the only innerHTML besides static markup)
     * ===================================================================== */
    const ICON = {
        vault:      '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="3.2"/><path d="M12 5.2v1.6M12 17.2v1.6M18.8 12h-1.6M6.8 12H5.2"/>',
        layers:     '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
        folder:     '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        folderPlus: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6M9 14h6"/>',
        history:    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        bookmark:   '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
        sliders:    '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
        search:     '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
        checkAll:   '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        square:     '<rect x="3" y="3" width="18" height="18" rx="2"/>',
        check:      '<path d="M20 6 9 17l-5-5"/>',
        x:          '<path d="M18 6 6 18M6 6l12 12"/>',
        save:       '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
        copy:       '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        window:     '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/>',
        refresh:    '<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>',
        restore:    '<path d="M1 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L1 10"/>',
        trash:      '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        edit:       '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z"/>',
        download:   '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
        code:       '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
        loader:     '<path d="M12 2v4M12 18v4M4.9 4.9l2.9 2.9M16.2 16.2l2.9 2.9M2 12h4M18 12h4M4.9 19.1l2.9-2.9M16.2 7.8l2.9-2.9"/>',
        alert:      '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        info:       '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
        inbox:      '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.7 4H7.3a2 2 0 0 0-1.8 1.1z"/>',
        grid:       '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
        zap:        '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
        calendar:   '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        external:   '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
        plus:       '<path d="M12 5v14M5 12h14"/>',
        list:       '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
        compass:    '<circle cx="12" cy="12" r="9"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>'
    };
    function svg(name, size) {
        const s = size || 16;
        return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON[name] || ''}</svg>`;
    }
    function paintIcons(rootNode) {
        rootNode.querySelectorAll('[data-ico]').forEach(n => {
            const name = n.getAttribute('data-ico');
            n.removeAttribute('data-ico');
            const slot = n.querySelector('.ni');
            if (slot) slot.innerHTML = svg(name, 18);
            else if (n.classList.contains('btn')) n.insertAdjacentHTML('afterbegin', svg(name, 14));
            else n.innerHTML = svg(name, n.classList.contains('logo') ? 18 : 16);
        });
    }

    /* ===================================================================== *
     *  Styles — the extension's tokens and components, scoped to the shadow
     *  root. The extension is dark-only (no prefers-color-scheme), so is this.
     * ===================================================================== */
    const CSS = `
:host{all:initial}
.layer{position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;transform-origin:0 0;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:normal;
    font-weight:400;letter-spacing:normal;text-align:left;color:#edeef5;color-scheme:dark;
    -webkit-text-size-adjust:none;text-size-adjust:none;direction:ltr;
    --bg:#0f0f17;--bg2:#181823;--bg3:#22222f;--bg4:#2b2b3a;--line:#2e2e3d;--line2:#3a3a4c;
    --txt:#edeef5;--muted:#8f90a6;--dim:#6b6c80;
    --blue:#5b8cff;--violet:#a855f7;--amber:#f59e0b;--emerald:#10b981;--pink:#ec4899;--danger:#f43f5e;--cyan:#22d3ee;
    --sec:var(--blue);--grad:linear-gradient(135deg,#5b8cff 0%,#a855f7 100%)}
.layer *,.layer *::before,.layer *::after{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.layer>*{pointer-events:auto}
.layer button,.layer input,.layer select,.layer textarea{font-family:inherit;font-size:inherit;color:inherit;margin:0}
.layer button{cursor:pointer;text-transform:none}
.layer svg{display:block;flex:0 0 auto}
.hidden{display:none !important}

/* ------------------------------ launcher ------------------------------ */
.fab{position:absolute;width:48px;height:48px;border-radius:15px;border:none;padding:0;
    background:var(--grad);color:#fff;display:flex;align-items:center;justify-content:center;
    box-shadow:0 4px 16px rgba(91,140,255,.4),0 2px 6px rgba(0,0,0,.45);touch-action:none;user-select:none;
    -webkit-user-select:none;opacity:.94}
.fab:active{transform:scale(.94)}
.fab em{position:absolute;top:-5px;right:-5px;background:var(--emerald);color:#052e1a;font-style:normal;
    font-size:10.5px;font-weight:800;line-height:18px;min-width:18px;height:18px;border-radius:9px;padding:0 4px;text-align:center}
.fab em:empty{display:none}

/* ------------------------------- sheets ------------------------------- */
.backdrop{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .22s;touch-action:none}
.backdrop.show{opacity:1}
.sheet{position:absolute;left:0;right:0;bottom:0;height:88%;display:flex;flex-direction:column;
    background:var(--bg);color:var(--txt);border-radius:18px 18px 0 0;overflow:hidden;
    box-shadow:0 -8px 40px rgba(0,0,0,.6);transform:translateY(105%);transition:transform .26s cubic-bezier(.2,.8,.3,1)}
.sheet.show{transform:translateY(0)}
.wide .sheet{left:calc(50% - 330px);right:auto;width:660px;height:min(86%,860px)}
.sheet.gs{height:auto;max-height:72%;background:#15151b}
.sheet[data-sec="open"]{--sec:var(--blue)}
.sheet[data-sec="groups"]{--sec:var(--violet)}
.sheet[data-sec="closed"]{--sec:var(--amber)}
.sheet[data-sec="hist"]{--sec:var(--pink)}
.sheet[data-sec="saved"]{--sec:var(--emerald)}
.sheet[data-sec="settings"]{--sec:var(--cyan)}

/* ------------------------------ header ------------------------------ */
header{position:relative;display:flex;align-items:center;gap:10px;padding:16px 14px 11px;flex:0 0 auto;
    background:var(--grad);color:#fff;box-shadow:0 2px 14px rgba(91,140,255,.28);touch-action:none}
header .grip{position:absolute;top:6px;left:50%;width:44px;height:4.5px;margin-left:-22px;border-radius:3px;background:rgba(255,255,255,.5)}
header .logo{width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,.2);
    display:flex;align-items:center;justify-content:center}
header h1{font-size:16px;margin:0;font-weight:800;flex:1;letter-spacing:.2px;color:#fff;line-height:1.2}
header h1 small{display:block;font-size:10.5px;font-weight:600;opacity:.8;letter-spacing:.1px}
header .icon{background:rgba(255,255,255,.16);border:none;color:#fff}
header .icon:active{background:rgba(255,255,255,.3)}
.icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:0;
    background:var(--bg3);border:1px solid var(--line);color:var(--txt)}
.icon:active{background:var(--bg4)}

/* -------------------------------- nav -------------------------------- */
nav{display:flex;background:var(--bg2);border-bottom:1px solid var(--line);flex:0 0 auto}
nav button{flex:1;min-width:0;background:none;border:none;color:var(--dim);padding:8px 2px 7px;
    display:flex;flex-direction:column;align-items:center;gap:3px;position:relative;
    font-size:10.5px;font-weight:700;letter-spacing:.2px;transition:color .15s}
nav button .nl{display:flex;align-items:center;gap:4px;white-space:nowrap}
nav button::after{content:"";position:absolute;left:18%;right:18%;bottom:0;height:2.5px;
    border-radius:2px 2px 0 0;background:transparent;transition:background .15s}
nav button.on{color:#fff}
nav button.on::after{background:currentColor}
nav button[data-sec="open"].on{color:var(--blue)}
nav button[data-sec="groups"].on{color:var(--violet)}
nav button[data-sec="closed"].on{color:var(--amber)}
nav button[data-sec="hist"].on{color:var(--pink)}
nav button[data-sec="saved"].on{color:var(--emerald)}
nav button[data-sec="settings"].on{color:var(--cyan)}
/* counts sit on the icon's corner so six labels still fit a 360px phone */
nav em{position:absolute;top:3px;left:50%;margin-left:7px;font-style:normal;font-size:9px;font-weight:800;
    line-height:14px;background:var(--bg4);color:var(--muted);border-radius:7px;padding:0 4px;min-width:15px;text-align:center}
nav em:empty{display:none}
nav button.on em{background:var(--sec);color:#0f0f17}

/* ------------------------------ search ------------------------------ */
.searchbar{display:flex;gap:7px;padding:9px 12px;background:var(--bg2);
    border-bottom:1px solid var(--line);flex:0 0 auto;align-items:center}
.searchwrap{flex:1;min-width:0;display:flex;align-items:center;gap:7px;background:var(--bg3);
    border:1.5px solid var(--line);border-radius:11px;padding:0 10px;transition:border-color .15s}
.searchwrap:focus-within{border-color:var(--sec)}
.searchwrap svg{color:var(--dim)}
.search{flex:1;background:none;border:none;color:var(--txt);padding:9px 0;font-size:13.5px;min-width:0;outline:none}
.search::-webkit-search-cancel-button{filter:invert(.6)}
.searchbar .icon{width:36px;height:36px}

.main{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.sec{padding:10px 11px 18px}
.ch input[type=checkbox],.row input[type=checkbox]{width:19px;height:19px;accent-color:var(--sec);flex:0 0 auto;margin:0}

/* history filter bar */
.histbar{display:flex;flex-direction:column;gap:6px;margin-bottom:10px}
.histbar .hrow{display:flex;gap:6px;align-items:center;min-width:0}
.histbar select,.histbar input{background:var(--bg3);border:1.5px solid var(--line);border-radius:10px;
    color:var(--txt);padding:7px 9px;font-size:12.5px;outline:none;min-width:0}
.histbar select:focus,.histbar input:focus{border-color:var(--sec)}
.histbar select,.histbar input[type=date],.histbar input[type=time]{flex:1 1 0}
.histbar input[type=number]{width:72px;flex:0 0 auto}
.histbar .hlbl{font-size:11px;color:var(--muted);font-weight:700}

/* --------------------------- section heads --------------------------- */
.sechead{display:flex;align-items:center;gap:7px;margin:4px 0 10px;color:var(--sec)}
.sechead .st{font-size:11px;font-weight:800;letter-spacing:.9px;text-transform:uppercase}
.sechead .rule{flex:1;height:1px;background:linear-gradient(90deg,currentColor,transparent);opacity:.35}
.sechead.alt{margin-top:20px}

/* ---------------------------- window cards ---------------------------- */
.wingroup{margin-bottom:13px;border:1px solid var(--line);border-radius:14px;overflow:hidden;
    background:var(--bg2);box-shadow:0 2px 10px rgba(0,0,0,.25)}
.winhead{display:flex;align-items:center;gap:8px;padding:10px 12px;font-size:12.5px;
    background:linear-gradient(90deg,rgba(91,140,255,.16),rgba(91,140,255,.03));border-left:3px solid var(--blue)}
.winhead .wi{color:var(--blue)}
.winhead .wt{flex:1;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cur{color:#052e1a;background:var(--emerald);font-size:9.5px;font-weight:800;
    border-radius:6px;padding:2px 7px;letter-spacing:.3px;text-transform:uppercase}

/* ------------------------------- rows ------------------------------- */
.row{display:flex;gap:10px;align-items:center;padding:9px 11px;border-top:1px solid var(--line);
    background:var(--bg);transition:background .12s}
.sec>.row{border:1px solid var(--line);border-radius:12px;margin-bottom:6px}
.row.sel{background:linear-gradient(90deg,rgba(91,140,255,.2),rgba(91,140,255,.05));box-shadow:inset 3px 0 0 var(--blue)}
.row.quiet .t{color:var(--muted)}
.av{width:28px;height:28px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;
    justify-content:center;font-size:12.5px;font-weight:800;color:#fff;text-transform:uppercase;
    letter-spacing:-.3px;overflow:hidden}
.av img{width:100%;height:100%;object-fit:cover;display:block}
.row .body{min-width:0;flex:1;cursor:pointer}
.row .t{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .u{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.row .meta{font-size:10px;color:var(--dim);margin-top:3px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pill{background:var(--bg3);border-radius:5px;padding:1px 6px;font-weight:700;font-size:10px;color:var(--muted)}
.live{color:var(--emerald);font-weight:700}
.row .rb{background:none;border:none;color:var(--dim);padding:6px;flex:0 0 auto;
    border-radius:8px;display:flex;align-items:center;justify-content:center}
.row .rb:active{background:var(--bg3);color:var(--danger)}
.row .rb.go:active{color:var(--emerald)}

/* ------------------------------ badges ------------------------------ */
.gbadge{font-size:9.5px;border-radius:6px;padding:2px 7px;font-weight:800;color:#fff;
    letter-spacing:.2px;display:inline-flex;align-items:center;gap:4px;max-width:100%;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.g-grey{background:#6b7280}.g-blue{background:#3b82f6}.g-red{background:#ef4444}
.g-yellow{background:#eab308;color:#3a2c00}.g-green{background:#22c55e;color:#03260f}
.g-pink{background:#ec4899}.g-purple{background:#a855f7}.g-cyan{background:#06b6d4;color:#00252b}
.g-orange{background:#f97316;color:#2e1200}

/* ------------------------------- cards ------------------------------- */
.card{border:1px solid var(--line);border-radius:14px;padding:12px;margin-bottom:11px;
    background:var(--bg2);border-left:3px solid var(--sec);box-shadow:0 2px 10px rgba(0,0,0,.22)}
.card.note{border-left-color:var(--amber);background:linear-gradient(90deg,rgba(245,158,11,.1),var(--bg2))}
.card.info{border-left-color:var(--sec);background:linear-gradient(90deg,rgba(91,140,255,.08),var(--bg2));padding:10px 12px}
.card .ch{display:flex;align-items:center;gap:8px;margin-bottom:7px;min-width:0}
.card .ch .ci{color:var(--sec)}
.card .ct{flex:1;min-width:0;font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .cnt{font-size:10px;font-weight:800;background:var(--bg4);color:var(--muted);
    border-radius:8px;padding:2px 8px;flex:0 0 auto}
.card .cm{font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.5}
.card .cm:last-child{margin-bottom:0}
.card .cm b{color:var(--txt)}
.card .cu{font-size:11px;color:var(--dim);line-height:1.55;max-height:52px;overflow:hidden;margin-bottom:10px;overflow-wrap:anywhere}
.card .cb{display:flex;gap:6px;flex-wrap:wrap}
.card .gtabs{margin:2px 0 10px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.card .gtabs .row:first-child{border-top:none}

/* ------------------------------ buttons ------------------------------ */
.btn{background:var(--bg3);border:1px solid var(--line2);color:var(--txt);border-radius:10px;
    padding:9px 12px;font-size:12.5px;font-weight:700;display:inline-flex;align-items:center;
    gap:6px;justify-content:center;transition:transform .08s;line-height:1.2}
.btn:active{transform:scale(.96)}
.btn.p{background:linear-gradient(135deg,#5b8cff,#7c6cff);border-color:transparent;color:#fff;box-shadow:0 2px 8px rgba(91,140,255,.35)}
.btn.g{background:linear-gradient(135deg,#10b981,#059669);border-color:transparent;color:#fff;box-shadow:0 2px 8px rgba(16,185,129,.3)}
.btn.v{background:linear-gradient(135deg,#a855f7,#7e22ce);border-color:transparent;color:#fff;box-shadow:0 2px 8px rgba(168,85,247,.3)}
.btn.a{background:linear-gradient(135deg,#f59e0b,#d97706);border-color:transparent;color:#231400;box-shadow:0 2px 8px rgba(245,158,11,.3)}
.btn.d{background:rgba(244,63,94,.14);border-color:rgba(244,63,94,.4);color:#ffb3c0}
.btn.sm{padding:7px 10px;font-size:11.5px;border-radius:9px}
.link{background:none;border:none;color:var(--sec);font-size:11.5px;font-weight:700;padding:3px 5px;flex:0 0 auto}

/* ------------------------------- footer ------------------------------- */
footer{flex:0 0 auto;background:var(--bg2);border-top:1px solid var(--line);padding:9px 10px;box-shadow:0 -3px 14px rgba(0,0,0,.35)}
footer .selinfo{font-size:11.5px;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:6px}
footer .selinfo b{color:var(--blue);font-size:13px}
footer .btns{display:flex;gap:6px;overflow-x:auto;padding-bottom:3px;overscroll-behavior:contain}
footer .btns .btn{white-space:nowrap;flex:0 0 auto}

.jobbar{flex:0 0 auto;display:flex;align-items:center;gap:9px;padding:9px 13px;
    background:linear-gradient(90deg,rgba(91,140,255,.24),rgba(168,85,247,.14));
    color:#cfe0ff;font-size:12px;font-weight:600;border-top:1px solid var(--line)}
.jobbar .jt{flex:1}
.jobbar .spin{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ------------------------------- empty ------------------------------- */
.empty{color:var(--muted);text-align:center;padding:34px 16px;line-height:1.65;font-size:13px}
.empty .eico{width:56px;height:56px;border-radius:18px;margin:0 auto 12px;display:flex;
    align-items:center;justify-content:center;background:var(--bg3);color:var(--sec)}
.empty b{color:var(--txt);overflow-wrap:anywhere}

/* ------------------------------ settings ------------------------------ */
.field{margin-bottom:15px}
.field label{display:block;font-size:13px;font-weight:700;margin-bottom:5px}
.field .h{display:block;font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5;font-weight:500}
.field input[type=number],.field input[type=text],.field select,.field textarea{width:100%;background:var(--bg3);
    border:1.5px solid var(--line);color:var(--txt);border-radius:10px;padding:10px;font-size:13.5px;outline:none}
.field textarea{min-height:64px;resize:vertical;font-size:12.5px}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--sec)}
.field.inline{display:flex;align-items:center;gap:11px}
.field.inline label{flex:1;min-width:0;margin:0}
.field.inline input[type=checkbox]{width:21px;height:21px;accent-color:var(--sec);flex:0 0 auto;margin:0}
.field.inline input[type=number]{width:88px;flex:0 0 auto}
.field.inline select{width:auto;max-width:52%;flex:0 0 auto;padding:8px}
.btnrow{display:flex;gap:6px}
.btnrow .btn{flex:1}

/* ------------------------------- toast ------------------------------- */
.toast{position:absolute;left:50%;bottom:78px;transform:translateX(-50%) translateY(8px);
    background:var(--bg4);color:#fff;padding:10px 16px;border-radius:22px;font-size:12.5px;
    font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.55);border:1px solid var(--line2);
    max-width:88%;width:max-content;text-align:center;opacity:0;pointer-events:none !important;
    transition:opacity .2s,transform .2s;z-index:80;overflow-wrap:anywhere}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}

/* ------------------------------- modal ------------------------------- */
.modal{position:absolute;inset:0;background:rgba(0,0,0,.68);display:flex;align-items:center;
    justify-content:center;padding:18px;z-index:60}
.modal .mp{background:var(--bg2);border:1px solid var(--line2);border-radius:16px;color:var(--txt);
    width:100%;max-width:360px;padding:17px;max-height:86%;overflow:auto;overscroll-behavior:contain;
    box-shadow:0 16px 50px rgba(0,0,0,.6);--sec:var(--blue)}
.modal h3{margin:0 0 13px;font-size:15.5px;font-weight:800;display:flex;align-items:center;gap:8px;overflow-wrap:anywhere}
.modal .mb{display:flex;flex-direction:column;gap:9px}
.modal .mh{font-size:11.5px;color:var(--muted);line-height:1.5}
.modal input[type=text]{width:100%;background:var(--bg3);border:1.5px solid var(--line);
    color:var(--txt);border-radius:10px;padding:11px;font-size:14px;outline:none}
.modal input[type=text]:focus,.modal textarea:focus{border-color:var(--sec)}
.modal textarea{width:100%;min-height:150px;background:var(--bg3);border:1.5px solid var(--line);color:var(--txt);
    border-radius:10px;padding:10px;font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace;resize:vertical;outline:none}
.modal .gpick{display:flex;flex-direction:column;gap:6px;max-height:200px;overflow:auto}
.modal .gpick .btn{justify-content:flex-start}
.swatches{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 2px}
.swatch{width:32px;height:32px;border-radius:50%;border:2.5px solid transparent;padding:0;transition:transform .1s}
.swatch.on{border-color:#fff;transform:scale(1.12)}
pre.diag{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:11px;
    margin:9px 0 0;font-size:10.5px;line-height:1.55;white-space:pre;overflow-wrap:normal;
    max-height:260px;overflow:auto;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace}

/* --------------------------- group switcher --------------------------- */
.gsgrab{flex:0 0 auto;height:40px;display:flex;align-items:center;background:#181823;position:relative;touch-action:none}
.gsgrab .grip{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:52px;height:5.5px;border-radius:3px;background:#4a4a5e}
.gsgrab .icon{position:absolute;right:6px;top:4px;width:32px;height:32px;background:#22222f;border:none;color:#9a9ab0}
.gshead{display:flex;align-items:center;gap:9px;padding:4px 14px 10px;background:#181823;border-bottom:1px solid #2a2a36}
.gsdot{width:12px;height:12px;border-radius:50%;flex:0 0 auto}
.gstitle{flex:1;min-width:0;color:#edeef5;font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gscount{color:#8f90a6;font-size:11px;font-weight:800;background:#2b2b3a;border-radius:9px;padding:2px 8px}
.gschips{display:flex;gap:6px;overflow-x:auto;padding:8px 14px 0;background:#181823}
.gschips .gbadge{border:none;font-size:11px;padding:4px 9px;opacity:.55;flex:0 0 auto}
.gschips .gbadge.on{opacity:1}
.gslist{overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:6px 8px 8px;min-height:0}
.gsrow{display:flex;align-items:center;gap:11px;padding:10px;border-radius:11px;color:#edeef5;cursor:pointer}
.gsrow.on{background:#1c2740;box-shadow:inset 3px 0 0 #5b8cff}
.gsrow:active{background:#22222f}
.gsrow .av{width:30px;height:30px}
.gsrow .body{min-width:0;flex:1}
.gsrow .t{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gsrow .u{font-size:11px;color:#8f90a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.gsrow .rb{background:none;border:none;color:var(--dim);padding:6px;border-radius:8px}
.gsfoot{display:flex;justify-content:space-between;align-items:center;padding:6px 12px 12px;gap:8px;flex:0 0 auto}
.gsfoot .h{font-size:10.5px;color:var(--dim)}

.narrow header{padding:15px 11px 9px}
.narrow .sec{padding:8px 8px 14px}
.narrow nav button{font-size:10px}
@media (prefers-reduced-motion:reduce){.sheet,.backdrop,.toast{transition:none}}
`;

    /* ===================================================================== *
     *  DOM scaffolding: closed shadow root, a layer that tracks the visual
     *  viewport (and undoes the zoom-out of non-mobile sites on phones)
     * ===================================================================== */
    let hostEl = null, root = null, layer = null, uiScale = 1;
    const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    };
    const $ = s => root && root.querySelector(s);
    const COARSE = pick(() => matchMedia('(pointer: coarse)').matches) || false;

    function ensureUI() {
        if (hostEl) {
            if (!hostEl.isConnected) (document.documentElement || document.body).appendChild(hostEl);
            return;
        }
        hostEl = document.createElement('tab-vault-ui');
        hostEl.setAttribute('style', 'all:initial !important;display:block !important;position:fixed !important;' +
            'top:0 !important;left:0 !important;width:0 !important;height:0 !important;' +
            'z-index:2147483646 !important;pointer-events:none !important;');
        root = hostEl.attachShadow({ mode: 'closed' });
        const st = document.createElement('style');
        st.textContent = CSS;
        root.appendChild(st);
        layer = el('div', 'layer');
        root.appendChild(layer);
        // Keystrokes typed into our inputs must not reach page shortcuts
        // (YouTube's "k", "f"…): stop them at the shadow boundary.
        ['keydown', 'keyup', 'keypress'].forEach(type => layer.addEventListener(type, e => {
            e.stopPropagation();
            if (type === 'keydown' && e.key === 'Escape') {
                if (modalStack.length) modalStack[modalStack.length - 1]();
                else closeSheets();
            }
        }));
        layer.addEventListener('wheel', e => {
            if (e.target && e.target.classList && e.target.classList.contains('backdrop') && e.cancelable) e.preventDefault();
        }, { passive: false });
        (document.documentElement || document.body).appendChild(hostEl);
        layoutLayer();
        const vv = window.visualViewport;
        let raf = 0;
        const relayout = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; layoutLayer(); }); };
        if (vv) { vv.addEventListener('resize', relayout); vv.addEventListener('scroll', relayout); }
        addEventListener('resize', relayout);
    }
    function layoutLayer() {
        if (!layer) return;
        const vv = window.visualViewport;
        const w = vv ? vv.width : innerWidth, h = vv ? vv.height : innerHeight;
        const ox = vv ? vv.offsetLeft : 0, oy = vv ? vv.offsetTop : 0;
        let k = 1;
        if (COARSE && screen && screen.width > 0) {
            const sw = screen.width, sh = screen.height;
            const nat = ((w > h) === (sw > sh)) ? sw : sh;
            const r = w / nat;
            if (r > 1.15 || r < 0.87) k = Math.max(0.35, Math.min(4, r));
        }
        uiScale = k;
        const W = w / k, H = h / k;
        layer.style.cssText = `left:${ox}px;top:${oy}px;width:${W}px;height:${H}px;transform:scale(${k})`;
        layer.classList.toggle('wide', W >= 700);
        layer.classList.toggle('narrow', W < 370);
        placeFab();
    }
    function layerSize() {
        const r = layer ? { w: parseFloat(layer.style.width) || innerWidth, h: parseFloat(layer.style.height) || innerHeight } : { w: innerWidth, h: innerHeight };
        return r;
    }

    /* ------------------------------- toast ------------------------------- */
    let toastEl = null, toastT = null;
    function toast(msg) {
        ensureUI();
        if (!toastEl) { toastEl = el('div', 'toast'); layer.appendChild(toastEl); }
        toastEl.textContent = msg;
        layer.appendChild(toastEl);   // keep it on top
        requestAnimationFrame(() => toastEl.classList.add('show'));
        clearTimeout(toastT);
        toastT = setTimeout(() => toastEl.classList.remove('show'), 2800);
    }

    /* ------------------------------- modals ------------------------------- */
    const modalStack = [];
    function openModal(title, onCancel) {
        ensureUI();
        const m = el('div', 'modal');
        const mp = el('div', 'mp');
        const h = el('h3', null, title);
        const mb = el('div', 'mb');
        mp.appendChild(h); mp.appendChild(mb); m.appendChild(mp);
        const sec = sheet && getComputedStyle(sheet).getPropertyValue('--sec');
        if (sec) mp.style.setProperty('--sec', sec.trim());
        const cancel = () => { close(); onCancel(); };
        const close = () => { m.remove(); const i = modalStack.indexOf(cancel); if (i >= 0) modalStack.splice(i, 1); };
        m.addEventListener('click', e => { if (e.target === m) cancel(); });
        modalStack.push(cancel);
        layer.appendChild(m);
        return { m, mb, close, cancel };
    }
    function btnRow(buttons) {
        const r = el('div', 'btnrow'); r.style.marginTop = '6px';
        buttons.forEach(b => r.appendChild(b));
        return r;
    }
    function askText(title, initial, extra) {
        return new Promise(resolve => {
            const md = openModal(title, () => resolve(null));
            const input = el('input'); input.type = 'text'; input.value = initial || '';
            md.mb.appendChild(input);
            let picked = extra && extra.colors ? (extra.color || 'blue') : null;
            if (extra && extra.colors) md.mb.appendChild(swatches(picked, c => { picked = c; }));
            const ok = () => { md.close(); resolve({ text: input.value.trim(), color: picked }); };
            input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
            md.mb.appendChild(btnRow([mk('Cancel', md.cancel), mk('OK', ok, 'p')]));
            setTimeout(() => { try { input.focus(); input.select(); } catch (e) {} }, 60);
        });
    }
    function swatches(picked, onPick) {
        const sw = el('div', 'swatches');
        GROUP_COLORS.forEach(c => {
            const b = el('button', 'swatch g-' + c + (c === picked ? ' on' : ''));
            b.type = 'button'; b.title = c;
            b.onclick = () => { onPick(c); sw.querySelectorAll('.swatch').forEach(x => x.classList.remove('on')); b.classList.add('on'); };
            sw.appendChild(b);
        });
        return sw;
    }
    function askTextarea(title, placeholder, okLabel) {
        return new Promise(resolve => {
            const md = openModal(title, () => resolve(null));
            const ta = el('textarea'); ta.spellcheck = false; ta.placeholder = placeholder || '';
            md.mb.appendChild(ta);
            md.mb.appendChild(btnRow([mk('Cancel', md.cancel), mk(okLabel || 'Import', () => { md.close(); resolve(ta.value.trim()); }, 'p')]));
            setTimeout(() => { try { ta.focus(); } catch (e) {} }, 60);
        });
    }
    function showText(title, text) {
        const md = openModal(title, () => {});
        const ta = el('textarea'); ta.value = text; ta.readOnly = true;
        md.mb.appendChild(ta);
        md.mb.appendChild(el('div', 'mh', 'Long-press / select all and copy it by hand — the browser blocked automatic copying.'));
        md.mb.appendChild(btnRow([mk('Close', md.cancel, 'p')]));
        setTimeout(() => { try { ta.focus(); ta.select(); } catch (e) {} }, 60);
    }
    function confirmBox(msg, okLabel, danger) {
        return new Promise(resolve => {
            const md = openModal(msg, () => resolve(false));
            md.mb.appendChild(btnRow([mk('Cancel', md.cancel), mk(okLabel || 'OK', () => { md.close(); resolve(true); }, danger ? 'd' : 'p')]));
        });
    }
    function choice(title, options, hint) {
        return new Promise(resolve => {
            const md = openModal(title, () => resolve(null));
            options.forEach(o => {
                const b = mk(o.label, () => { md.close(); resolve(o.v); }, o.cls || '', o.icon);
                b.style.width = '100%';
                md.mb.appendChild(b);
            });
            const c = mk('Cancel', md.cancel); c.style.width = '100%';
            md.mb.appendChild(c);
            if (hint) md.mb.appendChild(el('div', 'mh', hint));
        });
    }
    /* Pick an existing Tab Vault group or create one. */
    function pickGroup(count) {
        return new Promise(resolve => {
            const md = openModal('Add ' + plural(count, 'tab') + ' to a group', () => resolve(null));
            const groups = gv(K.SAVED_GROUPS, []).filter(hasTabs);
            if (groups.length) {
                const list = el('div', 'gpick');
                groups.forEach(g => {
                    const b = el('button', 'btn sm');
                    const badge = el('span', 'gbadge g-' + safeColor(g.color), g.name || 'group');
                    b.appendChild(badge);
                    b.appendChild(el('span', 'pill', plural(g.tabs.length, 'tab')));
                    b.onclick = () => { md.close(); resolve({ id: g.id }); };
                    list.appendChild(b);
                });
                md.mb.appendChild(list);
                md.mb.appendChild(el('div', 'mh', 'or start a new group:'));
            }
            const input = el('input'); input.type = 'text'; input.placeholder = 'New group name';
            md.mb.appendChild(input);
            let color = 'blue';
            md.mb.appendChild(swatches(color, c => { color = c; }));
            const create = () => { md.close(); resolve({ name: input.value.trim() || 'Group', color }); };
            input.addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
            md.mb.appendChild(btnRow([mk('Cancel', md.cancel), mk('Create group', create, 'v', 'folderPlus')]));
        });
    }
    const safeColor = c => GROUP_COLORS.includes(c) ? c : 'grey';

    /* --------------------------- UI building --------------------------- */
    function mk(label, fn, cls, icon) {
        const b = el('button', 'btn sm' + (cls ? ' ' + cls : ''));
        b.type = 'button';
        b.innerHTML = (icon ? svg(icon, 13) : '') + '<span></span>';
        b.querySelector('span').textContent = label;
        b.onclick = fn;
        return b;
    }
    function sechead(icon, text, alt) {
        const d = el('div', 'sechead' + (alt ? ' alt' : ''));
        d.innerHTML = svg(icon, 14) + '<span class="st"></span><span class="rule"></span>';
        d.querySelector('.st').textContent = text;
        return d;
    }
    /* parts: strings, or {b: text} for bold — never HTML */
    function emptyState(icon, parts) {
        const d = el('div', 'empty');
        d.innerHTML = `<div class="eico">${svg(icon, 26)}</div>`;
        appendParts(d, parts);
        return d;
    }
    function appendParts(node, parts) {
        (Array.isArray(parts) ? parts : [parts]).forEach(p => {
            if (p == null) return;
            if (typeof p === 'string') node.appendChild(document.createTextNode(p));
            else if (p.b != null) node.appendChild(el('b', null, p.b));
            else if (p.br) node.appendChild(el('br'));
            else if (p.code != null) node.appendChild(el('code', null, p.code));
        });
    }
    function noteCard(parts, cls) {
        const n = el('div', 'card ' + (cls || 'note'));
        const cm = el('div', 'cm');
        appendParts(cm, parts);
        n.appendChild(cm);
        return n;
    }
    function domainHue(u) {
        const h = host(u) || '';
        let n = 0;
        for (let i = 0; i < h.length; i++) n = (n * 31 + h.charCodeAt(i)) >>> 0;
        return n % 360;
    }
    function avatarFor(t) {
        const a = el('div', 'av');
        const hue = domainHue(t.url);
        a.style.background = `linear-gradient(135deg,hsl(${hue} 62% 46%),hsl(${(hue + 28) % 360} 62% 36%))`;
        a.textContent = (host(t.url) || '?').replace(/^[^a-z0-9]*/i, '').charAt(0) || '?';
        const fav = t.favIconUrl || t.fav;
        if (settings.showFavicons && fav && /^https?:/i.test(fav)) {
            const img = el('img');
            img.referrerPolicy = 'no-referrer';
            img.decoding = 'async';
            img.alt = '';
            img.onload = () => { a.textContent = ''; a.style.background = 'var(--bg3)'; a.appendChild(img); };
            img.onerror = () => {};
            img.src = fav;
        }
        return a;
    }
    function groupsForUrl(u, groups) {
        const n = normUrl(u);
        return (groups || gv(K.SAVED_GROUPS, [])).filter(g => hasTabs(g) && g.tabs.some(t => t && normUrl(t.url) === n));
    }

    /* ===================================================================== *
     *  Manager sheet
     * ===================================================================== */
    const state = {
        section: 'open', query: '',
        selected: new Set(), closedSel: new Set(), histSel: new Set(),
        openRows: [], closedShown: { wins: [], tabs: [] }, histShown: [],
        histRange: 'today', histDate: '', histMax: 300, histFrom: '', histTo: '',
        rowOrder: [], lastSelIdx: -1, prevSection: null, expanded: new Set(), tmConfirmed: false
    };
    let sheet = null, backdrop = null, footerFor = '';

    const SHEET_HTML = `
<header>
  <span class="grip"></span>
  <span class="logo" data-ico="vault"></span>
  <h1>Tab Vault<small>userscript</small></h1>
  <button class="icon" data-act="refresh" data-ico="refresh" title="Refresh"></button>
  <button class="icon" data-act="close" data-ico="x" title="Close"></button>
</header>
<nav>
  <button data-sec="open"     data-ico="layers"><span class="ni"></span><span class="nl">Open <em data-c="open"></em></span></button>
  <button data-sec="groups"   data-ico="folder"><span class="ni"></span><span class="nl">Groups <em data-c="groups"></em></span></button>
  <button data-sec="closed"   data-ico="history"><span class="ni"></span><span class="nl">Closed <em data-c="closed"></em></span></button>
  <button data-sec="hist"     data-ico="calendar"><span class="ni"></span><span class="nl">History</span></button>
  <button data-sec="saved"    data-ico="bookmark"><span class="ni"></span><span class="nl">Saved <em data-c="saved"></em></span></button>
  <button data-sec="settings" data-ico="sliders"><span class="ni"></span><span class="nl">Setup</span></button>
</nav>
<div class="searchbar">
  <div class="searchwrap"><span data-ico="search"></span><input class="search" type="search" placeholder="Search title or URL…" autocomplete="off"></div>
  <button class="icon" data-act="selall" data-ico="checkAll" title="Select all shown"></button>
  <button class="icon" data-act="selnone" data-ico="square" title="Clear selection"></button>
</div>
<div class="main">
  <section data-s="open" class="sec"></section>
  <section data-s="groups" class="sec hidden"></section>
  <section data-s="closed" class="sec hidden"></section>
  <section data-s="hist" class="sec hidden"></section>
  <section data-s="saved" class="sec hidden"></section>
  <section data-s="settings" class="sec hidden"></section>
</div>
<div class="jobbar hidden"><span class="spin" data-ico="loader"></span><span class="jt"></span><button class="link" data-act="jobcancel">Cancel</button></div>
<footer class="hidden"><div class="selinfo"><span data-ico="check"></span><b class="selcount">0</b> selected</div><div class="btns"></div></footer>`;

    const box = s => sheet && sheet.querySelector('section[data-s="' + s + '"]');
    const sq = s => sheet && sheet.querySelector(s);

    function openManager(sec) {
        ensureUI();
        closeSheets(true);
        if (sec && SECTIONS.includes(sec)) state.section = sec;
        backdrop = el('div', 'backdrop');
        backdrop.onclick = () => closeSheets();
        layer.appendChild(backdrop);
        sheet = el('div', 'sheet');
        sheet.innerHTML = SHEET_HTML;   // static markup only
        paintIcons(sheet);
        footerFor = '';
        layer.appendChild(sheet);
        wireSheet();
        sheet.addEventListener('touchstart', () => { lastSheetTouch = now(); }, { passive: true, capture: true });
        sheet.addEventListener('pointerdown', () => { lastSheetTouch = now(); }, { capture: true });
        attachDrag(sheet, sheet.querySelector('header'));
        requestAnimationFrame(() => { if (backdrop) backdrop.classList.add('show'); if (sheet) sheet.classList.add('show'); });
        sweep().then(() => render());
        render();
        startManagerPoll();
    }
    function closeSheets(immediate) {
        stopManagerPoll();
        modalStack.slice().forEach(c => c());
        const parts = [backdrop, sheet, gsheet].filter(Boolean);
        backdrop = null; sheet = null; gsheet = null;
        parts.forEach(p => {
            if (immediate) { p.remove(); return; }
            p.classList.remove('show');
            p.style.transform = '';
            setTimeout(() => p.remove(), 280);
        });
    }
    /* Drag-down-to-close (ported from the extension's in-page sheet). */
    function attachDrag(sh, handle) {
        let sy = 0, dy = 0, dragging = false, lastY = 0, lastT = 0, vel = 0;
        handle.addEventListener('touchstart', e => {
            if (e.target.closest && e.target.closest('button')) return;
            dragging = true; sy = lastY = e.touches[0].clientY; dy = 0; vel = 0; lastT = now();
            sh.style.transition = 'none';
        }, { passive: true });
        handle.addEventListener('touchmove', e => {
            if (!dragging) return;
            const y = e.touches[0].clientY, t = now();
            if (t > lastT) vel = (y - lastY) / (t - lastT);
            lastY = y; lastT = t;
            dy = Math.max(0, (y - sy) / uiScale);
            sh.style.transform = `translateY(${dy}px)`;
        }, { passive: true });
        const end = () => {
            if (!dragging) return;
            dragging = false;
            sh.style.transition = '';
            if (dy > 80 || (dy > 24 && vel > 0.45)) closeSheets();
            else sh.style.transform = '';
        };
        handle.addEventListener('touchend', end, { passive: true });
        handle.addEventListener('touchcancel', end, { passive: true });
    }

    function wireSheet() {
        sheet.querySelectorAll('nav button').forEach(b => {
            b.onclick = () => { state.section = b.getAttribute('data-sec'); render(); };
        });
        const search = sq('.search');
        search.value = state.query;
        search.addEventListener('input', () => { state.query = search.value.trim(); render(); });
        sq('[data-act="close"]').onclick = () => closeSheets();
        sq('[data-act="refresh"]').onclick = async () => { await sweep(); render(); toast('Refreshed'); };
        sq('[data-act="jobcancel"]').onclick = cancelJob;
        sq('[data-act="selall"]').onclick = () => {
            if (state.section === 'closed') {
                state.closedShown.wins.forEach(w => state.closedSel.add(w.id));
                state.closedShown.tabs.forEach(t => state.closedSel.add(t.id));
            } else if (state.section === 'hist') state.histShown.forEach(h => state.histSel.add(h.url));
            else if (state.section === 'open') state.openRows.filter(matches).forEach(t => state.selected.add(t.id));
            rerenderList();
        };
        sq('[data-act="selnone"]').onclick = () => { const s = sectionSelection(); if (s) s.clear(); rerenderList(); };
        updateJobBar();
    }

    /* Live refresh while the sheet is open: listener-driven where possible,
     * a light poll otherwise (and for TM's tab list, which has no events). */
    let mgrPoll = null, liveRerender = null;
    function startManagerPoll() {
        stopManagerPoll();
        mgrPoll = setInterval(() => {
            if (!sheet) return stopManagerPoll();
            if (state.section === 'open' && (!CAN_LISTEN || API.getTabs)) renderSoft();
        }, CAN_LISTEN ? 6000 : 3000);
    }
    function stopManagerPoll() { clearInterval(mgrPoll); mgrPoll = null; }
    function liveChanged() {
        updateFabCount();
        if (sheet && state.section === 'open') {
            clearTimeout(liveRerender);
            liveRerender = setTimeout(renderSoft, 400);
        }
    }
    /* Re-render without disturbing scroll, and not mid-gesture or mid-modal. */
    let lastSheetTouch = 0;
    function renderSoft() {
        if (!sheet || modalStack.length) return;
        if (now() - lastSheetTouch < 1500) { clearTimeout(liveRerender); liveRerender = setTimeout(renderSoft, 1500); return; }
        const main = sq('.main'); const top = main ? main.scrollTop : 0;
        render().then(() => { const m = sq('.main'); if (m) m.scrollTop = top; });
    }

    function matches(t) {
        if (!state.query) return true;
        const q = state.query.toLowerCase();
        return String(t.title || '').toLowerCase().includes(q) || String(t.url || '').toLowerCase().includes(q);
    }
    function sectionSelection() {
        if (state.section === 'open') return state.selected;
        if (state.section === 'closed') return state.closedSel;
        if (state.section === 'hist') return state.histSel;
        return null;
    }

    let renderSeq = 0;
    async function render() {
        if (!sheet) return;
        const seq = ++renderSeq;
        const s = state.section;
        if (state.prevSection !== s) { state.lastSelIdx = -1; state.prevSection = s; }
        sheet.setAttribute('data-sec', s);
        sheet.querySelectorAll('.sec').forEach(x => x.classList.toggle('hidden', x.getAttribute('data-s') !== s));
        sheet.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.getAttribute('data-sec') === s));
        sq('.searchbar').classList.toggle('hidden', s === 'settings');
        if (s === 'open') state.openRows = await loadOpenRows();
        if (seq !== renderSeq || !sheet) return;   // a newer render superseded this one
        try {
            if (s === 'open') renderOpen();
            else if (s === 'groups') renderGroups();
            else if (s === 'closed') renderClosed();
            else if (s === 'hist') renderHist();
            else if (s === 'saved') renderSaved();
            else renderSettings();
        } catch (e) {
            const b = box(s); b.textContent = '';
            b.appendChild(emptyState('alert', ['Something went wrong: ', { b: String((e && e.message) || e) }]));
        }
        renderCounts();
        renderActions();
    }
    function rerenderList() { render(); }

    function renderCounts() {
        if (!sheet) return;
        const set = (k, n) => { const e = sheet.querySelector('em[data-c="' + k + '"]'); if (e) e.textContent = n ? String(n) : ''; };
        set('open', state.openRows.length);
        set('groups', gv(K.SAVED_GROUPS, []).length);
        set('closed', gv(K.CLOSED_WINDOWS, []).length + gv(K.CLOSED_TABS, []).length);
        set('saved', gv(K.SESSIONS, []).length);
    }

    /* ------------------------- range selection ------------------------- */
    function selectRangeTo(index) {
        const sel = sectionSelection();
        if (!sel) return;
        const a = state.lastSelIdx >= 0 ? Math.min(state.lastSelIdx, index) : index;
        const b = state.lastSelIdx >= 0 ? Math.max(state.lastSelIdx, index) : index;
        for (let i = a; i <= b; i++) { const id = state.rowOrder[i]; if (id !== undefined) sel.add(id); }
        state.lastSelIdx = index;
        rerenderList();
    }
    function rangeSelectable(cb, index) {
        cb.addEventListener('change', e => {
            if (cb.__lp) { cb.__lp = false; e.stopImmediatePropagation(); return; }
            state.lastSelIdx = index;
        });
        let timer = null, fired = false;
        cb.addEventListener('touchstart', () => {
            fired = false;
            timer = setTimeout(() => { fired = true; cb.__lp = true; selectRangeTo(index); }, 420);
        }, { passive: true });
        cb.addEventListener('touchmove', () => clearTimeout(timer), { passive: true });
        cb.addEventListener('touchcancel', () => clearTimeout(timer));
        cb.addEventListener('touchend', e => { clearTimeout(timer); if (fired && e.cancelable) e.preventDefault(); });
        cb.addEventListener('contextmenu', e => { if (fired) e.preventDefault(); });
        cb.addEventListener('click', e => {
            if (e.shiftKey && state.lastSelIdx >= 0 && state.lastSelIdx !== index) { e.preventDefault(); selectRangeTo(index); }
        });
    }
    function selBox(set, id, onToggle) {
        const cb = el('input'); cb.type = 'checkbox';
        cb.checked = set.has(id);
        rangeSelectable(cb, state.rowOrder.push(id) - 1);
        cb.addEventListener('change', () => {
            if (cb.checked) set.add(id); else set.delete(id);
            if (onToggle) onToggle(cb.checked);
            renderActions();
        });
        cb.addEventListener('click', e => e.stopPropagation());
        return cb;
    }

    /* ------------------------------- Open ------------------------------- */
    async function loadOpenRows() {
        const tm = await tmTabs();
        state.tmConfirmed = !!tm;
        const live = readLive();
        const t = now();
        const hb = settings.heartbeatSec * 1000;
        const stale = settings.staleMin * 60000;
        const ids = new Set(Object.keys(live));
        if (tm) Object.keys(tm).forEach(id => ids.add(id));
        const rows = [];
        ids.forEach(id => {
            let e = live[id];
            const te = tm && tm[id];
            if (tm && !te) return;                       // Tampermonkey says: gone
            if (te && (!e || (te.seen || 0) > (e.seen || 0) + 1000)) {
                e = Object.assign({}, e || {}, { id, url: te.url || (e && e.url), title: te.title || (e && e.title) || '',
                    fav: te.fav || (e && e.fav) || '', seen: te.seen || (e && e.seen) || t });
            }
            if (!e || !e.url) return;
            if (id !== TAB_ID) {
                if (e.gone && !te) return;               // unloading / closing
                if (!te && t - e.seen > stale) return;   // lost contact (sweep files it)
            }
            const isSelf = id === TAB_ID;
            const ago = t - (e.seen || 0);
            const status = isSelf ? 'this' : (e.vis && ago < hb * 2.5) ? 'active' : (ago < hb * 4 ? 'live' : 'quiet');
            rows.push({ id, url: isSelf ? location.href : e.url, title: isSelf ? document.title : (e.title || ''),
                fav: e.fav || '', seen: isSelf ? t : e.seen, foc: e.foc || 0, status, confirmed: !!te });
        });
        if (TAB_ID && !rows.some(r => r.id === TAB_ID)) {
            rows.push({ id: TAB_ID, url: location.href, title: document.title, fav: faviconUrl(), seen: t, foc: t, status: 'this', confirmed: false, untracked: !trackingOn() });
        }
        rows.sort((a, b) => (a.status === 'this' ? -1 : b.status === 'this' ? 1 : 0) || (Math.max(b.foc, 0) - Math.max(a.foc, 0)) || (b.seen - a.seen));
        // drop selections of tabs that vanished
        const present = new Set(rows.map(r => r.id));
        state.selected.forEach(id => { if (!present.has(id)) state.selected.delete(id); });
        return rows;
    }
    function liveCount() {
        const live = readLive(); const t = now(); const stale = settings.staleMin * 60000;
        let n = 0;
        for (const id in live) { const e = live[id]; if (e && (id === TAB_ID || (!e.gone && t - e.seen < stale))) n++; }
        return n;
    }

    function renderOpen() {
        const b = box('open'); b.textContent = '';
        state.rowOrder = [];
        const rows = state.openRows.filter(matches);
        const groups = gv(K.SAVED_GROUPS, []);
        const wg = el('div', 'wingroup');
        const head = el('div', 'winhead');
        head.innerHTML = `<span class="wi">${svg('window', 15)}</span><span class="wt"></span>`;
        head.querySelector('.wt').textContent = 'Tabs running Tab Vault · ' + state.openRows.length;
        const selBtn = el('button', 'link', 'select all');
        selBtn.onclick = () => { rows.forEach(t => state.selected.add(t.id)); rerenderList(); };
        const saveBtn = el('button', 'link', 'save');
        saveBtn.title = 'Save all of these as a session';
        saveBtn.onclick = () => saveSession(state.openRows, 'Open tabs');
        head.appendChild(selBtn); head.appendChild(saveBtn);
        wg.appendChild(head);
        rows.forEach(t => wg.appendChild(openRow(t, groups)));
        if (rows.length) b.appendChild(wg);
        else b.appendChild(emptyState(state.query ? 'search' : 'layers', state.query ? ['No tabs match ', { b: state.query }, '.'] : 'No open tabs found.'));

        const note = state.tmConfirmed
            ? [{ b: 'Tampermonkey' }, ' confirms which of these tabs are still open. Only tabs where Tab Vault has run are listed — the browser’s own tab list is out of a userscript’s reach.']
            : ['Listed: tabs where Tab Vault has run (a userscript can’t read the browser’s tab list). Tabs asleep in the background show when they were last heard from; tabs opened before you installed appear once you visit them.'];
        if (MODE === 'local') note.push({ br: 1 }, { br: 1 }, { b: 'No GM storage in this manager' }, ' — only tabs on this site can be seen.');
        b.appendChild(noteCard(note, 'info'));
    }
    function openRow(t, groups) {
        const row = el('div', 'row' + (state.selected.has(t.id) ? ' sel' : '') + (t.status === 'quiet' ? ' quiet' : ''));
        const cb = selBox(state.selected, t.id, on => row.classList.toggle('sel', on));
        const body = el('div', 'body');
        body.appendChild(el('div', 't', t.title || host(t.url)));
        body.appendChild(el('div', 'u', host(t.url)));
        const meta = el('div', 'meta');
        if (t.status === 'this') meta.appendChild(el('span', 'cur', 'this tab'));
        else if (t.status === 'active') meta.appendChild(el('span', 'live', '● active'));
        else if (t.status === 'live') meta.appendChild(el('span', 'live', '● open'));
        else meta.appendChild(el('span', null, 'last heard ' + relTime(t.seen)));
        if (t.confirmed && t.status !== 'this') meta.appendChild(el('span', 'pill', 'TM ✓'));
        if (t.untracked) meta.appendChild(el('span', 'pill', 'not tracked'));
        groupsForUrl(t.url, groups).slice(0, 3).forEach(g => meta.appendChild(el('span', 'gbadge g-' + safeColor(g.color), g.name || 'group')));
        body.appendChild(meta);
        body.onclick = () => focusTab(t);
        const x = el('button', 'rb'); x.innerHTML = svg('x', 16); x.title = 'Close tab'; x.type = 'button';
        x.onclick = async e => {
            e.stopPropagation();
            const r = await closeTabs([t]);
            toast(closeSummary(r));
            render();
        };
        row.appendChild(cb); row.appendChild(avatarFor(t)); row.appendChild(body); row.appendChild(x);
        return row;
    }
    async function focusTab(t) {
        if (t.id === TAB_ID) { closeSheets(); return; }
        toast('Asking that tab to come forward…');
        const r = await sendCmd(t.id, 'focus');
        if (r === 'ok') { closeSheets(); return; }
        if (r === 'nochange') toast('The browser didn’t switch tabs (userscripts usually can’t) — switch to it yourself');
        else toast('No answer — that tab is asleep or gone');
    }
    async function closeTabs(tabs) {
        const res = { ok: 0, refused: 0, noanswer: 0, self: false };
        const others = tabs.filter(t => t.id !== TAB_ID);
        const answers = await Promise.all(others.map(t => sendCmd(t.id, 'close')));
        answers.forEach(a => { if (a === 'ok') res.ok++; else if (a === 'refused') res.refused++; else res.noanswer++; });
        if (others.length) { await sleep(300); await sweep(); }
        if (tabs.some(t => t.id === TAB_ID)) {
            res.self = true;
            try { window.close(); } catch (e) {}
            await sleep(400);
            res.refused++;   // still here: the browser refused
        }
        return res;
    }
    function closeSummary(r) {
        const parts = [];
        if (r.ok) parts.push('Closed ' + r.ok);
        if (r.refused) parts.push(r.refused + ' refused by the browser (only tabs opened by script can be closed, unless your manager grants window.close)');
        if (r.noanswer) parts.push(r.noanswer + ' didn’t answer (asleep in the background?)');
        return parts.join(' · ') || 'Nothing closed';
    }

    /* ------------------------------ Groups ------------------------------ */
    function renderGroups() {
        const b = box('groups'); b.textContent = '';
        const groups = gv(K.SAVED_GROUPS, []).filter(hasTabs)
            .filter(g => !state.query || String(g.name || '').toLowerCase().includes(state.query.toLowerCase()) || g.tabs.some(matches));
        b.appendChild(noteCard(['A userscript can’t see or change your browser’s own tab groups, so these are ', { b: 'Tab Vault groups' },
            ' — kept by the script, restorable as a set, and in the same format as the extension’s saved groups (export/import carries them across). Add tabs from Open, History or Closed; the compact switcher (gesture or menu) shows the group of the page you’re on.']));
        const bar = el('div', 'cb'); bar.style.marginBottom = '11px';
        bar.appendChild(mk('New group', async () => {
            const r = await askText('New group', '', { colors: true });
            if (!r) return;
            createGroup(r.text || 'Group', r.color || 'blue', []);
            render();
        }, 'v', 'folderPlus'));
        bar.appendChild(mk('Add this page', async () => {
            const g = await pickGroup(1);
            if (!g) return;
            addToGroup(g, [{ url: location.href, title: document.title }]);
            render();
        }, '', 'plus'));
        b.appendChild(bar);
        b.appendChild(sechead('bookmark', 'Tab Vault groups'));
        if (!groups.length) {
            b.appendChild(emptyState('folderPlus', state.query ? ['No group matches ', { b: state.query }, '.']
                : ['No groups yet.', { br: 1 }, 'Select tabs in ', { b: 'Open' }, ' and tap ', { b: 'Group' }, '.']));
            return;
        }
        const liveUrls = new Set(state.openRows.map(r => normUrl(r.url)).concat(Object.values(readLive()).filter(e => e && !e.gone).map(e => normUrl(e.url))));
        groups.forEach(g => b.appendChild(groupCard(g, liveUrls)));
    }
    function groupCard(g, liveUrls) {
        const c = el('div', 'card');
        c.style.borderLeftColor = 'var(--violet)';
        const ch = el('div', 'ch');
        ch.appendChild(el('span', 'gbadge g-' + safeColor(g.color), g.name || 'group'));
        ch.appendChild(el('span', 'ct'));
        const openN = g.tabs.filter(t => liveUrls.has(normUrl(t.url))).length;
        ch.appendChild(el('span', 'cnt', plural(g.tabs.length, 'tab') + (openN ? ' · ' + openN + ' open' : '')));
        c.appendChild(ch);
        c.appendChild(el('div', 'cm', 'saved ' + relTime(g.savedAt || now())));
        c.appendChild(el('div', 'cu', g.tabs.slice(0, 4).map(t => t.title || host(t.url)).join(' · ') || 'empty'));
        if (state.expanded.has(g.id)) {
            const list = el('div', 'gtabs');
            g.tabs.forEach((t, i) => {
                const row = el('div', 'row');
                const body = el('div', 'body');
                body.appendChild(el('div', 't', t.title || host(t.url)));
                body.appendChild(el('div', 'u', host(t.url) + (liveUrls.has(normUrl(t.url)) ? ' · open' : '')));
                body.onclick = () => openTab(t.url, true);
                const x = el('button', 'rb'); x.type = 'button'; x.innerHTML = svg('x', 15); x.title = 'Remove from group';
                x.onclick = () => { mutateGroup(g.id, gg => { gg.tabs.splice(i, 1); }); render(); };
                row.appendChild(avatarFor(t)); row.appendChild(body); row.appendChild(x);
                list.appendChild(row);
            });
            if (!g.tabs.length) list.appendChild(el('div', 'empty', 'No tabs in this group.'));
            c.appendChild(list);
        }
        const cb = el('div', 'cb');
        cb.appendChild(mk('Restore', () => openUrls(g.tabs.map(t => t.url), 'batch'), 'v', 'restore'));
        cb.appendChild(mk('Switcher', () => openGroupSheet(g.id), '', 'compass'));
        cb.appendChild(mk(state.expanded.has(g.id) ? 'Hide tabs' : 'Tabs', () => {
            if (state.expanded.has(g.id)) state.expanded.delete(g.id); else state.expanded.add(g.id);
            render();
        }, '', 'list'));
        cb.appendChild(mk('Edit', async () => {
            const r = await askText('Edit group', g.name || '', { colors: true, color: safeColor(g.color) });
            if (!r) return;
            mutateGroup(g.id, gg => { gg.name = r.text || gg.name || 'Group'; gg.color = r.color || gg.color; });
            render();
        }, '', 'edit'));
        cb.appendChild(mk('Save', () => saveSession(g.tabs, g.name || 'Group'), 'p', 'save'));
        cb.appendChild(mk('HTML', () => exportBookmarksHtml(g.tabs, g.name), '', 'code'));
        cb.appendChild(mk('Copy', () => copyUrls(g.tabs), '', 'copy'));
        cb.appendChild(mk('Delete', async () => {
            if (!await confirmBox('Delete group “' + (g.name || 'group') + '”?', 'Delete', true)) return;
            gset(K.SAVED_GROUPS, gv(K.SAVED_GROUPS, []).filter(x => x.id !== g.id));
            render();
        }, 'd', 'trash'));
        c.appendChild(cb);
        return c;
    }
    function mutateGroup(id, fn) {
        const list = gv(K.SAVED_GROUPS, []);
        const g = list.find(x => x && x.id === id);
        if (g && hasTabs(g)) { fn(g); gset(K.SAVED_GROUPS, list); }
    }
    function createGroup(name, color, tabs) {
        const list = gv(K.SAVED_GROUPS, []);
        const g = { id: rid('g'), name: name || 'Group', color: safeColor(color || 'blue'), savedAt: now(),
            tabs: (tabs || []).filter(t => isRestorable(t.url)).map(t => ({ url: t.url, title: t.title || '' })) };
        list.unshift(g);
        gset(K.SAVED_GROUPS, list);
        return g;
    }
    function addToGroup(pickRes, items) {
        const usable = (items || []).filter(t => isRestorable(t.url));
        if (!usable.length) { toast('Nothing restorable to add'); return; }
        if (pickRes.id) {
            let added = 0, name = '';
            mutateGroup(pickRes.id, g => {
                name = g.name;
                const have = new Set(g.tabs.map(t => normUrl(t.url)));
                usable.forEach(t => { if (!have.has(normUrl(t.url))) { g.tabs.push({ url: t.url, title: t.title || '' }); have.add(normUrl(t.url)); added++; } });
            });
            toast(added ? `Added ${plural(added, 'tab')} to “${name || 'group'}”` : 'Already in that group');
        } else {
            createGroup(pickRes.name, pickRes.color, usable);
            toast(`Group “${pickRes.name}” · ${plural(usable.length, 'tab')}`);
        }
    }
    async function groupItems(items) {
        if (!items.length) return;
        const g = await pickGroup(items.length);
        if (!g) return;
        addToGroup(g, items);
        sectionSelection() && sectionSelection().clear();
        render();
    }

    /* ------------------------------ Closed ------------------------------ */
    function renderClosed() {
        const b = box('closed'); b.textContent = '';
        const wins = gv(K.CLOSED_WINDOWS, []).filter(hasTabs).filter(w => !state.query || w.tabs.some(matches));
        const tabs = gv(K.CLOSED_TABS, []).filter(hasUrl).filter(matches).slice(0, 300);
        state.closedShown = { wins, tabs };
        state.rowOrder = [];

        b.appendChild(noteCard(['A tab lands here when its page unloads and nothing comes back in that tab within ',
            { b: settings.closedAfterSec + ' s' }, '. Tabs silent for over ', { b: settings.staleMin + ' min' }, ' are filed as “lost contact”.',
            API.getTabs ? ' Tampermonkey’s tab list makes this exact where it answers.' : ' Without Tampermonkey’s tab API, typing a new address into a tab can look like a close, too.']));

        if (wins.length) {
            b.appendChild(sechead('window', 'Closed windows (imported)'));
            wins.forEach(w => {
                const c = el('div', 'card');
                const ch = el('div', 'ch');
                ch.appendChild(selBox(state.closedSel, w.id));
                const ci = el('span', 'ci'); ci.innerHTML = svg('window', 15); ch.appendChild(ci);
                ch.appendChild(el('span', 'ct', plural(w.tabs.length, 'tab')));
                c.appendChild(ch);
                c.appendChild(el('div', 'cm', 'closed ' + relTime(w.closedAt || 0)));
                c.appendChild(el('div', 'cu', w.tabs.slice(0, 5).map(t => t.title || host(t.url)).join(' · ')));
                const cb = el('div', 'cb');
                cb.appendChild(mk('Reopen', () => openUrls(w.tabs.map(t => t.url), 'batch'), 'a', 'restore'));
                cb.appendChild(mk('Save', () => saveSession(w.tabs, 'Closed window'), '', 'save'));
                cb.appendChild(mk('Forget', () => {
                    state.closedSel.delete(w.id);
                    gset(K.CLOSED_WINDOWS, gv(K.CLOSED_WINDOWS, []).filter(x => x.id !== w.id)); render();
                }, 'd', 'trash'));
                c.appendChild(cb);
                b.appendChild(c);
            });
        }

        b.appendChild(sechead('history', 'Closed tabs', wins.length > 0));
        if (!tabs.length) {
            b.appendChild(emptyState('history', state.query ? ['Nothing closed matches ', { b: state.query }, '.'] : 'No closed tabs captured yet.'));
            return;
        }
        const bar = el('div', 'cb'); bar.style.marginBottom = '8px';
        bar.appendChild(mk('Reopen all shown', () => openUrls(tabs.map(t => t.url), 'batch'), 'a', 'restore'));
        bar.appendChild(mk('Clear list', async () => {
            if (!await confirmBox('Clear the closed-tabs list?', 'Clear', true)) return;
            state.closedSel.clear(); gset(K.CLOSED_TABS, []); render();
        }, 'd', 'trash'));
        b.appendChild(bar);
        tabs.forEach(t => {
            const row = el('div', 'row' + (state.closedSel.has(t.id) ? ' sel' : ''));
            const cb = selBox(state.closedSel, t.id, on => row.classList.toggle('sel', on));
            const body = el('div', 'body');
            body.appendChild(el('div', 't', t.title || host(t.url)));
            body.appendChild(el('div', 'u', host(t.url) + ' · ' + relTime(t.closedAt || 0)));
            if (t.lost) { const meta = el('div', 'meta'); meta.appendChild(el('span', 'pill', 'lost contact — may still be open')); body.appendChild(meta); }
            body.onclick = () => { openTab(t.url, true) || toast('Pop-up blocked'); };
            const x = el('button', 'rb go'); x.type = 'button'; x.innerHTML = svg('restore', 16); x.title = 'Reopen';
            x.onclick = () => { openTab(t.url, true) || toast('Pop-up blocked'); };
            row.appendChild(cb); row.appendChild(avatarFor(t)); row.appendChild(body); row.appendChild(x);
            b.appendChild(row);
        });
    }
    function closedSelItems() {
        const out = [];
        for (const w of state.closedShown.wins) if (state.closedSel.has(w.id)) w.tabs.forEach(t => out.push({ url: t.url, title: t.title }));
        for (const t of state.closedShown.tabs) if (state.closedSel.has(t.id)) out.push({ url: t.url, title: t.title });
        return out;
    }
    async function forgetClosedSelected() {
        const n = state.closedSel.size;
        if (!await confirmBox(`Forget ${n} selected entr${n === 1 ? 'y' : 'ies'}?`, 'Forget', true)) return;
        gset(K.CLOSED_WINDOWS, gv(K.CLOSED_WINDOWS, []).filter(w => !state.closedSel.has(w.id)));
        gset(K.CLOSED_TABS, gv(K.CLOSED_TABS, []).filter(t => !state.closedSel.has(t.id)));
        state.closedSel.clear();
        render();
    }

    /* ------------------------------ History ------------------------------ */
    function histRangeBounds() {
        const DAY = 86400000;
        const midnight = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
        const t = now(), today = midnight(t);
        switch (state.histRange) {
            case 'today':     return { start: today, end: t + 1 };
            case 'yesterday': return { start: today - DAY, end: today };
            case '7d':        return { start: today - 7 * DAY, end: t + 1 };
            case '30d':       return { start: today - 30 * DAY, end: t + 1 };
            case 'day': {
                const d = state.histDate ? midnight(state.histDate + 'T12:00:00') : today;
                return { start: d, end: d + DAY };
            }
            default:          return { start: 0, end: t + 1 };   // 'all'
        }
    }
    function renderHist() {
        const b = box('hist'); b.textContent = '';
        const bar = el('div', 'histbar');
        bar.innerHTML = `
          <div class="hrow">
            <select data-h="range">
              <option value="today">Today</option><option value="yesterday">Yesterday</option>
              <option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
              <option value="day">Pick a day…</option><option value="all">All time</option>
            </select>
            <input type="date" data-h="date">
            <input type="number" data-h="max" min="20" max="5000" step="20" title="Max results">
          </div>
          <div class="hrow">
            <span class="hlbl">between</span>
            <input type="time" data-h="from" title="Only pages last seen from this time of day">
            <span class="hlbl">and</span>
            <input type="time" data-h="to" title="Only pages last seen before this time of day">
          </div>`;
        b.appendChild(bar);
        const q = s => bar.querySelector('[data-h="' + s + '"]');
        const rangeSel = q('range'), dateIn = q('date'), maxIn = q('max'), fromIn = q('from'), toIn = q('to');
        rangeSel.value = state.histRange; maxIn.value = state.histMax;
        dateIn.style.display = state.histRange === 'day' ? '' : 'none';
        if (state.histDate) dateIn.value = state.histDate;
        fromIn.value = state.histFrom; toIn.value = state.histTo;
        rangeSel.onchange = () => { state.histRange = rangeSel.value; render(); };
        dateIn.onchange = () => { state.histDate = dateIn.value; render(); };
        maxIn.onchange = () => { state.histMax = Math.max(20, Math.min(5000, +maxIn.value || 300)); render(); };
        fromIn.onchange = () => { state.histFrom = fromIn.value; render(); };
        toIn.onchange = () => { state.histTo = toIn.value; render(); };

        const { start, end } = histRangeBounds();
        let items = gv(K.PAGES, []).filter(hasUrl).filter(p => isRestorable(p.url) && (p.lastSeen || 0) >= start && (p.lastSeen || 0) < end && matches(p));
        // Time-of-day window on the last visit; a window crossing midnight wraps.
        const toMin = v => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; };
        const fromM = toMin(state.histFrom), toM = toMin(state.histTo);
        if (fromM != null || toM != null) {
            const a = fromM != null ? fromM : 0, z = toM != null ? toM : 1440;
            items = items.filter(h => {
                const d = new Date(h.lastSeen || 0);
                const mins = d.getHours() * 60 + d.getMinutes();
                return a <= z ? (mins >= a && mins < z) : (mins >= a || mins < z);
            });
        }
        items.sort((x, y) => (y.lastSeen || 0) - (x.lastSeen || 0));
        items = items.slice(0, state.histMax);
        state.histShown = items;

        b.appendChild(sechead('calendar', plural(items.length, 'page')));
        if (!items.length) {
            b.appendChild(emptyState('calendar', state.query ? ['Nothing in this range matches ', { b: state.query }, '.'] : 'Nothing seen in this range.'));
        }
        state.rowOrder = [];
        items.forEach(h => {
            const row = el('div', 'row' + (state.histSel.has(h.url) ? ' sel' : ''));
            const cb = selBox(state.histSel, h.url, on => row.classList.toggle('sel', on));
            const body = el('div', 'body');
            body.appendChild(el('div', 't', h.title || host(h.url)));
            body.appendChild(el('div', 'u', host(h.url) + ' · ' + fmtTime(h.lastSeen || 0) + (h.visits > 1 ? ` · ${h.visits}×` : '')));
            body.onclick = () => { openTab(h.url, true) || toast('Pop-up blocked'); };
            const x = el('button', 'rb go'); x.type = 'button'; x.innerHTML = svg('external', 16); x.title = 'Open';
            x.onclick = () => { openTab(h.url, true) || toast('Pop-up blocked'); };
            row.appendChild(cb); row.appendChild(avatarFor(h)); row.appendChild(body); row.appendChild(x);
            b.appendChild(row);
        });
        b.appendChild(noteCard(['Pages Tab Vault has seen in your tabs — not the browser’s own history, which userscripts can’t read. ',
            settings.logPages ? 'Keeps the newest ' + settings.maxPages + '.' : { b: 'Logging is off (Setup).' }], 'info'));
    }
    function histSelItems() {
        return state.histShown.filter(h => state.histSel.has(h.url)).map(h => ({ url: h.url, title: h.title || '' }));
    }
    async function forgetHistSelected() {
        const n = state.histSel.size;
        if (!await confirmBox(`Remove ${plural(n, 'page')} from the log?`, 'Remove', true)) return;
        gset(K.PAGES, gv(K.PAGES, []).filter(p => !(p && state.histSel.has(p.url))));
        state.histSel.clear();
        render();
    }

    /* ------------------------------ Saved ------------------------------ */
    function renderSaved() {
        const b = box('saved'); b.textContent = '';
        const ql = state.query.toLowerCase();
        const sessions = gv(K.SESSIONS, []).filter(hasTabs).filter(s => !state.query || String(s.name || '').toLowerCase().includes(ql) || s.tabs.some(matches));
        if (!sessions.length) {
            b.appendChild(emptyState('bookmark', state.query ? ['No session matches ', { b: state.query }, '.']
                : ['No saved sessions yet.', { br: 1 }, 'Select tabs in ', { b: 'Open' }, ' and tap ', { b: 'Save session' }, '.']));
            return;
        }
        sessions.forEach(s => {
            const c = el('div', 'card');
            const ch = el('div', 'ch');
            const ci = el('span', 'ci'); ci.innerHTML = svg('bookmark', 15); ch.appendChild(ci);
            ch.appendChild(el('span', 'ct', s.name || 'Session'));
            ch.appendChild(el('span', 'cnt', String(s.tabs.length)));
            c.appendChild(ch);
            c.appendChild(el('div', 'cm', `${plural(s.tabs.length, 'tab')} · saved ${relTime(s.savedAt || 0)}`));
            c.appendChild(el('div', 'cu', s.tabs.slice(0, 5).map(t => t.title || host(t.url)).join(' · ')));
            const cb = el('div', 'cb');
            cb.appendChild(mk('Restore', () => openUrls(s.tabs.map(t => t.url), 'batch'), 'g', 'restore'));
            cb.appendChild(mk('Group', () => groupItems(s.tabs), '', 'folderPlus'));
            cb.appendChild(mk('HTML', () => exportBookmarksHtml(s.tabs, s.name), '', 'code'));
            cb.appendChild(mk('JSON', () => downloadFile('tab-vault-session-' + now() + '.json',
                JSON.stringify({ exportedAt: new Date().toISOString(), source: 'tab-vault-userscript', sessions: [s], savedGroups: [], closedWindows: [], closedTabs: [] }, null, 2),
                'application/json'), '', 'download'));
            cb.appendChild(mk('Copy', () => copyUrls(s.tabs), '', 'copy'));
            cb.appendChild(mk('Rename', async () => {
                const r = await askText('Rename session', s.name || '');
                if (!r || !r.text) return;
                const list = gv(K.SESSIONS, []);
                const item = list.find(x => x && x.id === s.id); if (item) item.name = r.text;
                gset(K.SESSIONS, list); render();
            }, '', 'edit'));
            cb.appendChild(mk('Delete', async () => {
                if (!await confirmBox(`Delete session “${s.name || 'Session'}”?`, 'Delete', true)) return;
                gset(K.SESSIONS, gv(K.SESSIONS, []).filter(x => !x || x.id !== s.id)); render();
            }, 'd', 'trash'));
            c.appendChild(cb);
            b.appendChild(c);
        });
    }
    async function saveSession(tabs, prefix) {
        const usable = (tabs || []).filter(t => isRestorable(t.url));
        if (!usable.length) { toast('Nothing restorable to save'); return; }
        const def = (prefix || 'Session') + ' · ' + new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const r = await askText('Save session', def);
        if (!r) return;
        const list = gv(K.SESSIONS, []);
        list.unshift({ id: rid('s'), name: r.text || def, savedAt: now(), tabs: usable.map(t => ({ url: t.url, title: t.title || '' })) });
        gset(K.SESSIONS, list);
        toast(`Saved ${plural(usable.length, 'tab')}`);
        const sel = sectionSelection(); if (sel) sel.clear();
        render();
    }

    /* ------------------------------ Setup ------------------------------ */
    function renderSettings() {
        const s = settings;
        const b = box('settings');
        const n = v => String(+v || 0);
        const gOpts = `<option value="off">Off</option><option value="tap3">3-finger tap</option><option value="tap4">4-finger tap</option>
            <option value="swipe3up">3-finger swipe up</option><option value="swipe3down">3-finger swipe down</option>`;
        const tOpts = `<option value="sheet">Full manager (bottom sheet)</option><option value="groupsheet">Current group (switcher)</option>`;
        b.innerHTML = `
      <div class="sechead">${svg('layers', 14)}<span class="st">Tracking</span><span class="rule"></span></div>
      <div class="field inline"><label>List this tab under Open<span class="h">Registers each tab (URL, title, heartbeat) in the script's shared storage</span></label>
        <input type="checkbox" data-k="trackLive"></div>
      <div class="field inline"><label>Heartbeat (s)<span class="h">How often a visible tab refreshes its entry (background tabs: 3×). 15–120.</span></label>
        <input type="number" data-k="heartbeatSec" min="15" max="120" value="${n(s.heartbeatSec)}"></div>
      <div class="field inline"><label>Lost contact after (min)<span class="h">A tab silent this long leaves Open and is filed under Closed as “lost contact”</span></label>
        <input type="number" data-k="staleMin" min="5" max="1440" value="${n(s.staleMin)}"></div>
      <div class="field inline"><label>Keep a History log<span class="h">Every page Tab Vault sees, for the History tab</span></label>
        <input type="checkbox" data-k="logPages"></div>
      <div class="field inline"><label>History log size<span class="h">Stored now: ${gv(K.PAGES, []).length}</span></label>
        <input type="number" data-k="maxPages" min="50" max="5000" value="${n(s.maxPages)}"></div>
      <div class="field"><label>Never track URLs containing<span class="h">One per line or comma-separated (e.g. accounts.google, bank)</span></label>
        <textarea data-k="exclude" spellcheck="false"></textarea></div>
      <div class="field inline"><label>Show site icons<span class="h">Loads each site's own favicon (no referrer sent)</span></label>
        <input type="checkbox" data-k="showFavicons"></div>

      <div class="sechead alt">${svg('inbox', 14)}<span class="st">Capture</span><span class="rule"></span></div>
      <div class="field inline"><label>Capture closed tabs<span class="h">Turn off to stop recording anything under Closed</span></label>
        <input type="checkbox" data-k="captureClosed"></div>
      <div class="field inline"><label>Closed after (s)<span class="h">An unloaded tab that doesn't reload within this counts as closed. 3–120.</span></label>
        <input type="number" data-k="closedAfterSec" min="3" max="120" value="${n(s.closedAfterSec)}"></div>
      <div class="field inline"><label>Keep closed tabs<span class="h">Stored now: ${gv(K.CLOSED_TABS, []).length}</span></label>
        <input type="number" data-k="maxClosedTabs" min="10" max="2000" value="${n(s.maxClosedTabs)}"></div>

      <div class="sechead alt">${svg('restore', 14)}<span class="st">Restoring</span><span class="rule"></span></div>
      <div class="field inline"><label>Batch size<span class="h">Tabs opened per batch</span></label>
        <input type="number" data-k="batchSize" min="1" max="50" value="${n(s.batchSize)}"></div>
      <div class="field inline"><label>Batch delay (s)<span class="h">Pause between batches</span></label>
        <input type="number" data-k="batchDelaySec" min="0" max="60" value="${n(s.batchDelaySec)}"></div>

      <div class="sechead alt">${svg('zap', 14)}<span class="st">Quick access</span><span class="rule"></span></div>
      <div class="field inline"><label>Corner button<span class="h">Tap: manager · long-press: Setup · drag to move</span></label>
        <input type="checkbox" data-k="showFab"></div>
      <div class="field inline"><label>Open gesture<span class="h">Multi-finger gesture on any page. Avoid ones your phone grabs (3-finger-down is often screenshot).</span></label>
        <select data-k="gesture">${gOpts}</select></div>
      <div class="field inline"><label>Gesture opens</label><select data-k="gestureTarget">${tOpts}</select></div>
      <div class="field inline"><label>Second gesture<span class="h">A separate gesture with its own target.</span></label>
        <select data-k="gesture2">${gOpts}</select></div>
      <div class="field inline"><label>Second gesture opens</label><select data-k="gestureTarget2">${tOpts}</select></div>
      <div class="field" style="margin-top:18px"><button class="btn p" data-a="save" data-ico="save" style="width:100%">Save settings</button></div>

      <div class="sechead alt">${svg('save', 14)}<span class="st">Your data</span><span class="rule"></span></div>
      <div class="field"><div class="btnrow">
          <button class="btn" data-a="export" data-ico="download">Export JSON</button>
          <button class="btn" data-a="copyjson" data-ico="copy">Copy JSON</button></div></div>
      <div class="field"><div class="btnrow">
          <button class="btn" data-a="import" data-ico="restore">Import JSON</button>
          <button class="btn" data-a="paste" data-ico="edit">Paste JSON</button></div>
        <input type="file" data-a="importfile" accept=".json,application/json,text/plain" style="display:none">
        <div class="h">Same format as the Tab Vault extension (sessions, saved groups, closed windows/tabs) plus this script's History log; the old Via Tab Saver JSON imports into History. Import merges — nothing overwritten, duplicates skipped.</div></div>
      <div class="field"><div class="btnrow">
          <button class="btn d" data-a="clearclosed" data-ico="trash">Clear closed</button>
          <button class="btn d" data-a="clearhist" data-ico="trash">Clear History</button></div></div>
      <div class="field"><button class="btn" data-a="rebuild" data-ico="refresh" style="width:100%">Rebuild open-tab list</button>
        <div class="h">Empties the shared registry; every tab still running re-registers within a heartbeat.</div></div>

      <div class="sechead alt">${svg('search', 14)}<span class="st">Capabilities</span><span class="rule"></span></div>
      <div class="field"><div class="btnrow">
          <button class="btn" data-a="cap" data-ico="zap">Show capabilities</button>
          <button class="btn" data-a="capcopy" data-ico="copy" style="flex:0 0 auto"></button></div>
        <pre class="diag" data-a="capout" style="display:none"></pre></div>`;
        paintIcons(b);
        const f = k => b.querySelector('[data-k="' + k + '"]');
        ['trackLive', 'logPages', 'showFavicons', 'captureClosed', 'showFab'].forEach(k => { f(k).checked = !!s[k]; });
        f('exclude').value = String(s.exclude || '');
        const gs = ['off', 'tap3', 'tap4', 'swipe3up', 'swipe3down'];
        f('gesture').value = gs.includes(s.gesture) ? s.gesture : 'off';
        f('gesture2').value = gs.includes(s.gesture2) ? s.gesture2 : 'off';
        f('gestureTarget').value = s.gestureTarget === 'groupsheet' ? 'groupsheet' : 'sheet';
        f('gestureTarget2').value = s.gestureTarget2 === 'sheet' ? 'sheet' : 'groupsheet';
        const A = a => b.querySelector('[data-a="' + a + '"]');
        const num = (k, lo, hi) => { const v = parseInt(f(k).value, 10); return isNaN(v) ? DEFAULTS[k] : Math.max(lo, Math.min(hi, v)); };

        A('save').onclick = () => {
            const next = Object.assign({}, gv(K.SETTINGS, {}), {
                trackLive: f('trackLive').checked, logPages: f('logPages').checked, showFavicons: f('showFavicons').checked,
                captureClosed: f('captureClosed').checked, showFab: f('showFab').checked,
                heartbeatSec: num('heartbeatSec', 15, 120), staleMin: num('staleMin', 5, 1440),
                maxPages: num('maxPages', 50, 5000), closedAfterSec: num('closedAfterSec', 3, 120),
                maxClosedTabs: num('maxClosedTabs', 10, 2000),
                batchSize: num('batchSize', 1, 50), batchDelaySec: num('batchDelaySec', 0, 60),
                exclude: f('exclude').value,
                gesture: f('gesture').value, gestureTarget: f('gestureTarget').value,
                gesture2: f('gesture2').value, gestureTarget2: f('gestureTarget2').value
            });
            gset(K.SETTINGS, next);
            settingsChanged();
            toast('Settings saved');
            render();
        };
        A('export').onclick = () => downloadFile('tab-vault-' + now() + '.json', JSON.stringify(exportData(), null, 2), 'application/json');
        A('copyjson').onclick = () => copyText(JSON.stringify(exportData()), 'Export JSON copied');
        A('import').onclick = () => A('importfile').click();
        const fileIn = A('importfile');   // NB: e.target is nulled after dispatch inside a shadow tree
        fileIn.addEventListener('change', async () => {
            const file = fileIn.files && fileIn.files[0];
            if (!file) return;
            try { toast(importSummary(importData(JSON.parse(await file.text())))); render(); }
            catch (err) { toast('Import failed: ' + ((err && err.message) || 'not a valid export file')); }
            try { fileIn.value = ''; } catch (e) {}
        });
        A('paste').onclick = async () => {
            const text = await askTextarea('Paste an exported JSON', '{ "sessions": [ … ], "savedGroups": [ … ] }');
            if (!text) return;
            try { toast(importSummary(importData(JSON.parse(text)))); render(); }
            catch (err) { toast('Import failed: ' + ((err && err.message) || 'not a valid export')); }
        };
        A('clearclosed').onclick = async () => {
            if (!await confirmBox('Clear all closed tabs and windows?', 'Clear', true)) return;
            gset(K.CLOSED_WINDOWS, []); gset(K.CLOSED_TABS, []); state.closedSel.clear(); render();
        };
        A('clearhist').onclick = async () => {
            if (!await confirmBox('Clear the History log?', 'Clear', true)) return;
            gset(K.PAGES, []); state.histSel.clear(); render();
        };
        A('rebuild').onclick = () => {
            resetLive(); lastHeal = 0; writeLive();
            toast('Registry emptied — tabs re-register as they check in');
        };
        A('cap').onclick = () => { const o = A('capout'); o.style.display = 'block'; o.textContent = 'Probing…'; capabilities().then(t => { o.textContent = t; }); };
        A('capcopy').onclick = async () => {
            const o = A('capout'); const text = await capabilities();
            o.style.display = 'block'; o.textContent = text;
            copyText(text, 'Capabilities copied');
        };
    }
    function settingsChanged() {
        const was = settings;
        settings = loadSettings();
        renderFab();
        if (was.trackLive && !settings.trackLive) removeSelfFromLive();
        else if (!was.trackLive && settings.trackLive) registerSelf();
    }

    async function capabilities() {
        const L = [];
        const add = (k, v) => L.push(String(k).padEnd(28) + ': ' + v);
        add('script', 'Tab Vault (userscript) ' + ((INFO && INFO.script && INFO.script.version) || VERSION));
        add('handler', (HANDLER + ' ' + HANDLER_VER).trim());
        if (INFO && INFO.injectInto) add('inject into', INFO.injectInto);
        if (INFO && INFO.sandboxMode) add('sandbox', INFO.sandboxMode);
        add('storage', MODE === 'gm' ? 'GM_setValue — shared by all tabs and sites' : 'localStorage — THIS SITE ONLY (no GM_setValue)');
        add('cross-tab updates', MODE === 'gm' ? (API.addListener ? 'GM_addValueChangeListener (live)' : 'polling') : 'storage events (same site only)');
        add('remote commands', cmdMode === 'listener' ? 'listener' : cmdMode === 'storage-event' ? 'storage events' : 'polling every 1.5 s');
        add('tab id', (TAB_ID || '-') + ' via ' + (ID_SRC || '-'));
        const tm = await tmTabs();
        add('open-tab source', API.getTabs ? (tm ? 'GM_getTabs (authoritative) — ' + Object.keys(tm).length + ' tab(s)' : 'GM_getTabs present but not answering; heartbeat registry') : 'heartbeat registry');
        add('tracking this tab', trackingOn() ? 'yes' : (excludedUrl(location.href) ? 'no (excluded URL)' : 'no (off)'));
        add('ui scale', uiScale.toFixed(2) + (COARSE ? ' (touch)' : ''));
        add('userAgent', String(navigator.userAgent || '').slice(0, 120));
        L.push('', '--- GM API surface ---');
        const names = {
            GM_getValue: API.getValue, GM_setValue: API.setValue, GM_deleteValue: API.deleteValue, GM_listValues: API.listValues,
            GM_addValueChangeListener: API.addListener, GM_registerMenuCommand: API.menu, GM_openInTab: API.openInTab,
            GM_setClipboard: API.setClipboard, GM_getTab: API.getTab, GM_saveTab: API.saveTab, GM_getTabs: API.getTabs
        };
        Object.keys(names).forEach(k => add(k, names[k] ? 'present' : '-'));
        add('GM_info', INFO ? 'present' : '-');
        add('GM (promise API)', pick(() => typeof GM !== 'undefined' && GM && typeof GM === 'object') ? 'present' : '-');
        const grants = INFO && INFO.script && (INFO.script.grant || INFO.script.grants);
        if (Array.isArray(grants)) add('granted', grants.join(', '));
        L.push('', '--- data ---');
        [K.LIVE, K.PAGES, K.CLOSED_TABS, K.CLOSED_WINDOWS, K.SESSIONS, K.SAVED_GROUPS].forEach(k => {
            const v = k === K.LIVE ? readLive() : gv(k, []);
            const count = Array.isArray(v) ? v.length : Object.keys(v).length;
            let size = 0; try { size = JSON.stringify(v).length; } catch (e) {}
            add(k, count + ' item(s), ' + (size < 1024 ? size + ' B' : '~' + Math.round(size / 1024) + ' KB'));
        });
        const keys = glist();
        if (keys) add('stored keys', keys.length);
        return L.join('\n');
    }

    /* --------------------------- footer actions --------------------------- */
    function renderActions() {
        if (!sheet) return;
        const sel = sectionSelection();
        const n = sel ? sel.size : 0;
        sq('footer').classList.toggle('hidden', n === 0);
        sq('.selcount').textContent = String(n);
        if (n && footerFor !== state.section) buildFooter();
    }
    function buildFooter() {
        footerFor = state.section;
        const bar = sq('footer .btns'); bar.textContent = '';
        const add = (label, fn, cls, icon) => bar.appendChild(mk(label, fn, cls, icon));
        const openSel = () => state.openRows.filter(t => state.selected.has(t.id));
        if (state.section === 'open') {
            add('Save session', () => saveSession(openSel(), 'Selection'), 'p', 'save');
            add('Group', () => groupItems(openSel()), 'v', 'folderPlus');
            add('HTML', () => exportBookmarksHtml(openSel(), 'Tab Vault'), '', 'code');
            add('Copy', () => copyUrls(openSel()), '', 'copy');
            add('Close', async () => {
                const tabs = openSel();
                if (!tabs.length) return;
                if (!await confirmBox(`Close ${plural(tabs.length, 'tab')}?`, 'Close', true)) return;
                const r = await closeTabs(tabs);
                state.selected.clear();
                toast(closeSummary(r));
                render();
            }, 'd', 'x');
        } else if (state.section === 'closed') {
            add('Reopen', () => openUrls(closedSelItems().map(t => t.url), 'batch'), 'a', 'restore');
            add('Group', () => groupItems(closedSelItems()), 'v', 'folderPlus');
            add('Save', () => saveSession(closedSelItems(), 'Closed'), 'p', 'save');
            add('Copy', () => copyUrls(closedSelItems()), '', 'copy');
            add('Forget', forgetClosedSelected, 'd', 'trash');
        } else if (state.section === 'hist') {
            add('Open', () => openUrls(histSelItems().map(t => t.url), 'batch'), 'a', 'restore');
            add('Group', () => groupItems(histSelItems()), 'v', 'folderPlus');
            add('Save', () => saveSession(histSelItems(), 'History'), 'p', 'save');
            add('Copy', () => copyUrls(histSelItems()), '', 'copy');
            add('Forget', forgetHistSelected, 'd', 'trash');
        }
    }
    function updateJobBar(extra) {
        if (!sheet) return;
        const bar = sq('.jobbar');
        bar.classList.toggle('hidden', !job);
        if (job) sq('.jobbar .jt').textContent = `Opening ${job.idx} / ${job.urls.length}…` + (extra ? ' · ' + extra : '');
    }

    /* ===================================================================== *
     *  Compact "current group" switcher
     * ===================================================================== */
    let gsheet = null;
    function openGroupSheet(gid) {
        const groups = gv(K.SAVED_GROUPS, []).filter(hasTabs);
        const hits = groupsForUrl(location.href, groups);
        let g = gid ? groups.find(x => x.id === gid) : hits[0];
        if (!g) {
            openManager('groups');
            toast(groups.length ? 'This page isn’t in a Tab Vault group' : 'No Tab Vault groups yet');
            return;
        }
        ensureUI();
        closeSheets(true);
        backdrop = el('div', 'backdrop');
        backdrop.onclick = () => closeSheets();
        layer.appendChild(backdrop);
        gsheet = el('div', 'sheet gs');
        const grab = el('div', 'gsgrab');
        grab.appendChild(el('span', 'grip'));
        const xb = el('button', 'icon'); xb.type = 'button'; xb.innerHTML = svg('x', 16); xb.title = 'Close';
        xb.onclick = () => closeSheets();
        grab.appendChild(xb);
        gsheet.appendChild(grab);

        const head = el('div', 'gshead');
        head.appendChild(el('span', 'gsdot g-' + safeColor(g.color)));
        head.appendChild(el('span', 'gstitle', g.name || 'Tab group'));
        head.appendChild(el('span', 'gscount', plural(g.tabs.length, 'tab')));
        gsheet.appendChild(head);
        const others = hits.length > 1 ? hits : [];
        if (others.length) {
            const chips = el('div', 'gschips');
            others.forEach(o => {
                const c = el('button', 'gbadge g-' + safeColor(o.color) + (o.id === g.id ? ' on' : ''), o.name || 'group');
                c.type = 'button';
                c.onclick = () => openGroupSheet(o.id);
                chips.appendChild(c);
            });
            gsheet.insertBefore(chips, head);
        }
        const live = readLive();
        const t0 = now(), stale = settings.staleMin * 60000;
        const liveByUrl = {};
        for (const id in live) {
            const e = live[id];
            if (!e || e.gone || id === TAB_ID || t0 - e.seen > stale) continue;
            const k = normUrl(e.url);
            if (!liveByUrl[k] || liveByUrl[k].seen < e.seen) liveByUrl[k] = e;
        }
        const cur = normUrl(location.href);
        const list = el('div', 'gslist');
        g.tabs.forEach(t => {
            const isCur = normUrl(t.url) === cur;
            const liveE = liveByUrl[normUrl(t.url)];
            const row = el('div', 'gsrow' + (isCur ? ' on' : ''));
            const body = el('div', 'body');
            body.appendChild(el('div', 't', t.title || host(t.url)));
            body.appendChild(el('div', 'u', host(t.url) + (isCur ? ' · this tab' : liveE ? ' · open' : '')));
            const ob = el('button', 'rb'); ob.type = 'button'; ob.innerHTML = svg('external', 15); ob.title = 'Open in a new tab';
            ob.onclick = e => { e.stopPropagation(); openTab(t.url, true) || toast('Pop-up blocked'); closeSheets(); };
            row.appendChild(avatarFor({ url: t.url, fav: liveE && liveE.fav })); row.appendChild(body); row.appendChild(ob);
            row.addEventListener('click', async () => {
                if (isCur) { closeSheets(); return; }
                if (liveE) {
                    toast('Switching…');
                    const r = await sendCmd(liveE.id, 'focus');
                    if (r === 'ok') { closeSheets(); return; }
                    toast(r === 'nochange' ? 'The browser didn’t switch — tap ↗ to open a copy, or switch yourself' : 'That tab didn’t answer — tap ↗ to open it');
                    return;
                }
                openTab(t.url, true) || toast('Pop-up blocked');
                closeSheets();
            });
            list.appendChild(row);
        });
        gsheet.appendChild(list);
        const foot = el('div', 'gsfoot');
        foot.appendChild(el('span', 'h', 'Tab Vault group · tap to switch, ↗ opens a copy'));
        const full = el('button', 'link', 'Full manager'); full.type = 'button';
        full.style.color = 'var(--blue)';
        full.onclick = () => openManager('groups');
        foot.appendChild(full);
        gsheet.appendChild(foot);
        layer.appendChild(gsheet);
        attachDrag(gsheet, grab);
        requestAnimationFrame(() => { if (backdrop) backdrop.classList.add('show'); if (gsheet) gsheet.classList.add('show'); });
    }

    /* ===================================================================== *
     *  Corner launcher (draggable; long-press = Setup)
     * ===================================================================== */
    let fabEl = null;
    function renderFab() {
        if (!settings.showFab) { if (fabEl) { fabEl.remove(); fabEl = null; } return; }
        ensureUI();
        if (!fabEl) {
            fabEl = el('button', 'fab');
            fabEl.type = 'button';
            fabEl.title = 'Tab Vault — tap: manager · long-press: Setup · drag to move';
            fabEl.setAttribute('aria-label', 'Tab Vault');
            fabEl.innerHTML = svg('vault', 24) + '<em></em>';
            let moved = false, longP = false, tmr = null, sx = 0, sy = 0, ox = 0, oy = 0, down = false;
            fabEl.addEventListener('pointerdown', e => {
                down = true; moved = false; longP = false; sx = e.clientX; sy = e.clientY;
                ox = parseFloat(fabEl.style.left) || 0; oy = parseFloat(fabEl.style.top) || 0;
                try { fabEl.setPointerCapture(e.pointerId); } catch (x) {}
                clearTimeout(tmr);
                tmr = setTimeout(() => { if (!moved) { longP = true; openManager('settings'); } }, 550);
            });
            fabEl.addEventListener('pointermove', e => {
                if (!down) return;
                const dx = (e.clientX - sx) / uiScale, dy = (e.clientY - sy) / uiScale;
                if (!moved && Math.abs(dx) + Math.abs(dy) > 6) { moved = true; clearTimeout(tmr); }
                if (moved) setFabPos(ox + dx, oy + dy);
            });
            const up = () => {
                if (!down) return;
                down = false; clearTimeout(tmr);
                if (moved) {
                    const { w, h } = layerSize();
                    gset(K.FABPOS, { x: (parseFloat(fabEl.style.left) || 0) / w, y: (parseFloat(fabEl.style.top) || 0) / h });
                }
            };
            fabEl.addEventListener('pointerup', up);
            fabEl.addEventListener('pointercancel', up);
            fabEl.addEventListener('contextmenu', e => e.preventDefault());
            fabEl.addEventListener('click', () => { if (!moved && !longP) openManager(); moved = false; longP = false; });
            layer.insertBefore(fabEl, layer.firstChild);
        }
        placeFab();
        updateFabCount();
    }
    function setFabPos(x, y) {
        const { w, h } = layerSize();
        fabEl.style.left = Math.min(Math.max(4, x), w - 52) + 'px';
        fabEl.style.top = Math.min(Math.max(4, y), h - 52) + 'px';
    }
    function placeFab() {
        if (!fabEl) return;
        const p = gv(K.FABPOS, null);
        const { w, h } = layerSize();
        if (p && typeof p.x === 'number' && typeof p.y === 'number') setFabPos(p.x * w, p.y * h);
        else setFabPos(12, h - 156 - 48);
    }
    let fabCountT = null;
    function updateFabCount() {
        if (!fabEl) return;
        clearTimeout(fabCountT);
        fabCountT = setTimeout(() => {
            const em = fabEl && fabEl.querySelector('em');
            if (em) { const n = liveCount(); em.textContent = n > 1 ? String(n) : ''; }
        }, 250);
    }

    /* ===================================================================== *
     *  Multi-finger gestures (ported from the extension's content script)
     * ===================================================================== */
    function fireGesture(t) { if (t === 'groupsheet') openGroupSheet(); else openManager(); }
    const need = g => g === 'tap4' ? 4 : (g === 'off' || !g ? 0 : 3);
    const gestureConfigs = () => [{ g: settings.gesture, t: settings.gestureTarget }, { g: settings.gesture2, t: settings.gestureTarget2 }]
        .filter(c => need(c.g) > 0);
    let gTracking = false, gFired = false, gsx = 0, gsy = 0, gst = 0, gMoved = 0, gSeen = 0, gFingers = 0;
    function centroid(touches) {
        let x = 0, y = 0;
        for (let i = 0; i < touches.length; i++) { x += touches[i].clientX; y += touches[i].clientY; }
        return { x: x / touches.length, y: y / touches.length };
    }
    addEventListener('touchstart', e => {
        if (sheet || gsheet) return;
        const n = e.touches.length;
        gSeen = Math.max(gSeen, n);
        if (!gTracking && gestureConfigs().some(c => need(c.g) === n)) {
            gTracking = true; gFired = false; gMoved = 0; gFingers = n;
            const c = centroid(e.touches); gsx = c.x; gsy = c.y; gst = now();
        }
    }, { passive: true, capture: true });
    addEventListener('touchmove', e => {
        if (!gTracking || gFired || e.touches.length !== gFingers) return;
        const c = centroid(e.touches);
        const dx = c.x - gsx, dy = c.y - gsy;
        gMoved = Math.max(gMoved, Math.abs(dx), Math.abs(dy));
        if (Math.abs(dx) >= 130) return;
        const dir = dy < -90 ? 'swipe3up' : (dy > 90 ? 'swipe3down' : null);
        if (!dir) return;
        const hit = gestureConfigs().find(cf => cf.g === dir && need(cf.g) === gFingers);
        if (hit) { gFired = true; gTracking = false; fireGesture(hit.t); }
    }, { passive: true, capture: true });
    addEventListener('touchend', e => {
        if (e.touches.length > 0) return;
        if (gTracking && !gFired && now() - gst < 450 && gMoved < 40) {
            const hit = gestureConfigs().find(cf => (cf.g === 'tap3' || cf.g === 'tap4') && need(cf.g) === gSeen);
            if (hit) fireGesture(hit.t);
        }
        gTracking = false; gFired = false; gSeen = 0;
    }, { passive: true, capture: true });
    addEventListener('touchcancel', () => { gTracking = false; gFired = false; gSeen = 0; }, { passive: true, capture: true });

    /* ===================================================================== *
     *  Page lifecycle
     * ===================================================================== */
    let navFlagAt = 0;
    const flagNav = () => { navFlagAt = now(); };
    function watchNavigation() {
        // A navigation the page itself starts (link, form, location.*) is not
        // a close. Browser-UI navigations (address bar) can't be seen.
        try {
            if (window.navigation && typeof window.navigation.addEventListener === 'function') {
                window.navigation.addEventListener('navigate', e => {
                    if (!e.hashChange && e.navigationType !== 'reload' && !(e.destination && e.destination.sameDocument)) flagNav();
                });
            }
        } catch (e) {}
        document.addEventListener('click', e => {
            if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
            if (!a || a.hasAttribute('download')) return;
            const tgt = (a.getAttribute('target') || '').toLowerCase();
            if (tgt && tgt !== '_self' && tgt !== '_top' && tgt !== '_parent') return;
            if (/^(javascript:|#)/i.test(a.getAttribute('href') || '')) return;
            flagNav();
        }, true);
        document.addEventListener('submit', flagNav, true);
    }
    function onPageHide(e) {
        if (!TAB_ID) return;
        if (!trackingOn()) { gone = true; return; }
        flushPageLog();
        if (e.persisted || now() - navFlagAt < 5000) putLive(TAB_ID, null);   // navigation, not a close
        else { const me = selfEntry(); me.gone = now(); putLive(TAB_ID, me); }
        gone = true;
        lastSig = '';
        bumpLive();
    }
    function onPageShow(e) {
        if (!e.persisted || !TAB_ID) return;
        gone = false;
        registerSelf();
        logPage(true);
        renderFab();
    }
    let lastUrl = location.href, lastTitle = document.title;
    function watchUrlAndTitle() {
        setInterval(() => {
            if (gone) return;
            if (location.href !== lastUrl) {
                lastUrl = location.href; lastTitle = document.title;
                if (trackingOn()) { scheduleLiveWrite(600); setTimeout(() => logPage(true), 900); }
                else removeSelfFromLive();
            } else if (document.title !== lastTitle) {
                lastTitle = document.title;
                if (trackingOn()) { scheduleLiveWrite(3000); setTimeout(() => logPage(false), 3200); }
            }
        }, 1500);
    }
    function heartbeat() {
        setInterval(() => {
            if (gone || !TAB_ID) return;
            if (hostEl && !hostEl.isConnected) ensureUI();   // the page wiped our host
            const vis = document.visibilityState === 'visible';
            const due = settings.heartbeatSec * 1000 * (vis ? 1 : 3);
            if (now() - lastLiveWrite >= due - 600) {
                writeLive();
                if (now() - lastPageTouch > 5 * 60000 && vis) logPage(false);
                sweep();
            }
        }, 5000);
    }

    /* ===================================================================== *
     *  Boot
     * ===================================================================== */
    async function boot() {
        const r = await resolveTabId();
        TAB_ID = r.id; ID_SRC = r.src;
        registerSelf();
        logPage(true);
        setTimeout(() => {   // titles and favicons often arrive late
            const me = liveEntry(TAB_ID);
            if (trackingOn() && (document.title !== lastTitle || !me || !me.fav)) { lastTitle = document.title; writeLive(); logPage(false); }
        }, 2500);

        onChange(K.LIVE, onLiveChange);       // 1.0.0 tabs still write the shared map
        onChange('liveRev', onLiveChange);
        subscribeOwn();
        onChange(K.SETTINGS, () => settingsChanged());
        onChange(K.FABPOS, () => placeFab());
        startCmdChannel();

        document.addEventListener('visibilitychange', () => {
            if (gone) return;
            if (document.visibilityState === 'visible') {
                lastFocusAt = now();
                scheduleLiveWrite(300);
                handleCmds();
                updateFabCount();
                setTimeout(sweep, 1200);
            } else writeLive();   // the last reliable moment on mobile
        });
        addEventListener('pagehide', onPageHide);
        addEventListener('pageshow', onPageShow);
        watchNavigation();
        watchUrlAndTitle();
        heartbeat();
        setTimeout(sweep, 1500 + Math.random() * 1500);
        renderFab();
    }

    /* menu entries (Tampermonkey/Violentmonkey/ScriptCat/XBrowser menus) */
    function menu(label, fn) { try { if (API.menu) API.menu(label, fn); } catch (e) {} }
    menu('🗂 Tab Vault', () => openManager());
    menu('🧭 Current group switcher', () => openGroupSheet());
    menu('⚙️ Tab Vault setup', () => openManager('settings'));
    menu('◐ Toggle corner button', () => {
        const next = Object.assign({}, gv(K.SETTINGS, {}), { showFab: !settings.showFab });
        gset(K.SETTINGS, next);
        settingsChanged();
        toast(settings.showFab ? 'Corner button on' : 'Corner button off — use the menu or a gesture');
    });

    boot().catch(e => { try { console.warn('[Tab Vault] boot failed', e); } catch (x) {} });
})();
