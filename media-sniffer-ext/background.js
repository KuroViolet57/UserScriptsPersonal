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
 * and reloaded on wake.
 * ========================================================================== */
'use strict';

const K = { MEDIA: 'mediaByTab', SETTINGS: 'settings', FILTER: 'filter' };

const DEFAULT_SETTINGS = {
    buttonOn: true,          // floating button on <video> elements
    buttonSize: 44,
    buttonCorner: 'tr',      // tl tr bl br
    minVideoPx: 120,
    playerPackage: '',       // android package for "open in player" ('' = chooser)
    collapseSegments: true,  // fold repeated .ts/.m4s segment URLs into one entry
    maxPerTab: 300,
    minSniffBytes: 0,        // ignore network media smaller than this (0 = keep all)
    gesture: 'tap3',         // off | tap3 | tap4 | swipe3up | swipe3down
    gestureTarget: 'panel'   // panel (on-page) | popup (native sheet) | tab
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

/* --------------------------- classification --------------------------- */
const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'f4v', 'ts', 'm2ts', 'm4s', '3gp', 'ogv'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'mka'];
const STREAM_EXT = ['m3u8', 'mpd'];
const SEGMENT_EXT = ['ts', 'm4s', 'aac', 'm2ts'];

function extOf(url) {
    try {
        const p = new URL(url).pathname;
        const dot = p.lastIndexOf('.');
        if (dot === -1) return '';
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
        const e = ext || ct.slice(6).replace('quicktime', 'mov').replace('x-matroska', 'mkv');
        return { kind: 'video', ext: VIDEO_EXT.includes(e) ? e : (ext || 'mp4') };
    }
    if (ct.startsWith('audio/')) {
        const e = ext || ct.slice(6).replace('mpeg', 'mp3');
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

function nameOf(url, ext) {
    try {
        const p = new URL(url).pathname;
        let base = decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)) || '';
        if (!base) base = 'media' + (ext ? '.' + ext : '');
        return base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
    } catch (e) { return 'media' + (ext ? '.' + ext : ''); }
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

/* ---------------------------- media store ---------------------------- */
/* mediaByTab: { [tabId]: { items: [...], title, host, updatedAt } } */
let media = null;                 // in-memory copy; mirrored to storage
let saveTimer = null;

async function loadMedia() {
    if (media == null) media = await get(K.MEDIA, {});
    return media;
}
function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; set(K.MEDIA, media || {}); }, 500);
}

async function addItem(tabId, item) {
    const s = await getSettings();
    await loadMedia();
    const bucket = media[tabId] || (media[tabId] = { items: [], updatedAt: 0 });
    bucket.updatedAt = Date.now();

    // range-request / repeat dedupe by URL
    const existing = bucket.items.find(x => x.url === item.url);
    if (existing) {
        if (item.size && (!existing.size || item.size > existing.size)) existing.size = item.size;
        if (item.mime && !existing.mime) existing.mime = item.mime;
        existing.hits = (existing.hits || 1) + 1;
        scheduleSave(); updateBadge(tabId); return;
    }

    // segment folding
    if (s.collapseSegments && SEGMENT_EXT.includes(item.ext)) {
        const key = segmentKey(item.url);
        const seg = bucket.items.find(x => x.segKey === key);
        if (seg) {
            seg.segments = (seg.segments || 1) + 1;
            if (item.size) seg.segBytes = (seg.segBytes || 0) + item.size;
            seg.ts = Date.now();
            scheduleSave(); updateBadge(tabId); return;
        }
        item.segKey = key;
        item.segments = 1;
        if (item.size) { item.segBytes = item.size; }
    }

    bucket.items.push(item);
    if (bucket.items.length > s.maxPerTab) bucket.items.splice(0, bucket.items.length - s.maxPerTab);
    scheduleSave();
    updateBadge(tabId);

    // DOM-reported items often arrive without a size (the element was cached),
    // which used to let them bypass the min-size floor. Resolve it with a HEAD
    // probe — host_permissions make this CORS-free from the worker.
    if (!item.size && !item.blob && item.src === 'dom' && item.kind !== 'stream') probeSize(item);
}

