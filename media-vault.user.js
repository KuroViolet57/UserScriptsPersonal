// ==UserScript==
// @name         Media Vault (userscript)
// @namespace    https://github.com/KuroViolet57/UserScriptsPersonal
// @version      1.0.0
// @description  Media Vault as a userscript: detects video / audio / HLS-DASH streams from fetch/XHR response headers, the Performance timeline, <video>/<audio>/<source> elements and iframes; folds segment floods; lists them in a bottom sheet with search, type / format / size filters and bulk actions; adds an on-video button with a preview player; downloads via the manager (Referer), 1DM / ADM / any Android app, or opens in an external player.
// @author       KuroViolet57
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      *
// @sandbox      JavaScript
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/media-vault.user.js
// @updateURL    https://raw.githubusercontent.com/KuroViolet57/UserScriptsPersonal/ccr-b432f84b-h7f7j6/media-vault.user.js
// ==/UserScript==

/*
 * Media Vault (userscript) — port of the Media Vault 1.5.0 MV3 extension
 * (media-sniffer-ext/) and successor of media-sniffer.user.js 1.4.1.
 *
 * Detection sources (a userscript has no webRequest, so it stacks several):
 *   net   fetch / XHR hooks (unsafeWindow, or an injected page script when the
 *         manager runs us in an isolated world) reading the RESPONSE
 *         Content-Type / Content-Length / Content-Range — classified exactly
 *         like the extension's background worker.
 *   perf  PerformanceObserver on resource entries (buffered): requests the
 *         page's JS never made (media element loads, CSS, preloads...).
 *   dom   <video>/<audio>/<source>, currentSrc, same-origin iframes, a
 *         MutationObserver and media events.
 *   frame child frames run the same sniffers but draw no UI; they post their
 *         finds to window.top (namespaced, validated messages) and mirror
 *         them to shared GM storage keyed by the top page's id.
 *
 * UI lives in a closed Shadow DOM; nothing page-derived is ever parsed as
 * HTML (no innerHTML anywhere — also keeps Trusted-Types pages happy).
 * Every GM_* API is feature-detected; GM_info is read only if the manager
 * exposes it (it is deliberately NOT @grant-ed: that blocked installs on
 * ScriptCat / Quetta).
 */

