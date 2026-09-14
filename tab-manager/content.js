/* ==========================================================================
 * Tab Vault — content script: multi-finger gestures open the manager.
 *
 * TWO independent gestures, each with its own target (Setup → Quick access):
 *  - sheet:      the full manager (manager.html) as a bottom sheet
 *  - groupsheet: a compact switcher listing ONLY the current tab's group —
 *                tap a row to jump to that tab (Vivaldi-style chevron view)
 *  - popup:      the browser's native popup sheet (falls back to the sheet)
 *  - tab:        the full-page manager
 * ========================================================================== */
(() => {
    'use strict';
    if (window.top !== window) return;
    if (window.__tabVaultGesture) return;
    window.__tabVaultGesture = true;

    let gesture = 'swipe3up', target = 'sheet';
    let gesture2 = 'off', target2 = 'groupsheet';

    function readCfg(s) {
        gesture = (s && s.gesture) || 'off';
        target = (s && s.gestureTarget) || 'sheet';
        gesture2 = (s && s.gesture2) || 'off';
        target2 = (s && s.gestureTarget2) || 'groupsheet';
    }
    try {
        chrome.storage.local.get({ settings: {} }, o =>
            readCfg(Object.assign({ gesture: 'swipe3up' }, o.settings)));
        chrome.storage.onChanged.addListener(ch => {
            if (ch.settings && ch.settings.newValue) readCfg(ch.settings.newValue);
        });
    } catch (e) {}

    function send(msg) {
        return new Promise(res => {
            try { chrome.runtime.sendMessage(msg, r => { void chrome.runtime.lastError; res(r || {}); }); }
            catch (e) { res({}); }
        });
    }

    function fire(t) {
        if (t === 'tab') send({ type: 'openManager' });
        else if (t === 'groupsheet') openGroupSheet();
        else if (t === 'popup') {
            let lostFocus = false;
            const onBlur = () => { lostFocus = true; };
            addEventListener('blur', onBlur, { once: true });
            send({ type: 'tryOpenPopup' }).then(r => {
                setTimeout(() => {
                    removeEventListener('blur', onBlur);
                    const opened = (r && r.ok) || lostFocus || !document.hasFocus();
                    if (!opened) openSheet();
                }, 400);
            });
        } else openSheet();
    }

    /* ------------------------------ styles ------------------------------ */
    function ensureSheetStyle() {
        if (document.getElementById('tv-sheet-style')) return;
        const s = document.createElement('style');
        s.id = 'tv-sheet-style';
        s.textContent = `
        #tv-sheet-wrap{position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.45);
            opacity:0;transition:opacity .22s}
        #tv-sheet-wrap.show{opacity:1}
        .tv-sheetbox{position:fixed;left:0;right:0;bottom:0;z-index:2147483641;
            background:#15151b;border-radius:18px 18px 0 0;overflow:hidden;
            box-shadow:0 -8px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;
            transform:translateY(105%);transition:transform .26s cubic-bezier(.2,.8,.3,1);
            touch-action:none;font-family:system-ui,Roboto,sans-serif}
        .tv-sheetbox.show{transform:translateY(0)}
        #tv-sheet{height:84vh}
        #tv-gsheet{max-height:72vh}
        .tv-grab{flex:0 0 auto;height:40px;display:flex;align-items:center;
            background:#181823;cursor:grab;position:relative;touch-action:none}
        .tv-grab .tv-pill{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
            width:52px;height:5.5px;border-radius:3px;background:#4a4a5e}
        .tv-grab .tv-close{position:absolute;right:6px;top:50%;transform:translateY(-50%);
            width:32px;height:32px;border:none;border-radius:9px;background:#22222f;color:#9a9ab0;
            font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center}
        #tv-sheet iframe{flex:1;border:none;width:100%;background:#0f0f17}
        .tv-ghead{display:flex;align-items:center;gap:9px;padding:4px 14px 10px;background:#181823;
            border-bottom:1px solid #2a2a36}
        .tv-gdot{width:12px;height:12px;border-radius:50%;flex:0 0 auto}
        .tv-gtitle{flex:1;color:#edeef5;font-size:14px;font-weight:800;white-space:nowrap;
            overflow:hidden;text-overflow:ellipsis}
        .tv-gcount{color:#8f90a6;font-size:11px;font-weight:800;background:#2b2b3a;
            border-radius:9px;padding:2px 8px}
        .tv-glist{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px 8px 14px}
        .tv-grow{display:flex;align-items:center;gap:11px;padding:11px 10px;border-radius:11px;
            color:#edeef5}
        .tv-grow.on{background:#1c2740;box-shadow:inset 3px 0 0 #5b8cff}
        .tv-grow:active{background:#22222f}
        .tv-gav{width:30px;height:30px;border-radius:9px;flex:0 0 auto;display:flex;align-items:center;
            justify-content:center;font-size:13px;font-weight:800;color:#fff;text-transform:uppercase;
            overflow:hidden}
        .tv-gav img{width:100%;height:100%;object-fit:cover}
        .tv-gbody{min-width:0;flex:1}
        .tv-gt{font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .tv-gu{font-size:11px;color:#8f90a6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
        .tv-gempty{color:#8f90a6;text-align:center;padding:26px 16px;font-size:13px;line-height:1.6}
        .g-grey{background:#6b7280}.g-blue{background:#3b82f6}.g-red{background:#ef4444}
        .g-yellow{background:#eab308}.g-green{background:#22c55e}.g-pink{background:#ec4899}
        .g-purple{background:#a855f7}.g-cyan{background:#06b6d4}.g-orange{background:#f97316}`;
        (document.head || document.documentElement).appendChild(s);
    }

    /* ------------------------- shared sheet frame ------------------------- */
    let sheetWrap = null;      // backdrop; one sheet at a time

    function buildSheet(id) {
        ensureSheetStyle();
        closeSheet();
        sheetWrap = document.createElement('div');
        sheetWrap.id = 'tv-sheet-wrap';
        const sheet = document.createElement('div');
        sheet.className = 'tv-sheetbox';
        sheet.id = id;
        const grab = document.createElement('div');
        grab.className = 'tv-grab';
        grab.innerHTML = '<span class="tv-pill"></span><button class="tv-close">✕</button>';
        grab.querySelector('.tv-close').addEventListener('click', closeSheet);
        sheet.appendChild(grab);
        document.body.appendChild(sheetWrap);
        document.body.appendChild(sheet);
        requestAnimationFrame(() => { sheetWrap && sheetWrap.classList.add('show'); sheet.classList.add('show'); });
        sheetWrap.addEventListener('click', closeSheet);

        let sy = 0, dy = 0, dragging = false, lastY = 0, lastT = 0, vel = 0;
        grab.addEventListener('touchstart', e => {
            dragging = true; sy = lastY = e.touches[0].clientY; dy = 0; vel = 0; lastT = Date.now();
            sheet.style.transition = 'none';
        }, { passive: true });
        grab.addEventListener('touchmove', e => {
            if (!dragging) return;
            const y = e.touches[0].clientY, t = Date.now();
            if (t > lastT) vel = (y - lastY) / (t - lastT);
            lastY = y; lastT = t;
            dy = Math.max(0, y - sy);
            sheet.style.transform = `translateY(${dy}px)`;
        }, { passive: true });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            sheet.style.transition = '';
            if (dy > 80 || (dy > 24 && vel > 0.45)) closeSheet();
            else sheet.style.transform = '';
        };
        grab.addEventListener('touchend', endDrag, { passive: true });
        grab.addEventListener('touchcancel', endDrag, { passive: true });
        return sheet;
    }

    function closeSheet() {
        if (!sheetWrap) return;
        const wrap = sheetWrap; sheetWrap = null;
        wrap.classList.remove('show');
        document.querySelectorAll('.tv-sheetbox').forEach(sh => {
            sh.style.transform = ''; sh.classList.remove('show');
            setTimeout(() => sh.remove(), 280);
        });
        setTimeout(() => wrap.remove(), 280);
    }

    /* --------------------------- manager sheet --------------------------- */
    function openSheet() {
        const sheet = buildSheet('tv-sheet');
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('manager.html');
        sheet.appendChild(frame);
    }

    /* ------------------------ group switcher sheet ------------------------ */
    function hue(str) {
        let n = 0; for (let i = 0; i < (str || '').length; i++) n = (n * 31 + str.charCodeAt(i)) >>> 0;
        return n % 360;
    }
    function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; } }

    async function openGroupSheet() {
        const r = await send({ type: 'getGroupSwitcher' });
        if (!r.ok) { openSheet(); return; }
        if (!r.grouped || !r.tabs.length) {
            // Not in a group (or the browser hides groups): show the full manager.
            openSheet();
            return;
        }
        const sheet = buildSheet('tv-gsheet');

        const head = document.createElement('div');
        head.className = 'tv-ghead';
        const dot = document.createElement('span');
        dot.className = 'tv-gdot g-' + ((r.group && r.group.color) || 'grey');
        const title = document.createElement('span');
        title.className = 'tv-gtitle';
        title.textContent = (r.group && r.group.title) || 'Tab group';
        const count = document.createElement('span');
        count.className = 'tv-gcount';
        count.textContent = r.tabs.length + ' tab' + (r.tabs.length === 1 ? '' : 's');
        head.appendChild(dot); head.appendChild(title); head.appendChild(count);
        sheet.appendChild(head);

        const list = document.createElement('div');
        list.className = 'tv-glist';
        for (const t of r.tabs) {
            const row = document.createElement('div');
            row.className = 'tv-grow' + (t.id === r.activeId ? ' on' : '');
            const av = document.createElement('div');
            av.className = 'tv-gav';
            const h = hue(hostOf(t.url));
            av.style.background = `linear-gradient(135deg,hsl(${h} 62% 46%),hsl(${(h + 28) % 360} 62% 36%))`;
            av.textContent = (hostOf(t.url) || '?').replace(/^[^a-z0-9]*/i, '').charAt(0) || '?';
            if (t.favIconUrl && /^https?:/.test(t.favIconUrl)) {
                const img = document.createElement('img');
                img.src = t.favIconUrl;
                img.onload = () => { av.textContent = ''; av.style.background = '#22222f'; av.appendChild(img); };
            }
            const body = document.createElement('div');
            body.className = 'tv-gbody';
            const tt = document.createElement('div'); tt.className = 'tv-gt';
            tt.textContent = t.title || hostOf(t.url);
            const tu = document.createElement('div'); tu.className = 'tv-gu';
            tu.textContent = hostOf(t.url);
            body.appendChild(tt); body.appendChild(tu);
            row.appendChild(av); row.appendChild(body);
            row.addEventListener('click', () => {
                closeSheet();
                if (t.id !== r.activeId) send({ type: 'activateTab', tabId: t.id });
            });
            list.appendChild(row);
        }
        sheet.appendChild(list);
    }

    /* ------------------------- gesture detector -------------------------
     * Two configs at once. Fingers decide which configs are candidates,
     * the motion (tap vs directional swipe) picks the one that fires. */
    const need = g => g === 'tap4' ? 4 : (g === 'off' || !g ? 0 : 3);
    const configs = () => [{ g: gesture, t: target }, { g: gesture2, t: target2 }]
        .filter(c => need(c.g) > 0);

    let tracking = false, fired = false, sx = 0, sy = 0, st = 0, moved = 0, seen = 0, fingers = 0;

    function centroid(touches) {
        let x = 0, y = 0;
        for (const t of touches) { x += t.clientX; y += t.clientY; }
        return { x: x / touches.length, y: y / touches.length };
    }

    addEventListener('touchstart', e => {
        if (sheetWrap) return;
        const n = e.touches.length;
        seen = Math.max(seen, n);
        if (!tracking && configs().some(c => need(c.g) === n)) {
            tracking = true; fired = false; moved = 0; fingers = n;
            const c = centroid(e.touches); sx = c.x; sy = c.y; st = Date.now();
        }
    }, { passive: true });

    addEventListener('touchmove', e => {
        if (!tracking || fired) return;
        if (e.touches.length !== fingers) return;
        const c = centroid(e.touches);
        const dx = c.x - sx, dy = c.y - sy;
        moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
        if (Math.abs(dx) >= 130) return;
        const dir = dy < -90 ? 'swipe3up' : (dy > 90 ? 'swipe3down' : null);
        if (!dir) return;
        const hit = configs().find(cf => cf.g === dir && need(cf.g) === fingers);
        if (hit) { fired = true; tracking = false; fire(hit.t); }
    }, { passive: true });

    addEventListener('touchend', e => {
        if (e.touches.length > 0) return;
        if (tracking && !fired && Date.now() - st < 450 && moved < 40) {
            const hit = configs().find(cf => (cf.g === 'tap3' || cf.g === 'tap4') && need(cf.g) === seen);
            if (hit) fire(hit.t);
        }
        tracking = false; fired = false; seen = 0;
    }, { passive: true });

    addEventListener('touchcancel', () => { tracking = false; fired = false; seen = 0; }, { passive: true });
})();
