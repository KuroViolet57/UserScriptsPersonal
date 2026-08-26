/* ==========================================================================
 * Tab Vault — content script: multi-finger gesture opens the manager.
 *
 * Two gesture targets (Setup → "Gesture opens"):
 *  - sheet (default): the real manager.html embedded in an extension iframe,
 *    presented as a bottom sheet over the current page. Swipe the handle down
 *    (or tap the backdrop) to dismiss — you never leave the page.
 *  - tab: the full-page manager in its own tab (old behaviour).
 *
 * Extension iframes are exempt from the page's CSP, so the sheet works
 * everywhere; manager.html must be listed in web_accessible_resources.
 * ========================================================================== */
(() => {
    'use strict';
    if (window.top !== window) return;
    if (window.__tabVaultGesture) return;
    window.__tabVaultGesture = true;

    let gesture = 'swipe3up';     // off | tap3 | tap4 | swipe3up | swipe3down
    let target = 'sheet';         // sheet | tab

    try {
        chrome.storage.local.get({ settings: {} }, o => {
            gesture = (o.settings && o.settings.gesture) || 'swipe3up';
            target = (o.settings && o.settings.gestureTarget) || 'sheet';
        });
        chrome.storage.onChanged.addListener(ch => {
            if (ch.settings && ch.settings.newValue) {
                gesture = ch.settings.newValue.gesture || 'off';
                target = ch.settings.newValue.gestureTarget || 'sheet';
            }
        });
    } catch (e) {}

    function fire() {
        if (target === 'tab') {
            try { chrome.runtime.sendMessage({ type: 'openManager' }, () => { void chrome.runtime.lastError; }); }
            catch (e) {}
        } else {
            openSheet();
        }
    }

    /* ---------------------------- bottom sheet ---------------------------- */
    let sheetWrap = null;

    function ensureSheetStyle() {
        if (document.getElementById('tv-sheet-style')) return;
        const s = document.createElement('style');
        s.id = 'tv-sheet-style';
        s.textContent = `
        #tv-sheet-wrap{position:fixed;inset:0;z-index:2147483640;background:rgba(0,0,0,.45);
            opacity:0;transition:opacity .22s}
        #tv-sheet-wrap.show{opacity:1}
        #tv-sheet{position:fixed;left:0;right:0;bottom:0;height:84vh;z-index:2147483641;
            background:#15151b;border-radius:18px 18px 0 0;overflow:hidden;
            box-shadow:0 -8px 40px rgba(0,0,0,.6);display:flex;flex-direction:column;
            transform:translateY(105%);transition:transform .26s cubic-bezier(.2,.8,.3,1);
            touch-action:none}
        #tv-sheet.show{transform:translateY(0)}
        #tv-sheet .tv-grab{flex:0 0 auto;padding:9px 0 7px;display:flex;justify-content:center;
            background:#181823;cursor:grab}
        #tv-sheet .tv-grab span{width:44px;height:5px;border-radius:3px;background:#3a3a4c}
        #tv-sheet iframe{flex:1;border:none;width:100%;background:#0f0f17}`;
        (document.head || document.documentElement).appendChild(s);
    }

    function openSheet() {
        if (sheetWrap) return;
        ensureSheetStyle();

        sheetWrap = document.createElement('div');
        sheetWrap.id = 'tv-sheet-wrap';
        const sheet = document.createElement('div');
        sheet.id = 'tv-sheet';
        const grab = document.createElement('div');
        grab.className = 'tv-grab';
        grab.innerHTML = '<span></span>';
        const frame = document.createElement('iframe');
        frame.src = chrome.runtime.getURL('manager.html');
        sheet.appendChild(grab);
        sheet.appendChild(frame);
        document.body.appendChild(sheetWrap);
        document.body.appendChild(sheet);

        requestAnimationFrame(() => { sheetWrap && sheetWrap.classList.add('show'); sheet.classList.add('show'); });
        sheetWrap.addEventListener('click', closeSheet);

        // drag the handle down to dismiss
        let sy = 0, dy = 0, dragging = false;
        grab.addEventListener('touchstart', e => {
            dragging = true; sy = e.touches[0].clientY; dy = 0;
            sheet.style.transition = 'none';
        }, { passive: true });
        grab.addEventListener('touchmove', e => {
            if (!dragging) return;
            dy = Math.max(0, e.touches[0].clientY - sy);
            sheet.style.transform = `translateY(${dy}px)`;
        }, { passive: true });
        const endDrag = () => {
            if (!dragging) return;
            dragging = false;
            sheet.style.transition = '';
            if (dy > 110) closeSheet();
            else sheet.style.transform = '';
        };
        grab.addEventListener('touchend', endDrag, { passive: true });
        grab.addEventListener('touchcancel', endDrag, { passive: true });
    }

    function closeSheet() {
        if (!sheetWrap) return;
        const wrap = sheetWrap; sheetWrap = null;
        const sheet = document.getElementById('tv-sheet');
        wrap.classList.remove('show');
        if (sheet) { sheet.style.transform = ''; sheet.classList.remove('show'); }
        setTimeout(() => { wrap.remove(); sheet && sheet.remove(); }, 280);
    }

    /* ------------------------- gesture detector ------------------------- */
    const need = g => g === 'tap4' ? 4 : (g === 'off' ? 0 : 3);
    let tracking = false, fired = false, sx = 0, sy = 0, st = 0, moved = 0, seen = 0;

    function centroid(touches) {
        let x = 0, y = 0;
        for (const t of touches) { x += t.clientX; y += t.clientY; }
        return { x: x / touches.length, y: y / touches.length };
    }

    addEventListener('touchstart', e => {
        const n = need(gesture);
        if (!n || sheetWrap) return;
        seen = Math.max(seen, e.touches.length);
        if (e.touches.length === n && !tracking) {
            tracking = true; fired = false; moved = 0;
            const c = centroid(e.touches); sx = c.x; sy = c.y; st = Date.now();
        }
    }, { passive: true });

    addEventListener('touchmove', e => {
        if (!tracking || fired) return;
        const n = need(gesture);
        if (e.touches.length !== n) return;
        const c = centroid(e.touches);
        const dx = c.x - sx, dy = c.y - sy;
        moved = Math.max(moved, Math.abs(dx), Math.abs(dy));
        if (gesture === 'swipe3up' && dy < -90 && Math.abs(dx) < 130) { fired = true; tracking = false; fire(); }
        else if (gesture === 'swipe3down' && dy > 90 && Math.abs(dx) < 130) { fired = true; tracking = false; fire(); }
    }, { passive: true });

    addEventListener('touchend', e => {
        if (e.touches.length > 0) return;
        if (tracking && !fired && (gesture === 'tap3' || gesture === 'tap4') &&
            seen === need(gesture) && Date.now() - st < 450 && moved < 40) {
            fire();
        }
        tracking = false; fired = false; seen = 0;
    }, { passive: true });

    addEventListener('touchcancel', () => { tracking = false; fired = false; seen = 0; }, { passive: true });
})();
