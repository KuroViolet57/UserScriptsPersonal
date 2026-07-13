// ==UserScript==
// @name         Better Media Sniffer
// @name:es      Mejor Detector de Medios
// @namespace    https://github.com/KuroViolet57/UserScriptsPersonal
// @version      1.4.0
// @description  A better media sniffer for Android userscript managers (Via Browser, etc). Detects videos/audio on the page, shows an organized list with size + extension filters, adds a floating button on video players that opens a resizable pop-up player with download / open-in-external-player / copy-link actions.
// @description:es Detector de medios mejorado para navegadores Android. Detecta videos/audio, lista organizada con filtros por tamaño y extension, boton flotante sobre el reproductor con ventana emergente para descargar, abrir en reproductor externo o copiar enlace.
// @author       KuroViolet57
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_addStyle
// @grant        GM_info
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==

/*
 * Better Media Sniffer
 * --------------------
 * Works in userscript managers that expose the classic GM_* API (Via Browser,
 * XBrowser, Violentmonkey, Tampermonkey, etc). Everything degrades gracefully if
 * a given GM_* function is missing.
 *
 * Downloading on Android:
 *  - "XBrowser / GM download": uses GM_download with a Referer header (fixes the
 *    common "stuck in queue" caused by hotlink protection) and XBrowser's `tag`
 *    subfolder feature. Recommended on XBrowser.
 *  - "Direct download": fetches the file as a blob (GM_xmlhttpRequest, bypasses
 *    CORS) and saves it. Recommended on Via.
 *  - "Send to 1DM+/ADM": hands the real URL to that app via an android `intent:`.
 *  - "Open in player": android `intent:` VIEW to a media player.
 *  - "Copy link": copies the direct media URL to the clipboard.
 *
 * On XBrowser the settings toggles are also mirrored into the native script menu
 * (tap the menu entries to flip them) via GM_registerMenuCommand /
 * GM_unregisterMenuCommand.
 */

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     *  GM compatibility layer
     * ------------------------------------------------------------------ */
    const GM = {
        getValue(key, def) {
            try {
                if (typeof GM_getValue === 'function') return GM_getValue(key, def);
            } catch (e) {}
            try {
                const raw = localStorage.getItem('__bms_' + key);
                return raw == null ? def : JSON.parse(raw);
            } catch (e) { return def; }
        },
        setValue(key, val) {
            try {
                if (typeof GM_setValue === 'function') { GM_setValue(key, val); return; }
            } catch (e) {}
            try { localStorage.setItem('__bms_' + key, JSON.stringify(val)); } catch (e) {}
        },
        registerMenu(label, fn) {
            try { if (typeof GM_registerMenuCommand === 'function') return GM_registerMenuCommand(label, fn); } catch (e) {}
            return null;
        },
        unregisterMenu(id) {
            try { if (id != null && typeof GM_unregisterMenuCommand === 'function') GM_unregisterMenuCommand(id); } catch (e) {}
        },
        setClipboard(text) {
            try {
                if (typeof GM_setClipboard === 'function') { GM_setClipboard(text, 'text'); return true; }
            } catch (e) {}
            return false;
        },
        openInTab(url, background) {
            try { if (typeof GM_openInTab === 'function') { GM_openInTab(url, background); return true; } } catch (e) {}
            try { window.open(url, '_blank'); return true; } catch (e) {}
            return false;
        },
        xhr(opts) {
            const fn = (typeof GM_xmlhttpRequest === 'function') ? GM_xmlhttpRequest :
                       (typeof GM !== 'undefined' && GM.xmlHttpRequest) ? GM.xmlHttpRequest : null;
            if (fn) { try { return fn(opts); } catch (e) {} }
            return null;
        },
        download(opts) {
            try { if (typeof GM_download === 'function') { GM_download(opts); return true; } } catch (e) {}
            return false;
        },
        addStyle(css) {
            try { if (typeof GM_addStyle === 'function') { GM_addStyle(css); return; } } catch (e) {}
            const s = document.createElement('style');
            s.textContent = css;
            (document.head || document.documentElement).appendChild(s);
        }
    };

    /* ------------------------------------------------------------------ *
     *  Environment detection
     * ------------------------------------------------------------------ */
    const SCRIPT_HANDLER = (() => {
        try { return (typeof GM_info !== 'undefined' && GM_info && GM_info.scriptHandler) || ''; } catch (e) { return ''; }
    })();
    const IS_XBROWSER = /x\s*-?browser|xbext/i.test(SCRIPT_HANDLER) || /XBrowser/i.test(navigator.userAgent || '');
    const HAS_UNREGISTER = (typeof GM_unregisterMenuCommand === 'function');

    function escAttr(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    /* ------------------------------------------------------------------ *
     *  Settings
     * ------------------------------------------------------------------ */
    const DEFAULT_SETTINGS = {
        buttonSize: 44,          // px, floating button diameter on the playbox
        buttonOpacity: 0.85,     // 0..1
        buttonCorner: 'tr',      // tl / tr / bl / br
        minVideoPx: 120,         // don't add buttons to tiny videos (min width or height)
        captureNetwork: true,    // sniff media from fetch/XHR
        fetchSizes: true,        // HEAD requests to learn file size
        showFab: true,           // persistent corner launcher with detected count
        // 'gm' (GM_download+Referer) | 'browser' (blob) | '1dm' | 'adm' | 'intent'
        // Default to the native GM download on XBrowser, blob elsewhere (Via).
        downloadMethod: IS_XBROWSER ? 'gm' : 'browser',
        gmTag: '',               // XBrowser GM_download subfolder tag ('' = none)
        playerPackage: '',       // android package for "open in player" ('' = chooser)
        playerLabel: 'Ask (system chooser)',
        intentFormB: false       // use intent://host form instead of intent:url
    };

    let settings = Object.assign({}, DEFAULT_SETTINGS, GM.getValue('settings', {}));

    function saveSettings() { GM.setValue('settings', settings); }

    const PLAYER_PRESETS = [
        { label: 'Ask (system chooser)', pkg: '' },
        { label: 'MX Player (Free)', pkg: 'com.mxtech.videoplayer.ad' },
        { label: 'MX Player Pro', pkg: 'com.mxtech.videoplayer.pro' },
        { label: 'VLC', pkg: 'org.videolan.vlc' },
        { label: 'Just (Player)', pkg: 'com.brouken.player' },
        { label: 'nPlayer', pkg: 'cn.nplayer.nplayer' },
        { label: 'Web Video Cast', pkg: 'com.instantbits.cast.webvideo' },
        { label: 'Custom package…', pkg: '__custom__' }
    ];

    /* ------------------------------------------------------------------ *
     *  Media classification
     * ------------------------------------------------------------------ */
    const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'ts', 'm3u8', 'mpd', '3gp', 'ogv'];
    const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba'];
    const STREAM_EXT = ['m3u8', 'mpd']; // no native <video> preview on Android Chrome/WebView
    const ALL_EXT = VIDEO_EXT.concat(AUDIO_EXT);

    const MIME_MAP = {
        mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
        mov: 'video/quicktime', avi: 'video/x-msvideo', flv: 'video/x-flv', ts: 'video/mp2t',
        m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml', '3gp': 'video/3gpp',
        ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
        oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm'
    };

    function extFromUrl(url) {
        try {
            const clean = url.split('#')[0].split('?')[0];
            const base = clean.substring(clean.lastIndexOf('/') + 1);
            const dot = base.lastIndexOf('.');
            if (dot === -1) return '';
            return base.substring(dot + 1).toLowerCase();
        } catch (e) { return ''; }
    }

    function extFromContentType(ct) {
        if (!ct) return '';
        ct = ct.split(';')[0].trim().toLowerCase();
        for (const k in MIME_MAP) if (MIME_MAP[k] === ct) return k;
        if (ct === 'application/x-mpegurl' || ct === 'audio/mpegurl') return 'm3u8';
        if (ct.startsWith('video/')) return ct.split('/')[1];
        if (ct.startsWith('audio/')) return ct.split('/')[1];
        return '';
    }

    function nameFromUrl(url, ext) {
        try {
            const clean = url.split('#')[0].split('?')[0];
            let base = decodeURIComponent(clean.substring(clean.lastIndexOf('/') + 1));
            if (!base || base.indexOf('.') === -1) {
                base = (base || 'media') + (ext ? '.' + ext : '');
            }
            base = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
            return base || ('media' + (ext ? '.' + ext : ''));
        } catch (e) { return 'media' + (ext ? '.' + ext : ''); }
    }

    function isMediaExt(ext) { return ALL_EXT.indexOf(ext) !== -1; }
    function isAudio(ext) { return AUDIO_EXT.indexOf(ext) !== -1; }
    function isStream(ext) { return STREAM_EXT.indexOf(ext) !== -1; }

    function humanSize(bytes) {
        if (bytes == null || bytes < 0 || isNaN(bytes)) return '';
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0, n = bytes;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(n < 10 ? 2 : 1)) + ' ' + u[i];
    }

    /* ------------------------------------------------------------------ *
     *  Media store
     * ------------------------------------------------------------------ */
    const store = [];            // {url, ext, name, size, mime, kind, blob, el, ts}
    const seen = new Set();
    const listeners = [];
    function onChange(fn) { listeners.push(fn); }
    function emit() { listeners.forEach(fn => { try { fn(); } catch (e) {} }); }

    function addMedia(url, opts) {
        opts = opts || {};
        if (!url || typeof url !== 'string') return null;
        if (url.startsWith('data:')) return null;
        const isBlob = url.startsWith('blob:');
        let ext = opts.ext || extFromUrl(url);
        if (!ext && opts.contentType) ext = extFromContentType(opts.contentType);
        // Accept blob/media element sources even without a clear extension.
        if (!isMediaExt(ext) && !opts.fromElement && !isBlob) return null;
        if (seen.has(url)) {
            const existing = store.find(m => m.url === url);
            if (existing && opts.size && !existing.size) { existing.size = opts.size; emit(); }
            if (existing && opts.el && !existing.el) existing.el = opts.el;
            return existing;
        }
        seen.add(url);
        const item = {
            url,
            ext: ext || (isBlob ? 'blob' : ''),
            name: nameFromUrl(url, ext),
            size: opts.size || null,
            mime: opts.contentType || MIME_MAP[ext] || '',
            kind: isAudio(ext) ? 'audio' : 'video',
            blob: isBlob,
            stream: isStream(ext),
            el: opts.el || null,
            ts: Date.now()
        };
        store.push(item);
        emit();
        if (settings.fetchSizes && !item.size && !isBlob) fetchSize(item);
        return item;
    }

    const sizeQueue = [];
    let sizeActive = 0;
    function fetchSize(item) {
        sizeQueue.push(item);
        pumpSizeQueue();
    }
    function pumpSizeQueue() {
        while (sizeActive < 3 && sizeQueue.length) {
            const item = sizeQueue.shift();
            sizeActive++;
            const done = () => { sizeActive--; pumpSizeQueue(); };
            const req = GM.xhr({
                method: 'HEAD',
                url: item.url,
                timeout: 12000,
                onload(r) {
                    try {
                        const h = (r.responseHeaders || '');
                        const m = /content-length:\s*(\d+)/i.exec(h);
                        if (m) { item.size = parseInt(m[1], 10); emit(); }
                        const ct = /content-type:\s*([^\r\n]+)/i.exec(h);
                        if (ct && !item.mime) item.mime = ct[1].trim();
                    } catch (e) {}
                    done();
                },
                onerror: done,
                ontimeout: done
            });
            if (!req) { sizeActive--; } // GM.xhr unavailable
        }
    }

    /* ------------------------------------------------------------------ *
     *  Network interception (fetch + XHR)
     * ------------------------------------------------------------------ */
    function looksLikeMedia(url, ct) {
        if (!url) return false;
        const ext = extFromUrl(url);
        if (isMediaExt(ext)) return true;
        if (ct) {
            ct = ct.toLowerCase();
            if (ct.indexOf('video/') === 0 || ct.indexOf('audio/') === 0) return true;
            if (ct.indexOf('mpegurl') !== -1 || ct.indexOf('dash+xml') !== -1) return true;
        }
        return false;
    }

    function installNetworkHooks() {
        if (!settings.captureNetwork) return;
        const win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

        // fetch
        try {
            const origFetch = win.fetch;
            if (origFetch) {
                win.fetch = function (input, init) {
                    const url = (typeof input === 'string') ? input : (input && input.url) || '';
                    return origFetch.apply(this, arguments).then(res => {
                        try {
                            const ct = res.headers && res.headers.get('content-type');
                            const cl = res.headers && res.headers.get('content-length');
                            const finalUrl = res.url || url;
                            if (looksLikeMedia(finalUrl, ct)) {
                                addMedia(finalUrl, { contentType: ct, size: cl ? parseInt(cl, 10) : null });
                            }
                        } catch (e) {}
                        return res;
                    });
                };
            }
        } catch (e) {}

        // XHR
        try {
            const XP = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
            if (XP) {
                const origOpen = XP.open;
                const origSend = XP.send;
                XP.open = function (method, url) {
                    this.__bmsUrl = url;
                    return origOpen.apply(this, arguments);
                };
                XP.send = function () {
                    this.addEventListener('load', () => {
                        try {
                            const ct = this.getResponseHeader && this.getResponseHeader('content-type');
                            const cl = this.getResponseHeader && this.getResponseHeader('content-length');
                            const finalUrl = this.responseURL || this.__bmsUrl;
                            if (looksLikeMedia(finalUrl, ct)) {
                                addMedia(finalUrl, { contentType: ct, size: cl ? parseInt(cl, 10) : null });
                            }
                        } catch (e) {}
                    });
                    return origSend.apply(this, arguments);
                };
            }
        } catch (e) {}
    }

    /* ------------------------------------------------------------------ *
     *  DOM scanning for <video>/<audio>/<source>
     * ------------------------------------------------------------------ */
    const trackedVideos = new Map(); // videoEl -> buttonEl

    function collectSources(el) {
        const urls = [];
        if (el.currentSrc) urls.push(el.currentSrc);
        if (el.src) urls.push(el.src);
        el.querySelectorAll && el.querySelectorAll('source[src]').forEach(s => urls.push(s.src));
        return urls.filter(Boolean);
    }

    function scanMediaElements() {
        const els = document.querySelectorAll('video, audio');
        els.forEach(el => {
            collectSources(el).forEach(u => addMedia(u, { fromElement: true, el }));
            if (el.tagName === 'VIDEO') ensureVideoButton(el);
        });
        // prune buttons for detached videos
        trackedVideos.forEach((btn, vid) => {
            if (!document.contains(vid)) { btn.remove(); trackedVideos.delete(vid); }
        });
    }

    /* ------------------------------------------------------------------ *
     *  Styles
     * ------------------------------------------------------------------ */
    GM.addStyle(`
    .bms-fab{position:fixed;z-index:2147483600;right:12px;bottom:96px;width:46px;height:46px;border-radius:50%;
        background:#7c5cff;color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px;
        box-shadow:0 4px 14px rgba(0,0,0,.4);border:none;touch-action:none;user-select:none}
    .bms-fab .bms-fab-count{position:absolute;top:-4px;right:-4px;background:#ff4d6d;color:#fff;font-size:11px;
        min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;font-weight:700}
    .bms-vidbtn{position:fixed;z-index:2147483000;border:none;border-radius:50%;background:rgba(124,92,255,.95);
        color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.5);
        cursor:pointer;padding:0;line-height:0}
    .bms-vidbtn svg{width:56%;height:56%}
    .bms-overlay{position:fixed;inset:0;z-index:2147483610;background:rgba(0,0,0,.55);display:flex;
        align-items:center;justify-content:center;font-family:system-ui,-apple-system,Roboto,sans-serif}
    .bms-panel{background:#1c1c22;color:#eee;border-radius:14px;width:min(96vw,560px);max-height:90vh;
        display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.6)}
    .bms-head{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#25252d;font-weight:600;font-size:15px}
    .bms-head .bms-spacer{flex:1}
    .bms-x{background:none;border:none;color:#bbb;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}
    .bms-body{padding:12px 14px;overflow:auto}
    .bms-filters{display:flex;gap:8px;flex-wrap:wrap;padding:10px 14px;background:#202027;position:sticky;top:0}
    .bms-filters select,.bms-filters input{background:#33333d;color:#eee;border:1px solid #444;border-radius:8px;
        padding:7px 9px;font-size:14px}
    .bms-item{border:1px solid #33333d;border-radius:10px;padding:10px 12px;margin-bottom:10px;background:#26262e}
    .bms-item .bms-name{font-size:14px;word-break:break-all;margin-bottom:4px;font-weight:600}
    .bms-item .bms-meta{font-size:12px;color:#9a9aa5;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
    .bms-badge{background:#3a3a46;border-radius:6px;padding:2px 7px;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
    .bms-badge.stream{background:#7a4d00;color:#ffd591}
    .bms-badge.blob{background:#4d2a55;color:#e6b3f0}
    .bms-actions{display:flex;gap:8px;flex-wrap:wrap}
    .bms-btn{background:#7c5cff;color:#fff;border:none;border-radius:8px;padding:9px 12px;font-size:13px;
        cursor:pointer;display:flex;align-items:center;gap:6px;font-weight:600}
    .bms-btn.sec{background:#3a3a46}
    .bms-btn.gc{background:#2ea043}
    .bms-empty{color:#888;text-align:center;padding:26px 10px}
    /* Player popup */
    .bms-player{position:fixed;z-index:2147483620;background:#101014;border:1px solid #33333d;border-radius:12px;
        display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 46px rgba(0,0,0,.7);
        width:min(92vw,640px);max-width:98vw;max-height:92vh;resize:both;min-width:240px;min-height:200px}
    .bms-player-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1d1d24;cursor:move;touch-action:none}
    .bms-player-head .bms-pt{flex:1;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#eee}
    .bms-player-body{flex:1;display:flex;flex-direction:column;background:#000;min-height:0}
    .bms-player-body video,.bms-player-body audio{width:100%;height:100%;flex:1;background:#000;object-fit:contain;min-height:0}
    .bms-nopreview{flex:1;display:flex;align-items:center;justify-content:center;color:#aaa;text-align:center;padding:18px;font-size:13px}
    .bms-player-meta{font-size:11px;color:#9a9aa5;padding:6px 10px;background:#15151a;word-break:break-all}
    .bms-player-actions{display:flex;gap:8px;padding:10px;background:#1d1d24;flex-wrap:wrap;justify-content:center}
    .bms-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:#333;color:#fff;
        padding:10px 16px;border-radius:24px;z-index:2147483630;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.5)}
    .bms-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #2c2c34}
    .bms-row label{font-size:14px;flex:1}
    .bms-row .bms-hint{display:block;font-size:11px;color:#888;margin-top:2px}
    .bms-row input[type=range]{width:120px}
    .bms-row input[type=text],.bms-row input[type=number],.bms-row select{background:#33333d;color:#eee;
        border:1px solid #444;border-radius:8px;padding:7px 9px;font-size:14px;max-width:180px}
    .bms-val{min-width:44px;text-align:right;font-size:13px;color:#bbb}
    `);

    /* ------------------------------------------------------------------ *
     *  Icons
     * ------------------------------------------------------------------ */
    const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const ICON_DL = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.6l3.3-3.3 1.4 1.4L12 17.4 7.3 11.7l1.4-1.4L12 13.6V3zM5 19h14v2H5z"/></svg>';
    const ICON_EXT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M14 3h7v7h-2V6.4l-8.3 8.3-1.4-1.4L17.6 5H14V3zM5 5h5v2H5v12h12v-5h2v7H3V5z"/></svg>';
    const ICON_COPY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

    /* ------------------------------------------------------------------ *
     *  Toast
     * ------------------------------------------------------------------ */
    let toastTimer;
    function toast(msg) {
        let t = document.querySelector('.bms-toast');
        if (!t) { t = document.createElement('div'); t.className = 'bms-toast'; document.body.appendChild(t); }
        t.textContent = msg;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => t.remove(), 2200);
    }

    /* ------------------------------------------------------------------ *
     *  Actions: download / open in player / copy
     * ------------------------------------------------------------------ */
    const DL_PKGS = { adm: 'com.dv.adm', '1dm': 'idm.internet.download.manager.plus' };

    // Last-resort: click a real <a download>. On Android this only reliably saves
    // for same-origin / blob URLs; for cross-origin direct files the WebView tends
    // to just open the file, which is exactly the bug we avoid by preferring blob.
    function anchorDownload(item, saveUrl) {
        const a = document.createElement('a');
        a.href = saveUrl || item.url;
        a.download = item.name || 'video';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 0);
    }

    // Referer often required by hotlink-protected media hosts. Sending it makes
    // GM_download / GM_xmlhttpRequest succeed instead of getting a 403 (which on
    // XBrowser shows up as a download stuck in the queue).
    function refererHeaders() {
        const h = {};
        try { h.Referer = location.href; } catch (e) {}
        return h;
    }

    // Native manager download (GM_download). On XBrowser this hands the file to
    // its built-in downloader; `tag` puts it in a subfolder. Falls back to blob.
    function gmDownload(item) {
        if (item.blob) { blobDownload(item); return; }
        const opts = {
            url: item.url,
            name: item.name || 'video',
            headers: refererHeaders(),
            onload() { toast('Downloaded: ' + item.name); },
            onerror(e) {
                const msg = (e && (e.error || e.details)) ? (': ' + (e.error || e.details)) : '';
                toast('GM download failed' + msg + ' — trying direct');
                blobDownload(item);
            },
            ontimeout() { toast('GM download timed out — trying direct'); blobDownload(item); }
        };
        if (settings.gmTag) opts.tag = settings.gmTag;
        if (GM.download(opts)) toast('Sent to downloader…');
        else blobDownload(item);
    }

    // Fetch the file as a blob (GM.xhr bypasses CORS) and save it locally. This
    // forces a genuine download instead of the browser opening the video in a tab.
    function blobDownload(item) {
        if (item.blob) { anchorDownload(item); toast('Saving…'); return; }
        toast('Starting download…');
        const req = GM.xhr({
            method: 'GET',
            url: item.url,
            responseType: 'blob',
            headers: refererHeaders(),
            timeout: 0,
            onprogress(e) {
                if (e && e.lengthComputable) toast('Downloading ' + Math.round(e.loaded / e.total * 100) + '%');
            },
            onload(r) {
                try {
                    const blob = r.response;
                    if (!blob || (blob.size === 0)) { toast('Empty response, opening link'); anchorDownload(item); return; }
                    const url = URL.createObjectURL(blob);
                    anchorDownload(item, url);
                    setTimeout(() => URL.revokeObjectURL(url), 120000);
                    toast('Saved: ' + item.name);
                } catch (e) { toast('Save failed, opening link'); anchorDownload(item); }
            },
            onerror() { toast('Direct download failed, opening link'); anchorDownload(item); },
            ontimeout() { toast('Download timed out, opening link'); anchorDownload(item); }
        });
        if (!req) { toast('GM_xmlhttpRequest unavailable — opening link'); anchorDownload(item); }
    }

    // Build an android VIEW intent. Use a BROAD mime (video/* or audio/*): apps
    // like VLC/MX register intent filters for video/* but not necessarily for a
    // specific codec (video/webm), so an explicit package + exact mime resolves
    // to nothing ("Allow" -> nothing happens). Broad mime matches reliably.
    function broadType(item) { return item.kind === 'audio' ? 'audio/*' : 'video/*'; }
    function buildViewIntent(url, pkg, title, mime, formB) {
        let intent;
        if (formB) {
            // Chrome-canonical form: intent://host/path#Intent;scheme=https;...
            const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
            intent = m ? ('intent://' + m[2] + '#Intent;scheme=' + m[1] + ';action=android.intent.action.VIEW;')
                       : ('intent:' + url + '#Intent;action=android.intent.action.VIEW;');
        } else {
            intent = 'intent:' + url + '#Intent;action=android.intent.action.VIEW;';
        }
        if (mime) intent += 'type=' + encodeURIComponent(mime) + ';';
        if (pkg) intent += 'package=' + pkg + ';';
        if (title) intent += 'S.title=' + encodeURIComponent(title) + ';';
        intent += 'end';
        return intent;
    }

    // Hand the real http(s) URL to an external app (1DM+, ADM, or a chooser).
    function intentDownload(item, pkg) {
        if (item.blob) { toast('Blob source can only be saved directly'); blobDownload(item); return; }
        try { window.location.href = buildViewIntent(item.url, pkg, item.name, broadType(item)); }
        catch (e) { toast('No handler, downloading directly'); blobDownload(item); }
    }

    function downloadMedia(item) {
        switch (settings.downloadMethod) {
            case 'gm': gmDownload(item); return;
            case '1dm': intentDownload(item, DL_PKGS['1dm']); return;
            case 'adm': intentDownload(item, DL_PKGS.adm); return;
            case 'intent': intentDownload(item, ''); return;
            case 'browser':
            default: blobDownload(item); return;
        }
    }

    let lastPlayItem = null;
    let lastIntent = null;

    function fireIntent(intent, label) {
        lastIntent = intent;
        try { console.log('[BMS] open-in-player intent (' + (label || '') + '):', intent); } catch (e) {}
        try { window.BMS && (window.BMS.lastIntent = intent); } catch (e) {}
        window.location.href = intent;
    }

    function openInPlayer(item) {
        if (item.blob) { toast('Blob source can only be played in-page'); return; }
        lastPlayItem = item;
        try {
            fireIntent(buildViewIntent(item.url, settings.playerPackage, item.name, broadType(item),
                settings.intentFormB), 'default');
            if (settings.playerPackage) {
                setTimeout(() => toast('Nothing opened? Menu → "Test Open-in-player" to find a working variant'), 1600);
            }
        } catch (e) {
            window.open(item.url, '_blank');
        }
    }

    function copyLink(item) {
        if (GM.setClipboard(item.url)) { toast('Link copied'); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(item.url).then(() => toast('Link copied'), () => fallbackCopy(item.url));
        } else fallbackCopy(item.url);
    }
    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Link copied'); } catch (e) { toast('Copy failed'); }
        ta.remove();
    }

    /* ------------------------------------------------------------------ *
     *  Diagnostics: on-screen console + "Open in player" intent tester
     * ------------------------------------------------------------------ */
    // On-screen console for phones (no chrome://inspect needed). Fetches eruda via
    // GM.xhr and evals it so the page's CSP can't block it; falls back to a tag.
    function toggleConsole() {
        const init = () => { try { window.eruda.init(); toast('Console opened (tap the floating button)'); } catch (e) { toast('Console init failed'); } };
        if (window.eruda) {
            try { window.eruda.destroy(); window.eruda = null; toast('Console closed'); } catch (e) { init(); }
            return;
        }
        toast('Loading console…');
        const tagFallback = () => {
            const s = document.createElement('script');
            s.src = 'https://cdn.jsdelivr.net/npm/eruda';
            s.onload = init;
            s.onerror = () => toast('Could not load console (blocked / offline)');
            (document.body || document.documentElement).appendChild(s);
        };
        const req = GM.xhr({
            method: 'GET', url: 'https://cdn.jsdelivr.net/npm/eruda',
            onload(r) {
                try { (0, eval)(r.responseText); init(); }   // eslint-disable-line no-eval
                catch (e) { tagFallback(); }
            },
            onerror: tagFallback, ontimeout: tagFallback
        });
        if (!req) tagFallback();
    }

    // Pick a target media item to test with.
    function diagTarget() {
        if (lastPlayItem && !lastPlayItem.blob) return lastPlayItem;
        const vids = store.filter(m => m.kind === 'video' && !m.blob && !m.stream);
        return vids.length ? vids[vids.length - 1] : (store.length ? store[store.length - 1] : null);
    }

    // Try each intent variant so you can find which one launches your player.
    function openPlayerDiag() {
        const item = diagTarget();
        if (!item) { toast('No testable media yet — play/scan a direct video first'); return; }
        const pkg = settings.playerPackage;
        const pkgLabel = settings.playerLabel || (pkg || 'chooser');
        const variants = [
            ['① ' + pkgLabel + ' · video/*', () => buildViewIntent(item.url, pkg, item.name, broadType(item), false)],
            ['② ' + pkgLabel + ' · intent:// form', () => buildViewIntent(item.url, pkg, item.name, broadType(item), true)],
            ['③ System chooser · video/*', () => buildViewIntent(item.url, '', item.name, broadType(item), false)],
            ['④ ' + pkgLabel + ' · exact mime', () => buildViewIntent(item.url, pkg, item.name, item.mime || MIME_MAP[item.ext] || broadType(item), false)],
            ['⑤ ' + pkgLabel + ' · no type', () => buildViewIntent(item.url, pkg, item.name, '', false)]
        ];

        const ov = document.createElement('div');
        ov.className = 'bms-overlay';
        ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
        const panel = document.createElement('div');
        panel.className = 'bms-panel';
        panel.innerHTML = `<div class="bms-head"><span>🎬 Open-in-player test</span><span class="bms-spacer"></span>
            <button class="bms-x" data-x>✕</button></div>
            <div class="bms-body">
              <div class="bms-hint" style="margin-bottom:10px">Target: <b>${escAttr(item.name)}</b><br>
              Tap each until your player opens. Note which number works and tell me — I'll make it the default.
              Use 🐞 Debug console to see the exact intent strings/errors.</div>
            </div>`;
        const body = panel.querySelector('.bms-body');
        variants.forEach(([label, make]) => {
            const b = mkBtn('', label, () => { fireIntent(make(), label); });
            b.style.cssText = 'width:100%;justify-content:flex-start;margin-bottom:8px';
            body.appendChild(b);
        });
        const copyBtn = mkBtn('sec', ICON_COPY + ' Copy all intent strings', () => {
            const all = variants.map(([l, mk]) => l + '\n' + mk()).join('\n\n');
            if (!GM.setClipboard(all) && navigator.clipboard) navigator.clipboard.writeText(all);
            toast('Copied — paste it back to me');
        });
        copyBtn.style.cssText = 'width:100%;justify-content:center;margin-top:4px';
        body.appendChild(copyBtn);
        panel.querySelector('[data-x]').onclick = () => ov.remove();
        ov.appendChild(panel);
        document.body.appendChild(ov);
    }

    /* ------------------------------------------------------------------ *
     *  Floating button on each <video>
     * ------------------------------------------------------------------ */
    function cornerStyle(btn, rect, size) {
        const pad = 6;
        let top, left;
        const c = settings.buttonCorner;
        top = (c[0] === 't') ? rect.top + pad : rect.bottom - size - pad;
        left = (c[1] === 'l') ? rect.left + pad : rect.right - size - pad;
        btn.style.top = Math.max(0, top) + 'px';
        btn.style.left = Math.max(0, left) + 'px';
    }

    function ensureVideoButton(video) {
        if (trackedVideos.has(video)) return;
        const btn = document.createElement('button');
        btn.className = 'bms-vidbtn';
        btn.innerHTML = ICON_PLAY;
        btn.title = 'Media Sniffer';
        btn.addEventListener('click', (e) => {
            e.preventDefault(); e.stopPropagation();
            openPlayerForVideo(video);
        }, true);
        document.body.appendChild(btn);
        trackedVideos.set(video, btn);
        positionVideoButton(video, btn);
    }

    function positionVideoButton(video, btn) {
        const size = settings.buttonSize;
        const rect = video.getBoundingClientRect();
        const visible = rect.width >= settings.minVideoPx && rect.height >= 60 &&
            rect.bottom > 0 && rect.top < window.innerHeight &&
            rect.right > 0 && rect.left < window.innerWidth;
        if (!visible) { btn.style.display = 'none'; return; }
        // Respect the active filter: don't show a button on a video whose media
        // doesn't pass the filter (keeps thumbnail-heavy pages usable).
        if (filterIsActive()) {
            const item = itemForVideo(video);
            if (item && !matchesFilter(item)) { btn.style.display = 'none'; return; }
            // No captured source yet but a size floor is set: hide until we know
            // it qualifies, so tiny/uncaptured previews stay clean.
            if (!item && listFilter.minSize > 0) { btn.style.display = 'none'; return; }
        }
        btn.style.display = 'flex';
        btn.style.width = size + 'px';
        btn.style.height = size + 'px';
        btn.style.opacity = settings.buttonOpacity;
        cornerStyle(btn, rect, size);
    }

    function repositionAllButtons() {
        trackedVideos.forEach((btn, vid) => positionVideoButton(vid, btn));
    }

    function openPlayerForVideo(video) {
        // Best source for this specific video element.
        const urls = collectSources(video);
        let item = null;
        for (const u of urls) {
            item = store.find(m => m.url === u) || addMedia(u, { fromElement: true, el: video });
            if (item) break;
        }
        if (!item && urls.length) {
            item = { url: urls[0], ext: extFromUrl(urls[0]) || 'blob', name: nameFromUrl(urls[0]),
                     size: null, mime: '', kind: 'video', blob: urls[0].startsWith('blob:'),
                     stream: false, el: video };
        }
        if (!item) { toast('No source found — opening media list'); openList(); return; }
        openPlayer(item, video);
    }

    /* ------------------------------------------------------------------ *
     *  Resizable / draggable player popup
     * ------------------------------------------------------------------ */
    let activePlayer = null;
    function openPlayer(item, sourceVideo) {
        closePlayer();
        lastPlayItem = item;
        const wrap = document.createElement('div');
        wrap.className = 'bms-player';

        const head = document.createElement('div');
        head.className = 'bms-player-head';
        head.innerHTML = `<span class="bms-pt">${item.name}</span>`;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'bms-x'; copyBtn.innerHTML = ICON_COPY; copyBtn.title = 'Copy link';
        copyBtn.addEventListener('click', () => copyLink(item));
        const xBtn = document.createElement('button');
        xBtn.className = 'bms-x'; xBtn.textContent = '✕'; xBtn.title = 'Close';
        xBtn.addEventListener('click', closePlayer);
        head.appendChild(copyBtn); head.appendChild(xBtn);

        const body = document.createElement('div');
        body.className = 'bms-player-body';

        if (item.stream && !item.blob) {
            body.innerHTML = `<div class="bms-nopreview">⚠️ This is a streaming playlist (<b>${item.ext.toUpperCase()}</b>).<br>Preview isn't supported here — use <b>Download</b> or <b>Open in player</b>.</div>`;
        } else {
            const media = document.createElement(item.kind === 'audio' ? 'audio' : 'video');
            media.controls = true;
            media.autoplay = true;
            media.playsInline = true;
            media.src = item.url;
            media.addEventListener('error', () => {
                body.innerHTML = '<div class="bms-nopreview">⚠️ Preview failed to load.<br>Try <b>Download</b> or <b>Open in player</b>.</div>';
            });
            body.appendChild(media);
            // pause the underlying page video to avoid double audio
            if (sourceVideo && !sourceVideo.paused) { try { sourceVideo.pause(); } catch (e) {} }
        }

        const meta = document.createElement('div');
        meta.className = 'bms-player-meta';
        meta.textContent = [item.ext.toUpperCase(), item.size ? humanSize(item.size) : '', item.url]
            .filter(Boolean).join('  •  ');

        const actions = document.createElement('div');
        actions.className = 'bms-player-actions';
        actions.appendChild(mkBtn('gc', ICON_DL + ' Download', () => downloadMedia(item)));
        actions.appendChild(mkBtn('', ICON_EXT + ' Open in player', () => openInPlayer(item)));
        actions.appendChild(mkBtn('sec', ICON_COPY + ' Copy link', () => copyLink(item)));

        wrap.appendChild(head);
        wrap.appendChild(body);
        wrap.appendChild(meta);
        wrap.appendChild(actions);
        document.body.appendChild(wrap);
        activePlayer = wrap;

        // center it
        const w = wrap.offsetWidth, h = wrap.offsetHeight;
        wrap.style.left = Math.max(4, (window.innerWidth - w) / 2) + 'px';
        wrap.style.top = Math.max(4, (window.innerHeight - h) / 2) + 'px';

        makeDraggable(wrap, head);
    }

    function closePlayer() {
        if (activePlayer) {
            const m = activePlayer.querySelector('video, audio');
            if (m) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {} }
            activePlayer.remove();
            activePlayer = null;
        }
    }

    function mkBtn(cls, html, fn) {
        const b = document.createElement('button');
        b.className = 'bms-btn' + (cls ? ' ' + cls : '');
        b.innerHTML = html;
        b.addEventListener('click', fn);
        return b;
    }

    function makeDraggable(el, handle) {
        let sx, sy, ox, oy, dragging = false;
        const start = (x, y) => {
            dragging = true;
            sx = x; sy = y;
            const r = el.getBoundingClientRect();
            ox = r.left; oy = r.top;
        };
        const move = (x, y) => {
            if (!dragging) return;
            let nl = ox + (x - sx), nt = oy + (y - sy);
            nl = Math.min(Math.max(0, nl), window.innerWidth - 60);
            nt = Math.min(Math.max(0, nt), window.innerHeight - 40);
            el.style.left = nl + 'px'; el.style.top = nt + 'px';
        };
        const end = () => { dragging = false; };
        handle.addEventListener('touchstart', e => { const t = e.touches[0]; start(t.clientX, t.clientY); }, { passive: true });
        handle.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY); e.preventDefault(); }, { passive: false });
        handle.addEventListener('touchend', end);
        handle.addEventListener('mousedown', e => { start(e.clientX, e.clientY); e.preventDefault(); });
        window.addEventListener('mousemove', e => move(e.clientX, e.clientY));
        window.addEventListener('mouseup', end);
    }

    /* ------------------------------------------------------------------ *
     *  Media list panel (with filters)
     * ------------------------------------------------------------------ */
    let listOverlay = null;
    const listFilter = Object.assign(
        { type: 'all', ext: 'all', minSize: 0, query: '' },
        GM.getValue('filter', {})
    );

    function saveFilter() { GM.setValue('filter', listFilter); }

    // Shared predicate used by the list, the FAB count, and on-video buttons.
    function matchesFilter(m) {
        if (!m) return true;
        if (listFilter.type !== 'all' && m.kind !== listFilter.type) return false;
        if (listFilter.ext !== 'all' && m.ext !== listFilter.ext) return false;
        if (listFilter.minSize && (!m.size || m.size < listFilter.minSize)) return false;
        if (listFilter.query && m.name.toLowerCase().indexOf(listFilter.query.toLowerCase()) === -1) return false;
        return true;
    }

    function filterIsActive() {
        return listFilter.type !== 'all' || listFilter.ext !== 'all' ||
               listFilter.minSize > 0 || !!listFilter.query;
    }

    // Find the detected media item that belongs to a given <video> element.
    function itemForVideo(video) {
        const urls = collectSources(video);
        for (const u of urls) { const it = store.find(m => m.url === u); if (it) return it; }
        return store.find(m => m.el === video) || null;
    }

    // When filters change, refresh everything they influence.
    function applyFilterEverywhere() {
        saveFilter();
        renderList();
        updateFab();
        repositionAllButtons();
    }

    function openList() {
        if (listOverlay) { renderList(); return; }
        listOverlay = document.createElement('div');
        listOverlay.className = 'bms-overlay';
        listOverlay.addEventListener('click', e => { if (e.target === listOverlay) closeList(); });

        const panel = document.createElement('div');
        panel.className = 'bms-panel';
        panel.innerHTML = `
            <div class="bms-head">
                <span>🎯 Detected media</span><span class="bms-spacer"></span>
                <button class="bms-x" data-act="settings" title="Settings">⚙️</button>
                <button class="bms-x" data-act="clear" title="Clear list">🗑</button>
                <button class="bms-x" data-act="close">✕</button>
            </div>
            <div class="bms-filters">
                <select data-f="type">
                    <option value="all">All types</option>
                    <option value="video">Video</option>
                    <option value="audio">Audio</option>
                </select>
                <select data-f="ext"></select>
                <select data-f="minSize">
                    <option value="0">Any size</option>
                    <option value="1048576">&gt; 1 MB</option>
                    <option value="5242880">&gt; 5 MB</option>
                    <option value="20971520">&gt; 20 MB</option>
                    <option value="104857600">&gt; 100 MB</option>
                </select>
                <input data-f="query" type="text" placeholder="filter by name…" style="flex:1;min-width:120px">
            </div>
            <div class="bms-body" id="bms-list-body"></div>`;
        listOverlay.appendChild(panel);
        document.body.appendChild(listOverlay);

        panel.querySelector('[data-act="close"]').addEventListener('click', closeList);
        panel.querySelector('[data-act="settings"]').addEventListener('click', () => { closeList(); openSettings(); });
        panel.querySelector('[data-act="clear"]').addEventListener('click', () => {
            store.length = 0; seen.clear(); emit(); renderList();
        });
        panel.querySelectorAll('[data-f]').forEach(el => {
            el.addEventListener('input', () => {
                const f = el.getAttribute('data-f');
                listFilter[f] = (f === 'minSize') ? parseInt(el.value, 10) : el.value;
                applyFilterEverywhere();
            });
        });

        // Restore persisted filter values into the controls.
        panel.querySelector('[data-f="type"]').value = listFilter.type;
        panel.querySelector('[data-f="minSize"]').value = String(listFilter.minSize || 0);
        panel.querySelector('[data-f="query"]').value = listFilter.query || '';

        renderList();
    }

    function closeList() { if (listOverlay) { listOverlay.remove(); listOverlay = null; } }

    function renderList() {
        if (!listOverlay) return;
        // refresh ext dropdown (keep the persisted ext selectable even if not
        // yet detected on this page, so the saved filter survives a reload)
        const extSel = listOverlay.querySelector('[data-f="ext"]');
        const exts = Array.from(new Set(store.map(m => m.ext).filter(Boolean)));
        if (listFilter.ext !== 'all' && exts.indexOf(listFilter.ext) === -1) exts.push(listFilter.ext);
        exts.sort();
        extSel.innerHTML = '<option value="all">All extensions</option>' +
            exts.map(e => `<option value="${e}">${e.toUpperCase()}</option>`).join('');
        extSel.value = listFilter.ext;

        const body = listOverlay.querySelector('#bms-list-body');
        let items = store.slice().sort((a, b) => b.ts - a.ts).filter(matchesFilter);

        if (!items.length) {
            const msg = (store.length && filterIsActive())
                ? ('No media matches the filter (' + store.length + ' hidden).<br>Adjust or clear the filter above.')
                : 'No media detected yet.<br>Play or scroll to the video, then reopen.';
            body.innerHTML = '<div class="bms-empty">' + msg + '</div>';
            return;
        }
        body.innerHTML = '';
        items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'bms-item';
            const badges = [`<span class="bms-badge">${item.ext || '?'}</span>`,
                `<span class="bms-badge">${item.kind}</span>`];
            if (item.stream) badges.push('<span class="bms-badge stream">stream</span>');
            if (item.blob) badges.push('<span class="bms-badge blob">blob</span>');
            row.innerHTML = `
                <div class="bms-name">${item.name}</div>
                <div class="bms-meta">${badges.join('')}${item.size ? '<span>' + humanSize(item.size) + '</span>' : ''}</div>
                <div class="bms-actions"></div>`;
            const acts = row.querySelector('.bms-actions');
            acts.appendChild(mkBtn('', ICON_PLAY.replace('viewBox="0 0 24 24"', 'width="15" height="15" viewBox="0 0 24 24"') + ' Play', () => { closeList(); openPlayer(item); }));
            acts.appendChild(mkBtn('gc', ICON_DL + ' Download', () => downloadMedia(item)));
            acts.appendChild(mkBtn('sec', ICON_EXT + ' Player', () => openInPlayer(item)));
            acts.appendChild(mkBtn('sec', ICON_COPY + ' Copy', () => copyLink(item)));
            body.appendChild(row);
        });
    }

    /* ------------------------------------------------------------------ *
     *  Settings panel
     * ------------------------------------------------------------------ */
    let settingsOverlay = null;
    function openSettings() {
        if (settingsOverlay) return;
        settingsOverlay = document.createElement('div');
        settingsOverlay.className = 'bms-overlay';
        settingsOverlay.addEventListener('click', e => { if (e.target === settingsOverlay) closeSettings(); });

        const panel = document.createElement('div');
        panel.className = 'bms-panel';

        const playerOptions = PLAYER_PRESETS.map(p =>
            `<option value="${p.pkg}" ${p.pkg === settings.playerPackage ? 'selected' : ''}>${p.label}</option>`).join('');
        const isCustom = settings.playerPackage && !PLAYER_PRESETS.some(p => p.pkg === settings.playerPackage);

        panel.innerHTML = `
            <div class="bms-head"><span>⚙️ Settings</span><span class="bms-spacer"></span>
                <button class="bms-x" data-act="close">✕</button></div>
            <div class="bms-body">
                <div class="bms-row">
                    <label>Floating button size<span class="bms-hint">Size of the play button on the video</span></label>
                    <input type="range" min="28" max="80" step="2" data-s="buttonSize" value="${settings.buttonSize}">
                    <span class="bms-val" id="bms-v-size">${settings.buttonSize}px</span>
                </div>
                <div class="bms-row">
                    <label>Button opacity</label>
                    <input type="range" min="0.3" max="1" step="0.05" data-s="buttonOpacity" value="${settings.buttonOpacity}">
                    <span class="bms-val" id="bms-v-op">${Math.round(settings.buttonOpacity * 100)}%</span>
                </div>
                <div class="bms-row">
                    <label>Button corner</label>
                    <select data-s="buttonCorner">
                        <option value="tl">Top-left</option><option value="tr">Top-right</option>
                        <option value="bl">Bottom-left</option><option value="br">Bottom-right</option>
                    </select>
                </div>
                <div class="bms-row">
                    <label>Default third-party player<span class="bms-hint">Used by "Open in player"</span></label>
                    <select data-s="playerPackage">${playerOptions}${isCustom ? `<option value="${settings.playerPackage}" selected>${settings.playerPackage}</option>` : ''}</select>
                </div>
                <div class="bms-row" id="bms-custom-row" style="${isCustom ? '' : 'display:none'}">
                    <label>Custom package name<span class="bms-hint">e.g. com.mxtech.videoplayer.ad</span></label>
                    <input type="text" id="bms-custom-pkg" placeholder="com.example.player" value="${isCustom ? settings.playerPackage : ''}">
                </div>
                <div class="bms-row">
                    <label>Download method<span class="bms-hint">GM download = manager with Referer (best on XBrowser). Direct = blob save (best on Via). 1DM+/ADM hand the URL to that app.</span></label>
                    <select data-s="downloadMethod">
                        <option value="gm">GM download (manager + Referer)${IS_XBROWSER ? ' — recommended' : ''}</option>
                        <option value="browser">Direct download (blob save)${IS_XBROWSER ? '' : ' — recommended'}</option>
                        <option value="1dm">Send to 1DM+</option>
                        <option value="adm">Send to ADM</option>
                        <option value="intent">Send to app (chooser)</option>
                    </select>
                </div>
                <div class="bms-row">
                    <label>Download subfolder (tag)<span class="bms-hint">XBrowser only: GM download saves into this subfolder. Blank = default folder.</span></label>
                    <input type="text" id="bms-gmtag" placeholder="e.g. Videos" value="${escAttr(settings.gmTag || '')}" style="max-width:150px">
                </div>
                <div class="bms-row">
                    <label>Minimum video size for button<span class="bms-hint">Skip tiny videos (px)</span></label>
                    <input type="number" min="0" max="1000" data-s="minVideoPx" value="${settings.minVideoPx}" style="max-width:90px">
                </div>
                <div class="bms-row">
                    <label>Capture network media<span class="bms-hint">Sniff fetch/XHR requests</span></label>
                    <input type="checkbox" data-s="captureNetwork" ${settings.captureNetwork ? 'checked' : ''}>
                </div>
                <div class="bms-row">
                    <label>Fetch file sizes<span class="bms-hint">HEAD requests to learn sizes</span></label>
                    <input type="checkbox" data-s="fetchSizes" ${settings.fetchSizes ? 'checked' : ''}>
                </div>
                <div class="bms-row">
                    <label>Show corner launcher (FAB)</label>
                    <input type="checkbox" data-s="showFab" ${settings.showFab ? 'checked' : ''}>
                </div>
                <div class="bms-row" style="border:none">
                    <button class="bms-btn gc" id="bms-save">Save</button>
                    <button class="bms-btn sec" id="bms-reset">Reset defaults</button>
                </div>
            </div>`;
        settingsOverlay.appendChild(panel);
        document.body.appendChild(settingsOverlay);

        // set current select values
        panel.querySelector('[data-s="buttonCorner"]').value = settings.buttonCorner;
        panel.querySelector('[data-s="downloadMethod"]').value = settings.downloadMethod;

        panel.querySelector('[data-act="close"]').addEventListener('click', closeSettings);
        panel.querySelector('[data-s="buttonSize"]').addEventListener('input', e =>
            panel.querySelector('#bms-v-size').textContent = e.target.value + 'px');
        panel.querySelector('[data-s="buttonOpacity"]').addEventListener('input', e =>
            panel.querySelector('#bms-v-op').textContent = Math.round(e.target.value * 100) + '%');
        const pkgSel = panel.querySelector('[data-s="playerPackage"]');
        pkgSel.addEventListener('change', () => {
            const custom = panel.querySelector('#bms-custom-row');
            custom.style.display = (pkgSel.value === '__custom__') ? '' : 'none';
        });

        panel.querySelector('#bms-save').addEventListener('click', () => {
            panel.querySelectorAll('[data-s]').forEach(el => {
                const key = el.getAttribute('data-s');
                let val;
                if (el.type === 'checkbox') val = el.checked;
                else if (el.type === 'range' || el.type === 'number') val = parseFloat(el.value);
                else val = el.value;
                if (key === 'playerPackage') {
                    if (val === '__custom__') {
                        val = (panel.querySelector('#bms-custom-pkg').value || '').trim();
                    }
                    const preset = PLAYER_PRESETS.find(p => p.pkg === val);
                    settings.playerLabel = preset ? preset.label : (val || 'Custom');
                }
                settings[key] = val;
            });
            const tagEl = panel.querySelector('#bms-gmtag');
            if (tagEl) settings.gmTag = (tagEl.value || '').trim();
            saveSettings();
            applySettings();
            closeSettings();
            toast('Settings saved');
        });
        panel.querySelector('#bms-reset').addEventListener('click', () => {
            settings = Object.assign({}, DEFAULT_SETTINGS);
            saveSettings();
            applySettings();
            closeSettings();
            toast('Settings reset');
        });
    }
    function closeSettings() { if (settingsOverlay) { settingsOverlay.remove(); settingsOverlay = null; } }

    function applySettings() {
        repositionAllButtons();
        updateFab();
        if (HAS_UNREGISTER) buildMenu();
    }

    /* ------------------------------------------------------------------ *
     *  Corner FAB
     * ------------------------------------------------------------------ */
    let fab = null;
    function updateFab() {
        if (!settings.showFab) { if (fab) { fab.remove(); fab = null; } return; }
        if (!fab) {
            fab = document.createElement('button');
            fab.className = 'bms-fab';
            fab.innerHTML = '🎯<span class="bms-fab-count">0</span>';
            fab.title = 'Tap: media list · Long-press: settings';
            let moved = false, longPressed = false, lpTimer = null, sx, sy, ox, oy;
            const down = (x, y) => {
                moved = false; longPressed = false; sx = x; sy = y;
                const r = fab.getBoundingClientRect(); ox = r.left; oy = r.top;
                clearTimeout(lpTimer);
                lpTimer = setTimeout(() => { if (!moved) { longPressed = true; openSettings(); } }, 550);
            };
            const mv = (x, y) => {
                if (Math.abs(x - sx) + Math.abs(y - sy) > 6) { moved = true; clearTimeout(lpTimer); }
                let nl = ox + (x - sx), nt = oy + (y - sy);
                nl = Math.min(Math.max(0, nl), window.innerWidth - 46);
                nt = Math.min(Math.max(0, nt), window.innerHeight - 46);
                fab.style.left = nl + 'px'; fab.style.top = nt + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto';
            };
            const up = () => { clearTimeout(lpTimer); };
            fab.addEventListener('touchstart', e => { const t = e.touches[0]; down(t.clientX, t.clientY); }, { passive: true });
            fab.addEventListener('touchmove', e => { const t = e.touches[0]; mv(t.clientX, t.clientY); }, { passive: true });
            fab.addEventListener('touchend', up);
            fab.addEventListener('touchcancel', up);
            fab.addEventListener('click', () => { if (!moved && !longPressed) openList(); });
            document.body.appendChild(fab);
        }
        const c = fab.querySelector('.bms-fab-count');
        const n = store.filter(matchesFilter).length;
        c.textContent = n;
        c.style.display = n ? 'flex' : 'none';
    }

    /* ------------------------------------------------------------------ *
     *  Bootstrap
     * ------------------------------------------------------------------ */
    installNetworkHooks();

    onChange(updateFab);
    onChange(repositionAllButtons);

    function boot() {
        scanMediaElements();
        updateFab();

        // One-time nudge: on XBrowser the native GM download is the reliable path.
        if (IS_XBROWSER && settings.downloadMethod !== 'gm' && !GM.getValue('xbHintShown', false)) {
            GM.setValue('xbHintShown', true);
            setTimeout(() => toast('XBrowser tip: set Download method to "GM download" (⚙️ or the menu) for reliable saves'), 3500);
        }

        const mo = new MutationObserver(() => { scheduleScan(); });
        mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

        let scanTimer = null;
        function scheduleScan() {
            if (scanTimer) return;
            scanTimer = setTimeout(() => { scanTimer = null; scanMediaElements(); }, 400);
        }
        window.__bmsScheduleScan = scheduleScan;

        // reposition buttons continuously (cheap)
        let rafPending = false;
        const tick = () => {
            rafPending = false;
            repositionAllButtons();
        };
        const req = () => { if (!rafPending) { rafPending = true; requestAnimationFrame(tick); } };
        window.addEventListener('scroll', req, true);
        window.addEventListener('resize', req, true);
        setInterval(() => { scanMediaElements(); repositionAllButtons(); }, 1500);
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);

    /* ------------------------------------------------------------------ *
     *  Native menu (XBrowser/Tampermonkey) — toggles & cyclers.
     *  GM_registerMenuCommand only takes (label, fn), so toggles are done by
     *  re-registering with an updated label (needs GM_unregisterMenuCommand).
     * ------------------------------------------------------------------ */
    const _menuIds = [];
    const DL_LABELS = { gm: 'GM download', browser: 'Direct (blob)', '1dm': '1DM+', adm: 'ADM', intent: 'App chooser' };
    const DL_ORDER = ['gm', 'browser', '1dm', 'adm', 'intent'];

    function _reg(label, fn) { const id = GM.registerMenu(label, fn); if (id != null) _menuIds.push(id); }
    function _clearMenu() {
        if (!HAS_UNREGISTER) return;           // can't clear -> avoid duplicates
        _menuIds.splice(0).forEach(id => GM.unregisterMenu(id));
    }
    function buildMenu() {
        _clearMenu();
        _reg('🎯 Open media list', openList);
        _reg('⚙️ Open settings', openSettings);
        _reg('⬇️ Download method: ' + (DL_LABELS[settings.downloadMethod] || settings.downloadMethod), cycleDownload);
        _reg((settings.showFab ? '☑️' : '⬜') + ' Corner button', () => toggleSetting('showFab'));
        _reg((settings.fetchSizes ? '☑️' : '⬜') + ' Fetch file sizes', () => toggleSetting('fetchSizes'));
        _reg((settings.captureNetwork ? '☑️' : '⬜') + ' Network capture (reload)', () => toggleSetting('captureNetwork'));
        _reg('🎬 Test "Open in player"', openPlayerDiag);
        _reg('🐞 Debug console', toggleConsole);
        _reg('🧹 Clear detected list', () => { store.length = 0; seen.clear(); emit(); toast('List cleared'); });
    }
    function toggleSetting(key) {
        settings[key] = !settings[key]; saveSettings();
        repositionAllButtons(); updateFab();
        if (HAS_UNREGISTER) buildMenu();
        toast(key + ': ' + (settings[key] ? 'on' : 'off'));
    }
    function cycleDownload() {
        const i = DL_ORDER.indexOf(settings.downloadMethod);
        settings.downloadMethod = DL_ORDER[(i + 1) % DL_ORDER.length];
        saveSettings();
        if (HAS_UNREGISTER) buildMenu();
        toast('Download method: ' + DL_LABELS[settings.downloadMethod]);
    }
    buildMenu();

    // expose a tiny debug handle
    try {
        window.BMS = { store, settings, openList, openSettings, addMedia, env: { IS_XBROWSER, SCRIPT_HANDLER, HAS_UNREGISTER } };
    } catch (e) {}
})();
