/* ==========================================================================
 * Media Vault — background service worker
 *
 * The sniffer. chrome.webRequest sees EVERY response the browser receives —
 * page JS, iframes, the media stack's own range requests, service workers —
 * which is exactly the coverage a userscript can never get. Classification
 * uses the Content-Type header first and the URL extension second, so
 * extensionless CDN URLs and octet-stream MP4s are caught too.
 *
 * MV3 workers die when idle, so detected media is mirrored to chrome.storage
 * (one key per tab) and reloaded on wake.
 * ========================================================================== */
'use strict';

const K = { MEDIA: 'mediaByTab', SETTINGS: 'settings', FILTER: 'filter', DL: 'mvDownloads' };
const TAB_P = 'mv:tab:';            // one storage key per tab bucket (1.7.0+)

const DEFAULT_SETTINGS = {
    buttonOn: true,          // floating button on <video> elements
    buttonSize: 44,
    buttonCorner: 'tr',      // tl tr bl br
    minVideoPx: 120,
    playerPackage: '',       // android package for "open in player" ('' = chooser)
    downloadMethod: 'browser', // browser | 1dmplus | 1dm | 1dmlite | adm | admpro | chooser | custom
    downloadPackage: '',     // android package when downloadMethod = custom
    copyOnSend: true,        // also copy the link when handing it to an app
    collapseSegments: true,  // fold repeated .ts/.m4s segment URLs into one entry
    maxPerTab: 300,
    minSniffBytes: 0,        // ignore network media smaller than this (0 = keep all)
    gesture: 'tap3',         // off | tap3 | tap4 | swipe3up | swipe3down
    gestureTarget: 'sheet',  // sheet | panel (on-page) | popup (native) | tab
    popupW: 0, popupH: 0,    // toolbar-popup size in px; 0 = browser default
    askWhereToSave: false,   // chrome.downloads saveAs (Vivaldi 8.3 honours it, VAB-13554)
    ignorePrivate: false     // skip private tabs entirely (otherwise kept in memory only)
};

/* ------------------------------ storage ------------------------------ */
function get(key, def) {
    return new Promise(res => chrome.storage.local.get({ [key]: def }, o => res(o[key])));
}
function set(key, val) {
    return new Promise(res => chrome.storage.local.set({ [key]: val }, () => res()));
}
/* Settings are cached in memory and refreshed on change: every detection
 * used to read them from storage (twice). */
let settingsP = null;
function getSettings() {
    if (!settingsP) settingsP = get(K.SETTINGS, {}).then(s => Object.assign({}, DEFAULT_SETTINGS, s));
    return settingsP;
}
chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch[K.SETTINGS]) settingsP = null;
});

/* Android package names: letters, digits, _ and dots, at least two parts.
 * Anything else (a ';' would add intent parameters) is dropped. */
function safePkg(p) {
    p = String(p || '').trim();
    return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(p) ? p : '';
}

/* --------------------------- classification --------------------------- */
const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'f4v', 'ts', 'm2ts', 'm4s', '3gp', 'ogv'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'mka'];
const STREAM_EXT = ['m3u8', 'mpd'];
const SEGMENT_EXT = ['ts', 'm4s', 'aac', 'm2ts'];
// fMP4 / CMAF segments served as .mp4/.m4a/.m4v with a numbered segment-ish name
const FMP4_EXT = ['mp4', 'm4v', 'm4a', 'cmfv', 'cmfa'];
const SEG_NAME_RE = /(?:^|[\/_.-])(?:seg(?:ment)?|chunk|frag(?:ment)?|part)[-_]?\d+[^\/]*$/i;
// Content-Type subtypes that name a container (extensionless segment URLs)
const CT_VIDEO = { 'mp2t': 'ts', 'iso.segment': 'm4s', 'quicktime': 'mov', 'x-matroska': 'mkv', 'x-flv': 'flv', 'mp4': 'mp4', 'webm': 'webm' };
const CT_AUDIO = { 'mpeg': 'mp3', 'mp4': 'm4a', 'aac': 'aac', 'ogg': 'ogg', 'opus': 'opus', 'wav': 'wav', 'flac': 'flac', 'webm': 'weba' };