async function probeSize(item) {
    try {
        const r = await fetch(item.url, { method: 'HEAD' });
        if (!r.ok) return;
        let size = parseInt(r.headers.get('content-length'), 10) || null;
        const cr = r.headers.get('content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        if (m) size = parseInt(m[1], 10);
        if (size) { item.size = size; scheduleSave(); }
    } catch (e) {}
}

/* The hard floor from Setup ("ignore media smaller than"), enforced when the
 * lists are read so it applies to every item — network-sniffed, DOM-reported,
 * and items whose size only arrived later via dedupe or probe. Streams and
 * blob: sources have no knowable size and are exempt; unknown sizes are kept. */
function passesMinSize(item, s) {
    if (!s.minSniffBytes) return true;
    if (item.kind === 'stream' || item.blob) return true;
    const size = item.size || item.segBytes || null;
    return size == null || size >= s.minSniffBytes;
}
async function visibleItems(bucket) {
    if (!bucket) return [];
    const s = await getSettings();
    return bucket.items.filter(i => passesMinSize(i, s));
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

/* ---------------------------- webRequest ---------------------------- */
function headerVal(headers, name) {
    if (!headers) return '';
    const h = headers.find(x => x.name.toLowerCase() === name);
    return h ? (h.value || '') : '';
}

chrome.webRequest.onHeadersReceived.addListener(details => {
    try {
        if (details.tabId < 0) return;                       // not tied to a tab
        if (details.statusCode >= 400) return;
        const ct = headerVal(details.responseHeaders, 'content-type');
        const cls = classify(details.url, ct);
        if (!cls) return;

        let size = parseInt(headerVal(details.responseHeaders, 'content-length'), 10) || null;
        // 206 partial: content-range carries the real total ("bytes 0-1/12345")
        const cr = headerVal(details.responseHeaders, 'content-range');
        const m = cr && /\/(\d+)\s*$/.exec(cr);
        if (m) size = parseInt(m[1], 10);

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
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

/* ------------------------------ lifecycle ------------------------------ */
chrome.tabs.onRemoved.addListener(async tabId => {
    await loadMedia();
    if (media[tabId]) { delete media[tabId]; scheduleSave(); }
});
// fresh page load in the same tab: start a clean list
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
    if (info.status === 'loading' && info.url) {
        await loadMedia();
        if (media[tabId]) { delete media[tabId]; scheduleSave(); updateBadge(tabId); }
    }
    if (tab && tab.title && media && media[tabId]) media[tabId].title = tab.title;
});

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
                        for (const it of await visibleItems(media[tid])) all.push(Object.assign({ tabId: +tid }, it));
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
                for (const it of (msg.items || [])) {
                    const cls = it.blob ? { kind: it.kind || 'video', ext: 'blob' }
                                        : classify(it.url, it.mime || '');
                    const k = cls || { kind: it.kind || 'video', ext: extOf(it.url) || '' };
                    await addItem(tabId, {
                        id: 'd' + Math.random().toString(36).slice(2, 9),
                        url: it.url, ext: k.ext, kind: k.kind,
                        mime: it.mime || '', size: it.size || null,
                        name: it.title || nameOf(it.url, k.ext),
                        host: hostOf(it.url), pageUrl: it.pageUrl || '',
                        blob: !!it.blob, src: 'dom', ts: Date.now()
                    });
                }
                sendResponse({ ok: true });
            } else if (msg.type === 'download') {
                if (chrome.downloads && chrome.downloads.download) {
                    try {
                        const id = await chrome.downloads.download({
                            url: msg.url,
                            filename: msg.filename || undefined,
                            saveAs: false
                        });
                        sendResponse({ ok: true, id });
                    } catch (e) {
                        sendResponse({ ok: false, error: String((e && e.message) || e), fallback: true });
                    }
                } else {
                    sendResponse({ ok: false, error: 'downloads API unavailable', fallback: true });
                }
            } else if (msg.type === 'clear') {
                if (msg.tabId != null) delete media[msg.tabId];
                else media = {};
                scheduleSave();
                if (msg.tabId != null) updateBadge(msg.tabId);
                sendResponse({ ok: true });
            } else if (msg.type === 'getSettings') {
                sendResponse({ ok: true, settings: await getSettings() });
            } else if (msg.type === 'setSettings') {
                await set(K.SETTINGS, msg.settings || {});
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