(function () {
    'use strict';

    const VERSION = '1.0.0';
    const NS = 'mv-us-1';                       // message namespace

    let IS_TOP = true;
    try { IS_TOP = window.top === window.self; } catch (e) { IS_TOP = false; }

    if (window.__mediaVaultUS) return;
    try { window.__mediaVaultUS = true; } catch (e) {}

    /* ================================================================== *
     *  GM compatibility layer — every API feature-detected
     * ================================================================== */
    const GM4 = (typeof GM !== 'undefined' && GM) ? GM : null;
    const A = {
        getValue: typeof GM_getValue === 'function' ? GM_getValue : null,
        setValue: typeof GM_setValue === 'function' ? GM_setValue : null,
        deleteValue: typeof GM_deleteValue === 'function' ? GM_deleteValue : null,
        addListener: typeof GM_addValueChangeListener === 'function' ? GM_addValueChangeListener : null,
        removeListener: typeof GM_removeValueChangeListener === 'function' ? GM_removeValueChangeListener : null,
        menu: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand : null,
        unmenu: typeof GM_unregisterMenuCommand === 'function' ? GM_unregisterMenuCommand : null,
        xhr: typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
            : (GM4 && typeof GM4.xmlHttpRequest === 'function' ? GM4.xmlHttpRequest.bind(GM4) : null),
        download: typeof GM_download === 'function' ? GM_download
            : (GM4 && typeof GM4.download === 'function' ? GM4.download.bind(GM4) : null),
        setClipboard: typeof GM_setClipboard === 'function' ? GM_setClipboard
            : (GM4 && typeof GM4.setClipboard === 'function' ? GM4.setClipboard.bind(GM4) : null),
        openTab: typeof GM_openInTab === 'function' ? GM_openInTab
            : (GM4 && typeof GM4.openInTab === 'function' ? GM4.openInTab.bind(GM4) : null)
    };
    const PW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    const HANDLER = (() => {
        try {
            if (typeof GM_info !== 'undefined' && GM_info) {
                return ((GM_info.scriptHandler || '') + ' ' + (GM_info.version || '')).trim();
            }
        } catch (e) {}
        return '';
    })();

    const LS = '__mvus_';
    function gv(key, def) {
        try {
            if (A.getValue) { const v = A.getValue(key, def); return v === undefined ? def : v; }
        } catch (e) {}
        try { const raw = localStorage.getItem(LS + key); return raw == null ? def : JSON.parse(raw); }
        catch (e) { return def; }
    }
    function sv(key, val) {
        try { if (A.setValue) { A.setValue(key, val); return; } } catch (e) {}
        try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch (e) {}
    }
    function dv(key) {
        try { if (A.deleteValue) { A.deleteValue(key); return; } } catch (e) {}
        try { localStorage.removeItem(LS + key); } catch (e) {}
    }
    function onValue(key, fn) {
        if (!A.addListener) return null;
        try { return A.addListener(key, fn); } catch (e) { return null; }
    }

    /* ================================================================== *
     *  Environment
     * ================================================================== */
    const UA = navigator.userAgent || '';
    const IS_ANDROID = /Android/i.test(UA);
    const IS_XBROWSER = /x\s*-?browser|xbext/i.test(HANDLER) || /XBrowser/i.test(UA);
    const rnd = n => Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0');
    const PAGE_ID = rnd(12);
    const FRAME_ID = rnd(8);

    /* ================================================================== *
     *  Settings (same keys as the extension, plus userscript extras)
     * ================================================================== */
    const DEFAULTS = {
        buttonOn: true, buttonSize: 44, buttonCorner: 'tr', minVideoPx: 120, buttonOpacity: 0.92,
        playerPackage: '',
        downloadMethod: 'browser',   // browser | 1dmplus | 1dm | 1dmlite | adm | admpro | chooser | custom
        downloadPackage: '', copyOnSend: true,
        browserEngine: 'auto',       // auto (GM_download → blob → link) | blob | link
        gmTag: '',                   // XBrowser GM_download subfolder
        collapseSegments: true, maxPerTab: 300, minSniffBytes: 0,
        gesture: 'tap3', gestureTarget: 'sheet',     // sheet | panel
        showFab: true,
        captureNetwork: true, perfObserver: true, scanFrames: true, fetchSizes: true,
        intents: 'auto',             // auto (Android only) | on | off
        intentFormB: false,
        uiScale: 0                   // 0 = auto (compensates desktop-width pages on phones)
    };
    let S = Object.assign({}, DEFAULTS, gv('settings', {}));

    const DL_APPS = {   // ids from media-sniffer-ext/content.js + media.js
        '1dmplus': ['1DM+', 'idm.internet.download.manager.plus'],
        '1dm':     ['1DM', 'idm.internet.download.manager'],
        '1dmlite': ['1DM Lite', 'idm.internet.download.manager.adm.lite'],
        'adm':     ['ADM', 'com.dv.adm'],
        'admpro':  ['ADM Pro', 'com.dv.adm.pay'],
        'chooser': ['App chooser', ''],
        'custom':  ['Custom app', null]
    };
    const DL_ORDER = ['browser', '1dmplus', '1dm', '1dmlite', 'adm', 'admpro', 'chooser', 'custom'];
    const PLAYERS = {
        vlc: ['VLC', 'org.videolan.vlc'], mx: ['MX Player', 'com.mxtech.videoplayer.ad'],
        mxpro: ['MX Player Pro', 'com.mxtech.videoplayer.pro'], just: ['Just Player', 'com.brouken.player'],
        mpv: ['mpv', 'is.xyz.mpv']
    };
    function intentsOn() { return S.intents === 'on' || (S.intents === 'auto' && IS_ANDROID); }
    /* {label, pkg}: pkg === null means the browser's own downloader. */
    function resolveDl() {
        const m = DL_APPS[S.downloadMethod];
        if (!m || !intentsOn()) return { label: 'Download', pkg: null };
        if (S.downloadMethod === 'custom') {
            const pkg = (S.downloadPackage || '').trim();
            return pkg ? { label: pkg.split('.').pop(), pkg } : { label: 'Download', pkg: null };
        }
        return { label: m[0], pkg: m[1] };
    }
    function dlLabel() { const d = resolveDl(); return d.pkg === null ? 'Download' : d.label; }
    function methodLabel(m) { return m === 'browser' ? 'Browser downloader' : (DL_APPS[m] ? DL_APPS[m][0] : m); }

    /* ================================================================== *
     *  Classification — ported from media-sniffer-ext/background.js
     * ================================================================== */
    const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'f4v', 'ts', 'm2ts', 'm4s', '3gp', 'ogv'];
    const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba', 'mka'];
    const STREAM_EXT = ['m3u8', 'mpd'];
    const SEGMENT_EXT = ['ts', 'm4s', 'aac', 'm2ts'];
    // fMP4 / CMAF segments served as .mp4/.m4a/.m4v with a numbered segment-ish name
    const FMP4_EXT = ['mp4', 'm4v', 'm4a', 'cmfv', 'cmfa'];
    const SEG_NAME_RE = /(?:^|[\/_.-])(?:seg(?:ment)?|chunk|frag(?:ment)?|part)[-_]?\d+[^\/]*$/i;

    function extOf(url) {
        try {
            const p = new URL(url, location.href).pathname;
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
    function sanitizeName(s) { return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120); }
    function nameOf(url) {
        try {
            const p = new URL(url, location.href).pathname;
            return sanitizeName(decodeURIComponent(p.slice(p.lastIndexOf('/') + 1)));
        } catch (e) { return ''; }
    }
    /* Display + download name. Extensionless CDN names ("vfile") get the page
     * title and the classified extension instead. */
    function makeName(url, ext, hint) {
        let base = hint ? sanitizeName(hint) : nameOf(url);
        if (!/\.[a-z0-9]{1,5}$/i.test(base)) {
            const t = sanitizeName(document.title || '').slice(0, 80);
            base = (t || base || 'media') + (ext && ext !== 'blob' ? '.' + ext : '');
        }
        return base;
    }
    function hostOf(url) { try { return new URL(url, location.href).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
    function absUrl(u) { try { return new URL(u, location.href).href; } catch (e) { return ''; } }
    /* Segment streams produce hundreds of numbered URLs; fold them into one
     * entry keyed by the URL with digit-runs collapsed (background.js rule). */
    function segmentKey(url) {
        try { const u = new URL(url); return u.origin + u.pathname.replace(/\d+/g, '#'); }
        catch (e) { return url.replace(/\d+/g, '#'); }
    }
    function isSegmentUrl(url, ext) {
        if (SEGMENT_EXT.includes(ext)) return true;
        if (!FMP4_EXT.includes(ext)) return false;
        try { return SEG_NAME_RE.test(new URL(url).pathname); } catch (e) { return false; }
    }
    function totalFromRange(cr) { const m = cr && /\/(\d+)\s*$/.exec(cr); return m ? parseInt(m[1], 10) : null; }

    /* ================================================================== *
     *  Media store (top frame) — background.js addItem semantics
     * ================================================================== */
    const items = [];
    const byUrl = new Map();
    const segs = new Map();
    const rawSeen = new Set();      // every raw URL already counted (folded segments too)
    const stats = { net: 0, perf: 0, dom: 0, frame: 0, viaPost: 0, viaStore: 0, probes: 0, probeOk: 0 };
    const framesSeen = new Set();
    let hookMode = 'off', perfMode = 'off', lastDl = '-';
    let idSeq = 0;

    function addItem(rec) {
        const url = rec.url;
        if (!url) return;
        const ex = byUrl.get(url);
        if (ex) {
            let ch = false;
            if (rec.size && !ex.segKey && (!ex.size || rec.size > ex.size)) { ex.size = rec.size; ch = true; }
            if (rec.mime && !ex.mime) ex.mime = rec.mime;
            if (!ex.ext && rec.ext) { ex.ext = rec.ext; ex.kind = rec.kind || ex.kind; ch = true; }
            ex.hits++;
            if (ch) changed();
            return;
        }
        if (rawSeen.has(url)) return;
        rawSeen.add(url);
        const it = {
            id: 'i' + (++idSeq), url, ext: rec.ext || '', kind: rec.kind || 'video',
            mime: rec.mime || '', size: rec.size || null,
            name: rec.blob ? sanitizeName(rec.name || document.title || 'blob media') : makeName(url, rec.ext, rec.name),
            host: hostOf(url), pageUrl: rec.pageUrl || location.href, src: rec.src || 'net',
            frame: rec.frame || '', blob: !!rec.blob, ts: Date.now(), hits: 1
        };
        if (S.collapseSegments && !it.blob && isSegmentUrl(url, it.ext)) {
            const key = segmentKey(url);
            const seg = segs.get(key);
            if (seg && byUrl.get(seg.url) === seg) {
                seg.segments++;
                if (rec.size) seg.segBytes += rec.size;
                seg.ts = Date.now();
                changed();
                return;
            }
            it.segKey = key; it.segments = 1; it.segBytes = rec.size || 0; it.size = null;
            segs.set(key, it);
        }
        items.push(it);
        byUrl.set(url, it);
        stats[it.frame ? 'frame' : it.src] = (stats[it.frame ? 'frame' : it.src] || 0) + 1;
        const cap = Math.max(50, Math.min(2000, +S.maxPerTab || 300));
        if (items.length > cap) {
            items.splice(0, items.length - cap).forEach(d => {
                byUrl.delete(d.url);
                if (d.segKey && segs.get(d.segKey) === d) segs.delete(d.segKey);
            });
        }
        changed();
        if (!it.size && !it.blob && it.kind !== 'stream' && !it.segKey && S.fetchSizes) probeSize(it);
    }
    function removeItems(list) {
        const set = new Set(list);
        for (let i = items.length - 1; i >= 0; i--) {
            if (set.has(items[i])) { byUrl.delete(items[i].url); items.splice(i, 1); }
        }
        changed();
    }
    function clearItems() {
        items.length = 0; byUrl.clear(); segs.clear(); rawSeen.clear(); domSeen.clear();
        changed();
    }
    /* Setup's "ignore media smaller than" floor — list, launcher count and
     * on-video buttons. Streams, blob: and folded segment streams are exempt
     * (their total size is unknowable); unknown sizes are kept. */
    function passesMinSize(it) {
        if (!S.minSniffBytes) return true;
        if (it.kind === 'stream' || it.blob || it.segKey) return true;
        return it.size == null || it.size >= S.minSniffBytes;
    }
    function visibleItems() {
        return items.filter(passesMinSize).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }

    /* --------------------------- size probes --------------------------- */
    const probeQ = [];
    let probeActive = 0;
    function probeSize(it) { probeQ.push(it); pumpProbe(); }
    function pumpProbe() {
        while (probeActive < 3 && probeQ.length) {
            const it = probeQ.shift();
            probeActive++;
            stats.probes++;
            probeUrl(it.url, it.pageUrl).then(info => {
                if (info) {
                    if (info.ct && !it.mime) it.mime = info.ct;
                    if (!it.ext && info.ct) {
                        const c = classify(it.url, info.ct);
                        if (c) { it.ext = c.ext; it.kind = c.kind; if (!/\.[a-z0-9]{1,5}$/i.test(it.name)) it.name += '.' + c.ext; }
                    }
                    if (info.size && !it.size) { it.size = info.size; stats.probeOk++; }
                    changed();
                }
            }, () => {}).then(() => { probeActive--; pumpProbe(); });
        }
    }
    function parseHeaders(raw) {
        const o = {};
        String(raw || '').split(/\r?\n/).forEach(l => {
            const i = l.indexOf(':');
            if (i > 0) o[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        });
        return o;
    }
    function gmProbe(method, url, ref) {
        return new Promise(res => {
            if (!A.xhr) { res(null); return; }
            let done = false, req = null;
            const fin = v => { if (!done) { done = true; res(v); } };
            const parse = r => {
                const hd = parseHeaders(r && r.responseHeaders);
                const st = (r && r.status) || 0;
                let size = totalFromRange(hd['content-range']);
                if (!size && (st === 200 || (method === 'HEAD' && st >= 200 && st < 300))) size = parseInt(hd['content-length'], 10) || null;
                return { status: st, size, ct: (hd['content-type'] || '').split(';')[0].trim() };
            };
            const headers = {};
            if (ref) headers.Referer = ref;
            if (method === 'GET') headers.Range = 'bytes=0-0';
            try {
                req = A.xhr({
                    method, url, headers, timeout: 15000,
                    onreadystatechange(r) {
                        if (method === 'GET' && r && r.readyState >= 2 && r.responseHeaders) {
                            fin(parse(r));
                            try { req && req.abort && req.abort(); } catch (e) {}
                        }
                    },
                    onload(r) { fin(parse(r)); },
                    onerror() { fin(null); }, ontimeout() { fin(null); }, onabort() { fin(null); }
                });
            } catch (e) { fin(null); }
            setTimeout(() => fin(null), 20000);
        });
    }
    async function probeUrl(url, ref) {
        if (A.xhr) {
            const h = await gmProbe('HEAD', url, ref);
            if (h && h.size) return h;
            const g = await gmProbe('GET', url, ref);    // servers that refuse HEAD: 1-byte range
            if (g && (g.size || g.ct)) return g;
            return h;
        }
        try {   // no GM_xmlhttpRequest: same-origin / CORS-enabled HEAD only
            const f = origFetch || window.fetch;
            const r = await f.call(PW, url, { method: 'HEAD', credentials: 'include' });
            return { size: totalFromRange(r.headers.get('content-range')) || parseInt(r.headers.get('content-length'), 10) || null,
                     ct: (r.headers.get('content-type') || '').split(';')[0].trim() };
        } catch (e) { return null; }
    }

    /* ================================================================== *
     *  Reporting: top adds directly, child frames forward to the top
     * ================================================================== */
    const childAll = new Map();
    const childQ = [];
    let childT = 0, storeT = 0, knownPageId = '';
    function report(rec) {
        if (!rec || !rec.url) return;
        if (IS_TOP) { addItem(rec); return; }
        if (!rec.blob && !rec.name) rec.name = makeName(rec.url, rec.ext);   // frame's own title
        const prev = childAll.get(rec.url);
        if (prev && !(rec.size && (!prev.size || rec.size > prev.size))) return;
        if (prev) childAll.delete(rec.url);
        childAll.set(rec.url, rec);
        if (childAll.size > 400) childAll.delete(childAll.keys().next().value);
        childQ.push(rec);
        if (!childT) childT = setTimeout(flushChild, 350);
    }
    function slim(r) {
        return { url: r.url, kind: r.kind, ext: r.ext || '', size: r.size || null, mime: (r.mime || '').slice(0, 100),
                 src: r.src, name: (r.name || '').slice(0, 160) };
    }
    function frameMsg(list) {
        return { __mv: NS, v: 1, type: 'items', frame: FRAME_ID, pageUrl: location.href.slice(0, 2048), items: list.map(slim) };
    }
    function flushChild() {
        childT = 0;
        const batch = childQ.splice(0, 400);
        if (!batch.length) return;
        try { window.top.postMessage(frameMsg(batch), '*'); } catch (e) {}
        if (!storeT) storeT = setTimeout(writeChildStore, 1200);
    }
    function topOriginGuess() {
        try {
            const ao = location.ancestorOrigins;
            if (ao && ao.length) return ao[ao.length - 1];
        } catch (e) {}
        try { if (document.referrer) return new URL(document.referrer).origin; } catch (e) {}
        return '';
    }
    /* Some managers strip cross-origin postMessage to the top; shared GM
     * storage reaches the top's value-change listener regardless. */
    function writeChildStore() {
        storeT = 0;
        if (!A.setValue || !A.addListener) return;
        const key = knownPageId ? 'mvf_' + knownPageId : (topOriginGuess() ? 'mvf_o_' + topOriginGuess() : '');
        if (!key) return;
        const msg = frameMsg(Array.from(childAll.values()).slice(-200));
        msg.ts = Date.now();
        sv(key, msg);
    }

    /* Frame messages are page-reachable: validate shape and every field. */
    function cleanItem(x) {
        if (!x || typeof x !== 'object') return null;
        const url = typeof x.url === 'string' ? x.url : '';
        if (!url || url.length > 4096 || !/^(https?:|blob:)/i.test(url)) return null;
        if (!['video', 'audio', 'stream'].includes(x.kind)) return null;
        const blob = /^blob:/i.test(url);
        const ext = (typeof x.ext === 'string' && /^[a-z0-9]{0,5}$/.test(x.ext)) ? x.ext : '';
        const size = (typeof x.size === 'number' && isFinite(x.size) && x.size > 0 && x.size < 1e13) ? Math.floor(x.size) : null;
        return {
            url, kind: x.kind, ext: blob ? 'blob' : ext, size, blob,
            mime: typeof x.mime === 'string' ? x.mime.slice(0, 100) : '',
            src: ['net', 'perf', 'dom'].includes(x.src) ? x.src : 'net',
            name: typeof x.name === 'string' ? x.name.slice(0, 160) : ''
        };
    }
    let lastGestureMsg = 0;
    function onFrameData(d, via) {
        if (!d || typeof d !== 'object' || d.__mv !== NS || d.v !== 1) return false;
        if (d.type === 'items' && Array.isArray(d.items)) {
            const pageUrl = (typeof d.pageUrl === 'string' && /^https?:/i.test(d.pageUrl)) ? d.pageUrl.slice(0, 2048) : '';
            if (typeof d.frame === 'string') framesSeen.add(d.frame.slice(0, 20));
            stats[via]++;
            d.items.slice(0, 500).forEach(x => {
                const r = cleanItem(x);
                if (!r) return;
                r.frame = hostOf(pageUrl) || 'frame';
                r.pageUrl = pageUrl;
                addItem(r);
            });
            return true;
        }
        if (d.type === 'gesture' && Date.now() - lastGestureMsg > 800) { lastGestureMsg = Date.now(); fireGesture(); return true; }
        return false;
    }
    function helloFrames() {
        const msg = { __mv: NS, v: 1, type: 'hello', pageId: IS_TOP ? PAGE_ID : knownPageId };
        if (!msg.pageId) return;
        try { for (let i = 0; i < window.frames.length; i++) { try { window.frames[i].postMessage(msg, '*'); } catch (e) {} } } catch (e) {}
    }
    function initFrameChannel() {
        window.addEventListener('message', e => {
            const d = e.data;
            if (!d || typeof d !== 'object' || d.__mv !== NS) return;
            if (IS_TOP) {
                if (d.type === 'hi' && e.source && e.source !== window) {
                    try { e.source.postMessage({ __mv: NS, v: 1, type: 'hello', pageId: PAGE_ID }, '*'); } catch (err) {}
                    return;
                }
                if ((e.source === window || e.source === PW) && d.type !== 'gesture') return;   // our own frame never posts items to itself
                onFrameData(d, 'viaPost');
            } else if (d.type === 'hello' && (e.source === window.parent || e.source === window.top) &&
                       typeof d.pageId === 'string' && /^[a-z0-9]{6,20}$/.test(d.pageId)) {
                const first = !knownPageId;
                knownPageId = d.pageId;
                if (first) { helloFrames(); if (childAll.size && !storeT) storeT = setTimeout(writeChildStore, 300); }
            }
        });
        if (IS_TOP) {
            const handler = (name, oldV, newV, remote) => { if (newV) onFrameData(newV, 'viaStore'); };
            onValue('mvf_' + PAGE_ID, handler);
            onValue('mvf_o_' + location.origin, handler);
            window.addEventListener('pagehide', () => { dv('mvf_' + PAGE_ID); });
            let n = 0;
            const tick = () => { helloFrames(); n++; setTimeout(tick, n < 10 ? 2000 : 10000); };
            setTimeout(tick, 300);
        } else {
            try { window.top.postMessage({ __mv: NS, v: 1, type: 'hi' }, '*'); } catch (e) {}
        }
    }

    /* ================================================================== *
     *  Network detection: fetch / XHR response headers
     * ================================================================== */
    let origFetch = null;
    function onNetRecord(r) {
        try {
            if (!r || !r.url) return;
            const url = absUrl(String(r.url));
            if (!/^https?:/i.test(url)) return;
            const st = +r.st || 0;
            if (st >= 400) return;
            const cls = classify(url, r.ct || '');
            if (!cls) return;
            let size = totalFromRange(r.cr);
            if (!size) {
                const cl = parseInt(r.cl, 10) || null;
                // a 206 without a readable Content-Range only tells the chunk length
                size = (st === 206 && !isSegmentUrl(url, cls.ext)) ? null : cl;
            }
            report({ url, kind: cls.kind, ext: cls.ext, mime: (r.ct || '').split(';')[0].trim(), size, src: 'net' });
        } catch (e) {}
    }
    /* Self-contained so it can also be stringified into a page <script>. */
    function makeHooks(win, emit, wrap) {
        wrap = wrap || (f => f);
        try {
            const of = win.fetch;
            if (typeof of === 'function' && !of.__mvh) {
                const nf = wrap(function (input, init) {
                    const p = of.apply(this, arguments);
                    try {
                        const u = typeof input === 'string' ? input : ((input && input.url) || String(input || ''));
                        p.then(res => {
                            try {
                                const g = n => { try { return res.headers.get(n); } catch (e) { return null; } };
                                emit({ url: res.url || u, ct: g('content-type'), cl: g('content-length'), cr: g('content-range'), st: res.status });
                            } catch (e) {}
                        }, () => {});
                    } catch (e) {}
                    return p;
                });
                try { nf.__mvh = 1; } catch (e) {}
                win.fetch = nf;
            }
        } catch (e) {}
        try {
            const XP = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
            if (XP && !XP.__mvh) {
                const oo = XP.open, os = XP.send;
                XP.open = wrap(function (m, u) { try { this.__mvu = u; } catch (e) {} return oo.apply(this, arguments); });
                XP.send = wrap(function () {
                    try {
                        const x = this;
                        let done = false;
                        x.addEventListener('readystatechange', function () {
                            if (done || x.readyState < 2) return;
                            done = true;
                            try {
                                emit({ url: x.responseURL || String(x.__mvu || ''), ct: x.getResponseHeader('content-type'),
                                       cl: x.getResponseHeader('content-length'), cr: x.getResponseHeader('content-range'), st: x.status });
                            } catch (e) {}
                        });
                    } catch (e) {}
                    return os.apply(this, arguments);
                });
                try { XP.__mvh = 1; } catch (e) {}
            }
        } catch (e) {}
    }
    let ttPolicy;
    /* Trusted-Types pages (YouTube, Google…) reject plain strings for script
     * text — and log a violation even when the exception is caught. Use a
     * policy when the page's CSP allows creating one. */
    function trustedScript(code) {
        if (ttPolicy === undefined) {
            ttPolicy = null;
            try {
                const tt = PW.trustedTypes || window.trustedTypes;
                if (tt && tt.createPolicy) ttPolicy = tt.createPolicy('media-vault-us-' + rnd(6), { createScript: x => x });
            } catch (e) { ttPolicy = null; }
        }
        return ttPolicy ? ttPolicy.createScript(code) : code;
    }
    function runInPage(code) {
        try {
            const s = document.createElement('script');
            s.textContent = trustedScript(code);
            (document.head || document.documentElement).appendChild(s);
            s.remove();
            return true;
        } catch (e) { return false; }
    }
    function installNet() {
        try { origFetch = PW.fetch; } catch (e) {}
        const wrap = typeof exportFunction === 'function' ? (f => { try { return exportFunction(f, PW); } catch (e) { return f; } }) : null;
        makeHooks(PW, onNetRecord, wrap);
        hookMode = 'unsafeWindow (unverified)';
        // A distinct unsafeWindow is the page's window by contract (TM / VM
        // page mode, Firefox wrappedJSObject): no probe, no CSP noise. Only the
        // ambiguous unsafeWindow === window case (isolated world?) is probed.
        if (PW !== window) { hookMode = 'page world (unsafeWindow)'; return; }
        // At document-start <html> may not exist yet. A MutationObserver
        // callback (microtask) still runs before the parser's first script.
        if (document.documentElement) verifyHookWorld();
        else {
            try {
                const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); verifyHookWorld(); } });
                mo.observe(document, { childList: true });
            } catch (e) {}
        }
    }
    /* Is unsafeWindow really the page's window? Ask a page <script>. If we are
     * in an isolated world (e.g. Violentmonkey content mode), hook from a page
     * script instead and bridge the records back with a DOM event. */
    function verifyHookWorld() {
        const mark = 'mvmark' + rnd(8);
        try { PW[mark] = 1; } catch (e) {}
        const attr = 'data-' + mark;
        const de = document.documentElement;
        runInPage('document.documentElement.setAttribute(' + JSON.stringify(attr) + ',typeof window[' + JSON.stringify(mark) + '])');
        const seen = de.getAttribute(attr);
        de.removeAttribute(attr);
        try { delete PW[mark]; } catch (e) {}
        if (seen === 'number') { hookMode = 'page world (unsafeWindow)'; return; }
        if (seen === 'undefined') {
            const EVT = 'mvnet-' + rnd(10);
            document.addEventListener(EVT, e => {
                try { const d = JSON.parse(String(e.detail || '')); if (d && typeof d === 'object') onNetRecord(d); } catch (err) {}
            });
            runInPage('(' + makeHooks.toString() + ')(window,function(r){try{document.dispatchEvent(new CustomEvent(' +
                JSON.stringify(EVT) + ',{detail:JSON.stringify(r)}))}catch(e){}});document.documentElement.setAttribute(' +
                JSON.stringify(attr + 'h') + ',"1")');
            const ok = de.getAttribute(attr + 'h') === '1';     // CSP can drop the script without an exception
            de.removeAttribute(attr + 'h');
            hookMode = ok ? 'page world (injected script)' : 'isolated world only (page script blocked) — performance timeline still works';
        }
        // null: page scripts blocked (CSP / Trusted Types) — then we are almost
        // certainly already in the page world (TM / XBrowser), keep the hooks.
    }

    /* ================================================================== *
     *  PerformanceObserver: requests the page's JS never made
     * ================================================================== */
    function onPerfEntry(e) {
        try {
            const url = e.name;
            if (!url || !/^https?:/i.test(url)) return;
            const init = e.initiatorType || '';
            let cls = classify(url, e.contentType || '');
            if (!cls && (init === 'video' || init === 'audio')) cls = { kind: init, ext: extOf(url) };
            if (!cls) return;
            const body = e.encodedBodySize || e.transferSize || 0;
            let size = null;
            if (isSegmentUrl(url, cls.ext)) size = body || null;
            else if (e.responseStatus === 200 && body) size = e.decodedBodySize || body;
            const st = e.responseStatus || 0;
            if (st >= 400) return;
            report({ url, kind: cls.kind, ext: cls.ext, mime: (e.contentType || ''), size, src: 'perf' });
        } catch (err) {}
    }
    function installPerf() {
        try {
            const PO = window.PerformanceObserver;
            if (!PO) { perfMode = 'unsupported'; return; }
            const po = new PO(list => { try { list.getEntries().forEach(onPerfEntry); } catch (e) {} });
            try { po.observe({ type: 'resource', buffered: true }); perfMode = 'on (buffered)'; }
            catch (e) {
                po.observe({ entryTypes: ['resource'] }); perfMode = 'on';
                try { performance.getEntriesByType('resource').forEach(onPerfEntry); } catch (e2) {}
            }
        } catch (e) { perfMode = 'error: ' + (e && e.message); }
    }

    /* ================================================================== *
     *  DOM scan: <video>/<audio>/<source>, currentSrc, same-origin iframes
     * ================================================================== */
    const domSeen = new Set();
    function collectSources(el) {
        const urls = [];
        try {
            if (el.currentSrc) urls.push(el.currentSrc);
            if (el.src) urls.push(el.src);
            el.querySelectorAll && el.querySelectorAll('source[src]').forEach(s => urls.push(s.src));
        } catch (e) {}
        return Array.from(new Set(urls.filter(u => u && !/^data:/i.test(u))));
    }
    function reportDom(u, kind) {
        if (domSeen.has(u)) return;
        domSeen.add(u);
        const blob = /^blob:/i.test(u);
        let cls = blob ? { kind, ext: 'blob' } : classify(u, '');
        if (!cls) cls = { kind, ext: extOf(u) || '' };
        report({ url: u, kind: cls.kind, ext: cls.ext, mime: '', size: null, src: 'dom', blob,
                 name: blob ? (document.title || 'blob media') : '' });
    }
    function scanDoc(doc, depth) {
        let els;
        try { els = doc.querySelectorAll('video, audio'); } catch (e) { return; }
        els.forEach(el => {
            const kind = el.tagName === 'AUDIO' ? 'audio' : 'video';
            collectSources(el).forEach(u => reportDom(u, kind));
            if (IS_TOP && depth === 0 && kind === 'video' && S.buttonOn) ensureButton(el);
        });
        if (depth < 3) {
            try {
                doc.querySelectorAll('iframe, frame').forEach(f => {
                    let d = null;
                    try { d = f.contentDocument; } catch (e) {}
                    if (d && d !== doc) scanDoc(d, depth + 1);
                });
            } catch (e) {}
        }
    }
    function scan() {
        scanDoc(document, 0);
        if (IS_TOP) pruneButtons();
    }
    let scanT = 0;
    function scheduleScan() { if (!scanT) scanT = setTimeout(() => { scanT = 0; scan(); }, 350); }

    /* ================================================================== *
     *  Downloads, apps, players, clipboard
     * ================================================================== */
    /* Android VIEW intent. Broad type (video/* / audio/*) is what actually
     * resolves on real devices; an exact codec MIME often matches nothing. */
    function buildIntent(url, pkg, kind, title, opt) {
        opt = opt || {};
        let it;
        const m = opt.formB && /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
        if (m) it = 'intent://' + m[2] + '#Intent;scheme=' + m[1] + ';action=android.intent.action.VIEW;';
        else it = 'intent:' + url + '#Intent;action=android.intent.action.VIEW;';
        const type = opt.type !== undefined ? opt.type : (kind === 'audio' ? 'audio/*' : 'video/*');
        if (type) it += 'type=' + encodeURIComponent(type) + ';';
        if (pkg) it += 'package=' + pkg + ';';
        if (title) it += 'S.title=' + encodeURIComponent(String(title).slice(0, 120)) + ';';
        return it + 'end';
    }
    let lastIntent = '', lastPlayItem = null;
    function fireIntent(intent, label) {
        lastIntent = intent;
        try { console.log('[Media Vault] intent (' + (label || '') + '):', intent); } catch (e) {}
        location.href = intent;
    }
    function silentCopy(text) {
        if (A.setClipboard) { try { A.setClipboard(text, 'text'); return Promise.resolve(true); } catch (e) {} }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(text).then(() => true, () => execCopy(text));
        }
        return Promise.resolve(execCopy(text));
    }
    function execCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px';
            (document.body || document.documentElement).appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (e) { return false; }
    }
    function copyText(text, msg) { silentCopy(text).then(ok => toast(ok ? (msg || 'Copied') : 'Copy failed')); }
    function openTab(url) {
        if (A.openTab) { try { A.openTab(url, false); return; } catch (e) {} }
        try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    }
    function fileName(it) {
        let n = it.name || 'media';
        if (!/\.[a-z0-9]{1,5}$/i.test(n) && it.ext && it.ext !== 'blob') n += '.' + it.ext;
        return sanitizeName(n) || 'media';
    }
    function refererFor(it) { return (it && it.pageUrl) || location.href; }
    function anchorSave(href, name) {
        const a = document.createElement('a');
        a.href = href; a.download = name || 'media'; a.rel = 'noopener';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 0);
    }
    function linkDownload(it) {
        lastDl = 'link';
        let same = false;
        try { same = new URL(it.url).origin === location.origin; } catch (e) {}
        if (same) { anchorSave(it.url, fileName(it)); toast('Saving…'); }
        else { openTab(it.url); toast('Opened the file — the browser’s downloader can take it from there'); }
    }
    /* Fetch as a blob (GM_xmlhttpRequest bypasses CORS, Referer for hotlink
     * protection) and save — forces a real download instead of the browser
     * opening the video. Buffered in memory: big files → use an app. */
    function blobDownload(it) {
        if (!A.xhr) { toast('GM_xmlhttpRequest unavailable — opening the link'); linkDownload(it); return; }
        lastDl = 'blob';
        toast('Starting download…');
        let lastPct = -1;
        try {
            A.xhr({
                method: 'GET', url: it.url, responseType: 'blob', timeout: 0,
                headers: { Referer: refererFor(it) },
                onprogress(e) {
                    if (e && e.lengthComputable && e.total) {
                        const p = Math.round(e.loaded / e.total * 100);
                        if (p !== lastPct && p % 5 === 0) { lastPct = p; toast('Downloading ' + p + '%'); }
                    }
                },
                onload(r) {
                    try {
                        const blob = r && r.response;
                        if (!blob || !blob.size || (r.status && r.status >= 400)) { toast('Empty / refused response — opening the link'); linkDownload(it); return; }
                        const u = URL.createObjectURL(blob);
                        anchorSave(u, fileName(it));
                        setTimeout(() => URL.revokeObjectURL(u), 120000);
                        toast('Saved: ' + fileName(it));
                    } catch (e) { toast('Save failed — opening the link'); linkDownload(it); }
                },
                onerror() { toast('Direct download failed — opening the link'); linkDownload(it); },
                ontimeout() { toast('Timed out — opening the link'); linkDownload(it); }
            });
        } catch (e) { linkDownload(it); }
    }
    /* GM_download with Referer (hotlink-protected hosts otherwise 403, which
     * XBrowser shows as a download stuck in the queue) and XBrowser's `tag`. */
    function gmDownload(it) {
        lastDl = 'GM_download';
        const opts = {
            url: it.url, name: fileName(it), saveAs: false,
            headers: { Referer: refererFor(it) },
            onload() { toast('Downloaded: ' + fileName(it)); },
            onerror(e) {
                const why = e && (e.error || e.details) ? ': ' + (e.error || e.details) : '';
                toast('Manager download failed' + why + ' — trying direct');
                blobDownload(it);
            },
            ontimeout() { toast('Manager download timed out — trying direct'); blobDownload(it); }
        };
        if (S.gmTag) opts.tag = S.gmTag;
        try { A.download(opts); toast('Sent to the downloader…'); }
        catch (e) { blobDownload(it); }
    }
    function browserDownload(it) {
        if (S.browserEngine === 'link') return linkDownload(it);
        if (S.browserEngine === 'blob') return blobDownload(it);
        if (A.download) return gmDownload(it);
        return blobDownload(it);
    }
    /* Hand the direct link to an Android app. The tap that got us here is the
     * user activation Android requires; the link is copied first (1DM / ADM
     * watch the clipboard and offer the download on their own). */
    function sendToApp(it, dl, opts) {
        opts = opts || {};
        const copied = !opts.skipCopy && S.copyOnSend !== false;
        if (copied) silentCopy(it.url);
        lastDl = 'intent → ' + dl.label;
        try {
            fireIntent(buildIntent(it.url, dl.pkg, it.kind, it.name), dl.label);
            toast('Sent to ' + dl.label + (copied ? ' · link copied' : '') + (opts.note || ''));
        } catch (e) { toast('Could not open ' + dl.label + ' — using the browser'); browserDownload(it); }
    }
    function downloadOne(it) {
        if (it.blob) { toast('blob: streams can only be watched in-page'); return; }
        const dl = resolveDl();
        if (dl.pkg !== null) return sendToApp(it, dl);
        browserDownload(it);
    }
    async function downloadMany(list) {
        list = list.filter(i => !i.blob);
        if (!list.length) return;
        const dl = resolveDl();
        if (dl.pkg !== null && list.length > 1) {
            // apps take one intent at a time: copy them all, hand over the first
            await silentCopy(list.map(i => i.url).join('\n'));
            sendToApp(list[0], dl, { skipCopy: true, note: ' · ' + list.length + ' links copied — add the rest from the clipboard' });
            return;
        }
        for (const it of list) { downloadOne(it); await new Promise(r => setTimeout(r, 400)); }
    }
    function openInPlayer(it) {
        if (it.blob) { toast('blob: streams can only be watched in-page'); return; }
        lastPlayItem = it;
        if (!intentsOn()) { openTab(it.url); return; }
        try { fireIntent(buildIntent(it.url, S.playerPackage, it.kind, it.name, { formB: S.intentFormB }), 'player'); }
        catch (e) { openTab(it.url); }
    }

    /* ================================================================== *
     *  Debug console (eruda) — fetched via GM_xmlhttpRequest so CSP can't block it
     * ================================================================== */
    function toggleConsole() {
        const w = window;
        const init = () => { try { w.eruda.init(); toast('Console open — tap its gear button'); } catch (e) { toast('Console init failed'); } };
        if (w.eruda) {
            try { w.eruda.destroy(); w.eruda = null; toast('Console closed'); } catch (e) { init(); }
            return;
        }
        toast('Loading console…');
        const tag = () => {
            try {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/eruda';
                s.onload = () => { if (!w.eruda && PW.eruda) w.eruda = PW.eruda; init(); };
                s.onerror = () => toast('Could not load the console (blocked / offline)');
                (document.body || document.documentElement).appendChild(s);
            } catch (e) { toast('Could not load the console'); }
        };
        if (!A.xhr) { tag(); return; }
        try {
            A.xhr({
                method: 'GET', url: 'https://cdn.jsdelivr.net/npm/eruda', timeout: 30000,
                onload(r) { try { (0, eval)(r.responseText); init(); } catch (e) { tag(); } },   // eslint-disable-line no-eval
                onerror: tag, ontimeout: tag
            });
        } catch (e) { tag(); }
    }

    /* ================================================================== *
     *  UI plumbing: closed shadow root, DOM builder, icons, styles
     * ================================================================== */
    const SVGNS = 'http://www.w3.org/2000/svg';
    const ICONS = {
        clap: ['M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', 'm4 11-1.5-4.5 15.2-5 1.5 4.5z', 'm7.6 9 2.2-4.6M12.4 7.4l2.2-4.6'],
        film: [{ t: 'rect', x: 2, y: 2, width: 20, height: 20, rx: 2.2 }, 'M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5'],
        sliders: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'],
        search: [{ t: 'circle', cx: 11, cy: 11, r: 7 }, 'm21 21-4.3-4.3'],
        check: ['M20 6 9 17l-5-5'],
        x: ['M18 6 6 18M6 6l12 12'],
        download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5M12 15V3'],
        copy: [{ t: 'rect', x: 9, y: 9, width: 13, height: 13, rx: 2 }, 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
        trash: ['M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
        play: ['M8 5v14l11-7z'],
        music: ['M9 18V5l12-2v13', { t: 'circle', cx: 6, cy: 18, r: 3 }, { t: 'circle', cx: 18, cy: 16, r: 3 }],
        external: ['M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
        refresh: ['M23 4v6h-6M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15'],
        save: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'],
        monitor: [{ t: 'rect', x: 2, y: 3, width: 20, height: 14, rx: 2 }, 'M8 21h8M12 17v4'],
        activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
        bug: ['M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 1 1 6 0v1.1', 'M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9',
              'M6.5 9C4.6 8.8 3 7.1 3 5M6 13H2M3 21c0-2.1 1.7-3.9 3.8-4M21 5c0 2.1-1.6 3.8-3.5 4M22 13h-4M17.2 17c2.1.1 3.8 1.9 3.8 4'],
        layers: ['M12 2 2 7l10 5 10-5-10-5z', 'm2 17 10 5 10-5', 'm2 12 10 5 10-5'],
        list: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01']
    };
    function ico(name, size, filled) {
        const s = document.createElementNS(SVGNS, 'svg');
        const at = { viewBox: '0 0 24 24', width: size || 16, height: size || 16, fill: filled ? 'currentColor' : 'none',
                     stroke: filled ? 'none' : 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        for (const k in at) s.setAttribute(k, at[k]);
        for (const part of ICONS[name] || []) {
            let el;
            if (typeof part === 'string') { el = document.createElementNS(SVGNS, 'path'); el.setAttribute('d', part); }
            else { el = document.createElementNS(SVGNS, part.t); for (const k in part) if (k !== 't') el.setAttribute(k, part[k]); }
            s.appendChild(el);
        }
        return s;
    }
    /* DOM builder: text only through textContent / text nodes, never HTML. */
    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        if (props) {
            for (const k in props) {
                const v = props[k];
                if (v == null || v === false) continue;
                if (k === 'class') el.className = v;
                else if (k === 'text') el.textContent = v;
                else if (k === 'style') Object.assign(el.style, v);
                else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
                else if (typeof v !== 'string' && k in el) el[k] = v;
                else el.setAttribute(k, v === true ? '' : String(v));
            }
        }
        for (const c of kids.flat(3)) {
            if (c == null || c === false) continue;
            el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
        }
        return el;
    }

    const CSS = `
:host{all:initial;--z:1;
  --bg:#0f0f17;--bg2:#181823;--bg3:#22222f;--bg4:#2b2b3a;--line:#2e2e3d;--line2:#3a3a4c;
  --txt:#edeef5;--muted:#8f90a6;--dim:#6b6c80;
  --blue:#5b8cff;--violet:#a855f7;--amber:#f59e0b;--emerald:#10b981;--danger:#f43f5e;--cyan:#22d3ee;
  --sec:var(--violet);--grad:linear-gradient(135deg,#a855f7 0%,#5b8cff 100%)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
.ui{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.35;color:var(--txt);
  text-align:left;letter-spacing:normal;text-transform:none;direction:ltr}
button,input,select{font-family:inherit;margin:0;line-height:1.2}
button{cursor:pointer}
svg{display:block;flex:0 0 auto}
.hidden{display:none!important}

/* ---------- on-video button ---------- */
.vbtn{position:fixed;z-index:3;border:none;border-radius:50%;background:linear-gradient(135deg,#5b8cff,#a855f7);color:#fff;
  display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer;padding:0;margin:0}
.vbtn svg{width:50%;height:50%;margin-left:6%}

/* ---------- corner launcher ---------- */
.fab{position:fixed;z-index:4;left:0;top:0;width:48px;height:48px;border-radius:16px;border:none;padding:0;background:var(--grad);color:#fff;
  display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(124,92,255,.45),0 2px 6px rgba(0,0,0,.45);
  touch-action:none;user-select:none;-webkit-user-select:none;transform-origin:0 0;transform:scale(var(--z))}
.fab .cnt{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;border-radius:10px;background:var(--danger);color:#fff;
  font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;padding:0 5px;border:2px solid var(--bg)}

/* ---------- toast ---------- */
.toast{position:fixed;z-index:30;left:50%;bottom:calc(84px * var(--z));transform:translateX(-50%) scale(var(--z));transform-origin:50% 100%;
  background:var(--bg4);color:#fff;padding:10px 16px;border-radius:22px;font-size:12.5px;font-weight:600;
  box-shadow:0 6px 20px rgba(0,0,0,.55);border:1px solid var(--line2);max-width:calc(88vw / var(--z));width:max-content;text-align:center;
  opacity:0;pointer-events:none;transition:opacity .2s}
.toast.show{opacity:1}

/* ---------- bottom sheet (the extension popup) ---------- */
.sheet-wrap{position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.45);opacity:0;transition:opacity .22s}
.sheet-wrap.show{opacity:1}
.sheet{position:fixed;left:0;bottom:0;z-index:11;width:100%;height:86%;background:var(--bg);border-radius:18px 18px 0 0;overflow:hidden;
  box-shadow:0 -8px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;
  transform-origin:0 100%;transform:scale(var(--z)) translateY(105%);transition:transform .26s cubic-bezier(.2,.8,.3,1)}
.sheet.show{transform:scale(var(--z)) translateY(var(--dy,0px))}
.sheet.drag{transition:none}
.sheet[data-sec="tab"]{--sec:var(--violet)}
.sheet[data-sec="settings"]{--sec:var(--cyan)}
.sheet[data-sec="diag"]{--sec:var(--amber)}
.grab{flex:0 0 auto;height:26px;display:flex;align-items:center;justify-content:center;background:var(--bg2);cursor:grab;touch-action:none}
.pill{width:52px;height:5.5px;border-radius:3px;background:#4a4a5e}
header{display:flex;align-items:center;gap:10px;padding:10px 12px;flex:0 0 auto;background:var(--grad);color:#fff;
  box-shadow:0 2px 14px rgba(168,85,247,.28)}
header .logo{width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center}
header h1{font-size:16px;margin:0;font-weight:800;flex:1;letter-spacing:.2px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:0;
  background:var(--bg3);border:1px solid var(--line);color:var(--txt)}
header .icon{background:rgba(255,255,255,.16);border:none;color:#fff}
header .icon:active{background:rgba(255,255,255,.3)}
nav{display:flex;background:var(--bg2);border-bottom:1px solid var(--line);flex:0 0 auto}
nav button{flex:1;background:none;border:none;color:var(--dim);padding:8px 3px 7px;display:flex;flex-direction:column;align-items:center;gap:3px;
  position:relative;font-size:10.5px;font-weight:700;transition:color .15s;min-width:0}
nav button .nl{display:flex;align-items:center;gap:4px}
nav button::after{content:"";position:absolute;left:22%;right:22%;bottom:0;height:2.5px;border-radius:2px 2px 0 0;background:transparent}
nav button.on::after{background:currentColor}
nav button[data-sec="tab"].on{color:var(--violet)}
nav button[data-sec="settings"].on{color:var(--cyan)}
nav button[data-sec="diag"].on{color:var(--amber)}
nav em{font-style:normal;font-size:9.5px;font-weight:800;background:var(--bg4);color:var(--muted);border-radius:9px;padding:1px 5px;min-width:16px;text-align:center}
nav em:empty{display:none}
nav button.on em{background:var(--sec);color:#0f0f17}
.filters{padding:9px 12px;background:var(--bg2);border-bottom:1px solid var(--line);flex:0 0 auto;display:flex;flex-direction:column;gap:7px}
.searchwrap{display:flex;align-items:center;gap:7px;background:var(--bg3);border:1.5px solid var(--line);border-radius:11px;padding:0 10px;color:var(--dim)}
.searchwrap:focus-within{border-color:var(--sec)}
.search{flex:1;background:none;border:none;color:var(--txt);padding:9px 0;font-size:13.5px;min-width:0;outline:none;-webkit-appearance:none;appearance:none}
.selects{display:flex;gap:6px}
.selects select{flex:1;background:var(--bg3);border:1.5px solid var(--line);color:var(--txt);border-radius:9px;padding:7px 6px;font-size:11.5px;font-weight:600;min-width:0;outline:none}
.selects select:focus{border-color:var(--sec)}
.main{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:var(--bg)}
.sec{padding:10px 11px 18px}
.row{display:flex;gap:10px;align-items:flex-start;padding:10px 11px;margin-bottom:9px;background:var(--bg2);border:1px solid var(--line);
  border-radius:12px;border-left:3px solid var(--sec)}
.row.sel{background:linear-gradient(90deg,rgba(168,85,247,.2),var(--bg2));border-left-color:var(--violet);border-color:var(--line2)}
.row input[type=checkbox]{width:19px;height:19px;flex:0 0 auto;margin:4px 0 0;accent-color:var(--violet)}
.av{width:30px;height:30px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#fff;margin-top:1px}
.row .body{min-width:0;flex:1}
.row .t{font-size:12.5px;font-weight:700;word-break:break-all;line-height:1.35}
.row .meta{font-size:10px;color:var(--dim);margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.row .meta .size{color:var(--emerald);font-weight:800;font-size:10.5px}
.badge{font-size:9px;border-radius:5px;padding:1.5px 6px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;background:var(--bg4);color:var(--muted)}
.badge.video{background:rgba(91,140,255,.2);color:#9ab8ff}
.badge.audio{background:rgba(16,185,129,.18);color:#5fd3ab}
.badge.stream{background:rgba(245,158,11,.18);color:#f5c163}
.badge.blob{background:rgba(168,85,247,.2);color:#cf9df7}
.badge.seg{background:rgba(34,211,238,.15);color:#7fdff0}
.badge.frame{background:rgba(244,63,94,.14);color:#ffb3c0}
.row .acts{display:flex;gap:4px;margin-top:8px;flex-wrap:wrap}
.ab{border-radius:8px;padding:7px 9px;font-size:10.5px;font-weight:700;cursor:pointer;background:var(--bg3);color:var(--txt);
  border:1px solid var(--line2);display:inline-flex;align-items:center;gap:4px}
.ab.g{background:linear-gradient(135deg,#10b981,#059669);border-color:transparent;color:#fff}
.ab.p{background:linear-gradient(135deg,#5b8cff,#7c6cff);border-color:transparent;color:#fff}
.tabhead{display:flex;align-items:center;gap:7px;margin:6px 0 10px;color:var(--sec);font-size:11px;font-weight:800;letter-spacing:.4px}
.tabhead .rule{flex:1;height:1px;background:linear-gradient(90deg,currentColor,transparent);opacity:.35}
.tabhead .tt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%}
.btn{background:var(--bg3);border:1px solid var(--line2);color:var(--txt);border-radius:10px;padding:9px 12px;font-size:12.5px;font-weight:700;
  display:inline-flex;align-items:center;gap:6px;justify-content:center}
.btn:active{transform:scale(.96)}
.btn.p{background:linear-gradient(135deg,#5b8cff,#7c6cff);border-color:transparent;color:#fff}
.btn.g{background:linear-gradient(135deg,#10b981,#059669);border-color:transparent;color:#fff}
.btn.d{background:rgba(244,63,94,.14);border-color:rgba(244,63,94,.4);color:#ffb3c0}
.btn.w{width:100%}
footer{flex:0 0 auto;background:var(--bg2);border-top:1px solid var(--line);padding:9px 10px;box-shadow:0 -3px 14px rgba(0,0,0,.35)}
footer .selinfo{font-size:11.5px;color:var(--muted);margin-bottom:8px;display:flex;align-items:center;gap:6px}
footer .selinfo b{color:var(--violet);font-size:13px}
footer .selinfo .sp{flex:1}
footer .lnk{background:none;border:none;color:var(--blue);font-size:11.5px;font-weight:700;padding:2px 4px}
footer .btns{display:flex;gap:6px;overflow-x:auto}
footer .btns .btn{white-space:nowrap;flex:0 0 auto}
.empty{color:var(--muted);text-align:center;padding:34px 16px;line-height:1.65;font-size:13px}
.empty .eico{width:56px;height:56px;border-radius:18px;margin:0 auto 12px;display:flex;align-items:center;justify-content:center;background:var(--bg3);color:var(--sec)}
.empty b{color:var(--txt)}
.field{margin-bottom:15px}
.field label{display:block;font-size:13px;font-weight:700;margin-bottom:5px}
.field .h{display:block;font-size:11px;color:var(--muted);margin-top:3px;line-height:1.5;font-weight:500}
.field input[type=number],.field input[type=text],.field select{width:100%;background:var(--bg3);border:1.5px solid var(--line);color:var(--txt);
  border-radius:10px;padding:10px;font-size:13.5px;outline:none}
.field input:focus,.field select:focus{border-color:var(--sec)}
.field.inline{display:flex;align-items:center;gap:11px}
.field.inline label{flex:1;margin:0;min-width:0}
.field.inline input[type=checkbox]{width:21px;height:21px;accent-color:var(--sec);flex:0 0 auto;margin:0}
.field.inline input[type=number]{width:88px;flex:0 0 auto}
.field.inline select{width:150px;flex:0 0 auto}
pre.diag{background:var(--bg2);border:1px solid var(--line);border-radius:10px;padding:11px;margin:9px 0 0;font-size:10.5px;line-height:1.55;
  white-space:pre-wrap;word-break:break-word;max-height:none;overflow:auto;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace}
.brow{display:flex;gap:6px;flex-wrap:wrap}
.brow .btn{flex:1 1 auto}

/* ---------- on-page panel (preview player) ---------- */
.ov{position:fixed;inset:0;z-index:12;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center}
.panel{background:var(--bg2);color:var(--txt);border:1px solid var(--line2);border-radius:14px;width:min(calc(94vw / var(--z)),540px);
  max-height:calc(90vh / var(--z));display:flex;flex-direction:column;overflow:hidden;box-shadow:0 14px 50px rgba(0,0,0,.65);transform:scale(var(--z))}
.phead{display:flex;align-items:center;gap:8px;padding:10px 10px 10px 13px;background:var(--grad);color:#fff;font-weight:800;font-size:14px}
.phead .pt{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.phead .icon{width:30px;height:30px;background:rgba(255,255,255,.16);border:none;color:#fff}
.player{background:#000;min-height:170px;max-height:calc(44vh / var(--z));display:flex;flex:0 0 auto}
.player video,.player audio{width:100%;max-height:calc(44vh / var(--z));background:#000;display:block}
.noprev{color:var(--muted);font-size:12.5px;display:flex;align-items:center;justify-content:center;flex:1;padding:18px;text-align:center;line-height:1.5}
.pbody{overflow:auto;padding:10px 11px;overscroll-behavior:contain}
.pitem{border:1px solid var(--line);border-left:3px solid var(--violet);border-radius:11px;padding:9px 11px;margin-bottom:9px;background:var(--bg)}
.pitem.on{border-color:var(--blue);background:#1b2337}
.pitem .t{font-size:12.5px;font-weight:700;word-break:break-all;margin-bottom:4px}
.pitem .meta{font-size:10px;color:var(--dim);display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;align-items:center}
.pitem .meta .size{color:var(--emerald);font-weight:800;font-size:10.5px}
.pitem .acts{display:flex;gap:5px;flex-wrap:wrap}

/* ---------- modal ---------- */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.68);display:flex;align-items:center;justify-content:center;padding:18px;z-index:20}
.modal .mp{background:var(--bg2);border:1px solid var(--line2);border-radius:16px;width:min(calc(92vw / var(--z)),380px);max-height:calc(86vh / var(--z));
  overflow:auto;padding:17px;box-shadow:0 16px 50px rgba(0,0,0,.6);transform:scale(var(--z))}
.modal h3{margin:0 0 10px;font-size:15.5px}
.modal .mb{display:flex;flex-direction:column;gap:8px}
.modal .h{font-size:12px;color:var(--muted);line-height:1.45}
.modal .btn{justify-content:flex-start;text-align:left}
`;

    let host = null, root = null, ui = null, uiZ = 1;
    function computeZ() {
        if (+S.uiScale > 0) return Math.max(0.75, Math.min(3, +S.uiScale));
        try {
            const sw = screen.width || 0, iw = window.innerWidth || 0;
            const touch = IS_ANDROID || (navigator.maxTouchPoints || 0) > 0;
            if (touch && sw && iw > sw * 1.15) return Math.min(3.5, iw / sw);   // desktop-width page on a phone
        } catch (e) {}
        return 1;
    }
    function applyZ() {
        uiZ = Math.round(computeZ() * 100) / 100;
        if (host) host.style.setProperty('--z', String(uiZ));
        layoutSheet();
    }
    function fsParent() {
        const fe = document.fullscreenElement || document.webkitFullscreenElement;
        return fe && !/^(VIDEO|AUDIO|IFRAME|IMG|CANVAS)$/.test(fe.tagName) ? fe : null;
    }
    function mountHost() {
        const parent = fsParent() || document.documentElement;
        if (parent && host.parentNode !== parent) { try { parent.appendChild(host); } catch (e) {} }
    }
    function ensureRoot() {
        if (root) { if (!host.isConnected) mountHost(); return root; }
        host = document.createElement('mv-vault-' + rnd(6).replace(/^[0-9]/, 'x'));
        const hs = host.style;
        hs.setProperty('all', 'initial', 'important');
        [['position', 'fixed'], ['top', '0'], ['left', '0'], ['width', '0'], ['height', '0'], ['z-index', '2147483647'],
         ['display', 'block'], ['overflow', 'visible'], ['visibility', 'visible'], ['opacity', '1'], ['transform', 'none'],
         ['filter', 'none'], ['contain', 'none'], ['pointer-events', 'auto']].forEach(([k, v]) => hs.setProperty(k, v, 'important'));
        root = host.attachShadow({ mode: 'closed' });
        let styled = false;
        try {
            if (window.CSSStyleSheet && 'adoptedStyleSheets' in root) {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(CSS);
                root.adoptedStyleSheets = [sheet];
                styled = root.adoptedStyleSheets.length === 1;
            }
        } catch (e) {}
        if (!styled) { const st = document.createElement('style'); st.textContent = CSS; root.appendChild(st); }
        ui = h('div', { class: 'ui' });
        root.appendChild(ui);
        // keep our clicks / keys / touches away from the page's bubbling handlers
        ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchmove',
         'keydown', 'keyup', 'keypress', 'input', 'change', 'wheel', 'contextmenu', 'focusin', 'focusout']
            .forEach(t => root.addEventListener(t, e => e.stopPropagation(), { passive: t === 'touchmove' || t === 'wheel' || t === 'touchstart' }));
        root.addEventListener('keydown', e => {
            if (e.key === 'Escape') { if (modalEl) closeModal(); else if (panelEl) closePanel(); else if (sheetOpen) closeSheet(); }
        });
        applyZ();
        mountHost();
        if (gv('debugExposeShadow', false)) { try { window.__MV.shadow = root; } catch (e) {} }
        return root;
    }

    let toastEl = null, toastT = 0;
    function toast(m) {
        if (!IS_TOP) return;
        ensureRoot();
        if (!toastEl) { toastEl = h('div', { class: 'toast' }); ui.appendChild(toastEl); }
        toastEl.textContent = m;
        toastEl.classList.add('show');
        clearTimeout(toastT);
        toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
    }
    function human(n) {
        if (n == null || isNaN(n)) return '';
        const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
        while (n >= 1024 && i < 4) { n /= 1024; i++; }
        return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
    }
    function relTime(ts) {
        const s = Math.floor((Date.now() - ts) / 1000);
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
        const hh = Math.floor(m / 60); if (hh < 24) return hh + 'h ago';
        return Math.floor(hh / 24) + 'd ago';
    }
    function hue(str) { let n = 0; for (let i = 0; i < (str || '').length; i++) n = (n * 31 + str.charCodeAt(i)) >>> 0; return n % 360; }
    function badges(it) {
        const b = [h('span', { class: 'badge ' + (it.blob ? 'blob' : it.kind), text: it.ext || it.kind })];
        if (it.kind === 'stream') b.push(h('span', { class: 'badge stream', text: 'stream' }));
        if (it.segments > 1) b.push(h('span', { class: 'badge seg', text: it.segments + ' seg' }));
        if (it.frame) b.push(h('span', { class: 'badge frame', text: 'frame' }));
        const sz = it.size || it.segBytes;
        if (sz) b.push(h('span', { class: 'size', text: human(sz) + (it.segBytes && !it.size ? '+' : '') }));
        if (it.host) b.push(h('span', { text: it.host }));
        if (it.ts) b.push(h('span', { text: relTime(it.ts) }));
        return b;
    }
    function ab(label, icon, cls, fn) {
        return h('button', { class: 'ab' + (cls ? ' ' + cls : ''), onclick: e => { e.preventDefault(); fn(); } }, ico(icon, 12), h('span', { text: label }));
    }
    function btn(label, icon, cls, fn) {
        return h('button', { class: 'btn' + (cls ? ' ' + cls : ''), onclick: e => { e.preventDefault(); fn(e); } }, icon ? ico(icon, 14) : null, label);
    }

    /* ================================================================== *
     *  On-video buttons
     * ================================================================== */
    const vbtns = new Map();
    function ensureButton(video) {
        if (vbtns.has(video)) return;
        ensureRoot();
        const b = h('button', { class: 'vbtn', title: 'Media Vault',
            onclick: e => { e.preventDefault(); e.stopPropagation(); openPanel(video); } }, ico('play', 24, true));
        b.style.display = 'none';
        ui.appendChild(b);
        vbtns.set(video, b);
        positionButton(video, b);
    }
    function pruneButtons() {
        vbtns.forEach((b, v) => { if (!v.isConnected || !S.buttonOn) { b.remove(); vbtns.delete(v); } });
    }
    function videoPassesFloor(video) {
        if (!S.minSniffBytes) return true;
        const srcs = collectSources(video);
        if (!srcs.length) return true;
        for (const u of srcs) { const it = byUrl.get(u); if (!it || passesMinSize(it)) return true; }
        return false;
    }
    function positionButton(video, b) {
        const size = Math.round((+S.buttonSize || 44) * uiZ);
        let r;
        try { r = video.getBoundingClientRect(); } catch (e) { b.style.display = 'none'; return; }
        const minPx = (+S.minVideoPx || 0);
        const vis = S.buttonOn && r.width >= minPx && r.height >= 60 && r.bottom > 0 && r.top < innerHeight &&
            r.right > 0 && r.left < innerWidth && !panelEl && !sheetOpen && videoPassesFloor(video);
        if (!vis) { b.style.display = 'none'; return; }
        b.style.display = 'flex';
        b.style.width = b.style.height = size + 'px';
        b.style.opacity = String(Math.max(0.3, Math.min(1, +S.buttonOpacity || 0.92)));
        const pad = 6 * uiZ, c = S.buttonCorner || 'tr';
        b.style.top = Math.max(0, c[0] === 't' ? r.top + pad : r.bottom - size - pad) + 'px';
        b.style.left = Math.max(0, c[1] === 'l' ? r.left + pad : r.right - size - pad) + 'px';
    }
    function repositionAll() { vbtns.forEach((b, v) => positionButton(v, b)); }

    /* ================================================================== *
     *  Corner launcher (draggable; tap = list, long-press = Setup)
     * ================================================================== */
    let fab = null, fabCnt = null;
    function placeFab(x, y) {
        const w = 48 * uiZ;
        const nx = Math.min(Math.max(0, x), innerWidth - w), ny = Math.min(Math.max(0, y), innerHeight - w);
        fab.style.left = nx + 'px'; fab.style.top = ny + 'px';
        return [nx, ny];
    }
    function restoreFab() {
        const p = gv('fabPos', null);
        const w = 48 * uiZ;
        if (p && typeof p.x === 'number') placeFab(p.x * innerWidth, p.y * innerHeight);
        else placeFab(innerWidth - w - 12 * uiZ, innerHeight - w - 110 * uiZ);
    }
    function updateFab() {
        if (!IS_TOP) return;
        if (!S.showFab) { if (fab) { fab.remove(); fab = null; } return; }
        if (!document.body) return;
        if (!fab) {
            ensureRoot();
            fabCnt = h('span', { class: 'cnt' });
            fab = h('button', { class: 'fab', title: 'Media Vault — tap: list · long-press: Setup' }, ico('clap', 22), fabCnt);
            let moved = false, longP = false, lpT = 0, sx = 0, sy = 0, ox = 0, oy = 0, down = false;
            const start = (x, y) => {
                down = true; moved = false; longP = false; sx = x; sy = y;
                const r = fab.getBoundingClientRect(); ox = r.left; oy = r.top;
                clearTimeout(lpT);
                lpT = setTimeout(() => { if (!moved) { longP = true; openSheet('settings'); } }, 550);
            };
            const move = (x, y) => {
                if (!down) return;
                if (Math.abs(x - sx) + Math.abs(y - sy) > 8) { moved = true; clearTimeout(lpT); }
                if (moved) placeFab(ox + x - sx, oy + y - sy);
            };
            const end = () => {
                if (!down) return;
                down = false; clearTimeout(lpT);
                if (moved) { const r = fab.getBoundingClientRect(); sv('fabPos', { x: r.left / innerWidth, y: r.top / innerHeight }); }
            };
            fab.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
            fab.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
            fab.addEventListener('touchend', end);
            fab.addEventListener('touchcancel', end);
            fab.addEventListener('mousedown', e => { if (e.button === 0) start(e.clientX, e.clientY); });
            window.addEventListener('mousemove', e => move(e.clientX, e.clientY), true);
            window.addEventListener('mouseup', end, true);
            fab.addEventListener('contextmenu', e => e.preventDefault());
            fab.addEventListener('click', e => { e.preventDefault(); if (!moved && !longP) openSheet('tab'); });
            ui.appendChild(fab);
            restoreFab();
        }
        const n = visibleItems().length;
        fabCnt.textContent = n > 999 ? '999+' : String(n);
        fabCnt.style.display = n ? 'flex' : 'none';
    }

    /* ================================================================== *
     *  Bottom sheet: This page · Setup · Diagnostics
     * ================================================================== */
    const F = Object.assign({ query: '', type: 'all', ext: 'all', minSize: 0 }, gv('filter', {}));
    const selected = new Set();
    let sheetWrap = null, sheetEl = null, sheetOpen = false, section = 'tab';
    const SH = {};
    function saveFilter() { sv('filter', { query: F.query, type: F.type, ext: F.ext, minSize: F.minSize }); }
    function matches(it) {
        if (F.type !== 'all' && it.kind !== F.type) return false;
        if (F.ext !== 'all' && it.ext !== F.ext) return false;
        if (F.minSize && !((it.size || it.segBytes || 0) >= F.minSize)) return false;
        if (F.query) {
            const q = F.query.toLowerCase();
            if (!(it.name || '').toLowerCase().includes(q) && !(it.url || '').toLowerCase().includes(q)) return false;
        }
        return true;
    }
    function sel(cls, options, value, onchange) {
        const s = h('select', { class: cls || '' }, options.map(([v, l]) => h('option', { value: String(v), text: l })));
        s.value = String(value);
        if (onchange) s.addEventListener('change', onchange);
        return s;
    }
    function buildSheet() {
        ensureRoot();
        sheetWrap = h('div', { class: 'sheet-wrap', onclick: closeSheet });
        SH.count = h('em');
        const navBtn = (secName, icon, label, extra) => h('button', { 'data-sec': secName, onclick: () => { section = secName; selected.clear(); renderSheet(); SH.main.scrollTop = 0; } },
            ico(icon, 18), h('span', { class: 'nl' }, label, extra || null));
        SH.nav = h('nav', null, navBtn('tab', 'film', 'This page', SH.count), navBtn('settings', 'sliders', 'Setup'), navBtn('diag', 'activity', 'Diagnostics'));
        SH.search = h('input', { class: 'search', type: 'search', placeholder: 'Search name or URL…', value: F.query || '' });
        SH.search.addEventListener('input', () => { F.query = SH.search.value.trim(); saveFilter(); renderList(); });
        SH.ftype = sel('', [['all', 'All types'], ['video', 'Video'], ['audio', 'Audio'], ['stream', 'Streams']], F.type,
            () => { F.type = SH.ftype.value; saveFilter(); renderList(); });
        SH.fext = sel('', [['all', 'All formats']], 'all', () => { F.ext = SH.fext.value; saveFilter(); renderList(); });
        SH.fsize = sel('', [[0, 'Any size'], [1048576, '> 1 MB'], [5242880, '> 5 MB'], [20971520, '> 20 MB'], [104857600, '> 100 MB']], F.minSize || 0,
            () => { F.minSize = +SH.fsize.value; saveFilter(); renderList(); });
        SH.filters = h('div', { class: 'filters' }, h('div', { class: 'searchwrap' }, ico('search', 16), SH.search),
            h('div', { class: 'selects' }, SH.ftype, SH.fext, SH.fsize));
        SH.secTab = h('section', { class: 'sec' });
        SH.secSettings = h('section', { class: 'sec hidden' });
        SH.secDiag = h('section', { class: 'sec hidden' });
        SH.main = h('div', { class: 'main' }, SH.secTab, SH.secSettings, SH.secDiag);
        SH.selcount = h('b', { text: '0' });
        SH.footer = h('footer', { class: 'hidden' },
            h('div', { class: 'selinfo' }, ico('check', 14), SH.selcount, ' selected', h('span', { class: 'sp' }),
                h('button', { class: 'lnk', text: 'All', onclick: () => { visibleItems().filter(matches).forEach(i => selected.add(i.id)); renderList(true); } }),
                h('button', { class: 'lnk', text: 'None', onclick: () => { selected.clear(); renderList(true); } })),
            h('div', { class: 'btns' },
                SH.bulkDl = btn('Download', 'download', 'g', () => bulk('download')),
                btn('Copy URLs', 'copy', '', () => bulk('copy')),
                btn('Remove', 'trash', 'd', () => bulk('remove'))));
        const grab = h('div', { class: 'grab' }, h('span', { class: 'pill' }));
        sheetEl = h('div', { class: 'sheet', 'data-sec': 'tab' },
            grab,
            h('header', null, h('span', { class: 'logo' }, ico('clap', 18)), h('h1', { text: 'Media Vault' }),
                h('button', { class: 'icon', title: 'On-page player', onclick: () => { closeSheet(); openPanel(null); } }, ico('play', 16)),
                h('button', { class: 'icon', title: 'Refresh', onclick: () => { scan(); renderSheet(); } }, ico('refresh', 16)),
                h('button', { class: 'icon', title: 'Close', onclick: closeSheet }, ico('x', 16))),
            SH.nav, SH.filters, SH.main, SH.footer);
        ui.appendChild(sheetWrap);
        ui.appendChild(sheetEl);
        // drag the grab bar down to dismiss (touch), as in the extension
        let sy = 0, dy = 0, dragging = false, lastY = 0, lastT = 0, vel = 0;
        grab.addEventListener('touchstart', e => {
            dragging = true; sy = lastY = e.touches[0].clientY; dy = 0; vel = 0; lastT = Date.now();
            sheetEl.classList.add('drag');
        }, { passive: true });
        grab.addEventListener('touchmove', e => {
            if (!dragging) return;
            const y = e.touches[0].clientY, t = Date.now();
            if (t > lastT) vel = (y - lastY) / (t - lastT);
            lastY = y; lastT = t;
            dy = Math.max(0, y - sy);
            sheetEl.style.setProperty('--dy', (dy / uiZ) + 'px');
        }, { passive: true });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            sheetEl.classList.remove('drag');
            if (dy > 80 || (dy > 24 && vel > 0.45)) closeSheet();
            else sheetEl.style.setProperty('--dy', '0px');
        };
        grab.addEventListener('touchend', endDrag, { passive: true });
        grab.addEventListener('touchcancel', endDrag, { passive: true });
        grab.addEventListener('click', closeSheet);
    }
    function layoutSheet() {
        if (!sheetEl) return;
        const vw = innerWidth, vh = innerHeight;
        const w = Math.min(vw, 620 * uiZ);
        const hgt = Math.min(vh * 0.88, Math.max(vh * 0.6, 860 * uiZ));
        sheetEl.style.width = (w / uiZ) + 'px';
        sheetEl.style.height = (Math.min(hgt, vh) / uiZ) + 'px';
        sheetEl.style.left = ((vw - w) / 2) + 'px';
        sheetEl.style.borderRadius = w < vw ? '18px 18px 0 0' : '';
    }
    function openSheet(sec) {
        if (!IS_TOP) return;
        if (!document.body && !document.documentElement) return;
        if (!sheetEl) buildSheet();
        closePanel();
        if (sec) section = sec;
        sheetOpen = true;
        layoutSheet();
        sheetEl.style.setProperty('--dy', '0px');
        renderSheet();
        requestAnimationFrame(() => { sheetWrap.classList.add('show'); sheetEl.classList.add('show'); });
        repositionAll();
    }
    function closeSheet() {
        if (!sheetOpen) return;
        sheetOpen = false;
        sheetWrap.classList.remove('show');
        sheetEl.classList.remove('show');
        repositionAll();
    }
    function renderSheet() {
        if (!sheetEl) return;
        sheetEl.setAttribute('data-sec', section);
        SH.nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.getAttribute('data-sec') === section));
        SH.secTab.classList.toggle('hidden', section !== 'tab');
        SH.secSettings.classList.toggle('hidden', section !== 'settings');
        SH.secDiag.classList.toggle('hidden', section !== 'diag');
        SH.filters.classList.toggle('hidden', section !== 'tab');
        if (section === 'settings') renderSettings();
        else if (section === 'diag') renderDiag();
        renderList(true);
    }
    function refreshExtOptions(all) {
        const exts = Array.from(new Set(all.map(i => i.ext).filter(Boolean)));
        if (F.ext !== 'all' && !exts.includes(F.ext)) exts.push(F.ext);
        exts.sort();
        const want = ['all'].concat(exts).join('|');
        if (SH.fext.__opts !== want) {
            SH.fext.textContent = '';
            SH.fext.appendChild(h('option', { value: 'all', text: 'All formats' }));
            exts.forEach(e => SH.fext.appendChild(h('option', { value: e, text: e.toUpperCase() })));
            SH.fext.__opts = want;
        }
        SH.fext.value = F.ext;
    }
    function emptyState(icon, ...parts) {
        return h('div', { class: 'empty' }, h('div', { class: 'eico' }, ico(icon, 26)), parts);
    }
    function setKids(el, kids) {
        el.textContent = '';
        kids.forEach(k => el.appendChild(k));
    }
    let listKey = '';
    const rowRefs = new Map();
    /* Rebuild only when the set / order of rows changes; otherwise patch the
     * meta line in place (segment floods would otherwise recreate the buttons
     * under the user's finger several times a second). */
    function renderList(force) {
        if (!sheetEl) return;
        const all = visibleItems();
        SH.count.textContent = all.length ? String(all.length) : '';
        // drop selections that no longer exist
        const ids = new Set(all.map(i => i.id));
        selected.forEach(id => { if (!ids.has(id)) selected.delete(id); });
        renderActions();
        if (section !== 'tab') return;
        refreshExtOptions(all);
        const box = SH.secTab;
        const shown = all.filter(matches);
        const key = (shown.length ? shown.map(i => i.id).join(',') : 'empty' + all.length) + '|' + dlLabel();
        if (!force && key === listKey && box.firstChild) {
            shown.forEach(it => {
                const r = rowRefs.get(it.id);
                if (r) { setKids(r.meta, badges(it)); r.t.textContent = it.name || it.url; }
            });
            return;
        }
        listKey = key;
        rowRefs.clear();
        box.textContent = '';
        if (!shown.length) {
            box.appendChild(all.length
                ? emptyState('search', 'Nothing matches the filter (' + all.length + ' hidden).')
                : emptyState('film', 'No media detected on this page yet.', h('br'), 'Open the video and ', h('b', { text: 'play it' }), ' for a moment.'));
            return;
        }
        shown.forEach(it => box.appendChild(mediaRow(it)));
    }
    function mediaRow(it) {
        const isSel = selected.has(it.id);
        const row = h('div', { class: 'row' + (isSel ? ' sel' : '') });
        const cb = h('input', { type: 'checkbox' });
        cb.checked = isSel;
        cb.addEventListener('change', () => {
            if (cb.checked) selected.add(it.id); else selected.delete(it.id);
            row.classList.toggle('sel', cb.checked);
            renderActions();
        });
        const hh = hue(it.host || it.url);
        const av = h('div', { class: 'av' }, ico(it.kind === 'audio' ? 'music' : (it.kind === 'stream' ? 'layers' : 'film'), 14));
        av.style.background = 'linear-gradient(135deg,hsl(' + hh + ' 62% 46%),hsl(' + ((hh + 28) % 360) + ' 62% 36%))';
        const acts = h('div', { class: 'acts' });
        if (!it.blob) {
            acts.appendChild(ab(dlLabel(), 'download', 'g', () => downloadOne(it)));
            acts.appendChild(ab('Copy', 'copy', '', () => copyText(it.url, 'Link copied')));
            acts.appendChild(ab('Open', 'external', '', () => openTab(it.url)));
        } else {
            acts.appendChild(ab('Copy', 'copy', '', () => copyText(it.url, 'blob: URL copied (only works on its page)')));
        }
        if (!it.segKey || it.segments < 3) acts.appendChild(ab('Play', 'play', 'p', () => { closeSheet(); openPanel(null, it); }));
        const t = h('div', { class: 't', text: it.name || it.url, title: it.url });
        const meta = h('div', { class: 'meta' }, badges(it));
        rowRefs.set(it.id, { t, meta });
        row.appendChild(cb); row.appendChild(av); row.appendChild(h('div', { class: 'body' }, t, meta, acts));
        return row;
    }
    function renderActions() {
        const n = selected.size;
        SH.footer.classList.toggle('hidden', n === 0 || section !== 'tab');
        SH.selcount.textContent = String(n);
        const lab = SH.bulkDl.lastChild;
        if (lab) lab.textContent = dlLabel();
    }
    function bulk(act) {
        const list = items.filter(i => selected.has(i.id));
        if (!list.length) return;
        if (act === 'download') downloadMany(list);
        else if (act === 'copy') copyText(list.filter(i => !i.blob).map(i => i.url).join('\n'), list.length + ' URLs copied');
        else if (act === 'remove') { removeItems(list); toast('Cleared from list'); }
        selected.clear();
        renderList(true);
    }

    /* ------------------------------- Setup ------------------------------- */
    const CTL = {};
    function tabhead(icon, title) { return h('div', { class: 'tabhead' }, ico(icon, 13), h('span', { class: 'tt', text: title }), h('span', { class: 'rule' })); }
    function lab(label, hint) { return h('label', null, label, hint ? h('span', { class: 'h', text: hint }) : null); }
    function fCheck(id, label, hint, val) {
        const c = CTL[id] = h('input', { type: 'checkbox' }); c.checked = !!val;
        const l = lab(label, hint); l.addEventListener('click', () => c.click());
        return h('div', { class: 'field inline' }, l, c);
    }
    function fNum(id, label, hint, val, min, max, step) {
        const c = CTL[id] = h('input', { type: 'number', min: String(min), max: String(max), step: String(step || 1), value: String(val) });
        return h('div', { class: 'field inline' }, lab(label, hint), c);
    }
    function fSel(id, label, hint, opts, val, block) {
        const c = CTL[id] = sel('', opts, val);
        return h('div', { class: 'field' + (block ? '' : ' inline') }, lab(label, hint), c);
    }
    function fText(id, label, hint, val, ph) {
        const c = CTL[id] = h('input', { type: 'text', value: val || '', placeholder: ph || '', autocomplete: 'off', spellcheck: 'false' });
        return h('div', { class: 'field' }, lab(label, hint), c);
    }
    function renderSettings() {
        const s = S, box = SH.secSettings;
        box.textContent = '';
        const preset = Object.keys(PLAYERS).find(k => PLAYERS[k][1] === (s.playerPackage || ''));
        const dlpkgRow = fText('dlpkg', 'Custom download app package', 'e.g. com.example.downloader', s.downloadPackage, 'com.example.downloader');
        const playerRow = fText('player', 'Custom player package', 'e.g. com.mxtech.videoplayer.ad', preset ? '' : s.playerPackage, 'com.example.player');
        const tagRow = fText('gmtag', 'Download subfolder (XBrowser tag)', 'XBrowser’s GM_download saves into this subfolder. Blank = default folder.', s.gmTag, 'e.g. Videos');
        const andHint = intentsOn() ? '' : ' (Android only — this browser uses the browser downloader unless app actions are forced on below)';
        box.append(
            tabhead('film', 'ON-VIDEO BUTTON'),
            fCheck('btn', 'Show over videos', '', s.buttonOn),
            fNum('size', 'Size (px)', '', s.buttonSize, 28, 80),
            fSel('corner', 'Corner', '', [['tl', 'Top-left'], ['tr', 'Top-right'], ['bl', 'Bottom-left'], ['br', 'Bottom-right']], s.buttonCorner),
            fNum('minpx', 'Min video size (px)', 'Skip tiny thumbnail videos', s.minVideoPx, 0, 1000),
            fNum('opacity', 'Opacity (%)', '', Math.round((+s.buttonOpacity || 0.92) * 100), 30, 100, 5),

            tabhead('clap', 'CORNER LAUNCHER'),
            fCheck('fab', 'Show the launcher with count', 'Drag to move · tap = list · long-press = Setup', s.showFab),
            h('div', { class: 'field' }, btn('Reset launcher position', 'refresh', 'w', () => { dv('fabPos'); if (fab) restoreFab(); toast('Launcher moved back'); })),

            tabhead('search', 'DETECTION'),
            fNum('minb', 'Ignore media smaller than (MB)', 'Hides smaller files everywhere (streams/blob exempt); 0 keeps all',
                ((s.minSniffBytes || 0) / 1048576).toFixed(1).replace(/\.0$/, ''), 0, 100000, 0.5),
            fCheck('collapse', 'Fold stream segments', 'Collapse repeated .ts/.m4s/.aac and numbered fMP4 segment URLs into one entry', s.collapseSegments),
            fNum('max', 'Max entries per page', '', s.maxPerTab, 50, 2000),
            fCheck('net', 'Read fetch / XHR responses', 'Content-Type / Length / Range of the page’s own requests (reload to apply)', s.captureNetwork),
            fCheck('perf', 'Performance timeline', 'Media requests the page’s JS didn’t make (reload to apply)', s.perfObserver),
            fCheck('frames', 'Look inside iframes', 'Frames report to this page; they draw no UI (reload to apply)', s.scanFrames),
            fCheck('probe', 'Look up unknown sizes', 'HEAD request (1-byte range fallback) for items without a size', s.fetchSizes),

            tabhead('download', 'DOWNLOADS'),
            fSel('dlm', 'Download with', 'Browser = the userscript manager’s downloader (Referer sent), then a direct blob save. Apps get the direct link via an Android intent; it’s also copied to the clipboard as a backup.' + andHint,
                [['browser', 'Browser downloader'], ['1dmplus', '1DM+'], ['1dm', '1DM'], ['1dmlite', '1DM Lite'], ['adm', 'ADM'], ['admpro', 'ADM Pro'],
                 ['chooser', 'App chooser (Open with…)'], ['custom', 'Custom package…']], DL_APPS[s.downloadMethod] ? s.downloadMethod : 'browser', true),
            dlpkgRow,
            fCheck('dlcopy', 'Copy link when sending to an app', 'Backup if the app doesn’t open: paste it, or let 1DM / ADM auto-detect it', s.copyOnSend !== false),
            fSel('engine', 'Browser downloader engine', 'Auto: GM_download (+Referer) → blob save → open link. Blob: fetch then save (best on Via). Link: plain link / new tab.',
                [['auto', 'Auto'], ['blob', 'Blob save'], ['link', 'Plain link']], s.browserEngine, true),
            tagRow,

            tabhead('external', 'EXTERNAL PLAYER'),
            fSel('playerpre', 'Open in player with', '', [['', 'System chooser'], ['vlc', 'VLC'], ['mx', 'MX Player'], ['mxpro', 'MX Player Pro'],
                ['just', 'Just Player'], ['mpv', 'mpv'], ['custom', 'Custom package…']], !s.playerPackage ? '' : (preset || 'custom')),
            playerRow,
            fSel('intents', 'Android app actions', 'Intent-based actions (apps, external player). Auto = only on Android.',
                [['auto', 'Auto'], ['on', 'Always on'], ['off', 'Off']], s.intents),

            tabhead('play', 'QUICK ACCESS'),
            fSel('gesture', 'Open gesture', 'Avoid gestures your phone grabs (3-finger-down is often screenshot)',
                [['off', 'Off'], ['tap3', '3-finger tap'], ['tap4', '4-finger tap'], ['swipe3up', '3-finger swipe up'], ['swipe3down', '3-finger swipe down']], s.gesture),
            fSel('gtarget', 'Gesture opens', '', [['sheet', 'Bottom sheet'], ['panel', 'Media panel (player)']], s.gestureTarget),
            fSel('uiscale', 'Interface size', 'Auto enlarges the UI on desktop-width pages on phones',
                [[0, 'Auto'], [1, '100%'], [1.25, '125%'], [1.5, '150%'], [2, '200%']], s.uiScale || 0),

            h('div', { class: 'field', style: { marginTop: '18px' } }, btn('Save settings', 'save', 'p w', saveFromForm)),
            h('div', { class: 'field' }, btn('Reset to defaults', 'refresh', 'w', () => {
                if (!confirm('Reset all Media Vault settings?')) return;
                setSettings(Object.assign({}, DEFAULTS)); renderSettings(); toast('Settings reset');
            })),
            h('div', { class: 'field' }, btn('Clear all detected media', 'trash', 'd w', () => { clearItems(); toast('Cleared'); }))
        );
        const sync = () => {
            dlpkgRow.style.display = CTL.dlm.value === 'custom' ? '' : 'none';
            playerRow.style.display = CTL.playerpre.value === 'custom' ? '' : 'none';
            tagRow.style.display = (CTL.dlm.value === 'browser' && CTL.engine.value === 'auto' && (IS_XBROWSER || s.gmTag)) ? '' : 'none';
        };
        CTL.dlm.addEventListener('change', sync); CTL.playerpre.addEventListener('change', sync); CTL.engine.addEventListener('change', sync);
        sync();
    }
    function clampN(v, lo, hi, def) { v = parseFloat(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def; }
    function saveFromForm() {
        const p = CTL.playerpre.value;
        setSettings(Object.assign({}, S, {
            buttonOn: CTL.btn.checked,
            buttonSize: clampN(CTL.size.value, 28, 80, 44),
            buttonCorner: CTL.corner.value,
            minVideoPx: clampN(CTL.minpx.value, 0, 1000, 120),
            buttonOpacity: clampN(CTL.opacity.value, 30, 100, 92) / 100,
            showFab: CTL.fab.checked,
            minSniffBytes: Math.round(Math.max(0, +CTL.minb.value || 0) * 1048576),
            collapseSegments: CTL.collapse.checked,
            maxPerTab: clampN(CTL.max.value, 50, 2000, 300),
            captureNetwork: CTL.net.checked, perfObserver: CTL.perf.checked, scanFrames: CTL.frames.checked, fetchSizes: CTL.probe.checked,
            downloadMethod: CTL.dlm.value, downloadPackage: CTL.dlpkg.value.trim(), copyOnSend: CTL.dlcopy.checked,
            browserEngine: CTL.engine.value, gmTag: CTL.gmtag.value.trim(),
            playerPackage: p === 'custom' ? CTL.player.value.trim() : (PLAYERS[p] ? PLAYERS[p][1] : ''),
            intents: CTL.intents.value,
            gesture: CTL.gesture.value, gestureTarget: CTL.gtarget.value,
            uiScale: +CTL.uiscale.value || 0
        }));
        toast('Settings saved');
    }
    function setSettings(next) {
        S = Object.assign({}, DEFAULTS, next);
        sv('settings', S);
        applySettings();
    }
    function applySettings() {
        if (!IS_TOP) return;
        applyZ();
        if (fab) restoreFab();
        pruneButtons();
        scan();
        repositionAll();
        updateFab();
        if (sheetOpen) renderList();
        buildMenu();
    }

    /* ---------------------------- Diagnostics ---------------------------- */
    function diagText() {
        const api = Object.keys(A).map(k => k + (A[k] ? '✓' : '✗')).join(' ');
        const vis = visibleItems();
        return [
            'Media Vault (userscript) ' + VERSION,
            'manager: ' + (HANDLER || 'unknown (GM_info not exposed)'),
            'userAgent: ' + UA.slice(0, 170),
            'android: ' + IS_ANDROID + ' · xbrowser: ' + IS_XBROWSER + ' · app actions: ' + (intentsOn() ? 'on' : 'off') + ' (' + S.intents + ')',
            'GM APIs: ' + api,
            'unsafeWindow: ' + (typeof unsafeWindow !== 'undefined' ? (unsafeWindow === window ? 'same object as window' : 'separate (sandboxed)') : 'missing'),
            'network hooks: ' + hookMode,
            'performance observer: ' + perfMode,
            'ui scale: ' + uiZ + ' (viewport ' + innerWidth + '×' + innerHeight + ', screen ' + (screen.width || '?') + ')',
            'items: ' + items.length + ' stored · ' + vis.length + ' pass the size floor · cap ' + S.maxPerTab,
            'by source: net ' + stats.net + ' · perf ' + stats.perf + ' · dom ' + stats.dom + ' · frames ' + stats.frame,
            'segment groups: ' + Array.from(segs.values()).filter(s => byUrl.get(s.url) === s).map(s => s.segments + '×' + s.host).join(', '),
            'frame reports: postMessage ' + stats.viaPost + ' · GM storage ' + stats.viaStore + ' · frames ' + framesSeen.size,
            'size probes: ' + stats.probes + ' sent · ' + stats.probeOk + ' sized · queue ' + probeQ.length,
            'download: ' + methodLabel(S.downloadMethod) + ' · engine ' + S.browserEngine + ' · last ' + lastDl,
            'last intent: ' + (lastIntent || '-'),
            'page: ' + location.href.slice(0, 200),
            'settings: ' + JSON.stringify(S)
        ].join('\n');
    }
    function renderDiag() {
        const box = SH.secDiag;
        box.textContent = '';
        const out = h('pre', { class: 'diag', text: diagText() });
        box.append(
            tabhead('activity', 'DIAGNOSTICS'),
            h('div', { class: 'brow' },
                btn('Refresh', 'refresh', '', () => { out.textContent = diagText(); }),
                btn('Copy', 'copy', '', () => copyText(diagText(), 'Diagnostics copied')),
                btn('Debug console', 'bug', '', toggleConsole)),
            intentsOn() ? h('div', { class: 'brow', style: { marginTop: '6px' } }, btn('Test “Open in player” variants', 'external', 'w', openPlayerDiag)) : null,
            out);
    }
    function openPlayerDiag() {
        const vids = items.filter(m => !m.blob && m.kind !== 'stream' && !m.segKey);
        const it = (lastPlayItem && !lastPlayItem.blob) ? lastPlayItem : (vids[vids.length - 1] || items[items.length - 1]);
        if (!it) { toast('No testable media yet — play a direct video first'); return; }
        const pkg = S.playerPackage;
        const pl = pkg || 'chooser';
        const broad = it.kind === 'audio' ? 'audio/*' : 'video/*';
        const exact = it.mime || ({ mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4' })[it.ext] || broad;
        const variants = [
            ['1 · ' + pl + ' · ' + broad, () => buildIntent(it.url, pkg, it.kind, it.name)],
            ['2 · ' + pl + ' · intent:// form', () => buildIntent(it.url, pkg, it.kind, it.name, { formB: true })],
            ['3 · System chooser · ' + broad, () => buildIntent(it.url, '', it.kind, it.name)],
            ['4 · ' + pl + ' · exact MIME', () => buildIntent(it.url, pkg, it.kind, it.name, { type: exact })],
            ['5 · ' + pl + ' · no type', () => buildIntent(it.url, pkg, it.kind, it.name, { type: '' })]
        ];
        openModal('Open-in-player test', [
            h('div', { class: 'h' }, 'Target: ', h('b', { text: it.name }), h('br'), 'Tap each until your player opens; “intent:// form” can then be made the default in Diagnostics.'),
            variants.map(([l, mk]) => btn(l, 'external', '', () => fireIntent(mk(), l))),
            btn('Use intent:// form by default: ' + (S.intentFormB ? 'on' : 'off'), 'sliders', '', () => { setSettings(Object.assign({}, S, { intentFormB: !S.intentFormB })); closeModal(); toast('intent:// form ' + (S.intentFormB ? 'on' : 'off')); }),
            btn('Copy all intent strings', 'copy', '', () => copyText(variants.map(([l, mk]) => l + '\n' + mk()).join('\n\n'), 'Intent strings copied')),
            btn('Close', 'x', '', closeModal)
        ]);
    }
    let modalEl = null;
    function openModal(title, kids) {
        ensureRoot();
        closeModal();
        modalEl = h('div', { class: 'modal', onclick: e => { if (e.target === modalEl) closeModal(); } },
            h('div', { class: 'mp' }, h('h3', { text: title }), h('div', { class: 'mb' }, kids)));
        ui.appendChild(modalEl);
    }
    function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }

    /* ================================================================== *
     *  On-page panel with preview player (content.js overlay port)
     * ================================================================== */
    let panelEl = null, panelList = null, panelPlayer = null, panelSel = '', panelSig = '';
    const panelRefs = new Map();
    function openPanel(video, item) {
        if (!IS_TOP) return;
        ensureRoot();
        closePanel();
        if (sheetOpen) closeSheet();
        if (video && !video.paused) { try { video.pause(); } catch (e) {} }
        let pre = item || null;
        if (!pre && video) {
            const srcs = collectSources(video);
            srcs.forEach(u => reportDom(u, 'video'));
            for (const u of srcs) { if (byUrl.get(u)) { pre = byUrl.get(u); break; } }
        }
        panelPlayer = h('div', { class: 'player' }, h('div', { class: 'noprev', text: 'Tap an item below to preview it here.' }));
        panelList = h('div', { class: 'pbody' });
        panelEl = h('div', { class: 'ov', onclick: e => { if (e.target === panelEl) closePanel(); } },
            h('div', { class: 'panel' },
                h('div', { class: 'phead' }, ico('clap', 18), h('span', { class: 'pt', text: 'Media on this page' }),
                    h('button', { class: 'icon', title: 'Full list', onclick: () => { closePanel(); openSheet('tab'); } }, ico('list', 16)),
                    h('button', { class: 'icon', title: 'Close', onclick: closePanel }, ico('x', 16))),
                panelPlayer, panelList));
        ui.appendChild(panelEl);
        panelSel = '';
        panelSig = '';
        renderPanelList();
        if (pre) playInPanel(pre);
        repositionAll();
    }
    function panelItems() {
        const vis = visibleItems();
        const usable = vis.filter(x => !x.segKey || x.segments < 3);
        return usable.length ? usable : vis;
    }
    function renderPanelList() {
        if (!panelEl) return;
        const list = panelItems();
        const sig = list.map(i => i.id).join(',') + '|' + panelSel + '|' + dlLabel();
        if (sig === panelSig) {
            list.forEach(it => { const m = panelRefs.get(it.id); if (m) setKids(m, badges(it)); });
            return;
        }
        panelSig = sig;
        panelRefs.clear();
        const st = panelList.scrollTop;
        panelList.textContent = '';
        if (!list.length) {
            panelList.appendChild(h('div', { class: 'empty' }, 'Nothing detected yet.', h('br'), 'Play the video for a moment, then reopen.'));
            return;
        }
        list.forEach(it => {
            const acts = h('div', { class: 'acts' }, ab('Preview', 'play', 'p', () => playInPanel(it)));
            if (!it.blob) {
                acts.appendChild(ab(dlLabel(), 'download', 'g', () => downloadOne(it)));
                acts.appendChild(intentsOn() ? ab('Player', 'external', '', () => openInPlayer(it)) : ab('Open', 'external', '', () => openTab(it.url)));
            }
            acts.appendChild(ab('Copy', 'copy', '', () => copyText(it.url, it.blob ? 'blob: URL copied (only works on its page)' : 'Link copied')));
            const meta = h('div', { class: 'meta' }, badges(it));
            panelRefs.set(it.id, meta);
            panelList.appendChild(h('div', { class: 'pitem' + (it.id === panelSel ? ' on' : '') },
                h('div', { class: 't', text: it.name || it.url, title: it.url }), meta, acts));
        });
        panelList.scrollTop = st;
    }
    function stopPanelMedia() {
        if (!panelPlayer) return;
        const m = panelPlayer.querySelector('video, audio');
        if (m) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {} }
    }
    function playInPanel(it) {
        if (!panelEl) return;
        panelSel = it.id;
        lastPlayItem = it;
        renderPanelList();
        requestAnimationFrame(centerPanelSel);
        stopPanelMedia();
        panelPlayer.textContent = '';
        if (it.kind === 'stream' && !it.blob) {
            panelPlayer.appendChild(h('div', { class: 'noprev' }, 'Streaming playlist (' + (it.ext || '').toUpperCase() + ') — no in-page preview.', h('br'), 'Use Download or Player.'));
            return;
        }
        const m = h(it.kind === 'audio' ? 'audio' : 'video', { controls: true, autoplay: true, playsInline: true });
        m.addEventListener('error', () => {
            panelPlayer.textContent = '';
            panelPlayer.appendChild(h('div', { class: 'noprev' }, 'Preview failed to load' + (it.blob ? ' (MSE blob streams play only in their own player)' : '') + '.', h('br'), 'Try Download or Player.'));
        });
        m.addEventListener('loadedmetadata', centerPanelSel);
        m.src = it.url;
        panelPlayer.appendChild(m);
    }
    function centerPanelSel() {
        try {
            const on = panelList && panelList.querySelector('.pitem.on');
            if (on) panelList.scrollTop = Math.max(0, on.offsetTop - panelList.offsetTop - (panelList.clientHeight - on.offsetHeight) / 2);
        } catch (e) {}
    }
    function closePanel() {
        if (!panelEl) return;
        stopPanelMedia();
        panelEl.remove();
        panelEl = null;
        repositionAll();
    }

    /* ================================================================== *
     *  UI refresh (debounced)
     * ================================================================== */
    let chT = 0;
    function changed() {
        if (!IS_TOP || chT) return;
        chT = setTimeout(() => {
            chT = 0;
            updateFab();
            if (sheetOpen && section === 'tab') renderList();
            else if (sheetOpen) { SH.count.textContent = String(visibleItems().length || ''); }
            if (panelEl) renderPanelList();
            repositionAll();
        }, 200);
    }

    /* ================================================================== *
     *  Open gesture (content.js port); child frames forward it to the top
     * ================================================================== */
    function fireGesture() {
        if (!IS_TOP) { try { window.top.postMessage({ __mv: NS, v: 1, type: 'gesture' }, '*'); } catch (e) {} return; }
        if (sheetOpen || panelEl) return;
        if (S.gestureTarget === 'panel') openPanel(null);
        else openSheet('tab');
    }
    function armGesture() {
        const need = () => { const g = S.gesture || 'off'; return g === 'tap4' ? 4 : (g === 'off' ? 0 : 3); };
        let tracking = false, fired = false, sx = 0, sy = 0, st = 0, moved = 0, seen = 0;
        const centroid = ts => { let x = 0, y = 0; for (const t of ts) { x += t.clientX; y += t.clientY; } return { x: x / ts.length, y: y / ts.length }; };
        const o = { passive: true, capture: true };
        window.addEventListener('touchstart', e => {
            const n = need(); if (!n || sheetOpen) return;
            seen = Math.max(seen, e.touches.length);
            if (e.touches.length === n && !tracking) {
                tracking = true; fired = false; moved = 0;
                const c = centroid(e.touches); sx = c.x; sy = c.y; st = Date.now();
            }
        }, o);
        window.addEventListener('touchmove', e => {
            if (!tracking || fired) return;
            const g = S.gesture, n = need();
            if (e.touches.length !== n) return;
            const c = centroid(e.touches);
            const dx = c.x - sx, dy = c.y - sy;
            moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
            if (g === 'swipe3up' && dy < -90 && Math.abs(dx) < 130) { fired = true; tracking = false; fireGesture(); }
            else if (g === 'swipe3down' && dy > 90 && Math.abs(dx) < 130) { fired = true; tracking = false; fireGesture(); }
        }, o);
        window.addEventListener('touchend', e => {
            if (e.touches.length > 0) return;
            const g = S.gesture;
            if (tracking && !fired && (g === 'tap3' || g === 'tap4') && seen === need() && Date.now() - st < 450 && moved < 40) fireGesture();
            tracking = false; fired = false; seen = 0;
        }, o);
        window.addEventListener('touchcancel', () => { tracking = false; fired = false; seen = 0; }, o);
    }

    /* ================================================================== *
     *  Menu commands (+ XBrowser native-menu toggles, re-registered with
     *  updated labels when GM_unregisterMenuCommand exists)
     * ================================================================== */
    const menuIds = [];
    let menuBuilt = false;
    function reg(label, fn) {
        if (!A.menu) return;
        try { const id = A.menu(label, fn); if (id != null) menuIds.push(id); } catch (e) {}
    }
    function buildMenu() {
        if (!IS_TOP || !A.menu) return;
        if (menuBuilt) {
            if (!A.unmenu) return;                // can't relabel → avoid duplicates
            menuIds.splice(0).forEach(id => { try { A.unmenu(id); } catch (e) {} });
        }
        menuBuilt = true;
        const tick = v => (v ? '☑️ ' : '⬜ ');
        reg('🎬 Media list', () => openSheet('tab'));
        reg('⚙️ Setup', () => openSheet('settings'));
        reg('🩺 Diagnostics', () => openSheet('diag'));
        reg('🐞 Debug console', toggleConsole);
        reg('⬇️ Download with: ' + methodLabel(S.downloadMethod), cycleDownload);
        reg(tick(S.buttonOn) + 'On-video button', () => toggleSetting('buttonOn', 'On-video button'));
        reg(tick(S.showFab) + 'Corner launcher', () => toggleSetting('showFab', 'Corner launcher'));
        reg(tick(S.fetchSizes) + 'Look up file sizes', () => toggleSetting('fetchSizes', 'Size lookups'));
        reg(tick(S.captureNetwork) + 'Network capture (reload)', () => toggleSetting('captureNetwork', 'Network capture'));
        if (intentsOn()) reg('🎯 Test “Open in player”', openPlayerDiag);
        reg('🧹 Clear detected list', () => { clearItems(); toast('List cleared'); });
    }
    function toggleSetting(key, label) {
        setSettings(Object.assign({}, S, { [key]: !S[key] }));
        toast(label + ': ' + (S[key] ? 'on' : 'off'));
    }
    function cycleDownload() {
        const order = intentsOn() ? DL_ORDER : ['browser'];
        const i = order.indexOf(S.downloadMethod);
        let next = order[(i + 1) % order.length];
        if (next === 'custom' && !(S.downloadPackage || '').trim()) next = order[0];
        setSettings(Object.assign({}, S, { downloadMethod: next }));
        toast('Download with: ' + methodLabel(next) + (intentsOn() ? '' : ' (app hand-off is Android only)'));
    }

    /* ================================================================== *
     *  Boot
     * ================================================================== */
    if (!IS_TOP && !S.scanFrames) return;

    try { window.__MV = { items, settings: () => S, set: o => setSettings(Object.assign({}, S, o)), visible: visibleItems,
                          stats, report, addItem, openSheet, openPanel, scan, diag: diagText,
                          env: { IS_TOP, IS_ANDROID, IS_XBROWSER, HANDLER, PAGE_ID } }; } catch (e) {}

    if (S.captureNetwork) installNet();
    if (S.perfObserver) installPerf();
    initFrameChannel();
    armGesture();

    if (IS_TOP) {
        buildMenu();
        onValue('settings', (n, o, nv, remote) => {
            if (remote && nv && typeof nv === 'object') { S = Object.assign({}, DEFAULTS, nv); applySettings(); }
        });
        document.addEventListener('fullscreenchange', () => { if (host) mountHost(); repositionAll(); });
        document.addEventListener('webkitfullscreenchange', () => { if (host) mountHost(); repositionAll(); });
    }

    // media events don't bubble, but a capture listener still sees them
    ['loadstart', 'loadedmetadata', 'play', 'durationchange'].forEach(t => document.addEventListener(t, e => {
        const el = e.target;
        if (el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) {
            collectSources(el).forEach(u => reportDom(u, el.tagName === 'AUDIO' ? 'audio' : 'video'));
            if (IS_TOP && el.tagName === 'VIDEO' && S.buttonOn && el.ownerDocument === document && document.body) ensureButton(el);
        }
    }, true));

    try {
        new MutationObserver(scheduleScan).observe(document.documentElement || document,
            { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    } catch (e) {}

    function boot() {
        scan();
        if (IS_TOP) {
            updateFab();
            let raf = false;
            const onMove = () => { if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; repositionAll(); }); } };
            window.addEventListener('scroll', onMove, true);
            window.addEventListener('resize', () => {
                const z = uiZ; applyZ();
                if (fab && z !== uiZ) restoreFab(); else if (fab) { const r = fab.getBoundingClientRect(); placeFab(r.left, r.top); }
                onMove();
            }, true);
        }
        setInterval(() => {
            scan();
            if (IS_TOP) {
                repositionAll();
                if (host && !host.isConnected) mountHost();
                if (sheetOpen && section === 'tab') renderList();     // ages, in place
            }
        }, 1500);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