function extOf(url) {
    try {
        const p = new URL(url).pathname;
        const dot = p.lastIndexOf('.');
        if (dot === -1 || dot < p.lastIndexOf('/')) return '';
        const e = p.slice(dot + 1).toLowerCase();
        return /^[a-z0-9]{1,5}$/.test(e) ? e : '';
    } catch (e) { return ''; }
}

/* Returns {kind, ext} or null. kind: video | audio | stream */
function classify(url, contentType) {
    const ct = (contentType || '').split(';')[0].trim().toLowerCase();
    const ext = extOf(url);

    if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/x-mpegurl' ||
        ct === 'audio/mpegurl' || ct === 'audio/x-mpegurl') return { kind: 'stream', ext: ext || 'm3u8' };
    if (ct === 'application/dash+xml') return { kind: 'stream', ext: ext || 'mpd' };
    if (STREAM_EXT.includes(ext)) return { kind: 'stream', ext };

    if (ct.startsWith('video/')) {
        const sub = ct.slice(6);
        const fromCt = CT_VIDEO[sub] || sub;
        const e = (sub === 'mp2t' || sub === 'iso.segment') ? (VIDEO_EXT.includes(ext) ? ext : fromCt) : (ext || fromCt);
        return { kind: 'video', ext: VIDEO_EXT.includes(e) ? e : (ext || 'mp4') };
    }
    if (ct.startsWith('audio/')) {
        const sub = ct.slice(6);
        const e = ext || CT_AUDIO[sub] || sub;
        return { kind: 'audio', ext: AUDIO_EXT.includes(e) ? e : (ext || 'mp3') };
    }
    // Media served under a generic type — the classic slip-through. Trust the ext.
    if (ct === 'application/octet-stream' || ct === 'binary/octet-stream' || ct === '' ||
        ct === 'application/download' || ct === 'text/plain') {
        if (VIDEO_EXT.includes(ext)) return { kind: 'video', ext };
        if (AUDIO_EXT.includes(ext)) return { kind: 'audio', ext };
    }
    return null;
}

/* Same rules as the userscript's sanitizeName / makeName. */
function sanitizeName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}
function nameOf(url, ext) {
    try {
        const p = new URL(url).pathname;
        const base = sanitizeName(decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)));
        return base || ('media' + (ext && ext !== 'blob' ? '.' + ext : ''));
    } catch (e) { return 'media' + (ext && ext !== 'blob' ? '.' + ext : ''); }
}
/* Display + download name. Extensionless CDN names ("vfile") get the page
 * title and the classified extension instead. */
function makeName(url, ext, pageTitle) {
    let base;
    try { const p = new URL(url).pathname; base = sanitizeName(decodeURIComponent(p.slice(p.lastIndexOf('/') + 1))); }
    catch (e) { base = ''; }
    if (!/\.[a-z0-9]{1,5}$/i.test(base)) {
        const t = sanitizeName(pageTitle || '').slice(0, 80);
        base = (t || base || 'media') + (ext && ext !== 'blob' ? '.' + ext : '');
    }
    return base;
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }

/* Segment streams produce hundreds of numbered URLs; fold them into one
 * entry keyed by the URL with digit-runs collapsed. */
function segmentKey(url) {
    try {
        const u = new URL(url);
        return u.origin + u.pathname.replace(/\d+/g, '#');
    } catch (e) { return url.replace(/\d+/g, '#'); }
}
function isSegmentUrl(url, ext) {
    if (SEGMENT_EXT.includes(ext)) return true;
    if (!FMP4_EXT.includes(ext)) return false;
    try { return SEG_NAME_RE.test(new URL(url).pathname); } catch (e) { return false; }
}
/* Playlists are re-polled with changing queries (LL-HLS _HLS_msn, tokens):
 * one row per playlist path. */
