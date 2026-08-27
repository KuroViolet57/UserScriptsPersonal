/* ==========================================================================
 * Media Vault — content script (top frame)
 *
 * Complements the background webRequest sniffer with what only the page can
 * see: <video>/<audio> element sources (cached media that never re-hits the
 * network, and blob:/MSE streams), plus the floating on-video button that
 * opens the in-page pop-up player with download / open-in-player / copy.
 * ========================================================================== */
(() => {
    'use strict';
    if (window.top !== window) return;
    if (window.__mediaVaultLoaded) return;
    window.__mediaVaultLoaded = true;

    let settings = {
        buttonOn: true, buttonSize: 44, buttonCorner: 'tr',
        minVideoPx: 120, playerPackage: '', gesture: 'tap3', gestureTarget: 'panel'
    };

    function send(msg) {
        return new Promise(res => {
            try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || {}); }); }
            catch (e) { res({}); }
        });
    }
    send({ type: 'getSettings' }).then(r => { if (r.ok) settings = Object.assign(settings, r.settings); boot(); });

    /* --------------------------- DOM reporting --------------------------- */
    const reported = new Set();
    function collectSources(el) {
        const urls = [];
        if (el.currentSrc) urls.push(el.currentSrc);
        if (el.src) urls.push(el.src);
        el.querySelectorAll && el.querySelectorAll('source[src]').forEach(s => urls.push(s.src));
        return urls.filter(u => u && !u.startsWith('data:'));
    }
    function scan() {
        const found = [];
        document.querySelectorAll('video, audio').forEach(el => {
            const kind = el.tagName === 'AUDIO' ? 'audio' : 'video';
            for (const u of collectSources(el)) {
                if (reported.has(u)) continue;
                reported.add(u);
                found.push({
                    url: u, kind, blob: u.startsWith('blob:'),
                    title: (document.title || '').slice(0, 80),
                    pageUrl: location.href
                });
            }
            if (kind === 'video' && settings.buttonOn) ensureButton(el);
        });
        if (found.length) send({ type: 'domMedia', items: found });
        trackedButtons.forEach((btn, vid) => {
            if (!document.contains(vid)) { btn.remove(); trackedButtons.delete(vid); }
        });
    }

    /* ------------------------------ styles ------------------------------ */
    const css = `
    .mv-btn{position:fixed;z-index:2147483000;border:none;border-radius:50%;
        background:linear-gradient(135deg,#5b8cff,#a855f7);color:#fff;display:flex;align-items:center;
        justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.5);cursor:pointer;padding:0}
    .mv-btn svg{width:52%;height:52%}
    .mv-ov{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.6);display:flex;
        align-items:center;justify-content:center;font-family:system-ui,Roboto,sans-serif}
    .mv-panel{background:#15151f;color:#edeef5;border:1px solid #33334a;border-radius:14px;
        width:min(94vw,540px);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 14px 50px rgba(0,0,0,.65)}
    .mv-head{display:flex;align-items:center;gap:8px;padding:11px 13px;
        background:linear-gradient(135deg,#5b8cff33,#a855f733);font-weight:700;font-size:14px}
    .mv-head span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mv-x{background:none;border:none;color:#bbb;font-size:20px;padding:2px 8px;cursor:pointer}
    .mv-body{overflow:auto;padding:10px 12px}
    .mv-player{background:#000;min-height:180px;max-height:46vh;display:flex}
    .mv-player video,.mv-player audio{width:100%;max-height:46vh;background:#000}
    .mv-noprev{color:#9a9ab0;font-size:12.5px;display:flex;align-items:center;justify-content:center;
        flex:1;padding:18px;text-align:center;line-height:1.5}
    .mv-item{border:1px solid #2c2c3e;border-radius:11px;padding:9px 11px;margin-bottom:9px;background:#1b1b28}
    .mv-item.on{border-color:#5b8cff;background:#1b2337}
    .mv-name{font-size:12.5px;font-weight:700;word-break:break-all;margin-bottom:3px}
    .mv-meta{font-size:10.5px;color:#9a9ab0;display:flex;gap:7px;flex-wrap:wrap;margin-bottom:7px}
    .mv-badge{background:#33334a;border-radius:5px;padding:1px 6px;font-weight:800;font-size:9.5px;
        text-transform:uppercase;letter-spacing:.4px}
    .mv-badge.s{background:#7a4d00;color:#ffd591}
    .mv-badge.b{background:#4d2a55;color:#e6b3f0}
    .mv-acts{display:flex;gap:6px;flex-wrap:wrap}
    .mv-a{border:none;border-radius:8px;padding:8px 10px;font-size:11.5px;font-weight:700;cursor:pointer;
        background:#33334a;color:#edeef5;display:inline-flex;gap:5px;align-items:center}
    .mv-a.p{background:linear-gradient(135deg,#5b8cff,#7c6cff);color:#fff}
    .mv-a.g{background:linear-gradient(135deg,#10b981,#059669);color:#fff}
    .mv-empty{color:#9a9ab0;text-align:center;padding:24px 12px;font-size:12.5px;line-height:1.6}
    .mv-toast{position:fixed;left:50%;bottom:46px;transform:translateX(-50%);background:#33334a;color:#fff;
        padding:9px 15px;border-radius:20px;z-index:2147483630;font-size:12.5px;font-weight:600;
        box-shadow:0 4px 14px rgba(0,0,0,.5);max-width:88vw;text-align:center}`;
    function addStyle() {
        if (document.getElementById('mv-style')) return;
        const s = document.createElement('style');
        s.id = 'mv-style'; s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    }

    const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

    let toastT;
    function toast(m) {
        let t = document.querySelector('.mv-toast');
        if (!t) { t = document.createElement('div'); t.className = 'mv-toast'; document.body.appendChild(t); }
        t.textContent = m; clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 2400);
    }

    /* --------------------------- on-video button --------------------------- */
    const trackedButtons = new Map();
    function ensureButton(video) {
        if (trackedButtons.has(video)) return;
        addStyle();
        const b = document.createElement('button');
        b.className = 'mv-btn';
        b.innerHTML = PLAY;
        b.title = 'Media Vault';
        b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openOverlay(video); }, true);
        document.body.appendChild(b);
        trackedButtons.set(video, b);
        position(video, b);
    }
    function position(video, b) {
        const size = settings.buttonSize;
        const r = video.getBoundingClientRect();
        const vis = r.width >= settings.minVideoPx && r.height >= 60 &&
            r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
        if (!vis) { b.style.display = 'none'; return; }
        b.style.display = 'flex';
        b.style.width = b.style.height = size + 'px';
        const pad = 6;
        b.style.top = Math.max(0, settings.buttonCorner[0] === 't' ? r.top + pad : r.bottom - size - pad) + 'px';
        b.style.left = Math.max(0, settings.buttonCorner[1] === 'l' ? r.left + pad : r.right - size - pad) + 'px';
    }
    function repositionAll() { trackedButtons.forEach((b, v) => position(v, b)); }

    /* ------------------------------ helpers ------------------------------ */
    function human(n) {
        if (n == null || isNaN(n)) return '';
        const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
        while (n >= 1024 && i < 3) { n /= 1024; i++; }
        return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
    }
    function buildIntent(url, pkg, kind) {
        let it = 'intent:' + url + '#Intent;action=android.intent.action.VIEW;';
        it += 'type=' + encodeURIComponent(kind === 'audio' ? 'audio/*' : 'video/*') + ';';
        if (pkg) it += 'package=' + pkg + ';';
        return it + 'end';
    }
    function copy(text) {
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
            .then(() => toast('Link copied'), () => {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
                document.body.appendChild(ta); ta.select();
                try { document.execCommand('copy'); toast('Link copied'); }
                catch (e) { toast('Copy failed'); }
                ta.remove();
            });
    }
    async function download(item) {
        const r = await send({ type: 'download', url: item.url, filename: item.name });
        if (r.ok) { toast('Download started'); return; }
        // fallback: plain anchor (same-origin/blob) — best effort
        const a = document.createElement('a');
        a.href = item.url; a.download = item.name || 'media';
        document.body.appendChild(a); a.click(); a.remove();
        toast(r.error ? 'Downloader said: ' + r.error : 'Trying browser download…');
    }

    /* ------------------------------ overlay ------------------------------ */
    let overlay = null;
    function openOverlay(video) {
        addStyle();
        closeOverlay();
        if (video && !video.paused) { try { video.pause(); } catch (e) {} }
        return openOverlay2(video);
    }
    async function openOverlay2(video) {
        const resp = await send({ type: 'getMediaForMe' });
        const items = (resp.ok ? resp.items : []) || [];

        overlay = document.createElement('div');
        overlay.className = 'mv-ov';
        overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });

        const panel = document.createElement('div');
        panel.className = 'mv-panel';
        panel.innerHTML = `
            <div class="mv-head"><span>🎬 Media on this page</span>
                <button class="mv-x" data-a="x">✕</button></div>
            <div class="mv-player" id="mv-player"><div class="mv-noprev">Tap an item below to preview it here.</div></div>
            <div class="mv-body" id="mv-list"></div>`;
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        panel.querySelector('[data-a="x"]').addEventListener('click', closeOverlay);

        const list = panel.querySelector('#mv-list');
        const playerBox = panel.querySelector('#mv-player');

        const usable = items.filter(x => !x.segKey || x.segments < 3);
        const shown = usable.length ? usable : items;
        if (!shown.length) {
            list.innerHTML = '<div class="mv-empty">Nothing detected yet.<br>Play the video for a moment, then reopen.</div>';
        }

        // preselect: the tapped video's current source if we know it
        const currentSrc = video ? collectSources(video)[0] : null;

        shown.sort((a, b) => (b.ts || 0) - (a.ts || 0)).forEach(item => {
            const row = document.createElement('div');
            row.className = 'mv-item';
            const segInfo = item.segments > 2 ? `<span class="mv-badge s">${item.segments} segments</span>` : '';
            row.innerHTML = `
                <div class="mv-name"></div>
                <div class="mv-meta">
                    <span class="mv-badge">${item.ext || '?'}</span>
                    <span class="mv-badge">${item.kind}</span>
                    ${item.kind === 'stream' ? '<span class="mv-badge s">stream</span>' : ''}
                    ${item.blob ? '<span class="mv-badge b">blob</span>' : ''}
                    ${segInfo}
                    ${item.size ? '<span>' + human(item.size) + '</span>' : (item.segBytes ? '<span>' + human(item.segBytes) + '+</span>' : '')}
                    <span>${item.host || ''}</span>
                </div>
                <div class="mv-acts">
                    <button class="mv-a p" data-a="play">▶ Preview</button>
                    <button class="mv-a g" data-a="dl">⬇ Download</button>
                    <button class="mv-a" data-a="ext">↗ Player</button>
                    <button class="mv-a" data-a="copy">⧉ Copy</button>
                </div>`;
            row.querySelector('.mv-name').textContent = item.name || item.url;
            row.querySelector('[data-a="play"]').addEventListener('click', () => {
                list.querySelectorAll('.mv-item').forEach(x => x.classList.remove('on'));
                row.classList.add('on');
                if (item.kind === 'stream' && !item.blob) {
                    playerBox.innerHTML = '<div class="mv-noprev">Streaming playlist (' + (item.ext || '').toUpperCase() +
                        ') — no in-page preview.<br>Use Download or Player.</div>';
                    return;
                }
                playerBox.innerHTML = '';
                const m = document.createElement(item.kind === 'audio' ? 'audio' : 'video');
                m.controls = true; m.autoplay = true; m.playsInline = true;
                m.src = item.url;
                m.addEventListener('error', () => {
                    playerBox.innerHTML = '<div class="mv-noprev">Preview failed to load.<br>Try Download or Player.</div>';
                });
                playerBox.appendChild(m);
            });
            row.querySelector('[data-a="dl"]').addEventListener('click', () => {
                if (item.blob) { toast('blob: streams can only be watched in-page'); return; }
                download(item);
            });
            row.querySelector('[data-a="ext"]').addEventListener('click', () => {
                if (item.blob) { toast('blob: streams can only be watched in-page'); return; }
                location.href = buildIntent(item.url, settings.playerPackage, item.kind);
            });
            row.querySelector('[data-a="copy"]').addEventListener('click', () => copy(item.url));
            list.appendChild(row);

            if (currentSrc && item.url === currentSrc) row.querySelector('[data-a="play"]').click();
        });
    }
    function closeOverlay() {
        if (!overlay) return;
        const m = overlay.querySelector('video, audio');
        if (m) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {} }
        overlay.remove(); overlay = null;
    }

    /* --------------------------- open gesture ---------------------------
     * Multi-finger shortcut straight to the media panel (default: 3-finger
     * tap; configurable — 3-finger swipe DOWN is a system screenshot on many
     * Android skins, so avoid that one if your phone grabs it). */
    function fireGesture() {
        if (settings.gestureTarget === 'tab') send({ type: 'openManagerTab' });
        else if (settings.gestureTarget === 'popup') {
            // Fall back to the on-page panel only if the native sheet truly
            // didn't open — judged by focus, since some builds open it while
            // still reporting failure (which doubled the UIs).
            let lostFocus = false;
            const onBlur = () => { lostFocus = true; };
            addEventListener('blur', onBlur, { once: true });
            send({ type: 'tryOpenPopup' }).then(r => {
                setTimeout(() => {
                    removeEventListener('blur', onBlur);
                    const opened = (r && r.ok) || lostFocus || !document.hasFocus();
                    if (!opened) openOverlay(null);
                }, 400);
            });
        }
        else openOverlay(null);
    }

    function armGesture() {
        const need = () => {
            const g = settings.gesture || 'off';
            return g === 'tap4' ? 4 : (g === 'off' ? 0 : 3);
        };
        let tracking = false, fired = false, sx = 0, sy = 0, st = 0, moved = 0, seen = 0;
        const centroid = ts => {
            let x = 0, y = 0;
            for (const t of ts) { x += t.clientX; y += t.clientY; }
            return { x: x / ts.length, y: y / ts.length };
        };
        addEventListener('touchstart', e => {
            const n = need(); if (!n) return;
            seen = Math.max(seen, e.touches.length);
            if (e.touches.length === n && !tracking) {
                tracking = true; fired = false; moved = 0;
                const c = centroid(e.touches); sx = c.x; sy = c.y; st = Date.now();
            }
        }, { passive: true });
        addEventListener('touchmove', e => {
            if (!tracking || fired) return;
            const g = settings.gesture, n = need();
            if (e.touches.length !== n) return;
            const c = centroid(e.touches);
            const dx = c.x - sx, dy = c.y - sy;
            moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
            if (g === 'swipe3up' && dy < -90 && Math.abs(dx) < 130) { fired = true; tracking = false; fireGesture(); }
            else if (g === 'swipe3down' && dy > 90 && Math.abs(dx) < 130) { fired = true; tracking = false; fireGesture(); }
        }, { passive: true });
        addEventListener('touchend', e => {
            if (e.touches.length > 0) return;
            const g = settings.gesture;
            if (tracking && !fired && (g === 'tap3' || g === 'tap4') &&
                seen === need() && Date.now() - st < 450 && moved < 40) {
                fireGesture();
            }
            tracking = false; fired = false; seen = 0;
        }, { passive: true });
        addEventListener('touchcancel', () => { tracking = false; fired = false; seen = 0; }, { passive: true });
    }

    // settings changes (saved from the popup) apply live, no reload needed
    try {
        chrome.storage.onChanged.addListener(ch => {
            if (ch.settings && ch.settings.newValue) Object.assign(settings, ch.settings.newValue);
        });
    } catch (e) {}

    /* ------------------------------- boot ------------------------------- */
    function boot() {
        scan();
        armGesture();
        let raf = false;
        const onMove = () => { if (!raf) { raf = true; requestAnimationFrame(() => { raf = false; repositionAll(); }); } };
        addEventListener('scroll', onMove, true);
        addEventListener('resize', onMove, true);
        setInterval(() => { scan(); repositionAll(); }, 1500);
    }

    // popup asks us to open the overlay ("show on page")
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg.type === 'openOverlay') { openOverlay2(null); sendResponse({ ok: true }); }
    });
})();