function streamKey(url) {
    try { const u = new URL(url); return u.origin + u.pathname; } catch (e) { return url.split('?')[0]; }
}

/* ---------------------------- media store ---------------------------- */
/* media: { [tabId]: { items: [...], title, navUrl, private, updatedAt } }
 * Stored one key per tab (mv:tab:<id>) — only changed tabs are rewritten.
 * Private tabs: Vivaldi 8.3+ runs extensions in private tabs (VAB-13631).
 * Their buckets go to chrome.storage.session (memory only) and never to disk. */
let media = null;                 // in-memory copy; mirrored to storage
let mediaP = null;                // the one load in flight (concurrent wake-ups share it)
let saveTimer = null;
const dirty = new Set();          // tab ids changed since the last save
const removed = new Set();        // tab ids whose bucket was deleted

const SESSION = (chrome.storage && chrome.storage.session) || null;
const privateTabs = new Set(), publicTabs = new Set();
const firstUrl = new Map();       // tab url seen at the first detection (for the hash-change rule)
async function isPrivateTab(tabId) {
    if (privateTabs.has(tabId)) return true;
    if (publicTabs.has(tabId)) return false;
    try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.url) firstUrl.set(tabId, t.url);
        (t && t.incognito ? privateTabs : publicTabs).add(tabId);
        return !!(t && t.incognito);
    } catch (e) { return false; }
}

function areaGetAll(area) { return new Promise(res => { try { area.get(null, o => res(o || {})); } catch (e) { res({}); } }); }
function loadMedia() {
    if (media) return Promise.resolve(media);
    if (mediaP) return mediaP;
    mediaP = (async () => {
        const m = {};
        const local = await areaGetAll(chrome.storage.local);
        const legacy = local[K.MEDIA];
        if (legacy && typeof legacy === 'object') {          // 1.6.0 kept every tab in one key
            for (const tid in legacy) if (legacy[tid] && Array.isArray(legacy[tid].items)) { m[tid] = legacy[tid]; dirty.add(tid); }
        }
        for (const k in local) if (k.indexOf(TAB_P) === 0 && local[k] && Array.isArray(local[k].items)) m[k.slice(TAB_P.length)] = local[k];
        if (SESSION) {
            const ses = await areaGetAll(SESSION);
            const old = ses[K.MEDIA];
            if (old && typeof old === 'object') for (const tid in old) if (old[tid] && Array.isArray(old[tid].items)) { m[tid] = old[tid]; dirty.add(tid); }
            for (const k in ses) if (k.indexOf(TAB_P) === 0 && ses[k] && Array.isArray(ses[k].items)) m[k.slice(TAB_P.length)] = ses[k];
        }
        media = m;
        if (legacy || dirty.size) { migrateLegacy = true; scheduleSave(); }
        return media;
    })();
    return mediaP;
}
let migrateLegacy = false;
function markDirty(tabId) { dirty.add(String(tabId)); scheduleSave(); }
function dropBucket(tabId) {
    if (media && media[tabId]) { delete media[tabId]; removed.add(String(tabId)); dirty.delete(String(tabId)); scheduleSave(); }
}
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(flushSave, 1500);
}
function flushSave() {
    saveTimer = null;
    const disk = {}, mem = {}, gone = [];
    for (const tid of dirty) {
        const b = media && media[tid];
        if (!b) continue;
        (b.private ? mem : disk)[TAB_P + tid] = b;
    }
    for (const tid of removed) gone.push(TAB_P + tid);
    dirty.clear(); removed.clear();
    if (Object.keys(disk).length) chrome.storage.local.set(disk);
    if (gone.length) { chrome.storage.local.remove(gone); if (SESSION) try { SESSION.remove(gone); } catch (e) {} }
    if (SESSION && Object.keys(mem).length) { try { SESSION.set(mem); } catch (e) {} }
    if (migrateLegacy) {
        migrateLegacy = false;
        chrome.storage.local.remove(K.MEDIA);
        if (SESSION) try { SESSION.remove(K.MEDIA); } catch (e) {}
    }
}

async function addItem(tabId, item) {
    const s = await getSettings();
    await loadMedia();
    const priv = await isPrivateTab(tabId);
    if (priv && s.ignorePrivate) return;
    const bucket = media[tabId] || (media[tabId] = { items: [], updatedAt: 0 });
    if (priv) bucket.private = true;
    if (!bucket.navUrl) bucket.navUrl = navUrls.get(tabId) || firstUrl.get(tabId) || '';
    bucket.updatedAt = Date.now();

    // range-request / repeat dedupe by URL; playlists by path
    const sk = item.kind === 'stream' ? streamKey(item.url) : null;
    const existing = bucket.items.find(x => x.url === item.url || (sk && x.kind === 'stream' && streamKey(x.url) === sk));
    if (existing) {
        if (sk && existing.url !== item.url) { existing.url = item.url; existing.ts = Date.now(); }   // freshest token
        if (item.size && !existing.segKey && (!existing.size || item.size > existing.size)) existing.size = item.size;
        if (item.mime && !existing.mime) existing.mime = item.mime;
        existing.hits = (existing.hits || 1) + 1;
        markDirty(tabId); badgeSoon(tabId); return;
    }

    // segment folding
    if (s.collapseSegments && !item.blob && isSegmentUrl(item.url, item.ext)) {
        const key = segmentKey(item.url);
        const seg = bucket.items.find(x => x.segKey === key);
        if (seg) {
            seg.segments = (seg.segments || 1) + 1;
            if (item.size) seg.segBytes = (seg.segBytes || 0) + item.size;
            seg.ts = Date.now();
            markDirty(tabId); badgeSoon(tabId); return;
        }
        item.segKey = key;
        item.segments = 1;
        item.segBytes = item.size || 0;
        item.size = null;
    }

    item.hits = 1;
    bucket.items.push(item);
    const cap = Math.max(50, Math.min(2000, +s.maxPerTab || 300));
    if (bucket.items.length > cap) bucket.items.splice(0, bucket.items.length - cap);
    markDirty(tabId);
    badgeSoon(tabId);

    // DOM-reported items often arrive without a size (the element was cached),
    // which used to let them bypass the min-size floor. Resolve it with a HEAD
    // probe — host_permissions make this CORS-free from the worker.
    if (!item.size && !item.blob && item.src === 'dom' && item.kind !== 'stream' && !item.segKey) probeSize(tabId, item);
}

async function probeSize(tabId, item) {
    try {
        const r = await fetch(item.url, { method: 'HEAD' });
        if (!r.ok) return;
        let size = parseInt(r.headers.get('content-length'), 10) || null;
        const cr = r.headers.get('content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        if (m) size = parseInt(m[1], 10);
        if (size) { item.size = size; markDirty(tabId); }
    } catch (e) {}
}

/* The hard floor from Setup ("ignore media smaller than"), enforced when the
 * lists are read so it applies to every item — network-sniffed, DOM-reported,
 * and items whose size only arrived later via dedupe or probe. Streams, folded
 * segment streams and blob: sources have no knowable size and are exempt;
 * unknown sizes are kept. */
function passesMinSize(item, s) {
    if (!s.minSniffBytes) return true;
    if (item.kind === 'stream' || item.blob || item.segKey) return true;
    const size = item.size || null;
    return size == null || size >= s.minSniffBytes;
}
async function visibleItems(bucket) {
    if (!bucket) return [];
    const s = await getSettings();
    return bucket.items.filter(i => passesMinSize(i, s));
}

/* Badge: at most one update per tab every 300 ms (a segment stream hits
 * many times a second). */
const badgeTimers = new Map();
function badgeSoon(tabId) {
    if (badgeTimers.has(tabId)) return;
    badgeTimers.set(tabId, setTimeout(() => { badgeTimers.delete(tabId); updateBadge(tabId); }, 300));
}
async function updateBadge(tabId) {
    if (!chrome.action || !chrome.action.setBadgeText) return;
    try {
        const bucket = (media || {})[tabId];
        const n = bucket ? (await visibleItems(bucket)).length : 0;
        await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
        if (chrome.action.setBadgeBackgroundColor)
            await chrome.action.setBadgeBackgroundColor({ tabId, color: '#7c5cff' });
    } catch (e) {}
}

/* Tell the tab's content scripts their "already reported" memory is stale. */
function tellCleared(tabId) {
    try { const p = chrome.tabs.sendMessage(+tabId, { type: 'mediaCleared' }); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

/* ---------------------------- webRequest ---------------------------- */
function headerVal(headers, name) {
    if (!headers) return '';
    const h = headers.find(x => x.name.toLowerCase() === name);
    return h ? (h.value || '') : '';
}

/* Only request types that can carry media: images, scripts, styles and fonts
 * no longer wake the worker. */
const SNIFF_TYPES = ['media', 'xmlhttprequest', 'other', 'object', 'sub_frame', 'main_frame'];

chrome.webRequest.onHeadersReceived.addListener(details => {
    try {
        if (details.tabId < 0) return;                       // not tied to a tab
        if (details.statusCode >= 400) return;
        const ct = headerVal(details.responseHeaders, 'content-type');
        const cls = classify(details.url, ct);
        if (!cls) return;

        let size = parseInt(headerVal(details.responseHeaders, 'content-length'), 10) || null;
        // 206 partial: content-range carries the real total ("bytes 0-1/12345");
        // without a total ("bytes 0-1/*") the length is only this chunk's.
        const cr = headerVal(details.responseHeaders, 'content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        if (m) size = parseInt(m[1], 10);
        else if (details.statusCode === 206 && !isSegmentUrl(details.url, cls.ext)) size = null;

        addItem(details.tabId, {
            id: 'n' + details.requestId,
            url: details.url,
            ext: cls.ext, kind: cls.kind,
            mime: ct.split(';')[0].trim(),
            size,
            name: nameOf(details.url, cls.ext),
            host: hostOf(details.url),
            pageUrl: details.initiator || '',
            src: 'net',
            ts: Date.now()
        });
    } catch (e) {}
}, { urls: ['<all_urls>'], types: SNIFF_TYPES }, ['responseHeaders']);

/* ------------------------------ lifecycle ------------------------------ */
chrome.tabs.onRemoved.addListener(async tabId => {
    privateTabs.delete(tabId); publicTabs.delete(tabId);
    await loadMedia();
    dropBucket(tabId);
});
/* A new page in the tab (link, typed URL, or a RELOAD — which sends status
 * "loading" with no url, since the URL did not change) starts a clean list.
 * A hash-only change (#t=10) keeps it. */
const stripHash = u => String(u || '').split('#')[0];
const navUrls = new Map();
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status === 'loading') {
        await loadMedia();
        const b = media[tabId];
        const nowUrl = info.url || (tab && tab.url) || '';
        const hashOnly = !!info.url && b && b.navUrl && stripHash(b.navUrl) === stripHash(info.url);
        if (b && !hashOnly) { dropBucket(tabId); updateBadge(tabId); }
        else if (b) { b.navUrl = nowUrl; markDirty(tabId); }
        navUrls.set(tabId, nowUrl);
    }
    if (tab && media && media[tabId]) {
        if (tab.title) media[tabId].title = tab.title;
        if (tab.url && !media[tabId].navUrl) media[tabId].navUrl = tab.url;
    }
});
/* Tab ids are only unique within a browser session: lists from the last
 * session can never be shown again, so they are dropped at startup. */
chrome.runtime.onStartup.addListener(async () => {
    await loadMedia();
    for (const tid of Object.keys(media)) dropBucket(tid);
    flushSaveSoon();
});
function flushSaveSoon() { clearTimeout(saveTimer); saveTimer = null; flushSave(); }

/* ------------------------- download refusals -------------------------
 * chrome.downloads cannot send a Referer (its headers are "restricted to those
 * allowed by XMLHttpRequest"), and declarativeNetRequest cannot add one:
 * Chromium hides browser-initiated, non-navigation requests from extensions
 * (chrome_extensions_api_client.cc, ShouldHideBrowserNetworkRequest). So when
 * a server refuses one of our downloads, the page shows a notice pointing to
 * the app hand-off instead. */
async function rememberDownload(id, tabId, url) {
    if (id == null || tabId == null || !SESSION) return;
    try {
        const o = await new Promise(r => SESSION.get({ [K.DL]: {} }, x => r(x[K.DL] || {})));
        o[id] = { tabId, url, at: Date.now() };
        for (const k of Object.keys(o)) if (Date.now() - o[k].at > 3 * 3600000) delete o[k];
        await new Promise(r => SESSION.set({ [K.DL]: o }, r));
    } catch (e) {}
}
const REFUSED = ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED'];
if (chrome.downloads && chrome.downloads.onChanged) {
    chrome.downloads.onChanged.addListener(async delta => {
        try {
            const err = delta && delta.error && delta.error.current;
            if (!err || !REFUSED.includes(err) || !SESSION) return;
            const o = await new Promise(r => SESSION.get({ [K.DL]: {} }, x => r(x[K.DL] || {})));
            const d = o[delta.id];
            if (!d) return;
            const text = 'The site refused the download (' + (err === 'SERVER_FORBIDDEN' ? '403' : '401') +
                ') — it only serves its own pages. Use Download with 1DM / ADM, or Open in player.';
            const p = chrome.tabs.sendMessage(d.tabId, { type: 'mvNotice', text, url: d.url }, { frameId: 0 });
            if (p && p.catch) p.catch(() => {});
        } catch (e) {}
    });
}

/* ------------------------------ messages ------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
        try {
            await loadMedia();
            if (msg.type === 'getMediaForMe') {
                const tid = sender.tab && sender.tab.id;
                sendResponse({ ok: true, items: await visibleItems(tid != null ? media[tid] : null) });
            } else if (msg.type === 'getMedia') {
                if (msg.tabId != null) {
                    sendResponse({ ok: true, items: await visibleItems(media[msg.tabId]) });
                } else {
                    const all = [];
                    for (const tid in media) {
                        const priv = !!media[tid].private;
                        for (const it of await visibleItems(media[tid])) all.push(Object.assign({ tabId: +tid, private: priv }, it));
                    }
                    sendResponse({ ok: true, items: all });
                }
            } else if (msg.type === 'tryOpenPopup') {
                if (chrome.action && chrome.action.openPopup) {
                    try { await chrome.action.openPopup(); sendResponse({ ok: true }); }
                    catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
                } else sendResponse({ ok: false, error: 'openPopup unsupported' });
            } else if (msg.type === 'openManagerTab') {
                const url = chrome.runtime.getURL('media.html');
                const existing = await chrome.tabs.query({ url });
                if (existing.length) await chrome.tabs.update(existing[0].id, { active: true });
                else await chrome.tabs.create({ url });
                sendResponse({ ok: true });
            } else if (msg.type === 'domMedia') {
                const tabId = sender.tab && sender.tab.id;
                if (tabId == null) { sendResponse({ ok: false }); return; }
                for (const it of (msg.items || []).slice(0, 200)) {
                    if (!it || typeof it.url !== 'string' || !/^(https?:|blob:)/i.test(it.url)) continue;
                    const blob = /^blob:/i.test(it.url);
                    const cls = blob ? { kind: it.kind === 'audio' ? 'audio' : 'video', ext: 'blob' }
                                     : classify(it.url, it.mime || '');
                    const kind = cls ? cls.kind : (it.kind === 'audio' ? 'audio' : 'video');
                    const ext = cls ? cls.ext : (extOf(it.url) || (kind === 'audio' ? 'mp3' : 'mp4'));
                    await addItem(tabId, {
                        id: 'd' + Math.random().toString(36).slice(2, 9),
                        url: it.url, ext, kind,
                        mime: it.mime || '', size: it.size || null,
                        name: blob ? sanitizeName(it.title || 'blob media') : makeName(it.url, ext, it.title),
                        host: hostOf(it.url), pageUrl: it.pageUrl || '',
                        frame: sender.frameId ? hostOf(it.pageUrl || '') || 'frame' : '',
                        blob, src: 'dom', ts: Date.now()
                    });
                }
                sendResponse({ ok: true });
            } else if (msg.type === 'download') {
                if (chrome.downloads && chrome.downloads.download) {
                    try {
                        const id = await chrome.downloads.download({
                            url: msg.url,
                            filename: msg.filename ? sanitizeName(msg.filename) : undefined,
                            saveAs: !!(await getSettings()).askWhereToSave
                        });
                        const tabId = msg.tabId != null ? msg.tabId : (sender.tab && sender.tab.id);
                        await rememberDownload(id, tabId, msg.url);
                        sendResponse({ ok: true, id });
                    } catch (e) {
                        sendResponse({ ok: false, error: String((e && e.message) || e), fallback: true });
                    }
                } else {
                    sendResponse({ ok: false, error: 'downloads API unavailable', fallback: true });
                }
            } else if (msg.type === 'openIntent') {
                // The popup / full page can't launch an Android app itself:
                // ask the page's TOP frame to navigate to the intent: URL.
                try {
                    if (msg.tabId == null) throw new Error('no page tab');
                    const r = await chrome.tabs.sendMessage(msg.tabId, { type: 'openIntent', intent: msg.intent }, { frameId: 0 });
                    sendResponse(r && r.ok ? { ok: true } : { ok: false, error: 'page did not accept' });
                } catch (e) {
                    sendResponse({ ok: false, error: String((e && e.message) || e) });
                }
            } else if (msg.type === 'remove') {
                // Bulk "Remove" in the list: drop exactly these rows.
                const byTab = {};
                for (const it of (msg.items || [])) if (it && it.url) (byTab[it.tabId] || (byTab[it.tabId] = new Set())).add(it.url);
                let n = 0;
                for (const tid in byTab) {
                    const b = media[tid];
                    if (!b) continue;
                    const before = b.items.length;
                    b.items = b.items.filter(i => !byTab[tid].has(i.url));
                    if (b.items.length !== before) { n += before - b.items.length; markDirty(tid); updateBadge(+tid); }
                }
                sendResponse({ ok: true, removed: n });
            } else if (msg.type === 'clear') {
                const tids = msg.tabId != null ? [String(msg.tabId)] : Object.keys(media);
                for (const tid of tids) { dropBucket(tid); updateBadge(+tid); tellCleared(tid); }
                sendResponse({ ok: true });
            } else if (msg.type === 'getSettings') {
                sendResponse({ ok: true, settings: await getSettings() });
            } else if (msg.type === 'setSettings') {
                const s = Object.assign({}, msg.settings || {});
                if ('playerPackage' in s) s.playerPackage = safePkg(s.playerPackage);
                if ('downloadPackage' in s) s.downloadPackage = safePkg(s.downloadPackage);
                await set(K.SETTINGS, s);
                settingsP = null;
                sendResponse({ ok: true });
            } else {
                sendResponse({ ok: false, error: 'unknown message' });
            }
        } catch (e) {
            sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
    })();
    return true;
});
